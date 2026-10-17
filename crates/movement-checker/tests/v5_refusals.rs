//! From version 5 the checker refuses at save the forms the engine does not
//! run, each with the spelling it does run: a linked write or match whose
//! target walks more than one hop (MOV_WRITE_MULTI_HOP), a walk with no root
//! outside a hop's WHERE (MOV_WALK_ROOTLESS), and a `unique by` on a write to
//! a declared node (MOV_WRITE_SHAPE_UNIQUE). `_resources` reads off an
//! extraction call's result as off the keyword's. Versions 1–4 are
//! unchanged. The TypeScript twin is
//! packages/movement-lang/checker/__test__/v5_refusals.unit.test.ts, same
//! programs, same messages.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"contractVersion":1,"adapters":{"attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"crm_cred":{"positions":{"company":{"properties":{"name":"text"},"edges":{"deals":{"target":"deal"},"notes":{"target":"note","writable":true}}},"deal":{"properties":{"title":"text"},"edges":{}},"note":{"properties":{"body":"text"},"edges":{}}},"collections":{"companies":{"target":"company"},"notes":{"target":"note"}},"writableRoots":{"note":{"fields":{"body":"text"},"resultShape":{"externalId":"text"}},"company":{"fields":{"name":"text"},"resultShape":{"externalId":"text"}}}}}}},"credentials":{"crm_cred":{"adapters":["attio"]}},"plugins":{}}"#;

const CODES: &[&str] = &["MOV_WRITE_MULTI_HOP", "MOV_WALK_ROOTLESS", "MOV_WRITE_SHAPE_UNIQUE", "MOV_RESOURCES_NOT_EXTRACTED", "MOV_KG_QUERY_RETIRED", "MOV_AWAIT_ON_LIST", "MOV_WRITE_LINK_FIELD", "MOV_WRITE_LINK_FIELD_NUDGE", "MOV_JSON_HAS_NO_EDGES"];

fn found(body: &str, version: u32) -> Vec<(String, usize, String)> {
    let (setup, declaration) = if version < 5 { ("crm = attio(credentials: crm_cred)", "movement") } else { ("crm = connect attio using crm_cred", "function") };
    let source = format!(
        "import {{ attio }} from adapters\nimport {{ crm_cred }} from credentials\n{setup}\nnode Note {{\n  title: <text>\n}}\n{declaration} go(t: <text>, j: <json>) {{\n{body}\n}}\n"
    );
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let diagnostics = check_source(&source, &catalog, options).unwrap_or_else(|e| panic!("{source}: {e:?}"));
    diagnostics.into_iter().filter(|d| CODES.contains(&d.code.as_str())).map(|d| (d.code, d.span.start.line, d.message)).collect()
}

fn codes(body: &str, version: u32) -> Vec<String> {
    found(body, version).into_iter().map(|(code, _, _)| code).collect()
}

#[test]
fn a_linked_write_or_match_walks_one_hop() {
    assert_eq!(
        found("  write crm-[:companies]->-[:notes]-> { body: t }", 5),
        [(
            "MOV_WRITE_MULTI_HOP".to_string(),
            8,
            "a write target walks exactly one edge, from the record it starts at — 'crm-[:companies]->-[:notes]->' walks 2 hops. Walk to the parent in a block, then write off its alias: 'parent-[p:…]-> { write p-[:notes]-> { … } }'".to_string()
        )]
    );
    assert_eq!(codes("  found = match crm-[:companies]->-[:notes]-> { unique by (`body`), body: t }", 5), ["MOV_WRITE_MULTI_HOP"]);
    // The spelling it names runs, and so does one hop.
    assert!(codes("  crm-[c:companies]-> {\n    write c-[:notes]-> { body: t }\n  }", 5).is_empty());
    assert!(codes("  write crm-[:notes]-> { body: t }", 5).is_empty());
    assert!(codes("  write crm-[:companies]->-[:notes]-> { body: t }", 4).is_empty());
}

#[test]
fn a_walk_starts_at_a_record_it_names() {
    assert_eq!(
        found("  -[c:companies]-> {\n    x = 1\n  }", 5),
        [(
            "MOV_WALK_ROOTLESS".to_string(),
            8,
            "'-[c:companies]->' has no root, so nothing says which record it walks from — name the record it starts at: 'x-[c:companies]->'".to_string()
        )]
    );
    assert_eq!(
        found("  x = exists(-[:notes]->)", 5),
        [(
            "MOV_WALK_ROOTLESS".to_string(),
            8,
            "'-[:notes]->' has no root, so nothing says which record it walks from — name the record it starts at ('x-[:notes]->'). Only inside a hop's WHERE does 'exists(-[:notes]->)' walk from a record: the one that hop lands on".to_string()
        )]
    );
    assert_eq!(codes("  if (exists(-[n:notes WHERE n.body == t]->)) {\n    x = 1\n  }", 5), ["MOV_WALK_ROOTLESS"]);
    assert_eq!(codes("  x = count(-[:notes]->)", 5), ["MOV_WALK_ROOTLESS"]);
    assert_eq!(codes("  f = () => exists(-[:notes]->)", 5), ["MOV_WALK_ROOTLESS"]);
    // Inside a hop's WHERE a rootless EXISTS walks off the record the hop lands on.
    assert!(codes("  crm-[c:companies WHERE exists(-[:deals]->)]-> {\n    write crm-[:notes]-> { body: c.name }\n  }", 5).is_empty());
    assert!(codes("  x = exists(crm-[c:companies WHERE exists(-[:deals]->)]->)", 5).is_empty());
    // Versions 1–4 keep their own reading.
    assert!(codes("  -[c:companies]-> {\n    x = 1\n  }", 4).is_empty());
    assert!(codes("  x = EXISTS(-[:notes]->)", 4).is_empty());
}

