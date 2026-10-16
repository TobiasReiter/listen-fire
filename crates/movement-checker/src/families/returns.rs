//! What a body hands back — part of the calls family. Each `return` is
//! typed as it is met; a body's returns close into its one value (a
//! movement's or a closure's call is that value); and a written return type
//! is held against every `return` (`checkBody`, `closeReturns`, `checkReturn`
//! and `checkDeclaredReturn` in checker/check.ts).
//!
//! - MOV_RETURN_PLANE_MISMATCH
//! - MOV_RETURN_TYPE

use std::rc::Rc;
use movement_parser::ast::{ClosureExpression, ParamTypeRef, RValue, ReturnStatement, Span, Statement};
use movement_parser::version::since;

use crate::checker::Checker;
use crate::codes;
use crate::scope::{Resolution, ScopeId};
use crate::types::field::{
    Ty, describe_field_type, field_assignable, field_type_equals, handle_within, is_maybe_absent, shows_more_handles, spell_held_steps,
    strip_absent, HeldWalk,
};
use crate::types::position::{PlaneType, Position, ReturnShape, describe_position, positions_match};

/// One `return`: where it is, and what it hands back.
pub struct Returned {
    pub span: Span,
    pub shape: ReturnShape,
}

/// `ReturnCollector`: a body's `return`s, as they are met.
pub struct ReturnCollector {
    pub what: String,
    pub returns: Vec<Returned>,
    /// Why a `return` here is refused, when the body hands nothing back.
    pub refuses: Option<String>,
}

/// A walked body: each `return` in it, and the one value they close into.
pub struct Body {
    pub returns: Vec<Returned>,
    pub value: ReturnShape,
}

/// `UNKNOWN_RETURN`: it may well return, and nobody can say what.
pub fn unknown_return() -> ReturnShape {
    ReturnShape { returns: true, ..ReturnShape::default() }
}

/// `returnPlane`: `None` for a return nobody could type (unknown is not a plane).
fn return_plane(shape: &ReturnShape) -> Option<bool> {
    if shape.plane.pos.is_some() {
        return Some(true);
    }
    shape.plane.field.is_some().then_some(false)
}

/// `recordOf`.
fn record_of(position: &Position) -> Ty {
    Ty::record(Some(position.clone()))
}

