//! The callbacks a run mints, over the state file: the family (movement-
//! engine `services/run_host/store.ts` `CallbackStore`, as the TypeScript lf
//! keeps it in apps/cli/src/state.ts) and the rules a call is judged and
//! recorded by (`services/run_host/callbacks.ts`). A door (`POST
//! /api/cb/<id>`, `lf call`) records a call; the run's body then runs under
//! the run's lease (crate::runs).
//!
//! A call's life: validated first, so a bad payload never consumes a
//! single-use callback; recorded with its body queued as work in the same
//! transaction; its body marked started (the call lands) and run under the
//! lease; only then are the run's awaits on the callback woken.

use base64::Engine as _;
use rusqlite::{OptionalExtension, params};

use crate::json::{Js, Obj};
use crate::obj;
use crate::store::{Store, StoreError, iso};

/// Every door's one recognition test. Compared, never parsed.
pub const CALLBACK_ID_PREFIX: &str = "cb_";
/// The correlation map's adapter type for a callback await (`CALLBACK_AWAIT_TYPE`).
pub const CALLBACK_AWAIT_TYPE: &str = "callback";
pub const CALLBACK_BODY_WORK_KIND: &str = "fire_callback";
/// The scalar types a fire-time parameter may declare (`CALLBACK_PARAM_TYPES`).
const CALLBACK_PARAM_TYPES: &[&str] = &["text", "number", "boolean", "date", "datetime", "json", "file"];

type Result<T> = std::result::Result<T, StoreError>;

pub fn is_callback_id(value: &str) -> bool {
    value.starts_with(CALLBACK_ID_PREFIX)
}

/// The prefix and 24 random bytes, base64url: the id is the authorization,
/// so it must not be guessable.
fn new_callback_id() -> String {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    format!("{CALLBACK_ID_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_24(&bytes)))
}

/// 24 bytes of the two uuids' random bits: each uuid's version and variant
/// bytes (6 and 8) are left out.
fn random_24(bytes: &[u8; 32]) -> [u8; 24] {
    let mut out = [0u8; 24];
    let picked = bytes.iter().enumerate().filter(|(i, _)| i % 16 != 6 && i % 16 != 8).map(|(_, b)| *b);
    for (slot, byte) in out.iter_mut().zip(picked) {
        *slot = byte;
    }
    out
}

/// The link a callback's `url` reads, under the host's public base (`callbackUrl`).
pub fn callback_url(base_url: &str, id: &str) -> String {
    format!("{}/api/cb/{id}", base_url.trim_end_matches('/'))
}

/// An instant as `Date.prototype.toISOString` writes it; None when it is not one.
pub fn to_iso(text: &str) -> Option<String> {
    let at: jiff::Timestamp = text.trim().parse().ok().or_else(|| date_only(text))?;
    let ms = at.as_millisecond();
    let whole = jiff::Timestamp::from_millisecond(ms).ok()?;
    Some(format!("{}.{:03}Z", whole.strftime("%Y-%m-%dT%H:%M:%S"), ms.rem_euclid(1000)))
}

/// `YYYY-MM-DD`, which `new Date` reads as midnight UTC.
fn date_only(text: &str) -> Option<jiff::Timestamp> {
    let date: jiff::civil::Date = text.trim().parse().ok()?;
    date.to_zoned(jiff::tz::TimeZone::UTC).ok().map(|z| z.timestamp())
}

fn millis(text: &str) -> Option<i64> {
    text.parse::<jiff::Timestamp>().ok().map(|t| t.as_millisecond())
}

// ── The record ──────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Live,
    Fired,
    Revoked,
}

impl Status {
    fn of(text: &str) -> Result<Status> {
        match text {
            "live" => Ok(Status::Live),
            "fired" => Ok(Status::Fired),
            "revoked" => Ok(Status::Revoked),
            other => Err(StoreError::Invalid(format!("not a callback status: {other}"))),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Status::Live => "live",
            Status::Fired => "fired",
            Status::Revoked => "revoked",
        }
    }
}

