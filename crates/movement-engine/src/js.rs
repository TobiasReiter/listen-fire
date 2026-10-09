//! JavaScript's values, and the JavaScript semantics the TypeScript engine
//! leans on without saying so: `String()`, `Number()`, `===`, truthiness,
//! property order, `Math.round`, `toFixed`, `trim`, UTF-16 lengths and
//! comparisons, `JSON.stringify`. Each is written out here because Rust's own
//! version differs somewhere (see the README's list), and the engine has to
//! compute what the TypeScript engine computed, byte for byte.
//!
//! Objects and arrays are shared (`Rc`), because `===` compares them by
//! identity: `x == x` is true for a dict, and two equal-looking literals are
//! not equal. A value that came from the caller remembers its `origin`, so
//! handing it back hands back the caller's own object.

use std::cmp::Ordering;
use std::rc::Rc;

#[derive(Debug, Clone)]
pub enum Js {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Rc<JsArray>),
    Object(Rc<JsObject>),
}

#[derive(Debug, Default)]
pub struct JsArray {
    pub items: Vec<Js>,
    /// The caller's id for this array, when it came from the caller.
    pub origin: Option<u32>,
}

/// A plain object: own keys in JavaScript's order (array-index keys
/// ascending first, then the rest as inserted).
#[derive(Debug, Default)]
pub struct JsObject {
    entries: Vec<(String, Js)>,
    pub origin: Option<u32>,
}

impl JsObject {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn entries(&self) -> &[(String, Js)] {
        &self.entries
    }

    /// A fresh object with `other`'s own entries (`{...other}`).
    pub fn clone_of(other: &JsObject) -> JsObject {
        JsObject { entries: other.entries.clone(), origin: None }
    }

    pub fn get(&self, key: &str) -> Option<&Js> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// `object[key] = value` for any key but `__proto__` (which sets the
    /// prototype instead; callers refuse it before getting here). A key
    /// already there keeps its place.
    pub fn set(&mut self, key: String, value: Js) {
        insert_in_object_order(&mut self.entries, key, value);
    }
}

/// `object[key] = value` over any keyed list: array-index keys ascending
/// first, then the rest as inserted; a key already there keeps its place.
pub fn insert_in_object_order<V>(entries: &mut Vec<(String, V)>, key: String, value: V) {
    if let Some(slot) = entries.iter_mut().find(|(k, _)| *k == key) {
        slot.1 = value;
        return;
    }
    match array_index(&key) {
        Some(index) => {
            let at = entries.iter().position(|(k, _)| array_index(k).is_none_or(|other| other > index)).unwrap_or(entries.len());
            entries.insert(at, (key, value));
        }
        None => entries.push((key, value)),
    }
}

/// A key that is an array index (`"0"`, `"17"`, below 2³² − 1), which an
/// object lists before its other keys, in numeric order.
fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) || (bytes[0] == b'0' && bytes.len() > 1) {
        return None;
    }
    key.parse::<u64>().ok().filter(|&n| n < u64::from(u32::MAX)).map(|n| n as u32)
}

impl Js {
    pub fn str(text: impl Into<String>) -> Js {
        Js::String(text.into())
    }

    pub fn array(items: Vec<Js>) -> Js {
        Js::Array(Rc::new(JsArray { items, origin: None }))
    }

    pub fn object(object: JsObject) -> Js {
        Js::Object(Rc::new(object))
    }

    /// `null` or `undefined` — what `== null` and `??` test for.
    pub fn is_nullish(&self) -> bool {
        matches!(self, Js::Undefined | Js::Null)
    }

    pub fn truthy(&self) -> bool {
        match self {
            Js::Undefined | Js::Null => false,
            Js::Bool(b) => *b,
            Js::Number(n) => !(n.is_nan() || *n == 0.0),
            Js::String(s) => !s.is_empty(),
            Js::Array(_) | Js::Object(_) => true,
        }
    }

    /// `typeof`, as an error message prints it.
    pub fn type_of(&self) -> &'static str {
        match self {
            Js::Undefined => "undefined",
            Js::Null | Js::Array(_) | Js::Object(_) => "object",
            Js::Bool(_) => "boolean",
            Js::Number(_) => "number",
            Js::String(_) => "string",
        }
    }

    /// `String(value)`.
    pub fn to_js_string(&self) -> String {
        match self {
            Js::Undefined => "undefined".into(),
            Js::Null => "null".into(),
            Js::Bool(b) => b.to_string(),
            Js::Number(n) => number_to_string(*n),
            Js::String(s) => s.clone(),
            // Array.prototype.join: a null or undefined member is empty.
            Js::Array(array) => array
                .items
                .iter()
                .map(|item| if item.is_nullish() { String::new() } else { item.to_js_string() })
                .collect::<Vec<_>>()
                .join(","),
            Js::Object(_) => "[object Object]".into(),
        }
    }

    /// `Number(value)`.
    pub fn to_number(&self) -> f64 {
        match self {
            Js::Undefined => f64::NAN,
            Js::Null => 0.0,
            Js::Bool(b) => f64::from(u8::from(*b)),
            Js::Number(n) => *n,
            Js::String(s) => string_to_number(s),
            Js::Array(_) => string_to_number(&self.to_js_string()),
            Js::Object(_) => f64::NAN,
        }
    }
}

