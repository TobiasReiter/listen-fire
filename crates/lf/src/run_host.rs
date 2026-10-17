//! The run host's rules over the backend families, ported from movement-
//! engine `services/run_host/{rules,drain,lease}.ts`: what a park writes and
//! in which order, when a run counts as complete, how a run that failed or
//! was cancelled is torn down, how a race's losing subtrees are withdrawn,
//! how a parked run's leaves are stepped (claimed, stepped, finished, with
//! deferred races settled once at the end), and the per-run lease every
//! entry into a run holds.
//!
//! Callback-backed awaits are kept by crate::callbacks, not here.

use std::cell::Cell;
use std::future::Future;

use sha2::{Digest, Sha256};

use crate::json::Js;
use crate::obj;
use crate::backend::RunHostStore;
use crate::store::StoreError;

/// A minute of silence is a dead process, not a slow one (`RUN_LEASE_TTL_MS`).
pub const RUN_LEASE_TTL_MS: i64 = 60_000;

/// `CANCELLED_BY_OPERATOR`.
pub const CANCELLED_BY_OPERATOR: &str = "Cancelled by an operator";

pub type Result<T> = std::result::Result<T, String>;

fn store<T>(result: std::result::Result<T, StoreError>) -> Result<T> {
    result.map_err(|e| e.to_string())
}

// ── The run lease ───────────────────────────────────────────────────────────

/// A lease this process holds (`HeldRunLease`).
pub struct Lease {
    pub run_id: String,
    pub token: String,
    deadline: Cell<i64>,
    lost: Cell<bool>,
}

fn now_ms() -> i64 {
    jiff::Timestamp::now().as_millisecond()
}

impl Lease {
    /// True once this holder can no longer be sure the run is its own.
    pub fn is_lost(&self) -> bool {
        if !self.lost.get() && now_ms() > self.deadline.get() {
            self.lost.set(true);
        }
        self.lost.get()
    }

    async fn renew_forever(&self, store: &dyn RunHostStore) {
        let ttl = RUN_LEASE_TTL_MS;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis((ttl / 3) as u64)).await;
            if self.lost.get() {
                continue;
            }
            let attempted = now_ms();
            if attempted > self.deadline.get() {
                self.lost.set(true);
                continue;
            }
            match store.renew_lease(&self.run_id, &self.token, ttl) {
                Ok(true) => self.deadline.set(attempted + ttl),
                Ok(false) => self.lost.set(true),
                // One failed renewal is not a lost lease: the deadline is.
                Err(_) => {}
            }
        }
    }
}

/// `withRunLease`: `body` under the run's lease, renewed while it runs and
/// released however it ends; None when the lease is held elsewhere.
pub async fn with_run_lease<T>(store: &dyn RunHostStore, run_id: &str, body: impl AsyncFnOnce(&Lease) -> T) -> Result<Option<T>> {
    let deadline = now_ms() + RUN_LEASE_TTL_MS;
    let Some(token) = store.claim_lease(run_id, RUN_LEASE_TTL_MS).map_err(|e| e.to_string())? else { return Ok(None) };
    let lease = Lease { run_id: run_id.to_string(), token, deadline: Cell::new(deadline), lost: Cell::new(false) };
    let value = tokio::select! {
        biased;
        value = body(&lease) => value,
        () = lease.renew_forever(store) => unreachable!("the renewal never ends"),
    };
    // A release that fails lets the lease lapse instead.
    let _ = store.release_lease(run_id, &lease.token);
    Ok(Some(value))
}

// ── Library texts a park pins ───────────────────────────────────────────────

