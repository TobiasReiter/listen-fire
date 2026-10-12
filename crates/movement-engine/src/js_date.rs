//! JavaScript's `Date`, as far as the language reads it: `Date.UTC`'s day
//! arithmetic, TimeClip, the UTC getters, `toISOString`, and
//! `new Date(text)` / `Date.parse(text)`.
//!
//! The parse is V8's (src/date/dateparser*.{h,cc}, src/builtins/
//! builtins-date.cc `ParseDateTimeString`, of the V8 Node 22.20 ships),
//! written out step for step: the ES5 ISO form first, then the legacy
//! parser V8 falls back to for everything else (`new Date("a 1")` is
//! 2001-01-01). A text with no offset of its own is read in the local zone:
//! the process's for V8, the run's `localZone` here (`LocalZone`), UTC when
//! the run names none.

use crate::env_services::EnvServices;

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

// ── The local zone ───────────────────────────────────────────────────────────

/// The zone a date-time text with no offset of its own is read in. V8 reads
/// it in the process's local zone; this engine is handed the zone with the
/// run (`localZone`, an IANA name the environment services read) and reads
/// UTC when it is handed none.
#[derive(Clone, Copy)]
pub struct LocalZone<'a> {
    zone: Option<(&'a str, &'a dyn EnvServices)>,
}

impl<'a> LocalZone<'a> {
    pub const UTC: LocalZone<'static> = LocalZone { zone: None };

    pub fn new(zone: Option<&'a str>, services: &'a dyn EnvServices) -> Self {
        LocalZone { zone: zone.map(|zone| (zone, services)) }
    }

    /// Whether the environment reads `zone` at all: one it does not would
    /// read every offset as 0, silently UTC.
    pub fn is_known(zone: &str, services: &dyn EnvServices) -> bool {
        services.tz_convert("1970-01-01T00:00:00.000Z", zone).is_some()
    }

    /// The zone's offset at a UTC instant, in milliseconds.
    fn offset_at(zone: &str, services: &dyn EnvServices, instant: f64) -> f64 {
        services
            .tz_convert(&to_iso_string(within_read_years(instant)), zone)
            .map_or(0.0, |fields| (fields.offset_minutes * 60_000.0).round())
    }

    /// `LocalOffsetInMs(wall, is_utc = false)`: the offset of a wall-clock
    /// reading, as ICU's `getOffsetFromLocal(UCAL_TZ_LOCAL_FORMER,
    /// UCAL_TZ_LOCAL_FORMER)` answers it for V8 (intl-objects.cc
    /// `ICUTimezoneCache::GetOffsets`): a reading the clock shows twice is
    /// the earlier instant, and one it skips is read with the offset before
    /// the change.
    fn offset_of_reading(&self, wall: f64) -> f64 {
        let Some((zone, services)) = self.zone else { return 0.0 };
        let at = |instant: f64| Self::offset_at(zone, services, instant);
        let before = at(wall - MS_PER_DAY);
        let after = at(wall + MS_PER_DAY);
        let read_here = |offset: f64| at(wall - offset) == offset;
        // The earliest instant showing `wall` is the one with the larger offset.
        let candidates = if before == after { vec![before] } else { vec![before.max(after), before.min(after)] };
        candidates.into_iter().find(|&offset| read_here(offset)).unwrap_or(before)
    }
}

/// An instant whose zone reading the environment answers reliably: years
/// 1000–9000. Outside them a zone's offset is periodic (its local mean time
/// before its first change, its final rule after its last), and 400
/// Gregorian years repeat the calendar weekday for weekday, so the instant
/// is moved by whole such cycles into the span. (`Intl` refuses an instant
/// past ±8.64e15 ms, which a local reading near the end of time asks about,
/// and reads a year before the common era as its era's year.)
fn within_read_years(instant: f64) -> f64 {
    const CYCLE: f64 = 146_097.0 * MS_PER_DAY;
    let low = days_from_civil(1000, 1, 1) as f64 * MS_PER_DAY;
    let high = days_from_civil(9000, 1, 1) as f64 * MS_PER_DAY;
    if instant >= high {
        instant - (((instant - high) / CYCLE).floor() + 1.0) * CYCLE
    } else if instant < low {
        instant + ((low - instant) / CYCLE).ceil() * CYCLE
    } else {
        instant
    }
}

