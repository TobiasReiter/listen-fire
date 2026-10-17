//! A text: a Rust `String`, so Unicode scalar values. Every count, cut and
//! search is by character (code point): an emoji's `length` is 1,
//! `split("")` keeps it whole, and a cut never falls inside it. Equality,
//! hashing and order are the `String`'s own.
//!
//! What is not Unicode text never gets in. A host's JSON can escape half
//! of a surrogate pair on its own (`"\ud83d"`, which `JSON.stringify`
//! writes for a lone half); the JSON reader (`read_json_text`) makes each
//! such escape U+FFFD. A program's source reaches the engine the same way,
//! and a string literal has no `\u` escape, so it holds none either.
//!
//! The parser keeps its own text form, so a span counts the UTF-16 units an
//! editor counts (movement_parser::util::form: a U+FDD0 written twice). A
//! literal's text is made plain where it becomes a value (`of_program`).

use std::borrow::Cow;
use std::fmt;

/// A text the engine holds (see the module's note).
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct JsString(String);

impl JsString {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `text === ""`.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn into_string(self) -> String {
        self.0
    }

    /// `.length`: characters.
    pub fn len_chars(&self) -> usize {
        self.0.chars().count()
    }
}

impl fmt::Display for JsString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for JsString {
    fn from(text: String) -> JsString {
        JsString(text)
    }
}

impl From<&str> for JsString {
    fn from(text: &str) -> JsString {
        JsString(text.to_string())
    }
}

impl From<&String> for JsString {
    fn from(text: &String) -> JsString {
        JsString(text.clone())
    }
}

impl From<&JsString> for JsString {
    fn from(text: &JsString) -> JsString {
        text.clone()
    }
}

impl From<Cow<'_, str>> for JsString {
    fn from(text: Cow<'_, str>) -> JsString {
        JsString(text.into_owned())
    }
}

impl From<Box<str>> for JsString {
    fn from(text: Box<str>) -> JsString {
        JsString(String::from(text))
    }
}

impl From<char> for JsString {
    fn from(c: char) -> JsString {
        JsString(c.to_string())
    }
}

impl FromIterator<char> for JsString {
    fn from_iter<I: IntoIterator<Item = char>>(chars: I) -> JsString {
        JsString(chars.into_iter().collect())
    }
}

impl std::borrow::Borrow<str> for JsString {
    fn borrow(&self) -> &str {
        &self.0
    }
}

impl serde::Serialize for JsString {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl From<JsString> for String {
    fn from(text: JsString) -> String {
        text.0
    }
}

impl PartialEq<str> for JsString {
    fn eq(&self, other: &str) -> bool {
        self.0 == other
    }
}

impl PartialEq<&str> for JsString {
    fn eq(&self, other: &&str) -> bool {
        self.0 == *other
    }
}

impl PartialEq<String> for JsString {
    fn eq(&self, other: &String) -> bool {
        &self.0 == other
    }
}

impl PartialEq<JsString> for str {
    fn eq(&self, other: &JsString) -> bool {
        self == other.0
    }
}

impl PartialEq<JsString> for &str {
    fn eq(&self, other: &JsString) -> bool {
        *self == other.0
    }
}

impl PartialEq<JsString> for String {
    fn eq(&self, other: &JsString) -> bool {
        *self == other.0
    }
}

// ── Characters ────────────────────────────────────────────────────────────────

/// `.length`: characters, not bytes.
pub fn len_chars(text: &str) -> usize {
    text.chars().count()
}

/// The text's first `count` characters (all of it when it has fewer).
pub fn first_chars(text: &str, count: usize) -> &str {
    text.char_indices().nth(count).map_or(text, |(at, _)| &text[..at])
}

/// `split("")`: one text per character.
pub fn split_chars(text: &str) -> Vec<String> {
    text.chars().map(String::from).collect()
}

/// `JSON.stringify(text)`: the quoting JSON.stringify does (`\u00xx` in
/// lower case for the controls it has no short escape for).
pub fn json_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ── The program boundary ──────────────────────────────────────────────────────

/// A text the parser wrote (a literal, a map key), as the text it is.
pub fn of_program(text: &str) -> Cow<'_, str> {
    use movement_parser::util::form::{ESCAPE, Piece, pieces};
    if !text.contains(ESCAPE) {
        return Cow::Borrowed(text);
    }
    Cow::Owned(
        pieces(text)
            .map(|piece| match piece {
                Piece::Char(c) => c,
                Piece::Lone(_) => '\u{FFFD}',
            })
            .collect(),
    )
}

