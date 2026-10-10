//! The content an extraction reads, as resources (extraction.ts
//! `resolveFromData`, `fileSegment`, `pluginFileResources`; Layer 5
//! provenance): each `from […]` datum a prompt segment, a text datum a TEXT
//! resource, a source file a FILE resource (its text, when one can be read,
//! a segment of its own); each file a plugin fetched a FILE resource of the
//! record it ran for. A resource with no id is given one by the host
//! (`ids.mint`), one request per batch.

use movement_parser::ast::ExprSlot;
use serde_json::{Value as Json, json};

use crate::env;
use crate::extract::prompt::{self, Segment};
use crate::host;
use crate::js::{self, Js, JsObject};
use crate::run::{Failure, Run, Stop};
use crate::trace::TraceEntry;
use crate::unique::get as member;

use super::run::{Materializer, PluginResult, thrown};

/// What a run warns of, once per file, when a file that was there could
/// not be fetched (run.ts `FILE_BYTES_UNAVAILABLE`).
const FILE_BYTES_UNAVAILABLE: &str = "MOVENG_FILE_BYTES_UNAVAILABLE";

/// What the `from […]` slots resolved to.
pub(crate) struct FromData {
    pub(crate) segments: Vec<Segment>,
    /// The slots' own origins, then each readable file's, once each.
    pub(crate) sources: Vec<u32>,
    pub(crate) resources: Vec<Js>,
    /// Every source file as the trace tells it.
    pub(crate) files: Vec<Js>,
}

/// One source file's contribution (`FileResolution`).
#[derive(Clone)]
pub(crate) struct FileResolution {
    resource: Js,
    /// The segment its text makes and the `file` origin citing it.
    text: Option<(Segment, u32)>,
    traced: Js,
}

/// `isFileRef`: a branded descriptor.
pub(crate) fn is_file_ref(value: &Js) -> bool {
    matches!(value, Js::Object(object) if matches!(object.get("__brand"), Some(Js::String(brand)) if brand == "FileRef"))
}

/// `fileHandle`: the owner's handle, or the store key.
pub(crate) fn file_handle(file: &Js) -> Option<String> {
    let source = member(file, "source");
    let Js::Object(source) = source else { return None };
    let key = if source.get("store").is_some() { source.get("objectUri") } else { source.get("handle") };
    match key {
        Some(Js::String(text)) => Some(text.clone()),
        _ => None,
    }
}


