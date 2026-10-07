//! A tree from its JSON: the parser's own output, or a TypeScript rewriting
//! of it (a nested call replaced by the name bound to it). Read by hand from
//! a `serde_json::Value` rather than through derived `Deserialize`s: the
//! derived visitors for the tree's tagged and untagged enums more than
//! doubled the WASM artifact, and buffered every subtree once per level.
//!
//! As the TypeScript reads it: a key that is absent and a key that is
//! `undefined` are the same, so an absent optional and a `null` one are not
//! (JSON.stringify drops `undefined`), and keys the tree does not have are
//! ignored.

use serde_json::{Map, Value};

use crate::tree::{
    Arrow, At, BinaryOp, CallArg, ClosureBody, DeclarationMember, DeclaredEdge, Direction, Duration, EntryValue, Hop,
    JsNumber, ListElement, LiteralEntry, LiteralValue, MExpr, MapKey, MapLiteral, MapMember, Name, NodeDeclaration,
    OrderBy, Param, Quote, RecordMember, SortDirection, Spread, StringKey, StringPart, StringQuoted, TypeExpr, UnaryOp,
};

type Read<T> = Result<T, String>;

/// The tree in `json`, its nesting bounded (`util::json::read_bounded`).
pub fn read_tree(json: &str) -> Read<MExpr> {
    expr(&crate::util::json::read_bounded(json)?)
}

fn object<'a>(v: &'a Value, what: &str) -> Read<&'a Map<String, Value>> {
    v.as_object().ok_or_else(|| format!("{what} is not an object"))
}

fn field<'a>(o: &'a Map<String, Value>, key: &str) -> Read<&'a Value> {
    o.get(key).ok_or_else(|| format!("missing `{key}`"))
}

fn optional<'a>(o: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    o.get(key)
}

fn string(o: &Map<String, Value>, key: &str) -> Read<String> {
    field(o, key)?.as_str().map(String::from).ok_or_else(|| format!("`{key}` is not a string"))
}

fn boolean(o: &Map<String, Value>, key: &str) -> Read<bool> {
    field(o, key)?.as_bool().ok_or_else(|| format!("`{key}` is not a boolean"))
}

fn number(v: &Value, key: &str) -> Read<JsNumber> {
    v.as_f64().map(JsNumber).ok_or_else(|| format!("`{key}` is not a number"))
}

fn offset(o: &Map<String, Value>, key: &str) -> Read<usize> {
    let n = field(o, key)?.as_f64().ok_or_else(|| format!("`{key}` is not a number"))?;
    if n < 0.0 || n.fract() != 0.0 {
        return Err(format!("`{key}` is not an offset"));
    }
    Ok(n as usize)
}

fn array<'a>(o: &'a Map<String, Value>, key: &str) -> Read<&'a Vec<Value>> {
    field(o, key)?.as_array().ok_or_else(|| format!("`{key}` is not an array"))
}

fn each<T>(o: &Map<String, Value>, key: &str, read: impl Fn(&Value) -> Read<T>) -> Read<Vec<T>> {
    array(o, key)?.iter().map(read).collect()
}

fn at(o: &Map<String, Value>) -> Read<At> {
    at_of(field(o, "at")?)
}

fn at_of(v: &Value) -> Read<At> {
    let o = object(v, "`at`")?;
    Ok(At { start: offset(o, "start")?, end: offset(o, "end")? })
}

fn boxed(o: &Map<String, Value>, key: &str) -> Read<Box<MExpr>> {
    expr(field(o, key)?).map(Box::new)
}

fn optional_boxed(o: &Map<String, Value>, key: &str) -> Read<Option<Box<MExpr>>> {
    optional(o, key).map(|v| expr(v).map(Box::new)).transpose()
}

fn name(v: &Value) -> Read<Name> {
    let o = object(v, "a name")?;
    Ok(Name { text: string(o, "text")?, quoted: boolean(o, "quoted")?, at: at(o)? })
}

fn optional_name(o: &Map<String, Value>, key: &str) -> Read<Option<Name>> {
    optional(o, key).map(name).transpose()
}

fn kind(o: &Map<String, Value>) -> Option<&str> {
    o.get("kind").and_then(Value::as_str)
}

