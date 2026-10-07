//! One test per lowering rule and per refusal (lower.ts and
//! expression/call_shape.ts). The corpus-wide proof is the differential the
//! TypeScript ran before it was deleted, and the pinned fixture
//! (parser/expression/__test__/lowering_regression) that now runs through this.

use serde_json::{Value, json};

use super::*;

fn tree(text: &str) -> MExpr {
    crate::expr::parse_expression(text).unwrap_or_else(|e| panic!("{text}: {e:?}"))
}

/// The lowered value's JSON, as the ABI writes it (the TypeScript's key order).
fn exact(text: &str) -> String {
    let e = lower_expression(&tree(text), text).unwrap_or_else(|r| panic!("{text}: {r:?}"));
    serde_json::to_string(&e).unwrap()
}

fn value(text: &str) -> Value {
    serde_json::from_str(&exact(text)).unwrap()
}

fn condition(text: &str) -> Value {
    let c = lower_condition(&tree(text), text).unwrap_or_else(|r| panic!("{text}: {r:?}"));
    serde_json::to_value(&c).unwrap()
}

fn refusal(text: &str) -> LoweringRefusal {
    match lower_expression(&tree(text), text) {
        Err(r) => r,
        Ok(e) => panic!("{text} lowered to {}", serde_json::to_string(&e).unwrap()),
    }
}

fn refused(text: &str) -> String {
    let r = refusal(text);
    assert_eq!((r.code.as_deref(), r.class), (None, RefusalClass::Lowering), "{text}");
    r.message
}

fn shape_refused(text: &str) -> String {
    let r = refusal(text);
    assert_eq!(r.class, RefusalClass::CallShape, "{text}");
    r.message
}

fn condition_refused(text: &str) -> String {
    lower_condition(&tree(text), text).unwrap_err().message
}

fn prop(name: &str) -> Value {
    json!({ "type": "property", "propertyTypeId": name })
}

fn stat(v: Value) -> Value {
    json!({ "type": "static", "value": v })
}

fn edge(label: &str) -> Value {
    json!({ "type": "edge", "edgeTypeId": label, "direction": "outgoing" })
}

const SENTINEL: &str = POSITION_SENTINEL;

// ── Values ──

#[test]
fn literals_are_static() {
    assert_eq!(value("1.5"), stat(json!(1.5)));
    assert_eq!(value("true"), stat(json!(true)));
    assert_eq!(value("null"), stat(json!(null)));
    // Past 2^53 a number is written as a float; JSON.parse reads the same number.
    assert_eq!(value("9007199254740993"), stat(json!(9007199254740992.0)));
}

#[test]
fn a_string_is_static_and_an_interpolating_one_a_concat_of_its_nonempty_parts() {
    assert_eq!(value("'a'"), stat(json!("a")));
    assert_eq!(value("\"\""), stat(json!("")));
    assert_eq!(value("\"${a}\""), json!({ "type": "concat", "parts": [prop("a")] }));
    assert_eq!(value("\"x ${a} y\""), json!({ "type": "concat", "parts": [stat(json!("x ")), prop("a"), stat(json!(" y"))] }));
}

#[test]
fn a_name_is_a_property_and_an_edge_property_inside_a_hop_where() {
    assert_eq!(value("a"), prop("a"));
    assert_eq!(
        value("x-[:e WHERE n == \"${m}\"]->.y")["steps"][0]["expressionFilter"],
        json!({ "type": "compare", "op": "eq", "left": { "type": "edge_property", "propertyTypeId": "n" },
                "right": { "type": "concat", "parts": [prop("m")] } })
    );
}

#[test]
fn a_special_reads_parent_resource_or_meta_unchecked() {
    assert_eq!(value("@parent.created"), json!({ "type": "parent_result", "field": "created" }));
    assert_eq!(value("@parent.bogus"), json!({ "type": "parent_result", "field": "bogus" }));
    assert_eq!(value("@resource.url"), json!({ "type": "resource", "field": "url" }));
    assert_eq!(value("@current_date"), json!({ "type": "meta", "key": "current_date" }));
}

