//! Character scans the statement layer and the expression grammar share
//! (packages/movement-lang/parser/scan.ts) — the one definition of what a
//! NAME is: a bare identifier, or a backtick-quoted name when the exposed
//! name carries spaces or punctuation.

use crate::util::utf16::{is_ident_char, is_ident_start, is_js_space, to_string, trim};

/// A bare identifier at `pos`: the name and the index just past it.
pub fn scan_ident(src: &[u16], pos: usize) -> Option<(String, usize)> {
    let end = ident_end(src, pos)?;
    Some((to_string(&src[pos..end]), end))
}

/// Where the bare identifier at `pos` ends, without copying it out.
pub fn ident_end(src: &[u16], pos: usize) -> Option<usize> {
    if !is_ident_start(*src.get(pos)?) {
        return None;
    }
    let mut end = pos + 1;
    while end < src.len() && is_ident_char(src[end]) {
        end += 1;
    }
    Some(end)
}

/// A backtick-quoted name at `pos` (the opening backtick): the name and the
/// index of the CLOSING backtick. A quoted name is single-line, and a
/// backslash escapes the next character (`` `a\`b` `` is a`b, `` `a\\b` `` is
/// a\b), the expression lexer's rule, so every reader of a name reads it the
/// same way. `None` when it is unterminated before a newline or `limit`.
pub fn scan_backtick_name(src: &[u16], pos: usize) -> Option<(String, usize)> {
    scan_backtick_name_within(src, pos, src.len())
}

/// `scan_backtick_name` inside a window ending at `limit`.
pub fn scan_backtick_name_within(src: &[u16], pos: usize, limit: usize) -> Option<(String, usize)> {
    if src.get(pos) != Some(&BACKTICK) {
        return None;
    }
    let after = skip_backtick_name(src, pos, limit)?;
    let interior = &src[pos + 1..after - 1];
    // The TypeScript's `replace(/\\(.)/g, '$1')`: `.` is any unit but a line
    // terminator, so a backslash before one stays.
    let mut name: Vec<u16> = Vec::with_capacity(interior.len());
    let mut i = 0;
    while i < interior.len() {
        let u = interior[i];
        if u == BACKSLASH && interior.get(i + 1).is_some_and(|&next| !is_line_terminator(next)) {
            name.push(interior[i + 1]);
            i += 2;
            continue;
        }
        name.push(u);
        i += 1;
    }
    Some((to_string(&name), after - 1))
}

fn is_line_terminator(u: u16) -> bool {
    u == NEWLINE || u == b'\r' as u16 || u == 0x2028 || u == 0x2029
}

/// A NAME at `pos`, bare or quoted: the name (backticks stripped, escapes
/// read) and the index just past the whole token.
pub fn scan_name(src: &[u16], pos: usize) -> Option<(String, usize)> {
    if src.get(pos) == Some(&BACKTICK) {
        let (name, close) = scan_backtick_name(src, pos)?;
        return Some((name, close + 1));
    }
    scan_ident(src, pos)
}

/// A MEMBER PATH at `pos`: a name and one or more property steps (`m.k`,
/// ``m.`a key`.inner``), nothing else. Each step's name and the index just
/// past the last; `None` for no name, or a name with no `.` step after it.
pub fn scan_member_path(src: &[u16], pos: usize) -> Option<(Vec<String>, usize)> {
    let (first, mut end) = scan_name(src, pos)?;
    let mut names = vec![first];
    while src.get(end) == Some(&(b'.' as u16)) {
        let Some((step, step_end)) = scan_name(src, end + 1) else {
            break;
        };
        names.push(step);
        end = step_end;
    }
    (names.len() > 1).then_some((names, end))
}

