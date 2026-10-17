//! The services of the environment the engine runs in that the language
//! leans on and that JavaScript carries in its runtime: the zone database
//! (`Intl.DateTimeFormat`), WHATWG URL parsing (`new URL`), locale number
//! formatting (`Intl.NumberFormat`) and Unicode normalisation
//! (`String.prototype.normalize`).
//!
//! The engine asks for them through `EnvServices`, which has two
//! implementations with one set of answers:
//!
//! - in the WASM artifact, `HostImports`: a synchronous import the loader
//!   provides (packages/movement-lang/wasm/env_services.ts), which answers
//!   from the JavaScript runtime itself, so the TypeScript engine and the
//!   Rust one read zones, URLs and text identically by construction;
//! - natively (the `native-env` feature), `Native`: the `jiff` zone
//!   database, the `url` crate, and ICU4X's normaliser and decimal
//!   formatter. `tests/env_services.rs` holds it to Node's own answers
//!   (tests/env/fixture.json, written by tests/env/generate.ts through the
//!   very module the loader imports).
//!
//! Each operation is one JSON request, `{op, …args}`, answered `{value}`:
//! that is the import's wire, and the fixture's.

use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};

/// The wall-clock reading of an instant in a zone, as
/// `Intl.DateTimeFormat('en-US', {timeZone, hourCycle: 'h23', …})`'s parts
/// give it (the year of its era: 1 BC is 1). `weekday` is 0 for Sunday; `offset_minutes` is the reading less
/// the instant (fractional for a local mean time).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZonedFields {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    pub millisecond: i64,
    pub offset_minutes: f64,
    pub weekday: i64,
}

/// A WHATWG URL's components, as `new URL(text)` names them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UrlParts {
    pub href: String,
    pub protocol: String,
    pub username: String,
    pub password: String,
    pub host: String,
    pub hostname: String,
    pub port: String,
    pub pathname: String,
    pub search: String,
    pub hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NormalForm {
    #[serde(rename = "NFC")]
    Nfc,
    #[serde(rename = "NFD")]
    Nfd,
    #[serde(rename = "NFKC")]
    Nfkc,
    #[serde(rename = "NFKD")]
    Nfkd,
}

pub trait EnvServices {
    /// `instant_iso` (a `toISOString` text) read on the wall clock of
    /// `zone`, or `None` where `zone` is not one `Intl` accepts.
    fn tz_convert(&self, instant_iso: &str, zone: &str) -> Option<ZonedFields>;
    /// `new URL(text)`, or `None` where it throws.
    fn url_parse(&self, text: &str) -> Option<UrlParts>;
    /// `text.normalize(form)`.
    fn normalize(&self, text: &str, form: NormalForm) -> String;
}

/// One request on the wire.
pub fn request_json(op: &Op<'_>) -> Json {
    match op {
        Op::TzConvert { instant_iso, zone } => json!({ "op": "tz_convert", "instantIso": instant_iso, "zone": zone }),
        Op::UrlParse { text } => json!({ "op": "url_parse", "text": text }),
        Op::Normalize { text, form } => json!({ "op": "normalize", "text": text, "form": form }),
    }
}

/// The operations, as data: what a request carries.
#[derive(Debug, Clone)]
pub enum Op<'a> {
    TzConvert { instant_iso: &'a str, zone: &'a str },
    UrlParse { text: &'a str },
    Normalize { text: &'a str, form: NormalForm },
}

impl Op<'_> {
    /// Read from its wire form (the fixture's inputs).
    pub fn answer_with(request: &Json, services: &dyn EnvServices) -> Result<Json, String> {
        let text = |name: &str| request.get(name).and_then(Json::as_str).ok_or_else(|| format!("{request} has no `{name}`"));
        Ok(match text("op")? {
            "tz_convert" => json!(services.tz_convert(text("instantIso")?, text("zone")?)),
            "url_parse" => json!(services.url_parse(text("text")?)),
            "normalize" => {
                let form: NormalForm = serde_json::from_value(json!(text("form")?)).map_err(|e| e.to_string())?;
                json!(services.normalize(text("text")?, form))
            }
            other => return Err(format!("no environment service `{other}`")),
        })
    }
}

/// The services of wherever this engine was built to run.
pub fn current() -> &'static dyn EnvServices {
    #[cfg(target_arch = "wasm32")]
    {
        &HostImports
    }
    #[cfg(all(not(target_arch = "wasm32"), feature = "native-env"))]
    {
        &native::Native
    }
    #[cfg(all(not(target_arch = "wasm32"), not(feature = "native-env")))]
    {
        &Missing
    }
}

/// The checker's zone database (`movement_checker::host::ZoneLookup`): a
/// zone is one `Intl` accepts exactly when it can read an instant there,
/// which is `isValidTimeZone`'s own probe (constructing the formatter).
pub struct EnvZones;

