//! The limiter slot (plans/cloud-native-2026-10-06/22_everywhere_plan.md,
//! Henry 2026-10-18): what keeps lf's calls to modules and models inside
//! the provider's limits. The engine knows nothing of limits; lf asks the
//! slot before each call to a module (crate::credential_calls) and each
//! model request (crate::anthropic), and holds the call until it is granted.
//!
//! The contract (docs/contracts/limiter-slot.md) never waits: `acquire`
//! answers granted (with a permit to release) or refused (with when to ask
//! again), so a limiter shared by many hosts is just another module filling
//! the slot. Every request carries the limits it is under, so no limiter
//! reads a manifest. lf's built-in, `@lf/memory-limiter`, keeps them in
//! process (MemoryLimiter); a process module is crate::limiter_module.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tokio::sync::Notify;

use crate::json::Js;

/// What a declared limit is counted per (protocol.ts `LIMIT_SCOPES`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Credential,
    Module,
    Install,
    Team,
}

impl Scope {
    fn of(name: &str) -> Option<Scope> {
        match name {
            "credential" => Some(Scope::Credential),
            "module" => Some(Scope::Module),
            "install" => Some(Scope::Install),
            "team" => Some(Scope::Team),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Scope::Credential => "credential",
            Scope::Module => "module",
            Scope::Install => "install",
            Scope::Team => "team",
        }
    }
}

/// One limit a module's manifest declares (`WireDeclaredLimit`), or a
/// built-in core module carries.
#[derive(Debug, Clone, PartialEq)]
pub struct DeclaredLimit {
    pub scope: Scope,
    /// At most `calls` per `per_ms`.
    pub calls: Option<(u64, u64)>,
    pub concurrent: Option<u64>,
}

/// A manifest answer's `limits`, held to `WireDeclaredLimit`.
pub fn limits_of(manifest: &Js) -> Result<Vec<DeclaredLimit>, String> {
    let Some(limits) = manifest.get("limits") else { return Ok(Vec::new()) };
    let limits = limits.as_array().ok_or("limits: expected a list")?;
    limits
        .iter()
        .enumerate()
        .map(|(i, limit)| {
            let at = |m: &str| format!("limits.{i}: {m}");
            let scope = limit.get("scope").and_then(Js::as_str).and_then(Scope::of).ok_or_else(|| at("scope: expected credential, module, install or team"))?;
            let whole = |key: &str| match limit.get(key) {
                None => Ok(None),
                Some(Js::Num(n)) => n.as_u64().filter(|n| *n > 0).map(Some).ok_or_else(|| at(&format!("{key}: expected a whole number above 0"))),
                Some(_) => Err(at(&format!("{key}: expected a whole number above 0"))),
            };
            let per = match limit.get("per") {
                None => None,
                Some(per) => Some(per.as_str().and_then(duration_ms).ok_or_else(|| at("per: expected a duration (500ms, 10s, 1m, 1h, 1d)"))?),
            };
            let calls = match (whole("calls")?, per) {
                (Some(calls), Some(per)) => Some((calls, per)),
                (None, None) => None,
                _ => return Err(at("`calls` and `per` go together")),
            };
            let concurrent = whole("concurrent")?;
            if calls.is_none() && concurrent.is_none() {
                return Err(at("a limit declares `calls` and `per`, or `concurrent`, or both"));
            }
            Ok(DeclaredLimit { scope, calls, concurrent })
        })
        .collect()
}

/// `500ms`, `10s`, `1m`, `1h`, `1d` (`WireLimitDuration`).
pub fn duration_ms(text: &str) -> Option<u64> {
    let split = text.find(|c: char| !c.is_ascii_digit())?;
    let (digits, unit) = text.split_at(split);
    if digits.starts_with('0') {
        return None;
    }
    let n: u64 = digits.parse().ok()?;
    let unit_ms = match unit {
        "ms" => 1,
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        _ => return None,
    };
    n.checked_mul(unit_ms)
}

/// Who a call is made as: what each scope counts it by.
pub struct Caller<'a> {
    pub module: &'a str,
    /// The install's entry; None where the module has none of its own.
    pub install: Option<&'a str>,
    /// The credential the call is made as, if any.
    pub credential: Option<&'a str>,
    pub team: &'a str,
}

/// A call's own provider holds no longer than a segment runs (the wall
/// clock's default): a permit its holder never released lapses then.
pub const HOLD_MS: u64 = 900_000;

