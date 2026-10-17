//! The secrets host family, as the TypeScript lf drives it (movement-engine
//! services/secrets/family.ts): where a credential's fields are read from,
//! written back to and refreshed through, whatever stores them (a plain or
//! SOPS file, the environment). A store implements `SecretsBackend`; every
//! caller goes through the one `SecretsFamily`, so the rules a refresh keeps
//! are stated once:
//!
//! - A write-back names the version it was computed from, and is refused when
//!   the stored credential has moved on (compare-and-swap).
//! - A refresh runs at most once at a time per credential: in this process by
//!   sharing the one in flight, across processes by the store's lock file (the
//!   same `<secrets file>.lock` the TypeScript lf takes, so the two binaries
//!   never refresh at once). The refresher runs only if the stored credential
//!   is still the one the caller found stale.
//! - A store that could not keep a rotated token refuses before the token is
//!   spent.
//! - No secret value reaches a warning or an error message.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime};

use sha2::{Digest, Sha256};

/// A credential's fields, every value a string (`expires_at` an ISO time).
pub type Fields = BTreeMap<String, String>;

/// A credential as stored, with the version a write-back must name.
#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    pub fields: Fields,
    /// Opaque; changes whenever the stored credential changes.
    pub version: String,
}

impl Record {
    pub fn of(fields: Fields) -> Record {
        let version = content_version(&fields);
        Record { fields, version }
    }
}

pub enum WriteBack {
    Written(Record),
    /// Kept for this process only (the environment); `why` names no value.
    NotPersisted { record: Record, why: String },
    Conflict(Record),
    Missing,
}

/// What a store implements. `reference` is the store's own name for a
/// credential: its name in a secrets file.
pub trait SecretsBackend {
    fn resolve(&self, reference: &str) -> Result<Option<Record>, String>;
    /// Merge `fields` over the stored ones, if the stored version is still `expected`.
    fn write_back(&self, reference: &str, fields: &Fields, expected: &str) -> Result<WriteBack, String>;
    /// The file whose lock (`<file>.lock`) every holder of the store takes,
    /// other processes included. None: the store has one process.
    fn locked_file(&self) -> Option<PathBuf> {
        None
    }
    /// Refuse, before a refresh spends a refresh token, when a write-back could not be stored.
    fn assert_writable(&self, _reference: &str) -> Result<(), String> {
        Ok(())
    }
}

/// The family's refusals, by the TypeScript error each stands for.
#[derive(Debug, Clone, PartialEq)]
pub enum SecretError {
    Missing(String),
    Conflict(String),
    RefreshFailed { reference: String, detail: String },
    /// The store itself failed (sops could not run, the lock stayed held).
    Store(String),
}

impl SecretError {
    pub fn message(&self) -> String {
        match self {
            SecretError::Missing(reference) => format!("credential \"{reference}\" is not stored"),
            SecretError::Conflict(reference) => format!("credential \"{reference}\" changed since it was read; the write-back was refused"),
            SecretError::RefreshFailed { reference, detail } => format!("refreshing credential \"{reference}\" failed: {detail}"),
            SecretError::Store(message) => message.clone(),
        }
    }

    /// The TypeScript error's `name`.
    pub fn name(&self) -> &'static str {
        match self {
            SecretError::Missing(_) => "SecretMissing",
            SecretError::Conflict(_) => "SecretVersionConflict",
            SecretError::RefreshFailed { .. } => "SecretRefreshFailed",
            SecretError::Store(_) => "Error",
        }
    }
}

impl From<SecretError> for String {
    fn from(error: SecretError) -> String {
        error.message()
    }
}

pub type LocalFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// Computes the fields a refresh changes from the credential as stored.
pub type Refresher<'a> = dyn Fn(Record) -> LocalFuture<'a, Result<Fields, String>> + 'a;

type Flight = Rc<RefCell<Option<Result<Record, SecretError>>>>;

