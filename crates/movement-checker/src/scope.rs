//! The lexical scope chain (checker/scopes.ts). Scopes and symbols live in
//! arenas owned by the checker and are named by index, so a symbol can be
//! shared between scopes (a narrowing re-declares the same one) without
//! reference counting.

use std::collections::HashSet;

use indexmap::IndexMap;
use movement_parser::ast::Span;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolKind {
    Adapter,
    Credential,
    Plugin,
    FileImport,
    Binding,
    Instance,
    Param,
    Movement,
    /// A node declaration (`node X { … }`); the TypeScript keeps the
    /// historical spelling `shape`.
    Shape,
    Alias,
    Type,
}

impl SymbolKind {
    /// `describeKind` in check.ts.
    pub fn describe(self) -> &'static str {
        match self {
            SymbolKind::Adapter => "an adapter type",
            SymbolKind::Credential => "a credential",
            SymbolKind::Plugin => "a plugin",
            SymbolKind::FileImport => "a file import",
            SymbolKind::Binding => "a binding",
            SymbolKind::Instance => "a constructed instance",
            SymbolKind::Param => "a parameter",
            SymbolKind::Movement => "a movement",
            SymbolKind::Shape => "a declared node",
            SymbolKind::Alias => "a traversal alias",
            SymbolKind::Type => "a declared type",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    pub span: Span,
    /// For an import: the name in its namespace (the local name may be an alias).
    pub imported_name: Option<String>,
    /// For an instance: the adapter that constructed it.
    pub adapter: Option<String>,
    /// A binding or parameter whose value is a closure: a function by name.
    pub is_closure: bool,
    /// What the binding is typed as (the type core's; empty is untyped).
    pub types: crate::types::scope_env::SymbolTypes,
}

impl Symbol {
    pub fn new(name: impl Into<String>, kind: SymbolKind, span: Span) -> Self {
        Symbol { name: name.into(), kind, span, imported_name: None, adapter: None, is_closure: false, types: Default::default() }
    }

    /// `isFunctionSymbol`: a name a call can run.
    pub fn is_function(&self) -> bool {
        matches!(self.kind, SymbolKind::Movement | SymbolKind::Plugin | SymbolKind::FileImport) || self.is_closure
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ScopeId(pub usize);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SymbolId(pub usize);

#[derive(Debug)]
pub struct Scope {
    pub parent: Option<ScopeId>,
    /// The last binding of each name, in first-declaration order (a `Map`'s).
    pub symbols: IndexMap<String, SymbolId>,
    /// Names a later statement in this list binds.
    pub pending: HashSet<String>,
    /// Names bound inside a closed traversal block, with the block's binding name.
    pub escaped: IndexMap<String, Option<String>>,
}

pub enum Resolution {
    Found(SymbolId),
    Pending,
    Escaped { block_name: Option<String> },
    Unknown,
}

pub enum Shadowing {
    Bound(SymbolId),
    Pending,
}

#[derive(Default, Debug)]
pub struct Scopes {
    scopes: Vec<Scope>,
    symbols: Vec<Symbol>,
}

impl Scopes {
    /// A new scope under `parent`: the file's (none), a movement's or a
    /// closure's body, a traversal block's, or an `if` arm's.
    pub fn open(&mut self, parent: Option<ScopeId>) -> ScopeId {
        self.scopes.push(Scope { parent, symbols: IndexMap::new(), pending: HashSet::new(), escaped: IndexMap::new() });
        ScopeId(self.scopes.len() - 1)
    }

    pub fn scope(&self, id: ScopeId) -> &Scope {
        &self.scopes[id.0]
    }

    pub fn scope_mut(&mut self, id: ScopeId) -> &mut Scope {
        &mut self.scopes[id.0]
    }

    pub fn symbol(&self, id: SymbolId) -> &Symbol {
        &self.symbols[id.0]
    }

    pub fn symbol_mut(&mut self, id: SymbolId) -> &mut Symbol {
        &mut self.symbols[id.0]
    }

    pub fn add_symbol(&mut self, symbol: Symbol) -> SymbolId {
        self.symbols.push(symbol);
        SymbolId(self.symbols.len() - 1)
    }

    pub fn chain(&self, from: ScopeId) -> impl Iterator<Item = ScopeId> + '_ {
        std::iter::successors(Some(from), move |id| self.scopes[id.0].parent)
    }

    /// Binds `symbol` in `scope`; the same-scope binding it replaced, if any.
    pub fn declare(&mut self, scope: ScopeId, symbol: SymbolId) -> Option<SymbolId> {
        let name = self.symbols[symbol.0].name.clone();
        let scope = &mut self.scopes[scope.0];
        scope.pending.remove(&name);
        scope.symbols.insert(name, symbol)
    }

    pub fn has_own(&self, scope: ScopeId, name: &str) -> bool {
        self.scopes[scope.0].symbols.contains_key(name)
    }

    /// What an authored binding of `name` in `scope` would hide.
    pub fn shadowing(&self, scope: ScopeId, name: &str) -> Option<Shadowing> {
        for id in self.chain(scope).skip(1) {
            let s = &self.scopes[id.0];
            if let Some(symbol) = s.symbols.get(name) {
                return Some(Shadowing::Bound(*symbol));
            }
            if s.pending.contains(name) {
                return Some(Shadowing::Pending);
            }
        }
        None
    }

    pub fn resolve(&self, scope: ScopeId, name: &str) -> Resolution {
        for id in self.chain(scope) {
            let s = &self.scopes[id.0];
            if let Some(symbol) = s.symbols.get(name) {
                return Resolution::Found(*symbol);
            }
            if s.pending.contains(name) {
                return Resolution::Pending;
            }
        }
        for id in self.chain(scope) {
            if let Some(block_name) = self.scopes[id.0].escaped.get(name) {
                return Resolution::Escaped { block_name: block_name.clone() };
            }
        }
        Resolution::Unknown
    }

    /// The function in scope written `name` in any letter case.
    pub fn resolve_function(&self, scope: ScopeId, name: &str) -> Option<SymbolId> {
        let folded = name.to_lowercase();
        for id in self.chain(scope) {
            for symbol in self.scopes[id.0].symbols.values() {
                let s = &self.symbols[symbol.0];
                if s.is_function() && s.name.to_lowercase() == folded {
                    return Some(*symbol);
                }
            }
        }
        None
    }
}
