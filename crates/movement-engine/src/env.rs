//! The value bindings an expression reads, in scopes with a parent chain,
//! and the wire they cross the boundary on.
//!
//! The wire carries JavaScript values exactly: JSON's own scalars stand for
//! themselves, and everything JSON cannot say is a tagged array —
//! `["u"]` undefined, `["n", "NaN" | "Infinity" | "-Infinity" | "-0"]`, a
//! string holding a lone surrogate `["s16", [units…]]` (its UTF-16 code
//! units; an object's key too, in the key's place), a list `["l", id, [items…]]`, an object `["o", id, [[key, value]…]]` (its
//! keys in the object's own order), `["r", id]` the same list or object
//! again. On the way back `["i", id]` is one of the caller's own objects,
//! handed back as itself. Identity has to cross because `===` compares
//! objects by it.
//!
//! A value is either data or an engine object (a record), and the two
//! never share a form: every tag above is data, whatever keys an object
//! carries. A record whose binding object is data (the event, a callback,
//! a shape position, a resource) crosses to the host as `["x", id,
//! descriptor]`, numbered on the segment's wire, and the host hands it
//! back as `["x", id]`; any other record crosses as `["x", kind]`, which
//! the host refuses. Nothing the host sends but `["x", id]` decodes to a
//! record.
//!
//! Provenance crosses as ids: the caller numbers the origins its bindings
//! carry (`0..origins`), and any id from `origins` up is a literal origin
//! the evaluation minted, one per literal evaluated.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use serde_json::{Map, Value as Json, json};

use crate::js::{Js, JsArray, JsObject};

/// A binding's trail: every origin id that fed it, and the one it arrived
/// from untransformed, when it did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Trail {
    pub origins: Vec<u32>,
    pub direct: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct ValueBinding {
    pub value: Js,
    /// `None` is a binding declared with no trail (the TypeScript's
    /// `provenance ?? NO_PROVENANCE`).
    pub trail: Option<Trail>,
    /// A walk read for a field: a spread reads it as its members.
    pub many: bool,
}

/// One scope of value bindings and the scope it sits in.
#[derive(Debug, Default)]
pub struct Env {
    bindings: HashMap<String, ValueBinding>,
    parent: Option<Rc<Env>>,
}

impl Env {
    pub fn new() -> Env {
        Env::default()
    }

    pub fn child(parent: Rc<Env>) -> Env {
        Env { bindings: HashMap::new(), parent: Some(parent) }
    }

    pub fn declare(&mut self, name: impl Into<String>, binding: ValueBinding) {
        self.bindings.insert(name.into(), binding);
    }

    pub fn resolve(&self, name: &str) -> Option<&ValueBinding> {
        self.bindings.get(name).or_else(|| self.parent.as_deref().and_then(|p| p.resolve(name)))
    }
}

/// What `eval_expression` reads beside the expression.
pub struct Envelope {
    pub env: Env,
    /// How many origin ids the caller assigned.
    pub origins: u32,
    /// The movement's pin. Required: the engine knows no release, so it has
    /// no version of its own to fall back to.
    pub language_version: u32,
    /// The run's pinned instant, in milliseconds (`now`, a `toISOString`
    /// text on the wire): what `DATE.TODAY` reads.
    pub now: Option<f64>,
    /// The zone a date-time text with no offset is read in (`localZone`, an
    /// IANA name): the caller's process's local zone, as V8 reads it there.
    /// Absent: UTC.
    pub local_zone: Option<String>,
}

pub fn read_envelope(text: &str) -> Result<Envelope, String> {
    let json: Json = crate::js_string::from_json_text(text).map_err(|e| format!("the bindings are not JSON: {e}"))?;
    let mut decoder = Decoder::default();
    let mut env = Env::new();
    for (name, binding) in json.get("bindings").and_then(Json::as_object).ok_or("the envelope has no `bindings`")? {
        let value = decoder.value(binding.get("value").ok_or_else(|| format!("binding `{name}` has no value"))?)?;
        let trail = binding.get("provenance").map(read_trail).transpose()?;
        let many = binding.get("many").and_then(Json::as_bool).unwrap_or(false);
        env.declare(name.clone(), ValueBinding { value, trail, many });
    }
    let origins = json.get("origins").and_then(Json::as_u64).unwrap_or(0) as u32;
    let language_version = match json.get("languageVersion") {
        Some(version) => version.as_u64().map(|v| v as u32).ok_or_else(|| format!("the language version is a number, not {version}"))?,
        None => return Err("the envelope has no `languageVersion`: an expression is evaluated under its movement's pin, which the caller passes".into()),
    };
    let now = match json.get("now") {
        None => None,
        Some(Json::String(iso)) => match crate::js_date::parse(iso, crate::js_date::LocalZone::UTC) {
            Some(ms) => Some(ms),
            None => return Err(format!("the pinned instant {iso:?} is not a toISOString text")),
        },
        Some(other) => return Err(format!("the pinned instant is a text, not {other}")),
    };
    let local_zone = match json.get("localZone") {
        None => None,
        Some(Json::String(zone)) => Some(zone.clone()),
        Some(other) => return Err(format!("the local zone is a text, not {other}")),
    };
    Ok(Envelope { env, origins, language_version, now, local_zone })
}

