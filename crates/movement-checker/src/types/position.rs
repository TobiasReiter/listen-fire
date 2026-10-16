//! Positions (`PositionTypeRef` in checker/typing.ts): where a record handle
//! stands — a system's own meta position, one record type of an instance, a
//! union of them, a write handle, an extracted node, a closure, a node a
//! construct mints, or one of those that may be empty. The arrow plane.

use std::collections::BTreeSet;
use std::rc::Rc;

use indexmap::IndexMap;
use movement_parser::catalog::types::{EdgeSchema, InstanceSchema, JsMap, PositionSchema};

use super::field::{Ty, field_type_equals, maybe_absent, strip_absent, is_maybe_absent};

/// `InstanceRef`: one constructed instance. Two refs are the same instance
/// when they are the same `Rc`, or when both are constructions of one system
/// address (the TypeScript's `token`).
#[derive(Debug)]
pub struct Instance {
    pub name: String,
    /// Shared between instances built from one catalog schema.
    pub schema: Rc<InstanceSchema>,
    /// A node declaration's own (`node X { … }`), belonging to no system:
    /// its records are compared by structure (`isDeclaredNode`). The
    /// declaration's symbol is its identity: settling the declaration at its
    /// statement rebuilds the instance, and the TypeScript patches its schema
    /// in place, so both builds are one declaration (an imported one carries
    /// the library's symbol).
    pub declared: Option<crate::scope::SymbolId>,
    /// `None` when an argument is not a literal: the construction is then a
    /// system of its own.
    pub address: Option<SystemAddress>,
}

/// `SystemAddress`: a constructed system's identity — its adapter, its
/// credential and the values of its literal arguments (by name, sorted; each
/// value as `JSON.stringify` spells it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemAddress {
    pub adapter: String,
    pub credential: Option<String>,
    pub args: Vec<(String, String)>,
}

pub type InstanceRef = Rc<Instance>;

pub fn same_instance(a: &InstanceRef, b: &InstanceRef) -> bool {
    Rc::ptr_eq(a, b)
        || matches!((&a.address, &b.address), (Some(x), Some(y)) if x == y)
        || matches!((a.declared, b.declared), (Some(x), Some(y)) if x == y)
}

/// `systemDifference`: ` — these are two different systems: …`, naming what
/// differs, when a record of one system is handed where another's is
/// expected; empty when the two are one system or not both instances.
pub fn system_difference(arg: &Position, param: &Position) -> String {
    let (Some(a), Some(b)) = (instance_of_position(arg), instance_of_position(param)) else { return String::new() };
    if same_instance(a, b) {
        return String::new();
    }
    match (&a.address, &b.address) {
        (Some(x), Some(y)) => {
            if x.adapter != y.adapter {
                return format!(" — these are two different systems: one is {}, the other {}", y.adapter, x.adapter);
            }
            if x.credential != y.credential {
                return format!(
                    " — these are two different systems: one is reached with the credential '{}', the other with '{}'",
                    y.credential.as_deref().unwrap_or("(none)"),
                    x.credential.as_deref().unwrap_or("(none)")
                );
            }
            let value_of = |address: &SystemAddress, name: &str| {
                address.args.iter().find(|(n, _)| n == name).map_or("(not given)".to_string(), |(_, v)| v.clone())
            };
            let mut names: Vec<&str> = Vec::new();
            for (name, _) in x.args.iter().chain(&y.args) {
                if !names.contains(&name.as_str()) {
                    names.push(name);
                }
            }
            match names.into_iter().find(|name| value_of(x, name) != value_of(y, name)) {
                Some(differing) => format!(
                    " — these are two different systems: one is constructed with '{differing}: {}', the other with '{differing}: {}'",
                    value_of(y, differing),
                    value_of(x, differing)
                ),
                None => " — these are two different systems".to_string(),
            }
        }
        _ => {
            let unaddressed = [b, a].into_iter().find(|i| i.address.is_none()).expect("one is unaddressed");
            format!(
                " — these are two different systems as far as the checker can tell: '{}' is constructed with an argument that is not a literal, so its address is not known until it runs — write its construction arguments as literals to make it the same system",
                unaddressed.name
            )
        }
    }
}

/// The instance a position names (`'instance' in position`).
fn instance_of_position(position: &Position) -> Option<&InstanceRef> {
    match position {
        Position::Meta { instance } => Some(instance),
        Position::Position(p) => Some(&p.instance),
        Position::Union(u) => Some(&u.instance),
        Position::Handle(h) => Some(&h.instance),
        Position::Extract { .. } | Position::Closure(_) | Position::MaybeEmpty(_) | Position::Local(_) | Position::OneOf(_) => None,
    }
}

/// A type on whichever plane it lives; both absent is untyped.
#[derive(Debug, Clone, Default)]
pub struct PlaneType {
    pub pos: Option<Box<Position>>,
    pub field: Option<Ty>,
}

/// `ReturnShape`: whether a body hands anything back, and what.
#[derive(Debug, Clone, Default)]
pub struct ReturnShape {
    pub returns: bool,
    pub plane: PlaneType,
    /// What the value may hold where its type cannot say (a walk input).
    pub may_hold: Option<Ty>,
}

#[derive(Debug, Clone)]
pub struct ClosureParam {
    pub name: String,
    pub plane: PlaneType,
}

