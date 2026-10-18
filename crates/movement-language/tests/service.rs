//! Each query of the language service on small v5 programs, whole and half-typed.

use movement_language::{DiagSeverity, Item, ItemKind, Pos, Range, Service};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{
  "cron":{"constructionArgs":[],"canFire":true,"triggerConfig":["schedule","timezone"],"triggerConfigRequired":["schedule"],"triggerConfigFormats":{"schedule":"cron","timezone":"timezone"},"schemas":{"":{"positions":{"Tick":{"properties":{"Fired at":"date"},"edges":{}}},"collections":{},"writableRoots":{},"eventPosition":"Tick","eventPositions":[{"position":"Tick"}]}}},
  "manual":{"constructionArgs":[],"canFire":true,"schemas":{"":{"positions":{"Invocation":{"properties":{"Text":"text","Run by (name)":"text"},"edges":{}}},"collections":{},"writableRoots":{},"eventPosition":"Invocation","eventPositions":[{"position":"Invocation"}]}}},
  "slack":{"constructionArgs":[],"canFire":true,"triggerConfig":["channel","pollIntervalSeconds"],"triggerConfigRequired":["channel"],"schemas":{"":{"positions":{
    "channel":{"properties":{"Name":"text"},"edges":{"Messages":{"target":"message","readable":true,"sequenced":"chronological"}}},
    "message":{"properties":{"Body":"text","Score":"number"},"edges":{}}},
    "collections":{"Channels":{"target":"channel"}},"writableRoots":{}}}}},
  "credentials":{"acme_bot":{"adapters":["slack"]},"other_crm":{"adapters":["attio"]}},
  "plugins":{"fetch_url":{"args":["url"],"package":"@lf/web"},"summarise":{"args":["text"]}},
  "files":{"lib/greet":{"source":"export function greet(name: <text>) {\n  return \"Hi ${name}\"\n}\n"}}}"#;

const PROGRAM: &str = "import { `@lf/slack` as slack } from adapters
import { greet } from \"lib/greet\"
chat = connect slack

function hello(run: <manual-[:Invocation]->>) {
  greeting = Text.upper(run.`Text`)
  return greet(greeting)
}

function scan(c: <chat-[:channel]->>) {
  ms = c-[m:Messages WHERE m.Score > 1]->
  return count(ms)
}

listen to manual fire hello
";

fn service() -> Service {
    Service::new(CatalogSnapshot::load(CATALOG).unwrap(), 5)
}

/// The position just after the `n`th (0-based) occurrence of `marker` in `source`.
fn after(source: &str, marker: &str, n: usize) -> Pos {
    let at = source.match_indices(marker).nth(n).unwrap_or_else(|| panic!("no {marker}")).0 + marker.len();
    let before = &source[..at];
    let line = before.matches('\n').count() as u32;
    let character = before.rsplit('\n').next().unwrap().encode_utf16().count() as u32;
    Pos { line, character }
}

/// `source` with `inserted` written at `pos`'s line end... at the byte after `marker`.
fn typed(source: &str, marker: &str, inserted: &str) -> (String, Pos) {
    let at = source.find(marker).unwrap() + marker.len();
    let text = format!("{}{inserted}{}", &source[..at], &source[at..]);
    let pos = after(&text, &format!("{marker}{inserted}"), 0);
    (text, pos)
}

fn labels(items: &[Item]) -> Vec<&str> {
    items.iter().map(|i| i.label.as_str()).collect()
}

#[test]
fn a_whole_program_checks_clean() {
    let found = service().diagnostics(PROGRAM);
    assert!(found.iter().all(|d| d.severity != DiagSeverity::Error), "{found:?}");
}

#[test]
fn a_file_that_does_not_parse_reports_its_refusal() {
    let found = service().diagnostics("function f( {\n");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].code, "MOV_PARSE");
}

#[test]
fn the_scope_at_the_cursor_holds_what_is_bound_above_it() {
    // Half-typed: a new line `  x = ` inside hello, after `greeting`.
    let (text, pos) = typed(PROGRAM, "  greeting = Text.upper(run.`Text`)\n", "  x = gr");
    let items = service().complete(&text, pos);
    let names = labels(&items);
    for expected in ["greeting", "run", "hello", "scan", "chat", "greet", "manual", "cron", "map", "Text"] {
        assert!(names.contains(&expected), "{expected} missing from {names:?}");
    }
    // `c` is scan's parameter, not hello's; `ms` is bound in scan.
    assert!(!names.contains(&"c") && !names.contains(&"ms"), "{names:?}");
    let greeting = items.iter().find(|i| i.label == "greeting").unwrap();
    assert_eq!(greeting.detail.as_deref(), Some("text"));
}

