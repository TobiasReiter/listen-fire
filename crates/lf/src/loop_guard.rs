//! The loop guard slot (docs/contracts/loop-guard-slot.md): a module that
//! keeps a run's own writes from firing it again. Empty unless lf.yaml's
//! `core:` names one; with none, a movement writing to the source it listens
//! to hears its own write come back and runs again.
//!
//! The host's part is small. After a run writes a record to a source that
//! can echo it (one that sends webhooks or is polled, and can read a record
//! back), it reads the record back and tells the guard (`record_write`).
//! When an inbound event names a record, it asks the guard whether the event
//! is the echo of a listen's own write (`is_echo`); an echo fires none of
//! that listen's movement. Everything else is the guard's: how long it
//! remembers, what "unchanged" means, where its memory lives.
//!
//! `@lf/fingerprint-guard`, the built-in, remembers a hash of the record as
//! the write left it for an hour, per record and writing movement. An event
//! is the write's echo while the record still hashes the same. Someone
//! else's change leaves it different, so it fires (the platform's authorship
//! rule: this change's author, never the record's identity forever); another
//! movement's listens hear the write, since reacting to what a movement
//! wrote is a legitimate chain. Its memory is a file of its own
//! (`.lf/guard.db`), or a Postgres database every lf worker shares (its
//! `lf_guard` schema); nothing of it is in the store slot.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use tokio_postgres::Client;

use crate::json::Js;
use crate::store::{iso, iso_at};

/// How long the built-in remembers a write: an echo arrives within it (a
/// webhook in seconds, a poll within its interval).
pub const REMEMBERED_MS: i64 = 60 * 60 * 1000;

/// One record write a segment made, with the record as the source answered
/// it right after.
#[derive(Debug, Clone, PartialEq)]
pub struct Wrote {
    /// The external written to (its manifest name).
    pub adapter: String,
    /// The record type the write named, which reading it back takes.
    pub record_type: String,
    pub external_id: String,
    /// `null` for a record that is gone.
    pub record: Js,
}

/// Whether an inbound event naming `external_id` on `adapter` is the echo of
/// `writer`'s own write (`listen:<file>:<movement>`). `current` is the record
/// as it stands now, once the guard has said which type to read.
#[derive(Debug, Clone, Copy)]
pub struct Asked<'a> {
    pub adapter: &'a str,
    pub external_id: &'a str,
    pub writer: &'a str,
    pub current: Option<Current<'a>>,
}

#[derive(Debug, Clone, Copy)]
pub struct Current<'a> {
    pub record_type: &'a str,
    pub record: &'a Js,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    Echo(bool),
    /// The guard needs the record as it stands, of this type, to say.
    Read { record_type: String },
}

pub trait LoopGuard: Send + Sync {
    /// `writer`'s write, remembered; its later write to the same record replaces it.
    fn record_write(&self, wrote: &Wrote, writer: &str) -> Result<(), String>;
    fn is_echo(&self, asked: &Asked) -> Result<Answer, String>;
}

