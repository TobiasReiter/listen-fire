//! `parallel` and `race` (run.ts `interpretCombinator`), and the closures
//! their arms are written as.
//!
//! Each arm runs in a scope of its own, a child of the combinator's, at the
//! address `… .b k`, as a flow of its own (crate::flow): its own call stack
//! and trace, its writes ordered under the combinator's fork by its index.
//! The arms run at once — each runs its own prefix, and one arm's park does
//! not stop the others reaching theirs — and their traces are spliced into
//! the combinator's in arm order once every arm has stopped. The receipt is
//! a tuple: slot k what arm k returned, a null value where it returned
//! nothing. An arm that failed fails the combinator, once every other arm
//! has stopped too; the failure is the earliest arm's.
//!
//! A `race` settles on the arms that finished: the ones still parked stop
//! being listened on (`cancelSubtrees`). With none finished it parks as a
//! join of one; a `parallel` with parked arms keeps what the finished ones
//! returned at its frame (`persistBranchExport`) and parks as a join of
//! as many as parked.

use std::rc::Rc;

use movement_parser::ast::{ArmExpression, ClosureExpression, CombinatorArms, CombinatorExpression, CombinatorKind, Statement};

use crate::bindings::{Binding, Closure, Scope};
use crate::env::{Trail, ValueBinding};
use crate::executor::join_all;
use crate::flow::{Boundary, Code};
use crate::host;
use crate::js::Js;
use crate::run::{Address, Failure, Flow, RETURN_SLOT, Run, Stop};
use crate::trace::TraceEntry;

/// One arm, as a body to run (`ArmInvocation`): a closure written in place
/// sees the scope around it; a name brings what it captured (a closure's
/// capture, a movement's file scope) and is a call by that name.
struct Arm {
    body: Rc<Vec<Statement>>,
    path: String,
    captured: Option<Rc<Scope>>,
    name: Option<String>,
    /// An arm built at run time: its body has no place in the source to be
    /// found at, so a park inside it carries it (an `arm` frame).
    runtime: Option<Code<ClosureExpression>>,
}

/// How one arm stopped.
enum Ended {
    /// It ran to its end (or ended quietly): what it returned.
    Settled(Binding),
    Parked,
    Failed(Stop),
}

/// `NULL_SLOT`: the slot of an arm that handed nothing back.
pub(crate) fn null_slot() -> Binding {
    Binding::Value(ValueBinding { value: Js::Null, trail: Some(Trail::default()), many: false })
}

