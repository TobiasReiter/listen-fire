//! The requests a segment makes of its host, one builder per host call, named
//! after the `EngineHost` groups (apps/api/src/services/movement_engine/
//! host.ts, docs/engine-host.md). A builder is the only place a request's
//! shape is written: the executor carries `{family, method, args}` without
//! reading them, and the TypeScript shim routes on the same pair, so a shape
//! change touches a builder and its route and nothing between.

use serde::Serialize;
use serde_json::{Value as Json, json};

/// The `EngineHost` groups a request can address (`Trace` is its `trace`
/// array), plus `Check` (the TypeScript checker, until the checker is Rust),
/// `Builtins` (the TypeScript standard library, for the readings this engine
/// hands back) and `Echo`: the protocol's own
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
    Trace,
    Check,
    Builtins,
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
            Family::Trace => "trace",
            Family::Check => "check",
            Family::Builtins => "builtins",
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
            Family::Trace,
            Family::Check,
            Family::Builtins,
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
    /// A target whose writes are rehearsed: the host wraps the live adapter
    /// in the run's dry-run capture (`wrapAdapterForDryRun`).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub dry_run: bool,
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

    /// Whether the live adapter implements an optional member (`readRecord`):
    /// answered a boolean.
    pub fn has(instance: Instance, method: &str) -> Request {
        Request { family: Family::Adapters, method: "has".into(), args: json!({ "instance": instance.0, "method": method }) }
    }

    /// `call` with its arguments, and its answer, on the eval wire
    /// (crate::env): key order, `undefined` and the numbers JSON cannot say
    /// cross as the JavaScript has them.
    pub fn call_wire(instance: Instance, method: &str, args: Vec<Json>) -> Request {
        Request {
            family: Family::Adapters,
            method: "call".into(),
            args: json!({ "instance": instance.0, "method": method, "args": args, "wire": true }),
        }
    }
}

pub mod llm {
    use super::*;

    /// The identity judge over a write's candidates (`arbitrateEntities`),
    /// values on the eval wire: answered `{index: number | null,
    /// judgeUnavailable?: message}`, the message being what the host's
    /// `onJudgeUnavailable` heard.
    pub fn arbitrate_entities(asserted: Json, candidates: Json, record_type: &str, constraints: Json) -> Request {
        Request {
            family: Family::Llm,
            method: "arbitrateEntities".into(),
            args: json!({ "asserted": asserted, "candidates": candidates, "recordType": record_type, "constraints": constraints }),
        }
    }
}

pub mod locks {
    use super::*;

    /// The segment's cross-run write locks, taken by name (sorted, each once):
    /// answered `undefined` once held.
    pub fn acquire(names: &[String]) -> Request {
        Request { family: Family::Locks, method: "acquire".into(), args: json!({ "names": names }) }
    }

    /// The same names let go, as one earlier `acquire` took them.
    pub fn release(names: &[String]) -> Request {
        Request { family: Family::Locks, method: "release".into(), args: json!({ "names": names }) }
    }
}

pub mod park {
    use super::*;

    /// A timer park (`sleep`): the leaf's address and its `ParkedScopeState`,
    /// to wake `wakeAfterMs` from the host's own clock (`Date.now()`, as the
    /// TypeScript reads it).
    pub fn commit_timer_park(address: &str, state: Json, wake_after_ms: f64) -> Request {
        Request {
            family: Family::Park,
            method: "commitTimerPark".into(),
            args: json!({ "address": address, "state": state, "wakeAfterMs": wake_after_ms }),
        }
    }
}

pub mod control {
    use super::*;

    /// The cancel gate at a statement boundary (`cancel.cancelled()`):
    /// answered true once a cancel is requested.
    pub fn cancelled() -> Request {
        Request { family: Family::Control, method: "cancelled".into(), args: json!({}) }
    }

    /// The run's last cancel check, undebounced (`cancel.cancelledNow()`).
    pub fn cancelled_now() -> Request {
        Request { family: Family::Control, method: "cancelledNow".into(), args: json!({}) }
    }
}

pub mod trace {
    use super::*;

    /// One entry appended to the run's trace as it lands.
    pub fn append(entry: &crate::trace::TraceEntry) -> Request {
        Request { family: Family::Trace, method: "append".into(), args: json!({ "entry": entry }) }
    }
}

pub mod builtins {
    use super::*;

    /// A built-in this engine hands back for these arguments, answered by
    /// the TypeScript member: `{id, args, now, languageVersion}`, values on
    /// the eval wire, the answer too.
    pub fn function(id: &str, args: Vec<Json>, now: &str, language_version: u32) -> Request {
        Request {
            family: Family::Builtins,
            method: "function".into(),
            args: json!({ "id": id, "args": args, "now": now, "languageVersion": language_version }),
        }
    }

    /// The shared comparator (`compareValues`), likewise.
    pub fn compare(op: &str, left: Json, right: Json) -> Request {
        Request { family: Family::Builtins, method: "compare".into(), args: json!({ "op": op, "left": left, "right": right }) }
    }
}

pub mod check {
    use super::*;

    /// The pinned source checked against the run's snapshot (the host's,
    /// which the segment was handed too): answered
    /// `{diagnostics, link?, stamps}` (crate::program reads it). A program
    /// that fails its check never gets an answer: the host ends the run with
    /// MOVENG_CHECK, as the TypeScript engine does before it runs anything.
    pub fn program(source: &str, language_version: u32, upgrading_from: Option<u32>) -> Request {
        let mut args = json!({ "source": source, "languageVersion": language_version });
        if let Some(from) = upgrading_from {
            args["upgradingFrom"] = json!(from);
        }
        Request { family: Family::Check, method: "program".into(), args }
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
            dry_run: false,
        });
        assert_eq!((resolve.family.as_str(), resolve.method.as_str()), ("adapters", "resolve"));
        assert_eq!(resolve.args, json!({ "adapterType": "attio", "teamId": "t1", "role": "target" }));
        let call = adapters::call(Instance(3), "readRecord", vec![json!("person"), json!("r1")]);
        assert_eq!(call.args, json!({ "instance": 3, "method": "readRecord", "args": ["person", "r1"] }));
        assert_eq!(instance_of(&json!({ "instance": 3 })), Some(Instance(3)));
        assert_eq!(adapters::credential_id("crm").args, json!({ "credentialName": "crm" }));
        let check = check::program("src", 3, None);
        assert_eq!((check.family.as_str(), check.method.as_str()), ("check", "program"));
        assert_eq!(check.args, json!({ "source": "src", "languageVersion": 3 }));
    }

    #[test]
    fn every_family_parses_back_from_its_name() {
        for name in ["adapters", "llm", "park", "control", "files", "lookup", "locks", "trace", "check", "builtins", "echo"] {
            assert_eq!(Family::parse(name).map(Family::as_str), Some(name));
        }
        assert_eq!(Family::parse("nope"), None);
    }
}
