//! The extraction keyword under language version 5: MOV_EXTRACT_KEYWORD_RETIRED
//! with the same rewrite the TypeScript checker writes
//! (packages/movement-lang/checker/__test__/extract_keyword_retired.unit.test.ts).

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"slack":{"constructionArgs":[],"schemas":{"":{"positions":{"message":{"properties":{"Text":"text"},"edges":{}},"note":{"properties":{"Body":"text"},"edges":{}}},"collections":{"note":{"target":"note"}},"writableRoots":{"note":{"fields":{"Body":"text"},"resultShape":{"Body":"text"},"edges":{}}}}}}},"credentials":{},"plugins":{"fetchUrl":{"args":["url"],"priced":true,"output":{"kind":"value","type":"text"}}}}"#;

fn check(source: &str, version: u32) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap().into_iter().filter(|d| d.code == "MOV_EXTRACT_KEYWORD_RETIRED").collect()
}

const PRELUDE: &str = "import { `@lf/slack` as slack } from adapters\nchat = connect slack\n\n";

#[test]
fn the_keyword_is_refused_with_the_typescripts_rewrite() {
    let source = format!(
        "{PRELUDE}function go(m: <chat-[:message]->>) {{\n  found = extract \"careful\" from [m.Text, \"the subject\"] {{\n    node company: \"each company named\" {{\n      name: <text> \"its name\"\n      node person: \"each person\" {{ name: \"their name\" }}\n    }}\n  }}\n}}\n"
    );
    let found = check(&source, 5);
    assert_eq!(found.len(), 1);
    assert!(found[0].message.contains("writes 'found = extractOne(content, FoundShape, { tier: \"careful\" })'"), "{}", found[0].message);
    assert!(found[0].message.ends_with("(see handbook: front#extraction)"), "{}", found[0].message);
    let fix = found[0].fix.as_ref().expect("a fix");
    assert_eq!(fix.get("safe"), None);
    assert_eq!(
        fix["edits"][0]["text"],
        "node FoundShape: \"the relevant information in the content\" {\n  node company: \"each company named\" {\n    name: <text> \"its name\"\n    node person: \"each person\" {\n      name: <text> \"their name\"\n    }\n  }\n}\n\n"
    );
    assert_eq!(fix["edits"][0]["span"]["start"], serde_json::json!({ "line": 4, "col": 1 }));
    assert_eq!(fix["edits"][1]["text"], "extractOne([m.Text, \"the subject\"], FoundShape, { tier: \"careful\" })");
}

#[test]
fn a_through_stage_has_no_rewrite_and_versions_one_to_four_are_unchanged() {
    let source = format!("import {{ fetchUrl }} from plugins\n{PRELUDE}function go(m: <chat-[:message]->>) {{\n  found = extract from [m.Text] through [fetchUrl(m.Text)] {{ summary: \"s\" }}\n}}\n");
    let found = check(&source, 5);
    assert_eq!(found.len(), 1);
    assert!(found[0].fix.is_none());
    assert!(found[0].message.contains("No rewrite keeps a 'through […]' stage's meaning"));
    let v4 = "import { slack } from adapters\nchat = slack()\n\nmovement go(m: <chat-[:message]->>) {\n  found = extract from [m.Text] { node co: \"each\" { name: <text> \"n\" } }\n}\n";
    assert!(check(v4, 4).is_empty());
}
