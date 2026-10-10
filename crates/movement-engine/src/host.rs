//! The requests a segment makes of its host, one builder per host call, named
//! after the `EngineHost` groups (apps/api/src/services/movement_engine/
//! host.ts, docs/contracts/host-families.md). A builder is the only place a request's
//! shape is written: the executor carries `{family, method, args}` without
//! reading them, and the TypeScript shim routes on the same pair, so a shape
//! change touches a builder and its route and nothing between.

use std::rc::Rc;

use serde::Serialize;
use serde_json::{Value as Json, json};

/// The `EngineHost` families a request can address (docs/contracts/host-families.md;
/// host.ts `HOST_FAMILIES`), spelled as the manifest spells them, plus the
/// ones that are this engine's own and never reach an `EngineHost`: `Check`
/// (the TypeScript checker, until the checker is Rust), `Builtins` (the
/// TypeScript standard library, for the readings this engine hands back),
/// and in test builds only `Echo` (the protocol's own probe, served by no
/// host).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Adapters,
    Llm,
    LlmClient,
    LlmTransforms,
    ParkSink,
    ControlCancel,
    Locks,
    Trace,
    Clock,
    Files,
    Ids,
    Check,
    Builtins,
    Log,
    #[cfg(test)]
    Echo,
}

const FAMILIES: &[Family] = &[
    Family::Adapters,
    Family::Llm,
    Family::LlmClient,
    Family::LlmTransforms,
    Family::ParkSink,
    Family::ControlCancel,
    Family::Locks,
    Family::Trace,
    Family::Clock,
    Family::Files,
    Family::Ids,
    Family::Check,
    Family::Builtins,
    Family::Log,
    #[cfg(test)]
    Family::Echo,
];

impl Family {
    pub fn as_str(self) -> &'static str {
        match self {
            Family::Adapters => "adapters",
            Family::Llm => "llm",
            Family::LlmClient => "llm.client",
            Family::LlmTransforms => "llm.transforms",
            Family::ParkSink => "park.sink",
            Family::ControlCancel => "control.cancel",
            Family::Locks => "locks",
            Family::Trace => "trace",
            Family::Clock => "clock",
            Family::Files => "files",
            Family::Ids => "ids",
            Family::Check => "check",
            Family::Builtins => "builtins",
            Family::Log => "log",
            #[cfg(test)]
            Family::Echo => "echo",
        }
    }

    pub fn parse(name: &str) -> Option<Family> {
        FAMILIES.iter().copied().find(|family| family.as_str() == name)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub family: Family,
    pub method: String,
    pub args: Json,
}

/// An adapter instance as `adapters.resolve` answered it: its opaque id,
/// meaningful only within the segment, and the methods it implements (an
/// optional member such as `readRecord` is asked of this list, never of the
/// host).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instance {
    pub id: String,
    pub methods: Rc<Vec<String>>,
}

impl Instance {
    pub fn has(&self, method: &str) -> bool {
        self.methods.iter().any(|m| m == method)
    }
}

/// `adapters.resolve`'s request, as docs/contracts/host-families.md writes it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveAdapter {
    /// The instance's slug as the binding holds it (a dict's may be no
    /// text, and the TypeScript hands the host what it holds).
    pub adapter_type: Json,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credentials_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub construction_args: Option<std::collections::BTreeMap<String, String>>,
    pub role: Role,
    /// A target whose writes are rehearsed: the host captures them into its
    /// write sink and never makes them.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Source,
    Target,
}

/// Every request but `check`'s and `builtins`' names the segment it is made
/// in: the id the run host's `segment.open` answered, handed to this engine
/// in its input.
fn in_segment(segment: &str, mut args: Json) -> Json {
    if let Some(object) = args.as_object_mut() {
        object.insert("segmentId".into(), json!(segment));
    }
    args
}

pub mod adapters {
    use super::*;

    /// Answered with the instance as data (crate::host::instance_of).
    pub fn resolve(segment: &str, input: &ResolveAdapter) -> Request {
        let args = serde_json::to_value(input).expect("a ResolveAdapter is always JSON");
        Request { family: Family::Adapters, method: "resolve".into(), args: in_segment(segment, args) }
    }

