//! The extraction keyword run whole (extraction.ts `Materializer`, run.ts
//! `runExtraction`): the spec built for this firing, the `from […]` data
//! read, its `through` pipeline run, one model call per through-free region
//! — validated, retried once, read — and per entity each later stage behind
//! its `through` fence, its fenced children, and its children in turn; the
//! files fetched given ids in the tree's order; the tree exported and bound.
//!
//! What runs side by side runs as the TypeScript runs it, at most
//! `STAGE_FAN_OUT` at a time (`map_concurrent`): a pipeline's plugins, a
//! node's fenced children, an entity's children. Each branch writes the trace
//! into a slice of its own, spliced back in the order the branches were
//! written, so the trace reads as the serial walk would. A call site is
//! numbered when its region is planned, as the TypeScript numbers it.
//!
//! Every host-visible step is the TypeScript's: `control.cancel.cancelled`
//! before each model call and each plugin launch, `clock.now` either side of
//! each, `llm.client.call` and `llm.transforms.invoke` priced (a priced
//! plugin refused before it starts once the cap is spent), `files.
//! resolveFileText` for a source file, `ids.mint` once per batch of
//! resources.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use movement_parser::ast::{self, ExprSlot};
use movement_parser::catalog::types::InstanceSchema;
use serde_json::{Map, Value as Json, json};

use crate::bindings::{Binding, Scope};
use crate::env;
use crate::executor::map_concurrent;
use crate::extract::emission::{self, Emission, Working};
use crate::extract::prompt::{self, Enrichment, Entity, Segment};
use crate::extract::resources::plugin_file_resources;
use crate::extract::spec::{self, Firing, NodeSpec, Region, SpecError, WordsScope};
use crate::extract::validate::{self, Coercions, Issue, PathKey};
use crate::host;
use crate::js::{self, Js, JsObject};
use crate::program::DeclaringFile;
use crate::run::{Failure, Run, Stop};
use crate::trace::{Members, TraceEntry};

/// How much of the walk runs at once, per fan (extraction.ts `STAGE_FAN_OUT`).
pub const STAGE_FAN_OUT: usize = 4;
/// Prompt parts kept per call on the trace; the rest are counted.
pub(crate) const TRACE_INPUT_PARTS: usize = 12;
/// How much of a misbehaving reply the trace keeps.
const TRACE_REPLY_CHARS: usize = 1000;
/// Reply digests kept per run.
pub(crate) const TRACE_REPLY_DIGESTS: usize = 5;
/// Validation issues quoted when the retry fires.
pub(crate) const TRACE_ISSUE_LINES: usize = 8;
pub(crate) const TRACE_URL_CHARS: usize = 200;
/// Entities declaring at least this many sites ask the larger model
/// (model_choice.ts `ENTITY_DENSITY_OPUS_THRESHOLD`).
const ENTITY_DENSITY_OPUS_THRESHOLD: usize = 30;
/// Extraction's own reasoning depth (ai_tiers.ts `EXTRACTION_EFFORT`).
const EXTRACTION_EFFORT: &str = "low";
/// The room a call that reasons gets (ai_tiers.ts `REASONING_OUTPUT_TOKENS`).
pub(crate) const REASONING_OUTPUT_TOKENS: u64 = 64000;

/// One model call's settings (`TierCallSettings` / `ExtractionCallSettings`).
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct CallSettings {
    pub model: String,
    pub effort: Option<String>,
    pub max_tokens: Option<u64>,
}

/// `aiTier`: a tier as written, its legacy spelling followed.
pub(crate) fn ai_tier(written: Option<&str>) -> Option<&'static str> {
    match written? {
        "quick" => Some("quick"),
        "careful" | "smart" => Some("careful"),
        "thorough" => Some("thorough"),
        _ => None,
    }
}

/// `roomToThink`: the ceiling a reasoning depth needs.
pub(crate) fn room_to_think(effort: Option<&str>) -> Option<u64> {
    matches!(effort, Some("high" | "xhigh")).then_some(REASONING_OUTPUT_TOKENS)
}

/// `extractionCallSettings`: the tier's row (built in, then this
/// deployment's assignment over it), or with no tier the density
/// heuristic's model at extraction's own depth.
pub(crate) fn extraction_call_settings(tier: Option<&str>, density_model: &str, tiers: &std::collections::BTreeMap<String, super::TierAssignment>) -> CallSettings {
    extraction_call_settings_over(tier, density_model, tiers, None, None)
}

/// `extractionCallSettings` with the author's own model and effort over
/// the row (the extraction call's `{ model, effort }`).
pub(crate) fn extraction_call_settings_over(
    tier: Option<&str>,
    density_model: &str,
    tiers: &std::collections::BTreeMap<String, super::TierAssignment>,
    model_over: Option<&str>,
    effort_over: Option<&str>,
) -> CallSettings {
    let Some(named) = ai_tier(tier) else {
        let effort = effort_over.unwrap_or(EXTRACTION_EFFORT).to_string();
        let max_tokens = room_to_think(Some(&effort));
        return CallSettings { model: model_over.unwrap_or(density_model).into(), effort: Some(effort), max_tokens };
    };
    let (mut row_model, mut effort) = match named {
        "careful" => ("sonnet".to_string(), "high".to_string()),
        "thorough" => ("sonnet".to_string(), "xhigh".to_string()),
        _ => ("sonnet".to_string(), EXTRACTION_EFFORT.to_string()),
    };
    if let Some(assigned) = tiers.get(named) {
        if let Some(m) = &assigned.model {
            row_model = m.clone();
        }
        if let Some(e) = &assigned.effort {
            effort = e.clone();
        }
    }
    if let Some(e) = effort_over {
        effort = e.to_string();
    }
    if let Some(m) = model_over {
        row_model = m.to_string();
    }
    let max_tokens = room_to_think(Some(&effort));
    CallSettings { model: row_model, effort: Some(effort), max_tokens }
}

/// `aiExpressionSettings`: an `AI(prompt[, tier])` call's.
pub(crate) fn ai_expression_settings(tier: Option<&str>) -> CallSettings {
    match ai_tier(tier) {
        Some("careful") => CallSettings { model: "sonnet".into(), effort: None, max_tokens: None },
        Some("thorough") => CallSettings { model: "opus5".into(), effort: None, max_tokens: Some(REASONING_OUTPUT_TOKENS) },
        _ => CallSettings { model: "haiku".into(), effort: Some(EXTRACTION_EFFORT.into()), max_tokens: None },
    }
}
const LABEL: &str = "movement_extraction";

/// A plugin's or a file reader's answer that held what the eval wire cannot
/// carry fails the statement here, where the TypeScript reads on ("Spec the
/// tail" in the README).
pub(crate) fn refuse_uncarried(answer: &Js, what: &str) -> Result<(), Failure> {
    let uncarried = uncarried(answer);
    if uncarried.is_empty() {
        return Ok(());
    }
    Err(Failure::unreproduced(
        &format!("{what} holding a `__proto__` key or a lone surrogate (in {})", uncarried.join(", ")),
        "the Rust engine reads only what its wire carries",
    ))
}

