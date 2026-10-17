//! Real v5 movements run end to end through the typed interface, host family
//! by host family, each compared with the same run through the JSON boundary
//! (crate::begin, answered with the wire a TypeScript or lf host writes by
//! hand), so the typed mapping is held to the JSON route's behaviour rather
//! than to itself.

use std::collections::VecDeque;

use serde_json::{Value as Json, json};

use super::*;
use crate::executor::{Answer, PendingRequest, Step};

/// One adapter, `world`, with everything the families below need: a monster
/// the event is about, notes that are written under a fuzzy identity, a
/// document holding a file, and tickets whose `Reply` edge is awaitable.
const CATALOG: &str = r#"{
  "adapters": { "world": { "constructionArgs": [], "canFire": true, "triggerConfig": ["events"], "schemas": { "": {
    "positions": {
      "Monster": { "properties": { "Name": "text", "Slayer": "text", "Scroll": "file" }, "edges": {} },
      "Note": { "properties": { "Title": "text", "Attachment": "file" }, "edges": {} },
      "Ticket": { "properties": { "Subject": "text" }, "edges": { "Reply": { "target": "Reply", "awaitable": true, "watchable": true } } },
      "Reply": { "properties": { "Body": "text" }, "edges": {} }
    },
    "collections": { "notes": { "target": "Note" }, "tickets": { "target": "Ticket" } },
    "eventPosition": "Monster",
    "writableRoots": {
      "Note": { "fields": { "Title": "text", "Attachment": "file" }, "resultShape": { "externalId": "text", "Title": "text" }, "fuzzyResolution": true },
      "Ticket": { "fields": { "Subject": "text" }, "resultShape": { "externalId": "text" } }
    }
  } } } },
  "credentials": {},
  "plugins": { "lookup": { "args": ["q"], "requiredArgs": ["q"], "priced": false, "output": { "kind": "value", "type": "text" } } },
  "models": ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"]
}"#;

const NOW: &str = "2026-03-12T12:00:00.000Z";

fn input(source: &str) -> RunInput {
    let event = Event::new("world", Data::map([("Name", Data::text("Dragon")), ("Slayer", Data::text("Ada"))]))
        .of_type("monster.slain")
        .about("Monster", "m1");
    RunInput::new(source, event, NOW).function("m").catalog(Catalog::from_json(CATALOG).unwrap())
}

/// The movement's source with `body` as its one function.
fn movement(imports: &str, body: &str) -> String {
    format!("import {{ world }} from adapters\n{imports}game = connect world\nfunction m(monster: <game-[:Monster]->>) {{\n{body}}}\nlisten to game {{ events: [\"monster.slain\"] }} fire m\n")
}

fn errors(source: &str) -> Vec<Problem> {
    check(source, &Catalog::from_json(CATALOG).unwrap(), LANGUAGE_VERSION).into_iter().filter(|p| p.severity == Severity::Error).collect()
}

fn finished(outcome: Result<Outcome, EmbedError>) -> RunResult {
    match outcome.unwrap() {
        Outcome::Finished(ran) => ran,
        other => panic!("not finished: {other:?}"),
    }
}

// ── the world adapter, typed ──

/// The world as a typed host: every call it answers is also recorded.
#[derive(Default)]
struct World {
    calls: Vec<(String, Data)>,
    notes: Vec<(String, String)>,
    /// Replies per ticket id, once they have arrived.
    replies: Vec<(String, String)>,
    /// Existing notes `resolveEntity` offers as candidates.
    candidates: Vec<(String, String)>,
    updated: Vec<(String, String)>,
}

impl World {
    fn record(id: &str, record_type: &str, fields: Data) -> Data {
        Data::map([("adapterType", Data::text("world")), ("externalId", Data::text(id)), ("recordType", Data::text(record_type)), ("data", fields)])
    }
}

impl Adapters for World {
    fn resolve(&mut self, request: AdapterRequest) -> HostResult<AdapterInstance> {
        assert_eq!(request.adapter_type, "world");
        Ok(AdapterInstance { id: "w".into(), methods: ["createRecord", "updateRecord", "resolveEntity", "getFieldValue", "resolveAwait", "describe"].map(String::from).to_vec() })
    }

