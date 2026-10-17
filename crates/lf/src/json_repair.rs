//! A model reply's broken JSON repaired as the TypeScript engine repairs it:
//! a port of the npm `jsonrepair` 3.8.0 (its non-streaming `jsonrepair`),
//! which movement-engine's `parseJsonReply` calls. The text is walked in
//! UTF-16 units, as JavaScript indexes a string, so a repair lands where the
//! TypeScript one does. The replies both are held to: `testdata/json_replies.json`.
//!
//! jsonrepair is Copyright (c) 2020-2023 by Jos de Jong, under the ISC
//! License: permission to use, copy, modify, and/or distribute this software
//! for any purpose with or without fee is hereby granted, provided that the
//! above copyright notice and this permission notice appear in all copies.
//! THE SOFTWARE IS PROVIDED "AS IS" AND ISC DISCLAIMS ALL WARRANTIES WITH
//! REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
//! MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL ISC BE LIABLE FOR ANY
//! SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
//! WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
//! ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
//! IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

/// Why a text could not be repaired, and where.
#[derive(Debug, PartialEq)]
pub struct RepairError {
    pub message: String,
    pub position: usize,
}

/// `jsonrepair`: the text as valid JSON, or why it cannot be.
pub fn repair(text: &str) -> Result<String, RepairError> {
    let mut repairing = Repair { text: text.encode_utf16().collect(), i: 0, output: Vec::new() };
    repairing.document()?;
    Ok(String::from_utf16_lossy(&repairing.output))
}

const BACKSLASH: u16 = b'\\' as u16;
const SLASH: u16 = b'/' as u16;
const ASTERISK: u16 = b'*' as u16;
const OPENING_BRACE: u16 = b'{' as u16;
const CLOSING_BRACE: u16 = b'}' as u16;
const OPENING_BRACKET: u16 = b'[' as u16;
const CLOSING_BRACKET: u16 = b']' as u16;
const OPEN_PARENTHESIS: u16 = b'(' as u16;
const CLOSE_PARENTHESIS: u16 = b')' as u16;
const SPACE: u16 = b' ' as u16;
const NEWLINE: u16 = b'\n' as u16;
const TAB: u16 = b'\t' as u16;
const RETURN: u16 = b'\r' as u16;
const BACKSPACE: u16 = 0x08;
const FORM_FEED: u16 = 0x0c;
const DOUBLE_QUOTE: u16 = b'"' as u16;
const PLUS: u16 = b'+' as u16;
const MINUS: u16 = b'-' as u16;
const QUOTE: u16 = b'\'' as u16;
const COMMA: u16 = b',' as u16;
const DOT: u16 = b'.' as u16;
const COLON: u16 = b':' as u16;
const SEMICOLON: u16 = b';' as u16;
const LOWERCASE_E: u16 = b'e' as u16;
const UPPERCASE_E: u16 = b'E' as u16;

fn is_hex(code: Option<u16>) -> bool {
    code.is_some_and(|c| c < 0x80 && (c as u8).is_ascii_hexdigit())
}

fn is_digit(code: Option<u16>) -> bool {
    code.is_some_and(|c| c < 0x80 && (c as u8).is_ascii_digit())
}

fn is_valid_string_character(code: u16) -> bool {
    code >= 0x20
}

/// /^[,:[\]/{}()\n+]$/
fn is_delimiter(code: Option<u16>) -> bool {
    code.is_some_and(|c| c < 0x80 && b",:[]/{}()\n+".contains(&(c as u8)))
}

fn is_delimiter_except_slash(code: Option<u16>) -> bool {
    is_delimiter(code) && code != Some(SLASH)
}

/// /^[[{\w-]$/, or a quote.
fn is_start_of_value(code: Option<u16>) -> bool {
    code.is_some_and(|c| (c < 0x80 && (c == OPENING_BRACKET || c == OPENING_BRACE || c == MINUS || is_word(c))) || is_quote(Some(c)))
}

