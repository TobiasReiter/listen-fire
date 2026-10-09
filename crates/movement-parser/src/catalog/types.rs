//! The catalog's data: the schema types of packages/movement-lang/checker/
//! catalog.ts and the snapshot of service/snapshot.ts, field for field, as
//! the JSON the TypeScript writes them. Absent optionals are omitted, never
//! null. A field the TypeScript does not declare is refused when read: the
//! TypeScript passes such a field through, and dropping it silently would be
//! an answer the two sides disagree on without saying so.
//!
//! Every object keyed by data is a `JsMap`, in the order a JavaScript object
//! holds its keys: schema field order is observable (a diagnostic lists a
//! position's fields in it). Sorted output is only for hashing and
//! comparison (`crate::to_sorted_json`), never the data the checker reads.

use std::ops::{Deref, DerefMut};

use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::tree::JsNumber;
use crate::util::js::object_key_order;

/// How deep catalog JSON may nest. The typed read tries a field type's
/// variants one by one at every level, which costs far more stack per level
/// than a `Value`'s read: about 1,800 levels of `list of` exhausted Node's
/// stack in the WASM (measured 2026-10-07). Real catalog data is a dozen
/// levels deep.
pub const MAX_CATALOG_DEPTH: usize = 256;

/// Catalog data from its text, its nesting bounded by `MAX_CATALOG_DEPTH`.
pub fn read_catalog<'a, T: Deserialize<'a>>(json: &'a str) -> Result<T, String> {
    crate::util::json::from_json_within(json, MAX_CATALOG_DEPTH)
}

/// An object keyed by data, in JavaScript's key order: array-index keys
/// first, ascending, then the rest as written — the order `JSON.parse` gives
/// the TypeScript and every `Object.keys`/`Object.entries` over it sees.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct JsMap<V>(pub IndexMap<String, V>);

impl<V> Deref for JsMap<V> {
    type Target = IndexMap<String, V>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<V> DerefMut for JsMap<V> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl<V> FromIterator<(String, V)> for JsMap<V> {
    fn from_iter<I: IntoIterator<Item = (String, V)>>(iter: I) -> Self {
        let mut map = IndexMap::new();
        for (k, v) in iter {
            map.insert(k, v);
        }
        object_key_order(&mut map);
        JsMap(map)
    }
}

impl<V: Serialize> Serialize for JsMap<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for JsMap<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut map = IndexMap::<String, V>::deserialize(deserializer)?;
        object_key_order(&mut map);
        Ok(JsMap(map))
    }
}

// ── Field value types ──

/// `FieldType`: a bare name, or a tagged collection. One type serves
/// `SchemaFieldType` too — the same JSON, minus the members only the
/// checker's typing builds (a union, a record, a tuple's rest, a dict's
/// shape); `is_schema` says whether a value is one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FieldType {
    Scalar(Scalar),
    Composite(Composite),
}

pub type SchemaFieldType = FieldType;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scalar {
    Text,
    Number,
    Boolean,
    Date,
    Datetime,
    File,
    Json,
    Absent,
}

