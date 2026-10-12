//! The extraction keyword's specs, regions, prompts and reply reading, and
//! the priced-plugin cap, held to the TypeScript's own answers
//! (tests/oracle/extraction.json, written by tests/oracle/extraction_oracle.ts
//! through generate.ts): the same spec JSON, the same site ids, the same
//! system and user messages byte for byte, the same data read from every
//! seeded reply or the same issues in the same order and words, the same
//! coercions, and the same refusal and account for a priced plugin.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use movement_engine::env::{js_of_serialized, json_of_js};
use movement_engine::extract::prompt::{self, Enrichment, Entity, Segment};
use movement_engine::extract::spec::{self, Firing, NodeSpec, Region, SpecError, WordsScope};
use movement_engine::extract::validate::{self, Issue, PathKey};
use movement_engine::js::{self, Js};
use movement_engine::ledger::{Ledger, Spend};
use movement_engine::program::{self, DeclaringFile};
use movement_parser::ast::{self, ExprSlot};
use movement_parser::catalog::types::{InstanceSchema, JsMap, PluginSpec};
use serde_json::{Value as Json, json};

/// The spec builder awaits only its firing, which answers at once here.
fn ready<T>(future: impl Future<Output = T>) -> T {
    let mut future = pin!(future);
    match future.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("the stand-in firing never waits"),
    }
}

/// The oracle's stand-in firing: its instances' schemas, and descriptions
/// tagged with the scope they were asked in.
struct Stand<'w> {
    schemas: &'w BTreeMap<String, InstanceSchema>,
}

impl Firing for Stand<'_> {
    type Error = ();

    fn instance_schema(&self, name: &str) -> Option<&InstanceSchema> {
        self.schemas.get(name)
    }

    async fn describe(&self, slot: &ExprSlot, scope: &WordsScope) -> Result<String, ()> {
        let scope = match scope {
            WordsScope::Firing => "firing",
            WordsScope::File(DeclaringFile::Root) => "root",
            WordsScope::File(DeclaringFile::Library(path)) => path,
        };
        Ok(format!("⟪{scope}|{}⟫", slot.raw))
    }
}

/// The oracle's `plain`: a prototype a record was given (an object, not
/// `null`) put back as its own `__proto__` key, last, at every depth.
fn restored(value: &Js) -> Js {
    match value {
        Js::Array(list) => Js::array(list.items().iter().map(restored).collect()),
        Js::Object(object) => {
            let mut out = js::JsObject::new();
            for (key, value) in object.entries() {
                out.set(key.clone(), restored(value));
            }
            if let Some(proto @ (Js::Object(_) | Js::Array(_))) = &object.proto {
                out.set("__proto__".into(), restored(proto));
            }
            Js::object(out)
        }
        other => other.clone(),
    }
}

/// A reply as `JSON.parse` reads it: its keys in the order written.
fn reply_of(text: &str) -> Js {
    let raw: Box<serde_json::value::RawValue> = serde_json::from_str(text).expect("a reply is JSON");
    js_of_serialized(&raw)
}

fn region_json(region: &Region<'_>) -> Json {
    json!({
        "siteId": region.site_id,
        "node": region.spec.name,
        "stageIndex": region.stage_index,
        "single": region.single,
        "children": region.children.iter().map(region_json).collect::<Vec<_>>(),
    })
}

/// Every call a materialisation makes, in the oracle's tree order.
fn regions_of(spec: &NodeSpec) -> Vec<Region<'_>> {
    let mut counter = 0;
    let mut next = || {
        counter += 1;
        counter
    };
    let mut regions = vec![Region::plan(spec, 0, true, &mut next)];
    fn walk<'s>(node: &'s NodeSpec, regions: &mut Vec<Region<'s>>, next: &mut dyn FnMut() -> u64) {
        for stage in 1..node.stages.len() {
            regions.push(Region::plan(node, stage, true, next));
        }
        for stage in &node.stages {
            for child in &stage.children {
                if child.stages.first().is_some_and(|s| !s.through.is_empty()) {
                    regions.push(Region::plan(child, 0, false, next));
                }
                walk(child, regions, next);
            }
        }
    }
    walk(spec, &mut regions, &mut next);
    regions
}

fn issues_json(issues: &[Issue]) -> Json {
    Json::Array(
        issues
            .iter()
            .map(|issue| {
                let path: Vec<Json> = issue
                    .path
                    .iter()
                    .map(|step| match step {
                        PathKey::Key(key) => json!(key),
                        PathKey::Index(i) => json!(i),
                    })
                    .collect();
                json!({ "path": path, "message": issue.message })
            })
            .collect(),
    )
}

