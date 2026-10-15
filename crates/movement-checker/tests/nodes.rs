//! The nodes family: node declarations, node and graph literals, and a
//! declared node as a parameter's type.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{},"credentials":{},"plugins":{}}"#;

fn codes_at(source: &str, version: u32) -> Vec<(String, String)> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options)
        .unwrap()
        .into_iter()
        .filter(|d| d.code != "MOV_LISTEN_MISSING" && d.code != "MOV_LANGUAGE_VERSION_DEPRECATED")
        .map(|d| (d.code, d.message))
        .collect()
}

#[test]
fn a_shaped_graph_built_from_a_spread_walks_its_declared_children() {
    let source = "node Note {\n  text: <text>\n  node tag {\n    label: <text>\n  }\n}\nmovement main() {\n  v = { text: \"hello\", tag: [{ label: \"a\" }] }\n  g = graph<Note> { ...v }\n  g-[t:tag]-> {\n    l = t.label\n  }\n}\n";
    assert_eq!(codes_at(source, 3), vec![]);
}

/// Debugging aid: `NODES_CASE=<dir>` checks `<dir>/case.mov` against `<dir>/case.json`.
#[test]
fn debug_case() {
    let Ok(dir) = std::env::var("NODES_CASE") else { return };
    let source = std::fs::read_to_string(format!("{dir}/case.mov")).unwrap();
    let catalog = CatalogSnapshot::load(&std::fs::read_to_string(format!("{dir}/case.json")).unwrap()).unwrap();
    let version = std::env::var("NODES_VERSION").ok().and_then(|v| v.parse().ok()).unwrap_or(3);
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    for d in check_source(&source, &catalog, options).unwrap() {
        eprintln!("{} {:?} {}", d.code, d.span, d.message);
    }
}
