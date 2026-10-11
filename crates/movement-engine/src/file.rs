//! A file the engine holds (engine-contracts `file_ref.ts`): a descriptor the
//! engine itself made a file, at an envelope that declares one — a field the
//! catalog types `file`, a resource's `fileRef` slot, a plugin output's
//! declared file, a parked `file`. It is its own value (`Js::File`), never a
//! `Js::Object` with a key: data carrying a descriptor's keys, `__brand`
//! included, is data wherever it goes.

use std::rc::Rc;

use movement_parser::catalog::types::{Composite, FieldType, InstanceSchema, Scalar};

use crate::js::{Js, JsObject};

/// The members a descriptor may have: one with any other is not one.
const DESCRIPTOR_MEMBERS: [&str; 6] = ["__brand", "name", "contentType", "size", "source", "url"];

/// An own member, `undefined` where it is absent (as `x !== undefined` reads
/// an absent key and one holding `undefined` alike).
fn member(object: &JsObject, key: &str) -> Js {
    object.get(key).cloned().unwrap_or(Js::Undefined)
}

/// A plain object: no prototype a filing gave it.
fn plain(value: &Js) -> Option<&Rc<JsObject>> {
    match value {
        Js::Object(object) if matches!(object.proto, None | Some(Js::Null)) && !crate::js::is_object_prototype(object) => Some(object),
        _ => None,
    }
}

/// `fileDescriptorOf`: the descriptor a value spells — a plain object with
/// nothing but a descriptor's members, each of its type, and at least one of
/// `__brand`, `source` and `url` — in the descriptor's own order.
pub fn descriptor_of(value: &Js) -> Option<JsObject> {
    let object = plain(value)?;
    if !object.entries().iter().all(|(key, _)| DESCRIPTOR_MEMBERS.contains(&key.as_str())) {
        return None;
    }
    let brand = member(object, "__brand");
    let name = member(object, "name");
    let content_type = member(object, "contentType");
    let size = member(object, "size");
    let url = member(object, "url");
    let source = member(object, "source");
    if [&brand, &source, &url].iter().all(|m| matches!(m, Js::Undefined)) {
        return None;
    }
    if !matches!(&brand, Js::Undefined) && !matches!(&brand, Js::String(b) if b == "FileRef") {
        return None;
    }
    let text_or_absent = |m: &Js| matches!(m, Js::Undefined | Js::String(_));
    if !text_or_absent(&name) || !text_or_absent(&content_type) {
        return None;
    }
    if !matches!(size, Js::Undefined) && !matches!(size, Js::Number(n) if n.is_finite()) {
        return None;
    }
    if !matches!(url, Js::Undefined | Js::Null | Js::String(_)) {
        return None;
    }
    let source = match source {
        Js::Undefined => None,
        other => Some(source_of(&other)?),
    };
    let mut out = JsObject::new();
    out.set("__brand".into(), Js::str("FileRef"));
    for (key, value) in [("name", name), ("contentType", content_type), ("size", size)] {
        if !matches!(value, Js::Undefined) {
            out.set(key.into(), value);
        }
    }
    if let Some(source) = source {
        out.set("source".into(), Js::object(source));
    }
    if !matches!(url, Js::Undefined) {
        out.set("url".into(), url);
    }
    Some(out)
}

/// A descriptor's `source` in one of its spellings, its members each text.
fn source_of(value: &Js) -> Option<JsObject> {
    let object = plain(value)?;
    let text = |key: &str| match object.get(key) {
        Some(Js::String(text)) => Some(text.clone()),
        _ => None,
    };
    let mut out = JsObject::new();
    if object.get("store").is_some() {
        let object_uri = text("objectUri")?;
        if text("store").as_deref() != Some("document") {
            return None;
        }
        out.set("store".into(), Js::str("document"));
        out.set("objectUri".into(), Js::str(object_uri));
        return Some(out);
    }
    let handle = text("handle")?;
    if object.get("ownerAdapterType").is_some() {
        out.set("ownerAdapterType".into(), Js::str(text("ownerAdapterType")?));
        out.set("handle".into(), Js::str(handle));
        return Some(out);
    }
    out.set("adapterType".into(), Js::str(text("adapterType")?));
    match member(object, "credentialId") {
        Js::Undefined => {}
        Js::String(id) => out.set("credentialId".into(), Js::String(id)),
        _ => return None,
    }
    match member(object, "constructionArgs") {
        Js::Undefined => {}
        args => {
            let args = plain(&args)?;
            let mut copy = JsObject::new();
            for (key, value) in args.entries() {
                let Js::String(_) = value else { return None };
                copy.set(key.clone(), value.clone());
            }
            out.set("constructionArgs".into(), Js::object(copy));
        }
    }
    out.set("handle".into(), Js::str(handle));
    Some(out)
}

