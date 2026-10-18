//! The movement language service (docs/contracts/language-service.md): what
//! a position in a movement file answers, from one check of it by the Rust
//! checker. Written for language version 5; `lf lsp` serves it.

mod builtins;
mod complete;
mod hover;
pub mod recover;
pub mod text;
mod walk;

pub use complete::{Item, ItemKind};
pub use hover::Hover;
pub use text::{Pos, Range};

use movement_checker::query::{Analysis, analyze};
use movement_checker::{CheckOptions, Severity};
use movement_parser::ast::Span;
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::util::form::external_text;

use crate::text::{Text, loc_of, range_of};

/// The online docs for language version 5. A placeholder until the docs
/// site is published (CONCERNS.md).
pub const DOCS_BASE: &str = "https://listen-fire.github.io/docs/v5";

pub fn docs_url(page: &str, anchor: &str) -> String {
    format!("{DOCS_BASE}/{page}#{anchor}")
}

/// The code a file that does not parse is reported under.
pub const PARSE_CODE: &str = "MOV_PARSE";

/// A project's catalog and language version: what every answer is checked against.
pub struct Service {
    pub catalog: CatalogSnapshot,
    pub language_version: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagSeverity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextEdit {
    pub range: Range,
    pub new_text: String,
}

#[derive(Debug, Clone)]
pub struct Diag {
    pub range: Range,
    pub severity: DiagSeverity,
    pub code: String,
    pub message: String,
    /// The checker's own fix, when it offers one.
    pub fix: Option<Vec<TextEdit>>,
}

/// Where a name is declared: in this file (`file: None`) or a library, by
/// the catalog's key for it (its path under the movements folder).
#[derive(Debug, Clone, PartialEq)]
pub struct Location {
    pub file: Option<String>,
    pub range: Range,
}

#[derive(Debug, Clone)]
pub struct Action {
    pub title: String,
    pub edits: Vec<TextEdit>,
    /// The diagnostic it resolves.
    pub code: String,
    pub preferred: bool,
}

/// One check of a file.
pub(crate) struct Analyzed {
    pub analysis: Analysis,
}

impl Service {
    pub fn new(catalog: CatalogSnapshot, language_version: u32) -> Self {
        Service { catalog, language_version }
    }

    fn options(&self) -> CheckOptions<'static> {
        CheckOptions { language_version: self.language_version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones }
    }

    /// The file checked, repaired around `cursor` (a 0-based line) when it
    /// does not parse as written.
    pub(crate) fn analyze(&self, source: &str, cursor: Option<u32>) -> Option<Analyzed> {
        let parsed = recover::parse_recovering(source, self.language_version, cursor)?;
        let analysis = analyze(&parsed.program, &self.catalog, self.options());
        Some(Analyzed { analysis })
    }

    /// Every diagnostic the file has: its parse refusal alone when it does
    /// not parse, else the checker's.
    pub fn diagnostics(&self, source: &str) -> Vec<Diag> {
        let program = match recover::parse(source, self.language_version) {
            Ok(program) => program,
            Err(refused) => {
                let at = text::pos_of(refused.loc);
                let end = Pos { line: at.line, character: at.character + 1 };
                return vec![Diag {
                    range: Range { start: at, end },
                    severity: DiagSeverity::Error,
                    code: PARSE_CODE.into(),
                    message: external_text(&refused.message).into_owned(),
                    fix: None,
                }];
            }
        };
        analyze(&program, &self.catalog, self.options()).diagnostics.into_iter().map(|d| diag_of(&d)).collect()
    }

    pub fn complete(&self, source: &str, pos: Pos) -> Vec<Item> {
        complete::complete(self, source, pos)
    }

    pub fn hover(&self, source: &str, pos: Pos) -> Option<Hover> {
        hover::hover(self, source, pos)
    }

    /// Where the name at `pos` is declared.
    pub fn definition(&self, source: &str, pos: Pos) -> Option<Location> {
        let text = Text::new(source);
        // The path of a file import names the library.
        let line = text.line(pos.line);
        if line.trim_start().starts_with("import") && text::inside_quotes(text.line_before(pos)) {
            let before = text.line_before(pos);
            let open = before.rfind('"')?;
            let rest = &line[open + 1..];
            let path = &rest[..rest.find('"')?];
            return Some(Location { file: Some(path.to_string()), range: Range { start: Pos { line: 0, character: 0 }, end: Pos { line: 0, character: 0 } } });
        }
        let word = hover::word_at(&text, pos)?;
        if word.after_dot {
            return None;
        }
        let analyzed = self.analyze(source, Some(pos.line))?;
        let analysis = &analyzed.analysis;
        if let Some(imported) = analysis.imported(&word.name) {
            return Some(Location { file: Some(imported.file.clone()), range: range_of(&imported.span) });
        }
        let id = analysis.resolve(loc_of(pos), &word.name)?;
        let symbol = analysis.symbol(id);
        if symbol.unit {
            return None;
        }
        Some(Location { file: None, range: name_range(&text, &symbol.span, &symbol.name) })
    }

