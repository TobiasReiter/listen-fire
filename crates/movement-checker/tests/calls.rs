//! The calls, closures and flow families on their own programs. Parity with
//! the TypeScript checker is the harness's job (parity/run.sh); these pin
//! the rules the families add to the walk.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

fn codes(source: &str, version: u32) -> Vec<(String, String)> {
    let catalog = CatalogSnapshot::load(r#"{"adapters":{},"credentials":{},"plugins":{}}"#).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap().into_iter().map(|d| (d.code, d.message)).collect()
}

fn has(found: &[(String, String)], code: &str) -> bool {
    found.iter().any(|(c, _)| c == code)
}

#[test]
fn binding_a_call_of_a_movement_that_returns_nothing_is_refused() {
    let source = "movement lists(e: <number>) {\n  names = [1]\n}\nmovement main(e: <number>) {\n  x = lists(e: e)\n}";
    let found = codes(source, 1);
    assert!(has(&found, "MOV_CALL_RETURNS_NOTHING"), "{found:?}");
}

#[test]
fn a_callback_that_reaches_a_wait_through_a_movement_is_refused() {
    let source = "movement waits(n: <number>) {\n  await sleep(1h)\n  return n\n}\nmovement main(e: <number>) {\n  cb = callback(waits)\n}";
    assert!(has(&codes(source, 3), "MOV_WAIT_NOT_RESUMABLE"));
    assert!(!has(&codes(source, 2), "MOV_WAIT_NOT_RESUMABLE"));
}

#[test]
fn movements_calling_each_other_declare_what_they_return() {
    let source = "function ping(n: <number>) {\n  if n == 0 {\n    return 0\n  }\n  return pong(n - 1)\n}\nfunction pong(n: <number>): <number> {\n  return ping(n)\n}";
    let found = codes(source, 3);
    let recursive: Vec<_> = found.iter().filter(|(c, _)| c == "MOV_RECURSIVE_RETURN_TYPE").collect();
    assert_eq!(recursive.len(), 1, "{found:?}");
    assert!(recursive[0].1.contains("(ping → pong → ping)"), "{found:?}");
}

#[test]
fn a_closure_that_calls_itself_and_returns_nothing_binds_nothing() {
    let source = "movement main(e: <number>) {\n  tick = (n: <number>) => {\n    if n > 0 {\n      y = tick(n - 1)\n    }\n  }\n  tick(2)\n}";
    assert!(has(&codes(source, 3), "MOV_CALL_RETURNS_NOTHING"));
}

#[test]
fn a_value_argument_is_held_to_its_parameter_type() {
    let source = "movement inc(v: <number>): <number> {\n  return v + 1\n}\nmovement main(e: <number>) {\n  x = inc(\"three\")\n  y = inc(v: e)\n}";
    let found = codes(source, 3);
    let misfits: Vec<_> = found.iter().filter(|(c, _)| c == "MOV_CALL_ARG_TYPE").collect();
    assert_eq!(misfits.len(), 1, "{found:?}");
    assert_eq!(misfits[0].1, "'inc' expects number for 'v' (argument 1), but this argument is text");
}

#[test]
fn a_record_literal_argument_carries_only_the_keys_its_parameter_declares() {
    let source = "movement configured(cfg: <{ mode: text, owner?: text }>) {\n  x = 1\n}\nmovement main(e: <number>) {\n  configured({ mode: \"fast\", ownr: \"sam\" })\n}";
    let found = codes(source, 3);
    assert!(found.iter().any(|(c, m)| c == "MOV_CALL_ARG_TYPE" && m.ends_with("which has no key 'ownr' — did you mean 'owner'?")), "{found:?}");
}

#[test]
fn a_builtin_argument_of_the_wrong_kind_is_refused_from_version_3() {
    let source = "movement main(e: <number>) {\n  x = UPPER(e)\n}";
    let message = "UPPER's 'text' takes text, and this is number — UPPER(text)";
    assert!(codes(source, 3).iter().any(|(c, m)| c == "MOV_BUILTIN_ARG_TYPE" && m == message));
    assert!(!has(&codes(source, 2), "MOV_BUILTIN_ARG_TYPE"));
}

#[test]
fn a_collection_op_reads_its_settings_as_written() {
    let source = "movement main(e: <number>) {\n  names = [\"a\", \"b\"]\n  x = MAP(names, { concurrency: 2, initialConcurrency: 4 }, (t) => { return t })\n}";
    let found = codes(source, 3);
    let message = "'MAP' runs its first batch 4 at a time and the rest 2 at a time — the first batch is the warm-up, so it is never the wider one. Lower initialConcurrency, or raise concurrency.";
    assert!(found.iter().any(|(c, m)| c == "MOV_COLLECTION_OP_CONFIG" && m == message), "{found:?}");
}

#[test]
fn a_collection_ops_function_takes_its_members_type() {
    let source = "movement main(e: <number>) {\n  xs = [1, 2]\n  x = MAP(xs, (t) => { return UPPER(t) })\n  y = MAP(e, (t) => { return t })\n}";
    let found = codes(source, 3);
    assert!(found.iter().any(|(c, m)| c == "MOV_BUILTIN_ARG_TYPE" && m.starts_with("UPPER's 'text' takes text, and this is number")), "{found:?}");
    assert!(found.iter().any(|(c, m)| c == "MOV_COLLECTION_OP_NOT_A_COLLECTION" && m.starts_with("'MAP' reads a collection, and this is number")), "{found:?}");
}

/// A chain of closures, each returning the last on two branches: the
/// returns' union is one arm per distinct handle (the same handle passed on
/// is itself), so the check is linear in the chain — before, a union that
/// doubled per level made it exponential, and 20 links never finished.
#[test]
fn a_chain_of_closures_returning_the_last_twice_checks_in_linear_time() {
    let catalog = CatalogSnapshot::load(
        r#"{"adapters":{"attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"crm_cred":{"positions":{"company":{"properties":{"name":"text"},"edges":{}}},"collections":{"companies":{"target":"company"}},"writableRoots":{"company":{"fields":{"name":"text"},"resultShape":{"externalId":"text","name":"text"}}}}}}},"credentials":{"crm_cred":{"adapters":["attio"]}},"plugins":{}}"#,
    )
    .unwrap();
    let links = 60;
    let mut source = String::from(
        "import { attio } from adapters\nimport { crm_cred } from credentials\ncrm = attio(credentials: crm_cred)\nmovement m() {\n  org = write crm-[:companies]-> { name: \"Acme\" }\n  f0 = () => COALESCE(org, \"x\")\n",
    );
    for i in 1..=links {
        source += &format!("  f{i} = () => {{\n    if 1 > 0 {{\n      return f{p}()\n    }}\n    return f{p}()\n  }}\n", p = i - 1);
    }
    source += &format!("  g = graph {{ n: f{links}() }}\n}}\n");
    for version in [4, 5] {
        let started = std::time::Instant::now();
        let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
        let found: Vec<String> = check_source(&source, &catalog, options).unwrap().into_iter().map(|d| d.code).collect();
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "{:?}", started.elapsed());
        assert_eq!(found, ["MOV_GRAPH_ENTRY_RECORD"]);
    }
}

#[test]
fn a_closure_is_not_held_as_data_under_version_5() {
    let not_data = |line: &str, version: u32| {
        let source = format!("movement m(c: <boolean>) {{\n  label = (x: <number>) => \"x\"\n  {line}\n}}");
        codes(&source, version).into_iter().filter(|(c, _)| c == "MOV_CLOSURE_NOT_DATA").map(|(_, m)| m).collect::<Vec<_>>()
    };
    assert_eq!(not_data("fs = [label]", 5).len(), 1);
    assert!(not_data("box = { g: label }", 5)[0].starts_with("'g' holds a closure"));
    // Refused once, as the IF's operand, not again as the list's element.
    let chosen = not_data("fs = [IF c THEN label ELSE 1 END]", 5);
    assert_eq!(chosen.len(), 1, "{chosen:?}");
    assert!(chosen[0].starts_with("a value chosen by IF"));
    assert!(not_data("d = MAP([1, 2], (x) => { return label })", 5)[0].starts_with("'MAP' answers a list"));
    assert!(not_data("fs = [label]", 4).is_empty());
}
