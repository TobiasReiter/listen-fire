//! What each name is typed as: the type core's half of the walk. A binding,
//! a parameter, a declared `type` and a constructed instance each carry the
//! type their declaration gives them (`Symbol::types`), so a later
//! expression in scope types against them (`Checker::typing`).
//!
//! Typing here reports nothing: a family that judges an expression runs
//! its own `Typing` where the TypeScript reports, and surfaces what it says.

use std::rc::Rc;

use movement_parser::ast::{ClosureExpression, ConstructionCall, ExprSlot, ParamTypeRef, PathHead, PathRoot, RValue, TypeRef, ValueType};
use movement_parser::catalog::snapshot::Args;
use movement_parser::lowering::expression::{Expression, StaticValue, TraversalStep};

use crate::checker::Checker;
use crate::scope::{Resolution, ScopeId, SymbolKind};
use crate::slots::expression_of_slot;
use crate::types::field::{Ty, maybe_absent, strip_absent, unify_value_types};
use crate::types::position::{ClosureParam, ClosureType, Instance, PlaneType, Position, ReturnShape, SystemAddress, position_ref_in};
use crate::types::scope_env::{ScopeEnv, SymbolTypes};
use crate::types::field::is_maybe_absent;
use crate::types::narrowing::PresenceProof;
use crate::types::position::{narrow_present, narrow_present_node};
use crate::types::{TypeEnv, Typing};

