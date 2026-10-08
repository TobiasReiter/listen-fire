//! Admission: whether this engine runs a program whole, decided on its own
//! parse before anything else — before the catalog loads, before the
//! `check.program` host call, before any host request at all. A program this
//! engine does not run is refused with a stable reason (snake_case, the
//! README's admission section lists every one), and the shim runs it on the
//! TypeScript engine; the refusal cost a parse and this walk, nothing more.
//!
//! The walk is an allow-list: every statement kind, right-hand side, write
//! form, node entry, condition and expression kind a body may hold, and
//! every built-in an expression may call. Whatever this engine would refuse
//! mid-run because of what the program SAYS is refused here instead; what it
//! refuses because of what a value turns out to HOLD (a `__proto__` key
//! spread in, a record compared by identity or shaped like a binding, a
//! field that is `Object.prototype`'s) cannot be known from the text, and
//! stays a documented mid-run failure (the README's "Errors a run can meet
//! mid-run"). What needs the checker's stamps is refused after the check
//! and before any effect (`run::Run::stamp_decline`).

use std::collections::BTreeSet;

use movement_parser::ast::{
    self, AwaitSource, CallArg, CallStatement, ExprSlot, ImportSource, NodeEntry, NodeLiteral, ParamTypeRef, PathHead, PathRoot, RValue,
    Statement, TraversalBlock, WriteExpression, WriteTarget,
};
use movement_parser::lowering::condition::MovementCondition;
use movement_parser::lowering::expression::{Expression, FilterOperator, ListElement, ObjectMember, StaticValue, TraversalStep};

use crate::write::{EdgeShape, edge_shape};

/// The flat built-ins and namespaced members the evaluator runs
/// (crate::stdlib): an expression calling any other is refused.
const FUNCTIONS: [&str; 32] = [
    "isnull", "coalesce", "trim", "lower", "upper", "length", "abs", "round", "floor", "ceil", "tostring", "tonumber", "multi", "split",
    "date", "datetime", "number", "currency.get_number_from_figure", "currency.get_code_from_figure", "currency.format_figure", "date.parse",
    "date.add_days", "date.format", "date.format_iso", "date.today", "datetime.at", "text.regex_extract", "text.slug", "text.pairs",
    "text.serialise", "url.host", "number.format",
];

/// Why this engine does not run `program`, or `None` when it does. Every
/// movement in the file is walked, not only the one an event dispatches.
/// A cost cap refuses nothing: a run that meets it suspends (crate::park).
pub fn refusal(program: &ast::Program, language_version: u32) -> Option<String> {
    let mut file_names = BTreeSet::new();
    let mut instances = BTreeSet::new();
    let mut movements: Vec<&ast::MovementDeclaration> = Vec::new();
    for statement in &program.statements {
        if let Statement::Movement(movement) = statement {
            movements.push(movement);
        }
    }
    let movement_names: BTreeSet<String> = movements.iter().map(|m| m.name.clone()).collect();
    for statement in &program.statements {
        match statement {
            Statement::Import(import) => {
                match &import.source {
                    ImportSource::Builtin { namespace } if namespace == "adapters" || namespace == "credentials" => {}
                    ImportSource::Builtin { namespace } => return Some(format!("import_from_{namespace}")),
                    ImportSource::File { .. } => return Some("import_from_file".into()),
                }
                for name in &import.names {
                    file_names.insert(name.alias.clone().unwrap_or_else(|| name.name.clone()));
                }
            }
            Statement::Assign(assign) => match &assign.value {
                RValue::Construct { construct } if movement_names.contains(&construct.callee) => return Some("file_call".into()),
                RValue::Construct { .. } => {
                    file_names.insert(assign.name.clone());
                    instances.insert(assign.name.clone());
                }
                _ => return Some("file_assignment".into()),
            },
            Statement::Listen(_) => {}
            Statement::Movement(movement) => {
                if movement.params.iter().any(|p| matches!(p.type_, Some(ParamTypeRef::Value(_)))) {
                    return Some("movement_value_param".into());
                }
                file_names.insert(movement.name.clone());
            }
            other => return Some(format!("file_statement:{}", statement_kind(other))),
        }
    }
    for movement in &movements {
        let events: BTreeSet<String> = movement.params.iter().map(|p| p.name.clone()).collect();
        let mut bound = Bound::default();
        bound.collect(&movement.body, &[]);
        if bound.sites.iter().any(|(n, _, _)| events.contains(n) || file_names.contains(n)) {
            return Some("name_shadowed".into());
        }
        if bound.rebound() {
            return Some("name_rebound".into());
        }
        let names = Names {
            events: &events,
            values: &bound.values,
            handles: &bound.handles,
            nodes: &bound.nodes,
            landings: &bound.landings,
            instances: instances.union(&bound.instances).cloned().collect(),
            body_instances: &bound.instances,
            file_names: &file_names,
            movements: &movement_names,
            language_version,
        };
        if let Err(reason) = names.body(&movement.body, Within::Body) {
            return Some(reason);
        }
    }
    None
}

