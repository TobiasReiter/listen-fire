//! The extraction family against a small registry with one plugin. The
//! expected diagnostics were read off the TypeScript checker run on the same
//! programs and catalog.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"registry":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"public_registry":{"positions":{"entity":{"properties":{"Name":"text","City":"text","Stage":{"kind":"enum","options":["Seed","Growth"]}},"edges":{"Holdings":{"target":"holding"}}},"holding":{"properties":{"Amount":"number"},"edges":{}}},"collections":{"entities":{"target":"entity"}},"writableRoots":{"entities":{"fields":{"Name":"text","Founded":"date","Stage":{"kind":"enum","options":["Seed","Growth"]}},"resultShape":{"Name":"text"}}}}}}},"credentials":{"public_registry":{"adapters":["registry"]}},"plugins":{"lookup":{"args":["q"],"priced":false,"requiredArgs":["q"]}},"models":["claude-opus-5"]}"#;

fn check(source: &str, version: u32) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options)
        .unwrap()
        .into_iter()
        .filter(|d| d.code != "MOV_LISTEN_MISSING" && d.code != "MOV_LANGUAGE_VERSION_DEPRECATED")
        .collect()
}

fn at(d: &Diagnostic) -> (&str, (usize, usize), (usize, usize)) {
    (d.code.as_str(), (d.span.start.line, d.span.start.col), (d.span.end.line, d.span.end.col))
}

const STAGES: &str = r#"import { registry } from adapters
import { public_registry as pr } from credentials
import { lookup } from plugins
reg = registry(credentials: pr)
node Company: "each company" {
  name: <text> "its name"
  size: <number> "its headcount"
}
movement main(e: <reg-[:entity]->>) {
  found = extract from [e.`Name`] {
    name: "the name"
  } through [lookup(q: detail, extra: 1)] {
    detail: <nubmer> "more"
  }
  companies = extract([e.`Name`], Company, { teir: 'careful', model: 'claude-opus-6' })
  big = ONLY(companies).size > 3
  lookup(q: "x")
}
"#;

#[test]
fn stages_calls_and_annotations_say_what_the_typescript_says() {
    let found = check(STAGES, 5);
    let places: Vec<_> = found.iter().map(at).collect();
    assert_eq!(
        places,
        vec![
            ("MOV_THROUGH_FORWARD_REF", (12, 24), (12, 30)),
            ("MOV_THROUGH_BAD_ARG", (12, 39), (12, 40)),
            ("MOV_UNKNOWN_TYPE_NAME", (13, 5), (13, 28)),
            ("MOV_EXTRACT_CONFIG", (15, 44), (15, 87)),
            ("MOV_EXTRACT_CONFIG", (15, 44), (15, 87)),
            ("MOV_ABSENT_REQUIRED", (16, 9), (16, 33)),
            ("MOV_PLUGIN_ROW_UNDECLARED", (17, 3), (17, 17)),
        ]
    );
    assert_eq!(found[2].message, "'nubmer' is not a type — annotate with a primitive (text, number, boolean, date, datetime, file, json), a type you declare (`type nubmer = <\"A\" | \"B\">`), or another field's type by path (<crm-[:companies]->.`funding_stage`>) — did you mean 'number'?");
    assert_eq!(found[4].message, "'extract': 'claude-opus-6' is not a model this deployment reaches — did you mean 'claude-opus-5'? — it reaches 'claude-opus-5'");
}

const RESOURCES: &str = r#"import { registry } from adapters
import { public_registry as pr } from credentials
import { lookup } from plugins
reg = registry(credentials: pr)
movement main(e: <reg-[:entity]->>) {
  found = extract from [e.`Name`] {
    name: "the name"
  } through [lookup(q: name)] {
    round: "the round"
  } through [lookup(q: round)] {
    detail: "more"
  }
  found-[r:_resources WHERE @resource.url != ""]-> { u = r.url }
  x = @resource.url
  write reg-[:entities]-> { Name: "a", Founded ?: found.detail, Stage: found.name }
  s = found.nme
}
"#;

#[test]
fn a_retired_resource_read_inside_a_head_is_rewritten_in_place() {
    let found = check(RESOURCES, 3);
    let places: Vec<_> = found.iter().map(at).collect();
    assert_eq!(
        places,
        vec![
            ("MOV_RESOURCE_READ_RETIRED", (13, 3), (13, 51)),
            ("MOV_RESOURCE_READ_RETIRED", (14, 7), (14, 20)),
            ("MOV_WRITE_READ_ONLY_EDGE", (15, 9), (15, 27)),
            ("MOV_EXTRACT_UNKNOWN_FIELD", (16, 7), (16, 16)),
        ]
    );
    let fix = found[0].fix.as_ref().expect("the rewrite");
    assert_eq!(fix["edits"][0]["span"]["start"]["col"], 29);
    assert_eq!(fix["edits"][0]["span"]["end"]["col"], 42);
    assert_eq!(fix["edits"][0]["text"], "url");
    assert_eq!(found[3].message, "'nme' is not a field of the extract result — it declares: name, round, detail");
}