impl Checker<'_> {
    /// A typing of expressions against `scope`.
    pub fn typing_env(&self, scope: ScopeId) -> ScopeEnv<'_> {
        ScopeEnv { scopes: &self.scopes, scope, zones: self.zones, nodes: &self.nodes, upgrading_from: self.upgrading_from, function_values: &self.function_values }
    }

    /// An expression slot's type in `scope`, and what it may hold where its
    /// type cannot say; nothing reported.
    #[allow(dead_code)] // the families' entry point; none reads it yet
    pub fn type_of_slot(&self, slot: &ExprSlot, scope: ScopeId) -> Option<(Expression, Option<Ty>, Option<Ty>)> {
        let expr = expression_of_slot(slot).ok()?;
        let env = self.typing_env(scope);
        let mut typing = Typing::new(&env, self.version, slot.span);
        let ty = typing.infer(&expr);
        let may_hold = typing.may_hold_type(&expr);
        Some((expr, ty, may_hold))
    }

    /// `declarePresence`: each proven name shadowed by its narrowed self.
    pub(crate) fn declare_presence(&mut self, proofs: &[PresenceProof], scope: ScopeId, into: ScopeId) {
        for proof in proofs {
            let Resolution::Found(id) = self.scopes.resolve(scope, proof.root()) else { continue };
            let symbol = self.scopes.symbol(id).clone();
            let mut narrowed = symbol.clone();
            match proof {
                PresenceProof::NonBlank { property, .. } => {
                    if !matches!(symbol.kind, SymbolKind::Param | SymbolKind::Alias | SymbolKind::Binding) {
                        continue;
                    }
                    match property {
                        None => narrowed.types.non_blank = true,
                        Some(property) => {
                            narrowed.types.non_blank_fields.insert(property.clone());
                        }
                    }
                }
                PresenceProof::Field { property, .. } => {
                    let Some(position) = symbol_position(&symbol.types) else { continue };
                    let Some(position) = narrow_present(&position, property) else { continue };
                    narrowed.types.pos = Some(position);
                }
                PresenceProof::Binding { .. } => {
                    if symbol.types.pos.is_none() && symbol.types.field.is_some() {
                        let Some(field) = symbol.types.field.as_ref().filter(|f| is_maybe_absent(Some(f))) else { continue };
                        narrowed.types.field = Some(strip_absent(field).clone());
                    } else {
                        let Some(position) = symbol_position(&symbol.types) else { continue };
                        let Some(position) = narrow_present_node(&position) else { continue };
                        narrowed.types.pos = Some(position);
                    }
                }
            }
            let narrowed = self.scopes.add_symbol(narrowed);
            self.scopes.declare(into, narrowed);
        }
    }

    /// `name = <slot>`: a pick off a walk binds the landing it may not find
    /// (`landedAggregatePosition`), a second name for a record binds that
    /// record (`bareNodeSymbol`), and anything else binds the value as written
    /// (`holdsValue`: a list literal stays the tuple it is).
    fn type_of_bound_slot(&self, slot: &ExprSlot, scope: ScopeId, holds_value: bool) -> Option<SymbolTypes> {
        // The slot as it was checked: each call it runs already hoisted to a name.
        if let Some((_, hoisted)) = self.nested_call_rewrite(slot, scope) {
            return self.type_of_bound_slot(&hoisted, scope, holds_value);
        }
        let expr = expression_of_slot(slot).ok()?;
        let env = self.typing_env(scope);
        let mut typing = Typing::new(&env, self.version, slot.span);
        if let Some((root, steps)) = aggregated_bare_path(&expr) {
            let start = root.and_then(|r| env.resolve_root(r));
            if let Some(start) = start {
                let landed = typing.walk_steps(Some(start), steps, false);
                if let Some(landed) = landed {
                    return Some(SymbolTypes { pos: Some(Position::MaybeEmpty(Box::new(landed))), ..SymbolTypes::default() });
                }
            }
        }
        if let Some(name) = crate::types::narrowing::bare_name(&expr)
            && let Some(pos) = env.resolve_root(name)
        {
            return Some(SymbolTypes { pos: Some(pos), ..SymbolTypes::default() });
        }
        let ty = if holds_value { typing.infer_exact(&expr) } else { typing.infer(&expr) };
        let may_hold = typing.may_hold_type(&expr);
        let may_hold = if ty.is_none() { may_hold } else { None };
        let many_valued = crate::types::narrowing::is_walk_projection(&expr)
            || crate::types::narrowing::bare_name(&expr).is_some_and(|n| env.is_many_valued_name(n));
        Some(SymbolTypes { field: ty, may_hold, many_valued, ..SymbolTypes::default() })
    }

    /// Gives `name`, bound in `scope` itself, its types.
    pub fn set_types(&mut self, scope: ScopeId, name: &str, types: SymbolTypes) {
        if let Some(id) = self.scopes.scope(scope).symbols.get(name).copied() {
            self.scopes.symbol_mut(id).types = types;
        }
    }

    /// The types a `name = value` binding carries.
    pub fn type_assigned(&mut self, name: &str, value: &RValue, scope: ScopeId) {
        if let Some(types) = self.assigned_types(Some(name), value, scope) {
            self.set_types(scope, name, types);
        }
    }

    /// The types a value carries onto the name bound to it, or (no name) as
    /// the value a `return` hands back: typed in the order a binding is —
    /// the value as written, then what checking it found (a call's return, a
    /// closure's inferred return, the record it is).
    pub fn bound_types(&mut self, name: Option<&str>, value: &RValue, bound: &crate::checker::Bound, scope: ScopeId) -> Option<SymbolTypes> {
        let mut types = self.assigned_types(name, value, scope);
        if let (Some(returns), Some(SymbolTypes { pos: Some(Position::Closure(typed)), .. })) = (&bound.closure_returns, types.as_mut()) {
            typed.returns = returns.clone();
        }
        if let Some(returned) = &bound.returned {
            types = Some(crate::families::arg_fit::types_of_return(returned));
        }
        if let Some(pos) = &bound.pos {
            types = Some(SymbolTypes { pos: Some(pos.clone()), ..SymbolTypes::default() });
        } else if bound.record {
            types = Some(SymbolTypes { is_record: true, ..SymbolTypes::default() });
        }
        if let Some(receipt) = &bound.receipt {
            let may_hold = receipt.may_hold.clone().filter(|held| crate::types::field::shows_more_handles(held, receipt.ty.as_ref()));
            types = Some(SymbolTypes { field: receipt.ty.clone(), may_hold, receipt_holds_record: receipt.holds_record, ..SymbolTypes::default() });
        }
        if let Some((returned, ordering)) = &bound.collected {
            types = Some(collected_types(returned, *ordering));
        }
        types
    }

    /// `bound_types`' first step: the value as written. A name holds it
    /// as written (a list literal stays the tuple it is); a returned value is
    /// read, a tuple widening to its list.
    fn assigned_types(&mut self, name: Option<&str>, value: &RValue, scope: ScopeId) -> Option<SymbolTypes> {
        let holds_value = name.is_some();
        let types = match value {
            RValue::Construct { construct } => self.instance_types(name?, construct, scope),
            RValue::Extract { extract } => SymbolTypes {
                pos: Some(Position::Extract {
                    node: Rc::new(self.extract_graph(crate::types::position::EXTRACT_ROOT_NAME, &extract.stages, scope)),
                    present: Default::default(),
                }),
                ..SymbolTypes::default()
            },
            RValue::ExtractCall { extract_call } => SymbolTypes { field: self.extract_call_type(extract_call, scope), ..SymbolTypes::default() },
            // From version 3 a positional call is also read as one expression
            // (`n = ONLY(…)`), and `check_call` reads it so.
            RValue::Call { call } if call.expression.is_some() => call.expression.as_ref().and_then(|expr| self.type_of_bound_slot(expr, scope, holds_value))?,
            RValue::Expr { expr } => self.type_of_bound_slot(expr, scope, holds_value)?,
            RValue::Closure { closure } => {
                SymbolTypes { pos: self.closure_type(closure, scope).map(Position::Closure), ..SymbolTypes::default() }
            }
            _ => return None,
        };
        Some(types)
    }

    /// An instance: the schema its construction picks.
    fn instance_types(&mut self, name: &str, construct: &ConstructionCall, scope: ScopeId) -> SymbolTypes {
        let adapter = match self.scopes.resolve(scope, &construct.callee) {
            Resolution::Found(id) if self.scopes.symbol(id).kind == SymbolKind::Adapter => {
                self.scopes.symbol(id).imported_name.clone().unwrap_or_else(|| construct.callee.clone())
            }
            _ => return SymbolTypes::default(),
        };
        let credential_arg = self.catalog.adapter(&adapter).and_then(movement_parser::catalog::helpers::credential_arg_of).map(|a| a.name.clone());
        let args: Args = construct
            .args
            .iter()
            .filter(|a| a.name != "dry_run")
            .map(|a| {
                let raw = a.value.raw.trim().to_string();
                let raw = if credential_arg.as_ref() == Some(&a.name) { self.imported_credential_name(&raw, scope) } else { raw };
                (a.name.clone(), raw)
            })
            .collect();
        let Some(schema) = self.catalog.instantiate(&adapter, &args) else { return SymbolTypes::default() };
        let schema = self.schemas.entry(schema as *const _ as usize).or_insert_with(|| Rc::new(schema.clone())).clone();
        let address = self.address_of(&adapter, credential_arg.as_deref(), construct, scope);
        let instance = Rc::new(Instance { name: name.to_string(), schema, declared: None, address });
        SymbolTypes { pos: Some(Position::Meta { instance }), ..SymbolTypes::default() }
    }

    /// `addressTokenOf`: the system a construction reaches — its adapter, its
    /// credential and the values of its other arguments — when every one of
    /// those is a literal.
    fn address_of(&self, adapter: &str, credential_arg: Option<&str>, construct: &ConstructionCall, scope: ScopeId) -> Option<SystemAddress> {
        let credential_name = credential_arg.unwrap_or("credentials");
        let credential = construct.args.iter().find(|a| a.name == credential_name).map(|a| self.imported_credential_name(a.value.raw.trim(), scope));
        let mut args = Vec::new();
        for arg in construct.args.iter().filter(|a| Some(a.name.as_str()) != credential_arg) {
            let Ok(Expression::Static { value }) = expression_of_slot(&arg.value) else { return None };
            let spelled = match value {
                StaticValue::String(text) => serde_json::to_string(&text).ok()?,
                StaticValue::Number(n) => serde_json::to_string(&n).ok()?,
                StaticValue::Bool(b) => b.to_string(),
                StaticValue::Null => "null".to_string(),
            };
            args.push((arg.name.clone(), spelled));
        }
        args.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
        Some(SystemAddress { adapter: adapter.to_string(), credential, args })
    }

    /// `checkPathHead`, the typing half: where a head's walk starts (a record
    /// the root names or holds) and the hops it takes. `None` when the hops do
    /// not parse to a walk (a `_resources` head, a syntax error), which stays
    /// untyped; a rootless head starts nowhere.
    pub fn head_walk(&self, head: &PathHead, scope: ScopeId) -> Option<(Option<Position>, Vec<TraversalStep>)> {
        let probe_root = match &head.root {
            None => String::new(),
            Some(PathRoot::Name { name }) => crate::families::names::spell_name(name),
            Some(PathRoot::Expression { .. }) => crate::checker::EXPRESSION_ROOT_PROBE.to_string(),
        };
        let probe = format!("{probe_root}{}.`__movement_head_probe__`", head.hops_raw);
        let Ok(Expression::Traverse { steps, .. }) = crate::slots::expression_of_text(&probe) else { return None };
        let start = match &head.root {
            None => None,
            Some(PathRoot::Name { name }) => {
                let env = self.typing_env(scope);
                env.resolve_root(name).or_else(|| {
                    let held = crate::types::field::widen_tuples(env.resolve_scalar(name), self.version);
                    crate::types::field::record_head_position(held.as_ref())
                })
            }
            Some(PathRoot::Expression { expr }) => {
                let held = self.type_of_slot(expr, scope).and_then(|(_, ty, _)| ty);
                crate::types::field::record_head_position(held.as_ref())
            }
        };
        Some((start, steps))
    }

    /// A `type` declaration: the closed option set it names.
    pub fn type_declared(&mut self, scope: ScopeId, name: &str, options: &[String]) {
        let field = Ty::Enum { options: options.to_vec(), open: None };
        self.set_types(scope, name, SymbolTypes { field: Some(field), ..SymbolTypes::default() });
    }

    /// A parameter: the plane its declared type puts it on.
    pub fn type_param(&mut self, body: ScopeId, name: &str, type_: &ParamTypeRef, declared_in: ScopeId, of: &ParamOf) {
        let plane = self.parameter_plane(of, name, self.plane_type_of(type_, declared_in));
        self.set_types(body, name, SymbolTypes { pos: plane.pos.map(|p| *p), field: plane.field, ..SymbolTypes::default() });
    }

    /// `asParameter` on a parameter's plane: a record parameter carries its
    /// function's cell for it, shared by every walk of the body.
    pub fn parameter_plane(&self, of: &ParamOf, param: &str, plane: PlaneType) -> PlaneType {
        let (Some(pos), Some(owner)) = (plane.pos.as_ref(), of.owner) else { return plane };
        let pos = (**pos).clone();
        let mut needs = self.param_needs.borrow_mut();
        let cells = needs.entry(owner).or_default();
        PlaneType { pos: Some(Box::new(crate::types::position::as_parameter(pos, cells, &of.function, param))), field: plane.field }
    }

    /// `planeTypeOf`: a written type, on whichever plane it lives.
    pub fn plane_type_of(&self, type_: &ParamTypeRef, scope: ScopeId) -> PlaneType {
        match type_ {
            ParamTypeRef::Value(value) => PlaneType { field: self.value_member_type(value, scope), pos: None },
            ParamTypeRef::Name(reference) => {
                if reference.hops_raw.is_none() && reference.position.is_none() {
                    if let Some(scalar) = Ty::from_scalar_name(&reference.graph) {
                        return PlaneType { field: Some(scalar), pos: None };
                    }
                    if let Some(declared) = self.declared_type_in(&reference.graph, scope) {
                        return PlaneType { field: Some(declared), pos: None };
                    }
                }
                PlaneType { pos: self.position_from_type_ref(reference, scope).map(Box::new), field: None }
            }
        }
    }

    /// `declaredTypeIn`: a `type` declaration's option set.
    pub fn declared_type_in(&self, name: &str, scope: ScopeId) -> Option<Ty> {
        match self.scopes.resolve(scope, name) {
            Resolution::Found(id) if self.scopes.symbol(id).kind == SymbolKind::Type => {
                self.scopes.symbol(id).types.field.clone().filter(|t| matches!(t, Ty::Enum { .. }))
            }
            _ => None,
        }
    }

    /// `positionFromTypeRef`: `<crm.Company>` is a position (or a union) of
    /// the instance `crm`, `<crm>` the instance itself, and `<crm-[:E]->>`
    /// the position the event address names.
    pub fn position_from_type_ref(&self, reference: &TypeRef, scope: ScopeId) -> Option<Position> {
        let Resolution::Found(id) = self.scopes.resolve(scope, &reference.graph) else { return None };
        // A declaration IS its root node, so `<Doc>` starts there; a hop off
        // the name is the retired meta-node form (refused where it is written).
        if self.scopes.symbol(id).kind == crate::scope::SymbolKind::Shape {
            return if reference.hops_raw.is_none() { self.declared_root(id) } else { None };
        }
        let Some(Position::Meta { instance }) = &self.scopes.symbol(id).types.pos else { return None };
        if let Some(hops) = &reference.hops_raw {
            return crate::types::event_address::position_from_address(instance, hops);
        }
        match &reference.position {
            None => Some(Position::Meta { instance: instance.clone() }),
            Some(name) => position_ref_in(instance, name).or_else(|| {
                let target = &instance.schema.collections.get(name)?.target;
                position_ref_in(instance, target)
            }),
        }
    }

    /// `valueMemberType`: a written value type (`<list of text>`,
    /// `<{ a: text, b?: number }>`, `<(c: <Company>) => <text>>`).
    pub fn value_member_type(&self, value: &ValueType, scope: ScopeId) -> Option<Ty> {
        match value {
            ValueType::Name { name, .. } => Ty::from_scalar_name(name).or_else(|| self.declared_type_in(name, scope)),
            ValueType::List { of, .. } => self.value_member_type(of, scope).map(Ty::list),
            ValueType::Record { keys, .. } => {
                let mut shape = Vec::new();
                for key in keys {
                    let ty = self.value_member_type(&key.type_, scope)?;
                    shape.push((key.name.clone(), if key.optional == Some(true) { maybe_absent(ty) } else { ty }));
                }
                let of = unify_value_types(&shape.iter().map(|(_, t)| Some(strip_absent(t).clone())).collect::<Vec<_>>()).unwrap_or(Ty::Json);
                Some(Ty::Dict { of: Box::new(of), shape: Some(shape.into_iter().map(|(k, t)| (k, Some(t))).collect()) })
            }
            ValueType::Closure { params, returns, .. } => {
                let mut planes = Vec::new();
                for param in params {
                    let plane = self.plane_type_of(param.type_.as_ref()?, scope);
                    if plane.field.is_none() && plane.pos.is_none() {
                        return None;
                    }
                    planes.push(ClosureParam { name: param.name.clone(), plane });
                }
                let returned = self.plane_type_of(returns, scope);
                if returned.field.is_none() && returned.pos.is_none() {
                    return None;
                }
                let label = format!("a closure <{}>", spell_value_type(value));
                let closure = ClosureType::new(label, planes, ReturnShape { returns: true, plane: returned, may_hold: None }, None);
                Some(Ty::record(Some(Position::Closure(closure))))
            }
        }
    }

    /// A closure's signature as its declaration writes it. What its body
    /// returns, where no return type is written, is the closures family's to
    /// infer (`returns` stays untyped).
    pub fn closure_type(&self, closure: &ClosureExpression, scope: ScopeId) -> Option<ClosureType> {
        let of = ParamOf::closure(closure, None);
        let params = closure
            .params
            .iter()
            .map(|param| ClosureParam {
                name: param.name.clone(),
                plane: param.type_.as_ref().map(|t| self.parameter_plane(&of, &param.name, self.plane_type_of(t, scope))).unwrap_or_default(),
            })
            .collect();
        let returns = match &closure.return_type {
            Some(written) => ReturnShape { returns: true, plane: self.plane_type_of(written, scope), may_hold: None },
            None => ReturnShape { returns: true, ..ReturnShape::default() },
        };
        Some(ClosureType::new("a closure", params, returns, Some(closure.span)))
    }
}