/// `IF(cond, a, b)` — IF called like a spreadsheet function. A parenthesised
/// condition (`IF (a OR b) THEN …`) is the ordinary form; only a top-level
/// comma inside the parentheses says the author meant a call. `open` is the
/// offset of the `(` after `IF`. The refusal, with the rewrite where there
/// are three arguments.
pub fn call_style_if_message(src: &[u16], open: usize) -> Option<String> {
    if src.get(open) != Some(&(b'(' as u16)) {
        return None;
    }
    let mut args: Vec<String> = Vec::new();
    let mut hops: Vec<bool> = Vec::new();
    let mut arg_start = open + 1;
    let mut i = open;
    while i < src.len() {
        match skip_opaque(src, i, hops.last().copied().unwrap_or(false), src.len()) {
            Ok(Some(Opaque::Skipped { end, .. })) => {
                i = end;
                continue;
            }
            Ok(Some(Opaque::Unterminated { .. })) | Err(TooDeep) => return None,
            Ok(None) => {}
        }
        let c = src[i];
        if is_opener(c) {
            hops.push(opens_hop(src, i, src.len()));
        } else if is_closer(c) {
            hops.pop();
            if hops.is_empty() {
                args.push(to_string(trim(&src[arg_start..i])));
                break;
            }
        } else if c == b',' as u16 && hops.len() == 1 {
            args.push(to_string(trim(&src[arg_start..i])));
            arg_start = i + 1;
        }
        i += 1;
    }
    if args.len() < 2 {
        return None;
    }
    let rewrite = if args.len() == 3 {
        format!("IF {} THEN {} ELSE {} END", args[0], args[1], args[2])
    } else {
        "IF <condition> THEN <value> ELSE <otherwise> END".to_string()
    };
    Some(format!("IF is written 'IF … THEN … ELSE … END', not called like a function — write '{rewrite}'"))
}

// ── The text a bracket scan steps over whole ──
//
// Both grammars find where a bracketed region ends without parsing it: the
// statement grammar to capture an expression slot, the expression grammar to
// find a closure's block body and a `${…}` interpolation. These are the ONE
// set of rules for what that scan steps over (packages/movement-lang/parser/
// scan.ts holds the same for the language service), so neither grammar can
// see a bracket the other reads as prose.

const BACKTICK: u16 = b'`' as u16;
const BACKSLASH: u16 = b'\\' as u16;
const NEWLINE: u16 = b'\n' as u16;

/// Strings nested inside interpolations past this many are refused rather
/// than recursed into (`crate::lexer::MAX_DEPTH`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TooDeep;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpaqueKind {
    String,
    Name,
    Comment,
}

/// What a scan steps over whole at a position: a string (`"…"`, `'…'`), a
/// backtick-quoted name or a `#` comment, and the index just past it (a
/// comment stops before its newline); or one that never closes, and where it
/// began.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opaque {
    Skipped { kind: OpaqueKind, end: usize },
    Unterminated { name: bool, start: usize },
}

pub fn is_opener(c: u16) -> bool {
    c == b'(' as u16 || c == b'[' as u16 || c == b'{' as u16
}

pub fn is_closer(c: u16) -> bool {
    c == b')' as u16 || c == b']' as u16 || c == b'}' as u16
}

fn closer_of(open: u16) -> u16 {
    match open {
        0x28 => b')' as u16,
        0x5B => b']' as u16,
        _ => b'}' as u16,
    }
}

/// What starts at `pos` that a bracket scan must step over whole, or `None`
/// when it is code. `in_hop` is true directly inside a hop's brackets, where
/// `#` begins a head (`-[#linked]->`) rather than a comment.
pub fn skip_opaque(src: &[u16], pos: usize, in_hop: bool, limit: usize) -> Result<Option<Opaque>, TooDeep> {
    skip_opaque_at(src, pos, in_hop, limit, 0)
}

fn skip_opaque_at(src: &[u16], pos: usize, in_hop: bool, limit: usize, depth: usize) -> Result<Option<Opaque>, TooDeep> {
    let Some(&c) = src.get(pos) else {
        return Ok(None);
    };
    if c == b'"' as u16 || c == b'\'' as u16 {
        return Ok(Some(match skip_string_at(src, pos, limit, depth)? {
            Some(end) => Opaque::Skipped { kind: OpaqueKind::String, end },
            None => Opaque::Unterminated { name: false, start: pos },
        }));
    }
    if c == BACKTICK {
        return Ok(Some(match skip_backtick_name(src, pos, limit) {
            Some(end) => Opaque::Skipped { kind: OpaqueKind::Name, end },
            None => Opaque::Unterminated { name: true, start: pos },
        }));
    }
    if c == b'#' as u16 && !in_hop {
        let mut end = pos;
        while end < limit && src[end] != NEWLINE {
            end += 1;
        }
        return Ok(Some(Opaque::Skipped { kind: OpaqueKind::Comment, end }));
    }
    Ok(None)
}

