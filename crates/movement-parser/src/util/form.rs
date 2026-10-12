//! The engine's text form: any run of UTF-16 code units in a Rust `String`,
//! a lone surrogate held in-band as U+FDD0 (`ESCAPE`, a noncharacter
//! Unicode reserves for a program's internal use) then one plane-16
//! private-use character naming the unit (U+100000 + unit − U+D800), and a
//! U+FDD0 the text holds written twice. The engine's JSON reader writes
//! every host text so, the program source included; the parser reads the
//! source's code units through this form, so a span counts what the
//! TypeScript parser counts. A text with no U+FDD0 is itself.

use std::borrow::Cow;

/// U+FDD0: what begins a lone surrogate's escape, or a U+FDD0 written twice.
pub const ESCAPE: char = '\u{FDD0}';
pub(crate) const PLANE_16: u32 = 0x10_0000;
const ESCAPE_UTF8: &[u8] = "\u{FDD0}".as_bytes();

/// One piece of a text: a character, or a lone surrogate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Piece {
    Char(char),
    Lone(u16),
}

impl Piece {
    pub fn len_utf16(self) -> usize {
        match self {
            Piece::Char(c) => c.len_utf16(),
            Piece::Lone(_) => 1,
        }
    }

    /// Appended to a text in the engine's form.
    pub fn push_onto(self, out: &mut String) {
        match self {
            Piece::Char(ESCAPE) => {
                out.push(ESCAPE);
                out.push(ESCAPE);
            }
            Piece::Char(c) => out.push(c),
            Piece::Lone(unit) => {
                out.push(ESCAPE);
                out.push(char::from_u32(PLANE_16 + u32::from(unit - 0xD800)).expect("a plane-16 scalar"));
            }
        }
    }
}

/// A text's pieces, in order. A U+FDD0 not followed by its escape's second
/// character (a text that never passed the JSON reader) is itself.
pub fn pieces(text: &str) -> impl Iterator<Item = Piece> + '_ {
    let mut chars = text.chars().peekable();
    std::iter::from_fn(move || {
        let c = chars.next()?;
        if c != ESCAPE {
            return Some(Piece::Char(c));
        }
        match chars.peek().copied() {
            Some(ESCAPE) => {
                chars.next();
                Some(Piece::Char(ESCAPE))
            }
            Some(next) if (PLANE_16..PLANE_16 + 0x800).contains(&(next as u32)) => {
                chars.next();
                Some(Piece::Lone((next as u32 - PLANE_16) as u16 + 0xD800))
            }
            _ => Some(Piece::Char(ESCAPE)),
        }
    })
}

/// A text's UTF-16 code units.
pub fn units_of(text: &str) -> impl Iterator<Item = u16> + '_ {
    pieces(text).flat_map(|piece| {
        let mut buffer = [0u16; 2];
        let units: Vec<u16> = match piece {
            Piece::Char(c) => c.encode_utf16(&mut buffer).to_vec(),
            Piece::Lone(unit) => vec![unit],
        };
        units
    })
}

/// A text's code units, collected.
pub fn units_vec(text: &str) -> Vec<u16> {
    if !text.contains(ESCAPE) {
        return text.encode_utf16().collect();
    }
    units_of(text).collect()
}

/// The text these code units make, in the engine's form.
pub fn text_of_units(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len());
    for decoded in char::decode_utf16(units.iter().copied()) {
        let piece = match decoded {
            Ok(c) => Piece::Char(c),
            Err(lone) => Piece::Lone(lone.unpaired_surrogate()),
        };
        piece.push_onto(&mut out);
    }
    out
}

/// `.length`: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    if !text.contains(ESCAPE) {
        return text.encode_utf16().count();
    }
    pieces(text).map(Piece::len_utf16).sum()
}

/// Whether the text holds no lone surrogate.
pub fn is_well_formed(text: &str) -> bool {
    !text.contains(ESCAPE) || pieces(text).all(|piece| matches!(piece, Piece::Char(_)))
}


