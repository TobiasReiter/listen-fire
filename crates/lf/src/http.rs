//! The loopback HTTP server this host's listeners share (`lf serve`,
//! the inbound contract bridge, the exposed-file listener): HTTP/1.1 over
//! hyper, each connection a task on this thread's LocalSet, each request
//! read whole (up to a limit) and handed to the listener's handler as plain
//! data.

use std::convert::Infallible;
use std::future::Future;
use std::rc::Rc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use crate::json::Js;

/// One request, read whole.
pub struct Request {
    pub method: String,
    /// The path, still percent-encoded, without its query.
    pub path: String,
    /// What follows the `?`, or empty.
    pub query: String,
    /// Lower-case names, each with its first value.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// The body was longer than the listener's limit; `body` holds none of it.
    pub too_large: bool,
}

/// A header's first value, by its lower-case name.
pub fn header<'h>(headers: &'h [(String, String)], name: &str) -> Option<&'h str> {
    headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

pub struct Response {
    pub status: u16,
    pub content_type: Option<&'static str>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn json(status: u16, body: &Js) -> Response {
        Response { status, content_type: Some("application/json"), body: body.to_json().into_bytes() }
    }

    pub fn text(status: u16, text: &str) -> Response {
        Response { status, content_type: Some("text/plain; charset=utf-8"), body: format!("{text}\n").into_bytes() }
    }

    pub fn bytes(status: u16, body: Vec<u8>) -> Response {
        Response { status, content_type: None, body }
    }
}

/// Accept connections on `listener` for as long as the task runs, each
/// request answered by `handler`. A body over `limit` bytes is read through
/// (so the sender sees the answer, not a reset) but not kept.
pub async fn serve<H, F>(listener: TcpListener, limit: usize, handler: H)
where
    H: Fn(Request) -> F + 'static,
    F: Future<Output = Response> + 'static,
{
    let handler = Rc::new(handler);
    while let Ok((stream, _)) = listener.accept().await {
        let handler = handler.clone();
        tokio::task::spawn_local(async move {
            let service = service_fn(move |request: hyper::Request<Incoming>| {
                let handler = handler.clone();
                async move {
                    let request = read(request, limit).await;
                    let response = handler(request).await;
                    let mut answer = hyper::Response::builder().status(response.status);
                    if let Some(content_type) = response.content_type {
                        answer = answer.header("content-type", content_type);
                    }
                    let answer = answer.body(Full::new(Bytes::from(response.body))).unwrap_or_else(|_| {
                        let mut failed = hyper::Response::new(Full::new(Bytes::new()));
                        *failed.status_mut() = hyper::StatusCode::INTERNAL_SERVER_ERROR;
                        failed
                    });
                    Ok::<_, Infallible>(answer)
                }
            });
            // A connection that fails mid-request has no one left to answer.
            let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
        });
    }
}

async fn read(request: hyper::Request<Incoming>, limit: usize) -> Request {
    let (parts, mut body) = request.into_parts();
    let headers = {
        let mut seen: Vec<(String, String)> = Vec::new();
        for (name, value) in &parts.headers {
            if seen.iter().any(|(k, _)| k == name.as_str()) {
                continue;
            }
            seen.push((name.as_str().to_string(), String::from_utf8_lossy(value.as_bytes()).into_owned()));
        }
        seen
    };
    let mut bytes = Vec::new();
    let mut size = 0usize;
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else { break };
        if let Some(data) = frame.data_ref() {
            size += data.len();
            if size <= limit {
                bytes.extend_from_slice(data);
            }
        }
    }
    let too_large = size > limit;
    Request {
        method: parts.method.as_str().to_string(),
        path: parts.uri.path().to_string(),
        query: parts.uri.query().unwrap_or_default().to_string(),
        headers,
        body: if too_large { Vec::new() } else { bytes },
        too_large,
    }
}

/// `decodeURIComponent`: None where it would throw.
pub fn decode_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `new URLSearchParams(query)`: its pairs in order, `+` a space, each
/// percent-decoded (an undecodable escape is kept as written).
pub fn query_pairs(query: &str) -> Vec<(String, String)> {
    let decode = |part: &str| {
        let spaced = part.replace('+', " ");
        decode_component(&spaced).unwrap_or(spaced)
    };
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((k, v)) => (decode(k), decode(v)),
            None => (decode(pair), String::new()),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn components_decode_as_decode_uri_component_does() {
        assert_eq!(decode_component("acme%20crm").as_deref(), Some("acme crm"));
        assert_eq!(decode_component("caf%C3%A9").as_deref(), Some("café"));
        assert_eq!(decode_component("bad%2"), None);
        assert_eq!(decode_component("bad%FF"), None);
    }

    #[test]
    fn a_query_reads_as_url_search_params_reads_it() {
        assert_eq!(query_pairs("note=a+b&x=%41&flag"), vec![("note".into(), "a b".into()), ("x".into(), "A".into()), ("flag".into(), String::new())]);
    }
}
