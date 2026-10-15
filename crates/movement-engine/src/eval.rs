//! The pure expression evaluator: `evalMovementExpr`
//! (packages/movement-engine/services/movement_engine/expression.ts) over the kinds that
//! need no host — literals, value-binding reads, `AT`, lists, maps,
//! interpolation, conditionals, comparisons, logic, arithmetic and the
//! built-in functions — with the same values, the same provenance and the
//! same errors.
//!
//! Provenance follows the TypeScript's rules exactly: a literal is a fresh
//! origin (one per evaluation), a name passes its binding's trail through
//! untouched, a branch or a `COALESCE` passes the chosen value's trail
//! through, and everything else is the taint union of what it read.
//!
//! The walk is async, as `evalMovementExpr` is: inside a run, a read the
//! host answers (an event field, a built-in this engine hands back) is
//! awaited where it is made and the walk resumes there, so an expression is
//! evaluated once however many reads it makes, in the TypeScript's order.
//! With no run nothing is awaited, and `eval_pure` runs the walk on the spot.

use std::cell::Cell;
use std::future::Future;
use std::pin::Pin;

use movement_parser::lowering::POSITION_SENTINEL;
use movement_parser::lowering::expression::{
    AggregationFunction, Expression, FilterOperator, ListElement, LogicalOp, ObjectMember, OrderDirection, StaticValue,
};

use crate::bindings::Binding;
use crate::env::{Env, Trail, ValueBinding};
use crate::executor::{HostError, ready};
use crate::filter::{arithmetic, at_index, compare_to_null, compare_values, is_null_literal};
use crate::js::{Js, JsObject};
use crate::stdlib::{self, Surroundings};

/// The class a thrown error has on the TypeScript side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    /// `MovementEngineError` with this code.
    Engine(&'static str),
    Error,
    RangeError,
    /// What JavaScript throws reading a property off nothing.
    TypeError,
    /// This engine's own refusal of a reading it does not reproduce, raised
    /// where the TypeScript engine would read on: reported as
    /// `MOVENG_UNSUPPORTED`, and never forgiven by a collection op's
    /// `onError`, which forgives only what the TypeScript's member threw.
    Unreproduced,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EvalError {
    /// What the TypeScript evaluator throws, constructed as it constructs it.
    Thrown { class: ErrorClass, message: String },
    /// A value or construct whose JavaScript reading this engine does not
    /// reproduce (a text only V8's date parser reads, a regex feature): the
    /// TypeScript evaluator answers it instead.
    Fallback(String),
    /// A host request the evaluation awaited failed (`Reader`): the run
    /// fails with the host's own error.
    Host(HostError),
    /// A priced call the evaluation awaited met the run's cost cap: the
    /// statement suspends (run.rs `body`).
    CapExceeded(crate::ledger::CapExceeded),
}

impl EvalError {
    pub fn engine(code: &'static str, message: String) -> EvalError {
        EvalError::Thrown { class: ErrorClass::Engine(code), message }
    }

    pub fn error(message: String) -> EvalError {
        EvalError::Thrown { class: ErrorClass::Error, message }
    }

    fn unsupported(construct: &str, detail: &str) -> EvalError {
        EvalError::engine(
            "MOVENG_UNSUPPORTED",
            format!("{construct} is not supported by the movement engine yet ({detail})"),
        )
    }

    /// `unsupported(construct)`, with no detail.
    fn unsupported_bare(construct: &str) -> EvalError {
        EvalError::engine("MOVENG_UNSUPPORTED", format!("{construct} is not supported by the movement engine yet"))
    }
}

/// A value's trail: exactly a binding's own (passed through), or one built
/// here.
#[derive(Debug, Clone, PartialEq)]
pub enum Prov {
    Binding(String),
    Built(Trail),
}

#[derive(Debug, Clone)]
pub struct Evaluated {
    pub value: Js,
    pub prov: Prov,
}

/// A literal as the TypeScript engine holds it: its lowered tree crosses
/// to it as JSON, which writes a `-0` literal as `0`, so a literal is never
/// `-0` there (a `-0` computed at run time is).
pub fn static_value(value: &StaticValue) -> Js {
    match value {
        StaticValue::String(s) => Js::str(s.clone()),
        StaticValue::Number(n) if n.0 == 0.0 => Js::Number(0.0),
        StaticValue::Number(n) => Js::Number(n.0),
        StaticValue::Bool(b) => Js::Bool(*b),
        StaticValue::Null => Js::Null,
    }
}

/// The names an expression reads: value bindings, and which names are the
/// event (read through the host).
pub trait Names {
    fn value(&self, name: &str) -> Option<ValueBinding>;
    /// Whatever `name` is bound to: a value, the event, or what else the
    /// run binds.
    fn binding(&self, name: &str) -> Option<Binding> {
        if self.is_event(name) {
            return Some(Binding::Event);
        }
        self.value(name).map(Binding::Value)
    }
    fn is_event(&self, name: &str) -> bool;
    /// A name bound to anything but a value, which a presence test reads as
    /// present by the fact of being bound (`presenceCompare`).
    fn binds_non_value(&self, _name: &str) -> bool {
        false
    }
}

impl Names for Env {
    fn value(&self, name: &str) -> Option<ValueBinding> {
        self.resolve(name).cloned()
    }

    fn is_event(&self, _name: &str) -> bool {
        false
    }
}

/// What an evaluation inside a run asks of its host, in evaluation order.
#[derive(Debug, Clone)]
pub enum Ask {
    /// A field of the event position (`msg.\`subject\``), through the
    /// source adapter.
    EventField { field: String },
    /// A name bound to anything but a value, read whole (`readBareName`), or
    /// as a list's or a map's member (`evalValueMember`, which hands a
    /// record over as itself).
    Bare { name: String, member: bool },
    /// A built-in this engine does not reproduce for these arguments: the
    /// TypeScript member answers.
    Function { id: String, args: Vec<Js> },
    /// A `WITHIN`, measured from the host's clock (`compareValues`'
    /// `within`): the only comparison `compare_values` hands back.
    Within { left: Js, right: Js },
    /// A bare name inside a hop's WHERE or ORDER BY (a position-scoped
    /// evaluation) that no value binding answers: the landed record's field.
    /// `edge` for the bracket grammar's `edge_property`, which reads the
    /// walked edge's own inline property first, then a value binding of
    /// that name, then the record's field.
    ScopedField { field: String, edge: bool },
    /// A traversal the run reads (crate::traverse `read_from`): off the
    /// event, an instance or a record, read for a field, as the records it
    /// lands on, or as an `EXISTS`.
    Traverse { expr: Expression },
    /// The same read rooted at a record a value holds (`top = FIRST(rows)`,
    /// `m.k` of a map holding one), named `name` for a message.
    From { name: String, held: Binding, expr: Expression },
    /// `expr` scoped at the record `subject` holds (`memberScope`): a SORT
    /// key over a list of records.
    ScopedAt { expr: Expression, subject: Js },
    /// A rootless `EXISTS(-[…]->)` inside a hop's WHERE, walked off the
    /// record the evaluation is scoped at (`evaluateExists`).
    ScopedExists { expr: Expression },
    /// `@user_*` and `@actor_*` (`resolveMovementMetaKey`): the acting user
    /// the host looks up, the actor the source adapter parses.
    Meta { key: String },
    /// A function the destination field advertises (`invokeFieldFunction`),
    /// called by its lowered name with its arguments' values.
    FieldFunction { id: String, args: Vec<Js> },
    /// `AI(prompt[, tier])`: the model's answer (`evaluateAi`), or null.
    Ai { prompt: String, tier: Option<String> },
    /// `FILE(content, type)`: the host's rendered artifact (`files.render`).
    RenderFile { content: String, kind: String },
    /// `READ(file)`: the file's text, or why there is none (`files.resolveFileText`).
    ReadFile { file: Js },
}

/// `JSON.stringify(value)` as a template literal prints it (`undefined`
/// for undefined).
fn json_text(value: &Js) -> String {
    match value {
        Js::Undefined => "undefined".into(),
        other => crate::js::json_stringify(other, 0),
    }
}

/// The ambients a run reads through its host (`resolveMovementMetaKey`'s
/// acting-user and raw-actor families).
pub fn is_host_meta(key: &str) -> bool {
    matches!(key, "user_email" | "user_name" | "user_id" | "actor_email" | "actor_name" | "actor_id")
}

/// An evaluation in progress, or a host answer it awaits.
pub type Evaluating<'s> = Pin<Box<dyn Future<Output = Eval> + 's>>;

/// What an evaluation inside a run asks of its run. The evaluation awaits
/// each answer where it asked and resumes there, so the host sees the reads
/// in evaluation order, one evaluation however many it reads.
pub trait Reader {
    fn ask(&self, ask: Ask) -> Evaluating<'_>;
    /// A literal's origin, minted in the run's table as the evaluation
    /// reaches it: one per literal evaluated, as the TypeScript makes one
    /// `literal` origin object each time.
    fn literal(&self) -> u32;
    /// An ambient's origin (`{kind: 'meta', key}`), minted as the
    /// evaluation reaches it.
    fn meta(&self, key: &str) -> u32;
    /// An `AI()` answer's origin (`{kind: 'ai', prompt, inputs}`), the
    /// prompt's own origins its inputs.
    fn ai_origin(&self, _prompt: &str, _inputs: &[u32]) -> u32 {
        0
    }
    /// A resource field (`@resource.field`, a `_resources` WHERE's read):
    /// the current resource's, in a run; `None` where no run answers it.
    fn resource_field(&self, _field: &str) -> Option<Evaluated> {
        None
    }
    /// A `READ(file)`'s origin (`{kind: 'file', rawTextId?, handle?, name?,
    /// contentType?}`).
    fn file_origin(&self, _origin: Js) -> u32 {
        0
    }
    /// Whether the write field this evaluation is the value of advertises a
    /// function of this lowered name (`ctx.fieldFunctions`).
    fn field_function(&self, _id: &str) -> bool {
        false
    }
    /// An entry onto the running flow's trace (`ctx.trace.push`).
    fn trace(&self, _entry: crate::trace::TraceEntry) {}
}

pub struct Evaluator<'a> {
    env: &'a dyn Names,
    language_version: u32,
    around: Surroundings<'a>,
    mode: Mode<'a>,
    /// Position-scoped (`MovementExprContext.scope`): a hop's WHERE or ORDER
    /// BY key, whose bare names read the landed record.
    scoped: bool,
}

