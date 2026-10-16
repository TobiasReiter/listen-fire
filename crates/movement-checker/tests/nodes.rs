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

#[test]
fn a_node_literal_argument_is_judged_by_structure() {
    let source = "node Doc {\n  title: <text>\n}\nmovement takes(d: <Doc>) {\n}\nmovement main() {\n  takes(d: node { nope: \"x\" })\n}\n";
    assert_eq!(codes_at(source, 3), vec![("MOV_NODE_ARG_SHAPE".into(), "'takes' expects Doc.Doc, and it has no `title`".into())]);
}

#[test]
fn an_extends_cycle_names_the_chain() {
    let source = "node A extends B {\n  a: <text>\n}\nnode B extends A {\n  b: <text>\n}\n";
    let codes: Vec<String> = codes_at(source, 3).into_iter().map(|(c, _)| c).collect();
    assert_eq!(codes, vec!["MOV_EXTENDS_CYCLE", "MOV_EXTENDS_CYCLE"]);
}

#[test]
fn a_shaped_graph_needs_every_required_field() {
    let source = "node Note {\n  text: <text>\n  tag: <text | null>\n}\nmovement main() {\n  g = graph<Note> { }\n}\n";
    assert_eq!(
        codes_at(source, 3),
        vec![("MOV_GRAPH_FIELD_MISSING".into(), "<Note> needs `text` (text) and this graph doesn't write it — only a field declared '<T | null>' may be left out".into())]
    );
}

const RUN_BUILT: &str = "node Company {\n  name: <text>\n  thesis: <text | null>\n}\nmovement main() {\n  deduped = node { companies: <Company> order by arrival }\n  write deduped-[:companies]-> { name: \"Acme\" }\n  MAP(deduped-[:companies]->, (e) => {\n    BODY\n  })\n}\n";
const RUN_BUILT_V5: &str = "node Company {\n  name: <text>\n  thesis: <text | null>\n}\nfunction main() {\n  deduped = node { companies: <Company> order by arrival }\n  write deduped-[:companies]-> { name: \"Acme\" }\n  map(deduped-[:companies]->, (e) => {\n    BODY\n  })\n}\n";

#[test]
fn a_record_this_run_built_updates_in_place_by_its_landing_type() {
    assert_eq!(codes_at(&RUN_BUILT.replace("BODY", "write e { thesis: \"x\" }"), 3), vec![]);
    assert_eq!(
        codes_at(&RUN_BUILT_V5.replace("BODY", "write e { nope: \"x\" }"), 5),
        vec![("MOV_WRITE_UNKNOWN_FIELD".into(), "'e' (Company.Company this run built) has no field 'nope' — it has: name, thesis".into())]
    );
}

#[test]
fn a_built_graph_is_not_a_record_to_update() {
    let source = "node Company {\n  thesis: <text | null>\n}\nmovement main() {\n  g = graph<Company> { thesis: \"a\" }\n  write g { thesis: \"x\" }\n}\n";
    assert_eq!(
        codes_at(source, 4),
        vec![("MOV_WRITE_POSITION_NOT_RECORD".into(), "'g' is a <Company> graph — 'write g { … }' updates an already-identified record in place, so it needs a record position: a traversal alias or a prior write result".into())]
    );
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
