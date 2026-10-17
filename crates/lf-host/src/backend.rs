//! The run host's backend as one trait (movement-engine
//! `services/run_host/store.ts` `RunHostStore`, with lf's run records and
//! its callbacks beside it), so every command runs over whichever store it
//! was given: the TypeScript lf's SQLite state file (crate::store) or the
//! hosted product's Postgres tables (crate::pg_store).
//!
//! Which one is the store spec's: `--store <spec>`, else lf.yaml's `store:`,
//! else `.lf/state.db`. A spec that starts `postgres://` or `postgresql://`
//! is a Postgres connection; anything else is a SQLite file.
//!
//! Every method blocks until its backend answers, as rusqlite does. The
//! Postgres store serves the same blocking calls from its own connection
//! thread, so the rules over the store (crate::run_host) read alike over
//! both.

use std::path::{Path, PathBuf};

use crate::json::Js;
use crate::pg_store::PgStore;
use crate::project::{Project, ProjectStore};
use crate::store::{BranchExport, ClaimedWork, CorrelatedAwait, LeafRow, Result, RunRow, Store};

/// The tenant a SQLite state file's rows belong to (`LOCAL_TENANT`).
pub const SQLITE_TENANT: &str = "local";

/// The tenant lf's rows belong to in a Postgres store, unless `--team`
/// names another: the database's team ids are uuids, so the local tenant
/// is one too. Fixed, so every lf process pointed at one database (a
/// `run`, its door, the `drain` workers) shares one queue.
pub const POSTGRES_TENANT: &str = "6c66206c-6f63-4061-8c00-000000000001";

/// Where a command's run state is kept.
#[derive(Debug, Clone, PartialEq)]
pub enum StoreSpec {
    Sqlite(PathBuf),
    Postgres { url: String, tenant: String },
}

impl StoreSpec {
    /// `spec` read as a store; `team` the Postgres tenant (refused for SQLite,
    /// whose tenant is always the local one).
    pub fn parse(spec: &str, relative_to: &Path, team: Option<&str>) -> std::result::Result<StoreSpec, String> {
        if spec.starts_with("postgres://") || spec.starts_with("postgresql://") {
            let tenant = team.unwrap_or(POSTGRES_TENANT);
            if uuid::Uuid::parse_str(tenant).is_err() {
                return Err(format!("--team {tenant}: a Postgres store's team is a uuid"));
            }
            return Ok(StoreSpec::Postgres { url: spec.to_string(), tenant: tenant.to_string() });
        }
        if team.is_some() {
            return Err("--team names a Postgres store's tenant; a SQLite state file has one tenant".into());
        }
        Ok(StoreSpec::Sqlite(relative_to.join(spec)))
    }

    /// The store a command opens: `--store`, else lf.yaml's `store:`, else
    /// the project's state file.
    pub fn of_command(flag: Option<&str>, project_store: Option<&str>, root: &Path, lf_dir: &Path, team: Option<&str>) -> std::result::Result<StoreSpec, String> {
        match flag.or(project_store) {
            Some(spec) => StoreSpec::parse(spec, root, team),
            None if team.is_some() => Err("--team names a Postgres store's tenant; pass --store postgres://…".into()),
            None => Ok(StoreSpec::Sqlite(lf_dir.join("state.db"))),
        }
    }

    /// lf.yaml's `store:` as a spec: written out, or read from the
    /// environment variable or the secrets entry (its `url` field) it names.
    pub fn of_project(project: &Project, env: &[(String, String)]) -> std::result::Result<Option<String>, String> {
        Ok(Some(match &project.store {
            None => return Ok(None),
            Some(ProjectStore::Spec(spec)) => spec.clone(),
            Some(ProjectStore::Env(name)) => env
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| format!("lf.yaml's store reads the environment variable {name}, which is not set"))?,
            Some(ProjectStore::Credential(name)) => {
                let credentials = crate::secrets::load_secrets(project, env)?;
                let credential = credentials.iter().find(|c| &c.name == name).ok_or_else(|| format!("lf.yaml's store reads the secrets entry \"{name}\", which the secrets file does not have"))?;
                credential.fields.get("url").filter(|v| !v.is_empty()).cloned().ok_or_else(|| format!("the secrets entry \"{name}\" has no `url` field, which lf.yaml's store reads"))?
            }
        }))
    }

    /// How the store is named in a message: a Postgres URL without its password.
    pub fn display(&self) -> String {
        match self {
            StoreSpec::Sqlite(path) => path.display().to_string(),
            StoreSpec::Postgres { url, .. } => redact_password(url),
        }
    }
}