pub(crate) fn thrown(failure: Failure) -> Stop {
    Stop::Thrown(failure)
}

/// What one plugin invocation brought back (`TransformInvocationResult`).
#[derive(Debug, Clone, Default)]
pub(crate) struct PluginResult {
    pub(crate) text: Option<String>,
    /// An object, or absent.
    pub(crate) data: Option<Js>,
    pub(crate) records: Vec<Js>,
    /// `records` answered as something other than a list (or nothing),
    /// which a records output cannot map.
    pub(crate) records_not_a_list: bool,
    pub(crate) outcome: Option<String>,
}

impl PluginResult {
    fn of(answer: &Js) -> PluginResult {
        let member = |key: &str| crate::unique::get(&answer, key);
        let text = match member("text") {
            Js::String(text) => Some(text),
            _ => None,
        };
        let data = match member("data") {
            data @ Js::Object(_) => Some(data),
            _ => None,
        };
        let (records, records_not_a_list) = match member("records") {
            Js::Array(list) => (list.items().clone(), false),
            nullish if nullish.is_nullish() => (Vec::new(), false),
            _ => (Vec::new(), true),
        };
        let outcome = match member("outcome") {
            Js::String(outcome) if !outcome.is_empty() => Some(outcome),
            _ => None,
        };
        PluginResult { text, data, records, records_not_a_list, outcome }
    }

    /// `Object.keys(result.data ?? {})`.
    pub(crate) fn data_keys(&self) -> Vec<String> {
        match &self.data {
            Some(Js::Object(object)) => object.entries().iter().map(|(k, _)| k.clone()).collect(),
            _ => Vec::new(),
        }
    }

    /// The text, when it has any (`if (result.text)`).
    pub(crate) fn text(&self) -> Option<&str> {
        self.text.as_deref().filter(|t| !t.is_empty())
    }

    /// What a `plugin` trace entry says of what came back: the text's
    /// length, the data's fields, the plugin's own outcome.
    pub(crate) fn trace_into(&self, entry: &mut Members) {
        if let Some(text) = self.text() {
            entry.set("chars", Js::Number(js::utf16_len(text) as f64));
        }
        let fields = self.data_keys();
        if !fields.is_empty() {
            entry.set("fields", Js::array(fields.into_iter().map(Js::String).collect()));
        }
        if let Some(outcome) = &self.outcome {
            entry.set("outcome", Js::str(outcome.clone()));
        }
    }
}

/// One plugin of a stage that ran for an entity, by the name the stage wrote.
#[derive(Debug, Clone)]
pub(crate) struct Enriched {
    plugin: String,
    result: PluginResult,
}

/// Where one branch of the walk writes the trace (extraction.ts
/// `TraceSink`): the run's own flow, or a slice its parent splices back.
#[derive(Clone)]
pub(crate) struct Sink<'r, 'h> {
    run: &'r Run<'h>,
    slice: Option<Rc<RefCell<Vec<TraceEntry>>>>,
}

impl<'r, 'h> Sink<'r, 'h> {
    fn root(run: &'r Run<'h>) -> Sink<'r, 'h> {
        Sink { run, slice: None }
    }

    fn push(&self, entry: TraceEntry) {
        if matches!(&entry, TraceEntry::Extraction(members) if members.get("reply").is_some()) {
            self.run.reply_digests.set(self.run.reply_digests.get() + 1);
        }
        self.place(entry);
    }

    fn place(&self, entry: TraceEntry) {
        match &self.slice {
            None => self.run.trace(entry),
            Some(slice) => slice.borrow_mut().push(entry),
        }
    }

    fn branch(&self) -> Sink<'r, 'h> {
        Sink { run: self.run, slice: Some(Rc::default()) }
    }

    /// The branches' entries in the order the branches were written; called
    /// however the fan ended.
    fn absorb(&self, branches: &[Sink<'r, 'h>]) {
        for branch in branches {
            if let Some(slice) = &branch.slice {
                for entry in slice.borrow_mut().drain(..) {
                    self.place(entry);
                }
            }
        }
    }

    /// The run has kept its share of reply digests.
    fn digest_budget_spent(&self) -> bool {
        self.run.reply_digests.get() >= TRACE_REPLY_DIGESTS
    }
}

/// The firing a spec is resolved in (crate::extract::spec `Firing`): the
/// body's scope for the extraction's own words, the file's for a root
/// declaration's; the live schemas of the instances the body sees.
pub(crate) struct FiringScope<'r, 'h> {
    run: &'r Run<'h>,
    scope: &'r Rc<Scope>,
    /// Each name the scope chain binds to an instance, innermost first.
    instances: Vec<(String, Rc<crate::bindings::InstanceBinding>)>,
}

impl<'r, 'h> FiringScope<'r, 'h> {
    pub(crate) fn new(run: &'r Run<'h>, scope: &'r Rc<Scope>) -> Self {
        let mut seen: Vec<String> = Vec::new();
        let mut instances = Vec::new();
        for at in scope.chain_from_root().iter().rev() {
            for (name, binding) in at.own_bindings() {
                if seen.contains(&name) {
                    continue;
                }
                seen.push(name.clone());
                if let Binding::Instance(instance) = binding {
                    instances.push((name, instance));
                }
            }
        }
        FiringScope { run, scope, instances }
    }
}

impl Firing for FiringScope<'_, '_> {
    type Error = Stop;

    fn instance_schema(&self, name: &str) -> Option<&InstanceSchema> {
        self.instances.iter().find(|(n, _)| n == name)?.1.schema.as_ref()
    }

    async fn describe(&self, slot: &ExprSlot, scope: &WordsScope) -> Result<String, Stop> {
        let file;
        let scope = match scope {
            WordsScope::Firing => self.scope,
            WordsScope::File(DeclaringFile::Root) => {
                file = self.scope.chain_from_root()[0].clone();
                &file
            }
            // A library's words read the library's own scope, which this
            // engine builds no copy of: admission refuses file imports.
            WordsScope::File(DeclaringFile::Library(path)) => {
                return Err(thrown(Failure::unreproduced(
                    &format!("a description written in the library '{path}'"),
                    "the Rust engine builds no library scope",
                )));
            }
        };
        let value = self.run.evaluate_slot(slot, scope).await?.value;
        Ok(match value {
            Js::String(text) => text,
            nullish if nullish.is_nullish() => String::new(),
            other => other.to_js_string(),
        })
    }
}

/// The walk over one extraction (`Materializer`).
pub(crate) struct Materializer<'r, 'h> {
    pub(crate) run: &'r Run<'h>,
    pub(crate) scope: &'r Rc<Scope>,
    sites: Cell<u64>,
    /// The `from […]` text, fed to a plugin's extraction-fed arguments.
    source_text: RefCell<String>,
    /// Every source file, as each call's trace entry tells it.
    source_files: RefCell<Vec<Js>>,
    pub(crate) file_memo: RefCell<Vec<(String, super::resources::FileResolution)>>,
    /// The site refs (`ExtractSiteRef`) of the calls made so far, by site id.
    site_refs: RefCell<Vec<(String, Js)>>,
    /// The extraction's tier as its author wrote it (`extract "careful"
    /// from`): every call it makes, at every stage, asks for it.
    tier: Option<String>,
}

