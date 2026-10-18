//! A session — one project opened for running: its secrets, externals,
//! catalog, files and listens — and the entry points the run commands share:
//! an event routed to the listens it matches and run, a parked run resumed,
//! the work queue drained, a callback called and a run cancelled, and the
//! line each run is reported by (`report`).

use std::cell::RefCell;
use std::io::Write;

use indexmap::IndexMap;

use crate::callbacks::{CALLBACK_AWAIT_TYPE, CallFor, CallOutcome, queue_body, record_callback_call, refusal, resolvable_awaits};
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
    CANCELLED_BY_OPERATOR, Lease, Settled, StepOutcome, StepRequest, Stepper, after_step, arm_timer_wake, clear_if_quiescent, drain_due_timers, drain_run,
    fail_run, next_timer_wake, run_complete_without, run_quiescent, settle_if_cancel_requested, with_run_lease,
};
use crate::secrets::{Credentials, load_secrets, missing_credentials};
use crate::segment::{Ended, Entry, Ran, SegmentHost, SegmentHostParts, SegmentInput, run_segment};
use crate::sources::{MovementFile, scan_movements};
use crate::backend::{RunHostStore, StoreSpec, open_store};
use crate::store::iso;
use crate::wire_results;

/// How many due work rows one drain of `lf resume` or `lf serve` claims.
pub const WORK_ROWS_PER_DRAIN: i64 = 100;

/// How long a work row's claim lasts (`LEASE_TTL_MS`).
const WORK_LEASE_MS: i64 = 60_000;
/// How long a work row waits before it is tried again: when its run was
/// held elsewhere, and when it failed.
const BUSY_RETRY_MS: i64 = 5_000;
const FAILED_RETRY_MS: i64 = 30_000;
/// Where `lf serve` listens unless told otherwise (`DEFAULT_PORT`).
pub const DEFAULT_PORT: u16 = 4400;

