//! One engine segment, driven natively: the Rust movement engine
//! (crates/movement-engine) linked into this binary, its requests served
//! from the local run host. A port of the TypeScript host's shim
//! (movement-engine `movement_engine/rust_engine.ts` drives the segment,
//! `rust_host.ts` routes each request), over the same JSON texts the WASM
//! boundary carries (`abi.rs`), so the engine sees exactly what it sees
//! there: the segment input, each answer as `{value}`, `{}` or `{error}`, and
//! each step out as the sorted JSON the artifact writes.
//!
//! Every request the engine issues is served concurrently; every answer
//! already settled is handed over before any request it leads to is served
//! (the TypeScript shim's settle queue).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use serde_json::{Value as Json, json};

use crate::documents::Documents;
use crate::file_ref::{descriptor_of, field_type_of, files_at_type, owner_of, Owner};
use crate::json::{Js, Obj};
use crate::obj;
use crate::remote::{ADAPTER_METHODS, SegmentAdapters};
use crate::run_host::{arm_timer_wake, cancel_subtrees, queue_await_wake, save_source, settle_if_cancel_requested};
use crate::store::{Store, StoreError};
use crate::wire::{Hv, Wire, js_of_json, json_of_js};

/// The one tenant a local project is (`LOCAL_TENANT`).
pub const TEAM: &str = "local";

/// The host methods this host serves, by path: the engine asks an optional
/// one only of a host that lists it. The callback family (`park.callbacks`)
/// is not served yet, nor is a cost-cap pause (`commitLimitPause`), which the
/// TypeScript lf does not serve either.
const SERVES: &[&str] = &[
    "segment.open",
    "segment.close",
    "adapters.resolve",
    "adapters.call",
    "llm.client.call",
    "llm.extractCall.call",
    "llm.transforms.invoke",
    "llm.arbitrateEntities",
    "park.sink.recordJoin",
    "park.sink.commitTimerPark",
    "park.sink.commitAwaitPark",
    "park.sink.decrementJoin",
    "park.sink.persistBranchExport",
    "park.sink.collectBranchExports",
    "park.sink.cancelSubtrees",
    "park.sink.commitSuspension",
    "park.wake",
    "park.sources.save",
    "park.sources.load",
    "park.bindings.record",
    "park.bindings.findBoundCounterpart",
    "park.bindings.delete",
    "control.cancel.cancelled",
    "control.cancel.cancelledNow",
    "files.resolveFileText",
    "files.render",
    "lookup.resolveActingUser",
    "locks.acquire",
    "locks.release",
    "trace.append",
    "clock.now",
    "ids.mint",
];

/// The chat models a run is held to (`runChatModels` over the model
/// registry's Anthropic list). THIN until lf-host calls models (G6): the
/// TypeScript lf's list, as its registry names it today.
const RUN_CHAT_MODELS: &[&str] = &[
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
];

/// The trace entry kinds the engine appends (`traceEntry`).
const TRACE_KINDS: &[&str] = &["gate", "warning", "block", "read", "ai", "extraction", "plugin", "chunks", "field_miss"];

/// What a segment is entered as (`Resumption`).
pub enum Entry {
    /// A fresh firing.
    Run,
    /// A parked leaf resumed: re-entered, or stepped past.
    Resume { state: Js, reenter: bool },
    /// A race a batch resume deferred, settled.
    Settle { state: Js, frame_address: String },
}

/// What a segment runs: the run's facts and how it is entered.
pub struct SegmentInput<'a> {
    pub source: &'a str,
    pub language_version: u32,
    pub movement_name: &'a str,
    /// The trigger event, as data.
    pub event: &'a Js,
    pub fired_at: &'a str,
    pub catalog: &'a Js,
    pub dry_run: bool,
    pub entry: Entry,
}

/// What a segment that ran came to.
pub struct Ran {
    pub writes: usize,
    pub parked_address: Option<String>,
    pub cancelled: bool,
    pub deferred_race_frames: Vec<String>,
    /// A rehearsal's captured writes.
    pub captured: Vec<Js>,
}

/// Why a segment did not run to a result.
pub enum Ended {
    /// The run failed, with this message (`runFailureCause(error).message`).
    Failed(String),
    /// A fenced write found the run's lease gone.
    LeaseLost,
}

/// A host call that failed: what the engine is answered with, and what the
/// run fails with if the engine fails it.
struct HostFailure {
    message: String,
    name: Option<String>,
    lease_lost: bool,
}

/// A fault in this host itself: the run fails, the engine is never answered.
struct Fault(String);

impl From<String> for Fault {
    fn from(message: String) -> Fault {
        Fault(message)
    }
}

/// What the host serves a segment from.
pub struct SegmentHost<'s> {
    pub segment_id: String,
    pub run_id: String,
    pub fence: Option<String>,
    pub store: &'s Store,
    pub adapters: SegmentAdapters<'s>,
    pub documents: &'s Documents,
    /// The acting user every event acts as (`localIdentity`).
    pub user: Js,
    wire: RefCell<Wire>,
    positions: RefCell<HashMap<i64, Hv>>,
    host_errors: RefCell<Vec<HostFailure>>,
    cancelled: Cell<bool>,
    lock_tokens: RefCell<HashMap<String, Vec<String>>>,
    next_lock: Cell<u64>,
}

