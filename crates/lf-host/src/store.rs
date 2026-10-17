//! The run host's backend families (movement-engine
//! `services/run_host/store.ts`) over SQLite, in the TypeScript lf's state
//! file: the same schema and the same statements as apps/cli/src/state.ts,
//! so one `.lf/state.db` reads alike from either host. Held to the hosted
//! Postgres backend's meaning by the run host's contract suite, which drives
//! this store through `--contract-store` (crate::contract_store).
//!
//! Instants are text in `Date.toISOString`'s form, compared as text, exactly
//! as the TypeScript store compares them.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use crate::json::Js;

/// The TypeScript lf's schema (apps/cli/src/state.ts `SCHEMA`), verbatim; a
/// test holds the two equal.
pub const SCHEMA: &str = "
create table if not exists run (
  id text primary key,
  file text not null,
  movement text not null,
  status text not null,
  started_at text not null,
  finished_at text,
  input text not null,
  outcome text,
  lease_token text,
  lease_until text
);
create table if not exists trace (
  run_id text not null,
  seq integer not null,
  entry text not null,
  primary key (run_id, seq)
);
create table if not exists leaf (
  run_id text not null,
  address text not null,
  reason text not null,
  status text not null default 'parked',
  wake_at text,
  state text not null,
  primary key (run_id, address)
);
create table if not exists await_correlation (
  run_id text not null,
  team_id text not null,
  address text not null,
  adapter_type text not null,
  correlation_key text not null,
  primary key (run_id, address)
);
create index if not exists await_correlation_key on await_correlation (team_id, adapter_type, correlation_key);
create table if not exists join_frame (
  run_id text not null,
  frame_address text not null,
  pending integer not null,
  closed_by_address text,
  primary key (run_id, frame_address)
);
create table if not exists join_branch_export (
  run_id text not null,
  frame_address text not null,
  branch_address text not null,
  branch_index integer not null,
  exports text not null,
  decremented integer not null default 0,
  primary key (run_id, frame_address, branch_address)
);
create table if not exists record_binding (
  a_adapter_type text not null,
  a_instance_key text not null,
  a_type_id text not null,
  a_record_id text not null,
  b_adapter_type text not null,
  b_instance_key text not null,
  b_type_id text not null,
  b_record_id text not null,
  bound_seq integer not null,
  primary key (a_adapter_type, a_instance_key, a_type_id, a_record_id, b_adapter_type, b_instance_key, b_type_id, b_record_id)
);
create table if not exists park_library_source (
  team_id text not null,
  hash text not null,
  source text not null,
  primary key (team_id, hash)
);
create table if not exists callback (
  id text primary key,
  team_id text not null,
  run_id text not null,
  address text not null,
  params text not null,
  state text not null,
  calls text not null,
  single_use integer not null,
  expires_at text,
  status text not null,
  created_at text not null,
  fired_at text,
  revoked_at text
);
create index if not exists callback_run on callback (run_id);
create table if not exists work (
  id integer primary key autoincrement,
  kind text not null,
  key text not null unique,
  payload text not null,
  due_at text not null,
  lease_token text,
  lease_until text,
  version integer not null default 0
);
";

/// The core's park reasons (`CORE_PARK_REASONS`).
pub const CORE_PARK_REASONS: &[&str] = &["timer", "await", "limit"];
/// The work kinds lf queues (apps/cli/src/state.ts `WorkKind`).
pub const WORK_KINDS: &[&str] = &["resume_timer", "wake_await", "fire_event", "fire_callback"];

/// Columns a state file written by an earlier lf lacks (apps/cli/src/state.ts
/// `addMissingColumns`), added on open so either host leaves the file alike.
const ADDED_RUN_COLUMNS: &[&str] = &["cancel_requested_at", "cancel_reason"];

