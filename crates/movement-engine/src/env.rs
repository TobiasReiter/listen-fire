//! The value bindings an expression reads, in scopes with a parent chain,
//! and the wire they cross the boundary on.
//!
//! The wire carries plain JSON: null, booleans, finite numbers and texts
//! stand for themselves, a list is `["l", [items…]]` and an object
//! `["o", [[key, value]…]]` (its keys in the object's own order). What
//! JSON cannot say crosses as the nearest thing it can: `undefined`, `NaN`,
//! `±Infinity` and `-0` are `null` (a member holding `undefined` is left
//! out, as `JSON.stringify` leaves it), a lone surrogate is U+FFFD. Nothing
//! crosses by identity: an object reached twice is written twice.
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

use crate::js::{Js, JsObject};

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

/// What the evaluator's unit tests (crate::evaluate) read beside the
/// expression.
#[cfg(test)]
pub struct Envelope {
    pub env: Env,
    /// How many origin ids the caller assigned.
    pub origins: u32,
    /// The run's pinned instant, in milliseconds (`now`, a `toISOString`
    /// text on the wire): what `DATE.TODAY` reads.
    pub now: Option<f64>,
}

#[cfg(test)]
pub fn read_envelope(text: &str) -> Result<Envelope, String> {
    let json: Json = crate::js_string::from_json_text(text).map_err(|e| format!("the bindings are not JSON: {e}"))?;
    let decoder = Decoder::default();
    let mut env = Env::new();
    for (name, binding) in json.get("bindings").and_then(Json::as_object).ok_or("the envelope has no `bindings`")? {
        let value = decoder.value(binding.get("value").ok_or_else(|| format!("binding `{name}` has no value"))?)?;
        let trail = binding.get("provenance").map(read_trail).transpose()?;
        let many = binding.get("many").and_then(Json::as_bool).unwrap_or(false);
        env.declare(name.clone(), ValueBinding { value, trail, many });
    }
    let origins = json.get("origins").and_then(Json::as_u64).unwrap_or(0) as u32;
    let now = match json.get("now") {
        None => None,
        Some(Json::String(iso)) => match crate::js_date::parse(iso) {
            Some(ms) => Some(ms),
            None => return Err(format!("the pinned instant {iso:?} is not a toISOString text")),
        },
        Some(other) => return Err(format!("the pinned instant is a text, not {other}")),
    };
    Ok(Envelope { env, origins, now })
}

#[cfg(test)]
fn read_trail(json: &Json) -> Result<Trail, String> {
    let id = |v: &Json| v.as_u64().map(|n| n as u32).ok_or_else(|| format!("an origin id is a number, not {v}"));
    let origins = json.get("origins").and_then(Json::as_array).ok_or("a trail has `origins`")?;
    Ok(Trail {
        origins: origins.iter().map(id).collect::<Result<_, _>>()?,
        direct: json.get("direct").map(id).transpose()?,
    })
}

#[derive(Default)]
struct Decoder<'h> {
    /// The records this segment handed the host, by the id each crossed
    /// under: `["x", id]` is one of them, handed back as itself.
    records: Option<&'h [Rc<crate::bindings::Binding>]>,
}

