//! Collection ops — `MAP`, `FILTER`, `REDUCE`, `GROUPBY`, `KEYBY` — and
//! `MEMBERS(<T>)`: run.ts's `interpretCollectionOp` and `interpretMembers`.
//!
//! An op is one of its statement's calls (`… .c k`): its members run under
//! it, the i-th at `… .c k.i i`. The function is a closure written in
//! place, which captures the scope it is written in, or a movement handed
//! by name, which captures the caller's (from version 3 a named call, on
//! the call depth). Each member binds as `bindValue` binds it — a record
//! as itself — and what the function returns is the member's answer, in the
//! currency it came in: a record as itself, anything else its value.
//!
//! Members run `concurrency` at a time after a first batch of
//! `initialConcurrency` (run.ts `runMembers`), each in a flow of its own:
//! its trace spliced into the enclosing one in member order, its writes
//! ordered under the op's fork by its index, its effects kept apart from
//! the others' by the run's locks. Under
//! `onError: "warn"` or `"ignore"` a member whose function fails is left
//! out (`warn` traces why); a failure that is the run's (its cost cap, the
//! call depth, the call ceiling, a quiet end) passes through whatever it
//! says, and stops the op, as the first failure does under `"error"`.

use std::cell::RefCell;
use std::rc::Rc;

use movement_parser::ast::{self, ArmExpression, CallArg, CallStatement, CollectionOp, CollectionOpExpression, MembersExpression, MovementParam, Statement};
use movement_parser::lowering::expression::{Expression, ObjectMember, StaticValue};

use crate::bindings::{Binding, Scope};
use crate::env::{Trail, ValueBinding};
use crate::js::{Js, JsObject};
use crate::flow::Boundary;
use crate::run::{Address, Failure, Flow, Run, Stop};
use crate::trace::TraceEntry;

/// `CollectionRunSettings`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnError {
    Error,
    Warn,
    Ignore,
}

/// A collection op as a member frame keeps it: the op, and the object the
/// TypeScript's park writes for it (`SerializedFrame.op`, its AST as the
/// TypeScript holds it).
#[derive(Debug)]
pub(crate) struct OpCode {
    pub op: CollectionOpExpression,
    pub json: Js,
}

/// The function an op runs over its members.
pub(crate) struct Function {
    params: Vec<MovementParam>,
    body: Vec<Statement>,
    captured: Rc<Scope>,
    /// The body's AST path, where its statements' stamps are keyed.
    path: String,
    /// A function handed by name: from version 3 a call by that name.
    named: Option<String>,
    /// A closure handed by name: the closure, its body calling it by the
    /// name of its own (`self`).
    closure: Option<Rc<crate::bindings::Closure>>,
    self_name: Option<String>,
    /// A function written in place from version 5: `captured` is the scope
    /// it is written in, held by REFERENCE, as every other closure holds
    /// its scope.
    by_reference: bool,
}

impl Function {
    /// run.ts `closureScope(fn)`: the scope a member's scopes chain from —
    /// a named closure's own, or a fresh one built from a snapshot.
    pub(crate) fn call_root(&self) -> Rc<Scope> {
        match &self.closure {
            Some(closure) => closure.call_root(),
            None if self.by_reference => self.captured.clone(),
            None => self.captured.fresh_copy(),
        }
    }

    pub(crate) fn body_statements(&self) -> &[Statement] {
        &self.body
    }

    pub(crate) fn body_path(&self) -> &str {
        &self.path
    }

    /// The name a function handed by name is called by.
    pub(crate) fn named_call(&self) -> Option<&str> {
        self.named.as_deref()
    }

    fn copy(&self) -> Function {
        Function {
            params: self.params.clone(),
            body: self.body.clone(),
            captured: self.captured.clone(),
            path: self.path.clone(),
            named: self.named.clone(),
            closure: self.closure.clone(),
            self_name: self.self_name.clone(),
            by_reference: self.by_reference,
        }
    }
}

impl CollectionRun {
    /// The run, for its resume to fill in its members and start.
    pub(crate) fn resumed_copy(&self) -> CollectionRun {
        CollectionRun {
            op: self.op.clone(),
            on_error: self.on_error,
            function: self.function.copy(),
            address: self.address.clone(),
            site: self.site.clone(),
            index: self.index,
            members: self.members.clone(),
            source_trail: self.source_trail.clone(),
            init: self.init.clone(),
            concurrency: self.concurrency,
            initial: self.initial,
        }
    }
}

/// `serializeMemberAnswer`: a finished member as its op's frame keeps it.
/// From version 5 the park names `chain`, the op's live scopes
/// (`memberAnswerPark`); before, the answer is written as it always was.
pub(crate) fn member_answer_export(run: &Run<'_>, answer: Option<&Js>, chain: Option<&[Rc<Scope>]>) -> Result<Js, Failure> {
    Ok(match answer {
        Some(value) => {
            let value = Binding::Value(ValueBinding { value: value.clone(), trail: Some(Trail::default()), many: false });
            let written = match chain {
                Some(chain) => crate::park::serialize_naming_chain(run, &value, chain)?,
                None => crate::park::serialize_alone_plain(run, &value)?,
            };
            crate::env::object_of(vec![("kept", Js::Bool(true)), ("answer", written)])
        }
        None => crate::env::object_of(vec![("kept", Js::Bool(false))]),
    })
}

