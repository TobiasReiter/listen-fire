//! The closures family: not yet ported. Its codes (PORT.md has where the
//! TypeScript raises each):
//!
//! - MOV_BLOCK_READ_BACK_RETIRED
//! - MOV_BLOCK_RETURNS_NOTHING
//! - MOV_CLOSURE_NOT_DATA
//! - MOV_COLLECTION_OP_ARITY
//! - MOV_COLLECTION_OP_CONFIG
//! - MOV_COLLECTION_OP_NOT_A_COLLECTION
//! - MOV_COLLECTION_OP_RETURNS_NOTHING
//! - MOV_COLLECTION_OP_SUSPENDS
//! - MOV_COMBINATOR_ARMS_ARE_ARGUMENTS
//! - MOV_COMBINATOR_ARM_NOT_FUNCTION
//! - MOV_COMBINATOR_ARM_TAKES_NOTHING
//! - MOV_COMBINATOR_NEEDS_AWAIT
//! - MOV_COMBINATOR_NO_AWAIT
//! - MOV_INLINE_BLOCK_RETIRED
//! - MOV_PARALLEL_RETIRED


use std::rc::Rc;
use movement_parser::ast::{
    ArmExpression, ClosureExpression, CollectionOp, CollectionOpExpression, CombinatorArms, CombinatorExpression, CombinatorKind, Loc, RValue,
    Span, Statement,
};
use movement_parser::version::{before, since};
use serde_json::json;

use crate::checker::Checker;
use crate::slots::is_bare_ident;
use crate::types::scope_env::SymbolTypes;
use crate::codes;
use crate::diagnostic::Diagnostic;
use crate::scope::{Resolution, ScopeId, Symbol, SymbolId, SymbolKind};
use crate::types::field::{CollectionOrder, Ty, collection_order_of, list_of};
use crate::types::position::{ClosureParam, PlaneType, ReturnShape};

/// Whether a body hands a value back: a `return` at its own level or in an
/// `if` arm (a block, a closure or a movement inside it returns for itself).
pub fn body_returns(statements: &[Statement]) -> bool {
    statements.iter().any(|statement| match statement {
        Statement::Return(_) => true,
        Statement::If(s) => s.arms.iter().any(|arm| body_returns(&arm.body)) || s.else_arm.as_ref().is_some_and(|e| body_returns(&e.body)),
        _ => false,
    })
}

fn kind_name(kind: CombinatorKind) -> &'static str {
    match kind {
        CombinatorKind::Race => "race",
        CombinatorKind::Parallel => "parallel",
        CombinatorKind::All => "all",
    }
}

fn op_spelling(op: CollectionOp) -> &'static str {
    match op {
        CollectionOp::Map => "MAP",
        CollectionOp::Filter => "FILTER",
        CollectionOp::Reduce => "REDUCE",
        CollectionOp::Groupby => "GROUPBY",
        CollectionOp::Keyby => "KEYBY",
        // No spelling of the tree's `SORTBY`: it exists only as `sort`.
        CollectionOp::Sort => "sort",
    }
}

/// `shiftLoc`.
fn shift(loc: Loc, by: isize) -> Loc {
    Loc { line: loc.line, col: loc.col.saturating_add_signed(by) }
}

fn edit(start: Loc, end: Loc, text: &str) -> serde_json::Value {
    json!({ "span": Span { start, end }, "text": text })
}

/// What a collection op hands its function (`CollectionMembers`): each
/// member, REDUCE's starting value, and what each may hold beyond its type.
struct Members {
    /// REDUCE hands its starting value first.
    reduce: bool,
    element: Option<Ty>,
    element_may_hold: Option<Ty>,
    carried: Option<Ty>,
    carried_may_hold: Option<Ty>,
}

/// A combinator's answer (`checkCombinator`'s value): its type, what its
/// slots may hold beyond that type (`combinatorMayHold`), and whether an arm
/// hands back a record (`receiptHoldsRecord`).
#[derive(Debug, Clone, Default)]
pub struct Receipt {
    pub ty: Option<Ty>,
    pub may_hold: Option<Ty>,
    pub holds_record: bool,
}

/// `combinatorMayLeaveSlotsNull`: a race settles on its first arm; an `all`
/// whose `onError` lets a failed arm through leaves that slot empty.
fn combinator_may_leave_slots_null(combinator: &CombinatorExpression) -> bool {
    if combinator.kind == CombinatorKind::Race {
        return true;
    }
    let Some(settings) = &combinator.settings else { return false };
    let Ok(parsed) = crate::slots::expression_of_slot(settings) else { return false };
    crate::families::collection_config::on_error_lets_through(&parsed, crate::families::collection_config::ALL_SETTING_KEYS)
}

