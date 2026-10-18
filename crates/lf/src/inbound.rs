//! The inbound doors' core, ported from movement-engine `services/inbound`
//! (verify.ts, deliver.ts, push.ts): how a delivery's signature is checked,
//! the one pipeline every provider's webhook delivery goes through, and the
//! two push doors an external calls. Framework-free and store-free: a host
//! supplies its stores (crate::doors is lf's) and sends the answer.
//!
//! The webhook door: intercepts → subscription → provider check → signature
//! → preprocessInbound → capture an event's receipt → advance the pull cursor
//! → queue a work row per receipt and per await wake → ack. Capture, queue,
//! then ack: the sender's 200 means every receipt and wake has its work row.

use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

use crate::http::header;
use crate::json::Js;
use crate::obj;

/// The placeholder a subscription holds until its registration returns a
/// secret (`UNREGISTERED_SECRET`): never a key anything verifies against.
const UNREGISTERED_SECRET: &str = "pending";
/// Slack sends the signed timestamp beside the signature; the scheme fixes it.
const SLACK_TIMESTAMP_HEADER: &str = "x-slack-request-timestamp";
/// The most items one push to either door may carry (`ADAPTER_DOOR_MAX_BATCH`).
const DOOR_MAX_BATCH: usize = 1000;

// ── Signature schemes (verify.ts) ───────────────────────────────────────────

/// The protocol's declarative schemes (`INBOUND_SIGNATURE_SCHEMES`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scheme {
    /// Hex HMAC-SHA256 of the body, an optional `sha256=` prefix (Meta,
    /// GitHub). No secret or no signature never verifies.
    HmacSha256Hex,
    /// Bare hex HMAC-SHA256 of the body. Lenient: an empty secret is a key
    /// like any other.
    Attio,
    /// The secret is base64, the header `hmac-sha256=<hex>` (prefix
    /// optional). Lenient on an empty secret, as `attio` is.
    AirtableMac,
    /// HMAC-SHA256 as hex or base64, an optional `sha256=` prefix in any
    /// case; with no key configured any delivery verifies.
    AffinityHexOrB64,
    /// Slack's `v0:{timestamp}:{body}`, `v0=` prefix optional; no replay window.
    SlackV0,
    /// The token echoed in a header, compared in constant time; no secret
    /// never verifies.
    TelegramSecretToken,
    /// This protocol's own: hex HMAC-SHA256 in `x-listen-fire-signature`,
    /// never with a placeholder or empty secret.
    Remote,
}

impl Scheme {
    fn of(name: &str) -> Option<Scheme> {
        Some(match name {
            "hmac_sha256_hex" => Scheme::HmacSha256Hex,
            "attio" => Scheme::Attio,
            "airtable_mac" => Scheme::AirtableMac,
            "affinity_hex_or_b64" => Scheme::AffinityHexOrB64,
            "slack_v0" => Scheme::SlackV0,
            "telegram_secret_token" => Scheme::TelegramSecretToken,
            "remote" => Scheme::Remote,
            _ => return None,
        })
    }

    /// The headers a scheme reads when a declaration names none of its own.
    fn default_headers(self) -> &'static [&'static str] {
        match self {
            Scheme::HmacSha256Hex => &["x-hub-signature-256"],
            Scheme::Attio => &["attio-signature"],
            Scheme::AirtableMac => &["x-airtable-content-mac"],
            Scheme::AffinityHexOrB64 => &["x-affinity-webhook-signature"],
            Scheme::SlackV0 => &["x-slack-signature"],
            Scheme::TelegramSecretToken => &["x-telegram-bot-api-secret-token"],
            Scheme::Remote => &["x-listen-fire-signature"],
        }
    }
}

/// A request a door answers itself before verifying (`INBOUND_INTERCEPTS`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Intercept {
    /// Slack's one-shot setup check: echo the challenge, unsigned.
    SlackUrlVerification,
}

