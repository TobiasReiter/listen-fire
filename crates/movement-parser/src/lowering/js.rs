//! The JavaScript semantics the lowering's messages and text reads depend on,
//! made explicit. The crate README lists each.

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
}
