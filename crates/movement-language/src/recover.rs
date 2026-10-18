//! Parsing half-typed text. The statement grammar refuses a file at its first
//! error; a file being edited has one near the cursor. So the service parses
//! the text as written, and failing that a repaired copy whose lines and
//! columns are the original's: the cursor's line blanked, then the error's,
//! then the text cut above the cursor with its open brackets closed.

use movement_parser::ast::Program;
use movement_parser::stmt::ParseError;
use movement_parser::util::form::form_of_text;

pub struct Parsed {
    pub program: Program,
    /// The refusal of the text as written, when it was repaired.
    pub refused: Option<ParseError>,
}

pub fn parse(source: &str, version: u32) -> Result<Program, ParseError> {
    movement_parser::stmt::parse_program(&form_of_text(source), version, false)
}

/// The program `source` is, or the nearest repaired copy that parses.
/// `cursor`: the 0-based line being edited, when there is one.
pub fn parse_recovering(source: &str, version: u32, cursor: Option<u32>) -> Option<Parsed> {
    let refused = match parse(source, version) {
        Ok(program) => return Some(Parsed { program, refused: None }),
        Err(refused) => refused,
    };
    let error_line = refused.loc.line.saturating_sub(1) as u32;
    let mut candidates: Vec<String> = Vec::new();
    if let Some(line) = cursor {
        candidates.push(blank_lines(source, &[line]));
    }
    candidates.push(blank_lines(source, &[error_line]));
    if let Some(line) = cursor {
        candidates.push(blank_lines(source, &[line, error_line]));
    }
    if let Some(line) = cursor {
        candidates.push(closed_above(source, line));
    }
    candidates.push(closed_above(source, error_line));
    candidates.into_iter().find_map(|text| parse(&text, version).ok()).map(|program| Parsed { program, refused: Some(refused) })
}

/// `source` with each of `lines` (0-based) written as spaces, its braces and
/// brackets kept, so the lines below keep their structure.
fn blank_lines(source: &str, lines: &[u32]) -> String {
    source
        .split('\n')
        .enumerate()
        .map(|(index, line)| {
            if lines.contains(&(index as u32)) {
                line.chars().map(|c| if matches!(c, '{' | '}' | '\r') { c } else { ' ' }).collect::<String>()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The lines above `line`, then a line closing each bracket they leave open.
fn closed_above(source: &str, line: u32) -> String {
    let kept: Vec<&str> = source.split('\n').take(line as usize).collect();
    let mut text = kept.join("\n");
    let closers: String = open_brackets(&text).into_iter().rev().map(|c| match c {
        '{' => '}',
        '(' => ')',
        _ => ']',
    }).collect();
    text.push('\n');
    for closer in closers.chars() {
        text.push(closer);
        text.push('\n');
    }
    text
}

/// The brackets `text` leaves open, outermost first (strings, backticked
/// names and comments skipped).
pub fn open_brackets(text: &str) -> Vec<char> {
    open_brackets_at(text).into_iter().map(|(_, c)| c).collect()
}

/// `open_brackets`, each with its byte offset in `text`.
pub fn open_brackets_at(text: &str) -> Vec<(usize, char)> {
    let mut open = Vec::new();
    let mut chars = text.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        match c {
            '"' | '`' => {
                let mut escaped = false;
                for (_, d) in chars.by_ref() {
                    if d == c && !escaped {
                        break;
                    }
                    escaped = d == '\\' && !escaped;
                }
            }
            '#' => {
                for (_, d) in chars.by_ref() {
                    if d == '\n' {
                        break;
                    }
                }
            }
            '{' | '(' | '[' => open.push((at, c)),
            '}' | ')' | ']' => {
                open.pop();
            }
            _ => {}
        }
    }
    open
}