/// The entity a per-entity call refines.
#[derive(Clone, Copy)]
struct EntityArg<'a> {
    spec: &'a NodeSpec,
    context: &'a JsObject,
    enrichments: &'a [Enriched],
}

/// What one branch of the fence walk carries.
struct Walk<'a> {
    segments: &'a [Segment],
    base_sources: &'a [u32],
    ancestor_context: JsObject,
}

impl Clone for Walk<'_> {
    fn clone(&self) -> Self {
        Walk { segments: self.segments, base_sources: self.base_sources, ancestor_context: JsObject::clone_of(&self.ancestor_context) }
    }
}

/// How a region's model call ended without a reading.
enum Unanswered {
    /// Rejected by the schema twice: the last reply's issues.
    Invalid(Vec<Issue>),
    Stopped(Stop),
}

/// What one region's call turned out to be.
#[derive(Default)]
struct Telemetry {
    model: String,
    /// What the tier asks for, the same on the retry.
    settings: CallSettings,
    duration_ms: Option<f64>,
    last_reply: Option<Reply>,
    retried: Option<Vec<String>>,
}

/// A model call's answer (`LlmCallResult`).
#[derive(Clone)]
pub(crate) struct Reply {
    /// The reply held what the eval wire cannot carry (the shim's
    /// `uncarried`): a `__proto__` key, a lone surrogate.
    pub(crate) unreadable: bool,
    pub(crate) parsed_json: Js,
    pub(crate) raw_text: Option<String>,
    pub(crate) effort_stepped_down: Option<Js>,
    pub(crate) continuations: f64,
}

impl Run<'_> {
    /// `x = extract from […] { tree }`: the spec built for this firing, the
    /// tree materialised, and the emitted entities hung off the extract's
    /// last call on the trace (`recordExtractedEntities`).
    pub(crate) async fn extraction(&self, extract: &ast::ExtractExpression, scope: &Rc<Scope>) -> Result<Rc<Emission>, Stop> {
        let firing = FiringScope::new(self, scope);
        let spec = spec::build_extract_spec(extract, &self.checked.declarations, &firing).await.map_err(|error| match error {
            SpecError::Runtime(message) => thrown(Failure::engine("MOVENG_RUNTIME", message)),
            SpecError::Firing(stop) => stop,
        })?;
        let mark = self.trace.len();
        let materializer = Materializer {
            run: self,
            scope,
            sites: Cell::new(0),
            source_text: RefCell::default(),
            source_files: RefCell::default(),
            file_memo: RefCell::default(),
            site_refs: RefCell::default(),
            tier: extract.tier.clone(),
        };
        let root = materializer.materialize(extract, &spec).await?;
        record_extracted_entities(self, mark, &root);
        Ok(root)
    }

    /// One priced call answered on the eval wire: its cost charged, a
    /// refusal included; a budget refusal the run's cap where its own
    /// figures say so (run_context.ts `charged`).
    pub(crate) async fn priced(&self, request: host::Request) -> Result<Js, Failure> {
        let answer = self.ask(request).await?.unwrap_or(Json::Null);
        let answer = self.wire.decode(&answer).map_err(|e| Failure::engine("MOVENG_RUNTIME", e))?;
        let member = |key: &str| crate::unique::get(&answer, key);
        let cost = member("cost");
        let cost = (!matches!(cost, Js::Undefined)).then(|| env::json_of_js(&cost));
        self.ledger
            .charge(cost.as_ref())
            .map_err(|message| Failure::Engine { class: crate::eval::ErrorClass::Error, message })?;
        if let Js::Object(error) = member("error")
            && matches!(error.get("kind"), Some(Js::String(kind)) if kind == "budget")
        {
            if let Some(cap) = self.ledger.exceeded() {
                return Err(Failure::CapExceeded(cap));
            }
            let message = error.get("message").map(Js::to_js_string).unwrap_or_default();
            return Err(Failure::Engine { class: crate::eval::ErrorClass::Error, message });
        }
        Ok(answer)
    }

    /// The cancel gate inside a statement (`throwIfCancelled`).
    pub(crate) async fn throw_if_cancelled(&self) -> Result<(), Stop> {
        let cancelled = self.ask(host::control::cancelled(self.segment())).await.map_err(thrown)?;
        if cancelled.is_some_and(|v| v.as_bool() == Some(true)) { Err(Stop::Cancelled) } else { Ok(()) }
    }

    /// The registered name of the plugin a program calls `written`: the
    /// one its import names (`import { fetch_url as fetch }`).
    pub(crate) fn registered_plugin(&self, written: &str, scope: &Scope) -> String {
        match scope.resolve(written) {
            Some(Binding::Plugin(registered)) => registered,
            _ => written.to_string(),
        }
    }

    /// `pluginSpecNamed`: dashes read as underscores.
    pub(crate) fn plugin_spec(&self, registered: &str) -> Option<&movement_parser::catalog::types::PluginSpec> {
        crate::plugin::spec_named(&self.catalog.plugins, registered)
    }

    /// One invocation (`llm.transforms.invoke`): refused before the host is
    /// asked when the plugin is priced and the cap is spent; its cost
    /// charged; `{segmentId, plugin, config, extractedContext, budget}`.
    pub(crate) async fn invoke(&self, registered: &str, config: &JsObject, extracted_context: &JsObject) -> Result<PluginResult, Failure> {
        if let Some(cap) = self.ledger.plugin_refusal(&self.catalog.plugins, registered) {
            return Err(Failure::CapExceeded(cap));
        }
        let request = host::llm::transforms_invoke(
            self.segment(),
            registered,
            self.encode(&Js::object(JsObject::clone_of(config)))?,
            self.encode(&Js::object(JsObject::clone_of(extracted_context)))?,
            self.ledger.budget(),
        );
        let answer = self.priced(request).await?;
        refuse_uncarried(&answer, &format!("'{registered}''s answer"))?;
        // The host made the files the plugin's output declares (the shim's
        // `withDeclaredFiles`): they arrive as files, and nothing else does.
        Ok(PluginResult::of(&answer))
    }
}

impl<'r, 'h> Materializer<'r, 'h> {
    fn version(&self) -> u32 {
        self.run.version()
    }