/// How a provider's webhooks are verified (`WireInboundDeclaration`).
#[derive(Clone, Debug)]
pub struct Declaration {
    /// The door's provider segment, lower case.
    pub provider_key: String,
    pub scheme: Scheme,
    /// Lower case; the first one present carries the signature.
    pub signature_headers: Vec<String>,
    pub intercepts: Vec<Intercept>,
}

impl Declaration {
    /// Validated as `WireInboundDeclaration` parses it.
    pub fn read(value: &Js) -> Result<Declaration, String> {
        let provider_key = value.get("providerKey").and_then(Js::as_str).ok_or("providerKey: expected a string")?;
        let lower_ascii = provider_key.chars().next().is_some_and(|c| c.is_ascii_lowercase())
            && provider_key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
        if !lower_ascii {
            return Err("providerKey: providerKey must be ASCII lower case".into());
        }
        let scheme = value.get("scheme").and_then(Js::as_str).and_then(Scheme::of).ok_or("scheme: expected one of the inbound signature schemes")?;
        let headers = value.get("signatureHeaders").and_then(Js::as_array).ok_or("signatureHeaders: expected an array")?;
        let mut signature_headers = Vec::new();
        for h in headers {
            let name = h.as_str().filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
            signature_headers.push(name.ok_or("signatureHeaders: a signature header is a lower-case header name")?.to_string());
        }
        if signature_headers.is_empty() {
            return Err("signatureHeaders: expected at least one header".into());
        }
        let intercepts = match value.get("intercepts") {
            None => Vec::new(),
            Some(list) => list
                .as_array()
                .ok_or("intercepts: expected an array")?
                .iter()
                .map(|i| match i.as_str() {
                    Some("slack_url_verification") => Ok(Intercept::SlackUrlVerification),
                    _ => Err("intercepts: expected slack_url_verification".to_string()),
                })
                .collect::<Result<_, _>>()?,
        };
        Ok(Declaration { provider_key: provider_key.to_string(), scheme, signature_headers, intercepts })
    }
}

/// The first of `names` that is present, or '' when none is.
fn first_present_header(headers: &[(String, String)], names: &[String]) -> String {
    names.iter().find_map(|name| header(headers, name)).unwrap_or_default().to_string()
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `Buffer.from(text, 'hex')`: pairs decoded up to the first that is not
/// hex, so a malformed signature decodes short.
fn hex_prefix(text: &str) -> Vec<u8> {
    text.as_bytes().chunks_exact(2).map_while(|pair| std::str::from_utf8(pair).ok().and_then(|p| u8::from_str_radix(p, 16).ok())).collect()
}

/// `Buffer.from(text, 'base64')`: lenient, either alphabet, padding optional,
/// anything else skipped.
fn base64_lenient(text: &str) -> Vec<u8> {
    let sextet = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    };
    let bits: Vec<u8> = text.bytes().take_while(|c| *c != b'=').filter_map(sextet).collect();
    let mut out = Vec::new();
    for group in bits.chunks(4) {
        let n = group.iter().enumerate().fold(0u32, |n, (i, s)| n | (u32::from(*s) << (18 - 6 * i)));
        let bytes = n.to_be_bytes();
        out.extend_from_slice(&bytes[1..group.len().max(1)]);
    }
    out
}

/// Equal lengths and equal bytes, in time independent of where they differ.
fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Hex against hex (`sameHex`).
fn same_hex(expected_hex: &str, presented_hex: &str) -> bool {
    same_bytes(&hex_prefix(expected_hex), &hex_prefix(presented_hex))
}

/// Compared as digests, so the comparison takes the same time whatever the
/// lengths (doors.ts `sameSecret`).
pub fn same_secret(presented: &str, expected: &str) -> bool {
    same_bytes(&Sha256::digest(presented.as_bytes()), &Sha256::digest(expected.as_bytes()))
}

