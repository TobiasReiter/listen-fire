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
//! spread in, a record compared by identity, a
//! field that is `Object.prototype`'s) cannot be known from the text, and
//! stays a documented mid-run failure (the README's "Errors a run can meet
//! mid-run"). What needs the checker's stamps is refused after the check
//! and before any effect (`run::Run::stamp_decline`).

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use movement_parser::ast::{
    self, ArmExpression, CollectionOp, AwaitSource, CallArg, CallStatement, CollectionOpExpression, ExprSlot, ImportSource, NodeEntry, NodeLiteral, ParamTypeRef,
    PathHead, PathRoot, RValue, Statement, TraversalBlock, WriteExpression, WriteTarget, UntilCondition, CombinatorArms, CallbackSubject,
};
use movement_parser::catalog::types::{JsMap, PluginOutput, PluginSpec};
use movement_parser::lowering::expression::EdgeDirection;
use movement_parser::lowering::condition::MovementCondition;
use movement_parser::lowering::expression::{AggregationFunction, Expression, FilterOperator, ListElement, ObjectMember, StaticValue, TraversalStep};


use crate::write::{EdgeShape, TargetWhere, edge_shape};

/// The flat built-ins and namespaced members the evaluator runs
/// (crate::stdlib): an expression calling any other is refused.
const FUNCTIONS: [&str; 34] = [
    "file", "read", "isnull", "coalesce", "trim", "lower", "upper", "length", "abs", "round", "floor", "ceil", "tostring", "tonumber", "multi", "split",
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

/// A language version this release does not support, refused by that name
/// before the parse or any construct's refusal reads the program: the
/// TypeScript engine refuses it with its own message, naming the version and
/// the fix. Every construct refusal below is for a supported version.
pub fn version_refusal(language_version: u32) -> Option<String> {
    if movement_parser::version::SUPPORTED_LANGUAGE_VERSIONS.contains(&language_version) {
        None
    } else {
        Some("language_version_unsupported".into())
    }
}

/// The movement a segment runs (`selectMovement`): the one named, exactly
/// or from version 3 in any letter case (the fired name is a function's),
/// else the file's only movement. `None` when none is picked, and the run
/// throws MOVENG_NOT_FOUND after the check, on either engine.
pub fn entry_of<'m>(movements: &[&'m ast::MovementDeclaration], wanted: Option<&str>, language_version: u32) -> Option<&'m ast::MovementDeclaration> {
    match wanted.filter(|w| !w.is_empty()) {
        Some(wanted) => movements.iter().find(|m| m.name == wanted).or_else(|| {
            (language_version >= 3).then(|| movements.iter().find(|m| crate::js::to_lower_case(&m.name) == crate::js::to_lower_case(wanted))).flatten()
        }),
        None if movements.len() == 1 => movements.first(),
        None => None,
    }
    .copied()
}

/// The movements a run of `entry` can execute, in source order: the entry
/// and every movement a reached body names, transitively. Either engine
/// enters a movement's body only by resolving a name the running body
/// wrote — a call's callee (run.ts `runCall`), a combinator's named arm
/// (`armBodyAt`, `movementDeclaration`), a movement handed where a closure
/// goes (`closureOf`) — and a name is lexical (`resolveCallee`,
/// `Environment.resolve`), so a movement no reached body spells is never
/// run. A body spells a name in a structured field (a callee, an arm) or
/// inside a slot's verbatim text; every one of both is read here, in any
/// letter case, a string literal's words included, so the set is never
/// smaller than what can run. With no entry picked every movement is
/// walked.
pub fn reachable<'p>(program: &'p ast::Program, entry: Option<&str>, language_version: u32) -> Vec<&'p ast::MovementDeclaration> {
    let movements: Vec<&ast::MovementDeclaration> =
        program.statements.iter().filter_map(|s| if let Statement::Movement(m) = s { Some(m) } else { None }).collect();
    let Some(entry) = entry_of(&movements, entry, language_version) else { return movements };
    let mut reached = vec![entry];
    let mut next = 0;
    while let Some(movement) = reached.get(next).copied() {
        // A tree that does not serialise is read as naming every movement.
        let Some(spelled) = names_spelled(movement) else { return movements };
        for other in &movements {
            if !reached.iter().any(|r| std::ptr::eq(*r, *other)) && spelled.contains(&crate::js::to_lower_case(&other.name)) {
                reached.push(other);
            }
        }
        next += 1;
    }
    movements.into_iter().filter(|m| reached.iter().any(|r| std::ptr::eq(*r, *m))).collect()
}

/// Every name `movement` spells, lowercased: each string the AST holds
/// whole (a structured name) and each name the shared scan reads in it (a
/// slot's text, bare or backtick-quoted).
fn names_spelled(movement: &ast::MovementDeclaration) -> Option<BTreeSet<String>> {
    fn strings(value: &serde_json::Value, names: &mut BTreeSet<String>) {
        match value {
            serde_json::Value::String(text) => {
                names.insert(crate::js::to_lower_case(text));
                let units: Vec<u16> = text.encode_utf16().collect();
                let mut at = 0;
                while at < units.len() {
                    match movement_parser::scan::scan_name(&units, at) {
                        Some((name, end)) => {
                            names.insert(crate::js::to_lower_case(&name));
                            at = end;
                        }
                        None => at += 1,
                    }
                }
            }
            serde_json::Value::Array(items) => items.iter().for_each(|item| strings(item, names)),
            serde_json::Value::Object(members) => members.values().for_each(|member| strings(member, names)),
            _ => {}
        }
    }
    let mut names = BTreeSet::new();
    strings(&serde_json::to_value(movement).ok()?, &mut names);
    Some(names)
}

/// Every reason the walk meets, deduplicated, in the order it meets them.
#[derive(Default)]
struct Reasons(RefCell<Vec<String>>);

impl Reasons {
    fn note(&self, reason: impl Into<String>) {
        let reason = reason.into();
        let mut reasons = self.0.borrow_mut();
        if !reasons.contains(&reason) {
            reasons.push(reason);
        }
    }

    fn noted(&self, admitted: Admitted) {
        if let Err(reason) = admitted {
            self.note(reason);
        }
    }
}

/// Why this engine does not run `program`: every reason, in the order the
/// walk meets them, empty when it runs it. The first is the one a walk that
/// stopped at it would have given; the rest are what it would have hidden
/// (each statement is walked whatever the one before it needed). The file's
/// declarations and values are walked whole (`prepareMovement` binds every
/// one), and of its movements those in `movements` (`reachable`). A cost
/// cap refuses nothing: a run that meets it suspends (crate::park).
pub fn refusals(
    program: &ast::Program,
    movements: &[&ast::MovementDeclaration],
    entry: Option<&ast::MovementDeclaration>,
    language_version: u32,
    catalog: &Plugins<'_>,
) -> Admission {
    let reasons = Reasons::default();
    let mut file_names = BTreeSet::new();
    let mut instances = BTreeSet::new();
    let mut plugins = BTreeSet::new();
    // What a plain call of each imported plugin binds, by its local name.
    let mut plugin_binds: BTreeMap<String, PluginBinds> = BTreeMap::new();
    for statement in &program.statements {
        if let Statement::Import(import) = statement
            && matches!(&import.source, ImportSource::Builtin { namespace } if namespace == "plugins")
        {
            for name in &import.names {
                let local = name.alias.clone().unwrap_or_else(|| name.name.clone());
                plugin_binds.insert(local.clone(), catalog.binds(&name.name, language_version));
                plugins.insert(local);
            }
        }
    }
    let callees = Callees::of(program, &plugin_binds, language_version);
    let movement_names: BTreeSet<String> =
        program.statements.iter().filter_map(|s| if let Statement::Movement(m) = s { Some(m.name.clone()) } else { None }).collect();
    let plugin_named = |callee: &str| names_plugin(&plugins, callee, language_version);
    // `resolveCallee`: as written, or from version 3 in any letter case.
    let movement_named = |callee: &str| {
        movement_names.contains(callee) || (language_version >= 3 && movement_names.iter().any(|m| crate::js::to_lower_case(m) == crate::js::to_lower_case(callee)))
    };
    // File-level values, in source order: each may read the ones before it.
    // One already refused binds its name and is not walked again.
    let mut file_values: Vec<(&str, Option<&RValue>)> = Vec::new();
    for statement in &program.statements {
        match statement {
            Statement::Import(import) => {
                match &import.source {
                    ImportSource::Builtin { namespace } if namespace == "adapters" || namespace == "credentials" || namespace == "plugins" => {}
                    ImportSource::Builtin { namespace } => reasons.note(format!("import_from_{namespace}")),
                    ImportSource::File { .. } => reasons.note("import_from_file"),
                }
                for name in &import.names {
                    file_names.insert(name.alias.clone().unwrap_or_else(|| name.name.clone()));
                }
            }
            Statement::Assign(assign) => {
                file_names.insert(assign.name.clone());
                match &assign.value {
                    RValue::Construct { construct } if movement_names.contains(&construct.callee) || plugin_named(&construct.callee) => {
                        reasons.note("file_call");
                        file_values.push((&assign.name, None));
                    }
                    RValue::Construct { .. } => {
                        instances.insert(assign.name.clone());
                    }
                    // A call whose callee the file declares is a call, not the
                    // built-in's value it would otherwise read as (run.ts
                    // `resolvedRValue`), and a file has no event to make it about
                    // (`fileLevelCall`).
                    RValue::Call { call } if plugin_named(&call.callee) || movement_named(&call.callee) => {
                        reasons.note("file_call");
                        file_values.push((&assign.name, None));
                    }
                    RValue::Expr { .. } | RValue::Call { .. } => file_values.push((&assign.name, Some(&assign.value))),
                    _ => {
                        reasons.note("file_assignment");
                        file_values.push((&assign.name, None));
                    }
                }
            }
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
                file_names.insert(movement.name.clone());
            }
            other => reasons.note(format!("file_statement:{}", statement_kind(other))),
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
        if let Some(value) = value {
            let names = Names {
                reasons: &reasons,
                events: &none,
                values: &values,
                handles: &none,
                nodes: &none,
                landings: &none,
                members: &none,
                lazies: &none,
                instances: BTreeSet::new(),
                body_instances: &none,
                file_names: &file_names,
                movements: &movement_names,
                plugins: &plugins,
                plugin_binds: &plugin_binds,
                extracts: &none,
                graphs: &none,
                shapes: &shapes,
                callees: &callees,
                unknown_calls: &[],
                language_version,
                value_holders: &callees.file_holders,
                record_nodes: &none,
            };
            reasons.noted(names.rvalue(value));
        }
        values.insert(name.to_string());
    }
    let file_values = values;
    // A declared shape's words are read in the file's scope once an
    // extraction asks for them.
    let file_scope = Names {
        reasons: &reasons,
        events: &none,
        values: &file_values,
        handles: &none,
        nodes: &none,
        landings: &none,
        members: &none,
        lazies: &none,
        instances: BTreeSet::new(),
        body_instances: &none,
        file_names: &file_names,
        movements: &movement_names,
        plugins: &plugins,
        plugin_binds: &plugin_binds,
        extracts: &none,
        graphs: &none,
        shapes: &shapes,
        callees: &callees,
        unknown_calls: &[],
        language_version,
        value_holders: &callees.file_holders,
        record_nodes: &none,
    };
    for statement in &program.statements {
        if let Statement::Shape(shape) = statement {
            reasons.noted(file_scope.shape_words(&shape.root));
        }
    }
    let mut called: Vec<(String, Vec<String>)> = Vec::new();
    for walk in walks(&callees, movements, entry) {
        let movement = walk.movement;
        if walk.called && entry.is_some() {
            let params = movement.params.iter().zip(&walk.signature).filter(|(_, k)| **k == Kind::Event).map(|(p, _)| p.name.clone());
            match called.iter_mut().find(|(m, _)| *m == movement.name) {
                Some((_, known)) => {
                    for param in params {
                        if !known.contains(&param) {
                            known.push(param);
                        }
                    }
                }
                None => called.push((movement.name.clone(), params.collect())),
            }
        }
        // A movement no call reaches takes its parameters as the event: one
        // taking a value can only be entered by what is refused elsewhere.
        if !walk.called && movement.params.iter().any(|p| matches!(p.type_, Some(ParamTypeRef::Value(_)))) {
            reasons.note("movement_value_param");
        }
        let params: BTreeSet<String> = movement.params.iter().map(|p| p.name.clone()).collect();
        let bound = callees.bound(movement, &walk.signature, Vec::new());
        let events: BTreeSet<String> = bound.events.union(&bound.event_aliases).cloned().collect();
        let shadows = |n: &String| params.contains(n) || file_names.contains(n);
        if bound.sites.iter().any(|(n, _, _)| shadows(n)) || bound.member_params.iter().any(|(n, _)| shadows(n)) {
            reasons.note("name_shadowed");
        }
        if bound.rebound() {
            reasons.note("name_rebound");
        }
        let values = bound.values.union(&file_values).cloned().collect();
        let value_holders = bound.value_holders();
        let names = Names {
            reasons: &reasons,
            events: &events,
            values: &values,
            handles: &bound.handles,
            nodes: &bound.nodes,
            landings: &bound.landings,
            members: &bound.members,
            lazies: &bound.lazies,
            instances: instances.union(&bound.instances).cloned().collect(),
            body_instances: &bound.instances,
            file_names: &file_names,
            movements: &movement_names,
            plugins: &plugins,
            plugin_binds: &plugin_binds,
            extracts: &bound.extracts,
            graphs: &bound.graphs,
            shapes: &shapes,
            callees: &callees,
            unknown_calls: &bound.unknown_calls,
            language_version,
            value_holders: &value_holders,
            record_nodes: &bound.record_nodes,
        };
        names.body(&movement.body, Within::Body);
    }
    Admission { reasons: reasons.0.into_inner(), called }
}

/// What admission found: why this engine does not run the program (empty
/// when it does), and the movements a run of the entry calls, each with the
/// parameters a call may bind to the event (`Run::stamp_decline` reads the
/// event's dated fields through them).
pub struct Admission {
    pub reasons: Vec<String>,
    pub called: Vec<(String, Vec<String>)>,
}

/// One movement as admission walks it: its parameters bound as a call
/// binds them, or (the entry, or a movement no call reaches) as the event.
struct Walk<'p> {
    movement: &'p ast::MovementDeclaration,
    signature: Signature,
    /// Entered by a call: it runs as a callee.
    called: bool,
}

/// What admission walks (`What admission walks`, the README): the entry,
/// each movement a walked body calls under each signature its calls give it,
/// transitively, and every other movement the entry reaches with its
/// parameters as the event — in source order, a movement's signatures in
/// the order met.
fn walks<'p>(callees: &'p Callees<'p>, movements: &[&'p ast::MovementDeclaration], entry: Option<&'p ast::MovementDeclaration>) -> Vec<Walk<'p>> {
    let as_event = |m: &ast::MovementDeclaration| vec![Kind::Event; m.params.len()];
    let mut walks: Vec<Walk<'p>> = match entry {
        Some(entry) => vec![Walk { movement: entry, signature: as_event(entry), called: false }],
        None => movements.iter().map(|m| Walk { movement: m, signature: as_event(m), called: false }).collect(),
    };
    let mut next = 0;
    while next < walks.len() {
        let bound = callees.bound(walks[next].movement, &walks[next].signature, Vec::new());
        for (callee, signature) in bound.calls {
            let Some(movement) = callees.movement(&callee) else { continue };
            if !walks.iter().any(|w| w.called && std::ptr::eq(w.movement, movement) && w.signature == signature) {
                walks.push(Walk { movement, signature, called: true });
            }
        }
        next += 1;
    }
    for movement in movements {
        if !walks.iter().any(|w| std::ptr::eq(w.movement, *movement)) {
            walks.push(Walk { movement, signature: as_event(movement), called: false });
        }
    }
    let order = |m: &ast::MovementDeclaration| callees.movements.iter().position(|d| std::ptr::eq(*d, m)).unwrap_or(usize::MAX);
    walks.sort_by_key(|w| order(w.movement));
    walks
}

/// Whether a movement keeps a walk anywhere: `x = lazy …`, or a `lazy`
/// entry in a node literal however deep. A body a construct admission
/// refuses where it stands (a combinator's arms, a callback's, a closure's)
/// is not looked into: no run reaches it.
fn holds_lazy(movement: &ast::MovementDeclaration) -> bool {
    fn statements(body: &[Statement]) -> bool {
        body.iter().any(|statement| match statement {
            Statement::Assign(ast::AssignStatement { value, .. }) | Statement::Return(ast::ReturnStatement { value, .. }) => rvalue(value),
            Statement::Call(call) => call_args(call),
            Statement::Block(statement) => statements(&statement.block.body),
            Statement::If(statement) => statement.arms.iter().any(|arm| statements(&arm.body)) || statement.else_arm.as_ref().is_some_and(|arm| statements(&arm.body)),
            Statement::Import(_)
            | Statement::Shape(_)
            | Statement::Type(_)
            | Statement::Movement(_)
            | Statement::Listen(_)
            | Statement::Write(_)
            | Statement::Match(_)
            | Statement::Link(_)
            | Statement::Unlink(_)
            | Statement::Delete(_)
            | Statement::Refresh(_)
            | Statement::Await(_)
            | Statement::Combinator(_)
            | Statement::Collection(_)
            | Statement::Error(_) => false,
        })
    }
    fn rvalue(value: &RValue) -> bool {
        match value {
            RValue::Lazy { .. } => true,
            RValue::Node { node } => node_literal(node),
            RValue::Call { call } => call_args(call),
            RValue::Block { block } => statements(&block.body),
            RValue::Construct { .. }
            | RValue::Write { .. }
            | RValue::Match { .. }
            | RValue::Link { .. }
            | RValue::Extract { .. }
            | RValue::ExtractCall { .. }
            | RValue::Await { .. }
            | RValue::Combinator { .. }
            | RValue::Collection { .. }
            | RValue::Members { .. }
            | RValue::InlineBlock { .. }
            | RValue::Callback { .. }
            | RValue::Closure { .. }
            | RValue::Expr { .. } => false,
        }
    }
    fn node_literal(node: &ast::NodeLiteral) -> bool {
        node.entries.iter().any(|entry| match entry {
            ast::NodeEntry::Traversal { lazy, mapping, .. } => *lazy || mapping.as_ref().is_some_and(node_literal),
            ast::NodeEntry::Nodes { nodes, .. } => nodes.iter().any(node_literal),
            ast::NodeEntry::Value { .. } | ast::NodeEntry::Declared { .. } => false,
        })
    }
    fn call_args(call: &CallStatement) -> bool {
        call.args.iter().any(|arg| match arg {
            CallArg::Node { node, .. } => node_literal(node),
            CallArg::Call { call, .. } => call_args(call),
            CallArg::Expr { .. } | CallArg::Write { .. } | CallArg::Closure { .. } | CallArg::Type { .. } => false,
        })
    }
    statements(&movement.body)
}



