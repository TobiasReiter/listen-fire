//! The run host's backend over Postgres: the `@lf/postgres-store` core
//! module. Its tables live in a schema of its own, `lf`, which its setup
//! creates and migrates (`lf connect @lf/postgres-store`, src/core.rs);
//! nothing of the hosted product's schema is read or written. The tables and
//! statements keep the hosted backend's shapes and meaning
//! (apps/api/src/services/movement_engine/run_host_store.ts,
//! callback_store.ts and work/store.ts), so the contract suite holds the two
//! to the same cases:
//!
//!   parks         lf.parked_run
//!   joins         lf.join_pending + join_branch_export
//!   correlations  lf.adapter_await
//!   leases        the lease columns of lf.trigger_run
//!   work          lf.work
//!   sources       lf.park_library_source
//!   callbacks     lf.callback
//!   pull cursors  lf.inbound_checkpoint
//!   receipts      lf.event_receipt
//!   lf's runs     lf.trigger_run (below)
//!
//! Held to the hosted backend's meaning by the run host's contract suite
//! (`lf --contract-store postgres://…`). Leases and expiry are judged
//! by the database's clock, as the hosted backend judges them.
//!
//! One store is one tenant's: lf's runs, and the work rows it enqueues and
//! claims, are its tenant's only, so a `drain` worker never claims another
//! tenant's work.
//!
//! lf's run record on a `trigger_run` row: `trigger_id` is the listen's
//! pipeline (`listen:<file>:<movement>`), `trigger_payload` holds the file,
//! the movement and the run's facts (their JSON text verbatim, so a resume
//! reads exactly what the firing wrote), `nodes_written` its writes and
//! `failure_reason` its error. A completed run is `success`, as the hosted
//! product names it; lf reads it back as `completed`. The trace is kept
//! where the hosted product keeps it: a movement step per segment on
//! `steps`, its entries at `diagnostics.trace`.
//!
//! Blocking, as the SQLite store is: the connection lives on its own thread
//! with its own runtime, and each call waits for its answer.

use std::future::Future;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};

use tokio_postgres::types::ToSql;
use tokio_postgres::{Client, Row};

use crate::backend::{CallbackClaim, CallbackRecord, MintCallback, RunHostStore};
use crate::json::Js;
use crate::obj;
use crate::store::{BranchExport, ClaimDue, ClaimedWork, CorrelatedAwait, LeafRow, Result, RunRow, StoreError, WORK_KINDS};

type Params<'a> = [&'a (dyn ToSql + Sync)];

