//! JavaScript's `Date`, as far as the standard library reads it: `Date.UTC`'s
//! day arithmetic, TimeClip, the UTC getters, `toISOString`, and
//! `new Date(text)` for the texts whose meaning is fixed.
//!
//! That last one is deliberately partial. V8 reads an ISO 8601 date-time
//! with its spec parser and EVERY other text with a permissive legacy parser
//! (`new Date("a 1")` is 2001-01-01), and a date-time without an offset in
//! the process's local zone. Neither is reproduced: such a text is
//! `Parsed::Unknown`, and the evaluation goes back to TypeScript rather than
//! guess. A text with no digit at all never names a date to either parser.

pub const MS_PER_DAY: f64 = 86_400_000.0;

/// What `new Date(text).getTime()` is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Parsed {
    Valid(f64),
    /// `NaN`: an Invalid Date.
    Invalid,
    /// A text only V8's legacy parser, or the local zone, can answer.
    Unknown,
}

/// Days since 1970-01-01 of a proleptic Gregorian date (month 1–12).
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date `days` after 1970-01-01: (year, month 1–12, day 1–31).
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

pub fn days_in_month(year: i64, month: i64) -> i64 {
    days_from_civil(if month == 12 { year + 1 } else { year }, if month == 12 { 1 } else { month + 1 }, 1)
        - days_from_civil(year, month, 1)
}

/// `Date.UTC(year, month - 1, day)` for a date `validParts` already
/// accepted (so no two-digit-year or overflow rules apply).
pub fn utc_midnight(year: i64, month: i64, day: i64) -> f64 {
    days_from_civil(year, month, day) as f64 * MS_PER_DAY
}

/// TimeClip: an instant outside ±8.64e15 ms is an Invalid Date; inside, it
/// is truncated toward zero (and `-0` is `+0`).
pub fn time_clip(t: f64) -> Option<f64> {
    if !t.is_finite() || t.abs() > 8.64e15 { None } else { Some(t.trunc() + 0.0) }
}

/// The UTC getters of a valid instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UtcFields {
    pub year: i64,
    /// 0–11, as `getUTCMonth`.
    pub month: i64,
    pub day: i64,
    /// 0 is Sunday, as `getUTCDay`.
    pub weekday: i64,
    pub hours: i64,
    pub minutes: i64,
    pub seconds: i64,
    pub millis: i64,
}

pub fn utc_fields(ms: f64) -> UtcFields {
    let ms = ms as i64;
    let days = ms.div_euclid(MS_PER_DAY as i64);
    let in_day = ms.rem_euclid(MS_PER_DAY as i64);
    let (year, month, day) = civil_from_days(days);
    UtcFields {
        year,
        month: month - 1,
        day,
        weekday: (days + 4).rem_euclid(7),
        hours: in_day / 3_600_000,
        minutes: in_day / 60_000 % 60,
        seconds: in_day / 1000 % 60,
        millis: in_day % 1000,
    }
}

/// `Date.prototype.toISOString` of a valid instant: a six-digit signed year
/// outside 0000–9999.
pub fn to_iso_string(ms: f64) -> String {
    let f = utc_fields(ms);
    let year = if (0..=9999).contains(&f.year) {
        format!("{:04}", f.year)
    } else {
        format!("{}{:06}", if f.year < 0 { '-' } else { '+' }, f.year.abs())
    };
    format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        f.month + 1,
        f.day,
        f.hours,
        f.minutes,
        f.seconds,
        f.millis
    )
}

/// `new Date(text).getTime()`, for the texts whose reading is fixed:
/// `YYYY-MM-DD` (UTC midnight), and `YYYY-MM-DDTHH:mm[:ss[.fff…]]` with `Z`
/// or `±HH:mm`. As V8's spec parser, a day up to 31 rolls into the next
/// month (`2026-02-30` is March 2nd), `24:00` is the next midnight, and a
/// fraction keeps its first three digits.
pub fn parse(text: &str) -> Parsed {
    if !text.bytes().any(|b| b.is_ascii_digit()) {
        return Parsed::Invalid;
    }
    iso(text.as_bytes()).map_or(Parsed::Unknown, Parsed::Valid)
}