fn pairs(pairs: &[(String, Vec<String>)]) -> Json {
    Json::Array(pairs.iter().map(|(k, v)| json!([k, v])).collect())
}

fn extraction_of(program: &ast::Program) -> &ast::ExtractExpression {
    program
        .statements
        .iter()
        .find_map(|statement| match statement {
            ast::Statement::Movement(movement) => match movement.body.first() {
                Some(ast::Statement::Assign(assign)) => match &assign.value {
                    ast::RValue::Extract { extract } => Some(extract),
                    _ => None,
                },
                _ => None,
            },
            _ => None,
        })
        .expect("the case's movement starts with its extraction")
}

#[test]
fn extractions_ask_and_read_as_typescript_asks_and_reads() {
    let cases: Vec<Json> = serde_json::from_str(include_str!("oracle/extraction.json")).expect("the oracle reads");
    let world = &cases[0];
    assert_eq!(world["kind"], "world");
    let schemas: BTreeMap<String, InstanceSchema> = serde_json::from_value(world["schemas"].clone()).expect("the schemas read");
    let plugins: JsMap<PluginSpec> = serde_json::from_value(world["plugins"].clone()).expect("the plugins read");
    let firing = Stand { schemas: &schemas };
    let (mut programs, mut regions_seen, mut replies, mut messages, mut data, mut priced) = (0, 0, 0, 0, 0, 0);
    let (mut prototype_replies, mut prototyped) = (0, 0);

    for case in &cases[1..] {
        match case["kind"].as_str().unwrap() {
            "program" => {
                programs += 1;
                let source = case["source"].as_str().unwrap();
                let root = program::parse(source, 3).unwrap_or_else(|e| panic!("{source}\n{e}"));
                let answer = json!({ "diagnostics": [], "stamps": [], "link": case["link"] });
                let checked = program::join_check(root, &answer, 3).expect("the link joins");
                let built = ready(spec::build_extract_spec(extraction_of(&checked.root.program), &checked.declarations, &firing));
                if let Some(error) = case.get("error") {
                    let Err(SpecError::Runtime(message)) = built else { panic!("{source}\nexpected {error}, built {built:?}") };
                    assert_eq!(format!("MOVENG_RUNTIME: {message}"), error.as_str().unwrap(), "{source}");
                    continue;
                }
                let spec = built.unwrap_or_else(|e| panic!("{source}\n{e:?}"));
                assert_eq!(spec.to_json(), case["spec"], "{source}");
                let regions = regions_of(&spec);
                let expected = case["regions"].as_array().unwrap();
                assert_eq!(regions.len(), expected.len(), "{source}");
                for (region, expected) in regions.iter().zip(expected) {
                    regions_seen += 1;
                    assert_eq!(region_json(region), expected["region"], "{source}");
                    assert_eq!(region.sites(), expected["sites"].as_u64().unwrap() as usize);
                    assert_eq!(prompt::system_prompt(region), expected["system"].as_str().unwrap(), "{source}");
                    assert_eq!(validate::envelope_example(region), expected["envelope"].as_str().unwrap());
                    for reply in expected["replies"].as_array().unwrap() {
                        replies += 1;
                        let text = reply["reply"].as_str().unwrap();
                        let verdict = &reply["verdict"];
                        let read = validate::read_reply(region, &reply_of(text));
                        if text.contains("__proto__") || text.contains("constructor") {
                            prototype_replies += 1;
                        }
                        match (read, verdict.get("data")) {
                            (Ok(read), Some(expected_data)) => {
                                // A prototype zod gave a record is written back as
                                // its `__proto__` key, last, on both sides.
                                let restored = restored(&read.value);
                                assert_eq!(&json_of_js(&restored), expected_data, "{source}\n{text}");
                                assert_eq!(js::json_stringify(&restored, 0), verdict["dataText"].as_str().unwrap(), "{text}");
                                if verdict.get("prototype").is_some() {
                                    prototyped += 1;
                                }
                                assert_eq!(pairs(&read.coercions.values), verdict["coerced"], "{text}");
                                assert_eq!(pairs(&read.coercions.evidence), verdict["evidenceCoerced"], "{text}");
                                assert_eq!(json!(read.coercions.envelope), verdict["envelope"], "{text}");
                            }
                            (Err(issues), None) => {
                                assert_eq!(issues_json(&issues), verdict["issues"], "{source}\n{text}");
                                assert_eq!(prompt::retry_user_message("", region, &issues), verdict["retry"].as_str().unwrap(), "{text}");
                                assert_eq!(validate::unanswered_detail(region, &reply_of(text), &issues), verdict["detail"].as_str().unwrap(), "{text}");
                            }
                            (read, _) => panic!("{source}\n{text}\nRust read {read:?}, TypeScript {verdict}"),
                        }
                    }
                }
            }
            "message" => {
                messages += 1;
                let segments: Vec<Segment> = case["segments"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| Segment { classification: s["classification"].as_str().unwrap().into(), content: s["content"].as_str().unwrap().into() })
                    .collect();
                let entity = case.get("entity").map(|entity| Entity {
                    description: entity["description"].as_str().unwrap().into(),
                    context: reply_of(entity["context"].as_str().unwrap()),
                    enrichments: entity["enrichments"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|e| Enrichment {
                            plugin: e["plugin"].as_str().unwrap().into(),
                            text: e.get("text").map(|t| t.as_str().unwrap().into()),
                            data: e.get("data").map(|d| reply_of(d.as_str().unwrap())),
                        })
                        .collect(),
                });
                let rendered = prompt::user_message(&segments, entity.as_ref());
                assert_eq!(rendered.text, case["text"].as_str().unwrap());
                let parts: Vec<Json> = rendered.parts.iter().map(|(c, n)| json!({ "classification": c, "chars": n })).collect();
                assert_eq!(Json::Array(parts), case["parts"]);
            }
            "datum" => {
                data += 1;
                let datum = reply_of(case["datum"].as_str().unwrap());
                let segment = prompt::segment_for_datum(&datum);
                assert_eq!(json!({ "classification": segment.classification, "content": segment.content }), case["segment"], "{}", case["datum"]);
                if let Some(expected) = case.get("asPlugin") {
                    let segments = match &datum {
                        Js::String(text) => prompt::plugin_segments(Some(text.as_form()), None),
                        object => prompt::plugin_segments(None, Some(object)),
                    };
                    let got: Vec<Json> = segments.iter().map(|s| json!({ "classification": s.classification, "content": s.content })).collect();
                    assert_eq!(&Json::Array(got), expected, "{}", case["datum"]);
                }
            }
            "priced" => {
                priced += 1;
                let spend: Spend = serde_json::from_value(case["spend"].clone()).unwrap();
                let ledger = Ledger::new(&spend);
                ledger.charge(Some(&case["charges"])).unwrap();
                let plugin = case["plugin"].as_str().unwrap();
                match (ledger.plugin_refusal(&plugins, plugin), case.get("refused")) {
                    (Some(cap), Some(refused)) => {
                        assert_eq!(cap.to_json()["class"], refused["class"], "{case}");
                        assert_eq!(cap.message(), refused["message"].as_str().unwrap(), "{case}");
                        assert_eq!(json!(cap.cap_microdollars), json!(refused["capMicrodollars"].as_f64().unwrap()), "{case}");
                        assert_eq!(json!(cap.spent_microdollars), json!(refused["spentMicrodollars"].as_f64().unwrap()), "{case}");
                        assert_eq!(case["asked"], json!([]), "a refused plugin's host is asked nothing");
                    }
                    (None, None) => {
                        let asked = &case["asked"].as_array().unwrap()[0];
                        assert_eq!(json!(ledger.budget()["remainingMicrodollars"].as_f64()), json!(asked["remainingMicrodollars"].as_f64()), "{case}");
                        ledger.charge(Some(&case["answerCost"])).unwrap();
                    }
                    (refusal, _) => panic!("{case}\nRust {refusal:?}"),
                }
                let lines = ledger.cost_lines();
                let segment: f64 = lines.iter().map(|l| l.microdollars).sum();
                let account = &case["account"];
                assert_eq!(segment, account["segmentMicrodollars"].as_f64().unwrap(), "{case}");
                assert_eq!(spend.prior_microdollars + segment, account["runMicrodollars"].as_f64().unwrap(), "{case}");
                let by_source: Vec<(String, f64)> = lines.iter().map(|l| (l.source.clone(), l.microdollars)).collect();
                let expected: Vec<(String, f64)> =
                    account["bySource"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_f64().unwrap())).collect();
                let mut sorted = by_source.clone();
                sorted.sort_by(|a, b| a.0.cmp(&b.0));
                assert_eq!(sorted, expected, "{case}");
            }
            other => panic!("an oracle case of kind {other}"),
        }
    }
    // A pin that silently lost its cases would hold nothing.
    assert!(programs >= 160 && regions_seen >= 300 && replies >= 1500 && messages >= 100 && data >= 15 && priced >= 80);
    // Program 0's replies with prototype-named fields: every one is held to
    // TypeScript's verdict as it stands, those whose read set a prototype too.
    assert!(prototype_replies >= 16 && prototyped >= 3, "{prototype_replies} prototype replies, {prototyped} prototyped");
}