fn redact_password(url: &str) -> String {
    let Some(scheme_end) = url.find("://").map(|i| i + 3) else { return url.to_string() };
    let rest = &url[scheme_end..];
    let Some(at) = rest.find('@') else { return url.to_string() };
    match rest[..at].find(':') {
        Some(colon) => format!("{}{}:***{}", &url[..scheme_end], &rest[..colon], &rest[at..]),
        None => url.to_string(),
    }
}

pub fn open_store(spec: &StoreSpec) -> std::result::Result<Box<dyn RunHostStore>, String> {
    let opened: Result<Box<dyn RunHostStore>> = match spec {
        StoreSpec::Sqlite(path) => Store::open(path).map(|s| Box::new(s) as Box<dyn RunHostStore>),
        StoreSpec::Postgres { url, tenant } => PgStore::connect(url, tenant).map(|s| Box::new(s) as Box<dyn RunHostStore>),
    };
    opened.map_err(|e| format!("{}: {e}", spec.display()))
}

// ── Callbacks ───────────────────────────────────────────────────────────────

/// One `callback(…)` mint as the store keeps it (`CallbackRecord`).
#[derive(Debug, Clone)]
pub struct CallbackRecord {
    pub id: String,
    pub team_id: String,
    pub run_id: String,
    pub address: String,
    /// `[{ name, type }]`, in declaration order.
    pub params: Js,
    pub state: Js,
    /// The ledger: `[{ at, values, bodyStartedAt? }]`.
    pub calls: Js,
    pub single_use: bool,
    pub expires_at: Option<String>,
    /// `live`, `fired` or `revoked`.
    pub status: String,
}

/// What recording a call came to (`CallbackClaim`).
pub enum CallbackClaim {
    Recorded { callback: CallbackRecord, call_index: i64 },
    NotFound,
    Closed(CallbackRecord),
    Expired(CallbackRecord),
}

pub struct MintCallback<'a> {
    pub team_id: &'a str,
    pub run_id: &'a str,
    pub address: &'a str,
    pub params: &'a Js,
    pub state: &'a Js,
    pub single_use: bool,
    pub expires_at: Option<&'a str>,
}

/// Every family a run host's backend serves, and lf's run records.
pub trait RunHostStore {
    /// The tenant this store's rows of lf's own runs belong to.
    fn tenant(&self) -> &str;

    // ── Run records ─────────────────────────────────────────────────────────
    fn start_run(&self, id: &str, file: &str, movement: &str, started_at: &str, input: &str) -> Result<()>;
    /// `completed`, `parked`, `running` or `failed`; an ending revokes the run's live callbacks.
    fn settle_run(&self, id: &str, status: &str, outcome: &Js, at: &str) -> Result<()>;
    fn mark_parked(&self, id: &str) -> Result<()>;
    fn mark_failed(&self, id: &str, message: &str) -> Result<()>;
    /// The operator's cancel request on the run (its reason), or None.
    fn cancel_request(&self, id: &str) -> Result<Option<Option<String>>>;
    /// An operator asks to cancel the run.
    fn request_cancel(&self, id: &str, reason: Option<&str>) -> Result<()>;
    fn run(&self, id: &str) -> Result<Option<RunRow>>;
    /// The most recent runs first.
    fn runs(&self, limit: i64) -> Result<Vec<RunRow>>;
    /// The entries a segment appended to its run's trace (`segment_id`: the
    /// segment's, so a store that keeps one record per segment finds its own).
    fn append_trace(&self, run_id: &str, segment_id: &str, entries: &[Js]) -> Result<()>;
    fn trace_len(&self, run_id: &str) -> Result<i64>;

    // ── Parks ───────────────────────────────────────────────────────────────
    fn put_leaf(&self, run_id: &str, address: &str, reason: &str, wake_at: Option<&str>, state: &Js, fence: Option<&str>) -> Result<()>;
    fn claim_leaf(&self, run_id: &str, address: &str, reason: Option<&str>) -> Result<Option<(String, Js)>>;
    fn finish_leaf(&self, run_id: &str, address: &str, fence: Option<&str>) -> Result<()>;
    fn leaves(&self, run_id: &str, parked_only: bool, reason: Option<&str>, due_by: Option<&str>) -> Result<Vec<LeafRow>>;
    fn delete_leaves(&self, run_id: &str, addresses: &[String]) -> Result<()>;

