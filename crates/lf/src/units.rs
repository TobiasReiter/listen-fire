//! The run host's units (Henry 2026-10-16): `cron` and `manual`, in every
//! file's scope from language version 5 with no import
//! (movement_parser::version::RUN_HOST_UNITS). lf builds them in, as the
//! platform does (apps/api translation_graph/adapters/{cron,manual}): their
//! catalog entries, the in-process adapter a run reads its event through, the
//! event `lf run <movement>` fires on a manual listen, and the ticks `lf serve`
//! and `lf drain` fire on a cron listen.
//!
//! A project external of the same name replaces the unit.

use serde_json::json;

use crate::json::{Js, Obj};
use crate::obj;
use crate::wire::{Hv, js_of_json};

pub const CRON: &str = "cron";
pub const MANUAL: &str = "manual";

/// The unit `name` is, when no external of the project takes the name.
pub fn unit_named<'a>(name: &str, externals: impl IntoIterator<Item = &'a str>) -> Option<&'static str> {
    let unit = movement_parser::version::RUN_HOST_UNITS.iter().copied().find(|u| *u == name)?;
    (!externals.into_iter().any(|e| e == unit)).then_some(unit)
}

/// What the unit's manifest says of its listens (`listenConfig`,
/// `subscribableEvents`), as an external's manifest says it.
pub fn listen_vocabulary(unit: &str) -> Obj {
    js_obj(match unit {
        CRON => json!({
            "subscribableEvents": ["tick"],
            "listenConfig": [
                { "key": "schedule", "required": true, "format": "cron" },
                { "key": "timezone", "required": false, "format": "timezone" },
            ],
        }),
        _ => json!({}),
    })
}

/// `listEntryPoints`.
pub fn entry_points(unit: &str) -> Vec<Js> {
    let entries = match unit {
        CRON => json!([{ "typeId": "tick", "displayName": "Tick", "writable": false, "readable": false, "fires": true }]),
        _ => json!([
            { "typeId": "invocation", "displayName": "Invocation", "writable": false, "readable": false, "fires": true },
            { "typeId": "file", "displayName": "File", "writable": false, "readable": false },
        ]),
    };
    entries.as_array().map(|a| a.iter().map(js_of_json).collect()).unwrap_or_default()
}

/// `describe`, by type id or display name; `None` for a type the unit lacks.
pub fn describe(unit: &str, type_ref: &str) -> Option<Js> {
    descriptors(unit).into_iter().find(|d| [d.get("typeId"), d.get("displayName")].iter().any(|v| v.and_then(Js::as_str) == Some(type_ref)))
}

/// Every type the unit describes, by type id (the catalog's projection input).
pub fn descriptors(unit: &str) -> Vec<Js> {
    let field = |id: &str, name: &str, kind: &str, required: bool| json!({ "fieldId": id, "displayName": name, "kind": kind, "writable": false, "required": required });
    let list = match unit {
        CRON => vec![json!({
            "typeId": "tick",
            "displayName": "Tick",
            "description": "One scheduled firing — when it was due, and on which schedule.",
            "fields": [field("firedAt", "Fired at", "date", true), field("schedule", "Schedule", "string", true)],
            "references": [],
        })],
        _ => vec![
            json!({
                "typeId": "invocation",
                "displayName": "Invocation",
                "description": "One Run-now press — when, by whom, and any text or files supplied.",
                "fields": [
                    field("firedAt", "Fired at", "date", true),
                    field("actorEmail", "Run by (email)", "string", false),
                    field("actorName", "Run by (name)", "string", false),
                    field("text", "Text", "string", false),
                    field("content", "Content", "string", false),
                ],
                "references": [{ "fieldId": "files", "targetTypeId": "file", "cardinality": "many", "direction": "outgoing", "name": "Files", "writable": false }],
            }),
            json!({
                "typeId": "file",
                "displayName": "File",
                "fields": [
                    field("name", "Name", "string", true),
                    field("contentType", "Content Type", "string", true),
                    field("size", "Size", "number", false),
                ],
                "references": [],
            }),
        ],
    };
    list.iter().map(js_of_json).collect()
}

/// The type an unstable event position resolves to (`webhookEventTypeId`).
pub fn event_type_id(unit: &str) -> &'static str {
    if unit == CRON { "tick" } else { "invocation" }
}

/// The methods the unit's in-process adapter answers.
pub const METHODS: &[&str] = &["listEntryPoints", "describe", "getFieldValue", "getRelated"];

