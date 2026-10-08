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
//!    writes (crate::write), node and graph literals (crate::node), body
//!    constructions, `sleep` (a park: crate::park) — or, resuming, the parked
//!    leaf's continuation;
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
use movement_parser::lowering::expression::Expression;
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
use crate::stdlib::{self, Surroundings};
use crate::trace::{FlowTrace, TraceEntry};
use crate::{env_services, js_date};

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
    /// before a call (`… .c k`) is never reached: this engine runs no calls.
    #[serde(default)]
    pub suspend_at: Vec<String>,
}

/// The segment entry: the run, and its `done`.
pub async fn segment(host: Host, input: SegmentInput) -> Json {
    let ledger = crate::ledger::Ledger::new(&input.spend);
    let mut done = match run(&host, &input, &ledger).await {
        Ok(result) => json!({ "result": result }),
        Err(Stop::Refused(reason)) => return json!({ "refused": reason }),
        Err(Stop::Declined(reason)) => return json!({ "declined": reason }),
        Err(Stop::Thrown(failure)) => json!({ "thrown": failure.to_json() }),
        Err(Stop::Failed(failure, result)) => json!({ "failed": { "error": failure.to_json(), "result": result } }),
        Err(Stop::Cancelled | Stop::Parked(_)) => unreachable!("a cancel or a park ends the body, and the run returns its result"),
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
    /// Not admitted: nothing but the parse and the walk happened.
    Refused(String),
    /// Past admission, before any host-visible effect.
    Declined(String),
    Thrown(Failure),
    /// The body failed; the result so far rides with it.
    Failed(Failure, Json),
    /// The cancel gate said so at a statement boundary (`RunCancelledSignal`).
    Cancelled,
    /// The flow parked at this address (`RunParked`): its state is durable.
    Parked(String),
}

#[derive(Debug, Clone)]
pub(crate) enum Failure {
    Engine { class: ErrorClass, message: String },
    Host(HostError),
    /// The run met its cost cap (`RunCostCapExceeded`): the statement
    /// suspends where it can, and fails the run where it cannot.
    CapExceeded(crate::ledger::CapExceeded),
}

impl Failure {
    pub(crate) fn engine(code: &'static str, message: String) -> Failure {
        Failure::Engine { class: ErrorClass::Engine(code), message }
    }

    pub(crate) fn unsupported(construct: &str, detail: &str) -> Failure {
        Failure::engine("MOVENG_UNSUPPORTED", format!("{construct} is not supported by the movement engine yet ({detail})"))
    }

    /// The failure as an evaluation carries it out of a read it awaited.
    pub(crate) fn into_eval(self) -> EvalError {
        match self {
            Failure::Engine { class, message } => EvalError::Thrown { class, message },
            Failure::Host(error) => EvalError::Host(error),
            Failure::CapExceeded(cap) => EvalError::CapExceeded(cap),
        }
    }

    /// What an evaluation failed with; a reading this engine hands back
    /// fails the run, `unreproduced` saying so.
    pub(crate) fn of_eval(error: EvalError, unreproduced: &str) -> Failure {
        match error {
            EvalError::Thrown { class, message } => Failure::Engine { class, message },
            EvalError::Host(error) => Failure::Host(error),
            EvalError::CapExceeded(cap) => Failure::CapExceeded(cap),
            EvalError::Fallback(reason) => Failure::unsupported(&format!("this reading ({reason})"), unreproduced),
        }
    }

    fn to_json(&self) -> Json {
        match self {
            Failure::Engine { class: ErrorClass::Engine(code), message } => {
                json!({ "class": "MovementEngineError", "code": code, "message": message })
            }
            Failure::Engine { class: ErrorClass::Error, message } => json!({ "class": "Error", "message": message }),
            Failure::Engine { class: ErrorClass::RangeError, message } => json!({ "class": "RangeError", "message": message }),
            Failure::Host(error) => json!({ "hostError": error.detail.get("ref").cloned().unwrap_or(Json::Null) }),
            Failure::CapExceeded(cap) => cap.to_json(),
        }
    }
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
    /// The parameter's declared position, which names a typeless root.
    pub(crate) start_surface_type: Option<String>,
    pub(crate) position: Position,
}

/// A lexical address (address.ts): `s1.b0.s2`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Address(Vec<(char, usize)>);

impl Address {
    pub fn stmt(&self, index: usize) -> Address {
        self.child('s', index)
    }

    pub fn branch(&self, index: usize) -> Address {
        self.child('b', index)
    }

    fn child(&self, kind: char, index: usize) -> Address {
        let mut steps = self.0.clone();
        steps.push((kind, index));
        Address(steps)
    }

    /// `encodeAddress`.
    pub fn encode(&self) -> String {
        self.0.iter().map(|(kind, index)| format!("{kind}{index}")).collect::<Vec<_>>().join(".")
    }
}

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
    /// The park sink answered that it cannot suspend (it has no
    /// `commitSuspension`): run.ts `canSuspend` is false for the run.
    pub(crate) cannot_suspend: std::cell::Cell<bool>,
}

