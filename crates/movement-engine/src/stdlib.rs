//! The built-in functions (packages/movement-lang/expression/stdlib.ts and
//! the flat set in apps/api/src/services/movement_engine/expression.ts's
//! `applyMovementFunction`), argument for argument and quirk for quirk.
//!
//! What JavaScript's runtime knows — the zone database, WHATWG URLs,
//! Unicode normalisation — the members ask of `EnvServices`; the run's
//! pinned instant (`DATE.TODAY`'s now) comes with them in `Surroundings`.

use crate::env_services::{EnvServices, NormalForm};
use crate::eval::EvalError;
use crate::js::{self, Js, JsObject};
use crate::js_date::{self, Parsed};
use crate::js_regex::{Regex, RegexError};

/// The 17 flat built-ins `applyMovementFunction` runs (`coalesce` is the
/// evaluator's, being branch selection), and the namespaced members.
pub const FLAT: [&str; 17] = [
    "isnull", "coalesce", "trim", "lower", "upper", "length", "abs", "round", "floor", "ceil", "tostring", "tonumber",
    "multi", "split", "date", "datetime", "number",
];

pub const NAMESPACED: [&str; 15] = [
    "currency.get_number_from_figure",
    "currency.get_code_from_figure",
    "currency.format_figure",
    "date.parse",
    "date.add_days",
    "date.format",
    "date.format_iso",
    "date.today",
    "datetime.at",
    "text.regex_extract",
    "text.slug",
    "text.pairs",
    "text.serialise",
    "url.host",
    "number.format",
];

/// Which argument a member reads specially: `TEXT.PAIRS`'s record, and
/// `TEXT.SERIALISE`'s whole value.
pub fn record_arg(id: &str) -> Option<usize> {
    (id == "text.pairs").then_some(0)
}

pub fn whole_value_arg(id: &str) -> Option<usize> {
    (id == "text.serialise").then_some(0)
}

/// What a member reads beyond its arguments: the environment's services,
/// and the run's pinned instant (milliseconds), which only `DATE.TODAY`
/// reads.
#[derive(Clone, Copy)]
pub struct Surroundings<'a> {
    pub services: &'a dyn EnvServices,
    pub now: Option<f64>,
}

fn arg(args: &[Js], i: usize) -> Js {
    args.get(i).cloned().unwrap_or(Js::Undefined)
}

/// `applyMovementFunction`.
pub fn apply_flat(id: &str, args: &[Js]) -> Result<Js, EvalError> {
    let a = arg(args, 0);
    let text_or_null = |f: fn(&str) -> String| if a.is_nullish() { Js::Null } else { Js::String(f(&a.to_js_string())) };
    Ok(match id {
        "isnull" => Js::Bool(a.is_nullish()),
        "trim" => text_or_null(|s| js::trim(s).to_string()),
        // Rust's case mappings are Unicode's, with JavaScript's special
        // casings (ß → SS, the final sigma).
        "lower" => text_or_null(js::to_lower_case),
        "upper" => text_or_null(js::to_upper_case),
        "length" => match &a {
            Js::Undefined | Js::Null => Js::Number(0.0),
            Js::Array(list) => Js::Number(list.items().len() as f64),
            other => Js::Number(js::utf16_len(&other.to_js_string()) as f64),
        },
        "abs" => Js::Number(a.to_number().abs()),
        "round" => Js::Number(js::math_round(a.to_number())),
        "floor" => Js::Number(a.to_number().floor()),
        "ceil" => Js::Number(a.to_number().ceil()),
        "tostring" => if a.is_nullish() { Js::Null } else { Js::String(a.to_js_string()) },
        "tonumber" => {
            let n = a.to_number();
            if n.is_nan() { Js::Null } else { Js::Number(n) }
        }
        "date" => coerce_to_date(&a)?.map_or(Js::Null, Js::String),
        "datetime" => coerce_to_datetime(&a)?.map_or(Js::Null, |(iso, _)| Js::String(iso)),
        "number" => coerce_to_number(&a).map_or(Js::Null, Js::Number),
        "multi" => {
            let mut flat = Vec::new();
            for v in args {
                match v {
                    Js::Undefined | Js::Null => {}
                    Js::Array(list) => flat.extend(list.items().iter().filter(|x| !x.is_nullish()).cloned()),
                    other => flat.push(other.clone()),
                }
            }
            Js::array(flat)
        }
        "split" => {
            if a.is_nullish() {
                return Ok(Js::array(vec![]));
            }
            let separator = arg(args, 1);
            let separator = if separator.is_nullish() { ",".to_string() } else { separator.to_js_string() };
            let text = a.to_js_string();
            if separator.is_empty() && !js::is_bmp(&text) {
                return Err(EvalError::Fallback("splitting astral characters into UTF-16 halves".into()));
            }
            let parts: Vec<String> = if separator.is_empty() {
                text.chars().map(String::from).collect()
            } else {
                text.split(separator.as_str()).map(String::from).collect()
            };
            Js::array(parts.iter().map(|p| js::trim(p)).filter(|p| !p.is_empty()).map(Js::str).collect())
        }
        other => return Err(EvalError::engine("MOVENG_RUNTIME", format!("unknown built-in function: {other}"))),
    })
}

/// One namespaced member.
pub fn apply_namespaced(id: &str, args: &[Js], around: Surroundings<'_>) -> Result<Js, EvalError> {
    let a = arg(args, 0);
    let b = arg(args, 1);
    match id {
        "currency.get_number_from_figure" => Ok(figure_number(&a)),
        "currency.get_code_from_figure" => Ok(figure_code(&a)),
        "currency.format_figure" => Ok(format_figure(&a, &b)),
        "date.parse" => Ok(read_date_parts(&a).map_or(Js::Null, |p| Js::String(iso_date(p)))),
        "date.add_days" => date_add_days(&a, &b),
        "date.format" => date_format(&a, &b),
        "date.format_iso" => Ok(date_format_iso(&a)?.map_or(Js::Null, |(iso, _)| Js::String(iso))),
        "date.today" => date_today(&a, around),
        "datetime.at" => datetime_at(args, around.services),
        "text.regex_extract" => text_regex_extract(args),
        "text.slug" => text_slug(&a, around.services),
        "text.pairs" => Ok(text_pairs(&a, &b)),
        "text.serialise" => text_serialise(&a, &b),
        "url.host" => url_host(&a, around.services),
        "number.format" => Ok(number_format(&a, &b)),
        other => Err(EvalError::Fallback(format!("{other} is not a member this engine runs"))),
    }
}