/// /\w/: an ASCII letter, digit or underscore.
fn is_word(c: u16) -> bool {
    c < 0x80 && ((c as u8).is_ascii_alphanumeric() || c == b'_' as u16)
}

fn is_control_character(code: u16) -> bool {
    matches!(code, NEWLINE | RETURN | TAB | BACKSPACE | FORM_FEED)
}

fn is_whitespace(code: Option<u16>) -> bool {
    matches!(code, Some(SPACE | NEWLINE | TAB | RETURN))
}

fn is_special_whitespace(code: Option<u16>) -> bool {
    matches!(code, Some(0xa0 | 0x2000..=0x200a | 0x202f | 0x205f | 0x3000))
}

fn is_quote(code: Option<u16>) -> bool {
    is_double_quote_like(code) || is_single_quote_like(code)
}

fn is_double_quote_like(code: Option<u16>) -> bool {
    matches!(code, Some(DOUBLE_QUOTE | 0x201c | 0x201d))
}

fn is_double_quote(code: Option<u16>) -> bool {
    code == Some(DOUBLE_QUOTE)
}

fn is_single_quote_like(code: Option<u16>) -> bool {
    matches!(code, Some(QUOTE | 0x2018 | 0x2019 | 0x60 | 0xb4))
}

fn is_single_quote(code: Option<u16>) -> bool {
    code == Some(QUOTE)
}