    fn call(&mut self, call: AdapterCall) -> HostResult<AdapterReply> {
        self.calls.push((call.method.clone(), call.args.clone()));
        Ok(match call.method.as_str() {
            "getFieldValue" if call.args.get("fieldId").and_then(Data::as_text) == Some("Scroll") => AdapterReply::ok(Data::File(FileRef::made(
                1,
                FileDescriptor { name: Some("scroll.txt".into()), content_type: Some("text/plain".into()), size: Some(12.0), handle: Some("blob-1".into()) },
            ))),
            "getFieldValue" => {
                let field = call.args.get("fieldId").and_then(Data::as_text).unwrap_or_default().to_string();
                let data = call.args.get("position").and_then(|p| p.get("identity")).and_then(|i| i.get("data")).cloned();
                AdapterReply::ok(data.and_then(|d| d.get(&field).cloned()).unwrap_or(Data::Null))
            }
            "describe" => AdapterReply::ok(Data::Null),
            "createRecord" => {
                let record_type = call.args.get("recordType").and_then(Data::as_text).unwrap_or_default().to_string();
                let fields = call.args.get("fields").cloned().unwrap_or(Data::Null);
                let id = format!("{}-{}", record_type.to_lowercase(), self.calls.len());
                if record_type == "Note" {
                    self.notes.push((id.clone(), fields.get("Title").and_then(Data::as_text).unwrap_or_default().to_string()));
                }
                AdapterReply::ok(World::record(&id, &record_type, fields))
            }
            "updateRecord" => {
                let id = call.args.get("externalId").and_then(Data::as_text).unwrap_or_default().to_string();
                let fields = call.args.get("fields").cloned().unwrap_or(Data::Null);
                self.updated.push((id.clone(), fields.get("Title").and_then(Data::as_text).unwrap_or_default().to_string()));
                AdapterReply::ok(World::record(&id, "Note", fields))
            }
            "resolveEntity" => AdapterReply::ok(Data::map([(
                "candidates",
                Data::List(self.candidates.iter().map(|(id, title)| World::record(id, "Note", Data::map([("Title", Data::text(title))]))).collect()),
            )])),
            "resolveAwait" => {
                let id = call.args.get("recordId").and_then(Data::as_text).unwrap_or_default().to_string();
                match self.replies.iter().find(|(ticket, _)| *ticket == id) {
                    Some((_, body)) => AdapterReply::ok(Data::map([
                        ("status", Data::text("landed")),
                        ("correlationKey", Data::text(id)),
                        ("landings", Data::List(vec![Data::map([("recordType", Data::text("Reply")), ("fields", Data::map([("Body", Data::text(body))]))])])),
                    ])),
                    None => AdapterReply::ok(Data::map([("status", Data::text("pending")), ("correlationKey", Data::text(id))])),
                }
            }
            other => AdapterReply::error("adapter_error", format!("the world does not answer {other}")),
        })
    }
}

// ── the JSON route ──

fn o(entries: Vec<(&str, Json)>) -> Json {
    json!(["o", entries.into_iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>()])
}

fn l(items: Vec<Json>) -> Json {
    json!(["l", items])
}

fn wire_cost(source: &str, microdollars: f64) -> Json {
    l(vec![o(vec![("source", json!(source)), ("microdollars", json!(microdollars))])])
}

type Scripted<'a> = Box<dyn FnMut(&str, &Json) -> Option<Json> + 'a>;

/// The JSON boundary: the segment input the typed route builds, driven by a
/// host that answers each request in the wire's own words.
struct Wire<'a> {
    seen: Vec<(String, Json)>,
    answer: Scripted<'a>,
}

impl<'a> Wire<'a> {
    /// `answer` serves what the test scripts; the world and the plain
    /// families (locks, clock, ids…) are served by `wire_world` after it.
    fn new(mut world: WireWorld, mut answer: impl FnMut(&str, &Json) -> Option<Json> + 'a) -> Wire<'a> {
        Wire { seen: Vec::new(), answer: Box::new(move |label, args| answer(label, args).or_else(|| world.answer(label, args))) }
    }

    /// The outcome of running `input` through the JSON boundary, its segment
    /// entered as `entry` says.
    fn drive(&mut self, input: &RunInput, entry: Entry<'_>, served: &mut Hosts<'_>) -> Outcome {
        let mut segment = crate::begin(&input_text(served, input, &entry, "segment")).unwrap();
        let mut queue = VecDeque::new();
        let mut step = segment.start().unwrap();
        let done = loop {
            match step {
                Step::Done(done) => break done,
                Step::Pending(pending) => {
                    queue.extend(pending);
                    let request: PendingRequest = queue.pop_front().unwrap();
                    let label = format!("{}.{}", request.family, request.method);
                    self.seen.push((label.clone(), request.args.clone()));
                    let answer: Answer = Ok((self.answer)(&label, &request.args));
                    step = segment.answer(request.id, answer).unwrap();
                }
            }
        };
        outcome(&done, &[])
    }

    fn args_of(&self, label: &str) -> Vec<&Json> {
        self.seen.iter().filter(|(seen, _)| seen == label).map(|(_, args)| args).collect()
    }
}

/// The world, answered as a JSON host answers it.
#[derive(Default)]
struct WireWorld {
    candidates: Vec<(String, String)>,
    replies: Vec<(String, String)>,
    calls: usize,
    ids: usize,
    /// The positions a call registered, which later calls name by handle.
    positions: std::collections::BTreeMap<u64, Data>,
}

impl WireWorld {
    fn record(id: &str, record_type: &str, fields: Json) -> Json {
        o(vec![("adapterType", json!("world")), ("externalId", json!(id)), ("recordType", json!(record_type)), ("data", fields)])
    }