/// One recorded call: when, its values, and when its body started (it landed).
#[derive(Clone, Debug)]
pub struct LedgerCall {
    pub at: String,
    pub values: Obj,
    pub body_started_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct CallbackRecord {
    pub id: String,
    pub team_id: String,
    pub run_id: String,
    pub address: String,
    /// `{ name, type }` each, in declaration order.
    pub params: Vec<(String, String)>,
    pub state: Js,
    pub calls: Vec<LedgerCall>,
    pub single_use: bool,
    pub expires_at: Option<String>,
    pub status: Status,
}

fn params_js(params: &[(String, String)]) -> Js {
    Js::Arr(params.iter().map(|(name, kind)| Js::Obj(obj! { "name" => Js::str(name), "type" => Js::str(kind) })).collect())
}

fn calls_js(calls: &[LedgerCall]) -> Js {
    Js::Arr(
        calls
            .iter()
            .map(|call| {
                let mut out = obj! { "at" => Js::str(&call.at), "values" => Js::Obj(call.values.clone()) };
                if let Some(started) = &call.body_started_at {
                    out.insert("bodyStartedAt".into(), Js::str(started));
                }
                Js::Obj(out)
            })
            .collect(),
    )
}

impl CallbackRecord {
    pub fn to_js(&self) -> Js {
        Js::Obj(obj! {
            "id" => Js::str(&self.id),
            "teamId" => Js::str(&self.team_id),
            "runId" => Js::str(&self.run_id),
            "address" => Js::str(&self.address),
            "params" => params_js(&self.params),
            "state" => self.state.clone(),
            "calls" => calls_js(&self.calls),
            "singleUse" => Js::Bool(self.single_use),
            "expiresAt" => self.expires_at.as_deref().map(Js::str).unwrap_or(Js::Null),
            "status" => Js::str(self.status.name()),
        })
    }

    /// The calls that have landed (their body started): what `cb-[:Called]->`
    /// reads (`landedCalls`).
    pub fn landed_calls(&self) -> Js {
        Js::Arr(
            self.calls
                .iter()
                .filter(|call| call.body_started_at.is_some())
                .map(|call| Js::Obj(obj! { "at" => Js::str(&call.at), "values" => Js::Obj(call.values.clone()) }))
                .collect(),
        )
    }
}

fn invalid(what: &str) -> StoreError {
    StoreError::Invalid(format!("a stored callback's {what} does not read"))
}

fn params_of(value: &Js) -> Result<Vec<(String, String)>> {
    let items = value.as_array().ok_or_else(|| invalid("params"))?;
    items
        .iter()
        .map(|p| {
            let name = p.get("name").and_then(Js::as_str).ok_or_else(|| invalid("params"))?;
            let kind = p.get("type").and_then(Js::as_str).filter(|t| CALLBACK_PARAM_TYPES.contains(t)).ok_or_else(|| invalid("params"))?;
            Ok((name.to_string(), kind.to_string()))
        })
        .collect()
}

fn calls_of(value: &Js) -> Result<Vec<LedgerCall>> {
    let items = value.as_array().ok_or_else(|| invalid("calls"))?;
    items
        .iter()
        .map(|c| {
            let at = c.get("at").and_then(Js::as_str).ok_or_else(|| invalid("calls"))?.to_string();
            let Some(Js::Obj(values)) = c.get("values") else { return Err(invalid("calls")) };
            let body_started_at = match c.get("bodyStartedAt") {
                None => None,
                Some(Js::Str(s)) => Some(s.clone()),
                Some(_) => return Err(invalid("calls")),
            };
            Ok(LedgerCall { at, values: values.clone(), body_started_at })
        })
        .collect()
}

fn parse(text: &str) -> Result<Js> {
    Js::parse(text.as_bytes()).map_err(|e| StoreError::Invalid(format!("a stored callback value is not JSON: {e}")))
}

/// What recording a call came to (`CallbackClaim`).
pub enum Claim {
    Recorded { callback: CallbackRecord, call_index: usize },
    NotFound,
    Closed(CallbackRecord),
    Expired(CallbackRecord),
}

impl Claim {
    pub fn to_js(&self) -> Js {
        match self {
            Claim::Recorded { callback, call_index } => {
                Js::Obj(obj! { "kind" => Js::str("recorded"), "callback" => callback.to_js(), "callIndex" => Js::Num((*call_index as u64).into()) })
            }
            Claim::NotFound => Js::Obj(obj! { "kind" => Js::str("not_found") }),
            Claim::Closed(callback) => Js::Obj(obj! { "kind" => Js::str("closed"), "callback" => callback.to_js() }),
            Claim::Expired(callback) => Js::Obj(obj! { "kind" => Js::str("expired"), "callback" => callback.to_js() }),
        }
    }
}

/// Which a refusal judges: a new call at the door, or a call already recorded.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CallFor {
    NewCall,
    RecordedCall,
}

