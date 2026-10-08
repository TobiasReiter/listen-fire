//! A hop's pushdown and its ORDER BY / LIMIT plan held to the TypeScript's
//! own answers (tests/oracle/order_limit.json, written by
//! tests/oracle/order_limit_oracle.ts through generate.ts): for each seeded
//! bracket, the pushed `where` / `orderBy` / `limit` must be the very JSON
//! text JSON.stringify writes for the TypeScript's, with the same leaves
//! swapped for the same scalars, and the items kept must be the same, in the
//! same order.

use movement_engine::env::decode;
use movement_engine::js::{self, Js, JsObject};
use movement_engine::order_limit::{Substitution, apply_hop_order_limit, hop_pushdown};
use movement_parser::lowering::expression::{EdgeStep, Expression, TraversalStep};
use serde_json::Value as Json;

fn edge_step(hop: &str) -> EdgeStep {
    let probe = format!("graph{hop}.`__movement_engine_probe__`");
    let tree = movement_parser::expr::parse_expression(&probe).expect("the hop parses");
    let lowered = movement_parser::lowering::lower_expression(&tree, &probe).expect("the hop lowers");
    match lowered {
        Expression::Traverse { mut steps, .. } if steps.len() == 1 => match steps.remove(0) {
            TraversalStep::Edge(step) => step,
            other => panic!("not an edge hop: {other:?}"),
        },
        other => panic!("not a one-hop walk: {other:?}"),
    }
}

#[test]
fn a_hop_pushes_and_keeps_what_typescript_pushes_and_keeps() {
    let cases: Vec<Json> = serde_json::from_str(include_str!("oracle/order_limit.json")).expect("the oracle reads");
    assert!(cases.len() > 500, "the oracle holds its cases");
    for case in &cases {
        let hop = case["hop"].as_str().unwrap();
        let step = edge_step(hop);
        let pushed = hop_pushdown(&step);
        let leaves = pushed.where_.map(|w| movement_engine::filter::pure_leaf_reads(w).expect("a pushed WHERE is pure")).unwrap_or_default();
        let substitutions: Vec<Substitution<'_>> = case["subs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|sub| Substitution { leaf: leaves[sub[0].as_u64().unwrap() as usize], value: decode(&sub[1]).unwrap() })
            .collect();
        let mut object = JsObject::new();
        for (key, value) in pushed.members(&substitutions) {
            object.set(key, value);
        }
        let text = js::json_stringify(&Js::object(object), 0);
        assert_eq!(text, case["pushdown"].as_str().unwrap(), "{hop} {}", case["subs"]);

        let keys: Option<Vec<Js>> = case.get("keys").map(|keys| keys.as_array().unwrap().iter().map(|k| decode(k).unwrap()).collect());
        let count = keys.as_ref().map_or_else(|| case["count"].as_u64().unwrap() as usize, Vec::len);
        let plan = apply_hop_order_limit(count, step.cardinality.as_ref(), keys.as_deref()).expect("the pin sorts no mixed keys past 64 items");
        let expected: Vec<usize> = case["plan"].as_array().unwrap().iter().map(|i| i.as_u64().unwrap() as usize).collect();
        assert_eq!(plan, expected, "{hop} keys {:?}", case.get("keys"));
    }
}
