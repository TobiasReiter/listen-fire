//! What a flow waits on (run.ts `interpretAwait`), and the callbacks a run
//! mints.
//!
//! - **`sleep`**: a timer park (crate::park).
//! - **`until(condition, every)`**: the condition tested now; met, its value
//!   is bound and the run goes on; else a timer park the timer resume
//!   re-enters to test it again (`until: true`).
//! - **A combinator**: crate::combinator.
//! - **An edge**: check now, else park. A callback's `Called` edge is read
//!   off the callback's ledger (`park.callbacks.calls`); a written record's
//!   edge is asked of its awaitable adapter (`resolveAwait`). Resolved, the
//!   landing is bound and the run goes on; pending, the await park is
//!   committed under the key a wake names it by (`commitAwaitPark`), the
//!   question asked once more now that the park is durable, and the run woken
//!   (`park.wake`) when it already resolved. The resume re-enters the await,
//!   which checks again.
//! - **`callback(…)`**: minted with the host (`park.callbacks.mint`), its
//!   captured continuation the park's own state; its body is the callback
//!   entry's (crate::resume).

use std::rc::Rc;

use movement_parser::ast::{self, AwaitSource, CallbackExpression, CallbackSubject, ParamTypeRef, PathHead, PathRoot, UntilCondition};
use movement_parser::lowering::expression::Expression;
use serde_json::Value as Json;

use crate::bindings::{Binding, Closure, Scope};
use crate::env::{self, Trail, ValueBinding};
use crate::eval::ErrorClass;
use crate::flow::Code;
use crate::host;
use crate::js::{Js, JsObject};
use crate::park::Leaf;
use crate::run::{Address, Failure, Flow, Run, Stop};
use crate::trace::TraceEntry;

/// `CALLBACK_CALLED_EDGE`: a callback's one edge.
pub(crate) const CALLED: &str = "Called";
/// `CALLBACK_AWAIT_TYPE`: the reserved identity a callback await parks under.
const CALLBACK_AWAIT_TYPE: &str = "callback";
/// `CALLBACK_CALL_AT`: the landing's field holding when the call landed.
const CALLED_AT: &str = "At";
/// `UNTIL_DEFAULT_EVERY_MS`: an `until`'s cadence when none is written.
const UNTIL_EVERY_MS: f64 = 3_600_000.0;
/// The scalar types a fire-time parameter may declare.
const CALLBACK_PARAM_TYPES: [&str; 7] = ["text", "number", "boolean", "date", "datetime", "json", "file"];

/// What an await's check found (`check()`).
enum Checked {
    Bind(Js),
    Empty,
    Wait(Json),
}

