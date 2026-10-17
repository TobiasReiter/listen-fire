//! `CHUNKS` held to movement-lang's own chunk.ts and density.ts
//! (tests/oracle/chunks.json, written by tests/oracle/chunks_oracle.ts
//! through generate.ts): the same refusal sentence for options a run cannot
//! cut by, else the same pieces and, in the entities mode, the same estimate
//! of each. The size mode is compared on any text whose characters are each
//! one UTF-16 unit: version 5 counts characters, where JavaScript counted
//! units, so on a text holding an emoji (or a lone surrogate, which the
//! engine reads as U+FFFD) the pieces differ on purpose. The entities mode
//! is compared on ASCII text only (Henry's ruling, 2026-10-12: its letter
//! classes are this engine's own tables, README "Known divergences").

use movement_engine::chunks::{self, Spec};
use movement_engine::env::js_of_json;
use movement_engine::js::Js;
use movement_engine::js_string;
use serde_json::Value as Json;

#[test]
fn chunks_cut_and_estimate_as_the_typescript_does() {
    let lines: Vec<&str> = include_str!("oracle/chunks.json").lines().collect();
    assert!(lines.len() >= 600, "the oracle holds {} cases", lines.len());
    let (mut cut, mut by_entities, mut refused, mut by_character) = (0, 0, 0, 0);
    for line in lines {
        let case: Json = js_string::from_json_text(line).unwrap();
        let text: Vec<char> = case["text"].as_str().unwrap().chars().collect();
        let option = |key: &str| case["options"].get(key).map_or(Js::Undefined, js_of_json);
        let spec = chunks::read_spec(&option("size"), &option("entities"), &option("overlap"));
        if let Some(error) = case.get("error") {
            assert_eq!(spec.as_ref().err().map(String::as_str), error.as_str(), "{line}");
            refused += 1;
            continue;
        }
        let spec = spec.unwrap_or_else(|e| panic!("{line}\n{e}"));
        if text.iter().any(|&c| c.len_utf16() > 1 || c == '\u{FFFD}') {
            by_character += 1;
            continue;
        }
        let pieces: Vec<&[char]> = chunks::chunk(&text, spec).into_iter().map(|range| &text[range]).collect();
        let expected: Vec<Vec<char>> = case["pieces"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().chars().collect()).collect();
        assert_eq!(pieces, expected.iter().map(Vec::as_slice).collect::<Vec<_>>(), "{line}");
        if let Spec::Entities { .. } = spec {
            let estimates: Vec<u64> = pieces.iter().map(|p| chunks::entities(p) as u64).collect();
            let wanted: Vec<u64> = case["estimates"].as_array().unwrap().iter().map(|n| n.as_u64().unwrap()).collect();
            assert_eq!(estimates, wanted, "{line}");
            by_entities += 1;
        }
        cut += 1;
    }
    eprintln!("cut {cut}, by entities {by_entities}, refused {refused}, counted by character {by_character}");
    assert!(cut > 350 && by_entities > 100 && refused > 40 && by_character > 100, "cut {cut}, by entities {by_entities}, refused {refused}, by character {by_character}");
}
