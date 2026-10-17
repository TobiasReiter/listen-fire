//! `lf-host --contract-store <state.db>`: the run host's backend families
//! (crate::store) served over stdin/stdout, one JSON-RPC 2.0 message per
//! line, so the TypeScript contract suite drives this store through its
//! `RpcStoreBackend` (movement-engine `services/run_host/rpc_store.ts`) and
//! holds it to the meaning every backend has.
//!
//! A method is `<family>.<method>` as `RunHostStore` names it
//! (`parks.putLeaf`, `work.claimDue`, …), its params the TypeScript method's
//! one input object, its result the TypeScript method's answer (`null` for
//! none). `runs.start` adds a run row, the contract's `newRun`. A fenced write
//! refused because the lease is gone answers the error `RunLeaseLost`
//! (code -32001, `data: { name, runId }`), which the client rethrows as the
//! core's `RunLeaseLost`. Requests are answered one at a time, in order.
//! The callback family and the run records (`callbacks.*`, `runs.*`) are
//! crate::callbacks's.

use std::path::Path;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::json::{Js, Obj};
use crate::obj;
use crate::store::{Store, StoreError};

const LEASE_LOST: i64 = -32001;
const INVALID_PARAMS: i64 = -32602;
const METHOD_NOT_FOUND: i64 = -32601;
const PARSE_ERROR: i64 = -32700;
const STORE_FAILED: i64 = -32000;

pub async fn serve(path: &Path) -> Result<(), String> {
    let store = Store::open(path).map_err(|e| format!("{}: {}", path.display(), describe(&e)))?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        if line.trim().is_empty() {
            continue;
        }
        let reply = answer(&store, &line);
        stdout.write_all(format!("{}\n", reply.to_json()).as_bytes()).await.map_err(|e| e.to_string())?;
        stdout.flush().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn answer(store: &Store, line: &str) -> Js {
    let request = match Js::parse(line.as_bytes()) {
        Ok(request) => request,
        Err(e) => return error_reply(Js::Null, PARSE_ERROR, format!("not JSON: {e}"), None),
    };
    let id = request.get("id").cloned().unwrap_or(Js::Null);
    let Some(method) = request.get("method").and_then(Js::as_str) else {
        return error_reply(id, INVALID_PARAMS, "a request names its method".into(), None);
    };
    let empty = Js::from(Obj::new());
    let params = Params(request.get("params").unwrap_or(&empty));
    match dispatch(store, method, &params) {
        Ok(result) => Js::from(obj! { "jsonrpc" => Js::str("2.0"), "id" => id, "result" => result }),
        Err(Failure::Store(StoreError::LeaseLost { run_id })) => error_reply(
            id,
            LEASE_LOST,
            "run lease lost; another instance may hold the run".into(),
            Some(Js::from(obj! { "name" => Js::str("RunLeaseLost"), "runId" => Js::str(run_id) })),
        ),
        Err(Failure::Store(other)) => error_reply(id, STORE_FAILED, describe(&other), None),
        Err(Failure::Params(message)) => error_reply(id, INVALID_PARAMS, message, None),
        Err(Failure::Unknown) => error_reply(id, METHOD_NOT_FOUND, format!("no method \"{method}\""), None),
    }
}

fn error_reply(id: Js, code: i64, message: String, data: Option<Js>) -> Js {
    let mut error = obj! { "code" => Js::Num(code.into()), "message" => Js::str(message) };
    if let Some(data) = data {
        error.insert("data".into(), data);
    }
    Js::from(obj! { "jsonrpc" => Js::str("2.0"), "id" => id, "error" => Js::from(error) })
}

fn describe(error: &StoreError) -> String {
    match error {
        StoreError::LeaseLost { run_id } => format!("run lease lost: {run_id}"),
        StoreError::Invalid(message) => message.clone(),
        StoreError::Db(error) => error.to_string(),
    }
}

enum Failure {
    Store(StoreError),
    Params(String),
    Unknown,
}

impl From<StoreError> for Failure {
    fn from(error: StoreError) -> Self {
        Failure::Store(error)
    }
}

/// One request's input object.
struct Params<'a>(&'a Js);

