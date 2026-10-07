//! Parses every expression text in packages/movement-lang/parser/expression/
//! __test__/__fixtures__/expression_slots.json and asserts none panics. The
//! trees themselves are pinned in expression_trees.json, beside it
//! (parser/expression/__test__/trees_regression.unit.test.ts).
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
#[ignore = "a sweep of the whole corpus; run with --ignored"]
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

/// Every corpus tree lowers without panicking, both ways, and lowers the
/// same from its JSON (the ABI's path, through the hand-written reader) as
/// from the tree itself.
#[test]
#[ignore = "a sweep of the whole corpus; run with --ignored"]
fn every_expression_tree_lowers_alike_from_its_json() {
    use movement_parser::lowering::{lower_condition, lower_condition_json, lower_expression, lower_expression_json};
    let path = common::fixture("parser/expression/__test__/__fixtures__/expression_slots.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
    let slots: Vec<Slot> = serde_json::from_str(&text).unwrap_or_else(|e| panic!("expression_slots.json: {e}"));
    let (mut lowered, mut refused) = (0usize, 0usize);
    for slot in &slots {
        let Ok(tree) = movement_parser::expr::parse_expression(&slot.raw) else { continue };
        let json = serde_json::to_value(&tree).unwrap();
        let direct = lower_expression(&tree, &slot.raw).map(|e| serde_json::to_value(e).unwrap());
        let via_json = lower_expression_json(&json, &slot.raw);
        assert_eq!(direct.is_ok(), via_json.is_ok(), "{}", slot.raw);
        if let (Ok(a), Ok(b)) = (&direct, &via_json) {
            assert_eq!(a, b, "{}", slot.raw);
        }
        let direct = lower_condition(&tree, &slot.raw).map(|c| serde_json::to_value(c).unwrap());
        let via_json = lower_condition_json(&json, &slot.raw);
        assert_eq!(direct.ok(), via_json.ok(), "{}", slot.raw);
        if lower_expression(&tree, &slot.raw).is_ok() { lowered += 1 } else { refused += 1 }
    }
    println!("expression_slots.json: {lowered} lowered, {refused} refused as expressions");
    assert!(lowered > 1000);
}