/// `memberValue`: what a member's function returned, a record as itself; a
/// function that returned nothing answers null for `MAP`.
pub(crate) fn member_answer_in(op: CollectionOp, spelling: &str, flow: Flow, at: &Scope) -> Result<Js, Stop> {
    let returned = match flow {
        Flow::Returned => at.resolve_own(crate::run::RETURN_SLOT),
        Flow::FellThrough => None,
    };
    match returned {
        Some(Binding::Value(value)) => Ok(value.value),
        Some(record) => Ok(crate::record::held(record)),
        None if op == CollectionOp::Map => Ok(Js::Null),
        None => Err(Stop::Thrown(Failure::engine(
            "MOVENG_RUNTIME",
            format!("the function for '{spelling}' returned nothing — the checker should have caught this"),
        ))),
    }
}

/// Where an op is written: as an op (its node's AST path), or as a call of
/// one (version 3; the call and its AST path).
pub(crate) enum OpOrigin {
    Written(String),
    Call { call: CallStatement, path: String },
}

impl OpOrigin {
    /// The AST path of the op's function argument.
    fn fn_path(&self, _expr: &CollectionOpExpression) -> String {
        match self {
            OpOrigin::Written(path) => format!("{path}/fn"),
            OpOrigin::Call { call, path } => format!("{path}/args/{}", call.args.len() - 1),
        }
    }
}

/// One collection op being run (`CollectionRun`): whatever its members and
/// its answer need, whether it started in this segment or is being finished
/// on resume.
pub(crate) struct CollectionRun {
    pub op: Rc<OpCode>,
    pub on_error: OnError,
    pub function: Function,
    /// The op's own address, its statement's `call k`: members are `iter i`
    /// under it, and it is the join frame when members park.
    pub address: Address,
    /// The op as its statement's call: the statement its members'
    /// boundaries name, and which call it is.
    pub site: Option<Rc<crate::flow::Site>>,
    pub index: usize,
    pub members: Vec<Js>,
    pub source_trail: Trail,
    /// `REDUCE`'s starting value (null for the other ops).
    pub init: Js,
    /// How many members run at once, and how many the first batch runs.
    pub concurrency: usize,
    pub initial: usize,
}

/// `memberLeftOut`: the warning `onError: "warn"` leaves for a member it
/// left out.
pub(crate) fn member_left_out(spelling: &str, index: usize, count: Option<usize>, failure: &Failure) -> TraceEntry {
    let of = count.map_or_else(String::new, |count| format!(" of {count}"));
    TraceEntry::Warning {
        code: "MOVENG_COLLECTION_MEMBER_FAILED".into(),
        message: format!("'{spelling}' left out the member at index {index}{of}, because its function failed: {}", error_message(failure)),
    }
}

/// What a version-3 call of a built-in reads as (`readCall`): the op, or
/// `MEMBERS`, or nothing this module runs.
// Handed straight back to its caller and taken apart at once, never stored
// in bulk: boxing the large variant would only add an allocation.
#[allow(clippy::large_enum_variant)]
pub(crate) enum Reading {
    Collection(CollectionOpExpression),
    Members(MembersExpression),
}

/// `lookupBuiltin(written)` for the forms this module runs; from version 5
/// also `sort` by a function key, which the tree calls `SORTBY`
/// (movement_parser::surface::table::SORT_BY).
fn builtin_form(written: &str, language_version: u32) -> Option<Option<CollectionOp>> {
    if language_version >= 5 && written == movement_parser::surface::table::SORT_BY {
        return Some(Some(CollectionOp::Sort));
    }
    match crate::js::to_lower_case(written).as_str() {
        "map" => Some(Some(CollectionOp::Map)),
        "filter" => Some(Some(CollectionOp::Filter)),
        "reduce" => Some(Some(CollectionOp::Reduce)),
        "groupby" => Some(Some(CollectionOp::Groupby)),
        "keyby" => Some(Some(CollectionOp::Keyby)),
        "members" => Some(None),
        _ => None,
    }
}

/// The op as the TypeScript spells it in its messages.
pub(crate) fn spelling(op: CollectionOp) -> &'static str {
    match op {
        CollectionOp::Map => "MAP",
        CollectionOp::Filter => "FILTER",
        CollectionOp::Reduce => "REDUCE",
        CollectionOp::Groupby => "GROUPBY",
        CollectionOp::Keyby => "KEYBY",
        CollectionOp::Sort => "sort",
    }
}

