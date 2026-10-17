//! A session — one project opened for running: its secrets, externals,
//! catalog, files and listens — and the entry points the run commands share:
//! an event routed to the listens it matches and run, a parked run resumed,
//! and the work queue drained. A port of apps/cli/src/runs.ts, its output
//! (`report`) the TypeScript lf's line for line.

use std::cell::RefCell;
use std::io::Write;

use indexmap::IndexMap;

use crate::catalog::catalog_of;
use crate::check::{LOCAL_TENANT, describe_external};
use crate::documents::Documents;
use crate::externals::{RunningExternal, rpc, scan_externals, start_externals};
use crate::json::{Js, Obj};
use crate::obj;
use crate::project::{Project, refuse_below_lf};
use crate::remote::{Externals, SegmentAdapters};
use crate::routing::{Listen, collect_listens, event_matches_trigger_scope, trigger_event_of};
use crate::run_host::{
    Lease, Settled, StepOutcome, StepRequest, Stepper, after_step, arm_timer_wake, clear_if_quiescent, drain_due_timers, drain_run, next_timer_wake,
    run_complete_without, run_quiescent, with_run_lease,
};
use crate::secrets::{Credentials, load_secrets, missing_credentials};
use crate::segment::{Ended, Entry, SegmentHost, SegmentHostParts, SegmentInput, run_segment};
use crate::sources::{MovementFile, scan_movements};
use crate::backend::{RunHostStore, StoreSpec, open_store};
use crate::store::iso;
use crate::wire_results;

/// How long a work row's claim lasts (`LEASE_TTL_MS`).
const WORK_LEASE_MS: i64 = 60_000;
/// How long a work row waits before it is tried again: when its run was
/// held elsewhere, and when it failed.
const BUSY_RETRY_MS: i64 = 5_000;
const FAILED_RETRY_MS: i64 = 30_000;

pub struct Session {
    pub project: Project,
    pub store: Box<dyn RunHostStore>,
    credentials: Credentials,
    running: Vec<RunningExternal>,
    documents: Documents,
    files: Vec<MovementFile>,
    catalog: Js,
    listens: Vec<Listen>,
    /// `LF_CLOCK_AHEAD_MS`: what is due is judged this far ahead.
    due_offset_ms: i64,
    /// The principal every event acts as (`localIdentity`).
    user: Js,
    /// The temporary folder an ephemeral session's state lives in.
    ephemeral_dir: Option<std::path::PathBuf>,
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(dir) = &self.ephemeral_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// `localIdentity`: LF_USER / LF_USER_EMAIL, else lf.yaml's `user`, else the OS user.
fn local_identity(project: &Project) -> Js {
    let env = |k: &str| std::env::var(k).ok();
    let name = env("LF_USER").or_else(|| project.user.0.clone()).or_else(|| env("USER")).or_else(|| env("USERNAME")).unwrap_or_else(|| "lf".into());
    let email = env("LF_USER_EMAIL").or_else(|| project.user.1.clone()).unwrap_or_else(|| format!("{name}@localhost"));
    Js::Obj(obj! {
        "principal" => Js::Obj(obj! { "id" => Js::Str(format!("local:{name}")), "display" => Js::str(&name) }),
        "email" => Js::Str(email),
    })
}

fn due_clock_offset() -> Result<i64, String> {
    match std::env::var("LF_CLOCK_AHEAD_MS") {
        Err(_) => Ok(0),
        Ok(raw) if raw.is_empty() => Ok(0),
        Ok(raw) => raw
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|n| *n >= 0)
            .ok_or_else(|| format!("LF_CLOCK_AHEAD_MS is \"{raw}\": it must be a whole number of milliseconds")),
    }
}

