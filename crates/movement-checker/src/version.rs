//! The language version table as the checker reports it
//! (packages/movement-lang/language_version.ts), and the handbook pointers a
//! fixed set of codes append (checker/handbook_pointers.ts).

use movement_parser::ast::{Loc, Span};
use movement_parser::version::{CURRENT_LANGUAGE_VERSION, SUPPORTED_LANGUAGE_VERSIONS};

use crate::codes;
use crate::diagnostic::Diagnostic;

const NAMES: &[(u32, &str)] = &[(1, "Quiet Heron"), (2, "Bright Otter"), (3, "Steady Lynx"), (4, "Luminous Owl"), (5, "Dancing Wren")];

/// Versions this release still runs but will remove: none today.
const DEPRECATED: &[u32] = &[];

/// `"Bright Otter" (2)`, or `version 99` for a version the table lacks.
pub fn describe(version: u32) -> String {
    match NAMES.iter().find(|(v, _)| *v == version) {
        Some((v, name)) => format!("\"{name}\" ({v})"),
        None => format!("version {version}"),
    }
}

/// What a movement pinned to `version` is told before anything else.
pub fn standing_diagnostic(version: u32) -> Option<Diagnostic> {
    let at = Loc { line: 1, col: 1 };
    let span = Span { start: at, end: at };
    let current = describe(CURRENT_LANGUAGE_VERSION);
    if !SUPPORTED_LANGUAGE_VERSIONS.contains(&version) {
        return Some(Diagnostic::error(
            codes::LANGUAGE_VERSION_UNSUPPORTED,
            format!(
                "this automation is written in language version {}, which this release does not support, so it will not validate or run. To fix: validate it under {current}, repair what that reports, and upgrade it to {current}.",
                describe(version)
            ),
            span,
        ));
    }
    if DEPRECATED.contains(&version) {
        let mut warning = Diagnostic::error(
            codes::LANGUAGE_VERSION_DEPRECATED,
            format!(
                "this automation is written in language version {}, which is deprecated and will be removed in a future release. Validate it under {current}, repair what that reports, and upgrade it to {current} before then.",
                describe(version)
            ),
            span,
        );
        warning.severity = Some(crate::diagnostic::Severity::Warning);
        return Some(warning);
    }
    None
}

/// The handbook anchor a code's message ends with (`HANDBOOK_POINTER_BY_CODE`).
fn handbook_anchor(code: &str) -> Option<&'static str> {
    Some(match code {
        "MOV_ABSENT_REQUIRED" => "front#maybe-absent",
        "MOV_FUNCTION_UNKNOWN" => "front#functions-not-methods",
        "MOV_EXTRACT_CALL_NESTED" => "front#extraction",
        "MOV_MATCH_NO_IDENTITY" | "MOV_UNIQUE_UNKNOWN_FIELD" | "MOV_LINKED_HOP_RETIRED" | "MOV_PARENT_READ_RETIRED"
        | "MOV_WRITE_BIND_RETIRED" => "front#identity",
        "MOV_MATCH_UNNAMED" | "MOV_MATCH_MISS_CONTINUES" | "MOV_LINK_MATCH_BODY_RETIRED" => "writes#match",
        "MOV_HANDLE_FIELD_RETIRED" | "MOV_HANDLE_READ_FOUND" | "MOV_OLD_EDGE_NOT_A_WRITE" | "MOV_ARTIFICIAL_EDGE_UNKNOWN" => {
            "writes#what-the-write-did"
        }
        _ => return None,
    })
}

/// ` (see handbook: front#systems)`.
pub fn see_handbook(anchor: &str) -> String {
    format!(" (see handbook: {anchor})")
}

/// `withHandbookPointer`.
pub fn with_handbook_pointer(mut diagnostic: Diagnostic) -> Diagnostic {
    if let Some(anchor) = handbook_anchor(&diagnostic.code) {
        let suffix = see_handbook(anchor);
        if !diagnostic.message.ends_with(&suffix) {
            diagnostic.message.push_str(&suffix);
        }
    }
    diagnostic
}
