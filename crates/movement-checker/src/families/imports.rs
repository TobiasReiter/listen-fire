//! File imports: resolving `import { x } from "lib/file"` against the files
//! the catalog snapshot carries, and checking each library in its own scope.
//!
//! Codes: MOV_IMPORT_FILE_UNRESOLVED, MOV_IMPORT_FILE_INVALID,
//! MOV_IMPORT_CYCLE, MOV_IMPORT_NOT_EXPORTED (the linker's), and
//! MOV_IMPORT_FILE_UNSUPPORTED (raised by the import statement the names
//! family checks).
//!
//! TypeScript: link.ts `linkImports`; check.ts `checkLibrary`,
//! `fileImportSymbol`, `checkProgramWithLink`.

use std::collections::HashMap;
use std::rc::Rc;

use indexmap::IndexMap;
use movement_parser::ast::{
    ArmExpression, AwaitExpression, AwaitSource, CombinatorArms, CombinatorExpression, ImportSource, ImportStatement, Loc, Program, RValue,
    Span, Statement,
};
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::util::form::form_of_text;

use crate::checker::Checker;
use crate::codes;
use crate::diagnostic::{Diagnostic, Severity};
use crate::scope::{Symbol, SymbolId, SymbolKind};

/// One resolved library file: its program and its own file-imported names.
pub struct LinkedFile {
    pub path: String,
    pub program: Program,
    pub imports: IndexMap<String, LinkedExport>,
}

/// What an imported name resolved to: an exported movement or node
/// declaration, by its name in the library.
#[derive(Clone)]
pub struct LinkedExport {
    pub name: String,
    pub is_movement: bool,
    pub file: String,
}

/// `ProgramLink`: the root's imports, every library by path, and the problems.
#[derive(Default)]
pub struct ProgramLink {
    pub imports: IndexMap<String, LinkedExport>,
    pub files: HashMap<String, Rc<LinkedFile>>,
    pub problems: Vec<Diagnostic>,
}

/// What the walk holds for file imports: the link, the file being checked
/// (none for the root), and each library once checked — its file scope's
/// symbols by name.
#[derive(Default)]
pub struct ImportState {
    link: Option<Rc<ProgramLink>>,
    current_file: Option<Rc<LinkedFile>>,
    checked: HashMap<String, IndexMap<String, SymbolId>>,
    /// The old spellings (language version 5) of the libraries the file
    /// being checked imports, each at the import that pulled its library in.
    /// Kept apart from the walk's diagnostics: a finding's message names the
    /// old spelling, which the program's own spelling must not rewrite.
    pub spelling: Vec<Diagnostic>,
}

impl ImportState {
    pub fn new(link: Option<ProgramLink>) -> Self {
        ImportState { link: link.map(Rc::new), ..ImportState::default() }
    }

    /// The link the walk resolved imports through, where files resolve.
    pub fn link(&self) -> Option<&ProgramLink> {
        self.link.as_deref()
    }

    /// The library file being checked; none for the root program.
    pub fn current_path(&self) -> Option<&str> {
        self.current_file.as_ref().map(|f| f.path.as_str())
    }
}

/// `fileExports`: the movements and nodes marked `export`.
fn file_exports(program: &Program) -> Vec<(&str, bool)> {
    program
        .statements
        .iter()
        .filter_map(|s| match s {
            Statement::Movement(m) if m.exported == Some(true) => Some((m.name.as_str(), true)),
            Statement::Shape(s) if s.exported == Some(true) => Some((s.name.as_str(), false)),
            _ => None,
        })
        .collect()
}

/// `unexportedDeclarationNames`.
fn unexported_declaration_names(program: &Program) -> Vec<&str> {
    program
        .statements
        .iter()
        .filter_map(|s| match s {
            Statement::Movement(m) if m.exported != Some(true) => Some(m.name.as_str()),
            Statement::Shape(s) if s.exported != Some(true) => Some(s.name.as_str()),
            _ => None,
        })
        .collect()
}

