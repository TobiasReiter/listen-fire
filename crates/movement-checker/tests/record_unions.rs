//! One rule for a value that may be one of several records — TypeScript's
//! union: an IF, a COALESCE, a function's returns and a list's members of
//! records of one type are that type, keeping only what every member vouches
//! for; of different types, a union that reads, walks and writes only what
//! every member offers. A read, a walk, a call's value and a list's member ran
//! under 3 and 4, so what the rule refuses there is an upgrade warning; a
//! write in place to such a value never ran, and its checks hold on every
//! version. The TypeScript checker's `record_unions.unit.test.ts` and
//! `maybe_record_write_target.unit.test.ts`, case for case, under 3, 4 and 5:
//! each expectation is the TypeScript checker's own answer on the same
//! program (every diagnostic, in order, with its span and severity), read off
//! it on 2026-10-16 into `record_unions.fixtures.json`.

use movement_checker::{CheckOptions, Severity, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

#[derive(serde::Deserialize)]
struct Case {
    file: String,
    name: String,
    catalog: String,
    source: String,
    version: u32,
    expected: Vec<String>,
}

fn diagnostics(case: &Case) -> Vec<String> {
    let catalog = CatalogSnapshot::load(&case.catalog).unwrap();
    let options = CheckOptions { language_version: case.version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&case.source, &catalog, options)
        .unwrap()
        .into_iter()
        .map(|d| {
            let severity = match d.severity {
                None => "error",
                Some(Severity::Warning) => "warning",
                Some(Severity::Info) => "info",
            };
            let upgrade = if d.upgrade == Some(true) { "+upgrade" } else { "" };
            format!("{} {}:{}-{}:{} {severity}{upgrade} {}", d.code, d.span.start.line, d.span.start.col, d.span.end.line, d.span.end.col, d.message)
        })
        .collect()
}

#[test]
fn every_case_answers_as_the_typescript_checker_does() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("record_unions.fixtures.json")).unwrap();
    let mut failures = Vec::new();
    for case in &cases {
        let found = diagnostics(case);
        if found != case.expected {
            failures.push(format!("{} / {} (version {}):\n  expected {:#?}\n  found    {:#?}", case.file, case.name, case.version, case.expected, found));
        }
    }
    assert!(failures.is_empty(), "{} of {} cases differ:\n{}", failures.len(), cases.len(), failures.join("\n"));
}
