//! The regex matcher (TEXT.REGEX_EXTRACT's dialect) held to its frozen
//! answers (tests/frozen/regex.jsonl; see frozen/mod.rs): seeded pattern and
//! text pairs over backreferences, lazy quantifiers, lookahead and
//! lookbehind, named groups, `\b`, classes, anchors, alternation and empty
//! iterations, then long texts and deep nesting. The dialect reads code
//! points (an astral character is one character) and not Annex B: an octal
//! escape, `\N` past the groups, `\c` without a letter and an unknown letter
//! escape are malformed, which are the places Node's answers (the first
//! recording) differ.

mod frozen;
use movement_engine::js_regex::{Regex, RegexError};
use serde_json::json;

#[test]
fn regexes_match_as_they_were_frozen() {
    let cases = frozen::cases("regex");
    assert!(cases.len() >= 7200, "{} cases", cases.len());
    let answered: Vec<_> = cases
        .iter()
        .map(|case| {
            let outcome = match Regex::new(case["pattern"].as_str().unwrap()).map(|r| r.exec(case["text"].as_str().unwrap())) {
                Err(RegexError::Syntax) => json!({ "syntaxError": true }),
                Ok(None) => json!({ "match": null }),
                Ok(Some(groups)) => json!({ "match": groups }),
            };
            frozen::answer(case, &["outcome"], vec![("outcome", outcome)])
        })
        .collect();
    frozen::settle("regex", &answered);
}
