//! The walk (the `Checker` class in check.ts): one pass in source order over
//! every statement list, each list hoisted, prescanned, then checked
//! statement by statement. Each construct's rules live in its family's
//! module (`crate::families`); this file decides what is walked, in which
//! scope, and in which order.

use movement_parser::ast::{
    AwaitExpression, AwaitSource, ClosureExpression, ExprSlot, ExtractExpression,
    LinkTarget, MatchExpression, MovementDeclaration, ParamTypeRef, PathHead, PathRoot, RValue, Span,
    Statement, TraversalBlock, UntilCondition, ValueType, WriteExpression, WriteTarget,
};
use movement_parser::catalog::types::CatalogSnapshot;

use crate::diagnostic::Diagnostic;
use crate::types::field::{Ty, mixed_tuple_message, widen_tuples};
use crate::types::{TypeEnv, Typing};

use crate::types::narrowing::{negative_presence_proofs, presence_proofs};
use crate::types::position::Position;
use crate::families::names::spell_name;
use crate::scope::{Resolution, ScopeId, Scopes, Symbol, SymbolKind};
use movement_parser::lowering::condition::MovementCondition;

use crate::slots::{collect_expression_names, condition_of_slot, expression_of_slot, expression_of_text, extract_hop_aliases, is_bare_ident, is_literal_word};

/// `EXPRESSION_ROOT_PROBE`: what an expression root is spelled as in a probe.
pub(crate) const EXPRESSION_ROOT_PROBE: &str = "__movement_expression_root__";

/// The scalar names a value type may be written as (`<number>`).
const SCALAR_TYPE_NAMES: &[&str] = &["text", "number", "boolean", "date", "datetime", "file", "json"];

pub struct Checker<'c> {
    pub catalog: &'c CatalogSnapshot,
    pub version: u32,
    /// Whether file imports resolve (the snapshot carries files).
    pub resolves_files: bool,
    pub scopes: Scopes,
    pub diagnostics: Vec<Diagnostic>,
    /// Depth of type-only walks, which report nothing.
    pub type_only: usize,
    /// Each catalog schema an instance was built from, read once.
    pub schemas: std::collections::HashMap<usize, std::rc::Rc<movement_parser::catalog::types::InstanceSchema>>,
    /// What the listens family remembers across the file.
    pub listens: crate::families::listens::ListenState,
    /// The resolved file imports, and each library once checked.
    pub imports: crate::families::imports::ImportState,
    /// Checking for a move up from this version (`upgradingFrom`).
    pub upgrading_from: Option<u32>,
    /// The host's zone database.
    pub zones: &'c dyn crate::host::ZoneLookup,
    /// Each movement's parameter names, by its symbol (`ScopeSymbol.movement`).
    /// The bodies being walked, innermost last, each collecting its `return`s.
    pub return_stack: Vec<crate::families::calls::ReturnCollector>,
    /// Whether each function a call can vouch for hands a value back, by its
    /// symbol: a movement's body, or a closure bound to a name.
    pub function_returns: std::collections::HashMap<crate::scope::SymbolId, bool>,
    /// Closures that call themselves by name without declaring what they return.
    pub selves: crate::families::closures::Selves,
    /// Whether each open body may wait, and what each named function does.
    pub effects: crate::families::flow::Effects,
    /// Movement bodies walked to learn what a call to them returns and does.
    pub inference: crate::families::calls::Inference,
    /// Node declarations, as their uses read them.
    pub nodes: crate::families::nodes::NodeState,
}

/// How `checkExprSlot` reads a slot (`SlotOptions`).
#[derive(Default, Clone, Copy)]
pub struct SlotOptions<'f> {
    /// The value is kept as written (`holdsValue`): typed exactly, not read.
    pub holds_value: bool,
    /// A write's field value, whose target may advertise functions of its own.
    pub write_field: bool,
    /// A `through` stage's argument: the fields it may (and may not yet) read.
    pub fields: Option<&'f crate::families::extraction::ThroughFields>,
}

/// What `checkExprSlot` answers: the slot parsed (not for a bare name), its
/// value type, and what it may hold where its type cannot say.
#[derive(Default)]
#[allow(dead_code)] // what the families read off a slot; none reads it yet
pub struct SlotTyped {
    pub expr: Option<movement_parser::lowering::expression::Expression>,
    pub ty: Option<Ty>,
    pub may_hold: Option<Ty>,
}

/// What a right-hand side carries onto the name it is bound to.
#[derive(Default)]
pub struct Bound {
    pub is_closure: bool,
    /// A construction bound to a name is an instance, not a plain binding.
    pub is_instance: bool,
    /// For an instance: the adapter that constructed it.
    pub adapter: Option<String>,
    /// For an instance: what its construction built.
    pub instance: Option<std::rc::Rc<crate::families::systems::Instance>>,
    /// The record the value is, when checking it typed one (a node literal, a lazy walk).
    pub pos: Option<Position>,
    /// For a closure: whether calling it may wait.
    pub closure_suspends: bool,
    /// For a function's call: what it hands back.
    pub returned: Option<crate::types::position::ReturnShape>,
}