    /// One call into an instance: the method and its one argument object
    /// (the adapter protocol's `params`), answered `{result}` or `{error:
    /// {kind, message, name?, detail?}}`. `args` and `result` cross on the
    /// eval wire (crate::env, `wire: true`): key order, `undefined` and the
    /// numbers JSON cannot say cross as the JavaScript has them, so the host
    /// is handed exactly what the TypeScript engine hands it.
    pub fn call(segment: &str, instance: &Instance, method: &str, args: Json) -> Request {
        Request {
            family: Family::Adapters,
            method: "call".into(),
            args: in_segment(segment, json!({ "instance": instance.id, "method": method, "args": args, "wire": true })),
        }
    }

    /// A call whose argument object leads with a `position`, sent by handle:
    /// `positionRef` names a position the segment registered with its host,
    /// and `position` (on the eval wire) registers it, on the first call that
    /// names it. `args` is the rest of the argument object; the host's
    /// adapter receives `{position, ...args}` (the shim, rust_host.ts, keeps
    /// the segment's positions). A read re-sends a handle, not the record.
    pub fn call_at(segment: &str, instance: &Instance, method: &str, position: PositionArg, args: Json) -> Request {
        let mut request = call(segment, instance, method, args);
        request.args["positionRef"] = json!(position.reference);
        if let Some(value) = position.value {
            request.args["position"] = value;
        }
        request
    }

    /// A position by handle: its number in the segment, and the position
    /// itself the first time it is named.
    pub struct PositionArg {
        pub reference: u32,
        pub value: Option<Json>,
    }
}

pub mod llm {
    use super::*;

    /// The identity judge over a write's candidates (`arbitrateEntities`), a
    /// priced call: the run's `budget` goes in, values on the eval wire;
    /// answered `{index: number | null, judgeUnavailable?, cost?}` or a
    /// budget refusal `{error: {kind: "budget", message}, cost?}`.
    pub fn arbitrate_entities(segment: &str, arbitration: Arbitration, budget: Json) -> Request {
        let Arbitration { asserted, candidates, record_type, constraints, language_version } = arbitration;
        Request {
            family: Family::Llm,
            method: "arbitrateEntities".into(),
            args: in_segment(
                segment,
                json!({
                    "asserted": asserted,
                    "candidates": candidates,
                    "recordType": record_type,
                    "constraints": constraints,
                    "languageVersion": language_version,
                    "budget": budget,
                }),
            ),
        }
    }

    /// An extraction region's model call (`llm.client.call`), a priced call:
    /// the run's `budget` goes in; answered on the eval wire (`wire: true`:
    /// the reply's `parsedJson` keeps the key order and the numbers the model
    /// wrote, as `JSON.parse` made them) with `{parsedJson, rawText?,
    /// effortSteppedDown?, continuations?, cost?}`, or a budget refusal.
    pub fn client_call(segment: &str, call: ClientCall<'_>, budget: Json) -> Request {
        let ClientCall { system, user_message, label, model, effort, max_tokens } = call;
        let mut args = json!({ "system": system, "userMessage": user_message, "label": label, "model": model, "effort": effort, "budget": budget, "wire": true });
        if let Some(max_tokens) = max_tokens {
            args["maxTokens"] = json!(max_tokens);
        }
        Request { family: Family::LlmClient, method: "call".into(), args: in_segment(segment, args) }
    }

    /// What one model call is asked.
    pub struct ClientCall<'a> {
        pub system: &'a str,
        pub user_message: &'a str,
        pub label: &'a str,
        pub model: &'a str,
        pub effort: &'a str,
        pub max_tokens: Option<u64>,
    }

    /// A plugin invocation (`llm.transforms.invoke`), a priced call: the
    /// plugin as registered, its arguments and the entity's fields so far on
    /// the eval wire; answered on the wire with `{text?, data?, records?,
    /// outcome?, cost?}`, or a budget refusal.
    pub fn transforms_invoke(segment: &str, plugin: &str, config: Json, extracted_context: Json, budget: Json) -> Request {
        Request {
            family: Family::LlmTransforms,
            method: "invoke".into(),
            args: in_segment(
                segment,
                json!({ "plugin": plugin, "config": config, "extractedContext": extracted_context, "budget": budget, "wire": true }),
            ),
        }
    }

    /// What the judge is asked.
    pub struct Arbitration<'a> {
        pub asserted: Json,
        pub candidates: Json,
        pub record_type: &'a str,
        pub constraints: Json,
        pub language_version: u32,
    }
}