/// An instant as `Date.toISOString` writes it, by the database's clock.
macro_rules! iso {
    ($column:literal) => {
        concat!("to_char(", $column, " at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
    };
}

/// The run is still leased under the token (`leaseTokenIs`): compared as
/// text, so a token that is not a uuid holds nothing rather than failing.
const LEASED_TO: &str = "lease_token::text = ";

/// The work row's version (`FIRST_VERSION` / `nextVersion`): millisecond-
/// exact, strictly increasing however close two writes land.
const NEXT_VERSION_OF_WORK: &str = "greatest(date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', work.updated_at) + interval '1 millisecond')";
const NEXT_VERSION_OF_W: &str = "greatest(date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', w.updated_at) + interval '1 millisecond')";

/// `hosted completed` is `success`; every other status lf writes is the same word.
fn hosted_status(status: &str) -> &str {
    if status == "completed" { "success" } else { status }
}

fn lf_status(status: String) -> String {
    if status == "success" { "completed".into() } else { status }
}

fn failed(error: tokio_postgres::Error) -> StoreError {
    StoreError::Backend(match error.as_db_error() {
        Some(db) => format!("postgres: {}", db.message()),
        // The cause too: a refused certificate says why only there.
        None => match std::error::Error::source(&error) {
            Some(cause) => format!("postgres: {error}: {cause}"),
            None => format!("postgres: {error}"),
        },
    })
}

fn parse_text(text: &str) -> Result<Js> {
    Js::parse(text.as_bytes()).map_err(|e| StoreError::Invalid(format!("a stored value is not JSON: {e}")))
}

/// Polls one future to its end on this thread. The client's futures only
/// wait on channels its connection thread answers, so nothing here needs
/// this thread's runtime.
fn block_on<F: Future>(future: F) -> F::Output {
    struct Unpark(std::thread::Thread);
    impl Wake for Unpark {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = Waker::from(Arc::new(Unpark(std::thread::current())));
    let mut cx = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
        std::thread::park();
    }
}

/// The store's own schema, in order. Each runs once, in its own
/// transaction, under an advisory lock so two setups never race; the
/// applied ones are recorded in `lf.schema_migration`.
const MIGRATIONS: &[(i32, &str)] = &[(1, include_str!("pg_store_schema_1.sql")), (2, include_str!("pg_store_schema_2.sql"))];

/// The advisory lock the migrations run under: "lf-store" as a number.
const MIGRATION_LOCK: i64 = 0x6c66_2d73_746f_7265;

const CALLBACK_COLUMNS: &str = concat!(
    "id, team_id::text, run_id::text, address, params::text, state::text, calls::text, single_use, ",
    iso!("expires_at"),
    ", status"
);

fn callback_of(row: &Row) -> Result<CallbackRecord> {
    Ok(CallbackRecord {
        id: row.get(0),
        team_id: row.get(1),
        run_id: row.get(2),
        address: row.get(3),
        params: parse_text(row.get(4))?,
        state: parse_text(row.get(5))?,
        calls: parse_text(row.get(6))?,
        single_use: row.get(7),
        expires_at: row.get(8),
        status: row.get(9),
    })
}

const RUN_COLUMNS: &str = concat!(
    "id::text, trigger_payload->>'file', trigger_payload->>'movement', status, ",
    iso!("started_at"),
    ", trigger_payload->>'facts', nodes_written::int8, failure_reason"
);

fn run_of(row: &Row) -> Result<RunRow> {
    let id: String = row.get(0);
    let lf_field = |i: usize, name: &str| -> Result<String> {
        row.get::<_, Option<String>>(i).ok_or_else(|| StoreError::Invalid(format!("run {id} is not one of lf's runs (its trigger_payload has no {name})")))
    };
    let status = lf_status(row.get(3));
    let failure: Option<String> = row.get(7);
    let outcome = if status == "failed" {
        Js::Obj(obj! { "error" => Js::str(failure.unwrap_or_default()) })
    } else {
        Js::Obj(obj! { "writes" => Js::Num(row.get::<_, i64>(6).into()) })
    };
    Ok(RunRow {
        file: lf_field(1, "file")?,
        movement: lf_field(2, "movement")?,
        input: lf_field(5, "facts")?,
        started_at: row.get(4),
        outcome: Some(outcome.to_json()),
        status,
        id,
    })
}

pub struct PgStore {
    client: Client,
    tenant: String,
    /// Who holds a lease this process took: informational (the token fences).
    owner: String,
}

impl PgStore {
    /// Connect to a store whose schema is set up, the connection served from
    /// its own thread until the store drops.
    pub fn connect(url: &str, tenant: &str) -> Result<PgStore> {
        let store = PgStore::connect_unchecked(url, tenant)?;
        store.require_schema()?;
        Ok(store)
    }

    fn connect_unchecked(url: &str, tenant: &str) -> Result<PgStore> {
        let (sent, connected) = std::sync::mpsc::channel();
        let url = url.to_string();
        std::thread::Builder::new()
            .name("lf postgres".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                    Ok(runtime) => runtime,
                    Err(e) => return drop(sent.send(Err(StoreError::Backend(format!("no runtime for the connection: {e}"))))),
                };
                runtime.block_on(async move {
                    let (config, tls) = match crate::pg_tls::config_of(&url) {
                        Ok(read) => read,
                        Err(message) => return drop(sent.send(Err(StoreError::Backend(message)))),
                    };
                    match config.connect(tls).await {
                        Ok((client, connection)) => {
                            if sent.send(Ok(client)).is_ok() {
                                // Ends when the client drops (or the server goes).
                                let _ = connection.await;
                            }
                        }
                        Err(error) => drop(sent.send(Err(failed(error)))),
                    }
                });
            })
            .map_err(|e| StoreError::Backend(format!("no thread for the connection: {e}")))?;
        let client = connected.recv().map_err(|_| StoreError::Backend("the connection thread ended before it connected".into()))??;
        Ok(PgStore {
            client,
            tenant: tenant.to_string(),
            owner: format!("lf:{}:{}", std::process::id(), &uuid::Uuid::new_v4().to_string()[..8]),
        })
    }

    /// The schema is the store's own, created by its setup: refused loudly
    /// when it is missing or behind this lf.
    fn require_schema(&self) -> Result<()> {
        let latest = MIGRATIONS.last().map(|(v, _)| *v).unwrap_or(0);
        let present = self.query_opt("select 1 from information_schema.tables where table_schema = 'lf' and table_name = 'schema_migration'", &[])?.is_some();
        let applied: i32 = if present { self.query_opt("select coalesce(max(version), 0) from lf.schema_migration", &[])?.map(|r| r.get(0)).unwrap_or(0) } else { 0 };
        if applied >= latest {
            return Ok(());
        }
        Err(StoreError::Backend(format!(
            "this database's lf schema is {}: set the store up with `lf connect @lf/postgres-store` (it creates and migrates the schema)",
            if applied == 0 { "missing".to_string() } else { format!("at version {applied}, this lf needs {latest}") }
        )))
    }

    /// The store's setup: create the `lf` schema and apply every migration
    /// not yet applied. Idempotent; safe to run from two places at once.
    pub fn migrate(url: &str) -> Result<Vec<i32>> {
        let store = PgStore::connect_unchecked(url, crate::backend::POSTGRES_TENANT)?;
        let mut applied_now = Vec::new();
        block_on(store.client.batch_execute(&format!("select pg_advisory_lock({MIGRATION_LOCK})"))).map_err(failed)?;
        let outcome = (|| -> Result<()> {
            store.execute("create schema if not exists lf", &[])?;
            store.execute("create table if not exists lf.schema_migration (version integer primary key, applied_at timestamptz not null default now())", &[])?;
            let done: Vec<i32> = store.query("select version from lf.schema_migration", &[])?.iter().map(|r| r.get(0)).collect();
            for (version, sql) in MIGRATIONS {
                if done.contains(version) {
                    continue;
                }
                store.transaction(|| {
                    block_on(store.client.batch_execute(sql)).map_err(failed)?;
                    store.execute("insert into lf.schema_migration (version) values ($1)", &[version])?;
                    Ok(())
                })?;
                applied_now.push(*version);
            }
            Ok(())
        })();
        let _ = block_on(store.client.batch_execute(&format!("select pg_advisory_unlock({MIGRATION_LOCK})")));
        outcome.map(|()| applied_now)
    }

    fn query(&self, sql: &str, params: &Params<'_>) -> Result<Vec<Row>> {
        block_on(self.client.query(sql, params)).map_err(failed)
    }

    fn execute(&self, sql: &str, params: &Params<'_>) -> Result<u64> {
        block_on(self.client.execute(sql, params)).map_err(failed)
    }

    fn query_opt(&self, sql: &str, params: &Params<'_>) -> Result<Option<Row>> {
        Ok(self.query(sql, params)?.into_iter().next())
    }

    /// One transaction around `body`, rolled back when it fails. Calls are
    /// one at a time, so nothing else runs on the connection meanwhile.
    fn transaction<T>(&self, body: impl FnOnce() -> Result<T>) -> Result<T> {
        block_on(self.client.batch_execute("begin")).map_err(failed)?;
        match body() {
            Ok(value) => {
                block_on(self.client.batch_execute("commit")).map_err(failed)?;
                Ok(value)
            }
            Err(error) => {
                let _ = block_on(self.client.batch_execute("rollback"));
                Err(error)
            }
        }
    }

    /// Why a fenced write wrote nothing (`notWritten`).
    fn not_written(run_id: &str, fence: Option<&str>) -> StoreError {
        match fence {
            Some(_) => StoreError::LeaseLost { run_id: run_id.to_string() },
            None => StoreError::Invalid(format!("run {run_id} has no trigger_run row to park on")),
        }
    }

    fn enqueue_row(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>, team_id: &str) -> Result<()> {
        if !WORK_KINDS.contains(&kind) {
            return Err(StoreError::Invalid(format!("not a work kind: {kind}")));
        }
        let payload = payload.to_json();
        self.execute(
            &format!(
                "insert into lf.work (kind, key, team_id, payload, due_at, updated_at)
                 values ($1::text, $2::text, $3::text::uuid, $4::text::jsonb, coalesce($5::text::timestamptz, now()), date_trunc('milliseconds', clock_timestamp()))
                 on conflict (key) do update set
                   due_at = case when work.lease_until > now() then excluded.due_at else least(work.due_at, excluded.due_at) end,
                   payload = excluded.payload,
                   team_id = coalesce(excluded.team_id, work.team_id),
                   updated_at = {NEXT_VERSION_OF_WORK}"
            ),
            &[&kind, &key, &team_id, &payload, &due_at],
        )?;
        Ok(())
    }
}