/// Why this engine does not run `program` with this input, or `None`: a
/// flow this engine runs must not suspend inside a traversal block, where
/// the TypeScript engine records the iteration's park and joins the fan-out
/// later (`interpretBlock`), which this engine does not do. A cost cap can
/// be met at any judged write, so a capped run with a write in a block is
/// refused; so is a `suspendAt` address inside one (an `i` step).
pub fn input_refusal(program: &ast::Program, capped: bool, suspend_at: &[String]) -> Option<String> {
    if suspend_at.iter().any(|address| address.split('.').any(|step| step.starts_with('i'))) {
        return Some("suspend_at_inside_block".into());
    }
    if capped && program.statements.iter().any(|s| matches!(s, Statement::Movement(m) if writes_in_block(&m.body, false))) {
        return Some("cost_cap_inside_block".into());
    }
    None
}

/// Whether a write sits in a traversal block's body, at any depth.
fn writes_in_block(statements: &[Statement], in_block: bool) -> bool {
    statements.iter().any(|statement| match statement {
        Statement::Write(_) => in_block,
        Statement::Assign(assign) => in_block && matches!(assign.value, RValue::Write { .. }),
        Statement::If(statement) => {
            statement.arms.iter().any(|arm| writes_in_block(&arm.body, in_block))
                || statement.else_arm.as_ref().is_some_and(|arm| writes_in_block(&arm.body, in_block))
        }
        Statement::Block(statement) => writes_in_block(&statement.block.body, true),
        _ => false,
    })
}

/// The AST's own `kind` for a statement.
fn statement_kind(statement: &Statement) -> &'static str {
    match statement {
        Statement::Import(_) => "import",
        Statement::Assign(_) => "assign",
        Statement::Shape(_) => "shape",
        Statement::Type(_) => "type",
        Statement::Movement(_) => "movement",
        Statement::Listen(_) => "listen",
        Statement::Write(_) => "write",
        Statement::Match(_) => "match",
        Statement::Call(_) => "call",
        Statement::Block(_) => "block",
        Statement::Link(_) => "link",
        Statement::Unlink(_) => "unlink",
        Statement::Delete(_) => "delete",
        Statement::Refresh(_) => "refresh",
        Statement::If(_) => "if",
        Statement::Await(_) => "await",
        Statement::Combinator(_) => "combinator",
        Statement::Collection(_) => "collection",
        Statement::Return(_) => "return",
        Statement::Error(_) => "error",
    }
}

/// The AST's own `kind` for a right-hand side.
fn rvalue_kind(value: &RValue) -> &'static str {
    match value {
        RValue::Construct { .. } => "construct",
        RValue::Call { .. } => "call",
        RValue::Write { .. } => "write",
        RValue::Match { .. } => "match",
        RValue::Link { .. } => "link",
        RValue::Extract { .. } => "extract",
        RValue::ExtractCall { .. } => "extractCall",
        RValue::Block { .. } => "block",
        RValue::Await { .. } => "await",
        RValue::Combinator { .. } => "combinator",
        RValue::Collection { .. } => "collection",
        RValue::Members { .. } => "members",
        RValue::InlineBlock { .. } => "inlineBlock",
        RValue::Callback { .. } => "callback",
        RValue::Closure { .. } => "closure",
        RValue::Node { .. } => "node",
        RValue::Lazy { .. } => "lazy",
        RValue::Expr { .. } => "expr",
    }
}

/// Every name a body binds, by what it holds; `if` arms and block bodies
/// included, and a block head's hop alias (`landings`). Each binding is kept
/// with the lexical scope it lands in (`sites`): an `if` arm and a block's
/// body (its iteration, where the hop alias lives) are scopes of their own.
#[derive(Default)]
struct Bound {
    values: BTreeSet<String>,
    handles: BTreeSet<String>,
    instances: BTreeSet<String>,
    nodes: BTreeSet<String>,
    landings: BTreeSet<String>,
    /// (name, kind, scope path from the body's root scope).
    sites: Vec<(String, Kind, Vec<usize>)>,
    scopes: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Value,
    Handle,
    Instance,
    Node,
    Landing,
}