    fn answer(&mut self, label: &str, args: &Json) -> Option<Json> {
        match label {
            "adapters.resolve" => Some(json!({ "instance": "w", "methods": ["createRecord", "updateRecord", "resolveEntity", "getFieldValue", "resolveAwait", "describe"] })),
            "adapters.call" => {
                self.calls += 1;
                let mut call = Data::from_wire(&args["args"]).unwrap();
                if let Some(handle) = args.get("positionRef").and_then(Json::as_u64) {
                    if let Some(position) = args.get("position") {
                        self.positions.insert(handle, Data::from_wire(position).unwrap());
                    }
                    let rest = match call {
                        Data::Map(entries) => entries,
                        _ => Vec::new(),
                    };
                    call = Data::Map(std::iter::once(("position".to_string(), self.positions[&handle].clone())).chain(rest).collect());
                }
                let method = args["method"].as_str().unwrap();
                let result = match method {
                    "getFieldValue" => {
                        let field = call.get("fieldId").and_then(Data::as_text).unwrap_or_default();
                        if field == "Scroll" {
                            json!(["F", 1, { "name": "scroll.txt", "contentType": "text/plain", "size": 12.0, "handle": "blob-1" }])
                        } else {
                            let position = call.get("position").and_then(|p| p.get("identity")).and_then(|i| i.get("data")).cloned();
                            position.and_then(|d| d.get(field).cloned()).unwrap_or(Data::Null).to_wire()
                        }
                    }
                    "describe" => Json::Null,
                    "createRecord" => {
                        let record_type = call.get("recordType").and_then(Data::as_text).unwrap_or_default().to_string();
                        let fields = call.get("fields").cloned().unwrap_or(Data::Null).to_wire();
                        Self::record(&format!("{}-{}", record_type.to_lowercase(), self.calls), &record_type, fields)
                    }
                    "updateRecord" => {
                        let id = call.get("externalId").and_then(Data::as_text).unwrap_or_default().to_string();
                        let fields = call.get("fields").cloned().unwrap_or(Data::Null).to_wire();
                        Self::record(&id, "Note", fields)
                    }
                    "resolveEntity" => o(vec![(
                        "candidates",
                        l(self.candidates.iter().map(|(id, title)| Self::record(id, "Note", o(vec![("Title", json!(title))]))).collect()),
                    )]),
                    "resolveAwait" => {
                        let id = call.get("recordId").and_then(Data::as_text).unwrap_or_default().to_string();
                        match self.replies.iter().find(|(ticket, _)| *ticket == id) {
                            Some((_, body)) => o(vec![
                                ("status", json!("landed")),
                                ("correlationKey", json!(id)),
                                ("landings", l(vec![o(vec![("recordType", json!("Reply")), ("fields", o(vec![("Body", json!(body))]))])])),
                            ]),
                            None => o(vec![("status", json!("pending")), ("correlationKey", json!(id))]),
                        }
                    }
                    other => return Some(json!({ "error": { "kind": "adapter_error", "message": format!("the world does not answer {other}") } })),
                };
                Some(json!({ "result": result }))
            }
            "locks.acquire" => Some(json!({ "token": args["names"].as_array().unwrap().iter().filter_map(Json::as_str).collect::<Vec<_>>().join(",") })),
            "control.cancel.cancelled" | "control.cancel.cancelledNow" => Some(json!(false)),
            "clock.now" => Some(json!({ "nowIso": NOW })),
            "ids.mint" => {
                let count = args["count"].as_u64().unwrap();
                Some(json!((0..count).map(|_| { self.ids += 1; format!("id-{}", self.ids) }).collect::<Vec<_>>()))
            }
            _ => None,
        }
    }
}

// ── the stores ──

/// Parks, joins and callbacks in memory.
#[derive(Default)]
struct Parks {
    timers: Vec<TimerPark>,
    awaits: Vec<AwaitPark>,
    mints: Vec<CallbackMint>,
    /// Each callback's ledger of calls, as `{at, values}`.
    calls: Vec<Data>,
    joins: Vec<(String, i64)>,
    exports: Vec<(String, BranchExport)>,
    wakes: Vec<(String, serde_json::Value)>,
}

impl Store for Parks {
    fn keeps_parks(&self) -> bool {
        true
    }
    fn commit_timer_park(&mut self, park: TimerPark) -> HostResult<()> {
        self.timers.push(park);
        Ok(())
    }
    fn commit_await_park(&mut self, park: AwaitPark) -> HostResult<()> {
        self.awaits.push(park);
        Ok(())
    }
    fn record_join(&mut self, frame: &str, parked_children: i64) -> HostResult<()> {
        self.joins.push((frame.into(), parked_children));
        Ok(())
    }
    fn decrement_join(&mut self, frame: &str, _branch: &str, _leaf: &str) -> HostResult<bool> {
        let join = self.joins.iter_mut().find(|(f, _)| f == frame).ok_or("no such join")?;
        join.1 -= 1;
        Ok(join.1 == 0)
    }
    fn persist_branch_export(&mut self, frame: &str, export: BranchExport) -> HostResult<()> {
        self.exports.push((frame.into(), export));
        Ok(())
    }
    fn collect_branch_exports(&mut self, frame: &str) -> HostResult<Vec<BranchExport>> {
        Ok(self.exports.iter().filter(|(f, _)| f == frame).map(|(_, e)| e.clone()).collect())
    }
    fn cancel_subtrees(&mut self, prefixes: &[String], exclude: Option<&str>) -> HostResult<()> {
        self.awaits.retain(|a| Some(a.address.as_str()) == exclude || !prefixes.iter().any(|p| a.address.starts_with(p.as_str())));
        Ok(())
    }
    fn wake(&mut self, adapter_type: &str, key: &serde_json::Value) -> HostResult<()> {
        self.wakes.push((adapter_type.into(), key.clone()));
        Ok(())
    }
    fn mint_callback(&mut self, mint: CallbackMint) -> HostResult<MintedCallback> {
        self.mints.push(mint);
        Ok(MintedCallback { id: "cb1".into(), url: "https://example.test/cb/cb1".into() })
    }
    fn callback_calls(&mut self, _callback_id: &serde_json::Value) -> HostResult<Data> {
        Ok(Data::List(self.calls.clone()))
    }
}

// ── the families ──

/// A model that answers each call with `reply` and charges for it.
struct Model {
    reply: Data,
    calls: Vec<ModelCall>,
}

impl Models for Model {
    fn call(&mut self, call: ModelCall) -> HostResult<ModelReply> {
        self.calls.push(call);
        Ok(ModelReply { parsed_json: self.reply.clone(), raw_text: None, cost: vec![Cost { source: "model:test".into(), microdollars: 7.0 }] })
    }
}

fn titles(world: &World) -> Vec<&str> {
    world.notes.iter().map(|(_, title)| title.as_str()).collect()
}

#[test]
fn an_ai_call_runs_the_same_through_the_typed_and_the_json_route() {
    let source = movement("", "  line = ai(\"Describe ${monster.Name}\")\n  write game-[:notes]-> { Title: line }\n");
    assert_eq!(errors(&source), vec![]);
    let reply = Data::map([("value", Data::text("A fine line.")), ("has_value", Data::Bool(true))]);
    let (mut world, mut model) = (World::default(), Model { reply, calls: Vec::new() });
    let typed = run(&mut Hosts::new().adapters(&mut world).models(&mut model), &input(&source)).unwrap();
    assert_eq!(titles(&world), vec!["A fine line."]);
    assert_eq!(model.calls.len(), 1);
    assert_eq!((model.calls[0].label.as_str(), model.calls[0].prompt.clone()), ("movement-ai-expression", Prompt::Message("Describe Dragon".into())));
    let ran = finished(Ok(typed.clone()));
    assert_eq!(ran.cost, vec![Cost { source: "model:test".into(), microdollars: 7.0 }]);

    let mut wire = Wire::new(WireWorld::default(), |label, _| {
        (label == "llm.client.call").then(|| o(vec![("parsedJson", o(vec![("value", json!("A fine line.")), ("has_value", json!(true))])), ("cost", wire_cost("model:test", 7.0))]))
    });
    let (mut served, mut model) = (World::default(), Model { reply: Data::Null, calls: Vec::new() });
    let json = wire.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).models(&mut model));
    assert_eq!(typed, json);
}