pub struct SecretsFamily {
    backend: Box<dyn SecretsBackend>,
    cache: RefCell<HashMap<String, Record>>,
    flights: RefCell<HashMap<String, Flight>>,
    /// Credentials whose lock this process holds now.
    held: Rc<RefCell<HashSet<String>>>,
    warned: RefCell<HashSet<String>>,
    warn: Box<dyn Fn(&str)>,
}

const POLL: Duration = Duration::from_millis(20);
/// As the TypeScript lf: how long a lock is waited for, and when one left by
/// a process that died is taken over.
const LOCK_WAIT: Duration = Duration::from_secs(10);
const LOCK_STALE: Duration = Duration::from_secs(30);

impl SecretsFamily {
    pub fn new(backend: Box<dyn SecretsBackend>, warn: Box<dyn Fn(&str)>) -> SecretsFamily {
        SecretsFamily {
            backend,
            cache: RefCell::new(HashMap::new()),
            flights: RefCell::new(HashMap::new()),
            held: Rc::new(RefCell::new(HashSet::new())),
            warned: RefCell::new(HashSet::new()),
            warn,
        }
    }

    /// The credential, from the cache when it has been read before.
    pub fn resolve(&self, reference: &str) -> Result<Record, SecretError> {
        let cached = self.cache.borrow().get(reference).cloned();
        match cached {
            Some(record) => Ok(record),
            None => self.fresh(reference),
        }
    }

    /// Store `fields` over the credential at `expected`; a conflict when it has moved on.
    pub async fn write_back(&self, reference: &str, fields: &Fields, expected: &str) -> Result<Record, SecretError> {
        let _held = self.lock(reference).await?;
        let outcome = self.backend.write_back(reference, fields, expected).map_err(SecretError::Store)?;
        self.settle(reference, outcome, fields.values())
    }

    /// Store `fields` over whatever is stored now, under the lock.
    pub async fn update(&self, reference: &str, fields: &Fields) -> Result<Record, SecretError> {
        let _held = self.lock(reference).await?;
        let current = self.fresh(reference)?;
        let outcome = self.backend.write_back(reference, fields, &current.version).map_err(SecretError::Store)?;
        self.settle(reference, outcome, fields.values())
    }

    /// Refresh the credential the caller found stale at `seen_version`.
    pub async fn refresh(&self, reference: &str, seen_version: &str, refresher: &Refresher<'_>) -> Result<Record, SecretError> {
        let in_flight = self.flights.borrow().get(reference).cloned();
        if let Some(flight) = in_flight {
            loop {
                if let Some(outcome) = flight.borrow().clone() {
                    return outcome;
                }
                tokio::time::sleep(POLL).await;
            }
        }
        let flight: Flight = Rc::new(RefCell::new(None));
        self.flights.borrow_mut().insert(reference.to_string(), flight.clone());
        let outcome = self.refresh_now(reference, seen_version, refresher).await;
        *flight.borrow_mut() = Some(outcome.clone());
        self.flights.borrow_mut().remove(reference);
        outcome
    }

    async fn refresh_now(&self, reference: &str, seen_version: &str, refresher: &Refresher<'_>) -> Result<Record, SecretError> {
        let _held = self.lock(reference).await?;
        self.backend.assert_writable(reference).map_err(SecretError::Store)?;
        let current = self.fresh(reference)?;
        // Somebody refreshed it since the caller read it: theirs is the answer.
        if current.version != seen_version {
            return Ok(current);
        }
        let changed = refresher(current.clone()).await.map_err(|why| SecretError::RefreshFailed {
            reference: reference.to_string(),
            detail: redact_secrets(&why, current.fields.values()),
        })?;
        let outcome = self.backend.write_back(reference, &changed, &current.version).map_err(SecretError::Store)?;
        self.settle(reference, outcome, current.fields.values().chain(changed.values()))
    }

