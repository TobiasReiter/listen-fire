//! The walk (the `Checker` class in check.ts): one pass in source order over
//! every statement list, each list hoisted, prescanned, then checked
//! statement by statement. Each construct's rules live in its family's
//! module (`crate::families`); this file decides what is walked, in which
//! scope, and in which order.

use movement_parser::ast::{
    ArmExpression, AwaitExpression, AwaitSource, CallArg, CallStatement, CallbackSubject, ClosureExpression, CollectionOpExpression,
    CombinatorArms, CombinatorExpression, ConstructionCall, ExprSlot, ExtractCallShape, ExtractExpression, ExtractNode, ExtractStage,
    LinkTarget, MatchExpression, ShapeNode, MovementDeclaration, NodeEntry, NodeLiteral, ParamTypeRef, PathHead, PathRoot, RValue, Span,
    Statement, TraversalBlock, UntilCondition, ValueType, WriteExpression, WriteTarget,
};
use movement_parser::catalog::helpers::credential_arg_of;
use movement_parser::catalog::types::CatalogSnapshot;

use crate::diagnostic::Diagnostic;
use crate::types::field::{Ty, mixed_tuple_message, widen_tuples};
use crate::types::{TypeEnv, Typing};
use crate::types::field::{is_maybe_absent, strip_absent};
use crate::types::narrowing::{PresenceProof, negative_presence_proofs, presence_proofs};
use crate::types::position::{LocalEdge, LocalNode, Position, narrow_present, narrow_present_node};
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
    type_only: usize,
    /// Each catalog schema an instance was built from, read once.
    pub schemas: std::collections::HashMap<usize, std::rc::Rc<movement_parser::catalog::types::InstanceSchema>>,
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
    /// The record the value is, when checking it typed one (a node literal, a lazy walk).
    pub pos: Option<Position>,
}