#[test]
fn lists_and_maps_keep_their_spreads() {
    assert_eq!(
        value("[1, ...a]"),
        json!({ "type": "list", "elements": [stat(json!(1)), { "type": "spread", "expression": prop("a") }] })
    );
    assert_eq!(
        exact("{ \"k\": 1, ...b }"),
        r#"{"type":"object","entries":[{"key":"k","value":{"type":"static","value":1}},{"type":"spread","expression":{"type":"property","propertyTypeId":"b"}}]}"#
    );
}

#[test]
fn unary_binary_and_postfix_tests() {
    assert_eq!(value("NOT a"), json!({ "type": "not", "expression": prop("a") }));
    assert_eq!(value("-a"), json!({ "type": "negate", "expression": prop("a") }));
    assert_eq!(value("a % b"), json!({ "type": "arithmetic", "op": "%", "left": prop("a"), "right": prop("b") }));
    assert_eq!(value("a != b")["op"], "neq");
    assert_eq!(value("a IN b")["op"], "in");
    assert_eq!(value("a contains b")["op"], "contains");
    assert_eq!(value("a EXISTS"), json!({ "type": "compare", "op": "exists", "left": prop("a"), "right": stat(json!(true)) }));
}

#[test]
fn a_connective_folds_its_left_operand_parenthesised_or_not() {
    let flat = json!({ "type": "logical", "op": "and", "operands": [prop("a"), prop("b"), prop("c")] });
    assert_eq!(value("a AND b AND c"), flat);
    assert_eq!(value("(a AND b) AND c"), flat);
    assert_eq!(
        value("a AND (b AND c)"),
        json!({ "type": "logical", "op": "and", "operands": [prop("a"), { "type": "logical", "op": "and", "operands": [prop("b"), prop("c")] }] })
    );
}

#[test]
fn within_lowercases_the_unit_unless_quoted() {
    assert_eq!(value("x WITHIN 30D")["right"], stat(json!("30d")));
    assert_eq!(value("x WITHIN \"30D\"")["right"], stat(json!("30D")));
}

#[test]
fn an_if_without_else_is_empty_text() {
    assert_eq!(
        exact("IF a THEN b END"),
        r#"{"type":"conditional","condition":{"type":"property","propertyTypeId":"a"},"then":{"type":"property","propertyTypeId":"b"},"else":{"type":"static","value":""}}"#
    );
}

#[test]
fn what_is_not_a_value_is_refused() {
    assert_eq!(refused("x[0]"), "an index read `x[i]` is written AT(x, i)");
    assert_eq!(refused("EXISTS(x WHERE y) AND (x WHERE y)"), "WHERE filters a walk inside EXISTS(…) or a hop — it is not a value on its own");
    assert_eq!(refused("r IS <crm>"), "IS type tests are only recognised as top-level conjuncts of a condition");
    let closure = refusal("(x) => x");
    assert_eq!(closure.message, "a closure cannot be written here — bind it to a name first and pass the name");
    assert_eq!(closure.code.as_deref(), Some("MOV_EXPR_CLOSURE_POSITION"));
    assert_eq!(refused("<crm>"), "a type is not a value the shared expression tree can hold");
    assert_eq!(refused("node { a: 1 }"), "a node is not a value the shared expression tree can hold");
    assert_eq!(refused("graph { ...v }"), "a graph is not a value the shared expression tree can hold");
}

#[test]
fn extract_value_is_retired_unless_quoted() {
    let message = "EXTRACT_VALUE is retired (syntax amendment 4): extraction is a materialisation — declare the field in an `extract … { }` tree and read it as a plain property";
    assert_eq!(refused("EXTRACT_VALUE"), message);
    assert_eq!(refused("EXTRACT_VALUE(x)"), message);
    assert_eq!(value("`EXTRACT_VALUE`"), prop("EXTRACT_VALUE"));
}

// ── Chains ──

