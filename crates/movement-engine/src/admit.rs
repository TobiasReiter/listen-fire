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

use std::collections::{BTreeMap, BTreeSet};

use movement_parser::ast::{
    self, AwaitSource, CallArg, CallStatement, ExprSlot, ImportSource, NodeEntry, NodeLiteral, ParamTypeRef, PathHead, PathRoot, RValue,
    Statement, TraversalBlock, WriteExpression, WriteTarget,
};
use movement_parser::catalog::types::{JsMap, PluginOutput, PluginSpec};
use movement_parser::lowering::expression::EdgeDirection;
use movement_parser::lowering::condition::MovementCondition;
use movement_parser::lowering::expression::{AggregationFunction, Expression, FilterOperator, ListElement, ObjectMember, StaticValue, TraversalStep};

use crate::write::{EdgeShape, TargetWhere, edge_shape};

/// The flat built-ins and namespaced members the evaluator runs
/// (crate::stdlib): an expression calling any other is refused.
const FUNCTIONS: [&str; 32] = [
    "isnull", "coalesce", "trim", "lower", "upper", "length", "abs", "round", "floor", "ceil", "tostring", "tonumber", "multi", "split",
    "date", "datetime", "number", "currency.get_number_from_figure", "currency.get_code_from_figure", "currency.format_figure", "date.parse",
    "date.add_days", "date.format", "date.format_iso", "date.today", "datetime.at", "text.regex_extract", "text.slug", "text.pairs",
    "text.serialise", "url.host", "number.format",
];

/// What a plain call of a plugin binds, by the output the run's catalog
/// snapshot declares for it under the movement's pin (`pluginOutputUnder`):
/// read off the input, not asked of the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PluginBinds {
    Value,
    Record,
    Records,
    /// The plugin declares no output: the call fails, as the TypeScript's does.
    Nothing,
    /// The snapshot does not say (it did not read, or lacks the plugin).
    Unknown,
}

/// The plugins a run's catalog snapshot describes, when it reads: what
/// admission knows of a plugin call's output.
pub struct Plugins<'a>(pub Option<&'a JsMap<PluginSpec>>);

impl Plugins<'_> {
    fn binds(&self, registered: &str, language_version: u32) -> PluginBinds {
        let Some(specs) = self.0 else { return PluginBinds::Unknown };
        let Some(spec) = crate::plugin::spec_named(specs, registered) else { return PluginBinds::Unknown };
        match crate::plugin::output_under(spec, language_version) {
            Some(PluginOutput::Value { .. }) => PluginBinds::Value,
            Some(PluginOutput::Record { .. }) => PluginBinds::Record,
            Some(PluginOutput::Records { .. }) => PluginBinds::Records,
            None => PluginBinds::Nothing,
        }
    }
}

