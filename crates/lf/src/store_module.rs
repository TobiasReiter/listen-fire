//! A store module run as a process: the store slot filled by a third-party
//! module (crate::core), spoken to over the store wire
//! (docs/contracts/store-slot.md) — one JSON-RPC 2.0 message per line on its
//! stdin and stdout, the methods `lf --contract-store` serves
//! (crate::contract_store), opened by `store.open` with the module's
//! settings. Every call blocks until the module answers, as the other
//! stores' calls do, so the rules over the store (crate::run_host) read
//! alike over all three.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

use crate::backend::{CallbackClaim, CallbackRecord, MintCallback, RunHostStore};
use crate::core::ProcessModule;
use crate::json::{Js, Obj};
use crate::obj;
use crate::store::{BranchExport, ClaimedWork, CorrelatedAwait, LeafRow, Result, RunRow, StoreError};
use crate::store_wire::{Wire, int, num, opt, rows};

/// The error a fenced write answers when the run's lease is gone (`RunLeaseLost`).
pub const LEASE_LOST: i64 = -32001;

pub struct ProcessStore {
    name: String,
    tenant: String,
    wire: Mutex<Pipe>,
    child: Child,
}

struct Pipe {
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
}

impl ProcessStore {
    /// Start the module in its folder and open it with its settings.
    pub fn start(name: &str, process: &ProcessModule, settings: &BTreeMap<String, String>) -> Result<ProcessStore> {
        let (program, args) = process.command.split_first().ok_or_else(|| StoreError::Backend(format!("the store module {name} has no command")))?;
        let mut child = Command::new(program)
            .args(args)
            .current_dir(&process.dir)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .envs(&process.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| StoreError::Backend(format!("the store module {name}: {program} could not be started ({e})")))?;
        let wire = Pipe { stdin: child.stdin.take(), stdout: BufReader::new(child.stdout.take().expect("stdout is piped")), next_id: 0 };
        let mut store = ProcessStore { name: name.to_string(), tenant: String::new(), wire: Mutex::new(wire), child };
        let settings: Obj = settings.iter().map(|(k, v)| (k.clone(), Js::str(v))).collect();
        let opened = store.call("store.open", obj! { "settings" => Js::from(settings) })?;
        store.tenant = opened.get("tenant").and_then(Js::as_str).map(str::to_string).ok_or_else(|| store.malformed("store.open", &opened))?;
        Ok(store)
    }

    fn call(&self, method: &str, params: Obj) -> Result<Js> {
        let mut wire = self.wire.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        wire.next_id += 1;
        let id = wire.next_id;
        let request = Js::from(obj! { "jsonrpc" => Js::str("2.0"), "id" => Js::Num(id.into()), "method" => Js::str(method), "params" => Js::from(params) });
        let gone = |e: std::io::Error| StoreError::Backend(format!("the store module {}: {method}: {e}", self.name));
        let stdin = wire.stdin.as_mut().ok_or_else(|| StoreError::Backend(format!("the store module {} is closed", self.name)))?;
        stdin.write_all(format!("{}\n", request.to_json()).as_bytes()).map_err(gone)?;
        stdin.flush().map_err(gone)?;
        let mut line = String::new();
        if wire.stdout.read_line(&mut line).map_err(gone)? == 0 {
            return Err(StoreError::Backend(format!("the store module {} exited before it answered {method}", self.name)));
        }
        let reply = Js::parse(line.as_bytes()).map_err(|e| StoreError::Backend(format!("the store module {}: {method}: its answer is not JSON: {e}", self.name)))?;
        if reply.get("id").and_then(int) != Some(id) {
            return Err(StoreError::Backend(format!("the store module {}: {method}: answered request {}, not {id}", self.name, reply.get("id").map(Js::to_json).unwrap_or_default())));
        }
        if let Some(error) = reply.get("error") {
            let message = error.get("message").and_then(Js::as_str).unwrap_or("no message");
            if error.get("code").and_then(int) == Some(LEASE_LOST) {
                let run_id = error.get("data").and_then(|d| d.get("runId")).and_then(Js::as_str).unwrap_or_default();
                return Err(StoreError::LeaseLost { run_id: run_id.to_string() });
            }
            return Err(StoreError::Backend(format!("the store module {}: {method}: {message}", self.name)));
        }
        Ok(reply.get("result").cloned().unwrap_or(Js::Null))
    }

