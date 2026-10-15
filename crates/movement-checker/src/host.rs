//! The environment services the checker asks its host for (DESIGN: an
//! environment service is a host service behind a trait). The TypeScript
//! checker reads them off its JavaScript runtime; this crate never carries
//! their data itself, so the WASM artifact stays free of a zone database.
//!
//! - In the engine (native and WASM), the engine's own environment services
//!   answer (`movement_engine::env_services`): on WASM the loader's `Intl`,
//!   natively the `jiff` zone database. That is the production answer.
//! - Natively, `native::NativeZones` (the `native-zones` feature, on by
//!   default and inert on wasm32) answers from the same pinned `jiff` zone
//!   data, for this crate's tests and the parity harness.

/// The zone database: which time zones the host's runtime recognises.
pub trait ZoneLookup {
    /// `isValidTimeZone` (packages/shared/cron): whether `Intl.DateTimeFormat`
    /// accepts `zone` as its `timeZone`.
    fn is_zone(&self, zone: &str) -> bool;
}

/// `cronTimezoneError`: why `zone` is no time zone, or `None` when it is one.
pub fn time_zone_error(zones: &dyn ZoneLookup, zone: &str) -> Option<String> {
    (zone.is_empty() || !zones.is_zone(zone))
        .then(|| format!("'{zone}' is not a recognised IANA time zone (e.g. \"Europe/London\", \"America/New_York\", \"UTC\")"))
}

#[cfg(all(not(target_arch = "wasm32"), feature = "native-zones"))]
pub mod native {
    use jiff::tz::{Offset, TimeZone};

    use super::ZoneLookup;

    /// The `jiff` zone database, pinned to the zone data Node's ICU carries
    /// (the engine's `native-env` pin). Reads a zone as the engine's native
    /// environment services do (`zone_of` there): an IANA name in any case,
    /// or an offset `±HH`, `±HHMM`, `±HH:MM`.
    pub struct NativeZones;

    impl ZoneLookup for NativeZones {
        fn is_zone(&self, zone: &str) -> bool {
            if offset_zone(zone).is_some() {
                return true;
            }
            // `Intl` takes the IANA names and nothing looser: no surrounding
            // space, no path tricks.
            if zone.is_empty() || !zone.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-' | b'+')) {
                return false;
            }
            // `Factory` is in the IANA files but not among ICU's zones.
            if zone.eq_ignore_ascii_case("Factory") {
                return false;
            }
            TimeZone::get(zone).is_ok()
        }
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
}