impl Run<'_> {
    /// `interpretAwait`. `path` is the await source's AST path.
    pub(crate) async fn awaiting(&self, source: &AwaitSource, binding_name: Option<&str>, scope: &Rc<Scope>, at: &Address, path: &str) -> Result<(), Stop> {
        match source {
            AwaitSource::Until { condition, every, .. } => self.until(condition, every.as_ref(), binding_name, scope, at, &format!("{path}/condition")).await,
            AwaitSource::Sleep { duration, .. } => {
                self.sleep(duration, at, scope, binding_name).await?;
                if let Some(name) = binding_name {
                    scope.declare(name, Binding::Value(ValueBinding { value: Js::Bool(true), trail: Some(Trail::default()), many: false }));
                }
                Ok(())
            }
            AwaitSource::Combinator { combinator, .. } => self.combinator(combinator, binding_name, scope, at, &format!("{path}/combinator")).await,
            AwaitSource::Traversal { head, .. } | AwaitSource::First { head, .. } => self.await_edge(head, binding_name, scope, at).await,
        }
    }

    // ── until ──

    /// `interpretUntil`: check now, else re-park on the clock.
    async fn until(&self, condition: &UntilCondition, every: Option<&ast::DurationLiteral>, binding_name: Option<&str>, scope: &Rc<Scope>, at: &Address, path: &str) -> Result<(), Stop> {
        let (value, binding) = self.until_condition(condition, scope, at, path).await?;
        if until_met(&value) || self.input.dry_run {
            if let Some(name) = binding_name {
                scope.declare(name, binding);
            }
            return Ok(());
        }
        let address = at.encode();
        if !self.serves("park.sink.commitTimerPark") {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("await until reached at '{address}' with no park sink — a recurring wait needs the durable trigger-run substrate"),
            )));
        }
        let every_ms = match every {
            Some(every) => crate::park::duration_ms(&every.raw).ok_or_else(|| invalid_duration(&every.raw))?,
            None => UNTIL_EVERY_MS,
        };
        let state = crate::park::park_state(self, &address, None, Leaf::Until, scope).map_err(Stop::Thrown)?;
        let now = self.clock_now().await.map_err(Stop::Thrown)?;
        let wake_at = crate::js_date::to_iso_string(now + every_ms);
        let request = host::park::commit_timer_park(self.segment(), &address, self.encode(&state).map_err(Stop::Thrown)?, &wake_at);
        self.ask(request).await.map_err(Stop::Thrown)?;
        self.trace(TraceEntry::Gate { outcome: false });
        Err(Stop::Parked(address))
    }

    /// `evaluateUntilCondition`: a closure (written in place, or a name bound
    /// to one) called once per tick and what it returned; else the
    /// expression's value.
    async fn until_condition(&self, condition: &UntilCondition, scope: &Rc<Scope>, at: &Address, path: &str) -> Result<(Js, Binding), Stop> {
        match condition {
            UntilCondition::Closure { closure } => {
                let closure = Rc::new(Closure { code: Code { ast: Rc::new(closure.clone()), path: format!("{path}/closure") }, captured: scope.capture(), self_name: None });
                self.tick(&closure, at).await
            }
            UntilCondition::Expr { expr } => {
                let trimmed = crate::js::trim(&expr.raw);
                if is_bare_ident(trimmed)
                    && let Some(Binding::Closure(closure)) = scope.resolve(trimmed)
                {
                    return self.tick(&closure, at).await;
                }
                let evaluated = self.evaluate_slot(expr, scope).await?;
                let trail = self.trail_or_none(&evaluated.prov, scope);
                let value = evaluated.value;
                Ok((value.clone(), Binding::Value(ValueBinding { value, trail: Some(trail), many: false })))
            }
        }
    }

    /// `tickClosure`: the condition called, and what it returned.
    async fn tick(&self, closure: &Rc<Closure>, at: &Address) -> Result<(Js, Binding), Stop> {
        let (flow, child) = self.invoke_closure(closure, &[], at).await?;
        let returned = match flow {
            Flow::Returned => child.resolve_own(crate::run::RETURN_SLOT),
            Flow::FellThrough => None,
        };
        let Some(bound) = returned else {
            return Err(Stop::Thrown(Failure::engine("MOVENG_RUNTIME", "an 'until' condition returned nothing — the checker should have caught this".into())));
        };
        let value = match &bound {
            Binding::Value(value) => value.value.clone(),
            other => crate::record::held(other.clone()),
        };
        Ok((value, bound))
    }

    // ── An edge awaited ──

    /// The await on an edge: a callback's, or a written record's through its
    /// awaitable adapter.
    async fn await_edge(&self, head: &PathHead, binding_name: Option<&str>, scope: &Rc<Scope>, at: &Address) -> Result<(), Stop> {
        let edge = await_edge_name(&head.hops_raw);
        let step = crate::traverse::head_step(head).ok();
        let alias = step.as_ref().and_then(|step| step.alias.clone());
        let filter = if has_where(&head.hops_raw) { step.and_then(|step| step.expression_filter.map(|f| *f)) } else { None };
        // The WHERE's alias is the landing it reads (`r.answer` its field).
        let filter = filter.map(|filter| (filter, alias));
        let root = match &head.root {
            Some(PathRoot::Name { name }) => name.clone(),
            _ => String::new(),
        };
        let bound = scope.resolve(&root);
        match bound {
            Some(callback @ Binding::Callback(_)) => self.await_callback(&callback, &edge, filter.as_ref(), binding_name, scope, at).await,
            Some(Binding::Handle(handle)) => self.await_landing(&handle, &edge, filter.as_ref(), binding_name, scope, at).await,
            _ => Err(Stop::Thrown(Failure::unsupported(
                &format!("await '{root}-[:{edge}]->'"),
                "await needs a written record handle as its head (e.g. an ask written with `write asks-[:Check]->`)",
            ))),
        }
    }

    /// `interpretCallbackAwait`: the ledger standing in for `resolveAwait`,
    /// the callback's id for its key.
    async fn await_callback(&self, callback: &Binding, edge: &str, filter: Option<&(Expression, Option<String>)>, binding_name: Option<&str>, scope: &Rc<Scope>, at: &Address) -> Result<(), Stop> {
        if edge != CALLED {
            return Err(Stop::Thrown(Failure::unsupported(&format!("await '-[:{edge}]->' on a callback"), &format!("a callback has one edge, '{CALLED}'"))));
        }
        if !self.serves("park.callbacks.calls") {
            return Err(Stop::Thrown(Failure::unsupported(
                &format!("await cb-[:{CALLED}]->"),
                "this run has no callback sink — a callback needs the durable trigger-run substrate",
            )));
        }
        let id = self.callback_id(callback)?;
        if let Some(call) = self.first_matching_call(&id, filter, scope).await? {
            // The resolved shortcut: a fire already landed.
            if let Some(name) = binding_name {
                scope.declare(name, called_landing(&call));
            }
            return Ok(());
        }
        let address = at.encode();
        if !self.serves("park.sink.commitAwaitPark") {
            return Err(Stop::Thrown(Failure::unsupported(
                &format!("await cb-[:{CALLED}]-> (a durable park)"),
                "this run has no park sink — an await needs the durable trigger-run substrate",
            )));
        }
        let key = env::json_of_js(&id);
        let state = crate::park::park_state(self, &address, None, Leaf::Plain, scope).map_err(Stop::Thrown)?;
        let request = host::park::commit_await_park(self.segment(), &address, self.encode(&state).map_err(Stop::Thrown)?, CALLBACK_AWAIT_TYPE, &key);
        self.ask(request).await.map_err(Stop::Thrown)?;
        let again = self.first_matching_call(&id, filter, scope).await.map(|call| call.is_some());
        self.wake_if_resolved(CALLBACK_AWAIT_TYPE, &key, again).await;
        self.trace(TraceEntry::Gate { outcome: false });
        Err(Stop::Parked(address))
    }

    /// A callback binding's `callbackId`.
    pub(crate) fn callback_id(&self, callback: &Binding) -> Result<Js, Stop> {
        match callback {
            Binding::Callback(callback) => Ok(callback.callback_id.clone()),
            _ => unreachable!("only a callback has calls"),
        }
    }

    /// The calls a callback's ledger holds, as the host answers them.
    pub(crate) async fn callback_calls(&self, id: &Js) -> Result<Vec<Js>, Stop> {
        let answer = self.ask(host::park::callback_calls(self.segment(), &env::json_of_js(id))).await.map_err(Stop::Thrown)?;
        let calls = match answer {
            Some(answer) => self.wire.decode(&answer).map_err(|e| Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("park.callbacks.calls answered what does not read: {e}"))))?,
            None => Js::Undefined,
        };
        match calls {
            Js::Array(list) => Ok(list.items().clone()),
            other => Err(Stop::Thrown(Failure::Engine {
                class: ErrorClass::TypeError,
                message: format!("{} is not iterable", if other.is_nullish() { other.to_js_string() } else { "calls".into() }),
            })),
        }
    }

    /// `firstMatch`: the first call on the ledger the hop's WHERE takes.
    async fn first_matching_call(&self, id: &Js, filter: Option<&(Expression, Option<String>)>, scope: &Rc<Scope>) -> Result<Option<Js>, Stop> {
        for call in self.callback_calls(id).await? {
            if self.call_matches(&call, filter, scope).await? {
                return Ok(Some(call));
            }
        }
        Ok(None)
    }

    /// `callbackCallMatches`: the awaited hop's pure WHERE over one recorded
    /// call's fields, read directly (no adapter translates them).
    pub(crate) async fn call_matches(&self, call: &Js, filter: Option<&(Expression, Option<String>)>, scope: &Rc<Scope>) -> Result<bool, Stop> {
        let Some((filter, alias)) = filter else { return Ok(true) };
        let landing = called_landing(call);
        let at = scope.child();
        if let Some(alias) = alias {
            at.declare(alias.clone(), landing.clone());
        }
        let value = self.evaluate_scoped(filter, &at, None, Some(crate::run::Scoped::Binding(landing))).await?.value;
        Ok(value.truthy())
    }

    /// `wakeIfResolvedWhileParking`: the await's whole question asked once
    /// more now that the park is durable; resolved, the run is woken. A
    /// re-check that cannot answer leaves the run parked, and a wake that
    /// cannot be queued leaves the park as durable as before: both logged.
    async fn wake_if_resolved(&self, adapter_type: &str, key: &Json, resolved: Result<bool, Stop>) {
        let fields = |error: Option<String>| {
            let mut fields = serde_json::Map::new();
            fields.insert("adapterType".into(), Json::String(adapter_type.into()));
            fields.insert("correlationKey".into(), key.clone());
            if let Some(error) = error {
                fields.insert("error".into(), Json::String(error));
            }
            fields
        };
        match resolved {
            Err(stop) => {
                self.log("error", "[MovementEngine] await re-check after parking failed; the run stays parked without a wake", fields(Some(stop_message(&stop))));
            }
            Ok(false) => {}
            Ok(true) => {
                if let Err(failure) = self.ask(host::park::wake(self.segment(), adapter_type, key)).await {
                    self.log("error", "[MovementEngine] await wake after parking could not be queued", fields(Some(failure_message(&failure))));
                }
            }
        }
    }

    /// The await on a written record's edge (`interpretAwait`'s signal wake
    /// source): its awaitable adapter asked, with the head's own credential
    /// and construction arguments — the instance the write went through.
    async fn await_landing(&self, handle: &crate::bindings::Handle, edge: &str, filter: Option<&(Expression, Option<String>)>, binding_name: Option<&str>, scope: &Rc<Scope>, at: &Address) -> Result<(), Stop> {
        let record = handle.record();
        let record_id = record.get("externalId");
        let adapter_type = record.get("adapterType").to_js_string();
        if matches!(record_id, Js::Undefined) {
            // A rehearsed write: no real record to await; it settles empty.
            if let Some(name) = binding_name {
                scope.declare(name, null_value());
            }
            return Ok(());
        }
        let mut instance = (*handle.graph).clone();
        instance.adapter_slug = adapter_type.clone();
        let read = self.instance_read(&instance).await.map_err(Stop::Thrown)?;
        if !read.instance.has("resolveAwait") {
            return Err(Stop::Thrown(Failure::unsupported(
                &format!("await '-[:{edge}]->' on '{adapter_type}'"),
                &format!("the '{adapter_type}' adapter does not implement the awaitable capability"),
            )));
        }
        let raw = Rc::new(crate::traverse::Read { raw: true, ..(*read).clone() });
        if self.input.dry_run {
            if let Some(name) = binding_name {
                scope.declare(name, awaited_landing(&adapter_type, &raw, &Js::object(JsObject::new()), None));
            }
            return Ok(());
        }
        let mut point = vec![("recordId", record_id), ("edge", Js::str(edge))];
        let head_data = record.get("resultData");
        if !head_data.is_nullish() {
            point.push(("headData", head_data));
        }
        let point = env::object_of(point);
        let outcome = self.check_landing(&raw, &adapter_type, &point, filter, scope).await?;
        match outcome {
            Checked::Bind(landing) => {
                if let Some(name) = binding_name {
                    let record_type = crate::record::get(&landing, "recordType").ok().filter(|t| !matches!(t, Js::Undefined));
                    let fields = crate::record::get(&landing, "fields").unwrap_or(Js::Undefined);
                    scope.declare(name, awaited_landing(&adapter_type, &raw, &fields, record_type));
                }
                Ok(())
            }
            Checked::Empty => {
                if let Some(name) = binding_name {
                    scope.declare(name, awaited_landing(&adapter_type, &raw, &Js::object(JsObject::new()), None));
                }
                Ok(())
            }
            Checked::Wait(key) => {
                let address = at.encode();
                if !self.serves("park.sink.commitAwaitPark") {
                    return Err(Stop::Thrown(Failure::unsupported("await (a durable park)", "this run has no park sink — an await needs the durable trigger-run substrate")));
                }
                let state = crate::park::park_state(self, &address, None, Leaf::Plain, scope).map_err(Stop::Thrown)?;
                let parked_type = raw.adapter_type.clone();
                let request = host::park::commit_await_park(self.segment(), &address, self.encode(&state).map_err(Stop::Thrown)?, &parked_type, &key);
                self.ask(request).await.map_err(Stop::Thrown)?;
                let again = self.check_landing(&raw, &adapter_type, &point, filter, scope).await.map(|checked| !matches!(checked, Checked::Wait(_)));
                self.wake_if_resolved(&parked_type, &key, again).await;
                self.trace(TraceEntry::Gate { outcome: false });
                Err(Stop::Parked(address))
            }
        }
    }

    /// `check()`: `resolveAwait`, a landing taken only where the awaited
    /// WHERE takes it (through the adapter's own `getFieldValue`).
    async fn check_landing(&self, read: &Rc<crate::traverse::Read>, adapter_type: &str, point: &Js, filter: Option<&(Expression, Option<String>)>, scope: &Rc<Scope>) -> Result<Checked, Stop> {
        let resolution = self.call_adapter(&read.instance, "resolveAwait", point.clone()).await.map_err(Stop::Thrown)?;
        let get = |value: &Js, key: &str| crate::record::get(value, key).map_err(|e| Stop::Thrown(Failure::of_eval(e, "")));
        let status = get(&resolution, "status")?;
        match status {
            Js::String(status) if status == "pending" => Ok(Checked::Wait(env::json_of_js(&get(&resolution, "correlationKey")?))),
            Js::String(status) if status == "empty" => Ok(Checked::Empty),
            Js::String(status) if status == "landed" => {
                let landings = match get(&resolution, "landings")? {
                    Js::Array(list) => list.items().clone(),
                    other => return Err(Stop::Thrown(Failure::Engine { class: ErrorClass::TypeError, message: format!("{} is not iterable", other.to_js_string()) })),
                };
                for landing in landings {
                    let taken = match filter {
                        None => true,
                        Some(filter) => self.landing_matches(read, adapter_type, &landing, filter, scope).await?,
                    };
                    if taken {
                        return Ok(Checked::Bind(landing));
                    }
                }
                // Landings, none of which the WHERE takes: still armed.
                Ok(Checked::Wait(env::json_of_js(&get(&resolution, "correlationKey")?)))
            }
            other => Err(Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("resolveAwait answered a status of {}", crate::js::json_stringify(&other, 0))))),
        }
    }

    /// `awaitLandingMatches`: the WHERE read off the landing through the
    /// adapter, an AND stopping at its first false conjunct.
    async fn landing_matches(&self, read: &Rc<crate::traverse::Read>, adapter_type: &str, landing: &Js, filter: &(Expression, Option<String>), scope: &Rc<Scope>) -> Result<bool, Stop> {
        let (filter, alias) = filter;
        let record_type = match crate::record::get(landing, "recordType").map_err(|e| Stop::Thrown(Failure::of_eval(e, "")))? {
            Js::Undefined | Js::Null => Js::str("Response"),
            other => other,
        };
        let fields = crate::record::get(landing, "fields").map_err(|e| Stop::Thrown(Failure::of_eval(e, "")))?;
        let position = env::object_of(vec![
            ("adapterType", Js::str(adapter_type)),
            ("recordType", record_type),
            ("identity", env::object_of(vec![("kind", Js::str("unstable")), ("data", fields)])),
        ]);
        let landed = Rc::new(crate::bindings::Landed::new(position, None, read.clone()));
        let at = scope.child();
        if let Some(alias) = alias {
            at.declare(alias.clone(), Binding::Landed(landed.clone()));
        }
        let value = self.evaluate_scoped(filter, &at, None, Some(crate::run::Scoped::Landed(landed))).await?.value;
        Ok(value.truthy())
    }

    // ── callback(…) ──

    /// `mintCallback`: the capture made — the enclosing scope chain, as a
    /// park writes it — and the callback minted against this statement's
    /// address. `path` is the callback expression's AST path.
    pub(crate) async fn mint_callback(&self, callback: &CallbackExpression, scope: &Rc<Scope>, at: &Address, _path: &str) -> Result<Binding, Stop> {
        if !self.serves("park.callbacks.mint") {
            return Err(Stop::Thrown(Failure::unsupported("callback(…)", "this run has no callback sink — a callback needs the durable trigger-run substrate")));
        }
        let address = at.encode();
        let params = self.callback_params(&callback.subject, scope)?;
        let (single_use, expires_at) = self.callback_config(callback, scope).await?;
        let state = crate::park::park_state(self, &address, None, Leaf::Plain, scope).map_err(Stop::Thrown)?;
        let params_js = Js::array(params.iter().map(|(name, type_)| env::object_of(vec![("name", Js::str(name.clone())), ("type", Js::str(type_.clone()))])).collect());
        let request = host::park::mint_callback(self.segment(), &address, env::json_of_js(&params_js), self.encode(&state).map_err(Stop::Thrown)?, single_use, expires_at.as_deref());
        let minted = self.ask(request).await.map_err(Stop::Thrown)?.unwrap_or(Json::Null);
        let field = |key: &str| minted.get(key).map_or(Js::Undefined, env::js_of_json);
        Ok(Binding::Callback(Rc::new(crate::bindings::Callback { callback_id: field("id"), url: field("url"), params: params_js })))
    }

    /// `callbackParams`: the fire-time signature, in declaration order.
    fn callback_params(&self, subject: &CallbackSubject, scope: &Rc<Scope>) -> Result<Vec<(String, String)>, Stop> {
        let declared: Vec<ast::MovementParam> = match subject {
            CallbackSubject::Inline { closure, .. } => closure.params.clone(),
            CallbackSubject::Named { movement, args, .. } => {
                let name = self.callee_name(movement, scope);
                let Some(Binding::Movement(declared)) = scope.resolve(&name) else {
                    return Err(Stop::Thrown(Failure::engine(
                        "MOVENG_RUNTIME",
                        format!("callback({movement}): '{movement}' is not a movement in scope — the checker should have caught this"),
                    )));
                };
                let (declaration, _) = self.declaration(&declared)?;
                // `argumentBindings`: a named argument the parameter it names,
                // a positional one the parameter at its index.
                let supplied: Vec<String> = args
                    .iter()
                    .enumerate()
                    .filter_map(|(position, arg)| arg.name().map(String::from).or_else(|| declaration.params.get(position).map(|p| p.name.clone())))
                    .collect();
                let deferred: Vec<ast::MovementParam> = declaration.params.iter().filter(|p| !supplied.contains(&p.name)).cloned().collect();
                if !deferred.is_empty() {
                    let names: Vec<&str> = deferred.iter().map(|p| p.name.as_str()).collect();
                    return Err(Stop::Thrown(Failure::unsupported(
                        &format!("callback({movement}(…)) leaving '{}' unsupplied", names.join("', '")),
                        "a named callback binds no values at fire time yet — supply every argument, or use the inline form (`callback((x: <text>) => { … })`)",
                    )));
                }
                deferred
            }
        };
        declared
            .iter()
            .map(|param| match &param.type_ {
                Some(ParamTypeRef::Name(type_)) if type_.hops_raw.is_none() && type_.position.is_none() && CALLBACK_PARAM_TYPES.contains(&type_.graph.as_str()) => {
                    Ok((param.name.clone(), type_.graph.clone()))
                }
                other => Err(Stop::Thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!(
                        "a callback's parameter '{}' must be a scalar type, got '<{}>' — the checker should have caught this",
                        param.name,
                        other.as_ref().map_or_else(|| "?".to_string(), spell_param_type)
                    ),
                ))),
            })
            .collect()
    }

    /// `callbackConfig`: `{ once, ttl }`; `once` defaults true.
    async fn callback_config(&self, callback: &CallbackExpression, scope: &Rc<Scope>) -> Result<(bool, Option<String>), Stop> {
        let mut single_use = true;
        let mut expires_at = None;
        for entry in &callback.config {
            match entry.name.as_str() {
                "once" => single_use = !matches!(self.evaluate_slot(&entry.value, scope).await?.value, Js::Bool(false)),
                "ttl" => {
                    let raw = crate::js::trim(&entry.value.raw);
                    let now = self.clock_now().await.map_err(Stop::Thrown)?;
                    let ms = crate::park::duration_ms(raw).ok_or_else(|| invalid_duration(raw))?;
                    expires_at = Some(crate::js_date::to_iso_string(now + ms));
                }
                other => {
                    return Err(Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("'{other}' is not a callback setting — the checker should have caught this"))));
                }
            }
        }
        Ok((single_use, expires_at))
    }

    /// `cb-[c:Called]->`'s landings: the calls so far that its WHERE takes,
    /// read synchronously off the ledger.
    pub(crate) async fn called_landings(&self, callback: &Binding, filter: Option<&(Expression, Option<String>)>, scope: &Rc<Scope>) -> Result<Vec<Binding>, Stop> {
        if !self.serves("park.callbacks.calls") {
            return Err(Stop::Thrown(Failure::unsupported(&format!("cb-[:{CALLED}]->"), "this run has no callback sink — a callback needs the durable trigger-run substrate")));
        }
        let id = self.callback_id(callback)?;
        let mut landings = Vec::new();
        for call in self.callback_calls(&id).await? {
            if self.call_matches(&call, filter, scope).await? {
                landings.push(called_landing(&call));
            }
        }
        Ok(landings)
    }
}