impl<'s> SegmentHost<'s> {
    pub fn new(input: SegmentHostParts<'s>) -> SegmentHost<'s> {
        SegmentHost {
            segment_id: input.segment_id,
            run_id: input.run_id,
            fence: input.fence,
            store: input.store,
            adapters: input.adapters,
            documents: input.documents,
            user: input.user,
            wire: RefCell::new(Wire::default()),
            positions: RefCell::new(HashMap::new()),
            host_errors: RefCell::new(Vec::new()),
            cancelled: Cell::new(false),
            lock_tokens: RefCell::new(HashMap::new()),
            next_lock: Cell::new(0),
        }
    }
}

pub struct SegmentHostParts<'s> {
    pub segment_id: String,
    pub run_id: String,
    pub fence: Option<String>,
    pub store: &'s Store,
    pub adapters: SegmentAdapters<'s>,
    pub documents: &'s Documents,
    pub user: Js,
}

/// A number from the environment, positive and finite, else `default`.
fn knob(name: &str, default: f64) -> f64 {
    std::env::var(name).ok().and_then(|v| v.trim().parse::<f64>().ok()).filter(|n| n.is_finite() && *n > 0.0).unwrap_or(default)
}

/// The segment's input text (`segmentInput`).
fn input_text(host: &SegmentHost<'_>, input: &SegmentInput<'_>) -> Result<String, String> {
    let mut wire = host.wire.borrow_mut();
    let event = wire.write(&Hv::of_js(input.event));
    let mut segment = serde_json::Map::new();
    segment.insert("entry".into(), json!("segment"));
    if input.dry_run {
        segment.insert("dryRun".into(), json!(true));
    }
    let (state, reenter, settle) = match &input.entry {
        Entry::Run => (None, false, None),
        Entry::Resume { state, reenter } => (Some(state), *reenter, None),
        Entry::Settle { state, frame_address } => (Some(state), false, Some(frame_address)),
    };
    if let Some(state) = state {
        // A parked state's files are made host-side, in the segment's file
        // table: the engine is handed their handles, never their descriptors.
        let mut state = Hv::of_js(state);
        crate::park_files::in_park_state(&mut wire, &mut state);
        let mut resume = serde_json::Map::new();
        resume.insert("state".into(), wire.write(&state));
        if reenter {
            resume.insert("reenter".into(), json!(true));
        }
        if matches!(input.entry, Entry::Resume { .. }) {
            resume.insert("deferRaceSettlement".into(), json!(true));
        }
        segment.insert("resume".into(), Json::Object(resume));
    }
    if let Some(frame_address) = settle {
        segment.insert("settle".into(), json!({ "frameAddress": frame_address }));
    }
    segment.insert("source".into(), json!(input.source));
    segment.insert("nativeCheck".into(), json!(true));
    segment.insert("snapshotModels".into(), input.catalog.get("models").map(json_of_js).unwrap_or(Json::Null));
    segment.insert("languageVersion".into(), json!(input.language_version));
    segment.insert("movementName".into(), json!(input.movement_name));
    segment.insert("event".into(), event);
    segment.insert("segmentId".into(), json!(host.segment_id));
    let credential_ids: serde_json::Map<String, Json> = input
        .catalog
        .get("credentials")
        .and_then(|c| match c {
            Js::Obj(map) => Some(map.keys().map(|name| (name.clone(), json!(name))).collect()),
            _ => None,
        })
        .unwrap_or_default();
    segment.insert("credentialIds".into(), Json::Object(credential_ids));
    segment.insert("spend".into(), json!({ "priorMicrodollars": 0, "capBaselineMicrodollars": 0 }));
    segment.insert("now".into(), json!(input.fired_at));
    segment.insert("serves".into(), json!(SERVES));
    segment.insert("extractionFileChars".into(), json!(knob("EXTRACTION_FILE_CHARS", 50_000.0)));
    segment.insert("maxCallDepth".into(), json!(max_call_depth()?));
    segment.insert("extractionTiers".into(), json!({}));
    // The catalog last, as text: its maps are read in their own order.
    let mut catalog = match input.catalog {
        Js::Obj(map) => map.clone(),
        _ => return Err("the catalog snapshot is not an object".into()),
    };
    catalog.insert("models".into(), Js::strings(RUN_CHAT_MODELS));
    let head = Json::Object(segment).to_string();
    Ok(format!("{},\"catalog\":{}}}", &head[..head.len() - 1], Js::Obj(catalog).to_json()))
}

/// Run one segment to its result.
pub async fn run_segment(host: &SegmentHost<'_>, input: SegmentInput<'_>) -> Result<Ran, Ended> {
    let text = input_text(host, &input).map_err(Ended::Failed)?;
    let done = match drive(host, &text).await {
        Ok(done) => done,
        Err(Fault(message)) => return Err(Ended::Failed(message)),
    };
    read_result(host, &done)
}

type Served<'a> = Pin<Box<dyn Future<Output = (u32, Result<Json, Fault>)> + 'a>>;

/// The requests in flight, polled together.
struct InFlight<'a> {
    futures: Vec<Served<'a>>,
}

impl<'a> InFlight<'a> {
    fn poll_any(&mut self, cx: &mut Context<'_>) -> Poll<(u32, Result<Json, Fault>)> {
        for i in 0..self.futures.len() {
            if let Poll::Ready(settled) = self.futures[i].as_mut().poll(cx) {
                drop(self.futures.swap_remove(i));
                return Poll::Ready(settled);
            }
        }
        Poll::Pending
    }

