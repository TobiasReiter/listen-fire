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

use std::collections::HashMap;
use std::rc::Rc;

use serde_json::{Value as Json, json};

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
    pub language_version: Option<u32>,
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
    let language_version = json.get("languageVersion").and_then(Json::as_u64).map(|v| v as u32);
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
                        let value = Js::Array(Rc::new(JsArray { items, origin: Some(id as u32) }));
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

/// A value for a host call: written out whole, the caller's own objects
/// included (a run's host has no table of objects it sent; their order and
/// identity within the value still cross).
pub fn encode_plain(value: &Js) -> Json {
    let mut encoder = Encoder { plain: true, ..Encoder::default() };
    encoder.value(value)
}

#[derive(Default)]
struct Encoder {
    written: HashMap<usize, u64>,
    plain: bool,
}

impl Encoder {
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
            Js::Array(array) => match array.origin.filter(|_| !self.plain) {
                Some(id) => json!(["i", id]),
                None => self.shared(Rc::as_ptr(array) as usize, |this| {
                    json!(array.items.iter().map(|item| this.value(item)).collect::<Vec<_>>())
                }, "l"),
            },
            Js::Object(object) => match object.origin.filter(|_| !self.plain) {
                Some(id) => json!(["i", id]),
                None => self.shared(Rc::as_ptr(object) as usize, |this| {
                    json!(object.entries().iter().map(|(k, v)| json!([k, this.value(v)])).collect::<Vec<_>>())
                }, "o"),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::strict_equals;

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
            },"origins":1}"#,
        )
        .unwrap();
        let x = &envelope.env.resolve("x").unwrap().value;
        let y = envelope.env.resolve("y").unwrap();
        let Js::Array(list) = &y.value else { panic!("y is a list") };
        assert!(strict_equals(&list.items[0], x));
        assert!(y.many);
        assert_eq!(envelope.env.resolve("x").unwrap().trail, Some(Trail { origins: vec![0], direct: Some(0) }));
        assert_eq!(encode(x), json!(["i", 0]));
        let Js::Object(object) = x else { panic!("x is an object") };
        assert_eq!(object.entries().iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["b", "a"]);

        let fresh = Js::array(vec![]);
        let pair = Js::array(vec![fresh.clone(), fresh, Js::Number(-0.0), Js::Number(f64::INFINITY)]);
        assert_eq!(encode(&pair), json!(["l", 0, [["l", 1, []], ["r", 1], ["n", "-0"], ["n", "Infinity"]]]));
    }
}
