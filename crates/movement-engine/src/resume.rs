//! A parked flow resumed (run.ts `resumeAlongAddress`): the movement's body
//! descended along the leaf's address, each scope it passes rehydrated from
//! the state, the leaf's rule run (bind and step past, or re-enter), then
//! every level the descent passed through finished from the inside out
//! (`completeSpine`), exactly as it would have run had the run never parked.
//!
//! The address does the routing: `s i` a statement (the last is the leaf's);
//! `b k` an `if` arm or a combinator's arm; `i j` a fan-out's iteration;
//! `c k` the k-th call the statement made — a called body, or a collection
//! op whose next `i j` is the member. Each `b`/`i` step is one child scope
//! of the current body's chain; a `c` step starts a new body, whose chain
//! and boundary come off the state's `frames`, in order.
//!
//! Finishing a level: an `if` arm's `return` returns from its body; a join
//! (a fan-out, a `parallel`) keeps this branch's exports, decrements its
//! frame, and only the branch that closes it merges every branch's exports
//! into the parent and runs on; a `race` arm that completes first wins: the
//! arms still parked stop being listened on, the receipt is bound, and the
//! race's continuation runs (deferred instead, in a batch resume). A call
//! level hands what the callee returned back to its statement, which runs
//! again, its earlier calls replayed; a member level joins its op, and the
//! member that closes the op runs the members never started and hands the
//! op's answer back to its statement.
//!
//! Two more entries share the descent: a fired callback's body (the leaf is
//! its mint; nothing after it runs) and a race settled after a batch resume
//! (the leaf is the race).

use std::cell::RefCell;
use std::rc::Rc;

use movement_parser::ast::{CallbackSubject, CallStatement, CombinatorArms, CombinatorExpression, CombinatorKind, MovementDeclaration, RValue, Statement, TraversalBlock};

use crate::bindings::{Binding, Closure, DeferredWalk, Edge, Handle, InstanceBinding, Landed, Node, Scope};
use crate::collection::{CollectionRun, OpCode, OpOrigin};
use crate::combinator::null_slot;
use crate::env::{Trail, ValueBinding};
use crate::flow::{Boundary, CallRecord, Code, Site};
use crate::host;
use crate::js::{Js, JsObject};
use crate::park::{ParkReader, at, id_of, items, landing_shape_of, pairs, parse_address, text};
use crate::run::{Address, Failure, Flow, RETURN_SLOT, Run, Stop};
use crate::write::WriteRecord;
use serde_json::Value as Json;

/// What a resume does at its leaf statement (`ResumeLeaf`).
pub(crate) enum Leaf {
    /// Bind the answer and step past the leaf, or re-enter it.
    Continue { answer: Option<Binding>, reenter: bool },
    /// Run a fired callback's body (the leaf is its mint).
    FireCallback { values: Js, call_index: usize },
    /// Settle a race whose arms completed in a batch (the leaf is the race).
    SettleRace { frame: String },
}

/// A statement sequence the descent passed through, and the statement in it
/// the descent went into.
#[derive(Clone)]
struct Sequence {
    statements: Rc<Vec<Statement>>,
    scope: Rc<Scope>,
    address: Address,
    path: String,
    index: usize,
}

/// One level the descent passed through (`ResumeSpineFrame`).
enum Spine {
    Container {
        parent: Sequence,
        container: Box<Statement>,
        container_path: String,
        container_address: Address,
        descent: char,
        child: Rc<Scope>,
        branch_address: Address,
        branch_index: usize,
        arm_boundary: Option<Boundary>,
        arm_name: Option<String>,
    },
    Call {
        caller: Sequence,
        boundary: Boundary,
        site: Rc<Site>,
        index: usize,
        next: usize,
        callee: String,
        /// The callee body's scope, which its `return` lands in.
        scope: Rc<Scope>,
    },
    Member {
        caller: Sequence,
        boundary: Boundary,
        site: Rc<Site>,
        index: usize,
        next: usize,
        member: usize,
        run: CollectionRun,
        /// The member body's scope.
        scope: Rc<Scope>,
    },
}

/// How finishing a level ended (`SpineCompletion`): its body's outcome, or
/// stopped, the run staying parked (a join not yet closed, a race already
/// won, a deferred settlement).
enum Completion {
    Done(Flow),
    Stopped,
}

/// What runs at the leaf once the descent reached it.
enum LeafRun {
    /// Re-enter the leaf statement, its finished calls replayed.
    Reenter { at: Sequence, replay: Vec<(usize, CallRecord)> },
    /// The rest of the body once the leaf finished (`continueAfter`).
    After(Sequence),
    /// The race statement settled, then the rest of its body.
    SettleRace { at: Sequence, frame: String },
}

type Pinned<'s, T> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, Stop>> + 's>>;

/// Code a parked state carries as its syntax tree (docs/contracts/
/// park-state.md), read back as the AST it was written from, with the tree
/// as it was parked. Admission refuses a state whose code does not read
/// (`park::resume_refusal`), so this engine's own failure here is one the
/// TypeScript would not meet.
fn parked_tree<T: serde::de::DeserializeOwned>(tree: Option<&Js>, what: &str) -> Result<(T, Json), Stop> {
    let tree = tree.map(crate::env::json_of_js).unwrap_or(Json::Null);
    match serde_json::from_value(tree.clone()) {
        Ok(ast) => Ok((ast, tree)),
        Err(e) => Err(Stop::Thrown(Failure::unreproduced(&format!("resume: {what} the parked state carries ({e})"), "the Rust engine rebuilds parked code from its syntax tree"))),
    }
}

/// An AST as its tree.
fn to_tree<T: serde::Serialize>(ast: &T) -> Json {
    serde_json::to_value(ast).expect("an AST is always JSON")
}

/// Where a parked code ref says it is declared, as a refusal names it.
fn parked_file(descriptor: &Js) -> String {
    match text(at(descriptor, "file")).filter(|_| text(at(descriptor, "kind")) != Some("opaque")) {
        Some(path) => format!("library \"{path}\""),
        None => "program".to_string(),
    }
}

fn runtime(message: String) -> Stop {
    Stop::Thrown(Failure::engine("MOVENG_RUNTIME", message))
}

/// The address a resume descends (the state's, or a race frame's), when it
/// does not parse: `parseAddress`'s plain `Error`, which the TypeScript
/// raises before its interpreter runs, so it is the run's failure as it
/// stands, not a failure inside the run.
pub(crate) fn unparsed_address(state: &Js, leaf: &Leaf) -> Option<Failure> {
    let state_address = match leaf {
        Leaf::SettleRace { frame } => frame.clone(),
        _ => text(at(state, "address")).unwrap_or("").to_string(),
    };
    if parse_address(&state_address).is_some() {
        return None;
    }
    let token = state_address.split('.').find(|t| parse_address(t).is_none()).unwrap_or("");
    Some(Failure::Engine { class: crate::eval::ErrorClass::Error, message: format!("malformed address token '{token}' in '{state_address}'") })
}