/// `fileImportStatements`: every file import, nested ones included.
fn file_import_statements<'p>(statements: &'p [Statement], out: &mut Vec<(&'p ImportStatement, &'p str)>) {
    for statement in statements {
        match statement {
            Statement::Import(import) => {
                if let ImportSource::File { path } = &import.source {
                    out.push((import, path));
                }
            }
            Statement::Movement(m) => file_import_statements(&m.body, out),
            Statement::Combinator(c) => arm_bodies(Some(&c.combinator), out),
            Statement::Await(a) => arm_bodies(combinator_of(&a.r#await), out),
            Statement::Block(b) => file_import_statements(&b.block.body, out),
            Statement::If(i) => {
                for arm in &i.arms {
                    file_import_statements(&arm.body, out);
                }
                if let Some(else_arm) = &i.else_arm {
                    file_import_statements(&else_arm.body, out);
                }
            }
            Statement::Assign(a) => match &a.value {
                RValue::Block { block } => file_import_statements(&block.body, out),
                RValue::Closure { closure } => file_import_statements(&closure.body, out),
                RValue::Combinator { combinator } => arm_bodies(Some(combinator), out),
                RValue::Await { r#await } => arm_bodies(combinator_of(r#await), out),
                _ => {}
            },
            _ => {}
        }
    }
}

fn combinator_of(expr: &AwaitExpression) -> Option<&CombinatorExpression> {
    match &expr.source {
        AwaitSource::Combinator { combinator, .. } => Some(combinator),
        _ => None,
    }
}

/// The bodies of a combinator's written closure arms.
fn arm_bodies<'p>(expr: Option<&'p CombinatorExpression>, out: &mut Vec<(&'p ImportStatement, &'p str)>) {
    let Some(expr) = expr else { return };
    let arms = match &expr.arms {
        CombinatorArms::Literal { arms, .. } | CombinatorArms::Arguments { arms, .. } => arms,
        CombinatorArms::Dynamic { .. } => return,
    };
    for arm in arms {
        if let ArmExpression::Closure { closure, .. } = arm {
            file_import_statements(&closure.body, out);
        }
    }
}

const SPAN_FALLBACK: Span = Span { start: Loc { line: 1, col: 1 }, end: Loc { line: 1, col: 1 } };

struct Linker<'c> {
    catalog: &'c CatalogSnapshot,
    version: u32,
    /// `null` for a path that failed to load, so it fails once.
    files: IndexMap<String, Option<Rc<LinkedFile>>>,
    loading: Vec<String>,
    problems: Vec<Diagnostic>,
}

/// Where a problem is reported: on its own statement in the root, or, inside
/// a library, prefixed with the library's path and line at the root import.
#[derive(Clone, Copy)]
struct Site<'a> {
    root_span: Option<Span>,
    within: Option<&'a str>,
}

impl Linker<'_> {
    fn report(&mut self, site: Site<'_>, code: &str, message: String, statement_span: Span) {
        let (message, span) = match site.within {
            Some(path) => (format!("\"{path}\" line {}: {message}", statement_span.start.line), site.root_span.unwrap_or(SPAN_FALLBACK)),
            None => (message, statement_span),
        };
        self.problems.push(Diagnostic::error(code, message, span));
    }

    fn load(&mut self, path: &str, site: Site<'_>, statement_span: Span, root_span: Span) -> Option<Rc<LinkedFile>> {
        if let Some(at) = self.loading.iter().position(|p| p == path) {
            let mut chain: Vec<&str> = self.loading[at..].iter().map(String::as_str).collect();
            chain.push(path);
            let message = format!("Import cycle: {} — movement libraries cannot import each other in a loop", chain.join(" → "));
            self.report(site, codes::IMPORT_CYCLE, message, statement_span);
            return None;
        }
        if let Some(known) = self.files.get(path) {
            return known.clone();
        }
        let Some(source) = self.catalog.files.as_ref().and_then(|f| f.get(path)).map(|f| f.source.clone()) else {
            let message = format!("No movement file named \"{path}\" — file imports resolve against your saved movement files by name");
            self.report(site, codes::IMPORT_FILE_UNRESOLVED, message, statement_span);
            self.files.insert(path.to_string(), None);
            return None;
        };
        let program = match movement_parser::stmt::parse_program(&form_of_text(&source), self.version, false) {
            Ok(program) => program,
            Err(e) => {
                let message = format!(
                    "\"{path}\" does not parse — {} (line {}, col {}) — fix the library file before importing from it",
                    e.message, e.loc.line, e.loc.col
                );
                self.report(site, codes::IMPORT_FILE_INVALID, message, statement_span);
                self.files.insert(path.to_string(), None);
                return None;
            }
        };
        // The library's own imports are linked before it is filed, then filed
        // with them; a cycle back to it is caught by `loading`, not by the map.
        self.loading.push(path.to_string());
        let mut imports = IndexMap::new();
        self.link_file_level(&program, &mut imports, Site { root_span: Some(root_span), within: Some(path) });
        self.loading.pop();
        let file = Rc::new(LinkedFile { path: path.to_string(), program, imports });
        self.files.insert(path.to_string(), Some(file.clone()));
        Some(file)
    }

    fn link_file_level(&mut self, target: &Program, into: &mut IndexMap<String, LinkedExport>, site: Site<'_>) {
        let mut statements = Vec::new();
        file_import_statements(&target.statements, &mut statements);
        for (statement, path) in statements {
            let root_span = site.root_span.unwrap_or(statement.span);
            let Some(file) = self.load(path, site, statement.span, root_span) else { continue };
            let exports = file_exports(&file.program);
            for imported in &statement.names {
                let Some((_, is_movement)) = exports.iter().find(|(name, _)| *name == imported.name) else {
                    let hint = if unexported_declaration_names(&file.program).contains(&imported.name.as_str()) {
                        format!(" — \"{path}\" declares '{}' but doesn't export it; add `export` before its declaration", imported.name)
                    } else if exports.is_empty() {
                        " — a file's exports are the declarations marked `export` (it exports none)".to_string()
                    } else {
                        let available: Vec<&str> = exports.iter().map(|(name, _)| *name).collect();
                        format!(" — a file's exports are the declarations marked `export`: {}", available.join(", "))
                    };
                    let message = format!("\"{path}\" does not export '{}'{hint}", imported.name);
                    self.report(site, codes::IMPORT_NOT_EXPORTED, message, statement.span);
                    continue;
                };
                let local = imported.alias.clone().unwrap_or_else(|| imported.name.clone());
                into.insert(local, LinkedExport { name: imported.name.clone(), is_movement: *is_movement, file: path.to_string() });
            }
        }
    }
}

