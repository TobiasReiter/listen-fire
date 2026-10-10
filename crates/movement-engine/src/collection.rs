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
//! Members run one at a time, in order: the settings admission lets by are
//! one at a time (`concurrency` 1), where a member's trace, writes and
//! failure land exactly where running it in place would put them. Under
//! `onError: "warn"` or `"ignore"` a member whose function fails is left
//! out (`warn` traces why); a failure that is the run's (its cost cap, the
//! call depth, the call ceiling, a quiet end) passes through whatever it
//! says, and stops the op, as the first failure does under `"error"`.

use std::rc::Rc;

use movement_parser::ast::{self, ArmExpression, CallArg, CallStatement, CollectionOp, CollectionOpExpression, MembersExpression, MovementParam, Statement};
use movement_parser::lowering::expression::{Expression, ObjectMember, StaticValue};

use crate::bindings::{Binding, Scope};
use crate::env::{Trail, ValueBinding};
use crate::js::{Js, JsObject};
use crate::run::{Address, Failure, Flow, Run, Stop};
use crate::trace::TraceEntry;

/// `CollectionRunSettings`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnError {
    Error,
    Warn,
    Ignore,
}

/// The function an op runs over its members.
struct Function {
    params: Vec<MovementParam>,
    body: Vec<Statement>,
    captured: Rc<Scope>,
    /// The body's AST path, where its statements' stamps are keyed.
    path: String,
    /// A movement handed by name: from version 3 a call by that name.
    named: Option<String>,
}

/// What a version-3 call of a built-in reads as (`readCall`): the op, or
/// `MEMBERS`, or nothing this module runs.
pub(crate) enum Reading {
    Collection(CollectionOpExpression),
    Members(MembersExpression),
}

/// `lookupBuiltin(written)` for the forms this module runs.
fn builtin_form(written: &str) -> Option<Option<CollectionOp>> {
    match written.to_lowercase().as_str() {
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
    }
}

