//! The Rust side of the parity harness (parity/run.sh): replays every check
//! the TypeScript side wrote (`reference.jsonl`) through this crate and
//! compares, code by code.
//!
//! Per record, each diagnostic is paired with an identical one on the other
//! side (matched); a leftover pair with the same code and span differs only in
//! its message (message mismatch); what is still left is missing in Rust or
//! extra in Rust. Order is not compared here: the corpus pins it, and the
//! "exact" count says how many records also agree on it.
//!
//! Refused records (the Rust parser or catalog would not take them) are
//! listed by reason in `<work-dir>/refused.txt`.
//!
//! Usage: cargo run --release -p movement-checker --example parity -- <work-dir> <PARITY.md>

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;
use serde_json::Value;

#[derive(Default)]
struct Tally {
    ts: usize,
    rust: usize,
    matched: usize,
    missing: usize,
    extra: usize,
    mismatched: usize,
}

#[derive(Default)]
struct Corpus {
    records: usize,
    exact: usize,
    same_set: usize,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (work, out) = (&args[1], &args[2]);
    let families = families_of(&std::fs::read_to_string(std::path::Path::new(out).with_file_name("PORT.md")).expect("PORT.md"));
    let mut catalogs: HashMap<String, Result<CatalogSnapshot, String>> = HashMap::new();
    for line in std::fs::read_to_string(format!("{work}/snapshots.jsonl")).expect("snapshots.jsonl").lines() {
        // Raw, so the snapshot keeps the key order the TypeScript read (a
        // `Value` round trip would sort every object's keys).
        #[derive(serde::Deserialize)]
        struct Row<'a> {
            key: String,
            #[serde(borrow)]
            snapshot: &'a serde_json::value::RawValue,
        }
        let row: Row = serde_json::from_str(line).expect("a snapshot row");
        catalogs.insert(row.key, CatalogSnapshot::load(row.snapshot.get()));
    }
    let catalogs = Arc::new(catalogs);
    let mut worker = Worker::start(Arc::clone(&catalogs));
    let limit = Duration::from_secs(std::env::var("PARITY_TIMEOUT").ok().and_then(|n| n.parse().ok()).unwrap_or(20));
    let mut timed_out = 0;
    let mut codes: BTreeMap<String, Tally> = BTreeMap::new();
    let mut corpora: BTreeMap<String, Corpus> = BTreeMap::new();
    let mut samples: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let (mut refused, mut panicked) = (0, 0);
    // Why each refused record was refused (its TypeScript diagnostics are not
    // counted anywhere else), by reason, with the count and the first version and source seen.
    let mut refusals: BTreeMap<String, (usize, String)> = BTreeMap::new();
    let started = Instant::now();
    let reference = std::fs::read_to_string(format!("{work}/reference.jsonl")).expect("reference.jsonl");
    // PARITY_TRACE=1 names each record on stderr before checking it, so a hang names its record.
    let trace = std::env::var("PARITY_TRACE").is_ok();
    for (index, line) in reference.lines().enumerate() {
        if trace {
            eprintln!("record {index}");
        }
        let record: Value = serde_json::from_str(line).expect("a reference row");
        let source = record["source"].as_str().expect("a source");
        let version = record["version"].as_u64().expect("a version") as u32;
        let upgrading_from = record["upgradingFrom"].as_u64().map(|v| v as u32);
        let parse_version = record["parseVersion"].as_u64().map(|v| v as u32);
        let ts: Vec<Value> = record["ts"].as_array().expect("ts diagnostics").clone();
        let corpus = corpora.entry(record["corpus"].as_str().unwrap_or("?").to_string()).or_default();
        corpus.records += 1;
        let snapshot = record["snapshot"].as_str().expect("a snapshot key").to_string();
        if let Err(e) = &catalogs[&snapshot] {
            refused += 1;
            let reason = e.split(" at line ").next().unwrap_or("").to_string();
            let entry = refusals.entry(format!("catalog: {reason}")).or_insert_with(|| (0, format!("v{version}: {source}")));
            entry.0 += 1;
            continue;
        }
        let job = Job { source: source.to_string(), snapshot, version, upgrading_from, parse_version };
        let rust = match worker.check(job, limit) {
            Some(Outcome::Checked(diagnostics)) => diagnostics,
            Some(Outcome::Refused(message)) => {
                refused += 1;
                let reason = message.split(" at line ").next().unwrap_or("").to_string();
                let entry = refusals.entry(format!("parse: {reason}")).or_insert_with(|| (0, format!("v{version}: {source}")));
                entry.0 += 1;
                continue;
            }
            Some(Outcome::Panicked) => {
                panicked += 1;
                continue;
            }
            None => {
                // The check is still running past the limit: it is left behind
                // (the process exits at the end) and a fresh worker takes over.
                timed_out += 1;
                let entry = refusals
                    .entry(format!("timed out after {}s", limit.as_secs()))
                    .or_insert_with(|| (0, format!("record {index}, v{version}: {source}")));
                entry.0 += 1;
                worker = Worker::start(Arc::clone(&catalogs));
                continue;
            }
        };
        if ts == rust {
            corpus.exact += 1;
        }
        let mut left: Vec<Option<&Value>> = rust.iter().map(Some).collect();
        let mut unmatched_ts = Vec::new();
        for d in &ts {
            codes.entry(code(d)).or_default().ts += 1;
            match left.iter().position(|r| *r == Some(d)) {
                Some(i) => {
                    left[i] = None;
                    codes.get_mut(&code(d)).unwrap().matched += 1;
                }
                None => unmatched_ts.push(d),
            }
        }
        for d in &rust {
            codes.entry(code(d)).or_default().rust += 1;
        }
        let mut same_set = true;
        for d in unmatched_ts {
            same_set = false;
            let tally = codes.get_mut(&code(d)).unwrap();
            let pair = left.iter().position(|r| r.is_some_and(|r| r["code"] == d["code"] && r["span"] == d["span"]));
            let sample = match pair {
                Some(i) => {
                    tally.mismatched += 1;
                    let r = left[i].take().unwrap();
                    format!("MESSAGE v{version}\n  ts:   {}\n  rust: {}", d["message"], r["message"])
                }
                None => {
                    tally.missing += 1;
                    format!("MISSING v{version} {} {}", d["span"], d["message"])
                }
            };
            push_sample(&mut samples, code(d), sample, source, &d["span"]);
        }
        for r in left.into_iter().flatten() {
            same_set = false;
            codes.get_mut(&code(r)).unwrap().extra += 1;
            push_sample(&mut samples, code(r), format!("EXTRA v{version} {} {}", r["span"], r["message"]), source, &r["span"]);
        }
        if same_set {
            corpus.same_set += 1;
        }
    }
    let elapsed = started.elapsed().as_secs_f64();
    std::fs::write(format!("{work}/samples.txt"), samples.iter().map(|(c, s)| format!("## {c}\n{}\n", s.join("\n"))).collect::<String>())
        .expect("samples.txt");
    let mut by_count: Vec<_> = refusals.iter().collect();
    by_count.sort_by(|a, b| b.1.0.cmp(&a.1.0).then(a.0.cmp(b.0)));
    std::fs::write(
        format!("{work}/refused.txt"),
        by_count.iter().map(|(reason, (n, example))| format!("## {n} × {reason}\n{example}\n\n")).collect::<String>(),
    )
    .expect("refused.txt");
    let report = render(&codes, &corpora, &families, refused, panicked, timed_out, elapsed);
    std::fs::write(out, &report).expect("PARITY.md");
    print!("{}", report.split("\n## By family").next().unwrap_or(""));
    // A timed-out check may still be spinning on an abandoned worker.
    std::process::exit(0);
}

