//! The host's adapters for one segment: the instances `adapters.resolve`
//! hands the engine an id for, and each `adapters.call` dispatched into one —
//! a port of movement-engine's `engine/adapter_table.ts` over its remote
//! adapter (`adapters/remote/index.ts`), since every external lf reaches
//! is a process speaking adapter protocol 2. The same rewriting the
//! TypeScript remote adapter does: a position's files in the wire's spelling,
//! a written file exposed at a URL the external fetches, a file read back
//! (only at a field the external's own catalog declares a file, or a
//! resource's `fileRef`) named as one this install owns. Every answer is held
//! to its protocol schema (crate::wire_results), every call counts against
//! the segment's ceiling (`REMOTE_ADAPTER_MAX_CALLS_PER_RUN`), and a
//! rehearsed instance (`dryRun`) captures its writes instead of making them
//! (`engine/dry_run_adapter.ts`).

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};

use crate::documents::Documents;
use crate::credential_calls::{Sending, Target, send};
use crate::externals::RunningExternal;
use crate::file_ref::{Owner, descriptor_of, owned_file_source, owner_of, wire_position, wire_resource_record, wire_resource_shaped, wire_source};
use crate::json::{Js, Obj};
use crate::obj;
use crate::project::Project;
use crate::protocol::RpcError;
use crate::secrets::{Credential, Credentials, credential_for, signer_of};
use crate::wire::{Hv, json_of_js};
use crate::wire_results;

/// `ADAPTER_METHODS`, in order: what an instance can be asked.
pub const ADAPTER_METHODS: &[&str] = &[
    "listEntryPoints",
    "describe",
    "edgesFrom",
    "resolveEntity",
    "getFieldValue",
    "getRelated",
    "iterateRelatedPage",
    "preprocessInbound",
    "listEventTypes",
    "createRecord",
    "updateRecord",
    "deleteRecord",
    "linkRecords",
    "unlinkRecords",
    "ensureEventSubscription",
    "removeEventSubscription",
    "resolveAwait",
    "wakeKeys",
    "readRecord",
    "translateFilter",
    "getDedupRules",
    "getActorCandidates",
    "extractActor",
    "describeOpaqueId",
    "invokeFieldFunction",
];

/// The adapter methods that change the external system: a dry run rehearses
/// the record writes instead of calling them, and a segment past its wall
/// clock still waits for any of these in flight rather than cut it off.
pub const WRITE_METHODS: &[&str] =
    &["createRecord", "updateRecord", "deleteRecord", "linkRecords", "unlinkRecords", "ensureEventSubscription", "removeEventSubscription"];

/// `OPTIONAL_REMOTE_METHODS`: a remote instance has one only when the
/// external advertises it.
const OPTIONAL_REMOTE_METHODS: &[&str] = &[
    "edgesFrom",
    "preprocessInbound",
    "listEventTypes",
    "readRecord",
    "describeOpaqueId",
    "translateFilter",
    "getDedupRules",
    "getActorCandidates",
    "extractActor",
    "resolveFileRef",
    "invokeFieldFunction",
    "linkRecords",
    "unlinkRecords",
    "ensureEventSubscription",
    "removeEventSubscription",
    "wakeKeys",
];

/// `RESOURCES_REFERENCE_FIELD_ID`.
const RESOURCES_REFERENCE_FIELD_ID: &str = "_resources";

/// The ceiling's knob and default (`segment_scope.ts`).
const CEILING_ENV: &str = "REMOTE_ADAPTER_MAX_CALLS_PER_RUN";
const DEFAULT_CEILING: u64 = 2000;

/// What the host's adapters reach: the project's started externals, the
/// credentials they are called under, and the document store files cross by.
pub struct Externals<'s> {
    pub project: &'s Project,
    pub running: &'s [RunningExternal],
    pub credentials: &'s Credentials,
    pub documents: &'s Documents,
    pub tenant: &'s str,
    /// The loopGuard slot's module, if one is named: record writes are read
    /// back for it.
    pub loop_guard: Option<&'s dyn crate::loop_guard::LoopGuard>,
}

/// A call's failure, as the engine is answered with it (`AdapterCallError`).
#[derive(Debug, Clone, PartialEq)]
pub enum CallFailure {
    /// The segment made as many calls as one may.
    Ceiling(String),
    /// What the adapter (or the call to it) failed with: its message, its
    /// own name, and the HTTP status it carries.
    Adapter { message: String, name: Option<String>, status: Option<u16> },
}

impl CallFailure {
    fn adapter(message: impl Into<String>) -> CallFailure {
        CallFailure::Adapter { message: message.into(), name: None, status: None }
    }

    pub fn message(&self) -> &str {
        match self {
            CallFailure::Ceiling(message) | CallFailure::Adapter { message, .. } => message,
        }
    }

    /// The error the TypeScript engine raises for it is named so.
    pub fn name(&self) -> Option<&str> {
        match self {
            CallFailure::Ceiling(_) => Some("AdapterCallCeilingExceeded"),
            CallFailure::Adapter { name, .. } => name.as_deref(),
        }
    }

