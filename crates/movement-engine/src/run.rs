//! A segment of a run, executed whole: run.ts's `runMovement` for the
//! programs this engine admits (crate::admit says which). The same steps in
//! the same order, every one the TypeScript takes through its host taken
//! here as a host request:
//!
//! 1. the pinned source parsed and admitted (crate::admit, before any
//!    request), then checked (`check.program`, program.rs);
//! 2. `prepareMovement`: the file scope (imports, instances from the
//!    snapshot's `instantiate`), the movement picked, the source adapter
//!    resolved (`adapters.resolve`), the event seeded (`seedEventPosition`);
//! 3. `interpretBody` over the movement's statements, the cancel gate asked
//!    at each (`control.cancelled`): `x = <expr>`, `if`/`else`, `return`,
//!    writes (crate::write), node and graph literals (crate::node), calls of
//!    the program's movements (crate::call), body constructions, `sleep` (a
//!    park: crate::park) — or, resuming, the parked leaf's continuation;
//! 4. the last cancel check (`control.cancelledNow`) and the result: the
//!    writes, and where the run parked.
//!
//! An expression is evaluated by `eval::Evaluator`, one walk per
//! expression. What it cannot answer itself — a field of the event, read
//! through the source adapter; a built-in reading this engine hands back — it
//! asks, and awaits the answer where it asked, so the host sees the
//! TypeScript's calls in the TypeScript's order, short-circuits included.
//!
//! `done` is one of:
//!
//! - `{result: {movementName, writes, parked?, parkedAddress?, cancelled?}}`;
//! - `{failed: {error, result}}`: the body failed (`MovementRunFailed`,
//!   which carries what the run did before it);
//! - `{thrown: error}`: it failed before the body ran;
//! - `{refused: reason}`: admission (crate::admit) found, on this engine's
//!   own parse and before any host request, that the program or its parked
//!   state needs what this engine does not run;
//! - `{declined: reason}`: past admission, before anything the host can see
//!   happened, the check's stamps or the run's input turned out to need what
//!   this engine does not run.
//!
//! For either the shim runs the program on the TypeScript engine instead.
//!
//! `error` is `{class: "MovementEngineError", code, message}`, `{class:
//! "Error" | "RangeError", message}`, `{class: "RunCostCapExceeded",
//! capMicrodollars, spentMicrodollars}` (a run that met its cap where it
//! cannot suspend), or `{hostError: ref}`: the very error a host call failed
//! with, which the shim holds and rethrows.
//!
//! A run that meets its cost cap where it can suspend pauses instead
//! (crate::park): its `done` is a parked result, as a timer park's is.

use std::cell::RefCell;
use std::rc::Rc;

use movement_parser::ast::{self, AwaitSource, ExprSlot, MovementDeclaration, ParamTypeRef, RValue, Statement};
use movement_parser::catalog::helpers::{credential_arg_of, unwrap_credential_arg};
use movement_parser::catalog::snapshot::Args;
use movement_parser::catalog::types::{CatalogSnapshot, Composite, FieldType, InstanceSchema};
use movement_parser::lowering::condition::MovementCondition;
use movement_parser::lowering::expression::{AggregationFunction, Expression, FilterOperator, TraversalStep};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value as Json, json};

use crate::bindings::{Binding, InstanceBinding, Position, Scope};
use crate::write::{TargetAdapter, WriteRecord};
use crate::env::{self, Trail, ValueBinding};
use crate::eval::{Ask, ErrorClass, EvalError, Evaluated, Evaluating, Evaluator, Prov, Reader};
use crate::executor::{Host, HostError};
use crate::host::{self, Instance, ResolveAdapter, Role};
use crate::js::{self, Js, JsObject};
use crate::program::{self, Checked, Stamp};
use crate::stdlib::Surroundings;
use crate::trace::{FlowTrace, TraceEntry};
use crate::{env_services, js_date};

/// Why a segment this engine refused mid-run, before any effect, is the
/// TypeScript engine's to run (`declined`).
pub(crate) const UNREPRODUCED: &str = "unreproduced";

/// The slot a `return` binds its value into (run.ts `RETURN_SLOT`): a name
/// the grammar cannot spell.
pub(crate) const RETURN_SLOT: &str = "#return";

/// What the shim sends (rust_engine.ts `segmentInput`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentInput {
    pub source: String,
    /// The pin the run is under, written out by the shim.
    pub language_version: u32,
    #[serde(default)]
    pub movement_name: Option<String>,
    /// The trigger event, on the eval wire (its payload's key order is the
    /// JavaScript's).
    pub event: Json,
    /// The segment the run host opened for this entry (`segment.open`):
    /// every host request names it.
    pub segment_id: String,
    /// The credential ids the run's imports name, by credential name
    /// (`RunMovementInput.credentialIds`).
    #[serde(default)]
    pub credential_ids: std::collections::BTreeMap<String, String>,
    /// The run's spend account as this segment starts (crate::ledger).
    #[serde(default)]
    pub spend: crate::ledger::Spend,
    /// The run's pinned instant (`firedAt`, else when the run began).
    pub now: String,
    /// Kept as text: the catalog's maps are ordered.
    pub catalog: Box<RawValue>,
    /// A rehearsal: every write captured by the host, not committed, and a
    /// `sleep` fast-forwarded.
    #[serde(default)]
    pub dry_run: bool,
    /// Resume a parked run from its state (crate::park), rather than run it.
    #[serde(default)]
    pub resume: Option<crate::park::ResumeInput>,
    /// The run is paused at its cost cap, and this segment was woken for one
    /// of its flows: the flow suspends before its next statement
    /// (`RunMovementInput.limitPaused`).
    #[serde(default)]
    pub limit_paused: bool,
    /// Where to suspend, by address, once each (`RunMovementInput.suspendAt`):
    /// a statement's address suspends the flow just before it. An address
    /// before a call (`… .c k`) is refused at admission (`suspend_at_call`).
    #[serde(default)]
    pub suspend_at: Vec<String>,
    /// Every host method the run's host serves, by path
    /// (`park.sink.commitTimerPark`): the optional ones it serves are what
    /// the engine may ask, as the TypeScript engine asks its host object.
    pub serves: Vec<String>,
    /// How much of one source file's text an extraction prompt takes
    /// (extraction.ts `maxFileChars`, a deployment's `EXTRACTION_FILE_CHARS`):
    /// the shim reads it, so the engine reads no environment.
    #[serde(default = "default_file_chars")]
    pub extraction_file_chars: usize,
    /// How many named calls deep one run may nest from version 3
    /// (call_depth.ts `maxCallDepth`, a deployment's
    /// `MOVEMENT_MAX_CALL_DEPTH`): the shim reads it, so the engine reads no
    /// environment.
    #[serde(default = "default_call_depth")]
    pub max_call_depth: usize,
}

/// call_depth.ts `DEFAULT_MAX_CALL_DEPTH`.
fn default_call_depth() -> usize {
    32
}

fn default_file_chars() -> usize {
    50_000
}

/// The snapshot's plugins alone, read before the rest of it loads.
#[derive(Deserialize)]
struct CatalogPlugins {
    #[serde(default = "no_plugins")]
    plugins: movement_parser::catalog::types::JsMap<movement_parser::catalog::types::PluginSpec>,
}

fn no_plugins() -> movement_parser::catalog::types::JsMap<movement_parser::catalog::types::PluginSpec> {
    movement_parser::catalog::types::JsMap(Default::default())
}

/// The segment entry: the run, and its `done`.
pub async fn segment(host: Host, input: SegmentInput) -> Json {
    let ledger = crate::ledger::Ledger::new(&input.spend);
    let mut done = match run(&host, &input, &ledger).await {
        Ok(result) => json!({ "result": result }),
        Err(Stop::Refused(reasons)) => return json!({ "refused": reasons[0], "reasons": reasons }),
        Err(Stop::Declined(reason)) => return json!({ "declined": reason }),
        Err(Stop::Thrown(failure)) => json!({ "thrown": failure.to_json() }),
        Err(Stop::Failed(failure, result)) => json!({ "failed": { "error": failure.to_json(), "result": result } }),
        Err(Stop::Cancelled | Stop::Parked(_) | Stop::EndedQuietly) => {
            unreachable!("a cancel, a park or a quiet end ends the body, and the run returns its result")
        }
    };
    // What this segment's priced calls spent, by source, for the run host's
    // account (the run's figures are the run host's to report).
    let cost = ledger.cost_lines();
    if !cost.is_empty() {
        done["cost"] = json!(cost);
    }
    done
}

/// How a run stops early.
pub(crate) enum Stop {
    /// Not admitted: nothing but the parse and the walk happened. Every
    /// reason the walk met, the first first; never empty.
    Refused(Vec<String>),
    /// Past admission, before any host-visible effect.
    Declined(String),
    Thrown(Failure),
    /// The body failed; the result so far rides with it.
    Failed(Failure, Json),
    /// The cancel gate said so at a statement boundary (`RunCancelledSignal`).
    Cancelled,
    /// The flow parked at this address (`RunParked`): its state is durable.
    Parked(String),
    /// A match found nothing (`ScopeEndedQuietly`): the enclosing scope ends
    /// with nothing thrown — a block's iteration skips, the movement's body
    /// stops, and the run completes.
    EndedQuietly,
}

#[derive(Debug, Clone)]
pub(crate) enum Failure {
    Engine { class: ErrorClass, message: String },
    Host(HostError),
    /// The run met its cost cap (`RunCostCapExceeded`): the statement
    /// suspends where it can, and fails the run where it cannot.
    CapExceeded(crate::ledger::CapExceeded),
    /// A call would nest deeper than the limit (`CallDepthExceeded`): the
    /// run's movement, each call it is inside, then the refused one.
    CallDepth { limit: usize, chain: Vec<String> },
}

impl Failure {
    pub(crate) fn engine(code: &'static str, message: String) -> Failure {
        Failure::Engine { class: ErrorClass::Engine(code), message }
    }

    /// `unsupported(construct, detail?)`: an empty detail is none.
    pub(crate) fn unsupported(construct: &str, detail: &str) -> Failure {
        Failure::engine("MOVENG_UNSUPPORTED", unsupported_message(construct, detail))
    }

    /// This engine's refusal, mid-run, of what the TypeScript engine reads
    /// on through (`ErrorClass::Unreproduced`): `unsupported`'s message.
    pub(crate) fn unreproduced(construct: &str, detail: &str) -> Failure {
        Failure::Engine { class: ErrorClass::Unreproduced, message: unsupported_message(construct, detail) }
    }

    /// This engine's own refusal of what the TypeScript engine runs on
    /// through (`unreproduced`).
    pub(crate) fn is_unreproduced(&self) -> bool {
        matches!(self, Failure::Engine { class: ErrorClass::Unreproduced, .. })
    }

    /// The failure as an evaluation carries it out of a read it awaited.
    pub(crate) fn into_eval(self) -> EvalError {
        match self {
            Failure::Engine { class, message } => EvalError::Thrown { class, message },
            Failure::Host(error) => EvalError::Host(error),
            Failure::CapExceeded(cap) => EvalError::CapExceeded(cap),
            // No evaluation makes a call: a call's statement does.
            Failure::CallDepth { .. } => unreachable!("an expression makes no movement call"),
        }
    }

    /// What an evaluation failed with; a reading this engine hands back
    /// fails the run, `unreproduced` saying so.
    pub(crate) fn of_eval(error: EvalError, unreproduced: &str) -> Failure {
        match error {
            EvalError::Thrown { class, message } => Failure::Engine { class, message },
            EvalError::Host(error) => Failure::Host(error),
            EvalError::CapExceeded(cap) => Failure::CapExceeded(cap),
            EvalError::Fallback(reason) => Failure::unreproduced(&format!("this reading ({reason})"), unreproduced),
        }
    }

    fn to_json(&self) -> Json {
        match self {
            Failure::Engine { class: ErrorClass::Engine(code), message } => {
                json!({ "class": "MovementEngineError", "code": code, "message": message })
            }
            Failure::Engine { class: ErrorClass::Unreproduced, message } => {
                json!({ "class": "MovementEngineError", "code": "MOVENG_UNSUPPORTED", "message": message })
            }
            Failure::Engine { class: ErrorClass::Error, message } => json!({ "class": "Error", "message": message }),
            Failure::Engine { class: ErrorClass::RangeError, message } => json!({ "class": "RangeError", "message": message }),
            Failure::Engine { class: ErrorClass::TypeError, message } => json!({ "class": "TypeError", "message": message }),
            Failure::Host(error) => json!({ "hostError": error.detail.get("ref").cloned().unwrap_or(Json::Null) }),
            Failure::CapExceeded(cap) => cap.to_json(),
            Failure::CallDepth { limit, chain } => json!({ "class": "CallDepthExceeded", "limit": limit, "chain": chain }),
        }
    }
}

/// `unsupported`'s message (expression.ts): an empty detail is none.
fn unsupported_message(construct: &str, detail: &str) -> String {
    let detail = if detail.is_empty() { String::new() } else { format!(" ({detail})") };
    format!("{construct} is not supported by the movement engine yet{detail}")
}

/// A body's outcome (`BodyOutcome`): it ran to its end, or a `return` ended it.
pub(crate) enum Flow {
    FellThrough,
    Returned,
}

/// The event's source: its adapter (the handle the host resolved), the
/// position the event seeded, and what the surface-read wrapper (kg.ts
/// `surfaceReadAdapter`) needs to name it.
pub(crate) struct Source {
    pub(crate) instance: Instance,
    /// The live adapter's own `adapterType`.
    pub(crate) adapter_type: String,
    pub(crate) instance_name: String,
    pub(crate) position: Position,
    /// The seeded position as the read wrapper stamps it for a read: one
    /// object, so every read of the event names it by one handle.
    pub(crate) surface: Js,
    /// The source as a graph a block head walks (crate::traverse).
    pub(crate) read: Rc<crate::traverse::Read>,
    /// The typed event's canonical address (`sourceEventAddress`), which an
    /// `IS` test of the event compares (crate::is_test).
    pub(crate) address: Option<EventAddress>,
}

pub use crate::address::Address;

pub(crate) struct Run<'a> {
    pub(crate) host: &'a Host,
    pub(crate) input: &'a SegmentInput,
    pub(crate) ledger: &'a crate::ledger::Ledger,
    pub(crate) event: Js,
    pub(crate) now_ms: f64,
    pub(crate) catalog: CatalogSnapshot,
    pub(crate) checked: Checked,
    /// Aliased imports: local name → the catalog's name.
    pub(crate) import_originals: RefCell<Vec<(String, String)>>,
    pub(crate) source: RefCell<Option<Rc<Source>>>,
    /// The instance the event came from (`sourceInstance`).
    pub(crate) source_instance: RefCell<Option<Rc<InstanceBinding>>>,
    /// Every provenance origin the run has met, by id (the trails hold ids),
    /// as the TypeScript's `ProvenanceOrigin` objects.
    pub(crate) origins: RefCell<Vec<Js>>,
    /// The fields a `field_miss` was traced for, by instance: once each.
    pub(crate) misses: RefCell<Vec<(String, String)>>,
    /// The run's own flow's trace, not yet handed to the host.
    pub(crate) trace: FlowTrace,
    pub(crate) movement_name: RefCell<String>,
    /// The writes, in program order (`MovementRunResult.writes`).
    pub(crate) writes: RefCell<Vec<Rc<WriteRecord>>>,
    /// The target adapters resolved, by instance identity.
    pub(crate) targets: RefCell<Vec<(String, Rc<TargetAdapter>)>>,
    /// What every write tells its adapter about where it came from.
    pub(crate) mutation_context: RefCell<Js>,
    /// The run is paused at a limit: the flow suspends at its next statement
    /// boundary. From the input, or set as the run meets its cap; never
    /// cleared within a segment (run.ts `limitPaused`).
    pub(crate) limit_paused: std::cell::Cell<bool>,
    /// The `suspendAt` addresses not yet suspended at.
    pub(crate) pending_suspensions: RefCell<Vec<String>>,
    /// The graphs block heads read through, resolved as sources, by
    /// instance identity (`sourceAdapterCache`).
    pub(crate) source_reads: RefCell<Vec<(String, Rc<crate::traverse::Read>)>>,
    /// The positions registered with the host this segment (crate::host
    /// `call_at`), by handle number.
    pub(crate) positions: RefCell<crate::traverse::PositionTable>,
    /// The extraction sites the writes' provenance cites, by site id, each
    /// summarised once (`ProvenanceSummariser.sites`): the result's
    /// `extractionSites`.
    pub(crate) extraction_sites: RefCell<Vec<(String, Js)>>,
    /// The reply digests the run's trace holds (`TraceSink`'s budget).
    pub(crate) reply_digests: std::cell::Cell<usize>,
    /// The files whose bytes could not be fetched, warned of once each.
    pub(crate) unfetched_files: RefCell<Vec<String>>,
    /// Log lines not yet handed to the shim.
    pub(crate) log_lines: RefCell<Vec<Json>>,
    /// The file's scope, which a callee's scope forks from.
    pub(crate) file_scope: RefCell<Option<Rc<Scope>>>,
    /// Per statement running, at every depth, the calls it has made
    /// (`StatementSite.calls.next`): the next call's index.
    pub(crate) call_sites: RefCell<Vec<usize>>,
    /// The movements running, the dispatched one first (`callStack`).
    pub(crate) call_stack: RefCell<Vec<String>>,
    /// The movements the dispatched one calls, each with the parameters a
    /// call may bind to the event (crate::admit `Admission`).
    pub(crate) called: Vec<(String, Vec<String>)>,
    /// The segment's wire with its host: what the host sent, by id.
    pub(crate) wire: env::Wire,
    /// The run has asked its host for something other than a read: from
    /// then on, a refusal of this engine's own fails the run rather than
    /// handing it to the TypeScript engine.
    pub(crate) effected: std::cell::Cell<bool>,
}