struct Job {
    source: String,
    snapshot: String,
    version: u32,
    upgrading_from: Option<u32>,
    parse_version: Option<u32>,
}

enum Outcome {
    Checked(Vec<Value>),
    Refused(String),
    Panicked,
}

/// Checks on a thread of its own, so a check that never ends (an exponential
/// case the TypeScript finishes) costs the harness one record, not the run.
struct Worker {
    jobs: mpsc::Sender<Job>,
    outcomes: mpsc::Receiver<Outcome>,
}

impl Worker {
    fn start(catalogs: Arc<HashMap<String, Result<CatalogSnapshot, String>>>) -> Worker {
        let (jobs, inbox) = mpsc::channel::<Job>();
        let (outbox, outcomes) = mpsc::channel();
        std::thread::spawn(move || {
            for job in inbox {
                let Ok(catalog) = catalogs[&job.snapshot].as_ref() else { unreachable!("refused before the job was sent") };
                let options = CheckOptions {
                    language_version: job.version,
                    upgrading_from: job.upgrading_from,
                    parse_version: job.parse_version,
                    zones: &movement_checker::host::native::NativeZones,
                };
                let outcome = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check_source(&job.source, catalog, options))) {
                    Ok(Ok(diagnostics)) => {
                        Outcome::Checked(diagnostics.iter().map(|d| serde_json::to_value(d).expect("a diagnostic")).collect())
                    }
                    Ok(Err(e)) => Outcome::Refused(e.message),
                    Err(_) => Outcome::Panicked,
                };
                if outbox.send(outcome).is_err() {
                    return;
                }
            }
        });
        Worker { jobs, outcomes }
    }

    /// `None` when the check outlives `limit`.
    fn check(&self, job: Job, limit: Duration) -> Option<Outcome> {
        self.jobs.send(job).expect("the worker is alive");
        self.outcomes.recv_timeout(limit).ok()
    }
}

fn code(d: &Value) -> String {
    d["code"].as_str().unwrap_or("?").to_string()
}