// ── `Date.parse` ─────────────────────────────────────────────────────────────

/// `kMaxTimeBeforeUTCInMs`: how far from the epoch a local reading may be
/// and still be converted.
const MAX_TIME_BEFORE_UTC: f64 = 8.64e15 + 30.0 * MS_PER_DAY;

/// `Date.parse(text)` (and `new Date(text).getTime()`), `None` for NaN:
/// `ParseDateTimeString`.
pub fn parse(text: &str, local: LocalZone<'_>) -> Option<f64> {
    let units = crate::js_string::units_vec(text);
    let fields = parse_fields(&units)?;
    let day = make_day(fields.year, fields.month, fields.day)?;
    let time = f64::from(fields.hour) * 3_600_000.0
        + f64::from(fields.minute) * 60_000.0
        + f64::from(fields.second) * 1000.0
        + f64::from(fields.millisecond);
    let date = day * MS_PER_DAY + time;
    let date = match fields.utc_offset {
        Some(seconds) => date - f64::from(seconds) * 1000.0,
        None if date.abs() <= MAX_TIME_BEFORE_UTC => date - local.offset_of_reading(date),
        None => return None,
    };
    time_clip(date)
}

/// `MakeDay` of what the parser read (a month 0–11, a day 1–31): NaN past
/// a million years either side.
fn make_day(year: i32, month: i32, day: i32) -> Option<f64> {
    if !(-1_000_000..=1_000_000).contains(&year) {
        return None;
    }
    Some((days_from_civil(i64::from(year), i64::from(month) + 1, 1) + i64::from(day) - 1) as f64)
}

/// What `DateParser::Parse` writes out: the month 0-based, the offset in
/// seconds (`None`: the text named none).
struct Fields {
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
    millisecond: i32,
    utc_offset: Option<i32>,
}

/// `kNone`: a missing value.
const NONE: i32 = i32::MAX;
/// `kMaxSignificantDigits`: a numeral's digits past these are read and
/// dropped.
const MAX_SIGNIFICANT_DIGITS: i32 = 9;

/// `Between`: with unsigned arithmetic, as V8 writes it.
fn between(x: i32, lo: i32, hi: i32) -> bool {
    (x.wrapping_sub(lo) as u32) <= (hi.wrapping_sub(lo) as u32)
}

fn is_minute(x: i32) -> bool {
    between(x, 0, 59)
}
fn is_hour(x: i32) -> bool {
    between(x, 0, 23)
}
fn is_second(x: i32) -> bool {
    between(x, 0, 59)
}
fn is_hour12(x: i32) -> bool {
    between(x, 0, 12)
}
fn is_millisecond(x: i32) -> bool {
    between(x, 0, 999)
}
fn is_month(x: i32) -> bool {
    between(x, 1, 12)
}
fn is_day(x: i32) -> bool {
    between(x, 1, 31)
}

/// `IsWhiteSpace`: Unicode's space separators, tab, vertical tab, form
/// feed and the BOM — no line terminator.
fn is_white_space(c: u32) -> bool {
    matches!(c, 0x09 | 0x0B | 0x0C | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}

/// `IsWhiteSpaceOrLineTerminator`.
fn is_white_space_or_line_terminator(c: u32) -> bool {
    is_white_space(c) || matches!(c, 0x0A | 0x0D | 0x2028 | 0x2029)
}

/// `InputReader`: the text a UTF-16 unit at a time; `0` past its end (and
/// at a NUL, which ends it as surely).
struct InputReader<'s> {
    text: &'s [u16],
    index: usize,
    ch: u32,
}

impl<'s> InputReader<'s> {
    fn new(text: &'s [u16]) -> Self {
        let mut reader = InputReader { text, index: 0, ch: 0 };
        reader.next();
        reader
    }

