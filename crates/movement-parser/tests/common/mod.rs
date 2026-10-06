//! What the conformance harnesses share: the fixture paths and the canonical
//! JSON the TypeScript pins were hashed over.

use std::fmt::Write;
use std::path::PathBuf;

use serde_json::Value;

pub fn fixture(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/movement-lang").join(relative)
}

/// The text `canonical` in parser/expression/__test__/lowering_fixture.ts
/// produces: `JSON.stringify` with every object's keys sorted. Written out
/// by hand rather than with `serde_json::to_string` because the pins hash
/// JavaScript's number spelling (`5`, not `5.0`; `1e+21`, not `1e21`).
///
/// Keys sort by UTF-8 bytes here and by UTF-16 code units in JavaScript;
/// the two orders differ only between a key with an astral-plane character
/// and one with a character in U+E000..U+FFFF.
pub fn canonical(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(out, n),
        Value::String(s) => write_string(out, s),
        // JSON.stringify writes an `undefined` array element as `null`; Rust
        // has no undefined and writes `null` itself, so the two agree.
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            out.push('{');
            for (i, (key, item)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, item);
            }
            out.push('}');
        }
    }
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => write!(out, "\\u{:04x}", c as u32).unwrap(),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_number(out: &mut String, n: &serde_json::Number) {
    if let Some(i) = n.as_i64() {
        write!(out, "{i}").unwrap();
    } else if let Some(u) = n.as_u64() {
        write!(out, "{u}").unwrap();
    } else {
        out.push_str(&js_number(n.as_f64().expect("a JSON number is an i64, a u64 or an f64")));
    }
}

/// `Number.prototype.toString()` (ECMA-262 Number::toString, radix 10):
/// Rust's `{:e}` gives the same shortest round-tripping digits, which are
/// then laid out by JavaScript's rules.
pub fn js_number(x: f64) -> String {
    if x == 0.0 {
        return "0".into();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let sci = format!("{:e}", x.abs());
    let (mantissa, exponent) = sci.split_once('e').expect("{:e} always writes an exponent");
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().expect("{:e} writes an integer exponent") + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e = if e >= 0 { format!("+{e}") } else { e.to_string() };
        if k == 1 { format!("{digits}e{e}") } else { format!("{}.{}e{e}", &digits[..1], &digits[1..]) }
    };
    format!("{sign}{body}")
}

#[test]
fn numbers_are_spelled_as_javascript_spells_them() {
    let cases = [
        (5.0, "5"),
        (-0.0, "0"),
        (0.1, "0.1"),
        (1.5, "1.5"),
        (123456.789, "123456.789"),
        (1e21, "1e+21"),
        (1.5e21, "1.5e+21"),
        (1e20, "100000000000000000000"),
        (0.000001, "0.000001"),
        (0.0000001, "1e-7"),
        (-2.5e-8, "-2.5e-8"),
    ];
    for (x, js) in cases {
        assert_eq!(js_number(x), js, "{x}");
    }
}

#[test]
fn canonical_sorts_keys_and_escapes_as_json_stringify_does() {
    let value = serde_json::json!({ "b": [1, 2.0, "x\u{1}\"\n"], "a": { "z": null, "y": true } });
    assert_eq!(canonical(&value), r#"{"a":{"y":true,"z":null},"b":[1,2,"x\u0001\"\n"]}"#);
}