/// A closure's signature. Its effect row (`effects`) is the calls family's to add.
#[derive(Debug, Clone)]
pub struct ClosureType {
    pub label: String,
    pub params: Vec<ClosureParam>,
    pub returns: ReturnShape,
    /// Where the closure is written (a closure, or a function declared with
    /// a name): one closure however often it is read. `None` for one typed by
    /// an annotation.
    pub written_at: Option<movement_parser::ast::Span>,
    /// The closures one of several closures stands for (`closureCandidates`);
    /// empty for a single closure.
    pub candidates: Vec<ClosureType>,
}

impl ClosureType {
    pub fn new(label: impl Into<String>, params: Vec<ClosureParam>, returns: ReturnShape, written_at: Option<movement_parser::ast::Span>) -> Self {
        ClosureType { label: label.into(), params, returns, written_at, candidates: Vec::new() }
    }

    /// `candidatesOf`: the closures a call of this one may run.
    pub fn candidates(&self) -> Vec<&ClosureType> {
        if self.candidates.is_empty() { vec![self] } else { self.candidates.iter().collect() }
    }

    fn same_closure(&self, other: &ClosureType) -> bool {
        self.written_at.is_some() && self.written_at == other.written_at
    }
}

/// `oneOfClosures`: several closures any one of which a value may be — a
/// list's members, a body whose returns hand back different closures.
/// Calling it is calling any of them, as TypeScript calls a union of function
/// types: its value is the union of what they return, and a call is held to
/// every candidate's parameters (the ones it carries are the first's, as a
/// placeholder). `typed_by_every` false is the rule before version 5 for a
/// body's returns: the call is typed by the first closure alone, the others
/// kept so the call can warn where version 5 holds it to them.
pub fn one_of_closures(closures: &[ClosureType], typed_by_every: bool) -> ClosureType {
    let mut flat: Vec<ClosureType> = Vec::new();
    for closure in closures {
        for candidate in closure.candidates() {
            if !flat.iter().any(|seen| seen.same_closure(candidate)) {
                flat.push(candidate.clone());
            }
        }
    }
    if flat.len() == 1 {
        return flat.pop().expect("one closure");
    }
    let first = &flat[0];
    let mut merged = if typed_by_every {
        let returns: Vec<ReturnShape> = flat.iter().map(|c| c.returns.clone()).collect();
        ClosureType::new("one of several closures", first.params.clone(), union_returns(&returns), None)
    } else {
        ClosureType { candidates: Vec::new(), ..first.clone() }
    };
    merged.candidates = flat;
    merged
}

/// `unionReturns`: what calling one of several closures hands back —
/// TypeScript's union of their return types. A type all of them agree on is
/// the call's type; records alone are their union; anything else has no one
/// type, and what it may hold travels as `may_hold`.
pub fn union_returns(shapes: &[ReturnShape]) -> ReturnShape {
    let returning: Vec<&ReturnShape> = shapes.iter().filter(|shape| shape.returns).collect();
    let Some(first) = returning.first() else { return ReturnShape::default() };
    let only_position = |shape: &ReturnShape| shape.plane.field.is_none() && shape.may_hold.is_none() && shape.plane.pos.is_some();
    if returning.iter().all(|shape| {
        only_position(shape)
            && field_type_equals(&Ty::record(shape.plane.pos.as_deref().cloned()), &Ty::record(first.plane.pos.as_deref().cloned()))
    }) {
        return ReturnShape { returns: true, plane: PlaneType { pos: first.plane.pos.clone(), field: None }, may_hold: None };
    }
    let mut arms: Vec<Ty> = Vec::new();
    fn add(arm: &Ty, arms: &mut Vec<Ty>) {
        if let Ty::Union(members) = arm {
            members.iter().for_each(|m| add(m, arms));
            return;
        }
        if !arms.iter().any(|seen| field_type_equals(seen, arm)) {
            arms.push(arm.clone());
        }
    }
    let mut unknown = false;
    for shape in &returning {
        let arm = shape.may_hold.clone().or_else(|| shape.plane.field.clone()).or_else(|| super::field::record_value_of(shape.plane.pos.as_deref()));
        match arm {
            Some(arm) => add(&arm, &mut arms),
            None => unknown = true,
        }
    }
    let one_arm = arms.len() == 1;
    let union = match arms.len() {
        0 => None,
        1 => arms.pop(),
        _ => Some(Ty::Union(Rc::new(arms))),
    };
    let typed = match &union {
        Some(union) if !unknown => {
            if one_arm || super::field::records_alone(Some(union)).is_some() {
                Some(union.clone())
            } else if returning.iter().all(|shape| shape.plane.field.as_ref().zip(first.plane.field.as_ref()).is_some_and(|(a, b)| field_type_equals(a, b))) {
                first.plane.field.clone()
            } else {
                None
            }
        }
        _ => None,
    };
    let may_hold = union.filter(|union| super::field::shows_more_handles(union, typed.as_ref()));
    ReturnShape { returns: true, plane: PlaneType { field: typed, pos: None }, may_hold }
}

/// One field of an extracted node (`ExtractFieldInfo`, the part typing reads).
#[derive(Debug, Clone)]
pub struct ExtractField {
    pub explicit: Option<Ty>,
    /// `readsAsPresentText`: an unannotated field reads as present text.
    pub reads_as_present_text: bool,
    /// An annotation was written (`annotationRaw`), resolved or not.
    pub annotated: bool,
    /// Where the field is declared: an annotation's nudges point here.
    pub span: movement_parser::ast::Span,
    /// The targets an annotation was already suggested for (`suggested`), so
    /// repeated writes say it once.
    pub suggested: std::cell::RefCell<std::collections::HashSet<String>>,
}

