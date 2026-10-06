//! Parses every expression text in packages/movement-lang/parser/expression/
//! __test__/__fixtures__/expression_slots.json and asserts none panics. Tree
//! parity is the TypeScript differential's job
//! (parser/__test__/rust_differential.unit.test.ts).
//!
//!   cargo test -p movement-parser --test expression_slots -- --ignored --nocapture

// Each test binary compiles its own copy and uses only part of it.
#[allow(dead_code)]
mod common;

use std::panic::{AssertUnwindSafe, catch_unwind};

use serde::Deserialize;

#[derive(Deserialize)]
struct Slot {
    raw: String,
}

#[test]
#[ignore = "the expression grammar is not ported yet; run with --ignored"]
fn every_expression_text_parses_without_panicking() {
    let path = common::fixture("parser/expression/__test__/__fixtures__/expression_slots.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
    let slots: Vec<Slot> = serde_json::from_str(&text).unwrap_or_else(|e| panic!("expression_slots.json: {e}"));
    assert!(slots.len() > 1000, "expression_slots.json has only {} records", slots.len());

    let (mut trees, mut errors) = (0usize, 0usize);
    let mut panicked = Vec::new();
    for slot in &slots {
        // The ABI's version argument; the TypeScript expression grammar reads
        // no version, so any supported one must give the same tree.
        match catch_unwind(AssertUnwindSafe(|| movement_parser::parse_expression(&slot.raw, 3))) {
            Ok(Ok(_)) => trees += 1,
            Ok(Err(_)) => errors += 1,
            Err(_) => panicked.push(serde_json::to_string(&slot.raw).unwrap()),
        }
    }

    println!(
        "expression_slots.json: {trees} trees, {errors} errors, {} panics of {}",
        panicked.len(),
        slots.len()
    );
    assert!(panicked.is_empty(), "parse_expression panicked on: {}", panicked.join(", "));
}
