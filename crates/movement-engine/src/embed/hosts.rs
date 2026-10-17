//! What a run asks of the world, one trait per host family. Each mirrors a
//! core slot (store, models, judge, files, adapters, modules, secrets,
//! clock and ids, trace); the run host's rules (leases, fencing, parking)
//! stay the engine's and the store's. A family a host leaves unfilled
//! refuses whatever is asked of it, naming the request, so a movement that
//! needs it fails loudly rather than silently doing nothing.
//!
//! These are the same requests the JSON boundary carries
//! (docs/contracts/host-families.md, crate::host builds each one): the typed
//! route reads them into these calls (super::serve), so there is one
//! engine and one request shape.

use serde::{Deserialize, Serialize};

use super::data::{Data, FileDescriptor, FileRef};

/// A request the host could not serve. The run fails with its message.
#[derive(Debug, Clone, PartialEq)]
pub struct HostFailure {
    pub message: String,
    /// The error's class, when the host has one (`LeaseLostError`, …).
    pub name: Option<String>,
}

impl HostFailure {
    pub fn new(message: impl Into<String>) -> HostFailure {
        HostFailure { message: message.into(), name: None }
    }

    /// A priced call (a model, the judge, a plugin, a file read) refused
    /// because the run's budget (its `budget` field) cannot cover it. The run
    /// ends at its cost cap where its own figures say the cap is met, and
    /// fails with this message where they do not.
    pub fn budget(message: impl Into<String>) -> HostFailure {
        HostFailure { message: message.into(), name: Some(BUDGET.into()) }
    }

    pub(crate) fn is_budget(&self) -> bool {
        self.name.as_deref() == Some(BUDGET)
    }
}

const BUDGET: &str = "budget";

impl From<String> for HostFailure {
    fn from(message: String) -> HostFailure {
        HostFailure::new(message)
    }
}

impl From<&str> for HostFailure {
    fn from(message: &str) -> HostFailure {
        HostFailure::new(message)
    }
}

pub type HostResult<T> = Result<T, HostFailure>;

pub(crate) fn unserved<T>(what: &str) -> HostResult<T> {
    Err(HostFailure::new(format!("this host does not serve {what}")))
}

/// What a paid service spent on one call, charged to the run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cost {
    /// Who charged it (`model:<id>`, `adapter:<slug>`, `plugin:<name>`).
    pub source: String,
    pub microdollars: f64,
}

/// A parked flow's state, as the engine wrote it. Opaque: a store keeps it
/// (serde writes it as JSON) and hands it back to resume from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ParkedState(pub(crate) serde_json::Value);

impl ParkedState {
    /// Parked on an `until`'s timer: woken, it tests its condition again
    /// rather than stepping past.
    pub(crate) fn is_until(&self) -> bool {
        let entries = self.0.get(1).and_then(serde_json::Value::as_array);
        entries.into_iter().flatten().any(|entry| entry.get(0).and_then(serde_json::Value::as_str) == Some("until") && entry.get(1) == Some(&serde_json::Value::Bool(true)))
    }
}

/// A finished branch's exports at a join, as the engine wrote them. Opaque,
/// as a parked state is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BranchExports(pub(crate) serde_json::Value);

// ── store ──