/// `callbackRefusal`: revoked refuses both; a new call is refused by a
/// single-use callback that already fired, and by expiry. A recorded call is
/// not: firing it is what made the callback `fired`, and it was recorded
/// inside its window.
pub fn refusal(callback: &CallbackRecord, judged: CallFor, now: &str) -> Option<Refusal> {
    if callback.status == Status::Revoked {
        return Some(Refusal::Closed);
    }
    if judged == CallFor::RecordedCall {
        return None;
    }
    if callback.status == Status::Fired {
        return Some(Refusal::Closed);
    }
    if let Some(expires_at) = &callback.expires_at
        && let (Some(expires), Some(now)) = (millis(expires_at), millis(now))
        && expires <= now
    {
        return Some(Refusal::Expired);
    }
    None
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Refusal {
    Closed,
    Expired,
}

impl Refusal {
    pub fn name(self) -> &'static str {
        match self {
            Refusal::Closed => "closed",
            Refusal::Expired => "expired",
        }
    }
}

/// The body's work row (`callbackBodyWork`): keyed by the call, so a call is
/// queued once however often this is reached.
pub fn queue_body(store: &Store, callback_id: &str, team_id: &str, call_index: usize, due_at: &str) -> Result<()> {
    let payload = Js::Obj(obj! { "callbackId" => Js::str(callback_id), "teamId" => Js::str(team_id), "callIndex" => Js::Num((call_index as u64).into()) });
    store.enqueue(CALLBACK_BODY_WORK_KIND, &format!("{CALLBACK_BODY_WORK_KIND}:{callback_id}:{call_index}"), &payload, Some(due_at))
}

// ── The family, over the state file ─────────────────────────────────────────

impl Store {
    pub fn mint_callback(&self, team_id: &str, run_id: &str, address: &str, params: &[(String, String)], state: &Js, single_use: bool, expires_at: Option<&str>) -> Result<String> {
        let id = new_callback_id();
        let expires_at = match expires_at {
            None => None,
            Some(text) => Some(to_iso(text).ok_or_else(|| StoreError::Invalid(format!("expiresAt: not an instant: {text}")))?),
        };
        self.db.execute(
            "insert into callback (id, team_id, run_id, address, params, state, calls, single_use, expires_at, status, created_at)
             values (?, ?, ?, ?, ?, ?, '[]', ?, ?, 'live', ?)",
            params![id, team_id, run_id, address, params_js(params).to_json(), state.to_json(), i64::from(single_use), expires_at, iso(0)],
        )?;
        Ok(id)
    }