impl Run<'_> {
    /// `resume`, `fireCallback` or `settleRaceFrame`: the state's leaf, by
    /// its rule.
    pub(crate) async fn resume_along(&self, movement: &MovementDeclaration, movement_scope: &Rc<Scope>, body_path: &str, state: &Js, leaf: Leaf) -> Result<(), Stop> {
        let state_address = match &leaf {
            Leaf::SettleRace { frame } => frame.clone(),
            _ => text(at(state, "address")).unwrap_or("").to_string(),
        };
        let address = parse_address(&state_address).ok_or_else(|| {
            let token = state_address.split('.').find(|t| parse_address(t).is_none()).unwrap_or("");
            Stop::Thrown(Failure::Engine { class: crate::eval::ErrorClass::Error, message: format!("malformed address token '{token}' in '{state_address}'") })
        })?;
        let shown = encode(&address);
        let malformed = |why: &str| runtime(format!("malformed parked address '{shown}' — {why}"));
        if address.last().is_none_or(|(kind, _)| *kind != 's') {
            return Err(malformed("a parked leaf ends at a statement"));
        }
        let frames = items(at(state, "frames"));
        // Each body the address passes into keeps its own chain of scopes:
        // an outer body's rides on the frame that leaves it, the innermost
        // is the state's own.
        let mut chains: Vec<Vec<Js>> = frames.iter().filter(|f| text(at(f, "kind")) != Some("arm")).map(|f| items(at(f, "scopeChain"))).collect();
        chains.push(items(at(state, "scopeChain")));
        // A library's file scope is not rebuilt (the live one is used), so a
        // declaration parked under a library the re-parsed program does not
        // link would resolve silently: refuse it here, whatever the offset.
        for scope in chains.iter().flatten() {
            for (_, entry) in pairs(at(scope, "bindings")) {
                if matches!(text(at(entry, "kind")), Some("shape" | "movement" | "fileClosure"))
                    && let Some(path) = text(at(entry, "file"))
                    && self.checked.file(&crate::program::DeclaringFile::Library(path.to_string())).is_none()
                {
                    return Err(runtime(format!("resume: the parked state names the library \"{path}\", which the re-parsed program does not link")));
                }
            }
        }
        // The whole state was written as one park, so it is read as one.
        let park = ParkReader::over_state(state);
        let mut segment = 0;
        let mut next_frame = 0;
        let mut take_frame = || -> Result<Js, Stop> {
            let frame = frames.get(next_frame).cloned().ok_or_else(|| malformed("it enters more bodies than its state records"))?;
            next_frame += 1;
            Ok(frame)
        };
        self.rehydrate_into(chains[0].get(1), movement_scope, &park).await?;

        let mut statements = Rc::new(movement.body.clone());
        let mut scope = movement_scope.clone();
        let mut frame_address = Address::default();
        let mut path = body_path.to_string();
        let mut chain_index = 2;
        let mut spine: Vec<Spine> = Vec::new();
        let mut i = 0;
        loop {
            let (kind, index) = address[i];
            if kind != 's' {
                return Err(malformed(&format!("step {i} is '{}', expected a statement", step_name(kind))));
            }
            if i == address.len() - 1 {
                break;
            }
            let stmt_address = frame_address.stmt(index);
            let (descent, descent_index) = address[i + 1];
            let caller = Sequence { statements: statements.clone(), scope: scope.clone(), address: frame_address.clone(), path: path.clone(), index };
            if descent == 'c' {
                let frame = take_frame()?;
                let frame_kind = text(at(&frame, "kind")).unwrap_or("");
                if frame_kind == "arm" || id_of(at(&frame, "index")) != Some(descent_index as u64) {
                    return Err(malformed(&format!("its call step {descent_index} has no matching frame")));
                }
                let next = id_of(at(&frame, "next")).unwrap_or(0) as usize;
                let journal = self.rehydrate_journal(&items(at(&frame, "journal")), &park).await?;
                let site = Rc::new(Site { address: stmt_address.clone(), scope: scope.clone(), calls: RefCell::new(crate::flow::Calls { next, completed: journal, replay: Vec::new() }) });
                segment += 1;
                let chain = chains.get(segment).cloned().unwrap_or_default();
                let call_address = stmt_address.call(descent_index);
                if frame_kind == "call" {
                    let callee = text(at(&frame, "callee")).unwrap_or("").to_string();
                    let (root, body, body_path) = match scope.resolve(&callee) {
                        Some(Binding::Movement(declared)) => {
                            let (declaration, body_path) = self.declaration(&declared)?;
                            let file = self.scope_of_file(&declared.file).ok_or_else(|| runtime("no file scope for a movement call".into()))?;
                            (file, Rc::new(declaration.body), body_path)
                        }
                        Some(Binding::Closure(closure)) => (closure.call_root(), Rc::new(closure.code.ast.body.clone()), format!("{}/body", closure.code.path)),
                        _ => return Err(malformed(&format!("'{callee}' is no longer a function in the calling scope"))),
                    };
                    let callee_scope = root.child_written_in(crate::program::file_of_path(&body_path).0);
                    let offset = root.chain_from_root().len();
                    self.rehydrate_into(chain.get(offset), &callee_scope, &park).await?;
                    let boundary = Boundary::Call { site: site.clone(), index: descent_index, next, callee: callee.clone() };
                    spine.push(Spine::Call { caller, boundary, site, index: descent_index, next, callee, scope: callee_scope.clone() });
                    statements = body;
                    scope = callee_scope;
                    chain_index = offset + 1;
                    frame_address = call_address;
                    path = body_path;
                    i += 2;
                    continue;
                }
                // A collection op: the next step names the member.
                let Some(&('i', member)) = address.get(i + 2) else {
                    return Err(malformed(&format!("its collection op at call {descent_index} names no member")));
                };
                let op_json = at(&frame, "op").cloned().unwrap_or(Js::Undefined);
                let container = caller.statements.get(index).cloned().ok_or_else(|| malformed("its collection op's statement is not in the program"))?;
                let (op, origin) = self
                    .op_in_statement(&container, &format!("{}/{index}", caller.path), &op_json, &caller.scope)?
                    .ok_or_else(|| malformed(&format!("its collection op at call {descent_index} is not in its statement")))?;
                let spelling = crate::collection::spelling(op.op);
                let function = self.collection_function(&op.r#fn, spelling, &caller.scope, &origin_fn_path(&origin))?;
                let (on_error, concurrency, initial) = crate::collection::settings(op.config.as_ref()).map_err(|problem| {
                    runtime(format!("'{spelling}' was given settings it cannot run with — the checker should have caught this: {problem}"))
                })?;
                // The member's scopes chain from the function's own, which a
                // park writes ahead of them: one scope for a snapshot, the
                // whole chain for a closure that holds its scope.
                let root = function.call_root();
                let member_scope = root.child_written_in(crate::program::file_of_path(function.body_path()).0);
                let offset = root.chain_from_root().len();
                self.rehydrate_into(chain.get(offset), &member_scope, &park).await?;
                let body = Rc::new(function.body_statements().to_vec());
                let body_path = function.body_path().to_string();
                let run = CollectionRun {
                    op: Rc::new(OpCode { op: op.clone(), json: op_json }),
                    on_error,
                    function,
                    address: call_address.clone(),
                    site: Some(site.clone()),
                    index: descent_index,
                    members: Vec::new(),
                    source_trail: Trail::default(),
                    init: Js::Null,
                    concurrency: crate::collection::width(concurrency),
                    initial: crate::collection::width(initial),
                };
                let boundary = Boundary::Member { site: site.clone(), index: descent_index, next, member, op: run.op.clone() };
                spine.push(Spine::Member { caller, boundary, site, index: descent_index, next, member, run, scope: member_scope.clone() });
                statements = body;
                scope = member_scope;
                chain_index = offset + 1;
                frame_address = call_address.iter(member);
                path = body_path;
                i += 3;
                continue;
            }
            // A container statement: the next step descends into it.
            let container = statements.get(index).cloned().ok_or_else(|| runtime(format!("resume: the parked address '{shown}' names no statement {index}")))?;
            let container_path = format!("{path}/{index}");
            let combinator = combinator_of(&container, &container_path);
            let mut arm_boundary = None;
            let (body, body_address, body_path) = match &combinator {
                Some((expr, _)) if descent == 'b' && matches!(expr.arms, CombinatorArms::Dynamic { .. }) => {
                    let frame = take_frame()?;
                    if text(at(&frame, "kind")) != Some("arm") || id_of(at(&frame, "arm")) != Some(descent_index as u64) {
                        return Err(malformed(&format!("its run-time arm {descent_index} has no matching frame")));
                    }
                    let (code, _) = self.closure_code(at(&frame, "body"))?;
                    arm_boundary = Some(Boundary::Arm { arm: descent_index, body: code.clone() });
                    (Rc::new(code.ast.body.clone()), stmt_address.branch(descent_index), format!("{}/body", code.path))
                }
                _ => self.descend_for_resume(&container, &container_path, descent, descent_index, &stmt_address, &state_address, &scope)?,
            };
            let arm_name = match &combinator {
                Some((expr, _)) if descent == 'b' => match &expr.arms {
                    CombinatorArms::Literal { arms, .. } => match arms.get(descent_index) {
                        Some(movement_parser::ast::ArmExpression::Ref { name, .. }) => Some(name.clone()),
                        _ => None,
                    },
                    CombinatorArms::Dynamic { .. } => None,
                },
                _ => None,
            };
            let child = scope.child();
            self.rehydrate_into(chains.get(segment).and_then(|chain| chain.get(chain_index)), &child, &park).await?;
            chain_index += 1;
            spine.push(Spine::Container {
                parent: caller,
                container: Box::new(container),
                container_path,
                container_address: stmt_address,
                descent,
                child: child.clone(),
                branch_address: body_address.clone(),
                branch_index: descent_index,
                arm_boundary,
                arm_name,
            });
            statements = body;
            scope = child;
            frame_address = body_address;
            path = body_path;
            i += 2;
        }

        let leaf_index = address[address.len() - 1].1;
        let leaf_at = Sequence { statements: statements.clone(), scope: scope.clone(), address: frame_address.clone(), path: path.clone(), index: leaf_index };
        // Read whenever it was written, used or not: a node first written in
        // the journal is the one the scopes' references name.
        let journal = match at(state, "journal") {
            Some(journal) => Some(self.rehydrate_journal(&items(Some(journal)), &park).await?),
            None => None,
        };
        park.assert_read().map_err(runtime)?;
        match leaf {
            Leaf::FireCallback { values, call_index } => {
                self.firing_callback.set(true);
                let leaf_statement = statements.get(leaf_index).cloned();
                self.inside_spine(&spine, self.callback_body(leaf_statement.as_ref(), &leaf_at, &values, call_index)).await
            }
            Leaf::SettleRace { frame } => {
                let leaf_run = LeafRun::SettleRace { at: leaf_at, frame };
                self.complete_spine(&spine, 0, &state_address, &leaf_run).await.map(|_| ())
            }
            Leaf::Continue { answer, reenter } => {
                let binding_name = text(at(state, "bindingName"));
                if !reenter && matches!(at(state, "presenceBind"), Some(Js::Bool(true))) && let Some(name) = binding_name {
                    scope.declare(name, Binding::Value(ValueBinding { value: Js::Bool(true), trail: Some(Trail::default()), many: false }));
                } else if !reenter && let (Some(name), Some(answer)) = (binding_name, answer) {
                    scope.declare(name, answer);
                }
                let leaf_run = if reenter { LeafRun::Reenter { at: leaf_at, replay: journal.unwrap_or_default() } } else { LeafRun::After(leaf_at) };
                self.complete_spine(&spine, 0, &state_address, &leaf_run).await.map(|_| ())
            }
        }
    }

    /// `descendForResume`: one `i j` or `b k` step into its body, the address
    /// it lands on, and the body's AST path.
    #[allow(clippy::too_many_arguments)]
    fn descend_for_resume(&self, container: &Statement, container_path: &str, step: char, index: usize, stmt_address: &Address, parked: &str, scope: &Rc<Scope>) -> Result<(Rc<Vec<Statement>>, Address, String), Stop> {
        if step == 'i' {
            let Some((block, block_path)) = fan_out_block_of(container, container_path) else {
                return Err(runtime(format!("resume: address descends 'iter' into a non-fan-out statement (parked '{parked}')")));
            };
            return Ok((Rc::new(block.body.clone()), stmt_address.iter(index), format!("{block_path}/body")));
        }
        // Any other step reads as a branch (`descendForResume`).
        if let Statement::If(statement) = container {
            let (body, body_path) = match statement.arms.get(index) {
                Some(arm) => (arm.body.clone(), format!("{container_path}/arms/{index}/body")),
                None => match &statement.else_arm {
                    Some(arm) => (arm.body.clone(), format!("{container_path}/elseArm/body")),
                    None => return Err(runtime(format!("resume: if branch {index} has no body (parked '{parked}')"))),
                },
            };
            return Ok((Rc::new(body), stmt_address.branch(index), body_path));
        }
        if let Some((combinator, combinator_path)) = combinator_of(container, container_path) {
            // `armBodyAt`: a closure written in place, or a name resolved in
            // the scope around the combinator — a movement, or a body closure.
            let body = match &combinator.arms {
                CombinatorArms::Literal { arms, .. } => match arms.get(index) {
                    Some(movement_parser::ast::ArmExpression::Closure { closure, .. }) => Some((closure.body.clone(), format!("{combinator_path}/arms/arms/{index}/closure/body"))),
                    Some(movement_parser::ast::ArmExpression::Ref { name, .. }) => match scope.resolve(name) {
                        Some(Binding::Movement(declared)) => self.declaration(&declared).ok().map(|(d, path)| (d.body, path)),
                        Some(Binding::Closure(closure)) => Some((closure.code.ast.body.clone(), format!("{}/body", closure.code.path))),
                        _ => None,
                    },
                    None => None,
                },
                CombinatorArms::Dynamic { .. } => None,
            };
            let Some((body, body_path)) = body else {
                return Err(runtime(format!("resume: no body for arm {index} of this combinator (parked '{parked}')")));
            };
            return Ok((Rc::new(body), stmt_address.branch(index), body_path));
        }
        Err(runtime(format!("resume: address descends 'branch' into a '{}' statement (parked '{parked}')", statement_kind(container))))
    }

    /// The collection op a member frame names, in its statement: written
    /// as an op, or a call of one (version 3), by its span.
    fn op_in_statement(&self, statement: &Statement, path: &str, op_json: &Js, scope: &Rc<Scope>) -> Result<Option<(movement_parser::ast::CollectionOpExpression, OpOrigin)>, Stop> {
        let span = crate::record::get(op_json, "span").ok().and_then(|s| crate::code::span_json(&s)).map(|(span, _)| span);
        let (value, value_path) = match statement {
            Statement::Collection(collection) if Some(collection.collection.span) == span => {
                return Ok(Some((collection.collection.clone(), OpOrigin::Written(format!("{path}/collection")))));
            }
            Statement::Call(call) => {
                return match self.op_of_call(call, scope)? {
                    Some(op) if Some(op.span) == span => Ok(Some((op, OpOrigin::Call { call: call.clone(), path: path.to_string() }))),
                    _ => self.nested_op_in_statement(statement, span, scope),
                };
            }
            Statement::Assign(assign) => (&assign.value, format!("{path}/value")),
            Statement::Return(ret) => (&ret.value, format!("{path}/value")),
            _ => return self.nested_op_in_statement(statement, span, scope),
        };
        Ok(match value {
            RValue::Collection { collection } if Some(collection.span) == span => Some((collection.clone(), OpOrigin::Written(format!("{value_path}/collection")))),
            RValue::Call { call } => match self.op_of_call(call, scope)? {
                Some(op) if Some(op.span) == span => Some((op, OpOrigin::Call { call: call.clone(), path: format!("{value_path}/call") })),
                _ => self.nested_op_in_statement(statement, span, scope)?,
            },
            _ => self.nested_op_in_statement(statement, span, scope)?,
        })
    }

    /// A collection op called inside one of the statement's expressions
    /// (crate::nested), by its span: read again from its slot, at its place.
    fn nested_op_in_statement(&self, statement: &Statement, span: Option<movement_parser::ast::Span>, scope: &Rc<Scope>) -> Result<Option<(movement_parser::ast::CollectionOpExpression, OpOrigin)>, Stop> {
        if self.version() < 3 || span.is_none() {
            return Ok(None);
        }
        for slot in crate::admit::direct_slots(statement) {
            let Ok(tree) = movement_parser::expr::parse_expression(&slot.raw) else { continue };
            let calls = crate::nested::staged_calls(&tree, &|call| self.runs_as_call(call, scope));
            for at in calls {
                let Ok(value) = crate::nested::nested_call(&slot, at, self.version()) else { continue };
                let RValue::Call { call } = &value else { continue };
                if let Some(op) = self.op_of_call(call, scope)?
                    && Some(op.span) == span
                {
                    let path = self.nested_path(&slot, at, &value, &scope.written_in());
                    return Ok(Some((op, OpOrigin::Call { call: call.clone(), path: format!("{path}/value/call") })));
                }
            }
        }
        Ok(None)
    }

    fn op_of_call(&self, call: &CallStatement, scope: &Rc<Scope>) -> Result<Option<movement_parser::ast::CollectionOpExpression>, Stop> {
        let binds = scope.resolve(&call.callee).is_some() || scope.resolve_function(&call.callee).is_some();
        match crate::collection::reading(call, binds, self.version()) {
            Ok(Some(crate::collection::Reading::Collection(op))) => Ok(Some(op)),
            Ok(_) => Ok(None),
            Err(refusal) => Err(runtime(format!("{refusal} — the checker should have caught this"))),
        }
    }

    // ── Finishing the spine ──

    /// `insideSpine`: `future` run inside every boundary the descent passed
    /// — what a leaf that does not finish its spine still needs, so a park
    /// inside it records them.
    async fn inside_spine<T>(&self, spine: &[Spine], future: impl std::future::Future<Output = T>) -> T {
        let mut pushed = 0;
        for level in spine {
            let boundary = match level {
                Spine::Container { arm_boundary, .. } => arm_boundary.clone(),
                Spine::Call { boundary, .. } | Spine::Member { boundary, .. } => Some(boundary.clone()),
            };
            if let Some(boundary) = boundary {
                self.boundaries.borrow_mut().push(boundary);
                pushed += 1;
            }
        }
        let outcome = future.await;
        for _ in 0..pushed {
            self.boundaries.borrow_mut().pop();
        }
        outcome
    }

    /// `completeSpine`: the leaf, then every level from the inside out,
    /// each run within its own boundary so a re-park deeper records how to
    /// get back.
    fn complete_spine<'s>(&'s self, spine: &'s [Spine], level: usize, leaf_address: &'s str, leaf: &'s LeafRun) -> Pinned<'s, Completion> {
        Box::pin(async move {
            let Some(frame) = spine.get(level) else { return self.run_leaf(leaf).await.map(Completion::Done) };
            let inner = self.complete_spine(spine, level + 1, leaf_address, leaf);
            match frame {
                Spine::Container { arm_boundary, arm_name, .. } => {
                    let arm = self.within_called_name(arm_name.as_deref(), inner);
                    let completed = match arm_boundary {
                        Some(boundary) => self.within_boundary(boundary.clone(), arm).await?,
                        None => arm.await?,
                    };
                    let Completion::Done(flow) = completed else { return Ok(Completion::Stopped) };
                    self.finish_container(frame, flow, leaf_address).await
                }
                Spine::Call { .. } => self.finish_resumed_call(frame, inner).await,
                Spine::Member { .. } => self.finish_resumed_member(frame, inner, leaf_address).await,
            }
        })
    }

    /// The leaf's own rule.
    async fn run_leaf(&self, leaf: &LeafRun) -> Result<Flow, Stop> {
        match leaf {
            LeafRun::Reenter { at, replay } => self.body_from(&at.statements, &at.scope, &at.address, &at.path, at.index, replay.clone()).await,
            LeafRun::After(at) => self.continue_after(at).await,
            LeafRun::SettleRace { at, frame } => {
                self.settle_race_at(at.statements.get(at.index), &format!("{}/{}", at.path, at.index), frame, &at.scope).await?;
                self.continue_after(at).await
            }
        }
    }

    /// `continueAfter`: the rest of a body once its statement `index`
    /// finished; a `return` there returns.
    async fn continue_after(&self, at: &Sequence) -> Result<Flow, Stop> {
        if let Some(Statement::Return(_)) = at.statements.get(at.index) {
            let value = at.scope.resolve_own(RETURN_SLOT).unwrap_or_else(null_slot);
            at.scope.declare(RETURN_SLOT, value);
            return Ok(Flow::Returned);
        }
        self.body(&at.statements, &at.scope, &at.address, &at.path, at.index + 1).await
    }

    /// `finishContainer`.
    async fn finish_container(&self, frame: &Spine, flow: Flow, leaf_address: &str) -> Result<Completion, Stop> {
        let Spine::Container { parent, container, container_path, container_address, descent, child, branch_address, branch_index, .. } = frame else {
            unreachable!("a container level")
        };
        // The join-aware unwind needs the park sink; without one only the
        // leaf's own block completes.
        if !self.serves("park.sink.decrementJoin") {
            return Ok(Completion::Stopped);
        }
        let combinator = if *descent == 'b' { combinator_of(container, container_path) } else { None };
        let is_race = combinator.as_ref().is_some_and(|(c, _)| c.kind == CombinatorKind::Race);
        let is_join = *descent == 'i' || combinator.as_ref().is_some_and(|(c, _)| c.kind == CombinatorKind::Parallel);
        let frame_address = container_address.encode();
        if is_race || is_join {
            // This branch's exports kept before the decrement, so by the time
            // any branch learns it closed the frame, every sibling's are in.
            let exports = self.branch_exports(child, container, *descent)?;
            self.persist_branch_export(&frame_address, &branch_address.encode(), *branch_index as i64, &exports).await?;
            let closed = self.decrement_join(&frame_address, &branch_address.encode(), leaf_address).await?;
            if is_race {
                // Batch mode: this branch won, but others in the same pass
                // may complete too; the settlement waits for them all.
                if self.input.resume.as_ref().is_some_and(|r| r.defer_race_settlement) {
                    let mut deferred = self.deferred_race_frames.borrow_mut();
                    if !deferred.contains(&frame_address) {
                        deferred.push(frame_address);
                    }
                    return Ok(Completion::Stopped);
                }
                if !closed {
                    return Ok(Completion::Stopped);
                }
                let (combinator, _) = combinator.expect("a race");
                self.settle_race_winner(&combinator, container, container_address, &parent.scope, leaf_address).await?;
            } else {
                if !closed {
                    return Ok(Completion::Stopped);
                }
                self.merge_join_branch(container, container_path, container_address, &parent.scope).await?;
            }
            return self.continue_after(parent).await.map(Completion::Done);
        }
        // An `if` arm: block-scoped, transparent to `return`.
        if let Flow::Returned = flow {
            let value = child.resolve_own(RETURN_SLOT).unwrap_or_else(null_slot);
            parent.scope.declare(RETURN_SLOT, value);
            return Ok(Completion::Done(Flow::Returned));
        }
        self.continue_after(parent).await.map(Completion::Done)
    }

    /// `finishResumedCall`: the callee's body finished, so the call hands
    /// back what it returned — and the calling statement runs again, its
    /// earlier calls replayed and this one handing back that value.
    async fn finish_resumed_call(&self, frame: &Spine, inner: Pinned<'_, Completion>) -> Result<Completion, Stop> {
        let Spine::Call { caller, boundary, site, index, next, callee, scope } = frame else { unreachable!("a call level") };
        self.call_stack.borrow_mut().push(callee.clone());
        let completed = match self.within_boundary(boundary.clone(), inner).await {
            Err(Stop::EndedQuietly) => Ok(Completion::Done(Flow::FellThrough)),
            other => other,
        };
        self.call_stack.borrow_mut().pop();
        let Completion::Done(flow) = completed? else { return Ok(Completion::Stopped) };
        let value = match flow {
            Flow::Returned => scope.resolve_own(RETURN_SLOT),
            Flow::FellThrough => None,
        };
        self.rerun_statement(caller, site, *index, CallRecord { value, next: *next }).await.map(Completion::Done)
    }

    /// `rerunStatement`: the calling statement run again, the call a park
    /// was inside handing back `record`, every call finished before it
    /// replaying its kept value, then the rest of its body.
    async fn rerun_statement(&self, caller: &Sequence, site: &Rc<Site>, index: usize, record: CallRecord) -> Result<Flow, Stop> {
        let mut replay = site.calls.borrow().completed.clone();
        match replay.iter_mut().find(|(i, _)| *i == index) {
            Some(slot) => slot.1 = record,
            None => replay.push((index, record)),
        }
        self.body_from(&caller.statements, &caller.scope, &caller.address, &caller.path, caller.index, replay).await
    }

    /// `finishResumedMember`: the member's answer joins its op's frame; the
    /// member that closes it finishes the op (the members never started,
    /// the answer in member order) and hands it back to its statement.
    async fn finish_resumed_member(&self, frame: &Spine, inner: Pinned<'_, Completion>, leaf_address: &str) -> Result<Completion, Stop> {
        let Spine::Member { caller, boundary, site, index, next, member, run, scope } = frame else { unreachable!("a member level") };
        let spelling = crate::collection::spelling(run.op.op.op);
        let state = self.open_flow(self.fork_writes().branch(*member));
        let named = run.function.named_call().map(String::from);
        let flowed = async {
            let completed = self.within_boundary(boundary.clone(), self.within_called_name(named.as_deref(), inner)).await?;
            let Completion::Done(flow) = completed else { return Ok(None) };
            self.member_answer_of(run, flow, scope).map(Some)
        };
        let (outcome, mut state) = self.in_flow(state, flowed).await;
        let answer = match outcome {
            Ok(None) => {
                self.trace.extend(state.trace);
                return Ok(Completion::Stopped);
            }
            Ok(Some(value)) => Some(value),
            Err(Stop::Thrown(failure)) if run.on_error != crate::collection::OnError::Error && crate::collection::is_member_failure(&failure) => {
                if run.on_error == crate::collection::OnError::Warn {
                    state.trace.push(crate::collection::member_left_out(spelling, *member, None, &failure));
                }
                None
            }
            Err(other) => {
                self.trace.extend(state.trace);
                return Err(other);
            }
        };
        self.trace.extend(state.trace);
        if !self.serves("park.sink.decrementJoin") {
            return Ok(Completion::Stopped);
        }
        let frame_address = run.address.encode();
        let branch_address = run.address.iter(*member).encode();
        let exports = crate::collection::member_answer_export(self, answer.as_ref()).map_err(Stop::Thrown)?;
        self.persist_branch_export(&frame_address, &branch_address, *member as i64, &exports).await?;
        if !self.decrement_join(&frame_address, &branch_address, leaf_address).await? {
            return Ok(Completion::Stopped);
        }
        let (resumed, answers) = self.resumed_collection_run(run, &frame_address).await?;
        let pending: Vec<usize> = (0..resumed.members.len()).filter(|i| answers[*i].is_none()).collect();
        let value = self.run_members(&resumed, &pending, answers).await?;
        self.rerun_statement(caller, site, *index, CallRecord { value: Some(value), next: *next }).await.map(Completion::Done)
    }

    /// What a member's body handed back as its answer.
    fn member_answer_of(&self, run: &CollectionRun, flow: Flow, scope: &Rc<Scope>) -> Result<Js, Stop> {
        crate::collection::member_answer_in(run.op.op.op, crate::collection::spelling(run.op.op.op), flow, scope)
    }

    /// `resumedCollectionRun`: a parked op as its frame kept it — the
    /// members it reads, `REDUCE`'s start, every answer its members gave.
    async fn resumed_collection_run(&self, run: &CollectionRun, frame_address: &str) -> Result<(CollectionRun, Vec<Option<Option<Js>>>), Stop> {
        let rows = self.collect_branch_exports(frame_address).await?;
        let state = rows.iter().find(|(index, _)| *index == -1).map(|(_, exports)| exports.clone());
        let missing = || runtime(format!("resume: the collection op at '{frame_address}' kept no record of its members"));
        let state = state.filter(|s| at(s, "source").is_some() && at(s, "init").is_some()).ok_or_else(missing)?;
        let source = self.rehydrate_alone(at(&state, "source").unwrap_or(&Js::Undefined)).await?;
        let init = self.rehydrate_alone(at(&state, "init").unwrap_or(&Js::Undefined)).await?;
        let Binding::Value(ValueBinding { value: Js::Array(members), trail, .. }) = source else {
            return Err(runtime(format!("resume: the collection op at '{frame_address}' kept members that are not a list")));
        };
        let members = members.items().clone();
        let mut answers: Vec<Option<Option<Js>>> = vec![None; members.len()];
        for (index, exports) in &rows {
            if *index < 0 || !matches!(at(exports, "kept"), Some(Js::Bool(_))) {
                continue;
            }
            let Some(slot) = answers.get_mut(*index as usize) else { continue };
            if !matches!(at(exports, "kept"), Some(Js::Bool(true))) {
                *slot = Some(None);
                continue;
            }
            let bound = self.rehydrate_alone(at(exports, "answer").unwrap_or(&Js::Undefined)).await?;
            *slot = Some(Some(match bound {
                Binding::Value(value) => value.value,
                other => crate::record::held(other),
            }));
        }
        let init = match init {
            Binding::Value(value) => value.value,
            _ => Js::Null,
        };
        Ok((CollectionRun { members, source_trail: trail.unwrap_or_default(), init, ..run.resumed_copy() }, answers))
    }

    /// A branch's exports (`serializeBranchExport`): its scope's own
    /// bindings, a fan-out iteration's hop aliases (every hop's) left out.
    fn branch_exports(&self, child: &Rc<Scope>, container: &Statement, descent: char) -> Result<Js, Stop> {
        let aliases: Vec<String> = if descent == 'i' {
            fan_out_block_of(container, "").map(|(block, _)| crate::traverse::head_aliases(&block.head)).unwrap_or_default()
        } else {
            Vec::new()
        };
        let exported: Vec<(String, Binding)> = child.own_bindings().into_iter().filter(|(name, _)| !aliases.contains(name)).collect();
        crate::park::serialize_together(self, &exported).map_err(Stop::Thrown)
    }

    /// `mergeJoinBranch`: a closed join's exports folded into its parent as
    /// a never-parked run's join folds them.
    async fn merge_join_branch(&self, container: &Statement, container_path: &str, container_address: &Address, parent: &Rc<Scope>) -> Result<(), Stop> {
        let rows = self.collect_branch_exports(&container_address.encode()).await?;
        let Some(name) = bound_name_of(container) else { return Ok(()) };
        if let Some((combinator, _)) = combinator_of(container, container_path) {
            let receipt = self.receipt_from_exports(&rows, arm_count_of(&combinator, &rows)).await?;
            parent.declare(name, receipt);
            return Ok(());
        }
        // An assigned fan-out: what its iterations returned, in iteration order.
        let mut returned = Vec::new();
        for (_, exports) in &rows {
            if let Some(descriptor) = at(exports, RETURN_SLOT) {
                returned.push(self.rehydrate_alone(descriptor).await?);
            }
        }
        parent.declare(name, crate::traverse::block_value(returned));
        Ok(())
    }

    /// `settleRaceWinner`: every arm's subtree withdrawn (the winner's own
    /// leaf spared by address), the receipt bound from what completed.
    async fn settle_race_winner(&self, combinator: &CombinatorExpression, container: &Statement, container_address: &Address, parent: &Rc<Scope>, leaf_address: &str) -> Result<(), Stop> {
        let rows = self.collect_branch_exports(&container_address.encode()).await?;
        let arms = arm_count_of(combinator, &rows);
        let subtrees: Vec<String> = (0..arms).map(|k| container_address.branch(k).encode()).collect();
        if !subtrees.is_empty() {
            self.ask(host::park::cancel_subtrees(self.segment(), &subtrees, Some(leaf_address))).await.map_err(Stop::Thrown)?;
        }
        if let Some(name) = bound_name_of(container) {
            let receipt = self.receipt_from_exports(&rows, arms).await?;
            parent.declare(name, receipt);
        }
        Ok(())
    }

    /// `settleRaceAt`: the race statement itself, settled after a batch:
    /// every arm that settled in the batch a winner, the rest withdrawn.
    async fn settle_race_at(&self, statement: Option<&Statement>, statement_path: &str, frame: &str, scope: &Rc<Scope>) -> Result<(), Stop> {
        let combinator = statement.and_then(|s| combinator_of(s, statement_path));
        let (Some(statement), Some((combinator, _))) = (statement, combinator) else {
            return Err(runtime(format!("settleRace: no race statement at frame '{frame}'")));
        };
        let rows = self.collect_branch_exports(frame).await?;
        let arms = arm_count_of(&combinator, &rows);
        let receipt = self.receipt_from_exports(&rows, arms).await?;
        let frame_address = Address::parse(frame).unwrap_or_default();
        let subtrees: Vec<String> = (0..arms).map(|k| frame_address.branch(k).encode()).collect();
        self.ask(host::park::cancel_subtrees(self.segment(), &subtrees, None)).await.map_err(Stop::Thrown)?;
        if let Some(name) = bound_name_of(statement) {
            scope.declare(name, receipt);
        }
        Ok(())
    }

    /// `receiptFromExports`: slot i what arm i returned, its export's
    /// return slot; an arm that left no row a null slot.
    async fn receipt_from_exports(&self, rows: &[(i64, Js)], arms: usize) -> Result<Binding, Stop> {
        let mut slots: Vec<Binding> = (0..arms).map(|_| null_slot()).collect();
        for (index, exports) in rows {
            let Some(descriptor) = at(exports, RETURN_SLOT) else { continue };
            if *index < 0 || *index as usize >= slots.len() {
                continue;
            }
            slots[*index as usize] = self.rehydrate_alone(descriptor).await?;
        }
        Ok(Binding::Tuple(Rc::new(slots)))
    }

    /// `park.sink.decrementJoin`: whether this branch closed its frame.
    async fn decrement_join(&self, frame: &str, branch: &str, leaf: &str) -> Result<bool, Stop> {
        let answer = self.ask(host::park::decrement_join(self.segment(), frame, branch, leaf)).await.map_err(Stop::Thrown)?;
        Ok(answer.as_ref().and_then(|a| a.get("closed")).and_then(serde_json::Value::as_bool) == Some(true))
    }

    /// `park.sink.collectBranchExports`: by branch index, each row's
    /// exports as the host kept them.
    async fn collect_branch_exports(&self, frame: &str) -> Result<Vec<(i64, Js)>, Stop> {
        let answer = self.ask(host::park::collect_branch_exports(self.segment(), frame)).await.map_err(Stop::Thrown)?;
        let rows = match answer {
            Some(answer) => self.wire.decode(&answer).map_err(|e| runtime(format!("collectBranchExports answered what does not read: {e}")))?,
            None => Js::Undefined,
        };
        Ok(items(Some(&rows))
            .iter()
            .map(|row| {
                let index = match at(row, "branchIndex") {
                    Some(Js::Number(n)) => *n as i64,
                    _ => i64::MIN,
                };
                (index, at(row, "exports").cloned().unwrap_or(Js::Undefined))
            })
            .collect())
    }

    // ── A fired callback's body ──

    /// `runCallbackBody`: the body in a child of the captured scope, the
    /// fire-time values bound, at its own address frame (`… .i <call>`).
    async fn callback_body(&self, statement: Option<&Statement>, leaf: &Sequence, values: &Js, call_index: usize) -> Result<(), Stop> {
        let stmt_address = leaf.address.stmt(leaf.index);
        let Some(Statement::Assign(assign)) = statement else {
            return Err(runtime(format!(
                "fireCallback: no callback statement at '{}' — the run's pinned version and the stored entry point disagree",
                stmt_address.encode()
            )));
        };
        let RValue::Callback { callback } = &assign.value else {
            return Err(runtime(format!(
                "fireCallback: no callback statement at '{}' — the run's pinned version and the stored entry point disagree",
                stmt_address.encode()
            )));
        };
        let frame = stmt_address.iter(call_index);
        let path = format!("{}/{}/value/callback/subject", leaf.path, leaf.index);
        match &callback.subject {
            // The named form defers a whole movement with its fixed
            // arguments: the ordinary call path.
            CallbackSubject::Named { movement, args, span, .. } => {
                let call = CallStatement { callee: movement.clone(), args: args.clone(), expression: None, span: *span };
                self.call(&call, &leaf.scope, &frame, &path).await?;
                Ok(())
            }
            CallbackSubject::Inline { closure, .. } => {
                let child = leaf.scope.child();
                for param in &closure.params {
                    let value = crate::record::get(values, &param.name).unwrap_or(Js::Undefined);
                    let value = if value.is_nullish() { Js::Null } else { value };
                    child.declare(param.name.clone(), Binding::Value(ValueBinding { value, trail: Some(Trail::default()), many: false }));
                }
                match self.body(&closure.body, &child, &frame, &format!("{path}/closure/body"), 0).await {
                    Ok(_) => Ok(()),
                    Err(stop) => Err(stop),
                }
            }
        }
    }

    // ── Rehydration (serialize.ts `rehydrate`) ──

    /// `rehydrateScopeInto`: a scope's bindings declared into `scope`, the
    /// trigger's own live ones kept.
    async fn rehydrate_into(&self, serialized: Option<&Js>, scope: &Rc<Scope>, park: &ParkReader) -> Result<(), Stop> {
        // The scope a parked closure names by number is this one, live.
        if let Some(copy) = serialized {
            park.register_live_scope(copy, scope);
        }
        let Some(bindings) = serialized.and_then(|s| at(s, "bindings")) else { return Ok(()) };
        for (name, descriptor) in pairs(Some(bindings)) {
            let kind = text(at(descriptor, "kind")).unwrap_or("");
            if scope.resolve(name).is_some() && matches!(kind, "event" | "instance" | "movement" | "shape") {
                continue;
            }
            // Past `prepareMovement` the run has touched its source, so what
            // does not rehydrate fails the run, as it does on TypeScript.
            let binding = self.rehydrate(descriptor, park).await?;
            scope.declare(name.clone(), binding);
        }
        Ok(())
    }

    /// A descriptor stored on its own, its own park.
    pub(crate) async fn rehydrate_alone(&self, descriptor: &Js) -> Result<Binding, Stop> {
        let park = ParkReader::over_descriptor(descriptor);
        let binding = self.rehydrate(descriptor, &park).await?;
        park.assert_read().map_err(runtime)?;
        Ok(binding)
    }

    /// `rehydrateCallRecords`.
    async fn rehydrate_journal(&self, events: &[Js], park: &ParkReader) -> Result<Vec<(usize, CallRecord)>, Stop> {
        let mut out = Vec::with_capacity(events.len());
        for event in events {
            let index = id_of(at(event, "index")).unwrap_or(0) as usize;
            let value = match at(event, "value") {
                Some(Js::Null) | None => None,
                Some(descriptor) => Some(self.rehydrate(descriptor, park).await?),
            };
            let next = id_of(at(event, "next")).unwrap_or(0) as usize;
            out.push((index, CallRecord { value, next }));
        }
        Ok(out)
    }

    /// `rehydrateBinding`.
    fn rehydrate<'s>(&'s self, descriptor: &'s Js, park: &'s ParkReader) -> Pinned<'s, Binding> {
        Box::pin(async move {
            let malformed = |what: &str| runtime(format!("the parked state holds {what}"));
            Ok(match text(at(descriptor, "kind")) {
                Some("event") => Binding::Event,
                Some("handle") => {
                    // A numbered one is the ONE handle every `handleRef` to it
                    // reads as, filled in place here — or read already,
                    // through a reference that named it first.
                    let handle = match id_of(at(descriptor, "id")) {
                        Some(id) => {
                            if let Some(read) = park.handle(id).filter(|_| !park.handle_unfilled(id)) {
                                return Ok(Binding::Handle(read));
                            }
                            let handle = self.handle_numbered(id, park)?;
                            park.handle_filled(id);
                            handle
                        }
                        None => Rc::new(self.handle_of(descriptor)?),
                    };
                    // The record before its write (`-[:@old]->`): the handle
                    // itself, said as `oldIsSelf`, or a handle of its own.
                    if matches!(at(descriptor, "oldIsSelf"), Some(Js::Bool(true))) {
                        handle.move_to(handle.record(), crate::bindings::Old::Itself);
                    } else if let Some(old) = at(descriptor, "old") {
                        match self.rehydrate(old, park).await? {
                            Binding::Handle(old) => handle.move_to(handle.record(), crate::bindings::Old::Was(old)),
                            other => {
                                return Err(runtime(format!("the parked state's record before a write is {}, not a handle", crate::record::kind_of(&other))));
                            }
                        }
                    }
                    Binding::Handle(handle)
                }
                Some(kind @ ("extractRoot" | "extractPosition")) => {
                    let emission = self.rehydrate_emission(at(descriptor, "emission").unwrap_or(&Js::Undefined))?;
                    Binding::Extracted { emission, root: kind == "extractRoot", id: crate::bindings::Identity::new() }
                }
                Some("sourcePosition") => {
                    let position = at(descriptor, "position").cloned().unwrap_or(Js::Undefined);
                    let properties = at(descriptor, "edgeProperties").cloned();
                    let read = match at(descriptor, "read") {
                        Some(read) => self.source_read_of(text(at(read, "instanceName")).unwrap_or("")).await?,
                        None => self.source.borrow().as_ref().map(|source| source.read.clone()).ok_or_else(|| malformed("a record read off a source this run has none of"))?,
                    };
                    Binding::Landed(Rc::new(Landed::new(position, properties, read)))
                }
                // Named before its own descriptor was read: read it now,
                // whole (its record before included), from wherever in the
                // state it was written. A number no descriptor carries is a
                // reference into nothing, which `assertParkRead` refuses.
                Some("handleRef") => {
                    let id = id_of(at(descriptor, "id")).ok_or_else(|| malformed("a handleRef without an id"))?;
                    match park.handle(id) {
                        Some(handle) => Binding::Handle(handle),
                        None => match park.handle_descriptor(id) {
                            Some(written) => self.rehydrate(&written, park).await?,
                            None => Binding::Handle(self.handle_numbered(id, park)?),
                        },
                    }
                }
                Some("nodeRef") => {
                    let id = id_of(at(descriptor, "id")).ok_or_else(|| malformed("a nodeRef without an id"))?;
                    match park.node(id) {
                        Some(node) => Binding::Node(node),
                        None => match park.node_descriptor(id) {
                            Some(written) => self.rehydrate(&written, park).await?,
                            None => Binding::Node(park.numbered(id)),
                        },
                    }
                }
                Some("nodePosition") => Binding::Node(self.rehydrate_node(descriptor, park).await?),
                Some("lazyWalk") => Binding::LazyWalk(self.rehydrate_walk(at(descriptor, "walk").unwrap_or(&Js::Undefined), park).await?),
                Some("value") => {
                    let value = at(descriptor, "value").cloned().unwrap_or(Js::Undefined);
                    let trail = at(descriptor, "provenance").map(|p| self.rehydrate_trail(p)).transpose().map_err(|e| malformed(&e))?;
                    let many = matches!(at(descriptor, "many"), Some(Js::Bool(true)));
                    Binding::Value(ValueBinding { value, trail, many })
                }
                // Through the one binding constructor, so a park taken while
                // a name held one record on the value plane resumes with the
                // record bound as itself.
                Some("recordValue") => {
                    let value = self.rehydrate_value(at(descriptor, "value").unwrap_or(&Js::Undefined), park).await?;
                    let trail = at(descriptor, "provenance").map(|p| self.rehydrate_trail(p)).transpose().map_err(|e| malformed(&e))?;
                    let many = matches!(at(descriptor, "many"), Some(Js::Bool(true)));
                    crate::record::bind_value(value, Some(trail.unwrap_or_default()), many)
                }
                // Data only: the binding object, as it stood.
                Some("callback") => Binding::Callback(Rc::new(crate::bindings::Callback {
                    callback_id: at(descriptor, "callbackId").cloned().unwrap_or(Js::Undefined),
                    url: at(descriptor, "url").cloned().unwrap_or(Js::Undefined),
                    params: at(descriptor, "params").cloned().unwrap_or(Js::Undefined),
                })),
                Some("shapePosition") => Binding::ShapePosition(Rc::new(crate::bindings::ShapePosition {
                    shape: at(descriptor, "shape").cloned().unwrap_or(Js::Undefined),
                    node: at(descriptor, "node").cloned().unwrap_or(Js::Undefined),
                    fields: match (at(descriptor, "fields"), at(descriptor, "fileFields")) {
                        (Some(Js::Object(fields)), Some(files)) => Js::object(with_file_fields(JsObject::clone_of(fields), Some(files))?),
                        (fields, _) => fields.cloned().unwrap_or(Js::Undefined),
                    },
                    field_provenance: at(descriptor, "fieldProvenance").cloned().unwrap_or(Js::Undefined),
                })),
                Some("resource") => Binding::Resource(Rc::new(rehydrate_resource(at(descriptor, "resource").unwrap_or(&Js::Undefined)))),
                Some("instance") => Binding::Instance(Rc::new(self.rehydrate_instance(at(descriptor, "instance").unwrap_or(&Js::Null))?)),
                // A shape declared in a body: its declaration as it was
                // parked; its words read the running file's scope now
                // (serialize.ts `localShape`).
                Some("localShape") => {
                    let (declaration, _) = parked_tree::<movement_parser::ast::ShapeDeclaration>(at(descriptor, "declaration"), "a body's shape declaration")?;
                    let declared = crate::program::DeclaredShape { declaration, file: crate::program::DeclaringFile::Root };
                    Binding::Shape(Rc::new(crate::bindings::ShapeBinding { declared, local: true, declared_in: None }))
                }
                // Code refs, re-resolved by name from the re-parsed program —
                // in the library a shape or movement was declared in, which
                // the root program need not import or may shadow.
                Some("shape" | "movement" | "opaque") => self.code_ref(descriptor).await?,
                // A closure bound at a file's top level, found again by its
                // name in that file.
                Some("fileClosure") => match self.code_ref(descriptor).await? {
                    found @ Binding::Closure(_) => found,
                    _ => {
                        let name = text(at(descriptor, "name")).unwrap_or("");
                        return Err(runtime(format!("resume: '{name}' parked as a file-level function, and the re-parsed {} binds it to something else", parked_file(descriptor))));
                    }
                },
                Some("positions") => {
                    let mut landings = Vec::new();
                    for landing in items(at(descriptor, "landings")) {
                        landings.push(self.rehydrate(&landing, park).await?);
                    }
                    Binding::Positions(landings)
                }
                Some("tuple") => {
                    let mut slots = Vec::new();
                    for slot in items(at(descriptor, "slots")) {
                        slots.push(self.rehydrate(&slot, park).await?);
                    }
                    Binding::Tuple(Rc::new(slots))
                }
                // One that holds its scope by reference: the ONE scope every
                // closure naming it holds.
                Some("closure") if at(descriptor, "scope").is_some() => {
                    let (code, written) = self.closure_code(at(descriptor, "closure"))?;
                    let captured = self.scope_of(at(descriptor, "scope").unwrap_or(&Js::Undefined), &written, park).await?;
                    Binding::Closure(Rc::new(Closure { code, captured, self_name: text(at(descriptor, "self")).map(String::from), file_name: None, by_reference: true }))
                }
                Some("closure") => {
                    let (code, written) = self.closure_code(at(descriptor, "closure"))?;
                    let captured = Scope::root_written_in(written);
                    for (name, entry) in pairs(at(descriptor, "captured")) {
                        captured.declare(name.clone(), self.rehydrate(entry, park).await?);
                    }
                    Binding::Closure(Rc::new(Closure { code, captured, self_name: text(at(descriptor, "self")).map(String::from), file_name: None, by_reference: false }))
                }
                other => return Err(runtime(format!("a parked binding of kind {} is not one this engine rebuilds", other.unwrap_or("undefined")))),
            })
        })
    }

    /// `scopeOf`: the scope a parked closure holds — a file's, found in the
    /// re-parsed program; or a numbered one: the live scope the resume read
    /// a chain copy into, or one built here from its written copy, nested as
    /// it was, and registered before its bindings are read, so a closure in
    /// it that holds it gets it back. `written` is the file the closure's
    /// code is, what a scope nested in none reads its code in.
    fn scope_of<'s>(&'s self, link: &'s Js, written: &'s crate::program::DeclaringFile, park: &'s ParkReader) -> Pinned<'s, Rc<Scope>> {
        Box::pin(async move {
            if text(at(link, "kind")) == Some("file") {
                let file = match text(at(link, "file")) {
                    Some(path) => crate::program::DeclaringFile::Library(path.to_string()),
                    None => crate::program::DeclaringFile::Root,
                };
                return self
                    .scope_of_file(&file)
                    .ok_or_else(|| runtime("resume: a parked closure names a file scope the re-parsed program has none of".into()));
            }
            let id = id_of(at(link, "id")).ok_or_else(|| runtime("the parked state holds a scope link without an id".into()))?;
            if let Some(known) = park.scope(id) {
                return Ok(known);
            }
            let copy = if text(at(link, "kind")) == Some("scope") { Some(link.clone()) } else { park.scope_descriptor(id) };
            let copy = copy.ok_or_else(|| runtime(format!("the parked state refers to scope #{id} that it never wrote")))?;
            let scope = match at(&copy, "parent") {
                Some(parent) => self.scope_of(parent, written, park).await?.child(),
                None => Scope::root_written_in(written.clone()),
            };
            // Building its parent may have built it (a closure the parent
            // holds names it): that one is the scope.
            if let Some(known) = park.scope(id) {
                return Ok(known);
            }
            park.scope_registered(id, scope.clone());
            for (name, entry) in pairs(at(&copy, "bindings")) {
                scope.declare(name.clone(), self.rehydrate(entry, park).await?);
            }
            Ok(scope)
        })
    }

    /// `resolveCodeRef`: a code ref's name in the file it was declared in —
    /// the library its `file` names (an `opaque` import is the root
    /// program's), or the root program.
    async fn code_ref(&self, descriptor: &Js) -> Result<Binding, Stop> {
        let name = text(at(descriptor, "name")).unwrap_or("");
        let library = text(at(descriptor, "file")).filter(|_| text(at(descriptor, "kind")) != Some("opaque"));
        let scope = match library {
            None => self.file_scope.borrow().clone(),
            Some(path) => {
                if self.checked.file(&crate::program::DeclaringFile::Library(path.to_string())).is_none() {
                    return Err(runtime(format!("resume: the parked state names the library \"{path}\", which the re-parsed program does not link")));
                }
                Some(self.library_scope(path).await?)
            }
        };
        match scope.and_then(|file| file.resolve(name)) {
            Some(binding) => Ok(binding),
            None => Err(runtime(format!("resume: cannot re-resolve code ref '{name}' from the re-parsed {}", parked_file(descriptor)))),
        }
    }

    /// A handle as its descriptor writes it, its record before (`old`) not
    /// yet read.
    fn handle_of(&self, descriptor: &Js) -> Result<Handle, Stop> {
        let malformed = |what: &str| runtime(format!("the parked state holds {what}"));
        let record = at(descriptor, "handle").ok_or_else(|| malformed("a handle descriptor without its record"))?;
        let target_type = text(at(descriptor, "targetType")).ok_or_else(|| malformed("a handle without a targetType"))?;
        let graph = at(descriptor, "graph").and_then(|g| at(g, "instance")).ok_or_else(|| malformed("a handle without its graph"))?;
        Ok(Handle::new(Rc::new(WriteRecord { object: record.clone() }), crate::bindings::Old::Nothing, target_type.to_string(), Rc::new(self.rehydrate_instance(graph)?)))
    }

    /// The one handle numbered `id` in this park (`handleNumbered`): made
    /// from the descriptor that numbers it when first named, whichever is
    /// read first, a reference or the descriptor itself (a stored state's
    /// keys come back in jsonb's order). A number no descriptor in the state
    /// carries is a reference into nothing, refused as the TypeScript's
    /// `assertParkRead` refuses it.
    fn handle_numbered(&self, id: u64, park: &ParkReader) -> Result<Rc<Handle>, Stop> {
        if let Some(handle) = park.handle(id) {
            return Ok(handle);
        }
        let Some(descriptor) = park.handle_descriptor(id) else {
            return Err(runtime(format!("the parked state refers to write handle(s) #{id} that it never wrote")));
        };
        let handle = Rc::new(self.handle_of(&descriptor)?);
        park.handle_registered(id, handle.clone());
        Ok(handle)
    }

    /// A node, registered before its edges are read (a reference among them
    /// may lead back to it), filled in place.
    async fn rehydrate_node(&self, descriptor: &Js, park: &ParkReader) -> Result<Rc<RefCell<Node>>, Stop> {
        let node = match id_of(at(descriptor, "id")) {
            // Read already — through a reference that named it first.
            Some(id) if park.node(id).is_some() && !park.node_unfilled(id) => return Ok(park.numbered(id)),
            // Registered (and so reachable by its references) before its
            // edges are read, which is what lets an edge lead back to it.
            Some(id) => {
                let node = park.numbered(id);
                park.filled(id);
                node
            }
            None => Rc::new(RefCell::new(Node::default())),
        };
        let fields = pairs(at(descriptor, "fields")).to_vec();
        let order: Vec<String> = match at(descriptor, "fieldOrder") {
            Some(order) => items(Some(order)).iter().filter_map(|f| text(Some(f)).map(String::from)).collect(),
            None => fields.iter().map(|(k, _)| k.clone()).collect(),
        };
        // `inOrder`: the order kept, then whatever else the map holds.
        let mut ordered = JsObject::new();
        for key in &order {
            if let Some((_, value)) = fields.iter().find(|(k, _)| k == key) {
                ordered.set(key.clone(), value.clone());
            }
        }
        for (key, value) in &fields {
            if ordered.get(key).is_none() {
                ordered.set(key.clone(), value.clone());
            }
        }
        let ordered = with_file_fields(ordered, at(descriptor, "fileFields"))?;
        let mut provenance = Vec::new();
        for (field, trail) in pairs(at(descriptor, "fieldProvenance")) {
            provenance.push((field.clone(), self.rehydrate_trail(trail).map_err(|e| runtime(format!("the parked state holds {e}")))?));
        }
        let mut edges = Vec::new();
        for (edge, held) in pairs(at(descriptor, "edges")) {
            if text(at(held, "kind")) == Some("landed") {
                let mut landings = Vec::new();
                for landing in items(at(held, "landings")) {
                    landings.push(self.rehydrate(&landing, park).await?);
                }
                edges.push((edge.clone(), Edge { landings, shape: landing_shape_of(held), deferred: None }));
            } else {
                let walk = self.rehydrate_walk(at(held, "walk").unwrap_or(&Js::Undefined), park).await?;
                edges.push((edge.clone(), Edge { landings: Vec::new(), shape: None, deferred: Some(walk) }));
            }
        }
        let landed_on = text(at(descriptor, "landedOn")).map(String::from);
        *node.borrow_mut() = Node { fields: ordered, field_order: order, field_provenance: provenance, landed_on, edges };
        Ok(node)
    }

    /// `rehydrateDeferredWalk`: the walk as it was parked — its head and its
    /// mapping, one piece of parked code — in the scope it captured.
    async fn rehydrate_walk(&self, descriptor: &Js, park: &ParkReader) -> Result<Rc<DeferredWalk>, Stop> {
        let (head, head_tree) = parked_tree::<movement_parser::ast::PathHead>(at(descriptor, "head"), "a kept walk's head")?;
        let mapping = match at(descriptor, "mapping") {
            None | Some(Js::Undefined) => None,
            Some(mapping) => Some(parked_tree::<movement_parser::ast::NodeLiteral>(Some(mapping), "a kept walk's mapping")?),
        };
        let as_parked = |head: Json, mapping: Option<Json>| {
            let mut walk = serde_json::Map::new();
            walk.insert("head".into(), head);
            if let Some(mapping) = mapping {
                walk.insert("mapping".into(), mapping);
            }
            Json::Object(walk)
        };
        let typed = as_parked(to_tree(&head), mapping.as_ref().map(|(m, _)| to_tree(m)));
        let file = self.checked.park_code(typed, &as_parked(head_tree, mapping.as_ref().map(|(_, tree)| tree.clone())));
        let walk_path = crate::program::in_file(&file, "");
        let captured = Scope::root();
        for (name, entry) in pairs(at(descriptor, "captured")) {
            captured.declare(name.clone(), self.rehydrate(entry, park).await?);
        }
        let mapping = mapping.map(|(mapping, _)| (mapping, format!("{walk_path}/mapping")));
        Ok(Rc::new(DeferredWalk { head, head_path: format!("{walk_path}/head"), captured, mapping }))
    }

    /// A closure the state carries, as it was parked: a piece of parked code
    /// of its own, the file its body is written in.
    fn closure_code(&self, closure: Option<&Js>) -> Result<(Code<movement_parser::ast::ClosureExpression>, crate::program::DeclaringFile), Stop> {
        let (ast, tree) = parked_tree::<movement_parser::ast::ClosureExpression>(closure, "a closure")?;
        let written = self.checked.park_code(to_tree(&ast), &tree);
        Ok((Code { ast: Rc::new(ast), path: crate::program::in_file(&written, "") }, written))
    }

    /// `rehydrateEmission`.
    fn rehydrate_emission(&self, descriptor: &Js) -> Result<Rc<crate::extract::emission::Emission>, Stop> {
        let fields = pairs(at(descriptor, "fields")).to_vec();
        let order: Option<Vec<String>> = at(descriptor, "fieldOrder").map(|order| items(Some(order)).iter().filter_map(|f| text(Some(f)).map(String::from)).collect());
        let mut ordered = JsObject::new();
        match &order {
            Some(order) => {
                for key in order {
                    if let Some((_, value)) = fields.iter().find(|(k, _)| k == key) {
                        ordered.set(key.clone(), value.clone());
                    }
                }
                for (key, value) in &fields {
                    if ordered.get(key).is_none() {
                        ordered.set(key.clone(), value.clone());
                    }
                }
            }
            None => {
                for (key, value) in &fields {
                    ordered.set(key.clone(), value.clone());
                }
            }
        }
        let ordered = with_file_fields(ordered, at(descriptor, "fileFields"))?;
        let provenance = pairs(at(descriptor, "provenance")).iter().map(|(field, origin)| (field.clone(), self.mint_origin(origin.clone()))).collect();
        let origin = at(descriptor, "origin").map(|origin| self.mint_origin(origin.clone()));
        let resources = items(at(descriptor, "resources")).iter().map(rehydrate_resource).collect();
        let mut children = Vec::new();
        for (edge, kids) in pairs(at(descriptor, "children")) {
            let mut list = Vec::new();
            for kid in items(Some(kids)) {
                list.push(self.rehydrate_emission(&kid)?);
            }
            children.push((edge.clone(), list));
        }
        Ok(Rc::new(crate::extract::emission::Emission { node_name: text(at(descriptor, "nodeName")).unwrap_or("").to_string(), fields: ordered, provenance, origin, resources, children }))
    }

    /// `rehydrateValue`: a value with its records rebuilt where they stand.
    fn rehydrate_value<'s>(&'s self, descriptor: &'s Js, park: &'s ParkReader) -> Pinned<'s, Js> {
        Box::pin(async move {
            Ok(match text(at(descriptor, "kind")) {
                Some("record") => crate::record::held(self.rehydrate(at(descriptor, "binding").unwrap_or(&Js::Undefined), park).await?),
                Some("file") => revived_file(at(descriptor, "file"))?,
                Some("list") => {
                    let mut out = Vec::new();
                    for entry in items(at(descriptor, "of")) {
                        out.push(self.rehydrate_value(&entry, park).await?);
                    }
                    Js::array(out)
                }
                Some("map") => {
                    // `out[key] = …`, as `rehydrateValue` assigns.
                    let mut out = JsObject::new();
                    for (key, entry) in pairs(at(descriptor, "of")) {
                        out.assign(key.clone(), self.rehydrate_value(entry, park).await?);
                    }
                    Js::object(out)
                }
                _ => at(descriptor, "value").cloned().unwrap_or(Js::Undefined),
            })
        })
    }

    /// `resolveSourceRead`: the read seam of a file-scope instance, by its
    /// name.
    async fn source_read_of(&self, instance_name: &str) -> Result<Rc<crate::traverse::Read>, Stop> {
        let binding = self.file_scope.borrow().as_ref().and_then(|file| file.resolve(instance_name));
        match binding {
            Some(Binding::Instance(instance)) => self.instance_read(&instance).await.map_err(Stop::Thrown),
            Some(_) => Err(runtime(format!("resume: '{instance_name}' is not a readable graph"))),
            None => Err(runtime(format!("resume: cannot rebind read seam for instance '{instance_name}' — not in the re-parsed file scope"))),
        }
    }

    /// `rehydrateInstance`: the identity's schema instantiated again, live;
    /// an instance the snapshot no longer holds (its adapter uninstalled,
    /// its credential gone or moved) fails the resume rather than run
    /// untyped.
    pub(crate) fn rehydrate_instance(&self, identity: &Js) -> Result<InstanceBinding, Stop> {
        let text_of = |key: &str| text(at(identity, key)).map(String::from);
        let name = text_of("name").ok_or_else(|| runtime("the parked state holds an instance identity without a name".into()))?;
        let adapter_slug = text_of("adapterSlug").ok_or_else(|| runtime("the parked state holds an instance identity without an adapterSlug".into()))?;
        let credential_name = text_of("credentialName");
        let construction_config: Vec<(String, String)> = pairs(at(identity, "constructionConfig"))
            .iter()
            .map(|(k, v)| (k.clone(), match v { Js::String(s) => s.to_string(), _ => String::new() }))
            .collect();
        let spec = self.catalog.adapter(&adapter_slug);
        let credential_arg = spec.and_then(movement_parser::catalog::helpers::credential_arg_of).map_or_else(|| "credentials".to_string(), |a| a.name.clone());
        let mut spelled: Vec<(String, String)> = construction_config.clone();
        if let Some(credential) = &credential_name {
            spelled.push((credential_arg.clone(), credential.clone()));
        }
        let in_snapshot = spec.is_some()
            && credential_name
                .as_deref()
                .is_none_or(|c| self.catalog.credential(c).is_some_and(|spec| spec.adapters.contains(&adapter_slug)));
        if !in_snapshot {
            let args = spelled.iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join(", ");
            return Err(runtime(format!("instance {adapter_slug}({args}) is not in the catalog snapshot")));
        }
        let mut args = movement_parser::catalog::snapshot::Args::default();
        for (k, v) in &spelled {
            args.0.insert(k.clone(), v.clone());
        }
        let schema = self.catalog.instantiate(&adapter_slug, &args).cloned();
        Ok(InstanceBinding { name, adapter_slug, credential_name, construction_config, schema })
    }

    /// A parked trail's origins, each one more origin in this run's table.
    pub(crate) fn rehydrate_trail(&self, provenance: &Js) -> Result<Trail, String> {
        let origins = at(provenance, "origins").ok_or("a trail without origins")?;
        let origins = items(Some(origins)).iter().map(|o| self.mint_origin(o.clone())).collect();
        let direct = at(provenance, "direct").map(|d| self.mint_origin(d.clone()));
        Ok(Trail { origins, direct })
    }
}

