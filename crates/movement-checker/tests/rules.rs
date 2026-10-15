//! Rules the parity corpus never exercises (most are language version 4 and
//! 5 rules, which the corpus has not been re-harvested under yet). Each
//! expectation is the TypeScript checker's own answer on the same program,
//! read off it on 2026-10-15: every diagnostic, in order, with its span.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

fn check(source: &str, version: u32) -> Vec<String> {
    check_with(source, version, r#"{"adapters":{},"credentials":{},"plugins":{}}"#)
}

/// A system `box` with no credential: a `Doc` collection (`docs`) whose
/// records carry a name and a file, both writable.
const BOX: &str = r#"{"adapters":{"box":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{"Doc":{"properties":{"name":"text","attachment":"file"},"edges":{}}},"collections":{"docs":{"target":"Doc"}},"writableRoots":{"Doc":{"fields":{"name":"text","attachment":"file"},"requiredFields":[],"resultShape":{"externalId":"text"}}}}}}},"credentials":{},"plugins":{}}"#;

fn check_with(source: &str, version: u32, snapshot: &str) -> Vec<String> {
    check_upgrading(source, version, None, snapshot)
}

fn check_upgrading(source: &str, version: u32, upgrading_from: Option<u32>, snapshot: &str) -> Vec<String> {
    let catalog = CatalogSnapshot::load(snapshot).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from, parse_version: None, zones: &movement_checker::host::native::NativeZones };
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

#[test]
fn a_file_the_write_did_not_send_is_not_read_off_its_handle_from_version_5() {
    let source = "import { box } from adapters\nb = box()\nmovement m(f: <file>) {\n  h = write b-[:docs]-> { name: \"x\" }\n  a = h.attachment\n  k = write b-[:docs]-> { name: \"y\", attachment: f }\n  c = k.attachment\n  return a\n}\n";
    assert_eq!(
        check_with(source, 5, BOX),
        [
            "MOV_HANDLE_FILE_NOT_SENT 5:7-5:19 'attachment' is a file this write did not send, so the write's handle holds the system's description of it, not the file — read the record back through its edge to get the file, as a walk read does (`h-[:Files]->`), or send the file in this write",
        ]
    );
    assert!(check_with(source, 4, BOX).is_empty());
}

#[test]
fn a_field_the_write_did_not_set_reads_the_found_record_when_moving_up_across_4() {
    let source = "import { box } from adapters\nb = box()\nmovement m(f: <file>) {\n  h = write b-[:docs]-> { name: \"x\" }\n  a = h.attachment\n  n = h.name\n  e = h.externalId\n  return n\n}\n";
    assert_eq!(
        check_upgrading(source, 4, Some(3), BOX),
        [
            "MOV_HANDLE_READ_FOUND 5:7-5:19 since \"Luminous Owl\" (4) 'attachment' on 'h' reads the record as the write found it; before, it read what the system handed back from the write (often nothing). If the program assumed the old reading, change it, then upgrade. (see handbook: writes#what-the-write-did)",
        ]
    );
    assert!(check_with(source, 4, BOX).is_empty());
}

#[test]
fn a_record_is_not_looked_up_by_a_key() {
    let source = "import { box } from adapters\nb = box()\nmovement m(f: <file>, n: <text>) {\n  h = write b-[:docs]-> { name: \"x\" }\n  a = AT(h, \"name\")\n  c = AT(h, 0)\n  d = AT(IF n == \"x\" THEN h ELSE { name: \"y\" } END, \"name\")\n  e = AT(COALESCE(h, h), k)\n  g = AT(f, \"x\")\n  return n\n}\n";
    assert_eq!(
        check_with(source, 5, BOX),
        [
            "MOV_AT_RECORD_KEY 5:7-5:20 AT looks up a list's slot or a map's key, and this is a record — 'name' is not a key it holds. Read a field with a dot (h.name), or build a map of the fields you need ({ name: h.`Name`, … }) and look the key up in that",
            "MOV_AT_RECORD_KEY 7:7-7:60 AT looks up a list's slot or a map's key, and this may be a record — 'name' is not a key it holds. Read a field with a dot (r.name), or build a map of the fields you need ({ name: r.`Name`, … }) and look the key up in that",
            "MOV_NAME_UNRESOLVED 8:7-8:28 Unknown name 'k' — every name must be imported, bound by '=', a movement parameter, or a traversal alias in scope",
            "MOV_AT_RECORD_KEY 8:7-8:28 AT looks up a list's slot or a map's key, and this may be a record — its fields are not keys to look up. Read a field with a dot (r.`Name`), or build a map of the fields you need ({ name: r.`Name`, … }) and look the key up in that",
        ]
    );
}

#[test]
fn a_graph_holds_no_record_as_a_field_value() {
    let source = "import { box } from adapters\nb = box()\nmovement m(f: <file>, n: <text>) {\n  h = write b-[:docs]-> { name: \"x\" }\n  v = { who: h, tag: \"t\" }\n  w = { all: [h, h], k: \"x\" }\n  pair = [h, \"x\"]\n  g1 = graph { ...v }\n  g2 = graph { ...w }\n  g3 = graph { a: COALESCE(h, \"x\"), b: IF n == \"x\" THEN h ELSE \"y\" END, c: f, d: { inner: h }, e: pair, k: b }\n  return n\n}\n";
    assert_eq!(
        check_with(source, 5, BOX),
        [
            "MOV_GRAPH_SPREAD_RECORD 8:16-8:20 '...v' copies a map's values and maps into the graph, and 'v.who' is a b.Doc handle — a record, not a value. Write a field off it ('who: r.`Name`'), or write the record into the graph as an entry of its own ('who: r')",
            "MOV_GRAPH_SPREAD_RECORD 9:16-9:20 '...w' copies a map's values and maps into the graph, and 'w.all[0]' is a b.Doc handle — a record, not a value. Write a field off it ('all: [r.`Name`, …]'), or write the record into the graph as an entry of its own ('all: [r, …]')",
            "MOV_GRAPH_ENTRY_RECORD 10:16-10:35 'a' is a field, and 'COALESCE(h, \"x\")' may be a b.Doc handle — a record, not a value a field holds. Write a field off the record ('a: r.`Name`'), or make the entry the record alone ('a: r'), which holds it as a reference",
            "MOV_GRAPH_ENTRY_RECORD 10:37-10:71 'b' is a field, and 'IF n == \"x\" THEN h ELSE \"y\" END' may be a b.Doc handle — a record, not a value a field holds. Write a field off the record ('b: r.`Name`'), or make the entry the record alone ('b: r'), which holds it as a reference",
            "MOV_LIST_MIXED 10:99-10:103 a list holds one kind of thing, and this one holds both: a b.Doc handle is a record, and another member is text. A tuple may hold both — read one slot with 'AT(t, 0)' — but read as a list it may not. Build a list of records and walk it ('both = [one, two]' … 'both-[c:company]-> { … }'), or read the records' fields first and build a list of the values.",
            "MOV_GRAPH_ENTRY_RECORD 10:105-10:109 'k' is a field, and 'b' is 'b' (the instance itself) — a connection, not a value a field holds. Write a record read through it, or the fields you want ('k: r.`Name`')",
        ]
    );
    // An instance is no record bound on the node plane: a node literal's
    // entry naming one says nothing (the TypeScript's answer).
    let entry = "import { box } from adapters\nb = box()\nmovement m(n: <text>) {\n  x = node { k: b, j: n }\n  return n\n}\n";
    assert!(check_with(entry, 5, BOX).is_empty());
}

/// Every case in `rules.fixtures.json`: a program checked under its version
/// against the catalog snapshot it names, and the TypeScript's answer.
#[test]
fn the_fixture_programs_get_the_typescripts_answers() {
    // Raw, so each snapshot keeps the key order the TypeScript read (a
    // `Value` round trip would sort every object's keys).
    #[derive(serde::Deserialize)]
    struct Fixtures<'a> {
        #[serde(borrow)]
        snapshots: std::collections::HashMap<String, &'a serde_json::value::RawValue>,
        cases: Vec<serde_json::Value>,
    }
    let fixtures: Fixtures = serde_json::from_str(include_str!("rules.fixtures.json")).unwrap();
    let mut failures = Vec::new();
    for case in &fixtures.cases {
        let snapshot = fixtures.snapshots[case["snapshot"].as_str().unwrap()].get();
        let version = case["version"].as_u64().unwrap() as u32;
        let upgrading_from = case["upgradingFrom"].as_u64().map(|v| v as u32);
        let found = check_upgrading(case["source"].as_str().unwrap(), version, upgrading_from, snapshot);
        let expected: Vec<String> = case["expected"].as_array().unwrap().iter().map(|d| d.as_str().unwrap().to_string()).collect();
        if found != expected {
            failures.push(format!("{} (v{version}{}):\n  expected {expected:#?}\n  found {found:#?}", case["name"], upgrading_from.map_or(String::new(), |f| format!(" from {f}"))));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
