//! Source text as UTF-16 code units. The TypeScript parser indexes a
//! JavaScript string, so every offset it reports is a UTF-16 index; reading
//! the same units here makes each offset, slice and lookahead the TypeScript
//! grammar performs the same operation, with no byte-to-UTF-16 table to keep
//! in step.

/// A text being parsed, and helpers that follow JavaScript's string rules.
pub struct Utf16 {
    units: Vec<u16>,
}

impl Utf16 {
    pub fn new(text: &str) -> Self {
        Self { units: text.encode_utf16().collect() }
    }

    pub fn len(&self) -> usize {
        self.units.len()
    }

    pub fn is_empty(&self) -> bool {
        self.units.is_empty()
    }

    /// `src[i]`: the unit at `i`, or `None` past the end, as `undefined` is.
    pub fn at(&self, i: usize) -> Option<u16> {
        self.units.get(i).copied()
    }

    pub fn units(&self) -> &[u16] {
        &self.units
    }

    /// `src.slice(start, end)`, clamped as JavaScript clamps it.
    pub fn slice(&self, start: usize, end: usize) -> &[u16] {
        let end = end.min(self.units.len());
        let start = start.min(end);
        &self.units[start..end]
    }

    pub fn text(&self, start: usize, end: usize) -> String {
        to_string(self.slice(start, end))
    }

    /// `src.startsWith(prefix, at)`.
    pub fn starts_with(&self, at: usize, prefix: &str) -> bool {
        let mut i = at;
        for unit in prefix.encode_utf16() {
            if self.at(i) != Some(unit) {
                return false;
            }
            i += 1;
        }
        true
    }

    /// `src.indexOf(unit, from)`.
    pub fn index_of(&self, unit: u16, from: usize) -> Option<usize> {
        self.units.iter().skip(from).position(|&u| u == unit).map(|p| p + from)
    }

    /// The character at `i` as a message quotes it. JavaScript would quote
    /// one code unit, half of an astral character; the whole character is
    /// what the author wrote.
    pub fn char_text(&self, i: usize) -> String {
        match (self.at(i), self.at(i + 1)) {
            (Some(hi), Some(lo)) if is_high_surrogate(hi) && is_low_surrogate(lo) => to_string(&[hi, lo]),
            (Some(unit), _) => to_string(&[unit]),
            (None, _) => String::new(),
        }
    }
}

pub fn to_string(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn is_high_surrogate(unit: u16) -> bool {
    (0xD800..0xDC00).contains(&unit)
}

fn is_low_surrogate(unit: u16) -> bool {
    (0xDC00..0xE000).contains(&unit)
}

/// JavaScript's `\s` (and what `trim` removes): WhiteSpace and
/// LineTerminator. Not Rust's `char::is_whitespace`, which also takes
/// U+0085 and leaves out U+FEFF.
pub fn is_js_space(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0D
            | 0x20
            | 0xA0
            | 0x1680
            | 0x2000..=0x200A
            | 0x2028
            | 0x2029
            | 0x202F
            | 0x205F
            | 0x3000
            | 0xFEFF
    )
}

pub fn opt_is(unit: Option<u16>, c: char) -> bool {
    unit == Some(c as u16)
}

pub fn is_ascii_digit(unit: u16) -> bool {
    (b'0' as u16..=b'9' as u16).contains(&unit)
}

pub fn is_ident_start(unit: u16) -> bool {
    unit < 0x80 && (unit as u8 == b'_' || (unit as u8).is_ascii_alphabetic())
}

pub fn is_ident_char(unit: u16) -> bool {
    is_ident_start(unit) || is_ascii_digit(unit)
}

/// `s.trim()`, `s.trimStart()`, `s.trimEnd()` over code units.
pub fn trim(units: &[u16]) -> &[u16] {
    trim_end(trim_start(units))
}

pub fn trim_start(units: &[u16]) -> &[u16] {
    let lead = units.iter().take_while(|&&u| is_js_space(u)).count();
    &units[lead..]
}

pub fn trim_end(units: &[u16]) -> &[u16] {
    let tail = units.iter().rev().take_while(|&&u| is_js_space(u)).count();
    &units[..units.len() - tail]
}

/// An ASCII-case-insensitive match of `word` at the start of `units`: a
/// JavaScript `/i` regex without the `u` flag never folds a non-ASCII
/// character onto an ASCII one.
pub fn starts_with_ci(units: &[u16], word: &str) -> bool {
    let word: Vec<u16> = word.encode_utf16().collect();
    units.len() >= word.len()
        && units.iter().zip(&word).all(|(&a, &b)| a < 0x80 && (a as u8).eq_ignore_ascii_case(&(b as u8)))
}

/// The length of the run of `\s` at the start of `units`.
pub fn space_run(units: &[u16]) -> usize {
    units.iter().take_while(|&&u| is_js_space(u)).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn astral_characters_take_two_units() {
        let s = Utf16::new("a🌍b");
        assert_eq!(s.len(), 4);
        assert_eq!(s.text(1, 3), "🌍");
        assert_eq!(s.char_text(1), "🌍");
    }

    #[test]
    fn whitespace_is_javascripts() {
        assert!(is_js_space(0xFEFF));
        assert!(is_js_space(0x00A0));
        assert!(!is_js_space(0x0085));
    }

    #[test]
    fn case_insensitive_matching_is_ascii_only() {
        let s = Utf16::new("wHeRe x");
        assert!(starts_with_ci(s.units(), "WHERE"));
        // U+017F folds to 's' under Unicode folding; JavaScript's /i without
        // `u` refuses it.
        assert!(!starts_with_ci(Utf16::new("\u{17f}").units(), "S"));
    }
}
