//! Conformance against packages/movement-lang/parser/__test__/__fixtures__/
//! programs.json: every program the TypeScript corpora parse, pinned by the
//! sha256 of its canonical AST or by the error it throws. A gate: any drift
//! fails, and `--nocapture` prints the first differences.
//!
//!   cargo test -p movement-parser --test programs -- --nocapture

// Each test binary compiles its own copy and uses only part of it.
#[allow(dead_code)]
mod common;

use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
struct Record {
    source: String,
    version: u32,
    #[serde(flatten)]
    expected: Expected,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Expected {
    Ast { ast_sha256: String },
    Error { error: Value },
}

const SHOWN_DIFFS: usize = 20;

fn records() -> Vec<Record> {
    let path = common::fixture("parser/__test__/__fixtures__/programs.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
    let records: Vec<Record> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
        .map(|(i, line)| serde_json::from_str(line).unwrap_or_else(|e| panic!("programs.json line {}: {e}", i + 1)))
        .collect();
    assert!(records.len() > 1000, "programs.json has only {} records", records.len());
    records
}

#[test]
fn every_pinned_program_parses_as_pinned() {
    let records = records();

    let mut pass = 0usize;
    let mut diffs = Vec::new();
    for record in &records {
        match diff(record) {
            None => pass += 1,
            Some(why) => diffs.push(format!(
                "v{} {}: {why}",
                record.version,
                serde_json::to_string(&prefix(&record.source, 80)).unwrap()
            )),
        }
    }

    println!("programs.json: {pass} pass, {} fail of {}", diffs.len(), records.len());
    for line in diffs.iter().take(SHOWN_DIFFS) {
        println!("  {line}");
    }
    if diffs.len() > SHOWN_DIFFS {
        println!("  … and {} more", diffs.len() - SHOWN_DIFFS);
    }
    assert!(diffs.is_empty(), "{} of {} programs differ from their pins", diffs.len(), records.len());
}

/// The eager export is the pinned program plus a parse on every slot: take
/// `tree` / `error` back off and it is the plain output, and every slot —
/// and nothing else, a duration literal's identical `{raw, span}` included —
/// carries exactly one of the two.
#[test]
fn the_eager_program_is_the_plain_one_with_every_slot_parsed() {
    let mut slots = 0usize;
    for record in records() {
        let Ok(plain) = movement_parser::parse_program(&record.source, record.version) else { continue };
        let mut eager = movement_parser::parse_program_eager(&record.source, record.version)
            .unwrap_or_else(|e| panic!("eager parse failed where the plain one did not: {e}"));
        slots += strip_slot_parses(&mut eager, None, &record.source);
        assert_eq!(eager, plain, "{:?}", prefix(&record.source, 80));
    }
    assert!(slots > 10_000, "only {slots} slots seen");
}

/// Removes each slot's `tree`/`error`, checking it had exactly one and that
/// it was where a slot is; returns how many it removed.
fn strip_slot_parses(value: &mut Value, key: Option<&str>, source: &str) -> usize {
    match value {
        Value::Object(map) => {
            let tree = map.remove("tree");
            let error = map.remove("error");
            let is_braces = map.len() == 2 && map.contains_key("raw") && map.contains_key("span");
            let is_duration = matches!(key, Some("duration" | "every"));
            if is_braces && !is_duration {
                assert!(tree.is_some() != error.is_some(), "slot without exactly one parse in {source:?}: {map:?}");
                return 1;
            }
            assert!(tree.is_none() && error.is_none(), "a non-slot was parsed in {source:?}: {map:?}");
            map.iter_mut().map(|(k, v)| strip_slot_parses(v, Some(k.as_str()), source)).sum()
        }
        Value::Array(items) => items.iter_mut().map(|v| strip_slot_parses(v, key, source)).sum(),
        _ => 0,
    }
}

fn diff(record: &Record) -> Option<String> {
    // Versions outside the supported ones (99) go through unchanged; the pin
    // shows TypeScript reads them as the current version, so Rust must too.
    let parsed = movement_parser::parse_program(&record.source, record.version);
    match (&record.expected, parsed) {
        (Expected::Ast { ast_sha256 }, Ok(ast)) => {
            let got = sha256_hex(&common::canonical(&ast));
            (&got != ast_sha256).then(|| format!("ast hash {got}, pinned {ast_sha256}"))
        }
        (Expected::Ast { .. }, Err(error)) => Some(format!("error {error}, pinned an ast")),
        (Expected::Error { error: pinned }, Ok(_)) => Some(format!("parsed, pinned error {pinned}")),
        (Expected::Error { error: pinned }, Err(error)) => {
            let got = as_pinned_error(&error);
            (&got != pinned).then(|| format!("error {got}, pinned {pinned}"))
        }
    }
}

/// The pin is `MovementParseError`'s message and point location. Rust emits
/// the base message; the TypeScript class appends ` (line N, col M)`, so the
/// comparison does too. Anything else the Rust error carries is not part of
/// the contract here.
fn as_pinned_error(error: &Value) -> Value {
    let message = error.get("message").and_then(Value::as_str);
    let line = error.pointer("/loc/line").and_then(Value::as_u64);
    let col = error.pointer("/loc/col").and_then(Value::as_u64);
    match (message, line, col) {
        (Some(message), Some(line), Some(col)) => json!({
            "message": format!("{message} (line {line}, col {col})"),
            "loc": { "line": line, "col": col },
        }),
        _ => json!({ "message": error.get("message"), "loc": error.get("loc") }),
    }
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn prefix(source: &str, chars: usize) -> String {
    source.chars().take(chars).collect()
}

#[test]
fn the_hash_is_taken_over_the_canonical_text_typescript_pins() {
    // The pin programs.json carries for the empty v1 program.
    let empty = json!({ "statements": [] });
    let pinned = "00ff6f8f85177c9eea82cc033ba1aea2ec68a8f4e6a4f42fb60aa98ab5fe40de";
    assert_eq!(sha256_hex(&common::canonical(&empty)), pinned);
}

#[test]
fn a_rust_error_compares_as_the_movement_parse_error_it_becomes() {
    let rust = json!({ "message": "boom", "loc": { "line": 2, "col": 3 } });
    let pinned = json!({ "message": "boom (line 2, col 3)", "loc": { "line": 2, "col": 3 } });
    assert_eq!(as_pinned_error(&rust), pinned);
}

/// A parked state carries code as its syntax tree (docs/contracts/
/// park-state.md), and a resume rebuilds the code from that tree: every
/// corpus program's tree reads back as the AST it was written from, and
/// writes out as the same tree again — the eager parse's slot trees, which
/// no park carries, aside.
#[test]
fn every_program_tree_reads_back_as_the_ast_it_was_written_from() {
    let mut read = 0usize;
    for record in records() {
        let Ok(program) = movement_parser::stmt::parse_program(&record.source, record.version, false) else { continue };
        let tree = serde_json::to_value(&program).unwrap();
        let back: movement_parser::ast::Program =
            serde_json::from_value(tree.clone()).unwrap_or_else(|e| panic!("v{} {:?}: {e}", record.version, prefix(&record.source, 80)));
        if back != program {
            let at = program.statements.iter().zip(&back.statements).find(|(a, b)| a != b);
            panic!("v{} {:?} reads back as another AST: {at:#?}", record.version, prefix(&record.source, 80));
        }
        assert_eq!(serde_json::to_value(&back).unwrap(), tree);
        read += 1;
    }
    assert!(read > 1000, "only {read} programs read back");
}

/// Every statement kind the corpus holds, at any depth, reads back from its
/// `kind` tag as the statement it was written from. (`Statement::kind` is
/// exhaustive over the variants, so a new one cannot be left unlisted there;
/// this proves each tag reads back.)
#[test]
fn a_statement_of_every_kind_reads_back_by_its_tag() {
    use movement_parser::ast::Statement;
    use std::collections::BTreeSet;

    fn walk(value: &Value, seen: &mut BTreeSet<&'static str>) {
        match value {
            Value::Object(map) => {
                if map.contains_key("kind") && map.contains_key("span") {
                    if let Ok(statement) = serde_json::from_value::<Statement>(value.clone()) {
                        assert_eq!(serde_json::to_value(&statement).unwrap(), *value);
                        seen.insert(statement.kind());
                    }
                }
                map.values().for_each(|v| walk(v, seen));
            }
            Value::Array(items) => items.iter().for_each(|v| walk(v, seen)),
            _ => {}
        }
    }

    let mut seen = BTreeSet::new();
    for record in records() {
        let Ok(program) = movement_parser::stmt::parse_program(&record.source, record.version, false) else { continue };
        walk(&serde_json::to_value(&program).unwrap(), &mut seen);
    }
    let every = [
        "assign", "await", "block", "call", "collection", "combinator", "delete", "error", "if", "import", "link", "listen",
        "match", "movement", "refresh", "return", "shape", "type", "unlink", "write",
    ];
    assert_eq!(seen.into_iter().collect::<Vec<_>>(), every);
}
