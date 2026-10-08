//! The pure expression evaluator: `evalMovementExpr`
//! (apps/api/src/services/movement_engine/expression.ts) over the kinds that
//! need no host — literals, value-binding reads, `AT`, lists, maps,
//! interpolation, conditionals, comparisons, logic, arithmetic and the
//! built-in functions — with the same values, the same provenance and the
//! same errors.
//!
//! Provenance follows the TypeScript's rules exactly: a literal is a fresh
//! origin (one per evaluation), a name passes its binding's trail through
//! untouched, a branch or a `COALESCE` passes the chosen value's trail
//! through, and everything else is the taint union of what it read.

use std::cell::Cell;

use movement_parser::lowering::expression::{
    Expression, FilterOperator, ListElement, LogicalOp, ObjectMember, StaticValue,
};

use crate::env::{Env, Trail, ValueBinding};
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
}

#[derive(Debug, Clone, PartialEq)]
pub enum EvalError {
    /// What the TypeScript evaluator throws, constructed as it constructs it.
    Thrown { class: ErrorClass, message: String },
    /// A value or construct whose JavaScript reading this engine does not
    /// reproduce (a text only V8's date parser reads, a regex feature): the
    /// TypeScript evaluator answers it instead.
    Fallback(String),
    /// The evaluation needs an answer from the host it does not have yet
    /// (`Reader`): the caller asks, and evaluates the expression again.
    Suspend,
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

pub fn static_value(value: &StaticValue) -> Js {
    match value {
        StaticValue::String(s) => Js::str(s.clone()),
        StaticValue::Number(n) => Js::Number(n.0),
        StaticValue::Bool(b) => Js::Bool(*b),
        StaticValue::Null => Js::Null,
    }
}

/// The names an expression reads: value bindings, and which names are the
/// event (read through the host).
pub trait Names {
    fn value(&self, name: &str) -> Option<ValueBinding>;
    fn is_event(&self, name: &str) -> bool;
    /// A record the run holds (a write's handle, a node it built), whose
    /// fields the run reads (`readBindingField`).
    fn is_record(&self, _name: &str) -> bool {
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
    /// A field of a record the run holds (`co.externalId`, `g.title`):
    /// answered by the run, which holds the record and its fields' trails.
    RecordField { root: String, field: String },
    /// A built-in this engine does not reproduce for these arguments: the
    /// TypeScript member answers.
    Function { id: String, args: Vec<Js> },
    /// The shared comparator, likewise.
    Compare { op: FilterOperator, left: Js, right: Js },
}

/// The host's answers to an evaluation's asks. An evaluation is replayed
/// from the start after each new answer, so the answers are handed out in
/// the order asked; one not answered yet is `Suspend`.
pub trait Reader {
    fn ask(&self, ask: Ask) -> Result<Evaluated, EvalError>;
}

pub struct Evaluator<'a> {
    env: &'a dyn Names,
    language_version: u32,
    around: Surroundings<'a>,
    next_literal: Cell<u32>,
    reader: Option<&'a dyn Reader>,
}

type Eval = Result<Evaluated, EvalError>;

impl<'a> Evaluator<'a> {
    /// `first_literal` is the first origin id free for literals: the caller
    /// numbered its own origins below it.
    pub fn new(env: &'a dyn Names, language_version: u32, around: Surroundings<'a>, first_literal: u32) -> Self {
        Evaluator { env, language_version, around, next_literal: Cell::new(first_literal), reader: None }
    }

    /// Inside a run: what the evaluation cannot answer itself, it asks.
    pub fn with_reader(mut self, reader: &'a dyn Reader) -> Self {
        self.reader = Some(reader);
        self
    }

    /// The first literal origin id the evaluation has not minted.
    pub fn next_literal(&self) -> u32 {
        self.next_literal.get()
    }