    /// `planRegion`, its sites numbered as they are planned.
    fn plan<'s>(&self, spec: &'s NodeSpec, stage_index: usize, single: bool) -> Region<'s> {
        Region::plan(spec, stage_index, single, &mut || {
            self.sites.set(self.sites.get() + 1);
            self.sites.get()
        })
    }

    /// `Materializer.run`.
    async fn materialize(&self, extract: &ast::ExtractExpression, spec: &NodeSpec) -> Result<Rc<Emission>, Stop> {
        let sink = Sink::root(self.run);
        let from = self.resolve_from_data(&extract.from).await?;
        *self.source_files.borrow_mut() = from.files.clone();
        let mut segments = from.segments.clone();
        *self.source_text.borrow_mut() = from.segments.iter().map(|s| s.content.as_str()).collect::<Vec<_>>().join("\n\n");
        let mut base_sources = from.sources.clone();
        // The root's first-stage pipeline is the `from […] through […]`
        // data pipeline: once, on the bundle, before any extraction.
        let pipeline: &[ast::PluginCall] = spec.stages.first().map_or(&[], |stage| stage.through.as_slice());
        let branches: Vec<Sink<'r, 'h>> = pipeline.iter().map(|_| sink.branch()).collect();
        let empty = JsObject::new();
        let ran = map_concurrent((0..pipeline.len()).collect(), STAGE_FAN_OUT, |i, _| {
            let branch = &branches[i];
            let empty = &empty;
            async move {
                self.run.throw_if_cancelled().await?;
                self.invoke_plugin(&pipeline[i], empty, &spec.name, branch).await
            }
        })
        .await;
        let pipeline_resources = match ran {
            Ok(results) => {
                let mut fetched = Vec::new();
                for (plugin, result) in pipeline.iter().zip(results) {
                    let Some(result) = result else { continue };
                    segments.extend(prompt::plugin_segments(result.text(), result.data.as_ref()));
                    base_sources.push(self.run.mint_origin(enrichment_origin(&plugin.plugin)));
                    fetched.extend(plugin_file_resources(&result, self.version()));
                }
                self.run.stamp_resources(fetched).await.map_err(thrown)
            }
            Err(stop) => Err(stop),
        };
        sink.absorb(&branches);
        let pipeline_resources = pipeline_resources?;

        let region = self.plan(spec, 0, true);
        let emissions = self.extract_region(&region, &segments, None, &base_sources, &sink).await?;
        let root = emissions.into_iter().next().unwrap_or_else(|| Working::unanswered(spec));
        let walk = Walk { segments: &segments, base_sources: &base_sources, ancestor_context: JsObject::new() };
        let mut root = self.resolve_fences(root, walk, sink).await?;
        self.stamp_tree(&mut root).await?;
        let inherited: Vec<Js> = from.resources.iter().chain(&pipeline_resources).cloned().collect();
        Ok(emission::export(root, &inherited, self.version()))
    }

    /// `stampTree`: every record's fetched files given their ids in one
    /// request, the records in the tree's order.
    async fn stamp_tree(&self, root: &mut Working<'_>) -> Result<(), Stop> {
        let mut unstamped = Vec::new();
        collect_resources(root, &mut unstamped);
        let stamped = self.run.stamp_resources(unstamped).await.map_err(thrown)?;
        let mut next = stamped.into_iter();
        assign_resources(root, &mut next);
        Ok(())
    }

    // ── One model call per region ──

    /// `extractRegion`.
    async fn extract_region<'s>(
        &self,
        region: &Region<'s>,
        segments: &[Segment],
        entity: Option<EntityArg<'_>>,
        sources: &[u32],
        sink: &Sink<'r, 'h>,
    ) -> Result<Vec<Working<'s>>, Stop> {
        self.stamp_data_sources(region, sources);
        let user = prompt::user_message(
            segments,
            entity
                .map(|e| Entity {
                    description: e.spec.description.clone(),
                    context: Js::object(JsObject::clone_of(e.context)),
                    enrichments: e
                        .enrichments
                        .iter()
                        .map(|en| Enrichment { plugin: en.plugin.clone(), text: en.result.text.clone(), data: en.result.data.clone() })
                        .collect(),
                })
                .as_ref(),
        );
        let shape = self.shape(region, &user);
        if js::trim(&user.text).is_empty() {
            let mut entry = shape;
            entry.set("skipped", Js::str("empty_source"));
            entry.set("emissions", tally(&region.spec.name, 0));
            sink.push(TraceEntry::Extraction(entry));
            return Ok(Vec::new());
        }
        let system = prompt::system_prompt(region);
        let density = if region.sites() >= ENTITY_DENSITY_OPUS_THRESHOLD { "opus" } else { "sonnet" };
        let settings = extraction_call_settings(self.tier.as_deref(), density, &self.run.input.extraction_tiers);
        let mut telemetry = Telemetry { model: settings.model.clone(), settings, ..Telemetry::default() };
        let read = match self.call_with_retry(&system, &user.text, region, &mut telemetry).await {
            Ok(read) => read,
            Err(Unanswered::Stopped(stop)) => return Err(stop),
            Err(Unanswered::Invalid(issues)) => {
                // A per-entity call refines an entity that already stands,
                // which keeps its previous stage; the root has nothing to
                // fall back to.
                let kept = entity.map(|e| e.enrichments);
                let raised = self.failed_call(region, &shape, &telemetry, &issues, sink, kept);
                return if kept.is_some() { Ok(Vec::new()) } else { Err(thrown(raised)) };
            }
        };
        let entities = match &read.value {
            Js::Object(object) => match object.get(&region.site_id) {
                Some(Js::Array(list)) => list.items().clone(),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        };
        let site_ref = |site_id: &str| -> Js {
            self.site_refs.borrow().iter().find(|(id, _)| id == site_id).map(|(_, r)| r.clone()).unwrap_or(Js::Null)
        };
        let mint = |origin: Js| self.run.mint_origin(origin);
        let projected: Vec<Working<'s>> = entities
            .iter()
            .filter_map(|record| match record {
                Js::Object(object) => Some(emission::project(object, region, &site_ref, &mint)),
                Js::Array(_) => Some(emission::project(&JsObject::new(), region, &site_ref, &mint)),
                _ => None,
            })
            .collect();
        let mut empty = Vec::new();
        emission::count_empty(&projected, &mut empty);
        let mut dropped = Vec::new();
        let kept = emission::drop_empty(projected, &mut dropped);
        let mut why = Vec::new();
        if entities.is_empty() {
            why.push("no_entities");
        }
        if !dropped.is_empty() {
            why.push("dropped_records");
        }
        if telemetry.retried.is_some() {
            why.push("retried");
        }
        let mut entry = shape.clone();
        entry.set("emissions", tally(&region.spec.name, entities.len()));
        entry.extend(self.outcome(&telemetry, &why, sink, None, &shape));
        if !empty.is_empty() {
            entry.set("empty", counts(&empty));
        }
        if !dropped.is_empty() {
            entry.set("dropped", counts(&dropped));
        }
        coercion_members(&read.coercions, &mut entry);
        sink.push(TraceEntry::Extraction(entry));
        Ok(kept)
    }

    /// `stampDataSources`: the call's data sources onto every site the region
    /// batches, each site's ref made once.
    fn stamp_data_sources(&self, region: &Region<'_>, sources: &[u32]) {
        let data_sources = Js::array(sources.iter().map(|id| self.run.origin(*id)).collect());
        fn stamp(region: &Region<'_>, data_sources: &Js, into: &mut Vec<(String, Js)>) {
            let reference = env::object_of(vec![
                ("siteId", Js::str(region.site_id.clone())),
                ("node", Js::str(region.spec.name.clone())),
                ("description", Js::str(region.spec.description.clone())),
                ("stage", Js::Number(region.stage_index as f64)),
                ("dataSources", data_sources.clone()),
            ]);
            match into.iter_mut().find(|(id, _)| *id == region.site_id) {
                Some(slot) => slot.1 = reference,
                None => into.push((region.site_id.clone(), reference)),
            }
            for child in &region.children {
                stamp(child, data_sources, into);
            }
        }
        stamp(region, &data_sources, &mut self.site_refs.borrow_mut());
    }

    /// What every trace entry of a call carries: what it read.
    fn shape(&self, region: &Region<'_>, user: &prompt::UserMessage) -> Members {
        let mut shape = Members::default();
        shape.set("node", Js::str(region.spec.name.clone()));
        shape.set("inputChars", number(js::utf16_len(&user.text)));
        let parts: Vec<Js> =
            user.parts.iter().map(|(classification, chars)| env::object_of(vec![("classification", Js::str(classification.clone())), ("chars", number(*chars))])).collect();
        if !parts.is_empty() {
            shape.set("inputs", Js::array(parts.iter().take(TRACE_INPUT_PARTS).cloned().collect()));
        }
        if parts.len() > TRACE_INPUT_PARTS {
            shape.set("inputsTruncated", number(parts.len() - TRACE_INPUT_PARTS));
        }
        let files = self.source_files.borrow();
        if !files.is_empty() {
            shape.set("files", Js::array(files.iter().take(TRACE_INPUT_PARTS).cloned().collect()));
        }
        if files.len() > TRACE_INPUT_PARTS {
            shape.set("filesTruncated", number(files.len() - TRACE_INPUT_PARTS));
        }
        shape
    }

    /// `callWithRetry`: the cancel gate, the call timed, the reply read;
    /// once more, with what was wrong named, when it does not read.
    async fn call_with_retry(&self, system: &str, user_message: &str, region: &Region<'_>, telemetry: &mut Telemetry) -> Result<validate::Read, Unanswered> {
        self.run.throw_if_cancelled().await.map_err(Unanswered::Stopped)?;
        let started = self.run.clock_now().await.map_err(|f| Unanswered::Stopped(thrown(f)))?;
        let first = self.call_model(system, user_message, LABEL, &telemetry.settings).await.map_err(Unanswered::Stopped)?;
        telemetry.last_reply = Some(first.clone());
        telemetry.duration_ms = Some(self.run.clock_now().await.map_err(|f| Unanswered::Stopped(thrown(f)))? - started);
        let issues = match read_reply(region, &first) {
            Ok(read) => return Ok(read),
            Err(issues) => issues,
        };
        telemetry.retried = Some(validate::issue_lines(&issues).into_iter().take(TRACE_ISSUE_LINES).collect());
        let retry_message = prompt::retry_user_message(user_message, region, &issues);
        let retry = self.call_model(system, &retry_message, &format!("{LABEL}_retry"), &telemetry.settings).await.map_err(Unanswered::Stopped)?;
        telemetry.last_reply = Some(retry.clone());
        telemetry.duration_ms = Some(self.run.clock_now().await.map_err(|f| Unanswered::Stopped(thrown(f)))? - started);
        read_reply(region, &retry).map_err(Unanswered::Invalid)
    }

    /// One `llm.client.call`, priced.
    async fn call_model(&self, system: &str, user_message: &str, label: &str, settings: &CallSettings) -> Result<Reply, Stop> {
        let call = host::llm::ClientCall {
            system,
            user_message,
            label,
            model: &settings.model,
            effort: settings.effort.as_deref(),
            max_tokens: settings.max_tokens,
        };
        let answer = self.run.priced(host::llm::client_call(self.run.segment(), call, self.run.ledger.budget())).await.map_err(thrown)?;
        let member = |key: &str| crate::unique::get(&answer, key);
        let uncarried = uncarried(&answer);
        Ok(Reply {
            unreadable: uncarried.iter().any(|m| m == "parsedJson"),
            parsed_json: member("parsedJson"),
            raw_text: match member("rawText") {
                Js::String(text) => Some(text),
                _ => None,
            },
            effort_stepped_down: Some(member("effortSteppedDown")).filter(Js::truthy),
            continuations: match member("continuations") {
                Js::Number(n) => n,
                _ => 0.0,
            },
        })
    }

    /// `outcome`: what the call was (its model, how long, a continued answer,
    /// the retry's issues), and, when it misbehaved and the run's digest
    /// budget has room, what the model replied.
    fn outcome(&self, telemetry: &Telemetry, why: &[&str], sink: &Sink<'_, '_>, focus: Option<&(String, Js)>, shape: &Members) -> Members {
        let mut out = Members::default();
        out.set("model", Js::str(telemetry.model.clone()));
        if let Some(reply) = &telemetry.last_reply {
            if let Some(stepped) = &reply.effort_stepped_down {
                out.set("effortSteppedDown", stepped.clone());
            }
            if reply.continuations > 0.0 {
                out.set("continued", Js::Bool(true));
                out.set("continuations", Js::Number(reply.continuations));
                let mut fields = Map::new();
                fields.insert("node".into(), shape.get("node").map_or(Json::Null, env::json_of_js));
                fields.insert("inputChars".into(), shape.get("inputChars").map_or(Json::Null, env::json_of_js));
                fields.insert("continuations".into(), env::json_of_js(&Js::Number(reply.continuations)));
                self.run.log(
                    "warn",
                    "[movement:extract] the answer ran past its output ceiling and was continued — records near the end of the input may be missing; cut the input into pieces",
                    fields,
                );
            }
        }
        if let Some(ms) = telemetry.duration_ms {
            out.set("durationMs", Js::Number(ms));
        }
        if let Some(retried) = &telemetry.retried {
            out.set("retried", Js::array(retried.iter().map(|line| Js::str(line.clone())).collect()));
        }
        if !sink.digest_budget_spent()
            && let Some(digest) = telemetry.last_reply.as_ref().and_then(|reply| reply_digest(reply, why, focus))
        {
            out.set("reply", digest);
        }
        out
    }

    /// `failedCall`: the failing call on the trace, its reply's offending
    /// entity in the digest, and the run's error naming it — unless the call
    /// was refining an entity that stands (`kept`), which keeps it.
    fn failed_call(
        &self,
        region: &Region<'_>,
        shape: &Members,
        telemetry: &Telemetry,
        issues: &[Issue],
        sink: &Sink<'_, '_>,
        kept: Option<&[Enriched]>,
    ) -> Failure {
        let answered = telemetry.last_reply.as_ref().map_or(Js::Undefined, |r| r.parsed_json.clone());
        let focus = offending_entity(&answered, issues.first().map_or(&[], |i| i.path.as_slice()));
        let mut entry = shape.clone();
        entry.set("emissions", tally(&region.spec.name, 0));
        entry.set("failed", Js::str("invalid_reply"));
        if let Some(kept) = kept {
            entry.set("fallback", Js::str("kept_previous_stage"));
            if !kept.is_empty() {
                entry.set("plugins", Js::array(kept.iter().map(|e| plugin_outcome(&e.plugin, "dropped")).collect()));
            }
        }
        entry.extend(self.outcome(telemetry, &["failed"], sink, focus.as_ref(), shape));
        sink.push(TraceEntry::Extraction(entry));
        if let Some(kept) = kept {
            let mut fields = Map::new();
            fields.insert("node".into(), json!(region.spec.name));
            fields.insert("site".into(), json!(region.site_id));
            fields.insert("stage".into(), json!(region.stage_index));
            fields.insert("droppedEnrichments".into(), json!(kept.iter().map(|e| e.plugin.clone()).collect::<Vec<_>>()));
            self.run.log(
                "warn",
                "[movement:extract] a per-entity call was answered with something the guide does not describe — keeping the entity as its previous stage left it",
                fields,
            );
        }
        let detail = validate::unanswered_detail(region, &answered, issues);
        let held = match &focus {
            Some((at, _)) => format!("The run's trace holds the entity at `{at}`."),
            None => format!("The run's trace holds the first {TRACE_REPLY_CHARS} characters of it."),
        };
        Failure::engine(
            "MOVENG_RUNTIME",
            format!(
                "The extraction of `{}` ({}) was answered with something the guide does not describe, twice. {detail}{held}",
                region.spec.name, region.site_id
            ),
        )
    }

    // ── Fences: per-entity pipelines and continuation calls ──

    /// `resolveFences`: the entity's later stages, each behind its `through`
    /// pipeline (skipped when the pipeline brought nothing to read), its
    /// fenced children per stage, then each child entity in turn, side by
    /// side.
    fn resolve_fences<'s, 'a>(
        &'a self,
        mut emission: Working<'s>,
        walk: Walk<'a>,
        sink: Sink<'r, 'h>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Working<'s>, Stop>> + 'a>>
    where
        's: 'a,
    {
        Box::pin(async move {
            let spec = emission.spec;
            while emission.stage_index + 1 < spec.stages.len() {
                let next = emission.stage_index + 1;
                let stage = &spec.stages[next];
                let context = merged(&walk.ancestor_context, &emission.context);
                let enrichments = self.run_pipeline(&stage.through, &context, &spec.name, &sink).await?;
                // A fetched file is the record's source whether or not the
                // stage goes on to read anything.
                self.add_resources(&mut emission, &enrichments);
                if !stage.through.is_empty() && !has_enrichment_content(&enrichments) {
                    note_pointless_stage(&stage.through, &enrichments, &spec.name, &sink);
                    let mut fields = Map::new();
                    fields.insert("node".into(), json!(spec.name));
                    fields.insert("plugins".into(), json!(stage.through.iter().map(|p| p.plugin.clone()).collect::<Vec<_>>()));
                    self.run.log("info", "[movement:extract] stage has no enrichment for this entity — skipping the call", fields);
                    emission.stage_index = next;
                    self.resolve_fenced_children(&mut emission, next, &walk, &sink).await?;
                    continue;
                }
                let region = self.plan(spec, next, true);
                let sources = self.stage_sources(walk.base_sources, &enrichments);
                let entity = EntityArg { spec, context: &emission.context, enrichments: &enrichments };
                let continued = self.extract_region(&region, walk.segments, Some(entity), &sources, &sink).await?;
                if let Some(next_stage) = continued.into_iter().next() {
                    emission.absorb_stage(next_stage);
                }
                emission.stage_index = next;
                self.resolve_fenced_children(&mut emission, next, &walk, &sink).await?;
            }
            for stage in 0..=emission.stage_index {
                self.resolve_fenced_children(&mut emission, stage, &walk, &sink).await?;
            }
            // Siblings share nothing but the source text, so they go side by
            // side; the chain inside each entity stays in order.
            let ancestors = merged(&walk.ancestor_context, &namespace_context(&spec.name, &emission.context));
            let mut shape: Vec<(String, usize)> = Vec::new();
            let mut children = Vec::new();
            for (name, list) in std::mem::take(&mut emission.children) {
                shape.push((name, list.len()));
                children.extend(list);
            }
            let branches: Vec<Sink<'r, 'h>> = children.iter().map(|_| sink.branch()).collect();
            let child_walk = Walk { segments: walk.segments, base_sources: walk.base_sources, ancestor_context: ancestors };
            let walked = map_concurrent(children, STAGE_FAN_OUT, |child, i| self.resolve_fences(child, child_walk.clone(), branches[i].clone())).await;
            sink.absorb(&branches);
            let mut walked = walked?.into_iter();
            for (name, count) in shape {
                emission.children.push((name, walked.by_ref().take(count).collect()));
            }
            Ok(emission)
        })
    }

    /// `resolveFencedChildren`: the stage's children behind a pipeline of
    /// their own, side by side, each its own call for all its records,
    /// attached in declaration order.
    async fn resolve_fenced_children<'s>(&self, emission: &mut Working<'s>, stage_index: usize, walk: &Walk<'_>, sink: &Sink<'r, 'h>) -> Result<(), Stop> {
        let ancestors = merged(&walk.ancestor_context, &namespace_context(&emission.spec.name, &emission.context));
        let specs: Vec<&'s NodeSpec> = emission.spec.stages[stage_index]
            .children
            .iter()
            .filter(|child| child.stages.first().is_some_and(|stage| !stage.through.is_empty()))
            .filter(|child| !emission.has_child(&child.name))
            .collect();
        if specs.is_empty() {
            return Ok(());
        }
        let branches: Vec<Sink<'r, 'h>> = specs.iter().map(|_| sink.branch()).collect();
        let parent_spec = emission.spec;
        let parent_context = JsObject::clone_of(&emission.context);
        let extracted = map_concurrent(specs.clone(), STAGE_FAN_OUT, |child, i| {
            let branch = &branches[i];
            let ancestors = &ancestors;
            let parent_context = &parent_context;
            async move {
                let enrichments = self.run_pipeline(&child.stages[0].through, ancestors, &child.name, branch).await?;
                let region = self.plan(child, 0, false);
                let sources = self.stage_sources(walk.base_sources, &enrichments);
                let entity = EntityArg { spec: parent_spec, context: parent_context, enrichments: &enrichments };
                let mut records = self.extract_region(&region, walk.segments, Some(entity), &sources, branch).await?;
                // The child's stage ran once for all its records: each carries
                // what it fetched.
                for record in &mut records {
                    self.add_resources(record, &enrichments);
                }
                Ok::<_, Stop>(records)
            }
        })
        .await;
        sink.absorb(&branches);
        for (child, records) in specs.into_iter().zip(extracted?) {
            emission.set_children(child.name.clone(), records);
        }
        Ok(())
    }

    /// `stageSources`: the bundle's sources, then this stage's enrichments.
    fn stage_sources(&self, base: &[u32], enrichments: &[Enriched]) -> Vec<u32> {
        let mut sources = base.to_vec();
        sources.extend(enrichments.iter().map(|e| self.run.mint_origin(enrichment_origin(&e.plugin))));
        sources
    }

    /// `addResources`: the files a stage's plugins fetched, on the record
    /// they ran for (their ids come once the tree is done).
    fn add_resources(&self, emission: &mut Working<'_>, enrichments: &[Enriched]) {
        let fetched: Vec<Js> = enrichments.iter().flat_map(|e| plugin_file_resources(&e.result, self.version())).collect();
        if fetched.is_empty() {
            return;
        }
        emission.resources.get_or_insert_with(Vec::new).extend(fetched);
    }

    /// `runPipeline`: a stage's plugins, side by side, answered in the order
    /// written, each launched behind the cancel gate.
    async fn run_pipeline(&self, pipeline: &[ast::PluginCall], context: &JsObject, node: &str, sink: &Sink<'r, 'h>) -> Result<Vec<Enriched>, Stop> {
        let branches: Vec<Sink<'r, 'h>> = pipeline.iter().map(|_| sink.branch()).collect();
        let results = map_concurrent((0..pipeline.len()).collect(), STAGE_FAN_OUT, |i, _| {
            let branch = &branches[i];
            async move {
                self.run.throw_if_cancelled().await?;
                self.invoke_plugin(&pipeline[i], context, node, branch).await
            }
        })
        .await;
        sink.absorb(&branches);
        Ok(pipeline
            .iter()
            .zip(results?)
            .filter_map(|(plugin, result)| result.map(|result| Enriched { plugin: plugin.plugin.clone(), result }))
            .collect())
    }

    /// `invokePlugin`: its arguments (a bare name the entity's field of that
    /// name, anything else an expression), the source text into its
    /// extraction-fed arguments, a blank required argument skipping the
    /// entity, then the invocation, timed and traced.
    async fn invoke_plugin(&self, plugin: &ast::PluginCall, context: &JsObject, node: &str, sink: &Sink<'r, 'h>) -> Result<Option<PluginResult>, Stop> {
        let mut config = JsObject::new();
        for arg in &plugin.args {
            let raw = js::trim(&arg.value.raw);
            let value = match context.get(raw) {
                Some(value) if js::is_identifier(raw) => value.clone(),
                _ => self.run.evaluate_slot(&arg.value, self.scope).await?.value,
            };
            config.set(arg.name.clone(), value);
        }
        let registered = self.run.registered_plugin(&plugin.plugin, self.scope);
        let spec = self.run.plugin_spec(&registered);
        for fed in spec.and_then(|s| s.fed_args.as_ref()).into_iter().flatten() {
            config.set(fed.name.clone(), Js::str(self.source_text.borrow().clone()));
        }
        let url = match config.get("url") {
            Some(Js::String(url)) => Some(emission::cut(url, TRACE_URL_CHARS)),
            _ => None,
        };
        for param in spec.and_then(|s| s.required_args.as_ref()).into_iter().flatten() {
            if !is_blank(config.get(param)) {
                continue;
            }
            let mut fields = Map::new();
            fields.insert("plugin".into(), json!(plugin.plugin));
            fields.insert("param".into(), json!(param));
            fields.insert("written".into(), json!(plugin.args.iter().any(|a| a.name == *param)));
            self.run.log("info", "[movement:transform] required argument is empty — skipping this entity", fields);
            let mut entry = Members::default();
            entry.set("plugin", Js::str(plugin.plugin.clone()));
            entry.set("node", Js::str(node));
            entry.set("durationMs", Js::Number(0.0));
            entry.set("skippedParam", Js::str(param.clone()));
            sink.push(TraceEntry::Plugin(entry));
            return Ok(None);
        }
        let started = self.run.clock_now().await.map_err(thrown)?;
        let result = self.run.invoke(&registered, &config, context).await.map_err(thrown)?;
        let duration = self.run.clock_now().await.map_err(thrown)? - started;
        let mut entry = Members::default();
        entry.set("plugin", Js::str(plugin.plugin.clone()));
        entry.set("node", Js::str(node));
        if let Some(url) = url {
            entry.set("url", Js::str(url));
        }
        entry.set("durationMs", Js::Number(duration));
        result.trace_into(&mut entry);
        sink.push(TraceEntry::Plugin(entry));
        Ok(Some(result))
    }
}

