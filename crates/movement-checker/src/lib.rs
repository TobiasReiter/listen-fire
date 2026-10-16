//! The movement-language checker in Rust, ported from
//! packages/movement-lang/checker family by family (PORT.md). It reads the
//! Rust parser's AST and a catalog snapshot, and reports diagnostics in the
//! TypeScript checker's shape. The TypeScript checker stays the reference
//! until the parity harness (PARITY.md) finds no difference.

pub mod abi;
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
    let resolves_files = catalog.files.is_some();
    let mut link = resolves_files.then(|| families::imports::link_imports(program, catalog, options.language_version));
    let problems = link.as_mut().map(|l| std::mem::take(&mut l.problems)).unwrap_or_default();
    let mut checker = checker::Checker::new(catalog, &options, resolves_files);
    checker.imports = families::imports::ImportState::new(link);
    checker.run(&program.statements);
    version::standing_diagnostic(options.language_version)
        .into_iter()
        .chain(problems)
        .chain(checker.diagnostics.into_iter().map(version::with_handbook_pointer))
        .collect()
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