/// `linkImports`: a program's file imports, resolved transitively against
/// the snapshot's files. Never fails: each failure is a problem attributed
/// to an import of the root program, and its names stay unresolved.
pub fn link_imports(program: &Program, catalog: &CatalogSnapshot, version: u32) -> ProgramLink {
    let mut linker = Linker { catalog, version, files: IndexMap::new(), loading: Vec::new(), problems: Vec::new() };
    let mut imports = IndexMap::new();
    linker.link_file_level(program, &mut imports, Site { root_span: None, within: None });
    let files = linker.files.into_iter().filter_map(|(path, file)| file.map(|f| (path, f))).collect();
    ProgramLink { imports, files, problems: linker.problems }
}

impl Checker<'_> {
    /// `fileImportSymbol`: the local symbol of a file-imported name — the
    /// library's movement or node when the link resolved it (its library
    /// checked first), an opaque file import otherwise. With it, the library
    /// symbol it stands for.
    pub fn file_import_symbol(&mut self, local: &str, name: &str, span: Span) -> (Symbol, Option<SymbolId>) {
        let mut opaque = Symbol::new(local, SymbolKind::FileImport, span);
        opaque.imported_name = Some(name.to_string());
        let Some(link) = self.imports.link.clone() else { return (opaque, None) };
        let current = self.imports.current_file.clone();
        let imports = current.as_ref().map_or(&link.imports, |f| &f.imports);
        let Some(exported) = imports.get(local).cloned() else { return (opaque, None) };
        let Some(file) = link.files.get(&exported.file).cloned() else { return (opaque, None) };
        let library = self.check_library(&file, span);
        let Some(library_symbol) = library.get(&exported.name).copied() else { return (opaque, None) };
        let kind = self.scopes.symbol(library_symbol).kind;
        let resolved = match (exported.is_movement, kind) {
            (true, SymbolKind::Movement) => SymbolKind::Movement,
            (false, SymbolKind::Shape) => SymbolKind::Shape,
            _ => return (opaque, None),
        };
        let mut symbol = Symbol::new(local, resolved, span);
        symbol.imported_name = Some(name.to_string());
        (symbol, Some(library_symbol))
    }

    /// The library facts an imported symbol carries over from the library's own.
    pub fn adopt_library_symbol(&mut self, local: SymbolId, library: SymbolId) {
        self.listens.adopt(local, library);
        self.nodes.adopt(local, library);
        self.adopt_movement(local, library);
    }

    /// `checkLibrary`: one library checked once, in its own file scope, its
    /// errors and warnings surfaced at the import that first pulled it in,
    /// prefixed with its path and line. Its own info stays its own.
    fn check_library(&mut self, file: &Rc<LinkedFile>, at: Span) -> IndexMap<String, SymbolId> {
        if let Some(checked) = self.imports.checked.get(&file.path) {
            return checked.clone();
        }
        let outer_diagnostics = std::mem::take(&mut self.diagnostics);
        let own_spelling = file.program.spelling.iter().map(crate::diagnostic::of_spelling).collect();
        let outer_spelling = std::mem::replace(&mut self.imports.spelling, own_spelling);
        let outer_file = self.imports.current_file.replace(file.clone());
        let outer_listens = self.listens.enter_file();
        let scope = self.scopes.open(None);
        self.check_statement_list(&file.program.statements, scope);
        self.listens.leave_file(outer_listens);
        self.imports.current_file = outer_file;
        let surfaced = std::mem::replace(&mut self.diagnostics, outer_diagnostics);
        let surfaced_spelling = std::mem::replace(&mut self.imports.spelling, outer_spelling);
        let symbols = self.scopes.scope(scope).symbols.clone();
        self.imports.checked.insert(file.path.clone(), symbols.clone());
        for mut diagnostic in surfaced.into_iter().filter(|d| d.severity != Some(Severity::Info)) {
            diagnostic.message = format!("\"{}\" line {}: {}", file.path, diagnostic.span.start.line, diagnostic.message);
            diagnostic.span = at;
            self.push(diagnostic);
        }
        // A fix's edits are the library file's, so none is carried to the
        // import.
        if self.type_only == 0 {
            for diagnostic in surfaced_spelling {
                let message = format!("\"{}\" line {}: {}", file.path, diagnostic.span.start.line, diagnostic.message);
                self.imports.spelling.push(Diagnostic::error(&diagnostic.code, message, at));
            }
        }
        symbols
    }
}