/// What the reply says unread: a reply the eval wire could not carry is one
/// issue at its root, retried and failed as any reply the guide does not
/// describe ("Transition artefacts to mirror" in the README).
fn read_reply(region: &Region<'_>, reply: &Reply) -> Result<validate::Read, Vec<Issue>> {
    if reply.unreadable {
        return Err(vec![Issue { path: Vec::new(), message: UNREADABLE_REPLY.into() }]);
    }
    validate::read_reply(region, &reply.parsed_json)
}

pub(crate) const UNREADABLE_REPLY: &str = "the reply held a key or a text this engine cannot read (a `__proto__` key, or a lone surrogate)";

/// The members of a host's answer the shim could not carry on the eval wire.
pub(crate) fn uncarried(answer: &Js) -> Vec<String> {
    match crate::unique::get(answer, "uncarried") {
        Js::Array(list) => list.items().iter().map(Js::to_js_string).collect(),
        _ => Vec::new(),
    }
}

/// Every record's resources, the tree's order.
fn collect_resources(record: &Working<'_>, into: &mut Vec<Js>) {
    into.extend(record.resources.iter().flatten().cloned());
    for (_, children) in &record.children {
        for child in children {
            collect_resources(child, into);
        }
    }
}

/// The stamped resources back onto the records they came from, in the same
/// order.
fn assign_resources(record: &mut Working<'_>, stamped: &mut impl Iterator<Item = Js>) {
    if let Some(resources) = &mut record.resources {
        for slot in resources.iter_mut() {
            if let Some(next) = stamped.next() {
                *slot = next;
            }
        }
    }
    for (_, children) in &mut record.children {
        for child in children {
            assign_resources(child, stamped);
        }
    }
}

