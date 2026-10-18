//! Routing read from source: every `listen … fire …` across the project's
//! files is the routing table (as movement-engine's
//! `movement/file_listeners.ts` reads it), plus the scope gate an inbound event must
//! clear to reach a listen (`triggers/listen_config.ts`) and the trigger
//! event a run is handed (`triggers/trigger_event.ts`, with
//! `engine/inbound/discriminate.ts`).

use std::collections::HashMap;

use movement_parser::ast::{NamedArg, RValue, Statement};
use movement_parser::util::form::external_text;
use serde_json::Value as Json;

use crate::check::parse;
use crate::json::{Js, Obj};
use crate::sources::MovementFile;
use crate::wire::js_of_json;

/// One `listen` statement, with its instance's construction resolved (`FileListener`).
#[derive(Debug, Clone)]
pub struct Listen {
    /// The file it is in, by its index in the project's files.
    pub file: usize,
    /// The adapter slug (the construction's callee, import alias resolved).
    pub adapter: String,
    /// The listen's config block, statically evaluated.
    pub config: Obj,
    pub movement_name: String,
}

/// `configValueOf`: a listen config value, statically evaluated; anything
/// that does not reduce to a static value keeps its raw text.
fn config_value_of(arg: &NamedArg) -> Js {
    let raw = external_text(&arg.value.raw).into_owned();
    if arg.is_type == Some(true) {
        return Js::Str(raw.trim().to_string());
    }
    let lowered = movement_parser::parse_expression(&arg.value.raw, 0)
        .ok()
        .and_then(|tree| movement_parser::lowering::lower_expression_json(&tree, &arg.value.raw).ok());
    let Some(lowered) = lowered else { return Js::Str(raw.trim().to_string()) };
    let static_value = |e: &Json| -> Option<Js> {
        match e.get("type").and_then(Json::as_str) {
            Some("static") => Some(external_js(e.get("value").unwrap_or(&Json::Null))),
            _ => None,
        }
    };
    if let Some(value) = static_value(&lowered) {
        return value;
    }
    if lowered.get("type").and_then(Json::as_str) == Some("list")
        && let Some(elements) = lowered.get("elements").and_then(Json::as_array)
    {
        let read: Option<Vec<Js>> = elements
            .iter()
            .map(|e| match e.get("type").and_then(Json::as_str) {
                Some("static") => static_value(e),
                // `fields: [domains]` — bare names read as root-less property nodes.
                Some("property") => e.get("propertyTypeId").and_then(Json::as_str).map(|s| Js::Str(external_text(s).into_owned())),
                _ => None,
            })
            .collect();
        if let Some(read) = read {
            return Js::Arr(read);
        }
    }
    Js::Str(raw.trim().to_string())
}

/// A lowered static's value, its texts out of the engine's form.
fn external_js(value: &Json) -> Js {
    match value {
        Json::String(s) => Js::Str(external_text(s).into_owned()),
        other => js_of_json(other),
    }
}

/// `collectListens`: every listen across the files. A file that does not
/// parse routes nothing (`check` says why).
pub fn collect_listens(files: &[MovementFile], language_version: u32) -> Vec<Listen> {
    let mut listens = Vec::new();
    for (index, file) in files.iter().enumerate() {
        let Ok(program) = parse(&file.source, language_version) else { continue };
        let mut originals: HashMap<String, String> = HashMap::new();
        // Each instance's adapter, by the instance's name. (The construction's
        // credential is not part of a local listen: the run resolves it.)
        let mut constructions: HashMap<String, String> = HashMap::new();
        let mut declared = Vec::new();
        for statement in &program.statements {
            match statement {
                Statement::Import(import) => {
                    for name in &import.names {
                        if let Some(alias) = &name.alias {
                            originals.insert(alias.clone(), name.name.clone());
                        }
                    }
                }
                Statement::Assign(assign) => {
                    if let RValue::Construct { construct } = &assign.value {
                        let adapter = originals.get(&construct.callee).cloned().unwrap_or_else(|| construct.callee.clone());
                        constructions.insert(assign.name.clone(), adapter);
                    }
                }
                Statement::Listen(listen) => declared.push(listen),
                _ => {}
            }
        }
        for listen in declared {
            // A unit the file does not bind itself is the host's own.
            let unit = movement_parser::version::run_host_units(language_version).iter().find(|u| **u == listen.instance).map(|u| u.to_string());
            let Some(adapter) = constructions.get(&listen.instance).cloned().or(unit) else { continue };
            let mut config = Obj::new();
            for arg in &listen.config {
                config.insert(arg.name.clone(), config_value_of(arg));
            }
            listens.push(Listen {
                file: index,
                adapter,
                config,
                movement_name: listen.movement.clone(),
            });
        }
    }
    listens
}

/// `eventConfigList`.
fn event_config_list(events: Option<&Js>) -> Vec<String> {
    match events {
        Some(Js::Arr(items)) => items.iter().filter_map(Js::as_str).map(str::to_string).collect(),
        Some(Js::Str(s)) => vec![s.clone()],
        _ => Vec::new(),
    }
}

/// `eventMatchesTriggerScope`: the listen's chosen events, and an
/// Airtable-style table scope.
pub fn event_matches_trigger_scope(event: &Js, config: &Obj) -> bool {
    let events = event_config_list(config.get("events"));
    if !events.is_empty() {
        match event.get("eventType").and_then(Js::as_str) {
            Some(t) if events.iter().any(|e| e == t) => {}
            _ => return false,
        }
    }
    if let Some(Js::Str(table)) = config.get("table")
        && !table.is_empty()
        && let Some(record_type) = event.get("recordType")
        && record_type.as_str() != Some(table.as_str())
    {
        return false;
    }
    true
}