impl<'c> Checker<'c> {
    pub fn new(catalog: &'c CatalogSnapshot, options: &crate::CheckOptions<'c>, resolves_files: bool) -> Self {
        Checker {
            catalog,
            version: options.language_version,
            zones: options.zones,
            resolves_files,
            scopes: Scopes::default(),
            diagnostics: Vec::new(),
            type_only: 0,
            listens: Default::default(),
            imports: Default::default(),
            schemas: Default::default(),
            upgrading_from: options.upgrading_from,
            return_stack: Vec::new(),
            function_returns: Default::default(),
            selves: Default::default(),
            effects: Default::default(),
            inference: Default::default(),
            nodes: Default::default(),
        }
    }

    pub fn push(&mut self, diagnostic: Diagnostic) {
        if self.type_only == 0 {
            self.diagnostics.push(diagnostic);
        }
    }

    pub fn report(&mut self, code: &str, message: impl Into<String>, span: Span) {
        self.push(Diagnostic::error(code, message, span));
    }

    pub fn run(&mut self, statements: &[Statement]) -> ScopeId {
        let file = self.scopes.open(None);
        self.check_statement_list(statements, file);
        self.report_missing_listens();
        file
    }

    pub fn check_statement_list(&mut self, statements: &[Statement], scope: ScopeId) {
        self.hoist_declarations(statements, scope);
        self.prescan_pending(statements, scope);
        for statement in statements {
            self.check_statement(statement, scope);
        }
    }

    /// `hoistDeclarations`: types first, then movements and node declarations.
    fn hoist_declarations(&mut self, statements: &[Statement], scope: ScopeId) {
        for statement in statements {
            if let Statement::Type(declaration) = statement {
                let symbol = Symbol::new(&declaration.name, SymbolKind::Type, declaration.span);
                if let Some(existing) = self.declare_authored(scope, symbol, declaration.span) {
                    self.report_duplicate_declaration(&declaration.name, existing, declaration.span);
                }
                self.type_declared(scope, &declaration.name, &declaration.options);
            }
        }
        for statement in statements {
            let (name, kind, span) = match statement {
                Statement::Movement(m) => (&m.name, SymbolKind::Movement, m.span),
                Statement::Shape(s) => (&s.name, SymbolKind::Shape, s.span),
                _ => continue,
            };
            if kind == SymbolKind::Movement {
                self.check_function_name(name, span, scope);
            }
            let existing = self.declare_authored(scope, Symbol::new(name, kind, span), span);
            if let Some(existing) = existing {
                self.report_duplicate_declaration(name, existing, span);
            }
            match statement {
                Statement::Movement(movement) => {
                    self.note_movement(scope, movement);
                    self.note_movement_params(movement, scope);
                }
                Statement::Shape(shape) => {
                    self.declare_shape(scope, shape, existing.is_none());
                }
                _ => {}
            }
        }
        let mut visited = Vec::new();
        for statement in statements {
            if let Statement::Shape(shape) = statement {
                self.inherit_at_hoist(shape, scope, &mut visited);
            }
        }
    }

    /// `prescanPending`: names a later `=` or `import` in this list binds.
    fn prescan_pending(&mut self, statements: &[Statement], scope: ScopeId) {
        for statement in statements {
            let names: Vec<String> = match statement {
                Statement::Assign(a) => vec![a.name.clone()],
                Statement::Import(i) => i.names.iter().map(|n| n.alias.clone().unwrap_or_else(|| n.name.clone())).collect(),
                _ => continue,
            };
            for name in names {
                if !self.scopes.has_own(scope, &name) {
                    self.scopes.scope_mut(scope).pending.insert(name);
                }
            }
        }
    }

