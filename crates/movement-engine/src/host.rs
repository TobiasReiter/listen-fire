//! The requests a segment makes of its host, one builder per host call, named
//! after the `EngineHost` groups (apps/api/src/services/movement_engine/
//! host.ts, docs/engine-host.md). A builder is the only place a request's
//! shape is written: the executor carries `{family, method, args}` without
//! reading them, and the TypeScript shim routes on the same pair, so a shape
//! change touches a builder and its route and nothing between.

use serde::Serialize;
use serde_json::{Value as Json, json};

/// The `EngineHost` groups a request can address, plus `Clock` (the run's
/// pinned instant, which the shim holds) and `Echo`: the protocol's own
/// probe, served by no host (the `echo` entry's requests name it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Adapters,
    Llm,
    Park,
    Control,
    Files,
    Lookup,
    Locks,
    Clock,
    Echo,
}

impl Family {
    pub fn as_str(self) -> &'static str {
        match self {
            Family::Adapters => "adapters",
            Family::Llm => "llm",
            Family::Park => "park",
            Family::Control => "control",
            Family::Files => "files",
            Family::Lookup => "lookup",
            Family::Locks => "locks",
            Family::Clock => "clock",
            Family::Echo => "echo",
        }
    }

    pub fn parse(name: &str) -> Option<Family> {
        [
            Family::Adapters,
            Family::Llm,
            Family::Park,
            Family::Control,
            Family::Files,
            Family::Lookup,
            Family::Locks,
            Family::Clock,
            Family::Echo,
        ]
        .into_iter()
        .find(|family| family.as_str() == name)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub family: Family,
    pub method: String,
    pub args: Json,
}

/// The adapter instance a segment holds: the shim keeps the live `Adapter`
/// and hands the engine this number for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Instance(pub u64);

/// `ResolveAdapter`'s input, as host.ts types it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveAdapter {
    pub adapter_type: String,
    pub team_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credentials_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub construction_args: Option<std::collections::BTreeMap<String, String>>,
    pub role: Role,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Source,
    Target,
}

pub mod adapters {
    use super::*;

    /// Answered with `{instance}`, the handle `call` names.
    pub fn resolve(input: &ResolveAdapter) -> Request {
        let args = serde_json::to_value(input).expect("a ResolveAdapter is always JSON");
        Request { family: Family::Adapters, method: "resolve".into(), args }
    }

    /// Answered with the credential's id, or `undefined` for none.
    pub fn credential_id(credential_name: &str) -> Request {
        Request { family: Family::Adapters, method: "credentialId".into(), args: json!({ "credentialName": credential_name }) }
    }

    /// One of the live `Adapter`'s methods, with its positional arguments.
    pub fn call(instance: Instance, method: &str, args: Vec<Json>) -> Request {
        Request {
            family: Family::Adapters,
            method: "call".into(),
            args: json!({ "instance": instance.0, "method": method, "args": args }),
        }
    }
}

pub mod clock {
    use super::*;

    /// The run's pinned instant and the calendar date it is in `zone`:
    /// answered `{nowIso, zone, today}`, or an error for a zone that is not
    /// one (`DATE.TODAY(zone)`'s own message). The date is the shim's to
    /// work out because the zone database is not in the artifact.
    pub fn now(zone: &str) -> Request {
        Request { family: Family::Clock, method: "now".into(), args: json!({ "zone": zone }) }
    }
}

/// The instance handle a `resolve` answer carries.
pub fn instance_of(answer: &Json) -> Option<Instance> {
    answer.get("instance").and_then(Json::as_u64).map(Instance)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builders_write_the_shapes_the_shim_routes_on() {
        let resolve = adapters::resolve(&ResolveAdapter {
            adapter_type: "attio".into(),
            team_id: "t1".into(),
            credentials_id: None,
            construction_args: None,
            role: Role::Target,
        });
        assert_eq!((resolve.family.as_str(), resolve.method.as_str()), ("adapters", "resolve"));
        assert_eq!(resolve.args, json!({ "adapterType": "attio", "teamId": "t1", "role": "target" }));
        let call = adapters::call(Instance(3), "readRecord", vec![json!("person"), json!("r1")]);
        assert_eq!(call.args, json!({ "instance": 3, "method": "readRecord", "args": ["person", "r1"] }));
        assert_eq!(instance_of(&json!({ "instance": 3 })), Some(Instance(3)));
        assert_eq!(adapters::credential_id("crm").args, json!({ "credentialName": "crm" }));
        let now = clock::now("Europe/Berlin");
        assert_eq!((now.family.as_str(), now.method.as_str()), ("clock", "now"));
        assert_eq!(now.args, json!({ "zone": "Europe/Berlin" }));
    }

    #[test]
    fn every_family_parses_back_from_its_name() {
        for name in ["adapters", "llm", "park", "control", "files", "lookup", "locks", "clock", "echo"] {
            assert_eq!(Family::parse(name).map(Family::as_str), Some(name));
        }
        assert_eq!(Family::parse("nope"), None);
    }
}