    /// The callback, or None (an id never minted, or one without the prefix,
    /// which never reaches a query).
    pub fn callback(&self, id: &str) -> Result<Option<CallbackRecord>> {
        if !is_callback_id(id) {
            return Ok(None);
        }
        let row = self
            .db
            .query_row(
                "select id, team_id, run_id, address, params, state, calls, single_use, expires_at, status from callback where id = ?",
                params![id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, i64>(7)?,
                        r.get::<_, Option<String>>(8)?,
                        r.get::<_, String>(9)?,
                    ))
                },
            )
            .optional()?;
        let Some((id, team_id, run_id, address, params, state, calls, single_use, expires_at, status)) = row else { return Ok(None) };
        Ok(Some(CallbackRecord {
            id,
            team_id,
            run_id,
            address,
            params: params_of(&parse(&params)?)?,
            state: parse(&state)?,
            calls: calls_of(&parse(&calls)?)?,
            single_use: single_use == 1,
            expires_at,
            status: Status::of(&status)?,
        }))
    }

    /// Record one call: one transaction reads the row, judges it live and
    /// unexpired by this file's clock, appends the call and queues its body.
    pub fn record_call(&self, id: &str, values: &Obj, body_due_at: &str) -> Result<Claim> {
        self.transaction(|db| {
            let Some(mut callback) = self.callback(id)? else { return Ok(Claim::NotFound) };
            let now = iso(0);
            match refusal(&callback, CallFor::NewCall, &now) {
                Some(Refusal::Expired) => return Ok(Claim::Expired(callback)),
                Some(Refusal::Closed) => return Ok(Claim::Closed(callback)),
                None => {}
            }
            callback.calls.push(LedgerCall { at: now.clone(), values: values.clone(), body_started_at: None });
            callback.status = if callback.single_use { Status::Fired } else { Status::Live };
            db.execute(
                "update callback set calls = ?, status = ?, fired_at = case when ? then ? else fired_at end where id = ?",
                params![calls_js(&callback.calls).to_json(), callback.status.name(), i64::from(callback.single_use), now, id],
            )?;
            let call_index = callback.calls.len() - 1;
            queue_body(self, id, &callback.team_id, call_index, body_due_at)?;
            Ok(Claim::Recorded { callback, call_index })
        })
    }

    /// Mark call `call_index`'s body started (the call lands); given `fence`,
    /// only while the callback's run is leased under it.
    pub fn mark_body_started(&self, id: &str, call_index: usize, fence: Option<&str>) -> Result<bool> {
        self.transaction(|db| {
            let Some(mut callback) = self.callback(id)? else { return Ok(false) };
            if call_index >= callback.calls.len() {
                return Ok(false);
            }
            if let Some(fence) = fence
                && !Store::holds(db, &callback.run_id, fence)?
            {
                return Ok(false);
            }
            callback.calls[call_index].body_started_at = Some(iso(0));
            db.execute("update callback set calls = ? where id = ?", params![calls_js(&callback.calls).to_json(), id])?;
            Ok(true)
        })
    }

    /// Those of `ids` with at least one landed call.
    pub fn landed(&self, ids: &[String]) -> Result<Vec<String>> {
        let mut out = Vec::new();
        for id in ids {
            if self.callback(id)?.is_some_and(|c| c.calls.iter().any(|call| call.body_started_at.is_some())) {
                out.push(id.clone());
            }
        }
        Ok(out)
    }

    /// An operator asks to cancel the run (`requestCancel`): the first
    /// request's reason stands, and a run already over takes none. True when
    /// the run is open and now carries a request.
    pub fn request_cancel(&self, run_id: &str, reason: Option<&str>) -> Result<bool> {
        self.db.execute(
            "update run set cancel_requested_at = ?, cancel_reason = ? where id = ? and cancel_requested_at is null and status in ('running', 'parked')",
            params![iso(0), reason, run_id],
        )?;
        let row = self
            .db
            .query_row("select status, cancel_requested_at from run where id = ?", params![run_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))
            .optional()?;
        Ok(row.is_some_and(|(status, requested)| requested.is_some() && (status == "running" || status == "parked")))
    }
}

// ── The rule a call's values are judged by ─────────────────────────────────

fn signature(params: &[(String, String)]) -> String {
    params.iter().map(|(name, kind)| format!("{name} ({kind})")).collect::<Vec<_>>().join(", ")
}

/// `coerceCallbackValues`: every declared parameter present and coercible to
/// its declared type, and nothing undeclared (a silent drop is the absence of
/// a guarantee, not a weaker one).
pub fn coerce_values(params: &[(String, String)], raw: &Obj) -> std::result::Result<Obj, String> {
    let extra: Vec<&str> = raw.keys().map(String::as_str).filter(|k| !params.iter().any(|(name, _)| name == k)).collect();
    if !extra.is_empty() {
        return Err(if params.is_empty() {
            format!("this callback takes no values, but {} was sent", extra.iter().map(|e| format!("'{e}'")).collect::<Vec<_>>().join(", "))
        } else {
            format!("'{}' is not a parameter of this callback — it takes: {}", extra.join("', '"), signature(params))
        });
    }
    let mut values = Obj::new();
    for (name, kind) in params {
        let Some(value) = raw.get(name) else {
            return Err(format!("missing '{name}' — this callback expects {}", signature(params)));
        };
        values.insert(name.clone(), coerce_one(name, kind, value)?);
    }
    Ok(values)
}

