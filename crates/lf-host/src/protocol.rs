//! Adapter protocol 2's client, as far as `check` needs it: one POST per call
//! (docs/contracts/adapter-protocol.md), the envelope `{ ok, result }` or
//! `{ ok: false, error }`, both over HTTP 200. The same request the TypeScript
//! client writes (movement-engine `protocol/client.ts` `postRpc`).
//!
//! THIN (G0): plain HTTP only (an external reached by an `https` url is
//! refused), and no retry; G3 brings the full client.

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
    pub params: serde_json::Value,
}

struct Target {
    host: String,
    port: u16,
    path: String,
}

fn target_of(base_url: &str) -> Result<Target, String> {
    let Some(rest) = base_url.strip_prefix("http://") else {
        return Err(format!("{base_url}: lf-host reaches externals over plain http only for now"));
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
pub async fn post_rpc(call: Call<'_>) -> Result<Js, String> {
    let target = target_of(call.base_url)?;
    let stream = TcpStream::connect((target.host.as_str(), target.port))
        .await
        .map_err(|e| format!("Remote adapter at {} could not be reached for method \"{}\": {e}", call.base_url, call.method))?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let body = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "method": call.method,
        "cacheScopeId": "<none>",
        "params": call.params,
    });
    let mut request = Request::post(&target.path)
        .header("host", format!("{}:{}", target.host, target.port))
        .header("content-type", "application/json")
        .header(ADAPTER_TEAM_HEADER, call.team_id);
    if let Some(secret) = call.bearer {
        request = request.header("authorization", format!("Bearer {secret}"));
    }
    let request = request.body(Full::new(Bytes::from(body.to_string()))).map_err(|e| e.to_string())?;
    let response = sender.send_request(request).await.map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Remote adapter transport error (HTTP {}) for method \"{}\"", status.as_u16(), call.method));
    }
    let bytes = response.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes();
    let envelope = Js::parse(&bytes)
        .map_err(|e| format!("Remote adapter \"{}\" answered \"{}\" with a body that is not JSON: {e}", call.base_url, call.method))?;
    match envelope.get("ok") {
        Some(Js::Bool(true)) => Ok(envelope.get("result").cloned().unwrap_or(Js::Null)),
        Some(Js::Bool(false)) => {
            let error = envelope.get("error");
            let field = |k: &str| error.and_then(|e| e.get(k)).and_then(Js::as_str);
            match (field("code"), field("message")) {
                (Some(code), Some(message)) => Err(format!("Remote adapter error for method \"{}\": {code} — {message}", call.method)),
                _ => Err(shape_error(call.method, call.base_url, &envelope, "error: expected { code, message }")),
            }
        }
        _ => Err(shape_error(call.method, call.base_url, &envelope, "ok: expected true or false")),
    }
}

/// `RemoteResponseShapeError`'s wording: what came back, and what was expected.
pub fn shape_error(method: &str, adapter: &str, received: &Js, expected: &str) -> String {
    let what = match received {
        Js::Arr(items) => format!("received an array ({} item{})", items.len(), if items.len() == 1 { "" } else { "s" }),
        Js::Null => "received null".into(),
        Js::Obj(map) => format!("received an object with keys [{}]", map.keys().cloned().collect::<Vec<_>>().join(", ")),
        Js::Bool(_) => "received boolean".into(),
        Js::Num(_) => "received number".into(),
        Js::Str(_) => "received string".into(),
    };
    format!("Remote adapter \"{adapter}\" returned an unexpected shape from \"{method}\": {what}. {expected}")
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
}