fn read_trail(json: &Json) -> Result<Trail, String> {
    let id = |v: &Json| v.as_u64().map(|n| n as u32).ok_or_else(|| format!("an origin id is a number, not {v}"));
    let origins = json.get("origins").and_then(Json::as_array).ok_or("a trail has `origins`")?;
    Ok(Trail {
        origins: origins.iter().map(id).collect::<Result<_, _>>()?,
        direct: json.get("direct").map(id).transpose()?,
    })
}

/// `Object.is`, over what a member decoded to (members the host sent again
/// already decoded as the objects held).
fn identical(a: &Js, b: &Js) -> bool {
    match (a, b) {
        (Js::Number(x), Js::Number(y)) => x.to_bits() == y.to_bits() || (x.is_nan() && y.is_nan()),
        _ => crate::js::strict_equals(a, b),
    }
}

#[derive(Default)]
struct Decoder<'h> {
    seen: HashMap<u64, Js>,
    /// What the host sent before, by id: an object it sends again, as it
    /// was, decodes as the very object held (`===` itself, as the one
    /// object the host handed the TypeScript engine twice is).
    held: Option<&'h HashMap<u64, Js>>,
    /// The records this segment handed the host, by the id each crossed
    /// under: `["x", id]` is one of them, handed back as itself.
    records: Option<&'h [Rc<crate::bindings::Binding>]>,
}

