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
}
