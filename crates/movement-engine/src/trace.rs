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

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
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
    /// its members as extraction.ts writes them.
    Extraction(serde_json::Map<String, serde_json::Value>),
    /// One plugin invocation, a stage's or a plain call's.
    Plugin(serde_json::Map<String, serde_json::Value>),
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