/// Plain JSON as the eval wire writes it, for scripting a JSON host.
fn wire(value: Json) -> Json {
    match value {
        Json::Array(items) => l(items.into_iter().map(wire).collect()),
        Json::Object(map) => json!(["o", map.into_iter().map(|(k, v)| json!([k, wire(v)])).collect::<Vec<_>>()]),
        scalar => scalar,
    }
}

fn model_reply(parsed: Json, microdollars: f64) -> Json {
    o(vec![("parsedJson", wire(parsed)), ("cost", wire_cost("model:test", microdollars))])
}

#[test]
fn an_extraction_runs_the_same_through_the_typed_and_the_json_route() {
    let shape = "node Person: \"each person named\" { name: <text> \"their name\" }";
    let source = movement("", &format!("  people = extract([monster.Name, monster.Slayer], {shape})\n  map(people, (p) => {{ write game-[:notes]-> {{ Title: p.name }} }})\n"));
    assert_eq!(errors(&source), vec![]);
    let field = |value: &str| json!({ "value": value, "evidence": { "item": 0, "quote": value } });
    let reply = json!({ "records": [{ "name": field("Dragon") }, { "name": field("Ada") }] });
    let (mut world, mut model) = (World::default(), Model { reply: Data::from(reply.clone()), calls: Vec::new() });
    let typed = run(&mut Hosts::new().adapters(&mut world).models(&mut model), &input(&source)).unwrap();
    assert_eq!(titles(&world), vec!["Dragon", "Ada"]);
    assert_eq!(model.calls.len(), 1);
    assert_eq!(model.calls[0].label, "movement_extract_call");
    let Prompt::Blocks(blocks) = &model.calls[0].prompt else { panic!("{:?}", model.calls[0].prompt) };
    assert_eq!(blocks.len(), 3, "two content items and the shape");
    assert_eq!(finished(Ok(typed.clone())).cost, vec![Cost { source: "model:test".into(), microdollars: 7.0 }]);

    let mut json = Wire::new(WireWorld::default(), |label, _| (label == "llm.extractCall.call").then(|| model_reply(reply.clone(), 7.0)));
    let (mut served, mut unused) = (World::default(), Model { reply: Data::Null, calls: Vec::new() });
    let through_json = json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).models(&mut unused));
    assert_eq!(typed, through_json);
    assert_eq!(json.args_of("llm.extractCall.call").len(), 1);
}