    /// The answer's `error` (`AdapterCallError`).
    pub fn answer(&self) -> Js {
        match self {
            CallFailure::Ceiling(message) => Js::Obj(obj! { "kind" => Js::str("call_ceiling"), "message" => Js::str(message) }),
            CallFailure::Adapter { message, name, status } => {
                let mut out = obj! { "kind" => Js::str("adapter_error"), "message" => Js::str(message) };
                if let Some(name) = name {
                    out.insert("name".into(), Js::str(name));
                }
                if let Some(status) = status {
                    out.insert("detail".into(), Js::Obj(obj! { "status" => Js::Num((*status).into()) }));
                }
                Js::Obj(out)
            }
        }
    }
}

impl From<RpcError> for CallFailure {
    fn from(error: RpcError) -> CallFailure {
        CallFailure::Adapter { message: error.message(), name: Some(error.name().to_string()), status: error.status() }
    }
}

/// One instance a segment resolved.
struct Instance {
    id: String,
    /// A run host unit's instance answers in-process (crate::units).
    unit: Option<&'static str>,
    running: usize,
    /// The credential it is called under, by its index in the credentials.
    credential: Option<usize>,
    /// Its id as the descriptors it owns name it (`config.credentialsId`).
    credentials_id: String,
    /// What it was resolved as: a file's owner is matched by it.
    resolved_type: String,
    resolved_credential: Option<String>,
    dry_run: bool,
    cache_scope: String,
    /// The external's own catalog entries, by type, asked once each.
    described: RefCell<HashMap<String, Js>>,
}

/// The segment's adapters.
pub struct SegmentAdapters<'s> {
    segment_id: String,
    externals: &'s Externals<'s>,
    instances: RefCell<Vec<std::rc::Rc<Instance>>>,
    ids: RefCell<HashMap<String, String>>,
    /// Calls made to externals so far (the ceiling's count).
    calls: Cell<u64>,
    /// Ids a rehearsal invented, so a parent naming one reads as rehearsed.
    minted: RefCell<HashSet<String>>,
    /// The writes a rehearsed instance captured (`CapturedWrite`), in order.
    pub captured: RefCell<Vec<Js>>,
    /// The record writes made to sources that can echo them, read back for
    /// the loop guard (crate::loop_guard).
    pub wrote: RefCell<Vec<crate::loop_guard::Wrote>>,
}

impl<'s> SegmentAdapters<'s> {
    /// The project's externals, credentials and tenant this segment calls with.
    pub fn externals(&self) -> &'s Externals<'s> {
        self.externals
    }