pub mod locks {
    use super::*;

    /// The segment's cross-run write locks, taken by name (sorted, each
    /// once): answered `{token}` once held.
    pub fn acquire(segment: &str, names: &[String]) -> Request {
        Request { family: Family::Locks, method: "acquire".into(), args: in_segment(segment, json!({ "names": names })) }
    }

    /// What one earlier `acquire` took, given back by its token.
    pub fn release(segment: &str, token: &str) -> Request {
        Request { family: Family::Locks, method: "release".into(), args: in_segment(segment, json!({ "token": token })) }
    }
}

pub mod park {
    use super::*;

    /// A timer park (`sleep`): the leaf's address, its `ParkedScopeState`
    /// (on the eval wire, so its objects keep their key order, `wire:
    /// true`), and when to wake it, an ISO 8601 instant.
    pub fn commit_timer_park(segment: &str, address: &str, state: Json, wake_at: &str) -> Request {
        Request {
            family: Family::ParkSink,
            method: "commitTimerPark".into(),
            args: in_segment(segment, json!({ "address": address, "state": state, "wakeAt": wake_at, "wire": true })),
        }
    }

    /// An engine-initiated suspension (`suspendFlow`): the leaf's address and
    /// its suspended `ParkedScopeState`, on the eval wire. Asked only of a
    /// host that serves it (`SegmentInput::serves`).
    pub fn commit_suspension(segment: &str, address: &str, state: Json) -> Request {
        Request {
            family: Family::ParkSink,
            method: "commitSuspension".into(),
            args: in_segment(segment, json!({ "address": address, "state": state, "wire": true })),
        }
    }

    /// The run is pausing at its cost cap: what it spent against the cap.
    /// Asked only of a host that serves it and can suspend.
    pub fn commit_limit_pause(segment: &str, cap: &crate::ledger::CapExceeded) -> Request {
        Request {
            family: Family::ParkSink,
            method: "commitLimitPause".into(),
            args: in_segment(
                segment,
                json!({ "limit": "cost", "capMicrodollars": cap.cap_microdollars, "spentMicrodollars": cap.spent_microdollars }),
            ),
        }
    }
}

pub mod control {
    use super::*;

    /// The cancel gate at a statement boundary: answered true once a cancel
    /// is requested.
    pub fn cancelled(segment: &str) -> Request {
        Request { family: Family::ControlCancel, method: "cancelled".into(), args: in_segment(segment, json!({})) }
    }

    /// The run's last cancel check, undebounced.
    pub fn cancelled_now(segment: &str) -> Request {
        Request { family: Family::ControlCancel, method: "cancelledNow".into(), args: in_segment(segment, json!({})) }
    }
}

pub mod trace {
    use super::*;

    /// Entries appended to the run's trace as they land. `closing` marks the
    /// hand-over as the segment ends (the shim's own marker, never the
    /// host's): its failure is logged, not the run's.
    pub fn append(segment: &str, entries: &[crate::trace::TraceEntry], closing: bool) -> Request {
        // On the eval wire, so each entry's members keep the TypeScript's
        // order (serde's maps sort them).
        let entries = crate::env::encode_plain(&crate::js::Js::array(entries.iter().map(crate::trace::TraceEntry::to_js).collect()));
        let mut args = json!({ "entries": entries, "wire": true });
        if closing {
            args["closing"] = json!(true);
        }
        Request { family: Family::Trace, method: "append".into(), args: in_segment(segment, args) }
    }
}

pub mod clock {
    use super::*;

    /// The host's instant now, answered `{nowIso}`: the engine reads no
    /// clock of its own.
    pub fn now(segment: &str) -> Request {
        Request { family: Family::Clock, method: "now".into(), args: in_segment(segment, json!({})) }
    }

