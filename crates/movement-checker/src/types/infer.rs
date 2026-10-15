//! Typing one expression against a scope (`ExpressionTyping` in
//! checker/typing.ts): `infer` and `infer_exact`, the walk of a traversal's
//! steps, narrowing by the presence a condition proves, and what a choice
//! may hold (`may_hold_type`).
//!
//! The core types; the families judge. Each family that has rules about an
//! expression is called at a fixed point (`crate::families::<family>::…`)
//! with the operand types in hand, and reports through `Typing::report`.
//! A family hook never changes the type the core answers.

use std::collections::HashMap;

use indexmap::IndexMap;
use movement_parser::ast::Span;
use movement_parser::catalog::types::EdgeSchema;
use movement_parser::lowering::expression::{
    AggregationFunction, Expression, ListElement, LogicalOp, ObjectMember, StaticValue, TraversalStep,
};

use crate::codes;
use crate::diagnostic::{Diagnostic, Severity};

use super::field::*;
use super::narrowing::{PresenceProof, exists_subject, is_position_terminal, negative_presence_proofs, presence_proofs};
use super::position::{EdgeLanding, Position, describe_position, edge_landing, refine_selected, instance_of_ref, lookup_property_type, narrow_present, narrow_present_node};
use super::stdlib::{bare_coercer_returns, lookup_builtin, movement_meta_key_type, stdlib_function_by_id};

/// What the typing asks of the scope it types in (the TypeScript's
/// `ExpressionTyping` options).
pub trait TypeEnv {
    /// A name bound on the arrow plane: an instance, a record, a closure.
    fn resolve_root(&self, name: &str) -> Option<Position>;
    /// A name bound on the dot plane: a value.
    fn resolve_scalar(&self, name: &str) -> Option<Ty>;
    /// What a name bound to a choice may hold where its type cannot say.
    fn resolve_may_hold(&self, _name: &str) -> Option<Ty> {
        None
    }
    fn name_in_scope(&self, _name: &str) -> bool {
        false
    }
    /// A name known to hold a record nobody can name.
    fn is_record_name(&self, _name: &str) -> bool {
        false
    }
    /// A name bound to a block over a walk: its records, in this order.
    fn plural_order_of(&self, _name: &str) -> Option<CollectionOrder> {
        None
    }
    /// A value-plane name bound to a walk read for a field: many values.
    fn is_many_valued_name(&self, _name: &str) -> bool {
        false
    }
}

/// An environment with nothing in it.
pub struct EmptyEnv;

impl TypeEnv for EmptyEnv {
    fn resolve_root(&self, _name: &str) -> Option<Position> {
        None
    }
    fn resolve_scalar(&self, _name: &str) -> Option<Ty> {
        None
    }
}

/// The identity of an expression node, for the per-node answers kept while
/// typing (the TypeScript's `WeakMap`s). Never dereferenced.
fn key(expr: &Expression) -> usize {
    expr as *const Expression as usize
}

pub struct Typing<'a> {
    pub env: &'a dyn TypeEnv,
    pub version: u32,
    /// Where diagnostics point (one expression slot).
    pub span: Span,
    /// Hop aliases bound by the walks typed so far.
    pub locals: IndexMap<String, Option<Position>>,
    /// The walk being typed is awaited (`await x-[:E]->`).
    pub awaited: bool,
    pub last_edge_schema: Option<EdgeSchema>,
    pub last_landings: Vec<Option<Position>>,
    pub last_ordering: CollectionOrder,
    pub last_ordering_edge: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
    /// The field a write puts this value into (`WriteTargetRef`): its type,
    /// and its borrowable spelling (`crm.companies.stage`) when known.
    pub write_target: Option<(Ty, Option<String>)>,
    narrowed_scalars: HashMap<String, Ty>,
    narrowed_roots: HashMap<String, Position>,
    read_types: HashMap<usize, Option<Ty>>,
    exact_types: HashMap<usize, Option<Ty>>,
    bare_names: HashMap<usize, String>,
    /// Each traversal's own walk: its order and last edge (`walkOrderings`).
    walk_orderings: HashMap<usize, (CollectionOrder, Option<String>)>,
    /// Where each traversal landed (`walkDestinations`).
    walk_destinations: HashMap<usize, Position>,
}

impl<'a> Typing<'a> {
    pub fn new(env: &'a dyn TypeEnv, version: u32, span: Span) -> Self {
        Typing {
            env,
            version,
            span,
            locals: IndexMap::new(),
            awaited: false,
            last_edge_schema: None,
            last_landings: Vec::new(),
            last_ordering: CollectionOrder::Unknown,
            last_ordering_edge: None,
            diagnostics: Vec::new(),
            write_target: None,
            narrowed_scalars: HashMap::new(),
            narrowed_roots: HashMap::new(),
            read_types: HashMap::new(),
            exact_types: HashMap::new(),
            bare_names: HashMap::new(),
            walk_orderings: HashMap::new(),
            walk_destinations: HashMap::new(),
        }
    }

    pub fn report(&mut self, code: &str, message: impl Into<String>) {
        self.diagnostics.push(Diagnostic::error(code, message, self.span));
    }

    pub fn report_with(&mut self, code: &str, message: impl Into<String>, severity: Severity) {
        let mut diagnostic = Diagnostic::error(code, message, self.span);
        diagnostic.severity = Some(severity);
        self.diagnostics.push(diagnostic);
    }

