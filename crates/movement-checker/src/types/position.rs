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
/// exactly when they are the same `Rc` (the TypeScript's `token`).
#[derive(Debug)]
pub struct Instance {
    pub name: String,
    /// Shared between instances built from one catalog schema.
    pub schema: Rc<InstanceSchema>,
}

pub type InstanceRef = Rc<Instance>;

pub fn same_instance(a: &InstanceRef, b: &InstanceRef) -> bool {
    Rc::ptr_eq(a, b)
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
}

/// One field of an extracted node (`ExtractFieldInfo`, the part typing reads).
#[derive(Debug, Clone)]
pub struct ExtractField {
    pub explicit: Option<Ty>,
    /// `readsAsPresentText`: an unannotated field reads as present text.
    pub reads_as_present_text: bool,
}

/// `ExtractNodeType`: a node of an extract result graph.
#[derive(Debug, Clone)]
pub struct ExtractNode {
    pub name: String,
    pub properties: IndexMap<String, ExtractField>,
    pub children: IndexMap<String, Rc<ExtractNode>>,
}

/// `LocalEdge`: an edge of a checker-local node, with its landing.
#[derive(Debug, Clone)]
pub struct LocalEdge {
    pub schema: EdgeSchema,
    pub target: Position,
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
        Position::Handle(_) | Position::Extract { .. } | Position::Closure(_) | Position::Local(_) | Position::MaybeEmpty(_) => None,
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
        Position::Union(_) | Position::Meta { .. } | Position::Closure(_) => None,
    }
}

/// `narrowPresent`: `position` with `property` proven present, or `None`
/// when there is nothing to narrow.
pub fn narrow_present(position: &Position, property: &str) -> Option<Position> {
    match position {
        Position::MaybeEmpty(of) => is_maybe_absent(lookup_property_type(Some(position), property).as_ref()).then(|| (**of).clone()),
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
        Position::Extract { node, .. } => match node.children.get(edge) {
            Some(child) => EdgeLanding::Landed { landing: Position::Extract { node: child.clone(), present: BTreeSet::new() }, edge: None },
            None => EdgeLanding::Unknown { available: node.children.keys().cloned().collect() },
        },
        Position::Closure(_) => EdgeLanding::NotTraversable,
        Position::Local(local) => match local.edges.as_ref().and_then(|e| e.get(edge)) {
            Some(local_edge) => EdgeLanding::Landed { landing: local_edge.target.clone(), edge: Some(local_edge.schema.clone()) },
            None => EdgeLanding::Unknown { available: local.edges.as_ref().map(|e| e.keys().cloned().collect()).unwrap_or_default() },
        },
        Position::MaybeEmpty(of) => edge_landing(of, edge, version),
    }
}