impl Caller<'_> {
    /// Where a provider's throttle lands: the credential the call is made
    /// as, else its install, else the module.
    pub fn throttle_key(&self) -> String {
        format!("{}|throttle|{}", self.module, self.credential.or(self.install).unwrap_or(""))
    }

    fn value(&self, scope: Scope) -> &str {
        match scope {
            Scope::Module => "",
            Scope::Team => self.team,
            // Counted by the narrower thing when the call has it, else the wider.
            Scope::Install => self.install.unwrap_or(""),
            Scope::Credential => self.credential.or(self.install).unwrap_or(""),
        }
    }

    /// The request for one call under `limits`, costing one.
    pub fn request(&self, limits: &[DeclaredLimit]) -> Acquire {
        let limits = limits
            .iter()
            .enumerate()
            .map(|(i, limit)| Bucket {
                // The index keeps two limits on one scope (per minute, per day) apart.
                key: format!("{}|{}|{}|{i}", self.module, limit.scope.name(), self.value(limit.scope)),
                calls: limit.calls,
                concurrent: limit.concurrent,
            })
            .collect();
        Acquire { key: self.throttle_key(), cost: 1, limits, hold_ms: HOLD_MS }
    }
}

/// One limit a request is under, resolved to the bucket it counts in.
#[derive(Debug, Clone, PartialEq)]
pub struct Bucket {
    pub key: String,
    /// (calls, per ms)
    pub calls: Option<(u64, u64)>,
    pub concurrent: Option<u64>,
}

/// `limiter.acquire`'s request: granted only when every bucket has room and
/// `key` is not throttled, and then counted in all of them at once, so a
/// refused call spends nothing anywhere.
#[derive(Debug, Clone, PartialEq)]
pub struct Acquire {
    pub key: String,
    pub cost: u64,
    pub limits: Vec<Bucket>,
    /// A permit never released lapses after this long.
    pub hold_ms: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Grant {
    Granted { permit: String },
    /// Ask again at this instant (epoch milliseconds).
    Refused { retry_at_ms: i64 },
}

/// The slot's contract. No method waits: a refusal says when to ask again.
pub trait Limiter: Send + Sync {
    fn acquire(&self, request: &Acquire) -> Result<Grant, String>;
    fn release(&self, permit: &str) -> Result<(), String>;
    /// The provider asked for no call on `key` before `until_ms`.
    fn throttle(&self, key: &str, until_ms: i64) -> Result<(), String>;
    /// Notified when a permit is released, for a limiter in this process: a
    /// waiter then asks again before its `retry_at`.
    fn released(&self) -> Option<&Notify> {
        None
    }
}

pub fn now_ms() -> i64 {
    jiff::Timestamp::now().as_millisecond()
}

/// A granted call: released when dropped.
pub struct Held {
    limiter: Arc<dyn Limiter>,
    permit: String,
}

impl Drop for Held {
    fn drop(&mut self) {
        if let Err(message) = self.limiter.release(&self.permit) {
            eprintln!("lf: the limiter did not release a permit: {message}");
        }
    }
}

/// Acquire `request` from `limiter`, waiting in process while it is refused.
pub async fn acquire(limiter: &Arc<dyn Limiter>, request: &Acquire) -> Result<Held, String> {
    loop {
        // Listening before asking, so a release between the refusal and the
        // wait still wakes it.
        let mut released = limiter.released().map(|n| Box::pin(n.notified()));
        if let Some(released) = released.as_mut() {
            released.as_mut().enable();
        }
        let retry_at_ms = match limiter.acquire(request)? {
            Grant::Granted { permit } => return Ok(Held { limiter: limiter.clone(), permit }),
            Grant::Refused { retry_at_ms } => retry_at_ms,
        };
        // THE PAUSE SEAM (CONCERNS.md, r-limits): a host that parks a segment
        // on a limit (park reason `limit`, woken at `retry_at_ms`) would hand
        // the run back here instead of holding it in process. Today lf waits.
        let wait = Duration::from_millis(u64::try_from(retry_at_ms - now_ms()).unwrap_or(0));
        match released {
            Some(released) => {
                let _ = tokio::time::timeout(wait, released).await;
            }
            None => tokio::time::sleep(wait).await,
        }
    }
}

// ── The slot lf's calls ask ─────────────────────────────────────────────────

static SLOT: RwLock<Option<Arc<dyn Limiter>>> = RwLock::new(None);

/// The limiter the project's slot names, set as its session opens; the
/// built-in until then. One process serves one project, as the model
/// requests' slots did before the limiter slot.
pub fn slot() -> Arc<dyn Limiter> {
    if let Some(limiter) = SLOT.read().unwrap_or_else(|p| p.into_inner()).as_ref() {
        return limiter.clone();
    }
    let mut slot = SLOT.write().unwrap_or_else(|p| p.into_inner());
    slot.get_or_insert_with(|| Arc::new(MemoryLimiter::default())).clone()
}

pub fn install(limiter: Arc<dyn Limiter>) {
    *SLOT.write().unwrap_or_else(|p| p.into_inner()) = Some(limiter);
}

/// The limiter the project's slot names, opened with its settings.
pub fn of_project(project: &crate::project::Project, env: &[(String, String)]) -> Result<Arc<dyn Limiter>, String> {
    let module = &project.core.limiter;
    match &module.process {
        Some(process) => {
            let settings = crate::core::settings_of(&crate::secrets::load_secrets(project, env)?, module);
            Ok(Arc::new(crate::limiter_module::ProcessLimiter::start(&module.name, process, &settings)?))
        }
        None => Ok(Arc::new(MemoryLimiter::default())),
    }
}

// ── @lf/memory-limiter ──────────────────────────────────────────────────────

/// How soon a call refused for concurrency asks again, if no release wakes
/// it first (a permit lapsing frees a slot with no release).
const CONCURRENCY_RECHECK_MS: i64 = 1_000;

/// The limits kept in this process: a token bucket per `calls`/`per`
/// limit (full at first, refilled evenly), a count of held permits per
/// `concurrent` one, and the throttles providers reported.
#[derive(Default)]
pub struct MemoryLimiter {
    state: Mutex<State>,
    released: Notify,
}

#[derive(Default)]
struct State {
    buckets: HashMap<String, BucketState>,
    permits: HashMap<String, PermitState>,
    throttles: HashMap<String, i64>,
    next_permit: u64,
}

struct BucketState {
    tokens: f64,
    filled_at_ms: i64,
    held: u64,
}

struct PermitState {
    /// The concurrency buckets it holds a place in.
    holds: Vec<String>,
    lapses_at_ms: i64,
}

impl State {
    fn lapse_permits(&mut self, now: i64) {
        let lapsed: Vec<String> = self.permits.iter().filter(|(_, p)| p.lapses_at_ms <= now).map(|(id, _)| id.clone()).collect();
        for id in lapsed {
            self.free(&id);
        }
    }

