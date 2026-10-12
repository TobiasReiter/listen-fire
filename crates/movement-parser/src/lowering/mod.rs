//! Lowering: the movement expression tree (`crate::tree`) → the shared
//! `Expression` (packages/shared/expression/types.ts) that the checker, the
//! engine, the web app's formula input and every adapter's filter pushdown
//! read. This is where a NAME first means something: `COUNT` becomes an
//! aggregate, `AI` an llm node, `EXISTS` a quantifier, `CURRENCY.PARSE` a
//! stdlib function.
//!
//! A port of packages/movement-lang/parser/expression/lower.ts, rule by rule
//! and refusal by refusal: the TypeScript is now a wrapper over this. The
//! order in which sub-expressions are lowered is the TypeScript's too, so a
//! text with two faults is refused for the same one. It reproduces the old
//! text-rewriting bridge apart from four of its defects, fixed under every
//! language version: an `if` condition binds AND tighter than OR, an
//! `IF … AND … END` reads whole, a walk inside `EXISTS(…)` reads its own
//! interpolations and nested `EXISTS`, and an empty hop `WHERE` is refused. A
//! bare walk is the records it lands on wherever a value goes.

mod call_shape;
pub mod condition;
pub mod expression;
mod read;
mod vocabulary;

use std::borrow::Cow;

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

use crate::tree::{
    Arrow, BinaryOp, CHAIN_TOO_LONG, CallArg, Direction, Hop, LiteralValue, MExpr, MapLiteral, MapMember, Name, SortDirection,
    StringPart, UnaryOp,
};
use crate::util::js;
use crate::util::utf16::{self, Utf16};
pub use condition::MovementCondition;
use expression::{
    AggregationFunction, ArithmeticOp, Cardinality, CardinalityMode, EdgeDirection, EdgeStep, EnrichWithEntry,
    Expression, FilterOperator, ListElement, ListSpread, LogicalOp, MetaConfig, MetaEdgeKind, MetaEdgeStep, MetaSetting,
    ObjectMember, OrderDirection, StaticValue, TraversalStep,
};
use vocabulary::vocabulary;

/// Terminal property id meaning "the landings themselves": a bare walk
/// (`orgs-[:co]->`) lowers to a traverse ending in a read of this property.
pub const POSITION_SENTINEL: &str = "__movement_position__";

/// The name a walk is probed with to read its steps (`EXISTS(walk)`).
const EXISTS_PROBE: &str = "__movement_exists_probe__";

/// Why a tree has no lowering: the TypeScript's `LoweringError(message,
/// code?)`, or — for a built-in call's static shape — its `BridgeError`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoweringRefusal {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "RefusalClass::is_lowering")]
    pub class: RefusalClass,
}

/// Which TypeScript error class the refusal is rewrapped in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum RefusalClass {
    #[serde(rename = "LoweringError")]
    Lowering,
    /// A built-in call's static shape: a plain `BridgeError`, as the
    /// TypeScript's expression/call_shape.ts threw it.
    #[serde(rename = "BridgeError")]
    CallShape,
}

impl RefusalClass {
    fn is_lowering(&self) -> bool {
        *self == RefusalClass::Lowering
    }
}

impl LoweringRefusal {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: None, class: RefusalClass::Lowering }
    }

    pub fn with_code(message: impl Into<String>, code: &str) -> Self {
        Self { message: message.into(), code: Some(code.into()), class: RefusalClass::Lowering }
    }

    pub fn call_shape(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: None, class: RefusalClass::CallShape }
    }
}

pub type Lowered<T> = Result<T, LoweringRefusal>;

fn refuse<T>(message: impl Into<String>) -> Lowered<T> {
    Err(LoweringRefusal::new(message))
}

/// Lower one expression; `source` is the text `tree` was parsed from.
pub fn lower_expression(tree: &MExpr, source: &str) -> Lowered<Expression> {
    Lowering::new(source).lower(tree, TOP)
}

/// Lower one `if` condition into its top-level `AND` conjuncts, each an `IS`
/// type guard or an expression.
pub fn lower_condition(tree: &MExpr, source: &str) -> Lowered<MovementCondition> {
    Lowering::new(source).condition(tree)
}

/// Which entry point a JSON call is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Expression,
    Condition,
}

/// The ABI's lowering: a tree as JSON in, the lowered value's JSON out
/// (`Ok`), or `{"error": {message, code?, class?}}` (`Err`). The output keeps
/// the TypeScript's key order rather than sorting. A tree that does not
/// deserialise is the caller's fault, and says so with `class:
/// "MalformedTree"`. A chain past `MAX_CHAIN` is refused before it is
/// lowered, as the parser refuses it: the lowering recurses per level.
pub fn lower_json_bytes(tree_json: &str, source: &str, mode: Mode) -> Result<Vec<u8>, Vec<u8>> {
    let tree = match read::read_tree(tree_json) {
        Ok(tree) => tree,
        Err(reason) => {
            let message = format!("the lowering was handed a tree it cannot read: {reason}");
            let error = serde_json::json!({ "error": { "message": message, "class": "MalformedTree" } });
            return Err(serde_json::to_vec(&error).expect("a Value always serialises"));
        }
    };
    if tree.chain_overrun().is_some() {
        let refusal = LoweringRefusal::new(CHAIN_TOO_LONG);
        return Err(serde_json::to_vec(&ErrorEnvelope { error: refusal }).expect("a refusal always serialises"));
    }
    let written = match mode {
        Mode::Expression => lower_expression(&tree, source).map(|e| serde_json::to_vec(&e)),
        Mode::Condition => lower_condition(&tree, source).map(|c| serde_json::to_vec(&c)),
    };
    match written {
        Ok(bytes) => Ok(bytes.expect("a lowered value always serialises")),
        Err(refusal) => Err(serde_json::to_vec(&ErrorEnvelope { error: refusal }).expect("a refusal always serialises")),
    }
}

#[derive(Serialize)]
struct ErrorEnvelope {
    error: LoweringRefusal,
}

/// `lower_expression` from and to JSON values, for tests and harnesses.
pub fn lower_expression_json(tree: &Value, source: &str) -> Result<Value, Value> {
    lower_value(tree, source, Mode::Expression)
}

/// `lower_condition` from and to JSON values, for tests and harnesses.
pub fn lower_condition_json(tree: &Value, source: &str) -> Result<Value, Value> {
    lower_value(tree, source, Mode::Condition)
}

fn lower_value(tree: &Value, source: &str, mode: Mode) -> Result<Value, Value> {
    let json = serde_json::to_string(tree).expect("a Value always serialises");
    let parse = |bytes: Vec<u8>| -> Value { serde_json::from_slice(&bytes).expect("the lowering writes JSON") };
    match lower_json_bytes(&json, source, mode) {
        Ok(bytes) => Ok(parse(bytes)),
        Err(bytes) => Err(parse(bytes)["error"].take()),
    }
}

