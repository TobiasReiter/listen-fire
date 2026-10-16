//! The extraction CALL, `extract(content, Shape, config)` and
//! `extractOne(…)`, as extraction_call.ts runs it: content in, the shape's
//! records out — run-local nodes, one per thing the content names (or the
//! one it describes, or none), each nested node an edge of records of its
//! own. One `llm.extractCall.call` per call (and one retry), its prompt laid
//! out for the prompt cache: the fixed system prompt, each content item as a
//! block of its own, the shape and the instructions last; a cache breakpoint
//! at the end of the longest content prefix this run already sent to the
//! same model at the same effort, and one at the end of the content.
//!
//! What the run's calls share (`ExtractCallRunState`): the prefixes sent,
//! and each content file's reading, once per file — a second call over a
//! file another call is still reading waits for that reading, as the
//! TypeScript awaits the one promise.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use movement_parser::ast::{self, ExtractCallFinds, ExtractCallShape};
use movement_parser::catalog::types::{Composite, FieldType, Scalar};
use movement_parser::lowering::expression::{Expression, ObjectMember, StaticValue};
use serde_json::json;

use crate::bindings::{Binding, Edge, LandingShape, Node, Scope};
use crate::env::{self, Trail};
use crate::extract::emission::{self, TracedTree};
use crate::extract::resources::{bound_text, file_handle, is_file_ref};
use crate::extract::run::{CallSettings, FiringScope, Reply, TRACE_INPUT_PARTS, TRACE_ISSUE_LINES, TRACE_REPLY_DIGESTS, reply_digest, thrown};
use crate::extract::spec::{self, NodeSpec, SpecError};
use crate::extract::validate::{self, Issue};
use crate::host;
use crate::js::{self, Js, JsObject};
use crate::run::{Failure, Run, Stop};
use crate::trace::{Members, TraceEntry};

/// `EXTRACT_CALL_SYSTEM_PROMPT`: the same for every call, the shape last.
pub const SYSTEM_PROMPT: &str = "You are an information-extraction system.\n\nYou are given content as numbered items, one block per item, in the order its author listed them. The last block says what to extract from that content and how to answer.\n\nRead every content item. Extract only what the content supports, and cite the item each value came from.";

/// Entities declaring at least this many nodes ask the larger model
/// (model_choice.ts `ENTITY_DENSITY_OPUS_THRESHOLD`).
const ENTITY_DENSITY_OPUS_THRESHOLD: usize = 30;

/// One content file as the prompt reads it (`ContentFile`).
#[derive(Clone)]
struct ContentFile {
    text: Option<String>,
    origin: Option<u32>,
    traced: Js,
}

type FileReading = Result<ContentFile, Failure>;

/// What the call's settings record asks for (`ExtractCallSettings`).
#[derive(Default)]
pub(crate) struct WrittenSettings {
    tier: Option<String>,
    model: Option<String>,
    effort: Option<String>,
}

/// What the run's extraction calls share (`ExtractCallRunState`).
#[derive(Default)]
pub(crate) struct CallState {
    prefixes: RefCell<Prefixes>,
    /// Each file's reading by its handle (else its name): `None` while the
    /// call that started it waits on the host.
    files: RefCell<Vec<(String, Option<FileReading>)>>,
    /// The calls made so far (`extractCallCount`): the site ids' numbers.
    count: Cell<u64>,
}

/// `ExtractCallPrefixes`: the content prefixes sent, per model and effort —
/// a trie of the items, so "the first k items of this call were the first k
/// of an earlier one" is a walk, and nothing is hashed.
#[derive(Default)]
struct Prefixes {
    roots: HashMap<String, usize>,
    children: HashMap<(usize, String), usize>,
    nodes: usize,
}

impl Prefixes {
    fn fresh(&mut self) -> usize {
        self.nodes += 1;
        self.nodes
    }

    /// `plan`: where this call's breakpoints go (the content items whose
    /// blocks end in one) and how many leading items an earlier call sent;
    /// then this call's prefixes remembered.
    fn plan(&mut self, cache_key: &str, items: &[String]) -> (Vec<usize>, usize) {
        let root = match self.roots.get(cache_key) {
            Some(&root) => root,
            None => {
                let root = self.fresh();
                self.roots.insert(cache_key.to_string(), root);
                root
            }
        };
        let mut at = root;
        let mut shared = 0;
        for (k, item) in items.iter().enumerate() {
            let Some(&next) = self.children.get(&(at, item.clone())) else { break };
            at = next;
            shared = k + 1;
        }
        let mut breakpoints = Vec::new();
        if shared > 0 && shared < items.len() {
            breakpoints.push(shared - 1);
        }
        if !items.is_empty() {
            breakpoints.push(items.len() - 1);
        }
        let mut at = root;
        for item in items {
            at = match self.children.get(&(at, item.clone())) {
                Some(&next) => next,
                None => {
                    let next = self.fresh();
                    self.children.insert((at, item.clone()), next);
                    next
                }
            };
        }
        (breakpoints, shared)
    }
}

/// One content item, ready to be a block (`ContentItem`).
struct ContentItem {
    index: usize,
    classification: String,
    block: String,
    origin: Option<u32>,
    file: Option<Js>,
}