impl Scalar {
    pub fn name(self) -> &'static str {
        match self {
            Scalar::Text => "text",
            Scalar::Number => "number",
            Scalar::Boolean => "boolean",
            Scalar::Date => "date",
            Scalar::Datetime => "datetime",
            Scalar::File => "file",
            Scalar::Json => "json",
            Scalar::Absent => "absent",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Composite {
    List {
        of: Box<FieldType>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unordered: Option<bool>,
    },
    Tuple {
        of: Vec<Option<FieldType>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rest: Option<TupleRest>,
    },
    Dict {
        of: Box<FieldType>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shape: Option<JsMap<Option<FieldType>>>,
    },
    Enum {
        options: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        open: Option<OpenEnum>,
    },
    MaybeAbsent {
        of: Box<FieldType>,
    },
    Union {
        of: Vec<FieldType>,
    },
    /// `position` is the typing layer's `PositionTypeRef`, which this crate
    /// does not model yet; it is carried, not read.
    Record {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        position: Option<Value>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TupleRest {
    pub at: JsNumber,
    pub of: Option<Box<FieldType>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenEnum {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_pattern: Option<String>,
}

impl FieldType {
    /// Whether an adapter surface could declare this (`SchemaFieldType`).
    pub fn is_schema(&self) -> bool {
        match self {
            FieldType::Scalar(_) => true,
            FieldType::Composite(c) => match c {
                Composite::List { of, .. } | Composite::MaybeAbsent { of } => of.is_schema(),
                Composite::Dict { of, shape } => shape.is_none() && of.is_schema(),
                Composite::Tuple { of, rest } => rest.is_none() && of.iter().flatten().all(FieldType::is_schema),
                Composite::Enum { .. } => true,
                Composite::Union { .. } | Composite::Record { .. } => false,
            },
        }
    }
}

// ── Capabilities (packages/shared/expression/types.ts) ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PushMode {
    Bounded,
    Native,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NaturalOrder {
    pub field: String,
    pub direction: Direction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EdgeCapability {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<PushMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<PushMode>,
    pub supports_limit: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub natural_order: Option<NaturalOrder>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FilterOperator {
    Eq,
    Neq,
    Contains,
    Gt,
    Gte,
    Lt,
    Lte,
    Exists,
    In,
    Within,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldCapability {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter_operators: Option<Vec<FilterOperator>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orderable: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeSequencing {
    Chronological,
    Document,
    Arrival,
}

// ── Per-instance schema ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnNonLiteral {
    Error,
    Warn,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenericOver {
    pub field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_non_literal: Option<OnNonLiteral>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EdgeSchema {
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub polymorphic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability: Option<EdgeCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequenced: Option<EdgeSequencing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ephemeral: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linkable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_live_record: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub awaitable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolves_empty: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watchable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generic_over: Option<GenericOver>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PositionSchema {
    pub properties: JsMap<SchemaFieldType>,
    pub edges: JsMap<EdgeSchema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub property_capabilities: Option<JsMap<FieldCapability>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_properties: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undescribed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_only_properties: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ambiguous_properties: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiscriminatedWriteShape {
    pub discriminant: String,
    pub variants: JsMap<WritableRootSchema>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriteUnionVariant {
    pub name: String,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriteUnionShape {
    pub variants: Vec<WriteUnionVariant>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequiredEdge {
    pub edge: String,
    pub from: String,
}

/// `fuzzyResolution`: `true`, or the fields fuzzy resolution may match on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FuzzyResolution {
    All(bool),
    Fields(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WritableRootSchema {
    pub fields: JsMap<SchemaFieldType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discriminated: Option<DiscriminatedWriteShape>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_union: Option<WriteUnionShape>,
    pub result_shape: JsMap<SchemaFieldType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_uniqueness: Option<Vec<Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_edges: Option<Vec<RequiredEdge>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edges: Option<JsMap<EdgeSchema>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_fields: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_docs: Option<JsMap<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fuzzy_resolution: Option<FuzzyResolution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uniqueness_authorable: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CollectionSchema {
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability: Option<EdgeCapability>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventPosition {
    pub position: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstanceSchema {
    pub positions: JsMap<PositionSchema>,
    pub collections: JsMap<CollectionSchema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unions: Option<JsMap<Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub union_display_names: Option<JsMap<String>>,
    pub writable_roots: JsMap<WritableRootSchema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_shapes: Option<JsMap<WritableRootSchema>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_in_place_update: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edges_carry_properties: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refinements: Option<JsMap<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_members: Option<JsMap<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrow_by: Option<JsMap<Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generic_landings: Option<JsMap<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_position: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_positions: Option<Vec<EventPosition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_narrowing_keys: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_narrowing_values: Option<JsMap<JsMap<Vec<String>>>>,
}

// ── Adapters, credentials, plugins ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArgKind {
    Credential,
    Position,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConstructionArg {
    pub name: String,
    pub kind: ArgKind,
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options_from_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectAction {
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TriggerConfigFormat {
    Cron,
    Timezone,
    Fields,
    Strings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Connect {
    Oauth,
    KeyEntry,
    Intrinsic,
    Handshake,
    AppOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SchemaShape {
    Static,
    Introspected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdapterSpec {
    pub construction_args: Vec<ConstructionArg>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_fire: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_config: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_config_options: Option<JsMap<Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_events: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_config_required: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_config_required_why: Option<JsMap<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_config_formats: Option<JsMap<TriggerConfigFormat>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect_actions: Option<Vec<ConnectAction>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect: Option<Connect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_expectation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_shape: Option<SchemaShape>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CredentialSpec {
    pub adapters: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeclaredEffectRow {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reads: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub now: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suspend: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginFedArg {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum PluginOutput {
    Value {
        #[serde(rename = "type")]
        type_: SchemaFieldType,
    },
    Record {
        fields: JsMap<SchemaFieldType>,
    },
    Records {
        fields: JsMap<SchemaFieldType>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EarlierOutput {
    pub before: u32,
    pub output: PluginOutput,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSpec {
    pub args: Vec<String>,
    /// Whether invoking it may cost money: the engine refuses to start a
    /// priced plugin once the run has spent its cost cap.
    pub priced: bool,
    /// What each argument takes, by name: the plugin's declared input types.
    /// The checker reads them; nothing here does yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arg_types: Option<JsMap<SchemaFieldType>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effects: Option<DeclaredEffectRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fed_by_extraction: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fed_args: Option<Vec<PluginFedArg>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<PluginOutput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub earlier_outputs: Option<Vec<EarlierOutput>>,
}

// ── The snapshot (service/snapshot.ts) ──

/// `AdapterSnapshot`: the spec, plus what only a snapshot carries. Read by
/// taking the snapshot's three members out and reading the rest as the spec,
/// which is how `fromCatalogSnapshot` answers `adapter(name)` — by
/// subtraction.
#[derive(Debug, Clone, PartialEq)]
pub struct AdapterSnapshot {
    pub spec: AdapterSpec,
    pub schemas: JsMap<InstanceSchema>,
    pub schema_notes: Option<JsMap<Vec<String>>>,
    pub construction_arg_options: Option<JsMap<JsMap<Vec<String>>>>,
}

impl<'de> Deserialize<'de> for AdapterSnapshot {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        use serde_json::value::RawValue;
        // Raw, so every member's maps keep the order the text has them in.
        let mut members = IndexMap::<String, Box<RawValue>>::deserialize(deserializer)?;
        fn read<T: serde::de::DeserializeOwned, E: Error>(raw: Box<RawValue>) -> Result<T, E> {
            read_catalog(raw.get()).map_err(E::custom)
        }
        let schemas = members.shift_remove("schemas").ok_or_else(|| D::Error::missing_field("schemas"))?;
        let schema_notes = members.shift_remove("schemaNotes");
        let construction_arg_options = members.shift_remove("constructionArgOptions");
        let spec: Vec<String> = members
            .iter()
            .map(|(k, v)| format!("{}:{}", serde_json::to_string(k).expect("a key always serialises"), v.get()))
            .collect();
        Ok(AdapterSnapshot {
            schemas: read(schemas)?,
            schema_notes: schema_notes.map(read).transpose()?,
            construction_arg_options: construction_arg_options.map(read).transpose()?,
            spec: read_catalog(&format!("{{{}}}", spec.join(","))).map_err(D::Error::custom)?,
        })
    }
}

/// A snapshot's credential: the multi-adapter form, or the legacy
/// single-adapter one. Each form refuses members it does not declare.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SnapshotCredential {
    Adapters(CredentialSpec),
    Adapter(LegacyCredential),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyCredential {
    pub adapter: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotFile {
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogSnapshot {
    /// The contract version the builder wrote it under
    /// (docs/contracts/catalog-snapshot.md); absent reads as 1.
    #[serde(default, rename = "contractVersion")]
    pub contract_version: Option<u32>,
    pub adapters: JsMap<AdapterSnapshot>,
    pub credentials: JsMap<SnapshotCredential>,
    pub plugins: JsMap<PluginSpec>,
    #[serde(default)]
    pub files: Option<JsMap<SnapshotFile>>,
    #[serde(default)]
    pub models: Option<Vec<String>>,
}
