//! A connection's credential must belong to the module it connects, and fill
//! one of the credentials that module declares. The TypeScript twin is
//! packages/movement-lang/checker/__test__/credential_binding.unit.test.ts.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const SNAPSHOT: &str = r#"{"adapters":{"hubspot":{"canFire":true,"declaredCredentials":["oauth"],"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{}},"attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{}}},"credentials":{"alice_hubspot":{"adapters":["hubspot"],"credential":"oauth"},"old_hubspot_key":{"adapters":["hubspot"],"credential":"api_key"},"acme_attio":{"adapters":["attio"]}},"plugins":{}}"#;

fn found(using: &str, adapter: &str) -> Vec<(String, String)> {
    let catalog = CatalogSnapshot::load(SNAPSHOT).unwrap();
    let options = CheckOptions { language_version: 5, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let source = format!("import {{ `@lf/{adapter}` as {adapter} }} from adapters\nimport {{ {using} }} from credentials\nhs = connect {adapter} using {using}\n");
    check_source(&source, &catalog, options).unwrap().into_iter().map(|d| (d.code, d.message)).collect()
}

#[test]
fn a_credential_of_the_module_filling_a_declared_credential_is_clean() {
    assert!(found("alice_hubspot", "hubspot").iter().all(|(c, _)| c != "MOV_CRED_WRONG_ADAPTER"));
}

#[test]
fn another_module_s_credential_is_refused() {
    let diagnostics = found("alice_hubspot", "attio");
    let (_, message) = diagnostics.iter().find(|(c, _)| c == "MOV_CRED_WRONG_ADAPTER").expect("refused");
    assert_eq!(message, "'alice_hubspot' is a hubspot credential — 'attio' needs a attio credential");
}

#[test]
fn a_credential_for_a_declaration_the_module_lacks_is_refused() {
    let diagnostics = found("old_hubspot_key", "hubspot");
    let (_, message) = diagnostics.iter().find(|(c, _)| c == "MOV_CRED_WRONG_ADAPTER").expect("refused");
    assert_eq!(message, "'old_hubspot_key' is hubspot's 'api_key' credential, which 'hubspot' does not declare — connect it using a 'oauth' credential of hubspot");
}
