//! Version 5 fix-ups the handbook found, through the Rust checker. The
//! TypeScript twin is packages/movement-lang/checker/__test__/v5_fixups.unit.test.ts.

use movement_checker::types::event_address::{EventAddress, event_address_of_hops};
use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{},"credentials":{},"plugins":{}}"#;

fn check(source: &str, version: u32) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap()
}

fn errors(source: &str, version: u32) -> Vec<String> {
    check(source, version).into_iter().filter(|d| d.is_error()).map(|d| format!("{}: {}", d.code, d.message)).collect()
}

#[test]
fn a_namespace_member_bound_whole_reads_as_its_old_spelling_did() {
    for call in [
        r#"Date.today("Europe/Berlin")"#,
        r#"DateTime.at(Date.today("UTC"), "07:00", "UTC")"#,
        "Date.addDays(@current_date, 1)",
        r#"Text.regexExtract("DEAL-1", "(DEAL-\\d+)")"#,
        r#"Currency.numberFromFigure("£1.2m")"#,
        r#"Text.slug("a b")"#,
    ] {
        assert_eq!(errors(&format!("function f() {{\n  t = {call}\n  return t\n}}"), 5), Vec::<String>::new(), "{call}");
        assert_eq!(errors(&format!("function f() {{\n  return {call}\n}}"), 5), Vec::<String>::new(), "{call}");
    }
    assert_eq!(errors("movement f() {\n  t = DATE.TODAY(\"UTC\")\n  return t\n}", 4), Vec::<String>::new());
    let unknown = errors("function f() {\n  t = Date.tomorrow(\"UTC\")\n  return t\n}", 5);
    assert!(unknown.iter().any(|e| e.starts_with("MOV_V5_UNKNOWN_MEMBER")), "{unknown:?}");
}

#[test]
fn an_address_reads_the_event_through_the_hops_alias_from_5() {
    let aliased = "-[e:`Webhook Event` WHERE e.action == \"record.created\"]->";
    let address = EventAddress { event: "Webhook Event".into(), narrowing: vec![("action".into(), "record.created".into())] };
    assert_eq!(movement_parser::surface::with_version(5, || event_address_of_hops(aliased)), Some(address.clone()));
    let bare = "-[:`Webhook Event` WHERE `action` == \"record.created\"]->";
    assert_eq!(movement_parser::surface::with_version(4, || event_address_of_hops(bare)), Some(address));
    assert_eq!(movement_parser::surface::with_version(4, || event_address_of_hops(aliased)), None);
}

#[test]
fn a_callback_closure_with_parameters_calls_the_function_checked_as_one() {
    let program = |param: &str| {
        format!("function book(name: <text>, day: <date>) {{\n  return \"${{name}} ${{day}}\"\n}}\n\nfunction offer() {{\n  pick = callback((day: {param}) => book(\"Acme\", day))\n  return pick.url\n}}")
    };
    assert_eq!(errors(&program("<date>"), 5), Vec::<String>::new());
    let mistyped = errors(&program("<number>"), 5);
    assert!(mistyped.iter().any(|e| e.starts_with("MOV_CALL_ARG_TYPE")), "{mistyped:?}");
    let deferred = "function chase(name: <text>) {\n  return name\n}\n\nfunction offer() {\n  again = callback(() => chase(\"Acme\"))\n  return again.url\n}";
    assert_eq!(errors(deferred, 5), Vec::<String>::new());
}

const CHAT: &str = r#"{"adapters":{"slack":{"constructionArgs":[],"schemas":{"":{"positions":{
  "channel":{"properties":{"Name":"text"},"edges":{"Messages":{"target":"message","readable":true,"sequenced":"chronological"}}},
  "message":{"properties":{"Text":"text"},"edges":{}}},
  "collections":{"Channels":{"target":"channel"}},"writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

fn presence_warnings(source: &str, version: u32, upgrading_from: Option<u32>) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(CHAT).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap().into_iter().filter(|d| d.code == "MOV_PRESENCE_OF_RETURNED").collect()
}

#[test]
fn a_move_up_across_5_warns_a_null_test_on_a_blocks_returned_records() {
    let v4 = |test: &str| {
        format!("import {{ slack }} from adapters\nchat = slack()\n\nmovement go(c: <chat-[:channel]->>) {{\n  found = c-[m:Messages WHERE `Text` == \"x\"]-> {{ return m }}\n  n = IF {test} THEN 1 ELSE 0 END\n  return n\n}}")
    };
    let v5 = |test: &str| {
        format!("import {{ `@lf/slack` as slack }} from adapters\nchat = connect slack\n\nfunction go(c: <chat-[:channel]->>) {{\n  found = c-[m:Messages WHERE m.Text == \"x\"]-> {{ return m }}\n  n = {test} ? 1 : 0\n  return n\n}}")
    };
    let warned = presence_warnings(&v4("found != NULL"), 5, Some(4));
    assert_eq!(warned.len(), 1, "{warned:?}");
    assert_eq!(warned[0].upgrade, Some(true));
    assert!(warned[0].message.contains("'found != null' says whether the block returned any records into 'found'"), "{}", warned[0].message);
    assert_eq!(presence_warnings(&v5("found == null"), 5, Some(4)).len(), 1);
    assert!(presence_warnings(&v4("found != NULL"), 4, None).is_empty());
    assert!(presence_warnings(&v5("found != null"), 5, None).is_empty());
    assert!(presence_warnings(&v4("EXISTS(found)"), 5, Some(4)).is_empty());
}

#[test]
fn a_move_up_across_5_warns_a_count_of_a_list_that_may_hold_an_empty_item() {
    let v4 = |list: &str| format!("movement f(t: <text>) {{\n  xs = {list}\n  return COUNT(xs)\n}}");
    let warned = |source: &str, version: u32, from: Option<u32>| -> Vec<Diagnostic> {
        let catalog = CatalogSnapshot::load(CATALOG).unwrap();
        let options = CheckOptions { language_version: version, upgrading_from: from, parse_version: None, zones: &movement_checker::host::native::NativeZones };
        check_source(source, &catalog, options).unwrap().into_iter().filter(|d| d.code == "MOV_COUNT_COUNTS_EMPTY").collect()
    };
    let found = warned(&v4("[t, NULL]"), 5, Some(4));
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].upgrade, Some(true));
    assert!(found[0].message.contains("count(filter(xs, (x) => x != null))"));
    assert!(warned(&v4("[t, \"b\"]"), 5, Some(4)).is_empty());
    assert!(warned(&v4("[t, NULL]"), 4, None).is_empty());
}

#[test]
fn length_and_exists_of_a_list_rewrite_to_count_marked_safe() {
    let source = "movement f(t: <text>) {\n  xs = [t, NULL]\n  n = LENGTH(xs)\n  ok = EXISTS(xs)\n  return n\n}";
    let fixes: Vec<(String, bool)> = check(source, 5)
        .into_iter()
        .filter(|d| d.code == "MOV_V5_SPELLING")
        .filter_map(|d| d.fix)
        .filter_map(|fix| {
            let text: String = fix["edits"].as_array()?.iter().filter_map(|e| e["text"].as_str()).collect();
            text.starts_with("count(").then(|| (text, fix["safe"].as_bool() == Some(true)))
        })
        .collect();
    assert_eq!(fixes, vec![("count(xs)".to_string(), true), ("count(xs) > 0".to_string(), true)]);
}
