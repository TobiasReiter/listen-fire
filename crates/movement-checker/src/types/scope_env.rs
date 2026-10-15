//! The scope chain as the typing's environment: each symbol carries the type
//! its binding was given (`Symbol::types`), and a name resolves as the
//! names family resolves it.

use crate::scope::{Resolution, ScopeId, Scopes};

use super::field::{CollectionOrder, Ty};
use super::infer::TypeEnv;
use super::position::Position;

/// What a binding is typed as, on whichever plane (`ScopeSymbol`'s
/// `posType`, `fieldType`, `mayHold`, `pluralOrder`).
#[derive(Debug, Clone, Default)]
pub struct SymbolTypes {
    pub pos: Option<Position>,
    pub field: Option<Ty>,
    pub may_hold: Option<Ty>,
    /// A name bound to a block over a walk: its records, in this order.
    pub plural: Option<CollectionOrder>,
    /// Holds a record nobody can name.
    pub is_record: bool,
}

pub struct ScopeEnv<'s> {
    pub scopes: &'s Scopes,
    pub scope: ScopeId,
}

impl ScopeEnv<'_> {
    fn types(&self, name: &str) -> Option<&SymbolTypes> {
        match self.scopes.resolve(self.scope, name) {
            Resolution::Found(id) => Some(&self.scopes.symbol(id).types),
            _ => None,
        }
    }
}

impl TypeEnv for ScopeEnv<'_> {
    fn resolve_root(&self, name: &str) -> Option<Position> {
        self.types(name)?.pos.clone()
    }

    fn resolve_scalar(&self, name: &str) -> Option<Ty> {
        self.types(name)?.field.clone()
    }

    fn resolve_may_hold(&self, name: &str) -> Option<Ty> {
        self.types(name)?.may_hold.clone()
    }

    fn name_in_scope(&self, name: &str) -> bool {
        matches!(self.scopes.resolve(self.scope, name), Resolution::Found(_))
    }

    fn is_record_name(&self, name: &str) -> bool {
        self.types(name).is_some_and(|t| t.is_record)
    }

    fn plural_order_of(&self, name: &str) -> Option<CollectionOrder> {
        self.types(name)?.plural
    }
}
