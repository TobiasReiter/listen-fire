//! The check as a language service reads it: besides its diagnostics, what
//! the walk settled, kept — every scope with the text it covers, every
//! symbol with its type, and the import link. A position in the file is
//! answered from these (docs/contracts/language-service.md); nothing here
//! walks the program a second time.

use movement_parser::ast::{Loc, Program, Span};
use movement_parser::catalog::types::CatalogSnapshot;

use crate::scope::{Resolution, ScopeId, Scopes, Symbol, SymbolId, SymbolKind};
use crate::types::position::{ClosureType, Position, describe_position};
use crate::types::field::describe_field_type;
use crate::{CheckOptions, Diagnostic};

/// An imported name and the declaration it resolved to in its library.
#[derive(Debug, Clone)]
pub struct ImportedDeclaration {
    pub local: String,
    /// The catalog's key for the library (its path under the movements folder).
    pub file: String,
    pub name: String,
    pub span: Span,
}

/// What one check of a program settled.
pub struct Analysis {
    pub diagnostics: Vec<Diagnostic>,
    pub scopes: Scopes,
    /// The program's own file scope.
    pub file_scope: ScopeId,
    /// Each scope a body opens, with the text it covers.
    pub extents: Vec<(Span, ScopeId)>,
    pub imports: Vec<ImportedDeclaration>,
    /// Functions declared with a name, typed as the closures they are.
    pub function_values: std::collections::HashMap<SymbolId, ClosureType>,
}

/// Checks `program` and keeps what the walk settled.
pub fn analyze(program: &Program, catalog: &CatalogSnapshot, options: CheckOptions) -> Analysis {
    let (diagnostics, mut checker) = crate::run_check(program, catalog, options);
    let imports = checker
        .imports
        .link()
        .map(|link| {
            link.imports
                .iter()
                .filter_map(|(local, export)| {
                    let file = link.files.get(&export.file)?;
                    let span = file.program.statements.iter().find_map(|s| match s {
                        movement_parser::ast::Statement::Movement(m) if m.name == export.name => Some(m.span),
                        movement_parser::ast::Statement::Shape(s) if s.name == export.name => Some(s.span),
                        _ => None,
                    })?;
                    Some(ImportedDeclaration { local: local.clone(), file: export.file.clone(), name: export.name.clone(), span })
                })
                .collect()
        })
        .unwrap_or_default();
    Analysis {
        diagnostics,
        scopes: std::mem::take(&mut checker.scopes),
        file_scope: ScopeId(0),
        extents: std::mem::take(&mut checker.extents),
        imports,
        function_values: std::mem::take(&mut checker.function_values),
    }
}

fn before(a: Loc, b: Loc) -> bool {
    (a.line, a.col) <= (b.line, b.col)
}

fn contains(span: &Span, at: Loc) -> bool {
    before(span.start, at) && before(at, span.end)
}

fn size(span: &Span) -> (usize, usize) {
    (span.end.line - span.start.line, span.end.col.wrapping_sub(span.start.col))
}

/// A symbol a position sees.
pub struct Visible<'a> {
    pub id: SymbolId,
    pub symbol: &'a Symbol,
}

impl Analysis {
    /// The innermost scope whose text holds `at` (1-based line and column).
    pub fn scope_at(&self, at: Loc) -> ScopeId {
        self.extents
            .iter()
            .filter(|(span, _)| contains(span, at))
            .min_by_key(|(span, _)| size(span))
            .map_or(self.file_scope, |(_, scope)| *scope)
    }

    /// Every symbol `at` sees, innermost scope first, one per name: a
    /// declaration hoisted to its list's top (a function, a node, a type,
    /// a host unit) is seen from anywhere in it; any other binding from where
    /// it is written on.
    pub fn visible(&self, at: Loc) -> Vec<Visible<'_>> {
        let mut seen: Vec<Visible<'_>> = Vec::new();
        for scope in self.scopes.chain(self.scope_at(at)) {
            let mut here: Vec<Visible<'_>> = Vec::new();
            for id in self.scopes.scope(scope).declared.iter().copied() {
                let symbol = self.scopes.symbol(id);
                let hoisted = symbol.unit || matches!(symbol.kind, SymbolKind::Movement | SymbolKind::Shape | SymbolKind::Type);
                if !hoisted && !before(symbol.span.start, at) {
                    continue;
                }
                if seen.iter().any(|v| v.symbol.name == symbol.name) {
                    continue;
                }
                match here.iter_mut().find(|v| v.symbol.name == symbol.name) {
                    Some(earlier) => *earlier = Visible { id, symbol },
                    None => here.push(Visible { id, symbol }),
                }
            }
            seen.extend(here);
        }
        seen
    }

    /// The symbol `name` is at `at`.
    pub fn resolve(&self, at: Loc, name: &str) -> Option<SymbolId> {
        if let Some(found) = self.visible(at).into_iter().find(|v| v.symbol.name == name) {
            return Some(found.id);
        }
        match self.scopes.resolve(self.scope_at(at), name) {
            Resolution::Found(id) => Some(id),
            _ => None,
        }
    }

    pub fn symbol(&self, id: SymbolId) -> &Symbol {
        self.scopes.symbol(id)
    }

    /// The record a symbol holds, where it holds one.
    pub fn position_of(&self, id: SymbolId) -> Option<&Position> {
        self.scopes.symbol(id).types.pos.as_ref()
    }

    /// The symbol's type in the author's words, where the check typed it.
    pub fn type_text(&self, id: SymbolId) -> Option<String> {
        let symbol = self.scopes.symbol(id);
        if let Some(pos) = &symbol.types.pos {
            return Some(describe_position(pos));
        }
        if let Some(closure) = self.function_values.get(&id) {
            return Some(describe_position(&Position::Closure(closure.clone())));
        }
        symbol.types.field.as_ref().or(symbol.types.may_hold.as_ref()).map(describe_field_type)
    }

    /// Where an imported name is declared in its library.
    pub fn imported(&self, local: &str) -> Option<&ImportedDeclaration> {
        self.imports.iter().find(|i| i.local == local)
    }
}