/// Where a name is read. Inside a hop's WHERE a bare name is a property of
/// the EDGE's landing (`edge_property`) — the formula grammar's
/// edge-property mode, which everything nested in that WHERE inherits.
#[derive(Debug, Clone, Copy)]
struct Ctx {
    edge_props: bool,
}

const TOP: Ctx = Ctx { edge_props: false };

/// The aggregates by their upper-cased name (`AGG_FNS`).
fn aggregate_fn(upper: &str) -> Option<AggregationFunction> {
    use AggregationFunction as A;
    Some(match upper {
        "FIRST" => A::First,
        "LAST" => A::Last,
        "ONLY" => A::Only,
        "COUNT" => A::Count,
        "SUM" => A::Sum,
        "AVG" => A::Avg,
        "MIN" => A::Min,
        "MAX" => A::Max,
        "JOIN" => A::Join,
        "COLLECT" => A::Collect,
        "LLM_AGG" => A::Llm,
        _ => return None,
    })
}

/// The aggregates whose bare-walk argument takes a property written after
/// the call (`FIRST(orgs-[:co]->).url`). Read with the case folded: a
/// function's name is the same name in any letter case (language version 3),
/// and accepting what the old bridge's case-sensitive regex refused is
/// additive, so it holds under every version.
const BARE_PATH_AGGREGATES: [&str; 12] =
    ["FIRST", "LAST", "ONLY", "COUNT", "SUM", "AVG", "MIN", "MAX", "JOIN", "COLLECT", "SORT", "LLM_AGG"];

/// The `_resources` walk's terminal fields (`RESOURCE_TERMINALS`).
const RESOURCE_TERMINALS: [&str; 5] = ["name", "url", "type", "document_url", "content"];

/// A `_resources` WHERE's field names, lower-cased (`RESOURCE_WHERE_FIELDS`).
fn resource_where_field(lower: &str) -> Option<&'static str> {
    Some(match lower {
        "type" | "resourcetype" => "type",
        "name" => "name",
        "url" => "url",
        "content" => "content",
        "document_url" => "document_url",
        "contenttype" | "mimetype" => "contentType",
        _ => return None,
    })
}

const RESOURCE_TYPES: [&str; 5] = ["URL", "EMAIL", "WHATSAPP", "FILE", "TEXT"];

/// `/^[A-Z][A-Z0-9_]+$/`.
fn namespace_shaped(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() >= 2 && b[0].is_ascii_uppercase() && b[1..].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
}