impl Bound {
    fn collect(&mut self, statements: &[Statement], scope: &[usize]) {
        for statement in statements {
            match statement {
                Statement::Assign(assign) => {
                    let kind = match &assign.value {
                        RValue::Write { .. } => Kind::Handle,
                        RValue::Construct { .. } => Kind::Instance,
                        RValue::Node { .. } => Kind::Node,
                        _ => Kind::Value,
                    };
                    self.bind(&assign.name, kind, scope);
                }
                Statement::If(statement) => {
                    for arm in &statement.arms {
                        let inner = self.enter(scope);
                        self.collect(&arm.body, &inner);
                    }
                    if let Some(arm) = &statement.else_arm {
                        let inner = self.enter(scope);
                        self.collect(&arm.body, &inner);
                    }
                }
                Statement::Block(statement) => {
                    let inner = self.enter(scope);
                    if let Ok(step) = crate::traverse::head_step(&statement.block.head)
                        && let Some(alias) = step.alias
                    {
                        self.bind(&alias, Kind::Landing, &inner);
                    }
                    self.collect(&statement.block.body, &inner);
                }
                _ => {}
            }
        }
    }

    fn enter(&mut self, scope: &[usize]) -> Vec<usize> {
        self.scopes += 1;
        let mut inner = scope.to_vec();
        inner.push(self.scopes);
        inner
    }

    fn bind(&mut self, name: &str, kind: Kind, scope: &[usize]) {
        let into = match kind {
            Kind::Value => &mut self.values,
            Kind::Handle => &mut self.handles,
            Kind::Instance => &mut self.instances,
            Kind::Node => &mut self.nodes,
            Kind::Landing => &mut self.landings,
        };
        into.insert(name.to_string());
        self.sites.push((name.to_string(), kind, scope.to_vec()));
    }

    /// A name bound twice where one binding can see the other (one scope, or
    /// one inside the other), or bound as two kinds anywhere: what a body
    /// binds is read by name, so each name must mean one kind of thing, and a
    /// name is bound once in any one scope chain. The same name in two sibling
    /// scopes (two blocks' hop aliases, two arms' bindings) is two names.
    fn rebound(&self) -> bool {
        self.sites.iter().enumerate().any(|(i, (name, kind, scope))| {
            self.sites[i + 1..].iter().any(|(other, other_kind, other_scope)| {
                name == other && (kind != other_kind || scope.starts_with(other_scope) || other_scope.starts_with(scope))
            })
        })
    }
}

/// Where a statement sits: the movement's body (or an `if` arm of it), or a
/// traversal block's body, where a park or a suspension would leave the
/// fan-out's other iterations to a join this engine does not keep.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Within {
    Body,
    Block,
}

type Admitted = Result<(), String>;

fn refuse(reason: impl Into<String>) -> Admitted {
    Err(reason.into())
}

/// One movement's names, as its body may read them.
struct Names<'n> {
    /// The movement's parameters: the event.
    events: &'n BTreeSet<String>,
    values: &'n BTreeSet<String>,
    handles: &'n BTreeSet<String>,
    nodes: &'n BTreeSet<String>,
    /// Block heads' hop aliases: a record the walk landed on.
    landings: &'n BTreeSet<String>,
    /// The file's constructed instances and the body's.
    instances: BTreeSet<String>,
    body_instances: &'n BTreeSet<String>,
    /// Every name the file binds: imports, instances, movements.
    file_names: &'n BTreeSet<String>,
    movements: &'n BTreeSet<String>,
    language_version: u32,
}

