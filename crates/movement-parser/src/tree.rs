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

impl<'de> serde::Deserialize<'de> for JsNumber {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        <f64 as serde::Deserialize>::deserialize(deserializer).map(JsNumber)
    }
}

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

/// Where each closure written as an ELEMENT of a list literal starts
/// (`[() => { … }, (x) => x + 1]`), outermost first — language version 5's
/// one new closure position (`closuresInLists`, expression/tree.ts). A
/// closure's own body is not looked into: a list inside it is that body's
/// own slot's business.
pub fn closures_in_lists(tree: &MExpr) -> Vec<usize> {
    closure_extents_in_lists(tree).into_iter().map(|at| at.start).collect()
}

/// Every name `tree` reads as a value: a bare name anywhere but as the
/// callee a call names (language version 5 reads a function's name as the
/// function itself, `g = one`, `[twice, twice]`), a closure's concise body
/// included.
pub fn names_read(tree: &MExpr) -> Vec<String> {
    fn visit(expr: &MExpr, found: &mut Vec<String>) {
        match expr {
            MExpr::Name { name, .. } => found.push(name.text.clone()),
            MExpr::Call { callee, args, .. } => {
                if !matches!(callee.as_ref(), MExpr::Name { .. }) {
                    visit(callee, found);
                }
                for arg in args {
                    visit(&arg.value, found);
                }
            }
            other => shared::expr(other, &mut |child| visit(child, found)),
        }
    }
    let mut found = Vec::new();
    visit(tree, &mut found);
    found
}

/// `closures_in_lists`, each closure's whole extent: what an engine that
/// stages a slot's text finds them again by.
pub fn closure_extents_in_lists(tree: &MExpr) -> Vec<At> {
    fn visit(expr: &MExpr, found: &mut Vec<At>) {
        match expr {
            MExpr::List { elements, .. } => {
                for element in elements {
                    match element {
                        ListElement::Spread(spread) => visit(&spread.expr, found),
                        ListElement::Expr(MExpr::Closure { at, .. }) => found.push(*at),
                        ListElement::Expr(element) => visit(element, found),
                    }
                }
            }
            MExpr::String { parts, .. } => {
                for part in parts {
                    if let StringPart::Expr(part) = part {
                        visit(part, found);
                    }
                }
            }
            MExpr::Paren { expr, .. } => visit(expr, found),
            MExpr::Map { entries, .. } => {
                for entry in entries {
                    match entry {
                        MapMember::Entry { value, .. } => visit(value, found),
                        MapMember::Spread(spread) => visit(&spread.expr, found),
                    }
                }
            }
            MExpr::Member { object, .. } => visit(object, found),
            MExpr::Index { object, index, .. } => {
                visit(object, found);
                visit(index, found);
            }
            MExpr::Call { callee, args, .. } => {
                visit(callee, found);
                for arg in args {
                    visit(&arg.value, found);
                }
            }
            MExpr::Path { root, .. } => {
                if let Some(root) = root {
                    visit(root, found);
                }
            }
            MExpr::Unary { operand, .. } | MExpr::Exists { operand, .. } | MExpr::Within { operand, .. } => {
                visit(operand, found)
            }
            MExpr::Binary { left, right, .. } => {
                visit(left, found);
                visit(right, found);
            }
            MExpr::Where { source, predicate, .. } => {
                visit(source, found);
                visit(predicate, found);
            }
            MExpr::Is { subject, .. } => visit(subject, found),
            MExpr::If { condition, then, else_, .. } => {
                visit(condition, found);
                visit(then, found);
                if let Some(else_) = else_ {
                    visit(else_, found);
                }
            }
            MExpr::Literal { .. }
            | MExpr::Name { .. }
            | MExpr::Special { .. }
            | MExpr::Type { .. }
            | MExpr::Closure { .. }
            | MExpr::Node { .. }
            | MExpr::Graph { .. }
            | MExpr::Declaration { .. }
            | MExpr::Mapped { .. }
            | MExpr::Lazy { .. } => {}
        }
    }
    let mut found = Vec::new();
    visit(tree, &mut found);
    found
}