struct Judging(Verdict, usize);

impl Judge for Judging {
    fn arbitrate(&mut self, arbitration: Arbitration) -> HostResult<Verdict> {
        self.1 += 1;
        assert_eq!(arbitration.record_type, "Note");
        assert_eq!(arbitration.asserted.get("Title"), Some(&Data::text("Dragon")));
        assert_eq!(arbitration.candidates.as_list().map(<[Data]>::len), Some(2));
        Ok(self.0.clone())
    }
}

const FUZZY: &str = "  note = write game-[:notes]-> {\n    unique by (FUZZY `Title`)\n    Title: monster.Name\n  }\n";

fn candidates() -> Vec<(String, String)> {
    vec![("note-91".into(), "Dragon Inc".into()), ("note-92".into(), "Dragon Labs".into())]
}

#[test]
fn the_identity_judge_picks_the_record_a_fuzzy_write_is_the_same_through_both_routes() {
    let source = movement("", FUZZY);
    assert_eq!(errors(&source), vec![]);
    let verdict = Verdict { index: Some(1), judge_unavailable: None, cost: vec![Cost { source: "model:judge".into(), microdollars: 11.0 }] };
    let (mut world, mut judge) = (World { candidates: candidates(), ..World::default() }, Judging(verdict, 0));
    let typed = run(&mut Hosts::new().adapters(&mut world).judge(&mut judge), &input(&source)).unwrap();
    assert_eq!(judge.1, 1);
    assert_eq!(world.updated, vec![("note-92".to_string(), "Dragon".to_string())], "the judge's pick is updated, nothing created");
    assert!(world.notes.is_empty());
    assert_eq!(finished(Ok(typed.clone())).cost, vec![Cost { source: "model:judge".into(), microdollars: 11.0 }]);

    let mut json = Wire::new(WireWorld { candidates: candidates(), ..WireWorld::default() }, |label, _| {
        (label == "llm.arbitrateEntities").then(|| json!({ "index": 1, "cost": [{ "source": "model:judge", "microdollars": 11 }] }))
    });
    let (mut served, mut unused) = (World::default(), Judging(Verdict { index: None, judge_unavailable: None, cost: vec![] }, 0));
    assert_eq!(typed, json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).judge(&mut unused)));
}

/// A judge that says no match, and one that cannot judge, both leave the
/// write creating a new record, as the JSON route does.
#[test]
fn a_judge_that_declines_or_is_unavailable_leaves_the_write_creating() {
    let source = movement("", FUZZY);
    for verdict in [
        Verdict { index: None, judge_unavailable: None, cost: vec![] },
        Verdict { index: None, judge_unavailable: Some("the judge is asleep".into()), cost: vec![] },
    ] {
        let reason = verdict.judge_unavailable.clone();
        let (mut world, mut judge) = (World { candidates: candidates(), ..World::default() }, Judging(verdict, 0));
        let typed = run(&mut Hosts::new().adapters(&mut world).judge(&mut judge), &input(&source)).unwrap();
        assert_eq!(titles(&world), vec!["Dragon"], "{typed:?}");
        let mut json = Wire::new(WireWorld { candidates: candidates(), ..WireWorld::default() }, |label, _| {
            (label == "llm.arbitrateEntities").then(|| match &reason {
                Some(reason) => json!({ "index": null, "judgeUnavailable": reason }),
                None => json!({ "index": null }),
            })
        });
        let (mut served, mut unused) = (World::default(), Judging(Verdict { index: None, judge_unavailable: None, cost: vec![] }, 0));
        assert_eq!(typed, json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).judge(&mut unused)));
    }
}

struct Library {
    read: Vec<FileRef>,
    rendered: Vec<(String, String)>,
}

impl Files for Library {
    fn render(&mut self, content: &str, kind: &str) -> HostResult<FileRef> {
        self.rendered.push((content.into(), kind.into()));
        Ok(FileRef::made(2, FileDescriptor { name: Some("made.txt".into()), content_type: Some("text/plain".into()), size: Some(content.len() as f64), handle: Some("blob-2".into()) }))
    }
    fn file_text(&mut self, file: &FileRef, _budget: &Json) -> HostResult<(FileText, Vec<Cost>)> {
        self.read.push(file.clone());
        Ok((FileText::Text { text: "The scroll says hi".into(), raw_text_id: None }, vec![Cost { source: "file:ocr".into(), microdollars: 3.0 }]))
    }
}