#[test]
fn a_binding_below_the_cursor_is_not_yet_in_scope() {
    let pos = after(PROGRAM, "function hello(run: <manual-[:Invocation]->>) {\n", 0);
    let names: Vec<String> = labels(&service().complete(PROGRAM, pos)).into_iter().map(String::from).collect();
    assert!(names.contains(&"run".to_string()) && !names.contains(&"greeting".to_string()), "{names:?}");
}

#[test]
fn fields_follow_a_dot_and_a_backtick() {
    let (text, pos) = typed(PROGRAM, "  greeting = Text.upper(run.`Text`)\n", "  y = run.");
    let items = service().complete(&text, pos);
    assert_eq!(labels(&items), ["Text", "Run by (name)"]);
    assert_eq!(items[1].insert.as_deref(), Some("`Run by (name)`"));
    assert_eq!(items[0].detail.as_deref(), Some("text"));
    let (text, pos) = typed(PROGRAM, "  greeting = Text.upper(run.`Text`)\n", "  y = run.`Ru");
    let items = service().complete(&text, pos);
    assert!(labels(&items).contains(&"Run by (name)"));
    assert!(items[0].insert.is_none() && items[0].replace.is_some());
}

#[test]
fn fields_follow_a_hop_alias() {
    let (text, pos) = typed(PROGRAM, "  ms = c-[m:Messages WHERE m.", "");
    let items = service().complete(&text, pos);
    assert_eq!(labels(&items), ["Body", "Score"]);
    // Half-typed: the WHERE not finished.
    let (text, pos) = typed(PROGRAM, "  return count(ms)\n", "  ns = c-[n:Messages WHERE n.");
    assert_eq!(labels(&service().complete(&text, pos)), ["Body", "Score"]);
}

#[test]
fn edges_follow_a_hop_opening() {
    let (text, pos) = typed(PROGRAM, "  return count(ms)\n", "  ns = c-[:");
    let items = service().complete(&text, pos);
    assert_eq!(labels(&items), ["Messages"]);
    assert_eq!(items[0].kind, ItemKind::Edge);
    assert!(items[0].detail.as_deref().unwrap().contains("message"), "{:?}", items[0].detail);
    // Off the instance itself: its collections.
    let (text, pos) = typed(PROGRAM, "  return count(ms)\n", "  all = chat-[:");
    assert_eq!(labels(&service().complete(&text, pos)), ["Channels"]);
    // Two hops deep: the message has no edges.
    let (text, pos) = typed(PROGRAM, "  return count(ms)\n", "  deep = c-[:Messages]->-[:");
    assert!(service().complete(&text, pos).is_empty());
}

#[test]
fn record_types_follow_an_instance_in_a_type() {
    let (text, pos) = typed(PROGRAM, "listen to manual fire hello\n", "function more(x: <chat-[:");
    assert_eq!(labels(&service().complete(&text, pos)), ["channel", "message"]);
}

#[test]
fn a_namespace_offers_its_functions_as_v5_spells_them() {
    let (text, pos) = typed(PROGRAM, "  greeting = Text.upper(run.`Text`)\n", "  z = Text.");
    let items = service().complete(&text, pos);
    let names = labels(&items);
    assert!(names.contains(&"upper") && names.contains(&"includes") && !names.contains(&"UPPER"), "{names:?}");
    assert_eq!(items.iter().find(|i| i.label == "upper").unwrap().detail.as_deref(), Some("Text.upper(text)"));
}

#[test]
fn module_tags_complete_inside_an_import() {
    let source = "import {  } from adapters\n";
    let items = service().complete(source, Pos { line: 0, character: 9 });
    assert_eq!(labels(&items), ["`@lf/slack`"]);
    let items = service().complete("import {  } from plugins\n", Pos { line: 0, character: 9 });
    assert_eq!(labels(&items), ["`@lf/web`", "summarise"]);
    assert_eq!(items[0].insert.as_deref(), Some("`@lf/web` as web"));
    let items = service().complete("import {  } from \"lib/greet\"\n", Pos { line: 0, character: 9 });
    assert_eq!(labels(&items), ["greet"]);
}

#[test]
fn settings_keys_complete_inside_a_listen() {
    let (text, pos) = typed(PROGRAM, "listen to manual fire hello\n", "listen to chat { ");
    let items = service().complete(&text, pos);
    assert_eq!(labels(&items), ["channel", "every", "suppress_self"]);
    assert_eq!(items[0].detail.as_deref(), Some("required by slack"));
    let (text, pos) = typed(PROGRAM, "listen to manual fire hello\n", "listen to cron { ");
    assert_eq!(labels(&service().complete(&text, pos)), ["schedule", "timezone", "suppress_self"]);
}

#[test]
fn credential_names_follow_using() {
    let (text, pos) = typed(PROGRAM, "chat = connect slack", " using ");
    let items = service().complete(&text, pos);
    assert_eq!(labels(&items), ["acme_bot"]);
}

