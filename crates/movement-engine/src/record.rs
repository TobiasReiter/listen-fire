//! Records held as values: the binding objects the TypeScript engine puts on
//! the value plane (a walk's landings read bare, `[a, b]` of two records, a
//! collection op's answer) and reads back with `bindingOf`, mirrored.
//!
//! To JavaScript a held record is a plain object (`String` prints
//! `[object Object]`, `Number` is NaN, `===` is identity). Every consumer
//! that asks `bindingOf` first reads it as the record it is instead: a field
//! read, a walk, `==` (identity, else a stored record's address), a spread or
//! `TEXT.PAIRS` (its fields), a block head (its landings).
//!
//! `bindingOf` is structural: any plain dict whose `kind` names a binding
//! kind is a binding to it, and `kind in describeBinding` walks the
//! prototype chain, so `{kind: "toString"}` is one too. Such a dict is
//! `Binding::Shaped`, read here as the TypeScript reads a binding of its
//! kind: through the dict's own keys, failing where a key it needs is not
//! there with the TypeError JavaScript throws (tests/oracle/records.json
//! pins every reading to the TypeScript's own).

use std::rc::Rc;

use movement_parser::lowering::expression::{Expression, FilterOperator};

use crate::bindings::Binding;
use crate::eval::{ErrorClass, EvalError};
use crate::js::{self, Js, JsObject};

/// The binding kinds `bindingOf` recognises (`describeBinding`'s own keys).
pub const BINDING_KINDS: [&str; 20] = [
    "event", "instance", "handle", "extractRoot", "extractPosition", "sourcePosition", "resource", "blockMeta",
    "positions", "tuple", "closure", "value", "shape", "movement", "shapePosition", "nodePosition", "lazyWalk", "callback",
    "plugin", "opaque",
];

/// The binding's `kind`, as the TypeScript's object carries it.
pub fn kind_of(binding: &Binding) -> String {
    let kind = match binding {
        Binding::Shaped(dict) => return shaped_kind(dict),
        Binding::Value(_) => "value",
        Binding::Event => "event",
        Binding::Instance(_) => "instance",
        Binding::Opaque => "opaque",
        Binding::Movement(_) => "movement",
        Binding::Shape(_) => "shape",
        Binding::Plugin(_) => "plugin",
        Binding::Handle(_) => "handle",
        Binding::Node(_) => "nodePosition",
        Binding::Landed(_) => "sourcePosition",
        Binding::Positions(_) => "positions",
        Binding::LazyWalk(_) => "lazyWalk",
        Binding::Extracted { root: true, .. } => "extractRoot",
        Binding::Extracted { root: false, .. } => "extractPosition",
    };
    kind.to_string()
}

fn shaped_kind(dict: &JsObject) -> String {
    match dict.get("kind") {
        Some(Js::String(kind)) => kind.clone(),
        _ => unreachable!("a shaped binding has a text kind"),
    }
}

/// `describeBinding[kind]`, as a template string prints it: a kind the table
/// does not own is `Object.prototype`'s member of that name.
pub fn describe(binding: &Binding) -> String {
    match binding {
        Binding::Shaped(dict) => describe_kind(&shaped_kind(dict)),
        other => crate::write::describe_binding(other),
    }
}

pub fn describe_kind(kind: &str) -> String {
    let described = match kind {
        "event" => "the movement parameter (the event position)",
        "instance" => "a constructed adapter instance",
        "handle" => "a write handle",
        "extractRoot" => "an extract result",
        "extractPosition" => "an extracted entity",
        "sourcePosition" => "a traversed source record",
        "resource" => "a resource",
        "blockMeta" => "a block meta-node",
        "positions" => "a block's returned records",
        "tuple" => "a combinator receipt",
        "closure" => "a closure",
        "value" => "a value binding",
        "shape" => "a shape declaration",
        "movement" => "a movement declaration",
        "shapePosition" => "an in-memory shape position",
        "nodePosition" => "a synthesised node",
        "lazyWalk" => "a deferred traversal",
        "callback" => "a callback",
        "plugin" => "a plugin",
        "opaque" => "an import",
        other => return js::prototype_member(other, &Rc::new(JsObject::new())).to_js_string(),
    };
    described.to_string()
}

