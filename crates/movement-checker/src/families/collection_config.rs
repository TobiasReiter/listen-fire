//! A collection op's settings record (`MAP(xs, { … }, f)`) and the
//! collection it reads (checker/collection_config.ts and
//! `checkCollectionOp`'s source half). Part of the closures family:
//! MOV_COLLECTION_OP_CONFIG and MOV_COLLECTION_OP_NOT_A_COLLECTION.
//!
//! Every setting is written down, never worked out, so the record is read
//! here as the engine reads it, and a nonsense one is refused at save.

use movement_parser::ast::{ExprSlot, Span};
use movement_parser::lowering::expression::{Expression, ObjectMember, StaticValue};

use crate::checker::Checker;
use crate::codes;
use crate::meta::did_you_mean;
use crate::scope::{Resolution, ScopeId};
use crate::slots::{expression_of_slot, is_bare_ident, is_literal_word};
use crate::types::field::{Ty, collection_element_of, describe_field_type};

/// `COLLECTION_ON_ERROR`.
const ON_ERROR: [&str; 3] = ["ignore", "warn", "error"];

/// `SETTINGS`: each setting and what it is.
const SETTINGS: [(&str, &str); 3] = [
    ("onError", "\"error\" (the default), \"warn\" or \"ignore\" — what a member whose function fails does"),
    ("concurrency", "how many members run at once (1 by default)"),
    ("initialConcurrency", "how many members the first batch runs, before the rest start"),
];

/// `ALL_SETTING_KEYS`: what `all(f, g, { … })` takes (version 5).
pub const ALL_SETTING_KEYS: &[&str] = &["onError", "concurrency"];

const OP_SETTING_KEYS: &[&str] = &["onError", "concurrency", "initialConcurrency"];

/// `readCollectionConfig`, the half the checker reads: what is wrong with
/// the record (nothing, when it reads).
pub fn collection_config_problems(record: &Expression, spelling: &str, keys: &[&str]) -> Vec<String> {
    let inventory = SETTINGS.iter().filter(|(key, _)| keys.contains(key)).map(|(key, summary)| format!("{key} — {summary}")).collect::<Vec<_>>().join("; ");
    let Expression::Object { entries } = record else {
        return vec![format!(
            "'{spelling}' takes its settings as a record written in place — `{spelling}(xs, {{ onError: \"warn\", concurrency: 4 }}, f)`. The settings are: {inventory}"
        )];
    };
    let mut problems = Vec::new();
    let mut written: Vec<(&str, &Expression)> = Vec::new();
    for entry in entries {
        let ObjectMember::Entry { key, value } = entry else {
            problems.push(format!("'{spelling}' takes its settings written out one by one — a spread ('...') is not accepted here. The settings are: {inventory}"));
            continue;
        };
        if !keys.contains(&key.as_str()) {
            problems.push(format!("'{spelling}' has no setting '{key}'{}. The settings are: {inventory}", did_you_mean(key, keys)));
            continue;
        }
        if written.iter().any(|(k, _)| k == key) {
            problems.push(format!("'{spelling}' is given '{key}' twice — write it once"));
            continue;
        }
        written.push((key, value));
    }
    let setting = |name: &str| written.iter().find(|(k, _)| *k == name).map(|(_, v)| *v);
    if let Some(value) = setting("onError") {
        read_on_error(value, spelling, &mut problems);
    }
    let concurrency = match setting("concurrency") {
        Some(value) => read_width(value, "concurrency", spelling, &mut problems),
        None => Some(1.0),
    };
    let initial = match setting("initialConcurrency") {
        Some(value) => read_width(value, "initialConcurrency", spelling, &mut problems),
        None => concurrency,
    };
    // A first batch wider than the rest is the two written the wrong way round.
    if let (Some(concurrency), Some(initial)) = (concurrency, initial)
        && initial > concurrency
    {
        problems.push(format!(
            "'{spelling}' runs its first batch {} at a time and the rest {} at a time — the first batch is the warm-up, so it is never the wider one. Lower initialConcurrency, or raise concurrency.",
            js_number(initial),
            js_number(concurrency)
        ));
    }
    problems
}

