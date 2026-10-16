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
    /// A guard in scope proved the value itself not blank (`nonBlank.value`).
    pub non_blank: bool,
    /// …or these fields read off it (`nonBlank.fields`).
    pub non_blank_fields: std::collections::BTreeSet<String>,
    /// A value that is many values under one value's type: a walk read for a
    /// field, or a second name for one (`ScopeSymbol.plural`).
    pub many_valued: bool,
    /// A combinator's answer one of whose arms hands back a record
    /// (`receiptHoldsRecord`): its slot read null before version 5.
    pub receipt_holds_record: bool,
    /// A name bound to a list of functions written down: what each returns,
    /// in order (`ScopeSymbol.armReturns`).
    pub arm_returns: Option<Vec<super::position::ReturnShape>>,
    /// A name bound to a `MAP` whose function hands back functions: what
    /// each of those returns (`ScopeSymbol.armsEachReturn`).
    pub arms_each_return: Option<super::position::ReturnShape>,
}

pub struct ScopeEnv<'s> {
    pub scopes: &'s Scopes,
    pub scope: ScopeId,
    pub zones: &'s dyn crate::host::ZoneLookup,
    pub nodes: &'s crate::families::nodes::NodeState,
    pub upgrading_from: Option<u32>,
    /// Each function declared with a name read as a value (version 5,
    /// `functionAsValue`), typed before the typing that reads it.
    pub function_values: &'s std::collections::HashMap<crate::scope::SymbolId, super::position::ClosureType>,
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
    fn is_declared_graph(&self, instance: &super::position::InstanceRef) -> bool {
        instance.declared.is_some_and(|symbol| self.nodes.is_local(symbol))
    }

    fn upgrading_from(&self) -> Option<u32> {
        self.upgrading_from
    }

    fn is_zone(&self, zone: &str) -> Option<bool> {
        Some(self.zones.is_zone(zone))
    }

    fn resolve_root(&self, name: &str) -> Option<Position> {
        let Resolution::Found(id) = self.scopes.resolve(self.scope, name) else { return None };
        self.scopes
            .symbol(id)
            .types
            .pos
            .clone()
            .or_else(|| self.function_values.get(&id).cloned().map(Position::Closure))
            // A node declaration is a graph, as a constructed instance is (`positionTypeOf`).
            .or_else(|| self.nodes.declared(id).map(|declared| Position::Meta { instance: declared.instance.clone() }))
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

    fn is_record_receipt(&self, name: &str) -> bool {
        self.types(name).is_some_and(|t| t.receipt_holds_record)
    }

    fn is_many_valued_name(&self, name: &str) -> bool {
        self.types(name).is_some_and(|t| t.many_valued)
    }
}