/// `bindingOf`: the record a value IS, where it is one.
pub fn binding_of(value: &Js) -> Option<Binding> {
    match value {
        Js::Record(record) => Some((**record).clone()),
        Js::Object(dict) if is_shaped(dict) => Some(Binding::Shaped(dict.clone())),
        _ => None,
    }
}

/// A dict whose `kind` is text that `describeBinding` holds, its prototype's
/// names included.
pub fn is_shaped(dict: &JsObject) -> bool {
    matches!(dict.get("kind"), Some(Js::String(kind)) if BINDING_KINDS.contains(&kind.as_str()) || js::is_object_prototype_name(kind))
}

/// A record as the value a list, a map or a collection op holds it as: the
/// binding object itself (a shaped dict is the dict it is).
pub fn held(binding: Binding) -> Js {
    match binding {
        Binding::Shaped(dict) => Js::Object(dict),
        other => Js::Record(Rc::new(other)),
    }
}

/// `bindValue`: a record binds as the record it is, anything else on the
/// value plane.
pub fn bind_value(value: Js, trail: Option<crate::env::Trail>, many: bool) -> Binding {
    match binding_of(&value) {
        Some(record) => record,
        None => Binding::Value(crate::env::ValueBinding { value, trail, many }),
    }
}

/// `holdsRecords`: a record anywhere inside the value, through its lists and
/// maps.
pub fn holds_records(value: &Js) -> bool {
    binding_of(value).is_some()
        || match value {
            Js::Array(list) => list.items.iter().any(holds_records),
            Js::Object(dict) => dict.entries().iter().any(|(_, item)| holds_records(item)),
            _ => false,
        }
}

/// `heldBinding`: one record as itself, a non-empty list of nothing but
/// records as their landings.
pub fn held_binding(value: &Js) -> Option<Binding> {
    let Js::Array(list) = value else { return binding_of(value) };
    if list.items.is_empty() {
        return None;
    }
    list.items.iter().map(binding_of).collect::<Option<Vec<_>>>().map(Binding::Positions)
}

/// `heldRecords`: the record(s) a value binding holds, as the binding a walk
/// starts from; a list reads as landings only when the read walks (a hop,
/// or an `EXISTS` that hops or filters).
pub fn held_records(value: &Js, expr: &Expression) -> Option<Binding> {
    let held = held_binding(value)?;
    if !matches!(value, Js::Array(_)) {
        return Some(held);
    }
    let Expression::Traverse { steps, expression, .. } = expr else { return None };
    let walks = !steps.is_empty() || matches!(expression.as_ref(), Expression::Exists { steps, where_ } if !steps.is_empty() || where_.is_some());
    walks.then_some(held)
}

/// `readBindingField`'s value case: an object's field (its prototype's
/// names included), `?? null`; anything else null.
pub fn project(value: &Js, field: &str) -> Js {
    match value {
        Js::Object(object) => nullish_to_null(js::object_property(object, field)),
        _ => Js::Null,
    }
}

fn nullish_to_null(value: Js) -> Js {
    if value.is_nullish() { Js::Null } else { value }
}

/// `BINDING_IS_POSITION`: a record, the kinds a list literal holds as
/// themselves. A kind the table does not own reads `Object.prototype`'s
/// member, which is truthy.
pub fn is_position(binding: &Binding) -> bool {
    match binding {
        Binding::Event | Binding::Handle(_) | Binding::Extracted { .. } | Binding::Landed(_) | Binding::Positions(_) | Binding::Node(_) | Binding::LazyWalk(_) => true,
        Binding::Instance(_) | Binding::Value(_) | Binding::Shape(_) | Binding::Movement(_) | Binding::Plugin(_) | Binding::Opaque => false,
        Binding::Shaped(dict) => !matches!(shaped_kind(dict).as_str(), "instance" | "tuple" | "closure" | "value" | "shape" | "movement" | "plugin" | "opaque"),
    }
}

/// `isOneRecord`: what a name bound to a record reads as bare. A kind the
/// switch does not list reaches its default arm, `neverAsAny(binding)`,
/// which hands the (truthy) binding back.
pub fn is_one_record(binding: &Binding) -> bool {
    match binding {
        Binding::Handle(_) | Binding::Extracted { .. } | Binding::Landed(_) | Binding::Node(_) => true,
        Binding::Event | Binding::Instance(_) | Binding::Positions(_) | Binding::Value(_) | Binding::Shape(_) | Binding::Movement(_) | Binding::LazyWalk(_)
        | Binding::Plugin(_) | Binding::Opaque => false,
        Binding::Shaped(dict) => !matches!(
            shaped_kind(dict).as_str(),
            "event" | "instance" | "blockMeta" | "positions" | "tuple" | "closure" | "value" | "shape" | "movement" | "lazyWalk" | "plugin" | "opaque"
        ),
    }
}

