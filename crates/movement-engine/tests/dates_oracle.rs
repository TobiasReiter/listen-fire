//! Dates held to Node's answers in UTC (tests/oracle/dates.json, written by
//! tests/oracle/dates_oracle.ts through generate.ts): `Date.parse` of 6,000
//! seeded date-ish texts, and `DATE`, `DATE.FORMAT` and a filter's `<` over
//! them. Version 5 reads a date-time text as ISO 8601 / RFC 3339 only, with
//! no offset meaning UTC: where V8 read a legacy form (`"Mar 5, 2024"`,
//! `"item 3"`, a text with a space around it) or a day past its month's
//! end, version 5 reads no date, and only those texts may answer
//! differently. The oracle's other zones are
//! not read: a run has no local zone.

use movement_engine::filter::compare_values;
use movement_engine::js::Js;
use movement_engine::js_date;
use movement_engine::stdlib::{self, Surroundings};
use movement_parser::lowering::expression::FilterOperator;
use serde_json::{Value as Json, json};

#[test]
fn dates_read_as_node_reads_iso_texts_in_utc() {
    let text = include_str!("oracle/dates.json");
    let mut lines = text.lines();
    let header: Json = serde_json::from_str(lines.next().unwrap()).unwrap();
    let zones: Vec<&str> = header["zones"].as_array().unwrap().iter().map(|z| z.as_str().unwrap()).collect();
    let z = zones.iter().position(|zone| *zone == "UTC").expect("the oracle reads UTC");
    let format = header["format"].as_str().unwrap();
    let cases: Vec<Json> = lines.map(|line| serde_json::from_str(line).unwrap()).collect();
    assert_eq!(cases.len(), 6000);
    let texts: Vec<&str> = cases.iter().map(|c| c["text"].as_str().unwrap()).collect();
    // A text V8 read and version 5 does not: its answers may differ.
    let refused = |text: &str, case: &Json| js_date::parse(text).is_none() && case["parse"][z].as_f64().is_some();

    let around = Surroundings { services: movement_engine::env_services::current(), now: Some(0.0) };
    let mut mismatches = Vec::new();
    let mut refused_count = 0;
    for (i, case) in cases.iter().enumerate() {
        let text = texts[i];
        let label = |what: &str| format!("{what}({text:?})");
        if refused(text, case) {
            refused_count += 1;
            continue;
        }
        let parsed = js_date::parse(text);
        let want = case["parse"][z].as_f64();
        if parsed != want {
            mismatches.push(format!("{} = {parsed:?}, Node {want:?}", label("Date.parse")));
        }
        let date = stdlib::apply_flat("date", &[Js::str(text)]).map(|v| movement_engine::env::encode(&v));
        if date.as_ref().ok() != Some(&case["date"][z]) {
            mismatches.push(format!("{} = {date:?}, TypeScript {}", label("DATE"), case["date"][z]));
        }
        let formatted = stdlib::apply_namespaced("date.format", &[Js::str(text), Js::str(format)], around).map(|v| movement_engine::env::encode(&v));
        if formatted.as_ref().ok() != Some(&case["format"][z]) {
            mismatches.push(format!("{} = {formatted:?}, TypeScript {}", label("DATE.FORMAT"), case["format"][z]));
        }
        let j = (i + 1) % texts.len();
        if refused(texts[j], &cases[j]) {
            continue;
        }
        let lt = compare_values(&Js::str(text), FilterOperator::Lt, &Js::str(texts[j])).map(|b| json!(b));
        if lt.as_ref().ok() != Some(&case["lt"][z]) {
            mismatches.push(format!("{} < {:?} = {lt:?}, TypeScript {}", label("filter"), texts[j], case["lt"][z]));
        }
    }
    eprintln!("{refused_count} of {} texts V8 read as dates are no date from version 5", cases.len());
    assert!(mismatches.is_empty(), "{} mismatches:\n{}", mismatches.len(), mismatches.iter().take(60).cloned().collect::<Vec<_>>().join("\n"));
}

/// `"item 3" < "item 12"` compares the texts: V8 read both as dates.
#[test]
fn texts_that_only_v8_read_as_dates_compare_as_texts() {
    assert!(!compare_values(&Js::str("item 3"), FilterOperator::Lt, &Js::str("item 12")).unwrap());
    assert!(compare_values(&Js::str("2026-03-05T10:00"), FilterOperator::Lt, &Js::str("2026-03-05T10:00:01Z")).unwrap());
}
