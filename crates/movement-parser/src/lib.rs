//! The movement-language parser. Grammars produce the same JSON shapes the
//! TypeScript parser's `ast.ts` and `tree.ts` describe; `abi` carries them
//! across the WASM boundary.

pub mod abi;
pub mod ast;
pub mod expr;
pub mod lexer;
pub mod scan;
pub mod stmt;
pub mod tree;
pub mod util;
pub mod version;

use serde::Serialize;
use serde_json::{Value, json};

/// What a grammar entry point hands back: the parsed tree, or the error
/// object the TypeScript wrappers rewrap into their error classes.
pub type Parsed = Result<Value, Value>;

/// The `Program` exactly as the TypeScript parser builds it: each slot is
/// `{raw, span}` and nothing more, so its canonical hash is the pinned one.
pub fn parse_program(source: &str, version: u32) -> Parsed {
    let program = stmt::parse_program(source, version, false).map_err(|e| to_value(&e))?;
    Ok(to_value(&program))
}

/// The same `Program` with every slot's expression parsed up front: each
/// `ExprSlot` gains `tree` (its `MExpr`, offsets into `raw`) or `error` (the
/// expression grammar's refusal), which is what reading the slot lazily
/// would have produced. The slots are parsed after the statement parse, one
/// at a time, so the two recursions never stack.
pub fn parse_program_eager(source: &str, version: u32) -> Parsed {
    let program = stmt::parse_program(source, version, true).map_err(|e| to_value(&e))?;
    let mut value = to_value(&program);
    attach_slot_trees(&mut value);
    Ok(value)
}

/// Finds every object the statement parser marked as a slot, unmarks it and
/// adds its parse.
fn attach_slot_trees(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if map.remove("__slot").is_some() {
                let parsed = map.get("raw").and_then(Value::as_str).map(expr::parse_expression);
                match parsed {
                    Some(Ok(tree)) => {
                        map.insert("tree".into(), to_value(&tree));
                    }
                    Some(Err(error)) => {
                        map.insert("error".into(), to_value(&error));
                    }
                    None => {}
                }
                return;
            }
            map.values_mut().for_each(attach_slot_trees);
        }
        Value::Array(items) => items.iter_mut().for_each(attach_slot_trees),
        _ => {}
    }
}

/// The expression grammar reads no version: one grammar serves them all.
pub fn parse_expression(source: &str, _version: u32) -> Parsed {
    let tree = expr::parse_expression(source).map_err(|e| to_value(&e))?;
    Ok(to_value(&tree))
}

pub struct NestedCall {
    pub at_start: u32,
    pub at_end: u32,
    pub origin_line: u32,
    pub origin_col: u32,
    pub version: u32,
}

pub fn parse_nested_call(_raw: &str, _call: &NestedCall) -> Parsed {
    Err(not_implemented())
}

fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("parser output is always representable as JSON")
}

fn not_implemented() -> Value {
    json!({ "message": "not implemented", "pos": 0 })
}

/// Serialises with every object's keys sorted, recursively. Going through
/// `Value` is what sorts them: a derived `Serialize` writes struct fields in
/// declaration order, whereas serde_json's `Map` is a `BTreeMap` while the
/// `preserve_order` feature is off.
pub fn to_sorted_json<T: Serialize>(value: &T) -> Vec<u8> {
    let value = serde_json::to_value(value).expect("parser output is always representable as JSON");
    serde_json::to_vec(&value).expect("a serde_json Value always serialises")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eager_slots_carry_their_parse_and_nothing_else_does() {
        let program = parse_program_eager("await sleep(2d)\nx = a +\ny = b", 3).unwrap();
        let text = String::from_utf8(to_sorted_json(&program)).unwrap();
        assert!(!text.contains("__slot"), "{text}");
        // A duration literal is `{raw, span}` too, and is not an expression.
        assert_eq!(program.pointer("/statements/0/await/source/duration"), Some(&json!({
            "raw": "2d",
            "span": { "start": { "line": 1, "col": 13 }, "end": { "line": 1, "col": 15 } },
        })));
        let refused = program.pointer("/statements/1/value/expr").unwrap();
        assert!(refused.get("error").and_then(|e| e.get("message")).is_some() && refused.get("tree").is_none());
        assert_eq!(program.pointer("/statements/2/value/expr/tree/kind"), Some(&json!("name")));
    }

    #[test]
    fn struct_fields_come_out_sorted() {
        #[derive(Serialize)]
        struct Unsorted {
            zeta: u32,
            alpha: Inner,
        }
        #[derive(Serialize)]
        struct Inner {
            y: u32,
            b: u32,
        }
        let bytes = to_sorted_json(&Unsorted { zeta: 1, alpha: Inner { y: 2, b: 3 } });
        assert_eq!(String::from_utf8(bytes).unwrap(), r#"{"alpha":{"b":3,"y":2},"zeta":1}"#);
    }
}
