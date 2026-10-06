//! The expression grammar's tokens, read on demand: the parser asks for the
//! token at its cursor, given what came before (the one lexical rule that
//! looks back). Hops, types and closures are read by character in the
//! parser, so the lexer also carries the character scans they share.
//!
//! A port of the lexing half of packages/movement-lang/parser/expression/
//! parse_expression.ts. Offsets are UTF-16 indexes (see util::utf16).

use serde::Serialize;

use crate::util::utf16::{Utf16, is_ascii_digit, is_ident_char, is_ident_start, is_js_space, opt_is, to_string};

/// An expression the grammar refuses: the message, and the UTF-16 offset
/// into the text the parser was given (`ExpressionSyntaxError.offset`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SyntaxError {
    pub message: String,
    pub pos: usize,
}

pub type PResult<T> = Result<T, SyntaxError>;

pub fn fail<T>(message: impl Into<String>, pos: usize) -> PResult<T> {
    Err(SyntaxError { message: message.into(), pos })
}

/// How deep the grammar may nest before it refuses the text. The parser is
/// recursive descent, and a WASM build has two stacks to overflow: the
/// engine's own (V8 throws a RangeError, about 450 levels of parentheses on
/// Node's default stack) and the shadow stack in linear memory (4–6 KiB a
/// level; overflowing it under `--stack-first` is an out-of-bounds trap,
/// which hangs Node 22 on macOS instead of throwing). The bound keeps both
/// several times clear; real expressions nest a few levels.
/// scripts/build-parser-wasm.sh sizes the shadow stack.
pub const MAX_DEPTH: usize = 128;

pub const TOO_DEEP: &str = "nesting too deep";

/// The formula grammar's reserved words, matched case-insensitively
/// (shared/expression/formula.ts `KEYWORDS`).
pub const KEYWORDS: [&str; 13] =
    ["AND", "OR", "NOT", "IF", "THEN", "ELSE", "END", "TRUE", "FALSE", "NULL", "CONTAINS", "EXISTS", "IN"];

