//! What one region's call says to the model, byte for byte as extraction.ts
//! says it: the system prompt (`buildSystemPrompt`: the entity guide, the
//! task, the rules), the user message (`renderUserMessage`: the source
//! segments, then for a per-entity call the entity so far and what its
//! stage's plugins brought back), and the retry's (`retryUserMessage`).

use std::rc::Rc;

use movement_parser::catalog::types::{Composite, FieldType, Scalar};

use crate::bindings::Binding;
use crate::eval::EvalError;
use crate::extract::spec::Region;
use crate::extract::validate::{Issue, issue_lines, retry_instruction};
use crate::js::{self, Js, JsObject};
use crate::record;
use crate::run::Failure;

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
/// type?}` map, or anything else as the JSON of its value (`fieldsValueOf`):
/// a record, at any depth, as its fields, never its binding object. A file
/// that is the datum itself keeps its printable members (no reader in the
/// path); one inside it refuses.
pub fn segment_for_datum(datum: &Js) -> Result<Segment, UnwritableDatum> {
    if let Js::String(text) = datum {
        return Ok(Segment { classification: "TEXT".into(), content: text.clone() });
    }
    if let Js::Object(object) = datum
        && let Some(Js::String(content)) = object.get("content")
    {
        let classification = match object.get("type") {
            Some(Js::String(type_)) => type_.clone(),
            _ => "TEXT".into(),
        };
        return Ok(Segment { classification, content: content.clone() });
    }
    let value = if matches!(datum, Js::File(_)) { datum.clone() } else { fields_value_of(datum, &mut Vec::new())? };
    // `safeStringify`: `JSON.stringify`, else (a value holding itself) its text.
    Ok(Segment { classification: "FRAGMENT".into(), content: js::json_stringify(&value, 0) })
}

/// A `from` datum the prompt cannot carry: `fieldsValueOf`'s refusals.
#[derive(Debug, Clone, PartialEq)]
pub enum UnwritableDatum {
    /// A file anywhere inside it.
    FileInside,
    /// A list, map or record on its own path (defensive, as the
    /// TypeScript's is: a value is built bottom-up).
    ContainsItself,
    /// A record whose fields are not in hand (`recordFields`' refusal: a
    /// system's record, the event, a walk not yet run).
    Record(EvalError),
}

impl UnwritableDatum {
    /// The message the run fails with, as extraction.ts raises it.
    pub fn message(&self) -> String {
        let (construct, detail) = match self {
            UnwritableDatum::FileInside => (
                "a file inside an extraction input",
                "hand the file over as an input of its own, or put its text in its place with READ(f) (the checker should have caught this)",
            ),
            UnwritableDatum::ContainsItself => ("an extraction input that contains itself", ""),
            UnwritableDatum::Record(EvalError::Thrown { message, .. }) => return message.clone(),
            UnwritableDatum::Record(other) => return format!("{other:?}"),
        };
        crate::run::unsupported_message(construct, detail)
    }

    /// The run's failure.
    pub(crate) fn failure(self) -> Failure {
        match self {
            UnwritableDatum::Record(error) => Failure::of_eval(error, ""),
            other => Failure::engine("MOVENG_UNSUPPORTED", other.message()),
        }
    }
}

/// `fieldsValueOf`: a value as an extraction's prompt reads it — a record,
/// at any depth, as its fields (`recordFields`), a block's records and a
/// receipt's slots as lists, a value binding as its value; lists and plain
/// maps walked; anything else as it is.
fn fields_value_of(value: &Js, path: &mut Vec<*const ()>) -> Result<Js, UnwritableDatum> {
    let address: *const () = match value {
        Js::File(_) => return Err(UnwritableDatum::FileInside),
        Js::Array(list) => Rc::as_ptr(list).cast(),
        Js::Object(object) => Rc::as_ptr(object).cast(),
        Js::Record(record) => Rc::as_ptr(record).cast(),
        other => return Ok(other.clone()),
    };
    if path.contains(&address) {
        return Err(UnwritableDatum::ContainsItself);
    }
    path.push(address);
    let walked = match value {
        Js::Record(record) => match record.as_ref() {
            Binding::Positions(landings) => list_of(landings.iter().map(|landing| record::held(landing.clone())), path),
            Binding::Tuple(slots) => list_of(slots.iter().map(|slot| record::held(slot.clone())), path),
            Binding::Value(held) => fields_value_of(&held.value, path),
            other => match record::fields_of(other) {
                Ok(fields) => fields_value_of(&Js::object(fields), path),
                Err(error) => Err(UnwritableDatum::Record(error)),
            },
        },
        Js::Array(list) => {
            let items = list.items().clone();
            list_of(items.into_iter(), path)
        }
        Js::Object(object) if object.proto.is_none() => {
            let mut walked = JsObject::new();
            let mut failed = None;
            for (key, member) in object.entries() {
                match fields_value_of(member, path) {
                    Ok(member) => walked.set(key.clone(), member),
                    Err(error) => {
                        failed = Some(error);
                        break;
                    }
                }
            }
            failed.map_or_else(|| Ok(Js::object(walked)), Err)
        }
        other => Ok(other.clone()),
    };
    path.pop();
    walked
}

fn list_of(members: impl Iterator<Item = Js>, path: &mut Vec<*const ()>) -> Result<Js, UnwritableDatum> {
    let mut walked = Vec::new();
    for member in members {
        walked.push(fields_value_of(&member, path)?);
    }
    Ok(Js::array(walked))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A value that holds itself has no finite text: the datum refuses as
    /// `fieldsValueOf` does, never written as `null`. Defensive, as the
    /// TypeScript's is: no program is known to build one.
    #[test]
    fn a_datum_that_holds_itself_refuses() {
        let ring = Js::array(vec![Js::str("a")]);
        let Js::Array(list) = &ring else { unreachable!("an array") };
        list.push(ring.clone());
        assert_eq!(segment_for_datum(&ring), Err(UnwritableDatum::ContainsItself));
        assert_eq!(
            UnwritableDatum::ContainsItself.message(),
            "an extraction input that contains itself is not supported by the movement engine yet"
        );
    }

    /// One object held twice is no cycle: only a value on its own path is.
    #[test]
    fn an_object_held_twice_writes() {
        let shared = Js::array(vec![Js::Number(1.0)]);
        let datum = Js::array(vec![shared.clone(), Js::array(vec![shared])]);
        assert_eq!(segment_for_datum(&datum).map(|s| s.content), Ok("[[1],[[1]]]".to_string()));
    }

    /// A file inside a datum refuses; a file that is the datum writes its
    /// printable members.
    #[test]
    fn a_file_inside_a_datum_refuses() {
        let file = crate::file::for_test(0, Some("h"), Some("deck.pdf"));
        assert_eq!(segment_for_datum(&Js::array(vec![file.clone()])), Err(UnwritableDatum::FileInside));
        assert!(segment_for_datum(&file).is_ok());
    }
}
