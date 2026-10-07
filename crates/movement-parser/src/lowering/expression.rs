//! The shared `Expression` (packages/shared/expression/types.ts): its 28
//! kinds, the four traversal steps and the list spread — 33 shapes, field
//! names and `type` literals exactly as types.ts spells them.
//!
//! Unlike the parser's trees these are written WITHOUT sorting: each struct
//! declares its fields in the order the TypeScript lowering built the object,
//! so a consumer that walks an object's keys (or stringifies one) sees what
//! it saw before. Absent optionals are omitted, never null.
//!
//! They also read back (`Deserialize`): the engine (crates/movement-engine)
//! evaluates the very JSON the lowering wrote, so the two share one
//! definition of its shape.

use indexmap::IndexMap;
use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

use crate::tree::JsNumber;

/// `static.value`: `string | number | boolean | null`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum StaticValue {
    String(String),
    Number(JsNumber),
    Bool(bool),
    Null,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Expression {
    #[serde(rename = "property")]
    Property {
        #[serde(rename = "propertyTypeId")]
        property_type_id: String,
    },
    #[serde(rename = "edge_property")]
    EdgeProperty {
        #[serde(rename = "propertyTypeId")]
        property_type_id: String,
    },
    #[serde(rename = "static")]
    Static { value: StaticValue },
    #[serde(rename = "llm")]
    Llm {
        prompt: String,
        #[serde(rename = "promptExpression", skip_serializing_if = "Option::is_none")]
        prompt_expression: Option<Box<Expression>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tier: Option<String>,
    },
    #[serde(rename = "meta")]
    Meta { key: String },
    /// `field` is `'created' | 'external_id'` in the type, but the lowering
    /// carries whatever `@parent.…` names, unchecked (the checker refuses it).
    #[serde(rename = "parent_result")]
    ParentResult { field: String },
    #[serde(rename = "action_result")]
    ActionResult {
        #[serde(rename = "nodeId")]
        node_id: String,
        field: String,
    },
    /// As `parent_result`: `@resource.…` is carried unchecked.
    #[serde(rename = "resource")]
    Resource { field: String },
    #[serde(rename = "linked_object")]
    LinkedObject { adapter: String, field: String },
    #[serde(rename = "extract_value")]
    ExtractValue { description: String },
    #[serde(rename = "alias_ref")]
    AliasRef { name: String },
    #[serde(rename = "list")]
    List { elements: Vec<ListElement> },
    #[serde(rename = "object")]
    Object { entries: Vec<ObjectMember> },
    #[serde(rename = "traverse")]
    Traverse {
        #[serde(rename = "aliasRoot", skip_serializing_if = "Option::is_none")]
        alias_root: Option<String>,
        steps: Vec<TraversalStep>,
        expression: Box<Expression>,
    },
    #[serde(rename = "resource_traverse")]
    ResourceTraverse {
        #[serde(skip_serializing_if = "Option::is_none")]
        filter: Option<ResourceFilter>,
        #[serde(rename = "expressionFilter", skip_serializing_if = "Option::is_none")]
        expression_filter: Option<Box<Expression>>,
        expression: Box<Expression>,
    },
    #[serde(rename = "exists")]
    Exists {
        steps: Vec<TraversalStep>,
        #[serde(rename = "where", skip_serializing_if = "Option::is_none")]
        where_: Option<Box<Expression>>,
    },
    #[serde(rename = "arithmetic")]
    Arithmetic { op: ArithmeticOp, left: Box<Expression>, right: Box<Expression> },
    #[serde(rename = "compare")]
    Compare { op: FilterOperator, left: Box<Expression>, right: Box<Expression> },
    #[serde(rename = "logical")]
    Logical { op: LogicalOp, operands: Vec<Expression> },
    #[serde(rename = "not")]
    Not { expression: Box<Expression> },
    #[serde(rename = "negate")]
    Negate { expression: Box<Expression> },
    #[serde(rename = "concat")]
    Concat { parts: Vec<Expression> },
    #[serde(rename = "conditional")]
    Conditional {
        condition: Box<Expression>,
        then: Box<Expression>,
        #[serde(rename = "else")]
        else_: Box<Expression>,
    },
    #[serde(rename = "at")]
    At { expression: Box<Expression>, index: Box<Expression> },
    #[serde(rename = "aggregate")]
    Aggregate {
        #[serde(rename = "fn")]
        fn_: AggregationFunction,
        expression: Box<Expression>,
        #[serde(skip_serializing_if = "Option::is_none")]
        separator: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        #[serde(rename = "orderBy", skip_serializing_if = "Option::is_none")]
        order_by: Option<Box<Expression>>,
        #[serde(rename = "orderDirection", skip_serializing_if = "Option::is_none")]
        order_direction: Option<OrderDirection>,
    },
    #[serde(rename = "function")]
    Function {
        #[serde(rename = "fn")]
        fn_: String,
        args: Vec<Expression>,
    },
    #[serde(rename = "kg_exists")]
    KgExists { query: String, params: Vec<Expression> },
    #[serde(rename = "kg_value")]
    KgValue { query: String, params: Vec<Expression> },
}

impl Expression {
    pub fn stat(value: StaticValue) -> Self {
        Expression::Static { value }
    }

    pub fn static_text(text: impl Into<String>) -> Self {
        Expression::Static { value: StaticValue::String(text.into()) }
    }

    /// The text of a `static` string, as `x.type === 'static' && typeof
    /// x.value === 'string'` reads it.
    pub fn as_static_text(&self) -> Option<&str> {
        match self {
            Expression::Static { value: StaticValue::String(s) } => Some(s),
            _ => None,
        }
    }
}