// ── The JSON text boundary ────────────────────────────────────────────────────

/// A JSON text ready for serde_json (which refuses a lone surrogate's
/// escape): each `\udXXX` escape that is not half of an escaped pair
/// rewritten `\ufffd`. A text with none is itself.
pub fn read_json_text(text: &str) -> Cow<'_, str> {
    if !text.contains("\\u") {
        return Cow::Borrowed(text);
    }
    let bytes = text.as_bytes();
    let escape_at = |at: usize| -> Option<u16> {
        if bytes.get(at) != Some(&b'\\') || bytes.get(at + 1) != Some(&b'u') {
            return None;
        }
        let digits = text.get(at + 2..at + 6)?;
        digits.bytes().all(|b| b.is_ascii_hexdigit()).then(|| u16::from_str_radix(digits, 16).ok()).flatten()
    };
    let mut out = String::new();
    let mut in_string = false;
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'"' => {
                in_string = !in_string;
                at += 1;
            }
            b'\\' if in_string => match escape_at(at) {
                Some(0xD800..=0xDBFF) if matches!(escape_at(at + 6), Some(0xDC00..=0xDFFF)) => at += 12,
                Some(0xD800..=0xDFFF) => {
                    out.push_str(&text[copied..at]);
                    out.push_str("\\ufffd");
                    at += 6;
                    copied = at;
                }
                // Any other escape, a backslash's included, is two bytes on.
                _ => at += 2,
            },
            _ => at += 1,
        }
    }
    if copied == 0 {
        return Cow::Borrowed(text);
    }
    out.push_str(&text[copied..]);
    Cow::Owned(out)
}

/// `serde_json::from_str`, through the JSON text reader.
pub fn from_json_text<T: serde::de::DeserializeOwned>(text: &str) -> serde_json::Result<T> {
    serde_json::from_str(&read_json_text(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_text_counts_and_cuts_by_character() {
        assert_eq!(len_chars("a😀b"), 3);
        assert_eq!(JsString::from("😀").len_chars(), 1);
        assert_eq!(first_chars("a😀b", 2), "a😀");
        assert_eq!(first_chars("ab", 5), "ab");
        assert_eq!(split_chars("a😀"), ["a", "😀"]);
    }

    #[test]
    fn a_lone_surrogate_from_the_host_is_u_fffd() {
        let read: serde_json::Value = from_json_text(r#"{"a":"x\ud83d","b":"\ud83d\ude00","c":"\\ud800","\udc00":"\ufdd0\u0041"}"#).unwrap();
        assert_eq!(read["a"], "x\u{FFFD}");
        assert_eq!(read["b"], "😀");
        assert_eq!(read["c"], "\\ud800");
        assert_eq!(read["\u{FFFD}"], "\u{FDD0}A");
        assert_eq!(serde_json::to_string(&read).unwrap(), r#"{"a":"x�","b":"😀","c":"\\ud800","�":"﷐A"}"#);
        assert!(matches!(read_json_text(r#"{"a":"\u0041"}"#), Cow::Borrowed(_)));
    }

    #[test]
    fn a_literal_s_text_is_made_plain() {
        let written = movement_parser::util::form::text_of_units(&[0x61, 0xFDD0, 0xD800]);
        assert_eq!(of_program(&written), "a\u{FDD0}\u{FFFD}");
        assert!(matches!(of_program("a😀"), Cow::Borrowed("a😀")));
    }

    #[test]
    fn json_quote_writes_as_json_stringify_does() {
        assert_eq!(json_quote("\"a\\\u{1}\n😀"), r#""\"a\\\u0001\n😀""#);
    }
}