/// `rematerialiseAnswer`: a `Correct` answer (the curated row set) as a
/// traversable extract result, one child per surviving row under its type;
/// any other answer a value.
pub(crate) fn rematerialise_answer(answer: Js) -> Binding {
    let correct = match &answer {
        Js::Object(object) => match object.get("__correct") {
            Some(correct @ Js::Object(_)) => Some(correct.clone()),
            _ => None,
        },
        _ => None,
    };
    let Some(correct) = correct else {
        return Binding::Value(ValueBinding { value: answer, trail: Some(Trail::default()), many: false });
    };
    let type_name = crate::record::get(&correct, "type").map(|t| t.to_js_string()).unwrap_or_default();
    let rows = match crate::record::get(&correct, "rows") {
        Ok(Js::Array(rows)) => rows.items().clone(),
        _ => Vec::new(),
    };
    let emission = |fields: JsObject, children| Rc::new(crate::extract::emission::Emission { node_name: type_name.clone(), fields, provenance: Vec::new(), origin: None, resources: Vec::new(), children });
    let kids = rows
        .iter()
        .map(|row| {
            let fields = match crate::record::get(row, "fields") {
                Ok(Js::Object(fields)) => JsObject::clone_of(&fields),
                _ => JsObject::new(),
            };
            emission(fields, Vec::new())
        })
        .collect();
    Binding::Extracted { emission: emission(JsObject::new(), vec![(type_name.clone(), kids)]), root: true, id: crate::bindings::Identity::new() }
}