/// Slack's packed `{timestamp}:{signature}`, split at the first colon.
fn verify_slack_packed(raw_body: &[u8], packed: &str, secret: &str) -> bool {
    let Some(idx) = packed.find(':').filter(|i| *i > 0) else { return false };
    let (timestamp, signature) = (&packed[..idx], &packed[idx + 1..]);
    if signature.is_empty() {
        return false;
    }
    let presented = signature.strip_prefix("v0=").unwrap_or(signature);
    let signed = format!("v0:{timestamp}:{}", String::from_utf8_lossy(raw_body));
    same_hex(&to_hex(&hmac_sha256(secret.as_bytes(), signed.as_bytes())), presented)
}

fn check(scheme: Scheme, raw_body: &[u8], signature: &str, headers: &[(String, String)], secret: &str) -> bool {
    let hex_of = |key: &[u8]| to_hex(&hmac_sha256(key, raw_body));
    match scheme {
        Scheme::HmacSha256Hex => !signature.is_empty() && !secret.is_empty() && same_hex(&hex_of(secret.as_bytes()), signature.strip_prefix("sha256=").unwrap_or(signature)),
        Scheme::Attio => same_hex(&hex_of(secret.as_bytes()), signature),
        Scheme::AirtableMac => same_hex(&hex_of(&base64_lenient(secret)), signature.strip_prefix("hmac-sha256=").unwrap_or(signature)),
        Scheme::AffinityHexOrB64 => {
            if secret.is_empty() {
                return true;
            }
            let token = match signature.get(..7) {
                Some(prefix) if prefix.eq_ignore_ascii_case("sha256=") => &signature[7..],
                _ => signature,
            }
            .trim();
            if token.is_empty() {
                return false;
            }
            let digest = hmac_sha256(secret.as_bytes(), raw_body);
            let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &digest);
            [to_hex(&digest), b64].iter().any(|expected| same_bytes(expected.as_bytes(), token.as_bytes()))
        }
        Scheme::SlackV0 => {
            let Some(timestamp) = header(headers, SLACK_TIMESTAMP_HEADER) else { return false };
            !signature.is_empty() && verify_slack_packed(raw_body, &format!("{timestamp}:{signature}"), secret)
        }
        Scheme::TelegramSecretToken => !secret.is_empty() && !signature.is_empty() && same_bytes(secret.as_bytes(), signature.as_bytes()),
        Scheme::Remote => {
            if secret.is_empty() || secret == UNREGISTERED_SECRET {
                return false;
            }
            same_bytes(&hmac_sha256(secret.as_bytes(), raw_body), &hex_prefix(signature))
        }
    }
}

/// Check one delivery with a scheme (`verifyWithScheme`), its signature in
/// the first of `signature_headers` present (the scheme's own when none).
pub fn verify_with_scheme(scheme: Scheme, raw_body: &[u8], headers: &[(String, String)], secret: &str, signature_headers: &[String]) -> bool {
    let defaults: Vec<String>;
    let names = if signature_headers.is_empty() {
        defaults = scheme.default_headers().iter().map(|h| h.to_string()).collect();
        &defaults
    } else {
        signature_headers
    };
    check(scheme, raw_body, &first_present_header(headers, names), headers, secret)
}

/// A key a delivery may be verified against: present, not blank, not the
/// placeholder (`isUsableInboundSecret`).
fn is_usable_secret(secret: &str) -> bool {
    !secret.trim().is_empty() && secret != UNREGISTERED_SECRET
}

/// The signed-inbound rule for a declared inbound (`declaredInboundVerifier`):
/// refused when the key is missing, blank or a placeholder, and when the
/// signature is wrong. The leniencies some schemes keep for the doors that
/// predate the core never apply to a declaration.
pub fn verify_declared(declaration: &Declaration, raw_body: &[u8], headers: &[(String, String)], secret: &str) -> bool {
    is_usable_secret(secret) && verify_with_scheme(declaration.scheme, raw_body, headers, secret, &declaration.signature_headers)
}