/// `{...(x !== undefined ? { key: x } : {})}`.
fn present(entries: &mut Vec<(&'static str, Js)>, key: &'static str, value: Js) {
    if !matches!(value, Js::Undefined) {
        entries.push((key, value));
    }
}

/// `fileResourceForRef`: the source file as a FILE resource carrying the
/// very descriptor, its whole text (when it has one) inline.
fn file_resource(file: &Js, read: Option<(&str, &Js)>) -> Js {
    let mut entries = Vec::new();
    if let Some(handle) = file_handle(file) {
        entries.push(("externalId", Js::str(handle)));
    }
    entries.push(("type", Js::str("FILE")));
    present(&mut entries, "name", member(file, "name"));
    entries.push(("url", Js::Null));
    entries.push(("fileRef", file.clone()));
    present(&mut entries, "contentType", member(file, "contentType"));
    if let Some((text, _)) = read
        && !js::trim(text).is_empty()
    {
        entries.push(("content", Js::str(text)));
    }
    let mut data = vec![("file", file.clone())];
    present(&mut data, "name", member(file, "name"));
    data.push(("type", Js::str("FILE")));
    present(&mut data, "contentType", member(file, "contentType"));
    entries.push(("data", env::object_of(data)));
    if let Some((_, raw_text_id)) = read
        && !matches!(raw_text_id, Js::Undefined)
    {
        entries.push(("metadata", env::object_of(vec![("rawTextId", raw_text_id.clone())])));
    }
    env::object_of(entries)
}

/// `textResourceForDatum`: a datum with text as a TEXT resource.
fn text_resource(datum: &Js) -> Option<Js> {
    let segment = prompt::segment_for_datum(datum);
    if js::trim(&segment.content).is_empty() {
        return None;
    }
    Some(env::object_of(vec![
        ("type", Js::str("TEXT")),
        ("content", Js::str(segment.content.clone())),
        ("data", env::object_of(vec![("content", Js::str(segment.content)), ("type", Js::str("TEXT"))])),
    ]))
}

/// `pluginFileResources`: one FILE resource per record a plugin fetched
/// that carries a file, shaped as a source file's is, with the link it was
/// fetched from. Version 1's `_resources` held the `from […]` sources alone.
pub(crate) fn plugin_file_resources(result: &PluginResult, language_version: u32) -> Vec<Js> {
    if language_version < 2 {
        return Vec::new();
    }
    let mut resources = Vec::new();
    for record in &result.records {
        let file = member(record, "file");
        if !is_file_ref(&file) {
            continue;
        }
        let name = match member(record, "name") {
            Js::String(name) => Js::String(name),
            _ => member(&file, "name"),
        };
        let url = match member(record, "url") {
            Js::String(url) => Js::String(url),
            _ => Js::Null,
        };
        let mut entries = Vec::new();
        if let Some(handle) = file_handle(&file) {
            entries.push(("externalId", Js::str(handle)));
        }
        entries.push(("type", Js::str("FILE")));
        present(&mut entries, "name", name.clone());
        entries.push(("url", url.clone()));
        entries.push(("fileRef", file.clone()));
        present(&mut entries, "contentType", member(&file, "contentType"));
        let mut data = vec![("file", file.clone())];
        present(&mut data, "name", name);
        if !matches!(url, Js::Null) {
            data.push(("url", url));
        }
        data.push(("type", Js::str("FILE")));
        present(&mut data, "contentType", member(&file, "contentType"));
        entries.push(("data", env::object_of(data)));
        resources.push(env::object_of(entries));
    }
    resources
}

/// The file's text bounded for the prompt (`boundFileText`): past the
/// ceiling a prefix, the model told it was handed one. The ceiling is the
/// deployment's number as written, a fraction included: the text is cut
/// where `slice` truncates it, and the marker and the count print the number
/// itself (`first 2.5 of …`), as the TypeScript's template prints it.
pub fn bound_text(text: &str, ceiling: f64) -> (String, f64, Option<usize>) {
    let length = js::utf16_len(text);
    if length as f64 <= ceiling {
        return (text.to_string(), length as f64, None);
    }
    let head: String = utf16_prefix(text, ceiling.trunc() as usize);
    let marker = js::number_to_string(ceiling);
    (format!("{head}\n[… truncated: first {marker} of {length} characters]"), ceiling, Some(length))
}

/// `text.slice(0, units)`, in UTF-16 units.
fn utf16_prefix(text: &str, units: usize) -> String {
    let mut taken = 0;
    text.chars()
        .take_while(|c| {
            taken += c.len_utf16();
            taken <= units
        })
        .collect()
}

impl Run<'_> {
    /// `count` fresh ids from the host, refused unless they are `count`
    /// distinct texts (run_context.ts `mintedFrom`).
    pub(crate) async fn mint_ids(&self, count: usize) -> Result<Vec<String>, Failure> {
        if count == 0 {
            return Ok(Vec::new());
        }
        let answer = self.ask(host::ids::mint(self.segment(), count)).await?;
        let ids: Option<Vec<String>> = answer
            .as_ref()
            .and_then(Json::as_array)
            .filter(|ids| ids.len() == count)
            .and_then(|ids| ids.iter().map(|id| id.as_str().filter(|id| !id.is_empty()).map(String::from)).collect());
        let distinct = ids.as_ref().is_some_and(|ids| ids.iter().enumerate().all(|(i, id)| !ids[..i].contains(id)));
        match ids {
            Some(ids) if distinct => Ok(ids),
            _ => {
                let shown = answer.map_or_else(|| "undefined".to_string(), |a| a.to_string());
                Err(Failure::Engine {
                    class: crate::eval::ErrorClass::Error,
                    message: format!("ids.mint was asked for {count} ids and answered {shown}, which is not {count} distinct strings"),
                })
            }
        }
    }

    /// `stampResourceIds`: every resource without an id given one, all in
    /// one request; one that has its id passes through.
    pub(crate) async fn stamp_resources(&self, resources: Vec<Js>) -> Result<Vec<Js>, Failure> {
        let unstamped = resources.iter().filter(|r| !member(r, "id").truthy()).count();
        if unstamped == 0 {
            return Ok(resources);
        }
        let mut ids = self.mint_ids(unstamped).await?.into_iter();
        Ok(resources
            .into_iter()
            .map(|resource| {
                if member(&resource, "id").truthy() {
                    return resource;
                }
                let Js::Object(object) = &resource else { return resource };
                let mut stamped = JsObject::clone_of(object);
                stamped.set("id".into(), Js::str(ids.next().expect("one id per unstamped resource")));
                Js::object(stamped)
            })
            .collect())
    }

    /// The run's file→text seam (run.ts `fileTextResolver`): the host's
    /// reading, priced, and a file that was there but whose bytes could not
    /// be fetched warned of on the run, once per file.
    pub(crate) async fn resolve_file_text(&self, file: &Js) -> Result<Js, Failure> {
        let request = host::files::resolve_file_text(self.segment(), self.encode(file)?, self.ledger.budget());
        let answer = self.priced(request).await?;
        super::run::refuse_uncarried(&answer, "a file's text")?;
        if matches!(member(&answer, "unreadable"), Js::String(why) if why == "bytes_unavailable") {
            let key = file_handle(file).or_else(|| match member(file, "name") {
                Js::String(name) => Some(name),
                _ => None,
            });
            let key = key.unwrap_or_default();
            if !self.unfetched_files.borrow().contains(&key) {
                self.unfetched_files.borrow_mut().push(key);
                let name = match member(file, "name") {
                    Js::String(name) => format!("'{name}'"),
                    Js::Undefined => "a file".to_string(),
                    other => format!("'{}'", other.to_js_string()),
                };
                let detail = match member(&answer, "detail") {
                    Js::Undefined => String::new(),
                    detail => format!(": {}", detail.to_js_string()),
                };
                self.trace(TraceEntry::Warning {
                    code: FILE_BYTES_UNAVAILABLE.into(),
                    message: format!("The run could not fetch {name}{detail}. Whatever read it went on without its contents."),
                });
            }
        }
        Ok(answer)
    }
}

