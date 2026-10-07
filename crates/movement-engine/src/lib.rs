//! The movement engine. A segment runs inside one WASM instance as one
//! future (`executor`); whatever it needs from the world it asks the
//! TypeScript host for, one request at a time or several at once (`host`),
//! and the host answers each by id. `abi` carries that conversation across
//! the boundary; `value` is the engine's value model.
//!
//! No language semantics yet: the entries are the protocol's own probes,
//! and a program's segment arrives with the first slice the TypeScript shim
//! lets through (apps/api/src/services/movement_engine/rust_engine.ts).

pub mod abi;
pub mod executor;
pub mod host;
pub mod value;

use serde_json::{Value as Json, json};

use executor::{Answer, HostError, ProtocolError, Segment, join_all};
use host::{Family, Request};

/// The segment `start`'s input asks for, by its `entry`:
///
/// - `echo`: issues each of `requests` (`{family, method, args}`) at once
///   and finishes with `{answers}`, each in the answer envelope it came in.
/// - `panic`: panics with `message` on the first poll, so a loader can prove
///   its trap path against the real artifact.
pub fn begin(input: &str) -> Result<Segment, ProtocolError> {
    let input: Json = serde_json::from_str(input).map_err(|e| ProtocolError(format!("the input is not JSON: {e}")))?;
    match input.get("entry").and_then(Json::as_str) {
        Some("echo") => {
            let requests = input
                .get("requests")
                .and_then(Json::as_array)
                .ok_or_else(|| ProtocolError("an echo needs `requests`, an array".into()))?
                .iter()
                .map(echo_request)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Segment::new(|host| async move {
                let answers = join_all(requests.into_iter().map(|request| host.request(request)).collect()).await;
                json!({ "answers": answers.iter().map(answer_envelope).collect::<Vec<_>>() })
            }))
        }
        Some("panic") => {
            let message = input.get("message").and_then(Json::as_str).unwrap_or("").to_string();
            Ok(Segment::new(|_host| async move { panic!("{message}") }))
        }
        Some(other) => Err(ProtocolError(format!("no entry `{other}`"))),
        None => Err(ProtocolError("the input names no `entry`".into())),
    }
}

fn echo_request(request: &Json) -> Result<Request, ProtocolError> {
    let text = |name: &str| {
        request
            .get(name)
            .and_then(Json::as_str)
            .ok_or_else(|| ProtocolError(format!("an echo request needs `{name}`, a string: {request}")))
    };
    let family = text("family")?;
    let family = Family::parse(family).ok_or_else(|| ProtocolError(format!("no host family `{family}`")))?;
    Ok(Request { family, method: text("method")?.to_string(), args: request.get("args").cloned().unwrap_or(Json::Null) })
}

/// An answer's JSON: `{"value": …}`, `{}` for `undefined`, or
/// `{"error": {message, …}}` for a request the host could not serve.
pub fn read_answer(json: &str) -> Result<Answer, ProtocolError> {
    let envelope: Json = serde_json::from_str(json).map_err(|e| ProtocolError(format!("the answer is not JSON: {e}")))?;
    let Some(object) = envelope.as_object() else {
        return Err(ProtocolError(format!("an answer is an object, not {envelope}")));
    };
    match (object.get("value"), object.get("error"), object.len()) {
        (Some(value), None, 1) => Ok(Ok(Some(value.clone()))),
        (None, None, 0) => Ok(Ok(None)),
        (None, Some(error), 1) if error.get("message").is_some_and(Json::is_string) => {
            Ok(Err(HostError { detail: error.clone() }))
        }
        _ => Err(ProtocolError(format!("an answer is {{value}}, {{}} or {{error: {{message}}}}, not {envelope}"))),
    }
}

fn answer_envelope(answer: &Answer) -> Json {
    match answer {
        Ok(Some(value)) => json!({ "value": value }),
        Ok(None) => json!({}),
        Err(error) => json!({ "error": error.detail }),
    }
}
