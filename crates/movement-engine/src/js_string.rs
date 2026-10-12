//! A JavaScript string: any sequence of UTF-16 code units, a lone surrogate
//! included (`JSON.parse('"\ud83d"')` makes one, and so does a cut through a
//! surrogate pair, `"😀".slice(0, 1)`).
//!
//! A Rust `String` holds Unicode scalar values only, so a lone surrogate is
//! held in-band: the noncharacter U+FDD0 (`ESCAPE`, which Unicode reserves
//! for a program's internal use) followed by one plane-16 private-use
//! character naming the unit (U+100000 + unit − U+D800). A U+FDD0 the text
//! itself holds is written twice. Every text the engine holds is in this
//! form, the host's JSON (serde_json's `Value`) included: the JSON text
//! reader (`read_json_text`) turns a lone `\udXXX` escape into it and the
//! writer (`write_json_text`) turns it back, as `JSON.parse` and
//! `JSON.stringify` read and write one. A text with no lone surrogate (and
//! no U+FDD0) is itself, byte for byte: nothing is paid for the escape
//! unless it is there.
//!
//! The form is canonical (a lone high half followed by a lone low half is
//! the pair, as `"\ud83d" + "\ude00"` is `"😀"`), so equality and hashing of
//! the Rust text are JavaScript's `===`. What counts or cuts by code unit
//! (`length`, `slice`, a regex, `split("")`, an order by code unit) reads
//! the units (`units_of`); a search whose text or needle holds the escape
//! searches the units (`find_units`), as a plane-16 character the text
//! holds would otherwise match an escape's second half.

use std::borrow::Cow;
use std::fmt;

pub use movement_parser::util::form::{read_json_text, ESCAPE, Piece, is_well_formed, pieces, text_of_units, units_of, units_vec, utf16_len};

/// A JavaScript string, in the engine's form (see the module's note).
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct JsString(String);

impl JsString {
    /// The text in the engine's in-band form (the module's note): for a
    /// function of this crate that reads the form (`utf16_len`, `trim`,
    /// `to_lower_case`, `string_to_number`, a comparison with known text, a
    /// key), and for the JSON writer. Never read it with a `str` method that
    /// counts, cuts or searches: there a lone surrogate is two characters
    /// where JavaScript sees one unit.
    pub fn as_form(&self) -> &str {
        &self.0
    }

    /// `text === ""`.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn into_string(self) -> String {
        self.0
    }

    /// A text made of these code units, lone surrogates and all.
    pub fn from_units(units: &[u16]) -> JsString {
        JsString(text_of_units(units))
    }

    /// `.length`.
    pub fn len_utf16(&self) -> usize {
        utf16_len(&self.0)
    }

    /// Whether every surrogate is half of a pair (`isWellFormed()`).
    pub fn is_well_formed(&self) -> bool {
        is_well_formed(&self.0)
    }
}


impl fmt::Display for JsString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for JsString {
    fn from(text: String) -> JsString {
        JsString(canonical(text))
    }
}

impl From<&str> for JsString {
    fn from(text: &str) -> JsString {
        JsString::from(text.to_string())
    }
}

impl From<&String> for JsString {
    fn from(text: &String) -> JsString {
        JsString::from(text.clone())
    }
}

impl From<&JsString> for JsString {
    fn from(text: &JsString) -> JsString {
        text.clone()
    }
}

impl From<Cow<'_, str>> for JsString {
    fn from(text: Cow<'_, str>) -> JsString {
        JsString::from(text.into_owned())
    }
}

impl From<Box<str>> for JsString {
    fn from(text: Box<str>) -> JsString {
        JsString::from(String::from(text))
    }
}

impl From<char> for JsString {
    fn from(c: char) -> JsString {
        JsString::from(c.to_string())
    }
}

impl FromIterator<char> for JsString {
    fn from_iter<I: IntoIterator<Item = char>>(chars: I) -> JsString {
        JsString::from(chars.into_iter().collect::<String>())
    }
}

impl std::borrow::Borrow<str> for JsString {
    fn borrow(&self) -> &str {
        &self.0
    }
}

/// Written as the text it is; the JSON text writer writes a lone surrogate.
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

// ── The form ──────────────────────────────────────────────────────────────────

/// `text` in the canonical form: a lone high half met by a lone low half
/// made the pair, a bare U+FDD0 written twice.
fn canonical(text: String) -> String {
    if !text.contains(ESCAPE) {
        return text;
    }
    text_of_units(&units_vec(&text))
}

/// `text.slice(from, to)` by code unit (`from <= to`, both within the
/// text): a cut through a pair keeps the half on its side.
pub fn slice_units(text: &str, from: usize, to: usize) -> String {
    let units = units_vec(text);
    text_of_units(&units[from.min(units.len())..to.min(units.len())])
}

/// `haystack.indexOf(needle, from)` by code unit.
pub fn find_units(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(haystack.len()));
    }
    (from..=haystack.len().checked_sub(needle.len())?).find(|&at| haystack[at..at + needle.len()] == *needle)
}

/// Whether a search over these texts must read their code units: either
/// holds the escape.
pub fn needs_units(a: &str, b: &str) -> bool {
    a.contains(ESCAPE) || b.contains(ESCAPE)
}

/// `haystack.includes(needle)`.
pub fn includes(haystack: &str, needle: &str) -> bool {
    if !needs_units(haystack, needle) {
        return haystack.contains(needle);
    }
    find_units(&units_vec(haystack), &units_vec(needle), 0).is_some()
}

