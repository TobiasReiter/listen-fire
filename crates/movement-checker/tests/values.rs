//! The values family's statement rules against the TypeScript's answers,
//! read off the parity corpus (crates/movement-checker/parity) on 2026-10-15.

use movement_checker::families::values::{WriteFieldAbsence, write_field_absence};
use movement_checker::types::field::{Ty, maybe_absent};
use movement_parser::ast::{ExprSlot, FieldEntry, FieldWriteMode, Loc, Span};

fn span() -> Span {
    Span { start: Loc { line: 9, col: 35 }, end: Loc { line: 9, col: 36 } }
}

fn field(raw: &str, semantics: Option<FieldWriteMode>) -> FieldEntry {
    FieldEntry { name: "Title".into(), value: ExprSlot::plain(raw.into(), span()), semantics, span: span() }
}

fn absence<'a>(field: &'a FieldEntry, value: &'a Ty, target: Option<&'a Ty>, identifies: bool) -> WriteFieldAbsence<'a> {
    WriteFieldAbsence { field, spread: None, target_type: target, value_type: Some(value), root_description: "board.Lane", may_leave_unset: true, identifies }
}

#[test]
fn a_maybe_absent_value_in_a_plain_field_falls_back_or_stays_unset() {
    let entry = field("n", None);
    let value = maybe_absent(Ty::Text);
    let found = write_field_absence(absence(&entry, &value, Some(&Ty::Text), false)).unwrap();
    assert_eq!(found.code, "MOV_ABSENT_REQUIRED");
    assert_eq!(
        found.message,
        "'Title' on board.Lane needs a value, but 'n' may be absent (text (or absent)) — write 'Title: COALESCE(n, \"unknown\")' to fall back to a value that is always there, or 'Title ?: n' to leave it unset when absent"
    );
    assert_eq!(found.fix.unwrap()["edits"][0]["text"], "COALESCE(n, \"unknown\")");
}

#[test]
fn fill_a_nullable_field_and_a_present_value_take_it() {
    let value = maybe_absent(Ty::Text);
    let fill = field("n", Some(FieldWriteMode::Fill));
    assert!(write_field_absence(absence(&fill, &value, Some(&Ty::Text), false)).is_none());
    let plain = field("n", None);
    assert!(write_field_absence(absence(&plain, &value, Some(&maybe_absent(Ty::Text)), false)).is_none());
    assert!(write_field_absence(absence(&plain, &Ty::Text, Some(&Ty::Text), false)).is_none());
}

#[test]
fn an_identifying_field_is_gated_not_given_a_fallback() {
    let entry = field("n", None);
    let value = maybe_absent(Ty::Text);
    let found = write_field_absence(absence(&entry, &value, Some(&Ty::Text), true)).unwrap();
    assert!(found.message.ends_with("and it identifies the record, so a fallback would merge every record written without it into one — write only when it is there: put the write inside 'if n != null { … }'"));
    assert!(found.fix.is_none());
}
