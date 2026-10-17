//! The content an extraction call reads, as resources (Layer 5
//! provenance): a content file's text read once (`files.resolveFileText`,
//! bounded for the prompt).

use crate::host;
use crate::js::{self, Js};
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
    let length = js::len_chars(text);
    if length as f64 <= ceiling {
        return (text.to_string(), length as f64, None);
    }
    let head = crate::js_string::first_chars(text, ceiling.trunc() as usize);
    let marker = js::number_to_string(ceiling);
    (format!("{head}\n[… truncated: first {marker} of {length} characters]"), ceiling, Some(length))
}

impl Run<'_> {
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
            && !matches!(&unreadable, Js::String(why) if matches!(why.as_str(), "unsupported_type" | "bytes_unavailable" | "extraction_failed" | "no_text"))
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
        assert_eq!(env::encode_plain(&file), json!(["F", 3]));
    }
}