/// `text.split(separator)` (a non-empty separator), by code unit.
pub fn split(text: &str, separator: &str) -> Vec<String> {
    if !needs_units(text, separator) {
        return text.split(separator).map(String::from).collect();
    }
    let (units, separator) = (units_vec(text), units_vec(separator));
    let mut parts = Vec::new();
    let mut at = 0;
    while let Some(found) = find_units(&units, &separator, at) {
        parts.push(text_of_units(&units[at..found]));
        at = found + separator.len();
    }
    parts.push(text_of_units(&units[at..]));
    parts
}

/// `text.split("")`: one text per code unit, a pair's halves apart.
pub fn split_units(text: &str) -> Vec<String> {
    units_vec(text).into_iter().map(|unit| text_of_units(&[unit])).collect()
}

/// `JSON.stringify(text)`: the quoting JSON.stringify does (`\u00xx` in
/// lower case for the controls it has no short escape for, and for a lone
/// surrogate).
pub fn json_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for piece in pieces(text) {
        match piece {
            Piece::Lone(unit) => out.push_str(&format!("\\u{unit:04x}")),
            Piece::Char('"') => out.push_str("\\\""),
            Piece::Char('\\') => out.push_str("\\\\"),
            Piece::Char('\u{08}') => out.push_str("\\b"),
            Piece::Char('\u{0C}') => out.push_str("\\f"),
            Piece::Char('\n') => out.push_str("\\n"),
            Piece::Char('\r') => out.push_str("\\r"),
            Piece::Char('\t') => out.push_str("\\t"),
            Piece::Char(c) if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            // In the engine's form, as every text is (a U+FDD0 twice).
            other => other.push_onto(&mut out),
        }
    }
    out.push('"');
    out
}

// ── The JSON text boundary ────────────────────────────────────────────────────

/// A JSON text serde_json wrote, as `JSON.stringify` writes it: each lone
/// surrogate the engine's form holds written `\udXXX`, each U+FDD0 written
/// once. The escape only ever sits inside a JSON string, which is where
/// serde_json puts text.
pub fn write_json_text(text: String) -> String {
    match movement_parser::util::form::external_text(&text) {
        Cow::Borrowed(_) => text,
        Cow::Owned(out) => out,
    }
}

/// `serde_json::from_str`, through the JSON text reader.
pub fn from_json_text<T: serde::de::DeserializeOwned>(text: &str) -> serde_json::Result<T> {
    serde_json::from_str(&read_json_text(text))
}

/// `serde_json::to_string`, through the JSON text writer.
pub fn to_json_text<T: serde::Serialize + ?Sized>(value: &T) -> String {
    write_json_text(serde_json::to_string(value).expect("a JSON value serializes"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lone(unit: u16) -> String {
        text_of_units(&[unit])
    }

    #[test]
    fn a_lone_surrogate_is_held_and_counted_as_one_unit() {
        let high = JsString::from_units(&[0xD83D]);
        assert_eq!(high.len_utf16(), 1);
        assert!(!high.is_well_formed());
        assert_eq!(units_vec(high.as_form()), [0xD83D]);
        assert!(JsString::from("😀").is_well_formed());
        assert_eq!(JsString::from(format!("a{high}")).len_utf16(), 2);
    }

    #[test]
    fn two_halves_made_one_text_are_the_pair() {
        let joined = JsString::from(format!("{}{}", lone(0xD83D), lone(0xDE00)));
        assert_eq!(joined, "😀");
        assert_eq!(slice_units("😀", 0, 1), lone(0xD83D));
        assert_eq!(slice_units("a😀", 0, 2), format!("a{}", lone(0xD83D)));
    }

    #[test]
    fn a_text_holding_the_escape_character_keeps_it() {
        let text = JsString::from_units(&[0x61, 0xFDD0, 0xD800]);
        assert_eq!(units_vec(text.as_form()), [0x61, 0xFDD0, 0xD800]);
        assert_eq!(text.len_utf16(), 3);
        // A bare one (never read through the JSON reader) is itself.
        assert_eq!(JsString::from("a\u{FDD0}b").len_utf16(), 3);
        assert_eq!(units_vec(JsString::from("a\u{FDD0}b").as_form()), [0x61, 0xFDD0, 0x62]);
    }

    #[test]
    fn a_search_reads_code_units() {
        // `"😀".includes("\ud83d")` and its split, as JavaScript answers.
        assert!(includes("😀", &lone(0xD83D)));
        assert_eq!(split("a😀b", &lone(0xDE00)), [format!("a{}", lone(0xD83D)), "b".to_string()]);
        // A plane-16 character the text holds is not a lone surrogate's escape.
        let plane16 = "\u{100000}";
        assert!(!includes(&lone(0xD800), plane16));
        assert_eq!(split_units("a😀"), ["a".to_string(), lone(0xD83D), lone(0xDE00)]);
    }

    #[test]
    fn the_json_text_boundary_reads_and_writes_as_javascript_does() {
        let read: serde_json::Value = from_json_text(r#"{"a":"x\ud83d","b":"\ud83d\ude00","c":"\\ud800","\udc00":"\ufdd0\u0041"}"#).unwrap();
        assert_eq!(read["a"].as_str().unwrap(), format!("x{}", lone(0xD83D)));
        assert_eq!(read["b"].as_str().unwrap(), "😀");
        assert_eq!(read["c"].as_str().unwrap(), "\\ud800");
        assert_eq!(read[lone(0xDC00).as_str()].as_str().unwrap(), "\u{FDD0}\u{FDD0}A");
        assert_eq!(to_json_text(&read), r#"{"a":"x\ud83d","b":"😀","c":"\\ud800","\udc00":"﷐A"}"#);
        assert_eq!(json_quote(&format!("\"{}", lone(0xDBFF))), r#""\"\udbff""#);
        assert!(matches!(read_json_text(r#"{"a":"\u0041"}"#), Cow::Borrowed(_)));
    }
}