impl Checker<'_> {
    /// `checkBody`: a body's statements, collecting its `return`s.
    pub fn check_body(&mut self, statements: &[Statement], scope: ScopeId, what: String) -> Body {
        self.return_stack.push(ReturnCollector { what, returns: Vec::new(), refuses: None });
        self.check_statement_list(statements, scope);
        let collector = self.return_stack.pop().expect("the body's own collector");
        let value = self.close_returns(&collector);
        Body { returns: collector.returns, value }
    }

    /// `checkReturn`: what this `return` hands back, against the nearest
    /// enclosing body.
    pub fn check_return(&mut self, statement: &ReturnStatement, scope: ScopeId) {
        // `(f) => f()` where `f` returns nothing returns nothing, as
        // TypeScript's `() => g()` is `void` when `g` is: the call runs as a
        // statement.
        if statement.concise && self.concise_call_returns_nothing(&statement.value, scope) {
            match &statement.value {
                RValue::Call { call } => {
                    self.check_call(call, scope);
                }
                RValue::Construct { construct } => {
                    if let Some(call) = self.call_in_construct_position(construct, scope) {
                        self.check_call(&call, scope);
                    }
                }
                _ => {}
            }
            return;
        }
        let bound = self.check_rvalue(&statement.value, scope, None, statement.span);
        let types = self.bound_types(None, &statement.value, &bound, scope).unwrap_or_default();
        let shape = ReturnShape { returns: true, plane: PlaneType { pos: types.pos.map(Box::new), field: types.field }, may_hold: types.may_hold };
        self.collect_return(statement.span, shape);
    }

    /// `conciseCallReturnsNothing`: is this concise body's call one whose
    /// callee is known to return nothing?
    fn concise_call_returns_nothing(&mut self, value: &RValue, scope: ScopeId) -> bool {
        let written = match value {
            RValue::Call { call } => &call.callee,
            RValue::Construct { construct } => &construct.callee,
            _ => return false,
        };
        let callee = self.callee_name(written, scope);
        let Resolution::Found(id) = self.scopes.resolve(scope, &callee) else { return false };
        let symbol = self.scopes.symbol(id);
        if symbol.kind == crate::scope::SymbolKind::Movement {
            return !self.movement_return(id).returns;
        }
        self.called_closure(id).is_some_and(|closure| !closure.returns.returns) && !self.selves.undeclared.contains(&id)
    }

    /// `checkReturn`'s collecting half.
    fn collect_return(&mut self, span: Span, shape: ReturnShape) {
        match self.return_stack.last_mut() {
            None => self.report(
                codes::RETURN_OUTSIDE_BODY,
                "'return' hands a value back from a body — there is none here. A movement, a traversal-headed block and a closure each return; file-level statements do not.",
                span,
            ),
            Some(ReturnCollector { refuses: Some(why), .. }) => {
                let why = why.clone();
                self.report(codes::RETURN_OUTSIDE_BODY, why, span);
            }
            Some(collector) => collector.returns.push(Returned { span, shape }),
        }
    }

    /// `closeReturns`: a body's returns as its one value. Returns that
    /// disagree about their plane — a record against a value — are refused;
    /// returns on one plane take the first's type, and what any of them may
    /// hold travels with it.
    fn close_returns(&mut self, collector: &ReturnCollector) -> ReturnShape {
        let Some(first) = collector.returns.first() else { return ReturnShape::default() };
        let first_plane = return_plane(&first.shape);
        for later in &collector.returns[1..] {
            let plane = return_plane(&later.shape);
            let (Some(plane), Some(first_plane)) = (plane, first_plane) else { continue };
            if plane == first_plane {
                continue;
            }
            let kind = |record: bool| if record { "a record" } else { "a value" };
            self.report(
                codes::RETURN_PLANE_MISMATCH,
                format!(
                    "{} returns {} on line {} and {} here — a body has one value, so every 'return' in it hands back the same kind of thing",
                    collector.what,
                    kind(first_plane),
                    first.span.start.line,
                    kind(plane)
                ),
                later.span,
            );
        }
        // Returns that each hand back a closure are one of several closures: a
        // call of the value is held to every one of them, and is any of their
        // returns — not the first's alone.
        let closures: Vec<crate::types::position::ClosureType> = collector
            .returns
            .iter()
            .filter_map(|returned| match (&returned.shape.plane.field, &returned.shape.may_hold, returned.shape.plane.pos.as_deref()) {
                (None, None, Some(Position::Closure(closure))) => Some(closure.clone()),
                _ => None,
            })
            .collect();
        if closures.len() > 1 && closures.len() == collector.returns.len() {
            let merged = crate::types::position::one_of_closures(&closures, since(self.version, 5));
            return ReturnShape { returns: true, plane: PlaneType { pos: Some(Box::new(Position::Closure(merged))), field: None }, may_hold: None };
        }
        // TypeScript's return type is the union of its returns: the type
        // stays the first's, and the union travels as a walk input (never a
        // type, so it is not made canonical), flattened and deduplicated.
        let mut arms: Vec<Ty> = Vec::new();
        fn add(arm: &Ty, arms: &mut Vec<Ty>) {
            if let Ty::Union(members) = arm {
                members.iter().for_each(|m| add(m, arms));
                return;
            }
            if !arms.iter().any(|seen| crate::types::position::same_handle_object(seen, arm) || field_type_equals(seen, arm)) {
                arms.push(arm.clone());
            }
        }
        for returned in &collector.returns {
            if let Some(arm) = returned.shape.may_hold.as_ref().or(returned.shape.plane.field.as_ref()) {
                add(arm, &mut arms);
            }
        }
        let may_hold = match arms.len() {
            0 => None,
            1 => arms.pop(),
            _ => Some(Ty::Union(Rc::new(arms))),
        };
        let revealed = may_hold.filter(|held| shows_more_handles(held, first.shape.plane.field.as_ref()));
        ReturnShape { returns: true, plane: first.shape.plane.clone(), may_hold: revealed }
    }

    /// What a closure's call hands back: what it declares (version 3), else
    /// what its body was found to (`checkClosure`'s `returns`). Before
    /// version 5 a declaration that does not take what a return may hold is
    /// not refused where it is written, so the call still carries it.
    pub fn closure_returns(&self, closure: &ClosureExpression, inferred: ReturnShape, scope: ScopeId) -> ReturnShape {
        let Some(written) = closure.return_type.as_ref().filter(|_| since(self.version, 3)) else {
            let pos = inferred.plane.pos.map(|pos| Box::new(crate::types::position::without_parameter(*pos)));
            return ReturnShape { plane: PlaneType { pos, ..inferred.plane }, ..inferred };
        };
        let plane = self.plane_type_of(written, scope);
        let may_hold = inferred.may_hold.filter(|held| !since(self.version, 5) && shows_more_handles(held, plane.field.as_ref()));
        ReturnShape { returns: true, plane, may_hold }
    }

    /// `checkDeclaredReturn`: `): <R>` against what the body hands back —
    /// every `return` assignable to it, and a body that declares one
    /// returns something.
    pub fn check_declared_return(&mut self, written: &ParamTypeRef, what: &str, returns: &[Returned], scope: ScopeId, span: Span) {
        if !since(self.version, 3) {
            return;
        }
        let declared = self.plane_type_of(written, scope);
        let expected = format!("{what} declares it returns <{}>", crate::families::listens::spell_param_type(written));
        if returns.is_empty() {
            self.report(
                codes::RETURN_TYPE,
                format!("{expected}, but its body never returns a value — add a 'return', or drop the return type"),
                Span { start: span.start, end: span.start },
            );
            return;
        }
        for returned in returns {
            self.check_return_fit(&expected, &declared, returned);
        }
    }

    /// `checkReturnFit`: one `return` against a declared return type.
    fn check_return_fit(&mut self, expected: &str, declared: &PlaneType, returned: &Returned) {
        let span = returned.span;
        let shape = &returned.shape;
        if let Some(target) = &declared.field {
            // A record or file a return MAY hand back is one the declared
            // type has to take (from version 5; before, the call carries it
            // and a use that reaches data is refused there).
            let hidden = if since(self.version, 5) { shape.may_hold.as_ref().and_then(|held| handle_within(Some(held), &HeldWalk::taken_by(Some(target)))) } else { None };
            if let Some(hidden) = hidden {
                let steps = spell_held_steps(&hidden.steps);
                let file = hidden.is_file();
                let where_ = if steps.is_empty() {
                    format!("may be {}", describe_field_type(&hidden.handle))
                } else {
                    format!("may hold {} at '{steps}'", describe_field_type(&hidden.handle))
                };
                let repair = if file { "return its text in its place ('READ(f)')" } else { "return a field off it ('r.`Name`')" };
                self.report(
                    codes::RETURN_TYPE,
                    format!(
                        "{expected}, but this {where_} — {}, not a value. A call is typed by what it declares, so {repair}",
                        if file { "a file" } else { "a record" }
                    ),
                    span,
                );
                return;
            }
            let got = shape.plane.field.clone().or_else(|| shape.plane.pos.as_deref().map(record_of));
            let Some(got) = got else { return };
            if is_maybe_absent(Some(&got)) && !is_maybe_absent(Some(target)) {
                self.report(
                    codes::RETURN_TYPE,
                    format!("{expected}, but this value may be absent — fill it first ('COALESCE(x, …)'), or declare the return type as one that may be absent"),
                    span,
                );
                return;
            }
            let target = strip_absent(target);
            let source = strip_absent(&got);
            let misfit = match target {
                Ty::Dict { shape: Some(keys), .. } => record_return_misfit(keys, source),
                _ if field_assignable(source, target) => None,
                _ => Some(format!("this returns {}", describe_field_type(source))),
            };
            if let Some(misfit) = misfit {
                self.report(codes::RETURN_TYPE, format!("{expected}, but {misfit}"), span);
            }
            return;
        }
        let Some(target) = declared.pos.as_deref() else { return };
        let Some(source) = shape.plane.pos.as_deref() else {
            if let Some(field) = &shape.plane.field {
                self.report(codes::RETURN_TYPE, format!("{expected}, a record, but this returns {}", describe_field_type(field)), span);
            }
            return;
        };
        // A returned value is handed to the caller exactly as an argument is
        // handed to a parameter: the same structural judgements.
        let declared_node = match target {
            Position::Position(p) if p.instance.declared.is_some() => Some(p),
            _ => None,
        };
        let structural = match (source, declared_node) {
            (Position::Local(_), _) => crate::families::nodes::structural_misfit(source, target),
            (_, Some(param)) => crate::families::nodes::declared_param_misfit(source, param),
            _ => None,
        };
        if let Some(structural) = structural {
            self.report(codes::RETURN_TYPE, format!("{expected}, and {structural}"), span);
        } else if !matches!(source, Position::Local(_)) && declared_node.is_none() && positions_match(source, target) == Some(false) {
            self.report(codes::RETURN_TYPE, format!("{expected}, but this returns {}", describe_position(source)), span);
        }
    }
}

