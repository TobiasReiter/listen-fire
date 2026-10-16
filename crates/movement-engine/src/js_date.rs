//! Dates as the language reads them: the proleptic Gregorian day
//! arithmetic, TimeClip, the UTC fields, `toISOString`'s text, and reading a
//! date-time text (ISO 8601 / RFC 3339 only; no offset is UTC).

pub const MS_PER_DAY: f64 = 86_400_000.0;

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

// ── Reading a date-time text ────────────────────────────────────────────────

/// A date-time text as an instant (ms since the epoch), `None` when it is
/// not one: the ISO 8601 / RFC 3339 forms only, `2026-03-05`,
/// `2026-03-05T10:00`, `2026-03-05 10:00:30.25+05:30`, `2026-03-05T10:00Z`
/// (`YYYY` and `YYYY-MM` too, and the six-digit signed years `toISOString`
/// writes). A text with no offset is UTC. The day must exist in its month,
/// and the hour is 0–23.
pub fn parse(text: &str) -> Option<f64> {
    let mut r = Reader { s: text.as_bytes(), at: 0 };
    let year = match r.peek()? {
        sign @ (b'+' | b'-') => {
            r.at += 1;
            let digits = r.digits(6)?;
            if sign == b'-' && digits == 0 {
                return None;
            }
            if sign == b'-' { -digits } else { digits }
        }
        _ => r.digits(4)?,
    };
    let (mut month, mut day) = (1, 1);
    if r.eat(b'-') {
        month = r.digits(2)?;
        if r.eat(b'-') {
            day = r.digits(2)?;
        }
    }
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let mut ms = days_from_civil(year, month, day) as f64 * MS_PER_DAY;
    if matches!(r.peek(), Some(b'T' | b't' | b' ')) {
        r.at += 1;
        let hour = r.digits(2)?;
        r.eat(b':').then_some(())?;
        let minute = r.digits(2)?;
        let (mut second, mut millis) = (0, 0.0);
        if r.eat(b':') {
            second = r.digits(2)?;
            if r.eat(b'.') {
                let start = r.at;
                while r.peek().is_some_and(|c| c.is_ascii_digit()) {
                    r.at += 1;
                }
                let fraction = std::str::from_utf8(&r.s[start..r.at]).ok()?;
                if fraction.is_empty() {
                    return None;
                }
                millis = fraction.bytes().chain(std::iter::repeat(b'0')).take(3).fold(0.0, |acc, d| acc * 10.0 + f64::from(d - b'0'));
            }
        }
        if hour > 23 || minute > 59 || second > 59 {
            return None;
        }
        ms += (hour * 3_600_000 + minute * 60_000 + second * 1000) as f64 + millis;
        match r.peek() {
            Some(b'Z' | b'z') => r.at += 1,
            Some(sign @ (b'+' | b'-')) => {
                r.at += 1;
                let hours = r.digits(2)?;
                r.eat(b':');
                let minutes = r.digits(2)?;
                if hours > 23 || minutes > 59 {
                    return None;
                }
                let offset = ((hours * 60 + minutes) * 60_000) as f64;
                ms += if sign == b'+' { -offset } else { offset };
            }
            _ => {}
        }
    }
    if r.at != r.s.len() {
        return None;
    }
    time_clip(ms)
}

struct Reader<'a> {
    s: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.at).copied()
    }

    fn eat(&mut self, c: u8) -> bool {
        let found = self.peek() == Some(c);
        self.at += usize::from(found);
        found
    }

    /// Exactly `n` ASCII digits.
    fn digits(&mut self, n: usize) -> Option<i64> {
        let digits = self.s.get(self.at..self.at + n)?;
        if !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        self.at += n;
        Some(digits.iter().fold(0, |acc, d| acc * 10 + i64::from(d - b'0')))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iso_of(text: &str) -> Option<String> {
        parse(text).map(to_iso_string)
    }

    #[test]
    fn reads_the_iso_forms() {
        assert_eq!(iso_of("2026-01-01T00:00:00.12345Z").as_deref(), Some("2026-01-01T00:00:00.123Z"));
        assert_eq!(iso_of("2026-01-01T00:00:00.1Z").as_deref(), Some("2026-01-01T00:00:00.100Z"));
        assert_eq!(iso_of("2026-01-01T00:00+23:59").as_deref(), Some("2025-12-31T00:01:00.000Z"));
        assert_eq!(iso_of("2026-01-01T00:00:00.000-00:00").as_deref(), Some("2026-01-01T00:00:00.000Z"));
        assert_eq!(iso_of("0000-01-01T00:00Z").as_deref(), Some("0000-01-01T00:00:00.000Z"));
        assert_eq!(iso_of("2026-01-01t00:00z").as_deref(), Some("2026-01-01T00:00:00.000Z"));
        assert_eq!(iso_of("+275760-09-13T00:00Z").as_deref(), Some("+275760-09-13T00:00:00.000Z"));
        assert_eq!(iso_of("-000001-01-01T00:00Z").as_deref(), Some("-000001-01-01T00:00:00.000Z"));
        assert_eq!(iso_of("2026-01-01T00:00+0530").as_deref(), Some("2025-12-31T18:30:00.000Z"));
        assert_eq!(iso_of("2026-03").as_deref(), Some("2026-03-01T00:00:00.000Z"));
        // RFC 3339's space between the date and the time.
        assert_eq!(iso_of("2026-03-05 10:00:30").as_deref(), Some("2026-03-05T10:00:30.000Z"));
        // No offset is UTC, whatever zone the run is in.
        assert_eq!(iso_of("2026-03-05T10:00").as_deref(), Some("2026-03-05T10:00:00.000Z"));
    }

    /// Version 5 reads ISO / RFC 3339 only: V8's legacy forms, a day its
    /// month does not have and the hour 24 are no date (V8 read `"Mar 5,
    /// 2024"`, `"item 3"`, `"2026-02-30"` and `T24:00`).
    #[test]
    fn refuses_everything_else() {
        for text in [
            "", "a 1", "3/4", "Jan 5", "Mar 5, 2024", "item 3", "2026-1-9", "12/03/2026", "March 12, 2026 9:30 PM",
            "Thu, 12 Mar 2026 09:30:00 GMT+0530", "2026-02-30", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00 Z",
            "-000000-01-01T00:00Z", "2026-01-01T00:00+24:00", "2026-13-01T00:00Z", "2026-01-01 junk", "2026-01-01T10",
            "2026-01-01T10:00:00.Z", " 2026-01-01",
        ] {
            assert_eq!(iso_of(text), None, "{text}");
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
