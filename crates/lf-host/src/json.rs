//! JSON as JavaScript holds it: an object's keys in the order `JSON.parse`
//! and assignment give them (array-index keys first, then as written). The
//! catalog the checker reads takes several of its maps in text order
//! (movement-parser `JsMap`), so a catalog built here must be written in the
//! order the TypeScript builder writes it, and what an external answered must
//! be read keeping its order. serde_json's `Value` sorts (its
//! `preserve_order` stays off for the parser's sake), hence this type.

use std::fmt;

use indexmap::IndexMap;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, Serializer};

#[derive(Debug, Clone, PartialEq)]
pub enum Js {
    Null,
    Bool(bool),
    Num(serde_json::Number),
    Str(String),
    Arr(Vec<Js>),
    Obj(Obj),
}

pub type Obj = IndexMap<String, Js>;

impl Js {
    pub fn get(&self, key: &str) -> Option<&Js> {
        match self {
            Js::Obj(map) => map.get(key),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Js::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Js]> {
        match self {
            Js::Arr(items) => Some(items),
            _ => None,
        }
    }

    /// `x === true`.
    pub fn is_true(value: Option<&Js>) -> bool {
        matches!(value, Some(Js::Bool(true)))
    }

    /// `x === false`.
    pub fn is_false(value: Option<&Js>) -> bool {
        matches!(value, Some(Js::Bool(false)))
    }

    pub fn str(text: impl Into<String>) -> Js {
        Js::Str(text.into())
    }

    pub fn strings<S: AsRef<str>>(items: impl IntoIterator<Item = S>) -> Js {
        Js::Arr(items.into_iter().map(|s| Js::str(s.as_ref())).collect())
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("a Js value always serialises")
    }

    pub fn parse(text: &[u8]) -> Result<Js, String> {
        serde_json::from_slice(text).map_err(|e| e.to_string())
    }
}

/// An object literal, in the order its members are written.
#[macro_export]
macro_rules! obj {
    ($($key:expr => $value:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut map = $crate::json::Obj::new();
        $(map.insert(String::from($key), $value);)*
        map
    }};
}

impl From<Obj> for Js {
    fn from(map: Obj) -> Js {
        Js::Obj(map)
    }
}

impl Serialize for Js {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Js::Null => serializer.serialize_unit(),
            Js::Bool(b) => serializer.serialize_bool(*b),
            Js::Num(n) => n.serialize(serializer),
            Js::Str(s) => serializer.serialize_str(s),
            Js::Arr(items) => items.serialize(serializer),
            Js::Obj(map) => {
                // Assignment order, with array-index keys first as JavaScript
                // enumerates them.
                let mut ordered = map.clone();
                movement_parser::util::js::object_key_order(&mut ordered);
                let mut out = serializer.serialize_map(Some(ordered.len()))?;
                for (k, v) in &ordered {
                    out.serialize_entry(k, v)?;
                }
                out.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for Js {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Js, D::Error> {
        struct JsVisitor;
        impl<'de> Visitor<'de> for JsVisitor {
            type Value = Js;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON")
            }
            fn visit_unit<E: de::Error>(self) -> Result<Js, E> {
                Ok(Js::Null)
            }
            fn visit_none<E: de::Error>(self) -> Result<Js, E> {
                Ok(Js::Null)
            }
            fn visit_bool<E: de::Error>(self, b: bool) -> Result<Js, E> {
                Ok(Js::Bool(b))
            }
            fn visit_i64<E: de::Error>(self, n: i64) -> Result<Js, E> {
                Ok(Js::Num(n.into()))
            }
            fn visit_u64<E: de::Error>(self, n: u64) -> Result<Js, E> {
                Ok(Js::Num(n.into()))
            }
            fn visit_f64<E: de::Error>(self, n: f64) -> Result<Js, E> {
                serde_json::Number::from_f64(n).map(Js::Num).ok_or_else(|| E::custom("not a JSON number"))
            }
            fn visit_str<E: de::Error>(self, s: &str) -> Result<Js, E> {
                Ok(Js::Str(s.to_string()))
            }
            fn visit_string<E: de::Error>(self, s: String) -> Result<Js, E> {
                Ok(Js::Str(s))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Js, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Js::Arr(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Js, A::Error> {
                // A repeated key keeps its first place and its last value, as `JSON.parse` does.
                let mut map = Obj::new();
                while let Some((k, v)) = access.next_entry::<String, Js>()? {
                    map.insert(k, v);
                }
                // Enumerated as JavaScript enumerates it: array-index keys first.
                movement_parser::util::js::object_key_order(&mut map);
                Ok(Js::Obj(map))
            }
        }
        deserializer.deserialize_any(JsVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn objects_keep_written_order_with_index_keys_first() {
        let parsed = Js::parse(br#"{"b":1,"a":{"z":true,"y":null},"2":0,"1":[1.5,"x"]}"#).unwrap();
        assert_eq!(parsed.to_json(), r#"{"1":[1.5,"x"],"2":0,"b":1,"a":{"z":true,"y":null}}"#);
    }
}