/// `rehydrateResource`: a parked resource, its `fileRef` slot the file the
/// host made of it, and its `data.file` that same file.
fn rehydrate_resource(descriptor: &Js) -> Js {
    let Js::Object(object) = descriptor else { return descriptor.clone() };
    // The host handed the slot's file as one (its parked descriptor made a
    // file host-side); anything else in the slot is no file.
    let file = object.get("fileRef").filter(|f| matches!(f, Js::File(_))).cloned();
    let mut out = JsObject::new();
    for (key, value) in object.entries() {
        if key == "fileRef" {
            continue;
        }
        match (key.as_str(), value, &file) {
            ("data", Js::Object(data), Some(file)) if data.get("file").is_some() => {
                let mut data = JsObject::clone_of(data);
                data.set("file".into(), file.clone());
                out.set(key.clone(), Js::object(data));
            }
            _ => out.set(key.clone(), value.clone()),
        }
    }
    if let Some(file) = file {
        out.set("fileRef".into(), file);
    }
    Js::object(out)
}

/// A parked `file`: a file again, by the descriptor that said so.
fn revived_file(descriptor: Option<&Js>) -> Result<Js, Stop> {
    match descriptor {
        Some(file @ Js::File(_)) => Ok(file.clone()),
        // The host makes a parked file a file before the engine reads it.
        other => Err(Stop::Thrown(crate::run::Failure::engine(
            "MOVENG_PARK_NONSERIALIZABLE",
            format!("a parked file the host did not hand back as a file: {}", crate::js::json_stringify(&other.cloned().unwrap_or(Js::Undefined), 0)),
        ))),
    }
}

