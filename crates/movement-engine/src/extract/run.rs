//! What the extraction call, the `AI()` expression and a plain plugin call
//! share: each tier's model and effort (`extractionCallSettings`,
//! `aiExpressionSettings`), a priced call answered on the eval wire and
//! charged, the cancel gate, a plugin's invocation (`llm.transforms.invoke`)
//! and what it answered, the firing scope a declaration's words are read in,
//! and the trace's reply digests and extracted entities.

use std::rc::Rc;

use movement_parser::ast::ExprSlot;
use movement_parser::catalog::types::InstanceSchema;
use serde_json::Value as Json;

use crate::bindings::{Binding, Scope};
use crate::env;
use crate::extract::emission::{self};
use crate::extract::spec::{self, Firing, WordsScope};
use crate::host;
use crate::js::{self, Js, JsObject};
use crate::program::DeclaringFile;
use crate::run::{Failure, Run, Stop};
use crate::trace::{Members, TraceEntry};

/// Prompt parts kept per call on the trace; the rest are counted.
pub(crate) const TRACE_INPUT_PARTS: usize = 12;
/// How much of a misbehaving reply the trace keeps.
const TRACE_REPLY_CHARS: usize = 1000;
/// Reply digests kept per run.
pub(crate) const TRACE_REPLY_DIGESTS: usize = 5;
/// Validation issues quoted when the retry fires.
pub(crate) const TRACE_ISSUE_LINES: usize = 8;
pub(crate) const TRACE_URL_CHARS: usize = 200;
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
    pub(crate) outcome: Option<String>,
}

impl PluginResult {
    /// What `llm.transforms.invoke` answered, which the contract
    /// (`TransformInvocationResult`) gives as `{text?, data?, records?,
    /// outcome?}`: a member of another shape ends the run, coded.
    fn of(answer: &Js) -> Result<PluginResult, Failure> {
        const CALL: &str = "llm.transforms.invoke";
        let Js::Object(_) = answer else { return Err(Failure::host_answer(CALL, "an object with text, data, records and outcome members", answer)) };
        let member = |key: &str| crate::unique::get(answer, key);
        let text = match member("text") {
            Js::String(text) => Some(text.into_string()),
            absent if absent.is_nullish() => None,
            other => return Err(Failure::host_answer(CALL, "`text` as text or absent", &other)),
        };
        let data = match member("data") {
            data @ Js::Object(_) => Some(data),
            absent if absent.is_nullish() => None,
            other => return Err(Failure::host_answer(CALL, "`data` as an object or absent", &other)),
        };
        let records = match member("records") {
            Js::Array(list) => {
                if let Some(bad) = list.items().iter().find(|record| !matches!(record, Js::Object(_))) {
                    return Err(Failure::host_answer(CALL, "every entry of `records` as an object", bad));
                }
                list.items().clone()
            }
            absent if absent.is_nullish() => Vec::new(),
            other => return Err(Failure::host_answer(CALL, "`records` as a list or absent", &other)),
        };
        let outcome = match member("outcome") {
            Js::String(outcome) if !outcome.is_empty() => Some(outcome.into_string()),
            Js::String(_) => None,
            absent if absent.is_nullish() => None,
            other => return Err(Failure::host_answer(CALL, "`outcome` as text or absent", &other)),
        };
        Ok(PluginResult { text, data, records, outcome })
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
            entry.set("chars", Js::Number(js::len_chars(text) as f64));
        }
        let fields = self.data_keys();
        if !fields.is_empty() {
            entry.set("fields", Js::array(fields.into_iter().map(Js::str).collect()));
        }
        if let Some(outcome) = &self.outcome {
            entry.set("outcome", Js::str(outcome.clone()));
        }
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

    fn base(&self, of: &spec::ShapeLink, name: &str, declarations: &crate::program::Declarations) -> Option<spec::ShapeLink> {
        match &of.words {
            WordsScope::Body(body) => match body.resolve(name)? {
                Binding::Shape(shape) => Some(self.run.shape_link(&shape)),
                _ => None,
            },
            _ => declarations.of_file(&of.file)?.shapes.get(name).map(spec::ShapeLink::declared),
        }
    }

    async fn describe(&self, slot: &ExprSlot, scope: &WordsScope) -> Result<String, Stop> {
        let file;
        let scope = match scope {
            WordsScope::Body(body) => body,
            // A declaration's words read the scope of the file that declared
            // it (`describeIn(slot, libraryEnv(library) | fileEnv)`).
            WordsScope::File(DeclaringFile::Root) => {
                file = self.run.scope_of_file(&DeclaringFile::Root).unwrap_or_else(|| self.scope.chain_from_root()[0].clone());
                &file
            }
            WordsScope::File(DeclaringFile::Library(path)) => {
                file = self.run.library_scope(path).await?;
                &file
            }
        };
        let value = self.run.evaluate_slot(slot, scope).await?.value;
        Ok(match value {
            Js::String(text) => text.into_string(),
            nullish if nullish.is_nullish() => String::new(),
            other => other.to_js_string(),
        })
    }
}

/// A model call's answer (`LlmCallResult`).
#[derive(Clone)]
pub(crate) struct Reply {
    pub(crate) parsed_json: Js,
    pub(crate) raw_text: Option<String>,
}

impl Run<'_> {
    /// A shape binding as the spec builder reads it: one declared in a body
    /// reads its words and base in that body while it stands, and in the
    /// running file once a park has rebuilt it.
    pub(crate) fn shape_link(&self, shape: &crate::bindings::ShapeBinding) -> spec::ShapeLink {
        if !shape.local {
            return spec::ShapeLink::declared(&shape.declared);
        }
        let words = match shape.body_scope() {
            Some(body) => WordsScope::Body(body),
            None => WordsScope::File(DeclaringFile::Root),
        };
        spec::ShapeLink { declaration: shape.declared.declaration.clone(), file: shape.declared.file.clone(), words }
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
        // The host made the files the plugin's output declares (the shim's
        // `withDeclaredFiles`): they arrive as files, and nothing else does.
        PluginResult::of(&answer)
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
        ("keys", Js::array(keys.into_iter().take(TRACE_INPUT_PARTS).map(Js::str).collect())),
        ("sample", Js::str(emission::cut(&body, TRACE_REPLY_CHARS))),
    ];
    if let Some((at, _)) = focus {
        digest.push(("path", Js::str(at.clone())));
    }
    Some(env::object_of(digest))
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
