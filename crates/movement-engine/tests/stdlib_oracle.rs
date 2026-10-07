//! The standard library and the shared comparator held to the TypeScript's
//! own answers (tests/oracle/stdlib.json, written by tests/oracle/
//! generate.ts) over inputs chosen for JavaScript's hazards: coercion,
//! number printing, rounding, dates, regexes, URLs, key order.
//!
//! An input Rust hands back to TypeScript (`Fallback`) is not a mismatch;
//! the test prints how many there were per function.

use std::collections::BTreeMap;

use movement_engine::env::{decode, encode};
use movement_engine::eval::{ErrorClass, EvalError};
use movement_engine::filter::compare_values;
use movement_engine::js::Js;
use movement_engine::stdlib::{self, Clock};
use movement_parser::lowering::expression::FilterOperator;
use serde_json::{Value as Json, json};

struct NoClock;
impl Clock for NoClock {
    fn today(&self, _zone: &str) -> Result<Js, EvalError> {
        Err(EvalError::Fallback("no clock".into()))
    }
}

/// The wire with object ids dropped (the two sides number them apart) and
/// every number a double (`3` and `3.0` are one JavaScript number).
fn shape(json: &Json) -> Json {
    match json {
        Json::Number(n) => json!(n.as_f64().unwrap()),
        Json::Array(tagged) if matches!(tagged.first().and_then(Json::as_str), Some("l" | "o")) => {
            let items = tagged[2].as_array().unwrap().iter().map(|item| match item {
                Json::Array(pair) if tagged[0] == "o" => json!([pair[0], shape(&pair[1])]),
                other => shape(other),
            });
            json!([tagged[0], items.collect::<Vec<_>>()])
        }
        other => other.clone(),
    }
}

fn run(fn_: &str, args: &[Js]) -> Result<Js, EvalError> {
    if let Some(op) = fn_.strip_prefix("compare.") {
        let op: FilterOperator = serde_json::from_value(json!(op)).unwrap();
        return compare_values(&args[0], op, &args[1]).map(Js::Bool);
    }
    let value = || args.first().cloned().unwrap_or(Js::Undefined);
    match fn_ {
        "coerce.date" => stdlib::coerce_to_date(&value()).map(|d| d.map_or(Js::Null, Js::String)),
        "coerce.datetime" => stdlib::coerce_to_datetime(&value()).map(|d| d.map_or(Js::Null, |(iso, _)| Js::String(iso))),
        "coerce.number" => Ok(stdlib::coerce_to_number(&value()).map_or(Js::Null, Js::Number)),
        id => stdlib::apply_namespaced(id, args, &NoClock),
    }
}

#[test]
fn the_standard_library_answers_as_typescript_does() {
    let cases: Vec<Json> = serde_json::from_str(include_str!("oracle/stdlib.json")).unwrap();
    let mut fallbacks: BTreeMap<String, usize> = BTreeMap::new();
    let mut mismatches = Vec::new();
    for case in &cases {
        let fn_ = case["fn"].as_str().unwrap();
        let args: Vec<Js> = case["args"].as_array().unwrap().iter().map(|a| decode(a).unwrap()).collect();
        let got = match run(fn_, &args) {
            Ok(value) => json!({ "value": shape(&encode(&value)) }),
            Err(EvalError::Thrown { class, message }) => json!({ "throws": match class {
                ErrorClass::Engine(code) => json!({ "name": "MovementEngineError", "message": format!("{code}: {message}") }),
                ErrorClass::Error => json!({ "name": "Error", "message": message }),
                ErrorClass::RangeError => json!({ "name": "RangeError", "message": message }),
            } }),
            Err(EvalError::Fallback(_)) => {
                *fallbacks.entry(fn_.to_string()).or_default() += 1;
                continue;
            }
        };
        if case["outcome"].get("loneSurrogate").is_some() {
            mismatches.push(format!("{fn_}({}) = {got}, where only TypeScript can say a lone surrogate", case["args"]));
            continue;
        }
        let want = match &case["outcome"] {
            Json::Object(o) if o.contains_key("value") => json!({ "value": shape(&o["value"]) }),
            other => other.clone(),
        };
        if got != want {
            mismatches.push(format!("{fn_}({}) = {got}, TypeScript {want}", case["args"]));
        }
    }
    eprintln!("{} cases; handed back to TypeScript: {fallbacks:?}", cases.len());
    assert!(mismatches.is_empty(), "{} mismatches:\n{}", mismatches.len(), mismatches.join("\n"));
}