// ── CURRENCY ─────────────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS: [(&str, &str); 5] = [("£", "GBP"), ("€", "EUR"), ("¥", "JPY"), ("₹", "INR"), ("$", "USD")];

const CURRENCY_CODES: [&str; 23] = [
    "USD", "GBP", "EUR", "JPY", "CNY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK", "INR", "SGD", "HKD", "KRW", "BRL",
    "MXN", "ZAR", "PLN", "AED", "ILS", "TRY",
];

/// `MAGNITUDE_SUFFIXES[suffix] ?? 1`, prototype and all: the table is an
/// object literal, so `constructor` finds `Object` and multiplies to NaN.
fn magnitude(suffix: &str) -> f64 {
    match suffix {
        "k" | "thousand" => 1e3,
        "m" | "mm" | "mn" | "million" => 1e6,
        "b" | "bn" | "billion" => 1e9,
        "t" | "tn" | "trillion" => 1e12,
        "constructor" => f64::NAN,
        _ => 1.0,
    }
}

/// `/(\d[\d,]*(?:\.\d+)?)\s*([A-Za-z]+)?/.exec(text)`: the number's text and
/// the word stuck to it.
fn figure_match(text: &str) -> Option<(String, Option<String>)> {
    let chars: Vec<char> = text.chars().collect();
    let start = chars.iter().position(char::is_ascii_digit)?;
    let mut at = start + 1;
    while at < chars.len() && (chars[at].is_ascii_digit() || chars[at] == ',') {
        at += 1;
    }
    if chars.get(at) == Some(&'.') && chars.get(at + 1).is_some_and(char::is_ascii_digit) {
        at += 1;
        while at < chars.len() && chars[at].is_ascii_digit() {
            at += 1;
        }
    }
    let number: String = chars[start..at].iter().collect();
    // `\s` is UTF-16 based, but every JavaScript space is a BMP character.
    while at < chars.len() && js::is_js_space(chars[at]) {
        at += 1;
    }
    let word_end = chars[at..].iter().position(|c| !c.is_ascii_alphabetic()).map_or(chars.len(), |n| at + n);
    let word = (word_end > at).then(|| chars[at..word_end].iter().collect());
    Some((number, word))
}

fn figure_number(figure: &Js) -> Js {
    match figure {
        Js::Undefined | Js::Null => Js::Null,
        Js::Number(_) => figure.clone(),
        other => {
            let Some((number, suffix)) = figure_match(&other.to_js_string()) else { return Js::Null };
            let base = js::string_to_number(&number.replace(',', ""));
            if !base.is_finite() {
                return Js::Null;
            }
            Js::Number(base * suffix.map_or(1.0, |s| magnitude(&js::to_lower_case(&s))))
        }
    }
}

