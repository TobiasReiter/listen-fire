//! Language version 4's write handles (PLAN-07A Task 4c): every program in
//! tests/oracle/handles.json run on this engine as the TypeScript engine ran
//! it, against the same CRM. A write that found a record keeps it as found
//! (a field the write did not set reads it) and reaches it through
//! `-[:@old]->`, whatever found it: `unique by`, or the CRM's own rule (the
//! world's `finds: "always"`, every company whatever was asserted); a
//! rehearsed write that found one meets itself there; `write h { … }` moves
//! `h` on to the updated record in place, its `@old` the handle as it stood;
//! a named match binds absent on a miss and the block carries on, a judge
//! outage leaving its warning.
//!
//! The host here is the CRM the TypeScript's fake is: it matches, reads back,
//! creates and updates as the case's world says, and its writes through the
//! rehearsing instance are the host's rehearsal's (captured, never made: a
//! create's id from the test host's rehearsal sequence, an update's
//! association `none`), so the CRM never sees them. A case compares every
//! call the CRM received, the run's writes (each record as the result hands
//! it back), the trace, the parked state byte for byte, and how the run
//! ended.

use std::collections::HashMap;

use serde_json::{Value as Json, json};

use movement_engine::executor::{PendingRequest, Step};

/// What the segment's wire has carried, by the id the wire gave each object
/// and list, so a reference (`["i", id]`) reads as what it names.
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

    fn resolve<'s>(&'s self, wire: &'s Json) -> &'s Json {
        match wire.as_array().map(Vec::as_slice) {
            // A reference to an object sent before (`i`), or a back-reference
            // to one earlier in the same value (`r`): the very object again.
            Some([tag, id]) if tag == "i" || tag == "r" => self.resolve(&self.0[&id.as_u64().expect("an id")]),
            _ => wire,
        }
    }

    /// A wire value as JSON writes it (`JSON.parse(JSON.stringify(v))`): an
    /// `undefined` member left out, an `undefined` item null.
    fn plain(&self, wire: &Json) -> Json {
        let wire = self.resolve(wire);
        let Some(items) = wire.as_array() else { return integral(wire) };
        match items.first().and_then(Json::as_str) {
            Some("o") => Json::Object(
                items[2]
                    .as_array()
                    .expect("entries")
                    .iter()
                    .filter(|e| self.resolve(&e[1]) != &json!(["u"]))
                    .map(|e| (e[0].as_str().expect("a key").to_string(), self.plain(&e[1])))
                    .collect(),
            ),
            Some("l") => Json::Array(items[2].as_array().expect("items").iter().map(|i| self.plain(i)).collect()),
            Some("u") | Some("n") => Json::Null,
            _ => integral(wire),
        }
    }

    /// A wire value as `JSON.stringify` writes it, its keys in the order
    /// the wire carried them.
    fn text(&self, wire: &Json) -> String {
        let wire = self.resolve(wire);
        if let Some(n) = wire.as_f64() {
            return movement_engine::js::number_to_string(n);
        }
        let Some(items) = wire.as_array() else { return serde_json::to_string(wire).expect("JSON") };
        match items.first().and_then(Json::as_str) {
            Some("o") => {
                let members: Vec<String> = items[2]
                    .as_array()
                    .expect("entries")
                    .iter()
                    .filter(|e| self.resolve(&e[1]) != &json!(["u"]))
                    .map(|e| format!("{}:{}", serde_json::to_string(&e[0]).expect("a key"), self.text(&e[1])))
                    .collect();
                format!("{{{}}}", members.join(","))
            }
            Some("l") => format!("[{}]", items[2].as_array().expect("items").iter().map(|i| self.text(i)).collect::<Vec<_>>().join(",")),
            Some("u") | Some("n") => "null".into(),
            _ => serde_json::to_string(wire).expect("JSON"),
        }
    }

    fn member<'s>(&'s self, object: &'s Json, key: &str) -> Option<&'s Json> {
        let object = self.resolve(object).as_array()?;
        if object.first()? != "o" {
            return None;
        }
        object[2].as_array()?.iter().find(|e| e[0] == json!(key)).map(|e| self.resolve(&e[1]))
    }
}

/// A number as JSON writes it: an integral one without a fraction.
fn integral(value: &Json) -> Json {
    match value.as_f64() {
        Some(n) if value.is_f64() && n.fract() == 0.0 && n.abs() < 9.0e15 => json!(n as i64),
        _ => value.clone(),
    }
}