// ── The answer ──────────────────────────────────────────────────────────────

/// An HTTP answer, framework-free (`InboundAnswer`).
pub struct Answer {
    pub status: u16,
    pub body: Js,
    /// Poke whatever drains the work rows once this is sent (`afterAnswer`).
    pub notify_after: bool,
}

impl Answer {
    fn of(status: u16, body: Js) -> Answer {
        Answer { status, body, notify_after: false }
    }

    fn error(status: u16, code: &str) -> Answer {
        Answer::of(status, Js::Obj(obj! { "error" => Js::str(code) }))
    }

    /// A body over the door's limit, in the doors' own error shape.
    pub fn payload_too_large() -> Answer {
        Answer::error(413, "payload_too_large")
    }
}

/// The requests a door answers before it looks anything up.
fn answer_intercepts(intercepts: &[Intercept], raw_body: &[u8]) -> Option<Answer> {
    for intercept in intercepts {
        match intercept {
            Intercept::SlackUrlVerification => {
                let Ok(parsed) = Js::parse(raw_body) else { continue };
                if parsed.get("type").and_then(Js::as_str) != Some("url_verification") {
                    continue;
                }
                return Some(match parsed.get("challenge") {
                    Some(Js::Str(challenge)) => Answer::of(200, Js::Obj(obj! { "challenge" => Js::str(challenge) })),
                    _ => Answer::error(400, "missing_challenge"),
                });
            }
        }
    }
    None
}

// ── The webhook door (deliver.ts) ───────────────────────────────────────────

/// The row a door URL names.
pub struct Subscription {
    pub id: String,
    pub team_id: String,
    /// The URL's provider segment, upper-cased, must equal it.
    pub provider_key: String,
    pub secret: String,
    pub checkpoint: Option<Js>,
}

/// How a subscription's deliveries are checked and read.
pub struct Source {
    pub declaration: Declaration,
    /// The key its deliveries are signed with.
    pub secret: String,
    /// The external that reads them.
    pub adapter_type: String,
    /// The install (credential) it reads them under.
    pub install: String,
}

/// What `preprocessInbound` read off a delivery.
pub struct Extraction {
    pub events: Vec<Js>,
    pub checkpoint: Option<Js>,
}

/// What a door needs of its host (`InboundStore` with the adapter it opens).
pub trait InboundStore {
    async fn find_subscription(&self, id: &str) -> Result<Option<Subscription>, String>;
    /// Whether a provider key is one this host serves (so a missing row is
    /// `subscription_not_found` rather than `unknown_provider`).
    fn knows_provider(&self, provider_key: &str) -> bool;
    fn intercepts(&self, provider_key: &str) -> Vec<Intercept>;
    async fn source_for(&self, subscription: &Subscription) -> Result<Option<Source>, String>;
    /// Whether the source's adapter reads deliveries (`preprocessInbound`).
    fn reads_deliveries(&self, source: &Source) -> bool;
    async fn preprocess(&self, source: &Source, raw: &Js, checkpoint: Option<&Js>) -> Result<Extraction, String>;
    /// The correlation keys a delivery wakes; empty when the adapter names none.
    async fn wake_keys(&self, source: &Source, raw: &Js) -> Result<Vec<String>, String>;
    /// An event's receipt: what `enqueue` later queues.
    async fn capture(&self, event: &Js, source: &Source) -> Result<Js, String>;
    async fn save_checkpoint(&self, subscription_id: &str, checkpoint: &Js) -> Result<(), String>;
    async fn enqueue(&self, captured: Js, source: &Source) -> Result<(), String>;
    async fn enqueue_wakes(&self, adapter_type: &str, team_id: &str, keys: &[String]) -> Result<(), String>;
    /// Poke whatever drains the work rows.
    fn notify(&self);
}

pub struct Delivery<'a> {
    /// The URL's provider segment, as sent.
    pub provider: &'a str,
    pub subscription_id: &'a str,
    pub raw_body: &'a [u8],
    pub headers: &'a [(String, String)],
}