    /// The instant a `clock.now` answer names, in milliseconds since the
    /// epoch; `None` for an answer that names none.
    pub fn instant_of(answer: Option<&Json>) -> Option<f64> {
        match crate::js_date::parse(answer?.get("nowIso")?.as_str()?) {
            crate::js_date::Parsed::Valid(ms) => Some(ms),
            _ => None,
        }
    }
}

pub mod files {
    use super::*;

    /// A source file's text (`files.resolveFileText`), a priced call: the
    /// descriptor on the eval wire; answered on the wire with `{text,
    /// rawTextId?}` or `{unreadable, detail?}`, and `cost?`, or a budget
    /// refusal.
    pub fn resolve_file_text(segment: &str, file: Json, budget: Json) -> Request {
        Request {
            family: Family::Files,
            method: "resolveFileText".into(),
            args: in_segment(segment, json!({ "file": file, "budget": budget, "wire": true })),
        }
    }
}

pub mod ids {
    use super::*;

    /// `count` fresh ids (`ids.mint`, `count` ≥ 1), answered as that many
    /// distinct texts: the engine mints none of its own.
    pub fn mint(segment: &str, count: usize) -> Request {
        Request { family: Family::Ids, method: "mint".into(), args: in_segment(segment, json!({ "count": count })) }
    }
}

pub mod builtins {
    use super::*;

    /// A built-in this engine hands back for these arguments, answered by
    /// the TypeScript member: `{id, args, now, languageVersion}`, values on
    /// the eval wire, the answer too.
    pub fn function(id: &str, args: Vec<Json>, now: &str, language_version: u32) -> Request {
        Request {
            family: Family::Builtins,
            method: "function".into(),
            args: json!({ "id": id, "args": args, "now": now, "languageVersion": language_version }),
        }
    }

    /// The shared comparator (`compareValues`), likewise. `now` (an ISO
    /// 8601 instant, the host clock's answer) is what a `WITHIN` measures
    /// recency from, and only a `WITHIN` carries it.
    pub fn compare(op: &str, left: Json, right: Json, now: Option<&str>) -> Request {
        let mut args = json!({ "op": op, "left": left, "right": right });
        if let Some(now) = now {
            args["now"] = json!(now);
        }
        Request { family: Family::Builtins, method: "compare".into(), args }
    }
}

pub mod log {
    use super::*;

    /// Lines on the platform's log (`logger.info` / `logger.warn`), each
    /// `{level, message, fields}`, the run they belong to added by the
    /// shim: what the TypeScript engine logs, sent as a statement ends so a
    /// line costs no yield inside a fan.
    pub fn write(lines: Vec<Json>) -> Request {
        Request { family: Family::Log, method: "write".into(), args: json!({ "lines": lines }) }
    }
}

pub mod check {
    use super::*;

    /// The pinned source checked against the run's snapshot (the host's,
    /// which the segment was handed too): answered
    /// `{diagnostics, link?, stamps}` (crate::program reads it). A program
    /// that fails its check never gets an answer: the host ends the run with
    /// MOVENG_CHECK, as the TypeScript engine does before it runs anything.
    pub fn program(source: &str, language_version: u32, upgrading_from: Option<u32>) -> Request {
        let mut args = json!({ "source": source, "languageVersion": language_version });
        if let Some(from) = upgrading_from {
            args["upgradingFrom"] = json!(from);
        }
        Request { family: Family::Check, method: "program".into(), args }
    }
}

/// The instance a `resolve` answer describes.
pub fn instance_of(answer: &Json) -> Option<Instance> {
    let id = answer.get("instance").and_then(Json::as_str)?.to_string();
    let methods = answer
        .get("methods")
        .and_then(Json::as_array)?
        .iter()
        .map(|m| m.as_str().map(String::from))
        .collect::<Option<Vec<_>>>()?;
    Some(Instance { id, methods: Rc::new(methods) })
}

/// An `adapters.call` answer read: the result (still on the eval wire), or
/// the host's error as data.
pub enum CallAnswer {
    Result(Option<Json>),
    Error(Json),
}

