//! Scratch (not committed): the first corpus record whose source contains ARG, both sides' diagnostics.
use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;
use serde_json::Value;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (work, needle) = (&args[1], &args[2]);
    let version_filter: Option<u64> = args.get(3).and_then(|v| v.parse().ok());
    let snaps: Vec<Value> = std::fs::read_to_string(format!("{work}/snapshots.jsonl")).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    for line in std::fs::read_to_string(format!("{work}/reference.jsonl")).unwrap().lines() {
        let record: Value = serde_json::from_str(line).unwrap();
        let source = record["source"].as_str().unwrap();
        if !source.contains(needle.as_str()) { continue; }
        let version = record["version"].as_u64().unwrap();
        if version_filter.is_some_and(|v| v != version) { continue; }
        let snap = snaps.iter().find(|s| s["key"] == record["snapshot"]).unwrap();
        let catalog = CatalogSnapshot::load(&snap["snapshot"].to_string()).unwrap();
        let options = CheckOptions { language_version: version as u32, upgrading_from: record["upgradingFrom"].as_u64().map(|v| v as u32), parse_version: record["parseVersion"].as_u64().map(|v| v as u32) };
        println!("v{version}\n{}\n-- TS:", source.trim());
        for d in record["ts"].as_array().unwrap() { println!("  {} {} {}", d["code"], d["span"], d["message"]); }
        println!("-- Rust:");
        for d in check_source(source, &catalog, options).unwrap() { println!("  {} {} {}", d.code, serde_json::to_string(&d.span).unwrap(), d.message); }
        return;
    }
}