/// Why a delivery is refused, and the status it is refused with.
enum Refusal {
    UnknownProvider,
    SubscriptionNotFound,
    ProviderMismatch,
    SignatureInvalid,
    CannotPreprocess,
}

impl Refusal {
    fn answer(self) -> Answer {
        let (status, code) = match self {
            Refusal::UnknownProvider => (404, "unknown_provider"),
            Refusal::SubscriptionNotFound => (404, "subscription_not_found"),
            Refusal::ProviderMismatch => (400, "provider_mismatch"),
            Refusal::SignatureInvalid => (401, "signature_invalid"),
            Refusal::CannotPreprocess => (500, "adapter cannot preprocess inbound"),
        };
        Answer::error(status, code)
    }
}

/// The whole webhook door (`answerDelivery`): one delivery in, the answer out.
pub async fn answer_delivery<S: InboundStore>(store: &S, delivery: Delivery<'_>) -> Answer {
    let provider_key = delivery.provider.to_uppercase();
    if let Some(answer) = answer_intercepts(&store.intercepts(&provider_key), delivery.raw_body) {
        return answer;
    }
    match receive_delivery(store, &provider_key, &delivery).await {
        Ok(Ok(events_processed)) => Answer {
            status: 200,
            body: Js::Obj(obj! { "ok" => Js::Bool(true), "eventsProcessed" => Js::Num((events_processed as u64).into()) }),
            notify_after: true,
        },
        Ok(Err(refusal)) => refusal.answer(),
        Err(error) => {
            eprintln!("Webhook sync endpoint error: {error}");
            Answer::error(500, "internal")
        }
    }
}

/// Verify, capture and queue one delivery (`receiveDelivery` and its
/// `queue`): the events captured, or why it is refused. Anything that cannot
/// be queued is an error, so the sender's retry replays it.
async fn receive_delivery<S: InboundStore>(store: &S, provider_key: &str, delivery: &Delivery<'_>) -> Result<Result<usize, Refusal>, String> {
    let Some(subscription) = store.find_subscription(delivery.subscription_id).await? else {
        return Ok(Err(if store.knows_provider(provider_key) { Refusal::SubscriptionNotFound } else { Refusal::UnknownProvider }));
    };
    if subscription.provider_key != provider_key {
        return Ok(Err(Refusal::ProviderMismatch));
    }
    let Some(source) = store.source_for(&subscription).await? else { return Ok(Err(Refusal::UnknownProvider)) };
    // lf has no synthetic subscription: every delivery is verified.
    if !verify_declared(&source.declaration, delivery.raw_body, delivery.headers, &source.secret) {
        eprintln!("Webhook signature verification failed for subscription {}", delivery.subscription_id);
        return Ok(Err(Refusal::SignatureInvalid));
    }
    let body = Js::parse(delivery.raw_body).map_err(|e| format!("the delivery is not JSON: {e}"))?;
    // `preprocessInbound` is the raw→events seam every inbound adapter
    // implements; one that lacks it is a wiring bug, refused loudly.
    if !store.reads_deliveries(&source) {
        eprintln!("[webhook] adapter for provider {} has no preprocessInbound — delivery dropped", subscription.provider_key);
        return Ok(Err(Refusal::CannotPreprocess));
    }
    let extraction = store.preprocess(&source, &body, subscription.checkpoint.as_ref()).await?;

    // Capture: one receipt per event. A receipt that cannot be stored drops
    // its event from the count; the rest go on.
    let mut captured = Vec::new();
    for event in &extraction.events {
        match store.capture(event, &source).await {
            Ok(receipt) => captured.push(receipt),
            Err(error) => eprintln!("Webhook event capture failed: {error}"),
        }
    }

    // The wakes are independent of the events, read after the capture, so a
    // failing wake door never costs the delivery its receipts.
    let wakes = store.wake_keys(&source, &body).await;
    if extraction.events.is_empty() && wakes.as_ref().is_ok_and(Vec::is_empty) {
        return Ok(Ok(0));
    }
    // The pull cursor rides on "receipted", not "run".
    if let Some(checkpoint) = &extraction.checkpoint {
        store.save_checkpoint(&subscription.id, checkpoint).await?;
    }

    // One event's failure never stops the next; the wakes still go in.
    let events_processed = captured.len();
    let mut failures = Vec::new();
    for receipt in captured {
        if let Err(error) = store.enqueue(receipt, &source).await {
            eprintln!("Webhook event processing failed: {error}");
            failures.push(error);
        }
    }
    let keys = wakes.map_err(|error| format!("wakeKeys failed for adapter {}: {error}", source.adapter_type))?;
    store.enqueue_wakes(&source.adapter_type, &subscription.team_id, &keys).await?;
    if !failures.is_empty() {
        return Err(format!("{} receipt(s) of the delivery could not be queued: {}", failures.len(), failures.join("; ")));
    }
    Ok(Ok(events_processed))
}

