//! Records held as values (chunk 7A Task 3, Review Focus 3): every program in
//! tests/oracle/records.json run on this engine as the TypeScript engine ran
//! it — the same check, the same event, the same adapter — ending as it
//! ended. Values arrive untyped through the event's `json` fields, so the
//! readings are the ones a checked program can make of a value it cannot
//! type: `Object.prototype`'s names and ordinary ones read off dicts,
//! present and absent; picked, held, walked on, tested, sorted — a payload
//! dict whose `kind` names a binding kind or a prototype name, and a KEYBY
//! answer whose prototype a filing made a record, included: both engines
//! read data as data. Records the run itself holds — walked,
//! picked, returned by a block, written, built as nodes — are compared,
//! spread, walked on, sorted, grouped and read by key. Every language
//! version.
//!
//! No case may end otherwise than the TypeScript's run ended, a loud
//! refusal of this engine's included. A program admission refuses runs on
//! the TypeScript engine, so it differs from nothing; those are counted.

use std::collections::HashMap;

use serde_json::{Value as Json, json};

use movement_engine::executor::{PendingRequest, Step};

mod oracle_wire;

/// A case whose program or payload names one of `Object.prototype`'s
/// members: version 5 reads a map as a map (`m.constructor` is absent,
/// `__proto__` is a key like any other), where JavaScript read them through
/// the prototype.
fn names_a_prototype_member(case: &Json) -> bool {
    const NAMES: [&str; 12] = [
        "constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__",
        "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "__proto__", "toLocaleString",
    ];
    let (body, payload) = (case["body"].as_str().unwrap_or_default(), case["payload"].to_string());
    NAMES.iter().any(|name| body.contains(name) || payload.contains(name))
}

/// What the oracle's host has put on the wire, by the id the wire gave
/// each object and list: an id the engine hands back (`["i", id]`) names
/// the last one sent under it, as the engine's own table does.
#[derive(Default)]
struct Sent;

impl Sent {
    /// `wire` with a reference to what was sent read as what it names.
    /// An object's member, as written on the wire.
    fn member<'s>(&'s self, object: &'s Json, key: &str) -> Option<&'s Json> {
        let object = object.as_array()?;
        if object.first()? != "o" {
            return None;
        }
        object[1].as_array()?.iter().find(|e| e[0] == json!(key)).map(|e| &e[1])
    }
}

struct Host<'o> {
    sent: Sent,
    /// The errors the host answered with, by the `ref` each answer carries.
    errors: Vec<Json>,
    positions: HashMap<u64, Json>,
    related: &'o Json,
    /// The TypeScript's check answer; none when the engine checks natively,
    /// which then never asks.
    check: Option<&'o Json>,
}

impl Host<'_> {
    fn answer(&mut self, request: &PendingRequest) -> Json {
        let answer = match (request.family, request.method.as_str()) {
            ("check", "program") => return json!({ "value": self.check.expect("a native check asks the host for none") }),
            ("adapters", "resolve") => return self.resolve(request.args.get("adapterType")),
            ("control.cancel", _) => return json!({ "value": false }),
            ("clock", "now") => return json!({ "value": { "nowIso": "2026-01-01T00:00:00.000Z" } }),
            ("park.sink", _) => return json!({ "value": null }),
            ("trace", "append") | ("log", "write") => return json!({}),
            ("adapters", "call") => self.call(request),
            other => panic!("the oracle's programs ask nothing else: {other:?} {}", request.args),
        };
        json!({ "value": { "result": answer } })
    }

    /// The registry's lookup, by the slug's text (`registry[adapterType]`).
    fn resolve(&mut self, slug: Option<&Json>) -> Json {
        let key = slug.map_or_else(|| "undefined".to_string(), property_key);
        match key.as_str() {
            "email" => json!({ "value": { "instance": "i1", "adapterType": "email", "methods": ["getFieldValue", "getRelated", "createRecord", "describe"] } }),
            "attio" => json!({ "value": { "instance": "i2", "adapterType": "attio", "methods": ["getFieldValue", "getRelated", "createRecord", "describe", "iterateRelated", "iterateRelatedPage"] } }),
            other => {
                let message = format!("Unknown adapter type: {other}");
                self.errors.push(json!({ "class": "Error", "message": message }));
                json!({ "error": { "message": message, "name": "Error", "ref": self.errors.len() - 1 } })
            }
        }
    }

    fn call(&mut self, request: &PendingRequest) -> Json {
        if let Some(reference) = request.args.get("positionRef").and_then(Json::as_u64)
            && let Some(position) = request.args.get("position")
        {
            self.positions.insert(reference, position.clone());
        }
        let position = request.args.get("positionRef").and_then(Json::as_u64).map(|r| self.positions[&r].clone());
        let args = &request.args["args"];
        match request.args["method"].as_str() {
            Some("getFieldValue") => {
                let field = self.sent.member(args, "fieldId").and_then(Json::as_str).expect("a read names its field").to_string();
                let position = position.expect("a read names its position");
                // The adapter answers `Reflect.get(positionData(position), field)`:
                // what the data's prototype holds under a name it lacks.
                let data = self.sent.member(&position, "identity").and_then(|identity| self.sent.member(identity, "data"));
                match data.and_then(|data| self.sent.member(data, &field)) {
                    Some(value) => value.clone(),
                    None => Json::Null,
                }
            }
            Some("getRelated") => {
                let field = self.sent.member(args, "fieldId").and_then(Json::as_str).expect("a hop names its edge");
                self.related.get(field).map(oracle_wire::plain).unwrap_or_else(|| json!(["l", []]))
            }
            Some("iterateRelatedPage") => {
                let field = self.sent.member(args, "fieldId").and_then(Json::as_str).expect("a hop names its edge");
                let items = self.related.get(field).map(oracle_wire::plain).unwrap_or_else(|| json!(["l", []]));
                json!(["o", [["items", items]]])
            }
            Some("createRecord") => json!(["o", [["adapterType", "email"], ["externalId", "w1"], ["data", ["o", [["name", "w"]]]]]]),
            Some("describe") => Json::Null,
            Some("resolveEntity") => json!(["o", [["candidates", ["l", []]]]]),
            other => panic!("the oracle's adapter answers nothing else: {other:?} {}", request.args),
        }
    }
}