#[test]
fn a_dot_chain_is_right_nested_traverses() {
    assert_eq!(
        exact("a.b.c"),
        r#"{"type":"traverse","aliasRoot":"a","steps":[],"expression":{"type":"traverse","aliasRoot":"b","steps":[],"expression":{"type":"property","propertyTypeId":"c"}}}"#
    );
}

#[test]
fn edge_dot_reads_one_property_of_the_walked_edge() {
    assert_eq!(value("EDGE.x"), json!({ "type": "edge_property", "propertyTypeId": "x" }));
    assert_eq!(refused("edge.x.y"), "edge.<property> reads one property of the walked edge");
}

#[test]
fn only_a_name_heads_a_chain() {
    assert_eq!(refused("(a).b"), "'.', a call or a hop can only follow a name — not a paren");
    assert_eq!(refused("f(x).y"), "Unexpected '.' after the call f(…)");
}

#[test]
fn a_bare_walk_is_its_landings_and_a_walk_value_ends_outgoing() {
    assert_eq!(
        value("x-[:a]->"),
        json!({ "type": "traverse", "aliasRoot": "x", "steps": [edge("a")], "expression": prop(SENTINEL) })
    );
    assert_eq!(
        value("-[:a]->.b"),
        json!({ "type": "traverse", "steps": [edge("a")], "expression": prop("b") })
    );
    assert_eq!(refused("x<-[:a]-"), "a walk written as a value ends in ']->', or reads a '.property' after it");
}

#[test]
fn an_edge_step_carries_its_alias_cardinality_and_filter_in_order() {
    assert_eq!(
        exact("x-[a:e WHERE b ORDER BY k DESC LIMIT 2]->.y"),
        r#"{"type":"traverse","aliasRoot":"x","steps":[{"type":"edge","edgeTypeId":"e","direction":"outgoing","alias":"a","cardinality":{"mode":"n","limit":2,"orderBy":{"type":"property","propertyTypeId":"k"},"orderDirection":"desc"},"expressionFilter":{"type":"edge_property","propertyTypeId":"b"}}],"expression":{"type":"property","propertyTypeId":"y"}}"#
    );
    assert_eq!(value("x-[:e ORDER BY k]->.y")["steps"][0]["cardinality"], json!({ "mode": "all", "orderBy": prop("k"), "orderDirection": "asc" }));
    assert_eq!(value("x<-[:e]-.y")["steps"][0]["direction"], "incoming");
    assert_eq!(refused("x<-[a:e]-.y"), "an incoming hop takes no alias (`<-[:edge]-`)");
}

#[test]
fn the_extract_meta_edge_is_retired() {
    assert_eq!(
        refused("x-[:#extract]->.b"),
        "The #extract meta-edge is retired (syntax amendment 4): extraction is not a traversal — use an `extract … { }` materialisation and traverse its result graph"
    );
}

#[test]
fn a_transform_hop_keeps_its_settings_in_the_order_written() {
    assert_eq!(
        exact("x-[t:#transform { z: 1, plugin: p, description: d, a: 2, description: e, z: 3, __proto__: 4 }]->.o"),
        concat!(
            r#"{"type":"traverse","aliasRoot":"x","steps":[{"type":"meta_edge","metaEdge":"transform","alias":"t","config":"#,
            r#"{"extra":{"z":{"type":"static","value":3},"a":{"type":"static","value":2}},"#,
            r#""plugin":{"type":"property","propertyTypeId":"p"},"description":{"type":"property","propertyTypeId":"e"}}}],"#,
            r#""expression":{"type":"property","propertyTypeId":"o"}}"#
        )
    );
    assert_eq!(value("x-[#transform {}]->.o")["steps"][0], json!({ "type": "meta_edge", "metaEdge": "transform" }));
    assert_eq!(
        value("x-[#transform { enrich_with: [{ transform: a, argument: b }], data: [c] }]->.o")["steps"][0]["config"],
        json!({ "enrichWith": [{ "transform": prop("a"), "argument": prop("b") }], "data": [prop("c")] })
    );
}