/// `callbackCallBinding`: the `Called` landing — `At` plus one field per
/// fire-time parameter — an in-memory record of no graph.
pub(crate) fn called_landing(call: &Js) -> Binding {
    let mut fields = JsObject::new();
    fields.set(CALLED_AT.into(), crate::record::get(call, "at").unwrap_or(Js::Undefined));
    if let Ok(Js::Object(values)) = crate::record::get(call, "values") {
        for (key, value) in values.entries() {
            fields.set(key.clone(), value.clone());
        }
    }
    Binding::ShapePosition(Rc::new(crate::bindings::ShapePosition {
        shape: Js::str("callback"),
        node: Js::str(CALLED),
        fields: Js::object(fields),
        field_provenance: Js::object(JsObject::new()),
    }))
}

/// `declareAwaitResult`'s position: the landing's fields inline, read
/// through the awaitable adapter itself (no read wrapper).
fn awaited_landing(adapter_type: &str, read: &Rc<crate::traverse::Read>, fields: &Js, record_type: Option<Js>) -> Binding {
    let position = env::object_of(vec![
        ("adapterType", Js::str(adapter_type)),
        ("recordType", record_type.unwrap_or_else(|| Js::str("Response"))),
        ("identity", env::object_of(vec![("kind", Js::str("unstable")), ("data", fields.clone())])),
    ]);
    Binding::Landed(Rc::new(crate::bindings::Landed::new(position, None, read.clone())))
}