/// Up to 12 per code, each with the source line its span starts on.
fn push_sample(samples: &mut BTreeMap<String, Vec<String>>, code: String, sample: String, source: &str, span: &Value) {
    if std::env::var("PARITY_NO_MISSING").is_ok() && sample.starts_with("MISSING") {
        return;
    }
    let list = samples.entry(code).or_default();
    if list.len() < std::env::var("PARITY_SAMPLES").ok().and_then(|n| n.parse().ok()).unwrap_or(12) {
        let line = span["start"]["line"].as_u64().unwrap_or(1) as usize;
        let text = source.lines().nth(line.saturating_sub(1)).unwrap_or("");
        list.push(format!("{sample}\n  line {line}: {}", text.trim()));
    }
}

/// Each code's family, read from PORT.md's family tables (`### <family>`).
fn families_of(port: &str) -> HashMap<String, String> {
    let mut family = String::new();
    let mut out = HashMap::new();
    for line in port.lines() {
        if let Some(name) = line.strip_prefix("### ") {
            family = name.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("| MOV_") {
            let code = format!("MOV_{}", rest.split(' ').next().unwrap_or(""));
            out.insert(code, family.clone());
        }
    }
    out
}

fn render(
    codes: &BTreeMap<String, Tally>,
    corpora: &BTreeMap<String, Corpus>,
    families: &HashMap<String, String>,
    refused: usize,
    panicked: usize,
    timed_out: usize,
    elapsed: f64,
) -> String {
    let at_parity = |t: &Tally| t.ts > 0 && t.missing == 0 && t.extra == 0 && t.mismatched == 0;
    let seen: Vec<_> = codes.iter().filter(|(_, t)| t.ts > 0).collect();
    let parity = seen.iter().filter(|(_, t)| at_parity(t)).count();
    let (ts, matched): (usize, usize) = codes.values().fold((0, 0), |(a, b), t| (a + t.ts, b + t.matched));
    let extra: usize = codes.values().map(|t| t.extra).sum();
    let records: usize = corpora.values().map(|c| c.records).sum();
    let exact: usize = corpora.values().map(|c| c.exact).sum();
    let mut s = String::new();
    writeln!(s, "# Checker parity: Rust against TypeScript\n").unwrap();
    writeln!(s, "Written by `crates/movement-checker/parity/run.sh`. Do not edit by hand.\n").unwrap();
    writeln!(s, "- Codes at parity: **{parity} of {}** codes the TypeScript checker reports on this corpus.", seen.len()).unwrap();
    writeln!(s, "- Diagnostics matched: {matched} of {ts}; {extra} extra in Rust.").unwrap();
    writeln!(s, "- Records with exactly the TypeScript's diagnostics, in its order: {exact} of {records}.").unwrap();
    writeln!(s, "- Rust side: {elapsed:.1}s; {refused} records the Rust parser or catalog refused; {panicked} panics; {timed_out} checks that did not finish (refused.txt names them).\n").unwrap();
    writeln!(s, "A code is at parity when every diagnostic of it on the corpus is matched exactly and Rust reports none extra.\n").unwrap();
    writeln!(s, "| corpus | records | exact | same diagnostics, any order |\n|---|---|---|---|").unwrap();
    for (name, c) in corpora {
        writeln!(s, "| {name} | {} | {} | {} |", c.records, c.exact, c.same_set).unwrap();
    }
    writeln!(s, "\n## By family\n\n| family | codes seen | at parity | TS diagnostics | matched | missing | extra | message differs |\n|---|---|---|---|---|---|---|---|").unwrap();
    let mut by_family: BTreeMap<&str, (usize, usize, Tally)> = BTreeMap::new();
    for (c, t) in codes {
        let family = families.get(c).map_or("(not in PORT.md)", String::as_str);
        let entry = by_family.entry(family).or_default();
        if t.ts > 0 {
            entry.0 += 1;
        }
        if at_parity(t) {
            entry.1 += 1;
        }
        entry.2.ts += t.ts;
        entry.2.matched += t.matched;
        entry.2.missing += t.missing;
        entry.2.extra += t.extra;
        entry.2.mismatched += t.mismatched;
    }
    for (family, (seen, parity, t)) in &by_family {
        writeln!(s, "| {family} | {seen} | {parity} | {} | {} | {} | {} | {} |", t.ts, t.matched, t.missing, t.extra, t.mismatched).unwrap();
    }
    writeln!(s, "\n## By code\n\n| code | family | TS | matched | missing in Rust | extra in Rust | message differs | parity |\n|---|---|---|---|---|---|---|---|").unwrap();
    for (c, t) in codes {
        let family = families.get(c).map_or("?", String::as_str);
        let mark = if at_parity(t) { "yes" } else { "" };
        writeln!(s, "| {c} | {family} | {} | {} | {} | {} | {} | {mark} |", t.ts, t.matched, t.missing, t.extra, t.mismatched).unwrap();
    }
    s
}
