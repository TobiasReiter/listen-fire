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