enum Mode<'a> {
    /// `eval_expression`: nothing to ask, and literal ids counted up from
    /// the first the caller left free.
    Pure { next_literal: Cell<u32> },
    /// Inside a run: what the evaluation cannot answer itself it asks, and
    /// its literals are origins in the run's table.
    Run(&'a dyn Reader),
}

type Eval = Result<Evaluated, EvalError>;

impl<'a> Evaluator<'a> {
    /// `first_literal` is the first origin id free for literals: the caller
    /// numbered its own origins below it.
    pub fn new(env: &'a dyn Names, language_version: u32, around: Surroundings<'a>, first_literal: u32) -> Self {
        Evaluator { env, language_version, around, mode: Mode::Pure { next_literal: Cell::new(first_literal) }, scoped: false }
    }

    /// Inside a run: what the evaluation cannot answer itself, it asks.
    pub fn in_run(env: &'a dyn Names, language_version: u32, around: Surroundings<'a>, reader: &'a dyn Reader) -> Self {
        Evaluator { env, language_version, around, mode: Mode::Run(reader), scoped: false }
    }

    /// Inside a run, scoped at a landed record (its reader answers
    /// `Ask::ScopedField`).
    pub fn scoped_in_run(env: &'a dyn Names, language_version: u32, around: Surroundings<'a>, reader: &'a dyn Reader) -> Self {
        Evaluator { env, language_version, around, mode: Mode::Run(reader), scoped: true }
    }