/// What the previous token was: a `-` directly before a digit is a negative
/// number literal after an operator, an opening paren, a comma, or at the
/// start — the formula tokenizer's rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Previous {
    Start,
    Operand,
    Opener,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Interpolation {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Text(String),
    Interpolation(Interpolation),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuoteChar {
    Double,
    Single,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    Number(String),
    String { quote: QuoteChar, segments: Vec<Segment> },
    Name { text: String, quoted: bool },
    Keyword(&'static str),
    Special(String),
    Op(&'static str),
    Punct(&'static str),
    /// `-[` or `<-[` opening a hop — the parser reads the hop itself.
    Hop,
    Eof,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub start: usize,
    pub end: usize,
    pub newline_before: bool,
    pub space_before: bool,
    pub t: Tok,
}

impl Token {
    pub fn is_punct(&self, text: &str) -> bool {
        matches!(self.t, Tok::Punct(p) if p == text)
    }

    pub fn is_op(&self, text: &str) -> bool {
        matches!(self.t, Tok::Op(p) if p == text)
    }

    pub fn is_keyword(&self, text: &str) -> bool {
        matches!(self.t, Tok::Keyword(k) if k == text)
    }

    /// A contextual word (`WHERE`, `IS`, `ASC`): an unquoted name, matched
    /// case-insensitively. Not reserved — a field may still be called it.
    pub fn is_word(&self, word: &str) -> bool {
        matches!(&self.t, Tok::Name { text, quoted: false } if text.eq_ignore_ascii_case(word))
    }

    pub fn is_bare_name(&self, word: &str) -> bool {
        matches!(&self.t, Tok::Name { text, quoted: false } if text == word)
    }

    /// The string's text when it has no interpolation.
    pub fn plain_string(&self) -> Option<String> {
        match &self.t {
            Tok::String { segments, .. } => segments
                .iter()
                .map(|s| match s {
                    Segment::Text(t) => Some(t.as_str()),
                    Segment::Interpolation(_) => None,
                })
                .collect::<Option<Vec<_>>>()
                .map(|parts| parts.concat()),
            _ => None,
        }
    }
}

/// The one escape rule for string literals (shared/expression/formula.ts
/// `translateStringEscape`): `\n`, `\t`, `\r` are control characters; any
/// other escaped character is itself.
pub fn translate_string_escape(next: u16) -> u16 {
    match char::from_u32(next as u32) {
        Some('n') => '\n' as u16,
        Some('t') => '\t' as u16,
        Some('r') => '\r' as u16,
        _ => next,
    }
}

/// The refusal of a character no expression grammar reads, with the
/// spelling the author most likely meant (formula.ts
/// `unrecognisedCharacterMessage`).
pub fn unrecognised_character_message(ch: &str) -> String {
    let hint = match ch {
        "&" => Some("write AND (not & or &&)"),
        "|" => Some("write OR (not | or ||)"),
        "?" => Some("write IF … THEN … ELSE … END (there is no ? : conditional)"),
        ";" => Some("an expression takes no ; separator"),
        "\\" => Some("a backslash escapes only inside a quoted string"),
        "\u{2013}" => Some("write the ASCII minus '-' (this is an en dash)"),
        "\u{2014}" => Some("write the ASCII minus '-' (this is an em dash)"),
        "\u{2212}" => Some("write the ASCII minus '-' (this is a typographic minus sign)"),
        "\u{201C}" | "\u{201D}" => Some("write a straight double quote \" (this is a curly quote)"),
        "\u{2018}" | "\u{2019}" => Some("write a straight single quote ' (this is a curly quote)"),
        _ => None,
    };
    match hint {
        Some(hint) => format!("Unrecognised character '{ch}' — {hint}"),
        None => format!("Unrecognised character '{ch}'"),
    }
}

fn unit(c: char) -> u16 {
    c as u16
}

/// The text one parser reads: the whole source, and the end of its window
/// (an interpolation's parser stops at its `}`). Most reads stop at `limit`;
/// the few the TypeScript grammar makes on the unbounded string say so.
pub struct Scanner<'a> {
    pub src: &'a Utf16,
    pub limit: usize,
}

impl<'a> Scanner<'a> {
    /// The unit at `i` inside the window.
    pub fn at(&self, i: usize) -> Option<u16> {
        if i < self.limit { self.src.at(i) } else { None }
    }

    pub fn is(&self, i: usize, c: char) -> bool {
        opt_is(self.at(i), c)
    }

    /// Past the whitespace at `pos`; whether it crossed a newline.
    pub fn skip_ws(&self, mut pos: usize) -> (usize, bool) {
        let mut newline = false;
        while let Some(u) = self.at(pos) {
            if !is_js_space(u) {
                break;
            }
            if u == unit('\n') {
                newline = true;
            }
            pos += 1;
        }
        (pos, newline)
    }

    pub fn lex(&self, pos: usize, previous: Previous) -> PResult<Token> {
        let (start, newline_before) = self.skip_ws(pos);
        let space_before = start > pos;
        let token = |end: usize, t: Tok| Token { start, end, newline_before, space_before, t };
        let Some(c) = self.at(start) else {
            return Ok(token(start, Tok::Eof));
        };
        let is = |i: usize, ch: char| self.is(i, ch);

        if c == unit('"') || c == unit('\'') {
            let (end, quote, segments) = self.lex_string(start)?;
            return Ok(token(end, Tok::String { quote, segments }));
        }
        if c == unit('`') {
            let (name, end) = self.scan_backtick(start)?;
            return Ok(token(end, Tok::Name { text: name, quoted: true }));
        }
        let digit_next = self.at(start + 1).is_some_and(is_ascii_digit);
        if is_ascii_digit(c) || (c == unit('-') && digit_next && previous != Previous::Operand) {
            let mut i = start + 1;
            while self.at(i).is_some_and(|u| is_ascii_digit(u) || u == unit('.')) {
                i += 1;
            }
            return Ok(token(i, Tok::Number(self.src.text(start, i))));
        }
        if c == unit('@') {
            let mut i = start + 1;
            while self.at(i).is_some_and(|u| is_ident_char(u) || u == unit('.')) {
                i += 1;
            }
            return Ok(token(i, Tok::Special(self.src.text(start, i))));
        }
        if (c == unit('-') && is(start + 1, '[') && self.is_hop_interior(start + 2))
            || (c == unit('<') && is(start + 1, '-') && is(start + 2, '[') && self.is_hop_interior(start + 3))
        {
            return Ok(token(start, Tok::Hop));
        }
        if is_ident_start(c) {
            let mut i = start + 1;
            while self.at(i).is_some_and(is_ident_char) {
                i += 1;
            }
            let text = self.src.text(start, i);
            let upper = text.to_ascii_uppercase();
            if let Some(keyword) = KEYWORDS.iter().find(|k| **k == upper) {
                return Ok(token(i, Tok::Keyword(keyword)));
            }
            return Ok(token(i, Tok::Name { text, quoted: false }));
        }
        for two in ["!=", ">=", "<=", "==", "=>"] {
            if self.window_starts_with(start, two) {
                return Ok(token(start + 2, Tok::Op(two)));
            }
        }
        // A lone `!` is TypeScript's spelling of NOT, exactly as in the formula grammar.
        if c == unit('!') {
            return Ok(token(start + 1, Tok::Keyword("NOT")));
        }
        for op in ["=", "<", ">", "+", "-", "*", "/", "%"] {
            if c == op.as_bytes()[0] as u16 {
                return Ok(token(start + 1, Tok::Op(op)));
            }
        }
        if self.window_starts_with(start, "...") {
            return Ok(token(start + 3, Tok::Punct("...")));
        }
        if c == unit('.') {
            return Ok(token(start + 1, Tok::Op(".")));
        }
        for p in ["(", ")", "[", "]", "{", "}", ",", ":", "|", "?", ";"] {
            if c == p.as_bytes()[0] as u16 {
                return Ok(token(start + 1, Tok::Punct(p)));
            }
        }
        fail(unrecognised_character_message(&self.src.char_text(start)), start)
    }

    fn window_starts_with(&self, at: usize, text: &str) -> bool {
        at + text.len() <= self.limit && self.src.starts_with(at, text)
    }

    /// `start` is just inside `-[` / `<-[`: a hop opens with `:`, `#`, or an
    /// alias (`name:`). Anything else is a minus and a list.
    pub fn is_hop_interior(&self, start: usize) -> bool {
        let mut i = start;
        while self.at(i).is_some_and(is_js_space) {
            i += 1;
        }
        // Unbounded, as the TypeScript reads `this.src[i]`.
        let c = self.src.at(i);
        if opt_is(c, ':') || opt_is(c, '#') {
            return true;
        }
        let mut end = match c {
            Some(u) if u == unit('`') => {
                let mut j = i + 1;
                while j < self.limit && !self.is(j, '`') {
                    j += if self.is(j, '\\') { 2 } else { 1 };
                }
                if j >= self.limit {
                    return false;
                }
                j + 1
            }
            Some(u) if is_ident_start(u) => {
                let mut j = i + 1;
                while self.at(j).is_some_and(is_ident_char) {
                    j += 1;
                }
                j
            }
            _ => return false,
        };
        while self.at(end).is_some_and(is_js_space) {
            end += 1;
        }
        opt_is(self.src.at(end), ':')
    }

    pub fn scan_backtick(&self, start: usize) -> PResult<(String, usize)> {
        let mut i = start + 1;
        let mut name: Vec<u16> = Vec::new();
        while let Some(u) = self.at(i) {
            if u == unit('`') {
                return Ok((to_string(&name), i + 1));
            }
            if u == unit('\\') && i + 1 < self.limit {
                name.extend(self.at(i + 1));
                i += 2;
                continue;
            }
            name.push(u);
            i += 1;
        }
        fail("Unterminated backtick-quoted name", start)
    }

    fn lex_string(&self, start: usize) -> PResult<(usize, QuoteChar, Vec<Segment>)> {
        let double = self.is(start, '"');
        let quote = if double { QuoteChar::Double } else { QuoteChar::Single };
        let quote_unit = if double { unit('"') } else { unit('\'') };
        let mut segments = Vec::new();
        let mut text: Vec<u16> = Vec::new();
        let mut i = start + 1;
        while let Some(c) = self.at(i) {
            if c == unit('\\') && i + 1 < self.limit {
                text.extend(self.at(i + 1).map(translate_string_escape));
                i += 2;
                continue;
            }
            if double && c == unit('$') && opt_is(self.src.at(i + 1), '{') {
                if !text.is_empty() {
                    segments.push(Segment::Text(to_string(&text)));
                }
                text.clear();
                let close = self.find_interpolation_close(i + 2, 0)?;
                segments.push(Segment::Interpolation(Interpolation { start: i + 2, end: close }));
                i = close + 1;
                continue;
            }
            if c == quote_unit {
                if !text.is_empty() || segments.is_empty() {
                    segments.push(Segment::Text(to_string(&text)));
                }
                return Ok((i + 1, quote, segments));
            }
            text.push(c);
            i += 1;
        }
        fail("Unterminated string literal", start)
    }

    /// `start` is just after `${`; the index of the matching `}`. `depth`
    /// counts the strings nested inside interpolations so far.
    pub fn find_interpolation_close(&self, start: usize, depth: usize) -> PResult<usize> {
        if depth > MAX_DEPTH {
            return fail(TOO_DEEP, start);
        }
        let mut braces = 1usize;
        let mut i = start;
        while let Some(c) = self.at(i) {
            if c == unit('"') || c == unit('\'') {
                i = self.skip_quoted(i, depth + 1)?;
                continue;
            }
            if c == unit('`') {
                i = self.scan_backtick(i)?.1;
                continue;
            }
            if c == unit('{') {
                braces += 1;
            } else if c == unit('}') {
                braces -= 1;
                if braces == 0 {
                    return Ok(i);
                }
            }
            i += 1;
        }
        fail("Unterminated ${…} interpolation", start - 2)
    }

    /// The index just past a quoted string starting at `start`
    /// (interpolations skipped whole).
    pub fn skip_quoted(&self, start: usize, depth: usize) -> PResult<usize> {
        let quote = self.at(start);
        let double = opt_is(quote, '"');
        let mut i = start + 1;
        while let Some(c) = self.at(i) {
            if c == unit('\\') {
                i += 2;
                continue;
            }
            if double && c == unit('$') && opt_is(self.src.at(i + 1), '{') {
                i = self.find_interpolation_close(i + 2, depth)? + 1;
                continue;
            }
            if Some(c) == quote {
                return Ok(i + 1);
            }
            i += 1;
        }
        fail("Unterminated string literal", start)
    }

    /// The index of the bracket closing the one at `open`, skipping literals.
    pub fn matching_close(&self, open: usize) -> Option<usize> {
        let mut stack: Vec<u16> = Vec::new();
        let mut i = open;
        while let Some(c) = self.at(i) {
            if c == unit('"') || c == unit('\'') {
                i = self.skip_quoted(i, 0).ok()?;
                continue;
            }
            if c == unit('`') {
                let close = self.src.index_of(unit('`'), i + 1)?;
                if close >= self.limit {
                    return None;
                }
                i = close + 1;
                continue;
            }
            let pair = if c == unit('(') {
                Some(')')
            } else if c == unit('[') {
                Some(']')
            } else if c == unit('{') {
                Some('}')
            } else {
                None
            };
            if let Some(close) = pair {
                stack.push(unit(close));
            } else if c == unit(')') || c == unit(']') || c == unit('}') {
                if stack.pop() != Some(c) {
                    return None;
                }
                if stack.is_empty() {
                    return Some(i);
                }
            }
            i += 1;
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lex_all(text: &str) -> PResult<Vec<Token>> {
        let src = Utf16::new(text);
        let scanner = Scanner { src: &src, limit: src.len() };
        let mut pos = 0;
        let mut previous = Previous::Start;
        let mut out = Vec::new();
        loop {
            let tok = scanner.lex(pos, previous)?;
            if tok.t == Tok::Eof || tok.t == Tok::Hop {
                out.push(tok);
                return Ok(out);
            }
            pos = tok.end;
            previous = match tok.t {
                Tok::Op(_) | Tok::Punct("(") | Tok::Punct(",") => Previous::Opener,
                _ => Previous::Operand,
            };
            out.push(tok);
        }
    }

    fn kinds(text: &str) -> Vec<Tok> {
        lex_all(text).unwrap().into_iter().map(|t| t.t).collect()
    }

    #[test]
    fn a_leading_minus_is_a_number_only_where_an_operand_can_start() {
        assert_eq!(kinds("-5"), vec![Tok::Number("-5".into()), Tok::Eof]);
        assert_eq!(
            kinds("a-5"),
            vec![Tok::Name { text: "a".into(), quoted: false }, Tok::Op("-"), Tok::Number("5".into()), Tok::Eof]
        );
        assert_eq!(kinds("(-5"), vec![Tok::Punct("("), Tok::Number("-5".into()), Tok::Eof]);
    }

    #[test]
    fn numbers_take_every_digit_and_dot() {
        assert_eq!(kinds("1.2.3"), vec![Tok::Number("1.2.3".into()), Tok::Eof]);
    }

    #[test]
    fn keywords_are_case_insensitive_and_words_are_not_reserved() {
        assert_eq!(kinds("and"), vec![Tok::Keyword("AND"), Tok::Eof]);
        assert_eq!(kinds("where"), vec![Tok::Name { text: "where".into(), quoted: false }, Tok::Eof]);
        assert_eq!(kinds("!"), vec![Tok::Keyword("NOT"), Tok::Eof]);
    }

    #[test]
    fn a_hop_is_told_from_a_minus_and_a_list_by_lookahead() {
        assert_eq!(kinds("a-[:E]->"), vec![Tok::Name { text: "a".into(), quoted: false }, Tok::Hop]);
        assert_eq!(kinds("<-[x: E]-"), vec![Tok::Hop]);
        assert_eq!(kinds("-[#extract]->"), vec![Tok::Hop]);
        assert_eq!(kinds("a-[`b c` :E]->"), vec![Tok::Name { text: "a".into(), quoted: false }, Tok::Hop]);
        assert_eq!(
            kinds("a-[1]"),
            vec![
                Tok::Name { text: "a".into(), quoted: false },
                Tok::Op("-"),
                Tok::Punct("["),
                Tok::Number("1".into()),
                Tok::Punct("]"),
                Tok::Eof
            ]
        );
        assert_eq!(kinds("a-[b]")[1], Tok::Op("-"));
    }

    #[test]
    fn specials_spreads_and_two_character_operators() {
        assert_eq!(kinds("@parent.created"), vec![Tok::Special("@parent.created".into()), Tok::Eof]);
        assert_eq!(kinds("...m")[0], Tok::Punct("..."));
        assert_eq!(kinds("a.b")[1], Tok::Op("."));
        assert_eq!(kinds("=>")[0], Tok::Op("=>"));
        assert_eq!(kinds("<=")[0], Tok::Op("<="));
    }

    #[test]
    fn strings_split_at_interpolations_and_apply_escapes() {
        let toks = lex_all(r#""a\n${ "}" + b }c""#).unwrap();
        let Tok::String { quote, segments } = &toks[0].t else { panic!("{:?}", toks[0]) };
        assert_eq!(*quote, QuoteChar::Double);
        assert_eq!(
            segments,
            &vec![
                Segment::Text("a\n".into()),
                Segment::Interpolation(Interpolation { start: 6, end: 15 }),
                Segment::Text("c".into())
            ]
        );
        // Single quotes never interpolate.
        let toks = lex_all("'${a}'").unwrap();
        assert_eq!(toks[0].plain_string().as_deref(), Some("${a}"));
        assert_eq!(lex_all(r#""""#).unwrap()[0].plain_string().as_deref(), Some(""));
    }

    #[test]
    fn backtick_names_take_escapes() {
        assert_eq!(kinds(r"`a\`b`"), vec![Tok::Name { text: "a`b".into(), quoted: true }, Tok::Eof]);
    }

    #[test]
    fn unterminated_literals_point_at_their_start() {
        assert_eq!(lex_all("x 'abc").map(|_| ()), Ok(()).and(fail("Unterminated string literal", 2)));
        assert_eq!(lex_all("`abc").unwrap_err().message, "Unterminated backtick-quoted name");
        assert_eq!(
            lex_all(r#""a${b"#).unwrap_err(),
            SyntaxError { message: "Unterminated ${…} interpolation".into(), pos: 2 }
        );
    }

    #[test]
    fn a_hash_is_not_a_comment_in_an_expression() {
        // `#` comments are the statement scanner's; an expression slot never holds one.
        assert_eq!(
            lex_all("a # b").unwrap_err(),
            SyntaxError { message: "Unrecognised character '#'".into(), pos: 2 }
        );
    }

    #[test]
    fn unrecognised_characters_carry_a_hint_and_a_utf16_offset() {
        assert_eq!(
            lex_all("é – b").unwrap_err(),
            SyntaxError { message: "Unrecognised character 'é'".into(), pos: 0 }
        );
        assert_eq!(
            lex_all("'🌍' – b").unwrap_err(),
            SyntaxError {
                message: "Unrecognised character '–' — write the ASCII minus '-' (this is an en dash)".into(),
                pos: 5
            }
        );
        // The whole astral character, not half of it.
        assert_eq!(lex_all("🌍").unwrap_err().message, "Unrecognised character '🌍'");
    }

    #[test]
    fn offsets_count_utf16_units() {
        let toks = lex_all("'café🌍' + x").unwrap();
        assert_eq!((toks[0].start, toks[0].end), (0, 8));
        assert_eq!((toks[2].start, toks[2].end), (11, 12));
    }

    #[test]
    fn deeply_nested_interpolations_are_refused_not_overflowed() {
        let text = "\"${".repeat(MAX_DEPTH + 10);
        assert_eq!(lex_all(&text).unwrap_err().message, TOO_DEEP);
    }

    #[test]
    fn matching_close_skips_literals() {
        let src = Utf16::new("(a, \")\", `)`) => x");
        let scanner = Scanner { src: &src, limit: src.len() };
        assert_eq!(scanner.matching_close(0), Some(12));
        let src = Utf16::new("(a]");
        assert_eq!(Scanner { src: &src, limit: src.len() }.matching_close(0), None);
    }
}