async fn run(host: &Host, input: &SegmentInput, ledger: &crate::ledger::Ledger) -> Result<Json, Stop> {
    let version = input.language_version;
    // Admission first, on this engine's own parse: a program (or a parked
    // state) it does not run costs no catalog load, no check, no request.
    let root = match program::parse(&input.source, version) {
        Ok(root) => root,
        Err(_) => return Err(unparsed(host, input).await),
    };
    // What a plugin call binds is the snapshot's to say, read off the input.
    let plugins = serde_json::from_str::<CatalogPlugins>(input.catalog.get()).ok();
    let movements = crate::admit::reachable(&root.program, input.movement_name.as_deref(), version);
    let declared: Vec<&MovementDeclaration> =
        root.program.statements.iter().filter_map(|s| if let Statement::Movement(m) = s { Some(m) } else { None }).collect();
    let entry = crate::admit::entry_of(&declared, input.movement_name.as_deref(), version);
    let crate::admit::Admission { mut reasons, called } =
        crate::admit::refusals(&root.program, &movements, entry, version, &crate::admit::Plugins(plugins.as_ref().map(|c| &c.plugins)));
    let admitted_input = crate::admit::Input {
        capped: input.spend.cap_microdollars.is_some(),
        suspend_at: &input.suspend_at,
        limit_paused: input.limit_paused,
        dry_run: input.dry_run,
    };
    reasons.extend(crate::admit::input_refusal(&root.program, &movements, entry, &admitted_input));
    if let Some(resume) = &input.resume {
        reasons.extend(crate::park::resume_refusal(&resume.state));
    }
    if !reasons.is_empty() {
        return Err(Stop::Refused(reasons));
    }
    let catalog = CatalogSnapshot::load(input.catalog.get()).map_err(|_| Stop::Declined("catalog_does_not_load".into()))?;
    // The event crosses on the segment's wire: its objects are what the
    // host sent first.
    let wire = env::Wire::default();
    let event = wire.decode(&input.event).map_err(|_| Stop::Declined("event_does_not_read".into()))?;
    let now_ms = match js_date::parse(&input.now) {
        js_date::Parsed::Valid(ms) => ms,
        _ => return Err(Stop::Declined("instant_does_not_read".into())),
    };
    let answer = host
        .request(host::check::program(&input.source, version, None))
        .await
        .map_err(|e| Stop::Thrown(Failure::Host(e)))?
        .ok_or_else(|| Stop::Declined("check_answer_malformed".into()))?;
    let checked = program::join_check(root, &answer, version).map_err(|_| Stop::Declined("check_answer_malformed".into()))?;
    let run = Run {
        host,
        input,
        ledger,
        event: event.clone(),
        now_ms,
        catalog,
        checked,
        import_originals: RefCell::default(),
        source: RefCell::default(),
        source_instance: RefCell::default(),
        origins: RefCell::default(),
        misses: RefCell::default(),
        trace: FlowTrace::default(),
        movement_name: RefCell::default(),
        writes: RefCell::default(),
        targets: RefCell::default(),
        mutation_context: RefCell::new(mutation_context(&event, now_ms)),
        limit_paused: std::cell::Cell::new(input.limit_paused),
        pending_suspensions: RefCell::new(input.suspend_at.clone()),
        source_reads: RefCell::default(),
        positions: RefCell::default(),
        extraction_sites: RefCell::default(),
        reply_digests: std::cell::Cell::new(0),
        unfetched_files: RefCell::default(),
        log_lines: RefCell::default(),
        file_scope: RefCell::default(),
        call_sites: RefCell::default(),
        call_stack: RefCell::default(),
        called,
        wire,
        effected: std::cell::Cell::new(false),
    };
    // What the check's stamps say this engine does not run is declined
    // before every host-visible effect, the version warning's trace entry
    // among them.
    if let Some(reason) = run.stamp_decline() {
        return Err(Stop::Declined(reason.into()));
    }
    // A deprecated pin runs, and says so on the run's own record (the check
    // answer's version warning; an unsupported pin never got an answer).
    if let Some((code, message)) = run.checked.version_warning.clone() {
        run.trace(TraceEntry::Warning { code, message });
    }
    let outcome = run.execute().await;
    // This engine's own refusal, met before anything the host keeps: the
    // TypeScript engine runs the segment, as for a refusal at admission.
    if let Err(Stop::Failed(failure, _) | Stop::Thrown(failure)) = &outcome
        && failure.is_unreproduced()
        && !run.effected.get()
    {
        return Err(Stop::Declined(UNREPRODUCED.into()));
    }
    // What the segment traced after its last statement's hand-over (a park,
    // a failure, a body that never ran). The TypeScript hands it over as its
    // segment closes, where a failure to is logged and never the run's
    // (run_context.ts `closeRunContext`); so it is not this run's either:
    // the shim logs it.
    let _ = run.hand_over_trace(true).await;
    outcome
}

/// A source this engine's parser refuses: the check's to fail, as the
/// TypeScript engine's parse fails it (the shim ends the segment with the
/// check's own MOVENG_PARSE). A check that passes where the parser did not
/// is a grammar this engine lacks: declined, before anything the host sees.
async fn unparsed(host: &Host, input: &SegmentInput) -> Stop {
    match host.request(host::check::program(&input.source, input.language_version, None)).await {
        Ok(_) => Stop::Declined("source_does_not_parse".into()),
        Err(error) => Stop::Thrown(Failure::Host(error)),
    }
}