/// `Object.hasOwn(binding, key) ? binding[key] : null`: `AT` over a record,
/// which `isDictValue` takes for a dict. Its `kind`, and the scalars the
/// binding object owns; an internal object it owns is the TypeScript
/// engine's own currency, which this engine does not hand out.
pub fn own_property(binding: &Binding, key: &str) -> Result<Js, EvalError> {
    if key == "kind" {
        return Ok(Js::String(kind_of(binding)));
    }
    let internal = |what: &str| {
        Err(EvalError::engine(
            "MOVENG_UNSUPPORTED",
            format!("reading the '{what}' a record holds as a map's key is not supported by the movement engine yet"),
        ))
    };
    match (binding, key) {
        (Binding::Shaped(dict), key) => Ok(dict.get(key).cloned().unwrap_or(Js::Null)),
        (Binding::Value(value), "value") => Ok(value.value.clone()),
        (Binding::Value(value), "many") if value.many => Ok(Js::Bool(true)),
        (Binding::Value(_), "provenance") => internal("provenance"),
        (Binding::Handle(handle), "targetType") => Ok(Js::str(handle.target_type.clone())),
        (Binding::Handle(handle), "handle") => Ok(handle.record.object.clone()),
        (Binding::Handle(_), "graph") => internal("graph"),
        (Binding::Landed(landed), "position") => Ok(landed.position.clone()),
        (Binding::Landed(landed), "edgeProperties") if landed.edge_properties.is_some() => Ok(landed.edge_properties.clone().unwrap_or(Js::Null)),
        (Binding::Landed(_), "read") => internal("read"),
        (Binding::Node(node), "landedOn") => Ok(node.borrow().landed_on.clone().map_or(Js::Null, Js::String)),
        (Binding::Node(node), "fieldOrder") => Ok(Js::array(node.borrow().field_order.iter().cloned().map(Js::String).collect())),
        (Binding::Node(_), what @ ("fields" | "fieldProvenance" | "edges")) => internal(what),
        (Binding::Extracted { .. }, "emission") => internal("emission"),
        (Binding::Positions(landings), "landings") => Ok(Js::array(landings.iter().cloned().map(held).collect())),
        (Binding::LazyWalk(_), "walk") => internal("walk"),
        (Binding::Instance(instance), "name") => Ok(Js::str(instance.name.clone())),
        (Binding::Instance(instance), "adapterSlug") => Ok(Js::str(instance.adapter_slug.clone())),
        (Binding::Instance(instance), "credentialName") if instance.credential_name.is_some() => {
            Ok(instance.credential_name.clone().map_or(Js::Null, Js::String))
        }
        (Binding::Instance(_), what @ ("constructionConfig" | "schema")) => internal(what),
        (Binding::Plugin(name), "plugin") => Ok(Js::str(name.clone())),
        (Binding::Movement(_), what @ ("declaration" | "fileEnv")) => internal(what),
        (Binding::Shape(_), "declaration") => internal("declaration"),
        _ => Ok(Js::Null),
    }
}

/// `compareRecords`: `==` / `!=` of two values either of which is a
/// record, by identity (`sameRecord`); `None` where neither is one, or for
/// any other operator, which the shared comparator answers.
pub fn compare_records(left: &Js, op: FilterOperator, right: &Js) -> Result<Option<bool>, EvalError> {
    let (a, b) = (binding_of(left), binding_of(right));
    if a.is_none() && b.is_none() {
        return Ok(None);
    }
    if !matches!(op, FilterOperator::Eq | FilterOperator::Neq) {
        return Ok(None);
    }
    let same = match (&a, &b) {
        (Some(a), Some(b)) => same_record(a, b)?,
        _ => false,
    };
    Ok(Some(if op == FilterOperator::Eq { same } else { !same }))
}