/// One company the CRM holds: its id and its fields, in order.
struct Company {
    id: String,
    data: Vec<(String, Json)>,
}

struct Host<'o> {
    sent: Sent,
    world: &'o Json,
    /// The TypeScript's check answer; none when the engine checks natively.
    check: Option<&'o Json>,
    companies: Vec<Company>,
    /// Every instance the engine resolved, by id: whether it rehearses.
    instances: Vec<bool>,
    created: usize,
    rehearsed: usize,
    next_id: u64,
    positions: HashMap<u64, Json>,
    calls: Vec<Json>,
    trace: Vec<Json>,
    parked: Vec<Json>,
}

impl Host<'_> {
    fn id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn object(&mut self, members: Vec<(&str, Json)>) -> Json {
        let id = self.id();
        json!(["o", id, members.into_iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>()])
    }

    fn list(&mut self, items: Vec<Json>) -> Json {
        let id = self.id();
        json!(["l", id, items])
    }

    fn data(&mut self, data: &[(String, Json)]) -> Json {
        let members = data.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
        self.object(members)
    }

    fn reads(&self) -> bool {
        self.world["reads"] == json!(true)
    }

    fn answer(&mut self, request: &PendingRequest) -> Json {
        match (request.family, request.method.as_str()) {
            ("check", "program") => json!({ "value": self.check.expect("a native check asks the host for none") }),
            ("adapters", "resolve") => {
                let slug = request.args["adapterType"].as_str().expect("a slug").to_string();
                let dry = request.args.get("dryRun") == Some(&json!(true));
                self.instances.push(dry);
                let mut methods = vec!["listEntryPoints", "describe", "resolveEntity", "getFieldValue", "getRelated", "createRecord", "updateRecord", "deleteRecord"];
                if slug == "attio" && self.reads() {
                    methods.push("readRecord");
                }
                json!({ "value": { "instance": format!("i{}", self.instances.len() - 1), "adapterType": slug, "methods": methods } })
            }
            ("control.cancel", _) => json!({ "value": false }),
            ("clock", "now") => json!({ "value": { "nowIso": "2026-01-01T00:00:00.000Z" } }),
            ("trace", "append") => {
                self.sent.register(&request.args["entries"]);
                if let Json::Array(entries) = self.sent.plain(&request.args["entries"]) {
                    self.trace.extend(entries);
                }
                json!({})
            }
            ("log", "write") => json!({}),
            ("locks", "acquire") => {
                let token = self.id();
                json!({ "value": { "token": format!("t{token}") } })
            }
            ("locks", "release") => json!({ "value": null }),
            ("park.sink", "commitTimerPark") => {
                self.sent.register(&request.args["state"]);
                let state = self.sent.text(&request.args["state"]);
                self.parked.push(json!({ "address": request.args["address"], "state": state, "wakeAt": request.args["wakeAt"] }));
                json!({ "value": null })
            }
            ("llm", "arbitrateEntities") => match &self.world["judge"] {
                Json::String(outage) if outage == "outage" => json!({ "value": { "index": null, "judgeUnavailable": "anthropic 529", "cost": [] } }),
                index => json!({ "value": { "index": index, "cost": [] } }),
            },
            ("adapters", "call") => {
                let result = self.call(request);
                self.sent.register(&result);
                json!({ "value": { "result": result } })
            }
            other => panic!("the oracle's programs ask nothing else: {other:?} {}", request.args),
        }
    }

    fn call(&mut self, request: &PendingRequest) -> Json {
        self.sent.register(&request.args["args"]);
        if let Some(reference) = request.args.get("positionRef").and_then(Json::as_u64)
            && let Some(position) = request.args.get("position")
        {
            self.sent.register(position);
            self.positions.insert(reference, position.clone());
        }
        let instance = request.args["instance"].as_str().expect("an instance");
        let index: usize = instance.trim_start_matches('i').parse().expect("an instance id");
        let dry = self.instances[index];
        let args = self.sent.plain(&request.args["args"]);
        match request.args["method"].as_str().expect("a method") {
            "describe" => Json::Null,
            "getFieldValue" => {
                let position = request.args.get("positionRef").and_then(Json::as_u64).map(|r| self.positions[&r].clone()).expect("a read names its position");
                let field = args["fieldId"].as_str().expect("a field").to_string();
                let data = self.sent.member(&position, "identity").and_then(|identity| self.sent.member(identity, "data"));
                match data.and_then(|data| self.sent.member(data, &field)) {
                    Some(value) if value != &json!(["u"]) => value.clone(),
                    _ => Json::Null,
                }
            }
            "resolveEntity" => {
                self.calls.push(json!(["resolveEntity", args["recordType"], args["record"]]));
                let mut candidates = Vec::new();
                if args["recordType"] == "company" {
                    let always = self.world["finds"] == "always";
                    let found: Vec<(String, Vec<(String, Json)>)> = self
                        .companies
                        .iter()
                        .filter(|c| always || c.data.iter().any(|(k, v)| k == "name" && *v == args["record"]["name"]))
                        .map(|c| (c.id.clone(), c.data.clone()))
                        .collect();
                    for (id, data) in found {
                        let data = self.data(&data);
                        candidates.push(self.object(vec![("adapterType", json!("attio")), ("externalId", json!(id)), ("data", data)]));
                    }
                }
                let candidates = self.list(candidates);
                self.object(vec![("candidates", candidates)])
            }
            "readRecord" => {
                self.calls.push(json!(["readRecord", args["externalId"], args.get("fieldIds").cloned().unwrap_or(Json::Null)]));
                let id = args["externalId"].as_str().expect("an id");
                match self.companies.iter().find(|c| c.id == id).map(|c| c.data.clone()) {
                    Some(data) => self.data(&data),
                    None => Json::Null,
                }
            }
            "getRelated" => {
                self.calls.push(json!(["getRelated", args["fieldId"]]));
                if args["fieldId"] != "companies" {
                    return self.list(Vec::new());
                }
                let companies: Vec<(String, Vec<(String, Json)>)> = self.companies.iter().map(|c| (c.id.clone(), c.data.clone())).collect();
                let mut items = Vec::new();
                for (id, data) in companies {
                    let data = self.data(&data);
                    let identity = self.object(vec![("kind", json!("stable")), ("recordId", json!(id)), ("data", data)]);
                    let position = self.object(vec![("adapterType", json!("attio")), ("recordType", json!("company")), ("identity", identity)]);
                    items.push(self.object(vec![("position", position)]));
                }
                self.list(items)
            }
            // The host's rehearsal captures a rehearsed write: a create is
            // answered with the next of its own ids, an update as the write
            // it captured would have been.
            "createRecord" if dry => {
                self.rehearsed += 1;
                let id = format!("00000001-0000-4000-8000-{:012x}", self.rehearsed);
                let data = self.object(Vec::new());
                self.object(vec![("adapterType", json!("attio")), ("externalId", json!(id)), ("data", data)])
            }
            "updateRecord" if dry => {
                let data = self.object(Vec::new());
                self.object(vec![("adapterType", json!("attio")), ("externalId", args["externalId"].clone()), ("data", data), ("association", json!("none"))])
            }
            "createRecord" => {
                let mut call = vec![json!("createRecord"), args["recordType"].clone(), args["fields"].clone()];
                if let Some(links) = args.get("parentLinks").filter(|l| l.as_array().is_some_and(|l| !l.is_empty())) {
                    call.push(links.clone());
                }
                self.calls.push(Json::Array(call));
                self.created += 1;
                let id = format!("ext-{}", self.created);
                let data = self.object(Vec::new());
                self.object(vec![("adapterType", json!("attio")), ("externalId", json!(id)), ("data", data)])
            }
            "updateRecord" => {
                self.calls.push(json!(["updateRecord", args["externalId"], args["fields"]]));
                let id = args["externalId"].as_str().expect("an id").to_string();
                if let (Some(company), Json::Object(fields)) = (self.companies.iter_mut().find(|c| c.id == id), &args["fields"]) {
                    // `Object.assign` in the fields' order.
                    let wire_fields = self.sent.member(&request.args["args"], "fields").cloned().unwrap_or(Json::Null);
                    let order: Vec<String> = wire_fields.as_array().and_then(|o| o.get(2)).and_then(Json::as_array).map(|e| e.iter().filter_map(|e| e[0].as_str().map(String::from)).collect()).unwrap_or_default();
                    for key in order {
                        let value = fields[&key].clone();
                        match company.data.iter_mut().find(|(k, _)| *k == key) {
                            Some(slot) => slot.1 = value,
                            None => company.data.push((key, value)),
                        }
                    }
                }
                let data = self.object(Vec::new());
                self.object(vec![("adapterType", json!("attio")), ("externalId", json!(id)), ("data", data), ("association", json!("none"))])
            }
            other => panic!("the oracle's CRM answers nothing else: {other} {}", request.args),
        }
    }
}