pub fn expr(v: &Value) -> Read<MExpr> {
    let o = object(v, "an expression")?;
    let k = kind(o).ok_or("an expression has no `kind`")?;
    let at = at(o)?;
    Ok(match k {
        "literal" => MExpr::Literal {
            value: match field(o, "value")? {
                Value::Null => LiteralValue::Null(()),
                Value::Bool(b) => LiteralValue::Bool(*b),
                v => LiteralValue::Number(number(v, "value")?),
            },
            at,
        },
        "string" => MExpr::String {
            quote: match string(o, "quote")?.as_str() {
                "\"" => Quote::Double,
                "'" => Quote::Single,
                other => return Err(format!("unknown quote {other:?}")),
            },
            parts: each(o, "parts", |p| match p {
                Value::String(s) => Ok(StringPart::Text(s.clone())),
                p => expr(p).map(StringPart::Expr),
            })?,
            at,
        },
        "name" => MExpr::Name { name: name(field(o, "name")?)?, at },
        "special" => MExpr::Special { text: string(o, "text")?, at },
        "paren" => MExpr::Paren { expr: boxed(o, "expr")?, at },
        "list" => MExpr::List { elements: each(o, "elements", list_element)?, at },
        "map" => MExpr::Map { entries: each(o, "entries", map_member)?, at },
        "member" => MExpr::Member { object: boxed(o, "object")?, property: name(field(o, "property")?)?, at },
        "index" => MExpr::Index { object: boxed(o, "object")?, index: boxed(o, "index")?, at },
        "call" => MExpr::Call { callee: boxed(o, "callee")?, args: each(o, "args", call_arg)?, at },
        "path" => MExpr::Path { root: optional_boxed(o, "root")?, hops: each(o, "hops", hop)?, at },
        "unary" => MExpr::Unary {
            op: match string(o, "op")?.as_str() {
                "not" => UnaryOp::Not,
                "-" => UnaryOp::Neg,
                other => return Err(format!("unknown unary op {other:?}")),
            },
            operand: boxed(o, "operand")?,
            at,
        },
        "binary" => MExpr::Binary { op: binary_op(&string(o, "op")?)?, left: boxed(o, "left")?, right: boxed(o, "right")?, at },
        "exists" => MExpr::Exists { operand: boxed(o, "operand")?, at },
        "within" => {
            let d = object(field(o, "duration")?, "a duration")?;
            let duration = Duration { text: string(d, "text")?, quoted: boolean(d, "quoted")?, at: self::at(d)? };
            MExpr::Within { operand: boxed(o, "operand")?, duration, at }
        }
        "where" => MExpr::Where { source: boxed(o, "source")?, predicate: boxed(o, "predicate")?, at },
        "is" => MExpr::Is { subject: boxed(o, "subject")?, type_: type_expr(field(o, "type")?)?, at },
        "if" => MExpr::If {
            condition: boxed(o, "condition")?,
            then: boxed(o, "then")?,
            else_: optional_boxed(o, "else")?,
            at,
        },
        "type" => MExpr::Type { type_: type_expr(field(o, "type")?)?, at },
        "closure" => {
            let body = object(field(o, "body")?, "a closure body")?;
            let body = match kind(body) {
                Some("block") => ClosureBody::Block { at: self::at(body)? },
                Some("expr") => ClosureBody::Expr { expr: expr(field(body, "expr")?)? },
                other => return Err(format!("unknown closure body {other:?}")),
            };
            MExpr::Closure { params: each(o, "params", param)?, body: Box::new(body), at }
        }
        "node" => MExpr::Node { entries: each(o, "entries", literal_entry)?, at },
        "graph" => MExpr::Graph {
            shape: optional_name(o, "shape")?,
            entries: each(o, "entries", literal_entry)?,
            spreads: each(o, "spreads", expr)?,
            at,
        },
        "declaration" => MExpr::Declaration { declaration: Box::new(node_declaration(field(o, "declaration")?)?), at },
        "mapped" => MExpr::Mapped { source: boxed(o, "source")?, body: boxed(o, "body")?, at },
        "lazy" => MExpr::Lazy { walk: boxed(o, "walk")?, at },
        other => return Err(format!("unknown expression kind {other:?}")),
    })
}