impl Names<'_> {
    fn body(&self, statements: &[Statement], within: Within) -> Admitted {
        statements.iter().try_for_each(|statement| self.statement(statement, within))
    }

    fn statement(&self, statement: &Statement, within: Within) -> Admitted {
        let sleep = |source: &AwaitSource| {
            sleep_only(source)?;
            if within == Within::Block { refuse("block_park") } else { Ok(()) }
        };
        match statement {
            Statement::Assign(assign) => match &assign.value {
                RValue::Write { write } => self.write(write),
                RValue::Await { r#await } => sleep(&r#await.source),
                RValue::Construct { construct } if self.movements.contains(&construct.callee) => refuse("movement_call"),
                RValue::Construct { .. } => Ok(()),
                RValue::Node { node } => self.node(node, node.graph.is_some()),
                other => self.rvalue(other),
            },
            Statement::Return(ret) => self.rvalue(&ret.value),
            Statement::Write(statement) => self.write(&statement.write),
            Statement::Await(statement) => sleep(&statement.r#await.source),
            Statement::If(statement) => {
                for arm in &statement.arms {
                    self.condition(&arm.condition)?;
                    self.body(&arm.body, within)?;
                }
                match &statement.else_arm {
                    Some(arm) => self.body(&arm.body, within),
                    None => Ok(()),
                }
            }
            Statement::Block(_) if within == Within::Block => refuse("block_nested"),
            Statement::Block(statement) => self.block(&statement.block),
            other => refuse(format!("statement:{}", statement_kind(other))),
        }
    }

    /// A traversal block over an adapter edge (crate::traverse): one hop
    /// off a constructed instance, a write's handle or the event, its WHERE
    /// and ORDER BY key position-scoped expressions the evaluator runs, its
    /// body in the slice and with no park in it.
    fn block(&self, block: &TraversalBlock) -> Admitted {
        self.head(&block.head)?;
        self.body(&block.body, Within::Block)
    }

    fn head(&self, head: &PathHead) -> Admitted {
        let root = match &head.root {
            None => return refuse("block_head_rootless"),
            Some(PathRoot::Expression { .. }) => return refuse("block_head_expression_root"),
            Some(PathRoot::Name { name }) => name,
        };
        if self.landings.contains(root) {
            return refuse("block_nested");
        }
        if self.values.contains(root) {
            return refuse("block_head_value_root");
        }
        if self.nodes.contains(root) {
            return refuse("block_head_node_root");
        }
        if !self.instances.contains(root) && !self.handles.contains(root) && !self.events.contains(root) {
            return refuse("block_head_root");
        }
        let probe = format!("{}{}.`__movement_engine_probe__`", crate::write::spell_name(root), head.hops_raw);
        let Ok(tree) = movement_parser::expr::parse_expression(&probe) else { return refuse("block_head_does_not_lower") };
        let Ok(walk) = movement_parser::lowering::lower_expression(&tree, &probe) else { return refuse("block_head_does_not_lower") };
        let steps = match &walk {
            Expression::Traverse { steps, .. } => steps,
            Expression::ResourceTraverse { .. } => return refuse("block_head_resources"),
            _ => return refuse("block_head_does_not_lower"),
        };
        let [step] = steps.as_slice() else { return refuse("block_multi_hop") };
        let TraversalStep::Edge(step) = step else { return refuse("block_head_step") };
        if let Some(filter) = &step.expression_filter {
            self.scoped(filter)?;
        }
        if let Some(key) = step.cardinality.as_ref().and_then(|c| c.order_by.as_deref()) {
            self.scoped(key)?;
        }
        Ok(())
    }

    /// `name = <expression>`, or a built-in's call read as the expression it is.
    fn rvalue(&self, value: &RValue) -> Admitted {
        match value {
            RValue::Expr { expr } => self.slot(expr),
            RValue::Call { call } => self.slot(self.builtin_value(call)?),
            other => refuse(format!("rvalue:{}", rvalue_kind(other))),
        }
    }

    /// `resolveCallee` then `readCall` at a value's position: a callee the
    /// program does not bind (exactly, or from version 3 as a function in any
    /// letter case) is a built-in, read as its expression when its arguments
    /// are all positional values. Which built-in it is the expression's own
    /// walk decides (`FUNCTIONS`).
    fn builtin_value<'c>(&self, call: &'c CallStatement) -> Result<&'c ExprSlot, String> {
        let declared = self.binds(&call.callee)
            || self.language_version < 3
            || self.movements.iter().any(|m| m.to_lowercase() == call.callee.to_lowercase());
        if declared {
            return Err("function_call".into());
        }
        fn positional_values(args: &[CallArg]) -> bool {
            args.iter().all(|arg| match arg {
                CallArg::Expr { name: None, .. } => true,
                CallArg::Call { name: None, call } => positional_values(&call.args),
                _ => false,
            })
        }
        match &call.expression {
            Some(expr) if positional_values(&call.args) => Ok(expr),
            _ => Err("builtin_call_form".into()),
        }
    }

    /// `CallScope.binds`: a name the file or the body binds, anywhere.
    fn binds(&self, name: &str) -> bool {
        self.events.contains(name)
            || self.values.contains(name)
            || self.handles.contains(name)
            || self.nodes.contains(name)
            || self.body_instances.contains(name)
            || self.file_names.contains(name)
    }

    fn write(&self, write: &WriteExpression) -> Admitted {
        if write.bind.is_some() {
            return refuse("write_bind");
        }
        match &write.target {
            WriteTarget::Tuple { .. } => return refuse("write_tuple"),
            WriteTarget::Position { alias, .. } => {
                if !self.handles.contains(alias) {
                    return refuse("write_position_not_handle");
                }
            }
            WriteTarget::Linked { path, .. } => {
                let Some(PathRoot::Name { name: root }) = &path.root else { return refuse("write_root_expression") };
                if !self.instances.contains(root) && !self.handles.contains(root) && !self.events.contains(root) {
                    return refuse("write_root_not_held");
                }
                match edge_shape(path) {
                    EdgeShape::One { .. } => {}
                    EdgeShape::Narrowed => return refuse("write_target_where"),
                    EdgeShape::MultiHop | EdgeShape::Invalid(_) => return refuse("write_multi_hop"),
                }
            }
        }
        for clause in &write.unique_by {
            unique_clause(&clause.predicate.raw)?;
        }
        for spread in write.spreads.iter().flatten() {
            let held = self.values.contains(&spread.source)
                || self.handles.contains(&spread.source)
                || self.nodes.contains(&spread.source)
                || self.events.contains(&spread.source);
            if !held {
                return refuse("write_spread_source");
            }
        }
        write.fields.iter().try_for_each(|field| self.slot(&field.value))
    }

    /// A node or graph literal node.rs builds: value entries, nested
    /// literals, and in a graph a reference to a record the run holds and a
    /// spread of a value, a handle or a node; no shape, no declared or
    /// traversal entry.
    fn node(&self, literal: &NodeLiteral, graph: bool) -> Admitted {
        if literal.graph.as_ref().is_some_and(|g| g.shape.is_some()) {
            return refuse("graph_shape");
        }
        if !graph && literal.spreads.is_some() {
            return refuse("node_spread");
        }
        let records = |name: &str| self.handles.contains(name) || self.nodes.contains(name);
        for spread in literal.spreads.iter().flatten() {
            if !self.values.contains(&spread.source) && !records(&spread.source) {
                return refuse("node_spread_source");
            }
        }
        for entry in &literal.entries {
            match entry {
                NodeEntry::Value { value, .. } => {
                    let bare = crate::js::trim(&value.raw);
                    if graph && records(bare) {
                        continue;
                    }
                    if self.events.contains(bare) {
                        return refuse("node_event_entry");
                    }
                    self.slot(value)?;
                }
                NodeEntry::Nodes { nodes, .. } => {
                    for nested in nodes {
                        self.node(nested, graph)?;
                    }
                }
                NodeEntry::Declared { .. } => return refuse("node_declared_entry"),
                NodeEntry::Traversal { .. } => return refuse("node_traversal_entry"),
            }
        }
        Ok(())
    }

    fn slot(&self, slot: &ExprSlot) -> Admitted {
        let Ok(tree) = movement_parser::expr::parse_expression(&slot.raw) else { return refuse("expression_does_not_lower") };
        let Ok(expr) = movement_parser::lowering::lower_expression(&tree, &slot.raw) else { return refuse("expression_does_not_lower") };
        self.expression(&expr)
    }

    fn condition(&self, slot: &ExprSlot) -> Admitted {
        let Ok(tree) = movement_parser::expr::parse_expression(&slot.raw) else { return refuse("condition_does_not_lower") };
        let Ok(condition) = movement_parser::lowering::lower_condition(&tree, &slot.raw) else {
            return refuse("condition_does_not_lower");
        };
        self.conjunct(&condition)
    }

    fn conjunct(&self, condition: &MovementCondition) -> Admitted {
        match condition {
            MovementCondition::And { conjuncts } => conjuncts.iter().try_for_each(|c| self.conjunct(c)),
            MovementCondition::Expr { expr } => self.expression(expr),
            MovementCondition::IsTest { .. } => refuse("is_test"),
        }
    }

    /// The kinds the evaluator answers itself (or hands to `builtins.*`), a
    /// name read being a value the body binds, and a field read with no
    /// hops off the event, a value, a write's handle or a node.
    fn expression(&self, expr: &Expression) -> Admitted {
        self.walk(expr, false)
    }

    /// A hop's WHERE or ORDER BY key, scoped at the landed record: its bare
    /// names (`property`, `edge_property`) read the record's fields.
    fn scoped(&self, expr: &Expression) -> Admitted {
        self.walk(expr, true)
    }

    fn walk(&self, expr: &Expression, scoped: bool) -> Admitted {
        let each = |items: &[Expression]| items.iter().try_for_each(|e| self.walk(e, scoped));
        match expr {
            Expression::Property { .. } | Expression::EdgeProperty { .. } if scoped => Ok(()),
            Expression::AliasRef { name } | Expression::Property { property_type_id: name } => {
                if self.values.contains(name) { Ok(()) } else { refuse("name_not_value") }
            }
            // `EXISTS(x-[:e]->)` lowers as a walk ending in the quantifier.
            Expression::Traverse { expression, .. } if matches!(expression.as_ref(), Expression::Exists { .. }) => refuse("expression:exists"),
            Expression::Traverse { alias_root, steps, expression } => {
                let held = alias_root.as_ref().is_some_and(|root| {
                    self.events.contains(root)
                        || self.values.contains(root)
                        || self.handles.contains(root)
                        || self.nodes.contains(root)
                        || self.landings.contains(root)
                });
                if !held {
                    return refuse("traversal_root");
                }
                if !steps.is_empty() {
                    return refuse("traversal_steps");
                }
                match expression.as_ref() {
                    Expression::Property { .. } | Expression::EdgeProperty { .. } => Ok(()),
                    _ => refuse("traversal_terminal"),
                }
            }
            Expression::Static { value: StaticValue::Number(n) } => {
                if n.0.is_finite() && !(n.0 == 0.0 && n.0.is_sign_negative()) { Ok(()) } else { refuse("static_number") }
            }
            Expression::Static { .. } => Ok(()),
            Expression::At { expression, index } => {
                self.walk(expression, scoped)?;
                self.walk(index, scoped)
            }
            Expression::List { elements } => elements.iter().try_for_each(|element| match element {
                ListElement::Expression(e) => self.walk(e, scoped),
                ListElement::Spread(spread) => self.walk(&spread.expression, scoped),
            }),
            Expression::Object { entries } => entries.iter().try_for_each(|member| match member {
                ObjectMember::Entry { key, .. } if key == "__proto__" => refuse("proto_key"),
                ObjectMember::Entry { value, .. } => self.walk(value, scoped),
                ObjectMember::Spread(spread) => self.walk(&spread.expression, scoped),
            }),
            Expression::Concat { parts } => each(parts),
            Expression::Conditional { condition, then, else_ } => {
                self.walk(condition, scoped)?;
                self.walk(then, scoped)?;
                self.walk(else_, scoped)
            }
            Expression::Compare { op: FilterOperator::Within, .. } => refuse("within_compare"),
            Expression::Compare { left, right, .. } | Expression::Arithmetic { left, right, .. } => {
                self.walk(left, scoped)?;
                self.walk(right, scoped)
            }
            Expression::Logical { operands, .. } => each(operands),
            Expression::Not { expression } | Expression::Negate { expression } => self.walk(expression, scoped),
            Expression::Function { fn_, args } => {
                if !FUNCTIONS.contains(&fn_.as_str()) {
                    return refuse(format!("function:{fn_}"));
                }
                each(args)
            }
            other => refuse(format!("expression:{}", crate::eval::kind_of(other))),
        }
    }
}