fn iso(b: &[u8]) -> Option<f64> {
    let num = |from: usize, len: usize| -> Option<i64> {
        let digits = b.get(from..from + len)?;
        digits.iter().all(u8::is_ascii_digit).then(|| digits.iter().fold(0, |acc, d| acc * 10 + i64::from(d - b'0')))
    };
    let year = num(0, 4)?;
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    let month = num(5, 2)?;
    let day = num(8, 2)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let date = (days_from_civil(year, month, 1) + day - 1) as f64 * MS_PER_DAY;
    if b.len() == 10 {
        return Some(date);
    }
    if b.get(10) != Some(&b'T') || b.get(13) != Some(&b':') {
        return None;
    }
    let hours = num(11, 2)?;
    let minutes = num(14, 2)?;
    let mut at = 16;
    let mut seconds = 0;
    let mut millis = 0;
    let mut fraction_digits = 0;
    if b.get(at) == Some(&b':') {
        seconds = num(at + 1, 2)?;
        at += 3;
        if b.get(at) == Some(&b'.') {
            let digits = b[at + 1..].iter().take_while(|d| d.is_ascii_digit()).count();
            if digits == 0 {
                return None;
            }
            let kept = &b[at + 1..at + 1 + digits.min(3)];
            millis = kept.iter().fold(0, |acc, d| acc * 10 + i64::from(d - b'0')) * 10i64.pow(3 - kept.len() as u32);
            fraction_digits = digits;
            at += 1 + digits;
        }
    }
    // `24:00` is the next midnight only exactly: no minute, second or
    // fraction past it (a fraction starts after `YYYY-MM-DDTHH:mm:ss.`).
    let fraction_is_zero = b[20.min(b.len())..(20 + fraction_digits).min(b.len())].iter().all(|&d| d == b'0');
    if minutes > 59 || seconds > 59 || hours > 24 || (hours == 24 && (minutes, seconds, fraction_is_zero) != (0, 0, true)) {
        return None;
    }
    let offset_minutes = match b.get(at) {
        Some(b'Z') if b.len() == at + 1 => 0,
        Some(sign @ (b'+' | b'-')) if b.len() == at + 6 && b[at + 3] == b':' => {
            let (oh, om) = (num(at + 1, 2)?, num(at + 4, 2)?);
            if oh > 23 || om > 59 {
                return None;
            }
            if *sign == b'+' { oh * 60 + om } else { -(oh * 60 + om) }
        }
        // No offset: the process's local zone, which this cannot know.
        _ => return None,
    };
    let time = (hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis - offset_minutes * 60_000) as f64;
    time_clip(date + time)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iso_of(text: &str) -> Option<String> {
        match parse(text) {
            Parsed::Valid(ms) => Some(to_iso_string(ms)),
            Parsed::Invalid => None,
            Parsed::Unknown => Some("unknown".into()),
        }
    }

    #[test]
    fn reads_the_iso_forms_as_v8_does() {
        assert_eq!(iso_of("2026-02-30T00:00:00Z").as_deref(), Some("2026-03-02T00:00:00.000Z"));
        assert_eq!(iso_of("2026-02-30").as_deref(), Some("2026-03-02T00:00:00.000Z"));
        assert_eq!(iso_of("2026-01-01T24:00:00Z").as_deref(), Some("2026-01-02T00:00:00.000Z"));
        assert_eq!(iso_of("2026-01-01T00:00:00.12345Z").as_deref(), Some("2026-01-01T00:00:00.123Z"));
        assert_eq!(iso_of("2026-01-01T00:00:00.1Z").as_deref(), Some("2026-01-01T00:00:00.100Z"));
        assert_eq!(iso_of("2026-01-01T00:00+23:59").as_deref(), Some("2025-12-31T00:01:00.000Z"));
        assert_eq!(iso_of("2026-01-01T00:00:00.000-00:00").as_deref(), Some("2026-01-01T00:00:00.000Z"));
        assert_eq!(iso_of("0000-01-01T00:00Z").as_deref(), Some("0000-01-01T00:00:00.000Z"));
    }

    #[test]
    fn leaves_what_only_v8_can_read_unknown() {
        for text in ["2026-01-01T00:00:00", "2026-1-1", "a 1", "Item 5", "2026-13-01T00:00Z", "2026-01-01t00:00z", "2026-01-01T24:00:01Z", " 2026-01-01"] {
            assert_eq!(parse(text), Parsed::Unknown, "{text}");
        }
        for text in ["apple", "", "May", "noon", "T"] {
            assert_eq!(parse(text), Parsed::Invalid, "{text}");
        }
    }

    #[test]
    fn iso_strings_outside_four_digit_years() {
        assert_eq!(to_iso_string(8.64e15), "+275760-09-13T00:00:00.000Z");
        assert_eq!(to_iso_string(-62198755200000.0), "-000001-01-01T00:00:00.000Z");
        assert_eq!(to_iso_string(-1.0), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn time_clip_bounds_and_truncates() {
        assert_eq!(time_clip(8.64e15), Some(8.64e15));
        assert_eq!(time_clip(8.64e15 + 1.0), None);
        assert_eq!(time_clip(-1.5), Some(-1.0));
        assert!(time_clip(-0.5).is_some_and(|t| t == 0.0 && t.is_sign_positive()));
    }

    #[test]
    fn weekdays_and_month_lengths() {
        assert_eq!(utc_fields(utc_midnight(2026, 8, 31)).weekday, 1);
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2100, 2), 28);
        assert_eq!(days_in_month(2026, 12), 31);
    }
}