    fn position(&self) -> usize {
        self.index
    }

    fn next(&mut self) {
        self.ch = self.text.get(self.index).map_or(0, |&unit| u32::from(unit));
        self.index += 1;
    }

    fn read_unsigned_numeral(&mut self) -> i32 {
        let mut n = 0;
        let mut i = 0;
        while self.ch == u32::from(b'0') {
            self.next();
        }
        while self.is_ascii_digit() {
            if i < MAX_SIGNIFICANT_DIGITS {
                n = n * 10 + (self.ch - u32::from(b'0')) as i32;
            }
            i += 1;
            self.next();
        }
        n
    }

    /// The word's length; its first three units lowered (`| 0x20`) into
    /// `prefix`, zero-padded.
    fn read_word(&mut self, prefix: &mut [u32; 3]) -> i32 {
        let mut len = 0;
        while self.is_ascii_alpha_or_above() && !self.is_white_space_char() {
            if len < 3 {
                prefix[len] = self.ch | 0x20;
            }
            self.next();
            len += 1;
        }
        for slot in prefix.iter_mut().skip(len) {
            *slot = 0;
        }
        len as i32
    }

    fn skip(&mut self, c: u8) -> bool {
        if self.ch == u32::from(c) {
            self.next();
            return true;
        }
        false
    }

    fn skip_white_space(&mut self) -> bool {
        if is_white_space_or_line_terminator(self.ch) {
            self.next();
            return true;
        }
        false
    }

    /// A parenthesised run, nested, to its close or the text's end.
    fn skip_parentheses(&mut self) -> bool {
        if self.ch != u32::from(b'(') {
            return false;
        }
        let mut balance = 0;
        loop {
            if self.ch == u32::from(b')') {
                balance -= 1;
            } else if self.ch == u32::from(b'(') {
                balance += 1;
            }
            self.next();
            if !(balance > 0 && self.ch != 0) {
                return true;
            }
        }
    }