/// `positionTypeOf`: the record a name holds on the arrow plane, or as a value.
pub(crate) fn symbol_position(types: &SymbolTypes) -> Option<Position> {
    types.pos.clone().or_else(|| match &types.field {
        Some(Ty::Record(Some(position))) => Some((**position).clone()),
        _ => None,
    })
}

/// `planeOfReturn` for a traversal-headed block: what each walk of the body
/// returned, collected — a list of values, or the returned record (records
/// are many already, so the plurality lives on the name, with its order).
fn collected_types(returned: &ReturnShape, ordering: crate::types::field::CollectionOrder) -> SymbolTypes {
    use crate::types::field::list_of;
    let may_hold = returned.may_hold.clone().map(|held| list_of(held, ordering));
    if let Some(field) = &returned.plane.field {
        return SymbolTypes { field: Some(list_of(field.clone(), ordering)), may_hold, ..SymbolTypes::default() };
    }
    if let Some(pos) = &returned.plane.pos {
        return SymbolTypes { pos: Some((**pos).clone()), plural: Some(ordering), ..SymbolTypes::default() };
    }
    SymbolTypes { may_hold, ..SymbolTypes::default() }
}

/// `spellValueType`: a written value type as the author wrote it.
pub fn spell_value_type(value: &ValueType) -> String {
    match value {
        ValueType::Name { name, .. } => name.clone(),
        ValueType::List { of, .. } => format!("list of {}", spell_value_type(of)),
        ValueType::Record { keys, .. } => {
            let keys: Vec<String> =
                keys.iter().map(|k| format!("{}{}: {}", k.name, if k.optional == Some(true) { "?" } else { "" }, spell_value_type(&k.type_))).collect();
            format!("{{ {} }}", keys.join(", "))
        }
        ValueType::Closure { params, returns, .. } => {
            let params: Vec<String> = params.iter().map(|p| format!("{}: {}", p.name, p.type_.as_ref().map_or("?".to_string(), spell_param_type))).collect();
            format!("({}) => {}", params.join(", "), spell_param_type(returns))
        }
    }
}