/// `store`: where the run state is kept; an ephemeral session keeps its own
/// in a temporary state file instead.
pub async fn open_session(project: Project, ephemeral: bool, store: &StoreSpec) -> Result<Session, String> {
    let env: Vec<(String, String)> = std::env::vars().collect();
    let credentials = load_secrets(&project, &env)?;
    let files = scan_movements(&project)?;
    let missing = missing_credentials(&project, &files, &credentials, &env);
    if !missing.is_empty() {
        return Err(missing.iter().map(|m| format!("{}:{}:{} {}", m.file.display(), m.line, m.column, m.message)).collect::<Vec<_>>().join("\n"));
    }
    let externals = scan_externals(&project)?;
    let running = start_externals(&project, &externals, &credentials, LOCAL_TENANT).await?;
    let due_offset_ms = due_clock_offset()?;
    let (store, ephemeral_dir) = if ephemeral {
        let dir = std::env::temp_dir().join(format!("lf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        (open_store(&StoreSpec::Sqlite(dir.join("state.db")))?, Some(dir))
    } else {
        (open_store(store)?, None)
    };
    let documents = Documents::new(&project.lf_dir);
    let mut schemas = IndexMap::new();
    for r in running.iter().filter(|r| !r.is_plugin()) {
        schemas.insert(r.external.manifest.name.clone(), describe_external(r, &credentials).await?);
    }
    // Scanned again after the externals start, as the TypeScript session does.
    let files = scan_movements(&project)?;
    let catalog = catalog_of(&running, &schemas, &credentials, &files);
    let listens = collect_listens(&files, project.language_version);
    let user = local_identity(&project);
    Ok(Session { project, store, credentials, running, documents, files, catalog, listens, due_offset_ms, user, ephemeral_dir })
}

/// What one entry into a run came to (`RunOutcome`).
pub struct RunOutcome {
    pub run_id: String,
    pub file: String,
    pub movement: String,
    /// `fired` or `resumed` (a callback's body, `called`, is not run here yet).
    pub entry: &'static str,
    /// `completed`, `parked`, `failed` or `leaseLost`.
    pub status: String,
    pub writes: usize,
    pub captured: Option<Vec<Js>>,
    pub trace_entries: i64,
    pub error: Option<String>,
}

/// What a run entry has done so far: its writes, and how many segments ran.
#[derive(Default, Clone, Copy)]
struct Tally {
    writes: usize,
    stepped: usize,
}

/// The facts a run keeps so it can be resumed against the same program (`RunFacts`).
struct RunFacts {
    source: String,
    language_version: u32,
    event: Js,
    movement_name: String,
    fired_at: String,
}

impl RunFacts {
    fn to_js(&self) -> Js {
        Js::Obj(obj! {
            "source" => Js::str(&self.source),
            "languageVersion" => Js::Num(self.language_version.into()),
            "event" => self.event.clone(),
            "movementName" => Js::str(&self.movement_name),
            "firedAt" => Js::str(&self.fired_at),
        })
    }

    /// A run's facts, refused when its pin is one lf does not run.
    fn of_row(run_id: &str, input: &str) -> Result<RunFacts, String> {
        let facts = Js::parse(input.as_bytes()).map_err(|e| format!("run {run_id}: its facts are not JSON: {e}"))?;
        let text = |k: &str| facts.get(k).and_then(Js::as_str).map(str::to_string).ok_or_else(|| format!("run {run_id}: its facts have no {k}"));
        let language_version = match facts.get("languageVersion") {
            Some(Js::Num(n)) => n.as_u64().ok_or_else(|| format!("run {run_id}: languageVersion is a whole number"))? as u32,
            _ => return Err(format!("run {run_id}: its facts have no languageVersion")),
        };
        refuse_below_lf(language_version, &format!("run {run_id}"), "it cannot resume; run `lf upgrade` and fire it again")?;
        Ok(RunFacts {
            source: text("source")?,
            language_version,
            event: facts.get("event").cloned().unwrap_or(Js::Null),
            movement_name: text("movementName")?,
            fired_at: text("firedAt")?,
        })
    }
}

impl Session {
    fn externals(&self) -> Externals<'_> {
        Externals { project: &self.project, running: &self.running, credentials: &self.credentials, documents: &self.documents, tenant: LOCAL_TENANT }
    }

    fn due_by(&self) -> String {
        iso(self.due_offset_ms)
    }

    /// Route one event to every listen it matches, and run each (`fireEvent`).
    pub async fn fire_event(&self, external: &str, event: &Js, dry_run: bool) -> Result<Vec<RunOutcome>, String> {
        let event_types = self.event_types_of(external).await?;
        let mut outcomes = Vec::new();
        for listen in self.listens.iter().filter(|l| l.adapter == external && event_matches_trigger_scope(event, &l.config)) {
            let run_id = uuid::Uuid::new_v4().to_string();
            let file = &self.files[listen.file];
            let pipeline = format!("listen:{}:{}", file.name, listen.movement_name);
            let trigger = trigger_event_of(&pipeline, external, event, &event_types, &iso(0));
            outcomes.push(self.run_listen(&run_id, listen, trigger, dry_run).await?);
        }
        Ok(outcomes)
    }

    async fn event_types_of(&self, external: &str) -> Result<Vec<Js>, String> {
        let Some(running) = self.running.iter().find(|r| r.external.manifest.name == external) else { return Ok(Vec::new()) };
        if !running.methods.iter().any(|m| m == "listEventTypes") {
            return Ok(Vec::new());
        }
        let raw = rpc(running, &self.credentials, LOCAL_TENANT, "listEventTypes", serde_json::json!({})).await?;
        let types = wire_results::check("listEventTypes", external, &raw)?;
        Ok(types.as_array().map(<[Js]>::to_vec).unwrap_or_default())
    }

    async fn run_listen(&self, run_id: &str, listen: &Listen, event: Js, dry_run: bool) -> Result<RunOutcome, String> {
        let file = &self.files[listen.file];
        let fired_at = iso(0);
        let facts = RunFacts {
            source: file.source.clone(),
            language_version: self.project.language_version,
            event,
            movement_name: listen.movement_name.clone(),
            fired_at: fired_at.clone(),
        };
        self.store.start_run(run_id, &file.name, &facts.movement_name, &fired_at, &facts.to_js().to_json()).map_err(|e| e.to_string())?;
        let tally = RefCell::new(Tally::default());
        let captured = RefCell::new(Vec::new());
        let held = with_run_lease(&*self.store, run_id, async |lease: &Lease| -> Result<bool, String> {
            let fence = Some(lease.token.as_str());
            let outcome = self
                .record_segment(run_id, &facts, Some(&lease.token), &tally, dry_run.then_some(&captured), Entry::Run, None)
                .await?;
            if let Settled::Continue = after_step(&*self.store, run_id, fence, &outcome)? {
                clear_if_quiescent(&*self.store, run_id, fence)?;
            }
            Ok(outcome == StepOutcome::LeaseLost)
        })
        .await?;
        // A fresh run's row is new: nobody else can hold its lease.
        let Some(lease_lost) = held else { return Err(run_busy(run_id)) };
        let mut outcome = self.settled_outcome(run_id, "fired", *tally.borrow(), lease_lost?)?;
        if dry_run {
            outcome.captured = Some(captured.into_inner());
        }
        Ok(outcome)
    }

    /// Run one segment and record what it came to on the run's row
    /// (`recordSegment`). `completing` is the leaf whose own row goes after
    /// its step (None for a fresh firing).
    #[allow(clippy::too_many_arguments)] // the TypeScript's input object, spelled out
    async fn record_segment(
        &self,
        run_id: &str,
        facts: &RunFacts,
        fence: Option<&str>,
        tally: &RefCell<Tally>,
        captured: Option<&RefCell<Vec<Js>>>,
        entry: Entry,
        completing: Option<&str>,
    ) -> Result<StepOutcome, String> {
        tally.borrow_mut().stepped += 1;
        let externals = self.externals();
        let segment_id = uuid::Uuid::new_v4().to_string();
        let host = SegmentHost::new(SegmentHostParts {
            segment_id: segment_id.clone(),
            run_id: run_id.to_string(),
            fence: fence.map(str::to_string),
            store: &*self.store,
            adapters: SegmentAdapters::new(&segment_id, &externals),
            documents: &self.documents,
            user: self.user.clone(),
        });
        let input = SegmentInput {
            source: &facts.source,
            language_version: facts.language_version,
            movement_name: &facts.movement_name,
            event: &facts.event,
            fired_at: &facts.fired_at,
            catalog: &self.catalog,
            dry_run: captured.is_some(),
            entry,
        };
        let ran = match run_segment(&host, input).await {
            Ok(ran) => ran,
            Err(Ended::LeaseLost) => return Ok(StepOutcome::LeaseLost),
            Err(Ended::Failed(message)) => {
                self.store.mark_failed(run_id, &message).map_err(|e| e.to_string())?;
                return Ok(StepOutcome::Failed(message));
            }
        };
        if let Some(captured) = captured {
            captured.borrow_mut().extend(ran.captured.iter().cloned());
        }
        let writes = {
            let mut tally = tally.borrow_mut();
            tally.writes += ran.writes;
            tally.writes
        };
        let at = iso(0);
        let outcome = Js::Obj(obj! { "writes" => Js::Num(writes.into()) });
        if ran.cancelled {
            let reason = self.store.cancel_request(run_id).map_err(|e| e.to_string())?.flatten();
            return Ok(StepOutcome::Cancelled(reason));
        }
        if let Some(address) = ran.parked_address {
            self.store.settle_run(run_id, "parked", &outcome, &at).map_err(|e| e.to_string())?;
            return Ok(StepOutcome::Parked { address: Some(address), deferred_race_frames: ran.deferred_race_frames });
        }
        let complete = match completing {
            None => run_quiescent(&*self.store, run_id)?,
            Some(leaf) => run_complete_without(&*self.store, run_id, leaf)?,
        };
        self.store.settle_run(run_id, if complete { "completed" } else { "parked" }, &outcome, &at).map_err(|e| e.to_string())?;
        Ok(StepOutcome::Completed { deferred_race_frames: ran.deferred_race_frames })
    }

    /// Where a run stands once an entry into it is over, as its row says. A
    /// run still parked re-arms its timer row at its earliest parked timer.
    fn settled_outcome(&self, run_id: &str, entry: &'static str, tally: Tally, lease_lost: bool) -> Result<RunOutcome, String> {
        let row = self.store.run(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
        let trace_entries = self.store.trace_len(run_id).map_err(|e| e.to_string())?;
        let mut outcome = RunOutcome {
            run_id: run_id.to_string(),
            file: row.file.clone(),
            movement: row.movement.clone(),
            entry,
            status: String::new(),
            writes: tally.writes,
            captured: None,
            trace_entries,
            error: None,
        };
        if lease_lost {
            outcome.status = "leaseLost".into();
            return Ok(outcome);
        }
        match row.status.as_str() {
            "completed" => outcome.status = "completed".into(),
            "failed" => {
                outcome.status = "failed".into();
                let error = row.outcome.as_deref().and_then(|o| Js::parse(o.as_bytes()).ok()).and_then(|o| o.get("error").and_then(Js::as_str).map(str::to_string));
                outcome.error = Some(error.unwrap_or_else(|| "failed".into()));
            }
            "parked" | "running" => {
                if let Some(wake_at) = next_timer_wake(&*self.store, run_id)? {
                    arm_timer_wake(&*self.store, run_id, &wake_at)?;
                }
                outcome.status = "parked".into();
            }
            other => return Err(format!("run {run_id} has status {other}")),
        }
        Ok(outcome)
    }

    /// Step a parked run's leaves through one of the core's drains, under the
    /// run's lease. Ok(None) when the run is not parked or none of its leaves
    /// was stepped; Err(busy) when another process holds it.
    async fn drive_parked_run(&self, run_id: &str, drain: Drain) -> Result<Parked, String> {
        if self.store.run(run_id).map_err(|e| e.to_string())?.is_none() {
            return Err(format!("no run {run_id}"));
        }
        let held = with_run_lease(&*self.store, run_id, async |lease: &Lease| -> Result<Option<(Tally, bool)>, String> {
            let Some(stepper) = self.parked_stepper(run_id, lease)? else { return Ok(None) };
            let lease_lost = match &drain {
                Drain::EveryParkedLeaf => {
                    let leaves: Vec<String> = self.store.leaves(run_id, true, None, None).map_err(|e| e.to_string())?.into_iter().map(|l| l.address).collect();
                    drain_run(&*self.store, run_id, &leaves, None, lease, &stepper).await?
                }
                Drain::DueTimers => drain_due_timers(&*self.store, run_id, &self.due_by(), lease, &stepper).await?,
                Drain::Leaves(addresses) => drain_run(&*self.store, run_id, addresses, None, lease, &stepper).await?,
            };
            Ok(Some((*stepper.tally.borrow(), lease_lost)))
        })
        .await?;
        let Some(held) = held else { return Ok(Parked::Busy) };
        let Some((tally, lease_lost)) = held? else { return Ok(Parked::NotStepped) };
        if tally.stepped == 0 {
            return Ok(Parked::NotStepped);
        }
        Ok(Parked::Stepped(self.settled_outcome(run_id, "resumed", tally, lease_lost)?))
    }

    /// A parked run's step for the core's drains, under the lease. None when
    /// the run is not parked.
    fn parked_stepper<'a>(&'a self, run_id: &str, lease: &'a Lease) -> Result<Option<LeafStepper<'a>>, String> {
        let Some(row) = self.store.run(run_id).map_err(|e| e.to_string())? else { return Ok(None) };
        if row.status != "parked" {
            return Ok(None);
        }
        let facts = RunFacts::of_row(run_id, &row.input)?;
        Ok(Some(LeafStepper { session: self, run_id: run_id.to_string(), facts, lease, tally: RefCell::new(Tally::default()) }))
    }

    /// `lf resume <run>`: every parked leaf of the run, now.
    pub async fn resume_run(&self, run_id: &str) -> Result<RunOutcome, String> {
        let row = self.store.run(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
        if row.status != "parked" {
            return Err(format!("run {run_id} is {}, not parked", row.status));
        }
        match self.drive_parked_run(run_id, Drain::EveryParkedLeaf).await? {
            Parked::Busy => Err(run_busy(run_id)),
            Parked::NotStepped => Err(format!("run {run_id} is parked but has no parked leaf")),
            Parked::Stepped(outcome) => Ok(outcome),
        }
    }

    /// `lf resume` with no run: drain the due work, then step every leaf
    /// still parked, now.
    pub async fn resume_all(&self, log: &mut impl Write) -> Result<Vec<RunOutcome>, String> {
        let (_, mut outcomes) = self.drain_work(100, log).await?;
        let parked: Vec<String> = self.store.runs(1000).map_err(|e| e.to_string())?.into_iter().filter(|r| r.status == "parked").map(|r| r.id).collect();
        for run_id in parked {
            match self.drive_parked_run(&run_id, Drain::EveryParkedLeaf).await? {
                Parked::Busy => return Err(run_busy(&run_id)),
                Parked::NotStepped => {}
                Parked::Stepped(outcome) => outcomes.push(outcome),
            }
        }
        Ok(outcomes)
    }

    /// Drain the work queue once: up to `limit` due rows are leased, done,
    /// and completed (or released for a retry when their run is held
    /// elsewhere or they failed). How many rows were claimed, and what the
    /// runs they stepped came to.
    pub async fn drain_work(&self, limit: i64, log: &mut impl Write) -> Result<(usize, Vec<RunOutcome>), String> {
        let mut outcomes = Vec::new();
        let due = self.store.claim_due(limit, WORK_LEASE_MS, Some(&self.due_by())).map_err(|e| e.to_string())?;
        let claimed_rows = due.len();
        for claimed in due {
            match self.do_work(&claimed.kind, &claimed.payload).await {
                Ok((busy, done)) => {
                    outcomes.extend(done);
                    if busy {
                        self.store.release_work(&claimed.id, &claimed.claim, Some(&iso(BUSY_RETRY_MS))).map_err(|e| e.to_string())?;
                    } else {
                        self.store.complete(&claimed.id, &claimed.claim).map_err(|e| e.to_string())?;
                    }
                }
                Err(message) => {
                    let _ = writeln!(log, "work {} failed: {message}", claimed.key);
                    self.store.release_work(&claimed.id, &claimed.claim, Some(&iso(FAILED_RETRY_MS))).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok((claimed_rows, outcomes))
    }

    async fn do_work(&self, kind: &str, payload: &Js) -> Result<(bool, Vec<RunOutcome>), String> {
        let text = |k: &str| payload.get(k).and_then(Js::as_str).map(str::to_string).ok_or_else(|| format!("a {kind} row has no {k}"));
        match kind {
            "fire_event" => {
                let event = payload.get("event").cloned().ok_or("a fire_event row has no event")?;
                Ok((false, self.fire_event(&text("external")?, &event, false).await?))
            }
            "resume_timer" => {
                let run_id = text("runId")?;
                if self.store.run(&run_id).map_err(|e| e.to_string())?.is_none() {
                    return Ok((false, Vec::new()));
                }
                Ok(match self.drive_parked_run(&run_id, Drain::DueTimers).await? {
                    Parked::Busy => (true, Vec::new()),
                    Parked::NotStepped => (false, Vec::new()),
                    Parked::Stepped(outcome) => (false, vec![outcome]),
                })
            }
            "wake_await" => {
                let adapter_type = text("adapterType")?;
                let team = payload.get("teamId").and_then(Js::as_str).unwrap_or(LOCAL_TENANT).to_string();
                let key = text("correlationKey")?;
                let parks = self.store.correlated(&adapter_type, &team, &key).map_err(|e| e.to_string())?;
                let mut by_run: IndexMap<String, Vec<String>> = IndexMap::new();
                for park in parks {
                    by_run.entry(park.run_id).or_default().push(park.address);
                }
                let (mut busy, mut outcomes) = (false, Vec::new());
                for (run_id, addresses) in by_run {
                    match self.drive_parked_run(&run_id, Drain::Leaves(addresses)).await? {
                        Parked::Busy => busy = true,
                        Parked::NotStepped => {}
                        Parked::Stepped(outcome) => outcomes.push(outcome),
                    }
                }
                Ok((busy, outcomes))
            }
            "fire_callback" => Err("lf-host does not run callback bodies yet; the TypeScript lf drains this row".into()),
            other => Err(format!("not a work kind: {other}")),
        }
    }
}

/// Which of a parked run's leaves a drain steps.
enum Drain {
    EveryParkedLeaf,
    DueTimers,
    Leaves(Vec<String>),
}

enum Parked {
    Busy,
    NotStepped,
    Stepped(RunOutcome),
}

fn run_busy(run_id: &str) -> String {
    format!("run {run_id} is being stepped by another lf process right now; try again in a moment")
}

/// A parked run's leaves, stepped one segment each (`parkedStepper`).
struct LeafStepper<'a> {
    session: &'a Session,
    run_id: String,
    facts: RunFacts,
    lease: &'a Lease,
    tally: RefCell<Tally>,
}

impl Stepper for LeafStepper<'_> {
    async fn step(&self, request: StepRequest) -> StepOutcome {
        let completing = request.completing_address().to_string();
        let entry = match request {
            StepRequest::Leaf { state, reenter, .. } => Entry::Resume { state, reenter },
            StepRequest::Race { frame_address, state } => Entry::Settle { state, frame_address },
        };
        let recorded = self
            .session
            .record_segment(&self.run_id, &self.facts, Some(&self.lease.token), &self.tally, None, entry, Some(&completing))
            .await;
        recorded.unwrap_or_else(StepOutcome::Failed)
    }
}

/// `report`: each outcome's line, its error and a dry run's writes; the exit
/// code 1 when any failed.
pub fn report(outcomes: &[RunOutcome], out: &mut impl Write) -> Result<i32, String> {
    let io = |e: std::io::Error| e.to_string();
    if outcomes.is_empty() {
        writeln!(out, "no listen matched").map_err(io)?;
    }
    for o in outcomes {
        let entries = if o.trace_entries == 1 { "entry" } else { "entries" };
        let error = o.error.as_ref().map(|e| format!("\n  {e}")).unwrap_or_default();
        let verb = if o.entry == "called" { "called" } else { "run" };
        writeln!(out, "{verb} {} {}:{} {} — {} write(s), {} trace {entries}{error}", o.run_id, o.file, o.movement, o.status, o.writes, o.trace_entries).map_err(io)?;
        for w in o.captured.iter().flatten() {
            writeln!(out, "  dry run, not written: {}", w.to_json()).map_err(io)?;
        }
    }
    Ok(if outcomes.iter().any(|o| o.status == "failed") { 1 } else { 0 })
}

/// An event file: which external it came from, and the event (`EventFile`).
pub fn read_event_file(path: &std::path::Path) -> Result<(String, Js), String> {
    let text = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let file = Js::parse(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let external = file.get("external").and_then(Js::as_str).filter(|s| !s.is_empty()).ok_or_else(|| format!("{}: external: expected a non-empty string", path.display()))?;
    let event = match file.get("event") {
        // `payload` first, as the schema parses it, then the rest in order.
        Some(Js::Obj(map)) => {
            let mut ordered: Obj = obj! { "payload" => map.get("payload").cloned().unwrap_or(Js::Null) };
            for (k, v) in map {
                if k != "payload" {
                    ordered.insert(k.clone(), v.clone());
                }
            }
            if !map.contains_key("payload") {
                ordered.shift_remove("payload");
            }
            Js::Obj(ordered)
        }
        _ => return Err(format!("{}: event: expected an object", path.display())),
    };
    Ok((external.to_string(), event))
}