/// The longest chain a tree may hold: members, calls and indexes on one
/// object, operands of one operator run, a path's hops, a call's arguments.
/// Each link is a level of the tree (a hop is a level of its lowering), and
/// everything that walks a tree recurses per level — its JSON write and read,
/// the lowering — on a stack the grammar's nesting limit does not bound, since
/// a chain is read by a loop. About 2,200 levels exhausted the WASM's stack
/// (measured 2026-10-07); this sits at half that.
pub const MAX_CHAIN: usize = 1024;
pub const CHAIN_TOO_LONG: &str = "chain too long";

/// The sub-expressions directly inside a node, wherever they sit (a hop's
/// WHERE, a type's hops, a declaration's descriptions), once per reference
/// kind: `shared` for reading, `exclusive` for taking them out.
macro_rules! sub_expressions {
    ($module:ident $(, $m:tt)?) => {
        pub(crate) mod $module {
            use super::*;

            type R<'a, T> = &'a $($m)? T;

            pub fn expr<'a>(e: R<'a, MExpr>, f: &mut impl FnMut(R<'a, MExpr>)) {
                match e {
                    MExpr::Literal { .. } | MExpr::Name { .. } | MExpr::Special { .. } => {}
                    MExpr::String { parts, .. } => {
                        for part in parts {
                            if let StringPart::Expr(x) = part {
                                f(x);
                            }
                        }
                    }
                    MExpr::Paren { expr, .. } => f(expr),
                    MExpr::List { elements, .. } => {
                        for element in elements {
                            match element {
                                ListElement::Expr(x) => f(x),
                                ListElement::Spread(Spread { expr, .. }) => f(expr),
                            }
                        }
                    }
                    MExpr::Map { entries, .. } => map(entries, f),
                    MExpr::Member { object, .. } => f(object),
                    MExpr::Index { object, index, .. } => {
                        f(object);
                        f(index);
                    }
                    MExpr::Call { callee, args, .. } => {
                        f(callee);
                        for CallArg { value, .. } in args {
                            f(value);
                        }
                    }
                    MExpr::Path { root, hops, .. } => {
                        if let Some(root) = root {
                            f(root);
                        }
                        for h in hops {
                            hop(h, f);
                        }
                    }
                    MExpr::Unary { operand, .. } | MExpr::Exists { operand, .. } | MExpr::Within { operand, .. } => {
                        f(operand)
                    }
                    MExpr::Binary { left, right, .. } => {
                        f(left);
                        f(right);
                    }
                    MExpr::Where { source, predicate, .. } => {
                        f(source);
                        f(predicate);
                    }
                    MExpr::Is { subject, type_, .. } => {
                        f(subject);
                        type_expr(type_, f);
                    }
                    MExpr::If { condition, then, else_, .. } => {
                        f(condition);
                        f(then);
                        if let Some(x) = else_ {
                            f(x);
                        }
                    }
                    MExpr::Type { type_, .. } => type_expr(type_, f),
                    MExpr::Closure { params, body, .. } => {
                        for Param { type_, .. } in params {
                            if let Some(t) = type_ {
                                type_expr(t, f);
                            }
                        }
                        if let ClosureBody::Expr { expr } = &$($m)? **body {
                            f(expr);
                        }
                    }
                    MExpr::Node { entries, .. } => literal_entries(entries, f),
                    MExpr::Graph { entries, spreads, .. } => {
                        literal_entries(entries, f);
                        for x in spreads {
                            f(x);
                        }
                    }
                    MExpr::Declaration { declaration, .. } => node_declaration(declaration, f),
                    MExpr::Mapped { source, body, .. } => {
                        f(source);
                        f(body);
                    }
                    MExpr::Lazy { walk, .. } => f(walk),
                }
            }

            fn map<'a>(entries: R<'a, Vec<MapMember>>, f: &mut impl FnMut(R<'a, MExpr>)) {
                for entry in entries {
                    match entry {
                        MapMember::Entry { value, .. } => f(value),
                        MapMember::Spread(Spread { expr, .. }) => f(expr),
                    }
                }
            }

            fn hop<'a>(h: R<'a, Hop>, f: &mut impl FnMut(R<'a, MExpr>)) {
                let Hop { where_, config, order_by, .. } = h;
                if let Some(x) = where_ {
                    f(x);
                }
                if let Some(MapLiteral { entries, .. }) = config {
                    map(entries, f);
                }
                if let Some(o) = order_by {
                    let OrderBy { key, .. } = &$($m)? **o;
                    f(key);
                }
            }

            fn type_expr<'a>(t: R<'a, TypeExpr>, f: &mut impl FnMut(R<'a, MExpr>)) {
                match t {
                    TypeExpr::Named { hops, .. } => {
                        for h in hops {
                            hop(h, f);
                        }
                    }
                    TypeExpr::Record { members, .. } => {
                        for RecordMember { type_, .. } in members {
                            type_expr(type_, f);
                        }
                    }
                    TypeExpr::Union { members, .. } => {
                        for member in members {
                            type_expr(member, f);
                        }
                    }
                    TypeExpr::Literal { .. } => {}
                }
            }

            fn literal_entries<'a>(entries: R<'a, Vec<LiteralEntry>>, f: &mut impl FnMut(R<'a, MExpr>)) {
                for LiteralEntry { value, .. } in entries {
                    match value {
                        EntryValue::Expr(x) => f(x),
                        EntryValue::DeclaredEdge(DeclaredEdge { type_, .. }) => type_expr(type_, f),
                    }
                }
            }

            fn node_declaration<'a>(d: R<'a, NodeDeclaration>, f: &mut impl FnMut(R<'a, MExpr>)) {
                let NodeDeclaration { description, members, .. } = d;
                if let Some(x) = description {
                    f(x);
                }
                for member in members {
                    match member {
                        DeclarationMember::Field { type_, description, .. } => {
                            type_expr(type_, f);
                            if let Some(x) = description {
                                f(x);
                            }
                        }
                        DeclarationMember::Node { declaration } => node_declaration(declaration, f),
                    }
                }
            }
        }
    };
}