    fn fresh(&self, reference: &str) -> Result<Record, SecretError> {
        match self.backend.resolve(reference).map_err(SecretError::Store)? {
            Some(record) => {
                self.cache.borrow_mut().insert(reference.to_string(), record.clone());
                Ok(record)
            }
            None => {
                self.cache.borrow_mut().remove(reference);
                Err(SecretError::Missing(reference.to_string()))
            }
        }
    }

    fn settle<'v>(&self, reference: &str, outcome: WriteBack, values: impl Iterator<Item = &'v String>) -> Result<Record, SecretError> {
        match outcome {
            WriteBack::Written(record) => {
                self.cache.borrow_mut().insert(reference.to_string(), record.clone());
                Ok(record)
            }
            WriteBack::NotPersisted { record, why } => {
                self.cache.borrow_mut().insert(reference.to_string(), record.clone());
                if self.warned.borrow_mut().insert(reference.to_string()) {
                    (self.warn)(&redact_secrets(&why, values));
                }
                Ok(record)
            }
            WriteBack::Conflict(current) => {
                self.cache.borrow_mut().insert(reference.to_string(), current);
                Err(SecretError::Conflict(reference.to_string()))
            }
            WriteBack::Missing => {
                self.cache.borrow_mut().remove(reference);
                Err(SecretError::Missing(reference.to_string()))
            }
        }
    }

    /// This credential's lock: against this process's other callers, then
    /// against every other process through the store's lock file.
    async fn lock(&self, reference: &str) -> Result<Held, SecretError> {
        while self.held.borrow().contains(reference) {
            tokio::time::sleep(POLL).await;
        }
        self.held.borrow_mut().insert(reference.to_string());
        let mut held = Held { reference: reference.to_string(), set: self.held.clone(), file: None };
        if let Some(path) = self.backend.locked_file() {
            held.file = Some(FileLock::acquire(&path).await.map_err(SecretError::Store)?);
        }
        Ok(held)
    }
}

struct Held {
    reference: String,
    set: Rc<RefCell<HashSet<String>>>,
    file: Option<FileLock>,
}

impl Drop for Held {
    fn drop(&mut self) {
        drop(self.file.take());
        self.set.borrow_mut().remove(&self.reference);
    }
}

/// A secrets file's lock: `<file>.lock`, created exclusively beside it (the
/// TypeScript lf's `withFileLock`). One left by a process that died is taken
/// over once it is older than LOCK_STALE.
pub struct FileLock {
    lock: PathBuf,
}

impl FileLock {
    pub async fn acquire(path: &Path) -> Result<FileLock, String> {
        let mut name = path.as_os_str().to_owned();
        name.push(".lock");
        let lock = PathBuf::from(name);
        let started = Instant::now();
        loop {
            match create_exclusive(&lock) {
                Ok(()) => return Ok(FileLock { lock }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(format!("{}: {e}", lock.display())),
            }
            let stale = std::fs::metadata(&lock)
                .and_then(|m| m.modified())
                .is_ok_and(|at| SystemTime::now().duration_since(at).is_ok_and(|age| age > LOCK_STALE));
            if stale {
                let _ = std::fs::remove_file(&lock);
            }
            if started.elapsed() > LOCK_WAIT {
                return Err(format!(
                    "{} stayed locked by another lf for {}s ({})",
                    path.display(),
                    LOCK_WAIT.as_secs(),
                    lock.display()
                ));
            }
            tokio::time::sleep(POLL).await;
        }
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.lock);
    }
}

fn create_exclusive(path: &Path) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path).map(drop)
}

// ── Using a credential for one call ─────────────────────────────────────────

pub const REFRESH_WINDOW_MS: i64 = 30_000;

/// True when `expires_at` is within `window_ms` of now, or unreadable. A
/// credential that names no expiry is never stale by time.
pub fn expires_within(fields: &Fields, window_ms: i64, now_ms: i64) -> bool {
    let Some(at) = fields.get("expires_at") else { return false };
    match parse_instant_ms(at) {
        Some(ms) => ms - now_ms <= window_ms,
        None => true,
    }
}