/// `readCall`'s collection and `MEMBERS` readings of a call whose callee
/// the program does not bind, from version 3; `None` for any other call.
/// `binds` is the call scope's `binds`.
pub(crate) fn reading(call: &CallStatement, binds: bool, language_version: u32) -> Result<Option<Reading>, String> {
    if binds || language_version < 3 {
        return Ok(None);
    }
    let Some(form) = builtin_form(&call.callee, language_version) else { return Ok(None) };
    if call.args.iter().any(|arg| arg.name().is_some()) {
        return Err(format!("'{}' is a built-in, and a built-in takes its arguments in order", call.callee));
    }
    let Some(op) = form else {
        let [CallArg::Type { type_, span, .. }] = call.args.as_slice() else {
            return Err(format!("'{}' takes one type", call.callee));
        };
        return Ok(Some(Reading::Members(MembersExpression { type_: type_.clone(), span: call.span, type_span: *span })));
    };
    let configurable = matches!(op, CollectionOp::Map | CollectionOp::Filter | CollectionOp::Sort);
    let counts: &[usize] = if op == CollectionOp::Reduce {
        &[3]
    } else if configurable {
        &[2, 3]
    } else {
        &[2]
    };
    if !counts.contains(&call.args.len()) {
        return Err(format!("'{}' is not given the arguments it takes", call.callee));
    }
    let value = |arg: &CallArg| match arg {
        CallArg::Expr { expr, .. } => Ok(expr.clone()),
        CallArg::Call { call, .. } => call.expression.clone().ok_or_else(|| format!("a named call is not a value — bind '{}(…)' first", call.callee)),
        _ => Err("an argument that is not a value".to_string()),
    };
    let source = value(&call.args[0])?;
    let (mut init, mut config) = (None, None);
    if op == CollectionOp::Reduce {
        init = Some(value(&call.args[1])?);
    } else if call.args.len() == 3 {
        let slot = value(&call.args[1])?;
        if !slot.raw.trim_start().starts_with('{') {
            return Err(format!("'{}' takes its settings as a record written in place", call.callee));
        }
        config = Some(slot);
    }
    let r#fn = match call.args.last().expect("two or three arguments") {
        CallArg::Closure { closure, span, .. } => ArmExpression::Closure { closure: closure.clone(), span: *span },
        CallArg::Expr { expr, .. } => {
            let raw = crate::js::trim(&expr.raw);
            let units: Vec<u16> = crate::js_string::units_vec(raw);
            match movement_parser::scan::scan_name(&units, 0) {
                Some((name, end)) if end == units.len() => ArmExpression::Ref { name, span: expr.span },
                _ => return Err(format!("The function for '{}' is a function's name, or a closure — not the expression '{raw}'", call.callee)),
            }
        }
        _ => return Err(format!("The function for '{}' is a function's name, or a closure", call.callee)),
    };
    Ok(Some(Reading::Collection(CollectionOpExpression { op, source, init, config, r#fn, span: call.span })))
}

/// A width the checker read as a positive whole number.
pub(crate) fn width(n: f64) -> usize {
    if n.is_finite() && n >= 1.0 { n as usize } else { 1 }
}

/// `readCollectionConfig` for the settings a record written in place
/// names: what each says, or why it says nothing this engine runs.
pub(crate) fn settings(config: Option<&ast::ExprSlot>) -> Result<(OnError, f64, f64), String> {
    let Some(config) = config else { return Ok((OnError::Error, 1.0, 1.0)) };
    let (on_error, concurrency, initial) = written_settings(config)?;
    let concurrency = concurrency.unwrap_or(1.0);
    Ok((on_error, concurrency, initial.unwrap_or(concurrency)))
}

/// What a settings record written in place says: `onError`, and the
/// `concurrency` and `initialConcurrency` it names, if it names them.
fn written_settings(config: &ast::ExprSlot) -> Result<(OnError, Option<f64>, Option<f64>), String> {
    let lowered = movement_parser::expr::parse_expression(&config.raw)
        .ok()
        .and_then(|tree| movement_parser::lowering::lower_expression(&tree, &config.raw).ok())
        .ok_or("settings that do not lower")?;
    let Expression::Object { entries } = lowered else { return Err("settings that are not a record".into()) };
    let (mut on_error, mut concurrency, mut initial) = (OnError::Error, None, None);
    for entry in entries {
        let ObjectMember::Entry { key, value } = entry else { return Err("a spread in the settings".into()) };
        match (key.as_str(), &value) {
            ("onError", Expression::Static { value: StaticValue::String(mode) }) => {
                on_error = match mode.as_str() {
                    "error" => OnError::Error,
                    "warn" => OnError::Warn,
                    "ignore" => OnError::Ignore,
                    _ => return Err(format!("onError \"{mode}\"")),
                }
            }
            ("concurrency", Expression::Static { value: StaticValue::Number(n) }) => concurrency = Some(n.0),
            ("initialConcurrency", Expression::Static { value: StaticValue::Number(n) }) => initial = Some(n.0),
            (key, _) => return Err(format!("the setting '{key}'")),
        }
    }
    Ok((on_error, concurrency, initial))
}

/// `readSortSettings`: whether `sort`'s settings record (version 5) asks for
/// descending order; none written is ascending.
pub(crate) fn sort_descending(config: Option<&ast::ExprSlot>) -> Result<bool, String> {
    let Some(config) = config else { return Ok(false) };
    let lowered = movement_parser::expr::parse_expression(&config.raw)
        .ok()
        .and_then(|tree| movement_parser::lowering::lower_expression(&tree, &config.raw).ok())
        .ok_or("settings that do not lower")?;
    let Expression::Object { entries } = lowered else { return Err("settings that are not a record".into()) };
    let mut descending = false;
    for entry in entries {
        match entry {
            ObjectMember::Entry { key, value: Expression::Static { value: StaticValue::String(order) } } if key == "order" && (order == "asc" || order == "desc") => {
                descending = order == "desc";
            }
            ObjectMember::Entry { key, .. } => return Err(format!("the setting '{key}'")),
            ObjectMember::Spread(_) => return Err("a spread in the settings".into()),
        }
    }
    Ok(descending)
}

/// `readCollectionConfig` for `all`'s settings record (`ALL_SETTING_KEYS`):
/// `onError` and `concurrency` only, every arm at once (`arms`) unless it
/// says otherwise.
pub(crate) fn all_settings(config: &ast::ExprSlot, arms: usize) -> Result<(OnError, f64), String> {
    let (on_error, concurrency, initial) = written_settings(config)?;
    if initial.is_some() {
        return Err("the setting 'initialConcurrency'".into());
    }
    Ok((on_error, concurrency.unwrap_or(arms as f64)))
}

impl Run<'_> {
    /// `interpretCollectionOp`: the op opened as its statement's next call
    /// (handing back what it answered before a park, on a re-run), run, and
    /// its answer bound when it is.
    pub(crate) async fn collection(&self, expr: &CollectionOpExpression, binding_name: Option<&str>, scope: &Rc<Scope>, at: &Address, origin: OpOrigin) -> Result<(), Stop> {
        let event = self.begin_call_event().await?;
        let answer = match &event.replayed {
            Some(replayed) => replayed.value.clone(),
            None => {
                let answer = self.run_collection(expr, scope, at, &origin, &event).await?;
                self.finish_call(&event, Some(&answer));
                Some(answer)
            }
        };
        if let Some(name) = binding_name {
            let bound = answer.ok_or_else(|| {
                Stop::Thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!("'{}' returned nothing, so there is no value to bind — the checker should have caught this", spelling(expr.op)),
                ))
            })?;
            scope.declare(name, bound);
        }
        Ok(())
    }

    async fn run_collection(&self, expr: &CollectionOpExpression, scope: &Rc<Scope>, at: &Address, origin: &OpOrigin, event: &crate::call::CallEvent) -> Result<Binding, Stop> {
        let spelling = spelling(expr.op);
        let source = self.evaluate_slot(&expr.source, scope).await?;
        let source_trail = self.trail_or_none(&source.prov, scope);
        let Js::Array(list) = &source.value else {
            let got = if source.value.is_nullish() { "nothing".to_string() } else { source.value.type_of().to_string() };
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("'{spelling}' reads a collection of values and got {got} — the checker should have caught this"),
            )));
        };
        let members = list.items().clone();
        let init = match (&expr.init, expr.op) {
            (Some(init), CollectionOp::Reduce) => self.evaluate_slot(init, scope).await?.value,
            _ => Js::Null,
        };
        let read = if expr.op == CollectionOp::Sort { sort_descending(expr.config.as_ref()).map(|_| (OnError::Error, 1.0, 1.0)) } else { settings(expr.config.as_ref()) };
        let (on_error, concurrency, initial) = read.map_err(|problem| {
            Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("'{spelling}' was given settings it cannot run with — the checker should have caught this: {problem}")))
        })?;
        let function = self.collection_function(&expr.r#fn, spelling, scope, &origin.fn_path(expr))?;
        let run = CollectionRun {
            op: Rc::new(OpCode { op: expr.clone(), json: self.op_json(expr, origin).map_err(Stop::Thrown)? }),
            on_error,
            function,
            address: self.call_address(event, at),
            site: event.site.clone(),
            index: event.index,
            members,
            source_trail,
            init,
            concurrency: width(concurrency),
            initial: width(initial),
        };
        let answers = vec![None; run.members.len()];
        let indices: Vec<usize> = (0..run.members.len()).collect();
        self.run_members(&run, &indices, answers).await
    }

    /// `runCollectionMembers` / `runMembers`: the members at `indices`, the
    /// op's `concurrency` at a time, each in a flow of its own (its writes
    /// under the op's fork by its index), inside its member boundary. The
    /// first `initialConcurrency` members are a batch of their own, run to
    /// the end before any other starts; the rest take the next member as a
    /// slot frees. Each member's trace joins the enclosing one as soon as
    /// every member before it has finished, so it reads in member order. A
    /// member that parks holds its slot (that slot starts nothing more; the
    /// others go on), nothing past the first batch starts once one of it has
    /// parked, and a paused run starts nothing more once one has; the op then
    /// parks as a join of its parked members, keeping what the others
    /// answered. A member whose function fails under `onError: "warn"` or
    /// `"ignore"` is left out (`warn` traces why, after the member's own
    /// entries); any other failure stops further members starting, and once
    /// those running have finished the earliest member's is the op's.
    pub(crate) async fn run_members(&self, run: &CollectionRun, indices: &[usize], answers: Vec<Option<Option<Js>>>) -> Result<Binding, Stop> {
        let spelling = spelling(run.op.op.op);
        let fork = self.fork_writes();
        let answers = RefCell::new(answers);
        let parked: RefCell<Vec<usize>> = RefCell::default();
        let failure: RefCell<Option<(usize, Stop)>> = RefCell::default();
        let next = std::cell::Cell::new(0usize);
        let traces: RefCell<Vec<Option<Vec<TraceEntry>>>> = RefCell::new(vec![None; indices.len()]);
        let spliced = std::cell::Cell::new(0usize);
        let splice = || {
            let mut traces = traces.borrow_mut();
            while spliced.get() < indices.len() {
                let Some(trace) = traces[spliced.get()].take() else { break };
                self.trace.extend(trace);
                spliced.set(spliced.get() + 1);
            }
        };
        // The member at `position` of `indices`; true when it parked.
        let run_one = |position: usize| {
            let fork = &fork;
            let answers = &answers;
            let parked = &parked;
            let failure = &failure;
            let traces = &traces;
            let splice = &splice;
            async move {
                let index = indices[position];
                let state = self.open_flow(fork.branch(index));
                let snapshot = answers.borrow().clone();
                let (outcome, mut state) = self.in_flow(state, self.member(run, index, &snapshot)).await;
                let mut held = false;
                match outcome {
                    Ok(value) => answers.borrow_mut()[index] = Some(Some(value)),
                    Err(Stop::Parked(_)) => {
                        parked.borrow_mut().push(index);
                        held = true;
                    }
                    Err(Stop::Thrown(failed)) if run.on_error != OnError::Error && is_member_failure(&failed) => {
                        if run.on_error == OnError::Warn {
                            state.trace.push(member_left_out(spelling, index, Some(run.members.len()), &failed));
                        }
                        answers.borrow_mut()[index] = Some(None);
                    }
                    Err(other) => {
                        let mut failure = failure.borrow_mut();
                        if failure.as_ref().is_none_or(|(earliest, _)| index < *earliest) {
                            *failure = Some((index, other));
                        }
                    }
                }
                traces.borrow_mut()[position] = Some(state.trace);
                splice();
                held
            }
        };
        // `width` slots, each taking the next member until `end`, a failure,
        // its own member parking, or a paused run's first park.
        let run_batch = |end: usize, width: usize| {
            let run_one = &run_one;
            let next = &next;
            let failure = &failure;
            let parked = &parked;
            async move {
                let slots = width.min(end.saturating_sub(next.get()));
                let slot = || async move {
                    while failure.borrow().is_none() && next.get() < end && !(self.limit_paused.get() && !parked.borrow().is_empty()) {
                        let position = next.get();
                        next.set(position + 1);
                        if run_one(position).await {
                            return;
                        }
                    }
                };
                crate::executor::join_all((0..slots).map(|_| slot()).collect()).await;
            }
        };
        if run.initial < run.concurrency {
            run_batch(run.initial.min(indices.len()), run.initial).await;
        }
        if parked.borrow().is_empty() {
            run_batch(indices.len(), run.concurrency).await;
        }
        // A failed op stopped starting members: what the ones that ran did
        // still belongs on the trace, in member order.
        for trace in traces.borrow_mut().iter_mut().skip(spliced.get()) {
            if let Some(trace) = trace.take() {
                self.trace.extend(trace);
            }
        }
        if let Some((_, stop)) = failure.into_inner() {
            return Err(stop);
        }
        let answers = answers.into_inner();
        let parked = parked.into_inner();
        if !parked.is_empty() {
            return Err(self.park_collection_op(run, &answers, parked.len()).await);
        }
        let flat: Vec<Option<Js>> = answers.into_iter().map(Option::flatten).collect();
        self.collection_answer(&run.op.op, spelling, &run.members, &flat, &run.init, run.source_trail.clone())
    }

    /// One member: its function's body in a scope of its own off what the
    /// function captured, its parameters bound from the member (and for
    /// `REDUCE` what the members before it carried), inside its boundary
    /// and, for a function named, as a call by that name.
    async fn member(&self, run: &CollectionRun, index: usize, answers: &[Option<Option<Js>>]) -> Result<Js, Stop> {
        let member = run.members[index].clone();
        let values = match run.op.op.op {
            CollectionOp::Reduce => {
                let before: Vec<Option<Js>> = answers[..index].iter().map(|a| a.clone().flatten()).collect();
                vec![carried(&before, &run.init), member]
            }
            _ => vec![member],
        };
        let at = run.function.call_root().child_written_in(crate::program::file_of_path(&run.function.path).0);
        if let Some(name) = &run.function.self_name {
            at.declare(name.clone(), Binding::Closure(run.function.closure.clone().expect("a function with a name of its own is a closure")));
        }
        for (position, param) in run.function.params.iter().enumerate() {
            // `values[name] ?? null`.
            let value = match values.get(position) {
                Some(value) if !value.is_nullish() => value.clone(),
                _ => Js::Null,
            };
            at.declare(param.name.clone(), crate::record::bind_value(value, Some(Trail::default()), false));
        }
        let address = run.address.iter(index);
        let body = async {
            let named = run.function.named.as_deref();
            let flow = self.within_named_call(named, self.body(&run.function.body, &at, &address, &run.function.path, 0)).await?;
            self.member_answer(run.op.op.op, spelling(run.op.op.op), flow, &at)
        };
        match &run.site {
            Some(site) => {
                let next = site.calls.borrow().next;
                let boundary = Boundary::Member { site: site.clone(), index: run.index, next, member: index, op: run.op.clone() };
                self.within_boundary(boundary, body).await
            }
            None => body.await,
        }
    }

    /// `liveAnswerChain`: from version 5, the live scopes the op's statement
    /// runs in, its file's left out (a file scope is found again by its
    /// file) — what a member's answer names rather than copies, numbered by
    /// their place in the chain, the same on the writing run and the
    /// resuming one.
    pub(crate) fn live_answer_chain(&self, run: &CollectionRun) -> Option<Vec<Rc<Scope>>> {
        if self.version() < 5 {
            return None;
        }
        let Some(site) = &run.site else { return Some(Vec::new()) };
        Some(site.scope.chain_from_root().into_iter().filter(|scope| !scope.is_file_scope()).collect())
    }

    /// `parkCollectionOp`: some members parked; the op is a pending join at
    /// its own address, keeping what its resume needs (the members it reads,
    /// `REDUCE`'s start, each finished member's answer) at that frame.
    async fn park_collection_op(&self, run: &CollectionRun, answers: &[Option<Option<Js>>], parked: usize) -> Stop {
        let frame = run.address.encode();
        let kept = async {
            if self.serves("park.sink.persistBranchExport") {
                let source = Binding::Value(ValueBinding { value: Js::array(run.members.clone()), trail: Some(run.source_trail.clone()), many: false });
                let init = Binding::Value(ValueBinding { value: run.init.clone(), trail: Some(Trail::default()), many: false });
                let state = crate::env::object_of(vec![
                    ("source", crate::park::serialize_alone_plain(self, &source).map_err(Stop::Thrown)?),
                    ("init", crate::park::serialize_alone_plain(self, &init).map_err(Stop::Thrown)?),
                ]);
                self.persist_branch_export(&frame, &frame, -1, &state).await?;
                for (index, answer) in answers.iter().enumerate() {
                    let Some(answer) = answer else { continue };
                    let exports = member_answer_export(self, answer.as_ref(), self.live_answer_chain(run).as_deref()).map_err(Stop::Thrown)?;
                    self.persist_branch_export(&frame, &run.address.iter(index).encode(), index as i64, &exports).await?;
                }
            }
            self.record_join(&frame, parked).await
        };
        match kept.await {
            Ok(()) => Stop::Parked(frame),
            Err(stop) => stop,
        }
    }

    /// The op as a member frame keeps it (`SerializedFrame.op`): written as
    /// an op, the program's node; read from a call (version 3), the object
    /// `readCall` builds of the call's own pieces.
    fn op_json(&self, expr: &CollectionOpExpression, origin: &OpOrigin) -> Result<Js, Failure> {
        match origin {
            OpOrigin::Written(path) => self.program_code(path),
            OpOrigin::Call { call, path } => {
                let value_at = |index: usize| -> Result<Js, Failure> {
                    match &call.args[index] {
                        CallArg::Call { .. } => self.program_code(&format!("{path}/args/{index}/call/expression")),
                        _ => self.program_code(&format!("{path}/args/{index}/expr")),
                    }
                };
                let op = match expr.op {
                    CollectionOp::Map => "map",
                    CollectionOp::Filter => "filter",
                    CollectionOp::Reduce => "reduce",
                    CollectionOp::Groupby => "groupby",
                    CollectionOp::Keyby => "keyby",
                    CollectionOp::Sort => "sort",
                };
                let mut members = vec![("op", Js::str(op)), ("source", value_at(0)?)];
                if expr.init.is_some() {
                    members.push(("init", value_at(1)?));
                }
                if expr.config.is_some() {
                    members.push(("config", value_at(1)?));
                }
                let last = call.args.len() - 1;
                let function = match &expr.r#fn {
                    ArmExpression::Closure { .. } => crate::env::object_of(vec![
                        ("kind", Js::str("closure")),
                        ("closure", self.program_code(&format!("{path}/args/{last}/closure"))?),
                        ("span", self.program_code(&format!("{path}/args/{last}/span"))?),
                    ]),
                    ArmExpression::Ref { name, .. } => crate::env::object_of(vec![
                        ("kind", Js::str("ref")),
                        ("name", Js::str(name.clone())),
                        ("span", self.program_code(&format!("{path}/args/{last}/expr/span"))?),
                    ]),
                };
                members.push(("fn", function));
                members.push(("span", self.program_code(&format!("{path}/span"))?));
                Ok(crate::env::object_of(members))
            }
        }
    }

    /// `collectionFunction`: a closure written in place, capturing the scope
    /// it is written in, or a movement by name, capturing the caller's.
    pub(crate) fn collection_function(&self, function: &ArmExpression, spelling: &str, scope: &Rc<Scope>, fn_path: &str) -> Result<Function, Stop> {
        match function {
            // From version 5 a function written in place holds the scope it
            // is written in by REFERENCE, as every other closure does — so a
            // closure its body returns chains up to the live scope, not to a
            // flat copy that no park can tell from a file's.
            ArmExpression::Closure { closure, .. } => Ok(Function {
                params: closure.params.clone(),
                body: closure.body.clone(),
                captured: if self.version() >= 5 { scope.written_scope() } else { scope.capture() },
                path: format!("{fn_path}/closure/body"),
                named: None,
                closure: None,
                self_name: None,
                by_reference: self.version() >= 5,
            }),
            ArmExpression::Ref { name, .. } => match scope.resolve(name) {
                Some(Binding::Closure(closure)) => Ok(Function {
                    params: closure.code.ast.params.clone(),
                    body: closure.code.ast.body.clone(),
                    captured: closure.captured.clone(),
                    path: format!("{}/body", closure.code.path),
                    named: Some(name.clone()),
                    self_name: closure.self_name.clone(),
                    closure: Some(closure),
                    by_reference: false,
                }),
                Some(Binding::Movement(declared)) => {
                    let (declaration, path) = self.declaration(&declared)?;
                    Ok(Function {
                        params: declaration.params,
                        body: declaration.body,
                        captured: scope.capture_written_in(declared.file.clone()),
                        path,
                        named: Some(name.clone()),
                        closure: None,
                        self_name: None,
                        by_reference: false,
                    })
                }
                other => {
                    let what = other.as_ref().map_or_else(|| "not in scope".to_string(), crate::write::describe_binding);
                    Err(Stop::Thrown(Failure::engine(
                        "MOVENG_RUNTIME",
                        format!("'{name}' is {what}, and '{spelling}' runs a function — the checker should have caught this"),
                    )))
                }
            },
        }
    }

    fn member_answer(&self, op: CollectionOp, spelling: &str, flow: Flow, at: &Scope) -> Result<Js, Stop> {
        member_answer_in(op, spelling, flow, at)
    }

    /// `collectionAnswer`: the op's value from every member's answer, in
    /// member order.
    fn collection_answer(&self, expr: &CollectionOpExpression, spelling: &str, members: &[Js], answers: &[Option<Js>], init: &Js, source: Trail) -> Result<Binding, Stop> {
        let op = expr.op;
        let transformed = Trail { origins: source.origins.clone(), direct: None };
        let value = |value: Js, trail: Trail| Ok(Binding::Value(ValueBinding { value, trail: Some(trail), many: false }));
        match op {
            // The members in the order of what the function answered for
            // each (`sortByOrderKey`, as `SORT` orders): stable, a missing key
            // last whichever the order. The members keep their own trail.
            CollectionOp::Sort => {
                let descending = sort_descending(expr.config.as_ref()).map_err(|problem| {
                    Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("'{spelling}' was given settings it cannot run with — the checker should have caught this: {problem}")))
                })?;
                let keys: Vec<Js> = answers.iter().map(|a| a.clone().unwrap_or(Js::Null)).collect();
                let direction = if descending { movement_parser::lowering::expression::OrderDirection::Desc } else { movement_parser::lowering::expression::OrderDirection::Asc };
                let order = crate::order_limit::sort_by_order_key(&keys, Some(direction));
                value(Js::array(order.into_iter().map(|i| members[i].clone()).collect()), source)
            }
            CollectionOp::Reduce => value(carried(answers, init), transformed),
            CollectionOp::Map => value(Js::array(answers.iter().flatten().cloned().collect()), transformed),
            // The language's own truthiness: the function returns a boolean.
            CollectionOp::Filter => {
                let kept = members.iter().zip(answers).filter(|(_, a)| matches!(a, Some(Js::Bool(true)))).map(|(m, _)| m.clone()).collect();
                value(Js::array(kept), source)
            }
            CollectionOp::Groupby | CollectionOp::Keyby => {
                let mut filed = JsObject::new();
                for (member, answer) in members.iter().zip(answers) {
                    let Some(key) = answer else { continue };
                    let Js::String(key) = key else {
                        let what = if key.is_nullish() { "nothing".to_string() } else { key.type_of().to_string() };
                        return Err(Stop::Thrown(Failure::engine(
                            "MOVENG_RUNTIME",
                            format!("'{spelling}' files each member under a text key, and this one answered {what} — the checker should have caught this"),
                        )));
                    };
                    if op == CollectionOp::Keyby {
                        if filed.get(key.as_form()).is_some() {
                            return Err(Stop::Thrown(Failure::engine(
                                "MOVENG_RUNTIME",
                                format!("KEYBY says each key names one member, and '{key}' names more than one. Use GROUPBY if a key can have several."),
                            )));
                        }
                        filed.set(key.to_string(), member.clone());
                        continue;
                    }
                    let group = match filed.get(key.as_form()) {
                        Some(Js::Array(group)) => {
                            let mut items = group.items().clone();
                            items.push(member.clone());
                            items
                        }
                        _ => vec![member.clone()],
                    };
                    filed.set(key.to_string(), Js::array(group));
                }
                value(Js::object(filed), transformed)
            }
        }
    }

    /// `assertCallDepth` for a function handed to an op by name (version 3).
    pub(crate) fn enter_named_call(&self, name: &str) -> Result<(), Stop> {
        let stack = self.call_stack.borrow();
        let limit = self.input.max_call_depth;
        if stack.len().saturating_sub(1) < limit {
            return Ok(());
        }
        Err(Stop::Thrown(Failure::CallDepth { limit, chain: stack.iter().cloned().chain(std::iter::once(name.to_string())).collect() }))
    }

    /// `interpretMembers`: a closed type's values in declaration order — a
    /// type the file declares, or another field's option set, read off its
    /// graph's live schema.
    pub(crate) fn members(&self, expr: &MembersExpression, binding_name: Option<&str>, scope: &Scope) -> Result<(), Stop> {
        let options = match movement_parser::catalog::helpers::borrowed_type_segments(Some(&expr.type_)) {
            Some(segments) if segments.len() == 3 => match scope.resolve(&segments[0]) {
                Some(Binding::Instance(instance)) => instance
                    .schema
                    .as_ref()
                    .and_then(|schema| crate::extract::spec::borrowable_field(schema, &segments[1], &segments[2]))
                    .and_then(|field| match field {
                        movement_parser::catalog::types::FieldType::Composite(movement_parser::catalog::types::Composite::Enum { options, .. }) => Some(options),
                        _ => None,
                    }),
                _ => None,
            },
            Some(_) => None,
            None => self.checked.declarations.of_file(&scope.file_env()).and_then(|d| d.types.get(&expr.type_)).cloned(),
        };
        let Some(options) = options else {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("'MEMBERS(<{}>)' names no closed set of values — the checker should have caught this", expr.type_),
            )));
        };
        if let Some(name) = binding_name {
            let value = Js::array(options.into_iter().map(Js::str).collect());
            scope.declare(name, Binding::Value(ValueBinding { value, trail: Some(Trail::default()), many: false }));
        }
        Ok(())
    }
}

