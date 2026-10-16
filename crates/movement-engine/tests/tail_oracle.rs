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

/// `LOWER` and `UPPER` of seeded texts follow Rust's own tables (the
/// toolchain's Unicode, 17 today). Node's ICU (Unicode 16) wrote the oracle,
/// and a text maps differently only where it holds a letter Unicode 17 gave
/// a case (U+A7CE, U+A7D3, U+16EA0, U+16EBB), or a sigma beside U+0295,
/// which Unicode 17 no longer counts as cased (`ʕΣ` lowers to `ʕσ`, where
/// Node wrote `ʕς`).
#[test]
fn case_maps_by_rusts_tables() {
    const CASED_FROM_17: [char; 4] = ['\u{A7CE}', '\u{A7D3}', '\u{16EA0}', '\u{16EBB}'];
    let cases: Vec<Json> = serde_json::from_str(include_str!("oracle/case_mapping.json")).expect("case_mapping.json reads");
    assert!(cases.len() >= 4000);
    let mut unexplained = Vec::new();
    let mut moved = 0;
    for case in &cases {
        let text = case["text"].as_str().unwrap();
        let (lower, upper) = (js::to_lower_case(text), js::to_upper_case(text));
        assert_eq!((lower.as_str(), upper.as_str()), (text.to_lowercase().as_str(), text.to_uppercase().as_str()));
        if lower == case["lower"].as_str().unwrap() && upper == case["upper"].as_str().unwrap() {
            continue;
        }
        moved += 1;
        let explained = text.chars().any(|c| CASED_FROM_17.contains(&c)) || (text.contains('ʕ') && text.contains('Σ'));
        if !explained {
            unexplained.push(format!("{text:?}: {lower:?} {upper:?}, node {} {}", case["lower"], case["upper"]));
        }
    }
    assert!(unexplained.is_empty(), "{} of {moved} moved texts are unexplained:\n{}", unexplained.len(), unexplained.join("\n"));
}

/// ORDER BY and `SORT` over keys that mix numbers with texts and other
/// kinds, past V8's 64-item insertion sort: the comparator is no total
/// order, so V8's TimSort alone decides where items land, and the port lands
/// them there too.
#[test]
fn mixed_keys_sort_as_v8s_timsort_sorts_them() {
    use movement_engine::env::decode;
    use movement_engine::order_limit::sort_by_order_key;
    use movement_parser::lowering::expression::OrderDirection;
    let cases: Vec<Json> = serde_json::from_str(include_str!("oracle/mixed_sort.json")).expect("mixed_sort.json reads");
    assert!(cases.len() >= 400);
    let mut past_64 = 0;
    for (i, case) in cases.iter().enumerate() {
        let keys: Vec<js::Js> = case["keys"].as_array().unwrap().iter().map(|k| decode(k).unwrap()).collect();
        let direction = match case["direction"].as_str() {
            Some("asc") => Some(OrderDirection::Asc),
            Some("desc") => Some(OrderDirection::Desc),
            _ => None,
        };
        let expected: Vec<usize> = case["order"].as_array().unwrap().iter().map(|i| i.as_u64().unwrap() as usize).collect();
        assert_eq!(sort_by_order_key(&keys, direction), expected, "case {i}: {} keys, {:?}", keys.len(), case["direction"]);
        if keys.len() > 64 {
            past_64 += 1;
        }
    }
    assert!(past_64 >= 350, "{past_64} cases past 64 keys");
}
