//! The statement-layer AST, mirroring packages/movement-lang/parser/ast.ts
//! field for field and `kind` for `kind`. Serialised through
//! `to_sorted_json`, so declaration order is irrelevant; absent optionals are
//! omitted, never null, because the TypeScript side tests them with
//! `=== undefined` (and `declared?: undefined` tells the two extraction node
//! forms apart).
//!
//! A struct that is a member of a union AND appears on its own elsewhere
//! (`CallStatement`, `ShapeDeclaration`, the other statements) carries its
//! own `kind` tag, because the TypeScript object is the same one in both
//! places; the unions over such structs are then untagged.
//!
//! Every `Loc` is 1-based, its column counted in UTF-16 units.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Loc {
    pub line: usize,
    pub col: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub start: Loc,
    pub end: Loc,
}

/// A value-expression position, captured verbatim. `eager` asks the
/// serialiser to mark it so the eager export can find every slot afterwards
/// (a `DurationLiteral` has the same two fields and must not be mistaken
/// for one).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExprSlot {
    pub raw: String,
    pub span: Span,
    #[serde(rename = "__slot", default, skip_serializing_if = "std::ops::Not::not")]
    pub eager: bool,
    /// The closures written as elements of a list literal in the slot
    /// (`fs = [() => { … }, (x) => x + 1]`, language version 5), each parsed
    /// by the statement grammar, since a block body is statements. The
    /// lowering reads each as the name `slot_closure_name(at)`, which the
    /// engine binds to the closure in a scope around the slot.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub closures: Vec<SlotClosure>,
}

impl ExprSlot {
    /// A slot holding no list element closure: a piece of another slot's
    /// text, or a slot built by the engine.
    pub fn plain(raw: String, span: Span) -> Self {
        ExprSlot { raw, span, eager: false, closures: Vec::new() }
    }
}

/// One list element closure of a slot; `at` is its offset in `raw` (UTF-16).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SlotClosure {
    pub at: usize,
    pub closure: ClosureExpression,
}