// ── The push doors (push.ts) ────────────────────────────────────────────────

/// The install a push authenticated as.
pub struct PushCaller {
    pub team_id: String,
    pub adapter_type: String,
}

pub enum PushAuth {
    Authenticated(PushCaller),
    Unauthorized,
    /// The credential matches installs on several teams, and none is named.
    Ambiguous,
}

pub trait PushStore {
    async fn authenticate(&self, adapter_type: &str, headers: &[(String, String)]) -> Result<PushAuth, String>;
    /// The receipts one event earns.
    async fn capture_pushed(&self, caller: &PushCaller, event: &Js) -> Result<Vec<Js>, String>;
    async fn enqueue_pushed(&self, captured: Vec<Js>) -> Result<(), String>;
    async fn enqueue_pushed_wakes(&self, adapter_type: &str, team_id: &str, keys: &[String]) -> Result<(), String>;
    fn notify_pushed(&self);
}

/// Which push door.
#[derive(Clone, Copy)]
pub enum Push {
    Emit,
    Wake,
}

/// One push door's answer (`answerEmit`, `answerWake`): authenticated before
/// the body is judged, so an unauthenticated caller learns nothing about the
/// shape the door wants.
pub async fn answer_push<S: PushStore>(store: &S, push: Push, adapter_type: &str, headers: &[(String, String)], raw_body: &[u8]) -> Answer {
    let body = Js::parse(raw_body).ok();
    let caller = match store.authenticate(adapter_type, headers).await {
        Err(error) => {
            eprintln!("[AdapterDoors] push failed: {error}");
            return Answer::error(500, "internal");
        }
        Ok(PushAuth::Unauthorized) => return Answer::error(401, "unauthorized"),
        Ok(PushAuth::Ambiguous) => {
            return Answer::of(
                409,
                Js::Obj(obj! {
                    "error" => Js::str("ambiguous_credential"),
                    "message" => Js::str("this credential belongs to more than one team's install; name the team in the x-listen-fire-team header"),
                }),
            );
        }
        Ok(PushAuth::Authenticated(caller)) => caller,
    };
    let answered = match push {
        Push::Emit => match emit_body(body.as_ref()) {
            Err(issue) => return bad_request(issue),
            Ok(events) => emit(store, &caller, events).await,
        },
        Push::Wake => match wake_body(body.as_ref()) {
            Err(issue) => return bad_request(issue),
            Ok(keys) => wake(store, &caller, &keys).await,
        },
    };
    answered.unwrap_or_else(|error| {
        eprintln!("[AdapterDoors] push failed: {error}");
        Answer::error(500, "internal")
    })
}