/// `await sleep(…)`, the only await this engine parks on.
fn sleep_only(source: &AwaitSource) -> Admitted {
    match source {
        AwaitSource::Sleep { .. } => Ok(()),
        _ => refuse("await_not_sleep"),
    }
}

/// A `unique by` clause with a key (`identityKeyOf`), whose other conjuncts
/// read only the candidate (`isPurePredicate`).
fn unique_clause(raw: &str) -> Admitted {
    let mut keys = 0;
    for part in crate::unique::split_conjuncts(raw) {
        let Ok(tree) = movement_parser::expr::parse_expression(&part.raw) else { return refuse("expression_does_not_lower") };
        let Ok(expr) = movement_parser::lowering::lower_expression(&tree, &part.raw) else { return refuse("expression_does_not_lower") };
        for conjunct in crate::unique::and_conjuncts(&expr) {
            if crate::unique::identity_key(conjunct).is_some() {
                keys += 1;
            } else if crate::filter::pure_leaf_keys(conjunct).is_none() {
                return refuse("unique_by_reads_beyond_candidate");
            }
        }
    }
    if keys == 0 { refuse("unique_by_without_key") } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRELUDE: &str = "import { email, attio } from adapters\nimport { dealflow_inbox, acme_main } from credentials\ninbox = email(credentials: dealflow_inbox)\ncrm = attio(credentials: acme_main)\n";

    fn refused(body: &str) -> Option<String> {
        let source = format!("{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}");
        let program = movement_parser::stmt::parse_program(&source, 3, false).expect("the test's program parses");
        refusal(&program, 3)
    }

    fn file(source: &str) -> Option<String> {
        let program = movement_parser::stmt::parse_program(source, 3, false).expect("the test's program parses");
        refusal(&program, 3)
    }

    #[test]
    fn admits_reads_bindings_branches_writes_nodes_and_sleeps() {
        for body in [
            "  s = msg.`subject`\n  if s CONTAINS \"deal\" AND LENGTH(s) > 3 {\n    t = \"${UPPER(TRIM(s))}!\"\n    return t\n  } else {\n    u = COALESCE(msg.`text`, \"x\")\n  }",
            "  n = UPPER(msg.`subject`)",
            "  co = write crm-[:companies]-> { unique by (`name`) name: msg.`subject` }\n  write co-[:notes]-> { body: co.`name` }\n  write co { stage: \"x\" }",
            "  d = { label: \"x\" }\n  co = write crm-[:companies]-> { name: \"a\" }\n  g = graph { title: d.`label`, owner: co, ...co }\n  n = node { name: d.`label` }\n  write crm-[:companies]-> { ...d, name: g.`title` }",
            "  waited = await sleep(30s)\n  await sleep(1h)",
            "  x = NUMBER.FORMAT(1200000, \"compact\")\n  y = { a: [1, -2] }\n  z = y.`a`",
        ] {
            assert_eq!(refused(body), None, "{body}");
        }
    }

    #[test]
    fn refuses_each_construct_it_does_not_run_with_its_reason() {
        for (body, reason) in [
            ("  write crm-[c:companies WHERE `name` == \"x\"]-> { name: \"y\" }", "write_target_where"),
            ("  co = write crm-[:companies]-> { name: \"a\" }\n  x = co", "name_not_value"),
            ("  x = msg", "name_not_value"),
            ("  x = AI(\"why?\")", "expression:llm"),
            ("  if msg IS <inbox-[:message]->> {\n    x = 1\n  }", "is_test"),
            ("  x = crm.`name`", "traversal_root"),
            ("  x = msg-[:replies]->.`subject`", "traversal_steps"),
            ("  x = FIRST(msg.`subject`)", "expression:aggregate"),
            ("  x = TEXT.CHUNKS(msg.`subject`)", "expression_does_not_lower"),
            ("  x = msg.`subject` WITHIN \"7d\"", "within_compare"),
            ("  x = { __proto__: 1 }", "proto_key"),
            ("  x = 1\n  x = write crm-[:companies]-> { name: \"a\" }", "name_rebound"),
            ("  inbox = 1", "name_shadowed"),
            ("  msg = 1", "name_shadowed"),
            ("  x = await inbox-[:message]->", "await_not_sleep"),
            ("  r = m(msg: msg)", "movement_call"),
            ("  write crm-[:companies]-> bind co { name: \"a\" }", "write_bind"),
            ("  write crm-[:companies]-> { unique by (`name` == \"a\" AND msg-[:replies]->.`y` == 1) name: \"a\" }", "unique_by_reads_beyond_candidate"),
            ("  write crm-[:companies]-> { unique by (`name` CONTAINS \"a\") name: \"a\" }", "unique_by_without_key"),
            ("  write crm-[:companies]-> { ...crm }", "write_spread_source"),
            ("  g = graph { owner: msg }", "node_event_entry"),
            ("  g = graph { ...msg }", "node_spread_source"),
            ("  x = MAP([1], (v) => v)", "builtin_call_form"),
            ("  r = M(msg)", "function_call"),
        ] {
            assert_eq!(refused(body).as_deref(), Some(reason), "{body}");
        }
    }

    #[test]
    fn admits_one_hop_blocks_whose_body_is_in_the_slice() {
        for body in [
            "  crm-[c:companies WHERE `name` == \"Acme\" ORDER BY `name` DESC LIMIT 2]-> {\n    write crm-[:notes]-> { body: c.`name` }\n  }",
            "  wanted = msg.`subject`\n  crm-[c:companies WHERE c.`name` == wanted AND `stage` != msg.`text`]-> {\n    n = c.`name`\n    if n != \"x\" {\n      write crm-[:notes]-> { body: n }\n    }\n    return n\n  }",
            "  co = write crm-[:companies]-> { name: \"a\" }\n  co-[d:deals]-> {\n    write crm-[:notes]-> { body: d.`title` }\n  }",
            "  msg-[a:attachments]-> {\n    write crm-[:notes]-> { body: a.`name` }\n  }",
            "  crm-[:companies]-> {\n    write crm-[:notes]-> { body: \"one\" }\n  }",
        ] {
            assert_eq!(refused(body), None, "{body}");
        }
    }

    #[test]
    fn refuses_each_block_construct_it_does_not_run_with_its_reason() {
        for (body, reason) in [
            ("  crm-[c:companies]-> {\n    await sleep(1h)\n  }", "block_park"),
            ("  crm-[c:companies]-> {\n    c-[d:deals]-> {\n      x = d.`title`\n    }\n  }", "block_nested"),
            ("  crm-[c:companies]->-[d:deals]-> {\n    x = d.`title`\n  }", "block_multi_hop"),
            ("  v = 1\n  v-[c:companies]-> {\n    x = 1\n  }", "block_head_value_root"),
            ("  n = node { a: 1 }\n  n-[c:kids]-> {\n    x = 1\n  }", "block_head_node_root"),
            ("  crm-[c:companies WHERE EXISTS(c-[:deals]->)]-> {\n    x = 1\n  }", "expression:exists"),
            ("  crm-[c:companies ORDER BY c-[:owner]->.`joined`]-> {\n    x = 1\n  }", "traversal_steps"),
            ("  crm-[c:companies WHERE `name` == @current_date]-> {\n    x = 1\n  }", "expression:meta"),
            ("  crm-[c:companies]-> {\n    write c-[:notes]-> { body: \"x\" }\n  }", "write_root_not_held"),
            ("  crm-[c:companies]-> {\n    x = c\n  }", "name_not_value"),
            ("  x = crm-[c:companies]-> {\n    return c\n  }", "rvalue:block"),
            ("  crm-[c:companies]-> {\n    x = COUNT(c-[:deals]->)\n  }", "expression:aggregate"),
        ] {
            assert_eq!(refused(body).as_deref(), Some(reason), "{body}");
        }
    }

    #[test]
    fn scopes_names_lexically() {
        let twice = "  crm-[c:companies]-> {\n    n = c.`name`\n  }\n  crm-[c:companies]-> {\n    n = c.`name`\n  }";
        assert_eq!(refused(twice), None, "two blocks reusing a hop alias and a body name");
        let arms = "  if msg.`subject` == \"a\" {\n    t = 1\n  } else {\n    t = 2\n  }";
        assert_eq!(refused(arms), None, "one name in two sibling arms");
        for body in [
            "  crm-[c:companies]-> {\n    x = 1\n  }\n  c = 1",
            "  crm-[c:companies]-> {\n    c = 1\n  }",
            "  crm-[c:companies]-> {\n    n = 1\n  }\n  crm-[c:companies]-> {\n    n = write crm-[:notes]-> { body: \"x\" }\n  }",
            "  n = 1\n  if n == 1 {\n    n = 2\n  }",
        ] {
            assert_eq!(refused(body).as_deref(), Some("name_rebound"), "{body}");
        }
    }

    #[test]
    fn refuses_a_suspension_a_block_would_have_to_join() {
        let program = |body: &str| {
            let source = format!("{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}");
            movement_parser::stmt::parse_program(&source, 3, false).expect("the test's program parses")
        };
        let in_block = program("  crm-[c:companies]-> {\n    if c.`name` != \"\" {\n      write crm-[:notes]-> { body: c.`name` }\n    }\n  }");
        let outside = program("  write crm-[:notes]-> { body: \"x\" }\n  crm-[c:companies]-> {\n    x = c.`name`\n  }");
        assert_eq!(input_refusal(&in_block, true, &[]).as_deref(), Some("cost_cap_inside_block"));
        assert_eq!(input_refusal(&in_block, false, &[]), None);
        assert_eq!(input_refusal(&outside, true, &[]), None);
        assert_eq!(input_refusal(&outside, false, &["s1.i0.s0".into()]).as_deref(), Some("suspend_at_inside_block"));
        assert_eq!(input_refusal(&outside, false, &["s1".into()]), None);
    }

    #[test]
    fn refuses_what_the_file_says_it_does_not_run() {
        let movement = "movement m(msg: <inbox-[:message]->>) {\n  x = 1\n}";
        assert_eq!(file(&format!("{PRELUDE}type Stage = <\"a\" | \"b\">\n{movement}")).as_deref(), Some("file_statement:type"));
        assert_eq!(file(&format!("import {{ x }} from \"./lib.mov\"\n{movement}")).as_deref(), Some("import_from_file"));
        assert_eq!(file(&format!("{PRELUDE}y = 1\n{movement}")).as_deref(), Some("file_assignment"));
        assert_eq!(file(&format!("{PRELUDE}movement v(n: <number[]>) {{\n  x = n\n}}\n{movement}")).as_deref(), Some("movement_value_param"));
        assert_eq!(file(&format!("{PRELUDE}{movement}")), None);
    }
}
