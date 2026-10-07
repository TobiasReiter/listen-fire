//! The static shape of a built-in call (ported from the TypeScript's
//! expression/call_shape.ts): FILE's artifact type, READ's one argument, an
//! options map's keys. Its refusals were `BridgeError`s, not
//! `LoweringError`s, and keep that class across the boundary
//! (`RefusalClass::CallShape`).

use super::LoweringRefusal;
use super::expression::{Expression, ObjectMember, StaticValue};
use crate::util::js::number_to_string;
use super::vocabulary::{OptionSpec, OptionType, OptionsContract, quoted_list, vocabulary};
use indexmap::IndexMap;

/// `validateBuiltinCallShape` on a `function` node.
pub fn validate(fn_: &str, args: &[Expression]) -> Result<(), LoweringRefusal> {
    validate_file(fn_, args)?;
    validate_read(fn_, args)?;
    validate_options(fn_, args)
}

fn refuse(message: String) -> Result<(), LoweringRefusal> {
    Err(LoweringRefusal::call_shape(message))
}

fn validate_file(fn_: &str, args: &[Expression]) -> Result<(), LoweringRefusal> {
    let file = &vocabulary().file;
    if fn_ != file.fn_ {
        return Ok(());
    }
    if args.len() != 2 {
        return refuse(format!(
            "{} takes exactly 2 arguments, got {} — e.g. FILE(report_text, \"pdf\")",
            file.signature,
            args.len()
        ));
    }
    let known = args[1].as_static_text().is_some_and(|t| file.artifact_types.contains(&t));
    if !known {
        return refuse(format!(
            "FILE()'s second argument is the artifact type — a literal {}",
            quoted_list(file.artifact_types, "\"", " or ")
        ));
    }
    Ok(())
}

fn validate_read(fn_: &str, args: &[Expression]) -> Result<(), LoweringRefusal> {
    let read = &vocabulary().read;
    if fn_ != read.fn_ || args.len() == 1 {
        return Ok(());
    }
    refuse(format!("{} takes exactly 1 argument, got {} — e.g. READ(attachment)", read.signature, args.len()))
}

/// A literal option value, as the TypeScript `literals` map holds it.
type Literals<'a> = IndexMap<&'a str, &'a StaticValue>;

fn validate_options(fn_: &str, args: &[Expression]) -> Result<(), LoweringRefusal> {
    let Some(spec) = vocabulary().options_for(fn_) else {
        return Ok(());
    };
    let inventory = spec.describe();
    if args.len() != spec.arity {
        return refuse(format!(
            "{} takes exactly {} arguments, got {} — the options are a map: {inventory}",
            spec.signature,
            spec.arity,
            args.len()
        ));
    }
    let Expression::Object { entries } = &args[spec.index] else {
        return refuse(format!(
            "{} takes its options as a map — write {{ {}: … }}, not a bare value. The options are: {inventory}",
            spec.signature, spec.options[0].key
        ));
    };

    let mut literals: Literals = IndexMap::new();
    let mut seen: Vec<&str> = Vec::new();
    for entry in entries {
        let (key, value) = match entry {
            ObjectMember::Spread(_) => {
                return refuse(format!(
                    "{} takes its options written out one by one — a spread ('...') is not accepted here. The options are: {inventory}",
                    spec.signature
                ));
            }
            ObjectMember::Entry { key, value } => (key.as_str(), value),
        };
        let Some(option) = spec.options.iter().find(|o| o.key == key) else {
            let known: Vec<&str> = spec.options.iter().map(|o| o.key).collect();
            return refuse(format!(
                "{} has no option '{key}'{} — the options are: {inventory}",
                spec.signature,
                did_you_mean(key, &known)
            ));
        };
        if seen.contains(&key) {
            return refuse(format!("{} is given '{key}' twice — write it once", spec.signature));
        }
        seen.push(key);
        if let Expression::Static { value: v } = value {
            literals.insert(key, v);
        }
        if option.type_ == OptionType::Literal {
            validate_literal_option(spec, option, value)?;
        }
    }

    for option in spec.options {
        if option.required && !seen.contains(&option.key) {
            return refuse(format!(
                "{} needs '{}' — {}. The options are: {inventory}",
                spec.signature, option.key, option.summary
            ));
        }
    }

    for choice in spec.exactly_one {
        let written: Vec<&str> = choice.keys.iter().copied().filter(|k| seen.contains(k)).collect();
        let spellings = quoted_list(choice.keys, "'", " or ");
        if written.is_empty() {
            let summaries = choice
                .keys
                .iter()
                .filter_map(|k| spec.options.iter().find(|o| o.key == *k).map(|o| o.summary))
                .collect::<Vec<_>>()
                .join(", or ");
            return refuse(format!(
                "{} needs one of {spellings} — {summaries}. The options are: {inventory}",
                spec.signature
            ));
        }
        if written.len() > 1 {
            return refuse(format!(
                "{} is given {}, which are two ways of saying {} — write one of them",
                spec.signature,
                quoted_list(&written, "'", " and "),
                choice.what
            ));
        }
    }

    if let Some(rule) = spec.agree
        && let Some(disagreement) = agree(rule, &literals)?
    {
        return refuse(format!("{}: {disagreement}", spec.signature));
    }
    Ok(())
}