/// `String(value)`, as JavaScript writes the JSON values a call carries.
fn js_string(value: &Js) -> String {
    match value {
        Js::Str(s) => s.clone(),
        Js::Null => "null".into(),
        Js::Bool(b) => b.to_string(),
        Js::Num(n) => n.to_string(),
        Js::Arr(items) => items.iter().map(|i| if matches!(i, Js::Null) { String::new() } else { js_string(i) }).collect::<Vec<_>>().join(","),
        Js::Obj(_) => "[object Object]".into(),
    }
}

/// `Number(text)`: blank is 0; decimal, exponent and 0x/0o/0b forms.
fn js_number(text: &str) -> Option<f64> {
    let t = text.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    let radix = |prefix: &[&str], radix: u32| prefix.iter().find_map(|p| t.strip_prefix(p)).map(|digits| u64::from_str_radix(digits, radix).ok().map(|n| n as f64));
    if let Some(n) = radix(&["0x", "0X"], 16).or_else(|| radix(&["0o", "0O"], 8)).or_else(|| radix(&["0b", "0B"], 2)) {
        return n;
    }
    let lower = t.to_ascii_lowercase();
    // Rust reads `inf`, `nan` and `infinity` where JavaScript does not; none is finite anyway.
    if lower.contains("inf") || lower.contains("nan") {
        return None;
    }
    t.parse::<f64>().ok()
}

pub fn number(n: f64) -> Js {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        Js::Num((n as i64).into())
    } else {
        serde_json::Number::from_f64(n).map(Js::Num).unwrap_or(Js::Null)
    }
}

fn coerce_one(name: &str, kind: &str, raw: &Js) -> std::result::Result<Js, String> {
    let bad = |saw: String| Err(format!("'{name}' expects {kind}, but {saw}"));
    match kind {
        "text" => Ok(Js::Str(js_string(raw))),
        "number" => {
            let n = match raw {
                Js::Num(n) => n.as_f64(),
                other => js_number(&js_string(other)),
            };
            match n.filter(|n| n.is_finite()) {
                Some(n) => Ok(number(n)),
                None => bad(format!("'{}' is not a number", js_string(raw))),
            }
        }
        "boolean" => {
            if let Js::Bool(b) = raw {
                return Ok(Js::Bool(*b));
            }
            match js_string(raw).trim().to_lowercase().as_str() {
                "true" | "yes" | "1" => Ok(Js::Bool(true)),
                "false" | "no" | "0" => Ok(Js::Bool(false)),
                _ => bad(format!("'{}' is not true or false", js_string(raw))),
            }
        }
        "date" | "datetime" => match to_iso(&js_string(raw)) {
            Some(at) => Ok(Js::Str(if kind == "date" { at[..10].to_string() } else { at })),
            None => bad(format!("'{}' is not a date", js_string(raw))),
        },
        "json" => match raw {
            Js::Str(text) => Js::parse(text.as_bytes()).or_else(|_| bad(format!("'{text}' is not valid JSON"))),
            other => Ok(other.clone()),
        },
        // A handle the calling system owns: passed through, never invented here.
        _ => Ok(raw.clone()),
    }
}

/// What a door's call came to (`CallbackCallOutcome`).
pub enum CallOutcome {
    Recorded { callback: CallbackRecord, call_index: usize },
    NotFound,
    Closed,
    Expired,
    Mismatch(String),
}

impl CallOutcome {
    pub fn kind(&self) -> &'static str {
        match self {
            CallOutcome::Recorded { .. } => "recorded",
            CallOutcome::NotFound => "not_found",
            CallOutcome::Closed => "closed",
            CallOutcome::Expired => "expired",
            CallOutcome::Mismatch(_) => "mismatch",
        }
    }
}