/// `readPath`.
fn read_path<'a>(value: &'a Js, path: &str) -> Option<&'a Js> {
    path.split('.').try_fold(value, |at, key| at.get(key))
}

/// `discriminateEvent`'s choice: the event type the event is.
fn select_event_type<'a>(event: &Js, event_types: &'a [Js]) -> Option<&'a Js> {
    if let Some(tag) = event.get("tag") {
        return event_types.iter().find(|t| t.get("tag") == Some(tag));
    }
    let payload = event.get("payload").unwrap_or(&Js::Null);
    event_types.iter().find(|t| {
        let Some(matcher) = t.get("match") else { return false };
        let path = matcher.get("path").and_then(Js::as_str).unwrap_or_default();
        let Some(Js::Str(value)) = read_path(payload, path) else { return false };
        match matcher.get("equals") {
            Some(Js::Arr(options)) => options.iter().any(|o| o.as_str() == Some(value)),
            Some(Js::Str(equals)) => equals == value,
            _ => false,
        }
    })
}

/// `triggerEventOf`: the event as a run is handed it.
pub fn trigger_event_of(pipeline_input_id: &str, adapter_type: &str, event: &Js, event_types: &[Js], now: &str) -> Js {
    let root_record_type =
        if event_types.is_empty() { None } else { select_event_type(event, event_types).and_then(|t| t.get("positionType")).cloned() };
    let external_type = event.get("recordType").cloned().or_else(|| root_record_type.clone());
    let truthy = |v: &Js| !matches!(v, Js::Null | Js::Bool(false)) && v.as_str() != Some("");
    let mut out = Obj::new();
    out.insert("pipelineInputId".into(), Js::str(pipeline_input_id));
    out.insert("adapterType".into(), Js::str(adapter_type));
    out.insert("triggerType".into(), Js::str("webhook"));
    if let Some(payload) = event.get("payload") {
        out.insert("payload".into(), payload.clone());
    }
    if let Some(change) = event.get("changeType").filter(|v| truthy(v)) {
        out.insert("changeType".into(), change.clone());
    }
    if let Some(root) = root_record_type.filter(truthy) {
        out.insert("rootRecordType".into(), root);
    }
    if let Some(external_id) = event.get("externalId") {
        let mut reference = Obj::new();
        reference.insert("adapterType".into(), Js::str(adapter_type));
        reference.insert("externalId".into(), external_id.clone());
        if let Some(record_type) = external_type.filter(truthy) {
            reference.insert("recordType".into(), record_type);
        }
        out.insert("externalRecordRef".into(), Js::Obj(reference));
    }
    for key in ["actor", "changedFields", "idempotencyKey"] {
        if let Some(value) = event.get(key).filter(|v| truthy(v)) {
            out.insert(key.into(), value.clone());
        }
    }
    out.insert("occurredAt".into(), event.get("occurredAt").filter(|v| !matches!(v, Js::Null)).cloned().unwrap_or_else(|| Js::str(now)));
    Js::Obj(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn js(text: &str) -> Js {
        Js::parse(text.as_bytes()).unwrap()
    }

    #[test]
    fn a_listen_is_read_with_its_construction_and_static_config() {
        let source = "import { acme_crm as crm_kind } from adapters\nimport { acme } from credentials\n\ncrm = connect crm_kind using acme\n\nfunction welcome(company: <crm-[:Company]->>) {\n  write crm-[:Company]-> { Name: \"x\" }\n}\n\nlisten to crm { events: [\"company.created\"] } fire welcome\n";
        let files = vec![MovementFile { name: "companies".into(), path: PathBuf::from("companies.mvt"), source: source.into() }];
        let listens = collect_listens(&files, 5);
        assert_eq!(listens.len(), 1);
        let listen = &listens[0];
        assert_eq!((listen.adapter.as_str(), listen.movement_name.as_str()), ("acme_crm", "welcome"));
        assert_eq!(Js::Obj(listen.config.clone()).to_json(), r#"{"events":["company.created"]}"#);
    }

    #[test]
    fn the_scope_gate_reads_the_chosen_events_and_the_table() {
        let config = match js(r#"{"events":["company.created"]}"#) {
            Js::Obj(map) => map,
            _ => unreachable!(),
        };
        assert!(event_matches_trigger_scope(&js(r#"{"eventType":"company.created"}"#), &config));
        assert!(!event_matches_trigger_scope(&js(r#"{"eventType":"company.updated"}"#), &config));
        assert!(!event_matches_trigger_scope(&js(r#"{}"#), &config));
        assert!(event_matches_trigger_scope(&js(r#"{}"#), &Obj::new()));
    }

    #[test]
    fn the_trigger_event_is_built_in_the_typescript_order() {
        let event = js(r#"{"payload":{"id":"c-1"},"externalId":"c-1","eventType":"company.created","changeType":"create","recordType":"Company"}"#);
        let types = vec![js(r#"{"tag":"company.created","positionType":"Company"}"#)];
        assert_eq!(
            trigger_event_of("listen:companies:welcome", "acme_crm", &event, &types, "2026-10-17T00:00:00.000Z").to_json(),
            r#"{"pipelineInputId":"listen:companies:welcome","adapterType":"acme_crm","triggerType":"webhook","payload":{"id":"c-1"},"changeType":"create","externalRecordRef":{"adapterType":"acme_crm","externalId":"c-1","recordType":"Company"},"occurredAt":"2026-10-17T00:00:00.000Z"}"#
        );
        let tagged = js(r#"{"payload":{},"tag":"company.created"}"#);
        assert_eq!(trigger_event_of("p", "a", &tagged, &types, "t").get("rootRecordType").and_then(Js::as_str), Some("Company"));
    }
}
