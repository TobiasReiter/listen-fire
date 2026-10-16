//! Language version 5's semantics the spelling rewrite alone cannot carry
//! (the spine report's item (e)), through the Rust checker: under 4 nothing
//! changes; under 5 the old text is refused with a fix, and the fixed program
//! checks clean. The TypeScript twin is
//! packages/movement-lang/checker/__test__/v5_semantics.unit.test.ts.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"slack":{"constructionArgs":[],"schemas":{"":{"positions":{
  "channel":{"properties":{"Name":"text"},"edges":{"Messages":{"target":"message","readable":true,"sequenced":"chronological"}}},
  "message":{"properties":{"Text":"text","Tags":{"kind":"list","of":"text"}},"edges":{}}},
  "collections":{"Channels":{"target":"channel"}},"writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

fn check(source: &str, version: u32) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap().into_iter().filter(|d| d.is_error()).collect()
}

fn codes(source: &str, version: u32) -> Vec<String> {
    check(source, version).into_iter().map(|d| d.code).collect()
}

fn offset(source: &str, line: usize, col: usize) -> usize {
    let start: usize = source.split('\n').take(line - 1).map(|l| l.encode_utf16().count() + 1).sum();
    start + col - 1
}

/// Applies every MOV_V5_SPELLING fix, outermost first, until none is left.
fn upgraded(source: &str) -> String {
    let mut text = source.to_string();
    for _ in 0..8 {
        let refused: Vec<Diagnostic> = check(&text, 5).into_iter().filter(|d| d.code == "MOV_V5_SPELLING").collect();
        if refused.is_empty() {
            return text;
        }
        let mut taken: Vec<(usize, usize, String)> = Vec::new();
        for d in &refused {
            let fix = d.fix.as_ref().unwrap_or_else(|| panic!("no fix: {}", d.message));
            let edits: Vec<(usize, usize, String)> = fix["edits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| {
                    let at = |k: &str| offset(&text, e["span"][k]["line"].as_u64().unwrap() as usize, e["span"][k]["col"].as_u64().unwrap() as usize);
                    (at("start"), at("end"), e["text"].as_str().unwrap().to_string())
                })
                .collect();
            if edits.iter().all(|(s, e, _)| taken.iter().all(|(ts, te, _)| *e <= *ts || *s >= *te)) {
                taken.extend(edits);
            }
        }
        taken.sort_by_key(|(s, _, _)| std::cmp::Reverse(*s));
        let mut units: Vec<u16> = text.encode_utf16().collect();
        for (s, e, t) in taken {
            units.splice(s..e, t.encode_utf16());
        }
        text = String::from_utf16(&units).unwrap();
    }
    panic!("fixes did not settle:\n{text}")
}

const HEAD4: &str = "import { slack } from adapters\nchat = slack()\n\n";
const HEAD5: &str = "import { `@lf/slack` as slack } from adapters\nchat = connect slack\n\n";

#[test]
fn bang_binds_as_typescript_s_unary_operator() {
    let v4 = format!("{HEAD4}movement go(a: <boolean>, b: <boolean>) {{\n  if !a == b {{\n    x = 1\n  }}\n}}");
    assert_eq!(codes(&v4, 4), Vec::<String>::new());
    let v5 = format!("{HEAD5}function go(a: <boolean>, b: <boolean>) {{\n  if (!a == b) {{\n    x = 1\n  }}\n}}");
    let refused: Vec<_> = check(&v5, 5).into_iter().filter(|d| d.code == "MOV_V5_SPELLING").collect();
    assert_eq!(refused.len(), 1, "{refused:#?}");
    assert_eq!(refused[0].fix.as_ref().unwrap()["edits"][0]["text"], "!(a == b)");
    let fixed = upgraded(&v5);
    assert!(fixed.contains("if (!(a == b)) {"), "{fixed}");
    assert_eq!(codes(&fixed, 5), Vec::<String>::new());
}