fn binary_op(op: &str) -> Read<BinaryOp> {
    Ok(match op {
        "or" => BinaryOp::Or,
        "and" => BinaryOp::And,
        "==" => BinaryOp::Eq,
        "!=" => BinaryOp::Ne,
        "<" => BinaryOp::Lt,
        "<=" => BinaryOp::Le,
        ">" => BinaryOp::Gt,
        ">=" => BinaryOp::Ge,
        "contains" => BinaryOp::Contains,
        "in" => BinaryOp::In,
        "+" => BinaryOp::Add,
        "-" => BinaryOp::Sub,
        "*" => BinaryOp::Mul,
        "/" => BinaryOp::Div,
        "%" => BinaryOp::Rem,
        other => return Err(format!("unknown binary op {other:?}")),
    })
}

/// `{ kind: 'spread', expr, at }`, in a list or a map.
fn spread(o: &Map<String, Value>) -> Read<Spread> {
    Ok(Spread { expr: expr(field(o, "expr")?)?, at: at(o)? })
}

fn list_element(v: &Value) -> Read<ListElement> {
    let o = object(v, "a list element")?;
    if kind(o) == Some("spread") { spread(o).map(ListElement::Spread) } else { expr(v).map(ListElement::Expr) }
}

/// `isMapSpread`: an entry has no `kind`.
fn map_member(v: &Value) -> Read<MapMember> {
    let o = object(v, "a map member")?;
    if o.contains_key("kind") {
        return spread(o).map(MapMember::Spread);
    }
    let k = object(field(o, "key")?, "a map key")?;
    let key = match field(k, "quoted")? {
        Value::String(s) if s == "string" => {
            MapKey::String(StringKey { text: string(k, "text")?, quoted: StringQuoted::String, at: at(k)? })
        }
        _ => MapKey::Name(name(field(o, "key")?)?),
    };
    Ok(MapMember::Entry { key, value: expr(field(o, "value")?)? })
}

fn map_literal(v: &Value) -> Read<MapLiteral> {
    let o = object(v, "a map")?;
    Ok(MapLiteral { entries: each(o, "entries", map_member)?, at: at(o)? })
}

fn call_arg(v: &Value) -> Read<CallArg> {
    let o = object(v, "a call argument")?;
    Ok(CallArg { name: optional_name(o, "name")?, value: expr(field(o, "value")?)? })
}

fn hop(v: &Value) -> Read<Hop> {
    let o = object(v, "a hop")?;
    let order_by = optional(o, "orderBy")
        .map(|v| -> Read<Box<OrderBy>> {
            let ob = object(v, "an order by")?;
            let direction = optional(ob, "direction")
                .map(|d| match d.as_str() {
                    Some("asc") => Ok(SortDirection::Asc),
                    Some("desc") => Ok(SortDirection::Desc),
                    other => Err(format!("unknown order direction {other:?}")),
                })
                .transpose()?;
            Ok(Box::new(OrderBy { key: expr(field(ob, "key")?)?, direction }))
        })
        .transpose()?;
    Ok(Hop {
        direction: match string(o, "direction")?.as_str() {
            "out" => Direction::Out,
            "in" => Direction::In,
            other => return Err(format!("unknown hop direction {other:?}")),
        },
        arrow: match string(o, "arrow")?.as_str() {
            "->" => Arrow::Full,
            "-" => Arrow::Bare,
            other => return Err(format!("unknown arrow {other:?}")),
        },
        alias: optional_name(o, "alias")?,
        label: name(field(o, "label")?)?,
        where_: optional(o, "where").map(expr).transpose()?,
        config: optional(o, "config").map(map_literal).transpose()?,
        order_by,
        limit: optional(o, "limit").map(|v| number(v, "limit")).transpose()?,
        at: at(o)?,
    })
}

fn type_expr(v: &Value) -> Read<TypeExpr> {
    let o = object(v, "a type")?;
    let at = at(o)?;
    Ok(match kind(o) {
        Some("named") => TypeExpr::Named {
            name: name(field(o, "name")?)?,
            hops: each(o, "hops", hop)?,
            field: optional_name(o, "field")?,
            array: boolean(o, "array")?,
            at,
        },
        Some("record") => TypeExpr::Record {
            members: each(o, "members", |m| {
                let m = object(m, "a record member")?;
                Ok(RecordMember {
                    name: name(field(m, "name")?)?,
                    optional: boolean(m, "optional")?,
                    type_: type_expr(field(m, "type")?)?,
                })
            })?,
            array: boolean(o, "array")?,
            at,
        },
        Some("literal") => TypeExpr::Literal {
            value: match field(o, "value")? {
                Value::Null => None,
                Value::String(s) => Some(s.clone()),
                _ => return Err("a literal type's `value` is not a string".into()),
            },
            at,
        },
        Some("union") => TypeExpr::Union { members: each(o, "members", type_expr)?, at },
        other => return Err(format!("unknown type kind {other:?}")),
    })
}

