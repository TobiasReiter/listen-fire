//! `parallel` and `race` (chunk 7A Task 4): every program in
//! tests/oracle/parallel.json run on this engine as the TypeScript engine ran
//! it. The host is scripted by the TypeScript's run: of the requests this
//! engine has in flight, it answers the one the TypeScript asked next (each
//! adapter call, each cross-run lock taken, by name); the rest of the host
//! (the check, resolutions, the trace, the clock, a lock given back) is
//! answered as soon as it is asked. So a case passes only if this engine
//! can ask in the TypeScript's interleaving: an arm held back where the
//! TypeScript's ran on (a lock gate it does not share, a join it closes too
//! early) leaves the request the TypeScript asked next unasked, and the case
//! differs there. Ids are minted in the order creates are answered, so the
//! writes then come back in the order the TypeScript's write ledger hands
//! them back, each with the id its create was minted.
//!
//! The TypeScript's interleaving itself turns on how many microtasks each
//! of its layers takes between two requests, which this engine does not
//! reproduce, so the order a FIFO host would see is not compared: only that
//! this engine admits the TypeScript's order, and ends as it ended.

use std::collections::{HashMap, VecDeque};

use serde_json::{Value as Json, json};

use movement_engine::executor::{PendingRequest, Step};

/// Every object and list on the segment's wire, by its id, so a reference
/// (`["i", id]`) reads as what it names.
#[derive(Default)]
struct Sent(HashMap<u64, Json>);

impl Sent {
    fn register(&mut self, wire: &Json) {
        let Some(items) = wire.as_array() else { return };
        match items.first().and_then(Json::as_str) {
            Some("o") => {
                self.0.insert(items[1].as_u64().expect("an id"), wire.clone());
                for entry in items[2].as_array().expect("entries") {
                    self.register(&entry[1]);
                }
            }
            Some("l") => {
                self.0.insert(items[1].as_u64().expect("an id"), wire.clone());
                for item in items[2].as_array().expect("items") {
                    self.register(item);
                }
            }
            _ => {}
        }
    }

    /// A wire value as plain JSON (`undefined` as `null`).
    fn plain(&self, wire: &Json) -> Json {
        let Some(items) = wire.as_array() else { return wire.clone() };
        match items.first().and_then(Json::as_str) {
            Some("i") => self.plain(&self.0[&items[1].as_u64().expect("an id")]),
            Some("o") => Json::Object(items[2].as_array().expect("entries").iter().map(|e| (e[0].as_str().expect("a key").to_string(), self.plain(&e[1]))).collect()),
            Some("l") => Json::Array(items[2].as_array().expect("items").iter().map(|i| self.plain(i)).collect()),
            Some("u") => Json::Null,
            _ => wire.clone(),
        }
    }
}

struct Host<'o> {
    sent: Sent,
    check: &'o Json,
    created: usize,
    tokens: usize,
    next_id: u64,
    events: Vec<Json>,
    /// The id each create was minted, by its body and payload.
    minted: HashMap<String, String>,
}