/// `withFileFields`: the fields a park said hold a file made whole again,
/// each in its place.
fn with_file_fields(mut fields: JsObject, file_fields: Option<&Js>) -> Result<JsObject, Stop> {
    // `out[key] = …`, as `withFileFields` assigns.
    for (key, descriptor) in pairs(file_fields) {
        fields.assign(key.clone(), revived_field_value(descriptor)?);
    }
    Ok(fields)
}

fn revived_field_value(descriptor: &Js) -> Result<Js, Stop> {
    Ok(match text(at(descriptor, "kind")) {
        Some("file") => revived_file(at(descriptor, "file"))?,
        Some("list") => Js::array(items(at(descriptor, "of")).iter().map(revived_field_value).collect::<Result<_, _>>()?),
        Some("map") => {
            let mut out = JsObject::new();
            for (key, entry) in pairs(at(descriptor, "of")) {
                out.set(key.clone(), revived_field_value(entry)?);
            }
            Js::object(out)
        }
        Some("record") => return Err(runtime("a parked field holds a record, which no field can".into())),
        _ => at(descriptor, "value").cloned().unwrap_or(Js::Undefined),
    })
}

/// `combinatorOf`: the `race([…])` / `parallel([…])` a statement carries
/// (awaited, or bare), with its AST path.
pub(crate) fn combinator_of(statement: &Statement, path: &str) -> Option<(CombinatorExpression, String)> {
    let value = |value: &RValue, at: String| match value {
        RValue::Combinator { combinator } => Some((combinator.clone(), format!("{at}/combinator"))),
        RValue::Await { r#await } => match &r#await.source {
            movement_parser::ast::AwaitSource::Combinator { combinator, .. } => Some((combinator.clone(), format!("{at}/await/source/combinator"))),
            _ => None,
        },
        _ => None,
    };
    match statement {
        Statement::Combinator(statement) => Some((statement.combinator.clone(), format!("{path}/combinator"))),
        Statement::Await(statement) => match &statement.r#await.source {
            movement_parser::ast::AwaitSource::Combinator { combinator, .. } => Some((combinator.clone(), format!("{path}/await/source/combinator"))),
            _ => None,
        },
        Statement::Assign(assign) => value(&assign.value, format!("{path}/value")),
        Statement::Return(ret) => value(&ret.value, format!("{path}/value")),
        _ => None,
    }
}