    /// The type a node was read as (widened), once typed.
    pub fn read_type_of(&self, expr: &Expression) -> Option<&Option<Ty>> {
        self.read_types.get(&key(expr))
    }

    /// The type a node was typed as before widening, once typed.
    pub fn exact_type_of(&self, expr: &Expression) -> Option<&Option<Ty>> {
        self.exact_types.get(&key(expr))
    }

    /// A traversal's own walk, once typed: its order and its last edge.
    pub fn walk_ordering_of(&self, expr: &Expression) -> Option<&(CollectionOrder, Option<String>)> {
        self.walk_orderings.get(&key(expr))
    }

    /// Where a traversal landed, once typed.
    pub fn walk_destination_of(&self, expr: &Expression) -> Option<&Position> {
        self.walk_destinations.get(&key(expr))
    }

    /// The bare name a node reads, once typed.
    pub fn bare_name_of(&self, expr: &Expression) -> Option<&str> {
        self.bare_names.get(&key(expr)).map(String::as_str)
    }

    // ── Names ──

    /// `rootType`: a name on the arrow plane.
    pub fn root_type(&self, name: &str) -> Option<Position> {
        if let Some(narrowed) = self.narrowed_roots.get(name) {
            return Some(narrowed.clone());
        }
        if let Some(local) = self.locals.get(name) {
            return local.clone();
        }
        self.env.resolve_root(name)
    }

    /// `scalarType`: a name on the dot plane.
    pub fn scalar_type(&self, name: &str) -> Option<Ty> {
        if let Some(narrowed) = self.narrowed_scalars.get(name) {
            return Some(narrowed.clone());
        }
        self.env.resolve_scalar(name)
    }

    /// `bareNameType`: a name read as a value.
    pub fn bare_name_type(&self, name: &str) -> Option<Ty> {
        if let Some(scalar) = self.scalar_type(name) {
            return Some(scalar);
        }
        let record = record_value_of(self.root_type(name).as_ref()).or_else(|| self.env.is_record_name(name).then(|| Ty::Record(None)))?;
        Some(match self.env.plural_order_of(name) {
            Some(order) => list_of(record, order),
            None => record,
        })
    }

    /// `walkStart`: where a walk off `name` starts.
    pub fn walk_start(&self, name: &str) -> Option<Position> {
        if let Some(root) = self.root_type(name) {
            return Some(root);
        }
        let scalar = self.scalar_type(name);
        let position = record_head_position(scalar.as_ref())?;
        if !matches!(position, Position::MaybeEmpty(_))
            && is_maybe_absent(scalar.as_ref())
            && scalar.as_ref().is_some_and(|s| matches!(strip_absent(s), Ty::Record(_)))
            && self.version >= 3
        {
            return Some(Position::MaybeEmpty(Box::new(position)));
        }
        Some(position)
    }

    /// `nameMayBeAbsent`: `None` when nothing is known of the name.
    pub fn name_may_be_absent(&self, name: &str) -> Option<bool> {
        if let Some(scalar) = self.scalar_type(name) {
            return Some(is_maybe_absent(Some(&scalar)));
        }
        self.root_type(name).map(|node| matches!(node, Position::MaybeEmpty(_)))
    }

    // ── Entry points ──

    /// `infer`: the type a value is read as (a tuple at the top widened to its list).
    pub fn infer(&mut self, expr: &Expression) -> Option<Ty> {
        let exact = self.infer_exact(expr);
        self.widen(exact)
    }

    /// `inferExact`: the type before widening.
    pub fn infer_exact(&mut self, expr: &Expression) -> Option<Ty> {
        self.infer_exact_at(expr, None)
    }

    fn widen(&mut self, ty: Option<Ty>) -> Option<Ty> {
        if let Some(mixed) = mixed_tuple_message(ty.as_ref()) {
            self.report(codes::LIST_MIXED, mixed);
        }
        widen_tuples(ty, self.version)
    }

    /// `inferAt`: `expr` read with `position` as the record its bare names read.
    pub fn infer_at(&mut self, expr: &Expression, position: Option<&Position>) -> Option<Ty> {
        let exact = self.infer_exact_at(expr, position);
        let ty = self.widen(exact);
        self.read_types.insert(key(expr), ty.clone());
        ty
    }

    pub fn infer_exact_at(&mut self, expr: &Expression, position: Option<&Position>) -> Option<Ty> {
        let ty = self.type_exact_at(expr, position);
        self.exact_types.insert(key(expr), ty.clone());
        ty
    }

    // ── Narrowing ──

    /// `withPresence`: runs `body` with what `proofs` prove present narrowed,
    /// then restores the names as they were.
    pub fn with_presence<T>(&mut self, proofs: &[PresenceProof], position: Option<&Position>, body: impl FnOnce(&mut Self, Option<&Position>) -> T) -> T {
        let restore_scalars = self.narrowed_scalars.clone();
        let restore_roots = self.narrowed_roots.clone();
        let every_plane = self.version >= 3;
        let mut narrowed_position = position.cloned();
        for proof in proofs {
            match proof {
                PresenceProof::Binding { root } => {
                    if !every_plane && narrowed_position.is_some() {
                        continue;
                    }
                    let field = if every_plane { narrowed_position.as_ref().and_then(|p| narrow_present(p, root)) } else { None };
                    if field.is_some() {
                        narrowed_position = field;
                        continue;
                    }
                    if let Some(current) = self.scalar_type(root) {
                        self.narrowed_scalars.insert(root.clone(), strip_absent(&current).clone());
                        continue;
                    }
                    if !every_plane {
                        continue;
                    }
                    if let Some(present) = self.root_type(root).as_ref().and_then(narrow_present_node) {
                        self.narrowed_roots.insert(root.clone(), present);
                    }
                }
                PresenceProof::Field { root, property } => {
                    if !every_plane {
                        continue;
                    }
                    if let Some(dict) = self.dict_with_key_present(root, property) {
                        self.narrowed_scalars.insert(root.clone(), dict);
                        continue;
                    }
                    if let Some(present) = self.walk_start(root).as_ref().and_then(|r| narrow_present(r, property)) {
                        self.narrowed_roots.insert(root.clone(), present);
                    }
                }
                PresenceProof::NonBlank { .. } => {}
            }
        }
        let answer = body(self, narrowed_position.as_ref());
        self.narrowed_scalars = restore_scalars;
        self.narrowed_roots = restore_roots;
        answer
    }