/// `carriedBefore`: the last answer a member kept, or the start.
fn carried(answers: &[Option<Js>], init: &Js) -> Js {
    answers.iter().rev().flatten().next().cloned().unwrap_or_else(|| init.clone())
}

/// `isMemberFailure`: the member's own failure, which `onError` may forgive;
/// the run's (its cost cap, the call depth, the call ceiling, a lost lease)
/// passes through, and so does this engine's own refusal of a reading the
/// TypeScript's member would have made (forgiving it would drop a member the
/// TypeScript keeps).
pub(crate) fn is_member_failure(failure: &Failure) -> bool {
    match failure {
        Failure::Engine { class: crate::eval::ErrorClass::Unreproduced, .. } => false,
        Failure::Engine { .. } => true,
        Failure::Host(error) => !matches!(error.detail.get("name").and_then(serde_json::Value::as_str), Some("AdapterCallCeilingExceeded" | "RunLeaseLost" | "RunCancelledSignal")),
        Failure::CapExceeded(_) | Failure::CallDepth { .. } => false,
    }
}

/// `getErrorMessage(error)`: a `MovementEngineError`'s message carries its code.
pub(crate) fn error_message(failure: &Failure) -> String {
    match failure {
        Failure::Engine { class: crate::eval::ErrorClass::Engine(code), message } => format!("{code}: {message}"),
        Failure::Engine { class: crate::eval::ErrorClass::Unreproduced, .. } => unreachable!("never forgiven"),
        Failure::Engine { message, .. } => message.clone(),
        Failure::Host(error) => error.message().to_string(),
        Failure::CapExceeded(_) | Failure::CallDepth { .. } => unreachable!("never forgiven"),
    }
}