impl Decoder<'_> {
    fn value(&self, json: &Json) -> Result<Js, String> {
        Ok(match json {
            Json::Null => Js::Null,
            Json::Bool(b) => Js::Bool(*b),
            Json::Number(n) => Js::Number(n.as_f64().ok_or("a number the wire cannot read")?),
            Json::String(s) => Js::str(s.clone()),
            Json::Array(tagged) => {
                let tag = tagged.first().and_then(Json::as_str).ok_or_else(|| format!("an untagged wire array: {json}"))?;
                let id = || tagged.get(1).and_then(Json::as_u64).ok_or_else(|| format!("a wire `{tag}` without an id"));
                match tag {
                    "l" => {
                        let items = tagged.get(1).and_then(Json::as_array).ok_or("a wire list is [\"l\", items]")?;
                        Js::array(items.iter().map(|item| self.value(item)).collect::<Result<_, _>>()?)
                    }
                    "o" => {
                        let entries = tagged.get(1).and_then(Json::as_array).ok_or("a wire object is [\"o\", entries]")?;
                        let mut object = JsObject::new();
                        for entry in entries {
                            let (Some(Json::String(key)), Some(value)) = (entry.get(0), entry.get(1)) else {
                                return Err(format!("a wire entry is [key, value]: {entry}"));
                            };
                            object.set(key.clone(), self.value(value)?);
                        }
                        Js::object(object)
                    }
                    // A file the host hands the engine as one (a render's
                    // answer): its descriptor, made a file by the tag.
                    "F" => {
                        let id = id()? as u32;
                        let Some(Json::Object(shown)) = tagged.get(2) else { return Err(format!("a wire file without its display: {json}")) };
                        let handle = match shown.get("handle") {
                            None | Some(Json::Null) => None,
                            Some(Json::String(handle)) => Some(handle.clone()),
                            Some(_) => return Err(format!("a wire file's handle is text: {json}")),
                        };
                        let mut display = JsObject::new();
                        for key in ["name", "contentType", "size"] {
                            match shown.get(key) {
                                None | Some(Json::Null) => {}
                                Some(Json::String(text)) if key != "size" => display.set(key.into(), Js::str(text.clone())),
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

/// A text for the wire: a lone surrogate is U+FFFD.
fn wire_text(text: &str) -> Json {
    json!(crate::js_string::well_formed(text))
}

/// One value off the wire, on its own.
pub fn decode(json: &Json) -> Result<Js, String> {
    Decoder::default().value(json)
}

/// A value written out whole.
pub fn encode_plain(value: &Js) -> Json {
    Encoder::default().value(value)
}

/// A segment's wire with its host (rust_wire.ts's one `WireOut` per
/// segment): the records it handed the host, so `["x", id]` in an answer
/// names one of them. Answers are data, as the event is, whatever keys they
/// carry: only `["x", id]` names a record (one this wire handed out).
#[derive(Default)]
pub struct Wire {
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
        let records = self.records.borrow();
        Decoder { records: Some(&records) }.value(json)
    }

    /// A value for a host request, or the record it holds.
    pub fn encode(&self, value: &Js) -> Result<Json, HeldRecord> {
        let mut records = self.records.borrow_mut();
        let mut encoder = Encoder { records: Some(&mut records), ..Encoder::default() };
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
        let mut records = self.records.borrow_mut();
        Encoder { records: Some(&mut records), ..Encoder::default() }.value(value)
    }
}

#[derive(Default)]
struct Encoder<'w> {
    /// A record met while writing, by its kind.
    record: Option<String>,
    /// The records handed out so far (the segment's, or this value's own).
    records: Option<&'w mut Vec<Rc<crate::bindings::Binding>>>,
    own_records: Vec<Rc<crate::bindings::Binding>>,
}

impl Encoder<'_> {
    fn value(&mut self, value: &Js) -> Json {
        if crate::js::holds_itself(value) {
            return self.tree(&crate::js::acyclic(value));
        }
        self.tree(value)
    }

    fn tree(&mut self, value: &Js) -> Json {
        match value {
            Js::Undefined | Js::Null => Json::Null,
            Js::Bool(b) => json!(b),
            Js::Number(n) if !n.is_finite() || (*n == 0.0 && n.is_sign_negative()) => Json::Null,
            Js::Number(n) => json!(n),
            Js::String(s) => wire_text(s.as_form()),
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
                    json!(["x", id, self.tree(&descriptor)])
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
            Js::Array(array) => json!(["l", array.items().iter().map(|item| self.tree(item)).collect::<Vec<_>>()]),
            Js::Object(object) => {
                // A member holding `undefined` is left out, as `JSON.stringify`
                // leaves it out.
                let entries = object.entries().iter().filter(|(_, v)| !matches!(v, Js::Undefined));
                json!(["o", entries.map(|(k, v)| json!([wire_text(k), self.tree(v)])).collect::<Vec<_>>()])
            }
        }
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
        Js::Array(list) => Js::array(
            list.items().iter().map(|item| if matches!(item, Js::Undefined) { Js::Null } else { json_round_trip(item) }).collect(),
        ),
        Js::Object(object) => {
            let mut copy = JsObject::new();
            for (k, v) in object.entries() {
                if !matches!(v, Js::Undefined) {
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
        Js::Undefined | Js::Null => Json::Null,
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
                if !matches!(v, Js::Undefined) {
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

    /// What JSON cannot say crosses as `null`; nothing crosses by identity.
    #[test]
    fn the_wire_is_plain_json_in_key_order() {
        let envelope = read_envelope(
            r#"{"bindings":{
                "x":{"value":["o",[["b",null],["a",1]]],"provenance":{"origins":[0],"direct":0}},
                "y":{"value":["l",[["o",[]],2]],"many":true}
            },"origins":1,"languageVersion":5}"#,
        )
        .unwrap();
        let x = &envelope.env.resolve("x").unwrap().value;
        assert!(envelope.env.resolve("y").unwrap().many);
        assert_eq!(envelope.env.resolve("x").unwrap().trail, Some(Trail { origins: vec![0], direct: Some(0) }));
        let Js::Object(object) = x else { panic!("x is an object") };
        assert_eq!(object.entries().iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["b", "a"]);

        let fresh = Js::array(vec![]);
        let special = Js::array(vec![fresh.clone(), fresh, Js::Undefined, Js::Number(-0.0), Js::Number(f64::NAN), Js::Number(f64::INFINITY), Js::Number(0.0)]);
        assert_eq!(encode_plain(&special), json!(["l", [["l", []], ["l", []], null, null, null, null, 0.0]]));
        for gone in [json!(["u"]), json!(["n", "NaN"]), json!(["r", 0]), json!(["i", 0]), json!(["s16", [0xD83D]]), json!(["p"]), json!(["f", "toString"])] {
            assert!(decode(&gone).is_err(), "{gone}");
        }
    }

    /// A host's own `__proto__` key (`JSON.parse` makes one) is an own
    /// entry, read and written back as the key it is.
    #[test]
    fn an_own_proto_key_crosses_as_a_key() {
        let wire = Wire::default();
        let sent = json!(["o", [["a", 1], ["__proto__", ["o", [["x", 2]]]]]]);
        let Js::Object(object) = wire.decode(&sent).unwrap() else { panic!("an object") };
        assert_eq!(object.entries().iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["a", "__proto__"]);
        assert_eq!(encode_plain(&Js::Object(object.clone())), json!(["o", [["a", 1.0], ["__proto__", ["o", [["x", 2.0]]]]]]));
        assert_eq!(json_of_js(&Js::Object(object)), json!({ "a": 1, "__proto__": { "x": 2 } }));
    }

    /// A lone surrogate the engine holds crosses as U+FFFD, in a value and
    /// in a key; a pair crosses as the text it is.
    #[test]
    fn a_lone_surrogate_crosses_as_the_replacement_character() {
        let mut object = JsObject::new();
        object.set(crate::js_string::text_of_units(&[0xD83D]), Js::String(crate::js::JsString::from_units(&[0x61, 0xDE00])));
        object.set("k".into(), Js::str("😀"));
        assert_eq!(encode_plain(&Js::object(object)), json!(["o", [["\u{FFFD}", "a\u{FFFD}"], ["k", "😀"]]]));
    }
}