impl movement_checker::host::ZoneLookup for EnvZones {
    fn is_zone(&self, zone: &str) -> bool {
        current().tz_convert("1970-01-01T00:00:00.000Z", zone).is_some()
    }
}

/// A native build without `native-env`: no zone database, URL parser or
/// Unicode data to answer from.
#[cfg(all(not(target_arch = "wasm32"), not(feature = "native-env")))]
struct Missing;

#[cfg(all(not(target_arch = "wasm32"), not(feature = "native-env")))]
impl EnvServices for Missing {
    fn tz_convert(&self, _: &str, _: &str) -> Option<ZonedFields> {
        panic!("this movement engine was built without its environment services (the native-env feature)")
    }
    fn url_parse(&self, _: &str) -> Option<UrlParts> {
        panic!("this movement engine was built without its environment services (the native-env feature)")
    }
    fn normalize(&self, _: &str, _: NormalForm) -> String {
        panic!("this movement engine was built without its environment services (the native-env feature)")
    }
}

// ── The WASM artifact: the loader's import ──────────────────────────────────

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "movement_env")]
unsafe extern "C" {
    /// One request's JSON in; the `{value}` reply written to a buffer the
    /// import allocates with this module's `alloc`, through the two out
    /// slots. Status 0, or 1 for a request it could not read.
    #[link_name = "call"]
    fn env_call(request_ptr: *const u8, request_len: u32, out_ptr_ptr: *mut usize, out_len_ptr: *mut usize) -> u32;
}

#[cfg(target_arch = "wasm32")]
struct HostImports;

#[cfg(target_arch = "wasm32")]
impl HostImports {
    fn ask<T: serde::de::DeserializeOwned>(&self, op: &Op<'_>) -> T {
        let request = serde_json::to_string(&request_json(op)).expect("a JSON value serializes");
        let (mut out_ptr, mut out_len) = (0usize, 0usize);
        let status = unsafe { env_call(request.as_ptr(), request.len() as u32, &mut out_ptr, &mut out_len) };
        let bytes = unsafe { std::slice::from_raw_parts(out_ptr as *const u8, out_len) }.to_vec();
        unsafe { movement_parser::abi::dealloc(out_ptr as *mut u8, out_len as u32) };
        let reply: Json = crate::js_string::from_json_text(std::str::from_utf8(&bytes).expect("the environment import answers UTF-8")).expect("the environment import answers JSON");
        assert!(status == 0, "the environment import refused {request}: {reply}");
        serde_json::from_value(reply.get("value").cloned().unwrap_or(Json::Null))
            .unwrap_or_else(|e| panic!("the environment import answered {request} with {reply}: {e}"))
    }
}

#[cfg(target_arch = "wasm32")]
impl EnvServices for HostImports {
    fn tz_convert(&self, instant_iso: &str, zone: &str) -> Option<ZonedFields> {
        self.ask(&Op::TzConvert { instant_iso, zone })
    }
    fn url_parse(&self, text: &str) -> Option<UrlParts> {
        self.ask(&Op::UrlParse { text })
    }
    fn normalize(&self, text: &str, form: NormalForm) -> String {
        self.ask(&Op::Normalize { text, form })
    }
}

// ── Native: jiff, url, ICU4X ────────────────────────────────────────────────

#[cfg(all(not(target_arch = "wasm32"), feature = "native-env"))]
pub mod native {
    use icu_normalizer::{ComposingNormalizerBorrowed, DecomposingNormalizerBorrowed};
    use jiff::Timestamp;
    use jiff::tz::{Offset, TimeZone};

    use super::{EnvServices, NormalForm, UrlParts, ZonedFields};
    use crate::js_date;

    pub struct Native;