impl Run<'_> {
    pub(crate) fn version(&self) -> u32 {
        self.input.language_version
    }

    /// The segment every host request names.
    pub(crate) fn segment(&self) -> &str {
        &self.input.segment_id
    }

    /// Whether the host serves the method at `path`.
    pub(crate) fn serves(&self, path: &str) -> bool {
        self.input.serves.iter().any(|served| served == path)
    }

    /// The host's instant now (`clock.now`), in milliseconds.
    pub(crate) async fn clock_now(&self) -> Result<f64, Failure> {
        let answer = self.ask(host::clock::now(self.segment())).await?;
        host::clock::instant_of(answer.as_ref()).ok_or_else(|| {
            let shown = answer.map_or_else(|| "nothing".to_string(), |a| a.to_string());
            Failure::engine("MOVENG_RUNTIME", format!("clock.now answered {shown}, which is not {{ nowIso: <an ISO 8601 instant> }}"))
        })
    }

    /// The comparator's request for a reading `compare_values` hands back.
    /// A `WITHIN` measures from the host's clock, asked for it alone, as the
    /// TypeScript engine asks it at the comparison.
    pub(crate) async fn compare_request(&self, op: FilterOperator, left: &Js, right: &Js) -> Result<host::Request, Failure> {
        let now = match op {
            FilterOperator::Within => Some(js_date::to_iso_string(self.clock_now().await?)),
            _ => None,
        };
        self.compare_request_at(op, left, right, now.as_deref())
    }

    /// The comparator's request, a `WITHIN`'s instant given.
    pub(crate) fn compare_request_at(&self, op: FilterOperator, left: &Js, right: &Js, now: Option<&str>) -> Result<host::Request, Failure> {
        let op = serde_json::to_value(op).expect("an operator is JSON");
        Ok(host::builtins::compare(op.as_str().unwrap_or_default(), self.encode(left)?, self.encode(right)?, now))
    }

    /// The credential id the run was handed for `name`, if any.
    pub(crate) fn credential_id(&self, name: &str) -> Option<String> {
        self.input.credential_ids.get(name).cloned()
    }

    /// `assembleResult`: the writes cross on the eval wire, as the records
    /// the TypeScript builds.
    fn result(&self, cancelled: bool, parked: Option<&str>) -> Json {
        let writes: Vec<Js> = self.writes.borrow().iter().map(|w| w.object.clone()).collect();
        let mut result = json!({ "movementName": *self.movement_name.borrow(), "writes": self.wire.encode_result(&Js::array(writes)) });
        // Each extraction site the writes cite, once (`ProvenanceSummariser.sites`).
        let sites = self.extraction_sites.borrow();
        if !sites.is_empty() {
            let mut table = JsObject::new();
            for (id, summary) in sites.iter() {
                table.set(id.clone(), summary.clone());
            }
            result["extractionSites"] = self.wire.encode_result(&Js::object(table));
        }
        drop(sites);
        if let Some(address) = parked {
            result["parked"] = json!(true);
            result["parkedAddress"] = json!(address);
        }
        if cancelled {
            result["cancelled"] = json!(true);
        }
        result
    }

    async fn execute(&self) -> Result<Json, Stop> {
        let (movement, index, scope) = self.prepare().await?;
        let path = format!("/statements/{index}/body");
        let ran = match &self.input.resume {
            None => self.body(&movement.body, &scope, &Address::default(), &path, 0).await.map(|_| ()),
            Some(resume) => self.resume(resume, &movement, &scope, &path).await,
        };
        let (cancelled, parked) = match ran {
            // Find-on-missing at the top scope: the body simply stops, its
            // earlier writes stand, and the run completes.
            Ok(()) | Err(Stop::EndedQuietly) => (false, None),
            Err(Stop::Cancelled) => (true, None),
            Err(Stop::Parked(address)) => (false, Some(address)),
            Err(Stop::Thrown(failure)) => return Err(Stop::Failed(failure, self.result(false, None))),
            Err(other) => return Err(other),
        };
        // The last cancel check: a cancel stamped while the final statement
        // ran has no later boundary to be found at. A parked run's cancel is
        // the park sink's to settle.
        let cancelled = cancelled
            || (parked.is_none()
                && self.ask_bool(host::control::cancelled_now(self.segment())).await.map_err(|f| Stop::Failed(f, self.result(false, None)))?);
        Ok(self.result(cancelled, parked.as_deref()))
    }

    // ── prepareMovement ──

    async fn prepare(&self) -> Result<(MovementDeclaration, usize, Rc<Scope>), Stop> {
        let file = Scope::root();
        let statements = &self.checked.root.program.statements;
        let mut movements = Vec::new();
        let mut deferred = Vec::new();
        for statement in statements {
            match statement {
                Statement::Movement(m) => {
                    file.declare(m.name.clone(), Binding::Movement(m.name.clone()));
                    movements.push(m);
                }
                other => deferred.push(other),
            }
        }
        let movement = self.select_movement(&movements)?.clone();
        let index = statements
            .iter()
            .position(|s| matches!(s, Statement::Movement(m) if m.name == movement.name && m.span == movement.span))
            .expect("the movement picked is one of the program's");
        *self.movement_name.borrow_mut() = movement.name.clone();
        // In source order, so a file-level value reads the ones before it.
        for statement in deferred {
            match statement {
                Statement::Assign(assign) if !matches!(assign.value, RValue::Construct { .. }) => {
                    let expr = self.value_slot(&assign.value, &file)?;
                    let bound = self.bind_slot(expr, &file).await?;
                    file.declare(assign.name.clone(), Binding::Value(bound));
                }
                other => self.file_statement(other, &file),
            }
        }
        if movement.params.len() != 1 {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!(
                    "'{}' takes {} parameters — a dispatched movement takes exactly one (the triggering event); multi-parameter movements run as callees",
                    movement.name,
                    movement.params.len()
                ),
            )));
        }
        let param = &movement.params[0];
        let type_ref = match &param.type_ {
            None => {
                return Err(Stop::Thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!("'{}' has an untyped parameter — the checker should have caught this", movement.name),
                )));
            }
            Some(ParamTypeRef::Name(type_ref)) => type_ref,
            Some(ParamTypeRef::Value(_)) => unreachable!("admission refuses a value-typed parameter"),
        };
        let Some(Binding::Instance(source_instance)) = file.resolve(&type_ref.graph) else {
            return Err(Stop::Thrown(Failure::unsupported(
                &format!("a movement parameter typed against '{}'", type_ref.graph),
                "type the parameter against a constructed adapter instance",
            )));
        };
        self.seed(&source_instance, type_ref).await.map_err(Stop::Thrown)?;
        if event_text(&self.event, "triggerType").as_deref() == Some("snapshot") {
            let mut context = self.mutation_context.borrow().clone();
            if let Js::Object(object) = &context {
                let mut object = JsObject::clone_of(object);
                let mut source = match object.get("source") {
                    Some(Js::Object(source)) => JsObject::clone_of(source),
                    _ => JsObject::new(),
                };
                source.set("type".into(), Js::str("structured_input"));
                source.set("adapterType".into(), Js::str(source_instance.adapter_slug.clone()));
                object.set("source".into(), Js::object(source));
                context = Js::object(object);
            }
            *self.mutation_context.borrow_mut() = context;
        }
        *self.source_instance.borrow_mut() = Some(source_instance.clone());
        *self.file_scope.borrow_mut() = Some(file.clone());
        self.call_stack.borrow_mut().push(movement.name.clone());
        let movement_scope = file.child();
        movement_scope.declare(param.name.clone(), Binding::Event);
        Ok((movement, index, movement_scope))
    }

    /// What the checker's stamps on the dispatched movement, and on each
    /// movement it calls, say this engine does not run, found with no effect:
    ///
    /// - `event_field_dated`: a field the program reads off the event — by
    ///   name, or as a `...msg` spread's stamp names it — that the source's
    ///   schema types as a date. The adapter may answer it as a `Date`, which
    ///   no value of this engine is. `prepareMovement`'s picks (the
    ///   movement, its event parameter, the source instance) are made here
    ///   with no effect; anything `prepare` would fail on is left for it.
    fn stamp_decline(&self) -> Option<&'static str> {
        let statements = &self.checked.root.program.statements;
        let movements: Vec<&MovementDeclaration> = statements
            .iter()
            .filter_map(|s| match s {
                Statement::Movement(m) => Some(m),
                _ => None,
            })
            .collect();
        let movement: &MovementDeclaration = self.select_movement(&movements).ok()?;
        let index_of = |m: &MovementDeclaration| statements.iter().position(|s| matches!(s, Statement::Movement(d) if std::ptr::eq(d, m)));
        // The dispatched movement, and each it calls with the parameters a
        // call may bind to the event: what each body reads of the event, by
        // its own names for it.
        let mut bodies: Vec<(String, &MovementDeclaration, Vec<String>)> = Vec::new();
        let dispatched = movement.params.first().map(|p| vec![p.name.clone()]).unwrap_or_default();
        bodies.push((format!("/statements/{}/", index_of(movement)?), movement, dispatched));
        for (name, params) in &self.called {
            let Some(callee) = movements.iter().find(|m| m.name == *name) else { continue };
            bodies.push((format!("/statements/{}/", index_of(callee)?), callee, params.clone()));
        }
        let [param] = movement.params.as_slice() else { return None };
        let Some(ParamTypeRef::Name(type_ref)) = &param.type_ else { return None };
        let file = Scope::root();
        for statement in statements.iter().filter(|s| !matches!(s, Statement::Movement(_))) {
            self.file_statement(statement, &file);
        }
        self.import_originals.borrow_mut().clear();
        let Some(Binding::Instance(instance)) = file.resolve(&type_ref.graph) else { return None };
        let schema = instance.schema.as_ref()?;
        let dated = |field: &str| {
            schema.positions.0.iter().any(|(name, position)| {
                (type_ref.position.as_deref().is_none_or(|p| p == name))
                    && position.properties.0.get(field).is_some_and(|t| is_dated(t, schema, &mut Vec::new()))
            })
        };
        let mut read = Vec::new();
        for (prefix, body, params) in &bodies {
            let text = serde_json::to_string(&body.body).unwrap_or_default();
            // The event under each name a body has for it, and every second
            // name for it (`m2 = msg`).
            let names: Vec<String> = params.iter().flat_map(|p| event_names(&body.body, p)).collect();
            for name in &names {
                event_fields_read(&text, name, &mut |field| read.push(field.to_string()));
            }
            // `...msg` in a write: the lines the checker's stamp says it writes.
            for (path, stamp) in &self.checked.root.stamps {
                if let Stamp::SpreadFields(fields) = stamp
                    && path.starts_with(prefix.as_str())
                    && self.checked.root.tree.pointer(path).and_then(|n| n.get("source")).and_then(Json::as_str).is_some_and(|source| names.iter().any(|n| n == source))
                {
                    read.extend(fields.iter().cloned());
                }
            }
        }
        read.iter().any(|field| dated(field)).then_some("event_field_dated")
    }

    fn select_movement<'m>(&self, movements: &[&'m MovementDeclaration]) -> Result<&'m MovementDeclaration, Stop> {
        crate::admit::entry_of(movements, self.input.movement_name.as_deref(), self.version()).ok_or_else(|| {
            Stop::Thrown(Failure::engine(
                "MOVENG_NOT_FOUND",
                match self.input.movement_name.as_deref() {
                    Some(name) if !name.is_empty() => format!("no movement named '{name}' in this program"),
                    _ => format!(
                        "expected exactly one movement declaration (found {}) — pass movementName to pick one",
                        movements.len()
                    ),
                },
            ))
        })
    }

    /// `interpretFileStatement`, for what this engine runs at file scope
    /// with no effect (admission refused the rest; `prepare` evaluates the
    /// file-level values).
    fn file_statement(&self, statement: &Statement, file: &Scope) {
        match statement {
            Statement::Import(import) => {
                let plugins = matches!(&import.source, ast::ImportSource::Builtin { namespace } if namespace == "plugins");
                for name in &import.names {
                    if let Some(alias) = &name.alias {
                        self.import_originals.borrow_mut().push((alias.clone(), name.name.clone()));
                    }
                    let binding = if plugins { Binding::Plugin(name.name.clone()) } else { Binding::Opaque };
                    file.declare(name.alias.clone().unwrap_or_else(|| name.name.clone()), binding);
                }
            }
            Statement::Shape(shape) => file.declare(shape.name.clone(), Binding::Shape(shape.name.clone())),
            Statement::Assign(assign) => {
                if let RValue::Construct { construct } = &assign.value {
                    let instance = self.instance_binding(&assign.name, construct);
                    file.declare(assign.name.clone(), Binding::Instance(Rc::new(instance)));
                }
            }
            // A listen contributes nothing to a run.
            _ => {}
        }
    }

    fn original(&self, local: &str) -> String {
        self.import_originals
            .borrow()
            .iter()
            .find(|(alias, _)| alias == local)
            .map_or_else(|| local.to_string(), |(_, original)| original.clone())
    }

    /// `instanceBinding`: the construction's arguments as text, the
    /// credential's unwrapped, and the schema the snapshot instantiates.
    fn instance_binding(&self, name: &str, construct: &ast::ConstructionCall) -> InstanceBinding {
        let adapter_slug = self.original(&construct.callee);
        let credential_arg = self
            .catalog
            .adapter(&adapter_slug)
            .and_then(credential_arg_of)
            .map_or_else(|| "credentials".to_string(), |a| a.name.clone());
        let mut args = Args::default();
        let mut construction_config = Vec::new();
        for arg in &construct.args {
            let raw = js::trim(&arg.value.raw).to_string();
            if arg.name == credential_arg {
                args.0.insert(arg.name.clone(), self.original(&unwrap_credential_arg(&raw).unwrap_or_else(|| raw.clone())));
            } else {
                args.0.insert(arg.name.clone(), raw.clone());
                construction_config.push((arg.name.clone(), raw));
            }
        }
        let credential_name = construct
            .args
            .iter()
            .find(|a| a.name == credential_arg)
            .and_then(|a| unwrap_credential_arg(js::trim(&a.value.raw)))
            .map(|c| self.original(&c));
        InstanceBinding {
            name: name.to_string(),
            schema: self.catalog.instantiate(&adapter_slug, &args).cloned(),
            adapter_slug,
            credential_name,
            construction_config,
        }
    }

    /// The source adapter resolved and the event seeded (`prepareMovement`'s
    /// instance branch).
    async fn seed(&self, instance: &InstanceBinding, type_ref: &ast::TypeRef) -> Result<(), Failure> {
        let credentials_id = instance.credential_name.as_deref().and_then(|name| self.credential_id(name));
        let resolved = self
            .ask(host::adapters::resolve(self.segment(), &ResolveAdapter {
                adapter_type: Some(Json::String(instance.adapter_slug.clone())),
                credentials_id,
                construction_args: None,
                role: Role::Source,
                dry_run: false,
            }))
            .await?
            .unwrap_or(Json::Null);
        let handle = host::instance_of(&resolved).ok_or_else(|| Failure::engine("MOVENG_RUNTIME", format!("adapters.resolve answered {resolved}")))?;
        let adapter_type = resolved.get("adapterType").and_then(Json::as_str).unwrap_or(&instance.adapter_slug).to_string();
        let schema = instance.schema.as_ref();
        let root_record_type = event_text(&self.event, "rootRecordType");
        let root_surface_type = match self.natural_root_type_name(&handle, root_record_type.as_deref()).await {
            Some(name) => Some(name),
            None if event_text(&self.event, "triggerType").as_deref() == Some("mutation") => {
                sole_event_position(schema).or_else(|| type_ref.position.clone())
            }
            None => None,
        };
        let address = event_seed_address(schema, &self.event, root_surface_type.as_deref());
        let position = seed_event_position(&self.event, &instance.adapter_slug, root_surface_type, address.as_ref())?;
        let surface = restamp(&position, position.record_type.clone().or_else(|| type_ref.position.clone()), &adapter_type).to_js();
        let read = Rc::new(crate::traverse::Read::of_resolved(&resolved, handle.clone(), instance, type_ref.position.clone()));
        *self.source.borrow_mut() = Some(Rc::new(Source {
            instance: handle,
            adapter_type,
            instance_name: instance.name.clone(),
            position,
            surface,
            read,
            address,
        }));
        Ok(())
    }

    /// `naturalRootTypeName`: the discriminated root's machine type id named
    /// as the adapter's entry points name it, falling back to the id.
    async fn natural_root_type_name(&self, handle: &Instance, root_record_type: Option<&str>) -> Option<String> {
        let root = root_record_type?;
        // A failed listing names the root by its id, as the TypeScript's
        // catch does.
        let Ok(listed) = self.call_adapter(handle, "listEntryPoints", Js::object(JsObject::new())).await else {
            return Some(root.to_string());
        };
        let entries = Some(listed);
        let named = match entries {
            Some(Js::Array(list)) => list.items().iter().find_map(|entry| {
                let Js::Object(entry) = entry else { return None };
                matches!(entry.get("typeId"), Some(Js::String(id)) if id == root).then(|| match entry.get("displayName") {
                    Some(Js::Undefined | Js::Null) | None => None,
                    Some(name) => Some(name.to_js_string()),
                })?
            }),
            _ => None,
        };
        Some(named.unwrap_or_else(|| root.to_string()))
    }

    // ── interpretBody ──

    /// `interpretBody` from statement `from`; `path` is the body's AST path.
    pub(crate) fn body<'s>(
        &'s self,
        statements: &'s [Statement],
        scope: &'s Rc<Scope>,
        address: &'s Address,
        path: &'s str,
        from: usize,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Flow, Stop>> + 's>> {
        Box::pin(async move {
            for (index, statement) in statements.iter().enumerate().skip(from) {
                let at = address.stmt(index);
                // The cancel gate: a requested cancel stops the run at the
                // next statement boundary, never mid-statement.
                if self.ask_bool(host::control::cancelled(self.segment())).await.map_err(Stop::Thrown)? {
                    return Err(Stop::Cancelled);
                }
                // A paused run (its cap met here or before this segment)
                // stops each flow between statements; so does a `suspendAt`
                // address.
                self.suspend_before(&at, scope).await?;
                // The statement is the site of the calls it makes.
                self.call_sites.borrow_mut().push(0);
                let ran = self.statement(statement, scope, &at, &format!("{path}/{index}")).await;
                self.call_sites.borrow_mut().pop();
                let flow = match ran {
                    // The host refuses a priced call once the run has spent
                    // its cap: this statement was about to spend, so the run
                    // suspends just before it.
                    Err(Stop::Thrown(Failure::CapExceeded(cap))) => return Err(self.suspend_at_limit(cap, &at, scope).await),
                    other => other?,
                };
                self.publish_trace().await.map_err(Stop::Thrown)?;
                if let Flow::Returned = flow {
                    return Ok(Flow::Returned);
                }
            }
            Ok(Flow::FellThrough)
        })
    }

    async fn statement(&self, statement: &Statement, scope: &Rc<Scope>, at: &Address, path: &str) -> Result<Flow, Stop> {
        match statement {
            Statement::Assign(assign) => {
                self.assign(&assign.name, &assign.value, scope, at, path).await?;
                Ok(Flow::FellThrough)
            }
            Statement::Write(statement) => {
                self.write(&statement.write, None, scope, &format!("{path}/write")).await?;
                Ok(Flow::FellThrough)
            }
            Statement::Match(statement) => {
                self.match_record(&statement.r#match, None, scope).await?;
                Ok(Flow::FellThrough)
            }
            Statement::Link(statement) => {
                self.link(&statement.link, None, scope).await?;
                Ok(Flow::FellThrough)
            }
            Statement::Unlink(statement) => {
                self.unlink(statement, scope).await?;
                Ok(Flow::FellThrough)
            }
            Statement::Delete(statement) => {
                self.delete(&statement.name, scope).await?;
                Ok(Flow::FellThrough)
            }
            Statement::Await(statement) => match &statement.r#await.source {
                AwaitSource::Sleep { duration, .. } => {
                    self.sleep(duration, at, scope, None).await?;
                    Ok(Flow::FellThrough)
                }
                _ => Err(Stop::Thrown(Failure::unreproduced("this await", "the Rust engine runs `await sleep(…)`"))),
            },
            // `return <value>`: the same right-hand side, bound into a slot
            // the grammar cannot spell, and the body ends.
            Statement::Return(ret) => {
                self.assign(RETURN_SLOT, &ret.value, scope, at, path).await?;
                Ok(Flow::Returned)
            }
            Statement::Block(statement) => self.block(&statement.block, None, scope, at, path).await,
            // `ERROR(message)`: the run fails with the author's words.
            Statement::Error(statement) => {
                let expr = lowered(&statement.message, |tree| movement_parser::lowering::lower_expression(tree, &statement.message.raw), "expression")
                    .map_err(Stop::Thrown)?;
                let message = self.evaluate(&expr, scope, &statement.message).await?.value;
                let message = match message {
                    Js::String(text) => text,
                    other if other.is_nullish() => String::new(),
                    other => other.to_js_string(),
                };
                Err(Stop::Thrown(Failure::engine("MOVENG_ERROR", message)))
            }
            // A collection op run for its function's effects.
            Statement::Collection(statement) => {
                self.collection(&statement.collection, None, scope, at, &format!("{path}/collection/fn")).await?;
                Ok(Flow::FellThrough)
            }
            Statement::Call(call) if let Some(reading) = self.call_reading(call, scope)? => {
                match reading {
                    crate::collection::Reading::Collection(op) => {
                        let index = call.args.len() - 1;
                        self.collection(&op, None, scope, at, &format!("{path}/args/{index}")).await?;
                    }
                    crate::collection::Reading::Members(_) => {
                        return Err(Stop::Thrown(Failure::engine(
                            "MOVENG_RUNTIME",
                            format!("'{}(…)' reads a type's values and does nothing else — the checker should have caught this", call.callee),
                        )));
                    }
                }
                Ok(Flow::FellThrough)
            }
            // A plugin called for what it does: its value goes nowhere.
            Statement::Call(call) if matches!(scope.resolve(&call.callee), Some(Binding::Plugin(_))) => {
                self.plugin_call(&call.callee, &plugin_args(call)?, scope).await?;
                Ok(Flow::FellThrough)
            }
            Statement::Call(call) => {
                self.call(call, scope, at, path).await?;
                Ok(Flow::FellThrough)
            }
            Statement::If(statement) => {
                for (index, arm) in statement.arms.iter().enumerate() {
                    let taken = self.condition(&arm.condition, scope).await?;
                    self.trace(TraceEntry::Gate { outcome: taken });
                    if taken {
                        return self.arm(&arm.body, scope, &at.branch(index), &format!("{path}/arms/{index}/body")).await;
                    }
                }
                match &statement.else_arm {
                    Some(arm) => self.arm(&arm.body, scope, &at.branch(statement.arms.len()), &format!("{path}/elseArm/body")).await,
                    None => Ok(Flow::FellThrough),
                }
            }
            _ => Err(Stop::Thrown(Failure::unreproduced(
                "this statement",
                "the Rust engine runs bindings, writes, matches, links, unlinks, deletes, blocks, `if`, `sleep` and `return`",
            ))),
        }
    }

    /// `declareAssign`: `name = <right-hand side>`, `return` binding into
    /// the slot the grammar cannot spell. `path` is the statement's.
    async fn assign(&self, name: &str, value: &RValue, scope: &Rc<Scope>, at: &Address, path: &str) -> Result<(), Stop> {
        match value {
            RValue::Write { write } => {
                self.write(write, Some(name), scope, &format!("{path}/value/write")).await?;
            }
            RValue::Match { r#match } => {
                self.match_record(r#match, Some(name), scope).await?;
            }
            RValue::Link { link } => self.link(link, Some(name), scope).await?,
            RValue::Block { block } => {
                self.block(block, Some(name), scope, at, &format!("{path}/value")).await?;
            }
            RValue::Node { node } => {
                let built = self.synthesise_node(node, scope, &format!("{path}/value/node")).await?;
                scope.declare(name, Binding::Node(built));
            }
            RValue::Extract { extract } => {
                let emission = self.extraction(extract, scope).await?;
                scope.declare(name, Binding::Extracted { emission, root: true, id: crate::bindings::Identity::new() });
            }
            RValue::Collection { collection } => {
                self.collection(collection, Some(name), scope, at, &format!("{path}/value/collection/fn")).await?;
            }
            RValue::Members { members } => self.members(members, Some(name), scope)?,
            RValue::Call { call } if let Some(reading) = self.call_reading(call, scope)? => match reading {
                crate::collection::Reading::Collection(op) => {
                    let index = call.args.len() - 1;
                    self.collection(&op, Some(name), scope, at, &format!("{path}/value/call/args/{index}")).await?;
                }
                crate::collection::Reading::Members(members) => self.members(&members, Some(name), scope)?,
            },
            // A plugin's name in a construction's spelling is its call
            // (`constructionAsCall`).
            RValue::Construct { construct } if matches!(scope.resolve(&construct.callee), Some(Binding::Plugin(_))) => {
                let args: Vec<(String, ExprSlot)> = construct.args.iter().map(|a| (a.name.clone(), a.value.clone())).collect();
                let bound = self.plugin_call(&construct.callee, &args, scope).await?;
                scope.declare(name, bound);
            }
            RValue::Call { call } if matches!(scope.resolve(&call.callee), Some(Binding::Plugin(_))) => {
                let bound = self.plugin_call(&call.callee, &plugin_args(call)?, scope).await?;
                scope.declare(name, bound);
            }
            // A movement's name in a construction's spelling is a call too.
            RValue::Construct { construct } if self.calls_movement(&construct.callee, scope) => {
                let call = ast::CallStatement {
                    callee: construct.callee.clone(),
                    args: construct.args.iter().map(|a| ast::CallArg::Expr { name: Some(a.name.clone()), expr: a.value.clone() }).collect(),
                    expression: None,
                    span: construct.span,
                };
                let value = self.call(&call, scope, at, &format!("{path}/value/construct")).await?;
                scope.declare(name, self.call_value(&call.callee, value)?);
            }
            RValue::Call { call } if self.calls_movement(&call.callee, scope) => {
                let value = self.call(call, scope, at, &format!("{path}/value/call")).await?;
                scope.declare(name, self.call_value(&call.callee, value)?);
            }
            // An instance constructed in a body, as at file scope.
            RValue::Construct { construct } => {
                let instance = self.instance_binding(name, construct);
                scope.declare(name, Binding::Instance(Rc::new(instance)));
            }
            // Nothing runs here: every read of the name runs the walk.
            RValue::Lazy { lazy } => {
                let walk = self.defer_walk(&lazy.head, lazy.mapping.as_ref(), scope, &format!("{path}/value/lazy/mapping"));
                scope.declare(name, Binding::LazyWalk(walk));
            }
            RValue::Await { r#await } => match &r#await.source {
                AwaitSource::Sleep { duration, .. } => {
                    self.sleep(duration, at, scope, Some(name)).await?;
                    scope.declare(name, Binding::Value(env::ValueBinding { value: Js::Bool(true), trail: Some(Trail::default()), many: false }));
                }
                _ => return Err(Stop::Thrown(Failure::unreproduced("this await", "the Rust engine runs `await sleep(…)`"))),
            },
            _ => {
                let slot = self.value_slot(value, scope)?;
                let bound = self.bind_slot_binding(slot, scope).await?;
                scope.declare(name, bound);
            }
        }
        Ok(())
    }

    /// `readCallIn`'s reading of a call of a collection op or `MEMBERS` (a
    /// built-in from version 3, when the program binds no such name).
    fn call_reading(&self, call: &ast::CallStatement, scope: &Scope) -> Result<Option<crate::collection::Reading>, Stop> {
        let binds = scope.resolve(&call.callee).is_some() || scope.resolve_function(&call.callee).is_some();
        crate::collection::reading(call, binds, self.version())
            .map_err(|refusal| Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("{refusal} — the checker should have caught this"))))
    }

    /// An `if` arm, in a scope of its own; a `return` in it returns from the
    /// body the `if` is in, its value landing in that body's scope too.
    async fn arm(&self, body: &[Statement], scope: &Rc<Scope>, at: &Address, path: &str) -> Result<Flow, Stop> {
        let inner = scope.child();
        let flow = self.body(body, &inner, at, path, 0).await?;
        if let Flow::Returned = flow
            && let Some(value) = inner.resolve_own(RETURN_SLOT)
        {
            scope.declare(RETURN_SLOT, value);
        }
        Ok(flow)
    }

    /// The expression a right-hand side reads as: itself, or a bound call
    /// to a built-in (`n = UPPER(x)`, from version 3), which is the
    /// expression it is (`resolvedRValue`). The shim admits no other call.
    fn value_slot<'v>(&self, value: &'v RValue, scope: &Scope) -> Result<&'v ExprSlot, Stop> {
        match value {
            RValue::Expr { expr } => Ok(expr),
            RValue::Call { call } if self.version() >= 3 && scope.resolve(&call.callee).is_none() => call
                .expression
                .as_ref()
                .ok_or_else(|| Stop::Thrown(Failure::unreproduced(&format!("the call '{}'", call.callee), "a built-in's call reads as its expression"))),
            _ => Err(Stop::Thrown(Failure::unreproduced("this right-hand side", "the Rust engine runs `name = <expression>`"))),
        }
    }

    /// `bindSlotValue`: a bare name of a record (the event, a handle, a
    /// landing, a node, an extraction's) is a second name for it
    /// (`aliasedNodeBinding`); `FIRST`/`LAST`/`ONLY` of a bare walk is the
    /// record it picks (`selectedPositionBinding`); anything else, the value
    /// it evaluates to.
    pub(crate) async fn bind_slot_binding(&self, slot: &ExprSlot, scope: &Rc<Scope>) -> Result<Binding, Stop> {
        let expr = lowered(slot, |tree| movement_parser::lowering::lower_expression(tree, &slot.raw), "expression")
            .map_err(Stop::Thrown)?;
        if let Expression::Property { property_type_id: name } | Expression::AliasRef { name } = &expr
            && let Some(binding) = scope.resolve(name)
            && self.aliases(&binding)
        {
            return Ok(binding);
        }
        if let Some(selected) = self.selected_record(&expr, slot, scope).await.map_err(Stop::Thrown)? {
            return Ok(selected);
        }
        let bound = self.bind_evaluated(&expr, slot, scope).await?;
        Ok(crate::record::bind_value(bound.value, bound.trail, bound.many))
    }

    /// `aliasedNodeBinding`'s kinds: a bare name of one is a second name for
    /// the binding itself (a shape's from version 3); of any other, the
    /// value it reads as.
    fn aliases(&self, binding: &Binding) -> bool {
        match binding {
            Binding::Event | Binding::Handle(_) | Binding::Extracted { .. } | Binding::Landed(_) | Binding::Node(_) | Binding::LazyWalk(_) | Binding::Positions(_) => true,
            Binding::Shape(_) => self.version() >= 3,
            Binding::Value(_) | Binding::Instance(_) | Binding::Movement(_) | Binding::Plugin(_) | Binding::Opaque => false,
            // The switch's cases by kind; a kind it has none for falls out of
            // it, aliasing nothing.
            Binding::Shaped(_) => matches!(
                crate::record::kind_of(binding).as_str(),
                "event" | "handle" | "extractRoot" | "extractPosition" | "sourcePosition" | "resource" | "blockMeta" | "shapePosition" | "nodePosition"
                    | "lazyWalk" | "callback" | "positions" | "closure" | "tuple"
            ) || (crate::record::kind_of(binding) == "shape" && self.version() >= 3),
        }
    }

    /// `bindSlotValue` for what this engine binds: the value the slot
    /// evaluates to, with its trail.
    async fn bind_slot(&self, slot: &ExprSlot, scope: &Rc<Scope>) -> Result<ValueBinding, Stop> {
        let expr = lowered(slot, |tree| movement_parser::lowering::lower_expression(tree, &slot.raw), "expression")
            .map_err(Stop::Thrown)?;
        self.bind_evaluated(&expr, slot, scope).await
    }

    async fn bind_evaluated(&self, expr: &Expression, slot: &ExprSlot, scope: &Rc<Scope>) -> Result<ValueBinding, Stop> {
        let evaluated = self.evaluate(expr, scope, slot).await?;
        // `binding.provenance ?? NO_PROVENANCE`: a bound value always has a trail.
        let trail = match evaluated.prov {
            Prov::Binding(name) => Some(scope.value_of(&name).and_then(|b| b.trail).unwrap_or_default()),
            Prov::Built(trail) => Some(trail),
        };
        Ok(ValueBinding { value: evaluated.value, trail, many: binds_many_values(expr, scope) })
    }

    /// `selectedPositionBinding`: `FIRST`/`LAST`/`ONLY` of a bare walk of one
    /// hop, walked as a block head walks it; the record picked, or a null
    /// value when there is none.
    async fn selected_record(&self, expr: &Expression, slot: &ExprSlot, scope: &Rc<Scope>) -> Result<Option<Binding>, Failure> {
        let Expression::Aggregate { fn_: pick @ (AggregationFunction::First | AggregationFunction::Last | AggregationFunction::Only), expression, .. } = expr else {
            return Ok(None);
        };
        if !crate::eval::is_records_walk(expression) {
            return Ok(None);
        }
        let Expression::Traverse { alias_root: Some(root), steps, .. } = expression.as_ref() else { return Ok(None) };
        // A root `graphReadFor` resolves no graph for (a node the run built,
        // a value): the fold of the walk, evaluated.
        let graph = match scope.resolve(root) {
            Some(Binding::Event | Binding::Landed(_) | Binding::Instance(_)) => true,
            // A handle that bound no record has no graph to read.
            Some(Binding::Handle(handle)) => !matches!(handle.record.get("externalId"), Js::Undefined),
            _ => false,
        };
        if !graph {
            return Ok(None);
        }
        let [TraversalStep::Edge(step)] = steps.as_slice() else {
            unreachable!("admission picks only from a walk of one hop")
        };
        let landings = self.selection_landings(root, step, scope, slot).await?;
        if *pick == AggregationFunction::Only && landings.len() > 1 {
            return Err(Failure::engine(
                "MOVENG_RUNTIME",
                format!("ONLY({}) says there is exactly one, and there are {}. Narrow it until there is.", js::trim(&slot.raw), landings.len()),
            ));
        }
        let picked = if *pick == AggregationFunction::Last { landings.last() } else { landings.first() };
        Ok(Some(match picked {
            // What a selection binds carries the record and its graph, not
            // the walked edge's properties.
            Some(landed) => Binding::Landed(Rc::new(crate::bindings::Landed::new(landed.position.clone(), None, landed.read.clone()))),
            None => Binding::Value(ValueBinding { value: Js::Null, trail: Some(Trail::default()), many: false }),
        }))
    }

    /// `evaluateCondition`: the condition's conjuncts, each an expression's
    /// truthiness.
    async fn condition(&self, slot: &ExprSlot, scope: &Rc<Scope>) -> Result<bool, Stop> {
        let condition = lowered(slot, |tree| movement_parser::lowering::lower_condition(tree, &slot.raw), "condition")
            .map_err(Stop::Thrown)?;
        self.parsed_condition(&condition, scope, slot).await
    }

    fn parsed_condition<'s>(
        &'s self,
        condition: &'s MovementCondition,
        scope: &'s Rc<Scope>,
        slot: &'s ExprSlot,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool, Stop>> + 's>> {
        Box::pin(async move {
            match condition {
                MovementCondition::And { conjuncts } => {
                    for conjunct in conjuncts {
                        if !self.parsed_condition(conjunct, scope, slot).await? {
                            return Ok(false);
                        }
                    }
                    Ok(true)
                }
                MovementCondition::Expr { expr } => Ok(self.evaluate(expr, scope, slot).await?.value.truthy()),
                MovementCondition::IsTest { subject_raw, type_ } => self.is_test(subject_raw, type_, scope).map_err(Stop::Thrown),
            }
        })
    }

    /// One expression, evaluated as one walk: each read it makes of the host
    /// is awaited where it is made, and the walk resumes there.
    pub(crate) async fn evaluate(&self, expr: &Expression, scope: &Rc<Scope>, slot: &ExprSlot) -> Result<Evaluated, Stop> {
        // Each literal the evaluation reads is an origin in the program text:
        // the slot's span.
        let span = env::js_of_json(&serde_json::to_value(slot.span).expect("a span is JSON"));
        self.evaluate_in(expr, scope, Some(span), None).await
    }

    /// One walk, its literals' origins at `span`; scoped at `landed` (a
    /// hop's WHERE or ORDER BY key) when given.
    pub(crate) async fn evaluate_in(
        &self,
        expr: &Expression,
        scope: &Rc<Scope>,
        span: Option<Js>,
        landed: Option<Rc<crate::bindings::Landed>>,
    ) -> Result<Evaluated, Stop> {
        self.evaluate_scoped(expr, scope, span, landed.map(Scoped::Landed)).await
    }

    /// One walk, scoped at `subject` when given: a landed record, or an
    /// extracted entity (an `EXISTS` WHERE over an extraction's).
    pub(crate) async fn evaluate_scoped(&self, expr: &Expression, scope: &Rc<Scope>, span: Option<Js>, subject: Option<Scoped>) -> Result<Evaluated, Stop> {
        let around = Surroundings { services: env_services::current(), now: Some(self.now_ms) };
        let scoped = subject.is_some();
        let reader = Reading { run: self, scope, span: span.clone(), subject };
        let evaluator = if scoped {
            Evaluator::scoped_in_run(scope.as_ref(), self.version(), around, &reader)
        } else {
            Evaluator::in_run(scope.as_ref(), self.version(), around, &reader)
        };
        evaluator.eval(expr).await.map_err(|error| {
            Stop::Thrown(Failure::of_eval(error, "the Rust engine does not reproduce it; run this movement on the TypeScript engine"))
        })
    }

    /// What an evaluation asked, answered by the host.
    async fn answer(&self, ask: Ask, scope: &Rc<Scope>, subject: Option<&Scoped>, span: Option<&Js>) -> Result<Result<Evaluated, EvalError>, Failure> {
        match ask {
            Ask::EventField { field } => self.event_field(&field).await.map(Ok),
            Ask::Bare { name, member } => match scope.resolve(&name) {
                Some(binding) => self.bare(&name, binding, member).map(Ok),
                None => Err(Failure::engine("MOVENG_RUNTIME", format!("'{name}' is not in scope — the checker should have caught this"))),
            },
            Ask::ScopedField { field, edge } => match subject.expect("a scoped read is asked only of a scoped evaluation") {
                Scoped::Landed(landed) => self.scoped_field(landed, &field, edge, scope).await.map(Ok),
                // `scopeOf` a dict shaped like a traversed record: the
                // position scope its own keys make, read as any position's.
                Scoped::Binding(Binding::Shaped(dict)) if crate::record::kind_of(&Binding::Shaped(dict.clone())) == "sourcePosition" => {
                    let this = Js::Object(dict.clone());
                    let (position, read) = self.shaped_source_record(&this)?;
                    let properties = crate::record::get(&this, "edgeProperties").map_err(|e| Failure::of_eval(e, ""))?;
                    match read {
                        crate::shaped::GraphRead::Live(read) => {
                            let inline = !properties.is_nullish() && !matches!(crate::record::get(&properties, &field), Ok(Js::Undefined) | Err(_));
                            if !(edge && inline) {
                                crate::shaped::wrapper_reads(&position, read.start_surface_type.as_deref()).map_err(|e| Failure::of_eval(e, ""))?;
                            }
                            let landed = Rc::new(crate::bindings::Landed::new(position, (!properties.is_nullish()).then_some(properties), read));
                            self.scoped_field(&landed, &field, edge, scope).await.map(Ok)
                        }
                        crate::shaped::GraphRead::Foreign(read) => Ok(Err(crate::shaped::foreign_call(&read, "seam", "getFieldValue"))),
                    }
                }
                Scoped::Emission(_) if edge => Ok(Err(EvalError::engine(
                    "MOVENG_UNSUPPORTED",
                    "edge-property reads outside a traversal WHERE is not supported by the movement engine yet (edge properties exist only on a walked hop)".into(),
                ))),
                Scoped::Emission(emission) => Ok(crate::write::emission_field(emission, &field)),
                Scoped::Binding(_) if edge => Ok(Err(EvalError::engine(
                    "MOVENG_UNSUPPORTED",
                    "edge-property reads outside a traversal WHERE is not supported by the movement engine yet (edge properties exist only on a walked hop)".into(),
                ))),
                Scoped::Binding(binding) => self.read_binding_field(binding, &field, "the scoped position").map(Ok),
            },
            Ask::Traverse { expr } => {
                let span = span.cloned().unwrap_or(Js::Undefined);
                let Expression::Traverse { alias_root: Some(root), .. } = &expr else { unreachable!("the evaluator asks for rooted traversals only") };
                let binding = scope
                    .resolve(root)
                    .ok_or_else(|| Failure::engine("MOVENG_RUNTIME", format!("'{root}' is not in scope — the checker should have caught this")))?;
                self.read_from(&expr, root, binding, scope, &span).await.map(Ok)
            }
            Ask::From { name, held, expr } => {
                let span = span.cloned().unwrap_or(Js::Undefined);
                self.read_from(&expr, &name, held, scope, &span).await.map(Ok)
            }
            Ask::ScopedAt { expr, subject } => self.scoped_at_record(&expr, &subject, scope, span.cloned()).await.map(Ok),
            Ask::Function { id, args } => {
                let args = args.iter().map(|arg| self.encode(arg)).collect::<Result<_, _>>()?;
                let request = host::builtins::function(&id, args, &js_date::to_iso_string(self.now_ms), self.version());
                self.builtin(request).await
            }
            Ask::Compare { op, left, right } => {
                let request = self.compare_request(op, &left, &right).await?;
                self.builtin(request).await
            }
        }
    }

    /// `{value: wire}` or `{threw: {class, code?, message}}`: the TypeScript
    /// member's answer, its value or the error it throws.
    async fn builtin(&self, request: host::Request) -> Result<Result<Evaluated, EvalError>, Failure> {
        let answer = self.ask(request).await?.unwrap_or(Json::Null);
        if let Some(threw) = answer.get("threw") {
            let message = threw.get("message").and_then(Json::as_str).unwrap_or_default().to_string();
            let class = match (threw.get("class").and_then(Json::as_str), threw.get("code").and_then(Json::as_str)) {
                (Some("MovementEngineError"), Some("MOVENG_RUNTIME")) => ErrorClass::Engine("MOVENG_RUNTIME"),
                (Some("MovementEngineError"), Some("MOVENG_UNSUPPORTED")) => ErrorClass::Engine("MOVENG_UNSUPPORTED"),
                (Some("RangeError"), _) => ErrorClass::RangeError,
                (Some("TypeError"), _) => ErrorClass::TypeError,
                (Some("Error"), _) => ErrorClass::Error,
                _ => return Err(Failure::engine("MOVENG_RUNTIME", format!("a built-in threw what this engine cannot rethrow: {threw}"))),
            };
            return Ok(Err(EvalError::Thrown { class, message }));
        }
        let value = answer.get("value").ok_or_else(|| Failure::engine("MOVENG_RUNTIME", format!("a built-in answered {answer}")))?;
        let value = self.wire.decode(value).map_err(|e| Failure::engine("MOVENG_RUNTIME", e))?;
        Ok(Ok(Evaluated { value, prov: Prov::Built(Trail::default()) }))
    }

    /// `readSourcePositionField` on the event: the source adapter's
    /// `getFieldValue` through the surface-read wrapper, a `field_miss`
    /// traced for a field a raw payload does not carry, and the read's
    /// `source_field` origin.
    async fn event_field(&self, field: &str) -> Result<Evaluated, Failure> {
        let source = self.source.borrow().clone().expect("the event is seeded before the body runs");
        let seed = &source.position;
        let value = self.call_adapter_at(&source.instance, "getFieldValue", &source.surface, vec![("fieldId", Js::str(field))]).await?;
        if value.is_nullish() && !seed.is_stable() {
            self.trace_miss_in(&source.instance_name, &seed.data, field);
        }
        // In the TypeScript's key order (`readSourcePositionField`).
        let mut entries = vec![
            ("kind", Js::str("source_field")),
            ("instance", Js::str(source.instance_name.clone())),
            ("adapterType", Js::str(source.adapter_type.clone())),
        ];
        if seed.is_stable() {
            if let Some(record_type) = &seed.record_type {
                entries.push(("recordType", Js::str(record_type.clone())));
            }
            entries.push(("externalId", seed.record_id.clone().map_or(Js::Null, Js::String)));
        }
        entries.push(("field", Js::str(field)));
        let origin = env::object_of(entries);
        let id = self.mint_origin(origin);
        Ok(Evaluated { value, prov: Prov::Built(Trail { origins: vec![id], direct: Some(id) }) })
    }

    /// One more origin in the run's table; its id.
    pub(crate) fn mint_origin(&self, origin: Js) -> u32 {
        let mut origins = self.origins.borrow_mut();
        origins.push(origin);
        origins.len() as u32 - 1
    }

    /// The id of an origin the run holds as this very object, minted the
    /// first time: one origin reached twice is one origin, as the
    /// TypeScript's are.
    pub(crate) fn intern_origin(&self, origin: Js) -> u32 {
        let known = self.origins.borrow().iter().position(|o| match (o, &origin) {
            (Js::Object(a), Js::Object(b)) => Rc::ptr_eq(a, b),
            _ => false,
        });
        match known {
            Some(id) => id as u32,
            None => self.mint_origin(origin),
        }
    }

    /// The origin `id` names, as the TypeScript's object.
    pub(crate) fn origin(&self, id: u32) -> Js {
        self.origins.borrow().get(id as usize).cloned().unwrap_or(Js::Null)
    }

    /// An origin as the firing record carries it (`ProvenanceSummariser`):
    /// an extraction's site interned into the result's `extractionSites`.
    pub(crate) fn summarised_origin(&self, id: u32) -> Js {
        self.summarised(&self.origin(id))
    }

    /// `summariseOrigin`: an extraction's site by its id, its details (and
    /// its data sources, summarised) kept once in `extractionSites`, the
    /// first site of an id the one kept.
    pub(crate) fn summarised(&self, origin: &Js) -> Js {
        let get = |key: &str| crate::unique::get(origin, key);
        if !matches!(get("kind"), Js::String(kind) if kind == "extraction") {
            return summarise(origin);
        }
        let site = get("site");
        let site_id = crate::unique::get(&site, "siteId").to_js_string();
        let known = self.extraction_sites.borrow().iter().any(|(id, _)| *id == site_id);
        if !known {
            // The slot is reserved before the data sources are summarised.
            self.extraction_sites.borrow_mut().push((site_id.clone(), Js::Null));
            let sources: Vec<Js> = match crate::unique::get(&site, "dataSources") {
                Js::Array(list) => list.items().iter().map(|o| self.summarised(o)).collect(),
                _ => Vec::new(),
            };
            let summary = env::object_of(vec![
                ("node", crate::unique::get(&site, "node")),
                ("description", crate::unique::get(&site, "description")),
                ("stage", crate::unique::get(&site, "stage")),
                ("dataSources", Js::array(sources)),
            ]);
            if let Some(slot) = self.extraction_sites.borrow_mut().iter_mut().find(|(id, _)| *id == site_id) {
                slot.1 = summary;
            }
        }
        let mut entries = vec![("kind", Js::str("extraction")), ("site", Js::str(site_id))];
        for key in ["field", "description", "quote", "item"] {
            if !matches!(get(key), Js::Undefined) {
                entries.push((key, get(key)));
            }
        }
        env::object_of(entries)
    }

    /// `interpretSleep`: a rehearsal fast-forwards; a real run parks the flow
    /// on a timer, its scope chain serialized, and stops here.
    async fn sleep(&self, duration: &ast::DurationLiteral, at: &Address, scope: &Rc<Scope>, presence: Option<&str>) -> Result<(), Stop> {
        if self.input.dry_run {
            return Ok(());
        }
        let address = at.encode();
        if !self.serves("park.sink.commitTimerPark") {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("sleep reached at '{address}' with no park sink — the run cannot suspend on a timer without the durable trigger-run substrate"),
            )));
        }
        let state = crate::park::parked_state(self, &address, presence, scope).map_err(Stop::Thrown)?;
        // When to wake: the host's clock plus the sleep, its clock asked
        // before the duration is read, as the TypeScript engine asks it.
        let now = self.clock_now().await.map_err(Stop::Thrown)?;
        let ms = crate::park::duration_ms(&duration.raw).ok_or_else(|| {
            Stop::Thrown(Failure::Engine {
                class: ErrorClass::Error,
                message: format!("invalid duration literal '{}' — use unit-suffixed literals like 4h, 2d, 90m, 1h30m", duration.raw),
            })
        })?;
        let wake_at = js_date::to_iso_string(now + ms);
        let request = host::park::commit_timer_park(self.segment(), &address, self.encode(&state).map_err(Stop::Thrown)?, &wake_at);
        self.ask(request).await.map_err(Stop::Thrown)?;
        self.trace(TraceEntry::Gate { outcome: false });
        Err(Stop::Parked(address))
    }

    /// A `field_miss` for `field` read null off a raw payload `data` that
    /// does not carry it, once per instance and field.
    pub(crate) fn trace_miss_in(&self, instance_name: &str, data: &Js, field: &str) {
        let keys: Vec<String> = match data {
            Js::Object(object) => object.entries().iter().map(|(k, _)| k.clone()).collect(),
            Js::Array(list) => (0..list.items().len()).map(|i| i.to_string()).collect(),
            _ => return,
        };
        // `field in data`: own keys, and the prototype's.
        let carried = keys.iter().any(|k| k == field)
            || crate::js::is_object_prototype_name(field)
            || (matches!(data, Js::Array(_)) && (field == "length" || ARRAY_PROTOTYPE_NAMES.contains(&field)));
        let seen = self.misses.borrow().iter().any(|(b, f)| b == instance_name && f == field);
        if carried || seen {
            return;
        }
        self.misses.borrow_mut().push((instance_name.to_string(), field.to_string()));
        let available = keys.into_iter().take(30).collect();
        self.trace(TraceEntry::FieldMiss { binding: instance_name.to_string(), field: field.to_string(), available });
    }

    // ── Host calls ──

    /// An entry on the run's trace, handed to the host when its statement ends.
    pub(crate) fn trace(&self, entry: TraceEntry) {
        self.trace.push(entry);
    }

    /// The run's flow's buffered entries, in one `trace.append`; nothing
    /// asked when there are none.
    async fn publish_trace(&self) -> Result<(), Failure> {
        self.hand_over_trace(false).await
    }

    /// `closing`: the hand-over as the segment ends, whose failure is the
    /// shim's to log and never the run's.
    async fn hand_over_trace(&self, closing: bool) -> Result<(), Failure> {
        let lines = std::mem::take(&mut *self.log_lines.borrow_mut());
        if !lines.is_empty() {
            // A line the shim could not write is not the run's failure.
            let _ = self.ask(host::log::write(lines)).await;
        }
        let entries = self.trace.take();
        if entries.is_empty() {
            return Ok(());
        }
        self.ask(host::trace::append(self.segment(), &entries, closing)).await.map(|_| ())
    }

    /// A line on the platform's log where the TypeScript engine writes one,
    /// kept until the statement's trace is handed over.
    pub(crate) fn log(&self, level: &str, message: &str, fields: serde_json::Map<String, Json>) {
        self.log_lines.borrow_mut().push(json!({ "level": level, "message": message, "fields": fields }));
    }

    pub(crate) async fn ask(&self, request: host::Request) -> Result<Option<Json>, Failure> {
        if !request.is_read() {
            self.effected.set(true);
        }
        self.host.request(request).await.map_err(Failure::Host)
    }

    /// `value` for a host request. Admission keeps a record from every
    /// request's values; one that got past fails the run before the request.
    pub(crate) fn encode(&self, value: &Js) -> Result<Json, Failure> {
        self.wire.encode(value).map_err(|crate::env::HeldRecord(kind)| {
            Failure::unreproduced(
                &format!("handing a record held as a value ({}) to the host", crate::record::describe_kind(&kind)),
                "a record reaches a host call only read down to its fields",
            )
        })
    }

    async fn ask_bool(&self, request: host::Request) -> Result<bool, Failure> {
        Ok(self.ask(request).await?.is_some_and(|v| v.as_bool() == Some(true)))
    }
}

