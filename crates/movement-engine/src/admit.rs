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
    self, AwaitSource, CallArg, CallStatement, ExprSlot, ImportSource, NodeEntry, NodeLiteral, ParamTypeRef, PathRoot, RValue, Statement,
    WriteExpression, WriteTarget,
};
use movement_parser::lowering::condition::MovementCondition;
use movement_parser::lowering::expression::{Expression, FilterOperator, ListElement, ObjectMember, StaticValue};

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
/// `capped`: the run has a cost cap, so no priced call may be reached (the
/// judge of a `unique by` write is one, and a run that meets its cap there
/// must suspend, which this engine cannot yet).
pub fn refusal(program: &ast::Program, language_version: u32, capped: bool) -> Option<String> {
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
        bound.collect(&movement.body);
        let body_names: Vec<&String> =
            bound.values.iter().chain(&bound.handles).chain(&bound.instances).chain(&bound.nodes).collect();
        if body_names.iter().any(|n| events.contains(*n) || file_names.contains(*n)) {
            return Some("name_shadowed".into());
        }
        if body_names.iter().collect::<BTreeSet<_>>().len() != body_names.len() {
            return Some("name_rebound".into());
        }
        let names = Names {
            events: &events,
            values: &bound.values,
            handles: &bound.handles,
            nodes: &bound.nodes,
            instances: instances.union(&bound.instances).cloned().collect(),
            body_instances: &bound.instances,
            file_names: &file_names,
            movements: &movement_names,
            language_version,
            capped,
        };
        if let Err(reason) = names.body(&movement.body) {
            return Some(reason);
        }
    }
    None
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

/// Every name a body binds, by what it holds; `if` arms included.
#[derive(Default)]
struct Bound {
    values: BTreeSet<String>,
    handles: BTreeSet<String>,
    instances: BTreeSet<String>,
    nodes: BTreeSet<String>,
}

impl Bound {
    fn collect(&mut self, statements: &[Statement]) {
        for statement in statements {
            match statement {
                Statement::Assign(assign) => {
                    let into = match &assign.value {
                        RValue::Write { .. } => &mut self.handles,
                        RValue::Construct { .. } => &mut self.instances,
                        RValue::Node { .. } => &mut self.nodes,
                        _ => &mut self.values,
                    };
                    into.insert(assign.name.clone());
                }
                Statement::If(statement) => {
                    for arm in &statement.arms {
                        self.collect(&arm.body);
                    }
                    if let Some(arm) = &statement.else_arm {
                        self.collect(&arm.body);
                    }
                }
                _ => {}
            }
        }
    }
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
    /// The file's constructed instances and the body's.
    instances: BTreeSet<String>,
    body_instances: &'n BTreeSet<String>,
    /// Every name the file binds: imports, instances, movements.
    file_names: &'n BTreeSet<String>,
    movements: &'n BTreeSet<String>,
    language_version: u32,
    capped: bool,
}

