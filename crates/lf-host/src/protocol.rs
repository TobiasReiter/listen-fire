//! Adapter protocol 2's transport: one POST per call
//! (docs/contracts/adapter-protocol.md), the envelope `{ ok, result }` or
//! `{ ok: false, error }`, both over HTTP 200. The same request the TypeScript
//! client writes (movement-engine `protocol/client.ts` `postRpc`), failing
//! with the same errors: a transport error for a non-2xx answer, a protocol
//! error carrying the server's `{code, message}`, a shape error for an
//! envelope that is neither.
//!
//! Plain HTTP only (an external reached by an `https` url is refused, as
//! externals are local processes), and no retry: the TypeScript client
//! retries nothing either.

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::Request;
use hyper_util::rt::TokioIo;
use serde_json::json;

use crate::json::Js;
use tokio::net::TcpStream;

pub const PROTOCOL_VERSION: &str = "2";
/// The header naming the calling team (`ADAPTER_TEAM_HEADER`).
pub const ADAPTER_TEAM_HEADER: &str = "x-listen-fire-team";

pub struct Call<'a> {
    pub base_url: &'a str,
    /// The `Authorization` header's value, when the external authenticates.
    pub bearer: Option<&'a str>,
    pub team_id: &'a str,
    pub method: &'a str,
    /// The caller's cache scope (`cacheScopeId`): one per adapter instance.
    pub cache_scope_id: &'a str,
    pub params: serde_json::Value,
}

/// Why a protocol call failed, by the TypeScript error it stands for.
#[derive(Debug, Clone, PartialEq)]
pub enum RpcError {
    /// `fetch` itself failed: nothing answered.
    Unreachable(String),
    /// `RemoteTransportError`: a non-2xx answer.
    Transport { status: u16, method: String },
    /// `RemoteProtocolError`: the server's `{ ok: false, error }`.
    Protocol { code: String, message: String, method: String },
    /// `RemoteResponseShapeError`: an answer that is not the protocol's.
    Shape(String),
}

impl RpcError {
    pub fn message(&self) -> String {
        match self {
            RpcError::Unreachable(message) | RpcError::Shape(message) => message.clone(),
            RpcError::Transport { status, method } => format!("Remote adapter transport error (HTTP {status}) for method \"{method}\""),
            RpcError::Protocol { code, message, method } => format!("Remote adapter error for method \"{method}\": {code} — {message}"),
        }
    }

    /// The TypeScript error's `name`.
    pub fn name(&self) -> &'static str {
        match self {
            RpcError::Unreachable(_) => "TypeError",
            RpcError::Transport { .. } => "RemoteTransportError",
            RpcError::Protocol { .. } => "RemoteProtocolError",
            RpcError::Shape(_) => "RemoteResponseShapeError",
        }
    }

    /// The HTTP status a transport error carries.
    pub fn status(&self) -> Option<u16> {
        match self {
            RpcError::Transport { status, .. } => Some(*status),
            _ => None,
        }
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl From<RpcError> for String {
    fn from(error: RpcError) -> String {
        error.message()
    }
}

struct Target {
    host: String,
    port: u16,
    path: String,
}

fn target_of(base_url: &str) -> Result<Target, String> {
    let Some(rest) = base_url.strip_prefix("http://") else {
        return Err(format!("{base_url}: lf-host reaches externals over plain http only"));
    };
    let (authority, path) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, port.parse::<u16>().map_err(|_| format!("{base_url}: not a port: {port}"))?),
        None => (authority, 80),
    };
    Ok(Target { host: host.to_string(), port, path: path.to_string() })
}