/// `sameRecord`: one binding object, or two reads of one stored record (its
/// address).
fn same_record(a: &Binding, b: &Binding) -> Result<bool, EvalError> {
    let identical = match (a, b) {
        (Binding::Shaped(x), Binding::Shaped(y)) => Rc::ptr_eq(x, y),
        _ => a.is(b),
    };
    if identical {
        return Ok(true);
    }
    let Some(first) = address(a)? else { return Ok(false) };
    Ok(address(b)?.is_some_and(|other| other == first))
}

/// `recordAddress`: a stable record's `adapterType:recordType:recordId`, a
/// handle's `adapterType:externalId`; none for a record the run built.
fn address(binding: &Binding) -> Result<Option<String>, EvalError> {
    let text = |value: Js| value.to_js_string();
    match binding {
        Binding::Landed(landed) => {
            let position = &landed.position;
            let identity = crate::unique::get(position, "identity");
            if !matches!(crate::unique::get(&identity, "kind"), Js::String(kind) if kind == "stable") {
                return Ok(None);
            }
            Ok(Some(format!(
                "{}:{}:{}",
                text(crate::unique::get(position, "adapterType")),
                text(crate::unique::get(position, "recordType")),
                text(crate::unique::get(&identity, "recordId"))
            )))
        }
        Binding::Handle(handle) => Ok(Some(format!("{}:{}", text(handle.record.get("adapterType")), text(handle.record.get("externalId"))))),
        Binding::Shaped(dict) => {
            let dict = Js::Object(dict.clone());
            match shaped_kind_of(&dict).as_str() {
                "sourcePosition" => {
                    let position = get(&dict, "position")?;
                    let identity = get(&position, "identity")?;
                    if !matches!(get(&identity, "kind")?, Js::String(kind) if kind == "stable") {
                        return Ok(None);
                    }
                    Ok(Some(format!(
                        "{}:{}:{}",
                        text(get(&position, "adapterType")?),
                        text(get(&position, "recordType")?),
                        text(get(&identity, "recordId")?)
                    )))
                }
                "handle" => {
                    let handle = get(&dict, "handle")?;
                    Ok(Some(format!("{}:{}", text(get(&handle, "adapterType")?), text(get(&handle, "externalId")?))))
                }
                _ => Ok(None),
            }
        }
        _ => Ok(None),
    }
}

fn shaped_kind_of(dict: &Js) -> String {
    match dict {
        Js::Object(object) => shaped_kind(object),
        _ => unreachable!("a shaped binding is a dict"),
    }
}

/// `value[key]` as JavaScript reads it, for the TypeScript's reads of a
/// shaped binding's own keys: the TypeError it throws off nothing.
pub fn get(value: &Js, key: &str) -> Result<Js, EvalError> {
    match value {
        Js::Undefined | Js::Null => Err(type_error(&format!("Cannot read properties of {} (reading '{key}')", value.to_js_string()))),
        Js::Object(object) => Ok(js::object_property(object, key)),
        Js::Record(record) => match own_property(record, key)? {
            Js::Null if !matches!(key, "kind") => Ok(Js::Undefined),
            found => Ok(found),
        },
        Js::Array(list) if key == "length" => Ok(Js::Number(list.items.len() as f64)),
        Js::Array(list) => Ok(key.parse::<usize>().ok().and_then(|i| list.items.get(i).cloned()).unwrap_or(Js::Undefined)),
        Js::String(text) if key == "length" => Ok(Js::Number(js::utf16_len(text) as f64)),
        _ => Ok(Js::Undefined),
    }
}

pub fn type_error(message: &str) -> EvalError {
    EvalError::Thrown { class: ErrorClass::TypeError, message: message.to_string() }
}

fn unsupported(construct: &str, detail: Option<&str>) -> EvalError {
    EvalError::engine(
        "MOVENG_UNSUPPORTED",
        match detail {
            Some(detail) => format!("{construct} is not supported by the movement engine yet ({detail})"),
            None => format!("{construct} is not supported by the movement engine yet"),
        },
    )
}

/// `describeHeldValue`.
fn describe_held_value(value: &Js) -> String {
    match value {
        Js::Undefined | Js::Null => "nothing".into(),
        Js::Array(_) => "a list that is not all records".into(),
        other => format!("a {}", other.type_of()),
    }
}

/// `isDictValue`: a plain keyed object (a binding object is one too).
pub fn is_dict(value: &Js) -> bool {
    matches!(value, Js::Object(_) | Js::Record(_))
}

