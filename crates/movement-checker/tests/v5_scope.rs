//! Language version 5's semantics the spelling rewrite alone cannot carry
//! (plans/naming-rethink-2026-10-14/5_design.md): old spellings in imported
//! libraries reported at the import; a name that hides a built-in; plugins
//! by their exact-case names and package tags. Each under 4 as before.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

fn check_with(source: &str, version: u32, catalog: &str) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(catalog).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap()
}

fn with_files(files: &str) -> String {
    format!(r#"{{"adapters":{{}},"credentials":{{}},"plugins":{{}},"files":{files}}}"#)
}

#[test]
fn a_library_s_old_spellings_are_reported_at_its_import() {
    let files = with_files(r#"{"lib/a":{"source":"export function helper(t: <text>) {\n  return UPPER(t)\n}"}}"#);
    let root = "import { helper } from \"lib/a\"\nfunction go(t: <text>) {\n  x = helper(t)\n}";
    let found = check_with(root, 5, &files);
    let spelling: Vec<_> = found.iter().filter(|d| d.code == "MOV_V5_SPELLING").collect();
    assert_eq!(spelling.len(), 1, "{found:#?}");
    assert_eq!(spelling[0].message, "\"lib/a\" line 2: `UPPER` is written `Text.upper` from language version 5");
    assert_eq!((spelling[0].span.start.line, spelling[0].span.start.col), (1, 1));
    // The library's fix edits its own file, so none is carried to the import.
    assert!(spelling[0].fix.is_none());

    // A library's library: reported at the root import, both paths named.
    let files = with_files(
        r#"{"lib/a":{"source":"import { inner } from \"lib/b\"\nexport function helper(t: <text>) {\n  return inner(t)\n}"},"lib/b":{"source":"export function inner(t: <text>) {\n  return LOWER(t)\n}"}}"#,
    );
    let found = check_with(root, 5, &files);
    let spelling: Vec<_> = found.iter().filter(|d| d.code == "MOV_V5_SPELLING").map(|d| d.message.as_str()).collect();
    assert_eq!(spelling, vec!["\"lib/a\" line 1: \"lib/b\" line 2: `LOWER` is written `Text.lower` from language version 5"]);
}

#[test]
fn under_4_a_library_has_no_spelling_findings() {
    let files = with_files(r#"{"lib/a":{"source":"export movement helper(t: <text>) {\n  return UPPER(t)\n}"}}"#);
    let root = "import { helper } from \"lib/a\"\nmovement go(t: <text>) {\n  x = helper(t)\n}";
    let found = check_with(root, 4, &files);
    assert!(found.iter().all(|d| d.code != "MOV_V5_SPELLING"), "{found:#?}");
}
