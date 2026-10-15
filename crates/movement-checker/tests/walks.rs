//! The walks family against a small registry: what a walk may step along and
//! read off where it lands.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"registry":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"public_registry":{"positions":{"entity":{"properties":{"Name":"text","City":"text"},"edges":{"Holdings":{"target":"holding"}}},"holding":{"properties":{"Amount":"number"},"edges":{}}},"collections":{"entities":{"target":"entity"}},"writableRoots":{}}}}},"credentials":{"public_registry":{"adapters":["registry"]}},"plugins":{}}"#;

fn walk_codes(body: &str) -> Vec<(String, String)> {
    let source = format!(
        "import {{ registry }} from adapters\nimport {{ public_registry as pr }} from credentials\nreg = registry(credentials: pr)\nmovement main(e: <reg-[:entity]->>) {{\n{body}\n}}\n"
    );
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: 3, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &catalog, options)
        .unwrap()
        .into_iter()
        .filter(|d| d.code != "MOV_LISTEN_MISSING" && d.code != "MOV_LANGUAGE_VERSION_DEPRECATED")
        .map(|d| (d.code, d.message))
        .collect()
}

#[test]
fn an_unknown_edge_names_the_edges_there_are() {
    let found = walk_codes("  e-[h:Holding]-> { x = h.`Amount` }");
    assert_eq!(found, vec![("MOV_TRAVERSE_UNKNOWN_EDGE".into(), "reg.entity has no edge 'Holding' — it has: Holdings".into())]);
}

#[test]
fn a_hop_alias_reads_the_position_it_landed_on() {
    let found = walk_codes("  e-[h:Holdings]-> { x = h.`Amont` }");
    assert_eq!(found, vec![("MOV_UNKNOWN_PROPERTY".into(), "reg.holding has no field 'Amont' — it has: Amount — did you mean 'Amount'?".into())]);
}

#[test]
fn a_parameter_type_names_a_position_the_schema_has() {
    let source = "import { registry } from adapters\nimport { public_registry } from credentials\nreg = registry(credentials: public_registry)\nmovement main(e: <reg-[:Entity]->>) {\n}\n";
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: 3, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let codes: Vec<String> = check_source(source, &catalog, options).unwrap().into_iter().map(|d| d.message).collect();
    assert!(codes.contains(&"'reg' has no position type 'Entity' — it has: entity, holding".to_string()), "{codes:?}");
}

#[test]
fn an_unknown_meta_key_suggests_the_closest() {
    let found = walk_codes("  x = @user_emial");
    assert_eq!(found, vec![("MOV_META_UNKNOWN_KEY".into(), "'@user_emial' isn't a known meta field. Did you mean '@user_email'?".into())]);
}