/// `bindsManyValues`: a walk read for a field, or a second name for one.
fn binds_many_values(expr: &Expression, scope: &Scope) -> bool {
    match expr {
        Expression::Traverse { steps, expression, .. } if !steps.is_empty() => match expression.as_ref() {
            Expression::Property { property_type_id } => property_type_id != movement_parser::lowering::POSITION_SENTINEL,
            Expression::EdgeProperty { .. } => true,
            _ => false,
        },
        Expression::Property { property_type_id: name } | Expression::AliasRef { name } => scope.value_of(name).is_some_and(|b| b.many),
        _ => false,
    }
}

/// A plugin call's named arguments; admission lets by no other kind.
fn plugin_args(call: &ast::CallStatement) -> Result<Vec<(String, ExprSlot)>, Stop> {
    call.args
        .iter()
        .map(|arg| match arg {
            ast::CallArg::Expr { name: Some(name), expr } => Ok((name.clone(), expr.clone())),
            _ => Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("'{}' is a plugin, and a plugin's arguments are named values — the checker should have caught this", call.callee),
            ))),
        })
        .collect()
}

/// `Array.prototype`'s own names, which `in` finds on any list.
const ARRAY_PROTOTYPE_NAMES: [&str; 38] = [
    "at", "concat", "copyWithin", "entries", "every", "fill", "filter", "find", "findIndex", "findLast", "findLastIndex",
    "flat", "flatMap", "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf", "map", "pop", "push", "reduce",
    "reduceRight", "reverse", "shift", "slice", "some", "sort", "splice", "toLocaleString", "toReversed", "toSorted",
    "toSpliced", "unshift", "values", "with", "toString",
];