    /// Narrows a name for the rest of a statement list (an `if` arm's body):
    /// the checker's half of a guard. The caller restores with `clear_narrowing`.
    pub fn narrow_scalar(&mut self, name: &str, ty: Ty) {
        self.narrowed_scalars.insert(name.to_string(), ty);
    }

    pub fn narrow_root(&mut self, name: &str, position: Position) {
        self.narrowed_roots.insert(name.to_string(), position);
    }

    fn dict_with_key_present(&self, name: &str, key: &str) -> Option<Ty> {
        if self.root_type(name).is_some() {
            return None;
        }
        let held = self.scalar_type(name)?;
        if is_maybe_absent(Some(&held)) {
            return None;
        }
        let Ty::Dict { of, shape: Some(shape) } = &held else { return None };
        let slot = shape.get(key)?.as_ref()?;
        if !is_maybe_absent(Some(slot)) {
            return None;
        }
        let mut shape = shape.clone();
        shape.insert(key.to_string(), Some(strip_absent(slot).clone()));
        Some(Ty::Dict { of: of.clone(), shape: Some(shape) })
    }

    fn infer_logical(&mut self, op: LogicalOp, operands: &[Expression], position: Option<&Position>) {
        if self.version < 3 {
            for operand in operands {
                self.infer_at(operand, position);
            }
            return;
        }
        self.walk_logical(op, operands, 0, position);
    }

    fn walk_logical(&mut self, op: LogicalOp, operands: &[Expression], index: usize, at: Option<&Position>) {
        let Some(operand) = operands.get(index) else { return };
        self.infer_at(operand, at);
        if index == operands.len() - 1 {
            return;
        }
        let proofs = {
            let mut type_of = |o: &Expression| match self.read_types.get(&key(o)) {
                Some(known) => known.clone(),
                None => self.infer_at(o, at),
            };
            match op {
                LogicalOp::And => presence_proofs(operand, &mut type_of),
                LogicalOp::Or => negative_presence_proofs(operand, &mut type_of),
            }
        };
        self.with_presence(&proofs, at, |t, narrowed| t.walk_logical(op, operands, index + 1, narrowed));
    }

    // ── Walks ──

    fn hop_ordering(&self, from: Option<&Position>, has_order_by: bool, edge: &str, schema: Option<&EdgeSchema>) -> CollectionOrder {
        if has_order_by {
            return CollectionOrder::Ordered;
        }
        let Some(from) = from else { return CollectionOrder::Unknown };
        let sequenced = |s: Option<&EdgeSchema>| match s {
            None => CollectionOrder::Unknown,
            Some(s) if s.sequenced.is_some() => CollectionOrder::Ordered,
            Some(_) => CollectionOrder::Unordered,
        };
        match from {
            Position::Extract { .. } => CollectionOrder::Ordered,
            Position::Meta { instance } => {
                if instance.schema.collections.contains_key(edge) {
                    CollectionOrder::Unordered
                } else {
                    CollectionOrder::Unknown
                }
            }
            Position::Local(local) => sequenced(local.edges.as_ref().and_then(|e| e.get(edge)).map(|e| &e.schema)),
            _ => sequenced(schema),
        }
    }

    /// `walkSteps`: where a walk from `start` lands, its aliases bound.
    pub fn walk_steps(&mut self, start: Option<Position>, steps: &[TraversalStep], awaited: bool) -> Option<Position> {
        self.awaited = awaited;
        self.last_edge_schema = None;
        let mut landings = Vec::new();
        let mut current = start;
        let mut ordering = CollectionOrder::Unknown;
        let mut ordering_edge = None;
        for step in steps {
            match step {
                TraversalStep::Edge(edge) => {
                    let from = current.clone();
                    let landing = from.as_ref().map(|f| edge_landing(f, &edge.edge_type_id, self.version));
                    let (next, schema) = match &landing {
                        Some(EdgeLanding::Landed { landing, edge: schema }) => {
                            (Some(refine_selected(landing.clone(), edge.expression_filter.as_deref())), schema.clone())
                        }
                        Some(EdgeLanding::Untyped { edge }) => (None, edge.clone()),
                        _ => (None, None),
                    };
                    self.last_edge_schema = schema.clone();
                    crate::families::walks::observe_step(self, from.as_ref(), edge, landing.as_ref());
                    ordering =
                        self.hop_ordering(from.as_ref(), edge.cardinality.as_ref().is_some_and(|c| c.order_by.is_some()), &edge.edge_type_id, schema.as_ref());
                    ordering_edge = Some(edge.edge_type_id.clone());
                    crate::families::walks::observe_hop_order(self, edge, ordering);
                    if let Some(alias) = &edge.alias {
                        self.locals.insert(alias.clone(), next.clone());
                    }
                    if let Some(filter) = &edge.expression_filter {
                        self.infer_at(filter, next.as_ref());
                    }
                    if let Some(order_by) = edge.cardinality.as_ref().and_then(|c| c.order_by.as_deref()) {
                        let key_ty = self.infer_at(order_by, next.as_ref());
                        crate::families::values::ordering_key(self, order_by, key_ty.as_ref(), &format!("ORDER BY on '{}'", edge.edge_type_id));
                    }
                    crate::families::walks::observe_hop(self, from.as_ref(), edge, next.as_ref());
                    current = next;
                }
                TraversalStep::MetaEdge(meta) => {
                    if let Some(alias) = &meta.alias {
                        self.locals.insert(alias.clone(), None);
                    }
                    if let Some(filter) = &meta.expression_filter {
                        self.infer_at(filter, None);
                    }
                    current = None;
                }
                TraversalStep::LinkBack {} | TraversalStep::Resource(_) => current = None,
            }
            landings.push(current.clone());
        }
        self.last_landings = landings;
        self.last_ordering = ordering;
        self.last_ordering_edge = ordering_edge;
        current
    }

