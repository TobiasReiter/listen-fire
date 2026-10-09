//! Records held as values (chunk 7A Task 3, Review Focus 3): every program in
//! tests/oracle/records.json run on this engine as the TypeScript engine ran
//! it — the same check, the same event — ending as it ended. Values arrive
//! untyped through the event's `json` fields, so the readings are the ones a
//! checked program can make of a value it cannot type: `Object.prototype`'s
//! names and ordinary ones read off dicts, present and absent; dicts whose
//! `kind` names a binding kind or a prototype name, which the TypeScript
//! takes for records; picked, held, folded, mapped and interpolated; under
//! every language version.
//!
//! A dict taken for a binding of a kind whose reads need what the run does
//! not hold for it (a traversed record's read seam, a kept walk) fails
//! loudly here (`MOVENG_UNSUPPORTED`, "a value shaped like …"), never
//! differently: those are counted, and held to their recorded share.

use serde_json::{Value as Json, json};

use movement_engine::executor::{PendingRequest, Step};

/// The share of cases that may end in the loud refusal of a shaped dict's
/// reading this engine does not hold (the README's transition artefacts).
const LOUD_SHARE: f64 = 0.02;

fn answer(request: &PendingRequest, payload: &Json, check: &Json) -> Json {
    match (request.family, request.method.as_str()) {
        ("check", "program") => json!({ "value": check }),
        ("adapters", "resolve") => json!({ "value": { "instance": "i1", "adapterType": "email", "methods": ["getFieldValue", "getRelated"] } }),
        ("control.cancel", _) => json!({ "value": false }),
        ("trace", "append") | ("log", "write") => json!({}),
        ("adapters", "call") if request.args["method"] == json!("getFieldValue") => {
            let read = movement_engine::env::decode(&request.args["args"]).expect("the read's arguments decode");
            let movement_engine::js::Js::Object(read) = read else { panic!("a read's arguments are an object") };
            let Some(movement_engine::js::Js::String(field)) = read.get("fieldId") else { panic!("a read names its field") };
            // The payload on the eval wire: `["o", id, [[key, value], …]]`.
            let entries = payload[2].as_array().expect("the payload is an object");
            // The oracle's adapter answers `Reflect.get(data, field)`: what
            // the payload's prototype holds under a name it lacks.
            let prototype = |name: &str| match name {
                "constructor" => json!(["f", "Object"]),
                "__proto__" => json!(["p"]),
                other => json!(["f", other]),
            };
            match entries.iter().find(|e| e[0] == json!(field)) {
                Some(entry) => json!({ "value": { "result": entry[1] } }),
                None if movement_engine::js::is_object_prototype_name(field) => json!({ "value": { "result": prototype(field) } }),
                None => json!({ "value": {} }),
            }
        }
        other => panic!("the oracle's programs ask nothing else: {other:?}"),
    }
}

/// How a segment ended, as the TypeScript's run ended: its error.
fn ending(done: &Json) -> Json {
    let error = done.get("thrown").or_else(|| done.get("failed").map(|f| &f["error"]));
    match error {
        Some(error) => json!({ "error": error }),
        None if done.get("result").is_some() => json!({ "completed": true }),
        None => json!({ "unexpected": done }),
    }
}

#[test]
fn records_held_as_values_read_as_the_typescript_reads_them() {
    let oracle: Json = serde_json::from_str(include_str!("oracle/records.json")).expect("records.json reads");
    let prelude = oracle["prelude"].as_str().expect("a prelude");
    let cases = oracle["cases"].as_array().expect("cases");
    let mut loud = 0;
    let mut differ = Vec::new();
    for case in cases {
        let version = case["version"].as_u64().expect("a version");
        let source = prelude.replace("BODY", case["body"].as_str().expect("a body"));
        let payload = &case["payload"];
        let input = json!({
            "entry": "segment",
            "source": source,
            "languageVersion": version,
            "segmentId": "g1",
            "serves": [],
            "now": "2026-01-01T00:00:00.000Z",
            "event": ["o", 0, [["pipelineInputId", "p"], ["adapterType", "email"], ["triggerType", "webhook"], ["payload", payload]]],
            "catalog": oracle["catalog"],
            "credentialIds": { "inbox_cred": "cred-inbox_cred" },
        });
        let mut segment = movement_engine::begin(&input.to_string()).expect("the segment begins");
        let mut step = segment.start().expect("the segment starts");
        let done = loop {
            match step {
                Step::Done(done) => break done,
                Step::Pending(pending) => {
                    let request = pending.into_iter().next().expect("one request at a time");
                    let reply = movement_engine::read_answer(&answer(&request, payload, &case["check"]).to_string()).expect("an answer");
                    step = segment.answer(request.id, reply).expect("the answer is taken");
                }
            }
        };
        let rust = ending(&done);
        if rust == case["outcome"] {
            continue;
        }
        let shaped = rust["error"]["code"] == json!("MOVENG_UNSUPPORTED") && rust["error"]["message"].as_str().is_some_and(|m| m.contains("a value shaped like"));
        if shaped {
            loud += 1;
            if std::env::var("ORACLE_LOUD").is_ok() {
                println!("LOUD {} || {} || {}", rust["error"]["message"], case["outcome"], case["body"]);
            }
            continue;
        }
        differ.push(json!({ "version": version, "body": case["body"], "meta": movement_engine::env::json_of_js(&movement_engine::env::decode(payload).expect("a payload")), "typescript": case["outcome"], "rust": rust }));
    }
    let shown: Vec<String> = differ.iter().take(20).map(|d| d.to_string()).collect();
    assert!(differ.is_empty(), "{} of {} cases differ:\n{}", differ.len(), cases.len(), shown.join("\n"));
    assert!((loud as f64) <= LOUD_SHARE * cases.len() as f64, "{loud} of {} cases end in a shaped dict's loud refusal", cases.len());
}