#[derive(Debug)]
pub enum StoreError {
    /// `RunLeaseLost`: a fenced write under a token that no longer holds the run.
    LeaseLost { run_id: String },
    /// A value outside what the families take.
    Invalid(String),
    Db(rusqlite::Error),
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Db(error)
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

pub struct LeafRow {
    pub address: String,
    pub reason: String,
    pub status: String,
    pub wake_at: Option<String>,
}

pub struct ClaimedWork {
    pub id: String,
    pub kind: String,
    pub key: String,
    pub payload: Js,
    pub claim: String,
}

pub struct CorrelatedAwait {
    pub run_id: String,
    pub team_id: String,
    pub address: String,
}

pub struct BranchExport {
    pub branch_address: String,
    pub branch_index: i64,
    pub exports: Js,
}

/// `Date.prototype.toISOString` of now plus `offset_ms`.
pub fn iso(offset_ms: i64) -> String {
    let at = jiff::Timestamp::now().as_millisecond() + offset_ms;
    let ts = jiff::Timestamp::from_millisecond(at).expect("an instant within range");
    format!("{}.{:03}Z", ts.strftime("%Y-%m-%dT%H:%M:%S"), at.rem_euclid(1000))
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn text_of(value: &Js) -> String {
    value.to_json()
}

fn parse_text(text: &str) -> Result<Js> {
    Js::parse(text.as_bytes()).map_err(|e| StoreError::Invalid(format!("a stored value is not JSON: {e}")))
}

fn reason_of(reason: String) -> Result<String> {
    if CORE_PARK_REASONS.contains(&reason.as_str()) { Ok(reason) } else { Err(StoreError::Invalid(format!("not a park reason: {reason}"))) }
}

/// A work claim's handle (`<lease token>/<version>`).
fn work_claim(claim: &str) -> Result<(String, i64)> {
    let not = || StoreError::Invalid(format!("not a work claim: {claim}"));
    let at = claim.rfind('/').filter(|at| *at > 0).ok_or_else(not)?;
    let version = claim[at + 1..].parse::<i64>().map_err(|_| not())?;
    Ok((claim[..at].to_string(), version))
}

pub struct Store {
    db: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Store> {
        let db = Connection::open(path)?;
        // Two processes may share the file: readers never block the writer,
        // and a writer waits for another's transaction.
        db.execute_batch("pragma journal_mode = wal; pragma busy_timeout = 5000;")?;
        db.execute_batch(SCHEMA)?;
        let columns = db
            .prepare("select name from pragma_table_info('run')")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for column in ADDED_RUN_COLUMNS {
            if !columns.iter().any(|c| c == column) {
                db.execute_batch(&format!("alter table run add column {column} text"))?;
            }
        }
        Ok(Store { db })
    }

    /// One write transaction, taken before its first read.
    fn transaction<T>(&self, body: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        self.db.execute_batch("begin immediate")?;
        match body(&self.db) {
            Ok(value) => {
                self.db.execute_batch("commit")?;
                Ok(value)
            }
            Err(error) => {
                self.db.execute_batch("rollback")?;
                Err(error)
            }
        }
    }

    /// Whether the run is leased under `fence`, and the lease has not lapsed.
    fn holds(db: &Connection, run_id: &str, fence: &str) -> Result<bool> {
        Ok(db
            .query_row("select 1 from run where id = ? and lease_token = ? and lease_until > ?", params![run_id, fence, iso(0)], |_| Ok(()))
            .optional()?
            .is_some())
    }

    fn fenced<T>(&self, run_id: &str, fence: Option<&str>, body: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        self.transaction(|db| {
            if let Some(fence) = fence
                && !Self::holds(db, run_id, fence)?
            {
                return Err(StoreError::LeaseLost { run_id: run_id.to_string() });
            }
            body(db)
        })
    }

    // ── Runs ────────────────────────────────────────────────────────────────

    pub fn start_run(&self, id: &str, file: &str, movement: &str, started_at: &str, input: &str) -> Result<()> {
        self.db.execute(
            "insert into run (id, file, movement, status, started_at, input) values (?, ?, ?, ?, ?, ?)",
            params![id, file, movement, "running", started_at, input],
        )?;
        Ok(())
    }

    // ── Parks ───────────────────────────────────────────────────────────────

    pub fn put_leaf(&self, run_id: &str, address: &str, reason: &str, wake_at: Option<&str>, state: &Js, fence: Option<&str>) -> Result<()> {
        // `rewritten` is not kept: lf has no limit resume to read it.
        reason_of(reason.to_string())?;
        self.fenced(run_id, fence, |db| {
            db.execute(
                "insert into leaf (run_id, address, reason, status, wake_at, state) values (?, ?, ?, 'parked', ?, ?)
                 on conflict (run_id, address) do update set
                   reason = excluded.reason, status = 'parked', wake_at = excluded.wake_at, state = excluded.state",
                params![run_id, address, reason, wake_at, text_of(state)],
            )?;
            Ok(())
        })
    }

    pub fn claim_leaf(&self, run_id: &str, address: &str, reason: Option<&str>) -> Result<Option<(String, Js)>> {
        let sql = format!(
            "update leaf set status = 'resuming' where run_id = ? and address = ? and status = 'parked' {} returning reason, state",
            if reason.is_some() { "and reason = ?" } else { "" }
        );
        let mut args: Vec<&str> = vec![run_id, address];
        args.extend(reason);
        let row = self.db.query_row(&sql, params_from_iter(args), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).optional()?;
        row.map(|(reason, state)| Ok((reason_of(reason)?, parse_text(&state)?))).transpose()
    }

    pub fn finish_leaf(&self, run_id: &str, address: &str, fence: Option<&str>) -> Result<()> {
        self.transaction(|db| {
            if let Some(fence) = fence
                && !Self::holds(db, run_id, fence)?
            {
                return Ok(());
            }
            db.execute("delete from leaf where run_id = ? and address = ? and status = 'resuming'", params![run_id, address])?;
            Ok(())
        })
    }

    pub fn leaves(&self, run_id: &str, parked_only: bool, reason: Option<&str>, due_by: Option<&str>) -> Result<Vec<LeafRow>> {
        let mut clauses = vec!["run_id = ?"];
        let mut args: Vec<&str> = vec![run_id];
        if parked_only {
            clauses.push("status = 'parked'");
        }
        if let Some(reason) = reason {
            clauses.push("reason = ?");
            args.push(reason);
        }
        if let Some(due_by) = due_by {
            clauses.push("reason = 'timer' and wake_at <= ?");
            args.push(due_by);
        }
        let sql = format!("select address, reason, status, wake_at from leaf where {} order by address", clauses.join(" and "));
        let mut statement = self.db.prepare(&sql)?;
        let rows = statement
            .query_map(params_from_iter(args), |r| Ok(LeafRow { address: r.get(0)?, reason: r.get(1)?, status: r.get(2)?, wake_at: r.get(3)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for row in &rows {
            reason_of(row.reason.clone())?;
        }
        Ok(rows)
    }

    pub fn delete_leaves(&self, run_id: &str, addresses: &[String]) -> Result<()> {
        self.transaction(|db| {
            let mut drop = db.prepare("delete from leaf where run_id = ? and address = ?")?;
            for address in addresses {
                drop.execute(params![run_id, address])?;
            }
            Ok(())
        })
    }

    // ── Joins ───────────────────────────────────────────────────────────────

    pub fn record_join(&self, run_id: &str, frame_address: &str, pending: i64, fence: Option<&str>) -> Result<()> {
        self.fenced(run_id, fence, |db| {
            db.execute(
                "insert into join_frame (run_id, frame_address, pending) values (?, ?, ?)
                 on conflict (run_id, frame_address) do update set pending = excluded.pending",
                params![run_id, frame_address, pending],
            )?;
            Ok(())
        })
    }

    /// True for the one branch that closes the frame, also on a retry of it.
    pub fn decrement_join(&self, run_id: &str, frame_address: &str, branch_address: &str, leaf_address: &str) -> Result<bool> {
        self.transaction(|db| {
            let claimed = db.execute(
                "update join_branch_export set decremented = 1 where run_id = ? and frame_address = ? and branch_address = ? and decremented = 0",
                params![run_id, frame_address, branch_address],
            )?;
            if claimed > 0 {
                let updated: Option<i64> = db
                    .query_row(
                        "update join_frame set pending = pending - 1 where run_id = ? and frame_address = ? and pending > 0 returning pending",
                        params![run_id, frame_address],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(pending) = updated {
                    if pending > 0 {
                        return Ok(false);
                    }
                    db.execute(
                        "update join_frame set closed_by_address = ? where run_id = ? and frame_address = ?",
                        params![leaf_address, run_id, frame_address],
                    )?;
                    return Ok(true);
                }
            }
            let closed_by: Option<Option<String>> = db
                .query_row("select closed_by_address from join_frame where run_id = ? and frame_address = ?", params![run_id, frame_address], |r| r.get(0))
                .optional()?;
            Ok(closed_by.flatten().as_deref() == Some(leaf_address))
        })
    }

    pub fn persist_branch_export(&self, run_id: &str, frame_address: &str, branch_address: &str, branch_index: i64, exports: &Js) -> Result<()> {
        // A rewrite never touches `decremented`, the branch's decrement claim.
        self.db.execute(
            "insert into join_branch_export (run_id, frame_address, branch_address, branch_index, exports) values (?, ?, ?, ?, ?)
             on conflict (run_id, frame_address, branch_address) do update set exports = excluded.exports, branch_index = excluded.branch_index",
            params![run_id, frame_address, branch_address, branch_index, text_of(exports)],
        )?;
        Ok(())
    }

    pub fn collect_branch_exports(&self, run_id: &str, frame_address: &str) -> Result<Vec<BranchExport>> {
        let mut statement =
            self.db.prepare("select branch_address, branch_index, exports from join_branch_export where run_id = ? and frame_address = ? order by branch_index")?;
        let rows = statement
            .query_map(params![run_id, frame_address], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(branch_address, branch_index, exports)| Ok(BranchExport { branch_address, branch_index, exports: parse_text(&exports)? }))
            .collect()
    }

    pub fn has_pending_joins(&self, run_id: &str) -> Result<bool> {
        Ok(self.db.query_row("select 1 from join_frame where run_id = ? and pending > 0 limit 1", params![run_id], |_| Ok(())).optional()?.is_some())
    }

    pub fn frames(&self, run_id: &str) -> Result<Vec<String>> {
        let mut statement = self.db.prepare("select frame_address from join_frame where run_id = ? order by frame_address")?;
        Ok(statement.query_map(params![run_id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn delete_frames(&self, run_id: &str, frame_addresses: &[String]) -> Result<()> {
        self.transaction(|db| {
            let mut drop_frame = db.prepare("delete from join_frame where run_id = ? and frame_address = ?")?;
            let mut drop_exports = db.prepare("delete from join_branch_export where run_id = ? and frame_address = ?")?;
            for frame in frame_addresses {
                drop_frame.execute(params![run_id, frame])?;
                drop_exports.execute(params![run_id, frame])?;
            }
            Ok(())
        })
    }

    // ── Correlations ────────────────────────────────────────────────────────

    pub fn correlate(&self, run_id: &str, team_id: &str, address: &str, adapter_type: &str, correlation_key: &str) -> Result<()> {
        self.db.execute(
            "insert into await_correlation (run_id, team_id, address, adapter_type, correlation_key) values (?, ?, ?, ?, ?)
             on conflict (run_id, address) do update set
               team_id = excluded.team_id, adapter_type = excluded.adapter_type, correlation_key = excluded.correlation_key",
            params![run_id, team_id, address, adapter_type, correlation_key],
        )?;
        Ok(())
    }

    pub fn correlated(&self, adapter_type: &str, team_id: &str, correlation_key: &str) -> Result<Vec<CorrelatedAwait>> {
        let mut statement = self.db.prepare(
            "select run_id, team_id, address from await_correlation where team_id = ? and adapter_type = ? and correlation_key = ? order by run_id, address",
        )?;
        Ok(statement
            .query_map(params![team_id, adapter_type, correlation_key], |r| Ok(CorrelatedAwait { run_id: r.get(0)?, team_id: r.get(1)?, address: r.get(2)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn of_run(&self, run_id: &str, adapter_type: &str) -> Result<Vec<(CorrelatedAwait, String)>> {
        let mut statement =
            self.db.prepare("select run_id, team_id, address, correlation_key from await_correlation where run_id = ? and adapter_type = ? order by address")?;
        Ok(statement
            .query_map(params![run_id, adapter_type], |r| {
                Ok((CorrelatedAwait { run_id: r.get(0)?, team_id: r.get(1)?, address: r.get(2)? }, r.get(3)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn drop_correlation(&self, run_id: &str, address: &str) -> Result<()> {
        self.db.execute("delete from await_correlation where run_id = ? and address = ?", params![run_id, address])?;
        Ok(())
    }

    pub fn drop_run_correlations(&self, run_id: &str) -> Result<()> {
        self.db.execute("delete from await_correlation where run_id = ?", params![run_id])?;
        Ok(())
    }

    // ── The run lease ───────────────────────────────────────────────────────

    pub fn claim_lease(&self, run_id: &str, ttl_ms: i64) -> Result<Option<String>> {
        let token = uuid();
        self.transaction(|db| {
            let claimed = db.execute(
                "update run set lease_token = ?, lease_until = ? where id = ? and (lease_until is null or lease_until < ?)",
                params![token, iso(ttl_ms), run_id, iso(0)],
            )?;
            if claimed == 0 {
                return Ok(None);
            }
            db.execute("update leaf set status = 'parked' where run_id = ? and status = 'resuming'", params![run_id])?;
            Ok(Some(token))
        })
    }

    pub fn renew_lease(&self, run_id: &str, token: &str, ttl_ms: i64) -> Result<bool> {
        let renewed = self.db.execute(
            "update run set lease_until = ? where id = ? and lease_token = ? and lease_until > ?",
            params![iso(ttl_ms), run_id, token, iso(0)],
        )?;
        Ok(renewed > 0)
    }

    pub fn release_lease(&self, run_id: &str, token: &str) -> Result<()> {
        self.db.execute("update run set lease_token = null, lease_until = null where id = ? and lease_token = ?", params![run_id, token])?;
        Ok(())
    }

    pub fn drop_run_state(&self, run_id: &str, fence: Option<&str>) -> Result<bool> {
        self.transaction(|db| {
            if let Some(fence) = fence
                && !Self::holds(db, run_id, fence)?
            {
                return Ok(false);
            }
            db.execute("delete from leaf where run_id = ?", params![run_id])?;
            db.execute("delete from join_frame where run_id = ?", params![run_id])?;
            db.execute("delete from join_branch_export where run_id = ?", params![run_id])?;
            Ok(true)
        })
    }

    // ── The work queue ──────────────────────────────────────────────────────

    pub fn enqueue(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>) -> Result<()> {
        if !WORK_KINDS.contains(&kind) {
            return Err(StoreError::Invalid(format!("not a work kind: {kind}")));
        }
        // Against a held row the new due time wins: its holder's completion
        // leaves the row for the re-arm.
        let now = iso(0);
        self.db.execute(
            "insert into work (kind, key, payload, due_at) values (?, ?, ?, ?)
             on conflict (key) do update set
               due_at = case when work.lease_until > ? then excluded.due_at else min(work.due_at, excluded.due_at) end,
               payload = excluded.payload,
               version = work.version + 1",
            params![kind, key, text_of(payload), due_at.unwrap_or(&now), now],
        )?;
        Ok(())
    }

    pub fn claim_due(&self, limit: i64, lease_ms: i64, due_by: Option<&str>) -> Result<Vec<ClaimedWork>> {
        let now = iso(0);
        let due_by = due_by.map(str::to_string).unwrap_or_else(|| now.clone());
        self.transaction(|db| {
            let mut select = db.prepare(
                "select id, kind, key, payload, version from work where due_at <= ? and (lease_until is null or lease_until < ?) order by due_at, id limit ?",
            )?;
            let due = select
                .query_map(params![due_by, now, limit], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut lease = db.prepare("update work set lease_token = ?, lease_until = ?, version = version + 1 where id = ?")?;
            due.into_iter()
                .map(|(id, kind, key, payload, version)| {
                    if !WORK_KINDS.contains(&kind.as_str()) {
                        return Err(StoreError::Invalid(format!("not a work kind: {kind}")));
                    }
                    let lease_token = uuid();
                    lease.execute(params![lease_token, iso(lease_ms), id])?;
                    Ok(ClaimedWork { id: id.to_string(), kind, key, payload: parse_text(&payload)?, claim: format!("{lease_token}/{}", version + 1) })
                })
                .collect()
        })
    }

    pub fn complete(&self, id: &str, claim: &str) -> Result<()> {
        // Deleted only when nothing re-armed it since the claim; else the
        // re-armed row stays, unleased, for its new due time.
        let (lease_token, version) = work_claim(claim)?;
        let id = work_id(id)?;
        self.transaction(|db| {
            db.execute("delete from work where id = ? and lease_token = ? and version = ?", params![id, lease_token, version])?;
            db.execute("update work set lease_token = null, lease_until = null where id = ? and lease_token = ?", params![id, lease_token])?;
            Ok(())
        })
    }

    pub fn release_work(&self, id: &str, claim: &str, due_at: Option<&str>) -> Result<()> {
        let (lease_token, version) = work_claim(claim)?;
        self.db.execute(
            "update work set lease_token = null, lease_until = null,
               due_at = case when version = ? then coalesce(?, due_at) else due_at end
             where id = ? and lease_token = ?",
            params![version, due_at, work_id(id)?, lease_token],
        )?;
        Ok(())
    }

    // ── Library sources ─────────────────────────────────────────────────────

    pub fn put_source(&self, team_id: &str, hash: &str, source: &str) -> Result<()> {
        self.db.execute("insert into park_library_source (team_id, hash, source) values (?, ?, ?) on conflict do nothing", params![team_id, hash, source])?;
        Ok(())
    }

    pub fn get_source(&self, team_id: &str, hash: &str) -> Result<Option<String>> {
        Ok(self.db.query_row("select source from park_library_source where team_id = ? and hash = ?", params![team_id, hash], |r| r.get(0)).optional()?)
    }
}

/// `Number(work.id)`: the row id a claim names.
fn work_id(id: &str) -> Result<i64> {
    id.parse().map_err(|_| StoreError::Invalid(format!("not a work id: {id}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The TypeScript lf's schema, read off its source, is this one.
    #[test]
    fn the_schema_is_the_typescript_lfs() {
        let source = include_str!("../../../apps/cli/src/state.ts");
        let start = source.find("const SCHEMA = `").expect("state.ts declares SCHEMA") + "const SCHEMA = `".len();
        let end = start + source[start..].find('`').expect("SCHEMA ends");
        assert_eq!(&source[start..end], SCHEMA);
    }

    #[test]
    fn the_work_kinds_and_added_columns_are_the_typescript_lfs() {
        let source = include_str!("../../../apps/cli/src/state.ts");
        let marker = "export const WorkKind = z.enum([";
        let start = source.find(marker).expect("state.ts declares WorkKind") + marker.len();
        let end = start + source[start..].find(']').expect("WorkKind ends");
        let kinds: Vec<&str> = source[start..end].split(',').map(|k| k.trim().trim_matches('\'')).collect();
        assert_eq!(kinds, WORK_KINDS);
        let marker = "for (const column of [";
        let start = source.find(marker).expect("state.ts adds missing columns") + marker.len();
        let end = start + source[start..].find(']').expect("the column list ends");
        let columns: Vec<&str> = source[start..end].split(',').map(|c| c.trim().trim_matches('\'')).collect();
        assert_eq!(columns, ADDED_RUN_COLUMNS);
    }

    #[test]
    fn instants_are_written_as_to_iso_string_writes_them() {
        let now = iso(0);
        assert_eq!(now.len(), "2026-10-17T12:00:00.000Z".len(), "{now}");
        assert!(now.ends_with('Z') && now.as_bytes()[19] == b'.', "{now}");
        assert!(iso(60_000) > now);
    }

    #[test]
    fn a_work_claim_is_a_token_and_a_version() {
        assert_eq!(work_claim("abc/3").unwrap(), ("abc".to_string(), 3));
        assert!(work_claim("/3").is_err());
        assert!(work_claim("abc").is_err());
    }
}
