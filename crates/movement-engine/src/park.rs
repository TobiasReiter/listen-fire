//! A flow parked and resumed: serialize.ts's `ParkedScopeState` (version 1),
//! written and read exactly as the TypeScript engine writes and reads it, so
//! a run parked by either engine resumes on either.
//!
//! - **Park** (any await: `sleep`, `until`, a callback's landing, a
//!   combinator; and a suspension): one state for the whole run, written in
//!   the order serialize.ts writes it (`ParkWriter` numbers nodes and walks
//!   across the scope chain, the frames and the journal together): the
//!   leaf's address, `bindingName` (`presenceBind`, `until`), the scope
//!   chain root first, then `frames` innermost last — a call's (its site,
//!   finished calls, the callee's scope), a collection op's member, a
//!   combinator arm's (its join, `keepArmCount`).
//! - **Suspension** (run.ts `suspendFlow`): the flow stops just before a
//!   statement, its state `suspended`, with a `journal` of the calls the
//!   statement had finished. A flow suspends when the run meets its cost cap
//!   (`suspendAtLimit`, which first marks the run paused, `commitLimitPause`),
//!   at each statement of a run already paused (`limitPaused`), and at a
//!   `suspendAt` address (before a statement, or before its k-th call). A
//!   host whose sink cannot suspend (it serves no `commitSuspension`, read
//!   off `SegmentInput::serves`) is asked nothing, and the run goes on (a
//!   pause), fails on its cap, or fails for want of a park (`suspendAt`), as
//!   the TypeScript does.
//! - **Resume** is `resume.rs` (`resumeAlongAddress`).
//!
//! `resume_refusal` refuses only a state that does not read, another
//! version, a malformed `suspended`, and the two binding kinds this engine
//! does not rebuild (`blockMeta`, `localShape`), before the run asks its
//! host for anything; the shim then resumes it on the TypeScript engine.

use std::cell::RefCell;
use std::rc::Rc;

use movement_parser::ast;
use serde::Deserialize;
use serde_json::Value as Json;

use crate::bindings::{Binding, Handle, InstanceBinding, LandingShape, Node, Scope};
use crate::env::Trail;
use crate::env::{json_round_trip, object_of};
use crate::host;
use crate::ledger::CapExceeded;
use crate::trace::TraceEntry;
use crate::js::{Js, JsObject};
use crate::flow::{Boundary, CallRecord};
use crate::run::{Address, Failure, Run, Stop};

/// What a resumed segment is handed (`ResumeMovementInput`'s state and mode).
#[derive(Debug, Clone, Deserialize)]
pub struct ResumeInput {
    /// On the eval wire (crate::env): its objects in their stored key order.
    pub state: Json,
    /// Re-enter AT the parked statement rather than step past it.
    #[serde(default)]
    pub reenter: bool,
    /// What to bind at the leaf on a step-past resume (an ask's answer), on
    /// the eval wire.
    #[serde(default)]
    pub answer: Option<Json>,
    /// A batch resume: a race arm that completes defers the race's
    /// settlement to the host (`deferRaceSettlement`).
    #[serde(default, rename = "deferRaceSettlement")]
    pub defer_race_settlement: bool,
}

/// What a park's state says between its `bindingName` and its scope chain.
pub(crate) enum Leaf<'a> {
    /// A `sleep`: `presenceBind` for `x = await sleep(…)`.
    Timer { presence: bool },
    /// An `await until(…)`'s timer: re-entered to test its condition again.
    Until,
    /// An await on an edge (a callback's, an awaitable adapter's) or a
    /// callback's captured continuation: nothing between.
    Plain,
    /// An engine-initiated suspension, with the statement's finished calls.
    Suspended(&'a [(usize, CallRecord)]),
}

/// A park's state (run.ts `parkedState`), as the JavaScript object the
/// TypeScript writes — every key in its order (it crosses to the host on the
/// eval wire): `{version: 1, address, bindingName, …, scopeChain}`, then the
/// body boundaries the flow is inside (`frames`), when it is inside any. One
/// park's node table runs through the whole state, in the order it is
/// written.
pub(crate) fn park_state(run: &Run<'_>, address: &str, binding_name: Option<&str>, leaf: Leaf<'_>, scope: &Rc<Scope>) -> Result<Js, Failure> {
    one_park(|park| park_state_in(run, address, binding_name, &leaf, scope, park))
}

fn park_state_in(run: &Run<'_>, address: &str, binding_name: Option<&str>, leaf: &Leaf<'_>, scope: &Rc<Scope>, park: &mut ParkWriter) -> Result<Js, Failure> {
    let boundaries = run.boundaries.borrow().clone();
    // The frames' chains are written after the leaf's: a closure the leaf
    // reaches that holds one of their scopes names it, rather than writing it.
    for boundary in &boundaries {
        match boundary {
            Boundary::Call { site, .. } | Boundary::Member { site, .. } => park.carries_chain(&site.scope.chain_from_root()),
            Boundary::Arm { .. } => {}
        }
    }
    let mut state = vec![("version", Js::Number(1.0)), ("address", Js::str(address)), ("bindingName", binding_name.map_or(Js::Null, Js::str))];
    match *leaf {
        Leaf::Timer { presence: true } => state.push(("presenceBind", Js::Bool(true))),
        Leaf::Timer { presence: false } | Leaf::Plain => {}
        Leaf::Until => state.push(("until", Js::Bool(true))),
        Leaf::Suspended(journal) => {
            state.push(("suspended", Js::Bool(true)));
            state.push(("journal", serialize_journal(run, journal, park)?));
        }
    }
    state.push(("scopeChain", scope_chain(run, scope, park)?));
    if !boundaries.is_empty() {
        let frames = boundaries.iter().map(|boundary| serialize_boundary(run, boundary, park)).collect::<Result<Vec<_>, _>>()?;
        state.push(("frames", Js::array(frames)));
    }
    Ok(object_of(state))
}

/// `{version: 1, address, bindingName, presenceBind?, scopeChain}`: a
/// `sleep`'s park.
pub(crate) fn parked_state(run: &Run<'_>, address: &str, presence: Option<&str>, scope: &Rc<Scope>) -> Result<Js, Failure> {
    park_state(run, address, presence, Leaf::Timer { presence: presence.is_some() }, scope)
}

/// `{version: 1, address, bindingName: null, suspended: true, journal,
/// scopeChain}`, as `suspendFlow` writes it: the journal every call the
/// statement has handed back, those a re-run had still to replay among them.
pub(crate) fn suspended_state(run: &Run<'_>, address: &str, scope: &Rc<Scope>) -> Result<Js, Failure> {
    let journal = run.call_sites.borrow().last().map(|site| site.calls.borrow().journal()).unwrap_or_default();
    park_state(run, address, None, Leaf::Suspended(&journal), scope)
}

/// The scopes root first, as one park writes them.
fn scope_chain(run: &Run<'_>, scope: &Rc<Scope>, park: &mut ParkWriter) -> Result<Js, Failure> {
    let chain = scope.chain_from_root();
    park.carries_chain(&chain);
    Ok(Js::array(chain.iter().map(|s| serialize_scope(run, s, park)).collect::<Result<_, _>>()?))
}

/// `serializeCallRecords`: a statement's finished calls, by index.
fn serialize_journal(run: &Run<'_>, journal: &[(usize, CallRecord)], park: &mut ParkWriter) -> Result<Js, Failure> {
    let mut events = Vec::with_capacity(journal.len());
    for (index, record) in journal {
        let value = match &record.value {
            Some(binding) => serialize_binding(run, "", binding, park)?,
            None => Js::Null,
        };
        events.push(object_of(vec![("index", Js::Number(*index as f64)), ("value", value), ("next", Js::Number(record.next as f64))]));
    }
    Ok(Js::array(events))
}

