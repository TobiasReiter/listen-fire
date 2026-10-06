//! The movement-language parser. Grammars produce the same JSON shapes the
//! TypeScript parser's `ast.ts` and `tree.ts` describe; `abi` carries them
//! across the WASM boundary.

pub mod abi;
pub mod ast;
pub mod expr;
pub mod lexer;
pub mod scan;
pub mod tree;
pub mod util;
pub mod version;

use serde::Serialize;
use serde_json::{Value, json};

/// What a grammar entry point hands back: the parsed tree, or the error
/// object the TypeScript wrappers rewrap into their error classes.
pub type Parsed = Result<Value, Value>;

pub fn parse_program(_source: &str, _version: u32) -> Parsed {
    Err(not_implemented())
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
