//! The built-ins, the shared comparator, number printing and the regex
//! matcher held to the TypeScript's own answers (tests/oracle/*.json,
//! written by tests/oracle/generate.ts) over inputs chosen for JavaScript's
//! hazards: coercion, number printing, rounding, dates, regexes, URLs, key
//! order.
//!
//! An input Rust hands back to TypeScript (`Fallback`) is not a mismatch,
//! but no function may hand back more than its recorded share: a change
//! that quietly sends more to TypeScript fails here.

use std::collections::BTreeMap;

use movement_engine::env::{decode, encode};
use movement_engine::eval::{ErrorClass, EvalError};
use movement_engine::filter::compare_values;
use movement_engine::js::Js;
use movement_engine::stdlib::{self, Surroundings};
use movement_parser::lowering::expression::FilterOperator;
use serde_json::{Value as Json, json};

/// The generator pins `now` at the epoch and runs in UTC.
fn around() -> Surroundings<'static> {
    Surroundings { services: movement_engine::env_services::current(), now: Some(0.0), local_zone: Some("UTC") }
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
        return compare_values(&args[0], op, &args[1], around().local()).map(Js::Bool);
    }
    let value = || args.first().cloned().unwrap_or(Js::Undefined);
    match fn_ {
        "coerce.date" => Ok(stdlib::coerce_to_date(&value(), around().local()).map_or(Js::Null, Js::str)),
        "coerce.datetime" => Ok(stdlib::coerce_to_datetime(&value(), around().local()).map_or(Js::Null, |(iso, _)| Js::str(iso))),
        "coerce.number" => Ok(stdlib::coerce_to_number(&value()).map_or(Js::Null, Js::Number)),
        flat if flat.starts_with("flat.") => stdlib::apply_flat(&flat["flat.".len()..], args, around()),
        id => stdlib::apply_namespaced(id, args, around()),
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
            Ok(value) => json!({ "value": shape(&plain(&value)) }),
            Err(EvalError::Thrown { class, message }) => json!({ "throws": match class {
                ErrorClass::Engine(code) => json!({ "name": "MovementEngineError", "message": format!("{code}: {message}") }),
                ErrorClass::Error => json!({ "name": "Error", "message": message }),
                ErrorClass::RangeError => json!({ "name": "RangeError", "message": message }),
                ErrorClass::TypeError => json!({ "name": "TypeError", "message": message }),
                ErrorClass::Unreproduced => json!({ "name": "MovementEngineError", "message": format!("MOVENG_UNSUPPORTED: {message}") }),
            } }),
            Err(EvalError::Host(_) | EvalError::CapExceeded(_)) => unreachable!("no reader, so no host"),
            Err(EvalError::Fallback(_)) => {
                *fallbacks.entry(fn_.to_string()).or_default() += 1;
                continue;
            }
        };
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
    let mut totals: BTreeMap<&str, usize> = BTreeMap::new();
    for case in &cases {
        *totals.entry(case["fn"].as_str().unwrap()).or_default() += 1;
    }
    for (fn_, count) in &fallbacks {
        let ceiling = FALLBACK_CEILINGS.iter().find(|(f, _)| f == fn_).map_or(0.0, |(_, c)| *c);
        let share = *count as f64 / totals[fn_.as_str()] as f64;
        assert!(share <= ceiling, "{fn_} handed {count} of {} back to TypeScript ({share:.3}), above its ceiling {ceiling}", totals[fn_.as_str()]);
    }
}

/// The share of each function's oracle cases that may go back to
/// TypeScript. Every function not listed may hand back none (a split of an
/// astral character into its halves, and a match through a pair, were
/// handed back until the engine's strings held a lone surrogate).
const FALLBACK_CEILINGS: &[(&str, f64)] = &[];