/// The closure bodies a statement holds in place: a combinator's literal
/// arms, a closure bound or returned, a callback's inline body, an
/// `until`'s condition.
fn closure_bodies(statement: &Statement) -> Vec<&ast::ClosureExpression> {
    fn combinator<'a>(c: &'a ast::CombinatorExpression, bodies: &mut Vec<&'a ast::ClosureExpression>) {
        if let CombinatorArms::Literal { arms, .. } = &c.arms {
            for arm in arms {
                if let ArmExpression::Closure { closure, .. } = arm {
                    bodies.push(closure);
                }
            }
        }
    }
    fn source<'a>(source: &'a AwaitSource, bodies: &mut Vec<&'a ast::ClosureExpression>) {
        match source {
            AwaitSource::Combinator { combinator: c, .. } => combinator(c, bodies),
            AwaitSource::Until { condition: UntilCondition::Closure { closure }, .. } => bodies.push(closure),
            _ => {}
        }
    }
    fn value<'a>(value: &'a RValue, bodies: &mut Vec<&'a ast::ClosureExpression>) {
        match value {
            RValue::Await { r#await } => source(&r#await.source, bodies),
            RValue::Combinator { combinator: c } => combinator(c, bodies),
            RValue::Closure { closure } => bodies.push(closure),
            RValue::Callback { callback } => {
                if let CallbackSubject::Inline { closure, .. } = &callback.subject {
                    bodies.push(closure);
                }
            }
            _ => {}
        }
    }
    let mut bodies = Vec::new();
    match statement {
        Statement::Await(statement) => source(&statement.r#await.source, &mut bodies),
        Statement::Combinator(statement) => combinator(&statement.combinator, &mut bodies),
        Statement::Assign(assign) => value(&assign.value, &mut bodies),
        Statement::Return(ret) => value(&ret.value, &mut bodies),
        _ => {}
    }
    bodies
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

/// The program's movements as callees: which one a call names, which of its
/// parameters take a value, and what it hands back under what a call passes
/// (each worked out once).
/// What each file-level binding holds: an instance is a system's, a value
/// is free of records when what it reads is (the file's values before it).
fn file_holders(program: &ast::Program) -> BTreeMap<String, Holder> {
    let mut holders: BTreeMap<String, Holder> = BTreeMap::new();
    for statement in &program.statements {
        let Statement::Assign(assign) = statement else { continue };
        let holder = match &assign.value {
            RValue::Construct { .. } => Holder::Record,
            RValue::Expr { expr } => match lowered(&expr.raw) {
                Ok(expr) if !may_hold_record(&expr, &|name| holders.get(name).copied().unwrap_or(Holder::Other)) => Holder::Free,
                _ => Holder::Other,
            },
            _ => Holder::Other,
        };
        holders.insert(assign.name.clone(), holder);
    }
    holders
}

struct Callees<'p> {
    movements: Vec<&'p ast::MovementDeclaration>,
    plugin_binds: &'p BTreeMap<String, PluginBinds>,
    /// The `type`s the file declares: a parameter typed by one takes a value.
    types: BTreeSet<String>,
    /// The names the file's scope binds (its imports, shapes, values,
    /// instances and movements): from version 3 one bound exactly is the
    /// callee a call names, even in another letter case than a movement's.
    file_scope: BTreeSet<String>,
    language_version: u32,
    returns: RefCell<Vec<((String, Signature), Option<Kind>)>>,
    /// The record kinds a value may hold at run time: a kept walk only where
    /// the program keeps one.
    held_kinds: Vec<Kind>,
    /// What each file-level binding holds, as far as a record goes.
    file_holders: BTreeMap<String, Holder>,
}

impl<'p> Callees<'p> {
    fn of(program: &'p ast::Program, plugin_binds: &'p BTreeMap<String, PluginBinds>, language_version: u32) -> Callees<'p> {
        let mut movements = Vec::new();
        let mut types = BTreeSet::new();
        let mut file_scope = BTreeSet::new();
        for statement in &program.statements {
            match statement {
                Statement::Movement(m) => {
                    file_scope.insert(m.name.clone());
                    movements.push(m);
                }
                Statement::Type(t) => {
                    types.insert(t.name.clone());
                }
                Statement::Import(import) => file_scope.extend(import.names.iter().map(|n| n.alias.clone().unwrap_or_else(|| n.name.clone()))),
                Statement::Shape(shape) => {
                    file_scope.insert(shape.name.clone());
                }
                Statement::Assign(assign) => {
                    file_scope.insert(assign.name.clone());
                }
                _ => {}
            }
        }
        let keeps_walks = movements.iter().any(|m| holds_lazy(m));
        let held_kinds = HELD_KINDS.iter().copied().filter(|k| *k != Kind::Lazy || keeps_walks).collect();
        let file_holders = file_holders(program);
        Callees { movements, plugin_binds, types, file_scope, language_version, returns: RefCell::default(), held_kinds, file_holders }
    }

    /// The movement declared as `name`, exactly.
    fn movement(&self, name: &str) -> Option<&'p ast::MovementDeclaration> {
        self.movements.iter().copied().find(|m| m.name == name)
    }

    /// `resolveCallee` (run.ts `calleeName`): the movement a call names —
    /// exactly, or from version 3 in any letter case unless the name is
    /// bound exactly to something else (`bound_in_body`: the calling body
    /// binds it).
    fn callee(&self, written: &str, bound_in_body: bool) -> Option<&'p ast::MovementDeclaration> {
        self.movement(written).or_else(|| {
            let bound = bound_in_body || self.file_scope.contains(written);
            (self.language_version >= 3 && !bound).then(|| self.movements.iter().copied().find(|m| crate::js::to_lower_case(&m.name) == crate::js::to_lower_case(written))).flatten()
        })
    }

    /// `isValueParam`.
    fn takes_value(&self, param: &ast::MovementParam) -> bool {
        match &param.type_ {
            None => false,
            Some(ParamTypeRef::Value(_)) => true,
            Some(ParamTypeRef::Name(type_)) if type_.hops_raw.is_some() => false,
            Some(ParamTypeRef::Name(type_)) => {
                movement_parser::catalog::helpers::parse_field_type_name(Some(&type_.graph)).is_some() || self.types.contains(&type_.graph)
            }
        }
    }

    /// Whether a parameter that takes a value takes one the checker holds to
    /// a type that is never a record: a scalar but `json`, a literal union,
    /// a `type` the file declares.
    fn takes_plain_value(&self, param: &ast::MovementParam) -> bool {
        match &param.type_ {
            Some(ParamTypeRef::Value(_)) => true,
            Some(ParamTypeRef::Name(type_)) if type_.hops_raw.is_none() => match movement_parser::catalog::helpers::parse_field_type_name(Some(&type_.graph)) {
                Some(movement_parser::catalog::types::FieldType::Scalar(movement_parser::catalog::types::Scalar::Json)) => false,
                Some(_) => true,
                None => self.types.contains(&type_.graph),
            },
            _ => false,
        }
    }

    /// The names a movement binds, its parameters bound as `signature` says.
    fn bound(&'p self, movement: &ast::MovementDeclaration, signature: &[Kind], stack: Vec<(String, Signature)>) -> Bound<'p> {
        let walk = |record_nodes: BTreeSet<String>| {
            let mut bound = Bound { plugin_binds: self.plugin_binds.clone(), callees: Some(self), stack: stack.clone(), record_nodes, ..Bound::default() };
            for (param, kind) in movement.params.iter().zip(signature) {
                match kind {
                    Kind::Event => {
                        bound.events.insert(param.name.clone());
                    }
                    kind => {
                        bound.hold(&param.name, *kind);
                        bound.params.push((param.name.clone(), *kind));
                        if *kind == Kind::Value && self.takes_plain_value(param) {
                            bound.plain_params.insert(param.name.clone());
                        }
                    }
                }
            }
            bound.collect(&movement.body, &[]);
            bound
        };
        // A node a later write fills with a record holds one from the start,
        // as far as what reads it may hold: walked again knowing which.
        let first = walk(BTreeSet::new());
        if first.record_nodes.is_empty() { first } else { walk(first.record_nodes) }
    }

    /// What a movement hands back under `signature`: the one kind its
    /// returns share, or `None` where they differ or a recursion's cycle
    /// leaves it open.
    fn returns(&'p self, movement: &ast::MovementDeclaration, signature: &[Kind], stack: &[(String, Signature)]) -> Option<Kind> {
        let key = (movement.name.clone(), signature.to_vec());
        if stack.contains(&key) {
            return None;
        }
        if let Some((_, known)) = self.returns.borrow().iter().find(|(k, _)| *k == key) {
            return *known;
        }
        let mut above = stack.to_vec();
        above.push(key.clone());
        let returns = self.bound(movement, signature, above).returns;
        let kind = match returns.split_first() {
            // A bound call of one that returns nothing fails, mirrored.
            None => Some(Kind::Value),
            Some((first, rest)) => rest.iter().all(|k| k == first).then_some(*first).flatten(),
        };
        self.returns.borrow_mut().push((key, kind));
        kind
    }
}

/// `constructionAsCall`: `f(a: x)` in a construction's spelling, read as
/// the call it is.
fn construction_as_call(construct: &ast::ConstructionCall) -> CallStatement {
    CallStatement {
        callee: construct.callee.clone(),
        args: construct.args.iter().map(|a| CallArg::Expr { name: Some(a.name.clone()), expr: a.value.clone() }).collect(),
        expression: None,
        span: construct.span,
    }
}

/// Every name a body binds, by what it holds; `if` arms and block bodies
/// included, and a block head's hop alias (`landings`). Each binding is kept
/// with the lexical scope it lands in (`sites`): an `if` arm and a block's
/// body (its iteration, where the hop alias lives) are scopes of their own.
#[derive(Default)]
struct Bound<'c> {
    /// What a plain call of each plugin binds (`refusal`'s table).
    plugin_binds: BTreeMap<String, PluginBinds>,
    /// The program's movements, for the calls the body makes: what each
    /// passes and what it hands back.
    callees: Option<&'c Callees<'c>>,
    /// The calls being worked out above this body (a recursion's cycle).
    stack: Vec<(String, Signature)>,
    /// Each call the body makes, by callee and what it passes.
    calls: Vec<(String, Signature)>,
    /// The kind each `return` of the body (not of a block's iteration)
    /// hands back; `None` where it is not known.
    returns: Vec<Option<Kind>>,
    /// The calls whose arguments or value are of a kind not known here.
    unknown_calls: Vec<ast::Span>,
    /// How deep in block bodies the walk is: a `return` there is the
    /// iteration's.
    blocks: usize,
    values: BTreeSet<String>,
    handles: BTreeSet<String>,
    instances: BTreeSet<String>,
    nodes: BTreeSet<String>,
    landings: BTreeSet<String>,
    /// What an edge of a node the run built holds: a landing a local write
    /// made or a match found, or a hop alias over such an edge — a node of
    /// the run's, or a record of a system a `link` put there.
    members: BTreeSet<String>,
    /// An extraction's root, or an entity a head over one landed on.
    extracts: BTreeSet<String>,
    /// The nodes a `graph { … }` literal built (a subset of `nodes`), which
    /// may hold records of a system.
    graphs: BTreeSet<String>,
    /// Walks kept to run at each read (`x = lazy …`).
    lazies: BTreeSet<String>,
    /// The movement's parameters that hold the event, which a bare-name
    /// alias may name.
    events: BTreeSet<String>,
    /// Its other parameters, by what the call binds them to.
    params: Vec<(String, Kind)>,
    /// Second names for the event.
    event_aliases: BTreeSet<String>,
    /// (name, kind, scope path from the body's root scope).
    sites: Vec<(String, Kind, Vec<usize>)>,
    /// A collection op's closure parameters, each in the closure's own
    /// scope: a member, of whatever kind it is (`Names::collection_op`).
    member_params: Vec<(String, Vec<usize>)>,
    scopes: usize,
    /// What each value the body binds holds, as far as a record goes: the
    /// widest of its bindings.
    value_holders: BTreeMap<String, Holder>,
    /// What each collection op's parameter holds: a member of its source.
    param_holders: BTreeMap<String, Holder>,
    /// The parameters that take a value the checker types as never a record.
    plain_params: BTreeSet<String>,
    /// Nodes whose literal holds a record in a field (or may).
    record_nodes: BTreeSet<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Value,
    Handle,
    Instance,
    Node,
    /// A node a `graph { … }` literal built.
    Graph,
    Landing,
    Extracted,
    /// What a run-built node's edge holds (`Bound::members`).
    Member,
    /// A walk kept to run at each read.
    Lazy,
    /// A second name for the event.
    Event,
    /// A value handed to a position parameter: at run time it is the record
    /// it holds (`bindSlotValue`), of any kind a position parameter takes,
    /// or the call fails before the callee runs. A signature holding one is
    /// walked once per kind (`concrete`).
    Held,
}

/// The record kinds a value handed to a position parameter may hold
/// (`evaluateCallArg`'s position case).
const HELD_KINDS: [Kind; 6] = [Kind::Event, Kind::Handle, Kind::Landing, Kind::Extracted, Kind::Node, Kind::Lazy];

/// A signature with each `Held` parameter as each kind it may be (of
/// `held`); `None` past a bound on how many walks one call may cost.
fn concrete(signature: &[Kind], held: &[Kind]) -> Option<Vec<Signature>> {
    let mut signatures: Vec<Signature> = vec![Vec::new()];
    for kind in signature {
        let options: &[Kind] = if *kind == Kind::Held { held } else { std::slice::from_ref(kind) };
        signatures = signatures.iter().flat_map(|s| options.iter().map(move |k| [s.as_slice(), &[*k]].concat())).collect();
        if signatures.len() > HELD_KINDS.len() * HELD_KINDS.len() {
            return None;
        }
    }
    Some(signatures)
}

/// What a call binds a movement's parameters to, in declaration order.
type Signature = Vec<Kind>;

impl<'c> Bound<'c> {
    /// What a plain plugin call binds, by its output (anything but a record
    /// is read as a value, and what it does not bind is refused where the
    /// call stands).
    fn plugin_kind(&self, callee: &str) -> Option<Kind> {
        match self.plugin_binds.get(callee)? {
            PluginBinds::Record => Some(Kind::Node),
            _ => Some(Kind::Value),
        }
    }

    /// The collection op a right-hand side runs, where it runs one: written
    /// as one (before version 3), or a call of one of the built-ins.
    fn rvalue_collection(&self, value: &RValue) -> Option<CollectionOpExpression> {
        match value {
            RValue::Collection { collection } => Some(collection.clone()),
            RValue::Call { call } => self.call_collection(call),
            _ => None,
        }
    }

    fn call_collection(&self, call: &CallStatement) -> Option<CollectionOpExpression> {
        let binds = self.callee(&call.callee).is_some() || self.binds_in_body(&call.callee) || self.plugin_binds.contains_key(&call.callee);
        let file_bound = self.callees.is_some_and(|c| c.file_scope.contains(&call.callee));
        match crate::collection::reading(call, binds || file_bound, self.callees.map_or(3, |c| c.language_version)) {
            Ok(Some(crate::collection::Reading::Collection(op))) => Some(op),
            _ => None,
        }
    }

    fn binds_in_body(&self, name: &str) -> bool {
        self.sites.iter().any(|(n, _, _)| n == name) || self.params.iter().any(|(n, _)| n == name) || self.events.contains(name) || self.event_aliases.contains(name)
    }