fn param(v: &Value) -> Read<Param> {
    let o = object(v, "a parameter")?;
    Ok(Param { name: name(field(o, "name")?)?, type_: optional(o, "type").map(type_expr).transpose()? })
}

fn literal_entry(v: &Value) -> Read<LiteralEntry> {
    let o = object(v, "an entry")?;
    let value = field(o, "value")?;
    let value = match object(value, "an entry's value")? {
        e if kind(e) == Some("declaredEdge") => EntryValue::DeclaredEdge(DeclaredEdge {
            type_: type_expr(field(e, "type")?)?,
            sequenced: optional_name(e, "sequenced")?,
            at: at(e)?,
        }),
        _ => EntryValue::Expr(expr(value)?),
    };
    Ok(LiteralEntry { name: name(field(o, "name")?)?, value, at: at(o)? })
}

fn node_declaration(v: &Value) -> Read<NodeDeclaration> {
    let o = object(v, "a declaration")?;
    Ok(NodeDeclaration {
        name: name(field(o, "name")?)?,
        extends: optional_name(o, "extends")?,
        description: optional(o, "description").map(expr).transpose()?,
        members: each(o, "members", |m| {
            let m = object(m, "a declaration member")?;
            Ok(match kind(m) {
                Some("field") => DeclarationMember::Field {
                    name: name(field(m, "name")?)?,
                    type_: type_expr(field(m, "type")?)?,
                    description: optional(m, "description").map(expr).transpose()?,
                    at: at(m)?,
                },
                Some("node") => DeclarationMember::Node { declaration: node_declaration(field(m, "declaration")?)? },
                other => return Err(format!("unknown declaration member {other:?}")),
            })
        })?,
        sequenced: optional_name(o, "sequenced")?,
        at: at(o)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::to_sorted_json;

    /// Reading back what the parser wrote gives the parser's tree.
    #[test]
    fn reads_back_what_the_parser_writes() {
        for text in [
            "a.b(c, d: e)[0] + -f",
            "x-[a:b WHERE c ORDER BY d DESC LIMIT 2]->-[t:#transform { k: 1, ...s, \"q\": 2 }]-><-[:e]-.f",
            "IF a THEN \"x ${b} y\" ELSE 'z' END WITHIN 30d",
            "r IS <crm-[:company]->> AND s IS <text | null>",
            "() => {\n a = 1\n}",
            "(x) => x + 1",
            "graph { ...v }",
            "node {\n title: m.`Subject`\n files: lazy m-[a:Attachments]-> node { name: a.`Name` }\n}",
            "export node Entry: \"each\" {\n name: <text> \"the name\"\n node founder {\n first: <text>\n } order by arrival\n}",
            "EXISTS(m-[:a]-> WHERE b) AND c EXISTS AND [1, ...l, true, null] AND @meta AND <t>",
        ] {
            let text = text.strip_prefix("export ").unwrap_or(text);
            let tree = crate::expr::parse_expression(text).unwrap_or_else(|e| panic!("{text}: {e:?}"));
            let json = String::from_utf8(to_sorted_json(&tree)).unwrap();
            let back = read_tree(&json).unwrap_or_else(|e| panic!("{text}: {e}"));
            assert_eq!(back, tree, "{text}");
        }
    }

    #[test]
    fn a_tree_that_is_not_one_says_what_is_wrong() {
        assert_eq!(read_tree(r#"{"kind":"nope","at":{"start":0,"end":1}}"#).unwrap_err(), r#"unknown expression kind "nope""#);
        assert_eq!(read_tree(r#"{"kind":"name","at":{"start":0,"end":1}}"#).unwrap_err(), "missing `name`");
        assert!(read_tree("[").is_err());
    }
}