impl Decoder<'_> {
    /// The object or list the host sent under `id` before, when `fresh` is
    /// still what it was.
    fn again(&self, id: u64, fresh: &Js) -> Option<Js> {
        let held = self.held?.get(&id)?;
        let same = match (held, fresh) {
            (Js::Array(was), Js::Array(now)) => {
                let (was, now) = (was.items(), now.items());
                was.len() == now.len() && was.iter().zip(now.iter()).all(|(a, b)| identical(a, b))
            }
            (Js::Object(was), Js::Object(now)) => {
                was.proto.is_none()
                    && was.entries().len() == now.entries().len()
                    && was.entries().iter().zip(now.entries()).all(|((k, a), (l, b))| k == l && identical(a, b))
            }
            _ => false,
        };
        same.then(|| held.clone())
    }

    fn value(&mut self, json: &Json) -> Result<Js, String> {
        Ok(match json {
            Json::Null => Js::Null,
            Json::Bool(b) => Js::Bool(*b),
            Json::Number(n) => Js::Number(n.as_f64().ok_or("a number the wire cannot read")?),
            Json::String(s) => Js::str(s.clone()),
            Json::Array(tagged) if tagged.first().and_then(Json::as_str) == Some("s16") => Js::String(text_of_wire(json)?),
            Json::Array(tagged) => {
                let tag = tagged.first().and_then(Json::as_str).ok_or_else(|| format!("an untagged wire array: {json}"))?;
                let id = || tagged.get(1).and_then(Json::as_u64).ok_or_else(|| format!("a wire `{tag}` without an id"));
                match tag {
                    "u" => Js::Undefined,
                    "n" => Js::Number(match tagged.get(1).and_then(Json::as_str) {
                        Some("NaN") => f64::NAN,
                        Some("Infinity") => f64::INFINITY,
                        Some("-Infinity") => f64::NEG_INFINITY,
                        Some("-0") => -0.0,
                        _ => return Err(format!("an unknown special number: {json}")),
                    }),
                    "l" => {
                        let id = id()?;
                        let items = tagged.get(2).and_then(Json::as_array).ok_or("a wire list without items")?;
                        let items = items.iter().map(|item| self.value(item)).collect::<Result<_, _>>()?;
                        let mut array = JsArray::new(items);
                        array.origin = Some(id as u32);
                        let value = Js::Array(Rc::new(array));
                        let value = self.again(id, &value).unwrap_or(value);
                        self.seen.insert(id, value.clone());
                        value
                    }
                    "o" => {
                        let id = id()?;
                        let entries = tagged.get(2).and_then(Json::as_array).ok_or("a wire object without entries")?;
                        let mut object = JsObject::new();
                        for entry in entries {
                            let (Some(key), Some(value)) = (entry.get(0).and_then(|key| text_of_wire(key).ok()), entry.get(1)) else {
                                return Err(format!("a wire entry is [key, value]: {entry}"));
                            };
                            object.set(key.into_string(), self.value(value)?);
                        }
                        object.origin = Some(id as u32);
                        let value = Js::object(object);
                        let value = self.again(id, &value).unwrap_or(value);
                        self.seen.insert(id, value.clone());
                        value
                    }
                    "r" => self.seen.get(&id()?).cloned().ok_or("a wire reference to nothing seen")?,
                    "f" => match tagged.get(1).and_then(Json::as_str) {
                        Some("Object") => Js::Function(crate::js::NativeFunction("Object")),
                        Some(name) => match crate::js::OBJECT_PROTOTYPE_NAMES
                            .iter()
                            .find(|n| **n == name && !matches!(name, "constructor" | "__proto__"))
                            .or_else(|| crate::js::ARRAY_PROTOTYPE_NAMES.iter().find(|n| **n == name))
                        {
                            Some(name) => Js::Function(crate::js::NativeFunction(name)),
                            None => return Err(format!("the wire names no built-in: {json}")),
                        },
                        None => return Err(format!("a built-in without its name: {json}")),
                    },
                    "p" => crate::js::object_prototype(),
                    // A file the host hands the engine as one (a render's
                    // answer): its descriptor, made a file by the tag.
                    "F" => {
                        let id = id()? as u32;
                        let Some(Json::Object(shown)) = tagged.get(2) else { return Err(format!("a wire file without its display: {json}")) };
                        let handle = match shown.get("handle") {
                            None | Some(Json::Null) => None,
                            Some(handle) => Some(text_of_wire(handle).map_err(|_| format!("a wire file's handle is text: {json}"))?.into_string()),
                        };
                        let mut display = JsObject::new();
                        for key in ["name", "contentType", "size"] {
                            match shown.get(key) {
                                None | Some(Json::Null) => {}
                                Some(text @ (Json::String(_) | Json::Array(_))) if key != "size" => {
                                    display.set(key.into(), Js::String(text_of_wire(text).map_err(|_| format!("a wire file's {key} is text: {json}"))?));
                                }
                                Some(Json::Number(n)) if key == "size" => display.set(key.into(), Js::Number(n.as_f64().unwrap_or(f64::NAN))),
                                Some(_) => return Err(format!("a wire file's {key} is not one: {json}")),
                            }
                        }
                        if let Some(handle) = &handle {
                            display.set("handle".into(), Js::str(handle.clone()));
                        }
                        Js::File(Rc::new(crate::file::FileHandle { id, handle, display }))
                    }
                    "x" => {
                        let record = self.records.and_then(|records| records.get(usize::try_from(id().ok()?).ok()?).cloned());
                        Js::Record(record.ok_or_else(|| format!("a record the engine never handed out: {json}"))?)
                    }
                    _ => return Err(format!("an unknown wire tag: {json}")),
                }
            }
            Json::Object(_) => return Err(format!("a bare object on the wire: {json}")),
        })
    }
}

/// A text on the wire: itself, or `["s16", [units…]]` when it holds a lone
/// surrogate.
fn text_of_wire(json: &Json) -> Result<crate::js::JsString, String> {
    match json {
        Json::String(text) => Ok(crate::js::JsString::from(text.as_str())),
        Json::Array(tagged) if tagged.first().and_then(Json::as_str) == Some("s16") => {
            let units = tagged.get(1).and_then(Json::as_array).ok_or_else(|| format!("a wire `s16` without its units: {json}"))?;
            let units = units
                .iter()
                .map(|unit| unit.as_u64().and_then(|u| u16::try_from(u).ok()).ok_or_else(|| format!("a wire `s16` unit is a UTF-16 code unit: {json}")))
                .collect::<Result<Vec<u16>, _>>()?;
            Ok(crate::js::JsString::from_units(&units))
        }
        _ => Err(format!("a wire text is a string or `[\"s16\", units]`: {json}")),
    }
}

