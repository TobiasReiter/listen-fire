//! An adapter's introspection (`listEntryPoints()` entries plus one
//! `describe(typeId)` descriptor per entry) projected into the checker's
//! `InstanceSchema`: a port of movement-engine's
//! `translation_graph/movement/schema_projection.ts`
//! `instanceSchemaFromDescriptors`, member for member and in the TypeScript's
//! key order (the catalog reads several maps in text order). The why of each
//! rule is in the TypeScript; the comments here say only where a JavaScript
//! semantic is reproduced on purpose.

use std::collections::{HashMap, HashSet};

use indexmap::{IndexMap, IndexSet};
use movement_parser::catalog::helpers::{union_display, union_key, union_variants};

use crate::json::{Js, Obj};
use crate::obj;

/// The reserved resources reference (`RESOURCES_REFERENCE_FIELD_ID`).
const RESOURCES_REFERENCE_FIELD_ID: &str = "_resources";

pub struct ProjectionInput<'a> {
    pub adapter_type: &'a str,
    pub entries: &'a [Js],
    pub reached: &'a [Js],
    /// Descriptor per entry typeId, in the order they were set.
    pub descriptors: &'a IndexMap<String, Js>,
    pub meta_descriptor: Option<&'a Js>,
    pub supports_in_place_update: bool,
    pub edges_carry_properties: bool,
    pub all_entries: Option<&'a [Js]>,
    pub lazily_walked: bool,
}

pub struct Projection {
    pub schema: Js,
    /// What the projection left out and why. The hosted product reports
    /// these; lf discards them.
    pub notes: Vec<String>,
}

/// `String(value)` for a value used as an object key.
fn key(value: Option<&Js>) -> String {
    match value {
        None => "undefined".into(),
        Some(Js::Null) => "null".into(),
        Some(Js::Bool(b)) => b.to_string(),
        Some(Js::Num(n)) => n.to_string(),
        Some(Js::Str(s)) => s.clone(),
        Some(other) => other.to_json(),
    }
}