/// The call's settings record as written (extract_config.ts
/// `readExtractCallConfig`, without a model list): its tier, model and
/// effort, or what is wrong with it.
pub(crate) fn read_config(slot: &ast::ExprSlot) -> Result<WrittenSettings, Vec<String>> {
    const INVENTORY: &str = "tier — how much the job is worth: 'quick', 'careful', 'thorough'; model — a model this deployment can reach, by its name ('claude-opus-5'), in place of the tier's; effort — how hard that model thinks: 'low', 'medium', 'high', 'xhigh', in place of the tier's";
    let lowered = movement_parser::expr::parse_expression(&slot.raw)
        .ok()
        .and_then(|tree| movement_parser::lowering::lower_expression(&tree, &slot.raw).ok());
    let Some(Expression::Object { entries }) = lowered else {
        return Err(vec![format!(
            "'extract' takes its settings as a record written in place — `extract(content, Shape, {{ tier: 'careful' }})`. The settings are: {INVENTORY}"
        )]);
    };
    let mut problems = Vec::new();
    let mut written: Vec<(String, Expression)> = Vec::new();
    for entry in entries {
        match entry {
            ObjectMember::Spread(_) => {
                problems.push(format!("'extract' takes its settings written out one by one — a spread ('...') is not accepted here. The settings are: {INVENTORY}"))
            }
            ObjectMember::Entry { key, .. } if !matches!(key.as_str(), "tier" | "model" | "effort") => {
                problems.push(format!("'extract' has no setting '{key}'. The settings are: {INVENTORY}"))
            }
            ObjectMember::Entry { key, .. } if written.iter().any(|(k, _)| *k == key) => problems.push(format!("'extract' is given '{key}' twice — write it once")),
            ObjectMember::Entry { key, value } => written.push((key, value)),
        }
    }
    let mut word = |key: &str| -> Option<String> {
        let (_, value) = written.iter().find(|(k, _)| k == key)?;
        match value {
            Expression::Static { value: StaticValue::String(word) } => Some(word.clone()),
            _ => {
                problems.push(format!("'extract': '{key}' is written down, not worked out — write {key}: '…' as a quoted word"));
                None
            }
        }
    };
    let tier = word("tier");
    let effort = word("effort");
    let model = word("model");
    let tier = match tier {
        Some(word) => match crate::extract::run::ai_tier(Some(&word)) {
            Some(tier) => Some(tier.to_string()),
            None => {
                problems.push(format!("'extract': there is no tier '{word}' — write one of 'quick', 'careful', 'thorough'"));
                None
            }
        },
        None => None,
    };
    let effort = match effort {
        Some(word) if matches!(word.as_str(), "low" | "medium" | "high" | "xhigh") => Some(word),
        Some(word) => {
            problems.push(format!("'extract': there is no effort '{word}' — write one of 'low', 'medium', 'high', 'xhigh'"));
            None
        }
        None => None,
    };
    if problems.is_empty() { Ok(WrittenSettings { tier, model, effort }) } else { Err(problems) }
}

/// `unreachedModelMessage` (ai_tiers.ts): why a run refuses an extraction
/// call's written `model`, the list it is not in printed.
fn unreached_model_message(model: &str, models: &[String]) -> String {
    let reached = if models.is_empty() { "none".to_string() } else { models.iter().map(|m| format!("'{m}'")).collect::<Vec<_>>().join(", ") };
    format!("'extract''s model '{model}' is not a model this deployment reaches — it reaches {reached}")
}

/// `countShapeNodes`: what the density heuristic picks a model by.
fn count_shape_nodes(spec: &NodeSpec) -> usize {
    1 + spec.stages.first().map_or(0, |stage| stage.children.iter().map(count_shape_nodes).sum())
}

/// The site id's slug: `name.toLowerCase().replace(/[^a-z0-9]+/g, '_')`.
fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in js::to_lower_case(name).chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    out
}

fn answer_key(one: bool) -> &'static str {
    if one { "record" } else { "records" }
}

/// `describeGuideType`: a field's type as the entity guide names it.
fn guide_type(type_: Option<&FieldType>) -> String {
    let Some(type_) = type_ else { return "text".into() };
    match type_ {
        FieldType::Scalar(scalar) => match scalar {
            Scalar::Text | Scalar::Number | Scalar::Boolean | Scalar::Date | Scalar::Datetime | Scalar::File | Scalar::Json | Scalar::Absent | Scalar::Never => {
                scalar.name().into()
            }
        },
        FieldType::Composite(composite) => match composite {
            Composite::List { of, .. } => format!("list of {}", guide_type(Some(of))),
            Composite::MaybeAbsent { of } => guide_type(Some(of)),
            Composite::Tuple { .. } => "a list of values".into(),
            Composite::Dict { .. } => "a set of named values".into(),
            Composite::Record { .. } => "a record".into(),
            Composite::Union { of } => of.iter().map(|member| guide_type(Some(member))).collect::<Vec<_>>().join(" or "),
            Composite::Enum { options, open: Some(_) } => format!("text, known values: {}", options.join(" | ")),
            Composite::Enum { options, open: None } => format!("enum: {}", options.join(" | ")),
        },
    }
}

/// `described`: `: <words>` after a name, nothing without words.
fn described(description: &str) -> String {
    if description.is_empty() { String::new() } else { format!(": {description}") }
}

