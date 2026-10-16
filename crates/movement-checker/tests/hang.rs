//! A program can never make the checker hang. Every walk over a type is
//! linear in its distinct parts — a closure's return nests the last one's,
//! shared, not copied, and comparing, widening or searching it meets each
//! part once — and an inferred type with more than 10,000 distinct parts
//! stops there, reported on every version (`MOV_TYPE_TOO_LARGE`): a safety
//! limit, not a language rule. The TypeScript checker's
//! `type_size_limit.unit.test.ts`, case for case.

use std::time::{Duration, Instant};

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"crm_cred":{"positions":{"company":{"properties":{"name":"text"},"edges":{}}},"collections":{"companies":{"target":"company"}},"writableRoots":{"company":{"fields":{"name":"text"},"resultShape":{"externalId":"text","name":"text"}}}}}}},"credentials":{"crm_cred":{"adapters":["attio"]}},"plugins":{}}"#;

const PRELUDE: &str = "import { attio } from adapters\nimport { crm_cred } from credentials\ncrm = attio(credentials: crm_cred)";

const LINKS: usize = 30;

/// The errors a program reports, and how long the check took.
fn errors_under(version: u32, outside: &[String], body: &[String]) -> (Vec<Diagnostic>, Duration) {
    let source = format!("{PRELUDE}\n{}\nmovement m() {{\n{}\n}}", outside.join("\n"), body.join("\n"));
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let started = Instant::now();
    let found = check_source(&source, &catalog, options).unwrap();
    let took = started.elapsed();
    (found.into_iter().filter(Diagnostic::is_error).collect(), took)
}

fn codes(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().map(|d| d.code.as_str()).collect()
}

/// A chain of closures, each returning `returned` (over `a`, the last one's
/// value) on two branches.
fn chain_of(returned: &str, start: &str) -> Vec<String> {
    let mut lines = vec!["  org = write crm-[:companies]-> { name: \"Acme\" }".to_string(), format!("  f0 = () => {start}")];
    for i in 1..=LINKS {
        lines.extend([
            format!("  f{i} = () => {{"),
            format!("    a = f{}()", i - 1),
            "    if 1 > 0 {".to_string(),
            format!("      return {returned}"),
            "    }".to_string(),
            format!("    return {returned}"),
            "  }".to_string(),
        ]);
    }
    lines
}

fn quick(took: Duration) {
    assert!(took < Duration::from_secs(1), "took {took:?}");
}

fn big_map(keys: usize) -> String {
    format!("{{ {} }}", (0..keys).map(|i| format!("k{i}: {{ k{i}: 1 }}")).collect::<Vec<_>>().join(", "))
}

fn too_large(name: &str) -> String {
    format!("'{name}' builds a type too large to check (over 10000 parts) — split the value into named parts or declare its shape (node <Name> {{ … }})")
}

#[test]
fn a_chain_of_closures_returning_a_map_of_the_last_value_twice_checks_in_linear_time() {
    for version in 3..=5 {
        let mut body = chain_of("{ k: a, j: a }", "COALESCE(org, \"x\")");
        body.push(format!("  g = graph {{ n: f{LINKS}() }}"));
        let (found, took) = errors_under(version, &[], &body);
        assert_eq!(codes(&found), ["MOV_GRAPH_ENTRY_RECORD"], "v{version}");
        quick(took);
    }
}

#[test]
fn the_same_chain_over_a_plain_value_checks_in_linear_time_and_says_nothing() {
    for version in 3..=5 {
        let mut body = chain_of("{ k: a, j: a }", "1");
        body.push(format!("  x = f{LINKS}()"));
        let (found, took) = errors_under(version, &[], &body);
        assert!(found.is_empty(), "v{version}: {found:?}");
        quick(took);
    }
}

#[test]
fn a_chain_of_closures_returning_a_list_of_the_last_value_twice_checks_in_linear_time() {
    for version in 3..=5 {
        let mut body = chain_of("[a, a]", "COALESCE(org, \"x\")");
        body.push(format!("  g = graph {{ n: f{LINKS}() }}"));
        let (found, took) = errors_under(version, &[], &body);
        assert_eq!(codes(&found), ["MOV_GRAPH_ENTRY_RECORD"], "v{version}");
        quick(took);
    }
}

/// The parity corpus's `h12` (record 8575), thirty links deep.
#[test]
fn a_fan_of_closures_each_a_list_of_three_calls_of_the_last_checks_in_linear_time() {
    for version in 3..=5 {
        let mut fan = vec!["  org = write crm-[:companies]-> { name: \"Acme\" }".to_string(), "  h0 = () => COALESCE(org, \"x\")".to_string()];
        for i in 1..=LINKS {
            fan.push(format!("  h{i} = () => [h{0}(), h{0}(), h{0}()]", i - 1));
        }
        fan.push(format!("  g = graph {{ n: h{LINKS}() }}"));
        let (found, took) = errors_under(version, &[], &fan);
        assert_eq!(codes(&found), ["MOV_GRAPH_ENTRY_RECORD"], "v{version}");
        assert!(found[0].message.contains(&format!("at '{}'", "[0]".repeat(LINKS))), "{}", found[0].message);
        quick(took);
    }
}

#[test]
fn a_binding_whose_type_has_more_than_10000_distinct_parts_is_refused_once_and_goes_untyped() {
    for version in 3..=5 {
        let (found, _) = errors_under(version, &[], &[format!("  x = {}", big_map(10_000)), "  y = x.k1".to_string()]);
        let found: Vec<_> = found.iter().map(|d| (d.code.as_str(), d.message.clone())).collect();
        assert_eq!(found, [("MOV_TYPE_TOO_LARGE", too_large("x"))], "v{version}");
    }
}

#[test]
fn a_function_or_a_closure_that_returns_one_is_refused_where_it_is_declared_and_its_calls_go_untyped() {
    for version in 3..=5 {
        let outside = ["function big() {".to_string(), format!("  return {}", big_map(10_000)), "}".to_string()];
        let (found, _) = errors_under(version, &outside, &["  y = big()".to_string(), "  z = y.k1".to_string()]);
        let found: Vec<_> = found.iter().map(|d| (d.code.as_str(), d.message.clone(), d.span.start.line)).collect();
        assert_eq!(found, [("MOV_TYPE_TOO_LARGE", too_large("big"), 4)], "v{version}");
        let body = [format!("  c = () => {{ return {} }}", big_map(10_000)), "  y = c()".to_string(), "  z = y.k1".to_string()];
        let (found, _) = errors_under(version, &[], &body);
        let found: Vec<_> = found.iter().map(|d| (d.code.as_str(), d.message.clone())).collect();
        assert_eq!(found, [("MOV_TYPE_TOO_LARGE", too_large("c"))], "v{version}");
    }
}

#[test]
fn a_type_with_10000_parts_is_within_the_limit() {
    for version in 3..=5 {
        let (found, _) = errors_under(version, &[], &[format!("  x = {}", big_map(9_997))]);
        assert!(found.is_empty(), "v{version}: {:?}", codes(&found));
    }
}