/// One adapter call on the unit: `listEntryPoints`, `describe`, and the
/// event's fields read off its position's data; nothing is related (a file
/// supplied to a manual run is the platform's; lf supplies none).
pub fn call(unit: &str, method: &str, args: &Hv) -> Result<Js, String> {
    match method {
        "listEntryPoints" => Ok(Js::Arr(entry_points(unit))),
        "describe" => Ok(describe(unit, args.get("typeId").and_then(Hv::as_str).unwrap_or_default()).unwrap_or(Js::Null)),
        "getFieldValue" => {
            let position = args.get("position").map(Hv::js).unwrap_or(Js::Null);
            let record_type = position.get("recordType").and_then(Js::as_str).unwrap_or(event_type_id(unit));
            let written = args.get("fieldId").and_then(Hv::as_str).unwrap_or_default();
            let descriptor = describe(unit, record_type);
            let fields = descriptor.as_ref().and_then(|d| d.get("fields")).and_then(Js::as_array).unwrap_or(&[]);
            let field_id = fields
                .iter()
                .find(|f| [f.get("fieldId"), f.get("displayName")].iter().any(|v| v.and_then(Js::as_str) == Some(written)))
                .and_then(|f| f.get("fieldId").and_then(Js::as_str))
                .unwrap_or(written)
                .to_string();
            let data = position.get("identity").and_then(|i| i.get("data")).cloned().unwrap_or(Js::Null);
            Ok(match (unit, field_id.as_str()) {
                (MANUAL, "content") => data.get("text").cloned().unwrap_or(Js::str("")),
                _ => data.get(&field_id).cloned().unwrap_or(Js::Null),
            })
        }
        "getRelated" => Ok(Js::Arr(Vec::new())),
        other => Err(format!("the '{unit}' unit does not implement {other}")),
    }
}

/// The event a manual run is: when it was asked for, by whom, and the text
/// given with it.
pub fn manual_event(fired_at: &str, user: &Js, text: Option<&str>) -> Js {
    let mut payload = obj! { "firedAt" => Js::str(fired_at) };
    if let Some(email) = user.get("email").and_then(Js::as_str) {
        payload.insert("actorEmail".into(), Js::str(email));
    }
    if let Some(name) = user.get("principal").and_then(|p| p.get("display")).and_then(Js::as_str) {
        payload.insert("actorName".into(), Js::str(name));
    }
    if let Some(text) = text {
        payload.insert("text".into(), Js::str(text));
    }
    Js::Obj(obj! { "payload" => Js::Obj(payload) })
}

/// The event one cron occurrence is. Its idempotency key is the schedule's
/// occurrence, so however many workers find it due, a listen runs it once.
pub fn tick_event(fired_at: &str, schedule: &str, timezone: Option<&str>) -> Js {
    Js::Obj(obj! {
        "payload" => Js::Obj(obj! { "firedAt" => Js::str(fired_at), "schedule" => Js::str(schedule) }),
        "idempotencyKey" => Js::Str(format!("tick:{schedule}:{}:{fired_at}", timezone.unwrap_or("UTC"))),
    })
}

fn js_obj(value: serde_json::Value) -> Obj {
    match js_of_json(&value) {
        Js::Obj(map) => map,
        _ => Obj::new(),
    }
}

/// A cron listen's schedule, read as packages/shared/cron reads it (five
/// fields, names for months and weekdays, 7 also Sunday; both day fields
/// restricted means either matches), in the listen's zone or UTC.
pub struct Schedule {
    minutes: Vec<bool>,
    hours: Vec<bool>,
    days_of_month: Vec<bool>,
    months: Vec<bool>,
    days_of_week: Vec<bool>,
    any_day_of_month: bool,
    any_day_of_week: bool,
    zone: jiff::tz::TimeZone,
}