    pub fn new(segment_id: &str, externals: &'s Externals<'s>) -> SegmentAdapters<'s> {
        SegmentAdapters {
            segment_id: segment_id.to_string(),
            externals,
            instances: RefCell::new(Vec::new()),
            ids: RefCell::new(HashMap::new()),
            calls: Cell::new(0),
            minted: RefCell::new(HashSet::new()),
            captured: RefCell::new(Vec::new()),
            wrote: RefCell::new(Vec::new()),
        }
    }

    /// `adapters.resolve`: the instance's id and what it is, as data.
    pub fn resolve(&self, adapter_type: &str, credentials_id: Option<&str>, construction_args: Option<&Obj>, dry_run: bool) -> Result<Js, String> {
        let mut args: Vec<(String, String)> = construction_args
            .map(|a| a.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect())
            .unwrap_or_default();
        args.sort();
        let key = serde_json::json!([adapter_type, credentials_id, args, dry_run]).to_string();
        let existing = self.ids.borrow().get(&key).cloned();
        let id = match existing {
            Some(id) => id,
            None => {
                let instance = self.construct(adapter_type, credentials_id, dry_run)?;
                let id = instance.id.clone();
                self.instances.borrow_mut().push(std::rc::Rc::new(instance));
                self.ids.borrow_mut().insert(key, id.clone());
                id
            }
        };
        let instance = self.instance(&id).map_err(|f| f.message().to_string())?;
        Ok(self.describe_instance(&instance))
    }

    fn construct(&self, adapter_type: &str, credentials_id: Option<&str>, dry_run: bool) -> Result<Instance, String> {
        let ext = self.externals;
        let names = ext.running.iter().filter(|r| !r.is_plugin()).map(|r| r.external.manifest.name.as_str());
        if let Some(unit) = crate::units::unit_named(adapter_type, names) {
            let next = self.instances.borrow().len() + 1;
            return Ok(Instance {
                id: format!("{}:{next}", self.segment_id),
                unit: Some(unit),
                running: usize::MAX,
                credential: None,
                credentials_id: String::new(),
                resolved_type: unit.to_string(),
                resolved_credential: None,
                dry_run,
                cache_scope: uuid::Uuid::new_v4().to_string(),
                described: RefCell::new(HashMap::new()),
            });
        }
        let Some(running) = ext.running.iter().position(|r| r.external.manifest.name == adapter_type) else {
            return Err(format!(
                "no external \"{adapter_type}\" in {} (install it as a folder there)",
                ext.project.externals_dir.display()
            ));
        };
        // A credential's id is its name in the secrets file.
        let credential = match credentials_id {
            Some(id) => Some(ext.credentials.iter().position(|c| c.name == id).ok_or_else(|| format!("no credential \"{id}\" in the secrets file"))?),
            None => credential_for(ext.credentials, adapter_type).and_then(|c| ext.credentials.iter().position(|o| std::ptr::eq(o, c))),
        };
        let credentials_id_of = credential.map(|i| ext.credentials[i].name.clone()).unwrap_or_default();
        let next = self.instances.borrow().len() + 1;
        Ok(Instance {
            id: format!("{}:{next}", self.segment_id),
            unit: None,
            running,
            credential,
            credentials_id: credentials_id_of,
            resolved_type: adapter_type.to_string(),
            resolved_credential: credentials_id.map(str::to_string),
            dry_run,
            cache_scope: uuid::Uuid::new_v4().to_string(),
            described: RefCell::new(HashMap::new()),
        })
    }

    fn instance(&self, id: &str) -> Result<std::rc::Rc<Instance>, CallFailure> {
        self.instances.borrow().iter().find(|i| i.id == id).cloned().ok_or_else(|| {
            CallFailure::adapter(format!("no adapter instance '{id}' in segment '{}': it was never resolved there", self.segment_id))
        })
    }

    fn running(&self, instance: &Instance) -> &RunningExternal {
        &self.externals.running[instance.running]
    }

    fn advertises(&self, instance: &Instance, method: &str) -> bool {
        self.running(instance).methods.iter().any(|m| m == method)
    }

    /// Whether the remote instance has `method` (the factory's pruning).
    fn has(&self, instance: &Instance, method: &str) -> bool {
        match method {
            "iterateRelatedPage" | "iterateRelated" => self.advertises(instance, "iterateRelated") || self.advertises(instance, "iterateRelatedPage"),
            "resolveAwait" => self.advertises(instance, "resolveAwait"),
            m if OPTIONAL_REMOTE_METHODS.contains(&m) => self.advertises(instance, m),
            _ => true,
        }
    }

    /// `describeInstance`.
    fn describe_instance(&self, instance: &Instance) -> Js {
        if let Some(unit) = instance.unit {
            return Js::Obj(obj! {
                "instance" => Js::str(&instance.id),
                "adapterType" => Js::str(unit),
                "supportedTriggers" => Js::strings(["webhook"]),
                "capabilities" => Js::Obj(Obj::new()),
                "methods" => Js::strings(crate::units::METHODS),
                "walksContainers" => Js::Bool(false),
                "webhookEventTypeId" => Js::str(crate::units::event_type_id(unit)),
            });
        }
        let running = self.running(instance);
        let mut methods: Vec<&str> = ADAPTER_METHODS.iter().copied().filter(|m| self.has(instance, m)).collect();
        if self.has(instance, "iterateRelated") {
            methods.push("iterateRelated");
        }
        let mut out = obj! {
            "instance" => Js::str(&instance.id),
            "adapterType" => Js::str(&running.external.manifest.name),
            "supportedTriggers" => Js::strings(&running.supported_triggers),
            "capabilities" => running.runtime_capabilities.clone(),
            "methods" => Js::strings(methods),
            // A remote graph may have containers: assume it does.
            "walksContainers" => Js::Bool(true),
        };
        if let Some(id) = &running.webhook_event_type_id {
            out.insert("webhookEventTypeId".into(), Js::str(id));
        }
        Js::Obj(out)
    }

    /// One protocol call under the instance's credential, counted against the
    /// segment's ceiling, its answer held to the method's schema.
    async fn rpc(&self, instance: &Instance, method: &str, params: Js) -> Result<Js, CallFailure> {
        self.count()?;
        let ext = self.externals;
        let running = self.running(instance);
        let credential: Option<&Credential> = instance.credential.map(|i| &ext.credentials[i]);
        let target = Target {
            external: &running.external,
            base_url: &running.base_url,
            declarations: &running.credential_declarations,
            methods: &running.methods,
            settings: &running.settings,
            limits: &running.limits,
        };
        let sending = Sending { tenant: ext.tenant, method, cache_scope_id: &instance.cache_scope, params: json_of_js(&params) };
        // The install's server secret signs a call made as a user credential.
        let signer = signer_of(ext.credentials, &running.external.manifest.name, credential);
        let raw = send(&target, ext.credentials, credential, signer, sending).await?;
        wire_results::check(method, &running.external.manifest.name, &raw)
            .map_err(|message| CallFailure::Adapter { message, name: Some("RemoteResponseShapeError".into()), status: None })
    }

    fn count(&self) -> Result<(), CallFailure> {
        let ceiling = std::env::var(CEILING_ENV).ok().and_then(|v| v.parse::<f64>().ok()).filter(|n| n.is_finite() && *n > 0.0);
        let ceiling = ceiling.map(|n| n as u64).unwrap_or(DEFAULT_CEILING);
        let next = self.calls.get() + 1;
        if next > ceiling {
            return Err(CallFailure::Ceiling(format!(
                "Remote adapter call ceiling reached: this run made {ceiling} Remote adapter API calls, the limit set by {CEILING_ENV}. The run was stopped in case something was looping."
            )));
        }
        self.calls.set(next);
        Ok(())
    }

    /// `adapters.call`: the method's result as data, or its failure.
    pub async fn call(&self, instance_id: &str, method: &str, args: &Hv) -> Result<Option<Js>, CallFailure> {
        let instance = self.instance(instance_id)?;
        if let Some(unit) = instance.unit {
            return crate::units::call(unit, method, args).map(Some).map_err(CallFailure::adapter);
        }
        let adapter_type = self.running(&instance).external.manifest.name.clone();
        if !self.has(&instance, method) && !(method == "iterateRelatedPage") {
            return Err(CallFailure::adapter(format!("the '{adapter_type}' adapter does not implement {method}")));
        }
        if instance.dry_run
            && let Some(rehearsed) = self.rehearse(&instance, &adapter_type, method, args)
        {
            return rehearsed.map(Some);
        }
        let plain = args.js();
        let member = |key: &str| plain.get(key).cloned();
        let answer = match method {
            "listEntryPoints" | "listEventTypes" => self.rpc(&instance, method, Js::Obj(Obj::new())).await?,
            "describe" => self.describe(&instance, member("typeId").as_ref().and_then(Js::as_str).unwrap_or_default()).await?,
            "edgesFrom" => {
                let mut params = obj! { "position" => args.get("position").map(wire_position).unwrap_or(Js::Null) };
                if let Some(cursor) = member("cursor") {
                    params.insert("cursor".into(), cursor);
                }
                self.rpc(&instance, method, Js::Obj(params)).await?
            }
            "getFieldValue" => {
                let value = self.rpc(&instance, method, with_wire_position(&plain, args)).await?;
                self.owned_field_value(&instance, args, value).await?
            }
            "getRelated" => {
                let related = self.rpc(&instance, method, with_wire_position(&plain, args)).await?;
                if member("fieldId").as_ref().and_then(Js::as_str) == Some(RESOURCES_REFERENCE_FIELD_ID) {
                    owned_resources(&instance, &adapter_type, related)
                } else {
                    related
                }
            }
            "iterateRelatedPage" => self.related_page(&instance, &plain, args).await?,
            "createRecord" => {
                let input = self.to_wire_write_input(&instance, &plain, args).await?;
                self.rpc(&instance, method, input).await?
            }
            "updateRecord" => {
                let input = self.to_wire_write_input(&instance, &plain, args).await?;
                let result = self.rpc(&instance, method, input).await?;
                with_association(result, &plain)
            }
            "resolveAwait" => {
                let mut params = obj! {
                    "recordId" => member("recordId").unwrap_or(Js::Null),
                    "edge" => member("edge").unwrap_or(Js::Null),
                };
                if let Some(head) = member("headData") {
                    params.insert("headData".into(), head);
                }
                self.rpc(&instance, method, Js::Obj(params)).await?
            }
            "ensureEventSubscription" => match self.rpc(&instance, method, plain.clone()).await? {
                Js::Null => return Ok(None),
                registered => registered,
            },
            "removeEventSubscription" => {
                self.rpc(&instance, method, plain.clone()).await?;
                Js::Null
            }
            _ => self.rpc(&instance, method, plain.clone()).await?,
        };
        if matches!(method, "createRecord" | "updateRecord" | "deleteRecord") {
            self.note_write(&instance, &plain, &answer).await;
        }
        Ok(Some(answer))
    }

    /// A record write to a source that can echo it back (it sends webhooks
    /// or is polled), with a loop guard in its slot: the record read back as
    /// the write left it, for the guard (crate::loop_guard). A source that
    /// can not read a record back is not compared, and a failed read only
    /// means its echo fires.
    async fn note_write(&self, instance: &Instance, plain: &Js, answer: &Js) {
        let running = self.running(instance);
        if self.externals.loop_guard.is_none() || (running.inbound.is_none() && running.poll_interval_seconds.is_none()) || !self.has(instance, "readRecord") || answer.get("notFound").is_some() {
            return;
        }
        let Some(record_type) = plain.get("recordType").and_then(Js::as_str) else { return };
        let Some(external_id) = answer.get("externalId").or_else(|| plain.get("externalId")).and_then(Js::as_str) else { return };
        let params = Js::Obj(obj! { "recordType" => Js::str(record_type), "externalId" => Js::str(external_id) });
        match self.rpc(instance, "readRecord", params).await {
            Ok(record) => self.wrote.borrow_mut().push(crate::loop_guard::Wrote {
                adapter: running.external.manifest.name.clone(),
                record_type: record_type.to_string(),
                external_id: external_id.to_string(),
                record,
            }),
            Err(failure) => eprintln!("lf: {}: reading {record_type} {external_id} back after writing it: {} (its echo will fire)", running.external.manifest.name, failure.message()),
        }
    }

    /// `describe`, remembered per type for the instance (a failure is not).
    async fn describe(&self, instance: &Instance, type_id: &str) -> Result<Js, CallFailure> {
        if let Some(described) = instance.described.borrow().get(type_id) {
            return Ok(described.clone());
        }
        let described = self.rpc(instance, "describe", Js::Obj(obj! { "typeId" => Js::str(type_id) })).await?;
        instance.described.borrow_mut().insert(type_id.to_string(), described.clone());
        Ok(described)
    }

    /// `getFieldValue`'s answer, a file where the external's catalog declares
    /// the field a file.
    async fn owned_field_value(&self, instance: &Instance, args: &Hv, value: Js) -> Result<Js, CallFailure> {
        if !matches!(value, Js::Obj(_) | Js::Arr(_)) {
            return Ok(value);
        }
        let record_type = args.get("position").and_then(|p| p.get("recordType")).and_then(Hv::as_str);
        let field_id = args.get("fieldId").and_then(Hv::as_str).unwrap_or_default();
        let Some(record_type) = record_type else { return Ok(value) };
        let adapter_type = self.running(instance).external.manifest.name.clone();
        let described = self.describe(instance, record_type).await.map_err(|cause| {
            CallFailure::Adapter {
                message: format!(
                    "Remote adapter \"{adapter_type}\": describe({}) failed, so whether {} holds a file is not known — {}",
                    Js::str(record_type).to_json(),
                    Js::str(field_id).to_json(),
                    cause.message()
                ),
                name: Some("RemoteDescribeFailed".into()),
                status: None,
            }
        })?;
        // The first field the catalog names so decides, as `find` does.
        let field = described.get("fields").and_then(Js::as_array).and_then(|fields| {
            fields.iter().find(|f| f.get("displayName").and_then(Js::as_str) == Some(field_id) || f.get("fieldId").and_then(Js::as_str) == Some(field_id))
        });
        if field.and_then(|f| f.get("kind")).and_then(Js::as_str) != Some("file") {
            return Ok(value);
        }
        Ok(match value {
            Js::Arr(items) => Js::Arr(items.iter().map(|m| owned_file(&adapter_type, &instance.credentials_id, m)).collect()),
            other => owned_file(&adapter_type, &instance.credentials_id, &other),
        })
    }

    /// One page of a traversal: the external's own page when it pages, else
    /// its whole `getRelated` as one page (`relatedPage`).
    async fn related_page(&self, instance: &Instance, plain: &Js, args: &Hv) -> Result<Js, CallFailure> {
        let mut input = match plain {
            Js::Obj(map) => map.clone(),
            _ => Obj::new(),
        };
        let cursor = input.shift_remove("cursor");
        if !self.has(instance, "iterateRelatedPage") {
            let mut params = input.clone();
            if let Some(position) = args.get("position") {
                params.insert("position".into(), wire_position(position));
            }
            let items = self.rpc(instance, "getRelated", Js::Obj(params)).await?;
            return Ok(Js::Obj(obj! { "items" => items }));
        }
        let method = if self.advertises(instance, "iterateRelatedPage") { "iterateRelatedPage" } else { "iterateRelated" };
        if let Some(position) = args.get("position") {
            input.insert("position".into(), wire_position(position));
        }
        input.insert("cursor".into(), cursor.unwrap_or(Js::Null));
        let page = self.rpc(instance, method, Js::Obj(input)).await?;
        let mut out = obj! { "items" => page.get("items").cloned().unwrap_or(Js::Arr(Vec::new())) };
        if let Some(next) = page.get("nextCursor").filter(|c| !matches!(c, Js::Null)) {
            out.insert("nextCursor".into(), next.clone());
        }
        Ok(Js::Obj(out))
    }

    /// `toWireWriteInput`: the parent set as a list, every file (in a field
    /// or a resource) exposed at a fetchable URL.
    async fn to_wire_write_input(&self, instance: &Instance, plain: &Js, args: &Hv) -> Result<Js, CallFailure> {
        let mut out = match plain {
            Js::Obj(map) => map.clone(),
            _ => Obj::new(),
        };
        if let Some(Hv::Obj(fields)) = args.get("fields") {
            let mut exposed = Obj::new();
            for (name, value) in fields {
                exposed.insert(name.clone(), self.expose_files(instance, value).await?);
            }
            out.insert("fields".into(), Js::Obj(exposed));
        }
        let links = match args.get("parentLinks") {
            Some(Hv::List(links)) => Js::Arr(
                links
                    .iter()
                    .map(|link| {
                        let mut written = match link.js() {
                            Js::Obj(map) => map,
                            _ => Obj::new(),
                        };
                        if let Some(data) = link.get("data") {
                            written.insert("data".into(), wire_resource_record(data));
                        }
                        Js::Obj(written)
                    })
                    .collect(),
            ),
            _ => Js::Arr(Vec::new()),
        };
        out.insert("parentLinks".into(), links);
        if let Some(Hv::List(resources)) = args.get("resources") {
            let mut written = Vec::new();
            for resource in resources {
                let exposed = self.expose_files(instance, resource).await?;
                written.push(wire_resource_shaped(&Hv::of_js(&exposed)));
            }
            out.insert("resources".into(), Js::Arr(written));
        }
        Ok(Js::Obj(out))
    }

    /// `exposeWriteFileRefs`: every file in a written value as the wire's
    /// spelling, its bytes at a URL.
    async fn expose_files(&self, instance: &Instance, value: &Hv) -> Result<Js, CallFailure> {
        let mut files = Vec::new();
        collect_files(value, &mut files);
        let mut wired = Vec::with_capacity(files.len());
        for descriptor in files {
            wired.push(self.file_to_wire(instance, &descriptor).await?);
        }
        let mut wired = wired.into_iter();
        Ok(rebuild_with_files(value, &mut wired))
    }

    /// `fileRefToWire`: the descriptor's metadata, its owner in the wire's
    /// spelling, and a fetchable `url`.
    async fn file_to_wire(&self, instance: &Instance, file: &Obj) -> Result<Js, CallFailure> {
        let mut out = obj! { "__brand" => Js::str("FileRef") };
        for key in ["name", "contentType", "size"] {
            if let Some(v) = file.get(key) {
                out.insert(key.into(), v.clone());
            }
        }
        if let Some(source) = wire_source(file.get("source")) {
            out.insert("source".into(), source);
        }
        if let Some(url @ Js::Str(_)) = file.get("url") {
            out.insert("url".into(), url.clone());
        } else if file.get("source").is_some() {
            let (bytes, content_type) = self.redeem(instance, file).await?;
            let url = self.externals.documents.expose(&bytes).await.map_err(CallFailure::adapter)?;
            out.insert("url".into(), Js::Str(url));
            if !out.contains_key("contentType")
                && let Some(content_type) = content_type
            {
                out.insert("contentType".into(), Js::Str(content_type));
            }
        }
        Ok(Js::Obj(out))
    }

    /// `redeemFileRef`: a file's bytes from its owner — the document store,
    /// or the external that owns it, through its `resolveFileRef`.
    async fn redeem(&self, _instance: &Instance, file: &Obj) -> Result<(Vec<u8>, Option<String>), CallFailure> {
        let ext = self.externals;
        match owner_of(file.get("source")) {
            Some(Owner::Document { object_uri }) => {
                if !ext.documents.owns(&object_uri, ext.tenant) {
                    return Err(CallFailure::adapter(format!("the file {object_uri} is not a stored document of this project")));
                }
                let bytes = ext.documents.open(&object_uri).map_err(CallFailure::adapter)?;
                Ok((bytes, file.get("contentType").and_then(Js::as_str).map(str::to_string)))
            }
            Some(Owner::Adapter { adapter_type, credential_id, handle }) => {
                let owners: Vec<_> = self
                    .instances
                    .borrow()
                    .iter()
                    .filter(|i| i.resolved_type == adapter_type || (i.unit.is_none() && self.running(i).external.manifest.name == adapter_type))
                    .filter(|i| credential_id.is_none() || i.resolved_credential == credential_id || Some(&i.credentials_id) == credential_id.as_ref())
                    .cloned()
                    .collect();
                let [owner] = owners.as_slice() else {
                    return Err(CallFailure::adapter(format!("no one instance of '{adapter_type}' in this segment owns the file {handle}")));
                };
                if !self.has(owner, "resolveFileRef") {
                    return Err(CallFailure::adapter(format!("the '{adapter_type}' adapter does not implement resolveFileRef")));
                }
                let mut reference = file.clone();
                let source = reference.shift_remove("source");
                if let Some(on_wire) = wire_source(source.as_ref()) {
                    reference.insert("source".into(), on_wire);
                }
                let resolved = self.rpc(owner, "resolveFileRef", Js::Obj(obj! { "ref" => Js::Obj(reference) })).await?;
                let url = resolved.get("url").and_then(Js::as_str).unwrap_or_default().to_string();
                let (bytes, fetched_type) = http_get(&url).await.map_err(CallFailure::adapter)?;
                let content_type = resolved.get("contentType").and_then(Js::as_str).map(str::to_string).or(fetched_type);
                Ok((bytes, content_type))
            }
            None => Err(CallFailure::adapter("a file with no owner has no bytes to send")),
        }
    }

    /// A rehearsed instance's write: captured, never made. None for a call
    /// a rehearsal passes through to the live instance.
    fn rehearse(&self, instance: &Instance, adapter_type: &str, method: &str, args: &Hv) -> Option<Result<Js, CallFailure>> {
        let plain = args.js();
        let text = |key: &str| plain.get(key).cloned().unwrap_or(Js::Null);
        let parents = || -> Option<Js> {
            let links = plain.get("parentLinks").and_then(Js::as_array).filter(|l| !l.is_empty())?;
            Some(Js::Arr(
                links
                    .iter()
                    .map(|link| {
                        let id = link.get("externalId").cloned().unwrap_or(Js::Null);
                        let mut out = obj! {
                            "edgeName" => link.get("edgeName").cloned().unwrap_or(Js::Null),
                            "recordType" => link.get("recordType").cloned().unwrap_or(Js::Null),
                            "externalId" => id.clone(),
                        };
                        if id.as_str().is_some_and(|id| self.minted.borrow().contains(id)) {
                            out.insert("rehearsed".into(), Js::Bool(true));
                        }
                        Js::Obj(out)
                    })
                    .collect(),
            ))
        };
        let capture = |mut write: Obj, parents: Option<Js>| {
            if let Some(parents) = parents {
                write.insert("parents".into(), parents);
            }
            self.captured.borrow_mut().push(Js::Obj(write));
        };
        let link_of = |plain: &Js| {
            let from = plain.get("from");
            let to = plain.get("to");
            obj! {
                "adapterType" => Js::str(adapter_type),
                "recordType" => from.and_then(|f| f.get("recordType")).cloned().unwrap_or(Js::Null),
                "externalId" => from.and_then(|f| f.get("externalId")).cloned().unwrap_or(Js::Null),
                "link" => Js::Obj(obj! {
                    "edgeName" => plain.get("edgeName").cloned().unwrap_or(Js::Null),
                    "toRecordType" => to.and_then(|t| t.get("recordType")).cloned().unwrap_or(Js::Null),
                    "toExternalId" => to.and_then(|t| t.get("externalId")).cloned().unwrap_or(Js::Null),
                }),
            }
        };
        Some(Ok(match method {
            "createRecord" => {
                let external_id = uuid::Uuid::new_v4().to_string();
                let parents = parents();
                self.minted.borrow_mut().insert(external_id.clone());
                capture(
                    obj! { "kind" => Js::str("create"), "adapterType" => Js::str(adapter_type), "recordType" => text("recordType"), "fields" => text("fields") },
                    parents,
                );
                Js::Obj(obj! { "adapterType" => Js::str(adapter_type), "externalId" => Js::Str(external_id), "data" => Js::Obj(Obj::new()) })
            }
            "updateRecord" => {
                let parents = parents();
                let association = if parents.is_none() { "none" } else { "made" };
                capture(
                    obj! {
                        "kind" => Js::str("update"),
                        "adapterType" => Js::str(adapter_type),
                        "recordType" => text("recordType"),
                        "fields" => text("fields"),
                        "externalId" => text("externalId"),
                    },
                    parents,
                );
                Js::Obj(obj! {
                    "adapterType" => Js::str(adapter_type),
                    "externalId" => text("externalId"),
                    "data" => Js::Obj(Obj::new()),
                    "association" => Js::str(association),
                })
            }
            "deleteRecord" => {
                capture(
                    obj! { "kind" => Js::str("delete"), "adapterType" => Js::str(adapter_type), "recordType" => text("recordType"), "externalId" => text("externalId") },
                    None,
                );
                Js::Obj(Obj::new())
            }
            "linkRecords" | "unlinkRecords" if self.advertises(instance, method) => {
                let mut write = obj! { "kind" => Js::str(if method == "linkRecords" { "link" } else { "unlink" }) };
                write.extend(link_of(&plain));
                capture(write, None);
                if method == "linkRecords" { Js::Obj(obj! { "created" => Js::Bool(true) }) } else { Js::Obj(obj! { "removed" => Js::Bool(true) }) }
            }
            _ => return None,
        }))
    }
}