/// `serializeBoundary`: a live body boundary as a park keeps it.
fn serialize_boundary(run: &Run<'_>, boundary: &Boundary, park: &mut ParkWriter) -> Result<Js, Failure> {
    let kind = |k: &str| ("kind", Js::str(k));
    Ok(match boundary {
        Boundary::Call { site, index, next, callee } => {
            let journal = site.calls.borrow().finished();
            object_of(vec![
                kind("call"),
                ("index", Js::Number(*index as f64)),
                ("next", Js::Number(*next as f64)),
                ("callee", Js::str(callee.clone())),
                ("journal", serialize_journal(run, &journal, park)?),
                ("scopeChain", scope_chain(run, &site.scope, park)?),
            ])
        }
        Boundary::Member { site, index, next, member, op } => {
            let journal = site.calls.borrow().finished();
            object_of(vec![
                kind("member"),
                ("index", Js::Number(*index as f64)),
                ("next", Js::Number(*next as f64)),
                ("member", Js::Number(*member as f64)),
                ("op", op.json.clone()),
                ("journal", serialize_journal(run, &journal, park)?),
                ("scopeChain", scope_chain(run, &site.scope, park)?),
            ])
        }
        Boundary::Arm { arm, body } => object_of(vec![kind("arm"), ("arm", Js::Number(*arm as f64)), ("body", run.program_code(&body.path)?)]),
    })
}

/// One binding written alone, as its own park that knows the program's
/// files (`serializeBinding(value, this.newPark())`): a branch's returned
/// value.
pub(crate) fn serialize_alone(run: &Run<'_>, binding: &Binding) -> Result<Js, Failure> {
    one_park(|park| serialize_binding(run, "", binding, park))
}

/// One binding written alone by a park that knows no program
/// (`serializeBinding(value)`, a bare `newParkWriter()`): a collection op's
/// kept member and its start. Such a park takes any scope nested in none
/// for a file's, and names no library.
pub(crate) fn serialize_alone_plain(run: &Run<'_>, binding: &Binding) -> Result<Js, Failure> {
    one_park(|park| {
        park.plain = true;
        serialize_binding(run, "", binding, park)
    })
}

/// A completed branch's exports (`serializeBranchExport`): one stored
/// state, so ONE park writes every name — a handle or node two of them hold
/// is written once and referenced after — the returned value first, as the
/// name the join reads back on its own: its descriptors hold every first
/// sighting, so it never refers into a name that is not read.
pub(crate) fn serialize_together(run: &Run<'_>, bindings: &[(String, Binding)]) -> Result<Js, Failure> {
    let mut ordered: Vec<&(String, Binding)> = bindings.iter().collect();
    ordered.sort_by_key(|(name, _)| name != crate::run::RETURN_SLOT);
    one_park(|park| {
        let mut out = JsObject::new();
        for (name, binding) in &ordered {
            out.set(name.clone(), serialize_binding(run, "", binding, park)?);
        }
        Ok(Js::object(out))
    })
}

/// What one park has written (`ParkWriter`): the nodes, numbered as first
/// reached and held so they outlive the writing that numbers them; and the
/// write handles, each written once (a handle is held by reference: an
/// in-place write and `refresh` move it under every name that holds it).
/// A handle is numbered only when it is reached a second time, and its
/// FIRST descriptor carries that `id` (last, as serialize.ts back-patches
/// it), so a park that holds each handle once writes exactly the bytes it
/// always did.
#[derive(Default)]
pub(crate) struct ParkWriter {
    nodes: Vec<Rc<RefCell<crate::bindings::Node>>>,
    /// Each handle written so far, in first-sighting order, with its number
    /// once a second sighting gave it one.
    handles: Vec<(Rc<Handle>, Option<usize>)>,
    handle_ids: usize,
    /// The numbers an earlier pass over the same state gave: what each
    /// handle's first descriptor says (`id`).
    known: Vec<(Rc<Handle>, usize)>,
    /// Each scope a closure held, by its number (`scopeIds`), with the link
    /// to the scope it is nested in that its chain copies say (`parent`). A
    /// scope is numbered the first time a closure reaches it, so a park
    /// holding none writes exactly the bytes it always did.
    scope_ids: Vec<(Rc<Scope>, usize, Option<Js>)>,
    /// The scopes a parked chain has written a copy of (`scopeCopies`).
    scope_copied: Vec<Rc<Scope>>,
    /// The scopes a parked chain carries, or will (`chainScopes`): a closure
    /// that holds one names it, and never writes it a second time.
    chain_scopes: Vec<Rc<Scope>>,
    /// The numbers an earlier pass gave each scope: what every chain copy of
    /// it says (`id`, `parent`). The TypeScript back-patches a copy written
    /// before its scope was numbered; this engine writes the state again.
    known_scopes: Vec<(Rc<Scope>, usize, Option<Js>)>,
    /// A park that knows no program (a bare `newParkWriter()`): a scope is a
    /// file's when it is nested in none, and its link names no library.
    plain: bool,
}

impl ParkWriter {
    /// `carriesChain`.
    fn carries_chain(&mut self, chain: &[Rc<Scope>]) {
        for scope in chain {
            if !self.chain_scopes.iter().any(|s| Rc::ptr_eq(s, scope)) {
                self.chain_scopes.push(scope.clone());
            }
        }
    }

    /// `isFileScopeIn`.
    fn is_file_scope(&self, scope: &Scope) -> bool {
        if self.plain { scope.outer().is_none() } else { scope.is_file_scope() }
    }

    fn scope_id(&self, scope: &Rc<Scope>) -> Option<usize> {
        self.scope_ids.iter().find(|(s, _, _)| Rc::ptr_eq(s, scope)).map(|(_, id, _)| *id)
    }
}

/// One park, written whole. The TypeScript back-patches a handle's `id`
/// onto its first descriptor when a later sighting numbers it; this
/// engine's descriptors are built immutably, so a state whose handles were
/// numbered is written again, each first descriptor then saying the number
/// the first pass gave it (the walk is the same, so the numbers are).
fn one_park(write: impl Fn(&mut ParkWriter) -> Result<Js, Failure>) -> Result<Js, Failure> {
    let mut park = ParkWriter::default();
    let written = write(&mut park)?;
    let known: Vec<(Rc<Handle>, usize)> = park.handles.into_iter().filter_map(|(handle, id)| id.map(|id| (handle, id))).collect();
    // A copy of a numbered scope written before it was numbered says its
    // number only on the second pass; one written after says it on both.
    let renumber_scopes = park.scope_ids.iter().any(|(scope, _, _)| park.scope_copied.iter().any(|s| Rc::ptr_eq(s, scope)));
    if known.is_empty() && !renumber_scopes {
        return Ok(written);
    }
    write(&mut ParkWriter { known, known_scopes: park.scope_ids, plain: park.plain, ..ParkWriter::default() })
}

/// The number `written` has in this park, numbering it if it is new.
fn number(park: &mut ParkWriter, written: Rc<RefCell<crate::bindings::Node>>) -> Result<usize, usize> {
    match park.nodes.iter().position(|p| Rc::ptr_eq(p, &written)) {
        Some(id) => Err(id),
        None => {
            park.nodes.push(written);
            Ok(park.nodes.len() - 1)
        }
    }
}

/// `serializeScope`: a chain copy of one scope — its own bindings, and,
/// when a closure holds it by number, that number and the scope it is nested
/// in. A file's own scope is written as it always was, never numbered.
fn serialize_scope(run: &Run<'_>, scope: &Rc<Scope>, park: &mut ParkWriter) -> Result<Js, Failure> {
    // Registered before its bindings are written: a closure in it holds it,
    // and names it.
    if !park.is_file_scope(scope) && !park.scope_copied.iter().any(|s| Rc::ptr_eq(s, scope)) {
        park.scope_copied.push(scope.clone());
    }
    let mut members = vec![("bindings", Js::object(write_bindings(run, scope, park)?))];
    if !park.is_file_scope(scope) {
        let numbered = park.known_scopes.iter().chain(park.scope_ids.iter()).find(|(s, _, _)| Rc::ptr_eq(s, scope)).map(|(_, id, parent)| (*id, parent.clone()));
        if let Some((id, parent)) = numbered {
            members.push(("id", Js::Number(id as f64)));
            if let Some(parent) = parent {
                members.push(("parent", parent));
            }
        }
    }
    Ok(object_of(members))
}

/// One scope's OWN bindings (`writeBindings`), an import named by its slot.
fn write_bindings(run: &Run<'_>, scope: &Rc<Scope>, park: &mut ParkWriter) -> Result<JsObject, Failure> {
    let mut bindings = JsObject::new();
    for (name, binding) in scope.own_bindings() {
        bindings.set(name.clone(), serialize_binding(run, &name, &binding, park)?);
    }
    Ok(bindings)
}