/// `{kind: 'enrichment', plugin}`: what a stage's plugin added to a call's
/// context.
fn enrichment_origin(plugin: &str) -> Js {
    env::object_of(vec![("kind", Js::str("enrichment")), ("plugin", Js::str(plugin))])
}

/// `{...a, ...b}`.
fn merged(a: &JsObject, b: &JsObject) -> JsObject {
    let mut out = JsObject::clone_of(a);
    for (key, value) in b.entries() {
        out.set(key.clone(), value.clone());
    }
    out
}

/// `namespaceContext`: an ancestor's fields under its node's name (each run
/// of non-word characters an underscore); one with none adds nothing.
fn namespace_context(node: &str, context: &JsObject) -> JsObject {
    let mut out = JsObject::new();
    if context.entries().is_empty() {
        return out;
    }
    let mut key = String::new();
    let mut gap = false;
    for c in node.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            if gap {
                key.push('_');
            }
            gap = false;
            key.push(c);
        } else {
            gap = true;
        }
    }
    if gap {
        key.push('_');
    }
    out.set(key, Js::object(JsObject::clone_of(context)));
    out
}

/// `hasEnrichmentContent`: a stage's plugins brought text or data.
fn has_enrichment_content(enrichments: &[Enriched]) -> bool {
    enrichments.iter().any(|e| e.result.text().is_some() || !e.result.data_keys().is_empty())
}