/// The whitespace JavaScript's `trim` removes.
fn is_js_trim_whitespace(c: u16) -> bool {
    matches!(c, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

/// `isFunctionName(text.trim())`: /^\w+$/.
fn is_function_name(text: &[u16]) -> bool {
    let start = text.iter().position(|c| !is_js_trim_whitespace(*c)).unwrap_or(text.len());
    let end = text.iter().rposition(|c| !is_js_trim_whitespace(*c)).map_or(start, |e| e + 1);
    end > start && text[start..end].iter().all(|c| is_word(*c))
}

/// `stripLastOccurrence`: the last `strip` removed, and with
/// `strip_remaining` everything after it too.
fn strip_last_occurrence(text: &mut Vec<u16>, strip: u16, strip_remaining: bool) {
    if let Some(index) = text.iter().rposition(|c| *c == strip) {
        if strip_remaining {
            text.truncate(index);
        } else {
            text.remove(index);
        }
    }
}

/// `insertBeforeLastWhitespace`.
fn insert_before_last_whitespace(text: &mut Vec<u16>, insert: &[u16]) {
    let mut index = text.len();
    while index > 0 && is_whitespace(Some(text[index - 1])) {
        index -= 1;
    }
    text.splice(index..index, insert.iter().copied());
}

/// /[,\n][ \t\r]*$/
fn ends_with_comma_or_newline(text: &[u16]) -> bool {
    let trailing = text.iter().rev().take_while(|c| matches!(**c, SPACE | TAB | RETURN)).count();
    matches!(text.len().checked_sub(trailing + 1).map(|at| text[at]), Some(COMMA | NEWLINE))
}

/// `JSON.stringify` of a string.
fn stringified(text: &[u16]) -> Vec<u16> {
    let escape = |unit: u16| utf16(&format!("\\u{unit:04x}"));
    let mut out = vec![DOUBLE_QUOTE];
    let mut at = 0;
    while at < text.len() {
        let unit = text[at];
        match unit {
            DOUBLE_QUOTE => out.extend(utf16("\\\"")),
            BACKSLASH => out.extend(utf16("\\\\")),
            BACKSPACE => out.extend(utf16("\\b")),
            FORM_FEED => out.extend(utf16("\\f")),
            NEWLINE => out.extend(utf16("\\n")),
            RETURN => out.extend(utf16("\\r")),
            TAB => out.extend(utf16("\\t")),
            0..0x20 => out.extend(escape(unit)),
            0xd800..=0xdbff if text.get(at + 1).is_some_and(|next| (0xdc00..=0xdfff).contains(next)) => {
                out.extend([unit, text[at + 1]]);
                at += 1;
            }
            // A lone surrogate is escaped, as a well-formed JSON.stringify does.
            0xd800..=0xdfff => out.extend(escape(unit)),
            _ => out.push(unit),
        }
        at += 1;
    }
    out.push(DOUBLE_QUOTE);
    out
}

fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

struct Repair {
    text: Vec<u16>,
    i: usize,
    output: Vec<u16>,
}

/// Which closing quote ends a string, by its opening quote.
#[derive(Clone, Copy)]
enum EndQuote {
    Double,
    Single,
    SingleLike,
    DoubleLike,
}

impl EndQuote {
    fn ends(self, code: Option<u16>) -> bool {
        match self {
            EndQuote::Double => is_double_quote(code),
            EndQuote::Single => is_single_quote(code),
            EndQuote::SingleLike => is_single_quote_like(code),
            EndQuote::DoubleLike => is_double_quote_like(code),
        }
    }
}

impl Repair {
    /// `text.charCodeAt(at)`; None past either end.
    fn at(&self, at: usize) -> Option<u16> {
        self.text.get(at).copied()
    }

    fn code(&self) -> Option<u16> {
        self.at(self.i)
    }

    fn error(&self, message: String, position: usize) -> RepairError {
        RepairError { message, position }
    }

    fn unit_text(&self, at: usize) -> String {
        self.text.get(at).map(|c| String::from_utf16_lossy(&[*c])).unwrap_or_default()
    }

    fn document(&mut self) -> Result<(), RepairError> {
        if !self.parse_value()? {
            return Err(self.error("Unexpected end of json string".into(), self.text.len()));
        }
        let processed_comma = self.parse_character(COMMA);
        if processed_comma {
            self.parse_whitespace_and_skip_comments();
        }
        if is_start_of_value(self.code()) && ends_with_comma_or_newline(&self.output) {
            // A value after the root one: newline delimited JSON, made a root array.
            if !processed_comma {
                insert_before_last_whitespace(&mut self.output, &[COMMA]);
            }
            self.parse_newline_delimited_json()?;
        } else if processed_comma {
            strip_last_occurrence(&mut self.output, COMMA, false);
        }
        // Redundant closing brackets.
        while matches!(self.code(), Some(CLOSING_BRACE | CLOSING_BRACKET)) {
            self.i += 1;
            self.parse_whitespace_and_skip_comments();
        }
        if self.i >= self.text.len() {
            return Ok(());
        }
        Err(self.error(format!("Unexpected character {}", serde_json::Value::from(self.unit_text(self.i))), self.i))
    }

    fn parse_value(&mut self) -> Result<bool, RepairError> {
        self.parse_whitespace_and_skip_comments();
        let processed = self.parse_object()?
            || self.parse_array()?
            || self.parse_string(false)?
            || self.parse_number()
            || self.parse_keywords()
            || self.parse_unquoted_string()?;
        self.parse_whitespace_and_skip_comments();
        Ok(processed)
    }

    fn parse_whitespace_and_skip_comments(&mut self) -> bool {
        let start = self.i;
        self.parse_whitespace();
        while self.parse_comment() && self.parse_whitespace() {}
        self.i > start
    }

    fn parse_whitespace(&mut self) -> bool {
        let before = self.output.len();
        loop {
            let code = self.code();
            if is_whitespace(code) {
                self.output.push(self.text[self.i]);
            } else if is_special_whitespace(code) {
                self.output.push(SPACE);
            } else {
                break;
            }
            self.i += 1;
        }
        self.output.len() > before
    }

    fn parse_comment(&mut self) -> bool {
        if self.code() == Some(SLASH) && self.at(self.i + 1) == Some(ASTERISK) {
            while self.i < self.text.len() && !(self.code() == Some(ASTERISK) && self.at(self.i + 1) == Some(SLASH)) {
                self.i += 1;
            }
            self.i += 2;
            return true;
        }
        if self.code() == Some(SLASH) && self.at(self.i + 1) == Some(SLASH) {
            while self.i < self.text.len() && self.code() != Some(NEWLINE) {
                self.i += 1;
            }
            return true;
        }
        false
    }

    fn parse_character(&mut self, code: u16) -> bool {
        if self.code() == Some(code) {
            self.output.push(code);
            self.i += 1;
            return true;
        }
        false
    }

    fn skip_character(&mut self, code: u16) -> bool {
        if self.code() == Some(code) {
            self.i += 1;
            return true;
        }
        false
    }

    /// An ellipsis like `[1,2,3,...]`, skipped with an optional comma.
    fn skip_ellipsis(&mut self) {
        self.parse_whitespace_and_skip_comments();
        if self.code() == Some(DOT) && self.at(self.i + 1) == Some(DOT) && self.at(self.i + 2) == Some(DOT) {
            self.i += 3;
            self.parse_whitespace_and_skip_comments();
            self.skip_character(COMMA);
        }
    }

    fn parse_object(&mut self) -> Result<bool, RepairError> {
        if self.code() != Some(OPENING_BRACE) {
            return Ok(false);
        }
        self.output.push(OPENING_BRACE);
        self.i += 1;
        self.parse_whitespace_and_skip_comments();
        // A leading comma, as in {, message: "hi"}.
        if self.skip_character(COMMA) {
            self.parse_whitespace_and_skip_comments();
        }
        let mut initial = true;
        while self.i < self.text.len() && self.code() != Some(CLOSING_BRACE) {
            if !initial {
                if !self.parse_character(COMMA) {
                    insert_before_last_whitespace(&mut self.output, &[COMMA]);
                }
                self.parse_whitespace_and_skip_comments();
            } else {
                initial = false;
            }
            self.skip_ellipsis();
            let processed_key = self.parse_string(false)? || self.parse_unquoted_string()?;
            if !processed_key {
                if matches!(self.code(), Some(CLOSING_BRACE | OPENING_BRACE | CLOSING_BRACKET | OPENING_BRACKET) | None) {
                    strip_last_occurrence(&mut self.output, COMMA, false);
                } else {
                    return Err(self.error("Object key expected".into(), self.i));
                }
                break;
            }
            self.parse_whitespace_and_skip_comments();
            let processed_colon = self.parse_character(COLON);
            let truncated_text = self.i >= self.text.len();
            if !processed_colon {
                if is_start_of_value(self.code()) || truncated_text {
                    insert_before_last_whitespace(&mut self.output, &[COLON]);
                } else {
                    return Err(self.error("Colon expected".into(), self.i));
                }
            }
            if !self.parse_value()? {
                if processed_colon || truncated_text {
                    self.output.extend(utf16("null"));
                } else {
                    return Err(self.error("Colon expected".into(), self.i));
                }
            }
        }
        if self.code() == Some(CLOSING_BRACE) {
            self.output.push(CLOSING_BRACE);
            self.i += 1;
        } else {
            insert_before_last_whitespace(&mut self.output, &[CLOSING_BRACE]);
        }
        Ok(true)
    }

    fn parse_array(&mut self) -> Result<bool, RepairError> {
        if self.code() != Some(OPENING_BRACKET) {
            return Ok(false);
        }
        self.output.push(OPENING_BRACKET);
        self.i += 1;
        self.parse_whitespace_and_skip_comments();
        if self.skip_character(COMMA) {
            self.parse_whitespace_and_skip_comments();
        }
        let mut initial = true;
        while self.i < self.text.len() && self.code() != Some(CLOSING_BRACKET) {
            if !initial {
                if !self.parse_character(COMMA) {
                    insert_before_last_whitespace(&mut self.output, &[COMMA]);
                }
            } else {
                initial = false;
            }
            self.skip_ellipsis();
            if !self.parse_value()? {
                strip_last_occurrence(&mut self.output, COMMA, false);
                break;
            }
        }
        if self.code() == Some(CLOSING_BRACKET) {
            self.output.push(CLOSING_BRACKET);
            self.i += 1;
        } else {
            insert_before_last_whitespace(&mut self.output, &[CLOSING_BRACKET]);
        }
        Ok(true)
    }

    fn parse_newline_delimited_json(&mut self) -> Result<(), RepairError> {
        let mut initial = true;
        let mut processed_value = true;
        while processed_value {
            if !initial {
                if !self.parse_character(COMMA) {
                    insert_before_last_whitespace(&mut self.output, &[COMMA]);
                }
            } else {
                initial = false;
            }
            processed_value = self.parse_value()?;
        }
        strip_last_occurrence(&mut self.output, COMMA, false);
        let mut wrapped = utf16("[\n");
        wrapped.append(&mut self.output);
        wrapped.extend(utf16("\n]"));
        self.output = wrapped;
        Ok(())
    }

    fn prev_non_whitespace_index(&self, start: usize) -> usize {
        let mut prev = start;
        while prev > 0 && is_whitespace(self.at(prev)) {
            prev -= 1;
        }
        prev
    }

    /// A string in double quotes, or repaired from single or special quotes,
    /// an escaped string, or a missing end quote. First the string is taken
    /// to have a real end quote; when that quote turns out not to be followed
    /// by a delimiter, it is parsed again stopping at the first delimiter.
    fn parse_string(&mut self, stop_at_delimiter: bool) -> Result<bool, RepairError> {
        let mut skip_escape_chars = self.code() == Some(BACKSLASH);
        if skip_escape_chars {
            self.i += 1;
            skip_escape_chars = true;
        }
        if !is_quote(self.code()) {
            return Ok(false);
        }
        let end_quote = if is_double_quote(self.code()) {
            EndQuote::Double
        } else if is_single_quote(self.code()) {
            EndQuote::Single
        } else if is_single_quote_like(self.code()) {
            EndQuote::SingleLike
        } else {
            EndQuote::DoubleLike
        };
        let i_before = self.i;
        let o_before = self.output.len();
        let mut str = vec![DOUBLE_QUOTE];
        self.i += 1;
        loop {
            if self.i >= self.text.len() {
                // Missing its end quote.
                let i_prev = self.prev_non_whitespace_index(self.i - 1);
                if !stop_at_delimiter && is_delimiter(self.at(i_prev)) {
                    // Ends with a delimiter, like ["hello]: the quote goes before it.
                    self.i = i_before;
                    self.output.truncate(o_before);
                    return self.parse_string(true);
                }
                insert_before_last_whitespace(&mut str, &[DOUBLE_QUOTE]);
                self.output.extend(str);
                return Ok(true);
            } else if end_quote.ends(self.code()) {
                // Is it really the end? Look before and after it.
                let i_quote = self.i;
                let o_quote = str.len();
                str.push(DOUBLE_QUOTE);
                self.i += 1;
                self.output.extend_from_slice(&str);
                self.parse_whitespace_and_skip_comments();
                if stop_at_delimiter
                    || self.i >= self.text.len()
                    || is_delimiter(self.code())
                    || is_quote(self.code())
                    || is_digit(self.code())
                {
                    self.parse_concatenated_string()?;
                    return Ok(true);
                }
                if is_delimiter(self.at(self.prev_non_whitespace_index(i_quote.wrapping_sub(1)))) {
                    // Preceded by a delimiter and not followed by one: the
                    // end quote is missing; parse again stopping at a delimiter.
                    self.i = i_before;
                    self.output.truncate(o_before);
                    return self.parse_string(true);
                }
                // An unescaped quote inside the string: escape it and go on.
                self.output.truncate(o_before);
                self.i = i_quote + 1;
                str.insert(o_quote, BACKSLASH);
            } else if stop_at_delimiter && is_delimiter(self.code()) {
                insert_before_last_whitespace(&mut str, &[DOUBLE_QUOTE]);
                self.output.extend(str);
                self.parse_concatenated_string()?;
                return Ok(true);
            } else if self.code() == Some(BACKSLASH) {
                let next = self.at(self.i + 1);
                let escapes = |c: u16| c < 0x80 && b"\"\\/bfnrt".contains(&(c as u8));
                if next.is_some_and(escapes) {
                    str.extend_from_slice(&self.text[self.i..self.i + 2]);
                    self.i += 2;
                } else if next == Some(b'u' as u16) {
                    let mut j = 2;
                    while j < 6 && is_hex(self.at(self.i + j)) {
                        j += 1;
                    }
                    if j == 6 {
                        str.extend_from_slice(&self.text[self.i..self.i + 6]);
                        self.i += 6;
                    } else if self.i + j >= self.text.len() {
                        // A unicode escape cut off at the end: dropped, the string ended.
                        self.i = self.text.len();
                    } else {
                        let end = (self.i + 6).min(self.text.len());
                        let chars = String::from_utf16_lossy(&self.text[self.i..end]);
                        return Err(self.error(format!("Invalid unicode character \"{chars}\""), self.i));
                    }
                } else {
                    // An invalid escape: the backslash dropped.
                    str.extend(next);
                    self.i += 2;
                }
            } else {
                let code = self.text[self.i];
                if code == DOUBLE_QUOTE && self.i.checked_sub(1).and_then(|at| self.at(at)) != Some(BACKSLASH) {
                    str.extend([BACKSLASH, code]);
                    self.i += 1;
                } else if is_control_character(code) {
                    str.extend(utf16(match code {
                        BACKSPACE => "\\b",
                        FORM_FEED => "\\f",
                        NEWLINE => "\\n",
                        RETURN => "\\r",
                        _ => "\\t",
                    }));
                    self.i += 1;
                } else {
                    if !is_valid_string_character(code) {
                        return Err(self.error(format!("Invalid character {}", serde_json::Value::from(self.unit_text(self.i))), self.i));
                    }
                    str.push(code);
                    self.i += 1;
                }
            }
            if skip_escape_chars {
                self.skip_character(BACKSLASH);
            }
        }
    }

    /// Concatenated strings like "hello" + "world", made "helloworld".
    fn parse_concatenated_string(&mut self) -> Result<bool, RepairError> {
        let mut processed = false;
        self.parse_whitespace_and_skip_comments();
        while self.code() == Some(PLUS) {
            processed = true;
            self.i += 1;
            self.parse_whitespace_and_skip_comments();
            strip_last_occurrence(&mut self.output, DOUBLE_QUOTE, true);
            let start = self.output.len();
            if self.parse_string(false)? {
                self.output.remove(start);
            } else {
                insert_before_last_whitespace(&mut self.output, &[DOUBLE_QUOTE]);
            }
        }
        Ok(processed)
    }

    fn at_end_of_number(&self) -> bool {
        self.i >= self.text.len() || is_delimiter(self.code()) || is_whitespace(self.code())
    }

    /// A number cut off after `.`, `-` or `e`, completed with a 0.
    fn repair_number_ending_with_numeric_symbol(&mut self, start: usize) {
        self.output.extend_from_slice(&self.text[start..self.i]);
        self.output.push(b'0' as u16);
    }

    fn parse_number(&mut self) -> bool {
        let start = self.i;
        if self.code() == Some(MINUS) {
            self.i += 1;
            if self.at_end_of_number() {
                self.repair_number_ending_with_numeric_symbol(start);
                return true;
            }
            if !is_digit(self.code()) {
                self.i = start;
                return false;
            }
        }
        // Leading zeros are kept here; a number with one is quoted below.
        while is_digit(self.code()) {
            self.i += 1;
        }
        if self.code() == Some(DOT) {
            self.i += 1;
            if self.at_end_of_number() {
                self.repair_number_ending_with_numeric_symbol(start);
                return true;
            }
            if !is_digit(self.code()) {
                self.i = start;
                return false;
            }
            while is_digit(self.code()) {
                self.i += 1;
            }
        }
        if matches!(self.code(), Some(LOWERCASE_E | UPPERCASE_E)) {
            self.i += 1;
            if matches!(self.code(), Some(MINUS | PLUS)) {
                self.i += 1;
            }
            if self.at_end_of_number() {
                self.repair_number_ending_with_numeric_symbol(start);
                return true;
            }
            if !is_digit(self.code()) {
                self.i = start;
                return false;
            }
            while is_digit(self.code()) {
                self.i += 1;
            }
        }
        if !self.at_end_of_number() {
            self.i = start;
            return false;
        }
        if self.i > start {
            let num = &self.text[start..self.i];
            // /^0\d/: leading zeros, which JSON refuses, kept as text.
            let invalid_leading_zero = num.len() > 1 && num[0] == b'0' as u16 && is_digit(Some(num[1]));
            if invalid_leading_zero {
                self.output.push(DOUBLE_QUOTE);
                self.output.extend_from_slice(num);
                self.output.push(DOUBLE_QUOTE);
            } else {
                self.output.extend_from_slice(num);
            }
            return true;
        }
        false
    }

    /// true, false and null, and Python's True, False and None.
    fn parse_keywords(&mut self) -> bool {
        [("true", "true"), ("false", "false"), ("null", "null"), ("True", "true"), ("False", "false"), ("None", "null")]
            .iter()
            .any(|(name, value)| self.parse_keyword(name, value))
    }

    fn parse_keyword(&mut self, name: &str, value: &str) -> bool {
        let name = utf16(name);
        if self.text.get(self.i..self.i + name.len()) == Some(&name[..]) {
            self.output.extend(utf16(value));
            self.i += name.len();
            return true;
        }
        false
    }

    /// An unquoted string, quoted; a MongoDB call like NumberLong("2") or a
    /// JSONP call like callback({...}); unwrapped.
    fn parse_unquoted_string(&mut self) -> Result<bool, RepairError> {
        // Stops at the next delimiter; a slash is allowed, for regular expressions.
        let start = self.i;
        while self.i < self.text.len() && !is_delimiter_except_slash(self.code()) && !is_quote(self.code()) {
            self.i += 1;
        }
        if self.i == start {
            return Ok(false);
        }
        if self.code() == Some(OPEN_PARENTHESIS) && is_function_name(&self.text[start..self.i]) {
            self.i += 1;
            self.parse_value()?;
            if self.code() == Some(CLOSE_PARENTHESIS) {
                self.i += 1;
                if self.code() == Some(SEMICOLON) {
                    self.i += 1;
                }
            }
            return Ok(true);
        }
        // Without its trailing whitespace; `undefined` is null.
        while self.i > 0 && is_whitespace(self.at(self.i - 1)) {
            self.i -= 1;
        }
        let symbol = &self.text[start..self.i];
        if symbol == utf16("undefined") {
            self.output.extend(utf16("null"));
        } else {
            let quoted = stringified(symbol);
            self.output.extend(quoted);
        }
        if self.code() == Some(DOUBLE_QUOTE) {
            // A missing start quote, and here its end quote.
            self.i += 1;
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_truncated_document_is_closed() {
        assert_eq!(repair(r#"{"a":[{"b":1},{"c":"#).unwrap(), r#"{"a":[{"b":1},{"c":null}]}"#);
        assert_eq!(repair(r#"{"text": "He said, \"hi\" and left", "n": 3"#).unwrap(), r#"{"text": "He said, \"hi\" and left", "n": 3}"#);
    }

    #[test]
    fn what_cannot_be_repaired_says_where() {
        assert_eq!(repair("").unwrap_err(), RepairError { message: "Unexpected end of json string".into(), position: 0 });
        assert_eq!(repair(r#"{"a":1,,"b":2}"#).unwrap_err().message, "Object key expected");
    }

    #[test]
    fn a_symbol_is_quoted_as_json_stringify_quotes_it() {
        assert_eq!(String::from_utf16_lossy(&stringified(&utf16("a\"b\\c\u{1}"))), r#""a\"b\\c\u0001""#);
        assert_eq!(String::from_utf16_lossy(&stringified(&utf16("😀"))), "\"😀\"");
        assert_eq!(String::from_utf16_lossy(&stringified(&[0xd83d])), r#""\ud83d""#);
    }
}