/// `scopeRefOf`: where a numbered scope is — by number, or a file's by its
/// file.
fn scope_ref_of(park: &ParkWriter, scope: &Rc<Scope>) -> Result<Js, Failure> {
    if park.is_file_scope(scope) {
        let file = if park.plain { None } else { scope.own_file() };
        return Ok(file_link(file.unwrap_or(&crate::program::DeclaringFile::Root)));
    }
    let id = park.scope_id(scope).ok_or_else(|| Failure::engine("MOVENG_RUNTIME", "park: a scope was named before it was numbered".to_string()))?;
    Ok(object_of(vec![("kind", Js::str("scopeRef")), ("id", Js::Number(id as f64))]))
}

/// `{kind: 'file', file?}`: a file's own scope, found again in the
/// re-parsed program.
fn file_link(file: &crate::program::DeclaringFile) -> Js {
    object_of(with_file(vec![("kind", Js::str("file"))], file))
}

/// `scopeLinkOf`: the scope a body closure holds, as the park writes it — by
/// number when the park has numbered it or a chain carries it, a file's by
/// its file, and otherwise written here, once. Numbering a scope numbers the
/// scopes it is nested in, up to its file's.
fn scope_link_of(run: &Run<'_>, scope: &Rc<Scope>, park: &mut ParkWriter) -> Result<Js, Failure> {
    if park.is_file_scope(scope) || park.scope_id(scope).is_some() {
        return scope_ref_of(park, scope);
    }
    let id = park.scope_ids.len();
    park.scope_ids.push((scope.clone(), id, None));
    let outer = scope.outer().cloned();
    let parent = match &outer {
        Some(outer) => Some(scope_link_of(run, outer, park)?),
        None => None,
    };
    // The copies say where it is nested by reference: the scope it is nested
    // in is numbered now, and written once wherever it was.
    let parent_ref = match &outer {
        Some(outer) => Some(scope_ref_of(park, outer)?),
        None => None,
    };
    if let Some(slot) = park.scope_ids.iter_mut().find(|(s, _, _)| Rc::ptr_eq(s, scope)) {
        slot.2 = parent_ref;
    }
    let reference = object_of(vec![("kind", Js::str("scopeRef")), ("id", Js::Number(id as f64))]);
    if park.scope_copied.iter().any(|s| Rc::ptr_eq(s, scope)) || park.chain_scopes.iter().any(|s| Rc::ptr_eq(s, scope)) {
        return Ok(reference);
    }
    let mut members = vec![("kind", Js::str("scope")), ("id", Js::Number(id as f64))];
    if let Some(parent) = parent {
        members.push(("parent", parent));
    }
    members.push(("bindings", Js::object(write_bindings(run, scope, park)?)));
    Ok(object_of(members))
}

/// `serializeBinding`, for the kinds this engine binds.
fn serialize_binding(run: &Run<'_>, name: &str, binding: &Binding, park: &mut ParkWriter) -> Result<Js, Failure> {
    let kind = |k: &str| ("kind", Js::str(k));
    Ok(match binding {
        Binding::Node(node) => {
            // Numbered before its edges are walked: an edge back here is a
            // reference, not another lap.
            let id = match number(park, node.clone()) {
                Ok(id) => id,
                Err(id) => return Ok(object_of(vec![kind("nodeRef"), ("id", Js::Number(id as f64))])),
            };
            let node = node.borrow();
            let mut edges = JsObject::new();
            for (name, edge) in &node.edges {
                if let Some(walk) = &edge.deferred {
                    edges.set(name.clone(), object_of(vec![kind("deferred"), ("walk", serialize_deferred_walk(run, walk, park)?)]));
                    continue;
                }
                let landings: Vec<Js> = edge.landings.iter().map(|l| serialize_binding(run, "", l, park)).collect::<Result<_, _>>()?;
                let mut descriptor = vec![kind("landed"), ("landings", Js::array(landings))];
                if let Some(shape) = &edge.shape {
                    descriptor.push(("landing", landing_shape_js(shape)));
                }
                edges.set(name.clone(), object_of(descriptor));
            }
            let mut provenance = JsObject::new();
            for (field, trail) in &node.field_provenance {
                provenance.set(field.clone(), provenance_of(run, trail));
            }
            let mut members = vec![
                kind("nodePosition"),
                ("id", Js::Number(id as f64)),
                ("fields", Js::object(JsObject::clone_of(&node.fields))),
                ("fieldOrder", Js::array(node.field_order.iter().map(|f| Js::str(f.clone())).collect())),
            ];
            if let Some(files) = crate::file::file_fields_of(&node.fields) {
                members.push(("fileFields", files));
            }
            members.push(("fieldProvenance", Js::object(provenance)));
            if let Some(edge) = &node.landed_on {
                members.push(("landedOn", Js::str(edge.clone())));
            }
            members.push(("edges", Js::object(edges)));
            object_of(members)
        }
        Binding::LazyWalk(walk) => object_of(vec![kind("lazyWalk"), ("walk", serialize_deferred_walk(run, walk, park)?)]),
        Binding::Tuple(slots) => {
            let slots: Vec<Js> = slots.iter().map(|slot| serialize_binding(run, "", slot, park)).collect::<Result<_, _>>()?;
            object_of(vec![kind("tuple"), ("slots", Js::array(slots))])
        }
        // Its body rides across as AST, its capture by the ordinary rules.
        // One bound at a file's top level: a declaration of the program,
        // written by its name (and its library) and found again there,
        // never its body or the file scope it holds.
        Binding::Closure(closure) if closure.file_name.is_some() => {
            let name = closure.file_name.clone().unwrap_or_default();
            object_of(with_file(vec![kind("fileClosure"), ("name", Js::str(name))], &closure.captured.written_in()))
        }
        // One written in a body holds its scope by reference: its code, an
        // empty capture, and a link to the scope (`scope`).
        Binding::Closure(closure) if closure.by_reference => {
            let mut members = vec![kind("closure"), ("closure", run.program_code(&closure.code.path)?), ("captured", Js::object(JsObject::new()))];
            if let Some(name) = &closure.self_name {
                members.push(("self", Js::str(name.clone())));
            }
            members.push(("scope", scope_link_of(run, &closure.captured, park)?));
            object_of(members)
        }
        Binding::Closure(closure) => {
            let mut members = vec![kind("closure"), ("closure", run.program_code(&closure.code.path)?), ("captured", serialize_captured(run, &closure.captured, park)?)];
            if let Some(name) = &closure.self_name {
                members.push(("self", Js::str(name.clone())));
            }
            object_of(members)
        }
        Binding::Event => object_of(vec![kind("event")]),
        Binding::Instance(instance) => object_of(vec![kind("instance"), ("instance", identity(instance))]),
        Binding::Opaque => object_of(vec![kind("opaque"), ("what", Js::str("import")), ("name", Js::str(name))]),
        // Code refs: the name, and the library it is declared in, where a
        // resume finds it again (serialize.ts `declaringFile`).
        Binding::Movement(movement) => object_of(with_file(vec![kind("movement"), ("name", Js::str(movement.name.clone()))], &movement.file)),
        // One declared in a body has no name to re-resolve by: its
        // declaration rides across (serialize.ts `localShape`).
        Binding::Shape(shape) if shape.local => object_of(vec![kind("localShape"), ("declaration", crate::env::js_of_json(&serde_json::to_value(&shape.declared.declaration).expect("an AST is always JSON")))]),
        Binding::Shape(shape) => object_of(with_file(vec![kind("shape"), ("name", Js::str(shape.declared.declaration.name.clone()))], &shape.declared.file)),
        // A plugin travels as the import it is, re-resolved by its slot name.
        Binding::Plugin(_) => object_of(vec![kind("opaque"), ("what", Js::str("a plugin")), ("name", Js::str(name))]),
        Binding::Handle(handle) => {
            // Reached again: a reference to the one handle, numbered now.
            if let Some(slot) = park.handles.iter().position(|(h, _)| Rc::ptr_eq(h, handle)) {
                let id = match park.handles[slot].1 {
                    Some(id) => id,
                    None => {
                        let id = park.handle_ids;
                        park.handle_ids += 1;
                        park.handles[slot].1 = Some(id);
                        id
                    }
                };
                return Ok(object_of(vec![kind("handleRef"), ("id", Js::Number(id as f64))]));
            }
            // Registered before its `old` is walked, as a node is before its
            // edges.
            park.handles.push((handle.clone(), None));
            let mut members = vec![
                kind("handle"),
                ("handle", handle.record().object.clone()),
                ("targetType", Js::str(handle.target_type.clone())),
                ("graph", object_of(vec![kind("instance"), ("instance", identity(&handle.graph))])),
            ];
            // The record before its write (`-[:@old]->`), itself a handle; a
            // rehearsed write's is the handle itself, which JSON cannot nest.
            match handle.old() {
                crate::bindings::Old::Nothing => {}
                crate::bindings::Old::Itself => members.push(("oldIsSelf", Js::Bool(true))),
                crate::bindings::Old::Was(old) => members.push(("old", serialize_binding(run, "", &Binding::Handle(old), park)?)),
            }
            if let Some((_, id)) = park.known.iter().find(|(h, _)| Rc::ptr_eq(h, handle)) {
                members.push(("id", Js::Number(*id as f64)));
            }
            object_of(members)
        }
        // `holdsRecords` recurses through a value that holds itself until
        // V8's stack runs out: the park fails as the TypeScript's does.
        Binding::Value(value) if crate::js::holds_itself(&value.value) => {
            return Err(Failure::Engine { class: crate::eval::ErrorClass::RangeError, message: crate::js::stack_overflow().message });
        }
        // A value that holds a record or a file anywhere is written down to
        // them (`holdsEngineValues`, `serializeValue`).
        Binding::Value(value) if crate::record::holds_records(&value.value) || crate::file::holds_file(&value.value) => {
            let mut descriptor = vec![kind("recordValue"), ("value", serialize_value(run, &value.value, park)?)];
            if let Some(trail) = &value.trail {
                descriptor.push(("provenance", provenance_of(run, trail)));
            }
            if value.many {
                descriptor.push(("many", Js::Bool(true)));
            }
            object_of(descriptor)
        }
        Binding::Value(value) => {
            // `assertJsonSerializable`: the value as it will come back.
            let mut descriptor = vec![kind("value"), ("value", json_serializable(&value.value, "value binding")?)];
            if let Some(trail) = &value.trail {
                descriptor.push(("provenance", provenance_of(run, trail)));
            }
            if value.many {
                descriptor.push(("many", Js::Bool(true)));
            }
            object_of(descriptor)
        }
        // A record a pick bound (`top = FIRST(…)`): admission refuses every
        // park inside a block, so no hop alias reaches here. Its read is
        // named only when it is not the event's source (the TypeScript binds
        // none there), and a pick keeps no edge properties.
        Binding::Landed(landed) => {
            let mut descriptor = vec![kind("sourcePosition"), ("position", json_round_trip(&landed.position()))];
            if let Some(properties) = &landed.edge_properties {
                descriptor.push(("edgeProperties", json_round_trip(properties)));
            }
            let from_source = run.source.borrow().as_ref().is_some_and(|source| Rc::ptr_eq(&source.read, &landed.read));
            if !from_source {
                descriptor.push(("read", object_of(vec![("instanceName", Js::str(landed.read.instance_name.clone()))])));
            }
            object_of(descriptor)
        }
        Binding::Positions(landings) => {
            let landings: Vec<Js> = landings.iter().map(|l| serialize_binding(run, "", l, park)).collect::<Result<_, _>>()?;
            object_of(vec![kind("positions"), ("landings", Js::array(landings))])
        }
        // Data only: the binding object as it stands.
        Binding::Callback(_) | Binding::ShapePosition(_) | Binding::Resource(_) => {
            crate::record::data_object(binding).expect("a callback, a shape position and a resource are data")
        }
        // The extraction ran: its output is data, never run again.
        Binding::Extracted { emission, root, .. } => object_of(vec![
            kind(if *root { "extractRoot" } else { "extractPosition" }),
            ("emission", emission.descriptor(&|id| run.origin(id))),
        ]),
    })
}