/// An ISO instant as `Date.parse` reads the forms lf writes and people write.
pub fn parse_instant_ms(text: &str) -> Option<i64> {
    if let Ok(t) = text.parse::<jiff::Timestamp>() {
        return Some(t.as_millisecond());
    }
    // A date alone is midnight UTC, as `Date.parse` reads it.
    jiff::civil::Date::strptime("%Y-%m-%d", text).ok().and_then(|d| d.to_zoned(jiff::tz::TimeZone::UTC).ok()).map(|z| z.timestamp().as_millisecond())
}

/// `new Date(ms).toISOString()`.
pub fn iso_instant(ms: i64) -> String {
    jiff::Timestamp::from_millisecond(ms).map(|t| t.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()).unwrap_or_default()
}

pub fn now_ms() -> i64 {
    jiff::Timestamp::now().as_millisecond()
}

/// Run one call with a credential: refreshed first when it expires within the
/// window, and refreshed once more and retried when the call fails as
/// `unauthorized` says. Without a refresher, the call runs as it stands.
pub async fn with_secret<T, E, F, Fut>(
    family: &SecretsFamily,
    reference: &str,
    refresher: Option<&Refresher<'_>>,
    unauthorized: impl Fn(&E) -> bool,
    mut call: F,
) -> Result<T, E>
where
    E: From<SecretError>,
    F: FnMut(Record) -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    let mut record = family.resolve(reference)?;
    let Some(refresher) = refresher else { return call(record).await };
    if expires_within(&record.fields, REFRESH_WINDOW_MS, now_ms()) {
        record = family.refresh(reference, &record.version, refresher).await?;
    }
    match call(record).await {
        Err(error) if unauthorized(&error) => {
            // The record the call used: an update during it moved the cache on.
            let seen = family.resolve(reference)?.version;
            let record = family.refresh(reference, &seen, refresher).await?;
            call(record).await
        }
        answered => answered,
    }
}

// ── Versions and redaction ─────────────────────────────────────────────────

