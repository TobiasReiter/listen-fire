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
use std::collections::BTreeMap;
use std::rc::Rc;

use movement_parser::ast::{self, ExprSlot, MovementDeclaration, ParamTypeRef, RValue, Statement};
use movement_parser::catalog::helpers::{credential_arg_of, unwrap_credential_arg};
use movement_parser::catalog::snapshot::Args;
use movement_parser::catalog::types::{CatalogSnapshot, Composite, FieldType, InstanceSchema};
use movement_parser::lowering::condition::MovementCondition;
use movement_parser::lowering::expression::{AggregationFunction, Expression};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value as Json, json};

use crate::bindings::{Binding, InstanceBinding, MovementRef, Position, Scope, ShapeBinding};
use crate::write::{TargetAdapter, WriteRecord};
use crate::env::{self, Trail, ValueBinding};
use crate::eval::{Ask, ErrorClass, EvalError, Evaluated, Evaluating, Evaluator, Prov, Reader};
use crate::executor::{Host, HostError};
use crate::host::{self, Instance, ResolveAdapter, Role};
use crate::js::{self, Js, JsObject};
use crate::program::{self, Checked, DeclaredShape, DeclaringFile};
use crate::stdlib::Surroundings;
use crate::trace::{FlowTrace, TraceEntry};
use crate::{env_services, js_date};

/// Why a segment this engine refused mid-run, before any effect, is the
/// TypeScript engine's to run (`declined`).
pub(crate) const UNREPRODUCED: &str = "unreproduced";

/// The slot a `return` binds its value into (run.ts `RETURN_SLOT`): a name
/// the grammar cannot spell.
pub(crate) const RETURN_SLOT: &str = "#return";

/// A pin's standing warning: `{code, message}`, the check answer's `versionWarning`.
#[derive(Deserialize, Clone)]
pub struct VersionWarning {
    pub code: String,
    pub message: String,
}

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
    /// Answer `check.program` with the Rust checker (crates/movement-checker)
    /// instead of asking the host: its diagnostics, stamps and import link
    /// (movement_checker::answer). The host turns it on for every segment
    /// it runs on this engine (rust_engine.ts); off, the host's checker
    /// answers, as an admission dry run's start never asks.
    #[serde(default)]
    pub native_check: bool,
    /// With `native_check`: the `models` the run's snapshot itself lists
    /// (null: none), which the check holds a written model to, as the
    /// host's checker does. The catalog's own `models` is the run's list
    /// (`runChatModels`), which a run holds a model to as it calls; a
    /// snapshot listing none leaves the model unchecked until then. Absent:
    /// the catalog's.
    #[serde(default, deserialize_with = "present")]
    pub snapshot_models: Option<Json>,
    /// With `native_check`: the pin's standing warning (a deprecated
    /// version) as the run's release words it (`languageVersionDiagnostic`).
    /// The release is the host's, so its answer is the one the run traces,
    /// as the host's check answer's would be. Absent: this engine's own table.
    #[serde(default)]
    pub version_warning: Option<VersionWarning>,
    /// Resume a parked run from its state (crate::park), rather than run it.
    #[serde(default)]
    pub resume: Option<crate::park::ResumeInput>,
    /// With `resume`: run a fired callback's body against its captured
    /// state (`fireCallbackBody`) rather than resume a leaf.
    #[serde(default)]
    pub fire: Option<CallbackFire>,
    /// With `resume`: settle a race a batch resume deferred
    /// (`settleRaceFrame`), any completed branch's state as `resume.state`.
    #[serde(default)]
    pub settle: Option<RaceSettlement>,
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
    /// the shim reads it, so the engine reads no environment. The number as
    /// the deployment wrote it, a fraction included (positive and finite).
    #[serde(default = "default_file_chars")]
    pub extraction_file_chars: f64,
    /// How many named calls deep one run may nest from version 3
    /// (call_depth.ts `maxCallDepth`, a deployment's
    /// `MOVEMENT_MAX_CALL_DEPTH`): the shim reads it, so the engine reads no
    /// environment.
    #[serde(default = "default_call_depth")]
    pub max_call_depth: usize,
    /// What this deployment buys for each extraction tier (ai_tiers.ts
    /// `EXTRACTION_TIERS`, parsed): a tier's model and effort, each over the
    /// built-in row it names. The shim reads it, so the engine reads no
    /// environment. Absent: the built-in table.
    #[serde(default)]
    pub extraction_tiers: std::collections::BTreeMap<String, crate::extract::TierAssignment>,
    /// The admission dry run's start (rust_engine.ts `dryAdmit`): never
    /// answered past its first step, so a slot this engine's lowering misses,
    /// which a real run leaves to the check, is named among the refusals.
    #[serde(default)]
    pub dry_admission: bool,
}

/// A field that is there, null included (serde reads a null `Option` as
/// absent).
fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Json>, D::Error> {
    Json::deserialize(deserializer).map(Some)
}

/// A fired callback (`fireCallbackBody`): the call's values on the eval
/// wire, and its index on the callback's ledger.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallbackFire {
    pub values: Json,
    pub call_index: usize,
}

/// A deferred race to settle (`settleRaceFrame`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RaceSettlement {
    pub frame_address: String,
}

/// call_depth.ts `DEFAULT_MAX_CALL_DEPTH`.
fn default_call_depth() -> usize {
    32
}

fn default_file_chars() -> f64 {
    50_000.0
}

/// The snapshot's plugins alone, read before the rest of it loads.
#[derive(Deserialize)]
struct CatalogPlugins {
    #[serde(default = "no_plugins")]
    plugins: movement_parser::catalog::types::JsMap<movement_parser::catalog::types::PluginSpec>,
}

/// The movement files a snapshot carries for file imports
/// (`resolveFileFromSnapshot`), by the path an import names.
#[derive(serde::Deserialize)]
struct CatalogFiles {
    #[serde(default)]
    files: BTreeMap<String, CatalogFile>,
}

#[derive(serde::Deserialize)]
struct CatalogFile {
    source: String,
}

/// The snapshot's files parsed under the program's pin, each the program
/// admission walks an import in; one that does not parse is no library
/// (the link reports it, and the run ends at its check).
fn libraries_of(catalog: &str, language_version: u32) -> crate::admit::Libraries {
    let files = serde_json::from_str::<CatalogFiles>(catalog).map(|c| c.files).unwrap_or_default();
    crate::admit::Libraries(files.into_iter().filter_map(|(path, file)| Some((path, program::parse(&file.source, language_version).ok()?.program))).collect())
}

fn no_plugins() -> movement_parser::catalog::types::JsMap<movement_parser::catalog::types::PluginSpec> {
    movement_parser::catalog::types::JsMap(Default::default())
}