#[derive(Debug, Clone, PartialEq)]
pub struct TimerPark {
    pub address: String,
    pub state: ParkedState,
    /// When to resume it, an ISO 8601 instant.
    pub wake_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AwaitPark {
    pub address: String,
    pub state: ParkedState,
    /// Who wakes it: the awaitable adapter's type (or the callback
    /// identity) and its correlation key.
    pub adapter_type: String,
    pub correlation_key: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BranchExport {
    pub branch_address: String,
    pub branch_index: i64,
    pub exports: BranchExports,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CallbackMint {
    pub address: String,
    /// The fire-time parameters, `(name, type)`.
    pub params: Vec<(String, String)>,
    pub state: ParkedState,
    pub single_use: bool,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MintedCallback {
    pub id: String,
    pub url: String,
}

/// Where a run's parked flows live, and the run's control: its locks and
/// its cancel gate. `keeps_parks` false (the default) tells the engine the
/// host cannot park, and a `sleep` or an `await` fails the run.
pub trait Store {
    fn keeps_parks(&self) -> bool {
        false
    }
    fn commit_timer_park(&mut self, _park: TimerPark) -> HostResult<()> {
        unserved("park.sink.commitTimerPark")
    }
    fn commit_await_park(&mut self, _park: AwaitPark) -> HostResult<()> {
        unserved("park.sink.commitAwaitPark")
    }
    fn commit_suspension(&mut self, _address: &str, _state: ParkedState) -> HostResult<()> {
        unserved("park.sink.commitSuspension")
    }
    fn record_join(&mut self, _frame_address: &str, _parked_children: i64) -> HostResult<()> {
        unserved("park.sink.recordJoin")
    }
    /// A resumed branch completed: whether that closed its join.
    fn decrement_join(&mut self, _frame_address: &str, _branch_address: &str, _leaf_address: &str) -> HostResult<bool> {
        unserved("park.sink.decrementJoin")
    }
    fn persist_branch_export(&mut self, _frame_address: &str, _export: BranchExport) -> HostResult<()> {
        unserved("park.sink.persistBranchExport")
    }
    fn collect_branch_exports(&mut self, _frame_address: &str) -> HostResult<Vec<BranchExport>> {
        unserved("park.sink.collectBranchExports")
    }
    /// Every park at or below each prefix withdrawn (a race's losers).
    fn cancel_subtrees(&mut self, _subtree_addresses: &[String], _exclude_leaf: Option<&str>) -> HostResult<()> {
        unserved("park.sink.cancelSubtrees")
    }
    /// "Resume whatever is parked on this key."
    fn wake(&mut self, _adapter_type: &str, _correlation_key: &serde_json::Value) -> HostResult<()> {
        unserved("park.wake")
    }
    fn mint_callback(&mut self, _mint: CallbackMint) -> HostResult<MintedCallback> {
        unserved("park.callbacks.mint")
    }
    /// A callback's call ledger.
    fn callback_calls(&mut self, _callback_id: &serde_json::Value) -> HostResult<Data> {
        unserved("park.callbacks.calls")
    }
    /// A library's text kept once by its content: answered with its hash.
    fn save_source(&mut self, _source: &str) -> HostResult<String> {
        unserved("park.sources.save")
    }
    fn load_source(&mut self, _hash: &str) -> HostResult<Option<String>> {
        unserved("park.sources.load")
    }
    /// The cross-run write locks: answered with a token once held. One
    /// process running one segment at a time holds a lock as soon as it asks.
    fn acquire_locks(&mut self, names: &[String]) -> HostResult<String> {
        Ok(names.join(","))
    }
    fn release_locks(&mut self, _token: &str) -> HostResult<()> {
        Ok(())
    }
    /// The cancel gate, asked at statement boundaries.
    fn cancelled(&mut self) -> HostResult<bool> {
        Ok(false)
    }
}

// ── models and the judge ──

/// One model call: an extraction region's (`prompt` is the user message) or
/// the extraction call's (`blocks`, the last the shape).
#[derive(Debug, Clone, PartialEq)]
pub struct ModelCall {
    pub system: String,
    pub prompt: Prompt,
    pub label: String,
    pub model: String,
    pub effort: Option<String>,
    pub max_tokens: Option<u64>,
    /// The run's remaining budget, as the engine states it.
    pub budget: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Prompt {
    Message(String),
    Blocks(Vec<serde_json::Value>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelReply {
    /// The reply's JSON, as the model wrote it.
    pub parsed_json: Data,
    pub raw_text: Option<String>,
    pub cost: Vec<Cost>,
}

/// The models slot.
pub trait Models {
    fn call(&mut self, call: ModelCall) -> HostResult<ModelReply>;
}

#[derive(Debug, Clone, PartialEq)]
pub struct Arbitration {
    /// What the write asserts, and the records it might be.
    pub asserted: Data,
    pub candidates: Data,
    pub record_type: String,
    pub constraints: Data,
    pub language_version: u32,
    pub budget: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    /// Which candidate the write is, if any.
    pub index: Option<usize>,
    /// Why the judge could not judge, when it could not: the write then
    /// goes on without a match, as the engine's own rules leave it.
    pub judge_unavailable: Option<String>,
    pub cost: Vec<Cost>,
}

/// The judge slot: the fuzzy identity judge for `unique by`.
pub trait Judge {
    fn arbitrate(&mut self, arbitration: Arbitration) -> HostResult<Verdict>;
}

// ── files ──

#[derive(Debug, Clone, PartialEq)]
pub enum FileText {
    Text { text: String, raw_text_id: Option<String> },
    Unreadable { detail: Option<String> },
}

/// The files slot. A file the host makes is numbered by the host
/// (`FileRef::id`) and named back to it by that number.
pub trait Files {
    /// `FILE(content, type)`'s artifact, `kind` "pdf" or "text".
    fn render(&mut self, _content: &str, _kind: &str) -> HostResult<FileRef> {
        unserved("files.render")
    }
    fn file_text(&mut self, _file: &FileRef, _budget: &serde_json::Value) -> HostResult<(FileText, Vec<Cost>)> {
        unserved("files.resolveFileText")
    }
}

impl FileRef {
    /// A file the host made, numbered `id`.
    pub fn made(id: u32, descriptor: FileDescriptor) -> FileRef {
        FileRef { id, descriptor: Some(descriptor) }
    }
}

// ── adapters ──

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Source,
    Target,
}

/// `connect <adapter> using <credential>`, resolved for this run.
#[derive(Debug, Clone, PartialEq)]
pub struct AdapterRequest {
    pub adapter_type: String,
    pub credentials_id: Option<String>,
    pub construction_args: Vec<(String, String)>,
    pub role: Role,
    /// A rehearsal: the instance captures its writes and never makes them.
    pub dry_run: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AdapterInstance {
    /// The host's id for it, meaningful within the run.
    pub id: String,
    /// The adapter protocol methods it implements.
    pub methods: Vec<String>,
}

/// One adapter protocol call: `args` is its one argument object, the
/// position it reads from leading (`{position, …}`) when it has one.
#[derive(Debug, Clone, PartialEq)]
pub struct AdapterCall {
    pub instance: String,
    pub method: String,
    pub args: Data,
}

/// The adapter's own refusal, which a movement can see (`kind` is the
/// protocol's: `adapter_error`, `not_found`, …).
#[derive(Debug, Clone, PartialEq)]
pub struct AdapterError {
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AdapterReply {
    pub outcome: Result<Option<Data>, AdapterError>,
    pub cost: Vec<Cost>,
}

impl AdapterReply {
    pub fn ok(result: Data) -> AdapterReply {
        AdapterReply { outcome: Ok(Some(result)), cost: Vec::new() }
    }
    /// Answered with nothing (`undefined`).
    pub fn nothing() -> AdapterReply {
        AdapterReply { outcome: Ok(None), cost: Vec::new() }
    }
    pub fn error(kind: impl Into<String>, message: impl Into<String>) -> AdapterReply {
        AdapterReply { outcome: Err(AdapterError { kind: kind.into(), message: message.into() }), cost: Vec::new() }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActingUser {
    pub id: String,
    pub display: Option<String>,
    pub email: Option<String>,
}

/// The adapters slot: every system a movement reads or writes.
pub trait Adapters {
    fn resolve(&mut self, request: AdapterRequest) -> HostResult<AdapterInstance>;
    fn call(&mut self, call: AdapterCall) -> HostResult<AdapterReply>;
    /// `@user_*`: who caused the event, as the source instance says.
    fn acting_user(&mut self, _instance: &str, _event: &Data) -> HostResult<Option<ActingUser>> {
        Ok(None)
    }
}

// ── modules (plugins) ──

#[derive(Debug, Clone, PartialEq)]
pub struct PluginCall {
    /// The plugin as the catalog registers it.
    pub plugin: String,
    pub config: Data,
    /// The entity's fields so far.
    pub extracted_context: Data,
    pub budget: serde_json::Value,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PluginReply {
    pub text: Option<String>,
    pub data: Option<Data>,
    pub records: Option<Vec<Data>>,
    pub outcome: Option<Data>,
    pub cost: Vec<Cost>,
}

/// The modules slot's plugins: a call a movement makes by name.
pub trait Modules {
    fn invoke(&mut self, call: PluginCall) -> HostResult<PluginReply>;
}

// ── secrets ──

/// The secrets slot: the credential a movement's `using <name>` names, as
/// the id an adapter is resolved with. The engine never sees a secret.
pub trait Secrets {
    fn credential_id(&mut self, name: &str) -> Option<String>;
}

// ── clock and ids ──

/// The clock and ids slot: the engine reads no clock and mints no id of its
/// own.
pub trait Clock {
    /// Now, an ISO 8601 instant (`Date.toISOString`'s form).
    fn now_iso(&mut self) -> String;
    /// `count` fresh, distinct ids.
    fn mint_ids(&mut self, count: usize) -> Vec<String>;
}

// ── trace ──

#[derive(Debug, Clone, PartialEq)]
pub struct LogLine {
    pub level: String,
    pub message: String,
    pub fields: serde_json::Value,
}

/// The trace slot: the run's trace entries as they land, and its log lines.
pub trait Trace {
    fn append(&mut self, entries: Vec<Data>) -> HostResult<()>;
    fn log(&mut self, _line: LogLine) {}
}
