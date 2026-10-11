//! `parallel` and `race` (chunk 7A Task 4): every program in
//! tests/oracle/parallel.json run on this engine as the TypeScript engine ran
//! it. Both runs had the same scheduled host: the adapter's calls and the
//! cross-run locks are answered one at a time, and the run goes as far as it
//! can before the next: the oldest step's request first, and among the
//! requests one step let several flows ask, the least by its text (which of
//! them reached the host first turns on the TypeScript's microtasks). Here,
//! everything else the host
//! serves is answered as soon as it is asked, as the TypeScript's in-process
//! host answers it). So the two runs must ask the same requests in the same
//! order: an arm held back where the TypeScript's ran on (a lock gate it does
//! not share, a join it closes too early), or let through where it waited,
//! asks out of turn. A lock taken carries what its flow asked next (the only
//! flow the answer lets run), so which arm took it, and for which key, is
//! compared too. Ids are minted in the order creates are answered, and the
//! writes come back in the order the TypeScript's write ledger hands them
//! back, each with its id.

use std::collections::HashMap;

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
                    Some("resolveEntity") => Some(json!(["resolveEntity", [field(&args["record"], "body"), field(&args["record"], "payload"), field(&args["record"], "tag")]])),
                    Some("getRelated") => Some(json!(["getRelated", args["fieldId"], tag_of(&args["where"])])),
                    Some("createRecord") => Some(json!(["createRecord", [field(&args["fields"], "body"), field(&args["fields"], "payload"), field(&args["fields"], "tag")]])),
                    Some("updateRecord") => Some(json!(["updateRecord", [args["externalId"], field(&args["fields"], "body")]])),
                    Some("linkRecords") => Some(json!(["linkRecords", [args["from"]["externalId"], args["edgeName"], args["to"]["externalId"]]])),
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
                let methods = ["listEntryPoints", "describe", "resolveEntity", "getFieldValue", "getRelated", "createRecord", "updateRecord", "deleteRecord", "linkRecords"];
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
            Some("updateRecord") => {
                let (o, d) = (self.id(), self.id());
                json!(["o", o, [["adapterType", "kg"], ["externalId", args["externalId"]], ["data", ["o", d, []]], ["association", "none"]]])
            }
            Some("linkRecords") => {
                let o = self.id();
                json!(["o", o, [["created", true]]])
            }
            Some("describe") => Json::Null,
            other => panic!("the oracle's adapter answers nothing else: {other:?} {}", request.args),
        }
    }
}

/// Two arms one step let run reaching one in-run gate in modes that
/// exclude each other: the TypeScript's flows reach it in the order their
/// layers' microtasks let them, this engine's in arm order, so each engine
/// may let the other arm in first. Where the runs first differ (one of them
/// at a lock taken), the first lock of that name each then took is by a
/// different arm, for writes the gate keeps apart; each lock names the
/// request its flow asked next.
fn a_gate_race(typescript: &[Json], rust: &[Json]) -> bool {
    let is_lock = |e: &Json| e[0] == "acquire";
    if !typescript.first().is_some_and(is_lock) && !rust.first().is_some_and(is_lock) {
        return false;
    }
    let Some(names) = typescript.iter().chain(rust).find(|e| is_lock(e)).map(|e| e[1].clone()) else { return false };
    let first = |events: &[Json]| events.iter().find(|e| is_lock(e) && e[1] == names).cloned();
    let (Some(t), Some(r)) = (first(typescript), first(rust)) else { return false };
    let (a, b) = (&t[2], &r[2]);
    if arm_of(a).is_none() || arm_of(a) == arm_of(b) {
        return false;
    }
    let name = names[0].as_str().unwrap_or_default();
    if !name.starts_with("identity ") {
        // A record's or an edge's lock: exclusive, one name.
        return true;
    }
    // The type lock: FUZZY takes it exclusive; two key-set groups share it
    // only among themselves; one group shares it, but a key is exclusive.
    let (body_a, body_b) = (a[1][0].as_str().unwrap_or_default(), b[1][0].as_str().unwrap_or_default());
    let fuzzy = |body: &str| body.starts_with('f');
    let group = |w: &Json| !w[1][2].is_null();
    fuzzy(body_a) || fuzzy(body_b) || group(a) != group(b) || body_a == body_b
}