impl Materializer<'_, '_> {
    /// `resolveFromData`: each slot evaluated in the firing scope, its
    /// origins the extraction's data sources; each datum a segment, a text
    /// one a TEXT resource, a file a FILE resource (and, read, a segment);
    /// the resources without ids given theirs in one request.
    pub(crate) async fn resolve_from_data(&self, slots: &[ExprSlot]) -> Result<FromData, Stop> {
        let mut segments = Vec::new();
        let mut sources: Vec<u32> = Vec::new();
        let mut resources = Vec::new();
        let mut files = Vec::new();
        let mut seen_resource_ids: Vec<String> = Vec::new();
        for slot in slots {
            let evaluated = self.run.evaluate_slot(slot, self.scope).await?;
            let trail = self.run.trail_of(&evaluated.prov, self.scope).unwrap_or_default();
            for origin in trail.origins {
                if !sources.contains(&origin) {
                    sources.push(origin);
                }
            }
            let flat = match &evaluated.value {
                Js::Undefined | Js::Null => Vec::new(),
                Js::Array(list) => list.items().clone(),
                other => vec![other.clone()],
            };
            for datum in flat {
                if datum.is_nullish() {
                    continue;
                }
                if is_file_ref(&datum) {
                    let file = self.file_segment(&datum).await?;
                    if let Js::String(id) = member(&file.resource, "id")
                        && !seen_resource_ids.contains(&id)
                    {
                        seen_resource_ids.push(id);
                        resources.push(file.resource.clone());
                        files.push(file.traced.clone());
                    }
                    if let Some((segment, origin)) = file.text
                        && !sources.contains(&origin)
                    {
                        segments.push(segment);
                        sources.push(origin);
                    }
                    continue;
                }
                segments.push(prompt::segment_for_datum(&datum));
                if let Some(resource) = text_resource(&datum) {
                    resources.push(resource);
                }
            }
        }
        let resources = self.run.stamp_resources(resources).await.map_err(thrown)?;
        Ok(FromData { segments, sources, resources, files })
    }

