//! Language version 5: `fail(…)` inside an expression (a value that never
//! arrives, TypeScript's `never`) and `sort` by a function key, through the
//! Rust checker. Versions 1–4 are unchanged.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"Acme CRM":{"positions":{"company":{"properties":{"name":"text","score":"number"},"edges":{}}},"collections":{"companies":{"target":"company"}},"writableRoots":{"companies":{"fields":{"name":"text"},"resultShape":{"externalId":"text","name":"text"}}}}}}},"credentials":{"Acme CRM":{"adapters":["attio"]}},"plugins":{}}"#;

fn check(source: &str, version: u32) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap_or_else(|e| panic!("{source}: {e:?}"))
}

fn codes(source: &str, version: u32) -> Vec<String> {
    let mut codes: Vec<String> = check(source, version).into_iter().map(|d| d.code).collect();
    codes.sort();
    codes
}

fn offset(source: &str, at: &serde_json::Value) -> usize {
    let (line, col) = (at["line"].as_u64().unwrap() as usize, at["col"].as_u64().unwrap() as usize);
    source.split_inclusive('\n').take(line - 1).map(str::len).sum::<usize>() + col - 1
}

/// Applies every MOV_V5_SPELLING fix that does not overlap one taken
/// already, until none is left (the upgrade tool's loop).
fn upgraded(source: &str) -> String {
    let mut text = source.to_string();
    for _ in 0..8 {
        let found: Vec<Diagnostic> = check(&text, 5).into_iter().filter(|d| d.code == "MOV_V5_SPELLING").collect();
        if found.is_empty() {
            return text;
        }
        let mut taken: Vec<(usize, usize, String)> = Vec::new();
        for d in &found {
            let fix = d.fix.as_ref().unwrap_or_else(|| panic!("{text}: no fix for {}", d.message));
            for e in fix["edits"].as_array().unwrap() {
                let (s, t) = (offset(&text, &e["span"]["start"]), offset(&text, &e["span"]["end"]));
                if taken.iter().all(|(ts, te, _)| t <= *ts || s >= *te || (s == t && s == *ts && t == *te && false)) {
                    taken.push((s, t, e["text"].as_str().unwrap().to_string()));
                }
            }
        }
        taken.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
        for (s, t, new) in taken {
            text.replace_range(s..t, &new);
        }
    }
    panic!("{text}: fixes did not settle")
}

const HEAD_V5: &str = "import { `@lf/attio` as attio } from adapters\nimport { `Acme CRM` } from credentials\ncrm = connect attio using `Acme CRM`\n";
const HEAD_V4: &str = "import { attio } from adapters\nimport { `Acme CRM` } from credentials\ncrm = attio(credentials: `Acme CRM`)\n";

fn v5(body: &str) -> String {
    format!("{HEAD_V5}function need(s: <text>) {{\n  return s\n}}\nfunction go(t: <text>, xs: <text[]>, co: <crm-[:company]->>) {{\n{body}\n}}\n")
}
fn v4(body: &str) -> String {
    format!("{HEAD_V4}movement go(t: <text>, xs: <text[]>, co: <crm-[:company]->>) {{\n{body}\n}}\n")
}


/// A body with `m` a text that may be absent.
fn with_m(body: &str) -> String {
    v5(&format!("  m = first(xs)\n{body}"))
}

fn clean(body: &str) {
    let source = with_m(body);
    assert_eq!(codes(&source, 5), Vec::<String>::new(), "{source}\n{:#?}", check(&source, 5));
}

fn refused(body: &str, code: &str) {
    let source = with_m(body);
    assert!(codes(&source, 5).contains(&code.to_string()), "{source}\n{:#?}", check(&source, 5));
}

const WRITE: &str = "  need(x)";

#[test]
fn fail_is_a_value_that_never_arrives() {
    // The control: a maybe-absent value into a required field.
    refused(&format!("  x = m\n{WRITE}"), "MOV_CALL_ARG_TYPE");
    // A union with a value that never arrives is its other member.
    clean(&format!("  x = coalesce(m, fail(\"no m\"))\n{WRITE}"));
    clean(&format!("  x = m != null ? m : fail(\"no m\")\n{WRITE}"));
    clean(&format!("  x = m == null ? fail(\"no m\") : m\n{WRITE}"));
    clean("  need(coalesce(m, fail(\"no m\")))");
    // Its other member keeps its own kind: a number is refused as a name.
    refused("  n = m != null ? 1 : fail(\"no m\")\n  need(n)", "MOV_CALL_ARG_TYPE");
    // Never written anywhere but where it fails: it fits every type.
    clean("  y = Text.upper(fail(\"stop\"))");
}