    fn reader(&self) -> Option<&'a dyn Reader> {
        match self.mode {
            Mode::Run(reader) => Some(reader),
            Mode::Pure { .. } => None,
        }
    }

    /// `result`, or the host's answer where this engine handed it back.
    async fn or_ask(&self, result: Result<Js, EvalError>, ask: impl FnOnce() -> Ask) -> Result<Js, EvalError> {
        match (result, self.reader()) {
            (Err(EvalError::Fallback(_)), Some(reader)) => reader.ask(ask()).await.map(|answered| answered.value),
            (other, _) => other,
        }
    }

    fn literal(&self) -> u32 {
        match &self.mode {
            Mode::Run(reader) => reader.literal(),
            Mode::Pure { next_literal } => {
                let id = next_literal.get();
                next_literal.set(id + 1);
                id
            }
        }
    }

    /// An evaluation with no run, which asks nothing and so never waits.
    pub fn eval_pure(&self, expr: &Expression) -> Eval {
        debug_assert!(self.reader().is_none(), "an evaluation in a run is awaited");
        ready(self.eval(expr))
    }

    /// The walk, in the TypeScript's evaluation order: a read the run
    /// answers is awaited where it is made.
    pub fn eval<'s>(&'s self, expr: &'s Expression) -> Evaluating<'s> {
        Box::pin(async move { self.eval_in_place(expr).await })
    }

    async fn eval_in_place(&self, expr: &Expression) -> Eval {
        match expr {
            Expression::Static { value } => {
                let id = self.literal();
                Ok(Evaluated { value: static_value(value), prov: Prov::Built(Trail { origins: vec![id], direct: Some(id) }) })
            }
            // A bare name: the value binding's value and trail. Outside a
            // hop's WHERE a rootless `property` read is the same read; inside
            // one it is the landed record's field, unless a value binding of
            // that name stands in for it (`scopedBinding`).
            Expression::AliasRef { name } => self.read_name(name).await,
            Expression::Property { property_type_id: name } if self.scoped && self.env.value(name).is_none() => {
                self.ask_scoped(name, false).await
            }
            Expression::Property { property_type_id: name } => self.read_name(name).await,
            Expression::EdgeProperty { property_type_id: name } if self.scoped => self.ask_scoped(name, true).await,
            Expression::EdgeProperty { .. } => Err(EvalError::unsupported(
                "edge-property reads outside a traversal WHERE",
                "edge properties exist only on a walked hop",
            )),
            Expression::At { expression, index } => {
                let inner = self.eval(expression).await?;
                let index = self.eval(index).await?;
                let prov = self.union(&[&inner.prov, &index.prov]);
                // A dict is looked up by its own key; a key that is not there,
                // or one that is not text, is null. A record held as a value is
                // a dict to `isDictValue`: its own keys are the binding's.
                let value = match (&inner.value, &index.value) {
                    (Js::Object(object), Js::String(key)) if crate::js::is_dict(&inner.value) => object.get(key.as_form()).cloned().unwrap_or(Js::Null),
                    (Js::Record(record), Js::String(key)) => crate::record::own_property(record, key.as_form())?,
                    (Js::Object(_), _) if crate::js::is_dict(&inner.value) => Js::Null,
                    (Js::Record(_), _) => Js::Null,
                    (other, _) => at_index(other, index.value.to_number()),
                };
                Ok(Evaluated { value, prov })
            }
            Expression::List { elements } => {
                let mut values = Vec::new();
                let mut provs = Vec::new();
                for element in elements {
                    match element {
                        ListElement::Expression(e) => {
                            let member = self.member(e).await?;
                            values.push(member.value);
                            provs.push(member.prov);
                        }
                        ListElement::Spread(spread) => {
                            let evaluated = self.eval(&spread.expression).await?;
                            let members = if self.is_many_valued(&spread.expression) {
                                members_of(&evaluated.value)
                            } else {
                                evaluated.value.clone()
                            };
                            let Js::Array(list) = members else {
                                let what = if members.is_nullish() {
                                    "null".to_string()
                                } else {
                                    format!("not a list ({})", members.type_of())
                                };
                                return Err(EvalError::engine(
                                    "MOVENG_RUNTIME",
                                    format!("'...' splices a list's members into a list, and this value is {what}"),
                                ));
                            };
                            values.extend(list.items().iter().cloned());
                            provs.push(evaluated.prov);
                        }
                    }
                }
                Ok(Evaluated { value: Js::array(values), prov: self.union(&provs.iter().collect::<Vec<_>>()) })
            }
            Expression::Object { entries } => {
                let mut object = JsObject::new();
                let mut provs = Vec::new();
                for member in entries {
                    match member {
                        // `value[member.key] = result.value`: a `__proto__`
                        // key is `Object.prototype`'s setter.
                        ObjectMember::Entry { key, value } => {
                            let result = self.member(value).await?;
                            object.assign(key.clone(), result.value);
                            provs.push(result.prov);
                        }
                        ObjectMember::Spread(spread) => {
                            let result = self.member(&spread.expression).await?;
                            spread_keys(&result.value, &mut object)?;
                            provs.push(result.prov);
                        }
                    }
                }
                Ok(Evaluated { value: Js::object(object), prov: self.union(&provs.iter().collect::<Vec<_>>()) })
            }
            Expression::Concat { parts } => {
                let mut text = String::new();
                let mut provs = Vec::new();
                for part in parts {
                    let part = self.eval(part).await?;
                    if !part.value.is_nullish() {
                        text.push_str(&part.value.to_text().map_err(thrown)?);
                    }
                    provs.push(part.prov);
                }
                Ok(Evaluated { value: Js::str(text), prov: self.union(&provs.iter().collect::<Vec<_>>()) })
            }
            Expression::Conditional { condition, then, else_ } => {
                let condition = self.eval(condition).await?;
                self.eval(if condition.value.truthy() { then } else { else_ }).await
            }
            Expression::Compare { op, left, right } => {
                // `x == null` asks whether `x` has a value: answered from
                // the subject alone, which keeps its trail.
                if is_null_literal(right) {
                    return self.presence(left, *op).await;
                }
                if is_null_literal(left) {
                    return self.presence(right, *op).await;
                }
                let l = self.eval(left).await?;
                let r = self.eval(right).await?;
                // A record is compared by identity (`compareRecords`), never read.
                if let Some(same) = crate::record::compare_records(&l.value, *op, &r.value)? {
                    return Ok(Evaluated { value: Js::Bool(same), prov: self.union(&[&l.prov, &r.prov]) });
                }
                let value = self
                    .or_ask(compare_values(&l.value, *op, &r.value, self.around.local()).map(Js::Bool), || Ask::Within {
                        left: l.value.clone(),
                        right: r.value.clone(),
                    })
                    .await?;
                Ok(Evaluated { value, prov: self.union(&[&l.prov, &r.prov]) })
            }
            Expression::Logical { op, operands } => {
                let wanted = matches!(op, LogicalOp::Or);
                let mut seen = Vec::new();
                for operand in operands {
                    let result = self.eval(operand).await?;
                    let truthy = result.value.truthy();
                    seen.push(result.prov);
                    if truthy == wanted {
                        return Ok(Evaluated { value: Js::Bool(wanted), prov: self.union(&seen.iter().collect::<Vec<_>>()) });
                    }
                }
                Ok(Evaluated { value: Js::Bool(!wanted), prov: self.union(&seen.iter().collect::<Vec<_>>()) })
            }
            Expression::Not { expression } => {
                let inner = self.eval(expression).await?;
                Ok(Evaluated { value: Js::Bool(!inner.value.truthy()), prov: self.union(&[&inner.prov]) })
            }
            Expression::Negate { expression } => {
                let inner = self.eval(expression).await?;
                Ok(Evaluated { value: Js::Number(-inner.value.to_number()), prov: self.union(&[&inner.prov]) })
            }
            Expression::Arithmetic { op, left, right } => {
                let l = self.eval(left).await?;
                let r = self.eval(right).await?;
                let value = arithmetic(*op, l.value.to_number(), r.value.to_number());
                Ok(Evaluated { value, prov: self.union(&[&l.prov, &r.prov]) })
            }
            Expression::Function { fn_, args } => self.function(fn_, args).await,
            // `@current_date` / `@current_timestamp`: the run's pinned
            // instant (`pinnedNow`), its key the trail.
            Expression::Meta { key } if key == "current_date" || key == "current_timestamp" => {
                let (Some(reader), Some(now)) = (self.reader(), self.around.now) else {
                    return Err(EvalError::Fallback("an ambient is the run's".into()));
                };
                let instant = crate::js_date::to_iso_string(now);
                let value = if key == "current_date" { instant[..10].to_string() } else { instant };
                let id = reader.meta(key);
                Ok(Evaluated { value: Js::str(value), prov: Prov::Built(Trail { origins: vec![id], direct: Some(id) }) })
            }
            // `AI(prompt[, tier])` (`evaluateAi`): a prompt expression
            // evaluated and made text (absent as ""), else the prompt as
            // written; the model's answer, its origin the prompt with the
            // trails that flowed into it.
            Expression::Llm { prompt, prompt_expression, tier } => {
                let Some(reader) = self.reader() else {
                    return Err(EvalError::Fallback("AI() is the run's".into()));
                };
                let evaluated = match prompt_expression {
                    Some(expression) => Some(self.eval(expression).await?),
                    None => None,
                };
                let text = match &evaluated {
                    Some(result) if result.value.is_nullish() => String::new(),
                    Some(result) => result.value.to_js_string(),
                    None => prompt.clone(),
                };
                let inputs = match &evaluated {
                    Some(result) => self.trail_origins(&result.prov),
                    None => Vec::new(),
                };
                let value = reader.ask(Ask::Ai { prompt: text.clone(), tier: tier.clone() }).await?.value;
                let id = reader.ai_origin(&text, &inputs);
                Ok(Evaluated { value, prov: Prov::Built(Trail { origins: vec![id], direct: Some(id) }) })
            }
            // `@user_*` / `@actor_*`: the run's lookups, then the key's trail,
            // minted after the value as the TypeScript's `fromOrigin` is.
            Expression::Meta { key } if is_host_meta(key) => {
                let Some(reader) = self.reader() else {
                    return Err(EvalError::Fallback("an ambient is the run's".into()));
                };
                let value = reader.ask(Ask::Meta { key: key.clone() }).await?.value;
                let id = reader.meta(key);
                Ok(Evaluated { value, prov: Prov::Built(Trail { origins: vec![id], direct: Some(id) }) })
            }
            Expression::Traverse { alias_root: Some(root), .. } => self.traverse_from(expr, root).await,
            Expression::Traverse { alias_root: None, .. } => {
                Err(EvalError::unsupported("relative traversal (no alias root)", "E1 expressions read from named bindings only"))
            }
            Expression::Aggregate { fn_, expression, separator, order_by, order_direction, .. } => {
                self.aggregate(*fn_, expression, separator.as_deref(), order_by.as_deref(), *order_direction).await
            }
            // A rootless `EXISTS(-[…]->)`: the landed record a hop's WHERE
            // is scoped at is its subject (the run walks off it); anywhere
            // else the TypeScript's evaluator refuses it.
            Expression::Exists { .. } if self.scoped => self.ask_run(Ask::ScopedExists { expr: expr.clone() }).await,
            Expression::Exists { .. } => Err(rootless_exists()),
            // `case 'resource'`: the current resource's field, null where
            // the evaluation has none (outside a `_resources` WHERE).
            Expression::Resource { field } => match self.reader().and_then(|reader| reader.resource_field(field)) {
                Some(read) => Ok(read),
                None => Err(EvalError::Fallback("a resource field is the run's".into())),
            },
            other if has_no_typescript_case(other) => Err(EvalError::unsupported_bare(&format!("the expression kind '{}'", kind_of(expr)))),
            other => Err(EvalError::Fallback(format!("the expression kind {:?} needs the host", kind_of(other)))),
        }
    }

    /// `evaluateTraverse` / `traverseFrom`: a walk or a field read rooted at
    /// a name. A value's own read is the value plane's (and a record a
    /// value holds is the run's); the event's field is a host read; any
    /// other root is the run's to read.
    async fn traverse_from(&self, expr: &Expression, root: &str) -> Eval {
        let Expression::Traverse { steps, expression, .. } = expr else { unreachable!("a rooted traversal") };
        match self.env.binding(root) {
            None => Err(EvalError::engine("MOVENG_RUNTIME", format!("'{root}' is not in scope — the checker should have caught this"))),
            Some(Binding::Value(value)) => {
                let trail = value.trail.clone().unwrap_or_default();
                self.from_value(expr, root.to_string(), value, trail).await
            }
            Some(Binding::Event) if steps.is_empty() && field_terminal(expression).is_some_and(|f| f != POSITION_SENTINEL) => {
                let field = field_terminal(expression).expect("checked above");
                match self.reader() {
                    Some(reader) => reader.ask(Ask::EventField { field: field.to_string() }).await,
                    None => Err(EvalError::Fallback("the event needs the host".into())),
                }
            }
            Some(_) => self.ask_run(Ask::Traverse { expr: expr.clone() }).await,
        }
    }

    /// `traverseFrom`'s value case: a record the value holds is read as that
    /// record (`heldRecords`); `m.k.f` reads on from what the key holds,
    /// bound as a name bound to it would be; `EXISTS(v)` asks whether it
    /// holds anything; else the value's own field (`readBindingField`).
    fn from_value<'s>(&'s self, expr: &'s Expression, name: String, value: ValueBinding, trail: Trail) -> Evaluating<'s> {
        Box::pin(async move {
            let Expression::Traverse { steps, expression, .. } = expr else { unreachable!("a rooted traversal") };
            if let Some(held) = crate::record::held_records(&value.value, expr) {
                return self.ask_run(Ask::From { name, held, expr: expr.clone() }).await;
            }
            // A field projected out of a value keeps its taint but not its
            // quote (`transformed`).
            let transformed = Trail { origins: trail.origins.clone(), direct: None };
            if steps.is_empty()
                && let Expression::Traverse { alias_root: Some(key), .. } = expression.as_ref()
            {
                let member = format!("{name}.{key}");
                return match crate::record::bind_value(crate::record::project(&value.value, key), Some(transformed.clone()), false) {
                    Binding::Value(bound) => self.from_value(expression, member, bound, transformed).await,
                    held => self.ask_run(Ask::From { name: member, held, expr: expression.as_ref().clone() }).await,
                };
            }
            if let Expression::Exists { steps: hops, where_ } = expression.as_ref() {
                if !steps.is_empty() {
                    return Err(EvalError::unsupported_bare(&format!("EXISTS() after hops from '{name}'")));
                }
                if !hops.is_empty() || where_.is_some() {
                    return Err(EvalError::unsupported_bare(&format!(
                        "traversing inside EXISTS() from '{name}', which holds {} rather than a record",
                        describe_held_value(&value.value)
                    )));
                }
                let present = match &value.value {
                    Js::Array(list) => !list.items().is_empty(),
                    other => !other.is_nullish(),
                };
                return Ok(Evaluated { value: Js::Bool(present), prov: Prov::Built(transformed) });
            }
            // `directFieldRead`.
            if !steps.is_empty() {
                return Err(EvalError::unsupported(&format!("traversing from a value binding ('{name}')"), "source/handle traversal is E2 scope"));
            }
            let Some(field) = field_terminal(expression) else {
                return Err(EvalError::unsupported(&format!("this read shape on a value binding ('{name}')"), "only direct field reads run in E1"));
            };
            if field == POSITION_SENTINEL {
                return Err(EvalError::unsupported_bare(&format!("aggregating a value binding ('{name}') as a position")));
            }
            Ok(Evaluated { value: crate::record::project(&value.value, field), prov: Prov::Built(transformed) })
        })
    }

    /// `presenceCompare`: `x == null` of a name bound to anything but a
    /// value is answered by the binding (present), outside a hop's WHERE,
    /// where the name is the landed record's field.
    async fn presence(&self, subject: &Expression, op: FilterOperator) -> Eval {
        let name = match subject {
            _ if self.scoped => None,
            Expression::Property { property_type_id: name } | Expression::AliasRef { name } => Some(name),
            _ => None,
        };
        if let Some(name) = name
            && self.env.binds_non_value(name)
        {
            return Ok(Evaluated { value: Js::Bool(compare_to_null(op, &Js::Bool(true))), prov: Prov::Built(Trail::default()) });
        }
        let subject = self.eval(subject).await?;
        Ok(Evaluated { value: Js::Bool(compare_to_null(op, &subject.value)), prov: subject.prov })
    }

    /// What only the run can answer; with no run, the TypeScript's.
    async fn ask_run(&self, ask: Ask) -> Eval {
        match self.reader() {
            Some(reader) => reader.ask(ask).await,
            None => Err(EvalError::Fallback("a record is the run's".into())),
        }
    }

    /// `evalValueMember`: a list's or a map's member. A bare name bound to a
    /// record is that record (`memberPosition`), except a block's many
    /// returned records, which read as their list; anything else is the
    /// value it evaluates to.
    async fn member(&self, expr: &Expression) -> Eval {
        if !self.scoped
            && let Expression::AliasRef { name } | Expression::Property { property_type_id: name } = expr
            && let Some(binding) = self.env.binding(name)
            && crate::record::is_position(&binding)
            && !matches!(binding, Binding::Positions(_))
        {
            return self.ask_run(Ask::Bare { name: name.clone(), member: true }).await;
        }
        self.eval(expr).await
    }

    /// `case 'aggregate'`: the folds, as the TG engine's `applyAggregation`
    /// computes them, over what the inner expression evaluated to (nothing
    /// is no members, a list its own, anything else one).
    async fn aggregate(
        &self,
        fn_: AggregationFunction,
        inner: &Expression,
        separator: Option<&str>,
        order_by: Option<&Expression>,
        direction: Option<OrderDirection>,
    ) -> Eval {
        let evaluated = self.eval(inner).await?;
        let values: Vec<Js> = match &evaluated.value {
            Js::Undefined | Js::Null => Vec::new(),
            Js::Array(list) => list.items().clone(),
            other => vec![other.clone()],
        };
        if fn_ == AggregationFunction::Sort {
            return self.sort(values, order_by, direction, evaluated.prov).await;
        }
        let prov = self.union(&[&evaluated.prov]);
        let sum = |values: &[Js]| values.iter().fold(0.0, |acc, v| acc + or_zero(v.to_number()));
        let value = match fn_ {
            AggregationFunction::First => values.first().cloned().unwrap_or(Js::Null),
            AggregationFunction::Last => values.last().cloned().unwrap_or(Js::Null),
            AggregationFunction::Only => {
                let present: Vec<&Js> = values.iter().filter(|v| !v.is_nullish()).collect();
                if present.len() > 1 {
                    let Some(spelled) = crate::formula::spell(inner) else {
                        return Err(EvalError::Fallback("ONLY's message spells an expression this engine does not".into()));
                    };
                    return Err(EvalError::engine(
                        "MOVENG_RUNTIME",
                        format!(
                            "ONLY({spelled}) says there is exactly one, and there are {}. Narrow it until there is, or fold with something that takes many.",
                            present.len()
                        ),
                    ));
                }
                present.first().map_or(Js::Null, |v| (*v).clone())
            }
            AggregationFunction::Count => Js::Number(values.iter().filter(|v| !v.is_nullish()).count() as f64),
            AggregationFunction::Sum => Js::Number(sum(&values)),
            AggregationFunction::Avg if values.is_empty() => Js::Null,
            AggregationFunction::Avg => Js::Number(sum(&values) / values.len() as f64),
            AggregationFunction::Min if values.is_empty() => Js::Null,
            AggregationFunction::Min => Js::Number(math_min(values.iter().map(Js::to_number))),
            AggregationFunction::Max if values.is_empty() => Js::Null,
            AggregationFunction::Max => Js::Number(math_max(values.iter().map(Js::to_number))),
            AggregationFunction::Join => Js::str(
                values.iter().filter(|v| !v.is_nullish()).map(Js::to_text).collect::<Result<Vec<_>, _>>().map_err(thrown)?.join(separator.unwrap_or(", ")),
            ),
            AggregationFunction::Collect => Js::array(values),
            AggregationFunction::Sort => unreachable!("SORT answered above"),
            AggregationFunction::Llm => return Err(EvalError::unsupported_bare("the 'llm' aggregation")),
        };
        Ok(Evaluated { value, prov })
    }

    /// `evaluateSort`: the members in the order of their keys (`sortByOrderKey`),
    /// a plain value its own key, a map's read off it by name; the trail the
    /// collection arrived with, unchanged.
    async fn sort(&self, members: Vec<Js>, key: Option<&Expression>, direction: Option<OrderDirection>, prov: Prov) -> Eval {
        // Every key is read at once, each settling before the earliest
        // failure by position is thrown (`sortByOrderKey`).
        let reads: Vec<_> = members.iter().map(|member| self.sort_key(member, key)).collect();
        let keys = crate::executor::join_all(reads).await.into_iter().collect::<Result<Vec<Js>, EvalError>>()?;
        let order = crate::order_limit::sort_by_order_key(&keys, direction);
        Ok(Evaluated { value: Js::array(order.into_iter().map(|i| members[i].clone()).collect()), prov })
    }

    /// One member's SORT key (`memberScope`): a record reads its key in its
    /// own scope, a map reads its keys; a plain value has nothing to read one
    /// off, and with no key is its own.
    async fn sort_key(&self, member: &Js, key: Option<&Expression>) -> Result<Js, EvalError> {
        let record = crate::record::binding_of(member).is_some();
        let dict = record || matches!(member, Js::Object(_));
        let Some(key) = key else {
            if dict {
                return Err(EvalError::unsupported("sorting records with no key", "say what to rank them by — `SORT(xs, `Added At`, DESC)`"));
            }
            return Ok(member.clone());
        };
        if !dict {
            return Err(EvalError::unsupported(
                "reading SORT's key off this member",
                "the key is read off a RECORD — bind the walk first (`entries = … { return e }`) and sort that, or sort plain values by themselves (`SORT(xs)`)",
            ));
        }
        match self.member_key(member, key) {
            Some(value) if !record => Ok(value),
            _ => Ok(self.ask_run(Ask::ScopedAt { expr: key.clone(), subject: member.clone() }).await?.value),
        }
    }

    /// A SORT key over one map that is a bare name, read here: a value
    /// binding of that name first (`scopedBinding`), else the map's key
    /// (`readBindingField`). Any other key is the run's to read in the map's
    /// scope.
    fn member_key(&self, member: &Js, key: &Expression) -> Option<Js> {
        let (Expression::Property { property_type_id: name } | Expression::AliasRef { name }) = key else { return None };
        if let Some(bound) = self.env.value(name) {
            return Some(bound.value);
        }
        Some(crate::record::project(member, name))
    }

    async fn ask_scoped(&self, field: &str, edge: bool) -> Eval {
        match self.reader() {
            Some(reader) => reader.ask(Ask::ScopedField { field: field.to_string(), edge }).await,
            None => Err(EvalError::Fallback("a landed record is the run's".into())),
        }
    }

    /// `readBareName`: a value binding's value and trail; anything else bound
    /// is the run's to read (a record as itself, the event refused).
    async fn read_name(&self, name: &str) -> Eval {
        match self.env.binding(name) {
            None => Err(EvalError::engine("MOVENG_RUNTIME", format!("'{name}' is not in scope — the checker should have caught this"))),
            Some(Binding::Value(binding)) => Ok(Evaluated { value: binding.value, prov: Prov::Binding(name.to_string()) }),
            Some(_) => self.ask_run(Ask::Bare { name: name.to_string(), member: false }).await,
        }
    }

    /// `isManyValued`: a name bound to a walk read for a field.
    fn is_many_valued(&self, expr: &Expression) -> bool {
        match expr {
            // `isWalkProjection`: a walk of at least one hop read for a field.
            Expression::Traverse { steps, expression, .. } if !steps.is_empty() => match expression.as_ref() {
                Expression::Property { property_type_id } => property_type_id != movement_parser::lowering::POSITION_SENTINEL,
                Expression::EdgeProperty { .. } => true,
                _ => false,
            },
            Expression::AliasRef { name } | Expression::Property { property_type_id: name } => {
                self.env.value(name).is_some_and(|b| b.many)
            }
            _ => false,
        }
    }

    async fn function(&self, id: &str, args: &[Expression]) -> Eval {
        if stdlib::NAMESPACED.contains(&id) {
            let mut values = Vec::new();
            let mut provs = Vec::new();
            for (index, a) in args.iter().enumerate() {
                // `evalRecordArgument` / `evalWholeValueArgument`: read as a
                // member (a bare record name is the record), then a record
                // read down to its fields, or every record inside the value
                // read down to plain data.
                let value = if stdlib::record_arg(id) == Some(index) {
                    let result = self.member(a).await?;
                    provs.push(result.prov);
                    match crate::record::binding_of(&result.value) {
                        Some(record) => Js::object(crate::record::fields_of(&record)?),
                        None => result.value,
                    }
                } else if stdlib::whole_value_arg(id) == Some(index) {
                    let result = self.member(a).await?;
                    provs.push(result.prov);
                    crate::record::plain_value_of(&result.value)?
                } else {
                    let result = self.eval(a).await?;
                    provs.push(result.prov);
                    result.value
                };
                values.push(value);
            }
            let value = self
                .or_ask(stdlib::apply_namespaced(id, &values, self.around), || Ask::Function { id: id.to_string(), args: values.clone() })
                .await?;
            return Ok(Evaluated { value, prov: self.union(&provs.iter().collect::<Vec<_>>()) });
        }
        if id == "chunks"
            && let Some(reader) = self.reader()
        {
            return self.chunks(reader, args).await;
        }
        if (id == "file" || id == "read")
            && let Some(reader) = self.reader()
        {
            return if id == "file" { self.render_file(reader, args).await } else { self.read_file(reader, args).await };
        }
        if !stdlib::FLAT.contains(&id) {
            let Some(reader) = self.reader() else {
                return Err(EvalError::Fallback(format!("{id} is not a built-in this engine runs")));
            };
            // Built-ins always win; any other name is a function the write
            // field advertises, or unsupported, named, before its arguments
            // are read.
            if !reader.field_function(id) {
                return Err(EvalError::unsupported(
                    &format!("the function {}()", crate::js::to_upper_case(id)),
                    "built-in functions run everywhere; an integration-provided function runs only as a write-field value on a field that advertises it",
                ));
            }
            let mut values = Vec::new();
            let mut provs = Vec::new();
            for a in args {
                let result = self.eval(a).await?;
                provs.push(result.prov);
                values.push(result.value);
            }
            let value = reader.ask(Ask::FieldFunction { id: id.to_string(), args: values }).await?.value;
            return Ok(Evaluated { value, prov: self.union(&provs.iter().collect::<Vec<_>>()) });
        }
        if id == "coalesce" && self.language_version >= 3 {
            // From version 3 COALESCE short-circuits, as `??` does.
            let mut seen = Vec::new();
            for a in args {
                let result = self.eval(a).await?;
                if !result.value.is_nullish() {
                    return Ok(result);
                }
                seen.push(result.prov);
            }
            return Ok(Evaluated { value: Js::Null, prov: self.union(&seen.iter().collect::<Vec<_>>()) });
        }
        let mut results = Vec::new();
        for a in args {
            results.push(self.eval(a).await?);
        }
        let provs: Vec<&Prov> = results.iter().map(|r| &r.prov).collect();
        if id == "coalesce" {
            // Branch selection: the chosen value's trail flows through.
            if let Some(chosen) = results.iter().find(|r| !r.value.is_nullish()) {
                return Ok(chosen.clone());
            }
            return Ok(Evaluated { value: Js::Null, prov: self.union(&provs) });
        }
        let values: Vec<Js> = results.iter().map(|r| r.value.clone()).collect();
        let value = self.or_ask(stdlib::apply_flat(id, &values, self.around), || Ask::Function { id: id.to_string(), args: values.clone() }).await?;
        Ok(Evaluated { value, prov: self.union(&provs) })
    }

    /// The taint union: every origin once, in the order first seen, and no
    /// `direct`.
    /// `evaluateFileFunction`: the content and the type evaluated, the type
    /// held to `pdf` or `text`, the content rendered as text by the host;
    /// the descriptor carries both trails, transformed.
    async fn render_file(&self, reader: &dyn Reader, args: &[Expression]) -> Eval {
        let (Some(content_arg), Some(kind_arg)) = (args.first(), args.get(1)) else {
            return Err(EvalError::engine("MOVENG_RUNTIME", "FILE() expects (content, \"pdf\" | \"text\") — the checker should have caught this".into()));
        };
        let content = self.eval(content_arg).await?;
        let kind = self.eval(kind_arg).await?;
        let Js::String(kind_text) = &kind.value else {
            return Err(EvalError::engine("MOVENG_RUNTIME", format!("FILE()'s artifact type must be \"pdf\" or \"text\", got {}", json_text(&kind.value))));
        };
        if kind_text != "pdf" && kind_text != "text" {
            return Err(EvalError::engine("MOVENG_RUNTIME", format!("FILE()'s artifact type must be \"pdf\" or \"text\", got {}", json_text(&kind.value))));
        }
        let text = if content.value.is_nullish() { String::new() } else { content.value.to_js_string() };
        let value = reader.ask(Ask::RenderFile { content: text, kind: kind_text.to_string() }).await?.value;
        Ok(Evaluated { value, prov: self.union(&[&content.prov, &kind.prov]) })
    }

    /// `evaluateReadFunction`: absent for absent, a file's text with a
    /// `file` origin (`direct`, the argument's trail riding along), absent
    /// for a file with none, the reason on the trace.
    async fn read_file(&self, reader: &dyn Reader, args: &[Expression]) -> Eval {
        let Some(file_arg) = args.first() else {
            return Err(EvalError::engine("MOVENG_RUNTIME", "READ(file) expects one argument — the checker should have caught this".into()));
        };
        let file = self.eval(file_arg).await?;
        if file.value.is_nullish() {
            return Ok(Evaluated { value: Js::Null, prov: self.union(&[&file.prov]) });
        }
        if !crate::extract::is_file_ref(&file.value) {
            return Err(EvalError::engine(
                "MOVENG_RUNTIME",
                format!("READ() reads a file, and this is {} — the checker should have caught this", file.value.type_of()),
            ));
        }
        let read = reader.ask(Ask::ReadFile { file: file.value.clone() }).await?;
        match read.value {
            // Unreadable: absent, the file's own trail.
            Js::Undefined => Ok(Evaluated { value: Js::Null, prov: self.union(&[&file.prov]) }),
            text => {
                let Prov::Built(origin) = read.prov else { unreachable!("a read's text carries its file origin") };
                let mut origins = self.trail_origins(&file.prov);
                for id in &origin.origins {
                    if !origins.contains(id) {
                        origins.push(*id);
                    }
                }
                Ok(Evaluated { value: text, prov: Prov::Built(Trail { origins, direct: origin.direct }) })
            }
        }
    }

    /// `evaluateChunksFunction`: the text cut (crate::chunks), the cut on
    /// the trace; an absent text is no pieces.
    async fn chunks(&self, reader: &dyn Reader, args: &[Expression]) -> Eval {
        let [text_arg, options_arg, ..] = args else {
            return Err(EvalError::engine(
                "MOVENG_RUNTIME",
                "CHUNKS(text, { size | entities, overlap }) expects a text and an options map — the checker should have caught this".into(),
            ));
        };
        let text = self.eval(text_arg).await?;
        let options = self.eval(options_arg).await?;
        let prov = self.union(&[&text.prov, &options.prov]);
        let asked = |key: &str| match &options.value {
            Js::Object(object) => crate::js::plain_property(object, key),
            _ => Js::Undefined,
        };
        if !matches!(options.value, Js::Object(_) | Js::Record(_)) {
            return Err(EvalError::engine("MOVENG_RUNTIME", "CHUNKS() takes its options as a map — the checker should have caught this".into()));
        }
        let spec = crate::chunks::read_spec(&asked("size"), &asked("entities"), &asked("overlap")).map_err(|message| EvalError::engine("MOVENG_RUNTIME", message))?;
        let traced = |pieces: f64, sizes: Vec<Js>, estimates: Option<Vec<Js>>| {
            let mut members = crate::trace::Members::default();
            members.set("pieces", Js::Number(pieces));
            members.set("sizes", Js::array(sizes));
            members.set("unit", Js::str("chars"));
            members.set("mode", Js::str(spec.mode()));
            if let Some(estimates) = estimates {
                members.set("expectedEntities", Js::array(estimates));
            }
            reader.trace(crate::trace::TraceEntry::Chunks(members));
        };
        let units = match &text.value {
            value if value.is_nullish() => {
                traced(0.0, Vec::new(), None);
                return Ok(Evaluated { value: Js::array(Vec::new()), prov });
            }
            Js::String(text) => crate::js_string::units_vec(text.as_form()),
            other => {
                return Err(EvalError::engine("MOVENG_RUNTIME", format!("CHUNKS() cuts a text, and this is {} — the checker should have caught this", other.type_of())));
            }
        };
        let pieces: Vec<&[u16]> = crate::chunks::chunk(&units, spec).into_iter().map(|range| &units[range]).collect();
        let estimates = matches!(spec, crate::chunks::Spec::Entities { .. })
            .then(|| pieces.iter().map(|piece| Js::Number(crate::chunks::entities(piece) as f64)).collect());
        traced(pieces.len() as f64, pieces.iter().map(|piece| Js::Number(piece.len() as f64)).collect(), estimates);
        Ok(Evaluated { value: Js::array(pieces.iter().map(|piece| Js::String(crate::js_string::JsString::from_units(piece))).collect()), prov })
    }

    /// The origins a value's trail holds (`provenance.origins`).
    fn trail_origins(&self, prov: &Prov) -> Vec<u32> {
        match prov {
            Prov::Built(trail) => trail.origins.clone(),
            Prov::Binding(name) => self.env.value(name).and_then(|b| b.trail).map(|t| t.origins).unwrap_or_default(),
        }
    }

    fn union(&self, parts: &[&Prov]) -> Prov {
        let mut origins: Vec<u32> = Vec::new();
        for part in parts {
            let trail = match part {
                Prov::Built(trail) => Some(trail.clone()),
                Prov::Binding(name) => self.env.value(name).and_then(|b| b.trail),
            };
            for &origin in trail.as_ref().map_or(&[][..], |t| &t.origins[..]) {
                if !origins.contains(&origin) {
                    origins.push(origin);
                }
            }
        }
        Prov::Built(Trail { origins, direct: None })
    }
}

