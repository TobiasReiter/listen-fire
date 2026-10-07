//! The pure helpers of checker/catalog.ts that the checker and apps/api call
//! on schema data, and the two snapshot.ts leans on (`entryPositionKeyOf`,
//! parser/scan.ts's `unwrapCredentialArg`).

use indexmap::IndexMap;
use serde_json::Value;

use super::types::{AdapterSpec, ArgKind, Composite, ConstructionArg, FieldType, InstanceSchema, Scalar, SchemaFieldType};
use crate::scan::{scan_backtick_name, scan_ident};
use crate::util::js::{self, cmp_utf16, locale_compare};

/// `credentialArgOf(spec)`: the credential entry of a construction
/// signature, when the adapter needs one.
pub fn credential_arg_of(spec: &AdapterSpec) -> Option<&ConstructionArg> {
    first_credential_arg(&spec.construction_args)
}

pub fn first_credential_arg(args: &[ConstructionArg]) -> Option<&ConstructionArg> {
    args.iter().find(|a| a.kind == ArgKind::Credential)
}

/// `entryPositionKeyOf(spec, args)`: the entry position a construction pins,
/// as the opaque key schemas are stored under — the declared position args
/// written, unquoted, sorted by name, as JSON; `''` when none is.
pub fn entry_position_key_of(spec: &AdapterSpec, args: Option<&super::snapshot::Args>) -> String {
    position_key(&spec.construction_args, args)
}

pub fn position_key(construction_args: &[ConstructionArg], args: Option<&super::snapshot::Args>) -> String {
    let mut values: Vec<(&str, String)> = Vec::new();
    for arg in construction_args {
        if arg.kind != ArgKind::Position {
            continue;
        }
        let Some(raw) = args.and_then(|a| a.get(&arg.name)) else { continue };
        if js::trim(raw).is_empty() {
            continue;
        }
        values.push((&arg.name, unquote_construction_arg(raw)));
    }
    // `localeCompare`, a stable sort: equal names keep their order.
    values.sort_by(|(a, _), (b, _)| locale_compare(a, b));
    if values.is_empty() {
        return String::new();
    }
    serde_json::to_string(&values).expect("pairs of strings always serialise")
}

/// A position arg's value as written is source text; the key is the value.
fn unquote_construction_arg(raw: &str) -> String {
    let trimmed = js::trim(raw);
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        return trimmed[1..trimmed.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\");
    }
    trimmed
}

/// `unwrapCredentialArg(raw)`: the name a credential argument's text names —
/// a bare identifier or one backtick-quoted name spanning all of it.
pub fn unwrap_credential_arg(raw: &str) -> Option<String> {
    let trimmed: Vec<u16> = js::trim(raw).encode_utf16().collect();
    if trimmed.first() == Some(&u16::from(b'`')) {
        let (name, close) = scan_backtick_name(&trimmed, 0)?;
        return (close == trimmed.len() - 1).then_some(name);
    }
    let (name, end) = scan_ident(&trimmed, 0)?;
    (end == trimmed.len()).then_some(name)
}

/// `parseFieldTypeName(name)`: a surface type name's type.
pub fn parse_field_type_name(name: Option<&str>) -> Option<SchemaFieldType> {
    let scalar = match name? {
        "text" => Scalar::Text,
        "number" => Scalar::Number,
        "boolean" => Scalar::Boolean,
        "date" => Scalar::Date,
        "datetime" => Scalar::Datetime,
        "file" => Scalar::File,
        "json" => Scalar::Json,
        _ => return None,
    };
    Some(FieldType::Scalar(scalar))
}

