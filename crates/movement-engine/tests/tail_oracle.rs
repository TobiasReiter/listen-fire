//! The TypeScript engine's runtime accidents (what V8, Node or zod decide
//! rather than the language), held to the TypeScript's own answers: one
//! oracle file each, written by tests/oracle/tail_oracle.ts through
//! generate.ts.

use movement_engine::extract::bound_text;
use movement_engine::js;
use serde_json::Value as Json;

/// A source file bounded for the prompt under a seeded
/// `EXTRACTION_FILE_CHARS`, a fractional one included: the cut where `slice`
/// truncates, and the marker and the count printing the number as written.
#[test]
fn a_file_is_bounded_as_the_typescript_bounds_it() {
    let cases: Vec<Json> = serde_json::from_str(include_str!("oracle/file_bound.json")).expect("file_bound.json reads");
    assert!(cases.len() > 400, "the oracle holds {} cases", cases.len());
    let fractional = cases.iter().filter(|c| c["ceiling"].as_f64().is_some_and(|x| x.fract() != 0.0)).count();
    assert!(fractional > 100, "{fractional} fractional ceilings");
    for case in &cases {
        let text = case["text"].as_str().unwrap();
        let ceiling = case["ceiling"].as_f64().unwrap();
        let (content, chars, from) = bound_text(text, ceiling);
        let label = format!("{text:?} under {}", case["setting"]);
        assert_eq!(content, case["content"].as_str().unwrap(), "{label}");
        assert_eq!(chars, case["chars"].as_f64().unwrap(), "{label}");
        assert_eq!(from.map(|n| n as u64), case["truncatedFrom"].as_u64(), "{label}");
    }
}

/// `LOWER` and `UPPER` of seeded texts as Node's ICU maps them: not Rust's
/// tables, which follow the toolchain's Unicode.
#[test]
fn case_maps_as_nodes_icu_maps_it() {
    let cases: Vec<Json> = serde_json::from_str(include_str!("oracle/case_mapping.json")).expect("case_mapping.json reads");
    assert!(cases.len() >= 4000);
    let mut mismatches = Vec::new();
    let mut differs_from_rust = 0;
    for case in &cases {
        let text = case["text"].as_str().unwrap();
        let (lower, upper) = (js::to_lower_case(text), js::to_upper_case(text));
        if lower != case["lower"].as_str().unwrap() || upper != case["upper"].as_str().unwrap() {
            mismatches.push(format!("{text:?}: {lower:?} {upper:?}, node {} {}", case["lower"], case["upper"]));
        }
        if text.to_lowercase() != lower || text.to_uppercase() != upper {
            differs_from_rust += 1;
        }
    }
    assert!(mismatches.is_empty(), "{} of {} differ:\n{}", mismatches.len(), cases.len(), mismatches.join("\n"));
    eprintln!("{differs_from_rust} of {} map differently under Rust's own tables", cases.len());
}
