//! `lf-host upgrade`: the project's movement files rewritten into the language
//! version the project's engine runs, by the Rust checker's own fixes (the
//! TypeScript `lf upgrade`, apps/cli/src/upgrade.ts, over the shared loop in
//! packages/movement-lang/checker/upgrade.ts). Check, take the fixes that do
//! not overlap, apply them, check again, until nothing fixable is left. Only
//! fixes marked safe are applied unless `--all`; the rest are listed with their
//! rewrite. Only the rewritten spans change, so comments and layout survive.

use std::io::Write;
use std::path::Path;

use movement_checker::host::native::NativeZones;
use movement_checker::{CheckOptions, Diagnostic, Severity};
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::util::form::{external_text, read_json_text};
use serde_json::Value;

use crate::check::{Opened, open_checking, parse};
use crate::project::Project;

/// One pass per level of fix nesting; a well-behaved upgrade settles in a few.
const MAX_PASSES: usize = 16;

type Loc = (u64, u64);

struct Edit {
    start: Loc,
    end: Loc,
    text: String,
}

struct Fix {
    edits: Vec<Edit>,
    safe: bool,
    /// The edits as JSON, the identity two diagnostics offering one repair share.
    key: Value,
}

impl Fix {
    fn of(diagnostic: &Diagnostic) -> Option<Fix> {
        let fix = diagnostic.fix.as_ref()?;
        let loc = |v: &Value| Some((v.get("line")?.as_u64()?, v.get("col")?.as_u64()?));
        let edits_json = fix.get("edits")?;
        let edits = edits_json
            .as_array()?
            .iter()
            .map(|e| Some(Edit { start: loc(e.get("span")?.get("start")?)?, end: loc(e.get("span")?.get("end")?)?, text: external_text(e.get("text")?.as_str()?).into_owned() }))
            .collect::<Option<Vec<_>>>()?;
        Some(Fix { edits, safe: fix.get("safe") == Some(&Value::Bool(true)), key: edits_json.clone() })
    }

    fn extent(&self) -> (Loc, Loc) {
        let start = self.edits.iter().map(|e| e.start).min().unwrap_or((0, 0));
        let end = self.edits.iter().map(|e| e.end).max().unwrap_or((0, 0));
        (start, end)
    }
}

/// Two edits touch the same text, or insert at the same place (their order would be a guess).
fn edits_overlap(a: &Edit, b: &Edit) -> bool {
    if (a.start == a.end || b.start == b.end) && a.start == b.start {
        return true;
    }
    a.start < b.end && b.start < a.end
}

/// The diagnostics that stand between a text and the target version.
fn standing(diagnostics: Vec<Diagnostic>) -> Vec<Diagnostic> {
    diagnostics.into_iter().filter(|d| d.severity.is_none() || d.upgrade == Some(true)).collect()
}

fn fixes_to_apply(diagnostics: &[Diagnostic], all: bool) -> Vec<Fix> {
    let mut offered: Vec<Fix> = diagnostics
        .iter()
        .filter(|d| d.severity.is_none() || d.upgrade == Some(true))
        .filter_map(Fix::of)
        .filter(|fix| !fix.edits.is_empty() && (all || fix.safe))
        .collect();
    // Outermost first: earliest start, then widest.
    offered.sort_by(|a, b| {
        let (x, y) = (a.extent(), b.extent());
        x.0.cmp(&y.0).then(y.1.cmp(&x.1))
    });
    let mut taken: Vec<Fix> = Vec::new();
    for fix in offered {
        if taken.iter().any(|t| t.key == fix.key) {
            continue;
        }
        if taken.iter().any(|t| t.edits.iter().any(|a| fix.edits.iter().any(|b| edits_overlap(a, b)))) {
            continue;
        }
        taken.push(fix);
    }
    taken
}

