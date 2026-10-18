//! The record a written receiver holds: a name the check typed, or a walk off
//! one (`c-[m:Messages]->`, an alias `m` bound by a hop), stepped edge by edge
//! with the checker's own `edge_landing`.

use movement_checker::query::Analysis;
use movement_checker::types::Ty;
use movement_checker::types::field::describe_field_type;
use movement_checker::types::position::{EdgeLanding, Position, describe_position, edge_landing, position_schema_of_ref, record_field_types};
use movement_parser::ast::Loc;

use crate::text::trailing_word;

/// The record `text` (ending where the receiver ends) holds at `at`.
pub fn receiver(analysis: &Analysis, text: &str, at: Loc, version: u32) -> Option<Position> {
    receiver_within(analysis, text, at, version, 0)
}

fn receiver_within(analysis: &Analysis, text: &str, at: Loc, version: u32, depth: usize) -> Option<Position> {
    if depth > 16 {
        return None;
    }
    let trimmed = text.trim_end();
    if let Some(head) = trimmed.strip_suffix("]->") {
        let open = hop_open(head)?;
        let edge = hop_edge(&head[open + 2..])?;
        let from = receiver_within(analysis, &head[..open], at, version, depth + 1)?;
        return land(&from, &edge, version);
    }
    let name = trailing_name(trimmed)?;
    if let Some(position) = analysis.resolve(at, &name).and_then(|id| analysis.position_of(id)) {
        return Some(position.clone());
    }
    // An alias a hop earlier in the text binds.
    let bound = text.rfind(&format!("-[{name}:"))?;
    let edge = hop_edge(&text[bound + 2..])?;
    let from = receiver_within(analysis, &text[..bound], at, version, depth + 1)?;
    land(&from, &edge, version)
}

/// Where `-[` opens the hop `head` (the text before its `]->`) closes.
fn hop_open(head: &str) -> Option<usize> {
    let mut depth = 1usize;
    for (at, c) in head.char_indices().rev() {
        match c {
            ']' => depth += 1,
            '[' => {
                depth -= 1;
                if depth == 0 {
                    return head[..at].ends_with('-').then(|| at - 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// The edge a hop's text (after its `-[`) names: `m:Messages WHERE …` → `Messages`.
pub fn hop_edge(hop: &str) -> Option<String> {
    let after = match hop.find(':') {
        Some(colon) if !hop[..colon].contains(|c: char| c.is_whitespace() || c == '`') => &hop[colon + 1..],
        _ => hop,
    };
    let after = after.trim_start();
    if let Some(rest) = after.strip_prefix('`') {
        return rest.find('`').map(|end| rest[..end].to_string());
    }
    let name: String = after.chars().take_while(|c| crate::text::is_word_char(*c) || *c == '#' || *c == '@').collect();
    (!name.is_empty()).then_some(name)
}

/// The name `text` ends with: an identifier, or a backticked name.
pub fn trailing_name(text: &str) -> Option<String> {
    if let Some(head) = text.strip_suffix('`') {
        return head.rfind('`').map(|open| head[open + 1..].to_string());
    }
    let word = trailing_word(text);
    (!word.is_empty()).then(|| word.to_string())
}

fn land(from: &Position, edge: &str, version: u32) -> Option<Position> {
    match edge_landing(strip(from), edge, version) {
        EdgeLanding::Landed { landing, .. } => Some(landing),
        _ => None,
    }
}

fn strip(position: &Position) -> &Position {
    match position {
        Position::MaybeEmpty(of) => strip(of),
        other => other,
    }
}

/// The fields a record holds, each with its type as the author reads it.
pub fn fields(position: &Position) -> Vec<(String, Option<String>)> {
    record_field_types(position)
        .map(|fields| fields.into_iter().map(|(name, ty)| (name, ty.as_ref().map(describe_field_type))).collect())
        .unwrap_or_default()
}

/// The edges a walk can take next off a record, each with where it lands.
pub fn edges(position: &Position, version: u32) -> Vec<(String, String)> {
    let Some(schema) = position_schema_of_ref(strip(position)) else { return Vec::new() };
    schema
        .edges
        .iter()
        .map(|(name, edge)| {
            let landing = land(position, name, version).map_or_else(|| edge.target.clone(), |p| describe_position(&p));
            (name.clone(), landing)
        })
        .collect()
}

/// A field's type off a record, as the author reads it.
pub fn field_type(position: &Position, field: &str) -> Option<String> {
    let ty: Option<Ty> = movement_checker::types::position::lookup_property_type(Some(position), field);
    ty.as_ref().map(describe_field_type)
}
