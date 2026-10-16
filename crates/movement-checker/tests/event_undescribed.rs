//! MOV_EVENT_UNDESCRIBED: a read or a write off a movement's event parameter
//! — or a closure's, or a library function's — whose instance the catalog has
//! no description of. Refused from version 5 (the upgrade warning on a check
//! for a move up across 5), unsaid before. The TypeScript twin is
//! packages/movement-lang/checker/__test__/event_undescribed.unit.test.ts.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const UNDESCRIBED: &str = r#""manual":{"constructionArgs":[],"canFire":true,"triggerConfig":[],"schemas":{}}"#;
const DESCRIBED: &str = r#""manual":{"constructionArgs":[],"canFire":true,"triggerConfig":[],"schemas":{"":{"positions":{"Invocation":{"properties":{"text":"text"},"edges":{}}},"collections":{},"writableRoots":{},"eventPosition":"Invocation","eventPositions":[{"position":"Invocation"}]}}}"#;

const V5: &str = "import { manual } from adapters\nruns = connect manual\nfunction recap(go: <runs-[:Invocation]->>) {\n  t = go.`text`\n  go-[r:record]-> { fail(\"${r.`Name`}\") }\n}\nlisten to runs {} fire recap";
const BEFORE_5: &str = "import { manual } from adapters\nruns = manual()\nmovement recap(go: <runs-[:Invocation]->>) {\n  t = go.`text`\n  go-[r:record]-> { ERROR(\"${r.`Name`}\") }\n}\nlisten to runs {} fire recap";

fn check(source: &str, version: u32, manual: &str) -> Vec<Diagnostic> {
    check_with(source, version, manual, None, "{}")
}

fn check_with(source: &str, version: u32, manual: &str, upgrading_from: Option<u32>, files: &str) -> Vec<Diagnostic> {
    let snapshot = format!(r#"{{"adapters":{{{manual}}},"credentials":{{}},"plugins":{{}},"files":{files}}}"#);
    let catalog = CatalogSnapshot::load(&snapshot).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from, parse_version: None, zones: &movement_checker::host::native::NativeZones };
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

#[test]
fn a_check_for_a_move_up_across_5_gives_the_upgrade_warning_which_holds_the_pin() {
    for from in [3, 4] {
        let diagnostics = check_with(V5, 5, UNDESCRIBED, Some(from), "{}");
        assert_eq!(found(&diagnostics), [("MOV_EVENT_UNDESCRIBED", "Some(Warning)".to_string(), 4), ("MOV_EVENT_UNDESCRIBED", "Some(Warning)".to_string(), 5)]);
        assert!(diagnostics.iter().all(|d| d.upgrade == Some(true)), "from {from}");
        assert_eq!(
            diagnostics[0].message,
            "since \"Dancing Wren\" (5) a read or write off 'go' is refused while 'runs-[:Invocation]->' has no description in the catalog; before, it read null. The catalog describes it from the system behind 'runs': check that its connection resolves and the system answers, then upgrade."
        );
    }
}

#[test]
fn version_5_refuses_a_read_off_a_closures_parameter_typed_as_the_event() {
    let source = "import { manual } from adapters\nruns = connect manual\nfunction recap(n: <number>) {\n  subject = (go: <runs-[:Invocation]->>) => go.`text`\n  return n\n}";
    assert_eq!(found(&check(source, 5, UNDESCRIBED)), [("MOV_EVENT_UNDESCRIBED", "None".to_string(), 4)]);
}

#[test]
fn version_5_refuses_a_read_off_a_library_functions_parameter_at_the_import() {
    let library = r#"{"lib/recap":{"source":"import { manual } from adapters\nruns = connect manual\nexport function recap(go: <runs-[:Invocation]->>) {\n  return go.`text`\n}"}}"#;
    let diagnostics = check_with("import { recap } from \"lib/recap\"\nx = 1", 5, UNDESCRIBED, None, library);
    assert_eq!(diagnostics.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), ["MOV_EVENT_UNDESCRIBED"]);
    assert!(diagnostics[0].message.starts_with("\"lib/recap\" line 4: "), "{}", diagnostics[0].message);
}

/// Undescribed, the event is still a record, only not which one: from
/// version 5 a value it reaches is refused as a record is, however it got
/// there. Before 5 it stays untyped. (The TypeScript twin: "an undescribed
/// event held as a value".)
mod held_as_a_value {
    use super::*;

    const KG: &str = r#""kg":{"constructionArgs":[],"schemas":{"":{"positions":{"note":{"properties":{"payload":"json"},"edges":{}}},"collections":{"note":{"target":"note"}},"writableRoots":{"note":{"fields":{"payload":"json"},"resultShape":{"externalId":"text"}}}}}}"#;
    const LIBRARY: &str = "import { manual } from adapters\nruns = connect manual\nexport function mk(a: <number>) {\n  return (b: <runs-[:Invocation]->>) => {\n    return (c: <number>) => b\n  }\n}";

    fn codes(body: &[&str], version: u32) -> Vec<String> {
        let v5 = version >= 5;
        let source = [
            "import { mk } from \"lib/mk\"",
            "import { manual, kg } from adapters",
            if v5 { "runs = connect manual" } else { "runs = manual()" },
            if v5 { "graph = connect kg" } else { "graph = kg()" },
            if v5 { "function recap(go: <runs-[:Invocation]->>) {" } else { "movement recap(go: <runs-[:Invocation]->>) {" },
        ]
        .into_iter()
        .chain(body.iter().copied())
        .chain(["}", "listen to runs {} fire recap"])
        .collect::<Vec<_>>()
        .join("\n");
        let library = if v5 { LIBRARY.to_string() } else { LIBRARY.replace("connect manual", "manual()").replace("export function", "export movement") };
        let files = serde_json::json!({ "lib/mk": { "source": library } }).to_string();
        check_with(&source, version, &format!("{UNDESCRIBED},{KG}"), None, &files).into_iter().map(|d| d.code).collect()
    }

    #[test]
    fn is_refused_in_a_json_field_however_it_got_there() {
        for body in [
            &["  write graph-[:note]-> { payload: go }"][..],
            &["  write graph-[:note]-> { payload: { r: [go] } }"],
            &["  x = go", "  write graph-[:note]-> { payload: { r: x } }"],
            &["  f = (b: <runs-[:Invocation]->>) => b", "  write graph-[:note]-> { payload: { r: f(go) } }"],
            &["  h = mk(2)", "  k = h(go)", "  r = k(1)", "  write graph-[:note]-> { payload: { r: r } }"],
        ] {
            assert_eq!(codes(body, 5), ["MOV_WRITE_FIELD_TYPE"], "{body:?}");
        }
    }

    #[test]
    fn keeps_the_read_refusal_through_a_name() {
        assert_eq!(codes(&["  x = go", "  t = x.`text`"], 5), ["MOV_EVENT_UNDESCRIBED"]);
    }

    #[test]
    fn says_nothing_under_version_4_as_before() {
        assert!(codes(&["  write graph-[:note]-> { payload: go }"], 4).is_empty());
    }
}
