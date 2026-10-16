//! A null test on a <text> field of a record the extraction call hands back
//! (`extract` / `extractOne`): a text the model did not find is "", never
//! absent, so the test can only ever answer one way. From version 5 it is
//! refused (MOV_PRESENCE_TEST_ON_TEXT), as the keyword's result has been
//! since 2; versions 3 and 4 let it through, so a move up across 5 is warned
//! of. The TypeScript twin is
//! checker/__test__/v5_text_presence.unit.test.ts, same programs, same
//! messages.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{},"credentials":{},"plugins":{}}"#;

fn check(body: &str, version: u32, upgrading_from: Option<u32>) -> Vec<(String, &'static str, String)> {
    let source = format!(
        "node Found: \"the extraction\" {{\n  title: <text> \"the title\"\n  maybe: <text | null> \"a title, if any\"\n  size: <number> \"how many\"\n  node item: \"each item\" {{\n    label: <text> \"its label\"\n  }}\n}}\nfunction go(t: <text>) {{\n  r = extractOne([t], Found)\n{body}\n}}\n"
    );
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let diagnostics: Vec<Diagnostic> = check_source(&source, &catalog, options).unwrap_or_else(|e| panic!("{source}: {e:?}"));
    diagnostics
        .into_iter()
        .filter(|d| d.code == "MOV_PRESENCE_TEST_ON_TEXT")
        .map(|d| {
            let severity = match d.severity.map(|s| format!("{s:?}")).as_deref() {
                None => "error",
                Some("Warning") => "warning",
                Some(_) => "info",
            };
            (d.code, severity, d.message)
        })
        .collect()
}

fn refused(label: &str, verdict: &str, fix: &str) -> String {
    format!("'{label}' is extracted text, and a text the model did not find is \"\" — never absent — so testing it for null is {verdict}. Annotate it `<text | null>` to keep the null test, or test whether it is empty instead: {fix}.")
}

fn error(message: String) -> (String, &'static str, String) {
    ("MOV_PRESENCE_TEST_ON_TEXT".to_string(), "error", message)
}

#[test]
fn under_5_a_null_test_on_a_text_field_is_refused_naming_the_emptiness_test() {
    assert_eq!(check("  if (r != null) {\n    if (r.title != null) { }\n  }", 5, None), vec![error(refused("r.title", "always true", "`r.title != \"\"` (or `Text.length(r.title) > 0`)"))]);
    assert_eq!(check("  if (r != null) {\n    if (r.title == null) { }\n  }", 5, None), vec![error(refused("r.title", "always false", "`r.title == \"\"`"))]);
}

#[test]
fn under_5_a_nested_nodes_text_field_is_refused_the_same_way() {
    assert_eq!(check("  if (r != null) {\n    r-[i:item]-> { if (i.label == null) { } }\n  }", 5, None), vec![error(refused("i.label", "always false", "`i.label == \"\"`"))]);
}

#[test]
fn under_5_a_nullable_text_field_and_a_typed_one_may_still_be_tested() {
    assert_eq!(check("  if (r != null) {\n    if (r.maybe != null) { }\n    if (r.size == null) { }\n  }", 5, None), vec![]);
}

#[test]
fn a_test_on_a_record_that_may_not_be_there_says_something_and_is_let_through() {
    assert_eq!(check("  if (r.title != null) { }", 5, None), vec![]);
}

#[test]
fn under_4_the_test_is_let_through_as_it_always_was() {
    assert_eq!(check("  if (r != null) {\n    if (r.title != null) { }\n    r-[i:item]-> { if (i.label == null) { } }\n  }", 4, None), vec![]);
}

#[test]
fn on_a_move_up_from_4_to_5_the_test_is_an_upgrade_warning() {
    assert_eq!(
        check("  if (r != null) {\n    if (r.title != null) { }\n  }", 5, Some(4)),
        vec![(
            "MOV_PRESENCE_TEST_ON_TEXT".to_string(),
            "warning",
            "since \"Dancing Wren\" (5) a null test on 'r.title' is refused: it is extracted text, and a text the model did not find is \"\" — never absent — so the test was always true. Annotate it `<text | null>` to keep the null test, or test whether it is empty instead: `r.title != \"\"` (or `Text.length(r.title) > 0`), then upgrade.".to_string()
        )]
    );
}