/// The cross-option rules, by the name lowering/vocabulary/data.rs gives
/// each. A name it carries no rule for is refused, never a panic: the data is
/// generated, and a rule added on the TypeScript side lands there first.
fn agree(rule: &str, literals: &Literals) -> Result<Option<String>, LoweringRefusal> {
    match rule {
        "chunks" => Ok(chunks_overlap(literals)),
        other => Err(LoweringRefusal::new(format!(
            "lowering/vocabulary/data.rs names the cross-option rule `{other}`, which the lowering does not carry"
        ))),
    }
}

/// CHUNKS: an overlap under the size, when both are written as numbers.
fn chunks_overlap(literals: &Literals) -> Option<String> {
    let number = |key| match literals.get(key) {
        Some(StaticValue::Number(n)) => Some(n.0),
        _ => None,
    };
    let (size, overlap) = (number("size")?, number("overlap")?);
    if overlap < size {
        return None;
    }
    Some(format!(
        "an overlap of {} is not smaller than a size of {} — each piece would repeat the whole of the one before it and the text would never advance",
        number_to_string(overlap),
        number_to_string(size)
    ))
}

fn validate_literal_option(spec: &OptionsContract, option: &OptionSpec, value: &Expression) -> Result<(), LoweringRefusal> {
    let values = option.values.unwrap_or(&[]);
    let choices = quoted_list(values, "\"", " or ");
    let Some(text) = value.as_static_text() else {
        return refuse(format!(
            "{}: '{}' is written down, not worked out — write {}: {choices}",
            spec.signature, option.key, option.key
        ));
    };
    if !values.contains(&text) {
        return refuse(format!(
            "{}: '{}' has no value \"{text}\" — write {}: {choices}",
            spec.signature, option.key, option.key
        ));
    }
    if let Some((_, unavailable)) = option.unavailable.and_then(|u| u.iter().find(|(k, _)| *k == text)) {
        return refuse(format!("{}: {unavailable}", spec.signature));
    }
    Ok(())
}

/// ` (did you mean 'size'?)` — one edit away, or a prefix of the real thing.
fn did_you_mean(written: &str, known: &[&str]) -> String {
    let near = known.iter().find(|k| k.starts_with(written) || written.starts_with(**k) || edit_distance_at_most_one(k, written));
    near.map_or(String::new(), |k| format!(" (did you mean '{k}'?)"))
}

/// Over UTF-16 units, as the TypeScript indexes its strings.
fn edit_distance_at_most_one(a: &str, b: &str) -> bool {
    let a: Vec<u16> = a.encode_utf16().collect();
    let b: Vec<u16> = b.encode_utf16().collect();
    if a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let (mut i, mut j, mut edits) = (0, 0, 0);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            i += 1;
            j += 1;
            continue;
        }
        edits += 1;
        if edits > 1 {
            return false;
        }
        if a.len() == b.len() {
            i += 1;
            j += 1;
        } else if a.len() > b.len() {
            i += 1;
        } else {
            j += 1;
        }
    }
    edits + (a.len() - i) + (b.len() - j) <= 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lowering::vocabulary::vocabulary;

    #[test]
    fn a_near_miss_is_named() {
        assert_eq!(did_you_mean("sise", &["size", "overlap"]), " (did you mean 'size'?)");
        assert_eq!(did_you_mean("over", &["size", "overlap"]), " (did you mean 'overlap'?)");
        assert_eq!(did_you_mean("zzz", &["size", "overlap"]), "");
        assert!(edit_distance_at_most_one("size", "siz"));
        assert!(!edit_distance_at_most_one("size", "sz"));
    }

    #[test]
    fn every_cross_option_rule_the_vocabulary_names_is_carried() {
        for contract in vocabulary().options {
            if let Some(rule) = contract.agree {
                assert!(agree(rule, &Literals::new()).is_ok(), "{} names `{rule}`", contract.fn_);
            }
        }
        let refused = agree("nope", &Literals::new()).unwrap_err();
        assert!(refused.message.contains("lowering/vocabulary/data.rs") && refused.message.contains("`nope`"));
    }
}