/// JavaScript truthiness.
fn truthy(value: Option<&Js>) -> bool {
    match value {
        None | Some(Js::Null) | Some(Js::Bool(false)) => false,
        Some(Js::Num(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Js::Str(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `a ?? b`.
fn nullish_or<'a>(a: Option<&'a Js>, b: Option<&'a Js>) -> Option<&'a Js> {
    match a {
        None | Some(Js::Null) => b,
        some => some,
    }
}

fn items(value: Option<&Js>) -> &[Js] {
    value.and_then(Js::as_array).unwrap_or(&[])
}

/// `referenceTargetTypeIds`: one target, or several de-duplicated in order.
fn reference_target_type_ids(reference: &Js) -> Vec<String> {
    match reference.get("targetTypeIds") {
        None => vec![key(reference.get("targetTypeId"))],
        Some(ids) => items(Some(ids)).iter().map(|i| key(Some(i))).collect::<IndexSet<_>>().into_iter().collect(),
    }
}

fn is_artificial_edge(edge: &str) -> bool {
    edge.starts_with('@')
}

fn leave_out_artificial_edge(adapter_type: &str, edge: &str, notes: &mut Vec<String>) -> bool {
    if !is_artificial_edge(edge) {
        return false;
    }
    notes.push(format!(
        "{adapter_type}: the edge '{edge}' starts with '@', which is reserved for edges the engine makes (such as '@old') — it was left out; rename it in the source system to reach it"
    ));
    true
}

/// `fieldTypeFromDescriptor`: a field's type, or none for a reference (an
/// edge) or a kind with no projection.
pub fn field_type_from_descriptor(field: &Js) -> Option<Js> {
    let scalar = match field.get("kind").and_then(Js::as_str) {
        Some("string") => {
            let known = items(field.get("knownValues"));
            if field.get("knownValues").is_some() && !known.is_empty() {
                let open = match field.get("knownValuePattern") {
                    Some(pattern) => obj! { "allowPattern" => pattern.clone() },
                    None => Obj::new(),
                };
                Js::from(obj! { "kind" => Js::str("enum"), "options" => Js::Arr(known.to_vec()), "open" => Js::from(open) })
            } else {
                Js::str("text")
            }
        }
        Some(kind @ ("number" | "boolean" | "date" | "file" | "json")) => Js::str(kind),
        Some("enum") => match field.get("enumValues") {
            None => Js::str("text"),
            Some(values) => Js::from(obj! { "kind" => Js::str("enum"), "options" => values.clone() }),
        },
        _ => return None,
    };
    Some(if field.get("cardinality").and_then(Js::as_str) == Some("many") {
        Js::from(obj! { "kind" => Js::str("list"), "of" => scalar })
    } else {
        scalar
    })
}

fn project_native_uniqueness(
    constraints: Option<&Js>,
    surface_field_by_internal_id: &HashMap<String, String>,
    edge_surface_by_field_id: &HashMap<String, String>,
    parent_edges: Option<&IndexSet<String>>,
    label: &str,
    notes: &mut Vec<String>,
) -> Vec<Vec<String>> {
    let mut projected = Vec::new();
    for branch in items(constraints.and_then(|c| c.get("any"))) {
        let all = items(branch.get("all"));
        if all.is_empty() {
            continue;
        }
        let mut group = Vec::new();
        let mut mappable = true;
        for entry in all {
            let field = key(entry.get("field"));
            if let Some(surface) = surface_field_by_internal_id.get(&field) {
                group.push(surface.clone());
            } else if let Some(edge) = edge_surface_by_field_id.get(&field) {
                group.push(edge.clone());
            } else if parent_edges.is_some_and(|p| p.contains(&field)) {
                group.push(field);
            } else {
                mappable = false;
                break;
            }
        }
        if mappable {
            projected.push(group);
        } else {
            let named = all.iter().map(|e| key(e.get("field"))).collect::<Vec<_>>().join(", ");
            notes.push(format!(
                "{label}: a native uniqueness rule references '{named}' — not all of it maps to surface names, so the rule is omitted from the declared nativeUniqueness"
            ));
        }
    }
    projected
}

fn project_fuzzy_resolution(declared: Option<&Js>, surface_field_by_internal_id: &HashMap<String, String>, label: &str, notes: &mut Vec<String>) -> Option<Js> {
    match declared {
        None | Some(Js::Bool(false)) => None,
        Some(Js::Bool(true)) => Some(Js::Bool(true)),
        Some(list) => {
            let mut fields: Vec<String> = Vec::new();
            for field_id in items(Some(list)) {
                let field_id = key(Some(field_id));
                match surface_field_by_internal_id.get(&field_id) {
                    None => notes.push(format!("{label}: fuzzy resolution names '{field_id}', which is not one of its fields — omitted")),
                    Some(surface) if !fields.contains(surface) => fields.push(surface.clone()),
                    Some(_) => {}
                }
            }
            (!fields.is_empty()).then(|| Js::strings(fields))
        }
    }
}

fn project_write_union(declaration: &Js, write_field_name_by_id: &HashMap<String, String>, label: &str, notes: &mut Vec<String>) -> Js {
    let variants = items(declaration.get("variants"))
        .iter()
        .map(|variant| {
            let variant_name = key(variant.get("name"));
            let mut fields = Vec::new();
            for field_id in items(variant.get("fields")) {
                let field_id = key(Some(field_id));
                match write_field_name_by_id.get(&field_id) {
                    Some(name) => fields.push(name.clone()),
                    None => notes.push(format!(
                        "{label}: write variant '{variant_name}' names field '{field_id}', which did not project onto the write surface — the variant is projected without it"
                    )),
                }
            }
            let mut out = Obj::new();
            if let Some(name) = variant.get("name") {
                out.insert("name".into(), name.clone());
            }
            out.insert("fields".into(), Js::strings(fields));
            Js::from(out)
        })
        .collect();
    Js::from(obj! { "variants" => Js::Arr(variants) })
}

/// `{ ...a, ...b }` over two objects.
fn spread(a: Option<&Js>, b: Option<&Js>) -> Js {
    let mut out = Obj::new();
    for source in [a, b].into_iter().flatten() {
        if let Js::Obj(map) = source {
            for (k, v) in map {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Js::from(out)
}

/// `mergeVariantShape`: the variant type's write shape merged onto the base's.
fn merge_variant_shape(base: &Obj, variant: Option<&Obj>) -> Obj {
    let mut rest = base.clone();
    rest.shift_remove("discriminated");
    let Some(variant) = variant else { return rest };
    let mut required: IndexSet<String> = IndexSet::new();
    for source in [base.get("requiredFields"), variant.get("requiredFields")] {
        for f in items(source) {
            required.insert(key(Some(f)));
        }
    }
    rest.insert("fields".into(), spread(base.get("fields"), variant.get("fields")));
    rest.insert("resultShape".into(), spread(base.get("resultShape"), variant.get("resultShape")));
    if !required.is_empty() {
        rest.insert("requiredFields".into(), Js::strings(required));
    }
    if base.get("edges").is_some() || variant.get("edges").is_some() {
        rest.insert("edges".into(), spread(base.get("edges"), variant.get("edges")));
    }
    if base.get("fieldDocs").is_some() || variant.get("fieldDocs").is_some() {
        rest.insert("fieldDocs".into(), spread(base.get("fieldDocs"), variant.get("fieldDocs")));
    }
    if let Some(write_union) = variant.get("writeUnion") {
        rest.insert("writeUnion".into(), write_union.clone());
    }
    rest
}

/// The flags an edge carries over from its reference: (reference member,
/// projected only when it is `true`).
const EDGE_TRUE_FLAGS: &[&str] = &["ephemeral"];

pub fn instance_schema_from_descriptors(input: &ProjectionInput) -> Projection {
    let mut notes = Vec::new();
    let adapter_type = input.adapter_type;
    let meta_entries = input.all_entries.unwrap_or(input.entries);
    let all_entries: Vec<&Js> = meta_entries.iter().chain(input.reached).collect();
    let meta_edge_type_ids: HashSet<String> = meta_entries.iter().map(|e| key(e.get("typeId"))).collect();
    let display_of = |type_id: &str| -> Option<String> {
        all_entries.iter().find(|e| key(e.get("typeId")) == type_id).map(|e| key(e.get("displayName")))
    };
    let target_names_of = |reference: &Js| -> Vec<String> {
        reference_target_type_ids(reference)
            .into_iter()
            .map(|type_id| display_of(&type_id).unwrap_or(type_id))
            .collect::<IndexSet<_>>()
            .into_iter()
            .collect()
    };

    let mut edge_target_names: IndexSet<String> = IndexSet::new();
    let mut incoming_edge_names: HashMap<String, IndexSet<String>> = HashMap::new();
    for descriptor in input.descriptors.values() {
        for reference in items(descriptor.get("references")) {
            for name in target_names_of(reference) {
                edge_target_names.insert(name.clone());
                incoming_edge_names.entry(name).or_default().insert(key(nullish_or(reference.get("name"), reference.get("fieldId"))));
            }
        }
    }

    let mut positions = Obj::new();
    let mut collections = Obj::new();
    let mut root_capabilities: IndexMap<String, Js> = IndexMap::new();
    for reference in items(input.meta_descriptor.and_then(|m| m.get("references"))) {
        if let Some(capability) = reference.get("capability") {
            root_capabilities.insert(key(nullish_or(reference.get("name"), reference.get("fieldId"))), capability.clone());
        }
    }
    let mut unions = Obj::new();
    let mut union_display_names = Obj::new();
    // Shapes by name; `writableRoots` and `createShapes` name them and are
    // materialised at the end, since the TypeScript's registries alias the
    // shape objects a discriminated write later extends.
    let mut shape_by_name: IndexMap<String, Obj> = IndexMap::new();
    let mut writable_roots: Vec<String> = Vec::new();
    let mut writable_targets: IndexSet<String> = IndexSet::new();
    let mut type_id_by_name: HashMap<String, String> = HashMap::new();

    for entry in input.entries.iter().chain(input.reached) {
        let name = key(entry.get("displayName"));
        let type_id = key(entry.get("typeId"));
        if let Some(claimed_by) = type_id_by_name.get(&name) {
            if *claimed_by != type_id {
                notes.push(format!(
                    "{adapter_type}: more than one type is named '{name}' — keeping the first; rename one in the source system to address the other"
                ));
            }
            continue;
        }
        type_id_by_name.insert(name.clone(), type_id.clone());

        let readable = truthy(entry.get("readable"));
        if meta_edge_type_ids.contains(&type_id) && (readable || truthy(entry.get("writable"))) {
            let collection_name = nullish_or(entry.get("collectionName"), None).map(|c| key(Some(c))).unwrap_or_else(|| name.clone());
            if !leave_out_artificial_edge(adapter_type, &collection_name, &mut notes) {
                let mut collection = obj! { "target" => Js::str(&name) };
                if let Some(capability) = root_capabilities.get(&collection_name) {
                    collection.insert("capability".into(), capability.clone());
                }
                collections.insert(collection_name, Js::from(collection));
            }
        }

        let positioned = readable || Js::is_true(entry.get("fires")) || edge_target_names.contains(&name);
        let Some(descriptor) = input.descriptors.get(&type_id) else {
            if positioned {
                positions.insert(name, undescribed());
            }
            continue;
        };

        let mut properties = Obj::new();
        let mut property_capabilities = Obj::new();
        let mut writable_fields = Obj::new();
        let mut write_only_properties: Vec<String> = Vec::new();
        let mut ambiguous_properties: Vec<String> = Vec::new();
        let mut required_fields: Vec<String> = Vec::new();
        let mut field_docs = Obj::new();
        let mut write_field_name_by_id: HashMap<String, String> = HashMap::new();
        let mut dropped_field = false;
        let fields = items(descriptor.get("fields"));
        for field in fields {
            let Some(type_) = field_type_from_descriptor(field) else {
                if field.get("kind").and_then(Js::as_str) != Some("reference") {
                    dropped_field = true;
                }
                continue;
            };
            let field_name = key(field.get("displayName"));
            if properties.contains_key(&field_name) || write_only_properties.contains(&field_name) {
                if !ambiguous_properties.contains(&field_name) {
                    ambiguous_properties.push(field_name.clone());
                }
                notes.push(format!("{adapter_type}: '{name}' has more than one field named '{field_name}' — reads resolve to the first"));
                continue;
            }
            if Js::is_false(field.get("readable")) {
                write_only_properties.push(field_name.clone());
            } else {
                properties.insert(field_name.clone(), type_.clone());
                if let Some(capability) = field.get("capability") {
                    property_capabilities.insert(field_name.clone(), capability.clone());
                }
            }
            if truthy(field.get("writable")) {
                writable_fields.insert(field_name.clone(), type_);
                write_field_name_by_id.insert(key(field.get("fieldId")), field_name.clone());
                if Js::is_true(field.get("required")) {
                    required_fields.push(field_name.clone());
                }
                if let Some(Js::Str(description)) = field.get("description")
                    && !description.is_empty()
                {
                    field_docs.insert(field_name.clone(), Js::str(description));
                }
            }
        }

        let mut edges = Obj::new();
        let mut edge_surface_by_field_id: HashMap<String, String> = HashMap::new();
        let mut required_edges: Vec<Js> = Vec::new();
        for reference in items(descriptor.get("references")) {
            let edge = key(nullish_or(reference.get("name"), reference.get("fieldId")));
            if leave_out_artificial_edge(adapter_type, &edge, &mut notes) {
                continue;
            }
            let field_id = key(reference.get("fieldId"));
            let target_names = target_names_of(reference);
            let polymorphic = target_names.len() > 1;
            let target = if polymorphic { Some(union_key(&target_names)) } else { target_names.first().cloned() };
            if polymorphic && let Some(target) = &target {
                unions.insert(target.clone(), Js::strings(union_variants(&target_names)));
                union_display_names.insert(target.clone(), Js::str(union_display(&target_names)));
            }
            let unpublished: Vec<String> = reference_target_type_ids(reference).into_iter().filter(|t| display_of(t).is_none()).collect();
            if !unpublished.is_empty() && field_id != RESOURCES_REFERENCE_FIELD_ID && !input.lazily_walked {
                notes.push(format!(
                    "{adapter_type}: '{name}' reference '{edge}' targets {}, which listEntryPoints does not publish — the internal id will surface; publish the type or name it naturally",
                    unpublished.iter().map(|t| format!("'{t}'")).collect::<Vec<_>>().join(", ")
                ));
            }
            let replaces = match edges.get(&edge) {
                None => true,
                Some(existing) => Js::is_true(existing.get("resources")) && field_id != RESOURCES_REFERENCE_FIELD_ID,
            };
            if replaces {
                edges.insert(edge.clone(), Js::from(edge_schema(reference, target.as_deref(), polymorphic, &field_id)));
                if Js::is_true(reference.get("required")) {
                    let mut required = obj! { "edge" => Js::str(&edge) };
                    if let Some(target) = &target {
                        required.insert("from".into(), Js::str(target));
                    }
                    required_edges.push(Js::from(required));
                }
            }
            if Js::is_true(reference.get("writable")) {
                writable_targets.extend(target_names.iter().cloned());
            }
            edge_surface_by_field_id.insert(field_id, edge);
        }

        if positioned {
            let mut position = obj! { "properties" => Js::from(properties.clone()), "edges" => Js::from(edges.clone()) };
            if !property_capabilities.is_empty() {
                position.insert("propertyCapabilities".into(), Js::from(property_capabilities));
            }
            if dropped_field {
                position.insert("openProperties".into(), Js::Bool(true));
            }
            if !write_only_properties.is_empty() {
                position.insert("writeOnlyProperties".into(), Js::strings(&write_only_properties));
            }
            if !ambiguous_properties.is_empty() {
                position.insert("ambiguousProperties".into(), Js::strings(&ambiguous_properties));
            }
            if Js::is_true(descriptor.get("deletable")) {
                position.insert("deletable".into(), Js::Bool(true));
            }
            positions.insert(name.clone(), Js::from(position));
        }

        if !writable_fields.is_empty() {
            let surface_field_by_internal_id: HashMap<String, String> = fields
                .iter()
                .filter(|f| properties.contains_key(&key(f.get("displayName"))))
                .map(|f| (key(f.get("fieldId")), key(f.get("displayName"))))
                .rev() // `new Map(pairs)`: a repeated id keeps the last pair's name
                .fold(HashMap::new(), |mut m, (k, v)| {
                    m.entry(k).or_insert(v);
                    m
                });
            let native_uniqueness = project_native_uniqueness(
                descriptor.get("uniquenessConstraints"),
                &surface_field_by_internal_id,
                &edge_surface_by_field_id,
                incoming_edge_names.get(&name),
                &name,
                &mut notes,
            );
            let mut fuzzy_names = write_field_name_by_id.clone();
            fuzzy_names.extend(surface_field_by_internal_id.iter().map(|(k, v)| (k.clone(), v.clone())));
            let fuzzy_resolution = project_fuzzy_resolution(descriptor.get("supportsFuzzyResolution"), &fuzzy_names, &name, &mut notes);
            let write_union = descriptor.get("writeUnion").map(|d| project_write_union(d, &write_field_name_by_id, &name, &mut notes));

            let mut result_shape = obj! { "externalId" => Js::str("text"), "url" => Js::str("text") };
            for (k, v) in properties.iter().chain(writable_fields.iter()) {
                result_shape.insert(k.clone(), v.clone());
            }
            let mut shape = obj! { "fields" => Js::from(writable_fields), "resultShape" => Js::from(result_shape) };
            if !native_uniqueness.is_empty() {
                shape.insert("nativeUniqueness".into(), Js::Arr(native_uniqueness.into_iter().map(Js::strings).collect()));
            }
            if !edges.is_empty() {
                shape.insert("edges".into(), Js::from(edges));
            }
            if !required_edges.is_empty() {
                shape.insert("requiredEdges".into(), Js::Arr(required_edges));
            }
            if !required_fields.is_empty() {
                shape.insert("requiredFields".into(), Js::strings(&required_fields));
            }
            if !field_docs.is_empty() {
                shape.insert("fieldDocs".into(), Js::from(field_docs));
            }
            if let Some(fuzzy) = fuzzy_resolution {
                shape.insert("fuzzyResolution".into(), fuzzy);
            }
            if Js::is_false(descriptor.get("uniquenessAuthorable")) {
                shape.insert("uniquenessAuthorable".into(), Js::Bool(false));
            }
            if let Some(write_union) = write_union {
                shape.insert("writeUnion".into(), write_union);
            }
            shape_by_name.insert(name.clone(), shape);
            if truthy(entry.get("writable")) {
                writable_roots.push(name);
            }
        }
    }

    let entry_names: HashSet<String> = all_entries.iter().map(|e| key(e.get("displayName"))).collect();
    for target in &edge_target_names {
        if positions.contains_key(target) || entry_names.contains(target) {
            continue;
        }
        positions.insert(target.clone(), undescribed());
    }

    let create_shapes: Vec<String> = writable_targets
        .iter()
        .filter(|t| !writable_roots.contains(t) && shape_by_name.contains_key(*t))
        .cloned()
        .collect();

    let described_type_names: HashSet<String> =
        all_entries.iter().filter(|e| input.descriptors.contains_key(&key(e.get("typeId")))).map(|e| key(e.get("displayName"))).collect();
    for (type_id, descriptor) in input.descriptors {
        let Some(declaration) = descriptor.get("discriminatedWrite") else { continue };
        let name = display_of(type_id).unwrap_or_else(|| type_id.clone());
        let Some(base) = shape_by_name.get(&name).cloned() else { continue };
        let mut variants = Obj::new();
        if let Some(Js::Obj(variant_types)) = declaration.get("variantTypes") {
            for (literal, variant_type) in variant_types {
                let variant_type_name = key(Some(variant_type));
                if !described_type_names.contains(&variant_type_name) {
                    notes.push(format!(
                        "{adapter_type}: {name} declares write variant \"{literal}\" as type '{variant_type_name}', which was never described — the variant is omitted rather than collapsed onto the base shape, so a body naming that variant's own fields is rejected rather than silently accepted."
                    ));
                    continue;
                }
                let mut variant = merge_variant_shape(&base, shape_by_name.get(&variant_type_name));
                if positions.contains_key(&variant_type_name) {
                    variant.insert("position".into(), Js::str(&variant_type_name));
                }
                variants.insert(literal.clone(), Js::from(variant));
            }
        }
        let mut discriminated = Obj::new();
        if let Some(discriminant) = declaration.get("discriminant") {
            discriminated.insert("discriminant".into(), discriminant.clone());
        }
        discriminated.insert("variants".into(), Js::from(variants));
        if let Some(shape) = shape_by_name.get_mut(&name) {
            shape.insert("discriminated".into(), Js::from(discriminated));
        }
    }

    let event_positions: Vec<Js> = all_entries
        .iter()
        .filter(|e| Js::is_true(e.get("fires")))
        .map(|e| {
            let mut position = obj! { "position" => Js::str(key(e.get("displayName"))) };
            if let Some(on) = e.get("firesOn") {
                position.insert("on".into(), Js::Arr(items(Some(on)).to_vec()));
            }
            Js::from(position)
        })
        .collect();
    let published_collection_names: HashSet<String> = all_entries
        .iter()
        .filter(|e| Js::is_true(e.get("readable")) || Js::is_true(e.get("writable")))
        .map(|e| key(nullish_or(e.get("collectionName"), e.get("displayName"))))
        .collect();
    for collection_name in root_capabilities.keys() {
        if !published_collection_names.contains(collection_name) {
            notes.push(format!(
                "{adapter_type}: the root descriptor declares a capability for '{collection_name}', which listEntryPoints publishes no collection under — the declaration is dropped; give the two the same name"
            ));
        }
    }
    let readable_entries: Vec<&&Js> = all_entries.iter().filter(|e| truthy(e.get("readable"))).collect();
    let event_position = event_positions
        .first()
        .and_then(|p| p.get("position").cloned())
        .or_else(|| (readable_entries.len() == 1).then(|| Js::str(key(readable_entries[0].get("displayName")))));

    let materialise = |names: &[String]| -> Obj {
        names.iter().filter_map(|n| shape_by_name.get(n).map(|s| (n.clone(), Js::from(s.clone())))).collect()
    };
    let mut schema = obj! { "positions" => Js::from(positions), "collections" => Js::from(collections) };
    if !unions.is_empty() {
        schema.insert("unions".into(), Js::from(unions));
        schema.insert("unionDisplayNames".into(), Js::from(union_display_names));
    }
    schema.insert("writableRoots".into(), Js::from(materialise(&writable_roots)));
    if !create_shapes.is_empty() {
        schema.insert("createShapes".into(), Js::from(materialise(&create_shapes)));
    }
    if input.supports_in_place_update {
        schema.insert("supportsInPlaceUpdate".into(), Js::Bool(true));
    }
    if input.edges_carry_properties {
        schema.insert("edgesCarryProperties".into(), Js::Bool(true));
    }
    if let Some(event_position) = event_position {
        schema.insert("eventPosition".into(), event_position);
    }
    if !event_positions.is_empty() {
        schema.insert("eventPositions".into(), Js::Arr(event_positions));
    }
    Projection { schema: Js::from(schema), notes }
}

fn undescribed() -> Js {
    Js::from(obj! { "properties" => Js::from(Obj::new()), "edges" => Js::from(Obj::new()), "undescribed" => Js::Bool(true) })
}

/// One reference's edge, its members in the TypeScript's order.
fn edge_schema(reference: &Js, target: Option<&str>, polymorphic: bool, field_id: &str) -> Obj {
    let mut edge = Obj::new();
    if let Some(target) = target {
        edge.insert("target".into(), Js::str(target));
    }
    let mut flag = |name: &str, when: bool, value: Js| {
        if when {
            edge.insert(name.into(), value);
        }
    };
    flag("polymorphic", polymorphic, Js::Bool(true));
    flag("required", Js::is_true(reference.get("required")), Js::Bool(true));
    for passed in ["capability", "sequenced"] {
        if let Some(value) = reference.get(passed) {
            flag(passed, true, value.clone());
        }
    }
    for name in EDGE_TRUE_FLAGS {
        flag(name, Js::is_true(reference.get(name)), Js::Bool(true));
    }
    flag("readable", Js::is_false(reference.get("readable")), Js::Bool(false));
    flag("writable", Js::is_true(reference.get("writable")), Js::Bool(true));
    flag("linkable", Js::is_false(reference.get("linkable")), Js::Bool(false));
    for name in ["requiresLiveRecord", "subject", "awaitable", "resolvesEmpty", "watchable"] {
        flag(name, Js::is_true(reference.get(name)), Js::Bool(true));
    }
    if let Some(generic_over) = reference.get("genericOver") {
        flag("genericOver", true, generic_over.clone());
    }
    flag("resources", field_id == RESOURCES_REFERENCE_FIELD_ID, Js::Bool(true));
    edge
}

/// The projection over an adapter's own introspection answers, as
/// `lf check` and a session ask it of each adapter external (crate::check `describe_external`).
pub fn describe_external_schema(adapter_type: &str, entries: &[Js], descriptors: &IndexMap<String, Js>) -> Js {
    instance_schema_from_descriptors(&ProjectionInput {
        adapter_type,
        entries,
        reached: &[],
        descriptors,
        meta_descriptor: None,
        // A remote adapter always has `updateRecord` (it is not one of the
        // optional methods the client prunes), so `typeof … === 'function'`.
        supports_in_place_update: true,
        edges_carry_properties: false,
        all_entries: None,
        lazily_walked: false,
    })
    .schema
}

/// `--project-schema`: the projection over `instanceSchemaFromDescriptors`'s
/// input as JSON (`descriptors` as `[typeId, descriptor]` pairs, a `Map`'s
/// entries), answering `{ schema, notes }`.
pub fn probe(input: &Js) -> Result<Js, String> {
    let list = |key: &str| input.get(key).and_then(Js::as_array).map(<[Js]>::to_vec);
    let entries = list("entries").ok_or("entries: expected an array")?;
    let reached = list("reached").unwrap_or_default();
    let all_entries = list("allEntries");
    let mut descriptors = IndexMap::new();
    for pair in list("descriptors").ok_or("descriptors: expected [typeId, descriptor] pairs")? {
        match pair.as_array() {
            Some([Js::Str(type_id), descriptor]) => {
                descriptors.insert(type_id.clone(), descriptor.clone());
            }
            _ => return Err("descriptors: expected [typeId, descriptor] pairs".into()),
        }
    }
    let projection = instance_schema_from_descriptors(&ProjectionInput {
        adapter_type: input.get("adapterType").and_then(Js::as_str).ok_or("adapterType: expected a string")?,
        entries: &entries,
        reached: &reached,
        descriptors: &descriptors,
        meta_descriptor: input.get("metaDescriptor"),
        supports_in_place_update: Js::is_true(input.get("supportsInPlaceUpdate")),
        edges_carry_properties: Js::is_true(input.get("edgesCarryProperties")),
        all_entries: all_entries.as_deref(),
        lazily_walked: Js::is_true(input.get("lazilyWalked")),
    });
    Ok(Js::from(obj! { "schema" => projection.schema, "notes" => Js::strings(projection.notes) }))
}