const CHAT: &str = r#"{"adapters":{"chat":{"constructionArgs":[],"schemas":{"":{"positions":{
  "Channel":{"properties":{"Name":"text","Topic":"text"},"edges":{"Messages":{"target":"Message","writable":true}}},
  "Message":{"properties":{"Message":"text"},"edges":{}}},
  "collections":{"Channels":{"target":"Channel"}},
  "writableRoots":{"Channel":{"fields":{"Name":"text"},"resultShape":{"externalId":"text"}},"Message":{"fields":{"Message":"text"},"resultShape":{"externalId":"text"}}}}}}},"credentials":{},"plugins":{}}"#;

fn chat_codes(body: &str, version: u32) -> Vec<String> {
    let source = if version >= 5 {
        format!("import {{ `@lf/chat` as chat }} from adapters\nc = connect chat\n\nfunction go() {{\n{body}\n}}")
    } else {
        format!("import {{ chat }} from adapters\nc = chat()\n\nmovement go() {{\n{body}\n}}")
    };
    let catalog = CatalogSnapshot::load(CHAT).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &catalog, options).unwrap().into_iter().filter(|d| d.is_error()).map(|d| d.code).collect()
}

#[test]
fn narrowing_on_null_tests_is_what_exists_and_isnull_gave() {
    let (select4, select5) = ("  channel = ONLY(c-[h:Channels WHERE h.Name == \"alerts\"]->)", "  channel = only(c-[h:Channels WHERE h.Name == \"alerts\"]->)");
    let (name4, name5) = ("  n = ONLY(c-[h:Channels]->.Name)", "  n = only(c-[h:Channels]->.Name)");
    let write = "  write channel-[:Messages]-> { Message: \"hi\" }";
    let write_n = "  write c-[:Channels]-> { Name: n }";
    let write_topic = "  write c-[:Channels]-> { Name: channel.Topic }";
    let pairs = [
        (format!("{select4}\n{write}"), format!("{select5}\n{write}")),
        (format!("{select4}\n  if EXISTS(channel) {{\n{write}\n  }}"), format!("{select5}\n  if (channel != null) {{\n{write}\n  }}")),
        (format!("{name4}\n  if EXISTS(n) {{\n{write_n}\n  }}"), format!("{name5}\n  if (n != null) {{\n{write_n}\n  }}")),
        (format!("{select4}\n  if EXISTS(channel.Topic) {{\n{write_topic}\n  }}"), format!("{select5}\n  if (channel.Topic != null) {{\n{write_topic}\n  }}")),
        (format!("{select4}\n  if EXISTS(channel) {{\n  }}\n{write}"), format!("{select5}\n  if (channel != null) {{\n  }}\n{write}")),
        (format!("{name4}\n  if ISNULL(n) {{\n    ERROR(\"no\")\n  }}\n{write_n}"), format!("{name5}\n  if (n == null) {{\n    fail(\"no\")\n  }}\n{write_n}")),
        (format!("{select4}\n  if NOT EXISTS(channel) {{\n    ERROR(\"no\")\n  }}\n{write}"), format!("{select5}\n  if (channel == null) {{\n    fail(\"no\")\n  }}\n{write}")),
        (format!("{select4}\n  if ISNULL(channel.Topic) {{\n    ERROR(\"no\")\n  }}\n{write_topic}"), format!("{select5}\n  if (channel.Topic == null) {{\n    fail(\"no\")\n  }}\n{write_topic}")),
        (format!("{name4}\n  if ISNULL(n) {{\n  }}\n{write_n}"), format!("{name5}\n  if (n == null) {{\n  }}\n{write_n}")),
        (format!("{name4}\n  if EXISTS(n) OR 1 == 1 {{\n{write_n}\n  }}"), format!("{name5}\n  if (n != null || 1 == 1) {{\n{write_n}\n  }}")),
    ];
    for (v4, v5) in &pairs {
        assert_eq!(chat_codes(v5, 5), chat_codes(v4, 4), "{v5}");
    }
    assert_eq!(chat_codes(&pairs[0].1, 5), vec!["MOV_ABSENT_REQUIRED"]);
    assert_eq!(chat_codes(&pairs[8].1, 5), vec!["MOV_ABSENT_REQUIRED"]);
}