/// `<root>-[…]->` with the position terminal: the records a walk lands on.
pub(crate) fn is_records_walk(expr: &Expression) -> bool {
    matches!(expr, Expression::Traverse { alias_root: Some(_), steps, expression }
        if !steps.is_empty() && matches!(expression.as_ref(), Expression::Property { property_type_id } if property_type_id == POSITION_SENTINEL))
}

/// A kind the TypeScript's evaluator has no case for (the retired KG_VALUE
/// and KG_EXISTS, which the checker passes, and the TG engine's reads): it
/// fails on the kind, before it reads any part (expression.ts's default).
pub(crate) fn has_no_typescript_case(expr: &Expression) -> bool {
    matches!(
        expr,
        Expression::KgValue { .. }
            | Expression::KgExists { .. }
            | Expression::ParentResult { .. }
            | Expression::ActionResult { .. }
            | Expression::LinkedObject { .. }
            | Expression::ExtractValue { .. }
    )
}

/// `unsupported('rootless EXISTS()', …)`: no position scope to walk from.
pub(crate) fn rootless_exists() -> EvalError {
    EvalError::unsupported("rootless EXISTS()", "root the traversal at a named binding — EXISTS(x-[:edge]->)")
}

/// What a JavaScript built-in threw, as the evaluator throws it.
fn thrown(error: crate::js::Thrown) -> EvalError {
    let class = if error.class == "RangeError" { ErrorClass::RangeError } else { ErrorClass::TypeError };
    EvalError::Thrown { class, message: error.message }
}