    fn free(&mut self, permit: &str) -> bool {
        let Some(permit) = self.permits.remove(permit) else { return false };
        for key in permit.holds {
            if let Some(bucket) = self.buckets.get_mut(&key) {
                bucket.held = bucket.held.saturating_sub(1);
            }
        }
        true
    }
}

impl Limiter for MemoryLimiter {
    fn acquire(&self, request: &Acquire) -> Result<Grant, String> {
        let now = now_ms();
        let mut guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let state = &mut *guard;
        state.lapse_permits(now);
        if let Some(until) = state.throttles.get(&request.key).copied() {
            if until > now {
                return Ok(Grant::Refused { retry_at_ms: until });
            }
            state.throttles.remove(&request.key);
        }
        let mut retry_at_ms: Option<i64> = None;
        let mut later = |at: i64| retry_at_ms = Some(retry_at_ms.map_or(at, |r| r.max(at)));
        for limit in &request.limits {
            let bucket = state.buckets.entry(limit.key.clone()).or_insert_with(|| BucketState {
                tokens: limit.calls.map_or(0.0, |(calls, _)| calls as f64),
                filled_at_ms: now,
                held: 0,
            });
            if let Some((calls, per_ms)) = limit.calls {
                let rate = calls as f64 / per_ms as f64;
                bucket.tokens = (bucket.tokens + (now - bucket.filled_at_ms) as f64 * rate).min(calls as f64);
                bucket.filled_at_ms = now;
                // A call costing more than the whole window waits for a full one.
                let cost = (request.cost as f64).min(calls as f64);
                if bucket.tokens < cost {
                    later(now + ((cost - bucket.tokens) / rate).ceil() as i64);
                }
            }
            if limit.concurrent.is_some_and(|most| bucket.held >= most) {
                let soonest_lapse = state.permits.values().map(|p| p.lapses_at_ms).min().unwrap_or(i64::MAX);
                later(soonest_lapse.min(now + CONCURRENCY_RECHECK_MS));
            }
        }
        if let Some(retry_at_ms) = retry_at_ms {
            return Ok(Grant::Refused { retry_at_ms });
        }
        let mut holds = Vec::new();
        for limit in &request.limits {
            let bucket = state.buckets.get_mut(&limit.key).expect("each bucket was made above");
            if let Some((calls, _)) = limit.calls {
                bucket.tokens -= (request.cost as f64).min(calls as f64);
            }
            if limit.concurrent.is_some() {
                bucket.held += 1;
                holds.push(limit.key.clone());
            }
        }
        state.next_permit += 1;
        let permit = format!("p{}", state.next_permit);
        if !holds.is_empty() {
            let lapses_at_ms = now.saturating_add(i64::try_from(request.hold_ms).unwrap_or(i64::MAX));
            state.permits.insert(permit.clone(), PermitState { holds, lapses_at_ms });
        }
        Ok(Grant::Granted { permit })
    }