/// `recordFields`: a record's whole dot plane as a plain map, in the order
/// its kind declares its fields; a system's record has no field list in
/// hand.
pub fn fields_of(binding: &Binding) -> Result<JsObject, EvalError> {
    let mut fields = JsObject::new();
    match binding {
        Binding::Node(node) => {
            let node = node.borrow();
            for field in &node.field_order {
                fields.set(field.clone(), nullish_to_null(object_field(&node.fields, field)));
            }
        }
        Binding::Extracted { emission, .. } => {
            for (key, value) in emission.fields.entries() {
                fields.set(key.clone(), value.clone());
            }
        }
        Binding::Handle(handle) => {
            let written = handle.record.get("writtenValues");
            if let Js::Object(written) = &written {
                for (key, value) in written.entries() {
                    fields.set(key.clone(), value.clone());
                }
            }
            // `omitKeys`: a key `in` the written values (their prototype's
            // names too) is the written one.
            if let Js::Object(data) = handle.record.get("resultData") {
                for (key, value) in data.entries() {
                    let written_key = matches!(&written, Js::Object(w) if w.get(key).is_some()) || js::is_object_prototype_name(key);
                    if !written_key {
                        fields.set(key.clone(), value.clone());
                    }
                }
            }
        }
        Binding::Value(value) => match &value.value {
            Js::Object(dict) => {
                for (key, item) in dict.entries() {
                    fields.set(key.clone(), item.clone());
                }
            }
            other => return Err(unsupported(&format!("reading every field of {}", describe_held_value(other)), None)),
        },
        Binding::Landed(_) | Binding::Event => {
            return Err(unsupported(
                &format!("reading every field of {}", describe(binding)),
                Some("a system record has no field list in hand — build a dict of the fields you want, `{ name: r.name, … }`"),
            ));
        }
        Binding::Positions(_) | Binding::LazyWalk(_) | Binding::Instance(_) | Binding::Shape(_) | Binding::Movement(_) | Binding::Plugin(_) | Binding::Opaque => {
            return Err(unsupported(&format!("reading every field of {}", describe(binding)), None));
        }
        Binding::Shaped(dict) => return crate::record::shaped::fields(dict),
    }
    Ok(fields)
}

fn object_field(object: &JsObject, field: &str) -> Js {
    js::plain_property(object, field)
}

/// `object[field] ?? null` on a map the engine holds as an object.
pub fn project_object(object: &JsObject, field: &str) -> Js {
    nullish_to_null(js::plain_property(object, field))
}

/// `plainValueOf`: a value with every record inside it read down to plain
/// data — its fields, and one key per edge it carries holding what landed
/// there as a list.
pub fn plain_value_of(value: &Js) -> Result<Js, EvalError> {
    plain_value(value, &mut Vec::new())
}

fn plain_value(value: &Js, path: &mut Vec<Binding>) -> Result<Js, EvalError> {
    if let Some(record) = binding_of(value) {
        return plain_record(&record, path);
    }
    match value {
        Js::Array(list) => Ok(Js::array(list.items.iter().map(|item| plain_value(item, path)).collect::<Result<_, _>>()?)),
        Js::Object(dict) => {
            let mut out = JsObject::new();
            for (key, item) in dict.entries() {
                out.set(key.clone(), plain_value(item, path)?);
            }
            Ok(Js::object(out))
        }
        other => Ok(other.clone()),
    }
}

fn plain_record(binding: &Binding, path: &mut Vec<Binding>) -> Result<Js, EvalError> {
    if path.iter().any(|seen| same_object(seen, binding)) {
        return Err(unsupported("writing out a record that contains itself through its edges", None));
    }
    path.push(binding.clone());
    let plain = plain_record_within(binding, path);
    path.pop();
    plain
}

fn same_object(a: &Binding, b: &Binding) -> bool {
    match (a, b) {
        (Binding::Shaped(x), Binding::Shaped(y)) => Rc::ptr_eq(x, y),
        _ => a.is(b),
    }
}

