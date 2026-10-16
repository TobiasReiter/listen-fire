//! A parked state's spans, read back as the program's tree holds them.

use movement_parser::ast::Span;
use serde_json::Value as Json;

use crate::js::Js;

/// A state's `span` object, as the program's tree holds it.
pub(crate) fn span_json(value: &Js) -> Option<(Span, Json)> {
    let json = crate::env::json_of_js(value);
    let loc = |key: &str| -> Option<movement_parser::ast::Loc> {
        let at = json.get(key)?;
        Some(movement_parser::ast::Loc { line: at.get("line")?.as_u64()? as usize, col: at.get("col")?.as_u64()? as usize })
    };
    Some((Span { start: loc("start")?, end: loc("end")? }, json))
}
