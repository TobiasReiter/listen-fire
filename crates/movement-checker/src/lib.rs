//! The movement-language checker in Rust, ported from
//! packages/movement-lang/checker family by family (PORT.md). It reads the
//! Rust parser's AST and a catalog snapshot, and reports diagnostics in the
//! TypeScript checker's shape. The TypeScript checker stays the reference
//! until the parity harness (PARITY.md) finds no difference.

pub mod abi;
pub mod answer;
mod binding_types;
mod checker;
pub mod codes;
mod cron;
mod diagnostic;
pub mod families;
pub mod host;
mod meta;
pub mod scope;
pub mod slots;
pub mod types;
mod version;

pub use diagnostic::{Diagnostic, Severity};

use movement_parser::ast::Program;
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::util::form::form_of_text;

#[derive(Clone, Copy)]
pub struct CheckOptions<'a> {
    pub language_version: u32,
    /// Checking for a move up from this version (`upgradingFrom`).
    pub upgrading_from: Option<u32>,
    /// Parse under this version when it differs from the one checked under.
    pub parse_version: Option<u32>,
    /// The host's zone database (`host`): a cron listen's `timezone`, a
    /// standard-library zone argument.
    pub zones: &'a dyn host::ZoneLookup,
}

/// `checkProgram`: the diagnostics for `program` under `options`.
pub fn check_program(program: &Program, catalog: &CatalogSnapshot, options: CheckOptions) -> Vec<Diagnostic> {
    run_check(program, catalog, options).0
}

/// `check_program`, and the walk it made: what it settled on nodes and the
/// link it resolved imports through (crate::answer).
pub(crate) fn run_check<'c>(program: &Program, catalog: &'c CatalogSnapshot, options: CheckOptions<'c>) -> (Vec<Diagnostic>, checker::Checker<'c>) {
    let (problems, mut checker) = check_once(program, catalog, options, false);
    let found = std::mem::take(&mut checker.diagnostics);
    // Under an older pin a site of the union rule kept its old answer: the
    // check again applying the rule says what that refuses, as an upgrade
    // warning (`RecordUnions`).
    let joined = if checker.record_unions.withheld.get() {
        refused_once_joined(&found, &check_once(program, catalog, options, true).1.diagnostics)
    } else {
        Vec::new()
    };
    let diagnostics = version::standing_diagnostic(options.language_version)
        .into_iter()
        .chain(problems)
        .chain(found.into_iter().chain(joined).map(version::with_handbook_pointer))
        .collect();
    (diagnostics, checker)
}

fn check_once<'c>(program: &Program, catalog: &'c CatalogSnapshot, options: CheckOptions<'c>, join_before5: bool) -> (Vec<Diagnostic>, checker::Checker<'c>) {
    let resolves_files = catalog.files.is_some();
    let mut link = resolves_files.then(|| families::imports::link_imports(program, catalog, options.language_version));
    let problems = link.as_mut().map(|l| std::mem::take(&mut l.problems)).unwrap_or_default();
    let mut checker = checker::Checker::new(catalog, &options, resolves_files);
    checker.record_unions.join_before5 = join_before5;
    checker.imports = families::imports::ImportState::new(link);
    checker.run(&program.statements);
    (problems, checker)
}

/// `refusedOnceJoined`: the errors a check applying the union rule reports
/// that the check under an older pin did not — each an upgrade warning, since
/// before version 5 the value was typed otherwise (or not at all) and ran so.
fn refused_once_joined(under_pin: &[Diagnostic], joined: &[Diagnostic]) -> Vec<Diagnostic> {
    let key = |d: &Diagnostic| (d.code.clone(), d.message.clone(), format!("{:?}", d.span));
    let seen: std::collections::HashSet<_> = under_pin.iter().map(key).collect();
    joined
        .iter()
        .filter(|d| d.is_error() && !seen.contains(&key(d)))
        .map(|d| Diagnostic {
            message: format!(
                "{}. Before {} a value that may be one of several records (an IF, a COALESCE, a function's returns, a list's members) was typed by one of them, or not at all, and what it fed ran so; from it, it reads and writes only what every one of them offers, and this is refused",
                d.message.strip_suffix('.').unwrap_or(&d.message),
                version::describe(5)
            ),
            severity: Some(Severity::Warning),
            upgrade: Some(true),
            ..d.clone()
        })
        .collect()
}

/// `languageVersionDiagnostic`: what a pin to `version` says on its own —
/// an error for one this release does not support, a warning for a
/// deprecated one, nothing for a current one.
pub fn language_version_diagnostic(version: u32) -> Option<Diagnostic> {
    version::standing_diagnostic(version)
}

/// A source the parser refuses: its message and where.
#[derive(Debug, Clone)]
pub struct ParseRefusal {
    pub message: String,
}

/// Parses `source`, text from outside (UTF-8), and checks it. The
/// diagnostics are in the engine's text form, as `check_form`'s are.
pub fn check_source(source: &str, catalog: &CatalogSnapshot, options: CheckOptions) -> Result<Vec<Diagnostic>, ParseRefusal> {
    check_form(&form_of_text(source), catalog, options)
}

/// `check_source` over a source already in the engine's text form (as its
/// JSON reader writes every host text: a lone surrogate held in-band, a
/// U+FDD0 written twice). Forming it again would double what is doubled.
/// Its diagnostics quote the source in that form; a writer for a reader
/// outside undoes it (`external_text`).
pub fn check_form(source: &str, catalog: &CatalogSnapshot, options: CheckOptions) -> Result<Vec<Diagnostic>, ParseRefusal> {
    let parse_version = options.parse_version.unwrap_or(options.language_version);
    let program = movement_parser::stmt::parse_program(source, parse_version, false)
        .map_err(|e| ParseRefusal { message: format!("{} at line {}, column {}", e.message, e.loc.line, e.loc.col) })?;
    Ok(check_program(&program, catalog, options))
}

/// The check as JSON: `{diagnostics}`, or `{error}` for a source that does
/// not parse or a catalog that does not load.
pub fn check_json(source: &str, catalog_json: &str, options: CheckOptions) -> serde_json::Value {
    // Read as `JSON.parse` reads it: a lone surrogate's escape included.
    let catalog = match CatalogSnapshot::load(&movement_parser::util::form::read_json_text(catalog_json)) {
        Ok(catalog) => catalog,
        Err(message) => return serde_json::json!({ "error": { "message": message } }),
    };
    match check_source(source, &catalog, options) {
        Ok(diagnostics) => serde_json::json!({ "diagnostics": diagnostics }),
        Err(refusal) => serde_json::json!({ "error": { "message": refusal.message } }),
    }
}