    /// An op's function: a closure's parameters and body, in a scope of its
    /// own (its `return` is no `return` of the movement's); a movement
    /// handed by name, called once per member with each member as it is —
    /// a value or a record of any kind — so walked under each.
    fn collection(&mut self, op: &CollectionOpExpression, scope: &[usize]) {
        match &op.r#fn {
            ArmExpression::Closure { closure, .. } => {
                let inner = self.enter(scope);
                let member = lowered(&op.source.raw).map_or(Holder::Other, |source| member_holder(&source, &|name| self.holder(name)));
                for (index, param) in closure.params.iter().enumerate() {
                    self.member_params.push((param.name.clone(), inner.clone()));
                    let held = param_holder(op.op, index, member);
                    let joined = self.param_holders.get(&param.name).map_or(held, |h| h.join(held));
                    self.param_holders.insert(param.name.clone(), joined);
                }
                self.blocks += 1;
                self.collect(&closure.body, &inner);
                self.blocks -= 1;
            }
            ArmExpression::Ref { name, .. } => {
                let Some(callees) = self.callees else { return };
                let Some(movement) = callees.movement(name) else { return };
                let any: Vec<Kind> = std::iter::once(Kind::Value).chain(callees.held_kinds.iter().copied()).collect();
                let mut signatures: Vec<Signature> = vec![Vec::new()];
                for _ in &movement.params {
                    signatures = signatures.iter().flat_map(|s| any.iter().map(move |k| [s.as_slice(), &[*k]].concat())).collect();
                    if signatures.len() > any.len() * any.len() {
                        self.unknown_calls.push(op.span);
                        return;
                    }
                }
                for signature in signatures {
                    self.calls.push((movement.name.clone(), signature));
                }
            }
        }
    }

    /// The closure bodies a statement holds (a combinator's literal arms, a
    /// closure bound or returned, a callback's inline body, an `until`'s
    /// condition), each in a scope of its own whose `return` is no `return`
    /// of the movement's, its parameters members of whatever kind.
    fn closures_of(&mut self, statement: &Statement, scope: &[usize]) {
        for closure in closure_bodies(statement) {
            let inner = self.enter(scope);
            for param in &closure.params {
                self.member_params.push((param.name.clone(), inner.clone()));
            }
            self.blocks += 1;
            self.collect(&closure.body, &inner);
            self.blocks -= 1;
        }
    }

    fn collect(&mut self, statements: &[Statement], scope: &[usize]) {
        for statement in statements {
            self.closures_of(statement, scope);
            if let Some(op) = match statement {
                Statement::Collection(statement) => Some(statement.collection.clone()),
                Statement::Call(call) => self.call_collection(call),
                Statement::Assign(assign) => self.rvalue_collection(&assign.value),
                Statement::Return(ret) => self.rvalue_collection(&ret.value),
                _ => None,
            } {
                self.collection(&op, scope);
            }
            match statement {
                Statement::Assign(assign) => {
                    let kind = match &assign.value {
                        RValue::Write { write } if self.into_node(&write.target) => Kind::Member,
                        RValue::Match { r#match } if self.into_node(&r#match.target) => Kind::Member,
                        RValue::Write { .. } | RValue::Match { .. } | RValue::Link { .. } => Kind::Handle,
                        RValue::Construct { construct } if self.callee(&construct.callee).is_some() => self.call_kind(&construction_as_call(construct)),
                        RValue::Construct { construct } => self.plugin_kind(&construct.callee).unwrap_or(Kind::Instance),
                        RValue::Call { call } if self.callee(&call.callee).is_some() => self.call_kind(call),
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
                            if !self.literal_free(node) {
                                self.record_nodes.insert(assign.name.clone());
                            }
                            Kind::Node
                        }
                        RValue::Extract { .. } => Kind::Extracted,
                        RValue::Lazy { .. } => Kind::Lazy,
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
                    if kind == Kind::Value {
                        let op = self.rvalue_collection(&assign.value);
                        let holder = match &assign.value {
                            _ if let Some(op) = &op => self.collection_holder(op),
                            // Read once the block's own names are bound, below.
                            RValue::Block { .. } => Holder::Free,
                            RValue::Expr { expr } => self.holds(&expr.raw),
                            RValue::Call { call } if self.plugin_kind(&call.callee).is_none() => call.expression.as_ref().map_or(Holder::Other, |e| self.holds(&e.raw)),
                            // A plugin's value output is its text; a type's members
                            // are its words.
                            RValue::Call { .. } | RValue::Construct { .. } | RValue::Members { .. } => Holder::Free,
                            RValue::Combinator { combinator } => self.receipt_holder(combinator),
                            RValue::Await { r#await } => match &r#await.source {
                                AwaitSource::Combinator { combinator, .. } => self.receipt_holder(combinator),
                                // A sleep's presence.
                                AwaitSource::Sleep { .. } => Holder::Free,
                                // A met `until`'s value: what the condition evaluates to,
                                // or what its closure returned.
                                AwaitSource::Until { condition: UntilCondition::Expr { expr }, .. } => self.holds(&expr.raw),
                                AwaitSource::Until { condition: UntilCondition::Closure { closure }, .. } => self.returns_holder(&closure.body),
                                // A landing: a callback's call (its fields data) or an
                                // awaited system record.
                                AwaitSource::Traversal { .. } | AwaitSource::First { .. } => Holder::Record,
                            },
                            // The callback's binding object: its fields (id, url) data.
                            RValue::Callback { .. } => Holder::Record,
                            _ => Holder::Other,
                        };
                        let joined = self.value_holders.get(&assign.name).map_or(holder, |h| h.join(holder));
                        self.value_holders.insert(assign.name.clone(), joined);
                    }
                    self.bind(&assign.name, kind, scope);
                    if let RValue::Write { write } = &assign.value
                        && self.local_write_holds_record(write)
                    {
                        self.record_nodes.insert(assign.name.clone());
                    }
                    match &assign.value {
                        RValue::Write { write } => self.target_alias(&write.target, scope),
                        RValue::Match { r#match } => self.target_alias(&r#match.target, scope),
                        RValue::Block { block } => {
                            self.block(block, scope);
                            if kind == Kind::Value {
                                let held = self.returned_holder(&block.body);
                                let joined = self.value_holders.get(&assign.name).map_or(held, |h| h.join(held));
                                self.value_holders.insert(assign.name.clone(), joined);
                            }
                        }
                        _ => {}
                    }
                }
                Statement::Write(statement) => {
                    self.local_write_holds_record(&statement.write);
                    self.target_alias(&statement.write.target, scope)
                }
                Statement::Match(statement) => self.target_alias(&statement.r#match.target, scope),
                Statement::Call(call) if self.callee(&call.callee).is_some() => {
                    self.call_kind(call);
                }
                // A `return` of the body, not of a block's iteration: what
                // a call of the movement hands back.
                Statement::Return(ret) if self.blocks == 0 => {
                    let kind = self.value_kind(&ret.value);
                    self.returns.push(kind);
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
        let over_node = matches!(&block.head.root, Some(PathRoot::Name { name }) if self.nodes.contains(name) || self.members.contains(name));
        if let Ok(step) = crate::traverse::head_step(&block.head)
            && let Some(alias) = step.alias
        {
            let kind = if over_extract {
                Kind::Extracted
            } else if over_node {
                Kind::Member
            } else {
                Kind::Landing
            };
            self.bind(&alias, kind, &inner);
        }
        self.blocks += 1;
        self.collect(&block.body, &inner);
        self.blocks -= 1;
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
        let bound = self.sites.iter().rev().find(|(n, _, _)| n == name).map(|(_, kind, _)| *kind);
        match bound.or_else(|| self.params.iter().find(|(n, _)| n == name).map(|(_, kind)| *kind)) {
            Some(Kind::Node) if self.graphs.contains(name) => Kind::Graph,
            Some(kind @ (Kind::Handle | Kind::Node | Kind::Graph | Kind::Landing | Kind::Extracted | Kind::Member | Kind::Lazy | Kind::Event)) => kind,
            _ => Kind::Value,
        }
    }

    /// The movement a call names (`Callees::callee`).
    fn callee(&self, written: &str) -> Option<&'c ast::MovementDeclaration> {
        let bound_in_body = self.sites.iter().any(|(n, _, _)| n == written)
            || self.params.iter().any(|(n, _)| n == written)
            || self.events.contains(written)
            || self.event_aliases.contains(written);
        self.callees?.callee(written, bound_in_body)
    }

    /// What a right-hand side binds, for what a `return` of it hands back.
    fn value_kind(&mut self, value: &RValue) -> Option<Kind> {
        Some(match value {
            RValue::Expr { expr } => self.expression_kind(&expr.raw),
            RValue::Node { node } if node.graph.is_some() => Kind::Graph,
            RValue::Node { .. } => Kind::Node,
            RValue::Call { call } if self.callee(&call.callee).is_some() => return self.known_call_kind(call),
            RValue::Construct { construct } if self.callee(&construct.callee).is_some() => return self.known_call_kind(&construction_as_call(construct)),
            RValue::Call { call } => match (self.plugin_kind(&call.callee), &call.expression) {
                (Some(kind), _) => kind,
                (None, Some(expr)) => self.expression_kind(&expr.raw),
                (None, None) => Kind::Value,
            },
            RValue::Write { write } if self.into_node(&write.target) => Kind::Member,
            RValue::Match { r#match } if self.into_node(&r#match.target) => Kind::Member,
            RValue::Write { .. } | RValue::Match { .. } | RValue::Link { .. } => Kind::Handle,
            RValue::Extract { .. } => Kind::Extracted,
            _ => Kind::Value,
        })
    }

    /// A call's value, bound: what the callee hands back under what this
    /// call passes, a value where that is not known (the call refuses).
    fn call_kind(&mut self, call: &CallStatement) -> Kind {
        self.known_call_kind(call).unwrap_or(Kind::Value)
    }

    /// What the callee hands back under what this call passes (`runCall`:
    /// arguments bound by name or by declared order), the call noted for
    /// the walk; `None`, and the call noted unknown, where a kind is not
    /// known here.
    fn known_call_kind(&mut self, call: &CallStatement) -> Option<Kind> {
        let callees = self.callees?;
        let declaration = self.callee(&call.callee)?;
        let mut signature: Vec<Option<Kind>> = vec![Some(Kind::Value); declaration.params.len()];
        for (position, arg) in call.args.iter().enumerate() {
            let param = arg.name().map(String::from).or_else(|| declaration.params.get(position).map(|p| p.name.clone()));
            // A name the callee does not take fails the call, mirrored.
            let Some(index) = param.and_then(|p| declaration.params.iter().position(|d| d.name == p)) else { continue };
            let takes_value = callees.takes_value(&declaration.params[index]);
            signature[index] = match self.arg_kind(arg, takes_value) {
                // A value handed to a position parameter is the record it
                // holds, or the call fails before the callee runs.
                Some(Kind::Value) if !takes_value => Some(Kind::Held),
                other => other,
            };
        }
        let Some(signature) = signature.into_iter().collect::<Option<Signature>>() else {
            self.unknown_calls.push(call.span);
            return None;
        };
        let Some(signatures) = concrete(&signature, &callees.held_kinds) else {
            self.unknown_calls.push(call.span);
            return None;
        };
        let mut returned: Option<Option<Kind>> = None;
        for signature in signatures {
            self.calls.push((declaration.name.clone(), signature.clone()));
            let kind = callees.returns(declaration, &signature, &self.stack);
            returned = Some(match returned {
                None => kind,
                Some(seen) if seen == kind => seen,
                Some(_) => None,
            });
        }
        let returned = returned.flatten();
        if returned.is_none() {
            self.unknown_calls.push(call.span);
        }
        returned
    }

    /// `evaluateCallArg`: what an argument binds its parameter to.
    fn arg_kind(&mut self, arg: &CallArg, takes_value: bool) -> Option<Kind> {
        match arg {
            CallArg::Expr { .. } if takes_value => Some(Kind::Value),
            CallArg::Expr { expr, .. } => Some(self.expression_kind(&expr.raw)),
            CallArg::Write { write, .. } => Some(if self.into_node(&write.target) { Kind::Member } else { Kind::Handle }),
            CallArg::Node { node, .. } => Some(if node.graph.is_some() { Kind::Graph } else { Kind::Node }),
            CallArg::Call { call, .. } if self.callee(&call.callee).is_some() => self.known_call_kind(call),
            CallArg::Call { call, .. } => Some(match &call.expression {
                Some(expr) if !takes_value => self.expression_kind(&expr.raw),
                _ => Kind::Value,
            }),
            CallArg::Closure { .. } | CallArg::Type { .. } => Some(Kind::Value),
        }
    }

    /// A write's or a match's target rooted at a node the run built, or at
    /// what one's edge holds: it binds the landing, not a handle.
    /// Whether a write into a node this run built holds a record in a
    /// field: the node it lands in then holds one (its root marked so).
    fn local_write_holds_record(&mut self, write: &WriteExpression) -> bool {
        if !self.into_node(&write.target) {
            return false;
        }
        let spreads = write.spreads.iter().flatten().any(|spread| spread.path.is_some() || self.holder(&spread.source) == Holder::Other);
        if !spreads && write.fields.iter().all(|field| self.reads_free(&field.value.raw)) {
            return false;
        }
        let root = match &write.target {
            WriteTarget::Linked { path, .. } => match &path.root {
                Some(PathRoot::Name { name }) => name.clone(),
                _ => return true,
            },
            WriteTarget::Position { root: PathRoot::Name { name }, .. } => name.clone(),
            _ => return true,
        };
        self.record_nodes.insert(root);
        true
    }

    fn into_node(&self, target: &WriteTarget) -> bool {
        let root = match target {
            WriteTarget::Linked { path, .. } => match &path.root {
                Some(PathRoot::Name { name }) => name,
                _ => return false,
            },
            WriteTarget::Position { root: PathRoot::Name { name }, .. } => name,
            _ => return false,
        };
        self.nodes.contains(root) || self.members.contains(root)
    }

    /// What `name` holds here, as far as a record goes.
    fn holder(&self, name: &str) -> Holder {
        if self.member_params.iter().any(|(n, _)| n == name) {
            return self.param_holders.get(name).copied().unwrap_or(Holder::Other);
        }
        if self.values.contains(name) {
            if self.plain_params.contains(name) {
                return Holder::Free;
            }
            let param = self.params.iter().any(|(n, _)| n == name);
            return if param { Holder::Other } else { self.value_holders.get(name).copied().unwrap_or(Holder::Other) };
        }
        if self.record_nodes.contains(name) {
            return Holder::Other;
        }
        // The event's binding object is plain data (`{kind: 'event'}`),
        // carried as itself.
        if self.events.contains(name) || self.event_aliases.contains(name) {
            return Holder::Free;
        }
        let records = [&self.handles, &self.landings, &self.instances, &self.nodes, &self.members, &self.extracts, &self.graphs, &self.lazies];
        if records.iter().any(|set| set.contains(name)) {
            return Holder::Record;
        }
        if self.binds_here(name) {
            return Holder::Other;
        }
        // A name nothing binds reads as nothing: the read fails on both
        // engines before any request is made.
        match self.callees {
            Some(callees) if callees.file_scope.contains(name) => callees.file_holders.get(name).copied().unwrap_or(Holder::Other),
            _ => Holder::Free,
        }
    }

    /// Whether the body binds `name` (as anything).
    fn binds_here(&self, name: &str) -> bool {
        self.sites.iter().any(|(n, _, _)| n == name) || self.member_params.iter().any(|(n, _)| n == name) || self.params.iter().any(|(n, _)| n == name)
    }

    /// What a bound block hands back: the list of what its iterations
    /// return.
    fn returned_holder(&self, body: &[Statement]) -> Holder {
        match self.returns_holder(body) {
            Holder::Free => Holder::Free,
            Holder::Record => Holder::List,
            _ => Holder::Other,
        }
    }

    /// What each `return` of a body hands back, widened: free of records,
    /// one record whose fields are, or anything.
    fn returns_holder(&self, body: &[Statement]) -> Holder {
        let mut returned = Holder::Free;
        let mut returns = Vec::new();
        returns_of(body, &mut returns);
        for value in returns {
            let one = match value {
                RValue::Expr { expr } => lowered(&expr.raw).map_or(Holder::Other, |e| match &e {
                    Expression::AliasRef { name } | Expression::Property { property_type_id: name } if self.holder(name) == Holder::Record => Holder::Record,
                    other if !may_hold_record(other, &|name| self.holder(name)) => Holder::Free,
                    _ => Holder::Other,
                }),
                RValue::Write { .. } | RValue::Match { .. } | RValue::Link { .. } => Holder::Record,
                _ => Holder::Other,
            };
            returned = match (returned, one) {
                (Holder::Free, Holder::Free) => Holder::Free,
                (Holder::Free | Holder::Record, Holder::Free | Holder::Record) => Holder::Record,
                _ => Holder::Other,
            };
        }
        returned
    }

    /// A combinator's receipt read as a value (`readBareName`): each slot's
    /// value, a record's slot null — so it holds a record only where an arm
    /// returned a value that may.
    fn receipt_holder(&self, combinator: &ast::CombinatorExpression) -> Holder {
        let CombinatorArms::Literal { arms, .. } = &combinator.arms else { return Holder::Other };
        let mut held = Holder::Free;
        for arm in arms {
            let ArmExpression::Closure { closure, .. } = arm else { return Holder::Other };
            if !matches!(self.returns_holder(&closure.body), Holder::Free | Holder::Record) {
                held = Holder::Other;
            }
        }
        held
    }

    /// What a collection op hands back, as far as a record goes: a MAP the
    /// list of what its function returns, a FILTER its source's members.
    fn collection_holder(&self, op: &CollectionOpExpression) -> Holder {
        let source = lowered(&op.source.raw).map_or(Holder::Other, |s| member_holder(&s, &|name| self.holder(name)));
        let ArmExpression::Closure { closure, .. } = &op.r#fn else { return Holder::Other };
        let returned = self.returns_holder(&closure.body);
        let list = |member: Holder| match member {
            Holder::Free => Holder::Free,
            Holder::Record => Holder::List,
            _ => Holder::Other,
        };
        let init = op.init.as_ref().map_or(Holder::Free, |init| self.holds(&init.raw));
        match op.op {
            CollectionOp::Map => list(returned),
            CollectionOp::Filter => list(source),
            // What the last member's call returned, or the initial value.
            CollectionOp::Reduce if init == Holder::Free && returned == Holder::Free => Holder::Free,
            // Each member under the key its function returned.
            CollectionOp::Keyby => match source {
                Holder::Free => Holder::Free,
                Holder::Record => Holder::Map { depth: 1, lists: false },
                _ => Holder::Other,
            },
            _ if source == Holder::Free && returned == Holder::Free => Holder::Free,
            _ => Holder::Other,
        }
    }

    /// Whether a node literal's fields, at any depth, hold no record.
    fn literal_free(&self, node: &NodeLiteral) -> bool {
        self.literal_free_with(node, &BTreeSet::new())
    }

    /// `literal_free`, with `aliases` (a traversal entry's hop aliases) each
    /// one record landed on.
    fn literal_free_with(&self, node: &NodeLiteral, aliases: &BTreeSet<String>) -> bool {
        let holder = |name: &str| if aliases.contains(name) { Holder::Record } else { self.holder(name) };
        let free = |raw: &str| lowered(raw).is_ok_and(|expr| value_holder(&expr, &holder) == Holder::Free);
        let spreads = node.spreads.iter().flatten().all(|spread| spread.path.is_none() && holder(&spread.source) != Holder::Other);
        spreads
            && node.entries.iter().all(|entry| match entry {
                // A graph names a record by reference: it lands on the edge
                // (`referencedRecords`), not in a field.
                NodeEntry::Value { value, .. } if node.graph.is_some() && holder(crate::js::trim(&value.raw)) == Holder::Record => true,
                NodeEntry::Value { value, .. } => free(&value.raw),
                NodeEntry::Nodes { nodes, .. } => nodes.iter().all(|n| self.literal_free_with(n, aliases)),
                NodeEntry::Traversal { head, mapping, .. } => mapping.as_ref().is_none_or(|m| {
                    let mut inner = aliases.clone();
                    inner.extend(crate::traverse::head_step(head).ok().and_then(|step| step.alias));
                    self.literal_free_with(m, &inner)
                }),
                NodeEntry::Declared { .. } => true,
            })
    }

    /// Whether an expression slot's value holds no record.
    fn reads_free(&self, raw: &str) -> bool {
        self.holds(raw) == Holder::Free
    }

    /// What a value bound to an expression slot holds.
    fn holds(&self, raw: &str) -> Holder {
        lowered(raw).map_or(Holder::Other, |expr| value_holder(&expr, &|name| self.holder(name)))
    }

    /// What each value holds, for the walk of the body: the file's values
    /// the body does not rebind, and the body's own but its parameters.
    fn value_holders(&self) -> BTreeMap<String, Holder> {
        let mut holders: BTreeMap<String, Holder> = self.value_holders.clone();
        for name in self.params.iter().map(|(n, _)| n).chain(self.member_params.iter().map(|(n, _)| n)) {
            holders.remove(name);
        }
        holders.extend(self.plain_params.iter().map(|n| (n.clone(), Holder::Free)));
        if let Some(callees) = self.callees {
            for (name, holder) in &callees.file_holders {
                if !self.binds_here(name) {
                    holders.insert(name.clone(), *holder);
                }
            }
        }
        holders
    }

    fn enter(&mut self, scope: &[usize]) -> Vec<usize> {
        self.scopes += 1;
        let mut inner = scope.to_vec();
        inner.push(self.scopes);
        inner
    }

    fn bind(&mut self, name: &str, kind: Kind, scope: &[usize]) {
        self.hold(name, kind);
        self.sites.push((name.to_string(), kind, scope.to_vec()));
    }

    /// `name` in the set of what it holds.
    fn hold(&mut self, name: &str, kind: Kind) {
        let into = match kind {
            Kind::Value => &mut self.values,
            Kind::Handle => &mut self.handles,
            Kind::Instance => &mut self.instances,
            Kind::Node => &mut self.nodes,
            Kind::Graph => {
                self.nodes.insert(name.to_string());
                &mut self.graphs
            }
            Kind::Landing => &mut self.landings,
            Kind::Extracted => &mut self.extracts,
            Kind::Member => &mut self.members,
            Kind::Lazy => &mut self.lazies,
            Kind::Event => &mut self.event_aliases,
            // A callee is walked under concrete kinds only (`concrete`); a
            // value's reads are what a held record's are.
            Kind::Held => &mut self.values,
        };
        into.insert(name.to_string());
    }

    /// A name bound twice where one binding can see the other (one scope, or
    /// one inside the other), or bound as two kinds anywhere: what a body
    /// binds is read by name, so each name must mean one kind of thing, and a
    /// name is bound once in any one scope chain. The same name in two sibling
    /// scopes (two blocks' hop aliases, two arms' bindings) is two names.
    fn rebound(&self) -> bool {
        let nested = |a: &[usize], b: &[usize]| a.starts_with(b) || b.starts_with(a);
        let sites = self.sites.iter().enumerate().any(|(i, (name, kind, scope))| {
            self.sites[i + 1..].iter().any(|(other, other_kind, other_scope)| name == other && (kind != other_kind || nested(scope, other_scope)))
        });
        // A closure's parameter is a name of its own scope: only a binding it
        // can see, or one that sees it, is the same name twice.
        let params = self.member_params.iter().enumerate().any(|(i, (name, scope))| {
            self.sites.iter().any(|(other, _, other_scope)| name == other && nested(scope, other_scope))
                || self.member_params[i + 1..].iter().any(|(other, other_scope)| name == other && nested(scope, other_scope))
        });
        sites || params
    }
}

/// Where a statement sits: the movement's body (or an `if` arm of it), or a
/// traversal block's body, where a park or a suspension would leave the
/// fan-out's other iterations to a join this engine does not keep.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Within {
    Body,
    /// A `parallel`'s or a `race`'s arm, a closure's or a callback's body:
    /// a body of its own, whose park its frame or its address leads back to.
    Arm,
    Block,
    /// A collection op's function: its `return` is the member's answer (any
    /// right-hand side, as a body's), and a park in it would leave the
    /// op's other members to a join this engine does not keep.
    Member,
}

type Admitted = Result<(), String>;

fn refuse(reason: impl Into<String>) -> Admitted {
    Err(reason.into())
}

/// One movement's names, as its body may read them.
struct Names<'n> {
    /// Where each statement's reason goes, so the walk goes on past it.
    reasons: &'n Reasons,
    /// The movement's parameters: the event.
    events: &'n BTreeSet<String>,
    values: &'n BTreeSet<String>,
    handles: &'n BTreeSet<String>,
    nodes: &'n BTreeSet<String>,
    /// Block heads' hop aliases: a record the walk landed on.
    landings: &'n BTreeSet<String>,
    /// What a run-built node's edge holds (`Bound::members`).
    members: &'n BTreeSet<String>,
    /// Walks kept to run at each read.
    lazies: &'n BTreeSet<String>,
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
    /// The movements as callees: what a call's arguments bind.
    callees: &'n Callees<'n>,
    /// The calls whose arguments or value are of a kind not known.
    unknown_calls: &'n [ast::Span],
    language_version: u32,
    /// What each value (of `values`) holds, as far as a record goes; one
    /// not here may hold anything.
    value_holders: &'n BTreeMap<String, Holder>,
    /// The nodes whose literal holds a record in a field (or may).
    record_nodes: &'n BTreeSet<String>,
}

impl Names<'_> {
    /// Every statement, each one's reason noted and the next walked.
    fn body(&self, statements: &[Statement], within: Within) {
        for statement in statements {
            self.reasons.noted(self.statement(statement, within));
        }
    }

    fn statement(&self, statement: &Statement, within: Within) -> Admitted {
        // A park inside a block's iteration or a collection op's member is
        // joined by its fan-out's frame; inside a callee, resumed through its
        // call frames.
        let sleep = |source: &AwaitSource| self.await_source(source);
        match statement {
            Statement::Assign(assign) => match &assign.value {
                RValue::Write { write } => self.write(write),
                RValue::Match { r#match } => self.match_(r#match),
                RValue::Link { link } => self.link(link),
                // A bound block: what its iterations return is the binding.
                RValue::Block { block } => self.block(block),
                RValue::Await { r#await } => sleep(&r#await.source),
                RValue::Construct { construct } if self.callee(&construct.callee).is_some() => self.call(&construction_as_call(construct)),
                RValue::Call { call } if self.callee(&call.callee).is_some() => self.call(call),
                RValue::Construct { construct } if self.plugin(&construct.callee) => {
                    self.plugin_invocation(&construct.callee, construct.args.iter().map(|a| Some(&a.value)))
                }
                RValue::Extract { extract } => self.extract(extract),
                RValue::Construct { .. } => Ok(()),
                RValue::Node { node } => self.node(node, node.graph.is_some()),
                // Walked as a block head walks, at every read.
                RValue::Lazy { lazy } => self.traversal_entry(&lazy.head, lazy.mapping.as_ref(), false),
                RValue::Expr { expr } => self.assigned(expr),
                RValue::Collection { collection } => self.collection_op(collection, "rvalue:collection"),
                RValue::Members { .. } => Ok(()),
                RValue::Call { call } if let Some(reading) = self.reading(call)? => self.reading_admitted(&reading, "rvalue:collection"),
                RValue::Call { call } if !self.plugin(&call.callee) => self.assigned(self.builtin_value(call)?),
                RValue::Combinator { combinator } => self.combinator(combinator, within),
                RValue::Closure { closure } => self.closure(&closure.params, &closure.body),
                RValue::Callback { callback } => self.callback(callback),
                other => self.rvalue(other),
            },
            // A returned call's value is the TypeScript's to hand back.
            Statement::Return(ret) => match &ret.value {
                RValue::Call { call } if self.plugin(&call.callee) => refuse("plugin_call"),
                RValue::Collection { collection } => self.collection_op(collection, "rvalue:collection"),
                RValue::Members { .. } => Ok(()),
                RValue::Call { call } if let Some(reading) = self.reading(call)? => self.reading_admitted(&reading, "rvalue:collection"),
                // What a body returns is its call's value, an iteration's
                // its block's (`blockValue`: the values, or the records), a
                // member's its op's: any binding a right-hand side makes.
                RValue::Write { write } => self.write(write),
                RValue::Match { r#match } => self.match_(r#match),
                RValue::Link { link } => self.link(link),
                RValue::Extract { extract } => self.extract(extract),
                RValue::Call { call } if self.callee(&call.callee).is_some() => self.call(call),
                RValue::Construct { construct } if self.callee(&construct.callee).is_some() => self.call(&construction_as_call(construct)),
                RValue::Node { node } => self.node(node, node.graph.is_some()),
                RValue::Expr { expr } => self.assigned(expr),
                RValue::Call { call } => self.assigned(self.builtin_value(call)?),
                RValue::Await { r#await } => sleep(&r#await.source),
                RValue::Combinator { combinator } => self.combinator(combinator, within),
                RValue::Closure { closure } => self.closure(&closure.params, &closure.body),
                RValue::Callback { callback } => self.callback(callback),
                other => self.rvalue(other),
            },
            Statement::Write(statement) => self.write(&statement.write),
            Statement::Match(statement) => self.match_(&statement.r#match),
            Statement::Link(statement) => self.link(&statement.link),
            // Its endpoints are the records the names hold, which must be
            // written handles, as the TypeScript's `resolveEdgeEndpoint` says.
            Statement::Unlink(_) => Ok(()),
            Statement::Delete(statement) => {
                if self.handles.contains(&statement.name) || self.landings.contains(&statement.name) { Ok(()) } else { refuse("delete_not_record") }
            }
            Statement::Await(statement) => sleep(&statement.r#await.source),
            Statement::Combinator(statement) => self.combinator(&statement.combinator, within),
            Statement::If(statement) => {
                for arm in &statement.arms {
                    self.reasons.noted(self.condition(&arm.condition));
                    self.body(&arm.body, within);
                }
                if let Some(arm) = &statement.else_arm {
                    self.body(&arm.body, within);
                }
                Ok(())
            }
            Statement::Block(statement) => self.block(&statement.block),
            Statement::Error(statement) => self.slot(&statement.message),
            Statement::Call(call) if self.plugin(&call.callee) => self.plugin_call(call),
            Statement::Call(call) if self.callee(&call.callee).is_some() => self.call(call),
            Statement::Collection(statement) => self.collection_op(&statement.collection, "statement:collection"),
            Statement::Call(call) if let Some(reading) = self.reading(call)? => match reading {
                crate::collection::Reading::Collection(op) => self.collection_op(&op, "statement:collection"),
                // A type's values read and dropped: the checker refuses it.
                crate::collection::Reading::Members(_) => refuse("statement:call"),
            },
            other => refuse(format!("statement:{}", statement_kind(other))),
        }
    }

    /// What an `await` waits on (crate::awaits): a sleep; an `until`'s
    /// condition, a closure's body or an expression; a combinator's arms; an
    /// edge's WHERE, scoped at the landing.
    fn await_source(&self, source: &AwaitSource) -> Admitted {
        match source {
            AwaitSource::Sleep { .. } => Ok(()),
            AwaitSource::Until { condition: UntilCondition::Closure { closure }, .. } => self.closure(&closure.params, &closure.body),
            AwaitSource::Until { condition: UntilCondition::Expr { expr }, .. } => self.slot(expr),
            AwaitSource::Combinator { combinator, .. } => self.combinator(combinator, Within::Body),
            AwaitSource::Traversal { head, .. } | AwaitSource::First { head, .. } => {
                let Ok(step) = crate::traverse::head_step(head) else { return refuse("block_head_does_not_lower") };
                match &step.expression_filter {
                    Some(filter) => self.scoped(filter),
                    None => Ok(()),
                }
            }
        }
    }

    /// A `parallel`'s or a `race`'s arms (crate::combinator): each literal
    /// closure's body walked as an arm's, which sees the names around it; a
    /// name, the closure or movement it names, walked where it is written;
    /// arms built at run time, the value that holds them.
    fn combinator(&self, combinator: &ast::CombinatorExpression, _within: Within) -> Admitted {
        match &combinator.arms {
            CombinatorArms::Literal { arms, .. } => {
                for arm in arms {
                    if let ArmExpression::Closure { closure, .. } = arm {
                        self.reasons.noted(self.closure(&closure.params, &closure.body));
                    }
                }
                Ok(())
            }
            CombinatorArms::Dynamic { expr, .. } => self.slot(expr),
        }
    }

    /// A closure's body, a body of its own: its parameters values (which may
    /// hold records) over whatever else their names are bound to outside it.
    fn closure(&self, params: &[ast::MovementParam], body: &[Statement]) -> Admitted {
        self.closure_with(params, body, Holder::Other)
    }

    /// A closure's body, its parameters holding `held`.
    fn closure_with(&self, params: &[ast::MovementParam], body: &[Statement], held: Holder) -> Admitted {
        let params: BTreeSet<String> = params.iter().map(|p| p.name.clone()).collect();
        let without = |set: &BTreeSet<String>| -> BTreeSet<String> { set.difference(&params).cloned().collect() };
        let values: BTreeSet<String> = self.values.union(&params).cloned().collect();
        let (events, handles, nodes, landings, members, lazies, extracts, graphs) = (
            without(self.events),
            without(self.handles),
            without(self.nodes),
            without(self.landings),
            without(self.members),
            without(self.lazies),
            without(self.extracts),
            without(self.graphs),
        );
        let mut value_holders = self.value_holders.clone();
        for param in &params {
            value_holders.insert(param.clone(), held);
        }
        let inner = Names {
            value_holders: &value_holders,
            values: &values,
            events: &events,
            handles: &handles,
            nodes: &nodes,
            landings: &landings,
            members: &members,
            lazies: &lazies,
            extracts: &extracts,
            graphs: &graphs,
            instances: without(&self.instances),
            ..*self
        };
        inner.body(body, Within::Arm);
        Ok(())
    }

    /// `callback(…)`: an inline body walked as a closure's; a named one is
    /// a call of its movement, made when it fires.
    fn callback(&self, callback: &ast::CallbackExpression) -> Admitted {
        for entry in &callback.config {
            if entry.name == "once" {
                self.slot(&entry.value)?;
            }
        }
        match &callback.subject {
            // What a fire binds its parameters to is the platform's data.
            CallbackSubject::Inline { closure, .. } => self.closure_with(&closure.params, &closure.body, Holder::Free),
            CallbackSubject::Named { movement, args, span, .. } => {
                self.call(&CallStatement { callee: movement.clone(), args: args.clone(), expression: None, span: *span })
            }
        }
    }

    /// A call of a movement the program declares (crate::call): each
    /// argument walked as what it binds its parameter to — a value
    /// parameter's as an expression, a position parameter's as the record
    /// it names — the callee walked under what this call passes
    /// (`walks`).
    fn call(&self, call: &CallStatement) -> Admitted {
        if self.unknown_calls.contains(&call.span) {
            return refuse("movement_call");
        }
        let Some(declaration) = self.callee(&call.callee) else { return refuse("statement:call") };
        for (position, arg) in call.args.iter().enumerate() {
            let param = arg.name().map(String::from).or_else(|| declaration.params.get(position).map(|p| p.name.clone()));
            let takes_value = param.and_then(|p| declaration.params.iter().find(|d| d.name == p)).is_some_and(|p| self.callees.takes_value(p));
            match arg {
                CallArg::Expr { expr, .. } if takes_value => self.slot(expr)?,
                CallArg::Expr { expr, .. } => self.assigned(expr)?,
                CallArg::Write { write, .. } => self.write(write)?,
                CallArg::Node { node, .. } => self.node(node, node.graph.is_some())?,
                CallArg::Call { call, .. } if self.callee(&call.callee).is_some() => self.call(call)?,
                CallArg::Call { call, .. } if takes_value => self.slot(self.builtin_value(call)?)?,
                CallArg::Call { call, .. } => self.assigned(self.builtin_value(call)?)?,
                CallArg::Closure { .. } => return refuse("rvalue:closure"),
                CallArg::Type { .. } => return refuse("builtin_call_form"),
            }
        }
        Ok(())
    }

    /// A traversal block over an adapter edge (crate::traverse): one hop
    /// off a constructed instance, a write's handle, the event or an
    /// enclosing block's hop alias (a nested block), its WHERE
    /// and ORDER BY key position-scoped expressions the evaluator runs, its
    /// body in the slice and with no park in it.
    fn block(&self, block: &TraversalBlock) -> Admitted {
        self.reasons.noted(self.head(&block.head));
        self.body(&block.body, Within::Block);
        Ok(())
    }

    fn head(&self, head: &PathHead) -> Admitted {
        let root = match &head.root {
            None => return refuse("block_head_rootless"),
            // `AT(rows, 0)-[c:company]->`: the root bound as `x = <it>` binds.
            Some(PathRoot::Expression { expr }) => {
                self.assigned(expr)?;
                return self.value_head(head);
            }
            Some(PathRoot::Name { name }) => name,
        };
        // A hop off a kept walk continues the walk itself, past its head.
        if self.lazies.contains(root) {
            return refuse("block_head_value_root");
        }
        if self.extracts.contains(root) {
            return self.extract_head(root, head);
        }
        if self.nodes.contains(root) {
            return self.node_head(root, head);
        }
        // What a node's edge holds may be a node or a system's record: the
        // head is walked as either walks it, so it is held to both.
        let adapter_root = self.instances.contains(root)
            || self.handles.contains(root)
            || self.events.contains(root)
            || self.landings.contains(root)
            || self.members.contains(root);
        if !adapter_root {
            // A value (the records it holds, each walked as its kind walks),
            // or a name the run refuses to walk from, as the TypeScript does.
            return self.value_head(head);
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

    /// A head rooted at a value (or an expression): one edge hop off each
    /// record it holds — any kind of record, so its WHERE and ORDER BY are
    /// held to what every kind reads.
    fn value_head(&self, head: &PathHead) -> Admitted {
        let step = crate::traverse::head_step(head).map_err(|_| "block_multi_hop".to_string())?;
        refuse_meta_edge(&step.edge_type_id)?;
        self.hop(&step)
    }

    /// A head over a node the run built (`walkNodePlane`): one hop down one
    /// of its edges, the hop's WHERE scoped at each landing; its ORDER BY and
    /// LIMIT are not read.
    fn node_head(&self, root: &str, head: &PathHead) -> Admitted {
        let probe = format!("{}{}.`__movement_engine_probe__`", crate::write::spell_name(root), head.hops_raw);
        let Ok(tree) = movement_parser::expr::parse_expression(&probe) else { return refuse("block_head_does_not_lower") };
        let Ok(walk) = movement_parser::lowering::lower_expression(&tree, &probe) else { return refuse("block_head_does_not_lower") };
        let steps = match &walk {
            Expression::Traverse { steps, .. } => steps,
            _ => return refuse("block_head_does_not_lower"),
        };
        let [step] = steps.as_slice() else { return refuse("block_multi_hop") };
        let TraversalStep::Edge(step) = step else { return refuse("block_head_step") };
        refuse_meta_edge(&step.edge_type_id)?;
        match &step.expression_filter {
            Some(filter) => self.scoped(filter),
            None => Ok(()),
        }
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
        // A pick from a walk off a graph is walked as a block head walks
        // (`selectedPositionBinding`); off anything else it is the fold of
        // the walk's records, evaluated.
        // A pick from `-[:@old]->` is the evaluator's (the handle answers
        // the hop itself), as the TypeScript's `selectedPositionBinding`
        // leaves it.
        if let Some((root, steps)) = selection(&expr)
            && self.walks_from(root)
            && !crate::reading::starts_with_old_edge(steps)
        {
            let [TraversalStep::Edge(step)] = steps else { return refuse("select_multi_hop") };
            return self.hop(step);
        }
        self.expression(&expr)
    }

    /// The event, a handle, a landing, a node or an extraction's record.
    fn is_record(&self, name: &str) -> bool {
        self.events.contains(name)
            || self.handles.contains(name)
            || self.landings.contains(name)
            || self.nodes.contains(name)
            || self.extracts.contains(name)
            || self.members.contains(name)
            || self.lazies.contains(name)
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

    /// A walk's hops off `root` (crate::reading `read_from`): edges, each
    /// one's WHERE and ORDER BY scoped at the record it lands on; off an
    /// extraction, plain hops down its result. Off a value, the walk is off
    /// the records it holds; off a kept walk, the walk runs on past its
    /// head, which this engine does not do.
    fn walk_hops(&self, root: &str, steps: &[TraversalStep]) -> Admitted {
        if self.lazies.contains(root) {
            return refuse("traversal_root");
        }
        if self.extracts.contains(root) {
            return steps.iter().try_for_each(|step| match step {
                TraversalStep::Edge(step) if step.expression_filter.is_none() => Ok(()),
                _ => refuse("walk_extract_hop"),
            });
        }
        steps.iter().try_for_each(|step| match step {
            TraversalStep::Edge(step) => self.hop(step),
            _ => refuse("traversal_step"),
        })
    }

    /// `EXISTS(root…)`: over a value, whether it holds one (or, with hops,
    /// a walk off the records it holds); over an extraction, plain hops
    /// down it; over anything else, edges; each hop's WHERE and ORDER BY,
    /// and the final WHERE, scoped at the record reached.
    fn exists(&self, root: &str, steps: &[TraversalStep], where_: Option<&Expression>) -> Admitted {
        if self.extracts.contains(root) {
            for step in steps {
                match step {
                    TraversalStep::Edge(step) if step.expression_filter.is_none() && step.cardinality.is_none() => {}
                    _ => return refuse("exists_extract_hop"),
                }
            }
        } else {
            for step in steps {
                let TraversalStep::Edge(step) = step else { return refuse("exists_step") };
                self.hop(step)?;
            }
        }
        match where_ {
            Some(where_) => self.scoped(where_),
            None => Ok(()),
        }
    }

    /// `readCall`'s reading of a call of a collection op or `MEMBERS`, from
    /// version 3; a reading that refuses is the checker's to refuse.
    fn reading(&self, call: &CallStatement) -> Result<Option<crate::collection::Reading>, String> {
        let binds = self.binds(&call.callee) || self.callee(&call.callee).is_some() || self.plugin(&call.callee);
        crate::collection::reading(call, binds, self.language_version).map_err(|_| "builtin_call_form".to_string())
    }

    fn reading_admitted(&self, reading: &crate::collection::Reading, reason: &str) -> Admitted {
        match reading {
            crate::collection::Reading::Collection(op) => self.collection_op(op, reason),
            crate::collection::Reading::Members(_) => Ok(()),
        }
    }

    /// A collection op (crate::collection): one member at a time (a setting
    /// that runs more at once is refused by the op's own reason); its
    /// collection, start and closure body walked, the body as a member's —
    /// its parameters values, which may hold records. A movement handed by
    /// name is walked under every kind a member may be (`Bound::collection`).
    fn collection_op(&self, op: &CollectionOpExpression, reason: &str) -> Admitted {
        match crate::collection::settings(op.config.as_ref()) {
            Ok((_, concurrency, initial)) if concurrency == 1.0 && initial == 1.0 => {}
            _ => return refuse(reason),
        }
        self.slot(&op.source)?;
        if let Some(init) = &op.init {
            self.slot(init)?;
        }
        match &op.r#fn {
            // Its parameters are values in its body, over whatever else
            // their names are bound to outside it.
            ArmExpression::Closure { closure, .. } => {
                let params: BTreeSet<String> = closure.params.iter().map(|p| p.name.clone()).collect();
                let without = |set: &BTreeSet<String>| -> BTreeSet<String> { set.difference(&params).cloned().collect() };
                let values: BTreeSet<String> = self.values.union(&params).cloned().collect();
                let (events, handles, nodes, landings, members, lazies, extracts, graphs) = (
                    without(self.events),
                    without(self.handles),
                    without(self.nodes),
                    without(self.landings),
                    without(self.members),
                    without(self.lazies),
                    without(self.extracts),
                    without(self.graphs),
                );
                // A member of a source free of records is free of them; a
                // REDUCE's accumulator is what the function returned.
                let mut value_holders = self.value_holders.clone();
                for param in &params {
                    value_holders.remove(param);
                }
                let member = lowered(&op.source.raw).map_or(Holder::Other, |source| member_holder(&source, &|name| self.holder(name)));
                value_holders.extend(closure.params.iter().enumerate().map(|(index, p)| (p.name.clone(), param_holder(op.op, index, member))));
                let member = Names {
                    value_holders: &value_holders,
                    values: &values,
                    events: &events,
                    handles: &handles,
                    nodes: &nodes,
                    landings: &landings,
                    members: &members,
                    lazies: &lazies,
                    extracts: &extracts,
                    graphs: &graphs,
                    instances: without(&self.instances),
                    ..*self
                };
                member.body(&closure.body, Within::Member);
                Ok(())
            }
            ArmExpression::Ref { .. } if self.unknown_calls.contains(&op.span) => refuse("movement_call"),
            ArmExpression::Ref { .. } => Ok(()),
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
            || self.movements.iter().any(|m| crate::js::to_lower_case(m) == crate::js::to_lower_case(&call.callee));
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
            self.plugin_arg(slot)?;
        }
        Ok(())
    }

    /// `x = extract from […] { tree }` (crate::extract): its tier read off
    /// the run's input (`extractionTiers`), the `from` slots and every word the
    /// tree writes walked as expressions, each `through` plugin's arguments
    /// too — a bare name there reads the entity's field of that name first,
    /// else a value the body binds.
    fn extract(&self, extract: &ast::ExtractExpression) -> Admitted {
        extract.from.iter().try_for_each(|slot| self.slot(slot))?;
        // A `from` datum is written into the prompt as `JSON.stringify` writes
        // it: the event's binding object is `{"kind":"event"}`, and every
        // other record's holds what only the TypeScript engine has.
        if extract.from.iter().any(|slot| self.may_hold_record_slot(slot)) {
            return refuse("extract_from_record");
        }
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
                    self.plugin_arg(&arg.value)?;
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

    /// A declared shape's words, at every depth. (A field or node named
    /// `__proto__` is the checker's `MOV_SHAPE_FIELD_PROTO`: the run ends at
    /// the check on either engine.)
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
                || self.members.contains(name)
                || self.lazies.contains(name)
                || self.instances.contains(name)
                || self.file_names.contains(name))
    }

    /// The movement a call names (`Callees::callee`).
    fn callee(&self, written: &str) -> Option<&ast::MovementDeclaration> {
        self.callees.callee(written, self.binds(written))
    }

    /// A function name nothing in the program or the standard library
    /// answers (`DOMAIN_OF`): a function the write field advertises, or the
    /// TypeScript's own MOVENG_UNSUPPORTED naming it, both run here. A
    /// namespaced member, a name the standard library knows otherwise
    /// (`lookupBuiltin`: `FILE`, `READ`, `CHUNKS`, a collection op, `extract`
    /// …), and a name the program binds or declares (in any letter case: a
    /// call written in place, which the TypeScript runs first) stay refused
    /// by name.
    fn integration_function(&self, id: &str) -> bool {
        const OWN: [&str; 30] = [
            "map", "filter", "reduce", "groupby", "keyby", "members", "extract", "extractone", "file", "read", "chunks", "ai", "llm_agg",
            "kg_exists", "kg_value", "extract_value", "first", "last", "only", "count", "sum", "avg", "min", "max", "join", "collect", "at",
            "sort", "concat", "exists",
        ];
        let lowered = crate::js::to_lower_case(id);
        !id.contains('.')
            && !OWN.contains(&lowered.as_str())
            && !crate::stdlib::FLAT.contains(&lowered.as_str())
            && self.callee(id).is_none()
            && !self.binds_any_case(id)
    }

    /// A name the body itself binds (a parameter, a value, a record).
    fn binds_in_body(&self, name: &str) -> bool {
        self.events.contains(name)
            || self.extracts.contains(name)
            || self.values.contains(name)
            || self.handles.contains(name)
            || self.nodes.contains(name)
            || self.members.contains(name)
            || self.lazies.contains(name)
            || self.landings.contains(name)
            || self.body_instances.contains(name)
    }

    /// `CallScope.binds`: a name the file or the body binds, anywhere.
    /// `binds`, or `movements`, `shapes`, `graphs`, `plugins` or an
    /// instance, for a name in any letter case.
    fn binds_any_case(&self, name: &str) -> bool {
        let lowered = crate::js::to_lower_case(name);
        let sets: [&BTreeSet<String>; 15] = [
            self.events, self.extracts, self.values, self.handles, self.nodes, self.members, self.lazies, self.body_instances,
            self.file_names, self.landings, &self.instances, self.movements, self.plugins, self.graphs, self.shapes,
        ];
        sets.iter().any(|set| set.iter().any(|bound| crate::js::to_lower_case(bound) == lowered))
    }

    fn binds(&self, name: &str) -> bool {
        self.events.contains(name)
            || self.extracts.contains(name)
            || self.values.contains(name)
            || self.handles.contains(name)
            || self.nodes.contains(name)
            || self.members.contains(name)
            || self.lazies.contains(name)
            || self.body_instances.contains(name)
            || self.file_names.contains(name)
    }

    fn write(&self, write: &WriteExpression) -> Admitted {
        if write.bind.is_some() {
            return refuse("write_bind");
        }
        match &write.target {
            // One record at the convergence of its paths, each a linked
            // write's (`resolveTupleWriteTarget`).
            WriteTarget::Tuple { paths, .. } => paths.iter().try_for_each(|path| self.target_path(path, "write"))?,
            // `write m.k { … }`: the record a map holds, bound for the write
            // alone (run.ts `bindSlotValue`), which this engine does not.
            WriteTarget::Position { root: PathRoot::Expression { .. }, .. } => return refuse("write_position_member_path"),
            // The record the name holds, updated in place (a write's
            // handle moved on to it from version 4); anything else fails as
            // the TypeScript's `executePositionWrite` fails it.
            WriteTarget::Position { root: PathRoot::Name { .. }, .. } => {}
            WriteTarget::Linked { path, .. } => self.target_path(path, "write")?,
        }
        for clause in &write.unique_by {
            unique_clause(&clause.predicate.raw)?;
        }
        // A spread is its field lines, `f: e.f` per field the checker stamped
        // (`expandWriteSpreads`): reads of whatever `e` (or `m.k`) holds.
        write.fields.iter().try_for_each(|field| self.slot(&field.value))?;
        if !self.writes_into_node(&write.target) {
            self.system_fields(&write.fields, write.spreads.as_deref().unwrap_or_default())?;
        }
        Ok(())
    }

    /// Whether a write lands in a node this run built (no system is asked).
    fn writes_into_node(&self, target: &WriteTarget) -> bool {
        let root = match target {
            WriteTarget::Linked { path, .. } => match &path.root {
                Some(PathRoot::Name { name }) => name,
                _ => return false,
            },
            WriteTarget::Position { root: PathRoot::Name { name }, .. } => name,
            _ => return false,
        };
        self.nodes.contains(root) || self.members.contains(root)
    }

    /// The fields a write or a match hands a system's adapter: the
    /// TypeScript hands it a record as the binding object itself, which no
    /// request of this engine's carries.
    fn system_fields(&self, fields: &[ast::FieldEntry], spreads: &[ast::WriteSpread]) -> Admitted {
        if fields.iter().any(|field| self.may_hold_record_slot(&field.value)) {
            return refuse("write_field_record");
        }
        // A spread of a value reads that value's members' fields.
        if spreads.iter().any(|spread| spread.path.is_none() && self.holder(&spread.source) == Holder::Other && self.values.contains(&spread.source)) {
            return refuse("write_field_record");
        }
        Ok(())
    }

    /// A write's or a match's linked target: one edge off an instance, a
    /// handle, the event or a hop alias, its WHERE scoped at the candidate.
    fn target_path(&self, path: &PathHead, verb: &str) -> Admitted {
        let Some(PathRoot::Name { name: root }) = &path.root else { return refuse(format!("{verb}_root_expression")) };
        // Rooted at any name: the record it holds parents the write (or the
        // engine is the adapter, into a node the run built), and anything
        // else fails as the TypeScript's `linkedPathGraph` fails it — but a
        // declared shape's name is a shape write (an in-memory position),
        // which this engine does not make.
        if self.shapes.contains(root) && !self.binds_in_body(root) {
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
        m.fields.iter().try_for_each(|field| self.slot(&field.value))?;
        self.system_fields(&m.fields, &[])
    }

    /// `link a -[:e]-> b` or `link a -[:e]-> { match body }`: the endpoints
    /// written handles (a link into a node this run built appends a landing,
    /// which this engine does not).
    fn link(&self, link: &ast::LinkExpression) -> Admitted {
        // Onto an edge of a node the run built: the landing is appended
        // (a body form is the TypeScript's own refusal, mirrored).
        // What a node's edge holds links as a node or as a handle, whichever
        // it turns out to be; either refuses what does not fit, mirrored.
        if self.nodes.contains(&link.from) || self.members.contains(&link.from) {
            return match &link.to {
                ast::LinkTarget::Handle { .. } => Ok(()),
                ast::LinkTarget::Match { r#match, .. } => self.match_(r#match),
            };
        }
        // Any other endpoint is the record its name holds, which must be a
        // written handle (`resolveEdgeEndpoint`), whatever the name was bound
        // from: a value may hold one.
        match &link.to {
            ast::LinkTarget::Handle { .. } => Ok(()),
            ast::LinkTarget::Match { r#match, .. } => self.match_(r#match),
        }
    }

    /// A node or graph literal node.rs builds: value entries, nested
    /// literals, and in a graph a reference to a record the run holds and a
    /// spread of a value, a handle or a node; no shape, no declared or
    /// traversal entry.
    fn node(&self, literal: &NodeLiteral, graph: bool) -> Admitted {
        if !graph && literal.spreads.is_some() {
            return refuse("node_spread");
        }
        let records = |name: &str| self.handles.contains(name) || self.nodes.contains(name);
        // A record spread is copied by the checker's plan, read off the record
        // as it is: what a node's edge holds, a walked or extracted record too.
        let copied = |name: &str| records(name) || self.members.contains(name) || self.landings.contains(name) || self.extracts.contains(name);
        for spread in literal.spreads.iter().flatten() {
            if spread.path.is_some() {
                return refuse("node_spread_path");
            }
            if !self.values.contains(&spread.source) && !copied(&spread.source) {
                return refuse("node_spread_source");
            }
            // A map spread into a graph files a nested map (or a list of
            // them) as a child (`asMapList`), and the TypeScript takes a
            // record's binding object for a map too: its internals would
            // become the child's fields.
            if self.values.contains(&spread.source) && matches!(self.holder(&spread.source), Holder::Map { .. } | Holder::List | Holder::Other) {
                return refuse("node_spread_record");
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
                // A declared edge starts empty: it grows by a write or a link.
                NodeEntry::Declared { .. } if !graph => {}
                NodeEntry::Declared { .. } => return refuse("node_declared_entry"),
                // Walked where the literal stands, as a block head walks; a
                // lazy entry walks at each read.
                // In a graph a walk is always walked where it stands, its
                // tail a graph body.
                NodeEntry::Traversal { head, mapping, .. } => self.traversal_entry(head, mapping.as_ref(), graph)?,
            }
        }
        Ok(())
    }

    /// `walkLandings`: the head walked as a block head, and the tail
    /// literal, if any, read once per landing with the head's alias naming
    /// it (an extraction's entity, what a node's edge holds, or a record
    /// the walk landed on).
    fn traversal_entry(&self, head: &PathHead, mapping: Option<&NodeLiteral>, graph: bool) -> Admitted {
        self.head(head)?;
        let Some(mapping) = mapping else { return Ok(()) };
        let root = match &head.root {
            Some(PathRoot::Name { name }) => name.as_str(),
            _ => "",
        };
        let alias = crate::traverse::head_step(head).ok().and_then(|step| step.alias);
        let (mut extracts, mut members, mut landings) = (self.extracts.clone(), self.members.clone(), self.landings.clone());
        if let Some(alias) = alias {
            if self.extracts.contains(root) {
                extracts.insert(alias);
            } else if self.nodes.contains(root) || self.members.contains(root) {
                members.insert(alias);
            } else {
                landings.insert(alias);
            }
        }
        let item = Names { extracts: &extracts, members: &members, landings: &landings, instances: self.instances.clone(), ..*self };
        item.node(mapping, graph)
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
            // Any name: a value as itself, a record as itself (`readBareName`),
            // anything else refused as the TypeScript refuses it.
            Expression::AliasRef { .. } | Expression::Property { .. } => Ok(()),
            // `EXISTS(x-[:e]->)` lowers as a walk ending in the quantifier.
            Expression::Traverse { alias_root: Some(root), steps, expression } if steps.is_empty() && matches!(expression.as_ref(), Expression::Exists { .. }) => {
                let Expression::Exists { steps, where_ } = expression.as_ref() else { unreachable!("matched above") };
                self.exists(root, steps, where_.as_deref())
            }
            Expression::Traverse { expression, .. } if matches!(expression.as_ref(), Expression::Exists { .. }) => refuse("expression:exists"),
            // A walk read for a field, many-valued.
            // A walk read for a field, or as the records it lands on.
            Expression::Traverse { alias_root: Some(root), steps, expression } if !steps.is_empty() => match expression.as_ref() {
                Expression::Property { .. } | Expression::EdgeProperty { .. } => self.walk_hops(root, steps),
                _ => refuse("traversal_terminal"),
            },
            Expression::Aggregate { fn_, expression, order_by, .. } => self.aggregate(*fn_, expression, order_by.as_deref(), scoped),
            // The run's pinned instant; the acting user and the actor are
            // looked up, and the dispatch's bag is not the input's.
            Expression::Meta { key } if key == "current_date" || key == "current_timestamp" || crate::eval::is_host_meta(key) => Ok(()),
            // The dispatch's bag (`trigger`, `mutationContext`), which no
            // author writes: the checker refuses any other `@` key.
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
            // A field read with no hops off any name (`directFieldRead`, or a
            // value's own field), or on through a map's key (`m.k.f`).
            Expression::Traverse { alias_root: Some(_), expression, .. } => match expression.as_ref() {
                Expression::Property { .. } | Expression::EdgeProperty { .. } => Ok(()),
                Expression::Traverse { alias_root: Some(_), steps, .. } if steps.is_empty() => {
                    let mut terminal = expression.as_ref();
                    while let Expression::Traverse { steps, expression, .. } = terminal {
                        if !steps.is_empty() {
                            return refuse("traversal_steps");
                        }
                        terminal = expression;
                    }
                    match terminal {
                        Expression::Property { .. } | Expression::EdgeProperty { .. } => Ok(()),
                        _ => refuse("traversal_terminal"),
                    }
                }
                _ => refuse("traversal_terminal"),
            },
            Expression::Traverse { alias_root: None, .. } => refuse("traversal_root"),
            Expression::Static { value: StaticValue::Number(n) } => {
                if n.0.is_finite() && !(n.0 == 0.0 && n.0.is_sign_negative()) { Ok(()) } else { refuse("static_number") }
            }
            Expression::Static { .. } => Ok(()),
            Expression::At { expression, index } => {
                self.walk(expression, scoped)?;
                self.walk(index, scoped)?;
                // `AT` over a record reads the binding object's own keys
                // (`isDictValue`): its internals, past the few this engine
                // holds as the TypeScript holds them.
                let holder = |name: &str| self.holder(name);
                let record = holds_record(expression, &holder, scoped) && matches!(value_holder(expression, &holder), Holder::Record | Holder::Other);
                let plain = match index.as_ref() {
                    Expression::Static { value: StaticValue::String(key) } => !INTERNAL_KEYS.contains(&key.as_str()),
                    Expression::Static { value: StaticValue::Number(_) } => true,
                    _ => false,
                };
                if record && !plain { refuse("at_record_key") } else { Ok(()) }
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
                if !FUNCTIONS.contains(&fn_.as_str()) && !self.integration_function(fn_) {
                    return refuse(format!("function:{fn_}"));
                }
                // A reading handed back carries its arguments to the host.
                if HANDED_BACK.contains(&fn_.as_str()) && args.iter().any(|arg| holds_record(arg, &|name| self.holder(name), scoped)) {
                    return refuse("builtin_arg_record");
                }
                each(args)
            }
            // `AI()`: its prompt expression walked; the call is the run's.
            Expression::Llm { prompt_expression, .. } => match prompt_expression {
                Some(expression) => self.walk(expression, scoped),
                None => Ok(()),
            },
            other => refuse(format!("expression:{}", crate::eval::kind_of(other))),
        }
    }
}

impl Names<'_> {
    /// What `name` holds here, as far as a record goes.
    fn holder(&self, name: &str) -> Holder {
        if self.values.contains(name) {
            return self.value_holders.get(name).copied().unwrap_or(Holder::Other);
        }
        if self.record_nodes.contains(name) {
            return Holder::Other;
        }
        // The event's binding object is plain data (`{kind: 'event'}`),
        // carried as itself.
        if self.events.contains(name) {
            return Holder::Free;
        }
        let records = [self.handles, self.landings, self.nodes, self.members, self.extracts, self.graphs, self.lazies];
        if records.iter().any(|set| set.contains(name)) || self.instances.contains(name) {
            return Holder::Record;
        }
        // A name nothing binds reads as nothing: the read fails on both
        // engines before any request is made.
        if self.file_names.contains(name) { Holder::Other } else { Holder::Free }
    }

    /// Whether a slot's value may hold a record (one it does not lower to
    /// is refused where it is walked).
    fn may_hold_record_slot(&self, slot: &ExprSlot) -> bool {
        lowered(&slot.raw).map_or(true, |expr| may_hold_record(&expr, &|name| self.holder(name)))
    }

    /// A plugin's argument: one record reads as its fields
    /// (`recordFields`); a record anywhere inside a list or a map is handed
    /// to the plugin as the binding object itself, which this engine's
    /// wire does not carry.
    fn plugin_arg(&self, slot: &ExprSlot) -> Admitted {
        let Ok(expr) = lowered(&slot.raw) else { return Ok(()) };
        let one_record = match &expr {
            Expression::AliasRef { name } | Expression::Property { property_type_id: name } if !self.values.contains(name) => !self.lazies.contains(name),
            other => selection(other).is_some() || value_holder(other, &|name| self.holder(name)) == Holder::Record,
        };
        if !one_record && may_hold_record(&expr, &|name| self.holder(name)) { refuse("plugin_arg_record") } else { Ok(()) }
    }

    /// A bare name bound to something that is not a value.
    fn bound_non_value(&self, expr: &Expression) -> bool {
        let (Expression::Property { property_type_id: name } | Expression::AliasRef { name }) = expr else { return false };
        !self.values.contains(name) && (self.is_record(name) || self.instances.contains(name))
    }

    /// `case 'aggregate'`: the folds over a value, a walk read for a field,
    /// or (`COUNT`) the records a walk lands on.
    fn aggregate(&self, fn_: AggregationFunction, inner: &Expression, order_by: Option<&Expression>, scoped: bool) -> Admitted {
        match fn_ {
            AggregationFunction::Llm => refuse("aggregate:llm"),
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

/// What a name holds, as far as a value it reaches may hold a record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Holder {
    /// A value known never to hold a record: what it was bound to holds
    /// none (literals, a system record's fields, the built-ins over those,
    /// the event's binding object, which is plain data).
    Free,
    /// One record whose fields hold no record: a system's (a handle, a
    /// landed record, an instance; its fields are the host's data), an
    /// extraction's entity, a plugin's record, a node whose literal and
    /// local writes hold no record.
    Record,
    /// A map holding records of the kind above (or lists of them, `lists`)
    /// no deeper than `depth` keys (`held = { k: co }` is 1): a read that
    /// many keys deep may be a record, a read deeper is a field of one.
    Map { depth: u8, lists: bool },
    /// A list whose members are each free of records or one record of that
    /// kind (a walk read as its records, `[co]`, what a MAP returning `c`
    /// hands back): a member may be a record, a field of one is not.
    List,
    /// Anything else: a value that may hold records in ways not followed
    /// here, or a node whose literal (or a local write) holds one.
    Other,
}

impl Holder {
    /// What a name bound more than once holds: the widest of its bindings.
    fn join(self, other: Holder) -> Holder {
        match (self, other) {
            (a, b) if a == b => a,
            (Holder::Map { depth: a, lists: x }, Holder::Map { depth: b, lists: y }) => Holder::Map { depth: a.max(b), lists: x || y || a != b },
            (Holder::Free, wide @ (Holder::Map { .. } | Holder::List)) | (wide @ (Holder::Map { .. } | Holder::List), Holder::Free) => wide,
            _ => Holder::Other,
        }
    }
}

/// What each member of the list `expr` holds (a collection op's
/// parameter): free of records, one record whose fields are, or anything.
fn member_holder(expr: &Expression, holder: &dyn Fn(&str) -> Holder) -> Holder {
    if !may_hold_record(expr, holder) {
        return Holder::Free;
    }
    let one = |e: &Expression| match e {
        Expression::AliasRef { name } | Expression::Property { property_type_id: name } => holder(name) == Holder::Record,
        other => !may_hold_record(other, holder),
    };
    match expr {
        Expression::AliasRef { name } | Expression::Property { property_type_id: name } if matches!(holder(name), Holder::List | Holder::Map { depth: 1, .. }) => Holder::Record,
        // A read as deep as a map holds its records: one, or a list of them.
        Expression::Traverse { alias_root: Some(root), steps, expression } if steps.is_empty() && field_read(expression) => match holder(root) {
            Holder::Map { depth, .. } if read_depth(expression) == usize::from(depth) => Holder::Record,
            _ => Holder::Other,
        },
        Expression::Traverse { .. } if records_walk_off_record(expr, holder) => Holder::Record,
        Expression::List { elements } if elements.iter().all(|e| matches!(e, ListElement::Expression(e) if one(e))) => Holder::Record,
        Expression::Aggregate { fn_: AggregationFunction::Sort | AggregationFunction::Collect, expression, .. } => member_holder(expression, holder),
        _ => Holder::Other,
    }
}

/// A walk read as the records it lands on, off a record (or a value):
/// each landing is a system's record, or a node's edge's.
fn records_walk_off_record(expr: &Expression, holder: &dyn Fn(&str) -> Holder) -> bool {
    match expr {
        Expression::Traverse { alias_root: Some(root), steps, expression } => {
            !steps.is_empty() && !field_read(expression) && !matches!(expression.as_ref(), Expression::Exists { .. }) && matches!(holder(root), Holder::Record | Holder::Free)
        }
        _ => false,
    }
}

/// What a collection op's function's parameter at `index` holds: the
/// member (a REDUCE's second), else what is not followed here (a REDUCE's
/// accumulator).
fn param_holder(op: CollectionOp, index: usize, member: Holder) -> Holder {
    match (op, index) {
        (CollectionOp::Reduce, 1) => member,
        (CollectionOp::Reduce, _) => Holder::Other,
        _ => member,
    }
}

/// The values a body's `return`s hand back, its `if` arms' included (not a
/// nested block's iterations').
fn returns_of<'s>(body: &'s [Statement], out: &mut Vec<&'s RValue>) {
    for statement in body {
        match statement {
            Statement::Return(ret) => out.push(&ret.value),
            Statement::If(statement) => {
                for arm in &statement.arms {
                    returns_of(&arm.body, out);
                }
                if let Some(arm) = &statement.else_arm {
                    returns_of(&arm.body, out);
                }
            }
            _ => {}
        }
    }
}

/// What a value bound to `expr` holds, given what the names it reads hold.
fn value_holder(expr: &Expression, holder: &dyn Fn(&str) -> Holder) -> Holder {
    if !may_hold_record(expr, holder) {
        return Holder::Free;
    }
    // One member picked off such a list (or such a map) is one such record.
    if let Expression::Aggregate { fn_: AggregationFunction::First | AggregationFunction::Last | AggregationFunction::Only, expression, .. } | Expression::At { expression, .. } = expr
        && member_holder(expression, holder) == Holder::Record
    {
        return Holder::Record;
    }
    if let Expression::AliasRef { name } | Expression::Property { property_type_id: name } = expr {
        return match holder(name) {
            wide @ (Holder::Map { .. } | Holder::List | Holder::Record) => wide,
            _ => Holder::Other,
        };
    }
    if let Expression::Traverse { alias_root: Some(root), steps, expression } = expr
        && steps.is_empty()
        && field_read(expression)
        && let Holder::Map { depth, lists } = holder(root)
    {
        let read = read_depth(expression);
        return match read.cmp(&usize::from(depth)) {
            std::cmp::Ordering::Less => Holder::Map { depth: depth - read as u8, lists },
            // A record, or a list of them: read alike but as one record.
            std::cmp::Ordering::Equal if lists => Holder::List,
            std::cmp::Ordering::Equal => Holder::Record,
            std::cmp::Ordering::Greater => Holder::Free,
        };
    }
    if member_holder(expr, holder) == Holder::Record {
        return Holder::List;
    }
    map_depth(expr, holder).map_or(Holder::Other, |(depth, lists)| Holder::Map { depth, lists })
}

/// How many keys deep a map literal holds a record (`{ k: co }` is 1), when
/// each member is free of records, one record, or such a map.
fn map_depth(expr: &Expression, holder: &dyn Fn(&str) -> Holder) -> Option<(u8, bool)> {
    let Expression::Object { entries } = expr else { return None };
    let mut depths: Vec<u8> = Vec::new();
    let mut lists = false;
    for entry in entries {
        let ObjectMember::Entry { value, .. } = entry else { return None };
        let member = match value_holder(value, holder) {
            Holder::Free => continue,
            Holder::Record => 1,
            Holder::List => {
                lists = true;
                1
            }
            Holder::Map { depth, lists: inner } => {
                lists |= inner;
                depth.checked_add(1)?
            }
            Holder::Other => return None,
        };
        depths.push(member);
    }
    let depth = *depths.iter().max()?;
    // Records at two depths: a read at the shallower is a map holding them.
    Some((depth, lists || depths.iter().any(|d| *d != depth)))
}

/// How many keys a field read reads (`m.k` 1, `m.k.f` 2).
fn read_depth(terminal: &Expression) -> usize {
    match terminal {
        Expression::Traverse { alias_root: Some(_), steps, expression } if steps.is_empty() => 1 + read_depth(expression),
        _ => 1,
    }
}

/// Whether `expr`'s value may hold a record (`Js::Record`) — itself, or
/// inside its lists and maps. A request carries no record the TypeScript
/// engine would hand its host as the binding object, so admission refuses
/// one where a request would take it.
fn may_hold_record(expr: &Expression, holder: &dyn Fn(&str) -> Holder) -> bool {
    holds_record(expr, holder, false)
}

/// The built-ins that hand back one of their arguments (or a list of them).
const PASSING: [&str; 2] = ["coalesce", "multi"];

/// `may_hold_record`, `scoped` at a landed record: there a bare name reads
/// the record's field (a hop's WHERE, its ORDER BY key).
fn holds_record(expr: &Expression, holder: &dyn Fn(&str) -> Holder, scoped: bool) -> bool {
    let at = |e: &Expression| holds_record(e, holder, scoped);
    match expr {
        Expression::Property { .. } | Expression::EdgeProperty { .. } if scoped => false,
        Expression::AliasRef { name } | Expression::Property { property_type_id: name } => holder(name) != Holder::Free,
        Expression::Traverse { expression, .. } if matches!(expression.as_ref(), Expression::Exists { .. }) => false,
        // A field read, or a walk read for a field: the root's fields; a
        // map's member, or a field read off one.
        Expression::Traverse { alias_root: Some(root), steps, expression } if field_read(expression) => match holder(root) {
            Holder::Free | Holder::Record => false,
            Holder::Map { depth, .. } => !steps.is_empty() || read_depth(expression) <= usize::from(depth),
            Holder::List => !steps.is_empty(),
            Holder::Other => true,
        },
        // A walk read as the records it lands on.
        Expression::Traverse { .. } => true,
        Expression::Aggregate { fn_: AggregationFunction::Count | AggregationFunction::Sum | AggregationFunction::Avg | AggregationFunction::Join, .. } => false,
        Expression::Aggregate { expression, .. } => at(expression),
        Expression::Static { .. } | Expression::Meta { .. } | Expression::Llm { .. } => false,
        Expression::Compare { .. } | Expression::Logical { .. } | Expression::Not { .. } | Expression::Negate { .. } | Expression::Arithmetic { .. } | Expression::Concat { .. } => false,
        Expression::At { expression, .. } => at(expression),
        Expression::Conditional { then, else_, .. } => at(then) || at(else_),
        Expression::List { elements } => elements.iter().any(|element| match element {
            ListElement::Expression(e) => at(e),
            ListElement::Spread(spread) => at(&spread.expression),
        }),
        Expression::Object { entries } => entries.iter().any(|member| match member {
            ObjectMember::Entry { value, .. } => at(value),
            ObjectMember::Spread(spread) => at(&spread.expression),
        }),
        // The rest answer text, a number, a flag or a list of texts.
        Expression::Function { fn_, args } => PASSING.contains(&fn_.as_str()) && args.iter().any(at),
        _ => true,
    }
}

/// A walk or a field read ending in a field (at any depth of `m.k.f`); a
/// walk read as its records ends in the position sentinel instead.
fn field_read(terminal: &Expression) -> bool {
    match terminal {
        Expression::Property { property_type_id } => property_type_id != movement_parser::lowering::POSITION_SENTINEL,
        Expression::EdgeProperty { .. } => true,
        Expression::Traverse { alias_root: Some(_), expression, .. } => field_read(expression),
        _ => false,
    }
}

/// The keys of a binding object that hold the TypeScript engine's own
/// currency (a read seam, provenance objects, `Map`s): `AT` hands them out.
const INTERNAL_KEYS: [&str; 12] = ["provenance", "graph", "read", "fields", "fieldProvenance", "edges", "emission", "walk", "constructionConfig", "schema", "declaration", "fileEnv"];

/// The built-ins whose reading this engine may hand back to the TypeScript
/// member (`builtins.function`) on what their arguments hold: a regex nested
/// past what V8's stack allows, astral text.
const HANDED_BACK: [&str; 2] = ["split", "text.regex_extract"];

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
    plugins.contains(callee) || (language_version >= 3 && plugins.iter().any(|p| crate::js::to_lower_case(p) == crate::js::to_lower_case(callee)))
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

/// A hop over `-[:@old]->` (version 4 on) is answered by the write handle
/// it is off (crate::reading `is_old_edge`), so only the meta edges refuse.
fn refuse_meta_edge(edge: &str) -> Admitted {
    if is_meta_edge(edge) { refuse("traversal_meta_edge") } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The first reason, as a walk that stopped there gives it: the entry
    /// is the file's only movement, or every movement when there are more.
    fn refusal(program: &ast::Program, language_version: u32, catalog: &Plugins<'_>) -> Option<String> {
        let declared: Vec<&ast::MovementDeclaration> = program.statements.iter().filter_map(|s| if let Statement::Movement(m) = s { Some(m) } else { None }).collect();
        let entry = entry_of(&declared, None, language_version);
        refusals(program, &reachable(program, None, language_version), entry, language_version, catalog).reasons.into_iter().next()
    }

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

    /// Every reason, the entry named: what `run` hands the shim.
    fn reasons_of(source: &str, entry: &str, language_version: u32) -> Vec<String> {
        let program = movement_parser::stmt::parse_program(source, language_version, false).expect("the test's program parses");
        let declared: Vec<&ast::MovementDeclaration> = program.statements.iter().filter_map(|s| if let Statement::Movement(m) = s { Some(m) } else { None }).collect();
        let picked = entry_of(&declared, Some(entry), language_version);
        refusals(&program, &reachable(&program, Some(entry), language_version), picked, language_version, &Plugins(None)).reasons
    }

    /// A movement nothing the entry reaches names is not walked: what it
    /// holds cannot run. One the entry names, directly or through another,
    /// is — by a call, a named arm, a movement handed as a closure, in any
    /// letter case, bare or backtick-quoted.
    #[test]
    fn walks_the_entry_and_what_it_reaches_and_nothing_else() {
        let helper = "movement helper(e: <inbox-[:message]->>) {\n  x = KG_VALUE(\"why\")\n}\n";
        // The helper after the entry: movements are walked in source order.
        let entry = |body: &str| format!("{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}\n{helper}");
        assert_eq!(reasons_of(&entry("  s = msg.`subject`"), "m", 3), Vec::<String>::new(), "an unreached helper");
        assert_eq!(reasons_of(&entry("  s = msg.`subject`"), "helper", 3), ["expression:kg_value"], "the helper as the entry");
        for (body, first) in [
            // A call is walked into: what the callee holds is the reason.
            ("  helper(e: msg)", "expression:kg_value"),
            ("  r = helper(e: msg)", "expression:kg_value"),
            ("  r = HELPER(msg)", "expression:kg_value"),
            ("  r = await parallel([helper])", "expression:kg_value"),
            // A movement handed to a collection op by name is called once per
            // member; a name read whole (here refused at run time, as the
            // TypeScript refuses it) reaches it too.
            ("  r = MAP([msg], helper)", "expression:kg_value"),
            ("  x = \"${`helper`}\"", "expression:kg_value"),
        ] {
            let reasons = reasons_of(&entry(body), "m", 3);
            assert_eq!(reasons.first().map(String::as_str), Some(first), "{body}: {reasons:?}");
            assert!(reasons.iter().any(|r| r == "expression:kg_value"), "{body} reaches the helper: {reasons:?}");
        }
        // Transitively: the entry names `middle`, which names `helper`.
        let chain = format!("{PRELUDE}{helper}movement middle(e: <inbox-[:message]->>) {{\n  helper(e: e)\n}}\nmovement m(msg: <inbox-[:message]->>) {{\n  middle(e: msg)\n}}");
        assert_eq!(reasons_of(&chain, "m", 3), ["expression:kg_value"]);
        // A movement taking a value is refused only where it can run.
        let valued = format!("{PRELUDE}movement v(n: <number[]>) {{\n  x = n\n}}\nmovement m(msg: <inbox-[:message]->>) {{\n  x = 1\n}}");
        assert_eq!(reasons_of(&valued, "m", 3), Vec::<String>::new());
        assert_eq!(reasons_of(&valued, "v", 3).first().map(String::as_str), Some("movement_value_param"));
        // No entry picked (none named, or one named the file lacks): the run
        // throws MOVENG_NOT_FOUND after the check on either engine; every
        // movement is walked.
        let program = movement_parser::stmt::parse_program(&entry("  x = 1"), 3, false).unwrap();
        assert_eq!(reachable(&program, None, 3).len(), 2);
        assert_eq!(reachable(&program, Some("nowhere"), 3).len(), 2);
        // Before version 3 the fired name is exact; from it, any case.
        assert_eq!(reachable(&program, Some("M"), 3).iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["m"]);
        let v2 = movement_parser::stmt::parse_program(&entry("  x = 1"), 2, false).unwrap();
        assert_eq!(reachable(&v2, Some("M"), 2).len(), 2);
        // The file's values and declarations are walked whatever the entry.
        let valued_file = format!("{PRELUDE}y = KG_VALUE(\"why\")\n{helper}movement m(msg: <inbox-[:message]->>) {{\n  x = 1\n}}");
        assert_eq!(reasons_of(&valued_file, "m", 3), ["expression:kg_value"]);
    }

    /// The walk goes on past a statement's reason, into the next statement,
    /// an `if`'s arms past its condition and a block's body past its head:
    /// every reason, each once, in the order met, the first the one a walk
    /// that stopped there gives.
    #[test]
    fn notes_every_reason_in_the_order_met() {
        let body = "  x = KG_VALUE(\"why\")\n  y = KG_VALUE(\"again\")\n  if x WITHIN \"7d\" {\n    write msg { a: 1 }\n  }\n  v = 1\n  v-[c:companies]-> {\n    z = TEXT.CHUNKS(c.`name`)\n    await sleep(1h)\n  }\n  helper(e: msg)";
        let source = format!("{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}");
        assert_eq!(
            reasons_of(&source, "m", 3),
            ["expression:kg_value", "within_compare", "expression_does_not_lower", "statement:call"]
        );
        assert_eq!(refused(body).as_deref(), Some("expression:kg_value"));
        // The file's reasons come first, then each movement's, in source order.
        let file_first = format!("import {{ x }} from \"./lib.mov\"\n{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n  inbox = 1\n  y = KG_VALUE(\"why\")\n}}");
        assert_eq!(reasons_of(&file_first, "m", 3), ["import_from_file", "name_shadowed", "expression:kg_value"]);
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
            ("  x = KG_VALUE(\"why?\")", "expression:kg_value"),
            ("  x = FIRST(crm-[:companies]->-[:deals]->)", "select_multi_hop"),
            ("  x = FIRST(crm-[:#foo]->)", "traversal_meta_edge"),
            ("  crm-[:#foo]-> {\n    y = 1\n  }", "traversal_meta_edge"),
            ("  write crm-[:#foo]-> { name: \"a\" }", "traversal_meta_edge"),
            ("  x = TEXT.CHUNKS(msg.`subject`)", "expression_does_not_lower"),
            ("  x = msg.`subject` WITHIN \"7d\"", "within_compare"),
            ("  x = { __proto__: 1 }", "proto_key"),
            ("  x = 1\n  x = write crm-[:companies]-> { name: \"a\" }", "name_rebound"),
            ("  inbox = 1", "name_shadowed"),
            ("  msg = 1", "name_shadowed"),
            ("  write crm-[:companies]-> bind co { name: \"a\" }", "write_bind"),
            ("  write crm-[:companies]-> { unique by (`name` == \"a\" AND msg-[:replies]->.`y` == 1) name: \"a\" }", "unique_by_reads_beyond_candidate"),
            ("  write crm-[:companies]-> { unique by (`name` CONTAINS \"a\") name: \"a\" }", "unique_by_without_key"),
            ("  g = graph { owner: msg }", "node_event_entry"),
            ("  g = graph { ...msg }", "node_spread_source"),
            ("  held = { k: 1 }\n  write held.k { a: 1 }", "write_position_member_path"),
            ("  held = { k: 1 }\n  g = graph { ...held.k }", "node_spread_path"),
            ("  held = { k: 1 }\n  write held.k-[:e]-> { a: 1 }", "write_root_expression"),
            ("  x = MAP([1], { concurrency: 4 }, (v) => { return v })", "rvalue:collection"),
            ("  MAP([1], { concurrency: 4 }, (v) => { return v })", "statement:collection"),
            ("  x = 1\n  r = x(2)", "function_call"),
        ] {
            assert_eq!(refused(body).as_deref(), Some(reason), "{body}");
        }
    }

    #[test]
    fn refuses_an_unsupported_version_by_that_name() {
        assert_eq!(version_refusal(99).as_deref(), Some("language_version_unsupported"));
        assert_eq!(version_refusal(0).as_deref(), Some("language_version_unsupported"));
        for version in 1..=4 {
            assert_eq!(version_refusal(version), None, "{version}");
        }
    }

    /// Language version 4 (Luminous Owl, main's d5bb93f794): the constructs
    /// whose meaning changed run here (PLAN-07A Task 4c), each a
    /// `since(v, 4)` conditional where it differs, so the same program is
    /// admitted under versions 3 and 4 alike.
    #[test]
    fn admits_version_4s_changed_constructs_and_leaves_version_3_alone() {
        let under = |body: &str, version: u32| {
            let source = format!("{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}");
            let program = movement_parser::stmt::parse_program(&source, version, false).expect("the test's program parses");
            refusal(&program, version, &Plugins(None))
        };
        for body in [
            "  co = write crm-[:companies]-> { name: \"a\" }\n  fund = link co -[:portfolio]-> { unique by (`name`), name: \"F\" }",
            "  co = write crm-[:companies]-> { unique by (`name`) name: \"a\" }",
            "  co = write crm-[:companies]-> { name: \"a\" }\n  write co-[:notes]-> { title: co.`name` }",
            "  write crm-[:companies]-> { name: \"a\" }",
            "  crm-[c:companies]-> {\n    write c { name: \"b\" }\n  }",
            "  co = match crm-[:companies]-> { unique by (`name`) name: \"a\" }",
            "  match crm-[:companies]-> { unique by (`name`) name: \"a\" }",
            "  co = write crm-[:companies]-> { name: \"a\" }\n  x = co-[:@old]->.`name`",
            "  co = write crm-[:companies]-> { name: \"a\" }\n  co-[o:@old]-> {\n    x = 1\n  }",
            "  co = write crm-[:companies]-> { name: \"a\" }\n  if EXISTS(co-[:@old]->) {\n    x = 1\n  }",
            "  co = write crm-[:companies]-> { name: \"a\" }\n  was = FIRST(co-[:@old]->)",
            "  co = write crm-[:companies]-> { name: \"a\" }\n  write co { name: \"b\" }",
            "  co = write crm-[:companies]-> { name: \"a\" }\n  x = write co { name: \"b\" }",
            "  co = match crm-[:companies]-> { unique by (`name`) name: \"a\" }\n  if co != null {\n    x = write co { name: \"b\" }\n  }",
        ] {
            assert_eq!(under(body, 4), None, "{body}");
            assert_eq!(under(body, 3), None, "{body} under version 3");
        }
    }

    /// Main's v0.10.2–v0.10.9 language changes (the merge's port list): each
    /// construct this engine does not run is refused by a name of its own,
    /// and the scan rules the parser mirrors are admitted.
    #[test]
    fn refuses_mains_new_constructs_by_name_and_admits_its_scan_rules() {
        for (body, reason) in [
            ("  held = { k: 1 }\n  write held.k { a: 1 }", "write_position_member_path"),
            ("  held = { k: { name: \"a\" } }\n  g = graph { ...held.k }", "node_spread_path"),
            ("  x = { all: MAP([msg.`subject`], (s) => UPPER(s)) }", "expression_closure"),
            ("  if COUNT(FILTER([msg.`subject`], (s) => s != \"\")) > 0 {\n    x = 1\n  }", "expression_closure"),
            ("  write crm-[c:companies]-> { unique by (`name` == AT(MAP([1], (v) => v), 0)) name: \"a\" }", "expression_closure"),
            ("  x = [MAP([1], f)]", "function:map"),
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
            ("  crm-[c:companies]->-[d:deals]-> {\n    x = d.`title`\n  }", "block_multi_hop"),
            ("  crm-[c:companies]-> {\n    x = ONLY(c-[:deals]->.`name`)\n  }", "aggregate:only"),
        ] {
            assert_eq!(refused(body).as_deref(), Some(reason), "{body}");
        }
    }

    /// Chunk 7A Task 3: records held as values — a name of any kind read
    /// whole (as the record, or refused at run time as the TypeScript
    /// refuses it), lists and maps of records, walks read as their records,
    /// heads and walks off a value's records, picks, `==`, spreads, the
    /// collection ops one member at a time, `MEMBERS`, tuple writes, a write
    /// returned, link endpoints and write roots of any name.
    #[test]
    fn admits_records_held_as_values() {
        for body in [
            "  co = write crm-[:companies]-> { name: \"a\" }\n  x = [co]\n  held = { k: co }\n  write crm-[:notes]-> { body: held.k.`name` }",
            "  x = \"${msg}\"\n  y = crm.`name`",
            "  v = 1\n  if EXISTS(v-[:deals]->) {\n    x = 1\n  }\n  v-[c:companies]-> {\n    x = 1\n  }",
            "  n = node { a: 1 }\n  x = n-[:replies]->-[:to]->.`subject`\n  y = \"${FIRST(crm-[c:companies]->)}\"",
            "  rows = crm-[c:companies]->\n  top = FIRST(rows)\n  if COUNT(rows-[:notes]->) == 2 AND EXISTS(top-[n:notes WHERE `text` == \"b\"]->) {\n    write top-[:notes]-> { body: top.`name` }\n  }",
            "  all = crm-[c:companies]-> {\n    return c\n  }\n  all-[d:deals]-> {\n    write crm-[:notes]-> { body: d.`title` }\n  }\n  same = AT(all, 0) == FIRST(all)",
            "  write crm-[:companies]-> { ...crm }\n  held = { k: { name: \"a\" } }\n  write crm-[:companies]-> { ...held.k }",
            "  names = MAP(crm-[c:companies]->, (c) => {\n    return c.`name`\n  })\n  kept = FILTER(names, (n) => {\n    return n != \"\"\n  })\n  total = REDUCE([1, 2], 0, (a, n) => {\n    return a + n\n  })\n  by = GROUPBY(names, (n) => {\n    return n\n  })\n  MAP(kept, { onError: \"warn\" }, (n) => {\n    write crm-[:notes]-> { body: n }\n  })",
            "  co = write crm-[:companies]-> { name: \"b\" }\n  link co -[:x]-> msg\n  unlink co -[:x]-> msg\n  write msg { a: 1 }\n  x = match nowhere-[:kids]-> { unique by (`a`), a: 1 }",
            "  a = write crm-[:companies]-> { name: \"a\" }\n  b = write crm-[:people]-> { name: \"b\" }\n  write (a-[:notes]->, b-[:notes]->) { body: \"x\" }",
            "  crm-[c:companies]-> {\n    return write crm-[:notes]-> { body: c.`name` }\n  }",
        ] {
            assert_eq!(refused(body), None, "{body}");
        }
        let typed = format!("{PRELUDE}type Stage = <\"a\" | \"b\">\nnode Lead {{\n  name: <text>\n}}\nmovement m(msg: <inbox-[:message]->>) {{\n  stages = MEMBERS(<Stage>)\n  x = Lead\n}}");
        assert_eq!(file(&typed), None);
        let before = movement_parser::stmt::parse_program(&format!("{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n  names = MAP(crm-[c:companies]->, (c) => {{\n    return c.`name`\n  }})\n  MAP(names, (n) => {{\n    write crm-[:notes]-> {{ body: n }}\n  }})\n}}"), 2, false).unwrap();
        assert_eq!(refusal(&before, 2, &Plugins(None)), None, "the ops written as ops, before version 3");
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
            ("  delete msg", "delete_not_record"),
            ("  x = match crm-[:companies]-> { unique by (`name` CONTAINS \"a\"), name: \"a\" }", "unique_by_without_key"),
        ] {
            assert_eq!(refused(body).as_deref(), Some(reason), "{body}");
        }
    }

    /// Chunk 7A Task 2: a call reaches its callee, which is walked under
    /// what each call binds its parameters to; what a callee hands back is
    /// the call's value; a park inside a callee is admitted (Task 4).
    #[test]
    fn walks_each_callee_under_what_its_calls_bind() {
        let note = "node Note {\n  title: <text>\n  node kids {\n    first: <text>\n  }\n}\n";
        let program = |helpers: &str, body: &str| format!("{PRELUDE}{note}{helpers}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}");
        let reasons = |helpers: &str, body: &str| reasons_of(&program(helpers, body), "m", 3);
        // A node argument: the callee reads it, heads off it, writes into it.
        let persist = "movement persist(n: <Note>) {\n  write crm-[:companies]-> { name: n.`title` }\n  n-[k:kids]-> {\n    write crm-[:notes]-> { body: k.`first` }\n  }\n  write n-[:kids]-> { first: \"x\" }\n  one = write crm-[:companies]-> { name: \"o\" }\n  link n -[:kids]-> one\n}\n";
        assert_eq!(reasons(persist, "  persist(n: node { title: msg.`subject`, kids: <Note> })"), Vec::<String>::new());
        // The event as the argument: the same body walked as the event's
        // (a link from it fails as the TypeScript's does, at run time).
        assert_eq!(reasons(persist, "  persist(n: msg)"), Vec::<String>::new());
        // Two calls, two signatures: each walked; a park inside a block
        // inside a callee is admitted (Chunk 7A Task 4).
        let lazy = "movement lazy(n: <Note>) {\n  n-[k:kids]-> {\n    await sleep(1h)\n  }\n}\n";
        assert_eq!(reasons(lazy, "  lazy(n: msg)\n  lazy(n: node { title: \"t\", kids: <Note> })"), Vec::<String>::new());
        // A value parameter takes the value; the event read whole is refused
        // at run time, as the TypeScript refuses it.
        let shout = "movement shout(t: <text>) {\n  return UPPER(t)\n}\n";
        assert_eq!(reasons(shout, "  s = shout(t: msg.`subject`)\n  write crm-[:companies]-> { name: s }"), Vec::<String>::new());
        assert_eq!(reasons(shout, "  shout(t: msg)"), Vec::<String>::new());
        // What a callee returns is the call's value: a node is walked as one.
        let make = "movement make(t: <text>) {\n  return node { title: t, kids: <Note> }\n}\n";
        assert_eq!(reasons(make, "  n = make(t: \"a\")\n  write n-[:kids]-> { first: \"x\" }\n  x = COUNT(n-[:kids]->)"), Vec::<String>::new());
        // A value of two kinds, or one a recursion leaves open, refuses the call.
        let pick = "movement pick(t: <text>) {\n  if t == \"a\" {\n    return node { title: t }\n  }\n  return t\n}\n";
        assert_eq!(reasons(pick, "  r = pick(t: \"a\")"), ["movement_call"]);
        let deep = "movement deep(t: <text>) {\n  return deep(t: t)\n}\n";
        assert_eq!(reasons(deep, "  r = deep(t: \"a\")"), ["movement_call"]);
        // A position parameter handed a value takes the record the value
        // holds, of any kind (or the call fails before the callee runs): the
        // callee is walked under each.
        let heads = "movement heads(n: <Note>) {\n  n-[k:kids]-> {\n    x = k.`first`\n  }\n}\n";
        assert_eq!(reasons(heads, "  one = FIRST([msg])\n  heads(n: one)"), Vec::<String>::new());
        let keeps = "movement keeps(n: <Note>) {\n  n-[k:kids]-> {\n    x = k.`first`\n  }\n}\nmovement kept(e: <inbox-[:message]->>) {\n  files = lazy e-[a:attachments]->\n}\n";
        assert_eq!(reasons(keeps, "  one = FIRST([msg])\n  keeps(n: one)\n  kept(e: msg)"), ["block_head_value_root"], "where the program keeps a walk, a value may hold one");
        // A park inside a callee, at any depth: it resumes through its
        // call frames.
        let wait = "movement wait(e: <inbox-[:message]->>) {\n  if e.`subject` == \"a\" {\n    await sleep(1h)\n  }\n}\n";
        assert_eq!(reasons(wait, "  wait(e: msg)"), Vec::<String>::new());
        assert_eq!(reasons(wait, "  await sleep(1h)"), Vec::<String>::new(), "an uncalled movement is walked as before");
        // A cap met inside a callee, a kept walk held across a park, in a
        // body, a node literal or a call's node argument: each parks
        // (Chunk 7A Task 4), so none is refused.
        let save = "movement save(n: <Note>) {\n  write crm-[:companies]-> { unique by (`name`) name: n.`title` }\n}\n";
        assert_eq!(reasons(save, "  save(n: node { title: \"t\" })"), Vec::<String>::new());
        assert_eq!(reasons("", "  files = lazy msg-[a:attachments]->\n  await sleep(1h)"), Vec::<String>::new());
        assert_eq!(reasons("", "  n = node { title: \"t\", files: lazy msg-[a:attachments]-> }\n  await sleep(1h)"), Vec::<String>::new());
        assert_eq!(reasons(save, "  save(n: node { title: \"t\", files: lazy msg-[a:attachments]-> })\n  await sleep(1h)"), Vec::<String>::new());
        // From version 3 a call's name bound exactly to something else (the
        // file's `crm` instance) names that, not a movement in another case.
        let shadowed = "movement CRM(t: <text>) {\n  x = 1\n}\n";
        assert_eq!(reasons(shadowed, "  CRM(t: \"a\")"), Vec::<String>::new());
        assert!(reasons(shadowed, "  crm(t: \"a\")").contains(&"statement:call".to_string()), "{:?}", reasons(shadowed, "  crm(t: \"a\")"));
    }

    /// Chunk 7A Task 2: the graphs a run builds, as heads, targets and
    /// entries; what their edges hold read as the records they are.
    #[test]
    fn admits_the_graphs_a_run_builds() {
        let declared = |body: &str| {
            format!("{PRELUDE}node Company {{\n  name: <text>\n  node founder {{\n    first: <text>\n  }}\n}}\nmovement m(msg: <inbox-[:message]->>) {{\n{body}\n}}")
        };
        for body in [
            "  d = node { companies: <Company> order by arrival }\n  a = write d-[:companies]-> { unique by (FUZZY `name`) name: msg.`subject` }\n  write a-[:founder]-> { first: \"Ann\" }\n  write a { name ?: \"x\" }",
            "  d = node { companies: <Company> }\n  match d-[:companies]-> { unique by (`name`), name: \"Acme\" }\n  d-[c:companies WHERE c.`name` != \"x\"]-> {\n    write crm-[:companies]-> { name: c.`name` }\n    c-[f:founder]-> {\n      write crm-[:notes]-> { body: f.`first` }\n    }\n  }",
            "  sent = node { posted: <crm-[:companies]->> }\n  one = write crm-[:companies]-> { name: \"a\" }\n  link sent -[:posted]-> one\n  sent-[c:posted]-> {\n    write c-[:notes]-> { body: c.`name` }\n  }",
            "  n = node { name: \"a\" }\n  write n { name: \"b\" }",
            "  n = node { a: 1 }\n  link n -[:kids]-> n\n  x = match n-[:kids]-> { unique by (`a`), a: 1 }",
            "  g = graph { name: \"a\", entries: { name: \"x\" } }\n  g-[e:entries]-> {\n    write e { name: \"b\" }\n  }",
            "  doc = node { title: msg.`subject`, files: msg-[a:attachments]-> }\n  mapped = node { files: msg-[a:attachments]-> node { name: a.`name` } }",
            "  doc = node { files: lazy msg-[a:attachments]-> node { name: a.`name` } }\n  doc-[f:files]-> {\n    write crm-[:notes]-> { body: f.`name` }\n  }",
            "  files = lazy msg-[a:attachments]->\n  write crm-[:notes]-> { body: JOIN(files.`name`, \", \") }\n  if EXISTS(files) {\n    x = 1\n  }",
            "  g = graph<Company> { name: msg.`subject`, files: msg-[a:attachments]->, founder: { first: \"Ann\" } }\n  write g-[:founder]-> { first: \"Bob\" }",
        ] {
            assert_eq!(file(&declared(body)), None, "{body}");
        }
        for (body, reason) in [
            ("  files = lazy msg-[a:attachments]->\n  files-[f:x]-> {\n    y = 1\n  }", "block_head_value_root"),
            ("  files = lazy msg-[a:attachments]->\n  x = files-[:x]->.`name`", "traversal_root"),
            ("  d = node { companies: <Company> }\n  d-[c:companies]->-[f:founder]-> {\n    x = f.`first`\n  }", "block_multi_hop"),
        ] {
            assert_eq!(file(&declared(body)).as_deref(), Some(reason), "{body}");
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
            // A shaped graph (chunk 7A Task 2).
            "  g = graph<Lead> { name: \"a\" }",
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
            ("  if msg IS <Lead> {\n    x = 1\n  }", "is_test_declared_record"),
            ("  Lead = 1", "name_shadowed"),
            ("  Stage = 1", "name_shadowed"),
            ("  tag = 1", "name_shadowed"),
            ("  fetch = 1", "name_shadowed"),
        ] {
            assert_eq!(with(body).as_deref(), Some(reason), "{body}");
        }
        let movement = "movement m(msg: <inbox-[:message]->>) {\n  x = 1\n}";
        // A file-level value reads only the file-level values before it.
        for (value, reason) in [("y = KG_VALUE(\"why\")", "expression:kg_value")] {
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
            ("\n  x = deals-[c:co WHERE c.`name` == \"a\"]->.`name`", "walk_extract_hop"),
            ("\n  deals-[c:co WHERE `name` == \"x\"]-> {\n    x = 1\n  }", "block_head_extract_hop"),
            ("\n  deals-[c:co LIMIT 1]-> {\n    x = 1\n  }", "block_head_extract_hop"),
            ("\n  deals-[c:co]->-[p:people]-> {\n    x = 1\n  }", "block_multi_hop"),
            ("\n  msg-[f:_resources]-> {\n    x = 1\n  }", "block_head_resources"),
            ("\n  deals-[f:_resources WHERE type == \"FILE\"]-> {\n    x = 1\n  }", "block_head_resources"),
            ("\n  delete deals", "delete_not_record"),
        ] {
            assert_eq!(with(&format!("{tree}{after}")).as_deref(), Some(reason), "{after}");
        }
        for (body, reason) in [
            ("  d = extract from [msg.`text`] {\n    a: \"${KG_VALUE(\"why\")}\"\n  }", "expression:kg_value"),
            ("  d = extract from [SORT([msg.`text`], UPPER(\"a\"))] {\n    a: \"a\"\n  }", "aggregate:sort_key"),
            ("  d = extract from [msg.`text`] through [fetch_url(url: msg)] {\n    a: \"a\"\n  }", "name_not_value"),
            ("  d = extract from [msg.`text`] through [nowhere(url: msg.`text`)] {\n    a: \"a\"\n  }", "plugin_call"),
        ] {
            assert_eq!(with(body).as_deref(), Some(reason), "{body}");
        }
        // A tier is read off the run's input; `AI()` is the run's call.
        for body in ["  d = extract \"careful\" from [msg.`text`] {\n    a: \"a\"\n  }", "  d = extract from [msg.`text`] {\n    a: \"${AI(\"why\")}\"\n  }", "  x = AI(msg.`text`, \"thorough\")"] {
            assert_eq!(with(body), None, "{body}");
        }
        // A declared shape's words are walked in the file's scope.
        let shaped = |words: &str| file(&format!("{PRELUDE}node Lead {{\n  name: <text> \"{words}\"\n}}\nmovement m(msg: <inbox-[:message]->>) {{\n  x = 1\n}}"));
        assert_eq!(shaped("its name"), None);
        assert_eq!(shaped("its ${KG_VALUE(\"why\")} name").as_deref(), Some("expression:kg_value"));
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
            ("  return fetch_url(url: msg.`text`)", "rvalue:construct"),
        ] {
            assert_eq!(with(body).as_deref(), Some(reason), "{body}");
        }
        // A snapshot that does not say what the plugin hands back refuses
        // its call.
        let unknown = movement_parser::stmt::parse_program(&format!("import {{ fetch_url }} from plugins\n{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n  page = fetch_url(url: \"x\")\n}}"), 3, false).unwrap();
        assert_eq!(refusal(&unknown, 3, &Plugins(None)).as_deref(), Some("plugin_call"));
    }

    /// A request carries no record: where the TypeScript would hand its host
    /// the binding object (a plugin's argument, a reading handed back, a
    /// system write's field, a `from` datum written into the prompt), the
    /// program is refused by name, before anything runs.
    #[test]
    fn refuses_a_record_bound_for_a_request_by_name() {
        let specs: JsMap<PluginSpec> = serde_json::from_value(serde_json::json!({
            "echo": { "args": ["q"], "priced": false, "output": { "kind": "value", "type": "text" } },
        }))
        .unwrap();
        let with = |body: &str| {
            let source = format!("import {{ echo }} from plugins\n{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}");
            let program = movement_parser::stmt::parse_program(&source, 3, false).expect("the test's program parses");
            refusal(&program, 3, &Plugins(Some(&specs)))
        };
        for body in [
            // One record reads as its fields; a record's field is data; the
            // event's binding object is data too.
            "  x = echo(q: msg)\n  y = echo(q: [msg])\n  z = echo(q: { k: msg })",
            "  co = write crm-[:companies]-> { name: \"a\" }\n  x = echo(q: co)\n  y = echo(q: co.`name`)",
            "  rows = crm-[c:companies]->\n  top = FIRST(rows)\n  x = echo(q: top)\n  names = MAP(rows, (r) => {\n    return r.`name`\n  })\n  y = echo(q: names)",
            "  co = write crm-[:companies]-> { name: \"a\" }\n  held = { k: co }\n  write crm-[:notes]-> { body: held.k.`name` }",
            "  x = DATE.FORMAT(msg.`sent`, \"YYYY\")\n  found = extract from [msg, msg.`text`] {\n    name: \"the company\"\n  }",
        ] {
            assert_eq!(with(body), None, "{body}");
        }
        for (body, reason) in [
            ("  co = write crm-[:companies]-> { name: \"a\" }\n  x = echo(q: [co])", "plugin_arg_record"),
            ("  rows = crm-[c:companies]->\n  x = echo(q: rows)", "plugin_arg_record"),
            ("  co = write crm-[:companies]-> { name: \"a\" }\n  x = echo(q: { k: co })", "plugin_arg_record"),
            ("  rows = crm-[c:companies]->\n  x = TEXT.REGEX_EXTRACT(FIRST(rows), \"x\")", "builtin_arg_record"),
            ("  co = write crm-[:companies]-> { name: \"a\" }\n  write crm-[:notes]-> { body: co }", "write_field_record"),
            ("  rows = crm-[c:companies]->\n  write crm-[:notes]-> { body: rows }", "write_field_record"),
            ("  rows = crm-[c:companies]->\n  found = extract from [rows] {\n    name: \"the company\"\n  }", "extract_from_record"),
            ("  co = write crm-[:companies]-> { name: \"a\" }\n  found = extract from [co] {\n    name: \"the company\"\n  }", "extract_from_record"),
        ] {
            assert_eq!(with(body).as_deref(), Some(reason), "{body}");
        }
    }

    /// `AT` over a record reads the binding object's own keys, and a map
    /// spread into a graph files a record it holds as a child map
    /// (`asMapList`): where either would hand out the TypeScript engine's
    /// own currency, the program is refused by name.
    #[test]
    fn refuses_a_reading_of_a_binding_objects_internals_by_name() {
        for body in [
            "  rows = crm-[c:companies]->\n  top = FIRST(rows)\n  a = AT(top, \"kind\")\n  b = AT(rows, 0)\n  held = { k: \"v\" }\n  c = AT(held, \"k\")",
            "  held = { k: \"v\" }\n  g = graph { ...held }",
        ] {
            assert_eq!(refused(body), None, "{body}");
        }
        for (body, reason) in [
            ("  rows = crm-[c:companies]->\n  top = FIRST(rows)\n  a = AT(top, \"read\")", "at_record_key"),
            ("  rows = crm-[c:companies]->\n  top = FIRST(rows)\n  key = \"kind\"\n  a = AT(top, key)", "at_record_key"),
            ("  co = write crm-[:companies]-> { name: \"a\" }\n  held = { k: co }\n  g = graph { ...held }", "node_spread_record"),
        ] {
            assert_eq!(refused(body).as_deref(), Some(reason), "{body}");
        }
    }


}