/// `receiptMayHold`: each slot as what its arm's returns may hold, or the
/// record it hands back, which the tuple cannot type.
fn receipt_may_hold(nullable: bool, slots: &[ReturnShape]) -> Ty {
    Ty::Tuple {
        of: slots
            .iter()
            .map(|slot| {
                if !slot.returns {
                    return Some(Ty::Absent);
                }
                let held = slot.may_hold.clone().or_else(|| slot.plane.field.clone()).or_else(|| match slot.plane.pos.as_deref() {
                    Some(crate::types::position::Position::Closure(_)) | None => None,
                    Some(position) => Some(Ty::record(Some(position.clone()))),
                })?;
                Some(if nullable { crate::types::field::maybe_absent(held) } else { held })
            })
            .collect::<Vec<_>>()
            .into(),
        rest: None,
    }
}

fn arm_span(arm: &ArmExpression) -> Span {
    match arm {
        ArmExpression::Closure { span, .. } | ArmExpression::Ref { span, .. } => *span,
    }
}

impl Checker<'_> {
    /// `declareClosureSelf`: a closure bound to a name may call itself by
    /// that name (version 3); a parameter of the same name shadows it.
    pub fn declare_closure_self(&mut self, name: &str, closure: &ClosureExpression, body: ScopeId) -> Option<SymbolId> {
        if !since(self.version, 3) || closure.params.iter().any(|p| p.name == name) {
            return None;
        }
        let mut symbol = Symbol::new(name, SymbolKind::Binding, closure.span);
        symbol.is_closure = true;
        let id = self.scopes.add_symbol(symbol);
        self.scopes.declare(body, id);
        if closure.return_type.is_some() {
            self.function_returns.insert(id, true);
        } else {
            self.selves.undeclared.insert(id);
        }
        Some(id)
    }

    /// `noteUndeclaredSelfCall`: the first call through a closure's own name,
    /// when that closure declared nothing.
    pub fn note_self_call(&mut self, id: SymbolId, span: Span) {
        if self.selves.undeclared.contains(&id) {
            self.selves.first_call.entry(id).or_insert(span);
        }
    }

    /// A self-call whose value is used: whether it binds anything is known
    /// once the body has been walked.
    pub fn note_bound_self_call(&mut self, written: &str, span: Span, scope: ScopeId) {
        let callee = self.callee_name(written, scope);
        if let Resolution::Found(id) = self.scopes.resolve(scope, &callee)
            && self.selves.undeclared.contains(&id)
        {
            self.selves.bound_calls.entry(id).or_default().push((written.to_string(), span));
        }
    }

    /// The closure's body has been walked: a self-call needed the type being
    /// worked out, unless the body hands nothing back, when its bound
    /// self-calls bound nothing.
    pub fn close_closure_self(&mut self, id: SymbolId, returns_nothing: bool) {
        let name = self.scopes.symbol(id).name.clone();
        if let Some(span) = self.selves.first_call.get(&id).copied()
            && !returns_nothing
        {
            self.report(
                codes::RECURSIVE_RETURN_TYPE,
                recursive_return_type_message(&name, &[&name, &name], &format!("{name} = (…): <number> => …")),
                span,
            );
        }
        if returns_nothing {
            for (callee, span) in self.selves.bound_calls.get(&id).cloned().unwrap_or_default() {
                self.report_call_returns_nothing(&callee, span);
            }
        }
    }
}

/// The self-names of closures that declared no return type, and how they
/// were called while their bodies were walked.
#[derive(Default)]
pub struct Selves {
    pub undeclared: std::collections::HashSet<SymbolId>,
    pub first_call: std::collections::HashMap<SymbolId, Span>,
    pub bound_calls: std::collections::HashMap<SymbolId, Vec<(String, Span)>>,
}

/// `recursiveReturnTypeMessage`.
pub fn recursive_return_type_message(name: &str, chain: &[&str], example: &str) -> String {
    let around = if chain.len() <= 2 {
        "calls itself".to_string()
    } else {
        format!("calls itself through {}", chain[1..chain.len() - 1].iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(", "))
    };
    format!(
        "'{name}' {around} ({}), so it declares what it returns, as TypeScript requires — what its body returns cannot be worked out from a body that needs its own answer. Write the type after the parameters: '{example}'",
        chain.join(" → ")
    )
}

