//! File descriptors as the TypeScript host reads and spells them
//! (packages/engine-contracts/file_ref.ts, movement-engine
//! `engine/files/redeem.ts`): what a value must be to spell one, the owner
//! its `source` names, and the wire's spelling of it (the owner TYPE and its
//! handle — never a credential).

use crate::json::{Js, Obj};
use crate::obj;
use crate::wire::{Hv, Wire};

/// `DOCUMENT_STORE_OWNER`: how a document-store file is spelled where a
/// source names an owner type.
pub const DOCUMENT_STORE_OWNER: &str = "document-store";

const DESCRIPTOR_MEMBERS: &[&str] = &["__brand", "name", "contentType", "size", "source", "url"];

/// Whose a file is (`fileOwner`).
#[derive(Debug, Clone, PartialEq)]
pub enum Owner {
    Document { object_uri: String },
    Adapter { adapter_type: String, credential_id: Option<String>, handle: String },
}

/// `fileSourceOf`: a descriptor's `source` in one of its spellings.
fn source_of(value: &Js) -> Option<Js> {
    let Js::Obj(map) = value else { return None };
    let text = |key: &str| map.get(key).and_then(Js::as_str).map(str::to_string);
    if map.contains_key("store") {
        let object_uri = text("objectUri")?;
        return (text("store").as_deref() == Some("document"))
            .then(|| Js::Obj(obj! { "store" => Js::str("document"), "objectUri" => Js::Str(object_uri) }));
    }
    let handle = text("handle")?;
    if map.contains_key("ownerAdapterType") {
        let owner = text("ownerAdapterType")?;
        return Some(Js::Obj(obj! { "ownerAdapterType" => Js::Str(owner), "handle" => Js::Str(handle) }));
    }
    let adapter_type = text("adapterType")?;
    let mut out = obj! { "adapterType" => Js::Str(adapter_type) };
    match map.get("credentialId") {
        None => {}
        Some(Js::Str(id)) => {
            out.insert("credentialId".into(), Js::str(id));
        }
        Some(_) => return None,
    }
    if let Some(args) = map.get("constructionArgs") {
        let Js::Obj(args) = args else { return None };
        if !args.values().all(|v| matches!(v, Js::Str(_))) {
            return None;
        }
        out.insert("constructionArgs".into(), Js::Obj(args.clone()));
    }
    out.insert("handle".into(), Js::Str(handle));
    Some(Js::Obj(out))
}

/// `fileDescriptorOf`: the descriptor a plain value spells, when it spells one.
pub fn descriptor_of(value: &Js) -> Option<Obj> {
    let Js::Obj(map) = value else { return None };
    if !map.keys().all(|k| DESCRIPTOR_MEMBERS.contains(&k.as_str())) {
        return None;
    }
    if !["__brand", "source", "url"].iter().any(|k| map.contains_key(*k)) {
        return None;
    }
    if map.get("__brand").is_some_and(|b| b.as_str() != Some("FileRef")) {
        return None;
    }
    let mut out = obj! { "__brand" => Js::str("FileRef") };
    for key in ["name", "contentType"] {
        match map.get(key) {
            None => {}
            Some(v @ Js::Str(_)) => {
                out.insert(key.into(), v.clone());
            }
            Some(_) => return None,
        }
    }
    match map.get("size") {
        None => {}
        Some(v @ Js::Num(_)) => {
            out.insert("size".into(), v.clone());
        }
        Some(_) => return None,
    }
    let url = map.get("url");
    if url.is_some_and(|u| !matches!(u, Js::Null | Js::Str(_))) {
        return None;
    }
    if let Some(source) = map.get("source") {
        out.insert("source".into(), source_of(source)?);
    }
    if let Some(url) = url {
        out.insert("url".into(), url.clone());
    }
    Some(out)
}

/// `fileOwner`.
pub fn owner_of(source: Option<&Js>) -> Option<Owner> {
    let source = source?;
    let text = |key: &str| source.get(key).and_then(Js::as_str).map(str::to_string);
    if source.get("store").is_some() {
        return text("objectUri").map(|object_uri| Owner::Document { object_uri });
    }
    let handle = text("handle")?;
    if source.get("ownerAdapterType").is_some() {
        let owner = text("ownerAdapterType")?;
        return Some(if owner == DOCUMENT_STORE_OWNER {
            Owner::Document { object_uri: handle }
        } else {
            Owner::Adapter { adapter_type: owner, credential_id: None, handle }
        });
    }
    Some(Owner::Adapter { adapter_type: text("adapterType")?, credential_id: text("credentialId"), handle })
}