pub fn call_answer(answer: Option<Json>) -> Result<CallAnswer, String> {
    let Some(Json::Object(mut envelope)) = answer else {
        return Err("an adapters.call answer is {result} or {error}".into());
    };
    match (envelope.remove("result"), envelope.remove("error")) {
        (result, None) if envelope.is_empty() => Ok(CallAnswer::Result(result)),
        (None, Some(error)) if error.get("message").is_some_and(Json::is_string) => Ok(CallAnswer::Error(error)),
        _ => Err("an adapters.call answer is {result} or {error: {kind, message}}".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builders_write_the_shapes_the_host_contract_names() {
        let resolve = adapters::resolve(
            "g1",
            &ResolveAdapter { adapter_type: Json::from("attio"), credentials_id: None, construction_args: None, role: Role::Target, dry_run: false },
        );
        assert_eq!((resolve.family.as_str(), resolve.method.as_str()), ("adapters", "resolve"));
        assert_eq!(resolve.args, json!({ "segmentId": "g1", "adapterType": "attio", "role": "target" }));
        let instance = instance_of(&json!({ "instance": "i3", "methods": ["readRecord"] })).unwrap();
        assert!(instance.has("readRecord") && !instance.has("linkRecords"));
        let call = adapters::call("g1", &instance, "readRecord", json!({ "recordId": "r1" }));
        assert_eq!(
            call.args,
            json!({ "segmentId": "g1", "instance": "i3", "method": "readRecord", "args": { "recordId": "r1" }, "wire": true })
        );
        assert_eq!(locks::acquire("g1", &["a".into()]).args, json!({ "segmentId": "g1", "names": ["a"] }));
        assert_eq!(locks::release("g1", "t1").args, json!({ "segmentId": "g1", "token": "t1" }));
        let cancel = control::cancelled("g1");
        assert_eq!((cancel.family.as_str(), cancel.args.clone()), ("control.cancel", json!({ "segmentId": "g1" })));
        assert_eq!(park::commit_timer_park("g1", "s0", json!(null), "2026-01-01T00:00:00.000Z").family.as_str(), "park.sink");
        let now = clock::now("g1");
        assert_eq!((now.family.as_str(), now.method.as_str(), now.args.clone()), ("clock", "now", json!({ "segmentId": "g1" })));
        assert_eq!(clock::instant_of(Some(&json!({ "nowIso": "2026-01-01T00:00:01.000Z" }))), Some(1_767_225_601_000.0));
        assert_eq!(clock::instant_of(Some(&json!({ "nowIso": "soon" }))), None);
        assert_eq!(clock::instant_of(Some(&json!({ "now": "2026-01-01T00:00:01.000Z" }))), None);
        let within = builtins::compare("within", json!(1), json!("1d"), Some("2026-01-01T00:00:00.000Z"));
        assert_eq!(within.args["now"], json!("2026-01-01T00:00:00.000Z"));
        assert!(builtins::compare("eq", json!(1), json!(1), None).args.get("now").is_none());
        let check = check::program("src", 3, None);
        assert_eq!((check.family.as_str(), check.method.as_str()), ("check", "program"));
        assert_eq!(check.args, json!({ "source": "src", "languageVersion": 3 }));
    }

    #[test]
    fn an_adapter_call_answers_a_result_or_an_error() {
        assert!(matches!(call_answer(Some(json!({ "result": 1 }))), Ok(CallAnswer::Result(Some(_)))));
        assert!(matches!(call_answer(Some(json!({}))), Ok(CallAnswer::Result(None))));
        assert!(matches!(call_answer(Some(json!({ "error": { "kind": "adapter_error", "message": "m" } }))), Ok(CallAnswer::Error(_))));
        assert!(call_answer(Some(json!({ "error": {} }))).is_err());
        assert!(call_answer(None).is_err());
    }

    #[test]
    fn every_family_parses_back_from_its_name() {
        for name in ["adapters", "llm", "llm.client", "llm.transforms", "park.sink", "control.cancel", "locks", "trace", "clock", "files", "ids", "check", "builtins", "log", "echo"] {
            assert_eq!(Family::parse(name).map(Family::as_str), Some(name));
        }
        assert_eq!(Family::parse("nope"), None);
    }
}
