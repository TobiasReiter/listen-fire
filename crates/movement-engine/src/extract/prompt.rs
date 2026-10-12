//! What one region's call says to the model, byte for byte as extraction.ts
//! says it: the system prompt (`buildSystemPrompt`: the entity guide, the
//! task, the rules), the user message (`renderUserMessage`: the source
//! segments, then for a per-entity call the entity so far and what its
//! stage's plugins brought back), and the retry's (`retryUserMessage`).

use movement_parser::catalog::types::{Composite, FieldType, Scalar};

use crate::extract::spec::Region;
use crate::extract::validate::{Issue, issue_lines, retry_instruction};
use crate::js::{self, Js};

/// One labelled piece of the source content (`Segment`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub classification: String,
    pub content: String,
}

/// What one plugin of a stage brought back, as the prompt shows it.
#[derive(Debug, Clone)]
pub struct Enrichment {
    pub plugin: String,
    pub text: Option<String>,
    /// An object.
    pub data: Option<Js>,
}

/// The entity a per-entity call refines: its node's words, its fields so
/// far (an object), and its stage's enrichments.
#[derive(Debug, Clone)]
pub struct Entity {
    pub description: String,
    pub context: Js,
    pub enrichments: Vec<Enrichment>,
}

/// A rendered user message and its shape: one labelled part per segment,
/// entity block and enrichment, `chars` in UTF-16 units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserMessage {
    pub text: String,
    pub parts: Vec<(String, usize)>,
}