/// `fanOutBlockOf`: the traversal block a fan-out statement runs, with its
/// AST path.
fn fan_out_block_of<'a>(statement: &'a Statement, path: &str) -> Option<(&'a TraversalBlock, String)> {
    match statement {
        Statement::Block(statement) => Some((&statement.block, format!("{path}/block"))),
        Statement::Assign(movement_parser::ast::AssignStatement { value: RValue::Block { block }, .. }) => Some((block, format!("{path}/value/block"))),
        Statement::Return(movement_parser::ast::ReturnStatement { value: RValue::Block { block }, .. }) => Some((block, format!("{path}/value/block"))),
        _ => None,
    }
}

/// `boundRValueOf(…).name`: where a statement's right-hand side lands.
fn bound_name_of(statement: &Statement) -> Option<String> {
    match statement {
        Statement::Assign(assign) => Some(assign.name.clone()),
        Statement::Return(_) => Some(RETURN_SLOT.into()),
        _ => None,
    }
}

/// `armCountOf`: written in the source, or kept at the frame.
fn arm_count_of(combinator: &CombinatorExpression, rows: &[(i64, Js)]) -> usize {
    match &combinator.arms {
        CombinatorArms::Literal { arms, .. } => arms.len(),
        CombinatorArms::Dynamic { .. } => match rows.iter().find(|(index, _)| *index == -1).and_then(|(_, exports)| at(exports, "arms")) {
            Some(Js::Number(n)) => *n as usize,
            _ => 0,
        },
    }
}