    async fn next(&mut self) -> (u32, Result<Json, Fault>) {
        std::future::poll_fn(|cx| self.poll_any(cx)).await
    }

    /// One already settled, without waiting.
    fn ready(&mut self) -> Option<(u32, Result<Json, Fault>)> {
        let mut cx = Context::from_waker(std::task::Waker::noop());
        match self.poll_any(&mut cx) {
            Poll::Ready(settled) => Some(settled),
            Poll::Pending => None,
        }
    }
}

/// The engine's step, as the artifact writes it: sorted JSON, its texts
/// out of the engine's form.
fn step_json(step: Result<movement_engine::executor::Step, movement_engine::executor::ProtocolError>, call: &str) -> Result<Json, Fault> {
    let step = step.map_err(|e| Fault(format!("the Rust engine refused {call}: {}", e.0)))?;
    let bytes = movement_parser::util::form::external_bytes(movement_parser::to_sorted_json(&step));
    serde_json::from_slice(&bytes).map_err(|e| Fault(format!("the Rust engine's {call} is not JSON: {e}")))
}

fn engine_call<T>(call: &str, body: impl FnOnce() -> T) -> Result<T, Fault> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)).map_err(|panic| {
        let message = panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
        Fault(format!("the Rust engine panicked in {call}: {message}"))
    })
}

/// `driveEngine`: start the segment, serve every request it issues, answer
/// each as it settles.
async fn drive(host: &SegmentHost<'_>, input: &str) -> Result<Json, Fault> {
    let mut segment = engine_call("start", || movement_engine::begin(input))?.map_err(|e| Fault(format!("the Rust engine refused start: {}", e.0)))?;
    let mut step = step_json(engine_call("start", || segment.start())?, "start")?;
    let mut in_flight = InFlight { futures: Vec::new() };
    let result = loop {
        if let Some(done) = step.get("done") {
            break Ok(done.clone());
        }
        let pending = step.get("pending").and_then(Json::as_array).cloned().ok_or_else(|| Fault("the Rust engine's step is neither pending nor done".into()))?;
        for request in pending {
            let id = request.get("id").and_then(Json::as_u64).ok_or_else(|| Fault("a request from the Rust engine has no id".into()))? as u32;
            in_flight.futures.push(Box::pin(async move { (id, serve(host, &request).await) }));
        }
        if in_flight.futures.is_empty() {
            break Err(Fault("the Rust engine is waiting with no request in flight".into()));
        }
        let mut settled = Some(in_flight.next().await);
        let mut next_pending = Vec::new();
        let mut finished = None;
        while let Some((id, answer)) = settled.take() {
            let answer = match answer {
                Ok(answer) => answer,
                Err(fault) => {
                    finished = Some(Err(fault));
                    break;
                }
            };
            let stepped = movement_engine::read_answer(&answer.to_string())
                .map_err(|e| Fault(format!("an answer the engine cannot read: {}", e.0)))
                .and_then(|read| engine_call("answer", || segment.answer(id, read)))
                .and_then(|step| step_json(step, &format!("answer {id}")));
            let stepped = match stepped {
                Ok(stepped) => stepped,
                Err(fault) => {
                    finished = Some(Err(fault));
                    break;
                }
            };
            if stepped.get("done").is_some() {
                finished = Some(Ok(stepped));
                break;
            }
            next_pending.extend(stepped.get("pending").and_then(Json::as_array).cloned().unwrap_or_default());
            settled = in_flight.ready();
        }
        match finished {
            Some(Ok(done)) => step = done,
            Some(Err(fault)) => break Err(fault),
            None => step = json!({ "pending": next_pending }),
        }
    };
    // Every request still in flight settles first: no host call outlives
    // the segment it named.
    while !in_flight.futures.is_empty() {
        let _ = in_flight.next().await;
    }
    drop(segment);
    result
}

/// The segment's `done`: its result, or the error the run failed with.
fn read_result(host: &SegmentHost<'_>, done: &Json) -> Result<Ran, Ended> {
    if let Some(reason) = done.get("refused").or_else(|| done.get("declined")).and_then(Json::as_str) {
        return Err(Ended::Failed(format!("the Rust engine does not run this movement ({reason})")));
    }
    if let Some(cost) = done.get("cost").and_then(Json::as_array)
        && !cost.is_empty()
    {
        return Err(Ended::Failed("the Rust engine reports spending, but this host made no priced call".into()));
    }
    let failure = done.get("thrown").or_else(|| done.get("failed").and_then(|f| f.get("error")));
    if let Some(error) = failure {
        return Err(failure_of(host, error));
    }
    let Some(result) = done.get("result") else {
        return Err(Ended::Failed(format!("the Rust engine finished with {done}, which this host does not decode")));
    };
    let writes = match result.get("writes") {
        None => 0,
        Some(wire) => match host.wire.borrow_mut().read(wire) {
            Ok(Hv::List(items)) => items.len(),
            _ => return Err(Ended::Failed("the Rust engine result writes are write records".into())),
        },
    };
    let parked = result.get("parked") == Some(&json!(true));
    Ok(Ran {
        writes,
        parked_address: parked.then(|| result.get("parkedAddress").and_then(Json::as_str).unwrap_or_default().to_string()),
        cancelled: result.get("cancelled") == Some(&json!(true)),
        deferred_race_frames: result
            .get("deferredRaceFrames")
            .and_then(Json::as_array)
            .map(|frames| frames.iter().filter_map(Json::as_str).map(str::to_string).collect())
            .unwrap_or_default(),
        captured: host.adapters.captured.borrow().clone(),
    })
}