#[test]
fn a_transform_hop_s_settings_are_refused_when_malformed() {
    assert_eq!(refused("x-[#transform { ...a }]->.o"), "A hop's settings are written out one by one — a spread ('...') is not accepted here");
    assert_eq!(refused("x-[#transform { enrich_with: 1 }]->.o"), "enrich_with: expects a list literal");
    assert_eq!(refused("x-[#transform { enrich_with: [1] }]->.o"), "enrich_with: each entry must be an object literal");
    let exactly = "enrich_with entry: requires exactly \"transform\" and \"argument\"";
    assert_eq!(refused("x-[#transform { enrich_with: [{ transform: a }] }]->.o"), exactly);
    assert_eq!(refused("x-[#transform { enrich_with: [{ transform: a, argument: b, c: 1 }] }]->.o"), exactly);
    assert_eq!(refused("x-[#transform { data: 1 }]->.o"), "data: expects a list literal [expr, expr, ...]");
    assert_eq!(refused("x-[#transform { data: [a, ...b] }]->.o"), "data: lists its values one by one — a spread ('...') is not accepted here");
}

#[test]
fn a_resource_walk_drops_its_root_and_reads_resource_fields() {
    assert_eq!(
        exact("x-[:_resources:TEXT WHERE name == \"a\"]->.content"),
        r#"{"type":"resource_traverse","expressionFilter":{"type":"logical","op":"and","operands":[{"type":"compare","op":"eq","left":{"type":"resource","field":"type"},"right":{"type":"static","value":"TEXT"}},{"type":"compare","op":"eq","left":{"type":"resource","field":"name"},"right":{"type":"static","value":"a"}}]},"expression":{"type":"resource","field":"content"}}"#
    );
    assert_eq!(value("x-[:#resources: email ]->.url")["expressionFilter"]["right"], stat(json!("EMAIL")));
    assert_eq!(value("x-[:_resources:bogus]->.url"), json!({ "type": "resource_traverse", "expression": { "type": "resource", "field": "url" } }));
    assert_eq!(value("x-[:_resources]->.Other"), json!({ "type": "resource_traverse", "expression": prop("Other") }));
    assert_eq!(
        value("x-[:a]->-[:_resources WHERE MimeType]->.url"),
        json!({ "type": "traverse", "steps": [edge("a")], "expression": {
            "type": "resource_traverse", "expressionFilter": { "type": "resource", "field": "contentType" },
            "expression": { "type": "resource", "field": "url" } } })
    );
}

#[test]
fn a_resource_walk_is_refused_when_it_reads_nothing_or_too_much() {
    assert_eq!(refused("x-[:_resources]->-[:a]->.b"), "a hop cannot follow -[:_resources]->");
    assert_eq!(refused("x-[:_resources]->"), "Expected '.' after the resource hop");
    assert_eq!(refused("x-[:_resources]->.name.x"), "Unexpected '.' after the resource field name");
}

#[test]
fn a_resource_where_reads_resource_fields_only() {
    assert_eq!(refused("x-[:_resources WHERE Foo]->.url"), "Unknown property: Foo");
    // The TypeScript finds Object.prototype's `constructor` here (reported).
    assert_eq!(refused("x-[:_resources WHERE constructor]->.url"), "Unknown property: constructor");
    assert_eq!(refused("x-[:_resources WHERE a + b]->.url"), "a _resources WHERE compares resource fields — 'arithmetic' is not supported here");
    assert_eq!(refused("x-[:_resources WHERE f(x)]->.url"), "a _resources WHERE compares resource fields — 'call' is not supported here");
    assert_eq!(
        value("x-[:_resources WHERE NOT [(name), ...url] EXISTS]->.url")["expressionFilter"],
        json!({ "type": "not", "expression": { "type": "compare", "op": "exists", "left": { "type": "list", "elements": [
            { "type": "resource", "field": "name" }, { "type": "spread", "expression": { "type": "resource", "field": "url" } }] },
            "right": stat(json!(true)) } })
    );
}