    fn is_end(&self) -> bool {
        self.ch == 0
    }
    fn is_ascii_digit(&self) -> bool {
        (u32::from(b'0')..=u32::from(b'9')).contains(&self.ch)
    }
    fn is_ascii_alpha_or_above(&self) -> bool {
        self.ch >= u32::from(b'A')
    }
    fn is_white_space_char(&self) -> bool {
        is_white_space(self.ch)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeywordType {
    Invalid,
    MonthName,
    TimeZoneName,
    TimeSeparator,
    AmPm,
}

/// `KeywordTable::array`, in its order: a word matches the first entry
/// its first three letters spell, and only a month name may be longer.
const KEYWORDS: [([u8; 3], KeywordType, i32); 27] = [
    (*b"jan", KeywordType::MonthName, 1),
    (*b"feb", KeywordType::MonthName, 2),
    (*b"mar", KeywordType::MonthName, 3),
    (*b"apr", KeywordType::MonthName, 4),
    (*b"may", KeywordType::MonthName, 5),
    (*b"jun", KeywordType::MonthName, 6),
    (*b"jul", KeywordType::MonthName, 7),
    (*b"aug", KeywordType::MonthName, 8),
    (*b"sep", KeywordType::MonthName, 9),
    (*b"oct", KeywordType::MonthName, 10),
    (*b"nov", KeywordType::MonthName, 11),
    (*b"dec", KeywordType::MonthName, 12),
    (*b"am\0", KeywordType::AmPm, 0),
    (*b"pm\0", KeywordType::AmPm, 12),
    (*b"ut\0", KeywordType::TimeZoneName, 0),
    (*b"utc", KeywordType::TimeZoneName, 0),
    (*b"z\0\0", KeywordType::TimeZoneName, 0),
    (*b"gmt", KeywordType::TimeZoneName, 0),
    (*b"cdt", KeywordType::TimeZoneName, -5),
    (*b"cst", KeywordType::TimeZoneName, -6),
    (*b"edt", KeywordType::TimeZoneName, -4),
    (*b"est", KeywordType::TimeZoneName, -5),
    (*b"mdt", KeywordType::TimeZoneName, -6),
    (*b"mst", KeywordType::TimeZoneName, -7),
    (*b"pdt", KeywordType::TimeZoneName, -7),
    (*b"pst", KeywordType::TimeZoneName, -8),
    (*b"t\0\0", KeywordType::TimeSeparator, 0),
];

/// `KeywordTable::Lookup`: the keyword's type and value, `Invalid` (0) for
/// a word that is none.
fn lookup_keyword(prefix: &[u32; 3], len: i32) -> (KeywordType, i32) {
    KEYWORDS
        .iter()
        .find(|(word, kind, _)| {
            word.iter().zip(prefix).all(|(&w, &p)| u32::from(w) == p) && (len <= 3 || *kind == KeywordType::MonthName)
        })
        .map_or((KeywordType::Invalid, 0), |&(_, kind, value)| (kind, value))
}

/// `DateToken`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Token {
    Invalid,
    Unknown,
    Number { value: i32, length: i32 },
    Symbol(u8),
    WhiteSpace,
    EndOfInput,
    Keyword { kind: KeywordType, value: i32, length: i32 },
}

impl Token {
    fn is_number(&self) -> bool {
        matches!(self, Token::Number { .. })
    }
    fn number(&self) -> i32 {
        match self {
            Token::Number { value, .. } => *value,
            _ => unreachable!("a number is read only off a number token"),
        }
    }
    fn is_symbol(&self, symbol: u8) -> bool {
        *self == Token::Symbol(symbol)
    }
    fn is_fixed_length_number(&self, length: i32) -> bool {
        matches!(self, Token::Number { length: l, .. } if *l == length)
    }
    fn is_ascii_sign(&self) -> bool {
        matches!(self, Token::Symbol(b'+' | b'-'))
    }
    /// 1 for `+`, -1 for `-`.
    fn ascii_sign(&self) -> i32 {
        if self.is_symbol(b'+') { 1 } else { -1 }
    }
    fn is_keyword_type(&self, kind: KeywordType) -> bool {
        matches!(self, Token::Keyword { kind: k, .. } if *k == kind)
    }
    /// `Z` (or `z`), alone.
    fn is_keyword_z(&self) -> bool {
        matches!(self, Token::Keyword { kind: KeywordType::TimeZoneName, length: 1, value: 0 })
    }
}

/// `DateStringTokenizer`: one token of lookahead.
struct Tokenizer<'s> {
    reader: InputReader<'s>,
    next: Token,
}

impl<'s> Tokenizer<'s> {
    fn new(text: &'s [u16]) -> Self {
        let mut reader = InputReader::new(text);
        let next = Self::scan(&mut reader);
        Tokenizer { reader, next }
    }

    fn next(&mut self) -> Token {
        let token = self.next;
        self.next = Self::scan(&mut self.reader);
        token
    }

    fn peek(&self) -> Token {
        self.next
    }

    fn skip_symbol(&mut self, symbol: u8) -> bool {
        if self.next.is_symbol(symbol) {
            self.next = Self::scan(&mut self.reader);
            return true;
        }
        false
    }

    fn scan(reader: &mut InputReader<'_>) -> Token {
        let pre = reader.position();
        if reader.is_end() {
            return Token::EndOfInput;
        }
        if reader.is_ascii_digit() {
            let value = reader.read_unsigned_numeral();
            return Token::Number { value, length: (reader.position() - pre) as i32 };
        }
        for symbol in *b":-+.)" {
            if reader.skip(symbol) {
                return Token::Symbol(symbol);
            }
        }
        if reader.is_ascii_alpha_or_above() && !reader.is_white_space_char() {
            let mut prefix = [0u32; 3];
            let length = reader.read_word(&mut prefix);
            let (kind, value) = lookup_keyword(&prefix, length);
            return Token::Keyword { kind, value, length };
        }
        if reader.skip_white_space() {
            return Token::WhiteSpace;
        }
        if reader.skip_parentheses() {
            return Token::Unknown;
        }
        reader.next();
        Token::Unknown
    }
}