/// The error a run failed with, as its message: a host call's own failure
/// by the `ref` its answer carried, else the engine's.
fn failure_of(host: &SegmentHost<'_>, error: &Json) -> Ended {
    if let Some(reference) = error.get("hostError") {
        let errors = host.host_errors.borrow();
        return match reference.as_u64().and_then(|r| errors.get(r as usize)) {
            Some(failure) if failure.lease_lost => Ended::LeaseLost,
            Some(failure) => Ended::Failed(failure.message.clone()),
            None => Ended::Failed(format!("the Rust engine failed with a host error this host never answered ({reference})")),
        };
    }
    Ended::Failed(thrown_message(error))
}

/// The message of the error the TypeScript engine would have thrown
/// (`thrownBy`): a `MovementEngineError`'s is its code, then its message.
fn thrown_message(error: &Json) -> String {
    let message = error.get("message").and_then(Json::as_str).unwrap_or_default();
    match error.get("class").and_then(Json::as_str) {
        Some("MovementEngineError") => format!("{}: {message}", error.get("code").and_then(Json::as_str).unwrap_or("MOVENG_ERROR")),
        Some("CallDepthExceeded") => {
            let limit = error.get("limit").and_then(Json::as_u64).unwrap_or_default();
            let chain: Vec<&str> = error.get("chain").and_then(Json::as_array).map(|c| c.iter().filter_map(Json::as_str).collect()).unwrap_or_default();
            format!(
                "MOVENG_CALL_DEPTH: call depth limit reached: '{}' would nest {} calls deep, and the limit set by {CALL_DEPTH_ENV_VAR} is {limit}. The run was stopped in case a recursion never reaches the case that ends it. If this run legitimately needs to go deeper, raise {CALL_DEPTH_ENV_VAR} in the server's environment.",
                describe_chain(&chain),
                chain.len().saturating_sub(1)
            )
        }
        // A priced call met the cap: lf-host makes none yet (G6).
        Some("RunCostCapExceeded") => "Run cost cap reached: the run was stopped before its next priced call".into(),
        _ => message.to_string(),
    }
}

/// `describeChain`: a long chain shortened to its two ends.
fn describe_chain(chain: &[&str]) -> String {
    if chain.len() <= 12 {
        return chain.join(" → ");
    }
    let omitted = chain.len() - 10;
    let mut parts: Vec<String> = chain[..4].iter().map(|s| s.to_string()).collect();
    parts.push(format!("… {omitted} more …"));
    parts.extend(chain[chain.len() - 6..].iter().map(|s| s.to_string()));
    parts.join(" → ")
}

const CALL_DEPTH_ENV_VAR: &str = "MOVEMENT_MAX_CALL_DEPTH";

/// `maxCallDepth`: the deployment's limit, or 32; a value that is set but is
/// not a positive whole number is refused, never read as no limit.
fn max_call_depth() -> Result<u64, String> {
    let raw = std::env::var(CALL_DEPTH_ENV_VAR).unwrap_or_default();
    if raw.trim().is_empty() {
        return Ok(32);
    }
    raw.trim().parse::<u64>().ok().filter(|n| *n > 0).ok_or_else(|| {
        format!(
            "{CALL_DEPTH_ENV_VAR}=\"{raw}\" is not a positive whole number. Set it to how many calls deep one movement run may nest (e.g. {CALL_DEPTH_ENV_VAR}=32), or leave it unset for the default of 32."
        )
    })
}

// ── Routes ──────────────────────────────────────────────────────────────────

type Answer = Result<Option<Json>, HostFailure>;

fn text<'a>(args: &'a Json, name: &str, label: &str) -> Result<&'a str, Fault> {
    args.get(name).and_then(Json::as_str).ok_or_else(|| Fault(format!("{label} {name} must be a string")))
}

fn failure(message: impl Into<String>) -> HostFailure {
    HostFailure { message: message.into(), name: None, lease_lost: false }
}

fn store_failure(error: StoreError) -> HostFailure {
    let lease_lost = matches!(error, StoreError::LeaseLost { .. });
    HostFailure { name: lease_lost.then(|| "RunLeaseLost".to_string()), message: error.to_string(), lease_lost }
}

fn rules_failure(message: String) -> HostFailure {
    failure(message)
}