/// The edits applied the way `applyFix` applies them: columns count UTF-16 code units.
fn apply(source: &str, fixes: &[Fix]) -> String {
    let units: Vec<u16> = source.encode_utf16().collect();
    let mut line_starts = vec![0usize];
    for (i, u) in units.iter().enumerate() {
        if *u == u16::from(b'\n') {
            line_starts.push(i + 1);
        }
    }
    let offset = |(line, col): Loc| {
        let base = line_starts.get((line as usize).wrapping_sub(1)).copied().unwrap_or(units.len());
        (base + col as usize).saturating_sub(1)
    };
    let mut edits: Vec<&Edit> = fixes.iter().flat_map(|f| f.edits.iter()).collect();
    // Back to front, so an edit never shifts the offsets of one still to apply.
    edits.sort_by_key(|e| std::cmp::Reverse(offset(e.start)));
    let mut result = units.clone();
    for edit in edits {
        let (from, to) = (offset(edit.start).min(result.len()), offset(edit.end).min(result.len()));
        result.splice(from..to.max(from), edit.text.encode_utf16());
    }
    String::from_utf16_lossy(&result)
}

/// Every diagnostic a check of `source` under the project's version reports.
fn check_text(source: &str, catalog: &CatalogSnapshot, language_version: u32) -> Vec<Diagnostic> {
    let parse_refusal = |message: String, line: usize, col: usize| {
        let at = movement_parser::ast::Loc { line, col };
        vec![Diagnostic::error("MOV_PARSE", message, movement_parser::ast::Span { start: at, end: at })]
    };
    if let Err(refused) = parse(source, language_version) {
        return parse_refusal(refused.message, refused.line, refused.column);
    }
    let options = CheckOptions { language_version, upgrading_from: None, parse_version: None, zones: &NativeZones };
    match movement_checker::check_source(source, catalog, options) {
        Ok(diagnostics) => diagnostics,
        Err(refusal) => parse_refusal(refusal.message, 1, 1),
    }
}

struct Upgraded {
    source: String,
    remaining: Vec<Diagnostic>,
    settled: bool,
}

fn upgrade_source(source: &str, catalog: &CatalogSnapshot, language_version: u32, all: bool) -> Upgraded {
    let mut text = source.to_string();
    for _ in 0..MAX_PASSES {
        let diagnostics = check_text(&text, catalog, language_version);
        let fixes = fixes_to_apply(&diagnostics, all);
        let rewritten = apply(&text, &fixes);
        // A fix that rewrites to the same text would loop forever.
        if fixes.is_empty() || rewritten == text {
            return Upgraded { source: text, remaining: standing(diagnostics), settled: true };
        }
        text = rewritten;
    }
    let remaining = standing(check_text(&text, catalog, language_version));
    Upgraded { source: text, remaining, settled: false }
}

/// A unified diff of two texts, by line; empty when they are the same.
fn unified_diff(before: &str, after: &str, path: &str) -> String {
    if before == after {
        return String::new();
    }
    let lines_of = |text: &str| text.strip_suffix('\n').unwrap_or(text).split('\n').map(str::to_string).collect::<Vec<_>>();
    let (a, b) = (lines_of(before), lines_of(after));
    let context = 3usize;
    let mut lcs = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if a[i] == b[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    // (kind, text, lines of a before it, lines of b before it)
    let mut lines: Vec<(char, &str, usize, usize)> = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            lines.push((' ', &a[i], i, j));
            i += 1;
            j += 1;
        } else if i < a.len() && (j == b.len() || lcs[i + 1][j] >= lcs[i][j + 1]) {
            lines.push(('-', &a[i], i, j));
            i += 1;
        } else {
            lines.push(('+', &b[j], i, j));
            j += 1;
        }
    }
    let shown = path.trim_start_matches('/');
    let mut out = vec![format!("--- a/{shown}"), format!("+++ b/{shown}")];
    let mut k = 0;
    while k < lines.len() {
        if lines[k].0 == ' ' {
            k += 1;
            continue;
        }
        // A hunk: this change and every one within 2×context lines of it.
        let mut last_change = k;
        let mut n = k;
        while n < lines.len() && n - last_change <= 2 * context {
            if lines[n].0 != ' ' {
                last_change = n;
            }
            n += 1;
        }
        let hunk = &lines[k.saturating_sub(context)..(last_change + context + 1).min(lines.len())];
        let a_count = hunk.iter().filter(|l| l.0 != '+').count();
        let b_count = hunk.iter().filter(|l| l.0 != '-').count();
        let first = hunk[0];
        out.push(format!("@@ -{},{a_count} +{},{b_count} @@", first.2 + usize::from(a_count > 0), first.3 + usize::from(b_count > 0)));
        for l in hunk {
            out.push(format!("{}{}", l.0, l.1));
        }
        k = last_change + context + 1;
    }
    out.push(String::new());
    out.join("\n")
}