#[test]
fn a_linked_hop_reads_its_adapter_off_the_where_text() {
    let adapter = |text: &str| value(text)["adapter"].clone();
    assert_eq!(value("-[#linked WHERE type = \"attio\"]->.id"), json!({ "type": "linked_object", "adapter": "ATTIO", "field": "id" }));
    assert_eq!(adapter("-[#linked WHERE TYPE = 'hub']->.x"), "HUB");
    assert_eq!(adapter("-[#linked WHERE type=hub]->.x"), "HUB");
    assert_eq!(adapter("-[#linked WHERE type = \"\"]->.x"), "");
    // `type` inside `subtype` matches the word but not the `=` after it.
    assert_eq!(adapter("-[#linked WHERE subtype == \"q\" AND type = \"a\"]->.x"), "A");
    assert_eq!(adapter("-[#linked WHERE subtype = q]->.x"), "Q");
    assert_eq!(adapter("-[#linked]->.x"), "");
    // UTF-16 offsets: the WHERE is sliced after an astral character.
    assert_eq!(value("x-[:a]->-[#linked WHERE n == \"🌍\" AND type = \"é\"]->.x")["expression"]["adapter"], "É");
    assert_eq!(refused("-[#linked WHERE type = \"a\"]->.x.y"), "Expected field name after -[#linked...]->.");
    assert_eq!(refused("-[#linked WHERE type = \"a\"]->"), "Expected field name after -[#linked...]->.");
}

// ── Calls ──

#[test]
fn a_named_argument_is_a_movement_call_s() {
    assert_eq!(refused("f(a: 1)"), "a named argument (a: …) is a movement call's, not an expression's");
}

#[test]
fn aggregates_take_a_separator_and_a_bare_walk_s_property() {
    assert_eq!(value("join(x, \", \")"), json!({ "type": "aggregate", "fn": "join", "expression": prop("x"), "separator": ", " }));
    assert_eq!(value("COUNT()"), json!({ "type": "aggregate", "fn": "count", "expression": stat(json!("")) }));
    assert_eq!(value("LLM_AGG(x)")["fn"], "llm");
    assert_eq!(
        value("first(o-[:co]->).url"),
        json!({ "type": "aggregate", "fn": "first", "expression": { "type": "traverse", "aliasRoot": "o", "steps": [edge("co")], "expression": prop("url") } })
    );
    assert_eq!(refused("`FIRST`(o-[:co]->).url"), "Unexpected '.' after the call FIRST(…)");
    assert_eq!(refused("COUNT(o-[:co]->).url.x"), "Unexpected '.' after the call COUNT(…)");
}