fn figure_code(figure: &Js) -> Js {
    if figure.is_nullish() {
        return Js::Null;
    }
    let text = figure.to_js_string();
    for (symbol, code) in CURRENCY_SYMBOLS {
        if text.contains(symbol) {
            return Js::str(code);
        }
    }
    // `text.match(/[A-Za-z]{3}/g)`: three letters at a time, left to right.
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i + 3 <= chars.len() {
        if chars[i..i + 3].iter().all(char::is_ascii_alphabetic) {
            let word: String = chars[i..i + 3].iter().collect::<String>().to_ascii_uppercase();
            if CURRENCY_CODES.contains(&word.as_str()) {
                return Js::String(word);
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    Js::Null
}

const COMPACT_TIERS: [(f64, &str); 4] = [(1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")];

fn compact_magnitude(abs: f64) -> String {
    let Some((threshold, suffix)) = COMPACT_TIERS.iter().find(|(t, _)| abs >= *t) else {
        return js::number_to_string(abs);
    };
    let scaled = js::math_round((abs / threshold) * 10.0) / 10.0;
    let digits = if js::is_integer(scaled) { js::number_to_string(scaled) } else { js::to_fixed(scaled, 1) };
    format!("{digits}{suffix}")
}

/// `\B(?=(\d{3})+(?!\d))` → `,`: a comma wherever a run of digits whose
/// length is a multiple of three runs to the end of the digits, and the
/// position is not a word boundary.
fn group_thousands(int: &str) -> String {
    let chars: Vec<char> = int.chars().collect();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if i > 0 {
            let boundary = word(chars[i - 1]) != word(c);
            let run = chars[i..].iter().take_while(|d| d.is_ascii_digit()).count();
            if !boundary && run >= 3 && run % 3 == 0 {
                out.push(',');
            }
        }
        out.push(c);
    }
    out
}

fn grouped_magnitude(abs: f64) -> String {
    let rounded = js::math_round(abs * 100.0) / 100.0;
    let text = js::number_to_string(rounded);
    match text.split_once('.') {
        Some((int, frac)) => format!("{}.{frac}", group_thousands(int)),
        None => group_thousands(&text),
    }
}

/// `coerceToNumber`: a finite number, or null.
pub fn coerce_to_number(value: &Js) -> Option<f64> {
    match value {
        Js::Undefined | Js::Null => None,
        Js::Number(n) => n.is_finite().then_some(*n),
        other => {
            let text = other.to_js_string();
            let trimmed = js::trim(&text);
            let n = js::string_to_number(trimmed);
            (n.is_finite() && !trimmed.is_empty()).then_some(n)
        }
    }
}

fn number_format(value: &Js, style: &Js) -> Js {
    let Some(n) = coerce_to_number(value) else { return Js::Null };
    let sign = if n < 0.0 { "-" } else { "" };
    match style {
        Js::String(s) if s == "compact" => Js::String(format!("{sign}{}", compact_magnitude(n.abs()))),
        Js::String(s) if s == "grouped" => Js::String(format!("{sign}{}", grouped_magnitude(n.abs()))),
        _ => Js::Null,
    }
}

fn format_figure(value: &Js, code: &Js) -> Js {
    let Some(n) = coerce_to_number(value) else { return Js::Null };
    let sign = if n < 0.0 { "-" } else { "" };
    let amount = compact_magnitude(n.abs());
    let code = if code.is_nullish() { String::new() } else { js::to_upper_case(js::trim(&code.to_js_string())) };
    if code.is_empty() {
        return Js::String(format!("{sign}{amount}"));
    }
    if let Some((symbol, _)) = CURRENCY_SYMBOLS.iter().find(|(_, c)| *c == code) {
        return Js::String(format!("{sign}{symbol}{amount}"));
    }
    if CURRENCY_CODES.contains(&code.as_str()) {
        return Js::String(format!("{sign}{amount} {code}"));
    }
    Js::String(format!("{sign}{amount}"))
}

// ── DATE ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DateParts {
    y: i64,
    m: i64,
    d: i64,
}

fn month_number(name: &str) -> Option<i64> {
    Some(match name.to_ascii_lowercase().as_str() {
        "jan" | "january" => 1,
        "feb" | "february" => 2,
        "mar" | "march" => 3,
        "apr" | "april" => 4,
        "may" => 5,
        "jun" | "june" => 6,
        "jul" | "july" => 7,
        "aug" | "august" => 8,
        "sep" | "sept" | "september" => 9,
        "oct" | "october" => 10,
        "nov" | "november" => 11,
        "dec" | "december" => 12,
        // `MONTH_NAMES.constructor` is `Object`: found, and not a month, so
        // `validParts` refuses it exactly as it refuses no month at all.
        _ => return None,
    })
}

/// `validParts`: the round trip through `Date.UTC`. A year below 100 fails
/// it, because `Date.UTC` reads 0–99 as 1900–1999.
fn valid_parts(y: i64, m: i64, d: i64) -> Option<DateParts> {
    ((100..=9999).contains(&y) && (1..=12).contains(&m) && d >= 1 && d <= js_date::days_in_month(y, m))
        .then_some(DateParts { y, m, d })
}

fn iso_date(p: DateParts) -> String {
    format!("{}-{:02}-{:02}", p.y, p.m, p.d)
}

/// A run of ASCII digits at `at`, its value and where it ends.
fn digits_at(c: &[char], at: usize) -> (usize, i64) {
    let len = c[at.min(c.len())..].iter().take_while(|d| d.is_ascii_digit()).count();
    let value = c[at..at + len].iter().fold(0i64, |acc, d| acc.saturating_mul(10).saturating_add(i64::from(*d as u8 - b'0')));
    (at + len, value)
}

fn spaces_at(c: &[char], at: usize) -> usize {
    at + c[at.min(c.len())..].iter().take_while(|&&ch| js::is_js_space(ch)).count()
}

fn letters_at(c: &[char], at: usize) -> usize {
    at + c[at.min(c.len())..].iter().take_while(|ch| ch.is_ascii_alphabetic()).count()
}

/// `(?:st|nd|rd|th)?` then `\s+`... as the regex backtracks: the suffix is
/// taken only where whitespace follows it.
fn ordinal_suffix(c: &[char], at: usize) -> usize {
    let two: String = c.get(at..at + 2).map(|s| s.iter().collect()).unwrap_or_default();
    if matches!(two.as_str(), "st" | "nd" | "rd" | "th") { at + 2 } else { at }
}

/// `readDateParts`: ISO, `2026/03/12`, `12 March 2026`, `March 12, 2026`.
fn read_date_parts(value: &Js) -> Option<DateParts> {
    if value.is_nullish() {
        return None;
    }
    let text = value.to_js_string();
    let c: Vec<char> = js::trim(&text).chars().collect();
    // ^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$  (`.` stops at a line end)
    // ^(\d{4})\/(\d{1,2})\/(\d{1,2})$
    for separator in ['-', '/'] {
        let (at, y) = digits_at(&c, 0);
        if at != 4 || c.get(4) != Some(&separator) {
            continue;
        }
        let (at, m) = digits_at(&c, 5);
        if !(6..=7).contains(&at) || c.get(at) != Some(&separator) {
            continue;
        }
        let (end, d) = digits_at(&c, at + 1);
        if !(1..=2).contains(&(end - at - 1)) {
            continue;
        }
        let rest = &c[end..];
        let tail_ok = rest.is_empty()
            || (separator == '-'
                && (rest[0] == 'T' || js::is_js_space(rest[0]))
                && !rest[1..].iter().any(|&ch| matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')));
        if tail_ok {
            return valid_parts(y, m, d);
        }
    }
    // ^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})$
    let (at, day) = digits_at(&c, 0);
    if (1..=2).contains(&at) {
        let after_suffix = ordinal_suffix(&c, at);
        for from in [after_suffix, at] {
            let spaced = spaces_at(&c, from);
            if spaced == from {
                continue;
            }
            let word_end = letters_at(&c, spaced);
            if word_end == spaced {
                continue;
            }
            if let Some(year) = year_tail(&c, word_end) {
                let month: String = c[spaced..word_end].iter().collect();
                return month_number(&month).and_then(|m| valid_parts(year, m, day));
            }
        }
    }
    // ^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$
    let word_end = letters_at(&c, 0);
    if word_end > 0 {
        let spaced = spaces_at(&c, word_end);
        let (at, day) = digits_at(&c, spaced);
        if spaced > word_end && (1..=2).contains(&(at - spaced)) {
            for from in [ordinal_suffix(&c, at), at] {
                if let Some(year) = year_tail(&c, from) {
                    let month: String = c[..word_end].iter().collect();
                    return month_number(&month).and_then(|m| valid_parts(year, m, day));
                }
            }
        }
    }
    None
}

/// `,?\s+(\d{4})$` from `at`.
fn year_tail(c: &[char], at: usize) -> Option<i64> {
    let at = if c.get(at) == Some(&',') { at + 1 } else { at };
    let spaced = spaces_at(c, at);
    if spaced == at {
        return None;
    }
    let (end, year) = digits_at(c, spaced);
    (end - spaced == 4 && end == c.len()).then_some(year)
}

/// `dateFormatIso`: any readable date, timestamp or epoch as an ISO
/// instant, with its milliseconds.
fn date_format_iso(value: &Js) -> Result<Option<(String, f64)>, EvalError> {
    let instant = |ms: f64| (js_date::to_iso_string(ms), ms);
    match value {
        Js::Undefined | Js::Null => Ok(None),
        Js::Number(n) => Ok(js_date::time_clip(*n).map(instant)),
        other => {
            let text = other.to_js_string();
            let s = js::trim(&text);
            let b = s.as_bytes();
            let looks_iso = b.len() > 10
                && b[..4].iter().all(u8::is_ascii_digit)
                && b[4] == b'-'
                && b[5..7].iter().all(u8::is_ascii_digit)
                && b[7] == b'-'
                && b[8..10].iter().all(u8::is_ascii_digit)
                && b[10] == b'T';
            if looks_iso {
                return match js_date::parse(s) {
                    Parsed::Valid(ms) => Ok(Some(instant(ms))),
                    Parsed::Invalid => Ok(None),
                    Parsed::Unknown => Err(EvalError::Fallback(format!("V8 reads {s:?} its own way"))),
                };
            }
            Ok(read_date_parts(&Js::str(s)).map(|p| instant(js_date::utc_midnight(p.y, p.m, p.d))))
        }
    }
}

pub fn coerce_to_datetime(value: &Js) -> Result<Option<(String, f64)>, EvalError> {
    date_format_iso(value)
}

pub fn coerce_to_date(value: &Js) -> Result<Option<String>, EvalError> {
    Ok(coerce_to_datetime(value)?.map(|(iso, _)| iso.chars().take(10).collect()))
}

fn date_add_days(date: &Js, days: &Js) -> Result<Js, EvalError> {
    let Some(parts) = read_date_parts(date) else { return Ok(Js::Null) };
    let days = days.to_number();
    if !days.is_finite() {
        return Ok(Js::Null);
    }
    let epoch = js_date::utc_midnight(parts.y, parts.m, parts.d) + days.trunc() * js_date::MS_PER_DAY;
    match js_date::time_clip(epoch) {
        Some(ms) => Ok(Js::String(js_date::to_iso_string(ms).chars().take(10).collect())),
        None => Err(EvalError::Thrown { class: crate::eval::ErrorClass::RangeError, message: "Invalid time value".into() }),
    }
}

const DATE_FORMAT_TOKENS: [&str; 16] =
    ["YYYY", "YY", "MMMM", "MMM", "MM", "M", "DD", "D", "dddd", "ddd", "HH", "H", "mm", "m", "ss", "s"];
const MONTH_FULL: [&str; 12] =
    ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAY_FULL: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

enum Piece {
    Token(String),
    Literal(String),
}

/// `readDateFormat`: letter runs split where the letter changes, each a
/// token; everything else literal. `None` when a run is not a token.
fn read_date_format(pattern: &str) -> Option<Vec<Piece>> {
    let mut pieces = Vec::new();
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let letters = chars[i].is_ascii_alphabetic();
        let end = chars[i..].iter().position(|c| c.is_ascii_alphabetic() != letters).map_or(chars.len(), |n| i + n);
        if !letters {
            pieces.push(Piece::Literal(chars[i..end].iter().collect()));
        } else {
            let mut runs = Vec::new();
            let mut j = i;
            while j < end {
                let run_end = chars[j..end].iter().position(|&c| c != chars[j]).map_or(end, |n| j + n);
                runs.push(chars[j..run_end].iter().collect::<String>());
                j = run_end;
            }
            if !runs.iter().all(|run| DATE_FORMAT_TOKENS.contains(&run.as_str())) {
                return None;
            }
            pieces.extend(runs.into_iter().map(Piece::Token));
        }
        i = end;
    }
    Some(pieces)
}

/// `String(value).padStart(width, '0')`: on the text, so `-5` pads to `00-5`.
fn pad(value: i64, width: usize) -> String {
    let text = value.to_string();
    format!("{}{text}", "0".repeat(width.saturating_sub(text.len())))
}

fn date_format(value: &Js, pattern: &Js) -> Result<Js, EvalError> {
    let Some((_, ms)) = coerce_to_datetime(value)? else { return Ok(Js::Null) };
    if pattern.is_nullish() {
        return Ok(Js::Null);
    }
    let Some(pieces) = read_date_format(&pattern.to_js_string()) else { return Ok(Js::Null) };
    let f = js_date::utc_fields(ms);
    let mut out = String::new();
    for piece in pieces {
        match piece {
            Piece::Literal(text) => out.push_str(&text),
            Piece::Token(token) => out.push_str(&match token.as_str() {
                "YYYY" => pad(f.year, 4),
                // `%` keeps the dividend's sign, as JavaScript's does.
                "YY" => pad(f.year % 100, 2),
                "MMMM" => MONTH_FULL[f.month as usize].to_string(),
                "MMM" => MONTH_FULL[f.month as usize][..3].to_string(),
                "MM" => pad(f.month + 1, 2),
                "M" => (f.month + 1).to_string(),
                "DD" => pad(f.day, 2),
                "D" => f.day.to_string(),
                "dddd" => WEEKDAY_FULL[f.weekday as usize].to_string(),
                "ddd" => WEEKDAY_FULL[f.weekday as usize][..3].to_string(),
                "HH" => pad(f.hours, 2),
                "H" => f.hours.to_string(),
                "mm" => pad(f.minutes, 2),
                "m" => f.minutes.to_string(),
                "ss" => pad(f.seconds, 2),
                "s" => f.seconds.to_string(),
                other => unreachable!("{other} passed the token check"),
            }),
        }
    }
    Ok(Js::String(out))
}

// ── TEXT ─────────────────────────────────────────────────────────────────────

fn text_regex_extract(args: &[Js]) -> Result<Js, EvalError> {
    let (text, pattern, group) = (arg(args, 0), arg(args, 1), arg(args, 2));
    if text.is_nullish() || pattern.is_nullish() {
        return Ok(Js::Null);
    }
    let regex = match Regex::new(&pattern.to_js_string()) {
        Ok(regex) => regex,
        Err(RegexError::Syntax) => return Ok(Js::Null),
        Err(RegexError::Unsupported(what)) => return Err(EvalError::Fallback(what)),
    };
    let Some(groups) = regex.exec(&text.to_js_string()) else { return Ok(Js::Null) };
    let index = if args.len() > 2 { group.to_number() } else if groups.len() > 1 { 1.0 } else { 0.0 };
    if !js::is_integer(index) || index < 0.0 || index >= groups.len() as f64 {
        return Ok(Js::Null);
    }
    match &groups[index as usize] {
        None => Ok(Js::Null),
        Some(units) => String::from_utf16(units)
            .map(Js::String)
            .map_err(|_| EvalError::Fallback("a match that splits an astral character".into())),
    }
}

/// `TEXT.SLUG`: `normalize('NFKD')`, the combining diacriticals
/// (U+0300–U+036F) dropped, lower-cased, each run of anything but `a-z0-9`
/// one dash, and none at either end.
fn text_slug(value: &Js, services: &dyn EnvServices) -> Result<Js, EvalError> {
    if value.is_nullish() {
        return Ok(Js::Null);
    }
    let text = value.to_js_string();
    let decomposed = if text.is_ascii() { text } else { services.normalize(&text, NormalForm::Nfkd) };
    let bare: String = decomposed.chars().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect();
    let mut slug = String::new();
    let mut gap = false;
    for c in js::to_lower_case(&bare).chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !slug.is_empty() {
                slug.push('-');
            }
            gap = false;
            slug.push(c);
        } else {
            gap = true;
        }
    }
    Ok(Js::String(slug))
}

fn text_pairs(record: &Js, separator: &Js) -> Js {
    let Js::Object(record) = record else { return Js::Null };
    let separator = match separator {
        Js::String(s) => s.as_str(),
        _ => " | ",
    };
    let parts: Vec<String> = record
        .entries()
        .iter()
        // A nested node or edge (an object or list) is skipped, not printed.
        .filter(|(_, v)| !matches!(v, Js::Array(_) | Js::Object(_)))
        .map(|(k, v)| format!("{k}={}", if v.is_nullish() { String::new() } else { v.to_js_string() }))
        .collect();
    Js::String(parts.join(separator))
}

/// `toStableJson`: keys sorted by UTF-16 code unit (and then laid out as an
/// object lays them out: index keys first), `-0` as `0`, non-finite numbers
/// and absence as null, a `FileRef` as its descriptor.
fn to_stable_json(value: &Js) -> Js {
    match value {
        Js::Undefined | Js::Null | Js::Function(_) => Js::Null,
        // Read down to its fields first (`plainValueOf`).
        Js::Record(_) => Js::object(JsObject::new()),
        Js::Bool(_) | Js::String(_) => value.clone(),
        Js::Number(n) => if n.is_finite() { Js::Number(*n + 0.0) } else { Js::Null },
        Js::Array(list) => Js::array(list.items().iter().map(to_stable_json).collect()),
        Js::Object(object) => {
            let mut out = JsObject::new();
            if matches!(object.get("__brand"), Some(Js::String(brand)) if brand == "FileRef") {
                for key in ["contentType", "kind", "name", "size"] {
                    let field = if key == "kind" { Js::str("file") } else { object.get(key).map_or(Js::Null, to_stable_json) };
                    out.set(key.into(), field);
                }
                return Js::object(out);
            }
            let mut entries: Vec<&(String, Js)> = object.entries().iter().collect();
            entries.sort_by(|(a, _), (b, _)| js::utf16_cmp(a, b));
            for (key, item) in entries {
                out.set(key.clone(), to_stable_json(item));
            }
            Js::object(out)
        }
    }
}

fn text_serialise(value: &Js, format: &Js) -> Result<Js, EvalError> {
    match format {
        // `toStableJson` recurses through a value that holds itself until
        // V8's stack runs out.
        Js::String(f) if f == "JSON" && js::holds_itself(value) => {
            Err(EvalError::Thrown { class: crate::eval::ErrorClass::RangeError, message: js::stack_overflow().message })
        }
        Js::String(f) if f == "JSON" => Ok(Js::String(js::json_stringify(&to_stable_json(value), 2))),
        // `JSON.stringify(format)`, which is `undefined` for `undefined`.
        Js::Undefined => Err(EvalError::error("TEXT.SERIALISE: unknown format undefined".to_string())),
        other => Err(EvalError::error(format!("TEXT.SERIALISE: unknown format {}", js::json_stringify(other, 0)))),
    }
}

// ── URL ──────────────────────────────────────────────────────────────────────

/// `URL.HOST`: the `hostname` WHATWG URL parsing finds (`new URL`, asked of
/// the environment), after the TypeScript's own reading of what to parse.
fn url_host(value: &Js, services: &dyn EnvServices) -> Result<Js, EvalError> {
    if value.is_nullish() {
        return Ok(Js::Null);
    }
    let text = value.to_js_string();
    let raw = js::trim(&text);
    if raw.is_empty() {
        return Ok(Js::Null);
    }
    // A scheme-less address parses under an assumed `http://`; a relative
    // path or an opaque uri has no host either way.
    let attempt = if raw.contains("://") {
        raw.to_string()
    } else if raw.starts_with('/') || is_opaque_uri(raw) {
        return Ok(Js::Null);
    } else {
        format!("http://{raw}")
    };
    // No host (`file:///x`), or userinfo: `joe@acme.com` is an email.
    Ok(match services.url_parse(&attempt) {
        Some(url) if !url.hostname.is_empty() && url.username.is_empty() => Js::String(url.hostname),
        _ => Js::Null,
    })
}

/// `/^[a-zA-Z][a-zA-Z0-9+-]*:(?!\/\/)/`
fn is_opaque_uri(raw: &str) -> bool {
    let b = raw.as_bytes();
    if !b.first().is_some_and(u8::is_ascii_alphabetic) {
        return false;
    }
    let end = 1 + b[1..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == b'+' || **c == b'-').count();
    b.get(end) == Some(&b':') && !raw[end + 1..].starts_with("//")
}

// ── DATE.TODAY and DATETIME.AT (packages/shared/timezone) ───────────────────

/// cron's `cronTimezoneError`: `Intl` refuses the zone.
fn zone_problem(zone: &str, services: &dyn EnvServices) -> Option<String> {
    (zone.is_empty() || services.tz_convert("1970-01-01T00:00:00.000Z", zone).is_none()).then(|| {
        format!("'{zone}' is not a recognised IANA time zone (e.g. \"Europe/London\", \"America/New_York\", \"UTC\")")
    })
}

/// `Date.UTC(year, month - 1, day, hour, minute, second)`, two-digit years
/// read as 19xx as it reads them.
fn date_utc(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64) -> f64 {
    let year = if (0..=99).contains(&year) { 1900 + year } else { year };
    (js_date::days_from_civil(year, month, day) * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000) as f64
}

/// `wallAsUTC(localFields(instant, zone))`: the instant's wall reading in
/// `zone`, as a UTC epoch.
fn wall_as_utc(instant: f64, zone: &str, services: &dyn EnvServices) -> f64 {
    let f = services
        .tz_convert(&js_date::to_iso_string(instant), zone)
        .unwrap_or_else(|| panic!("{zone} was a zone a moment ago"));
    date_utc(f.year, f.month, f.day, f.hour, f.minute, f.second)
}

/// `DATE.TODAY(zone)`: the calendar date the run's pinned instant falls on
/// in `zone` (`zonedDateString`).
fn date_today(zone: &Js, around: Surroundings<'_>) -> Result<Js, EvalError> {
    if zone.is_nullish() {
        return Ok(Js::Null);
    }
    let zone = zone.to_js_string();
    if let Some(problem) = zone_problem(&zone, around.services) {
        return Err(EvalError::error(format!("DATE.TODAY(zone) — {problem}")));
    }
    let now = around.now.ok_or_else(|| EvalError::error("DATE.TODAY(zone) was evaluated with no pinned instant".into()))?;
    let f = around.services.tz_convert(&js_date::to_iso_string(now), &zone).expect("a zone just accepted");
    Ok(Js::String(format!("{}-{:02}-{:02}", f.year, f.month, f.day)))
}

/// `DATETIME.AT(date, time, zone)`: `instantAtZonedWallTime`, answered
/// through the zone's wall readings alone, as the TypeScript does.
fn datetime_at(args: &[Js], services: &dyn EnvServices) -> Result<Js, EvalError> {
    let (date, time, zone) = (arg(args, 0), arg(args, 1), arg(args, 2));
    if date.is_nullish() || time.is_nullish() || zone.is_nullish() {
        return Ok(Js::Null);
    }
    let Some(parts) = read_date_parts(&date) else {
        return Err(EvalError::error(format!(
            "DATETIME.AT(date, time, zone) — '{}' is not a calendar date. Its first argument is a day: DATE.TODAY(zone), a date field, DATE.ADD_DAYS(…) or DATE.PARSE(text).",
            date.to_js_string()
        )));
    };
    let time = time.to_js_string();
    let Some((hour, minute)) = read_wall_clock_time(&time) else {
        return Err(EvalError::error(format!(
            "DATETIME.AT(date, time, zone) — '{time}' is not a time of day — write it as 24-hour HH:mm (e.g. \"07:00\", \"18:30\")"
        )));
    };
    let zone = zone.to_js_string();
    if let Some(problem) = zone_problem(&zone, services) {
        return Err(EvalError::error(format!("DATETIME.AT(date, time, zone) — {problem}")));
    }
    let wanted = date_utc(parts.y, parts.m, parts.d, hour, minute, 0);
    let offset = |instant: f64| wall_as_utc(instant, &zone, services) - instant;
    let seed = wanted - offset(wanted);
    // A day either side straddles any one transition, so both offsets are
    // seen; an ambiguous reading takes the earlier instant.
    let guesses: Vec<f64> = [-86_400_000.0, 0.0, 86_400_000.0].iter().map(|d| wanted - offset(seed + d)).collect();
    let real = guesses.iter().copied().filter(|g| wall_as_utc(*g, &zone, services) == wanted).reduce(f64::min);
    let instant = match real {
        Some(instant) => instant,
        // A reading the clock skips: the first instant at or after it.
        None => {
            const SPAN: f64 = 26.0 * 3_600_000.0;
            let mut before = guesses.iter().copied().reduce(f64::min).unwrap() - SPAN;
            let mut after = guesses.iter().copied().reduce(f64::max).unwrap() + SPAN;
            while after - before > 1.0 {
                let mid = before + ((after - before) / 2.0).floor();
                if wall_as_utc(mid, &zone, services) >= wanted { after = mid } else { before = mid }
            }
            after
        }
    };
    js_date::time_clip(instant)
        .map(|ms| Js::String(js_date::to_iso_string(ms)))
        .ok_or_else(|| EvalError::Thrown { class: crate::eval::ErrorClass::RangeError, message: "Invalid time value".into() })
}

/// `readWallClockTime`: `/^([01]\d|2[0-3]):([0-5]\d)$/` on the trimmed text.
fn read_wall_clock_time(time: &str) -> Option<(i64, i64)> {
    let t = js::trim(time).as_bytes();
    let digit = |b: u8| b.is_ascii_digit().then(|| i64::from(b - b'0'));
    let [h1, h2, b':', m1, m2] = t else { return None };
    let (hour, minute) = (digit(*h1)? * 10 + digit(*h2)?, digit(*m1)? * 10 + digit(*m2)?);
    (hour <= 23 && minute <= 59).then_some((hour, minute))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn around() -> Surroundings<'static> {
        Surroundings { services: crate::env_services::current(), now: Some(0.0) }
    }

    fn call(id: &str, args: Vec<Js>) -> Js {
        let result = if FLAT.contains(&id) { apply_flat(id, &args) } else { apply_namespaced(id, &args, around()) };
        result.unwrap_or_else(|e| panic!("{id}: {e:?}"))
    }

    fn text(value: Js) -> String {
        match value {
            Js::String(s) => s,
            Js::Null => "<null>".into(),
            other => format!("<{other:?}>"),
        }
    }

    fn s(t: &str) -> Js {
        Js::str(t)
    }

    #[test]
    fn number_format_and_currency() {
        let n = |x: f64, style: &str| text(call("number.format", vec![Js::Number(x), s(style)]));
        assert_eq!(n(1_200_000.0, "compact"), "1.2M");
        assert_eq!(n(350_000.0, "compact"), "350K");
        assert_eq!(n(2_100_000_000.0, "compact"), "2.1B");
        assert_eq!(n(999.0, "compact"), "999");
        assert_eq!(n(999_950.0, "compact"), "1000K");
        assert_eq!(n(-1_250.0, "compact"), "-1.3K");
        assert_eq!(n(1_200_000.0, "grouped"), "1,200,000");
        assert_eq!(n(1234.5, "grouped"), "1,234.5");
        assert_eq!(n(1234.567, "grouped"), "1,234.57");
        assert_eq!(n(1e21, "grouped"), "999,999,999,999,999,900,000");
        assert_eq!(n(1.0, "other"), "<null>");
        assert_eq!(text(call("number.format", vec![s(" 12 "), s("compact")])), "12");
        assert_eq!(text(call("number.format", vec![s(""), s("compact")])), "<null>");
        let fig = |x: f64, code: Js| text(call("currency.format_figure", vec![Js::Number(x), code]));
        assert_eq!(fig(1_200_000.0, s("EUR")), "€1.2M");
        assert_eq!(fig(350_000.0, s(" usd ")), "$350K");
        assert_eq!(fig(1_200_000.0, s("CHF")), "1.2M CHF");
        assert_eq!(fig(-5.0, Js::Null), "-5");
        assert_eq!(fig(5.0, s("XYZ")), "5");
    }

    #[test]
    fn figures_read_as_the_regex_reads_them() {
        let num = |t: &str| call("currency.get_number_from_figure", vec![s(t)]);
        assert!(matches!(num("£1.2m"), Js::Number(n) if n == 1_200_000.0));
        assert!(matches!(num("raised 3,500 thousand"), Js::Number(n) if n == 3_500_000.0));
        assert!(matches!(num("2 billion"), Js::Number(n) if n == 2e9));
        assert!(matches!(num("5 constructor"), Js::Number(n) if n.is_nan()));
        assert!(matches!(num("7 widgets"), Js::Number(n) if n == 7.0));
        assert!(matches!(num("1."), Js::Number(n) if n == 1.0));
        assert!(matches!(num("none"), Js::Null));
        let code = |t: &str| text(call("currency.get_code_from_figure", vec![s(t)]));
        assert_eq!(code("£1.2m"), "GBP");
        assert_eq!(code("12 chf"), "CHF");
        assert_eq!(code("abcusd"), "USD");
        assert_eq!(code("xusd"), "<null>");
    }

    #[test]
    fn dates_parse_add_and_format() {
        let parse = |t: &str| text(call("date.parse", vec![s(t)]));
        assert_eq!(parse("12 March 2026"), "2026-03-12");
        assert_eq!(parse("March 12, 2026"), "2026-03-12");
        assert_eq!(parse("1st  Feb 2026"), "2026-02-01");
        assert_eq!(parse("2026/3/9"), "2026-03-09");
        assert_eq!(parse("2026-03-12T09:30Z"), "2026-03-12");
        assert_eq!(parse("2026-03-12 anything"), "2026-03-12");
        assert_eq!(parse("2026-02-29"), "<null>");
        assert_eq!(parse("0099-01-01"), "<null>");
        assert_eq!(parse("12/03/2026"), "<null>");
        assert_eq!(parse("31 Smarch 2026"), "<null>");
        assert_eq!(parse("2026-03-12T\nx"), "<null>");
        let add = |t: &str, d: f64| text(call("date.add_days", vec![s(t), Js::Number(d)]));
        assert_eq!(add("2026-03-12", 7.0), "2026-03-19");
        assert_eq!(add("2026-03-12", -12.9), "2026-02-28");
        assert!(matches!(
            apply_namespaced("date.add_days", &[s("2026-03-12"), Js::Number(1e9)], around()),
            Err(EvalError::Thrown { message, .. }) if message == "Invalid time value"
        ));
        let fmt = |v: Js, p: &str| text(call("date.format", vec![v, s(p)]));
        assert_eq!(fmt(s("2026-08-31"), "MMMM D, YYYY"), "August 31, 2026");
        assert_eq!(fmt(s("2026-08-31T07:05:09Z"), "ddd DD/MM/YY HH:mm:ss H m s"), "Mon 31/08/26 07:05:09 7 5 9");
        assert_eq!(fmt(s("2026-08-31"), "Day"), "<null>");
        assert_eq!(fmt(s("2026-08-31"), ""), "");
        assert_eq!(fmt(Js::Number(0.0), "dddd YYYY"), "Thursday 1970");
        let iso = |v: Js| text(call("date.format_iso", vec![v]));
        assert_eq!(iso(s("12 March 2026")), "2026-03-12T00:00:00.000Z");
        assert_eq!(iso(s("2026-03-12T09:30+01:00")), "2026-03-12T08:30:00.000Z");
        assert_eq!(iso(Js::Number(8.64e15 + 1.0)), "<null>");
        assert!(matches!(apply_namespaced("date.format_iso", &[s("2026-03-12T09:30")], around()), Err(EvalError::Fallback(_))));
        assert_eq!(text(call("date", vec![s("2026-03-12T23:30-02:00")])), "2026-03-13");
        assert_eq!(text(call("datetime", vec![s("2026-03-12")])), "2026-03-12T00:00:00.000Z");
        assert_eq!(text(call("date", vec![Js::Bool(true)])), "<null>");
    }

    #[test]
    fn text_members() {
        let slug = |t: &str| text(call("text.slug", vec![s(t)]));
        assert_eq!(slug("Acme Corp Ltd."), "acme-corp-ltd");
        assert_eq!(slug("--Hello,  World!--"), "hello-world");
        assert_eq!(slug("!!!"), "");
        assert_eq!(slug("Café Ünïcode ﬁ ½"), "cafe-unicode-fi-1-2");
        assert_eq!(slug("ΣΑΣ"), "");
        let mut record = JsObject::new();
        record.set("name".into(), s("Acme"));
        record.set("n".into(), Js::Number(1.5));
        record.set("gone".into(), Js::Undefined);
        record.set("nested".into(), Js::object(JsObject::new()));
        record.set("flag".into(), Js::Bool(false));
        let record = Js::object(record);
        assert_eq!(text(call("text.pairs", vec![record.clone()])), "name=Acme | n=1.5 | gone= | flag=false");
        assert_eq!(text(call("text.pairs", vec![record.clone(), s(", ")])), "name=Acme, n=1.5, gone=, flag=false");
        assert_eq!(text(call("text.pairs", vec![s("x")])), "<null>");
        assert_eq!(
            text(call("text.serialise", vec![record, s("JSON")])),
            "{\n  \"flag\": false,\n  \"gone\": null,\n  \"n\": 1.5,\n  \"name\": \"Acme\",\n  \"nested\": {}\n}"
        );
        let mut keyed = JsObject::new();
        keyed.set("b".into(), Js::Number(-0.0));
        keyed.set("10".into(), Js::Number(f64::NAN));
        keyed.set("9".into(), Js::array(vec![Js::Undefined]));
        assert_eq!(
            text(call("text.serialise", vec![Js::object(keyed), s("JSON")])),
            "{\n  \"9\": [\n    null\n  ],\n  \"10\": null,\n  \"b\": 0\n}"
        );
        assert_eq!(text(call("text.serialise", vec![Js::Undefined, s("JSON")])), "null");
        assert!(matches!(
            apply_namespaced("text.serialise", &[Js::Null, s("YAML")], around()),
            Err(EvalError::Thrown { message, .. }) if message == "TEXT.SERIALISE: unknown format \"YAML\""
        ));
        let rx = |args: Vec<Js>| text(call("text.regex_extract", args));
        assert_eq!(rx(vec![s("ref ABC-123"), s(r"([A-Z]+)-(\d+)")]), "ABC");
        assert_eq!(rx(vec![s("ref ABC-123"), s(r"([A-Z]+)-(\d+)"), Js::Number(2.0)]), "123");
        assert_eq!(rx(vec![s("ref ABC-123"), s(r"[A-Z]+-\d+")]), "ABC-123");
        assert_eq!(rx(vec![s("x"), s("(")]), "<null>");
        assert_eq!(rx(vec![s("b"), s("(a)|b"), Js::Number(1.0)]), "<null>");
        assert_eq!(rx(vec![s("abc"), s("b"), Js::Null]), "b");
    }

    #[test]
    fn datetime_at_names_the_instant_on_the_zones_wall_clock() {
        let at = |d: &str, t: &str, z: &str| apply_namespaced("datetime.at", &[s(d), s(t), s(z)], around());
        let text_at = |d: &str, t: &str, z: &str| text(at(d, t, z).unwrap());
        assert_eq!(text_at("2026-06-15", "07:00", "Europe/Berlin"), "2026-06-15T05:00:00.000Z");
        // A fall-back reading happens twice: the earlier. A spring-forward
        // gap: the transition itself.
        assert_eq!(text_at("2026-10-25", "02:30", "Europe/Berlin"), "2026-10-25T00:30:00.000Z");
        assert_eq!(text_at("2026-03-29", "02:30", "Europe/Berlin"), "2026-03-29T01:00:00.000Z");
        assert_eq!(text_at("12 March 2026", " 23:59 ", "Pacific/Kiritimati"), "2026-03-12T09:59:00.000Z");
        assert!(matches!(at("2026-06-15", "7:00", "UTC"), Err(EvalError::Thrown { message, .. }) if message.contains("'7:00' is not a time of day")));
        assert!(matches!(at("someday", "07:00", "UTC"), Err(EvalError::Thrown { message, .. }) if message.contains("'someday' is not a calendar date")));
        assert!(matches!(at("2026-06-15", "07:00", ""), Err(EvalError::Thrown { message, .. }) if message.contains("'' is not a recognised IANA time zone")));
        assert!(matches!(at("2026-06-15", "07:00", "UTC"), Ok(Js::String(_))));
        assert!(matches!(apply_namespaced("datetime.at", &[Js::Null, s("07:00"), s("UTC")], around()), Ok(Js::Null)));
    }

    #[test]
    fn url_host_as_whatwg_reads_it() {
        let host = |t: &str| text(call("url.host", vec![s(t)]));
        assert_eq!(host("https://WWW.Acme.com:8080/deals/1"), "www.acme.com");
        assert_eq!(host("acme.com:8080"), "acme.com");
        assert_eq!(host("www.Acme.com/x"), "www.acme.com");
        assert_eq!(host("not a url"), "<null>");
        assert_eq!(host("mailto:a@b.com"), "<null>");
        assert_eq!(host("joe@acme.com"), "<null>");
        assert_eq!(host("/deals/1"), "<null>");
        assert_eq!(host("localhost:8080"), "<null>");
        assert_eq!(host("http://@acme.com"), "acme.com");
        assert_eq!(host("http://:pw@acme.com"), "acme.com");
        assert_eq!(host("http://a@b@c.com"), "<null>");
        assert_eq!(host("http://acme.com:99999"), "<null>");
        assert_eq!(host("http://acme.com:99999999999999999999999"), "<null>");
        assert_eq!(host("http://acme.com:"), "acme.com");
        assert_eq!(host("http://acme.com:0080"), "acme.com");
        assert_eq!(host("http://acme.com:8a"), "<null>");
        // No `://`, and `http:` not followed by `//` reads as an opaque uri.
        assert_eq!(host("http:\\\\acme.com\\x"), "<null>");
        assert_eq!(host("http://\\acme.com\\x"), "acme.com");
        assert_eq!(host("https:///acme.com"), "acme.com");
        assert_eq!(host("http://a_b*c.com."), "a_b*c.com.");
        assert_eq!(host("foo bar://x"), "<null>");
        assert_eq!(host(""), "<null>");
        // The readings the environment's WHATWG parser owns.
        assert_eq!(host("http://127.1"), "127.0.0.1");
        assert_eq!(host("http://[::1]:80/"), "[::1]");
        assert_eq!(host("http://B\u{dc}cher.de"), "xn--bcher-kva.de");
        assert_eq!(host("file:///x"), "<null>");
        assert_eq!(host("git://Host/x"), "Host");
        assert_eq!(host("http://a%41.com"), "aa.com");
    }

    /// Node 22's ICU (Unicode 16), not Rust's tables (Unicode 17): U+0295
    /// is cased for the final-sigma rule in the older one, so the sigma
    /// before it is not final.
    #[test]
    fn case_mapping_follows_nodes_icu() {
        assert_eq!(text(call("lower", vec![s("ΑΣʕ")])), "ασʕ");
        assert_eq!(text(call("lower", vec![s("ΑΣ ʕ")])), "ας ʕ");
        assert_eq!(text(call("lower", vec![s("AΣ\u{345}")])), "aς\u{345}");
    }

    #[test]
    fn flat_builtins() {
        assert_eq!(text(call("trim", vec![s("\u{feff} x\u{a0}")])), "x");
        assert_eq!(text(call("upper", vec![s("straße")])), "STRASSE");
        assert_eq!(text(call("lower", vec![s("ΣΑΣ")])), "σας");
        assert!(matches!(call("length", vec![s("a😀")]), Js::Number(n) if n == 3.0));
        assert!(matches!(call("length", vec![Js::Null]), Js::Number(n) if n == 0.0));
        assert!(matches!(call("length", vec![Js::Number(-1.5)]), Js::Number(n) if n == 4.0));
        assert!(matches!(call("round", vec![s("-2.5")]), Js::Number(n) if n == -2.0));
        assert!(matches!(call("tonumber", vec![s("abc")]), Js::Null));
        assert!(matches!(call("tonumber", vec![s("")]), Js::Number(n) if n == 0.0));
        assert!(matches!(call("number", vec![s("")]), Js::Null));
        assert!(matches!(call("number", vec![s("0x10")]), Js::Number(n) if n == 16.0));
        assert_eq!(text(call("tostring", vec![Js::Number(1e21)])), "1e+21");
        assert_eq!(text(call("tostring", vec![Js::array(vec![Js::Number(1.0), Js::Null])])), "1,");
        let Js::Array(parts) = call("split", vec![s(" a, ,b ,"), Js::Null]) else { panic!("a list") };
        assert_eq!(parts.items().iter().map(|p| text(p.clone())).collect::<Vec<_>>(), ["a", "b"]);
        let Js::Array(chars) = call("split", vec![s("ab c"), s("")]) else { panic!("a list") };
        assert_eq!(chars.items().len(), 3);
        let Js::Array(flat) = call("multi", vec![Js::Number(1.0), Js::Null, Js::array(vec![Js::Number(2.0), Js::Undefined])]) else {
            panic!("a list")
        };
        assert_eq!(flat.items().len(), 2);
        assert!(matches!(call("isnull", vec![]), Js::Bool(true)));
    }
}