fn spell_param_type(type_: &ParamTypeRef) -> String {
    match type_ {
        ParamTypeRef::Value(value) => format!("<{}>", spell_value_type(value)),
        ParamTypeRef::Name(reference) => {
            let mut spelled = reference.graph.clone();
            if let Some(position) = &reference.position {
                spelled.push('.');
                spelled.push_str(position);
            }
            if let Some(hops) = &reference.hops_raw {
                spelled.push_str(hops);
            }
            format!("<{spelled}>")
        }
    }
}

/// `aggregatedBarePath`: `FIRST`/`LAST`/`ONLY` over a walk read for its landings.
fn aggregated_bare_path(expr: &Expression) -> Option<(Option<&str>, &[movement_parser::lowering::expression::TraversalStep])> {
    use movement_parser::lowering::expression::AggregationFunction as F;
    let Expression::Aggregate { fn_: F::First | F::Last | F::Only, expression, .. } = expr else { return None };
    let Expression::Traverse { alias_root, steps, expression: terminal } = &**expression else { return None };
    if steps.is_empty() || !crate::types::narrowing::is_position_terminal(terminal) {
        return None;
    }
    Some((alias_root.as_deref(), steps.as_slice()))
}



/// Whose parameter a cell is (`FieldsNeed`'s owner): a declared function, or a
/// closure by where it is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NeedOwner {
    Function(crate::scope::SymbolId),
    Closure([usize; 4]),
}

/// The function a parameter belongs to, for its need cell.
pub struct ParamOf {
    /// `None` where the function has no symbol to file under.
    pub owner: Option<NeedOwner>,
    /// How a diagnostic names the function.
    pub function: String,
}

impl ParamOf {
    pub fn closure(closure: &ClosureExpression, self_name: Option<&str>) -> ParamOf {
        let span = closure.span;
        ParamOf {
            owner: Some(NeedOwner::Closure([span.start.line, span.start.col, span.end.line, span.end.col])),
            function: self_name.unwrap_or("the closure").to_string(),
        }
    }
}