/// Two flows one step let run asking the very same lock (the same names):
/// the requests are one text, so no host can tell them apart, and each
/// engine may answer the other's first. The two locks taken next are the
/// same pair, for the same two requests.
fn twin_locks(typescript: &[Json], rust: &[Json]) -> bool {
    let [t0, t1, ..] = typescript else { return false };
    let [r0, r1, ..] = rust else { return false };
    let lock = |e: &Json| (e[0] == "acquire").then(|| e[1].clone());
    let names = lock(t0);
    names.is_some() && [t1, r0, r1].iter().all(|e| lock(e) == names) && t0[2] == r1[2] && t1[2] == r0[2] && t0[2] != t1[2]
}

/// Where two engines let different arms through a gate first, what must
/// still hold: every request asked, and no other; each arm's own requests
/// in order, its counts and its links from its own record included; what
/// the movement asks after the combinator after every request the arms
/// asked before it (the same requests on either side of it); the writes in
/// the ledger's order (their ids follow the order creates were answered,
/// so not those); the ending.
fn race_problems(typescript: &[Json], rust: &[Json], ts_writes: &Json, rust_writes: &Json, ended: &Json, ts_ended: &Json) -> Vec<Json> {
    let mut problems = Vec::new();
    if ended != ts_ended {
        problems.push(json!({ "outcome": ended }));
    }
    let sorted = |events: &[Json]| {
        let mut texts: Vec<String> = events.iter().map(Json::to_string).collect();
        texts.sort();
        texts
    };
    if sorted(typescript) != sorted(rust) {
        problems.push(json!("not the same requests"));
    }
    // The combinator's continuation: its first request is the write after it.
    let after = |events: &[Json]| events.iter().position(|e| e[0] == "createRecord" && e[1][0] == "after");
    let split = |events: &[Json], at: Option<usize>| {
        let at = at.unwrap_or(events.len());
        (sorted(&events[..at]), sorted(&events[at..]))
    };
    if split(typescript, after(typescript)) != split(rust, after(rust)) {
        problems.push(json!({ "afterTheCombinator": { "typescript": after(typescript), "rust": after(rust) } }));
    }
    let mut arms: Vec<String> = typescript.iter().filter_map(arm_of).collect();
    arms.sort();
    arms.dedup();
    for arm in arms {
        let of = |events: &[Json]| events.iter().filter(|e| arm_of(e).as_deref() == Some(arm.as_str())).cloned().collect::<Vec<_>>();
        if of(typescript) != of(rust) {
            problems.push(json!({ "arm": arm, "typescript": of(typescript), "rust": of(rust) }));
        }
    }
    let unminted = |ws: &Json| Json::Array(ws.as_array().into_iter().flatten().map(|w| json!({ "body": w["body"], "payload": w["payload"] })).collect());
    if unminted(ts_writes) != unminted(rust_writes) {
        problems.push(json!({ "writes": rust_writes }));
    }
    problems
}

/// The arm a recorded request is one of: where it is written (a keyed
/// write's `at`, an update's or a plain write's text, a count's WHERE), a
/// link from the arm's own record (the prelude's `ha`…`hd`, minted fifth
/// to sixth… in order), the arm a lock was taken for by what its flow
/// asked next; `None` for a link between the two shared records, or what
/// the movement does outside its arms.
fn arm_of(event: &Json) -> Option<String> {
    let at = match event[0].as_str()? {
        "acquire" => return arm_of(&event[2]),
        "resolveEntity" | "createRecord" => event[1][1].get("at").and_then(Json::as_str).or(event[1][0].as_str())?,
        "updateRecord" => event[1][1].as_str()?,
        "getRelated" => event[2].as_str()?,
        "linkRecords" => {
            let own = ["n3", "n4", "n5", "n6"].iter().position(|id| event[1][0] == *id)?;
            return Some(["a", "b", "c", "d"][own].to_string());
        }
        _ => return None,
    };
    let (arm, _) = at.split_once('.')?;
    Some(arm.to_string())
}