    // ── Joins ───────────────────────────────────────────────────────────────
    fn record_join(&self, run_id: &str, frame_address: &str, pending: i64, fence: Option<&str>) -> Result<()>;
    fn decrement_join(&self, run_id: &str, frame_address: &str, branch_address: &str, leaf_address: &str) -> Result<bool>;
    fn persist_branch_export(&self, run_id: &str, frame_address: &str, branch_address: &str, branch_index: i64, exports: &Js) -> Result<()>;
    fn collect_branch_exports(&self, run_id: &str, frame_address: &str) -> Result<Vec<BranchExport>>;
    fn has_pending_joins(&self, run_id: &str) -> Result<bool>;
    fn frames(&self, run_id: &str) -> Result<Vec<String>>;
    fn delete_frames(&self, run_id: &str, frame_addresses: &[String]) -> Result<()>;

    // ── Await correlations ──────────────────────────────────────────────────
    fn correlate(&self, run_id: &str, team_id: &str, address: &str, adapter_type: &str, correlation_key: &str) -> Result<()>;
    fn correlated(&self, adapter_type: &str, team_id: &str, correlation_key: &str) -> Result<Vec<CorrelatedAwait>>;
    fn of_run(&self, run_id: &str, adapter_type: &str) -> Result<Vec<(CorrelatedAwait, String)>>;
    fn drop_correlation(&self, run_id: &str, address: &str) -> Result<()>;
    fn drop_run_correlations(&self, run_id: &str) -> Result<()>;

    // ── The run lease ───────────────────────────────────────────────────────
    fn claim_lease(&self, run_id: &str, ttl_ms: i64) -> Result<Option<String>>;
    fn renew_lease(&self, run_id: &str, token: &str, ttl_ms: i64) -> Result<bool>;
    fn release_lease(&self, run_id: &str, token: &str) -> Result<()>;
    fn drop_run_state(&self, run_id: &str, fence: Option<&str>) -> Result<bool>;

    // ── The work queue ──────────────────────────────────────────────────────
    /// `team_id` absent: the store's own tenant's row.
    fn enqueue(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>, team_id: Option<&str>) -> Result<()>;
    fn claim_due(&self, limit: i64, lease_ms: i64, due_by: Option<&str>) -> Result<Vec<ClaimedWork>>;
    fn complete(&self, id: &str, claim: &str) -> Result<()>;
    fn release_work(&self, id: &str, claim: &str, due_at: Option<&str>) -> Result<()>;

    // ── Library sources ─────────────────────────────────────────────────────
    fn put_source(&self, team_id: &str, hash: &str, source: &str) -> Result<()>;
    fn get_source(&self, team_id: &str, hash: &str) -> Result<Option<String>>;

    // ── Callbacks ───────────────────────────────────────────────────────────
    fn mint_callback(&self, input: MintCallback<'_>) -> Result<String>;
    fn callback(&self, id: &str) -> Result<Option<CallbackRecord>>;
    /// Record one call and queue its body, in one transaction.
    fn record_callback_call(&self, id: &str, values: &Js, body_due_at: &str) -> Result<CallbackClaim>;
    fn mark_callback_body_started(&self, id: &str, call_index: i64, fence: Option<&str>) -> Result<bool>;
    fn landed_callbacks(&self, ids: &[String]) -> Result<Vec<String>>;
    fn revoke_run_callbacks(&self, run_id: &str) -> Result<()>;

    // ── Inbound pull cursors ────────────────────────────────────────────────
    /// An install's saved pull cursor (a notify-then-pull source's), or None.
    fn inbound_checkpoint(&self, subscription_id: &str) -> Result<Option<Js>>;
    fn save_inbound_checkpoint(&self, subscription_id: &str, checkpoint: &Js) -> Result<()>;
}

impl RunHostStore for Store {
    fn tenant(&self) -> &str {
        SQLITE_TENANT
    }