/// `parkSources.save`: a text named by the sha-256 of its UTF-8 bytes.
pub fn save_source(store_: &dyn RunHostStore, team_id: &str, source: &str) -> Result<String> {
    let digest = Sha256::digest(source.as_bytes());
    let hash = format!("sha256:{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>());
    store(store_.put_source(team_id, &hash, source))?;
    Ok(hash)
}

// ── Work the run host queues ────────────────────────────────────────────────

pub fn timer_work_key(run_id: &str) -> String {
    format!("resume_timer:{run_id}")
}

pub fn arm_timer_wake(store_: &dyn RunHostStore, run_id: &str, wake_at: &str) -> Result<()> {
    store(store_.enqueue("resume_timer", &timer_work_key(run_id), &Js::Obj(obj! { "runId" => Js::str(run_id) }), Some(wake_at), None))
}

/// The wake for one adapter identity, never coalesced.
pub fn queue_await_wake(store_: &dyn RunHostStore, adapter_type: &str, team_id: &str, correlation_key: &str) -> Result<()> {
    let payload = Js::Obj(obj! { "adapterType" => Js::str(adapter_type), "teamId" => Js::str(team_id), "correlationKey" => Js::str(correlation_key) });
    store(store_.enqueue("wake_await", &format!("wake_await:{}", uuid::Uuid::new_v4()), &payload, None, Some(team_id)))
}

// ── Completion ──────────────────────────────────────────────────────────────

/// `runCompleteWithout`: no join waits and no OTHER leaf is parked.
pub fn run_complete_without(store_: &dyn RunHostStore, run_id: &str, leaf_address: &str) -> Result<bool> {
    if store(store_.has_pending_joins(run_id))? {
        return Ok(false);
    }
    Ok(store(store_.leaves(run_id, true, None, None))?.iter().all(|l| l.address == leaf_address))
}

pub fn run_quiescent(store_: &dyn RunHostStore, run_id: &str) -> Result<bool> {
    if store(store_.has_pending_joins(run_id))? {
        return Ok(false);
    }
    Ok(store(store_.leaves(run_id, true, None, None))?.is_empty())
}

pub fn clear_if_quiescent(store_: &dyn RunHostStore, run_id: &str, fence: Option<&str>) -> Result<bool> {
    if !run_quiescent(store_, run_id)? {
        return Ok(false);
    }
    store(store_.drop_run_state(run_id, fence))?;
    Ok(true)
}

// ── A run that ends without completing ──────────────────────────────────────

pub fn abandon_run(store_: &dyn RunHostStore, run_id: &str, fence: Option<&str>) -> Result<bool> {
    if !store(store_.drop_run_state(run_id, fence))? {
        return Ok(false);
    }
    store(store_.drop_run_correlations(run_id))?;
    store(store_.revoke_run_callbacks(run_id))?;
    Ok(true)
}

pub fn fail_run(store_: &dyn RunHostStore, run_id: &str, message: &str, fence: Option<&str>) -> Result<bool> {
    store(store_.mark_failed(run_id, message))?;
    abandon_run(store_, run_id, fence)
}

pub fn settle_if_cancel_requested(store_: &dyn RunHostStore, run_id: &str, fence: Option<&str>) -> Result<bool> {
    let Some(reason) = store(store_.cancel_request(run_id))? else { return Ok(false) };
    fail_run(store_, run_id, reason.as_deref().unwrap_or(CANCELLED_BY_OPERATOR), fence)?;
    Ok(true)
}

// ── A race's losers ─────────────────────────────────────────────────────────

/// Whether `prefix` is `address` or one of its ancestors, step by step
/// (`s1.b1` is not an ancestor of `s1.b10`).
fn is_ancestor_or_self(prefix: &str, address: &str) -> bool {
    let prefix: Vec<&str> = if prefix.is_empty() { Vec::new() } else { prefix.split('.').collect() };
    let address: Vec<&str> = if address.is_empty() { Vec::new() } else { address.split('.').collect() };
    prefix.len() <= address.len() && prefix.iter().zip(&address).all(|(a, b)| a == b)
}

/// `cancelSubtrees`.
pub fn cancel_subtrees(store_: &dyn RunHostStore, run_id: &str, subtrees: &[String], exclude_leaf: Option<&str>) -> Result<()> {
    if subtrees.is_empty() {
        return Ok(());
    }
    for address in subtrees {
        if movement_engine::address::Address::parse(address).is_none() {
            return Err(format!("not a lexical address: {address}"));
        }
    }
    let in_subtree = |address: &str| Some(address) != exclude_leaf && subtrees.iter().any(|p| is_ancestor_or_self(p, address));
    let doomed: Vec<String> =
        store(store_.leaves(run_id, true, None, None))?.into_iter().map(|l| l.address).filter(|a| in_subtree(a)).collect();
    if !doomed.is_empty() {
        for address in &doomed {
            store(store_.drop_correlation(run_id, address))?;
        }
        store(store_.delete_leaves(run_id, &doomed))?;
    }
    let dead: Vec<String> = store(store_.frames(run_id))?.into_iter().filter(|f| in_subtree(f)).collect();
    if !dead.is_empty() {
        store(store_.delete_frames(run_id, &dead))?;
    }
    Ok(())
}

// ── Stepping a parked run ───────────────────────────────────────────────────

/// One segment the drain asks the host to run.
pub enum StepRequest {
    /// Resume a claimed leaf: re-enter at it, or (a slept timer) step past it.
    Leaf { address: String, state: Js, reenter: bool },
    /// Settle a race whose branches completed in this batch.
    Race { frame_address: String, state: Js },
}

impl StepRequest {
    /// The leaf whose own row goes after its step: what "complete" excludes.
    pub fn completing_address(&self) -> &str {
        match self {
            StepRequest::Leaf { address, .. } => address,
            StepRequest::Race { frame_address, .. } => frame_address,
        }
    }
}

/// What one segment came to (`StepOutcome`).
#[derive(Debug, Clone, PartialEq)]
pub enum StepOutcome {
    LeaseLost,
    Failed(String),
    Cancelled(Option<String>),
    Parked { address: Option<String>, deferred_race_frames: Vec<String> },
    Completed { deferred_race_frames: Vec<String> },
}

/// What runs one segment for a drain.
pub trait Stepper {
    fn step(&self, request: StepRequest) -> impl Future<Output = StepOutcome>;
}

pub enum Settled {
    Continue,
    Done,
    LeaseLost,
}

/// `afterStep`: a failure or a cancel tears the run down and ends the
/// drain; a lost lease ends it leaving every row.
pub fn after_step(store_: &dyn RunHostStore, run_id: &str, fence: Option<&str>, outcome: &StepOutcome) -> Result<Settled> {
    Ok(match outcome {
        StepOutcome::LeaseLost => Settled::LeaseLost,
        StepOutcome::Failed(_) => {
            abandon_run(store_, run_id, fence)?;
            Settled::Done
        }
        StepOutcome::Cancelled(reason) => {
            fail_run(store_, run_id, reason.as_deref().unwrap_or(CANCELLED_BY_OPERATOR), fence)?;
            Settled::Done
        }
        StepOutcome::Parked { .. } | StepOutcome::Completed { .. } => Settled::Continue,
    })
}

/// `drainRun`: step the chosen leaves of one run under the caller's lease.
/// True when the lease went mid-drain (every row is left as it is).
pub async fn drain_run(store_: &dyn RunHostStore, run_id: &str, addresses: &[String], reason: Option<&str>, lease: &Lease, stepper: &impl Stepper) -> Result<bool> {
    let fence = Some(lease.token.as_str());
    if settle_if_cancel_requested(store_, run_id, fence)? {
        return Ok(false);
    }
    let mut deferred: Vec<(String, Js)> = Vec::new();
    for address in addresses {
        if lease.is_lost() {
            return Ok(true);
        }
        let Some((claimed_reason, state)) = store(store_.claim_leaf(run_id, address, reason))? else {
            if lease.is_lost() {
                return Ok(true);
            }
            store(store_.drop_correlation(run_id, address))?;
            continue;
        };
        let until = Js::is_true(state.get("until"));
        let reenter = claimed_reason != "timer" || until;
        let outcome = stepper.step(StepRequest::Leaf { address: address.clone(), state: state.clone(), reenter }).await;
        match after_step(store_, run_id, fence, &outcome)? {
            Settled::Continue => {}
            Settled::Done => return Ok(false),
            Settled::LeaseLost => return Ok(true),
        }
        let (parked_at, frames) = match &outcome {
            StepOutcome::Parked { address, deferred_race_frames } => (address.as_deref(), deferred_race_frames),
            StepOutcome::Completed { deferred_race_frames } => (None, deferred_race_frames),
            _ => continue,
        };
        for frame in frames {
            if !deferred.iter().any(|(f, _)| f == frame) {
                deferred.push((frame.clone(), state.clone()));
            }
        }
        if parked_at != Some(address.as_str()) {
            store(store_.drop_correlation(run_id, address))?;
            store(store_.finish_leaf(run_id, address, fence))?;
        }
    }
    for (frame_address, state) in deferred {
        let outcome = stepper.step(StepRequest::Race { frame_address, state }).await;
        match after_step(store_, run_id, fence, &outcome)? {
            Settled::Continue => {}
            Settled::Done => return Ok(false),
            Settled::LeaseLost => return Ok(true),
        }
    }
    clear_if_quiescent(store_, run_id, fence)?;
    Ok(false)
}

/// `drainDueTimers`.
pub async fn drain_due_timers(store_: &dyn RunHostStore, run_id: &str, due_by: &str, lease: &Lease, stepper: &impl Stepper) -> Result<bool> {
    let due: Vec<String> = store(store_.leaves(run_id, true, Some("timer"), Some(due_by)))?.into_iter().map(|l| l.address).collect();
    drain_run(store_, run_id, &due, Some("timer"), lease, stepper).await
}

/// `nextTimerWake`: the earliest wake of the run's still-parked timers.
pub fn next_timer_wake(store_: &dyn RunHostStore, run_id: &str) -> Result<Option<String>> {
    let mut wakes: Vec<String> = store(store_.leaves(run_id, true, Some("timer"), None))?.into_iter().filter_map(|l| l.wake_at).collect();
    wakes.sort();
    Ok(wakes.into_iter().next())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ancestor_is_a_prefix_by_whole_steps() {
        assert!(is_ancestor_or_self("s1.b1", "s1.b1.s0"));
        assert!(is_ancestor_or_self("s1.b1", "s1.b1"));
        assert!(!is_ancestor_or_self("s1.b1", "s1.b10"));
        assert!(!is_ancestor_or_self("s1.b1.s0", "s1.b1"));
    }

    #[test]
    fn a_library_text_is_named_by_its_sha256() {
        let dir = std::env::temp_dir().join(format!("lf-rules-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store_ = crate::store::Store::open(&dir.join("state.db")).unwrap();
        // sha256("abc")
        assert_eq!(save_source(&store_, "local", "abc").unwrap(), "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(store_.get_source("local", "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad").unwrap().as_deref(), Some("abc"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
