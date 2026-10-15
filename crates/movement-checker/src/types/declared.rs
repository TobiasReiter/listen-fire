//! Declared nodes (checker/conformance.ts): a `node X { … }` declaration as
//! the schema an adapter would publish for it, `extends` folded in, and the
//! one structural comparator — does a supplied record carry everything a
//! declared structure says? A parameter typed by a declaration, a node
//! literal handed to one, a `link` onto a declared edge and an `IS <X>` test
//! all ask it.

use std::rc::Rc;

use movement_parser::ast::{ShapeDeclaration, ShapeNode};
use movement_parser::catalog::helpers::parse_field_type_name;
use movement_parser::catalog::types::{Composite, EdgeSchema, FieldType, InstanceSchema, JsMap, PositionSchema, Scalar, SchemaFieldType};

use super::field::{Ty, describe_field_type, field_assignable, strip_absent};
use super::position::{ExtractNode, Instance, InstanceRef, LocalNode, Position};

/// `T | absent` as a schema spells it.
pub fn schema_maybe_absent(of: SchemaFieldType) -> SchemaFieldType {
    match of {
        FieldType::Composite(Composite::MaybeAbsent { .. }) => of,
        _ => FieldType::Composite(Composite::MaybeAbsent { of: Box::new(of) }),
    }
}

fn position_schema(properties: JsMap<SchemaFieldType>, edges: JsMap<EdgeSchema>) -> PositionSchema {
    let mut schema: PositionSchema =
        serde_json::from_value(serde_json::json!({ "properties": {}, "edges": {} })).unwrap_or_else(|_| unreachable!("a position schema needs only properties and edges"));
    schema.properties = properties;
    schema.edges = edges;
    schema
}

fn empty_schema() -> InstanceSchema {
    serde_json::from_value(serde_json::json!({ "positions": {}, "collections": {}, "writableRoots": {} }))
        .unwrap_or_else(|_| unreachable!("an instance schema needs only its three maps"))
}

/// Puts one position in, with the writable root and collection a declared node has.
fn put(schema: &mut InstanceSchema, key: &str, position: PositionSchema) {
    let root = serde_json::json!({ "fields": &position.properties, "resultShape": &position.properties });
    let root = serde_json::from_value(root).unwrap_or_else(|_| unreachable!("a write shape needs only its fields"));
    let collection = serde_json::from_value(serde_json::json!({ "target": key })).unwrap_or_else(|_| unreachable!("a collection needs only its target"));
    schema.positions.insert(key.to_string(), position);
    schema.writable_roots.insert(key.to_string(), root);
    schema.collections.insert(key.to_string(), collection);
}

fn sequenced(of: Option<movement_parser::ast::EdgeSequencing>) -> Option<movement_parser::catalog::types::EdgeSequencing> {
    use movement_parser::ast::EdgeSequencing as Written;
    use movement_parser::catalog::types::EdgeSequencing as Schema;
    of.map(|s| match s {
        Written::Arrival => Schema::Arrival,
        Written::Document => Schema::Document,
        Written::Chronological => Schema::Chronological,
    })
}

/// `shapeToSchema`: the declaration as the schema an adapter would publish.
/// A position's key is its path from the root (`Doc`, `Doc.file`); an unknown
/// annotation degrades to text rather than dropping the field.
pub fn shape_to_schema(decl: &ShapeDeclaration, resolve_declared: &dyn Fn(&str) -> Option<SchemaFieldType>) -> InstanceSchema {
    let mut schema = empty_schema();
    fn add(node: &ShapeNode, key: &str, schema: &mut InstanceSchema, resolve_declared: &dyn Fn(&str) -> Option<SchemaFieldType>) {
        let properties: JsMap<SchemaFieldType> = node
            .fields
            .iter()
            .map(|field| {
                let named = parse_field_type_name(Some(&field.type_)).or_else(|| resolve_declared(&field.type_)).unwrap_or(FieldType::Scalar(Scalar::Text));
                (field.name.clone(), if field.nullable == Some(true) { schema_maybe_absent(named) } else { named })
            })
            .collect();
        let edges: JsMap<EdgeSchema> = node
            .children
            .iter()
            .map(|child| {
                let mut edge = super::position::edge_schema_to(&format!("{key}.{}", child.name));
                edge.writable = Some(true);
                edge.sequenced = sequenced(child.sequenced);
                (child.name.clone(), edge)
            })
            .collect();
        put(schema, key, position_schema(properties, edges));
        for child in &node.children {
            add(child, &format!("{key}.{}", child.name), schema, resolve_declared);
        }
    }
    add(&decl.root, &decl.name, &mut schema, resolve_declared);
    schema
}