impl Params<'_> {
    fn str(&self, key: &str) -> Result<&str, Failure> {
        self.0.get(key).and_then(Js::as_str).ok_or_else(|| Failure::Params(format!("{key}: expected a string")))
    }

    /// An optional string; `null` reads as absent.
    fn opt_str(&self, key: &str) -> Result<Option<&str>, Failure> {
        match self.0.get(key) {
            None | Some(Js::Null) => Ok(None),
            Some(Js::Str(s)) => Ok(Some(s)),
            Some(_) => Err(Failure::Params(format!("{key}: expected a string"))),
        }
    }

    fn int(&self, key: &str) -> Result<i64, Failure> {
        match self.0.get(key) {
            Some(Js::Num(n)) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)),
            _ => None,
        }
        .ok_or_else(|| Failure::Params(format!("{key}: expected an integer")))
    }

    fn flag(&self, key: &str) -> bool {
        Js::is_true(self.0.get(key))
    }

    /// A JSON value; absent (`undefined`) is stored as `null`, as `x ?? null`.
    fn value(&self, key: &str) -> Js {
        self.0.get(key).cloned().unwrap_or(Js::Null)
    }

    fn strings(&self, key: &str) -> Result<Vec<String>, Failure> {
        self.0
            .get(key)
            .and_then(Js::as_array)
            .and_then(|items| items.iter().map(|i| i.as_str().map(str::to_string)).collect::<Option<Vec<_>>>())
            .ok_or_else(|| Failure::Params(format!("{key}: expected an array of strings")))
    }
}

fn opt(value: Option<&str>) -> Js {
    value.map(Js::str).unwrap_or(Js::Null)
}

fn correlated_await(c: &crate::store::CorrelatedAwait) -> Obj {
    obj! { "runId" => Js::str(&c.run_id), "teamId" => Js::str(&c.team_id), "address" => Js::str(&c.address) }
}