/// `ExtractNodeType`: a node of an extract result graph.
#[derive(Debug, Clone)]
pub struct ExtractNode {
    pub name: String,
    pub properties: IndexMap<String, ExtractField>,
    pub children: IndexMap<String, Rc<ExtractNode>>,
    /// A node taking a declaration as its shape (`node entry: <Entry>`) whose
    /// declaration is not fully known here (it extends a name only the file
    /// it was imported from binds): everything off it is untyped.
    pub declared: bool,
}

/// `LocalEdge`: an edge of a checker-local node, with its landing.
#[derive(Debug, Clone)]
pub struct LocalEdge {
    pub schema: EdgeSchema,
    /// `None` when the landing could not be typed: the edge is declared, and
    /// walking it is untyped rather than unknown.
    pub target: Option<Position>,
    /// The landing type is a declared node, so landings are compared by
    /// what they offer rather than by system.
    pub structural: bool,
    /// The landings are recomputed at every read (a `lazy` entry's walk):
    /// there is nothing a `link` could append to.
    pub deferred: bool,
    /// A graph literal's edge holding references to real records.
    pub references: bool,
}

#[derive(Debug, Clone)]
pub struct LocalNode {
    pub label: String,
    /// A name present with `None` is a read the construct declared and could not type.
    pub reads: IndexMap<String, Option<Ty>>,
    pub edges: Option<IndexMap<String, LocalEdge>>,
    pub run_built: Option<Box<Position>>,
    pub extracted: Option<IndexMap<String, Ty>>,
}

#[derive(Debug, Clone)]
pub struct RecordPosition {
    pub instance: InstanceRef,
    pub position: String,
    pub narrows_event: Option<String>,
    pub display: Option<String>,
    /// Fields a guard in scope has proven present.
    pub present: BTreeSet<String>,
    pub run_built: bool,
    /// The record is a function's parameter: what its body needs of it is
    /// filed here (`FieldsNeed`).
    pub parameter: Option<NeedRef>,
}

#[derive(Debug, Clone)]
pub struct UnionPosition {
    pub instance: InstanceRef,
    pub union: String,
    pub variants: Vec<String>,
    pub narrows_event: Option<String>,
    pub display: Option<String>,
    /// The event address a parameter type named it by (`positionFromAddress`).
    pub address: Option<super::event_address::EventAddress>,
    pub parameter: Option<NeedRef>,
}

#[derive(Debug, Clone)]
pub struct HandlePosition {
    pub instance: InstanceRef,
    pub position: Option<String>,
    pub result_shape: IndexMap<String, Ty>,
    pub edges: Option<JsMap<EdgeSchema>>,
    pub generic_landings: Option<IndexMap<String, String>>,
    pub written: bool,
    pub set_fields: Option<BTreeSet<String>>,
    /// The TypeScript's object identity: a handle is a fresh object where a
    /// write or match makes one, and the same object wherever it is passed
    /// on. A clone keeps it; a copy that changes the handle takes a new one.
    pub identity: HandleIdentity,
}

/// See `HandlePosition::identity`.
#[derive(Debug, Clone, Default)]
pub struct HandleIdentity(Rc<()>);

impl HandleIdentity {
    pub fn is(&self, other: &HandleIdentity) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

/// The TypeScript's `===` on a field type, as far as it differs from
/// `fieldTypeEquals`: one handle passed on, never re-made, is itself.
pub fn same_handle_object(a: &Ty, b: &Ty) -> bool {
    match (a, b) {
        (Ty::Record(Some(a)), Ty::Record(Some(b))) => match (&**a, &**b) {
            (Position::Handle(a), Position::Handle(b)) => a.identity.is(&b.identity),
            _ => false,
        },
        _ => false,
    }
}

#[derive(Debug, Clone)]
pub enum Position {
    Meta { instance: InstanceRef },
    Position(RecordPosition),
    Union(UnionPosition),
    Handle(HandlePosition),
    Extract { node: Rc<ExtractNode>, present: BTreeSet<String> },
    Closure(ClosureType),
    /// A landing that may be empty: a dot read yields `T | absent`.
    MaybeEmpty(Box<Position>),
    Local(LocalNode),
    /// ONE OF several records of different types — TypeScript's `Person |
    /// Company`: an `IF` or a `COALESCE` of them, a function returning
    /// either, a list holding both. It reads, walks and writes only what
    /// EVERY member offers. Built only by `unions::join_positions`, which
    /// keeps it canonical: at least two members, none itself one of these,
    /// none maybe-empty (absence wraps the whole), no two members one type.
    OneOf(Vec<Position>),
}

impl Position {
    pub fn record(instance: InstanceRef, position: impl Into<String>) -> Position {
        Position::Position(RecordPosition {
            instance,
            position: position.into(),
            narrows_event: None,
            display: None,
            present: BTreeSet::new(),
            run_built: false,
            parameter: None,
        })
    }

