//! Conformance against packages/movement-lang/parser/__test__/__fixtures__/
//! programs.json: every program the TypeScript corpora parse, pinned by the
//! sha256 of its canonical AST or by the error it throws.
//!
//! A progress meter while the grammar is being ported, a gate afterwards:
//!   cargo test -p movement-parser --test programs -- --ignored --nocapture
//!   MOVEMENT_PARSER_STRICT=1 cargo test -p movement-parser --test programs -- --ignored

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

#[test]
#[ignore = "the program grammar is not ported yet; run with --ignored"]
fn every_pinned_program_parses_as_pinned() {
    let path = common::fixture("parser/__test__/__fixtures__/programs.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
    let records: Vec<Record> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
        .map(|(i, line)| serde_json::from_str(line).unwrap_or_else(|e| panic!("programs.json line {}: {e}", i + 1)))
        .collect();
    assert!(records.len() > 1000, "programs.json has only {} records", records.len());

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
    if std::env::var("MOVEMENT_PARSER_STRICT").as_deref() == Ok("1") {
        assert!(diffs.is_empty(), "{} of {} programs differ from their pins", diffs.len(), records.len());
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