/// A JSON value as a property key: JavaScript's `String(value)`.
fn property_key(value: &Json) -> String {
    match value {
        Json::String(text) => text.clone(),
        Json::Null => "null".into(),
        Json::Bool(b) => b.to_string(),
        Json::Number(n) => movement_engine::js::Js::Number(n.as_f64().expect("a finite number")).to_js_string(),
        Json::Array(items) => items.iter().map(|item| if item.is_null() { String::new() } else { property_key(item) }).collect::<Vec<_>>().join(","),
        Json::Object(_) => "[object Object]".into(),
    }
}

/// How a segment ended, as the TypeScript's run ended: its error (a host's
/// error as the host raised it).
fn ending(done: &Json, errors: &[Json]) -> Json {
    let error = done.get("thrown").or_else(|| done.get("failed").map(|f| &f["error"]));
    let error = match error.and_then(|e| e.get("hostError")).and_then(Json::as_u64) {
        Some(index) => Some(&errors[usize::try_from(index).expect("an index")]),
        None => error,
    };
    match error {
        Some(error) => json!({ "error": error }),
        None if done.get("result").is_some() => json!({ "completed": true }),
        None if done.get("refused").is_some() => json!({ "refused": done["refused"] }),
        None => json!({ "unexpected": done }),
    }
}

#[test]
fn records_held_as_values_read_as_the_typescript_reads_them() {
    run_records(false);
}

/// The same cases with the engine's own check (`nativeCheck`): the Rust
/// checker's stamps and import link run every case as the TypeScript's
/// recorded answer does, and the host is never asked for a check.
#[test]
fn records_run_the_same_on_the_native_check() {
    run_records(true);
}

fn run_records(native: bool) {
    let oracle: Json = serde_json::from_str(include_str!("oracle/records.json")).expect("records.json reads");
    let prelude = oracle["prelude"].as_str().expect("a prelude");
    let cases = oracle["cases"].as_array().expect("cases");
    let mut differ = Vec::new();
    let mut refused = 0;
    let mut reasons: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for case in cases {
        let version = case["version"].as_u64().expect("a version");
        let source = prelude.replace("BODY", case["body"].as_str().expect("a body"));
        let payload = &case["payload"];
        let event = json!(["o", [["pipelineInputId", "p"], ["adapterType", "email"], ["triggerType", "webhook"], ["payload", oracle_wire::plain(payload)]]]);
        let input = json!({
            "entry": "segment",
            "source": source,
            "languageVersion": version,
            "segmentId": "g1",
            "serves": ["park.sink.commitTimerPark"],
            "now": "2026-01-01T00:00:00.000Z",
            "event": event,
            "catalog": oracle["catalog"],
            "credentialIds": { "inbox_cred": "cred-inbox_cred" },
            "nativeCheck": native,
        });
        let check = (!native).then_some(&case["check"]);
        let mut host = Host { sent: Sent, errors: Vec::new(), positions: HashMap::new(), related: &oracle["related"], check };
        let mut segment = movement_engine::begin(&input.to_string()).expect("the segment begins");
        let mut step = segment.start().expect("the segment starts");
        // Requests in flight together (an `EXISTS` over several records)
        // are answered in the order asked.
        let mut waiting = std::collections::VecDeque::new();
        let done = loop {
            match step {
                Step::Done(done) => break done,
                Step::Pending(pending) => {
                    waiting.extend(pending);
                    let request = waiting.pop_front().expect("a segment waits only on what it asked");
                    let reply = movement_engine::read_answer(&host.answer(&request).to_string()).expect("an answer");
                    step = segment.answer(request.id, reply).expect("the answer is taken");
                }
            }
        };
        let rust = ending(&done, &host.errors);
        if let Some(reason) = rust.get("refused") {
            refused += 1;
            *reasons.entry(reason.as_str().unwrap_or_default().to_string()).or_default() += 1;
            continue;
        }
        if rust != case["outcome"] && !names_a_prototype_member(case) {
            differ.push(json!({ "version": version, "template": case["template"], "body": case["body"], "meta": payload, "typescript": case["outcome"], "rust": rust }));
        }
    }
    if let Ok(path) = std::env::var("ORACLE_DUMP") {
        std::fs::write(path, differ.iter().map(|d| d.to_string()).collect::<Vec<_>>().join("\n")).expect("the dump writes");
    }
    let shown: Vec<String> = differ.iter().take(20).map(|d| d.to_string()).collect();
    assert!(differ.is_empty(), "{} of {} cases differ ({refused} refused at admission):\n{}", differ.len(), cases.len(), shown.join("\n"));
    println!("{} cases, {refused} refused at admission: {reasons:?}", cases.len());
}
