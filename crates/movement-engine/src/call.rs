//! Calls of the movements a program declares: run.ts's `executeCall` →
//! `runCall`, for `persist(n: node { … })`, `x = summarise(d)` and the
//! construction spelling `x = persist(n: d)` of the same; from version 3 a
//! closure bound to a name is called the same way (`executeClosureCall`),
//! its body run in the scope it captured.
//!
//! A call is one of its statement's steps (`… .c k`, address.ts): what runs
//! inside the k-th call a statement makes is addressed under that step. The
//! callee runs in a scope of its own whose parent is the file's (lexical
//! scoping: the caller's locals are invisible), its parameters bound in
//! declaration order from arguments evaluated in the caller's source order —
//! a value parameter takes what its argument evaluates to, a position
//! parameter the record its argument is bound to (the event, a write's
//! handle, a node, a walked or extracted record). Its statements are the
//! run's own: the cancel gate, the trace handed over a statement at a time,
//! the writes on the one firing record. Its value is what it returned.
//!
//! Before version 3 a call to a movement already running fails; from it
//! recursion is bounded by the call depth (`call_depth.ts`), the limit the
//! shim reads from the deployment. Admission refuses a park or a suspension
//! inside a callee (`call_park`, `cost_cap_inside_call`), so a call never
//! has to be resumed into: no call frame is ever written.

use std::rc::Rc;

use movement_parser::ast::{CallArg, CallStatement, MovementDeclaration, ParamTypeRef, Statement};

use crate::bindings::{Binding, MovementRef, Scope};
use crate::program;
use crate::flow::Boundary;
use crate::run::{Address, Failure, Flow, Run, Stop};

type Called<'s> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<Binding>, Stop>> + 's>>;

/// The k-th call of the statement running now, as `beginCall` opened it
/// (`CallEvent`).
pub(crate) struct CallEvent {
    pub site: Option<Rc<crate::flow::Site>>,
    pub index: usize,
    /// Set when the call had already finished before a park: what it
    /// handed back.
    pub replayed: Option<crate::flow::CallRecord>,
}
type Bound<'s> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Binding, Stop>> + 's>>;