async fn run(host: &Host, input: &SegmentInput, ledger: &crate::ledger::Ledger) -> Result<Json, Stop> {
    let version = input.language_version;
    // Admission first, on this engine's own parse: a program (or a parked
    // state) it does not run costs no catalog load, no check, no request.
    let root = program::parse(&input.source, version).map_err(|_| Stop::Refused("source_does_not_parse".into()))?;
    if let Some(reason) = crate::admit::refusal(&root.program, version) {
        return Err(Stop::Refused(reason));
    }
    if let Some(resume) = &input.resume
        && let Some(reason) = crate::park::resume_refusal(&resume.state)
    {
        return Err(Stop::Refused(reason));
    }
    let catalog = CatalogSnapshot::load(input.catalog.get()).map_err(|_| Stop::Declined("catalog_does_not_load".into()))?;
    let event = env::decode(&input.event).map_err(|_| Stop::Declined("event_does_not_read".into()))?;
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
        cannot_suspend: std::cell::Cell::default(),
    };
    // What the check's stamps say this engine does not run is declined
    // before every host-visible effect, the version warning's trace entry
    // among them.
    if let Some(reason) = run.stamp_decline() {
        return Err(Stop::Declined(reason.into()));
    }
    // A deprecated pin runs, and says so on the run's own record (the check's
    // version diagnostic; an unsupported one never got an answer).
    let version_warning = run.checked.diagnostics.iter().find_map(|d| {
        let code = d.get("code")?.as_str()?;
        let message = d.get("message")?.as_str()?;
        code.starts_with("MOV_LANGUAGE_VERSION_").then(|| (code.to_string(), message.to_string()))
    });
    if let Some((code, message)) = version_warning {
        run.trace(TraceEntry::Warning { code, message });
    }
    let outcome = run.execute().await;
    // What the segment traced after its last statement's hand-over (a park,
    // a failure, a body that never ran). The TypeScript hands it over as its
    // segment closes, where a failure to is logged and never the run's
    // (run_context.ts `closeRunContext`); so it is not this run's either:
    // the shim logs it.
    let _ = run.hand_over_trace(true).await;
    outcome
}