/// The index just past the string opening at `pos` (`"` or `'`), or `None`
/// when it never closes. A backslash escapes the next unit; a double-quoted
/// string's `${…}` is a balanced region, so a quote or brace inside it is code.
pub fn skip_string(src: &[u16], pos: usize, limit: usize) -> Result<Option<usize>, TooDeep> {
    skip_string_at(src, pos, limit, 0)
}

fn skip_string_at(src: &[u16], pos: usize, limit: usize, depth: usize) -> Result<Option<usize>, TooDeep> {
    if depth > crate::lexer::MAX_DEPTH {
        return Err(TooDeep);
    }
    let quote = src[pos];
    let mut i = pos + 1;
    while i < limit {
        let c = src[i];
        if c == BACKSLASH {
            i += 2;
            continue;
        }
        if quote == b'"' as u16 && c == b'$' as u16 && src.get(i + 1) == Some(&(b'{' as u16)) {
            let Some(close) = matching_close_at(src, i + 1, limit, depth + 1)? else {
                return Ok(None);
            };
            i = close + 1;
            continue;
        }
        if c == quote {
            return Ok(Some(i + 1));
        }
        i += 1;
    }
    Ok(None)
}

/// The index just past the backtick-quoted name opening at `pos`, or `None`
/// when it does not close on its line. A backslash escapes the next unit, so
/// `` `a\`b` `` is one name.
pub fn skip_backtick_name(src: &[u16], pos: usize, limit: usize) -> Option<usize> {
    let mut i = pos + 1;
    while i < limit && src[i] != NEWLINE {
        if src[i] == BACKTICK {
            return Some(i + 1);
        }
        i += if src[i] == BACKSLASH && src.get(i + 1) != Some(&NEWLINE) { 2 } else { 1 };
    }
    None
}

/// `start` is just inside `-[` / `<-[`: a hop opens with `:`, `#`, or an
/// alias (`name:`). Anything else is a minus and a list.
pub fn is_hop_interior(src: &[u16], start: usize, limit: usize) -> bool {
    let mut i = start;
    while i < limit && is_js_space(src[i]) {
        i += 1;
    }
    let c = src.get(i).copied();
    if c == Some(b':' as u16) || c == Some(b'#' as u16) {
        return true;
    }
    let end = if c == Some(BACKTICK) { skip_backtick_name(src, i, limit) } else { ident_end(src, i) };
    let Some(end) = end.filter(|&end| end <= limit) else {
        return false;
    };
    let mut j = end;
    while j < limit && is_js_space(src[j]) {
        j += 1;
    }
    src.get(j) == Some(&(b':' as u16))
}

/// Does the bracket at `open` begin a hop's interior (`-[…]->`, `<-[…]-`)?
pub fn opens_hop(src: &[u16], open: usize, limit: usize) -> bool {
    src.get(open) == Some(&(b'[' as u16))
        && open > 0
        && src[open - 1] == b'-' as u16
        && is_hop_interior(src, open + 1, limit)
}

/// The index of the bracket closing the one at `open`, or `None` when it is
/// unbalanced or a literal inside it never closes. Strings, quoted names and
/// comments are stepped over whole at every depth, except that directly
/// inside a hop's brackets `#` begins a head.
pub fn matching_close(src: &[u16], open: usize, limit: usize) -> Result<Option<usize>, TooDeep> {
    matching_close_at(src, open, limit, 0)
}