/// `{ events }`: 1 to 1,000 events, each read as the protocol's event (its
/// declared keys, in order).
fn emit_body(body: Option<&Js>) -> Result<Vec<Js>, (String, String)> {
    let events = body.and_then(|b| b.get("events")).and_then(Js::as_array).ok_or(("events".to_string(), "expected an array".to_string()))?;
    if events.is_empty() || events.len() > DOOR_MAX_BATCH {
        return Err(("events".into(), format!("expected between 1 and {DOOR_MAX_BATCH} events")));
    }
    // The events as the protocol's `preprocessInbound` result reads them.
    let read = crate::wire_results::check("preprocessInbound", "emit", &Js::Obj(obj! { "events" => Js::Arr(events.to_vec()) }))
        .map_err(|issue| ("events".to_string(), issue))?;
    Ok(read.get("events").and_then(Js::as_array).map(<[Js]>::to_vec).unwrap_or_default())
}

/// `{ keys }`: 1 to 1,000 non-empty texts.
fn wake_body(body: Option<&Js>) -> Result<Vec<String>, (String, String)> {
    let keys = body.and_then(|b| b.get("keys")).and_then(Js::as_array).ok_or(("keys".to_string(), "expected an array".to_string()))?;
    if keys.is_empty() || keys.len() > DOOR_MAX_BATCH {
        return Err(("keys".into(), format!("expected between 1 and {DOOR_MAX_BATCH} keys")));
    }
    keys.iter().map(|k| k.as_str().filter(|k| !k.is_empty()).map(str::to_string).ok_or(("keys".to_string(), "expected non-empty strings".to_string()))).collect()
}

fn bad_request((path, message): (String, String)) -> Answer {
    Answer::of(
        400,
        Js::Obj(obj! {
            "error" => Js::str("bad_request"),
            "issues" => Js::Arr(vec![Js::Obj(obj! { "path" => Js::Str(path), "message" => Js::Str(message) })]),
        }),
    )
}

/// `emitEvents`: receipt each event and queue a run per receipt. A capture
/// that throws fails the call (500) after the receipts already made are
/// queued, since a receipt without its row would never run.
async fn emit<S: PushStore>(store: &S, caller: &PushCaller, events: Vec<Js>) -> Result<Answer, String> {
    let mut captured = Vec::new();
    let mut failed = 0u64;
    for event in &events {
        match store.capture_pushed(caller, event).await {
            Ok(receipts) => captured.extend(receipts),
            Err(error) => {
                failed += 1;
                eprintln!("[AdapterDoors] emit capture failed for {}: {error}", caller.adapter_type);
            }
        }
    }
    let accepted = captured.len() as u64;
    let any = !captured.is_empty();
    store.enqueue_pushed(captured).await?;
    if any {
        store.notify_pushed();
    }
    if failed > 0 {
        return Ok(Answer::of(500, Js::Obj(obj! { "error" => Js::str("capture_failed"), "accepted" => Js::Num(accepted.into()), "failed" => Js::Num(failed.into()) })));
    }
    Ok(Answer::of(202, Js::Obj(obj! { "accepted" => Js::Num(accepted.into()) })))
}