/// `a === b`: numbers by value (`NaN` is not itself, `-0` is `0`), objects
/// and arrays by identity.
pub fn strict_equals(a: &Js, b: &Js) -> bool {
    match (a, b) {
        (Js::Undefined, Js::Undefined) | (Js::Null, Js::Null) => true,
        (Js::Bool(x), Js::Bool(y)) => x == y,
        (Js::Number(x), Js::Number(y)) => x == y,
        (Js::String(x), Js::String(y)) => x == y,
        (Js::Array(x), Js::Array(y)) => Rc::ptr_eq(x, y),
        (Js::Object(x), Js::Object(y)) => Rc::ptr_eq(x, y),
        _ => false,
    }
}

/// SameValueZero — what `includes` and `Set` use: `===`, except `NaN` is
/// itself.
pub fn same_value_zero(a: &Js, b: &Js) -> bool {
    match (a, b) {
        (Js::Number(x), Js::Number(y)) if x.is_nan() && y.is_nan() => true,
        _ => strict_equals(a, b),
    }
}

// ── Strings ───────────────────────────────────────────────────────────────────

/// JavaScript's WhiteSpace and LineTerminator, which `trim` and `\s` strip.
/// Not Rust's `char::is_whitespace`: that one has U+0085 and lacks U+FEFF.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
            | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `.length`: UTF-16 code units, not bytes or chars.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `a < b` on strings: UTF-16 code-unit order, which differs from Rust's
/// code-point order where an astral character meets one above U+E000.
pub fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Whether every character is in the Basic Multilingual Plane — where a
/// UTF-16 code unit and a character are the same thing.
pub fn is_bmp(s: &str) -> bool {
    s.chars().all(|c| (c as u32) < 0x10000)
}

// ── Numbers ───────────────────────────────────────────────────────────────────

/// `Number(text)`: StringToNumber. Rust's `parse::<f64>` disagrees in both
/// directions (it reads `inf`, `nan` and `1_0`-free forms but not `0x10`, and
/// refuses `""`), so the grammar is checked here and only the decimal digits
/// are handed to it.
pub fn string_to_number(text: &str) -> f64 {
    let t = trim(text);
    if t.is_empty() {
        return 0.0;
    }
    for (prefixes, radix) in [(["0x", "0X"], 16), (["0o", "0O"], 8), (["0b", "0B"], 2)] {
        if let Some(digits) = prefixes.iter().find_map(|p| t.strip_prefix(p)) {
            return radix_digits(digits, radix);
        }
    }
    let (negative, body) = match t.as_bytes()[0] {
        b'+' => (false, &t[1..]),
        b'-' => (true, &t[1..]),
        _ => (false, t),
    };
    let magnitude = if body == "Infinity" { f64::INFINITY } else { decimal(body) };
    if negative { -magnitude } else { magnitude }
}

/// `StrUnsignedDecimalLiteral`: `1`, `1.`, `.5`, `1.5e-3`; anything else NaN.
fn decimal(body: &str) -> f64 {
    let bytes = body.as_bytes();
    let digits = |from: usize| bytes[from..].iter().take_while(|b| b.is_ascii_digit()).count();
    let int = digits(0);
    let mut at = int;
    let mut frac = 0;
    if bytes.get(at) == Some(&b'.') {
        frac = digits(at + 1);
        at += 1 + frac;
    }
    if int + frac == 0 {
        return f64::NAN;
    }
    let mantissa_end = at;
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(bytes.get(at + 1), Some(b'+' | b'-')));
        let exp = digits(at + 1 + sign);
        if exp == 0 {
            return f64::NAN;
        }
        at += 1 + sign + exp;
    }
    if at != bytes.len() {
        return f64::NAN;
    }
    let int_part = if int == 0 { "0" } else { &body[..int] };
    let frac_part = if frac == 0 { "0" } else { &body[int + 1..int + 1 + frac] };
    let exponent = &body[mantissa_end..];
    format!("{int_part}.{frac_part}{exponent}").parse().unwrap_or(f64::NAN)
}