    fn start_run(&self, id: &str, file: &str, movement: &str, started_at: &str, input: &str) -> Result<()> {
        Store::start_run(self, id, file, movement, started_at, input)
    }
    fn settle_run(&self, id: &str, status: &str, outcome: &Js, at: &str) -> Result<()> {
        Store::settle_run(self, id, status, outcome, at)
    }
    fn mark_parked(&self, id: &str) -> Result<()> {
        Store::mark_parked(self, id)
    }
    fn mark_failed(&self, id: &str, message: &str) -> Result<()> {
        Store::mark_failed(self, id, message)
    }
    fn cancel_request(&self, id: &str) -> Result<Option<Option<String>>> {
        Store::cancel_request(self, id)
    }
    fn request_cancel(&self, id: &str, reason: Option<&str>) -> Result<()> {
        Store::request_cancel(self, id, reason)
    }
    fn run(&self, id: &str) -> Result<Option<RunRow>> {
        Store::run(self, id)
    }
    fn runs(&self, limit: i64) -> Result<Vec<RunRow>> {
        Store::runs(self, limit)
    }
    fn append_trace(&self, run_id: &str, _segment_id: &str, entries: &[Js]) -> Result<()> {
        Store::append_trace(self, run_id, entries)
    }
    fn trace_len(&self, run_id: &str) -> Result<i64> {
        Store::trace_len(self, run_id)
    }

    fn put_leaf(&self, run_id: &str, address: &str, reason: &str, wake_at: Option<&str>, state: &Js, fence: Option<&str>) -> Result<()> {
        Store::put_leaf(self, run_id, address, reason, wake_at, state, fence)
    }
    fn claim_leaf(&self, run_id: &str, address: &str, reason: Option<&str>) -> Result<Option<(String, Js)>> {
        Store::claim_leaf(self, run_id, address, reason)
    }
    fn finish_leaf(&self, run_id: &str, address: &str, fence: Option<&str>) -> Result<()> {
        Store::finish_leaf(self, run_id, address, fence)
    }
    fn leaves(&self, run_id: &str, parked_only: bool, reason: Option<&str>, due_by: Option<&str>) -> Result<Vec<LeafRow>> {
        Store::leaves(self, run_id, parked_only, reason, due_by)
    }
    fn delete_leaves(&self, run_id: &str, addresses: &[String]) -> Result<()> {
        Store::delete_leaves(self, run_id, addresses)
    }

    fn record_join(&self, run_id: &str, frame_address: &str, pending: i64, fence: Option<&str>) -> Result<()> {
        Store::record_join(self, run_id, frame_address, pending, fence)
    }
    fn decrement_join(&self, run_id: &str, frame_address: &str, branch_address: &str, leaf_address: &str) -> Result<bool> {
        Store::decrement_join(self, run_id, frame_address, branch_address, leaf_address)
    }
    fn persist_branch_export(&self, run_id: &str, frame_address: &str, branch_address: &str, branch_index: i64, exports: &Js) -> Result<()> {
        Store::persist_branch_export(self, run_id, frame_address, branch_address, branch_index, exports)
    }
    fn collect_branch_exports(&self, run_id: &str, frame_address: &str) -> Result<Vec<BranchExport>> {
        Store::collect_branch_exports(self, run_id, frame_address)
    }
    fn has_pending_joins(&self, run_id: &str) -> Result<bool> {
        Store::has_pending_joins(self, run_id)
    }
    fn frames(&self, run_id: &str) -> Result<Vec<String>> {
        Store::frames(self, run_id)
    }
    fn delete_frames(&self, run_id: &str, frame_addresses: &[String]) -> Result<()> {
        Store::delete_frames(self, run_id, frame_addresses)
    }

    fn correlate(&self, run_id: &str, team_id: &str, address: &str, adapter_type: &str, correlation_key: &str) -> Result<()> {
        Store::correlate(self, run_id, team_id, address, adapter_type, correlation_key)
    }
    fn correlated(&self, adapter_type: &str, team_id: &str, correlation_key: &str) -> Result<Vec<CorrelatedAwait>> {
        Store::correlated(self, adapter_type, team_id, correlation_key)
    }
    fn of_run(&self, run_id: &str, adapter_type: &str) -> Result<Vec<(CorrelatedAwait, String)>> {
        Store::of_run(self, run_id, adapter_type)
    }
    fn drop_correlation(&self, run_id: &str, address: &str) -> Result<()> {
        Store::drop_correlation(self, run_id, address)
    }
    fn drop_run_correlations(&self, run_id: &str) -> Result<()> {
        Store::drop_run_correlations(self, run_id)
    }

