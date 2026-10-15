//! The closures family: not yet ported. Its codes (PORT.md has where the
//! TypeScript raises each):
//!
//! - MOV_BLOCK_READ_BACK_RETIRED
//! - MOV_BLOCK_RETURNS_NOTHING
//! - MOV_CLOSURE_NOT_DATA
//! - MOV_COLLECTION_OP_ARITY
//! - MOV_COLLECTION_OP_CONFIG
//! - MOV_COLLECTION_OP_NOT_A_COLLECTION
//! - MOV_COLLECTION_OP_RETURNS_NOTHING
//! - MOV_COLLECTION_OP_SUSPENDS
//! - MOV_COMBINATOR_ARMS_ARE_ARGUMENTS
//! - MOV_COMBINATOR_ARM_NOT_FUNCTION
//! - MOV_COMBINATOR_ARM_TAKES_NOTHING
//! - MOV_COMBINATOR_NEEDS_AWAIT
//! - MOV_COMBINATOR_NO_AWAIT
//! - MOV_INLINE_BLOCK_RETIRED
//! - MOV_PARALLEL_RETIRED


use movement_parser::ast::ClosureExpression;
use movement_parser::version::since;

use crate::checker::Checker;
use crate::scope::{ScopeId, Symbol, SymbolKind};

impl Checker<'_> {
    /// `declareClosureSelf`: a closure bound to a name may call itself by
    /// that name (version 3); a parameter of the same name shadows it.
    pub fn declare_closure_self(&mut self, name: &str, closure: &ClosureExpression, body: ScopeId) {
        if !since(self.version, 3) || closure.params.iter().any(|p| p.name == name) {
            return;
        }
        let mut symbol = Symbol::new(name, SymbolKind::Binding, closure.span);
        symbol.is_closure = true;
        let id = self.scopes.add_symbol(symbol);
        self.scopes.declare(body, id);
    }
}