pub struct Session {
    pub project: Project,
    pub store: Box<dyn RunHostStore>,
    credentials: Credentials,
    running: Vec<RunningExternal>,
    pub documents: Documents,
    files: Vec<MovementFile>,
    catalog: Js,
    listens: Vec<Listen>,
    /// `LF_CLOCK_AHEAD_MS`: what is due is judged this far ahead.
    due_offset_ms: i64,
    /// The principal every event acts as (`localIdentity`).
    user: Js,
    /// Where lf is reached from outside: a callback's url is under it.
    public_url: String,
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

/// `localIdentity`: LF_USER / LF_USER_EMAIL, else lf.yaml's `user` (its
/// name and email), else the OS user.
fn local_identity(configured: &(Option<String>, Option<String>), env: impl Fn(&str) -> Option<String>) -> Js {
    let name = env("LF_USER").or_else(|| configured.0.clone()).or_else(|| env("USER")).or_else(|| env("USERNAME")).unwrap_or_else(|| "lf".into());
    let email = env("LF_USER_EMAIL").or_else(|| configured.1.clone()).unwrap_or_else(|| format!("{name}@localhost"));
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
    // Before the externals start, so they are told where it is.
    crate::serve::open_models_door(&credentials).await?;
    let running = start_externals(&project, &externals, &credentials, LOCAL_TENANT).await?;
    let due_offset_ms = due_clock_offset()?;
    let (store, ephemeral_dir) = if ephemeral {
        let dir = std::env::temp_dir().join(format!("lf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        (open_store(&StoreSpec::Sqlite(dir.join("state.db")))?, Some(dir))
    } else {
        (open_store(store)?, None)
    };
    // The files slot's module: @lf/local-files, the one lf has (crate::core).
    let documents = Documents::new(&project.lf_dir);
    let mut schemas = IndexMap::new();
    for r in running.iter().filter(|r| !r.is_plugin()) {
        schemas.insert(r.external.manifest.name.clone(), describe_external(r, &credentials).await?);
    }
    // Scanned again after the externals start: one may have written a movement file.
    let files = scan_movements(&project)?;
    let catalog = catalog_of(&running, &schemas, &credentials, &files);
    let listens = collect_listens(&files, project.language_version);
    let user = local_identity(&project.user, |k| std::env::var(k).ok());
    let public_url = project
        .public_url
        .clone()
        .or_else(|| crate::serve::host_url().map(str::to_string))
        .unwrap_or_else(|| format!("http://127.0.0.1:{DEFAULT_PORT}"));
    Ok(Session { project, store, credentials, running, documents, files, catalog, listens, due_offset_ms, user, public_url, ephemeral_dir })
}

/// What firing one event came to: the runs it started, and a line per
/// listen it was a redelivery to (its `idempotencyKey` seen there before).
#[derive(Default)]
pub struct Fired {
    pub outcomes: Vec<RunOutcome>,
    pub redelivered: Vec<String>,
}

impl Fired {
    /// The redeliveries' lines, then the runs as `report` writes them.
    pub fn report(&self, out: &mut impl Write) -> Result<i32, String> {
        for line in &self.redelivered {
            writeln!(out, "{line}").map_err(|e| e.to_string())?;
        }
        if self.outcomes.is_empty() && !self.redelivered.is_empty() {
            return Ok(0);
        }
        report(&self.outcomes, out)
    }
}

/// What one entry into a run came to (`RunOutcome`).
pub struct RunOutcome {
    pub run_id: String,
    pub file: String,
    pub movement: String,
    /// `fired`, `resumed`, or `called` (a callback's body; `error`: the body
    /// failed, and the run carries on).
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
    /// The externals the session started.
    pub fn running(&self) -> &[RunningExternal] {
        &self.running
    }

    /// The installs: the secrets file's credentials, then the environment's.
    pub fn credentials(&self) -> &Credentials {
        &self.credentials
    }

    pub fn externals(&self) -> Externals<'_> {
        Externals { project: &self.project, running: &self.running, credentials: &self.credentials, documents: &self.documents, tenant: LOCAL_TENANT }
    }

    fn due_by(&self) -> String {
        iso(self.due_offset_ms)
    }

    /// Route one event to every listen it matches, and run each (`fireEvent`).
    /// An event with an `idempotencyKey` runs a listen once: a redelivery
    /// runs nothing. A dry run notes no receipt, so the real delivery after
    /// it still runs.
    pub async fn fire_event(&self, external: &str, event: &Js, dry_run: bool) -> Result<Fired, String> {
        self.fire_to(external, event, dry_run, |_| true).await
    }

    /// `fire_event`, to the listens `to` keeps of those the event reaches.
    async fn fire_to(&self, external: &str, event: &Js, dry_run: bool, to: impl Fn(&Listen) -> bool) -> Result<Fired, String> {
        let event_types = self.event_types_of(external).await?;
        let key = event.get("idempotencyKey").and_then(Js::as_str).filter(|k| !k.is_empty());
        let mut fired = Fired::default();
        for listen in self.listens.iter().filter(|l| l.adapter == external && event_matches_trigger_scope(event, &l.config) && to(l)) {
            let run_id = uuid::Uuid::new_v4().to_string();
            let file = &self.files[listen.file];
            let pipeline = format!("listen:{}:{}", file.name, listen.movement_name);
            if let Some(key) = key
                && !dry_run
                && !self.store.claim_event(&pipeline, key).map_err(|e| e.to_string())?
            {
                fired.redelivered.push(format!("{}:{} has run the event {key} before: this delivery runs nothing", file.name, listen.movement_name));
                continue;
            }
            let trigger = trigger_event_of(&pipeline, external, event, &event_types, &iso(0));
            fired.outcomes.push(self.run_listen(&run_id, listen, trigger, dry_run).await?);
        }
        Ok(fired)
    }

    /// `lf run <movement>`: one invocation on the manual unit, to the listens
    /// that fire `movement` (`listen to manual fire <movement>`).
    pub async fn run_manual(&self, movement: &str, text: Option<&str>, dry_run: bool) -> Result<Fired, String> {
        let manual = |l: &Listen| l.adapter == crate::units::MANUAL && l.movement_name == movement;
        if !self.listens.iter().any(manual) {
            return Err(format!("no listen fires '{movement}' on manual: add `listen to manual fire {movement}` to run it with `lf run {movement}`"));
        }
        let event = crate::units::manual_event(&iso(0), &self.user, text);
        self.fire_to(crate::units::MANUAL, &event, dry_run, |l| l.movement_name == movement).await
    }

    /// The cron unit's due ticks (scale from zero): for each cron listen, the
    /// latest occurrence since the last one it was fired for, fired once —
    /// a tick missed while no worker ran fires on the next drain, and the
    /// occurrence's receipt keeps a second worker from firing it again. A
    /// listen seen for the first time starts from now: nothing before it is
    /// owed.
    pub async fn fire_due_ticks(&self, log: &mut impl Write) -> Result<Vec<RunOutcome>, String> {
        let names = self.running.iter().filter(|r| !r.is_plugin()).map(|r| r.external.manifest.name.as_str());
        if crate::units::unit_named(crate::units::CRON, names).is_none() {
            return Ok(Vec::new());
        }
        let now = iso(self.due_offset_ms);
        let now_ms = crate::units::ms_of(&now).ok_or("the clock reads no instant")?;
        let mut outcomes = Vec::new();
        for (index, listen) in self.listens.iter().enumerate().filter(|(_, l)| l.adapter == crate::units::CRON) {
            let Some(schedule) = listen.config.get("schedule").and_then(Js::as_str) else { continue };
            let timezone = listen.config.get("timezone").and_then(Js::as_str);
            let file = &self.files[listen.file];
            let subscription = format!("cron:{}:{}:{schedule}:{}", file.name, listen.movement_name, timezone.unwrap_or("UTC"));
            let after = self.store.inbound_checkpoint(&subscription).map_err(|e| e.to_string())?;
            let Some(after_ms) = after.as_ref().and_then(|c| c.get("after")).and_then(Js::as_str).and_then(crate::units::ms_of) else {
                self.store.save_inbound_checkpoint(&subscription, &Js::Obj(obj! { "after" => Js::str(&now) })).map_err(|e| e.to_string())?;
                continue;
            };
            let parsed = match crate::units::parse_schedule(schedule, timezone) {
                Ok(parsed) => parsed,
                Err(message) => {
                    let _ = writeln!(log, "{}:{} schedule \"{schedule}\": {message}", file.name, listen.movement_name);
                    continue;
                }
            };
            let Some(due_ms) = parsed.latest_in(after_ms, now_ms) else { continue };
            let due = crate::units::iso_of(due_ms);
            let event = crate::units::tick_event(&due, schedule, timezone);
            let fired = self.fire_to(crate::units::CRON, &event, false, |l| std::ptr::eq(l, &self.listens[index])).await?;
            self.store.save_inbound_checkpoint(&subscription, &Js::Obj(obj! { "after" => Js::str(&due) })).map_err(|e| e.to_string())?;
            outcomes.extend(fired.outcomes);
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
        let ran = match self.segment(run_id, facts, fence, captured.is_some(), entry).await {
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

    /// One engine segment of the run, entered as `entry`, under `fence`.
    async fn segment(&self, run_id: &str, facts: &RunFacts, fence: Option<&str>, dry_run: bool, entry: Entry) -> Result<Ran, Ended> {
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
            public_url: self.public_url.clone(),
        });
        let input = SegmentInput {
            source: &facts.source,
            language_version: facts.language_version,
            movement_name: &facts.movement_name,
            event: &facts.event,
            fired_at: &facts.fired_at,
            catalog: &self.catalog,
            dry_run,
            entry,
            cost_cap_microdollars: self.project.cost_cap_microdollars,
        };
        run_segment(&host, input).await
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
                    let parked = self.store.leaves(run_id, true, None, None).map_err(|e| e.to_string())?;
                    // Resuming a run paused at its cost cap resets its usage,
                    // as the platform's explicit resume does (limit_resume.ts).
                    if parked.iter().any(|l| l.reason == "limit") {
                        self.store.reset_spend_baseline(run_id).map_err(|e| e.to_string())?;
                    }
                    let leaves: Vec<String> = parked.into_iter().map(|l| l.address).collect();
                    drain_run(&*self.store, run_id, &leaves, None, lease, &stepper).await?
                }
                Drain::DueTimers => drain_due_timers(&*self.store, run_id, &self.due_by(), lease, &stepper).await?,
                Drain::Awaits(extra) => drain_awaits(&*self.store, run_id, extra, lease, &stepper).await?,
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
        let (_, mut outcomes) = self.drain_work(WORK_ROWS_PER_DRAIN, log).await?;
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
        let mut outcomes = self.fire_due_ticks(log).await?;
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
                let fired = self.fire_event(&text("external")?, &event, false).await?;
                for line in &fired.redelivered {
                    eprintln!("lf: {line}");
                }
                Ok((false, fired.outcomes))
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
                let team = payload.get("teamId").and_then(Js::as_str).unwrap_or(self.store.tenant()).to_string();
                let key = text("correlationKey")?;
                let parks = self.store.correlated(&adapter_type, &team, &key).map_err(|e| e.to_string())?;
                let mut by_run: IndexMap<String, Vec<String>> = IndexMap::new();
                for park in parks {
                    by_run.entry(park.run_id).or_default().push(park.address);
                }
                let (mut busy, mut outcomes) = (false, Vec::new());
                for (run_id, addresses) in by_run {
                    match self.drive_parked_run(&run_id, Drain::Awaits(addresses)).await? {
                        Parked::Busy => busy = true,
                        Parked::NotStepped => {}
                        Parked::Stepped(outcome) => outcomes.push(outcome),
                    }
                }
                Ok((busy, outcomes))
            }
            "fire_callback" => {
                let index = payload.get("callIndex").and_then(|n| if let Js::Num(n) = n { n.as_u64() } else { None });
                let index = index.ok_or("a fire_callback row has no callIndex")? as usize;
                Ok(match self.run_recorded_body(&text("callbackId")?, index).await? {
                    BodyRun::Ran(outcomes) => (false, outcomes),
                    BodyRun::Busy => (true, Vec::new()),
                    BodyRun::Refused => (false, Vec::new()),
                })
            }
            other => Err(format!("not a work kind: {other}")),
        }
    }
}

