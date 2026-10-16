//! A slot's text is read again by the checker (the statement parse keeps it
//! verbatim), so every re-read must be under the program's version. The
//! TypeScript twin is packages/movement-lang/checker/__test__/v5_leftovers.unit.test.ts.

use movement_checker::{CheckOptions, check_program};
use movement_parser::ast::Program;
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{},"credentials":{},"plugins":{}}"#;

const BODY: &str = "function m(t: <text>) {\n  u = Text.upper(t)\n  xs = [t, u]\n  y = xs[0]\n  if (y == \"a\" && u != \"b\") {\n    z = sort(xs, (x) => x, { order: \"desc\" })\n  }\n}\n";

#[test]
fn a_version_5_program_rebuilt_from_its_json_is_read_under_5() {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let parsed = movement_parser::stmt::parse_program(BODY, 5, false).unwrap();
    // Stored and read back, outside any parse's scope: nothing of the parse
    // rides along but the text.
    let rebuilt: Program = serde_json::from_value(serde_json::to_value(&parsed).unwrap()).unwrap();
    let options = CheckOptions { language_version: 5, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let errors: Vec<String> =
        check_program(&rebuilt, &catalog, options).into_iter().filter(|d| d.is_error()).map(|d| format!("{}: {}", d.code, d.message)).collect();
    assert_eq!(errors, Vec::<String>::new());
}

