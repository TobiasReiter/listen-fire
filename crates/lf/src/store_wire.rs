//! The rows the store wire carries (docs/contracts/store-slot.md), each
//! written and read in one place: `lf --contract-store` writes them
//! (crate::contract_store) and lf reads them back from a store module
//! (crate::store_module). A row's keys are the TypeScript families' names
//! (`RunHostStore`, `CallbackStore`).

use crate::backend::{CallbackClaim, CallbackRecord};
use crate::json::{Js, Obj};
use crate::obj;
use crate::store::{BranchExport, ClaimedWork, CorrelatedAwait, LeafRow, RunRow};

/// A row as the store wire carries it.
pub trait Wire: Sized {
    fn to_wire(&self) -> Js;
    /// None: the value is not this row.
    fn from_wire(value: &Js) -> Option<Self>;
}

pub fn opt(value: Option<&str>) -> Js {
    value.map(Js::str).unwrap_or(Js::Null)
}

fn text(value: &Js, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

/// An optional string: absent and `null` alike are None.
fn opt_text(value: &Js, key: &str) -> Option<Option<String>> {
    match value.get(key) {
        None | Some(Js::Null) => Some(None),
        Some(Js::Str(s)) => Some(Some(s.clone())),
        Some(_) => None,
    }
}

pub fn int(value: &Js) -> Option<i64> {
    match value {
        Js::Num(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)),
        _ => None,
    }
}

pub fn num(value: f64) -> Js {
    serde_json::Number::from_f64(value).map(Js::Num).unwrap_or(Js::Null)
}

/// Every item of an array as a row, or None when any is not one.
pub fn rows<T: Wire>(value: &Js) -> Option<Vec<T>> {
    value.as_array()?.iter().map(T::from_wire).collect()
}

pub fn to_rows<T: Wire>(rows: &[T]) -> Js {
    Js::Arr(rows.iter().map(Wire::to_wire).collect())
}

impl Wire for RunRow {
    fn to_wire(&self) -> Js {
        Js::from(obj! {
            "id" => Js::str(&self.id),
            "file" => Js::str(&self.file),
            "movement" => Js::str(&self.movement),
            "status" => Js::str(&self.status),
            "startedAt" => Js::str(&self.started_at),
            "input" => Js::str(&self.input),
            "outcome" => opt(self.outcome.as_deref()),
        })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(RunRow {
            id: text(v, "id")?,
            file: text(v, "file")?,
            movement: text(v, "movement")?,
            status: text(v, "status")?,
            started_at: text(v, "startedAt")?,
            input: text(v, "input")?,
            outcome: opt_text(v, "outcome")?,
        })
    }
}

impl Wire for LeafRow {
    fn to_wire(&self) -> Js {
        Js::from(obj! {
            "address" => Js::str(&self.address),
            "reason" => Js::str(&self.reason),
            "status" => Js::str(&self.status),
            "wakeAt" => opt(self.wake_at.as_deref()),
        })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(LeafRow { address: text(v, "address")?, reason: text(v, "reason")?, status: text(v, "status")?, wake_at: opt_text(v, "wakeAt")? })
    }
}

impl Wire for ClaimedWork {
    fn to_wire(&self) -> Js {
        Js::from(obj! {
            "id" => Js::str(&self.id),
            "kind" => Js::str(&self.kind),
            "key" => Js::str(&self.key),
            "payload" => self.payload.clone(),
            "claim" => Js::str(&self.claim),
        })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(ClaimedWork { id: text(v, "id")?, kind: text(v, "kind")?, key: text(v, "key")?, payload: v.get("payload")?.clone(), claim: text(v, "claim")? })
    }
}

impl Wire for crate::echoes::Remembered {
    fn to_wire(&self) -> Js {
        Js::from(obj! { "writer" => Js::str(&self.writer), "recordType" => Js::str(&self.record_type), "fingerprint" => Js::str(&self.fingerprint) })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(crate::echoes::Remembered { writer: text(v, "writer")?, record_type: text(v, "recordType")?, fingerprint: text(v, "fingerprint")? })
    }
}

fn correlated_obj(c: &CorrelatedAwait) -> Obj {
    obj! { "runId" => Js::str(&c.run_id), "teamId" => Js::str(&c.team_id), "address" => Js::str(&c.address) }
}