    pub fn is_closure(&self) -> bool {
        matches!(self, Position::Closure(_))
    }
}

/// `positionRefIn`: a name in an instance — a union, or a position.
pub fn position_ref_in(instance: &InstanceRef, name: &str) -> Option<Position> {
    if let Some(variants) = instance.schema.unions.as_ref().and_then(|u| u.get(name)) {
        return Some(Position::Union(UnionPosition {
            instance: instance.clone(),
            union: name.to_string(),
            variants: variants.clone(),
            narrows_event: None,
            display: None,
            address: None,
            parameter: None,
        }));
    }
    instance.schema.positions.contains_key(name).then(|| Position::record(instance.clone(), name))
}

/// `instanceOfRef`: the graph a position belongs to.
pub fn instance_of_ref(position: Option<&Position>) -> Option<&InstanceRef> {
    match position? {
        Position::Meta { instance } => Some(instance),
        Position::Position(p) => Some(&p.instance),
        Position::Union(u) => Some(&u.instance),
        Position::Handle(h) => Some(&h.instance),
        Position::MaybeEmpty(of) => instance_of_ref(Some(of)),
        // The graph every record it may be is in, where they share one.
        Position::OneOf(members) => {
            let first = instance_of_ref(members.first())?;
            members[1..].iter().all(|m| instance_of_ref(Some(m)).is_some_and(|i| same_instance(i, first))).then_some(first)
        }
        Position::Extract { .. } | Position::Closure(_) | Position::Local(_) => None,
    }
}

/// `displayNameOf`.
pub fn display_name_of(instance: &Instance, position: &str) -> String {
    instance.schema.positions.get(position).and_then(|p| p.display_name.clone()).unwrap_or_else(|| position.to_string())
}

pub const EXTRACT_ROOT_NAME: &str = "extract result";

fn describe_closure_return(shape: &ReturnShape) -> String {
    if !shape.returns {
        return "nothing".to_string();
    }
    if let Some(held) = shape.may_hold.as_ref().or(shape.plane.field.as_ref()) {
        return super::field::describe_field_type(held);
    }
    shape.plane.pos.as_deref().map_or("something nobody can type".to_string(), describe_position)
}

/// `describePosition`: a position in the author's words.
pub fn describe_position(position: &Position) -> String {
    match position {
        Position::Meta { instance } => format!("'{}' (the instance itself)", instance.name),
        Position::Position(p) => format!("{}.{}", p.instance.name, display_name_of(&p.instance, &p.position)),
        Position::Union(u) => {
            if u.variants.is_empty() {
                return "a record kind the branches above already cover".to_string();
            }
            let shown = u
                .instance
                .schema
                .union_display_names
                .as_ref()
                .and_then(|names| names.get(&u.union).cloned())
                .or_else(|| u.display.clone())
                .unwrap_or_else(|| u.union.clone());
            format!("{}.{shown}", u.instance.name)
        }
        Position::Handle(h) => match &h.position {
            Some(position) => format!("a {}.{} handle", h.instance.name, display_name_of(&h.instance, position)),
            None => format!("a {} write handle", h.instance.name),
        },
        Position::Extract { node, .. } => {
            if node.name == EXTRACT_ROOT_NAME {
                "the extract result".to_string()
            } else {
                format!("the extracted node '{}'", node.name)
            }
        }
        Position::Closure(closure) => {
            if closure.label == "a closure" {
                format!("a closure returning {}", describe_closure_return(&closure.returns))
            } else {
                closure.label.clone()
            }
        }
        Position::Local(local) => local.label.clone(),
        Position::MaybeEmpty(of) => format!("{} (which may be empty)", describe_position(of)),
        Position::OneOf(members) => members.iter().map(describe_position).collect::<Vec<_>>().join(" or "),
    }
}

/// `describeReturnShape`.
pub fn describe_return_shape(shape: &PlaneType) -> String {
    if let Some(pos) = &shape.pos {
        return describe_position(pos);
    }
    shape.field.as_ref().map_or("nothing".to_string(), super::field::describe_field_type)
}

fn accepts_any_narrowing(param_name: &str, param_narrows: &Option<String>, arg_narrows: &Option<String>) -> bool {
    param_narrows.is_none() && arg_narrows.as_deref() == Some(param_name)
}

/// `positionsMatch`: whether a record at `arg` may stand where `param` is
/// asked for. `None` is "cannot say" (a handle of no position, a local node).
pub fn positions_match(arg: &Position, param: &Position) -> Option<bool> {
    // One of several records fits where every one of them does.
    if let Position::OneOf(members) = arg {
        let fits: Vec<Option<bool>> = members.iter().map(|member| positions_match(member, param)).collect();
        if fits.contains(&Some(false)) {
            return Some(false);
        }
        return fits.iter().all(|fit| *fit == Some(true)).then_some(true);
    }
    match param {
        Position::Position(param) => match arg {
            Position::Position(arg) => {
                if !same_instance(&arg.instance, &param.instance) {
                    return Some(false);
                }
                Some(arg.position == param.position || accepts_any_narrowing(&param.position, &param.narrows_event, &arg.narrows_event))
            }
            Position::Union(arg) => {
                if !same_instance(&arg.instance, &param.instance) {
                    return Some(false);
                }
                Some(accepts_any_narrowing(&param.position, &param.narrows_event, &arg.narrows_event))
            }
            Position::Handle(arg) => {
                if !same_instance(&arg.instance, &param.instance) {
                    return Some(false);
                }
                arg.position.as_ref().map(|p| *p == param.position)
            }
            _ => Some(false),
        },
        Position::Union(param) => match arg {
            Position::Union(arg) => {
                if !same_instance(&arg.instance, &param.instance) {
                    return Some(false);
                }
                Some(arg.union == param.union || accepts_any_narrowing(&param.union, &param.narrows_event, &arg.narrows_event))
            }
            Position::Position(arg) => {
                if !same_instance(&arg.instance, &param.instance) {
                    return Some(false);
                }
                Some(param.variants.contains(&arg.position) || accepts_any_narrowing(&param.union, &param.narrows_event, &arg.narrows_event))
            }
            Position::Handle(arg) => {
                if !same_instance(&arg.instance, &param.instance) {
                    return Some(false);
                }
                arg.position.as_ref().map(|p| param.variants.contains(p))
            }
            _ => Some(false),
        },
        Position::Meta { instance } => Some(matches!(arg, Position::Meta { instance: a } if same_instance(a, instance))),
        Position::Handle(_) | Position::Extract { .. } | Position::Closure(_) | Position::Local(_) | Position::MaybeEmpty(_) | Position::OneOf(_) => None,
    }
}

/// `sameStartingPoint`: each position fits the other.
pub fn same_starting_point(a: &Position, b: &Position) -> bool {
    if std::ptr::eq(a, b) {
        return true;
    }
    positions_match(a, b) == Some(true) && positions_match(b, a) == Some(true)
}

/// `positionSchemaOfRef`: the schema a position reads (a meta position's
/// edges are its collections). Owned, since the meta's is built.
pub fn position_schema_of_ref(position: &Position) -> Option<std::borrow::Cow<'_, PositionSchema>> {
    use std::borrow::Cow;
    match position {
        Position::Position(p) => p.instance.schema.positions.get(&p.position).map(Cow::Borrowed),
        Position::Handle(HandlePosition { instance, position: Some(name), .. }) => instance.schema.positions.get(name).map(Cow::Borrowed),
        Position::Meta { instance } => {
            let schema = &instance.schema;
            let edges: JsMap<EdgeSchema> = schema
                .collections
                .iter()
                .map(|(collection, c)| {
                    let edge = EdgeSchema {
                        target: c.target.clone(),
                        capability: c.capability.clone(),
                        writable: schema.writable_roots.contains_key(&c.target).then_some(true),
                        ..edge_schema_to(&c.target)
                    };
                    (collection.clone(), edge)
                })
                .collect();
            Some(Cow::Owned(PositionSchema { edges, ..empty_position_schema() }))
        }
        _ => None,
    }
}