/// `describeGuideType`: a field's type as the entity guide names it.
pub fn guide_type(type_: Option<&FieldType>) -> String {
    let Some(type_) = type_ else { return "text".into() };
    match type_ {
        FieldType::Scalar(scalar) => match scalar {
            Scalar::Text | Scalar::Number | Scalar::Boolean | Scalar::Date | Scalar::Datetime | Scalar::File | Scalar::Json | Scalar::Absent => {
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
pub fn described(description: &str) -> String {
    if description.is_empty() { String::new() } else { format!(": {description}") }
}

fn guide_section(site: &Region<'_>, parent: Option<&Region<'_>>, into: &mut Vec<String>) {
    let cardinality = if site.single {
        " (exactly one entity)"
    } else {
        " (emit each matching entity as an array element — zero, one, or many objects depending on the description)"
    };
    let head = match parent {
        Some(parent) => format!(
            "**{}** (an array under the key `{}` inside each **{}** entity){}{cardinality}",
            site.site_id,
            site.spec.name,
            parent.site_id,
            described(&site.spec.description)
        ),
        None => format!("**{}**{}{cardinality}", site.site_id, described(&site.spec.description)),
    };
    let lines: Vec<String> = site
        .fields()
        .iter()
        .map(|f| format!("    - `{}` ({}){}", f.name, guide_type(f.type_.as_ref()), described(&f.description)))
        .collect();
    let body = if lines.is_empty() { "    (no scalar fields — structural only)".to_string() } else { lines.join("\n") };
    into.push(format!("{head}\n{body}"));
    for child in &site.children {
        guide_section(child, Some(site), into);
    }
}

/// `buildSystemPrompt`.
pub fn system_prompt(region: &Region<'_>) -> String {
    let mut sections = Vec::new();
    guide_section(region, None, &mut sections);
    [
        "You are an information-extraction system.".to_string(),
        String::new(),
        "## Entity Guide".into(),
        sections.join("\n\n"),
        String::new(),
        "## Task".into(),
        "Extract structured data from the input message. For each field, return `{ evidence, value }` — the typed value, plus a quote of the source passage that supports it. Use null for missing values.".into(),
        String::new(),
        format!(
            "The response is a JSON object with one key — `{}` — whose value is a bare JSON array of entity objects. Nested entities are emitted as bare arrays under their declared keys inside their parent entity.",
            region.site_id
        ),
        String::new(),
        "## Rules".into(),
        "- Give every field an `evidence` quote of the closest supporting source passage you can find.".into(),
        "- The `{ evidence, value }` wrapping belongs to a FIELD and to nothing else. A list of entities is a bare array and an entity is a bare object: never give either one an `evidence` of its own, and never wrap either one in a `{ evidence, value }` pair.".into(),
        "- Every key inside an entity is a field name the guide declares for that entity. Do not rename a field, translate it, or answer under a key of your own.".into(),
        "- The field's description is authoritative. When it asks you to compose, normalize, reformat, or prefix a value — joining a brand name with a product name shown elsewhere, say — produce that composed value and quote the passage(s) it was built from.".into(),
        "- Never return null merely because the finished value does not appear verbatim in the source.".into(),
        "- Use null only when the source genuinely lacks the information. Do not invent values that have no support in the source.".into(),
        "- A missing value is null. Never stand one in with an empty string, whitespace, or a placeholder like \"none\", \"N/A\" or \"unknown\".".into(),
        "- Entities of the same type must have unique names.".into(),
        "- Where the guide permits zero entities, omit an entity entirely rather than emitting it with every field null — unless its description explicitly allows empty or placeholder entities.".into(),
    ]
    .join("\n")
}

/// `renderUserMessage`.
pub fn user_message(segments: &[Segment], entity: Option<&Entity>) -> UserMessage {
    let mut message = UserMessage { text: String::new(), parts: Vec::new() };
    let mut rendered: Vec<String> = Vec::new();
    let mut push = |classification: &str, body: String| {
        message.parts.push((classification.to_string(), js::utf16_len(&body)));
        rendered.push(body);
    };
    for segment in segments {
        push(&segment.classification, format!("## {}\n{}", segment.classification, segment.content));
    }
    if let Some(entity) = entity {
        push(
            "CURRENT ENTITY",
            [
                "## CURRENT ENTITY".to_string(),
                format!("You are extracting the remaining fields of one already-identified entity{}", described(&entity.description)),
                "```json".into(),
                js::json_stringify(&entity.context, 2),
                "```".into(),
            ]
            .join("\n"),
        );
        for enrichment in &entity.enrichments {
            let mut lines = vec![format!("## ENRICHMENT via `{}`", enrichment.plugin)];
            if let Some(text) = enrichment.text.as_ref().filter(|t| !t.is_empty()) {
                lines.push(text.clone());
            }
            if let Some(data) = enrichment.data.as_ref().filter(|d| has_keys(d)) {
                lines.extend(["```json".to_string(), js::json_stringify(data, 2), "```".into()]);
            }
            if lines.len() > 1 {
                push(&format!("ENRICHMENT via {}", enrichment.plugin), lines.join("\n"));
            }
        }
    }
    message.text = rendered.join("\n\n");
    message
}

/// `retryUserMessage`: the first prompt, then what was wrong with the reply.
pub fn retry_user_message(user_message: &str, region: &Region<'_>, issues: &[Issue]) -> String {
    format!(
        "{user_message}\n\n---\n\nYour previous response had validation errors:\n{}\n\n{}",
        issue_lines(issues).join("\n"),
        retry_instruction(region, issues)
    )
}

/// `segmentForDatum`: a `from` datum as a segment — text, a `{content,
/// type?}` record, or anything else as its JSON.
pub fn segment_for_datum(datum: &Js) -> Segment {
    if let Js::String(text) = datum {
        return Segment { classification: "TEXT".into(), content: text.to_string() };
    }
    if let Js::Object(object) = datum
        && let Some(Js::String(content)) = object.get("content")
    {
        let classification = match object.get("type") {
            Some(Js::String(type_)) => type_.to_string(),
            _ => "TEXT".into(),
        };
        return Segment { classification, content: content.to_string() };
    }
    // `safeStringify`: `JSON.stringify`, else (a value holding itself) its text.
    Segment { classification: "FRAGMENT".into(), content: js::json_stringify(datum, 0) }
}

/// `transformResultSegments`: a bundle-level plugin's text and data, each a
/// fragment of the source.
pub fn plugin_segments(text: Option<&str>, data: Option<&Js>) -> Vec<Segment> {
    let mut segments = Vec::new();
    if let Some(text) = text.filter(|t| !t.is_empty()) {
        segments.push(Segment { classification: "FRAGMENT".into(), content: text.to_string() });
    }
    if let Some(data) = data.filter(|d| has_keys(d)) {
        segments.push(Segment { classification: "FRAGMENT".into(), content: js::json_stringify(data, 0) });
    }
    segments
}

/// `Object.keys(value).length > 0`.
fn has_keys(value: &Js) -> bool {
    match value {
        Js::Object(object) => !object.entries().is_empty(),
        Js::Array(list) => !list.items().is_empty(),
        Js::String(s) => !s.is_empty(),
        _ => false,
    }
}
