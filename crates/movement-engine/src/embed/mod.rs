//! The engine embedded in a Rust program: a run driven with typed inputs,
//! its requests answered by host traits you implement, its outcome typed.
//!
//! ```text
//! check(source, &catalog)            -> problems, before anything runs
//! run(&mut hosts, RunInput)          -> Outcome (finished, parked, failed…)
//! resume(&mut hosts, RunInput, state) -> Outcome, when a park is due
//! ```
//!
//! This is the same engine the JSON boundary drives (crate::begin, the WASM
//! artifact and the `lf` command): a run here is one segment, its requests
//! the ones crate::host builds, read into typed host calls (serve.rs). The
//! families a host leaves unfilled refuse what they are asked.
//!
//! A host call is synchronous: the driver answers each request in the order
//! the engine made it.

mod data;
mod hosts;
mod serve;

pub use data::{Data, FileDescriptor, FileRef, RecordRef};
pub use hosts::*;

use serde_json::{Value as Json, json};

use crate::executor::{ProtocolError, Step};

/// The first language version this engine runs.
pub const LANGUAGE_VERSION: u32 = 5;

/// The host families a run may ask, each one optional.
#[derive(Default)]
pub struct Hosts<'h> {
    store: Option<&'h mut dyn Store>,
    models: Option<&'h mut dyn Models>,
    judge: Option<&'h mut dyn Judge>,
    files: Option<&'h mut dyn Files>,
    adapters: Option<&'h mut dyn Adapters>,
    modules: Option<&'h mut dyn Modules>,
    secrets: Option<&'h mut dyn Secrets>,
    clock: Option<&'h mut dyn Clock>,
    trace: Option<&'h mut dyn Trace>,
}

impl<'h> Hosts<'h> {
    pub fn new() -> Hosts<'h> {
        Hosts::default()
    }
    pub fn store(mut self, store: &'h mut dyn Store) -> Self {
        self.store = Some(store);
        self
    }
    pub fn models(mut self, models: &'h mut dyn Models) -> Self {
        self.models = Some(models);
        self
    }
    pub fn judge(mut self, judge: &'h mut dyn Judge) -> Self {
        self.judge = Some(judge);
        self
    }
    pub fn files(mut self, files: &'h mut dyn Files) -> Self {
        self.files = Some(files);
        self
    }
    pub fn adapters(mut self, adapters: &'h mut dyn Adapters) -> Self {
        self.adapters = Some(adapters);
        self
    }
    pub fn modules(mut self, modules: &'h mut dyn Modules) -> Self {
        self.modules = Some(modules);
        self
    }
    pub fn secrets(mut self, secrets: &'h mut dyn Secrets) -> Self {
        self.secrets = Some(secrets);
        self
    }
    /// Without one, the clock is the run's pinned instant and ids count up.
    pub fn clock(mut self, clock: &'h mut dyn Clock) -> Self {
        self.clock = Some(clock);
        self
    }
    pub fn trace(mut self, trace: &'h mut dyn Trace) -> Self {
        self.trace = Some(trace);
        self
    }

    /// The optional host methods these hosts serve, by path: the engine asks
    /// an optional one only of a host that lists it.
    fn serves(&self) -> Vec<&'static str> {
        let mut serves = vec!["adapters.resolve", "adapters.call"];
        if self.models.is_some() {
            serves.extend(["llm.client.call", "llm.extractCall.call"]);
        }
        if self.judge.is_some() {
            serves.push("llm.arbitrateEntities");
        }
        if self.modules.is_some() {
            serves.push("llm.transforms.invoke");
        }
        if self.store.as_deref().is_some_and(Store::keeps_parks) {
            serves.extend([
                "park.sink.recordJoin",
                "park.sink.commitTimerPark",
                "park.sink.commitAwaitPark",
                "park.sink.decrementJoin",
                "park.sink.persistBranchExport",
                "park.sink.collectBranchExports",
                "park.sink.cancelSubtrees",
                "park.sink.commitSuspension",
                "park.wake",
                "park.callbacks.mint",
                "park.callbacks.calls",
                "park.sources.save",
                "park.sources.load",
            ]);
        }
        serves
    }
}

/// What the movements are checked and run against: the adapters, the
/// credentials and the plugins, as a catalog snapshot
/// (docs/contracts/catalog-snapshot.md). Kept as its text, since its maps
/// are ordered.
#[derive(Debug, Clone)]
pub struct Catalog {
    text: String,
    snapshot: movement_parser::catalog::types::CatalogSnapshot,
}