/// An edge to `target` promising nothing else.
pub fn edge_schema_to(target: &str) -> EdgeSchema {
    serde_json::from_value(serde_json::json!({ "target": target })).unwrap_or_else(|_| unreachable!("an edge schema needs only its target"))
}

fn empty_position_schema() -> PositionSchema {
    serde_json::from_value(serde_json::json!({ "properties": {}, "edges": {} })).unwrap_or_else(|_| unreachable!("a position schema needs only properties and edges"))
}

/// `lookupPropertyType`: what a dot read of `property` off `position` is.
pub fn lookup_property_type(position: Option<&Position>, property: &str) -> Option<Ty> {
    match position? {
        Position::Position(p) => {
            let declared = p.instance.schema.positions.get(&p.position)?.properties.get(property).map(Ty::from_schema)?;
            Some(if p.present.contains(property) { strip_absent(&declared).clone() } else { declared })
        }
        handle @ Position::Handle(h) => {
            if let Some(from_shape) = h.result_shape.get(property) {
                return Some(from_shape.clone());
            }
            position_schema_of_ref(handle)?.properties.get(property).map(Ty::from_schema)
        }
        Position::Union(u) => {
            let types: Vec<Ty> = u
                .variants
                .iter()
                .filter_map(|v| u.instance.schema.positions.get(v).and_then(|p| p.properties.get(property)).map(Ty::from_schema))
                .collect();
            if types.len() != u.variants.len() || types.is_empty() {
                return None;
            }
            types.iter().all(|t| field_type_equals(t, &types[0])).then(|| types[0].clone())
        }
        Position::MaybeEmpty(of) => lookup_property_type(Some(of), property).map(maybe_absent),
        // A field every record it may be has, as the union of their types.
        Position::OneOf(members) => {
            let types: Option<Vec<Ty>> = members.iter().map(|member| lookup_property_type(Some(member), property)).collect();
            super::unions::join_field_types(&types?)
        }
        Position::Local(local) => local.reads.get(property).cloned().flatten(),
        Position::Closure(_) | Position::Meta { .. } | Position::Extract { .. } => None,
    }
}

/// `recordFieldTypes`: every field a record of `position` holds, typed.
pub fn record_field_types(position: &Position) -> Option<IndexMap<String, Option<Ty>>> {
    let typed = |names: Vec<String>| names.into_iter().map(|name| (name.clone(), lookup_property_type(Some(position), &name))).collect();
    match position {
        Position::Local(local) => Some(typed(local.reads.keys().cloned().collect())),
        Position::Position(_) | Position::Handle(_) => {
            let schema = position_schema_of_ref(position);
            if matches!(position, Position::Position(_)) && schema.is_none() {
                return None;
            }
            let mut names: Vec<String> = schema.map(|s| s.properties.keys().cloned().collect()).unwrap_or_default();
            if let Position::Handle(h) = position {
                for name in h.result_shape.keys() {
                    if !names.contains(name) {
                        names.push(name.clone());
                    }
                }
            }
            Some(typed(names))
        }
        Position::Extract { node, .. } if node.declared => None,
        Position::Extract { node, present } => Some(
            node.properties
                .iter()
                .map(|(name, field)| {
                    let ty = if field.reads_as_present_text || present.contains(name) {
                        Some(field.explicit.as_ref().map_or(Ty::Text, |t| strip_absent(t).clone()))
                    } else {
                        field.explicit.clone().map(maybe_absent)
                    };
                    (name.clone(), ty)
                })
                .collect(),
        ),
        Position::MaybeEmpty(of) => {
            Some(record_field_types(of)?.into_iter().map(|(name, ty)| (name, ty.map(maybe_absent))).collect())
        }
        // The fields every record it may be has, each the union of their types.
        Position::OneOf(members) => {
            let each: Vec<IndexMap<String, Option<Ty>>> = members.iter().map(record_field_types).collect::<Option<_>>()?;
            let (head, rest) = each.split_first()?;
            Some(
                head.keys()
                    .filter(|name| rest.iter().all(|fields| fields.contains_key(*name)))
                    .map(|name| {
                        let types: Option<Vec<Ty>> = each.iter().map(|fields| fields.get(name).cloned().flatten()).collect();
                        (name.clone(), types.and_then(|types| super::unions::join_field_types(&types)))
                    })
                    .collect(),
            )
        }
        Position::Union(_) | Position::Meta { .. } | Position::Closure(_) => None,
    }
}

