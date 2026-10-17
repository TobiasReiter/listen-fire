//! The Anthropic Messages API as the TypeScript lf calls it (movement-engine
//! `lib/anthropic/index.ts` `anthropicChatDetailed`, over the SDK): one
//! streamed request per turn, a reply cut off at the output ceiling continued
//! where it stopped, a reply that spent the whole ceiling thinking asked again
//! one effort lower, and a failed request retried with the same backoff.
//!
//! The request is streamed because above about 16K `max_tokens` a plain
//! request outlives the provider's HTTP timeout; the stream is read to its
//! end and reassembled into the one message the engine's caller wants.
//!
//! `base_url` may be `http://` (a proxy, a test fake) or `https://` (the
//! provider). TLS is rustls on the bundled web root set.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::Request;
use hyper_util::rt::TokioIo;
use serde_json::{Value as Json, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

use crate::models::{ProviderKey, TokenCounts};

const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2023-06-01";
/// A request that has not finished after this long has hung (the SDK's own
/// default timeout).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

/// `MAX_CHAT_CONTINUATIONS`.
pub const MAX_CHAT_CONTINUATIONS: u32 = 5;

/// One request's retries (`RETRY_LIMIT` and its delays).
#[derive(Debug, Clone, Copy)]
pub struct Backoff {
    pub attempts: u32,
    pub initial: Duration,
    pub multiple: u32,
    pub rate_limit_wait: Duration,
}

impl Default for Backoff {
    fn default() -> Backoff {
        Backoff { attempts: 4, initial: Duration::from_secs(1), multiple: 4, rate_limit_wait: Duration::from_secs(30) }
    }
}

/// Why a chat call failed.
#[derive(Debug, Clone, PartialEq)]
pub enum ChatError {
    /// The call's budget was spent before a request: nothing was sent.
    BudgetSpent,
    /// The provider or the connection failed; the message is the run's failure.
    Failed(String),
}

#[derive(Debug)]
enum RequestError {
    Http { status: u16, message: String },
    Connection(String),
    /// An `error` event in the stream.
    Stream { retryable: bool, message: String },
}

impl RequestError {
    fn message(&self) -> &str {
        match self {
            RequestError::Http { message, .. } | RequestError::Connection(message) | RequestError::Stream { message, .. } => message,
        }
    }

    fn retryable(&self) -> bool {
        match self {
            RequestError::Http { status, .. } => matches!(*status, 408 | 409 | 429) || *status >= 500,
            RequestError::Connection(_) => true,
            RequestError::Stream { retryable, .. } => *retryable,
        }
    }

    fn rate_limited(&self) -> bool {
        matches!(self, RequestError::Http { status: 429, .. })
    }
}

/// A user turn block: `cache_control` makes the end of it a cache breakpoint.
pub struct UserBlock {
    pub text: String,
    pub cache_breakpoint: bool,
}

pub enum UserMessage {
    Text(String),
    Blocks(Vec<UserBlock>),
}

pub struct ChatOptions {
    pub system: String,
    pub user: UserMessage,
    /// The model as the provider's wire names it.
    pub model: String,
    pub max_tokens: u64,
    /// One of low, medium, high, xhigh.
    pub effort: Option<String>,
    pub max_continuations: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatReply {
    pub text: String,
    pub stop_reason: Option<String>,
    /// The loop ran out of road while still truncated; the text is a fragment.
    pub truncated: bool,
    /// Continuation turns actually attempted.
    pub continuations: u32,
    /// The last turn spent its whole ceiling thinking and wrote no text.
    pub thinking_only: bool,
    /// The depth the last turn ran at.
    pub effort: Option<String>,
    pub stepped_down: Option<(String, String)>,
    pub max_tokens: u64,
    pub usage: TokenCounts,
}

/// One rung down the reasoning ladder (`effortBelow`).
fn effort_below(effort: Option<&str>) -> Option<&'static str> {
    match effort? {
        "xhigh" => Some("high"),
        "high" => Some("medium"),
        "medium" => Some("low"),
        _ => None,
    }
}

/// Models that read `output_config: { effort }` and think adaptively
/// (`usesAdaptiveThinking`).
fn uses_adaptive_thinking(model: &str) -> bool {
    ["claude-opus", "claude-sonnet-5", "claude-fable", "claude-mythos"].iter().any(|prefix| model.starts_with(prefix))
}

pub struct Provider {
    pub key: ProviderKey,
    pub backoff: Backoff,
}

impl Provider {
    pub fn new(key: ProviderKey) -> Provider {
        Provider { key, backoff: Backoff::default() }
    }

    /// `anthropicChatDetailed`. `budget_open` is asked before every request:
    /// false refuses the call (`assertRunBudget`).
    pub async fn chat_detailed(&self, options: &ChatOptions, budget_open: &dyn Fn() -> bool) -> Result<ChatReply, ChatError> {
        let model = options.model.as_str();
        let thinking_for = |depth: Option<&str>| match depth {
            Some(depth) if uses_adaptive_thinking(model) => Some((json!({ "type": "adaptive" }), json!({ "effort": depth }))),
            _ => None,
        };
        // An empty system text block is a 400 at the API.
        let system = (!options.system.is_empty())
            .then(|| json!([{ "type": "text", "text": options.system, "cache_control": { "type": "ephemeral" } }]));
        let first_turn = match &options.user {
            UserMessage::Text(text) => json!(text),
            UserMessage::Blocks(blocks) => Json::Array(
                blocks
                    .iter()
                    .map(|block| {
                        let mut out = json!({ "type": "text", "text": block.text });
                        if block.cache_breakpoint {
                            out["cache_control"] = json!({ "type": "ephemeral" });
                        }
                        out
                    })
                    .collect(),
            ),
        };
        let mut messages = vec![json!({ "role": "user", "content": first_turn })];

        let mut current_effort: Option<String> = options.effort.clone();
        let mut accumulated = String::new();
        let mut usage = TokenCounts::default();
        let mut stop_reason: Option<String>;
        let mut thinking_only;
        let mut stepped_down: Option<(String, String)> = None;
        let mut turn: u32 = 0;
        loop {
            if !budget_open() {
                return Err(ChatError::BudgetSpent);
            }
            let mut body = json!({ "model": model, "max_tokens": options.max_tokens });
            if let Some(system) = &system {
                body["system"] = system.clone();
            }
            body["messages"] = Json::Array(messages.clone());
            if let Some((thinking, output_config)) = thinking_for(current_effort.as_deref()) {
                body["thinking"] = thinking;
                body["output_config"] = output_config;
            }
            body["stream"] = json!(true);
            let message = self.request_with_backoff(&body).await.map_err(|e| ChatError::Failed(e.message().to_string()))?;

            let text = message.text();
            accumulated.push_str(&text);
            usage.input += message.usage.input;
            usage.output += message.usage.output;
            usage.cache_read += message.usage.cache_read;
            usage.cache_creation += message.usage.cache_creation;
            stop_reason = message.stop_reason.clone();
            thinking_only = stop_reason.as_deref() == Some("max_tokens")
                && text.is_empty()
                && !message.block_types.is_empty()
                && message.block_types.iter().all(|t| t == "thinking");

            if stop_reason.as_deref() != Some("max_tokens") {
                break;
            }
            // Truncated before any text: the whole ceiling went on thinking.
            // Ask again less deeply, once; a continuation would push an empty
            // assistant turn, which the API rejects.
            if text.is_empty() {
                let from = if thinking_only && stepped_down.is_none() { current_effort.clone() } else { None };
                let lower = from.as_deref().and_then(|from| effort_below(Some(from)));
                let (Some(from), Some(lower)) = (from, lower) else { break };
                stepped_down = Some((from, lower.to_string()));
                current_effort = Some(lower.to_string());
                continue;
            }
            if turn == options.max_continuations {
                break;
            }
            turn += 1;
            messages.push(json!({ "role": "assistant", "content": text }));
            messages.push(json!({ "role": "user", "content": "Continue exactly where you left off." }));
        }
        Ok(ChatReply {
            text: accumulated,
            truncated: stop_reason.as_deref() == Some("max_tokens"),
            stop_reason,
            continuations: turn,
            thinking_only,
            effort: current_effort,
            stepped_down,
            max_tokens: options.max_tokens,
            usage,
        })
    }

    async fn request_with_backoff(&self, body: &Json) -> Result<Message, RequestError> {
        let backoff = self.backoff;
        let mut attempt = 1;
        loop {
            let error = match self.request_once(body).await {
                Ok(message) => return Ok(message),
                Err(error) => error,
            };
            if !error.retryable() || attempt >= backoff.attempts {
                return Err(error);
            }
            if error.rate_limited() {
                tokio::time::sleep(backoff.rate_limit_wait).await;
            }
            tokio::time::sleep(backoff.initial * backoff.multiple.pow(attempt - 1)).await;
            attempt += 1;
        }
    }

    async fn request_once(&self, body: &Json) -> Result<Message, RequestError> {
        let base = self.key.base_url.as_deref().unwrap_or(DEFAULT_BASE_URL).trim_end_matches('/');
        let target = Target::of(&format!("{base}/v1/messages")).map_err(RequestError::Connection)?;
        match tokio::time::timeout(REQUEST_TIMEOUT, self.send(&target, body)).await {
            Ok(result) => result,
            Err(_) => Err(RequestError::Connection("Request timed out.".into())),
        }
    }

    async fn send(&self, target: &Target, body: &Json) -> Result<Message, RequestError> {
        let connection_error = |e: &dyn std::fmt::Display| RequestError::Connection(format!("Connection error: {e}"));
        let tcp = TcpStream::connect((target.host.as_str(), target.port)).await.map_err(|e| connection_error(&e))?;
        let request = Request::post(&target.path)
            .header("host", target.authority())
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .header("x-api-key", &self.key.api_key)
            .header("anthropic-version", API_VERSION)
            .header("user-agent", concat!("lf/", env!("CARGO_PKG_VERSION")))
            .body(Full::new(Bytes::from(body.to_string())))
            .map_err(|e| connection_error(&e))?;
        let (status, content_type, bytes) = if target.tls {
            let server_name = rustls::pki_types::ServerName::try_from(target.host.clone()).map_err(|e| connection_error(&e))?;
            let tls = tls_connector().connect(server_name, tcp).await.map_err(|e| connection_error(&e))?;
            exchange(tls, request).await.map_err(|e| connection_error(&e))?
        } else {
            exchange(tcp, request).await.map_err(|e| connection_error(&e))?
        };
        if !(200..300).contains(&status) {
            return Err(RequestError::Http { status, message: http_error_message(status, &bytes) });
        }
        if content_type.starts_with("application/json") {
            return Message::of_json(&bytes).map_err(RequestError::Connection);
        }
        Message::of_stream(&String::from_utf8_lossy(&bytes))
    }
}

async fn exchange<S>(stream: S, request: Request<Full<Bytes>>) -> Result<(u16, String, Bytes), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let response = sender.send_request(request).await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    let bytes = response.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes();
    Ok((status, content_type, bytes))
}