/// `serve`: one request, answered.
async fn serve(host: &SegmentHost<'_>, request: &Json) -> Result<Json, Fault> {
    let family = request.get("family").and_then(Json::as_str).unwrap_or_default();
    let method = request.get("method").and_then(Json::as_str).unwrap_or_default();
    let label = format!("{family}.{method}");
    let args = request.get("args").cloned().unwrap_or(Json::Null);
    if !args.is_object() {
        return Err(Fault(format!("{label}: args must be an object")));
    }
    if label != "log.write" && label != "check.program" && label != "check.compatible" && args.get("segmentId").and_then(Json::as_str) != Some(&host.segment_id) {
        return Err(Fault(format!("{label} named segment {}, not this engine's {}", args.get("segmentId").unwrap_or(&Json::Null), host.segment_id)));
    }
    let answered = route(host, &label, &args).await?;
    Ok(match answered {
        Ok(Some(value)) => json!({ "value": value }),
        Ok(None) => json!({}),
        Err(failure) => {
            let mut errors = host.host_errors.borrow_mut();
            errors.push(HostFailure { message: failure.message.clone(), name: failure.name.clone(), lease_lost: failure.lease_lost });
            let mut error = serde_json::Map::new();
            error.insert("message".into(), json!(failure.message));
            if let Some(name) = failure.name {
                error.insert("name".into(), json!(name));
            }
            error.insert("ref".into(), json!(errors.len() - 1));
            json!({ "error": error })
        }
    })
}

