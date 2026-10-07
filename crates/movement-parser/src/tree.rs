//! The movement expression tree, mirroring packages/movement-lang/parser/
//! expression/tree.ts field for field. Serialised through `to_sorted_json`,
//! so declaration order is irrelevant; absent optionals are omitted, never
//! null, because the TypeScript side tests them with `=== undefined`.
//!
//! Every `At` is a 0-based UTF-16 offset into the text the parser was given.

use serde::{Serialize, Serializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct At {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Name {
    pub text: String,
    pub quoted: bool,
    pub at: At,
}

/// A JavaScript number. Integral values serialise as integers so the JSON
/// reads as `JSON.stringify` writes it (`5`, not `5.0`); a non-finite one
/// becomes `null`, as `JSON.stringify` makes it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JsNumber(pub f64);

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

impl Serialize for JsNumber {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let x = self.0;
        if x.is_finite() && x.fract() == 0.0 && x.abs() <= MAX_SAFE_INTEGER {
            serializer.serialize_i64(x as i64)
        } else {
            serializer.serialize_f64(x)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum LiteralValue {
    Number(JsNumber),
    Bool(bool),
    Null(()),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Quote {
    #[serde(rename = "\"")]
    Double,
    #[serde(rename = "'")]
    Single,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum StringPart {
    Text(String),
    Expr(MExpr),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum BinaryOp {
    #[serde(rename = "or")]
    Or,
    #[serde(rename = "and")]
    And,
    #[serde(rename = "==")]
    Eq,
    #[serde(rename = "!=")]
    Ne,
    #[serde(rename = "<")]
    Lt,
    #[serde(rename = "<=")]
    Le,
    #[serde(rename = ">")]
    Gt,
    #[serde(rename = ">=")]
    Ge,
    #[serde(rename = "contains")]
    Contains,
    #[serde(rename = "in")]
    In,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum UnaryOp {
    #[serde(rename = "not")]
    Not,
    #[serde(rename = "-")]
    Neg,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CallArg {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<Name>,
    pub value: MExpr,
}

/// `{ "k": … }` — a key written as a string: `quoted` is the string `"string"`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StringKey {
    pub text: String,
    pub quoted: StringQuoted,
    pub at: At,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum StringQuoted {
    #[serde(rename = "string")]
    String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum MapKey {
    Name(Name),
    String(StringKey),
}

/// `{ kind: 'spread', expr, at }` — in a list or a map literal.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename = "spread")]
pub struct Spread {
    pub expr: MExpr,
    pub at: At,
}

/// A map entry carries no `kind`; `isMapSpread` tells the two apart by it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum MapMember {
    Entry { key: MapKey, value: MExpr },
    Spread(Spread),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ListElement {
    Expr(MExpr),
    Spread(Spread),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Out,
    In,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Arrow {
    #[serde(rename = "->")]
    Full,
    #[serde(rename = "-")]
    Bare,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OrderBy {
    pub key: MExpr,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<SortDirection>,
}

/// A map literal, where only a map may stand (a hop's config).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename = "map")]
pub struct MapLiteral {
    pub entries: Vec<MapMember>,
    pub at: At,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hop {
    pub direction: Direction,
    pub arrow: Arrow,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<Name>,
    pub label: Name,
    #[serde(rename = "where", skip_serializing_if = "Option::is_none")]
    pub where_: Option<MExpr>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<MapLiteral>,
    #[serde(rename = "orderBy", skip_serializing_if = "Option::is_none")]
    pub order_by: Option<Box<OrderBy>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<JsNumber>,
    pub at: At,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecordMember {
    pub name: Name,
    pub optional: bool,
    #[serde(rename = "type")]
    pub type_: TypeExpr,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TypeExpr {
    Named {
        name: Name,
        hops: Vec<Hop>,
        #[serde(skip_serializing_if = "Option::is_none")]
        field: Option<Name>,
        array: bool,
        at: At,
    },
    Record {
        members: Vec<RecordMember>,
        array: bool,
        at: At,
    },
    Literal {
        value: Option<String>,
        at: At,
    },
    Union {
        members: Vec<TypeExpr>,
        at: At,
    },
}

impl TypeExpr {
    pub fn at(&self) -> At {
        match self {
            TypeExpr::Named { at, .. }
            | TypeExpr::Record { at, .. }
            | TypeExpr::Literal { at, .. }
            | TypeExpr::Union { at, .. } => *at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DeclarationMember {
    Field {
        name: Name,
        #[serde(rename = "type")]
        type_: TypeExpr,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<MExpr>,
        at: At,
    },
    Node {
        declaration: NodeDeclaration,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NodeDeclaration {
    pub name: Name,
    #[serde(rename = "extends", skip_serializing_if = "Option::is_none")]
    pub extends: Option<Name>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<MExpr>,
    pub members: Vec<DeclarationMember>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequenced: Option<Name>,
    pub at: At,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename = "declaredEdge")]
pub struct DeclaredEdge {
    #[serde(rename = "type")]
    pub type_: TypeExpr,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequenced: Option<Name>,
    pub at: At,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum EntryValue {
    Expr(MExpr),
    DeclaredEdge(DeclaredEdge),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LiteralEntry {
    pub name: Name,
    pub value: EntryValue,
    pub at: At,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Param {
    pub name: Name,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub type_: Option<TypeExpr>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ClosureBody {
    Block { at: At },
    Expr { expr: MExpr },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Duration {
    pub text: String,
    pub quoted: bool,
    pub at: At,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MExpr {
    Literal {
        value: LiteralValue,
        at: At,
    },
    String {
        quote: Quote,
        parts: Vec<StringPart>,
        at: At,
    },
    Name {
        name: Name,
        at: At,
    },
    Special {
        text: String,
        at: At,
    },
    Paren {
        expr: Box<MExpr>,
        at: At,
    },
    List {
        elements: Vec<ListElement>,
        at: At,
    },
    Map {
        entries: Vec<MapMember>,
        at: At,
    },
    Member {
        object: Box<MExpr>,
        property: Name,
        at: At,
    },
    Index {
        object: Box<MExpr>,
        index: Box<MExpr>,
        at: At,
    },
    Call {
        callee: Box<MExpr>,
        args: Vec<CallArg>,
        at: At,
    },
    Path {
        #[serde(skip_serializing_if = "Option::is_none")]
        root: Option<Box<MExpr>>,
        hops: Vec<Hop>,
        at: At,
    },
    Unary {
        op: UnaryOp,
        operand: Box<MExpr>,
        at: At,
    },
    Binary {
        op: BinaryOp,
        left: Box<MExpr>,
        right: Box<MExpr>,
        at: At,
    },
    Exists {
        operand: Box<MExpr>,
        at: At,
    },
    Within {
        operand: Box<MExpr>,
        duration: Duration,
        at: At,
    },
    Where {
        source: Box<MExpr>,
        predicate: Box<MExpr>,
        at: At,
    },
    Is {
        subject: Box<MExpr>,
        #[serde(rename = "type")]
        type_: TypeExpr,
        at: At,
    },
    If {
        condition: Box<MExpr>,
        then: Box<MExpr>,
        #[serde(rename = "else", skip_serializing_if = "Option::is_none")]
        else_: Option<Box<MExpr>>,
        at: At,
    },
    Type {
        #[serde(rename = "type")]
        type_: TypeExpr,
        at: At,
    },
    Closure {
        params: Vec<Param>,
        body: Box<ClosureBody>,
        at: At,
    },
    Node {
        entries: Vec<LiteralEntry>,
        at: At,
    },
    Graph {
        #[serde(skip_serializing_if = "Option::is_none")]
        shape: Option<Name>,
        entries: Vec<LiteralEntry>,
        spreads: Vec<MExpr>,
        at: At,
    },
    Declaration {
        declaration: Box<NodeDeclaration>,
        at: At,
    },
    Mapped {
        source: Box<MExpr>,
        body: Box<MExpr>,
        at: At,
    },
    Lazy {
        walk: Box<MExpr>,
        at: At,
    },
}

impl MExpr {
    pub fn at(&self) -> At {
        match self {
            MExpr::Literal { at, .. }
            | MExpr::String { at, .. }
            | MExpr::Name { at, .. }
            | MExpr::Special { at, .. }
            | MExpr::Paren { at, .. }
            | MExpr::List { at, .. }
            | MExpr::Map { at, .. }
            | MExpr::Member { at, .. }
            | MExpr::Index { at, .. }
            | MExpr::Call { at, .. }
            | MExpr::Path { at, .. }
            | MExpr::Unary { at, .. }
            | MExpr::Binary { at, .. }
            | MExpr::Exists { at, .. }
            | MExpr::Within { at, .. }
            | MExpr::Where { at, .. }
            | MExpr::Is { at, .. }
            | MExpr::If { at, .. }
            | MExpr::Type { at, .. }
            | MExpr::Closure { at, .. }
            | MExpr::Node { at, .. }
            | MExpr::Graph { at, .. }
            | MExpr::Declaration { at, .. }
            | MExpr::Mapped { at, .. }
            | MExpr::Lazy { at, .. } => *at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::to_sorted_json;

    fn json<T: Serialize>(value: &T) -> String {
        String::from_utf8(to_sorted_json(value)).unwrap()
    }

    const AT: At = At { start: 0, end: 1 };

    #[test]
    fn a_map_entry_has_no_kind_and_a_spread_has_one() {
        let name = MExpr::Name { name: Name { text: "a".into(), quoted: false, at: AT }, at: AT };
        let map = MExpr::Map {
            entries: vec![
                MapMember::Entry {
                    key: MapKey::String(StringKey { text: "k".into(), quoted: StringQuoted::String, at: AT }),
                    value: name.clone(),
                },
                MapMember::Spread(Spread { expr: name, at: AT }),
            ],
            at: AT,
        };
        let out = json(&map);
        assert!(out.starts_with(r#"{"at":{"end":1,"start":0},"entries":[{"key":{"at":"#), "{out}");
        assert!(out.contains(r#""quoted":"string""#));
        assert!(out.contains(r#"{"at":{"end":1,"start":0},"expr":"#));
        assert!(out.contains(r#""kind":"spread""#));
    }

    #[test]
    fn literals_read_as_javascript_writes_them() {
        let lit = |value| json(&MExpr::Literal { value, at: AT });
        assert_eq!(lit(LiteralValue::Null(())), r#"{"at":{"end":1,"start":0},"kind":"literal","value":null}"#);
        assert_eq!(lit(LiteralValue::Number(JsNumber(5.0))), r#"{"at":{"end":1,"start":0},"kind":"literal","value":5}"#);
        assert_eq!(lit(LiteralValue::Number(JsNumber(1.5))), r#"{"at":{"end":1,"start":0},"kind":"literal","value":1.5}"#);
        assert_eq!(lit(LiteralValue::Bool(true)), r#"{"at":{"end":1,"start":0},"kind":"literal","value":true}"#);
    }

    #[test]
    fn absent_optionals_are_omitted() {
        let path = MExpr::Path { root: None, hops: vec![], at: AT };
        assert_eq!(json(&path), r#"{"at":{"end":1,"start":0},"hops":[],"kind":"path"}"#);
    }
}