/// A text for the wire: itself, or its code units tagged `s16` when it
/// holds a lone surrogate (JSON text carries one only as an escape a JSON
/// reader may refuse).
fn wire_text(text: &str) -> Json {
    if crate::js_string::is_well_formed(text) {
        return json!(text);
    }
    json!(["s16", crate::js_string::units_vec(text)])
}

/// One value off the wire, on its own.
pub fn decode(json: &Json) -> Result<Js, String> {
    Decoder::default().value(json)
}

/// A value for the wire back: the caller's own objects by id, the
/// evaluation's new ones written out once each.
pub fn encode(value: &Js) -> Json {
    let mut encoder = Encoder::default();
    encoder.value(value)
}

/// A value written out whole, the caller's own objects included (their
/// order and identity within the value still cross).
pub fn encode_plain(value: &Js) -> Json {
    let mut encoder = Encoder { plain: true, ..Encoder::default() };
    encoder.value(value)
}

/// A segment's wire with its host (rust_wire.ts's one `WireOut` per
/// segment): every object or list the host sent — in the input's event and
/// in its answers — by the id the wire gave it. Each value arrives whole (a
/// back-reference only within it), so answers decode in whatever order the
/// engine reads them and an object re-sent after a mutation reads as it now
/// is; one re-sent unchanged, under the id it was first sent under, decodes
/// as the very object held. Answers are data, as the event is, whatever keys
/// they carry: only `["x", id]` names a record (one this wire handed out). A
/// request hands a sent one back as itself (`["i", id]`), so an object
/// an adapter answered reaches the next host call as that very object, as it
/// does in the TypeScript engine; anything this engine built is written out.
#[derive(Default)]
pub struct Wire {
    sent: RefCell<HashMap<u64, Js>>,
    /// The records handed the host, numbered as first handed.
    records: RefCell<Vec<Rc<crate::bindings::Binding>>>,
}

/// A value bound for a request held a record (of this kind), which the
/// TypeScript engine would hand its host as the binding object itself and
/// this wire carries as no value the host could use: the request is never
/// made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldRecord(pub String);

impl Wire {
    /// A value the host sent.
    pub fn decode(&self, json: &Json) -> Result<Js, String> {
        let (value, seen) = {
            let held = self.sent.borrow();
            let records = self.records.borrow();
            let mut decoder = Decoder { held: Some(&held), records: Some(&records), ..Decoder::default() };
            (decoder.value(json)?, decoder.seen)
        };
        self.sent.borrow_mut().extend(seen);
        Ok(value)
    }

    /// A value for a host request, or the record it holds.
    pub fn encode(&self, value: &Js) -> Result<Json, HeldRecord> {
        let sent = self.sent.borrow();
        let mut records = self.records.borrow_mut();
        let mut encoder = Encoder { plain: true, sent: Some(&sent), records: Some(&mut records), ..Encoder::default() };
        let json = encoder.value(value);
        match encoder.record {
            Some(kind) => Err(HeldRecord(kind)),
            None => Ok(json),
        }
    }

    /// A value for the run's result, which holds no record (the writes, the
    /// extraction sites); one that did would cross as `["x", kind]`, which
    /// the shim refuses.
    pub fn encode_result(&self, value: &Js) -> Json {
        let sent = self.sent.borrow();
        let mut records = self.records.borrow_mut();
        Encoder { plain: true, sent: Some(&sent), records: Some(&mut records), ..Encoder::default() }.value(value)
    }
}

#[derive(Default)]
struct Encoder<'w> {
    written: HashMap<usize, u64>,
    plain: bool,
    /// What the host sent this segment: one of those, unchanged, crosses
    /// back as itself.
    sent: Option<&'w HashMap<u64, Js>>,
    /// A record met while writing, by its kind.
    record: Option<String>,
    /// The records handed out so far (the segment's, or this value's own).
    records: Option<&'w mut Vec<Rc<crate::bindings::Binding>>>,
    own_records: Vec<Rc<crate::bindings::Binding>>,
}