/// `fileValueOf`: the file a value is, at an envelope that declares one —
/// the engine's own file as itself, a descriptor made one.
pub fn file_value_of(value: &Js) -> Option<Js> {
    match value {
        Js::File(_) => Some(value.clone()),
        other => descriptor_of(other).map(|descriptor| Js::File(Rc::new(descriptor))),
    }
}

/// `filesAtType`: a value read where the catalog declares its type, every
/// position the type calls a file made one. Anything else is as it came.
pub fn files_at_type(ty: Option<&FieldType>, value: Js) -> Js {
    let Some(ty) = ty else { return value };
    if value.is_nullish() {
        return value;
    }
    match ty {
        FieldType::Scalar(Scalar::File) => file_value_of(&value).unwrap_or(value),
        FieldType::Scalar(_) => value,
        FieldType::Composite(composite) => match composite {
            Composite::List { of, .. } => match &value {
                Js::Array(list) => Js::array(list.items().iter().map(|item| files_at_type(Some(of), item.clone())).collect()),
                _ => value,
            },
            Composite::Tuple { of, .. } => match &value {
                Js::Array(list) => Js::array(
                    list.items().iter().enumerate().map(|(i, item)| files_at_type(of.get(i).and_then(Option::as_ref), item.clone())).collect(),
                ),
                _ => value,
            },
            Composite::Dict { of, .. } => match plain(&value) {
                Some(object) => {
                    let mut out = JsObject::new();
                    for (key, item) in object.entries() {
                        out.set(key.clone(), files_at_type(Some(of), item.clone()));
                    }
                    Js::object(out)
                }
                None => value,
            },
            Composite::MaybeAbsent { of } => files_at_type(Some(of), value),
            Composite::Enum { .. } | Composite::Union { .. } | Composite::Record { .. } => value,
        },
    }
}

/// `declaredFieldType`: the type an instance's schema declares for a field
/// of a position type.
pub fn declared_field_type<'a>(schema: Option<&'a InstanceSchema>, record_type: Option<&str>, field: &str) -> Option<&'a FieldType> {
    schema?.positions.get(record_type?)?.properties.get(field)
}

/// A file's descriptor as data: what JSON, a park and the wire write of it.
pub fn descriptor(file: &JsObject) -> Js {
    Js::object(JsObject::clone_of(file))
}

/// `holdsFile`: a file anywhere in a value, through its lists and dicts.
pub fn holds_file(value: &Js) -> bool {
    if crate::js::holds_itself(value) {
        return holds_file(&crate::js::acyclic(value));
    }
    match value {
        Js::File(_) => true,
        Js::Array(list) => list.items().iter().any(holds_file),
        Js::Object(dict) if dict.proto.is_none() => dict.entries().iter().any(|(_, item)| holds_file(item)),
        _ => false,
    }
}

/// `fileFieldsOf`: a record's fields that hold a file, each as its value
/// descriptor, beside the fields a park writes whole; `None` when no field
/// holds one.
pub fn file_fields_of(fields: &JsObject) -> Option<Js> {
    let mut out: Option<JsObject> = None;
    for (key, value) in fields.entries() {
        if holds_file(value) {
            out.get_or_insert_with(JsObject::new).set(key.clone(), file_field_value(value));
        }
    }
    out.map(Js::object)
}

/// `fileFieldValue`: a field's value with its files said to be.
fn file_field_value(value: &Js) -> Js {
    let of = |kind: &str, of: Js| crate::env::object_of(vec![("kind", Js::str(kind)), ("of", of)]);
    match value {
        Js::File(file) => crate::env::object_of(vec![("kind", Js::str("file")), ("file", descriptor(file))]),
        Js::Array(list) => of("list", Js::array(list.items().iter().map(file_field_value).collect())),
        Js::Object(dict) if dict.proto.is_none() => {
            let mut members = JsObject::new();
            for (key, item) in dict.entries() {
                members.set(key.clone(), file_field_value(item));
            }
            of("map", Js::object(members))
        }
        other => crate::env::object_of(vec![("kind", Js::str("data")), ("value", other.clone())]),
    }
}
