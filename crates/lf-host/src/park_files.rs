//! A parked state's files, made host-side so the engine is handed each one's
//! opaque handle and never its descriptor (movement-engine `rust_wire.ts`
//! `filesInParkState`, `filesInBranchExports`). The walk follows the park's
//! STRUCTURE, never a list of key names: a scope's `bindings`, a closure's
//! `captured` and an edge map are keyed by the author's names, so they are
//! walked as maps of descriptors whatever the names are, and each descriptor
//! is read by its `kind`. A file is made only where the structure says one
//! is: a `{ kind: 'file' }` value descriptor and a resource's `fileRef` slot
//! (with its `data.file`). Data and code are never read into.

use crate::file_ref::descriptor_of;
use crate::wire::{Hv, Wire};

fn member<'a>(value: &'a mut Hv, key: &str) -> Option<&'a mut Hv> {
    match value {
        Hv::Obj(entries) => entries.iter_mut().rev().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn kind(value: &Hv) -> Option<String> {
    value.get("kind").and_then(Hv::as_str).map(str::to_string)
}

/// Each entry of a map keyed by the author's names.
fn each_entry(value: Option<&mut Hv>, mut walk: impl FnMut(&mut Hv)) {
    if let Some(Hv::Obj(entries)) = value {
        entries.iter_mut().for_each(|(_, v)| walk(v));
    }
}

fn each_item(value: Option<&mut Hv>, mut walk: impl FnMut(&mut Hv)) {
    if let Some(Hv::List(items)) = value {
        items.iter_mut().for_each(&mut walk);
    }
}

/// A descriptor at a place that declares a file, made one.
fn make_file(wire: &mut Wire, value: &mut Hv) {
    if let Some(descriptor) = descriptor_of(&value.js()) {
        *value = wire.file(descriptor);
    }
}

/// `filesInParkState`.
pub fn in_park_state(wire: &mut Wire, state: &mut Hv) {
    if !matches!(state, Hv::Obj(_)) {
        return;
    }
    each_item(member(state, "scopeChain"), |scope| scope_files(wire, scope));
    each_item(member(state, "journal"), |event| journal_event_files(wire, event));
    each_item(member(state, "frames"), |frame| frame_files(wire, frame));
}

/// `filesInBranchExports`: every object member of a row's exports is a
/// binding descriptor.
pub fn in_branch_exports(wire: &mut Wire, rows: &mut Hv) {
    each_item(Some(rows), |row| {
        each_entry(member(row, "exports"), |entry| {
            if matches!(entry, Hv::Obj(_)) {
                descriptor_files(wire, entry);
            }
        });
    });
}

fn bindings_files(wire: &mut Wire, bindings: Option<&mut Hv>) {
    each_entry(bindings, |entry| descriptor_files(wire, entry));
}

fn scope_files(wire: &mut Wire, scope: &mut Hv) {
    if !matches!(scope, Hv::Obj(_)) {
        return;
    }
    bindings_files(wire, member(scope, "bindings"));
    if let Some(parent) = member(scope, "parent") {
        scope_link_files(wire, parent);
    }
}

fn scope_link_files(wire: &mut Wire, link: &mut Hv) {
    if kind(link).as_deref() == Some("scope") {
        bindings_files(wire, member(link, "bindings"));
        if let Some(parent) = member(link, "parent") {
            scope_link_files(wire, parent);
        }
    }
}

fn journal_event_files(wire: &mut Wire, event: &mut Hv) {
    if let Some(value @ Hv::Obj(_)) = member(event, "value") {
        descriptor_files(wire, value);
    }
}

fn frame_files(wire: &mut Wire, frame: &mut Hv) {
    // A member frame's `op` is code; a run-time arm's `body` is code.
    if matches!(kind(frame).as_deref(), Some("call" | "member")) {
        each_item(member(frame, "scopeChain"), |scope| scope_files(wire, scope));
        each_item(member(frame, "journal"), |event| journal_event_files(wire, event));
    }
}

fn walk_files(wire: &mut Wire, walk: &mut Hv) {
    // The walk's `head` and `mapping` are code.
    bindings_files(wire, member(walk, "captured"));
}

fn value_files(wire: &mut Wire, value: &mut Hv) {
    match kind(value).as_deref() {
        Some("file") => {
            if let Some(file) = member(value, "file") {
                make_file(wire, file);
            }
        }
        Some("record") => {
            if let Some(binding) = member(value, "binding") {
                descriptor_files(wire, binding);
            }
        }
        Some("list") => each_item(member(value, "of"), |item| value_files(wire, item)),
        Some("map") => each_entry(member(value, "of"), |entry| value_files(wire, entry)),
        _ => {}
    }
}

fn file_fields_files(wire: &mut Wire, file_fields: Option<&mut Hv>) {
    each_entry(file_fields, |entry| value_files(wire, entry));
}

fn emission_files(wire: &mut Wire, emission: &mut Hv) {
    // `fields`, `provenance` and `origin` are data.
    file_fields_files(wire, member(emission, "fileFields"));
    each_item(member(emission, "resources"), |resource| resource_files(wire, resource));
    each_entry(member(emission, "children"), |list| each_item(Some(list), |child| emission_files(wire, child)));
}

fn descriptor_files(wire: &mut Wire, descriptor: &mut Hv) {
    match kind(descriptor).as_deref() {
        // `handle` (the record written) and `graph` are data.
        Some("handle") => {
            if let Some(old) = member(descriptor, "old") {
                descriptor_files(wire, old);
            }
        }
        Some("extractRoot" | "extractPosition") => {
            if let Some(emission) = member(descriptor, "emission") {
                emission_files(wire, emission);
            }
        }
        Some("resource") => {
            if let Some(resource) = member(descriptor, "resource") {
                resource_files(wire, resource);
            }
        }
        Some("blockMeta") => each_entry(member(descriptor, "edges"), |landings| each_item(Some(landings), |l| descriptor_files(wire, l))),
        Some("positions") => each_item(member(descriptor, "landings"), |l| descriptor_files(wire, l)),
        Some("tuple") => each_item(member(descriptor, "slots"), |s| descriptor_files(wire, s)),
        // A closure's `closure` is code; its capture is a map of descriptors,
        // and its scope a scope link.
        Some("closure") => {
            bindings_files(wire, member(descriptor, "captured"));
            if let Some(scope) = member(descriptor, "scope") {
                scope_link_files(wire, scope);
            }
        }
        Some("recordValue") => {
            if let Some(value) = member(descriptor, "value") {
                value_files(wire, value);
            }
        }
        // `fields` and `fieldProvenance` are data.
        Some("shapePosition") => file_fields_files(wire, member(descriptor, "fileFields")),
        Some("nodePosition") => {
            file_fields_files(wire, member(descriptor, "fileFields"));
            each_entry(member(descriptor, "edges"), |edge| edge_files(wire, edge));
            each_item(member(descriptor, "resources"), |resource| resource_files(wire, resource));
        }
        Some("lazyWalk") => {
            if let Some(walk) = member(descriptor, "walk") {
                walk_files(wire, walk);
            }
        }
        // Data or code throughout (`event`, `instance`, `value`, `callback`,
        // `movement`, …): nothing in them is a file.
        _ => {}
    }
}

fn edge_files(wire: &mut Wire, edge: &mut Hv) {
    match kind(edge).as_deref() {
        // `landing` / `landingShape` are the shape a later write mints from.
        Some("landed") => each_item(member(edge, "landings"), |l| descriptor_files(wire, l)),
        Some("deferred") => {
            if let Some(walk) = member(edge, "walk") {
                walk_files(wire, walk);
            }
        }
        _ => {}
    }
}

/// A parked resource with its `fileRef` slot (and `data.file`) a file.
fn resource_files(wire: &mut Wire, resource: &mut Hv) {
    let Some(descriptor) = resource.get("fileRef").and_then(|slot| descriptor_of(&slot.js())) else { return };
    let file = wire.file(descriptor);
    if let Some(slot) = member(resource, "fileRef") {
        *slot = file.clone();
    }
    if let Some(data @ Hv::Obj(_)) = member(resource, "data")
        && let Some(inner) = member(data, "file")
    {
        *inner = file;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::Js;

    fn hv(text: &str) -> Hv {
        Hv::of_js(&Js::parse(text.as_bytes()).unwrap())
    }

    #[test]
    fn a_file_value_in_a_scope_is_made_a_file_and_data_beside_it_is_not() {
        let mut wire = Wire::default();
        let mut state = hv(
            r#"{"version":2,"address":"s1","scopeChain":[{"bindings":{
                "f":{"kind":"recordValue","value":{"kind":"file","file":{"__brand":"FileRef","name":"a.txt","source":{"store":"document","objectUri":"lf-files:k"}}}},
                "d":{"kind":"value","value":{"__brand":"FileRef","name":"looks like one"}}
            }}]}"#,
        );
        in_park_state(&mut wire, &mut state);
        let written = wire.write(&state).to_string();
        assert!(written.contains(r#"["F",0,{"handle":"lf-files:k","name":"a.txt"}]"#), "{written}");
        assert!(written.contains(r#"["name","looks like one"]"#), "{written}");
        assert!(wire.files.get(1).is_none());
    }
}