/// Which of a parked run's leaves a drain steps.
enum Drain {
    EveryParkedLeaf,
    DueTimers,
    /// The awaits resolvable now: those a woken key names, and those whose
    /// callback has a landed call.
    Awaits(Vec<String>),
}

/// `drainAwaits`: step every currently resolvable await leaf of one run under
/// the caller's lease, the callback-backed ones (`callbackAwaitKeeper`) and
/// the `extra` ones the caller already knows are resolvable, each once.
async fn drain_awaits(store: &dyn RunHostStore, run_id: &str, extra: &[String], lease: &Lease, stepper: &impl Stepper) -> Result<bool, String> {
    let mut addresses = resolvable_awaits(store, run_id).map_err(|e| e.to_string())?;
    for address in extra {
        if !addresses.contains(address) {
            addresses.push(address.clone());
        }
    }
    if addresses.is_empty() {
        return Ok(false);
    }
    drain_run(store, run_id, &addresses, None, lease, stepper).await
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

// ── Callbacks ───────────────────────────────────────────────────────────────

/// How long after a call its durable rows (its body's, its awaiters' wake)
/// come due. Its body runs at once when the run is free; the rows matter only
/// if this process dies first, so they wait well past a normal body.
const CALLBACK_BACKSTOP_MS: i64 = 30_000;

/// What calling a callback came to (`CallOutcome`).
pub struct Called {
    pub call: CallOutcome,
    /// The run was being stepped elsewhere: the body waits on its work row,
    /// due now, for whichever lf process drains next.
    pub queued: bool,
    pub outcomes: Vec<RunOutcome>,
}

/// Whether a recorded call's body ran (`RecordedBodyRun`). `Busy`: another
/// process holds the run, or the lease went before the body began, so the
/// body is left to its work row.
enum BodyRun {
    Ran(Vec<RunOutcome>),
    Busy,
    Refused,
}

/// What a body segment came to (`CallbackBodyOutcome`): a failed body fails
/// its segment, never the run.
enum BodyOutcome {
    Ran,
    Failed(String),
    Cancelled(Option<String>),
    LeaseLost,
}

/// What `runCallbackBody` came to under the lease.
enum UnderLease {
    Ran { outcome: BodyOutcome, body: Tally, stepped: Option<Tally> },
    NotStarted,
    /// Its callback is gone or closed, the call is not there or already
    /// started, or its run has ended.
    Refused,
}

impl Session {
    /// Call a callback (`callCallback`): validate and record the call (its
    /// body queued with it), then run the body now under the run's lease and
    /// wake whatever awaits the callback. The door (`POST /api/cb/<id>`) and
    /// `lf call` both come here.
    pub async fn call_callback(&self, id: &str, values: &Obj) -> Result<Called, String> {
        let backstop = iso(CALLBACK_BACKSTOP_MS);
        let call = record_callback_call(&*self.store, id, values, &backstop, &backstop).map_err(|e| e.to_string())?;
        let CallOutcome::Recorded { callback, call_index } = &call else { return Ok(Called { call, queued: false, outcomes: Vec::new() }) };
        let (callback_id, team_id, call_index) = (callback.id.clone(), callback.team_id.clone(), *call_index);
        match self.run_recorded_body(&callback_id, call_index).await? {
            BodyRun::Ran(outcomes) => Ok(Called { call, queued: false, outcomes }),
            BodyRun::Refused => Ok(Called { call, queued: false, outcomes: Vec::new() }),
            BodyRun::Busy => {
                // Held elsewhere: its row, due now, runs it once the run is free.
                queue_body(&*self.store, &callback_id, &team_id, call_index, &iso(0)).map_err(|e| e.to_string())?;
                Ok(Called { call, queued: true, outcomes: Vec::new() })
            }
        }
    }

    /// Run one recorded call's body under its run's lease, then the awaits
    /// it resolves (`runRecordedBody`).
    async fn run_recorded_body(&self, callback_id: &str, call_index: usize) -> Result<BodyRun, String> {
        let store_error = |e: crate::store::StoreError| e.to_string();
        let Some(callback) = self.store.callback(callback_id).map_err(store_error)? else { return Ok(BodyRun::Refused) };
        let Some(row) = self.store.run(&callback.run_id).map_err(store_error)? else { return Ok(BodyRun::Refused) };
        let run_id = row.id.clone();
        let held = with_run_lease(&*self.store, &run_id, async |lease: &Lease| self.callback_body_under(&row, callback_id, call_index, lease).await).await?;
        let Some(under) = held else { return Ok(BodyRun::Busy) };
        let (outcome, body, stepped) = match under? {
            UnderLease::NotStarted => return Ok(BodyRun::Busy),
            UnderLease::Refused => return Ok(BodyRun::Refused),
            UnderLease::Ran { outcome, body, stepped } => (outcome, body, stepped),
        };
        let mut called = self.settled_outcome(&run_id, "called", body, matches!(outcome, BodyOutcome::LeaseLost))?;
        if let BodyOutcome::Failed(error) = &outcome {
            called.error = Some(format!("the callback's body failed: {error}"));
        }
        let mut outcomes = vec![called];
        if let Some(stepped) = stepped.filter(|t| t.stepped > 0) {
            outcomes.push(self.settled_outcome(&run_id, "resumed", stepped, false)?);
        }
        Ok(BodyRun::Ran(outcomes))
    }

    /// `runCallbackBody`: everything that decides whether the body runs is
    /// read again here, under the lease; the body is marked started before it
    /// runs (at most once after start, a crash included), and the run's
    /// awaits on the callback are woken last, so what the body wrote is
    /// there for the continuation that reads it.
    async fn callback_body_under(&self, row: &crate::store::RunRow, callback_id: &str, call_index: usize, lease: &Lease) -> Result<UnderLease, String> {
        let store_error = |e: crate::store::StoreError| e.to_string();
        let fence = Some(lease.token.as_str());
        let Some(callback) = self.store.callback(callback_id).map_err(store_error)? else { return Ok(UnderLease::Refused) };
        let Some(call) = crate::callbacks::ledger(&callback).map_err(store_error)?.into_iter().nth(call_index) else { return Ok(UnderLease::Refused) };
        if refusal(&callback, CallFor::RecordedCall, &iso(0)).is_some() {
            return Ok(UnderLease::Refused);
        }
        if call.body_started_at.is_some() {
            return Ok(UnderLease::Refused);
        }
        let open = self.store.run(&callback.run_id).map_err(store_error)?.is_some_and(|r| r.status == "parked" || r.status == "running");
        if !open {
            return Ok(UnderLease::Refused);
        }
        if lease.is_lost() || !self.store.mark_callback_body_started(callback_id, call_index as i64, fence).map_err(store_error)? {
            return Ok(UnderLease::NotStarted);
        }
        let mut body = Tally::default();
        let outcome = self.callback_body_segment(row, &callback.state, &call.values, call_index, lease, &mut body).await?;
        match &outcome {
            BodyOutcome::LeaseLost => return Ok(UnderLease::Ran { outcome, body, stepped: None }),
            BodyOutcome::Cancelled(reason) => {
                fail_run(&*self.store, &callback.run_id, reason.as_deref().unwrap_or(CANCELLED_BY_OPERATOR), fence)?;
                return Ok(UnderLease::Ran { outcome, body, stepped: None });
            }
            BodyOutcome::Ran | BodyOutcome::Failed(_) => {}
        }
        let parks: Vec<String> = self
            .store
            .correlated(CALLBACK_AWAIT_TYPE, &callback.team_id, &callback.id)
            .map_err(store_error)?
            .into_iter()
            .filter(|p| p.run_id == callback.run_id)
            .map(|p| p.address)
            .collect();
        if parks.is_empty() {
            return Ok(UnderLease::Ran { outcome, body, stepped: None });
        }
        let Some(stepper) = self.parked_stepper(&callback.run_id, lease)? else { return Ok(UnderLease::Ran { outcome, body, stepped: None }) };
        drain_awaits(&*self.store, &callback.run_id, &parks, lease, &stepper).await?;
        let stepped = *stepper.tally.borrow();
        Ok(UnderLease::Ran { outcome, body, stepped: Some(stepped) })
    }

    /// A callback's body (`callbackBodySegment`): one engine segment entered
    /// at the callback, with the call's values.
    async fn callback_body_segment(&self, row: &crate::store::RunRow, state: &Js, values: &Obj, call_index: usize, lease: &Lease, tally: &mut Tally) -> Result<BodyOutcome, String> {
        if !matches!(state.get("version"), Some(Js::Num(_))) {
            return Ok(BodyOutcome::Failed("the callback holds no state to run its body from".into()));
        }
        let facts = RunFacts::of_row(&row.id, &row.input)?;
        tally.stepped += 1;
        let entry = Entry::Fire { state: state.clone(), values: values.clone(), call_index };
        Ok(match self.segment(&row.id, &facts, Some(&lease.token), false, entry).await {
            Err(Ended::LeaseLost) => BodyOutcome::LeaseLost,
            Err(Ended::Failed(message)) => BodyOutcome::Failed(message),
            Ok(ran) => {
                tally.writes += ran.writes;
                if ran.cancelled {
                    BodyOutcome::Cancelled(self.store.cancel_request(&row.id).map_err(|e| e.to_string())?.flatten())
                } else {
                    BodyOutcome::Ran
                }
            }
        })
    }
}

// ── Cancel ──────────────────────────────────────────────────────────────────

/// What `lf cancel` came to (`CancelOutcome`).
pub enum Cancelled {
    /// The run was not being stepped: it is settled failed now.
    Now,
    /// Another lf process is stepping it: its segment stops at the next
    /// statement boundary, and the run settles failed there.
    Requested,
}

/// `lf cancel <run>` (`cancelRun`): stamp the operator's request on the run's
/// row, then settle it through the core's cancel path (failed with the
/// reason, its live state torn down, its callbacks revoked) when no one
/// holds it. Settling starts no segment, so it needs no session.
pub async fn cancel_run(store: &dyn RunHostStore, run_id: &str, reason: Option<&str>) -> Result<Cancelled, String> {
    let row = store.run(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
    if row.status != "running" && row.status != "parked" {
        return Err(format!("run {run_id} is {}; there is nothing to cancel", row.status));
    }
    store.request_cancel(run_id, reason).map_err(|e| e.to_string())?;
    let held = with_run_lease(store, run_id, async |lease: &Lease| settle_if_cancel_requested(store, run_id, Some(&lease.token))).await?;
    match held {
        None => Ok(Cancelled::Requested),
        Some(settled) => settled.map(|_| Cancelled::Now),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(configured: (Option<&str>, Option<&str>), env: &[(&str, &str)]) -> (String, String) {
        let configured = (configured.0.map(str::to_string), configured.1.map(str::to_string));
        let user = local_identity(&configured, |k| env.iter().find(|(name, _)| *name == k).map(|(_, v)| v.to_string()));
        let text = |value: Option<&Js>| value.and_then(Js::as_str).unwrap_or_default().to_string();
        (text(user.get("principal").and_then(|p| p.get("id"))), text(user.get("email")))
    }

    #[test]
    fn the_acting_user_is_the_environments_then_lf_yamls_then_the_os_users() {
        let os = [("USER", "ada")];
        assert_eq!(identity((None, None), &os), ("local:ada".into(), "ada@localhost".into()));
        assert_eq!(identity((Some("grace"), Some("grace@acme.test")), &os), ("local:grace".into(), "grace@acme.test".into()));
        let overridden = [("USER", "ada"), ("LF_USER", "linus"), ("LF_USER_EMAIL", "linus@acme.test")];
        assert_eq!(identity((Some("grace"), Some("grace@acme.test")), &overridden), ("local:linus".into(), "linus@acme.test".into()));
        // Each part on its own: a name override keeps lf.yaml's email.
        assert_eq!(identity((Some("grace"), Some("grace@acme.test")), &[("LF_USER", "linus")]), ("local:linus".into(), "grace@acme.test".into()));
        assert_eq!(identity((None, None), &[("USERNAME", "win")]), ("local:win".into(), "win@localhost".into()));
        assert_eq!(identity((None, None), &[]), ("local:lf".into(), "lf@localhost".into()));
    }
}