impl<'c> Checker<'c> {
    pub fn new(catalog: &'c CatalogSnapshot, version: u32, resolves_files: bool) -> Self {
        Checker { catalog, version, resolves_files, scopes: Scopes::default(), diagnostics: Vec::new(), type_only: 0, schemas: Default::default() }
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
            if let Some(existing) = self.declare_authored(scope, Symbol::new(name, kind, span), span) {
                self.report_duplicate_declaration(name, existing, span);
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

    fn check_statement(&mut self, statement: &Statement, scope: ScopeId) {
        match statement {
            Statement::Import(import) => self.check_import(import, scope),
            Statement::Assign(assign) => {
                self.check_reserved_name(&assign.name, assign.span);
                let bound = self.check_rvalue(&assign.value, scope, Some(&assign.name));
                self.declare_binding(&assign.name, assign.span, &bound, scope);
                self.type_assigned(&assign.name, &assign.value, scope);
                if let Some(pos) = bound.pos {
                    self.set_types(scope, &assign.name, crate::types::scope_env::SymbolTypes { pos: Some(pos), ..Default::default() });
                }
            }
            Statement::Type(_) => {}
            Statement::Shape(shape) => {
                if !self.scopes.has_own(scope, &shape.name) {
                    self.declare_authored(scope, Symbol::new(&shape.name, SymbolKind::Shape, shape.span), shape.span);
                }
                self.check_shape_descriptions(&shape.root, scope);
                if let Some(base) = &shape.extends {
                    match self.scopes.resolve(scope, &base.name) {
                        Resolution::Found(_) => {}
                        failure => self.report_resolution_failure(&base.name, base.span, failure),
                    }
                }
            }
            Statement::Movement(movement) => self.check_movement(movement, scope),
            Statement::Listen(listen) => {
                let adapter = match &listen.construct {
                    Some(construct) => self.check_construction(construct, scope),
                    None => self.resolve_reference(&listen.instance, listen.span, scope).and_then(|id| self.scopes.symbol(id).adapter.clone()),
                };
                self.check_listen_config(listen, adapter.as_deref(), scope);
                let callee = self.callee_name(&listen.movement, scope);
                self.resolve_reference(&callee, listen.span, scope);
            }
            Statement::Write(write) => self.check_write(&write.write, scope),
            Statement::Match(statement) => self.check_match(&statement.r#match, scope),
            Statement::Call(call) => self.check_call(call, scope),
            Statement::Block(block) => self.check_traversal_block(&block.block, scope, None),
            Statement::Link(link) => self.check_link(&link.link, scope),
            Statement::Unlink(unlink) => {
                self.resolve_name(&unlink.from, unlink.span, scope);
                self.resolve_name(&unlink.to, unlink.span, scope);
                self.report_absent_edge_end("unlink", &unlink.from, &unlink.edge, Some(&unlink.to), unlink.span, scope);
            }
            Statement::Delete(delete) => {
                self.resolve_name(&delete.name, delete.span, scope);
            }
            Statement::Refresh(refresh) => {
                if let failure @ (Resolution::Pending | Resolution::Escaped { .. } | Resolution::Unknown) =
                    self.scopes.resolve(scope, &refresh.name)
                {
                    self.report_resolution_failure(&refresh.name, refresh.name_span, failure);
                }
            }
            Statement::If(statement) => self.check_if(statement, scope),
            Statement::Await(statement) => self.check_await(&statement.r#await, scope, None),
            Statement::Return(statement) => {
                self.check_rvalue(&statement.value, scope, None);
            }
            Statement::Combinator(statement) => self.check_combinator(&statement.combinator, scope),
            Statement::Collection(statement) => self.check_collection_op(&statement.collection, scope),
            Statement::Error(statement) => self.check_expr_slot(&statement.message, scope),
        }
    }

    /// `checkRValue`: the right-hand side of a binding or a `return`.
    pub fn check_rvalue(&mut self, value: &RValue, scope: ScopeId, name: Option<&str>) -> Bound {
        match value {
            RValue::Construct { construct } => {
                let adapter = self.check_construction(construct, scope);
                return Bound { is_closure: false, is_instance: name.is_some(), adapter, pos: None };
            }
            RValue::Call { call } => self.check_call(call, scope),
            RValue::Write { write } => self.check_write(write, scope),
            RValue::Match { r#match } => self.check_match(r#match, scope),
            RValue::Link { link } => self.check_link(link, scope),
            RValue::Extract { extract } => self.check_extract(extract, scope),
            RValue::ExtractCall { extract_call } => {
                self.check_expr_slot(&extract_call.content, scope);
                match &extract_call.shape {
                    ExtractCallShape::Named { name, span } => {
                        self.resolve_name(name, *span, scope);
                    }
                    ExtractCallShape::Inline { .. } => {}
                    ExtractCallShape::Computed { expr, .. } => self.check_expr_slot(expr, scope),
                }
                if let Some(config) = &extract_call.config {
                    self.check_expr_slot(config, scope);
                }
            }
            RValue::Block { block } => self.check_traversal_block(block, scope, name),
            RValue::Await { r#await } => self.check_await(r#await, scope, name),
            RValue::Combinator { combinator } => self.check_combinator(combinator, scope),
            RValue::Collection { collection } => self.check_collection_op(collection, scope),
            RValue::Members { .. } => {}
            RValue::InlineBlock { inline_block } => {
                let block_scope = self.scopes.open(Some(scope));
                self.check_statement_list(&inline_block.body, block_scope);
            }
            RValue::Callback { callback } => {
                match &callback.subject {
                    CallbackSubject::Inline { closure, .. } => self.check_closure(closure, scope, None),
                    // An unknown name here is MOV_CALLBACK_NOT_MOVEMENT: the listens family's.
                    CallbackSubject::Named { args, .. } => self.check_call_args(args, scope),
                }
                for arg in &callback.config {
                    self.check_expr_slot(&arg.value, scope);
                }
            }
            RValue::Closure { closure } => {
                self.check_closure(closure, scope, name);
                return Bound { is_closure: true, ..Bound::default() };
            }
            RValue::Node { node } => {
                let pos = self.check_node_literal(node, scope);
                return Bound { pos, ..Bound::default() };
            }
            RValue::Lazy { lazy } => {
                let aliases = self.check_path_head(&lazy.head, scope);
                let walk = self.type_head_walk(&lazy.head, scope);
                let pos = match &lazy.mapping {
                    Some(mapping) => {
                        let landing = self.open_landing(scope, &aliases, lazy.head.span);
                        self.type_head_aliases(landing, &walk);
                        self.check_node_literal(mapping, landing)
                    }
                    None => walk.landed,
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
    fn callee_name(&self, written: &str, scope: ScopeId) -> String {
        if matches!(self.scopes.resolve(scope, written), Resolution::Found(_)) || self.version < 3 {
            return written.to_string();
        }
        self.scopes.resolve_function(scope, written).map(|id| self.scopes.symbol(id).name.clone()).unwrap_or_else(|| written.to_string())
    }

    /// `checkExprSlot`: a bare name resolves as written; any other slot is
    /// parsed, every name it reads resolves, and it is typed, what the typing
    /// reports surfacing here.
    pub fn check_expr_slot(&mut self, slot: &ExprSlot, scope: ScopeId) {
        self.check_expr_slot_as(slot, scope, false);
    }

    /// `checkExprSlot` with `holdsValue`: the slot's value is kept as it is
    /// written (a tuple stays one), so it is typed exactly and not read.
    pub fn check_expr_slot_as(&mut self, slot: &ExprSlot, scope: ScopeId, holds_value: bool) -> SlotTyped {
        let trimmed = slot.raw.trim();
        if is_bare_ident(trimmed) {
            if is_literal_word(trimmed) {
                let ty = matches!(trimmed.to_uppercase().as_str(), "TRUE" | "FALSE").then_some(Ty::Boolean);
                return SlotTyped { expr: None, ty, may_hold: None };
            }
            self.resolve_name(trimmed, slot.span, scope);
            let bound = {
                let env = self.typing_env(scope);
                Typing::new(&env, self.version, slot.span).bare_name_type(trimmed)
            };
            let ty = if holds_value { bound } else { self.read_held_value(bound, slot.span) };
            let may_hold = self.typing_env(scope).resolve_may_hold(trimmed);
            return SlotTyped { expr: None, ty, may_hold };
        }
        let Ok(parsed) = expression_of_slot(slot) else { return SlotTyped::default() };
        let names = collect_expression_names(&parsed);
        for name in names.distinct_refs() {
            if !names.aliases.contains(name) {
                self.resolve_name(name, slot.span, scope);
            }
        }
        let (ty, may_hold, diagnostics) = {
            let env = self.typing_env(scope);
            let mut typing = Typing::new(&env, self.version, slot.span);
            let ty = if holds_value { typing.infer_exact(&parsed) } else { typing.infer(&parsed) };
            let may_hold = typing.may_hold_type(&parsed);
            (ty, may_hold, typing.diagnostics)
        };
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

    /// The config slots `checkListen` reads as expressions: every key the
    /// listener accepts, except a type reference and a `fields` list (bare
    /// property names, not names in scope).
    fn check_listen_config(&mut self, listen: &movement_parser::ast::ListenDeclaration, adapter: Option<&str>, scope: ScopeId) {
        let spec = adapter.and_then(|a| self.catalog.adapter(a));
        for arg in &listen.config {
            if let Some(spec) = spec
                && !spec.trigger_config.as_ref().is_some_and(|accepted| accepted.contains(&arg.name))
            {
                continue;
            }
            if arg.is_type == Some(true) {
                continue;
            }
            let format = spec.and_then(|s| s.trigger_config_formats.as_ref()).and_then(|f| f.0.get(&arg.name));
            if format == Some(&movement_parser::catalog::types::TriggerConfigFormat::Fields) {
                continue;
            }
            self.check_expr_slot(&arg.value, scope);
        }
    }

    /// `checkIf`: each arm's condition is checked in the arm's own scope and
    /// narrows it, conjunct by conjunct; an arm that always leaves proves its
    /// condition false below the `if` (while every arm before it leaves too);
    /// the `else` sees every arm's condition false; and from version 3, when
    /// the `else` and every arm but one leave, that arm's condition holds below.
    /// The `IS` eliminations down the chain are not modelled.
    fn check_if(&mut self, statement: &movement_parser::ast::IfStatement, scope: ScopeId) {
        let mut all_prior_terminate = true;
        let mut arm_terminates = Vec::new();
        for arm in &statement.arms {
            let arm_scope = self.scopes.open(Some(scope));
            self.check_condition_slot(&arm.condition, arm_scope, Some(arm_scope));
            self.check_statement_list(&arm.body, arm_scope);
            let terminating = terminates(&arm.body, self.version);
            arm_terminates.push(terminating);
            if all_prior_terminate && terminating {
                self.narrow_condition_negation(&arm.condition, scope, scope);
            }
            all_prior_terminate = all_prior_terminate && terminating;
        }
        let Some(else_arm) = &statement.else_arm else { return };
        let else_scope = self.scopes.open(Some(scope));
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

    /// `declarePresence`: each proven name shadowed by its narrowed self. A
    /// value binding sheds its absence; a record's landing its emptiness, or
    /// the field proven present. Blankness proofs are not modelled.
    fn declare_presence(&mut self, proofs: &[PresenceProof], scope: ScopeId, narrow_into: ScopeId) {
        for proof in proofs {
            let Resolution::Found(id) = self.scopes.resolve(scope, proof.root()) else { continue };
            let mut symbol = self.scopes.symbol(id).clone();
            match proof {
                PresenceProof::NonBlank { .. } => continue,
                PresenceProof::Field { property, .. } => {
                    let Some(narrowed) = symbol.types.pos.as_ref().and_then(|p| narrow_present(p, property)) else { continue };
                    symbol.types.pos = Some(narrowed);
                }
                PresenceProof::Binding { .. } => {
                    if symbol.types.pos.is_none() {
                        let Some(field) = symbol.types.field.as_ref().filter(|f| is_maybe_absent(Some(f))) else { continue };
                        symbol.types.field = Some(strip_absent(field).clone());
                    } else {
                        let Some(narrowed) = symbol.types.pos.as_ref().and_then(narrow_present_node) else { continue };
                        symbol.types.pos = Some(narrowed);
                    }
                }
            }
            let narrowed = self.scopes.add_symbol(symbol);
            self.scopes.declare(narrow_into, narrowed);
        }
    }

    /// `checkConditionSlot`: an `if` condition, whose `IS` tests name a
    /// subject and a type, and whose conjuncts narrow `narrow_into` in order.
    fn check_condition_slot(&mut self, slot: &ExprSlot, scope: ScopeId, narrow_into: Option<ScopeId>) {
        let Ok(condition) = condition_of_slot(slot) else { return };
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
                if let Some(hops) = &type_.hops_raw {
                    self.check_address_pins(&type_.graph, hops, slot.span, scope);
                }
            }
            MovementCondition::Expr { expr } => {
                let names = collect_expression_names(expr);
                for name in names.distinct_refs() {
                    if !names.aliases.contains(name) {
                        self.resolve_name(name, slot.span, scope);
                    }
                }
                let (ty, diagnostics) = {
                    let env = self.typing_env(scope);
                    let mut typing = Typing::new(&env, self.version, slot.span);
                    let ty = typing.infer(expr);
                    (ty, typing.diagnostics)
                };
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

    /// `checkConstruction`, the name half; the adapter it constructs, when its callee is one.
    fn check_construction(&mut self, construct: &ConstructionCall, scope: ScopeId) -> Option<String> {
        match self.scopes.resolve(scope, &construct.callee) {
            Resolution::Found(id) => {
                let callee = self.scopes.symbol(id);
                if callee.kind != SymbolKind::Adapter {
                    return None; // MOV_CONSTRUCT_NOT_ADAPTER: the systems family's.
                }
                let adapter = callee.imported_name.clone().unwrap_or_else(|| construct.callee.clone());
                let Some(credential) = self.catalog.adapter(&adapter).and_then(credential_arg_of).map(|a| a.name.clone()) else {
                    return Some(adapter);
                };
                for arg in construct.args.iter().filter(|a| a.name == credential) {
                    // An argument that is no name is MOV_CRED_WRONG_ADAPTER: the systems family's.
                    let Some(name) = movement_parser::catalog::helpers::unwrap_credential_arg(arg.value.raw.trim()) else { continue };
                    if let failure @ (Resolution::Pending | Resolution::Escaped { .. } | Resolution::Unknown) = self.scopes.resolve(scope, &name) {
                        self.report_resolution_failure(&name, arg.value.span, failure);
                    }
                }
                return Some(adapter);
            }
            Resolution::Unknown if self.catalog.adapter(&construct.callee).is_some() => {
                let credential = self.catalog.adapter(&construct.callee).and_then(credential_arg_of).map(|a| a.name.clone());
                let slot = credential.and_then(|name| construct.args.iter().find(|a| a.name == name)).map(|a| &a.value);
                self.report_unimported_adapter_construction(&construct.callee, slot, construct.span, scope);
            }
            failure => self.report_resolution_failure(&construct.callee, construct.span, failure),
        }
        None
    }

    fn check_movement(&mut self, movement: &MovementDeclaration, scope: ScopeId) {
        if !self.scopes.has_own(scope, &movement.name) {
            self.check_function_name(&movement.name, movement.span, scope);
            self.declare_authored(scope, Symbol::new(&movement.name, SymbolKind::Movement, movement.span), movement.span);
        }
        let body = self.scopes.open(Some(scope));
        for param in &movement.params {
            let Some(type_) = &param.type_ else { continue };
            self.check_param_type(type_, scope);
            self.check_param_address_pins(type_, scope);
            self.declare_param(body, &param.name, param.span, is_closure_type(type_));
            self.type_param(body, &param.name, type_, scope);
        }
        self.check_statement_list(&movement.body, body);
        if let Some(returns) = &movement.return_type {
            self.check_param_type(returns, scope);
        }
    }

    /// A parameter's type: a graph's name resolves; a value type names nothing.
    fn check_param_type(&mut self, type_: &ParamTypeRef, scope: ScopeId) {
        let ParamTypeRef::Name(reference) = type_ else { return };
        if reference.position.is_none() && reference.hops_raw.is_none() && self.version >= 3 {
            if SCALAR_TYPE_NAMES.contains(&reference.graph.as_str()) {
                return;
            }
            if let Resolution::Found(id) = self.scopes.resolve(scope, &reference.graph)
                && self.scopes.symbol(id).kind == SymbolKind::Type
            {
                return;
            }
        }
        self.resolve_name(&reference.graph, reference.span, scope);
    }

    pub fn check_closure(&mut self, closure: &ClosureExpression, scope: ScopeId, _self_name: Option<&str>) {
        let body = self.scopes.open(Some(scope));
        for param in &closure.params {
            let is_closure = param.type_.as_ref().is_some_and(is_closure_type);
            self.declare_param(body, &param.name, param.span, is_closure);
            if let Some(type_) = &param.type_ {
                self.check_param_address_pins(type_, scope);
                self.type_param(body, &param.name, type_, scope);
            }
        }
        self.check_statement_list(&closure.body, body);
    }

    fn check_call(&mut self, call: &CallStatement, scope: ScopeId) {
        if let Some(expression) = &call.expression {
            self.check_expr_slot(expression, scope);
            return;
        }
        if !crate::families::names::is_builtin_name(&call.callee) {
            let callee = self.callee_name(&call.callee, scope);
            match self.scopes.resolve(scope, &callee) {
                Resolution::Found(_) => {}
                Resolution::Unknown
                    if self.version >= 3 && self.catalog.adapter(&callee).is_none() && self.catalog.plugin(&callee).is_none() =>
                {
                    // MOV_FUNCTION_UNKNOWN: the calls family's.
                }
                failure => self.report_resolution_failure(&callee, call.span, failure),
            }
        }
        self.check_call_args(&call.args, scope);
    }

    fn check_call_args(&mut self, args: &[CallArg], scope: ScopeId) {
        for arg in args {
            match arg {
                CallArg::Expr { expr, .. } => self.check_expr_slot(expr, scope),
                CallArg::Write { write, .. } => self.check_write(write, scope),
                CallArg::Node { node, .. } => {
                    self.check_node_literal(node, scope);
                }
                CallArg::Call { call, .. } => self.check_call(call, scope),
                CallArg::Closure { closure, .. } => self.check_closure(closure, scope, None),
                CallArg::Type { .. } => {}
            }
        }
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

    fn check_write(&mut self, write: &WriteExpression, scope: ScopeId) {
        self.check_target(&write.target, scope);
        self.check_absent_target_root(&write.target, "write", scope);
        // From version 5 a `bind` is refused whole (MOV_WRITE_BIND_RETIRED, the writes family's).
        if let Some(bind) = &write.bind
            && self.version < 5
            && let failure @ (Resolution::Pending | Resolution::Escaped { .. } | Resolution::Unknown) = self.scopes.resolve(scope, &bind.name)
        {
            self.report_resolution_failure(&bind.name, bind.span, failure);
        }
        for field in &write.fields {
            self.check_expr_slot(&field.value, scope);
        }
        for spread in write.spreads.iter().flatten() {
            let root = spread.path.as_ref().map_or(spread.source.as_str(), |p| p.root.as_str());
            self.resolve_name(root, spread.span, scope);
        }
    }

    fn check_match(&mut self, matched: &MatchExpression, scope: ScopeId) {
        self.check_target(&matched.target, scope);
        self.check_absent_target_root(&matched.target, "match", scope);
        for field in &matched.fields {
            self.check_expr_slot(&field.value, scope);
        }
    }

    fn check_link(&mut self, link: &movement_parser::ast::LinkExpression, scope: ScopeId) {
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
    }

    fn check_extract(&mut self, extract: &ExtractExpression, scope: ScopeId) {
        for input in &extract.from {
            self.check_expr_slot(input, scope);
        }
        self.check_extract_stages(&extract.stages, scope);
    }

    fn check_extract_stages(&mut self, stages: &[ExtractStage], scope: ScopeId) {
        for stage in stages {
            for call in stage.through.iter().flatten() {
                self.resolve_name(&call.plugin, call.span, scope);
            }
            for field in &stage.fields {
                self.check_expr_slot(&field.description, scope);
            }
            for child in &stage.children {
                match child {
                    ExtractNode::Declared(node) => {
                        if let failure @ (Resolution::Pending | Resolution::Escaped { .. } | Resolution::Unknown) =
                            self.scopes.resolve(scope, &node.declared.type_)
                        {
                            self.report_resolution_failure(&node.declared.type_, node.declared.span, failure);
                        }
                        if let Some(description) = &node.description {
                            self.check_expr_slot(description, scope);
                        }
                        self.check_extract_stages(&node.stages, scope)
                    }
                    ExtractNode::Inline(node) => {
                        self.check_expr_slot(&node.description, scope);
                        self.check_extract_stages(&node.stages, scope)
                    }
                }
            }
        }
    }

    /// `checkShapeDescriptions`: a node declaration's words may interpolate names.
    fn check_shape_descriptions(&mut self, node: &ShapeNode, scope: ScopeId) {
        if let Some(description) = &node.description {
            self.check_expr_slot(description, scope);
        }
        for field in &node.fields {
            if let Some(description) = &field.description {
                self.check_expr_slot(description, scope);
            }
        }
        for child in &node.children {
            self.check_shape_descriptions(child, scope);
        }
    }

    /// `checkNodeLiteral`: its names resolve and its values are checked; the
    /// record it builds (a run-local node: each value entry a read, each
    /// nested node, declared edge or walk an edge), when it is a plain node.
    /// A `graph` literal is not typed here.
    fn check_node_literal(&mut self, node: &NodeLiteral, scope: ScopeId) -> Option<Position> {
        if let Some(shape) = node.graph.as_ref().and_then(|g| g.shape.as_ref()) {
            self.resolve_name(&shape.name, shape.span, scope);
        }
        let mut reads = indexmap::IndexMap::new();
        let mut edges = indexmap::IndexMap::new();
        for entry in &node.entries {
            match entry {
                NodeEntry::Value { name, value, .. } => {
                    let typed = self.check_expr_slot_as(value, scope, false);
                    reads.insert(name.clone(), typed.ty);
                }
                NodeEntry::Nodes { name, nodes, .. } => {
                    let landings: Vec<Option<Position>> = nodes.iter().map(|nested| self.check_node_literal(nested, scope)).collect();
                    edges.insert(name.clone(), LocalEdge { schema: local_edge_schema(name, None), target: Some(merge_landings(&landings, name)) });
                }
                NodeEntry::Declared { name, sequenced, .. } => {
                    edges.insert(name.clone(), LocalEdge { schema: local_edge_schema(name, sequenced.as_ref()), target: None });
                }
                NodeEntry::Traversal { name, head, mapping, .. } => {
                    let aliases = self.check_path_head(head, scope);
                    let walk = self.type_head_walk(head, scope);
                    let target = match mapping {
                        Some(mapping) => {
                            let landing = self.open_landing(scope, &aliases, head.span);
                            self.type_head_aliases(landing, &walk);
                            self.check_node_literal(mapping, landing).map(|mapped| match mapped {
                                Position::Local(local) => Position::Local(LocalNode { label: format!("a '{name}' landing"), ..local }),
                                other => other,
                            })
                        }
                        None => walk.landed,
                    };
                    edges.insert(name.clone(), LocalEdge { schema: local_edge_schema(name, None), target });
                }
            }
        }
        for spread in node.spreads.iter().flatten() {
            let root = spread.path.as_ref().map_or(spread.source.as_str(), |p| p.root.as_str());
            self.resolve_name(root, spread.span, scope);
        }
        if node.graph.is_some() {
            return None;
        }
        Some(Position::Local(LocalNode { label: "a node".to_string(), reads, edges: Some(edges), run_built: None, extracted: None }))
    }

    /// `landingScope`: the scope a walk's tail is read in, holding its hop aliases.
    fn open_landing(&mut self, scope: ScopeId, aliases: &[String], span: Span) -> ScopeId {
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
        if let Some(name) = &root_name {
            self.resolve_name(name, head.span, scope);
        }
        if let Some(PathRoot::Expression { expr }) = &head.root {
            self.check_expr_slot(expr, scope);
        }
        let root = match &head.root {
            None => String::new(),
            Some(PathRoot::Name { name }) => spell_name(name),
            Some(PathRoot::Expression { .. }) => EXPRESSION_ROOT_PROBE.to_string(),
        };
        let probe = format!("{root}{}.`__movement_head_probe__`", head.hops_raw);
        if let Ok(parsed) = expression_of_text(&probe) {
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
        }
        aliases
    }

    /// `checkTraversalBlock`: the body runs in its own scope holding the hop
    /// aliases, and what it binds is remembered as escaped once it closes.
    fn check_traversal_block(&mut self, block: &TraversalBlock, scope: ScopeId, assigned: Option<&str>) {
        let aliases = self.check_path_head(&block.head, scope);
        let walk = self.type_head_walk(&block.head, scope);
        let body = self.open_landing(scope, &aliases, block.head.span);
        self.type_head_aliases(body, &walk);
        self.check_statement_list(&block.body, body);
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
    }

    fn check_await(&mut self, awaited: &AwaitExpression, scope: ScopeId, _name: Option<&str>) {
        match &awaited.source {
            AwaitSource::Traversal { head, .. } | AwaitSource::First { head, .. } => {
                self.check_path_head(head, scope);
                self.type_head_walk_as(head, scope, true);
            }
            AwaitSource::Combinator { combinator, .. } => self.check_combinator(combinator, scope),
            AwaitSource::Sleep { .. } => {}
            AwaitSource::Until { condition, .. } => match condition {
                UntilCondition::Closure { closure } => self.check_closure(closure, scope, None),
                UntilCondition::Expr { expr } => self.check_expr_slot(expr, scope),
            },
        }
    }

    fn check_arm(&mut self, arm: &ArmExpression, scope: ScopeId) {
        match arm {
            ArmExpression::Closure { closure, .. } => self.check_closure(closure, scope, None),
            ArmExpression::Ref { name, span } => {
                let callee = self.callee_name(name, scope);
                if let failure @ (Resolution::Pending | Resolution::Escaped { .. } | Resolution::Unknown) =
                    self.scopes.resolve(scope, &callee)
                {
                    self.report_resolution_failure(&callee, *span, failure);
                }
            }
        }
    }

    fn check_combinator(&mut self, combinator: &CombinatorExpression, scope: ScopeId) {
        match &combinator.arms {
            CombinatorArms::Literal { arms, .. } | CombinatorArms::Arguments { arms, .. } => {
                for arm in arms {
                    self.check_arm(arm, scope);
                }
            }
            CombinatorArms::Dynamic { expr, .. } => self.check_expr_slot(expr, scope),
        }
        if let Some(settings) = &combinator.settings {
            self.check_expr_slot(settings, scope);
        }
    }

    fn check_collection_op(&mut self, op: &CollectionOpExpression, scope: ScopeId) {
        self.check_expr_slot(&op.source, scope);
        if let Some(init) = &op.init {
            self.check_expr_slot(init, scope);
        }
        self.check_arm(&op.r#fn, scope);
        if let Some(config) = &op.config {
            self.check_expr_slot(config, scope);
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

/// A run-local edge's promise: readable, and nothing else; sequenced when its
/// author said in what order.
fn local_edge_schema(name: &str, sequenced: Option<&movement_parser::ast::EdgeSequencing>) -> movement_parser::catalog::types::EdgeSchema {
    let mut schema = serde_json::json!({ "target": name, "readable": true });
    if let Some(sequenced) = sequenced {
        schema["sequenced"] = serde_json::to_value(sequenced).unwrap_or(serde_json::Value::Null);
    }
    serde_json::from_value(schema).unwrap_or_else(|_| crate::types::position::edge_schema_to(name))
}

/// `mergeLandings`, the typing half: the landings of a nested-node entry as
/// one type — the reads every landing wrote (untyped where one could not be
/// typed), the edges every landing has. (The disagreement it reports is the
/// nodes family's.)
fn merge_landings(landings: &[Option<Position>], name: &str) -> Position {
    let label = format!("a '{name}' landing");
    let empty = || Position::Local(LocalNode { label: label.clone(), reads: Default::default(), edges: None, run_built: None, extracted: None });
    let locals: Vec<Option<&LocalNode>> = landings.iter().map(|l| match l { Some(Position::Local(local)) => Some(local), _ => None }).collect();
    let Some(Some(first)) = locals.first() else { return empty() };
    if locals.len() == 1 {
        return Position::Local(LocalNode { label, ..(*first).clone() });
    }
    let rest = &locals[1..];
    let mut reads = indexmap::IndexMap::new();
    for (read, ty) in &first.reads {
        if !rest.iter().all(|l| l.is_some_and(|l| l.reads.contains_key(read))) {
            continue;
        }
        let all_typed = ty.is_some() && rest.iter().all(|l| l.is_some_and(|l| l.reads.get(read).is_some_and(Option::is_some)));
        reads.insert(read.clone(), if all_typed { ty.clone() } else { None });
    }
    let mut edges = indexmap::IndexMap::new();
    for (edge, local_edge) in first.edges.iter().flatten() {
        if rest.iter().all(|l| l.is_some_and(|l| l.edges.as_ref().is_some_and(|e| e.contains_key(edge)))) {
            edges.insert(edge.clone(), local_edge.clone());
        }
    }
    Position::Local(LocalNode { label, reads, edges: Some(edges), run_built: None, extracted: None })
}