impl Encoder<'_> {
    /// The id the host gave `value`, when it is that very object or list.
    fn sent_as(&self, value: &Js) -> Option<u32> {
        let sent = self.sent?;
        let origin = match value {
            Js::Object(object) => object.origin?,
            Js::Array(array) => array.origin?,
            _ => return None,
        };
        let same = match (sent.get(&u64::from(origin))?, value) {
            (Js::Object(held), Js::Object(object)) => Rc::ptr_eq(held, object),
            (Js::Array(held), Js::Array(array)) => Rc::ptr_eq(held, array),
            _ => false,
        };
        same.then_some(origin)
    }

    fn value(&mut self, value: &Js) -> Json {
        match value {
            Js::Undefined => json!(["u"]),
            Js::Null => Json::Null,
            Js::Bool(b) => json!(b),
            Js::Number(n) if n.is_nan() => json!(["n", "NaN"]),
            Js::Number(n) if n.is_infinite() => json!(["n", if *n > 0.0 { "Infinity" } else { "-Infinity" }]),
            Js::Number(n) if *n == 0.0 && n.is_sign_negative() => json!(["n", "-0"]),
            Js::Number(n) => json!(n),
            Js::String(s) => wire_text(s),
            // The built-in itself, which the host names back (`Object`, or
            // `Object.prototype[name]`).
            Js::Function(function) => json!(["f", function.0]),
            Js::Object(object) if crate::js::is_object_prototype(object) => json!(["p"]),
            // The event and a callback, the records the shim rebuilds, cross
            // tagged, by their number, with their data for the host to build
            // them from; any other never crosses: a request holding one is
            // never made (`HeldRecord`, which names it), and the shim refuses
            // its tag in a result.
            Js::Record(record) => match (record.as_ref(), crate::record::data_object(record)) {
                (crate::bindings::Binding::Event | crate::bindings::Binding::Callback(_), Some(descriptor)) => {
                    let records = match self.records.as_deref_mut() {
                        Some(records) => records,
                        None => &mut self.own_records,
                    };
                    let id = match records.iter().position(|held| Rc::ptr_eq(held, record)) {
                        Some(id) => id,
                        None => {
                            records.push(record.clone());
                            records.len() - 1
                        }
                    };
                    json!(["x", id, self.value(&descriptor)])
                }
                _ => {
                    let kind = crate::record::kind_of(record);
                    self.record.get_or_insert(kind.clone());
                    json!(["x", kind])
                }
            },
            // A file the engine holds crosses tagged: the tag, never its
            // descriptor's keys, is what makes it a file on the host.
            Js::File(file) => json!(["F", file.id]),
            Js::Array(_) | Js::Object(_) if self.sent_as(value).is_some() => json!(["i", self.sent_as(value)]),
            Js::Array(array) => match array.origin.filter(|_| !self.plain) {
                Some(id) => json!(["i", id]),
                None => self.shared(Rc::as_ptr(array) as usize, |this| {
                    json!(array.items().iter().map(|item| this.value(item)).collect::<Vec<_>>())
                }, "l"),
            },
            Js::Object(object) => match object.origin.filter(|_| !self.plain) {
                Some(id) => json!(["i", id]),
                None => {
                    let mut written = self.shared(Rc::as_ptr(object) as usize, |this| {
                        json!(object.entries().iter().map(|(k, v)| json!([wire_text(k), this.value(v)])).collect::<Vec<_>>())
                    }, "o");
                    // A prototype a filing gave it, which the host's object
                    // is given too: `["o", id, entries, prototype]`.
                    if let (Some(proto), Some(items)) = (&object.proto, written.as_array_mut())
                        && items.first() == Some(&json!("o"))
                    {
                        let proto = self.value(proto);
                        items.push(proto);
                    }
                    written
                }
            },
        }
    }

    fn shared(&mut self, address: usize, body: impl FnOnce(&mut Encoder) -> Json, tag: &str) -> Json {
        if let Some(id) = self.written.get(&address) {
            return json!(["r", id]);
        }
        let id = self.written.len() as u64;
        self.written.insert(address, id);
        json!([tag, id, body(self)])
    }
}

// ── Plain JSON ──

/// An object with these entries, in this order (JavaScript's key order).
pub fn object_of(entries: Vec<(&str, Js)>) -> Js {
    let mut object = JsObject::new();
    for (key, value) in entries {
        object.set(key.to_string(), value);
    }
    Js::object(object)
}