/// `{...input, position: wirePosition(input.position)}`.
fn with_wire_position(plain: &Js, args: &Hv) -> Js {
    let mut out = match plain {
        Js::Obj(map) => map.clone(),
        other => return other.clone(),
    };
    if let Some(position) = args.get("position") {
        out.insert("position".into(), wire_position(position));
    }
    Js::Obj(out)
}

/// An update's answer: an external that says nothing of the parent it was
/// handed has told nothing, which reads as `unsupported`.
fn with_association(result: Js, input: &Js) -> Js {
    let Js::Obj(mut map) = result else { return result };
    if map.contains_key("notFound") || map.contains_key("association") {
        return Js::Obj(map);
    }
    let linked = input.get("parentLinks").and_then(Js::as_array).is_some_and(|l| !l.is_empty());
    map.insert("association".into(), Js::str(if linked { "unsupported" } else { "none" }));
    Js::Obj(map)
}

/// `ownedFile`: a file read off the wire named as one this install owns.
fn owned_file(adapter_type: &str, credentials_id: &str, value: &Js) -> Js {
    let Some(mut descriptor) = descriptor_of(value) else { return value.clone() };
    let source = descriptor.shift_remove("source");
    let handle = source
        .as_ref()
        .and_then(|s| s.get("handle"))
        .and_then(Js::as_str)
        .map(str::to_string)
        .or_else(|| descriptor.get("url").and_then(Js::as_str).map(str::to_string));
    if let Some(handle) = handle {
        descriptor.insert("source".into(), owned_file_source(adapter_type, credentials_id, &handle));
    }
    Js::Obj(descriptor)
}