/// A `0x`/`0o`/`0b` literal's digits, rounded once to the nearest double as
/// JavaScript rounds the mathematical value.
fn radix_digits(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let bits_per = radix.trailing_zeros();
    let mut bits: Vec<bool> = Vec::new();
    for c in digits.chars() {
        let Some(d) = c.to_digit(radix) else { return f64::NAN };
        for i in (0..bits_per).rev() {
            bits.push((d >> i) & 1 == 1);
        }
    }
    let first = bits.iter().position(|&b| b).unwrap_or(bits.len());
    let bits = &bits[first..];
    if bits.is_empty() {
        return 0.0;
    }
    let take = bits.len().min(64);
    let mut m: u64 = bits[..take].iter().fold(0, |acc, &b| (acc << 1) | u64::from(b));
    // The dropped bits only matter as "some were set": 64 kept bits are
    // well past the 53 of the mantissa, so a sticky low bit rounds right.
    if bits[take..].iter().any(|&b| b) {
        m |= 1;
    }
    let scale = (bits.len() - take) as i32;
    (m as f64) * 2f64.powi(scale)
}

/// `Number.prototype.toString()`: ECMAScript's Number::toString, from
/// `ryu-js`. Rust's own shortest form picks a different digit string on a
/// 17-digit tie (where JavaScript takes the closer one, then the even one),
/// so it is not used for text.
pub fn number_to_string(x: f64) -> String {
    ryu_js::Buffer::new().format(x).to_string()
}

/// `Number.isInteger`.
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x
}

/// `Math.round`: half toward +∞ (`Math.round(-2.5)` is `-2`), and a negative
/// that rounds to zero is `-0`. Not Rust's `round`, which goes half away
/// from zero.
pub fn math_round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    if x > 0.0 && x < 0.5 {
        return 0.0;
    }
    if x < 0.0 && x >= -0.5 {
        return -0.0;
    }
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `Math.sign`.
pub fn math_sign(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 { x } else { x.signum() }
}

/// `Number.prototype.toFixed(digits)`: the exact decimal value of the
/// double, rounded half UP at `digits` places (`(0.25).toFixed(1)` is `0.3`,
/// where Rust's `{:.1}` rounds half to even and prints `0.2`), and
/// `String(x)` from 1e21 up.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.abs() >= 1e21 || x.is_infinite() {
        return number_to_string(x);
    }
    let negative = x < 0.0;
    // 1100 places hold any double's exact expansion (at most 1074), so this
    // prints the value itself, unrounded.
    let exact = format!("{:.1100}", x.abs());
    let (int, frac) = exact.split_once('.').expect("a fixed-point print has a point");
    let mut kept: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).collect();
    let rest = &frac.as_bytes()[digits..];
    if rest.first().is_some_and(|&d| d >= b'5') {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let int_len = kept.len() - digits;
    let text = String::from_utf8(kept).expect("digits are ASCII");
    let body = if digits == 0 { text } else { format!("{}.{}", &text[..int_len], &text[int_len..]) };
    // `(-0.01).toFixed(1)` is `-0.0`: the sign is the input's, not the digits'.
    if negative { format!("-{body}") } else { body }
}

// ── JSON.stringify ────────────────────────────────────────────────────────────

/// `JSON.stringify(text)`: the quoting JSON.stringify does (`\u00xx` in
/// lower case for the controls it has no short escape for).
pub fn json_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
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

/// `JSON.stringify(value, null, indent)` over a value that is already JSON
/// data (no `undefined`, no non-finite numbers). `indent` 0 is the compact
/// form.
pub fn json_stringify(value: &Js, indent: usize) -> String {
    let mut out = String::new();
    write_json(value, indent, 0, &mut out);
    out
}

