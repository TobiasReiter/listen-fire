//! The two implementations of the environment services agree: the native
//! one (jiff, url, ICU4X) answers every request in tests/env/fixture.json as
//! Node answered it through packages/movement-lang/wasm/env_services.ts,
//! which is the WASM artifact's implementation (the loader's import).

#![cfg(feature = "native-env")]

use std::collections::BTreeMap;

use movement_engine::env_services::{self, Op};
use serde_json::{Value as Json, json};

/// Every number a double: `3` and `3.0` are one JavaScript number.
fn shape(json: &Json) -> Json {
    match json {
        Json::Number(n) => json!(n.as_f64().unwrap()),
        Json::Array(items) => Json::Array(items.iter().map(shape).collect()),
        Json::Object(entries) => Json::Object(entries.iter().map(|(k, v)| (k.clone(), shape(v))).collect()),
        other => other.clone(),
    }
}

/// The zone data both sides read is one release: a Node upgrade that moves
/// its ICU's tzdata must move the jiff-tzdb pin with it.
#[test]
fn both_sides_read_one_zone_database() {
    let versions: Json = serde_json::from_str(include_str!("env/versions.json")).unwrap();
    assert_eq!(env_services::native::tz_version(), versions["tz"].as_str());
}

#[test]
fn the_native_services_answer_as_node_does() {
    let cases: Vec<Json> = serde_json::from_str(include_str!("env/fixture.json")).unwrap();
    let services = env_services::current();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut mismatches: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for case in &cases {
        let op = case["request"]["op"].as_str().unwrap().to_string();
        *counts.entry(op.clone()).or_default() += 1;
        let got = Op::answer_with(&case["request"], services).unwrap();
        if shape(&got) != shape(&case["answer"]) {
            mismatches.entry(op).or_default().push(format!("{}\n    native {got}\n    node   {}", case["request"], case["answer"]));
        }
    }
    eprintln!("{} cases: {counts:?}", cases.len());
    let total: usize = mismatches.values().map(Vec::len).sum();
    let report: Vec<String> = mismatches
        .iter()
        .map(|(op, list)| format!("{op}: {} differ\n  {}", list.len(), list.iter().take(25).cloned().collect::<Vec<_>>().join("\n  ")))
        .collect();
    assert!(total == 0, "{total} of {} differ:\n{}", cases.len(), report.join("\n"));
}