/// The SDK's `APIError` message: the status, then the body's `message` or
/// the body itself.
fn http_error_message(status: u16, body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let text = text.trim();
    if text.is_empty() {
        return format!("{status} status code (no body)");
    }
    match serde_json::from_str::<Json>(text) {
        Ok(parsed) => match parsed.get("message") {
            Some(Json::String(message)) => format!("{status} {message}"),
            Some(other) => format!("{status} {other}"),
            None => format!("{status} {text}"),
        },
        Err(_) => format!("{status} {text}"),
    }
}

// ── Transport ───────────────────────────────────────────────────────────────

struct Target {
    tls: bool,
    host: String,
    port: u16,
    path: String,
}

impl Target {
    fn of(url: &str) -> Result<Target, String> {
        let (tls, rest) = match (url.strip_prefix("https://"), url.strip_prefix("http://")) {
            (Some(rest), _) => (true, rest),
            (None, Some(rest)) => (false, rest),
            _ => return Err(format!("{url}: a model endpoint is an http:// or https:// url")),
        };
        let (authority, path) = match rest.find('/') {
            Some(at) => (&rest[..at], &rest[at..]),
            None => (rest, "/"),
        };
        let default_port = if tls { 443 } else { 80 };
        let (host, port) = match authority.rsplit_once(':') {
            Some((host, port)) if !host.ends_with(']') || host.starts_with('[') => {
                (host, port.parse::<u16>().map_err(|_| format!("{url}: not a port: {port}"))?)
            }
            _ => (authority, default_port),
        };
        Ok(Target { tls, host: host.trim_matches(['[', ']']).to_string(), port, path: path.to_string() })
    }

