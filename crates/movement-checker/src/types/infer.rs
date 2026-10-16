//! Typing one expression against a scope (`ExpressionTyping` in
//! checker/typing.ts): `infer` and `infer_exact`, the walk of a traversal's
//! steps, narrowing by the presence a condition proves, and what a choice
//! may hold (`may_hold_type`).
//!
//! The core types; the families judge. Each family that has rules about an
//! expression is called at a fixed point (`crate::families::<family>::…`)
//! with the operand types in hand, and reports through `Typing::report`.
//! A family hook never changes the type the core answers.

use std::rc::Rc;
use std::collections::HashMap;

use indexmap::IndexMap;
use movement_parser::ast::Span;
use movement_parser::version::since;
use movement_parser::surface::phrase::spell_word;
use movement_parser::catalog::types::EdgeSchema;
use movement_parser::lowering::expression::{
    AggregationFunction, EdgeStep, Expression, ListElement, LogicalOp, ObjectMember, StaticValue, TraversalStep,
};

use crate::codes;
use crate::diagnostic::{Diagnostic, Severity};

use super::field::*;
use super::narrowing::{PresenceProof, exists_subject, is_position_terminal, negative_presence_proofs, presence_proofs};
use super::unions::{RecordJoin, join_field_types, join_positions, joined_under, one_record_of};
use super::position::{EdgeLanding, Position, describe_position, edge_landing, refine_selected, instance_of_ref, lookup_property_type, narrow_present, narrow_present_node};
use super::stdlib::{bare_coercer_returns, movement_meta_key_type, stdlib_function_by_id};

