//! The run's decision trace (expression.ts's `MovementTraceEntry`): the
//! kinds this engine emits so far. Each is appended to the host's trace as
//! it lands (`trace.append`), so a caller reads the run while it goes, as it
//! reads the TypeScript engine's.

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
