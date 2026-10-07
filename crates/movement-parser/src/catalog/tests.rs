//! The catalog's behaviour, ported from the TypeScript's tests
//! (service/__test__/snapshot_positions, checker/__test__/json_type and
//! value_unions), plus the JavaScript semantics it reproduces. The
//! corpus-wide proof is checker/__test__/catalog_differential.

use serde_json::{Value, json};

use super::helpers::*;
use super::query::query_json;
use super::snapshot::{Args, instance_schema_key};
use super::types::{CatalogSnapshot, FieldType, InstanceSchema};

fn ty(v: Value) -> FieldType {
    serde_json::from_value(v).unwrap()
}

fn args(pairs: &[(&str, &str)]) -> Args {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn schema_with(collection: &str) -> Value {
    json!({ "positions": { "Row": { "properties": {}, "edges": {} } }, "collections": { collection: { "target": "Row" } }, "writableRoots": {} })
}

fn spec() -> Value {
    json!([
        { "name": "credentials", "kind": "credential", "required": true },
        { "name": "spreadsheet", "kind": "position", "required": false, "optionsFromType": "Spreadsheet" },
    ])
}

fn sheets(schemas: Value) -> CatalogSnapshot {
    let snapshot = json!({
        "adapters": { "google_sheets": { "constructionArgs": spec(), "schemas": schemas } },
        "credentials": { "Sheets Probe": { "adapters": ["google_sheets"] } },
        "plugins": {},
    });
    CatalogSnapshot::load(&snapshot.to_string()).unwrap()
}

fn position_key(pairs: &[(&str, &str)]) -> String {
    super::helpers::position_key(&serde_json::from_value::<Vec<_>>(spec()).unwrap(), Some(&args(pairs)))
}

fn collections(schema: Option<&InstanceSchema>) -> Vec<&str> {
    schema.map(|s| s.collections.keys().map(String::as_str).collect()).unwrap_or_default()
}

// ── service/__test__/snapshot_positions ──

#[test]
fn a_construction_pinning_no_position_has_the_empty_key() {
    assert_eq!(position_key(&[("credentials", "Sheets Probe")]), "");
}

#[test]
fn the_key_ignores_the_credential_and_undeclared_args() {
    assert_eq!(
        position_key(&[("credentials", "A"), ("spreadsheet", "\"S\"")]),
        position_key(&[("credentials", "B"), ("spreadsheet", "\"S\""), ("unknown", "x")]),
    );
}

#[test]
fn the_key_is_the_unquoted_value() {
    assert_eq!(position_key(&[("spreadsheet", "\"LP Commitments\"")]), position_key(&[("spreadsheet", "LP Commitments")]));
    assert_eq!(position_key(&[("spreadsheet", "\"LP Commitments\"")]), r#"[["spreadsheet","LP Commitments"]]"#);
}

#[test]
fn the_key_is_order_independent_and_sorted_as_locale_compare_sorts() {
    let spec = serde_json::from_value::<Vec<_>>(json!([
        { "name": "table", "kind": "position", "required": false },
        { "name": "Base", "kind": "position", "required": false },
        { "name": "base", "kind": "position", "required": false },
    ]))
    .unwrap();
    let key = |pairs: &[(&str, &str)]| super::helpers::position_key(&spec, Some(&args(pairs)));
    // The TypeScript's answer for the same call (2026-10-07); a blank value
    // pins nothing, and the escapes come out of the unquoted value.
    assert_eq!(
        key(&[("table", r#" "t \"q\" \\ " "#), ("Base", "B"), ("base", "  ")]),
        r#"[["Base","B"],["table","t \"q\" \\ "]]"#
    );
    assert_eq!(key(&[("table", "\"b\""), ("base", "\"a\"")]), key(&[("base", "\"a\""), ("table", "\"b\"")]));
}

#[test]
fn the_schema_key_is_the_bare_credential_until_a_position_is_pinned() {
    assert_eq!(instance_schema_key(Some("Sheets Probe"), Some("")), "Sheets Probe");
    assert_eq!(instance_schema_key(None, Some("")), "");
    assert_eq!(instance_schema_key(None, Some("[]")), "::[]");
    let a = instance_schema_key(Some("Sheets Probe"), Some(&position_key(&[("spreadsheet", "\"LP Commitments\"")])));
    let b = instance_schema_key(Some("Sheets Probe"), Some(&position_key(&[("spreadsheet", "\"Board Pack\"")])));
    assert_ne!(a, b);
}

/// Review Focus 2: both the positioned key and its unpositioned fallback
/// exist; the positioned one is the answer.
#[test]
fn a_pinned_position_resolves_its_own_schema_over_the_fallback() {
    let positioned = instance_schema_key(Some("Sheets Probe"), Some(&position_key(&[("spreadsheet", "\"LP Commitments\"")])));
    let snapshot = sheets(json!({ "Sheets Probe": schema_with("Spreadsheet"), positioned: schema_with("LPs (table)") }));
    let pinned = args(&[("credentials", "Sheets Probe"), ("spreadsheet", "\"LP Commitments\"")]);
    assert_eq!(collections(snapshot.instantiate("google_sheets", &pinned)), ["LPs (table)"]);
    assert_eq!(collections(snapshot.instantiate("google_sheets", &args(&[("credentials", "Sheets Probe")]))), ["Spreadsheet"]);
}

#[test]
fn an_undescribed_position_falls_back_to_the_meta_position() {
    let snapshot = sheets(json!({ "Sheets Probe": schema_with("Spreadsheet") }));
    let pinned = args(&[("credentials", "Sheets Probe"), ("spreadsheet", "\"Never Described\"")]);
    assert_eq!(collections(snapshot.instantiate("google_sheets", &pinned)), ["Spreadsheet"]);
}

#[test]
fn an_unresolvable_credential_is_untyped_position_or_not() {
    let snapshot = sheets(json!({ "Sheets Probe": schema_with("Spreadsheet") }));
    let other = args(&[("credentials", "Other Probe"), ("spreadsheet", "\"LP Commitments\"")]);
    assert!(snapshot.instantiate("google_sheets", &other).is_none());
    assert!(snapshot.instantiate("google_sheets", &args(&[])).is_none());
    assert!(snapshot.instantiate("nope", &args(&[])).is_none());
    // A backtick-quoted credential name is the name.
    let quoted = args(&[("credentials", " `Sheets Probe` ")]);
    assert_eq!(collections(snapshot.instantiate("google_sheets", &quoted)), ["Spreadsheet"]);
}

#[test]
fn an_adapter_without_a_credential_reads_its_credential_free_schema() {
    let snapshot = json!({
        "adapters": { "email": { "constructionArgs": [], "canFire": true, "schemas": { "": schema_with("messages") } } },
        "credentials": {}, "plugins": {},
    });
    let snapshot = CatalogSnapshot::load(&snapshot.to_string()).unwrap();
    assert_eq!(collections(snapshot.instantiate("email", &args(&[]))), ["messages"]);
    // `adapter(name)` is the entry minus the snapshot's own members.
    assert_eq!(serde_json::to_value(snapshot.adapter("email")).unwrap(), json!({ "constructionArgs": [], "canFire": true }));
}

#[test]
fn position_arg_options_are_published_and_absent_ones_unchecked() {
    let snapshot = json!({
        "adapters": { "google_sheets": {
            "constructionArgs": spec(), "schemas": {},
            "constructionArgOptions": { "Sheets Probe": { "spreadsheet": ["LP Commitments", "Board Pack"] } },
        } },
        "credentials": { "Sheets Probe": { "adapter": "google_sheets" } }, "plugins": {},
    });
    let snapshot = CatalogSnapshot::load(&snapshot.to_string()).unwrap();
    let options = snapshot.construction_arg_options("google_sheets", Some("Sheets Probe"), "spreadsheet");
    assert_eq!(options, Some(&["LP Commitments".to_string(), "Board Pack".to_string()][..]));
    assert_eq!(snapshot.construction_arg_options("google_sheets", None, "spreadsheet"), None);
    // The legacy single-adapter credential reads as the multi-adapter form.
    assert_eq!(snapshot.credential("Sheets Probe").unwrap().adapters, ["google_sheets"]);
}

// ── Loading ──

#[test]
fn a_member_the_typescript_does_not_declare_is_refused() {
    let snapshot = json!({ "adapters": {}, "credentials": {}, "plugins": {}, "extra": 1 });
    assert!(CatalogSnapshot::load(&snapshot.to_string()).unwrap_err().contains("extra"));
    let schema = json!({ "positions": { "Row": { "properties": {}, "edges": {}, "colour": "red" } }, "collections": {}, "writableRoots": {} });
    assert!(sheets_result(json!({ "": schema })).unwrap_err().contains("colour"));
}

#[test]
fn a_schema_field_typed_as_only_the_checker_types_is_refused() {
    let schema = json!({ "positions": { "Row": { "properties": { "r": { "kind": "record" } }, "edges": {} } }, "collections": {}, "writableRoots": {} });
    assert!(sheets_result(json!({ "": schema })).unwrap_err().contains("Row.r"));
}

fn sheets_result(schemas: Value) -> Result<CatalogSnapshot, String> {
    let snapshot = json!({ "adapters": { "a": { "constructionArgs": [], "schemas": schemas } }, "credentials": {}, "plugins": {} });
    CatalogSnapshot::load(&snapshot.to_string())
}

/// Schema field order is observable, and is a JavaScript object's: array
/// index keys first, ascending, then the rest as written.
#[test]
fn data_keys_keep_javascript_s_order() {
    let text = r#"{"positions":{"Row":{"properties":{"z":"text","10":"number","a":"date","2":"file"},"edges":{}}},"collections":{},"writableRoots":{}}"#;
    let schema: InstanceSchema = serde_json::from_str(text).unwrap();
    let keys: Vec<&str> = schema.positions["Row"].properties.keys().map(String::as_str).collect();
    assert_eq!(keys, ["2", "10", "z", "a"]);
    let written = serde_json::to_string(&schema.positions["Row"].properties).unwrap();
    assert_eq!(written, r#"{"2":"file","10":"number","z":"text","a":"date"}"#);
}

// ── checker/__test__/json_type, value_unions ──

#[test]
fn json_is_a_surface_type_name_that_describes_as_itself() {
    assert_eq!(parse_field_type_name(Some("json")), Some(ty(json!("json"))));
    assert_eq!(parse_field_type_name(Some("absent")), None);
    assert_eq!(parse_field_type_name(None), None);
    assert_eq!(describe_field_type(&ty(json!("json"))).unwrap(), "json");
    assert_eq!(describe_field_type(&ty(json!({ "kind": "list", "of": "json" }))).unwrap(), "list of json");
}

#[test]
fn a_union_inside_another_type_is_parenthesised() {
    let text_or_number = json!({ "kind": "union", "of": ["number", "text"] });
    assert_eq!(describe_field_type(&ty(text_or_number.clone())).unwrap(), "number | text");
    assert_eq!(describe_field_type(&ty(json!({ "kind": "list", "of": text_or_number }))).unwrap(), "list of (number | text)");
    assert_eq!(
        describe_field_type(&ty(json!({ "kind": "maybeAbsent", "of": text_or_number }))).unwrap(),
        "(number | text) (or absent)"
    );
}

#[test]
fn every_type_describes_as_the_typescript_describes_it() {
    // The TypeScript's answers for the same types (2026-10-07).
    let cases = [
        (json!("absent"), "null"),
        (json!({ "kind": "tuple", "of": ["text", null, { "kind": "list", "of": "number" }], "rest": { "at": 1, "of": { "kind": "union", "of": ["text", "number"] } } }), "[text, ...list of (text | number), ?, list of number]"),
        (json!({ "kind": "tuple", "of": ["text"], "rest": { "at": -5, "of": null } }), "[...list of ?, text]"),
        (json!({ "kind": "dict", "of": "json", "shape": {} }), "{  }"),
        (json!({ "kind": "dict", "of": "text" }), "dict of text"),
        (json!({ "kind": "enum", "options": [] }), "enum (no available values)"),
        (json!({ "kind": "enum", "options": ["Seed", "Series A"] }), "enum (Seed | Series A)"),
        (json!({ "kind": "record" }), "a record"),
    ];
    for (type_, described) in cases {
        assert_eq!(describe_field_type(&ty(type_.clone())).unwrap(), described, "{type_}");
    }
    // Written as text: `json!` would sort the shape's keys.
    let shaped = r#"{"kind":"dict","of":"json","shape":{"b":"text","2":null,"a":{"kind":"enum","options":["x","y"],"open":{}}}}"#;
    let shaped: FieldType = serde_json::from_str(shaped).unwrap();
    assert_eq!(describe_field_type(&shaped).unwrap(), "{ 2: ?, b: text, a: known values (x | y, …) }");
    assert!(describe_field_type(&ty(json!({ "kind": "record", "position": { "kind": "meta" } }))).is_err());
}

#[test]
fn a_variant_gives_a_bare_name_its_kind() {
    let variant = |t: Value| serde_json::to_value(variant_of(&ty(t))).unwrap();
    assert_eq!(variant(json!("text")), json!({ "kind": "text" }));
    let list = json!({ "kind": "list", "of": "text", "unordered": true });
    assert_eq!(variant(list.clone()), list);
}

// ── The other helpers ──

#[test]
fn a_refinement_key_sorts_the_filter_s_keys_by_utf16_units() {
    let filter: Value = serde_json::from_str("{\"b\":1,\"a\":[true,null,\"x\\n\\u0001\"],\"n\":1e21,\"🌍\":2,\"\u{ff61}\":3,\"m\":0.1}").unwrap();
    // The TypeScript's answer (2026-10-07): `🌍` (U+D83C…) before `｡` (U+FF61).
    assert_eq!(
        refinement_key("T", &filter),
        r#"["T","{\"a\":[true,null,\"x\\n\\u0001\"],\"b\":1,\"m\":0.1,\"n\":1e+21,\"🌍\":2,\"｡\":3}"]"#
    );
}

/// Review Focus 4: `unionVariants` sorts as `<` does, by UTF-16 units — an
/// astral member before one in U+E000–U+FFFF, where code-point order puts it
/// after.
#[test]
fn union_variants_sort_by_utf16_units() {
    let members: Vec<String> = ["b", "🌍", "\u{ff61}", "a", "b", "Z"].map(String::from).to_vec();
    assert_eq!(union_variants(&members), ["Z", "a", "b", "🌍", "\u{ff61}"]);
    assert_eq!(union_key(&["b".into(), "a".into()]), r#"["union",["a","b"]]"#);
    assert_eq!(union_display(&members), "Z | a | b | 🌍 | \u{ff61}");
}

#[test]
fn a_borrowed_type_is_a_dotted_path() {
    assert_eq!(borrowed_type_segments(Some("crm.companies.stage")), Some(vec!["crm".into(), "companies".into(), "stage".into()]));
    assert_eq!(borrowed_type_segments(Some("text")), None);
    assert_eq!(borrowed_type_segments(None), None);
}

#[test]
fn a_borrowed_field_prefers_the_write_surface() {
    let schema: InstanceSchema = serde_json::from_value(json!({
        "positions": { "companies": { "properties": { "stage": "text", "name": "text" }, "edges": {} } },
        "collections": {},
        "writableRoots": { "companies": { "fields": { "stage": { "kind": "enum", "options": ["Seed"] } }, "resultShape": {} } },
    }))
    .unwrap();
    assert_eq!(resolve_borrowed_field(&schema, "companies", "stage"), Some(&ty(json!({ "kind": "enum", "options": ["Seed"] }))));
    assert_eq!(resolve_borrowed_field(&schema, "companies", "name"), Some(&ty(json!("text"))));
    assert_eq!(resolve_borrowed_field(&schema, "companies", "nope"), None);
    assert_eq!(resolve_borrowed_field(&schema, "people", "name"), None);
}

#[test]
fn declared_types_keep_a_map_s_order() {
    let program = json!({ "statements": [
        { "kind": "type", "name": "B", "options": ["x"] },
        { "kind": "assign" },
        { "kind": "type", "name": "A", "options": ["y"] },
        { "kind": "type", "name": "B", "options": ["z"] },
    ] });
    let declared = declared_types_in(&program).unwrap();
    assert_eq!(serde_json::to_string(&declared).unwrap(), r#"{"B":{"kind":"enum","options":["z"]},"A":{"kind":"enum","options":["y"]}}"#);
}

#[test]
fn a_credential_argument_names_one_name() {
    assert_eq!(unwrap_credential_arg(" at_cred "), Some("at_cred".into()));
    assert_eq!(unwrap_credential_arg("`My Cred`"), Some("My Cred".into()));
    assert_eq!(unwrap_credential_arg("`My Cred` x"), None);
    assert_eq!(unwrap_credential_arg("Sheets Probe"), None);
    assert_eq!(unwrap_credential_arg(""), None);
}

// ── The query ──

fn query(snapshot: &Value, q: Value) -> Result<Value, Value> {
    let parse = |b: Vec<u8>| serde_json::from_slice::<Value>(&b).unwrap();
    query_json(&snapshot.to_string(), &q.to_string()).map(parse).map_err(parse)
}

#[test]
fn a_query_answers_a_value_or_nothing() {
    let snapshot = json!({
        "adapters": { "email": { "constructionArgs": [], "schemas": { "": schema_with("messages") } } },
        "credentials": { "c": { "adapters": ["email"] } }, "plugins": { "p": { "args": ["x"], "priced": false } },
    });
    let schema = query(&snapshot, json!({ "op": "instantiate", "adapter": "email", "args": {} })).unwrap();
    assert_eq!(schema["value"]["collections"], json!({ "messages": { "target": "Row" } }));
    assert_eq!(query(&snapshot, json!({ "op": "instantiate", "adapter": "x", "args": {} })), Ok(json!({})));
    assert_eq!(query(&snapshot, json!({ "op": "credentialNames" })), Ok(json!({ "value": ["c"] })));
    assert_eq!(query(&snapshot, json!({ "op": "plugin", "name": "p" })), Ok(json!({ "value": { "args": ["x"], "priced": false } })));
    assert_eq!(query(&snapshot, json!({ "op": "models" })), Ok(json!({})));
    let helper = json!({ "op": "helper", "name": "unionVariants", "args": [["b", "a"]] });
    assert_eq!(query(&json!(null), helper), Ok(json!({ "value": ["a", "b"] })));
    let undefined_arg = json!({ "op": "helper", "name": "parseFieldTypeName", "args": [null] });
    assert_eq!(query(&json!(null), undefined_arg), Ok(json!({})));
    let refused = query(&json!({ "adapters": {} }), json!({ "op": "adapter", "name": "x" })).unwrap_err();
    assert!(refused["error"]["message"].as_str().unwrap().starts_with("the snapshot does not read"));
}

// ── Depth ──

/// A field type `n` levels of `list of` deep, as text.
fn nested_list(n: usize) -> String {
    format!("{}\"text\"{}", r#"{"kind":"list","of":"#.repeat(n), "}".repeat(n))
}

/// A snapshot whose one property is typed `nested_list(n)`; its JSON nests
/// eight levels above the type.
fn deep_snapshot(n: usize) -> String {
    format!(
        r#"{{"adapters":{{"a":{{"constructionArgs":[],"schemas":{{"":{{"positions":{{"p":{{"properties":{{"f":{}}},"edges":{{}}}}}},"collections":{{}},"writableRoots":{{}}}}}}}}}},"credentials":{{}},"plugins":{{}}}}"#,
        nested_list(n)
    )
}

#[test]
fn catalog_json_is_bounded_well_inside_the_stack() {
    use super::types::MAX_CATALOG_DEPTH;
    let limit = MAX_CATALOG_DEPTH - 8;
    assert!(CatalogSnapshot::load(&deep_snapshot(limit)).is_ok());
    assert_eq!(
        CatalogSnapshot::load(&deep_snapshot(limit + 1)).unwrap_err(),
        format!("it nests deeper than {MAX_CATALOG_DEPTH} levels")
    );
    let describe = |n: usize| {
        let q = format!(r#"{{"op":"helper","name":"describeFieldType","args":[{}]}}"#, nested_list(n));
        query_json("", &q).map(|b| String::from_utf8(b).unwrap()).map_err(|b| String::from_utf8(b).unwrap())
    };
    assert!(describe(MAX_CATALOG_DEPTH).is_ok());
    assert_eq!(
        describe(MAX_CATALOG_DEPTH + 1).unwrap_err(),
        format!(r#"{{"error":{{"message":"the type does not read: it nests deeper than {MAX_CATALOG_DEPTH} levels"}}}}"#)
    );
    // A refinement's filter is a lowered expression, held to the deeper bound.
    let filter = format!("{}1{}", "[".repeat(1_000), "]".repeat(1_000));
    let q = format!(r#"{{"op":"helper","name":"refinementKey","args":[{{"type":"T","filter":{filter}}}]}}"#);
    assert!(query_json("", &q).is_ok());
}

#[test]
fn either_credential_form_refuses_a_member_it_does_not_declare() {
    for credential in [json!({ "adapters": ["a"], "extra": 1 }), json!({ "adapter": "a", "extra": 1 })] {
        let snapshot = json!({ "adapters": {}, "credentials": { "c": credential }, "plugins": {} });
        assert!(CatalogSnapshot::load(&snapshot.to_string()).is_err(), "{credential}");
    }
}