    /// `readProperty`, the typing half: a dot read off `position`. The walks
    /// family reports an unknown or ambiguous property.
    pub fn read_property(&mut self, position: Option<&Position>, property: &str) -> Option<Ty> {
        let ty = match position {
            Some(Position::Extract { node, present }) => self.read_extract_field(node, property).map(|t| {
                if present.contains(property) { strip_absent(&t).clone() } else { t }
            }),
            Some(Position::MaybeEmpty(of)) if matches!(**of, Position::Extract { .. }) => {
                let Position::Extract { node, present } = &**of else { unreachable!() };
                let read = self.read_extract_field(node, property);
                read.map(|t| maybe_absent(if present.contains(property) { strip_absent(&t).clone() } else { t }))
            }
            _ => lookup_property_type(position, property),
        };
        crate::families::walks::observe_read(self, position, property, ty.as_ref());
        ty
    }

    /// `readExtractField`, the typing half (the extraction family reports an
    /// unknown field): a typed field may not have been found, so it reads
    /// `T | absent`; text is handed over as `""` when not found, so it is
    /// present. An unannotated field is text, so written into a field text
    /// cannot be it is refused, naming the annotation (the version 1
    /// suggestion and the option-set nudge are the extraction family's).
    fn read_extract_field(&mut self, node: &super::position::ExtractNode, property: &str) -> Option<Ty> {
        let field = node.properties.get(property)?;
        if let Some(explicit) = &field.explicit {
            if self.version < 2 {
                return Some(maybe_absent(explicit.clone()));
            }
            return Some(if field.reads_as_present_text { Ty::Text } else { maybe_absent(explicit.clone()) });
        }
        if field.annotated || self.version < 2 {
            return None;
        }
        let Some((target, path)) = self.write_target.clone() else { return Some(Ty::Text) };
        match super::field::base_kind(&target) {
            Some(super::field::BaseKind::Text | super::field::BaseKind::Json | super::field::BaseKind::Absent | super::field::BaseKind::Record) => {
                return Some(Ty::Text);
            }
            _ => {}
        }
        let primitive = describe_field_type(&super::field::unwrap_list(&target));
        let borrow = path.as_deref().map(|path| {
            let segments: Vec<&str> = path.split('.').collect();
            let spelled = match segments.as_slice() {
                [graph, position, field] => format!("{graph}-[:{position}]->.`{field}`"),
                _ => path.to_string(),
            };
            format!(" (or borrow the field's own type: `{property}: <{spelled}> \"…\"`)")
        });
        let node_label = describe_position(&Position::Extract { node: std::rc::Rc::new(node.clone()), present: Default::default() });
        self.report(
            crate::codes::EXTRACT_NEEDS_ANNOTATION,
            format!(
                "'{property}' on {node_label} is text — a field with no annotation asks the model for words — and it is written into a {} field{}. Annotate it so the model answers a {primitive}: `{property}: <{primitive}> \"…\"`{}. An annotated {primitive} may not be found, so write it with '?:' (set-if-empty), or fall back with COALESCE.",
                describe_field_type(&target),
                path.as_deref().map(|p| format!(" ({p})")).unwrap_or_default(),
                borrow.unwrap_or_default()
            ),
        );
        None
    }

    /// `dictMemberRead`: `d.key` off a name holding a dict.
    fn dict_member_read(&mut self, alias_root: Option<&str>, steps: &[TraversalStep], member: &Expression) -> Option<Option<Ty>> {
        let root = alias_root?;
        if !steps.is_empty() || self.root_type(root).is_some() {
            return None;
        }
        let held = self.scalar_type(root)?;
        self.read_dict_member(&held, member, false)
    }