fn plain_record_within(binding: &Binding, path: &mut Vec<Binding>) -> Result<Js, EvalError> {
    match binding {
        Binding::Positions(landings) => return Ok(Js::array(landings.iter().map(|l| plain_record(l, path)).collect::<Result<_, _>>()?)),
        Binding::Value(value) => return plain_value(&value.value, path),
        _ => {}
    }
    let mut plain = JsObject::new();
    for (field, member) in fields_of(binding)?.entries() {
        plain.set(field.clone(), plain_value(member, path)?);
    }
    let mut edges: Vec<(String, Js)> = Vec::new();
    match binding {
        Binding::Node(node) => {
            let held: Vec<(String, crate::bindings::Edge)> = node.borrow().edges.clone();
            for (name, edge) in held {
                if edge.deferred.is_some() {
                    return Err(unsupported(
                        &format!("writing out the '{name}' edge of a record, which is a lazy walk that has not been run"),
                        Some("await it first"),
                    ));
                }
                let landed = edge.landings.iter().map(|l| plain_record(l, path)).collect::<Result<Vec<_>, _>>()?;
                edges.push((name, Js::array(landed)));
            }
        }
        Binding::Extracted { emission, .. } => {
            for (name, children) in &emission.children {
                let landed = children
                    .iter()
                    .map(|child| plain_record(&Binding::Extracted { emission: child.clone(), root: false, id: crate::bindings::Identity::new() }, path))
                    .collect::<Result<Vec<_>, _>>()?;
                edges.push((name.clone(), Js::array(landed)));
            }
        }
        _ => {}
    }
    for (name, landed) in edges {
        if plain.get(&name).is_some() || js::is_object_prototype_name(&name) {
            return Err(unsupported(&format!("writing out a record whose field and edge are both called '{name}'"), None));
        }
        plain.set(name, landed);
    }
    Ok(Js::object(plain))
}

pub mod shaped {
    //! A shaped binding read as the TypeScript reads a binding of its kind.

    use std::rc::Rc;

    use crate::eval::EvalError;
    use crate::js::{Js, JsObject};

    use super::{get, shaped_kind, unsupported};