/// `narrowPresent`: `position` with `property` proven present, or `None`
/// when there is nothing to narrow.
pub fn narrow_present(position: &Position, property: &str) -> Option<Position> {
    match position {
        Position::MaybeEmpty(of) => is_maybe_absent(lookup_property_type(Some(position), property).as_ref()).then(|| (**of).clone()),
        // The proof discharges the field in each record it may be.
        Position::OneOf(members) => {
            let narrowed: Vec<Option<Position>> = members.iter().map(|member| narrow_present(member, property)).collect();
            if narrowed.iter().all(Option::is_none) {
                return None;
            }
            let each: Vec<&Position> = narrowed.iter().zip(members).map(|(n, m)| n.as_ref().unwrap_or(m)).collect();
            super::unions::join_positions(&each).map(|joined| joined.position)
        }
        Position::Extract { node, present } => {
            let field = node.properties.get(property)?;
            if field.reads_as_present_text || present.contains(property) {
                return None;
            }
            let mut present = present.clone();
            present.insert(property.to_string());
            Some(Position::Extract { node: node.clone(), present })
        }
        Position::Local(local) => {
            let read = local.reads.get(property)?.as_ref()?;
            if !is_maybe_absent(Some(read)) {
                return None;
            }
            let mut narrowed = local.clone();
            narrowed.reads.insert(property.to_string(), Some(strip_absent(read).clone()));
            Some(Position::Local(narrowed))
        }
        Position::Position(p) => {
            if p.present.contains(property) || !is_maybe_absent(lookup_property_type(Some(position), property).as_ref()) {
                return None;
            }
            let mut narrowed = p.clone();
            narrowed.present.insert(property.to_string());
            Some(Position::Position(narrowed))
        }
        Position::Meta { .. } | Position::Union(_) | Position::Handle(_) | Position::Closure(_) => None,
    }
}

/// `narrowPresentNode`: a maybe-empty landing proven to be there.
pub fn narrow_present_node(position: &Position) -> Option<Position> {
    match position {
        Position::MaybeEmpty(of) => Some((**of).clone()),
        _ => None,
    }
}

/// Where one edge step off a position lands, without reporting: the walks
/// family turns each refusal into its diagnostic (`stepEdge`).
#[derive(Debug, Clone)]
pub enum EdgeLanding {
    Landed { landing: Position, edge: Option<EdgeSchema> },
    /// The edge leads somewhere nobody can type (an open schema, a variant
    /// set with different targets, an unreadable edge, a `#` edge).
    Untyped { edge: Option<EdgeSchema> },
    /// No such edge: the edges there are.
    Unknown { available: Vec<String> },
    /// A union where only some variants carry the edge.
    SomeVariants { carrying: Vec<String> },
    /// A union every variant of which an earlier branch already covered.
    Unreachable,
    /// A closure has no arrow plane.
    NotTraversable,
}

/// `refineSelected`: a hop whose WHERE the host registered a refinement for
/// lands on that refinement, not the whole type.
pub fn refine_selected(target: Position, filter: Option<&movement_parser::lowering::expression::Expression>) -> Position {
    let (Some(filter), Position::Position(p)) = (filter, &target) else { return target };
    let Some(refinements) = &p.instance.schema.refinements else { return target };
    let Ok(filter) = serde_json::to_value(filter) else { return target };
    let key = movement_parser::catalog::helpers::refinement_key(&p.position, &filter);
    match refinements.get(&key).and_then(|refined| position_ref_in(&p.instance, refined)) {
        Some(refined) => refined,
        None => target,
    }
}

/// The `@`-prefixed edges a write handle carries (`-[:@old]->`).
pub fn is_artificial_edge(edge: &str) -> bool {
    edge.starts_with('@')
}