/// `/^[A-Za-z_][A-Za-z0-9_]*$/`.
fn plain_identifier(text: &str) -> bool {
    let b = text.as_bytes();
    !b.is_empty() && (b[0].is_ascii_alphabetic() || b[0] == b'_') && b[1..].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

enum Segment<'a> {
    Member(&'a Name),
    Call(&'a [CallArg]),
    Hops(&'a [Hop]),
}

/// The meta hops a walk can only END in: `-[:_resources]->` (`#resources` is
/// its legacy spelling, `_resources:TEXT` its type shorthand) and the legacy
/// `-[#linked …]->`. (The TypeScript keeps its own copy, `endingHop`, which
/// the checker calls on TypeScript trees.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ending {
    Resources,
    Linked,
}

fn ending_hop(hop: &Hop) -> Option<Ending> {
    let label = &hop.label.text;
    // `label.split(/[:\s]/, 1)[0]`.
    let units: Vec<u16> = crate::util::form::units_vec(label);
    let cut = units.iter().position(|&u| u == u16::from(b':') || utf16::is_js_space(u)).unwrap_or(units.len());
    let base = utf16::to_string(&units[..cut]);
    if base == "#linked" || label == "#linked" {
        Some(Ending::Linked)
    } else if base == "_resources" || base == "#resources" {
        Some(Ending::Resources)
    } else {
        None
    }
}

/// `-[t:#transform { plugin: … }]->` — the one meta hop whose `{ … }`
/// settings are read.
fn is_transform_hop(hop: &Hop) -> bool {
    hop.label.text == "#transform"
}

enum Connective {
    Logical(LogicalOp),
    Compare(FilterOperator),
    Arithmetic(ArithmeticOp),
}

fn connective(op: BinaryOp) -> Connective {
    use Connective as C;
    match op {
        BinaryOp::Or => C::Logical(LogicalOp::Or),
        BinaryOp::And => C::Logical(LogicalOp::And),
        BinaryOp::Eq => C::Compare(FilterOperator::Eq),
        BinaryOp::Ne => C::Compare(FilterOperator::Neq),
        BinaryOp::Lt => C::Compare(FilterOperator::Lt),
        BinaryOp::Le => C::Compare(FilterOperator::Lte),
        BinaryOp::Gt => C::Compare(FilterOperator::Gt),
        BinaryOp::Ge => C::Compare(FilterOperator::Gte),
        BinaryOp::Contains => C::Compare(FilterOperator::Contains),
        BinaryOp::In => C::Compare(FilterOperator::In),
        BinaryOp::Add => C::Arithmetic(ArithmeticOp::Add),
        BinaryOp::Sub => C::Arithmetic(ArithmeticOp::Sub),
        BinaryOp::Mul => C::Arithmetic(ArithmeticOp::Mul),
        BinaryOp::Div => C::Arithmetic(ArithmeticOp::Div),
        BinaryOp::Rem => C::Arithmetic(ArithmeticOp::Rem),
    }
}

fn combine(op: BinaryOp, left: Expression, right: Expression) -> Expression {
    match connective(op) {
        // The formula grammar folds a left operand that is already the same
        // connective — parenthesised or not — into one flat list.
        Connective::Logical(op) => match left {
            Expression::Logical { op: inner, mut operands } if inner == op => {
                operands.push(right);
                Expression::Logical { op, operands }
            }
            left => Expression::Logical { op, operands: vec![left, right] },
        },
        Connective::Compare(op) => Expression::Compare { op, left: Box::new(left), right: Box::new(right) },
        Connective::Arithmetic(op) => Expression::Arithmetic { op, left: Box::new(left), right: Box::new(right) },
    }
}

fn is_arithmetic(op: BinaryOp) -> bool {
    matches!(connective(op), Connective::Arithmetic(_))
}

/// The name a call-shaped node answers to (`callTerminalName`).
fn call_terminal_name(expr: &Expression) -> Option<String> {
    match expr {
        Expression::Function { fn_, .. } => Some(fn_.to_uppercase()),
        Expression::Aggregate { fn_: AggregationFunction::Llm, .. } => Some("LLM_AGG".into()),
        Expression::Aggregate { fn_, .. } => Some(fn_.id().to_uppercase()),
        Expression::Llm { .. } => Some("AI".into()),
        Expression::Concat { .. } => Some("CONCAT".into()),
        Expression::KgExists { .. } => Some("KG_EXISTS".into()),
        Expression::KgValue { .. } => Some("KG_VALUE".into()),
        _ => None,
    }
}

fn static_of(value: &LiteralValue) -> StaticValue {
    match value {
        LiteralValue::Number(n) => StaticValue::Number(*n),
        LiteralValue::Bool(b) => StaticValue::Bool(*b),
        LiteralValue::Null(()) => StaticValue::Null,
    }
}

fn kind_of(expr: &MExpr) -> &'static str {
    match expr {
        MExpr::Literal { .. } => "literal",
        MExpr::String { .. } => "string",
        MExpr::Name { .. } => "name",
        MExpr::Special { .. } => "special",
        MExpr::Paren { .. } => "paren",
        MExpr::List { .. } => "list",
        MExpr::Map { .. } => "map",
        MExpr::Member { .. } => "member",
        MExpr::Index { .. } => "index",
        MExpr::Call { .. } => "call",
        MExpr::Path { .. } => "path",
        MExpr::Unary { .. } => "unary",
        MExpr::Binary { .. } => "binary",
        MExpr::Exists { .. } => "exists",
        MExpr::Within { .. } => "within",
        MExpr::Where { .. } => "where",
        MExpr::Is { .. } => "is",
        MExpr::If { .. } => "if",
        MExpr::Type { .. } => "type",
        MExpr::Closure { .. } => "closure",
        MExpr::Node { .. } => "node",
        MExpr::Graph { .. } => "graph",
        MExpr::Declaration { .. } => "declaration",
        MExpr::Mapped { .. } => "mapped",
        MExpr::Lazy { .. } => "lazy",
    }
}

/// `member(object, property)`: a synthetic `.property` read.
fn member(object: &MExpr, property: Name) -> MExpr {
    MExpr::Member { object: Box::new(object.clone()), property, at: object.at() }
}

/// A walk with nothing read off its end, from a plain root, ending `]->`.
fn is_bare_walk(expr: &MExpr) -> bool {
    let MExpr::Path { root, hops, .. } = expr else {
        return false;
    };
    if root.as_deref().is_some_and(|r| !matches!(r, MExpr::Name { .. })) {
        return false;
    }
    hops.last().is_some_and(|last| last.direction == Direction::Out && last.arrow == Arrow::Full)
}

/// The rules. `source` is the text the tree's `at` offsets index, in UTF-16
/// units.
struct Lowering {
    source: Utf16,
}

impl Lowering {
    fn new(source: &str) -> Self {
        Self { source: Utf16::new(source) }
    }

    fn slice(&self, start: usize, end: usize) -> String {
        js::slice(&self.source, start, end)
    }

    // ── Expressions ──

    fn lower(&self, expr: &MExpr, ctx: Ctx) -> Lowered<Expression> {
        Ok(match expr {
            MExpr::Literal { value, .. } => Expression::stat(static_of(value)),
            MExpr::String { parts, .. } => self.string(parts)?,
            MExpr::Name { name, .. } => self.leaf(name, ctx)?,
            MExpr::Special { text, .. } => {
                // `text.slice(1)`: the `@` is one unit.
                let v = text.get(1..).unwrap_or("");
                // The formula grammar carries these fields unchecked; mirrored
                // as-is. Language version 3 retires both reads (the checker's
                // MOV_PARENT_READ_RETIRED and MOV_RESOURCE_READ_RETIRED).
                if let Some(field) = v.strip_prefix("parent.") {
                    Expression::ParentResult { field: field.into() }
                } else if let Some(field) = v.strip_prefix("resource.") {
                    Expression::Resource { field: field.into() }
                } else {
                    Expression::Meta { key: v.into() }
                }
            }
            MExpr::Paren { expr, .. } => self.lower(expr, ctx)?,
            MExpr::List { elements, .. } => Expression::List {
                elements: elements
                    .iter()
                    .map(|e| self.list_element(e, |x| self.lower(x, ctx)))
                    .collect::<Lowered<_>>()?,
            },
            MExpr::Map { entries, .. } => Expression::Object {
                entries: entries
                    .iter()
                    .map(|e| {
                        Ok(match e {
                            MapMember::Spread(s) => ObjectMember::Spread(ListSpread { expression: Box::new(self.lower(&s.expr, ctx)?) }),
                            MapMember::Entry { key, value } => {
                                ObjectMember::Entry { key: map_key_text(key).into(), value: self.lower(value, ctx)? }
                            }
                        })
                    })
                    .collect::<Lowered<_>>()?,
            },
            MExpr::Member { .. } | MExpr::Call { .. } | MExpr::Path { .. } => self.chain(expr, ctx)?,
            MExpr::Index { .. } => return refuse("an index read `x[i]` is written AT(x, i)"),
            MExpr::Unary { op, operand, .. } => {
                let expression = Box::new(self.lower(operand, ctx)?);
                match op {
                    UnaryOp::Not => Expression::Not { expression },
                    UnaryOp::Neg => Expression::Negate { expression },
                }
            }
            MExpr::Binary { op, left, right, .. } => {
                let left = self.lower(left, ctx)?;
                combine(*op, left, self.lower(right, ctx)?)
            }
            MExpr::Exists { operand, .. } => Expression::Compare {
                op: FilterOperator::Exists,
                left: Box::new(self.lower(operand, ctx)?),
                right: Box::new(Expression::stat(StaticValue::Bool(true))),
            },
            MExpr::Within { operand, duration, .. } => {
                let value = if duration.quoted { duration.text.clone() } else { js::lowercase_last_unit(&duration.text) };
                Expression::Compare {
                    op: FilterOperator::Within,
                    left: Box::new(self.lower(operand, ctx)?),
                    right: Box::new(Expression::static_text(value)),
                }
            }
            MExpr::Where { .. } => {
                return refuse("WHERE filters a walk inside EXISTS(…) or a hop — it is not a value on its own");
            }
            MExpr::Is { .. } => return refuse("IS type tests are only recognised as top-level conjuncts of a condition"),
            MExpr::If { condition, then, else_, .. } => {
                let condition = Box::new(self.lower(condition, ctx)?);
                let then = Box::new(self.lower(then, ctx)?);
                let else_ = Box::new(match else_ {
                    Some(e) => self.lower(e, ctx)?,
                    None => Expression::static_text(""),
                });
                Expression::Conditional { condition, then, else_ }
            }
            MExpr::Closure { .. } => {
                return Err(LoweringRefusal::with_code(
                    "a closure cannot be written here — bind it to a name first and pass the name",
                    CLOSURE_POSITION_CODE,
                ));
            }
            MExpr::Type { .. }
            | MExpr::Node { .. }
            | MExpr::Graph { .. }
            | MExpr::Declaration { .. }
            | MExpr::Mapped { .. }
            | MExpr::Lazy { .. } => {
                return refuse(format!("a {} is not a value the shared expression tree can hold", kind_of(expr)));
            }
        })
    }

    fn list_element(
        &self,
        element: &crate::tree::ListElement,
        lower: impl Fn(&MExpr) -> Lowered<Expression>,
    ) -> Lowered<ListElement> {
        Ok(match element {
            crate::tree::ListElement::Spread(s) => ListElement::Spread(ListSpread { expression: Box::new(lower(&s.expr)?) }),
            crate::tree::ListElement::Expr(e) => ListElement::Expression(lower(e)?),
        })
    }

    /// A quoted string: a literal, or — with `${…}` — a concat whose holes
    /// are each a slot of their own: a hole in a hop WHERE reads a property,
    /// not an edge property.
    fn string(&self, parts: &[StringPart]) -> Lowered<Expression> {
        if parts.iter().all(|p| matches!(p, StringPart::Text(_))) {
            let text: String = parts
                .iter()
                .map(|p| match p {
                    StringPart::Text(t) => t.as_str(),
                    StringPart::Expr(_) => "",
                })
                .collect();
            return Ok(Expression::static_text(text));
        }
        let parts = parts
            .iter()
            .filter(|p| !matches!(p, StringPart::Text(t) if t.is_empty()))
            .map(|p| match p {
                StringPart::Text(t) => Ok(Expression::static_text(t.clone())),
                StringPart::Expr(e) => self.lower(e, TOP),
            })
            .collect::<Lowered<_>>()?;
        Ok(Expression::Concat { parts })
    }

    fn leaf(&self, name: &Name, ctx: Ctx) -> Lowered<Expression> {
        refuse_retired(name)?;
        let property_type_id = name.text.clone();
        Ok(if ctx.edge_props { Expression::EdgeProperty { property_type_id } } else { Expression::Property { property_type_id } })
    }

    // ── Chains: names, members, calls, walks ──
    //
    // The tree is left-nested, as postfix syntax is (`a.b.c` = member(member(a,
    // b), c)). The formula grammar's tree is right-nested from each root
    // (`traverse{a, expression: traverse{b, expression: c}}`), so a chain is
    // flattened to its segments and rebuilt from the left.

    fn chain(&self, expr: &MExpr, ctx: Ctx) -> Lowered<Expression> {
        let mut segments: Vec<Segment> = Vec::new();
        let mut head: Option<&MExpr> = Some(expr);
        while let Some(h) = head {
            match h {
                MExpr::Member { object, property, .. } => {
                    segments.push(Segment::Member(property));
                    head = Some(object);
                }
                MExpr::Call { callee, args, .. } => {
                    segments.push(Segment::Call(args));
                    head = Some(callee);
                }
                MExpr::Path { root, hops, .. } => {
                    segments.push(Segment::Hops(hops));
                    head = root.as_deref();
                }
                _ => break,
            }
        }
        segments.reverse();
        let Some(head) = head else {
            return match segments.split_first() {
                Some((Segment::Hops(hops), rest)) => self.traversal(None, hops, rest, ctx),
                _ => refuse("a walk starts at a name or at a hop"),
            };
        };
        let MExpr::Name { name, .. } = head else {
            return refuse(format!("'.', a call or a hop can only follow a name — not a {}", kind_of(head)));
        };
        self.from_name(name, &segments, ctx, false)
    }

    /// `scoped`: this name is the member of a dot-chain (`DATETIME.AT(…)`),
    /// so a call here is named inside its root and is none of the bare
    /// built-ins.
    fn from_name(&self, name: &Name, segments: &[Segment], ctx: Ctx, scoped: bool) -> Lowered<Expression> {
        let Some((first, rest)) = segments.split_first() else {
            return self.leaf(name, ctx);
        };
        match first {
            Segment::Call(args) => {
                let (expression, consumed) = self.call(name, args, rest, ctx, scoped)?;
                if rest.len() > consumed {
                    return refuse(format!("Unexpected '.' after the call {}(…)", name.text));
                }
                Ok(expression)
            }
            Segment::Member(property) => {
                if name.text.to_lowercase() == "edge" {
                    if !rest.is_empty() {
                        return refuse("edge.<property> reads one property of the walked edge");
                    }
                    return Ok(Expression::EdgeProperty { property_type_id: property.text.clone() });
                }
                let expression = self.from_name(property, rest, ctx, true)?;
                self.fold_namespace(Some(name.text.clone()), Vec::new(), expression)
            }
            Segment::Hops(hops) => self.traversal(Some(&name.text), hops, rest, ctx),
        }
    }

    /// A walk, then the `.terminal` the formula grammar requires after it.
    fn traversal(&self, alias_root: Option<&str>, hops: &[Hop], rest: &[Segment], ctx: Ctx) -> Lowered<Expression> {
        let mut steps: Vec<TraversalStep> = Vec::new();
        for (i, hop) in hops.iter().enumerate() {
            let label = &hop.label.text;
            if label == "#extract" {
                return refuse(
                    "The #extract meta-edge is retired (syntax amendment 4): extraction is not a traversal — use an `extract … { }` materialisation and traverse its result graph",
                );
            }
            if is_transform_hop(hop) {
                let config = match &hop.config {
                    Some(config) => self.meta_config(config, ctx)?,
                    None => None,
                };
                steps.push(TraversalStep::MetaEdge(MetaEdgeStep {
                    meta_edge: MetaEdgeKind::Transform,
                    alias: hop.alias.as_ref().map(|a| a.text.clone()),
                    config,
                    expression_filter: None,
                    filter: None,
                }));
                continue;
            }
            if let Some(ending) = ending_hop(hop) {
                if i != hops.len() - 1 {
                    return refuse(format!("a hop cannot follow -[:{label}]->"));
                }
                let inner = match ending {
                    Ending::Linked => self.linked(hop, rest)?,
                    Ending::Resources => self.resources(hop, rest, ctx)?,
                };
                // The formula grammar drops the root of a walk that ends in a
                // resource or linked hop — reproduced, not endorsed. Language
                // version 3 refuses a resource walk that would lose something
                // here (the checker's MOV_RESOURCE_WALK_UNREAD), and every
                // linked hop (MOV_LINKED_HOP_RETIRED).
                return Ok(if steps.is_empty() {
                    inner
                } else {
                    Expression::Traverse { alias_root: None, steps, expression: Box::new(inner) }
                });
            }
            steps.push(TraversalStep::Edge(self.edge_step(hop, ctx)?));
        }
        let expression = match rest.split_first() {
            None => {
                // A bare walk is the records it lands on, wherever a value goes.
                let last = hops.last().expect("a path has at least one hop");
                if last.direction != Direction::Out || last.arrow != Arrow::Full {
                    return refuse("a walk written as a value ends in ']->', or reads a '.property' after it");
                }
                self.leaf(&Name { text: POSITION_SENTINEL.into(), quoted: true, at: last.at }, ctx)?
            }
            Some((Segment::Member(terminal), after)) => self.from_name(terminal, after, ctx, false)?,
            Some(_) => return refuse("Expected '.' after the walk"),
        };
        Ok(Expression::Traverse { alias_root: alias_root.map(String::from), steps, expression: Box::new(expression) })
    }

    fn edge_step(&self, hop: &Hop, ctx: Ctx) -> Lowered<EdgeStep> {
        if hop.direction == Direction::In && hop.alias.is_some() {
            return refuse("an incoming hop takes no alias (`<-[:edge]-`)");
        }
        let cardinality = if hop.order_by.is_some() || hop.limit.is_some() {
            let (order_by, order_direction) = match &hop.order_by {
                Some(order) => (
                    Some(Box::new(self.lower(&order.key, ctx)?)),
                    Some(match order.direction {
                        Some(SortDirection::Desc) => OrderDirection::Desc,
                        Some(SortDirection::Asc) | None => OrderDirection::Asc,
                    }),
                ),
                None => (None, None),
            };
            Some(Cardinality {
                mode: if hop.limit.is_some() { CardinalityMode::N } else { CardinalityMode::All },
                limit: hop.limit,
                order_by,
                order_direction,
            })
        } else {
            None
        };
        let expression_filter = match &hop.where_ {
            Some(w) => Some(Box::new(self.lower(w, Ctx { edge_props: true })?)),
            None => None,
        };
        // A config `{ … }` on a plain edge hop is dropped by the formula
        // grammar; language version 3 refuses it (the checker's
        // MOV_HOP_CONFIG_UNREAD).
        Ok(EdgeStep {
            edge_type_id: hop.label.text.clone(),
            direction: if hop.direction == Direction::In { EdgeDirection::Incoming } else { EdgeDirection::Outgoing },
            alias: hop.alias.as_ref().map(|a| a.text.clone()),
            cardinality,
            filter: None,
            expression_filter,
        })
    }

    fn resources(&self, hop: &Hop, rest: &[Segment], ctx: Ctx) -> Lowered<Expression> {
        let label = &hop.label.text;
        let type_val = label.find(':').map(|colon| js::trim(&label[colon + 1..]).to_uppercase());
        let shorthand = type_val.filter(|t| RESOURCE_TYPES.contains(&t.as_str())).map(|t| Expression::Compare {
            op: FilterOperator::Eq,
            left: Box::new(Expression::Resource { field: "type".into() }),
            right: Box::new(Expression::static_text(t)),
        });
        let where_ = match &hop.where_ {
            Some(w) => Some(self.resource_predicate(w)?),
            None => None,
        };
        let expression_filter = match (shorthand, where_) {
            (Some(s), Some(w)) => Some(Expression::Logical { op: LogicalOp::And, operands: vec![s, w] }),
            (s, w) => s.or(w),
        };
        let Some((Segment::Member(terminal), after)) = rest.split_first() else {
            return refuse("Expected '.' after the resource hop");
        };
        let expression = match RESOURCE_TERMINALS.iter().find(|f| **f == terminal.text) {
            Some(field) => {
                if !after.is_empty() {
                    return refuse(format!("Unexpected '.' after the resource field {}", terminal.text));
                }
                Expression::Resource { field: (*field).into() }
            }
            None => self.from_name(terminal, after, ctx, false)?,
        };
        Ok(Expression::ResourceTraverse { filter: None, expression_filter: expression_filter.map(Box::new), expression: Box::new(expression) })
    }

    /// A `_resources` WHERE reads resource fields only.
    fn resource_predicate(&self, expr: &MExpr) -> Lowered<Expression> {
        Ok(match expr {
            MExpr::Name { name, .. } => {
                // The TypeScript looks the name up on a plain object, so
                // `constructor` and `__proto__` find Object.prototype's
                // members there; here they are unknown, as every other name
                // outside the table is (reported for a ruling).
                let Some(field) = resource_where_field(&name.text.to_lowercase()) else {
                    return refuse(format!("Unknown property: {}", name.text));
                };
                Expression::Resource { field: field.into() }
            }
            MExpr::Literal { .. } | MExpr::String { .. } | MExpr::Special { .. } => self.lower(expr, TOP)?,
            MExpr::Paren { expr, .. } => self.resource_predicate(expr)?,
            MExpr::Binary { op, left, right, .. } => {
                if is_arithmetic(*op) {
                    return refuse("a _resources WHERE compares resource fields — 'arithmetic' is not supported here");
                }
                let left = self.resource_predicate(left)?;
                combine(*op, left, self.resource_predicate(right)?)
            }
            MExpr::Unary { op, operand, .. } => {
                let expression = Box::new(self.resource_predicate(operand)?);
                match op {
                    UnaryOp::Not => Expression::Not { expression },
                    UnaryOp::Neg => Expression::Negate { expression },
                }
            }
            MExpr::List { elements, .. } => Expression::List {
                elements: elements
                    .iter()
                    .map(|e| self.list_element(e, |x| self.resource_predicate(x)))
                    .collect::<Lowered<_>>()?,
            },
            MExpr::Exists { operand, .. } => Expression::Compare {
                op: FilterOperator::Exists,
                left: Box::new(self.resource_predicate(operand)?),
                right: Box::new(Expression::stat(StaticValue::Bool(true))),
            },
            _ => {
                return refuse(format!(
                    "a _resources WHERE compares resource fields — '{}' is not supported here",
                    kind_of(expr)
                ));
            }
        })
    }

    /// `-[#linked WHERE type = "ATTIO"]->.field` — legacy. The adapter is
    /// read off the WHERE's SOURCE TEXT, as the formula grammar's regex read
    /// it: the one rule here a tree cannot express.
    fn linked(&self, hop: &Hop, rest: &[Segment]) -> Lowered<Expression> {
        let where_text: Vec<u16> = match &hop.where_ {
            Some(w) => {
                let at = w.at();
                self.source.slice(at.start, at.end).to_vec()
            }
            None => Vec::new(),
        };
        let adapter = linked_adapter(&where_text).map(|a| a.to_uppercase()).unwrap_or_default();
        match rest {
            [Segment::Member(terminal)] => Ok(Expression::LinkedObject { adapter, field: terminal.text.clone() }),
            _ => refuse("Expected field name after -[#linked...]->."),
        }
    }

    fn meta_config(&self, config: &MapLiteral, ctx: Ctx) -> Lowered<Option<MetaConfig>> {
        let mut cfg: MetaConfig = IndexMap::new();
        for entry in &config.entries {
            let MapMember::Entry { key, value } = entry else {
                return refuse("A hop's settings are written out one by one — a spread ('...') is not accepted here");
            };
            let key = map_key_text(key);
            if key == "enrich_with" {
                let MExpr::List { elements, .. } = value else {
                    return refuse("enrich_with: expects a list literal");
                };
                let entries = elements.iter().map(|e| self.enrich_with_entry(e, ctx)).collect::<Lowered<Vec<_>>>()?;
                cfg.insert("enrichWith", MetaSetting::EnrichWith(entries));
                continue;
            }
            let value = self.lower(value, ctx)?;
            match key {
                "description" => {
                    cfg.insert("description", MetaSetting::Expression(value));
                }
                "data" => {
                    let Expression::List { elements } = value else {
                        return refuse("data: expects a list literal [expr, expr, ...]");
                    };
                    let data = elements
                        .into_iter()
                        .map(|e| match e {
                            ListElement::Spread(_) => {
                                refuse("data: lists its values one by one — a spread ('...') is not accepted here")
                            }
                            ListElement::Expression(e) => Ok(e),
                        })
                        .collect::<Lowered<Vec<_>>>()?;
                    cfg.insert("data", MetaSetting::Expressions(data));
                }
                "plugin" => {
                    cfg.insert("plugin", MetaSetting::Expression(value));
                }
                key => {
                    let extra = cfg.entry("extra").or_insert_with(|| MetaSetting::Extra(IndexMap::new()));
                    let MetaSetting::Extra(extra) = extra else { unreachable!("`extra` only ever holds the extra settings") };
                    // `extra.__proto__ = value` sets the TypeScript object's
                    // prototype rather than adding a key.
                    if key != "__proto__" {
                        extra.insert(key.to_string(), value);
                    }
                }
            }
        }
        if let Some(MetaSetting::Extra(extra)) = cfg.get_mut("extra") {
            js::object_key_order(extra);
        }
        Ok(if cfg.is_empty() { None } else { Some(cfg) })
    }

    fn enrich_with_entry(&self, element: &crate::tree::ListElement, ctx: Ctx) -> Lowered<EnrichWithEntry> {
        let crate::tree::ListElement::Expr(MExpr::Map { entries, .. }) = element else {
            return refuse("enrich_with: each entry must be an object literal");
        };
        let pairs: Vec<(&str, &MExpr)> = entries
            .iter()
            .filter_map(|x| match x {
                MapMember::Entry { key, value } => Some((map_key_text(key), value)),
                MapMember::Spread(_) => None,
            })
            .collect();
        let find = |k: &str| pairs.iter().find(|(key, _)| *key == k).map(|(_, v)| *v);
        let (Some(transform), Some(argument)) = (find("transform"), find("argument")) else {
            return refuse("enrich_with entry: requires exactly \"transform\" and \"argument\"");
        };
        if entries.len() != 2 {
            return refuse("enrich_with entry: requires exactly \"transform\" and \"argument\"");
        }
        let transform = self.lower(transform, ctx)?;
        Ok(EnrichWithEntry { transform, argument: self.lower(argument, ctx)? })
    }

    // ── Calls: where a name becomes a built-in ──

    /// The second value is how many of the segments AFTER the call it
    /// absorbed (the aggregate's postfix property).
    fn call(&self, name: &Name, args: &[CallArg], after: &[Segment], ctx: Ctx, scoped: bool) -> Lowered<(Expression, usize)> {
        refuse_retired(name)?;
        if let Some(named) = args.iter().find_map(|a| a.name.as_ref()) {
            return refuse(format!("a named argument ({}: …) is a movement call's, not an expression's", named.text));
        }
        let upper = name.text.to_uppercase();

        // `EXISTS(…)`, in any letter case, is the quantifier; resolved by
        // name like any other call, unless scoped or quoted.
        if !name.quoted && upper == "EXISTS" && !scoped {
            return Ok((self.exists(args)?, 0));
        }

        // `AGG(<bare walk>).prop` reads a property of the aggregated landing:
        // the property moves inside the walk (the first url is the url of
        // the first).
        let mut values: Vec<Cow<MExpr>> = args.iter().map(|a| Cow::Borrowed(&a.value)).collect();
        let mut consumed = 0;
        if let Some(Segment::Member(next)) = after.first()
            && !name.quoted
            && BARE_PATH_AGGREGATES.contains(&upper.as_str())
            && values.first().is_some_and(|v| is_bare_walk(v))
        {
            values[0] = Cow::Owned(member(&values[0], (*next).clone()));
            consumed = 1;
        }

        if scoped {
            let fn_ = upper.to_lowercase();
            let args = values.iter().map(|v| self.lower(v, ctx)).collect::<Lowered<Vec<_>>>()?;
            call_shape::validate(&fn_, &args)?;
            return Ok((Expression::Function { fn_, args }, consumed));
        }
        if upper == "SORT" {
            return Ok((self.sort(&values, ctx)?, consumed));
        }
        let lowered = values.iter().map(|v| self.lower(v, ctx)).collect::<Lowered<Vec<_>>>()?;
        Ok((self.builtin(&upper, lowered)?, consumed))
    }

    fn builtin(&self, upper: &str, mut args: Vec<Expression>) -> Lowered<Expression> {
        if let Some(fn_) = aggregate_fn(upper) {
            let separator = args.get(1).and_then(|s| s.as_static_text()).map(String::from);
            let expression = if args.is_empty() { Expression::static_text("") } else { args.swap_remove(0) };
            return Ok(Expression::Aggregate {
                fn_,
                expression: Box::new(expression),
                separator,
                prompt: None,
                order_by: None,
                order_direction: None,
            });
        }
        match upper {
            "AI" => {
                if args.len() > 2 {
                    return refuse(format!("AI takes at most 2 arguments (prompt, tier), got {}", args.len()));
                }
                let mut tier = None;
                if args.len() == 2 {
                    let Some(t) = args[1].as_static_text() else {
                        let tiers = vocabulary::quoted_list(vocabulary().ai_tiers, "\"", ", ");
                        return refuse(format!("AI's second argument is the tier — {tiers} — written down in place"));
                    };
                    tier = Some(t.to_string());
                }
                let prompt = args.into_iter().next();
                Ok(match prompt {
                    Some(Expression::Static { value: StaticValue::String(prompt) }) => {
                        Expression::Llm { prompt, prompt_expression: None, tier }
                    }
                    prompt => Expression::Llm { prompt: String::new(), prompt_expression: prompt.map(Box::new), tier },
                })
            }
            "CONCAT" => Ok(Expression::Concat { parts: args }),
            "KG_EXISTS" | "KG_VALUE" => {
                let query = args.first().and_then(|q| q.as_static_text()).unwrap_or("").to_string();
                let params = args.into_iter().skip(1).collect();
                Ok(if upper == "KG_EXISTS" { Expression::KgExists { query, params } } else { Expression::KgValue { query, params } })
            }
            "AT" => {
                if args.len() != 2 {
                    return refuse(format!("AT takes exactly 2 arguments (AT(list, index)), got {}", args.len()));
                }
                let index = args.pop().expect("two arguments");
                let expression = args.pop().expect("two arguments");
                Ok(Expression::At { expression: Box::new(expression), index: Box::new(index) })
            }
            _ => {
                let fn_ = upper.to_lowercase();
                call_shape::validate(&fn_, &args)?;
                Ok(Expression::Function { fn_, args })
            }
        }
    }

    /// SORT(collection[, key][, ASC|DESC]) — a bare ASC/DESC in the LAST
    /// slot is the direction, not a field of that name.
    fn sort(&self, values: &[Cow<MExpr>], ctx: Ctx) -> Lowered<Expression> {
        let Some((source, rest)) = values.split_first() else {
            return refuse("SORT orders a collection");
        };
        let mut rest: Vec<&MExpr> = rest.iter().map(|v| v.as_ref()).collect();
        let mut direction = None;
        // `/^(ASC|DESC)$/i`: without the `u` flag, ASCII case only.
        if let Some(MExpr::Name { name, .. }) = rest.last() {
            let text = &name.text;
            if text.eq_ignore_ascii_case("ASC") || text.eq_ignore_ascii_case("DESC") {
                direction = Some(if text.to_uppercase() == "DESC" { OrderDirection::Desc } else { OrderDirection::Asc });
                rest.pop();
            }
        }
        if rest.len() > 1 {
            return refuse("SORT takes a collection, a key and a direction");
        }
        let expression = Box::new(self.lower(source, ctx)?);
        let order_by = match rest.first() {
            Some(key) => Some(Box::new(self.lower(key, ctx)?)),
            None => None,
        };
        Ok(Expression::Aggregate {
            fn_: AggregationFunction::Sort,
            expression,
            separator: None,
            prompt: None,
            order_by,
            order_direction: Some(direction.unwrap_or(OrderDirection::Asc)),
        })
    }

    /// `EXISTS(walk [WHERE predicate])` — true when the walk lands anywhere
    /// (that the predicate holds). The interior is read as a slot of its
    /// own, whatever surrounds the call, so a name in its predicate is never
    /// an edge property of an enclosing hop.
    fn exists(&self, args: &[CallArg]) -> Lowered<Expression> {
        let [arg] = args else {
            return refuse("EXISTS(…) expects a traversal path");
        };
        let (walk, predicate) = match &arg.value {
            MExpr::Where { source, predicate, .. } => (source.as_ref(), Some(predicate.as_ref())),
            walk => (walk, None),
        };
        if let Some((root, steps)) = self.walk_steps(walk)? {
            let where_ = match predicate {
                Some(p) => Some(Box::new(self.lower(p, TOP)?)),
                None => None,
            };
            let exists = Expression::Exists { steps, where_ };
            return match root {
                Some(root) => self.fold_namespace(Some(root), Vec::new(), exists),
                None => Ok(exists),
            };
        }
        // `EXISTS(x.Field)` asks a VALUE's presence: `x.Field != null`.
        if predicate.is_some() {
            return refuse("EXISTS(… WHERE …) needs a traversal path — a value has nothing to filter");
        }
        if let MExpr::Member { object, .. } = walk
            && let MExpr::Name { name, .. } = object.as_ref()
            && name.text.to_lowercase() != "edge"
        {
            let read = self.lower(walk, TOP)?;
            return Ok(Expression::Compare {
                op: FilterOperator::Neq,
                left: Box::new(read),
                right: Box::new(Expression::stat(StaticValue::Null)),
            });
        }
        refuse("EXISTS(…) expects a traversal path like -[:edge]-> or alias-[:edge]->, or a property read like x.`Field`")
    }

    /// A walk's root and steps, when `walk` is a name or a bare walk from one.
    #[allow(clippy::type_complexity)]
    fn walk_steps(&self, walk: &MExpr) -> Lowered<Option<(Option<String>, Vec<TraversalStep>)>> {
        match walk {
            MExpr::Name { name, .. } => return Ok(Some((Some(name.text.clone()), Vec::new()))),
            MExpr::Path { root, .. } if root.as_deref().is_none_or(|r| matches!(r, MExpr::Name { .. })) => {}
            _ => return Ok(None),
        }
        let probe_name = Name { text: EXISTS_PROBE.into(), quoted: true, at: walk.at() };
        let probe = self.lower(&member(walk, probe_name), TOP)?;
        Ok(match probe {
            Expression::Traverse { alias_root, steps, expression } if matches!(*expression, Expression::Property { .. }) => {
                Some((alias_root, steps))
            }
            _ => None,
        })
    }

    // ── Namespaced stdlib calls ──

    /// `CURRENCY.GET_NUMBER_FROM_FIGURE(…)` → the family's function; an
    /// unknown member or an unknown ALL-CAPS namespace in call position is
    /// refused. Takes a `traverse`'s parts.
    fn fold_namespace(&self, alias_root: Option<String>, steps: Vec<TraversalStep>, expression: Expression) -> Lowered<Expression> {
        let Some(root) = alias_root.as_deref().filter(|_| steps.is_empty()) else {
            return Ok(Expression::Traverse { alias_root, steps, expression: Box::new(expression) });
        };
        let call_name = call_terminal_name(&expression);
        let v = vocabulary();
        if let Some(family) = v.family(root) {
            let inventory = format!("{} provides: {}", family.namespace, family.describe());
            let Some(call_name) = call_name else {
                return refuse(format!(
                    "{} is a function family, not a position — call one of its functions. {inventory}",
                    family.namespace
                ));
            };
            let found = family.functions.iter().find(|f| f.name == call_name);
            let (Some(spec), Expression::Function { args, .. }) = (found, expression) else {
                return refuse(format!("{} has no function {call_name}() — {inventory}", family.namespace));
            };
            let (min, max) = (spec.arity.min, spec.arity.max);
            if args.len() < min || args.len() > max {
                let expected = if min == max { format!("{min}") } else { format!("{min}–{max}") };
                return refuse(format!(
                    "{} takes {expected} argument{}, got {}",
                    spec.signature,
                    if max == 1 { "" } else { "s" },
                    args.len()
                ));
            }
            return Ok(Expression::Function { fn_: spec.id.to_string(), args });
        }
        if call_name.is_some() && namespace_shaped(root) {
            return refuse(format!(
                "Unknown function namespace '{root}' — the namespaced families are: {}",
                v.namespaces().join(", ")
            ));
        }
        Ok(Expression::Traverse { alias_root, steps, expression: Box::new(expression) })
    }
}

fn refuse_retired(name: &Name) -> Lowered<()> {
    if !name.quoted && name.text == "EXTRACT_VALUE" {
        return refuse(
            "EXTRACT_VALUE is retired (syntax amendment 4): extraction is a materialisation — declare the field in an `extract … { }` tree and read it as a plain property",
        );
    }
    Ok(())
}

fn map_key_text(key: &crate::tree::MapKey) -> &str {
    match key {
        crate::tree::MapKey::Name(n) => &n.text,
        crate::tree::MapKey::String(s) => &s.text,
    }
}

/// The adapter named in a `#linked` WHERE's text: the first match of
/// `/type\s*=\s*"([^"]*)"/i`, else `/type\s*=\s*'([^']*)'/i`, else
/// `/type\s*=\s*(\S+)/i` — the regexes' leftmost-match semantics, by hand.
/// `\s` is JavaScript's whitespace and `/i` without `u` folds ASCII only.
fn linked_adapter(text: &[u16]) -> Option<String> {
    let quoted = |quote: u8| {
        move |rest: &[u16]| -> Option<String> {
            let rest = rest.strip_prefix(&[u16::from(quote)])?;
            let close = rest.iter().position(|&u| u == u16::from(quote))?;
            Some(utf16::to_string(&rest[..close]))
        }
    };
    let bare = |rest: &[u16]| -> Option<String> {
        let run = rest.iter().take_while(|&&u| !utf16::is_js_space(u)).count();
        (run > 0).then(|| utf16::to_string(&rest[..run]))
    };
    first_after_type_equals(text, quoted(b'"'))
        .or_else(|| first_after_type_equals(text, quoted(b'\'')))
        .or_else(|| first_after_type_equals(text, bare))
}

/// The first `type\s*=\s*` (leftmost) whose remainder `value` reads.
fn first_after_type_equals(text: &[u16], value: impl Fn(&[u16]) -> Option<String>) -> Option<String> {
    (0..text.len()).find_map(|start| {
        let rest = &text[start..];
        if !utf16::starts_with_ci(rest, "type") {
            return None;
        }
        let rest = &rest[4..];
        let rest = &rest[utf16::space_run(rest)..];
        let rest = rest.strip_prefix(&[u16::from(b'=')])?;
        value(&rest[utf16::space_run(rest)..])
    })
}

/// Whether an `IS` test is anywhere in the tree.
fn contains_is(expr: &MExpr) -> bool {
    matches!(expr, MExpr::Is { .. }) || children(expr).into_iter().any(contains_is)
}

/// The sub-expressions of a node (`children`; the TypeScript keeps its own,
/// which the checker walks TypeScript trees with).
fn children(e: &MExpr) -> Vec<&MExpr> {
    use crate::tree::{ClosureBody, EntryValue, LiteralEntry};
    fn entry_values(entries: &[LiteralEntry]) -> Vec<&MExpr> {
        entries
            .iter()
            .filter_map(|x| match &x.value {
                EntryValue::Expr(v) => Some(v),
                EntryValue::DeclaredEdge(_) => None,
            })
            .collect()
    }
    match e {
        MExpr::Literal { .. } | MExpr::Name { .. } | MExpr::Special { .. } | MExpr::Type { .. } | MExpr::Declaration { .. } => {
            vec![]
        }
        MExpr::String { parts, .. } => parts
            .iter()
            .filter_map(|p| match p {
                StringPart::Expr(e) => Some(e),
                StringPart::Text(_) => None,
            })
            .collect(),
        MExpr::Paren { expr, .. } => vec![expr],
        MExpr::List { elements, .. } => elements
            .iter()
            .map(|x| match x {
                crate::tree::ListElement::Spread(s) => &s.expr,
                crate::tree::ListElement::Expr(e) => e,
            })
            .collect(),
        MExpr::Map { entries, .. } => entries
            .iter()
            .map(|x| match x {
                MapMember::Spread(s) => &s.expr,
                MapMember::Entry { value, .. } => value,
            })
            .collect(),
        MExpr::Member { object, .. } => vec![object],
        MExpr::Index { object, index, .. } => vec![object, index],
        MExpr::Call { callee, args, .. } => std::iter::once(callee.as_ref()).chain(args.iter().map(|a| &a.value)).collect(),
        MExpr::Path { root, hops, .. } => {
            // A hop's config is a map, which the TypeScript lists as one
            // child; its values stand in for it here, which is the same to the
            // one walk (`contains_is`) this serves — a map is never an `IS`.
            let mut out: Vec<&MExpr> = root.as_deref().into_iter().collect();
            for h in hops {
                out.extend(h.where_.as_ref());
                if let Some(config) = &h.config {
                    out.extend(config.entries.iter().map(|x| match x {
                        MapMember::Spread(s) => &s.expr,
                        MapMember::Entry { value, .. } => value,
                    }));
                }
                out.extend(h.order_by.as_ref().map(|o| &o.key));
            }
            out
        }
        MExpr::Unary { operand, .. } | MExpr::Exists { operand, .. } | MExpr::Within { operand, .. } => vec![operand],
        MExpr::Binary { left, right, .. } => vec![left, right],
        MExpr::Where { source, predicate, .. } => vec![source, predicate],
        MExpr::Is { subject, .. } => vec![subject],
        MExpr::If { condition, then, else_, .. } => {
            let mut out: Vec<&MExpr> = vec![condition, then];
            out.extend(else_.as_deref());
            out
        }
        MExpr::Closure { body, .. } => match body.as_ref() {
            ClosureBody::Expr { expr } => vec![expr],
            ClosureBody::Block { .. } => vec![],
        },
        MExpr::Node { entries, .. } => entry_values(entries),
        MExpr::Graph { entries, spreads, .. } => {
            let mut out = entry_values(entries);
            out.extend(spreads.iter());
            out
        }
        MExpr::Mapped { source, body, .. } => vec![source, body],
        MExpr::Lazy { walk, .. } => vec![walk],
    }
}

/// The refusal code of a closure written where a value goes (the
/// TypeScript's `MOV_EXPR_CLOSURE_POSITION`).
pub const CLOSURE_POSITION_CODE: &str = "MOV_EXPR_CLOSURE_POSITION";

#[cfg(test)]
mod tests;