/// How the segment ended, as the TypeScript's run ended.
fn ending(done: &Json) -> Json {
    if let Some(result) = done.get("result") {
        return json!({ "completed": true, "parked": result.get("parked") == Some(&json!(true)) });
    }
    let error = done.get("thrown").or_else(|| done.get("failed").map(|f| &f["error"]));
    match error {
        Some(error) => json!({ "error": { "code": error.get("code").cloned().unwrap_or(Json::Null), "message": error.get("message").cloned().unwrap_or(Json::Null) } }),
        None => json!({ "unexpected": done }),
    }
}

#[test]
fn version_4_handles_read_find_and_park_as_the_typescript_does() {
    run_handles(false);
}

/// The same cases with the engine's own check (`nativeCheck`), the host
/// never asked for one.
#[test]
fn version_4_handles_read_find_and_park_on_the_native_check() {
    run_handles(true);
}

fn run_handles(native: bool) {
    let oracle: Json = serde_json::from_str(include_str!("oracle/handles.json")).expect("handles.json reads");
    let prelude = oracle["prelude"].as_str().expect("a prelude");
    let cases = oracle["cases"].as_array().expect("cases");
    let mut differ = Vec::new();
    let mut tally: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for case in cases {
        let source = prelude.replace("BODY", case["body"].as_str().expect("a body"));
        let event = json!(["o", 0, [["pipelineInputId", "p"], ["adapterType", "email"], ["triggerType", "webhook"], ["payload", ["o", 1, [["subject", "Acme"]]]]]]);
        let input = json!({
            "entry": "segment",
            "source": source,
            "languageVersion": 4,
            "segmentId": "g1",
            "serves": ["park.sink.commitTimerPark"],
            "now": "2026-01-01T00:00:00.000Z",
            "event": event,
            "catalog": oracle["catalog"],
            "credentialIds": { "inbox_cred": "cred-inbox_cred", "acme_main": "cred-acme_main" },
            "nativeCheck": native,
        });
        let companies = oracle["companies"]
            .as_array()
            .expect("companies")
            .iter()
            .map(|c| Company {
                id: c["externalId"].as_str().expect("an id").to_string(),
                data: vec![("name".to_string(), c["data"]["name"].clone()), ("domain".to_string(), c["data"]["domain"].clone())],
            })
            .collect();
        let mut host = Host {
            sent: Sent::default(),
            world: &case["world"],
            check: (!native).then_some(&case["check"]),
            companies,
            instances: Vec::new(),
            created: 0,
            rehearsed: 0,
            next_id: 990_000,
            positions: HashMap::new(),
            calls: Vec::new(),
            trace: Vec::new(),
            parked: Vec::new(),
        };
        host.sent.register(&event);
        let mut segment = movement_engine::begin(&input.to_string()).expect("the segment begins");
        let mut step = segment.start().expect("the segment starts");
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
        let outcome = ending(&done);
        if outcome.get("unexpected").is_some() {
            *tally.entry(format!("{}", done.get("refused").cloned().unwrap_or(Json::Null))).or_default() += 1;
            continue;
        }
        let writes = match done.get("result") {
            Some(result) => {
                host.sent.register(&result["writes"]);
                host.sent.plain(&result["writes"])
            }
            None => Json::Null,
        };
        let rust = json!({ "calls": host.calls, "writes": writes, "trace": host.trace, "parked": host.parked, "outcome": outcome });
        let typescript = json!({ "calls": case["calls"], "writes": case["writes"], "trace": case["trace"], "parked": case["parked"], "outcome": case["outcome"] });
        if rust != typescript {
            let first = ["calls", "writes", "trace", "parked", "outcome"].into_iter().find(|k| rust[k] != typescript[k]);
            differ.push(json!({ "body": case["body"], "world": case["world"], "first": first, "typescript": typescript, "rust": rust }));
        }
    }
    if let Ok(path) = std::env::var("ORACLE_DUMP") {
        std::fs::write(path, differ.iter().map(|d| d.to_string()).collect::<Vec<_>>().join("\n")).expect("the dump writes");
    }
    let shown: Vec<String> = differ.iter().take(3).map(|d| d.to_string()).collect();
    assert!(tally.is_empty(), "cases this engine did not run: {tally:?}");
    assert!(differ.is_empty(), "{} of {} cases differ:\n{}", differ.len(), cases.len(), shown.join("\n"));
    println!("{} cases", cases.len());
}