fn severity_word(d: &Diagnostic) -> &'static str {
    match d.severity {
        None => "error",
        Some(Severity::Warning) => "warning",
        Some(Severity::Info) => "info",
    }
}

pub async fn run(project: &Project, options: UpgradeOptions, out: &mut impl Write) -> Result<i32, String> {
    let io = |e: std::io::Error| e.to_string();
    let checking = match open_checking(project).await? {
        Opened::MissingCredentials(lines) => {
            for line in &lines {
                writeln!(out, "{line}").map_err(io)?;
            }
            writeln!(out, "{} error(s)", lines.len()).map_err(io)?;
            return Ok(1);
        }
        Opened::Ready(checking) => checking,
    };
    let catalog = CatalogSnapshot::load(&read_json_text(&checking.catalog.to_json())).map_err(|e| format!("the catalog does not load: {e}"))?;
    let (mut changed, mut left) = (0usize, 0usize);
    for file in &checking.files {
        let result = upgrade_source(&file.source, &catalog, project.language_version, options.all);
        let shown = relative(&project.root, &file.path);
        if result.source != file.source {
            changed += 1;
            if options.check_only {
                writeln!(out, "{}", unified_diff(&file.source, &result.source, &shown).trim_end()).map_err(io)?;
            } else {
                std::fs::write(&file.path, &result.source).map_err(|e| format!("{}: {e}", file.path.display()))?;
            }
        }
        for d in &result.remaining {
            left += 1;
            writeln!(out, "{shown}:{}:{} {} {} {}", d.span.start.line, d.span.start.col, severity_word(d), d.code, external_text(&d.message)).map_err(io)?;
            // A fix not proved to keep the meaning: shown, applied only with --all.
            if let Some(fix) = Fix::of(d).filter(|f| !f.edits.is_empty()) {
                let texts: Vec<String> = fix.edits.iter().map(|e| serde_json::to_string(&e.text).unwrap_or_default()).collect();
                writeln!(out, "  fix (not applied, may change meaning; --all applies it): {}", texts.join(", ")).map_err(io)?;
            }
        }
        if !result.settled {
            left += 1;
            writeln!(out, "{shown}: the rewrite did not settle — a fix keeps rewriting its own output (a bug; please report it)").map_err(io)?;
        }
    }
    let verb = if options.check_only { "would be rewritten" } else { "rewritten" };
    writeln!(out, "{} file(s), {changed} {verb}, {left} left to change by hand", checking.files.len()).map_err(io)?;
    Ok(if left > 0 || (options.check_only && changed > 0) { 1 } else { 0 })
}

pub struct UpgradeOptions {
    pub check_only: bool,
    pub all: bool,
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_diff_marks_the_changed_line_with_context() {
        let diff = unified_diff("a\nb\nc\n", "a\nB\nc\n", "x.mvt");
        assert_eq!(diff, "--- a/x.mvt\n+++ b/x.mvt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
    }

    #[test]
    fn edits_apply_by_utf16_columns_back_to_front() {
        let fix = |l, c0, c1, t: &str| Fix { edits: vec![Edit { start: (l, c0), end: (l, c1), text: t.into() }], safe: true, key: Value::Null };
        // "é😀" is 3 UTF-16 units; the edit after it starts at column 4.
        assert_eq!(apply("é😀xy\nz", &[fix(1, 4, 5, "X"), fix(2, 1, 1, ">")]), "é😀Xy\n>z");
    }
}