/// A version for a store that keeps the fields themselves: a hash of them,
/// order-independent (`contentVersion`).
pub fn content_version(fields: &Fields) -> String {
    let sorted: Vec<(&String, &String)> = fields.iter().collect();
    let text = serde_json::to_string(&sorted).unwrap_or_default();
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

const REDACTED: &str = "[redacted]";
/// Values this short are not worth hiding and would mangle ordinary words.
const MIN_REDACTED_LENGTH: usize = 4;

/// `text` with every occurrence of each value replaced, longest first.
pub fn redact_secrets<'v>(text: &str, values: impl Iterator<Item = &'v String>) -> String {
    let mut values: Vec<&String> = values.filter(|v| v.chars().count() >= MIN_REDACTED_LENGTH).collect();
    values.sort_by_key(|v| std::cmp::Reverse(v.len()));
    let mut out = text.to_string();
    for value in values {
        out = out.replace(value.as_str(), REDACTED);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// A store in memory, as the engine's vault.
    struct Memory {
        records: RefCell<HashMap<String, Fields>>,
        read_only: bool,
    }

    impl SecretsBackend for Memory {
        fn resolve(&self, reference: &str) -> Result<Option<Record>, String> {
            Ok(self.records.borrow().get(reference).cloned().map(Record::of))
        }
        fn write_back(&self, reference: &str, fields: &Fields, expected: &str) -> Result<WriteBack, String> {
            let Some(now) = self.resolve(reference)? else { return Ok(WriteBack::Missing) };
            if now.version != expected {
                return Ok(WriteBack::Conflict(now));
            }
            let mut merged = now.fields.clone();
            merged.extend(fields.clone());
            // A read-only store keeps it for this process, as the environment does.
            self.records.borrow_mut().insert(reference.to_string(), merged.clone());
            if self.read_only {
                return Ok(WriteBack::NotPersisted { record: Record::of(merged), why: format!("credential \"{reference}\" cannot be written back") });
            }
            Ok(WriteBack::Written(Record::of(merged)))
        }
    }

    fn fields(pairs: &[(&str, &str)]) -> Fields {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn family(read_only: bool, warnings: Rc<RefCell<Vec<String>>>) -> SecretsFamily {
        let records = HashMap::from([("acme".to_string(), fields(&[("access_token", "a0"), ("refresh_token", "r0")]))]);
        SecretsFamily::new(Box::new(Memory { records: RefCell::new(records), read_only }), Box::new(move |m| warnings.borrow_mut().push(m.to_string())))
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
    }

    #[test]
    fn a_write_back_at_a_moved_version_is_a_conflict() {
        block_on(async {
            let f = family(false, Rc::default());
            let seen = f.resolve("acme").unwrap();
            let after = f.write_back("acme", &fields(&[("access_token", "a1")]), &seen.version).await.unwrap();
            assert_eq!(after.fields["refresh_token"], "r0");
            let late = f.write_back("acme", &fields(&[("access_token", "a2")]), &seen.version).await.unwrap_err();
            assert_eq!(late, SecretError::Conflict("acme".into()));
            assert_eq!(f.resolve("acme").unwrap().fields["access_token"], "a1");
        });
    }

    #[test]
    fn two_concurrent_refreshes_call_the_refresher_once() {
        block_on(async {
            let f = family(false, Rc::default());
            let calls = Cell::new(0);
            let refresher = |_current: Record| -> LocalFuture<'_, Result<Fields, String>> {
                calls.set(calls.get() + 1);
                Box::pin(async {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    Ok(fields(&[("access_token", "a1")]))
                })
            };
            let seen = f.resolve("acme").unwrap().version;
            let (one, two) = tokio::join!(f.refresh("acme", &seen, &refresher), f.refresh("acme", &seen, &refresher));
            assert_eq!(calls.get(), 1);
            assert_eq!(one.unwrap().fields["access_token"], "a1");
            assert_eq!(two.unwrap().fields["access_token"], "a1");
        });
    }

    #[test]
    fn a_failed_refresh_names_no_secret_and_a_read_only_store_warns_once() {
        block_on(async {
            let warnings: Rc<RefCell<Vec<String>>> = Rc::default();
            let f = family(true, warnings.clone());
            let echo = |current: Record| -> LocalFuture<'_, Result<Fields, String>> {
                Box::pin(async move { Err(format!("invalid_grant for {}", current.fields["refresh_token"])) })
            };
            let seen = f.resolve("acme").unwrap().version;
            let failed = f.refresh("acme", &seen, &echo).await.unwrap_err();
            assert_eq!(failed.message(), "refreshing credential \"acme\" failed: invalid_grant for r0", "r0 is too short to redact");
            let first = f.write_back("acme", &fields(&[("access_token", "a1")]), &seen).await.unwrap();
            f.write_back("acme", &fields(&[("access_token", "a2")]), &first.version).await.unwrap();
            assert_eq!(warnings.borrow().len(), 1);
            assert_eq!(redact_secrets("token sekrit-1 and sekrit-12", [&"sekrit-1".to_string(), &"sekrit-12".to_string()].into_iter()), "token [redacted] and [redacted]");
        });
    }

    #[test]
    fn expiry_reads_iso_instants_and_dates() {
        let at = |s: &str| fields(&[("expires_at", s)]);
        let now = parse_instant_ms("2026-01-01T00:00:00Z").unwrap();
        assert!(expires_within(&at("2000-01-01T00:00:00Z"), REFRESH_WINDOW_MS, now));
        assert!(!expires_within(&at("2026-01-01T01:00:00.000Z"), REFRESH_WINDOW_MS, now));
        assert!(expires_within(&at("not a time"), REFRESH_WINDOW_MS, now));
        assert!(!expires_within(&Fields::new(), REFRESH_WINDOW_MS, now));
        assert_eq!(iso_instant(now + 1500), "2026-01-01T00:00:01.500Z");
        assert_eq!(parse_instant_ms("2026-01-01"), Some(now));
    }
}