/// The text as it leaves the engine for a reader that knows no form: each
/// lone surrogate written `\udXXX` (as `JSON.stringify` escapes one), each
/// doubled U+FDD0 written once. The JSON writer is this over serde_json's
/// output, where the form only ever sits inside a string; a panic's message
/// is this over its text.
pub fn external_text(text: &str) -> Cow<'_, str> {
    if !text.contains(ESCAPE) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    for piece in pieces(text) {
        match piece {
            Piece::Lone(unit) => out.push_str(&format!("\\u{unit:04x}")),
            Piece::Char(c) => out.push(c),
        }
    }
    Cow::Owned(out)
}

/// A text from outside (UTF-8, so no lone surrogate) in the form: each
/// U+FDD0 written twice. A text with none is itself.
pub fn form_of_text(text: &str) -> Cow<'_, str> {
    if !text.contains(ESCAPE) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len() + 3);
    for c in text.chars() {
        Piece::Char(c).push_onto(&mut out);
    }
    Cow::Owned(out)
}

/// Bytes written for a reader outside: `external_text` over them.
pub fn external_bytes(bytes: Vec<u8>) -> Vec<u8> {
    match std::str::from_utf8(&bytes).map(external_text) {
        Ok(Cow::Owned(text)) => text.into_bytes(),
        _ => bytes,
    }
}

/// A JSON text as `JSON.parse` reads it, ready for serde_json: each lone
/// `\udXXX` escape (serde_json refuses one) and each U+FDD0, raw or escaped,
/// rewritten in the engine's form. Everything else is left as written, a
/// pair's two escapes included. A text with neither is itself.
pub fn read_json_text(text: &str) -> Cow<'_, str> {
    if !text.contains(ESCAPE) && !text.contains("\\u") {
        return Cow::Borrowed(text);
    }
    let bytes = text.as_bytes();
    let hex_at = |at: usize| -> Option<u16> {
        let digits = text.get(at..at + 4)?;
        digits.bytes().all(|b| b.is_ascii_hexdigit()).then(|| u16::from_str_radix(digits, 16).ok()).flatten()
    };
    let escape_at = |at: usize| -> Option<u16> { (bytes.get(at) == Some(&b'\\') && bytes.get(at + 1) == Some(&b'u')).then(|| hex_at(at + 2)).flatten() };
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut copied = 0;
    let mut at = 0;
    let mut changed = false;
    while at < bytes.len() {
        match bytes[at] {
            b'"' => {
                in_string = !in_string;
                at += 1;
            }
            b'\\' if in_string => match escape_at(at) {
                Some(0xD800..=0xDBFF) if matches!(escape_at(at + 6), Some(0xDC00..=0xDFFF)) => at += 12,
                Some(unit @ (0xD800..=0xDFFF | 0xFDD0)) => {
                    out.push_str(&text[copied..at]);
                    let piece = if unit == 0xFDD0 { Piece::Char(ESCAPE) } else { Piece::Lone(unit) };
                    piece.push_onto(&mut out);
                    at += 6;
                    copied = at;
                    changed = true;
                }
                // Any other escape, a backslash's included, is two bytes on.
                _ => at += 2,
            },
            _ if in_string && bytes[at..].starts_with(ESCAPE_UTF8) => {
                out.push_str(&text[copied..at]);
                Piece::Char(ESCAPE).push_onto(&mut out);
                at += ESCAPE.len_utf8();
                copied = at;
                changed = true;
            }
            _ => at += 1,
        }
    }
    if !changed {
        return Cow::Borrowed(text);
    }
    out.push_str(&text[copied..]);
    Cow::Owned(out)
}


/// The text as a UTF-8 encoder writes it (`TextEncoder`, a WebIDL
/// `USVString`): each lone surrogate U+FFFD, still in the form.
pub fn usv_text(text: &str) -> Cow<'_, str> {
    if is_well_formed(text) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    for piece in pieces(text) {
        match piece {
            Piece::Lone(_) => out.push('\u{FFFD}'),
            other => other.push_onto(&mut out),
        }
    }
    Cow::Owned(out)
}
