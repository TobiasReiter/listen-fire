//! A movement value as the engine holds it: plain data, a record, a list or a
//! map of values, or absent (the TypeScript engine's `undefined`). Its JSON
//! is the parked-state `ValueDescriptor` (apps/api/src/services/
//! movement_engine/serialize.ts): `{kind: "data", value}`, `{kind: "record",
//! binding}`, `{kind: "list", of}`, `{kind: "map", of}`. Absent is
//! `{kind: "data"}` with no `value`, which is what serialising `undefined`
//! there writes.

use std::collections::BTreeMap;

use serde_json::{Map, Value as Json, json};

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Absent,
    Data(Json),
    /// The record's binding descriptor, kept as its JSON until the slice that
    /// first reads records gives it a type.
    Record(Json),
    List(Vec<Value>),
    Map(BTreeMap<String, Value>),
}

impl Value {
    pub fn to_json(&self) -> Json {
        match self {
            Value::Absent => json!({ "kind": "data" }),
            Value::Data(value) => json!({ "kind": "data", "value": value }),
            Value::Record(binding) => json!({ "kind": "record", "binding": binding }),
            Value::List(items) => json!({ "kind": "list", "of": items.iter().map(Value::to_json).collect::<Vec<_>>() }),
            Value::Map(entries) => {
                let of: Map<String, Json> = entries.iter().map(|(k, v)| (k.clone(), v.to_json())).collect();
                json!({ "kind": "map", "of": of })
            }
        }
    }

    pub fn from_json(json: &Json) -> Result<Value, String> {
        let object = json.as_object().ok_or_else(|| format!("a value descriptor is an object, not {json}"))?;
        let field = |name: &str| object.get(name).ok_or_else(|| format!("a {name}-less value descriptor: {json}"));
        match object.get("kind").and_then(Json::as_str) {
            Some("data") => Ok(object.get("value").map_or(Value::Absent, |value| Value::Data(value.clone()))),
            Some("record") => Ok(Value::Record(field("binding")?.clone())),
            Some("list") => {
                let items = field("of")?.as_array().ok_or_else(|| format!("a list's `of` is an array: {json}"))?;
                Ok(Value::List(items.iter().map(Value::from_json).collect::<Result<_, _>>()?))
            }
            Some("map") => {
                let entries = field("of")?.as_object().ok_or_else(|| format!("a map's `of` is an object: {json}"))?;
                let entries = entries
                    .iter()
                    .map(|(k, v)| Ok((k.clone(), Value::from_json(v)?)))
                    .collect::<Result<_, String>>()?;
                Ok(Value::Map(entries))
            }
            _ => Err(format!("an unknown value descriptor kind: {json}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_round_trips() {
        let value = Value::Map(BTreeMap::from([
            ("absent".into(), Value::Absent),
            ("n".into(), Value::Data(json!(1.5))),
            ("people".into(), Value::List(vec![Value::Record(json!({ "kind": "record", "id": "r1" }))])),
        ]));
        let encoded = value.to_json();
        assert_eq!(
            encoded,
            json!({ "kind": "map", "of": {
                "absent": { "kind": "data" },
                "n": { "kind": "data", "value": 1.5 },
                "people": { "kind": "list", "of": [{ "kind": "record", "binding": { "kind": "record", "id": "r1" } }] },
            } })
        );
        assert_eq!(Value::from_json(&encoded), Ok(value));
    }

    #[test]
    fn null_is_data_not_absent() {
        assert_eq!(Value::from_json(&json!({ "kind": "data", "value": null })), Ok(Value::Data(Json::Null)));
    }

    #[test]
    fn a_malformed_descriptor_is_refused() {
        assert!(Value::from_json(&json!({ "kind": "list" })).is_err());
        assert!(Value::from_json(&json!({ "kind": "nope" })).is_err());
        assert!(Value::from_json(&json!(3)).is_err());
    }
}