/// `ReadMilliseconds`: the numeral's first three digits, as its value and
/// length (leading zeros included) say them.
fn read_milliseconds(token: Token) -> i32 {
    let Token::Number { value: mut number, mut length } = token else { unreachable!("milliseconds are read off a number") };
    if length < 3 {
        if length == 1 {
            number *= 100;
        } else if length == 2 {
            number *= 10;
        }
    } else if length > 3 {
        if length > MAX_SIGNIFICANT_DIGITS {
            length = MAX_SIGNIFICANT_DIGITS;
        }
        let mut factor = 1;
        loop {
            factor *= 10;
            length -= 1;
            if length <= 3 {
                break;
            }
        }
        number /= factor;
    }
    number
}

/// `TimeZoneComposer`.
struct TimeZoneComposer {
    sign: i32,
    hour: i32,
    minute: i32,
}

impl TimeZoneComposer {
    fn set(&mut self, offset_in_hours: i32) {
        self.sign = if offset_in_hours < 0 { -1 } else { 1 };
        self.hour = offset_in_hours * self.sign;
        self.minute = 0;
    }
    fn set_sign(&mut self, sign: i32) {
        self.sign = if sign < 0 { -1 } else { 1 };
    }
    fn is_expecting(&self, n: i32) -> bool {
        self.hour != NONE && self.minute == NONE && is_minute(n)
    }
    fn is_utc(&self) -> bool {
        self.hour == 0 && self.minute == 0
    }
    fn is_empty(&self) -> bool {
        self.hour == NONE
    }
    /// The offset in seconds, `Some(None)` for none; `None` past a Smi.
    fn write(&self) -> Option<Option<i32>> {
        if self.sign == NONE {
            return Some(None);
        }
        let hour = if self.hour == NONE { 0 } else { self.hour };
        let minute = if self.minute == NONE { 0 } else { self.minute };
        let total = (hour as u32).wrapping_mul(3600).wrapping_add((minute as u32).wrapping_mul(60));
        if total > i32::MAX as u32 {
            return None;
        }
        let total = total as i32;
        Some(Some(if self.sign < 0 { -total } else { total }))
    }
}

/// `TimeComposer`: hour, minute, second, millisecond.
struct TimeComposer {
    comp: [i32; 4],
    index: usize,
    hour_offset: i32,
}

impl TimeComposer {
    fn is_empty(&self) -> bool {
        self.index == 0
    }
    fn is_expecting(&self, n: i32) -> bool {
        (self.index == 1 && is_minute(n)) || (self.index == 2 && is_second(n)) || (self.index == 3 && is_millisecond(n))
    }
    fn add(&mut self, n: i32) -> bool {
        if self.index < 4 {
            self.comp[self.index] = n;
            self.index += 1;
            return true;
        }
        false
    }
    fn add_final(&mut self, n: i32) -> bool {
        if !self.add(n) {
            return false;
        }
        while self.index < 4 {
            self.comp[self.index] = 0;
            self.index += 1;
        }
        true
    }
    fn write(&mut self) -> Option<[i32; 4]> {
        while self.index < 4 {
            self.comp[self.index] = 0;
            self.index += 1;
        }
        let [mut hour, minute, second, millisecond] = self.comp;
        if self.hour_offset != NONE {
            if !is_hour12(hour) {
                return None;
            }
            hour %= 12;
            hour += self.hour_offset;
        }
        if !is_hour(hour) || !is_minute(minute) || !is_second(second) || !is_millisecond(millisecond) {
            // The 24th hour, exactly.
            if hour != 24 || minute != 0 || second != 0 || millisecond != 0 {
                return None;
            }
        }
        Some([hour, minute, second, millisecond])
    }
}

/// `DayComposer`.
struct DayComposer {
    comp: [i32; 3],
    index: usize,
    named_month: i32,
    is_iso_date: bool,
}