fn matching_close_at(src: &[u16], open: usize, limit: usize, depth: usize) -> Result<Option<usize>, TooDeep> {
    let mut stack: Vec<(u16, bool)> = Vec::new();
    let mut i = open;
    while i < limit {
        let in_hop = stack.last().is_some_and(|&(_, hop)| hop);
        match skip_opaque_at(src, i, in_hop, limit, depth)? {
            Some(Opaque::Skipped { end, .. }) => {
                i = end;
                continue;
            }
            Some(Opaque::Unterminated { .. }) => return Ok(None),
            None => {}
        }
        let c = src[i];
        if is_opener(c) {
            stack.push((closer_of(c), opens_hop(src, i, limit)));
        } else if is_closer(c) {
            if stack.pop().map(|(close, _)| close) != Some(c) {
                return Ok(None);
            }
            if stack.is_empty() {
                return Ok(Some(i));
            }
        }
        i += 1;
    }
    Ok(None)
}

/// Is `pos` directly inside a hop's brackets, where `#` begins a head rather
/// than a comment? `from` is outside every bracket; the brackets between it
/// and `pos` are read with the scan's own rules.
pub fn is_directly_in_hop(src: &[u16], from: usize, pos: usize) -> bool {
    let mut hops: Vec<bool> = Vec::new();
    let mut i = from;
    while i < pos {
        match skip_opaque(src, i, hops.last().copied().unwrap_or(false), pos) {
            Ok(Some(Opaque::Skipped { end, .. })) => {
                i = end;
                continue;
            }
            Ok(Some(Opaque::Unterminated { .. })) | Err(TooDeep) => return false,
            Ok(None) => {}
        }
        let c = src[i];
        if is_opener(c) {
            hops.push(opens_hop(src, i, src.len()));
        } else if is_closer(c) {
            hops.pop();
        }
        i += 1;
    }
    hops.last().copied().unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(text: &str) -> Option<String> {
        let units: Vec<u16> = crate::util::form::units_vec(text);
        call_style_if_message(&units, 0)
    }

    #[test]
    fn three_arguments_get_the_rewrite() {
        assert_eq!(
            message("(a, 'x,y', c)").as_deref(),
            Some("IF is written 'IF … THEN … ELSE … END', not called like a function — write 'IF a THEN 'x,y' ELSE c END'")
        );
    }

    #[test]
    fn a_parenthesised_condition_is_not_a_call() {
        assert_eq!(message("(a OR b) THEN 1 END"), None);
        assert_eq!(message("(f(a, b)) THEN 1 END"), None);
    }

    #[test]
    fn two_arguments_get_the_template() {
        assert!(message("(a, b)").unwrap().ends_with("'IF <condition> THEN <value> ELSE <otherwise> END'"));
    }

    fn units(text: &str) -> Vec<u16> {
        crate::util::form::units_vec(text)
    }

    #[test]
    fn a_backtick_name_reads_its_escapes() {
        assert_eq!(scan_name(&units("`a\\`b`"), 0), Some(("a`b".into(), 6)));
        assert_eq!(scan_name(&units("`a\\\\b`"), 0), Some(("a\\b".into(), 6)));
        assert_eq!(scan_name(&units("`a\\nb`"), 0), Some(("anb".into(), 6)));
        assert_eq!(scan_name(&units("`open\nname`"), 0), None);
    }

    #[test]
    fn a_member_path_is_a_name_and_its_steps() {
        assert_eq!(scan_member_path(&units("m.k {"), 0), Some((vec!["m".into(), "k".into()], 3)));
        assert_eq!(scan_member_path(&units("m.`a key`.inner"), 0).map(|(n, e)| (n.len(), e)), Some((3, 15)));
        assert_eq!(scan_member_path(&units("m {"), 0), None);
    }

    #[test]
    fn matching_close_steps_over_strings_names_and_comments() {
        let src = units("{ # a } ' quote\n  x = 'b}' + `c}`\n}");
        assert_eq!(matching_close(&src, 0, src.len()), Ok(Some(src.len() - 1)));
        // Directly inside a hop's brackets `#` begins a head.
        let src = units("(x-[#linked]->)");
        assert_eq!(matching_close(&src, 0, src.len()), Ok(Some(14)));
        assert!(is_directly_in_hop(&src, 0, 4));
        assert!(!is_directly_in_hop(&src, 0, 1));
    }
}