/// A record's fingerprint: the hash of its JSON as the source answered it.
pub fn fingerprint(record: &Js) -> String {
    Sha256::digest(record.to_json().as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// The record an inbound event names: its `externalId`, if it carries one.
pub fn event_record(event: &Js) -> Option<&str> {
    event.get("externalId").and_then(Js::as_str).filter(|id| !id.is_empty())
}

/// The project's loop guard, if its slot is filled.
pub fn of_project(project: &crate::project::Project, env: &[(String, String)]) -> Result<Option<std::sync::Arc<dyn LoopGuard>>, String> {
    let Some(module) = &project.core.loop_guard else { return Ok(None) };
    let settings = crate::core::settings_of(&crate::secrets::load_secrets(project, env)?, module);
    Ok(Some(match &module.process {
        Some(process) => std::sync::Arc::new(crate::guard_module::ProcessGuard::start(&module.name, process, &settings)?),
        None => std::sync::Arc::new(FingerprintGuard::open(&settings, &project.root, &project.lf_dir)?),
    }))
}

// ── @lf/fingerprint-guard ───────────────────────────────────────────────────

pub struct FingerprintGuard {
    memory: Mutex<Memory>,
}

enum Memory {
    File(Connection),
    Postgres(Client),
}

const FILE_SCHEMA: &str = "
create table if not exists write_fingerprint (
  adapter text not null,
  external_id text not null,
  writer text not null,
  record_type text not null,
  fingerprint text not null,
  expires_at text not null,
  primary key (adapter, external_id, writer)
);";

const POSTGRES_SCHEMA: &str = "
create schema if not exists lf_guard;
create table if not exists lf_guard.write_fingerprint (
  adapter text not null,
  external_id text not null,
  writer text not null,
  record_type text not null,
  fingerprint text not null,
  expires_at timestamptz not null,
  primary key (adapter, external_id, writer)
);
create index if not exists write_fingerprint_expires_at on lf_guard.write_fingerprint (expires_at);";

/// The advisory lock the schema is created under: "lf-guard" as a number.
const SCHEMA_LOCK: i64 = 0x6c66_2d67_7561_7264;

impl FingerprintGuard {
    /// Open the guard's memory (creating it when missing): the `url`
    /// setting's Postgres database, else the `path` setting's file, else
    /// `.lf/guard.db`. Idempotent, so setup (`lf connect`) and use share it.
    pub fn open(settings: &BTreeMap<String, String>, root: &Path, lf_dir: &Path) -> Result<FingerprintGuard, String> {
        let memory = match settings.get("url").filter(|u| !u.is_empty()) {
            Some(url) => {
                let client = crate::pg_store::connect_client(url).map_err(|e| e.to_string())?;
                let failed = |e| crate::pg_store::failed(e).to_string();
                crate::pg_store::block_on(client.batch_execute(&format!("select pg_advisory_lock({SCHEMA_LOCK})"))).map_err(failed)?;
                let created = crate::pg_store::block_on(client.batch_execute(POSTGRES_SCHEMA)).map_err(failed);
                let _ = crate::pg_store::block_on(client.batch_execute(&format!("select pg_advisory_unlock({SCHEMA_LOCK})")));
                created?;
                Memory::Postgres(client)
            }
            None => {
                let path = match settings.get("path").filter(|p| !p.is_empty()) {
                    Some(path) => root.join(path),
                    None => lf_dir.join("guard.db"),
                };
                if let Some(folder) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                    std::fs::create_dir_all(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
                }
                let at = |e: rusqlite::Error| format!("{}: {e}", path.display());
                let db = Connection::open(&path).map_err(at)?;
                // Two lf processes may share the file.
                db.execute_batch("pragma journal_mode = wal; pragma busy_timeout = 5000;").map_err(at)?;
                db.execute_batch(FILE_SCHEMA).map_err(at)?;
                Memory::File(db)
            }
        };
        Ok(FingerprintGuard { memory: Mutex::new(memory) })
    }
}

impl LoopGuard for FingerprintGuard {
    fn record_write(&self, wrote: &Wrote, writer: &str) -> Result<(), String> {
        let (fingerprint, expires_at) = (fingerprint(&wrote.record), iso(REMEMBERED_MS));
        let memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        match &*memory {
            Memory::File(db) => {
                let failed = |e: rusqlite::Error| e.to_string();
                db.execute("delete from write_fingerprint where expires_at <= ?", params![iso(0)]).map_err(failed)?;
                db.execute(
                    "insert into write_fingerprint (adapter, external_id, writer, record_type, fingerprint, expires_at) values (?, ?, ?, ?, ?, ?) \
                     on conflict (adapter, external_id, writer) do update set record_type = excluded.record_type, fingerprint = excluded.fingerprint, expires_at = excluded.expires_at",
                    params![wrote.adapter, wrote.external_id, writer, wrote.record_type, fingerprint, expires_at],
                )
                .map_err(failed)?;
            }
            Memory::Postgres(client) => {
                let failed = |e| crate::pg_store::failed(e).to_string();
                crate::pg_store::block_on(client.execute("delete from lf_guard.write_fingerprint where expires_at <= now()", &[])).map_err(failed)?;
                crate::pg_store::block_on(client.execute(
                    "insert into lf_guard.write_fingerprint (adapter, external_id, writer, record_type, fingerprint, expires_at)
                     values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text::timestamptz)
                     on conflict (adapter, external_id, writer)
                     do update set record_type = excluded.record_type, fingerprint = excluded.fingerprint, expires_at = excluded.expires_at",
                    &[&wrote.adapter, &wrote.external_id, &writer, &wrote.record_type, &fingerprint, &expires_at],
                ))
                .map_err(failed)?;
            }
        }
        Ok(())
    }

    fn is_echo(&self, asked: &Asked) -> Result<Answer, String> {
        let now = iso_at(jiff::Timestamp::now().as_millisecond());
        let memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        let remembered: Option<(String, String)> = match &*memory {
            Memory::File(db) => db
                .query_row(
                    "select record_type, fingerprint from write_fingerprint where adapter = ? and external_id = ? and writer = ? and expires_at > ?",
                    params![asked.adapter, asked.external_id, asked.writer, now],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?,
            Memory::Postgres(client) => crate::pg_store::block_on(client.query_opt(
                "select record_type, fingerprint from lf_guard.write_fingerprint
                 where adapter = $1::text and external_id = $2::text and writer = $3::text and expires_at > $4::text::timestamptz",
                &[&asked.adapter, &asked.external_id, &asked.writer, &now],
            ))
            .map_err(|e| crate::pg_store::failed(e).to_string())?
            .map(|r| (r.get(0), r.get(1))),
        };
        Ok(match (remembered, asked.current) {
            (None, _) => Answer::Echo(false),
            (Some((record_type, _)), None) => Answer::Read { record_type },
            (Some((_, remembered)), Some(current)) => Answer::Echo(fingerprint(current.record) == remembered),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::obj;

    #[test]
    fn a_record_changed_by_anyone_has_another_fingerprint() {
        let written = Js::Obj(obj! { "description" => Js::str("Seen by lf") });
        let changed = Js::Obj(obj! { "description" => Js::str("Edited by Bob") });
        assert_eq!(fingerprint(&written), fingerprint(&written.clone()));
        assert_ne!(fingerprint(&written), fingerprint(&changed));
        assert_ne!(fingerprint(&written), fingerprint(&Js::Null));
    }

    fn guard() -> FingerprintGuard {
        let dir = std::env::temp_dir().join(format!("lf-guard-{}", uuid::Uuid::new_v4()));
        FingerprintGuard::open(&BTreeMap::new(), &dir, &dir.join(".lf")).unwrap()
    }

    fn wrote(description: &str) -> Wrote {
        Wrote { adapter: "attio".into(), record_type: "Companies".into(), external_id: "r1".into(), record: Js::Obj(obj! { "description" => Js::str(description) }) }
    }

    fn ask<'a>(guard: &FingerprintGuard, writer: &'a str, current: Option<&'a Js>) -> Answer {
        let current = current.map(|record| Current { record_type: "Companies", record });
        guard.is_echo(&Asked { adapter: "attio", external_id: "r1", writer, current }).unwrap()
    }

    #[test]
    fn an_unchanged_record_is_its_writers_echo_and_nobody_elses() {
        let guard = guard();
        guard.record_write(&wrote("Seen by lf"), "listen:sync:stamp").unwrap();
        let unchanged = wrote("Seen by lf").record;
        let edited = wrote("Edited by Bob").record;
        assert_eq!(ask(&guard, "listen:sync:stamp", None), Answer::Read { record_type: "Companies".into() });
        assert_eq!(ask(&guard, "listen:sync:stamp", Some(&unchanged)), Answer::Echo(true));
        assert_eq!(ask(&guard, "listen:sync:stamp", Some(&edited)), Answer::Echo(false));
        assert_eq!(ask(&guard, "listen:audit:log", None), Answer::Echo(false));
    }

    #[test]
    fn a_later_write_replaces_the_earlier_one() {
        let guard = guard();
        guard.record_write(&wrote("one"), "listen:sync:stamp").unwrap();
        guard.record_write(&wrote("two"), "listen:sync:stamp").unwrap();
        assert_eq!(ask(&guard, "listen:sync:stamp", Some(&wrote("one").record)), Answer::Echo(false));
        assert_eq!(ask(&guard, "listen:sync:stamp", Some(&wrote("two").record)), Answer::Echo(true));
    }
}