    fn release(&self, permit: &str) -> Result<(), String> {
        let freed = self.state.lock().unwrap_or_else(|p| p.into_inner()).free(permit);
        if freed {
            self.released.notify_waiters();
        }
        Ok(())
    }

    fn throttle(&self, key: &str, until_ms: i64) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let until = state.throttles.entry(key.to_string()).or_insert(until_ms);
        *until = (*until).max(until_ms);
        Ok(())
    }

    fn released(&self) -> Option<&Notify> {
        Some(&self.released)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caller() -> Caller<'static> {
        Caller { module: "@acme/crm", install: Some("crm"), credential: Some("alice_crm"), team: "local" }
    }

    fn concurrent(n: u64) -> DeclaredLimit {
        DeclaredLimit { scope: Scope::Module, calls: None, concurrent: Some(n) }
    }

    #[test]
    fn a_manifests_limits_are_read_and_held_to_their_shape() {
        let manifest = Js::parse(br#"{"limits":[{"scope":"credential","calls":100,"per":"10s"},{"scope":"module","concurrent":4}]}"#).unwrap();
        assert_eq!(
            limits_of(&manifest).unwrap(),
            [
                DeclaredLimit { scope: Scope::Credential, calls: Some((100, 10_000)), concurrent: None },
                DeclaredLimit { scope: Scope::Module, calls: None, concurrent: Some(4) },
            ]
        );
        for bad in [r#"[{"scope":"user","concurrent":1}]"#, r#"[{"scope":"team","calls":5}]"#, r#"[{"scope":"team"}]"#, r#"[{"scope":"team","calls":1,"per":"1w"}]"#] {
            let manifest = Js::parse(format!(r#"{{"limits":{bad}}}"#).as_bytes()).unwrap();
            assert!(limits_of(&manifest).is_err(), "{bad}");
        }
        assert_eq!(limits_of(&Js::parse(b"{}").unwrap()).unwrap(), []);
        assert_eq!((duration_ms("500ms"), duration_ms("1d"), duration_ms("05s"), duration_ms("s")), (Some(500), Some(86_400_000), None, None));
    }

    #[test]
    fn each_scope_counts_by_its_own_value() {
        let limits = [DeclaredLimit { scope: Scope::Credential, calls: Some((1, 60_000)), concurrent: None }];
        let alice = caller().request(&limits);
        let bob = Caller { credential: Some("bob_crm"), ..caller() }.request(&limits);
        assert_ne!(alice.limits[0].key, bob.limits[0].key);
        let module = [concurrent(1)];
        assert_eq!(caller().request(&module).limits[0].key, Caller { credential: Some("bob_crm"), ..caller() }.request(&module).limits[0].key);
    }

    #[test]
    fn a_concurrency_limit_holds_until_a_release() {
        let limiter = MemoryLimiter::default();
        let request = caller().request(&[concurrent(2)]);
        let Grant::Granted { permit } = limiter.acquire(&request).unwrap() else { panic!("first") };
        assert!(matches!(limiter.acquire(&request).unwrap(), Grant::Granted { .. }));
        let Grant::Refused { retry_at_ms } = limiter.acquire(&request).unwrap() else { panic!("third is refused") };
        assert!(retry_at_ms > now_ms());
        limiter.release(&permit).unwrap();
        assert!(matches!(limiter.acquire(&request).unwrap(), Grant::Granted { .. }));
    }

    #[tokio::test]
    async fn a_waiter_is_granted_as_soon_as_a_permit_is_released() {
        let limiter: Arc<dyn Limiter> = Arc::new(MemoryLimiter::default());
        let request = caller().request(&[concurrent(1)]);
        let first = acquire(&limiter, &request).await.unwrap();
        let started = std::time::Instant::now();
        let (_, second) = tokio::join!(
            async {
                tokio::time::sleep(Duration::from_millis(30)).await;
                drop(first);
            },
            acquire(&limiter, &request)
        );
        second.unwrap();
        assert!(started.elapsed() < Duration::from_millis(500), "woken by the release, not the recheck");
    }
}
