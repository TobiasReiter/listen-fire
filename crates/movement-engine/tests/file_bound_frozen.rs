//! A source file bounded for the prompt under a seeded
//! `EXTRACTION_FILE_CHARS` (tests/frozen/file_bound.jsonl; see frozen/mod.rs).

use movement_engine::extract::bound_text;
mod frozen;
use serde_json::json;

/// The ceiling includes fractional ones: the cut where `slice` truncates,
/// and the marker and the count printing the number as written.
#[test]
fn a_file_is_bounded_as_it_was_frozen() {
    let cases = frozen::cases("file_bound");
    assert!(cases.len() > 400, "{} cases", cases.len());
    let fractional = cases.iter().filter(|c| c["ceiling"].as_f64().is_some_and(|x| x.fract() != 0.0)).count();
    assert!(fractional > 100, "{fractional} fractional ceilings");
    let answered: Vec<_> = cases
        .iter()
        .map(|case| {
            let (content, chars, from) = bound_text(case["text"].as_str().unwrap(), case["ceiling"].as_f64().unwrap());
            frozen::answer(case, &["content", "chars", "truncatedFrom"], vec![("content", json!(content)), ("chars", json!(chars)), ("truncatedFrom", json!(from))])
        })
        .collect();
    frozen::settle("file_bound", &answered);
}
