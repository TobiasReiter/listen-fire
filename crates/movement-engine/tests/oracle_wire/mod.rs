//! The form the frozen fixtures' values are recorded in: JavaScript
//! values exactly, as the eval wire carried them before it became plain
//! JSON — `["u"]` undefined, `["n", "NaN" | "Infinity" | "-Infinity" |
//! "-0"]`, `["s16", [units…]]` a text holding a lone surrogate (read here
//! with each lone half U+FFFD, as the engine reads one), `["l", id,
//! [items…]]`, `["o", id, [[key, value]…]]`, `["r", id]` the same list or
//! object again. The engine no longer reads it; the fixtures keep it so
//! their inputs stay exact.
#![allow(dead_code)]

use std::collections::HashMap;
use std::rc::Rc;

use movement_engine::js::{Js, JsArray, JsObject, JsString};
use serde_json::{Value as Json, json};

pub fn decode(json: &Json) -> Result<Js, String> {
    Decoder::default().value(json)
}

/// A recorded value as the engine's wire carries it now.
pub fn plain(json: &Json) -> Json {
    movement_engine::env::encode_plain(&decode(json).expect("a recorded value"))
}

pub fn encode(value: &Js) -> Json {
    Encoder::default().value(value)
}

#[derive(Default)]
struct Decoder {
    seen: HashMap<u64, Js>,
}

fn text(json: &Json) -> Result<JsString, String> {
    match json {
        Json::String(text) => Ok(JsString::from(text.as_str())),
        Json::Array(tagged) if tagged.first().and_then(Json::as_str) == Some("s16") => {
            let units = tagged.get(1).and_then(Json::as_array).ok_or("s16 without units")?;
            let units: Vec<u16> = units.iter().map(|u| u.as_u64().and_then(|u| u16::try_from(u).ok()).ok_or("a unit")).collect::<Result<_, _>>()?;
            // The engine holds Unicode text: a lone half is U+FFFD.
            Ok(JsString::from(String::from_utf16_lossy(&units)))
        }
        _ => Err(format!("not a text: {json}")),
    }
}

impl Decoder {
    fn value(&mut self, json: &Json) -> Result<Js, String> {
        Ok(match json {
            Json::Null => Js::Null,
            Json::Bool(b) => Js::Bool(*b),
            Json::Number(n) => Js::Number(n.as_f64().ok_or("a number")?),
            Json::String(s) => Js::str(s.clone()),
            Json::Array(tagged) if tagged.first().and_then(Json::as_str) == Some("s16") => Js::String(text(json)?),
            Json::Array(tagged) => {
                let tag = tagged.first().and_then(Json::as_str).ok_or_else(|| format!("untagged: {json}"))?;
                let id = || tagged.get(1).and_then(Json::as_u64).ok_or_else(|| format!("`{tag}` without an id"));
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
                        let items = tagged.get(2).and_then(Json::as_array).ok_or("a list without items")?;
                        let items = items.iter().map(|item| self.value(item)).collect::<Result<_, _>>()?;
                        let value = Js::Array(Rc::new(JsArray::new(items)));
                        self.seen.insert(id, value.clone());
                        value
                    }
                    "o" => {
                        let id = id()?;
                        let entries = tagged.get(2).and_then(Json::as_array).ok_or("an object without entries")?;
                        let mut object = JsObject::new();
                        for entry in entries {
                            let key = text(entry.get(0).ok_or("an entry without a key")?)?;
                            object.set(key.into_string(), self.value(entry.get(1).ok_or("an entry without a value")?)?);
                        }
                        let value = Js::object(object);
                        self.seen.insert(id, value.clone());
                        value
                    }
                    "r" => self.seen.get(&id()?).cloned().ok_or("a reference to nothing seen")?,
                    _ => movement_engine::env::decode(json)?,
                }
            }
            Json::Object(_) => return Err(format!("a bare object: {json}")),
        })
    }
}

#[derive(Default)]
struct Encoder {
    written: HashMap<usize, u64>,
}

fn wire_text(text: &str) -> Json {
    json!(text)
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
            Js::String(s) => wire_text(s.as_str()),
            Js::Array(array) => self.shared(Rc::as_ptr(array) as usize, "l", |this| json!(array.items().iter().map(|item| this.value(item)).collect::<Vec<_>>())),
            Js::Object(object) => self.shared(Rc::as_ptr(object) as usize, "o", |this| {
                json!(object.entries().iter().map(|(k, v)| json!([wire_text(k), this.value(v)])).collect::<Vec<_>>())
            }),
            other => movement_engine::env::encode_plain(other),
        }
    }

    fn shared(&mut self, address: usize, tag: &str, body: impl FnOnce(&mut Encoder) -> Json) -> Json {
        if let Some(id) = self.written.get(&address) {
            return json!(["r", id]);
        }
        let id = self.written.len() as u64;
        self.written.insert(address, id);
        json!([tag, id, body(self)])
    }
}