/// One protocol call: its `result`, or why it failed.
pub async fn post_rpc(call: Call<'_>) -> Result<Js, RpcError> {
    let target = target_of(call.base_url).map_err(RpcError::Unreachable)?;
    let unreachable = |e: &dyn std::fmt::Display| {
        RpcError::Unreachable(format!("Remote adapter at {} could not be reached for method \"{}\": {e}", call.base_url, call.method))
    };
    let stream = TcpStream::connect((target.host.as_str(), target.port)).await.map_err(|e| unreachable(&e))?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.map_err(|e| unreachable(&e))?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let body = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "method": call.method,
        "cacheScopeId": call.cache_scope_id,
        "params": call.params,
    });
    let mut request = Request::post(&target.path)
        .header("host", format!("{}:{}", target.host, target.port))
        .header("content-type", "application/json")
        .header(ADAPTER_TEAM_HEADER, call.team_id);
    if let Some(secret) = call.bearer {
        request = request.header("authorization", format!("Bearer {secret}"));
    }
    let request = request.body(Full::new(Bytes::from(body.to_string()))).map_err(|e| unreachable(&e))?;
    let response = sender.send_request(request).await.map_err(|e| unreachable(&e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(RpcError::Transport { status: status.as_u16(), method: call.method.to_string() });
    }
    let bytes = response.into_body().collect().await.map_err(|e| unreachable(&e))?.to_bytes();
    let envelope = Js::parse(&bytes).map_err(|e| {
        RpcError::Shape(format!("Remote adapter \"{}\" answered \"{}\" with a body that is not JSON: {e}", call.base_url, call.method))
    })?;
    match envelope.get("ok") {
        Some(Js::Bool(true)) => Ok(envelope.get("result").cloned().unwrap_or(Js::Null)),
        Some(Js::Bool(false)) => {
            let error = envelope.get("error");
            let field = |k: &str| error.and_then(|e| e.get(k)).and_then(Js::as_str);
            match (field("code"), field("message")) {
                (Some(code), Some(message)) => {
                    Err(RpcError::Protocol { code: code.to_string(), message: message.to_string(), method: call.method.to_string() })
                }
                _ => Err(RpcError::Shape(shape_error(call.method, call.base_url, &envelope, "error: expected { code, message }"))),
            }
        }
        _ => Err(RpcError::Shape(shape_error(call.method, call.base_url, &envelope, "ok: expected true or false"))),
    }
}

/// What came back, as `RemoteResponseShapeError` describes it.
pub fn received(value: &Js) -> String {
    match value {
        Js::Arr(items) => format!("received an array ({} item{})", items.len(), if items.len() == 1 { "" } else { "s" }),
        Js::Null => "received null".into(),
        Js::Obj(map) => format!("received an object with keys [{}]", map.keys().cloned().collect::<Vec<_>>().join(", ")),
        Js::Bool(_) => "received boolean".into(),
        Js::Num(_) => "received number".into(),
        Js::Str(_) => "received string".into(),
    }
}

/// `RemoteResponseShapeError`'s wording: what came back, and what was expected.
pub fn shape_error(method: &str, adapter: &str, received_value: &Js, expected: &str) -> String {
    format!("Remote adapter \"{adapter}\" returned an unexpected shape from \"{method}\": {}. {expected}", received(received_value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_base_url_names_host_port_and_path() {
        let t = target_of("http://127.0.0.1:5557/").unwrap();
        assert_eq!((t.host.as_str(), t.port, t.path.as_str()), ("127.0.0.1", 5557, "/"));
        let t = target_of("http://localhost/rpc").unwrap();
        assert_eq!((t.host.as_str(), t.port, t.path.as_str()), ("localhost", 80, "/rpc"));
        assert!(target_of("https://example.com/").is_err());
    }

    #[test]
    fn each_failure_carries_the_typescript_errors_words() {
        let protocol = RpcError::Protocol { code: "internal".into(), message: "boom".into(), method: "describe".into() };
        assert_eq!(protocol.message(), "Remote adapter error for method \"describe\": internal — boom");
        assert_eq!(protocol.name(), "RemoteProtocolError");
        let transport = RpcError::Transport { status: 502, method: "getRelated".into() };
        assert_eq!(transport.message(), "Remote adapter transport error (HTTP 502) for method \"getRelated\"");
        assert_eq!(transport.status(), Some(502));
    }
}