/// `{ type: 'spread', expression }` — in a list, or an object literal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename = "spread")]
pub struct ListSpread {
    pub expression: Box<Expression>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ListElement {
    Expression(Expression),
    Spread(ListSpread),
}

/// An object entry has no `type`; `isObjectSpread` tells the two apart by it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ObjectMember {
    Entry { key: String, value: Expression },
    Spread(ListSpread),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TraversalStep {
    #[serde(rename = "edge")]
    Edge(EdgeStep),
    #[serde(rename = "linkBack")]
    LinkBack {},
    #[serde(rename = "resource")]
    Resource(ResourceStep),
    #[serde(rename = "meta_edge")]
    MetaEdge(MetaEdgeStep),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EdgeStep {
    #[serde(rename = "edgeTypeId")]
    pub edge_type_id: String,
    pub direction: EdgeDirection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cardinality: Option<Cardinality>,
    /// The formula grammar's `FilterExpression`; the lowering never writes one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<serde_json::Value>,
    #[serde(rename = "expressionFilter", skip_serializing_if = "Option::is_none")]
    pub expression_filter: Option<Box<Expression>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cardinality {
    pub mode: CardinalityMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<JsNumber>,
    #[serde(rename = "orderBy", skip_serializing_if = "Option::is_none")]
    pub order_by: Option<Box<Expression>>,
    #[serde(rename = "orderDirection", skip_serializing_if = "Option::is_none")]
    pub order_direction: Option<OrderDirection>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResourceStep {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<ResourceFilter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cardinality: Option<ResourceCardinality>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResourceCardinality {
    pub mode: CardinalityMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<JsNumber>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MetaEdgeStep {
    #[serde(rename = "metaEdge")]
    pub meta_edge: MetaEdgeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "meta_config")]
    pub config: Option<MetaConfig>,
    #[serde(rename = "expressionFilter", skip_serializing_if = "Option::is_none")]
    pub expression_filter: Option<Box<Expression>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<ResourceFilter>,
}

/// A hop's `{ … }` settings. The TypeScript filled the object key by key in
/// the order the settings were written, so its key order is the source's: an
/// ordered map of the five known keys, with `extra` itself an ordered map.
pub type MetaConfig = IndexMap<&'static str, MetaSetting>;

/// A hop's settings read back key by key, in the order written, each key's
/// value read as the one shape that key holds.
fn meta_config<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<MetaConfig>, D::Error> {
    struct Settings;
    impl<'de> Visitor<'de> for Settings {
        type Value = MetaConfig;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a hop's settings")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<MetaConfig, A::Error> {
            let mut config = MetaConfig::new();
            while let Some(key) = map.next_key::<String>()? {
                let (key, setting) = match key.as_str() {
                    "description" => ("description", MetaSetting::Expression(map.next_value()?)),
                    "plugin" => ("plugin", MetaSetting::Expression(map.next_value()?)),
                    "data" => ("data", MetaSetting::Expressions(map.next_value()?)),
                    "enrichWith" => ("enrichWith", MetaSetting::EnrichWith(map.next_value()?)),
                    "extra" => ("extra", MetaSetting::Extra(map.next_value()?)),
                    other => return Err(de::Error::custom(format!("a hop's settings have no key `{other}`"))),
                };
                config.insert(key, setting);
            }
            Ok(config)
        }
    }
    deserializer.deserialize_map(Settings).map(Some)
}

/// Read back by its key (`meta_config`), never by trying each shape in turn:
/// an `extra` map with a `type` key would otherwise read as an expression.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum MetaSetting {
    Expression(Expression),
    Expressions(Vec<Expression>),
    EnrichWith(Vec<EnrichWithEntry>),
    Extra(IndexMap<String, Expression>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EnrichWithEntry {
    pub transform: Expression,
    pub argument: Expression,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResourceFilter {
    #[serde(rename = "resourceType", skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<String>,
    #[serde(rename = "hasDocument", skip_serializing_if = "Option::is_none")]
    pub has_document: Option<bool>,
    #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(rename = "namePattern", skip_serializing_if = "Option::is_none")]
    pub name_pattern: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArithmeticOp {
    #[serde(rename = "+")]
    Add,
    #[serde(rename = "-")]
    Sub,
    #[serde(rename = "*")]
    Mul,
    #[serde(rename = "/")]
    Div,
    #[serde(rename = "%")]
    Rem,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogicalOp {
    And,
    Or,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AggregationFunction {
    First,
    Last,
    Only,
    Count,
    Sum,
    Avg,
    Min,
    Max,
    Join,
    Collect,
    Sort,
    Llm,
}

impl AggregationFunction {
    /// The `fn` as written in the JSON (`'first'`, …, `'llm'`).
    pub fn id(self) -> &'static str {
        match self {
            AggregationFunction::First => "first",
            AggregationFunction::Last => "last",
            AggregationFunction::Only => "only",
            AggregationFunction::Count => "count",
            AggregationFunction::Sum => "sum",
            AggregationFunction::Avg => "avg",
            AggregationFunction::Min => "min",
            AggregationFunction::Max => "max",
            AggregationFunction::Join => "join",
            AggregationFunction::Collect => "collect",
            AggregationFunction::Sort => "sort",
            AggregationFunction::Llm => "llm",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeDirection {
    Outgoing,
    Incoming,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CardinalityMode {
    All,
    First,
    N,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetaEdgeKind {
    Extract,
    Transform,
    Resources,
}