sub_expressions!(shared);
sub_expressions!(exclusive, mut);

/// What a taken-out sub-expression is replaced with: a leaf, so that the
/// node it leaves behind drops without recursing.
const LEAF: MExpr = MExpr::Literal { value: LiteralValue::Null(()), at: At { start: 0, end: 0 } };

impl MExpr {
    fn is_leaf(&self) -> bool {
        matches!(self, MExpr::Literal { .. } | MExpr::Name { .. } | MExpr::Special { .. })
    }

    /// Where the tree holds a chain longer than `MAX_CHAIN`, if it does: the
    /// start of the first node, in source order, that many levels down, or
    /// of the argument past the limit. Walked with a heap stack, since the
    /// tree it guards against is one too deep to recurse over.
    pub fn chain_overrun(&self) -> Option<usize> {
        fn weight(e: &MExpr) -> usize {
            match e {
                MExpr::Path { hops, .. } => hops.len().max(1),
                _ => 1,
            }
        }
        let mut stack = vec![(self, weight(self))];
        while let Some((e, depth)) = stack.pop() {
            if depth > MAX_CHAIN {
                return Some(e.at().start);
            }
            if let MExpr::Call { args, .. } = e
                && let Some(past) = args.get(MAX_CHAIN)
            {
                return Some(past.value.at().start);
            }
            let first = stack.len();
            shared::expr(e, &mut |child| stack.push((child, depth + weight(child))));
            stack[first..].reverse();
        }
        None
    }
}

/// Dropped level by level from a heap stack: the derived drop recurses per
/// level, and a tree is dropped before it is bounded (a refused chain, a
/// parse that fails after building one).
impl Drop for MExpr {
    fn drop(&mut self) {
        let mut taken = Vec::new();
        take_sub_expressions(self, &mut taken);
        while let Some(mut e) = taken.pop() {
            take_sub_expressions(&mut e, &mut taken);
        }
    }
}

fn take_sub_expressions(e: &mut MExpr, taken: &mut Vec<MExpr>) {
    exclusive::expr(e, &mut |child: &mut MExpr| {
        if !child.is_leaf() {
            taken.push(std::mem::replace(child, LEAF));
        }
    });
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
