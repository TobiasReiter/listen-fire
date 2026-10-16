//! Version 5 fix-ups the handbook found, through the Rust checker. The
//! TypeScript twin is packages/movement-lang/checker/__test__/v5_fixups.unit.test.ts.

use movement_checker::types::event_address::{EventAddress, event_address_of_hops};
use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{},"credentials":{},"plugins":{}}"#;

fn check(source: &str, version: u32) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap()
}

fn errors(source: &str, version: u32) -> Vec<String> {
    check(source, version).into_iter().filter(|d| d.is_error()).map(|d| format!("{}: {}", d.code, d.message)).collect()
}

#[test]
fn a_namespace_member_bound_whole_reads_as_its_old_spelling_did() {
    for call in [
        r#"Date.today("Europe/Berlin")"#,
        r#"DateTime.at(Date.today("UTC"), "07:00", "UTC")"#,
        "Date.addDays(@current_date, 1)",
        r#"Text.regexExtract("DEAL-1", "(DEAL-\\d+)")"#,
        r#"Currency.numberFromFigure("£1.2m")"#,
        r#"Text.slug("a b")"#,
    ] {
        assert_eq!(errors(&format!("function f() {{\n  t = {call}\n  return t\n}}"), 5), Vec::<String>::new(), "{call}");
        assert_eq!(errors(&format!("function f() {{\n  return {call}\n}}"), 5), Vec::<String>::new(), "{call}");
    }
    assert_eq!(errors("movement f() {\n  t = DATE.TODAY(\"UTC\")\n  return t\n}", 4), Vec::<String>::new());
    let unknown = errors("function f() {\n  t = Date.tomorrow(\"UTC\")\n  return t\n}", 5);
    assert!(unknown.iter().any(|e| e.starts_with("MOV_V5_UNKNOWN_MEMBER")), "{unknown:?}");
}

#[test]
fn an_address_reads_the_event_through_the_hops_alias_from_5() {
    let aliased = "-[e:`Webhook Event` WHERE e.action == \"record.created\"]->";
    let address = EventAddress { event: "Webhook Event".into(), narrowing: vec![("action".into(), "record.created".into())] };
    assert_eq!(movement_parser::surface::with_version(5, || event_address_of_hops(aliased)), Some(address.clone()));
    let bare = "-[:`Webhook Event` WHERE `action` == \"record.created\"]->";
    assert_eq!(movement_parser::surface::with_version(4, || event_address_of_hops(bare)), Some(address));
    assert_eq!(movement_parser::surface::with_version(4, || event_address_of_hops(aliased)), None);
}
