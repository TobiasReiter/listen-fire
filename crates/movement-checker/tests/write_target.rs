//! `write v { … }` where `v` is bound to an IF or a COALESCE whose arms have
//! no one type: `v` is read by what it may hold, as a graph entry and
//! `delete` read it. Records alone are one record — that record when the arms
//! agree on where it starts, unnamed (so nothing is refused) when they do not;
//! one that may be absent may be empty, and is no record to update in place; a
//! value among them is no record at all. The TypeScript checker's
//! `maybe_record_write_target.unit.test.ts`, case for case.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"crm_cred":{"positions":{"company":{"properties":{"name":"text"},"edges":{}},"person":{"properties":{"name":"text"},"edges":{}}},"collections":{"companies":{"target":"company"},"people":{"target":"person"}},"writableRoots":{"company":{"fields":{"name":"text"},"resultShape":{"externalId":"text","name":"text"}},"person":{"fields":{"name":"text"},"resultShape":{"externalId":"text","name":"text"}}},"supportsInPlaceUpdate":true}}}},"credentials":{"crm_cred":{"adapters":["attio"]}},"plugins":{}}"#;

const PRELUDE: &str = "import { attio } from adapters\nimport { crm_cred } from credentials\ncrm = attio(credentials: crm_cred)";
const PRELUDE_V5: &str = "import { attio } from adapters\nimport { crm_cred } from credentials\ncrm = connect attio using crm_cred";

const ORG: &str = "  org = write crm-[:companies]-> { name: \"Acme\" }";
const PICK: &str = "  pick = write crm-[:companies]-> { name: \"Beta\" }";
const PERSON: &str = "  per = write crm-[:people]-> { name: \"Ann\" }";

/// The same body in the spelling before version 5 and in version 5's.
fn errors_under(version: u32, before_5: &[&str], from_5: &[&str]) -> Vec<(String, String)> {
    let source = if version >= 5 {
        format!("{PRELUDE_V5}\nfunction m() {{\n{}\n}}", from_5.join("\n"))
    } else {
        format!("{PRELUDE}\nmovement m() {{\n{}\n}}", before_5.join("\n"))
    };
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &catalog, options)
        .unwrap()
        .into_iter()
        .filter(Diagnostic::is_error)
        .map(|d| (d.code, d.message))
        .collect()
}

const VERSIONS: [u32; 3] = [3, 4, 5];

#[test]
fn one_of_two_write_handles_is_a_record_nobody_can_name_and_nothing_is_refused() {
    for version in VERSIONS {
        assert_eq!(errors_under(version, &[ORG, PICK, "  v = COALESCE(pick, org)", "  write v { name: \"B\" }"], &[ORG, PICK, "  v = coalesce(pick, org)", "  write v { name: \"B\" }"]), vec![], "version {version}");
        assert_eq!(
            errors_under(
                version,
                &[ORG, PICK, "  c = 1 > 0", "  v = IF c THEN pick ELSE org END", "  write v { name: \"B\" }"],
                &[ORG, PICK, "  c = 1 > 0", "  v = c ? pick : org", "  write v { name: \"B\" }"]
            ),
            vec![],
            "version {version}"
        );
    }
}

#[test]
fn one_of_two_records_of_different_types_is_a_record_nobody_can_name_and_nothing_is_refused() {
    for version in VERSIONS {
        assert_eq!(errors_under(version, &[ORG, PERSON, "  v = COALESCE(per, org)", "  write v { name: \"B\" }"], &[ORG, PERSON, "  v = coalesce(per, org)", "  write v { name: \"B\" }"]), vec![], "version {version}");
    }
}

#[test]
fn a_walked_record_or_a_write_handle_is_a_record_nobody_can_name_and_nothing_is_refused() {
    for version in VERSIONS {
        let org = format!("  {ORG}");
        let before_5 = ["  crm-[a:companies]-> {", org.as_str(), "    v = COALESCE(a, org)", "    write v { nope: \"B\" }", "  }"];
        let from_5 = ["  crm-[a:companies]-> {", org.as_str(), "    v = coalesce(a, org)", "    write v { nope: \"B\" }", "  }"];
        assert_eq!(errors_under(version, &before_5, &from_5), vec![], "version {version}");
    }
}

#[test]
fn a_record_or_a_value_is_no_record_to_update_in_place() {
    for version in VERSIONS {
        assert_eq!(
            errors_under(version, &[ORG, "  v = COALESCE(org, \"x\")", "  write v { name: \"B\" }"], &[ORG, "  v = coalesce(org, \"x\")", "  write v { name: \"B\" }"]),
            vec![(
                "MOV_WRITE_POSITION_NOT_RECORD".to_string(),
                "'v' is a value that may hold something other than one record — 'write v { … }' updates an already-identified record in place, so it needs a record: a traversal alias, a prior write result, or a record picked from either".to_string()
            )],
            "version {version}"
        );
    }
}

#[test]
fn a_record_or_nothing_may_be_empty_and_is_no_record_to_update_in_place() {
    for version in VERSIONS {
        let found = errors_under(
            version,
            &[ORG, "  c = 1 > 0", "  v = IF c THEN org ELSE NULL END", "  write v { name: \"B\" }"],
            &[ORG, "  c = 1 > 0", "  v = c ? org : null", "  write v { name: \"B\" }"],
        );
        assert_eq!(found.iter().map(|(code, _)| code.as_str()).collect::<Vec<_>>(), vec!["MOV_WRITE_POSITION_NOT_RECORD"], "version {version}");
    }
}