/// Whether a settings record reads and its `onError` lets a failed member
/// through (anything but the default "error").
pub fn on_error_lets_through(record: &Expression, keys: &[&str]) -> bool {
    if !collection_config_problems(record, "", keys).is_empty() {
        return false;
    }
    let Expression::Object { entries } = record else { return false };
    entries.iter().any(|entry| {
        matches!(entry, ObjectMember::Entry { key, value: Expression::Static { value: StaticValue::String(on_error) } } if key == "onError" && on_error != "error")
    })
}

fn read_on_error(value: &Expression, spelling: &str, problems: &mut Vec<String>) {
    let choices = ON_ERROR.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
    let Expression::Static { value: StaticValue::String(written) } = value else {
        problems.push(format!("'{spelling}': 'onError' is written down, not worked out — write onError: one of {choices}"));
        return;
    };
    if !ON_ERROR.contains(&written.as_str()) {
        problems.push(format!("'{spelling}': 'onError' has no value \"{written}\"{} — write one of {choices}", did_you_mean(written, &ON_ERROR)));
    }
}

fn read_width(value: &Expression, key: &str, spelling: &str, problems: &mut Vec<String>) -> Option<f64> {
    let Expression::Static { value: StaticValue::Number(n) } = value else {
        problems.push(format!("'{spelling}': '{key}' is a whole number written down, not worked out — write {key}: 4"));
        return None;
    };
    let n = n.0;
    if n.fract() != 0.0 || !n.is_finite() || n < 1.0 {
        problems.push(format!(
            "'{spelling}': '{key}' is how many members run at once, so it is a whole number of at least 1 — and this is {}",
            js_number(n)
        ));
        return None;
    }
    Some(n)
}

/// A number as JavaScript's `String(n)` spells it.
fn js_number(n: f64) -> String {
    serde_json::to_string(&movement_parser::tree::JsNumber(n)).unwrap_or_else(|_| n.to_string())
}

impl Checker<'_> {
    /// `checkCollectionConfig`: the settings record read, not typed.
    pub fn check_collection_config(&mut self, config: &ExprSlot, spelling: &str, keys: Option<&[&str]>) {
        let parsed = match expression_of_slot(config) {
            Ok(parsed) => parsed,
            Err(error) => {
                self.report_slot_error(&error, config);
                return;
            }
        };
        for problem in collection_config_problems(&parsed, spelling, keys.unwrap_or(OP_SETTING_KEYS)) {
            self.report(codes::COLLECTION_OP_CONFIG, problem, config.span);
        }
    }

    /// `checkCollectionOp`'s source: a name bound to one record is not a
    /// collection; nor is a value that is not a list. What one member is,
    /// where the checker can say.
    pub fn collection_element(&mut self, source: &ExprSlot, parsed: Option<&Expression>, ty: Option<&Ty>, spelling: &str, scope: ScopeId) -> Option<Ty> {
        if let Some(kind) = self.one_record_named(source, parsed, scope) {
            self.report_not_a_collection(spelling, kind, source.span);
            return None;
        }
        let ty = ty?;
        let element = collection_element_of(ty);
        if element.is_none() {
            self.report_not_a_collection(spelling, &describe_field_type(ty), source.span);
        }
        element
    }

    /// `bareNodeSymbol`, not plural: what a bare name bound on the record
    /// plane to one record is (`describeKind`).
    fn one_record_named(&self, source: &ExprSlot, parsed: Option<&Expression>, scope: ScopeId) -> Option<&'static str> {
        let trimmed = source.raw.trim();
        let name = if is_bare_ident(trimmed) && !is_literal_word(trimmed) { Some(trimmed) } else { parsed.and_then(crate::types::narrowing::bare_name) }?;
        let Resolution::Found(id) = self.scopes.resolve(scope, name) else { return None };
        let symbol = self.scopes.symbol(id);
        // TODO(calls): `functionAsValue` — a function named as a value is on the record plane too.
        let on_record_plane = symbol.types.pos.is_some() || symbol.types.is_record;
        (on_record_plane && symbol.types.plural.is_none()).then(|| symbol.kind.describe())
    }

    fn report_not_a_collection(&mut self, spelling: &str, what: &str, span: Span) {
        self.report(
            codes::COLLECTION_OP_NOT_A_COLLECTION,
            format!(
                "'{spelling}' reads a collection, and this is {what} — one thing, not several. A hop's landings are a collection ('{spelling}(r-[:edge]->, …)'), and so is a list, a block's returns or another op's answer; walk one record in a traversal-headed block instead ('r-[x:edge]-> {{ … }}')."
            ),
            span,
        );
    }
}
