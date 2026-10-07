//! `catalog_query`: one lookup or helper call, from JSON to JSON, with no
//! state kept between calls — the snapshot comes with every query.
//!
//! The query is `{op, …}`; the answer `{"value": …}`, or `{}` where the
//! TypeScript answers `undefined`. Both directions keep the data's order (a
//! schema's fields as the snapshot holds them): inputs are read from their
//! text into their own types, never through a `serde_json::Value`, whose maps
//! are sorted; a comparison canonicalises.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;

use super::helpers;
use super::snapshot::{Args, instance_schema_key};
use super::types::{CatalogSnapshot, ConstructionArg, FieldType, InstanceSchema, read_catalog};
use crate::util::json::from_json;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Query<'a> {
    op: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    adapter: Option<String>,
    #[serde(default)]
    arg: Option<String>,
    #[serde(default)]
    credential_name: Option<String>,
    #[serde(default, borrow)]
    args: Option<&'a RawValue>,
}

/// The answer's JSON (`Ok`), or `{"error": {"message"}}` (`Err`).
pub fn query_json(snapshot: &str, query: &str) -> Result<Vec<u8>, Vec<u8>> {
    let error = |message: String| {
        serde_json::to_vec(&serde_json::json!({ "error": { "message": message } })).expect("a Value always serialises")
    };
    let query: Query = from_json(query).map_err(|e| error(format!("the query does not read: {e}")))?;
    let answer = if query.op == "helper" {
        helper(&query)
    } else {
        let snapshot = CatalogSnapshot::load(snapshot).map_err(|e| error(format!("the snapshot does not read: {e}")))?;
        lookup(&snapshot, &query)
    };
    match answer {
        Ok(Some(value)) => Ok(format!(r#"{{"value":{value}}}"#).into_bytes()),
        Ok(None) => Ok(b"{}".to_vec()),
        Err(message) => Err(error(message)),
    }
}

/// The answer's JSON, written straight from the typed data: through a
/// `serde_json::Value` its maps would come out sorted.
type Answer = Result<Option<String>, String>;

fn value<T: Serialize>(v: T) -> String {
    serde_json::to_string(&v).expect("catalog data always serialises")
}

fn some<T: Serialize>(v: Option<T>) -> Answer {
    Ok(v.map(value))
}

fn required<'q>(v: &'q Option<String>, key: &str) -> Result<&'q str, String> {
    v.as_deref().ok_or_else(|| format!("the query has no string `{key}`"))
}

/// A catalog argument from its text, bounded by `MAX_CATALOG_DEPTH`.
fn decode<'a, T: Deserialize<'a>>(raw: &'a RawValue, what: &str) -> Result<T, String> {
    read_catalog(raw.get()).map_err(|e| format!("{what} does not read: {e}"))
}

/// A refinement's filter: a lowered expression, as deep as a chain may make
/// one, read as a `Value` (whose read a deeper bound suits).
fn decode_value(raw: &RawValue, what: &str) -> Result<Value, String> {
    from_json(raw.get()).map_err(|e| format!("{what} does not read: {e}"))
}

fn lookup(snapshot: &CatalogSnapshot, query: &Query) -> Answer {
    match query.op.as_str() {
        "instantiate" => {
            let args: Args = match query.args {
                Some(raw) => decode(raw, "the arguments")?,
                None => Args::default(),
            };
            some(snapshot.instantiate(required(&query.adapter, "adapter")?, &args))
        }
        "adapter" => some(snapshot.adapter(required(&query.name, "name")?)),
        "credential" => some(snapshot.credential(required(&query.name, "name")?)),
        "credentialNames" => Ok(Some(value(snapshot.credential_names()))),
        "plugin" => some(snapshot.plugin(required(&query.name, "name")?)),
        "models" => some(snapshot.models()),
        "constructionArgOptions" => some(snapshot.construction_arg_options(
            required(&query.adapter, "adapter")?,
            query.credential_name.as_deref(),
            required(&query.arg, "arg")?,
        )),
        other => Err(format!("no catalog op `{other}`")),
    }
}