/// A work claim's handle, as the hosted backend writes it: the lease taken
/// and the row version it saw.
fn work_claim(claim: &str) -> Result<(String, String)> {
    let not = || StoreError::Invalid(format!("not a work claim: {claim}"));
    let parsed = Js::parse(claim.as_bytes()).map_err(|_| not())?;
    let token = parsed.get("leaseToken").and_then(Js::as_str).ok_or_else(not)?;
    let version = parsed.get("claimedUpdatedAt").and_then(Js::as_str).ok_or_else(not)?;
    Ok((token.to_string(), version.to_string()))
}

impl RunHostStore for PgStore {
    fn tenant(&self) -> &str {
        &self.tenant
    }

    // ── lf's run records ────────────────────────────────────────────────────

    fn start_run(&self, id: &str, file: &str, movement: &str, started_at: &str, input: &str) -> Result<()> {
        let trigger = format!("listen:{file}:{movement}");
        self.execute(
            "insert into lf.trigger_run (id, team_id, trigger_id, trigger_type, status, started_at, trigger_payload)
             values ($1::text::uuid, $2::text::uuid, $3::text, 'webhook', 'running', $4::text::timestamptz,
                     jsonb_build_object('file', $5::text, 'movement', $6::text, 'facts', $7::text))",
            &[&id, &self.tenant, &trigger, &started_at, &file, &movement, &input],
        )?;
        Ok(())
    }

    fn settle_run(&self, id: &str, status: &str, outcome: &Js, at: &str) -> Result<()> {
        let status = hosted_status(status);
        let writes = outcome.get("writes").and_then(|w| if let Js::Num(n) = w { n.as_i64() } else { None });
        let error = outcome.get("error").and_then(Js::as_str);
        let ended = status == "success" || status == "failed";
        self.transaction(|| {
            self.execute(
                "update lf.trigger_run set
                   status = $2::text,
                   nodes_written = coalesce($3::int8, nodes_written),
                   failure_reason = case when $2::text = 'failed' then $4::text else failure_reason end,
                   completed_at = case when $2::text = 'success' then $5::text::timestamptz else completed_at end,
                   failed_at = case when $2::text = 'failed' then $5::text::timestamptz else failed_at end
                 where id = $1::text::uuid",
                &[&id, &status, &writes, &error, &at],
            )?;
            if ended {
                self.revoke_run_callbacks(id)?;
            }
            Ok(())
        })
    }

    fn mark_parked(&self, id: &str) -> Result<()> {
        self.execute("update lf.trigger_run set status = 'parked' where id = $1::text::uuid and status in ('running', 'parked')", &[&id])?;
        Ok(())
    }

    fn mark_failed(&self, id: &str, message: &str) -> Result<()> {
        self.transaction(|| {
            self.execute(
                "update lf.trigger_run set status = 'failed', failed_at = now(), failure_reason = $2::text
                 where id = $1::text::uuid and status in ('running', 'parked')",
                &[&id, &message],
            )?;
            self.revoke_run_callbacks(id)
        })
    }

    fn cancel_request(&self, id: &str) -> Result<Option<Option<String>>> {
        let row = self.query_opt("select cancel_requested_at is not null, cancel_reason from lf.trigger_run where id = $1::text::uuid", &[&id])?;
        Ok(row.and_then(|r| r.get::<_, bool>(0).then(|| r.get(1))))
    }

    fn request_cancel(&self, id: &str, reason: Option<&str>) -> Result<()> {
        self.execute("update lf.trigger_run set cancel_requested_at = now(), cancel_reason = $2::text where id = $1::text::uuid", &[&id, &reason])?;
        Ok(())
    }