#[test]
fn a_write_to_a_declared_node_finds_nothing_by_unique_by() {
    let found = found("  n = write Note-[:item]-> { unique by (`title`), title: t }", 5);
    assert_eq!(
        found,
        [(
            "MOV_WRITE_SHAPE_UNIQUE".to_string(),
            8,
            "'unique by' has no meaning on a write to the declared node 'Note' — the record it makes lands in memory, so there is no store to find an existing one in. Drop the 'unique by' clause (or synthesise the record, 'node { title: … }')".to_string()
        )]
    );
    assert!(codes("  n = write Note-[:item]-> { unique by (`title`), title: t }", 4).is_empty());
}

#[test]
fn resources_read_off_an_extraction_calls_result() {
    let extract_one = "  d = extractOne([t], node D: \"the company\" { name: <text> \"a name\" })\n  if (d != null) {\n    d-[f:_resources]-> {\n      write crm-[:notes]-> { body: f.content }\n    }\n  }";
    assert!(codes(extract_one, 5).is_empty(), "{:?}", found(extract_one, 5));
    let extract = "  found = extract([t], node D: \"each company\" { name: <text> \"a name\" })\n  found-[f:_resources]-> {\n    write crm-[:notes]-> { body: f.content }\n  }";
    assert!(codes(extract, 5).is_empty(), "{:?}", found(extract, 5));
    // A system's record still reaches its files over an edge it declares.
    assert_eq!(codes("  crm-[c:companies]-> {\n    c-[f:_resources]-> {\n      x = 1\n    }\n  }", 5), ["MOV_RESOURCES_NOT_EXTRACTED"]);
}

#[test]
fn a_built_in_call_on_a_line_by_itself_parses_and_is_reported_as_a_value_nothing_reads() {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: 5, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let diagnostics = check_source("function go(t: <text>) {\n  Text.upper(t)\n}\n", &catalog, options).unwrap();
    assert_eq!(diagnostics.iter().map(|d| (d.code.as_str(), d.span.start.line)).collect::<Vec<_>>(), [("MOV_BUILTIN_UNUSED", 2)]);
}

#[test]
fn a_knowledge_graph_query_text_is_retired() {
    assert_eq!(
        found("  x = KG_VALUE(\"MATCH (n) RETURN n\")", 5),
        [(
            "MOV_KG_QUERY_RETIRED".to_string(),
            8,
            "'KG_VALUE(…)' is retired — it ran a query text against the knowledge graph, and no engine runs one from version 5. Walk the graph instead: connect it ('kg = connect graph'), then read along its edges ('kg-[c:Company WHERE …]->')".to_string()
        )]
    );
    assert_eq!(codes("  if (KG_EXISTS(\"MATCH (n) RETURN n\")) {\n    x = 1\n  }", 5), ["MOV_KG_QUERY_RETIRED"]);
    assert!(codes("  x = KG_VALUE(\"MATCH (n) RETURN n\")", 4).is_empty());
}

#[test]
fn an_await_parks_on_one_record() {
    let body = "  xs = crm-[c:companies]-> {\n    return c\n  }\n  w = await first(xs-[d:deals]->)";
    assert_eq!(
        found(body, 5),
        [(
            "MOV_AWAIT_ON_LIST".to_string(),
            11,
            "'await' parks on one record, under one key, and 'xs' holds a list of records — there is no one record to wait at. Await on one record a name holds: 'await first(rec-[d:deals]->)'".to_string()
        )]
    );
}

#[test]
fn a_record_is_not_a_relationships_value() {
    let body = "  d = write crm-[:notes]-> { body: t }\n  write crm-[:companies]-> { name: t, deals: d }";
    assert_eq!(
        found(body, 5),
        [(
            "MOV_WRITE_LINK_FIELD".to_string(),
            9,
            "'deals' is a relationship of crm.company, and a record is not written into it as a value — connect 'd' structurally: write off it ('write d-[:…]-> { … }'), or link the two after the write ('link … -[:deals]-> d')".to_string()
        )]
    );
    assert_eq!(codes(body, 4), ["MOV_WRITE_LINK_FIELD_NUDGE"]);
}

#[test]
fn a_json_value_has_no_relationships() {
    assert_eq!(
        found("  n = count(j-[:subs]->)", 5),
        [(
            "MOV_JSON_HAS_NO_EDGES".to_string(),
            8,
            "'j' holds a json value, and a json value has no relationships — '-[:subs]->' walks nothing. Read a key with a dot ('j.key'), or walk the record the value came from".to_string()
        )]
    );
    assert_eq!(codes("  j-[s:subs]-> {\n    x = 1\n  }", 5), ["MOV_JSON_HAS_NO_EDGES"]);
    assert!(codes("  n = count(j-[:subs]->)", 4).is_empty());
}