impl Wire for CorrelatedAwait {
    fn to_wire(&self) -> Js {
        Js::from(correlated_obj(self))
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(CorrelatedAwait { run_id: text(v, "runId")?, team_id: text(v, "teamId")?, address: text(v, "address")? })
    }
}

/// A run's await correlation with its key (`correlations.ofRun`).
impl Wire for (CorrelatedAwait, String) {
    fn to_wire(&self) -> Js {
        let mut row = correlated_obj(&self.0);
        row.insert("correlationKey".into(), Js::str(&self.1));
        Js::from(row)
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some((CorrelatedAwait::from_wire(v)?, text(v, "correlationKey")?))
    }
}

impl Wire for BranchExport {
    fn to_wire(&self) -> Js {
        Js::from(obj! {
            "branchAddress" => Js::str(&self.branch_address),
            "branchIndex" => Js::Num(self.branch_index.into()),
            "exports" => self.exports.clone(),
        })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(BranchExport { branch_address: text(v, "branchAddress")?, branch_index: int(v.get("branchIndex")?)?, exports: v.get("exports")?.clone() })
    }
}

impl Wire for CallbackRecord {
    fn to_wire(&self) -> Js {
        Js::from(obj! {
            "id" => Js::str(&self.id),
            "teamId" => Js::str(&self.team_id),
            "runId" => Js::str(&self.run_id),
            "address" => Js::str(&self.address),
            "params" => self.params.clone(),
            "state" => self.state.clone(),
            "calls" => self.calls.clone(),
            "singleUse" => Js::Bool(self.single_use),
            "expiresAt" => opt(self.expires_at.as_deref()),
            "status" => Js::str(&self.status),
        })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(CallbackRecord {
            id: text(v, "id")?,
            team_id: text(v, "teamId")?,
            run_id: text(v, "runId")?,
            address: text(v, "address")?,
            params: v.get("params")?.clone(),
            state: v.get("state")?.clone(),
            calls: v.get("calls")?.clone(),
            single_use: matches!(v.get("singleUse")?, Js::Bool(true)),
            expires_at: opt_text(v, "expiresAt")?,
            status: text(v, "status")?,
        })
    }
}

impl Wire for CallbackClaim {
    fn to_wire(&self) -> Js {
        Js::from(match self {
            CallbackClaim::Recorded { callback, call_index } => {
                obj! { "kind" => Js::str("recorded"), "callback" => callback.to_wire(), "callIndex" => Js::Num((*call_index).into()) }
            }
            CallbackClaim::NotFound => obj! { "kind" => Js::str("not_found") },
            CallbackClaim::Closed(callback) => obj! { "kind" => Js::str("closed"), "callback" => callback.to_wire() },
            CallbackClaim::Expired(callback) => obj! { "kind" => Js::str("expired"), "callback" => callback.to_wire() },
        })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        let callback = || v.get("callback").and_then(CallbackRecord::from_wire);
        Some(match v.get("kind")?.as_str()? {
            "recorded" => CallbackClaim::Recorded { callback: callback()?, call_index: int(v.get("callIndex")?)? },
            "not_found" => CallbackClaim::NotFound,
            "closed" => CallbackClaim::Closed(callback()?),
            "expired" => CallbackClaim::Expired(callback()?),
            _ => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_row_reads_back_as_it_was_written() {
        let run = RunRow {
            id: "r".into(),
            file: "f".into(),
            movement: "m".into(),
            status: "parked".into(),
            started_at: "2026-10-17T00:00:00.000Z".into(),
            input: "{}".into(),
            outcome: None,
        };
        let back = RunRow::from_wire(&run.to_wire()).unwrap();
        assert_eq!((back.id, back.status, back.outcome), (run.id, run.status, None));
        let callback = CallbackRecord {
            id: "c".into(),
            team_id: "t".into(),
            run_id: "r".into(),
            address: "a".into(),
            params: Js::Arr(vec![]),
            state: Js::Null,
            calls: Js::Arr(vec![]),
            single_use: true,
            expires_at: Some("2026-10-18T00:00:00.000Z".into()),
            status: "live".into(),
        };
        let claim = CallbackClaim::Recorded { callback, call_index: 2 };
        assert_eq!(CallbackClaim::from_wire(&claim.to_wire()).map(|c| c.to_wire()), Some(claim.to_wire()));
        assert!(LeafRow::from_wire(&Js::str("not a row")).is_none());
    }
}