/// `declaringFile`: a library's path beside a code ref declared there; the
/// root program's says none.
fn with_file<'k>(mut members: Vec<(&'k str, Js)>, file: &crate::program::DeclaringFile) -> Vec<(&'k str, Js)> {
    if let crate::program::DeclaringFile::Library(path) = file {
        members.push(("file", Js::str(path.clone())));
    }
    members
}

/// A captured scope (`captured`, a flat `Map`), each binding by the
/// ordinary rules, an import named by its slot.
fn serialize_captured(run: &Run<'_>, captured: &Rc<Scope>, park: &mut ParkWriter) -> Result<Js, Failure> {
    let mut out = JsObject::new();
    for (name, binding) in captured.own_bindings() {
        out.set(name.clone(), serialize_binding(run, &name, &binding, park)?);
    }
    Ok(Js::object(out))
}

/// `serializeDeferredWalk`: the walk's head as the program holds it, the
/// scope it captured, and its per-item mapping when it has one.
fn serialize_deferred_walk(run: &Run<'_>, walk: &crate::bindings::DeferredWalk, park: &mut ParkWriter) -> Result<Js, Failure> {
    let mut members = vec![("head", run.program_code(&walk.head_path)?), ("captured", serialize_captured(run, &walk.captured, park)?)];
    if let Some((_, path)) = &walk.mapping {
        members.push(("mapping", run.program_code(path)?));
    }
    Ok(object_of(members))
}

/// `serializeValue`: a record as its own descriptor, a file as one (its
/// descriptor), a list or a map walked, anything else data.
fn serialize_value(run: &Run<'_>, value: &Js, park: &mut ParkWriter) -> Result<Js, Failure> {
    if let Some(record) = crate::record::binding_of(value) {
        return Ok(object_of(vec![("kind", Js::str("record")), ("binding", serialize_binding(run, "", &record, park)?)]));
    }
    Ok(match value {
        // The file itself: the wire hands the host its id, and the host parks
        // the descriptor it keeps.
        Js::File(_) => object_of(vec![("kind", Js::str("file")), ("file", value.clone())]),
        Js::Array(list) => {
            let of = list.items().iter().map(|item| serialize_value(run, item, park)).collect::<Result<Vec<_>, _>>()?;
            object_of(vec![("kind", Js::str("list")), ("of", Js::array(of))])
        }
        Js::Object(dict) => {
            // `of[key] = …`: an own `__proto__` key sets the prototype, which
            // the park's JSON leaves out.
            let mut of = JsObject::new();
            for (key, item) in dict.entries() {
                of.assign(key.clone(), serialize_value(run, item, park)?);
            }
            object_of(vec![("kind", Js::str("map")), ("of", Js::object(of))])
        }
        other => object_of(vec![("kind", Js::str("data")), ("value", json_serializable(other, "value binding")?)]),
    })
}

/// `assertJsonSerializable`: the value as `JSON.parse(JSON.stringify(…))`
/// hands it back, a function anywhere in it refused by the key it sits
/// under.
fn json_serializable(value: &Js, at: &str) -> Result<Js, Failure> {
    fn function_key(value: &Js, key: &str) -> Option<String> {
        match value {
            Js::Function(_) => Some(key.to_string()),
            Js::Array(list) => list.items().iter().enumerate().find_map(|(i, item)| function_key(item, &i.to_string())),
            Js::Object(object) => object.entries().iter().find_map(|(k, item)| function_key(item, k)),
            _ => None,
        }
    }
    // A record left in a value no `holdsRecords` walk reaches (under an
    // object a filing gave a prototype): the TypeScript writes its binding
    // object's own keys as data — the event's, a block's returned records',
    // as this does; any other holds what only the TypeScript engine has.
    if let Err(kind) = crate::js::try_json_stringify(value, 0) {
        return Err(Failure::unreproduced(&format!("{at}: parking a record ({}) as the data of its binding object", crate::record::describe_kind(&kind)), "the TypeScript engine writes its read seam and schema"));
    }
    if let Some(key) = function_key(value, "") {
        return Err(Failure::engine(
            "MOVENG_PARK_NONSERIALIZABLE",
            format!("{at}: value is not JSON-serialisable ('{key}' is a function) — a parked scope must be durable."),
        ));
    }
    Ok(json_round_trip(value))
}

