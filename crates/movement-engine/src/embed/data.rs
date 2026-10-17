//! The values a host is handed and answers with: the eval wire
//! (crate::env) read into a Rust type, so a host never sees the wire's tags.
//! Lossless both ways: an object keeps its key order, and the two engine
//! objects that cross (a file, the event or a callback record) come back as
//! the handles they went out as.

use serde_json::{Value as Json, json};

/// One value, as the movement holds it.
#[derive(Debug, Clone, PartialEq)]
pub enum Data {
    Null,
    Bool(bool),
    Number(f64),
    Text(String),
    List(Vec<Data>),
    /// An object, its entries in the movement's own key order.
    Map(Vec<(String, Data)>),
    /// A file the engine holds, by the id the host's file table gave it.
    File(FileRef),
    /// The event or a callback, handed out by the engine: give it back as
    /// is and the engine reads it as the record again.
    Record(RecordRef),
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileRef {
    pub id: u32,
    /// What the host told the engine about it, when the host made it.
    pub descriptor: Option<FileDescriptor>,
}

/// What a reader of a file may print of it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FileDescriptor {
    pub name: Option<String>,
    pub content_type: Option<String>,
    pub size: Option<f64>,
    /// The host's own name for it (a storage key).
    pub handle: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecordRef {
    pub id: u64,
    /// The record's data, for a host that reads it (the event's payload).
    pub data: Box<Data>,
}

impl Data {
    pub fn text(text: impl Into<String>) -> Data {
        Data::Text(text.into())
    }

