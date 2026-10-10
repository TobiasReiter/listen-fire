//! The run's decision trace (expression.ts's `MovementTraceEntry`): the
//! kinds this engine emits so far, and the buffer a flow keeps them in.
//!
//! The host sees the trace as the run goes, a statement at a time, as the
//! TypeScript engine publishes it (run.ts `interpretBody`): a flow buffers
//! what its statement traces, and the run hands the host its own flow's
//! buffer in one `trace.append` after each statement that traced anything,
//! and once more as the segment ends (a park, a failure). A flow other than
//! the run's (a `parallel` arm) will keep its own buffer until it joins,
//! then splice it into the run's in arm order.

use std::cell::RefCell;

use crate::env;
use crate::js::{self, Js};

#[derive(Debug, Clone)]
pub enum TraceEntry {
    /// A movement pinned to a deprecated language version.
    Warning { code: String, message: String },
    /// One `if` arm's condition, evaluated.
    Gate { outcome: bool },
    /// A null read of a field a raw-payload position does not carry, with
    /// the first 30 keys it does.
    FieldMiss { binding: String, field: String, available: Vec<String> },
    /// A traversal block's head, as written, and how many landings it
    /// yielded: the body runs once per landing.
    Block { root: String, positions: usize },
    /// One extraction call, or the call a stage skipped (crate::extract):
    /// its members as extraction.ts writes them, in its order.
    Extraction(Members),
    /// One plugin invocation, a stage's or a plain call's.
    Plugin(Members),
}

/// An entry's members (all but `kind`), in the order the TypeScript writes
/// them: the trace is persisted as JSON, and its key order is the reader's.
#[derive(Debug, Clone, Default)]
pub struct Members(Vec<(String, Js)>);

impl Members {
    /// `entry[key] = value`: a key already there keeps its place.
    pub fn set(&mut self, key: &str, value: Js) {
        js::insert_in_object_order(&mut self.0, key.to_string(), value);
    }

    pub fn get(&self, key: &str) -> Option<&Js> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// The members of `other`, after these.
    pub fn extend(&mut self, other: Members) {
        for (key, value) in other.0 {
            self.set(&key, value);
        }
    }
}

impl TraceEntry {
    /// The entry as expression.ts's `MovementTraceEntry` object.
    pub fn to_js(&self) -> Js {
        let kind = |k: &str| ("kind", Js::str(k));
        match self {
            TraceEntry::Warning { code, message } => {
                env::object_of(vec![kind("warning"), ("code", Js::str(code.clone())), ("message", Js::str(message.clone()))])
            }
            TraceEntry::Gate { outcome } => env::object_of(vec![kind("gate"), ("outcome", Js::Bool(*outcome))]),
            TraceEntry::FieldMiss { binding, field, available } => env::object_of(vec![
                kind("field_miss"),
                ("binding", Js::str(binding.clone())),
                ("field", Js::str(field.clone())),
                ("available", Js::array(available.iter().map(|k| Js::str(k.clone())).collect())),
            ]),
            TraceEntry::Block { root, positions } => {
                env::object_of(vec![kind("block"), ("root", Js::str(root.clone())), ("positions", Js::Number(*positions as f64))])
            }
            TraceEntry::Extraction(members) | TraceEntry::Plugin(members) => {
                let name = if matches!(self, TraceEntry::Extraction(_)) { "extraction" } else { "plugin" };
                let mut object = js::JsObject::new();
                object.set("kind".into(), Js::str(name));
                for (key, value) in &members.0 {
                    object.set(key.clone(), value.clone());
                }
                Js::object(object)
            }
        }
    }
}

/// One flow's trace entries not yet handed to the host, in the order they
/// landed.
#[derive(Debug, Default)]
pub struct FlowTrace {
    pending: RefCell<Vec<TraceEntry>>,
}

impl FlowTrace {
    pub fn push(&self, entry: TraceEntry) {
        self.pending.borrow_mut().push(entry);
    }

    /// Several entries, after those already waiting: a joined flow's.
    pub fn extend(&self, entries: Vec<TraceEntry>) {
        self.pending.borrow_mut().extend(entries);
    }

    /// The buffer exchanged for `other`: the running flow's for another's
    /// (crate::flow).
    pub fn swap(&self, other: &mut Vec<TraceEntry>) {
        std::mem::swap(&mut *self.pending.borrow_mut(), other);
    }

    /// Everything buffered, emptying the buffer: the next `trace.append`'s
    /// entries, or a joined flow's for its parent to splice.
    pub fn take(&self) -> Vec<TraceEntry> {
        std::mem::take(&mut *self.pending.borrow_mut())
    }

    /// How many entries wait: where a statement's own entries will start.
    pub fn len(&self) -> usize {
        self.pending.borrow().len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.borrow().is_empty()
    }

    /// The entries from `from` on, to finish one in place once the statement
    /// that wrote them knows the rest (an extraction's emitted entities).
    pub fn amend(&self, from: usize, amend: impl FnOnce(&mut [TraceEntry])) {
        let mut pending = self.pending.borrow_mut();
        let from = from.min(pending.len());
        amend(&mut pending[from..]);
    }
}