/// `readCall`'s collection and `MEMBERS` readings of a call whose callee
/// the program does not bind, from version 3; `None` for any other call.
/// `binds` is the call scope's `binds`.
pub(crate) fn reading(call: &CallStatement, binds: bool, language_version: u32) -> Result<Option<Reading>, String> {
    if binds || language_version < 3 {
        return Ok(None);
    }
    let Some(form) = builtin_form(&call.callee) else { return Ok(None) };
    if call.args.iter().any(|arg| arg.name().is_some()) {
        return Err(format!("'{}' is a built-in, and a built-in takes its arguments in order", call.callee));
    }
    let Some(op) = form else {
        let [CallArg::Type { type_, span, .. }] = call.args.as_slice() else {
            return Err(format!("'{}' takes one type", call.callee));
        };
        return Ok(Some(Reading::Members(MembersExpression { type_: type_.clone(), span: call.span, type_span: *span })));
    };
    let configurable = matches!(op, CollectionOp::Map | CollectionOp::Filter);
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
            let units: Vec<u16> = raw.encode_utf16().collect();
            match movement_parser::scan::scan_name(&units, 0) {
                Some((name, end)) if end == units.len() => ArmExpression::Ref { name, span: expr.span },
                _ => return Err(format!("The function for '{}' is a function's name, or a closure — not the expression '{raw}'", call.callee)),
            }
        }
        _ => return Err(format!("The function for '{}' is a function's name, or a closure", call.callee)),
    };
    Ok(Some(Reading::Collection(CollectionOpExpression { op, source, init, config, r#fn, span: call.span })))
}

/// `readCollectionConfig` for the settings a record written in place
/// names: what each says, or why it says nothing this engine runs.
pub(crate) fn settings(config: Option<&ast::ExprSlot>) -> Result<(OnError, f64, f64), String> {
    let Some(config) = config else { return Ok((OnError::Error, 1.0, 1.0)) };
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
    let concurrency = concurrency.unwrap_or(1.0);
    Ok((on_error, concurrency, initial.unwrap_or(concurrency)))
}

impl Run<'_> {
    /// `interpretCollectionOp`: the op opened as its statement's next call,
    /// run, and its answer bound when it is.
    pub(crate) async fn collection(&self, expr: &CollectionOpExpression, binding_name: Option<&str>, scope: &Rc<Scope>, at: &Address, fn_path: &str) -> Result<(), Stop> {
        let index = self.begin_call();
        let answer = self.run_collection(expr, scope, &at.call(index), fn_path).await?;
        if let Some(name) = binding_name {
            scope.declare(name, answer);
        }
        Ok(())
    }

    async fn run_collection(&self, expr: &CollectionOpExpression, scope: &Rc<Scope>, address: &Address, fn_path: &str) -> Result<Binding, Stop> {
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
        let (on_error, concurrency, initial) = settings(expr.config.as_ref()).map_err(|problem| {
            Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("'{spelling}' was given settings it cannot run with — the checker should have caught this: {problem}")))
        })?;
        if concurrency != 1.0 || initial != 1.0 {
            return Err(Stop::Thrown(Failure::unreproduced(&format!("'{spelling}' running more than one member at a time"), "the Rust engine runs a collection op's members one at a time")));
        }
        let function = self.collection_function(&expr.r#fn, spelling, scope, fn_path)?;
        // Each member's answer, by member index: kept, or left out.
        let mut answers: Vec<Option<Js>> = Vec::with_capacity(members.len());
        for (index, member) in members.iter().enumerate() {
            let values = match expr.op {
                CollectionOp::Reduce => vec![carried(&answers, &init), member.clone()],
                _ => vec![member.clone()],
            };
            let at = function.captured.child();
            for (position, param) in function.params.iter().enumerate() {
                // `values[name] ?? null`.
                let value = match values.get(position) {
                    Some(value) if !matches!(value, Js::Undefined) => value.clone(),
                    _ => Js::Null,
                };
                at.declare(param.name.clone(), crate::record::bind_value(value, Some(Trail::default()), false));
            }
            let named = function.named.as_deref().filter(|_| self.version() >= 3);
            if let Some(name) = named {
                self.enter_named_call(name)?;
                self.call_stack.borrow_mut().push(name.to_string());
            }
            let ran = self.body(&function.body, &at, &address.iter(index), &function.path, 0).await;
            if named.is_some() {
                self.call_stack.borrow_mut().pop();
            }
            match ran {
                Ok(flow) => answers.push(Some(self.member_answer(expr.op, spelling, flow, &at)?)),
                Err(Stop::Thrown(failure)) if on_error != OnError::Error && is_member_failure(&failure) => {
                    if on_error == OnError::Warn {
                        self.trace(TraceEntry::Warning {
                            code: "MOVENG_COLLECTION_MEMBER_FAILED".into(),
                            message: format!(
                                "'{spelling}' left out the member at index {index} of {}, because its function failed: {}",
                                members.len(),
                                error_message(&failure)
                            ),
                        });
                    }
                    answers.push(None);
                }
                Err(other) => return Err(other),
            }
        }
        self.collection_answer(expr.op, spelling, &members, &answers, &init, source_trail)
    }

    /// `collectionFunction`: a closure written in place, capturing the scope
    /// it is written in, or a movement by name, capturing the caller's.
    fn collection_function(&self, function: &ArmExpression, spelling: &str, scope: &Rc<Scope>, fn_path: &str) -> Result<Function, Stop> {
        match function {
            ArmExpression::Closure { closure, .. } => Ok(Function {
                params: closure.params.clone(),
                body: closure.body.clone(),
                captured: scope.capture(),
                path: format!("{fn_path}/closure/body"),
                named: None,
            }),
            ArmExpression::Ref { name, .. } => match scope.resolve(name) {
                Some(Binding::Movement(declared)) => {
                    let (declaration, declared_at) = self.declaration(&declared)?;
                    Ok(Function {
                        params: declaration.params,
                        body: declaration.body,
                        captured: scope.capture(),
                        path: format!("/statements/{declared_at}/body"),
                        named: Some(name.clone()),
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

    /// `memberValue`: what the member's function returned, a record as
    /// itself; a function that returned nothing answers null for `MAP`.
    fn member_answer(&self, op: CollectionOp, spelling: &str, flow: Flow, at: &Scope) -> Result<Js, Stop> {
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

    /// `collectionAnswer`: the op's value from every member's answer, in
    /// member order.
    fn collection_answer(&self, op: CollectionOp, spelling: &str, members: &[Js], answers: &[Option<Js>], init: &Js, source: Trail) -> Result<Binding, Stop> {
        let transformed = Trail { origins: source.origins.clone(), direct: None };
        let value = |value: Js, trail: Trail| Ok(Binding::Value(ValueBinding { value, trail: Some(trail), many: false }));
        match op {
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
                    // `filed['__proto__']` is the answer's prototype: reading it
                    // finds `Object.prototype` (or what a filing put there), and
                    // assigning it sets the prototype — to a member that is an
                    // object, and to nothing for one that is not.
                    if key == "__proto__" {
                        if op == CollectionOp::Keyby {
                            if matches!(member, Js::Object(_) | Js::Array(_) | Js::Record(_) | Js::Function(_)) {
                                filed.proto = Some(member.clone());
                            }
                            continue;
                        }
                        match &filed.proto {
                            Some(Js::Array(list)) => list.push(member.clone()),
                            _ => filed.proto = Some(Js::array(vec![member.clone()])),
                        }
                        continue;
                    }
                    if op == CollectionOp::Keyby {
                        if filed.get(key).is_some() {
                            return Err(Stop::Thrown(Failure::engine(
                                "MOVENG_RUNTIME",
                                format!("KEYBY says each key names one member, and '{key}' names more than one. Use GROUPBY if a key can have several."),
                            )));
                        }
                        filed.set(key.clone(), member.clone());
                        continue;
                    }
                    let group = match filed.get(key) {
                        Some(Js::Array(group)) => {
                            let mut items = group.items().clone();
                            items.push(member.clone());
                            items
                        }
                        Some(_) => vec![member.clone()],
                        // A key the answer does not own reads through its
                        // prototype: a list found there is pushed to in place.
                        None => match filed.proto.as_ref().map(|proto| crate::js::inherited(proto, key)) {
                            Some(Js::Array(list)) => {
                                list.push(member.clone());
                                continue;
                            }
                            _ => vec![member.clone()],
                        },
                    };
                    filed.set(key.clone(), Js::array(group));
                }
                value(Js::object(filed), transformed)
            }
        }
    }

    /// `assertCallDepth` for a function handed to an op by name (version 3).
    fn enter_named_call(&self, name: &str) -> Result<(), Stop> {
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
            None => self.checked.declarations.root.types.get(&expr.type_).cloned(),
        };
        let Some(options) = options else {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("'MEMBERS(<{}>)' names no closed set of values — the checker should have caught this", expr.type_),
            )));
        };
        if let Some(name) = binding_name {
            let value = Js::array(options.into_iter().map(Js::String).collect());
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
fn is_member_failure(failure: &Failure) -> bool {
    match failure {
        Failure::Engine { class: crate::eval::ErrorClass::Unreproduced, .. } => false,
        Failure::Engine { .. } => true,
        Failure::Host(error) => !matches!(error.detail.get("name").and_then(serde_json::Value::as_str), Some("AdapterCallCeilingExceeded" | "RunLeaseLost" | "RunCancelledSignal")),
        Failure::CapExceeded(_) | Failure::CallDepth { .. } => false,
    }
}

/// `getErrorMessage(error)`: a `MovementEngineError`'s message carries its code.
fn error_message(failure: &Failure) -> String {
    match failure {
        Failure::Engine { class: crate::eval::ErrorClass::Engine(code), message } => format!("{code}: {message}"),
        Failure::Engine { class: crate::eval::ErrorClass::Unreproduced, .. } => unreachable!("never forgiven"),
        Failure::Engine { message, .. } => message.clone(),
        Failure::Host(error) => error.message().to_string(),
        Failure::CapExceeded(_) | Failure::CallDepth { .. } => unreachable!("never forgiven"),
    }
}