/// `fieldTerminalId`: the field a traversal's terminal reads (the bracket
/// grammar reads `t.\`f\`` as an edge property; either is the field).
pub(crate) fn field_terminal(terminal: &Expression) -> Option<&str> {
    match terminal {
        Expression::Property { property_type_id } | Expression::EdgeProperty { property_type_id } => Some(property_type_id),
        _ => None,
    }
}

/// `describeHeldValue`.
fn describe_held_value(value: &Js) -> String {
    match value {
        Js::Undefined | Js::Null => "nothing".into(),
        Js::Array(_) => "a list that is not all records".into(),
        other => format!("a {}", other.type_of()),
    }
}


/// `Number(v) || 0`.
fn or_zero(n: f64) -> f64 {
    if n.is_nan() || n == 0.0 { 0.0 } else { n }
}

/// `Math.min(...numbers)` over at least one: NaN if any is, and -0 below 0.
fn math_min(numbers: impl Iterator<Item = f64>) -> f64 {
    let mut least = f64::INFINITY;
    for n in numbers {
        if n.is_nan() {
            return f64::NAN;
        }
        if n < least || (n == 0.0 && least == 0.0 && n.is_sign_negative()) {
            least = n;
        }
    }
    least
}

/// `Math.max(...numbers)` over at least one: NaN if any is, and 0 above -0.
fn math_max(numbers: impl Iterator<Item = f64>) -> f64 {
    let mut most = f64::NEG_INFINITY;
    for n in numbers {
        if n.is_nan() {
            return f64::NAN;
        }
        if n > most || (n == 0.0 && most == 0.0 && most.is_sign_negative()) {
            most = n;
        }
    }
    most
}