/// `recordReturnMisfit`: why a returned value does not fit a declared
/// record type — every required key present, each one assignable.
fn record_return_misfit(keys: &movement_parser::catalog::types::JsMap<Option<Ty>>, source: &Ty) -> Option<String> {
    let Ty::Dict { shape: supplied, .. } = source else {
        return Some(format!("this returns {}", describe_field_type(source)));
    };
    let required: Vec<&String> = keys.iter().filter(|(_, ty)| ty.as_ref().is_some_and(|t| !is_maybe_absent(Some(t)))).map(|(key, _)| key).collect();
    let Some(supplied) = supplied else {
        if required.is_empty() {
            return None;
        }
        let listed = required.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(", ");
        return Some(format!("this returns {}, whose keys are data — nothing says it has {listed}", describe_field_type(source)));
    };
    let missing: Vec<&&String> = required.iter().filter(|key| !supplied.contains_key(key.as_str())).collect();
    if !missing.is_empty() {
        let which = if missing.len() == 1 { "the key" } else { "the keys" };
        let listed = missing.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(", ");
        return Some(format!("this is missing {which} {listed}"));
    }
    for (key, key_type) in keys.iter() {
        let (Some(key_type), Some(Some(given))) = (key_type, supplied.get(key.as_str())) else { continue };
        if is_maybe_absent(Some(given)) && !is_maybe_absent(Some(key_type)) {
            return Some(format!("its key '{key}' is required, but the value given for it may be absent"));
        }
        if !field_assignable(given, key_type) {
            return Some(format!(
                "its key '{key}' takes {}, but the value given for it is {}",
                describe_field_type(strip_absent(key_type)),
                describe_field_type(strip_absent(given))
            ));
        }
    }
    None
}
