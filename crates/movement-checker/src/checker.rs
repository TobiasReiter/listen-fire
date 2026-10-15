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
}

/// What a right-hand side carries onto the name it is bound to.
#[derive(Default)]
pub struct Bound {
    pub is_closure: bool,
    /// A construction bound to a name is an instance, not a plain binding.
    pub is_instance: bool,
    /// For an instance: the adapter that constructed it.
    pub adapter: Option<String>,
}

impl<'c> Checker<'c> {
    pub fn new(catalog: &'c CatalogSnapshot, version: u32, resolves_files: bool) -> Self {
        Checker { catalog, version, resolves_files, scopes: Scopes::default(), diagnostics: Vec::new(), type_only: 0 }
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
            Statement::If(statement) => {
                for arm in &statement.arms {
                    self.check_condition_slot(&arm.condition, scope);
                    let arm_scope = self.scopes.open(Some(scope));
                    self.check_statement_list(&arm.body, arm_scope);
                }
                if let Some(else_arm) = &statement.else_arm {
                    let else_scope = self.scopes.open(Some(scope));
                    self.check_statement_list(&else_arm.body, else_scope);
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
                let adapter = self.check_construction(construct, scope);
                return Bound { is_closure: false, is_instance: name.is_some(), adapter };
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
            RValue::Node { node } => self.check_node_literal(node, scope),
            RValue::Lazy { lazy } => {
                let aliases = self.check_path_head(&lazy.head, scope);
                if let Some(mapping) = &lazy.mapping {
                    let landing = self.open_landing(scope, &aliases, lazy.head.span);
                    self.check_node_literal(mapping, landing);
                }
            }
            RValue::Expr { expr } => self.check_expr_slot(expr, scope),
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

    /// `checkConditionSlot`, the name half: an `if` condition, whose `IS`
    /// tests name a subject and a type.
    fn check_condition_slot(&mut self, slot: &ExprSlot, scope: ScopeId) {
        let Ok(condition) = condition_of_slot(slot) else { return };
        self.check_condition(&condition, slot, scope);
    }

    fn check_condition(&mut self, condition: &MovementCondition, slot: &ExprSlot, scope: ScopeId) {
        match condition {
            MovementCondition::And { conjuncts } => conjuncts.iter().for_each(|c| self.check_condition(c, slot, scope)),
            MovementCondition::IsTest { subject_raw, type_ } => {
                let subject = subject_raw.trim();
                if is_bare_ident(subject) {
                    self.resolve_name(subject, slot.span, scope);
                } else {
                    self.check_expr_slot(&ExprSlot::plain(subject_raw.clone(), slot.span), scope);
                }
                self.resolve_name(&type_.graph, slot.span, scope);
            }
            MovementCondition::Expr { expr } => {
                let names = collect_expression_names(expr);
                for name in names.distinct_refs() {
                    if !names.aliases.contains(name) {
                        self.resolve_name(name, slot.span, scope);
                    }
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
            self.declare_param(body, &param.name, param.span, is_closure_type(type_));
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

    fn check_write(&mut self, write: &WriteExpression, scope: ScopeId) {
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
    }

    fn check_match(&mut self, matched: &MatchExpression, scope: ScopeId) {
        self.check_target(&matched.target, scope);
        for field in &matched.fields {
            self.check_expr_slot(&field.value, scope);
        }
    }

    fn check_link(&mut self, link: &movement_parser::ast::LinkExpression, scope: ScopeId) {
        self.resolve_name(&link.from, link.span, scope);
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
                    if let Some(mapping) = mapping {
                        let landing = self.open_landing(scope, &aliases, head.span);
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
        let body = self.open_landing(scope, &aliases, block.head.span);
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

fn is_closure_type(type_: &ParamTypeRef) -> bool {
    matches!(type_, ParamTypeRef::Value(ValueType::Closure { .. }))
}
