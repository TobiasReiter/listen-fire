//! The callbacks a run mints: the rules a call is judged and recorded by
//! (movement-engine `services/run_host/callbacks.ts`) over the store
//! trait's callback family (crate::backend), and the SQLite state file's
//! implementation of that family. A door (`POST /api/cb/<id>`, `lf call`) records a
//! call; the run's body then runs under the run's lease (crate::runs).
//!
//! A call's life: validated first, so a bad payload never consumes a
//! single-use callback; recorded with its body queued as work in the same
//! transaction; its body marked started (the call lands) and run under the
//! lease; only then are the run's awaits on the callback woken.

use rusqlite::{OptionalExtension, params};

use crate::backend::{CallbackClaim, CallbackRecord, MintCallback, RunHostStore};
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

/// A fresh callback id: the prefix and 24 random bytes, base64url
/// (`newCallbackId`). The id is the authorization, so it must not be guessable.
pub fn new_callback_id() -> Result<String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| StoreError::Backend(format!("no random bytes for a callback id: {e}")))?;
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut id = String::from(CALLBACK_ID_PREFIX);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(chunk[1]) << 8) | u32::from(chunk[2]);
        for shift in [18, 12, 6, 0] {
            id.push(char::from(ALPHABET[((n >> shift) & 63) as usize]));
        }
    }
    Ok(id)
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

// ── The record, read ────────────────────────────────────────────────────────

/// One recorded call: when, its values, and when its body started (it landed).
#[derive(Clone, Debug)]
pub struct LedgerCall {
    pub at: String,
    pub values: Obj,
    pub body_started_at: Option<String>,
}

fn invalid(what: &str) -> StoreError {
    StoreError::Invalid(format!("a stored callback's {what} does not read"))
}