/// The text a count's pushed WHERE compares the tag with: the arm's place
/// (`a.1`, `b02.0`); null when it names none.
fn tag_of(predicate: &Json) -> Json {
    fn find(value: &Json) -> Option<String> {
        match value {
            Json::String(text) => {
                let (arm, step) = text.split_once('.')?;
                let named = arm.chars().next().is_some_and(|c| ('a'..='d').contains(&c)) && arm[1..].chars().all(|c| c.is_ascii_digit());
                (named && !step.is_empty() && step.chars().all(|c| c.is_ascii_digit())).then(|| text.clone())
            }
            Json::Array(items) => items.iter().find_map(find),
            Json::Object(entries) => entries.values().find_map(find),
            _ => None,
        }
    }
    find(predicate).map_or(Json::Null, Json::String)
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
fn parallel_arms_ask_lock_and_order_their_writes_as_the_typescript_does() {
    let oracle: Json = serde_json::from_str(include_str!("oracle/parallel.json")).expect("parallel.json reads");
    let prelude = oracle["prelude"].as_str().expect("a prelude");
    let cases = oracle["cases"].as_array().expect("cases");
    let mut differ = Vec::new();
    let mut races = 0;
    let mut swapped = 0;
    // Of those, the cases holding a count or a link an arm asked.
    let mut attributed = 0;
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
        // What is in flight, each with what the oracle records of it.
        // Each with the step it was asked at (how many recorded requests had
        // been answered).
        let mut waiting: Vec<(PendingRequest, Option<Json>, usize)> = Vec::new();
        // A lock just answered: the next request recorded names its flow.
        let mut taken: Option<usize> = None;
        let done = loop {
            match step {
                Step::Done(done) => break done,
                Step::Pending(pending) => {
                    for request in pending {
                        let event = host.event(&request);
                        if let (Some(at), Some(event)) = (taken, &event) {
                            host.events[at].as_array_mut().expect("an event").push(event.clone());
                            taken = None;
                        }
                        waiting.push((request, event, host.events.len()));
                    }
                    // The rest of the host first, as an in-process host answers
                    // it; then the oldest step's request, the least by its text.
                    let at = waiting.iter().position(|(_, e, _)| e.is_none()).unwrap_or_else(|| {
                        (0..waiting.len()).min_by_key(|&i| (waiting[i].2, waiting[i].1.as_ref().map(Json::to_string))).expect("a segment waits only on what it asked")
                    });
                    let (request, event, _) = waiting.remove(at);
                    if let Some(event) = event {
                        if event[0] == "acquire" {
                            taken = Some(host.events.len());
                        }
                        host.events.push(event);
                    }
                    let reply = movement_engine::read_answer(&host.answer(&request).to_string()).expect("an answer");
                    step = segment.answer(request.id, reply).expect("the answer is taken");
                }
            }
        };
        // A lock taken last, after which its flow asked nothing more.
        if let Some(at) = taken {
            host.events[at].as_array_mut().expect("an event").push(Json::Null);
        }
        let (ended, written) = if done.get("result").is_some() { (json!({ "completed": true }), writes(&done, &host.sent)) } else { (json!({ "unexpected": done }), Json::Null) };
        let rust = json!({ "events": host.events, "writes": written, "outcome": ended });
        let typescript = json!({ "events": case["events"], "writes": case["writes"], "outcome": case["outcome"] });
        if rust != typescript {
            let expected = case["events"].as_array().expect("events");
            let first = host.events.iter().zip(expected).position(|(r, t)| r != t);
            let raced = first.is_some_and(|f| a_gate_race(&expected[f..], &host.events[f..]));
            let twins = first.is_some_and(|f| twin_locks(&expected[f..], &host.events[f..]));
            let problems = if raced || twins { race_problems(expected, &host.events, &case["writes"], &written, &ended, &case["outcome"]) } else { vec![json!("ordered otherwise")] };
            if problems.is_empty() {
                if expected.iter().any(|e| (e[0] == "getRelated" || e[0] == "linkRecords") && arm_of(e).is_some()) {
                    attributed += 1;
                }
                if raced {
                    races += 1;
                } else {
                    swapped += 1;
                }
            } else {
                differ.push(json!({ "body": case["body"], "firstDifference": first, "problems": problems, "typescript": typescript, "rust": rust }));
            }
        }
    }
    if let Ok(path) = std::env::var("ORACLE_DUMP") {
        std::fs::write(path, differ.iter().map(|d| d.to_string()).collect::<Vec<_>>().join("\n")).expect("the dump writes");
    }
    let shown: Vec<String> = differ.iter().take(5).map(|d| d.to_string()).collect();
    assert!(differ.is_empty(), "{} of {} cases differ:\n{}", differ.len(), cases.len(), shown.join("\n"));
    println!(
        "{} cases, {races} with arms of one step racing for one gate, {swapped} with two identical lock requests answered the other way ({attributed} of them holding an arm's count or link)",
        cases.len()
    );
}
