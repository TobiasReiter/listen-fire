//! The Rust side of the check-answer parity (parity/answers.sh): replays
//! every record of the checker parity's corpus (`reference.jsonl`) through
//! `answer::check_answer` and compares its stamps and import link with the
//! TypeScript's (`answers.jsonl`, from answer_reference.ts). Stamps compare
//! as a set (the engine files them by path); a link's libraries by path.
//!
//! A program whose check blocks never runs, so its answer reaches no engine:
//! the counts say how many of the programs that would run agree.
//!
//! Usage: cargo run --release -p movement-checker --example answer_parity -- <work-dir>

use std::collections::{BTreeSet, HashMap};

use movement_checker::CheckOptions;
use movement_checker::answer::check_answer;
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::util::form::{read_json_text, units_vec};
use serde_json::Value;

#[derive(Default)]
struct Tally {
    records: usize,
    stamps_equal: usize,
    links_equal: usize,
    unplaced: usize,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let work = &args[1];
    let mut catalogs: HashMap<String, Result<CatalogSnapshot, String>> = HashMap::new();
    for line in std::fs::read_to_string(format!("{work}/snapshots.jsonl")).expect("snapshots.jsonl").lines() {
        #[derive(serde::Deserialize)]
        struct Row<'a> {
            key: String,
            #[serde(borrow)]
            snapshot: &'a serde_json::value::RawValue,
        }
        let line = read_json_text(line);
        let row: Row = serde_json::from_str(&line).expect("a snapshot row");
        catalogs.insert(row.key, CatalogSnapshot::load(row.snapshot.get()));
    }
    let reference = std::fs::read_to_string(format!("{work}/reference.jsonl")).expect("reference.jsonl");
    let answers = std::fs::read_to_string(format!("{work}/answers.jsonl")).expect("answers.jsonl");
    let (mut running, mut blocked) = (Tally::default(), Tally::default());
    let (mut skipped, mut panicked) = (0, 0);
    let mut samples = Vec::new();
    std::panic::set_hook(Box::new(|_| {}));
    for (record, answer) in reference.lines().zip(answers.lines()) {
        let record: Value = serde_json::from_str(&read_json_text(record)).expect("a reference row");
        let ts: Value = serde_json::from_str(&read_json_text(answer)).expect("an answer row");
        let Ok(catalog) = &catalogs[record["snapshot"].as_str().expect("a snapshot key")] else {
            skipped += 1;
            continue;
        };
        if ts.get("error").is_some() {
            skipped += 1;
            continue;
        }
        let source = String::from_utf16_lossy(&units_vec(record["source"].as_str().expect("a source")));
        let version = record["version"].as_u64().expect("a version") as u32;
        let options = CheckOptions {
            language_version: version,
            upgrading_from: record["upgradingFrom"].as_u64().map(|v| v as u32),
            parse_version: record["parseVersion"].as_u64().map(|v| v as u32),
            zones: &movement_checker::host::native::NativeZones,
        };
        let form = movement_parser::util::form::form_of_text(&source);
        let parse_version = options.parse_version.unwrap_or(version);
        let Ok(program) = movement_parser::stmt::parse_program(&form, parse_version, false) else {
            skipped += 1;
            continue;
        };
        let Ok(rust) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check_answer(&program, catalog, options))) else {
            panicked += 1;
            continue;
        };
        let tally = if ts["blocked"] == Value::Bool(true) { &mut blocked } else { &mut running };
        tally.records += 1;
        tally.unplaced += rust.unplaced.len();
        let set = |stamps: &[Value]| stamps.iter().map(|s| s.to_string()).collect::<BTreeSet<_>>();
        let ts_stamps = set(ts["stamps"].as_array().expect("stamps"));
        let rust_stamps = set(&rust.stamps);
        let stamps_equal = ts_stamps == rust_stamps;
        let link_equal = normal_link(ts.get("link")) == normal_link(rust.link.as_ref());
        tally.stamps_equal += usize::from(stamps_equal);
        tally.links_equal += usize::from(link_equal);
        if (!stamps_equal || !link_equal || !rust.unplaced.is_empty()) && samples.len() < 60 {
            let mut sample = format!("## v{version} blocked={} {}\n", ts["blocked"], record["corpus"]);
            for s in ts_stamps.difference(&rust_stamps) {
                sample += &format!("  only ts:   {s}\n");
            }
            for s in rust_stamps.difference(&ts_stamps) {
                sample += &format!("  only rust: {s}\n");
            }
            for u in &rust.unplaced {
                sample += &format!("  unplaced:  {u}\n");
            }
            if !link_equal {
                sample += &format!("  link ts:   {}\n  link rust: {}\n", normal_link(ts.get("link")), normal_link(rust.link.as_ref()));
            }
            sample += &format!("{}\n", record["source"].as_str().unwrap_or(""));
            samples.push(sample);
        }
    }
    std::fs::write(format!("{work}/answer_samples.txt"), samples.join("\n")).expect("answer_samples.txt");
    for (what, tally) in [("would run", &running), ("blocked by the check", &blocked)] {
        println!(
            "{what}: {} records; stamps equal {}; links equal {}; stamps unplaced {}",
            tally.records, tally.stamps_equal, tally.links_equal, tally.unplaced
        );
    }
    println!("skipped {skipped} (catalog, parse or the TypeScript failed); panicked {panicked}; samples in {work}/answer_samples.txt");
}

/// A link with its libraries in path order.
fn normal_link(link: Option<&Value>) -> Value {
    let Some(link) = link else { return Value::Null };
    let mut link = link.clone();
    if let Some(files) = link.get_mut("files").and_then(Value::as_array_mut) {
        files.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    }
    link
}
