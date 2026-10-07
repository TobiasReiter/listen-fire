//! A segment of a run, executed whole: run.ts's `runMovement` for the
//! programs the shim's `rustCanRun` admits (apps/api/src/services/
//! movement_engine/rust_engine.ts says which). The same steps in the same
//! order, every one the TypeScript takes through its host taken here as a
//! host request:
//!
//! 1. the pinned source parsed, and checked (`check.program`, program.rs);
//! 2. `prepareMovement`: the file scope (imports, instances from the
//!    snapshot's `instantiate`), the movement picked, the source adapter
//!    resolved (`adapters.resolve`), the event seeded (`seedEventPosition`);
//! 3. `interpretBody` over the movement's statements, the cancel gate asked
//!    at each (`control.cancelled`): `x = <expr>`, `if`/`else`, `return`;
//! 4. the last cancel check (`control.cancelledNow`) and the result.
//!
//! An expression is evaluated by `eval::Evaluator`. What it cannot answer
//! itself — a field of the event, read through the source adapter; a
//! built-in reading this engine hands back — it asks, and the expression is
//! evaluated again with the answer, so the host sees the TypeScript's calls
//! in the TypeScript's order, short-circuits included.
//!
//! `done` is one of:
//!
//! - `{result: {movementName, cancelled?}}`;
//! - `{failed: {error, result}}`: the body failed (`MovementRunFailed`,
//!   which carries what the run did before it);
//! - `{thrown: error}`: it failed before the body ran;
//! - `{declined: reason}`: before any adapter was touched, the program
//!   turned out to need what this engine does not run; the shim runs it on
//!   the TypeScript engine instead.
//!
//! `error` is `{class: "MovementEngineError", code, message}`, `{class:
//! "Error" | "RangeError", message}`, or `{hostError: ref}`: the very error a
//! host call failed with, which the shim holds and rethrows.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use movement_parser::ast::{self, ExprSlot, MovementDeclaration, ParamTypeRef, RValue, Statement};
use movement_parser::catalog::helpers::{credential_arg_of, unwrap_credential_arg};
use movement_parser::catalog::snapshot::Args;
use movement_parser::catalog::types::{CatalogSnapshot, Composite, FieldType, InstanceSchema};
use movement_parser::lowering::condition::MovementCondition;
use movement_parser::lowering::expression::Expression;
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value as Json, json};

use crate::bindings::{Binding, InstanceBinding, Position, Scope};
use crate::env::{self, Trail, ValueBinding};
use crate::eval::{Ask, ErrorClass, EvalError, Evaluated, Evaluator, Prov, Reader};
use crate::executor::{Host, HostError};
use crate::host::{self, Instance, ResolveAdapter, Role};
use crate::js::{self, Js, JsObject};
use crate::program::{self, Checked};
use crate::stdlib::{self, Surroundings};
use crate::trace::TraceEntry;
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
    pub team_id: String,
    /// The run's pinned instant (`firedAt`, else when the run began).
    pub now: String,
    /// Kept as text: the catalog's maps are ordered.
    pub catalog: Box<RawValue>,
}

/// The segment entry: the run, and its `done`.
pub async fn segment(host: Host, input: SegmentInput) -> Json {
    match run(&host, &input).await {
        Ok(result) => json!({ "result": result }),
        Err(Stop::Declined(reason)) => json!({ "declined": reason }),
        Err(Stop::Thrown(failure)) => json!({ "thrown": failure.to_json() }),
        Err(Stop::Failed(failure, result)) => json!({ "failed": { "error": failure.to_json(), "result": result } }),
        Err(Stop::Cancelled) => unreachable!("a cancel ends the body, and the run returns its result"),
    }
}

/// How a run stops early.
enum Stop {
    Declined(String),
    Thrown(Failure),
    /// The body failed; the result so far rides with it.
    Failed(Failure, Json),
    /// The cancel gate said so at a statement boundary (`RunCancelledSignal`).
    Cancelled,
}

