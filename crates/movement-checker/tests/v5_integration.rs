//! The v5 surface integration's own rules, through the Rust checker: letter
//! case counts in a call's name from 5; a WHERE's bare name is typed as the
//! engine reads it (a value binding before a field) on every version; an
//! alias read is the field under 5 even where the scope binds its name; and
//! which fixes are
//! marked safe to apply automatically. The TypeScript twin is
//! packages/movement-lang/checker/__test__/v5_integration.unit.test.ts.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"slack":{"constructionArgs":[],"schemas":{"":{"positions":{
  "channel":{"properties":{"Name":"text"},"edges":{"Messages":{"target":"message","readable":true,"sequenced":"chronological"}}},
  "message":{"properties":{"Body":"text","Score":"number"},"edges":{}}},
  "collections":{"Channels":{"target":"channel"}},"writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

const HEAD4: &str = "import { slack } from adapters\nchat = slack()\n\n";
const HEAD5: &str = "import { `@lf/slack` as slack } from adapters\nchat = connect slack\n\n";

fn check(source: &str, version: u32) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap()
}

fn errors(source: &str, version: u32) -> Vec<String> {
    check(source, version).into_iter().filter(|d| d.is_error()).map(|d| d.code).collect()
}

#[test]
fn a_function_call_matches_its_name_in_letter_case_from_version_5() {
    let v4 = format!("{HEAD4}movement helper(x: <text>) {{\n  return x\n}}\n\nmovement go() {{\n  y = Helper(\"a\")\n}}\n");
    assert_eq!(errors(&v4, 4), Vec::<String>::new());
    let v5 = format!("{HEAD5}function helper(x: <text>) {{\n  return x\n}}\n\nfunction go() {{\n  y = Helper(\"a\")\n}}\n");
    assert!(errors(&v5, 5).contains(&"MOV_FUNCTION_UNKNOWN".to_string()), "{:?}", check(&v5, 5));
    assert_eq!(errors(&v5.replace("Helper(", "helper("), 5), Vec::<String>::new());
}

#[test]
fn a_where_name_that_is_a_variable_and_a_field_is_typed_as_the_variable_the_engine_reads() {
    // `Score` is a number field and a text parameter: the engine compares the parameter.
    let v4 = format!("{HEAD4}movement go(c: <chat-[:channel]->>, Score: <text>) {{\n  ms = c-[m:Messages WHERE Score == \"high\"]->\n}}\n");
    assert_eq!(errors(&v4, 4), Vec::<String>::new());
    let v4_field = format!("{HEAD4}movement go(c: <chat-[:channel]->>) {{\n  ms = c-[m:Messages WHERE Score == \"high\"]->\n}}\n");
    assert!(errors(&v4_field, 4).contains(&"MOV_COMPARE_TYPE_MISMATCH".to_string()), "{:?}", check(&v4_field, 4));
}

#[test]
fn an_alias_read_is_the_field_even_where_the_scope_binds_its_name_under_5() {
    // `m.Body == Body`: the field against the variable, both text.
    let same = format!("{HEAD5}function go(c: <chat-[:channel]->>, Body: <text>) {{\n  ms = c-[m:Messages WHERE m.Body == Body]->\n}}\n");
    assert_eq!(errors(&same, 5), Vec::<String>::new(), "{:?}", check(&same, 5));
    // `m.Score` is the number field, not the text variable `Score`.
    let field = format!("{HEAD5}function go(c: <chat-[:channel]->>, Score: <text>) {{\n  ms = c-[m:Messages WHERE m.Score == \"high\"]->\n}}\n");
    assert!(errors(&field, 5).contains(&"MOV_COMPARE_TYPE_MISMATCH".to_string()), "{:?}", check(&field, 5));
    // The same through ORDER BY.
    let ordered = format!("{HEAD5}function go(c: <chat-[:channel]->>, Score: <text>) {{\n  ms = c-[m:Messages WHERE m.Body == Score ORDER BY m.Score DESC LIMIT 2]->\n}}\n");
    assert_eq!(errors(&ordered, 5), Vec::<String>::new(), "{:?}", check(&ordered, 5));
}

#[test]
fn only_fixes_that_keep_the_meaning_are_marked_safe() {
    let safe_of = |source: &str| -> Vec<(String, bool)> {
        check(source, 5)
            .into_iter()
            .filter(|d| d.code == "MOV_V5_SPELLING")
            .filter_map(|d| d.fix.map(|f| (d.message, f.get("safe") == Some(&serde_json::json!(true)))))
            .collect()
    };
    let program = format!("{HEAD5}function go(t: <text>) {{\n  a = UPPER(t)\n  b = ISNULL(t)\n}}\n");
    let found = safe_of(&program);
    assert!(found.iter().any(|(m, safe)| m.contains("UPPER") && *safe), "{found:?}");
    assert!(found.iter().any(|(m, safe)| m.contains("ISNULL") && !*safe), "{found:?}");
    // A walk field read through the alias: safe.
    let walk = format!("{HEAD5}function go(c: <chat-[:channel]->>) {{\n  ms = c-[m:Messages WHERE Body == \"x\"]->\n}}\n");
    assert!(safe_of(&walk).iter().all(|(_, safe)| *safe), "{:?}", safe_of(&walk));
}

/// Twin of v5_leftovers.unit.test.ts: a field read off text is refused from
/// 5 and warned under 3 and 4 (both engines read null); a three-argument
/// `map`'s settings go after the function from 5.
#[test]
fn a_field_read_off_text_and_a_map_s_settings_say_what_version_5_writes() {
    let text_read = |found: Vec<Diagnostic>| found.into_iter().filter(|d| d.code == "MOV_TEXT_HAS_NO_FIELDS").map(|d| d.is_error()).collect::<Vec<_>>();
    let v5 = format!("{HEAD5}function go(t: <text>) {{\n  d = t.Name\n}}\n");
    assert_eq!(text_read(check(&v5, 5)), vec![true]);
    let v4 = format!("{HEAD4}movement go(t: <text>) {{\n  d = t.Name\n}}\n");
    assert_eq!(text_read(check(&v4, 4)), vec![false]);
    assert_eq!(text_read(check(&v4, 3)), vec![false]);
    assert_eq!(text_read(check(&v4, 2)), Vec::<bool>::new());

    let map = format!("{HEAD5}function go() {{\n  a = map([1, 2], (x) => x, 5)\n}}\n");
    let found = check(&map, 5);
    let message = &found.iter().find(|d| d.code == "MOV_BUILTIN_ARGS").expect("refused").message;
    assert!(message.contains("after the function — `map(xs, f, {"), "{message}");
}