/// What the typing asks of the scope it types in (the TypeScript's
/// `ExpressionTyping` options).
pub trait TypeEnv {
    /// A name bound on the arrow plane: an instance, a record, a closure.
    fn resolve_root(&self, name: &str) -> Option<Position>;
    /// A name bound on the dot plane: a value.
    fn resolve_scalar(&self, name: &str) -> Option<Ty>;
    /// A movement parameter typed against an event the catalog does not
    /// describe (`undescribedEventOf`); its `resolve_root` is `None`.
    fn undescribed_event(&self, _name: &str) -> Option<crate::families::walks::UndescribedEvent> {
        None
    }
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
    /// `isDeclaredGraphToken`: the instance is a declared shape's own graph
    /// (its records' fields are the program's words), not a system's.
    fn is_declared_graph(&self, _instance: &super::position::InstanceRef) -> bool {
        false
    }
    /// `isRecordReceipt`: a combinator's answer one of whose arms hands back a record.
    fn is_record_receipt(&self, _name: &str) -> bool {
        false
    }
    /// `upgradingFrom`: the version a check for a move up starts from.
    fn upgrading_from(&self) -> Option<u32> {
        None
    }
    /// Whether the check behind this typing applies the union rule before
    /// version 5 (`RecordUnions`); `None` outside a check.
    fn record_unions(&self) -> Option<&super::unions::RecordUnions> {
        None
    }
    /// Whether the host's zone database knows `zone`; `None` for a typing
    /// with no host behind it (one outside a check), which accuses nothing.
    fn is_zone(&self, _zone: &str) -> Option<bool> {
        None
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
    /// Edges read bare that their source would announce (`onWatchableRead`):
    /// whoever polls decides whether that is worth saying.
    pub watchable_reads: Vec<String>,
    /// The receipt each MOV_RECEIPT_RECORD_SLOT in `diagnostics` names, in
    /// order: whoever surfaces them warns once per receipt.
    pub receipt_reads: Vec<String>,
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
    /// Expressions a closure operand was refused in (`closureOperandRefused`),
    /// so a list or map holding one does not say so again.
    closure_operand_refused: std::collections::HashSet<usize>,
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
            watchable_reads: Vec::new(),
            receipt_reads: Vec::new(),
            diagnostics: Vec::new(),
            write_target: None,
            narrowed_scalars: HashMap::new(),
            narrowed_roots: HashMap::new(),
            read_types: HashMap::new(),
            exact_types: HashMap::new(),
            bare_names: HashMap::new(),
            walk_orderings: HashMap::new(),
            walk_destinations: HashMap::new(),
            closure_operand_refused: std::collections::HashSet::new(),
        }
    }

    pub fn report(&mut self, code: &str, message: impl Into<String>) {
        self.diagnostics.push(Diagnostic::error(code, message, self.span));
    }

    /// Does this typing apply the union rule (`unions::one_record_of`)?
    pub fn record_join(&self) -> RecordJoin<'a> {
        RecordJoin::under(self.version, self.env.record_unions())
    }

    /// What a site whose arms are these types is under the union rule, where
    /// this check applies it; `old`, its answer before version 5, where not.
    fn joined_records(&self, types: &[Ty], old: Option<Ty>) -> Option<Ty> {
        joined_under(Some(self.record_join()), one_record_of(types), old)
    }

    /// `probeEach`: one step (a field read, an edge hop) off every record a
    /// `OneOf` may be — what every member offers, or a refusal naming the
    /// member that does not offer it. The first refusal among a member's
    /// reports is the union's, said of that member; anything that is no
    /// refusal (a warning) is said as it was.
    fn probe_each<T>(
        &mut self,
        members: &[Position],
        mut step: impl FnMut(&mut Self, &Position) -> Option<T>,
        refusal: impl Fn(&Position, &str) -> String,
    ) -> Option<Vec<Option<T>>> {
        let mut answers = Vec::new();
        for member in members {
            let (before, receipts) = (self.diagnostics.len(), self.receipt_reads.len());
            let answer = step(self, member);
            let gathered = self.diagnostics.split_off(before);
            if let Some(refused) = gathered.iter().find(|d| d.is_error()) {
                self.receipt_reads.truncate(receipts);
                let message = refusal(member, refused.message.strip_suffix('.').unwrap_or(&refused.message));
                self.report(&refused.code.clone(), message);
                return None;
            }
            self.diagnostics.extend(gathered);
            answers.push(answer);
        }
        Some(answers)
    }

    /// `stepEdge`: one edge step off `from`, reported.
    fn step_edge(&mut self, from: Option<&Position>, edge: &EdgeStep) -> (Option<Position>, Option<EdgeSchema>) {
        let landing = from.map(|f| edge_landing(f, &edge.edge_type_id, self.version));
        let stepped = match &landing {
            // A record reached through a function's parameter is the
            // caller's record's child: what the body needs of it is the
            // parameter's need.
            Some(EdgeLanding::Landed { landing, edge: schema }) => (
                super::position::with_parameter_of(from, Some(refine_selected(landing.clone(), edge.expression_filter.as_deref()))),
                schema.clone(),
            ),
            Some(EdgeLanding::Untyped { edge }) => (None, edge.clone()),
            _ => (None, None),
        };
        crate::families::walks::observe_step(self, from, edge, landing.as_ref());
        stepped
    }

    /// `stepEveryMember`: `who-[:edge]->` off one of several records — every
    /// member's landing, joined.
    fn step_every_member(&mut self, members: &[Position], edge: &EdgeStep) -> Option<Position> {
        let union = describe_position(&Position::OneOf(members.to_vec()));
        let name = edge.edge_type_id.clone();
        let landings = self.probe_each(members, |t, member| t.step_edge(Some(member), edge).0, |member, refused| {
            format!(
                "'-[:{name}]->' can't be walked here: this may be {union}, and it walks only what every one of them has — {} refuses it ({refused}). Walk it where you know which record you hold",
                describe_position(member)
            )
        })?;
        let landings: Vec<Position> = landings.into_iter().collect::<Option<_>>()?;
        join_positions(&landings.iter().collect::<Vec<_>>()).map(|joined| joined.position)
    }

    /// `readEveryMember`: `who.Name` off one of several records — every
    /// member's field, joined.
    fn read_every_member(&mut self, members: &[Position], property: &str) -> Option<Ty> {
        let union = describe_position(&Position::OneOf(members.to_vec()));
        let types = self.probe_each(members, |t, member| t.read_property(Some(member), property), |member, refused| {
            format!(
                "'{property}' can't be read here: this may be {union}, and it reads only what every one of them has — {} refuses it ({refused}). Read it where you know which record you hold",
                describe_position(member)
            )
        })?;
        let types: Vec<Ty> = types.into_iter().collect::<Option<_>>()?;
        join_field_types(&types)
    }

    /// `refuseClosureAsData` (language version 5): a value whose type is —
    /// or may be, or holds — a closure is refused where it would be kept.
    pub fn refuse_closure_as_data(&mut self, expr: &Expression, ty: Option<&Ty>, where_: &str) {
        if self.version < 5 || self.closure_operand_refused.contains(&key(expr)) {
            return;
        }
        if crate::types::field::may_be_closure(ty) || crate::types::field::may_be_closure(self.may_hold_type(expr).as_ref()) {
            self.report(crate::codes::CLOSURE_NOT_DATA, crate::types::field::closure_not_data_message(where_));
        }
    }

    /// `refuseClosureOperands` (language version 5): a closure as an operand
    /// of a value expression, refused once for the whole expression, which
    /// is remembered so a list or map holding it does not say so again. True
    /// when it fired.
    pub fn refuse_closure_operands(&mut self, operands: &[(&Expression, Option<&Ty>)], whole: &Expression, operation: &str) -> bool {
        if self.version < 5 {
            return false;
        }
        let closure = operands.iter().any(|(operand, ty)| {
            crate::types::field::may_be_closure(*ty) || crate::types::field::may_be_closure(self.may_hold_type(operand).as_ref())
        });
        if !closure {
            return false;
        }
        self.report(crate::codes::CLOSURE_NOT_DATA, crate::types::field::closure_not_data_message(&format!("a value {operation} is")));
        self.closure_operand_refused.insert(key(whole));
        true
    }

    /// `reportUndescribedEvent`: a read off `name` — a field, a hop — where
    /// `name` is a movement parameter whose event the catalog does not
    /// describe, and nothing in this expression has given it a type.
    fn report_undescribed_event(&mut self, name: &str) {
        if self.narrowed_roots.contains_key(name) || self.locals.contains_key(name) {
            return;
        }
        let Some(event) = self.env.undescribed_event(name) else { return };
        if let Some(diagnostic) = crate::families::walks::undescribed_event_diagnostic(self.version, name, &event, self.span) {
            self.diagnostics.push(diagnostic);
        }
    }

    pub fn report_with(&mut self, code: &str, message: impl Into<String>, severity: Severity) {
        let mut diagnostic = Diagnostic::error(code, message, self.span);
        diagnostic.severity = Some(severity);
        self.diagnostics.push(diagnostic);
    }

    /// A warning said only because this check is for a move up (`'upgrade'`).
    pub fn report_upgrade(&mut self, code: &str, message: impl Into<String>) {
        let mut diagnostic = Diagnostic::error(code, message, self.span);
        diagnostic.severity = Some(Severity::Warning);
        diagnostic.upgrade = Some(true);
        self.diagnostics.push(diagnostic);
    }

    /// `upgradeCrosses`: this check is for a move up across version `n`.
    pub fn upgrade_crosses(&self, n: u32) -> bool {
        self.env.upgrading_from().is_some_and(|from| from < n && self.version >= n)
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

    /// `bareNameType` as the walker reads it: a read of a combinator's
    /// answer one of whose arms hands back a record is warned on a move up
    /// across 5 (`reportReceiptRecordSlot`) — that slot read null before.
    fn read_bare_name(&mut self, name: &str) -> Option<Ty> {
        if self.env.is_record_receipt(name) && self.upgrade_crosses(5) {
            self.report_upgrade(
                crate::codes::RECEIPT_RECORD_SLOT,
                format!(
                    "since {} a record an arm hands back reads as that record through '{name}' (`{}`, a field of it, a null check); before, that slot read null. If the program relied on the null, change it, then upgrade.",
                    crate::version::describe(5),
                    self.code(&format!("AT({name}, i)"))
                ),
            );
            self.receipt_reads.push(name.to_string());
        }
        self.bare_name_type(name)
    }

    /// `walkStart`: where a walk off `name` starts.
    pub fn walk_start(&self, name: &str) -> Option<Position> {
        if let Some(root) = self.root_type(name) {
            return Some(root);
        }
        let scalar = self.scalar_type(name);
        // A tuple of records walks as the list it widens to, its members
        // joined by the union rule, so a walk off `[lead, co]` asks every member.
        let walked = match scalar.as_ref().map(strip_absent) {
            Some(Ty::Tuple { .. }) => widen_tuples_joining(scalar.clone(), self.version, self.record_join()),
            _ => scalar.clone(),
        };
        let position = record_head_position(walked.as_ref())?;
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

    /// Program text this walk's messages suggest, in the program's spelling.
    pub fn code(&self, text: &str) -> String {
        movement_parser::surface::phrase::spell_code(text, self.version)
    }

    fn widen(&mut self, ty: Option<Ty>) -> Option<Ty> {
        if let Some(mixed) = mixed_tuple_message(ty.as_ref(), self.version) {
            self.report(codes::LIST_MIXED, mixed);
        }
        widen_tuples_joining(ty, self.version, self.record_join())
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
        Rc::make_mut(&mut shape).insert(key.to_string(), Some(strip_absent(slot).clone()));
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
                    let union = match &from {
                        Some(Position::OneOf(members)) => Some(members),
                        Some(Position::MaybeEmpty(of)) => match &**of {
                            Position::OneOf(members) => Some(members),
                            _ => None,
                        },
                        _ => None,
                    };
                    let (next, schema) = match union {
                        Some(members) if !(edge.edge_type_id.starts_with('#') && self.version >= 5) => (self.step_every_member(members, edge), None),
                        _ => self.step_edge(from.as_ref(), edge),
                    };
                    self.last_edge_schema = schema.clone();
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
                    crate::families::walks::report_in_memory_hop_order(self, from.as_ref(), edge);
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
        match position {
            Some(Position::OneOf(members)) => return self.read_every_member(members, property),
            Some(Position::MaybeEmpty(of)) if matches!(**of, Position::OneOf(_)) => {
                let Position::OneOf(members) = &**of else { unreachable!() };
                return self.read_every_member(members, property).map(maybe_absent);
            }
            _ => {}
        }
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

    /// `readExtractField` (the extraction family's).
    fn read_extract_field(&mut self, node: &super::position::ExtractNode, property: &str) -> Option<Ty> {
        crate::families::extraction::read_extract_field(self, node, property)
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

    /// `scalarFieldRead`: `t.Name` (and `t.Name.x`) where `t` holds text, a
    /// number or a true/false value — the field read off a value that has
    /// none (from version 3).
    fn scalar_field_read(&self, alias_root: Option<&str>, steps: &[TraversalStep], member: &Expression) -> Option<ScalarFieldRead> {
        let root = alias_root?;
        if self.version < 3 || !steps.is_empty() || self.root_type(root).is_some() {
            return None;
        }
        let held = self.scalar_type(root)?;
        let scalar = match strip_absent(&held) {
            Ty::Text | Ty::Enum { .. } => FieldlessScalar::Text,
            Ty::Number => FieldlessScalar::Number,
            Ty::Boolean => FieldlessScalar::Boolean,
            _ => return None,
        };
        let field = match member {
            Expression::Property { property_type_id, .. } => property_type_id.clone(),
            Expression::Traverse { alias_root: Some(key), .. } => key.clone(),
            _ => return None,
        };
        Some(ScalarFieldRead { root: root.to_string(), field, scalar })
    }

    /// `reportScalarFieldRead`: refused from version 5; before it both
    /// engines read null, so a warning.
    fn report_scalar_field_read(&mut self, read: &ScalarFieldRead) {
        let ScalarFieldRead { root, field, scalar } = read;
        let (is, subject, bare) = scalar.nouns();
        // A nested call's staged value (`Text.upper(t).x`) has no name to show.
        let message = if root.starts_with('#') {
            format!("this is {is}, and {subject} has no fields — '{field}' is not something it holds. Use the {bare} itself, or read '{field}' off the record the {bare} came from")
        } else {
            format!("'{root}' is {is}, and {subject} has no fields — '{field}' is not something it holds. Use the {bare} itself ('{root}'), or read '{field}' off the record the {bare} came from")
        };
        if since(self.version, 5) {
            self.report(codes::TEXT_HAS_NO_FIELDS, message);
        } else {
            self.report_with(
                codes::TEXT_HAS_NO_FIELDS,
                format!("{message}. Before {} it reads null; from it, this is refused", crate::version::describe(5)),
                Severity::Warning,
            );
        }
    }

    fn read_dict_member(&mut self, held: &Ty, member: &Expression, within: bool) -> Option<Option<Ty>> {
        let Ty::Dict { of, shape } = strip_absent(held) else { return None };
        let (key, member_steps, member_expression) = match member {
            Expression::Property { property_type_id, .. } => (property_type_id.clone(), None, None),
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
            Expression::Property { property_type_id, .. } => match position {
                None => {
                    self.bare_names.insert(key(expr), property_type_id.clone());
                    (self.read_bare_name(property_type_id), Vec::new())
                }
                Some(_) => (self.read_property(position, property_type_id), Vec::new()),
            },
            Expression::Traverse { alias_root, steps, expression } => {
                if let Some(read) = self.dict_member_read(alias_root.as_deref(), steps, expression) {
                    return (read, Vec::new());
                }
                // Said, and then read as it always was (as nothing).
                if let Some(read) = self.scalar_field_read(alias_root.as_deref(), steps, expression) {
                    self.report_scalar_field_read(&read);
                }
                if exists_subject(expr).is_some() {
                    return (Some(Ty::Boolean), Vec::new());
                }
                let start = match alias_root {
                    Some(root) => self.walk_start(root),
                    None => position.cloned(),
                };
                if let (Some(root), None) = (alias_root, &start) {
                    self.report_undescribed_event(root);
                }
                let destination = self.walk_steps(start, steps, false);
                self.walk_orderings.insert(key(expr), (self.last_ordering, self.last_ordering_edge.clone()));
                if let Some(destination) = &destination {
                    self.walk_destinations.insert(key(expr), destination.clone());
                }
                if !steps.is_empty() && is_position_terminal(expression) {
                    return (Some(list_of(Ty::record(destination), self.last_ordering)), Vec::new());
                }
                if let (Some(root), true, Expression::Property { property_type_id, .. }) = (alias_root, steps.is_empty(), &**expression) {
                    crate::families::records::report_handle_read_found(self, root, destination.as_ref(), property_type_id);
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
                // …and its ELSE by what a false condition proves, as TS
                // narrows `x == null ? a : x.b`: each arm before they join.
                let else_proofs = {
                    let mut type_of = |o: &Expression| self.infer_at(o, position);
                    negative_presence_proofs(condition, &mut type_of)
                };
                let else_ty = self.with_presence(&else_proofs, position, |t, narrowed| t.infer_at(else_, narrowed));
                // A closure is not data (language version 5): IF chooses
                // between values, never between closures.
                if self.refuse_closure_operands(&[(then, then_ty.as_ref()), (else_, else_ty.as_ref())], expr, &format!("chosen by {}", spell_word("IF … THEN … ELSE … END", self.version))) {
                    return (None, vec![condition_ty, then_ty, else_ty]);
                }
                let ty = match (&then_ty, &else_ty) {
                    // An arm that never arrives leaves the other's type.
                    (Some(Ty::Never), other) | (other, Some(Ty::Never)) => other.clone(),
                    // Before version 5 an IF of one type was its THEN arm's —
                    // what that arm alone had proved included — and an IF of
                    // arms of different types, or of one that may be absent
                    // beside one that may not, untyped.
                    (Some(a), Some(b)) => {
                        let arms = [a.clone(), b.clone()];
                        let old = field_type_equals(a, b).then(|| a.clone());
                        if one_record_of(&arms).is_some() {
                            self.joined_records(&arms, old)
                        } else if is_record(Some(a)) || is_record(Some(b)) {
                            // `null` beside a record stays a value that may be one (`may_hold`).
                            old
                        } else {
                            // Values are what either arm may be, as TypeScript's
                            // `c ? a : b` is `A | B`.
                            match &old {
                                Some(_) if is_maybe_absent(Some(a)) == is_maybe_absent(Some(b)) => old,
                                _ => joined_under(Some(self.record_join()), value_union(&arms), old),
                            }
                        }
                    }
                    _ => None,
                };
                (ty, vec![condition_ty, then_ty, else_ty])
            }
            Expression::At { expression, index } => {
                let inner = self.infer_exact_at(expression, position);
                let index_ty = self.infer_at(index, position);
                if crate::families::values::refuse_record_key(self, expression, index, index_ty.as_ref()) {
                    return (None, vec![inner, index_ty]);
                }
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
                let options = crate::families::extraction::options_contract(fn_);
                let types: Vec<Option<Ty>> = args
                    .iter()
                    .enumerate()
                    .map(|(i, a)| match options {
                        Some(contract) if contract.index == i => crate::families::extraction::type_options_map(self, a, contract, position),
                        _ => self.infer_at(a, position),
                    })
                    .collect();
                crate::families::values::observe_call(self, fn_, args);
                crate::families::extraction::observe_function(self, fn_);
                if crate::families::calls::check_call_operands(self, expr, fn_, args, &types) {
                    return (None, types);
                }
                let ty = self.function_type(fn_, &types);
                crate::families::calls::check_stdlib_args(self, fn_, args, &types);
                (ty, types)
            }
            Expression::KgExists { params, .. } | Expression::KgValue { params, .. } => {
                let types: Vec<Option<Ty>> = params.iter().map(|p| self.infer_at(p, position)).collect();
                (matches!(expr, Expression::KgExists { .. }).then_some(Ty::Boolean), types)
            }
            Expression::Meta { key: meta } => {
                crate::families::walks::observe_meta(self, meta);
                (movement_meta_key_type(meta), Vec::new())
            }
            Expression::EdgeProperty { property_type_id, field_only } => {
                // Binding first, field second: the engine's order (typing.ts).
                // A hop's alias read is only ever the field.
                if !field_only && let Some(bound) = self.scalar_type(property_type_id) {
                    return (Some(bound), Vec::new());
                }
                if let Some(declared) = lookup_property_type(position, property_type_id) {
                    return (Some(declared), Vec::new());
                }
                let a_variable = !field_only && self.env.name_in_scope(property_type_id);
                if a_variable || instance_of_ref(position).is_some_and(|i| i.schema.edges_carry_properties == Some(true)) {
                    return (None, Vec::new());
                }
                (self.read_property(position, property_type_id), Vec::new())
            }
            Expression::AliasRef { name } => {
                self.bare_names.insert(key(expr), name.clone());
                (self.read_bare_name(name), Vec::new())
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
        if function == F::Count && inner.is_some_and(may_hold_empty_item) && self.upgrade_crosses(5) {
            self.report_upgrade(
                crate::codes::COUNT_COUNTS_EMPTY,
                format!(
                    "since {} 'count' counts every item of a list, an empty one (null) included, as TypeScript's '.length' does; before, it skipped empty items, and this list may hold one. If the program relied on the old count, count only the items that are there (`{}`), then upgrade.",
                    crate::version::describe(5),
                    self.code("count(filter(xs, (x) => x != null))")
                ),
            );
        }
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

    /// A call's result type; its rules ran as it was typed.
    fn function_type(&mut self, function: &str, args: &[Option<Ty>]) -> Option<Ty> {
        match function {
            "file" => return Some(Ty::File),
            "read" => return crate::families::extraction::type_read_call(self, args),
            "chunks" => return Some(crate::families::extraction::type_chunks_call(self, args)),
            "coalesce" => return coalesce_type_with(args, |kinds, old| self.joined_records(kinds, old)),
            "multi" => return multi_type(args, self.record_join()),
            _ => {}
        }
        if let Some(coerced) = bare_coercer_returns(function) {
            return Some(coerced);
        }
        if let Some(spec) = stdlib_function_by_id(function) {
            return spec.returns.ty();
        }
        let builtin = if function == "extractone" && self.version < 3 { None } else { super::stdlib::builtin_under(&function.to_ascii_uppercase(), self.version) };
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
                ListElement::Expression(e) => {
                    let slot = self.infer_exact_at(e, position);
                    self.refuse_closure_as_data(e, slot.as_ref(), "a list's element is");
                    parts.push(Part::Slot(slot));
                }
                ListElement::Spread(spread) => {
                    let spread_parts = self.spread_parts(&spread.expression, position);
                    let held: Vec<Ty> = spread_parts.iter().filter_map(|(_, ty)| ty.clone()).collect();
                    self.refuse_closure_as_data(&spread.expression, value_union(&held).as_ref(), "a spread into a list holds");
                    parts.extend(spread_parts.into_iter().map(|(run, ty)| if run { Part::Run(ty) } else { Part::Slot(ty) }));
                }
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
            return Ty::Tuple { of: Rc::new(slots_of(&parts)), rest: None };
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
            return Ty::Tuple { of: Rc::new(of), rest: Some(TupleRest { at, of: run.map(Rc::new) }) };
        }
        let folded = match tuple_as_list(&slots_of(&parts[first_run..]), None, self.version) {
            Some(Ty::List { of, .. }) => Some(of),
            _ => None,
        };
        let at = prefix.len();
        Ty::Tuple { of: Rc::new(prefix), rest: Some(TupleRest { at, of: folded }) }
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
                    self.refuse_closure_as_data(value, exact.as_ref(), &format!("'{name}' holds"));
                    read_types.push(widen_tuples_joining(exact.clone(), self.version, self.record_join()));
                    shape.insert(name.clone(), exact);
                    written.insert(name.clone());
                }
                ObjectMember::Spread(spread) => {
                    let Some(held) = self.infer_exact_at(&spread.expression, position) else {
                        untyped_spread = true;
                        continue;
                    };
                    let copied = match strip_absent(&held) {
                        Ty::Dict { shape: Some(keys), .. } => value_union(&keys.values().flatten().cloned().collect::<Vec<_>>()),
                        Ty::Dict { of, shape: None } => Some((**of).clone()),
                        _ => None,
                    };
                    self.refuse_closure_as_data(&spread.expression, copied.as_ref(), "a spread into a map holds");
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
                        Ty::Record(Some(record)) if crate::families::records::holds_spelled_fields(self, Some(record), "copies its fields into a map with '...'") => {
                            super::position::record_field_types(record)
                        }
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
                        read_types.push(widen_tuples_joining(next, self.version, self.record_join()));
                    }
                }
            }
        }
        if untyped_spread {
            return None;
        }
        // Compared in place, not cloned: a type is the same as itself whatever
        // kind it is (`sameStartingPoint`'s identity), as a write's handle is.
        let first = read_types.first().and_then(Option::as_ref);
        let agree = first.is_some_and(|f| read_types.iter().all(|t| t.as_ref().is_some_and(|t| field_type_equals(t, f))));
        let first = first.cloned();
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
            return Some(if agree { Ty::Dict { of: Rc::new(of), shape: None } } else { Ty::Json });
        }
        let shape: Option<movement_parser::catalog::types::JsMap<Option<Ty>>> = keys_named.then(|| shape.into_iter().collect());
        Some(Ty::Dict { of: Rc::new(of), shape: shape.map(Rc::new) })
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
                Some(Ty::Dict { of: Rc::new(Ty::Json), shape: Some(Rc::new(shape)) })
            }
            Expression::List { elements } => {
                let mut slots = Vec::new();
                for element in elements {
                    match element {
                        ListElement::Spread(_) => return self.exact_types.get(&key(expr)).cloned().flatten(),
                        ListElement::Expression(e) => slots.push(self.may_hold_type(e)),
                    }
                }
                Some(Ty::Tuple { of: Rc::new(slots), rest: None })
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

    /// `handleHeldBy`: the first record or file the value of `expr` holds
    /// that `walk` does not accept, read off the expression's structure
    /// where its type says less (a choice's arms, a `COALESCE`, a `MULTI`,
    /// a pick of one member). Asked after `expr` is typed.
    pub fn handle_held_by(&self, expr: &Expression, walk: &HeldWalk) -> Option<HeldHandle> {
        let exact = |e: &Expression| self.exact_types.get(&key(e)).cloned().flatten();
        match expr {
            Expression::Object { entries } => entries.iter().find_map(|entry| match entry {
                ObjectMember::Spread(spread) => self.handle_spread_by(&spread.expression, walk),
                ObjectMember::Entry { key: name, value } => self.handle_held_by(value, &walk.into(HeldStep::Key(name.clone()))),
            }),
            Expression::List { elements } => {
                // A member's place is fixed until the first spread: past it, a
                // slot is wherever the run before it ended.
                let mut numbered = true;
                for (index, element) in elements.iter().enumerate() {
                    let held = match element {
                        ListElement::Spread(spread) => {
                            numbered = false;
                            handle_among_members(exact(&spread.expression).as_ref(), walk, |_| HeldStep::Member)
                        }
                        ListElement::Expression(e) => {
                            self.handle_held_by(e, &walk.into(if numbered { HeldStep::Slot(index) } else { HeldStep::Member }))
                        }
                    };
                    if held.is_some() {
                        return held;
                    }
                }
                None
            }
            Expression::Conditional { then, else_, .. } => self.handle_in_arms([&**then, &**else_], walk),
            // `COALESCE` hands back one of its arguments as it is, and `MULTI`
            // each present one as a member of the list it builds.
            Expression::Function { fn_, args } if fn_ == "coalesce" => self.handle_in_arms(args.iter(), walk),
            Expression::Function { fn_, args } if fn_ == "multi" => args.iter().find_map(|arg| self.handle_among_multi_members(arg, walk)),
            // `AT` picks one member of what it reads, or reads a value that is
            // no collection as itself.
            Expression::At { expression, index } => handle_within(exact(expr).as_ref(), walk).or_else(|| {
                // A literal index over what a tuple may hold (a receipt's arms)
                // reads its own slot, not any member.
                let slot = literal_index(index).and_then(|index| match self.may_hold_type(expression).as_ref().map(strip_absent) {
                    Some(Ty::Tuple { of, rest }) => Some(tuple_slot_type(of, rest.as_ref(), Some(index), self.version)),
                    _ => None,
                });
                match slot {
                    Some(slot) => handle_within(slot.as_ref(), walk),
                    None => self.handle_picked_from(expression, walk),
                }
            }),
            Expression::Aggregate { fn_, expression, .. } => {
                let within = handle_within(exact(expr).as_ref(), walk);
                if matches!(fn_, AggregationFunction::First | AggregationFunction::Last | AggregationFunction::Only) {
                    within.or_else(|| self.handle_picked_from(expression, walk))
                } else {
                    within
                }
            }
            _ => handle_within(exact(expr).as_ref(), walk).or_else(|| {
                let name = self.bare_names.get(&key(expr))?;
                handle_within(self.env.resolve_may_hold(name).as_ref(), walk)
            }),
        }
    }

    /// `handlePickedFrom`: what a read picking one member of `operand` may
    /// hand back — one level down in it, or the operand itself.
    fn handle_picked_from(&self, operand: &Expression, walk: &HeldWalk) -> Option<HeldHandle> {
        let within = self.handle_held_by(operand, &HeldWalk { steps: Vec::new(), ..walk.clone() })?;
        let mut steps = walk.steps.clone();
        steps.extend(within.steps.iter().skip(1).cloned());
        Some(HeldHandle { steps, may: true, ..within })
    }

    /// `handleInArms`: the first handle any arm holds; the value only may hold it.
    fn handle_in_arms<'e>(&self, arms: impl IntoIterator<Item = &'e Expression>, walk: &HeldWalk) -> Option<HeldHandle> {
        arms.into_iter().find_map(|arm| self.handle_held_by(arm, walk)).map(|held| HeldHandle { may: true, ..held })
    }

    /// `handleAmongMultiMembers`: a list argument's members, spliced in, or
    /// the value itself as one member.
    fn handle_among_multi_members(&self, arg: &Expression, walk: &HeldWalk) -> Option<HeldHandle> {
        let exact = |e: &Expression| self.exact_types.get(&key(e)).cloned().flatten();
        match arg {
            Expression::List { elements } => elements.iter().find_map(|element| match element {
                ListElement::Spread(spread) => handle_among_members(exact(&spread.expression).as_ref(), walk, |_| HeldStep::Member),
                ListElement::Expression(e) => self.handle_held_by(e, &walk.into(HeldStep::Member)),
            }),
            _ if exact(arg).as_ref().is_some_and(|ty| matches!(strip_absent(ty), Ty::List { .. } | Ty::Tuple { .. })) => {
                handle_among_members(exact(arg).as_ref(), walk, |_| HeldStep::Member)
            }
            _ => self.handle_held_by(arg, &walk.into(HeldStep::Member)),
        }
    }

    /// `handleSpreadBy`: what a `...` spread of `expr` would copy.
    fn handle_spread_by(&self, expr: &Expression, walk: &HeldWalk) -> Option<HeldHandle> {
        if let Expression::Conditional { then, else_, .. } = expr {
            let held = self.handle_spread_by(then, walk).or_else(|| self.handle_spread_by(else_, walk))?;
            return Some(HeldHandle { may: true, ..held });
        }
        handle_spread_of(self.exact_types.get(&key(expr)).cloned().flatten().as_ref(), walk)
    }

    fn multi_member_type(&self, arg: &Expression) -> Option<Ty> {
        let ty = self.may_hold_type(arg)?;
        match strip_absent(&ty) {
            Ty::List { of, .. } => Some((**of).clone()),
            Ty::Tuple { of, rest } => {
                let mut arms = of.to_vec();
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
        Position::OneOf(members) => members.iter().all(holds_fields_in_hand),
        Position::Position(_) | Position::Union(_) | Position::Meta { .. } | Position::Closure(_) => false,
    }
}

/// `mayHoldEmptyItem`: a list (or tuple) one of whose items may be empty —
/// what `COUNT` skipped before version 5 and counts from it.
fn may_hold_empty_item(ty: &Ty) -> bool {
    let empty = |item: Option<&Ty>| matches!(item, Some(Ty::MaybeAbsent(_) | Ty::Absent));
    match strip_absent(ty) {
        Ty::List { of, .. } => empty(Some(of)),
        Ty::Tuple { of, rest } => of.iter().any(|slot| empty(slot.as_ref())) || rest.as_ref().is_some_and(|r| empty(r.of.as_deref())),
        _ => false,
    }
}

/// A value with no fields to read: text (an enum's value is text), a number,
/// or a true/false value (`FieldlessScalar`).
#[derive(Clone, Copy)]
enum FieldlessScalar {
    Text,
    Number,
    Boolean,
}

impl FieldlessScalar {
    /// `SCALAR_NOUNS`: what it is, what has no fields, and the bare word.
    fn nouns(self) -> (&'static str, &'static str, &'static str) {
        match self {
            FieldlessScalar::Text => ("text", "a text", "text"),
            FieldlessScalar::Number => ("a number", "a number", "number"),
            FieldlessScalar::Boolean => ("a true/false value", "a true/false value", "value"),
        }
    }
}

struct ScalarFieldRead {
    root: String,
    field: String,
    scalar: FieldlessScalar,
}