    fn read_dict_member(&mut self, held: &Ty, member: &Expression, within: bool) -> Option<Option<Ty>> {
        let Ty::Dict { of, shape } = strip_absent(held) else { return None };
        let (key, member_steps, member_expression) = match member {
            Expression::Property { property_type_id } => (property_type_id.clone(), None, None),
            Expression::Traverse { alias_root: Some(root), steps, expression } => (root.clone(), Some(steps.as_slice()), Some(&**expression)),
            _ => return None,
        };
        if within && shape.as_ref().is_some_and(|s| !s.contains_key(&key)) {
            return None;
        }
        let known: Option<Ty> = match shape {
            None => Some((**of).clone()),
            Some(shape) => shape.get(&key).cloned().flatten(),
        };
        let nested = member_steps.is_some_and(|s| s.is_empty()) && known.as_ref().is_some_and(|k| is_dict(strip_absent(k)));
        if self.version < 3 && !nested && !holds_records(known.as_ref()) {
            return None;
        }
        let ty = match shape {
            None => Some(maybe_absent((**of).clone())),
            Some(shape) => match shape.get(&key) {
                None => {
                    let keys: Vec<String> = shape.keys().cloned().collect();
                    crate::families::values::unknown_dict_key(self, &key, &keys);
                    None
                }
                Some(slot) => {
                    if is_maybe_absent(Some(held)) {
                        maybe_absent_opt(slot.clone())
                    } else {
                        slot.clone()
                    }
                }
            },
        };
        let (Some(steps), Some(expression)) = (member_steps, member_expression) else { return Some(ty) };
        if nested && let Some(inner_ty) = &ty {
            if let Some(inner) = self.read_dict_member(inner_ty, expression, true) {
                return Some(inner);
            }
            if self.version < 3 {
                return None;
            }
        }
        let record = record_head_position(ty.as_ref());
        let destination = self.walk_steps(record, steps, false);
        Some(self.infer_at(expression, destination.as_ref()))
    }

    // ── One node ──

    fn type_exact_at(&mut self, expr: &Expression, position: Option<&Position>) -> Option<Ty> {
        let (ty, operands) = self.type_node(expr, position);
        crate::families::values::observe(self, expr, position, &operands, ty.as_ref());
        crate::families::calls::observe(self, expr, position, &operands, ty.as_ref());
        ty
    }

    /// One node's type, and its direct operands' types in source order.
    fn type_node(&mut self, expr: &Expression, position: Option<&Position>) -> (Option<Ty>, Vec<Option<Ty>>) {
        match expr {
            Expression::Static { value } => (
                match value {
                    StaticValue::String(_) => Some(Ty::Text),
                    StaticValue::Number(_) => Some(Ty::Number),
                    StaticValue::Bool(_) => Some(Ty::Boolean),
                    StaticValue::Null => Some(Ty::Absent),
                },
                Vec::new(),
            ),
            Expression::Property { property_type_id } => match position {
                None => {
                    self.bare_names.insert(key(expr), property_type_id.clone());
                    (self.bare_name_type(property_type_id), Vec::new())
                }
                Some(_) => (self.read_property(position, property_type_id), Vec::new()),
            },
            Expression::Traverse { alias_root, steps, expression } => {
                if let Some(read) = self.dict_member_read(alias_root.as_deref(), steps, expression) {
                    return (read, Vec::new());
                }
                if exists_subject(expr).is_some() {
                    return (Some(Ty::Boolean), Vec::new());
                }
                let start = match alias_root {
                    Some(root) => self.walk_start(root),
                    None => position.cloned(),
                };
                let destination = self.walk_steps(start, steps, false);
                self.walk_orderings.insert(key(expr), (self.last_ordering, self.last_ordering_edge.clone()));
                if let Some(destination) = &destination {
                    self.walk_destinations.insert(key(expr), destination.clone());
                }
                if !steps.is_empty() && is_position_terminal(expression) {
                    return (Some(list_of(Ty::record(destination), self.last_ordering)), Vec::new());
                }
                (self.infer_at(expression, destination.as_ref()), Vec::new())
            }
            Expression::ResourceTraverse { expression, .. } => {
                self.infer_at(expression, None);
                (None, Vec::new())
            }
            Expression::Exists { steps, where_ } => {
                let destination = self.walk_steps(position.cloned(), steps, false);
                if let Some(where_) = where_ {
                    self.infer_at(where_, destination.as_ref());
                }
                (Some(Ty::Boolean), Vec::new())
            }
            Expression::List { elements } => {
                let tuple = self.list_literal_type(elements, position);
                (if self.version < 3 { self.widen(Some(tuple)) } else { Some(tuple) }, Vec::new())
            }
            Expression::Object { entries } => (self.object_literal_type(entries, position), Vec::new()),
            Expression::Concat { parts } => {
                let operands: Vec<Option<Ty>> = parts.iter().map(|p| self.infer_at(p, position)).collect();
                (Some(Ty::Text), operands)
            }
            Expression::Arithmetic { left, right, .. } => {
                let operands = vec![self.infer_at(left, position), self.infer_at(right, position)];
                (Some(Ty::Number), operands)
            }
            Expression::Compare { left, right, .. } => {
                let operands = vec![self.infer_at(left, position), self.infer_at(right, position)];
                (Some(Ty::Boolean), operands)
            }
            Expression::Logical { op, operands } => {
                self.infer_logical(*op, operands, position);
                let types = operands.iter().map(|o| self.read_types.get(&key(o)).cloned().flatten()).collect();
                (Some(Ty::Boolean), types)
            }
            Expression::Not { expression } => {
                let operand = self.infer_at(expression, position);
                (Some(Ty::Boolean), vec![operand])
            }
            Expression::Negate { expression } => {
                let operand = self.infer_at(expression, position);
                (Some(Ty::Number), vec![operand])
            }
            Expression::Conditional { condition, then, else_ } => {
                let condition_ty = self.infer_at(condition, position);
                let proofs = {
                    let mut type_of = |o: &Expression| self.infer_at(o, position);
                    presence_proofs(condition, &mut type_of)
                };
                let then_ty = self.with_presence(&proofs, position, |t, narrowed| t.infer_at(then, narrowed));
                let else_ty = self.infer_at(else_, position);
                let ty = match (&then_ty, &else_ty) {
                    (Some(a), Some(b)) if field_type_equals(a, b) => then_ty.clone(),
                    _ => None,
                };
                (ty, vec![condition_ty, then_ty, else_ty])
            }
            Expression::At { expression, index } => {
                let inner = self.infer_exact_at(expression, position);
                let index_ty = self.infer_at(index, position);
                (self.at_type(inner.as_ref(), index, index_ty.as_ref()), vec![inner, index_ty])
            }
            Expression::Aggregate { fn_, expression, .. } => {
                let inner = self.infer_at(expression, position);
                (self.aggregate_type(*fn_, inner.as_ref(), expression), vec![inner])
            }
            Expression::Llm { prompt_expression, .. } => {
                let prompt = prompt_expression.as_ref().map(|p| self.infer_at(p, position));
                (None, prompt.into_iter().collect())
            }
            Expression::Function { fn_, args } => {
                let types: Vec<Option<Ty>> = args.iter().map(|a| self.infer_at(a, position)).collect();
                (self.function_type(fn_, &types), types)
            }
            Expression::KgExists { params, .. } | Expression::KgValue { params, .. } => {
                let types: Vec<Option<Ty>> = params.iter().map(|p| self.infer_at(p, position)).collect();
                (matches!(expr, Expression::KgExists { .. }).then_some(Ty::Boolean), types)
            }
            Expression::Meta { key: meta } => {
                crate::families::walks::observe_meta(self, meta);
                (movement_meta_key_type(meta), Vec::new())
            }
            Expression::EdgeProperty { property_type_id } => {
                if let Some(declared) = lookup_property_type(position, property_type_id) {
                    return (Some(declared), Vec::new());
                }
                if let Some(bound) = self.scalar_type(property_type_id) {
                    return (Some(bound), Vec::new());
                }
                if self.env.name_in_scope(property_type_id) || instance_of_ref(position).is_some_and(|i| i.schema.edges_carry_properties == Some(true)) {
                    return (None, Vec::new());
                }
                (self.read_property(position, property_type_id), Vec::new())
            }
            Expression::AliasRef { name } => {
                self.bare_names.insert(key(expr), name.clone());
                (self.bare_name_type(name), Vec::new())
            }
            Expression::ParentResult { .. }
            | Expression::ActionResult { .. }
            | Expression::ExtractValue { .. }
            | Expression::Resource { .. }
            | Expression::LinkedObject { .. } => (None, Vec::new()),
        }
    }

