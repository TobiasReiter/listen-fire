//! What each name is typed as: the type core's half of the walk. A binding,
//! a parameter, a declared `type` and a constructed instance each carry the
//! type their declaration gives them (`Symbol::types`), so a later
//! expression in scope types against them (`Checker::typing`).
//!
//! Typing here reports nothing: a family that judges an expression runs
//! its own `Typing` where the TypeScript reports, and surfaces what it says.

use std::rc::Rc;

use movement_parser::ast::{ClosureExpression, ConstructionCall, ExprSlot, ParamTypeRef, RValue, TypeRef, ValueType};
use movement_parser::catalog::snapshot::Args;
use movement_parser::lowering::expression::Expression;

use crate::checker::Checker;
use crate::scope::{Resolution, ScopeId, SymbolKind};
use crate::slots::expression_of_slot;
use crate::types::field::{Ty, maybe_absent, strip_absent, unify_value_types};
use crate::types::position::{ClosureParam, ClosureType, Instance, PlaneType, Position, ReturnShape, position_ref_in};
use crate::types::scope_env::{ScopeEnv, SymbolTypes};
use crate::types::{TypeEnv, Typing};

impl Checker<'_> {
    /// A typing of expressions against `scope`.
    pub fn typing_env(&self, scope: ScopeId) -> ScopeEnv<'_> {
        ScopeEnv { scopes: &self.scopes, scope }
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

    /// `name = <slot>`: a pick off a walk binds the landing it may not find
    /// (`landedAggregatePosition`), a second name for a record binds that
    /// record (`bareNodeSymbol`), and anything else binds the value as written
    /// (`holdsValue`: a list literal stays the tuple it is).
    fn type_of_bound_slot(&self, slot: &ExprSlot, scope: ScopeId) -> Option<SymbolTypes> {
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
        let ty = typing.infer_exact(&expr);
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
        let types = match value {
            RValue::Construct { construct } => self.instance_types(name, construct, scope),
            RValue::Expr { expr } => match self.type_of_bound_slot(expr, scope) {
                Some(types) => types,
                None => return,
            },
            RValue::Closure { closure } => {
                SymbolTypes { pos: self.closure_type(closure, scope).map(Position::Closure), ..SymbolTypes::default() }
            }
            _ => return,
        };
        self.set_types(scope, name, types);
    }

    /// An instance: the schema its construction picks.
    fn instance_types(&mut self, name: &str, construct: &ConstructionCall, scope: ScopeId) -> SymbolTypes {
        let adapter = match self.scopes.resolve(scope, &construct.callee) {
            Resolution::Found(id) if self.scopes.symbol(id).kind == SymbolKind::Adapter => {
                self.scopes.symbol(id).imported_name.clone().unwrap_or_else(|| construct.callee.clone())
            }
            _ => return SymbolTypes::default(),
        };
        let args: Args = construct.args.iter().map(|a| (a.name.clone(), a.value.raw.clone())).collect();
        let Some(schema) = self.catalog.instantiate(&adapter, &args) else { return SymbolTypes::default() };
        let schema = self.schemas.entry(schema as *const _ as usize).or_insert_with(|| Rc::new(schema.clone())).clone();
        let instance = Rc::new(Instance { name: name.to_string(), schema });
        SymbolTypes { pos: Some(Position::Meta { instance }), ..SymbolTypes::default() }
    }

    /// A `type` declaration: the closed option set it names.
    pub fn type_declared(&mut self, scope: ScopeId, name: &str, options: &[String]) {
        let field = Ty::Enum { options: options.to_vec(), open: None };
        self.set_types(scope, name, SymbolTypes { field: Some(field), ..SymbolTypes::default() });
    }

    /// A parameter: the plane its declared type puts it on.
    pub fn type_param(&mut self, body: ScopeId, name: &str, type_: &ParamTypeRef, declared_in: ScopeId) {
        let plane = self.plane_type_of(type_, declared_in);
        self.set_types(body, name, SymbolTypes { pos: plane.pos.map(|p| *p), field: plane.field, ..SymbolTypes::default() });
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

    /// `positionFromTypeRef`, the part without hops: `<crm.Company>` is a
    /// position (or a union) of the instance `crm`, `<crm>` the instance
    /// itself. A type written with hops is the walks family's to resolve.
    pub fn position_from_type_ref(&self, reference: &TypeRef, scope: ScopeId) -> Option<Position> {
        let Resolution::Found(id) = self.scopes.resolve(scope, &reference.graph) else { return None };
        let Some(Position::Meta { instance }) = &self.scopes.symbol(id).types.pos else { return None };
        if let Some(hops) = &reference.hops_raw {
            return position_from_address(instance, hops);
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
                let closure = ClosureType { label, params: planes, returns: ReturnShape { returns: true, plane: returned, may_hold: None } };
                Some(Ty::record(Some(Position::Closure(closure))))
            }
        }
    }

    /// A closure's signature as its declaration writes it. What its body
    /// returns, where no return type is written, is the closures family's to
    /// infer (`returns` stays untyped).
    pub fn closure_type(&self, closure: &ClosureExpression, scope: ScopeId) -> Option<ClosureType> {
        let params = closure
            .params
            .iter()
            .map(|param| ClosureParam { name: param.name.clone(), plane: param.type_.as_ref().map(|t| self.plane_type_of(t, scope)).unwrap_or_default() })
            .collect();
        let returns = match &closure.return_type {
            Some(written) => ReturnShape { returns: true, plane: self.plane_type_of(written, scope), may_hold: None },
            None => ReturnShape { returns: true, ..ReturnShape::default() },
        };
        Some(ClosureType { label: "a closure".to_string(), params, returns })
    }
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

/// `positionFromAddress`: the position an event address names — the key the
/// host grafted it under. A pinned address is narrower than its event.
fn position_from_address(instance: &crate::types::InstanceRef, hops_raw: &str) -> Option<Position> {
    let address = crate::types::address::event_address_of_hops(hops_raw)?;
    let resolved = position_ref_in(instance, &crate::types::address::event_address_key(&address))?;
    let narrowed = !address.narrowing.is_empty();
    Some(match resolved {
        Position::Position(mut record) if narrowed => {
            record.narrows_event = Some(address.event.clone());
            Position::Position(record)
        }
        Position::Union(mut union) if narrowed => {
            union.narrows_event = Some(address.event.clone());
            Position::Union(union)
        }
        other => other,
    })
}