    fn claim_lease(&self, run_id: &str, ttl_ms: i64) -> Result<Option<String>> {
        Store::claim_lease(self, run_id, ttl_ms)
    }
    fn renew_lease(&self, run_id: &str, token: &str, ttl_ms: i64) -> Result<bool> {
        Store::renew_lease(self, run_id, token, ttl_ms)
    }
    fn release_lease(&self, run_id: &str, token: &str) -> Result<()> {
        Store::release_lease(self, run_id, token)
    }
    fn drop_run_state(&self, run_id: &str, fence: Option<&str>) -> Result<bool> {
        Store::drop_run_state(self, run_id, fence)
    }

    // The state file has one tenant, so a row's team is not kept.
    fn enqueue(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>, _team_id: Option<&str>) -> Result<()> {
        Store::enqueue(self, kind, key, payload, due_at)
    }
    fn claim_due(&self, limit: i64, lease_ms: i64, due_by: Option<&str>) -> Result<Vec<ClaimedWork>> {
        Store::claim_due(self, limit, lease_ms, due_by)
    }
    fn complete(&self, id: &str, claim: &str) -> Result<()> {
        Store::complete(self, id, claim)
    }
    fn release_work(&self, id: &str, claim: &str, due_at: Option<&str>) -> Result<()> {
        Store::release_work(self, id, claim, due_at)
    }

    fn put_source(&self, team_id: &str, hash: &str, source: &str) -> Result<()> {
        Store::put_source(self, team_id, hash, source)
    }
    fn get_source(&self, team_id: &str, hash: &str) -> Result<Option<String>> {
        Store::get_source(self, team_id, hash)
    }

    fn mint_callback(&self, input: MintCallback<'_>) -> Result<String> {
        Store::mint_callback(self, input)
    }
    fn callback(&self, id: &str) -> Result<Option<CallbackRecord>> {
        Store::callback(self, id)
    }
    fn record_callback_call(&self, id: &str, values: &Js, body_due_at: &str) -> Result<CallbackClaim> {
        Store::record_callback_call(self, id, values, body_due_at)
    }
    fn mark_callback_body_started(&self, id: &str, call_index: i64, fence: Option<&str>) -> Result<bool> {
        Store::mark_callback_body_started(self, id, call_index, fence)
    }
    fn landed_callbacks(&self, ids: &[String]) -> Result<Vec<String>> {
        Store::landed_callbacks(self, ids)
    }
    fn revoke_run_callbacks(&self, run_id: &str) -> Result<()> {
        Store::revoke_run_callbacks(self, run_id)
    }

    fn inbound_checkpoint(&self, subscription_id: &str) -> Result<Option<Js>> {
        Store::inbound_checkpoint(self, subscription_id)
    }
    fn save_inbound_checkpoint(&self, subscription_id: &str, checkpoint: &Js) -> Result<()> {
        Store::save_inbound_checkpoint(self, subscription_id, checkpoint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_postgres_url_is_a_postgres_store_and_anything_else_a_state_file() {
        let root = Path::new("/p");
        assert_eq!(
            StoreSpec::parse("postgres://u:pw@h:5432/db", root, None).unwrap(),
            StoreSpec::Postgres { url: "postgres://u:pw@h:5432/db".into(), tenant: POSTGRES_TENANT.into() }
        );
        assert_eq!(StoreSpec::parse("state/other.db", root, None).unwrap(), StoreSpec::Sqlite(PathBuf::from("/p/state/other.db")));
        assert!(StoreSpec::parse("postgresql://h/db", root, Some("not-a-uuid")).unwrap_err().contains("uuid"));
        assert!(StoreSpec::parse("x.db", root, Some(POSTGRES_TENANT)).is_err());
        assert_eq!(StoreSpec::of_command(None, None, root, Path::new("/p/.lf"), None).unwrap(), StoreSpec::Sqlite(PathBuf::from("/p/.lf/state.db")));
        assert!(matches!(StoreSpec::of_command(None, Some("postgres://h/db"), root, root, None).unwrap(), StoreSpec::Postgres { .. }));
    }

    #[test]
    fn the_local_tenant_is_a_uuid() {
        assert!(uuid::Uuid::parse_str(POSTGRES_TENANT).is_ok());
    }

    #[test]
    fn a_url_is_shown_without_its_password() {
        assert_eq!(redact_password("postgres://u:secret@h:1/db"), "postgres://u:***@h:1/db");
        assert_eq!(redact_password("postgres://h/db"), "postgres://h/db");
    }
}