impl Checker<'_> {
    /// A closure bound to a name: whether its body hands a value back.
    pub fn note_closure_returns(&mut self, name: &str, value: &RValue, scope: ScopeId) {
        let RValue::Closure { closure } = value else { return };
        if let Some(id) = self.scopes.scope(scope).symbols.get(name).copied() {
            let returns = closure.return_type.is_some() || body_returns(&closure.body);
            self.function_returns.insert(id, returns);
        }
    }

    fn report_fixed(&mut self, code: &str, message: String, span: Span, edits: Vec<serde_json::Value>) {
        let mut diagnostic = Diagnostic::error(code, message, span);
        diagnostic.fix = Some(json!({ "edits": edits }));
        self.push(diagnostic);
    }

    /// `reportCombinatorForm`: before version 5 a combinator is awaited; from
    /// 5 `parallel` is retired, the arms are arguments and nothing awaits it.
    pub fn report_combinator_form(&mut self, expr: &CombinatorExpression, awaited: Option<Span>) {
        let kind = kind_name(expr.kind);
        if before(self.version, 5) {
            if awaited.is_none() {
                self.report(
                    codes::COMBINATOR_NEEDS_AWAIT,
                    format!("'{kind}([…])' does not park by itself — it composes a wait, and 'await' is what parks: write 'await {kind}([…])'"),
                    expr.span,
                );
            }
            return;
        }
        if expr.kind == CombinatorKind::Parallel {
            self.report_parallel_retired(expr, awaited.unwrap_or(expr.span));
            return;
        }
        if let CombinatorArms::Literal { span, .. } = &expr.arms {
            self.report_fixed(
                codes::COMBINATOR_ARMS_ARE_ARGUMENTS,
                format!("'{kind}' takes its functions as arguments, not in a list — a closure is not data, so there is no list of them to pass. Write '{kind}(f, g)'"),
                *span,
                vec![edit(span.start, shift(span.start, 1), ""), edit(shift(span.end, -1), span.end, "")],
            );
        }
        if let Some(awaited) = awaited {
            self.report_fixed(
                codes::COMBINATOR_NO_AWAIT,
                format!("'await' marks where the run itself parks — a sleep, an until, an answer read — and '{kind}(…)' does not park by itself: its arms may, and the run parks where they do. Write '{kind}(…)' without 'await'"),
                awaited,
                vec![edit(awaited.start, expr.span.start, "")],
            );
        }
        if let Some(settings) = &expr.settings {
            if expr.kind == CombinatorKind::Race {
                self.report(
                    codes::COLLECTION_OP_CONFIG,
                    "'race' takes no settings — it settles on the first arm to finish, so every arm runs at once. 'all' takes { concurrency, onError }",
                    settings.span,
                );
            } else {
                self.check_collection_config(settings, kind, Some(crate::families::collection_config::ALL_SETTING_KEYS));
            }
        }
    }

    /// `reportInlineBlockRetired`: `{ … }.name` read a block's inner binding.
    pub fn report_inline_block_retired(&mut self, inline: &movement_parser::ast::InlineBlockExpression) {
        let binding = &inline.binding;
        self.report(
            codes::INLINE_BLOCK_RETIRED,
            format!("reading a block's inner binding by name ('{{ … }}.{binding}') is retired — a body hands its value back with 'return'. Bind the value directly, or write a closure ('() => {{ … return {binding} }}') where the body should run later."),
            inline.span,
        );
    }

    /// `reportBlockReadBack`: `orgs.name` reached into the block `orgs` was
    /// bound to for a name bound inside it — matched against what escaped.
    pub fn report_block_read_back(&mut self, names: &crate::slots::CollectedNames, scope: ScopeId, span: Span) {
        for (root, members) in &names.rooted {
            for member in members {
                let escaped = self.scopes.chain(scope).find_map(|s| self.scopes.scope(s).escaped.get(member).cloned());
                if escaped.flatten().as_deref() != Some(root.as_str()) {
                    continue;
                }
                self.report(
                    codes::BLOCK_READ_BACK_RETIRED,
                    format!("'{member}' is bound INSIDE the block '{root}' came from, and a block's bindings do not escape it — return the value from the block instead: '{root} = … {{ … return {member} }}'"),
                    span,
                );
                return;
            }
        }
    }

    /// `reportParallelRetired`.
    fn report_parallel_retired(&mut self, expr: &CombinatorExpression, written: Span) {
        let message = "'parallel' is retired — 'all' is the same join, its functions passed as arguments: every one runs, and the answer is what each returned, in their order";
        let no_await = "no 'await': 'all' does not park by itself, and an arm that waits parks the run";
        match &expr.arms {
            CombinatorArms::Dynamic { .. } => self.report(
                codes::PARALLEL_RETIRED,
                format!("{message}. Write 'all(f, g, …)', naming each function — a closure is not data, so there is no list of them to pass — and {no_await}"),
                written,
            ),
            CombinatorArms::Literal { span, .. } => self.report_fixed(
                codes::PARALLEL_RETIRED,
                format!("{message}. Write 'all(…)' — {no_await}"),
                written,
                vec![edit(written.start, shift(span.start, 1), "all("), edit(shift(span.end, -1), expr.span.end, ")")],
            ),
            CombinatorArms::Arguments { .. } => self.report_fixed(
                codes::PARALLEL_RETIRED,
                format!("{message}. Write 'all(…)' — {no_await}"),
                written,
                vec![edit(written.start, shift(expr.span.start, "parallel".len() as isize), "all")],
            ),
        }
    }

    /// `checkCombinator`: the arms are functions the combinator calls, so it
    /// parks, and its answer is positional — one slot per arm written down,
    /// each what that arm returned (`T | null` where a slot may be left
    /// empty: a race, or an `onError` that lets a failed arm through). Arms
    /// built at run time give an answer nobody can type.
    pub fn check_combinator(&mut self, combinator: &CombinatorExpression, scope: ScopeId) -> Receipt {
        let kind = kind_name(combinator.kind);
        // Running arms concurrently is still running them: the combinator
        // waits, so it parks.
        self.flag_suspend();
        let arms = match &combinator.arms {
            CombinatorArms::Literal { arms, .. } | CombinatorArms::Arguments { arms, .. } => arms,
            CombinatorArms::Dynamic { expr, .. } => {
                // A name bound to a list of functions written down, or to a
                // MAP that builds them from a closure, is as known as a literal
                // arm list: what each arm returns is what the receipt may hold.
                // Arms known only at run time stay untyped.
                let parsed = self.check_expr_slot_with(expr, scope, crate::checker::SlotOptions::default()).expr;
                let raw = expr.raw.trim();
                let arm_name = if is_bare_ident(raw) { Some(raw) } else { parsed.as_ref().and_then(crate::types::narrowing::bare_name) };
                let types = match arm_name.map(|name| self.scopes.resolve(scope, name)) {
                    Some(Resolution::Found(id)) => Some(self.scopes.symbol(id).types.clone()),
                    _ => None,
                };
                let nullable = combinator_may_leave_slots_null(combinator);
                let may_hold = match types {
                    Some(SymbolTypes { arm_returns: Some(arms), .. }) => Some(receipt_may_hold(nullable, &arms)),
                    Some(SymbolTypes { arms_each_return: Some(each), .. }) => match receipt_may_hold(nullable, std::slice::from_ref(&each)) {
                        Ty::Tuple { of, .. } => match of.first().cloned().flatten() {
                            Some(Ty::Absent) | None => None,
                            Some(slot) => Some(list_of(slot, crate::types::field::CollectionOrder::Unknown)),
                        },
                        _ => None,
                    },
                    _ => None,
                };
                return Receipt { may_hold, ..Receipt::default() };
            }
        };
        let nullable = combinator_may_leave_slots_null(combinator);
        let slots: Vec<ReturnShape> = arms.iter().map(|arm| self.check_arm(arm, kind, scope, 0)).collect();
        // A closure is not data (version 5): an arm that hands one back would
        // keep it in the answer.
        if since(self.version, 5) {
            for (arm, slot) in arms.iter().zip(&slots) {
                let closure = matches!(slot.plane.pos.as_deref(), Some(crate::types::position::Position::Closure(_)))
                    || crate::types::field::may_be_closure(slot.plane.field.as_ref())
                    || crate::types::field::may_be_closure(slot.may_hold.as_ref());
                if slot.returns && closure {
                    self.report(
                        codes::CLOSURE_NOT_DATA,
                        crate::types::field::closure_not_data_message(&format!("'{kind}' keeps what each arm returns in its answer, and this arm returns")),
                        arm_span(arm),
                    );
                }
            }
        }
        let holds_record = slots.iter().any(|slot| slot.returns && (slot.plane.pos.is_some() || crate::types::field::is_record(slot.plane.field.as_ref())));
        let may_hold = receipt_may_hold(nullable, &slots);
        let ty = Ty::Tuple {
            of: slots
                .iter()
                .map(|slot| {
                    // An arm that hands nothing back is an always-null slot under
                    // every combinator: a join cannot invent a value the arm never made.
                    if !slot.returns {
                        return Some(Ty::Absent);
                    }
                    let field = slot.plane.field.clone()?;
                    Some(if nullable { crate::types::field::maybe_absent(field) } else { field })
                })
                .collect::<Vec<_>>()
                .into(),
            rest: None,
        };
        Receipt { ty: Some(ty), may_hold: Some(may_hold), holds_record }
    }

    /// `checkArm`: a closure written in place, or the name of a function; the
    /// combinator calls it with nothing, and what it returns is its slot.
    fn check_arm(&mut self, arm: &ArmExpression, kind: &str, scope: ScopeId, expected: usize) -> ReturnShape {
        match arm {
            ArmExpression::Closure { closure, span } => {
                let (body, suspends) = self.check_closure_walked(closure, scope, None, &format!("an arm of '{kind}'"), 0);
                if closure.params.len() != expected {
                    self.report_arm_arity(kind, expected, closure.params.len(), closure.params.first().map(|p| p.name.as_str()), *span);
                }
                self.absorb_suspend(suspends);
                self.closure_returns(closure, body.value, scope)
            }
            ArmExpression::Ref { name, span } => {
                self.check_named_arm(name, *span, kind, scope, expected);
                self.named_function_return(name, scope)
            }
        }
    }

    fn check_named_arm(&mut self, written: &str, span: Span, kind: &str, scope: ScopeId, expected: usize) -> Option<bool> {
        let callee = self.callee_name(written, scope);
        let id = match self.scopes.resolve(scope, &callee) {
            Resolution::Found(id) => id,
            failure => {
                self.report_resolution_failure(&callee, span, failure);
                return None;
            }
        };
        let symbol = self.scopes.symbol(id).clone();
        if symbol.kind == SymbolKind::Movement {
            self.call_movement(id);
            if let Some(params) = self.listens.movement_info(id).map(|info| info.params.iter().map(|p| p.name.clone()).collect::<Vec<_>>())
                && params.len() != expected
            {
                self.report_arm_arity(kind, expected, params.len(), params.first().map(String::as_str), span);
            }
            return self.function_returns.get(&id).copied();
        }
        if let Some(crate::types::position::Position::Closure(closure)) = &symbol.types.pos {
            let suspends = self.closure_suspends(id);
            self.absorb_suspend(suspends);
            if closure.params.len() != expected {
                self.report_arm_arity(kind, expected, closure.params.len(), closure.params.first().map(|p| p.name.as_str()), span);
            }
            return self.function_returns.get(&id).copied();
        }
        if symbol.kind == SymbolKind::FileImport || symbol.is_closure {
            return None;
        }
        self.report(
            codes::COMBINATOR_ARM_NOT_FUNCTION,
            format!("'{written}' is {}, and '{kind}' RUNS its arms — an arm has to be a function. Name a movement, or write the work as a closure: `() => {{ … }}`.", symbol.kind.describe()),
            span,
        );
        None
    }

    /// `reportArmArity`.
    fn report_arm_arity(&mut self, kind: &str, expected: usize, got: usize, param: Option<&str>, span: Span) {
        if expected == 0 {
            let which = param.map_or_else(|| "a parameter".to_string(), |p| format!("'{p}'"));
            self.report(
                codes::COMBINATOR_ARM_TAKES_NOTHING,
                format!("'{kind}' calls its arms with nothing, so {which} could only ever arrive null. Take no parameters — a closure already sees everything in scope where it is written."),
                span,
            );
            return;
        }
        let message = if expected == 1 {
            format!("'{kind}' calls its function with one member at a time, and this one takes {got}: write '(member) => {{ … }}'")
        } else {
            format!("'{kind}' calls its function with two things — the value carried so far and the next member — and this one takes {got}: write '(carried, member) => {{ … }}'")
        };
        self.report(codes::COLLECTION_OP_ARITY, message, span);
    }

    /// `checkCollectionOp`: the slots, the function the op is given, and
    /// the op's value — what the function hands back, collected as the op
    /// collects it.
    pub fn check_collection_op(&mut self, op: &CollectionOpExpression, scope: ScopeId) -> ReturnShape {
        self.check_collection_op_arms(op, scope).0
    }

    /// `checkCollectionOp`, and — for a `MAP` whose function hands back
    /// functions — what each of those returns (`collectionArmsReturn`).
    pub fn check_collection_op_arms(&mut self, op: &CollectionOpExpression, scope: ScopeId) -> (ReturnShape, Option<ReturnShape>) {
        let spelling = op_spelling(op.op);
        let source = self.check_expr_slot_with(&op.source, scope, crate::checker::SlotOptions::default());
        let init = op.init.as_ref().map(|init| self.check_expr_slot_with(init, scope, crate::checker::SlotOptions::default()));
        if let Some(config) = &op.config {
            if op.op == CollectionOp::Sort {
                self.check_sort_settings(config);
            } else {
                self.check_collection_config(config, spelling, None);
            }
        }
        let element = self.collection_element(&op.source, source.expr.as_ref(), source.ty.as_ref(), spelling, scope);
        let ordering = collection_order_of(source.ty.as_ref());
        // The order-sensitive one, held to the rule every order-sensitive fold is.
        if op.op == CollectionOp::Reduce && ordering == CollectionOrder::Unordered {
            self.report(
                codes::FOLD_NEEDS_ORDER,
                "'REDUCE' reads the members one after another, so the answer depends on the order they are in — and nothing has given this collection one. Order the traversal it came from ('ORDER BY'), or fold it with something that answers the same over any order ('COUNT', 'SUM', 'MIN', 'MAX', 'ONLY').",
                op.source.span,
            );
        }
        let members = Members {
            reduce: op.op == CollectionOp::Reduce,
            element: element.clone(),
            element_may_hold: source.may_hold.as_ref().and_then(crate::types::field::collection_element_of),
            carried: init.as_ref().and_then(|i| i.ty.clone()),
            carried_may_hold: init.as_ref().and_then(|i| i.may_hold.clone()),
        };
        let carried = members.carried.clone();
        let arity = if op.op == CollectionOp::Reduce { 2 } else { 1 };
        // The function is called once per member, so a parameter it leaves
        // untyped takes the member's type (REDUCE's first, the carried value's).
        let as_value = |ty: Option<Ty>| PlaneType { field: ty, pos: None };
        let supplied = if op.op == CollectionOp::Reduce {
            vec![as_value(carried.clone()), as_value(element.clone())]
        } else {
            vec![as_value(element.clone())]
        };
        let (returns, shape) = match &op.r#fn {
            ArmExpression::Closure { closure, span } => {
                if closure.params.len() != arity {
                    self.report_arm_arity(spelling, arity, closure.params.len(), closure.params.first().map(|p| p.name.as_str()), *span);
                }
                let (returned, suspends) = self.check_closure_supplied(closure, scope, None, &format!("the function for '{spelling}'"), arity, &supplied);
                if suspends && before(self.version, 3) {
                    self.report(
                        codes::COLLECTION_OP_SUSPENDS,
                        format!("the function for '{spelling}' waits ('await'), and '{spelling}' runs it over every member to build one value — there is no answer for what the collection is while it waits. Wait outside it: walk the positions in a traversal-headed block, or run the waits together with 'await parallel([…])'."),
                        *span,
                    );
                }
                // A parameter left untyped takes the member's type.
                let of = crate::binding_types::ParamOf::closure(closure, None);
                let bound: Vec<(ClosureParam, bool)> = closure
                    .params
                    .iter()
                    .enumerate()
                    .map(|(index, param)| match &param.type_ {
                        Some(written) => (ClosureParam { name: param.name.clone(), plane: self.parameter_plane(&of, &param.name, self.plane_type_of(written, scope)) }, true),
                        None => (ClosureParam { name: param.name.clone(), plane: supplied.get(index).cloned().unwrap_or_default() }, false),
                    })
                    .collect();
                let callee = format!("the function for '{spelling}'");
                self.check_members_fields_in_hand(spelling, &callee, &bound, &members, *span);
                self.check_members_fit_params(op, spelling, &callee, &bound, &members);
                self.absorb_suspend(suspends);
                let returns = Some(!returned.returns.is_empty() || closure.return_type.is_some());
                (returns, self.closure_returns(closure, returned.value, scope))
            }
            ArmExpression::Ref { name, span } => {
                let returns = self.check_named_arm(name, *span, spelling, scope, arity);
                let named: Vec<(ClosureParam, bool)> = self.named_function_params(name, scope).into_iter().map(|param| (param, true)).collect();
                let callee = format!("'{name}'");
                self.check_members_fields_in_hand(spelling, &callee, &named, &members, *span);
                self.check_members_fit_params(op, spelling, &callee, &named, &members);
                (returns, self.named_function_return(name, scope))
            }
        };
        if op.op != CollectionOp::Map && returns == Some(false) {
            self.report(
                codes::COLLECTION_OP_RETURNS_NOTHING,
                format!("the function for '{spelling}' hands nothing back, so there is nothing for '{spelling}' to do with each member — 'return' the answer for one."),
                arm_span(&op.r#fn),
            );
        }
        // A MAP function with no `return` leaves each slot absent.
        let shape = if op.op == CollectionOp::Map && !shape.returns { ReturnShape { returns: true, plane: as_value(Some(Ty::Absent)), may_hold: None } } else { shape };
        let returned = shape.plane.field.clone().or_else(|| shape.plane.pos.as_deref().map(|p| Ty::record(Some(p.clone()))));
        if since(self.version, 5) {
            // A closure is not data: an op never files closures as its answer
            // — a MAP's members, a GROUPBY's groups or a KEYBY's values.
            use crate::types::field::{closure_not_data_message, may_be_closure};
            let returns_closure = shape.plane.pos.as_deref().is_some_and(crate::types::position::Position::is_closure) || may_be_closure(returned.as_ref()) || may_be_closure(shape.may_hold.as_ref());
            if op.op == CollectionOp::Map && returns_closure {
                self.report(
                    codes::CLOSURE_NOT_DATA,
                    closure_not_data_message(&format!("'{spelling}' answers a list of what its function returns, and its function returns")),
                    op.span,
                );
            }
            if matches!(op.op, CollectionOp::Groupby | CollectionOp::Keyby) && may_be_closure(element.as_ref()) {
                self.report(codes::CLOSURE_NOT_DATA, closure_not_data_message(&format!("'{spelling}' files each member under a key, and each member is")), op.source.span);
            }
        }
        if op.op == CollectionOp::Sort {
            self.check_sort_by(op, source.expr.as_ref(), element.as_ref(), returned.as_ref());
        }
        if matches!(op.op, CollectionOp::Groupby | CollectionOp::Keyby) {
            let diagnostics = {
                let env = self.typing_env(scope);
                let mut typing = crate::types::Typing::new(&env, self.version, arm_span(&op.r#fn));
                crate::families::values::require_dict_key(&mut typing, returned.as_ref(), &format!("filed under by '{spelling}'"));
                typing.diagnostics
            };
            for diagnostic in diagnostics {
                self.push(diagnostic);
            }
        }
        let value = match op.op {
            CollectionOp::Map => returned.map(|r| list_of(r, ordering)),
            CollectionOp::Filter => element.map(|e| list_of(e, ordering)),
            CollectionOp::Reduce => returned.or(carried),
            CollectionOp::Groupby => element.map(|e| Ty::Dict { of: Rc::new(list_of(e, ordering)), shape: None }),
            CollectionOp::Keyby => element.map(|e| Ty::Dict { of: Rc::new(e), shape: None }),
            // The members themselves, now in an order.
            CollectionOp::Sort => element.map(|e| list_of(e, CollectionOrder::Ordered)),
        };
        // What the function's returns may hold beyond that type travels with
        // the op's value, as a call's does: MAP's as members, REDUCE's as itself.
        let arms_each_return = match shape.plane.pos.as_deref() {
            Some(crate::types::position::Position::Closure(closure)) if op.op == CollectionOp::Map => Some(closure.returns.clone()),
            _ => None,
        };
        let may_hold = match op.op {
            CollectionOp::Map => shape.may_hold.map(|held| list_of(held, ordering)),
            CollectionOp::Reduce => shape.may_hold,
            _ => None,
        };
        (ReturnShape { returns: true, plane: as_value(value), may_hold }, arms_each_return)
    }

    /// The parameters of a function named as an op's function, with the
    /// types they are written with.
    /// `checkSortBy`: `sort` by a function key is refused where `SORT(xs,
    /// key)` was, the key being the function: a walk written inside the
    /// call, or a key read off members that are plain values. Past those,
    /// what the function answers for each member is what the members are
    /// ranked by, so it is one value with an order.
    fn check_sort_by(&mut self, op: &CollectionOpExpression, walk: Option<&movement_parser::lowering::expression::Expression>, element: Option<&Ty>, key: Option<&Ty>) {
        use crate::families::values::{is_bare_walk, is_plain_value};
        let span = arm_span(&op.r#fn);
        if walk.is_some_and(is_bare_walk) {
            self.report(
                codes::SORT_KEY_ON_WALK,
                "sort reads a key off each record, and a walk written inside the call hands its records over without the graph they came from. Bind the walk first — `entries = … { return … }` — then sort the name.",
                op.source.span,
            );
            return;
        }
        if element.is_some_and(is_plain_value) && key_reads_off_member(&op.r#fn) {
            self.report(
                codes::SORT_KEY_ON_SCALAR,
                "sort reads this key off each member, and these members are plain values — there is nothing to read it from. Order them by themselves: `sort(…)` or `sort(…, { order: \"desc\" })`.",
                span,
            );
            return;
        }
        let Some(key) = key else { return };
        if crate::families::values::is_keyed_value(key) {
            let what = if crate::types::field::records_alone(Some(key)).is_some() { "a record" } else { "a value with named parts" };
            self.report(
                codes::SORT_NEEDS_KEY,
                format!("sort ranks the members by what its function answers, and it answers {what}, which has no order of its own — answer one of its fields: `sort(xs, (x) => x.`Added At`)`."),
                span,
            );
            return;
        }
        if crate::types::field::collection_element_of(key).is_some() {
            self.report(
                codes::ORDER_KEY_MULTI,
                "sort needs one value per member to rank it by, and this function answers with several. Fold them to one (List.min(…), List.max(…), first(…)), or answer a single-valued field.",
                span,
            );
        }
    }

    fn named_function_params(&mut self, written: &str, scope: ScopeId) -> Vec<ClosureParam> {
        let callee = self.callee_name(written, scope);
        let Resolution::Found(id) = self.scopes.resolve(scope, &callee) else { return Vec::new() };
        // What a function's body needs of each record parameter is learned
        // on the inference walk, which a declared return type otherwise skips.
        if self.scopes.symbol(id).kind == SymbolKind::Movement {
            self.infer_movement(id);
        }
        let symbol = self.scopes.symbol(id);
        match &symbol.types.pos {
            Some(crate::types::position::Position::Closure(closure)) => closure.params.clone(),
            _ if symbol.kind == SymbolKind::Movement => self.movement_declared_params(id).unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    /// `checkMembersFieldsInHand`: the members a collection op binds to its
    /// function's parameters, against what the function's body needs of each
    /// record parameter — the call-site check, where the op makes the call.
    fn check_members_fields_in_hand(&mut self, spelling: &str, callee: &str, params: &[(ClosureParam, bool)], members: &Members, span: Span) {
        let supplied = [members.carried.as_ref(), members.element.as_ref()];
        let supplied: &[Option<&Ty>] = if members.reduce { &supplied } else { &supplied[1..] };
        for (index, (param, _)) in params.iter().enumerate() {
            let need = crate::types::position::parameter_need_of(param.plane.pos.as_deref());
            let member = supplied.get(index).copied().flatten().and_then(|ty| crate::types::field::record_in(Some(ty)).flatten());
            let (Some(need), Some(member)) = (need, member) else { continue };
            let at = format!("hands it to {callee} as '{}' (line {})", need.borrow().param, span.start.line);
            let Some(shortfall) = self.fields_in_hand_shortfall(&need, &member, &at) else { continue };
            self.report(
                codes::CALL_ARG_OPAQUE_RECORD,
                format!(
                    "{callee} needs every field of {} in hand — its body {} — and '{spelling}' hands it each member of the collection, {}, {}. Copy the fields it needs into records the program holds first ('MAP(…, (r) => {{ return node {{ name: r.name, … }} }})'), or have the function read the fields it uses one by one",
                    shortfall.what,
                    shortfall.why,
                    crate::types::position::describe_position(&member),
                    shortfall.whose
                ),
                span,
            );
        }
    }

    /// `checkMembersFitParams`: the members a collection op binds to its
    /// function's parameters, against the types those parameters are written
    /// with — the call-site fit, where the op, not the author, makes the
    /// call (TypeScript refuses `["a"].map((n: number) => n)`). REDUCE's
    /// starting value is held to its accumulator, each member to the
    /// parameter after it. Refused from version 5; from 3 the op ran, handing
    /// the function the member as it was, so an older pin is warned.
    fn check_members_fit_params(&mut self, op: &CollectionOpExpression, spelling: &str, callee: &str, params: &[(ClosureParam, bool)], members: &Members) {
        if before(self.version, 3) {
            return;
        }
        let each = (members.element.as_ref(), members.element_may_hold.as_ref(), "each member", op.source.span);
        let given = if op.op == CollectionOp::Reduce {
            vec![(members.carried.as_ref(), members.carried_may_hold.as_ref(), "its starting value", op.init.as_ref().map_or(op.span, |i| i.span)), each]
        } else {
            vec![each]
        };
        self.as_upgrade_warnings_before_5("the function is handed the member as it is", |this| {
            for (index, (ty, may_hold, argument, span)) in given.into_iter().enumerate() {
                let Some((param, written)) = params.get(index) else { continue };
                let fit = crate::families::arg_fit::ArgFit {
                    callee,
                    param: Some(param),
                    index,
                    positional: true,
                    plugin: None,
                    caller: Some(crate::families::arg_fit::ArgCaller { callee: callee.to_string(), argument: format!("{argument} '{spelling}' hands it") }),
                };
                let record = crate::types::field::record_in(ty).flatten();
                if let Some(param_ty) = &param.plane.field {
                    if record.is_none() {
                        this.refuse_maybe_record_for_value(&fit, param_ty, ty, may_hold, span, "");
                    }
                    // A parameter that took the member's own type fits it.
                    if *written {
                        this.check_value_arg_fit_at(&fit, param_ty, ty, span);
                    }
                    continue;
                }
                if let Some(param_pos) = param.plane.pos.as_deref().filter(|_| *written) {
                    this.check_call_arg_fit_at(&fit, record.as_ref(), param_pos, span);
                }
            }
        });
    }

    /// `asUpgradeWarningsBefore5`: checks whose refusals are new under
    /// version 5 — before it, each error they report is an upgrade warning
    /// saying what the older version did (`then`).
    pub fn as_upgrade_warnings_before_5(&mut self, then: &str, run: impl FnOnce(&mut Self)) {
        let from = self.diagnostics.len();
        run(self);
        if since(self.version, 5) {
            return;
        }
        for diagnostic in &mut self.diagnostics[from..] {
            if diagnostic.severity.is_some() {
                continue;
            }
            diagnostic.message = format!("{}. Before {} {then}; from it, this is refused", diagnostic.message, crate::version::describe(5));
            diagnostic.severity = Some(crate::diagnostic::Severity::Warning);
            diagnostic.upgrade = Some(true);
        }
    }

    /// What a function named as an op's function hands back.
    fn named_function_return(&mut self, written: &str, scope: ScopeId) -> ReturnShape {
        let callee = self.callee_name(written, scope);
        let Resolution::Found(id) = self.scopes.resolve(scope, &callee) else { return crate::families::returns::unknown_return() };
        if self.scopes.symbol(id).kind == SymbolKind::Movement {
            return self.movement_return(id);
        }
        // A closure arm hands back what it returns on every version, called
        // or not (`checkArm`).
        if let Some(crate::types::position::Position::Closure(closure)) = &self.scopes.symbol(id).types.pos {
            return closure.returns.clone();
        }
        self.called_closure(id).map_or_else(crate::families::returns::unknown_return, |closure| closure.returns)
    }
}

/// `keyReadsOffMember`: whether a sort's function reads a part off the member
/// it is handed in what it returns (`(r) => r.Name`, what `SORT(xs, Name)`
/// reads as from 5).
fn key_reads_off_member(arm: &ArmExpression) -> bool {
    use movement_parser::tree::MExpr;
    let ArmExpression::Closure { closure, .. } = arm else { return false };
    let Some(param) = closure.params.first().map(|p| p.name.as_str()) else { return false };
    fn reads(e: &MExpr, param: &str) -> bool {
        matches!(e, MExpr::Member { object, .. } if matches!(object.as_ref(), MExpr::Name { name, .. } if name.text == param))
            || crate::families::calls::expression_children(e).into_iter().any(|c| reads(c, param))
    }
    closure.body.iter().any(|statement| match statement {
        Statement::Return(ret) => {
            // A concise body that is one call is held as the call, read whole.
            let returned = match &ret.value {
                RValue::Expr { expr } => Some(expr),
                RValue::Call { call } => call.expression.as_ref(),
                _ => None,
            };
            returned.is_some_and(|slot| movement_parser::expr::parse_expression(&slot.raw).is_ok_and(|tree| reads(&tree, param)))
        }
        _ => false,
    })
}
