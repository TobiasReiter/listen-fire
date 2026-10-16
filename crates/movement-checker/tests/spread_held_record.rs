//! `...m.k`, a record held under a map's key spread into a write: the
//! fields it writes are the record's where the program spells them out (a
//! `node { … }` literal), and an `extractOne` answer, which may be absent,
//! is no such record (MOV_WRITE_SPREAD_SOURCE), as the TypeScript's
//! `positionTypeOf` reads the held value's type as it is. Every version.
//! The TypeScript twin is checker/__test__/spread_held_record.unit.test.ts.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"contractVersion":1,"adapters":{"attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"crm_cred":{"positions":{"note":{"properties":{"body":"text","title":"text","payload":"json"},"edges":{}}},"collections":{"notes":{"target":"note"}},"writableRoots":{"note":{"fields":{"body":"text","title":"text","payload":"json"},"resultShape":{"externalId":"text"}}}}}}},"credentials":{"crm_cred":{"adapters":["attio"]}},"plugins":{}}"#;

fn codes(body: &str, version: u32) -> Vec<String> {
    let (setup, declaration) = if version < 5 { ("crm = attio(credentials: crm_cred)", "movement") } else { ("crm = connect attio using crm_cred", "function") };
    let source = format!(
        "import {{ attio }} from adapters\nimport {{ crm_cred }} from credentials\n{setup}\nnode Note: \"the note\" {{\n  body: <text> \"a body\"\n}}\n{declaration} go(t: <text>) {{\n{body}\n}}\n"
    );
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let diagnostics = check_source(&source, &catalog, options).unwrap_or_else(|e| panic!("{source}: {e:?}"));
    diagnostics.into_iter().filter(|d| d.severity.is_none()).map(|d| d.code).collect()
}

#[test]
fn a_held_extract_one_answer_is_refused_as_a_spread_source_on_every_version() {
    for version in [3, 4, 5] {
        assert_eq!(codes("  d = extractOne([t], Note)\n  held = { k: d }\n  write crm-[:notes]-> { ...held.k }", version), vec!["MOV_WRITE_SPREAD_SOURCE"], "version {version}");
    }
}

#[test]
fn a_held_node_literal_spreads_its_fields() {
    for version in [3, 4, 5] {
        assert_eq!(codes("  n = node { body: t }\n  held = { k: n }\n  write crm-[:notes]-> { ...held.k }", version), Vec::<String>::new(), "version {version}");
    }
}