/// A `LocalLandingShape` as the object a park stores.
fn landing_shape_js(shape: &LandingShape) -> Js {
    let mut edges = JsObject::new();
    for (name, nested) in &shape.edges {
        edges.set(name.clone(), landing_shape_js(nested));
    }
    object_of(vec![("fields", Js::array(shape.fields.iter().map(|f| Js::str(f.clone())).collect())), ("edges", Js::object(edges))])
}

/// `landingShapeOf`: a stored `landing`, or a legacy `landingShape` (the
/// nested names alone, no fields).
pub(crate) fn landing_shape_of(edge: &Js) -> Option<LandingShape> {
    fn read(shape: &Js) -> LandingShape {
        LandingShape {
            fields: items(at(shape, "fields")).iter().filter_map(|f| text(Some(f)).map(String::from)).collect(),
            edges: pairs(at(shape, "edges")).iter().map(|(name, nested)| (name.clone(), read(nested))).collect(),
        }
    }
    fn legacy(shape: &Js) -> LandingShape {
        LandingShape { fields: Vec::new(), edges: pairs(Some(shape)).iter().map(|(name, nested)| (name.clone(), legacy(nested))).collect() }
    }
    match (at(edge, "landing"), at(edge, "landingShape")) {
        (Some(shape), _) => Some(read(shape)),
        (None, Some(shape)) => Some(legacy(shape)),
        (None, None) => None,
    }
}

/// `serializeInstanceIdentity`.
fn identity(instance: &InstanceBinding) -> Js {
    let mut identity = vec![("name", Js::str(instance.name.clone())), ("adapterSlug", Js::str(instance.adapter_slug.clone()))];
    if let Some(credential) = &instance.credential_name {
        identity.push(("credentialName", Js::str(credential.clone())));
    }
    if !instance.construction_config.is_empty() {
        let mut config = JsObject::new();
        for (k, v) in &instance.construction_config {
            config.set(k.clone(), Js::str(v.clone()));
        }
        identity.push(("constructionConfig", Js::object(config)));
    }
    object_of(identity)
}

/// A trail as the TypeScript's `Provenance`: the origins themselves.
pub(crate) fn provenance_of(run: &Run<'_>, trail: &Trail) -> Js {
    let origins = run.origins.borrow();
    let origin = |id: &u32| origins.get(*id as usize).cloned().unwrap_or(Js::Null);
    let mut provenance = vec![("origins", Js::array(trail.origins.iter().map(origin).collect()))];
    if let Some(direct) = &trail.direct {
        provenance.push(("direct", origin(direct)));
    }
    object_of(provenance)
}

/// Why this engine does not resume `state` (on the eval wire), or `None`
/// when it does: a state of version 1 whose `suspended`, when present, is
/// `true`, and whose scopes, frames and journal hold only the binding kinds
/// this engine rebuilds (crate::resume) — every kind serialize.ts writes
/// but a block meta-node, which no run of either engine makes — and whose
/// code (a closure, an arm's body, a kept walk, a body-local declaration)
/// reads back as the syntax tree it rides as.
pub fn resume_refusal(state: &Json) -> Option<String> {
    let Ok(state) = crate::env::decode(state) else { return Some("resume_state_does_not_read".into()) };
    if !matches!(at(&state, "version"), Some(Js::Number(n)) if *n == 1.0) {
        return Some("resume_state_version".into());
    }
    if at(&state, "suspended").is_some_and(|suspended| !matches!(suspended, Js::Bool(true))) {
        return Some("resume_state_suspended".into());
    }
    let scopes = at(&state, "scopeChain").cloned().unwrap_or(Js::Undefined);
    let frames = at(&state, "frames").cloned().unwrap_or(Js::Undefined);
    let journal = at(&state, "journal").cloned().unwrap_or(Js::Undefined);
    // The lists a state's reader walks (its scopes, frames and journals, a
    // frame's own): one that is not a list is a state the TypeScript does
    // not read either.
    let listed = |value: &Js| matches!(value, Js::Undefined | Js::Array(_));
    let frames_listed = match &frames {
        Js::Array(list) => list.items().iter().all(|frame| {
            ["journal", "scopeChain"].iter().all(|key| listed(at(frame, key).unwrap_or(&Js::Undefined)))
        }),
        other => listed(other),
    };
    if !listed(&scopes) || !listed(&journal) || !frames_listed {
        return Some("resume_state_does_not_read".into());
    }
    // A value's own data is the host's, never a descriptor: only the
    // descriptors' kinds are read, each by the structure its kind has
    // (park_state.ts), never by a key name — the names of bindings, captures
    // and edges are the author's.
    scopes_refusal(&scopes).or_else(|| frames_refusal(&frames)).or_else(|| journal_refusal(&journal))
}

const NOT_READ: &str = "resume_state_code_does_not_read";

fn scopes_refusal(chain: &Js) -> Option<String> {
    items(Some(chain)).iter().find_map(|scope| map_refusal(at(scope, "bindings")).or_else(|| at(scope, "parent").and_then(scope_link_refusal)))
}

/// A scope link a closure holds, or a numbered scope's parent: a written
/// scope's bindings and parent read as theirs do; a reference or a file's
/// scope holds nothing.
fn scope_link_refusal(link: &Js) -> Option<String> {
    match text(at(link, "kind")) {
        Some("scope") if id_of(at(link, "id")).is_some() => {
            map_refusal(at(link, "bindings")).or_else(|| at(link, "parent").and_then(scope_link_refusal))
        }
        Some("scopeRef") if id_of(at(link, "id")).is_some() => None,
        Some("file") => None,
        _ => Some("resume_state_does_not_read".into()),
    }
}

fn journal_refusal(journal: &Js) -> Option<String> {
    items(Some(journal)).iter().find_map(|event| match at(event, "value") {
        None | Some(Js::Null) | Some(Js::Undefined) => None,
        Some(value) => descriptor_refusal(value),
    })
}

fn frames_refusal(frames: &Js) -> Option<String> {
    items(Some(frames)).iter().find_map(|frame| match text(at(frame, "kind")) {
        Some("call" | "member") => scopes_refusal(at(frame, "scopeChain").unwrap_or(&Js::Undefined))
            .or_else(|| journal_refusal(at(frame, "journal").unwrap_or(&Js::Undefined))),
        // A run-time arm: its body is code.
        Some("arm") => (!code_reads::<ast::ClosureExpression>(at(frame, "body"))).then(|| NOT_READ.to_string()),
        _ => Some("resume_state_does_not_read".into()),
    })
}

/// A map keyed by the author's names, every entry a descriptor.
fn map_refusal(entries: Option<&Js>) -> Option<String> {
    pairs(entries).iter().find_map(|(_, entry)| descriptor_refusal(entry))
}

fn walk_refusal(walk: Option<&Js>) -> Option<String> {
    let walk = walk?;
    let mapping = at(walk, "mapping");
    if !code_reads::<ast::PathHead>(at(walk, "head")) || mapping.is_some_and(|m| !code_reads::<ast::NodeLiteral>(Some(m))) {
        return Some(NOT_READ.into());
    }
    map_refusal(at(walk, "captured"))
}

fn value_refusal(value: &Js) -> Option<String> {
    match text(at(value, "kind")) {
        Some("record") => at(value, "binding").and_then(descriptor_refusal),
        Some("list") => items(at(value, "of")).iter().find_map(value_refusal),
        Some("map") => pairs(at(value, "of")).iter().find_map(|(_, entry)| value_refusal(entry)),
        // Data the engine held, never looked into.
        Some("data" | "file") => None,
        _ => Some("resume_state_does_not_read".into()),
    }
}