/// Strings as JavaScript holds them (tests/oracle/strings_oracle.ts): the
/// built-ins, the comparator, cuts, JSON's quoting and the JSON text
/// boundary over seeded texts holding lone, paired and astral code units.
/// Nothing is handed back.
#[test]
fn strings_hold_what_javascript_holds() {
    use movement_engine::js_string;
    let cases: Vec<Json> = js_string::from_json_text(include_str!("oracle/strings.json")).unwrap();
    assert!(cases.len() > 9_000, "the oracle holds {} cases", cases.len());
    let lone = cases.iter().filter(|case| case.to_string().contains("\"s16\"")).count();
    assert!(lone > 2_000, "{lone} cases hold a lone surrogate");
    let mut mismatches = Vec::new();
    for case in &cases {
        let fn_ = case["fn"].as_str().unwrap();
        let args = case["args"].as_array().unwrap();
        let text = || match decode(&args[0]).unwrap() {
            Js::String(text) => text,
            other => panic!("{fn_} takes a text, not {other:?}"),
        };
        let got = match fn_ {
            "slice" => json!({ "value": encode(&Js::str(js_string::slice_units(text().as_form(), 0, args[1].as_u64().unwrap() as usize))) }),
            "json.quote" => json!({ "value": movement_engine::js::json_quote(text().as_form()) }),
            "json.text" => {
                // The JSON text as a host writes it (the case holds it as a
                // text, in the engine's form).
                let external = String::from_utf16(&js_string::units_vec(args[0].as_str().unwrap())).unwrap();
                let read: Json = js_string::from_json_text(&external).unwrap();
                // The writer writes back the text `JSON.stringify` wrote.
                let written = js_string::to_json_text(&read);
                if written != external {
                    mismatches.push(format!("json.text {} written back as {written}", args[0]));
                }
                json!({ "value": shape(&plain(&movement_engine::env::js_of_json(&read))) })
            }
            "bound" => {
                let (content, chars, from) = movement_engine::extract::bound_text(text().as_form(), args[1].as_f64().unwrap());
                json!({ "value": shape(&plain(&Js::array(vec![Js::str(content), Js::Number(chars), from.map_or(Js::Null, |n| Js::Number(n as f64))]))) })
            }
            _ => {
                let args: Vec<Js> = args.iter().map(|a| decode(a).unwrap()).collect();
                match run(fn_, &args) {
                    Ok(value) => json!({ "value": shape(&plain(&value)) }),
                    Err(EvalError::Thrown { message, .. }) => json!({ "throws": message }),
                    Err(other) => json!({ "handedBack": format!("{other:?}") }),
                }
            }
        };
        let want = match &case["outcome"] {
            Json::Object(o) if o.contains_key("value") => json!({ "value": shape(&o["value"]) }),
            Json::Object(o) if o.contains_key("throws") => json!({ "throws": o["throws"]["message"] }),
            other => other.clone(),
        };
        if got != want {
            mismatches.push(format!("{fn_}({}) = {got}, TypeScript {want}", case["args"]));
        }
    }
    assert!(mismatches.is_empty(), "{} of {} mismatch:\n{}", mismatches.len(), cases.len(), mismatches.join("\n"));
}

/// Version 5 prints Rust's shortest digits in JavaScript's layout. On a
/// 17-digit tie the last digit may differ from JavaScript's
/// (`-3759079.6958007813` where JavaScript wrote `…812`); both read back as
/// the same number, and nothing else may differ.
#[test]
fn numbers_print_as_javascript_lays_them_out() {
    let cases: Vec<(String, String)> = serde_json::from_str(include_str!("oracle/numbers.json")).unwrap();
    let mut ties = 0;
    let mismatches: Vec<String> = cases
        .iter()
        .filter_map(|(bits, want)| {
            let x = f64::from_bits(u64::from_str_radix(bits, 16).unwrap());
            let got = movement_engine::js::number_to_string(x);
            let last_digit_tie = got.len() == want.len()
                && got[..got.len() - 1] == want[..want.len() - 1]
                && got.parse::<f64>().ok() == Some(x);
            ties += usize::from(got != *want && last_digit_tie);
            (got != *want && !last_digit_tie).then(|| format!("{bits}: {got}, JavaScript {want}"))
        })
        .collect();
    assert!(ties < cases.len() / 100, "{ties} last-digit ties of {}", cases.len());
    assert!(mismatches.is_empty(), "{} of {} differ:\n{}", mismatches.len(), cases.len(), mismatches.join("\n"));
}

#[test]
fn regexes_match_as_node_matches_them() {
    use movement_engine::js_regex::{Regex, RegexError};
    let cases: Vec<Json> = serde_json::from_str(include_str!("oracle/regex.json")).unwrap();
    let mut fallbacks = 0;
    let mut mismatches = Vec::new();
    for case in &cases {
        let (pattern, text) = (case["pattern"].as_str().unwrap(), case["text"].as_str().unwrap());
        let got = match Regex::new(pattern).map(|r| r.exec(text)) {
            Err(RegexError::Unsupported(_)) => {
                fallbacks += 1;
                continue;
            }
            Err(RegexError::Syntax) => json!({ "syntaxError": true }),
            Ok(None) => json!({ "match": null }),
            Ok(Some(groups)) => json!({ "match": groups
                .into_iter()
                .map(|g| g.map(|units| String::from_utf16(&units).unwrap()))
                .collect::<Vec<_>>() }),
        };
        if got != case["outcome"] {
            mismatches.push(format!("/{pattern}/.exec({text:?}) = {got}, node {}", case["outcome"]));
        }
    }
    eprintln!("{} regex cases, {fallbacks} handed back to TypeScript", cases.len());
    assert!(mismatches.is_empty(), "{} mismatches:\n{}", mismatches.len(), mismatches.join("\n"));
    // The whole dialect, deep nesting and long texts included: nothing is
    // handed back.
    assert!(cases.len() >= 7200, "the oracle holds {} cases", cases.len());
    assert_eq!(fallbacks, 0, "{fallbacks} of {} handed back", cases.len());
}
