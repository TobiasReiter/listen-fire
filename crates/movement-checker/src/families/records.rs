//! The records family: where a record may stand in for a value, and what a
//! handle a write returned still carries. Its codes (PORT.md has where the
//! TypeScript raises each):
//!
//! - MOV_AT_RECORD_KEY
//! - MOV_CALL_ARG_MAYBE_RECORD
//! - MOV_CALL_ARG_OPAQUE_RECORD
//! - MOV_FILE_IN_TEXT
//! - MOV_HANDLE_FIELD_RETIRED
//! - MOV_HANDLE_FILE_NOT_SENT
//! - MOV_HANDLE_READ_FOUND
//! - MOV_INTERNAL_UNTYPED_BINDING
//! - MOV_RECEIPT_RECORD_SLOT
//! - MOV_RECORD_NOT_A_VALUE
//! - MOV_STDLIB_ARG_LAZY_EDGE
//! - MOV_STDLIB_ARG_NOT_RECORD

use crate::codes;
use crate::families::walks::OLD_EDGE;
use crate::types::infer::Typing;

/// `RETIRED_HANDLE_FIELDS`: what a write's handle no longer carries from version 4.
pub fn is_retired_handle_field(property: &str) -> bool {
    matches!(property, "created" | "committed")
}

pub fn report_handle_field_retired(typing: &mut Typing, property: &str) {
    typing.report(
        codes::HANDLE_FIELD_RETIRED,
        format!(
            "'{property}' is no longer a field of a write's handle since {} — ask the record before the write instead: `EXISTS(h-[:{OLD_EDGE}]->)` is FALSE when this write created the record; `FIRST(h-[:{OLD_EDGE}]->) == h` when it was only rehearsed; compare fields against `FIRST(h-[:{OLD_EDGE}]->)` for what changed",
            crate::version::describe(4)
        ),
    );
}
