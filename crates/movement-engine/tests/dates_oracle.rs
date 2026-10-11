//! V8's date parser, mirrored in crate::js_date, held to Node's own answers
//! (tests/oracle/dates.json, written by tests/oracle/dates_oracle.ts through
//! generate.ts): `Date.parse` of 6,000 seeded date-ish texts, and `DATE`,
//! `DATE.FORMAT` and a filter's `<` over them, each in five local zones —
//! the engine handed the zone as a run's `localZone`, as the shim hands it
//! the process's.

use movement_engine::filter::compare_values;
use movement_engine::js::Js;
use movement_engine::js_date;
use movement_engine::stdlib::{self, Surroundings};
use movement_parser::lowering::expression::FilterOperator;
use serde_json::{Value as Json, json};

#[test]
fn dates_read_as_v8_reads_them_in_every_local_zone() {
    let text = include_str!("oracle/dates.json");
    let mut lines = text.lines();
    let header: Json = serde_json::from_str(lines.next().unwrap()).unwrap();
    let zones: Vec<&str> = header["zones"].as_array().unwrap().iter().map(|z| z.as_str().unwrap()).collect();
    let format = header["format"].as_str().unwrap();
    let cases: Vec<Json> = lines.map(|line| serde_json::from_str(line).unwrap()).collect();
    assert_eq!(cases.len(), 6000);
    assert_eq!(zones.len(), 5);
    let texts: Vec<&str> = cases.iter().map(|c| c["text"].as_str().unwrap()).collect();

    let mut mismatches = Vec::new();
    let mut zone_dependent = 0;
    for (z, zone) in zones.iter().enumerate() {
        let around = Surroundings { services: movement_engine::env_services::current(), now: Some(0.0), local_zone: Some(zone) };
        for (i, case) in cases.iter().enumerate() {
            let text = texts[i];
            let label = |what: &str| format!("{what}({text:?}) in {zone}");
            let parsed = js_date::parse(text, around.local());
            let want = case["parse"][z].as_f64();
            if parsed != want {
                mismatches.push(format!("{} = {parsed:?}, Node {want:?}", label("Date.parse")));
            }
            if z == 0 && case["parse"].as_array().unwrap().windows(2).any(|w| w[0] != w[1]) {
                zone_dependent += 1;
            }
            let date = stdlib::apply_flat("date", &[Js::str(text)], around).map(|v| movement_engine::env::encode(&v));
            if date.as_ref().ok() != Some(&case["date"][z]) {
                mismatches.push(format!("{} = {date:?}, TypeScript {}", label("DATE"), case["date"][z]));
            }
            let formatted = stdlib::apply_namespaced("date.format", &[Js::str(text), Js::str(format)], around).map(|v| movement_engine::env::encode(&v));
            if formatted.as_ref().ok() != Some(&case["format"][z]) {
                mismatches.push(format!("{} = {formatted:?}, TypeScript {}", label("DATE.FORMAT"), case["format"][z]));
            }
            let next = texts[(i + 1) % texts.len()];
            let lt = compare_values(&Js::str(text), FilterOperator::Lt, &Js::str(next), around.local()).map(|b| json!(b));
            if lt.as_ref().ok() != Some(&case["lt"][z]) {
                mismatches.push(format!("{} < {next:?} = {lt:?}, TypeScript {}", label("filter"), case["lt"][z]));
            }
        }
    }
    assert!(zone_dependent > 1000, "only {zone_dependent} texts read differently across the zones");
    assert!(mismatches.is_empty(), "{} mismatches:\n{}", mismatches.len(), mismatches.iter().take(60).cloned().collect::<Vec<_>>().join("\n"));
}
