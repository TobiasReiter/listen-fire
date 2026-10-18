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

/// The event one cron occurrence is. Its idempotency key is the occurrence,
/// so two workers firing it run it once.
pub fn tick_event(fired_at: &str, schedule: &str) -> Js {
    Js::Obj(obj! {
        "payload" => Js::Obj(obj! { "firedAt" => Js::str(fired_at), "schedule" => Js::str(schedule) }),
        "idempotencyKey" => Js::Str(format!("tick:{fired_at}")),
    })
}

fn js_obj(value: serde_json::Value) -> Obj {
    match js_of_json(&value) {
        Js::Obj(map) => map,
        _ => Obj::new(),
    }
}
