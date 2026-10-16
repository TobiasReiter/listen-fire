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

/// A U+FDD0 in the source: the engine's text form writes it twice, so a
/// source already in that form is checked as it is (`check_form`), and a
/// message quoting it reads once outside (`external_text`).
#[test]
fn a_source_in_the_engines_text_form_is_not_formed_twice() {
    use movement_checker::{CheckOptions, check_form, check_source};
    use movement_parser::catalog::types::CatalogSnapshot;
    use movement_parser::util::form::{external_text, form_of_text};
    let catalog = CatalogSnapshot::load(r#"{"adapters":{},"credentials":{},"plugins":{}}"#).unwrap();
    let options = || CheckOptions { language_version: 5, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let source = "movement m(nope: <text>) {\n  y = \"\u{FDD0}\" + nope\n}";
    let hint = |diagnostics: Vec<movement_checker::Diagnostic>| {
        diagnostics.into_iter().find(|d| d.code == "MOV_ARITH_NON_NUMERIC").map(|d| external_text(&d.message).into_owned()).unwrap()
    };
    let outside = hint(check_source(source, &catalog, options()).unwrap());
    assert!(outside.ends_with("instead: \"\u{FDD0}${nope}\"."), "{outside}");
    assert_eq!(hint(check_form(&form_of_text(source), &catalog, options()).unwrap()), outside);
}