    fn malformed(&self, method: &str, answer: &Js) -> StoreError {
        StoreError::Backend(format!("the store module {}: {method} answered {}, not its result's shape", self.name, answer.to_json()))
    }

    fn unit(&self, method: &str, params: Obj) -> Result<()> {
        self.call(method, params).map(|_| ())
    }

    fn flag(&self, method: &str, params: Obj) -> Result<bool> {
        match self.call(method, params)? {
            Js::Bool(b) => Ok(b),
            other => Err(self.malformed(method, &other)),
        }
    }

    fn row<T: Wire>(&self, method: &str, params: Obj) -> Result<Option<T>> {
        match self.call(method, params)? {
            Js::Null => Ok(None),
            answer => T::from_wire(&answer).map(Some).ok_or_else(|| self.malformed(method, &answer)),
        }
    }

    fn rows<T: Wire>(&self, method: &str, params: Obj) -> Result<Vec<T>> {
        let answer = self.call(method, params)?;
        rows(&answer).ok_or_else(|| self.malformed(method, &answer))
    }

    fn strings(&self, method: &str, params: Obj) -> Result<Vec<String>> {
        let answer = self.call(method, params)?;
        answer.as_array().and_then(|items| items.iter().map(|i| i.as_str().map(str::to_string)).collect()).ok_or_else(|| self.malformed(method, &answer))
    }
}

