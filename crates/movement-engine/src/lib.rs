//! The movement engine. A segment runs inside one WASM instance as one
//! future (`executor`); whatever it needs from the world it asks the
//! TypeScript host for, one request at a time or several at once (`host`),
//! and the host answers each by id. `abi` carries that conversation across
//! the boundary; `value` is the engine's value model.
//!
//! The first slice of language semantics is the pure evaluator (`eval`,
//! with `stdlib` and `filter`), which the TypeScript evaluator calls
//! synchronously through `abi::eval_expression` for an expression over value
//! bindings (apps/api/src/services/movement_engine/rust_engine.ts). Segment
//! entries are still the protocol's own probes.

pub mod abi;
pub mod bindings;
pub mod env;
pub mod env_services;
pub mod eval;
pub mod executor;
pub mod filter;
pub mod host;
pub mod js;
pub mod js_date;
pub mod js_regex;
pub mod program;
pub mod run;
pub mod stdlib;
pub mod trace;
pub mod value;

use movement_parser::lowering::expression::Expression;

use eval::{ErrorClass, EvalError, Evaluator, Prov};

use serde_json::{Value as Json, json};

use executor::{Answer, HostError, ProtocolError, Segment, join_all};
use host::{Family, Request};

/// The segment `start`'s input asks for, by its `entry`:
///
/// - `echo`: issues each of `requests` (`{family, method, args}`) at once
///   and finishes with `{answers}`, each in the answer envelope it came in.
/// - `segment`: a run, executed whole (crate::run says what it runs).
/// - `panic`: panics with `message` on the first poll, so a loader can prove
///   its trap path against the real artifact.
pub fn begin(input_text: &str) -> Result<Segment, ProtocolError> {
    let input: Json = serde_json::from_str(input_text).map_err(|e| ProtocolError(format!("the input is not JSON: {e}")))?;
    match input.get("entry").and_then(Json::as_str) {
        Some("echo") => {
            let requests = input
                .get("requests")
                .and_then(Json::as_array)
                .ok_or_else(|| ProtocolError("an echo needs `requests`, an array".into()))?
                .iter()
                .map(echo_request)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Segment::new(|host| async move {
                let answers = join_all(requests.into_iter().map(|request| host.request(request)).collect()).await;
                json!({ "answers": answers.iter().map(answer_envelope).collect::<Vec<_>>() })
            }))
        }
        Some("segment") => {
            let segment: run::SegmentInput =
                serde_json::from_str(input_text).map_err(|e| ProtocolError(format!("a segment's input does not read: {e}")))?;
            Ok(Segment::new(|host| run::segment(host, segment)))
        }
        Some("panic") => {
            let message = input.get("message").and_then(Json::as_str).unwrap_or("").to_string();
            Ok(Segment::new(|_host| async move { panic!("{message}") }))
        }
        Some(other) => Err(ProtocolError(format!("no entry `{other}`"))),
        None => Err(ProtocolError("the input names no `entry`".into())),
    }
}

fn echo_request(request: &Json) -> Result<Request, ProtocolError> {
    let text = |name: &str| {
        request
            .get(name)
            .and_then(Json::as_str)
            .ok_or_else(|| ProtocolError(format!("an echo request needs `{name}`, a string: {request}")))
    };
    let family = text("family")?;
    let family = Family::parse(family).ok_or_else(|| ProtocolError(format!("no host family `{family}`")))?;
    Ok(Request { family, method: text("method")?.to_string(), args: request.get("args").cloned().unwrap_or(Json::Null) })
}

