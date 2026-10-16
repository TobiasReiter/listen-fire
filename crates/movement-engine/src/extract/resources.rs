//! The content an extraction call reads, as resources (Layer 5
//! provenance): a content file's text read once (`files.resolveFileText`,
//! bounded for the prompt), and a resource with no id given one by the host
//! (`ids.mint`), one request per batch.

use serde_json::Value as Json;

use crate::host;
use crate::js::{self, Js, JsObject};
use crate::run::{Failure, Run};
use crate::trace::TraceEntry;
use crate::unique::get as member;


/// What a run warns of, once per file, when a file that was there could
/// not be fetched (run.ts `FILE_BYTES_UNAVAILABLE`).
const FILE_BYTES_UNAVAILABLE: &str = "MOVENG_FILE_BYTES_UNAVAILABLE";

/// `isFileValue`: a file the engine holds (`Js::File`), never a dict that
/// spells a descriptor.
pub(crate) fn is_file_ref(value: &Js) -> bool {
    matches!(value, Js::File(_))
}

/// `fileHandle`: the file's identity, as the host handed it — opaque,
/// compared and carried, never read inside.
pub(crate) fn file_handle(file: &Js) -> Option<String> {
    match file {
        Js::File(file) => file.handle.clone(),
        _ => None,
    }
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
    // `slice`: a cut through a pair keeps its high half.
    let head = crate::js_string::slice_units(text, 0, ceiling.trunc() as usize);
    let marker = js::number_to_string(ceiling);
    (format!("{head}\n[… truncated: first {marker} of {length} characters]"), ceiling, Some(length))
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
        // A reason the host names outside the four a file is unreadable for
        // reaches the trace, whose entry this engine holds to them: named
        // here rather than left to the shim's check of the trace.
        let unreadable = member(&answer, "unreadable");
        if !matches!(unreadable, Js::Undefined)
            && !matches!(&unreadable, Js::String(why) if matches!(why.as_form(), "unsupported_type" | "bytes_unavailable" | "extraction_failed" | "no_text"))
        {
            return Err(Failure::unreproduced(
                &format!("a file the host calls unreadable for {}", crate::js::json_stringify(&unreadable, 0)),
                "a file is unreadable as unsupported_type, bytes_unavailable, extraction_failed or no_text",
            ));
        }
        if matches!(member(&answer, "unreadable"), Js::String(why) if why == "bytes_unavailable") {
            let key = file_handle(file).or_else(|| match member(file, "name") {
                Js::String(name) => Some(name.into_string()),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env;
    use serde_json::json;

    #[test]
    fn a_long_file_is_bounded_and_says_so() {
        assert_eq!(bound_text("abc", 5.0), ("abc".to_string(), 3.0, None));
        let (content, chars, from) = bound_text("abcdef", 4.0);
        assert_eq!((content.as_str(), chars, from), ("abcd\n[… truncated: first 4 of 6 characters]", 4.0, Some(6)));
        let (content, chars, from) = bound_text("abcdef", 2.5);
        assert_eq!((content.as_str(), chars, from), ("ab\n[… truncated: first 2.5 of 6 characters]", 2.5, Some(6)));
    }

    #[test]
    fn a_file_is_one_the_engine_made_never_a_dict_with_its_keys() {
        let spelled = env::js_of_json(&json!({ "__brand": "FileRef", "name": "a.pdf", "source": { "store": "document", "objectUri": "s3://x" } }));
        assert!(!is_file_ref(&spelled));
        assert_eq!(file_handle(&spelled), None);
        // What the host hands: an id, the opaque handle, the printable parts.
        let file = env::decode(&json!(["F", 3, { "handle": "h-9", "name": "a.pdf" }])).expect("a file");
        assert!(is_file_ref(&file));
        assert_eq!(file_handle(&file).as_deref(), Some("h-9"));
        assert!(matches!(member(&file, "name"), Js::String(name) if name == "a.pdf"));
        assert!(matches!(member(&file, "source"), Js::Undefined));
        assert_eq!(env::encode(&file), json!(["F", 3]));
    }
}