fn step_name(kind: char) -> &'static str {
    match kind {
        's' => "stmt",
        'i' => "iter",
        'b' => "branch",
        _ => "call",
    }
}

fn statement_kind(statement: &Statement) -> &'static str {
    match statement {
        Statement::Import(_) => "import",
        Statement::Assign(_) => "assign",
        Statement::Shape(_) => "shape",
        Statement::Type(_) => "type",
        Statement::Movement(_) => "movement",
        Statement::Listen(_) => "listen",
        Statement::Write(_) => "write",
        Statement::Match(_) => "match",
        Statement::Call(_) => "call",
        Statement::Block(_) => "block",
        Statement::Link(_) => "link",
        Statement::Unlink(_) => "unlink",
        Statement::Delete(_) => "delete",
        Statement::Refresh(_) => "refresh",
        Statement::If(_) => "if",
        Statement::Await(_) => "await",
        Statement::Combinator(_) => "combinator",
        Statement::Collection(_) => "collection",
        Statement::Return(_) => "return",
        Statement::Error(_) => "error",
    }
}

fn encode(address: &[(char, usize)]) -> String {
    address.iter().map(|(kind, index)| format!("{kind}{index}")).collect::<Vec<_>>().join(".")
}

/// The AST path of an op's function argument.
fn origin_fn_path(origin: &OpOrigin) -> String {
    match origin {
        OpOrigin::Written(path) => format!("{path}/fn"),
        OpOrigin::Call { call, path } => format!("{path}/args/{}", call.args.len() - 1),
    }
}

