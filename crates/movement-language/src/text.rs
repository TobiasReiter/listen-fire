//! Positions as an editor counts them (0-based lines, UTF-16 columns) and as
//! the parser's spans count them (1-based lines and UTF-16 columns), and the
//! text around a position.

use movement_parser::ast::{Loc, Span};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Pos {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    pub start: Pos,
    pub end: Pos,
}

pub fn loc_of(pos: Pos) -> Loc {
    Loc { line: pos.line as usize + 1, col: pos.character as usize + 1 }
}

pub fn pos_of(loc: Loc) -> Pos {
    Pos { line: loc.line.saturating_sub(1) as u32, character: loc.col.saturating_sub(1) as u32 }
}

pub fn range_of(span: &Span) -> Range {
    Range { start: pos_of(span.start), end: pos_of(span.end) }
}

/// A document split into lines.
pub struct Text<'a> {
    pub source: &'a str,
    lines: Vec<&'a str>,
}

impl<'a> Text<'a> {
    pub fn new(source: &'a str) -> Self {
        Text { source, lines: source.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect() }
    }

    pub fn line(&self, line: u32) -> &'a str {
        self.lines.get(line as usize).copied().unwrap_or("")
    }

    pub fn line_count(&self) -> usize {
        self.lines.len()
    }

    /// The byte offset in its line of the UTF-16 column `character`.
    pub fn byte_in_line(&self, line: u32, character: u32) -> usize {
        byte_of_utf16(self.line(line), character as usize)
    }

    /// The line's text before `pos`.
    pub fn line_before(&self, pos: Pos) -> &'a str {
        let line = self.line(pos.line);
        &line[..self.byte_in_line(pos.line, pos.character)]
    }

    /// The line's text from `pos` on.
    pub fn line_after(&self, pos: Pos) -> &'a str {
        let line = self.line(pos.line);
        &line[self.byte_in_line(pos.line, pos.character)..]
    }

    /// Every line above `pos`, and its line up to it.
    pub fn before(&self, pos: Pos) -> String {
        let mut out = String::new();
        for line in self.lines.iter().take(pos.line as usize) {
            out.push_str(line);
            out.push('\n');
        }
        out.push_str(self.line_before(pos));
        out
    }

    /// The text from `pos` to the end.
    pub fn after(&self, pos: Pos) -> String {
        let mut out = self.line_after(pos).to_string();
        for line in self.lines.iter().skip(pos.line as usize + 1) {
            out.push('\n');
            out.push_str(line);
        }
        out
    }

    /// The text a span covers.
    pub fn slice(&self, span: &Span) -> String {
        let (start, end) = (pos_of(span.start), pos_of(span.end));
        if start.line == end.line {
            let line = self.line(start.line);
            let (a, b) = (self.byte_in_line(start.line, start.character), self.byte_in_line(end.line, end.character));
            return line.get(a..b.max(a)).unwrap_or("").to_string();
        }
        let mut out = self.line_after(start).to_string();
        for line in start.line + 1..end.line {
            out.push('\n');
            out.push_str(self.line(line));
        }
        out.push('\n');
        out.push_str(self.line_before(end));
        out
    }
}

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn byte_of_utf16(line: &str, units: usize) -> usize {
    let mut counted = 0;
    for (byte, ch) in line.char_indices() {
        if counted >= units {
            return byte;
        }
        counted += ch.len_utf16();
    }
    line.len()
}

pub fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The trailing identifier of `text` (letters, digits, `_`), possibly empty.
pub fn trailing_word(text: &str) -> &str {
    let start = text.char_indices().rev().take_while(|(_, c)| is_word_char(*c)).last().map_or(text.len(), |(i, _)| i);
    &text[start..]
}

/// Whether `text` holds an odd number of backticks: it ends inside a
/// backticked name.
pub fn inside_backticks(text: &str) -> bool {
    text.matches('`').count() % 2 == 1
}

/// A name as written: bare when it is an identifier, backticked otherwise.
pub fn written_name(name: &str) -> String {
    let bare = name.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_') && name.chars().all(is_word_char);
    if bare { name.to_string() } else { format!("`{name}`") }
}

/// Whether `text` ends inside a quoted string.
pub fn inside_quotes(text: &str) -> bool {
    let mut inside = false;
    let mut escaped = false;
    for c in text.chars() {
        if c == '"' && !escaped {
            inside = !inside;
        }
        escaped = c == '\\' && !escaped;
    }
    inside
}
