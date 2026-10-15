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

use movement_parser::lowering::expression::Expression;

use crate::codes;
use crate::families::walks::OLD_EDGE;
use crate::types::field::{Ty, describe_field_type, is_dict, is_record, record_in, strip_absent, union_members};
use crate::types::infer::{Typing, holds_fields_in_hand};
use crate::types::narrowing::bare_name;
use crate::types::position::Position;
use crate::types::stdlib::Builtin;

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

// ── Standard-library arguments that read a record's fields ──

/// `holdsSpelledFields`: the checker holds this record's fields in hand (a
/// node literal, an extraction, a write's own result, a declared shape's
/// graph) rather than a system's schema describing them.
// The parameter field-needs note (`noteFieldsNeeded`) is not ported: the type
// core carries no parameter cell yet.
fn holds_spelled_fields(typing: &Typing, position: Option<&Position>) -> bool {
    match position {
        None => false,
        Some(Position::MaybeEmpty(of)) => holds_spelled_fields(typing, Some(of)),
        Some(Position::Position(record)) => typing.env.is_declared_graph(&record.instance),
        Some(Position::Union(union)) => typing.env.is_declared_graph(&union.instance),
        Some(other) => holds_fields_in_hand(other),
    }
}

fn not_spelled_out(typing: &mut Typing, function: &Builtin) {
    typing.report(
        codes::STDLIB_ARG_NOT_RECORD,
        format!(
            "`{}` takes a record whose fields the program spells out — a dict literal, a `node {{ … }}` literal, an extracted record or a declared one; build a dict of the fields you want from this record",
            function.name
        ),
    );
}

/// `checkStdlibRecordArg`: `TEXT.PAIRS`'s record is keyed — a dict, or a
/// record whose fields the program holds. Unknown and absent stay silent.
pub fn check_stdlib_record_arg(typing: &mut Typing, function: &Builtin, args: &[Expression], types: &[Option<Ty>]) {
    let Some(index) = record_arg_index(function) else { return };
    let Some(Some(ty)) = types.get(index) else { return };
    let stripped = strip_absent(ty).clone();
    // A block's whole return is a list of records, and the reach for it is
    // reaching for the one record a member carries — answered as that.
    if args.get(index).and_then(bare_name).is_some_and(|name| typing.env.plural_order_of(name).is_some()) {
        not_spelled_out(typing, function);
        return;
    }
    let members = union_members(&stripped);
    if members.len() > 1 && members.iter().all(is_dict) {
        return;
    }
    if !is_record(Some(&stripped)) && !is_dict(&stripped) {
        typing.report(
            codes::STDLIB_ARG_NOT_RECORD,
            format!("{} takes a record or a dict, and this is {}.", function.describe(), describe_field_type(&stripped)),
        );
        return;
    }
    if is_dict(&stripped) {
        return;
    }
    let position = record_in(Some(&stripped)).flatten();
    if !holds_spelled_fields(typing, position.as_ref()) {
        not_spelled_out(typing, function);
    }
}

/// `checkStdlibWholeValueArg`: `TEXT.SERIALISE` writes out any value, but a
/// record in it must be one whose fields the program holds.
pub fn check_stdlib_whole_value_arg(typing: &mut Typing, function: &Builtin, types: &[Option<Ty>]) {
    let Some(index) = whole_value_arg_index(function) else { return };
    let Some(Some(ty)) = types.get(index) else { return };
    let Some(position) = record_in(Some(ty)) else { return };
    if !holds_spelled_fields(typing, position.as_ref()) {
        typing.report(
            codes::STDLIB_ARG_NOT_RECORD,
            format!(
                "`{}` writes out a record whose fields the program spells out — a `node {{ … }}` literal, an extracted record or a declared one; build a dict of the fields you want from this record",
                function.name
            ),
        );
    }
    // TODO(nodes): the graph checks — a reference edge holding records read
    // live from a system (STDLIB_ARG_NOT_RECORD), and a lazy edge
    // (STDLIB_ARG_LAZY_EDGE) — need a node literal's edges to carry
    // `references` and `deferred`, which the nodes family's literal typing sets.
}

/// `recordArg` of the standard-library function that has one.
fn record_arg_index(function: &Builtin) -> Option<usize> {
    (function.name == "TEXT.PAIRS").then_some(0)
}

/// `wholeValueArg` of the standard-library function that has one.
fn whole_value_arg_index(function: &Builtin) -> Option<usize> {
    (function.name == "TEXT.SERIALISE").then_some(0)
}
