//! A plugin fed only by an extraction (`linkedin_enrichment`: no inputs of
//! its own, it reads the record a `through […]` stage enriched) is a function
//! from language version 5: the record it runs on is its one positional
//! argument, and its call hands back what it declared. Versions 1–4 keep
//! refusing the call. The TypeScript twin is
//! packages/movement-lang/checker/__test__/v5_fed_by_extraction.unit.test.ts.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::plugin_args::PluginCallSite;
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{},"credentials":{},"plugins":{
  "linkedin_enrichment":{"args":[],"priced":false,"argTypes":{},"effects":{"reads":["the web"],"ai":true},"fedByExtraction":true,"output":{"kind":"record","fields":{"linkedin_url":{"kind":"maybeAbsent","of":"text"},"linkedin_profile":{"kind":"maybeAbsent","of":"text"}}}},
  "hidden_row":{"args":["text"],"requiredArgs":["text"],"priced":false,"argTypes":{"text":"text"}},
  "no_output":{"args":["text"],"requiredArgs":["text"],"priced":false,"argTypes":{"text":"text"},"effects":{"reads":["the web"]}}
}}"#;

fn catalog() -> CatalogSnapshot {
    CatalogSnapshot::load(CATALOG).unwrap()
}

fn check(source: &str, version: u32) -> Vec<Diagnostic> {
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog(), options).unwrap()
}

fn errors(source: &str, version: u32) -> Vec<Diagnostic> {
    check(source, version).into_iter().filter(|d| d.is_error()).collect()
}

fn codes(source: &str, version: u32) -> Vec<String> {
    errors(source, version).into_iter().map(|d| d.code).collect()
}

fn v5(body: &str) -> String {
    format!("import {{ linkedinEnrichment }} from plugins\n\nfunction go(n: <text>, c: <text>) {{\n{body}\n}}\n")
}

#[test]
fn the_record_a_stage_fed_is_the_one_positional_parameter_from_5() {
    let catalog = catalog();
    let spec = catalog.plugin("linkedin_enrichment").unwrap();
    assert_eq!(spec.under(5).positional_params(PluginCallSite::Plain), vec!["record"]);
    assert_eq!(&spec.under(4), spec);
}

#[test]
fn version_5_calls_it_with_the_record_and_types_what_it_hands_back() {
    let program = v5("  p = { name: n, company: { name: c } }\n  found = linkedinEnrichment(p)\n  url = coalesce(found.linkedin_url, \"\")");
    assert_eq!(errors(&program, 5), Vec::<Diagnostic>::new());
}

#[test]
fn version_5_refuses_a_call_without_the_record_naming_the_call_to_write() {
    let missing = errors(&v5("  found = linkedinEnrichment()"), 5);
    assert_eq!(missing.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), vec!["MOV_PLUGIN_FED_BY_EXTRACTION"]);
    assert!(missing[0].message.contains("`linkedinEnrichment(record)`"), "{}", missing[0].message);
}

#[test]
fn version_5_takes_nothing_past_the_record_but_a_settings_record() {
    assert_eq!(codes(&v5("  p = { name: n }\n  found = linkedinEnrichment(p, n)"), 5), vec!["MOV_THROUGH_BAD_ARG".to_string()]);
}

#[test]
fn version_5_reads_no_field_it_did_not_declare() {
    assert_ne!(codes(&v5("  p = { name: n }\n  found = linkedinEnrichment(p)\n  x = found.nope"), 5), Vec::<String>::new());
}

#[test]
fn the_extraction_keywords_hand_rewrite_points_at_the_call() {
    let program = "import { linkedinEnrichment } from plugins\n\nfunction go(u: <text>) {\n  found = extract from [u] {\n    name: \"the name\"\n  } through [linkedinEnrichment] {\n    detail: \"more\"\n  }\n}\n";
    let retired: Vec<String> = check(program, 5).into_iter().filter(|d| d.code == "MOV_EXTRACT_KEYWORD_RETIRED").map(|d| d.message).collect();
    assert_eq!(retired.len(), 1);
    assert!(
        retired[0].contains("map over the records calling each plugin ('linkedinEnrichment(record)'), extractOne over the content"),
        "{}",
        retired[0]
    );
}

#[test]
fn versions_1_to_4_keep_it_a_stage() {
    let program = "import { linkedin_enrichment } from plugins\n\nmovement go(n: <text>) {\n  found = linkedin_enrichment()\n}\n";
    let refused = errors(program, 4);
    assert_eq!(refused.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), vec!["MOV_PLUGIN_FED_BY_EXTRACTION"]);
    assert!(refused[0].message.contains("runs on what an extraction gives it and takes nothing of its own"));
}

/// Two plugins that never said what they do or hand back: a stage was their
/// only way in before 5, and from 5, with no stage, they are ordinary calls.
#[test]
fn a_plugin_that_has_not_declared_its_row_or_output_is_an_ordinary_call_from_5() {
    let v5 = "import { hiddenRow, noOutput } from plugins\n\nfunction go(n: <text>) {\n  a = hiddenRow(n)\n  b = noOutput(n)\n}\n";
    assert_eq!(codes(v5, 5), Vec::<String>::new());
    let v4 = "import { hidden_row, no_output } from plugins\n\nmovement go(n: <text>) {\n  a = hidden_row(text: n)\n  b = no_output(text: n)\n}\n";
    assert_eq!(codes(v4, 4), vec!["MOV_PLUGIN_ROW_UNDECLARED", "MOV_PLUGIN_OUTPUT_UNDECLARED"]);
    assert!(errors(v4, 4).iter().all(|d| d.message.contains("through [")));
}
