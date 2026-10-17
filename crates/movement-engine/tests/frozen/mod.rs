//! Frozen fixtures: one case per line (tests/frozen/<name>.jsonl), inputs
//! chosen for JavaScript's hazards, each with the answer the Rust engine
//! gives today. Rust is the reference for language version 5, so the file
//! is Rust's own: a test recomputes every answer and fails on the first
//! line that moved. When a change is meant to move answers, regenerate with
//! `FROZEN_REGENERATE=1 cargo test -p movement-engine --test <test>`
//! and read the diff of the .jsonl before committing it.
//!
//! The answers were first frozen from files the TypeScript engine had
//! written, wherever Rust agreed with it; the CHANGELOG names the places
//! version 5 answers differently on purpose.
#![allow(dead_code)]

use std::path::PathBuf;

use serde_json::Value as Json;

fn path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/frozen").join(format!("{name}.jsonl"))
}

/// The cases as recorded, in order.
pub fn cases(name: &str) -> Vec<Json> {
    let text = std::fs::read_to_string(path(name)).unwrap_or_else(|e| panic!("{name}.jsonl reads: {e}"));
    text.lines().map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("{name}.jsonl: {e}: {line}"))).collect()
}

/// Holds the file to `answered` (the same cases with Rust's answers), or
/// rewrites it when `FROZEN_REGENERATE` is set.
pub fn settle(name: &str, answered: &[Json]) {
    let lines: Vec<String> = answered.iter().map(Json::to_string).collect();
    let text = format!("{}\n", lines.join("\n"));
    if std::env::var_os("FROZEN_REGENERATE").is_some() {
        std::fs::write(path(name), text).expect("the frozen file writes");
        return;
    }
    let recorded = std::fs::read_to_string(path(name)).expect("the frozen file reads");
    let recorded: Vec<&str> = recorded.lines().collect();
    let moved: Vec<String> = lines
        .iter()
        .enumerate()
        .filter(|(i, line)| recorded.get(*i) != Some(&line.as_str()))
        .take(20)
        .map(|(i, line)| format!("line {}:\n  now      {line}\n  recorded {}", i + 1, recorded.get(i).unwrap_or(&"(none)")))
        .collect();
    assert!(
        moved.is_empty() && recorded.len() == lines.len(),
        "{name}.jsonl: {} cases recorded, {} answered; first moved:\n{}\n(FROZEN_REGENERATE=1 rewrites it)",
        recorded.len(),
        lines.len(),
        moved.join("\n")
    );
}

/// `case` with the keys in `drop` removed and `answer`'s entries set.
pub fn answer(case: &Json, drop: &[&str], answer: Vec<(&str, Json)>) -> Json {
    let mut object = case.as_object().expect("a case is an object").clone();
    for key in drop {
        object.remove(*key);
    }
    for (key, value) in answer {
        object.insert(key.to_string(), value);
    }
    Json::Object(object)
}