fn write_json(value: &Js, indent: usize, depth: usize, out: &mut String) {
    let newline = |out: &mut String, depth: usize| {
        if indent > 0 {
            out.push('\n');
            out.push_str(&" ".repeat(indent * depth));
        }
    };
    match value {
        Js::Undefined | Js::Null => out.push_str("null"),
        Js::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Js::Number(n) => out.push_str(&if n.is_finite() { number_to_string(*n) } else { "null".into() }),
        Js::String(s) => out.push_str(&json_quote(s)),
        Js::Array(array) => {
            if array.items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in array.items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                write_json(item, indent, depth + 1, out);
            }
            newline(out, depth);
            out.push(']');
        }
        Js::Object(object) => {
            let entries: Vec<_> = object.entries().iter().filter(|(_, v)| !matches!(v, Js::Undefined)).collect();
            if entries.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (key, item)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                out.push_str(&json_quote(key));
                out.push(':');
                if indent > 0 {
                    out.push(' ');
                }
                write_json(item, indent, depth + 1, out);
            }
            newline(out, depth);
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_to_string_matches_javascript() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.1, "0.1"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (0.000001, "0.000001"),
            (1.5e-7, "1.5e-7"),
            (123e-7, "0.0000123"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (1234.5, "1234.5"),
            // A 17-digit tie: JavaScript prints the closer digits.
            (16086.196899414062, "16086.196899414062"),
        ];
        for (x, want) in cases {
            assert_eq!(number_to_string(*x), *want, "{x:?}");
        }
    }

    #[test]
    fn string_to_number_matches_javascript() {
        let cases: &[(&str, f64)] = &[
            ("", 0.0),
            ("   ", 0.0),
            ("  12 ", 12.0),
            ("1e3", 1000.0),
            ("0x10", 16.0),
            ("0X1f", 31.0),
            ("0o17", 15.0),
            ("0b101", 5.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("+.5e1", 5.0),
            ("-12.25", -12.25),
            ("Infinity", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
            ("\u{a0}12\u{feff}", 12.0),
            ("0x1fffffffffffff1", 144115188075855860.0),
        ];
        for (s, want) in cases {
            assert_eq!(string_to_number(s), *want, "{s:?}");
        }
        for s in ["infinity", "inf", "nan", "NaN", "1_0", "-0x10", "0x", "1e", "e3", ".", "+", "12abc", "\u{85}12", "1 2"] {
            assert!(string_to_number(s).is_nan(), "{s:?}");
        }
        assert!(string_to_number("-0").is_sign_negative());
    }

    #[test]
    fn math_round_is_half_toward_positive_infinity() {
        assert_eq!(math_round(2.5), 3.0);
        assert_eq!(math_round(-2.5), -2.0);
        assert_eq!(math_round(-2.6), -3.0);
        assert_eq!(math_round(0.49999999999999994), 0.0);
        assert!(math_round(-0.4).is_sign_negative());
        assert_eq!(math_round(4503599627370497.0), 4503599627370497.0);
    }

    #[test]
    fn to_fixed_rounds_the_exact_value_half_up() {
        assert_eq!(to_fixed(0.25, 1), "0.3");
        assert_eq!(to_fixed(1.45, 1), "1.4");
        assert_eq!(to_fixed(0.05, 1), "0.1");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(9.96, 1), "10.0");
        assert_eq!(to_fixed(1.2, 1), "1.2");
        assert_eq!(to_fixed(1e21, 1), "1e+21");
    }

    #[test]
    fn strings_are_utf16_where_javascript_says_so() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(utf16_cmp("\u{FF61}", "😀"), Ordering::Greater);
        assert_eq!(trim("\u{FEFF} x \u{2028}"), "x");
        assert_eq!(trim("\u{85}x"), "\u{85}x");
    }

    #[test]
    fn objects_keep_javascript_key_order() {
        let mut o = JsObject::new();
        o.set("b".into(), Js::Number(1.0));
        o.set("10".into(), Js::Number(2.0));
        o.set("a".into(), Js::Number(3.0));
        o.set("2".into(), Js::Number(4.0));
        o.set("b".into(), Js::Number(5.0));
        o.set("01".into(), Js::Number(6.0));
        let keys: Vec<_> = o.entries().iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["2", "10", "b", "a", "01"]);
    }

    #[test]
    fn string_and_number_coercions_of_composites() {
        let list = Js::array(vec![Js::Number(1.0), Js::Null, Js::array(vec![Js::str("a"), Js::Undefined])]);
        assert_eq!(list.to_js_string(), "1,,a,");
        assert_eq!(Js::array(vec![]).to_number(), 0.0);
        assert_eq!(Js::array(vec![Js::str(" 5 ")]).to_number(), 5.0);
        assert!(Js::object(JsObject::new()).to_number().is_nan());
        assert_eq!(Js::object(JsObject::new()).to_js_string(), "[object Object]");
    }

    #[test]
    fn identity_not_shape_decides_equality() {
        let a = Js::array(vec![]);
        assert!(strict_equals(&a, &a.clone()));
        assert!(!strict_equals(&a, &Js::array(vec![])));
        assert!(!strict_equals(&Js::Number(f64::NAN), &Js::Number(f64::NAN)));
        assert!(same_value_zero(&Js::Number(f64::NAN), &Js::Number(f64::NAN)));
        assert!(strict_equals(&Js::Number(0.0), &Js::Number(-0.0)));
    }

    #[test]
    fn json_stringify_indents_as_javascript_does() {
        let mut inner = JsObject::new();
        inner.set("k".into(), Js::str("a\"\u{1}"));
        let value = Js::array(vec![Js::Number(1.0), Js::object(inner), Js::array(vec![]), Js::object(JsObject::new())]);
        assert_eq!(json_stringify(&value, 2), "[\n  1,\n  {\n    \"k\": \"a\\\"\\u0001\"\n  },\n  [],\n  {}\n]");
        assert_eq!(json_stringify(&value, 0), "[1,{\"k\":\"a\\\"\\u0001\"},[],{}]");
    }
}
