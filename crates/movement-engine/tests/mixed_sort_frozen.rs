//! ORDER BY and `SORT` over keys that mix numbers with texts and other
//! kinds, past 64 items (tests/frozen/mixed_sort.jsonl; see frozen/mod.rs).
//! The comparator is no total order, so the sort's algorithm alone decides
//! where items land: this holds the port of V8's TimSort in place.

use movement_engine::js;
use movement_engine::order_limit::sort_by_order_key;
use movement_parser::lowering::expression::OrderDirection;
use serde_json::json;
mod frozen;
mod oracle_wire;
use oracle_wire::decode;

#[test]
fn mixed_keys_sort_as_they_were_frozen() {
    let cases = frozen::cases("mixed_sort");
    assert!(cases.len() >= 400);
    let mut past_64 = 0;
    let answered: Vec<_> = cases
        .iter()
        .map(|case| {
            let keys: Vec<js::Js> = case["keys"].as_array().unwrap().iter().map(|k| decode(k).unwrap()).collect();
            let direction = match case["direction"].as_str() {
                Some("asc") => Some(OrderDirection::Asc),
                Some("desc") => Some(OrderDirection::Desc),
                _ => None,
            };
            past_64 += usize::from(keys.len() > 64);
            frozen::answer(case, &["order"], vec![("order", json!(sort_by_order_key(&keys, direction)))])
        })
        .collect();
    assert!(past_64 >= 350, "{past_64} cases past 64 keys");
    frozen::settle("mixed_sort", &answered);
}