/// The first reason this engine does not rebuild one binding descriptor.
/// Every kind is named: a kind added to park_state.ts and not here ends at
/// the last arm, a refusal, never a silent skip.
fn descriptor_refusal(descriptor: &Js) -> Option<String> {
    let Some(kind) = text(at(descriptor, "kind")) else { return Some("resume_state_does_not_read".into()) };
    match kind {
        "blockMeta" => Some(format!("resume_state_kind:{kind}")),
        "closure" => {
            if !code_reads::<ast::ClosureExpression>(at(descriptor, "closure")) {
                return Some(NOT_READ.into());
            }
            map_refusal(at(descriptor, "captured")).or_else(|| at(descriptor, "scope").and_then(scope_link_refusal))
        }
        "localShape" => (!code_reads::<ast::ShapeDeclaration>(at(descriptor, "declaration"))).then(|| NOT_READ.to_string()),
        "lazyWalk" => walk_refusal(at(descriptor, "walk")),
        "handle" => at(descriptor, "old").and_then(descriptor_refusal),
        "positions" => items(at(descriptor, "landings")).iter().find_map(descriptor_refusal),
        "tuple" => items(at(descriptor, "slots")).iter().find_map(descriptor_refusal),
        "recordValue" => at(descriptor, "value").and_then(value_refusal),
        "nodePosition" => pairs(at(descriptor, "edges")).iter().find_map(|(_, edge)| match text(at(edge, "kind")) {
            Some("landed") => items(at(edge, "landings")).iter().find_map(descriptor_refusal),
            Some("deferred") => walk_refusal(at(edge, "walk")),
            _ => Some("resume_state_does_not_read".into()),
        }),
        // Data, a name or an identity: nothing to look into.
        "event" | "instance" | "handleRef" | "nodeRef" | "extractRoot" | "extractPosition" | "sourcePosition" | "resource"
        | "value" | "callback" | "shape" | "movement" | "fileClosure" | "shapePosition" | "opaque" => None,
        _ => Some("resume_state_does_not_read".into()),
    }
}

/// Whether `tree` reads back as the AST `T` (crate::resume `parked_tree`).
fn code_reads<T: serde::de::DeserializeOwned>(tree: Option<&Js>) -> bool {
    tree.is_some_and(|tree| serde_json::from_value::<T>(crate::env::json_of_js(tree)).is_ok())
}

// ── Suspension ──

impl Run<'_> {
    /// Before a statement (run.ts `interpretBody`): a paused run's flow
    /// suspends where it can, and a `suspendAt` address suspends it, once.
    pub(crate) async fn suspend_before(&self, at: &Address, scope: &Rc<Scope>) -> Result<(), Stop> {
        if self.limit_paused.get() && self.can_suspend() {
            return Err(self.suspend_flow(at, scope).await?);
        }
        let address = at.encode();
        let pending = {
            let mut pending = self.pending_suspensions.borrow_mut();
            pending.iter().position(|a| *a == address).map(|i| pending.remove(i))
        };
        if pending.is_some() {
            return Err(if self.can_suspend() { self.suspend_flow(at, scope).await? } else { nowhere_to_park(&address) });
        }
        Ok(())
    }

    /// A `suspendAt` address before a statement's k-th call (`… .c k`):
    /// the flow suspends there, once, its statement's finished calls
    /// journalled.
    pub(crate) async fn suspend_before_call(&self, call_address: &Address, site: &Rc<crate::flow::Site>) -> Result<(), Stop> {
        let address = call_address.encode();
        let pending = {
            let mut pending = self.pending_suspensions.borrow_mut();
            pending.iter().position(|a| *a == address).map(|i| pending.remove(i))
        };
        if pending.is_some() {
            return Err(if self.serves("park.sink.commitSuspension") {
                self.suspend_flow(&site.address, &site.scope).await?
            } else {
                nowhere_to_park(&site.address.encode())
            });
        }
        Ok(())
    }

    /// `suspendAtLimit`: the run met its cost cap in the statement at `at`.
    /// The first time, the run is marked paused and says so; then the flow
    /// suspends just before the statement. What the statement ends with: the
    /// park, or, where the sink cannot suspend, the cap as the run's failure.
    pub(crate) async fn suspend_at_limit(&self, cap: CapExceeded, at: &Address, scope: &Rc<Scope>) -> Stop {
        match self.pause_at_limit(cap, at, scope).await {
            Ok(stop) | Err(stop) => stop,
        }
    }

    async fn pause_at_limit(&self, cap: CapExceeded, at: &Address, scope: &Rc<Scope>) -> Result<Stop, Stop> {
        if !self.can_suspend() {
            return Ok(Stop::Thrown(Failure::CapExceeded(cap)));
        }
        if !self.limit_paused.get() {
            // A sink that can suspend but keeps no pause is skipped, as
            // `commitLimitPause?.` skips it.
            if self.serves("park.sink.commitLimitPause") {
                self.ask(host::park::commit_limit_pause(self.segment(), &cap)).await.map_err(Stop::Thrown)?;
            }
            self.limit_paused.set(true);
            self.trace(TraceEntry::Warning { code: "RUN_PAUSED_COST_CAP".into(), message: cap.paused_message() });
        }
        self.suspend_flow(at, scope).await
    }

    /// run.ts `canSuspend`: the host's park sink commits suspensions.
    fn can_suspend(&self) -> bool {
        !self.firing_callback.get() && !self.call_sites.borrow().is_empty() && self.serves("park.sink.commitSuspension")
    }

    /// `suspendFlow`: the suspended state committed and the flow parked at
    /// `at`. Asked only where the sink can suspend.
    async fn suspend_flow(&self, at: &Address, scope: &Rc<Scope>) -> Result<Stop, Stop> {
        let address = at.encode();
        let state = suspended_state(self, &address, scope).map_err(Stop::Thrown)?;
        let request = host::park::commit_suspension(self.segment(), &address, self.encode(&state).map_err(Stop::Thrown)?);
        self.ask(request).await.map_err(Stop::Thrown)?;
        self.trace(TraceEntry::Gate { outcome: false });
        Ok(Stop::Parked(address))
    }
}

fn nowhere_to_park(address: &str) -> Stop {
    Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("the run was asked to suspend at '{address}' and has nowhere durable to park")))
}

// ── Reading a stored state (a JavaScript value, in its stored key order) ──

/// `value[key]`, absent for `undefined` as a stored key's absence reads.
pub(crate) fn at<'v>(value: &'v Js, key: &str) -> Option<&'v Js> {
    match value {
        Js::Object(object) => object.get(key).filter(|v| !matches!(v, Js::Undefined)),
        _ => None,
    }
}

pub(crate) fn text(value: Option<&Js>) -> Option<&str> {
    match value {
        Some(Js::String(s)) => Some(s.as_form()),
        _ => None,
    }
}

pub(crate) fn items(value: Option<&Js>) -> Vec<Js> {
    match value {
        Some(Js::Array(list)) => list.items().clone(),
        _ => Vec::new(),
    }
}

pub(crate) fn pairs(value: Option<&Js>) -> &[(String, Js)] {
    match value {
        Some(Js::Object(object)) => object.entries(),
        _ => &[],
    }
}

pub(crate) fn id_of(value: Option<&Js>) -> Option<u64> {
    match value {
        Some(Js::Number(n)) if *n >= 0.0 && n.fract() == 0.0 => Some(*n as u64),
        _ => None,
    }
}

/// The reading side of one park's tables (`ParkReader`): each number is
/// the one node, or the one write handle, every reference to it rehydrates
/// to.
#[derive(Default)]
pub(crate) struct ParkReader {
    nodes: RefCell<Vec<(u64, Rc<RefCell<Node>>)>>,
    unfilled: RefCell<Vec<u64>>,
    /// Every numbered descriptor the WHOLE parked state carries, by its
    /// number, indexed before anything is read (`handleDescriptors`,
    /// `nodeDescriptors`): a reference is resolved from it whichever copy of
    /// a scope (or frame, or journal) the reader walks, and in whatever order
    /// the state's keys come back. The writer numbers a handle or node at its
    /// FIRST sighting in its own walk order, which need not be a place the
    /// reader walks at all.
    handle_descriptors: Vec<(u64, Js)>,
    node_descriptors: Vec<(u64, Js)>,
    handles: RefCell<Vec<(u64, Rc<Handle>)>>,
    unfilled_handles: RefCell<Vec<u64>>,
    /// Every numbered scope's written copy anywhere in the state — a chain's,
    /// or a closure's `scope` — first wins (`scopeDescriptors`).
    scope_descriptors: Vec<(u64, Js)>,
    /// Each numbered scope as the ONE scope every closure naming it holds
    /// (`scopes`): the live scope a resume read a chain copy into, or one
    /// built from the scope's written copy.
    scopes: RefCell<Vec<(u64, Rc<Scope>)>>,
}