/// `inheritDeclaration`: `node X extends Y { … }` as the tree it stands for.
pub fn inherit_declaration(decl: &ShapeDeclaration, base: &ShapeDeclaration) -> ShapeDeclaration {
    let mut root = decl.root.clone();
    root.description = decl.root.description.clone().or_else(|| base.root.description.clone());
    root.fields = base.root.fields.iter().chain(&decl.root.fields).cloned().collect();
    root.children = base.root.children.iter().chain(&decl.root.children).cloned().collect();
    root.sequenced = None;
    ShapeDeclaration { name: decl.name.clone(), root, extends: None, exported: decl.exported.filter(|e| *e), span: decl.span }
}

/// `inheritSchema`: X's own schema with Y's folded under X's name.
pub fn inherit_schema(own: &InstanceSchema, name: &str, base_name: &str, base: &InstanceSchema) -> InstanceSchema {
    let rekey = |key: &str| -> String {
        if key == base_name {
            name.to_string()
        } else if let Some(rest) = key.strip_prefix(&format!("{base_name}.")) {
            format!("{name}.{rest}")
        } else {
            key.to_string()
        }
    };
    let mut schema = empty_schema();
    for (key, position) in base.positions.iter() {
        let edges: JsMap<EdgeSchema> = position.edges.iter().map(|(edge, e)| (edge.clone(), EdgeSchema { target: rekey(&e.target), ..e.clone() })).collect();
        let mine = (key == base_name).then(|| own.positions.get(name)).flatten();
        let mut position = position.clone();
        position.properties = position.properties.iter().map(|(k, v)| (k.clone(), v.clone())).chain(mine.into_iter().flat_map(|m| m.properties.iter().map(|(k, v)| (k.clone(), v.clone())))).collect();
        position.edges = edges.iter().map(|(k, v)| (k.clone(), v.clone())).chain(mine.into_iter().flat_map(|m| m.edges.iter().map(|(k, v)| (k.clone(), v.clone())))).collect();
        put(&mut schema, &rekey(key), position);
    }
    for (key, position) in own.positions.iter() {
        if key != name {
            put(&mut schema, key, position.clone());
        }
    }
    schema
}

/// A declared node's own instance: its root is the position keyed by its name.
pub fn declared_instance(name: &str, schema: InstanceSchema, symbol: crate::scope::SymbolId) -> InstanceRef {
    Rc::new(Instance { name: name.to_string(), schema: Rc::new(schema), declared: Some(symbol), address: None })
}

/// `declaredRootPosition`: the record `<X>` denotes — X's root.
pub fn declared_root_position(instance: &InstanceRef) -> Option<Position> {
    super::position::position_ref_in(instance, &instance.name)
}

/// `runBuiltLanding`: a declared node's records as they land on an
/// appendable edge of a node the run built.
pub fn run_built_landing(target: Position) -> Position {
    match target {
        Position::Position(mut p) => {
            p.run_built = true;
            Position::Position(p)
        }
        other => other,
    }
}

/// `describeShapeNode`: `<Message>`, or a nested node by its path (`<Message> → attachment`).
pub fn describe_shape_node(position: &str) -> String {
    let mut segments = position.split('.');
    let root = segments.next().unwrap_or("");
    std::iter::once(format!("<{root}>")).chain(segments.map(str::to_string)).collect::<Vec<_>>().join(" → ")
}

/// `surfaceNotEnumerated`: a position whose fields nobody listed.
pub fn surface_not_enumerated(position: Option<&PositionSchema>) -> bool {
    position.is_none_or(|p| p.open_properties == Some(true) || p.undescribed == Some(true) || p.pending == Some(true))
}

/// `SuppliedSurface`: what a supplied record offers, on both planes. A name
/// present with `None` is declared and untyped; an edge's landing is a
/// thunk, forced only when the required side asks.
pub struct Surface<'a> {
    pub properties: Vec<(String, Option<Ty>)>,
    pub edges: Vec<(String, Option<SurfaceThunk<'a>>)>,
}

/// An edge's landing surface, forced only when the required side asks.
pub type SurfaceThunk<'a> = Box<dyn Fn() -> Option<Surface<'a>> + 'a>;

