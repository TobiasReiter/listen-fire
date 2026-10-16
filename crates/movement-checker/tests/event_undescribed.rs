//! MOV_EVENT_UNDESCRIBED: a read or a write off a movement's event parameter
//! whose instance the catalog has no description of. Refused from version 5,
//! unsaid before. The TypeScript twin is
//! packages/movement-lang/checker/__test__/event_undescribed.unit.test.ts.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const UNDESCRIBED: &str = r#""manual":{"constructionArgs":[],"canFire":true,"triggerConfig":[],"schemas":{}}"#;
const DESCRIBED: &str = r#""manual":{"constructionArgs":[],"canFire":true,"triggerConfig":[],"schemas":{"":{"positions":{"Invocation":{"properties":{"text":"text"},"edges":{}}},"collections":{},"writableRoots":{},"eventPosition":"Invocation","eventPositions":[{"position":"Invocation"}]}}}"#;

const V5: &str = "import { manual } from adapters\nruns = connect manual\nfunction recap(go: <runs-[:Invocation]->>) {\n  t = go.`text`\n  go-[r:record]-> { fail(\"${r.`Name`}\") }\n}\nlisten to runs {} fire recap";
const BEFORE_5: &str = "import { manual } from adapters\nruns = manual()\nmovement recap(go: <runs-[:Invocation]->>) {\n  t = go.`text`\n  go-[r:record]-> { ERROR(\"${r.`Name`}\") }\n}\nlisten to runs {} fire recap";

fn check(source: &str, version: u32, manual: &str) -> Vec<Diagnostic> {
    let snapshot = format!(r#"{{"adapters":{{{manual}}},"credentials":{{}},"plugins":{{}}}}"#);
    let catalog = CatalogSnapshot::load(&snapshot).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap()
}

/// Code, severity (`None` is an error) and line.
fn found(diagnostics: &[Diagnostic]) -> Vec<(&str, String, usize)> {
    diagnostics.iter().map(|d| (d.code.as_str(), format!("{:?}", d.severity), d.span.start.line)).collect()
}

#[test]
fn version_5_refuses_a_field_read_and_a_walk_off_an_undescribed_event_each_where_it_is() {
    let diagnostics = check(V5, 5, UNDESCRIBED);
    assert_eq!(found(&diagnostics), [("MOV_EVENT_UNDESCRIBED", "None".to_string(), 4), ("MOV_EVENT_UNDESCRIBED", "None".to_string(), 5)]);
    assert_eq!(
        diagnostics[0].message,
        "'runs-[:Invocation]->' has no description in the catalog, so a read or write off 'go' can't be checked — it would be null at run time. The catalog describes it from the system behind 'runs': check that its connection resolves and the system answers, then check again."
    );
}

#[test]
fn versions_1_to_4_say_nothing_as_before() {
    for version in [1, 2, 3, 4] {
        assert!(check(BEFORE_5, version, UNDESCRIBED).is_empty(), "version {version}");
    }
}

#[test]
fn a_described_event_a_parameter_nothing_reads_and_an_unknown_adapter_are_silent() {
    let unread = V5.replace("  t = go.`text`\n  go-[r:record]-> { fail(\"${r.`Name`}\") }\n", "  return go\n");
    let unknown = V5.replace("manual", "nope");
    for (source, manual) in [(V5, DESCRIBED), (unread.as_str(), UNDESCRIBED), (unknown.as_str(), UNDESCRIBED)] {
        let diagnostics = check(source, 5, manual);
        assert!(!diagnostics.iter().any(|d| d.code == "MOV_EVENT_UNDESCRIBED"), "{source}: {diagnostics:?}");
    }
}