impl ParkReader {
    /// A reader of the park `state` was written as — a whole parked state
    /// (`newParkReader(state)`).
    pub(crate) fn over_state(state: &Js) -> ParkReader {
        let mut park = ParkReader::default();
        index_state(state, &mut park);
        park
    }

    /// A reader of one descriptor stored on its own (`newParkReaderOf`).
    pub(crate) fn over_descriptor(descriptor: &Js) -> ParkReader {
        let mut park = ParkReader::default();
        index_descriptor(descriptor, &mut park);
        park
    }

    pub(crate) fn node(&self, id: u64) -> Option<Rc<RefCell<Node>>> {
        self.nodes.borrow().iter().find(|(i, _)| *i == id).map(|(_, n)| n.clone())
    }

    pub(crate) fn node_descriptor(&self, id: u64) -> Option<Js> {
        self.node_descriptors.iter().find(|(i, _)| *i == id).map(|(_, d)| d.clone())
    }

    pub(crate) fn node_unfilled(&self, id: u64) -> bool {
        self.unfilled.borrow().contains(&id)
    }

    pub(crate) fn handle_unfilled(&self, id: u64) -> bool {
        self.unfilled_handles.borrow().contains(&id)
    }

    pub(crate) fn handle(&self, id: u64) -> Option<Rc<Handle>> {
        self.handles.borrow().iter().find(|(i, _)| *i == id).map(|(_, h)| h.clone())
    }

    pub(crate) fn handle_descriptor(&self, id: u64) -> Option<Js> {
        self.handle_descriptors.iter().find(|(i, _)| *i == id).map(|(_, d)| d.clone())
    }

    /// Made, and its own descriptor not read yet.
    pub(crate) fn handle_registered(&self, id: u64, handle: Rc<Handle>) {
        self.handles.borrow_mut().push((id, handle));
        self.unfilled_handles.borrow_mut().push(id);
    }

    pub(crate) fn handle_filled(&self, id: u64) {
        self.unfilled_handles.borrow_mut().retain(|i| *i != id);
    }

    /// `assertParkRead`: every number a reference named was read, a node's
    /// or a handle's; a resume that went on would read an empty stand-in
    /// where the run had something.
    pub(crate) fn assert_read(&self) -> Result<(), String> {
        if let Some(id) = self.unfilled() {
            return Err(format!("the parked state refers to run-built node(s) #{id} that it never wrote"));
        }
        if let Some(id) = self.unfilled_handles.borrow().first() {
            return Err(format!("the parked state refers to write handle(s) #{id} that it never wrote"));
        }
        Ok(())
    }

    pub(crate) fn numbered(&self, id: u64) -> Rc<RefCell<Node>> {
        if let Some((_, node)) = self.nodes.borrow().iter().find(|(i, _)| *i == id) {
            return node.clone();
        }
        let node = Rc::new(RefCell::new(Node::default()));
        self.nodes.borrow_mut().push((id, node.clone()));
        self.unfilled.borrow_mut().push(id);
        node
    }

    /// The scope numbered `id`, once the resume has it.
    pub(crate) fn scope(&self, id: u64) -> Option<Rc<Scope>> {
        self.scopes.borrow().iter().find(|(i, _)| *i == id).map(|(_, s)| s.clone())
    }

    /// The written copy of the scope numbered `id`, wherever it is.
    pub(crate) fn scope_descriptor(&self, id: u64) -> Option<Js> {
        self.scope_descriptors.iter().find(|(i, _)| *i == id).map(|(_, d)| d.clone())
    }

    /// `scopes.set`: the scope every closure naming `id` holds.
    pub(crate) fn scope_registered(&self, id: u64, scope: Rc<Scope>) {
        self.scopes.borrow_mut().push((id, scope));
    }

    /// `registerLiveScope`: a chain copy the resume read into `scope`, live —
    /// when it is numbered, the scope every closure naming that number holds.
    pub(crate) fn register_live_scope(&self, copy: &Js, scope: &Rc<Scope>) {
        if let Some(id) = id_of(at(copy, "id"))
            && self.scope(id).is_none()
        {
            self.scope_registered(id, scope.clone());
        }
    }

    pub(crate) fn filled(&self, id: u64) {
        self.unfilled.borrow_mut().retain(|i| *i != id);
    }

    pub(crate) fn unfilled(&self) -> Option<u64> {
        self.unfilled.borrow().first().copied()
    }
}

/*
 * The index follows each descriptor's STRUCTURE, the shapes the reader reads
 * (serialize.ts `indexState` / `indexDescriptor`) — never a list of key
 * names. A scope's `bindings`, a closure's `captured` and an edge map are
 * keyed by the AUTHOR's names, so they are walked as maps of descriptors
 * whatever the names are; a code-tree member (a closure's body, a walk's
 * head, an arm's body) is skipped only on the descriptor that has it, by not
 * being a member the walk visits.
 */

/// Every numbered handle and node descriptor anywhere in a parked state: its
/// scopes, frames and journals.
fn index_state(state: &Js, park: &mut ParkReader) {
    index_scopes(at(state, "scopeChain"), park);
    index_journal(at(state, "journal"), park);
    for frame in &items(at(state, "frames")) {
        // A run-time arm's `body` is code; its bindings ride on the chain.
        if let Some("call" | "member") = text(at(frame, "kind")) {
            index_scopes(at(frame, "scopeChain"), park);
            index_journal(at(frame, "journal"), park);
        }
    }
}

fn index_scopes(chain: Option<&Js>, park: &mut ParkReader) {
    for scope in &items(chain) {
        if let Some(id) = id_of(at(scope, "id")) {
            index_scope_copy(id, scope, park);
        }
        if let Some(parent) = at(scope, "parent") {
            index_scope_link(parent, park);
        }
        index_map(at(scope, "bindings"), park);
    }
}

fn index_scope_copy(id: u64, copy: &Js, park: &mut ParkReader) {
    if !park.scope_descriptors.iter().any(|(i, _)| *i == id) {
        park.scope_descriptors.push((id, copy.clone()));
    }
}

/// A scope link (`ScopeLink`): a written `scope`'s bindings are a map of
/// descriptors, and its parent a link; a `scopeRef` or a `file` holds
/// nothing.
fn index_scope_link(link: &Js, park: &mut ParkReader) {
    match text(at(link, "kind")) {
        Some("scope") => {
            if let Some(id) = id_of(at(link, "id")) {
                index_scope_copy(id, link, park);
            }
            if let Some(parent) = at(link, "parent") {
                index_scope_link(parent, park);
            }
            index_map(at(link, "bindings"), park);
        }
        Some("scopeRef" | "file") => {}
        other => unreachable_kind("scope link", other),
    }
}

fn index_journal(journal: Option<&Js>, park: &mut ParkReader) {
    for event in &items(journal) {
        match at(event, "value") {
            None | Some(Js::Null) | Some(Js::Undefined) => {}
            Some(value) => index_descriptor(value, park),
        }
    }
}

/// A map keyed by the author's names, every entry a descriptor.
fn index_map(entries: Option<&Js>, park: &mut ParkReader) {
    for (_, entry) in pairs(entries) {
        index_descriptor(entry, park);
    }
}

fn index_walk(walk: Option<&Js>, park: &mut ParkReader) {
    // The walk's `head` and `mapping` are code.
    if let Some(walk) = walk {
        index_map(at(walk, "captured"), park);
    }
}

fn index_value(value: &Js, park: &mut ParkReader) {
    match text(at(value, "kind")) {
        Some("record") => {
            if let Some(binding) = at(value, "binding") {
                index_descriptor(binding, park);
            }
        }
        Some("list") => items(at(value, "of")).iter().for_each(|entry| index_value(entry, park)),
        Some("map") => pairs(at(value, "of")).iter().for_each(|(_, entry)| index_value(entry, park)),
        // `data` and `file`: data the engine held, numbering nothing.
        Some("data" | "file") => {}
        // resume_refusal has refused any other kind before a reader indexes.
        other => unreachable_kind("value", other),
    }
}

