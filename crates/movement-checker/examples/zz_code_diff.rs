//! Scratch (not committed): every miss/extra/message-diff of the codes named, with source line.
//! Usage: cargo run --release -p movement-checker --example zz_code_diff -- <work> CODE[,CODE…] [max]
use std::collections::HashMap;
use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;
use serde_json::Value;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let work = &args[1];
    let codes: Vec<&str> = args[2].split(',').collect();
    let max: usize = args.get(3).and_then(|m| m.parse().ok()).unwrap_or(40);
    let mut catalogs: HashMap<String, Result<CatalogSnapshot, String>> = HashMap::new();
    for line in std::fs::read_to_string(format!("{work}/snapshots.jsonl")).unwrap().lines() {
        let row: Value = serde_json::from_str(line).unwrap();
        catalogs.insert(row["key"].as_str().unwrap().to_string(), CatalogSnapshot::load(&row["snapshot"].to_string()));
    }
    let mut shown = 0;
    let (mut missing, mut extra, mut differ) = (0, 0, 0);
    for line in std::fs::read_to_string(format!("{work}/reference.jsonl")).unwrap().lines() {
        let record: Value = serde_json::from_str(line).unwrap();
        let source = record["source"].as_str().unwrap();
        let version = record["version"].as_u64().unwrap() as u32;
        let options = CheckOptions {
            language_version: version,
            upgrading_from: record["upgradingFrom"].as_u64().map(|v| v as u32),
            parse_version: record["parseVersion"].as_u64().map(|v| v as u32),
        };
        let Ok(catalog) = catalogs[record["snapshot"].as_str().unwrap()].as_ref() else { continue };
        let rust = match std::panic::catch_unwind(|| check_source(source, catalog, options)) {
            Ok(Ok(d)) => d.iter().map(|d| serde_json::to_value(d).unwrap()).collect::<Vec<_>>(),
            _ => continue,
        };
        let ts: Vec<Value> = record["ts"].as_array().unwrap().iter().filter(|d| codes.contains(&d["code"].as_str().unwrap())).cloned().collect();
        let mut left: Vec<Option<Value>> = rust.into_iter().filter(|d| codes.contains(&d["code"].as_str().unwrap())).map(Some).collect();
        let mut out = Vec::new();
        for d in &ts {
            if let Some(i) = left.iter().position(|r| r.as_ref() == Some(d)) { left[i] = None; continue; }
            if let Some(i) = left.iter().position(|r| r.as_ref().is_some_and(|r| r["code"] == d["code"] && r["span"] == d["span"])) {
                let r = left[i].take().unwrap();
                differ += 1;
                out.push(format!("DIFF {}\n  ts:   {}\n  rust: {}", d["code"], d["message"], r["message"]));
            } else {
                missing += 1;
                out.push(format!("MISSING {} {} {}", d["code"], d["span"], d["message"]));
            }
        }
        for r in left.into_iter().flatten() {
            extra += 1;
            out.push(format!("EXTRA {} {} {}", r["code"], r["span"], r["message"]));
        }
        if !out.is_empty() && shown < max {
            shown += 1;
            println!("==== v{version} {}\n{}\n---- source:\n{}", record["corpus"], out.join("\n"), source.trim());
        }
    }
    println!("TOTAL missing {missing} extra {extra} differ {differ}");
}