/// `wireSource`: the owner type and its handle.
pub fn wire_source(source: Option<&Js>) -> Option<Js> {
    Some(match owner_of(source)? {
        Owner::Document { object_uri } => Js::Obj(obj! { "ownerAdapterType" => Js::str(DOCUMENT_STORE_OWNER), "handle" => Js::Str(object_uri) }),
        Owner::Adapter { adapter_type, handle, .. } => Js::Obj(obj! { "ownerAdapterType" => Js::Str(adapter_type), "handle" => Js::Str(handle) }),
    })
}

/// `wireFile`: a descriptor in the wire's spelling.
pub fn wire_file(descriptor: &Obj) -> Js {
    let mut out = descriptor.clone();
    let source = out.shift_remove("source");
    if let Some(on_wire) = wire_source(source.as_ref()) {
        out.insert("source".into(), on_wire);
    }
    Js::Obj(out)
}

/// The file a resource's slot holds: the engine's file, or a descriptor it spells.
fn slot_file(slot: Option<&Hv>) -> Option<Obj> {
    match slot? {
        Hv::File { descriptor, .. } => Some(descriptor.clone()),
        other => descriptor_of(&other.js()),
    }
}

/// `wireResourceRecord`: a resource-shaped value with its `fileRef` slot (and
/// its `data.file`, the same file) in the wire's spelling.
pub fn wire_resource_record(value: &Hv) -> Js {
    let mut out = match value.js() {
        Js::Obj(map) => map,
        other => return other,
    };
    let Some(file) = slot_file(value.get("fileRef")).map(|d| wire_file(&d)) else { return Js::Obj(out) };
    out.insert("fileRef".into(), file.clone());
    if let Some(Js::Obj(data)) = out.get_mut("data")
        && data.contains_key("file")
    {
        data.insert("file".into(), file);
    }
    Js::Obj(out)
}

/// `wireResourceShaped`.
pub fn wire_resource_shaped(value: &Hv) -> Js {
    match value {
        Hv::Obj(_) => wire_resource_record(value),
        other => other.js(),
    }
}

/// `wirePosition`: a position with the files on its data, resources and
/// evidence in the wire's spelling.
pub fn wire_position(position: &Hv) -> Js {
    let mut out = match position.js() {
        Js::Obj(map) => map,
        other => return other,
    };
    if let Some(data) = position.get("identity").and_then(|i| i.get("data"))
        && let Some(Js::Obj(identity)) = out.get_mut("identity")
    {
        identity.insert("data".into(), wire_resource_shaped(data));
    }
    if let Some(Hv::List(resources)) = position.get("resources") {
        out.insert("resources".into(), Js::Arr(resources.iter().map(wire_resource_shaped).collect()));
    }
    if let Some(Hv::Obj(evidence)) = position.get("evidence") {
        let mut map = Obj::new();
        for (field, entry) in evidence {
            let mut written = entry.js();
            if let (Js::Obj(entry_out), Some(reference @ Hv::Obj(_))) = (&mut written, entry.get("sourceResourceRef")) {
                entry_out.insert("sourceResourceRef".into(), wire_resource_record(reference));
            }
            map.insert(field.clone(), written);
        }
        out.insert("evidence".into(), Js::Obj(map));
    }
    Js::Obj(out)
}

/// `ownedFileSource`.
pub fn owned_file_source(adapter_type: &str, credentials_id: &str, handle: &str) -> Js {
    Js::Obj(obj! { "adapterType" => Js::str(adapter_type), "credentialId" => Js::str(credentials_id), "handle" => Js::str(handle) })
}

/// A field type the engine named (`filesAt`), as the catalog spells one.
#[derive(Debug, Clone, PartialEq)]
pub enum FieldType {
    Scalar(String),
    List(Box<FieldType>),
    Dict(Box<FieldType>),
    MaybeAbsent(Box<FieldType>),
    Tuple(Vec<Option<FieldType>>),
}

const SCALAR_FIELD_TYPES: &[&str] = &["text", "number", "boolean", "date", "datetime", "file", "json", "absent"];