/// `JSON.parse(JSON.stringify(value))`, keys kept in their order:
/// `undefined` members dropped (null in a list), non-finite numbers null,
/// `-0` 0. `undefined` itself stays `undefined`.
pub fn json_round_trip(value: &Js) -> Js {
    if crate::js::holds_itself(value) {
        return json_round_trip(&crate::js::acyclic(value));
    }
    match value {
        Js::Number(n) if !n.is_finite() => Js::Null,
        Js::Number(n) if *n == 0.0 => Js::Number(0.0),
        // `JSON.stringify` writes a function nowhere: null in a list, no key
        // in an object, and `undefined` alone.
        Js::Function(_) => Js::Undefined,
        Js::Array(list) => Js::array(
            list.items().iter().map(|item| if matches!(item, Js::Undefined | Js::Function(_)) { Js::Null } else { json_round_trip(item) }).collect(),
        ),
        Js::Object(object) => {
            let mut copy = JsObject::new();
            for (k, v) in object.entries() {
                if !matches!(v, Js::Undefined | Js::Function(_)) {
                    copy.set(k.clone(), json_round_trip(v));
                }
            }
            Js::object(copy)
        }
        Js::File(file) => json_round_trip(&crate::file::display(file)),
        // The binding object's JSON, where this engine writes it as the
        // TypeScript does (`try_json_stringify` names the rest).
        Js::Record(record) => match (crate::record::data_object(record), record.as_ref()) {
            (Some(data), _) => json_round_trip(&data),
            (None, crate::bindings::Binding::Positions(landings)) => object_of(vec![
                ("kind", Js::str("positions")),
                ("landings", json_round_trip(&Js::array(landings.iter().cloned().map(crate::record::held).collect()))),
            ]),
            (None, _) => Js::object(JsObject::new()),
        },
        other => other.clone(),
    }
}

/// A value as `JSON.parse(JSON.stringify(value))` hands it back: `undefined`
/// members dropped (null in a list), non-finite numbers null, `-0` 0.
pub fn json_of_js(value: &Js) -> Json {
    if crate::js::holds_itself(value) {
        return json_of_js(&crate::js::acyclic(value));
    }
    json_of_tree(value)
}

fn json_of_tree(value: &Js) -> Json {
    match value {
        Js::Undefined | Js::Null | Js::Function(_) => Json::Null,
        // A callback's, a shape position's or a resource's binding object
        // is data, written as it is; any other record is read down to its
        // fields wherever one is written out.
        Js::Record(record) => match (record.as_ref(), crate::record::data_object(record)) {
            (crate::bindings::Binding::Event, _) | (_, None) => Json::Object(Map::new()),
            (_, Some(data)) => json_of_tree(&data),
        },
        Js::File(file) => json_of_tree(&crate::file::display(file)),
        Js::Bool(b) => json!(b),
        Js::Number(n) if !n.is_finite() => Json::Null,
        Js::Number(n) if *n == 0.0 => json!(0),
        Js::Number(n) if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 => json!(*n as i64),
        Js::Number(n) => json!(n),
        Js::String(s) => json!(s),
        Js::Array(list) => Json::Array(list.items().iter().map(json_of_tree).collect()),
        Js::Object(object) => {
            let mut map = Map::new();
            for (k, v) in object.entries() {
                if !matches!(v, Js::Undefined | Js::Function(_)) {
                    map.insert(k.clone(), json_of_tree(v));
                }
            }
            Json::Object(map)
        }
    }
}

/// Plain JSON as a value.
pub fn js_of_json(json: &Json) -> Js {
    match json {
        Json::Null => Js::Null,
        Json::Bool(b) => Js::Bool(*b),
        Json::Number(n) => Js::Number(n.as_f64().unwrap_or(f64::NAN)),
        Json::String(s) => Js::str(s.clone()),
        Json::Array(items) => Js::array(items.iter().map(js_of_json).collect()),
        Json::Object(map) => {
            let mut object = JsObject::new();
            for (k, v) in map {
                object.set(k.clone(), js_of_json(v));
            }
            Js::object(object)
        }
    }
}

/// A serialized value read as the JavaScript object `JSON.parse` makes of
/// its text: keys in the order written (serde_json's own map sorts them).
pub fn js_of_serialized<T: serde::Serialize>(value: &T) -> Js {
    let text = serde_json::to_string(value).expect("the value serializes");
    let mut deserializer = serde_json::Deserializer::from_str(&text);
    serde::Deserializer::deserialize_any(&mut deserializer, InOrder).expect("serde_json reads back what it wrote")
}