/// `guideLines`: the shape as the prompt describes it, nested nodes
/// indented under their parents.
fn guide_lines(spec: &NodeSpec, parent: Option<&str>, depth: usize, one: bool, into: &mut Vec<String>) {
    let indent = "  ".repeat(depth);
    let words = described(&spec.description);
    into.push(match parent {
        None if one => format!("{indent}**{}**{words} — the one record, as the object under `record`", spec.name),
        None => format!("{indent}**{}**{words} — emit each one as an element of the `records` array (zero, one, or many, as the description says)", spec.name),
        Some(parent) => format!("{indent}**{}** (an array under the key `{}` inside each **{parent}**){words}", spec.name, spec.name),
    });
    let stage = spec.stages.first();
    let fields = stage.map_or(&[][..], |s| s.fields.as_slice());
    if fields.is_empty() {
        into.push(format!("{indent}    (no fields — structural only)"));
    }
    for field in fields {
        into.push(format!(
            "{indent}    - `{}` ({}){}",
            field.name,
            guide_type(field.type_.as_ref()),
            described(&field.description)
        ));
    }
    for child in stage.map_or(&[][..], |s| s.children.as_slice()) {
        guide_lines(child, Some(&spec.name), depth + 1, one, into);
    }
}

/// `shapeBlock`: the last block — what to extract, how to answer, the rules.
fn shape_block(spec: &NodeSpec, items: &[usize], one: bool) -> String {
    let mut lines: Vec<String> = vec!["## What to extract".into(), String::new()];
    if one {
        let description = js::trim(&spec.description);
        lines.push(if description.is_empty() {
            format!("Extract the single **{}** these sources describe, or nothing if they don't.", spec.name)
        } else {
            format!("Extract {description} — the single one these sources describe, or nothing if they don't.")
        });
        lines.push(String::new());
    }
    let mut guide = Vec::new();
    guide_lines(spec, None, 0, one, &mut guide);
    lines.push(guide.join("\n"));
    lines.extend(["".into(), "## How to answer".into(), "".into()]);
    lines.push(if one {
        "Return a JSON object with one key, `record`, whose value is the one record as a bare JSON object — or null when these sources describe none. Never an array: this asks for one record. A nested node is a bare array of its own records under its key inside the record.".into()
    } else {
        "Return a JSON object with one key, `records`, whose value is a bare JSON array of records. A nested node is a bare array of its own records under its key inside its parent record.".into()
    });
    lines.extend([
        String::new(),
        "Every field is answered as `{ \"value\": …, \"evidence\": { \"item\": <n>, \"quote\": \"…\" } }` — the typed value, the number of the content item it came from, and a quote of the passage that supports it. Use null for a value the content does not give.".into(),
        String::new(),
        "## Rules".into(),
        format!(
            "- `item` is the number in the heading of the content block the value came from ({}). When a value is composed from several items, cite the one that carries most of it.",
            items.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(", ")
        ),
        "- The `{ value, evidence }` wrapping belongs to a FIELD and to nothing else. A list of records is a bare array and a record is a bare object.".into(),
        "- Every key inside a record is a field or nested node the guide declares for it. Do not rename a field or answer under a key of your own.".into(),
        "- A field's description is authoritative. When it asks you to compose, normalise or reformat a value, produce that value and quote the passage(s) it was built from.".into(),
        "- Use null only when the content genuinely lacks the information. Never stand a missing value in with an empty string or a placeholder like \"none\", \"N/A\" or \"unknown\".".into(),
        if one {
            "- Answer `record` as null rather than a record with every field null. Records of the same nested kind must be distinct; omit a nested record rather than emitting one with every field null.".into()
        } else {
            "- Records of the same kind must be distinct. Omit a record entirely rather than emitting one with every field null.".into()
        },
    ]);
    lines.join("\n")
}

/// `correctionLine`.
fn correction_line(one: bool) -> &'static str {
    if one { "with the one record (or null) under `record`" } else { "with every record under `records`" }
}

/// What the answer's records tallied (`RecordTallies`), by node name in the
/// order first met.
#[derive(Default)]
struct Tallies {
    empty: Vec<(String, f64)>,
    dropped: Vec<(String, f64)>,
}

fn bump(into: &mut Vec<(String, f64)>, name: &str) {
    match into.iter_mut().find(|(n, _)| n == name) {
        Some((_, n)) => *n += 1.0,
        None => js::insert_in_object_order(into, name.to_string(), 1.0),
    }
}

fn counted(counts: &[(String, f64)]) -> Js {
    let mut object = JsObject::new();
    for (name, n) in counts {
        object.set(name.clone(), Js::Number(*n));
    }
    Js::object(object)
}

/// `readsAsPresentText`: plain text not marked `| null`, handed over as
/// `""` when nothing was found.
fn reads_as_present_text(field: &spec::FieldSpec) -> bool {
    !field.nullable && matches!(field.type_, None | Some(FieldType::Scalar(Scalar::Text)))
}

/// `landingShapeOf`.
fn landing_shape_of(spec: &NodeSpec) -> LandingShape {
    let stage = spec.stages.first();
    LandingShape {
        fields: stage.map_or_else(Vec::new, |s| s.fields.iter().map(|f| f.name.clone()).collect()),
        edges: stage.map_or_else(Vec::new, |s| s.children.iter().map(|c| (c.name.clone(), landing_shape_of(c))).collect()),
    }
}