/// `ownedResource` over a `_resources` reference's records.
fn owned_resources(instance: &Instance, adapter_type: &str, related: Js) -> Js {
    let Js::Arr(items) = related else { return related };
    Js::Arr(
        items
            .into_iter()
            .map(|mut item| {
                if let Js::Obj(item_map) = &mut item
                    && let Some(Js::Obj(position)) = item_map.get_mut("position")
                    && let Some(Js::Obj(identity)) = position.get_mut("identity")
                    && let Some(Js::Obj(data)) = identity.get_mut("data")
                    && let Some(slot) = data.get("fileRef").filter(|s| !matches!(s, Js::Null)).cloned()
                {
                    data.insert("fileRef".into(), owned_file(adapter_type, &instance.credentials_id, &slot));
                }
                item
            })
            .collect(),
    )
}

fn collect_files(value: &Hv, out: &mut Vec<Obj>) {
    match value {
        Hv::File { descriptor, .. } => out.push(descriptor.clone()),
        Hv::List(items) => items.iter().for_each(|i| collect_files(i, out)),
        Hv::Obj(entries) => entries.iter().for_each(|(_, v)| collect_files(v, out)),
        _ => {}
    }
}

fn rebuild_with_files(value: &Hv, wired: &mut impl Iterator<Item = Js>) -> Js {
    match value {
        Hv::File { .. } => wired.next().unwrap_or(Js::Null),
        Hv::List(items) => Js::Arr(items.iter().map(|i| rebuild_with_files(i, wired)).collect()),
        Hv::Obj(entries) => {
            let mut map = Obj::new();
            for (k, v) in entries {
                map.insert(k.clone(), rebuild_with_files(v, wired));
            }
            Js::Obj(map)
        }
        other => other.js(),
    }
}