impl Names<'_> {
    fn body(&self, statements: &[Statement]) -> Admitted {
        statements.iter().try_for_each(|statement| self.statement(statement))
    }

    fn statement(&self, statement: &Statement) -> Admitted {
        match statement {
            Statement::Assign(assign) => match &assign.value {
                RValue::Write { write } => self.write(write),
                RValue::Await { r#await } => sleep_only(&r#await.source),
                RValue::Construct { construct } if self.movements.contains(&construct.callee) => refuse("movement_call"),
                RValue::Construct { .. } => Ok(()),
                RValue::Node { node } => self.node(node, node.graph.is_some()),
                other => self.rvalue(other),
            },
            Statement::Return(ret) => self.rvalue(&ret.value),
            Statement::Write(statement) => self.write(&statement.write),
            Statement::Await(statement) => sleep_only(&statement.r#await.source),
            Statement::If(statement) => {
                for arm in &statement.arms {
                    self.condition(&arm.condition)?;
                    self.body(&arm.body)?;
                }
                match &statement.else_arm {
                    Some(arm) => self.body(&arm.body),
                    None => Ok(()),
                }
            }
            other => refuse(format!("statement:{}", statement_kind(other))),
        }
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
        if self.capped && !write.unique_by.is_empty() {
            return refuse("cost_cap_with_priced_call");
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
        let each = |items: &[Expression]| items.iter().try_for_each(|e| self.expression(e));
        match expr {
            Expression::AliasRef { name } | Expression::Property { property_type_id: name } => {
                if self.values.contains(name) { Ok(()) } else { refuse("name_not_value") }
            }
            Expression::Traverse { alias_root, steps, expression } => {
                let held = alias_root.as_ref().is_some_and(|root| {
                    self.events.contains(root) || self.values.contains(root) || self.handles.contains(root) || self.nodes.contains(root)
                });
                if !held {
                    return refuse("traversal_root");
                }
                if !steps.is_empty() {
                    return refuse("traversal_steps");
                }
                match expression.as_ref() {
                    Expression::Property { .. } => Ok(()),
                    _ => refuse("traversal_terminal"),
                }
            }
            Expression::Static { value: StaticValue::Number(n) } => {
                if n.0.is_finite() && !(n.0 == 0.0 && n.0.is_sign_negative()) { Ok(()) } else { refuse("static_number") }
            }
            Expression::Static { .. } => Ok(()),
            Expression::At { expression, index } => {
                self.expression(expression)?;
                self.expression(index)
            }
            Expression::List { elements } => elements.iter().try_for_each(|element| match element {
                ListElement::Expression(e) => self.expression(e),
                ListElement::Spread(spread) => self.expression(&spread.expression),
            }),
            Expression::Object { entries } => entries.iter().try_for_each(|member| match member {
                ObjectMember::Entry { key, .. } if key == "__proto__" => refuse("proto_key"),
                ObjectMember::Entry { value, .. } => self.expression(value),
                ObjectMember::Spread(spread) => self.expression(&spread.expression),
            }),
            Expression::Concat { parts } => each(parts),
            Expression::Conditional { condition, then, else_ } => {
                self.expression(condition)?;
                self.expression(then)?;
                self.expression(else_)
            }
            Expression::Compare { op: FilterOperator::Within, .. } => refuse("within_compare"),
            Expression::Compare { left, right, .. } | Expression::Arithmetic { left, right, .. } => {
                self.expression(left)?;
                self.expression(right)
            }
            Expression::Logical { operands, .. } => each(operands),
            Expression::Not { expression } | Expression::Negate { expression } => self.expression(expression),
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
        refusal(&program, 3, false)
    }

    fn file(source: &str) -> Option<String> {
        let program = movement_parser::stmt::parse_program(source, 3, false).expect("the test's program parses");
        refusal(&program, 3, false)
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
    fn refuses_what_the_file_says_it_does_not_run() {
        let movement = "movement m(msg: <inbox-[:message]->>) {\n  x = 1\n}";
        assert_eq!(file(&format!("{PRELUDE}type Stage = <\"a\" | \"b\">\n{movement}")).as_deref(), Some("file_statement:type"));
        assert_eq!(file(&format!("import {{ x }} from \"./lib.mov\"\n{movement}")).as_deref(), Some("import_from_file"));
        assert_eq!(file(&format!("{PRELUDE}y = 1\n{movement}")).as_deref(), Some("file_assignment"));
        assert_eq!(file(&format!("{PRELUDE}movement v(n: <number[]>) {{\n  x = n\n}}\n{movement}")).as_deref(), Some("movement_value_param"));
        assert_eq!(file(&format!("{PRELUDE}{movement}")), None);
    }

    #[test]
    fn a_capped_run_refuses_a_priced_call_and_nothing_else() {
        let capped = |body: &str| {
            let source = format!("{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}");
            let program = movement_parser::stmt::parse_program(&source, 3, false).expect("the test's program parses");
            refusal(&program, 3, true)
        };
        let identity = "  write crm-[:companies]-> { unique by (`name`) name: msg.`subject` }";
        assert_eq!(capped(identity).as_deref(), Some("cost_cap_with_priced_call"));
        assert_eq!(refused(identity), None);
        assert_eq!(capped("  write crm-[:companies]-> { name: msg.`subject` }"), None);
    }
}