    /// The quick fixes for the diagnostics touching `range`: each one's own
    /// fix, and a "did you mean" made a rewrite.
    pub fn code_actions(&self, source: &str, range: Range) -> Vec<Action> {
        let text = Text::new(source);
        let mut actions = Vec::new();
        for d in self.diagnostics(source) {
            if d.range.end < range.start || range.end < d.range.start {
                continue;
            }
            if let Some(edits) = &d.fix {
                let title = match edits.as_slice() {
                    [one] if !one.new_text.contains('\n') && one.new_text.len() <= 60 => format!("Rewrite as `{}`", one.new_text),
                    _ => format!("Apply the fix for {}", d.code),
                };
                actions.push(Action { title, edits: edits.clone(), code: d.code.clone(), preferred: true });
            }
            if let Some(action) = did_you_mean(&text, &d) {
                actions.push(action);
            }
        }
        actions
    }
}

fn diag_of(d: &movement_checker::Diagnostic) -> Diag {
    Diag {
        range: range_of(&d.span),
        severity: match d.severity {
            None => DiagSeverity::Error,
            Some(Severity::Warning) => DiagSeverity::Warning,
            Some(Severity::Info) => DiagSeverity::Info,
        },
        code: d.code.clone(),
        message: external_text(&d.message).into_owned(),
        fix: d.fix.as_ref().and_then(fix_edits),
    }
}

/// A `DiagnosticFix`'s edits.
fn fix_edits(fix: &serde_json::Value) -> Option<Vec<TextEdit>> {
    let edits = fix.get("edits")?.as_array()?;
    edits
        .iter()
        .map(|edit| {
            let span: Span = span_of_json(edit.get("span")?)?;
            Some(TextEdit { range: range_of(&span), new_text: external_text(edit.get("text")?.as_str()?).into_owned() })
        })
        .collect()
}

fn span_of_json(value: &serde_json::Value) -> Option<Span> {
    let loc = |v: &serde_json::Value| -> Option<movement_parser::ast::Loc> {
        Some(movement_parser::ast::Loc { line: v.get("line")?.as_u64()? as usize, col: v.get("col")?.as_u64()? as usize })
    };
    Some(Span { start: loc(value.get("start")?)?, end: loc(value.get("end")?)? })
}

/// The range of `name` inside a declaration's span (its first occurrence
/// there), or the span's start.
fn name_range(text: &Text<'_>, span: &Span, name: &str) -> Range {
    let start = text::pos_of(span.start);
    let line = text.line(start.line);
    let from = text.byte_in_line(start.line, start.character);
    if let Some(found) = line.get(from..).and_then(|rest| find_word(rest, name)) {
        let character = start.character + text::utf16_len(&line[from..from + found]) as u32;
        return Range { start: Pos { line: start.line, character }, end: Pos { line: start.line, character: character + text::utf16_len(name) as u32 } };
    }
    Range { start, end: start }
}

/// The byte offset of `word` in `text` as a whole word.
fn find_word(text: &str, word: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(found) = text[from..].find(word) {
        let at = from + found;
        let before = text[..at].chars().next_back().is_none_or(|c| !text::is_word_char(c));
        let after = text[at + word.len()..].chars().next().is_none_or(|c| !text::is_word_char(c));
        if before && after {
            return Some(at);
        }
        from = at + word.len().max(1);
    }
    None
}

/// "… 'Txt' … did you mean 'Text'?": the quoted name inside the diagnostic's
/// text rewritten to the suggestion.
fn did_you_mean(text: &Text<'_>, d: &Diag) -> Option<Action> {
    let lower = d.message.to_lowercase();
    let at = lower.find("did you mean ")? + "did you mean ".len();
    let rest = &d.message[at..];
    let rest = rest.strip_prefix("the field ").unwrap_or(rest);
    let quote = rest.chars().next().filter(|c| *c == '\'' || *c == '`')?;
    let suggestion = &rest[1..1 + rest[1..].find(quote)?];
    let span = Span { start: loc_of(d.range.start), end: loc_of(d.range.end) };
    let covered = text.slice(&span);
    // The misspelled name: the first one quoted before the suggestion that the span holds.
    let head = &d.message[..at];
    let wrong = head.split(['\'', '`']).skip(1).step_by(2).find(|w| !w.is_empty() && find_word(&covered, w).is_some())?;
    let offset = find_word(&covered, wrong)?;
    let start = advance(d.range.start, &covered[..offset]);
    let end = advance(start, wrong);
    Some(Action {
        title: format!("Change '{wrong}' to '{suggestion}'"),
        edits: vec![TextEdit { range: Range { start, end }, new_text: suggestion.to_string() }],
        code: d.code.clone(),
        preferred: d.fix.is_none(),
    })
}

/// `pos` moved past `text`.
fn advance(pos: Pos, text: &str) -> Pos {
    match text.rfind('\n') {
        Some(newline) => Pos { line: pos.line + text.matches('\n').count() as u32, character: text::utf16_len(&text[newline + 1..]) as u32 },
        None => Pos { line: pos.line, character: pos.character + text::utf16_len(text) as u32 },
    }
}
