//! The calls, closures and flow families on their own programs. Parity with
//! the TypeScript checker is the harness's job (parity/run.sh); these pin
//! the rules the families add to the walk.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

fn codes(source: &str, version: u32) -> Vec<(String, String)> {
    let catalog = CatalogSnapshot::load(r#"{"adapters":{},"credentials":{},"plugins":{}}"#).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None };
    check_source(source, &catalog, options).unwrap().into_iter().map(|d| (d.code, d.message)).collect()
}

fn has(found: &[(String, String)], code: &str) -> bool {
    found.iter().any(|(c, _)| c == code)
}

#[test]
fn binding_a_call_of_a_movement_that_returns_nothing_is_refused() {
    let source = "movement lists(e: <number>) {\n  names = [1]\n}\nmovement main(e: <number>) {\n  x = lists(e: e)\n}";
    let found = codes(source, 1);
    assert!(has(&found, "MOV_CALL_RETURNS_NOTHING"), "{found:?}");
}
