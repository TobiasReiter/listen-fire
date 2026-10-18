//! The run host's units (`cron`, `manual`): from version 5 in every file's
//! scope, connected, with no import; before it, imported and constructed as
//! any adapter. The TypeScript checker's twin is packages/movement-lang/
//! checker/__test__/units.unit.test.ts, on the same catalog.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"cron":{"constructionArgs":[],"canFire":true,"triggerConfig":["schedule","timezone"],"triggerConfigRequired":["schedule"],"triggerConfigFormats":{"schedule":"cron","timezone":"timezone"},"schemas":{"":{"positions":{"Tick":{"properties":{"Fired at":"date"},"edges":{}}},"collections":{},"writableRoots":{},"eventPosition":"Tick","eventPositions":[{"position":"Tick"}]}}},"manual":{"constructionArgs":[],"canFire":true,"schemas":{"":{"positions":{"Invocation":{"properties":{"Text":"text"},"edges":{}}},"collections":{},"writableRoots":{},"eventPosition":"Invocation","eventPositions":[{"position":"Invocation"}]}}}},"credentials":{},"plugins":{}}"#;

fn check(source: &str, version: u32) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap()
}

fn codes(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().map(|d| d.code.as_str()).collect()
}

const UNITS: &str = "function hello(run: <manual-[:Invocation]->>) {\n  return run.`Text`\n}\nlisten to manual fire hello\nfunction digest(t: <cron-[:Tick]->>) {\n  return t.`Fired at`\n}\nlisten to cron { schedule: \"0 9 * * 1\" } fire digest\n";

#[test]
fn from_version_5_cron_and_manual_need_no_import() {
    assert_eq!(codes(&check(UNITS, 5)), Vec::<&str>::new());
}

#[test]
fn a_unit_is_typed_as_its_adapter_describes_it() {
    let found = check(&UNITS.replace("run.`Text`", "run.`Txt`"), 5);
    assert_eq!(codes(&found), ["MOV_UNKNOWN_PROPERTY"]);
    let found = check(&UNITS.replace(" { schedule: \"0 9 * * 1\" }", ""), 5);
    assert_eq!(codes(&found), ["MOV_LISTEN_BAD_CONFIG"]);
}

#[test]
fn a_files_own_import_and_connection_of_a_unit_still_check() {
    let source = "import { manual } from adapters\nruns = connect manual\nfunction hello(run: <runs-[:Invocation]->>) {\n  return run.`Text`\n}\nlisten to runs fire hello\n";
    assert_eq!(codes(&check(source, 5)), Vec::<&str>::new());
    let shadowed = "function hello(manual: <number>) {\n  return manual\n}\n";
    assert_eq!(codes(&check(shadowed, 5)), Vec::<&str>::new());
}

#[test]
fn connecting_a_unit_is_told_to_listen_to_it_by_name() {
    let found = check("runs = connect manual\n", 5);
    assert_eq!(codes(&found), ["MOV_CONSTRUCT_NOT_ADAPTER"]);
    assert!(found[0].message.contains("one of the run host's units"), "{}", found[0].message);
}

#[test]
fn before_version_5_a_unit_is_imported_and_constructed() {
    let found = check("movement hello(run: <manual-[:Invocation]->>) {\n  x = 1\n}\nlisten to manual {} fire hello\n", 4);
    assert!(!found.is_empty());
    let source = "import { manual } from adapters\nruns = manual()\nmovement hello(run: <runs-[:Invocation]->>) {\n  x = run.`Text`\n}\nlisten to runs {} fire hello\n";
    assert_eq!(codes(&check(source, 4)), Vec::<&str>::new());
}