/// `stepEdge`, the typing half: the landing of `edge` off `from`.
pub fn edge_landing(from: &Position, edge: &str, version: u32) -> EdgeLanding {
    if edge.starts_with('#') && version >= 5 {
        return EdgeLanding::Untyped { edge: None };
    }
    // `stepArtificialEdge`: `@old` off a write's handle is the same kind of
    // record; any other `@` edge lands nowhere (the walks family says why).
    if is_artificial_edge(edge) && !matches!(from, Position::MaybeEmpty(_)) && version >= 4 {
        return match from {
            Position::Handle(h) if h.written && edge == "@old" => EdgeLanding::Landed { landing: from.clone(), edge: None },
            _ => EdgeLanding::Untyped { edge: None },
        };
    }
    match from {
        Position::Meta { instance } => match instance.schema.collections.get(edge) {
            Some(collection) => match position_ref_in(instance, &collection.target) {
                Some(landing) => EdgeLanding::Landed { landing, edge: None },
                None => EdgeLanding::Untyped { edge: None },
            },
            None => EdgeLanding::Unknown { available: instance.schema.collections.keys().cloned().collect() },
        },
        Position::Position(_) | Position::Handle(_) => {
            let (instance, edges, open, generic) = match from {
                Position::Position(p) => {
                    let Some(schema) = p.instance.schema.positions.get(&p.position) else { return EdgeLanding::Untyped { edge: None } };
                    (&p.instance, schema.edges.clone(), schema.open_properties == Some(true), None)
                }
                Position::Handle(h) => {
                    let schema = position_schema_of_ref(from);
                    let (edges, open) = match (schema, &h.edges) {
                        (Some(schema), _) => (schema.edges.clone(), schema.open_properties == Some(true)),
                        (None, Some(edges)) => (edges.clone(), false),
                        (None, None) => return EdgeLanding::Untyped { edge: None },
                    };
                    (&h.instance, edges, open, h.generic_landings.as_ref().and_then(|g| g.get(edge)).cloned())
                }
                _ => unreachable!("matched above"),
            };
            let Some(edge_schema) = edges.get(edge) else {
                if open {
                    return EdgeLanding::Untyped { edge: None };
                }
                return EdgeLanding::Unknown { available: edges.keys().cloned().collect() };
            };
            // A write-only edge reads nothing; an awaitable one still lands (the
            // walks family says whether it must be awaited).
            if edge_schema.readable == Some(false) && edge_schema.awaitable != Some(true) {
                return EdgeLanding::Untyped { edge: Some(edge_schema.clone()) };
            }
            let target = generic.unwrap_or_else(|| edge_schema.target.clone());
            match position_ref_in(instance, &target) {
                Some(landing) => EdgeLanding::Landed { landing, edge: Some(edge_schema.clone()) },
                None => EdgeLanding::Untyped { edge: Some(edge_schema.clone()) },
            }
        }
        Position::Union(u) => {
            if u.variants.is_empty() {
                return EdgeLanding::Unreachable;
            }
            let carrying: Vec<String> =
                u.variants.iter().filter(|v| u.instance.schema.positions.get(*v).is_some_and(|p| p.edges.contains_key(edge))).cloned().collect();
            if carrying.is_empty() {
                let mut available: Vec<String> = Vec::new();
                for v in &u.variants {
                    for name in u.instance.schema.positions.get(v).map(|p| p.edges.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() {
                        if !available.contains(&name) {
                            available.push(name);
                        }
                    }
                }
                return EdgeLanding::Unknown { available };
            }
            let carried: Vec<&EdgeSchema> = carrying.iter().filter_map(|v| u.instance.schema.positions.get(v)?.edges.get(edge)).collect();
            if carried.iter().all(|s| s.readable == Some(false)) {
                return EdgeLanding::Untyped { edge: carried.first().map(|s| (*s).clone()) };
            }
            if carrying.len() != u.variants.len() {
                return EdgeLanding::SomeVariants { carrying };
            }
            let schemas: Vec<&EdgeSchema> = carrying.iter().filter_map(|v| u.instance.schema.positions.get(v)?.edges.get(edge)).collect();
            let first = schemas[0];

            if schemas.iter().all(|s| s.target == first.target) {
                match position_ref_in(&u.instance, &first.target) {
                    Some(landing) => EdgeLanding::Landed { landing, edge: Some(first.clone()) },
                    None => EdgeLanding::Untyped { edge: Some(first.clone()) },
                }
            } else {
                EdgeLanding::Untyped { edge: Some(first.clone()) }
            }
        }
        Position::Extract { node, .. } if node.declared => EdgeLanding::Untyped { edge: None },
        Position::Extract { node, .. } => match node.children.get(edge) {
            Some(child) => EdgeLanding::Landed { landing: Position::Extract { node: child.clone(), present: BTreeSet::new() }, edge: None },
            None => EdgeLanding::Unknown { available: node.children.keys().cloned().collect() },
        },
        Position::Closure(_) => EdgeLanding::NotTraversable,
        Position::Local(local) => match local.edges.as_ref().and_then(|e| e.get(edge)) {
            Some(local_edge) => match &local_edge.target {
                Some(landing) => EdgeLanding::Landed { landing: landing.clone(), edge: Some(local_edge.schema.clone()) },
                None => EdgeLanding::Untyped { edge: Some(local_edge.schema.clone()) },
            },
            None => EdgeLanding::Unknown { available: local.edges.as_ref().map(|e| e.keys().cloned().collect()).unwrap_or_default() },
        },
        Position::MaybeEmpty(of) => edge_landing(of, edge, version),
        // Every record it may be lands; the typing walks each (`stepEveryMember`).
        Position::OneOf(members) => {
            let landings: Option<Vec<Position>> = members
                .iter()
                .map(|member| match edge_landing(member, edge, version) {
                    EdgeLanding::Landed { landing, .. } => Some(landing),
                    _ => None,
                })
                .collect();
            match landings.as_deref().map(|l| l.iter().collect::<Vec<_>>()).and_then(|l| super::unions::join_positions(&l)) {
                Some(joined) => EdgeLanding::Landed { landing: joined.position, edge: None },
                None => EdgeLanding::Untyped { edge: None },
            }
        }
    }
}

// ── What a function's body needs of a record parameter ──

/// A parameter's need cell, shared by every walk of the body that declares it.
pub type NeedRef = Rc<std::cell::RefCell<FieldsNeed>>;

/// `FieldsNeed`: what a function's body needs of a record parameter — its
/// fields in hand (a consumer that reads every field, as TEXT.SERIALISE or a
/// spread does). One cell per parameter, carried on the parameter's position
/// type, so a name bound to the parameter, a list holding it or a closure over
/// it records here too. A parameter passed on to another function's
/// parameter takes on that one's requirement (`passed_to`), read when a call
/// site asks — so a cycle of calls needs no fixpoint.
#[derive(Default)]
pub struct FieldsNeed {
    pub function: String,
    pub param: String,
    /// The first consumer in the body that needs the fields in hand.
    pub consumer: Option<String>,
    pub passed_to: Vec<(NeedRef, String)>,
    /// The cell for the records reached THROUGH the parameter's edges, at
    /// any depth.
    pub reached: Option<NeedRef>,
    /// This cell is a parameter's `reached` cell.
    pub through_edges: bool,
}

impl std::fmt::Debug for FieldsNeed {
    // Cells refer to one another in cycles: name the parameter only.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "FieldsNeed({}.{})", self.function, self.param)
    }
}

