//! A block whose head walks off a name that may hold no record — an
//! `extractOne` answer, a `match` that found nothing — fails the run at the
//! head when the record is absent (it does not run zero times), on every
//! version, and runs when it is there. From version 5 the checker refuses it
//! (MOV_ABSENT_REQUIRED) until a `!= null` guard proves the record there;
//! versions 1–4 keep it, and a move up across 5 is warned of. The
//! TypeScript twin is checker/__test__/v5_walk_off_absent.unit.test.ts, same
//! programs, same messages.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"contractVersion":1,"adapters":{"attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"crm_cred":{"positions":{"company":{"properties":{"name":"text","stage":"text","domain":"text","summary":"text","employees":"number"},"edges":{"deals":{"target":"deal"}}},"deal":{"properties":{"title":"text","amount":"number"},"edges":{}},"note":{"properties":{"body":"text","title":"text","payload":"json"},"edges":{}}},"collections":{"companies":{"target":"company"},"notes":{"target":"note"}},"writableRoots":{"note":{"fields":{"body":"text","title":"text","payload":"json"},"resultShape":{"externalId":"text"}},"company":{"fields":{"name":"text","stage":"text","domain":"text","summary":"text","employees":"number"},"resultShape":{"externalId":"text","name":"text"},"fuzzyResolution":true}},"supportsInPlaceUpdate":true}}}},"credentials":{"crm_cred":{"adapters":["attio"]}},"plugins":{}}"#;

fn found(body: &str, version: u32, upgrading_from: Option<u32>) -> Vec<(String, &'static str, String)> {
    let (setup, declaration) = if version < 5 { ("crm = attio(credentials: crm_cred)", "movement") } else { ("crm = connect attio using crm_cred", "function") };
    let source = format!(
        "import {{ attio }} from adapters\nimport {{ crm_cred }} from credentials\n{setup}\nnode Found: \"the companies named\" {{\n  node co: \"each company\" {{\n    name: <text> \"its name\"\n  }}\n}}\n{declaration} go(t: <text>) {{\n{body}\n}}\n"
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
        format!("'{name}' may be absent, and a block's walk off a record that is not there fails the run rather than running zero times. Guard the walk: 'if ({name} != null) {{ … }}'. (see handbook: front#maybe-absent)"),
    )
}

const EXTRACTED: &str = "  found = extractOne([t], Found)\n  found-[c:co]-> {\n    write crm-[:notes]-> { body: c.name }\n  }";
const MATCHED: &str = "  co = match crm-[:companies]-> { unique by (`name`), name: t }\n  co-[d:deals]-> {\n    write crm-[:notes]-> { body: d.title }\n  }";

#[test]
fn under_5_a_block_off_an_extract_one_answer_or_a_match_is_refused_unguarded() {
    assert_eq!(found(EXTRACTED, 5, None), vec![refused("found")]);
    assert_eq!(found(MATCHED, 5, None), vec![refused("co")]);
}

#[test]
fn under_5_an_expression_root_that_may_be_absent_is_refused_asking_for_a_name() {
    let refusal = found("  rows = [extractOne([t], Found)]\n  rows[0]-[c:co]-> {\n    write crm-[:notes]-> { body: c.name }\n  }", 5, None);
    assert_eq!(
        refusal,
        vec![(
            "MOV_ABSENT_REQUIRED".to_string(),
            "error",
            "'rows[0]' may be absent, and a block's walk off a record that is not there fails the run rather than running zero times. Guard the walk: 'x = rows[0]', then 'if (x != null) { … }'. (see handbook: front#maybe-absent)".to_string()
        )]
    );
}

#[test]
fn under_5_a_guard_proves_the_record_there() {
    assert_eq!(found("  found = extractOne([t], Found)\n  if (found != null) {\n    found-[c:co]-> {\n      write crm-[:notes]-> { body: c.name }\n    }\n  }", 5, None), vec![]);
    assert_eq!(found("  co = match crm-[:companies]-> { unique by (`name`), name: t }\n  if (co != null) {\n    co-[d:deals]-> {\n      write crm-[:notes]-> { body: d.title }\n    }\n  }", 5, None), vec![]);
}

#[test]
fn versions_1_to_4_keep_the_form_and_a_move_up_across_5_is_warned_of() {
    for version in [3, 4] {
        assert_eq!(found(EXTRACTED, version, None), vec![], "version {version}");
        assert_eq!(found(MATCHED, version, None), vec![], "version {version}");
    }
    let warned = found(EXTRACTED, 5, Some(4));
    assert_eq!(warned.len(), 1, "{warned:?}");
    assert_eq!(warned[0].1, "warning");
    assert!(warned[0].2.starts_with("since \"Dancing Wren\" (5) a block's walk off 'found', which may be absent, is refused"), "{}", warned[0].2);
}
