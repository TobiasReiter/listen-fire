//! The movement-language parser. Grammars produce the JSON shapes
//! packages/movement-lang/parser/ast.ts and expression/tree.ts describe;
//! `abi` carries them across the WASM boundary.

pub mod abi;
pub mod ast;
pub mod catalog;
pub mod expr;
pub mod lexer;
pub mod lowering;
pub mod scan;
pub mod stmt;
pub mod tree;
pub mod util;
pub mod version;

use serde::Serialize;
use serde_json::Value;

/// What a grammar entry point hands back: the parsed tree, or the error
/// object the TypeScript wrappers rewrap into their error classes.
pub type Parsed = Result<Value, Value>;

/// The `Program` exactly as parser/ast.ts types it: each slot is
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
                // A list element closure's body is statements whose slots
                // are marked too.
                if let Some(closures) = map.get_mut("closures") {
                    attach_slot_trees(closures);
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

/// `parseNestedCall`: the call at `at_start..at_end` of a slot's `raw` read
/// by the statement grammar as the right-hand side of a binding. The text
/// ends where the call does; `origin` is where `raw` starts in the file, so
/// the spans are the file's. Its slots carry their parse, as the eager
/// program's do. Offsets are UTF-16 units, as the TypeScript caller has them.
pub fn parse_nested_call(raw: &str, call: &NestedCall) -> Parsed {
    let head = util::utf16::Utf16::new(raw).text(0, call.at_end as usize);
    let origin = ast::Loc { line: call.origin_line as usize, col: call.origin_col as usize };
    let value = stmt::Parser::new(&head, call.version, origin, true)
        .parse_nested_call_value(call.at_start as usize)
        .map_err(|e| to_value(&e))?;
    let mut value = to_value(&value);
    attach_slot_trees(&mut value);
    Ok(value)
}

fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("parser output is always representable as JSON")
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
    use serde_json::json;

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
    fn a_nested_call_reads_to_its_end_with_the_file_s_spans() {
        // The call starts on the slot's first line, so its columns are offset
        // by the origin's; the closure's statement is on a later line, so
        // its columns are its own.
        let raw = "1 + f(x, () => {\n  y = 🌍x\n}) + 2";
        let end = crate::util::form::utf16_len(raw) - 4;
        let call = NestedCall { at_start: 4, at_end: end as u32, origin_line: 3, origin_col: 5, version: 3 };
        let value = parse_nested_call(raw, &call).unwrap();
        assert_eq!(value.pointer("/call/callee"), Some(&json!("f")));
        assert_eq!(value.pointer("/call/span"), Some(&json!({
            "start": { "line": 3, "col": 9 }, "end": { "line": 5, "col": 3 },
        })));
        // UTF-16 columns: the emoji is two.
        assert_eq!(value.pointer("/call/args/1/closure/body/0/value/expr/span"), Some(&json!({
            "start": { "line": 4, "col": 7 }, "end": { "line": 4, "col": 10 },
        })));
        // Its slots carry their parse, as the eager program's do.
        assert_eq!(value.pointer("/call/args/0/expr/tree/kind"), Some(&json!("name")));
        assert_eq!(
            value.pointer("/call/args/1/closure/body/0/value/expr/error/message"),
            Some(&json!("Unrecognised character '🌍'")),
        );
    }

    #[test]
    fn a_nested_call_that_does_not_end_at_its_extent_is_refused() {
        let call = NestedCall { at_start: 0, at_end: 6, origin_line: 2, origin_col: 3, version: 3 };
        let error = parse_nested_call("f(x) y", &call).unwrap_err();
        assert_eq!(error, json!({
            "message": "Expected the call to end here, found 'y'",
            "loc": { "line": 2, "col": 8 },
        }));
    }

    #[test]
    fn the_depth_limit_names_no_grammar() {
        // It guards statements as well as expressions. A debug build's frames
        // need more than a test thread's default stack to reach the limit
        // (and on macOS an overflow there hangs rather than aborting).
        let source = format!("{}x = 1{}", "if a {\n".repeat(200), "\n}".repeat(200));
        let error = std::thread::Builder::new()
            .stack_size(256 << 20)
            .spawn(move || parse_program(&source, 3).unwrap_err())
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(error.get("message"), Some(&json!("nesting too deep")));
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