/// `membersOf`: nothing is no members, a list is its own, anything else one.
fn members_of(value: &Js) -> Js {
    match value {
        Js::Undefined | Js::Null => Js::array(vec![]),
        Js::Array(_) => value.clone(),
        other => Js::array(vec![other.clone()]),
    }
}

/// `Object.assign(object, spreadKeysOf(value))`: a map's keys, or a
/// record's fields (`recordFields`), each assigned, so an own `__proto__`
/// key the source holds sets the object's prototype, as the TypeScript's
/// `Object.assign` does.
fn spread_keys(value: &Js, object: &mut JsObject) -> Result<(), EvalError> {
    if let Some(record) = crate::record::binding_of(value) {
        for (key, item) in crate::record::fields_of(&record)?.entries() {
            object.assign(key.clone(), item.clone());
        }
        return Ok(());
    }
    match value {
        Js::Undefined | Js::Null => Ok(()),
        Js::Object(source) if crate::js::is_dict(value) => {
            for (key, item) in source.entries() {
                object.assign(key.clone(), item.clone());
            }
            Ok(())
        }
        other => {
            let held = match other {
                Js::Array(_) => "a list that is not all records".to_string(),
                other => format!("a {}", other.type_of()),
            };
            Err(EvalError::unsupported(
                &format!("copying the keys of {held} into a map"),
                "a spread copies a map's keys or a record's fields — write the value under a key instead (the checker should have caught this)",
            ))
        }
    }
}