    /// `AT(x, i)`: a dict's key, a tuple's slot, a list's member.
    fn at_type(&mut self, inner: Option<&Ty>, index: &Expression, index_ty: Option<&Ty>) -> Option<Ty> {
        let inner = inner?;
        let shape = strip_absent(inner);
        if let Ty::Dict { of, shape: keys } = shape {
            crate::families::values::require_dict_key(self, index_ty, "looked up in a dict");
            let literal = index.as_static_text();
            let (Some(keys), Some(literal)) = (keys, literal) else { return Some(maybe_absent((**of).clone())) };
            let Some(slot) = keys.get(literal) else {
                let known: Vec<String> = keys.keys().cloned().collect();
                crate::families::values::unknown_dict_key(self, literal, &known);
                return None;
            };
            return if is_maybe_absent(Some(inner)) { maybe_absent_opt(slot.clone()) } else { slot.clone() };
        }
        match shape {
            Ty::Tuple { of, rest } => tuple_slot_type(of, rest.as_ref(), literal_index(index), self.version),
            Ty::List { of, .. } => Some(maybe_absent((**of).clone())),
            other => Some(maybe_absent(other.clone())),
        }
    }

    fn aggregate_type(&mut self, function: AggregationFunction, inner: Option<&Ty>, operand: &Expression) -> Option<Ty> {
        use AggregationFunction as F;
        let element = inner.map(unwrap_list);
        match function {
            F::Count | F::Sum | F::Avg => Some(Ty::Number),
            F::Join => Some(Ty::Text),
            F::Min | F::Max | F::First | F::Last | F::Only => element.map(maybe_absent),
            F::Collect => {
                let order = self.collection_order(operand, inner);
                element.map(|e| list_of(e, order))
            }
            // `SORT` hands the members back in order; the values family judges its key.
            F::Sort => element.map(|e| list_of(e, CollectionOrder::Ordered)),
            F::Llm => None,
        }
    }

    /// `collectionOrdering`, the part typing needs: a walk's order is its
    /// last hop's; a value's is its list's.
    fn collection_order(&self, operand: &Expression, ty: Option<&Ty>) -> CollectionOrder {
        if matches!(operand, Expression::Traverse { steps, .. } if !steps.is_empty()) {
            return self.last_ordering;
        }
        collection_order_of(ty)
    }

    fn function_type(&mut self, function: &str, args: &[Option<Ty>]) -> Option<Ty> {
        match function {
            "file" => return Some(Ty::File),
            "coalesce" => return coalesce_type(args),
            "multi" => return multi_type(args),
            _ => {}
        }
        if let Some(coerced) = bare_coercer_returns(function) {
            return Some(coerced);
        }
        if let Some(spec) = stdlib_function_by_id(function) {
            return spec.returns.ty();
        }
        let builtin = if function == "extractone" && self.version < 3 { None } else { lookup_builtin(function) };
        match builtin {
            Some(builtin) if self.version >= 3 => builtin.returns.ty(),
            _ => None,
        }
    }