impl Host<'_> {
    fn id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    /// What the oracle records of a request: an adapter call or a lock
    /// taken, as the TypeScript's fakes record it; `None` for the rest.
    fn event(&mut self, request: &PendingRequest) -> Option<Json> {
        self.sent.register(&request.args);
        match (request.family, request.method.as_str()) {
            ("locks", "acquire") => Some(json!(["acquire", request.args["names"]])),
            ("adapters", "call") => {
                let args = self.sent.plain(&request.args["args"]);
                match request.args["method"].as_str() {
                    Some("resolveEntity") => Some(json!(["resolveEntity", [field(&args["record"], "body"), field(&args["record"], "payload")]])),
                    Some("getRelated") => Some(json!(["getRelated", args["fieldId"]])),
                    Some("createRecord") => Some(json!(["createRecord", [field(&args["fields"], "body"), field(&args["fields"], "payload")]])),
                    _ => None,
                }
            }
            _ => None,
        }
    }

    fn answer(&mut self, request: &PendingRequest) -> Json {
        match (request.family, request.method.as_str()) {
            ("check", "program") => json!({ "value": self.check }),
            ("adapters", "resolve") => {
                let slug = request.args.get("adapterType").and_then(Json::as_str).unwrap_or_default();
                let methods = ["listEntryPoints", "describe", "resolveEntity", "getFieldValue", "getRelated", "createRecord", "updateRecord", "deleteRecord"];
                json!({ "value": { "instance": format!("i-{slug}"), "adapterType": slug, "methods": methods } })
            }
            ("control.cancel", _) => json!({ "value": false }),
            ("clock", "now") => json!({ "value": { "nowIso": "2026-01-01T00:00:00.000Z" } }),
            ("trace", "append") | ("log", "write") => json!({}),
            ("locks", "acquire") => {
                self.tokens += 1;
                json!({ "value": { "token": format!("t{}", self.tokens) } })
            }
            ("locks", "release") => json!({ "value": null }),
            ("adapters", "call") => {
                let result = self.call(request);
                self.sent.register(&result);
                json!({ "value": { "result": result } })
            }
            other => panic!("the oracle's programs ask nothing else: {other:?} {}", request.args),
        }
    }

    fn call(&mut self, request: &PendingRequest) -> Json {
        let args = self.sent.plain(&request.args["args"]);
        match request.args["method"].as_str() {
            Some("resolveEntity") => {
                let (o, l) = (self.id(), self.id());
                json!(["o", o, [["candidates", ["l", l, []]]]])
            }
            Some("getRelated") => {
                let l = self.id();
                json!(["l", l, []])
            }
            Some("createRecord") => {
                self.created += 1;
                self.minted.insert(json!([field(&args["fields"], "body"), field(&args["fields"], "payload")]).to_string(), format!("n{}", self.created));
                let (o, d) = (self.id(), self.id());
                json!(["o", o, [["adapterType", "kg"], ["externalId", format!("n{}", self.created)], ["data", ["o", d, []]]]])
            }
            Some("describe") => Json::Null,
            other => panic!("the oracle's adapter answers nothing else: {other:?} {}", request.args),
        }
    }
}

/// The arm a recorded request is one of: where its write is written (a
/// keyed write's `at`, else its body's name), `None` for a count or a lock.
fn arm_of(event: &Json) -> Option<String> {
    let [body, payload] = event.get(1)?.as_array()?.as_slice() else { return None };
    let at = payload.get("at").and_then(Json::as_str).or(body.as_str())?;
    Some(at.split('.').next().unwrap_or(at).to_string())
}

fn arms(events: &[Json]) -> Vec<String> {
    let mut arms: Vec<String> = events.iter().filter_map(arm_of).collect();
    arms.sort();
    arms.dedup();
    arms
}

fn of_arm(events: &[Json], arm: &str) -> Vec<Json> {
    events.iter().filter(|e| arm_of(e).as_deref() == Some(arm)).cloned().collect()
}

/// A keyed write's request, or a lock: what two arms racing for one key's
/// gate ask.
fn at_a_key_gate(event: &Json) -> bool {
    event.get(0).and_then(Json::as_str) == Some("acquire")
        || event.get(1).and_then(|e| e.get(1)).and_then(|p| p.get("at")).is_some()
}