const MONTHS: &[&str] = &["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS: &[&str] = &["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/// One field's values, `min..=max`, and whether it is `*`.
fn field(text: &str, min: usize, max: usize, names: &[&str], first_name: usize) -> Result<(Vec<bool>, bool), String> {
    let value = |s: &str| -> Result<usize, String> {
        if let Some(i) = names.iter().position(|n| n.eq_ignore_ascii_case(s)) {
            return Ok(i + first_name);
        }
        s.parse::<usize>().ok().filter(|n| (min..=max).contains(n)).ok_or_else(|| format!("'{s}' is not a value in {min}-{max}"))
    };
    let mut set = vec![false; max + 1];
    for item in text.split(',') {
        let (range, step) = match item.split_once('/') {
            Some((range, step)) => (range, step.parse::<usize>().ok().filter(|s| *s > 0).ok_or_else(|| format!("'{step}' is not a step"))?),
            None => (item, 1),
        };
        let (from, to) = match range {
            "*" => (min, max),
            r => match r.split_once('-') {
                Some((a, b)) => (value(a)?, value(b)?),
                None if step > 1 => (value(r)?, max),
                None => (value(r)?, value(r)?),
            },
        };
        if from > to {
            return Err(format!("range {range} runs backwards"));
        }
        for n in (from..=to).step_by(step) {
            set[n] = true;
        }
    }
    Ok((set, text == "*"))
}

pub fn parse_schedule(expression: &str, timezone: Option<&str>) -> Result<Schedule, String> {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    let [minute, hour, dom, month, dow] = fields.as_slice() else {
        return Err(format!("a schedule has five fields, got {}", fields.len()));
    };
    let (mut days_of_week, any_day_of_week) = field(dow, 0, 7, WEEKDAYS, 0)?;
    if days_of_week[7] {
        days_of_week[0] = true;
    }
    let (days_of_month, any_day_of_month) = field(dom, 1, 31, &[], 0)?;
    let zone = match timezone {
        Some(name) => jiff::tz::TimeZone::get(name).map_err(|e| format!("'{name}' is not a time zone: {e}"))?,
        None => jiff::tz::TimeZone::UTC,
    };
    Ok(Schedule {
        minutes: field(minute, 0, 59, &[], 0)?.0,
        hours: field(hour, 0, 23, &[], 0)?.0,
        days_of_month,
        months: field(month, 1, 12, MONTHS, 1)?.0,
        days_of_week,
        any_day_of_month,
        any_day_of_week,
        zone,
    })
}

/// How far back a worker looks for a missed occurrence.
const LOOKBACK_MINUTES: i64 = 366 * 24 * 60;

impl Schedule {
    /// Whether the minute starting at `ms` is an occurrence.
    fn matches(&self, ms: i64) -> bool {
        let Ok(at) = jiff::Timestamp::from_millisecond(ms) else { return false };
        let local = at.to_zoned(self.zone.clone());
        let (dom, dow) = (self.days_of_month[local.day() as usize], self.days_of_week[local.weekday().to_sunday_zero_offset() as usize]);
        let day = match (self.any_day_of_month, self.any_day_of_week) {
            (false, false) => dom || dow,
            (false, true) => dom,
            (true, false) => dow,
            (true, true) => true,
        };
        day && self.minutes[local.minute() as usize] && self.hours[local.hour() as usize] && self.months[local.month() as usize]
    }

    /// The latest occurrence after `after_ms` and no later than `until_ms`
    /// (each a minute's start), when there is one.
    pub fn latest_in(&self, after_ms: i64, until_ms: i64) -> Option<i64> {
        let mut at = until_ms - until_ms.rem_euclid(60_000);
        let floor = after_ms.max(until_ms - LOOKBACK_MINUTES * 60_000);
        while at > floor {
            if self.matches(at) {
                return Some(at);
            }
            at -= 60_000;
        }
        None
    }
}

/// An instant as `Date.prototype.toISOString` writes it.
pub fn iso_of(ms: i64) -> String {
    let ts = jiff::Timestamp::from_millisecond(ms).unwrap_or(jiff::Timestamp::UNIX_EPOCH);
    format!("{}.{:03}Z", ts.strftime("%Y-%m-%dT%H:%M:%S"), ms.rem_euclid(1000))
}

/// An ISO instant's milliseconds.
pub fn ms_of(iso: &str) -> Option<i64> {
    iso.parse::<jiff::Timestamp>().ok().map(|t| t.as_millisecond())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(iso: &str) -> i64 {
        ms_of(iso).unwrap()
    }

    #[test]
    fn the_latest_occurrence_in_a_window_is_the_one_a_worker_fires() {
        let weekly = parse_schedule("0 9 * * mon", None).unwrap();
        // 2026-10-12 and 2026-10-19 are Mondays.
        assert_eq!(weekly.latest_in(at("2026-10-01T00:00:00Z"), at("2026-10-18T00:00:00Z")).map(iso_of).as_deref(), Some("2026-10-12T09:00:00.000Z"));
        assert_eq!(weekly.latest_in(at("2026-10-12T09:00:00Z"), at("2026-10-18T00:00:00Z")), None);
        let every_five = parse_schedule("*/5 * * * *", None).unwrap();
        assert_eq!(every_five.latest_in(at("2026-10-18T10:00:00Z"), at("2026-10-18T10:07:30Z")).map(iso_of).as_deref(), Some("2026-10-18T10:05:00.000Z"));
    }

    #[test]
    fn a_zoned_schedule_is_wall_clock_time_there() {
        let london = parse_schedule("0 9 * * *", Some("Europe/London")).unwrap();
        // British Summer Time: 09:00 in London is 08:00 UTC.
        assert_eq!(london.latest_in(at("2026-07-01T00:00:00Z"), at("2026-07-01T12:00:00Z")).map(iso_of).as_deref(), Some("2026-07-01T08:00:00.000Z"));
    }

    #[test]
    fn both_day_fields_restricted_match_either() {
        let s = parse_schedule("0 0 1 * fri", None).unwrap();
        // 2026-10-16 is a Friday (a Thursday is the first).
        assert_eq!(s.latest_in(at("2026-10-02T00:00:00Z"), at("2026-10-17T00:00:00Z")).map(iso_of).as_deref(), Some("2026-10-16T00:00:00.000Z"));
        assert_eq!(s.latest_in(at("2026-09-30T00:00:00Z"), at("2026-10-01T12:00:00Z")).map(iso_of).as_deref(), Some("2026-10-01T00:00:00.000Z"));
    }
}