#[test]
fn code_after_an_arm_that_only_fails_knows_the_condition() {
    clean("  y = m != null ? m : fail(\"no m\")\n  need(m)");
    clean("  y = m == null ? fail(\"no m\") : 1\n  need(m)");
    clean("  y = coalesce(m, fail(\"no m\"))\n  need(m)");
    // Without the failing arm nothing is known below.
    refused("  y = m != null ? m : \"none\"\n  need(m)", "MOV_CALL_ARG_TYPE");
}

#[test]
fn versions_1_to_4_read_error_as_no_value() {
    let source = v4("  x = COALESCE(t, ERROR(\"no\"))");
    assert_eq!(codes(&source, 4), vec!["MOV_FUNCTION_UNKNOWN".to_string()]);
    // Under 5 the old word is respelled, and `fail` is no longer refused as not yet read.
    let refused = codes(&v5("  x = coalesce(t, fail(\"no\"))"), 5);
    assert!(refused.is_empty(), "{refused:?}");
}


const ROWS: &str = "  rows = List.from(crm-[:companies]->)";

/// The safe marker on the fix of the first finding with `code`.
fn fix_safe(source: &str) -> bool {
    let found = check(source, 5);
    let finding = found.iter().find(|d| d.code == "MOV_V5_SPELLING" && d.message.contains("its key a function")).unwrap_or_else(|| panic!("{source}\n{found:#?}"));
    finding.fix.as_ref().unwrap()["safe"] == serde_json::Value::Bool(true)
}

#[test]
fn sort_by_a_function_key() {
    clean(&format!("{ROWS}\n  x = sort(rows, (r) => Text.lower(r.name), {{ order: \"desc\" }})"));
    clean(&format!("{ROWS}\n  x = sort(rows, (r) => r.score)"));
    clean(&format!("{ROWS}\n  k = (r: <crm-[:company]->>) => r.score\n  x = sort(rows, k)"));
    // The members come back as themselves: a record's field reads off one.
    clean(&format!("{ROWS}\n  top = first(sort(rows, (r) => r.score, {{ order: \"desc\" }}))\n  need(coalesce(top.name, fail(\"no top\")))"));
    // Plain values by a computed key.
    clean("  x = sort(xs, (s) => Text.length(s))");
    // The key reads the member through its parameter, so an outer name never hides a field.
    clean(&format!("{ROWS}\n  name = \"z\"\n  x = sort(rows, (r) => r.name)"));
}

#[test]
fn sort_refuses_a_key_with_no_order() {
    refused(&format!("{ROWS}\n  x = sort(rows, (r) => r)\n  y = 1"), "MOV_SORT_NEEDS_KEY");
    refused(&format!("{ROWS}\n  x = sort(rows, (r) => co)"), "MOV_SORT_NEEDS_KEY");
    refused("  x = sort(xs, (s) => Text.split(s, \",\"))", "MOV_ORDER_KEY_MULTI");
    refused("  x = sort(xs, (s) => s, { order: \"down\" })", "MOV_V5_NOT_YET");
    refused("  x = sort(xs, (s) => Text.length(s), { order: \"down\" })", "MOV_COLLECTION_OP_CONFIG");
    refused("  x = sort(xs, (s) => Text.length(s), { by: \"desc\" })", "MOV_COLLECTION_OP_CONFIG");
    refused("  x = sort(xs, (s) => Text.length(s), 3)", "MOV_BUILTIN_ARGS");
    // No version before 5 has the tree's name.
    assert!(codes(&v4("  x = SORTBY(xs, (s) => s)"), 4).contains(&"MOV_FUNCTION_UNKNOWN".to_string()));
    // Under 5 the tree's name is an old spelling of `sort`.
    refused("  x = SORTBY(xs, (s) => Text.length(s))", "MOV_V5_SPELLING");
}

#[test]
fn the_old_field_key_upgrades_to_a_function_safe_only_where_no_variable_hides_the_field() {
    let old = v4("  rows = COLLECT(crm-[:companies]->)\n  x = SORT(rows, `score`, DESC)");
    let want = codes(&old, 4);
    let fixed = upgraded(&old);
    assert!(fixed.contains("sort(rows, (r) => r.score, { order: \"desc\" })"), "{fixed}");
    assert_eq!(codes(&fixed, 5), want, "{fixed}");
    assert!(fix_safe(&old));
    // An outer `score` was what the old key read: the rewrite reads the field.
    assert!(!fix_safe(&v4("  score = 3\n  rows = COLLECT(crm-[:companies]->)\n  x = SORT(rows, `score`, DESC)")));
    // So was an outer `r`, which the rewrite's parameter would hide.
    assert!(!fix_safe(&v4("  r = 3\n  rows = COLLECT(crm-[:companies]->)\n  x = SORT(rows, `score`)")));
    // A name bound elsewhere, out of scope at the sort, changes nothing.
    assert!(fix_safe(&v4("  rows = COLLECT(crm-[:companies]->)\n  x = SORT(rows, `score`)\n  if t == \"a\" {\n    score = 1\n  }")));
}
