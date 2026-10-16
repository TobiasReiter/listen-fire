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

const PLUGINS: &str = r#"{"adapters":{},"credentials":{},"plugins":{"fetch_url":{"args":["url"]}}}"#;

fn codes_of(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().map(|d| d.code.as_str()).collect()
}

#[test]
fn a_plugin_is_imported_by_its_exact_camel_case_name_under_5() {
    let new = "import { fetchUrl } from plugins\nfunction go(u: <text>) {\n  p = fetchUrl(url: u)\n}";
    let old = "import { fetch_url } from plugins\nmovement go(u: <text>) {\n  p = fetch_url(url: u)\n}";
    assert_eq!(codes_of(&check_with(new, 5, PLUGINS)), codes_of(&check_with(old, 4, PLUGINS)));
    // Under its own name as an alias, too.
    let aliased = "import { fetchUrl as get } from plugins\nfunction go(u: <text>) {\n  p = get(url: u)\n}";
    assert_eq!(codes_of(&check_with(aliased, 5, PLUGINS)), codes_of(&check_with(old, 4, PLUGINS)));
}

#[test]
fn the_catalog_s_key_is_the_old_spelling_under_5() {
    let old = "import { fetch_url } from plugins\nfunction go(u: <text>) {\n  p = fetch_url(url: u)\n}";
    let found = check_with(old, 5, PLUGINS);
    let spelling: Vec<_> = found.iter().filter(|d| d.code == "MOV_V5_SPELLING").collect();
    assert_eq!(spelling.len(), 1, "{found:#?}");
    assert_eq!(spelling[0].message, "from language version 5 the plugin `fetch_url` is imported as `fetchUrl`");
    // The local name is kept, so every call still reads.
    assert_eq!(spelling[0].fix.as_ref().unwrap()["edits"][0]["text"], "fetchUrl as fetch_url");
    let aliased = check_with("import { fetch_url as get } from plugins\n", 5, PLUGINS);
    assert_eq!(aliased.iter().find(|d| d.code == "MOV_V5_SPELLING").unwrap().fix.as_ref().unwrap()["edits"][0]["text"], "fetchUrl");
}

#[test]
fn a_plugin_name_in_another_letter_case_is_unknown_under_5_named_as_written() {
    let found = check_with("import { fetchURL } from plugins\n", 5, PLUGINS);
    let unknown: Vec<_> = found.iter().filter(|d| d.code == "MOV_IMPORT_UNKNOWN").map(|d| d.message.as_str()).collect();
    assert_eq!(unknown, vec!["Unknown plugin 'fetchURL' in 'plugins'"]);
}

#[test]
fn under_4_a_plugin_is_imported_by_the_catalog_s_key() {
    assert!(check_with("import { fetch_url } from plugins\n", 4, PLUGINS).iter().all(|d| d.code != "MOV_V5_SPELLING" && d.code != "MOV_IMPORT_UNKNOWN"));
    let found = check_with("import { fetchUrl } from plugins\n", 4, PLUGINS);
    assert!(found.iter().any(|d| d.message == "Unknown plugin 'fetchUrl' in 'plugins'"), "{found:#?}");
}
