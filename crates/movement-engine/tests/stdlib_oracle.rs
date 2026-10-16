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

/// A regex case over an astral character or a lone surrogate: version 5's
/// regex reads code points (`.` is a whole astral character, a lone
/// surrogate is U+FFFD), where JavaScript read UTF-16 units.
fn regex_over_astral(fn_: &str, case: &Json) -> bool {
    fn_ == "text.regex_extract" && { let text = case["args"].to_string(); text.contains("\"s16\"") || text.chars().any(|c| u32::from(c) > 0xFFFF) || text.contains("\\u") || text.contains('\u{FDD0}') }
}

/// A date reading over a text version 5 reads as no date-time (ISO 8601 /
/// RFC 3339 only, the hour 0–23, a day its month has) where V8's legacy
/// parser read one (`"9"`, `"2026-02-30"`, `T24:00`): DATE, DATETIME, the
/// DATE members and an ordering may answer differently.
fn date_v8_read(fn_: &str, case: &Json) -> bool {
    let dated = fn_.starts_with("date") || fn_.starts_with("coerce.") || fn_.starts_with("flat.date") || matches!(fn_, "compare.lt" | "compare.lte" | "compare.gt" | "compare.gte");
    dated && case["args"].as_array().unwrap().iter().any(|a| a.as_str().is_some_and(|t| movement_engine::js_date::parse(t).is_none()))
}

/// A number read from a text the version 5 way: trimmed of Rust's
/// whitespace (U+0085 is whitespace, U+FEFF is not) and read as a decimal
/// (no `0x`/`0o`/`0b` prefix), so such a text may answer differently.
fn number_text_v5(case: &Json) -> bool {
    case["args"].as_array().unwrap().iter().filter_map(Json::as_str).any(|t| {
        t.contains(['\u{FEFF}', '\u{85}']) || ["0x", "0X", "0o", "0O", "0b", "0B"].iter().any(|p| t.trim().trim_start_matches(['+', '-']).starts_with(p))
    })
}

/// ROUND of a negative half: version 5 rounds half away from zero
/// (`ROUND(-2.5)` is -3; JavaScript's `Math.round` said -2).
fn negative_half(fn_: &str, case: &Json) -> bool {
    fn_ == "flat.round" && case["args"][0].as_f64().is_some_and(|x| x < 0.0 && x.fract() == -0.5)
}

/// An ordering of texts holding an astral character or a lone surrogate:
/// version 5 orders texts by code point (Rust's `Ord`), where JavaScript
/// ordered UTF-16 units (`"\u{FF61}" < "😀"` in version 5, `>` before).
fn code_point_order(fn_: &str, case: &Json) -> bool {
    fn_.starts_with("compare.") && { let text = case["args"].to_string(); text.contains("\"s16\"") || text.chars().any(|c| u32::from(c) > 0xFFFF) }
}

/// A case where version 5 answers differently from the TypeScript on
/// purpose, each kind named by its own function above.
fn accepted_difference(fn_: &str, case: &Json) -> bool {
    regex_over_astral(fn_, case)
        || date_v8_read(fn_, case)
        || number_text_v5(case)
        || negative_half(fn_, case)
        || code_point_order(fn_, case)
        || empty_text_is_no_number(fn_, case)
        || number_like_key_serialised(fn_, case)
}

/// TEXT.SERIALISE of a map holding a number-like key: version 5 keeps a
/// map's keys as texts, so the sorted keys put `"10"` before `"2"`
/// (JavaScript listed integer keys first, in numeric order).
fn number_like_key_serialised(fn_: &str, case: &Json) -> bool {
    fn holds_number_key(json: &Json) -> bool {
        match json {
            Json::Array(items) if items.first() == Some(&Json::from("o")) => items[2]
                .as_array()
                .is_some_and(|entries| entries.iter().any(|e| e[0].as_str().is_some_and(|k| !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit())) || holds_number_key(&e[1]))),
            Json::Array(items) => items.iter().any(holds_number_key),
            _ => false,
        }
    }
    fn_ == "text.serialise" && holds_number_key(&case["args"])
}

/// `NUMBER` of a text that is empty once trimmed: version 5 answers null
/// (JavaScript's `Number("")` is 0).
fn empty_text_is_no_number(fn_: &str, case: &Json) -> bool {
    fn_ == "flat.tonumber" && case["args"][0].as_str().is_some_and(|t| t.trim().is_empty())
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
        if got != want && !accepted_difference(fn_, case) {
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
        if got != want && !accepted_difference(fn_, case) {
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

/// Node's answers, with the version 5 dialect's two differences: a pattern
/// that leans on Annex B (an octal escape, `\N` past the groups, `\c`
/// without a letter, an unknown letter escape) is malformed, and an astral
/// character is one character, not two units. Every other answer is Node's.
#[test]
fn regexes_match_as_node_matches_them_bar_annex_b_and_astral_characters() {
    use movement_engine::js_regex::{Regex, RegexError};
    let cases: Vec<Json> = serde_json::from_str(include_str!("oracle/regex.json")).unwrap();
    let mut differences = 0;
    let mut mismatches = Vec::new();
    for case in &cases {
        let (pattern, text) = (case["pattern"].as_str().unwrap(), case["text"].as_str().unwrap());
        let got = match Regex::new(pattern).map(|r| r.exec(text)) {
            Err(RegexError::Syntax) => json!({ "syntaxError": true }),
            Ok(None) => json!({ "match": null }),
            Ok(Some(groups)) => json!({ "match": groups }),
        };
        if got == case["outcome"] {
            continue;
        }
        differences += 1;
        let astral = |s: &str| s.chars().any(|c| u32::from(c) > 0xFFFF);
        let annex_b = got == json!({ "syntaxError": true }) && pattern.contains('\\');
        if !(annex_b || astral(pattern) || astral(text)) {
            mismatches.push(format!("/{pattern}/.exec({text:?}) = {got}, node {}", case["outcome"]));
        }
    }
    eprintln!("{} regex cases, {differences} answered differently (Annex B or astral)", cases.len());
    assert!(mismatches.is_empty(), "{} mismatches:\n{}", mismatches.len(), mismatches.join("\n"));
    assert!(cases.len() >= 7200, "the oracle holds {} cases", cases.len());
}
