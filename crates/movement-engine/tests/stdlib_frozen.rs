//! The built-ins and the shared comparator held to their frozen answers
//! (tests/frozen/stdlib.jsonl; see frozen/mod.rs) over inputs chosen for
//! JavaScript's hazards: coercion, number printing, rounding, dates, URLs,
//! key order, regex extraction.
//!
//! An input Rust hands back to TypeScript (`Fallback`) is recorded as
//! `{"fallback":true}`, so a change that quietly sends more there moves the
//! file.

mod frozen;
mod oracle_wire;
use oracle_wire::{decode, encode};
use movement_engine::eval::{ErrorClass, EvalError};
use movement_engine::filter::compare_values;
use movement_engine::js::Js;
use movement_engine::stdlib::{self, Surroundings};
use movement_parser::lowering::expression::FilterOperator;
use serde_json::{Value as Json, json};

/// The generator pins `now` at the epoch and runs in UTC, as a run does.
fn around() -> Surroundings<'static> {
    Surroundings { services: movement_engine::env_services::current(), now: Some(0.0) }
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

/// A value on the wire as the generator writes it: an input handed back is
/// written out, not referred to by id.
fn plain(value: &Js) -> Json {
    match value {
        Js::Array(list) => json!(["l", 0, list.items().iter().map(plain).collect::<Vec<_>>()]),
        Js::Object(object) => json!(["o", 0, object.entries().iter().map(|(k, v)| json!([encode(&Js::str(k.as_str())), plain(v)])).collect::<Vec<_>>()]),
        scalar => encode(scalar),
    }
}

fn run(fn_: &str, args: &[Js]) -> Result<Js, EvalError> {
    if let Some(op) = fn_.strip_prefix("compare.") {
        let op: FilterOperator = serde_json::from_value(json!(op)).unwrap();
        return compare_values(&args[0], op, &args[1]).map(Js::Bool);
    }
    let value = || args.first().cloned().unwrap_or(Js::Undefined);
    match fn_ {
        "coerce.date" => Ok(stdlib::coerce_to_date(&value()).map_or(Js::Null, Js::str)),
        "coerce.datetime" => Ok(stdlib::coerce_to_datetime(&value()).map_or(Js::Null, |(iso, _)| Js::str(iso))),
        "coerce.number" => Ok(stdlib::coerce_to_number(&value()).map_or(Js::Null, Js::Number)),
        flat if flat.starts_with("flat.") => stdlib::apply_flat(&flat["flat.".len()..], args),
        id => stdlib::apply_namespaced(id, args, around()),
    }
}

#[test]
fn the_standard_library_answers_as_it_was_frozen() {
    let cases = frozen::cases("stdlib");
    assert!(cases.len() > 11_000, "{} cases", cases.len());
    let answered: Vec<Json> = cases
        .iter()
        .map(|case| {
            let fn_ = case["fn"].as_str().unwrap();
            let args: Vec<Js> = case["args"].as_array().unwrap().iter().map(|a| decode(a).unwrap()).collect();
            let outcome = match run(fn_, &args) {
                Ok(value) => json!({ "value": shape(&plain(&value)) }),
                Err(EvalError::Thrown { class, message }) => json!({ "throws": match class {
                    ErrorClass::Engine(code) => json!({ "name": "MovementEngineError", "message": format!("{code}: {message}") }),
                    ErrorClass::Error => json!({ "name": "Error", "message": message }),
                    ErrorClass::RangeError => json!({ "name": "RangeError", "message": message }),
                    ErrorClass::TypeError => json!({ "name": "TypeError", "message": message }),
                    ErrorClass::Unreproduced => json!({ "name": "MovementEngineError", "message": format!("MOVENG_UNSUPPORTED: {message}") }),
                } }),
                Err(EvalError::Host(_) | EvalError::CapExceeded(_)) => unreachable!("no reader, so no host"),
                Err(EvalError::Fallback(_)) => json!({ "fallback": true }),
            };
            frozen::answer(case, &["outcome"], vec![("outcome", outcome)])
        })
        .collect();
    frozen::settle("stdlib", &answered);
}