/// `variantOf(type)`: the type as one tagged value, a bare name given the
/// `kind` the collections carry.
pub fn variant_of(type_: &FieldType) -> Variant<'_> {
    match type_ {
        FieldType::Scalar(s) => Variant::Scalar { kind: s.name() },
        FieldType::Composite(_) => Variant::Composite(type_),
    }
}

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum Variant<'a> {
    Scalar { kind: &'static str },
    Composite(&'a FieldType),
}

/// `describeFieldType(type)`: the type in author-facing words. A record's
/// position is described by the typing layer, which this crate does not
/// hold yet; describing one is refused rather than guessed.
pub fn describe_field_type(type_: &FieldType) -> Result<String, String> {
    let c = match type_ {
        FieldType::Scalar(Scalar::Absent) => return Ok("null".into()),
        FieldType::Scalar(s) => return Ok(s.name().into()),
        FieldType::Composite(c) => c,
    };
    Ok(match c {
        Composite::MaybeAbsent { of } => format!("{} (or absent)", describe_member(of)?),
        Composite::List { of, .. } => format!("list of {}", describe_member(of)?),
        Composite::Union { of } => of.iter().map(describe_field_type).collect::<Result<Vec<_>, _>>()?.join(" | "),
        Composite::Tuple { of, rest } => {
            let mut slots = of.iter().map(slot).collect::<Result<Vec<_>, _>>()?;
            if let Some(rest) = rest {
                let run = match &rest.of {
                    None => "?".to_string(),
                    Some(of) => describe_member(of)?,
                };
                let at = splice_start(rest.at.0, slots.len());
                slots.insert(at, format!("...list of {run}"));
            }
            format!("[{}]", slots.join(", "))
        }
        Composite::Dict { shape: Some(shape), .. } => {
            let keys = shape.iter().map(|(k, v)| Ok(format!("{k}: {}", slot(v)?))).collect::<Result<Vec<_>, String>>()?;
            format!("{{ {} }}", keys.join(", "))
        }
        Composite::Dict { of, shape: None } => format!("dict of {}", describe_member(of)?),
        Composite::Record { position: Some(_) } => {
            return Err("describing a record's position is the typing layer's, which is not ported".into());
        }
        Composite::Record { position: None } => "a record".into(),
        Composite::Enum { options, open: Some(_) } => format!("known values ({}, …)", options.join(" | ")),
        Composite::Enum { options, open: None } if options.is_empty() => "enum (no available values)".into(),
        Composite::Enum { options, open: None } => format!("enum ({})", options.join(" | ")),
    })
}

fn slot(type_: &Option<FieldType>) -> Result<String, String> {
    match type_ {
        None => Ok("?".into()),
        Some(t) => describe_field_type(t),
    }
}

/// A type inside another, parenthesised when it is a union.
fn describe_member(type_: &FieldType) -> Result<String, String> {
    let described = describe_field_type(type_)?;
    Ok(match type_ {
        FieldType::Composite(Composite::Union { .. }) => format!("({described})"),
        _ => described,
    })
}

/// `Array.prototype.splice`'s start: truncated, counted from the end when
/// negative, clamped to the length.
fn splice_start(at: f64, len: usize) -> usize {
    let at = if at.is_nan() { 0.0 } else { at.trunc() };
    if at < 0.0 { (len as f64 + at).max(0.0) as usize } else { at.min(len as f64) as usize }
}

/// `refinementKey({type, filter})`: a refinement's identity — the type and
/// the filter written with sorted keys.
pub fn refinement_key(type_: &str, filter: &Value) -> String {
    serde_json::to_string(&(type_, canonicalize(filter))).expect("strings always serialise")
}

/// catalog.ts's `canonicalize`: JSON with every object's keys sorted, by
/// UTF-16 units as `<` sorts them.
fn canonicalize(value: &Value) -> String {
    match value {
        Value::Array(items) => format!("[{}]", items.iter().map(canonicalize).collect::<Vec<_>>().join(",")),
        Value::Object(members) => {
            let mut entries: Vec<(&String, &Value)> = members.iter().collect();
            entries.sort_by(|(a, _), (b, _)| cmp_utf16(a, b));
            let written: Vec<String> = entries
                .into_iter()
                .map(|(k, v)| format!("{}:{}", serde_json::to_string(k).expect("strings always serialise"), canonicalize(v)))
                .collect();
            format!("{{{}}}", written.join(","))
        }
        Value::Number(n) => n.as_f64().map_or_else(|| "null".into(), js::number_to_string),
        other => serde_json::to_string(other).expect("a JSON scalar always serialises"),
    }
}

/// `borrowedTypeSegments(name)`: a borrowed type's dotted path, or nothing
/// for a plain type name.
pub fn borrowed_type_segments(name: Option<&str>) -> Option<Vec<String>> {
    let name = name?;
    name.contains('.').then(|| name.split('.').map(String::from).collect())
}

/// `resolveBorrowedField(schema, root, field)`: a field of one root or
/// position, the writable root's winning by name.
pub fn resolve_borrowed_field<'a>(schema: &'a InstanceSchema, root: &str, field: &str) -> Option<&'a SchemaFieldType> {
    let writable = schema.writable_roots.get(root).map(|w| &w.fields);
    let readable = schema.positions.get(root).map(|p| &p.properties);
    writable.and_then(|w| w.get(field)).or_else(|| readable.and_then(|r| r.get(field)))
}

/// `declaredTypesIn(program)`: every `type` declaration a program makes, by
/// name, as the closed enum it names — in a `Map`'s order: first
/// declaration's place, last declaration's options.
pub fn declared_types_in(program: &Value) -> Result<IndexMap<String, SchemaFieldType>, String> {
    let statements = program.get("statements").and_then(Value::as_array).ok_or("a program has `statements`")?;
    let mut declared = IndexMap::new();
    for statement in statements {
        if statement.get("kind").and_then(Value::as_str) != Some("type") {
            continue;
        }
        let name = statement.get("name").and_then(Value::as_str).ok_or("a type declaration has a `name`")?;
        let options = statement
            .get("options")
            .and_then(Value::as_array)
            .and_then(|o| o.iter().map(|v| v.as_str().map(String::from)).collect::<Option<Vec<_>>>())
            .ok_or("a type declaration has its `options`")?;
        declared.insert(name.to_string(), FieldType::Composite(Composite::Enum { options, open: None }));
    }
    Ok(declared)
}

/// `unionVariants(members)`: a union's members, de-duplicated and sorted as
/// `<` sorts strings — by UTF-16 units.
pub fn union_variants(members: &[String]) -> Vec<String> {
    let mut seen = indexmap::IndexSet::new();
    for m in members {
        seen.insert(m.clone());
    }
    let mut variants: Vec<String> = seen.into_iter().collect();
    variants.sort_by(|a, b| cmp_utf16(a, b));
    variants
}

/// `unionKey(members)`: a union's identity.
pub fn union_key(members: &[String]) -> String {
    serde_json::to_string(&("union", union_variants(members))).expect("strings always serialise")
}

/// `unionDisplay(members)`.
pub fn union_display(members: &[String]) -> String {
    union_variants(members).join(" | ")
}