/// `recordCallbackCall`: validate and record a call. Its body is queued with
/// it, due at `body_due_at`; a durable wake of the callback's awaits is
/// queued too, due at `wake_due_at` and coalesced per callback, so a wake
/// lost to a crash still finds the landed call.
pub fn record_callback_call(store: &Store, id: &str, values: &Obj, body_due_at: &str, wake_due_at: &str) -> Result<CallOutcome> {
    let Some(existing) = store.callback(id)? else { return Ok(CallOutcome::NotFound) };
    let coerced = match coerce_values(&existing.params, values) {
        Ok(coerced) => coerced,
        Err(message) => return Ok(CallOutcome::Mismatch(message)),
    };
    let (callback, call_index) = match store.record_call(id, &coerced, body_due_at)? {
        Claim::Recorded { callback, call_index } => (callback, call_index),
        Claim::NotFound => return Ok(CallOutcome::NotFound),
        Claim::Closed(_) => return Ok(CallOutcome::Closed),
        Claim::Expired(_) => return Ok(CallOutcome::Expired),
    };
    let wake = Js::Obj(obj! { "adapterType" => Js::str(CALLBACK_AWAIT_TYPE), "teamId" => Js::str(&callback.team_id), "correlationKey" => Js::str(&callback.id) });
    store.enqueue("wake_await", &format!("wake_await:callback_backstop:{}", callback.id), &wake, Some(wake_due_at))?;
    Ok(CallOutcome::Recorded { callback, call_index })
}

/// The run's callback-backed awaits that are resolvable now
/// (`callbackAwaitKeeper.loadResolvable`): a park on a callback one of whose
/// calls has landed.
pub fn resolvable_awaits(store: &Store, run_id: &str) -> Result<Vec<String>> {
    let parks = store.of_run(run_id, CALLBACK_AWAIT_TYPE)?;
    if parks.is_empty() {
        return Ok(Vec::new());
    }
    let mut keys: Vec<String> = parks.iter().map(|(_, key)| key.clone()).collect();
    keys.dedup();
    let landed = store.landed(&keys)?;
    Ok(parks.into_iter().filter(|(_, key)| landed.contains(key)).map(|(park, _)| park.address).collect())
}

// ── The contract bridge's methods ───────────────────────────────────────────

pub enum RpcFailure {
    Store(StoreError),
    Params(String),
}

impl From<StoreError> for RpcFailure {
    fn from(error: StoreError) -> Self {
        RpcFailure::Store(error)
    }
}

