//! MOV_FILE_VALUE_RUNS: a file-level value from version 5 holds a value only
//! — a call to a function or a plugin (written whole or nested in the value),
//! a write, a walk, a wait or a node is refused at save, as the engines refuse
//! it at run time. The TypeScript twin is
//! packages/movement-lang/checker/__test__/file_value.unit.test.ts.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const SNAPSHOT: &str = r#"{"adapters":{"kg":{"constructionArgs":[],"schemas":{"":{"positions":{"note":{"properties":{"text":"text"},"edges":{}}},"collections":{"notes":{"target":"note"}},"writableRoots":{"note":{"fields":{"text":"text"},"resultShape":{"externalId":"text"}}}}}}},"credentials":{},"plugins":{"echo":{"args":["q"],"requiredArgs":["q"],"output":{"kind":"value","type":"text"}}},"files":FILES}"#;

fn check(lines: &[&str], version: u32, library: Option<&str>) -> Vec<Diagnostic> {
    let head = if version >= 5 { "import { kg } from adapters\nimport { echo } from plugins\ngraph = connect kg" } else { "import { kg } from adapters\nimport { echo } from plugins\ngraph = kg()" };
    let source = format!("{head}\n{}", lines.join("\n"));
    let files = match library {
        Some(library) => serde_json::json!({ "lib/vals": { "source": library } }).to_string(),
        None => "{}".to_string(),
    };
    let catalog = CatalogSnapshot::load(&SNAPSHOT.replace("FILES", &files)).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &catalog, options).unwrap()
}

fn refused(lines: &[&str]) -> Vec<usize> {
    check(lines, 5, None).iter().filter(|d| d.code == "MOV_FILE_VALUE_RUNS").map(|d| d.span.start.line).collect()
}

#[test]
fn refuses_what_is_not_a_value() {
    for lines in [
        &["p = echo(\"x\")"][..],
        &["said = { page: echo(\"x\") }"],
        &["function f(n: <number>) {", "  return n", "}", "x = f(1)"],
        &["g = (n: <number>) => n + 1", "x = g(1)"],
        &["w = write graph-[:notes]-> { text: \"x\" }"],
        &["n = node { a: 1 }"],
    ] {
        assert_eq!(refused(lines), [lines.len() + 3], "{lines:?}");
    }
}

#[test]
fn says_what_the_value_holds() {
    let diagnostics = check(&["said = { page: echo(\"x\") }"], 5, None);
    let found = diagnostics.iter().find(|d| d.code == "MOV_FILE_VALUE_RUNS").expect("refused");
    assert_eq!(
        found.message,
        "'said' is a file-level value, worked out before every run with no event in scope, so it holds a value only — not a call to 'echo'. Do it inside the function that uses it."
    );
}

#[test]
fn accepts_a_value() {
    for lines in [&["n = { a: 1, b: [2, 3] }"][..], &["n = coalesce(null, \"x\")"], &["f = (q: <text>) => echo(q)"]] {
        assert!(check(lines, 5, None).is_empty(), "{lines:?}: {:?}", check(lines, 5, None));
    }
}

#[test]
fn refuses_one_in_a_library_at_the_import() {
    let library = "import { echo } from plugins\nsaid = echo(\"x\")\nexport function f(n: <number>) {\n  return n\n}";
    let found: Vec<(String, String)> =
        check(&["import { f } from \"lib/vals\""], 5, Some(library)).into_iter().map(|d| (d.code, d.message.chars().take(18).collect())).collect();
    assert_eq!(found, [("MOV_FILE_VALUE_RUNS".to_string(), "\"lib/vals\" line 2:".to_string())]);
}

#[test]
fn says_nothing_under_version_4() {
    assert!(!check(&["p = echo(q: \"x\")"], 4, None).iter().any(|d| d.code == "MOV_FILE_VALUE_RUNS"));
}