#[derive(Debug, Clone)]
enum Failure {
    Engine { class: ErrorClass, message: String },
    Host(HostError),
}

impl Failure {
    fn engine(code: &'static str, message: String) -> Failure {
        Failure::Engine { class: ErrorClass::Engine(code), message }
    }

    fn unsupported(construct: &str, detail: &str) -> Failure {
        Failure::engine("MOVENG_UNSUPPORTED", format!("{construct} is not supported by the movement engine yet ({detail})"))
    }

    fn to_json(&self) -> Json {
        match self {
            Failure::Engine { class: ErrorClass::Engine(code), message } => {
                json!({ "class": "MovementEngineError", "code": code, "message": message })
            }
            Failure::Engine { class: ErrorClass::Error, message } => json!({ "class": "Error", "message": message }),
            Failure::Engine { class: ErrorClass::RangeError, message } => json!({ "class": "RangeError", "message": message }),
            Failure::Host(error) => json!({ "hostError": error.detail.get("ref").cloned().unwrap_or(Json::Null) }),
        }
    }
}

/// A body's outcome (`BodyOutcome`): it ran to its end, or a `return` ended it.
enum Flow {
    FellThrough,
    Returned,
}

/// The event's source: its adapter (the handle the host resolved), the
/// position the event seeded, and what the surface-read wrapper (kg.ts
/// `surfaceReadAdapter`) needs to name it.
struct Source {
    instance: Instance,
    /// The live adapter's own `adapterType`.
    adapter_type: String,
    instance_name: String,
    /// The parameter's declared position, which names a typeless root.
    start_surface_type: Option<String>,
    position: Position,
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

struct Run<'a> {
    host: &'a Host,
    input: &'a SegmentInput,
    event: Js,
    now_ms: f64,
    catalog: CatalogSnapshot,
    checked: Checked,
    /// Aliased imports: local name → the catalog's name.
    import_originals: RefCell<Vec<(String, String)>>,
    source: RefCell<Option<Rc<Source>>>,
    /// Every provenance origin the run has met, by id (the trails hold ids).
    origins: RefCell<Vec<Json>>,
    /// The fields a `field_miss` was traced for, by instance: once each.
    misses: RefCell<Vec<(String, String)>>,
    /// The statement the run is at, where a park would record it.
    at: RefCell<Address>,
    movement_name: RefCell<String>,
}

async fn run(host: &Host, input: &SegmentInput) -> Result<Json, Stop> {
    let version = input.language_version;
    let catalog = CatalogSnapshot::load(input.catalog.get())
        .map_err(|e| Stop::Declined(format!("the catalog snapshot does not load: {e}")))?;
    let root = program::parse(&input.source, version)
        .map_err(|e| Stop::Declined(format!("the source does not parse here as it did for the shim: {e}")))?;
    let snapshot: Json = serde_json::from_str(input.catalog.get()).expect("the catalog was read a moment ago");
    let answer = host
        .request(host::check::program(&input.source, &snapshot, version, None))
        .await
        .map_err(|e| Stop::Thrown(Failure::Host(e)))?
        .ok_or_else(|| Stop::Declined("check.program answered nothing".into()))?;
    let checked = program::join_check(root, &answer, version).map_err(Stop::Declined)?;
    let event = env::decode(&input.event).map_err(|e| Stop::Declined(format!("the event does not read: {e}")))?;
    let now_ms = match js_date::parse(&input.now) {
        js_date::Parsed::Valid(ms) => ms,
        _ => return Err(Stop::Declined(format!("the pinned instant {:?} is not an instant", input.now))),
    };
    let run = Run {
        host,
        input,
        event,
        now_ms,
        catalog,
        checked,
        import_originals: RefCell::default(),
        source: RefCell::default(),
        origins: RefCell::default(),
        misses: RefCell::default(),
        at: RefCell::default(),
        movement_name: RefCell::default(),
    };
    // Whatever this engine does not run is declined before anything the
    // host can see happens: no trace entry, no adapter.
    if let Some(reason) = declined_by(&run.checked.root.program) {
        return Err(Stop::Declined(reason));
    }
    // A deprecated pin runs, and says so on the run's own record (the check's
    // version diagnostic; an unsupported one never got an answer).
    let version_warning = run.checked.diagnostics.iter().find_map(|d| {
        let code = d.get("code")?.as_str()?;
        let message = d.get("message")?.as_str()?;
        code.starts_with("MOV_LANGUAGE_VERSION_").then(|| (code.to_string(), message.to_string()))
    });
    if let Some((code, message)) = version_warning {
        run.trace(TraceEntry::Warning { code, message }).await.map_err(Stop::Thrown)?;
    }
    run.execute().await
}