/// The name a list element closure is read by inside its slot — an identity
/// compared, never parsed. `#` keeps it out of every author's namespace.
pub fn slot_closure_name(at: usize) -> String {
    format!("#closure@{at}")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeRef {
    pub graph: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hops_raw: Option<String>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PathRoot {
    Name { name: String },
    Expression { expr: ExprSlot },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathHead {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<PathRoot>,
    pub hops_raw: String,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Program {
    pub statements: Vec<Statement>,
}

/// Read back by its `kind` (a parked state carries code as this tree): the
/// statement structs tag themselves on the way out only, so an untagged
/// read would take the first struct whose fields fit.
///
/// One list declares each variant with its `kind`; the enum, `kind()` and the
/// reading by `kind` are all generated from it, so a variant cannot be added
/// without its tag being readable.
macro_rules! statements {
    ($($variant:ident($ty:ident) = $kind:literal;)*) => {
        #[derive(Debug, Clone, PartialEq, Serialize)]
        #[serde(untagged)]
        pub enum Statement {
            $($variant($ty),)*
        }

        impl Statement {
            /// The `kind` tag the statement is written with.
            pub fn kind(&self) -> &'static str {
                match self {
                    $(Statement::$variant(_) => $kind,)*
                }
            }
        }

        impl<'de> Deserialize<'de> for Statement {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                use serde::de::Error;
                let tree = serde_json::Value::deserialize(deserializer)?;
                let kind = tree.get("kind").and_then(serde_json::Value::as_str).ok_or_else(|| D::Error::custom("a statement without its kind"))?.to_string();
                match kind.as_str() {
                    $($kind => Ok(Statement::$variant($ty::deserialize(tree).map_err(D::Error::custom)?)),)*
                    other => Err(D::Error::custom(format!("a statement of kind '{other}'"))),
                }
            }
        }
    };
}

statements! {
    Import(ImportStatement) = "import";
    Assign(AssignStatement) = "assign";
    Shape(ShapeDeclaration) = "shape";
    Type(TypeDeclaration) = "type";
    Movement(MovementDeclaration) = "movement";
    Listen(ListenDeclaration) = "listen";
    Write(WriteStatement) = "write";
    Match(MatchStatement) = "match";
    Call(CallStatement) = "call";
    Block(BlockStatement) = "block";
    Link(LinkStatement) = "link";
    Unlink(UnlinkStatement) = "unlink";
    Delete(DeleteStatement) = "delete";
    Refresh(RefreshStatement) = "refresh";
    If(IfStatement) = "if";
    Await(AwaitStatement) = "await";
    Combinator(CombinatorStatement) = "combinator";
    Collection(CollectionStatement) = "collection";
    Return(ReturnStatement) = "return";
    Error(ErrorStatement) = "error";
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "return")]
pub struct ReturnStatement {
    pub value: RValue,
    pub span: Span,
    /// A concise closure body that is one call (`(f) => f()`, language
    /// version 5): TypeScript's `() => g()`, which hands back what `g`
    /// returns, and nothing when `g` returns nothing.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub concise: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ImportSource {
    Builtin { namespace: String },
    File { path: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImportedName {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "import")]
pub struct ImportStatement {
    pub names: Vec<ImportedName>,
    pub source: ImportSource,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "assign")]
pub struct AssignStatement {
    pub name: String,
    pub value: RValue,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RValue {
    Construct { construct: ConstructionCall },
    Call { call: CallStatement },
    Write { write: WriteExpression },
    Match { r#match: MatchExpression },
    Link { link: LinkExpression },
    Extract { extract: ExtractExpression },
    ExtractCall {
        #[serde(rename = "extractCall")]
        extract_call: ExtractCallExpression,
    },
    Block { block: TraversalBlock },
    Await { r#await: AwaitExpression },
    Combinator { combinator: CombinatorExpression },
    Collection { collection: CollectionOpExpression },
    Members { members: MembersExpression },
    InlineBlock {
        #[serde(rename = "inlineBlock")]
        inline_block: InlineBlockExpression,
    },
    Callback { callback: CallbackExpression },
    Closure { closure: ClosureExpression },
    Node { node: NodeLiteral },
    Lazy { lazy: LazyTraversal },
    Expr { expr: ExprSlot },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LazyTraversal {
    pub head: PathHead,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mapping: Option<NodeLiteral>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConstructionCall {
    pub callee: String,
    pub args: Vec<NamedArg>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedArg {
    pub name: String,
    pub value: ExprSlot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_type: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WriteTarget {
    Linked {
        path: PathHead,
        #[serde(rename = "explicitType", skip_serializing_if = "Option::is_none")]
        explicit_type: Option<String>,
        span: Span,
    },
    Tuple {
        paths: Vec<PathHead>,
        #[serde(rename = "explicitType", skip_serializing_if = "Option::is_none")]
        explicit_type: Option<String>,
        span: Span,
    },
    /// `write a { … }`, `write m.k { … }`: the record a name or a member
    /// path holds, updated in place.
    Position {
        root: PathRoot,
        span: Span,
    },
}

impl WriteTarget {
    pub fn span(&self) -> Span {
        match self {
            WriteTarget::Linked { span, .. } | WriteTarget::Tuple { span, .. } | WriteTarget::Position { span, .. } => {
                *span
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteExpression {
    pub target: WriteTarget,
    pub unique_by: Vec<UniqueClause>,
    pub fields: Vec<FieldEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spreads: Option<Vec<WriteSpread>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bind: Option<BindClause>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BindClause {
    pub name: String,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "write")]
pub struct WriteStatement {
    pub write: WriteExpression,
    pub span: Span,
}

/// A `WriteTarget` that is not a position — `match`'s, and a link body's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchExpression {
    pub target: WriteTarget,
    pub unique_by: Vec<UniqueClause>,
    pub fields: Vec<FieldEntry>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "match")]
pub struct MatchStatement {
    pub r#match: MatchExpression,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FieldWriteMode {
    #[serde(rename = "fill")]
    Fill,
    #[serde(rename = "append")]
    Append,
    #[serde(rename = "append-missing")]
    AppendMissing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldEntry {
    pub name: String,
    pub value: ExprSlot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantics: Option<FieldWriteMode>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WriteSpread {
    /// The spread record's bound name, or a member path as written (`path`
    /// then says what it reads).
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<SpreadPath>,
    /// Only ever `fill`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantics: Option<FieldWriteMode>,
    pub span: Span,
}

/// `...m.k`: the bound name, then the keys read off it, in order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpreadPath {
    pub root: String,
    pub members: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UniqueClause {
    pub predicate: ExprSlot,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeLiteral {
    pub entries: Vec<NodeEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph: Option<GraphForm>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spreads: Option<Vec<MapSpread>>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphForm {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape: Option<NamedSpan>,
}

/// `{ name, span }` — a name and where it was written.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NamedSpan {
    pub name: String,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeSequencing {
    Arrival,
    Document,
    Chronological,
}

impl EdgeSequencing {
    pub fn word(self) -> &'static str {
        match self {
            EdgeSequencing::Arrival => "arrival",
            EdgeSequencing::Document => "document",
            EdgeSequencing::Chronological => "chronological",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NodeEntry {
    Value {
        name: String,
        value: ExprSlot,
        span: Span,
    },
    Nodes {
        name: String,
        nodes: Vec<NodeLiteral>,
        span: Span,
    },
    Declared {
        name: String,
        #[serde(rename = "type")]
        type_: TypeRef,
        #[serde(skip_serializing_if = "Option::is_none")]
        sequenced: Option<EdgeSequencing>,
        span: Span,
    },
    Traversal {
        name: String,
        head: PathHead,
        lazy: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        mapping: Option<NodeLiteral>,
        span: Span,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MapSpread {
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<SpreadPath>,
    pub after: usize,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraversalBlock {
    pub head: PathHead,
    pub body: Vec<Statement>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "block")]
pub struct BlockStatement {
    pub block: TraversalBlock,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LinkTarget {
    Handle {
        name: String,
    },
    Match {
        r#match: MatchExpression,
        #[serde(rename = "impliedIdentity")]
        implied_identity: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LinkExpression {
    pub from: String,
    pub edge: String,
    pub to: LinkTarget,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "link")]
pub struct LinkStatement {
    pub link: LinkExpression,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "unlink")]
pub struct UnlinkStatement {
    pub from: String,
    pub edge: String,
    pub to: String,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "delete")]
pub struct DeleteStatement {
    pub name: String,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "refresh", rename_all = "camelCase")]
pub struct RefreshStatement {
    pub name: String,
    pub name_span: Span,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IfArm {
    pub condition: ExprSlot,
    pub body: Vec<Statement>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ElseArm {
    pub body: Vec<Statement>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "if", rename_all = "camelCase")]
pub struct IfStatement {
    pub arms: Vec<IfArm>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub else_arm: Option<ElseArm>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DurationLiteral {
    pub raw: String,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AwaitExpression {
    pub source: AwaitSource,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AwaitSource {
    Traversal {
        head: PathHead,
        span: Span,
    },
    First {
        head: PathHead,
        span: Span,
    },
    Combinator {
        combinator: CombinatorExpression,
        span: Span,
    },
    Sleep {
        duration: DurationLiteral,
        span: Span,
    },
    Until {
        condition: UntilCondition,
        #[serde(skip_serializing_if = "Option::is_none")]
        every: Option<DurationLiteral>,
        span: Span,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum UntilCondition {
    Closure { closure: ClosureExpression },
    Expr { expr: ExprSlot },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "await")]
pub struct AwaitStatement {
    pub r#await: AwaitExpression,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CombinatorKind {
    Race,
    Parallel,
}

impl CombinatorKind {
    pub fn word(self) -> &'static str {
        match self {
            CombinatorKind::Race => "race",
            CombinatorKind::Parallel => "parallel",
        }
    }
}

/// `kind` here is data (which combinator), not a union tag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CombinatorExpression {
    pub kind: CombinatorKind,
    pub arms: CombinatorArms,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CombinatorArms {
    Literal { arms: Vec<ArmExpression>, span: Span },
    Dynamic { expr: ExprSlot, span: Span },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ArmExpression {
    Closure { closure: ClosureExpression, span: Span },
    Ref { name: String, span: Span },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CollectionOpExpression {
    pub op: CollectionOp,
    pub source: ExprSlot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub init: Option<ExprSlot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<ExprSlot>,
    pub r#fn: ArmExpression,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CollectionOp {
    Map,
    Filter,
    Reduce,
    Groupby,
    Keyby,
}

impl CollectionOp {
    /// The surface spelling of each op. Uppercase, like every other function
    /// the language ships.
    pub fn from_spelling(word: &str) -> Option<Self> {
        match word {
            "MAP" => Some(CollectionOp::Map),
            "FILTER" => Some(CollectionOp::Filter),
            "REDUCE" => Some(CollectionOp::Reduce),
            "GROUPBY" => Some(CollectionOp::Groupby),
            "KEYBY" => Some(CollectionOp::Keyby),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MembersExpression {
    #[serde(rename = "type")]
    pub type_: String,
    pub span: Span,
    pub type_span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "combinator")]
pub struct CombinatorStatement {
    pub combinator: CombinatorExpression,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "collection")]
pub struct CollectionStatement {
    pub collection: CollectionOpExpression,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosureExpression {
    pub params: Vec<MovementParam>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_type: Option<ParamTypeRef>,
    pub body: Vec<Statement>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineBlockExpression {
    pub body: Vec<Statement>,
    pub binding: String,
    pub binding_span: Span,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallbackExpression {
    pub subject: CallbackSubject,
    pub config: Vec<NamedArg>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_span: Option<Span>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CallbackSubject {
    Inline {
        closure: ClosureExpression,
        span: Span,
    },
    Named {
        movement: String,
        args: Vec<CallArg>,
        #[serde(rename = "nameSpan")]
        name_span: Span,
        span: Span,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "error")]
pub struct ErrorStatement {
    pub message: ExprSlot,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CallArg {
    Expr {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        expr: ExprSlot,
    },
    Write {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        write: WriteExpression,
    },
    Node {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        node: NodeLiteral,
    },
    Call {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        call: CallStatement,
    },
    Closure {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        closure: ClosureExpression,
        span: Span,
    },
    Type {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(rename = "type")]
        type_: String,
        span: Span,
    },
}

impl CallArg {
    pub fn name(&self) -> Option<&str> {
        match self {
            CallArg::Expr { name, .. }
            | CallArg::Write { name, .. }
            | CallArg::Node { name, .. }
            | CallArg::Call { name, .. }
            | CallArg::Closure { name, .. }
            | CallArg::Type { name, .. } => name.as_deref(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "call")]
pub struct CallStatement {
    pub callee: String,
    pub args: Vec<CallArg>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expression: Option<ExprSlot>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "shape")]
pub struct ShapeDeclaration {
    pub name: String,
    pub root: ShapeNode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extends: Option<NamedSpan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exported: Option<bool>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShapeField {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nullable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<ExprSlot>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShapeNode {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<ExprSlot>,
    pub fields: Vec<ShapeField>,
    pub children: Vec<ShapeNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequenced: Option<EdgeSequencing>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "type")]
pub struct TypeDeclaration {
    pub name: String,
    pub options: Vec<String>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MovementParam {
    pub name: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub type_: Option<ParamTypeRef>,
    pub span: Span,
}

/// A written value type: TypeScript's `ValueTypeMember`, which `ValueTypeRef`
/// (the `list` and `record` arms) is a part of.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ValueType {
    Name { name: String, span: Span },
    List { of: Box<ValueType>, span: Span },
    Record { keys: Vec<ValueTypeKey>, span: Span },
    /// `<(c: <Company>) => <text>>` — a closure type (language version 5),
    /// TypeScript's function type. Every parameter is typed.
    Closure { params: Vec<MovementParam>, returns: Box<ParamTypeRef>, span: Span },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ValueTypeKey {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: ValueType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optional: Option<bool>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ParamTypeRef {
    Name(TypeRef),
    Value(ValueType),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "movement", rename_all = "camelCase")]
pub struct MovementDeclaration {
    pub name: String,
    pub params: Vec<MovementParam>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_type: Option<ParamTypeRef>,
    pub body: Vec<Statement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exported: Option<bool>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "listen")]
pub struct ListenDeclaration {
    pub instance: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub construct: Option<ConstructionCall>,
    pub config: Vec<NamedArg>,
    pub movement: String,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractExpression {
    pub from: Vec<ExprSlot>,
    pub stages: Vec<ExtractStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractStage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub through: Option<Vec<PluginCall>>,
    pub fields: Vec<ExtractField>,
    pub children: Vec<ExtractNode>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractField {
    pub name: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub type_: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nullable: Option<bool>,
    pub description: ExprSlot,
    pub span: Span,
}

/// Told apart by `declared`: absent on the inline form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ExtractNode {
    // Read back in this order: the declared form is the one with `declared`,
    // and an inline one's fields fit it otherwise.
    Declared(DeclaredExtractNode),
    Inline(InlineExtractNode),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InlineExtractNode {
    pub name: String,
    pub description: ExprSlot,
    pub stages: Vec<ExtractStage>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeclaredExtractNode {
    pub name: String,
    pub declared: DeclaredType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<ExprSlot>,
    pub stages: Vec<ExtractStage>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeclaredType {
    #[serde(rename = "type")]
    pub type_: String,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtractCallFinds {
    Each,
    One,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractCallExpression {
    pub finds: ExtractCallFinds,
    pub content: ExprSlot,
    pub shape: ExtractCallShape,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<ExprSlot>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ExtractCallShape {
    Named { name: String, span: Span },
    Inline { declaration: ShapeDeclaration, span: Span },
    Computed { expr: ExprSlot, span: Span },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginCall {
    pub plugin: String,
    pub args: Vec<NamedArg>,
    pub span: Span,
}