fn blank(value: Option<&Js>) -> bool {
    match value {
        None | Some(Js::Undefined | Js::Null) => true,
        Some(Js::String(text)) => text.is_empty(),
        _ => false,
    }
}

/// One record and the records under it, for the trace's sample (`treeOf`).
fn tree_of(record: &Node, spec: &NodeSpec) -> TracedTree {
    let mut children = Vec::new();
    for child in spec.stages.first().map_or(&[][..], |s| s.children.as_slice()) {
        for landing in record.landings(&child.name) {
            if let Binding::Node(node) = landing {
                children.push(tree_of(&node.borrow(), child));
            }
        }
    }
    TracedTree { node_name: spec.name.clone(), fields: record.fields.entries().to_vec(), children }
}

impl Run<'_> {
    /// `found = extract(content, Shape, { … })` (`runExtractCall`): the
    /// shape's spec, the call's settings, the content evaluated, then the
    /// call itself.
    pub(crate) async fn extract_call(&self, call: &ast::ExtractCallExpression, scope: &Rc<Scope>) -> Result<Binding, Stop> {
        let runtime = |message: String| thrown(Failure::engine("MOVENG_RUNTIME", message));
        let shape = match &call.shape {
            ExtractCallShape::Computed { expr, .. } => {
                return Err(runtime(format!(
                    "'extract' takes a node declaration as its shape, and '{}' is worked out (the checker should have caught this)",
                    expr.raw
                )));
            }
            // Bound for this call only, as the checker scoped it: a local
            // declaration of the calling body's.
            ExtractCallShape::Inline { declaration, .. } => {
                spec::ShapeLink { declaration: (**declaration).clone(), file: scope.file_env(), words: spec::WordsScope::Body(scope.clone()) }
            }
            ExtractCallShape::Named { name, .. } => {
                let declared = match scope.resolve(name) {
                    Some(Binding::Shape(declared)) => Some(self.shape_link(&declared)),
                    _ => None,
                };
                declared.ok_or_else(|| runtime(format!("'{name}' is not a node declaration in scope, so 'extract' has no shape to fill (the checker should have caught this)")))?
            }
        };
        // The extractor is told the declaration's own name, whatever name
        // reached it.
        let declared_name = shape.declaration.name.clone();
        let firing = FiringScope::new(self, scope);
        let spec = spec::build_declaration_spec(&declared_name, &shape, &self.checked.declarations, &firing).await.map_err(|error| match error {
            SpecError::Runtime(message) => runtime(message),
            SpecError::Firing(stop) => stop,
        })?;
        let settings = self.extract_call_settings(call, &spec)?;
        let content = self.evaluate_slot(&call.content, scope).await?;
        let trail = self.trail_of(&content.prov, scope).unwrap_or_default();
        let count = self.extract_calls.count.get() + 1;
        self.extract_calls.count.set(count);
        let site_id = format!("xc:{}#{count}", slug(&declared_name));
        let one = matches!(call.finds, ExtractCallFinds::One);
        self.run_extract_call(&content.value, &trail, &spec, one, &settings, &site_id).await
    }

    /// `extractCallSettings`: the tier's assignment on this deployment, then
    /// the author's model and effort. A model is held to the catalog
    /// snapshot's `models`, the run's one list (ai_tiers.ts `runChatModels`,
    /// which the shim always sends) and the one the checker held it to, so
    /// only an unchecked program fails here, in the TypeScript's words
    /// (`unreachedModelMessage`). With no list (an embedder that sends none),
    /// the TypeScript would ask the model registry, which this engine does
    /// not hold, and the call is refused as its own.
    fn extract_call_settings(&self, call: &ast::ExtractCallExpression, spec: &NodeSpec) -> Result<CallSettings, Stop> {
        let WrittenSettings { tier, model, effort } = match &call.config {
            None => WrittenSettings::default(),
            Some(slot) => read_config(slot).map_err(|problems| {
                thrown(Failure::engine("MOVENG_RUNTIME", format!("invalid 'extract' settings (the checker should have caught this): {}", problems.join("; "))))
            })?,
        };
        if let Some(model) = &model {
            let Some(models) = self.catalog.models.as_ref() else {
                return Err(thrown(Failure::unreproduced(
                    &format!("'extract''s model '{model}' with no model list holding it"),
                    "the Rust engine holds a model to the catalog snapshot's `models`",
                )));
            };
            if !models.contains(model) {
                return Err(thrown(Failure::engine("MOVENG_RUNTIME", unreached_model_message(model, models))));
            }
        }
        let density = if count_shape_nodes(spec) >= ENTITY_DENSITY_OPUS_THRESHOLD { "opus" } else { "sonnet" };
        Ok(crate::extract::run::extraction_call_settings_over(tier.as_deref(), density, &self.input.extraction_tiers, model.as_deref(), effort.as_deref()))
    }

    /// `contentFile`: one content file's bounded text, or why there is none
    /// — once per file for the whole run (by its handle, else its name).
    async fn content_file(&self, file: &Js) -> Result<ContentFile, Failure> {
        let handle = file_handle(file);
        let name = match crate::unique::get(file, "name") {
            Js::String(name) => Some(name.into_string()),
            _ => None,
        };
        let Some(key) = handle.clone().or(name) else { return self.read_content_file(file, None).await };
        let started = {
            let files = self.extract_calls.files.borrow();
            files.iter().find(|(k, _)| *k == key).map(|(_, state)| state.is_some())
        };
        if started.is_none() {
            self.extract_calls.files.borrow_mut().push((key.clone(), None));
            let read = self.read_content_file(file, handle).await;
            if let Some(slot) = self.extract_calls.files.borrow_mut().iter_mut().find(|(k, _)| *k == key) {
                slot.1 = Some(read.clone());
            }
            return read;
        }
        // Another call is reading it, or has: its reading is this one's.
        std::future::poll_fn(|_| {
            let files = self.extract_calls.files.borrow();
            match files.iter().find(|(k, _)| *k == key) {
                Some((_, Some(read))) => std::task::Poll::Ready(read.clone()),
                _ => std::task::Poll::Pending,
            }
        })
        .await
    }

    /// The reading itself (`contentFile`'s `read`).
    async fn read_content_file(&self, file: &Js, handle: Option<String>) -> Result<ContentFile, Failure> {
        let member = |value: &Js, key: &str| crate::unique::get(value, key);
        let mut named = Vec::new();
        for key in ["name", "contentType"] {
            let value = member(file, key);
            if !matches!(value, Js::Undefined) {
                named.push((key, value));
            }
        }
        let result = self.resolve_file_text(file).await?;
        if let Js::String(why) = member(&result, "unreadable") {
            let mut traced = named;
            traced.push(("unreadable", Js::String(why)));
            let detail = member(&result, "detail");
            if !matches!(detail, Js::Undefined) {
                traced.push(("detail", detail));
            }
            return Ok(ContentFile { text: None, origin: None, traced: env::object_of(traced) });
        }
        let text = member(&result, "text").to_js_string();
        if js::trim(&text).is_empty() {
            let mut traced = named;
            traced.push(("unreadable", Js::str("no_text")));
            return Ok(ContentFile { text: None, origin: None, traced: env::object_of(traced) });
        }
        let ceiling = self.input.extraction_file_chars;
        let (content, chars, truncated_from) = bound_text(&text, ceiling);
        if let Some(of) = truncated_from {
            let mut fields = serde_json::Map::new();
            if let Js::String(name) = member(file, "name") {
                fields.insert("name".into(), json!(name));
            }
            fields.insert("chars".into(), env::json_of_js(&Js::Number(ceiling)));
            fields.insert("of".into(), json!(of));
            self.log("warn", "[movement:extract] truncating a source file for the prompt", fields);
        }
        let mut origin = vec![("kind", Js::str("file"))];
        let raw_text_id = member(&result, "rawTextId");
        if !matches!(raw_text_id, Js::Undefined) {
            origin.push(("rawTextId", raw_text_id));
        }
        if let Some(handle) = handle {
            origin.push(("handle", Js::str(handle)));
        }
        origin.extend(named.iter().cloned());
        let origin = self.mint_origin(env::object_of(origin));
        let mut traced = named;
        traced.push(("chars", Js::Number(chars)));
        if let Some(from) = truncated_from {
            traced.push(("truncatedFrom", Js::Number(from as f64)));
        }
        Ok(ContentFile { text: Some(content), origin: Some(origin), traced: env::object_of(traced) })
    }

    /// `contentItems`: one block per item, in order; an item's number is
    /// its place in the list, so an absent item has no block and a file
    /// nothing could read says so in its block.
    async fn content_items(&self, content: &Js) -> Result<Vec<ContentItem>, Stop> {
        let list = match content {
            Js::Array(list) => list.items().clone(),
            other => vec![other.clone()],
        };
        let mut items = Vec::new();
        for (index, value) in list.iter().enumerate() {
            if value.is_nullish() {
                continue;
            }
            if is_file_ref(value) {
                let file = self.content_file(value).await.map_err(thrown)?;
                let label = match crate::unique::get(value, "name") {
                    Js::Undefined => "file".to_string(),
                    name => format!("file \"{}\"", name.to_js_string()),
                };
                let body = file.text.clone().unwrap_or_else(|| {
                    let why = match crate::unique::get(&file.traced, "unreadable") {
                        Js::Undefined => "no_text".to_string(),
                        why => why.to_js_string(),
                    };
                    format!("[this file could not be read: {why}]")
                });
                items.push(ContentItem {
                    index,
                    classification: format!("item {index} (file)"),
                    block: format!("## Content item {index} ({label})\n{body}"),
                    origin: file.origin,
                    file: Some(file.traced),
                });
                continue;
            }
            if matches!(value, Js::Array(_) | Js::Object(_) | Js::Record(_)) {
                let what = if matches!(value, Js::Array(_)) { "list" } else { "record" };
                return Err(thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!("content item {index} of 'extract' is a {what}, and 'extract' reads text and files — render it as text with TEXT.SERIALISE(value, 'JSON') (the checker should have caught this)"),
                )));
            }
            let text = value.to_js_string();
            if js::trim(&text).is_empty() {
                continue;
            }
            items.push(ContentItem { index, classification: format!("item {index} (text)"), block: format!("## Content item {index} (text)\n{text}"), origin: None, file: None });
        }
        Ok(items)
    }

    /// `runExtractCall`: the records found — a list of them, or the one
    /// record or absent. A reply that answers some other question is asked
    /// once more, then raised.
    async fn run_extract_call(&self, content: &Js, content_trail: &Trail, spec: &NodeSpec, one: bool, settings: &CallSettings, site_id: &str) -> Result<Binding, Stop> {
        let items = self.content_items(content).await?;
        let files: Vec<Js> = items.iter().filter_map(|item| item.file.clone()).collect();
        let parts: Vec<(String, usize)> = items.iter().map(|item| (item.classification.clone(), js::utf16_len(&item.block))).collect();
        let number = |n: usize| Js::Number(n as f64);
        let mut shape = Members::default();
        shape.set("form", Js::str("call"));
        shape.set("node", Js::str(spec.name.clone()));
        shape.set("inputChars", number(parts.iter().map(|(_, chars)| chars).sum()));
        if !parts.is_empty() {
            let shown = parts.iter().take(TRACE_INPUT_PARTS).map(|(c, n)| env::object_of(vec![("classification", Js::str(c.clone())), ("chars", number(*n))]));
            shape.set("inputs", Js::array(shown.collect()));
        }
        if parts.len() > TRACE_INPUT_PARTS {
            shape.set("inputsTruncated", number(parts.len() - TRACE_INPUT_PARTS));
        }
        if !files.is_empty() {
            shape.set("files", Js::array(files.iter().take(TRACE_INPUT_PARTS).cloned().collect()));
        }
        if files.len() > TRACE_INPUT_PARTS {
            shape.set("filesTruncated", number(files.len() - TRACE_INPUT_PARTS));
        }
        let tally = |n: usize| counted(&[(spec.name.clone(), n as f64)]);
        if items.is_empty() {
            // Nothing to read is nothing found — said on the run.
            let mut entry = shape;
            entry.set("skipped", Js::str("empty_source"));
            entry.set("emissions", tally(0));
            self.trace(TraceEntry::Extraction(entry));
            return Ok(answer_of(Vec::new(), one));
        }

        let cache_key = format!("{}|{}", settings.model, settings.effort.as_deref().unwrap_or("undefined"));
        let blocks: Vec<String> = items.iter().map(|item| item.block.clone()).collect();
        let (breakpoints, shared_items) = self.extract_calls.prefixes.borrow_mut().plan(&cache_key, &blocks);
        let content_blocks: Vec<serde_json::Value> = items
            .iter()
            .enumerate()
            .map(|(position, item)| if breakpoints.contains(&position) { json!({ "text": item.block, "cacheBreakpoint": true }) } else { json!({ "text": item.block }) })
            .collect();
        let shown: Vec<usize> = items.iter().map(|item| item.index).collect();
        let guide = shape_block(spec, &shown, one);
        let mut data_sources: Vec<Js> = content_trail.origins.iter().map(|id| self.origin(*id)).collect();
        data_sources.extend(items.iter().filter_map(|item| item.origin).map(|id| self.origin(id)));
        let site = env::object_of(vec![
            ("siteId", Js::str(site_id)),
            ("node", Js::str(spec.name.clone())),
            ("description", Js::str(spec.description.clone())),
            ("stage", Js::Number(0.0)),
            ("dataSources", Js::array(data_sources)),
        ]);

        let mut usage: Vec<Js> = Vec::new();
        let started = self.clock_now().await.map_err(thrown)?;
        let first = self.ask_extract_call(&content_blocks, &guide, "movement_extract_call", settings, &mut usage).await?;
        let mut last_reply = Some(first.clone());
        let mut read = read_reply(spec, one, &first);
        let mut retried: Option<Vec<String>> = None;
        if let Err(issues) = &read {
            let lines = validate::issue_lines(issues);
            retried = Some(lines.iter().take(TRACE_ISSUE_LINES).cloned().collect());
            let last = format!(
                "{guide}\n\n---\n\nYour previous response had validation errors:\n{}\n\nReturn the complete corrected JSON, {}.",
                lines.join("\n"),
                correction_line(one)
            );
            let retry = self.ask_extract_call(&content_blocks, &last, "movement_extract_call_retry", settings, &mut usage).await?;
            last_reply = Some(retry.clone());
            read = read_reply(spec, one, &retry);
            if let Err(issues) = &read {
                let mut entry = shape;
                entry.set("emissions", tally(0));
                entry.set("failed", Js::str("invalid_reply"));
                entry.set("retried", strings(retried.as_deref().unwrap_or_default()));
                self.digest_into(&mut entry, last_reply.as_ref(), &["failed", "retried"]);
                self.telemetry_into(&mut entry, settings, started, &breakpoints, &items, shared_items, &usage).await?;
                self.trace(TraceEntry::Extraction(entry));
                let (path, message) = match issues.first() {
                    Some(issue) => {
                        let path = validate::issue_path(issue);
                        (if path.is_empty() { "the reply".to_string() } else { path }, issue.message.clone())
                    }
                    None => ("the reply".to_string(), "unreadable".to_string()),
                };
                return Err(thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!("The extraction of `{}` was answered with something its shape does not describe, twice: {path} — {message}.", spec.name),
                )));
            }
        }
        let Ok(read) = read else { unreachable!("an unread reply failed above") };
        let reply = match &read.value {
            Js::Object(object) => object.get(answer_key(one)).cloned().unwrap_or(Js::Undefined),
            _ => Js::Undefined,
        };
        let records = match reply {
            Js::Array(list) => list.items().clone(),
            nullish if nullish.is_nullish() => Vec::new(),
            record => vec![record],
        };
        let answered = records.iter().filter(|r| matches!(r, Js::Object(_))).count();
        let shown_set = shown;
        let mut tallies = Tallies::default();
        let landings = self.build_records(&records, spec, &site, &shown_set, &mut tallies);
        let mut why: Vec<&str> = Vec::new();
        if answered == 0 {
            why.push("no_entities");
        }
        if !tallies.dropped.is_empty() {
            why.push("dropped_records");
        }
        if retried.is_some() {
            why.push("retried");
        }
        let mark = self.trace.len();
        let mut entry = shape;
        entry.set("emissions", tally(answered));
        if let Some(retried) = &retried {
            entry.set("retried", strings(retried));
        }
        self.digest_into(&mut entry, last_reply.as_ref(), &why);
        if !tallies.empty.is_empty() {
            entry.set("empty", counted(&tallies.empty));
        }
        if !tallies.dropped.is_empty() {
            entry.set("dropped", counted(&tallies.dropped));
        }
        if !read.coercions.values.is_empty() {
            let mut object = JsObject::new();
            for (key, values) in &read.coercions.values {
                object.set(key.clone(), strings(values));
            }
            entry.set("coerced", Js::object(object));
        }
        self.telemetry_into(&mut entry, settings, started, &breakpoints, &items, shared_items, &usage).await?;
        self.trace(TraceEntry::Extraction(entry));
        // The keyword's tree has an unnamed root over its top-level records.
        let trees = landings
            .iter()
            .filter_map(|landing| match landing {
                Binding::Node(node) => Some(tree_of(&node.borrow(), spec)),
                _ => None,
            })
            .collect();
        let root = TracedTree { node_name: spec::ROOT_NAME.into(), fields: Vec::new(), children: trees };
        crate::extract::run::record_traced_entities(self, mark, emission::traced_entities_of(&root));
        Ok(answer_of(landings, one))
    }

    /// One `llm.extractCall.call`, the cancel gate before it, priced.
    async fn ask_extract_call(&self, content: &[serde_json::Value], last: &str, label: &str, settings: &CallSettings, usage: &mut Vec<Js>) -> Result<Reply, Stop> {
        self.throw_if_cancelled().await?;
        let mut blocks = content.to_vec();
        blocks.push(json!({ "text": last }));
        let request = host::llm::extract_call(self.segment(), SYSTEM_PROMPT, blocks, label, settings, self.ledger.budget());
        let answer = self.priced(request).await.map_err(thrown)?;
        let member = |key: &str| crate::unique::get(&answer, key);
        let used = member("usage");
        if !matches!(used, Js::Undefined) {
            usage.push(used);
        }
        Ok(Reply {
            parsed_json: member("parsedJson"),
            raw_text: match member("rawText") {
                Js::String(text) => Some(text.into_string()),
                _ => None,
            },
        })
    }

    /// `digestOf`: what the model replied, while the run's budget of
    /// digests has room.
    fn digest_into(&self, entry: &mut Members, reply: Option<&Reply>, why: &[&str]) {
        if self.reply_digests.get() >= TRACE_REPLY_DIGESTS {
            return;
        }
        if let Some(digest) = reply.and_then(|reply| reply_digest(reply, why, None)) {
            entry.set("reply", digest);
            self.reply_digests.set(self.reply_digests.get() + 1);
        }
    }

    /// `telemetry`: the model, how long the call took, and the cache's part.
    #[allow(clippy::too_many_arguments)]
    async fn telemetry_into(
        &self,
        entry: &mut Members,
        settings: &CallSettings,
        started: f64,
        breakpoints: &[usize],
        items: &[ContentItem],
        shared_items: usize,
        usage: &[Js],
    ) -> Result<(), Stop> {
        entry.set("model", Js::str(settings.model.clone()));
        let now = self.clock_now().await.map_err(thrown)?;
        entry.set("durationMs", Js::Number(now - started));
        let mut cache = vec![
            ("breakpoints", Js::array(breakpoints.iter().map(|&position| Js::Number(items[position].index as f64)).collect())),
            ("sharedItems", Js::Number(shared_items as f64)),
        ];
        if !usage.is_empty() {
            let sum = |key: &str| usage.iter().map(|u| crate::unique::get(u, key).to_number()).fold(0.0, |total, n| total + n);
            cache.push(("inputTokens", Js::Number(sum("inputTokens"))));
            cache.push(("readTokens", Js::Number(sum("cacheReadTokens"))));
            cache.push(("writeTokens", Js::Number(sum("cacheCreationTokens"))));
        }
        entry.set("cache", env::object_of(cache));
        Ok(())
    }

    /// `buildRecords`: each answered record a node of the run's own — its
    /// fields (blank is absent, plain text present), each cited at the
    /// call's site with the model's quote and the item it named (an item
    /// never shown is no citation), its nested nodes edges of their own; a
    /// record with nothing in it dropped and counted.
    fn build_records(&self, raw: &[Js], spec: &NodeSpec, site: &Js, shown: &[usize], tallies: &mut Tallies) -> Vec<Binding> {
        let stage = spec.stages.first();
        let fields_of = stage.map_or(&[][..], |s| s.fields.as_slice());
        let children_of = stage.map_or(&[][..], |s| s.children.as_slice());
        let mut records = Vec::new();
        for entry in raw {
            let Js::Object(entry) = entry else { continue };
            let mut fields = JsObject::new();
            let mut provenance = Vec::new();
            for field in fields_of {
                let answer = js::object_property(entry, &field.name);
                let given = match &answer {
                    Js::Object(object) => object.get("value").cloned().unwrap_or(Js::Undefined),
                    _ => Js::Undefined,
                };
                let value = if matches!(field.type_, Some(FieldType::Scalar(Scalar::Json))) {
                    if given.is_nullish() { Js::Null } else { given }
                } else {
                    emission::absent_if_blank(&given)
                };
                let value = if matches!(value, Js::Null) && reads_as_present_text(field) { Js::str("") } else { value };
                fields.set(field.name.clone(), value);
                let evidence = match &answer {
                    Js::Object(object) => object.get("evidence").cloned().unwrap_or(Js::Undefined),
                    _ => Js::Undefined,
                };
                let mut origin = vec![
                    ("kind", Js::str("extraction")),
                    ("site", site.clone()),
                    ("field", Js::str(field.name.clone())),
                    ("description", Js::str(field.description.clone())),
                ];
                if let Js::String(quote) = crate::unique::get(&evidence, "quote")
                    && !quote.is_empty()
                {
                    origin.push(("quote", Js::String(quote)));
                }
                if let Js::Number(item) = crate::unique::get(&evidence, "item")
                    && js::is_integer(item)
                    && item >= 0.0
                    && shown.contains(&(item as usize))
                {
                    origin.push(("item", Js::Number(item)));
                }
                let id = self.mint_origin(env::object_of(origin));
                js::insert_in_object_order(&mut provenance, field.name.clone(), Trail { origins: vec![id], direct: Some(id) });
            }
            let mut edges = Vec::new();
            for child in children_of {
                let nested = match js::object_property(entry, &child.name) {
                    Js::Array(list) => list.items().clone(),
                    _ => Vec::new(),
                };
                let landings = self.build_records(&nested, child, site, shown, tallies);
                edges.push((child.name.clone(), Edge { landings, shape: Some(landing_shape_of(child)), deferred: None }));
            }
            let node = Node {
                fields,
                field_order: fields_of.iter().map(|f| f.name.clone()).collect(),
                field_provenance: provenance,
                landed_on: Some(spec.name.clone()),
                edges,
            };
            let blank_fields = !fields_of.is_empty() && fields_of.iter().all(|f| blank(node.fields.get(&f.name)));
            if blank_fields {
                bump(&mut tallies.empty, &spec.name);
            }
            let empty = fields_of.iter().all(|f| blank(node.fields.get(&f.name))) && node.edges.iter().all(|(_, edge)| edge.landings.is_empty());
            if empty {
                bump(&mut tallies.dropped, &spec.name);
                continue;
            }
            records.push(Binding::Node(Rc::new(RefCell::new(node))));
        }
        records
    }
}