    /// `recordFields` of a shaped binding.
    pub fn fields(dict: &Rc<JsObject>) -> Result<JsObject, EvalError> {
        let this = Js::Object(dict.clone());
        let kind = shaped_kind(dict);
        let mut fields = JsObject::new();
        let spread = |fields: &mut JsObject, value: &Js| {
            if let Js::Object(source) = value {
                for (key, item) in source.entries() {
                    fields.set(key.clone(), item.clone());
                }
            }
        };
        match kind.as_str() {
            "nodePosition" => {
                let order = get(&this, "fieldOrder")?;
                let Js::Array(order) = order else {
                    get(&order, "map")?;
                    return Err(super::type_error("binding.fieldOrder.map is not a function"));
                };
                let values = get(&this, "fields")?;
                for field in &order.items {
                    let key = field.to_js_string();
                    let value = get(&values, &key)?;
                    fields.set(key, if value.is_nullish() { Js::Null } else { value });
                }
            }
            "shapePosition" => spread(&mut fields, &get(&this, "fields")?),
            "extractPosition" | "extractRoot" => spread(&mut fields, &get(&get(&this, "emission")?, "fields")?),
            "handle" => {
                let handle = get(&this, "handle")?;
                let written = get(&handle, "writtenValues")?;
                spread(&mut fields, &written);
                if let Js::Object(data) = get(&handle, "resultData")? {
                    for (key, value) in data.entries() {
                        let written_key = match &written {
                            Js::Object(w) => w.get(key).is_some() || crate::js::is_object_prototype_name(key),
                            _ => return Err(super::type_error(&format!("Cannot use 'in' operator to search for '{key}' in {}", written.to_js_string()))),
                        };
                        if !written_key {
                            fields.set(key.clone(), value.clone());
                        }
                    }
                }
            }
            "resource" => {
                let data = get(&get(&this, "resource")?, "data")?;
                spread(&mut fields, &data);
            }
            "callback" => {
                fields.set("id".into(), get(&this, "callbackId")?);
                fields.set("url".into(), get(&this, "url")?);
            }
            "value" => {
                let value = get(&this, "value")?;
                match &value {
                    Js::Object(_) | Js::Record(_) => spread(&mut fields, &value),
                    other => return Err(unsupported(&format!("reading every field of {}", super::describe_held_value(other)), None)),
                }
            }
            "sourcePosition" | "event" => {
                return Err(unsupported(
                    &format!("reading every field of {}", super::describe_kind(&kind)),
                    Some("a system record has no field list in hand — build a dict of the fields you want, `{ name: r.name, … }`"),
                ));
            }
            "positions" | "blockMeta" | "lazyWalk" | "tuple" | "instance" | "closure" | "shape" | "movement" | "plugin" | "opaque" => {
                return Err(unsupported(&format!("reading every field of {}", super::describe_kind(&kind)), None));
            }
            // `neverAsAny(binding)`: the dict itself.
            _ => spread(&mut fields, &this),
        }
        Ok(fields)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `kind in describeBinding` walks the prototype chain: a dict whose
    /// `kind` is one of `Object.prototype`'s names is a record too.
    #[test]
    fn a_dict_is_a_record_when_its_kind_is_a_binding_kind_or_a_prototype_name() {
        let with_kind = |kind: &str| {
            let mut o = JsObject::new();
            o.set("kind".into(), Js::str(kind));
            Js::object(o)
        };
        for kind in ["event", "handle", "toString", "constructor", "valueOf", "__proto__", "hasOwnProperty"] {
            assert!(binding_of(&with_kind(kind)).is_some(), "{kind}");
        }
        for kind in ["nope", "tostring", "prototype", ""] {
            assert!(binding_of(&with_kind(kind)).is_none(), "{kind}");
        }
        assert!(binding_of(&Js::str("event")).is_none());
        assert_eq!(describe_kind("constructor"), "function Object() { [native code] }");
        assert_eq!(describe_kind("__proto__"), "[object Object]");
        assert_eq!(describe_kind("toString"), "function toString() { [native code] }");
    }

    /// ToPrimitive over a dict: its own `toString` that is no function
    /// cannot make it text; a built-in there is called.
    #[test]
    fn a_dict_is_made_text_as_to_primitive_makes_it() {
        let dict = |entries: Vec<(&str, Js)>| {
            let mut o = JsObject::new();
            for (k, v) in entries {
                o.set(k.into(), v);
            }
            Js::object(o)
        };
        let f = |name: &'static str| Js::Function(js::NativeFunction(name));
        assert_eq!(dict(vec![]).to_text().unwrap(), "[object Object]");
        assert_eq!(dict(vec![("valueOf", Js::Number(1.0))]).to_text().unwrap(), "[object Object]");
        assert_eq!(dict(vec![("toString", Js::str("t"))]).to_text().unwrap_err().message, "Cannot convert object to primitive value");
        assert_eq!(dict(vec![("toString", f("hasOwnProperty"))]).to_text().unwrap(), "false");
        assert_eq!(dict(vec![("toString", f("hasOwnProperty")), ("undefined", Js::Number(1.0))]).to_text().unwrap(), "true");
        assert_eq!(dict(vec![("toString", f("__lookupGetter__"))]).to_text().unwrap(), "undefined");
        assert_eq!(dict(vec![("toString", f("__defineGetter__"))]).to_text().unwrap_err().message, "Object.prototype.__defineGetter__: Expecting function");
        assert_eq!(dict(vec![("toString", f("toLocaleString"))]).to_text().unwrap_err().class, "RangeError");
        assert_eq!(Js::array(vec![dict(vec![("toString", Js::Null)])]).to_text().unwrap_err().message, "Cannot convert object to primitive value");
    }

    /// `===` of two binding objects is identity: a clone is the same object.
    #[test]
    fn records_compare_by_identity_or_address() {
        let node = Binding::Node(Rc::new(std::cell::RefCell::new(crate::bindings::Node::default())));
        let other = Binding::Node(Rc::new(std::cell::RefCell::new(crate::bindings::Node::default())));
        let held = |b: &Binding| held(b.clone());
        assert_eq!(compare_records(&held(&node), FilterOperator::Eq, &held(&node)).unwrap(), Some(true));
        assert_eq!(compare_records(&held(&node), FilterOperator::Eq, &held(&other)).unwrap(), Some(false));
        assert_eq!(compare_records(&held(&node), FilterOperator::Neq, &Js::Number(1.0)).unwrap(), Some(true));
        assert_eq!(compare_records(&held(&node), FilterOperator::Gt, &held(&node)).unwrap(), None);
        assert_eq!(compare_records(&Js::Number(1.0), FilterOperator::Eq, &Js::Number(1.0)).unwrap(), None);
    }
}