    /// `fileSegment`: a source file's FILE resource (always, stamped), and,
    /// when it yields text, its segment and `file` origin — once per file
    /// (by its handle, else its name).
    async fn file_segment(&self, file: &Js) -> Result<FileResolution, Stop> {
        let handle = file_handle(file);
        let name = match member(file, "name") {
            Js::String(name) => Some(name),
            _ => None,
        };
        let key = handle.clone().or(name);
        if let Some(key) = &key
            && let Some((_, cached)) = self.file_memo.borrow().iter().find(|(k, _)| k == key)
        {
            return Ok(cached.clone());
        }
        let result = self.run.resolve_file_text(file).await.map_err(thrown)?;
        let unreadable = member(&result, "unreadable");
        let readable = matches!(unreadable, Js::Undefined);
        let text = match member(&result, "text") {
            Js::String(text) if readable => Some(text),
            _ => None,
        };
        let raw_text_id = member(&result, "rawTextId");
        let ceiling = self.run.input.extraction_file_chars;
        let bounded = text.as_deref().filter(|t| !js::trim(t).is_empty()).map(|t| bound_text(t, ceiling));
        if let Some((_, _, Some(of))) = &bounded {
            let mut fields = serde_json::Map::new();
            if let Js::String(name) = member(file, "name") {
                fields.insert("name".into(), json!(name));
            }
            fields.insert("chars".into(), env::json_of_js(&Js::Number(ceiling)));
            fields.insert("of".into(), json!(of));
            self.run.log("warn", "[movement:extract] truncating a source file for the prompt", fields);
        }
        let segment = match (&text, &bounded) {
            (Some(_), Some((content, _, _))) => {
                let mut origin = vec![("kind", Js::str("file"))];
                present(&mut origin, "rawTextId", raw_text_id.clone());
                if let Some(handle) = &handle {
                    origin.push(("handle", Js::str(handle.clone())));
                }
                present(&mut origin, "name", member(file, "name"));
                present(&mut origin, "contentType", member(file, "contentType"));
                let id = self.run.mint_origin(env::object_of(origin));
                Some((Segment { classification: "FILE".into(), content: content.clone() }, id))
            }
            _ => None,
        };
        let mut traced = Vec::new();
        present(&mut traced, "name", member(file, "name"));
        present(&mut traced, "contentType", member(file, "contentType"));
        if !readable {
            traced.push(("unreadable", unreadable.clone()));
            present(&mut traced, "detail", member(&result, "detail"));
        } else if let Some((_, chars, truncated_from)) = &bounded {
            traced.push(("chars", Js::Number(*chars)));
            if let Some(from) = truncated_from {
                traced.push(("truncatedFrom", Js::Number(*from as f64)));
            }
        } else {
            traced.push(("unreadable", Js::str("no_text")));
        }
        let traced = env::object_of(traced);
        let read = text.as_deref().map(|t| (t, &raw_text_id));
        let resource = self.run.stamp_resources(vec![file_resource(file, read)]).await.map_err(thrown)?.remove(0);
        let resolution = FileResolution { resource, text: segment, traced };
        if let Some(key) = key {
            self.file_memo.borrow_mut().push((key, resolution.clone()));
        }
        Ok(resolution)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_file_is_bounded_and_says_so() {
        assert_eq!(bound_text("abc", 5.0), ("abc".to_string(), 3.0, None));
        let (content, chars, from) = bound_text("abcdef", 4.0);
        assert_eq!((content.as_str(), chars, from), ("abcd\n[… truncated: first 4 of 6 characters]", 4.0, Some(6)));
        let (content, chars, from) = bound_text("abcdef", 2.5);
        assert_eq!((content.as_str(), chars, from), ("ab\n[… truncated: first 2.5 of 6 characters]", 2.5, Some(6)));
    }

    #[test]
    fn a_file_is_known_by_its_brand_and_its_handle() {
        let file = env::js_of_json(&json!({ "__brand": "FileRef", "name": "a.pdf", "source": { "store": "document", "objectUri": "s3://x" } }));
        assert!(is_file_ref(&file));
        assert_eq!(file_handle(&file).as_deref(), Some("s3://x"));
        assert!(!is_file_ref(&env::js_of_json(&json!({ "name": "a.pdf" }))));
    }
}