impl Catalog {
    /// A snapshot's JSON text, refused when it does not read as one.
    pub fn from_json(text: &str) -> Result<Catalog, String> {
        let snapshot = movement_parser::catalog::types::CatalogSnapshot::load(text)?;
        Ok(Catalog { text: text.to_string(), snapshot })
    }

    pub fn snapshot(&self) -> &movement_parser::catalog::types::CatalogSnapshot {
        &self.snapshot
    }
}

impl Default for Catalog {
    fn default() -> Catalog {
        Catalog::from_json(r#"{"adapters":{},"credentials":{},"plugins":{}}"#).expect("the empty catalog reads")
    }
}

/// One problem the checker found.
#[derive(Debug, Clone, PartialEq)]
pub struct Problem {
    pub code: String,
    pub message: String,
    pub line: usize,
    pub column: usize,
    pub severity: Severity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
    Info,
}

/// What the checker says of `source` against `catalog`, under the language
/// version `language_version`. A run checks again before it runs anything.
pub fn check(source: &str, catalog: &Catalog, language_version: u32) -> Vec<Problem> {
    use movement_checker::host::native::NativeZones;
    let options = movement_checker::CheckOptions { language_version, upgrading_from: None, parse_version: None, zones: &NativeZones };
    let external = |text: &str| movement_parser::util::form::external_text(text).into_owned();
    match movement_checker::check_source(source, &catalog.snapshot, options) {
        Err(refusal) => vec![Problem { code: "MOV_PARSE".into(), message: external(&refusal.message), line: 0, column: 0, severity: Severity::Error }],
        Ok(diagnostics) => diagnostics
            .into_iter()
            .map(|d| Problem {
                code: d.code,
                message: external(&d.message),
                line: d.span.start.line,
                column: d.span.start.col,
                severity: match d.severity {
                    None => Severity::Error,
                    Some(movement_checker::Severity::Warning) => Severity::Warning,
                    Some(movement_checker::Severity::Info) => Severity::Info,
                },
            })
            .collect(),
    }
}

/// Every `listen to <instance> { events: […] } fire <function>` in `source`:
/// which function an event fires. Routing is the host's: a host matches its
/// event to a listen and runs that function.
#[derive(Debug, Clone, PartialEq)]
pub struct Listen {
    /// The adapter the listened instance connects (its import alias resolved).
    pub adapter: String,
    pub function: String,
    /// The event types the listen chooses; empty, every event.
    pub events: Vec<String>,
}

pub fn listens(source: &str, language_version: u32) -> Result<Vec<Listen>, String> {
    use movement_parser::ast::{RValue, Statement};
    let form = movement_parser::util::form::form_of_text(source);
    let program = movement_parser::stmt::parse_program(&form, language_version, true)
        .map_err(|e| format!("{} (line {}, col {})", movement_parser::util::form::external_text(&e.message), e.loc.line, e.loc.col))?;
    let mut aliases = std::collections::HashMap::new();
    let mut instances = std::collections::HashMap::new();
    let mut out = Vec::new();
    for statement in &program.statements {
        match statement {
            Statement::Import(import) => {
                for name in &import.names {
                    aliases.insert(name.alias.clone().unwrap_or_else(|| name.name.clone()), name.name.clone());
                }
            }
            Statement::Assign(assign) => {
                if let RValue::Construct { construct } = &assign.value {
                    instances.insert(assign.name.clone(), aliases.get(&construct.callee).cloned().unwrap_or_else(|| construct.callee.clone()));
                }
            }
            Statement::Listen(listen) => {
                let Some(adapter) = instances.get(&listen.instance) else { continue };
                let events = listen
                    .config
                    .iter()
                    .filter(|arg| arg.name == "events")
                    .flat_map(|arg| string_literals(&movement_parser::util::form::external_text(&arg.value.raw)))
                    .collect();
                out.push(Listen { adapter: adapter.clone(), function: listen.movement.clone(), events });
            }
            _ => {}
        }
    }
    Ok(out)
}

/// The quoted texts in a config value (`["a", "b"]` or `"a"`).
fn string_literals(raw: &str) -> Vec<String> {
    raw.split('"').skip(1).step_by(2).map(str::to_string).collect()
}

/// The event a run is fired by: what an adapter would deliver for it.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    /// The adapter the event comes from (the listened instance's).
    pub adapter_type: String,
    /// Which of the adapter's events it is (`player.joined`).
    pub event_type: Option<String>,
    /// The record the event is about, by its type and id.
    pub record_type: Option<String>,
    pub external_id: Option<String>,
    pub change_type: Option<String>,
    /// The event's own data: the record's fields.
    pub payload: Data,
    /// When it happened, ISO 8601.
    pub occurred_at: Option<String>,
}

