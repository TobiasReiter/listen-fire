//! A plugin's arguments by position from language version 5 (design §2.7),
//! through the Rust checker: its required inputs in the manifest's order,
//! then one settings record; the named form versions 1–4 write is refused
//! with the positional rewrite. The TypeScript twin is
//! packages/movement-lang/checker/__test__/v5_plugins.unit.test.ts.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{},"credentials":{},"plugins":{
  "fetch_url":{"args":["url","email"],"priced":false,"requiredArgs":["url"],"argTypes":{"url":"text","email":"text"},"effects":{},"output":{"kind":"value","type":"text"}},
  "research":{"args":["name","context","questions"],"priced":false,"requiredArgs":["name"],"argTypes":{"name":"text","context":"text","questions":"text"},"effects":{},"output":{"kind":"record","fields":{"summary":"text"}}},
  "vc_url_retrieval":{"args":["email"],"priced":false,"fedArgs":[{"name":"text","required":true}],"argTypes":{"text":"text","email":"text"},"effects":{},"output":{"kind":"value","type":"text"}},
  "linkedin_enrichment":{"args":["depth"],"priced":false,"fedArgs":[{"name":"text","required":true}],"requiredArgs":["depth"],"argTypes":{"depth":"number"}}
}}"#;

const HEAD4: &str = "import { fetch_url, research, vc_url_retrieval } from plugins\n\n";
const HEAD5: &str = "import { fetchUrl, research, vcUrlRetrieval } from plugins\n\n";

fn check(source: &str, version: u32) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap().into_iter().filter(|d| d.is_error()).collect()
}

fn codes(source: &str, version: u32) -> Vec<String> {
    check(source, version).into_iter().map(|d| d.code).collect()
}

fn v4(body: &str) -> String {
    format!("{HEAD4}movement go(u: <text>, n: <text>, s: <text>, t: <text>) {{\n{body}\n}}\n")
}

fn v5(body: &str) -> String {
    format!("{HEAD5}function go(u: <text>, n: <text>, s: <text>, t: <text>) {{\n{body}\n}}\n")
}

/// The source with each diagnostic's fix applied (ASCII text: a column is a character).
fn apply_fixes(source: &str, diagnostics: &[Diagnostic]) -> String {
    let lines: Vec<&str> = source.split('\n').collect();
    let offset = |line: u64, col: u64| lines[..line as usize - 1].iter().map(|l| l.len() + 1).sum::<usize>() + col as usize - 1;
    let mut edits: Vec<(usize, usize, String)> = diagnostics
        .iter()
        .filter_map(|d| d.fix.as_ref())
        .flat_map(|fix| fix["edits"].as_array().unwrap().clone())
        .map(|edit| {
            let at = |end: &str| offset(edit["span"][end]["line"].as_u64().unwrap(), edit["span"][end]["col"].as_u64().unwrap());
            (at("start"), at("end"), edit["text"].as_str().unwrap().to_string())
        })
        .collect();
    edits.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out = source.to_string();
    for (start, end, text) in edits {
        out.replace_range(start..end, &text);
    }
    out
}

#[test]
fn versions_1_to_4_keep_named_plugin_arguments() {
    assert_eq!(codes(&v4("  p = fetch_url(url: u)\n  r = research(name: n, context: s)\n  v = vc_url_retrieval(text: t, email: u)"), 4), Vec::<String>::new());
    assert_eq!(codes(&v4("  p = fetch_url(u)"), 4), vec!["MOV_PLUGIN_ARGS_NAMED".to_string()]);
}

