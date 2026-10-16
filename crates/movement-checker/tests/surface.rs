//! Language version 5's surface through the Rust checker: the everyday
//! spelling checks as the old one does under 4, an old spelling under 5 is
//! MOV_V5_SPELLING with its rewrite, and messages name built-ins in the
//! program's own spelling. Parity with the TypeScript checker is
//! parity/run.sh's.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

fn check(source: &str, version: u32) -> Vec<movement_checker::Diagnostic> {
    let catalog = CatalogSnapshot::load(r#"{"adapters":{},"credentials":{},"plugins":{}}"#).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap()
}

fn codes(source: &str, version: u32) -> Vec<String> {
    check(source, version).into_iter().map(|d| d.code).collect()
}

const V5: &str = "function go(t: <text>, n: <number>) {\n  a = Text.upper(Text.trim(t))\n  b = n > 1 && n < 5 ? Number.round(n) : 0\n  if (a != null || !(n == 2)) {\n    c = Text.length(a)\n  }\n}";
const V4: &str = "movement go(t: <text>, n: <number>) {\n  a = UPPER(TRIM(t))\n  b = IF n > 1 AND n < 5 THEN ROUND(n) ELSE 0 END\n  if a != NULL OR NOT (n == 2) {\n    c = LENGTH(a)\n  }\n}";

#[test]
fn the_everyday_spelling_checks_as_the_old_one_did() {
    assert_eq!(codes(V5, 5), codes(V4, 4));
}

#[test]
fn an_old_spelling_under_5_is_refused_with_its_rewrite() {
    let found = check(V4, 5);
    let spelling: Vec<_> = found.iter().filter(|d| d.code == "MOV_V5_SPELLING").collect();
    assert!(spelling.len() >= 8, "{spelling:#?}");
    assert!(spelling.iter().all(|d| d.fix.is_some()));
    let upper = spelling.iter().find(|d| d.message.starts_with("`UPPER`")).unwrap();
    assert_eq!(upper.message, "`UPPER` is written `Text.upper` from language version 5");
    assert_eq!(upper.fix.as_ref().unwrap()["edits"][0]["text"], "Text.upper");
}

#[test]
fn a_message_names_a_built_in_in_the_program_s_spelling() {
    let v4: Vec<String> = check("movement go(n: <number>) {\n  a = UPPER(n)\n}", 4).into_iter().map(|d| d.message).collect();
    let v5: Vec<String> = check("function go(n: <number>) {\n  a = Text.upper(n)\n}", 5).into_iter().map(|d| d.message).collect();
    assert_eq!(v4.len(), v5.len(), "{v4:?} / {v5:?}");
    for (old, new) in v4.iter().zip(&v5) {
        assert_eq!(new, &movement_parser::surface::table::spell_message(old, 5));
    }
    println!("{v4:?}\n{v5:?}");
}

#[test]
fn a_message_suggests_the_surface_of_its_program_s_version() {
    let v5: Vec<String> = check("function go() {\n  f = () => 1\n  x = !f\n  y = f && f\n}", 5).into_iter().map(|d| d.message).collect();
    assert!(v5[0].starts_with("a value negated by '!' is a closure"), "{v5:?}");
    assert!(v5[1].starts_with("a value joined by '&&' is a closure"), "{v5:?}");
}
