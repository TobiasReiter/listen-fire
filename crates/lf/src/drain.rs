//! `lf drain`: a worker over the work queue, the scale-from-zero shape
//! of the run host (plans/cloud-native-2026-10-06/10_run_host.md): start,
//! claim due work rows one at a time under their lease, run what each one
//! asks (a timer's resume, an await's wake, a queued event), and exit.
//!
//!   --until-idle      exit once no row is due for this worker
//!   --max-seconds N   claim nothing new once N seconds have passed
//!
//!   --kinds k1,k2     a pool: claim only work rows of these kinds
//!                     (crate::store::WORK_KINDS), and `cron` for the cron
//!                     listens' due ticks, which are not rows
//!
//! With neither it polls forever, once a second while nothing is due. Any
//! number of workers can drain one Postgres store at once: a row is claimed
//! by one of them (SKIP LOCKED), and a run is stepped by whoever holds its
//! lease, so every run's work is done once.

use std::io::Write;
use std::time::{Duration, Instant};

use crate::runs::{Session, report};
use crate::store::WORK_KINDS;

/// One row per claim, so workers draining one queue share it row by row.
const ROWS_PER_CLAIM: i64 = 1;
const IDLE_POLL: Duration = Duration::from_secs(1);

/// CRON names the cron listens' tick check in a pool: the one share of a
/// drain that is not a work row (a tick fires from its checkpoint).
pub const CRON: &str = "cron";

/// Which work one worker takes: every kind, or a pool's (`--kinds`), so
/// polls, run steps and callbacks can be drained by separately sized fleets.
#[derive(Debug, Clone, PartialEq)]
pub struct Pool {
    /// The work rows' kinds; None: every kind.
    rows: Option<Vec<String>>,
    cron: bool,
}

impl Default for Pool {
    fn default() -> Pool {
        Pool { rows: None, cron: true }
    }
}

impl Pool {
    /// `--kinds poll_listen,cron`: each a work kind or `cron`.
    pub fn of(list: &str) -> Result<Pool, String> {
        let kinds: Vec<&str> = list.split(',').map(str::trim).filter(|k| !k.is_empty()).collect();
        if kinds.is_empty() {
            return Err("--kinds names no kind".into());
        }
        if let Some(other) = kinds.iter().find(|k| **k != CRON && !WORK_KINDS.contains(k)) {
            return Err(format!("--kinds {other}: not a kind of work (the kinds: {}, {CRON})", WORK_KINDS.join(", ")));
        }
        Ok(Pool { rows: Some(kinds.iter().filter(|k| **k != CRON).map(|k| k.to_string()).collect()), cron: kinds.contains(&CRON) })
    }

    pub fn fires_cron(&self) -> bool {
        self.cron
    }

    pub fn takes(&self, kind: &str) -> bool {
        self.rows.as_ref().is_none_or(|k| k.iter().any(|k| k == kind))
    }

    /// The work rows' kinds the store is asked for; None for every kind.
    pub fn work_kinds(&self) -> Option<&[String]> {
        self.rows.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pool_names_work_kinds_and_cron() {
        let pool = Pool::of("poll_listen, cron").unwrap();
        assert!(pool.fires_cron() && pool.takes("poll_listen") && !pool.takes("resume_timer"));
        assert_eq!(pool.work_kinds(), Some(&["poll_listen".to_string()][..]));
        let runs = Pool::of("fire_event,resume_timer").unwrap();
        assert!(!runs.fires_cron() && !runs.takes("poll_listen"));
        assert!(Pool::of("poll").unwrap_err().contains("not a kind of work"));
        assert!(Pool::of(",").is_err());
        let all = Pool::default();
        assert!(all.fires_cron() && all.takes("fire_callback") && all.work_kinds().is_none());
    }
}

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
