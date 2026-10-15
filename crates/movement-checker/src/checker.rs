//! The walk (the `Checker` class in check.ts): one pass in source order over
//! every statement list, each list hoisted, prescanned, then checked
//! statement by statement. Each construct's rules live in its family's
//! module (`crate::families`); this file decides what is walked, in which
//! scope, and in which order.

use movement_parser::ast::{
    ArmExpression, AwaitExpression, AwaitSource, CallArg, CallStatement, ClosureExpression, CollectionOpExpression,
    CombinatorArms, CombinatorExpression, ExprSlot, ExtractCallShape, ExtractExpression, ExtractNode, ExtractStage,
    LinkTarget, MatchExpression, ShapeNode, MovementDeclaration, NodeEntry, NodeLiteral, ParamTypeRef, PathHead, PathRoot, RValue, Span,
    Statement, TraversalBlock, UntilCondition, ValueType, WriteExpression, WriteTarget,
};
use movement_parser::catalog::types::CatalogSnapshot;

use crate::diagnostic::Diagnostic;
use crate::families::names::spell_name;
use crate::scope::{Resolution, ScopeId, Scopes, Symbol, SymbolKind};
use movement_parser::lowering::condition::MovementCondition;

use crate::slots::{collect_expression_names, condition_of_slot, expression_of_slot, expression_of_text, extract_hop_aliases, is_bare_ident, is_literal_word};

/// `EXPRESSION_ROOT_PROBE`: what an expression root is spelled as in a probe.
const EXPRESSION_ROOT_PROBE: &str = "__movement_expression_root__";

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
    /// What the listens family remembers across the file.
    pub listens: crate::families::listens::ListenState,
    /// The resolved file imports, and each library once checked.
    pub imports: crate::families::imports::ImportState,
    /// Checking for a move up from this version (`upgradingFrom`).
    pub upgrading_from: Option<u32>,
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
    /// The record a write, a match or a link hands back.
    pub handle: Option<crate::types::Position>,
}