/// A kind the admission check refused is never indexed; one that reaches
/// here is a kind added without a decision, and fails loudly.
fn unreachable_kind(what: &str, kind: Option<&str>) {
    panic!("park reader: {what} kind {kind:?} is not one this engine reads");
}

fn index_descriptor(descriptor: &Js, park: &mut ParkReader) {
    match text(at(descriptor, "kind")) {
        Some("handle") => {
            if let Some(id) = id_of(at(descriptor, "id"))
                && !park.handle_descriptors.iter().any(|(i, _)| *i == id)
            {
                park.handle_descriptors.push((id, descriptor.clone()));
            }
            if let Some(old) = at(descriptor, "old") {
                index_descriptor(old, park);
            }
        }
        Some("nodePosition") => {
            if let Some(id) = id_of(at(descriptor, "id"))
                && !park.node_descriptors.iter().any(|(i, _)| *i == id)
            {
                park.node_descriptors.push((id, descriptor.clone()));
            }
            for (_, edge) in pairs(at(descriptor, "edges")) {
                match text(at(edge, "kind")) {
                    Some("landed") => items(at(edge, "landings")).iter().for_each(|landing| index_descriptor(landing, park)),
                    Some("deferred") => index_walk(at(edge, "walk"), park),
                    other => unreachable_kind("edge", other),
                }
            }
        }
        Some("blockMeta") => {
            for (_, landings) in pairs(at(descriptor, "edges")) {
                items(Some(landings)).iter().for_each(|landing| index_descriptor(landing, park));
            }
        }
        Some("positions") => items(at(descriptor, "landings")).iter().for_each(|landing| index_descriptor(landing, park)),
        Some("tuple") => items(at(descriptor, "slots")).iter().for_each(|slot| index_descriptor(slot, park)),
        // A closure's `closure` is code; its capture is a map of descriptors,
        // and its scope a scope link.
        Some("closure") => {
            index_map(at(descriptor, "captured"), park);
            if let Some(link) = at(descriptor, "scope") {
                index_scope_link(link, park);
            }
        }
        Some("recordValue") => {
            if let Some(value) = at(descriptor, "value") {
                index_value(value, park);
            }
        }
        Some("lazyWalk") => index_walk(at(descriptor, "walk"), park),
        // Nothing a park numbers: their payload is data or code, never a
        // descriptor.
        Some(
            "event" | "instance" | "handleRef" | "nodeRef" | "extractRoot" | "extractPosition" | "sourcePosition" | "resource" | "value"
            | "callback" | "shape" | "localShape" | "movement" | "fileClosure" | "shapePosition" | "opaque",
        ) => {}
        other => unreachable_kind("descriptor", other),
    }
}

/// `parseAddress` for the steps this engine runs (`s`, `b`).
pub(crate) fn parse_address(text: &str) -> Option<Vec<(char, usize)>> {
    if text.is_empty() {
        return Some(Vec::new());
    }
    text.split('.')
        .map(|step| {
            let mut chars = step.chars();
            let kind = chars.next()?;
            let index = chars.as_str().parse().ok()?;
            matches!(kind, 's' | 'b' | 'i' | 'c').then_some((kind, index))
        })
        .collect()
}

/// `durationToMs`: unit-suffixed parts (`1h30m`), `None` for a text that is
/// not one.
pub fn duration_ms(raw: &str) -> Option<f64> {
    let mut total = 0.0;
    let mut digits = String::new();
    let mut any = false;
    for c in raw.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
            continue;
        }
        let unit = match c {
            's' => 1_000.0,
            'm' => 60_000.0,
            'h' => 3_600_000.0,
            'd' => 86_400_000.0,
            'w' => 604_800_000.0,
            _ => return None,
        };
        if digits.is_empty() {
            return None;
        }
        total += digits.parse::<f64>().ok()? * unit;
        digits.clear();
        any = true;
    }
    (any && digits.is_empty()).then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_read_as_duration_to_ms_reads_them() {
        assert_eq!(duration_ms("30s"), Some(30_000.0));
        assert_eq!(duration_ms("1h30m"), Some(5_400_000.0));
        assert_eq!(duration_ms("2d"), Some(172_800_000.0));
        assert_eq!(duration_ms("h"), None);
        assert_eq!(duration_ms("30"), None);
    }

    /// A record a pick bound parks as serialize.ts writes a source
    /// position: the position, and the graph it was read from by name.
    #[test]
    fn a_picked_record_parks_as_the_typescript_writes_it() {
        let input: crate::run::SegmentInput = serde_json::from_value(serde_json::json!({
            "source": "movement m(msg: <inbox-[:message]->>) {\n  x = 1\n}", "languageVersion": 3, "event": null,
            "segmentId": "g1", "serves": [], "now": "2026-03-12T12:00:00.000Z",
            "catalog": { "adapters": {}, "credentials": {}, "plugins": {} },
        }))
        .unwrap();
        let ledger = crate::ledger::Ledger::new(&input.spend);
        let host = crate::executor::Host::default();
        let root = crate::program::parse(&input.source, 3).unwrap();
        let checked = crate::program::join_check(root, &serde_json::json!({ "diagnostics": [], "stamps": [] }), 3).unwrap();
        let run = Run {
            host: &host,
            input: &input,
            ledger: &ledger,
            event: Js::Undefined,
            now_ms: 0.0,
            catalog: movement_parser::catalog::types::CatalogSnapshot::load(input.catalog.get()).unwrap(),
            checked,
            import_originals: RefCell::default(),
            source: RefCell::default(),
            source_instance: RefCell::default(),
            acting_user: RefCell::default(),
            actor: RefCell::default(),
            origins: RefCell::default(),
            misses: RefCell::default(),
            trace: crate::trace::FlowTrace::default(),
            movement_name: RefCell::default(),
            writes: RefCell::default(),
            targets: RefCell::default(),
            mutation_context: RefCell::new(Js::Undefined),
            limit_paused: std::cell::Cell::new(false),
            pending_suspensions: RefCell::default(),
            source_reads: RefCell::default(),
            positions: RefCell::default(),
            extraction_sites: RefCell::default(),
            reply_digests: std::cell::Cell::new(0),
            extract_calls: Default::default(),
            unfetched_files: RefCell::default(),
            log_lines: RefCell::default(),
            file_scope: RefCell::default(),
            library_scopes: RefCell::default(),
            call_sites: RefCell::default(),
            slot_paths: RefCell::default(),
            boundaries: RefCell::default(),
            write_order: RefCell::default(),
            held_locks: RefCell::default(),
            forked: std::cell::Cell::new(false),
            gates: RefCell::default(),
            write_keys: RefCell::default(),
            resolutions: RefCell::default(),
            firing_callback: std::cell::Cell::new(false),
            deferred_race_frames: RefCell::default(),
            call_stack: RefCell::default(),
            wire: crate::env::Wire::default(),
            effected: std::cell::Cell::new(false),
        };
        let read = Rc::new(crate::traverse::Read {
            instance: crate::host::Instance { id: "i1".into(), methods: Rc::new(Vec::new()) },
            adapter_type: "graph".into(),
            instance_name: "kg".into(),
            schema: None,
            start_surface_type: None,
            incoming: false,
            edge_properties: false,
            streams: false,
            raw: false,
        });
        let scope = Scope::root();
        scope.declare("c", Binding::Landed(Rc::new(crate::bindings::Landed::new(Js::Undefined, None, read))));
        for state in [parked_state(&run, "s0", None, &scope), suspended_state(&run, "s0", &scope)] {
            let state = crate::env::encode_plain(&state.expect("a picked record parks"));
            let text = state.to_string();
            assert!(text.contains(r#"[["kind","sourcePosition"],["position",["u"]],["read",["o","#), "{text}");
            assert!(text.contains(r#"[["instanceName","kg"]]"#), "{text}");
        }
    }

    #[test]
    fn addresses_parse_back() {
        assert_eq!(parse_address("s1.b0.s2"), Some(vec![('s', 1), ('b', 0), ('s', 2)]));
        assert_eq!(parse_address("s1.x0"), None);
    }

}