impl Run<'_> {
    fn version(&self) -> u32 {
        self.input.language_version
    }

    fn result(&self, cancelled: bool) -> Json {
        let mut result = json!({ "movementName": *self.movement_name.borrow() });
        if cancelled {
            result["cancelled"] = json!(true);
        }
        result
    }

    async fn execute(&self) -> Result<Json, Stop> {
        let (movement, scope) = self.prepare().await?;
        let cancelled = match self.body(&movement.body, &scope, &Address::default()).await {
            Ok(_) => false,
            Err(Stop::Cancelled) => true,
            Err(Stop::Thrown(failure)) => return Err(Stop::Failed(failure, self.result(false))),
            Err(other) => return Err(other),
        };
        // The last cancel check: a cancel stamped while the final statement
        // ran has no later boundary to be found at.
        let cancelled = cancelled || self.ask_bool(host::control::cancelled_now()).await.map_err(|f| Stop::Failed(f, self.result(false)))?;
        Ok(self.result(cancelled))
    }

    // ── prepareMovement ──

    async fn prepare(&self) -> Result<(MovementDeclaration, Rc<Scope>), Stop> {
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
            Some(ParamTypeRef::Value(_)) => unreachable!("declined_by refuses a value-typed parameter"),
        };
        let Some(Binding::Instance(source_instance)) = file.resolve(&type_ref.graph) else {
            return Err(Stop::Thrown(Failure::unsupported(
                &format!("a movement parameter typed against '{}'", type_ref.graph),
                "type the parameter against a constructed adapter instance",
            )));
        };
        self.seed(&source_instance, type_ref).await.map_err(Stop::Thrown)?;
        let movement_scope = file.child();
        movement_scope.declare(param.name.clone(), Binding::Event);
        Ok((movement, movement_scope))
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
    /// (`declined_by` refused the rest).
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
        let credentials_id = match &instance.credential_name {
            Some(name) => self.ask(host::adapters::credential_id(name)).await?.and_then(|id| id.as_str().map(String::from)),
            None => None,
        };
        let resolved = self
            .ask(host::adapters::resolve(&ResolveAdapter {
                adapter_type: instance.adapter_slug.clone(),
                team_id: self.input.team_id.clone(),
                credentials_id,
                construction_args: None,
                role: Role::Source,
            }))
            .await?
            .unwrap_or(Json::Null);
        let handle = host::instance_of(&resolved).ok_or_else(|| Failure::engine("MOVENG_RUNTIME", format!("adapters.resolve answered {resolved}")))?;
        let adapter_type = resolved.get("adapterType").and_then(Json::as_str).unwrap_or(&instance.adapter_slug).to_string();
        let schema = instance.schema.as_ref();
        let root_record_type = event_text(&self.event, "rootRecordType");
        let root_surface_type = match self.natural_root_type_name(handle, root_record_type.as_deref()).await {
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
    async fn natural_root_type_name(&self, handle: Instance, root_record_type: Option<&str>) -> Option<String> {
        let root = root_record_type?;
        let Ok(answer) = self.host.request(host::adapters::call_wire(handle, "listEntryPoints", vec![])).await else {
            return Some(root.to_string());
        };
        let entries = answer.map(|wire| env::decode(&wire)).transpose().ok().flatten();
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

    fn body<'s>(
        &'s self,
        statements: &'s [Statement],
        scope: &'s Rc<Scope>,
        address: &'s Address,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Flow, Stop>> + 's>> {
        Box::pin(async move {
            for (index, statement) in statements.iter().enumerate() {
                let at = address.stmt(index);
                *self.at.borrow_mut() = at.clone();
                // The cancel gate: a requested cancel stops the run at the
                // next statement boundary, never mid-statement.
                if self.ask_bool(host::control::cancelled()).await.map_err(Stop::Thrown)? {
                    return Err(Stop::Cancelled);
                }
                if let Flow::Returned = self.statement(statement, scope, &at).await? {
                    return Ok(Flow::Returned);
                }
            }
            Ok(Flow::FellThrough)
        })
    }

    async fn statement(&self, statement: &Statement, scope: &Rc<Scope>, at: &Address) -> Result<Flow, Stop> {
        match statement {
            Statement::Assign(assign) => {
                let expr = self.value_slot(&assign.value, scope)?;
                let bound = self.bind_slot(expr, scope).await?;
                scope.declare(assign.name.clone(), Binding::Value(bound));
                Ok(Flow::FellThrough)
            }
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
                    self.trace(TraceEntry::Gate { outcome: taken }).await.map_err(Stop::Thrown)?;
                    if taken {
                        return self.body(&arm.body, &scope.child(), &at.branch(index)).await;
                    }
                }
                match &statement.else_arm {
                    Some(arm) => self.body(&arm.body, &scope.child(), &at.branch(statement.arms.len())).await,
                    None => Ok(Flow::FellThrough),
                }
            }
            _ => Err(Stop::Thrown(Failure::unsupported("this statement", "the Rust engine runs bindings, `if` and `return`"))),
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
        let trail = match evaluated.prov {
            Prov::Binding(name) => scope.value_of(&name).and_then(|b| b.trail),
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

    /// One expression, evaluated until it needs nothing more of the host:
    /// each ask answered in order, the evaluation replayed with the answers
    /// so far.
    async fn evaluate(&self, expr: &Expression, scope: &Rc<Scope>, slot: &ExprSlot) -> Result<Evaluated, Stop> {
        let replay = Replay::default();
        let around = Surroundings { services: env_services::current(), now: Some(self.now_ms) };
        loop {
            replay.cursor.set(0);
            let first_literal = self.origins.borrow().len() as u32;
            let evaluator = Evaluator::new(scope.as_ref(), Some(self.version()), around, first_literal).with_reader(&replay);
            match evaluator.eval(expr) {
                Ok(evaluated) => {
                    // Each literal the evaluation read is an origin in the
                    // program text: the slot's span.
                    let span = serde_json::to_value(slot.span).expect("a span is JSON");
                    let mut origins = self.origins.borrow_mut();
                    for _ in first_literal..evaluator.next_literal() {
                        origins.push(json!({ "kind": "literal", "span": span }));
                    }
                    return Ok(evaluated);
                }
                Err(EvalError::Suspend) => {
                    let ask = replay.pending.borrow_mut().take().expect("a suspended evaluation asked");
                    let answer = self.answer(ask).await.map_err(Stop::Thrown)?;
                    replay.answers.borrow_mut().push(answer);
                }
                Err(EvalError::Thrown { class, message }) => return Err(Stop::Thrown(Failure::Engine { class, message })),
                Err(EvalError::Fallback(reason)) => {
                    return Err(Stop::Thrown(Failure::unsupported(
                        &format!("this reading ({reason})"),
                        "the Rust engine does not reproduce it; run this movement on the TypeScript engine",
                    )));
                }
            }
        }
    }

    /// What an evaluation asked, answered by the host.
    async fn answer(&self, ask: Ask) -> Result<Result<Evaluated, EvalError>, Failure> {
        match ask {
            Ask::EventField { field } => self.event_field(&field).await.map(Ok),
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
        let answer = self.ask(host::adapters::call_wire(source.instance, "getFieldValue", vec![env::encode_plain(&Js::object(read))])).await?;
        let value = match answer {
            Some(wire) => env::decode(&wire).map_err(|e| Failure::engine("MOVENG_RUNTIME", e))?,
            None => Js::Undefined,
        };
        if value.is_nullish() && !seed.is_stable() {
            self.trace_miss(&source, field).await?;
        }
        let mut origin = json!({ "kind": "source_field", "instance": source.instance_name, "adapterType": source.adapter_type, "field": field });
        if seed.is_stable() {
            if let Some(record_type) = &seed.record_type {
                origin["recordType"] = json!(record_type);
            }
            origin["externalId"] = json!(seed.record_id);
        }
        let id = {
            let mut origins = self.origins.borrow_mut();
            origins.push(origin);
            origins.len() as u32 - 1
        };
        Ok(Evaluated { value, prov: Prov::Built(Trail { origins: vec![id], direct: Some(id) }) })
    }

    async fn trace_miss(&self, source: &Source, field: &str) -> Result<(), Failure> {
        let data = &source.position.data;
        let keys: Vec<String> = match data {
            Js::Object(object) => object.entries().iter().map(|(k, _)| k.clone()).collect(),
            Js::Array(list) => (0..list.items.len()).map(|i| i.to_string()).collect(),
            _ => return Ok(()),
        };
        // `field in data`: own keys, and the prototype's.
        let carried = keys.iter().any(|k| k == field)
            || stdlib::is_object_prototype_name(field)
            || (matches!(data, Js::Array(_)) && (field == "length" || ARRAY_PROTOTYPE_NAMES.contains(&field)));
        let seen = self.misses.borrow().iter().any(|(b, f)| *b == source.instance_name && f == field);
        if carried || seen {
            return Ok(());
        }
        self.misses.borrow_mut().push((source.instance_name.clone(), field.to_string()));
        let available = keys.into_iter().take(30).collect();
        self.trace(TraceEntry::FieldMiss { binding: source.instance_name.clone(), field: field.to_string(), available }).await
    }

    // ── Host calls ──

    async fn trace(&self, entry: TraceEntry) -> Result<(), Failure> {
        self.ask(host::trace::append(&entry)).await.map(|_| ())
    }

    async fn ask(&self, request: host::Request) -> Result<Option<Json>, Failure> {
        self.host.request(request).await.map_err(Failure::Host)
    }

    async fn ask_bool(&self, request: host::Request) -> Result<bool, Failure> {
        Ok(self.ask(request).await?.is_some_and(|v| v.as_bool() == Some(true)))
    }
}

/// Why this engine does not run `program`, when it does not: a file-level
/// statement it does not interpret, a construction that is a call, or a
/// movement taking a value. The shim's `rustCanRun` admits none such; this
/// is the engine's own guard, answered before the run does anything.
fn declined_by(program: &ast::Program) -> Option<String> {
    let movements: Vec<&str> = program
        .statements
        .iter()
        .filter_map(|s| match s {
            Statement::Movement(m) => Some(m.name.as_str()),
            _ => None,
        })
        .collect();
    for statement in &program.statements {
        match statement {
            Statement::Import(import) => match &import.source {
                ast::ImportSource::Builtin { namespace } if namespace == "adapters" || namespace == "credentials" => {}
                _ => return Some("an import from plugins or a file".into()),
            },
            Statement::Assign(assign) => match &assign.value {
                RValue::Construct { construct } if !movements.contains(&construct.callee.as_str()) => {}
                RValue::Construct { .. } => return Some("a file-level call".into()),
                _ => return Some("a file-level assignment that is not a construction".into()),
            },
            Statement::Listen(_) => {}
            Statement::Movement(m) => {
                if m.params.iter().any(|p| matches!(p.type_, Some(ParamTypeRef::Value(_)))) {
                    return Some("a movement taking a value".into());
                }
            }
            _ => return Some("a file-level statement this engine does not run".into()),
        }
    }
    None
}

/// `Array.prototype`'s own names, which `in` finds on any list.
const ARRAY_PROTOTYPE_NAMES: [&str; 38] = [
    "at", "concat", "copyWithin", "entries", "every", "fill", "filter", "find", "findIndex", "findLast", "findLastIndex",
    "flat", "flatMap", "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf", "map", "pop", "push", "reduce",
    "reduceRight", "reverse", "shift", "slice", "some", "sort", "splice", "toLocaleString", "toReversed", "toSorted",
    "toSpliced", "unshift", "values", "with", "toString",
];

/// The answers an evaluation's asks have had, handed out in the order asked.
#[derive(Default)]
struct Replay {
    answers: RefCell<Vec<Result<Evaluated, EvalError>>>,
    cursor: Cell<usize>,
    pending: RefCell<Option<Ask>>,
}

impl Reader for Replay {
    fn ask(&self, ask: Ask) -> Result<Evaluated, EvalError> {
        let at = self.cursor.get();
        if let Some(answer) = self.answers.borrow().get(at) {
            self.cursor.set(at + 1);
            return answer.clone();
        }
        *self.pending.borrow_mut() = Some(ask);
        Err(EvalError::Suspend)
    }
}

impl Scope {
    fn value_of(&self, name: &str) -> Option<ValueBinding> {
        crate::eval::Names::value(self, name)
    }
}

/// A slot parsed and lowered (`expressionOfSlot` / `conditionOfSlot`); a
/// refusal is the checker's miss.
fn lowered<T, E: std::fmt::Debug>(
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
            "entry": "segment", "source": source, "languageVersion": 3, "teamId": "t1",
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
            ("adapters", "resolve") => json!({ "value": { "instance": 1, "adapterType": "email" } }),
            ("control", _) => json!({ "value": false }),
            ("trace", "append") => json!({}),
            ("adapters", "call") => {
                let read = env::decode(&request.args["args"][0]).unwrap();
                let Js::Object(read) = read else { panic!("a read") };
                let Some(Js::String(field)) = read.get("fieldId") else { panic!("a field") };
                match payload.get(field) {
                    Some(value) => json!({ "value": value }),
                    None => json!({}),
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
        assert_eq!(done, json!({ "result": { "movementName": "m" } }));
        let calls: Vec<String> = seen.iter().map(|r| format!("{}.{}", r.family, r.method)).collect();
        assert_eq!(
            calls,
            [
                "check.program", "adapters.resolve", "control.cancelled", "adapters.call", "control.cancelled", "trace.append",
                "control.cancelled", "control.cancelled", "control.cancelledNow",
            ]
        );
        assert_eq!(seen[5].args, json!({ "entry": { "kind": "gate", "outcome": true } }));
        // The source adapter reads the payload under the parameter's
        // declared position.
        let read = env::decode(&seen[3].args["args"][0]).unwrap();
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
            ("adapters", "call") => json!({ "error": { "message": "down", "ref": 4 } }),
            _ => host(request),
        });
        assert_eq!(done, json!({ "failed": { "error": { "hostError": 4 }, "result": { "movementName": "m" } } }));
    }

    #[test]
    fn what_it_does_not_run_is_declined_before_anything_happens() {
        let source = "import { email } from adapters\ninbox = email()\ntype T = <\"a\">\nmovement m(msg: <inbox-[:message]->>) {\n  s = 1\n}";
        let (done, seen) = drive(source, json!(["o", 1, []]), plain_host(json!({})));
        assert_eq!(done, json!({ "declined": "a file-level statement this engine does not run" }));
        assert_eq!(seen.len(), 1);
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