    fn run(&self, id: &str) -> Result<Option<RunRow>> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Ok(None);
        }
        self.query_opt(&format!("select {RUN_COLUMNS} from lf.trigger_run where id = $1::text::uuid and team_id = $2::text::uuid"), &[&id, &self.tenant])?
            .map(|r| run_of(&r))
            .transpose()
    }

    fn runs(&self, limit: i64) -> Result<Vec<RunRow>> {
        self.query(
            &format!("select {RUN_COLUMNS} from lf.trigger_run where team_id = $1::text::uuid and trigger_payload ? 'facts' order by started_at desc limit $2::int8"),
            &[&self.tenant, &limit],
        )?
        .iter()
        .map(run_of)
        .collect()
    }

    /// Where the hosted product keeps a run's trace: each segment's in its
    /// own movement step on `trigger_run.steps`, at `diagnostics.trace`
    /// (trigger_run.ts `movementStepDiagnostics`), so the hosted inspection
    /// reads lf's runs as its own. A segment's later entries extend its step,
    /// found by the `segmentId` lf keeps on it.
    fn append_trace(&self, run_id: &str, segment_id: &str, entries: &[Js]) -> Result<()> {
        let entries = Js::Arr(entries.to_vec()).to_json();
        self.execute(
            "update lf.trigger_run set steps = case
               when steps -> -1 ->> 'segmentId' = $2::text
                 then jsonb_set(steps, array[(jsonb_array_length(steps) - 1)::text, 'diagnostics', 'trace'],
                                coalesce(steps -> -1 -> 'diagnostics' -> 'trace', '[]'::jsonb) || $3::text::jsonb)
               else steps || jsonb_build_array(jsonb_build_object(
                 'tgId', trigger_id, 'tgName', null, 'sourceAdapterType', null, 'targetAdapterType', null,
                 'status', 'success', 'appliedActionPlans', '[]'::jsonb, 'errors', '[]'::jsonb, 'engine', 'interpreter',
                 'diagnostics', jsonb_build_object('trace', $3::text::jsonb), 'segmentId', $2::text))
             end
             where id = $1::text::uuid and team_id = $4::text::uuid",
            &[&run_id, &segment_id, &entries, &self.tenant],
        )?;
        Ok(())
    }

    /// The hosted product's run total: `diagnostics.costMicrodollars`
    /// (trigger_run.ts `runSpentMicrodollars`), less the cap's baseline.
    fn run_spent(&self, run_id: &str) -> Result<f64> {
        let row = self.query_opt(
            "select (coalesce((diagnostics ->> 'costMicrodollars')::float8, (diagnostics ->> 'costUsd')::float8 * 1000000, 0)
                     - cost_cap_baseline_microdollars)::float8
             from lf.trigger_run where id = $1::text::uuid and team_id = $2::text::uuid",
            &[&run_id, &self.tenant],
        )?;
        Ok(row.map_or(0.0, |r| r.get(0)))
    }

    fn add_run_spend(&self, run_id: &str, microdollars: f64) -> Result<()> {
        self.execute(
            "update lf.trigger_run set diagnostics = diagnostics
               || jsonb_build_object('costMicrodollars', coalesce((diagnostics ->> 'costMicrodollars')::float8, 0) + $2::float8)
               || jsonb_build_object('costUsd', (coalesce((diagnostics ->> 'costMicrodollars')::float8, 0) + $2::float8) / 1000000)
             where id = $1::text::uuid and team_id = $3::text::uuid",
            &[&run_id, &microdollars, &self.tenant],
        )?;
        Ok(())
    }

    /// `cost_cap_baseline_microdollars`, as limit_resume.ts sets it.
    fn reset_spend_baseline(&self, run_id: &str) -> Result<()> {
        self.execute(
            "update lf.trigger_run set cost_cap_baseline_microdollars = round(coalesce((diagnostics ->> 'costMicrodollars')::float8, 0))::int8
             where id = $1::text::uuid and team_id = $2::text::uuid",
            &[&run_id, &self.tenant],
        )?;
        Ok(())
    }

    fn trace_len(&self, run_id: &str) -> Result<i64> {
        let row = self.query_opt(
            "select coalesce(sum(jsonb_array_length(step -> 'diagnostics' -> 'trace')), 0)::int8
             from lf.trigger_run r, jsonb_array_elements(r.steps) as step
             where r.id = $1::text::uuid and r.team_id = $2::text::uuid and jsonb_typeof(step -> 'diagnostics' -> 'trace') = 'array'",
            &[&run_id, &self.tenant],
        )?;
        Ok(row.map_or(0, |r| r.get(0)))
    }

    fn trace_entries(&self, run_id: &str) -> Result<Option<Vec<Js>>> {
        let rows = self.query(
            "select t.entry::text
             from lf.trigger_run r,
                  jsonb_array_elements(r.steps) with ordinality as s(step, i),
                  jsonb_array_elements(case when jsonb_typeof(s.step -> 'diagnostics' -> 'trace') = 'array' then s.step -> 'diagnostics' -> 'trace' else '[]'::jsonb end)
                    with ordinality as t(entry, j)
             where r.id = $1::text::uuid and r.team_id = $2::text::uuid
             order by s.i, t.j",
            &[&run_id, &self.tenant],
        )?;
        rows.iter().map(|r| Js::parse(r.get::<_, String>(0).as_bytes()).map_err(StoreError::Backend)).collect::<Result<Vec<_>>>().map(Some)
    }

    // ── Parks ───────────────────────────────────────────────────────────────

    fn put_leaf(&self, run_id: &str, address: &str, reason: &str, wake_at: Option<&str>, state: &Js, fence: Option<&str>) -> Result<()> {
        let state = state.to_json();
        let written = self.query_opt(
            &format!(
                "insert into lf.parked_run (run_id, address, status, park_reason, wake_at, state)
                 select r.id, $2::text, 'parked', $3::text, $4::text::timestamptz, $5::text::jsonb
                 from lf.trigger_run r where r.id = $1::text::uuid and ($6::text is null or r.{LEASED_TO}$6::text)
                 on conflict (run_id, address) do update set
                   state = excluded.state, status = 'parked', park_reason = excluded.park_reason, wake_at = excluded.wake_at
                 returning id"
            ),
            &[&run_id, &address, &reason, &wake_at, &state, &fence],
        )?;
        if written.is_none() {
            return Err(Self::not_written(run_id, fence));
        }
        Ok(())
    }

    fn claim_leaf(&self, run_id: &str, address: &str, reason: Option<&str>) -> Result<Option<(String, Js)>> {
        let row = self.query_opt(
            "update lf.parked_run set status = 'resuming', updated_at = now()
             where run_id = $1::text::uuid and address = $2::text and status = 'parked' and ($3::text is null or park_reason = $3::text)
             returning park_reason, coalesce(state, 'null'::jsonb)::text",
            &[&run_id, &address, &reason],
        )?;
        row.map(|r| Ok((r.get(0), parse_text(r.get(1))?))).transpose()
    }

    fn finish_leaf(&self, run_id: &str, address: &str, fence: Option<&str>) -> Result<()> {
        self.execute(
            &format!(
                "delete from lf.parked_run p
                 where p.run_id = $1::text::uuid and p.address = $2::text and p.status = 'resuming'
                   and ($3::text is null or exists (select 1 from lf.trigger_run r where r.id = p.run_id and r.{LEASED_TO}$3::text))"
            ),
            &[&run_id, &address, &fence],
        )?;
        Ok(())
    }

    fn leaves(&self, run_id: &str, parked_only: bool, reason: Option<&str>, due_by: Option<&str>) -> Result<Vec<LeafRow>> {
        let rows = self.query(
            concat!(
                "select address, park_reason, status, ",
                iso!("wake_at"),
                " from lf.parked_run
                 where run_id = $1::text::uuid and (not $2::bool or status = 'parked') and ($3::text is null or park_reason = $3::text)
                   and ($4::text is null or (park_reason = 'timer' and wake_at <= $4::text::timestamptz))
                 order by created_at, address"
            ),
            &[&run_id, &parked_only, &reason, &due_by],
        )?;
        Ok(rows.iter().map(|r| LeafRow { address: r.get(0), reason: r.get(1), status: r.get(2), wake_at: r.get(3) }).collect())
    }

    fn delete_leaves(&self, run_id: &str, addresses: &[String]) -> Result<()> {
        if addresses.is_empty() {
            return Ok(());
        }
        self.execute("delete from lf.parked_run where run_id = $1::text::uuid and address = any($2::text[])", &[&run_id, &addresses])?;
        Ok(())
    }

    // ── Joins ───────────────────────────────────────────────────────────────

    fn record_join(&self, run_id: &str, frame_address: &str, pending: i64, fence: Option<&str>) -> Result<()> {
        let recorded = self.query_opt(
            &format!(
                "insert into lf.join_pending (run_id, frame_address, pending)
                 select r.id, $2::text, $3::int8 from lf.trigger_run r
                 where r.id = $1::text::uuid and ($4::text is null or r.{LEASED_TO}$4::text)
                 on conflict (run_id, frame_address) do update set pending = excluded.pending, updated_at = now()
                 returning run_id"
            ),
            &[&run_id, &frame_address, &pending, &fence],
        )?;
        if recorded.is_none() {
            return Err(Self::not_written(run_id, fence));
        }
        Ok(())
    }

    /// The mark-closed decrement (`decrementJoin`): each branch claims its
    /// one decrement against its own export row, and the closer's address
    /// is kept on the frame, so a retry of the closer closes again and a
    /// sibling never does.
    fn decrement_join(&self, run_id: &str, frame_address: &str, branch_address: &str, leaf_address: &str) -> Result<bool> {
        self.transaction(|| {
            let claimed = self.query_opt(
                "update lf.join_branch_export set decremented = true
                 where run_id = $1::text::uuid and frame_address = $2::text and branch_address = $3::text and decremented = false
                 returning 1",
                &[&run_id, &frame_address, &branch_address],
            )?;
            if claimed.is_some() {
                let updated = self.query_opt(
                    "update lf.join_pending set pending = pending - 1, updated_at = now()
                     where run_id = $1::text::uuid and frame_address = $2::text and pending > 0
                     returning pending::int8",
                    &[&run_id, &frame_address],
                )?;
                if let Some(updated) = updated {
                    if updated.get::<_, i64>(0) > 0 {
                        return Ok(false);
                    }
                    self.execute(
                        "update lf.join_pending set closed_by_address = $3::text where run_id = $1::text::uuid and frame_address = $2::text",
                        &[&run_id, &frame_address, &leaf_address],
                    )?;
                    return Ok(true);
                }
            }
            let row = self.query_opt(
                "select closed_by_address from lf.join_pending where run_id = $1::text::uuid and frame_address = $2::text",
                &[&run_id, &frame_address],
            )?;
            Ok(row.and_then(|r| r.get::<_, Option<String>>(0)).as_deref() == Some(leaf_address))
        })
    }

    fn persist_branch_export(&self, run_id: &str, frame_address: &str, branch_address: &str, branch_index: i64, exports: &Js) -> Result<()> {
        // The conflict update never touches `decremented`: a re-persist would
        // otherwise reset the branch's decrement claim.
        let exports = exports.to_json();
        self.execute(
            "insert into lf.join_branch_export (run_id, frame_address, branch_address, branch_index, exports)
             values ($1::text::uuid, $2::text, $3::text, $4::int8, $5::text::jsonb)
             on conflict (run_id, frame_address, branch_address) do update set
               exports = excluded.exports, branch_index = excluded.branch_index, updated_at = now()",
            &[&run_id, &frame_address, &branch_address, &branch_index, &exports],
        )?;
        Ok(())
    }

    fn collect_branch_exports(&self, run_id: &str, frame_address: &str) -> Result<Vec<BranchExport>> {
        self.query(
            "select branch_address, branch_index::int8, exports::text from lf.join_branch_export
             where run_id = $1::text::uuid and frame_address = $2::text order by branch_index",
            &[&run_id, &frame_address],
        )?
        .iter()
        .map(|r| Ok(BranchExport { branch_address: r.get(0), branch_index: r.get(1), exports: parse_text(r.get(2))? }))
        .collect()
    }

    fn has_pending_joins(&self, run_id: &str) -> Result<bool> {
        Ok(self.query_opt("select 1 from lf.join_pending where run_id = $1::text::uuid and pending > 0 limit 1", &[&run_id])?.is_some())
    }

    fn frames(&self, run_id: &str) -> Result<Vec<String>> {
        Ok(self
            .query("select frame_address from lf.join_pending where run_id = $1::text::uuid order by frame_address", &[&run_id])?
            .iter()
            .map(|r| r.get(0))
            .collect())
    }

    fn delete_frames(&self, run_id: &str, frame_addresses: &[String]) -> Result<()> {
        if frame_addresses.is_empty() {
            return Ok(());
        }
        self.transaction(|| {
            self.execute("delete from lf.join_pending where run_id = $1::text::uuid and frame_address = any($2::text[])", &[&run_id, &frame_addresses])?;
            self.execute("delete from lf.join_branch_export where run_id = $1::text::uuid and frame_address = any($2::text[])", &[&run_id, &frame_addresses])?;
            Ok(())
        })
    }

    // ── Await correlations ──────────────────────────────────────────────────

    fn correlate(&self, run_id: &str, team_id: &str, address: &str, adapter_type: &str, correlation_key: &str) -> Result<()> {
        self.execute(
            "insert into lf.adapter_await (adapter_type, correlation_key, run_id, team_id, address)
             values ($1::text, $2::text, $3::text::uuid, $4::text::uuid, $5::text)
             on conflict (run_id, address) do update set
               adapter_type = excluded.adapter_type, correlation_key = excluded.correlation_key, updated_at = now()",
            &[&adapter_type, &correlation_key, &run_id, &team_id, &address],
        )?;
        Ok(())
    }

    fn correlated(&self, adapter_type: &str, team_id: &str, correlation_key: &str) -> Result<Vec<CorrelatedAwait>> {
        Ok(self
            .query(
                "select run_id::text, team_id::text, address from lf.adapter_await
                 where adapter_type = $1::text and team_id = $2::text::uuid and correlation_key = $3::text order by created_at",
                &[&adapter_type, &team_id, &correlation_key],
            )?
            .iter()
            .map(|r| CorrelatedAwait { run_id: r.get(0), team_id: r.get(1), address: r.get(2) })
            .collect())
    }

    fn of_run(&self, run_id: &str, adapter_type: &str) -> Result<Vec<(CorrelatedAwait, String)>> {
        Ok(self
            .query(
                "select run_id::text, team_id::text, address, correlation_key from lf.adapter_await
                 where run_id = $1::text::uuid and adapter_type = $2::text order by address",
                &[&run_id, &adapter_type],
            )?
            .iter()
            .map(|r| (CorrelatedAwait { run_id: r.get(0), team_id: r.get(1), address: r.get(2) }, r.get(3)))
            .collect())
    }

    fn drop_correlation(&self, run_id: &str, address: &str) -> Result<()> {
        self.execute("delete from lf.adapter_await where run_id = $1::text::uuid and address = $2::text", &[&run_id, &address])?;
        Ok(())
    }

    fn drop_run_correlations(&self, run_id: &str) -> Result<()> {
        self.execute("delete from lf.adapter_await where run_id = $1::text::uuid", &[&run_id])?;
        Ok(())
    }

    // ── The run lease ───────────────────────────────────────────────────────

    /// One statement: taken only while free or lapsed, and in the same
    /// statement every leaf a dead holder left claimed goes back to parked.
    fn claim_lease(&self, run_id: &str, ttl_ms: i64) -> Result<Option<String>> {
        let token = uuid::Uuid::new_v4().to_string();
        let claimed = self.query_opt(
            "with claimed as (
               update lf.trigger_run
               set lease_owner = $2::text, lease_until = now() + $3::int8 * interval '1 millisecond', lease_token = $4::text::uuid
               where id = $1::text::uuid and (lease_until is null or lease_until < now())
               returning id
             ), returned as (
               update lf.parked_run set status = 'parked'
               where run_id in (select id from claimed) and status = 'resuming'
             )
             select id from claimed",
            &[&run_id, &self.owner, &ttl_ms, &token],
        )?;
        Ok(claimed.map(|_| token))
    }

    /// Also the run's heartbeat. A lapsed lease is not renewed: it is free.
    fn renew_lease(&self, run_id: &str, token: &str, ttl_ms: i64) -> Result<bool> {
        let renewed = self.execute(
            &format!(
                "update lf.trigger_run set lease_until = now() + $3::int8 * interval '1 millisecond', last_heartbeat_at = now()
                 where id = $1::text::uuid and {LEASED_TO}$2::text and lease_until > now()"
            ),
            &[&run_id, &token, &ttl_ms],
        )?;
        Ok(renewed > 0)
    }

    fn release_lease(&self, run_id: &str, token: &str) -> Result<()> {
        self.execute(
            &format!("update lf.trigger_run set lease_owner = null, lease_until = null, lease_token = null where id = $1::text::uuid and {LEASED_TO}$2::text"),
            &[&run_id, &token],
        )?;
        Ok(())
    }

    fn drop_run_state(&self, run_id: &str, fence: Option<&str>) -> Result<bool> {
        self.transaction(|| {
            if let Some(fence) = fence {
                // Held for the transaction: the lease cannot change hands
                // between the check and the deletes.
                let held = self.query_opt(
                    &format!("select id from lf.trigger_run where id = $1::text::uuid and {LEASED_TO}$2::text for update"),
                    &[&run_id, &fence],
                )?;
                if held.is_none() {
                    return Ok(false);
                }
            }
            for table in ["parked_run", "join_pending", "join_branch_export"] {
                self.execute(&format!("delete from lf.{table} where run_id = $1::text::uuid"), &[&run_id])?;
            }
            Ok(true)
        })
    }

    // ── The work queue ──────────────────────────────────────────────────────

    fn enqueue(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>, team_id: Option<&str>) -> Result<()> {
        self.enqueue_row(kind, key, payload, due_at, team_id.unwrap_or(&self.tenant))
    }

    /// One statement, so two drainers cannot race: SKIP LOCKED hands each a
    /// disjoint set, and MATERIALIZED fixes the selection before the update.
    fn claim_due(&self, claim: &ClaimDue<'_>) -> Result<Vec<ClaimedWork>> {
        let kinds = claim.kinds()?;
        let (due_by, limit, lease_ms) = (claim.due_by, claim.limit, claim.lease_ms);
        let rows = self.query(
            &format!(
                "with c as materialized (
                   select id from lf.work
                   where due_at <= coalesce($1::text::timestamptz, now()) and (lease_until is null or lease_until < now())
                     and kind = any($2::text[]) and team_id = $3::text::uuid
                   order by due_at
                   limit $4::int8
                   for update skip locked
                 )
                 update lf.work w
                 set lease_owner = $5::text, lease_until = now() + $6::int8 * interval '1 millisecond', lease_token = gen_random_uuid(),
                     attempts = attempts + 1, updated_at = {NEXT_VERSION_OF_W}
                 from c where w.id = c.id
                 returning w.id::text, w.kind, w.key, w.payload::text, w.lease_token::text, {}",
                iso!("w.updated_at")
            ),
            &[&due_by, &kinds, &self.tenant, &limit, &self.owner, &lease_ms],
        )?;
        rows.iter()
            .map(|r| {
                let claim = Js::Obj(obj! { "leaseToken" => Js::Str(r.get(4)), "claimedUpdatedAt" => Js::Str(r.get(5)) });
                Ok(ClaimedWork { id: r.get(0), kind: r.get(1), key: r.get(2), payload: parse_text(r.get(3))?, claim: claim.to_json() })
            })
            .collect()
    }

    /// Deleted unless re-armed since the claim (its version moved): then
    /// its lease clears and it runs again at its due time.
    fn complete(&self, id: &str, claim: &str) -> Result<()> {
        let (token, version) = work_claim(claim)?;
        let held = "id = $1::text::uuid and lease_token::text = $2::text";
        self.execute(
            &format!("delete from lf.work where {held} and interval_ms is null and updated_at = $3::text::timestamptz"),
            &[&id, &token, &version],
        )?;
        self.execute(
            &format!(
                "update lf.work set lease_owner = null, lease_until = null, lease_token = null, attempts = 0, deferrals = 0,
                   due_at = case when interval_ms is null then due_at else now() + interval_ms * interval '1 millisecond' end
                 where {held}"
            ),
            &[&id, &token],
        )?;
        Ok(())
    }

    /// Unleased for a retry at `due_at`, unless re-armed since the claim.
    fn release_work(&self, id: &str, claim: &str, due_at: Option<&str>) -> Result<()> {
        let (token, version) = work_claim(claim)?;
        self.execute(
            "update lf.work set lease_owner = null, lease_until = null, lease_token = null,
               due_at = case when updated_at = $3::text::timestamptz then coalesce($4::text::timestamptz, due_at) else due_at end
             where id = $1::text::uuid and lease_token::text = $2::text",
            &[&id, &token, &version, &due_at],
        )?;
        Ok(())
    }

    // ── Library sources ─────────────────────────────────────────────────────

    fn put_source(&self, team_id: &str, hash: &str, source: &str) -> Result<()> {
        self.execute(
            "insert into lf.park_library_source (team_id, hash, source) values ($1::text::uuid, $2::text, $3::text) on conflict (team_id, hash) do nothing",
            &[&team_id, &hash, &source],
        )?;
        Ok(())
    }

    fn get_source(&self, team_id: &str, hash: &str) -> Result<Option<String>> {
        Ok(self
            .query_opt("select source from lf.park_library_source where team_id = $1::text::uuid and hash = $2::text", &[&team_id, &hash])?
            .map(|r| r.get(0)))
    }

    // ── Callbacks ───────────────────────────────────────────────────────────

    fn mint_callback(&self, input: MintCallback<'_>) -> Result<String> {
        let id = crate::callbacks::new_callback_id()?;
        let (params, state) = (input.params.to_json(), input.state.to_json());
        self.execute(
            "insert into lf.callback (id, team_id, run_id, address, params, state, calls, single_use, expires_at, status)
             values ($1::text, $2::text::uuid, $3::text::uuid, $4::text, $5::text::jsonb, $6::text::jsonb, '[]'::jsonb, $7::bool, $8::text::timestamptz, 'live')",
            &[&id, &input.team_id, &input.run_id, &input.address, &params, &state, &input.single_use, &input.expires_at],
        )?;
        Ok(id)
    }

    fn callback(&self, id: &str) -> Result<Option<CallbackRecord>> {
        // The prefix guard keeps a foreign payload from ever reaching a query.
        if !id.starts_with("cb_") {
            return Ok(None);
        }
        self.query_opt(&format!("select {CALLBACK_COLUMNS} from lf.callback where id = $1::text"), &[&id])?.map(|r| callback_of(&r)).transpose()
    }

    /// The claim is one statement: single-use flips live → fired, a
    /// repeatable one appends, and its body's work row commits with it. One
    /// clock decides expiry and the call's instant: the database's.
    fn record_callback_call(&self, id: &str, values: &Js, body_due_at: &str) -> Result<CallbackClaim> {
        if !id.starts_with("cb_") {
            return Ok(CallbackClaim::NotFound);
        }
        let values = values.to_json();
        self.transaction(|| {
            let claimed = self.query_opt(
                &format!(
                    "update lf.callback set
                       status = case when single_use then 'fired' else status end,
                       fired_at = case when single_use then now() else fired_at end,
                       calls = calls || jsonb_build_array(jsonb_build_object('at', {}, 'values', $2::text::jsonb)),
                       updated_at = now()
                     where id = $1::text and status = 'live' and (expires_at is null or expires_at > now())
                     returning {CALLBACK_COLUMNS}",
                    iso!("now()")
                ),
                &[&id, &values],
            )?;
            if let Some(row) = claimed {
                let callback = callback_of(&row)?;
                let call_index = callback.calls.as_array().map_or(0, |calls| calls.len() as i64) - 1;
                if call_index < 0 {
                    return Err(StoreError::Invalid(format!("callback {id} recorded a call its ledger does not hold")));
                }
                // `callbackBodyWork`.
                let payload = Js::Obj(obj! {
                    "callbackId" => Js::str(id),
                    "teamId" => Js::str(&callback.team_id),
                    "callIndex" => Js::Num(call_index.into()),
                });
                self.enqueue_row("fire_callback", &format!("fire_callback:{id}:{call_index}"), &payload, Some(body_due_at), &callback.team_id)?;
                return Ok(CallbackClaim::Recorded { callback, call_index });
            }
            let Some(row) = self.query_opt(&format!("select {CALLBACK_COLUMNS}, expires_at <= now() from lf.callback where id = $1::text"), &[&id])? else {
                return Ok(CallbackClaim::NotFound);
            };
            let callback = callback_of(&row)?;
            // `callbackRefusal` for a new call: revoked or fired is closed; past its window, expired.
            let expired = row.get::<_, Option<bool>>(10) == Some(true);
            Ok(if callback.status == "live" && expired { CallbackClaim::Expired(callback) } else { CallbackClaim::Closed(callback) })
        })
    }

    fn mark_callback_body_started(&self, id: &str, call_index: i64, fence: Option<&str>) -> Result<bool> {
        let marked = self.execute(
            &format!(
                "update lf.callback c set
                   calls = jsonb_set(calls, array[$2::int8::text], (calls -> ($2::int8)::int4) || jsonb_build_object('bodyStartedAt', {})),
                   updated_at = now()
                 where c.id = $1::text
                   and ($3::text is null or exists (select 1 from lf.trigger_run r where r.id = c.run_id and r.{LEASED_TO}$3::text))",
                iso!("now()")
            ),
            &[&id, &call_index, &fence],
        )?;
        Ok(marked > 0)
    }

    fn landed_callbacks(&self, ids: &[String]) -> Result<Vec<String>> {
        let ids: Vec<String> = ids.iter().filter(|id| id.starts_with("cb_")).cloned().collect();
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let landed: Vec<String> = self
            .query(
                "select id from lf.callback
                 where id = any($1::text[]) and exists (select 1 from jsonb_array_elements(calls) as call where call ? 'bodyStartedAt')",
                &[&ids],
            )?
            .iter()
            .map(|r| r.get(0))
            .collect();
        Ok(ids.into_iter().filter(|id| landed.contains(id)).collect())
    }

    /// Only ever touches live rows: a fired single-use keeps its `fired`.
    fn revoke_run_callbacks(&self, run_id: &str) -> Result<()> {
        self.execute(
            "update lf.callback set status = 'revoked', revoked_at = now(), updated_at = now() where run_id = $1::text::uuid and status = 'live'",
            &[&run_id],
        )?;
        Ok(())
    }

    fn inbound_checkpoint(&self, subscription_id: &str) -> Result<Option<Js>> {
        let row = self.query_opt(
            "select checkpoint::text from lf.inbound_checkpoint where team_id = $1::text::uuid and subscription_id = $2::text",
            &[&self.tenant, &subscription_id],
        )?;
        row.map(|r| parse_text(r.get(0))).transpose()
    }
    fn save_inbound_checkpoint(&self, subscription_id: &str, checkpoint: &Js) -> Result<()> {
        let text = checkpoint.to_json();
        self.execute(
            "insert into lf.inbound_checkpoint (team_id, subscription_id, checkpoint) values ($1::text::uuid, $2::text, $3::text::jsonb)
             on conflict (team_id, subscription_id) do update set checkpoint = excluded.checkpoint, updated_at = now()",
            &[&self.tenant, &subscription_id, &text],
        )?;
        Ok(())
    }

    fn claim_event(&self, listen: &str, key: &str) -> Result<bool> {
        let inserted = self.execute(
            "insert into lf.event_receipt (team_id, listen, key) values ($1::text::uuid, $2::text, $3::text) on conflict do nothing",
            &[&self.tenant, &listen, &key],
        )?;
        Ok(inserted == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_completed_run_is_the_hosted_products_success() {
        assert_eq!(hosted_status("completed"), "success");
        assert_eq!(hosted_status("parked"), "parked");
        assert_eq!(lf_status("success".into()), "completed");
        assert_eq!(lf_status("failed".into()), "failed");
    }

    #[test]
    fn a_work_claim_is_the_hosted_backends_handle() {
        let (token, version) = work_claim(r#"{"leaseToken":"t","claimedUpdatedAt":"2026-10-17T00:00:00.000Z"}"#).unwrap();
        assert_eq!((token.as_str(), version.as_str()), ("t", "2026-10-17T00:00:00.000Z"));
        assert!(work_claim("t/3").is_err());
    }

    #[test]
    fn block_on_runs_a_future_to_its_end() {
        assert_eq!(block_on(async { 41 + 1 }), 42);
    }
}