    /// `result`, or the host's answer where this engine handed it back.
    fn or_ask(&self, result: Result<Js, EvalError>, ask: impl FnOnce() -> Ask) -> Result<Js, EvalError> {
        match (result, self.reader) {
            (Err(EvalError::Fallback(_)), Some(reader)) => reader.ask(ask()).map(|answered| answered.value),
            (other, _) => other,
        }
    }

    pub fn eval(&self, expr: &Expression) -> Eval {
        match expr {
            Expression::Static { value } => {
                let id = self.next_literal.get();
                self.next_literal.set(id + 1);
                Ok(Evaluated { value: static_value(value), prov: Prov::Built(Trail { origins: vec![id], direct: Some(id) }) })
            }
            // A bare name: the value binding's value and trail. Outside a
            // hop's WHERE a rootless `property` read is the same read.
            Expression::AliasRef { name } | Expression::Property { property_type_id: name } => self.read_name(name),
            Expression::At { expression, index } => {
                let inner = self.eval(expression)?;
                let index = self.eval(index)?;
                let prov = self.union(&[&inner.prov, &index.prov]);
                // A dict is looked up by its key; a key that is not there,
                // or one that is not text, is null.
                let value = match &inner.value {
                    Js::Object(object) => match &index.value {
                        Js::String(key) => object.get(key).cloned().unwrap_or(Js::Null),
                        _ => Js::Null,
                    },
                    other => at_index(other, index.value.to_number()),
                };
                Ok(Evaluated { value, prov })
            }
            Expression::List { elements } => {
                let mut values = Vec::new();
                let mut provs = Vec::new();
                for element in elements {
                    match element {
                        ListElement::Expression(e) => {
                            let member = self.eval(e)?;
                            values.push(member.value);
                            provs.push(member.prov);
                        }
                        ListElement::Spread(spread) => {
                            let evaluated = self.eval(&spread.expression)?;
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
                            values.extend(list.items.iter().cloned());
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
                        ObjectMember::Entry { key, value } => {
                            let result = self.eval(value)?;
                            if key == "__proto__" {
                                return Err(EvalError::Fallback("a `__proto__` key sets a prototype".into()));
                            }
                            object.set(key.clone(), result.value);
                            provs.push(result.prov);
                        }
                        ObjectMember::Spread(spread) => {
                            let result = self.eval(&spread.expression)?;
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
                    let part = self.eval(part)?;
                    if !part.value.is_nullish() {
                        text.push_str(&part.value.to_js_string());
                    }
                    provs.push(part.prov);
                }
                Ok(Evaluated { value: Js::String(text), prov: self.union(&provs.iter().collect::<Vec<_>>()) })
            }
            Expression::Conditional { condition, then, else_ } => {
                let condition = self.eval(condition)?;
                self.eval(if condition.value.truthy() { then } else { else_ })
            }
            Expression::Compare { op, left, right } => {
                // `x == null` asks whether `x` has a value: answered from
                // the subject alone, which keeps its trail.
                if is_null_literal(right) {
                    let subject = self.eval(left)?;
                    return Ok(Evaluated { value: Js::Bool(compare_to_null(*op, &subject.value)), prov: subject.prov });
                }
                if is_null_literal(left) {
                    let subject = self.eval(right)?;
                    return Ok(Evaluated { value: Js::Bool(compare_to_null(*op, &subject.value)), prov: subject.prov });
                }
                let l = self.eval(left)?;
                let r = self.eval(right)?;
                let records = stdlib::is_binding_shaped(&l.value) || stdlib::is_binding_shaped(&r.value);
                if records && matches!(op, FilterOperator::Eq | FilterOperator::Neq) {
                    return Err(EvalError::Fallback("a record compared by its identity".into()));
                }
                let value = self.or_ask(compare_values(&l.value, *op, &r.value).map(Js::Bool), || Ask::Compare {
                    op: *op,
                    left: l.value.clone(),
                    right: r.value.clone(),
                })?;
                Ok(Evaluated { value, prov: self.union(&[&l.prov, &r.prov]) })
            }
            Expression::Logical { op, operands } => {
                let wanted = matches!(op, LogicalOp::Or);
                let mut seen = Vec::new();
                for operand in operands {
                    let result = self.eval(operand)?;
                    let truthy = result.value.truthy();
                    seen.push(result.prov);
                    if truthy == wanted {
                        return Ok(Evaluated { value: Js::Bool(wanted), prov: self.union(&seen.iter().collect::<Vec<_>>()) });
                    }
                }
                Ok(Evaluated { value: Js::Bool(!wanted), prov: self.union(&seen.iter().collect::<Vec<_>>()) })
            }
            Expression::Not { expression } => {
                let inner = self.eval(expression)?;
                Ok(Evaluated { value: Js::Bool(!inner.value.truthy()), prov: self.union(&[&inner.prov]) })
            }
            Expression::Negate { expression } => {
                let inner = self.eval(expression)?;
                Ok(Evaluated { value: Js::Number(-inner.value.to_number()), prov: self.union(&[&inner.prov]) })
            }
            Expression::Arithmetic { op, left, right } => {
                let l = self.eval(left)?;
                let r = self.eval(right)?;
                let value = arithmetic(*op, l.value.to_number(), r.value.to_number());
                Ok(Evaluated { value, prov: self.union(&[&l.prov, &r.prov]) })
            }
            Expression::Function { fn_, args } => self.function(fn_, args),
            Expression::Traverse { alias_root: Some(root), steps, expression } if steps.is_empty() => {
                let Expression::Property { property_type_id: field } = expression.as_ref() else {
                    return Err(EvalError::Fallback("a traversal terminal other than a field".into()));
                };
                self.traverse(root, field)
            }
            other => Err(EvalError::Fallback(format!("the expression kind {:?} needs the host", kind_of(other)))),
        }
    }

    /// `root.field` with no hops: the event's field through the host, or a
    /// value binding's field projected (`readBindingField`'s value case).
    fn traverse(&self, root: &str, field: &str) -> Eval {
        if self.env.is_event(root) {
            return match self.reader {
                Some(reader) => reader.ask(Ask::EventField { field: field.to_string() }),
                None => Err(EvalError::Fallback("the event needs the host".into())),
            };
        }
        if self.env.is_record(root) {
            return match self.reader {
                Some(reader) => reader.ask(Ask::RecordField { root: root.to_string(), field: field.to_string() }),
                None => Err(EvalError::Fallback("a record the run holds is the run's".into())),
            };
        }
        let Some(binding) = self.env.value(root) else {
            return Err(EvalError::Fallback(format!("'{root}' is not a value binding")));
        };
        // A record held on the value plane reads as the record it is.
        if stdlib::is_binding_shaped(&binding.value) {
            return Err(EvalError::Fallback("a record held in a value binding".into()));
        }
        let value = match &binding.value {
            Js::Object(object) => match object.get(field) {
                Some(found) if !found.is_nullish() => found.clone(),
                Some(_) => Js::Null,
                // `value[field] ?? null` reads Object.prototype's names too.
                None if stdlib::is_object_prototype_name(field) => {
                    return Err(EvalError::Fallback(format!("`{field}` is Object.prototype's")));
                }
                None => Js::Null,
            },
            _ => Js::Null,
        };
        // A field projected out of a value keeps the taint union but drops
        // `direct`: it is not the whole value's quote.
        Ok(Evaluated { value, prov: self.union(&[&Prov::Binding(root.to_string())]) })
    }

    fn read_name(&self, name: &str) -> Eval {
        let Some(binding) = self.env.value(name) else {
            return Err(EvalError::engine(
                "MOVENG_RUNTIME",
                format!("'{name}' is not in scope — the checker should have caught this"),
            ));
        };
        Ok(Evaluated { value: binding.value.clone(), prov: Prov::Binding(name.to_string()) })
    }

    /// `isManyValued`: a name bound to a walk read for a field.
    fn is_many_valued(&self, expr: &Expression) -> bool {
        match expr {
            Expression::AliasRef { name } | Expression::Property { property_type_id: name } => {
                self.env.value(name).is_some_and(|b| b.many)
            }
            _ => false,
        }
    }

    fn function(&self, id: &str, args: &[Expression]) -> Eval {
        if stdlib::NAMESPACED.contains(&id) {
            let mut values = Vec::new();
            let mut provs = Vec::new();
            for (index, a) in args.iter().enumerate() {
                let result = self.eval(a)?;
                // A record (a dict the TypeScript reads as a binding) is
                // read down to its fields there.
                let special = stdlib::record_arg(id) == Some(index) || stdlib::whole_value_arg(id) == Some(index);
                if special && holds_binding(&result.value, stdlib::whole_value_arg(id) == Some(index)) {
                    return Err(EvalError::Fallback("a record read down to its fields".into()));
                }
                values.push(result.value);
                provs.push(result.prov);
            }
            let value = self.or_ask(stdlib::apply_namespaced(id, &values, self.around), || Ask::Function {
                id: id.to_string(),
                args: values.clone(),
            })?;
            return Ok(Evaluated { value, prov: self.union(&provs.iter().collect::<Vec<_>>()) });
        }
        if !stdlib::FLAT.contains(&id) {
            return Err(EvalError::Fallback(format!("{id} is not a built-in this engine runs")));
        }
        if id == "coalesce" && self.language_version >= 3 {
            // From version 3 COALESCE short-circuits, as `??` does.
            let mut seen = Vec::new();
            for a in args {
                let result = self.eval(a)?;
                if !result.value.is_nullish() {
                    return Ok(result);
                }
                seen.push(result.prov);
            }
            return Ok(Evaluated { value: Js::Null, prov: self.union(&seen.iter().collect::<Vec<_>>()) });
        }
        let mut results = Vec::new();
        for a in args {
            results.push(self.eval(a)?);
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
        let value = self.or_ask(stdlib::apply_flat(id, &values), || Ask::Function { id: id.to_string(), args: values.clone() })?;
        Ok(Evaluated { value, prov: self.union(&provs) })
    }

    /// The taint union: every origin once, in the order first seen, and no
    /// `direct`.
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

/// `membersOf`: nothing is no members, a list is its own, anything else one.
fn members_of(value: &Js) -> Js {
    match value {
        Js::Undefined | Js::Null => Js::array(vec![]),
        Js::Array(_) => value.clone(),
        other => Js::array(vec![other.clone()]),
    }
}

/// `Object.assign(object, spreadKeysOf(value))`.
fn spread_keys(value: &Js, object: &mut JsObject) -> Result<(), EvalError> {
    match value {
        Js::Undefined | Js::Null => Ok(()),
        Js::Object(_) if stdlib::is_binding_shaped(value) => Err(EvalError::Fallback("a record's fields spread".into())),
        Js::Object(source) => {
            for (key, item) in source.entries() {
                if key == "__proto__" {
                    return Err(EvalError::Fallback("a `__proto__` key sets a prototype".into()));
                }
                object.set(key.clone(), item.clone());
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

/// Whether `value` is, or (for a whole-value argument) holds anywhere, a
/// dict the TypeScript reads as a record.
fn holds_binding(value: &Js, deep: bool) -> bool {
    if stdlib::is_binding_shaped(value) {
        return true;
    }
    if !deep {
        return false;
    }
    match value {
        Js::Array(list) => list.items.iter().any(|item| holds_binding(item, true)),
        Js::Object(object) => object.entries().iter().any(|(_, item)| holds_binding(item, true)),
        _ => false,
    }
}

fn kind_of(expr: &Expression) -> String {
    serde_json::to_value(expr)
        .ok()
        .and_then(|json| json.get("type").and_then(|t| t.as_str()).map(String::from))
        .unwrap_or_default()
}
