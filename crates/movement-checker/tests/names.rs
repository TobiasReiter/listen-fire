//! The names family on its own programs. Parity with the TypeScript checker
//! is the harness's job (parity/run.sh); these pin the walk's scoping.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

fn codes(source: &str, version: u32) -> Vec<(String, String)> {
    let catalog = CatalogSnapshot::load(r#"{"adapters":{},"credentials":{"crm_cred":{"adapters":["attio"]}},"plugins":{}}"#).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap().into_iter().map(|d| (d.code, d.message)).collect()
}

#[test]
fn a_read_before_its_binding_is_use_before_bind_and_an_unknown_name_is_unresolved() {
    let found = codes("movement m(n: <number>) {\n  a = later + 1\n  later = 2\n  b = nowhere\n}", 3);
    assert_eq!(found.iter().map(|(c, _)| c.as_str()).collect::<Vec<_>>(), ["MOV_USE_BEFORE_BIND", "MOV_NAME_UNRESOLVED"]);
}

#[test]
fn a_block_s_bindings_do_not_escape_it() {
    let found = codes("movement m(n: <number>) {\n  xs = [1]\n  out = xs-[x:items]-> {\n    inner = 1\n    return inner\n  }\n  y = inner\n}", 3);
    let (code, message) = found.last().unwrap();
    assert_eq!(code, "MOV_NAME_UNRESOLVED");
    assert!(message.contains("bound inside a traversal block") && message.contains("'out = …"), "{message}");
}

#[test]
fn a_credential_is_never_a_value() {
    let found = codes("import { crm_cred } from credentials\nmovement m(n: <number>) {\n  x = crm_cred\n}", 3);
    assert!(found.iter().any(|(c, _)| c == "MOV_CREDENTIAL_NOT_A_VALUE"), "{found:?}");
}

#[test]
fn function_names_are_case_insensitive_from_version_3_only() {
    let source = "movement Notify(n: <number>) {\n}\nmovement notify(n: <number>) {\n}";
    assert!(codes(source, 3).iter().any(|(c, _)| c == "MOV_FUNCTION_NAME_COLLISION"));
    assert!(!codes(source, 2).iter().any(|(c, _)| c == "MOV_FUNCTION_NAME_COLLISION"));
}

#[test]
fn an_inner_name_may_not_hide_an_outer_one() {
    let found = codes("x = 1\nmovement m(x: <number>) {\n}", 3);
    assert!(found.iter().any(|(c, m)| c == "MOV_SHADOWED_NAME" && m.contains("a binding at line 1")), "{found:?}");
}

#[test]
fn an_unsupported_version_is_refused_first() {
    let found = codes("x = 1", 99);
    assert_eq!(found[0].0, "MOV_LANGUAGE_VERSION_UNSUPPORTED");
}