#[test]
fn hover_shows_the_type_a_doc_line_and_a_versioned_link() {
    let service = service();
    let hover = service.hover(PROGRAM, after(PROGRAM, "return greet(gree", 0)).unwrap();
    assert!(hover.contents.contains("greeting: text"), "{}", hover.contents);
    assert!(hover.contents.contains("https://listen-fire.github.io/docs/v5/language#bindings"), "{}", hover.contents);
    let hover = service.hover(PROGRAM, after(PROGRAM, "Text.up", 0)).unwrap();
    assert!(hover.contents.contains("Text.upper(text)") && hover.contents.contains("`UPPER`"), "{}", hover.contents);
    assert!(hover.contents.contains("/docs/v5/functions#text-upper"), "{}", hover.contents);
    let hover = service.hover(PROGRAM, after(PROGRAM, "run.`Te", 0)).unwrap();
    assert!(hover.contents.contains("Text: text"), "{}", hover.contents);
    let hover = service.hover(PROGRAM, after(PROGRAM, "m.Sco", 0)).unwrap();
    assert!(hover.contents.contains("Score: number"), "{}", hover.contents);
    let hover = service.hover(PROGRAM, after(PROGRAM, "c-[m:Mess", 0)).unwrap();
    assert!(hover.contents.contains("landing on"), "{}", hover.contents);
    let hover = service.hover(PROGRAM, after(PROGRAM, "function sc", 0)).unwrap();
    assert!(hover.contents.contains("function scan(c: <chat-[:channel]->>)"), "{}", hover.contents);
}

#[test]
fn definition_finds_bindings_functions_and_library_declarations() {
    let service = service();
    let found = service.definition(PROGRAM, after(PROGRAM, "return greet(gree", 0)).unwrap();
    assert_eq!(found.file, None);
    assert_eq!(found.range.start, Pos { line: 5, character: 2 });
    let found = service.definition(PROGRAM, after(PROGRAM, "listen to manual fire hel", 0)).unwrap();
    assert_eq!(found.range.start, Pos { line: 4, character: 9 });
    let found = service.definition(PROGRAM, after(PROGRAM, "return gre", 0)).unwrap();
    assert_eq!(found.file.as_deref(), Some("lib/greet"));
    assert_eq!(found.range.start.line, 0);
    let found = service.definition(PROGRAM, after(PROGRAM, "from \"lib/gr", 0)).unwrap();
    assert_eq!(found.file.as_deref(), Some("lib/greet"));
    // A parameter.
    let found = service.definition(PROGRAM, after(PROGRAM, "Text.upper(ru", 0)).unwrap();
    assert_eq!(found.range.start, Pos { line: 4, character: 15 });
}

#[test]
fn code_actions_are_the_checker_s_fixes() {
    // An old spelling under 5: MOV_V5_SPELLING with its rewrite.
    let source = PROGRAM.replace("Text.upper(run.`Text`)", "UPPER(run.`Text`)");
    let service = service();
    let found = service.diagnostics(&source);
    let spelling = found.iter().find(|d| d.code == "MOV_V5_SPELLING").unwrap_or_else(|| panic!("{found:?}"));
    let actions = service.code_actions(&source, spelling.range);
    let action = actions.iter().find(|a| a.code == "MOV_V5_SPELLING").unwrap();
    assert!(action.edits.iter().any(|e| e.new_text.contains("Text.upper")), "{actions:?}");
}

#[test]
fn a_did_you_mean_becomes_a_rewrite() {
    let source = PROGRAM.replace("run.`Text`", "run.`Txt`");
    let service = service();
    let found = service.diagnostics(&source);
    let unknown = found.iter().find(|d| d.code == "MOV_UNKNOWN_PROPERTY").unwrap_or_else(|| panic!("{found:?}"));
    let actions = service.code_actions(&source, Range { start: unknown.range.start, end: unknown.range.start });
    let action = actions.iter().find(|a| a.title.contains("'Text'")).unwrap_or_else(|| panic!("{} {actions:?}", unknown.message));
    assert_eq!(action.edits[0].new_text, "Text");
}

#[test]
fn completion_on_a_line_that_breaks_the_parse_still_sees_the_scope() {
    // `(` left open on the cursor's line.
    let (text, pos) = typed(PROGRAM, "  greeting = Text.upper(run.`Text`)\n", "  bad = Text.upper(gr");
    assert!(service().diagnostics(&text).iter().any(|d| d.code == "MOV_PARSE"));
    assert!(labels(&service().complete(&text, pos)).contains(&"greeting"));
    // A function header half written: everything above still answers.
    let (text, pos) = typed(PROGRAM, "listen to manual fire hello\n", "function late(x: <num");
    let names: Vec<String> = labels(&service().complete(&text, pos)).into_iter().map(String::from).collect();
    assert!(names.contains(&"hello".to_string()), "{names:?}");
}
