//! The eval wire between the host and the engine (crates/movement-engine/src/
//! env.rs says the format; packages/movement-engine/services/movement_engine/
//! rust_wire.ts is the TypeScript host's side, which this ports): a list is
//! `["l", items]`, an object `["o", [[key, value]…]]` in its own key order, a
//! file the opaque handle `["F", id, shown]` (`["F", id]` back), and a record
//! the engine handed out `["x", id, descriptor]` (`["x", id]` back).
//!
//! A value off the wire is a `Hv`: data, or a file or record by the id the
//! segment's tables hold it under. A file's descriptor (its source, which
//! names the store or the owning install) never reaches the engine: the
//! segment's `FileTable` keeps it, and the engine holds the handle.

use std::collections::HashMap;

use serde_json::{Value as Json, json};

use crate::json::{Js, Obj};

/// A value as the host holds one from the engine.
#[derive(Debug, Clone, PartialEq)]
pub enum Hv {
    Null,
    Bool(bool),
    Num(serde_json::Number),
    Str(String),
    List(Vec<Hv>),
    /// Entries in the order the engine wrote them.
    Obj(Vec<(String, Hv)>),
    /// A file the segment's table holds, by its id, with its descriptor.
    File { id: usize, descriptor: Obj },
    /// A record the engine handed out, by the id it gave it, with the
    /// descriptor it was handed out with.
    Record { id: u64, descriptor: Box<Hv> },
}

impl Hv {
    pub fn get(&self, key: &str) -> Option<&Hv> {
        match self {
            Hv::Obj(entries) => entries.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Hv::Str(s) => Some(s),
            _ => None,
        }
    }

    /// The value as plain JSON leaves the host (to an external, into the
    /// state file): a file as its descriptor, as `JSON.stringify` writes a
    /// file value; a record as the descriptor it was handed out with.
    pub fn js(&self) -> Js {
        match self {
            Hv::Null => Js::Null,
            Hv::Bool(b) => Js::Bool(*b),
            Hv::Num(n) => Js::Num(n.clone()),
            Hv::Str(s) => Js::Str(s.clone()),
            Hv::List(items) => Js::Arr(items.iter().map(Hv::js).collect()),
            Hv::Obj(entries) => {
                let mut map = Obj::new();
                for (k, v) in entries {
                    map.insert(k.clone(), v.js());
                }
                Js::Obj(map)
            }
            Hv::File { descriptor, .. } => Js::Obj(descriptor.clone()),
            Hv::Record { descriptor, .. } => descriptor.js(),
        }
    }

    /// Plain data, as a value the host made (an adapter's answer, the event).
    pub fn of_js(value: &Js) -> Hv {
        match value {
            Js::Null => Hv::Null,
            Js::Bool(b) => Hv::Bool(*b),
            Js::Num(n) => Hv::Num(n.clone()),
            Js::Str(s) => Hv::Str(s.clone()),
            Js::Arr(items) => Hv::List(items.iter().map(Hv::of_js).collect()),
            Js::Obj(map) => {
                // Enumerated as JavaScript enumerates the object.
                let mut ordered = map.clone();
                movement_parser::util::js::object_key_order(&mut ordered);
                Hv::Obj(ordered.iter().map(|(k, v)| (k.clone(), Hv::of_js(v))).collect())
            }
        }
    }
}

/// A JSON number as JavaScript holds it: an integral value is the integer
/// it is (`JSON.stringify` writes `2`, never `2.0`), and `-0` is `0`.
pub fn js_number(n: &serde_json::Number) -> serde_json::Number {
    if n.is_i64() || n.is_u64() {
        return n.clone();
    }
    let f = n.as_f64().unwrap_or(0.0);
    if f == 0.0 {
        return 0.into();
    }
    if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 {
        return (f as i64).into();
    }
    serde_json::Number::from_f64(f).unwrap_or_else(|| 0.into())
}