    fn authority(&self) -> String {
        let default_port = if self.tls { 443 } else { 80 };
        if self.port == default_port { self.host.clone() } else { format!("{}:{}", self.host, self.port) }
    }
}

fn tls_connector() -> tokio_rustls::TlsConnector {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    let config = CONFIG.get_or_init(|| {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("ring supports the default protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
        Arc::new(config)
    });
    tokio_rustls::TlsConnector::from(config.clone())
}

// ── The reassembled message ─────────────────────────────────────────────────

#[derive(Debug, Default)]
struct Message {
    /// Each content block's type, in order.
    block_types: Vec<String>,
    /// Each block's text (empty for a block that carries none).
    block_texts: Vec<String>,
    stop_reason: Option<String>,
    usage: TokenCounts,
}

impl Message {
    fn text(&self) -> String {
        self.block_types.iter().zip(&self.block_texts).filter(|(kind, _)| *kind == "text").map(|(_, text)| text.as_str()).collect()
    }

    fn take_usage(&mut self, usage: &Json) {
        let count = |field: &str| usage.get(field).and_then(Json::as_u64);
        if let Some(n) = count("input_tokens") {
            self.usage.input = n;
        }
        if let Some(n) = count("output_tokens") {
            self.usage.output = n;
        }
        if let Some(n) = count("cache_read_input_tokens") {
            self.usage.cache_read = n;
        }
        if let Some(n) = count("cache_creation_input_tokens") {
            self.usage.cache_creation = n;
        }
    }

    /// A non-streamed answer, for an endpoint that ignores `stream`.
    fn of_json(bytes: &[u8]) -> Result<Message, String> {
        let parsed: Json = serde_json::from_slice(bytes).map_err(|e| format!("the model endpoint answered a body that is not JSON: {e}"))?;
        let mut message = Message::default();
        for block in parsed.get("content").and_then(Json::as_array).into_iter().flatten() {
            message.block_types.push(block.get("type").and_then(Json::as_str).unwrap_or_default().to_string());
            message.block_texts.push(block.get("text").and_then(Json::as_str).unwrap_or_default().to_string());
        }
        message.stop_reason = parsed.get("stop_reason").and_then(Json::as_str).map(str::to_string);
        if let Some(usage) = parsed.get("usage") {
            message.take_usage(usage);
        }
        Ok(message)
    }

    /// The server-sent events of a streamed message.
    fn of_stream(text: &str) -> Result<Message, RequestError> {
        let mut message = Message::default();
        let mut started = false;
        for event in text.replace("\r\n", "\n").split("\n\n") {
            let data: String = event.lines().filter_map(|line| line.strip_prefix("data:")).map(str::trim_start).collect::<Vec<_>>().join("\n");
            if data.is_empty() {
                continue;
            }
            let Ok(data) = serde_json::from_str::<Json>(&data) else {
                return Err(RequestError::Connection(format!("the model stream carried an event that is not JSON: {data}")));
            };
            match data.get("type").and_then(Json::as_str).unwrap_or_default() {
                "message_start" => {
                    started = true;
                    if let Some(usage) = data.get("message").and_then(|m| m.get("usage")) {
                        message.take_usage(usage);
                    }
                }
                "content_block_start" => {
                    let block = data.get("content_block");
                    message.block_types.push(block.and_then(|b| b.get("type")).and_then(Json::as_str).unwrap_or_default().to_string());
                    message.block_texts.push(block.and_then(|b| b.get("text")).and_then(Json::as_str).unwrap_or_default().to_string());
                }
                "content_block_delta" => {
                    let index = data.get("index").and_then(Json::as_u64).unwrap_or(0) as usize;
                    let delta = data.get("delta");
                    if delta.and_then(|d| d.get("type")).and_then(Json::as_str) == Some("text_delta")
                        && let (Some(more), Some(slot)) = (delta.and_then(|d| d.get("text")).and_then(Json::as_str), message.block_texts.get_mut(index))
                    {
                        slot.push_str(more);
                    }
                }
                "message_delta" => {
                    if let Some(reason) = data.get("delta").and_then(|d| d.get("stop_reason")).and_then(Json::as_str) {
                        message.stop_reason = Some(reason.to_string());
                    }
                    if let Some(usage) = data.get("usage") {
                        message.take_usage(usage);
                    }
                }
                "error" => {
                    let error = data.get("error");
                    let kind = error.and_then(|e| e.get("type")).and_then(Json::as_str).unwrap_or_default();
                    let words = error.and_then(|e| e.get("message")).and_then(Json::as_str).map(str::to_string).unwrap_or_else(|| data.to_string());
                    return Err(RequestError::Stream { retryable: matches!(kind, "overloaded_error" | "api_error"), message: words });
                }
                _ => {}
            }
        }
        if !started {
            return Err(RequestError::Connection("stream ended without producing a Message with role=assistant".into()));
        }
        Ok(message)
    }
}

#[cfg(test)]
pub mod tests {
    use std::sync::Mutex;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    /// One scripted answer of the fake provider.
    pub enum Scripted {
        Stream(String),
        Status(u16, String),
    }

    /// A message as the provider streams it.
    pub fn stream_of(blocks: &[(&str, &str)], stop_reason: &str, usage: (u64, u64)) -> String {
        let mut events: Vec<(&str, Json)> = vec![(
            "message_start",
            json!({ "type": "message_start", "message": { "id": "m", "type": "message", "role": "assistant", "model": "fake", "content": [],
                "stop_reason": null, "stop_sequence": null, "usage": { "input_tokens": usage.0, "output_tokens": 0 } } }),
        )];
        for (index, (kind, text)) in blocks.iter().enumerate() {
            let body_key = if *kind == "thinking" { "thinking" } else { "text" };
            events.push(("content_block_start", json!({ "type": "content_block_start", "index": index, "content_block": { "type": kind, body_key: "" } })));
            if !text.is_empty() {
                let delta = if *kind == "thinking" { json!({ "type": "thinking_delta", "thinking": text }) } else { json!({ "type": "text_delta", "text": text }) };
                events.push(("content_block_delta", json!({ "type": "content_block_delta", "index": index, "delta": delta })));
            }
            events.push(("content_block_stop", json!({ "type": "content_block_stop", "index": index })));
        }
        events.push((
            "message_delta",
            json!({ "type": "message_delta", "delta": { "stop_reason": stop_reason, "stop_sequence": null }, "usage": { "output_tokens": usage.1 } }),
        ));
        events.push(("message_stop", json!({ "type": "message_stop" })));
        events.iter().map(|(name, data)| format!("event: {name}\ndata: {data}\n\n")).collect()
    }

    /// A fake Messages API answering the script in order, then repeating its
    /// last answer; returns its base url and every request body it saw.
    pub async fn fake_anthropic(script: Vec<Scripted>) -> (String, Arc<Mutex<Vec<(Json, Vec<(String, String)>)>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let script = Arc::new(script);
        tokio::spawn(async move {
            let mut served = 0usize;
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                let (head_end, length) = loop {
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        break (0, 0);
                    }
                    raw.extend_from_slice(&buf[..n]);
                    if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&raw[..at]).to_lowercase();
                        let length = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
                        break (at + 4, length);
                    }
                };
                while raw.len() < head_end + length {
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    raw.extend_from_slice(&buf[..n]);
                }
                let head = String::from_utf8_lossy(&raw[..head_end]).to_string();
                let headers = head.lines().skip(1).filter_map(|l| l.split_once(": ")).map(|(k, v)| (k.to_lowercase(), v.to_string())).collect();
                let body: Json = serde_json::from_slice(&raw[head_end..]).unwrap_or(Json::Null);
                log.lock().unwrap().push((body, headers));
                let answer = &script[served.min(script.len() - 1)];
                served += 1;
                let (status, content_type, payload) = match answer {
                    Scripted::Stream(text) => (200, "text/event-stream", text.clone()),
                    Scripted::Status(status, text) => (*status, "application/json", text.clone()),
                };
                let reply = format!("HTTP/1.1 {status} X\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}", payload.len());
                let _ = socket.write_all(reply.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        (url, seen)
    }

    fn quick(url: String) -> Provider {
        let backoff = Backoff { attempts: 4, initial: Duration::ZERO, multiple: 4, rate_limit_wait: Duration::ZERO };
        Provider { key: ProviderKey { api_key: "test-key".into(), base_url: Some(url) }, backoff }
    }

    fn options(effort: Option<&str>, model: &str) -> ChatOptions {
        ChatOptions {
            system: "sys".into(),
            user: UserMessage::Text("hi".into()),
            model: model.into(),
            max_tokens: 100,
            effort: effort.map(str::to_string),
            max_continuations: MAX_CHAT_CONTINUATIONS,
        }
    }

    #[tokio::test]
    async fn a_streamed_reply_is_reassembled_and_sent_on_the_secrets_key() {
        let (url, seen) = fake_anthropic(vec![Scripted::Stream(stream_of(&[("text", "{\"a\":"), ("text", "1}")], "end_turn", (10, 8)))]).await;
        let reply = quick(url).chat_detailed(&options(None, "claude-sonnet-5"), &|| true).await.unwrap();
        assert_eq!(reply.text, "{\"a\":1}");
        assert_eq!(reply.usage, TokenCounts { input: 10, output: 8, cache_read: 0, cache_creation: 0 });
        assert!(!reply.truncated);
        let seen = seen.lock().unwrap();
        let (body, headers) = &seen[0];
        assert!(headers.contains(&("x-api-key".to_string(), "test-key".to_string())));
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["system"][0]["cache_control"], json!({ "type": "ephemeral" }));
        assert_eq!(body["messages"][0], json!({ "role": "user", "content": "hi" }));
        assert!(body.get("thinking").is_none());
    }

    #[tokio::test]
    async fn a_reply_cut_at_the_ceiling_is_continued_where_it_stopped() {
        let (url, seen) = fake_anthropic(vec![
            Scripted::Stream(stream_of(&[("text", "{\"a\":")], "max_tokens", (10, 100))),
            Scripted::Stream(stream_of(&[("text", "1}")], "end_turn", (30, 2))),
        ])
        .await;
        let reply = quick(url).chat_detailed(&options(None, "claude-sonnet-5"), &|| true).await.unwrap();
        assert_eq!((reply.text.as_str(), reply.continuations, reply.truncated), ("{\"a\":1}", 1, false));
        assert_eq!(reply.usage.input, 40);
        let seen = seen.lock().unwrap();
        let second = &seen[1].0["messages"];
        assert_eq!(second[1], json!({ "role": "assistant", "content": "{\"a\":" }));
        assert_eq!(second[2], json!({ "role": "user", "content": "Continue exactly where you left off." }));
    }

    #[tokio::test]
    async fn a_reply_that_only_thought_is_asked_again_one_effort_lower() {
        let (url, seen) = fake_anthropic(vec![
            Scripted::Stream(stream_of(&[("thinking", "hmm")], "max_tokens", (10, 100))),
            Scripted::Stream(stream_of(&[("text", "ok")], "end_turn", (10, 3))),
        ])
        .await;
        let reply = quick(url).chat_detailed(&options(Some("high"), "claude-sonnet-5"), &|| true).await.unwrap();
        assert_eq!(reply.stepped_down, Some(("high".to_string(), "medium".to_string())));
        assert_eq!((reply.text.as_str(), reply.continuations, reply.effort.as_deref()), ("ok", 0, Some("medium")));
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0["output_config"], json!({ "effort": "high" }));
        assert_eq!(seen[0].0["thinking"], json!({ "type": "adaptive" }));
        assert_eq!(seen[1].0["output_config"], json!({ "effort": "medium" }));
    }

    #[tokio::test]
    async fn the_budget_is_asked_before_every_request() {
        let (url, seen) = fake_anthropic(vec![Scripted::Stream(stream_of(&[("text", "x")], "end_turn", (1, 1)))]).await;
        let refused = quick(url).chat_detailed(&options(None, "claude-sonnet-5"), &|| false).await;
        assert_eq!(refused, Err(ChatError::BudgetSpent));
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_server_error_is_retried_and_a_bad_key_is_not() {
        let overloaded = || Scripted::Status(529, r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#.into());
        let (url, seen) = fake_anthropic(vec![overloaded(), Scripted::Stream(stream_of(&[("text", "ok")], "end_turn", (1, 1)))]).await;
        let reply = quick(url).chat_detailed(&options(None, "claude-sonnet-5"), &|| true).await.unwrap();
        assert_eq!(reply.text, "ok");
        assert_eq!(seen.lock().unwrap().len(), 2);

        let (url, seen) = fake_anthropic(vec![Scripted::Status(401, r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#.into())]).await;
        let failed = quick(url).chat_detailed(&options(None, "claude-sonnet-5"), &|| true).await;
        assert_eq!(
            failed,
            Err(ChatError::Failed(r#"401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#.into()))
        );
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    /// Reaches the real provider over TLS with a key that cannot be valid: the
    /// provider's 401 proves the handshake and the request. Run by hand
    /// (`cargo test -p lf https -- --ignored`); it needs the network.
    #[tokio::test]
    #[ignore]
    async fn https_reaches_the_provider() {
        let provider = Provider { key: ProviderKey { api_key: "not-a-key".into(), base_url: None }, backoff: Backoff::default() };
        let Err(ChatError::Failed(message)) = provider.chat_detailed(&options(None, "claude-sonnet-5"), &|| true).await else { panic!("expected a refusal") };
        assert!(message.starts_with("401 "), "{message}");
    }

    #[test]
    fn a_url_names_scheme_host_port_and_path() {
        let t = Target::of("http://127.0.0.1:5557/v1/messages").unwrap();
        assert_eq!((t.tls, t.host.as_str(), t.port, t.path.as_str()), (false, "127.0.0.1", 5557, "/v1/messages"));
        let t = Target::of("https://api.anthropic.com/v1/messages").unwrap();
        assert_eq!((t.tls, t.port, t.authority().as_str()), (true, 443, "api.anthropic.com"));
        assert!(Target::of("ftp://x").is_err());
    }
}