/// `FieldsReach`: what a requirement is asked of — the record handed over
/// itself, or the records reached through its edges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldsReach {
    Record,
    Reached,
}

/// `fieldsNeededBy`: why `need`'s parameter needs the fields of its record
/// (or of what is reached through it) in hand, if it does — directly, or
/// through the parameters it is passed on to.
pub fn fields_needed_by(need: &NeedRef, reach: FieldsReach, seen: &mut Vec<(NeedRef, FieldsReach)>) -> Option<String> {
    let cell = need.borrow();
    // A reached cell stands for every depth below the parameter.
    let asked = if cell.through_edges { FieldsReach::Record } else { reach };
    if seen.iter().any(|(n, r)| Rc::ptr_eq(n, need) && *r == asked) {
        return None;
    }
    seen.push((need.clone(), asked));
    if asked == FieldsReach::Record
        && let Some(consumer) = &cell.consumer
    {
        return Some(if cell.through_edges { format!("reaches a record through '{}' and {consumer}", cell.param) } else { consumer.clone() });
    }
    if asked == FieldsReach::Reached
        && let Some(reached) = &cell.reached
        && let Some(why) = fields_needed_by(reached, FieldsReach::Record, seen)
    {
        return Some(why);
    }
    let onward_reaches: &[FieldsReach] = if cell.through_edges { &[FieldsReach::Record, FieldsReach::Reached] } else { std::slice::from_ref(&asked) };
    for (onward, at) in &cell.passed_to {
        for onward_reach in onward_reaches {
            if let Some(why) = fields_needed_by(onward, *onward_reach, seen) {
                return Some(format!("{at}, and '{}' {why}", onward.borrow().function));
            }
        }
    }
    None
}

/// `parameterNeedOf`: the parameter cell a position carries, through a gate.
pub fn parameter_need_of(position: Option<&Position>) -> Option<NeedRef> {
    match position? {
        Position::MaybeEmpty(of) => parameter_need_of(Some(of)),
        Position::Position(record) => record.parameter.clone(),
        Position::Union(union) => union.parameter.clone(),
        _ => None,
    }
}

/// `noteFieldsNeeded`: files that `position`'s record — when it is a
/// function's parameter — has its fields read by `consumer`.
pub fn note_fields_needed(position: Option<&Position>, consumer: impl FnOnce() -> String) {
    if let Some(need) = parameter_need_of(position) {
        let mut cell = need.borrow_mut();
        if cell.consumer.is_none() {
            cell.consumer = Some(consumer());
        }
    }
}

/// `reachedThrough`: the cell for what is reached through `need`'s
/// parameter — made on first ask; a reached cell is its own.
fn reached_through(need: &NeedRef) -> NeedRef {
    if need.borrow().through_edges {
        return need.clone();
    }
    let mut cell = need.borrow_mut();
    let (function, param) = (cell.function.clone(), cell.param.clone());
    cell.reached
        .get_or_insert_with(|| Rc::new(std::cell::RefCell::new(FieldsNeed { function, param, through_edges: true, ..FieldsNeed::default() })))
        .clone()
}

/// `withParameterOf`: `landing`, walked from `from`, carrying the cell for
/// what is reached through `from`'s parameter.
pub fn with_parameter_of(from: Option<&Position>, landing: Option<Position>) -> Option<Position> {
    let Some(need) = parameter_need_of(from) else { return landing };
    Some(match landing? {
        Position::MaybeEmpty(of) => Position::MaybeEmpty(Box::new(with_parameter_of(from, Some(*of.clone())).unwrap_or(*of))),
        Position::Position(record) => Position::Position(RecordPosition { parameter: Some(reached_through(&need)), ..record }),
        Position::Union(union) => Position::Union(UnionPosition { parameter: Some(reached_through(&need)), ..union }),
        other => other,
    })
}

/// `asParameter`: `position` as the type of parameter `param` of `function`,
/// carrying the parameter's cell (made on first ask, kept in `cells`). Only a
/// position or a union names a record a caller hands over.
pub fn as_parameter(position: Position, cells: &mut std::collections::HashMap<String, NeedRef>, function: &str, param: &str) -> Position {
    if !matches!(position, Position::Position(_) | Position::Union(_)) {
        return position;
    }
    let need = cells
        .entry(param.to_string())
        .or_insert_with(|| Rc::new(std::cell::RefCell::new(FieldsNeed { function: function.to_string(), param: param.to_string(), ..FieldsNeed::default() })))
        .clone();
    match position {
        Position::Position(record) => Position::Position(RecordPosition { parameter: Some(need), ..record }),
        Position::Union(union) => Position::Union(UnionPosition { parameter: Some(need), ..union }),
        other => other,
    }
}

/// `withoutParameter`: the record once it has left the body.
pub fn without_parameter(position: Position) -> Position {
    match position {
        Position::MaybeEmpty(of) => Position::MaybeEmpty(Box::new(without_parameter(*of))),
        Position::Position(record) => Position::Position(RecordPosition { parameter: None, ..record }),
        Position::Union(union) => Position::Union(UnionPosition { parameter: None, ..union }),
        other => other,
    }
}