/// The lowered expression's own `type`.
pub(crate) fn kind_of(expr: &Expression) -> String {
    serde_json::to_value(expr)
        .ok()
        .and_then(|json| json.get("type").and_then(|t| t.as_str()).map(String::from))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::task::{Context, Poll, Waker};

    use super::*;

    fn expression(text: &str) -> Expression {
        let tree = movement_parser::parse_expression(text, 0).unwrap();
        let bytes = movement_parser::lowering::lower_json_bytes(&tree.to_string(), text, movement_parser::lowering::Mode::Expression)
            .unwrap_or_else(|e| panic!("{}", String::from_utf8_lossy(&e)));
        serde_json::from_slice(&bytes).unwrap()
    }

    /// `msg` is the event; nothing else is bound.
    struct EventOnly;

    impl Names for EventOnly {
        fn value(&self, _name: &str) -> Option<ValueBinding> {
            None
        }

        fn is_event(&self, name: &str) -> bool {
            name == "msg"
        }
    }

    /// Answers each event read with the field's name upper-cased, after one
    /// poll that is not ready (the host has not answered yet); counts what
    /// the walk does.
    #[derive(Default)]
    struct Counting {
        asked: RefCell<Vec<String>>,
        literals: Cell<u32>,
    }

    impl Reader for Counting {
        fn ask(&self, ask: Ask) -> Evaluating<'_> {
            let Ask::EventField { field } = ask else { panic!("only event reads here") };
            self.asked.borrow_mut().push(field.clone());
            let mut answered = false;
            Box::pin(std::future::poll_fn(move |cx| {
                if !std::mem::replace(&mut answered, true) {
                    // Answered as soon as asked: due again on the next poll.
                    cx.waker().wake_by_ref();
                    return Poll::Pending;
                }
                Poll::Ready(Ok(Evaluated { value: Js::str(crate::js::to_upper_case(&field)), prov: Prov::Built(Trail::default()) }))
            }))
        }

        fn literal(&self) -> u32 {
            self.literals.set(self.literals.get() + 1);
            self.literals.get() - 1
        }

        fn meta(&self, _key: &str) -> u32 {
            self.literal()
        }
    }

    /// The walk to its end, polled once per answer, as a segment is; how many
    /// times it waited.
    fn drive(evaluator: &Evaluator, expr: &Expression) -> (Eval, usize) {
        let mut walk = evaluator.eval(expr);
        let mut cx = Context::from_waker(Waker::noop());
        let mut waits = 0;
        loop {
            match walk.as_mut().poll(&mut cx) {
                Poll::Ready(result) => return (result, waits),
                Poll::Pending => waits += 1,
            }
        }
    }

    fn in_run<'a>(reader: &'a Counting) -> Evaluator<'a> {
        Evaluator::in_run(&EventOnly, 3, Surroundings { services: crate::env_services::current(), now: None, local_zone: None }, reader)
    }

    /// `value[member.key] = …`: an object literal's `__proto__` key is
    /// `Object.prototype`'s setter — an object or `null` the prototype,
    /// anything else ignored — and is no key of the object.
    #[test]
    fn an_object_literal_assigns_its_proto_key() {
        let reader = Counting::default();
        let (result, _) = drive(&in_run(&reader), &expression("{ a: 1, __proto__: { b: 2 } }"));
        let Js::Object(object) = result.unwrap().value else { panic!("an object") };
        assert_eq!(object.entries().iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["a"]);
        assert!(matches!(&object.proto, Some(Js::Object(proto)) if matches!(proto.get("b"), Some(Js::Number(n)) if *n == 2.0)));
        let (result, _) = drive(&in_run(&reader), &expression("{ __proto__: 1, a: 2 }"));
        let Js::Object(object) = result.unwrap().value else { panic!("an object") };
        assert!(object.proto.is_none() && object.get("__proto__").is_none());
    }

    /// `{...m}` is the TypeScript's `Object.assign`: an own `__proto__` key in
    /// `m` sets the new object's prototype (an object) or nothing (a
    /// primitive), and is no key of it.
    #[test]
    fn a_spread_assigns_an_own_proto_key_as_object_assign_does() {
        let source = |proto: Js| {
            let mut m = JsObject::new();
            m.set("a".into(), Js::Number(1.0));
            m.set("__proto__".into(), proto);
            Js::object(m)
        };
        let mut x = JsObject::new();
        x.set("x".into(), Js::Number(2.0));
        let mut spread = JsObject::new();
        spread_keys(&source(Js::object(x)), &mut spread).unwrap();
        assert_eq!(spread.entries().iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["a"]);
        let spread = std::rc::Rc::new(spread);
        assert!(matches!(crate::js::object_property(&spread, "x"), Js::Number(n) if n == 2.0));
        let mut ignored = JsObject::new();
        spread_keys(&source(Js::Number(5.0)), &mut ignored).unwrap();
        assert!(ignored.proto.is_none() && ignored.get("__proto__").is_none());
        // `null`: no prototype at all, and still a dict (`isDictValue`).
        let mut bare = JsObject::new();
        spread_keys(&source(Js::Null), &mut bare).unwrap();
        let bare = Js::object(bare);
        assert!(crate::js::is_dict(&bare));
        let mut again = JsObject::new();
        spread_keys(&bare, &mut again).unwrap();
        assert!(matches!(again.get("a"), Some(Js::Number(n)) if *n == 1.0));
    }

    #[test]
    fn twenty_reads_are_twenty_waits_in_one_walk() {
        let fields: Vec<String> = (0..20).map(|i| format!("f{i}")).collect();
        let text = format!("CONCAT(\"<\", {})", fields.iter().map(|f| format!("msg.`{f}`")).collect::<Vec<_>>().join(", "));
        let reader = Counting::default();
        let (result, waits) = drive(&in_run(&reader), &expression(&text));
        let expected: String = std::iter::once("<".to_string()).chain(fields.iter().map(|f| crate::js::to_upper_case(f))).collect();
        assert!(matches!(result.unwrap().value, Js::String(s) if s == expected));
        assert_eq!(*reader.asked.borrow(), fields);
        assert_eq!(waits, 20);
        // The literal before the reads was evaluated once: the walk never
        // started over.
        assert_eq!(reader.literals.get(), 1);
    }

    #[test]
    fn only_the_taken_arm_reads() {
        let reader = Counting::default();
        let expr = expression("IF msg.`a` == \"A\" THEN IF msg.`b` == \"X\" THEN msg.`c` ELSE msg.`d` END ELSE msg.`e` END");
        let (result, _) = drive(&in_run(&reader), &expr);
        assert!(matches!(result.unwrap().value, Js::String(s) if s == "D"));
        assert_eq!(*reader.asked.borrow(), ["a", "b", "d"]);
    }

    #[test]
    fn a_true_left_operand_of_or_reads_nothing_on_its_right() {
        let reader = Counting::default();
        let (result, waits) = drive(&in_run(&reader), &expression("msg.`a` == \"A\" OR msg.`b` == \"B\""));
        assert!(matches!(result.unwrap().value, Js::Bool(true)));
        assert_eq!(*reader.asked.borrow(), ["a"]);
        assert_eq!(waits, 1);
    }

    #[test]
    fn a_read_inside_a_function_argument_is_awaited_before_the_function() {
        let reader = Counting::default();
        let (result, waits) = drive(&in_run(&reader), &expression("LOWER(CONCAT(msg.`x`, \"-\", TRIM(msg.`y`)))"));
        assert!(matches!(result.unwrap().value, Js::String(s) if s == "x-y"));
        assert_eq!(*reader.asked.borrow(), ["x", "y"]);
        assert_eq!((waits, reader.literals.get()), (2, 1));
    }

    #[test]
    fn independent_walks_wait_on_their_reads_together() {
        // Two flows' evaluations joined (parallel arms, later): each has its
        // first read in flight before either is answered.
        let reader = Counting::default();
        let evaluator = in_run(&reader);
        let (left, right) = (expression("CONCAT(msg.`a`, msg.`b`)"), expression("CONCAT(msg.`c`, msg.`d`)"));
        let mut both = Box::pin(crate::executor::join_all(vec![evaluator.eval(&left), evaluator.eval(&right)]));
        let mut cx = Context::from_waker(Waker::noop());
        assert!(both.as_mut().poll(&mut cx).is_pending());
        assert_eq!(*reader.asked.borrow(), ["a", "c"]);
        let results = loop {
            if let Poll::Ready(results) = both.as_mut().poll(&mut cx) {
                break results;
            }
        };
        assert_eq!(*reader.asked.borrow(), ["a", "c", "b", "d"]);
        let texts: Vec<String> = results.into_iter().map(|r| r.unwrap().value.to_js_string()).collect();
        assert_eq!(texts, ["AB", "CD"]);
    }
}