impl Run<'_> {
    pub(crate) fn version(&self) -> u32 {
        self.input.language_version
    }

    /// The segment every host request names.
    pub(crate) fn segment(&self) -> &str {
        &self.input.segment_id
    }

    /// The credential id the run was handed for `name`, if any.
    pub(crate) fn credential_id(&self, name: &str) -> Option<String> {
        self.input.credential_ids.get(name).cloned()
    }

    /// `assembleResult`: the writes cross on the eval wire, as the records
    /// the TypeScript builds.
    fn result(&self, cancelled: bool, parked: Option<&str>) -> Json {
        let writes: Vec<Js> = self.writes.borrow().iter().map(|w| w.object.clone()).collect();
        let mut result = json!({ "movementName": *self.movement_name.borrow(), "writes": env::encode_plain(&Js::array(writes)) });
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
            Ok(()) => (false, None),
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
        for statement in deferred {
            self.file_statement(statement, &file);
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
        let movement_scope = file.child();
        movement_scope.declare(param.name.clone(), Binding::Event);
        Ok((movement, index, movement_scope))
    }

    /// What the checker's stamps on the dispatched movement say this engine
    /// does not run, found with no effect:
    ///
    /// - `graph_copy_walks_edges`: a graph's record spread whose copy plan
    ///   walks the record's edges (node.rs copies fields);
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
        let index = statements.iter().position(|s| matches!(s, Statement::Movement(m) if std::ptr::eq(m, movement)))?;
        let prefix = format!("/statements/{index}/");
        let walks_edges = self.checked.root.stamps.iter().any(|(path, stamp)| {
            path.starts_with(&prefix)
                && matches!(stamp, Stamp::Copy(plan) if plan.get("edges").and_then(Json::as_object).is_some_and(|edges| !edges.is_empty()))
        });
        if walks_edges {
            return Some("graph_copy_walks_edges");
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
        let text = serde_json::to_string(&movement.body).unwrap_or_default();
        event_fields_read(&text, &param.name, &mut |field| read.push(field.to_string()));
        // `...msg` in a write: the lines the checker's stamp says it writes.
        for (path, stamp) in &self.checked.root.stamps {
            if let Stamp::SpreadFields(fields) = stamp
                && path.starts_with(&prefix)
                && self.checked.root.tree.pointer(path).and_then(|n| n.get("source")).and_then(Json::as_str) == Some(param.name.as_str())
            {
                read.extend(fields.iter().cloned());
            }
        }
        read.iter().any(|field| dated(field)).then_some("event_field_dated")
    }

    fn select_movement<'m>(&self, movements: &[&'m MovementDeclaration]) -> Result<&'m MovementDeclaration, Stop> {
        let wanted = self.input.movement_name.as_deref().filter(|w| !w.is_empty());
        let found = match wanted {
            Some(wanted) => movements.iter().find(|m| m.name == wanted).or_else(|| {
                // From version 3 the fired name is a function's, in any case.
                (self.version() >= 3)
                    .then(|| movements.iter().find(|m| m.name.to_lowercase() == wanted.to_lowercase()))
                    .flatten()
            }),
            None if movements.len() == 1 => movements.first(),
            None => None,
        };
        found.copied().ok_or_else(|| {
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
    /// (admission refused the rest).
    fn file_statement(&self, statement: &Statement, file: &Scope) {
        match statement {
            Statement::Import(import) => {
                for name in &import.names {
                    if let Some(alias) = &name.alias {
                        self.import_originals.borrow_mut().push((alias.clone(), name.name.clone()));
                    }
                    file.declare(name.alias.clone().unwrap_or_else(|| name.name.clone()), Binding::Opaque);
                }
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
                adapter_type: instance.adapter_slug.clone(),
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
        *self.source.borrow_mut() = Some(Rc::new(Source {
            instance: handle,
            adapter_type,
            instance_name: instance.name.clone(),
            start_surface_type: type_ref.position.clone(),
            position,
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
            Some(Js::Array(list)) => list.items.iter().find_map(|entry| {
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
                let flow = match self.statement(statement, scope, &at, &format!("{path}/{index}")).await {
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
                match &assign.value {
                    RValue::Write { write } => {
                        self.write(write, Some(&assign.name), scope, &format!("{path}/value/write")).await?;
                    }
                    RValue::Node { node } => {
                        let built = self.synthesise_node(node, scope, &format!("{path}/value/node")).await?;
                        scope.declare(assign.name.clone(), Binding::Node(built));
                    }
                    // An instance constructed in a body, as at file scope; a
                    // movement's name in that spelling is a call.
                    RValue::Construct { construct } => {
                        if matches!(scope.resolve(&construct.callee), Some(Binding::Movement(_))) {
                            return Err(Stop::Thrown(Failure::unsupported("a call", "the Rust engine runs no calls yet")));
                        }
                        let instance = self.instance_binding(&assign.name, construct);
                        scope.declare(assign.name.clone(), Binding::Instance(Rc::new(instance)));
                    }
                    RValue::Await { r#await } => match &r#await.source {
                        AwaitSource::Sleep { duration, .. } => {
                            self.sleep(duration, at, scope, Some(&assign.name)).await?;
                            scope.declare(assign.name.clone(), Binding::Value(env::ValueBinding { value: Js::Bool(true), trail: Some(Trail::default()), many: false }));
                        }
                        _ => return Err(Stop::Thrown(Failure::unsupported("this await", "the Rust engine runs `await sleep(…)`"))),
                    },
                    _ => {
                        let expr = self.value_slot(&assign.value, scope)?;
                        let bound = self.bind_slot(expr, scope).await?;
                        scope.declare(assign.name.clone(), Binding::Value(bound));
                    }
                }
                Ok(Flow::FellThrough)
            }
            Statement::Write(statement) => {
                self.write(&statement.write, None, scope, &format!("{path}/write")).await?;
                Ok(Flow::FellThrough)
            }
            Statement::Await(statement) => match &statement.r#await.source {
                AwaitSource::Sleep { duration, .. } => {
                    self.sleep(duration, at, scope, None).await?;
                    Ok(Flow::FellThrough)
                }
                _ => Err(Stop::Thrown(Failure::unsupported("this await", "the Rust engine runs `await sleep(…)`"))),
            },
            // `return <value>`: the same right-hand side, bound into a slot
            // the grammar cannot spell, and the body ends.
            Statement::Return(ret) => {
                let expr = self.value_slot(&ret.value, scope)?;
                let bound = self.bind_slot(expr, scope).await?;
                scope.declare("#return", Binding::Value(bound));
                Ok(Flow::Returned)
            }
            Statement::If(statement) => {
                for (index, arm) in statement.arms.iter().enumerate() {
                    let taken = self.condition(&arm.condition, scope).await?;
                    self.trace(TraceEntry::Gate { outcome: taken });
                    if taken {
                        return self.body(&arm.body, &scope.child(), &at.branch(index), &format!("{path}/arms/{index}/body"), 0).await;
                    }
                }
                match &statement.else_arm {
                    Some(arm) => self.body(&arm.body, &scope.child(), &at.branch(statement.arms.len()), &format!("{path}/elseArm/body"), 0).await,
                    None => Ok(Flow::FellThrough),
                }
            }
            _ => Err(Stop::Thrown(Failure::unsupported("this statement", "the Rust engine runs bindings, writes, `if`, `sleep` and `return`"))),
        }
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
                .ok_or_else(|| Stop::Thrown(Failure::unsupported(&format!("the call '{}'", call.callee), "a built-in's call reads as its expression"))),
            _ => Err(Stop::Thrown(Failure::unsupported("this right-hand side", "the Rust engine runs `name = <expression>`"))),
        }
    }

    /// `bindSlotValue` for what this engine binds: the value the slot
    /// evaluates to, with its trail.
    async fn bind_slot(&self, slot: &ExprSlot, scope: &Rc<Scope>) -> Result<ValueBinding, Stop> {
        let expr = lowered(slot, |tree| movement_parser::lowering::lower_expression(tree, &slot.raw), "expression")
            .map_err(Stop::Thrown)?;
        let evaluated = self.evaluate(&expr, scope, slot).await?;
        // `binding.provenance ?? NO_PROVENANCE`: a bound value always has a trail.
        let trail = match evaluated.prov {
            Prov::Binding(name) => Some(scope.value_of(&name).and_then(|b| b.trail).unwrap_or_default()),
            Prov::Built(trail) => Some(trail),
        };
        Ok(ValueBinding { value: evaluated.value, trail, many: false })
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
                MovementCondition::IsTest { .. } => Err(Stop::Thrown(Failure::unsupported("an IS test", "the Rust engine runs expression conditions"))),
            }
        })
    }

    /// One expression, evaluated as one walk: each read it makes of the host
    /// is awaited where it is made, and the walk resumes there.
    pub(crate) async fn evaluate(&self, expr: &Expression, scope: &Rc<Scope>, slot: &ExprSlot) -> Result<Evaluated, Stop> {
        let around = Surroundings { services: env_services::current(), now: Some(self.now_ms) };
        // Each literal the evaluation reads is an origin in the program text:
        // the slot's span.
        let span = env::js_of_json(&serde_json::to_value(slot.span).expect("a span is JSON"));
        let reader = Reading { run: self, scope, span };
        let evaluator = Evaluator::in_run(scope.as_ref(), Some(self.version()), around, &reader);
        evaluator.eval(expr).await.map_err(|error| {
            Stop::Thrown(Failure::of_eval(error, "the Rust engine does not reproduce it; run this movement on the TypeScript engine"))
        })
    }

    /// What an evaluation asked, answered by the host.
    async fn answer(&self, ask: Ask, scope: &Scope) -> Result<Result<Evaluated, EvalError>, Failure> {
        match ask {
            Ask::EventField { field } => self.event_field(&field).await.map(Ok),
            Ask::RecordField { root, field } => Ok(self.record_field(&root, &field, scope)),
            Ask::Function { id, args } => {
                let args = args.iter().map(env::encode_plain).collect();
                let request = host::builtins::function(&id, args, &js_date::to_iso_string(self.now_ms), self.version());
                self.builtin(request).await
            }
            Ask::Compare { op, left, right } => {
                let op = serde_json::to_value(op).expect("an operator is JSON");
                let request = host::builtins::compare(op.as_str().unwrap_or_default(), env::encode_plain(&left), env::encode_plain(&right));
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
                (Some("Error"), _) => ErrorClass::Error,
                _ => return Err(Failure::engine("MOVENG_RUNTIME", format!("a built-in threw what this engine cannot rethrow: {threw}"))),
            };
            return Ok(Err(EvalError::Thrown { class, message }));
        }
        let value = answer.get("value").ok_or_else(|| Failure::engine("MOVENG_RUNTIME", format!("a built-in answered {answer}")))?;
        let value = env::decode(value).map_err(|e| Failure::engine("MOVENG_RUNTIME", e))?;
        Ok(Ok(Evaluated { value, prov: Prov::Built(Trail::default()) }))
    }

    /// `readSourcePositionField` on the event: the source adapter's
    /// `getFieldValue` through the surface-read wrapper, a `field_miss`
    /// traced for a field a raw payload does not carry, and the read's
    /// `source_field` origin.
    async fn event_field(&self, field: &str) -> Result<Evaluated, Failure> {
        let source = self.source.borrow().clone().expect("the event is seeded before the body runs");
        let seed = &source.position;
        let position = restamp(seed, seed.record_type.clone().or_else(|| source.start_surface_type.clone()), &source.adapter_type);
        let mut read = JsObject::new();
        read.set("position".into(), position.to_js());
        read.set("fieldId".into(), Js::str(field));
        let value = self.call_adapter(&source.instance, "getFieldValue", Js::object(read)).await?;
        if value.is_nullish() && !seed.is_stable() {
            self.trace_miss(&source, field);
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

    /// An origin as the firing record carries it (`ProvenanceSummariser`).
    pub(crate) fn summarised_origin(&self, id: u32) -> Js {
        let origin = self.origins.borrow().get(id as usize).cloned().unwrap_or(Js::Null);
        summarise(&origin)
    }

    /// `interpretSleep`: a rehearsal fast-forwards; a real run parks the flow
    /// on a timer, its scope chain serialized, and stops here.
    async fn sleep(&self, duration: &ast::DurationLiteral, at: &Address, scope: &Rc<Scope>, presence: Option<&str>) -> Result<(), Stop> {
        if self.input.dry_run {
            return Ok(());
        }
        let address = at.encode();
        let state = crate::park::parked_state(self, &address, presence, scope);
        let ms = crate::park::duration_ms(&duration.raw).ok_or_else(|| {
            Stop::Thrown(Failure::Engine {
                class: ErrorClass::Error,
                message: format!("invalid duration literal '{}' — use unit-suffixed literals like 4h, 2d, 90m, 1h30m", duration.raw),
            })
        })?;
        // When to wake, by the engine's own wall clock, as the TypeScript
        // reads `Date.now()` (an environment service, not a host call).
        let wake_at = js_date::to_iso_string(env_services::current().now_ms() + ms);
        let request = host::park::commit_timer_park(self.segment(), &address, env::encode_plain(&state), &wake_at);
        let answer = self.ask(request).await.map_err(Stop::Thrown)?;
        if answer.as_ref().and_then(|a| a.get("noSink")).is_some() {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("sleep reached at '{address}' with no park sink — the run cannot suspend on a timer without the durable trigger-run substrate"),
            )));
        }
        self.trace(TraceEntry::Gate { outcome: false });
        Err(Stop::Parked(address))
    }

    fn trace_miss(&self, source: &Source, field: &str) {
        let data = &source.position.data;
        let keys: Vec<String> = match data {
            Js::Object(object) => object.entries().iter().map(|(k, _)| k.clone()).collect(),
            Js::Array(list) => (0..list.items.len()).map(|i| i.to_string()).collect(),
            _ => return,
        };
        // `field in data`: own keys, and the prototype's.
        let carried = keys.iter().any(|k| k == field)
            || stdlib::is_object_prototype_name(field)
            || (matches!(data, Js::Array(_)) && (field == "length" || ARRAY_PROTOTYPE_NAMES.contains(&field)));
        let seen = self.misses.borrow().iter().any(|(b, f)| *b == source.instance_name && f == field);
        if carried || seen {
            return;
        }
        self.misses.borrow_mut().push((source.instance_name.clone(), field.to_string()));
        let available = keys.into_iter().take(30).collect();
        self.trace(TraceEntry::FieldMiss { binding: source.instance_name.clone(), field: field.to_string(), available });
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
        let entries = self.trace.take();
        if entries.is_empty() {
            return Ok(());
        }
        self.ask(host::trace::append(self.segment(), &entries, closing)).await.map(|_| ())
    }

    pub(crate) async fn ask(&self, request: host::Request) -> Result<Option<Json>, Failure> {
        self.host.request(request).await.map_err(Failure::Host)
    }

    async fn ask_bool(&self, request: host::Request) -> Result<bool, Failure> {
        Ok(self.ask(request).await?.is_some_and(|v| v.as_bool() == Some(true)))
    }
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
    scope: &'r Scope,
    span: Js,
}

impl Reader for Reading<'_, '_> {
    fn ask(&self, ask: Ask) -> Evaluating<'_> {
        Box::pin(async move { self.run.answer(ask, self.scope).await.map_err(Failure::into_eval)? })
    }

    fn literal(&self) -> u32 {
        self.run.mint_origin(env::object_of(vec![("kind", Js::str("literal")), ("span", self.span.clone())]))
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
fn summarise(origin: &Js) -> Js {
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
        let input = json!({
            "entry": "segment", "source": source, "languageVersion": 3, "segmentId": "g1",
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
        assert_eq!(seen[6].args, json!({ "entries": [{ "kind": "gate", "outcome": true }], "segmentId": "g1" }));
        // Every request the host serves names the segment.
        assert!(seen.iter().filter(|r| r.family != "check").all(|r| r.args["segmentId"] == json!("g1")));
        // The source adapter reads the payload under the parameter's
        // declared position.
        let read = env::decode(&seen[3].args["args"]).unwrap();
        let Js::Object(read) = read else { panic!("a read") };
        let Some(Js::Object(position)) = read.get("position") else { panic!("a position") };
        assert!(matches!(position.get("recordType"), Some(Js::String(t)) if t == "message"));
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
        let source = "import { email } from adapters\ninbox = email()\ntype T = <\"a\">\nmovement m(msg: <inbox-[:message]->>) {\n  s = 1\n}";
        let (done, seen) = drive(source, json!(["o", 1, []]), plain_host(json!({})));
        // Refused on this engine's own parse: not even the check is asked.
        assert_eq!(done, json!({ "refused": "file_statement:type" }));
        assert!(seen.is_empty());
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
        ] {
            let input = json!({
                "entry": "segment", "source": source, "languageVersion": 3, "segmentId": "g1",
                "now": "2026-03-12T12:00:00.000Z", "event": wire(json!({})), "catalog": serde_json::from_str::<Json>(CATALOG).unwrap(),
                "resume": { "state": wire(state) },
            });
            let mut segment = crate::begin(&input.to_string()).unwrap();
            match segment.start().unwrap() {
                Step::Done(done) => assert_eq!(done, json!({ "refused": reason })),
                Step::Pending(pending) => panic!("{reason}: asked {:?}", pending.iter().map(|r| r.method.clone()).collect::<Vec<_>>()),
            }
        }
        let resumable = json!({
            "version": 1, "address": "s2.b0.s0", "bindingName": null,
            "scopeChain": [{ "bindings": {
                "v": { "kind": "value", "value": { "a": 1 }, "provenance": { "origins": [{ "kind": "literal" }] } },
                "e": { "kind": "event" },
                "g": { "kind": "nodePosition", "fields": {}, "fieldProvenance": {}, "edges": { "owner": { "kind": "landed", "landings": [{ "kind": "nodeRef", "id": 0 }] } } },
            } }],
        });
        assert_eq!(crate::park::resume_refusal(&wire(resumable.clone())), None);
        // A suspension's state, whose journal is empty: this engine runs no calls.
        let mut suspended = resumable;
        suspended["suspended"] = json!(true);
        suspended["journal"] = json!([]);
        assert_eq!(crate::park::resume_refusal(&wire(suspended)), None);
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
            "entry": "segment", "source": source, "languageVersion": 3, "segmentId": "g1",
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
            "entry": "segment", "source": source, "languageVersion": 3, "segmentId": "g1",
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
        let record = crate::env::json_of_js(&writes.items[0]);
        assert_eq!(record["externalId"], json!("co-1"));
        assert_eq!(record["bindingName"], json!("co"));
        assert_eq!(record["origin"], json!({ "kind": "write", "writeIndex": 0, "externalId": "co-1" }));
        assert_eq!(record["provenance"]["name"][0]["kind"], json!("source_field"));
    }

    /// A sink that takes the pause (`commitLimitPause`) and then cannot
    /// suspend (`commitSuspension` answers `noSink`) answers the two halves
    /// of `canSuspend` differently: the run cannot park, so it fails on its
    /// cap rather than with a suspension it never made.
    #[test]
    fn a_sink_that_pauses_but_cannot_suspend_fails_the_run_on_its_cap() {
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
            "entry": "segment", "source": source, "languageVersion": 3, "segmentId": "g1",
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
                        ("park.sink", "commitLimitPause") => json!({}),
                        ("park.sink", "commitSuspension") => json!({ "value": { "noSink": true } }),
                        ("control.cancel", _) => json!({ "value": false }),
                        _ => json!({}),
                    };
                    seen.push(if method.is_empty() { format!("{}.{}", request.family, request.method) } else { method });
                    step = segment.answer(request.id, crate::read_answer(&answer.to_string()).unwrap()).unwrap();
                }
            }
        };
        assert!(seen.iter().any(|s| s == "park.sink.commitLimitPause"), "{seen:?}");
        assert!(seen.iter().any(|s| s == "park.sink.commitSuspension"), "{seen:?}");
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
            "entry": "segment", "source": source, "languageVersion": 3, "segmentId": "g1",
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
        let deprecated = json!({ "diagnostics": [{ "code": "MOV_LANGUAGE_VERSION_DEPRECATED", "message": "old" }], "stamps": [] });
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

    #[test]
    fn a_graph_copy_that_walks_edges_declines_after_the_check() {
        let source = "import { email, attio } from adapters\ninbox = email()\ncrm = attio()\nmovement m(msg: <inbox-[:message]->>) {\n  co = write crm-[:companies]-> { name: msg.`subject` }\n  g = graph { ...co }\n}";
        let copy = |edges: Json| json!({ "diagnostics": [], "stamps": [{ "path": "/statements/3/body/1/value/node/spreads/0", "copy": { "fields": ["name"], "edges": edges } }] });
        let (done, seen) = dated_run(source, copy(json!({ "notes": { "fields": [], "edges": {} } })));
        assert_eq!(done, json!({ "declined": "graph_copy_walks_edges" }));
        assert_eq!(seen, ["check.program"]);
        let (_, seen) = dated_run(source, copy(json!({})));
        assert_eq!(seen[1], "adapters.resolve");
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
    fn addresses_encode_as_address_ts_does() {
        let root = Address::default();
        assert_eq!(root.encode(), "");
        assert_eq!(root.stmt(1).branch(0).stmt(2).encode(), "s1.b0.s2");
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