impl<'c> Checker<'c> {
    pub fn new(catalog: &'c CatalogSnapshot, version: u32, resolves_files: bool) -> Self {
        Checker {
            catalog,
            version,
            resolves_files,
            scopes: Scopes::default(),
            diagnostics: Vec::new(),
            type_only: 0,
            listens: Default::default(),
            imports: Default::default(),
            schemas: Default::default(),
            upgrading_from: None,
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
            if let Some(existing) = self.declare_authored(scope, Symbol::new(name, kind, span), span) {
                self.report_duplicate_declaration(name, existing, span);
            }
            match statement {
                Statement::Movement(movement) => self.note_movement(scope, movement),
                Statement::Shape(shape) => self.note_shape(scope, shape),
                _ => {}
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
                if let Some(handle) = bound.handle {
                    self.set_types(scope, &assign.name, crate::types::scope_env::SymbolTypes { pos: Some(handle), ..Default::default() });
                }
            }
            Statement::Type(_) => {}
            Statement::Shape(shape) => {
                if !self.scopes.has_own(scope, &shape.name) {
                    self.declare_authored(scope, Symbol::new(&shape.name, SymbolKind::Shape, shape.span), shape.span);
                    self.note_shape(scope, shape);
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
            Statement::Listen(listen) => self.check_listen(listen, scope),
            Statement::Write(write) => {
                self.check_write(&write.write, scope, None, false);
            }
            Statement::Match(statement) => {
                self.check_match(&statement.r#match, scope);
                self.check_match_rules(&statement.r#match, scope, None, false);
                self.report_unnamed_match(statement.span);
            }
            Statement::Call(call) => self.check_call(call, scope),
            Statement::Block(block) => self.check_traversal_block(&block.block, scope, None),
            Statement::Link(link) => {
                self.check_link(&link.link, scope, None);
            }
            Statement::Unlink(unlink) => {
                self.resolve_name(&unlink.from, unlink.span, scope);
                self.resolve_name(&unlink.to, unlink.span, scope);
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
            Statement::If(statement) => {
                // A failed bare `IS` rules its variant out of every later arm and the `else`.
                let mut ruled_out = crate::families::walks::RuledOut::default();
                let mut all_prior_leave = true;
                let mut arms_leave = Vec::new();
                for arm in &statement.arms {
                    let arm_scope = self.scopes.open(Some(scope));
                    self.declare_eliminated(&ruled_out, scope, arm_scope);
                    self.check_condition_slot(&arm.condition, arm_scope, Some(arm_scope));
                    self.narrow_arm(&arm.condition, scope, arm_scope);
                    self.check_statement_list(&arm.body, arm_scope);
                    let leaves = terminates(&arm.body, self.version);
                    arms_leave.push(leaves);
                    if all_prior_leave && leaves {
                        self.narrow_fails(&arm.condition, scope, scope);
                    }
                    all_prior_leave = all_prior_leave && leaves;
                    if let Ok(condition) = condition_of_slot(&arm.condition) {
                        self.collect_is_elimination(&condition, scope, &mut ruled_out);
                    }
                }
                if let Some(else_arm) = &statement.else_arm {
                    let else_scope = self.scopes.open(Some(scope));
                    self.declare_eliminated(&ruled_out, scope, else_scope);
                    for arm in &statement.arms {
                        self.narrow_fails(&arm.condition, else_scope, else_scope);
                    }
                    self.check_statement_list(&else_arm.body, else_scope);
                    let falls_through: Vec<usize> = arms_leave.iter().enumerate().filter(|(_, leaves)| !**leaves).map(|(i, _)| i).collect();
                    if self.version >= 3 && falls_through.len() == 1 && terminates(&else_arm.body, self.version) {
                        self.narrow_holds_slot(&statement.arms[falls_through[0]].condition, scope, scope);
                    }
                }
            }
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
                if let Some(call) = self.call_in_construct_position(construct, scope) {
                    self.check_call(&call, scope);
                    return Bound::default();
                }
                let constructed = self.check_construction(construct, scope);
                let adapter = constructed.adapter.clone();
                let instance = name.map(|_| std::rc::Rc::new(self.instance_of(construct, constructed)));
                return Bound { is_closure: false, is_instance: name.is_some(), adapter, instance, handle: None };
            }
            RValue::Call { call } => self.check_call(call, scope),
            RValue::Write { write } => {
                let handle = self.check_write(write, scope, name, name.is_some());
                return Bound { handle, ..Bound::default() };
            }
            RValue::Match { r#match } => {
                self.check_match(r#match, scope);
                let handle = self.check_match_rules(r#match, scope, name, false);
                let handle = if self.version >= 4 { handle.map(|h| crate::types::Position::MaybeEmpty(Box::new(h))) } else { handle };
                return Bound { handle, ..Bound::default() };
            }
            RValue::Link { link } => {
                let handle = self.check_link(link, scope, name);
                return Bound { handle, ..Bound::default() };
            }
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
            RValue::Callback { callback } => self.check_callback(callback, scope),
            RValue::Closure { closure } => {
                self.check_closure(closure, scope, name);
                return Bound { is_closure: true, ..Bound::default() };
            }
            RValue::Node { node } => self.check_node_literal(node, scope),
            RValue::Lazy { lazy } => {
                let aliases = self.check_path_head(&lazy.head, scope);
                let walk = self.walk_head(&lazy.head, scope, false);
                if let Some(mapping) = &lazy.mapping {
                    let landing = self.open_landing(scope, &aliases, lazy.head.span);
                    self.type_hop_aliases(landing, &aliases, walk.as_ref());
                    self.check_node_literal(mapping, landing);
                }
            }
            RValue::Expr { expr } => self.check_expr_slot(expr, scope),
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

    /// `checkExprSlot`, the name half: a bare name resolves as written; any
    /// other slot is parsed and every name it reads resolves.
    pub fn check_expr_slot(&mut self, slot: &ExprSlot, scope: ScopeId) {
        let trimmed = slot.raw.trim();
        if is_bare_ident(trimmed) {
            if !is_literal_word(trimmed) {
                self.resolve_name(trimmed, slot.span, scope);
            }
            return;
        }
        let Ok(parsed) = expression_of_slot(slot) else { return };
        let names = collect_expression_names(&parsed);
        for name in names.distinct_refs() {
            if !names.aliases.contains(name) {
                self.resolve_name(name, slot.span, scope);
            }
        }
        self.report_slot_typing(&parsed, slot.span, scope);
    }

    /// `slotTyping(...).infer(parsed)`: what typing the slot reports.
    fn report_slot_typing(&mut self, parsed: &movement_parser::lowering::expression::Expression, span: Span, scope: ScopeId) {
        let diagnostics = {
            let env = self.typing_env(scope);
            let mut typing = crate::types::Typing::new(&env, self.version, span);
            typing.infer(parsed);
            typing.diagnostics
        };
        for diagnostic in diagnostics {
            self.push(diagnostic);
        }
    }

    /// `checkConditionSlot`, the name half: an `if` condition, whose `IS`
    /// tests name a subject and a type.
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
                self.check_is_test(subject_raw, type_, slot.span, scope, narrow_into);
            }
            MovementCondition::Expr { expr } => {
                let names = collect_expression_names(expr);
                for name in names.distinct_refs() {
                    if !names.aliases.contains(name) {
                        self.resolve_name(name, slot.span, scope);
                    }
                }
                self.report_slot_typing(expr, slot.span, scope);
            }
        }
    }

    fn check_movement(&mut self, movement: &MovementDeclaration, scope: ScopeId) {
        if !self.scopes.has_own(scope, &movement.name) {
            self.check_function_name(&movement.name, movement.span, scope);
            self.declare_authored(scope, Symbol::new(&movement.name, SymbolKind::Movement, movement.span), movement.span);
            self.note_movement(scope, movement);
        }
        let body = self.scopes.open(Some(scope));
        for param in &movement.params {
            let Some(type_) = &param.type_ else { continue };
            let graph = self.check_param_type(type_, scope);
            if let (ParamTypeRef::Name(reference), false) = (type_, crate::families::systems::is_value_param_type(self, type_, scope)) {
                self.check_param_source(reference, graph);
                self.note_dispatchable(movement, reference, graph, scope);
            }
            self.report_param_position(type_, scope);
            self.declare_param(body, &param.name, param.span, is_closure_type(type_));
            self.type_param(body, &param.name, type_, scope);
        }
        self.check_statement_list(&movement.body, body);
        if let Some(returns) = &movement.return_type {
            self.check_param_type(returns, scope);
        }
    }

    /// A parameter's type: a graph's name resolves; a value type names nothing.
    /// What the graph's name resolved to.
    fn check_param_type(&mut self, type_: &ParamTypeRef, scope: ScopeId) -> Option<crate::scope::SymbolId> {
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

    pub fn check_closure(&mut self, closure: &ClosureExpression, scope: ScopeId, _self_name: Option<&str>) {
        let body = self.scopes.open(Some(scope));
        for param in &closure.params {
            let is_closure = param.type_.as_ref().is_some_and(is_closure_type);
            self.declare_param(body, &param.name, param.span, is_closure);
            if let Some(type_) = &param.type_ {
                self.report_param_position(type_, scope);
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

    pub fn check_call_args(&mut self, args: &[CallArg], scope: ScopeId) {
        for arg in args {
            match arg {
                CallArg::Expr { expr, .. } => self.check_expr_slot(expr, scope),
                CallArg::Write { write, .. } => {
                    self.check_write(write, scope, None, true);
                }
                CallArg::Node { node, .. } => self.check_node_literal(node, scope),
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

    fn check_write(&mut self, write: &WriteExpression, scope: ScopeId, binding: Option<&str>, is_bound: bool) -> Option<crate::types::Position> {
        self.check_target(&write.target, scope);
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

    fn check_node_literal(&mut self, node: &NodeLiteral, scope: ScopeId) {
        if let Some(shape) = node.graph.as_ref().and_then(|g| g.shape.as_ref()) {
            self.resolve_name(&shape.name, shape.span, scope);
        }
        for entry in &node.entries {
            match entry {
                NodeEntry::Value { value, .. } => self.check_expr_slot(value, scope),
                NodeEntry::Nodes { nodes, .. } => {
                    for nested in nodes {
                        self.check_node_literal(nested, scope);
                    }
                }
                NodeEntry::Declared { .. } => {}
                NodeEntry::Traversal { head, mapping, .. } => {
                    let aliases = self.check_path_head(head, scope);
                    let walk = self.walk_head(head, scope, false);
                    if let Some(mapping) = mapping {
                        let landing = self.open_landing(scope, &aliases, head.span);
                        self.type_hop_aliases(landing, &aliases, walk.as_ref());
                        self.check_node_literal(mapping, landing);
                    }
                }
            }
        }
        for spread in node.spreads.iter().flatten() {
            let root = spread.path.as_ref().map_or(spread.source.as_str(), |p| p.root.as_str());
            self.resolve_name(root, spread.span, scope);
        }
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
        if let Some(name) = &root_name {
            self.check_path_root_constructed(name, root_symbol, &head.hops_raw, head.span);
        }
        self.report_head_not_a_position(head, scope);
        aliases
    }

    /// `checkTraversalBlock`: the body runs in its own scope holding the hop
    /// aliases, and what it binds is remembered as escaped once it closes.
    fn check_traversal_block(&mut self, block: &TraversalBlock, scope: ScopeId, assigned: Option<&str>) {
        let aliases = self.check_path_head(&block.head, scope);
        let walk = self.walk_head(&block.head, scope, false);
        let body = self.open_landing(scope, &aliases, block.head.span);
        self.type_hop_aliases(body, &aliases, walk.as_ref());
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
                self.walk_head(head, scope, true);
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

/// `terminates` (flow.ts): a list that always leaves — an `ERROR`, a
/// `return` from version 3, or an `if` every arm of which leaves.
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