impl Event {
    pub fn new(adapter_type: impl Into<String>, payload: Data) -> Event {
        Event { adapter_type: adapter_type.into(), event_type: None, record_type: None, external_id: None, change_type: None, payload, occurred_at: None }
    }
    pub fn of_type(mut self, event_type: impl Into<String>) -> Event {
        self.event_type = Some(event_type.into());
        self
    }
    /// The record the event is about.
    pub fn about(mut self, record_type: impl Into<String>, external_id: impl Into<String>) -> Event {
        self.record_type = Some(record_type.into());
        self.external_id = Some(external_id.into());
        self
    }

    /// The trigger event as the run reads it (lf's `trigger_event_of`).
    fn to_wire(&self, pipeline_input_id: &str) -> Json {
        let mut out = vec![
            ("pipelineInputId".to_string(), Data::text(pipeline_input_id)),
            ("adapterType".into(), Data::text(self.adapter_type.clone())),
            ("triggerType".into(), Data::text("webhook")),
            ("payload".into(), self.payload.clone()),
        ];
        if let Some(change) = &self.change_type {
            out.push(("changeType".into(), Data::text(change.clone())));
        }
        if let Some(record_type) = &self.record_type {
            out.push(("rootRecordType".into(), Data::text(record_type.clone())));
        }
        if let Some(id) = &self.external_id {
            let mut reference = vec![("adapterType".to_string(), Data::text(self.adapter_type.clone())), ("externalId".into(), Data::text(id.clone()))];
            if let Some(record_type) = &self.record_type {
                reference.push(("recordType".into(), Data::text(record_type.clone())));
            }
            out.push(("externalRecordRef".into(), Data::Map(reference)));
        }
        if let Some(event_type) = &self.event_type {
            out.push(("eventType".into(), Data::text(event_type.clone())));
        }
        if let Some(record_type) = &self.record_type {
            out.push(("recordType".into(), Data::text(record_type.clone())));
        }
        if let Some(at) = &self.occurred_at {
            out.push(("occurredAt".into(), Data::text(at.clone())));
        }
        Data::Map(out).to_wire()
    }
}

/// One run: the movement's source, the function to fire, its event and the
/// instant the run is pinned to.
#[derive(Debug, Clone)]
pub struct RunInput {
    pub source: String,
    pub language_version: u32,
    /// The function the event fires (a `listen … fire <function>`); `None`
    /// runs the file's one movement.
    pub function: Option<String>,
    pub event: Event,
    /// The run's pinned instant (ISO 8601): what `NOW()` and `TODAY()` read.
    pub now: String,
    pub catalog: Catalog,
    /// A rehearsal: every write captured by the adapter, none made.
    pub dry_run: bool,
    /// The run's spending cap, in microdollars.
    pub cost_cap_microdollars: Option<f64>,
}

impl RunInput {
    pub fn new(source: impl Into<String>, event: Event, now: impl Into<String>) -> RunInput {
        RunInput {
            source: source.into(),
            language_version: LANGUAGE_VERSION,
            function: None,
            event,
            now: now.into(),
            catalog: Catalog::default(),
            dry_run: false,
            cost_cap_microdollars: None,
        }
    }
    pub fn function(mut self, function: impl Into<String>) -> RunInput {
        self.function = Some(function.into());
        self
    }
    pub fn catalog(mut self, catalog: Catalog) -> RunInput {
        self.catalog = catalog;
        self
    }
}