/// The callback family and the run records over the contract bridge
/// (`callbacks.*`, `runs.*`); None for a method that is neither.
pub fn rpc(store: &Store, method: &str, params: &Js) -> Option<std::result::Result<Js, RpcFailure>> {
    let text = |key: &str| params.get(key).and_then(Js::as_str).ok_or_else(|| RpcFailure::Params(format!("{key}: expected a string")));
    let optional = |key: &str| match params.get(key) {
        None | Some(Js::Null) => Ok(None),
        Some(Js::Str(s)) => Ok(Some(s.as_str())),
        Some(_) => Err(RpcFailure::Params(format!("{key}: expected a string"))),
    };
    let answer = (|| -> std::result::Result<Js, RpcFailure> {
        Ok(match method {
            "callbacks.mint" => {
                let declared = params_of(params.get("params").unwrap_or(&Js::Null)).map_err(|_| RpcFailure::Params("params: expected { name, type } each".into()))?;
                let single_use = match params.get("singleUse") {
                    Some(Js::Bool(b)) => *b,
                    _ => return Err(RpcFailure::Params("singleUse: expected a boolean".into())),
                };
                let state = params.get("state").cloned().unwrap_or(Js::Null);
                let id = store.mint_callback(text("teamId")?, text("runId")?, text("address")?, &declared, &state, single_use, optional("expiresAt")?)?;
                Js::Obj(obj! { "id" => Js::Str(id) })
            }
            "callbacks.get" => store.callback(text("id")?)?.map(|c| c.to_js()).unwrap_or(Js::Null),
            "callbacks.record" => {
                let Some(Js::Obj(values)) = params.get("values") else { return Err(RpcFailure::Params("values: expected an object".into())) };
                store.record_call(text("id")?, values, text("bodyDueAt")?)?.to_js()
            }
            "callbacks.markBodyStarted" => {
                let index = params.get("callIndex").and_then(|n| match n {
                    Js::Num(n) => n.as_u64(),
                    _ => None,
                });
                let index = index.ok_or_else(|| RpcFailure::Params("callIndex: expected a whole number".into()))?;
                Js::Bool(store.mark_body_started(text("id")?, index as usize, optional("fence")?)?)
            }
            "callbacks.landed" => {
                let ids: Vec<String> = params
                    .get("ids")
                    .and_then(Js::as_array)
                    .and_then(|items| items.iter().map(|i| i.as_str().map(str::to_string)).collect())
                    .ok_or_else(|| RpcFailure::Params("ids: expected an array of strings".into()))?;
                Js::strings(store.landed(&ids)?)
            }
            "callbacks.revokeRun" | "runs.closeRun" => {
                store.revoke_run_callbacks(text("runId")?)?;
                Js::Null
            }
            "runs.cancelRequest" => match store.cancel_request(text("runId")?)? {
                None => Js::Null,
                Some(reason) => Js::Obj(obj! { "reason" => reason.map(Js::Str).unwrap_or(Js::Null) }),
            },
            "runs.markFailed" => {
                store.mark_failed(text("runId")?, text("message")?)?;
                Js::Null
            }
            "runs.requestCancel" => {
                store.request_cancel(text("runId")?, optional("reason")?)?;
                Js::Null
            }
            "runs.status" => store.run(text("runId")?)?.map(|r| Js::Str(r.status)).unwrap_or_else(|| Js::str("missing")),
            "runs.complete" => {
                store.settle_run(text("runId")?, "completed", &Js::Null, &iso(0))?;
                Js::Null
            }
            _ => return Err(RpcFailure::Params(String::new())),
        })
    })();
    match answer {
        Err(RpcFailure::Params(message)) if message.is_empty() => None,
        other => Some(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_is_the_prefix_and_32_base64url_characters() {
        let id = new_callback_id();
        assert!(is_callback_id(&id));
        assert_eq!(id.len(), 3 + 32);
        assert!(id[3..].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_ne!(id, new_callback_id());
    }

    #[test]
    fn values_are_coerced_as_the_typescript_rule_coerces_them() {
        let params = vec![("n".to_string(), "number".to_string()), ("ok".to_string(), "boolean".to_string()), ("on".to_string(), "date".to_string())];
        let raw = |text: &str| match Js::parse(text.as_bytes()).unwrap() {
            Js::Obj(map) => map,
            _ => unreachable!(),
        };
        let coerced = coerce_values(&params, &raw(r#"{"n":"3","ok":"yes","on":"2026-10-17T09:30:00Z"}"#)).unwrap();
        assert_eq!(Js::Obj(coerced).to_json(), r#"{"n":3,"ok":true,"on":"2026-10-17"}"#);
        assert_eq!(coerce_values(&params, &raw(r#"{"n":"many","ok":true,"on":"2026-01-01"}"#)).unwrap_err(), "'n' expects number, but 'many' is not a number");
        assert_eq!(
            coerce_values(&params[..1], &raw(r#"{"n":1,"other":2}"#)).unwrap_err(),
            "'other' is not a parameter of this callback — it takes: n (number)"
        );
        assert_eq!(coerce_values(&[], &raw(r#"{"x":1}"#)).unwrap_err(), "this callback takes no values, but 'x' was sent");
        assert_eq!(coerce_values(&params[..1], &raw("{}")).unwrap_err(), "missing 'n' — this callback expects n (number)");
    }

    #[test]
    fn an_instant_is_written_as_to_iso_string_writes_it() {
        assert_eq!(to_iso("2026-10-17T09:30:00Z").as_deref(), Some("2026-10-17T09:30:00.000Z"));
        assert_eq!(to_iso("2026-10-17T09:30:00.5+01:00").as_deref(), Some("2026-10-17T08:30:00.500Z"));
        assert_eq!(to_iso("2026-10-17").as_deref(), Some("2026-10-17T00:00:00.000Z"));
        assert_eq!(to_iso("soon"), None);
    }
}