/// `notePointlessStage`: the call that was not made, and what each of the
/// stage's plugins did for this entity.
fn note_pointless_stage(pipeline: &[ast::PluginCall], enrichments: &[Enriched], node: &str, sink: &Sink<'_, '_>) {
    let ran = |name: &str| enrichments.iter().any(|e| e.plugin == name);
    let plugins: Vec<Js> = pipeline.iter().map(|p| plugin_outcome(&p.plugin, if ran(&p.plugin) { "empty" } else { "skipped" })).collect();
    let mut entry = Members::default();
    entry.set("node", Js::str(node));
    entry.set("inputChars", number(0));
    entry.set("skipped", Js::str("no_enrichment"));
    entry.set("plugins", Js::array(plugins));
    entry.set("emissions", tally(node, 0));
    sink.push(TraceEntry::Extraction(entry));
}

/// `isBlank`: absent, or text of only spaces.
fn is_blank(value: Option<&Js>) -> bool {
    match value {
        None => true,
        Some(value) if value.is_nullish() => true,
        Some(Js::String(text)) => js::trim(text).is_empty(),
        Some(_) => false,
    }
}

/// Per-name counts as the trace writes them.
fn counts(counts: &[(String, f64)]) -> Js {
    let mut object = JsObject::new();
    for (name, n) in counts {
        object.set(name.clone(), Js::Number(*n));
    }
    Js::object(object)
}