    fn list_literal_type(&mut self, elements: &[ListElement], position: Option<&Position>) -> Ty {
        enum Part {
            Slot(Option<Ty>),
            Run(Option<Ty>),
        }
        let mut parts: Vec<Part> = Vec::new();
        for element in elements {
            match element {
                ListElement::Expression(e) => parts.push(Part::Slot(self.infer_exact_at(e, position))),
                ListElement::Spread(spread) => parts.extend(self.spread_parts(&spread.expression, position).into_iter().map(|(run, ty)| {
                    if run { Part::Run(ty) } else { Part::Slot(ty) }
                })),
            }
        }
        let slots_of = |run: &[Part]| -> Vec<Option<Ty>> {
            run.iter()
                .map(|p| match p {
                    Part::Slot(t) | Part::Run(t) => t.clone(),
                })
                .collect()
        };
        let Some(first_run) = parts.iter().position(|p| matches!(p, Part::Run(_))) else {
            return Ty::Tuple { of: slots_of(&parts), rest: None };
        };
        let prefix = slots_of(&parts[..first_run]);
        let tail = &parts[first_run + 1..];
        if tail.iter().all(|p| matches!(p, Part::Slot(_))) {
            let run = match &parts[first_run] {
                Part::Run(t) | Part::Slot(t) => t.clone(),
            };
            let at = prefix.len();
            let mut of = prefix;
            of.extend(slots_of(tail));
            return Ty::Tuple { of, rest: Some(TupleRest { at, of: run.map(Box::new) }) };
        }
        let folded = match tuple_as_list(&slots_of(&parts[first_run..]), None, self.version) {
            Some(Ty::List { of, .. }) => Some(of),
            _ => None,
        };
        let at = prefix.len();
        Ty::Tuple { of: prefix, rest: Some(TupleRest { at, of: folded }) }
    }

    /// `spreadParts`, the typing half: `(is_run, type)` for each part a
    /// `...x` in a list contributes. The values family reports a spread of
    /// what is no list.
    fn spread_parts(&mut self, expr: &Expression, position: Option<&Position>) -> Vec<(bool, Option<Ty>)> {
        let Some(spread) = self.infer_exact_at(expr, position) else { return vec![(true, None)] };
        let many_valued = super::narrowing::is_walk_projection(expr)
            || (position.is_none() && super::narrowing::bare_name(expr).is_some_and(|n| self.env.is_many_valued_name(n)));
        if many_valued && holds_one_value(&spread) {
            return vec![(true, Some(spread))];
        }
        crate::families::values::list_spread(self, &spread);
        match strip_absent(&spread) {
            Ty::Tuple { of, rest } => {
                let mut parts: Vec<(bool, Option<Ty>)> = of.iter().map(|s| (false, s.clone())).collect();
                if let Some(rest) = rest {
                    parts.insert(rest.at.min(parts.len()), (true, rest.of.as_deref().cloned()));
                }
                parts
            }
            Ty::List { of, .. } => vec![(true, Some((**of).clone()))],
            present @ Ty::Union(_) => vec![(true, collection_element_of(present))],
            _ => vec![(true, None)],
        }
    }