/// `JSON.parse`'s reading, key order kept.
struct InOrder;

impl<'de> serde::de::Visitor<'de> for InOrder {
    type Value = Js;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("JSON")
    }
    fn visit_unit<E>(self) -> Result<Js, E> {
        Ok(Js::Null)
    }
    fn visit_bool<E>(self, v: bool) -> Result<Js, E> {
        Ok(Js::Bool(v))
    }
    fn visit_i64<E>(self, v: i64) -> Result<Js, E> {
        Ok(Js::Number(v as f64))
    }
    fn visit_u64<E>(self, v: u64) -> Result<Js, E> {
        Ok(Js::Number(v as f64))
    }
    fn visit_f64<E>(self, v: f64) -> Result<Js, E> {
        Ok(Js::Number(v))
    }
    fn visit_str<E>(self, v: &str) -> Result<Js, E> {
        Ok(Js::str(v))
    }
    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Js, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element_seed(InOrder)? {
            items.push(item);
        }
        Ok(Js::array(items))
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Js, A::Error> {
        let mut object = JsObject::new();
        while let Some(key) = map.next_key::<String>()? {
            object.set(key, map.next_value_seed(InOrder)?);
        }
        Ok(Js::object(object))
    }
}

impl<'de> serde::de::DeserializeSeed<'de> for InOrder {
    type Value = Js;

    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<Js, D::Error> {
        deserializer.deserialize_any(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_object_the_host_sends_again_unchanged_is_the_one_held() {
        let wire = Wire::default();
        let sent = json!(["o", 3, [["kind", "instance"], ["slug", ["l", 4, ["email"]]]]]);
        let (Js::Object(first), Js::Object(again)) = (wire.decode(&sent).unwrap(), wire.decode(&sent).unwrap()) else { panic!("objects") };
        assert!(Rc::ptr_eq(&first, &again));
        let changed = json!(["o", 3, [["kind", "instance"], ["slug", ["l", 4, ["attio"]]]]]);
        let Js::Object(now) = wire.decode(&changed).unwrap() else { panic!("an object") };
        assert!(!Rc::ptr_eq(&first, &now), "re-sent after a change, it reads as it now is");
    }
    use crate::js::strict_equals;

    #[test]
    fn a_record_fails_only_the_request_it_is_written_for() {
        let wire = Wire::default();
        let record = crate::record::held(crate::bindings::Binding::Positions(Vec::new()));
        // The run's result written with one (never asked) and a request
        // holding one refused: neither touches the next request.
        let _ = wire.encode_result(&Js::array(vec![record.clone()]));
        assert_eq!(wire.encode(&Js::array(vec![Js::String("a".into()), record])), Err(HeldRecord("positions".into())));
        assert_eq!(wire.encode(&Js::String("a".into())), Ok(json!("a")));
    }

    #[test]
    fn values_cross_as_their_json_round_trip() {
        let mut object = JsObject::new();
        object.set("a".into(), Js::Undefined);
        object.set("b".into(), Js::array(vec![Js::Undefined, Js::Number(f64::NAN), Js::Number(-0.0), Js::Number(1.5)]));
        assert_eq!(json_of_js(&Js::object(object)), json!({ "b": [null, null, 0, 1.5] }));
        assert!(matches!(js_of_json(&json!({ "x": [1, "y"] })), Js::Object(_)));
    }


    #[test]
    fn a_child_scope_shadows_and_falls_back() {
        let mut root = Env::new();
        root.declare("a", ValueBinding { value: Js::Number(1.0), trail: None, many: false });
        root.declare("b", ValueBinding { value: Js::Number(2.0), trail: None, many: false });
        let mut child = Env::child(Rc::new(root));
        child.declare("a", ValueBinding { value: Js::Number(3.0), trail: None, many: false });
        assert!(matches!(child.resolve("a").map(|b| &b.value), Some(Js::Number(3.0))));
        assert!(matches!(child.resolve("b").map(|b| &b.value), Some(Js::Number(2.0))));
        assert!(child.resolve("c").is_none());
    }

    #[test]
    fn the_wire_keeps_identity_special_numbers_and_key_order() {
        let envelope = read_envelope(
            r#"{"bindings":{
                "x":{"value":["o",0,[["b",["u"]],["a",["n","NaN"]]]],"provenance":{"origins":[0],"direct":0}},
                "y":{"value":["l",1,[["r",0],["n","-0"]]],"many":true}
            },"origins":1,"languageVersion":3}"#,
        )
        .unwrap();
        let x = &envelope.env.resolve("x").unwrap().value;
        let y = envelope.env.resolve("y").unwrap();
        let Js::Array(list) = &y.value else { panic!("y is a list") };
        assert!(strict_equals(&list.items()[0], x));
        assert!(y.many);
        assert_eq!(envelope.env.resolve("x").unwrap().trail, Some(Trail { origins: vec![0], direct: Some(0) }));
        assert_eq!(encode(x), json!(["i", 0]));
        let Js::Object(object) = x else { panic!("x is an object") };
        assert_eq!(object.entries().iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["b", "a"]);

        let fresh = Js::array(vec![]);
        let pair = Js::array(vec![fresh.clone(), fresh, Js::Number(-0.0), Js::Number(f64::INFINITY)]);
        assert_eq!(encode(&pair), json!(["l", 0, [["l", 1, []], ["r", 1], ["n", "-0"], ["n", "Infinity"]]]));
    }