/// What `credentialArgOf` and `entryPositionKeyOf` read of a spec.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Signature {
    construction_args: Vec<ConstructionArg>,
}

#[derive(Deserialize)]
struct Refinement<'a> {
    #[serde(rename = "type")]
    type_: String,
    #[serde(borrow)]
    filter: &'a RawValue,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaKeyInput {
    #[serde(default)]
    credential_name: Option<String>,
    #[serde(default)]
    position_key: Option<String>,
}

/// `{op: "helper", name, args: [...]}`: a helper called with its arguments as
/// the TypeScript passed them (an `undefined` written as `null`).
fn helper(query: &Query) -> Answer {
    let name = required(&query.name, "name")?;
    let raw = query.args.ok_or("a helper query has `args`")?;
    // The list itself at the deeper bound: a refinement's filter rides in it.
    let args: Vec<&RawValue> = from_json(raw.get()).map_err(|e| format!("the helper's arguments do not read: {e}"))?;
    let null = RawValue::NULL;
    let arg = |i: usize| args.get(i).copied().unwrap_or(null);
    let text = |i: usize| decode::<Option<String>>(arg(i), "a text argument");
    match name {
        "parseFieldTypeName" => some(helpers::parse_field_type_name(text(0)?.as_deref())),
        "describeFieldType" => Ok(Some(value(helpers::describe_field_type(&decode::<FieldType>(arg(0), "the type")?)?))),
        "variantOf" => Ok(Some(value(helpers::variant_of(&decode::<FieldType>(arg(0), "the type")?)))),
        "refinementKey" => {
            let input: Refinement =
                from_json(arg(0).get()).map_err(|e| format!("the refinement does not read: {e}"))?;
            let filter = decode_value(input.filter, "the filter")?;
            Ok(Some(value(helpers::refinement_key(&input.type_, &filter))))
        }
        "borrowedTypeSegments" => some(helpers::borrowed_type_segments(text(0)?.as_deref())),
        "resolveBorrowedField" => {
            let schema: InstanceSchema = decode(arg(0), "the schema")?;
            let (root, field) = (text(1)?.unwrap_or_default(), text(2)?.unwrap_or_default());
            some(helpers::resolve_borrowed_field(&schema, &root, &field))
        }
        "declaredTypesIn" => {
            let program = decode_value(arg(0), "the program")?;
            Ok(Some(value(helpers::declared_types_in(&program)?.into_iter().collect::<Vec<_>>())))
        }
        "credentialArgOf" => {
            let spec: Signature = decode(arg(0), "the spec")?;
            some(helpers::first_credential_arg(&spec.construction_args))
        }
        "entryPositionKeyOf" => {
            let spec: Signature = decode(arg(0), "the spec")?;
            let args: Option<Args> = decode(arg(1), "the arguments")?;
            Ok(Some(value(helpers::position_key(&spec.construction_args, args.as_ref()))))
        }
        "unwrapCredentialArg" => Ok(Some(value(helpers::unwrap_credential_arg(&text(0)?.unwrap_or_default())))),
        "unionVariants" => Ok(Some(value(helpers::union_variants(&decode::<Vec<String>>(arg(0), "the members")?)))),
        "unionKey" => Ok(Some(value(helpers::union_key(&decode::<Vec<String>>(arg(0), "the members")?)))),
        "unionDisplay" => Ok(Some(value(helpers::union_display(&decode::<Vec<String>>(arg(0), "the members")?)))),
        "instanceSchemaKey" => {
            let input: SchemaKeyInput = decode(arg(0), "the instance")?;
            Ok(Some(value(instance_schema_key(input.credential_name.as_deref(), input.position_key.as_deref()))))
        }
        other => Err(format!("no catalog helper `{other}`")),
    }
}