#[test]
fn ai_is_an_llm_node() {
    assert_eq!(exact("AI(\"p\", \"quick\")"), r#"{"type":"llm","prompt":"p","tier":"quick"}"#);
    assert_eq!(exact("AI(p)"), r#"{"type":"llm","prompt":"","promptExpression":{"type":"property","propertyTypeId":"p"}}"#);
    assert_eq!(exact("AI()"), r#"{"type":"llm","prompt":""}"#);
    assert_eq!(refused("AI(a, b, c)"), "AI takes at most 2 arguments (prompt, tier), got 3");
    assert_eq!(refused("AI(\"p\", x)"), "AI's second argument is the tier — \"quick\", \"careful\", \"thorough\" — written down in place");
}

#[test]
fn concat_kg_and_at() {
    assert_eq!(value("CONCAT(a, 1)"), json!({ "type": "concat", "parts": [prop("a"), stat(json!(1))] }));
    assert_eq!(exact("KG_EXISTS(\"q\", a)"), r#"{"type":"kg_exists","query":"q","params":[{"type":"property","propertyTypeId":"a"}]}"#);
    assert_eq!(value("kg_value(q)"), json!({ "type": "kg_value", "query": "", "params": [] }));
    assert_eq!(value("AT(x, 1)"), json!({ "type": "at", "expression": prop("x"), "index": stat(json!(1)) }));
    assert_eq!(refused("AT(x)"), "AT takes exactly 2 arguments (AT(list, index)), got 1");
}

#[test]
fn sort_takes_a_key_and_a_trailing_direction() {
    assert_eq!(exact("SORT(x, k, Desc)"), r#"{"type":"aggregate","fn":"sort","expression":{"type":"property","propertyTypeId":"x"},"orderBy":{"type":"property","propertyTypeId":"k"},"orderDirection":"desc"}"#);
    assert_eq!(value("SORT(x, asc)"), json!({ "type": "aggregate", "fn": "sort", "expression": prop("x"), "orderDirection": "asc" }));
    assert_eq!(value("sort(x)")["orderDirection"], "asc");
    assert_eq!(refused("SORT()"), "SORT orders a collection");
    assert_eq!(refused("SORT(x, a, b)"), "SORT takes a collection, a key and a direction");
}

#[test]
fn any_other_call_is_a_function_by_its_lowercased_name() {
    assert_eq!(value("Coalesce(a)"), json!({ "type": "function", "fn": "coalesce", "args": [prop("a")] }));
    assert_eq!(value("`exists`(a)"), json!({ "type": "function", "fn": "exists", "args": [prop("a")] }));
}

#[test]
fn exists_is_the_quantifier_or_a_presence_test() {
    assert_eq!(
        value("EXISTS(x-[:a]-> WHERE b)"),
        json!({ "type": "traverse", "aliasRoot": "x", "steps": [], "expression": { "type": "exists", "steps": [edge("a")], "where": prop("b") } })
    );
    assert_eq!(value("exists(-[:a]->)"), json!({ "type": "exists", "steps": [edge("a")] }));
    assert_eq!(value("EXISTS(x)"), json!({ "type": "traverse", "aliasRoot": "x", "steps": [], "expression": { "type": "exists", "steps": [] } }));
    assert_eq!(
        value("EXISTS(x.y)"),
        json!({ "type": "compare", "op": "neq", "left": { "type": "traverse", "aliasRoot": "x", "steps": [], "expression": prop("y") }, "right": stat(json!(null)) })
    );
    assert_eq!(refused("EXISTS(a, b)"), "EXISTS(…) expects a traversal path");
    assert_eq!(refused("EXISTS(x.y WHERE z)"), "EXISTS(… WHERE …) needs a traversal path — a value has nothing to filter");
    let path = "EXISTS(…) expects a traversal path like -[:edge]-> or alias-[:edge]->, or a property read like x.`Field`";
    assert_eq!(refused("EXISTS(edge.y)"), path);
    assert_eq!(refused("EXISTS(1)"), path);
    // A walk ending in a resource hop has no steps to probe.
    assert_eq!(refused("EXISTS(x-[:_resources]->)"), path);
}

#[test]
fn a_namespace_member_call_is_its_stdlib_function() {
    assert_eq!(
        value("currency.get_number_from_figure(x)"),
        json!({ "type": "function", "fn": "currency.get_number_from_figure", "args": [prop("x")] })
    );
    let currency = "CURRENCY provides: GET_NUMBER_FROM_FIGURE(figure), GET_CODE_FROM_FIGURE(figure), FORMAT_FIGURE(number, code)";
    assert_eq!(refused("CURRENCY.x"), format!("CURRENCY is a function family, not a position — call one of its functions. {currency}"));
    assert_eq!(refused("CURRENCY.NOPE(x)"), format!("CURRENCY has no function NOPE() — {currency}"));
    assert_eq!(refused("CURRENCY.CONCAT(a)"), format!("CURRENCY has no function CONCAT() — {currency}"));
    assert_eq!(refused("CURRENCY.GET_NUMBER_FROM_FIGURE()"), "CURRENCY.GET_NUMBER_FROM_FIGURE(figure) takes 1 argument, got 0");
    assert_eq!(refused("TEXT.REGEX_EXTRACT(a)"), "TEXT.REGEX_EXTRACT(text, pattern, group?) takes 2–3 arguments, got 1");
    assert_eq!(refused("EXISTS(CURRENCY)"), format!("CURRENCY is a function family, not a position — call one of its functions. {currency}"));
}

#[test]
fn an_unknown_all_caps_namespace_in_call_position_is_refused() {
    let message = "Unknown function namespace 'NOPE' — the namespaced families are: CURRENCY, DATE, DATETIME, TEXT, URL, NUMBER";
    assert_eq!(refused("NOPE.F(x)"), message);
    assert_eq!(value("Nope.F(x)")["aliasRoot"], "Nope");
    assert_eq!(value("N.F(x)")["aliasRoot"], "N");
    assert_eq!(value("NOPE.x")["aliasRoot"], "NOPE");
}

// ── A built-in call's static shape (BridgeError) ──

#[test]
fn file_and_read_have_a_fixed_shape() {
    assert_eq!(shape_refused("FILE(x)"), "FILE(content, \"pdf\" | \"text\") takes exactly 2 arguments, got 1 — e.g. FILE(report_text, \"pdf\")");
    assert_eq!(shape_refused("FILE(x, \"doc\")"), "FILE()'s second argument is the artifact type — a literal \"pdf\" or \"text\"");
    assert_eq!(value("FILE(x, \"pdf\")")["fn"], "file");
    assert_eq!(shape_refused("READ(a, b)"), "READ(file) takes exactly 1 argument, got 2 — e.g. READ(attachment)");
    // A scoped member's name is checked as the bare built-in's.
    assert_eq!(shape_refused("X.READ()"), "READ(file) takes exactly 1 argument, got 0 — e.g. READ(attachment)");
}

#[test]
fn an_options_map_settles_its_keys() {
    let sig = "CHUNKS(text, { size | entities, overlap })";
    let inventory = "size — the most characters a piece may be; entities — the most records a piece is expected to yield, cutting on whole lines; overlap — how many characters each piece repeats from the one before it (none by default); unit — what size counts — \"chars\" (exactly one of 'size' or 'entities')";
    assert_eq!(shape_refused("CHUNKS(t)"), format!("{sig} takes exactly 2 arguments, got 1 — the options are a map: {inventory}"));
    assert_eq!(shape_refused("CHUNKS(t, 5)"), format!("{sig} takes its options as a map — write {{ size: … }}, not a bare value. The options are: {inventory}"));
    assert_eq!(shape_refused("CHUNKS(t, { ...o })"), format!("{sig} takes its options written out one by one — a spread ('...') is not accepted here. The options are: {inventory}"));
    assert_eq!(shape_refused("CHUNKS(t, { sise: 1 })"), format!("{sig} has no option 'sise' (did you mean 'size'?) — the options are: {inventory}"));
    assert_eq!(shape_refused("CHUNKS(t, { zz: 1 })"), format!("{sig} has no option 'zz' — the options are: {inventory}"));
    assert_eq!(shape_refused("CHUNKS(t, { size: 1, size: 2 })"), format!("{sig} is given 'size' twice — write it once"));
    assert_eq!(shape_refused("CHUNKS(t, { overlap: 1 })"), format!("{sig} needs one of 'size' or 'entities' — the most characters a piece may be, or the most records a piece is expected to yield, cutting on whole lines. The options are: {inventory}"));
    assert_eq!(shape_refused("CHUNKS(t, { size: 1, entities: 2 })"), format!("{sig} is given 'size' and 'entities', which are two ways of saying how big a piece is — write one of them"));
    assert!(lower_expression(&tree("CHUNKS(t, { entities: n, unit: \"chars\" })"), "").is_ok());
}

#[test]
fn a_literal_option_is_a_known_spelling_written_down() {
    let sig = "CHUNKS(text, { size | entities, overlap })";
    assert_eq!(shape_refused("CHUNKS(t, { size: 1, unit: u })"), format!("{sig}: 'unit' is written down, not worked out — write unit: \"chars\" or \"tokens\""));
    assert_eq!(shape_refused("CHUNKS(t, { size: 1, unit: \"x\" })"), format!("{sig}: 'unit' has no value \"x\" — write unit: \"chars\" or \"tokens\""));
    assert_eq!(shape_refused("CHUNKS(t, { size: 1, unit: \"tokens\" })"), format!("{sig}: token chunking is not available yet; use unit: \"chars\""));
}

#[test]
fn an_overlap_must_be_under_the_size_printing_numbers_as_javascript_does() {
    let sig = "CHUNKS(text, { size | entities, overlap })";
    let tail = "each piece would repeat the whole of the one before it and the text would never advance";
    assert_eq!(shape_refused("CHUNKS(t, { size: 10, overlap: 10 })"), format!("{sig}: an overlap of 10 is not smaller than a size of 10 — {tail}"));
    assert_eq!(
        shape_refused("CHUNKS(t, { size: 0.00000001, overlap: 1000000000000000000000 })"),
        format!("{sig}: an overlap of 1e+21 is not smaller than a size of 1e-8 — {tail}")
    );
    assert!(lower_expression(&tree("CHUNKS(t, { size: 10, overlap: 2 })"), "").is_ok());
    assert!(lower_expression(&tree("CHUNKS(t, { size: s, overlap: 20 })"), "").is_ok());
}

// ── Conditions ──

#[test]
fn a_condition_splits_on_its_top_level_ands_only() {
    assert_eq!(condition("a"), json!({ "kind": "expr", "expr": prop("a") }));
    assert_eq!(
        condition("a AND (b AND c)"),
        json!({ "kind": "and", "conjuncts": [{ "kind": "expr", "expr": prop("a") },
            { "kind": "expr", "expr": { "type": "logical", "op": "and", "operands": [prop("b"), prop("c")] } }] })
    );
    assert_eq!(condition("a OR b AND c")["expr"]["op"], "or");
}

#[test]
fn an_is_test_names_its_graph_position_or_address() {
    assert_eq!(condition("r IS <crm>"), json!({ "kind": "isTest", "subjectRaw": "r", "type": { "graph": "crm" } }));
    assert_eq!(condition("`r x` IS <crm-[:company]->>")["subjectRaw"], "`r x`");
    assert_eq!(condition("f(\"🌍\") IS <crm-[:`Odd Name`]->>"), json!({ "kind": "isTest", "subjectRaw": "f(\"🌍\")", "type": { "graph": "crm", "position": "Odd Name" } }));
    assert_eq!(
        condition("\"🌍\" == x AND r IS <at-[:a WHERE n == \"é\"]->>")["conjuncts"][1]["type"],
        json!({ "graph": "at", "hopsRaw": "-[:a WHERE n == \"é\"]->" })
    );
    assert_eq!(condition("r IS <crm-[:a]->-[:b]->>")["type"]["hopsRaw"], "-[:a]->-[:b]->");
    assert_eq!(condition("r IS <crm-[a:b]->>")["type"]["hopsRaw"], "-[a:b]->");
}

#[test]
fn an_is_test_is_refused_off_the_top_level_or_without_a_position_type() {
    let nested = "IS type tests under OR/NOT (or nested in parentheses) are not yet supported — use IS only as a top-level AND conjunct";
    assert_eq!(condition_refused("a OR r IS <crm>"), nested);
    assert_eq!(condition_refused("(r IS <crm>)"), nested);
    assert_eq!(condition_refused("x-[:a WHERE r IS <c>]->.b"), nested);
    let expects = "IS expects a position type in angle brackets like <graph> or <graph-[:position]->>";
    assert_eq!(condition_refused("r IS <text | null>"), expects);
    assert_eq!(condition_refused("r IS <crm-[:a]->[]>"), expects);
    assert_eq!(condition_refused("r IS <crm<-[:a]->"), expects);
    assert_eq!(condition_refused("r IS <crm-[:a]->.`f`>"), expects);
}

#[test]
fn a_tree_and_its_json_lower_alike() {
    let text = "x-[:a]->.b == 1";
    let json = serde_json::to_value(tree(text)).unwrap();
    assert_eq!(lower_expression_json(&json, text).unwrap(), value(text));
    assert_eq!(lower_condition_json(&json, text).unwrap(), condition(text));
    assert_eq!(
        lower_expression_json(&serde_json::to_value(tree("x[0]")).unwrap(), "x[0]").unwrap_err(),
        json!({ "message": "an index read `x[i]` is written AT(x, i)" })
    );
}