/// Why this engine does not run `program`, or `None` when it does. Every
/// movement in the file is walked, not only the one an event dispatches.
/// A cost cap refuses nothing: a run that meets it suspends (crate::park).
pub fn refusal(program: &ast::Program, language_version: u32, catalog: &Plugins<'_>) -> Option<String> {
    let mut file_names = BTreeSet::new();
    let mut instances = BTreeSet::new();
    let mut movements: Vec<&ast::MovementDeclaration> = Vec::new();
    let mut plugins = BTreeSet::new();
    // What a plain call of each imported plugin binds, by its local name.
    let mut plugin_binds: BTreeMap<String, PluginBinds> = BTreeMap::new();
    for statement in &program.statements {
        match statement {
            Statement::Movement(movement) => movements.push(movement),
            Statement::Import(import) if matches!(&import.source, ImportSource::Builtin { namespace } if namespace == "plugins") => {
                for name in &import.names {
                    let local = name.alias.clone().unwrap_or_else(|| name.name.clone());
                    plugin_binds.insert(local.clone(), catalog.binds(&name.name, language_version));
                    plugins.insert(local);
                }
            }
            _ => {}
        }
    }
    let movement_names: BTreeSet<String> = movements.iter().map(|m| m.name.clone()).collect();
    let plugin_named = |callee: &str| names_plugin(&plugins, callee, language_version);
    // `resolveCallee`: as written, or from version 3 in any letter case.
    let movement_named = |callee: &str| {
        movement_names.contains(callee) || (language_version >= 3 && movement_names.iter().any(|m| m.to_lowercase() == callee.to_lowercase()))
    };
    // File-level values, in source order: each may read the ones before it.
    let mut file_values: Vec<(&str, &RValue)> = Vec::new();
    for statement in &program.statements {
        match statement {
            Statement::Import(import) => {
                match &import.source {
                    ImportSource::Builtin { namespace } if namespace == "adapters" || namespace == "credentials" || namespace == "plugins" => {}
                    ImportSource::Builtin { namespace } => return Some(format!("import_from_{namespace}")),
                    ImportSource::File { .. } => return Some("import_from_file".into()),
                }
                for name in &import.names {
                    file_names.insert(name.alias.clone().unwrap_or_else(|| name.name.clone()));
                }
            }
            Statement::Assign(assign) => match &assign.value {
                RValue::Construct { construct } if movement_names.contains(&construct.callee) || plugin_named(&construct.callee) => {
                    return Some("file_call".into());
                }
                RValue::Construct { .. } => {
                    file_names.insert(assign.name.clone());
                    instances.insert(assign.name.clone());
                }
                // A call whose callee the file declares is a call, not the
                // built-in's value it would otherwise read as (run.ts
                // `resolvedRValue`), and a file has no event to make it about
                // (`fileLevelCall`).
                RValue::Call { call } if plugin_named(&call.callee) || movement_named(&call.callee) => {
                    return Some("file_call".into());
                }
                RValue::Expr { .. } | RValue::Call { .. } => {
                    file_names.insert(assign.name.clone());
                    file_values.push((&assign.name, &assign.value));
                }
                _ => return Some("file_assignment".into()),
            },
            // A declared shape binds its name at file scope (run.ts
            // `interpretFileStatement`); a `type` is the checker's alone. What
            // either declares is read by the constructs naming it, which are
            // walked (and refused) where they stand.
            Statement::Shape(shape) => {
                file_names.insert(shape.name.clone());
            }
            Statement::Type(declaration) => {
                file_names.insert(declaration.name.clone());
            }
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
    let none = BTreeSet::new();
    let shapes: BTreeSet<String> = program
        .statements
        .iter()
        .filter_map(|s| if let Statement::Shape(shape) = s { Some(shape.name.clone()) } else { None })
        .collect();
    let mut values = BTreeSet::new();
    for (name, value) in &file_values {
        let names = Names {
            events: &none,
            values: &values,
            handles: &none,
            nodes: &none,
            landings: &none,
            instances: BTreeSet::new(),
            body_instances: &none,
            file_names: &file_names,
            movements: &movement_names,
            plugins: &plugins,
            plugin_binds: &plugin_binds,
            extracts: &none,
            graphs: &none,
            shapes: &shapes,
            language_version,
        };
        if let Err(reason) = names.rvalue(value) {
            return Some(reason);
        }
        values.insert(name.to_string());
    }
    let file_values = values;
    // A declared shape's words are read in the file's scope once an
    // extraction asks for them.
    let file_scope = Names {
        events: &none,
        values: &file_values,
        handles: &none,
        nodes: &none,
        landings: &none,
        instances: BTreeSet::new(),
        body_instances: &none,
        file_names: &file_names,
        movements: &movement_names,
        plugins: &plugins,
        plugin_binds: &plugin_binds,
        extracts: &none,
        graphs: &none,
        shapes: &shapes,
        language_version,
    };
    for statement in &program.statements {
        if let Statement::Shape(shape) = statement
            && let Err(reason) = file_scope.shape_words(&shape.root)
        {
            return Some(reason);
        }
    }
    for movement in &movements {
        let params: BTreeSet<String> = movement.params.iter().map(|p| p.name.clone()).collect();
        let mut bound = Bound { plugin_binds: plugin_binds.clone(), events: params.clone(), ..Bound::default() };
        bound.collect(&movement.body, &[]);
        let events: BTreeSet<String> = params.union(&bound.event_aliases).cloned().collect();
        if bound.sites.iter().any(|(n, _, _)| params.contains(n) || file_names.contains(n)) {
            return Some("name_shadowed".into());
        }
        if bound.rebound() {
            return Some("name_rebound".into());
        }
        let values = bound.values.union(&file_values).cloned().collect();
        let names = Names {
            events: &events,
            values: &values,
            handles: &bound.handles,
            nodes: &bound.nodes,
            landings: &bound.landings,
            instances: instances.union(&bound.instances).cloned().collect(),
            body_instances: &bound.instances,
            file_names: &file_names,
            movements: &movement_names,
            plugins: &plugins,
            plugin_binds: &plugin_binds,
            extracts: &bound.extracts,
            graphs: &bound.graphs,
            shapes: &shapes,
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
    // Before a statement's k-th call: the call's step this engine does not
    // address (it keeps no call journal).
    if suspend_at.iter().any(|address| address.split('.').any(|step| step.starts_with('c'))) {
        return Some("suspend_at_call".into());
    }
    let plugins: BTreeSet<String> = program
        .statements
        .iter()
        .filter_map(|s| match s {
            Statement::Import(import) if matches!(&import.source, ImportSource::Builtin { namespace } if namespace == "plugins") => Some(import),
            _ => None,
        })
        .flat_map(|import| import.names.iter().map(|name| name.alias.clone().unwrap_or_else(|| name.name.clone())))
        .collect();
    if capped && program.statements.iter().any(|s| matches!(s, Statement::Movement(m) if priced_in_block(&m.body, false, &plugins))) {
        return Some("cost_cap_inside_block".into());
    }
    None
}

/// Whether a priced step sits in a traversal block's body, at any depth: a
/// write, a match that may ask the judge, an extraction, a plugin's call.
fn priced_in_block(statements: &[Statement], in_block: bool, plugins: &BTreeSet<String>) -> bool {
    let judged_link = |link: &ast::LinkExpression| matches!(link.to, ast::LinkTarget::Match { .. });
    statements.iter().any(|statement| match statement {
        Statement::Write(_) | Statement::Match(_) => in_block,
        Statement::Link(statement) => in_block && judged_link(&statement.link),
        Statement::Call(call) => in_block && plugins.contains(&call.callee),
        Statement::Assign(assign) => {
            in_block
                && match &assign.value {
                    RValue::Write { .. } | RValue::Match { .. } | RValue::Extract { .. } => true,
                    RValue::Link { link } => judged_link(link),
                    RValue::Call { call } => plugins.contains(&call.callee),
                    RValue::Construct { construct } => plugins.contains(&construct.callee),
                    _ => false,
                }
                || matches!(&assign.value, RValue::Block { block } if priced_in_block(&block.body, true, plugins))
        }
        Statement::If(statement) => {
            statement.arms.iter().any(|arm| priced_in_block(&arm.body, in_block, plugins))
                || statement.else_arm.as_ref().is_some_and(|arm| priced_in_block(&arm.body, in_block, plugins))
        }
        Statement::Block(statement) => priced_in_block(&statement.block.body, true, plugins),
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
    /// What a plain call of each plugin binds (`refusal`'s table).
    plugin_binds: BTreeMap<String, PluginBinds>,
    values: BTreeSet<String>,
    handles: BTreeSet<String>,
    instances: BTreeSet<String>,
    nodes: BTreeSet<String>,
    landings: BTreeSet<String>,
    /// An extraction's root, or an entity a head over one landed on.
    extracts: BTreeSet<String>,
    /// The nodes a `graph { … }` literal built (a subset of `nodes`), which
    /// may hold records of a system.
    graphs: BTreeSet<String>,
    /// The movement's parameters, which a bare-name alias may name.
    events: BTreeSet<String>,
    /// Second names for the event.
    event_aliases: BTreeSet<String>,
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
    Extracted,
    /// A second name for the event.
    Event,
}

impl Bound {
    /// What a plain plugin call binds, by its output (anything but a record
    /// is read as a value, and what it does not bind is refused where the
    /// call stands).
    fn plugin_kind(&self, callee: &str) -> Option<Kind> {
        match self.plugin_binds.get(callee)? {
            PluginBinds::Record => Some(Kind::Node),
            _ => Some(Kind::Value),
        }
    }

    fn collect(&mut self, statements: &[Statement], scope: &[usize]) {
        for statement in statements {
            match statement {
                Statement::Assign(assign) => {
                    let kind = match &assign.value {
                        RValue::Write { .. } | RValue::Match { .. } | RValue::Link { .. } => Kind::Handle,
                        RValue::Construct { construct } => self.plugin_kind(&construct.callee).unwrap_or(Kind::Instance),
                        RValue::Call { call } => match (self.plugin_kind(&call.callee), &call.expression) {
                            (Some(kind), _) => kind,
                            // A built-in's call is the expression it reads as.
                            (None, Some(expr)) => self.expression_kind(&expr.raw),
                            (None, None) => Kind::Value,
                        },
                        RValue::Node { node } => {
                            if node.graph.is_some() {
                                self.graphs.insert(assign.name.clone());
                            }
                            Kind::Node
                        }
                        RValue::Extract { .. } => Kind::Extracted,
                        RValue::Expr { expr } => {
                            if let Ok(Expression::Property { property_type_id: name } | Expression::AliasRef { name }) = lowered(&expr.raw)
                                && self.graphs.contains(&name)
                            {
                                self.graphs.insert(assign.name.clone());
                            }
                            self.expression_kind(&expr.raw)
                        }
                        _ => Kind::Value,
                    };
                    self.bind(&assign.name, kind, scope);
                    match &assign.value {
                        RValue::Write { write } => self.target_alias(&write.target, scope),
                        RValue::Match { r#match } => self.target_alias(&r#match.target, scope),
                        RValue::Block { block } => self.block(block, scope),
                        _ => {}
                    }
                }
                Statement::Write(statement) => self.target_alias(&statement.write.target, scope),
                Statement::Match(statement) => self.target_alias(&statement.r#match.target, scope),
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
                Statement::Block(statement) => self.block(&statement.block, scope),
                _ => {}
            }
        }
    }

    /// A block's hop alias and its body, in the block's own scope (its
    /// iteration's).
    fn block(&mut self, block: &TraversalBlock, scope: &[usize]) {
        let inner = self.enter(scope);
        // A head over what an extraction yielded lands on its entities.
        let over_extract = matches!(&block.head.root, Some(PathRoot::Name { name }) if self.extracts.contains(name));
        if let Ok(step) = crate::traverse::head_step(&block.head)
            && let Some(alias) = step.alias
        {
            self.bind(&alias, if over_extract { Kind::Extracted } else { Kind::Landing }, &inner);
        }
        self.collect(&block.body, &inner);
    }

    /// A target WHERE's hop alias (`crm-[c:companies WHERE c.\`region\` ==
    /// "EU"]->`): the candidate the WHERE reads, in a scope of its own.
    fn target_alias(&mut self, target: &WriteTarget, scope: &[usize]) {
        if let WriteTarget::Linked { path, .. } = target
            && let EdgeShape::One { where_: Some(TargetWhere { alias: Some(alias), .. }), .. } = edge_shape(path)
        {
            let inner = self.enter(scope);
            self.bind(&alias, Kind::Landing, &inner);
        }
    }

    /// What `x = <expression>` binds: a second name for a record
    /// (`aliasedNodeBinding`), the record a fold picks
    /// (`selectedPositionBinding`), or a value.
    fn expression_kind(&self, raw: &str) -> Kind {
        match lowered(raw) {
            Ok(Expression::Property { property_type_id: name } | Expression::AliasRef { name }) => self.kind_of(&name),
            Ok(expr) if selection(&expr).is_some() => Kind::Landing,
            _ => Kind::Value,
        }
    }

    /// What `name` was bound as before here: a record a bare-name alias
    /// names again, or else a value (the TypeScript's own reading).
    fn kind_of(&self, name: &str) -> Kind {
        if self.events.contains(name) {
            return Kind::Event;
        }
        match self.sites.iter().rev().find(|(n, _, _)| n == name).map(|(_, kind, _)| *kind) {
            Some(kind @ (Kind::Handle | Kind::Node | Kind::Landing | Kind::Extracted | Kind::Event)) => kind,
            _ => Kind::Value,
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
            Kind::Extracted => &mut self.extracts,
            Kind::Event => &mut self.event_aliases,
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
    /// The plugins the file imports, by local name.
    plugins: &'n BTreeSet<String>,
    /// What a plain call of each binds.
    plugin_binds: &'n BTreeMap<String, PluginBinds>,
    /// What extractions yielded: a root, or an entity a head landed on.
    extracts: &'n BTreeSet<String>,
    /// The nodes a `graph { … }` literal built.
    graphs: &'n BTreeSet<String>,
    /// The node declarations the file makes.
    shapes: &'n BTreeSet<String>,
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
                RValue::Match { r#match } => self.match_(r#match),
                RValue::Link { link } => self.link(link),
                // A bound block: what its iterations return is the binding.
                RValue::Block { block } => self.block(block),
                RValue::Await { r#await } => sleep(&r#await.source),
                RValue::Construct { construct } if self.movements.contains(&construct.callee) => refuse("movement_call"),
                RValue::Construct { construct } if self.plugin(&construct.callee) => {
                    self.plugin_invocation(&construct.callee, construct.args.iter().map(|a| Some(&a.value)))
                }
                RValue::Extract { extract } => self.extract(extract),
                RValue::Construct { .. } => Ok(()),
                RValue::Node { node } => self.node(node, node.graph.is_some()),
                RValue::Expr { expr } => self.assigned(expr),
                RValue::Call { call } if !self.plugin(&call.callee) => self.assigned(self.builtin_value(call)?),
                other => self.rvalue(other),
            },
            // A returned call's value is the TypeScript's to hand back.
            Statement::Return(ret) => match &ret.value {
                RValue::Call { call } if self.plugin(&call.callee) => refuse("plugin_call"),
                other => self.rvalue(other),
            },
            Statement::Write(statement) => self.write(&statement.write),
            Statement::Match(statement) => self.match_(&statement.r#match),
            Statement::Link(statement) => self.link(&statement.link),
            Statement::Unlink(statement) => {
                if self.handles.contains(&statement.from) && self.handles.contains(&statement.to) { Ok(()) } else { refuse("link_endpoint_not_handle") }
            }
            Statement::Delete(statement) => {
                if self.handles.contains(&statement.name) || self.landings.contains(&statement.name) { Ok(()) } else { refuse("delete_not_record") }
            }
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
            Statement::Block(statement) => self.block(&statement.block),
            Statement::Error(statement) => self.slot(&statement.message),
            Statement::Call(call) if self.plugin(&call.callee) => self.plugin_call(call),
            other => refuse(format!("statement:{}", statement_kind(other))),
        }
    }

    /// A traversal block over an adapter edge (crate::traverse): one hop
    /// off a constructed instance, a write's handle, the event or an
    /// enclosing block's hop alias (a nested block), its WHERE
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
        if self.values.contains(root) {
            return refuse("block_head_value_root");
        }
        if self.extracts.contains(root) {
            return self.extract_head(root, head);
        }
        if self.nodes.contains(root) {
            return refuse("block_head_node_root");
        }
        let held = self.instances.contains(root) || self.handles.contains(root) || self.events.contains(root) || self.landings.contains(root);
        if !held {
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
        refuse_meta_edge(&step.edge_type_id)?;
        if let Some(filter) = &step.expression_filter {
            self.scoped(filter)?;
        }
        if let Some(key) = step.cardinality.as_ref().and_then(|c| c.order_by.as_deref()) {
            self.scoped(key)?;
        }
        Ok(())
    }

    /// A head over what an extraction yielded: one hop down one of its
    /// edges, as the TypeScript walks it (no WHERE, which it refuses, and no
    /// ORDER BY, LIMIT or direction, which it does not read).
    fn extract_head(&self, root: &str, head: &PathHead) -> Admitted {
        let probe = format!("{}{}.`__movement_engine_probe__`", crate::write::spell_name(root), head.hops_raw);
        let Ok(tree) = movement_parser::expr::parse_expression(&probe) else { return refuse("block_head_does_not_lower") };
        let Ok(walk) = movement_parser::lowering::lower_expression(&tree, &probe) else { return refuse("block_head_does_not_lower") };
        let steps = match &walk {
            Expression::Traverse { steps, .. } => steps,
            // A file read off one carries forward into a write as the very
            // descriptor, which crosses this engine's wire as a copy.
            Expression::ResourceTraverse { .. } => return refuse("block_head_resources"),
            _ => return refuse("block_head_does_not_lower"),
        };
        let [step] = steps.as_slice() else { return refuse("block_multi_hop") };
        let TraversalStep::Edge(step) = step else { return refuse("block_head_step") };
        if step.expression_filter.is_some() || step.cardinality.is_some() || step.direction != EdgeDirection::Outgoing {
            return refuse("block_head_extract_hop");
        }
        Ok(())
    }

    /// `x = <expression>`: a bare name of a record is a second name for it
    /// (`aliasedNodeBinding`), and `FIRST`/`LAST`/`ONLY` of a bare walk the
    /// record it picks (`selectedPositionBinding`), of one hop off a root a
    /// block head walks from.
    fn assigned(&self, slot: &ExprSlot) -> Admitted {
        let expr = lowered(&slot.raw)?;
        if let Expression::Property { property_type_id: name } | Expression::AliasRef { name } = &expr
            && self.is_record(name)
        {
            return Ok(());
        }
        if let Some((root, steps)) = selection(&expr) {
            if !self.walks_from(root) {
                return refuse("traversal_root");
            }
            let [TraversalStep::Edge(step)] = steps else { return refuse("select_multi_hop") };
            return self.hop(step);
        }
        self.expression(&expr)
    }

    /// The event, a handle, a landing, a node or an extraction's record.
    fn is_record(&self, name: &str) -> bool {
        self.events.contains(name) || self.handles.contains(name) || self.landings.contains(name) || self.nodes.contains(name) || self.extracts.contains(name)
    }

    /// A root an adapter walk starts from (crate::traverse `walk_start`).
    fn walks_from(&self, root: &str) -> bool {
        self.events.contains(root) || self.handles.contains(root) || self.landings.contains(root) || self.instances.contains(root)
    }

    /// One hop of a walk: an edge, its WHERE and ORDER BY key scoped at the
    /// landed record.
    fn hop(&self, step: &movement_parser::lowering::expression::EdgeStep) -> Admitted {
        refuse_meta_edge(&step.edge_type_id)?;
        // The hop's alias names the record it landed on, there.
        let mut landings = self.landings.clone();
        landings.extend(step.alias.iter().cloned());
        let at = Names { landings: &landings, instances: self.instances.clone(), ..*self };
        if let Some(filter) = &step.expression_filter {
            at.scoped(filter)?;
        }
        if let Some(key) = step.cardinality.as_ref().and_then(|c| c.order_by.as_deref()) {
            at.scoped(key)?;
        }
        Ok(())
    }

    /// A walk's hops off `root` (crate::traverse `walk_read`): off an
    /// extraction, plain hops down its result; off anything an adapter walk
    /// starts from, edges.
    fn walk_hops(&self, root: &str, steps: &[TraversalStep]) -> Admitted {
        if self.extracts.contains(root) {
            return steps.iter().try_for_each(|step| match step {
                TraversalStep::Edge(step) if step.expression_filter.is_none() => Ok(()),
                _ => refuse("walk_extract_hop"),
            });
        }
        if !self.walks_from(root) {
            return refuse("traversal_root");
        }
        steps.iter().try_for_each(|step| match step {
            TraversalStep::Edge(step) => self.hop(step),
            _ => refuse("traversal_step"),
        })
    }

    /// `EXISTS(root…)`: over a value, whether it holds one; over an
    /// extraction, plain hops down it; over anything an adapter walk starts
    /// from, edges; the WHERE scoped at each record reached.
    fn exists(&self, root: &str, steps: &[TraversalStep], where_: Option<&Expression>) -> Admitted {
        if self.values.contains(root) {
            return if steps.is_empty() && where_.is_none() { Ok(()) } else { refuse("exists_over_value") };
        }
        if self.extracts.contains(root) {
            for step in steps {
                match step {
                    TraversalStep::Edge(step) if step.expression_filter.is_none() && step.cardinality.is_none() => {}
                    _ => return refuse("exists_extract_hop"),
                }
            }
        } else if self.walks_from(root) {
            for step in steps {
                let TraversalStep::Edge(step) = step else { return refuse("exists_step") };
                self.hop(step)?;
            }
        } else if self.nodes.contains(root) {
            return refuse("exists_node");
        } else {
            return refuse("traversal_root");
        }
        match where_ {
            Some(where_) => self.scoped(where_),
            None => Ok(()),
        }
    }

    /// `name = <expression>`, or a built-in's call read as the expression it is.
    fn rvalue(&self, value: &RValue) -> Admitted {
        match value {
            RValue::Expr { expr } => self.slot(expr),
            RValue::Call { call } if self.plugin(&call.callee) => self.plugin_call(call),
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
        // A plugin's invocation (`llm.transforms.invoke`), which this engine
        // does not make yet.
        if self.plugin(&call.callee) {
            return Err("plugin_call".into());
        }
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

    fn plugin(&self, callee: &str) -> bool {
        names_plugin(self.plugins, callee, self.language_version)
    }

    /// A plugin's plain call (crate::plugin): spelled as imported (a callee
    /// in another letter case is the TypeScript's), named value arguments,
    /// an output the slice binds.
    fn plugin_call(&self, call: &CallStatement) -> Admitted {
        let args = call.args.iter().map(|arg| match arg {
            CallArg::Expr { name: Some(_), expr } => Some(expr),
            _ => None,
        });
        self.plugin_invocation(&call.callee, args)
    }

    fn plugin_invocation<'a>(&self, callee: &str, args: impl Iterator<Item = Option<&'a ExprSlot>>) -> Admitted {
        match self.plugin_binds.get(callee) {
            None | Some(PluginBinds::Unknown) => return refuse("plugin_call"),
            Some(PluginBinds::Records) => return refuse("plugin_call:records"),
            Some(PluginBinds::Value | PluginBinds::Record | PluginBinds::Nothing) => {}
        }
        for arg in args {
            let Some(slot) = arg else { return refuse("plugin_call_form") };
            self.slot(slot)?;
        }
        Ok(())
    }

    /// `x = extract from […] { tree }` (crate::extract): no tier (what a
    /// tier buys is the deployment's), the `from` slots and every word the
    /// tree writes walked as expressions, each `through` plugin's arguments
    /// too — a bare name there reads the entity's field of that name first,
    /// else a value the body binds.
    fn extract(&self, extract: &ast::ExtractExpression) -> Admitted {
        if extract.tier.is_some() {
            return refuse("extract_tier");
        }
        extract.from.iter().try_for_each(|slot| self.slot(slot))?;
        self.extract_stages(&extract.stages)
    }

    fn extract_stages(&self, stages: &[ast::ExtractStage]) -> Admitted {
        for stage in stages {
            for plugin in stage.through.iter().flatten() {
                if !self.plugins.contains(&plugin.plugin) {
                    return refuse("plugin_call");
                }
                for arg in &plugin.args {
                    let bare = crate::js::trim(&arg.value.raw);
                    if crate::js::is_identifier(bare) {
                        if self.holds_other_than_value(bare) {
                            return refuse("name_not_value");
                        }
                        continue;
                    }
                    self.slot(&arg.value)?;
                }
            }
            for field in &stage.fields {
                self.slot(&field.description)?;
            }
            for child in &stage.children {
                match child {
                    ast::ExtractNode::Inline(child) => {
                        self.slot(&child.description)?;
                        self.extract_stages(&child.stages)?;
                    }
                    ast::ExtractNode::Declared(child) => {
                        if let Some(words) = &child.description {
                            self.slot(words)?;
                        }
                        self.extract_stages(&child.stages)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// A declared shape's words, at every depth.
    fn shape_words(&self, shape: &ast::ShapeNode) -> Admitted {
        if let Some(words) = &shape.description {
            self.slot(words)?;
        }
        for field in &shape.fields {
            if let Some(words) = &field.description {
                self.slot(words)?;
            }
        }
        shape.children.iter().try_for_each(|child| self.shape_words(child))
    }

    /// A name bound to anything but a value: read bare, the TypeScript
    /// refuses it with an error of its own.
    fn holds_other_than_value(&self, name: &str) -> bool {
        !self.values.contains(name)
            && (self.events.contains(name)
                || self.handles.contains(name)
                || self.nodes.contains(name)
                || self.landings.contains(name)
                || self.extracts.contains(name)
                || self.instances.contains(name)
                || self.file_names.contains(name))
    }

    /// `CallScope.binds`: a name the file or the body binds, anywhere.
    fn binds(&self, name: &str) -> bool {
        self.events.contains(name)
            || self.extracts.contains(name)
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
            // `write m.k { … }`: the record a map holds, bound for the write
            // alone (run.ts `bindSlotValue`), which this engine does not.
            WriteTarget::Position { root: PathRoot::Expression { .. }, .. } => return refuse("write_position_member_path"),
            WriteTarget::Position { root: PathRoot::Name { name }, .. } => {
                if !self.handles.contains(name) && !self.landings.contains(name) {
                    return refuse("write_position_not_record");
                }
            }
            WriteTarget::Linked { path, .. } => self.target_path(path, "write")?,
        }
        for clause in &write.unique_by {
            unique_clause(&clause.predicate.raw)?;
        }
        for spread in write.spreads.iter().flatten() {
            if spread.path.is_some() {
                return refuse("write_spread_path");
            }
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

    /// A write's or a match's linked target: one edge off an instance, a
    /// handle, the event or a hop alias, its WHERE scoped at the candidate.
    fn target_path(&self, path: &PathHead, verb: &str) -> Admitted {
        let Some(PathRoot::Name { name: root }) = &path.root else { return refuse(format!("{verb}_root_expression")) };
        if self.nodes.contains(root) {
            return refuse(format!("{verb}_node_root"));
        }
        let held = self.instances.contains(root) || self.handles.contains(root) || self.events.contains(root) || self.landings.contains(root);
        if !held {
            return refuse(format!("{verb}_root_not_held"));
        }
        match edge_shape(path) {
            EdgeShape::One { edge, .. } if is_meta_edge(&edge) => refuse("traversal_meta_edge"),
            EdgeShape::One { where_: Some(where_), .. } => self.scoped(&where_.filter),
            EdgeShape::One { where_: None, .. } => Ok(()),
            EdgeShape::MultiHop | EdgeShape::Invalid(_) => refuse(format!("{verb}_multi_hop")),
        }
    }

    /// `match <target> { unique by (…) … }` (crate::verbs): a linked target in
    /// a system, keyed `unique by` clauses, field values the evaluator runs.
    fn match_(&self, m: &ast::MatchExpression) -> Admitted {
        match &m.target {
            WriteTarget::Linked { path, .. } => self.target_path(path, "match")?,
            WriteTarget::Tuple { .. } => return refuse("match_tuple"),
            WriteTarget::Position { .. } => return refuse("match_position"),
        }
        for clause in &m.unique_by {
            unique_clause(&clause.predicate.raw)?;
        }
        m.fields.iter().try_for_each(|field| self.slot(&field.value))
    }

    /// `link a -[:e]-> b` or `link a -[:e]-> { match body }`: the endpoints
    /// written handles (a link into a node this run built appends a landing,
    /// which this engine does not).
    fn link(&self, link: &ast::LinkExpression) -> Admitted {
        if self.nodes.contains(&link.from) {
            return refuse("link_node");
        }
        if !self.handles.contains(&link.from) {
            return refuse("link_endpoint_not_handle");
        }
        match &link.to {
            ast::LinkTarget::Handle { name } if self.handles.contains(name) => Ok(()),
            ast::LinkTarget::Handle { .. } => refuse("link_endpoint_not_handle"),
            ast::LinkTarget::Match { r#match, .. } => self.match_(r#match),
        }
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
            if spread.path.is_some() {
                return refuse("node_spread_path");
            }
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
        self.expression(&lowered(&slot.raw)?)
    }

    fn condition(&self, slot: &ExprSlot) -> Admitted {
        let Ok(tree) = movement_parser::expr::parse_expression(&slot.raw) else { return refuse("condition_does_not_lower") };
        match movement_parser::lowering::lower_condition(&tree, &slot.raw) {
            Ok(condition) => self.conjunct(&condition),
            Err(refusal) => refuse(lowering_refused(&refusal, "condition_does_not_lower")),
        }
    }

    fn conjunct(&self, condition: &MovementCondition) -> Admitted {
        match condition {
            MovementCondition::And { conjuncts } => conjuncts.iter().try_for_each(|c| self.conjunct(c)),
            MovementCondition::Expr { expr } => self.expression(expr),
            MovementCondition::IsTest { subject_raw, type_ } => {
                let subject = crate::js::trim(subject_raw);
                let declared = self.shapes.contains(&type_.graph) && type_.hops_raw.is_none();
                let typed_record = self.events.contains(subject) || self.handles.contains(subject) || self.landings.contains(subject);
                // A record a system describes is compared by its types,
                // which the checker's assignability decides.
                if declared && typed_record {
                    return refuse("is_test_declared_record");
                }
                if declared && self.graphs.contains(subject) {
                    return refuse("is_test_declared_graph");
                }
                Ok(())
            }
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
            Expression::Traverse { alias_root: Some(root), steps, expression } if steps.is_empty() && matches!(expression.as_ref(), Expression::Exists { .. }) => {
                let Expression::Exists { steps, where_ } = expression.as_ref() else { unreachable!("matched above") };
                self.exists(root, steps, where_.as_deref())
            }
            Expression::Traverse { expression, .. } if matches!(expression.as_ref(), Expression::Exists { .. }) => refuse("expression:exists"),
            // A walk read for a field, many-valued.
            Expression::Traverse { alias_root: Some(root), steps, expression } if !steps.is_empty() => match expression.as_ref() {
                Expression::Property { property_type_id } if property_type_id == movement_parser::lowering::POSITION_SENTINEL => {
                    refuse("walk_records")
                }
                Expression::Property { .. } | Expression::EdgeProperty { .. } => self.walk_hops(root, steps),
                _ => refuse("traversal_terminal"),
            },
            Expression::Aggregate { fn_, expression, order_by, .. } => self.aggregate(*fn_, expression, order_by.as_deref(), scoped),
            // The run's pinned instant; the acting user and the actor are
            // looked up, and the dispatch's bag is not the input's.
            Expression::Meta { key } if key == "current_date" || key == "current_timestamp" => Ok(()),
            Expression::Meta { key } => refuse(format!("meta:{key}")),
            // `x == null` of a name bound to anything but a value: answered by
            // the binding (`presenceCompare`).
            Expression::Compare { left, right, .. }
                if !scoped
                    && ((crate::filter::is_null_literal(right) && self.bound_non_value(left))
                        || (crate::filter::is_null_literal(left) && self.bound_non_value(right))) =>
            {
                Ok(())
            }
            Expression::Traverse { alias_root, steps, expression } => {
                let held = alias_root.as_ref().is_some_and(|root| {
                    self.events.contains(root)
                        || self.extracts.contains(root)
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
            // A plugin called in place, bound first from version 3
            // (checker/nested_calls.ts): its invocation.
            Expression::Function { fn_, .. } if names_plugin(self.plugins, fn_, self.language_version) => refuse("plugin_call"),
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

impl Names<'_> {
    /// A bare name bound to something that is not a value.
    fn bound_non_value(&self, expr: &Expression) -> bool {
        let (Expression::Property { property_type_id: name } | Expression::AliasRef { name }) = expr else { return false };
        !self.values.contains(name) && (self.is_record(name) || self.instances.contains(name))
    }

    /// `case 'aggregate'`: the folds over a value, a walk read for a field,
    /// or (`COUNT`) the records a walk lands on.
    fn aggregate(&self, fn_: AggregationFunction, inner: &Expression, order_by: Option<&Expression>, scoped: bool) -> Admitted {
        let records = crate::eval::is_records_walk(inner);
        match fn_ {
            AggregationFunction::Llm => refuse("aggregate:llm"),
            AggregationFunction::Count if records => {
                let Expression::Traverse { alias_root: Some(root), steps, .. } = inner else { unreachable!("a records walk is rooted") };
                self.walk_hops(root, steps)
            }
            // A record picked in place is a value only a binding can hold.
            _ if records => refuse("aggregate_records"),
            // ONLY's failure spells its expression back; a name is what it spells.
            AggregationFunction::Only if crate::eval::spelled_name(inner).is_none() => refuse("aggregate:only"),
            AggregationFunction::Sort => {
                if order_by.is_some_and(|key| !matches!(key, Expression::Property { .. } | Expression::AliasRef { .. })) {
                    return refuse("aggregate:sort_key");
                }
                self.walk(inner, scoped)
            }
            _ => self.walk(inner, scoped),
        }
    }
}

/// `aggregatedBarePath`: `FIRST`/`LAST`/`ONLY` of a bare walk, its root and
/// hops.
fn selection(expr: &Expression) -> Option<(&str, &[TraversalStep])> {
    let Expression::Aggregate { fn_: AggregationFunction::First | AggregationFunction::Last | AggregationFunction::Only, expression, .. } = expr else {
        return None;
    };
    if !crate::eval::is_records_walk(expression) {
        return None;
    }
    let Expression::Traverse { alias_root: Some(root), steps, .. } = expression.as_ref() else { return None };
    Some((root, steps))
}

/// Whether `callee` resolves to an imported plugin (`resolveCallee`): as
/// written, or from version 3 in any letter case, as a function does.
fn names_plugin(plugins: &BTreeSet<String>, callee: &str, language_version: u32) -> bool {
    plugins.contains(callee) || (language_version >= 3 && plugins.iter().any(|p| p.to_lowercase() == callee.to_lowercase()))
}

/// An expression slot, lowered.
fn lowered(raw: &str) -> Result<Expression, String> {
    let Ok(tree) = movement_parser::expr::parse_expression(raw) else { return Err("expression_does_not_lower".into()) };
    movement_parser::lowering::lower_expression(&tree, raw).map_err(|refusal| lowering_refused(&refusal, "expression_does_not_lower"))
}

/// A closure is not a value the shared tree lowers, yet from version 3 the
/// TypeScript engine runs a collection op written inside an expression, its
/// closure with it, by binding the call first (checker/nested_calls.ts): a
/// closure the lowering refuses is that construct, not the checker's miss.
fn lowering_refused(refusal: &movement_parser::lowering::LoweringRefusal, otherwise: &str) -> String {
    if refusal.code.as_deref() == Some(movement_parser::lowering::CLOSURE_POSITION_CODE) { "expression_closure".into() } else { otherwise.into() }
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
        let expr = lowered(&part.raw)?;
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

/// A `#`-prefixed edge names the engine's own meta references, which the
/// TypeScript read wrapper hands the adapter without restamping the
/// position; this engine does not run them.
fn is_meta_edge(edge: &str) -> bool {
    edge.starts_with('#')
}

fn refuse_meta_edge(edge: &str) -> Admitted {
    if is_meta_edge(edge) { refuse("traversal_meta_edge") } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRELUDE: &str = "import { email, attio } from adapters\nimport { dealflow_inbox, acme_main } from credentials\ninbox = email(credentials: dealflow_inbox)\ncrm = attio(credentials: acme_main)\n";

    fn refused(body: &str) -> Option<String> {
        let source = format!("{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}");
        let program = movement_parser::stmt::parse_program(&source, 3, false).expect("the test's program parses");
        refusal(&program, 3, &Plugins(None))
    }

    fn file(source: &str) -> Option<String> {
        let program = movement_parser::stmt::parse_program(source, 3, false).expect("the test's program parses");
        refusal(&program, 3, &Plugins(None))
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
            ("  v = 1\n  if EXISTS(v-[:deals]->) {\n    x = 1\n  }", "exists_over_value"),
            ("  co = write crm-[:companies]-> { name: \"a\" }\n  x = [co]", "name_not_value"),
            ("  x = \"${msg}\"", "name_not_value"),
            ("  x = AI(\"why?\")", "expression:llm"),
            ("  x = FIRST(crm-[:companies]->-[:deals]->)", "select_multi_hop"),
            ("  x = crm.`name`", "traversal_root"),
            ("  x = FIRST(crm-[:#foo]->)", "traversal_meta_edge"),
            ("  crm-[:#foo]-> {\n    y = 1\n  }", "traversal_meta_edge"),
            ("  write crm-[:#foo]-> { name: \"a\" }", "traversal_meta_edge"),
            ("  n = node { a: 1 }\n  x = n-[:replies]->.`subject`", "traversal_root"),
            ("  x = \"${FIRST(crm-[c:companies]->)}\"", "aggregate_records"),
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
            ("  held = { k: 1 }\n  write held.k { a: 1 }", "write_position_member_path"),
            ("  held = { k: 1 }\n  write crm-[:companies]-> { ...held.k }", "write_spread_path"),
            ("  held = { k: 1 }\n  g = graph { ...held.k }", "node_spread_path"),
            ("  held = { k: 1 }\n  write held.k-[:e]-> { a: 1 }", "write_root_expression"),
            ("  x = MAP([1], (v) => v)", "builtin_call_form"),
            ("  r = M(msg)", "function_call"),
        ] {
            assert_eq!(refused(body).as_deref(), Some(reason), "{body}");
        }
    }

    /// Main's v0.10.2–v0.10.9 language changes (the merge's port list): each
    /// construct this engine does not run is refused by a name of its own,
    /// and the scan rules the parser mirrors are admitted.
    #[test]
    fn refuses_mains_new_constructs_by_name_and_admits_its_scan_rules() {
        for (body, reason) in [
            ("  held = { k: 1 }\n  write held.k { a: 1 }", "write_position_member_path"),
            ("  held = { k: { name: \"a\" } }\n  write crm-[:companies]-> { ...held.k }", "write_spread_path"),
            ("  held = { k: { name: \"a\" } }\n  g = graph { ...held.k }", "node_spread_path"),
            ("  n = node { name: \"a\" }\n  write n { name: \"b\" }", "write_position_not_record"),
            ("  g = graph { name: \"a\", entries: { name: \"x\" } }\n  g-[e:entries]-> {\n    write e { name: \"b\" }\n  }", "block_head_node_root"),
            ("  g = graph { name: \"a\", entries: { name: \"x\" } }\n  if EXISTS(g-[:entries]->) {\n    x = 1\n  }", "exists_node"),
            ("  x = { all: MAP([msg.`subject`], (s) => UPPER(s)) }", "expression_closure"),
            ("  if COUNT(FILTER([msg.`subject`], (s) => s != \"\")) > 0 {\n    x = 1\n  }", "expression_closure"),
            ("  write crm-[c:companies]-> { unique by (`name` == AT(MAP([1], (v) => v), 0)) name: \"a\" }", "expression_closure"),
            ("  x = [MAP([1], f)]", "function:map"),
            ("  held = { k: { inner: msg.`subject` } }\n  x = held.k.inner", "traversal_terminal"),
            ("  rows = crm-[c:companies]-> {\n    return c\n  }", "name_not_value"),
            ("  co = write crm-[:companies]-> { name: \"a\" }\n  held = { k: co }", "name_not_value"),
        ] {
            assert_eq!(refused(body).as_deref(), Some(reason), "{body}");
        }
        assert_eq!(
            file(&format!("import {{ fetch_url }} from plugins\n{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n  x = fetch_url(url: fetch_url(url: msg.`text`))\n}}")).as_deref(),
            Some("plugin_call")
        );
        for body in [
            "  `a\\`b` = msg.`subject`\n  `c\\\\d` = \"${`a\\`b`}!\"\n  write crm-[:companies]-> { name: `c\\\\d` }",
            "  write crm-[:companies]-> { name: UPPER( # a \"quoted\" {aside}\n    msg.`subject`) }",
        ] {
            assert_eq!(refused(body), None, "{body}");
        }
    }

    /// Chunk 6A Task 4: aggregates, EXISTS, IS tests and whole-value reads
    /// of a record.
    #[test]
    fn admits_the_expression_tail() {
        for body in [
            "  x = JOIN(crm-[c:companies WHERE `stage` == \"Seed\" ORDER BY `name`]->.`name`, \", \")",
            "  n = COUNT(crm-[:companies]->)\n  total = SUM([1, 2]) + MAX([3]) + AVG([4])\n  s = SORT([2, 1], DESC)",
            "  top = FIRST(crm-[c:companies WHERE `name` == \"Acme\"]->)\n  if top == null { ERROR(\"none\") }\n  write top-[:notes]-> { body: top.`name` }",
            "  co = write crm-[:companies]-> { name: \"a\" }\n  if EXISTS(co-[n:notes WHERE `text` == \"b\"]->) {\n    x = 1\n  }",
            "  if EXISTS(msg-[:files]-> WHERE `name` CONTAINS \"pdf\") {\n    x = 1\n  }",
            "  if EXISTS(crm-[o:organization]->-[le:list_entries WHERE `listName` == \"P\"]->) {\n    x = 1\n  }",
            "  write crm-[c:companies WHERE EXISTS(c-[:deals]->)]-> { name: \"y\" }",
            "  v = msg.`subject`\n  if EXISTS(v) {\n    x = 1\n  }",
            "  m2 = msg\n  write crm-[:companies]-> { name: m2.`subject` }",
            "  if msg IS <inbox-[:message]->> {\n    x = 1\n  }",
            "  crm-[c:companies]-> {\n    doc = c\n    if doc IS <crm-[:company]->> {\n      x = COUNT(doc-[:deals]->)\n    }\n  }",
        ] {
            assert_eq!(refused(body), None, "{body}");
        }
        let declared = format!("{PRELUDE}node Note {{\n  title: <text>\n}}\nmovement m(msg: <inbox-[:message]->>) {{\n  d = node {{ title: \"t\" }}\n  if d IS <Note> {{\n    x = 1\n  }}\n}}");
        assert_eq!(file(&declared), None);
        // A second name for a second name of the event is the event.
        let aliased = format!("{PRELUDE}node Lead {{\n  name: <text>\n}}\nmovement m(msg: <inbox-[:message]->>) {{\n  m2 = `msg`\n  m3 = m2\n  if m3 IS <Lead> {{\n    x = 1\n  }}\n}}");
        assert_eq!(file(&aliased).as_deref(), Some("is_test_declared_record"));
    }

    #[test]
    fn admits_one_hop_blocks_whose_body_is_in_the_slice() {
        for body in [
            "  crm-[c:companies WHERE `name` == \"Acme\" ORDER BY `name` DESC LIMIT 2]-> {\n    write crm-[:notes]-> { body: c.`name` }\n  }",
            "  wanted = msg.`subject`\n  crm-[c:companies WHERE c.`name` == wanted AND `stage` != msg.`text`]-> {\n    n = c.`name`\n    if n != \"x\" {\n      write crm-[:notes]-> { body: n }\n    }\n    return n\n  }",
            "  co = write crm-[:companies]-> { name: \"a\" }\n  co-[d:deals]-> {\n    write crm-[:notes]-> { body: d.`title` }\n  }",
            "  msg-[a:attachments]-> {\n    write crm-[:notes]-> { body: a.`name` }\n  }",
            "  crm-[:companies]-> {\n    write crm-[:notes]-> { body: \"one\" }\n  }",
            "  names = crm-[c:companies]-> {\n    if c.`stage` == \"x\" {\n      return \"x\"\n    }\n    return c.`name`\n  }\n  write crm-[:notes]-> { body: \"${LENGTH(names)}\" }",
            "  crm-[c:companies]-> {\n    write crm-[:notes]-> { body: c.`name` }\n    c-[d:deals WHERE `title` != c.`name`]-> {\n      x = d.`title`\n      write crm-[:notes]-> { body: x }\n    }\n  }",
        ] {
            assert_eq!(refused(body), None, "{body}");
        }
    }

    #[test]
    fn refuses_each_block_construct_it_does_not_run_with_its_reason() {
        for (body, reason) in [
            ("  crm-[c:companies]-> {\n    await sleep(1h)\n  }", "block_park"),
            ("  crm-[c:companies]->-[d:deals]-> {\n    x = d.`title`\n  }", "block_multi_hop"),
            ("  v = 1\n  v-[c:companies]-> {\n    x = 1\n  }", "block_head_value_root"),
            ("  n = node { a: 1 }\n  n-[c:kids]-> {\n    x = 1\n  }", "block_head_node_root"),
            ("  crm-[c:companies]-> {\n    x = ONLY(c-[:deals]->.`name`)\n  }", "aggregate:only"),
            ("  crm-[c:companies ORDER BY c-[:owner]->]-> {\n    x = 1\n  }", "walk_records"),
            ("  crm-[c:companies WHERE `name` == @user_email]-> {\n    x = 1\n  }", "meta:user_email"),
            ("  crm-[c:companies]-> {\n    x = [c]\n  }", "name_not_value"),
            ("  x = crm-[c:companies]-> {\n    return c\n  }", "name_not_value"),
            ("  crm-[c:companies]-> {\n    x = c-[:deals]->\n  }", "walk_records"),
        ] {
            assert_eq!(refused(body).as_deref(), Some(reason), "{body}");
        }
    }

    #[test]
    fn admits_the_record_verbs_on_records_in_a_system() {
        for body in [
            "  co = match crm-[c:companies WHERE c.`region` == msg.`text`]-> { unique by (FUZZY `name`), name: msg.`subject` }\n  write crm-[:notes]-> { body: co.`name` }",
            "  match crm-[:companies WHERE `region` == \"EU\"]-> { unique by (`name`), name: \"a\" }",
            "  write crm-[c:companies WHERE c.`region` == \"EU\"]-> { unique by (`name`), name: \"a\" }",
            "  p = write crm-[:people]-> { name: \"a\" }\n  co = write crm-[:companies]-> { name: \"b\" }\n  link p -[:company]-> co\n  unlink p -[:company]-> co\n  delete co",
            "  co = write crm-[:companies]-> { name: \"b\" }\n  fund = link co -[:portfolio]-> { unique by (`name`), name: \"F\" }",
            "  crm-[c:companies]-> {\n    write c-[:notes]-> { body: c.`name` }\n    write c { stage: \"x\" }\n    delete c\n  }",
        ] {
            assert_eq!(refused(body), None, "{body}");
        }
    }

    #[test]
    fn refuses_each_record_verb_form_it_does_not_run_with_its_reason() {
        for (body, reason) in [
            ("  n = node { a: 1 }\n  link n -[:kids]-> n", "link_node"),
            ("  co = write crm-[:companies]-> { name: \"b\" }\n  link co -[:x]-> msg", "link_endpoint_not_handle"),
            ("  co = write crm-[:companies]-> { name: \"b\" }\n  unlink co -[:x]-> msg", "link_endpoint_not_handle"),
            ("  delete msg", "delete_not_record"),
            ("  write msg { a: 1 }", "write_position_not_record"),
            ("  n = node { a: 1 }\n  x = match n-[:kids]-> { unique by (`a`), a: 1 }", "match_node_root"),
            ("  x = match nowhere-[:kids]-> { unique by (`a`), a: 1 }", "match_root_not_held"),
            ("  x = match crm-[:companies]-> { unique by (`name` CONTAINS \"a\"), name: \"a\" }", "unique_by_without_key"),
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
        let matched = program("  crm-[c:companies]-> {\n    x = match crm-[:funds]-> { unique by (`name`), name: c.`name` }\n  }");
        assert_eq!(input_refusal(&matched, true, &[]).as_deref(), Some("cost_cap_inside_block"), "a match may ask the judge");
        assert_eq!(input_refusal(&in_block, false, &[]), None);
        assert_eq!(input_refusal(&outside, true, &[]), None);
        assert_eq!(input_refusal(&outside, false, &["s1.i0.s0".into()]).as_deref(), Some("suspend_at_inside_block"));
        assert_eq!(input_refusal(&outside, false, &["s1".into()]), None);
    }

    #[test]
    fn refuses_what_the_file_says_it_does_not_run() {
        let movement = "movement m(msg: <inbox-[:message]->>) {\n  x = 1\n}";
        assert_eq!(file(&format!("import {{ x }} from \"./lib.mov\"\n{movement}")).as_deref(), Some("import_from_file"));
        assert_eq!(file(&format!("{PRELUDE}r = extract from [\"a\"] {{\n  node n: \"n\" {{ a: \"a\" }}\n}}\n{movement}")).as_deref(), Some("file_assignment"));
        assert_eq!(file(&format!("{PRELUDE}movement v(n: <number[]>) {{\n  x = n\n}}\n{movement}")).as_deref(), Some("movement_value_param"));
        assert_eq!(file(&format!("{PRELUDE}{movement}")), None);
    }

    /// File-level declarations bind names and run nothing: a shape, a type,
    /// a plugin import and a value are admitted, and what reads them is
    /// walked where it stands.
    #[test]
    fn admits_file_level_declarations_and_refuses_by_name_what_reads_them() {
        let declared = format!(
            "import {{ fetch_url as fetch }} from plugins\n{PRELUDE}type Stage = <\"a\" | \"b\">\nrules = \"route infra\"\ntag = \"${{UPPER(rules)}}!\"\nnode Lead: \"a lead\" {{\n  name: <text> \"its name ${{rules}}\"\n  stage: <Stage>\n}}\n"
        );
        let with = |body: &str| file(&format!("{declared}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}"));
        for body in [
            "  x = 1",
            "  write crm-[:companies]-> { name: tag, stage: \"${rules} ${msg.`subject`}\" }",
            "  await sleep(1h)\n  y = tag",
            "  found = extract from [msg.`text`] {\n    node lead: <Lead>\n  }",
        ] {
            assert_eq!(with(body), None, "{body}");
        }
        for (body, reason) in [
            ("  page = fetch(url: msg.`text`)", "plugin_call"),
            ("  page = fetch()", "plugin_call"),
            // From version 3 a callee resolves in any letter case.
            ("  page = FETCH()", "plugin_call"),
            ("  fetch(url: msg.`text`)", "plugin_call"),
            ("  x = { page: fetch(msg.`text`) }", "plugin_call"),
            ("  g = graph<Lead> { name: \"a\" }", "graph_shape"),
            ("  if msg IS <Lead> {\n    x = 1\n  }", "is_test_declared_record"),
            ("  x = Lead", "name_not_value"),
            ("  Lead = 1", "name_shadowed"),
            ("  Stage = 1", "name_shadowed"),
            ("  tag = 1", "name_shadowed"),
            ("  fetch = 1", "name_shadowed"),
        ] {
            assert_eq!(with(body).as_deref(), Some(reason), "{body}");
        }
        let movement = "movement m(msg: <inbox-[:message]->>) {\n  x = 1\n}";
        // A file-level value reads only the file-level values before it.
        for (value, reason) in [("y = crm.`name`", "traversal_root"), ("y = later\nlater = 1", "name_not_value"), ("y = AI(\"why\")", "expression:llm")] {
            assert_eq!(file(&format!("{PRELUDE}{value}\n{movement}")).as_deref(), Some(reason), "{value}");
        }
        assert_eq!(file(&format!("import {{ fetch_url }} from plugins\n{PRELUDE}page = fetch_url()\n{movement}")).as_deref(), Some("file_call"));
        // A plugin or a movement called at file level, in either call form.
        for value in ["page = fetch_url(url: \"x\")", "page = FETCH_URL(url: \"x\")", "r = m(msg: 1)", "r = M(1)"] {
            assert_eq!(file(&format!("import {{ fetch_url }} from plugins\n{PRELUDE}{value}\n{movement}")).as_deref(), Some("file_call"), "{value}");
        }
    }

    /// The extraction keyword runs whole (chunk 6A Task 3b): its words, its
    /// `from` slots and its stages' plugin arguments are walked as
    /// expressions, a head over what it yielded walks one of its edges, and
    /// a field of an extracted entity reads as a record's.
    #[test]
    fn admits_extraction_and_refuses_by_name_what_it_does_not_run() {
        let plugins = format!("import {{ fetch_url }} from plugins\n{PRELUDE}");
        let with = |body: &str| file(&format!("{plugins}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}"));
        let tree = "  deals = extract from [msg.`text`, \"also ${msg.`subject`}\"] through [fetch_url(url: msg.`text`)] {\n    digest: \"a summary\"\n    node co: \"each company\" {\n      name: <text> \"its name\"\n      website: \"its site\"\n    } through [fetch_url(url: website)] {\n      summary: \"what it does\"\n    }\n  }";
        for after in [
            "",
            "\n  write crm-[:notes]-> { body: deals.`digest` }",
            "\n  deals-[c:co]-> {\n    write crm-[:companies]-> { unique by (`name`) name: c.`name`, summary: c.summary }\n    c-[p:people]-> {\n      x = p.`name`\n    }\n  }",
            "\n  if deals.`digest` != \"\" {\n    y = deals.digest\n  }",
        ] {
            assert_eq!(with(&format!("{tree}{after}")), None, "{after}");
        }
        for (after, reason) in [
            ("\n  x = [deals]", "name_not_value"),
            ("\n  x = deals-[c:co WHERE c.`name` == \"a\"]->.`name`", "walk_extract_hop"),
            ("\n  deals-[c:co WHERE `name` == \"x\"]-> {\n    x = 1\n  }", "block_head_extract_hop"),
            ("\n  deals-[c:co LIMIT 1]-> {\n    x = 1\n  }", "block_head_extract_hop"),
            ("\n  deals-[c:co]->-[p:people]-> {\n    x = 1\n  }", "block_multi_hop"),
            ("\n  msg-[f:_resources]-> {\n    x = 1\n  }", "block_head_resources"),
            ("\n  deals-[f:_resources WHERE type == \"FILE\"]-> {\n    x = 1\n  }", "block_head_resources"),
            ("\n  write crm-[:companies]-> { ...deals }", "write_spread_source"),
            ("\n  write deals { a: 1 }", "write_position_not_record"),
            ("\n  write deals-[:notes]-> { a: 1 }", "write_root_not_held"),
            ("\n  delete deals", "delete_not_record"),
            ("\n  deals-[c:co]-> {\n    write c { a: 1 }\n  }", "write_position_not_record"),
        ] {
            assert_eq!(with(&format!("{tree}{after}")).as_deref(), Some(reason), "{after}");
        }
        for (body, reason) in [
            ("  d = extract \"careful\" from [msg.`text`] {\n    a: \"a\"\n  }", "extract_tier"),
            ("  d = extract from [msg.`text`] {\n    a: \"${AI(\"why\")}\"\n  }", "expression:llm"),
            ("  d = extract from [SORT([msg.`text`], UPPER(\"a\"))] {\n    a: \"a\"\n  }", "aggregate:sort_key"),
            ("  d = extract from [msg.`text`] through [fetch_url(url: msg)] {\n    a: \"a\"\n  }", "name_not_value"),
            ("  d = extract from [msg.`text`] through [nowhere(url: msg.`text`)] {\n    a: \"a\"\n  }", "plugin_call"),
            ("  return extract from [msg.`text`] {\n    a: \"a\"\n  }", "rvalue:extract"),
        ] {
            assert_eq!(with(body).as_deref(), Some(reason), "{body}");
        }
        // A declared shape's words are walked in the file's scope.
        let shaped = |words: &str| file(&format!("{PRELUDE}node Lead {{\n  name: <text> \"{words}\"\n}}\nmovement m(msg: <inbox-[:message]->>) {{\n  x = 1\n}}"));
        assert_eq!(shaped("its name"), None);
        assert_eq!(shaped("its ${crm.`name`} name").as_deref(), Some("traversal_root"));
    }

    /// A plugin's plain call binds what the catalog snapshot declares it
    /// hands back, read off the input.
    #[test]
    fn admits_a_plugin_call_by_its_declared_output() {
        let specs: JsMap<PluginSpec> = serde_json::from_value(serde_json::json!({
            "fetch_url": { "args": ["url"], "priced": true, "output": { "kind": "value", "type": "text" } },
            "research": { "args": ["name"], "priced": true, "output": { "kind": "record", "fields": { "summary": "text" } } },
            "find_files": { "args": ["q"], "priced": false, "output": { "kind": "records", "fields": { "url": "text" } } },
        }))
        .unwrap();
        let with = |body: &str| {
            let source = format!("import {{ fetch_url, research, find_files }} from plugins\n{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}");
            let program = movement_parser::stmt::parse_program(&source, 3, false).expect("the test's program parses");
            refusal(&program, 3, &Plugins(Some(&specs)))
        };
        for body in [
            "  page = fetch_url(url: msg.`text`)\n  write crm-[:notes]-> { body: COALESCE(page, \"none\") }",
            "  more = research(name: msg.`subject`)\n  write crm-[:notes]-> { body: more.`summary` }",
            "  fetch_url(url: msg.`text`)",
            "  page = fetch_url()",
        ] {
            assert_eq!(with(body), None, "{body}");
        }
        for (body, reason) in [
            ("  found = find_files(q: msg.`text`)", "plugin_call:records"),
            ("  page = fetch_url(msg.`text`)", "plugin_call_form"),
            ("  page = fetch_url(url: TRIM(msg.`text`))", "plugin_call_form"),
            ("  page = FETCH_URL(url: msg.`text`)", "plugin_call"),
            ("  more = research(name: msg.`subject`)\n  x = [more]", "name_not_value"),
            ("  page = fetch_url(url: msg)", "name_not_value"),
            ("  return fetch_url(url: msg.`text`)", "rvalue:construct"),
        ] {
            assert_eq!(with(body).as_deref(), Some(reason), "{body}");
        }
        // A snapshot that does not say what the plugin hands back refuses
        // its call.
        let unknown = movement_parser::stmt::parse_program(&format!("import {{ fetch_url }} from plugins\n{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n  page = fetch_url(url: \"x\")\n}}"), 3, false).unwrap();
        assert_eq!(refusal(&unknown, 3, &Plugins(None)).as_deref(), Some("plugin_call"));
    }

    #[test]
    fn refuses_a_suspension_at_a_call_and_a_capped_priced_step_in_a_block() {
        let program = |body: &str| {
            let source = format!("import {{ fetch_url }} from plugins\n{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}");
            movement_parser::stmt::parse_program(&source, 3, false).expect("the test's program parses")
        };
        let extract = program("  crm-[c:companies]-> {\n    d = extract from [c.`name`] {\n      a: \"a\"\n    }\n  }");
        let call = program("  crm-[c:companies]-> {\n    fetch_url(url: c.`name`)\n  }");
        for in_block in [&extract, &call] {
            assert_eq!(input_refusal(in_block, true, &[]).as_deref(), Some("cost_cap_inside_block"));
            assert_eq!(input_refusal(in_block, false, &[]), None);
        }
        let outside = program("  page = fetch_url(url: msg.`text`)");
        assert_eq!(input_refusal(&outside, true, &[]), None);
        assert_eq!(input_refusal(&outside, false, &["s0.c0".into()]).as_deref(), Some("suspend_at_call"));
    }
}
