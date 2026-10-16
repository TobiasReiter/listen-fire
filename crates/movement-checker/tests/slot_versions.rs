//! A slot's text is read again by the checker (the statement parse keeps it
//! verbatim), so every re-read must be under the program's version. The
//! TypeScript twin is packages/movement-lang/checker/__test__/v5_leftovers.unit.test.ts.

use movement_checker::{CheckOptions, check_program};
use movement_parser::ast::Program;
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{},"credentials":{},"plugins":{}}"#;

const BODY: &str = "function m(t: <text>) {\n  u = Text.upper(t)\n  xs = [t, u]\n  y = xs[0]\n  if (y == \"a\" && u != \"b\") {\n    z = sort(xs, (x) => x, { order: \"desc\" })\n  }\n}\n";

#[test]
fn a_version_5_programs_slots_are_read_under_5() {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    // A slot keeps only its text: the checker reads it again.
    let parsed: Program = movement_parser::stmt::parse_program(BODY, 5, false).unwrap();
    let options = CheckOptions { language_version: 5, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let errors: Vec<String> =
        check_program(&parsed, &catalog, options).into_iter().filter(|d| d.is_error()).map(|d| format!("{}: {}", d.code, d.message)).collect();
    assert_eq!(errors, Vec::<String>::new());
}

/// An index on a call's result (`sort(…)[0]`) is TypeScript's indexing, read
/// on whatever value the call hands back — also when the call is one the
/// checker hoists to a name of its own (a key that calls `Text.upper`).
#[test]
fn an_index_on_a_hoisted_calls_result_reads_the_result() {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    for line in [
        "y = sort(tags, (k) => Text.upper(k))[0]",
        "y = sort(tags, (k) => Text.upper(k), { order: \"desc\" })[0]",
        "y = sort(tags, (k) => Text.upper(k))[0] == \"b\"",
        "y = 1 + count(sort(tags, (k) => Text.upper(k))[0])",
    ] {
        let source = format!("function m(t: <text>) {{\n  tags = [\"b\", \"a\"]\n  {line}\n  return y\n}}\n");
        let options = CheckOptions { language_version: 5, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
        let errors: Vec<String> = movement_checker::check_source(&source, &catalog, options)
            .unwrap()
            .into_iter()
            .filter(|d| d.is_error())
            .map(|d| format!("{}: {}", d.code, d.message))
            .collect();
        assert_eq!(errors, Vec::<String>::new(), "{line}");
    }
}