/// One evaluation's reads, answered by its run in the scope it reads.
struct Reading<'r, 'h> {
    run: &'r Run<'h>,
    scope: &'r Rc<Scope>,
    /// Where the evaluation's literals are written (`literalSpan`).
    span: Option<Js>,
    /// What a position-scoped evaluation reads.
    subject: Option<Scoped>,
}

/// What a position-scoped evaluation's bare names read (`PositionScope`).
#[derive(Clone)]
pub(crate) enum Scoped {
    Landed(Rc<crate::bindings::Landed>),
    Emission(Rc<crate::extract::emission::Emission>),
    /// Any other record a run-built node's edge holds (`{kind: 'binding'}`):
    /// a node, a handle.
    Binding(Binding),
}

impl Reader for Reading<'_, '_> {
    fn ask(&self, ask: Ask) -> Evaluating<'_> {
        Box::pin(async move { self.run.answer(ask, self.scope, self.subject.as_ref(), self.span.as_ref()).await.map_err(Failure::into_eval)? })
    }

    fn literal(&self) -> u32 {
        let mut origin = vec![("kind", Js::str("literal"))];
        if let Some(span) = &self.span {
            origin.push(("span", span.clone()));
        }
        self.run.mint_origin(env::object_of(origin))
    }

    fn meta(&self, key: &str) -> u32 {
        self.run.mint_origin(env::object_of(vec![("kind", Js::str("meta")), ("key", Js::str(key))]))
    }
}

impl Scope {
    fn value_of(&self, name: &str) -> Option<ValueBinding> {
        crate::eval::Names::value(self, name)
    }
}

/// A slot parsed and lowered (`expressionOfSlot` / `conditionOfSlot`); a
/// refusal is the checker's miss.
pub(crate) fn lowered<T, E: std::fmt::Debug>(
    slot: &ExprSlot,
    lower: impl FnOnce(&movement_parser::tree::MExpr) -> Result<T, E>,
    what: &str,
) -> Result<T, Failure> {
    let invalid = |message: String| {
        Failure::engine("MOVENG_RUNTIME", format!("invalid {what} (the checker should have caught this): {message}"))
    };
    let tree = movement_parser::expr::parse_expression(&slot.raw).map_err(|e| invalid(format!("{e:?}")))?;
    lower(&tree).map_err(|e| invalid(format!("{e:?}")))
}

/// The name a slot reads bare, as the lowering spells it (`bareName`): a
/// backticked name included.
fn bare_name(slot: &ExprSlot) -> Option<String> {
    let tree = movement_parser::expr::parse_expression(&slot.raw).ok()?;
    match movement_parser::lowering::lower_expression(&tree, &slot.raw).ok()? {
        Expression::Property { property_type_id: name } | Expression::AliasRef { name } => Some(name),
        _ => None,
    }
}

/// `param` and every name a body binds to it again (`x = param`, `y = x`),
/// at any depth.
fn event_names(body: &[Statement], param: &str) -> Vec<String> {
    fn collect(statements: &[Statement], names: &mut Vec<String>) -> bool {
        let mut grew = false;
        for statement in statements {
            match statement {
                Statement::Assign(assign) => {
                    if let RValue::Expr { expr } = &assign.value
                        && bare_name(expr).is_some_and(|name| names.contains(&name))
                        && !names.contains(&assign.name)
                    {
                        names.push(assign.name.clone());
                        grew = true;
                    }
                    if let RValue::Block { block } = &assign.value {
                        grew |= collect(&block.body, names);
                    }
                }
                Statement::If(statement) => {
                    for arm in &statement.arms {
                        grew |= collect(&arm.body, names);
                    }
                    if let Some(arm) = &statement.else_arm {
                        grew |= collect(&arm.body, names);
                    }
                }
                Statement::Block(statement) => grew |= collect(&statement.block.body, names),
                _ => {}
            }
        }
        grew
    }
    let mut names = vec![param.to_string()];
    while collect(body, &mut names) {}
    names
}

/// Every field `param.field` an expression in `body_json` (a body's AST as
/// JSON) reads with no hops.
pub fn event_fields_read(body_json: &str, param: &str, found: &mut dyn FnMut(&str)) {
    let Ok(tree) = serde_json::from_str::<Json>(body_json) else { return };
    let mut raws = Vec::new();
    collect_raws(&tree, &mut raws);
    for raw in raws {
        let Ok(parsed) = movement_parser::expr::parse_expression(&raw) else { continue };
        let lowered = movement_parser::lowering::lower_expression(&parsed, &raw)
            .ok()
            .and_then(|e| serde_json::to_value(e).ok())
            .or_else(|| movement_parser::lowering::lower_condition(&parsed, &raw).ok().and_then(|c| serde_json::to_value(c).ok()));
        if let Some(expr) = lowered {
            reads_of(&expr, param, found);
        }
    }
}

fn collect_raws(tree: &Json, into: &mut Vec<String>) {
    match tree {
        Json::Object(map) => {
            if let (Some(Json::String(raw)), Some(_)) = (map.get("raw"), map.get("span")) {
                into.push(raw.clone());
            }
            map.values().for_each(|v| collect_raws(v, into));
        }
        Json::Array(items) => items.iter().for_each(|v| collect_raws(v, into)),
        _ => {}
    }
}

fn reads_of(expr: &Json, param: &str, found: &mut dyn FnMut(&str)) {
    match expr {
        Json::Object(map) => {
            if map.get("type").and_then(Json::as_str) == Some("traverse")
                && map.get("aliasRoot").and_then(Json::as_str) == Some(param)
                && let Some(field) = map.get("expression").filter(|e| e.get("type").and_then(Json::as_str) == Some("property")).and_then(|e| e.get("propertyTypeId")).and_then(Json::as_str)
            {
                found(field);
            }
            map.values().for_each(|v| reads_of(v, param, found));
        }
        Json::Array(items) => items.iter().for_each(|v| reads_of(v, param, found)),
        _ => {}
    }
}