async fn route(host: &SegmentHost<'_>, label: &str, args: &Json) -> Result<Answer, Fault> {
    let store = host.store;
    let run_id = host.run_id.as_str();
    let fence = host.fence.as_deref();
    Ok(match label {
        "adapters.resolve" => {
            let role = args.get("role").and_then(Json::as_str);
            if role != Some("source") && role != Some("target") {
                return Err(Fault(format!("adapters.resolve role must be \"source\" or \"target\", not {}", args.get("role").unwrap_or(&Json::Null))));
            }
            // As the dict holds it: a lookup reads a slug as its text.
            let adapter_type = match args.get("adapterType") {
                Some(Json::String(s)) => s.clone(),
                Some(Json::Array(items)) => items.iter().map(|i| i.as_str().map(str::to_string).unwrap_or_else(|| i.to_string())).collect::<Vec<_>>().join(","),
                Some(other) => other.to_string(),
                None => "undefined".into(),
            };
            let construction_args = match args.get("constructionArgs").map(js_of_json) {
                Some(Js::Obj(map)) => Some(map),
                _ => None,
            };
            let dry_run = args.get("dryRun") == Some(&json!(true));
            match host.adapters.resolve(&adapter_type, args.get("credentialsId").and_then(Json::as_str), construction_args.as_ref(), dry_run) {
                Ok(resolved) => Ok(Some(json_of_js(&resolved))),
                Err(message) => Err(failure(message)),
            }
        }
        "adapters.call" => adapters_call(host, args).await?,
        "park.sink.commitTimerPark" => {
            let state = read_wire(host, args.get("state"))?.js();
            let address = text(args, "address", "park.sink.commitTimerPark")?;
            let wake_at = text(args, "wakeAt", "park.sink.commitTimerPark")?;
            park(host, || {
                store.put_leaf(run_id, address, "timer", Some(wake_at), &state, fence).map_err(store_failure)?;
                // The leaf is the truth; the work row only says when to look.
                arm_timer_wake(store, run_id, wake_at).map_err(rules_failure)
            })
        }
        "park.sink.commitAwaitPark" => {
            let state = read_wire(host, args.get("state"))?.js();
            let address = text(args, "address", "park.sink.commitAwaitPark")?;
            let adapter_type = text(args, "adapterType", "park.sink.commitAwaitPark")?;
            let key = text(args, "correlationKey", "park.sink.commitAwaitPark")?;
            park(host, || {
                store.put_leaf(run_id, address, "await", None, &state, fence).map_err(store_failure)?;
                store.correlate(run_id, TEAM, address, adapter_type, key).map_err(store_failure)
            })
        }
        "park.sink.commitSuspension" => {
            let state = read_wire(host, args.get("state"))?.js();
            let address = text(args, "address", "park.sink.commitSuspension")?;
            park(host, || {
                store.put_leaf(run_id, address, "limit", None, &state, fence).map_err(store_failure)?;
                store.drop_correlation(run_id, address).map_err(store_failure)
            })
        }
        "park.sink.recordJoin" => {
            let frame = text(args, "frameAddress", "park.sink.recordJoin")?;
            let pending = args.get("parkedChildren").and_then(Json::as_i64).ok_or_else(|| Fault("park.sink.recordJoin parkedChildren is a count".into()))?;
            store.record_join(run_id, frame, pending, fence).map(|()| None).map_err(store_failure)
        }
        "park.sink.decrementJoin" => {
            let frame = text(args, "frameAddress", "park.sink.decrementJoin")?;
            let branch = text(args, "branchAddress", "park.sink.decrementJoin")?;
            let leaf = text(args, "leafAddress", "park.sink.decrementJoin")?;
            store.decrement_join(run_id, frame, branch, leaf).map(|closed| Some(json!({ "closed": closed }))).map_err(store_failure)
        }
        "park.sink.persistBranchExport" => {
            let exports = read_wire(host, args.get("exports"))?.js();
            let frame = text(args, "frameAddress", "park.sink.persistBranchExport")?;
            let branch = text(args, "branchAddress", "park.sink.persistBranchExport")?;
            let index = args.get("branchIndex").and_then(Json::as_i64).ok_or_else(|| Fault("park.sink.persistBranchExport branchIndex is an integer".into()))?;
            store.persist_branch_export(run_id, frame, branch, index, &exports).map(|()| None).map_err(store_failure)
        }
        "park.sink.collectBranchExports" => {
            let frame = text(args, "frameAddress", "park.sink.collectBranchExports")?;
            match store.collect_branch_exports(run_id, frame) {
                Ok(rows) => {
                    let rows = Js::Arr(
                        rows.into_iter()
                            .map(|r| {
                                Js::Obj(obj! {
                                    "branchAddress" => Js::Str(r.branch_address),
                                    "branchIndex" => Js::Num(r.branch_index.into()),
                                    "exports" => r.exports,
                                })
                            })
                            .collect(),
                    );
                    // A branch's exports are parked state: its files the host's to make.
                    let mut wire = host.wire.borrow_mut();
                    let mut rows = Hv::of_js(&rows);
                    crate::park_files::in_branch_exports(&mut wire, &mut rows);
                    Ok(Some(wire.write(&rows)))
                }
                Err(error) => Err(store_failure(error)),
            }
        }
        "park.sink.cancelSubtrees" => {
            let subtrees: Vec<String> = args
                .get("subtreeAddresses")
                .and_then(Json::as_array)
                .and_then(|list| list.iter().map(|a| a.as_str().map(str::to_string)).collect())
                .ok_or_else(|| Fault("park.sink.cancelSubtrees subtreeAddresses are a list of texts".into()))?;
            let exclude = args.get("excludeLeaf").and_then(Json::as_str);
            cancel_subtrees(store, run_id, &subtrees, exclude).map(|()| None).map_err(rules_failure)
        }
        "park.wake" => {
            let adapter_type = text(args, "adapterType", "park.wake")?;
            let key = text(args, "correlationKey", "park.wake")?;
            queue_await_wake(store, adapter_type, TEAM, key).map(|()| None).map_err(rules_failure)
        }
        "park.sources.save" => {
            let source = text(args, "source", "park.sources.save")?;
            save_source(store, TEAM, source).map(|hash| Some(json!({ "hash": hash }))).map_err(rules_failure)
        }
        "park.sources.load" => {
            let hash = text(args, "hash", "park.sources.load")?;
            match store.get_source(TEAM, hash) {
                Ok(Some(source)) => Ok(Some(json!({ "source": source }))),
                Ok(None) => Ok(Some(json!({}))),
                Err(error) => Err(store_failure(error)),
            }
        }
        "clock.now" => Ok(Some(json!({ "nowIso": crate::store::iso(0) }))),
        "control.cancel.cancelled" | "control.cancel.cancelledNow" => {
            if !host.cancelled.get() {
                host.cancelled.set(store.cancel_request(run_id).map_err(|e| Fault(e.to_string()))?.is_some());
            }
            Ok(Some(json!(host.cancelled.get())))
        }
        "trace.append" => {
            let entries = match read_wire(host, args.get("entries"))? {
                Hv::List(items) => items.iter().map(Hv::js).collect::<Vec<_>>(),
                _ => return Err(Fault("trace.append entries are a list".into())),
            };
            // The kinds the engine appends (crates/movement-engine/src/trace.rs),
            // each kept as the engine wrote it.
            for entry in &entries {
                let kind = entry.get("kind").and_then(Js::as_str).unwrap_or_default();
                if !TRACE_KINDS.contains(&kind) {
                    return Err(Fault(format!("the Rust engine appended a trace entry this host does not know: {kind}")));
                }
            }
            store.append_trace(run_id, &entries).map(|()| None).map_err(store_failure)
        }
        "log.write" => {
            for line in args.get("lines").and_then(Json::as_array).into_iter().flatten() {
                let level = line.get("level").and_then(Json::as_str).unwrap_or("info");
                let message = line.get("message").and_then(Json::as_str).unwrap_or_default();
                eprintln!("{level}: {message} {}", line.get("fields").unwrap_or(&Json::Null));
            }
            Ok(None)
        }
        "ids.mint" => {
            let count = args.get("count").and_then(Json::as_u64).filter(|n| *n >= 1).ok_or_else(|| Fault("ids.mint count is a positive integer".into()))?;
            Ok(Some(json!((0..count).map(|_| uuid::Uuid::new_v4().to_string()).collect::<Vec<_>>())))
        }
        "locks.acquire" => {
            // One process steps one segment at a time, so a lock is held
            // by the asking segment as soon as it asks.
            let names: Vec<String> = args
                .get("names")
                .and_then(Json::as_array)
                .and_then(|list| list.iter().map(|n| n.as_str().map(str::to_string)).collect())
                .ok_or_else(|| Fault("locks.acquire names are a list of texts".into()))?;
            host.next_lock.set(host.next_lock.get() + 1);
            let token = format!("{}#{}", host.segment_id, host.next_lock.get());
            host.lock_tokens.borrow_mut().insert(token.clone(), names);
            Ok(Some(json!({ "token": token })))
        }
        "locks.release" => {
            let token = text(args, "token", "locks.release")?;
            match host.lock_tokens.borrow_mut().remove(token) {
                Some(_) => Ok(None),
                None => Err(failure(format!("write lock token '{token}' is not held: released twice, or never acquired"))),
            }
        }
        "lookup.resolveActingUser" => Ok(Some(host.wire.borrow().write(&Hv::of_js(&host.user)))),
        "files.render" => {
            let content = text(args, "content", "files.render")?;
            let kind = text(args, "type", "files.render")?;
            let (name, content_type) = match kind {
                "pdf" => ("movement-artifact.pdf", "application/pdf"),
                "text" => ("movement-artifact.txt", "text/plain"),
                _ => return Err(Fault("files.render type is \"pdf\" or \"text\"".into())),
            };
            // THIN: a "pdf" is stored as its text, as the TypeScript lf stores it.
            match host.documents.put(TEAM, content.as_bytes(), name, content_type) {
                Ok(descriptor) => {
                    let mut wire = host.wire.borrow_mut();
                    let file = wire.file(descriptor);
                    Ok(Some(wire.write(&file)))
                }
                Err(message) => Err(failure(message)),
            }
        }
        "files.resolveFileText" => {
            let file = match read_wire(host, args.get("file"))? {
                Hv::File { descriptor, .. } => descriptor,
                _ => return Err(Fault("files.resolveFileText file is a file the engine holds".into())),
            };
            let answer = local_file_text(host, &file);
            Ok(Some(host.wire.borrow().write(&Hv::of_js(&answer))))
        }
        // Families lf-host does not serve yet: the run fails naming them.
        "llm.client.call" | "llm.extractCall.call" | "llm.transforms.invoke" | "llm.arbitrateEntities" => {
            Err(failure(format!("{label}: lf-host does not call models yet; use the TypeScript lf for a movement that does")))
        }
        "park.bindings.record" | "park.bindings.findBoundCounterpart" | "park.bindings.delete" => {
            Err(failure(format!("{label}: lf-host keeps no record bindings yet; use the TypeScript lf for a movement that binds records")))
        }
        _ => return Err(Fault(format!("the host has no route for {label}"))),
    })
}

