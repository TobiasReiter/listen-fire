//! The TypeScript engine's runtime accidents (what V8, Node or zod decide
//! rather than the language), held to the TypeScript's own answers: one
//! oracle file each, written by tests/oracle/tail_oracle.ts through
//! generate.ts.

use movement_engine::extract::bound_text;
use movement_engine::js;
mod oracle_wire;
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

/// ORDER BY and `SORT` over keys that mix numbers with texts and other
/// kinds, past V8's 64-item insertion sort: the comparator is no total
/// order, so V8's TimSort alone decides where items land, and the port lands
/// them there too.
#[test]
fn mixed_keys_sort_as_v8s_timsort_sorts_them() {
    use crate::oracle_wire::decode;
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