/// `wakeKeys`: a wake per key; a key nothing is parked on drains as a no-op.
async fn wake<S: PushStore>(store: &S, caller: &PushCaller, keys: &[String]) -> Result<Answer, String> {
    store.enqueue_pushed_wakes(&caller.adapter_type, &caller.team_id, keys).await?;
    store.notify_pushed();
    Ok(Answer::of(202, Js::Obj(obj! { "accepted" => Js::Num((keys.len() as u64).into()) })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    const BODY: &[u8] = br#"{"events":[]}"#;

    #[test]
    fn hmac_sha256_is_rfc_4231s() {
        // RFC 4231 test case 2.
        assert_eq!(to_hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn each_scheme_verifies_its_own_signature() {
        let hex = to_hex(&hmac_sha256(b"s3cret", BODY));
        let no_headers: Vec<String> = Vec::new();
        let ok = |scheme, pairs: &[(&str, &str)], secret: &str| verify_with_scheme(scheme, BODY, &headers(pairs), secret, &no_headers);
        assert!(ok(Scheme::HmacSha256Hex, &[("x-hub-signature-256", &format!("sha256={hex}"))], "s3cret"));
        assert!(!ok(Scheme::HmacSha256Hex, &[("x-hub-signature-256", &format!("sha256={hex}"))], ""));
        assert!(ok(Scheme::Attio, &[("attio-signature", &hex)], "s3cret"));
        assert!(ok(Scheme::Remote, &[("x-listen-fire-signature", &hex)], "s3cret"));
        assert!(!ok(Scheme::Remote, &[("x-listen-fire-signature", &hex)], "pending"));
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, hmac_sha256(b"s3cret", BODY));
        assert!(ok(Scheme::AffinityHexOrB64, &[("x-affinity-webhook-signature", &format!("SHA256={b64}"))], "s3cret"));
        assert!(ok(Scheme::AffinityHexOrB64, &[], ""), "no key configured lets anything in");
        assert!(ok(Scheme::TelegramSecretToken, &[("x-telegram-bot-api-secret-token", "tok")], "tok"));
        let airtable = to_hex(&hmac_sha256(&base64_lenient("c2VjcmV0"), BODY));
        assert!(ok(Scheme::AirtableMac, &[("x-airtable-content-mac", &format!("hmac-sha256={airtable}"))], "c2VjcmV0"));
        let slack = to_hex(&hmac_sha256(b"s3cret", format!("v0:17:{}", std::str::from_utf8(BODY).unwrap()).as_bytes()));
        assert!(ok(Scheme::SlackV0, &[("x-slack-request-timestamp", "17"), ("x-slack-signature", &format!("v0={slack}"))], "s3cret"));
    }

    #[test]
    fn a_declaration_holds_the_signed_inbound_rule() {
        let declared = Declaration { provider_key: "crm".into(), scheme: Scheme::Attio, signature_headers: vec!["x-sig".into()], intercepts: Vec::new() };
        let unsigned_key = to_hex(&hmac_sha256(b"", BODY));
        assert!(verify_with_scheme(Scheme::Attio, BODY, &headers(&[("x-sig", &unsigned_key)]), "", &declared.signature_headers), "attio is lenient alone");
        assert!(!verify_declared(&declared, BODY, &headers(&[("x-sig", &unsigned_key)]), ""), "never under a declaration");
        assert!(!verify_declared(&declared, BODY, &headers(&[("x-sig", &unsigned_key)]), " "));
    }

    #[test]
    fn buffers_decode_as_node_decodes_them() {
        assert_eq!(hex_prefix("0aZZ0b"), vec![0x0a]);
        assert_eq!(hex_prefix("abc"), vec![0xab]);
        assert_eq!(base64_lenient("aGk="), b"hi");
        assert_eq!(base64_lenient("aGk"), b"hi");
        assert_eq!(base64_lenient("-_8"), base64_lenient("+/8"));
    }

    #[test]
    fn a_declaration_reads_as_the_wire_schema_reads_it() {
        let read = |text: &str| Declaration::read(&Js::parse(text.as_bytes()).unwrap());
        let ok = read(r#"{"providerKey":"acme_crm","scheme":"remote","signatureHeaders":["x-listen-fire-signature"],"intercepts":["slack_url_verification"]}"#).unwrap();
        assert_eq!((ok.scheme, ok.intercepts), (Scheme::Remote, vec![Intercept::SlackUrlVerification]));
        assert!(read(r#"{"providerKey":"Acme","scheme":"remote","signatureHeaders":["x"]}"#).is_err());
        assert!(read(r#"{"providerKey":"acme","scheme":"nope","signatureHeaders":["x"]}"#).is_err());
        assert!(read(r#"{"providerKey":"acme","scheme":"remote","signatureHeaders":[]}"#).is_err());
        assert!(read(r#"{"providerKey":"acme","scheme":"remote","signatureHeaders":["X-Upper"]}"#).is_err());
    }
}
