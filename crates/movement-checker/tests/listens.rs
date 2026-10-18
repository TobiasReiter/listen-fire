//! The listens, systems and imports families on their own programs. Parity
//! with the TypeScript checker is the harness's job (parity/run.sh); these
//! pin the behaviours that span statements.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CRON: &str = r#""cron":{"constructionArgs":[],"canFire":true,"triggerConfig":["schedule","timezone"],"triggerConfigRequired":["schedule"],"triggerConfigFormats":{"schedule":"cron","timezone":"timezone"},"schemas":{"":{"positions":{"Tick":{"properties":{},"edges":{}}},"collections":{},"writableRoots":{},"eventPosition":"Tick","eventPositions":[{"position":"Tick"}]}}}"#;

fn check(source: &str, files: &str) -> Vec<Diagnostic> {
    let snapshot = format!(r#"{{"adapters":{{{CRON}}},"credentials":{{}},"plugins":{{}}{files}}}"#);
    let catalog = CatalogSnapshot::load(&snapshot).unwrap();
    let options = CheckOptions { language_version: 3, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap()
}

fn codes(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().map(|d| d.code.as_str()).collect()
}

#[test]
fn a_dispatchable_movement_without_a_listen_is_told_how_to_add_one() {
    let found = check("import { cron } from adapters\nt = cron()\nmovement digest(e: <t-[:Tick]->>) {}", "");
    assert_eq!(codes(&found), ["MOV_LISTEN_MISSING"]);
    assert!(found[0].message.ends_with("e.g. listen to t { schedule: \"0 9 * * 1\" } fire digest"), "{}", found[0].message);
}

#[test]
fn any_listen_silences_the_missing_listen_and_its_config_is_checked() {
    let found = check(
        "import { cron } from adapters\nt = cron()\nmovement digest(e: <t-[:Tick]->>) {}\nlisten to t { schedule: \"61 9 * * 1\" } fire digest",
        "",
    );
    assert_eq!(codes(&found), ["MOV_LISTEN_BAD_CONFIG"]);
    assert!(found[0].message.contains("minute value 61 is out of range (0-59)"), "{}", found[0].message);
}

#[test]
fn a_library_is_checked_once_and_its_errors_surface_at_the_import() {
    let files = r#","files":{"lib/a":{"source":"export movement helper(n: <number>) {\n  x = nowhere\n}"}}"#;
    let found = check("import { helper } from \"lib/a\"\nimport { nope } from \"lib/a\"\nmovement m(n: <number>) {\n  helper(n: n)\n}", files);
    assert_eq!(codes(&found), ["MOV_IMPORT_NOT_EXPORTED", "MOV_NAME_UNRESOLVED"]);
    assert!(found[0].message.starts_with("\"lib/a\" does not export 'nope'"), "{}", found[0].message);
    assert!(found[1].message.starts_with("\"lib/a\" line 2: Unknown name 'nowhere'"), "{}", found[1].message);
    assert_eq!(found[1].span.start.line, 1);
}

/// A host whose zone database holds one zone.
struct OneZone(&'static str);

impl movement_checker::host::ZoneLookup for OneZone {
    fn is_zone(&self, zone: &str) -> bool {
        zone == self.0
    }
}

#[test]
fn a_cron_time_zone_is_the_hosts_to_recognise() {
    let source = "import { cron } from adapters\nt = cron()\nmovement digest(e: <t-[:Tick]->>) {}\nlisten to t { schedule: \"0 9 * * 1\", timezone: \"Narnia/Cair\" } fire digest";
    let snapshot = format!(r#"{{"adapters":{{{CRON}}},"credentials":{{}},"plugins":{{}}}}"#);
    let catalog = CatalogSnapshot::load(&snapshot).unwrap();
    let with = |zones: &dyn movement_checker::host::ZoneLookup| {
        check_source(source, &catalog, CheckOptions { language_version: 3, upgrading_from: None, parse_version: None, zones }).unwrap()
    };
    let refused = with(&movement_checker::host::native::NativeZones);
    assert_eq!(codes(&refused), ["MOV_LISTEN_BAD_CONFIG"]);
    assert!(refused[0].message.starts_with("'Narnia/Cair' is not a recognised IANA time zone"), "{}", refused[0].message);
    assert!(with(&OneZone("Narnia/Cair")).is_empty());
}

const FEED: &str = r#""feed":{"constructionArgs":[],"canFire":true,"triggerConfig":["pollIntervalSeconds"],"schemas":{"":{"positions":{"Note":{"properties":{},"edges":{}}},"collections":{},"writableRoots":{},"eventPosition":"Note","eventPositions":[{"position":"Note"}]}}}"#;

fn check_feed(listen: &str, language_version: u32) -> Vec<Diagnostic> {
    let snapshot = format!(r#"{{"adapters":{{{FEED}}},"credentials":{{}},"plugins":{{}}}}"#);
    let catalog = CatalogSnapshot::load(&snapshot).unwrap();
    let options = CheckOptions { language_version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let (connect, movement) = if language_version >= 5 { ("connect feed", "function") } else { ("feed()", "movement") };
    let source = format!("import {{ feed }} from adapters\nf = {connect}\n{movement} seen(n: <f-[:Note]->>) {{}}\n{listen}");
    check_source(&source, &catalog, options).unwrap()
}

#[test]
fn from_version_5_a_polled_listens_interval_is_every() {
    assert_eq!(codes(&check_feed("listen to f { every: 5m } fire seen", 5)), Vec::<&str>::new());
    let bad = check_feed("listen to f { every: 5 } fire seen", 5);
    assert_eq!(codes(&bad), ["MOV_LISTEN_BAD_CONFIG"]);
    assert!(bad[0].message.contains("not a valid poll interval"), "{}", bad[0].message);
}

#[test]
fn the_old_poll_interval_key_is_respelled_under_5_and_the_only_spelling_before() {
    let old = check_feed("listen to f { pollIntervalSeconds: 300 } fire seen", 5);
    assert_eq!(codes(&old), ["MOV_V5_SPELLING"]);
    assert!(old[0].message.contains("every: 5m"), "{}", old[0].message);
    assert_eq!(codes(&check_feed("listen to f { pollIntervalSeconds: 300 } fire seen", 4)), Vec::<&str>::new());
    // Before 5 `every` is not a key the source takes.
    assert_eq!(codes(&check_feed("listen to f { every: 5m } fire seen", 4)), ["MOV_LISTEN_BAD_CONFIG"]);
}