/// The reply read by the call's schema.
fn read_reply(spec: &NodeSpec, one: bool, reply: &Reply) -> Result<validate::Read, Vec<Issue>> {
    validate::read_call_reply(spec, one, &reply.parsed_json)
}

fn strings(lines: &[String]) -> Js {
    Js::array(lines.iter().map(|line| Js::str(line.clone())).collect())
}

/// `answerOf`: `extract`'s list of records; `extractOne`'s record, or
/// absent.
fn answer_of(landings: Vec<Binding>, one: bool) -> Binding {
    if !one {
        return Binding::Positions(landings);
    }
    landings.into_iter().next().unwrap_or_else(|| crate::record::bind_value(Js::Null, Some(Trail::default()), false))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A later call over the same leading content reads it from the cache
    /// the first call wrote: its breakpoints are the end of the shared
    /// prefix and the end of its own content.
    #[test]
    fn a_shared_content_prefix_is_found_and_marked() {
        let mut prefixes = Prefixes::default();
        let items = |xs: &[&str]| xs.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(prefixes.plan("m|e", &items(&["a", "b"])), (vec![1], 0));
        assert_eq!(prefixes.plan("m|e", &items(&["a", "c"])), (vec![0, 1], 1));
        assert_eq!(prefixes.plan("m|e", &items(&["a", "b"])), (vec![1], 2));
        assert_eq!(prefixes.plan("other|e", &items(&["a", "b"])), (vec![1], 0));
        assert_eq!(prefixes.plan("m|e", &[]), (vec![], 0));
    }

    #[test]
    fn a_site_slug_folds_every_run_of_other_characters() {
        assert_eq!(slug("Company"), "company");
        assert_eq!(slug("Big Deal—Plan 2"), "big_deal_plan_2");
        assert_eq!(slug("a😀b"), "a_b");
    }
}
