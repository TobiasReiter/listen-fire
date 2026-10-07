//! The JavaScript semantics the lowering and the catalog depend on, made
//! explicit. The crate README lists each.

use std::cmp::Ordering;

use crate::util::utf16::{self, Utf16};

/// `String(x)` for a number — ECMAScript's Number::toString: the shortest
/// digits that round-trip, positional between 1e-7 and 1e21, else `1.5e+21`.
/// Rust's `{}` differs at both ends (`1e21` prints in full, `1e-7` as
/// `0.0000001`).
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x < 0.0 {
        return format!("-{}", number_to_string(-x));
    }
    // `{:e}` is the shortest round-tripping digits: `d[.ddd]e<exp>`.
    let sci = format!("{x:e}");
    let (mantissa, exp) = sci.split_once('e').expect("LowerExp writes an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exp: i32 = exp.parse().expect("LowerExp writes an integer exponent");
    let k = digits.len() as i32;
    let n = exp + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let sign = if n - 1 < 0 { '-' } else { '+' };
        let e = (n - 1).abs();
        if k == 1 { format!("{digits}e{sign}{e}") } else { format!("{}.{}e{sign}{e}", &digits[..1], &digits[1..]) }
    }
}

/// A JavaScript object's own-key order: array-index keys (the canonical
/// decimal of an integer below 2^32 - 1) first, ascending, then the rest in
/// insertion order. `IndexMap` keeps only the second.
pub fn object_key_order<V>(map: &mut indexmap::IndexMap<String, V>) {
    fn array_index(key: &str) -> Option<u32> {
        let n: u32 = key.parse().ok()?;
        (n != u32::MAX && n.to_string() == key).then_some(n)
    }
    // A stable sort: the non-index keys tie, and keep their order.
    map.sort_by(|a, _, b, _| match (array_index(a), array_index(b)) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
}

/// `text.slice(start, end)` with UTF-16 offsets, as a tree's `at` indexes
/// its source.
pub fn slice(source: &Utf16, start: usize, end: usize) -> String {
    source.text(start, end)
}

/// `s.trim()`: JavaScript's whitespace, not Rust's (U+FEFF in, U+0085 out).
pub fn trim(s: &str) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    utf16::to_string(utf16::trim(&units))
}

/// `${s.slice(0, -1)}${s.slice(-1).toLowerCase()}`: the last UTF-16 unit
/// lowercased. Half of an astral character has no case, so that text is
/// left as it is.
pub fn lowercase_last_unit(s: &str) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    match units.split_last() {
        Some((&last, head)) if !(0xD800..0xE000).contains(&last) => {
            let last = char::from_u32(u32::from(last)).expect("a non-surrogate unit is a character");
            format!("{}{}", utf16::to_string(head), last.to_lowercase())
        }
        _ => s.to_string(),
    }
}

/// `a < b` on strings: UTF-16 code units, where Rust's `Ord` compares code
/// points; the two disagree when one side is astral and the other sits in
/// U+E000–U+FFFF.
pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `a.localeCompare(b)` as Node's ICU collation answers it for the default
/// locale, for the text it is given here (identifiers): punctuation and
/// spaces before digits before letters, a letter's case ignored until every
/// letter ties, then lower case first; control characters ignored. Outside
/// ASCII it falls back to code-point order, which ICU does not (an accented
/// letter sorts with its base letter) — a divergence the crate README names.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    // Node's own order for printable ASCII, read off `localeCompare`
    // (2026-10-07); letters appear once, lower case standing for both.
    const ASCII_ORDER: &str = "\t\n\u{b}\u{c}\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";
    fn weights(s: &str) -> (Vec<u32>, Vec<u8>) {
        let mut primary = Vec::new();
        let mut tertiary = Vec::new();
        for c in s.chars() {
            if c.is_ascii_control() && !matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r') {
                continue;
            }
            let lower = c.to_ascii_lowercase();
            let weight = match ASCII_ORDER.find(lower) {
                Some(i) if c.is_ascii() => i as u32,
                _ => ASCII_ORDER.len() as u32 + u32::from(c),
            };
            primary.push(weight);
            tertiary.push(u8::from(c.is_ascii_uppercase()));
        }
        (primary, tertiary)
    }
    let (pa, ta) = weights(a);
    let (pb, tb) = weights(b);
    pa.cmp(&pb).then_with(|| ta.cmp(&tb))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        let cases: [(f64, &str); 14] = [
            (0.0, "0"),
            (-0.0, "0"),
            (5.0, "5"),
            (-5.0, "-5"),
            (1.5, "1.5"),
            (0.1, "0.1"),
            (100.0, "100"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (1.25e-10, "1.25e-10"),
            (f64::INFINITY, "Infinity"),
        ];
        for (x, js) in cases {
            assert_eq!(number_to_string(x), js, "{x:?}");
        }
        assert_eq!(number_to_string(f64::NAN), "NaN");
    }

    #[test]
    fn trim_is_javascripts() {
        assert_eq!(trim("\u{feff} a \u{a0}"), "a");
        assert_eq!(trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn only_the_last_unit_is_lowercased() {
        assert_eq!(lowercase_last_unit("30D"), "30d");
        assert_eq!(lowercase_last_unit("DD"), "Dd");
        assert_eq!(lowercase_last_unit(""), "");
        // Half of an astral character has no case.
        assert_eq!(lowercase_last_unit("3🌍"), "3🌍");
    }

    #[test]
    fn strings_compare_by_utf16_units() {
        // U+FF61 is one unit above U+D83C, the first unit of 🌍; by code
        // point the emoji is the greater.
        assert_eq!(cmp_utf16("🌍", "\u{ff61}"), Ordering::Less);
        assert_eq!("🌍".cmp("\u{ff61}"), Ordering::Greater);
        assert_eq!(cmp_utf16("a", "b"), Ordering::Less);
        assert_eq!(cmp_utf16("ab", "a"), Ordering::Greater);
    }

    #[test]
    fn locale_compare_is_node_s_for_identifiers() {
        // The order Node printed for these (2026-10-07).
        let mut names = vec!["b", "B", "ab_", "Ab", "aB", "ab", "a1", "a-b", "a_b", "A", "a"];
        names.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(names, ["a", "A", "a_b", "a-b", "a1", "ab", "aB", "Ab", "ab_", "b", "B"]);
        assert_eq!(locale_compare("a\u{1}b", "ab"), Ordering::Equal);
        assert_eq!(locale_compare("\t", " "), Ordering::Less);
        assert_eq!(locale_compare("spreadsheet", "sheet"), Ordering::Greater);
    }
}