    /// An object from its entries, in this order.
    pub fn map<K: Into<String>>(entries: impl IntoIterator<Item = (K, Data)>) -> Data {
        Data::Map(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }

    /// An object's member (a record's, through its data).
    pub fn get(&self, key: &str) -> Option<&Data> {
        match self {
            Data::Map(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            Data::Record(record) => record.data.get(key),
            _ => None,
        }
    }

    pub fn as_text(&self) -> Option<&str> {
        match self {
            Data::Text(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Data::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_list(&self) -> Option<&[Data]> {
        match self {
            Data::List(items) => Some(items),
            _ => None,
        }
    }

    /// Plain JSON, for a host that stores or prints it (key order kept only
    /// as far as `serde_json`'s map keeps it; a file is its descriptor, a
    /// record its data).
    pub fn to_json(&self) -> Json {
        match self {
            Data::Null => Json::Null,
            Data::Bool(b) => json!(b),
            Data::Number(n) => json!(n),
            Data::Text(t) => json!(t),
            Data::List(items) => Json::Array(items.iter().map(Data::to_json).collect()),
            Data::Map(entries) => Json::Object(entries.iter().map(|(k, v)| (k.clone(), v.to_json())).collect()),
            Data::File(file) => {
                let d = file.descriptor.clone().unwrap_or_default();
                json!({ "file": file.id, "name": d.name, "contentType": d.content_type, "size": d.size })
            }
            Data::Record(record) => record.data.to_json(),
        }
    }

    /// Off the wire. `None` for a form the wire never carries.
    pub(crate) fn from_wire(json: &Json) -> Result<Data, String> {
        Ok(match json {
            Json::Null => Data::Null,
            Json::Bool(b) => Data::Bool(*b),
            Json::Number(n) => Data::Number(n.as_f64().ok_or("a number the wire cannot read")?),
            Json::String(s) => Data::Text(s.clone()),
            Json::Object(_) => return Err(format!("a bare object on the wire: {json}")),
            Json::Array(tagged) => {
                let tag = tagged.first().and_then(Json::as_str).ok_or_else(|| format!("an untagged wire array: {json}"))?;
                match tag {
                    "l" => Data::List(
                        tagged.get(1).and_then(Json::as_array).ok_or("a wire list is [\"l\", items]")?.iter().map(Data::from_wire).collect::<Result<_, _>>()?,
                    ),
                    "o" => {
                        let entries = tagged.get(1).and_then(Json::as_array).ok_or("a wire object is [\"o\", entries]")?;
                        let mut out = Vec::with_capacity(entries.len());
                        for entry in entries {
                            let (Some(Json::String(key)), Some(value)) = (entry.get(0), entry.get(1)) else {
                                return Err(format!("a wire entry is [key, value]: {entry}"));
                            };
                            out.push((key.clone(), Data::from_wire(value)?));
                        }
                        Data::Map(out)
                    }
                    "F" => {
                        let id = tagged.get(1).and_then(Json::as_u64).ok_or("a wire file has an id")? as u32;
                        Data::File(FileRef { id, descriptor: None })
                    }
                    "x" => match (tagged.get(1).and_then(Json::as_u64), tagged.get(2)) {
                        (Some(id), Some(data)) => Data::Record(RecordRef { id, data: Box::new(Data::from_wire(data)?) }),
                        // `["x", kind]`: a record the engine never hands a host.
                        _ => return Err(format!("a record no host is handed: {json}")),
                    },
                    _ => return Err(format!("an unknown wire tag: {json}")),
                }
            }
        })
    }

    /// Onto the wire.
    pub(crate) fn to_wire(&self) -> Json {
        match self {
            Data::Null => Json::Null,
            Data::Bool(b) => json!(b),
            Data::Number(n) if n.is_finite() => json!(n),
            Data::Number(_) => Json::Null,
            Data::Text(t) => json!(t),
            Data::List(items) => json!(["l", items.iter().map(Data::to_wire).collect::<Vec<_>>()]),
            Data::Map(entries) => json!(["o", entries.iter().map(|(k, v)| json!([k, v.to_wire()])).collect::<Vec<_>>()]),
            Data::File(file) => {
                let d = file.descriptor.clone().unwrap_or_default();
                let mut shown = serde_json::Map::new();
                for (key, value) in [("name", d.name), ("contentType", d.content_type), ("handle", d.handle)] {
                    if let Some(value) = value {
                        shown.insert(key.into(), json!(value));
                    }
                }
                if let Some(size) = d.size {
                    shown.insert("size".into(), json!(size));
                }
                json!(["F", file.id, shown])
            }
            Data::Record(record) => json!(["x", record.id]),
        }
    }
}

impl From<&str> for Data {
    fn from(text: &str) -> Data {
        Data::Text(text.into())
    }
}

impl From<String> for Data {
    fn from(text: String) -> Data {
        Data::Text(text)
    }
}

impl From<f64> for Data {
    fn from(n: f64) -> Data {
        Data::Number(n)
    }
}

impl From<bool> for Data {
    fn from(b: bool) -> Data {
        Data::Bool(b)
    }
}

/// Plain JSON in (an object's keys in `serde_json`'s order).
impl From<Json> for Data {
    fn from(json: Json) -> Data {
        match json {
            Json::Null => Data::Null,
            Json::Bool(b) => Data::Bool(b),
            Json::Number(n) => Data::Number(n.as_f64().unwrap_or(f64::NAN)),
            Json::String(s) => Data::Text(s),
            Json::Array(items) => Data::List(items.into_iter().map(Data::from).collect()),
            Json::Object(map) => Data::Map(map.into_iter().map(|(k, v)| (k, Data::from(v))).collect()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wire_round_trips_through_data() {
        let wire = json!(["o", [["b", 1.0], ["a", ["l", [true, null, "t"]]], ["f", ["F", 3, { "name": "n.txt" }]]]]);
        let data = Data::from_wire(&wire).unwrap();
        assert_eq!(data.get("b"), Some(&Data::Number(1.0)));
        assert!(matches!(data.get("f"), Some(Data::File(FileRef { id: 3, .. }))));
        let event = Data::from_wire(&json!(["x", 0, ["o", [["payload", ["o", [["id", "p1"]]]]]]])).unwrap();
        assert_eq!(event.to_wire(), json!(["x", 0]));
        assert_eq!(event.get("payload").and_then(|p| p.get("id")), Some(&Data::text("p1")));
        assert!(Data::from_wire(&json!(["x", "Binding"])).is_err());
    }
}