    pub(crate) fn check_statement(&mut self, statement: &Statement, scope: ScopeId) {
        match statement {
            Statement::Import(import) => self.check_import(import, scope),
            Statement::Assign(assign) => {
                self.check_reserved_name(&assign.name, assign.span);
                let bound = self.check_rvalue(&assign.value, scope, Some(&assign.name), assign.span);
                self.declare_binding(&assign.name, assign.span, &bound, scope);
                if bound.is_closure
                    && let Some(id) = self.scopes.scope(scope).symbols.get(&assign.name).copied()
                {
                    self.effects.closures.insert(id, bound.closure_suspends);
                }
                self.type_assigned(&assign.name, &assign.value, scope);
                if let Some(returned) = &bound.returned {
                    self.set_types(scope, &assign.name, crate::families::arg_fit::types_of_return(returned));
                }
                self.note_shape_alias(&assign.name, &assign.value, scope);
                if let Some(pos) = bound.pos {
                    self.set_types(scope, &assign.name, crate::types::scope_env::SymbolTypes { pos: Some(pos), ..Default::default() });
                }
                self.note_closure_returns(&assign.name, &assign.value, scope);
            }
            Statement::Type(_) => {}
            Statement::Shape(shape) => {
                if !self.scopes.has_own(scope, &shape.name) {
                    self.declare_authored(scope, Symbol::new(&shape.name, SymbolKind::Shape, shape.span), shape.span);
                    self.declare_shape(scope, shape, true);
                }
                self.settle_shape(shape, scope);
            }
            Statement::Movement(movement) => self.check_movement(movement, scope),
            Statement::Listen(listen) => self.check_listen(listen, scope),
            Statement::Write(write) => {
                self.check_write(&write.write, scope, None, false);
            }
            Statement::Match(statement) => {
                self.check_match(&statement.r#match, scope);
                self.check_match_rules(&statement.r#match, scope, None, false);
                self.report_unnamed_match(statement.span);
            }
            Statement::Call(call) => self.check_call_statement(call, scope),
            Statement::Block(block) => {
                self.check_traversal_block(&block.block, scope, None);
            }
            Statement::Link(link) => {
                self.check_link(&link.link, scope, None);
            }
            Statement::Unlink(unlink) => {
                self.resolve_name(&unlink.from, unlink.span, scope);
                self.resolve_name(&unlink.to, unlink.span, scope);
                self.report_absent_edge_end("unlink", &unlink.from, &unlink.edge, Some(&unlink.to), unlink.span, scope);
                self.check_bare_link_edge(&unlink.from, &unlink.edge, unlink.span, crate::families::writes::LinkVerb::Unlink, scope);
            }
            Statement::Delete(delete) => {
                self.resolve_name(&delete.name, delete.span, scope);
                self.check_delete_rules(&delete.name, delete.span, scope);
            }
            Statement::Refresh(refresh) => {
                match self.scopes.resolve(scope, &refresh.name) {
                    failure @ (Resolution::Pending | Resolution::Escaped { .. } | Resolution::Unknown) => {
                        self.report_resolution_failure(&refresh.name, refresh.name_span, failure)
                    }
                    _ => self.check_refresh_rules(&refresh.name, refresh.name_span, scope),
                }
            }
            Statement::If(statement) => self.check_if(statement, scope),
            Statement::Await(statement) => self.check_await(&statement.r#await, scope, None),
            Statement::Return(statement) => {
                self.check_rvalue(&statement.value, scope, None, statement.span);
                self.collect_return(statement.span);
            }
            Statement::Combinator(statement) => {
                self.report_combinator_form(&statement.combinator, None);
                self.check_combinator(&statement.combinator, scope);
            }
            Statement::Collection(statement) => self.check_collection_op(&statement.collection, scope),
            Statement::Error(statement) => self.check_expr_slot(&statement.message, scope),
        }
    }

    /// `checkRValue`: the right-hand side of a binding or a `return`.
    pub fn check_rvalue(&mut self, value: &RValue, scope: ScopeId, name: Option<&str>, span: Span) -> Bound {
        match value {
            RValue::Construct { construct } => {
                if let Some(call) = self.call_in_construct_position(construct, scope) {
                    let returned = self.check_call_rvalue(&call, scope, span);
                    return Bound { returned, ..Bound::default() };
                }
                let constructed = self.check_construction(construct, scope);
                let adapter = constructed.adapter.clone();
                let instance = name.map(|_| std::rc::Rc::new(self.instance_of(construct, constructed)));
                if name.is_none() {
                    self.report_construction_returned(construct, span);
                }
                return Bound { is_instance: name.is_some(), adapter, instance, ..Bound::default() };
            }
            RValue::Call { call } => {
                let returned = self.check_call_rvalue(call, scope, span);
                return Bound { returned, ..Bound::default() };
            }
            RValue::Write { write } => {
                let handle = self.check_write(write, scope, name, name.is_some());
                return Bound { pos: handle, ..Bound::default() };
            }
            RValue::Match { r#match } => {
                self.check_match(r#match, scope);
                let handle = self.check_match_rules(r#match, scope, name, false);
                let handle = if self.version >= 4 { handle.map(|h| crate::types::Position::MaybeEmpty(Box::new(h))) } else { handle };
                return Bound { pos: handle, ..Bound::default() };
            }
            RValue::Link { link } => {
                let handle = self.check_link(link, scope, name);
                return Bound { pos: handle, ..Bound::default() };
            }
            RValue::Extract { extract } => self.check_extract(extract, scope),
            RValue::ExtractCall { extract_call } => self.check_extract_call(extract_call, scope),
            RValue::Block { block } => {
                let returns = self.check_traversal_block(block, scope, name);
                if !returns {
                    self.report_block_returns_nothing(block, name);
                }
            }
            RValue::Await { r#await } => self.check_await(r#await, scope, name),
            RValue::Combinator { combinator } => {
                self.report_combinator_form(combinator, None);
                self.check_combinator(combinator, scope);
            }
            RValue::Collection { collection } => self.check_collection_op(collection, scope),
            RValue::Members { members } => {
                self.check_members(members, scope);
            }
            RValue::InlineBlock { inline_block } => {
                let block_scope = self.scopes.open(Some(scope));
                self.check_statement_list(&inline_block.body, block_scope);
                self.report_inline_block_retired(inline_block);
            }
            RValue::Callback { callback } => self.check_callback(callback, scope),
            RValue::Closure { closure } => {
                let label = name.map_or_else(|| "this closure".to_string(), |n| format!("the closure '{n}'"));
                let (_, suspends) = self.check_closure_walked(closure, scope, name, &label, 0);
                return Bound { is_closure: true, closure_suspends: suspends, ..Bound::default() };
            }
            RValue::Node { node } => {
                let pos = self.check_node_literal(node, scope);
                return Bound { pos, ..Bound::default() };
            }
            RValue::Lazy { lazy } => {
                let aliases = self.check_path_head(&lazy.head, scope);
                let walk = self.walk_head(&lazy.head, scope, false);
                let pos = match &lazy.mapping {
                    Some(mapping) => {
                        let landing = self.open_landing(scope, &aliases, lazy.head.span);
                        self.type_hop_aliases(landing, &aliases, walk.as_ref());
                        self.check_node_literal(mapping, landing)
                    }
                    None => walk.and_then(|w| w.landed),
                };
                return Bound { pos, ..Bound::default() };
            }
            RValue::Expr { expr } => {
                self.check_expr_slot_as(expr, scope, name.is_some());
            }
        }
        Bound::default()
    }

    /// The name a call or a listen fires: from version 3 a function written
    /// in another letter case is the same function.
    pub fn callee_name(&self, written: &str, scope: ScopeId) -> String {
        if matches!(self.scopes.resolve(scope, written), Resolution::Found(_)) || self.version < 3 {
            return written.to_string();
        }
        self.scopes.resolve_function(scope, written).map(|id| self.scopes.symbol(id).name.clone()).unwrap_or_else(|| written.to_string())
    }

    /// `checkExprSlot`: a bare name resolves as written; any other slot is
    /// parsed, every name it reads resolves, and it is typed, what the typing
    /// reports surfacing here.
    pub fn check_expr_slot(&mut self, slot: &ExprSlot, scope: ScopeId) {
        self.check_expr_slot_with(slot, scope, SlotOptions::default());
    }

    /// `checkExprSlot` with `holdsValue`: the slot's value is kept as it is
    /// written (a tuple stays one), so it is typed exactly and not read.
    pub fn check_expr_slot_as(&mut self, slot: &ExprSlot, scope: ScopeId, holds_value: bool) -> SlotTyped {
        self.check_expr_slot_with(slot, scope, SlotOptions { holds_value, ..SlotOptions::default() })
    }

    /// `checkExprSlot` for a write's field value, whose target may advertise
    /// functions of its own.
    pub fn check_expr_slot_in(&mut self, slot: &ExprSlot, scope: ScopeId, write_field: bool) {
        self.check_expr_slot_with(slot, scope, SlotOptions { write_field, ..SlotOptions::default() });
    }

    /// `checkExprSlot`: a bare name resolves as written; any other slot has
    /// its nested calls hoisted out, is parsed, every name it reads resolves,
    /// and it is typed, what the typing reports surfacing here.
    pub fn check_expr_slot_with(&mut self, slot: &ExprSlot, scope: ScopeId, options: SlotOptions) -> SlotTyped {
        let SlotOptions { holds_value, write_field, fields } = options;
        let trimmed = slot.raw.trim();
        if is_bare_ident(trimmed) {
            if is_literal_word(trimmed) {
                let ty = matches!(trimmed.to_uppercase().as_str(), "TRUE" | "FALSE").then_some(Ty::Boolean);
                return SlotTyped { expr: None, ty, may_hold: None };
            }
            self.resolve_name_with_fields(trimmed, slot.span, scope, fields);
            let bound = {
                let env = self.typing_env(scope);
                Typing::new(&env, self.version, slot.span).bare_name_type(trimmed)
            };
            let ty = if holds_value { bound } else { self.read_held_value(bound, slot.span) };
            let may_hold = self.typing_env(scope).resolve_may_hold(trimmed);
            return SlotTyped { expr: None, ty, may_hold };
        }
        if let Some(hoisted) = self.hoist_nested_calls(slot, scope) {
            return self.check_expr_slot_with(&hoisted, scope, options);
        }
        let parsed = match expression_of_slot(slot) {
            Ok(parsed) => parsed,
            Err(error) => {
                self.report_slot_error(&error, slot);
                return SlotTyped::default();
            }
        };
        let names = collect_expression_names(&parsed);
        for name in names.distinct_refs() {
            if !names.aliases.contains(name) {
                self.resolve_name_with_fields(name, slot.span, scope, fields);
            }
        }
        self.check_slot_expression(slot, scope, write_field);
        self.report_block_read_back(&names, scope, slot.span);
        let (ty, may_hold, diagnostics, watchable) = {
            let env = self.typing_env(scope);
            let mut typing = Typing::new(&env, self.version, slot.span);
            let ty = if holds_value { typing.infer_exact(&parsed) } else { typing.infer(&parsed) };
            let may_hold = typing.may_hold_type(&parsed);
            (ty, may_hold, typing.diagnostics, typing.watchable_reads)
        };
        self.effects.note_watchable_reads(&watchable);
        for diagnostic in diagnostics {
            self.push(diagnostic);
        }
        SlotTyped { expr: Some(parsed), ty, may_hold }
    }

    /// `readHeldValue`: a bare name's value read — a tuple as the list it
    /// widens to, refused where it holds records and values both.
    fn read_held_value(&mut self, ty: Option<Ty>, span: Span) -> Option<Ty> {
        if let Some(mixed) = mixed_tuple_message(ty.as_ref()) {
            self.report(crate::codes::LIST_MIXED, mixed, span);
        }
        widen_tuples(ty, self.version)
    }

    /// `checkIf`: each arm's condition is checked in the arm's own scope and
    /// narrows it, conjunct by conjunct; an arm that always leaves proves its
    /// condition false below the `if` (while every arm before it leaves too);
    /// the `else` sees every arm's condition false; and from version 3, when
    /// the `else` and every arm but one leave, that arm's condition holds below.
    /// A failed bare `IS` test rules its variant out of the arms below it.
    fn check_if(&mut self, statement: &movement_parser::ast::IfStatement, scope: ScopeId) {
        // A failed bare `IS` rules its variant out of every later arm and the `else`.
        let mut ruled_out = crate::families::walks::RuledOut::default();
        let mut all_prior_terminate = true;
        let mut arm_terminates = Vec::new();
        for arm in &statement.arms {
            let arm_scope = self.scopes.open(Some(scope));
            self.declare_eliminated(&ruled_out, scope, arm_scope);
            self.check_condition_slot(&arm.condition, arm_scope, Some(arm_scope));
            self.check_statement_list(&arm.body, arm_scope);
            let terminating = terminates(&arm.body, self.version);
            arm_terminates.push(terminating);
            if all_prior_terminate && terminating {
                self.narrow_condition_negation(&arm.condition, scope, scope);
            }
            all_prior_terminate = all_prior_terminate && terminating;
            if let Ok(condition) = condition_of_slot(&arm.condition) {
                self.collect_is_elimination(&condition, scope, &mut ruled_out);
            }
        }
        let Some(else_arm) = &statement.else_arm else { return };
        let else_scope = self.scopes.open(Some(scope));
        self.declare_eliminated(&ruled_out, scope, else_scope);
        for arm in &statement.arms {
            self.narrow_condition_negation(&arm.condition, else_scope, else_scope);
        }
        self.check_statement_list(&else_arm.body, else_scope);
        let falls_through: Vec<usize> = arm_terminates.iter().enumerate().filter(|(_, leaves)| !**leaves).map(|(i, _)| i).collect();
        if self.version >= 3 && falls_through.len() == 1 && terminates(&else_arm.body, self.version) {
            self.narrow_condition_holds(&statement.arms[falls_through[0]].condition, scope);
        }
    }

    /// `narrowConditionNegation`: what a condition's falsity proves present.
    /// A conjunction's falsity proves none of its conjuncts false.
    fn narrow_condition_negation(&mut self, slot: &ExprSlot, scope: ScopeId, narrow_into: ScopeId) {
        let Ok(MovementCondition::Expr { expr }) = condition_of_slot(slot) else { return };
        let proofs = {
            let env = self.typing_env(scope);
            let mut typing = Typing::new(&env, self.version, slot.span);
            negative_presence_proofs(&expr, &mut |o| typing.infer(o))
        };
        self.declare_presence(&proofs, scope, narrow_into);
    }

    /// `narrowConditionHolds`: each conjunct of the one arm that falls through.
    fn narrow_condition_holds(&mut self, slot: &ExprSlot, scope: ScopeId) {
        let Ok(condition) = condition_of_slot(slot) else { return };
        let conjuncts = match condition {
            MovementCondition::And { conjuncts } => conjuncts,
            other => vec![other],
        };
        for conjunct in conjuncts {
            if let MovementCondition::Expr { expr } = conjunct {
                self.narrow_presence(&expr, scope, scope, slot.span);
            }
        }
    }

    /// `narrowPresence`: what a condition's truth proves present, declared into `narrow_into`.
    fn narrow_presence(&mut self, expr: &movement_parser::lowering::expression::Expression, scope: ScopeId, narrow_into: ScopeId, span: Span) {
        let proofs = {
            let env = self.typing_env(scope);
            let mut typing = Typing::new(&env, self.version, span);
            presence_proofs(expr, &mut |o| typing.infer(o))
        };
        self.declare_presence(&proofs, scope, narrow_into);
    }

    /// `checkConditionSlot`: an `if` condition, whose `IS` tests name a
    /// subject and a type, and whose conjuncts narrow `narrow_into` in order.
    fn check_condition_slot(&mut self, slot: &ExprSlot, scope: ScopeId, narrow_into: Option<ScopeId>) {
        if let Some(hoisted) = self.hoist_nested_calls(slot, scope) {
            return self.check_condition_slot(&hoisted, scope, narrow_into);
        }
        let condition = match condition_of_slot(slot) {
            Ok(condition) => condition,
            Err(error) => return self.report_slot_error(&error, slot),
        };
        self.check_slot_expression(slot, scope, false);
        self.check_condition(&condition, slot, scope, narrow_into);
    }

    fn check_condition(&mut self, condition: &MovementCondition, slot: &ExprSlot, scope: ScopeId, narrow_into: Option<ScopeId>) {
        match condition {
            MovementCondition::And { conjuncts } => conjuncts.iter().for_each(|c| self.check_condition(c, slot, scope, narrow_into)),
            MovementCondition::IsTest { subject_raw, type_ } => {
                let subject = subject_raw.trim();
                if is_bare_ident(subject) {
                    self.resolve_name(subject, slot.span, scope);
                } else {
                    self.check_expr_slot(&ExprSlot::plain(subject_raw.clone(), slot.span), scope);
                }
                self.resolve_name(&type_.graph, slot.span, scope);
                self.check_is_test(subject_raw, type_, slot.span, scope, narrow_into);
            }
            MovementCondition::Expr { expr } => {
                let names = collect_expression_names(expr);
                for name in names.distinct_refs() {
                    if !names.aliases.contains(name) {
                        self.resolve_name(name, slot.span, scope);
                    }
                }
                let (ty, diagnostics, watchable) = {
                    let env = self.typing_env(scope);
                    let mut typing = Typing::new(&env, self.version, slot.span);
                    let ty = typing.infer(expr);
                    (ty, typing.diagnostics, typing.watchable_reads)
                };
                self.effects.note_watchable_reads(&watchable);
                for diagnostic in diagnostics {
                    self.push(diagnostic);
                }
                // Gating on a structured value is always true, never a decision.
                if let Some(message) = crate::families::values::json_opaque_message(ty.as_ref(), "used as a condition") {
                    self.report(crate::codes::JSON_OPAQUE, message, slot.span);
                }
                if self.version >= 5 && crate::types::field::may_be_closure(ty.as_ref()) {
                    self.report(
                        crate::codes::CLOSURE_NOT_DATA,
                        crate::types::field::closure_not_data_message("a value used as a condition is"),
                        slot.span,
                    );
                }
                if let Some(narrow_into) = narrow_into {
                    self.narrow_presence(expr, scope, narrow_into, slot.span);
                }
            }
        }
    }

    fn check_movement(&mut self, movement: &MovementDeclaration, scope: ScopeId) {
        if !self.scopes.has_own(scope, &movement.name) {
            self.check_function_name(&movement.name, movement.span, scope);
            self.declare_authored(scope, Symbol::new(&movement.name, SymbolKind::Movement, movement.span), movement.span);
            self.note_movement(scope, movement);
            self.note_movement_params(movement, scope);
        }
        let body = self.scopes.open(Some(scope));
        for param in &movement.params {
            let Some(type_) = &param.type_ else {
                self.report_param_needs_type(&param.name, param.span, &format!("'{}'", movement.name));
                continue;
            };
            if let ParamTypeRef::Value(value) = type_
                && self.version >= 3
            {
                self.report_value_type(value, scope);
            }
            let graph = self.check_param_type(type_, scope);
            if let (ParamTypeRef::Name(reference), false) = (type_, crate::families::systems::is_value_param_type(self, type_, scope)) {
                self.check_param_source(reference, graph);
                self.note_dispatchable(movement, reference, graph, scope);
            }
            self.report_param_position(type_, scope);
            self.declare_param(body, &param.name, param.span, is_closure_type(type_));
            self.type_param(body, &param.name, type_, scope);
        }
        self.open_effect_frame();
        let returns = self.check_body(&movement.body, body, format!("'{}'", movement.name));
        let row = self.close_effect_frame();
        if let Some(returns) = &movement.return_type {
            self.check_param_type(returns, scope);
        }
        if let Some(id) = self.scopes.scope(scope).symbols.get(&movement.name).copied()
            && self.scopes.symbol(id).kind == SymbolKind::Movement
        {
            self.record_movement_row(id, row);
            self.report_movement_cycle(id, movement, !returns.is_empty());
        }
    }

    /// A parameter's type: a graph's name resolves; a value type names nothing.
    /// What the graph's name resolved to.
    pub(crate) fn check_param_type(&mut self, type_: &ParamTypeRef, scope: ScopeId) -> Option<crate::scope::SymbolId> {
        let ParamTypeRef::Name(reference) = type_ else { return None };
        if reference.position.is_none() && reference.hops_raw.is_none() && self.version >= 3 {
            if SCALAR_TYPE_NAMES.contains(&reference.graph.as_str()) {
                return None;
            }
            if let Resolution::Found(id) = self.scopes.resolve(scope, &reference.graph)
                && self.scopes.symbol(id).kind == SymbolKind::Type
            {
                return None;
            }
        }
        self.resolve_name(&reference.graph, reference.span, scope)
    }

    /// A closure whose caller supplies its parameters' types (a call's
    /// argument): none of them needs one written.
    pub fn check_closure(&mut self, closure: &ClosureExpression, scope: ScopeId, self_name: Option<&str>) -> Vec<Span> {
        self.check_closure_as(closure, scope, self_name, "", usize::MAX)
    }

    /// `checkClosure`: `label` says what the closure is, and the caller
    /// supplies the types of its first `supplied` parameters. What its
    /// body returns, where.
    pub fn check_closure_as(&mut self, closure: &ClosureExpression, scope: ScopeId, self_name: Option<&str>, label: &str, supplied: usize) -> Vec<Span> {
        self.check_closure_walked(closure, scope, self_name, label, supplied).0
    }

    /// `checkClosure`, with whether calling the closure may wait: its body
    /// is its own function, so what it does is not the writer's.
    pub fn check_closure_walked(&mut self, closure: &ClosureExpression, scope: ScopeId, self_name: Option<&str>, label: &str, supplied: usize) -> (Vec<Span>, bool) {
        self.check_closure_supplied(closure, scope, self_name, label, supplied, &[])
    }

    /// `checkClosure` with `suppliedParams`: the caller supplies the first
    /// `supplied` parameters, and `types` says what it hands each, where the
    /// closure leaves the type out (contextual typing).
    pub fn check_closure_supplied(
        &mut self,
        closure: &ClosureExpression,
        scope: ScopeId,
        self_name: Option<&str>,
        label: &str,
        supplied: usize,
        types: &[crate::types::position::PlaneType],
    ) -> (Vec<Span>, bool) {
        let body = self.scopes.open(Some(scope));
        for (index, param) in closure.params.iter().enumerate() {
            if param.type_.is_none() && index >= supplied {
                self.report_param_needs_type(&param.name, param.span, label);
            }
            if let Some(ParamTypeRef::Value(value)) = &param.type_ {
                self.report_value_type(value, scope);
            }
            let is_closure = param.type_.as_ref().is_some_and(is_closure_type);
            self.declare_param(body, &param.name, param.span, is_closure);
            if let Some(type_) = &param.type_ {
                self.report_param_position(type_, scope);
                self.type_param(body, &param.name, type_, scope);
            } else if let Some(given) = types.get(index) {
                let types = crate::types::scope_env::SymbolTypes { pos: given.pos.as_deref().cloned(), field: given.field.clone(), ..Default::default() };
                self.set_types(body, &param.name, types);
            }
        }
        let own = self_name.and_then(|name| self.declare_closure_self(name, closure, body));
        self.open_effect_frame();
        let returns = self.check_body(&closure.body, body, label.to_string());
        let suspends = self.close_effect_frame();
        if let Some(own) = own {
            self.close_closure_self(own, returns.is_empty());
        }
        (returns, suspends)
    }

    fn check_target(&mut self, target: &WriteTarget, scope: ScopeId) {
        match target {
            WriteTarget::Linked { path, .. } => {
                self.check_path_head(path, scope);
            }
            WriteTarget::Tuple { paths, .. } => {
                for path in paths {
                    self.check_path_head(path, scope);
                }
            }
            WriteTarget::Position { root, span } => match root {
                PathRoot::Name { name } => {
                    self.resolve_name(name, *span, scope);
                }
                PathRoot::Expression { expr } => self.check_expr_slot(expr, scope),
            },
        }
    }

    pub(crate) fn check_write(&mut self, write: &WriteExpression, scope: ScopeId, binding: Option<&str>, is_bound: bool) -> Option<crate::types::Position> {
        self.check_target(&write.target, scope);
        // From version 5 a `bind` is refused whole (MOV_WRITE_BIND_RETIRED, the writes family's).
        if let Some(bind) = &write.bind
            && self.version < 5
            && let failure @ (Resolution::Pending | Resolution::Escaped { .. } | Resolution::Unknown) = self.scopes.resolve(scope, &bind.name)
        {
            self.report_resolution_failure(&bind.name, bind.span, failure);
        }
        for field in &write.fields {
            self.check_expr_slot_in(&field.value, scope, true);
        }
        for spread in write.spreads.iter().flatten() {
            let root = spread.path.as_ref().map_or(spread.source.as_str(), |p| p.root.as_str());
            self.resolve_name(root, spread.span, scope);
        }
        self.check_write_rules(write, scope, binding, is_bound)
    }

    fn check_match(&mut self, matched: &MatchExpression, scope: ScopeId) {
        self.check_target(&matched.target, scope);
        for field in &matched.fields {
            self.check_expr_slot(&field.value, scope);
        }
    }

    fn check_link(&mut self, link: &movement_parser::ast::LinkExpression, scope: ScopeId, binding: Option<&str>) -> Option<crate::types::Position> {
        self.resolve_name(&link.from, link.span, scope);
        let to = match &link.to {
            LinkTarget::Handle { name } => Some(name.as_str()),
            LinkTarget::Match { .. } => None,
        };
        self.report_absent_edge_end("link", &link.from, &link.edge, to, link.span, scope);
        match &link.to {
            LinkTarget::Handle { name } => {
                self.resolve_name(name, link.span, scope);
            }
            LinkTarget::Match { r#match, .. } => self.check_match(r#match, scope),
        }
        self.check_link_rules(link, scope, binding)
    }

    fn check_extract(&mut self, extract: &ExtractExpression, scope: ScopeId) {
        self.check_ai_tier(extract.tier.as_deref(), extract.span);
        for input in &extract.from {
            self.check_expr_slot(input, scope);
        }
        self.check_extract_stages(&extract.stages, scope, &Default::default(), None);
        self.resolve_extract_annotations(&extract.stages, scope);
    }

    /// `landingScope`: the scope a walk's tail is read in, holding its hop aliases.
    pub(crate) fn open_landing(&mut self, scope: ScopeId, aliases: &[String], span: Span) -> ScopeId {
        let landing = self.scopes.open(Some(scope));
        for alias in aliases {
            self.declare_authored(landing, Symbol::new(alias, SymbolKind::Alias, span), span);
        }
        landing
    }

    /// `checkPathHead`, the name half: its root and every name its hops read.
    pub fn check_path_head(&mut self, head: &PathHead, scope: ScopeId) -> Vec<String> {
        let aliases = extract_hop_aliases(&head.hops_raw);
        let root_name = match &head.root {
            Some(PathRoot::Name { name }) => Some(name.clone()),
            _ => None,
        };
        let root_symbol = match &root_name {
            Some(name) => self.resolve_name(name, head.span, scope),
            None => None,
        };
        if let Some(PathRoot::Expression { expr }) = &head.root {
            self.check_expr_slot(expr, scope);
        }
        let root = match &head.root {
            None => String::new(),
            Some(PathRoot::Name { name }) => spell_name(name),
            Some(PathRoot::Expression { .. }) => EXPRESSION_ROOT_PROBE.to_string(),
        };
        let probe = format!("{root}{}.`__movement_head_probe__`", head.hops_raw);
        let parsed = expression_of_text(&probe);
        if let Err(error) = &parsed {
            self.report_head_parse_error(error, head.span);
        }
        if let Ok(parsed) = parsed {
            let names = collect_expression_names(&parsed);
            for name in names.distinct_refs() {
                let local = aliases.iter().any(|a| a == name)
                    || names.aliases.contains(name)
                    || root_name.as_deref() == Some(name)
                    || name == EXPRESSION_ROOT_PROBE;
                if !local {
                    self.resolve_name(name, head.span, scope);
                }
            }
            self.report_block_read_back(&names, scope, head.span);
            self.check_head_expression(&probe, head, scope);
        }
        self.check_head_resources(head, &probe, root_name.as_deref(), scope);
        if let Some(name) = &root_name {
            self.check_path_root_constructed(name, root_symbol, &head.hops_raw, head.span);
        }
        self.report_head_not_a_position(head, scope);
        aliases
    }

    /// `checkTraversalBlock`: the body runs in its own scope holding the hop
    /// aliases, and what it binds is remembered as escaped once it closes.
    /// Whether the block's body hands a value back.
    fn check_traversal_block(&mut self, block: &TraversalBlock, scope: ScopeId, assigned: Option<&str>) -> bool {
        let aliases = self.check_path_head(&block.head, scope);
        let walk = self.walk_head(&block.head, scope, false);
        let body = self.open_landing(scope, &aliases, block.head.span);
        self.type_hop_aliases(body, &aliases, walk.as_ref());
        let what = assigned.map_or_else(|| "this block".to_string(), |name| format!("the block bound to '{name}'"));
        let returns = self.check_body(&block.body, body, what);
        let bound: Vec<String> = self
            .scopes
            .scope(body)
            .symbols
            .iter()
            .filter(|(_, id)| self.scopes.symbol(**id).kind != SymbolKind::Alias)
            .map(|(name, _)| name.clone())
            .collect();
        for name in bound {
            self.scopes.scope_mut(scope).escaped.insert(name, assigned.map(str::to_string));
        }
        let inner: Vec<(String, Option<String>)> =
            self.scopes.scope(body).escaped.iter().map(|(n, b)| (n.clone(), b.clone())).collect();
        for (name, block_name) in inner {
            self.scopes.scope_mut(scope).escaped.entry(name).or_insert(block_name);
        }
        !returns.is_empty()
    }

    fn check_await(&mut self, awaited: &AwaitExpression, scope: ScopeId, _name: Option<&str>) {
        self.flag_suspend();
        match &awaited.source {
            AwaitSource::Traversal { head, span } => {
                self.check_awaited_head(head, Some(*span));
                self.check_path_head(head, scope);
                let walk = self.walk_head(head, scope, true);
                self.check_awaitable(head, walk.as_ref());
            }
            AwaitSource::First { head, .. } => {
                self.check_awaited_head(head, None);
                self.check_path_head(head, scope);
                let walk = self.walk_head(head, scope, true);
                self.check_awaitable(head, walk.as_ref());
            }
            AwaitSource::Combinator { combinator, .. } => {
                self.report_combinator_form(combinator, Some(awaited.span));
                self.check_combinator(combinator, scope);
            }
            AwaitSource::Sleep { duration, .. } => self.check_sleep_duration(duration),
            AwaitSource::Until { condition, every, .. } => {
                if let Some(every) = every {
                    self.check_until_cadence(every);
                }
                let condition_span = match condition {
                    UntilCondition::Closure { closure } => closure.span,
                    UntilCondition::Expr { expr } => expr.span,
                };
                self.check_until_watching(condition_span, |this| match condition {
                    UntilCondition::Closure { closure } => {
                        this.check_until_params(closure);
                        let impure = this.check_until_purity(&closure.body);
                        let (_, suspends) = this.check_closure_walked(closure, scope, None, "this 'until' condition", 0);
                        this.absorb_suspend(suspends);
                        if suspends && !impure {
                            this.refuse_unresumable_wait("this 'until' condition", closure.span);
                        }
                    }
                    UntilCondition::Expr { expr } => {
                        this.check_expr_slot(expr, scope);
                        if let Resolution::Found(id) = this.scopes.resolve(scope, expr.raw.trim()) {
                            let suspends = this.closure_suspends(id);
                            this.absorb_suspend(suspends);
                        }
                    }
                });
            }
        }
    }
}

/// `terminates` (checker/flow.ts): every path through the list leaves it —
/// an `ERROR`, from version 3 a `return`, or an `if` whose every arm and
/// `else` leave.
fn terminates(statements: &[Statement], version: u32) -> bool {
    statements.iter().any(|statement| match statement {
        Statement::Error(_) => true,
        Statement::Return(_) => version >= 3,
        Statement::If(statement) => {
            statement.else_arm.as_ref().is_some_and(|e| terminates(&e.body, version)) && statement.arms.iter().all(|arm| terminates(&arm.body, version))
        }
        _ => false,
    })
}

fn is_closure_type(type_: &ParamTypeRef) -> bool {
    matches!(type_, ParamTypeRef::Value(ValueType::Closure { .. }))
}
