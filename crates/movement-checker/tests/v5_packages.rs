//! A plugin package from language version 5 (design §2.10, §4.3), through
//! the Rust checker: ``import { `@lf/web` as web } from plugins`` binds each
//! member as `web.fetchUrl`, a call of which is an ordinary plugin call. The
//! TypeScript twin is packages/movement-lang/checker/__test__/v5_packages.unit.test.ts.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{},"credentials":{},"plugins":{
  "fetch_url":{"args":["url","email"],"priced":false,"requiredArgs":["url"],"argTypes":{"url":"text","email":"text"},"effects":{},"output":{"kind":"value","type":"text"},"package":"@lf/web"},
  "research":{"args":["name","context"],"priced":false,"requiredArgs":["name"],"argTypes":{"name":"text","context":"text"},"effects":{},"output":{"kind":"record","fields":{"summary":"text"}},"package":"@lf/web"},
  "linkedin_enrichment":{"args":["depth"],"priced":false,"fedArgs":[{"name":"text","required":true}],"argTypes":{"depth":"number"},"package":"@lf/web"},
  "summarize":{"args":["text"],"priced":false,"requiredArgs":["text"],"argTypes":{"text":"text"},"effects":{},"output":{"kind":"value","type":"text"}}
}}"#;

const HEAD: &str = "import { `@lf/web` as web } from plugins\n\n";

fn check(source: &str, version: u32) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap().into_iter().filter(|d| d.is_error()).collect()
}

fn codes(source: &str, version: u32) -> Vec<String> {
    check(source, version).into_iter().map(|d| d.code).collect()
}

fn v5(body: &str) -> String {
    format!("{HEAD}function go(u: <text>, n: <text>, s: <text>) {{\n{body}\n}}\n")
}

#[test]
fn a_package_s_members_are_called_as_its_plugins_are() {
    // Bound, a bare statement, nested in an expression, as another call's argument.
    let program = v5("  p = web.fetchUrl(u)
  web.fetchUrl(u)
  x = Text.length(web.fetchUrl(u, { email: s })) + 1
  r = web.research(web.fetchUrl(u), { context: s })
  y = r.summary");
    assert_eq!(check(&program, 5), Vec::<Diagnostic>::new());
    // Inside closures: a block body and a concise one.
    let closures = v5("  g = (x: <text>) => {
    q = web.fetchUrl(x)
    return q
  }
  h = (x: <text>) => web.fetchUrl(x)
  a = g(u)
  b = h(u)");
    assert_eq!(check(&closures, 5), Vec::<Diagnostic>::new());
}

#[test]
fn a_member_call_binds_and_is_checked_as_the_plugin_s_own_call_is() {
    assert_eq!(codes(&v5("  p = web.fetchUrl(u, { url: s })"), 5), vec!["MOV_THROUGH_BAD_ARG".to_string()]);
    assert_eq!(codes(&v5("  r = web.research()"), 5), vec!["MOV_THROUGH_ARG_MISSING".to_string()]);
    assert_eq!(codes(&v5("  x = Text.upper(web.fetchUrl(u, s))"), 5), vec!["MOV_THROUGH_BAD_ARG".to_string()]);
    assert_eq!(codes(&v5("  r = web.research(n)\n  p = web.fetchUrl(r)"), 5), vec!["MOV_CALL_ARG_TYPE".to_string()]);
    // The named form gets the positional fix, as an unpackaged plugin's does.
    let named = check(&v5("  r = web.research(name: n, context: s)"), 5);
    let fixes: Vec<_> = named.iter().filter(|d| d.code == "MOV_V5_SPELLING").map(|d| d.fix.as_ref().map(|f| f["edits"][0]["text"].clone())).collect();
    assert_eq!(fixes, vec![Some(serde_json::json!("n, { context: s }"))]);
}

#[test]
fn an_unknown_member_names_the_package_s_members() {
    for body in ["  p = web.fetchUr(u)", "  web.fetchUr(u)", "  x = Text.length(web.fetchUr(u))"] {
        let found = check(&v5(body), 5);
        assert_eq!(found.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), vec!["MOV_V5_UNKNOWN_MEMBER"], "{body}");
        assert_eq!(found[0].message, "`web` has no member `fetchUr` (its members: `fetchUrl`, `research`, `linkedinEnrichment`) — did you mean `fetchUrl`?");
    }
    // A plugin of no package is not one of its members.
    assert_eq!(codes(&v5("  p = web.summarize(u)"), 5), vec!["MOV_V5_UNKNOWN_MEMBER".to_string()]);
}

#[test]
fn an_unknown_tag_is_an_unknown_plugin() {
    let source = "import { `@lf/nope` as nope } from plugins\n\nfunction go(u: <text>) {\n  p = 1\n}\n";
    let found = check(source, 5);
    assert_eq!(found.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), vec!["MOV_IMPORT_UNKNOWN"]);
    assert_eq!(found[0].message, "Unknown plugin '@lf/nope' in 'plugins'");
}

#[test]
fn versions_1_to_4_read_a_tag_as_an_unknown_plugin() {
    let source = "import { `@lf/web` as web } from plugins\n\nmovement go(u: <text>) {\n  p = 1\n}\n";
    assert_eq!(codes(source, 4), vec!["MOV_IMPORT_UNKNOWN".to_string()]);
}

#[test]
fn a_local_binding_is_never_a_package() {
    // A dot on a record reads a field; it is never a member call of a package.
    let found = codes(&v5("  box = { n: 1 }\n  v = box.fetchUrl()"), 5);
    assert_eq!(found, vec!["MOV_FUNCTION_UNKNOWN".to_string()]);
}

fn stage(through: &str) -> String {
    format!(
        "{HEAD}function go(u: <text>) {{\n  found = extract from [u] {{\n    name: \"the name\"\n  }} through [{through}] {{\n    detail: \"more\"\n  }}\n}}\n"
    )
}

#[test]
fn a_through_stage_names_a_package_s_member() {
    assert_eq!(check(&stage("web.linkedinEnrichment"), 5), Vec::<Diagnostic>::new());
    assert_eq!(check(&stage("web.linkedinEnrichment({ depth: 2 })"), 5), Vec::<Diagnostic>::new());
    let unknown = check(&stage("web.linkedin"), 5);
    assert_eq!(unknown.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), vec!["MOV_V5_UNKNOWN_MEMBER"]);
}

#[test]
fn a_package_imported_without_a_name_is_refused_with_one() {
    let source = "import { `@lf/web` } from plugins\n\nfunction go(u: <text>) {\n  p = 1\n}\n";
    let found = check(source, 5);
    assert_eq!(found.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), vec!["MOV_V5_IMPORT_NEEDS_ALIAS"]);
    assert_eq!(
        found[0].message,
        "`@lf/web` is imported without a name to call it by — a package's members are called through the name after 'as' (web.<member>(…)), and `@lf/web` is not a name a program can write: write `@lf/web` as web"
    );
    let fix = found[0].fix.as_ref().unwrap();
    assert_eq!(fix["edits"][0]["text"], serde_json::json!(" as web"));
    assert_eq!(fix.get("safe"), None, "the name it suggests may be taken");
    // A plugin imported by its own name needs none.
    assert_eq!(codes("import { summarize } from plugins\n\nfunction go(u: <text>) {\n  p = summarize(u)\n}\n", 5), Vec::<String>::new());
}