/// A plain `GET`: the body and its content type.
async fn http_get(url: &str) -> Result<(Vec<u8>, Option<String>), String> {
    use http_body_util::{BodyExt, Empty};
    let rest = url.strip_prefix("http://").ok_or_else(|| format!("{url}: lf fetches files over plain http only"))?;
    let (authority, path) = rest.find('/').map(|at| (&rest[..at], &rest[at..])).unwrap_or((rest, "/"));
    let (host, port) = authority.rsplit_once(':').map(|(h, p)| (h, p.parse::<u16>().unwrap_or(80))).unwrap_or((authority, 80));
    let stream = tokio::net::TcpStream::connect((host, port)).await.map_err(|e| format!("{url}: {e}"))?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream)).await.map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let request = hyper::Request::get(path).header("host", authority).body(Empty::<bytes::Bytes>::new()).map_err(|e| e.to_string())?;
    let response = sender.send_request(request).await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("RemoteAdapter.resolveFileRef: fetch of resolved url failed (status {}).", response.status().as_u16()));
    }
    let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).map(str::to_string);
    let bytes = response.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes().to_vec();
    Ok((bytes, content_type))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_answers_as_an_adapter_call_error() {
        let ceiling = CallFailure::Ceiling("stop".into());
        assert_eq!(ceiling.answer().to_json(), r#"{"kind":"call_ceiling","message":"stop"}"#);
        let failed: CallFailure = RpcError::Transport { status: 502, method: "describe".into() }.into();
        assert_eq!(
            failed.answer().to_json(),
            r#"{"kind":"adapter_error","message":"Remote adapter transport error (HTTP 502) for method \"describe\"","name":"RemoteTransportError","detail":{"status":502}}"#
        );
    }

    #[test]
    fn an_update_that_says_nothing_of_its_parent_reads_unsupported() {
        let input = Js::parse(br#"{"parentLinks":[{"edgeName":"e"}]}"#).unwrap();
        let result = Js::parse(br#"{"adapterType":"a","externalId":"1","data":{}}"#).unwrap();
        assert_eq!(with_association(result.clone(), &input).get("association").and_then(Js::as_str), Some("unsupported"));
        let none = Js::parse(br#"{"parentLinks":[]}"#).unwrap();
        assert_eq!(with_association(result, &none).get("association").and_then(Js::as_str), Some("none"));
    }

    #[test]
    fn a_file_read_back_is_named_as_one_this_install_owns() {
        let read = Js::parse(br#"{"name":"r.pdf","url":"http://crm/r","source":{"ownerAdapterType":"crm","handle":"h1"}}"#).unwrap();
        assert_eq!(
            owned_file("crm", "acme", &read).to_json(),
            r#"{"__brand":"FileRef","name":"r.pdf","url":"http://crm/r","source":{"adapterType":"crm","credentialId":"acme","handle":"h1"}}"#
        );
        assert_eq!(owned_file("crm", "acme", &Js::str("x")), Js::str("x"));
    }
}