/// The interpreter's `mutationContext`: where the run's writes came from.
fn mutation_context(event: &Js, now_ms: f64) -> Js {
    let mut source = JsObject::new();
    source.set("type".into(), Js::str("structured_input"));
    source.set("adapterType".into(), event_get(event, "adapterType"));
    source.set("pipelineInputId".into(), event_get(event, "pipelineInputId"));
    let mut context = JsObject::new();
    context.set("source".into(), Js::object(source));
    let occurred = match event_get(event, "occurredAt") {
        Js::Undefined | Js::Null => Js::str(js_date::to_iso_string(now_ms)),
        other => other,
    };
    context.set("occurredAt".into(), occurred);
    Js::object(context)
}

/// `ProvenanceSummariser.summariseOrigin` for the origins this engine meets:
/// an earlier write by its index, `AI()` by its prompt, the rest as they are.
pub(crate) fn summarise(origin: &Js) -> Js {
    let get = |key: &str| crate::unique::get(origin, key);
    match get("kind") {
        Js::String(kind) if kind == "write" => {
            let mut entries = vec![("kind", Js::str("write")), ("write", get("writeIndex"))];
            for key in ["externalId", "field"] {
                if !matches!(get(key), Js::Undefined) {
                    entries.push((key, get(key)));
                }
            }
            env::object_of(entries)
        }
        Js::String(kind) if kind == "ai" => env::object_of(vec![("kind", Js::str("ai")), ("prompt", get("prompt"))]),
        _ => match origin {
            Js::Object(object) => Js::object(JsObject::clone_of(object)),
            other => other.clone(),
        },
    }
}

/// A field type a value of which an adapter may answer as a `Date`. A
/// record is dated when the position it names has a dated property; one this
/// engine cannot name is taken as possibly dated.
fn is_dated(field: &FieldType, schema: &InstanceSchema, seen: &mut Vec<String>) -> bool {
    match field {
        FieldType::Scalar(scalar) => matches!(scalar, movement_parser::catalog::types::Scalar::Date | movement_parser::catalog::types::Scalar::Datetime),
        FieldType::Composite(Composite::List { of, .. } | Composite::MaybeAbsent { of } | Composite::Dict { of, .. }) => is_dated(of, schema, seen),
        FieldType::Composite(Composite::Union { of }) => of.iter().any(|t| is_dated(t, schema, seen)),
        FieldType::Composite(Composite::Tuple { of, .. }) => of.iter().flatten().any(|t| is_dated(t, schema, seen)),
        FieldType::Composite(Composite::Record { position }) => {
            let name = position.as_ref().and_then(|p| p.as_str().or_else(|| p.get("position").and_then(Json::as_str)));
            let Some(name) = name else { return true };
            if seen.iter().any(|s| s == name) {
                return false;
            }
            seen.push(name.to_string());
            match schema.positions.0.get(name) {
                Some(position) => position.properties.0.values().any(|t| is_dated(t, schema, seen)),
                None => true,
            }
        }
        FieldType::Composite(Composite::Enum { .. }) => false,
    }
}

// ── The event seed (run.ts) ─────────────────────────────────────────────────

fn event_text(event: &Js, key: &str) -> Option<String> {
    match event_get(event, key) {
        Js::String(text) => Some(text),
        _ => None,
    }
}

fn event_get(value: &Js, key: &str) -> Js {
    match value {
        Js::Object(object) => object.get(key).cloned().unwrap_or(Js::Undefined),
        _ => Js::Undefined,
    }
}

/// `soleEventPosition`: the one event node an adapter publishes, if one.
fn sole_event_position(schema: Option<&InstanceSchema>) -> Option<String> {
    match schema?.event_positions.as_deref()? {
        [only] => Some(only.position.clone()),
        _ => None,
    }
}

/// An event's canonical narrowed address (`EventAddress`).
#[derive(Debug, Clone, PartialEq)]
pub struct EventAddress {
    pub event: String,
    /// Insertion order, as the TypeScript fills it.
    pub narrowing: Vec<(String, String)>,
}

/// `eventSeedAddress`.
fn event_seed_address(schema: Option<&InstanceSchema>, event: &Js, root_type_name: Option<&str>) -> Option<EventAddress> {
    let schema = schema?;
    let nodes = schema.event_positions.as_deref().filter(|n| !n.is_empty())?;
    if !matches!(event_text(event, "triggerType").as_deref(), Some("webhook" | "poll")) {
        return None;
    }
    let node = nodes
        .iter()
        .find(|n| Some(n.position.as_str()) == root_type_name)
        .or_else(|| (nodes.len() == 1).then(|| &nodes[0]))?
        .position
        .clone();
    let payload = event_get(event, "payload");
    let pinned = |key: &str| match event_get(&payload, key) {
        Js::String(value) if !value.is_empty() => Some(value),
        _ => None,
    };
    let mut narrowing = Vec::new();
    for key in schema.event_narrowing_keys.iter().flatten() {
        if let Some(value) = pinned(key) {
            narrowing.push((key.clone(), value));
        }
    }
    let action_type = schema.positions.0.get(&node).and_then(|p| p.properties.0.get("action"));
    if matches!(action_type, Some(FieldType::Composite(Composite::Enum { .. })))
        && let Some(value) = pinned("action")
    {
        if let Some(slot) = narrowing.iter_mut().find(|(k, _)| k == "action") {
            slot.1 = value;
        } else {
            narrowing.push(("action".into(), value));
        }
    }
    Some(EventAddress { event: node, narrowing })
}

/// `eventAddressKey`: the bare event name, or `JSON.stringify([event,
/// pins])` with the pins sorted by key.
pub fn event_address_key(address: &EventAddress) -> String {
    let mut pins = address.narrowing.clone();
    if pins.is_empty() {
        return address.event.clone();
    }
    pins.sort_by(|(a, _), (b, _)| js::utf16_cmp(a, b));
    serde_json::to_string(&json!([address.event, pins])).expect("strings are JSON")
}

/// `seedEventPosition`.
fn seed_event_position(
    event: &Js,
    source_adapter_slug: &str,
    surface_type: Option<String>,
    event_address: Option<&EventAddress>,
) -> Result<Position, Failure> {
    let adapter_type = event_text(event, "adapterType").unwrap_or_default();
    let payload = event_get(event, "payload");
    let external_id = match event_get(&event_get(event, "externalRecordRef"), "externalId") {
        Js::Undefined => None,
        id => Some(id),
    };
    match event_text(event, "triggerType").as_deref() {
        Some("webhook" | "poll") => {
            if let Some(address) = event_address {
                let key = Some(event_address_key(address));
                if let Some(id) = external_id.as_ref().filter(|_| surface_type.as_deref() == Some(address.event.as_str())) {
                    return Ok(Position::stable(&adapter_type, key, id.to_js_string(), payload));
                }
                return Ok(Position::unstable(&adapter_type, key, payload));
            }
            let root_record_type = event_text(event, "rootRecordType").filter(|t| !t.is_empty());
            if let (Some(root), Some(id)) = (&root_record_type, external_id.as_ref().filter(|id| id.truthy())) {
                return Ok(Position::stable(&adapter_type, Some(surface_type.unwrap_or_else(|| root.clone())), id.to_js_string(), payload));
            }
            Ok(Position::unstable(&adapter_type, surface_type.or_else(|| event_text(event, "rootRecordType")), payload))
        }
        Some("snapshot") => Ok(Position::unstable(source_adapter_slug, Some("meta".into()), Js::Undefined)),
        Some("mutation") => match event_get(event, "recordId") {
            id if id.truthy() => Ok(Position::stable(source_adapter_slug, surface_type, id.to_js_string(), Js::Undefined)),
            _ => Err(Failure::engine(
                "MOVENG_RUNTIME",
                "a mutation event carries no recordId — nothing to seed the changed record from".into(),
            )),
        },
        other => Err(Failure::unsupported(
            &format!("'{}' trigger events", other.unwrap_or("undefined")),
            "the movement engine seeds webhook, poll, snapshot, and mutation events",
        )),
    }
}