/// How a run ended.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// It ran to its end.
    Finished(RunResult),
    /// A flow parked (`sleep`, `await`): the store holds its state, and the
    /// run resumes from it when the park is due.
    Parked(RunResult),
    /// Its cancel gate closed.
    Cancelled(RunResult),
    /// It failed: an engine error, or a host failure it could not get past.
    Failed(RunFailure),
    /// The engine does not run it (a language version below 5, say).
    Refused(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunResult {
    pub function: String,
    /// The writes it made, in program order, as write records.
    pub writes: Vec<Data>,
    pub parked_address: Option<String>,
    /// What it spent, by who charged it.
    pub cost: Vec<Cost>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunFailure {
    /// The engine's code (`MOVENG_CHECK`, `MOVENG_RUNTIME`, …), absent for a
    /// host's own failure.
    pub code: Option<String>,
    pub message: String,
    /// The host call that failed it, when one did.
    pub host: Option<HostFailure>,
}

/// A misuse of the embedding (an input the engine cannot read), never a
/// run's own failure.
#[derive(Debug, Clone, PartialEq)]
pub struct EmbedError(pub String);

impl std::fmt::Display for EmbedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EmbedError {}

impl From<ProtocolError> for EmbedError {
    fn from(error: ProtocolError) -> EmbedError {
        EmbedError(error.0)
    }
}

/// Run `input` to its end against `hosts`.
pub fn run(hosts: &mut Hosts<'_>, input: &RunInput) -> Result<Outcome, EmbedError> {
    drive(hosts, input, None)
}

/// Resume a parked flow of `input`'s run from its state, once its park is
/// due (a timer's `wake_at` passed, an awaited event arrived).
pub fn resume(hosts: &mut Hosts<'_>, input: &RunInput, state: &ParkedState) -> Result<Outcome, EmbedError> {
    drive(hosts, input, Some(state))
}

fn drive(hosts: &mut Hosts<'_>, input: &RunInput, resume: Option<&ParkedState>) -> Result<Outcome, EmbedError> {
    let segment_id = "segment";
    let mut segment = crate::begin(&input_text(hosts, input, resume, segment_id))?;
    let mut session = serve::Session::new(input.now.clone());
    let mut queue = std::collections::VecDeque::new();
    let mut step = segment.start()?;
    let done = loop {
        match step {
            Step::Done(done) => break done,
            Step::Pending(pending) => {
                queue.extend(pending);
                let request = queue.pop_front().ok_or_else(|| EmbedError("the engine is waiting with no request in flight".into()))?;
                let answer = session.serve(hosts, &request);
                step = segment.answer(request.id, answer)?;
            }
        }
    };
    Ok(outcome(&done, &session.failures))
}

fn input_text(hosts: &mut Hosts<'_>, input: &RunInput, resume: Option<&ParkedState>, segment_id: &str) -> String {
    let credential_ids: serde_json::Map<String, Json> = input
        .catalog
        .snapshot
        .credential_names()
        .into_iter()
        .map(|name| {
            let id = hosts.secrets.as_deref_mut().and_then(|s| s.credential_id(name)).unwrap_or_else(|| name.to_string());
            (name.to_string(), json!(id))
        })
        .collect();
    let mut spend = json!({ "priorMicrodollars": 0, "capBaselineMicrodollars": 0 });
    if let Some(cap) = input.cost_cap_microdollars {
        spend["capMicrodollars"] = json!(cap);
    }
    let mut head = json!({
        "entry": "segment",
        "source": input.source,
        "languageVersion": input.language_version,
        "event": input.event.to_wire(&format!("embed:{}", input.function.as_deref().unwrap_or(""))),
        "segmentId": segment_id,
        "credentialIds": credential_ids,
        "spend": spend,
        "now": input.now,
        "serves": hosts.serves(),
        "nativeCheck": true,
        "snapshotModels": input.catalog.snapshot.models().map(|m| json!(m)).unwrap_or(Json::Null),
    });
    if let Some(function) = &input.function {
        head["movementName"] = json!(function);
    }
    if input.dry_run {
        head["dryRun"] = json!(true);
    }
    if let Some(state) = resume {
        head["resume"] = json!({ "state": state.0 });
    }
    // The catalog last, as its own text: its maps are read in their order.
    let head = head.to_string();
    format!("{},\"catalog\":{}}}", &head[..head.len() - 1], input.catalog.text)
}

fn outcome(done: &Json, failures: &[HostFailure]) -> Outcome {
    if let Some(reason) = done.get("refused").or_else(|| done.get("declined")) {
        return Outcome::Refused(reason.as_str().unwrap_or_default().to_string());
    }
    if let Some(error) = done.get("thrown").or_else(|| done.get("failed").and_then(|f| f.get("error"))) {
        let host = error.get("hostError").and_then(Json::as_u64).and_then(|r| failures.get(r as usize)).cloned();
        let message = match &host {
            Some(failure) => failure.message.clone(),
            None => error.get("message").and_then(Json::as_str).map(str::to_string).unwrap_or_else(|| error.to_string()),
        };
        return Outcome::Failed(RunFailure { code: error.get("code").and_then(Json::as_str).map(str::to_string), message, host });
    }
    let result = done.get("result").cloned().unwrap_or(Json::Null);
    let writes = match result.get("writes").map(Data::from_wire) {
        Some(Ok(Data::List(writes))) => writes,
        _ => Vec::new(),
    };
    let cost = done.get("cost").and_then(|c| serde_json::from_value(c.clone()).ok()).unwrap_or_default();
    let ran = RunResult {
        function: result.get("movementName").and_then(Json::as_str).unwrap_or_default().to_string(),
        writes,
        parked_address: result.get("parkedAddress").and_then(Json::as_str).map(str::to_string),
        cost,
    };
    if result.get("cancelled") == Some(&json!(true)) {
        Outcome::Cancelled(ran)
    } else if result.get("parked") == Some(&json!(true)) {
        Outcome::Parked(ran)
    } else {
        Outcome::Finished(ran)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CATALOG: &str = r#"{"adapters":{"email":{"constructionArgs":[],"canFire":true,"schemas":{"":{"positions":{"message":{"properties":{"subject":"text"},"edges":{}}},"collections":{},"eventPosition":"message"}}}},"credentials":{},"plugins":{}}"#;
    const SOURCE: &str = "import { email } from adapters\ninbox = connect email\nfunction m(msg: <inbox-[:message]->>) {\n  s = msg.`subject`\n  await sleep(1h)\n}\nlisten to inbox fire m\n";

    struct Inbox;

    impl Adapters for Inbox {
        fn resolve(&mut self, _request: AdapterRequest) -> HostResult<AdapterInstance> {
            Ok(AdapterInstance { id: "i1".into(), methods: Vec::new() })
        }
        fn call(&mut self, call: AdapterCall) -> HostResult<AdapterReply> {
            Ok(match call.method.as_str() {
                "getFieldValue" => AdapterReply::ok(Data::text("Hi")),
                _ => AdapterReply::nothing(),
            })
        }
    }

    fn input() -> RunInput {
        let event = Event::new("email", Data::map([("subject", Data::text("Hi"))]));
        RunInput::new(SOURCE, event, "2026-03-12T12:00:00.000Z").function("m").catalog(Catalog::from_json(CATALOG).unwrap())
    }

    /// A host with no store cannot park: the run fails naming what it
    /// needed, never quietly skips the `sleep`.
    #[test]
    fn a_run_that_parks_on_a_host_with_no_store_fails_naming_the_park() {
        assert!(check(SOURCE, &Catalog::from_json(CATALOG).unwrap(), LANGUAGE_VERSION).iter().all(|p| p.severity != Severity::Error));
        assert_eq!(listens(SOURCE, LANGUAGE_VERSION).unwrap(), vec![Listen { adapter: "email".into(), function: "m".into(), events: Vec::new() }]);
        let mut inbox = Inbox;
        let outcome = run(&mut Hosts::new().adapters(&mut inbox), &input()).unwrap();
        let Outcome::Failed(failure) = outcome else { panic!("{outcome:?}") };
        assert!(failure.message.contains("sleep") || failure.message.contains("park"), "{failure:?}");
    }

    /// With a store, the same run parks, and resumes from the state it kept.
    #[test]
    fn a_parked_run_resumes_from_its_stored_state() {
        #[derive(Default)]
        struct Timers(Vec<TimerPark>);
        impl Store for Timers {
            fn keeps_parks(&self) -> bool {
                true
            }
            fn commit_timer_park(&mut self, park: TimerPark) -> HostResult<()> {
                self.0.push(park);
                Ok(())
            }
        }
        let (mut inbox, mut timers) = (Inbox, Timers::default());
        let outcome = run(&mut Hosts::new().adapters(&mut inbox).store(&mut timers), &input()).unwrap();
        assert!(matches!(&outcome, Outcome::Parked(ran) if ran.function == "m"), "{outcome:?}");
        assert_eq!(timers.0[0].wake_at, "2026-03-12T13:00:00.000Z");
        let state = timers.0[0].state.clone();
        let outcome = resume(&mut Hosts::new().adapters(&mut inbox).store(&mut timers), &input(), &state).unwrap();
        assert!(matches!(outcome, Outcome::Finished(_)), "{outcome:?}");
    }
}
