//! The value bindings an expression reads, in scopes with a parent chain,
//! and the wire they cross the boundary on.
//!
//! The wire carries JavaScript values exactly: JSON's own scalars stand for
//! themselves, and everything JSON cannot say is a tagged array —
//! `["u"]` undefined, `["n", "NaN" | "Infinity" | "-Infinity" | "-0"]`, a
//! list `["l", id, [items…]]`, an object `["o", id, [[key, value]…]]` (its
//! keys in the object's own order), `["r", id]` the same list or object
//! again. On the way back `["i", id]` is one of the caller's own objects,
//! handed back as itself. Identity has to cross because `===` compares
//! objects by it.
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
}

pub fn read_envelope(text: &str) -> Result<Envelope, String> {
    let json: Json = serde_json::from_str(text).map_err(|e| format!("the bindings are not JSON: {e}"))?;
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
        Some(Json::String(iso)) => match crate::js_date::parse(iso) {
            crate::js_date::Parsed::Valid(ms) => Some(ms),
            _ => return Err(format!("the pinned instant {iso:?} is not a toISOString text")),
        },
        Some(other) => return Err(format!("the pinned instant is a text, not {other}")),
    };
    Ok(Envelope { env, origins, language_version, now })
}

fn read_trail(json: &Json) -> Result<Trail, String> {
    let id = |v: &Json| v.as_u64().map(|n| n as u32).ok_or_else(|| format!("an origin id is a number, not {v}"));
    let origins = json.get("origins").and_then(Json::as_array).ok_or("a trail has `origins`")?;
    Ok(Trail {
        origins: origins.iter().map(id).collect::<Result<_, _>>()?,
        direct: json.get("direct").map(id).transpose()?,
    })
}

#[derive(Default)]
struct Decoder {
    seen: HashMap<u64, Js>,
}

impl Decoder {
    fn value(&mut self, json: &Json) -> Result<Js, String> {
        Ok(match json {
            Json::Null => Js::Null,
            Json::Bool(b) => Js::Bool(*b),
            Json::Number(n) => Js::Number(n.as_f64().ok_or("a number the wire cannot read")?),
            Json::String(s) => Js::String(s.clone()),
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
                        self.seen.insert(id, value.clone());
                        value
                    }
                    "o" => {
                        let id = id()?;
                        let entries = tagged.get(2).and_then(Json::as_array).ok_or("a wire object without entries")?;
                        let mut object = JsObject::new();
                        for entry in entries {
                            let (Some(key), Some(value)) = (entry.get(0).and_then(Json::as_str), entry.get(1)) else {
                                return Err(format!("a wire entry is [key, value]: {entry}"));
                            };
                            object.set(key.to_string(), self.value(value)?);
                        }
                        object.origin = Some(id as u32);
                        let value = Js::object(object);
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
                    _ => return Err(format!("an unknown wire tag: {json}")),
                }
            }
            Json::Object(_) => return Err(format!("a bare object on the wire: {json}")),
        })
    }
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
/// is. A request hands a sent one back as itself (`["i", id]`), so an object
/// an adapter answered reaches the next host call as that very object, as it
/// does in the TypeScript engine; anything this engine built is written out.
#[derive(Default)]
pub struct Wire {
    sent: RefCell<HashMap<u64, Js>>,
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
        let mut decoder = Decoder::default();
        let value = decoder.value(json)?;
        self.sent.borrow_mut().extend(decoder.seen);
        Ok(value)
    }

    /// A value for a host request, or the record it holds.
    pub fn encode(&self, value: &Js) -> Result<Json, HeldRecord> {
        let sent = self.sent.borrow();
        let mut encoder = Encoder { plain: true, sent: Some(&sent), ..Encoder::default() };
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
        Encoder { plain: true, sent: Some(&sent), ..Encoder::default() }.value(value)
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
            Js::String(s) => json!(s),
            // The built-in itself, which the host names back (`Object`, or
            // `Object.prototype[name]`).
            Js::Function(function) => json!(["f", function.0]),
            Js::Object(object) if crate::js::is_object_prototype(object) => json!(["p"]),
            // A record never crosses: a request holding one is never made
            // (`HeldRecord`), and the shim refuses this tag in a result.
            // The event's binding object is plain data, `{kind: 'event'}`: it
            // crosses as that.
            Js::Record(record) if matches!(record.as_ref(), crate::bindings::Binding::Event) => {
                let mut object = JsObject::new();
                object.set("kind".into(), Js::str("event"));
                self.value(&Js::object(object))
            }
            Js::Record(record) => {
                let kind = crate::record::kind_of(record);
                self.record.get_or_insert(kind.clone());
                json!(["x", kind])
            }
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
                        json!(object.entries().iter().map(|(k, v)| json!([k, this.value(v)])).collect::<Vec<_>>())
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
        // The binding object's JSON, where this engine writes it as the
        // TypeScript does (`try_json_stringify` names the rest).
        Js::Record(record) => match record.as_ref() {
            crate::bindings::Binding::Event => object_of(vec![("kind", Js::str("event"))]),
            crate::bindings::Binding::Positions(landings) => object_of(vec![
                ("kind", Js::str("positions")),
                ("landings", json_round_trip(&Js::array(landings.iter().cloned().map(crate::record::held).collect()))),
            ]),
            _ => Js::object(JsObject::new()),
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
        // Read down to its fields wherever one is written out.
        Js::Record(_) => Json::Object(Map::new()),
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