/// `{[node]: n}`.
fn tally(node: &str, n: usize) -> Js {
    counts(&[(node.to_string(), n as f64)])
}

fn number(n: usize) -> Js {
    Js::Number(n as f64)
}

/// `{plugin, outcome}`.
fn plugin_outcome(plugin: &str, outcome: &str) -> Js {
    env::object_of(vec![("plugin", Js::str(plugin)), ("outcome", Js::str(outcome))])
}

/// What the read coerced, on the call's entry.
fn coercion_members(coercions: &Coercions, entry: &mut Members) {
    let keyed = |list: &[(String, Vec<String>)]| {
        let mut object = JsObject::new();
        for (key, values) in list {
            object.set(key.clone(), Js::array(values.iter().map(|v| Js::str(v.clone())).collect()));
        }
        Js::object(object)
    };
    if !coercions.values.is_empty() {
        entry.set("coerced", keyed(&coercions.values));
    }
    if !coercions.evidence.is_empty() {
        entry.set("evidenceCoerced", keyed(&coercions.evidence));
    }
    if let Some(envelope) = &coercions.envelope {
        entry.set("envelopeRepaired", Js::str(envelope.clone()));
    }
}

/// `replyDigest`: the keys a misbehaving reply answered under, and the head
/// of it — or the entity the rejection named.
pub(crate) fn reply_digest(reply: &Reply, why: &[&str], focus: Option<&(String, Js)>) -> Option<Js> {
    if why.is_empty() {
        return None;
    }
    let keys: Vec<String> = match &reply.parsed_json {
        Js::Object(object) => object.entries().iter().map(|(k, _)| k.clone()).collect(),
        Js::Array(list) => (0..list.items().len()).map(|i| i.to_string()).collect(),
        _ => Vec::new(),
    };
    let body = match focus {
        Some((_, entity)) => js::json_stringify(entity, 0),
        None => reply.raw_text.clone().unwrap_or_else(|| js::json_stringify(&reply.parsed_json, 0)),
    };
    let mut digest = vec![
        ("why", Js::array(why.iter().map(|w| Js::str(*w)).collect())),
        ("keys", Js::array(keys.into_iter().take(TRACE_INPUT_PARTS).map(Js::String).collect())),
        ("sample", Js::str(emission::cut(&body, TRACE_REPLY_CHARS))),
    ];
    if let Some((at, _)) = focus {
        digest.push(("path", Js::str(at.clone())));
    }
    Some(env::object_of(digest))
}

/// `offendingEntity`: the record a rejection's path lands inside, found by
/// walking the path into the reply as written — the deepest object reached
/// through a list index.
fn offending_entity(reply: &Js, path: &[PathKey]) -> Option<(String, Js)> {
    let mut node = reply.clone();
    let mut found = None;
    let mut walked: Vec<String> = Vec::new();
    for step in path {
        let next = match (&node, step) {
            (Js::Array(list), PathKey::Index(i)) => list.items().get(*i).cloned(),
            (Js::Array(list), PathKey::Key(key)) => key.parse::<usize>().ok().and_then(|i| list.items().get(i).cloned()),
            (Js::Object(object), PathKey::Key(key)) => object.get(key).cloned(),
            (Js::Object(object), PathKey::Index(i)) => object.get(&i.to_string()).cloned(),
            _ => None,
        };
        let Some(next) = next.filter(|n| !matches!(n, Js::Undefined)) else { break };
        node = next;
        walked.push(match step {
            PathKey::Key(key) => key.clone(),
            PathKey::Index(i) => i.to_string(),
        });
        if matches!(step, PathKey::Index(_)) && matches!(node, Js::Object(_)) {
            found = Some((walked.join("."), node.clone()));
        }
    }
    found
}

/// `recordExtractedEntities`: the whole tree's entities on the extract's
/// last call that happened (a stage skipped for want of anything new is not
/// one); none when that call was skipped for an empty source.
fn record_extracted_entities(run: &Run<'_>, from: usize, root: &Emission) {
    record_traced_entities(run, from, emission::traced_entities(root));
}

/// `recordExtractedEntities` with the sample already read off the tree.
pub(crate) fn record_traced_entities(run: &Run<'_>, from: usize, (entities, truncated): (Js, Js)) {
    run.trace.amend(from, |entries| {
        let target = entries.iter_mut().rev().find_map(|entry| match entry {
            TraceEntry::Extraction(members) if !matches!(members.get("skipped"), Some(Js::String(why)) if why == "no_enrichment") => Some(members),
            _ => None,
        });
        let Some(target) = target else { return };
        if target.get("skipped").is_some() {
            return;
        }
        if let Js::Object(object) = &entities
            && !object.entries().is_empty()
        {
            target.set("entities", entities.clone());
        }
        if let Js::Object(object) = &truncated
            && !object.entries().is_empty()
        {
            target.set("truncatedCount", truncated.clone());
        }
    });
}