#[test]
fn a_plugin_takes_its_required_inputs_by_position_and_the_rest_in_a_settings_record() {
    let program = v5("  p = fetchUrl(u)\n  r = research(n, { context: s, questions: s })\n  v = vcUrlRetrieval(t, { email: u })\n  w = fetchUrl(u, { email: s })");
    assert_eq!(check(&program, 5), Vec::<Diagnostic>::new());
    // A bare statement, a call as another's argument, and one nested in an expression.
    let nested = v5("  fetchUrl(u)
  r = research(fetchUrl(u), { context: s })
  x = Text.length(fetchUrl(u)) + 1");
    assert_eq!(check(&nested, 5), Vec::<Diagnostic>::new());
    assert_eq!(codes(&v5("  x = Text.upper(fetchUrl(u, s))"), 5), vec!["MOV_THROUGH_BAD_ARG".to_string()]);
}

#[test]
fn the_bound_call_is_checked_as_the_named_one_is() {
    // Too many by position, a setting that is positional, an unknown setting,
    // a last extra argument that is no record, a missing input.
    assert_eq!(codes(&v5("  p = fetchUrl(u, { url: s })"), 5), vec!["MOV_THROUGH_BAD_ARG".to_string()]);
    assert_eq!(codes(&v5("  r = research(n, { nope: s })"), 5), vec!["MOV_THROUGH_BAD_ARG".to_string()]);
    assert_eq!(codes(&v5("  p = fetchUrl(u, s)"), 5), vec!["MOV_THROUGH_BAD_ARG".to_string()]);
    assert_eq!(codes(&v5("  p = fetchUrl(u, { email: s }, s)"), 5), vec!["MOV_THROUGH_BAD_ARG".to_string()]);
    assert_eq!(codes(&v5("  r = research()"), 5), vec!["MOV_THROUGH_ARG_MISSING".to_string()]);
    let missing_fed = check(&v5("  v = vcUrlRetrieval()"), 5);
    assert_eq!(missing_fed.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), vec!["MOV_PLUGIN_FED_BY_EXTRACTION"]);
    assert!(missing_fed[0].message.contains("`vcUrlRetrieval(text)`"), "{}", missing_fed[0].message);
    // Each value is held to the type declared for the parameter it binds.
    assert_eq!(codes(&v5("  r = research(n)\n  p = fetchUrl(r)"), 5), vec!["MOV_CALL_ARG_TYPE".to_string()]);
    assert_eq!(codes(&v5("  r = research(n)\n  p = fetchUrl(u, { email: r })"), 5), vec!["MOV_CALL_ARG_TYPE".to_string()]);
    let extra = check(&v5("  p = fetchUrl(u, s)"), 5);
    assert_eq!(extra[0].message, "'fetchUrl' takes one argument by position (url), then its settings as one record `{ name: value }` — this argument is past them");
    assert_eq!((extra[0].span.start.line, extra[0].span.start.col), (4, 19));
    let past = check(&v5("  p = fetchUrl(u, { email: s }, s)"), 5);
    assert_eq!((past[0].span.start.col, past[0].span.end.col), (33, 34));
}

#[test]
fn a_settings_entry_is_reported_where_it_is_written() {
    let found = check(&v5("  r = research(n, { context: s, name: s })"), 5);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].message, "'name' is an argument 'research' takes by position — write it in its place, not in the settings record");
    assert_eq!((found[0].span.start.line, found[0].span.start.col, found[0].span.end.col), (4, 33, 37));
    let typed = check(&v5("  r = research(n)\n  q = research(n, { context: r })"), 5);
    assert_eq!(typed.iter().map(|d| (d.code.as_str(), d.span.start.line, d.span.start.col)).collect::<Vec<_>>(), vec![("MOV_CALL_ARG_TYPE", 5, 30)]);
}

#[test]
fn the_named_form_under_5_is_rewritten_by_position_from_the_manifest() {
    let fixes_of = |source: &str| -> Vec<(Option<String>, bool)> {
        check(source, 5)
            .into_iter()
            .filter(|d| d.code == "MOV_V5_SPELLING")
            .map(|d| {
                let text = d.fix.as_ref().map(|f| f["edits"][0]["text"].as_str().unwrap().to_string());
                (text, d.fix.as_ref().is_some_and(|f| f.get("safe") == Some(&serde_json::json!(true))))
            })
            .collect()
    };
    assert_eq!(fixes_of(&v5("  p = fetchUrl(url: u)")), vec![(Some("u".to_string()), true)]);
    assert_eq!(fixes_of(&v5("  r = research(name: n, context: s)")), vec![(Some("n, { context: s }".to_string()), true)]);
    assert_eq!(fixes_of(&v5("  v = vcUrlRetrieval(text: t, email: u)")), vec![(Some("t, { email: u }".to_string()), true)]);
    // Moved, the arguments would run in another order: a fix, not a safe one.
    assert_eq!(fixes_of(&v5("  r = research(context: s, name: n)")), vec![(Some("n, { context: s }".to_string()), false)]);
    // A name the manifest does not know, or an input never written: no rewrite.
    assert_eq!(fixes_of(&v5("  r = research(name: n, nope: s)")), vec![(None, false)]);
    assert_eq!(fixes_of(&v5("  r = research(context: s)")), vec![(None, false)]);
}

#[test]
fn the_rewrite_applied_checks_clean() {
    let program = v5("  p = fetchUrl(url: u)\n  r = research(name: n, context: s, questions: t)\n  v = vcUrlRetrieval(text: t, email: u)");
    let fixed = apply_fixes(&program, &check(&program, 5));
    assert!(fixed.contains("fetchUrl(u)") && fixed.contains("research(n, { context: s, questions: t })") && fixed.contains("vcUrlRetrieval(t, { email: u })"), "{fixed}");
    assert_eq!(check(&fixed, 5), Vec::<Diagnostic>::new());
}
