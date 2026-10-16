//! One diagnostic per misspelled bare name in a version 5 walk's WHERE: a
//! bare name inside a hop's brackets is a variable from outside the walk. A
//! field of the hop written bare is the old spelling (MOV_V5_SPELLING, its fix
//! the alias read); a name that is neither a variable nor a field of the
//! hop's known type is one unknown name (MOV_NAME_UNRESOLVED), its
//! did-you-mean over the hop's fields and the names in scope. The TypeScript
//! twin is checker/__test__/v5_walk_names.unit.test.ts, same programs, same
//! messages.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"Acme CRM":{"positions":{"company":{"properties":{"name":"text","score":"number"},"edges":{}}},"collections":{"companies":{"target":"company"}},"writableRoots":{}}}}},"credentials":{"Acme CRM":{"adapters":["attio"]}},"plugins":{}}"#;

fn check(body: &str) -> Vec<(String, String)> {
    let source = format!(
        "import {{ `@lf/attio` as attio }} from adapters\nimport {{ `Acme CRM` }} from credentials\ncrm = connect attio using `Acme CRM`\nfunction go(cutoff: <number>) {{\n{body}\n}}\n"
    );
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: 5, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let diagnostics: Vec<Diagnostic> = check_source(&source, &catalog, options).unwrap_or_else(|e| panic!("{source}: {e:?}"));
    diagnostics.into_iter().filter(|d| d.severity.is_none()).map(|d| (d.code, d.message)).collect()
}

const UNKNOWN: &str = "no variable in scope is called that, and crm.company has no such field (a bare name inside a walk's brackets is a variable from outside the walk; a field is read through the hop's alias)";

#[test]
fn a_misspelled_variable_is_one_unknown_name_suggesting_the_variable() {
    for body in ["  crm-[c:companies WHERE c.score > cutof]-> { }", "  n = crm-[c:companies WHERE c.score > cutof]->.name"] {
        assert_eq!(
            check(body),
            vec![("MOV_NAME_UNRESOLVED".to_string(), format!("Unknown name 'cutof' — {UNKNOWN} — did you mean 'cutoff'?"))],
            "{body}"
        );
    }
}

#[test]
fn a_misspelled_field_is_one_unknown_name_suggesting_the_field_through_the_alias() {
    assert_eq!(
        check("  crm-[c:companies WHERE scor > cutoff]-> { }"),
        vec![("MOV_NAME_UNRESOLVED".to_string(), format!("Unknown name 'scor' — {UNKNOWN} — did you mean the field 'score', read through the hop's alias?"))]
    );
}

#[test]
fn a_field_written_bare_is_the_old_spelling_alone() {
    let found = check("  crm-[c:companies WHERE score > cutoff]-> { }");
    assert_eq!(found.iter().map(|(c, _)| c.as_str()).collect::<Vec<_>>(), vec!["MOV_V5_SPELLING"]);
}

#[test]
fn a_name_far_from_everything_has_no_suggestion() {
    assert_eq!(
        check("  crm-[c:companies WHERE c.score > zzzzzzzz]-> { }"),
        vec![("MOV_NAME_UNRESOLVED".to_string(), format!("Unknown name 'zzzzzzzz' — {UNKNOWN}"))]
    );
}