fn dispatch(store: &Store, method: &str, p: &Params) -> Result<Js, Failure> {
    let none = Ok(Js::Null);
    match method {
        "runs.start" => {
            store.start_run(p.str("id")?, p.str("file")?, p.str("movement")?, p.str("startedAt")?, p.str("input")?)?;
            none
        }

        "parks.putLeaf" => {
            store.put_leaf(p.str("runId")?, p.str("address")?, p.str("reason")?, p.opt_str("wakeAt")?, &p.value("state"), p.opt_str("fence")?)?;
            none
        }
        "parks.claimLeaf" => Ok(match store.claim_leaf(p.str("runId")?, p.str("address")?, p.opt_str("reason")?)? {
            None => Js::Null,
            Some((reason, state)) => Js::from(obj! { "reason" => Js::str(reason), "state" => state }),
        }),
        "parks.finishLeaf" => {
            store.finish_leaf(p.str("runId")?, p.str("address")?, p.opt_str("fence")?)?;
            none
        }
        "parks.leaves" => {
            let rows = store.leaves(p.str("runId")?, p.flag("parkedOnly"), p.opt_str("reason")?, p.opt_str("dueBy")?)?;
            Ok(Js::Arr(
                rows.into_iter()
                    .map(|r| {
                        Js::from(obj! {
                            "address" => Js::str(r.address),
                            "reason" => Js::str(r.reason),
                            "status" => Js::str(r.status),
                            "wakeAt" => opt(r.wake_at.as_deref()),
                        })
                    })
                    .collect(),
            ))
        }
        "parks.deleteLeaves" => {
            store.delete_leaves(p.str("runId")?, &p.strings("addresses")?)?;
            none
        }

        "joins.recordJoin" => {
            store.record_join(p.str("runId")?, p.str("frameAddress")?, p.int("pending")?, p.opt_str("fence")?)?;
            none
        }
        "joins.decrementJoin" => {
            let closed = store.decrement_join(p.str("runId")?, p.str("frameAddress")?, p.str("branchAddress")?, p.str("leafAddress")?)?;
            Ok(Js::from(obj! { "closed" => Js::Bool(closed) }))
        }
        "joins.persistBranchExport" => {
            store.persist_branch_export(p.str("runId")?, p.str("frameAddress")?, p.str("branchAddress")?, p.int("branchIndex")?, &p.value("exports"))?;
            none
        }
        "joins.collectBranchExports" => Ok(Js::Arr(
            store
                .collect_branch_exports(p.str("runId")?, p.str("frameAddress")?)?
                .into_iter()
                .map(|e| {
                    Js::from(obj! {
                        "branchAddress" => Js::str(e.branch_address),
                        "branchIndex" => Js::Num(e.branch_index.into()),
                        "exports" => e.exports,
                    })
                })
                .collect(),
        )),
        "joins.hasPendingJoins" => Ok(Js::Bool(store.has_pending_joins(p.str("runId")?)?)),
        "joins.frames" => Ok(Js::strings(store.frames(p.str("runId")?)?)),
        "joins.deleteFrames" => {
            store.delete_frames(p.str("runId")?, &p.strings("frameAddresses")?)?;
            none
        }

        "correlations.correlate" => {
            store.correlate(p.str("runId")?, p.str("teamId")?, p.str("address")?, p.str("adapterType")?, p.str("correlationKey")?)?;
            none
        }
        "correlations.correlated" => Ok(Js::Arr(
            store
                .correlated(p.str("adapterType")?, p.str("teamId")?, p.str("correlationKey")?)?
                .iter()
                .map(|c| Js::from(correlated_await(c)))
                .collect(),
        )),
        "correlations.ofRun" => Ok(Js::Arr(
            store
                .of_run(p.str("runId")?, p.str("adapterType")?)?
                .iter()
                .map(|(c, key)| {
                    let mut row = correlated_await(c);
                    row.insert("correlationKey".into(), Js::str(key));
                    Js::from(row)
                })
                .collect(),
        )),
        "correlations.drop" => {
            store.drop_correlation(p.str("runId")?, p.str("address")?)?;
            none
        }
        "correlations.dropRun" => {
            store.drop_run_correlations(p.str("runId")?)?;
            none
        }

        "leases.claim" => Ok(match store.claim_lease(p.str("runId")?, p.int("ttlMs")?)? {
            None => Js::Null,
            Some(token) => Js::from(obj! { "token" => Js::str(token) }),
        }),
        "leases.renew" => Ok(Js::Bool(store.renew_lease(p.str("runId")?, p.str("token")?, p.int("ttlMs")?)?)),
        "leases.release" => {
            store.release_lease(p.str("runId")?, p.str("token")?)?;
            none
        }
        "leases.dropRunState" => Ok(Js::Bool(store.drop_run_state(p.str("runId")?, p.opt_str("fence")?)?)),

        "work.enqueue" => {
            store.enqueue(p.str("kind")?, p.str("key")?, &p.value("payload"), p.opt_str("dueAt")?)?;
            none
        }
        "work.claimDue" => Ok(Js::Arr(
            store
                .claim_due(p.int("limit")?, p.int("leaseMs")?, p.opt_str("dueBy")?)?
                .into_iter()
                .map(|w| {
                    Js::from(obj! {
                        "id" => Js::str(w.id),
                        "kind" => Js::str(w.kind),
                        "key" => Js::str(w.key),
                        "payload" => w.payload,
                        "claim" => Js::str(w.claim),
                    })
                })
                .collect(),
        )),
        "work.complete" => {
            store.complete(p.str("id")?, p.str("claim")?)?;
            none
        }
        "work.release" => {
            store.release_work(p.str("id")?, p.str("claim")?, p.opt_str("dueAt")?)?;
            none
        }

        "sources.put" => {
            store.put_source(p.str("teamId")?, p.str("hash")?, p.str("source")?)?;
            none
        }
        "sources.get" => Ok(opt(store.get_source(p.str("teamId")?, p.str("hash")?)?.as_deref())),

        other => match crate::callbacks::rpc(store, other, p.0) {
            None => Err(Failure::Unknown),
            Some(Ok(result)) => Ok(result),
            Some(Err(crate::callbacks::RpcFailure::Store(error))) => Err(Failure::Store(error)),
            Some(Err(crate::callbacks::RpcFailure::Params(message))) => Err(Failure::Params(message)),
        },
    }
}