/// An answer's JSON: `{"value": …}`, `{}` for `undefined`, or
/// `{"error": {message, …}}` for a request the host could not serve.
pub fn read_answer(json: &str) -> Result<Answer, ProtocolError> {
    let envelope: Json = serde_json::from_str(json).map_err(|e| ProtocolError(format!("the answer is not JSON: {e}")))?;
    let Some(object) = envelope.as_object() else {
        return Err(ProtocolError(format!("an answer is an object, not {envelope}")));
    };
    match (object.get("value"), object.get("error"), object.len()) {
        (Some(value), None, 1) => Ok(Ok(Some(value.clone()))),
        (None, None, 0) => Ok(Ok(None)),
        (None, Some(error), 1) if error.get("message").is_some_and(Json::is_string) => {
            Ok(Err(HostError { detail: error.clone() }))
        }
        _ => Err(ProtocolError(format!("an answer is {{value}}, {{}} or {{error: {{message}}}}, not {envelope}"))),
    }
}

fn answer_envelope(answer: &Answer) -> Json {
    match answer {
        Ok(Some(value)) => json!({ "value": value }),
        Ok(None) => json!({}),
        Err(error) => json!({ "error": error.detail }),
    }
}

/// `eval_expression`'s reply, or a message for input it cannot read.
pub fn evaluate(expr: &str, bindings: &str) -> Result<Json, String> {
    let expr: Expression = serde_json::from_str(expr).map_err(|e| format!("the expression does not read: {e}"))?;
    let envelope = env::read_envelope(bindings)?;
    let around = stdlib::Surroundings { services: env_services::current(), now: envelope.now };
    let evaluator = Evaluator::new(&envelope.env, envelope.language_version, around, envelope.origins);
    Ok(match evaluator.eval(&expr) {
        Ok(result) => json!({
            "value": env::encode(&result.value),
            "provenance": match result.prov {
                Prov::Binding(name) => json!({ "binding": name }),
                Prov::Built(trail) => match trail.direct {
                    Some(direct) => json!({ "origins": trail.origins, "direct": direct }),
                    None => json!({ "origins": trail.origins }),
                },
            },
        }),
        Err(EvalError::Thrown { class, message }) => json!({ "error": match class {
            ErrorClass::Engine(code) => json!({ "class": "MovementEngineError", "code": code, "message": message }),
            ErrorClass::Error => json!({ "class": "Error", "message": message }),
            ErrorClass::RangeError => json!({ "class": "RangeError", "message": message }),
        } }),
        Err(EvalError::Fallback(reason)) => json!({ "fallback": reason }),
        Err(EvalError::Suspend) => unreachable!("an evaluation with no reader never suspends"),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value as Json, json};

    use super::evaluate;

    /// `text` parsed and lowered as the TypeScript's `parseMovementExpression`
    /// does, as the JSON the engine is handed.
    fn lowered(text: &str) -> String {
        let tree = movement_parser::parse_expression(text, 0).unwrap();
        let bytes = movement_parser::lowering::lower_json_bytes(&tree.to_string(), text, movement_parser::lowering::Mode::Expression)
            .unwrap_or_else(|e| panic!("{}", String::from_utf8_lossy(&e)));
        String::from_utf8(bytes).unwrap()
    }

    fn eval_with(text: &str, envelope: Json) -> Json {
        evaluate(&lowered(text), &envelope.to_string()).unwrap()
    }

    fn eval(text: &str, bindings: Json) -> Json {
        let bindings: serde_json::Map<String, Json> =
            bindings.as_object().unwrap().iter().map(|(k, v)| (k.clone(), json!({ "value": v }))).collect();
        eval_with(text, json!({ "bindings": bindings }))
    }

    fn value(text: &str, bindings: Json) -> Json {
        let reply = eval(text, bindings);
        reply.get("value").cloned().unwrap_or_else(|| panic!("{text}: {reply}"))
    }

    #[test]
    fn the_lowered_shape_reads_back_as_it_was_written() {
        for text in [
            "a % b * c",
            "IF x THEN \"t\" ELSE CONCAT(\"a\", y) END",
            "{ type: \"section\", ...m, n: [1, ...xs] }",
            "COALESCE(a, DATE.ADD_DAYS(d, -1), NUMBER.FORMAT(n, \"compact\"))",
            "m-[x:Edge { description: \"d\", data: [a, b], tier: \"fast\" }]->.`Field`",
            "COUNT(c-[:deals WHERE stage == \"Seed\"]->)",
        ] {
            let json = lowered(text);
            let expr: movement_parser::lowering::expression::Expression = serde_json::from_str(&json).unwrap();
            assert_eq!(serde_json::to_string(&expr).unwrap(), json, "{text}");
        }
    }

    #[test]
    fn arithmetic_keeps_javascript_semantics() {
        assert_eq!(value("a % b", json!({ "a": -7, "b": 20 })), json!(-7.0));
        assert_eq!(value("a % b", json!({ "a": 7, "b": 0 })), json!(null));
        assert_eq!(value("a / b", json!({ "a": 7, "b": ["n", "-0"] })), json!(null));
        assert_eq!(value("-x", json!({ "x": "abc" })), json!(["n", "NaN"]));
        assert_eq!(value("-x", json!({ "x": 0 })), json!(["n", "-0"]));
        assert_eq!(value("a + b", json!({ "a": "1", "b": 2 })), json!(3.0));
        assert_eq!(value("a + b", json!({ "a": "", "b": ["u"] })), json!(["n", "NaN"]));
    }

    #[test]
    fn absence_reads_as_typescript_reads_it() {
        assert_eq!(value("\"said: ${x}!\"", json!({ "x": null })), json!("said: !"));
        assert_eq!(value("\"[${AT(d, k)}]\"", json!({ "d": ["o", 0, [["a", "x"]]], "k": "b" })), json!("[]"));
        assert_eq!(value("x == null", json!({ "x": ["u"] })), json!(true));
        assert_eq!(value("x == null", json!({ "x": false })), json!(false));
        assert_eq!(value("x == y", json!({ "x": ["u"], "y": null })), json!(false));
        assert_eq!(value("x == 0", json!({ "x": "0" })), json!(false));
        assert_eq!(value("IF x THEN \"then\" ELSE \"else\" END", json!({ "x": ["u"] })), json!("else"));
        assert_eq!(value("AT(l, -1)", json!({ "l": ["l", 0, [1, 2, 3]] })), json!(3.0));
        assert_eq!(value("AT(l, 0)", json!({ "l": "solo" })), json!("solo"));
        assert_eq!(value("AT(l, 1.5)", json!({ "l": ["l", 0, [1, 2]] })), json!(null));
        // An own key holding undefined is undefined, not null.
        assert_eq!(value("AT(d, \"a\")", json!({ "d": ["o", 0, [["a", ["u"]]]] })), json!(["u"]));
    }

    #[test]
    fn identity_crosses_the_boundary() {
        let d = json!(["o", 4, [["a", 1]]]);
        assert_eq!(value("d == e", json!({ "d": d, "e": ["r", 4] })), json!(true));
        assert_eq!(value("d == { a: 1 }", json!({ "d": d })), json!(false));
        // The caller's own object comes back as itself.
        assert_eq!(value("IF TRUE THEN d ELSE 0 END", json!({ "d": d })), json!(["i", 4]));
        assert_eq!(value("[d, d]", json!({ "d": d })), json!(["l", 0, [["i", 4], ["i", 4]]]));
    }

    #[test]
    fn maps_keep_javascript_key_order() {
        assert_eq!(value("{ b: 1, a: 2, b: 3 }", json!({})), json!(["o", 0, [["b", 3.0], ["a", 2.0]]]));
        assert_eq!(
            value("{ z: 0, ...m }", json!({ "m": ["o", 1, [["10", true], ["2", false]]] })),
            json!(["o", 0, [["2", false], ["10", true], ["z", 0.0]]])
        );
        let refused = eval("{ ...m }", json!({ "m": 5 }));
        assert_eq!(refused["error"]["code"], "MOVENG_UNSUPPORTED");
        assert_eq!(
            refused["error"]["message"],
            "copying the keys of a number into a map is not supported by the movement engine yet (a spread copies a map's keys or a record's fields — write the value under a key instead (the checker should have caught this))"
        );
        let refused = eval("[...m]", json!({ "m": "x" }));
        assert_eq!(refused["error"]["message"], "'...' splices a list's members into a list, and this value is not a list (string)");
        assert_eq!(value("{ ...m }", json!({ "m": ["o", 1, [["kind", "nope"]]] })), json!(["o", 0, [["kind", "nope"]]]));
        assert!(eval("{ ...m }", json!({ "m": ["o", 1, [["kind", "event"]]] })).get("fallback").is_some());
    }

    #[test]
    fn provenance_follows_the_typescript_rules() {
        let envelope = json!({
            "bindings": {
                "x": { "value": "a", "provenance": { "origins": [0], "direct": 0 } },
                "y": { "value": null, "provenance": { "origins": [1, 0] } },
                "z": { "value": 2 },
            },
            "origins": 2,
        });
        let prov = |text: &str| eval_with(text, envelope.clone())["provenance"].clone();
        assert_eq!(prov("x"), json!({ "binding": "x" }));
        assert_eq!(prov("IF z THEN x ELSE y END"), json!({ "binding": "x" }));
        assert_eq!(prov("COALESCE(y, x)"), json!({ "binding": "x" }));
        assert_eq!(prov("CONCAT(x, y, z)"), json!({ "origins": [0, 1] }));
        assert_eq!(prov("\"lit\""), json!({ "origins": [2], "direct": 2 }));
        assert_eq!(prov("CONCAT(\"a\", \"b\")"), json!({ "origins": [2, 3] }));
        assert_eq!(prov("x == null"), json!({ "binding": "x" }));
        assert_eq!(prov("UPPER(x)"), json!({ "origins": [0] }));
    }

    #[test]
    fn coalesce_short_circuits_from_version_three() {
        let text = "COALESCE(x, DATE.ADD_DAYS(\"2026-01-01\", 1000000000))";
        let envelope = |version: Option<u32>| {
            let mut e = json!({ "bindings": { "x": { "value": 1 } } });
            if let Some(v) = version {
                e["languageVersion"] = json!(v);
            }
            e
        };
        assert_eq!(eval_with(text, envelope(Some(3)))["value"], json!(1.0));
        let eager = eval_with(text, envelope(Some(2)));
        assert_eq!(eager["error"], json!({ "class": "RangeError", "message": "Invalid time value" }));
        assert_eq!(eval_with(text, envelope(None))["error"]["class"], "RangeError");
    }

    #[test]
    fn date_today_reads_the_pinned_instant_in_the_zone() {
        let envelope = json!({ "bindings": {}, "now": "2026-03-11T23:30:00.000Z" });
        assert_eq!(eval_with("DATE.TODAY(\"Europe/Berlin\")", envelope.clone())["value"], "2026-03-12");
        assert_eq!(eval_with("DATE.TODAY(\"UTC\")", envelope.clone())["value"], "2026-03-11");
        assert_eq!(
            eval_with("DATE.TODAY(\"Mars/Base\")", envelope.clone())["error"],
            json!({ "class": "Error", "message": "DATE.TODAY(zone) — 'Mars/Base' is not a recognised IANA time zone (e.g. \"Europe/London\", \"America/New_York\", \"UTC\")" })
        );
        assert_eq!(
            eval_with("DATETIME.AT(DATE.TODAY(\"Europe/Berlin\"), \"07:00\", \"Europe/Berlin\")", envelope)["value"],
            "2026-03-12T06:00:00.000Z"
        );
    }

    #[test]
    fn what_needs_the_host_is_handed_back() {
        assert!(eval("@current_date", json!({}))["fallback"].is_string());
        assert!(eval("x WITHIN \"30d\"", json!({ "x": 1 }))["fallback"].is_string());
        assert_eq!(eval("x", json!({}))["error"]["message"], "'x' is not in scope — the checker should have caught this");
    }
}