impl Run<'_> {
    /// `interpretCombinator`. `path` is the combinator's AST path.
    pub(crate) async fn combinator(&self, expr: &CombinatorExpression, binding_name: Option<&str>, scope: &Rc<Scope>, at: &Address, path: &str) -> Result<(), Stop> {
        let arms = self.resolve_arms(expr, scope, path).await?;
        let kind = match expr.kind {
            CombinatorKind::Race => "race",
            CombinatorKind::Parallel => "parallel",
        };
        self.trace(TraceEntry::Block { root: kind.into(), positions: arms.len() });
        if arms.is_empty() {
            if expr.kind == CombinatorKind::Race {
                return Err(Stop::Thrown(Failure::engine("MOVENG_RUNTIME", "a race over no arms can never settle — nothing was given to it to run".into())));
            }
            // A parallel over nothing ran nothing, and its receipt has no slots.
            if let Some(name) = binding_name {
                scope.declare(name, Binding::Tuple(Rc::new(Vec::new())));
            }
            return Ok(());
        }
        let fork = self.fork_writes();
        let envs: Vec<Rc<Scope>> = arms.iter().map(|_| scope.child()).collect();
        let addresses: Vec<Address> = (0..arms.len()).map(|index| at.branch(index)).collect();
        let flows = arms.iter().enumerate().map(|(index, arm)| {
            let state = self.open_flow(fork.branch(index));
            let (env, address) = (&envs[index], &addresses[index]);
            self.in_flow(state, async move {
                let ran = match &arm.runtime {
                    None => self.run_arm(arm, env, address).await,
                    Some(body) => self.within_boundary(Boundary::Arm { arm: index, body: body.clone() }, self.run_arm(arm, env, address)).await,
                };
                match ran {
                    Ok(Flow::Returned) => Ended::Settled(env.resolve_own(RETURN_SLOT).unwrap_or_else(null_slot)),
                    // A quiet scope end (find-on-missing) still completed: it ran
                    // to its end, it just bound less on the way.
                    Ok(Flow::FellThrough) | Err(Stop::EndedQuietly) => Ended::Settled(null_slot()),
                    Err(Stop::Parked(_)) => Ended::Parked,
                    Err(other) => Ended::Failed(other),
                }
            })
        });
        let outcomes = join_all(flows.collect()).await;
        let mut ended = Vec::with_capacity(outcomes.len());
        for (outcome, state) in outcomes {
            self.trace.extend(state.trace);
            ended.push(outcome);
        }
        // The earliest arm's failure, once every arm has stopped.
        let mut settled: Vec<Option<Binding>> = Vec::with_capacity(ended.len());
        let mut parked: Vec<usize> = Vec::new();
        for (index, outcome) in ended.into_iter().enumerate() {
            match outcome {
                Ended::Failed(stop) => return Err(stop),
                Ended::Settled(value) => settled.push(Some(value)),
                Ended::Parked => {
                    settled.push(None);
                    parked.push(index);
                }
            }
        }
        let receipt = || Binding::Tuple(Rc::new(settled.iter().map(|slot| slot.clone().unwrap_or_else(null_slot)).collect()));
        let frame = at.encode();
        if expr.kind == CombinatorKind::Race {
            if settled.iter().any(Option::is_some) {
                // Stop listening on every arm still parked: one signal per
                // park, and the record behind it stays answerable.
                if !parked.is_empty() && self.serves("park.sink.cancelSubtrees") {
                    let subtrees: Vec<String> = parked.iter().map(|index| addresses[*index].encode()).collect();
                    self.ask(host::park::cancel_subtrees(self.segment(), &subtrees, None)).await.map_err(Stop::Thrown)?;
                }
                if let Some(name) = binding_name {
                    scope.declare(name, receipt());
                }
                return Ok(());
            }
            self.keep_arm_count(expr, &frame, arms.len()).await?;
            self.record_join(&frame, 1).await?;
            return Err(Stop::Parked(frame));
        }
        if !parked.is_empty() {
            self.keep_arm_count(expr, &frame, arms.len()).await?;
            // The arms that already finished keep their slots at the frame, as
            // a resumed arm's export does: the closer builds the receipt from
            // them all.
            for (index, slot) in settled.iter().enumerate() {
                let Some(value) = slot else { continue };
                let exports = crate::env::object_of(vec![(RETURN_SLOT, crate::park::serialize_alone(self, value).map_err(Stop::Thrown)?)]);
                self.persist_branch_export(&frame, &addresses[index].encode(), index as i64, &exports).await?;
            }
            self.record_join(&frame, parked.len()).await?;
            return Err(Stop::Parked(frame));
        }
        if let Some(name) = binding_name {
            scope.declare(name, receipt());
        }
        Ok(())
    }

    /// `keepArmCount`: a parked combinator whose arms were built at run time
    /// keeps how many there were at its frame (`FRAME_STATE_INDEX`).
    async fn keep_arm_count(&self, expr: &CombinatorExpression, frame: &str, arms: usize) -> Result<(), Stop> {
        if !matches!(expr.arms, CombinatorArms::Dynamic { .. }) {
            return Ok(());
        }
        let state = crate::env::object_of(vec![("arms", Js::Number(arms as f64))]);
        self.persist_branch_export(frame, frame, -1, &state).await
    }

    /// `park.sink?.persistBranchExport`, where the host keeps a park sink.
    pub(crate) async fn persist_branch_export(&self, frame: &str, branch: &str, index: i64, exports: &Js) -> Result<(), Stop> {
        if !self.serves("park.sink.persistBranchExport") {
            return Ok(());
        }
        let exports = self.encode(exports).map_err(Stop::Thrown)?;
        self.ask(host::park::persist_branch_export(self.segment(), frame, branch, index, exports)).await.map_err(Stop::Thrown)?;
        Ok(())
    }

    /// `park.sink?.recordJoin`, where the host keeps a park sink.
    pub(crate) async fn record_join(&self, frame: &str, parked: usize) -> Result<(), Stop> {
        if !self.serves("park.sink.recordJoin") {
            return Ok(());
        }
        self.ask(host::park::record_join(self.segment(), frame, parked)).await.map_err(Stop::Thrown)?;
        Ok(())
    }

    /// `resolveArms`: literal arms in place, or a collection of closures a
    /// value holds. `path` is the combinator's AST path.
    async fn resolve_arms(&self, expr: &CombinatorExpression, scope: &Rc<Scope>, path: &str) -> Result<Vec<Arm>, Stop> {
        let kind = match expr.kind {
            CombinatorKind::Race => "race",
            CombinatorKind::Parallel => "parallel",
        };
        match &expr.arms {
            CombinatorArms::Literal { arms, .. } => arms
                .iter()
                .enumerate()
                .map(|(index, arm)| self.arm_invocation(arm, kind, scope, &format!("{path}/arms/arms/{index}")))
                .collect(),
            CombinatorArms::Dynamic { expr: slot, .. } => {
                let evaluated = self.evaluate_slot(slot, scope).await?.value;
                let entries = match &evaluated {
                    Js::Array(list) => list.items().clone(),
                    other => vec![other.clone()],
                };
                entries
                    .iter()
                    .enumerate()
                    .map(|(index, entry)| match crate::record::binding_of(entry) {
                        Some(Binding::Closure(closure)) => Ok(Arm {
                            body: Rc::new(closure.code.ast.body.clone()),
                            path: format!("{}/body", closure.code.path),
                            captured: Some(closure.captured.clone()),
                            name: None,
                            runtime: Some(closure.code.clone()),
                        }),
                        _ => Err(Stop::Thrown(Failure::engine(
                            "MOVENG_RUNTIME",
                            format!("arm {index} of '{kind}' is not a function — a combinator runs what it is given, and this is {}", entry.type_of()),
                        ))),
                    })
                    .collect()
            }
        }
    }

    /// `armInvocation`: one literal arm. `path` is the arm's AST path.
    fn arm_invocation(&self, arm: &ArmExpression, kind: &str, scope: &Rc<Scope>, path: &str) -> Result<Arm, Stop> {
        match arm {
            // Written in place: it captures the scope around it, which the
            // arm's scope is a child of, so there is nothing extra to carry.
            ArmExpression::Closure { closure, .. } => {
                Ok(Arm { body: Rc::new(closure.body.clone()), path: format!("{path}/closure/body"), captured: None, name: None, runtime: None })
            }
            ArmExpression::Ref { name, .. } => match scope.resolve(name) {
                Some(Binding::Closure(closure)) => Ok(Arm {
                    body: Rc::new(closure.code.ast.body.clone()),
                    path: format!("{}/body", closure.code.path),
                    captured: Some(closure.captured.clone()),
                    name: Some(name.clone()),
                    runtime: None,
                }),
                Some(Binding::Movement(declared)) => {
                    let (declaration, declared_at) = self.declaration(&declared)?;
                    if !declaration.params.is_empty() {
                        return Err(Stop::Thrown(Failure::engine(
                            "MOVENG_RUNTIME",
                            format!(
                                "'{name}' takes {} argument(s), and '{kind}' calls its arms with none — the checker should have caught this",
                                declaration.params.len()
                            ),
                        )));
                    }
                    // A movement runs against the file scope it was declared
                    // in, not the one that named it here.
                    let file = self.file_scope.borrow().clone().map(|file| file.capture());
                    Ok(Arm { body: Rc::new(declaration.body), path: format!("/statements/{declared_at}/body"), captured: file, name: Some(name.clone()), runtime: None })
                }
                other => {
                    let what = other.as_ref().map_or_else(|| "not in scope".to_string(), crate::record::describe);
                    Err(Stop::Thrown(Failure::engine(
                        "MOVENG_RUNTIME",
                        format!("'{name}' is {what}, and '{kind}' runs its arms — an arm has to be a function. The checker should have caught this."),
                    )))
                }
            },
        }
    }

    /// `runArm`: one arm in its own branch scope, as a call by its name.
    async fn run_arm(&self, arm: &Arm, env: &Rc<Scope>, address: &Address) -> Result<Flow, Stop> {
        if let Some(captured) = &arm.captured {
            for (name, binding) in captured.own_bindings() {
                env.declare(name, binding);
            }
        }
        self.within_named_call(arm.name.as_deref(), self.body(&arm.body, env, address, &arm.path, 0)).await
    }

    /// `withinNamedCall`: `future` run as a call of the function `name` (from
    /// version 3), counted towards the call depth, on this flow's stack.
    pub(crate) async fn within_named_call<T>(&self, name: Option<&str>, future: impl std::future::Future<Output = Result<T, Stop>>) -> Result<T, Stop> {
        let Some(name) = name.filter(|_| self.version() >= 3) else { return future.await };
        self.enter_named_call(name)?;
        self.within_called_name(Some(name), future).await
    }

    /// `withinCalledName`: `future` run with `name` on this flow's stack
    /// (from version 3), not measured against the limit.
    pub(crate) async fn within_called_name<T>(&self, name: Option<&str>, future: impl std::future::Future<Output = T>) -> T {
        let Some(name) = name.filter(|_| self.version() >= 3) else { return future.await };
        self.call_stack.borrow_mut().push(name.to_string());
        let outcome = future.await;
        self.call_stack.borrow_mut().pop();
        outcome
    }

    /// `x = (…) => { … }`: the closure, its scope captured as it stands, and
    /// from version 3 the name its body may call it by.
    pub(crate) fn closure_binding(&self, closure: &ClosureExpression, name: Option<&str>, scope: &Rc<Scope>, path: &str) -> Binding {
        Binding::Closure(Rc::new(Closure {
            code: Code { ast: Rc::new(closure.clone()), path: path.to_string() },
            captured: scope.capture(),
            self_name: name.filter(|_| self.version() >= 3).map(String::from),
        }))
    }

    /// `invokeClosure`: its captured scope, its parameters bound from
    /// `values` (a record as itself), its body at `address`.
    pub(crate) async fn invoke_closure(&self, closure: &Rc<Closure>, values: &[(String, Js)], address: &Address) -> Result<(Flow, Rc<Scope>), Stop> {
        let bound = values.iter().filter(|(_, v)| !v.is_nullish()).map(|(name, v)| (name.clone(), crate::record::bind_value(v.clone(), Some(Trail::default()), false))).collect();
        self.invoke_closure_bound(closure, bound, address).await
    }

    /// `invokeClosure` handed bindings (a named call's arguments, each
    /// already the binding `bindValue` makes of it); a parameter handed
    /// none binds null.
    pub(crate) async fn invoke_closure_bound(&self, closure: &Rc<Closure>, bound: Vec<(String, Binding)>, address: &Address) -> Result<(Flow, Rc<Scope>), Stop> {
        let child = closure.captured.child();
        // Its own name first, so a parameter of the same name shadows it.
        if let Some(name) = &closure.self_name {
            child.declare(name.clone(), Binding::Closure(closure.clone()));
        }
        for param in &closure.code.ast.params {
            let binding = bound
                .iter()
                .find(|(name, _)| *name == param.name)
                .map(|(_, b)| b.clone())
                .unwrap_or_else(|| crate::record::bind_value(Js::Null, Some(Trail::default()), false));
            child.declare(param.name.clone(), binding);
        }
        let path = format!("{}/body", closure.code.path);
        let flow = self.body(&closure.code.ast.body, &child, address, &path, 0).await?;
        Ok((flow, child))
    }
}