#[test]
fn a_file_is_read_and_a_file_is_made_the_same_through_both_routes() {
    let source = movement("", "  text = File.read(monster.Scroll)\n  doc = File.from(\"copy: ${text}\", \"text\")\n  write game-[:notes]-> { Title: coalesce(text, \"\"), Attachment: doc }\n");
    assert_eq!(errors(&source), vec![]);
    let (mut world, mut library) = (World::default(), Library { read: Vec::new(), rendered: Vec::new() });
    let typed = run(&mut Hosts::new().adapters(&mut world).files(&mut library), &input(&source)).unwrap();
    assert_eq!(library.read.iter().map(|f| f.id).collect::<Vec<_>>(), vec![1], "the host is handed back the file it made");
    assert_eq!(library.rendered, vec![("copy: The scroll says hi".to_string(), "text".to_string())]);
    assert_eq!(titles(&world), vec!["The scroll says hi"]);
    let attachment = world.calls.iter().find(|(m, _)| m == "createRecord").and_then(|(_, a)| a.get("fields")).and_then(|f| f.get("Attachment")).cloned();
    assert!(matches!(attachment, Some(Data::File(FileRef { id: 2, .. }))), "{attachment:?}");
    assert_eq!(finished(Ok(typed.clone())).cost, vec![Cost { source: "file:ocr".into(), microdollars: 3.0 }]);

    let mut json = Wire::new(WireWorld::default(), |label, _| match label {
        "files.resolveFileText" => Some(o(vec![("text", json!("The scroll says hi")), ("cost", wire_cost("file:ocr", 3.0))])),
        "files.render" => Some(json!(["F", 2, { "name": "made.txt", "contentType": "text/plain", "size": 24.0, "handle": "blob-2" }])),
        _ => None,
    });
    let (mut served, mut unused) = (World::default(), Library { read: Vec::new(), rendered: Vec::new() });
    assert_eq!(typed, json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).files(&mut unused)));
}

struct Plugins(Vec<PluginCall>);

impl Modules for Plugins {
    fn invoke(&mut self, call: PluginCall) -> HostResult<PluginReply> {
        self.0.push(call);
        Ok(PluginReply { text: Some("looked up".into()), cost: vec![Cost { source: "plugin:lookup".into(), microdollars: 5.0 }], ..PluginReply::default() })
    }
}

#[test]
fn a_plugin_call_runs_the_same_through_both_routes() {
    let source = movement("import { lookup } from plugins\n", "  hit = lookup(monster.Name)\n  write game-[:notes]-> { Title: hit }\n");
    assert_eq!(errors(&source), vec![]);
    let (mut world, mut plugins) = (World::default(), Plugins(Vec::new()));
    let typed = run(&mut Hosts::new().adapters(&mut world).modules(&mut plugins), &input(&source)).unwrap();
    assert_eq!(titles(&world), vec!["looked up"]);
    assert_eq!(plugins.0.len(), 1);
    assert_eq!((plugins.0[0].plugin.as_str(), plugins.0[0].config.get("q")), ("lookup", Some(&Data::text("Dragon"))));
    assert_eq!(finished(Ok(typed.clone())).cost, vec![Cost { source: "plugin:lookup".into(), microdollars: 5.0 }]);

    let mut json = Wire::new(WireWorld::default(), |label, _| {
        (label == "llm.transforms.invoke").then(|| o(vec![("text", json!("looked up")), ("cost", wire_cost("plugin:lookup", 5.0))]))
    });
    let (mut served, mut unused) = (World::default(), Plugins(Vec::new()));
    assert_eq!(typed, json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).modules(&mut unused)));
}

/// A model that refuses on its budget ends the run as the JSON route's
/// budget refusal does, not as a host fault.
struct Broke;

impl Models for Broke {
    fn call(&mut self, _call: ModelCall) -> HostResult<ModelReply> {
        Err(HostFailure::budget("no budget left for this call"))
    }
}

#[test]
fn a_model_that_refuses_on_budget_fails_the_run_as_the_json_route_does() {
    let source = movement("", "  line = ai(\"Describe ${monster.Name}\")\n  write game-[:notes]-> { Title: line }\n");
    let (mut world, mut broke) = (World::default(), Broke);
    let typed = run(&mut Hosts::new().adapters(&mut world).models(&mut broke), &input(&source)).unwrap();
    assert!(world.notes.is_empty());
    let mut json = Wire::new(WireWorld::default(), |label, _| {
        (label == "llm.client.call").then(|| o(vec![("error", o(vec![("kind", json!("budget")), ("message", json!("no budget left for this call"))]))]))
    });
    let (mut served, mut unused) = (World::default(), Broke);
    let through_json = json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).models(&mut unused));
    assert_eq!(typed, through_json);
    assert!(matches!(&typed, Outcome::Failed(f) if f.message.contains("no budget left")), "{typed:?}");
}

