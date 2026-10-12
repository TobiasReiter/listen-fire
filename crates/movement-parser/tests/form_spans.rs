//! A source in the engine's text form (crate::util::form: a lone surrogate
//! held in-band, a U+FDD0 the text holds written twice) parses with the
//! spans the TypeScript parser gives the source's code units: one unit for
//! a U+FDD0 and one for a lone half, as for any BMP character. So the tree
//! is the tree of the same program with each such unit replaced by `x`,
//! but for the literal's text.

use movement_parser::util::form::text_of_units;

fn program(odd: &[u16]) -> String {
    let mut units: Vec<u16> = "movement m(msg: <inbox-[:message]->>) {\n  ready = () => { return msg.`subject` != \"".encode_utf16().collect();
    units.extend_from_slice(odd);
    units.extend("\" }\n  await sleep(1h)\n  ERROR(\"done ${ready()}\")\n}".encode_utf16());
    text_of_units(&units)
}

#[test]
fn a_source_holding_the_escape_or_a_lone_half_keeps_the_typescript_spans() {
    let plain = movement_parser::parse_program(&program(&[0x78]), 3).expect("parses");
    let plain = serde_json::to_string(&plain).unwrap();
    for odd in [&[0xFDD0][..], &[0xD83D], &[0xDE00], &[0xFDD0, 0xDBC0, 0xDC00]] {
        let parsed = movement_parser::parse_program(&program(odd), 3).expect("parses");
        let text = serde_json::to_string(&parsed).unwrap();
        // Every span is the plain program's; only the literal's text differs.
        let literal = text_of_units(odd);
        let expected = if odd.len() == 1 { plain.replace("!= \\\"x\\\"", &format!("!= \\\"{literal}\\\"")) } else { String::new() };
        if odd.len() == 1 {
            assert_eq!(text, expected, "{odd:x?}");
        } else {
            // Three units: the spans after the literal move by two, as the
            // TypeScript's do.
            let wider = movement_parser::parse_program(&program(&[0x78, 0x78, 0x78]), 3).expect("parses");
            let wider = serde_json::to_string(&wider).unwrap().replace("!= \\\"xxx\\\"", &format!("!= \\\"{literal}\\\""));
            assert_eq!(text, wider, "{odd:x?}");
        }
    }
}
