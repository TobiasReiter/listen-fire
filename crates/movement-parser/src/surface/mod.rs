//! The language surface of version 5 (plans/naming-rethink-2026-10-14/
//! 5_design.md): the everyday spelling outside walk brackets, read into the
//! tree versions 1–4 already parse. `table` is the spelling table,
//! `canonical` the rewrite of a v5 expression into the canonical tree.
//!
//! The version an expression is read under is AMBIENT for the length of one
//! parse, check or run (`with_version`): slot text is re-read at many places
//! in both checkers and the engine, and every one of them must read it under
//! the program's own version. Threading the version through each reader, or
//! stamping it on every slot, were the alternatives; the ambient scope makes
//! every reader agree by construction. Outside a scope the grammar is the
//! one versions 1–4 read.

pub mod canonical;
pub mod table;

#[cfg(test)]
mod tests;

use std::cell::RefCell;

use serde::{Deserialize, Serialize};

use crate::ast::{Loc, Span};
use crate::tree::At;
use crate::util::utf16::Utf16;

/// An old spelling under version 5: refused, with the exact rewrite.
pub const SPELLING_CODE: &str = "MOV_V5_SPELLING";
/// `Text.foo(…)`: a standard namespace has no such member.
pub const UNKNOWN_MEMBER_CODE: &str = "MOV_V5_UNKNOWN_MEMBER";
/// A v5 form the spelling rewrite cannot read yet (the spine's edge).
pub const NOT_YET_CODE: &str = "MOV_V5_NOT_YET";

/// A finding inside one expression text; offsets are UTF-16 into it.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub code: &'static str,
    pub message: String,
    pub at: At,
    pub edits: Option<Vec<Edit>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Edit {
    pub at: At,
    pub text: String,
}

/// A finding placed in the file: what `Program.spelling` carries and both
/// checkers report as a diagnostic, its fix in `DiagnosticFix`'s shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpellingFinding {
    pub code: String,
    pub message: String,
    pub span: Span,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fix: Option<Fix>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fix {
    pub edits: Vec<SourceEdit>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceEdit {
    pub span: Span,
    pub text: String,
}

struct Scope {
    version: u32,
    findings: Option<Vec<SpellingFinding>>,
}

thread_local! {
    static SCOPE: RefCell<Vec<Scope>> = const { RefCell::new(Vec::new()) };
}

/// Runs `f` with expressions read under `version`.
pub fn with_version<T>(version: u32, f: impl FnOnce() -> T) -> T {
    SCOPE.with(|s| s.borrow_mut().push(Scope { version, findings: None }));
    let out = f();
    SCOPE.with(|s| s.borrow_mut().pop());
    out
}

/// Runs `f` with expressions read under `version`, gathering the findings
/// every slot read in it reports (the statement parser's `parse_program`).
pub fn collecting<T>(version: u32, f: impl FnOnce() -> T) -> (T, Vec<SpellingFinding>) {
    SCOPE.with(|s| s.borrow_mut().push(Scope { version, findings: Some(Vec::new()) }));
    let out = f();
    let findings = SCOPE.with(|s| s.borrow_mut().pop()).and_then(|s| s.findings).unwrap_or_default();
    (out, findings)
}

/// The version expressions are read under; 0 outside every scope.
pub fn version() -> u32 {
    SCOPE.with(|s| s.borrow().last().map_or(0, |s| s.version))
}

/// The v5 surface is read.
pub fn is_v5() -> bool {
    crate::version::since(version(), 5)
}

/// Records a finding in the innermost collecting scope, if there is one.
///
/// A finding already there is not recorded twice: a block closure's
/// statements are read both by the statement grammar (a call written as a
/// statement) and through the slot that call's expression is.
pub fn report(finding: SpellingFinding) {
    SCOPE.with(|s| {
        if let Some(findings) = s.borrow_mut().iter_mut().rev().find_map(|s| s.findings.as_mut())
            && !findings.contains(&finding)
        {
            findings.push(finding);
        }
    });
}

/// Reads a v5 expression into the canonical tree; the findings are where
/// its text spells something the old way.
pub fn canonicalize(tree: &mut crate::tree::MExpr, src: &Utf16) -> Vec<Finding> {
    let mut canon = canonical::Canon::new(src);
    canon.visit(tree, false);
    canon.findings
}

/// The findings of a slot's text, placed in the file: its text begins at
/// `start`. A text the grammar refuses has none; the checker reports why.
///
/// A block closure's statements inside the text are read here too, their
/// findings reported as they are read: the statement grammar reads them only
/// when the call they sit in is read (a nested call, long after the parse),
/// where no finding is gathered.
pub fn slot_findings(raw: &str, start: Loc) -> Vec<SpellingFinding> {
    let src = Utf16::new(raw);
    let Ok(mut tree) = crate::expr::parse_expression_raw(raw) else { return Vec::new() };
    let findings = canonicalize(&mut tree, &src);
    read_blocks(&tree, &src, start);
    findings.into_iter().map(|f| place(&f, &src, start)).collect()
}

fn read_blocks(e: &crate::tree::MExpr, src: &Utf16, start: Loc) {
    if let crate::tree::MExpr::Closure { body, .. } = e
        && let crate::tree::ClosureBody::Block { at } = body.as_ref()
    {
        crate::stmt::read_block_for_findings(&src.text(at.start, at.end), loc_in(src, start, at.start));
    }
    crate::tree::shared::expr(e, &mut |child| read_blocks(child, src, start));
}

/// A finding at offsets into a text that starts at `start` in the file.
pub fn place(f: &Finding, src: &Utf16, start: Loc) -> SpellingFinding {
    let span = |at: At| Span { start: loc_in(src, start, at.start), end: loc_in(src, start, at.end) };
    SpellingFinding {
        code: f.code.to_string(),
        message: f.message.clone(),
        span: span(f.at),
        fix: f.edits.as_ref().map(|edits| Fix { edits: edits.iter().map(|e| SourceEdit { span: span(e.at), text: e.text.clone() }).collect() }),
    }
}

/// The file's line and UTF-16 column of `offset` into a text at `start`.
pub fn loc_in(src: &Utf16, start: Loc, offset: usize) -> Loc {
    let units = &src.units()[..offset.min(src.len())];
    match units.iter().rposition(|&u| u == b'\n' as u16) {
        None => Loc { line: start.line, col: start.col + units.len() },
        Some(nl) => {
            let lines = units.iter().filter(|&&u| u == b'\n' as u16).count();
            Loc { line: start.line + lines, col: units.len() - nl }
        }
    }
}