const TICKET: &str = "  t = write game-[:tickets]-> { Subject: monster.Name }\n  r = await first(t-[:Reply]->)\n  write game-[:notes]-> { Title: coalesce(r.Body, \"\") }\n";

#[test]
fn an_await_on_an_adapter_record_parks_and_resumes_when_the_reply_arrives() {
    let source = movement("", TICKET);
    assert_eq!(errors(&source), vec![]);
    let (mut world, mut parks) = (World::default(), Parks::default());
    let parked = run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source)).unwrap();
    assert!(matches!(&parked, Outcome::Parked(ran) if ran.parked_address.is_some()), "{parked:?}");
    assert!(world.notes.is_empty() && parks.timers.is_empty());
    let [park] = parks.awaits.as_slice() else { panic!("{:?}", parks.awaits) };
    assert_eq!(park.adapter_type, "world");
    let key = park.correlation_key.clone();
    assert!(key.as_str().is_some_and(|k| k.starts_with("ticket-")), "{key}");

    // The reply arrives; the awaiting statement is entered again.
    let ticket = key.as_str().unwrap().to_string();
    world.replies.push((ticket.clone(), "Thanks".into()));
    let park = parks.awaits.remove(0);
    let calls_before_resume = world.calls.len();
    let resumed = resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source), &park.state, Wake::Arrival).unwrap();
    assert_eq!(titles(&world), vec!["Thanks"]);
    assert!(matches!(resumed, Outcome::Finished(_)), "{resumed:?}");

    // The JSON route: the same two segments, answered by hand.
    let mut json = Wire::new(WireWorld::default(), |label, _| (label == "park.sink.commitAwaitPark").then_some(Json::Null));
    let (mut served, mut store) = (World::default(), Parks::default());
    let through_json = json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).store(&mut store));
    assert_eq!(parked, through_json);
    let committed = json.args_of("park.sink.commitAwaitPark");
    assert_eq!(committed.len(), 1);
    assert_eq!((committed[0]["state"].clone(), committed[0]["address"].clone()), (park.state.0.clone(), json!(park.address)));
    assert_eq!((committed[0]["adapterType"].clone(), committed[0]["correlationKey"].clone()), (json!("world"), park.correlation_key));
    let mut json = Wire::new(WireWorld { replies: vec![(ticket, "Thanks".into())], calls: calls_before_resume, ..WireWorld::default() }, |_, _| None);
    let through_json = json.drive(&input(&source), Entry::Resume { state: &park.state, reenter: true }, &mut Hosts::new().adapters(&mut served).store(&mut store));
    assert_eq!(resumed, through_json);
}

/// A reply that has not arrived keeps the flow parked: re-entering the
/// await checks again rather than stepping past it.
#[test]
fn an_await_woken_early_parks_again_instead_of_stepping_past() {
    let source = movement("", TICKET);
    let (mut world, mut parks) = (World::default(), Parks::default());
    run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source)).unwrap();
    let park = parks.awaits.remove(0);
    let again = resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source), &park.state, Wake::Arrival).unwrap();
    assert!(matches!(again, Outcome::Parked(_)), "{again:?}");
    assert_eq!(parks.awaits.len(), 1);
    assert!(world.notes.is_empty());
}

const CALLBACK: &str = "  approve = callback((who: <text>) => { write game-[:notes]-> { Title: \"approved by ${who}\" } })\n  tap = await first(approve-[:Called]->)\n  write game-[:notes]-> { Title: \"tapped by ${tap.who} at ${tap.At}\" }\n";