    /// `None` where a spread could not be typed: the TypeScript types more of
    /// what a program binds than this core yet does, so an untyped spread
    /// leaves the map untyped here rather than one whose keys nobody named.
    fn object_literal_type(&mut self, members: &[ObjectMember], position: Option<&Position>) -> Option<Ty> {
        let mut shape: IndexMap<String, Option<Ty>> = IndexMap::new();
        // Keys a written entry gave, until something overwrites them.
        let mut written: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut read_types: Vec<Option<Ty>> = Vec::new();
        let mut keys_named = true;
        let mut untyped_spread = false;
        for member in members {
            match member {
                ObjectMember::Entry { key: name, value } => {
                    let exact = self.infer_exact_at(value, position);
                    read_types.push(widen_tuples(exact.clone(), self.version));
                    shape.insert(name.clone(), exact);
                    written.insert(name.clone());
                }
                ObjectMember::Spread(spread) => {
                    let Some(held) = self.infer_exact_at(&spread.expression, position) else {
                        untyped_spread = true;
                        continue;
                    };
                    let may_be_absent = is_maybe_absent(Some(&held));
                    let keys: Option<IndexMap<String, Option<Ty>>> = match strip_absent(&held) {
                        Ty::Json => {
                            keys_named = false;
                            read_types.push(Some(Ty::Json));
                            continue;
                        }
                        Ty::Dict { shape: Some(keys), .. } => Some(keys.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
                        Ty::Dict { of, shape: None } => {
                            keys_named = false;
                            read_types.push(Some((**of).clone()));
                            continue;
                        }
                        Ty::Record(Some(record)) if holds_fields_in_hand(record) => super::position::record_field_types(record),
                        present => {
                            crate::families::values::map_spread_not_keyed(self, present);
                            keys_named = false;
                            read_types.push(None);
                            continue;
                        }
                    };
                    let Some(keys) = keys else {
                        keys_named = false;
                        read_types.push(Some(Ty::Json));
                        continue;
                    };
                    for (name, ty) in keys {
                        let earlier = shape.get(&name).cloned();
                        let next = if !may_be_absent {
                            if written.contains(&name) {
                                crate::families::values::map_key_overwritten(self, &name);
                            }
                            ty
                        } else {
                            match earlier {
                                None => ty.map(maybe_absent),
                                Some(earlier) => match (earlier, ty) {
                                    (Some(e), Some(t)) => value_union(&[e, t]),
                                    _ => None,
                                },
                            }
                        };
                        written.remove(&name);
                        shape.insert(name, next.clone());
                        read_types.push(widen_tuples(next, self.version));
                    }
                }
            }
        }
        if untyped_spread {
            return None;
        }
        let first = read_types.first().cloned().flatten();
        let agree = first.as_ref().is_some_and(|f| read_types.iter().all(|t| t.as_ref().is_some_and(|t| field_type_equals(t, f))));
        let of = match (&first, agree) {
            (Some(first), true) => {
                if read_types.iter().any(|t| is_maybe_absent(t.as_ref())) {
                    maybe_absent(first.clone())
                } else {
                    first.clone()
                }
            }
            _ => Ty::Json,
        };
        if self.version < 2 {
            return Some(if agree { Ty::Dict { of: Box::new(of), shape: None } } else { Ty::Json });
        }
        let shape: Option<movement_parser::catalog::types::JsMap<Option<Ty>>> = keys_named.then(|| shape.into_iter().collect());
        Some(Ty::Dict { of: Box::new(of), shape })
    }

    // ── What a choice may hold ──

    /// `mayHoldType`: what a value may hold where its type cannot say — the
    /// mixed record/value case of a `COALESCE` or an `IF`. Read after `infer`.
    pub fn may_hold_type(&self, expr: &Expression) -> Option<Ty> {
        match expr {
            Expression::Conditional { then, else_, .. } => arms_union(&[self.may_hold_type(then), self.may_hold_type(else_)]),
            Expression::Function { fn_, args } if fn_ == "coalesce" => arms_union(&args.iter().map(|a| self.may_hold_type(a)).collect::<Vec<_>>()),
            Expression::Function { fn_, args } if fn_ == "multi" => {
                arms_union(&args.iter().map(|a| self.multi_member_type(a)).collect::<Vec<_>>()).map(|m| list_of(m, CollectionOrder::Ordered))
            }
            Expression::At { expression, .. } => self.may_hold_picked(expr, expression),
            Expression::Aggregate { fn_: AggregationFunction::First | AggregationFunction::Last | AggregationFunction::Only, expression, .. } => {
                self.may_hold_picked(expr, expression)
            }
            Expression::Object { entries } => {
                if entries.iter().any(|e| matches!(e, ObjectMember::Spread(_))) {
                    return self.exact_types.get(&key(expr)).cloned().flatten();
                }
                let shape = entries
                    .iter()
                    .filter_map(|e| match e {
                        ObjectMember::Entry { key: name, value } => Some((name.clone(), self.may_hold_type(value))),
                        ObjectMember::Spread(_) => None,
                    })
                    .collect();
                Some(Ty::Dict { of: Box::new(Ty::Json), shape: Some(shape) })
            }
            Expression::List { elements } => {
                let mut slots = Vec::new();
                for element in elements {
                    match element {
                        ListElement::Spread(_) => return self.exact_types.get(&key(expr)).cloned().flatten(),
                        ListElement::Expression(e) => slots.push(self.may_hold_type(e)),
                    }
                }
                Some(Ty::Tuple { of: slots, rest: None })
            }
            _ => {
                let held = self.bare_names.get(&key(expr)).and_then(|name| self.env.resolve_may_hold(name));
                held.or_else(|| self.exact_types.get(&key(expr)).cloned().flatten())
            }
        }
    }

    fn may_hold_picked(&self, expr: &Expression, operand: &Expression) -> Option<Ty> {
        if let Some(Some(exact)) = self.exact_types.get(&key(expr)) {
            return Some(exact.clone());
        }
        if let Expression::At { expression, index } = expr
            && let Some(index) = literal_index(index)
            && let Some(held) = self.may_hold_type(expression)
            && let Ty::Tuple { of, rest } = strip_absent(&held)
        {
            return tuple_slot_type(of, rest.as_ref(), Some(index), self.version);
        }
        let picked = self.multi_member_type(operand)?;
        arms_union(&[Some(picked), None])
    }

    fn multi_member_type(&self, arg: &Expression) -> Option<Ty> {
        let ty = self.may_hold_type(arg)?;
        match strip_absent(&ty) {
            Ty::List { of, .. } => Some((**of).clone()),
            Ty::Tuple { of, rest } => {
                let mut arms = of.clone();
                arms.push(rest.as_ref().and_then(|r| r.of.as_deref().cloned()));
                arms_union(&arms)
            }
            _ => Some(ty),
        }
    }
}

/// `literalIndex`: an integer literal.
pub fn literal_index(expr: &Expression) -> Option<i64> {
    match expr {
        Expression::Static { value: StaticValue::Number(n) } if n.0.fract() == 0.0 && n.0.is_finite() => Some(n.0 as i64),
        _ => None,
    }
}

/// `holdsFieldsInHand`: the checker holds this record's fields (a node
/// literal, an extraction, a write's handle) rather than a system's schema
/// describing them. A declared shape's graph is not told apart from a
/// system's here.
pub fn holds_fields_in_hand(position: &Position) -> bool {
    match position {
        Position::Extract { .. } | Position::Handle(_) | Position::Local(_) => true,
        Position::MaybeEmpty(of) => holds_fields_in_hand(of),
        Position::Position(_) | Position::Union(_) | Position::Meta { .. } | Position::Closure(_) => false,
    }
}
