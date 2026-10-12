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
//! A record is a `Js::Record` and nothing else: a dict is data whatever
//! keys it carries, a `kind` naming a binding's included (Henry's ruling,
//! 2026-10-10: the content of data never changes how it is treated).

use std::rc::Rc;

use movement_parser::lowering::expression::{Expression, FilterOperator};

use crate::bindings::Binding;
use crate::eval::{ErrorClass, EvalError};
use crate::js::{self, Js, JsObject};

/// The binding's `kind`, as the TypeScript's object carries it.
pub fn kind_of(binding: &Binding) -> String {
    let kind = match binding {
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
        Binding::Tuple(_) => "tuple",
        Binding::Closure(_) => "closure",
        Binding::Extracted { root: true, .. } => "extractRoot",
        Binding::Extracted { root: false, .. } => "extractPosition",
        Binding::Callback(_) => "callback",
        Binding::ShapePosition(_) => "shapePosition",
        Binding::Resource(_) => "resource",
    };
    kind.to_string()
}

/// `describeBinding[binding.kind]`.
pub fn describe(binding: &Binding) -> String {
    crate::write::describe_binding(binding)
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
        other => return other.to_string(),
    };
    described.to_string()
}

/// `bindingOf`: the record a value IS, where it is one. Only an engine
/// object is: a dict is data.
pub fn binding_of(value: &Js) -> Option<Binding> {
    match value {
        Js::Record(record) => Some((**record).clone()),
        _ => None,
    }
}

/// A record as the value a list, a map or a collection op holds it as: the
/// binding object itself.
pub fn held(binding: Binding) -> Js {
    Js::Record(Rc::new(binding))
}

/// The binding object a record IS to the TypeScript engine, for the kinds
/// whose object holds data only (the event, a callback, a shape position, a
/// resource): what a JSON writer prints, and, for the event and a callback,
/// the descriptor a host is handed (`["x", id, descriptor]` on the
/// segment's wire). None for a kind whose
/// object holds what only an engine has (a read seam, a schema, code).
pub fn data_object(binding: &Binding) -> Option<Js> {
    let kind = ("kind", Js::str(kind_of(binding)));
    Some(crate::env::object_of(match binding {
        Binding::Event => vec![kind],
        Binding::Callback(callback) => vec![kind, ("callbackId", callback.callback_id.clone()), ("url", callback.url.clone()), ("params", callback.params.clone())],
        Binding::ShapePosition(position) => vec![
            kind,
            ("shape", position.shape.clone()),
            ("node", position.node.clone()),
            ("fields", position.fields.clone()),
            ("fieldProvenance", position.field_provenance.clone()),
        ],
        Binding::Resource(resource) => vec![kind, ("resource", (**resource).clone())],
        _ => return None,
    }))
}

/// `bindValue`: a record binds as the record it is, anything else on the
/// value plane.
pub fn bind_value(value: Js, trail: Option<crate::env::Trail>, many: bool) -> Binding {
    match binding_of(&value) {
        Some(record) => record,
        None => Binding::Value(crate::env::ValueBinding { value, trail, many }),
    }
}

/// `holdsRecords` (serialize.ts): whether a record — one held as a value,
/// or a dict `bindingOf` takes for one — is anywhere inside the value,
/// through its lists and maps; a park writes a value holding one as the
/// recursive `recordValue` descriptor, and everything else as data.
pub fn holds_records(value: &Js) -> bool {
    if js::holds_itself(value) {
        return holds_records(&js::acyclic(value));
    }
    binding_of(value).is_some()
        || match value {
            Js::Array(list) => list.items().iter().any(holds_records),
            Js::Object(dict) if dict.proto.is_none() => dict.entries().iter().any(|(_, item)| holds_records(item)),
            _ => false,
        }
}

/// `heldBinding`: one record as itself, a non-empty list of nothing but
/// records as their landings.
pub fn held_binding(value: &Js) -> Option<Binding> {
    let Js::Array(list) = value else { return binding_of(value) };
    if list.items().is_empty() {
        return None;
    }
    list.items().iter().map(binding_of).collect::<Option<Vec<_>>>().map(Binding::Positions)
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
        Js::File(file) => nullish_to_null(js::plain_property(&file.display, field)),
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
        Binding::Event
        | Binding::Handle(_)
        | Binding::Extracted { .. }
        | Binding::Landed(_)
        | Binding::Positions(_)
        | Binding::Node(_)
        | Binding::LazyWalk(_)
        | Binding::Callback(_)
        | Binding::ShapePosition(_)
        | Binding::Resource(_) => true,
        Binding::Instance(_) | Binding::Value(_) | Binding::Shape(_) | Binding::Movement(_) | Binding::Plugin(_) | Binding::Opaque | Binding::Tuple(_) | Binding::Closure(_) => false,
    }
}