impl DayComposer {
    fn is_empty(&self) -> bool {
        self.index == 0
    }
    fn add(&mut self, n: i32) -> bool {
        if self.index < 3 {
            self.comp[self.index] = n;
            self.index += 1;
            return true;
        }
        false
    }
    /// (year, month 0–11, day). The components missing are 1 before any
    /// reading, so two numbers read as month and day are of the year 1,
    /// which is 2001.
    fn write(&mut self) -> Option<(i32, i32, i32)> {
        if self.index < 1 {
            return None;
        }
        while self.index < 3 {
            self.comp[self.index] = 1;
            self.index += 1;
        }
        let [a, b, c] = self.comp;
        let (mut year, month, day) = if self.named_month == NONE {
            if self.is_iso_date || !is_day(a) { (a, b, c) } else { (c, a, b) }
        } else if !is_day(a) {
            (a, self.named_month, b)
        } else {
            (b, self.named_month, a)
        };
        if !self.is_iso_date {
            if between(year, 0, 49) {
                year += 2000;
            } else if between(year, 50, 99) {
                year += 1900;
            }
        }
        if !is_month(month) || !is_day(day) {
            return None;
        }
        Some((year, month - 1, day))
    }
}

/// `ParseES5DateTime`: as far as the text is an ES5 date-time string. The
/// token to go on with in the legacy parser, `EndOfInput` when the text was
/// one whole, `Invalid` when it can be nothing.
fn parse_es5(scanner: &mut Tokenizer<'_>, day: &mut DayComposer, time: &mut TimeComposer, tz: &mut TimeZoneComposer) -> Token {
    if scanner.peek().is_ascii_sign() {
        // The sign goes back to the legacy parser if it is not used.
        let sign_token = scanner.next();
        if !scanner.peek().is_fixed_length_number(6) {
            return sign_token;
        }
        let sign = sign_token.ascii_sign();
        let year = scanner.next().number();
        if sign < 0 && year == 0 {
            return sign_token;
        }
        day.add(sign * year);
    } else if scanner.peek().is_fixed_length_number(4) {
        day.add(scanner.next().number());
    } else {
        return scanner.next();
    }
    if scanner.skip_symbol(b'-') {
        if !scanner.peek().is_fixed_length_number(2) || !is_month(scanner.peek().number()) {
            return scanner.next();
        }
        day.add(scanner.next().number());
        if scanner.skip_symbol(b'-') {
            if !scanner.peek().is_fixed_length_number(2) || !is_day(scanner.peek().number()) {
                return scanner.next();
            }
            day.add(scanner.next().number());
        }
    }
    if !scanner.peek().is_keyword_type(KeywordType::TimeSeparator) {
        if scanner.peek() != Token::EndOfInput {
            return scanner.next();
        }
    } else {
        scanner.next();
        if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 0, 24) {
            return Token::Invalid;
        }
        let hour_is_24 = scanner.peek().number() == 24;
        time.add(scanner.next().number());
        if !scanner.skip_symbol(b':') {
            return Token::Invalid;
        }
        if !scanner.peek().is_fixed_length_number(2) || !is_minute(scanner.peek().number()) || (hour_is_24 && scanner.peek().number() > 0) {
            return Token::Invalid;
        }
        time.add(scanner.next().number());
        if scanner.skip_symbol(b':') {
            if !scanner.peek().is_fixed_length_number(2) || !is_second(scanner.peek().number()) || (hour_is_24 && scanner.peek().number() > 0) {
                return Token::Invalid;
            }
            time.add(scanner.next().number());
            if scanner.skip_symbol(b'.') {
                if !scanner.peek().is_number() || (hour_is_24 && scanner.peek().number() > 0) {
                    return Token::Invalid;
                }
                time.add(read_milliseconds(scanner.next()));
            }
        }
        if scanner.peek().is_keyword_z() {
            scanner.next();
            tz.set(0);
        } else if scanner.peek().is_ascii_sign() {
            tz.set_sign(scanner.next().ascii_sign());
            if scanner.peek().is_fixed_length_number(4) {
                // `hhmm`, an extension.
                let hourmin = scanner.next().number();
                let (hour, min) = (hourmin / 100, hourmin % 100);
                if !is_hour(hour) || !is_minute(min) {
                    return Token::Invalid;
                }
                tz.hour = hour;
                tz.minute = min;
            } else {
                if !scanner.peek().is_fixed_length_number(2) || !is_hour(scanner.peek().number()) {
                    return Token::Invalid;
                }
                tz.hour = scanner.next().number();
                if !scanner.skip_symbol(b':') {
                    return Token::Invalid;
                }
                if !scanner.peek().is_fixed_length_number(2) || !is_minute(scanner.peek().number()) {
                    return Token::Invalid;
                }
                tz.minute = scanner.next().number();
            }
        }
        if scanner.peek() != Token::EndOfInput {
            return Token::Invalid;
        }
    }
    // A date alone is UTC; a date-time without an offset is local.
    if tz.is_empty() && time.is_empty() {
        tz.set(0);
    }
    day.is_iso_date = true;
    Token::EndOfInput
}