/// `schemaSurface`: what a published schema offers at `position`.
pub fn schema_surface<'a>(schema: &'a InstanceSchema, position: &str) -> Option<Surface<'a>> {
    let declared = schema.positions.get(position);
    if surface_not_enumerated(declared) {
        return None;
    }
    let declared = declared?;
    Some(Surface {
        properties: declared.properties.iter().map(|(k, v)| (k.clone(), Some(Ty::from_schema(v)))).collect(),
        edges: declared
            .edges
            .iter()
            .map(|(name, edge)| {
                let target = edge.target.clone();
                let thunk: Option<SurfaceThunk<'a>> =
                    schema.positions.contains_key(&target).then(|| Box::new(move || schema_surface(schema, &target)) as SurfaceThunk<'a>);
                (name.clone(), thunk)
            })
            .collect(),
    })
}

/// `suppliedSurface`: a position's surface — a node a construct minted, or a
/// record of an enumerated schema.
pub fn supplied_surface(position: &Position) -> Option<Surface<'_>> {
    match position {
        Position::Local(local) => Some(local_surface(local)),
        Position::MaybeEmpty(of) => supplied_surface(of),
        Position::Position(p) => schema_surface(&p.instance.schema, &p.position),
        _ => None,
    }
}

/// `extractSurface`: what an extracted node offers — each field as its
/// annotation types it (text where none is written), each child node an edge.
pub fn extract_surface(node: &ExtractNode) -> Option<Surface<'_>> {
    if node.declared {
        return None;
    }
    Some(Surface {
        properties: node.properties.iter().map(|(name, field)| (name.clone(), Some(field.explicit.clone().unwrap_or(Ty::Text)))).collect(),
        edges: node.children.iter().map(|(name, child)| (name.clone(), Some(Box::new(move || extract_surface(child)) as SurfaceThunk<'_>))).collect(),
    })
}

fn local_surface<'a>(local: &'a LocalNode) -> Surface<'a> {
    Surface {
        properties: local.reads.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        edges: local
            .edges
            .iter()
            .flatten()
            .map(|(name, edge)| {
                let thunk = edge.target.as_ref().map(|target| Box::new(move || supplied_surface(target)) as SurfaceThunk<'a>);
                (name.clone(), thunk)
            })
            .collect(),
    }
}

/// `surfaceMisfit`: the first thing `supplied` lacks that the required
/// position declares, phrased for the author; `None` when it fits or when
/// either side has nothing to compare.
pub fn surface_misfit(supplied: Option<&Surface>, schema: &InstanceSchema, position: &str, absent_may_be_missing: bool) -> Option<String> {
    misfit_at(supplied, schema, position, absent_may_be_missing, "", &mut vec![])
}

fn misfit_at(supplied: Option<&Surface>, schema: &InstanceSchema, position: &str, absent_may_be_missing: bool, path: &str, seen: &mut Vec<String>) -> Option<String> {
    let required = schema.positions.get(position);
    if surface_not_enumerated(required) {
        return None;
    }
    let required = required?;
    let supplied = supplied?;
    for (name, want) in required.properties.iter() {
        let Some((_, have)) = supplied.properties.iter().find(|(k, _)| k == name) else {
            if absent_may_be_missing && matches!(want, FieldType::Composite(Composite::MaybeAbsent { .. })) {
                continue;
            }
            return Some(format!("it has no {path}`{name}`"));
        };
        let Some(have) = have else { continue };
        let want = Ty::from_schema(want);
        if !field_assignable(have, &want) {
            return Some(format!("its {path}`{name}` is {}, not {}{}", describe_field_type(have), describe_field_type(&want), text_repair(have, &want)));
        }
    }
    for (name, edge) in required.edges.iter() {
        let Some((_, landing)) = supplied.edges.iter().find(|(k, _)| k == name) else { continue };
        if seen.contains(&edge.target) {
            continue;
        }
        let landed = landing.as_ref().and_then(|thunk| thunk());
        seen.push(edge.target.clone());
        let misfit = misfit_at(landed.as_ref(), schema, &edge.target, absent_may_be_missing, &format!("{name} → "), seen);
        seen.pop();
        if misfit.is_some() {
            return misfit;
        }
    }
    None
}

/// `textRepair`: how to write the text a number or a yes/no should be.
pub fn text_repair(have: &Ty, want: &Ty) -> &'static str {
    if !matches!(strip_absent(want), Ty::Text) {
        return "";
    }
    match strip_absent(have) {
        Ty::Number => " — write the text it should be: `TOSTRING(…)`",
        Ty::Boolean => " — write the text it should be: `IF … THEN \"Yes\" ELSE \"No\" END`",
        _ => "",
    }
}

/// A `type` declaration's option set as a schema spells it.
pub fn schema_type_of(ty: &Ty) -> Option<SchemaFieldType> {
    match ty {
        Ty::Enum { options, .. } => Some(FieldType::Composite(Composite::Enum { options: options.clone(), open: None })),
        _ => None,
    }
}