/// The segment entry: the run, and its `done`.
pub async fn segment(host: Host, mut input: SegmentInput) -> Json {
    // The source as the TypeScript engine's parser is handed it: its text
    // encoded as UTF-8 (`TextEncoder`), so a lone half is U+FFFD there.
    input.source = movement_parser::util::form::usv_text(&input.source).into_owned();
    let ledger = crate::ledger::Ledger::new(&input.spend);
    let mut done = match run(&host, &input, &ledger).await {
        Ok(result) => json!({ "result": result }),
        Err(Stop::Refused(reasons)) => return json!({ "refused": reasons[0], "reasons": reasons }),
        Err(Stop::Declined(reason)) => return json!({ "declined": reason }),
        Err(Stop::Thrown(failure)) => failure.marked(json!({ "thrown": failure.to_json() })),
        Err(Stop::Failed(failure, result)) => failure.marked(json!({ "failed": { "error": failure.to_json(), "result": result } })),
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

/// The extraction keyword, which admission refuses on every version
/// (crate::admit::LEGACY_EXTRACTION) before a run starts.
fn legacy_extraction() -> Failure {
    Failure::unsupported(
        "the extraction keyword ('x = extract from […] { … }')",
        "legacy_extraction: this engine does not run it on any version; version 5 writes 'extract(content, Shape)', and a version 1–4 program runs on the TypeScript engine",
    )
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

    /// A `done` that ended in this failure, marked `unreproduced` where it
    /// is this engine's own refusal of what the TypeScript engine runs on
    /// through (met after an effect, or it would have declined): the wire
    /// codes it MOVENG_UNSUPPORTED, as it codes the TypeScript's own
    /// failure this engine mirrors, so the marker is what tells a
    /// divergence from a mirrored ending.
    fn marked(&self, mut done: Json) -> Json {
        if self.is_unreproduced() {
            done["unreproduced"] = json!(true);
        }
        done
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
pub(crate) fn unsupported_message(construct: &str, detail: &str) -> String {
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

/// An adapter resolution one flow started, which every flow asking the
/// same resolution awaits (run.ts `resolutions`).
pub(crate) type Resolution = Rc<crate::flow::Shared<Result<Option<Json>, Failure>>>;

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
    /// `@user_*`'s acting user and `@actor_*`'s actor, once looked up
    /// (`actingUserCache` / `actorCache`: null is an answer too).
    pub(crate) acting_user: RefCell<Option<Js>>,
    pub(crate) actor: RefCell<Option<Js>>,
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
    /// What the run's extraction calls share (`ExtractCallRunState`).
    pub(crate) extract_calls: crate::extract::call::CallState,
    /// The files whose bytes could not be fetched, warned of once each.
    pub(crate) unfetched_files: RefCell<Vec<String>>,
    /// Log lines not yet handed to the shim.
    pub(crate) log_lines: RefCell<Vec<Json>>,
    /// The file's scope, which a callee's scope forks from.
    pub(crate) file_scope: RefCell<Option<Rc<Scope>>>,
    /// Each linked library's own scope, built once per path the first time
    /// the run needs it (run.ts `libraryEnvs`): an imported movement's call
    /// forks from its library's, a library's words read it.
    pub(crate) library_scopes: RefCell<Vec<(String, Rc<Scope>)>>,
    /// The statements the running flow is inside, at every depth, innermost
    /// last (`statementSites`): each the site of the calls it makes.
    pub(crate) call_sites: RefCell<Vec<Rc<crate::flow::Site>>>,
    /// Where each expression slot is written, by its span (crate::nested
    /// `slot_path`): the program's, and a nested call's once it is read.
    pub(crate) slot_paths: RefCell<std::collections::BTreeMap<crate::program::DeclaringFile, crate::nested::SlotPaths>>,
    /// The body boundaries the running flow is inside (`boundaries`).
    pub(crate) boundaries: RefCell<Vec<crate::flow::Boundary>>,
    /// Where the running flow's next write falls in program order.
    pub(crate) write_order: RefCell<crate::flow::WriteOrder>,
    /// The effect locks the running flow holds, by name.
    pub(crate) held_locks: RefCell<Vec<(String, crate::flow::LockMode)>>,
    /// The running flow is one a `parallel`, a `race` or a collection op
    /// started: its trace waits to join the flow that started it.
    pub(crate) forked: std::cell::Cell<bool>,
    /// The run's own locks, by name (effect_locks.ts `gates`).
    pub(crate) gates: RefCell<Vec<(String, Rc<crate::flow::Gate>)>>,
    /// Each write's key in program order, as `writes` holds them.
    pub(crate) write_keys: RefCell<Vec<Vec<usize>>>,
    /// This segment runs a fired callback's body, which cannot suspend.
    pub(crate) firing_callback: std::cell::Cell<bool>,
    /// The race frames a batch resume completed a branch into, deferred for
    /// the host to settle once the batch is through (`deferredRaceFrames`).
    pub(crate) deferred_race_frames: RefCell<Vec<String>>,
    /// Each distinct resolution asked this segment, by its identity, as it
    /// resolves (run.ts `resolutions`): two flows asking at once share one
    /// request.
    pub(crate) resolutions: RefCell<Vec<(String, Resolution)>>,
    /// The movements running, the dispatched one first (`callStack`).
    pub(crate) call_stack: RefCell<Vec<String>>,
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
    if let Some(reason) = crate::admit::version_refusal(version) {
        return Err(Stop::Refused(vec![reason]));
    }
    let root = match program::parse(&input.source, version) {
        Ok(root) => root,
        Err(refusal) if input.native_check => return Err(native_unparsed(&refusal)),
        Err(_) => return Err(unparsed(host, input).await),
    };
    // What a plugin call binds is the snapshot's to say, read off the input.
    let plugins = serde_json::from_str::<CatalogPlugins>(input.catalog.get()).ok();
    let libraries = libraries_of(input.catalog.get(), version);
    let movements = crate::admit::reachable(&root.program, input.movement_name.as_deref(), version);
    let declared: Vec<&MovementDeclaration> =
        root.program.statements.iter().filter_map(|s| if let Statement::Movement(m) = s { Some(m) } else { None }).collect();
    let entry = crate::admit::entry_of(&declared, input.movement_name.as_deref(), version);
    let crate::admit::Admission { mut reasons } =
        crate::admit::refusals(&root.program, &movements, entry, version, &crate::admit::Plugins(plugins.as_ref().map(|c| &c.plugins)), &libraries);
    if let Some(resume) = &input.resume {
        reasons.extend(crate::park::resume_refusal(&resume.state));
    }
    // A slot this engine's lowering misses is, alone, the checker's to
    // judge: one the checker refuses ends the run at the check on either
    // engine; one it passes is declined after the check, before anything.
    let lowering_misses: Vec<String> = reasons.iter().filter(|r| r.ends_with("_does_not_lower")).cloned().collect();
    if lowering_misses.len() < reasons.len() || (input.dry_admission && !reasons.is_empty()) {
        return Err(Stop::Refused(reasons));
    }
    let catalog = CatalogSnapshot::load(input.catalog.get()).map_err(|_| Stop::Declined("catalog_does_not_load".into()))?;
    // The event crosses on the segment's wire: its objects are what the
    // host sent first.
    let wire = env::Wire::default();
    let event = wire.decode(&input.event).map_err(|_| Stop::Declined("event_does_not_read".into()))?;
    let Some(now_ms) = js_date::parse(&input.now) else {
        return Err(Stop::Declined("instant_does_not_read".into()));
    };
    let answer = if input.native_check {
        let snapshot_models = match &input.snapshot_models {
            None => None,
            Some(Json::Null) => Some(None),
            Some(models) => Some(Some(serde_json::from_value::<Vec<String>>(models.clone()).map_err(|_| Stop::Declined("snapshot_models_do_not_read".into()))?)),
        };
        match snapshot_models {
            Some(models) if models != catalog.models => {
                let checked_against = CatalogSnapshot { models, ..catalog.clone() };
                native_check(&root.program, &checked_against, version, input.version_warning.as_ref())?
            }
            _ => native_check(&root.program, &catalog, version, input.version_warning.as_ref())?,
        }
    } else {
        host.request(host::check::program(&input.source, version, None))
            .await
            .map_err(|e| Stop::Thrown(Failure::Host(e)))?
            .ok_or_else(|| Stop::Declined("check_answer_malformed".into()))?
    };
    // A package import binds its members (`web.fetchUrl`) as the imports of
    // the plugins they are; the check above read it as written.
    let mut root = root;
    movement_parser::catalog::packages::expand_package_imports(&mut root.program, &catalog.plugins, version);
    let mut checked = program::join_check(root, &answer, version).map_err(|_| Stop::Declined("check_answer_malformed".into()))?;
    for (file, _) in checked.files.values_mut() {
        movement_parser::catalog::packages::expand_package_imports(&mut file.program, &catalog.plugins, version);
    }
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
        acting_user: RefCell::default(),
        actor: RefCell::default(),
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
        extract_calls: Default::default(),
        unfetched_files: RefCell::default(),
        log_lines: RefCell::default(),
        file_scope: RefCell::default(),
        library_scopes: RefCell::default(),
        call_sites: RefCell::default(),
        slot_paths: RefCell::default(),
        boundaries: RefCell::default(),
        write_order: RefCell::default(),
        held_locks: RefCell::default(),
        forked: std::cell::Cell::new(false),
        gates: RefCell::default(),
        write_keys: RefCell::default(),
        resolutions: RefCell::default(),
        firing_callback: std::cell::Cell::new(false),
        deferred_race_frames: RefCell::default(),
        call_stack: RefCell::default(),
        wire,
        effected: std::cell::Cell::new(false),
    };
    if let Some(reason) = lowering_misses.into_iter().next() {
        return Err(Stop::Declined(reason));
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

/// The Rust checker's answer to `check.program` (`SegmentInput::native_check`),
/// on the program as this engine parsed it, shaped as the host's
/// (rust_host.ts): `{diagnostics, stamps, link?, versionWarning?}`. A
/// program it refuses ends as the host ends one (program_check.ts
/// `checkPinned`): a pin this release cannot honour with
/// MOVENG_LANGUAGE_VERSION, else MOVENG_CHECK listing the blocking
/// diagnostics — errors only, and a retired write form that still runs does
/// not block.
fn native_check(program: &ast::Program, catalog: &CatalogSnapshot, version: u32, release_warning: Option<&VersionWarning>) -> Result<Json, Stop> {
    let pin = movement_checker::language_version_diagnostic(version);
    if let Some(pin) = pin.as_ref().filter(|d| d.is_error()) {
        return Err(Stop::Thrown(Failure::engine("MOVENG_LANGUAGE_VERSION", pin.message.clone())));
    }
    let options = movement_checker::CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &crate::env_services::EnvZones };
    let answer = movement_checker::answer::check_answer(program, catalog, options);
    let blocking: Vec<String> = answer
        .diagnostics
        .iter()
        .filter(|d| d.is_error() && d.code != movement_checker::codes::WRITE_SHAPE_RETIRED)
        .map(|d| format!("  {} (line {}): {}", d.code, d.span.start.line, d.message))
        .collect();
    if !blocking.is_empty() {
        return Err(Stop::Thrown(Failure::engine("MOVENG_CHECK", format!("the movement program failed checking:\n{}", blocking.join("\n")))));
    }
    let mut json = answer.to_json();
    // The run's own version warning, as the host reads it (run.ts, before
    // the body): a deprecated pin runs, and says so — in the release's words
    // when the host sent them.
    let warning = release_warning.map(|w| (w.code.clone(), w.message.clone())).or(pin.map(|d| (d.code, d.message)));
    if let Some((code, message)) = warning {
        json["versionWarning"] = json!({ "code": code, "message": message });
    }
    Ok(json)
}

/// A source this engine's parser refuses, under the native check: the
/// check's MOVENG_PARSE, worded as the TypeScript's `MovementParseError`.
fn native_unparsed(refusal: &Json) -> Stop {
    let message = refusal.get("message").and_then(Json::as_str).unwrap_or("the source does not parse");
    let at = |key: &str| refusal.get("loc").and_then(|l| l.get(key)).and_then(Json::as_u64).unwrap_or(0);
    Stop::Thrown(Failure::engine("MOVENG_PARSE", format!("{message} (line {}, col {})", at("line"), at("col"))))
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


    /// The credential id the run was handed for `name`, if any.
    pub(crate) fn credential_id(&self, name: &str) -> Option<String> {
        self.input.credential_ids.get(name).cloned()
    }

    /// The program's AST at `path`, as a park writes it (crate::program
    /// `code_at`).
    /// A closure's code as a park writes it: the closure's AST; for a
    /// movement read as a value (language version 5), the closure the
    /// TypeScript makes of its declaration, `{ params, body, span }`.
    pub(crate) fn parked_closure_code(&self, path: &str) -> Result<Js, Failure> {
        let code = self.program_code(path)?;
        if !matches!(crate::unique::get(&code, "kind"), Js::String(kind) if kind == "movement") {
            return Ok(code);
        }
        Ok(env::object_of(vec![("params", crate::unique::get(&code, "params")), ("body", crate::unique::get(&code, "body")), ("span", crate::unique::get(&code, "span"))]))
    }

    pub(crate) fn program_code(&self, path: &str) -> Result<Js, Failure> {
        self.checked.code_at(path)
            .ok_or_else(|| Failure::engine("MOVENG_RUNTIME", format!("the program holds no node at {path}, which a park writes")))
    }

    /// `WriteLedger.append`: a write, link, unlink or delete on the firing
    /// record, numbered as it happens (later reads cite it by that number),
    /// its place in program order the running flow's next.
    /// A write record moved on in place (`refresh`): the run's ledger names
    /// the new one where it named the old.
    pub(crate) fn replace_write(&self, old: &Rc<WriteRecord>, new: Rc<WriteRecord>) {
        if let Some(slot) = self.writes.borrow_mut().iter_mut().find(|w| Rc::ptr_eq(w, old)) {
            *slot = new;
        }
    }

    pub(crate) fn append_write(&self, record: Rc<WriteRecord>) {
        let key = self.write_order.borrow_mut().key();
        self.writes.borrow_mut().push(record);
        self.write_keys.borrow_mut().push(key);
    }

    /// `WriteLedger.ordered`: the writes in program order — the writes of
    /// concurrent flows by branch, at the place of their fork — every
    /// citation of a write by number renumbered to match.
    fn ordered_writes(&self) -> Vec<Js> {
        let writes = self.writes.borrow();
        let keys = self.write_keys.borrow();
        let mut order: Vec<usize> = (0..writes.len()).collect();
        order.sort_by(|a, b| crate::flow::compare_keys(&keys[*a], &keys[*b]));
        if order.iter().enumerate().all(|(position, index)| position == *index) {
            return writes.iter().map(|w| w.object.clone()).collect();
        }
        let mut renumbered = vec![0usize; writes.len()];
        for (position, index) in order.iter().enumerate() {
            renumbered[*index] = position;
        }
        order.iter().map(|index| renumber_citations(&writes[*index].object, &renumbered)).collect()
    }

    /// `assembleResult`: the writes cross on the eval wire, as the records
    /// the TypeScript builds.
    fn result(&self, cancelled: bool, parked: Option<&str>) -> Json {
        let writes = self.ordered_writes();
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
        let deferred = self.deferred_race_frames.borrow();
        if !deferred.is_empty() {
            result["deferredRaceFrames"] = json!(*deferred);
        }
        result
    }

    async fn execute(&self) -> Result<Json, Stop> {
        let (movement, index, scope) = self.prepare().await?;
        let path = format!("/statements/{index}/body");
        let ran = match &self.input.resume {
            None => self.body(&movement.body, &scope, &Address::default(), &path, 0).await.map(|_| ()),
            Some(resume) => {
                // The state as it was stored, keys in their stored order (on
                // the eval wire, as the event is).
                let state = env::decode(&resume.state).map_err(|e| Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("the parked state does not read: {e}"))))?;
                let leaf = match (&self.input.fire, &self.input.settle) {
                    (Some(fire), _) => crate::resume::Leaf::FireCallback {
                        values: self.wire.decode(&fire.values).map_err(|e| Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("the callback's values do not read: {e}"))))?,
                        call_index: fire.call_index,
                    },
                    (None, Some(settle)) => crate::resume::Leaf::SettleRace { frame: settle.frame_address.clone() },
                    (None, None) => {
                        let answer = match (&resume.answer, resume.reenter) {
                            (Some(answer), false) => Some(crate::resume::rematerialise_answer(
                                self.wire.decode(answer).map_err(|e| Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("the answer does not read: {e}"))))?,
                            )),
                            _ => None,
                        };
                        crate::resume::Leaf::Continue { answer, reenter: resume.reenter }
                    }
                };
                if let Some(failure) = crate::resume::unparsed_address(&state, &leaf) {
                    return Err(Stop::Thrown(failure));
                }
                self.resume_along(&movement, &scope, &path, &state, leaf).await
            }
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
                && self.input.settle.is_none()
                && self.ask_bool(host::control::cancelled_now(self.segment())).await.map_err(|f| Stop::Failed(f, self.result(false, None)))?);
        Ok(self.result(cancelled, parked.as_deref()))
    }

    // ── prepareMovement ──

    async fn prepare(&self) -> Result<(MovementDeclaration, usize, Rc<Scope>), Stop> {
        let file = Scope::of_file(DeclaringFile::Root);
        let statements = &self.checked.root.program.statements;
        let mut movements = Vec::new();
        for statement in statements {
            if let Statement::Movement(m) = statement {
                file.declare(m.name.clone(), Binding::Movement(Rc::new(MovementRef { name: m.name.clone(), file: DeclaringFile::Root })));
                movements.push(m);
            }
        }
        let movement = self.select_movement(&movements)?.clone();
        let index = statements
            .iter()
            .position(|s| matches!(s, Statement::Movement(m) if m.name == movement.name && m.span == movement.span))
            .expect("the movement picked is one of the program's");
        *self.movement_name.borrow_mut() = movement.name.clone();
        // The root's scope is the one a library's import of a name falls
        // back to only by name; it is set before the file statements run so
        // a library built meanwhile sees it.
        *self.file_scope.borrow_mut() = Some(file.clone());
        self.interpret_file(&DeclaringFile::Root, &file).await?;
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
            Some(ParamTypeRef::Value(value)) => {
                return Err(Stop::Thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!(
                        "'{}' takes a value ('{}: <{}>'), and a dispatched movement takes the triggering event — the checker should have caught this",
                        movement.name,
                        param.name,
                        spell_value_type(value)
                    ),
                )));
            }
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

    /// `interpretFileStatement` over a file's statements other than its
    /// movements, in source order, so a file-level value reads the ones
    /// before it: an import binds its names (a library's movement building
    /// that library's scope as the TypeScript's `declareFileImports` does), a
    /// construction binds an instance, a value binds a value, a closure binds
    /// a closure over the file's own scope; a call, or an
    /// extraction, block, write, match or link, has no event to run about and
    /// fails the run as the TypeScript's does; any other right-hand side
    /// binds nothing.
    fn interpret_file<'s>(&'s self, written: &'s DeclaringFile, file: &'s Rc<Scope>) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), Stop>> + 's>> {
        Box::pin(async move {
            let Some(program) = self.checked.file(written).map(|f| &f.program) else {
                return Err(Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("the file {written:?} is not linked"))));
            };
            for (index, statement) in program.statements.iter().enumerate().filter(|(_, s)| !matches!(s, Statement::Movement(_))) {
                match statement {
                    Statement::Import(ast::ImportStatement { source: ast::ImportSource::File { path }, names, .. }) => {
                        self.declare_file_imports(names, path, written, file).await?;
                    }
                    Statement::Assign(assign) => match &assign.value {
                        RValue::Construct { construct } if self.file_callable(&construct.callee, file, program) => return Err(Stop::Thrown(file_level_call())),
                        RValue::Construct { .. } => self.file_statement(statement, file, written),
                        // A call there is a built-in's value, or a call with
                        // nothing to run about (`resolvedRValue`, then
                        // `fileLevelCall`) — whatever its callee is, a closure's
                        // or a name nothing binds.
                        RValue::Call { call } if !self.reads_as_builtin(call, file) => return Err(Stop::Thrown(file_level_call())),
                        RValue::Expr { .. } | RValue::Call { .. } => {
                            let expr = self.value_slot(&assign.value, file)?;
                            let bound = self.bind_slot(expr, file).await?;
                            file.declare(assign.name.clone(), Binding::Value(bound));
                        }
                        RValue::Extract { .. } => return Err(Stop::Thrown(legacy_extraction())),
                        RValue::ExtractCall { .. } => {
                            return Err(Stop::Thrown(Failure::unsupported(
                                "file-level extract expressions",
                                "extraction runs inside a movement body, where the event is in scope",
                            )));
                        }
                        RValue::Block { .. } => return Err(Stop::Thrown(Failure::unsupported("file-level traversal blocks", "blocks run inside a movement body"))),
                        RValue::Write { .. } => return Err(Stop::Thrown(Failure::unsupported("file-level writes", "writes run inside a movement body"))),
                        RValue::Match { .. } => return Err(Stop::Thrown(Failure::unsupported("file-level matches", "a match runs inside a movement body"))),
                        RValue::Link { .. } => return Err(Stop::Thrown(Failure::unsupported("file-level links", "a link runs inside a movement body"))),
                        // In scope in the file's functions, holding the file's
                        // scope by reference (`file_closure_binding`).
                        RValue::Closure { closure } => {
                            let path = crate::program::in_file(written, &format!("/statements/{index}/value/closure"));
                            file.declare(assign.name.clone(), self.file_closure_binding(closure, &assign.name, file, &path));
                        }
                        _ => {}
                    },
                    other => self.file_statement(other, file, written),
                }
            }
            Ok(())
        })
    }

    /// `declareFileImports`: each name an `import { … } from "<file>"`
    /// binds, as the link resolved it — a shape as its declaration, a
    /// movement callable in its library's own scope.
    async fn declare_file_imports(&self, names: &[ast::ImportedName], path: &str, written: &DeclaringFile, file: &Rc<Scope>) -> Result<(), Stop> {
        for name in names {
            let local = name.alias.clone().unwrap_or_else(|| name.name.clone());
            let Some(import) = self.checked.imports_of(written).iter().find(|i| i.local == local) else {
                return Err(Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("'{local}' did not resolve from \"{path}\" — the checker should have caught this"))));
            };
            let binding = if import.kind == "shape" {
                let declared = self.checked.declarations.of_file(written).and_then(|d| d.shapes.get(&local)).cloned();
                let declared = declared.ok_or_else(|| Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("'{local}' did not resolve from \"{path}\" — the checker should have caught this"))))?;
                Binding::Shape(ShapeBinding::of(declared))
            } else {
                self.library_scope(&import.file).await?;
                Binding::Movement(Rc::new(MovementRef { name: import.name.clone(), file: DeclaringFile::Library(import.file.clone()) }))
            };
            file.declare(local, binding);
        }
        Ok(())
    }

    /// A library file's scope, built once per path (`libraryEnv`): its
    /// movements first, each callable in this scope, then its other
    /// statements in source order. The import aliases its constructions
    /// resolve are its own while it builds (`importOriginals` saved and
    /// restored around it).
    pub(crate) fn library_scope<'s>(&'s self, path: &'s str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Rc<Scope>, Stop>> + 's>> {
        Box::pin(async move {
            if let Some((_, scope)) = self.library_scopes.borrow().iter().find(|(p, _)| p == path) {
                return Ok(scope.clone());
            }
            let written = DeclaringFile::Library(path.to_string());
            let file = Scope::of_file(written.clone());
            self.library_scopes.borrow_mut().push((path.to_string(), file.clone()));
            let Some(library) = self.checked.file(&written) else {
                return Err(Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("the library \"{path}\" is not linked"))));
            };
            for statement in &library.program.statements {
                if let Statement::Movement(m) = statement {
                    file.declare(m.name.clone(), Binding::Movement(Rc::new(MovementRef { name: m.name.clone(), file: written.clone() })));
                }
            }
            let saved = self.import_originals.borrow().clone();
            let built = self.interpret_file(&written, &file).await;
            *self.import_originals.borrow_mut() = saved;
            built?;
            Ok(file)
        })
    }

    /// The scope a file's movements fork their calls from.
    pub(crate) fn scope_of_file(&self, file: &DeclaringFile) -> Option<Rc<Scope>> {
        match file {
            DeclaringFile::Root => self.file_scope.borrow().clone(),
            DeclaringFile::Library(path) => self.library_scopes.borrow().iter().find(|(p, _)| p == path).map(|(_, scope)| scope.clone()),
            // Parked code declares no movement.
            DeclaringFile::Parked(_) => None,
        }
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
    fn file_statement(&self, statement: &Statement, file: &Scope, written: &DeclaringFile) {
        match statement {
            Statement::Import(import) => {
                let plugins = matches!(&import.source, ast::ImportSource::Builtin { namespace } if namespace == "plugins");
                let credential = matches!(&import.source, ast::ImportSource::Builtin { namespace } if namespace == "credentials");
                for name in &import.names {
                    if let Some(alias) = &name.alias {
                        self.import_originals.borrow_mut().push((alias.clone(), name.name.clone()));
                    }
                    let binding = if plugins { Binding::Plugin(name.name.clone()) } else { Binding::Opaque { credential } };
                    file.declare(name.alias.clone().unwrap_or_else(|| name.name.clone()), binding);
                }
            }
            Statement::Shape(shape) => {
                file.declare(shape.name.clone(), Binding::Shape(ShapeBinding::of(DeclaredShape { declaration: shape.clone(), file: written.clone() })));
            }
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

    /// `readCall`'s value reading: from version 3, a callee the scope does
    /// not bind (nor names a function in any letter case) that the standard
    /// library answers.
    fn reads_as_builtin(&self, call: &ast::CallStatement, scope: &Scope) -> bool {
        self.version() >= 3
            && scope.resolve(&call.callee).is_none()
            && scope.resolve_function(&call.callee, self.version()).is_none()
            && !call.callee.contains('.')
            && crate::stdlib::is_flat_builtin(&call.callee)
    }

    /// Whether a file-level construction or call names a movement or a
    /// plugin (`resolveCallee` at file scope), which has no event to run
    /// about.
    fn file_callable(&self, callee: &str, file: &Scope, program: &ast::Program) -> bool {
        match file.resolve(callee) {
            Some(Binding::Movement(_) | Binding::Plugin(_)) => true,
            Some(_) => false,
            None => (3..5).contains(&self.version()) && program.statements.iter().any(|s| matches!(s, Statement::Movement(m) if js::to_lower_case(&m.name) == js::to_lower_case(callee))),
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
            .resolve_adapter(&ResolveAdapter {
                adapter_type: instance.adapter_slug.clone(),
                credentials_id,
                construction_args: None,
                role: Role::Source,
                dry_run: false,
            })
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
        self.body_from(statements, scope, address, path, from, Vec::new())
    }

    /// `interpretBody` entered at `from` (`BodyEntry`), that statement
    /// handing back the calls it had finished before a park (`replay`)
    /// instead of making them again.
    pub(crate) fn body_from<'s>(
        &'s self,
        statements: &'s [Statement],
        scope: &'s Rc<Scope>,
        address: &'s Address,
        path: &'s str,
        from: usize,
        replay: Vec<(usize, crate::flow::CallRecord)>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Flow, Stop>> + 's>> {
        Box::pin(async move {
            // A node declaration in a body names a shape for the whole body,
            // as the checker hoists it; a resume, which enters past the
            // statements that already ran, finds it again here, or keeps the
            // one its park rebuilt.
            for statement in statements {
                if let Statement::Shape(shape) = statement
                    && scope.resolve_own(&shape.name).is_none()
                {
                    let declared = DeclaredShape { declaration: shape.clone(), file: scope.file_env() };
                    scope.declare(shape.name.clone(), Binding::Shape(Rc::new(ShapeBinding { declared, local: true, declared_in: Some(Rc::downgrade(scope)) })));
                }
            }
            let mut replay = Some(replay);
            for (index, statement) in statements.iter().enumerate().skip(from) {
                let at = address.stmt(index);
                // The cancel gate: a requested cancel stops the run at the
                // next statement boundary, never mid-statement.
                if self.ask_bool(host::control::cancelled(self.segment())).await.map_err(Stop::Thrown)? {
                    return Err(Stop::Cancelled);
                }
                // The statement is the site of the calls it makes.
                let site = crate::flow::Site::new(at.clone(), scope.clone(), replay.take().unwrap_or_default());
                self.call_sites.borrow_mut().push(site);
                let ran = self.statement_at(statement, scope, &at, &format!("{path}/{index}")).await;
                self.call_sites.borrow_mut().pop();
                let flow = ran?;
                // A flow a fork started keeps its trace until it joins.
                if !self.forked.get() {
                    self.publish_trace().await.map_err(Stop::Thrown)?;
                }
                if let Flow::Returned = flow {
                    return Ok(Flow::Returned);
                }
            }
            Ok(Flow::FellThrough)
        })
    }

    /// One statement inside its site: a paused run (its cap met here or
    /// before this segment) stops each flow before it, and so does a
    /// `suspendAt` address; the host refusing a priced call once the run has
    /// spent its cap means this statement was about to spend, so the flow
    /// suspends just before it, its finished calls journalled.
    async fn statement_at(&self, statement: &Statement, scope: &Rc<Scope>, at: &Address, path: &str) -> Result<Flow, Stop> {
        self.suspend_before(at, scope).await?;
        match self.statement(statement, scope, at, path).await {
            Err(Stop::Thrown(Failure::CapExceeded(cap))) => Err(self.suspend_at_limit(cap, at, scope).await),
            other => other,
        }
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
                self.match_record(&statement.r#match, None, scope, self.match_miss_policy()).await?;
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
            Statement::Refresh(statement) => {
                self.refresh(&statement.name, scope).await?;
                Ok(Flow::FellThrough)
            }
            Statement::Await(statement) => {
                self.awaiting(&statement.r#await.source, None, scope, at, &format!("{path}/await/source")).await?;
                Ok(Flow::FellThrough)
            }
            // Bare, the checker refuses it; still run, as the TypeScript runs it.
            Statement::Combinator(statement) => {
                self.combinator(&statement.combinator, None, scope, at, &format!("{path}/combinator")).await?;
                Ok(Flow::FellThrough)
            }
            // `return <value>`: the same right-hand side, bound into a slot
            // the grammar cannot spell, and the body ends.
            Statement::Return(ret) => {
                // `(f) => f()` (language version 5): the closure hands back
                // what the call returns — and, when it returns nothing,
                // nothing (`conciseCall`).
                if ret.concise
                    && let Some((call, call_path)) = self.concise_call(&ret.value, scope, path)
                {
                    return match self.call(&call, scope, at, &call_path).await? {
                        None => Ok(Flow::FellThrough),
                        Some(value) => {
                            scope.declare(RETURN_SLOT, value);
                            Ok(Flow::Returned)
                        }
                    };
                }
                self.assign(RETURN_SLOT, &ret.value, scope, at, path).await?;
                Ok(Flow::Returned)
            }
            Statement::Block(statement) => self.block(&statement.block, None, scope, at, path).await,
            // `ERROR(message)`: the run fails with the author's words.
            Statement::Error(statement) => {
                let message = self.evaluate_slot(&statement.message, scope).await?.value;
                Err(Stop::Thrown(Failure::engine("MOVENG_ERROR", failure_message(&message))))
            }
            // A collection op run for its function's effects.
            Statement::Collection(statement) => {
                self.collection(&statement.collection, None, scope, at, crate::collection::OpOrigin::Written(format!("{path}/collection"))).await?;
                Ok(Flow::FellThrough)
            }
            Statement::Call(call) if let Some(reading) = self.call_reading(call, scope)? => {
                match reading {
                    crate::collection::Reading::Collection(op) => {
                        self.collection(&op, None, scope, at, crate::collection::OpOrigin::Call { call: call.clone(), path: path.to_string() }).await?;
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
            Statement::Call(call) if self.calls_plugin(&call.callee, scope) => {
                self.plugin_call(&call.callee, &call.args, scope, at, path).await?;
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
            // Hoisted when the body was entered (`body_from`).
            Statement::Shape(_) => Ok(Flow::FellThrough),
            _ => Err(Stop::Thrown(Failure::unreproduced(
                "this statement",
                "the Rust engine runs bindings, writes, matches, links, unlinks, deletes, blocks, `if`, `sleep` and `return`",
            ))),
        }
    }

    /// `declareAssign`: `name = <right-hand side>`, `return` binding into
    /// the slot the grammar cannot spell. `path` is the statement's.
    pub(crate) async fn assign(&self, name: &str, value: &RValue, scope: &Rc<Scope>, at: &Address, path: &str) -> Result<(), Stop> {
        match value {
            RValue::Write { write } => {
                self.write(write, Some(name), scope, &format!("{path}/value/write")).await?;
            }
            RValue::Match { r#match } => {
                self.match_record(r#match, Some(name), scope, self.match_miss_policy()).await?;
            }
            RValue::Link { link } => self.link(link, Some(name), scope).await?,
            RValue::Block { block } => {
                self.block(block, Some(name), scope, at, &format!("{path}/value")).await?;
            }
            RValue::Node { node } => {
                let built = self.synthesise_node(node, scope, &format!("{path}/value/node")).await?;
                scope.declare(name, Binding::Node(built));
            }
            // Admission refused it (crate::admit::LEGACY_EXTRACTION): no run reaches here.
            RValue::Extract { .. } => return Err(Stop::Thrown(legacy_extraction())),
            // A call like any other: re-running its statement takes the
            // value it already extracted instead of paying for it again.
            RValue::ExtractCall { extract_call } => {
                let event = self.begin_call_event().await?;
                let extracted = match &event.replayed {
                    Some(replayed) => replayed.value.clone(),
                    None => {
                        let value = self.extract_call(extract_call, scope).await?;
                        self.finish_call(&event, Some(&value));
                        Some(value)
                    }
                };
                scope.declare(name, self.call_value("extract", extracted)?);
            }
            RValue::Collection { collection } => {
                self.collection(collection, Some(name), scope, at, crate::collection::OpOrigin::Written(format!("{path}/value/collection"))).await?;
            }
            RValue::Members { members } => self.members(members, Some(name), scope)?,
            RValue::Call { call } if let Some(reading) = self.call_reading(call, scope)? => match reading {
                crate::collection::Reading::Collection(op) => {
                    self.collection(&op, Some(name), scope, at, crate::collection::OpOrigin::Call { call: call.clone(), path: format!("{path}/value/call") }).await?;
                }
                crate::collection::Reading::Members(members) => self.members(&members, Some(name), scope)?,
            },
            // A plugin's name in a construction's spelling is its call
            // (`constructionAsCall`).
            RValue::Construct { construct } if self.calls_plugin(&construct.callee, scope) => {
                let args: Vec<ast::CallArg> = construct.args.iter().map(|a| ast::CallArg::Expr { name: Some(a.name.clone()), expr: a.value.clone() }).collect();
                let bound = self.plugin_call(&construct.callee, &args, scope, at, &format!("{path}/value/construct")).await?;
                scope.declare(name, bound);
            }
            RValue::Call { call } if self.calls_plugin(&call.callee, scope) => {
                let bound = self.plugin_call(&call.callee, &call.args, scope, at, &format!("{path}/value/call")).await?;
                scope.declare(name, bound);
            }
            // A function's name in a construction's spelling is a call too.
            RValue::Construct { construct } if self.calls_function(&construct.callee, scope) => {
                let call = ast::CallStatement {
                    callee: construct.callee.clone(),
                    args: construct.args.iter().map(|a| ast::CallArg::Expr { name: Some(a.name.clone()), expr: a.value.clone() }).collect(),
                    expression: None,
                    span: construct.span,
                };
                let value = self.call(&call, scope, at, &format!("{path}/value/construct")).await?;
                scope.declare(name, self.call_value(&call.callee, value)?);
            }
            RValue::Call { call } if self.calls_function(&call.callee, scope) => {
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
                let walk = self.defer_walk(&lazy.head, lazy.mapping.as_ref(), scope, &format!("{path}/value/lazy"));
                scope.declare(name, Binding::LazyWalk(walk));
            }
            RValue::Await { r#await } => self.awaiting(&r#await.source, Some(name), scope, at, &format!("{path}/value/await/source")).await?,
            RValue::Combinator { combinator } => self.combinator(combinator, Some(name), scope, at, &format!("{path}/value/combinator")).await?,
            RValue::Closure { closure } => {
                let bound = self.closure_binding(closure, Some(name), scope, &format!("{path}/value/closure"));
                scope.declare(name, bound);
            }
            RValue::Callback { callback } => {
                let minted = self.mint_callback(callback, scope, at, &format!("{path}/value/callback")).await?;
                scope.declare(name, minted);
            }
            _ => {
                let slot = self.value_slot(value, scope)?;
                let bound = self.bind_slot_binding(slot, scope).await?;
                scope.declare(name, bound);
            }
        }
        Ok(())
    }

    /// `conciseCall`: a concise body's call, when its callee is a function
    /// (a movement, a plugin or a closure), with its AST path; `None` for a
    /// construction or a built-in, which the ordinary `return` evaluates.
    fn concise_call(&self, value: &RValue, scope: &Scope, path: &str) -> Option<(ast::CallStatement, String)> {
        let (call, call_path) = match value {
            RValue::Call { call } => (call.clone(), format!("{path}/value/call")),
            RValue::Construct { construct } => (
                ast::CallStatement {
                    callee: construct.callee.clone(),
                    args: construct.args.iter().map(|a| ast::CallArg::Expr { name: Some(a.name.clone()), expr: a.value.clone() }).collect(),
                    expression: None,
                    span: construct.span,
                },
                format!("{path}/value/construct"),
            ),
            _ => return None,
        };
        let callable = matches!(scope.resolve(&self.callee_name(&call.callee, scope)), Some(Binding::Movement(_) | Binding::Plugin(_) | Binding::Closure(_)));
        callable.then_some((call, call_path))
    }

    /// `readCallIn`'s reading of a call of a collection op or `MEMBERS` (a
    /// built-in from version 3, when the program binds no such name).
    fn call_reading(&self, call: &ast::CallStatement, scope: &Scope) -> Result<Option<crate::collection::Reading>, Stop> {
        let binds = scope.resolve(&call.callee).is_some() || scope.resolve_function(&call.callee, self.version()).is_some();
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
        // Staged first, as `bindSlotValue` stages before `evaluateSlot`.
        if let Some((staged, scratch)) = self.staged(slot, scope).await? {
            return Box::pin(self.bind_slot_binding(&staged, &scratch)).await;
        }
        let expr = lowered(slot, |tree| movement_parser::lowering::lower_expression(tree, &slot.raw), "expression")
            .map_err(Stop::Thrown)?;
        if let Expression::Property { property_type_id: name, field_only: false } | Expression::AliasRef { name } = &expr
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
            Binding::Event
            | Binding::Handle(_)
            | Binding::Extracted { .. }
            | Binding::Landed(_)
            | Binding::Node(_)
            | Binding::LazyWalk(_)
            | Binding::Positions(_)
            | Binding::Tuple(_)
            | Binding::Closure(_)
            | Binding::Callback(_)
            | Binding::ShapePosition(_)
            | Binding::Resource(_) => true,
            Binding::Shape(_) => self.version() >= 3,
            Binding::Value(_) | Binding::Instance(_) | Binding::Movement(_) | Binding::Plugin(_) | Binding::Opaque { .. } => false,
        }
    }

    /// `bindSlotValue` for what this engine binds: the value the slot
    /// evaluates to, with its trail.
    async fn bind_slot(&self, slot: &ExprSlot, scope: &Rc<Scope>) -> Result<ValueBinding, Stop> {
        // A file-level value holding a nested call: this engine binds the
        // file's values before anything else, and stages none there.
        if self.version() >= 3
            && let Ok(tree) = movement_parser::expr::parse_expression(&slot.raw)
            && !crate::nested::staged_calls(&tree, &|call| self.runs_as_call(call, scope)).is_empty()
        {
            return Err(Stop::Thrown(Failure::unreproduced("a nested call in a file-level value", "the Rust engine stages nested calls in a body")));
        }
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
        // `-[:@old]->` is no system's edge: the evaluator answers it from the
        // handle, and the record it selects binds as itself.
        if matches!(scope.resolve(root), Some(Binding::Handle(_))) && crate::reading::starts_with_old_edge(steps) {
            return Ok(None);
        }
        // A root `graphReadFor` resolves no graph for (a node the run built,
        // a value): the fold of the walk, evaluated.
        let graph = match scope.resolve(root) {
            Some(Binding::Event | Binding::Landed(_) | Binding::Instance(_)) => true,
            // A handle that bound no record has no graph to read.
            Some(Binding::Handle(handle)) => !matches!(handle.record().get("externalId"), Js::Undefined),
            _ => false,
        };
        if !graph {
            return Ok(None);
        }
        let landings = self.selection_landings(root, steps, scope, slot).await?;
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
            Some(landed) => Binding::Landed(Rc::new(crate::bindings::Landed::new(landed.position().clone(), None, landed.read.clone()))),
            None => Binding::Value(ValueBinding { value: Js::Null, trail: Some(Trail::default()), many: false }),
        }))
    }

    /// `evaluateCondition`: the condition's conjuncts, each an expression's
    /// truthiness.
    pub(crate) async fn condition(&self, slot: &ExprSlot, scope: &Rc<Scope>) -> Result<bool, Stop> {
        // Staged first, as `evaluateCondition` stages it.
        if let Some(held) = self.staged_condition(slot, scope).await? {
            return Ok(held);
        }
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
                MovementCondition::IsTest { subject_raw, type_ } => self.is_test(subject_raw, type_, scope).await.map_err(Stop::Thrown),
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
        self.evaluate_with(expr, scope, span, subject, None).await
    }

    /// `evaluateMovementExpression` with `currentResource`: a `_resources`
    /// WHERE over one resource (`filterResources`).
    pub(crate) async fn evaluate_over_resource(&self, expr: &Expression, scope: &Rc<Scope>, span: Option<Js>, resource: &Js) -> Result<Evaluated, Stop> {
        let around = Surroundings { services: env_services::current(), now: Some(self.now_ms) };
        let reader = Reading { run: self, scope, span, subject: None, field: None, resource: Some(resource) };
        Evaluator::in_run(scope.as_ref(), self.version(), around, &reader).eval(expr).await.map_err(|error| {
            Stop::Thrown(Failure::of_eval(error, "the Rust engine does not reproduce it; run this movement on the TypeScript engine"))
        })
    }

    /// `evaluate_scoped`, as a write field's value when `field` names the
    /// functions that field advertises (`bindMovementFieldFunctions`).
    pub(crate) async fn evaluate_with(
        &self,
        expr: &Expression,
        scope: &Rc<Scope>,
        span: Option<Js>,
        subject: Option<Scoped>,
        field: Option<&crate::write::FieldFunctions>,
    ) -> Result<Evaluated, Stop> {
        let around = Surroundings { services: env_services::current(), now: Some(self.now_ms) };
        let scoped = subject.is_some();
        let reader = Reading { run: self, scope, span: span.clone(), subject, field, resource: None };
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
            Ask::ScopedField { field, edge, field_only } => match subject.expect("a scoped read is asked only of a scoped evaluation") {
                Scoped::Landed(landed) => self.scoped_field(landed, &field, crate::traverse::ScopedRead { edge, field_only }, scope).await.map(Ok),
                // Only a walked hop's record carries inline edge properties.
                // Over an in-memory edge (an extracted child, a node literal's
                // landing) an alias read is that record's own field, and from 5
                // a bare name is the variable it names, as everywhere else.
                Scoped::Emission(_) | Scoped::Binding(_) if edge && !field_only => match scope.resolve(&field) {
                    Some(Binding::Value(value)) if movement_parser::version::since(self.version(), 5) => {
                        Ok(Ok(Evaluated { value: value.value, prov: Prov::Built(value.trail.unwrap_or_default()) }))
                    }
                    _ => Ok(Err(EvalError::engine(
                        "MOVENG_UNSUPPORTED",
                        "edge-property reads outside a traversal WHERE is not supported by the movement engine yet (edge properties exist only on a walked hop)".into(),
                    ))),
                },
                Scoped::Emission(emission) => Ok(crate::write::emission_field(emission, &field)),
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
            // `case 'exists'` scoped: the landed record as a source position
            // with no read of its own (so walked through the run's source,
            // `cursor.read ?? ctx.source`), or the extracted entity.
            Ask::ScopedExists { expr } => {
                let Expression::Exists { steps, where_ } = &expr else { unreachable!("the evaluator asks for EXISTS only") };
                let subject = match subject.expect("a scoped read is asked only of a scoped evaluation") {
                    Scoped::Landed(landed) => {
                        let source = self.source.borrow().clone().expect("the event is seeded before the body runs");
                        Binding::Landed(Rc::new(crate::bindings::Landed::new(landed.position().clone(), None, source.read.clone())))
                    }
                    Scoped::Emission(emission) => Binding::Extracted { emission: emission.clone(), root: false, id: crate::bindings::Identity::new() },
                    Scoped::Binding(_) => return Ok(Err(crate::eval::rootless_exists())),
                };
                let span = span.cloned().unwrap_or(Js::Undefined);
                let found = self.exists(steps, where_.as_deref(), vec![subject], scope, &span).await?;
                Ok(Ok(Evaluated { value: Js::Bool(found), prov: Prov::Built(Trail::default()) }))
            }
            Ask::Within { left, right } => {
                let now = self.clock_now().await?;
                let value = Js::Bool(crate::filter::within(&left, &right, now));
                Ok(Ok(Evaluated { value, prov: Prov::Built(Trail::default()) }))
            }
            Ask::Meta { key } => {
                let value = self.meta_value(&key).await?;
                Ok(Ok(Evaluated { value, prov: Prov::Built(Trail::default()) }))
            }
            Ask::RenderFile { content, kind } => {
                let request = host::files::render(self.segment(), &content, &kind);
                let answer = self.ask(request).await?.unwrap_or(Json::Null);
                let value = self.wire.decode(&answer).map_err(|e| Failure::engine("MOVENG_RUNTIME", e))?;
                Ok(Ok(Evaluated { value, prov: Prov::Built(Trail::default()) }))
            }
            Ask::ReadFile { file } => self.read_file(&file).await.map(Ok),
            Ask::Ai { prompt, tier } => self.ai(&prompt, tier.as_deref()).await.map(|value| Ok(Evaluated { value, prov: Prov::Built(Trail::default()) })),
            // Asked only of a write field's evaluation, which answers it.
            Ask::FieldFunction { id, .. } => Err(Failure::engine("MOVENG_RUNTIME", format!("{id}() was asked of no write field"))),
        }
    }

    /// `READ(file)`'s host half: the text (its `file` origin minted, the
    /// trace's entry written), or undefined for a file with none.
    async fn read_file(&self, file: &Js) -> Result<Evaluated, Failure> {
        let answer = self.resolve_file_text(file).await?;
        let mut named = crate::trace::Members::default();
        for key in ["name", "contentType"] {
            let value = event_get(file, key);
            if !matches!(value, Js::Undefined) {
                named.set(key, value);
            }
        }
        if let Js::String(why) = event_get(&answer, "unreadable") {
            let mut entry = named;
            entry.set("unreadable", Js::String(why));
            let detail = event_get(&answer, "detail");
            if !matches!(detail, Js::Undefined) {
                entry.set("detail", detail);
            }
            self.trace.push(TraceEntry::Read(entry));
            return Ok(Evaluated { value: Js::Undefined, prov: Prov::Built(Trail::default()) });
        }
        let text = event_get(&answer, "text");
        let mut entry = named.clone();
        entry.set("chars", Js::Number(js::utf16_len(&text.to_js_string()) as f64));
        self.trace.push(TraceEntry::Read(entry));
        let mut origin = vec![("kind", Js::str("file"))];
        let raw_text_id = event_get(&answer, "rawTextId");
        if !matches!(raw_text_id, Js::Undefined) {
            origin.push(("rawTextId", raw_text_id));
        }
        if let Some(handle) = crate::extract::file_handle(file) {
            origin.push(("handle", Js::str(handle)));
        }
        for key in ["name", "contentType"] {
            let value = event_get(file, key);
            if !matches!(value, Js::Undefined) {
                origin.push((key, value));
            }
        }
        let id = self.mint_origin(env::object_of(origin));
        Ok(Evaluated { value: text, prov: Prov::Built(Trail { origins: vec![id], direct: Some(id) }) })
    }

    /// `evaluateAi`: one priced `llm.client.call` at the tier's settings,
    /// its reply read out of the structured envelope (`aiAnswer`), traced.
    async fn ai(&self, prompt: &str, tier: Option<&str>) -> Result<Js, Failure> {
        let settings = crate::extract::run::ai_expression_settings(tier);
        let call = host::llm::ClientCall {
            system: AI_EXPRESSION_SYSTEM,
            user_message: prompt,
            label: "movement-ai-expression",
            model: &settings.model,
            effort: settings.effort.as_deref(),
            max_tokens: settings.max_tokens,
        };
        let answer = self.priced(host::llm::client_call(self.segment(), call, self.ledger.budget())).await?;
        let value = ai_answer(&event_get(&answer, "parsedJson"));
        // The prompt's first 300 UTF-16 units: a cut through a pair keeps
        // its high half, as `slice` does.
        let traced = crate::extract::emission::cut(prompt, AI_TRACE_PROMPT_UNITS);
        self.trace.push(TraceEntry::Ai { prompt: traced, has_value: !value.is_nullish() });
        Ok(value)
    }

    /// `resolveMovementMetaKey` for the acting-user and raw-actor keys.
    async fn meta_value(&self, key: &str) -> Result<Js, Failure> {
        let nullish = |value: Js| if value.is_nullish() { Js::Null } else { value };
        match key {
            "user_email" | "user_name" | "user_id" => {
                let acting = self.acting_user().await?;
                if !acting.truthy() {
                    return Ok(Js::Null);
                }
                // `acting.principal.display`: a principal the host left out
                // throws JavaScript's TypeError (forgivable, as any).
                let principal = |field: &str| {
                    let principal = event_get(&acting, "principal");
                    crate::record::get(&principal, field).map_err(|error| Failure::of_eval(error, ""))
                };
                Ok(match key {
                    "user_email" => nullish(event_get(&acting, "email")),
                    "user_name" => nullish(principal("display")?),
                    _ => principal("id")?,
                })
            }
            _ => {
                let actor = self.actor().await?;
                if !actor.truthy() {
                    return Ok(Js::Null);
                }
                Ok(match key {
                    "actor_email" => {
                        let email = event_get(&actor, "email");
                        if !email.is_nullish() {
                            email
                        } else if crate::js::strict_equals(&event_get(&actor, "scheme"), &Js::str("email")) {
                            event_get(&actor, "identifier")
                        } else {
                            Js::Null
                        }
                    }
                    "actor_name" => {
                        let name = event_get(&actor, "name");
                        if !name.is_nullish() { name } else { nullish(event_get(&actor, "label")) }
                    }
                    _ => event_get(&actor, "identifier"),
                })
            }
        }
    }

    /// `resolveMovementActingUser`: asked of the host once per segment,
    /// through the source when it lists `getActorCandidates`; a throw is no
    /// user.
    async fn acting_user(&self) -> Result<Js, Failure> {
        if let Some(cached) = self.acting_user.borrow().clone() {
            return Ok(cached);
        }
        let source = self.source.borrow().clone();
        let resolved = match source {
            Some(source) if source.instance.has("getActorCandidates") => {
                let trigger = event_get(&self.event, "triggerEntryId");
                let trigger_id = trigger.truthy().then(|| trigger.to_js_string());
                let request = host::lookup::resolve_acting_user(self.segment(), trigger_id.as_deref(), &source.instance, self.encode(&self.event)?);
                match self.ask(request).await {
                    Ok(Some(user)) => self.wire.decode(&user).map_err(|e| Failure::engine("MOVENG_RUNTIME", e))?,
                    Ok(None) | Err(Failure::Host(_)) => Js::Null,
                    Err(other) => return Err(other),
                }
            }
            _ => Js::Null,
        };
        *self.acting_user.borrow_mut() = Some(resolved.clone());
        Ok(resolved)
    }

    /// `resolveMovementActor`: the source adapter's `extractActor` of the
    /// event, once per segment; a failure is no actor.
    async fn actor(&self) -> Result<Js, Failure> {
        if let Some(cached) = self.actor.borrow().clone() {
            return Ok(cached);
        }
        let source = self.source.borrow().clone();
        let resolved = match source {
            Some(source) if source.instance.has("extractActor") => {
                match self.call_adapter(&source.instance, "extractActor", env::object_of(vec![("event", self.event.clone())])).await {
                    Ok(actor) => actor,
                    Err(Failure::Host(_)) => Js::Null,
                    Err(other) => return Err(other),
                }
            }
            _ => Js::Null,
        };
        *self.actor.borrow_mut() = Some(resolved.clone());
        Ok(resolved)
    }

    /// `readSourcePositionField` on the event: the source adapter's
    /// `getFieldValue` through the surface-read wrapper, a `field_miss`
    /// traced for a field a raw payload does not carry, and the read's
    /// `source_field` origin.
    async fn event_field(&self, field: &str) -> Result<Evaluated, Failure> {
        let source = self.source.borrow().clone().expect("the event is seeded before the body runs");
        let seed = &source.position;
        // A file is what the catalog declares one (the read wrapper's
        // `filesAtType`, which the host applies): any other field's answer is
        // data, whatever its keys.
        let declared = crate::file::declared_field_type(source.read.schema.as_ref(), crate::traverse::record_type(&source.surface).as_deref(), field);
        let value = self.field_value_at(&source.instance, &source.surface, field, declared).await?;
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
            entries.push(("externalId", seed.record_id.clone().map_or(Js::Null, Js::str)));
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
    pub(crate) async fn sleep(&self, duration: &ast::DurationLiteral, at: &Address, scope: &Rc<Scope>, presence: Option<&str>) -> Result<(), Stop> {
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

    /// A log line the host names the run's team on, after `after` (where the
    /// TypeScript engine's line has it): the engine holds no team, so it
    /// says only where the host's goes.
    pub(crate) fn log_with_team(&self, level: &str, message: &str, fields: serde_json::Map<String, Json>, after: &str) {
        self.log_lines.borrow_mut().push(json!({ "level": level, "message": message, "fields": fields, "teamAfter": after }));
    }

    /// `adapters.resolve`, one request per distinct resolution per segment
    /// (`resolutionKey`: what it asks for, the construction args in any key
    /// order): a flow asking what another is already asking awaits its
    /// answer. A resolution that failed is not remembered.
    pub(crate) async fn resolve_adapter(&self, resolution: &ResolveAdapter) -> Result<Option<Json>, Failure> {
        let key = serde_json::to_string(&(
            &resolution.adapter_type,
            &resolution.credentials_id,
            &resolution.construction_args,
            resolution.role,
            resolution.dry_run,
        ))
        .expect("a resolution is JSON");
        let pending = self.resolutions.borrow().iter().find(|(k, _)| *k == key).map(|(_, shared)| shared.clone());
        if let Some(shared) = pending {
            return shared.wait().await;
        }
        let shared = Rc::new(crate::flow::Shared::default());
        self.resolutions.borrow_mut().push((key.clone(), shared.clone()));
        let answer = self.ask(host::adapters::resolve(self.segment(), resolution)).await;
        if answer.is_err() {
            self.resolutions.borrow_mut().retain(|(k, held)| !(*k == key && Rc::ptr_eq(held, &shared)));
        }
        shared.settle(answer.clone());
        answer
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

/// A write record with every citation of a write by number the ledger
/// holds renumbered (`WriteLedger.cite`): the record's own `origin`, and the
/// summarised origins (`{kind: 'write', write}`) its provenance cites.
fn renumber_citations(record: &Js, renumbered: &[usize]) -> Js {
    fn renumbered_as(value: &Js, renumbered: &[usize]) -> Js {
        match value {
            Js::Number(n) if *n >= 0.0 && n.fract() == 0.0 && (*n as usize) < renumbered.len() => Js::Number(renumbered[*n as usize] as f64),
            other => other.clone(),
        }
    }
    fn citation(origin: &Js, key: &str, renumbered: &[usize]) -> Js {
        let Js::Object(object) = origin else { return origin.clone() };
        if !matches!(object.get("kind"), Some(Js::String(kind)) if kind == "write") {
            return origin.clone();
        }
        let mut copy = JsObject::new();
        for (k, v) in object.entries() {
            copy.set(k.clone(), if k == key { renumbered_as(v, renumbered) } else { v.clone() });
        }
        Js::object(copy)
    }
    fn provenance(value: &Js, renumbered: &[usize]) -> Js {
        match value {
            Js::Object(object) if matches!(object.get("kind"), Some(Js::String(kind)) if kind == "write") => citation(value, "write", renumbered),
            Js::Object(object) => {
                let mut copy = JsObject::new();
                for (k, v) in object.entries() {
                    copy.set(k.clone(), provenance(v, renumbered));
                }
                Js::object(copy)
            }
            Js::Array(list) => Js::array(list.items().iter().map(|v| provenance(v, renumbered)).collect()),
            other => other.clone(),
        }
    }
    let Js::Object(object) = record else { return record.clone() };
    let mut copy = JsObject::new();
    for (k, v) in object.entries() {
        let value = match k.as_str() {
            "origin" => citation(v, "writeIndex", renumbered),
            "provenance" => provenance(v, renumbered),
            _ => v.clone(),
        };
        copy.set(k.clone(), value);
    }
    Js::object(copy)
}

/// `bindsManyValues`: a walk read for a field, or a second name for one.
fn binds_many_values(expr: &Expression, scope: &Scope) -> bool {
    match expr {
        Expression::Traverse { steps, expression, .. } if !steps.is_empty() => match expression.as_ref() {
            Expression::Property { property_type_id, .. } => property_type_id != movement_parser::lowering::POSITION_SENTINEL,
            Expression::EdgeProperty { .. } => true,
            _ => false,
        },
        Expression::Property { property_type_id: name, field_only: false } | Expression::AliasRef { name } => scope.value_of(name).is_some_and(|b| b.many),
        _ => false,
    }
}

/// A plugin call's named arguments; admission lets by no other kind.
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
    /// The functions the write field this is the value of advertises.
    field: Option<&'r crate::write::FieldFunctions>,
    /// The resource a `_resources` WHERE is evaluated over
    /// (`currentResource`).
    resource: Option<&'r Js>,
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
        Box::pin(async move {
            if let (Ask::FieldFunction { id, args }, Some(field)) = (&ask, self.field) {
                let value = self.run.field_function(field, id, args).await.map_err(Failure::into_eval)??;
                return Ok(Evaluated { value, prov: Prov::Built(Trail::default()) });
            }
            self.run.answer(ask, self.scope, self.subject.as_ref(), self.span.as_ref()).await.map_err(Failure::into_eval)?
        })
    }

    fn field_function(&self, id: &str) -> bool {
        self.field.is_some_and(|field| field.has(id))
    }

    fn trace(&self, entry: TraceEntry) {
        self.run.trace.push(entry);
    }

    fn resource_field(&self, field: &str) -> Option<Evaluated> {
        Some(match self.resource {
            Some(resource) => self.run.resource_field(resource, field),
            None => Evaluated { value: Js::Null, prov: Prov::Built(Trail::default()) },
        })
    }

    fn ai_origin(&self, prompt: &str, inputs: &[u32]) -> u32 {
        let inputs = inputs.iter().map(|&id| self.run.origin(id)).collect();
        self.run.mint_origin(env::object_of(vec![("kind", Js::str("ai")), ("prompt", Js::str(prompt)), ("inputs", Js::array(inputs))]))
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

// ── The event seed (run.ts) ─────────────────────────────────────────────────

fn event_text(event: &Js, key: &str) -> Option<String> {
    match event_get(event, key) {
        Js::String(text) => Some(text.into_string()),
        _ => None,
    }
}

/// `spellValueType`: a written value type in its surface spelling.
fn spell_value_type(value: &ast::ValueType) -> String {
    match value {
        ast::ValueType::Name { name, .. } => name.clone(),
        ast::ValueType::List { of, .. } => match **of {
            ast::ValueType::Closure { .. } => format!("<{}>[]", spell_value_type(of)),
            _ => format!("{}[]", spell_value_type(of)),
        },
        ast::ValueType::Record { keys, .. } => format!(
            "{{ {} }}",
            keys.iter().map(|k| format!("{}{}: {}", k.name, if k.optional == Some(true) { "?" } else { "" }, spell_value_type(&k.type_))).collect::<Vec<_>>().join(", ")
        ),
        ast::ValueType::Closure { params, returns, .. } => format!(
            "({}) => <{}>",
            params
                .iter()
                .map(|p| format!("{}: <{}>", p.name, p.type_.as_ref().map_or_else(|| "?".to_string(), spell_param_type)))
                .collect::<Vec<_>>()
                .join(", "),
            spell_param_type(returns)
        ),
    }
}

/// `spellParamType`: a parameter's written type in its surface spelling.
fn spell_param_type(type_: &ast::ParamTypeRef) -> String {
    match type_ {
        ast::ParamTypeRef::Value(value) => spell_value_type(value),
        ast::ParamTypeRef::Name(name) => format!("{}{}", name.graph, name.hops_raw.as_deref().unwrap_or("")),
    }
}

/// `fileLevelCall`: a call written at file scope, which has no event to be
/// about.
fn file_level_call() -> Failure {
    Failure::unsupported("file-level calls", "a call runs inside a movement body, where the event is in scope")
}

/// How much of an `AI()` prompt its trace entry keeps, in UTF-16 units.
const AI_TRACE_PROMPT_UNITS: usize = 300;

/// `AI_EXPRESSION_SYSTEM`, the system prompt every `AI()` call carries.
const AI_EXPRESSION_SYSTEM: &str = "You are evaluating an AI() expression inside a data-movement program.\n\
The user message is the program author's prompt. Answer it directly and\n\
concisely — the answer becomes a field value, so no preamble and no markdown.\n\
Respond with a JSON object of the shape\n\
{\"value\": <your answer as a string, or null>, \"has_value\": <boolean>}.\n\
If the prompt has no meaningful answer — nothing applies, nothing is\n\
needed, the requested thing is absent — set \"has_value\": false and\n\
\"value\": null. Never answer with placeholder text like \"none\" or \"N/A\".";

/// `aiAnswer`: the envelope's value (null when the model said it has none),
/// else the older `{answer}` shape, else the reply itself; made text, a
/// blank answer read as none (`blankIsAbsent`).
fn ai_answer(parsed: &Js) -> Js {
    let is_object = matches!(parsed, Js::Object(_) | Js::Array(_));
    let has = |key: &str| matches!(parsed, Js::Object(object) if object.get(key).is_some());
    let answer = if is_object && has("has_value") {
        if crate::js::strict_equals(&event_get(parsed, "has_value"), &Js::Bool(false)) {
            return Js::Null;
        }
        event_get(parsed, "value")
    } else if is_object && has("answer") {
        event_get(parsed, "answer")
    } else {
        parsed.clone()
    };
    if answer.is_nullish() {
        return Js::Null;
    }
    let text = if matches!(answer, Js::Object(_) | Js::Array(_)) { js::json_stringify(&answer, 0) } else { answer.to_js_string() };
    if js::trim(&text).is_empty() { Js::Null } else { Js::str(text) }
}

fn event_get(value: &Js, key: &str) -> Js {
    match value {
        Js::Object(object) => object.get(key).cloned().unwrap_or(Js::Undefined),
        Js::File(file) => file.display.get(key).cloned().unwrap_or(Js::Undefined),
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
        Js::String(value) if !value.is_empty() => Some(value.into_string()),
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
    pins.sort_by(|(a, _), (b, _)| a.cmp(b));
    crate::js_string::to_json_text(&json!([address.event, pins]))
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


/// `fail(message)`'s words, as the run fails with them: a text as written,
/// nothing as nothing, anything else as JavaScript writes it.
pub(crate) fn failure_message(message: &Js) -> String {
    match message {
        Js::String(text) => text.clone().into_string(),
        other if other.is_nullish() => String::new(),
        other => other.to_js_string(),
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

    /// A segment's input, its event an email webhook with `payload`.
    fn segment_input(source: &str, payload: Json, serves: &[&str]) -> Json {
        json!({
            "entry": "segment", "source": source, "languageVersion": 3, "segmentId": "g1", "serves": serves,
            "now": "2026-03-12T12:00:00.000Z",
            "event": env::encode_plain(&env::decode(&json!(["o", 0, [
                ["pipelineInputId", "p"], ["adapterType", "email"], ["triggerType", "webhook"], ["payload", payload],
            ]])).unwrap()),
            "catalog": serde_json::from_str::<Json>(CATALOG).unwrap(),
        })
    }

    /// `drive`, for a host that serves the optional methods `serves`.
    fn drive_serving(source: &str, payload: Json, serves: &[&str], serve: impl Fn(&PendingRequest) -> Json) -> (Json, Vec<PendingRequest>) {
        drive_input(segment_input(source, payload, serves), serve)
    }

    /// A segment of `input` driven to its end.
    fn drive_input(input: Json, serve: impl Fn(&PendingRequest) -> Json) -> (Json, Vec<PendingRequest>) {
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
                match payload.get(field.as_form()) {
                    Some(value) => json!({ "value": { "result": value } }),
                    None => json!({ "value": {} }),
                }
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    /// A run that ends in this engine's own refusal (met after an effect)
    /// says so on its `done`, apart from the TypeScript's own
    /// MOVENG_UNSUPPORTED, which this engine mirrors and the wire codes the
    /// same.
    #[test]
    fn an_unreproduced_ending_is_marked_apart_from_a_mirrored_one() {
        let own = Failure::unreproduced("a bound write", "the Rust engine runs identity writes");
        let mirrored = Failure::unsupported("DOMAIN_OF", "");
        assert_eq!(own.to_json()["code"], mirrored.to_json()["code"]);
        assert_eq!(own.marked(json!({ "thrown": own.to_json() }))["unreproduced"], json!(true));
        let failed = own.marked(json!({ "failed": { "error": own.to_json(), "result": {} } }));
        assert_eq!(failed["unreproduced"], json!(true));
        assert_eq!(mirrored.marked(json!({ "thrown": mirrored.to_json() })).get("unreproduced"), None);
    }

    /// The pinned instant with no offset is UTC, whatever zone the host
    /// names (a `localZone` is not read from version 5): 00:30 on 15 July is
    /// the 15th.
    #[test]
    fn the_pinned_instant_with_no_offset_is_utc() {
        let source = "import { email } from adapters\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {\n  day = DATE.TODAY(\"UTC\")\n  if day == \"2026-07-15\" {\n    s = msg.`subject`\n  }\n}";
        let mut input = segment_input(source, json!(["o", 1, [["subject", "Hi"]]]), &[]);
        input["now"] = json!("2026-07-15T00:30");
        input["localZone"] = json!("America/Los_Angeles");
        let (done, seen) = drive_input(input, plain_host(json!({ "subject": "Hi" })));
        assert!(done.get("result").is_some(), "{done}");
        assert!(seen.iter().any(|r| r.family == "adapters" && r.method == "call"));
    }

    /// With `nativeCheck` the Rust checker answers `check.program`: the host
    /// is never asked, a clean program runs, and one it refuses ends with
    /// MOVENG_CHECK before any request at all.
    #[test]
    fn a_native_check_answers_in_place_of_the_host() {
        let source = "import { email } from adapters\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {\n  s = msg.`subject`\n}";
        let mut input = segment_input(source, json!(["o", 1, [["subject", "Hi"]]]), &[]);
        input["nativeCheck"] = json!(true);
        let (done, seen) = drive_input(input.clone(), plain_host(json!({ "subject": "Hi" })));
        assert!(done.get("result").is_some(), "{done}");
        assert!(seen.iter().all(|r| r.family != "check"), "{seen:?}");
        input["source"] = json!(source.replace("msg.`subject`", "nowhere"));
        let (done, seen) = drive_input(input.clone(), plain_host(json!({ "subject": "Hi" })));
        assert!(seen.is_empty(), "{seen:?}");
        assert!(done.to_string().contains("MOVENG_CHECK") && done.to_string().contains("MOV_NAME_UNRESOLVED"), "{done}");
        // A source the parser refuses ends at the check too, with its parse
        // error, and the host is asked nothing.
        input["source"] = json!(source.replace("movement m(", "movement m(("));
        let (done, seen) = drive_input(input, plain_host(json!({ "subject": "Hi" })));
        assert!(seen.is_empty(), "{seen:?}");
        assert!(done.to_string().contains("MOVENG_PARSE") && done.to_string().contains("(line 3, col"), "{done}");
    }

    /// A null test of a credential reads it, and is refused as every other
    /// read of one is, on every version, with the TypeScript engine's error
    /// (`presenceCompare` there); another import is still present by being
    /// bound. The checker refuses the program first; this is the engine's own
    /// line behind it.
    #[test]
    fn a_null_test_of_a_credential_is_refused_not_answered() {
        for version in 1..=5 {
            for test in ["acme == null", "acme != null"] {
                let source = format!("import {{ email }} from adapters\nimport {{ acme }} from credentials\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {{\n  if {test} {{ return 1 }}\n  return 2\n}}");
                let mut input = segment_input(&source, json!(["o", 1, []]), &[]);
                input["languageVersion"] = json!(version);
                let (done, _) = drive_input(input, plain_host(json!({})));
                let error = if done.get("thrown").is_some() { &done["thrown"] } else { &done["failed"]["error"] };
                assert_eq!(error["code"], json!("MOVENG_UNSUPPORTED"), "v{version} {test}: {done}");
                assert_eq!(error["message"], json!("reading 'acme' (an import) as a bare value is not supported by the movement engine yet"), "v{version} {test}: {done}");
            }
            let source = "import { email, attio } from adapters\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {\n  if attio != null {\n    ERROR(\"present\")\n  }\n}";
            let mut input = segment_input(source, json!(["o", 1, []]), &[]);
            input["languageVersion"] = json!(version);
            let (done, _) = drive_input(input, plain_host(json!({})));
            let message = done["thrown"]["message"].as_str().or_else(|| done["failed"]["error"]["message"].as_str()).unwrap_or_default();
            assert!(message.contains("present"), "v{version}: {done}");
        }
    }

    /// A credential import parks as any import does, as the TypeScript
    /// engine writes it: its mark is re-derived on resume from the re-parsed
    /// import, never stored.
    #[test]
    fn a_credential_import_parks_as_any_import_does() {
        let source = "import { email } from adapters\nimport { acme } from credentials\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {\n  await sleep(1h)\n}";
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
        let state = env::json_of_js(&env::decode(&park.args["state"]).unwrap());
        let file = &state["scopeChain"][0]["bindings"];
        assert_eq!(file["acme"], json!({ "kind": "opaque", "what": "import", "name": "acme" }));
        assert_eq!(file["email"], json!({ "kind": "opaque", "what": "import", "name": "email" }));
    }

    const SLEEPS: &str = "import { email } from adapters\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {\n  await sleep(1h)\n}";

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
        let refused = format!("{prelude}movement m(msg: <inbox-[:message]->>) {{\n  x = @trigger\n  helper(e: msg)\n}}\n{helper}");
        match first_step(&refused) {
            Step::Done(done) => {
                assert_eq!(done, json!({ "refused": "meta:trigger", "reasons": ["meta:trigger", "plugin_call"] }))
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

    /// An extraction call whose written `model` meets a run input that carries
    /// no `models` list is declined `unreproduced` (README `extract_call_model`): the
    /// TypeScript would ask the model registry, which this engine does not
    /// hold. The call is refused before the model is asked anything, handed
    /// back as `unreproduced`.
    #[test]
    fn an_extraction_call_with_a_model_and_no_model_list_is_declined_unreproduced() {
        let source = "import { email } from adapters\ninbox = email()\nnode Company: \"each company named in this message\" {\n  name: <text> \"the company's name\"\n}\nmovement m(msg: <inbox-[:message]->>) {\n  found = extract([msg.`text`], Company, { model: 'claude-opus-5' })\n  write crm-[:notes]-> { body: \"${COUNT(found)}\" }\n}";
        let host = plain_host(json!({ "text": "Acme raised." }));
        let (done, seen) = drive(source, json!(["o", 1, [["text", "Acme raised."]]]), |request| match (request.family, request.method.as_str()) {
            ("ids", "mint") => json!({ "value": ["id-1"] }),
            ("clock", "now") => json!({ "value": { "nowIso": "2026-10-09T12:00:00.000Z" } }),
            ("llm.client" | "llm.extractCall", _) => panic!("the model is never asked: {request:?}"),
            _ => host(request),
        });
        // Nothing the host can see had happened (the call is the first effect),
        // so the segment is handed back to the TypeScript engine as
        // `unreproduced`, rather than ending the run in a marked failure.
        assert_eq!(done, json!({ "declined": "unreproduced" }));
        assert!(seen.iter().all(|r| !r.family.starts_with("llm")), "{seen:?}");
    }

    /// The extraction keyword is refused by name before anything runs, on
    /// every version: its host is asked nothing.
    #[test]
    fn the_extraction_keyword_is_refused_by_name_and_asks_nothing() {
        let source = "import { email } from adapters\ninbox = email()\nmovement m(msg: <inbox-[:message]->>) {\n  deals = extract from [msg.`text`] {\n    digest: \"a summary\"\n  }\n}";
        let host = plain_host(json!({ "text": "Acme raised." }));
        let (done, seen) = drive(source, json!(["o", 1, [["text", "Acme raised."]]]), host);
        assert_eq!(done["refused"], json!(crate::admit::LEGACY_EXTRACTION), "{done}");
        assert!(seen.is_empty(), "{seen:?}");
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
            (json!({ "version": 1, "address": "s0", "suspended": false }), "resume_state_suspended"),
            (json!({ "version": 2, "address": "s0" }), "resume_state_version"),
            (json!({ "version": 1, "address": "s0", "scopeChain": scope(json!({ "kind": "blockMeta", "edges": [] })) }), "resume_state_kind:blockMeta"),
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

    /// A declared shape travels by name and is re-resolved from the program's
    /// file scope wherever the state holds it; one declared in a body travels
    /// as its declaration's tree (serialize.ts `localShape`), rebuilt from it.
    #[test]
    fn a_shape_is_resumed_by_name_or_by_its_declaration() {
        let state = |file: Json, body: Json| {
            json!({ "version": 1, "address": "s0", "bindingName": null, "scopeChain": [{ "bindings": file }, { "bindings": body }] })
        };
        let shape = json!({ "kind": "shape", "name": "Lead" });
        assert_eq!(crate::park::resume_refusal(&wire(state(json!({ "Lead": shape }), json!({})))), None);
        assert_eq!(crate::park::resume_refusal(&wire(state(json!({}), json!({ "Lead": shape })))), None);
        // A shape declared in a body rides as its declaration's tree, and one
        // that does not read as a declaration is refused by name.
        let declared = crate::program::parse("movement m() {\n  node Tag {\n    label: <text>\n  }\n}", 3).unwrap();
        let declaration = declared.tree.pointer("/statements/0/body/0").cloned().unwrap();
        let local = json!({ "kind": "localShape", "declaration": declaration });
        assert_eq!(crate::park::resume_refusal(&wire(state(json!({}), json!({ "Tag": local })))), None);
        let partial = json!({ "kind": "localShape", "declaration": { "kind": "shape", "name": "Tag" } });
        assert_eq!(crate::park::resume_refusal(&wire(state(json!({}), json!({ "Tag": partial })))), Some("resume_state_code_does_not_read".into()));
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
        assert_eq!(done["failed"]["error"]["message"], json!("the parked state holds a handle descriptor without its record"));
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

    /// A date-typed event field runs (Henry's ruling, PLAN-08A group F′):
    /// the host hands the engine its ISO text, never a `Date`, so nothing
    /// is declined after the check, and the version warning is traced.
    #[test]
    fn a_dated_read_runs_past_the_check() {
        let deprecated = json!({
            "diagnostics": [{ "code": "MOV_LANGUAGE_VERSION_DEPRECATED", "message": "old" }],
            "stamps": [],
            "versionWarning": { "code": "MOV_LANGUAGE_VERSION_DEPRECATED", "message": "old" },
        });
        let source = "import { email, attio } from adapters\ninbox = email()\ncrm = attio()\nmovement m(msg: <inbox-[:message]->>) {\n  write crm-[:companies]-> { name: msg.`when` }\n}";
        let (_, seen) = dated_run(source, deprecated);
        assert_eq!(seen[1], "adapters.resolve");
        let source = "import { email, attio } from adapters\ninbox = email()\ncrm = attio()\nmovement m(msg: <inbox-[:message]->>) {\n  write crm-[:companies]-> { ...msg }\n}";
        let stamp = json!({ "diagnostics": [], "stamps": [{ "path": "/statements/3/body/0/write/spreads/0", "spreadFields": ["subject", "when"] }] });
        let (_, seen) = dated_run(source, stamp);
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