    /// A host's own `__proto__` key (`JSON.parse` makes one) is an own
    /// entry: read as the key it is, never the prototype, and written back
    /// as one.
    #[test]
    fn an_own_proto_key_crosses_as_a_key() {
        let wire = Wire::default();
        let sent = json!(["o", 0, [["a", 1], ["__proto__", ["o", 1, [["x", 2]]]]]]);
        let Js::Object(object) = wire.decode(&sent).unwrap() else { panic!("an object") };
        assert!(object.proto.is_none());
        assert_eq!(object.entries().iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["a", "__proto__"]);
        assert!(matches!(crate::js::object_property(&object, "__proto__"), Js::Object(own) if own.get("x").is_some()));
        assert_eq!(encode_plain(&Js::Object(object.clone())), json!(["o", 0, [["a", 1.0], ["__proto__", ["o", 1, [["x", 2.0]]]]]]));
        assert_eq!(json_of_js(&Js::Object(object)), json!({ "a": 1, "__proto__": { "x": 2 } }));
    }

    /// A lone surrogate crosses tagged, in a value and in a key, both ways;
    /// a pair crosses as the text it is.
    #[test]
    fn a_lone_surrogate_crosses_as_its_code_units() {
        let wire = Wire::default();
        let sent = json!(["o", 0, [[["s16", [0xD83D]], ["s16", [0x61, 0xDE00]]], ["k", "😀"]]]);
        let Js::Object(object) = wire.decode(&sent).unwrap() else { panic!("an object") };
        let (key, value) = &object.entries()[0];
        assert_eq!(crate::js_string::units_vec(key), [0xD83D]);
        assert!(matches!(value, Js::String(text) if crate::js_string::units_vec(text) == [0x61, 0xDE00]));
        assert_eq!(encode_plain(&Js::Object(object.clone())), json!(["o", 0, [[["s16", [0xD83D]], ["s16", [0x61, 0xDE00]]], ["k", "😀"]]]));
        // Two halves on the wire, one after the other, are the pair.
        assert!(matches!(decode(&json!(["s16", [0xD83D, 0xDE00]])).unwrap(), Js::String(text) if text == "😀"));
    }

    #[test]
    fn a_segment_reads_each_answer_whole_in_any_order() {
        let wire = Wire::default();
        // The same host object sent twice, mutated between: two ids, each
        // read as it was when sent; the later one decoded first.
        let later = wire.decode(&json!(["o", 1, [["n", 2], ["self", ["o", 2, [["k", ["l", 3, []]], ["again", ["r", 3]]]]]]])).unwrap();
        let earlier = wire.decode(&json!(["o", 0, [["n", 1]]])).unwrap();
        let n = |value: &Js| match value {
            Js::Object(object) => object.get("n").cloned(),
            _ => None,
        };
        assert!(matches!(n(&later), Some(Js::Number(2.0))));
        assert!(matches!(n(&earlier), Some(Js::Number(1.0))));
        assert_eq!(wire.encode(&later), Ok(json!(["i", 1])));
        assert_eq!(wire.encode(&earlier), Ok(json!(["i", 0])));
        assert!(wire.decode(&json!(["r", 0])).is_err());
    }
}