/// The callback's fire-time signature: `{ name, type }` each, in declaration order.
pub fn declared_params(callback: &CallbackRecord) -> Result<Vec<(String, String)>> {
    params_of(&callback.params)
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

/// The callback's call ledger.
pub fn ledger(callback: &CallbackRecord) -> Result<Vec<LedgerCall>> {
    let items = callback.calls.as_array().ok_or_else(|| invalid("calls"))?;
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

/// The calls that have landed (their body started): what `cb-[:Called]->`
/// reads (`landedCalls`).
pub fn landed_calls(callback: &CallbackRecord) -> Result<Js> {
    Ok(Js::Arr(
        ledger(callback)?
            .into_iter()
            .filter(|call| call.body_started_at.is_some())
            .map(|call| Js::Obj(obj! { "at" => Js::Str(call.at), "values" => Js::Obj(call.values) }))
            .collect(),
    ))
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
    if callback.status == "revoked" {
        return Some(Refusal::Closed);
    }
    if judged == CallFor::RecordedCall {
        return None;
    }
    if callback.status == "fired" {
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

/// The body's work row (`callbackBodyWork`): keyed by the call, so a call is
/// queued once however often this is reached.
pub fn queue_body(store: &dyn RunHostStore, callback_id: &str, team_id: &str, call_index: usize, due_at: &str) -> Result<()> {
    let payload = Js::Obj(obj! { "callbackId" => Js::str(callback_id), "teamId" => Js::str(team_id), "callIndex" => Js::Num((call_index as u64).into()) });
    store.enqueue(CALLBACK_BODY_WORK_KIND, &format!("{CALLBACK_BODY_WORK_KIND}:{callback_id}:{call_index}"), &payload, Some(due_at), Some(team_id))
}

// ── The family over the state file (the trait's SQLite implementation) ─────

fn parse(text: &str) -> Result<Js> {
    Js::parse(text.as_bytes()).map_err(|e| StoreError::Invalid(format!("a stored callback value is not JSON: {e}")))
}

impl Store {
    pub fn mint_callback(&self, mint: MintCallback<'_>) -> Result<String> {
        let MintCallback { team_id, run_id, address, params, state, single_use, expires_at } = mint;
        params_of(params).map_err(|_| StoreError::Invalid("params: expected { name, type } each".into()))?;
        let id = new_callback_id()?;
        let expires_at = match expires_at {
            None => None,
            Some(text) => Some(to_iso(text).ok_or_else(|| StoreError::Invalid(format!("expiresAt: not an instant: {text}")))?),
        };
        self.db.execute(
            "insert into callback (id, team_id, run_id, address, params, state, calls, single_use, expires_at, status, created_at)
             values (?, ?, ?, ?, ?, ?, '[]', ?, ?, 'live', ?)",
            params![id, team_id, run_id, address, params.to_json(), state.to_json(), i64::from(single_use), expires_at, iso(0)],
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
            params: parse(&params)?,
            state: parse(&state)?,
            calls: parse(&calls)?,
            single_use: single_use == 1,
            expires_at,
            status,
        }))
    }

    /// Record one call: one transaction reads the row, judges it live and
    /// unexpired by this file's clock, appends the call and queues its body.
    pub fn record_callback_call(&self, id: &str, values: &Js, body_due_at: &str) -> Result<CallbackClaim> {
        let Js::Obj(values) = values else { return Err(StoreError::Invalid("values: expected an object".into())) };
        self.transaction(|db| {
            let Some(mut callback) = self.callback(id)? else { return Ok(CallbackClaim::NotFound) };
            let now = iso(0);
            match refusal(&callback, CallFor::NewCall, &now) {
                Some(Refusal::Expired) => return Ok(CallbackClaim::Expired(callback)),
                Some(Refusal::Closed) => return Ok(CallbackClaim::Closed(callback)),
                None => {}
            }
            let mut calls = ledger(&callback)?;
            calls.push(LedgerCall { at: now.clone(), values: values.clone(), body_started_at: None });
            callback.calls = calls_js(&calls);
            callback.status = if callback.single_use { "fired" } else { "live" }.to_string();
            db.execute(
                "update callback set calls = ?, status = ?, fired_at = case when ? then ? else fired_at end where id = ?",
                params![callback.calls.to_json(), callback.status, i64::from(callback.single_use), now, id],
            )?;
            let call_index = calls.len() - 1;
            queue_body(self, id, &callback.team_id, call_index, body_due_at)?;
            Ok(CallbackClaim::Recorded { callback, call_index: call_index as i64 })
        })
    }

    /// Mark call `call_index`'s body started (the call lands); given `fence`,
    /// only while the callback's run is leased under it.
    pub fn mark_callback_body_started(&self, id: &str, call_index: i64, fence: Option<&str>) -> Result<bool> {
        self.transaction(|db| {
            let Some(callback) = self.callback(id)? else { return Ok(false) };
            let mut calls = ledger(&callback)?;
            let Some(call) = usize::try_from(call_index).ok().and_then(|i| calls.get_mut(i)) else { return Ok(false) };
            if let Some(fence) = fence
                && !Store::holds(db, &callback.run_id, fence)?
            {
                return Ok(false);
            }
            call.body_started_at = Some(iso(0));
            db.execute("update callback set calls = ? where id = ?", params![calls_js(&calls).to_json(), id])?;
            Ok(true)
        })
    }

    /// Those of `ids` with at least one landed call.
    pub fn landed_callbacks(&self, ids: &[String]) -> Result<Vec<String>> {
        let mut out = Vec::new();
        for id in ids {
            if let Some(callback) = self.callback(id)?
                && ledger(&callback)?.iter().any(|call| call.body_started_at.is_some())
            {
                out.push(id.clone());
            }
        }
        Ok(out)
    }

    /// An operator asks to cancel the run (`requestCancel`): the first
    /// request's reason stands, and a run already over takes none.
    pub fn request_cancel(&self, run_id: &str, reason: Option<&str>) -> Result<()> {
        self.db.execute(
            "update run set cancel_requested_at = ?, cancel_reason = ? where id = ? and cancel_requested_at is null and status in ('running', 'parked')",
            params![iso(0), reason, run_id],
        )?;
        Ok(())
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
    Recorded { callback: Box<CallbackRecord>, call_index: usize },
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
pub fn record_callback_call(store: &dyn RunHostStore, id: &str, values: &Obj, body_due_at: &str, wake_due_at: &str) -> Result<CallOutcome> {
    let Some(existing) = store.callback(id)? else { return Ok(CallOutcome::NotFound) };
    let coerced = match coerce_values(&declared_params(&existing)?, values) {
        Ok(coerced) => coerced,
        Err(message) => return Ok(CallOutcome::Mismatch(message)),
    };
    let (callback, call_index) = match store.record_callback_call(id, &Js::Obj(coerced), body_due_at)? {
        CallbackClaim::Recorded { callback, call_index } => (callback, call_index),
        CallbackClaim::NotFound => return Ok(CallOutcome::NotFound),
        CallbackClaim::Closed(_) => return Ok(CallOutcome::Closed),
        CallbackClaim::Expired(_) => return Ok(CallOutcome::Expired),
    };
    let call_index = usize::try_from(call_index).map_err(|_| invalid("calls"))?;
    let wake = Js::Obj(obj! { "adapterType" => Js::str(CALLBACK_AWAIT_TYPE), "teamId" => Js::str(&callback.team_id), "correlationKey" => Js::str(&callback.id) });
    store.enqueue("wake_await", &format!("wake_await:callback_backstop:{}", callback.id), &wake, Some(wake_due_at), Some(&callback.team_id))?;
    Ok(CallOutcome::Recorded { callback: Box::new(callback), call_index })
}

/// The run's callback-backed awaits that are resolvable now
/// (`callbackAwaitKeeper.loadResolvable`): a park on a callback one of whose
/// calls has landed.
pub fn resolvable_awaits(store: &dyn RunHostStore, run_id: &str) -> Result<Vec<String>> {
    let parks = store.of_run(run_id, CALLBACK_AWAIT_TYPE)?;
    if parks.is_empty() {
        return Ok(Vec::new());
    }
    let mut keys: Vec<String> = parks.iter().map(|(_, key)| key.clone()).collect();
    keys.dedup();
    let landed = store.landed_callbacks(&keys)?;
    Ok(parks.into_iter().filter(|(_, key)| landed.contains(key)).map(|(park, _)| park.address).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_is_the_prefix_and_32_base64url_characters() {
        let id = new_callback_id().unwrap();
        assert!(is_callback_id(&id));
        assert_eq!(id.len(), 3 + 32);
        assert!(id[3..].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_ne!(id, new_callback_id().unwrap());
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
