//! A walk inside an EXPRESSION (`count(found-[c:co]->)`, `exists(found-[c:co]->)`,
//! a hop read in a write field, an interpolation) off a name that may hold no
//! record fails the run at the hop when the record is absent, as a block's
//! walk does (v5_walk_off_absent). From version 5 the checker refuses it
//! (MOV_ABSENT_REQUIRED) until a `!= null` guard proves the record there;
//! versions 1–4 keep it, and a move up across 5 is warned of. `exists(found)`
//! has no hop and answers false for an absent record, so it is no walk. The
//! TypeScript twin is checker/__test__/v5_expression_walk_off_absent.unit.test.ts,
//! same programs, same messages.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"contractVersion":1,"adapters":{"attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"crm_cred":{"positions":{"company":{"properties":{"name":"text","stage":"text","domain":"text","summary":"text","employees":"number"},"edges":{"deals":{"target":"deal"}}},"deal":{"properties":{"title":"text","amount":"number"},"edges":{}},"note":{"properties":{"body":"text","title":"text","payload":"json"},"edges":{}}},"collections":{"companies":{"target":"company"},"notes":{"target":"note"}},"writableRoots":{"note":{"fields":{"body":"text","title":"text","payload":"json"},"resultShape":{"externalId":"text"}},"company":{"fields":{"name":"text","stage":"text","domain":"text","summary":"text","employees":"number"},"resultShape":{"externalId":"text","name":"text"},"fuzzyResolution":true}},"supportsInPlaceUpdate":true}}}},"credentials":{"crm_cred":{"adapters":["attio"]}},"plugins":{}}"#;

fn spelled(version: u32, text: &str) -> String {
    if version < 5 { text.replace("count(", "COUNT(").replace("exists(", "EXISTS(") } else { text.to_string() }
}

fn found(body: &str, version: u32, upgrading_from: Option<u32>) -> Vec<(String, &'static str, String)> {
    let (setup, declaration) = if version < 5 { ("crm = attio(credentials: crm_cred)", "movement") } else { ("crm = connect attio using crm_cred", "function") };
    let body = spelled(version, body);
    let source = format!(
        "import {{ attio }} from adapters\nimport {{ crm_cred }} from credentials\n{setup}\nnode Found: \"the companies named\" {{\n  node co: \"each company\" {{\n    name: <text> \"its name\"\n  }}\n}}\n{declaration} go(t: <text>) {{\n  found = extractOne([t], Found)\n{body}\n}}\n"
    );
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let diagnostics = check_source(&source, &catalog, options).unwrap_or_else(|e| panic!("{source}: {e:?}"));
    diagnostics
        .into_iter()
        .filter(|d| d.code == "MOV_ABSENT_REQUIRED")
        .map(|d| (d.code, if d.severity.is_none() { "error" } else { "warning" }, d.message))
        .collect()
}

fn refused(name: &str) -> (String, &'static str, String) {
    (
        "MOV_ABSENT_REQUIRED".to_string(),
        "error",
        format!("'{name}' may be absent, and a walk inside an expression off a record that is not there fails the run. Guard the walk: 'if ({name} != null) {{ … }}'. (see handbook: front#maybe-absent)"),
    )
}

const POSITIONS: [(&str, &str); 6] = [
    ("an aggregate", "  n = count(found-[c:co]->)"),
    ("an exists with a hop", "  has = exists(found-[c:co]->)"),
    ("a hop read in a write field", "  write crm-[:notes]-> { body: found-[c:co]->.name }"),
    ("an aggregate in a write field", "  write crm-[:notes]-> { body: count(found-[c:co]->) }"),
    ("an interpolation", "  write crm-[:notes]-> { body: \"n: ${count(found-[c:co]->)}\" }"),
    ("a condition", "  if (count(found-[c:co]->) > 0) {\n    write crm-[:notes]-> { body: \"some\" }\n  }"),
];

#[test]
fn under_5_an_expression_walk_is_refused_unguarded_and_passes_guarded() {
    for (position, body) in POSITIONS {
        assert_eq!(found(body, 5, None), vec![refused("found")], "{position}");
        assert_eq!(found(&format!("  if (found != null) {{\n{body}\n  }}"), 5, None), vec![], "{position}, guarded");
    }
}

#[test]
fn versions_3_and_4_keep_it_and_a_move_up_across_5_is_warned_of() {
    for (position, body) in POSITIONS {
        for version in [3, 4] {
            assert_eq!(found(body, version, None), vec![], "{position}, version {version}");
        }
        let warned = found(body, 5, Some(4));
        assert_eq!(warned.len(), 1, "{position}: {warned:?}");
        assert_eq!(warned[0].1, "warning", "{position}");
        assert!(warned[0].2.starts_with("since \"Dancing Wren\" (5) a walk inside an expression off 'found', which may be absent, is refused"), "{}", warned[0].2);
    }
}

#[test]
fn exists_of_the_name_alone_has_no_hop_and_is_no_walk() {
    assert_eq!(found("  has = exists(found)", 5, None), vec![]);
}

#[test]
fn a_name_proven_present_by_an_and_guard_is_walked_freely() {
    assert_eq!(found("  ok = found != null and count(found-[c:co]->) > 0", 5, None), vec![]);
}