/// Whether another arm's keyed write holds the key `next` waits for here:
/// begun (its search asked, or its search in flight) and not yet created;
/// or past its run's own gates, taking its cross-run lock (whose names do not
/// say the key: the key's gate is the run's own, taken before). For a lock
/// taken, any keyed write in progress.
fn key_held_by_another(next: &Json, asked: &[Json], in_flight: &[Json]) -> bool {
    if in_flight.iter().any(|e| e[0] == "acquire") {
        return true;
    }
    let keyed = |e: &Json| e.get(1).and_then(|e| e.get(1)).and_then(|p| p.get("at")).cloned().map(|at| (e[1][0].clone(), at));
    let created: Vec<_> = asked.iter().filter(|e| e[0] == "createRecord").filter_map(keyed).collect();
    let mut begun = asked.iter().chain(in_flight).filter(|e| e[0] == "resolveEntity").filter_map(keyed).filter(|w| !created.contains(w));
    match keyed(next) {
        Some((key, at)) => begun.any(|(k, a)| k == key && a != at),
        None => begun.next().is_some(),
    }
}

/// A record's field as the oracle's fakes record it (`?? null`).
fn field(record: &Json, name: &str) -> Json {
    record.get(name).cloned().unwrap_or(Json::Null)
}

/// The writes a segment's result hands back, as the oracle records them.
fn writes(done: &Json, sent: &Sent) -> Json {
    let result = &done["result"];
    let writes = sent.plain(result.get("writes").unwrap_or(&Json::Null));
    Json::Array(
        writes
            .as_array()
            .map(|ws| {
                ws.iter()
                    .map(|w| {
                        let values = &w["writtenValues"];
                        json!({
                            "externalId": w["externalId"],
                            "body": values.get("body").cloned().unwrap_or(Json::Null),
                            "payload": values.get("payload").cloned().unwrap_or(Json::Null),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    )
}

#[test]
fn parallel_arms_interleave_lock_and_order_their_writes_as_the_typescript_does() {
    let oracle: Json = serde_json::from_str(include_str!("oracle/parallel.json")).expect("parallel.json reads");
    let prelude = oracle["prelude"].as_str().expect("a prelude");
    let cases = oracle["cases"].as_array().expect("cases");
    let mut differ = Vec::new();
    let mut raced = 0;
    for case in cases {
        let source = prelude.replace("BODY", case["body"].as_str().expect("a body"));
        let event = json!(["o", 0, [["pipelineInputId", "p"], ["adapterType", "email"], ["triggerType", "webhook"], ["payload", ["o", 1, [["subject", "Acme"]]]]]]);
        let input = json!({
            "entry": "segment",
            "source": source,
            "languageVersion": 3,
            "segmentId": "g1",
            "serves": ["locks.acquire", "locks.release"],
            "now": "2026-01-01T00:00:00.000Z",
            "event": event,
            "catalog": oracle["catalog"],
            "credentialIds": { "inbox_cred": "cred-inbox_cred", "kg_cred": "cred-kg_cred" },
        });
        let mut host = Host { sent: Sent::default(), check: &case["check"], created: 0, tokens: 0, next_id: 990_000, events: Vec::new(), minted: HashMap::new() };
        host.sent.register(&event);
        let mut segment = movement_engine::begin(&input.to_string()).expect("the segment begins");
        let mut step = segment.start().expect("the segment starts");
        let expected: Vec<Json> = case["events"].as_array().expect("events").clone();
        // The TypeScript's requests not yet asked here, in its order.
        let mut remaining = expected.clone();
        let mut stalls = Vec::new();
        // What is in flight, each with what the oracle records of it.
        let mut waiting: VecDeque<(PendingRequest, Option<Json>)> = VecDeque::new();
        let done = loop {
            match step {
                Step::Done(done) => break Some(done),
                Step::Pending(pending) => {
                    for request in pending {
                        let event = host.event(&request);
                        waiting.push_back((request, event));
                    }
                    let rank = |event: &Json| remaining.iter().position(|e| e == event);
                    let at = waiting.iter().position(|(_, e)| e.is_none()).or_else(|| {
                        // The TypeScript's next request, if this engine has
                        // asked it; else, where two arms raced to one key's
                        // gate and the other won here, the in-flight request
                        // the TypeScript asked soonest.
                        waiting.iter().position(|(_, e)| e.as_ref() == remaining.first()).or_else(|| {
                            let soonest = waiting.iter().enumerate().filter_map(|(i, (_, e))| Some((rank(e.as_ref()?)?, i))).min()?;
                            let in_flight: Vec<Json> = waiting.iter().filter_map(|(_, e)| e.clone()).collect();
                            stalls.push(json!({
                                "typescriptNext": remaining.first(),
                                "answered": waiting[soonest.1].1,
                                "rival": remaining.first().is_some_and(|next| key_held_by_another(next, &host.events, &in_flight)),
                            }));
                            Some(soonest.1)
                        })
                    });
                    let Some(at) = at else { break None };
                    let (request, event) = waiting.remove(at).expect("in flight");
                    if let Some(event) = event {
                        let Some(index) = rank(&event) else { break None };
                        remaining.remove(index);
                        host.events.push(event);
                    }
                    let reply = movement_engine::read_answer(&host.answer(&request).to_string()).expect("an answer");
                    step = segment.answer(request.id, reply).expect("the answer is taken");
                }
            }
        };
        let (ended, written) = match &done {
            Some(done) if done.get("result").is_some() => (json!({ "completed": true }), writes(done, &host.sent)),
            Some(done) => (json!({ "unexpected": done }), Json::Null),
            None => (json!({ "stuck": { "asked": waiting.iter().map(|(_, e)| e.clone()).collect::<Vec<_>>(), "typescriptNext": remaining.first() } }), Json::Null),
        };
        let mut problems = Vec::new();
        if ended != case["outcome"] {
            problems.push(json!({ "outcome": ended }));
        }
        // Every request the TypeScript made, and no other.
        if !remaining.is_empty() {
            problems.push(json!({ "unasked": remaining }));
        }
        // Each arm asked what it asks in the TypeScript's order.
        for arm in arms(&expected) {
            let (ts, rust) = (of_arm(&expected, &arm), of_arm(&host.events, &arm));
            if ts != rust {
                problems.push(json!({ "arm": arm, "typescript": ts, "rust": rust }));
            }
        }
        // Only where the TypeScript's next request waits at a key's gate,
        // which another arm took first here, may the order differ.
        for stall in &stalls {
            if !at_a_key_gate(&stall["typescriptNext"]) || stall["rival"] != json!(true) {
                problems.push(json!({ "stall": stall }));
            }
        }
        // The writes in the write ledger's order; each with the id its own
        // create was minted (the same ids as the TypeScript's where the run
        // asked in its order throughout).
        if written != Json::Null {
            let unminted = |ws: &Json| Json::Array(ws.as_array().into_iter().flatten().map(|w| json!({ "body": w["body"], "payload": w["payload"] })).collect());
            if unminted(&written) != unminted(&case["writes"]) || (stalls.is_empty() && written != case["writes"]) {
                problems.push(json!({ "writes": written, "typescript": case["writes"] }));
            }
            for w in written.as_array().into_iter().flatten() {
                if host.minted.get(&json!([w["body"], w["payload"]]).to_string()) != w["externalId"].as_str().map(str::to_string).as_ref() {
                    problems.push(json!({ "citation": w, "minted": host.minted.get(&json!([w["body"], w["payload"]]).to_string()), "written": written }));
                }
            }
        }
        raced += usize::from(!stalls.is_empty());
        if !problems.is_empty() {
            differ.push(json!({ "body": case["body"], "problems": problems, "typescript": expected, "rust": host.events }));
        }
    }
    if let Ok(path) = std::env::var("ORACLE_DUMP") {
        std::fs::write(path, differ.iter().map(|d| d.to_string()).collect::<Vec<_>>().join("\n")).expect("the dump writes");
    }
    let shown: Vec<String> = differ.iter().take(5).map(|d| d.to_string()).collect();
    assert!(differ.is_empty(), "{} of {} cases differ:\n{}", differ.len(), cases.len(), shown.join("\n"));
    println!("{} cases, {raced} with two arms racing for one key's gate", cases.len());
}