    /// The zone `Intl` reads `zone` as: an IANA name in any case, or an
    /// offset `±HH`, `±HHMM`, `±HH:MM`.
    fn zone_of(zone: &str) -> Option<TimeZone> {
        if let Some(offset) = offset_zone(zone) {
            return Some(TimeZone::fixed(offset));
        }
        // `Intl` takes the IANA names and nothing looser: no surrounding
        // space, no path tricks.
        if zone.is_empty() || !zone.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-' | b'+')) {
            return None;
        }
        // `Factory` is in the IANA files but not among ICU's zones.
        if zone.eq_ignore_ascii_case("Factory") {
            return None;
        }
        TimeZone::get(zone).ok()
    }

    /// The zone data this implementation reads, as `process.versions.tz`
    /// names it.
    pub fn tz_version() -> Option<&'static str> {
        jiff_tzdb::VERSION
    }

    fn offset_zone(zone: &str) -> Option<Offset> {
        let b = zone.as_bytes();
        let sign = match b.first()? {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        let digits = |s: &[u8]| s.iter().all(u8::is_ascii_digit).then(|| std::str::from_utf8(s).ok()?.parse::<i32>().ok()).flatten();
        let (hours, minutes) = match &b[1..] {
            [h1, h2] => (digits(&[*h1, *h2])?, 0),
            [h1, h2, m1, m2] => (digits(&[*h1, *h2])?, digits(&[*m1, *m2])?),
            [h1, h2, b':', m1, m2] => (digits(&[*h1, *h2])?, digits(&[*m1, *m2])?),
            _ => return None,
        };
        if hours > 23 || minutes > 59 {
            return None;
        }
        Offset::from_seconds(sign * (hours * 3600 + minutes * 60)).ok()
    }

    /// WHATWG fails a non-special URL whose authority holds a `\\` (a
    /// forbidden host code point, or a port that is not digits), where the
    /// `url` crate reads the backslash into the path.
    fn opaque_authority_has_backslash(text: &str) -> bool {
        let Some((_, rest)) = text.split_once("://") else { return false };
        rest.split(['/', '?', '#']).next().is_some_and(|authority| authority.contains('\\'))
    }

    /// A `toISOString` text's instant: `YYYY-MM-DDTHH:mm:ss.sssZ`, or with a
    /// signed six-digit year.
    fn iso_millis(iso: &str) -> Option<i64> {
        let (sign, rest) = match iso.as_bytes().first()? {
            b'+' => (1, &iso[1..]),
            b'-' => (-1, &iso[1..]),
            _ => (1, iso),
        };
        let (year, rest) = rest.split_once('-')?;
        let year = sign * year.parse::<i64>().ok()?;
        let n = |range: std::ops::Range<usize>| rest.get(range)?.parse::<i64>().ok();
        // MM-DDTHH:mm:ss.sssZ
        let days = js_date::days_from_civil(year, n(0..2)?, n(3..5)?);
        Some(days * 86_400_000 + n(6..8)? * 3_600_000 + n(9..11)? * 60_000 + n(12..14)? * 1000 + n(15..18)?)
    }

    impl EnvServices for Native {
        fn tz_convert(&self, instant_iso: &str, zone: &str) -> Option<ZonedFields> {
            let tz = zone_of(zone)?;
            let ms = iso_millis(instant_iso).unwrap_or_else(|| panic!("tz_convert is handed toISOString texts, not {instant_iso:?}"));
            let zoned = Timestamp::from_millisecond(ms).ok()?.to_zoned(tz);
            let dt = zoned.datetime();
            let millisecond = ms.rem_euclid(1000);
            // `Intl` writes the year of its era: 1 BC is year 1, not 0.
            let year = i64::from(dt.year());
            let year = if year <= 0 { 1 - year } else { year };
            let (month, day) = (i64::from(dt.month()), i64::from(dt.day()));
            let (hour, minute, second) = (i64::from(dt.hour()), i64::from(dt.minute()), i64::from(dt.second()));
            // The offset and the weekday are of that reading as `Date.UTC`
            // reads it back (years 0–99 as 19xx), as the TypeScript derives
            // them; before the common era they are the reading's, not the
            // instant's.
            let utc_year = if (0..=99).contains(&year) { 1900 + year } else { year };
            let days = js_date::days_from_civil(utc_year, month, day);
            let wall = days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000;
            Some(ZonedFields {
                year,
                month,
                day,
                hour,
                minute,
                second,
                millisecond,
                offset_minutes: (wall + millisecond - ms) as f64 / 60_000.0,
                weekday: (days + 4).rem_euclid(7),
            })
        }

        fn url_parse(&self, text: &str) -> Option<UrlParts> {
            let url = url::Url::parse(text).ok()?;
            if !url.is_special() && opaque_authority_has_backslash(text) {
                return None;
            }
            let hostname = url.host_str().unwrap_or("").to_string();
            let port = url.port().map(|p| p.to_string()).unwrap_or_default();
            let prefixed = |prefix: &str, part: Option<&str>| part.filter(|p| !p.is_empty()).map(|p| format!("{prefix}{p}")).unwrap_or_default();
            Some(UrlParts {
                href: url.as_str().to_string(),
                protocol: format!("{}:", url.scheme()),
                username: url.username().to_string(),
                password: url.password().unwrap_or("").to_string(),
                host: if port.is_empty() { hostname.clone() } else { format!("{hostname}:{port}") },
                hostname,
                port,
                pathname: url.path().to_string(),
                search: prefixed("?", url.query()),
                hash: prefixed("#", url.fragment()),
            })
        }

        fn normalize(&self, text: &str, form: NormalForm) -> String {
            match form {
                NormalForm::Nfc => ComposingNormalizerBorrowed::new_nfc().normalize(text).into_owned(),
                NormalForm::Nfkc => ComposingNormalizerBorrowed::new_nfkc().normalize(text).into_owned(),
                NormalForm::Nfd => DecomposingNormalizerBorrowed::new_nfd().normalize(text).into_owned(),
                NormalForm::Nfkd => DecomposingNormalizerBorrowed::new_nfkd().normalize(text).into_owned(),
            }
        }
    }
}
