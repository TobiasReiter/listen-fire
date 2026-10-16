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

#[test]
fn a_callback_closure_that_leaves_its_function_a_parameter_open_is_an_arity_error_from_5() {
    let program = |subject: &str, keyword: &str| {
        format!("{keyword} book(name: <text>, day: <date>) {{\n  return \"${{name}} ${{day}}\"\n}}\n\n{keyword} offer() {{\n  pick = callback({subject})\n  return pick.url\n}}")
    };
    let open = errors(&program("() => book(\"Acme\")", "function"), 5);
    assert_eq!(
        open,
        vec!["MOV_CALL_ARITY: 'book' takes 2 arguments, got 1 — a callback's closure is called with nothing, so it passes every argument itself, and what the platform sends when it fires is a parameter the closure declares: callback((d: <date>) => book(…, d))".to_string()]
    );
    assert_eq!(errors(&program("book", "function"), 5), Vec::<String>::new(), "a function named bare leaves its parameters to the platform");
    assert_eq!(errors(&program("book(\"Acme\")", "movement"), 4), Vec::<String>::new(), "versions 1–4 unchanged");
}

#[test]
fn the_arity_error_carries_the_closure_read_off_the_functions_signature() {
    let program = |prelude: &str, subject: &str| {
        format!("function book(name: <text>, day: <date>) {{\n  return \"${{name}} ${{day}}\"\n}}\n\nfunction offer() {{\n{prelude}  pick = callback({subject})\n  return pick.url\n}}")
    };
    let fix = |source: &str| {
        let d = check(source, 5).into_iter().find(|d| d.code == "MOV_CALL_ARITY").expect("an arity error");
        let fix = d.fix.expect("a fix");
        (fix["edits"][0]["text"].as_str().unwrap().to_string(), fix.get("safe").is_some())
    };
    assert_eq!(fix(&program("", "() => book(\"Acme\")")), ("(day: <date>) => book(\"Acme\", day)".to_string(), false), "never safe: the engines refuse the old form at run time");
    assert_eq!(fix(&program("  day = \"Acme\"\n", "() => book(day)")), ("(day: <date>) => book(day, day)".to_string(), false));
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

#[test]
fn a_message_calls_a_declaration_a_function_from_5() {
    let v5 = errors("function f() {\n  return nope(1)\n}", 5).join("\n");
    assert!(v5.contains("a call names a function declared or imported here, or a built-in"), "{v5}");
    let v4 = errors("movement f() {\n  return nope(1)\n}", 4).join("\n");
    assert!(v4.contains("a call names a movement or function declared or imported here, or a built-in"), "{v4}");
}

#[test]
fn a_member_read_off_an_index_binds_the_index_first_from_5() {
    for body in ["  r = [{ a: 1 }]\n  n = r[0].a", "  r = [[{ a: 1 }]]\n  n = r[0][0].a"] {
        assert_eq!(errors(&format!("function f() {{\n{body}\n  return n\n}}"), 5), Vec::<String>::new(), "{body}");
    }
}

#[test]
fn a_negative_literal_index_reads_the_tuples_slot_as_at_did() {
    let program = |index: &str| {
        format!("function g(n: <number>) {{\n  return n\n}}\n\nfunction f() {{\n  t = [\"a\", 2]\n  c = t[{index}]\n  return g(c)\n}}")
    };
    assert_eq!(errors(&program("-1"), 5), Vec::<String>::new());
    let first = errors(&program("0"), 5);
    assert!(first.iter().any(|e| e.starts_with("MOV_CALL_ARG_TYPE")), "{first:?}");
}

const REGISTRY: &str = r#"{"adapters":{"registry":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"public_registry":{"positions":{"entity":{"properties":{"Name":"text","City":"text"},"edges":{}}},"collections":{"entities":{"target":"entity"}},"writableRoots":{"entity":{"fields":{"Name":"text","City":"text"},"resultShape":{"externalId":"text","Name":"text","City":"text"},"fuzzyResolution":["Name"]}}}}}},"credentials":{"public_registry":{"adapters":["registry"]}},"plugins":{}}"#;

#[test]
fn a_targets_bare_field_is_respelled_through_the_alias_at_its_own_place() {
    let edits = |line: &str| -> Vec<(u64, u64, String)> {
        let source = format!(
            "import {{ registry }} from adapters\nimport {{ public_registry }} from credentials\nreg = registry(credentials: public_registry)\nmovement main() {{\n{line}\n}}"
        );
        let catalog = CatalogSnapshot::load(REGISTRY).unwrap();
        let options = CheckOptions { language_version: 5, upgrading_from: Some(4), parse_version: None, zones: &movement_checker::host::native::NativeZones };
        let found = check_source(&source, &catalog, options).unwrap();
        let d = found.into_iter().find(|d| d.code == "MOV_V5_SPELLING" && d.message.contains("hop's alias")).expect("a walk field respelling");
        d.fix.expect("a fix")["edits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (e["span"]["start"]["col"].as_u64().unwrap(), e["span"]["end"]["col"].as_u64().unwrap(), e["text"].as_str().unwrap().to_string()))
            .collect()
    };
    let expected = |at: u64| vec![(at, at, "e".to_string()), (at + 16, at + 22, "e.`City`".to_string())];
    // `  write reg-[` puts the colon at column 14; `  rows = reg-[` at 15.
    assert_eq!(edits("  write reg-[:entities WHERE `City` == \"x\"]-> { unique by (FUZZY `Name`), Name: \"a\" }"), expected(14));
    assert_eq!(edits("  m = match reg-[:entities WHERE `City` == \"x\"]-> { unique by (FUZZY `Name`), Name: \"a\" }"), expected(18));
    assert_eq!(edits("  rows = reg-[:entities WHERE `City` == \"x\"]->"), expected(15));
}
