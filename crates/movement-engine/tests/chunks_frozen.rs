//! `CHUNKS` held to its frozen answers (tests/frozen/chunks.jsonl; see
//! frozen/mod.rs): the refusal sentence for options a run cannot cut by,
//! else the pieces and, in the entities mode, the estimate of each. Version
//! 5 counts characters, where JavaScript counted UTF-16 units, so the size
//! mode cuts an emoji whole. The entities mode reads this engine's own letter
//! tables (README "Known divergences"), so its cases are ASCII text.

use movement_engine::chunks::{self, Spec};
use movement_engine::env::js_of_json;
use movement_engine::js::Js;
mod frozen;
use serde_json::json;

#[test]
fn chunks_cut_and_estimate_as_they_were_frozen() {
    let cases = frozen::cases("chunks");
    assert!(cases.len() >= 600, "{} cases", cases.len());
    let (mut cut, mut by_entities, mut refused) = (0, 0, 0);
    let answered: Vec<_> = cases
        .iter()
        .map(|case| {
            let text: Vec<char> = case["text"].as_str().unwrap().chars().collect();
            let option = |key: &str| case["options"].get(key).map_or(Js::Undefined, js_of_json);
            let drop = ["error", "pieces", "estimates"];
            let spec = match chunks::read_spec(&option("size"), &option("entities"), &option("overlap")) {
                Ok(spec) => spec,
                Err(error) => {
                    refused += 1;
                    return frozen::answer(case, &drop, vec![("error", json!(error))]);
                }
            };
            cut += 1;
            let pieces: Vec<&[char]> = chunks::chunk(&text, spec).into_iter().map(|range| &text[range]).collect();
            let mut answer = vec![("pieces", json!(pieces.iter().map(|p| p.iter().collect::<String>()).collect::<Vec<_>>()))];
            if let Spec::Entities { .. } = spec {
                by_entities += 1;
                answer.push(("estimates", json!(pieces.iter().map(|p| chunks::entities(p)).collect::<Vec<_>>())));
            }
            frozen::answer(case, &drop, answer)
        })
        .collect();
    assert!(cut > 450 && by_entities > 100 && refused > 40, "cut {cut}, by entities {by_entities}, refused {refused}");
    frozen::settle("chunks", &answered);
}