#[test]
fn a_callback_is_minted_fired_and_its_awaiter_resumed() {
    let source = movement("", CALLBACK);
    assert_eq!(errors(&source), vec![]);
    let (mut world, mut parks) = (World::default(), Parks::default());
    let parked = run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source)).unwrap();
    assert!(matches!(parked, Outcome::Parked(_)), "{parked:?}");
    let [mint] = parks.mints.as_slice() else { panic!("{:?}", parks.mints) };
    assert_eq!(mint.params, vec![("who".to_string(), "text".to_string())]);
    assert!(mint.single_use);
    let [park] = parks.awaits.as_slice() else { panic!("{:?}", parks.awaits) };
    assert_eq!((park.adapter_type.as_str(), park.correlation_key.clone()), ("callback", json!("cb1")));

    // Someone calls it: the call lands on the ledger, its body runs, and the awaiter is woken.
    let call = CallbackCall { values: Data::map([("who", Data::text("Bo"))]), call_index: 0 };
    parks.calls.push(Data::map([("at", Data::text("2026-03-12T12:05:00.000Z")), ("values", call.values.clone())]));
    let (mint_state, await_state) = (mint.state.clone(), park.state.clone());
    let calls_before_fire = world.calls.len();
    let fired = fire(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source), &mint_state, &call).unwrap();
    assert!(matches!(fired, Outcome::Finished(_)), "{fired:?}");
    assert_eq!(titles(&world), vec!["approved by Bo"]);
    let calls_before_resume = world.calls.len();
    let resumed = resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source), &await_state, Wake::Arrival).unwrap();
    assert!(matches!(resumed, Outcome::Finished(_)), "{resumed:?}");
    assert_eq!(titles(&world), vec!["approved by Bo", "tapped by Bo at 2026-03-12T12:05:00.000Z"]);

    // The JSON route, the same three segments.
    let ledger = json!(["l", [wire(json!({ "at": "2026-03-12T12:05:00.000Z", "values": { "who": "Bo" } }))]]);
    let (mut served, mut store) = (World::default(), Parks::default());
    let mut json = Wire::new(WireWorld::default(), |label, _| match label {
        "park.callbacks.mint" => Some(json!({ "id": "cb1", "url": "https://example.test/cb/cb1" })),
        "park.callbacks.calls" => Some(l(vec![])),
        "park.sink.commitAwaitPark" => Some(Json::Null),
        _ => None,
    });
    let through_json = json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).store(&mut store));
    assert_eq!(parked, through_json);
    let minted = json.args_of("park.callbacks.mint");
    assert_eq!((minted[0]["state"].clone(), minted[0]["params"].clone()), (mint_state.0.clone(), json!([{ "name": "who", "type": "text" }])));
    let mut json = Wire::new(WireWorld { calls: calls_before_fire, ..WireWorld::default() }, |_, _| None);
    let through_json = json.drive(&input(&source), Entry::Fire { state: &mint_state, call: &call }, &mut Hosts::new().adapters(&mut served).store(&mut store));
    assert_eq!(fired, through_json);
    let mut json = Wire::new(WireWorld { calls: calls_before_resume, ..WireWorld::default() }, |label, _| (label == "park.callbacks.calls").then(|| ledger.clone()));
    let through_json = json.drive(&input(&source), Entry::Resume { state: &await_state, reenter: true }, &mut Hosts::new().adapters(&mut served).store(&mut store));
    assert_eq!(resumed, through_json);
}

const JOIN: &str = "  r = all(\n    () => {\n      t = write game-[:tickets]-> { Subject: monster.Name }\n      x = await first(t-[:Reply]->)\n      return coalesce(x.Body, \"\")\n    },\n    () => { return \"fast\" },\n  )\n  write game-[:notes]-> { Title: \"${r[0]}+${r[1]}\" }\n";

#[test]
fn a_join_with_a_parked_arm_closes_when_the_arm_resumes() {
    let source = movement("", JOIN);
    assert_eq!(errors(&source), vec![]);
    let (mut world, mut parks) = (World::default(), Parks::default());
    let parked = run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source)).unwrap();
    assert!(matches!(parked, Outcome::Parked(_)), "{parked:?}");
    assert!(world.notes.is_empty());
    assert_eq!(parks.joins.len(), 1, "the join recorded one parked arm: {:?}", parks.joins);
    assert_eq!(parks.joins[0].1, 1);
    assert_eq!(parks.exports.len(), 1, "the arm that finished left its export: {:?}", parks.exports.iter().map(|(f, e)| (f, e.branch_index)).collect::<Vec<_>>());
    let [park] = parks.awaits.as_slice() else { panic!("{:?}", parks.awaits) };
    let (ticket, state) = (park.correlation_key.as_str().unwrap().to_string(), park.state.clone());

    world.replies.push((ticket, "Thanks".into()));
    let resumed = resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source), &state, Wake::Arrival).unwrap();
    assert!(matches!(resumed, Outcome::Finished(_)), "{resumed:?}");
    assert_eq!(titles(&world), vec!["Thanks+fast"]);
}

/// A timer wake steps past a `sleep` but re-tests an `until`'s condition:
/// the state says which it is parked on.
#[test]
fn a_timer_wake_retests_an_until_and_steps_past_a_sleep() {
    let until = movement("", "  await until(monster.Name == \"Wyrm\", { every: 15m })\n  write game-[:notes]-> { Title: \"done\" }\n");
    assert_eq!(errors(&until), vec![]);
    let (mut world, mut parks) = (World::default(), Parks::default());
    let parked = run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&until)).unwrap();
    assert!(matches!(parked, Outcome::Parked(_)), "{parked:?}");
    let timer = parks.timers.remove(0);
    assert_eq!(timer.wake_at, "2026-03-12T12:15:00.000Z");
    assert!(timer.state.is_until());
    let again = resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&until), &timer.state, Wake::Timer).unwrap();
    assert!(matches!(again, Outcome::Parked(_)), "the condition is still false: {again:?}");
    assert_eq!(parks.timers.len(), 1);
    assert!(world.notes.is_empty());

    let sleep = movement("", "  await sleep(1h)\n  write game-[:notes]-> { Title: \"done\" }\n");
    run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&sleep)).unwrap();
    let timer = parks.timers.pop().unwrap();
    assert!(!timer.state.is_until());
    let done = resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&sleep), &timer.state, Wake::Timer).unwrap();
    assert!(matches!(done, Outcome::Finished(_)), "{done:?}");
    assert_eq!(titles(&world), vec!["done"]);
}