/// The surface-read wrapper's restamp: the position under its natural type,
/// so the adapter resolves the natural field name against it.
fn restamp(position: &Position, natural: Option<String>, adapter_type: &str) -> Position {
    match natural {
        Some(natural) if Some(&natural) != position.record_type.as_ref() => match &position.record_id {
            Some(id) => Position::stable(adapter_type, Some(natural), id.clone(), position.data.clone()),
            None => Position::unstable(adapter_type, Some(natural), position.data.clone()),
        },
        _ => position.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::{PendingRequest, Step};

    const CATALOG: &str = r#"{"adapters":{"email":{"constructionArgs":[],"schemas":{"":{"positions":{"message":{"properties":{"subject":"text","text":"text"},"edges":{}}},"collections":{},"writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

    /// A segment driven to its end, each request answered by `serve`; the
    /// requests in the order they came.
    fn drive(source: &str, payload: Json, serve: impl Fn(&PendingRequest) -> Json) -> (Json, Vec<PendingRequest>) {
        drive_serving(source, payload, &[], serve)
    }

    /// `drive`, for a host that serves the optional methods `serves`.
    fn drive_serving(source: &str, payload: Json, serves: &[&str], serve: impl Fn(&PendingRequest) -> Json) -> (Json, Vec<PendingRequest>) {
        let input = json!({
            "entry": "segment", "source": source, "languageVersion": 3, "segmentId": "g1", "serves": serves,
            "now": "2026-03-12T12:00:00.000Z",
            "event": env::encode_plain(&env::decode(&json!(["o", 0, [
                ["pipelineInputId", "p"], ["adapterType", "email"], ["triggerType", "webhook"], ["payload", payload],
            ]])).unwrap()),
            "catalog": serde_json::from_str::<Json>(CATALOG).unwrap(),
        });
        let mut segment = crate::begin(&input.to_string()).unwrap();
        let mut seen = Vec::new();
        let mut step = segment.start().unwrap();
        loop {
            match step {
                Step::Done(done) => return (done, seen),
                Step::Pending(pending) => {
                    let request = pending.into_iter().next().expect("one request at a time");
                    let answer = crate::read_answer(&serve(&request).to_string()).unwrap();
                    seen.push(request.clone());
                    step = segment.answer(request.id, answer).unwrap();
                }
            }
        }
    }

    /// The host of a plain run: the check passes, the gate never closes, a
    /// field reads the payload's value.
    fn plain_host(payload: Json) -> impl Fn(&PendingRequest) -> Json {
        move |request| match (request.family, request.method.as_str()) {
            ("check", "program") => json!({ "value": { "diagnostics": [], "stamps": [] } }),
            ("adapters", "resolve") => json!({ "value": { "instance": "i1", "adapterType": "email", "methods": [] } }),
            ("control.cancel", _) => json!({ "value": false }),
            ("trace", "append") => json!({}),
            ("adapters", "call") => {
                let read = env::decode(&request.args["args"]).unwrap();
                let Js::Object(read) = read else { panic!("a read") };
                let Some(Js::String(field)) = read.get("fieldId") else { panic!("a field") };
                match payload.get(field) {
                    Some(value) => json!({ "value": { "result": value } }),
                    None => json!({ "value": {} }),
                }
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    const SLEEPS: &str = "import { email } from adapters\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {\n  await sleep(1h)\n}";

    /// A member's failure that is this engine's own refusal — a reading the
    /// TypeScript's member would have made — is never forgiven by
    /// `onError`: dropping the member would answer what the TypeScript does
    /// not. The run fails, naming it.
    #[test]
    fn on_error_never_forgives_this_engines_own_refusal() {
        let mixed: Vec<String> = (0..65).map(|i| if i % 2 == 0 { i.to_string() } else { format!("\"{i}\"") }).collect();
        let source = format!(
            "import {{ email }} from adapters\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {{\n  ys = MAP([1, 2], {{ onError: \"ignore\" }}, (x) => {{\n    return SORT([{}])\n  }})\n  return ys\n}}",
            mixed.join(", ")
        );
        // Met before any effect, the refusal hands the run to the
        // TypeScript engine; after one (the gate's trace handed over), it
        // fails the run.
        let (done, _) = drive(&source, json!(["o", 1, []]), plain_host(json!({})));
        assert_eq!(done, json!({ "declined": "unreproduced" }));
        let source = source.replace("  ys = MAP", "  if 1 == 1 {\n    g = 1\n  }\n  ys = MAP");
        let (done, _) = drive(&source, json!(["o", 1, []]), plain_host(json!({})));
        let error = done.get("thrown").or_else(|| done.get("failed").map(|f| &f["error"])).unwrap_or_else(|| panic!("the run fails: {done}"));
        assert_eq!(error["code"], json!("MOVENG_UNSUPPORTED"), "{done}");
        assert!(error["message"].as_str().is_some_and(|m| m.starts_with("SORT over 65 members")), "{done}");
    }

    /// The engine reads no clock: a sleep asks the host's `clock.now` and
    /// wakes at its answer plus the sleep.
    #[test]
    fn a_sleep_wakes_at_the_host_clocks_answer_plus_the_sleep() {
        let host = plain_host(json!({}));
        let (done, seen) = drive_serving(SLEEPS, json!(["o", 1, []]), &["park.sink.commitTimerPark"], |request| {
            match (request.family, request.method.as_str()) {
                ("clock", "now") => json!({ "value": { "nowIso": "2026-10-07T12:00:00.000Z" } }),
                ("park.sink", "commitTimerPark") => json!({}),
                _ => host(request),
            }
        });
        assert!(done.get("result").is_some(), "{done}");
        let calls: Vec<String> = seen.iter().map(|r| format!("{}.{}", r.family, r.method)).collect();
        let clock = calls.iter().position(|c| c == "clock.now").expect("the clock was asked");
        assert_eq!(calls[clock + 1], "park.sink.commitTimerPark");
        assert_eq!(seen[clock].args, json!({ "segmentId": "g1" }));
        assert_eq!(seen[clock + 1].args["wakeAt"], json!("2026-10-07T13:00:00.000Z"));
    }

    /// A clock answer that names no instant fails the run, as the TypeScript
    /// engine's read of it does.
    #[test]
    fn a_clock_answer_naming_no_instant_fails_the_run() {
        let host = plain_host(json!({}));
        let (done, _) = drive_serving(SLEEPS, json!(["o", 1, []]), &["park.sink.commitTimerPark"], |request| {
            match (request.family, request.method.as_str()) {
                ("clock", "now") => json!({ "value": { "now": "2026-10-07T12:00:00.000Z" } }),
                _ => host(request),
            }
        });
        let message = done["thrown"]["message"].as_str().or_else(|| done["failed"]["error"]["message"].as_str()).unwrap_or_default();
        assert!(message.contains("clock.now answered") && message.contains("nowIso"), "{done}");
    }

    /// A host that serves no timer park is asked neither its clock nor a
    /// park: the sleep fails the run first, as the TypeScript engine's does.
    #[test]
    fn a_sleep_on_a_host_with_no_timer_park_asks_nothing_and_fails() {
        let (done, seen) = drive(SLEEPS, json!(["o", 1, []]), plain_host(json!({})));
        assert!(!seen.iter().any(|r| r.family == "clock" || r.family == "park.sink"));
        let message = done["thrown"]["message"].as_str().or_else(|| done["failed"]["error"]["message"].as_str()).unwrap_or_default();
        assert!(message.contains("with no park sink"), "{done}");
    }

    #[test]
    fn a_run_reads_binds_and_branches_through_its_host() {
        let source = "import { email } from adapters\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {\n  s = msg.`subject`\n  if s == \"Hi\" {\n    t = \"${s}!\"\n    return t\n  }\n  u = msg.`text`\n}";
        let payload = json!({ "subject": "Hi" });
        let (done, seen) = drive(source, json!(["o", 1, [["subject", "Hi"]]]), plain_host(payload));
        assert_eq!(done, json!({ "result": { "movementName": "m", "writes": ["l", 0, []] } }));
        let calls: Vec<String> = seen.iter().map(|r| format!("{}.{}", r.family, r.method)).collect();
        assert_eq!(
            calls,
            [
                "check.program", "adapters.resolve", "control.cancel.cancelled", "adapters.call", "control.cancel.cancelled",
                "control.cancel.cancelled", "trace.append", "control.cancel.cancelled", "control.cancel.cancelledNow",
            ]
        );
        // The `if`'s gate is handed over after the arm's first statement, as
        // the TypeScript publishes after every statement at any depth.
        assert_eq!(appended(&seen[6]), json!([{ "kind": "gate", "outcome": true }]));
        // Every request the host serves names the segment.
        assert!(seen.iter().filter(|r| r.family != "check").all(|r| r.args["segmentId"] == json!("g1")));
        // The source adapter reads the payload under the parameter's
        // declared position.
        // (Its data is the event's own object, named by the id it was sent with.)
        assert!(seen[3].args["position"].to_string().contains(r#"["recordType","message"]"#), "{}", seen[3].args["position"]);
    }

    /// The event's position crosses once, registered by handle on its first
    /// read; every later read names the handle, and carries only the rest of
    /// its arguments.
    #[test]
    fn a_position_crosses_once_and_is_named_by_handle_after() {
        let source = "import { email } from adapters\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {\n  s = \"${msg.`subject`} ${msg.`text`}\"\n}";
        let payload = json!({ "subject": "Hi", "text": "there" });
        let (_, seen) = drive(source, json!(["o", 1, [["subject", "Hi"], ["text", "there"]]]), plain_host(payload));
        let reads: Vec<&PendingRequest> = seen.iter().filter(|r| r.args.get("method") == Some(&json!("getFieldValue"))).collect();
        assert_eq!(reads.len(), 2);
        assert_eq!((reads[0].args["positionRef"].clone(), reads[1].args["positionRef"].clone()), (json!(0), json!(0)));
        assert!(reads[0].args.get("position").is_some());
        assert!(reads[1].args.get("position").is_none(), "a handle already registered is not re-sent");
        let Js::Object(read) = env::decode(&reads[1].args["args"]).unwrap() else { panic!("a read") };
        assert_eq!(read.entries().iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["fieldId"]);
    }

    /// A streamed landing is not restamped as it lands; the stamp a field
    /// read gives it is made once, so the record crosses once however many of
    /// its fields are read.
    #[test]
    fn a_streamed_landing_crosses_once_however_many_fields_are_read() {
        let source = "import { email } from adapters\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {\n  msg-[a:attachments]-> {\n    s = \"${a.`name`} ${a.`subject`}\"\n  }\n}";
        let landing = json!(["o", 1, [["adapterType", "email"], ["recordType", null], ["identity", ["o", 2, [["kind", "unstable"], ["data", ["o", 3, [["name", "a"]]]]]]]]]);
        let (done, seen) = drive(source, json!(["o", 1, []]), move |request| match (request.family, request.method.as_str()) {
            ("check", "program") => json!({ "value": { "diagnostics": [], "stamps": [] } }),
            ("adapters", "resolve") => json!({ "value": { "instance": "i1", "adapterType": "email", "methods": ["iterateRelated"] } }),
            ("control.cancel", _) => json!({ "value": false }),
            ("trace", "append") => json!({}),
            ("adapters", "call") if request.args["method"] == json!("iterateRelatedPage") => {
                json!({ "value": { "result": ["o", 0, [["items", ["l", 4, [["o", 5, [["position", landing.clone()]]]]]]]] } })
            }
            ("adapters", "call") => json!({ "value": { "result": "x" } }),
            other => panic!("unexpected {other:?}"),
        });
        assert!(done.get("result").is_some(), "{done}");
        let reads: Vec<&PendingRequest> = seen.iter().filter(|r| r.args.get("method") == Some(&json!("getFieldValue"))).collect();
        assert_eq!(reads.len(), 2);
        assert_eq!(reads[0].args["positionRef"], reads[1].args["positionRef"]);
        assert!(reads[0].args.get("position").is_some());
        assert!(reads[1].args.get("position").is_none(), "the landing's stamp is registered once");
        // Stamped with the parameter's declared type, its inline data kept.
        assert!(reads[0].args["position"].to_string().contains(r#"["recordType","message"]"#), "{}", reads[0].args["position"]);
    }

    #[test]
    fn a_failed_read_fails_the_run_with_the_hosts_own_error() {
        let source = "import { email } from adapters\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {\n  s = msg.`subject`\n}";
        let payload = json!({});
        let host = plain_host(payload);
        let (done, _) = drive(source, json!(["o", 1, []]), move |request| match (request.family, request.method.as_str()) {
            ("adapters", "call") => json!({ "value": { "error": { "kind": "adapter_error", "message": "down", "ref": 4 } } }),
            _ => host(request),
        });
        assert_eq!(done, json!({ "failed": { "error": { "hostError": 4 }, "result": { "movementName": "m", "writes": ["l", 0, []] } } }));
    }

    #[test]
    fn what_it_does_not_run_is_declined_before_anything_happens() {
        let source = "import { email } from adapters\nimport { fetch_url } from plugins\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {\n  s = fetch_url(url: \"x\")\n}";
        let (done, seen) = drive(source, json!(["o", 1, []]), plain_host(json!({})));
        // Refused on this engine's own parse: not even the check is asked.
        assert_eq!(done, json!({ "refused": "plugin_call", "reasons": ["plugin_call"] }));
        assert!(seen.is_empty());
    }

    /// The refused `done` carries every reason, the first as `refused`; a
    /// movement the entry does not reach refuses nothing, and the run goes on
    /// to its check.
    #[test]
    fn a_refusal_names_every_reason_and_an_unreached_movement_none() {
        let first_step = |source: &str| {
            let input = json!({
                "entry": "segment", "source": source, "languageVersion": 3, "segmentId": "g1", "serves": [], "movementName": "m",
                "now": "2026-03-12T12:00:00.000Z", "event": wire(json!({})), "catalog": serde_json::from_str::<Json>(CATALOG).unwrap(),
            });
            crate::begin(&input.to_string()).unwrap().start().unwrap()
        };
        let prelude = "import { email } from adapters\nimport { fetch_url } from plugins\ninbox = email()\n";
        let helper = "movement helper(e: <inbox-[:message]->>) {\n  s = fetch_url(url: \"x\")\n}\n";
        let refused = format!("{prelude}movement m(msg: <inbox-[:message]->>) {{\n  x = AI(\"why\")\n  helper(e: msg)\n}}\n{helper}");
        match first_step(&refused) {
            Step::Done(done) => {
                assert_eq!(done, json!({ "refused": "expression:llm", "reasons": ["expression:llm", "plugin_call"] }))
            }
            Step::Pending(pending) => panic!("asked {:?}", pending.iter().map(|r| r.method.clone()).collect::<Vec<_>>()),
        }
        let unreached = format!("{prelude}movement m(msg: <inbox-[:message]->>) {{\n  x = 1\n}}\n{helper}");
        match first_step(&unreached) {
            Step::Pending(pending) => assert_eq!(pending.iter().map(|r| (r.family, r.method.as_str())).collect::<Vec<_>>(), [("check", "program")]),
            Step::Done(done) => panic!("{done}"),
        }
    }

    /// The file scope as `prepareMovement` builds it: an import of a plugin
    /// binds the plugin, a declared shape its name, a `type` nothing, and a
    /// value what it evaluates to, in source order, a body reading it; a park
    /// writes each as the TypeScript engine does.
    #[test]
    fn file_level_declarations_bind_and_park_as_the_typescript_engine_writes_them() {
        let source = "import { email } from adapters\nimport { fetch_url as fetch } from plugins\ninbox = email()\ntype Stage = <\"a\" | \"b\">\nrules = \"route\"\nnode Lead {\n  name: <text> \"its name ${rules}\"\n}\ntag = \"${UPPER(rules)}!\"\nmovement m(msg: <inbox-[:message]->>) {\n  label = \"${tag} ${rules}\"\n  await sleep(1h)\n}";
        let host = plain_host(json!({}));
        let (done, seen) = drive_serving(source, json!(["o", 1, []]), &["park.sink.commitTimerPark"], |request| {
            match (request.family, request.method.as_str()) {
                ("clock", "now") => json!({ "value": { "nowIso": "2026-10-07T12:00:00.000Z" } }),
                ("park.sink", "commitTimerPark") => json!({}),
                _ => host(request),
            }
        });
        assert!(done.get("result").is_some(), "{done}");
        let park = seen.iter().find(|r| r.method == "commitTimerPark").expect("the sleep parked");
        let decoded = env::decode(&park.args["state"]).unwrap();
        let state = env::json_of_js(&decoded);
        let file = &state["scopeChain"][0]["bindings"];
        // In the order declared (the JSON above sorts its keys).
        let Some(Js::Array(chain)) = (match &decoded { Js::Object(o) => o.get("scopeChain"), _ => None }) else { panic!("a chain") };
        let first = chain.items()[0].clone();
        let Some(Js::Object(bindings)) = (match &first { Js::Object(o) => o.get("bindings"), _ => None }) else { panic!("bindings") };
        let kinds: Vec<(&str, String)> = bindings.entries().iter().map(|(name, b)| (name.as_str(), env::json_of_js(b)["kind"].as_str().unwrap_or_default().to_string())).collect();
        let kinds: Vec<(&str, &str)> = kinds.iter().map(|(n, k)| (*n, k.as_str())).collect();
        assert_eq!(
            kinds,
            [("m", "movement"), ("email", "opaque"), ("fetch", "opaque"), ("inbox", "instance"), ("rules", "value"), ("Lead", "shape"), ("tag", "value")]
        );
        assert_eq!(file["fetch"], json!({ "kind": "opaque", "what": "a plugin", "name": "fetch" }));
        assert_eq!(file["Lead"], json!({ "kind": "shape", "name": "Lead" }));
        assert_eq!(file["tag"]["value"], json!("ROUTE!"));
        assert_eq!(state["scopeChain"][1]["bindings"]["label"]["value"], json!("ROUTE! route"));
        // Its own park resumes here: the file scope's shape is the program's.
        assert_eq!(crate::park::resume_refusal(&park.args["state"]), None);
    }

    /// An extraction asks what the TypeScript asks, in its order: the
    /// `from` slot's read, one `ids.mint` for its text resource, then per
    /// region the cancel gate, the clock either side of the priced model
    /// call; a head over what it yielded asks nothing.
    #[test]
    fn an_extraction_asks_its_host_what_the_typescript_asks_in_its_order() {
        let source = "import { email } from adapters\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {\n  deals = extract from [msg.`text`] {\n    digest: \"a summary\"\n    node co: \"each company\" {\n      name: \"its name\"\n    }\n  }\n  deals-[c:co]-> {\n    n = c.`name`\n  }\n}";
        let payload = json!({ "text": "Acme raised." });
        let host = plain_host(payload.clone());
        let reply = env::encode_plain(&env::js_of_json(&json!({ "parsedJson": { "x:extract_result#1": [{
            "digest": { "evidence": "q", "value": "a raise" },
            "co": [{ "name": { "evidence": "Acme", "value": "Acme" } }, { "name": { "evidence": null, "value": " " } }],
        }] } })));
        let (done, seen) = drive(source, json!(["o", 1, [["text", "Acme raised."]]]), |request| match (request.family, request.method.as_str()) {
            ("ids", "mint") => json!({ "value": ["id-1"] }),
            ("clock", "now") => json!({ "value": { "nowIso": "2026-10-09T12:00:00.000Z" } }),
            ("llm.client", "call") => json!({ "value": reply.clone() }),
            _ => host(request),
        });
        assert!(done.get("result").is_some(), "{done}");
        let calls: Vec<String> = seen.iter().map(|r| format!("{}.{}", r.family, r.method)).collect();
        assert_eq!(
            calls,
            [
                "check.program", "adapters.resolve", "control.cancel.cancelled", "adapters.call", "ids.mint", "control.cancel.cancelled",
                "clock.now", "llm.client.call", "clock.now", "trace.append", "control.cancel.cancelled", "control.cancel.cancelled",
                "trace.append", "control.cancel.cancelledNow",
            ]
        );
        let call = &seen[7].args;
        assert_eq!((call["label"].clone(), call["model"].clone(), call["effort"].clone()), (json!("movement_extraction"), json!("sonnet"), json!("low")));
        assert!(call["system"].as_str().unwrap().contains("**x:co#2** (an array under the key `co` inside each **x:extract_result#1** entity)"));
        assert_eq!(call["userMessage"], json!("## TEXT\nAcme raised."));
        assert_eq!(call["budget"], json!({ "remainingMicrodollars": null }));
        // The blank entity is counted empty and dropped; the trace names
        // what was extracted.
        let entries = appended(&seen[9]);
        let entry = &entries[0];
        // In the TypeScript's key order, the members `extractRegion` writes.
        let Js::Array(wired) = env::decode(&seen[9].args["entries"]).unwrap() else { panic!("a list") };
        let Js::Object(first) = &wired.items()[0] else { panic!("an entry") };
        assert_eq!(
            first.entries().iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            ["kind", "node", "inputChars", "inputs", "emissions", "model", "durationMs", "reply", "empty", "dropped", "entities"]
        );
        assert_eq!(entry["emissions"], json!({ "extract result": 1 }));
        assert_eq!((entry["empty"].clone(), entry["dropped"].clone()), (json!({ "co": 1 }), json!({ "co": 1 })));
        assert_eq!(entry["entities"], json!({ "extract result": [{ "fields": { "digest": "a raise" } }], "co": [{ "fields": { "name": "Acme" } }] }));
        assert_eq!(appended(&seen[12]), json!([{ "kind": "block", "root": "deals-[c:co]->", "positions": 1 }]));
    }

    /// What a `trace.append` handed over, its entries off the eval wire.
    fn appended(request: &PendingRequest) -> Json {
        assert_eq!(request.args["wire"], json!(true));
        env::json_of_js(&env::decode(&request.args["entries"]).unwrap())
    }

    /// A plain JSON value on the eval wire.
    fn wire(value: Json) -> Json {
        env::encode_plain(&env::js_of_json(&value))
    }

    #[test]
    fn a_parked_state_it_does_not_resume_is_refused_before_anything_happens() {
        let source = "import { email } from adapters\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {\n  await sleep(1h)\n  s = 1\n}";
        let scope = |binding: Json| json!([{ "bindings": { "x": binding } }]);
        for (state, reason) in [
            (json!({ "version": 1, "address": "s0", "journal": [{ "index": 0, "value": null, "next": 1 }] }), "resume_state_journal"),
            (json!({ "version": 1, "address": "s0", "frames": [] }), "resume_state_frames"),
            (json!({ "version": 1, "address": "s0", "suspended": false }), "resume_state_suspended"),
            (json!({ "version": 1, "address": "s0", "until": {} }), "resume_state_until"),
            (json!({ "version": 2, "address": "s0" }), "resume_state_version"),
            (json!({ "version": 1, "address": "s1.i0.s0" }), "resume_state_address"),
            (json!({ "version": 1, "address": "s0", "scopeChain": scope(json!({ "kind": "extraction" })) }), "resume_state_kind:extraction"),
            (
                json!({ "version": 1, "address": "s0", "scopeChain": scope(json!({ "kind": "value", "value": 1, "provenance": { "origins": [{ "kind": "extraction" }] } })) }),
                "resume_state_extraction_origin",
            ),
            (
                json!({ "version": 1, "address": "s0", "scopeChain": scope(json!({ "kind": "value", "value": [{ "kind": "handle" }] })) }),
                "resume_state_value_holds_record",
            ),
            (
                json!({ "version": 1, "address": "s0", "scopeChain": scope(json!({ "kind": "nodePosition", "fields": {}, "fieldProvenance": {}, "edges": { "e": { "kind": "deferred" } } })) }),
                "resume_state_deferred_edge",
            ),
            (
                json!({ "version": 1, "address": "s0", "scopeChain": scope(json!({ "kind": "positions", "landings": [{ "kind": "handle" }] })) }),
                "resume_state_returned_records",
            ),
        ] {
            let input = json!({
                "entry": "segment", "source": source, "languageVersion": 3, "segmentId": "g1", "serves": [],
                "now": "2026-03-12T12:00:00.000Z", "event": wire(json!({})), "catalog": serde_json::from_str::<Json>(CATALOG).unwrap(),
                "resume": { "state": wire(state) },
            });
            let mut segment = crate::begin(&input.to_string()).unwrap();
            match segment.start().unwrap() {
                Step::Done(done) => assert_eq!(done, json!({ "refused": reason, "reasons": [reason] })),
                Step::Pending(pending) => panic!("{reason}: asked {:?}", pending.iter().map(|r| r.method.clone()).collect::<Vec<_>>()),
            }
        }
        let resumable = json!({
            "version": 1, "address": "s2.b0.s0", "bindingName": null,
            "scopeChain": [{ "bindings": {
                "none": { "kind": "positions", "landings": [] },
                "v": { "kind": "value", "value": { "a": 1 }, "provenance": { "origins": [{ "kind": "literal" }] } },
                "e": { "kind": "event" },
                "g": { "kind": "nodePosition", "fields": {}, "fieldProvenance": {}, "edges": { "owner": { "kind": "landed", "landings": [{ "kind": "nodeRef", "id": 0 }] } } },
            } }],
        });
        assert_eq!(crate::park::resume_refusal(&wire(resumable.clone())), None);
        // A suspension's state, whose journal is empty: this engine keeps no
        // call's answer for a statement run again.
        let mut suspended = resumable;
        suspended["suspended"] = json!(true);
        suspended["journal"] = json!([]);
        assert_eq!(crate::park::resume_refusal(&wire(suspended)), None);
    }

    /// The file scope is rebuilt from the program on resume, so a declared
    /// shape there is the program's; anywhere else it is a local shape this
    /// engine does not rebuild.
    #[test]
    fn a_shape_is_resumed_in_the_file_scope_only() {
        let state = |file: Json, body: Json| {
            json!({ "version": 1, "address": "s0", "bindingName": null, "scopeChain": [{ "bindings": file }, { "bindings": body }] })
        };
        let shape = json!({ "kind": "shape", "name": "Lead" });
        assert_eq!(crate::park::resume_refusal(&wire(state(json!({ "Lead": shape }), json!({})))), None);
        assert_eq!(
            crate::park::resume_refusal(&wire(state(json!({}), json!({ "Lead": shape })))).as_deref(),
            Some("resume_state_kind:shape")
        );
    }

    #[test]
    fn a_malformed_state_of_a_known_kind_fails_the_resume_loudly() {
        // Its kinds are all this engine's, so admission lets it by; the
        // handle carries no record, so rehydrating it fails the run rather
        // than resume it wrong.
        let source = "import { email } from adapters\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {\n  await sleep(1h)\n  s = 1\n}";
        let state = json!({ "version": 1, "address": "s0", "bindingName": null, "scopeChain": [
            { "bindings": {} },
            { "bindings": { "co": { "kind": "handle", "targetType": "company" } } },
        ] });
        assert_eq!(crate::park::resume_refusal(&wire(state.clone())), None);
        let input = json!({
            "entry": "segment", "source": source, "languageVersion": 3, "segmentId": "g1", "serves": [],
            "now": "2026-03-12T12:00:00.000Z", "event": wire(json!({ "adapterType": "email", "triggerType": "webhook", "payload": {} })),
            "catalog": serde_json::from_str::<Json>(CATALOG).unwrap(), "resume": { "state": wire(state) },
        });
        let host = plain_host(json!({}));
        let mut segment = crate::begin(&input.to_string()).unwrap();
        let mut step = segment.start().unwrap();
        let done = loop {
            match step {
                Step::Done(done) => break done,
                Step::Pending(pending) => {
                    let request = pending.into_iter().next().expect("one request at a time");
                    let answer = crate::read_answer(&host(&request).to_string()).unwrap();
                    step = segment.answer(request.id, answer).unwrap();
                }
            }
        };
        assert_eq!(done["failed"]["error"]["code"], json!("MOVENG_RUNTIME"), "{done}");
        assert_eq!(done["failed"]["error"]["message"], json!("a handle descriptor without its record"));
    }

    #[test]
    fn a_write_searches_creates_and_records_through_its_host() {
        let schema = |position: &str, collections: Json| {
            json!({ "constructionArgs": [], "schemas": { "": {
                "positions": { position: { "properties": { "subject": "text", "name": "text" }, "edges": {} } },
                "collections": collections, "writableRoots": {},
            } } })
        };
        let catalog = json!({
            "adapters": { "email": schema("message", json!({})), "attio": schema("company", json!({ "companies": { "target": "company" } })) },
            "credentials": {}, "plugins": {},
        });
        let source = "import { email, attio } from adapters\ninbox = email()\ncrm = attio()\nmovement m(msg: <inbox-[:message]->>) {\n  co = write crm-[:companies]-> {\n    unique by (`name`)\n    name: msg.`subject`\n  }\n}";
        let input = json!({
            "entry": "segment", "source": source, "languageVersion": 3, "segmentId": "g1", "serves": [],
            "now": "2026-03-12T12:00:00.000Z",
            "event": ["o", 0, [["adapterType", "email"], ["triggerType", "webhook"], ["payload", ["o", 1, [["subject", "Acme"]]]]]],
            "catalog": catalog,
        });
        let mut segment = crate::begin(&input.to_string()).unwrap();
        let mut seen = Vec::new();
        let mut step = segment.start().unwrap();
        let done = loop {
            match step {
                Step::Done(done) => break done,
                Step::Pending(pending) => {
                    let request = pending.into_iter().next().expect("one request at a time");
                    let method = request.args.get("method").and_then(Json::as_str).unwrap_or("").to_string();
                    let answer = match (request.family, request.method.as_str()) {
                        ("check", _) => json!({ "value": { "diagnostics": [], "stamps": [] } }),
                        ("adapters", "resolve") => json!({ "value": {
                            "instance": format!("i{}", seen.len() + 1), "adapterType": request.args["adapterType"], "methods": [],
                        } }),
                        ("adapters", "call") => json!({ "value": { "result": match method.as_str() {
                            "getFieldValue" => json!("Acme"),
                            "describe" => json!(null),
                            "resolveEntity" => json!(["o", 0, [["candidates", ["l", 1, []]]]]),
                            "createRecord" => json!(["o", 0, [["externalId", "co-1"], ["data", ["o", 1, []]]]]),
                            other => panic!("unexpected call {other}"),
                        } } }),
                        ("locks", "acquire") => json!({ "value": { "token": "k1" } }),
                        ("control.cancel", _) => json!({ "value": false }),
                        _ => json!({}),
                    };
                    seen.push(if method.is_empty() { format!("{}.{}", request.family, request.method) } else { method });
                    step = segment.answer(request.id, crate::read_answer(&answer.to_string()).unwrap()).unwrap();
                }
            }
        };
        assert_eq!(
            seen,
            [
                "check.program", "adapters.resolve", "control.cancel.cancelled", "adapters.resolve", "describe", "getFieldValue",
                "locks.acquire", "resolveEntity", "createRecord", "locks.release", "control.cancel.cancelledNow",
            ]
        );
        let writes = env::decode(&done["result"]["writes"]).unwrap();
        let Js::Array(writes) = writes else { panic!("a list of writes") };
        let record = crate::env::json_of_js(&writes.items()[0]);
        assert_eq!(record["externalId"], json!("co-1"));
        assert_eq!(record["bindingName"], json!("co"));
        assert_eq!(record["origin"], json!({ "kind": "write", "writeIndex": 0, "externalId": "co-1" }));
        assert_eq!(record["provenance"]["name"][0]["kind"], json!("source_field"));
    }

    /// A host whose sink keeps pauses (`commitLimitPause`) but cannot suspend
    /// (it serves no `commitSuspension`) is not paused at all (run.ts
    /// `canSuspend`): the run fails on its cap, asking its sink nothing.
    #[test]
    fn a_sink_that_keeps_pauses_but_cannot_suspend_fails_the_run_on_its_cap() {
        let schema = |position: &str, collections: Json, roots: Json| {
            json!({ "constructionArgs": [], "schemas": { "": {
                "positions": { position: { "properties": { "subject": "text", "name": "text" }, "edges": {} } },
                "collections": collections, "writableRoots": roots,
            } } })
        };
        let catalog = json!({
            "adapters": {
                "email": schema("message", json!({}), json!({})),
                "attio": schema("company", json!({ "companies": { "target": "company" } }), json!({
                    "company": { "fields": { "name": "text" }, "resultShape": { "externalId": "text", "name": "text" }, "fuzzyResolution": true },
                })),
            },
            "credentials": {}, "plugins": {},
        });
        let source = "import { email, attio } from adapters\ninbox = email()\ncrm = attio()\nmovement m(msg: <inbox-[:message]->>) {\n  co = write crm-[:companies]-> {\n    unique by (FUZZY `name`)\n    name: msg.`subject`\n  }\n}";
        let input = json!({
            "entry": "segment", "source": source, "languageVersion": 3, "segmentId": "g1", "serves": ["park.sink.commitLimitPause"],
            "now": "2026-03-12T12:00:00.000Z",
            "event": ["o", 0, [["adapterType", "email"], ["triggerType", "webhook"], ["payload", ["o", 1, [["subject", "Acme"]]]]]],
            "catalog": catalog,
            "spend": { "priorMicrodollars": 1200, "capBaselineMicrodollars": 0, "capMicrodollars": 1000 },
        });
        let mut segment = crate::begin(&input.to_string()).unwrap();
        let mut seen = Vec::new();
        let mut step = segment.start().unwrap();
        let candidate = |id: &str, name: &str| json!(["o", 0, [["adapterType", "attio"], ["externalId", id], ["data", ["o", 1, [["name", name]]]]]]);
        let done = loop {
            match step {
                Step::Done(done) => break done,
                Step::Pending(pending) => {
                    let request = pending.into_iter().next().expect("one request at a time");
                    let method = request.args.get("method").and_then(Json::as_str).unwrap_or("").to_string();
                    let answer = match (request.family, request.method.as_str()) {
                        ("check", _) => json!({ "value": { "diagnostics": [], "stamps": [] } }),
                        ("adapters", "resolve") => json!({ "value": {
                            "instance": format!("i{}", seen.len() + 1), "adapterType": request.args["adapterType"], "methods": [],
                        } }),
                        ("adapters", "call") => json!({ "value": { "result": match method.as_str() {
                            "getFieldValue" => json!("Acme"),
                            "describe" => json!(null),
                            "resolveEntity" => json!(["o", 0, [["candidates", ["l", 1, [candidate("co-1", "Acme Inc"), candidate("co-2", "Acme Labs")]]]]]),
                            other => panic!("unexpected call {other}"),
                        } } }),
                        ("llm", "arbitrateEntities") => json!({ "value": { "error": { "kind": "budget", "message": "spent" }, "cost": [] } }),
                        ("locks", "acquire") => json!({ "value": { "token": "k1" } }),
                        ("control.cancel", _) => json!({ "value": false }),
                        _ => json!({}),
                    };
                    seen.push(if method.is_empty() { format!("{}.{}", request.family, request.method) } else { method });
                    step = segment.answer(request.id, crate::read_answer(&answer.to_string()).unwrap()).unwrap();
                }
            }
        };
        assert!(!seen.iter().any(|s| s.starts_with("park.sink")), "{seen:?}");
        assert_eq!(done["failed"]["error"], json!({ "class": "RunCostCapExceeded", "capMicrodollars": 1000.0, "spentMicrodollars": 1200.0 }));
    }

    #[test]
    fn the_event_fields_a_body_reads_are_found() {
        let body = json!([{ "kind": "write", "write": { "fields": [{ "value": { "raw": "COALESCE(msg.`when`, x.`y`)", "span": {} } }] } }]).to_string();
        let mut seen = Vec::new();
        event_fields_read(&body, "msg", &mut |f| seen.push(f.to_string()));
        assert_eq!(seen, ["when"]);
    }

    /// A segment whose check answers `check`, with a dated event field;
    /// the requests it made, and its `done`.
    fn dated_run(source: &str, check: Json) -> (Json, Vec<String>) {
        let schema = |properties: Json, collections: Json| {
            json!({ "constructionArgs": [], "schemas": { "": {
                "positions": { "message": { "properties": properties, "edges": {} } },
                "collections": collections, "writableRoots": {},
            } } })
        };
        let catalog = json!({
            "adapters": {
                "email": schema(json!({ "subject": "text", "when": "datetime" }), json!({})),
                "attio": schema(json!({ "name": "text" }), json!({ "companies": { "target": "message" } })),
            },
            "credentials": {}, "plugins": {},
        });
        let input = json!({
            "entry": "segment", "source": source, "languageVersion": 3, "segmentId": "g1", "serves": [],
            "now": "2026-03-12T12:00:00.000Z",
            "event": ["o", 0, [["adapterType", "email"], ["triggerType", "webhook"], ["payload", ["o", 1, []]]]],
            "catalog": catalog,
        });
        let mut segment = crate::begin(&input.to_string()).unwrap();
        let mut seen = Vec::new();
        let mut step = segment.start().unwrap();
        loop {
            match step {
                Step::Done(done) => return (done, seen),
                Step::Pending(pending) => {
                    let request = pending.into_iter().next().expect("one request at a time");
                    seen.push(format!("{}.{}", request.family, request.method));
                    let answer = match request.family {
                        "check" => json!({ "value": check }),
                        _ => json!({}),
                    };
                    step = segment.answer(request.id, crate::read_answer(&answer.to_string()).unwrap()).unwrap();
                }
            }
        }
    }

    #[test]
    fn a_dated_read_declines_before_the_version_warning_is_traced() {
        let deprecated = json!({
            "diagnostics": [{ "code": "MOV_LANGUAGE_VERSION_DEPRECATED", "message": "old" }],
            "stamps": [],
            "versionWarning": { "code": "MOV_LANGUAGE_VERSION_DEPRECATED", "message": "old" },
        });
        let source = "import { email, attio } from adapters\ninbox = email()\ncrm = attio()\nmovement m(msg: <inbox-[:message]->>) {\n  write crm-[:companies]-> { name: msg.`when` }\n}";
        let (done, seen) = dated_run(source, deprecated);
        assert_eq!(done, json!({ "declined": "event_field_dated" }));
        assert_eq!(seen, ["check.program"]);
    }

    #[test]
    fn a_spread_of_the_event_declines_on_the_dated_fields_its_stamp_names() {
        let source = "import { email, attio } from adapters\ninbox = email()\ncrm = attio()\nmovement m(msg: <inbox-[:message]->>) {\n  write crm-[:companies]-> { ...msg }\n}";
        let stamp = |fields: Json| json!({ "diagnostics": [], "stamps": [{ "path": "/statements/3/body/0/write/spreads/0", "spreadFields": fields }] });
        let (done, seen) = dated_run(source, stamp(json!(["subject", "when"])));
        assert_eq!(done, json!({ "declined": "event_field_dated" }));
        assert_eq!(seen, ["check.program"]);
        // Undated fields only: the run goes on to its source.
        let (_, seen) = dated_run(source, stamp(json!(["subject"])));
        assert_eq!(seen[1], "adapters.resolve");
    }

    /// A graph's record spread whose copy plan walks edges runs on (chunk
    /// 7A Task 2): its walk is the node plane's.
    #[test]
    fn a_graph_copy_that_walks_edges_runs_past_the_check() {
        let source = "import { email, attio } from adapters\ninbox = email()\ncrm = attio()\nmovement m(msg: <inbox-[:message]->>) {\n  co = write crm-[:companies]-> { name: msg.`subject` }\n  g = graph { ...co }\n}";
        let copy = |edges: Json| json!({ "diagnostics": [], "stamps": [{ "path": "/statements/3/body/1/value/node/spreads/0", "copy": { "fields": ["name"], "edges": edges } }] });
        for edges in [json!({ "notes": { "fields": [], "edges": {} } }), json!({})] {
            let (_, seen) = dated_run(source, copy(edges));
            assert_eq!(seen[1], "adapters.resolve");
        }
    }

    #[test]
    fn a_record_is_dated_through_the_positions_it_names() {
        let schema: InstanceSchema = serde_json::from_value(json!({
            "positions": {
                "message": { "properties": { "subject": "text", "sender": { "kind": "record", "position": "person" } }, "edges": {} },
                "person": { "properties": { "name": "text", "met": { "kind": "list", "of": { "kind": "record", "position": "meeting" } } }, "edges": {} },
                "meeting": { "properties": { "at": "datetime" }, "edges": {} },
                "loop": { "properties": { "next": { "kind": "record", "position": "loop" }, "name": "text" }, "edges": {} },
            },
            "collections": {}, "writableRoots": {},
        }))
        .unwrap();
        let field = |json: Json| -> FieldType { serde_json::from_value(json).unwrap() };
        let dated = |json: Json| is_dated(&field(json), &schema, &mut Vec::new());
        assert!(dated(json!("date")) && dated(json!("datetime")) && !dated(json!("text")));
        // A record two positions deep, through a list, reaches a datetime.
        assert!(dated(json!({ "kind": "record", "position": "message" })));
        assert!(dated(json!({ "kind": "maybeAbsent", "of": { "kind": "record", "position": "person" } })));
        // A cycle with nothing dated in it ends, undated.
        assert!(!dated(json!({ "kind": "record", "position": "loop" })));
        // A record this engine cannot name, or one naming no position, may be dated.
        assert!(dated(json!({ "kind": "record" })));
        assert!(dated(json!({ "kind": "record", "position": "nowhere" })));
        assert!(!dated(json!({ "kind": "enum", "options": ["a"] })));
    }

    #[test]
    fn an_event_address_keys_by_its_sorted_pins() {
        let bare = EventAddress { event: "Message".into(), narrowing: vec![] };
        assert_eq!(event_address_key(&bare), "Message");
        let pinned = EventAddress {
            event: "Record Change".into(),
            narrowing: vec![("table".into(), "tblDeals".into()), ("base".into(), "app1".into())],
        };
        assert_eq!(event_address_key(&pinned), r#"["Record Change",[["base","app1"],["table","tblDeals"]]]"#);
    }
}
