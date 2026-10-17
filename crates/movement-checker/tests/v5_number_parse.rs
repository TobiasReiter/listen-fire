//! From version 5 `Number.parse(text)` answers nothing for text that is no
//! number (the engine's `NUMBER("")` is null), so it is `number | absent`: a
//! required value must come from a `!= null` guard, a guard clause that always
//! leaves, or a fallback (MOV_ABSENT_REQUIRED). Versions 1–4 type it `number`.
//! The TypeScript twin is checker/__test__/v5_number_parse.unit.test.ts, same
//! programs, same messages.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"contractVersion":1,"adapters":{"crm":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"crm_cred":{"positions":{"company":{"properties":{"name":"text","employees":"number"},"edges":{}}},"collections":{"companies":{"target":"company"}},"writableRoots":{"company":{"fields":{"name":"text","employees":"number"},"resultShape":{"externalId":"text"}}}}}}},"credentials":{"crm_cred":{"adapters":["crm"]}},"plugins":{}}"#;

fn absent(body: &str, version: u32) -> Vec<String> {
    let (setup, declaration, body) = if version >= 5 {
        ("c = connect crm using crm_cred", "function", body.to_string())
    } else {
        ("c = crm(credentials: crm_cred)", "movement", body.replace("Number.parse(", "NUMBER(").replace("fail(", "ERROR("))
    };
    let source = format!("import {{ crm }} from adapters\nimport {{ crm_cred }} from credentials\n{setup}\n{declaration} go(t: <text>) {{\n{body}\n}}\n");
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let diagnostics = check_source(&source, &catalog, options).unwrap_or_else(|e| panic!("{source}: {e:?}"));
    diagnostics.into_iter().filter(|d| d.code == "MOV_ABSENT_REQUIRED").map(|d| d.message).collect()
}

fn write(value: &str) -> String {
    format!("  write c-[:companies]-> {{ name: \"x\", employees: {value} }}")
}

fn refused(shown: &str) -> String {
    format!("'employees' on c.company needs a value, but '{shown}' may be absent (number (or absent)) — write 'employees: coalesce({shown}, 0)' to fall back to a value that is always there, or 'employees ?: {shown}' to leave it unset when absent (see handbook: front#maybe-absent)")
}

#[test]
fn under_5_a_required_field_refuses_the_parse_direct_or_through_a_name() {
    assert_eq!(absent(&write("Number.parse(t)"), 5), vec![refused("Number.parse(t)")]);
    assert_eq!(absent(&format!("  n = Number.parse(t)\n{}", write("n")), 5), vec![refused("n")]);
}

#[test]
fn under_5_a_guard_a_guard_clause_that_leaves_and_a_fallback_each_satisfy_it() {
    assert_eq!(absent(&format!("  n = Number.parse(t)\n  if (n != null) {{\n  {}\n  }}", write("n")), 5), Vec::<String>::new());
    assert_eq!(absent(&format!("  n = Number.parse(t)\n  if (n == null) {{\n    fail(\"no number\")\n  }}\n{}", write("n")), 5), Vec::<String>::new());
    assert_eq!(absent(&write("coalesce(Number.parse(t), 0)"), 5), Vec::<String>::new());
    assert_eq!(absent("  write c-[:companies]-> { name: \"x\", employees ?: Number.parse(t) }", 5), Vec::<String>::new());
}

#[test]
fn under_1_to_4_the_parse_is_a_plain_number() {
    assert_eq!(absent(&write("Number.parse(t)"), 4), Vec::<String>::new());
    assert_eq!(absent(&format!("  n = Number.parse(t)\n{}", write("n")), 4), Vec::<String>::new());
}