/// Plain JSON (serde's, keys sorted) as data, numbers as JavaScript holds them.
pub fn js_of_json(value: &Json) -> Js {
    match value {
        Json::Null => Js::Null,
        Json::Bool(b) => Js::Bool(*b),
        Json::Number(n) => Js::Num(js_number(n)),
        Json::String(s) => Js::Str(s.clone()),
        Json::Array(items) => Js::Arr(items.iter().map(js_of_json).collect()),
        Json::Object(map) => Js::Obj(map.iter().map(|(k, v)| (k.clone(), js_of_json(v))).collect()),
    }
}

/// Data as serde's JSON, for the engine's plain (non-wire) answers.
pub fn json_of_js(value: &Js) -> Json {
    match value {
        Js::Null => Json::Null,
        Js::Bool(b) => Json::Bool(*b),
        Js::Num(n) => Json::Number(n.clone()),
        Js::Str(s) => Json::String(s.clone()),
        Js::Arr(items) => Json::Array(items.iter().map(json_of_js).collect()),
        Js::Obj(map) => Json::Object(map.iter().map(|(k, v)| (k.clone(), json_of_js(v))).collect()),
    }
}

/// The files a segment handed the engine, by id: each one's whole descriptor
/// (`{__brand, name?, contentType?, size?, source?, url?}`).
#[derive(Debug, Default)]
pub struct FileTable {
    files: Vec<Obj>,
}

impl FileTable {
    pub fn add(&mut self, descriptor: Obj) -> usize {
        self.files.push(descriptor);
        self.files.len() - 1
    }

    pub fn get(&self, id: usize) -> Option<&Obj> {
        self.files.get(id)
    }

    /// What the engine is shown of a file: its handle and what it may print.
    fn shown(&self, id: usize) -> Json {
        let Some(file) = self.files.get(id) else { return json!({}) };
        let mut shown = serde_json::Map::new();
        if let Some(handle) = file_handle(file) {
            shown.insert("handle".into(), Json::String(handle));
        }
        for key in ["name", "contentType", "size"] {
            if let Some(value) = file.get(key) {
                shown.insert(key.into(), json_of_js(value));
            }
        }
        Json::Object(shown)
    }
}

/// `fileHandle`: the store's object uri, or the owner's handle.
pub fn file_handle(file: &Obj) -> Option<String> {
    let source = file.get("source")?;
    if source.get("store").is_some() {
        return source.get("objectUri").and_then(Js::as_str).map(str::to_string);
    }
    source.get("handle").and_then(Js::as_str).map(str::to_string)
}

/// The segment's wire: its file table and the records the engine handed out.
#[derive(Debug, Default)]
pub struct Wire {
    pub files: FileTable,
    records: HashMap<u64, Hv>,
}

