//! The priced-plugin cap, held to the TypeScript's own answers
//! (tests/oracle/priced.json, written by tests/oracle/priced_oracle.ts through
//! generate.ts): the same refusal and account for a priced plugin.

use movement_engine::ledger::{Ledger, Spend};
use movement_parser::catalog::types::{JsMap, PluginSpec};
use serde_json::{Value as Json, json};

#[test]
fn a_priced_plugin_is_refused_and_charged_as_typescript_refuses_and_charges_it() {
    let cases: Vec<Json> = serde_json::from_str(include_str!("oracle/priced.json")).expect("the oracle reads");
    let world = &cases[0];
    assert_eq!(world["kind"], "world");
    let plugins: JsMap<PluginSpec> = serde_json::from_value(world["plugins"].clone()).expect("the plugins read");
    let mut priced = 0;
    for case in &cases[1..] {
        match case["kind"].as_str().unwrap() {
            "priced" => {
                priced += 1;
                let spend: Spend = serde_json::from_value(case["spend"].clone()).unwrap();
                let ledger = Ledger::new(&spend);
                ledger.charge(Some(&case["charges"])).unwrap();
                let plugin = case["plugin"].as_str().unwrap();
                match (ledger.plugin_refusal(&plugins, plugin), case.get("refused")) {
                    (Some(cap), Some(refused)) => {
                        assert_eq!(cap.to_json()["class"], refused["class"], "{case}");
                        assert_eq!(cap.message(), refused["message"].as_str().unwrap(), "{case}");
                        assert_eq!(json!(cap.cap_microdollars), json!(refused["capMicrodollars"].as_f64().unwrap()), "{case}");
                        assert_eq!(json!(cap.spent_microdollars), json!(refused["spentMicrodollars"].as_f64().unwrap()), "{case}");
                        assert_eq!(case["asked"], json!([]), "a refused plugin's host is asked nothing");
                    }
                    (None, None) => {
                        let asked = &case["asked"].as_array().unwrap()[0];
                        assert_eq!(json!(ledger.budget()["remainingMicrodollars"].as_f64()), json!(asked["remainingMicrodollars"].as_f64()), "{case}");
                        ledger.charge(Some(&case["answerCost"])).unwrap();
                    }
                    (refusal, _) => panic!("{case}\nRust {refusal:?}"),
                }
                let lines = ledger.cost_lines();
                let segment: f64 = lines.iter().map(|l| l.microdollars).sum();
                let account = &case["account"];
                assert_eq!(segment, account["segmentMicrodollars"].as_f64().unwrap(), "{case}");
                assert_eq!(spend.prior_microdollars + segment, account["runMicrodollars"].as_f64().unwrap(), "{case}");
                let by_source: Vec<(String, f64)> = lines.iter().map(|l| (l.source.clone(), l.microdollars)).collect();
                let expected: Vec<(String, f64)> =
                    account["bySource"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_f64().unwrap())).collect();
                let mut sorted = by_source.clone();
                sorted.sort_by(|a, b| a.0.cmp(&b.0));
                assert_eq!(sorted, expected, "{case}");
            }
            other => panic!("an oracle case of kind {other}"),
        }
    }
    // A pin that silently lost its cases would hold nothing.
    assert!(priced >= 80);
}
