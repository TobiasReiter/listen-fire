//! Rules the parity corpus never exercises (most are language version 4 and
//! 5 rules, which the corpus has not been re-harvested under yet). Each
//! expectation is the TypeScript checker's own answer on the same program,
//! read off it on 2026-10-15: every diagnostic, in order, with its span.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

fn check(source: &str, version: u32) -> Vec<String> {
    let catalog = CatalogSnapshot::load(r#"{"adapters":{},"credentials":{},"plugins":{}}"#).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options)
        .unwrap()
        .into_iter()
        .map(|d| format!("{} {}:{}-{}:{} {}", d.code, d.span.start.line, d.span.start.col, d.span.end.line, d.span.end.col, d.message))
        .collect()
}

#[test]
fn a_file_combined_into_text_is_refused_from_version_5() {
    let source = "movement m(f: <file>, g: <file[]>, n: <text>) {\n  a = \"see ${f}\"\n  b = \"all ${g}\"\n  c = IF n == \"x\" THEN f ELSE n END\n  d = \"maybe ${c}\"\n  return a\n}\n";
    assert_eq!(
        check(source, 5),
        [
            "MOV_FILE_IN_TEXT 2:7-2:17 this is a file, and a file is not text, so it can't be combined into text — its text is READ(f) ('${COALESCE(READ(f), \"\")}'), or write the file into a field that holds files",
            "MOV_FILE_IN_TEXT 3:7-3:17 this may be a file, and a file is not text, so it can't be combined into text — its text is READ(f) ('${COALESCE(READ(f), \"\")}'), or write the file into a field that holds files",
            "MOV_FILE_IN_TEXT 5:7-5:19 this may be a file, and a file is not text, so it can't be combined into text — its text is READ(f) ('${COALESCE(READ(f), \"\")}'), or write the file into a field that holds files",
        ]
    );
    assert!(check(source, 4).iter().all(|d| !d.starts_with("MOV_FILE_IN_TEXT")));
}

#[test]
fn a_written_value_type_names_value_types_and_holds_no_closure() {
    let source = "type Tone = <\"brisk\" | \"warm\">\nfunction m(cfg: <{ mode: Tonee, go: <(n: <number>) => <text>> }>, fs: <() => <text>>[], xs: <txt[]>, h: <(n: <nmbr>) => <text>>) {\n  pick = (k: <{ a: nmber }>) => { return 1 }\n  return 1\n}\n";
    assert_eq!(
        check(source, 5),
        [
            "MOV_UNKNOWN_TYPE_NAME 2:26-2:31 'Tonee' is not a value type — a list or record type holds values: a primitive (text, number, boolean, date, datetime, file, json), a type you declare (`type Tonee = <\"A\" | \"B\">`), or a list or record of them — did you mean 'Tone'?",
            "MOV_CLOSURE_NOT_DATA 2:33-2:62 the key 'go' is typed as a closure, and a closure is not data — keep it in a variable ('g = …', called as 'g()') or pass it as an argument ('all(f, g)', 'MAP(xs, (x) => …)')",
            "MOV_CLOSURE_NOT_DATA 2:71-2:87 a list's element is typed as a closure, and a closure is not data — keep it in a variable ('g = …', called as 'g()') or pass it as an argument ('all(f, g)', 'MAP(xs, (x) => …)')",
            "MOV_UNKNOWN_TYPE_NAME 2:94-2:97 'txt' is not a value type — a list or record type holds values: a primitive (text, number, boolean, date, datetime, file, json), a type you declare (`type txt = <\"A\" | \"B\">`), or a list or record of them — did you mean 'text'?",
            "MOV_NAME_UNRESOLVED 2:110-2:116 Unknown name 'nmbr' — every name must be imported, bound by '=', a movement parameter, or a traversal alias in scope",
            "MOV_UNKNOWN_TYPE_NAME 3:20-3:25 'nmber' is not a value type — a list or record type holds values: a primitive (text, number, boolean, date, datetime, file, json), a type you declare (`type nmber = <\"A\" | \"B\">`), or a list or record of them — did you mean 'number'?",
        ]
    );
}