impl Run<'_> {
    /// `calleeName`: the name a callee was declared with — from version 3 a
    /// function's call may spell it in another letter case.
    pub(crate) fn callee_name(&self, written: &str, scope: &Scope) -> String {
        if scope.resolve(written).is_some() || self.version() < 3 {
            return written.to_string();
        }
        scope.resolve_function(written).unwrap_or_else(|| written.to_string())
    }

    /// Whether `written` names a plugin (`runCall`'s `callee.kind ===
    /// 'plugin'`): as imported, or from version 3 in another letter case.
    pub(crate) fn calls_plugin(&self, written: &str, scope: &Scope) -> bool {
        matches!(scope.resolve(&self.callee_name(written, scope)), Some(Binding::Plugin(_)))
    }

    /// Whether `written` names a function this run calls: a movement, or
    /// from version 3 a closure bound to a name.
    pub(crate) fn calls_function(&self, written: &str, scope: &Scope) -> bool {
        match scope.resolve(&self.callee_name(written, scope)) {
            Some(Binding::Movement(_)) => true,
            Some(Binding::Closure(_)) => self.version() >= 3,
            None => self.member_callee_object(written, scope),
            _ => false,
        }
    }

    /// `executeCall`: the statement's next call opened, then the callee run.
    /// `path` is the call's AST path (its arguments' stamps are under it).
    pub(crate) fn call<'s>(&'s self, call: &'s CallStatement, scope: &'s Rc<Scope>, at: &'s Address, path: &'s str) -> Called<'s> {
        Box::pin(async move {
            let event = self.begin_call_event().await?;
            if let Some(replayed) = &event.replayed {
                return Ok(replayed.value.clone());
            }
            let value = self.run_call(call, scope, at, path, &event).await?;
            self.finish_call(&event, value.as_ref());
            Ok(value)
        })
    }

    /// `runCall`: the callee's arguments evaluated in the caller's source
    /// order, its body run inside the call's boundary.
    fn run_call<'s>(&'s self, call: &'s CallStatement, scope: &'s Rc<Scope>, at: &'s Address, path: &'s str, event: &'s CallEvent) -> Called<'s> {
        Box::pin(async move {
            let name = self.callee_name(&call.callee, scope);
            let declared_file;
            let callee = match scope.resolve(&name) {
                None if self.member_callee_object(&call.callee, scope) => {
                    let member = movement_parser::ast::ExprSlot::plain(call.callee.clone(), call.span);
                    crate::record::binding_of(&self.evaluate_slot(&member, scope).await?.value)
                }
                resolved => resolved,
            };
            let declaration = match callee {
                Some(Binding::Movement(declared)) => {
                    declared_file = declared.file.clone();
                    self.declaration(&declared)?
                }
                // A closure bound to a name is a function too (language version 3).
                Some(Binding::Closure(closure)) if self.version() >= 3 => return self.closure_call(call, &closure, scope, at, path, event).await,
                // One function sort: a plugin's call, its value what the
                // plugin declared it hands back (`executePluginCall`).
                Some(Binding::Plugin(_)) => return Ok(Some(self.invoke_plugin(&call.callee, &call.args, scope, at, path).await?)),
                Some(Binding::Opaque { .. }) => {
                    return Err(Stop::Thrown(Failure::unsupported(
                        &format!("calling the import '{}'", call.callee),
                        "this run has no file resolver — its catalog snapshot carries no files (or declare the movement in this file)",
                    )));
                }
                other => {
                    let what = other.as_ref().map_or_else(|| "not in scope".to_string(), crate::write::describe_binding);
                    return Err(Stop::Thrown(Failure::engine(
                        "MOVENG_RUNTIME",
                        format!("'{}' is {what}, not a callable movement — the checker should have caught this", call.callee),
                    )));
                }
            };
            let (declaration, body_path) = declaration;
            self.enter_call(&declaration.name)?;
            if call.args.len() != declaration.params.len() {
                return Err(Stop::Thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!(
                        "'{}' takes {} argument(s), got {} — the checker should have caught this",
                        declaration.name,
                        declaration.params.len(),
                        call.args.len()
                    ),
                )));
            }
            let file = self.scope_of_file(&declared_file).ok_or_else(|| Stop::Thrown(Failure::engine("MOVENG_RUNTIME", "no file scope for a movement call".into())))?;
            let callee = file.child();
            // `argumentBindings`: a named argument the parameter it names, a
            // positional one the parameter declared at its index; evaluated
            // in the caller's source order, a later one for the same
            // parameter replacing an earlier.
            let mut evaluated: Vec<(String, Binding)> = Vec::new();
            for (position, arg) in call.args.iter().enumerate() {
                let param = arg.name().map(String::from).or_else(|| declaration.params.get(position).map(|p| p.name.clone()));
                let Some(declared) = param.as_deref().and_then(|p| declaration.params.iter().find(|d| d.name == p)) else {
                    let which = arg.name().map_or_else(|| "for this argument".to_string(), |n| format!("'{n}'"));
                    return Err(Stop::Thrown(Failure::engine(
                        "MOVENG_RUNTIME",
                        format!("'{}' has no parameter {which} — the checker should have caught this", declaration.name),
                    )));
                };
                // A parameter typed by a refinement names one the callee's file declares.
                let takes_value = self.takes_value(declared.type_.as_ref(), &declared_file);
                let bound = self.call_arg(arg, scope, at, &format!("{path}/args/{position}"), takes_value).await?;
                match evaluated.iter_mut().find(|(p, _)| *p == declared.name) {
                    Some(slot) => slot.1 = bound,
                    None => evaluated.push((declared.name.clone(), bound)),
                }
            }
            for param in &declaration.params {
                let Some((_, binding)) = evaluated.iter().find(|(p, _)| *p == param.name) else {
                    return Err(Stop::Thrown(Failure::engine(
                        "MOVENG_RUNTIME",
                        format!("'{}' call supplies no argument '{}' — the checker should have caught this", declaration.name, param.name),
                    )));
                };
                callee.declare(param.name.clone(), binding.clone());
            }
            self.call_stack.borrow_mut().push(declaration.name.clone());
            let address = self.call_address(event, at);
            let ran = self.within_call(event, &name, self.body(&declaration.body, &callee, &address, &body_path, 0)).await;
            self.call_stack.borrow_mut().pop();
            match ran {
                Ok(Flow::Returned) => Ok(callee.resolve_own(crate::run::RETURN_SLOT)),
                // Find-on-missing inside a callee ends the callee's scope;
                // the caller goes on after the call.
                Ok(Flow::FellThrough) | Err(Stop::EndedQuietly) => Ok(None),
                Err(other) => Err(other),
            }
        })
    }

    /// `executeClosureCall`: `f(3)` where `f` names a closure — called as a
    /// movement is (arguments bound by name or by order, evaluated in the
    /// caller's source order), its body run in the closure's captured scope
    /// under this call's step, its value what it returned.
    fn closure_call<'s>(
        &'s self,
        call: &'s CallStatement,
        closure: &'s Rc<crate::bindings::Closure>,
        scope: &'s Rc<Scope>,
        at: &'s Address,
        path: &'s str,
        event: &'s CallEvent,
    ) -> Called<'s> {
        Box::pin(async move {
            let params = &closure.code.ast.params;
            // From version 5 a closure stands where a closure type is
            // expected when it takes FEWER parameters than the type supplies
            // (TypeScript's rule), so a call through the type may hand it
            // more arguments than it declares: they are evaluated, in order,
            // and dropped, as JavaScript drops them.
            let positional = call.args.first().is_some_and(|arg| arg.name().is_none());
            let kept = if self.version() >= 5 && positional && call.args.len() > params.len() { params.len() } else { call.args.len() };
            let (args, extra) = call.args.split_at(kept);
            if args.len() != params.len() {
                return Err(Stop::Thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!("'{}' takes {} argument(s), got {} — the checker should have caught this", call.callee, params.len(), call.args.len()),
                )));
            }
            let mut bound: Vec<(String, Binding)> = Vec::new();
            for (position, arg) in args.iter().enumerate() {
                let param = arg.name().map(String::from).or_else(|| params.get(position).map(|p| p.name.clone()));
                let Some(declared) = param.as_deref().and_then(|p| params.iter().find(|d| d.name == p)) else {
                    let which = arg.name().map_or_else(|| "for this argument".to_string(), |n| format!("'{n}'"));
                    return Err(Stop::Thrown(Failure::engine(
                        "MOVENG_RUNTIME",
                        format!("'{}' has no parameter {which} — the checker should have caught this", call.callee),
                    )));
                };
                // A parameter with no written type (language version 5) is
                // typed by where the closure is handed — a closure type's
                // parameter — and takes whatever the argument evaluates to,
                // a record included.
                let untyped = declared.type_.is_none() && self.version() >= 5;
                let takes_value = untyped || self.takes_value(declared.type_.as_ref(), &scope.file_env());
                let binding = self.call_arg(arg, scope, at, &format!("{path}/args/{position}"), takes_value).await?;
                match bound.iter_mut().find(|(p, _)| *p == declared.name) {
                    Some(slot) => slot.1 = binding,
                    None => bound.push((declared.name.clone(), binding)),
                }
            }
            for (position, arg) in extra.iter().enumerate() {
                self.call_arg(arg, scope, at, &format!("{path}/args/{}", kept + position), true).await?;
            }
            let name = self.callee_name(&call.callee, scope);
            let address = self.call_address(event, at);
            let ran = self.within_call(event, &name, self.within_named_call(Some(&name), self.invoke_closure_bound(closure, bound, &address))).await;
            match ran {
                Ok((Flow::Returned, child)) => Ok(child.resolve_own(crate::run::RETURN_SLOT)),
                // Find-on-missing inside the closure ends the closure's
                // scope, as it ends a called movement's.
                Ok((Flow::FellThrough, _)) | Err(Stop::EndedQuietly) => Ok(None),
                Err(other) => Err(other),
            }
        })
    }

    /// `readCall` in an argument: from version 3 a callee the program does
    /// not bind is a built-in, read as the expression the call is.
    pub(crate) fn builtin_reading<'c>(&self, call: &'c CallStatement, scope: &Scope) -> Option<&'c movement_parser::ast::ExprSlot> {
        let name = self.callee_name(&call.callee, scope);
        (self.version() >= 3 && scope.resolve(&name).is_none()).then_some(call.expression.as_ref()).flatten()
    }

    /// `callAddress`: what runs inside a call is under its statement's
    /// `call k` step.
    pub(crate) fn call_address(&self, event: &CallEvent, at: &Address) -> Address {
        event.site.as_ref().map_or(at, |site| &site.address).call(event.index)
    }

    /// `requireCallValue`: a call whose value is bound or passed on.
    pub(crate) fn call_value(&self, callee: &str, value: Option<Binding>) -> Result<Binding, Stop> {
        value.ok_or_else(|| {
            Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("'{callee}' returned nothing, so there is no value to bind — the checker should have caught this"),
            ))
        })
    }

    /// `beginCall`: the running statement's next call — on a re-run, what it
    /// had already handed back before a park, which it hands back instead of
    /// running; a `suspendAt` before it suspends the flow there.
    pub(crate) async fn begin_call_event(&self) -> Result<CallEvent, Stop> {
        let site = self.call_sites.borrow().last().cloned();
        let Some(site) = site else { return Ok(CallEvent { site: None, index: 0, replayed: None }) };
        let index = site.calls.borrow().next;
        let replayed = site.calls.borrow().replay.iter().find(|(i, _)| *i == index).map(|(_, r)| r.clone());
        if let Some(replayed) = replayed {
            let mut calls = site.calls.borrow_mut();
            calls.next = replayed.next;
            calls.complete(index, replayed.clone());
            drop(calls);
            return Ok(CallEvent { site: Some(site), index, replayed: Some(replayed) });
        }
        self.suspend_before_call(&site.address.call(index), &site).await?;
        site.calls.borrow_mut().next += 1;
        Ok(CallEvent { site: Some(site), index, replayed: None })
    }

    /// `finishCall`: what a call handed back, kept on its statement.
    pub(crate) fn finish_call(&self, event: &CallEvent, value: Option<&Binding>) {
        if let Some(site) = &event.site {
            let mut calls = site.calls.borrow_mut();
            let next = calls.next;
            calls.complete(event.index, crate::flow::CallRecord { value: value.cloned(), next });
        }
    }

    /// `enterCallee`: `future` run inside the call's body boundary, so a park
    /// below it records how to get back. A call made outside any statement
    /// has no statement to be re-run by, and runs as it always did.
    pub(crate) async fn within_call<T>(&self, event: &CallEvent, callee: &str, future: impl std::future::Future<Output = T>) -> T {
        let Some(site) = &event.site else { return future.await };
        let next = site.calls.borrow().next;
        self.within_boundary(Boundary::Call { site: site.clone(), index: event.index, next, callee: callee.to_string() }, future).await
    }

    /// `withinBoundary`: `future` run one body boundary deeper.
    pub(crate) async fn within_boundary<T>(&self, boundary: Boundary, future: impl std::future::Future<Output = T>) -> T {
        self.boundaries.borrow_mut().push(boundary);
        let outcome = future.await;
        self.boundaries.borrow_mut().pop();
        outcome
    }

    /// Before version 3 a movement already running is not called again;
    /// from it, the depth is bounded (`assertCallDepth`: the run's own
    /// movement is not a call).
    fn enter_call(&self, callee: &str) -> Result<(), Stop> {
        let stack = self.call_stack.borrow();
        let chain = || stack.iter().cloned().chain(std::iter::once(callee.to_string())).collect::<Vec<_>>();
        if self.version() < 3 {
            if stack.iter().any(|running| running == callee) {
                return Err(Stop::Thrown(Failure::unsupported(&format!("recursive movement calls ('{}')", chain().join(" → ")), "")));
            }
            return Ok(());
        }
        let limit = self.input.max_call_depth;
        if stack.len().saturating_sub(1) < limit {
            return Ok(());
        }
        Err(Stop::Thrown(Failure::CallDepth { limit, chain: chain() }))
    }

    /// The declaration a movement binding names, and its body's AST path.
    pub(crate) fn declaration(&self, movement: &MovementRef) -> Result<(MovementDeclaration, String), Stop> {
        self.checked
            .file(&movement.file)
            .and_then(|file| {
                file.program.statements.iter().enumerate().find_map(|(i, s)| match s {
                    Statement::Movement(m) if m.name == movement.name => Some((m.clone(), program::in_file(&movement.file, &format!("/statements/{i}/body")))),
                    _ => None,
                })
            })
            // A parked state can name a movement a later edit removed.
            .ok_or_else(|| Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("'{}' is not a movement this program declares", movement.name))))
    }

    /// `isValueParam`: a parameter typed by a value (`<number[]>`), a field
    /// type (`<text>`) or a `type` the file declares takes what its argument
    /// evaluates to; any other takes a position.
    fn takes_value(&self, type_: Option<&ParamTypeRef>, file: &program::DeclaringFile) -> bool {
        match type_ {
            None => false,
            Some(ParamTypeRef::Value(_)) => true,
            Some(ParamTypeRef::Name(type_)) if type_.hops_raw.is_some() => false,
            Some(ParamTypeRef::Name(type_)) => {
                movement_parser::catalog::helpers::parse_field_type_name(Some(&type_.graph)).is_some()
                    || self.checked.declarations.of_file(file).is_some_and(|d| d.types.contains_key(&type_.graph))
            }
        }
    }

    /// A plugin's call or node argument (`pluginArgValue`): bound as a
    /// value parameter's argument is.
    pub(crate) async fn plugin_bound_arg(&self, arg: &CallArg, scope: &Rc<Scope>, at: &Address, path: &str) -> Result<Binding, Stop> {
        self.call_arg(arg, scope, at, path, true).await
    }

    /// `evaluateCallArg`.
    fn call_arg<'s>(&'s self, arg: &'s CallArg, scope: &'s Rc<Scope>, at: &'s Address, path: &'s str, takes_value: bool) -> Bound<'s> {
        Box::pin(async move {
            match arg {
                // `bindValue`: a record a value parameter is handed binds as
                // the record it is.
                CallArg::Expr { expr, .. } if takes_value => {
                    let evaluated = self.evaluate_slot(expr, scope).await?;
                    let trail = self.trail_or_none(&evaluated.prov, scope);
                    Ok(crate::record::bind_value(evaluated.value, Some(trail), false))
                }
                CallArg::Write { write, .. } => self.write(write, None, scope, &format!("{path}/write")).await,
                CallArg::Node { node, .. } => Ok(Binding::Node(self.synthesise_node(node, scope, &format!("{path}/node")).await?)),
                // A built-in called here is the value it computes; any other
                // call runs, and its value is what this argument passes on.
                CallArg::Call { call, name } => match self.builtin_reading(call, scope) {
                    Some(expr) => {
                        let as_value = CallArg::Expr { name: name.clone(), expr: expr.clone() };
                        self.call_arg(&as_value, scope, at, path, takes_value).await
                    }
                    None => {
                        let value = self.call(call, scope, at, &format!("{path}/call")).await?;
                        self.call_value(&call.callee, value)
                    }
                },
                // A closure is a value (language version 5): written in
                // place as an argument it is (AST, scope), holding the scope
                // it is written in by reference, as a list element closure
                // does.
                CallArg::Closure { closure, .. } if takes_value && self.version() >= 5 => Ok(Binding::Closure(Rc::new(crate::bindings::Closure {
                    code: crate::flow::Code { ast: Rc::new(closure.clone()), path: format!("{path}/closure") },
                    captured: scope.clone(),
                    self_name: None,
                    file_name: None,
                    by_reference: true,
                }))),
                CallArg::Closure { .. } => Err(Stop::Thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    "a function handed to a function's parameter — the checker should have caught this".into(),
                ))),
                CallArg::Type { .. } => Err(Stop::Thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    "a type handed to a function's parameter — the checker should have caught this".into(),
                ))),
                // A position parameter takes the record its argument is bound to.
                CallArg::Expr { expr, .. } => match self.bind_slot_binding(expr, scope).await? {
                    binding @ (Binding::Event
                    | Binding::Handle(_)
                    | Binding::Landed(_)
                    | Binding::Node(_)
                    | Binding::Extracted { .. }
                    | Binding::LazyWalk(_)
                    | Binding::ShapePosition(_)
                    | Binding::Resource(_)) => Ok(binding),
                    other => Err(Stop::Thrown(Failure::unsupported(
                        &format!("passing {} ('{}') as a movement argument", crate::write::describe_binding(&other), crate::js::trim(&expr.raw)),
                        "arguments are positions — pass the event, a write handle, or adapt with an inline shape-write",
                    ))),
                },
            }
        })
    }
}