/// `DateParser::Parse`: the ES5 form as far as it goes, then the legacy
/// parser over what is left.
fn parse_fields(text: &[u16]) -> Option<Fields> {
    let mut scanner = Tokenizer::new(text);
    let mut tz = TimeZoneComposer { sign: NONE, hour: NONE, minute: NONE };
    let mut time = TimeComposer { comp: [0; 4], index: 0, hour_offset: NONE };
    let mut day = DayComposer { comp: [0; 3], index: 0, named_month: NONE, is_iso_date: false };

    let next_unhandled = parse_es5(&mut scanner, &mut day, &mut time, &mut tz);
    if next_unhandled == Token::Invalid {
        return None;
    }
    let mut has_read_number = !day.is_empty();
    let mut token = next_unhandled;
    while token != Token::EndOfInput {
        match token {
            Token::Number { value: n, .. } => {
                has_read_number = true;
                if scanner.skip_symbol(b':') {
                    if scanner.skip_symbol(b':') {
                        // `n::`
                        if !time.is_empty() {
                            return None;
                        }
                        time.add(n);
                        time.add(0);
                    } else {
                        // `n:`
                        if !time.add(n) {
                            return None;
                        }
                        if scanner.peek().is_symbol(b'.') {
                            scanner.next();
                        }
                    }
                } else if scanner.skip_symbol(b'.') && time.is_expecting(n) {
                    time.add(n);
                    if !scanner.peek().is_number() {
                        return None;
                    }
                    let ms = read_milliseconds(scanner.next());
                    if ms < 0 {
                        return None;
                    }
                    time.add_final(ms);
                } else if tz.is_expecting(n) {
                    tz.minute = n;
                } else if time.is_expecting(n) {
                    time.add_final(n);
                    // The end, a space, `Z` or a sign must follow a time.
                    let peek = scanner.peek();
                    if peek != Token::EndOfInput && peek != Token::WhiteSpace && !peek.is_keyword_z() && !peek.is_ascii_sign() {
                        return None;
                    }
                } else {
                    if !day.add(n) {
                        return None;
                    }
                    scanner.skip_symbol(b'-');
                }
            }
            Token::Keyword { kind, value, .. } => {
                if kind == KeywordType::AmPm && !time.is_empty() {
                    time.hour_offset = value;
                } else if kind == KeywordType::MonthName {
                    day.named_month = value;
                    scanner.skip_symbol(b'-');
                } else if kind == KeywordType::TimeZoneName && has_read_number {
                    tz.set(value);
                } else {
                    // A word that means nothing is allowed only before the
                    // first number, and apart from it.
                    if has_read_number {
                        return None;
                    }
                    if scanner.peek().is_number() {
                        return None;
                    }
                }
            }
            Token::Symbol(b'+' | b'-') if tz.is_utc() || !time.is_empty() => {
                // An offset, only after a zone of UTC or a time.
                tz.set_sign(token.ascii_sign());
                let (mut n, mut length) = (0, 0);
                if let Token::Number { value, length: l } = scanner.peek() {
                    scanner.next();
                    n = value;
                    length = l;
                }
                has_read_number = true;
                if scanner.peek().is_symbol(b':') {
                    tz.hour = n;
                    tz.minute = NONE;
                } else if length == 2 || length == 1 {
                    // `GMT-8`
                    tz.hour = n;
                    tz.minute = 0;
                } else if length == 4 || length == 3 {
                    // `hhmm`
                    tz.hour = n / 100;
                    tz.minute = n % 100;
                } else {
                    return None;
                }
            }
            Token::Symbol(b'+' | b'-' | b')') if has_read_number => return None,
            _ => {}
        }
        token = scanner.next();
    }

    let (year, month, day) = day.write()?;
    let [hour, minute, second, millisecond] = time.write()?;
    let utc_offset = tz.write()?;
    Some(Fields { year, month, day, hour, minute, second, millisecond, utc_offset })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iso_of(text: &str) -> Option<String> {
        parse(text, LocalZone::UTC).map(to_iso_string)
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
        assert_eq!(iso_of("2026-01-01t00:00z").as_deref(), Some("2026-01-01T00:00:00.000Z"));
        assert_eq!(iso_of("+275760-09-13T00:00Z").as_deref(), Some("+275760-09-13T00:00:00.000Z"));
        assert_eq!(iso_of("2026-01-01T00:00+0530").as_deref(), Some("2025-12-31T18:30:00.000Z"));
        for text in ["2026-01-01T24:00:01Z", "2026-01-01T00:00:00 Z", "-000000-01-01T00:00Z", "2026-01-01T00:00+24:00"] {
            assert_eq!(iso_of(text), None, "{text}");
        }
    }

    #[test]
    fn reads_the_legacy_forms_as_v8_does() {
        for (text, iso) in [
            ("a 1", "2001-01-01T00:00:00.000Z"),
            ("3/4", "2001-03-04T00:00:00.000Z"),
            ("Jan 5", "2001-01-05T00:00:00.000Z"),
            ("2026-1-9", "2026-01-09T00:00:00.000Z"),
            (" 2026-01-01", "2026-01-01T00:00:00.000Z"),
            ("12/03/2026", "2026-12-03T00:00:00.000Z"),
            ("March 12, 2026 9:30 PM", "2026-03-12T21:30:00.000Z"),
            ("Thu, 12 Mar 2026 09:30:00 GMT+0530 (India Standard Time)", "2026-03-12T04:00:00.000Z"),
            ("12 mar 26 12:00 am EST", "2026-03-12T05:00:00.000Z"),
            ("2/31/2026", "2026-03-03T00:00:00.000Z"),
            ("Mon Jan 01 2001 10:00:00.5 UTC-01:30", "2001-01-01T11:30:00.500Z"),
            ("1999 Dec 31 23:59:59 z", "1999-12-31T23:59:59.000Z"),
            ("decimal 7 50", "1950-12-07T00:00:00.000Z"),
            ("1/1/2020 24:00", "2020-01-02T00:00:00.000Z"),
            ("2026-01-01 junk", "2026-06-01T00:00:00.000Z"),
            ("1:2:3:4:5", "2001-05-01T01:02:03.004Z"),
        ] {
            assert_eq!(iso_of(text).as_deref(), Some(iso), "{text}");
        }
        for text in ["", "apple", "May", "noon", "T", "Item5", "1 a", "2026-13-01T00:00Z", "1/2/3/4", "13/13/2026", "12:00 +12345", "2020-01-01 12:00 +700000:", "12 pm 13:00", "1/1/2020 24:01", "Jan 1 2020\u{2028}"] {
            assert_eq!(iso_of(text), None, "{text}");
        }
        assert_eq!(parse("2020-01-01 12:00 +400000:", LocalZone::UTC), Some(137_880_000_000.0));
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