/// A park's write, then what follows every park: the run is observably
/// parked, and a cancel stamped meanwhile settles it at once.
fn park(host: &SegmentHost<'_>, write: impl FnOnce() -> Result<(), HostFailure>) -> Answer {
    write()?;
    host.store.mark_parked(&host.run_id).map_err(store_failure)?;
    // Never break the park path: a cancel that fails to settle here
    // settles at the run's next entry.
    let _ = settle_if_cancel_requested(host.store, &host.run_id, None);
    Ok(None)
}

fn read_wire(host: &SegmentHost<'_>, value: Option<&Json>) -> Result<Hv, Fault> {
    host.wire.borrow_mut().read(value.unwrap_or(&Json::Null)).map_err(Fault)
}

/// `adapters.call`: `{result}` or `{error}`, as data.
async fn adapters_call(host: &SegmentHost<'_>, args: &Json) -> Result<Answer, Fault> {
    let method = args.get("method").and_then(Json::as_str).unwrap_or_default().to_string();
    if !ADAPTER_METHODS.contains(&method.as_str()) {
        return Err(Fault(format!("adapters.call method {} is not an adapter method", args.get("method").unwrap_or(&Json::Null))));
    }
    if args.get("wire") != Some(&json!(true)) {
        return Err(Fault("adapters.call carries its args on the eval wire".into()));
    }
    let instance = text(args, "instance", "adapters.call")?.to_string();
    // Read before the call awaits anything, so a registration and a call
    // naming it in flight together are served in the order the engine made them.
    let call_args = {
        let rest = read_wire(host, args.get("args"))?;
        let Hv::Obj(rest) = rest else { return Err(Fault(format!("adapters.call {method}: args are one object"))) };
        match args.get("positionRef") {
            None => Hv::Obj(rest),
            Some(reference) => {
                let reference = reference.as_i64().ok_or_else(|| Fault("adapters.call positionRef is an integer".into()))?;
                if let Some(position) = args.get("position") {
                    if host.positions.borrow().contains_key(&reference) {
                        return Err(Fault(format!("adapters.call registered position {reference} twice")));
                    }
                    let position = read_wire(host, Some(position))?;
                    host.positions.borrow_mut().insert(reference, position);
                }
                let position = host
                    .positions
                    .borrow()
                    .get(&reference)
                    .cloned()
                    .ok_or_else(|| Fault(format!("adapters.call named position {reference}, which was never registered")))?;
                let mut entries = vec![("position".to_string(), position)];
                entries.extend(rest);
                Hv::Obj(entries)
            }
        }
    };
    let files_at = match args.get("filesAt") {
        None => None,
        Some(value) => Some(field_type_of(value).ok_or_else(|| Fault(format!("adapters.call {method} filesAt is a field type")))?),
    };
    let files_in = args.get("filesIn").and_then(Json::as_str);
    if args.get("filesIn").is_some() && files_in != Some("resources") {
        return Err(Fault(format!("adapters.call {method} filesIn is \"resources\" or absent")));
    }
    match host.adapters.call(&instance, &method, &call_args).await {
        Err(failed) => {
            let message = failed.message().to_string();
            let mut errors = host.host_errors.borrow_mut();
            errors.push(HostFailure { message, name: failed.name().map(str::to_string), lease_lost: false });
            let mut error = match failed.answer() {
                Js::Obj(map) => map,
                _ => Obj::new(),
            };
            error.insert("ref".into(), Js::Num((errors.len() - 1).into()));
            Ok(Ok(Some(json!({ "error": json_of_js(&Js::Obj(error)) }))))
        }
        // An answer of nothing crosses as no result.
        Ok(None) => Ok(Ok(Some(json!({})))),
        Ok(Some(result)) => {
            let answered = if files_in == Some("resources") { resources_with_files(&mut host.wire.borrow_mut(), &result) } else { None };
            let mut wire = host.wire.borrow_mut();
            let value = match answered {
                Some(hv) => hv,
                None => files_at_type(&mut wire, files_at.as_ref(), &result),
            };
            Ok(Ok(Some(json!({ "result": wire.write(&value) }))))
        }
    }
}

