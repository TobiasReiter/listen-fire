//! Character scans the statement layer and the expression grammar share
//! (packages/movement-lang/parser/scan.ts) — the one definition of what a
//! NAME is: a bare identifier, or a backtick-quoted name when the exposed
//! name carries spaces or punctuation.

use crate::util::utf16::{is_ident_char, is_ident_start, to_string, trim};

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

/// A backtick-quoted name at `pos` (the opening backtick): the interior and
/// the index of the CLOSING backtick. A quoted name is single-line; `None`
/// when it is unterminated before a newline or the end.
pub fn scan_backtick_name(src: &[u16], pos: usize) -> Option<(String, usize)> {
    if src.get(pos) != Some(&(b'`' as u16)) {
        return None;
    }
    let mut end = pos + 1;
    while end < src.len() && src[end] != b'`' as u16 && src[end] != b'\n' as u16 {
        end += 1;
    }
    if end >= src.len() || src[end] == b'\n' as u16 {
        return None;
    }
    Some((to_string(&src[pos + 1..end]), end))
}

/// A NAME at `pos`, bare or quoted: the name (backticks stripped) and the
/// index just past the whole token.
pub fn scan_name(src: &[u16], pos: usize) -> Option<(String, usize)> {
    if src.get(pos) == Some(&(b'`' as u16)) {
        let (name, close) = scan_backtick_name(src, pos)?;
        return Some((name, close + 1));
    }
    scan_ident(src, pos)
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
    let mut depth = 0usize;
    let mut arg_start = open + 1;
    let mut i = open;
    while i < src.len() {
        let c = src[i];
        if c == b'"' as u16 || c == b'\'' as u16 || c == b'`' as u16 {
            let close = src.iter().skip(i + 1).position(|&u| u == c)? + i + 1;
            i = close + 1;
            continue;
        }
        if c == b'(' as u16 || c == b'[' as u16 || c == b'{' as u16 {
            depth += 1;
        } else if c == b')' as u16 || c == b']' as u16 || c == b'}' as u16 {
            depth -= 1;
            if depth == 0 {
                args.push(to_string(trim(&src[arg_start..i])));
                break;
            }
        } else if c == b',' as u16 && depth == 1 {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn message(text: &str) -> Option<String> {
        let units: Vec<u16> = text.encode_utf16().collect();
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
}