impl Drop for ProcessStore {
    /// Its stdin closed, the module ends at end of input; one that does not
    /// within a second is killed.
    fn drop(&mut self) {
        if let Ok(mut wire) = self.wire.lock() {
            wire.stdin.take();
        }
        for _ in 0..100 {
            if !matches!(self.child.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn s(value: &str) -> Js {
    Js::str(value)
}

fn strings(items: &[String]) -> Js {
    Js::strings(items)
}

impl RunHostStore for ProcessStore {
    fn tenant(&self) -> &str {
        &self.tenant
    }

    fn start_run(&self, id: &str, file: &str, movement: &str, started_at: &str, input: &str) -> Result<()> {
        self.unit("runs.start", obj! { "id" => s(id), "file" => s(file), "movement" => s(movement), "startedAt" => s(started_at), "input" => s(input) })
    }
    fn settle_run(&self, id: &str, status: &str, outcome: &Js, at: &str) -> Result<()> {
        self.unit("runs.settle", obj! { "runId" => s(id), "status" => s(status), "outcome" => outcome.clone(), "at" => s(at) })
    }
    fn mark_parked(&self, id: &str) -> Result<()> {
        self.unit("runs.markParked", obj! { "runId" => s(id) })
    }
    fn mark_failed(&self, id: &str, message: &str) -> Result<()> {
        self.unit("records.markFailed", obj! { "runId" => s(id), "message" => s(message) })
    }
    fn cancel_request(&self, id: &str) -> Result<Option<Option<String>>> {
        match self.call("records.cancelRequest", obj! { "runId" => s(id) })? {
            Js::Null => Ok(None),
            answer => match answer.get("reason") {
                None | Some(Js::Null) => Ok(Some(None)),
                Some(Js::Str(reason)) => Ok(Some(Some(reason.clone()))),
                Some(_) => Err(self.malformed("records.cancelRequest", &answer)),
            },
        }
    }
    fn request_cancel(&self, id: &str, reason: Option<&str>) -> Result<()> {
        self.unit("runs.requestCancel", obj! { "runId" => s(id), "reason" => opt(reason) })
    }
    fn run(&self, id: &str) -> Result<Option<RunRow>> {
        self.row("runs.get", obj! { "runId" => s(id) })
    }
    fn runs(&self, limit: i64) -> Result<Vec<RunRow>> {
        self.rows("runs.list", obj! { "limit" => Js::Num(limit.into()) })
    }
    fn append_trace(&self, run_id: &str, segment_id: &str, entries: &[Js]) -> Result<()> {
        self.unit("runs.appendTrace", obj! { "runId" => s(run_id), "segmentId" => s(segment_id), "entries" => Js::Arr(entries.to_vec()) })
    }
    fn run_spent(&self, run_id: &str) -> Result<f64> {
        match self.call("runs.spent", obj! { "runId" => s(run_id) })? {
            Js::Num(n) => n.as_f64().ok_or_else(|| self.malformed("runs.spent", &Js::Num(n))),
            other => Err(self.malformed("runs.spent", &other)),
        }
    }
    fn add_run_spend(&self, run_id: &str, microdollars: f64) -> Result<()> {
        self.unit("runs.addSpend", obj! { "runId" => s(run_id), "microdollars" => num(microdollars) })
    }
    fn reset_spend_baseline(&self, run_id: &str) -> Result<()> {
        self.unit("runs.resetSpendBaseline", obj! { "runId" => s(run_id) })
    }
    fn trace_len(&self, run_id: &str) -> Result<i64> {
        let answer = self.call("runs.traceLength", obj! { "runId" => s(run_id) })?;
        int(&answer).ok_or_else(|| self.malformed("runs.traceLength", &answer))
    }

    fn put_leaf(&self, run_id: &str, address: &str, reason: &str, wake_at: Option<&str>, state: &Js, fence: Option<&str>) -> Result<()> {
        self.unit(
            "parks.putLeaf",
            obj! { "runId" => s(run_id), "address" => s(address), "reason" => s(reason), "wakeAt" => opt(wake_at), "state" => state.clone(), "fence" => opt(fence) },
        )
    }
    fn claim_leaf(&self, run_id: &str, address: &str, reason: Option<&str>) -> Result<Option<(String, Js)>> {
        match self.call("parks.claimLeaf", obj! { "runId" => s(run_id), "address" => s(address), "reason" => opt(reason) })? {
            Js::Null => Ok(None),
            answer => match (answer.get("reason").and_then(Js::as_str), answer.get("state")) {
                (Some(reason), Some(state)) => Ok(Some((reason.to_string(), state.clone()))),
                _ => Err(self.malformed("parks.claimLeaf", &answer)),
            },
        }
    }
    fn finish_leaf(&self, run_id: &str, address: &str, fence: Option<&str>) -> Result<()> {
        self.unit("parks.finishLeaf", obj! { "runId" => s(run_id), "address" => s(address), "fence" => opt(fence) })
    }
    fn leaves(&self, run_id: &str, parked_only: bool, reason: Option<&str>, due_by: Option<&str>) -> Result<Vec<LeafRow>> {
        self.rows("parks.leaves", obj! { "runId" => s(run_id), "parkedOnly" => Js::Bool(parked_only), "reason" => opt(reason), "dueBy" => opt(due_by) })
    }
    fn delete_leaves(&self, run_id: &str, addresses: &[String]) -> Result<()> {
        self.unit("parks.deleteLeaves", obj! { "runId" => s(run_id), "addresses" => strings(addresses) })
    }

    fn record_join(&self, run_id: &str, frame_address: &str, pending: i64, fence: Option<&str>) -> Result<()> {
        self.unit("joins.recordJoin", obj! { "runId" => s(run_id), "frameAddress" => s(frame_address), "pending" => Js::Num(pending.into()), "fence" => opt(fence) })
    }
    fn decrement_join(&self, run_id: &str, frame_address: &str, branch_address: &str, leaf_address: &str) -> Result<bool> {
        let params = obj! { "runId" => s(run_id), "frameAddress" => s(frame_address), "branchAddress" => s(branch_address), "leafAddress" => s(leaf_address) };
        let answer = self.call("joins.decrementJoin", params)?;
        match answer.get("closed") {
            Some(Js::Bool(closed)) => Ok(*closed),
            _ => Err(self.malformed("joins.decrementJoin", &answer)),
        }
    }
    fn persist_branch_export(&self, run_id: &str, frame_address: &str, branch_address: &str, branch_index: i64, exports: &Js) -> Result<()> {
        self.unit(
            "joins.persistBranchExport",
            obj! {
                "runId" => s(run_id),
                "frameAddress" => s(frame_address),
                "branchAddress" => s(branch_address),
                "branchIndex" => Js::Num(branch_index.into()),
                "exports" => exports.clone(),
            },
        )
    }
    fn collect_branch_exports(&self, run_id: &str, frame_address: &str) -> Result<Vec<BranchExport>> {
        self.rows("joins.collectBranchExports", obj! { "runId" => s(run_id), "frameAddress" => s(frame_address) })
    }
    fn has_pending_joins(&self, run_id: &str) -> Result<bool> {
        self.flag("joins.hasPendingJoins", obj! { "runId" => s(run_id) })
    }
    fn frames(&self, run_id: &str) -> Result<Vec<String>> {
        self.strings("joins.frames", obj! { "runId" => s(run_id) })
    }
    fn delete_frames(&self, run_id: &str, frame_addresses: &[String]) -> Result<()> {
        self.unit("joins.deleteFrames", obj! { "runId" => s(run_id), "frameAddresses" => strings(frame_addresses) })
    }

    fn correlate(&self, run_id: &str, team_id: &str, address: &str, adapter_type: &str, correlation_key: &str) -> Result<()> {
        self.unit(
            "correlations.correlate",
            obj! { "runId" => s(run_id), "teamId" => s(team_id), "address" => s(address), "adapterType" => s(adapter_type), "correlationKey" => s(correlation_key) },
        )
    }
    fn correlated(&self, adapter_type: &str, team_id: &str, correlation_key: &str) -> Result<Vec<CorrelatedAwait>> {
        self.rows("correlations.correlated", obj! { "adapterType" => s(adapter_type), "teamId" => s(team_id), "correlationKey" => s(correlation_key) })
    }
    fn of_run(&self, run_id: &str, adapter_type: &str) -> Result<Vec<(CorrelatedAwait, String)>> {
        self.rows("correlations.ofRun", obj! { "runId" => s(run_id), "adapterType" => s(adapter_type) })
    }
    fn drop_correlation(&self, run_id: &str, address: &str) -> Result<()> {
        self.unit("correlations.drop", obj! { "runId" => s(run_id), "address" => s(address) })
    }
    fn drop_run_correlations(&self, run_id: &str) -> Result<()> {
        self.unit("correlations.dropRun", obj! { "runId" => s(run_id) })
    }

    fn claim_lease(&self, run_id: &str, ttl_ms: i64) -> Result<Option<String>> {
        match self.call("leases.claim", obj! { "runId" => s(run_id), "ttlMs" => Js::Num(ttl_ms.into()) })? {
            Js::Null => Ok(None),
            answer => answer.get("token").and_then(Js::as_str).map(|t| Some(t.to_string())).ok_or_else(|| self.malformed("leases.claim", &answer)),
        }
    }
    fn renew_lease(&self, run_id: &str, token: &str, ttl_ms: i64) -> Result<bool> {
        self.flag("leases.renew", obj! { "runId" => s(run_id), "token" => s(token), "ttlMs" => Js::Num(ttl_ms.into()) })
    }
    fn release_lease(&self, run_id: &str, token: &str) -> Result<()> {
        self.unit("leases.release", obj! { "runId" => s(run_id), "token" => s(token) })
    }
    fn drop_run_state(&self, run_id: &str, fence: Option<&str>) -> Result<bool> {
        self.flag("leases.dropRunState", obj! { "runId" => s(run_id), "fence" => opt(fence) })
    }

    fn enqueue(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>, team_id: Option<&str>) -> Result<()> {
        self.unit("work.enqueue", obj! { "kind" => s(kind), "key" => s(key), "payload" => payload.clone(), "dueAt" => opt(due_at), "teamId" => opt(team_id) })
    }
    fn claim_due(&self, limit: i64, lease_ms: i64, due_by: Option<&str>) -> Result<Vec<ClaimedWork>> {
        self.rows("work.claimDue", obj! { "limit" => Js::Num(limit.into()), "leaseMs" => Js::Num(lease_ms.into()), "dueBy" => opt(due_by) })
    }
    fn complete(&self, id: &str, claim: &str) -> Result<()> {
        self.unit("work.complete", obj! { "id" => s(id), "claim" => s(claim) })
    }
    fn release_work(&self, id: &str, claim: &str, due_at: Option<&str>) -> Result<()> {
        self.unit("work.release", obj! { "id" => s(id), "claim" => s(claim), "dueAt" => opt(due_at) })
    }

    fn put_source(&self, team_id: &str, hash: &str, source: &str) -> Result<()> {
        self.unit("sources.put", obj! { "teamId" => s(team_id), "hash" => s(hash), "source" => s(source) })
    }
    fn get_source(&self, team_id: &str, hash: &str) -> Result<Option<String>> {
        match self.call("sources.get", obj! { "teamId" => s(team_id), "hash" => s(hash) })? {
            Js::Null => Ok(None),
            Js::Str(source) => Ok(Some(source)),
            other => Err(self.malformed("sources.get", &other)),
        }
    }

    fn mint_callback(&self, input: MintCallback<'_>) -> Result<String> {
        let params = obj! {
            "teamId" => s(input.team_id),
            "runId" => s(input.run_id),
            "address" => s(input.address),
            "params" => input.params.clone(),
            "state" => input.state.clone(),
            "singleUse" => Js::Bool(input.single_use),
            "expiresAt" => opt(input.expires_at),
        };
        let answer = self.call("callbacks.mint", params)?;
        answer.get("id").and_then(Js::as_str).map(str::to_string).ok_or_else(|| self.malformed("callbacks.mint", &answer))
    }
    fn callback(&self, id: &str) -> Result<Option<CallbackRecord>> {
        self.row("callbacks.get", obj! { "id" => s(id) })
    }
    fn record_callback_call(&self, id: &str, values: &Js, body_due_at: &str) -> Result<CallbackClaim> {
        let answer = self.call("callbacks.record", obj! { "id" => s(id), "values" => values.clone(), "bodyDueAt" => s(body_due_at) })?;
        CallbackClaim::from_wire(&answer).ok_or_else(|| self.malformed("callbacks.record", &answer))
    }
    fn mark_callback_body_started(&self, id: &str, call_index: i64, fence: Option<&str>) -> Result<bool> {
        self.flag("callbacks.markBodyStarted", obj! { "id" => s(id), "callIndex" => Js::Num(call_index.into()), "fence" => opt(fence) })
    }
    fn landed_callbacks(&self, ids: &[String]) -> Result<Vec<String>> {
        self.strings("callbacks.landed", obj! { "ids" => strings(ids) })
    }
    fn revoke_run_callbacks(&self, run_id: &str) -> Result<()> {
        self.unit("callbacks.revokeRun", obj! { "runId" => s(run_id) })
    }

    fn inbound_checkpoint(&self, subscription_id: &str) -> Result<Option<Js>> {
        match self.call("inbound.checkpoint", obj! { "subscriptionId" => s(subscription_id) })? {
            Js::Null => Ok(None),
            answer => answer.get("checkpoint").cloned().map(Some).ok_or_else(|| self.malformed("inbound.checkpoint", &answer)),
        }
    }
    fn save_inbound_checkpoint(&self, subscription_id: &str, checkpoint: &Js) -> Result<()> {
        self.unit("inbound.saveCheckpoint", obj! { "subscriptionId" => s(subscription_id), "checkpoint" => checkpoint.clone() })
    }

    fn claim_event(&self, listen: &str, key: &str) -> Result<bool> {
        self.flag("events.claim", obj! { "listen" => s(listen), "key" => s(key) })
    }
}