/// `relatedResourcesWithFiles`: a `_resources` reference's records, each
/// resource's `fileRef` slot made a file.
fn resources_with_files(wire: &mut Wire, related: &Js) -> Option<Hv> {
    let Js::Arr(items) = related else { return None };
    Some(Hv::List(
        items
            .iter()
            .map(|item| {
                let slot = item.get("position").and_then(|p| p.get("identity")).and_then(|i| i.get("data")).and_then(|d| d.get("fileRef"));
                let Some(descriptor) = slot.and_then(descriptor_of) else { return Hv::of_js(item) };
                let file = wire.file(descriptor);
                let mut hv = Hv::of_js(item);
                set_path(&mut hv, &["position", "identity", "data", "fileRef"], file);
                hv
            })
            .collect(),
    ))
}

fn set_path(value: &mut Hv, path: &[&str], to: Hv) {
    let Some((first, rest)) = path.split_first() else {
        *value = to;
        return;
    };
    if let Hv::Obj(entries) = value
        && let Some((_, member)) = entries.iter_mut().rev().find(|(k, _)| k == first)
    {
        set_path(member, rest, to);
    }
}

/// `localFileText`: a file's text, when it is a text file whose bytes are
/// to hand.
fn local_file_text(host: &SegmentHost<'_>, file: &Obj) -> Js {
    let content_type = file.get("contentType").and_then(Js::as_str).unwrap_or_default();
    let extension = file.get("name").and_then(Js::as_str).unwrap_or_default().rsplit('.').next().unwrap_or_default().to_lowercase();
    let textual = if content_type.is_empty() {
        ["txt", "md", "markdown", "json", "csv", "tsv", "xml", "yaml", "yml", "html", "log"].contains(&extension.as_str())
    } else {
        is_text_type(content_type) || content_type == "application/pdf"
    };
    let unreadable = |why: &str, detail: Option<String>| {
        let mut out = obj! { "unreadable" => Js::str(why) };
        if let Some(detail) = detail {
            out.insert("detail".into(), Js::Str(detail));
        }
        Js::Obj(out)
    };
    if !textual {
        let named = if !content_type.is_empty() { content_type.to_string() } else if !extension.is_empty() { extension } else { "an unknown type".into() };
        return unreadable("unsupported_type", Some(format!("lf reads text files only, not {named}")));
    }
    let bytes = match owner_of(file.get("source")) {
        Some(Owner::Document { object_uri }) if host.documents.owns(&object_uri, TEAM) => host.documents.open(&object_uri),
        Some(Owner::Document { object_uri }) => Err(format!("the file {object_uri} is not a stored document of this project")),
        Some(Owner::Adapter { adapter_type, .. }) => Err(format!("a file '{adapter_type}' owns is not read by lf-host yet")),
        None => Err("a file with no owner has no bytes".into()),
    };
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(message) => return unreadable("bytes_unavailable", Some(message)),
    };
    if bytes.starts_with(b"%PDF-") {
        return unreadable("unsupported_type", Some("lf cannot extract text from a PDF yet".into()));
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if text.trim().is_empty() { unreadable("no_text", None) } else { Js::Obj(obj! { "text" => Js::Str(text) }) }
}

/// `TEXT_TYPES`: `text/*`, the textual `application/*` types and their `+json`/`+xml` kin.
fn is_text_type(content_type: &str) -> bool {
    if content_type.starts_with("text/") {
        return true;
    }
    let Some(sub) = content_type.strip_prefix("application/") else { return false };
    if ["json", "xml", "yaml", "x-yaml", "csv"].iter().any(|t| sub.starts_with(t)) {
        return true;
    }
    let name: String = sub.chars().take_while(|c| c.is_ascii_alphanumeric() || "_.+-".contains(*c)).collect();
    name.ends_with("+json") || name.ends_with("+xml") || name.contains("+json") || name.contains("+xml")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_engine_error_reads_as_the_typescript_one() {
        assert_eq!(thrown_message(&json!({ "class": "MovementEngineError", "code": "MOVENG_CHECK", "message": "m" })), "MOVENG_CHECK: m");
        assert_eq!(thrown_message(&json!({ "class": "TypeError", "message": "t" })), "t");
        let chain: Vec<String> = (0..14).map(|i| format!("f{i}")).collect();
        let chain: Vec<&str> = chain.iter().map(String::as_str).collect();
        assert_eq!(describe_chain(&chain), "f0 → f1 → f2 → f3 → … 4 more … → f8 → f9 → f10 → f11 → f12 → f13");
    }

    #[test]
    fn text_types_are_the_typescript_lfs() {
        for t in ["text/plain", "application/json", "application/ld+json", "application/x-yaml", "application/xml; charset=utf-8"] {
            assert!(is_text_type(t), "{t}");
        }
        for t in ["image/png", "application/pdf", "application/octet-stream"] {
            assert!(!is_text_type(t), "{t}");
        }
    }

}