fn null_value() -> Binding {
    Binding::Value(ValueBinding { value: Js::Null, trail: Some(Trail::default()), many: false })
}

/// `untilConditionMet`: identity against true, with a stringified fallback
/// for sources that hand booleans back as `"true"`, never against a node.
fn until_met(value: &Js) -> bool {
    match value {
        Js::Bool(true) => true,
        Js::Undefined | Js::Null | Js::Object(_) | Js::Array(_) | Js::Record(_) => false,
        other => other.to_js_string() == "true",
    }
}

/// `BARE_IDENT`.
fn is_bare_ident(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `awaitEdgeName`: the edge name of an awaited hop, `-[:Response]->` and
/// `-[got:Response]->` alike, a backtick-quoted name unwrapped.
pub(crate) fn await_edge_name(hops_raw: &str) -> String {
    let inner = hops_raw.strip_prefix("-[").unwrap_or(hops_raw);
    let inner = match inner.trim_end().strip_suffix("]->") {
        Some(stripped) => stripped,
        None => inner,
    };
    let after = match inner.find(':') {
        Some(colon) => &inner[colon + 1..],
        None => inner,
    };
    let after = crate::js::trim(after);
    let name = if let Some(rest) = after.strip_prefix('`')
        && let Some(end) = rest.find('`')
        && end > 0
    {
        &rest[..end]
    } else {
        let end = after.find(|c: char| c.is_whitespace() || c == ']').unwrap_or(after.len());
        if end == 0 { after } else { &after[..end] }
    };
    crate::js::trim(name).to_string()
}

/// `/\bWHERE\b/i`.
fn has_where(hops_raw: &str) -> bool {
    let upper = hops_raw.to_ascii_uppercase();
    let bytes = upper.as_bytes();
    let word = |i: usize| bytes.get(i).is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_');
    upper.match_indices("WHERE").any(|(i, _)| (i == 0 || !word(i - 1)) && !word(i + 5))
}

fn spell_param_type(type_: &ParamTypeRef) -> String {
    match type_ {
        ParamTypeRef::Name(type_) => {
            let mut spelled = type_.graph.clone();
            if let Some(hops) = &type_.hops_raw {
                spelled.push_str(hops);
            }
            spelled
        }
        ParamTypeRef::Value(_) => "a value".to_string(),
    }
}

fn invalid_duration(raw: &str) -> Stop {
    Stop::Thrown(Failure::Engine {
        class: ErrorClass::Error,
        message: format!("invalid duration literal '{raw}' — use unit-suffixed literals like 4h, 2d, 90m, 1h30m"),
    })
}

fn failure_message(failure: &Failure) -> String {
    match failure {
        Failure::Engine { message, .. } => message.clone(),
        Failure::Host(error) => error.message().to_string(),
        other => format!("{other:?}"),
    }
}

fn stop_message(stop: &Stop) -> String {
    match stop {
        Stop::Thrown(failure) => failure_message(failure),
        _ => "the re-check did not end".into(),
    }
}