/// `isOneRecord`: what a name bound to a record reads as bare. A kind the
/// switch does not list reaches its default arm, `neverAsAny(binding)`,
/// which hands the (truthy) binding back.
pub fn is_one_record(binding: &Binding) -> bool {
    match binding {
        Binding::Handle(_) | Binding::Extracted { .. } | Binding::Landed(_) | Binding::Node(_) | Binding::Callback(_) | Binding::ShapePosition(_) | Binding::Resource(_) => true,
        Binding::Event | Binding::Instance(_) | Binding::Positions(_) | Binding::Value(_) | Binding::Shape(_) | Binding::Movement(_) | Binding::LazyWalk(_)
        | Binding::Plugin(_) | Binding::Opaque | Binding::Tuple(_) | Binding::Closure(_) => false,
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
        (Binding::Callback(callback), "callbackId") => Ok(callback.callback_id.clone()),
        (Binding::Callback(callback), "url") => Ok(callback.url.clone()),
        (Binding::Callback(callback), "params") => Ok(callback.params.clone()),
        (Binding::ShapePosition(position), "shape") => Ok(position.shape.clone()),
        (Binding::ShapePosition(position), "node") => Ok(position.node.clone()),
        (Binding::ShapePosition(position), "fields") => Ok(position.fields.clone()),
        (Binding::ShapePosition(position), "fieldProvenance") => Ok(position.field_provenance.clone()),
        (Binding::Resource(resource), "resource") => Ok((**resource).clone()),
        (Binding::Value(value), "value") => Ok(value.value.clone()),
        (Binding::Value(value), "many") if value.many => Ok(Js::Bool(true)),
        (Binding::Value(_), "provenance") => internal("provenance"),
        (Binding::Handle(handle), "targetType") => Ok(Js::str(handle.target_type.clone())),
        (Binding::Handle(handle), "handle") => Ok(handle.record().object.clone()),
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
        (Some(a), Some(b)) => same_record(a, b),
        _ => false,
    };
    Ok(Some(if op == FilterOperator::Eq { same } else { !same }))
}

/// `sameRecord`: one binding object, or two reads of one stored record (its
/// address).
fn same_record(a: &Binding, b: &Binding) -> bool {
    if a.is(b) {
        return true;
    }
    let Some(first) = address(a) else { return false };
    address(b).is_some_and(|other| other == first)
}

/// `recordAddress`: a stable record's `adapterType:recordType:recordId`, a
/// handle's `adapterType:externalId`; none for a record the run built.
fn address(binding: &Binding) -> Option<String> {
    let text = |value: Js| value.to_js_string();
    match binding {
        Binding::Landed(landed) => {
            let position = &landed.position;
            let identity = crate::unique::get(position, "identity");
            if !matches!(crate::unique::get(&identity, "kind"), Js::String(kind) if kind == "stable") {
                return None;
            }
            Some(format!(
                "{}:{}:{}",
                text(crate::unique::get(position, "adapterType")),
                text(crate::unique::get(position, "recordType")),
                text(crate::unique::get(&identity, "recordId"))
            ))
        }
        // A snapshot (`-[:@old]->`) is a record as it once stood, not a
        // live position: equal only to itself.
        Binding::Handle(handle) => {
            let record = handle.record();
            if matches!(record.get("snapshot"), Js::Bool(true)) {
                return None;
            }
            Some(format!("{}:{}", text(record.get("adapterType")), text(record.get("externalId"))))
        }
        _ => None,
    }
}

