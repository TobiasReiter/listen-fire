//! `lf-host drain`: a worker over the work queue, the scale-from-zero shape
//! of the run host (plans/cloud-native-2026-10-06/10_run_host.md): start,
//! claim due work rows one at a time under their lease, run what each one
//! asks (a timer's resume, an await's wake, a queued event), and exit.
//!
//!   --until-idle      exit once no row is due for this worker
//!   --max-seconds N   claim nothing new once N seconds have passed
//!
//! With neither it polls forever, once a second while nothing is due. Any
//! number of workers can drain one Postgres store at once: a row is claimed
//! by one of them (SKIP LOCKED), and a run is stepped by whoever holds its
//! lease, so every run's work is done once.

use std::io::Write;
use std::time::{Duration, Instant};

use crate::runs::{Session, report};

/// One row per claim, so workers draining one queue share it row by row.
const ROWS_PER_CLAIM: i64 = 1;
const IDLE_POLL: Duration = Duration::from_secs(1);

pub struct DrainOptions {
    pub until_idle: bool,
    pub max_seconds: Option<u64>,
}

/// Each run a row stepped is reported as `lf resume` reports it, as it
/// ends. The exit code is 1 when any of them failed.
pub async fn drain(session: &Session, options: &DrainOptions, out: &mut impl Write) -> Result<i32, String> {
    let deadline = options.max_seconds.map(|s| Instant::now() + Duration::from_secs(s));
    let past_deadline = || deadline.is_some_and(|d| Instant::now() >= d);
    let mut code = 0;
    while !past_deadline() {
        // As `lf resume`: a row that fails is retried later, its reason on stderr.
        let (claimed, outcomes) = session.drain_work(ROWS_PER_CLAIM, &mut std::io::stderr()).await?;
        if !outcomes.is_empty() {
            code = code.max(report(&outcomes, out)?);
            out.flush().map_err(|e| e.to_string())?;
        }
        if claimed > 0 {
            continue;
        }
        if options.until_idle {
            break;
        }
        let wait = deadline.map_or(IDLE_POLL, |d| IDLE_POLL.min(d.saturating_duration_since(Instant::now())));
        tokio::time::sleep(wait).await;
    }
    Ok(code)
}
