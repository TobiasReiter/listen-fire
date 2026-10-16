//! Spine gaps of language version 5's surface (plans/naming-rethink-2026-10-14/
//! 5_design.md), each through the Rust checker: the v5 form checks as the old
//! form does under 4, the old form under 5 is MOV_V5_SPELLING with a fix, and
//! applying the fixes gives text that checks under 5 as the old form did
//! under 4. Versions 1–4 are unchanged.

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
    format!("{HEAD_V5}function go(t: <text>, xs: <text[]>, co: <crm-[:company]->>) {{\n{body}\n}}\n")
}
fn v4(body: &str) -> String {
    format!("{HEAD_V4}movement go(t: <text>, xs: <text[]>, co: <crm-[:company]->>) {{\n{body}\n}}\n")
}

/// The v5 form under 5 checks as the old form under 4; the old form under 5
/// is refused with fixes, and the fixed text checks under 5 as the old did.
fn same(new: &str, old: &str) {
    let (new, old) = (v5(new), v4(old));
    let want = codes(&old, 4);
    assert!(want.iter().all(|c| !c.starts_with("MOV_UNKNOWN")), "{old}: {want:?}");
    assert_eq!(codes(&new, 5), want, "{new}\n{:#?}", check(&new, 5));
    let refused = check(&old, 5);
    assert!(refused.iter().any(|d| d.code == "MOV_V5_SPELLING"), "{old}");
    let fixed = upgraded(&old);
    assert_eq!(codes(&fixed, 5), want, "{old}\nupgraded to\n{fixed}\n{:#?}", check(&fixed, 5));
}

#[test]
fn fail_is_the_error_statement() {
    same("  if (t == null) {\n    fail(\"no text\")\n  }\n  y = Text.upper(t)", "  if t == NULL {\n    ERROR(\"no text\")\n  }\n  y = UPPER(t)");
    same("  fail(\"always\")", "  ERROR(\"always\")");
    same("  if (t == null) { fail(\"no text\") }", "  if t == NULL { ERROR(\"no text\") }");
    let refused = check(&v4("  ERROR(\"x\")"), 5);
    let error = refused.iter().find(|d| d.message.contains("`ERROR`")).unwrap();
    assert_eq!(error.fix.as_ref().unwrap()["edits"][0]["text"], "fail");
    // Under 4 `fail` is a name like any other.
    assert!(codes(&v4("  fail(\"x\")"), 4).contains(&"MOV_FUNCTION_UNKNOWN".to_string()));
    // Inside an expression it is a value that never arrives (v5_never_sort).
    assert!(!codes(&v5("  x = coalesce(t, fail(\"no\"))"), 5).contains(&"MOV_V5_NOT_YET".to_string()));
}

#[test]
fn is_inside_the_if_parentheses_narrows() {
    same("  y = 1\n  if (co is <crm-[:company]->>) {\n    n = co.name\n  }", "  y = 1\n  if co IS <crm-[:company]->> {\n    n = co.name\n  }");
    same(
        "  y = 1\n  if (co is <crm-[:company]->> && t != null) {\n    n = co.name\n  }",
        "  y = 1\n  if co IS <crm-[:company]->> AND t != NULL {\n    n = co.name\n  }",
    );
}

#[test]
fn closure_taking_built_ins_bind_in_v5_order() {
    same("  x = map(xs, (s) => Text.upper(s), { concurrency: 2 })", "  x = MAP(xs, { concurrency: 2 }, (s) => UPPER(s))");
    same("  x = map(xs, (s) => {\n    return Text.upper(s)\n  }, { concurrency: 2 })", "  x = MAP(xs, { concurrency: 2 }, (s) => {\n    return UPPER(s)\n  })");
    same("  map(xs, (s) => {\n    write crm-[:companies]-> { name: s }\n  }, { onError: \"warn\" })", "  MAP(xs, { onError: \"warn\" }, (s) => {\n    write crm-[:companies]-> { name: s }\n  })");
    same("  x = filter(xs, (s) => Text.length(s) > 0)", "  x = FILTER(xs, (s) => LENGTH(s) > 0)");
    same("  x = reduce(xs, (a, s) => a + Text.length(s), 0)", "  x = REDUCE(xs, 0, (a, s) => a + LENGTH(s))");
    same("  x = reduce(xs, (a: <number>, s: <text>) => a + Text.length(s), 0)", "  x = REDUCE(xs, 0, (a: <number>, s: <text>) => a + LENGTH(s))");
    same("  g = (a: <number>, s: <text>) => a + Text.length(s)\n  x = reduce(xs, g, 0)", "  g = (a: <number>, s: <text>) => a + LENGTH(s)\n  x = REDUCE(xs, 0, g)");
    same("  x = List.groupBy(xs, (s) => Text.lower(s))", "  x = GROUPBY(xs, (s) => LOWER(s))");
    same("  x = List.keyBy(xs, (s) => Text.lower(s))", "  x = KEYBY(xs, (s) => LOWER(s))");
    same("  x = count(List.keyBy(xs, (s) => Text.lower(s)))", "  x = COUNT(KEYBY(xs, (s) => LOWER(s)))");
    // A wrong argument still reads as the canonical call's.
    same("  x = reduce(xs, 0, (a, s) => a)", "  x = REDUCE(xs, (a, s) => a, 0)");
}

#[test]
fn sort_with_no_key_or_by_itself() {
    same("  x = sort(xs)", "  x = SORT(xs)");
    same("  x = sort(xs, { order: \"desc\" })", "  x = SORT(xs, DESC)");
    same("  x = first(sort(xs))", "  x = FIRST(SORT(xs))");
    same("  x = sort(xs, (s) => s, { order: \"desc\" })", "  x = SORT(xs, DESC)");
    same("  rows = List.from(co-[:companies]->)\n  x = sort(rows, (r) => r.score, { order: \"desc\" })", "  rows = COLLECT(co-[:companies]->)\n  x = SORT(rows, `score`, DESC)");
}

#[test]
fn indexing_reads_in_every_slot() {
    same("  y = \"${xs[0]}\"", "  y = \"${AT(xs, 0)}\"");
    same("  write crm-[:companies]-> { name: xs[0] }", "  write crm-[:companies]-> { name: AT(xs, 0) }");
    same("  write crm-[:companies]-> { name: \"${xs[1]}!\" }", "  write crm-[:companies]-> { name: \"${AT(xs, 1)}!\" }");
}

#[test]
fn await_first_is_lower_case() {
    same("  q = co\n  x = await first(q-[:companies]->)", "  q = co\n  x = await FIRST(q-[:companies]->)");
}

#[test]
fn callback_takes_a_deferred_call() {
    same("  x = callback(() => go(t, xs, co))", "  x = callback(go(t, xs, co))");
    same("  x = callback(() => {\n    y = 1\n  })", "  x = callback({\n    y = 1\n  })");
}

#[test]
fn a_backticked_credential_after_using() {
    same("  y = 1", "  y = 1");
    // The fix keeps a hyphenated adapter's backticks.
    let old = "import { `my-crm` } from adapters\nimport { `Acme CRM` } from credentials\ncrm = `my-crm`(credentials: `Acme CRM`)\n";
    let fix = check(old, 5).into_iter().find(|d| d.message.contains("connect")).map(|d| d.fix.unwrap()["edits"][0]["text"].clone());
    assert_eq!(fix, Some(serde_json::json!("connect `my-crm` using `Acme CRM`")));
}