impl Wire {
    /// A value off the wire.
    pub fn read(&mut self, wire: &Json) -> Result<Hv, String> {
        Ok(match wire {
            Json::Null => Hv::Null,
            Json::Bool(b) => Hv::Bool(*b),
            Json::Number(n) => Hv::Num(js_number(n)),
            Json::String(s) => Hv::Str(s.clone()),
            Json::Object(_) => return Err(format!("a bare object on the wire: {wire}")),
            Json::Array(tagged) => {
                let tag = tagged.first().and_then(Json::as_str).ok_or_else(|| format!("an untagged wire array: {wire}"))?;
                match tag {
                    "l" => {
                        let items = tagged.get(1).and_then(Json::as_array).ok_or("a wire list is [\"l\", items]")?;
                        Hv::List(items.iter().map(|item| self.read(item)).collect::<Result<_, _>>()?)
                    }
                    "o" => {
                        let entries = tagged.get(1).and_then(Json::as_array).ok_or("a wire object is [\"o\", entries]")?;
                        let mut out = Vec::with_capacity(entries.len());
                        for entry in entries {
                            let (Some(Json::String(key)), Some(value)) = (entry.get(0), entry.get(1)) else {
                                return Err(format!("a wire entry is [key, value]: {entry}"));
                            };
                            out.push((key.clone(), self.read(value)?));
                        }
                        Hv::Obj(out)
                    }
                    "F" => {
                        let id = tagged.get(1).and_then(Json::as_u64).ok_or_else(|| format!("a wire file without an id: {wire}"))?;
                        let id = usize::try_from(id).map_err(|e| e.to_string())?;
                        let Some(descriptor) = self.files.get(id) else {
                            return Err(format!("the engine named a file {id} this segment never handed it"));
                        };
                        Hv::File { id, descriptor: descriptor.clone() }
                    }
                    "x" => {
                        let id = tagged.get(1).and_then(Json::as_u64).ok_or_else(|| format!("the engine handed the host a record it cannot carry ({wire})"))?;
                        if let Some(descriptor) = tagged.get(2) {
                            let descriptor = self.read(descriptor)?;
                            self.records.entry(id).or_insert(descriptor);
                        }
                        let Some(descriptor) = self.records.get(&id) else {
                            return Err(format!("the engine named a record {id} it never handed out"));
                        };
                        Hv::Record { id, descriptor: Box::new(descriptor.clone()) }
                    }
                    other => return Err(format!("an unknown wire tag {other}")),
                }
            }
        })
    }

    /// A value onto the wire.
    pub fn write(&self, value: &Hv) -> Json {
        match value {
            Hv::Null => Json::Null,
            Hv::Bool(b) => Json::Bool(*b),
            Hv::Num(n) => Json::Number(js_number(n)),
            Hv::Str(s) => Json::String(s.clone()),
            Hv::List(items) => json!(["l", items.iter().map(|item| self.write(item)).collect::<Vec<_>>()]),
            Hv::Obj(entries) => json!(["o", entries.iter().map(|(k, v)| json!([k, self.write(v)])).collect::<Vec<_>>()]),
            Hv::File { id, .. } => json!(["F", id, self.files.shown(*id)]),
            Hv::Record { id, .. } => json!(["x", id]),
        }
    }

    /// A file the host makes for the engine: added to the table.
    pub fn file(&mut self, descriptor: Obj) -> Hv {
        let id = self.files.add(descriptor.clone());
        Hv::File { id, descriptor }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::obj;

    #[test]
    fn data_round_trips_in_its_own_key_order() {
        let mut wire = Wire::default();
        let sent = json!(["o", [["b", 1.0], ["a", ["l", [true, null, "x"]]]]]);
        let read = wire.read(&sent).unwrap();
        assert_eq!(read.js().to_json(), r#"{"b":1,"a":[true,null,"x"]}"#);
        assert_eq!(wire.write(&read), json!(["o", [["b", 1], ["a", ["l", [true, null, "x"]]]]]));
    }

    #[test]
    fn a_file_crosses_as_its_handle_and_back_as_its_descriptor() {
        let mut wire = Wire::default();
        let source = obj! { "store" => Js::str("document"), "objectUri" => Js::str("lf-files:k") };
        let file = wire.file(obj! { "__brand" => Js::str("FileRef"), "name" => Js::str("a.txt"), "size" => Js::Num(3.into()), "source" => Js::Obj(source) });
        assert_eq!(wire.write(&file), json!(["F", 0, { "handle": "lf-files:k", "name": "a.txt", "size": 3 }]));
        let back = wire.read(&json!(["o", [["f", ["F", 0]]]])).unwrap();
        assert_eq!(
            back.js().to_json(),
            r#"{"f":{"__brand":"FileRef","name":"a.txt","size":3,"source":{"store":"document","objectUri":"lf-files:k"}}}"#
        );
        assert!(wire.read(&json!(["F", 7])).is_err());
    }

    #[test]
    fn numbers_read_as_javascript_holds_them() {
        assert_eq!(js_of_json(&json!([2.0, -0.0, 1.5])).to_json(), "[2,0,1.5]");
    }
}