/// `schemaFieldTypeOf`.
pub fn field_type_of(value: &serde_json::Value) -> Option<FieldType> {
    if let Some(text) = value.as_str() {
        return SCALAR_FIELD_TYPES.contains(&text).then(|| FieldType::Scalar(text.to_string()));
    }
    let kind = value.get("kind").and_then(serde_json::Value::as_str)?;
    let of = value.get("of");
    match kind {
        "list" => Some(FieldType::List(Box::new(field_type_of(of?)?))),
        "dict" => Some(FieldType::Dict(Box::new(field_type_of(of?)?))),
        "maybeAbsent" => Some(FieldType::MaybeAbsent(Box::new(field_type_of(of?)?))),
        "tuple" => Some(FieldType::Tuple(of?.as_array()?.iter().map(|slot| if slot.is_null() { None } else { field_type_of(slot) }).collect())),
        _ => None,
    }
}

/// `filesAtType`: the value with every position the type calls a file made a
/// file in the segment's table.
pub fn files_at_type(wire: &mut Wire, ty: Option<&FieldType>, value: &Js) -> Hv {
    let Some(ty) = ty else { return Hv::of_js(value) };
    if matches!(value, Js::Null) {
        return Hv::Null;
    }
    match (ty, value) {
        (FieldType::Scalar(s), _) if s == "file" => match descriptor_of(value) {
            Some(descriptor) => wire.file(descriptor),
            None => Hv::of_js(value),
        },
        (FieldType::List(of), Js::Arr(items)) => Hv::List(items.iter().map(|m| files_at_type(wire, Some(of), m)).collect()),
        (FieldType::Tuple(slots), Js::Arr(items)) => {
            Hv::List(items.iter().enumerate().map(|(i, m)| files_at_type(wire, slots.get(i).and_then(Option::as_ref), m)).collect())
        }
        (FieldType::Dict(of), Js::Obj(_)) => match Hv::of_js(value) {
            Hv::Obj(entries) => Hv::Obj(entries.into_iter().map(|(k, m)| (k, files_at_type(wire, Some(of), &m.js()))).collect()),
            other => other,
        },
        (FieldType::MaybeAbsent(of), _) => files_at_type(wire, Some(of), value),
        _ => Hv::of_js(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn js(text: &str) -> Js {
        Js::parse(text.as_bytes()).unwrap()
    }

    #[test]
    fn a_descriptor_is_only_a_plain_object_of_descriptor_members() {
        assert!(descriptor_of(&js(r#"{"name":"a","url":"http://x"}"#)).is_some());
        assert!(descriptor_of(&js(r#"{"name":"a"}"#)).is_none());
        assert!(descriptor_of(&js(r#"{"url":"http://x","other":1}"#)).is_none());
        assert!(descriptor_of(&js(r#"{"__brand":"Other"}"#)).is_none());
        assert_eq!(
            Js::Obj(descriptor_of(&js(r#"{"url":"u","source":{"handle":"h","ownerAdapterType":"crm"},"name":"n"}"#)).unwrap()).to_json(),
            r#"{"__brand":"FileRef","name":"n","source":{"ownerAdapterType":"crm","handle":"h"},"url":"u"}"#
        );
    }

    #[test]
    fn the_wire_spells_a_file_by_its_owner_type_never_its_credential() {
        let stored = descriptor_of(&js(r#"{"__brand":"FileRef","name":"r.txt","source":{"store":"document","objectUri":"lf-files:k"}}"#)).unwrap();
        assert_eq!(wire_file(&stored).to_json(), r#"{"__brand":"FileRef","name":"r.txt","source":{"ownerAdapterType":"document-store","handle":"lf-files:k"}}"#);
        let owned = descriptor_of(&js(r#"{"source":{"adapterType":"crm","credentialId":"acme","handle":"h"}}"#)).unwrap();
        assert_eq!(wire_file(&owned).to_json(), r#"{"__brand":"FileRef","source":{"ownerAdapterType":"crm","handle":"h"}}"#);
    }

    #[test]
    fn files_are_made_only_where_the_type_declares_them() {
        let mut wire = Wire::default();
        let value = js(r#"[{"url":"u"},"plain"]"#);
        let made = files_at_type(&mut wire, Some(&FieldType::List(Box::new(FieldType::Scalar("file".into())))), &value);
        assert!(matches!(&made, Hv::List(items) if matches!(items[0], Hv::File { id: 0, .. }) && items[1] == Hv::Str("plain".into())));
        let text = files_at_type(&mut wire, Some(&FieldType::Scalar("text".into())), &js(r#"{"url":"u"}"#));
        assert!(matches!(text, Hv::Obj(_)));
    }
}
