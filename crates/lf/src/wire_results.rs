//! Every protocol result an external answers, validated as the TypeScript
//! client validates it (`parseWireResult` over `METHODS[method].result`,
//! packages/engine-contracts/protocol.ts): a process module's answer is a
//! safety boundary, so the check is always on. A schema here is a port of
//! the zod one, with zod's output: an object's declared keys in declaration
//! order (absent optional ones left out), then — for a `passthrough` object
//! only — its other keys in their own order; a stripping object drops them.
//! A refusal is worded as `RemoteResponseShapeError` words one: what came
//! back, then the first issue and its path.

use crate::json::{Js, Obj};
use crate::protocol::received;

#[derive(Clone)]
enum S {
    Unknown,
    Str,
    Num,
    Bool,
    Null,
    Literal(&'static str),
    LiteralTrue,
    Enum(&'static [&'static str]),
    Nullable(Box<S>),
    Array(Box<S>),
    Record(Box<S>),
    Object { fields: Vec<(&'static str, S, bool)>, passthrough: bool },
    Union(Vec<S>),
    /// A discriminated union: the member whose `key` literal the value names.
    Tagged { key: &'static str, members: Vec<(&'static str, S)> },
}

fn obj(fields: Vec<(&'static str, S, bool)>) -> S {
    S::Object { fields, passthrough: false }
}

fn loose(fields: Vec<(&'static str, S, bool)>) -> S {
    S::Object { fields, passthrough: true }
}

fn req(name: &'static str, s: S) -> (&'static str, S, bool) {
    (name, s, false)
}

fn opt(name: &'static str, s: S) -> (&'static str, S, bool) {
    (name, s, true)
}

fn arr(s: S) -> S {
    S::Array(Box::new(s))
}

fn nullable(s: S) -> S {
    S::Nullable(Box::new(s))
}

fn record(s: S) -> S {
    S::Record(Box::new(s))
}

/// `extend`: the base's fields with `more` added or replacing (zod keeps a
/// replaced key at its first place).
fn extend(base: S, more: Vec<(&'static str, S, bool)>, passthrough: Option<bool>) -> S {
    let S::Object { mut fields, passthrough: was } = base else { unreachable!("only an object is extended") };
    for field in more {
        match fields.iter_mut().find(|f| f.0 == field.0) {
            Some(existing) => *existing = field,
            None => fields.push(field),
        }
    }
    S::Object { fields, passthrough: passthrough.unwrap_or(was) }
}

// ── The protocol's shapes (protocol.ts), as far as results reach them ────────

fn position_identity() -> S {
    S::Tagged {
        key: "kind",
        members: vec![
            ("stable", obj(vec![req("kind", S::Literal("stable")), req("recordId", S::Str), opt("data", S::Unknown)])),
            ("unstable", obj(vec![req("kind", S::Literal("unstable")), req("data", S::Unknown)])),
        ],
    }
}

fn ephemeral_origin_ref() -> S {
    S::Union(vec![
        obj(vec![req("kind", S::Literal("extract")), req("extractStepId", S::Str), req("nodeId", S::Str)]),
        obj(vec![req("kind", S::Literal("transform")), req("transformName", S::Str), req("emissionIndex", S::Num), req("nodeId", S::Str)]),
        obj(vec![req("kind", S::Literal("resource")), opt("resourceId", S::Str), req("nodeId", S::Str)]),
    ])
}

fn external_record_ref() -> S {
    obj(vec![req("adapterType", S::Str), req("externalId", S::Str), opt("recordType", S::Str), opt("url", S::Str), req("data", record(S::Unknown))])
}

fn wire_file_ref() -> S {
    obj(vec![
        opt("__brand", S::Literal("FileRef")),
        opt("name", S::Str),
        opt("contentType", S::Str),
        opt("size", S::Num),
        opt("source", obj(vec![req("ownerAdapterType", S::Str), req("handle", S::Str)])),
        opt("url", S::Str),
    ])
}

fn wire_resource() -> S {
    obj(vec![
        opt("id", S::Str),
        opt("externalId", S::Str),
        opt("type", S::Enum(&["URL", "EMAIL", "WHATSAPP", "FILE", "TEXT"])),
        opt("name", S::Str),
        opt("url", nullable(S::Str)),
        opt("fileRef", wire_file_ref()),
        opt("contentType", nullable(S::Str)),
        opt("data", record(S::Unknown)),
        opt("content", S::Str),
        opt("metadata", record(S::Unknown)),
        opt("facts", arr(obj(vec![req("s", S::Str), req("p", S::Str), req("o", S::Str), opt("t", S::Str)]))),
        opt("provenance", extend(external_record_ref(), vec![opt("field", S::Str)], None)),
    ])
}

fn field_evidence() -> S {
    obj(vec![
        opt("quote", S::Str),
        opt("startOffset", S::Num),
        opt("endOffset", S::Num),
        opt("type", S::Enum(&["extraction", "user_edit", "retrieval"])),
        opt("sourceResourceRef", obj(vec![opt("externalId", S::Str), opt("fileRef", S::Unknown)])),
    ])
}

fn source_position() -> S {
    obj(vec![
        req("adapterType", S::Str),
        req("recordType", nullable(S::Str)),
        req("identity", position_identity()),
        opt("originRef", ephemeral_origin_ref()),
        opt("evidence", record(field_evidence())),
        opt("resources", arr(extend(wire_resource(), vec![opt("fileRef", S::Unknown)], None))),
    ])
}

fn landed_position() -> S {
    extend(source_position(), vec![req("recordType", S::Str)], None)
}

fn related_result() -> S {
    obj(vec![req("position", landed_position()), opt("edgeId", S::Str)])
}

fn related_page() -> S {
    obj(vec![req("items", arr(related_result())), opt("nextCursor", S::Unknown)])
}

fn schema_type_descriptor() -> S {
    let described = loose(vec![req("fieldId", S::Str)]);
    loose(vec![
        req("typeId", S::Str),
        req("displayName", S::Str),
        req("fields", arr(described.clone())),
        req("references", arr(described)),
        opt("deletable", S::Bool),
    ])
}

fn actor() -> S {
    obj(vec![req("type", S::Enum(&["user", "api-token", "system"])), req("id", nullable(S::Str))])
}

fn discriminable_event() -> S {
    obj(vec![
        req("payload", S::Unknown),
        opt("idempotencyKey", S::Str),
        opt("externalId", S::Str),
        opt("tag", S::Str),
        opt("actor", actor()),
        opt("occurredAt", S::Str),
        opt("changeType", S::Enum(&["create", "update", "delete"])),
        opt("eventType", S::Str),
        opt("recordType", S::Str),
        opt("changedFields", arr(S::Str)),
    ])
}

fn write_result() -> S {
    extend(external_record_ref(), vec![opt("events", arr(S::Unknown))], Some(true))
}

fn actor_identity() -> S {
    obj(vec![
        req("identifier", S::Str),
        req("scheme", S::Enum(&["email", "phone", "opaque"])),
        opt("adapterType", S::Str),
        opt("email", S::Str),
        opt("name", S::Str),
        opt("label", S::Str),
    ])
}

/// The result schema of `method`; None for a method whose result this host
/// does not yet hold to its schema (named in the module's callers).
fn result_schema(method: &str) -> Option<S> {
    Some(match method {
        "listEntryPoints" => arr(loose(vec![req("typeId", S::Str), req("displayName", S::Str), req("writable", S::Bool), req("readable", S::Bool)])),
        "describe" => nullable(schema_type_descriptor()),
        "edgesFrom" => nullable(loose(vec![
            req("descriptor", schema_type_descriptor()),
            opt("targetPositions", record(landed_position())),
            opt("nextCursor", S::Unknown),
        ])),
        // `resolveEntity` coerces a bare array first (`preprocess`).
        "resolveEntity" => obj(vec![req("candidates", arr(external_record_ref()))]),
        "getFieldValue" | "invokeFieldFunction" => S::Unknown,
        "getRelated" => arr(related_result()),
        "iterateRelated" | "iterateRelatedPage" => related_page(),
        "preprocessInbound" | "poll" => obj(vec![req("events", arr(discriminable_event())), opt("checkpoint", S::Unknown)]),
        "listEventTypes" => arr(obj(vec![
            req("tag", S::Str),
            req("positionType", S::Str),
            opt("match", obj(vec![req("path", S::Str), req("equals", S::Union(vec![S::Str, arr(S::Str)]))])),
        ])),
        "createRecord" => write_result(),
        "updateRecord" => S::Union(vec![
            extend(write_result(), vec![opt("association", S::Enum(&["made", "already", "unsupported", "none"]))], None),
            obj(vec![req("notFound", S::LiteralTrue)]),
        ]),
        "deleteRecord" => loose(vec![opt("events", arr(S::Unknown))]),
        "linkRecords" => obj(vec![req("created", S::Bool)]),
        "unlinkRecords" => obj(vec![req("removed", S::Bool)]),
        "ensureEventSubscription" => nullable(obj(vec![opt("externalId", S::Str), opt("secret", S::Str)])),
        "removeEventSubscription" => S::Null,
        "resolveAwait" => S::Tagged {
            key: "status",
            members: vec![
                ("pending", obj(vec![req("status", S::Literal("pending")), req("correlationKey", S::Str)])),
                (
                    "landed",
                    obj(vec![
                        req("status", S::Literal("landed")),
                        req("landings", arr(obj(vec![opt("recordId", S::Str), opt("recordType", S::Str), req("fields", record(S::Unknown))]))),
                        req("correlationKey", S::Str),
                    ]),
                ),
                ("empty", obj(vec![req("status", S::Literal("empty"))])),
            ],
        },
        "wakeKeys" => arr(S::Str),
        "readRecord" => nullable(record(S::Unknown)),
        "describeOpaqueId" => nullable(S::Str),
        "resolveFileRef" => obj(vec![req("url", S::Str), opt("contentType", S::Str)]),
        "getActorCandidates" => arr(obj(vec![req("identity", actor_identity()), req("source", S::Enum(&["originator", "relay"]))])),
        "extractActor" => nullable(actor_identity()),
        _ => return None,
    })
}

struct Issue {
    message: String,
    path: Vec<String>,
}

fn kind_of(value: Option<&Js>) -> &'static str {
    match value {
        None => "undefined",
        Some(Js::Null) => "null",
        Some(Js::Bool(_)) => "boolean",
        Some(Js::Num(_)) => "number",
        Some(Js::Str(_)) => "string",
        Some(Js::Arr(_)) => "array",
        Some(Js::Obj(_)) => "object",
    }
}

fn expected(what: &str, value: Option<&Js>) -> Issue {
    Issue { message: format!("Invalid input: expected {what}, received {}", kind_of(value)), path: Vec::new() }
}

fn at(mut issue: Issue, key: String) -> Issue {
    issue.path.insert(0, key);
    issue
}

/// `schema.parse(value)`: the value zod hands back, or its first issue.
/// `value` None is `undefined` (an absent member).
fn parse(schema: &S, value: Option<&Js>) -> Result<Option<Js>, Issue> {
    match schema {
        S::Unknown => Ok(value.cloned()),
        S::Str => match value {
            Some(v @ Js::Str(_)) => Ok(Some(v.clone())),
            _ => Err(expected("string", value)),
        },
        S::Num => match value {
            Some(v @ Js::Num(_)) => Ok(Some(v.clone())),
            _ => Err(expected("number", value)),
        },
        S::Bool => match value {
            Some(v @ Js::Bool(_)) => Ok(Some(v.clone())),
            _ => Err(expected("boolean", value)),
        },
        S::Null => match value {
            Some(Js::Null) => Ok(Some(Js::Null)),
            _ => Err(expected("null", value)),
        },
        S::Literal(text) => match value {
            Some(Js::Str(s)) if s == text => Ok(Some(Js::str(*text))),
            _ => Err(Issue { message: format!("Invalid input: expected \"{text}\""), path: Vec::new() }),
        },
        S::LiteralTrue => match value {
            Some(Js::Bool(true)) => Ok(Some(Js::Bool(true))),
            _ => Err(Issue { message: "Invalid input: expected true".into(), path: Vec::new() }),
        },
        S::Enum(options) => match value {
            Some(Js::Str(s)) if options.contains(&s.as_str()) => Ok(Some(Js::Str(s.clone()))),
            _ => Err(Issue {
                message: format!("Invalid option: expected one of {}", options.iter().map(|o| format!("\"{o}\"")).collect::<Vec<_>>().join("|")),
                path: Vec::new(),
            }),
        },
        S::Nullable(inner) => match value {
            Some(Js::Null) => Ok(Some(Js::Null)),
            _ => parse(inner, value),
        },
        S::Array(inner) => match value {
            Some(Js::Arr(items)) => {
                let mut out = Vec::with_capacity(items.len());
                for (i, item) in items.iter().enumerate() {
                    // A member that parses to `undefined` stays a hole-free `undefined`, which JSON writes as null.
                    out.push(parse(inner, Some(item)).map_err(|e| at(e, i.to_string()))?.unwrap_or(Js::Null));
                }
                Ok(Some(Js::Arr(out)))
            }
            _ => Err(expected("array", value)),
        },
        S::Record(inner) => match value {
            Some(Js::Obj(map)) => {
                let mut out = Obj::new();
                for (k, v) in map {
                    if let Some(parsed) = parse(inner, Some(v)).map_err(|e| at(e, k.clone()))? {
                        out.insert(k.clone(), parsed);
                    }
                }
                Ok(Some(Js::Obj(out)))
            }
            _ => Err(expected("record", value)),
        },
        S::Object { fields, passthrough } => {
            let Some(Js::Obj(map)) = value else { return Err(expected("object", value)) };
            let mut out = Obj::new();
            for (name, field, optional) in fields {
                let member = map.get(*name);
                if member.is_none() && *optional {
                    continue;
                }
                if let Some(parsed) = parse(field, member).map_err(|e| at(e, name.to_string()))? {
                    out.insert(name.to_string(), parsed);
                }
            }
            if *passthrough {
                for (k, v) in map {
                    if !fields.iter().any(|f| f.0 == k) {
                        out.insert(k.clone(), v.clone());
                    }
                }
            }
            Ok(Some(Js::Obj(out)))
        }
        S::Union(members) => members
            .iter()
            .find_map(|member| parse(member, value).ok())
            .ok_or_else(|| Issue { message: "Invalid input".into(), path: Vec::new() }),
        S::Tagged { key, members } => {
            let Some(Js::Obj(_)) = value else { return Err(expected("object", value)) };
            let tag = value.and_then(|v| v.get(key)).and_then(Js::as_str);
            match members.iter().find(|(name, _)| Some(*name) == tag) {
                Some((_, member)) => parse(member, value),
                None => Err(at(Issue { message: "Invalid input".into(), path: Vec::new() }, key.to_string())),
            }
        }
    }
}

/// `parseWireResult(METHODS[method].result, raw, {method, adapter})`.
pub fn check(method: &str, adapter: &str, raw: &Js) -> Result<Js, String> {
    let Some(schema) = result_schema(method) else { return Ok(raw.clone()) };
    // `resolveEntity`'s preprocess: a bare array is its candidates.
    let coerced;
    let input = match (method, raw) {
        ("resolveEntity", Js::Arr(_)) => {
            let mut map = Obj::new();
            map.insert("candidates".into(), raw.clone());
            coerced = Js::Obj(map);
            &coerced
        }
        _ => raw,
    };
    match parse(&schema, Some(input)) {
        Ok(parsed) => Ok(parsed.unwrap_or(Js::Null)),
        Err(issue) => {
            let path = if issue.path.is_empty() { "(root)".to_string() } else { issue.path.join(".") };
            Err(format!(
                "Remote adapter \"{adapter}\" returned an unexpected shape from \"{method}\": {}. {} at {path}",
                received(raw),
                issue.message
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn js(text: &str) -> Js {
        Js::parse(text.as_bytes()).unwrap()
    }

    #[test]
    fn a_stripping_object_keeps_its_declared_keys_in_declared_order() {
        let checked = check("listEventTypes", "a", &js(r#"[{"positionType":"C","tag":"t","extra":1}]"#)).unwrap();
        assert_eq!(checked.to_json(), r#"[{"tag":"t","positionType":"C"}]"#);
    }

    #[test]
    fn a_passthrough_object_keeps_the_rest_after_its_declared_keys() {
        let checked = check("createRecord", "a", &js(r#"{"data":{},"z":1,"externalId":"e","adapterType":"x"}"#)).unwrap();
        assert_eq!(checked.to_json(), r#"{"adapterType":"x","externalId":"e","data":{},"z":1}"#);
    }

    #[test]
    fn resolve_entity_takes_a_bare_array_of_candidates() {
        assert_eq!(check("resolveEntity", "a", &js("[]")).unwrap().to_json(), r#"{"candidates":[]}"#);
    }

    #[test]
    fn a_refusal_names_what_came_back_and_where_it_failed() {
        let refused = check("getRelated", "acme", &js(r#"[{"position":{"adapterType":"a","recordType":null,"identity":{"kind":"unstable","data":1}}}]"#)).unwrap_err();
        assert_eq!(
            refused,
            "Remote adapter \"acme\" returned an unexpected shape from \"getRelated\": received an array (1 item). Invalid input: expected string, received null at 0.position.recordType"
        );
        assert!(check("updateRecord", "a", &js(r#"{"notFound":true}"#)).is_ok());
        assert!(check("resolveAwait", "a", &js(r#"{"status":"pending"}"#)).is_err());
    }
}