/// `value[key]` as JavaScript reads it: the TypeError it throws off
/// nothing.
pub fn get(value: &Js, key: &str) -> Result<Js, EvalError> {
    match value {
        Js::Undefined | Js::Null => Err(type_error(&format!("Cannot read properties of {} (reading '{key}')", value.to_js_string()))),
        Js::Object(object) => Ok(js::object_property(object, key)),
        // A file's members, as a property of the TypeScript's file object.
        Js::File(file) => Ok(js::plain_property(&file.display, key)),
        Js::Record(record) => match own_property(record, key)? {
            Js::Null if !matches!(key, "kind") => Ok(Js::Undefined),
            found => Ok(found),
        },
        Js::Array(list) if key == "length" => Ok(Js::Number(list.items().len() as f64)),
        Js::Array(list) => Ok(key.parse::<usize>().ok().and_then(|i| list.items().get(i).cloned()).unwrap_or(Js::Undefined)),
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
            let record = handle.record();
            let written = record.get("writtenValues");
            if let Js::Object(written) = &written {
                for (key, value) in written.entries() {
                    fields.set(key.clone(), value.clone());
                }
            }
            // `omitKeys({...foundData, ...resultData}, writtenValues)`: a key
            // `in` the written values (their prototype's names too) is the
            // written one.
            let mut data = JsObject::new();
            for bag in ["foundData", "resultData"] {
                spread(&mut data, &record.get(bag));
            }
            for (key, value) in data.entries() {
                let written_key = matches!(&written, Js::Object(w) if w.get(key).is_some()) || js::is_object_prototype_name(key);
                if !written_key {
                    fields.set(key.clone(), value.clone());
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
        Binding::Positions(_)
        | Binding::LazyWalk(_)
        | Binding::Instance(_)
        | Binding::Shape(_)
        | Binding::Movement(_)
        | Binding::Plugin(_)
        | Binding::Opaque
        | Binding::Tuple(_)
        | Binding::Closure(_) => {
            return Err(unsupported(&format!("reading every field of {}", describe(binding)), None));
        }
        Binding::Callback(callback) => {
            fields.set("id".into(), callback.callback_id.clone());
            fields.set("url".into(), callback.url.clone());
        }
        Binding::ShapePosition(position) => spread(&mut fields, &position.fields),
        Binding::Resource(resource) => spread(&mut fields, &get(resource, "data").unwrap_or(Js::Undefined)),
    }
    Ok(fields)
}

/// `{...value}` of an object, into `fields`.
fn spread(fields: &mut JsObject, value: &Js) {
    if let Js::Object(source) = value {
        for (key, item) in source.entries() {
            fields.set(key.clone(), item.clone());
        }
    }
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
    // `plainValueOf` recurses through a list that holds itself until V8's
    // stack runs out.
    if js::holds_itself(value) {
        let thrown = js::stack_overflow();
        return Err(EvalError::Thrown { class: ErrorClass::RangeError, message: thrown.message });
    }
    plain_value(value, &mut Vec::new())
}

fn plain_value(value: &Js, path: &mut Vec<Binding>) -> Result<Js, EvalError> {
    if let Some(record) = binding_of(value) {
        return plain_record(&record, path);
    }
    match value {
        Js::Array(list) => Ok(Js::array(list.items().iter().map(|item| plain_value(item, path)).collect::<Result<_, _>>()?)),
        // `isDictValue`: an object a prototype was assigned to is handed on
        // as it is.
        Js::Object(dict) if dict.proto.is_none() => {
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
    if path.iter().any(|seen| seen.is(binding)) {
        return Err(unsupported("writing out a record that contains itself through its edges", None));
    }
    path.push(binding.clone());
    let plain = plain_record_within(binding, path);
    path.pop();
    plain
}

fn plain_record_within(binding: &Binding, path: &mut Vec<Binding>) -> Result<Js, EvalError> {
    match binding {
        Binding::Positions(landings) => return Ok(Js::array(landings.iter().map(|l| plain_record(l, path)).collect::<Result<_, _>>()?)),
        Binding::Value(value) => return plain_value(&value.value, path),
        _ => {}
    }
    // `plain[field] = …`: assigned, as `plainRecordOf` does.
    let mut plain = JsObject::new();
    for (field, member) in fields_of(binding)?.entries() {
        plain.assign(field.clone(), plain_value(member, path)?);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A dict is data whatever its `kind` says: a binding kind, an
    /// `Object.prototype` name, anything.
    #[test]
    fn a_dict_is_never_a_record_whatever_its_kind() {
        let with_kind = |kind: &str| {
            let mut o = JsObject::new();
            o.set("kind".into(), Js::str(kind));
            Js::object(o)
        };
        for kind in ["event", "handle", "lazyWalk", "callback", "closure", "positions", "toString", "constructor", "__proto__", "nope"] {
            assert!(binding_of(&with_kind(kind)).is_none(), "{kind}");
        }
        assert!(binding_of(&held(Binding::Event)).is_some());
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
