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
//! mid-run").

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use movement_parser::ast::{
    self, ArmExpression, CollectionOp, AwaitSource, CallArg, CallStatement, CollectionOpExpression, ExprSlot, ImportSource, NodeEntry, NodeLiteral, ParamTypeRef,
    PathHead, PathRoot, RValue, Statement, TraversalBlock, WriteExpression, WriteTarget, UntilCondition, CombinatorArms, CallbackSubject,
};
use movement_parser::catalog::types::{JsMap, PluginOutput, PluginSpec};
use movement_parser::lowering::condition::MovementCondition;
use movement_parser::lowering::expression::{AggregationFunction, Expression, ListElement, ObjectMember, StaticValue, TraversalStep};


use crate::write::{EdgeShape, TargetWhere, edge_shape};

/// The flat built-ins and namespaced members the evaluator runs
/// (crate::stdlib): an expression calling any other is refused.
const FUNCTIONS: [&str; 35] = [
    "chunks", "file", "read", "isnull", "coalesce", "trim", "lower", "upper", "length", "abs", "round", "floor", "ceil", "tostring", "tonumber", "multi", "split",
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

/// A plugin a file imports, by its local name: what a plain call binds, and
/// its spec where the snapshot has it (from version 5 its parameters bind a
/// call's arguments by position).
#[derive(Debug, Clone, PartialEq)]
struct PluginImport {
    binds: PluginBinds,
    spec: Option<Rc<PluginSpec>>,
}

/// The plugins a run's catalog snapshot describes, when it reads: what
/// admission knows of a plugin call's output.
pub struct Plugins<'a>(pub Option<&'a JsMap<PluginSpec>>);

impl Plugins<'_> {
    fn import(&self, registered: &str, language_version: u32) -> PluginImport {
        let Some(spec) = self.0.and_then(|specs| crate::plugin::spec_named(specs, registered)) else {
            return PluginImport { binds: PluginBinds::Unknown, spec: None };
        };
        let binds = match crate::plugin::output_under(spec, language_version) {
            Some(PluginOutput::Value { .. }) => PluginBinds::Value,
            Some(PluginOutput::Record { .. }) => PluginBinds::Record,
            Some(PluginOutput::Records { .. }) => PluginBinds::Records,
            None => PluginBinds::Nothing,
        };
        PluginImport { binds, spec: Some(Rc::new(spec.clone())) }
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
        Some(wanted) => spelled(movements, |m| &m.name, wanted, language_version >= 3),
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
    reachable_from(program, vec![entry])
}

/// The movements of `program` that `start` reaches, transitively, by the
/// names their bodies spell (`reachable`), in source order.
fn reachable_from<'p>(program: &'p ast::Program, start: Vec<&'p ast::MovementDeclaration>) -> Vec<&'p ast::MovementDeclaration> {
    let movements: Vec<&ast::MovementDeclaration> =
        program.statements.iter().filter_map(|s| if let Statement::Movement(m) = s { Some(m) } else { None }).collect();
    let mut reached = start;
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
                let units: Vec<u16> = crate::js_string::units_vec(text);
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
    libraries: &Libraries,
) -> Admission {
    let reasons = Reasons::default();
    let mut seeds: Vec<Seed> = Vec::new();
    let walking = Walking { language_version, catalog, libraries, reasons: &reasons };
    let start: Vec<Walk> = match entry {
        Some(entry) => vec![Walk { movement: entry, signature: vec![Kind::Event; entry.params.len()], called: false }],
        None => movements.iter().map(|m| Walk { movement: m, signature: vec![Kind::Event; m.params.len()], called: false }).collect(),
    };
    admit_file(&walking, program, movements, start, entry.is_some(), &mut seeds);
    // Each library a file imports from, its declarations and values walked
    // (the run binds them when its importer's import is bound, or when a
    // shape's words first read them); then each library movement a walked
    // body calls (or names), walked in its own file under what the call
    // passes it, transitively.
    let mut walked: Vec<Seed> = Vec::new();
    let mut next = 0;
    while let Some(seed) = seeds.get(next).cloned() {
        next += 1;
        if walked.contains(&seed) {
            continue;
        }
        walked.push(seed.clone());
        let library = libraries.0.get(&seed.path);
        if seed.name.is_empty() {
            match library {
                Some(library) => admit_file(&walking, library, &[], Vec::new(), false, &mut seeds),
                None => reasons.note("import_from_file"),
            }
            continue;
        }
        let movement = library.and_then(|library| {
            library.statements.iter().find_map(|s| match s {
                Statement::Movement(m) if m.name == seed.name => Some(m),
                _ => None,
            })
        });
        let (Some(library), Some(movement)) = (library, movement) else {
            reasons.note("import_from_file");
            continue;
        };
        let reached = reachable_from(library, vec![movement]);
        let start = vec![Walk { movement, signature: seed.signature.clone(), called: seed.called }];
        admit_file(&walking, library, &reached, start, false, &mut seeds);
    }
    Admission { reasons: reasons.0.into_inner() }
}

/// Every closure `program` writes, wherever it is written (bound, a list
/// element, an argument in place, an arm, returned, inside a nested call's
/// arguments), and every name its expressions read as a value: language
/// version 5's functions a value may hold (`Callees::value_closures`).
fn functions_as_values(program: &ast::Program, language_version: u32) -> (Vec<ast::ClosureExpression>, BTreeSet<String>) {
    type Seen = BTreeSet<(String, usize, usize)>;
    fn walk(json: &serde_json::Value, language_version: u32, closures: &mut Vec<ast::ClosureExpression>, read: &mut BTreeSet<String>, seen: &mut Seen) {
        match json {
            serde_json::Value::Object(object) => {
                let is_closure = ["params", "body", "span"].iter().all(|k| object.contains_key(*k)) && !object.contains_key("name");
                if is_closure && let Ok(closure) = serde_json::from_value::<ast::ClosureExpression>(json.clone()) {
                    closures.push(closure);
                }
                if let (Some(serde_json::Value::String(raw)), Some(span)) = (object.get("raw"), object.get("span"))
                    && let Ok(span) = serde_json::from_value::<ast::Span>(span.clone())
                    && seen.insert((raw.clone(), span.start.line, span.start.col))
                    && let Ok(tree) = movement_parser::expr::parse_expression(raw)
                {
                    read.extend(movement_parser::tree::names_read(&tree));
                    let slot = ExprSlot::plain(raw.clone(), span);
                    let calls = crate::nested::staged_calls(&tree, &|call| matches!(call, movement_parser::tree::MExpr::Call { callee, .. } if callee_written(callee).is_some()));
                    for at in calls {
                        if let Ok(value) = crate::nested::nested_call(&slot, at, language_version)
                            && let Ok(value) = serde_json::to_value(&value)
                        {
                            walk(&value, language_version, closures, read, seen);
                        }
                    }
                }
                object.values().for_each(|value| walk(value, language_version, closures, read, seen));
            }
            serde_json::Value::Array(items) => items.iter().for_each(|item| walk(item, language_version, closures, read, seen)),
            _ => {}
        }
    }
    let (mut closures, mut read) = (Vec::new(), BTreeSet::new());
    if let Ok(json) = serde_json::to_value(&program.statements) {
        walk(&json, language_version, &mut closures, &mut read, &mut Seen::new());
    }
    (closures, read)
}

/// What every file's walk shares.
struct Walking<'a> {
    language_version: u32,
    catalog: &'a Plugins<'a>,
    libraries: &'a Libraries,
    reasons: &'a Reasons,
}

/// A library movement to walk: by its library and its declared name, under
/// the kinds a call binds its parameters to (`called`), or with them as the
/// event (a movement named, not called); with no name, the library's own
/// declarations and values alone.
#[derive(Debug, Clone, PartialEq)]
struct Seed {
    path: String,
    name: String,
    signature: Signature,
    called: bool,
}

/// The library files a run's catalog snapshot carries, by the path an
/// import names, parsed under the importing program's pin: what admission
/// walks an imported movement and its file in (the check links the same
/// sources, `resolveFileFromSnapshot`).
#[derive(Debug, Default)]
pub struct Libraries(pub BTreeMap<String, ast::Program>);

/// One file's walk: its declarations and values, then `start` and every
/// movement it reaches (`movements`, the reachable ones). The root's walk
/// stops before any body where a file statement or the entry fails every
/// run (`stops_at_entry`); a library's file statements fail at the moment
/// its importer binds it, which the run mirrors.
fn admit_file<'p>(
    walking: &Walking<'p>,
    program: &'p ast::Program,
    movements: &[&'p ast::MovementDeclaration],
    start: Vec<Walk<'p>>,
    has_entry: bool,
    seeds: &mut Vec<Seed>,
) {
    let Walking { language_version, catalog, libraries, reasons } = *walking;
    let entry = if has_entry { start.first().map(|w| w.movement) } else { None };
    let mut file_names = BTreeSet::new();
    let mut instances = BTreeSet::new();
    let plugin_binds = plugin_binds_of(program, catalog, language_version);
    let plugins: BTreeSet<String> = plugin_binds.keys().cloned().collect();
    let imported = imported_movements(program, walking);
    let callees = Callees::of(program, &plugin_binds, language_version, imported);
    let movement_names: BTreeSet<String> = program
        .statements
        .iter()
        .filter_map(|s| if let Statement::Movement(m) = s { Some(m.name.clone()) } else { None })
        .chain(callees.imported.iter().map(|i| i.local.clone()))
        .collect();
    let plugin_named = |callee: &str| names_plugin(&plugins, callee, language_version);
    // `resolveCallee`: as written, or from version 3 in any letter case.
    let movement_named = |callee: &str| spelled(&movement_names, String::as_str, callee, folds_case(language_version)).is_some();
    // File-level values, in source order: each may read the ones before it.
    // One already refused binds its name and is not walked again.
    let mut file_values: Vec<(&str, Option<&RValue>)> = Vec::new();
    // A file statement that fails every run before any body (run.ts
    // `interpretFileStatement`): what follows it never runs.
    let mut fails_at_file = false;
    for statement in &program.statements {
        if fails_at_file {
            break;
        }
        match statement {
            Statement::Import(import) => {
                match &import.source {
                    ImportSource::Builtin { namespace } if namespace == "adapters" || namespace == "credentials" || namespace == "plugins" => {}
                    ImportSource::Builtin { namespace } => reasons.note(format!("import_from_{namespace}")),
                    // A name the snapshot's file declares (the checker holds it
                    // to an exported one); any other the link leaves unresolved,
                    // and the run ends at the check on either engine.
                    ImportSource::File { path } => {
                        let declares = |name: &str| {
                            libraries.0.get(path).is_some_and(|library| {
                                library.statements.iter().any(|s| matches!(s, Statement::Movement(m) if m.name == name) || matches!(s, Statement::Shape(d) if d.name == name))
                            })
                        };
                        if !import.names.iter().all(|n| declares(&n.name)) {
                            reasons.note("import_from_file");
                        }
                        let seed = Seed { path: path.clone(), name: String::new(), signature: Vec::new(), called: false };
                        if !seeds.contains(&seed) {
                            seeds.push(seed);
                        }
                    }
                }
                for name in &import.names {
                    file_names.insert(name.alias.clone().unwrap_or_else(|| name.name.clone()));
                }
            }
            Statement::Assign(assign) => {
                file_names.insert(assign.name.clone());
                match &assign.value {
                    // `fileLevelCall`, and the right-hand sides that have no
                    // event to run about: the run fails as the TypeScript's
                    // does, before any body.
                    RValue::Construct { construct } if movement_named(&construct.callee) || plugin_named(&construct.callee) => fails_at_file = true,
                    RValue::Construct { .. } => {
                        instances.insert(assign.name.clone());
                    }
                    // A call whose callee the file declares is a call, not the
                    // built-in's value it would otherwise read as (run.ts
                    // `resolvedRValue`), and a file has no event to make it about
                    // (`fileLevelCall`).
                    RValue::Call { call } if plugin_named(&call.callee) || movement_named(&call.callee) => fails_at_file = true,
                    RValue::Extract { .. } | RValue::ExtractCall { .. } | RValue::Block { .. } | RValue::Write { .. } | RValue::Match { .. } | RValue::Link { .. } => {
                        fails_at_file = true;
                    }
                    RValue::Expr { .. } | RValue::Call { .. } => file_values.push((&assign.name, Some(&assign.value))),
                    // Any other right-hand side binds nothing: a read of the
                    // name fails at run time on either engine, naming it.
                    _ => file_values.push((&assign.name, None)),
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
            // Any other file statement runs nothing (`interpretFileStatement`).
            _ => {}
        }
    }
    let none = BTreeSet::new();
    let no_closures = BTreeMap::new();
    let no_either = BTreeMap::new();
    // The file's node declarations: its own, and those it imports from a
    // library.
    let shapes: BTreeSet<String> = program
        .statements
        .iter()
        .flat_map(|s| match s {
            Statement::Shape(shape) => vec![shape.name.clone()],
            Statement::Import(ast::ImportStatement { source: ImportSource::File { path }, names, .. }) => names
                .iter()
                .filter(|n| libraries.0.get(path).is_some_and(|l| l.statements.iter().any(|s| matches!(s, Statement::Shape(d) if d.name == n.name))))
                .map(|n| n.alias.clone().unwrap_or_else(|| n.name.clone()))
                .collect(),
            _ => Vec::new(),
        })
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
                shape_aliases: &none,
                callees: &callees,
                unknown_calls: &[],
                language_version,
                value_holders: &callees.file_holders,
                either_values: &no_either,
                record_nodes: &none,
                closure_holders: &no_closures,
                call_holders: &[],
                nested_holders: &[],
            };
            reasons.noted(names.rvalue(value));
        }
        values.insert(name.to_string());
    }
    let file_values = values;
    // The dispatched movement is picked and its one parameter read before
    // any body (`prepareMovement`): one taking other than one parameter, an
    // untyped one or a value fails the run there, on either engine.
    let fails_at_entry = entry.is_some_and(|e| e.params.len() != 1 || matches!(e.params[0].type_, None | Some(ParamTypeRef::Value(_))));
    if fails_at_file || fails_at_entry {
        return;
    }
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
        shape_aliases: &none,
        callees: &callees,
        unknown_calls: &[],
        language_version,
        value_holders: &callees.file_holders,
        either_values: &no_either,
        record_nodes: &none,
        closure_holders: &no_closures,
        call_holders: &[],
        nested_holders: &[],
    };
    for statement in &program.statements {
        if let Statement::Shape(shape) = statement {
            reasons.noted(file_scope.shape_words(&shape.root));
        }
    }
    let walked = walks(&callees, movements, start, seeds);
    // A library movement a walked body names without calling it (an arm, a
    // callback, a function handed by name) takes its parameters as the
    // event, as a movement of the file's own that no call reaches does.
    for movement in &walked {
        let Some(spelled) = names_spelled(movement.movement) else { continue };
        for import in &callees.imported {
            let seed = Seed { path: import.path.clone(), name: import.declaration.name.clone(), signature: vec![Kind::Event; import.declaration.params.len()], called: false };
            if spelled.contains(&crate::js::to_lower_case(&import.local)) && !seeds.iter().any(|s| s.path == seed.path && s.name == seed.name) {
                seeds.push(seed);
            }
        }
    }
    for walk in walked {
        let movement = walk.movement;
        // A movement no call reaches takes its parameters as the event. One
        // taking a value fails the run before its body when fired itself
        // (above); as a combinator's arm the checker refuses it
        // (MOV_COMBINATOR_ARM_TAKES_NOTHING), and handed where a closure goes
        // it is walked as the closure's function: only a name its text
        // merely mentions reaches it otherwise, and that never runs.
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
        let closure_holders: BTreeMap<String, Holder> = callees.closure_bodies.keys().map(|name| (name.clone(), bound.closure_call_holder(name))).collect();
        // A shape declared in the body is hoisted for it, as the file's are
        // for the file.
        let body_shapes: BTreeSet<String> = shapes.iter().cloned().chain(crate::code::shapes_declared_in(&movement.body)).collect();
        let shape_aliases = if language_version >= 3 { shape_aliases_in(&movement.body, &body_shapes) } else { BTreeSet::new() };
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
            shapes: &body_shapes,
            shape_aliases: &shape_aliases,
            callees: &callees,
            unknown_calls: &bound.unknown_calls,
            language_version,
            value_holders: &value_holders,
            either_values: &bound.either_values,
            record_nodes: &bound.record_nodes,
            closure_holders: &closure_holders,
            call_holders: &bound.call_holders,
            nested_holders: &bound.nested_holders,
        };
        names.body(&movement.body, Within::Body);
    }
}

/// The names a body binds, once and only once anywhere in it, to the bare
/// name of a shape (or of another such name): from version 3 each is the
/// shape itself (`aliasedNodeBinding`). A name bound more than once is no
/// alias here (`name_rebound` refuses it anyway).
fn shape_aliases_in(body: &[Statement], shapes: &BTreeSet<String>) -> BTreeSet<String> {
    let mut assigned: BTreeMap<String, Vec<String>> = BTreeMap::new();
    fn collect(body: &[Statement], assigned: &mut BTreeMap<String, Vec<String>>) {
        for statement in body {
            match statement {
                Statement::Assign(assign) => {
                    let raw = match &assign.value {
                        RValue::Expr { expr } => crate::js::trim(&expr.raw).to_string(),
                        _ => String::new(),
                    };
                    assigned.entry(assign.name.clone()).or_default().push(raw);
                }
                Statement::If(statement) => {
                    statement.arms.iter().for_each(|arm| collect(&arm.body, assigned));
                    if let Some(arm) = &statement.else_arm {
                        collect(&arm.body, assigned);
                    }
                }
                Statement::Block(statement) => collect(&statement.block.body, assigned),
                _ => {}
            }
        }
    }
    collect(body, &mut assigned);
    let mut aliases = BTreeSet::new();
    loop {
        let found: Vec<String> = assigned
            .iter()
            .filter(|(name, values)| !aliases.contains(*name) && values.len() == 1 && (shapes.contains(&values[0]) || aliases.contains(&values[0])))
            .map(|(name, _)| name.clone())
            .collect();
        if found.is_empty() {
            return aliases;
        }
        aliases.extend(found);
    }
}

/// What admission found: why this engine does not run the program (empty
/// when it does).
pub struct Admission {
    pub reasons: Vec<String>,
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
fn walks<'p>(callees: &'p Callees<'p>, movements: &[&'p ast::MovementDeclaration], start: Vec<Walk<'p>>, seeds: &mut Vec<Seed>) -> Vec<Walk<'p>> {
    let as_event = |m: &ast::MovementDeclaration| vec![Kind::Event; m.params.len()];
    let mut walks: Vec<Walk<'p>> = start;
    let mut next = 0;
    while next < walks.len() {
        let bound = callees.bound(walks[next].movement, &walks[next].signature, Vec::new());
        for (movement, signature) in bound.calls {
            // A library's movement is walked in its own file.
            if let Some(import) = callees.imported_as(movement) {
                let seed = Seed { path: import.path.clone(), name: movement.name.clone(), signature, called: true };
                if !seeds.contains(&seed) {
                    seeds.push(seed);
                }
                continue;
            }
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
        {
            for arm in c.arms.written() {
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

/// The call a statement makes itself: a call statement, or a call bound or
/// returned.
fn statement_call(statement: &Statement) -> Option<&CallStatement> {
    match statement {
        Statement::Call(call) => Some(call),
        Statement::Assign(ast::AssignStatement { value: RValue::Call { call }, .. }) | Statement::Return(ast::ReturnStatement { value: RValue::Call { call }, .. }) => Some(call),
        _ => None,
    }
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
            RValue::Call { .. } => Holder::Other,
            // Binds nothing at file scope (`interpretFileStatement`): a read
            // of it fails, naming it, before it is handed anywhere.
            _ => Holder::Free,
        };
        holders.insert(assign.name.clone(), holder);
    }
    holders
}

/// A movement a file imports from a library, by the name the file binds.
struct Imported<'p> {
    local: String,
    path: String,
    declaration: &'p ast::MovementDeclaration,
    /// The `type`s its library declares: what its parameters' refinements name.
    types: BTreeSet<String>,
    /// Its library, and what the library's own plugin imports and file
    /// imports bind: what its body's names are read against.
    library: &'p ast::Program,
    plugin_binds: BTreeMap<String, PluginImport>,
    nested: Vec<Imported<'p>>,
    /// The library read as a file of its own, built once per import (its
    /// fixpoint is not cheap) and shared by every lookup.
    callees: Rc<Callees<'p>>,
}

impl Clone for Imported<'_> {
    fn clone(&self) -> Self {
        Imported {
            local: self.local.clone(),
            path: self.path.clone(),
            declaration: self.declaration,
            types: self.types.clone(),
            library: self.library,
            plugin_binds: self.plugin_binds.clone(),
            nested: self.nested.clone(),
            callees: self.callees.clone(),
        }
    }
}

/// What a plain call of each plugin a file imports binds, by its local name.
fn plugin_binds_of(program: &ast::Program, catalog: &Plugins<'_>, language_version: u32) -> BTreeMap<String, PluginImport> {
    let mut plugin_binds = BTreeMap::new();
    for statement in &program.statements {
        if let Statement::Import(import) = statement
            && matches!(&import.source, ImportSource::Builtin { namespace } if namespace == "plugins")
        {
            for name in &import.names {
                let local = name.alias.clone().unwrap_or_else(|| name.name.clone());
                let members = catalog.0.map(|specs| movement_parser::catalog::packages::package_members(specs, &name.name)).unwrap_or_default();
                if movement_parser::version::since(language_version, 5) && !members.is_empty() {
                    for member in members {
                        plugin_binds.insert(movement_parser::catalog::packages::member_local(&local, &member.name), catalog.import(&member.key, language_version));
                    }
                    continue;
                }
                plugin_binds.insert(local, catalog.import(&name.name, language_version));
            }
        }
    }
    plugin_binds
}

/// Each movement `program` imports from a library the snapshot carries.
fn imported_movements<'p>(program: &ast::Program, walking: &Walking<'p>) -> Vec<Imported<'p>> {
    imported_through(program, walking, &[])
}

/// `imported_movements`, below the libraries `above` (an import cycle,
/// which the link refuses, is not followed round).
fn imported_through<'p>(program: &ast::Program, walking: &Walking<'p>, above: &[&str]) -> Vec<Imported<'p>> {
    let libraries = walking.libraries;
    let mut imported = Vec::new();
    for statement in &program.statements {
        let Statement::Import(ast::ImportStatement { source: ImportSource::File { path }, names, .. }) = statement else { continue };
        if above.contains(&path.as_str()) {
            continue;
        }
        let Some(library) = libraries.0.get(path) else { continue };
        let types: BTreeSet<String> = library.statements.iter().filter_map(|s| if let Statement::Type(t) = s { Some(t.name.clone()) } else { None }).collect();
        for name in names {
            let declaration = library.statements.iter().find_map(|s| match s {
                Statement::Movement(m) if m.name == name.name => Some(m),
                _ => None,
            });
            if let Some(declaration) = declaration {
                let plugin_binds = plugin_binds_of(library, walking.catalog, walking.language_version);
                let nested = imported_through(library, walking, &[above, &[path.as_str()]].concat());
                let callees = Rc::new(Callees::of(library, &plugin_binds, walking.language_version, nested.clone()));
                imported.push(Imported {
                    local: name.alias.clone().unwrap_or_else(|| name.name.clone()),
                    path: path.clone(),
                    declaration,
                    types: types.clone(),
                    library,
                    plugin_binds,
                    nested,
                    callees,
                });
            }
        }
    }
    imported
}

struct Callees<'p> {
    movements: Vec<&'p ast::MovementDeclaration>,
    /// The movements the file imports from libraries: callees too, walked
    /// in their own files.
    imported: Vec<Imported<'p>>,
    plugin_binds: BTreeMap<String, PluginImport>,
    /// The `type`s the file declares: a parameter typed by one takes a value.
    types: BTreeSet<String>,
    /// The names the file's scope binds (its imports, shapes, values,
    /// instances and movements): from version 3 one bound exactly is the
    /// callee a call names, even in another letter case than a movement's.
    file_scope: BTreeSet<String>,
    language_version: u32,
    returns: RefCell<Vec<Returned>>,
    /// The record kinds a value may hold at run time: a kept walk only where
    /// the program keeps one.
    held_kinds: Vec<Kind>,
    /// What each file-level binding holds, as far as a record goes.
    file_holders: BTreeMap<String, Holder>,
    /// The closures bound to a name anywhere, by name: the parameters a
    /// call of one binds; `None` where closures of that name differ in
    /// what their parameters take.
    closures: BTreeMap<String, Option<Vec<ast::MovementParam>>>,
    /// Every closure bound to each name, for what a call of one hands back.
    closure_bodies: BTreeMap<String, Vec<&'p ast::ClosureExpression>>,
    /// The file's own statements: a closure written at file scope is read
    /// in a walk of them (`outside_closure_holder`).
    file_statements: &'p [Statement],
    /// The closures `outside_closure_holder` is reading now (a cycle).
    outside_walking: RefCell<Vec<ast::Span>>,
    /// What a call of each closure a library's function hands back hands
    /// back, read in the library's own file (`closures_returned`).
    foreign_holders: RefCell<Vec<(*const ast::ClosureExpression, Holder)>>,
    /// Language version 5: the functions a value may hold, which a call
    /// through a value runs (a parameter, a member): every closure
    /// the file writes, wherever it is written, and every function whose
    /// name the file reads as a value (`g = one`, `[twice]`).
    value_closures: Vec<ast::ClosureExpression>,
    value_movements: Vec<&'p ast::MovementDeclaration>,
    /// The names any function of the file takes as a parameter: a call of
    /// one is a call through a value wherever it is written, never of a
    /// closure bound to the name elsewhere.
    params_named: BTreeSet<String>,
    /// What a call through a value hands back (`value_call_holder`).
    value_calls: std::cell::Cell<ValueCalls>,
}

/// What a call through a value hands back, worked out once per file: the
/// join of what every function a value may hold hands back, to a fixed
/// point (a function's returns may themselves be calls through values).
#[derive(Debug, Clone, Copy)]
enum ValueCalls {
    Unknown,
    /// Being worked out: the join so far.
    Settling(Holder),
    Settled(Holder),
}

impl<'p> Callees<'p> {
    fn of(program: &'p ast::Program, plugin_binds: &BTreeMap<String, PluginImport>, language_version: u32, imported: Vec<Imported<'p>>) -> Callees<'p> {
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
        let mut callees = Callees {
            movements,
            imported,
            plugin_binds: plugin_binds.clone(),
            types,
            file_scope,
            language_version,
            returns: RefCell::default(),
            held_kinds,
            file_holders,
            closures: BTreeMap::new(),
            closure_bodies: BTreeMap::new(),
            file_statements: &program.statements,
            outside_walking: RefCell::default(),
            foreign_holders: RefCell::default(),
            value_closures: Vec::new(),
            value_movements: Vec::new(),
            params_named: BTreeSet::new(),
            value_calls: std::cell::Cell::new(ValueCalls::Unknown),
        };
        if language_version >= 5 {
            let (closures, read) = functions_as_values(program, language_version);
            callees.value_movements = callees.movements.iter().copied().filter(|m| read.contains(&m.name)).collect();
            callees.params_named = closures.iter().flat_map(|c| c.params.iter()).chain(callees.movements.iter().flat_map(|m| m.params.iter())).map(|p| p.name.clone()).collect();
            callees.value_closures = closures;
        }
        for (name, closure) in crate::code::bound_closures(program) {
            callees.closure_bodies.entry(name.to_string()).or_default().push(closure);
            let takes = |params: &[ast::MovementParam]| params.iter().map(|p| (p.name.clone(), callees.takes_value(p))).collect::<Vec<_>>();
            let same = match callees.closures.get(name) {
                None => true,
                Some(None) => false,
                Some(Some(seen)) => takes(seen) == takes(&closure.params),
            };
            let entry = same.then(|| closure.params.clone());
            callees.closures.insert(name.to_string(), entry);
        }
        // A name bound to a call's value (`h = mk(2)`) is a closure where
        // every `return` of the callee hands one back: `mk` a closure or a
        // movement of this file, each return a closure literal or a name
        // bound to closures. A call of it runs the closure the call made, in
        // its scope (`executeClosureCall`), so its parameters are those
        // closures' and its value what their returns hand back. Followed
        // until no new name is learnt (`h2 = h(1)` where `h`'s returns are
        // closures too).
        let call_bound = crate::code::call_bound(program);
        loop {
            let mut learnt = false;
            for (name, callee) in &call_bound {
                let Some(returned) = callees.closures_returned(callee) else { continue };
                let bodies = callees.closure_bodies.entry(name.to_string()).or_default();
                let fresh: Vec<_> = returned.into_iter().filter(|c| !bodies.iter().any(|b| std::ptr::eq(*b, *c))).collect();
                if fresh.is_empty() {
                    continue;
                }
                learnt = true;
                bodies.extend(fresh.iter().copied());
                for closure in fresh {
                    let takes = |params: &[ast::MovementParam]| params.iter().map(|p| (p.name.clone(), callees.takes_value(p))).collect::<Vec<_>>();
                    let same = match callees.closures.get(*name) {
                        None => true,
                        Some(None) => false,
                        Some(Some(seen)) => takes(seen) == takes(&closure.params),
                    };
                    let entry = same.then(|| closure.params.clone());
                    callees.closures.insert(name.to_string(), entry);
                }
            }
            if !learnt {
                break;
            }
        }
        callees
    }

    /// What a call through a value hands back (language version 5): the
    /// join of what every function a value may hold hands back
    /// (`value_closures`, `value_movements`, and a library's, through an
    /// import), read to a fixed point. The TypeScript checker types the
    /// call by the closure type it reads; admission runs before the check,
    /// and asks a narrower question (how a record may be held), so it reads
    /// the functions themselves.
    fn value_call_holder(&'p self) -> Holder {
        match self.value_calls.get() {
            ValueCalls::Settled(held) | ValueCalls::Settling(held) => held,
            ValueCalls::Unknown => {
                let mut held = Holder::Free;
                let settled = loop {
                    self.value_calls.set(ValueCalls::Settling(held));
                    self.returns.borrow_mut().clear();
                    let next = self.value_functions_holder();
                    let joined = returned_join(held, next);
                    if joined == held {
                        break held;
                    }
                    held = joined;
                };
                self.returns.borrow_mut().clear();
                self.value_calls.set(ValueCalls::Settled(settled));
                settled
            }
        }
    }

    /// One round of `value_call_holder`: what each function a value may
    /// hold hands back, joined.
    fn value_functions_holder(&'p self) -> Holder {
        let mut held = Holder::Free;
        for import in &self.imported {
            held = returned_join(held, import.callees.value_call_holder());
        }
        for movement in &self.value_movements {
            for signature in self.signatures_called_through_a_value(&movement.params) {
                held = returned_join(held, self.returns(movement, &signature, &[]).1);
            }
        }
        let at = |loc: ast::Loc| (loc.line, loc.col);
        let within = |outer: &ast::Span, inner: &ast::Span| at(outer.start) <= at(inner.start) && at(inner.end) <= at(outer.end);
        let at_file: Vec<&ast::ClosureExpression> = self.value_closures.iter().filter(|c| !self.movements.iter().any(|m| within(&m.span, &c.span))).collect();
        if !at_file.is_empty() {
            let mut bound = Bound { plugin_binds: self.plugin_binds.clone(), callees: Some(self), ..Bound::default() };
            for statement in self.file_statements.iter().filter(|s| matches!(s, Statement::Assign(_))) {
                bound.collect(std::slice::from_ref(statement), &[]);
            }
            for closure in at_file {
                held = returned_join(held, bound.returned_values_holder(&closure.body));
            }
        }
        for movement in &self.movements {
            let written: Vec<&ast::ClosureExpression> = self.value_closures.iter().filter(|c| within(&movement.span, &c.span)).collect();
            if written.is_empty() {
                continue;
            }
            for signature in self.signatures_called_through_a_value(&movement.params) {
                let bound = self.bound(movement, &signature, Vec::new());
                for closure in &written {
                    held = returned_join(held, bound.returned_values_holder(&closure.body));
                }
            }
        }
        held
    }

    /// Every signature a movement may be entered under where nothing says
    /// what its call passes: a value parameter a value, any other each
    /// record kind a position takes (`concrete`); the event's for one no
    /// such bound reaches.
    fn signatures_called_through_a_value(&self, params: &[ast::MovementParam]) -> Vec<Signature> {
        let signature: Signature = params.iter().map(|p| if self.takes_value(p) { Kind::Value } else { Kind::Held }).collect();
        concrete(&signature, &self.held_kinds).unwrap_or_else(|| vec![vec![Kind::Event; params.len()]])
    }

    /// What a call of `closure` hands back where the walk calling it did
    /// not walk its body: a closure written at file scope, or in another
    /// movement's body (one that movement's call handed back, `h = mk(2)`).
    /// Its returns are read in the walk that holds its names: the file's
    /// statements, or that movement's body under value arguments (one taking
    /// a record, or a cycle, may hand back anything).
    fn outside_closure_holder(&'p self, closure: &'p ast::ClosureExpression) -> Holder {
        if let Some((_, held)) = self.foreign_holders.borrow().iter().find(|(c, _)| std::ptr::eq(*c, closure)) {
            return *held;
        }
        if self.outside_walking.borrow().contains(&closure.span) || !self.reaches(closure) {
            // A cycle, or a closure of no file read here (spans carry no
            // file, so it would be read against names that are not its
            // own): nothing is known of what it holds.
            return Holder::Other;
        }
        let at = |loc: ast::Loc| (loc.line, loc.col);
        let within = |span: &ast::Span| at(span.start) <= at(closure.span.start) && at(closure.span.end) <= at(span.end);
        self.outside_walking.borrow_mut().push(closure.span);
        let held = match self.movements.iter().find(|m| within(&m.span)) {
            Some(movement) if movement.params.iter().all(|p| self.takes_value(p)) => {
                self.bound(movement, &vec![Kind::Value; movement.params.len()], Vec::new()).returned_values_holder(&closure.body)
            }
            Some(_) => Holder::Other,
            None => {
                let mut bound = Bound { plugin_binds: self.plugin_binds.clone(), callees: Some(self), ..Bound::default() };
                for statement in self.file_statements.iter().filter(|s| matches!(s, Statement::Assign(_))) {
                    bound.collect(std::slice::from_ref(statement), &[]);
                }
                bound.returned_values_holder(&closure.body)
            }
        };
        self.outside_walking.borrow_mut().pop();
        held
    }

    /// Whether `closure` is one of this file's: bound to a name, or one a
    /// movement's or closure's returns hand back, at any depth.
    fn reaches(&self, closure: &ast::ClosureExpression) -> bool {
        let mut seen: Vec<&'p ast::ClosureExpression> = self.closure_bodies.values().flatten().copied().collect();
        let mut at = 0;
        let mut found = seen.iter().any(|c| std::ptr::eq(*c, closure));
        let mut pending: Vec<&'p [Statement]> = self.movements.iter().map(|m| m.body.as_slice()).collect();
        loop {
            while let Some(body) = pending.pop() {
                let mut returned = Vec::new();
                self.returned_closures(body, &mut returned);
                for c in returned {
                    if !seen.iter().any(|s| std::ptr::eq(*s, c)) {
                        found |= std::ptr::eq(c, closure);
                        seen.push(c);
                    }
                }
            }
            if found || at >= seen.len() {
                return found;
            }
            pending.push(&seen[at].body);
            at += 1;
        }
    }

    /// The closures a call of `callee` hands back, where every `return` of
    /// it hands back a closure: a closure literal, or a name bound to
    /// closures. `None` where any return is something else, or the callee
    /// is no closure and no movement of this file (an import's closure is
    /// its library's, walked there).
    fn closures_returned(&self, callee: &str) -> Option<Vec<&'p ast::ClosureExpression>> {
        if self.language_version < 3 {
            return None;
        }
        let bodies: Vec<&'p [Statement]> = match self.callee(callee, false) {
            // A library's function: its returns read in its own file, and
            // what a call of each closure hands back with them.
            Some(movement) if let Some(import) = self.imported_as(movement) => {
                let library = import.callees.clone();
                let returned = library.closures_returned(&movement.name)?;
                // Every closure a call of these can hand back, however deep
                // (`(b) => (c) => b`), is the library's too: its holder is
                // read in the library's file, never in this one.
                let mut reached = returned.clone();
                let mut at = 0;
                while at < reached.len() {
                    let mut deeper = Vec::new();
                    library.returned_closures(&reached[at].body, &mut deeper);
                    for closure in deeper {
                        if !reached.iter().any(|c| std::ptr::eq(*c, closure)) {
                            reached.push(closure);
                        }
                    }
                    at += 1;
                }
                for closure in &reached {
                    if !self.foreign_holders.borrow().iter().any(|(c, _)| std::ptr::eq(*c, *closure)) {
                        let held = library.outside_closure_holder(closure);
                        self.foreign_holders.borrow_mut().push((*closure, held));
                    }
                }
                return Some(returned);
            }
            Some(movement) => vec![&movement.body],
            None => self.closure_bodies.get(self.closure_name(callee, false)?)?.iter().map(|c| c.body.as_slice()).collect(),
        };
        let mut returned = Vec::new();
        for body in bodies {
            if !self.returned_closures(body, &mut returned) {
                return None;
            }
        }
        (!returned.is_empty()).then_some(returned)
    }

    /// The closures a body's own `return`s hand back (`returns_of`: an
    /// `if` arm's included; a block's iteration's and a nested closure's
    /// are theirs): false where one hands back anything else.
    fn returned_closures(&self, body: &'p [Statement], into: &mut Vec<&'p ast::ClosureExpression>) -> bool {
        let mut returns = Vec::new();
        returns_of(body, &mut returns);
        returns.into_iter().all(|value| match value {
            RValue::Closure { closure } => {
                into.push(closure);
                true
            }
            RValue::Expr { expr } => match lowered(&expr.raw) {
                Ok(Expression::AliasRef { name } | Expression::Property { property_type_id: name, field_only: false }) => {
                    self.closure_bodies.get(&name).is_some_and(|closures| {
                        into.extend(closures.iter().copied());
                        true
                    })
                }
                _ => false,
            },
            _ => false,
        })
    }

    /// The parameters of the closure a call names from version 3 (a
    /// closure bound to that name, `closure_name`, no movement of it):
    /// `Some(None)` where the program's closures of that name differ.
    fn closure(&self, written: &str, bound_exactly: bool) -> Option<Option<&Vec<ast::MovementParam>>> {
        let name = self.closure_name(written, bound_exactly)?;
        self.closures.get(name).map(Option::as_ref)
    }

    /// The name of the closure a call names from version 3 (`resolveCallee`):
    /// one bound to the name as written, or, where the calling scope binds
    /// nothing under it exactly (`bound_exactly`), the one closure name the
    /// program binds in another letter case. `resolveFunction` takes the
    /// first such name in the call's own scope chain, innermost first; these
    /// names are the whole program's, so a second spelling (one in a sibling
    /// scope, `Get` in an `if` arm beside `get`) leaves the call unread here
    /// and the run refused, and a sole spelling out of the call's chain is a
    /// call the checker refuses (MOV_NAME_UNRESOLVED).
    fn closure_name(&self, written: &str, bound_exactly: bool) -> Option<&str> {
        if self.language_version < 3 || self.movement(written).is_some() || self.params_named.contains(written) {
            return None;
        }
        if let Some(name) = spelled(self.closures.keys(), String::as_str, written, false) {
            return Some(name);
        }
        if bound_exactly || !folds_case(self.language_version) {
            return None;
        }
        let folded = crate::js::to_lower_case(written);
        let mut spellings = self.closures.keys().filter(|name| crate::js::to_lower_case(name) == folded);
        let name = spellings.next()?;
        spellings.next().is_none().then_some(name.as_str())
    }

    /// The movement declared or imported as `name`, exactly.
    fn movement(&self, name: &str) -> Option<&'p ast::MovementDeclaration> {
        self.movements.iter().copied().find(|m| m.name == name).or_else(|| self.imported.iter().find(|i| i.local == name).map(|i| i.declaration))
    }

    /// The import `movement` is, when it is a library's.
    fn imported_as(&self, movement: &ast::MovementDeclaration) -> Option<&Imported<'p>> {
        self.imported.iter().find(|i| std::ptr::eq(i.declaration, movement))
    }

    /// `resolveCallee` (run.ts `calleeName`): the movement a call names —
    /// exactly, or from version 3 in any letter case unless the name is
    /// bound exactly to something else (`bound_in_body`: the calling body
    /// binds it).
    fn callee(&self, written: &str, bound_in_body: bool) -> Option<&'p ast::MovementDeclaration> {
        let bound = bound_in_body || self.file_scope.contains(written);
        let named: Vec<(&str, &'p ast::MovementDeclaration)> =
            self.movements.iter().map(|m| (m.name.as_str(), *m)).chain(self.imported.iter().map(|i| (i.local.as_str(), i.declaration))).collect();
        spelled(&named, |(name, _)| name, written, folds_case(self.language_version) && !bound).map(|(_, m)| *m)
    }

    /// `isValueParam`. The checker holds every argument to a value
    /// parameter's type, which is never a record, so admission reads the
    /// parameter as free of records — but before version 5 the checker does
    /// not see a record through `COALESCE` or `MULTI` (from 5,
    /// MOV_CALL_ARG_MAYBE_RECORD), so every argument bound to one is held to
    /// it as well (`call_arg_record`).
    fn takes_value(&self, param: &ast::MovementParam) -> bool {
        // An imported movement's parameter names its own library's `type`s.
        let types = self.imported.iter().find(|i| i.declaration.params.as_ptr_range().contains(&std::ptr::from_ref(param))).map_or(&self.types, |i| &i.types);
        self.is_value_type_in(param.type_.as_ref(), types)
    }

    /// Whether a declared type is a value's (no record, no walk).
    fn is_value_type(&self, type_: Option<&ParamTypeRef>) -> bool {
        self.is_value_type_in(type_, &self.types)
    }

    fn is_value_type_in(&self, type_: Option<&ParamTypeRef>, types: &BTreeSet<String>) -> bool {
        match type_ {
            None => false,
            Some(ParamTypeRef::Value(_)) => true,
            Some(ParamTypeRef::Name(type_)) if type_.hops_raw.is_some() => false,
            Some(ParamTypeRef::Name(type_)) => {
                movement_parser::catalog::helpers::parse_field_type_name(Some(&type_.graph)).is_some() || types.contains(&type_.graph)
            }
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
                        if *kind == Kind::Value && self.takes_value(param) {
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
    fn returns(&'p self, movement: &ast::MovementDeclaration, signature: &[Kind], stack: &[(String, Signature)]) -> (Option<Kind>, Holder) {
        // A library's movement hands back what its body does, read in its
        // own file.
        if let Some(import) = self.imported_as(movement) {
            let library = import.callees.clone();
            return library.returns(movement, signature, &[]);
        }
        let key = (movement.name.clone(), signature.to_vec());
        if stack.contains(&key) {
            // A recursion: what it hands back is what it declares, when it
            // declares a value (the checker holds every return to it).
            if self.is_value_type(movement.return_type.as_ref()) {
                return (Some(Kind::Value), Holder::Free);
            }
            return (None, Holder::Other);
        }
        if let Some((_, known, held)) = self.returns.borrow().iter().find(|(k, _, _)| *k == key) {
            return (*known, *held);
        }
        let mut above = stack.to_vec();
        above.push(key.clone());
        let bound = self.bound(movement, signature, above);
        let kind = match bound.returns.split_first() {
            // A bound call of one that returns nothing fails, mirrored.
            None => Some(Kind::Value),
            Some((first, rest)) => rest.iter().all(|k| k == first).then_some(*first).flatten(),
        };
        let held = bound.returned_values_holder(&movement.body);
        self.returns.borrow_mut().push((key, kind, held));
        (kind, held)
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
    plugin_binds: BTreeMap<String, PluginImport>,
    /// The program's movements, for the calls the body makes: what each
    /// passes and what it hands back.
    callees: Option<&'c Callees<'c>>,
    /// The calls being worked out above this body (a recursion's cycle).
    stack: Vec<(String, Signature)>,
    /// Each call the body makes, by callee and what it passes.
    calls: Vec<(&'c ast::MovementDeclaration, Signature)>,
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
    /// The values bound only to a COALESCE or an IF that hands back a
    /// record or data (`either_holder`), each binding's text: a maybe-record
    /// a position parameter takes before version 5 (B15). `None` once any
    /// binding of the name is something else.
    either_values: BTreeMap<String, Option<Vec<String>>>,
    /// What each collection op's parameter holds: a member of its source.
    param_holders: BTreeMap<String, Holder>,
    /// The parameters that take a value the checker types as never a record.
    plain_params: BTreeSet<String>,
    /// Nodes whose literal holds a record in a field (or may).
    record_nodes: BTreeSet<String>,
    /// The closures whose bodies this walk collected (by where each is
    /// written): what a call of one hands back is read off its `return`s
    /// only where its names are this walk's.
    closures_walked: Vec<ast::Span>,
    /// The closures whose returns are being read (a recursion's cycle).
    closures_returning: RefCell<Vec<String>>,
    /// What each call of a movement hands back, as far as a record goes, by
    /// where the call is written.
    call_holders: Vec<(ast::Span, Holder)>,
    /// What each movement call nested in an expression hands back, by the
    /// call's text (several places writing the same text joined).
    nested_holders: Vec<(String, Holder)>,
    /// Each binding of a name, in order, as arms a MAP builds at run time
    /// (`built_arms_holder`): what a combinator over them receipts, `None`
    /// for a binding that is not such arms.
    built_arms: BTreeMap<String, Vec<Option<Holder>>>,
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

/// What a movement hands back under a signature: the kind its returns
/// share, and what those returns hold as far as a record goes.
type Returned = ((String, Signature), Option<Kind>, Holder);

impl<'c> Bound<'c> {
    /// What a plain plugin call binds, by its output (anything but a record
    /// is read as a value, and what it does not bind is refused where the
    /// call stands).
    fn plugin_bind(&self, callee: &str) -> Option<PluginBinds> {
        plugin_bind(&self.plugin_binds, callee, self.callees.map_or(0, |c| c.language_version))
    }

    fn plugin_kind(&self, callee: &str) -> Option<Kind> {
        match self.plugin_bind(callee)? {
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
        match self.call_reading(call) {
            Some(crate::collection::Reading::Collection(op)) => Some(op),
            _ => None,
        }
    }

    /// The built-in's reading a call is (a collection op, `MEMBERS`), where
    /// it is one: not where the call's name is bound to something else.
    fn call_reading(&self, call: &CallStatement) -> Option<crate::collection::Reading> {
        let binds = self.callee(&call.callee).is_some() || self.binds_in_body(&call.callee) || self.plugin_binds.contains_key(&call.callee);
        let file_bound = self.callees.is_some_and(|c| c.file_scope.contains(&call.callee));
        crate::collection::reading(call, binds || file_bound, self.callees.map_or(3, |c| c.language_version)).ok().flatten()
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
                    let checked = self.callees.is_some_and(|c| c.language_version >= 5 && c.takes_value(param));
                    let held = if checked { Holder::Free } else { param_holder(op.op, index, member) };
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
                for param in &movement.params {
                    // From version 5 a typed value parameter takes only a
                    // value: the checker holds each member, and a REDUCE's
                    // start, to it (MOV_CALL_ARG_TYPE, MOV_CALL_ARG_MAYBE_RECORD).
                    let kinds: &[Kind] = if callees.language_version >= 5 && callees.takes_value(param) { &[Kind::Value] } else { &any };
                    signatures = signatures.iter().flat_map(|s| kinds.iter().map(move |k| [s.as_slice(), &[*k]].concat())).collect();
                    if signatures.len() > any.len() * any.len() {
                        self.unknown_calls.push(op.span);
                        return;
                    }
                }
                for signature in signatures {
                    self.calls.push((movement, signature));
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
            self.closure_body(closure, scope);
        }
        // A closure written in place as a function's argument (language
        // version 5; a collection op's function is its member's,
        // `collection`).
        if let Some(call) = statement_call(statement)
            && self.callees.is_some_and(|c| c.language_version >= 5)
            && self.call_reading(call).is_none()
        {
            for arg in &call.args {
                if let CallArg::Closure { closure, .. } = arg {
                    self.closure_body(closure, scope);
                }
            }
        }
    }

    fn closure_body(&mut self, closure: &ast::ClosureExpression, scope: &[usize]) {
        let inner = self.enter(scope);
        for param in &closure.params {
            self.member_params.push((param.name.clone(), inner.clone()));
            let held = self.closure_param_holder(param);
            let joined = self.param_holders.get(&param.name).map_or(held, |h| h.join(held));
            self.param_holders.insert(param.name.clone(), joined);
        }
        self.closures_walked.push(closure.span);
        self.blocks += 1;
        self.collect(&closure.body, &inner);
        self.blocks -= 1;
    }

    /// What a closure's parameter holds, by the type it is declared with
    /// (the checker holds every argument to it): a value type takes a value
    /// no record is (`Callees::takes_value`); a position takes one record,
    /// whose fields hold none where no node of the body's holds one
    /// (`Names::closure_with` reads it alike).
    fn closure_param_holder(&self, param: &ast::MovementParam) -> Holder {
        let Some(callees) = self.callees else { return Holder::Other };
        match &param.type_ {
            Some(_) if callees.takes_value(param) => Holder::Free,
            Some(ParamTypeRef::Name(_)) if self.record_nodes.is_empty() => Holder::Record,
            _ => Holder::Other,
        }
    }

    fn collect(&mut self, statements: &[Statement], scope: &[usize]) {
        for statement in statements {
            self.closures_of(statement, scope);
            self.nested_movement_calls(statement);
            self.nested_collections(statement, scope);
            if let Some(op) = match statement {
                Statement::Collection(statement) => Some(statement.collection.clone()),
                Statement::Call(call) => self.call_collection(call),
                Statement::Assign(assign) => self.rvalue_collection(&assign.value),
                Statement::Return(ret) => self.rvalue_collection(&ret.value),
                _ => None,
            } {
                self.collection(&op, scope);
            }
            // A returned block: its names bound as a bound block's are.
            if let Statement::Return(ast::ReturnStatement { value: RValue::Block { block }, .. }) = statement {
                self.block(block, scope);
            }
            match statement {
                Statement::Assign(assign) => {
                    let kind = match &assign.value {
                        RValue::Write { write } if self.into_node(&write.target) => Kind::Member,
                        RValue::Match { r#match } if self.into_node(&r#match.target) => Kind::Member,
                        RValue::Write { .. } | RValue::Match { .. } | RValue::Link { .. } => Kind::Handle,
                        RValue::Construct { construct } if self.callee(&construct.callee).is_some() => self.call_kind(&construction_as_call(construct)),
                        RValue::Construct { construct } if self.calls_closure(&construct.callee) => {
                            self.closure_call_args(&construction_as_call(construct).args);
                            Kind::Value
                        }
                        RValue::Call { call } if self.calls_closure(&call.callee) || self.value_callee(&call.callee) => {
                            self.closure_call_args(&call.args);
                            Kind::Value
                        }
                        RValue::Construct { construct } if self.value_callee(&construct.callee) => {
                            self.closure_call_args(&construction_as_call(construct).args);
                            Kind::Value
                        }
                        RValue::Construct { construct } => self.plugin_kind(&construct.callee).unwrap_or(Kind::Instance),
                        RValue::Call { call } if self.callee(&call.callee).is_some() => self.call_kind(call),
                        RValue::Call { call } if self.plugin_kind(&call.callee).is_some() => {
                            self.closure_call_args(&call.args);
                            self.plugin_kind(&call.callee).unwrap_or(Kind::Value)
                        }
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
                            if let Ok(Expression::Property { property_type_id: name, field_only: false } | Expression::AliasRef { name }) = lowered(&expr.raw)
                                && self.graphs.contains(&name)
                            {
                                self.graphs.insert(assign.name.clone());
                            }
                            self.expression_kind(&expr.raw)
                        }
                        _ => Kind::Value,
                    };
                    if kind == Kind::Value {
                        // A bound block's is read once the block's own names
                        // are bound, below.
                        let holder = if matches!(assign.value, RValue::Block { .. }) { Holder::Free } else { self.rvalue_holder(&assign.value) };
                        let joined = self.value_holders.get(&assign.name).map_or(holder, |h| h.join(holder));
                        self.value_holders.insert(assign.name.clone(), joined);
                        let either = self.either_text(&assign.value).filter(|raw| lowered(raw).is_ok_and(|e| either_holder(&e, &|name| self.holder(name)).is_some())).map(String::from);
                        let seen = self.either_values.entry(assign.name.clone()).or_insert_with(|| Some(Vec::new()));
                        match either {
                            Some(raw) => {
                                if let Some(raws) = seen {
                                    raws.push(raw);
                                }
                            }
                            None => *seen = None,
                        }
                    }
                    let arms = self.rvalue_collection(&assign.value).and_then(|op| self.built_arms_holder(&op));
                    self.built_arms.entry(assign.name.clone()).or_default().push(arms);
                    self.bind(&assign.name, kind, scope);
                    if let RValue::Write { write } = &assign.value
                        && self.local_write_holds_record(write)
                    {
                        self.record_nodes.insert(assign.name.clone());
                    }
                    // A node a call hands back holds a record in a field where
                    // the callee's returns may; a second name for a node that
                    // holds one, too.
                    let node_kind = matches!(kind, Kind::Node | Kind::Graph | Kind::Member | Kind::Lazy);
                    let call_span = match &assign.value {
                        RValue::Call { call } if self.callee(&call.callee).is_some() => Some(call.span),
                        RValue::Construct { construct } if self.callee(&construct.callee).is_some() => Some(construct.span),
                        _ => None,
                    };
                    let aliases_dirty = matches!(&assign.value, RValue::Expr { expr }
                        if matches!(lowered(&expr.raw), Ok(Expression::AliasRef { name } | Expression::Property { property_type_id: name, field_only: false }) if self.record_nodes.contains(&name)));
                    if node_kind && (call_span.is_some_and(|span| self.call_holder(span) != Holder::Record) || aliases_dirty) {
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
                Statement::Call(call) if self.calls_closure(&call.callee) || self.value_callee(&call.callee) => self.closure_call_args(&call.args),
                // A plugin's arguments that call a movement: what each hands
                // back (`Names::plugin_call`).
                Statement::Call(call) if self.plugin_kind(&call.callee).is_some() => self.closure_call_args(&call.args),
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

    /// The movement calls nested in a statement's own expressions (crate::nested,
    /// version 3 on): each noted for the walk under what it passes, as a
    /// statement's call is. A call whose value is not known to be a value
    /// (a record, a node, or a kind decided at run time) is noted unknown,
    /// so `Names::nested_value` refuses it: a nested call's value is read as
    /// a value. A positional call carries its own reading as an expression
    /// (`n = make(l)`, `said = summarise(pick("a"))`); where the call runs
    /// as a call — a function's, a plugin's, a closure's, one through a
    /// value — and not as the built-in's expression it reads as
    /// (`builtin_reading`), that slot is the call and its arguments, each
    /// read where the statement or argument holds it: what it hands back is
    /// noted, but nothing in it is refused as a value.
    fn nested_movement_calls(&mut self, statement: &Statement) {
        let Some(callees) = self.callees else { return };
        if callees.language_version < 3 {
            return;
        }
        let runs_as_call = |callee: &str| self.callee(callee).is_some() || self.plugin_kind(callee).is_some() || self.calls_closure(callee) || self.value_callee(callee);
        let readings: Vec<ast::Span> = call_readings(statement).into_iter().filter(|(callee, _)| runs_as_call(callee)).map(|(_, span)| span).collect();
        for slot in direct_slots(statement) {
            let own_reading = readings.contains(&slot.span);
            let Ok(tree) = movement_parser::expr::parse_expression(&slot.raw) else { continue };
            let runs = |call: &movement_parser::tree::MExpr| match call {
                movement_parser::tree::MExpr::Call { callee, .. } => matches!(callee.as_ref(), movement_parser::tree::MExpr::Name { name, .. } if self.callee(&name.text).is_some()),
                _ => false,
            };
            for at in crate::nested::staged_calls(&tree, &runs) {
                let Ok(RValue::Call { call }) = crate::nested::nested_call(&slot, at, callees.language_version) else { continue };
                if self.callee(&call.callee).is_none() {
                    continue;
                }
                if self.known_call_kind(&call) != Some(Kind::Value) && !own_reading {
                    self.unknown_calls.push(call.span);
                }
                let text = movement_parser::util::utf16::Utf16::new(&slot.raw).text(at.start, at.end);
                let held = self.call_holder(call.span);
                match self.nested_holders.iter_mut().find(|(t, _)| *t == text) {
                    Some((_, seen)) => *seen = returned_join(*seen, held),
                    None => self.nested_holders.push((text, held)),
                }
            }
        }
    }

    /// The collection ops nested in a statement's own expressions
    /// (crate::nested, version 3 on), each collected as a statement's op is:
    /// its function's body entered, a movement handed by name noted. One
    /// op is read once, though two slots hold its text (a built-in's call
    /// and the call among its arguments).
    fn nested_collections(&mut self, statement: &Statement, scope: &[usize]) {
        let Some(callees) = self.callees else { return };
        if callees.language_version < 3 {
            return;
        }
        let mut seen = Vec::new();
        for slot in direct_slots(statement) {
            let Ok(tree) = movement_parser::expr::parse_expression(&slot.raw) else { continue };
            let runs = |call: &movement_parser::tree::MExpr| match call {
                movement_parser::tree::MExpr::Call { callee, .. } => matches!(callee.as_ref(), movement_parser::tree::MExpr::Name { name, .. } if crate::nested::is_call_form(&name.text)),
                _ => false,
            };
            for at in crate::nested::staged_calls(&tree, &runs) {
                let Ok(RValue::Call { call }) = crate::nested::nested_call(&slot, at, callees.language_version) else { continue };
                if seen.contains(&call.span) {
                    continue;
                }
                seen.push(call.span);
                if let Some(crate::collection::Reading::Collection(op)) = self.call_reading(&call) {
                    self.collection(&op, scope);
                    // What it hands back, as a statement's op's binding holds it.
                    let text = movement_parser::util::utf16::Utf16::new(&slot.raw).text(at.start, at.end);
                    let held = self.collection_holder(&op);
                    match self.nested_holders.iter_mut().find(|(t, _)| *t == text) {
                        Some((_, seen)) => *seen = seen.join(held),
                        None => self.nested_holders.push((text, held)),
                    }
                }
            }
        }
    }

    /// A closure's or a plugin's call's arguments that call a movement: what
    /// each hands back, for the parameter it binds (`Names::call_args`,
    /// `Names::plugin_call`).
    fn closure_call_args(&mut self, args: &[CallArg]) {
        for arg in args {
            if let CallArg::Call { call, .. } = arg
                && self.callee(&call.callee).is_some()
            {
                self.call_kind(call);
            }
        }
    }

    /// What a value a right-hand side binds holds, as far as a record goes.
    fn rvalue_holder(&self, value: &RValue) -> Holder {
        match value {
            _ if let Some(op) = self.rvalue_collection(value) => self.collection_holder(&op),
            RValue::Block { block } => self.returned_holder(&block.body),
            RValue::Expr { expr } => self.holds(&expr.raw),
            // What a closure's or a movement's `return`s hand back: the type
            // the checker gives a call is its callee's returns', read here
            // off those returns.
            RValue::Call { call } if self.calls_closure(&call.callee) => self.closure_call_holder(&call.callee),
            RValue::Construct { construct } if self.calls_closure(&construct.callee) => self.closure_call_holder(&construct.callee),
            RValue::Call { call } if self.value_callee(&call.callee) => self.value_call_holder(),
            RValue::Construct { construct } if self.value_callee(&construct.callee) => self.value_call_holder(),
            RValue::Call { call } if self.callee(&call.callee).is_some() => self.call_holder(call.span),
            RValue::Construct { construct } if self.callee(&construct.callee).is_some() => self.call_holder(construct.span),
            // A type's members are its words.
            RValue::Call { call } if matches!(self.call_reading(call), Some(crate::collection::Reading::Members(_))) => Holder::Free,
            RValue::Call { call } if self.plugin_kind(&call.callee).is_none() => call.expression.as_ref().map_or(Holder::Other, |e| self.holds(&e.raw)),
            // A plugin's records output: a list of records whose
            // fields are the data it found.
            RValue::Call { call } if self.plugin_bind(&call.callee) == Some(PluginBinds::Records) => Holder::List,
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
            // The records an extraction call found, run-local
            // nodes whose fields are what the model said.
            RValue::ExtractCall { extract_call } if matches!(extract_call.finds, ast::ExtractCallFinds::One) => Holder::Record,
            RValue::ExtractCall { .. } => Holder::List,
            // A write's, a match's or a link's record, its fields the system's.
            RValue::Write { .. } | RValue::Match { .. } | RValue::Link { .. } => Holder::Record,
            // A node whose literal holds no record: one record whose fields
            // hold none.
            RValue::Node { node } if self.literal_free(node) => Holder::Record,
            // A closure is a value (language version 5) that holds no
            // record itself: what a call of it hands back is the call's.
            RValue::Closure { .. } if self.callees.is_some_and(|c| c.language_version >= 5) => Holder::Free,
            _ => Holder::Other,
        }
    }

    /// What a call of the closure bound to `name` hands back: what the
    /// `return`s of every closure of that name hand back — read in this walk
    /// where it collected the body (its names are this walk's), else in the
    /// walk that holds its names (`Callees::outside_closure_holder`: a
    /// closure written at file scope, or handed back by another function's
    /// call); a recursion's cycle may be anything.
    fn closure_call_holder(&self, name: &str) -> Holder {
        let Some(callees) = self.callees else { return Holder::Other };
        let Some(name) = callees.closure_name(name, self.binds_in_body(name)) else { return Holder::Other };
        let Some(bodies) = callees.closure_bodies.get(name) else { return Holder::Other };
        if self.closures_returning.borrow().iter().any(|n| n == name) {
            return Holder::Other;
        }
        self.closures_returning.borrow_mut().push(name.to_string());
        let held = bodies
            .iter()
            .map(|closure| {
                if self.closures_walked.contains(&closure.span) {
                    self.returned_values_holder(&closure.body)
                } else {
                    callees.outside_closure_holder(closure)
                }
            })
            .reduce(returned_join)
            .unwrap_or(Holder::Other);
        self.closures_returning.borrow_mut().pop();
        held
    }

    /// What a call of the closure bound to `name` binds: a value where what
    /// it hands back is free of records (`closure_call_holder`); not known
    /// otherwise.
    fn closure_call_kind(&self, name: &str) -> Option<Kind> {
        (self.closure_call_holder(name) == Holder::Free).then_some(Kind::Value)
    }

    /// What the movement call written at `span` hands back (`known_call_kind`
    /// worked it out), or anything where it was not.
    fn call_holder(&self, span: ast::Span) -> Holder {
        self.call_holders.iter().rev().find(|(at, _)| *at == span).map_or(Holder::Other, |(_, held)| *held)
    }

    /// A block's hop alias and its body, in the block's own scope (its
    /// iteration's).
    fn block(&mut self, block: &TraversalBlock, scope: &[usize]) {
        let inner = self.enter(scope);
        // A head over what an extraction yielded lands on its entities.
        let over_extract = matches!(&block.head.root, Some(PathRoot::Name { name }) if self.extracts.contains(name));
        let over_node = matches!(&block.head.root, Some(PathRoot::Name { name }) if self.nodes.contains(name) || self.members.contains(name));
        let kind = if over_extract {
            Kind::Extracted
        } else if over_node {
            Kind::Member
        } else {
            Kind::Landing
        };
        // Every hop's alias names its own level's record on the path; a
        // `_resources` hop's, the resource (a record, as a landing is).
        if let Some(alias) = crate::traverse::resources_alias(&block.head.hops_raw) {
            self.bind(&alias, Kind::Landing, &inner);
        }
        for alias in crate::traverse::head_steps(&block.head).unwrap_or_default().into_iter().filter_map(|step| step.alias) {
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
            Ok(Expression::Property { property_type_id: name, field_only: false } | Expression::AliasRef { name }) => self.kind_of(&name),
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

    /// Whether a call names a closure bound to that name (`Callees::closure`).
    fn calls_closure(&self, written: &str) -> bool {
        self.callee(written).is_none() && self.callees.is_some_and(|c| c.closure(written, self.binds_in_body(written)).is_some())
    }

    /// A call through a value (language version 5, run.ts's call of a name
    /// whose value is a closure): its callee a name the body or the file
    /// binds — a parameter, a member, `g = one`; not a function of the
    /// program's, a closure bound to the name, or a plugin.
    fn value_callee(&self, written: &str) -> bool {
        let Some(callees) = self.callees else { return false };
        if callees.language_version < 5 || self.callee(written).is_some() || self.calls_closure(written) || self.plugin_kind(written).is_some() {
            return false;
        }
        let holds = |name: &str| self.binds_here(name) || callees.file_holders.contains_key(name);
        holds(written)
    }

    /// What a call through a value hands back (`Callees::value_call_holder`).
    fn value_call_holder(&self) -> Holder {
        self.callees.map_or(Holder::Other, |c| c.value_call_holder())
    }

    /// What a right-hand side binds, for what a `return` of it hands back.
    fn value_kind(&mut self, value: &RValue) -> Option<Kind> {
        Some(match value {
            // A closure's call hands back what its returns do: a value where
            // every closure of the name returns one free of records.
            RValue::Call { call } if self.calls_closure(&call.callee) => return self.closure_call_kind(&call.callee),
            RValue::Construct { construct } if self.calls_closure(&construct.callee) => return self.closure_call_kind(&construct.callee),
            RValue::Call { call } if self.value_callee(&call.callee) => return (self.value_call_holder() == Holder::Free).then_some(Kind::Value),
            RValue::Construct { construct } if self.value_callee(&construct.callee) => return (self.value_call_holder() == Holder::Free).then_some(Kind::Value),
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
            RValue::Lazy { .. } => Kind::Lazy,
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
        let mut holder: Option<Holder> = None;
        for signature in signatures {
            self.calls.push((declaration, signature.clone()));
            let (kind, held) = callees.returns(declaration, &signature, &self.stack);
            returned = Some(match returned {
                None => kind,
                Some(seen) if seen == kind => seen,
                Some(_) => None,
            });
            holder = Some(holder.map_or(held, |h| returned_join(h, held)));
        }
        self.call_holders.push((call.span, holder.unwrap_or(Holder::Other)));
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
        // engines before any request is made. A function's name read as a
        // value (language version 5) is the function, free of records.
        match self.callees {
            Some(callees) if callees.language_version >= 5 && callees.movement(name).is_some() => Holder::Free,
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
        match self.returned_values_holder(body) {
            Holder::Free => Holder::Free,
            Holder::Record => Holder::List,
            Holder::Map { depth, lists } => Holder::Rows { depth, lists },
            _ => Holder::Other,
        }
    }

    /// What the values a body's `return`s hand back hold, widened: free of
    /// records, one record whose fields are (a record, or a value that is
    /// one), or anything. Each is read as the right-hand side it is: a
    /// built-in's call as its expression, a closure's or a movement's call
    /// as what its own returns hand back.
    fn returned_values_holder(&self, body: &[Statement]) -> Holder {
        let mut returns = Vec::new();
        returns_of(body, &mut returns);
        returns.into_iter().map(|value| self.returned_value_holder(value)).fold(Holder::Free, returned_join)
    }

    /// One `return`'s value, as `returned_values_holder` widens it: a
    /// COALESCE or an IF handing back a record or data is one record or
    /// data (`either_holder`), as two returns of each are.
    fn returned_value_holder(&self, value: &RValue) -> Holder {
        if let Some(raw) = self.either_text(value)
            && let Some(held) = lowered(raw).ok().and_then(|e| either_holder(&e, &|name| self.holder(name)))
        {
            return held;
        }
        self.rvalue_holder(value)
    }

    /// A right-hand side's expression text where it is one with no nested
    /// call of a function, a closure or a plugin: an expression, or a
    /// built-in called (`COALESCE(…)`, staged as a call).
    fn either_text<'v>(&self, value: &'v RValue) -> Option<&'v str> {
        let raw = match value {
            RValue::Expr { expr } => &expr.raw,
            RValue::Call { call } if self.callee(&call.callee).is_none() && !self.calls_closure(&call.callee) && !self.value_callee(&call.callee) && self.plugin_kind(&call.callee).is_none() => &call.expression.as_ref()?.raw,
            _ => return None,
        };
        (!self.has_nested_call(raw)).then_some(raw.as_str())
    }

    /// Whether a slot's text holds a nested call (crate::nested) of a
    /// function, a closure or a plugin: what it hands back is not read off
    /// the text itself.
    fn has_nested_call(&self, raw: &str) -> bool {
        nested_rewrite(raw, &|name| self.callee(name).is_some() || self.calls_closure(name) || self.value_callee(name) || self.plugin_kind(name).is_some(), &|_, _| Holder::Other, &|name| self.holder(name)).is_some()
    }

    /// What each `return` of a body hands back, widened: free of records,
    /// one record binding whose fields are, or anything (a value holding a
    /// record among it: a receipt reads a record binding's slot as null,
    /// never such a value's).
    fn returns_holder(&self, body: &[Statement]) -> Holder {
        let mut returned = Holder::Free;
        let mut returns = Vec::new();
        returns_of(body, &mut returns);
        for value in returns {
            let one = match value {
                RValue::Expr { expr } => lowered(&expr.raw).map_or(Holder::Other, |e| match &e {
                    Expression::AliasRef { name } | Expression::Property { property_type_id: name, field_only: false } if self.holder(name) == Holder::Record => Holder::Record,
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
    /// returned a value that may. Arms a value holds are the closures a MAP
    /// built them as (`built_arms`), where every binding of the name is one.
    fn receipt_holder(&self, combinator: &ast::CombinatorExpression) -> Holder {
        let arms = match &combinator.arms {
            CombinatorArms::Literal { arms, .. } | CombinatorArms::Arguments { arms, .. } => arms,
            CombinatorArms::Dynamic { expr, .. } => {
                let Ok(Expression::AliasRef { name } | Expression::Property { property_type_id: name, field_only: false }) = lowered(&expr.raw) else { return Holder::Other };
                return match self.built_arms.get(&name) {
                    Some(bindings) if let Some(held) = bindings.iter().try_fold(Holder::Free, |held, arms| arms.map(|arms| held.join(arms))) => held,
                    // Arms a value holds otherwise (language version 5): any
                    // function a value may hold, each slot what a call
                    // through a value hands back, a record's slot null.
                    _ if self.callees.is_some_and(|c| c.language_version >= 5) => match self.value_call_holder() {
                        Holder::Free | Holder::Record => Holder::Free,
                        _ => Holder::Other,
                    },
                    _ => Holder::Other,
                };
            }
        };
        let mut held = Holder::Free;
        for arm in arms {
            let arm_held = match arm {
                ArmExpression::Closure { closure, .. } => self.returns_holder(&closure.body),
                // A closure by name: its body's returns; a movement by name:
                // its returns (no arguments, so no values to hold).
                ArmExpression::Ref { name, .. } if self.calls_closure(name) => self.closure_call_holder(name),
                ArmExpression::Ref { name, .. } => match self.callees.and_then(|callees| Some((callees, callees.movement(name)?))) {
                    Some((callees, movement)) if movement.params.iter().all(|p| callees.takes_value(p)) => {
                        callees.returns(movement, &vec![Kind::Value; movement.params.len()], &[]).1
                    }
                    _ => return Holder::Other,
                },
            };
            if !matches!(arm_held, Holder::Free | Holder::Record) {
                held = Holder::Other;
            }
        }
        held
    }

    /// What a combinator over the arms a MAP builds receipts (`arms =
    /// MAP(xs, (n) => { return () => { … } })`, each arm a closure its
    /// function returns): a slot holds a record only where an arm's
    /// `return` may hand one back. `None` where the op builds anything else.
    fn built_arms_holder(&self, op: &CollectionOpExpression) -> Option<Holder> {
        if op.op != CollectionOp::Map {
            return None;
        }
        let ArmExpression::Closure { closure, .. } = &op.r#fn else { return None };
        let mut returns = Vec::new();
        returns_of(&closure.body, &mut returns);
        if returns.is_empty() {
            return None;
        }
        let mut held = Holder::Free;
        for value in returns {
            let RValue::Closure { closure: arm } = value else { return None };
            if !matches!(self.returns_holder(&arm.body), Holder::Free | Holder::Record) {
                held = Holder::Other;
            }
        }
        Some(held)
    }

    /// What a collection op hands back, as far as a record goes: a MAP the
    /// list of what its function returns, a FILTER its source's members.
    fn collection_holder(&self, op: &CollectionOpExpression) -> Holder {
        let source = lowered(&op.source.raw).map_or(Holder::Other, |s| member_holder(&s, &|name| self.holder(name)));
        let returned = match &op.r#fn {
            ArmExpression::Closure { closure, .. } => self.returned_values_holder(&closure.body),
            // A closure by name: what its body returns, its parameters
            // holding what they are declared to.
            ArmExpression::Ref { name, .. } if self.calls_closure(name) => self.closure_call_holder(name),
            // A movement taking values (the checker holds each member to
            // their types): what it returns, called with values.
            ArmExpression::Ref { name, .. } => match self.callees.and_then(|callees| Some((callees, callees.movement(name)?))) {
                Some((callees, movement)) if movement.params.iter().all(|p| callees.takes_value(p)) => {
                    callees.returns(movement, &vec![Kind::Value; movement.params.len()], &[]).1
                }
                _ => return Holder::Other,
            },
        };
        let list = |member: Holder| match member {
            Holder::Free => Holder::Free,
            Holder::Record => Holder::List,
            Holder::Map { depth, lists } => Holder::Rows { depth, lists },
            _ => Holder::Other,
        };
        let init = op.init.as_ref().map_or(Holder::Free, |init| self.holds(&init.raw));
        match op.op {
            CollectionOp::Map => list(returned),
            // The members themselves, kept or reordered.
            CollectionOp::Filter | CollectionOp::Sort => list(source),
            // What the last member's call returned, or the initial value.
            CollectionOp::Reduce if init == Holder::Free && returned == Holder::Free => Holder::Free,
            // Each member under the key its function returned.
            CollectionOp::Keyby => match source {
                Holder::Free => Holder::Free,
                Holder::Record => Holder::Map { depth: 1, lists: false },
                _ => Holder::Other,
            },
            // The list of the members under each key its function returned.
            CollectionOp::Groupby => match source {
                Holder::Free => Holder::Free,
                Holder::Record => Holder::Map { depth: 1, lists: true },
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
        // A nested call's value is what the callee hands back (`holds`),
        // read where no hop alias is in scope.
        let nested = |raw: &str| {
            nested_rewrite(raw, &|name| self.callee(name).is_some() || self.calls_closure(name) || self.plugin_kind(name).is_some(), &|_, _| Holder::Other, &|name| self.holder(name)).is_some()
        };
        let free = |raw: &str| match nested(raw) {
            true => aliases.is_empty() && self.holds(raw) == Holder::Free,
            false => lowered(raw).is_ok_and(|expr| value_holder(&expr, &holder) == Holder::Free),
        };
        // A spread copies a record's fields (`spreadRecordIntoGraph`), or a
        // map's keys: free where what it reads holds no record but itself.
        let spreads = node.spreads.iter().flatten().all(|spread| match &spread.path {
            None => holder(&spread.source) != Holder::Other,
            Some(_) => matches!(self.holds(&spread.source), Holder::Free | Holder::Record),
        });
        spreads
            && node.entries.iter().all(|entry| match entry {
                // A graph names a record by reference: it lands on the edge
                // (`referencedRecords`), not in a field.
                NodeEntry::Value { value, .. } if node.graph.is_some() && holder(crate::js::trim(&value.raw)) == Holder::Record => true,
                NodeEntry::Value { value, .. } => free(&value.raw),
                NodeEntry::Nodes { nodes, .. } => nodes.iter().all(|n| self.literal_free_with(n, aliases)),
                NodeEntry::Traversal { head, mapping, .. } => mapping.as_ref().is_none_or(|m| {
                    let mut inner = aliases.clone();
                    inner.extend(crate::traverse::head_aliases(head));
                    self.literal_free_with(m, &inner)
                }),
                NodeEntry::Declared { .. } => true,
            })
    }

    /// Whether an expression slot's value holds no record.
    fn reads_free(&self, raw: &str) -> bool {
        self.holds(raw) == Holder::Free
    }

    /// What a value bound to an expression slot holds: a nested call's
    /// value may be anything.
    fn holds(&self, raw: &str) -> Holder {
        let call_holder = |callee: &str, text: &str| {
            if self.calls_closure(callee) {
                self.closure_call_holder(callee)
            } else if self.value_callee(callee) {
                self.value_call_holder()
            } else if self.callee(callee).is_some() {
                nested_holder(&self.nested_holders, text)
            } else if is_collection_form(callee) && self.plugin_kind(callee).is_none() && !self.binds_in_body(callee) {
                // A collection op: what `nested_collections` read it to hand back.
                nested_holder(&self.nested_holders, text)
            } else if self.plugin_kind(callee).is_some() || !staged_as_value(callee) {
                nested_call_holder(callee, self.plugin_bind(callee))
            } else {
                self.holds(text)
            }
        };
        let nested = nested_rewrite(raw, &|name| self.callee(name).is_some() || self.calls_closure(name) || self.value_callee(name) || self.plugin_kind(name).is_some(), &call_holder, &|name| self.holder(name));
        let names = nested.as_ref().map_or(&[][..], |(_, plan)| plan.names.as_slice());
        let holder = |name: &str| match names.iter().find(|(n, _)| n == name) {
            Some((_, held)) => *held,
            None => self.holder(name),
        };
        lowered(nested.as_ref().map_or(raw, |(text, _)| text.as_str())).map_or(Holder::Other, |expr| value_holder(&expr, &holder))
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
    plugin_binds: &'n BTreeMap<String, PluginImport>,
    /// What extractions yielded: a root, or an entity a head landed on.
    extracts: &'n BTreeSet<String>,
    /// The nodes a `graph { … }` literal built.
    graphs: &'n BTreeSet<String>,
    /// The node declarations the file makes.
    shapes: &'n BTreeSet<String>,
    /// Names a body binds to a shape's name (`D = Detail`, from version 3 a
    /// second name for the shape itself, `aliasedNodeBinding`).
    shape_aliases: &'n BTreeSet<String>,
    /// The movements as callees: what a call's arguments bind.
    callees: &'n Callees<'n>,
    /// The calls whose arguments or value are of a kind not known.
    unknown_calls: &'n [ast::Span],
    language_version: u32,
    /// What each value (of `values`) holds, as far as a record goes; one
    /// not here may hold anything.
    value_holders: &'n BTreeMap<String, Holder>,
    /// (`Bound::either_values`): the maybe-record values, each binding's
    /// text; a parameter of a body walked inside shadows its name.
    either_values: &'n BTreeMap<String, Option<Vec<String>>>,
    /// The nodes whose literal holds a record in a field (or may).
    record_nodes: &'n BTreeSet<String>,
    /// What a call of each closure bound to a name hands back, as far as a
    /// record goes (`Bound::closure_call_holder`).
    closure_holders: &'n BTreeMap<String, Holder>,
    /// What each movement call hands back, by where it is written
    /// (`Bound::call_holders`).
    call_holders: &'n [(ast::Span, Holder)],
    /// (`Bound::nested_holders`).
    nested_holders: &'n [(String, Holder)],
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
                RValue::Construct { construct } if self.calls_closure(&construct.callee) => self.closure_call(&construction_as_call(construct)),
                RValue::Call { call } if self.calls_closure(&call.callee) => self.closure_call(call),
                RValue::Call { call } if self.value_callee(&call.callee) => self.value_call(call),
                RValue::Construct { construct } if self.value_callee(&construct.callee) => self.value_call(&construction_as_call(construct)),
                RValue::Construct { construct } if self.plugin(&construct.callee) => {
                    self.plugin_invocation(&construct.callee, construct.args.iter().map(|a| Some(&a.value)))
                }
                RValue::Extract { extract } => self.extract(extract),
                RValue::ExtractCall { extract_call } => self.extract_call(extract_call),
                // `f(n: 3)` of a closure or a value the body binds is its
                // call (the construction spelling of one), not an instance.
                RValue::Construct { construct } if self.values.contains(&construct.callee) || self.binds_in_body(&construct.callee) => refuse("function_call"),
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
                RValue::Block { block } => self.block(block),
                RValue::Extract { extract } => self.extract(extract),
                RValue::ExtractCall { extract_call } => self.extract_call(extract_call),
                RValue::Call { call } if self.callee(&call.callee).is_some() => self.call(call),
                RValue::Construct { construct } if self.callee(&construct.callee).is_some() => self.call(&construction_as_call(construct)),
                // A closure's call returned, as one bound is (`executeClosureCall`).
                RValue::Call { call } if self.calls_closure(&call.callee) => self.closure_call(call),
                RValue::Construct { construct } if self.calls_closure(&construct.callee) => self.closure_call(&construction_as_call(construct)),
                RValue::Call { call } if self.value_callee(&call.callee) => self.value_call(call),
                RValue::Construct { construct } if self.value_callee(&construct.callee) => self.value_call(&construction_as_call(construct)),
                RValue::Node { node } => self.node(node, node.graph.is_some()),
                // A kept walk handed back by a movement's body: the call's
                // value is the walk (`return` binds the right-hand side as
                // `x = lazy …` binds it), read at each read as a block head is.
                RValue::Lazy { lazy } if within == Within::Body => self.traversal_entry(&lazy.head, lazy.mapping.as_ref(), false),
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
            // The record the name holds, re-fetched; anything else fails the
            // run as the TypeScript's `interpretRefresh` fails it.
            Statement::Refresh(_) => Ok(()),
            Statement::Delete(statement) => {
                // What a node's edge holds is the record it is (a system's,
                // deleted in its system), or a run-built node, which the
                // TypeScript refuses as it refuses any binding that is no
                // record position (`resolvePositionWriteTarget`), mirrored:
                // so are the event and a value that holds no record.
                let name = &statement.name;
                let held = self.handles.contains(name) || self.landings.contains(name) || self.members.contains(name);
                let refused_alike = self.events.contains(name) || (self.values.contains(name) && self.holder(name) == Holder::Free);
                if held || refused_alike { Ok(()) } else { refuse("delete_not_record") }
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
            // A node declaration in a body names a shape for the whole body
            // (hoisted); its words read the body's scope.
            Statement::Shape(shape) => self.shape_words(&shape.root),
            Statement::Call(call) if self.plugin(&call.callee) => self.plugin_call(call),
            Statement::Call(call) if self.callee(&call.callee).is_some() => self.call(call),
            Statement::Call(call) if self.calls_closure(&call.callee) => self.closure_call(call),
            Statement::Call(call) if self.value_callee(&call.callee) => self.value_call(call),
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
            CombinatorArms::Literal { arms, .. } | CombinatorArms::Arguments { arms, .. } => {
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
    fn closure_with(&self, declared: &[ast::MovementParam], body: &[Statement], held: Holder) -> Admitted {
        let params: BTreeSet<String> = declared.iter().map(|p| p.name.clone()).collect();
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
        let mut either_values = self.either_values.clone();
        for param in &params {
            value_holders.insert(param.clone(), held);
            either_values.remove(param);
        }
        // A parameter typed by a field type (`<text>`) takes a value no
        // record is (the checker holds the argument to it); one typed by a
        // position takes one record (a graph the run built among them),
        // whose fields hold none where no node of the body's holds one.
        for param in declared {
            if param.type_.is_none() {
                continue;
            }
            if self.callees.takes_value(param) {
                value_holders.insert(param.name.clone(), Holder::Free);
            } else if self.record_nodes.is_empty() {
                value_holders.insert(param.name.clone(), Holder::Record);
            }
        }
        let inner = Names {
            value_holders: &value_holders,
            either_values: &either_values,
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
        self.call_args(&declaration.params, &call.args)
    }

    /// A call of a closure bound to a name (`executeClosureCall`, from
    /// version 3): its arguments walked as a movement call's are, by what
    /// its parameters take; its body was walked where it is written, its
    /// parameters holding whatever a call hands them.
    fn closure_call(&self, call: &CallStatement) -> Admitted {
        match self.callees.closure(&call.callee, self.binds(&call.callee)) {
            Some(Some(params)) => self.call_args(params, &call.args),
            // Closures of the name that differ in what they take: from
            // language version 5 a call through the value the name holds.
            Some(None) if self.language_version >= 5 => self.value_call(call),
            _ => refuse("function_call"),
        }
    }

    /// A call through a value (language version 5): a parameter, a member,
    /// a name bound to a function read as a value, `box.g`
    /// (`Bound::value_callee`).
    fn value_callee(&self, written: &str) -> bool {
        if self.language_version < 5 || self.callee(written).is_some() || self.calls_closure(written) || self.plugin(written) {
            return false;
        }
        self.values.contains(written.split_once('.').map_or(written, |(object, _)| object))
    }

    /// A call through a value: the function it runs may be any a value may
    /// hold (`Callees::value_closures`), each body walked where it is
    /// written. Each argument is walked as an expression; one that may hold
    /// a record the checker refuses for a value parameter
    /// (MOV_CALL_ARG_MAYBE_RECORD, from version 5, the only version with
    /// calls through a value).
    fn value_call(&self, call: &CallStatement) -> Admitted {
        self.call_args(&[], &call.args)
    }

    /// A call's arguments, each walked as what it binds its parameter to.
    /// A value parameter, which the callee's body reads as free of records
    /// (`Callees::takes_value`), takes no argument that may hold one
    /// (`call_arg_record`). A position parameter, whose record the callee's
    /// body reads field by field as data, takes only a record known to hold
    /// none in a field (`position_arg_record`): so a callee's own position
    /// parameters are clean wherever they are passed on.
    fn call_args(&self, params: &[ast::MovementParam], args: &[CallArg]) -> Admitted {
        for (position, arg) in args.iter().enumerate() {
            let name = arg.name().map(String::from).or_else(|| params.get(position).map(|p| p.name.clone()));
            let param = name.and_then(|p| params.iter().find(|d| d.name == p));
            let takes_value = param.is_some_and(|p| self.callees.takes_value(p));
            // An untyped parameter is a collection op's function's (the checker
            // requires a type elsewhere), its member held where the op is.
            let takes_position = param.is_some_and(|p| p.type_.is_some()) && !takes_value;
            let free = |slot: &ExprSlot| {
                if takes_value && self.may_hold_record_slot(slot) {
                    refuse("call_arg_record")
                } else if takes_position && !self.clean_record(slot) {
                    refuse("position_arg_record")
                } else {
                    Ok(())
                }
            };
            let returns_free = |held: Holder| match held {
                held if self.hands_over_clean(held) && (held == Holder::Free || takes_position) => Ok(()),
                _ if takes_value => refuse("call_arg_record"),
                _ if takes_position => refuse("position_arg_record"),
                _ => Ok(()),
            };
            match arg {
                CallArg::Expr { expr, .. } if takes_value => {
                    self.slot(expr)?;
                    free(expr)?;
                }
                CallArg::Expr { expr, .. } => {
                    self.assigned(expr)?;
                    free(expr)?;
                }
                CallArg::Write { write, .. } => {
                    self.write(write)?;
                    if takes_position && self.writes_into_node(&write.target) && (!write.spreads.as_deref().unwrap_or_default().is_empty() || write.fields.iter().any(|f| self.may_hold_record_slot(&f.value))) {
                        return refuse("position_arg_record");
                    }
                }
                CallArg::Node { node, .. } => {
                    self.node(node, node.graph.is_some())?;
                    if takes_position && !self.literal_clean(node) {
                        return refuse("position_arg_record");
                    }
                }
                CallArg::Call { call, .. } if self.callee(&call.callee).is_some() => {
                    self.call(call)?;
                    returns_free(self.call_holders.iter().rev().find(|(at, _)| *at == call.span).map_or(Holder::Other, |(_, held)| *held))?;
                }
                CallArg::Call { call, .. } if self.calls_closure(&call.callee) => {
                    self.closure_call(call)?;
                    returns_free(self.closure_holder(&call.callee))?;
                }
                CallArg::Call { call, .. } if self.value_callee(&call.callee) => {
                    self.value_call(call)?;
                    returns_free(self.callees.value_call_holder())?;
                }
                CallArg::Call { call, .. } if takes_value => {
                    let value = self.builtin_value(call)?;
                    self.slot(value)?;
                    free(value)?;
                }
                CallArg::Call { call, .. } => {
                    let value = self.builtin_value(call)?;
                    self.assigned(value)?;
                    free(value)?;
                }
                // A closure written in place (language version 5): a value,
                // its body walked as a closure's.
                CallArg::Closure { closure, .. } if self.language_version >= 5 => self.reasons.noted(self.closure(&closure.params, &closure.body)),
                CallArg::Closure { .. } => return refuse("rvalue:closure"),
                CallArg::Type { .. } => return refuse("builtin_call_form"),
            }
        }
        Ok(())
    }

    /// Whether a call names a closure bound to that name (`Callees::closure`).
    fn calls_closure(&self, written: &str) -> bool {
        self.callee(written).is_none() && self.callees.closure(written, self.binds(written)).is_some()
    }

    /// Whether a call's value, handed on, holds no record a way this
    /// engine does not follow: free of records, or one record whose fields
    /// hold none (where no node of this body holds one).
    fn hands_over_clean(&self, held: Holder) -> bool {
        held == Holder::Free || (held == Holder::Record && self.record_nodes.is_empty())
    }

    /// A function's value handed to a plugin (`recordFields` of a record).
    fn plugin_value(&self, held: Holder) -> Admitted {
        if self.hands_over_clean(held) { Ok(()) } else { refuse("plugin_call_form") }
    }

    /// What a call of the closure `written` names hands back (`closure_holders`
    /// under the name it is bound to); anything where none is named.
    fn closure_holder(&self, written: &str) -> Holder {
        self.callees.closure_name(written, self.binds(written)).and_then(|name| self.closure_holders.get(name)).copied().unwrap_or(Holder::Other)
    }

    /// Whether what a slot hands a position parameter is a record known to
    /// hold none in a field: a system's record, an extraction's, the event,
    /// or a node of this body's where no node of the body holds one (a node
    /// handed in, through a parameter, was held to this at its own call; one
    /// a call returned, to what the callee's returns hold).
    fn clean_record(&self, slot: &ExprSlot) -> bool {
        if !matches!(self.text_holder(&slot.raw), Holder::Free | Holder::Record) {
            // B15: a value that may be a record and may be data (`COALESCE(co,
            // "x")`, an IF of the two, a name bound to one). Before version 5
            // the checker passes it, and the run binds the record, or fails
            // passing the data (`evaluateCallArg`), alike on both engines;
            // from 5 the checker refuses it.
            return self.nested_text(&slot.raw).is_none() && lowered(&slot.raw).is_ok_and(|expr| self.either_clean(&expr, 0));
        }
        if self.record_nodes.is_empty() {
            return true;
        }
        lowered(&slot.raw).is_ok_and(|expr| self.system_record(&expr))
    }

    /// A bare name of a record known to hold none in a field: a system's, an
    /// extraction's, the event.
    fn system_record(&self, expr: &Expression) -> bool {
        matches!(
            expr,
            Expression::AliasRef { name } | Expression::Property { property_type_id: name, field_only: false }
                if self.handles.contains(name) || self.instances.contains(name) || self.extracts.contains(name) || self.events.contains(name)
        )
    }

    /// Whether a maybe-record (`either_holder`) hands a position parameter
    /// only data or a record `clean_record` takes: each operand it may hand
    /// back, through the names bound to one (`either_values`).
    fn either_clean(&self, expr: &Expression, depth: u8) -> bool {
        if depth > 8 {
            return false;
        }
        let operand = |operand: &Expression| match value_holder(operand, &|name| self.holder(name)) {
            Holder::Free => true,
            Holder::Record => self.record_nodes.is_empty() || self.system_record(operand),
            _ => self.either_clean(operand, depth + 1),
        };
        match expr {
            Expression::Conditional { then, else_, .. } => operand(then) && operand(else_),
            Expression::Function { fn_, args } if fn_ == "coalesce" => args.iter().all(operand),
            Expression::AliasRef { name } | Expression::Property { property_type_id: name, field_only: false } if self.values.contains(name) => match self.either_values.get(name) {
                Some(Some(raws)) if !raws.is_empty() => raws.iter().all(|raw| lowered(raw).is_ok_and(|bound| self.either_clean(&bound, depth + 1))),
                _ => false,
            },
            _ => false,
        }
    }

    /// Whether a node literal handed to a position parameter holds no record
    /// in a field (`Bound::literal_free`'s reading, at a call).
    fn literal_clean(&self, node: &NodeLiteral) -> bool {
        self.literal_clean_with(node, &BTreeSet::new())
    }

    /// `literal_clean`, with `aliases` (a traversal entry's hop aliases)
    /// each one record a walk landed on.
    fn literal_clean_with(&self, node: &NodeLiteral, aliases: &BTreeSet<String>) -> bool {
        let holder = |name: &str| if aliases.contains(name) { Holder::Record } else { self.holder(name) };
        let free = |value: &ExprSlot| match self.nested_text(&value.raw) {
            Some(_) => aliases.is_empty() && !self.may_hold_record_slot(value),
            None => lowered(&value.raw).is_ok_and(|expr| !may_hold_record(&expr, &holder)),
        };
        node.spreads.iter().flatten().all(|spread| spread.path.is_none() && matches!(holder(&spread.source), Holder::Free | Holder::Record))
            && node.entries.iter().all(|entry| match entry {
                NodeEntry::Value { value, .. } if node.graph.is_some() && holder(crate::js::trim(&value.raw)) == Holder::Record => true,
                NodeEntry::Value { value, .. } => free(value),
                NodeEntry::Nodes { nodes, .. } => nodes.iter().all(|n| self.literal_clean_with(n, aliases)),
                NodeEntry::Traversal { head, mapping, .. } => mapping.as_ref().is_none_or(|m| {
                    let mut inner = aliases.clone();
                    inner.extend(crate::traverse::head_aliases(head));
                    self.literal_clean_with(m, &inner)
                }),
                NodeEntry::Declared { .. } => true,
            })
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
            // The run fails where the TypeScript's `resolveHeadIterations`
            // fails it (`unsupported`, crate::traverse `head_iterations_past`).
            None => return Ok(()),
            // `AT(rows, 0)-[c:company]->`: the root bound as `x = <it>` binds.
            Some(PathRoot::Expression { expr }) => {
                self.assigned(expr)?;
                return self.value_head(head);
            }
            Some(PathRoot::Name { name }) => name,
        };
        // A hop off a kept walk continues the walk itself, past its head
        // (crate::node `run_deferred_past`): its landings are a system's
        // records or the nodes its mapping builds, so the hop is held to
        // what every kind reads, as a value's is.
        if self.lazies.contains(root) {
            return self.value_head(head);
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
            // The record's resource bundle (`resolvePositionResources`), its
            // WHERE read over each resource; off an instance or a handle the
            // run fails as the TypeScript's does.
            Expression::ResourceTraverse { expression_filter, .. } => return self.resource_filter(expression_filter.as_deref()),
            _ => return refuse("block_head_does_not_lower"),
        };
        // Every hop off every path the hop before reached
        // (`walkSourceHeadPaths`), each one's WHERE and ORDER BY scoped at
        // its landing, over the head's own scope.
        steps.iter().try_for_each(|step| match step {
            TraversalStep::Edge(step) => self.hop(step),
            _ => refuse("block_head_step"),
        })
    }

    /// A head rooted at a value (or an expression): one edge hop off each
    /// record it holds — any kind of record, so its WHERE and ORDER BY are
    /// held to what every kind reads.
    fn value_head(&self, head: &PathHead) -> Admitted {
        if let Some(filter) = resources_head_filter(head) {
            return self.resource_filter(filter.as_deref());
        }
        let steps = crate::traverse::head_steps(head).map_err(|_| "block_head_step".to_string())?;
        steps.iter().try_for_each(|step| self.hop(step))
    }

    /// A `_resources` hop's WHERE, read over each resource with it current
    /// (`filterResources`): resource fields, literals and their operators.
    fn resource_filter(&self, filter: Option<&Expression>) -> Admitted {
        filter.map_or(Ok(()), |filter| self.expression(filter))
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
            // The run fails as the TypeScript's does: a node has no bundle.
            Expression::ResourceTraverse { expression_filter, .. } => return self.resource_filter(expression_filter.as_deref()),
            _ => return refuse("block_head_does_not_lower"),
        };
        let Some((TraversalStep::Edge(step), rest)) = steps.split_first() else { return refuse("block_head_step") };
        refuse_meta_edge(&step.edge_type_id)?;
        if let Some(filter) = &step.expression_filter {
            self.scoped(filter)?;
        }
        // Past the node's own edge the walk is the landing's: a node's edge
        // again, or a system's record walked on as a source head walks
        // (`walkNodePlane`), so a later hop is held to both.
        rest.iter().try_for_each(|step| match step {
            TraversalStep::Edge(step) => self.hop(step),
            _ => refuse("block_head_step"),
        })
    }

    /// A head over what an extraction yielded: one hop down one of its
    /// edges, as the TypeScript walks it: a WHERE fails the run as its
    /// `headIterationsFrom` fails it (crate::traverse `extract_paths`, the
    /// same `unsupported`), and an ORDER BY, a LIMIT or a direction is not
    /// read, by either engine.
    fn extract_head(&self, root: &str, head: &PathHead) -> Admitted {
        let probe = format!("{}{}.`__movement_engine_probe__`", crate::write::spell_name(root), head.hops_raw);
        let Ok(tree) = movement_parser::expr::parse_expression(&probe) else { return refuse("block_head_does_not_lower") };
        let Ok(walk) = movement_parser::lowering::lower_expression(&tree, &probe) else { return refuse("block_head_does_not_lower") };
        let steps = match &walk {
            Expression::Traverse { steps, .. } => steps,
            // The content the extraction read, as it stamped it (a file
            // among them carried forward as the very file).
            Expression::ResourceTraverse { expression_filter, .. } => return self.resource_filter(expression_filter.as_deref()),
            _ => return refuse("block_head_does_not_lower"),
        };
        match steps.iter().all(|step| matches!(step, TraversalStep::Edge(_))) {
            true => Ok(()),
            false => refuse("block_head_step"),
        }
    }

    /// `x = <expression>`: a bare name of a record is a second name for it
    /// (`aliasedNodeBinding`), and `FIRST`/`LAST`/`ONLY` of a bare walk the
    /// record it picks (`selectedPositionBinding`), of one hop off a root a
    /// block head walks from.
    fn assigned(&self, slot: &ExprSlot) -> Admitted {
        if let Some(staged) = self.with_nested(slot, &|names, slot| names.assigned(slot)) {
            return staged;
        }
        let expr = lowered(&slot.raw)?;
        if let Expression::Property { property_type_id: name, field_only: false } | Expression::AliasRef { name } = &expr
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
            return steps.iter().try_for_each(|step| match step {
                TraversalStep::Edge(step) => self.hop(step),
                _ => refuse("traversal_step"),
            });
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
    /// the records it holds; off a kept walk, the walk runs on past its head
    /// (`resolveDeferred`), each hop held to what every kind reads.
    fn walk_hops(&self, root: &str, steps: &[TraversalStep]) -> Admitted {
        // Down an extraction, plain hops (`walkExtractSteps`): a WHERE or a
        // hop that is no edge fails the run as the TypeScript's fails it
        // (crate::traverse `walk_extract`, the same `unsupported`, before the
        // WHERE is read); an ORDER BY, a LIMIT or a direction is not read.
        if self.extracts.contains(root) {
            return Ok(());
        }
        steps.iter().try_for_each(|step| match step {
            TraversalStep::Edge(step) => self.hop(step),
            _ => refuse("traversal_step"),
        })
    }

    /// `EXISTS(root…)`: over a value, whether it holds one (or, with hops,
    /// a walk off the records it holds); over anything else, edges — down
    /// an extraction its entities' children, each hop's WHERE, ORDER BY and
    /// LIMIT read there as the TypeScript's `evaluateExists` reads them
    /// (crate::reading `exists`); each hop's WHERE and ORDER BY, and the
    /// final WHERE, scoped at the record reached.
    fn exists(&self, steps: &[TraversalStep], where_: Option<&Expression>) -> Admitted {
        for step in steps {
            let TraversalStep::Edge(step) = step else { return refuse("exists_step") };
            self.hop(step)?;
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

    /// A collection op (crate::collection): its members `concurrency` at a
    /// time (settings this engine does not read are refused by the op's own
    /// reason); its
    /// collection, start and closure body walked, the body as a member's —
    /// its parameters values, which may hold records. A movement handed by
    /// name is walked under every kind a member may be (`Bound::collection`).
    fn collection_op(&self, op: &CollectionOpExpression, reason: &str) -> Admitted {
        let settings_read = if op.op == CollectionOp::Sort { crate::collection::sort_descending(op.config.as_ref()).is_ok() } else { crate::collection::settings(op.config.as_ref()).is_ok() };
        if !settings_read {
            return refuse(reason);
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
                let mut either_values = self.either_values.clone();
                for param in &params {
                    value_holders.remove(param);
                    either_values.remove(param);
                }
                let member = lowered(&op.source.raw).map_or(Holder::Other, |source| member_holder(&source, &|name| self.holder(name)));
                value_holders.extend(closure.params.iter().enumerate().map(|(index, p)| (p.name.clone(), self.member_param_holder(op.op, index, p, member))));
                let member = Names {
                    value_holders: &value_holders,
                    either_values: &either_values,
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
            // A movement or a closure handed by name is called with each
            // member (a REDUCE's accumulator first, what the last call
            // returned): one taking a value, which its body reads as free of
            // records, takes no member or accumulator that may hold one.
            ArmExpression::Ref { name, .. } => {
                let params: Vec<&ast::MovementParam> = match self.callees.movement(name) {
                    Some(movement) => movement.params.iter().collect(),
                    None => self
                        .callees
                        .closure_name(name, self.binds(name))
                        .and_then(|name| self.callees.closure_bodies.get(name))
                        .into_iter()
                        .flatten()
                        .flat_map(|closure| closure.params.iter())
                        .collect(),
                };
                let member = lowered(&op.source.raw).map_or(Holder::Other, |source| member_holder(&source, &|name| self.holder(name)));
                // A member handed to a position parameter: a record known to
                // hold none in a field (`clean_record`).
                if params.iter().any(|p| p.type_.is_some() && !self.callees.takes_value(p))
                    && !(matches!(member, Holder::Free | Holder::Record) && self.record_nodes.is_empty())
                {
                    return refuse("position_arg_record");
                }
                if !params.iter().any(|p| self.callees.takes_value(p)) {
                    return Ok(());
                }
                // From version 5 the checker holds each member, and a
                // REDUCE's start, to the function's typed parameter
                // (MOV_CALL_ARG_TYPE, MOV_CALL_ARG_MAYBE_RECORD), as it holds
                // a plain call's argument: only what the function hands back
                // is left to read here.
                let checked = self.language_version >= 5;
                let returns_free = match self.callees.movement(name) {
                    Some(movement) if movement.params.iter().all(|p| self.callees.takes_value(p)) => {
                        self.callees.returns(movement, &vec![Kind::Value; movement.params.len()], &[]).1 == Holder::Free
                    }
                    Some(_) => false,
                    None => self.closure_holder(name) == Holder::Free,
                };
                let accumulator_free = op.op != CollectionOp::Reduce || ((checked || op.init.as_ref().is_none_or(|init| !self.may_hold_record_slot(init))) && returns_free);
                if (!checked && member != Holder::Free) || !accumulator_free { refuse("call_arg_record") } else { Ok(()) }
            }
        }
    }

    /// `name = <expression>`, or a built-in's call read as the expression it is.
    fn rvalue(&self, value: &RValue) -> Admitted {
        match value {
            RValue::Expr { expr } => self.slot(expr),
            RValue::Call { call } if self.plugin(&call.callee) => self.plugin_call(call),
            RValue::Call { call } if self.calls_closure(&call.callee) => self.closure_call(call),
            RValue::Construct { construct } if self.calls_closure(&construct.callee) => self.closure_call(&construction_as_call(construct)),
            RValue::ExtractCall { extract_call } => self.extract_call(extract_call),
            RValue::Construct { construct } if self.plugin(&construct.callee) => {
                self.plugin_invocation(&construct.callee, construct.args.iter().map(|a| Some(&a.value)))
            }
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
            || spelled(self.movements, String::as_str, &call.callee, folds_case(self.language_version)).is_some();
        if declared {
            return Err("function_call".into());
        }
        match &call.expression {
            Some(expr) if self.positional_values(&call.args) => Ok(expr),
            _ => Err("builtin_call_form".into()),
        }
    }

    /// `readCall`'s reading of a built-in's arguments: values in order,
    /// each call among them read at an argument's position — a function's
    /// (staged as a nested call, whatever its arguments), a built-in that is
    /// no value (read as its expression, which stages it), or a value
    /// built-in whose own arguments read so.
    fn positional_values(&self, args: &[CallArg]) -> bool {
        args.iter().all(|arg| match arg {
            CallArg::Expr { name: None, .. } => true,
            CallArg::Call { name: None, call } => {
                let function = self.binds(&call.callee) || self.plugin(&call.callee) || spelled(self.movements, String::as_str, &call.callee, folds_case(self.language_version)).is_some();
                function
                    || (call.args.iter().all(|arg| arg.name().is_none())
                        && ((crate::nested::is_call_form(&call.callee) && call.expression.is_some()) || self.positional_values(&call.args)))
            }
            _ => false,
        })
    }

    fn plugin(&self, callee: &str) -> bool {
        names_plugin(self.plugins, callee, self.language_version)
    }

    /// A plugin's plain call (crate::plugin): spelled as imported (a callee
    /// in another letter case is the TypeScript's), named value arguments,
    /// an output the slice binds.
    fn plugin_call(&self, call: &CallStatement) -> Admitted {
        match plugin_bind(self.plugin_binds, &call.callee, self.language_version) {
            None | Some(PluginBinds::Unknown) => return refuse("plugin_call"),
            Some(PluginBinds::Value | PluginBinds::Record | PluginBinds::Records | PluginBinds::Nothing) => {}
        }
        // From version 5 its arguments are by position, bound to its
        // parameters as crate::plugin binds them; one that does not fit fails
        // the call before any is read.
        let spec = plugin_import(self.plugin_binds, &call.callee, self.language_version).and_then(|import| import.spec.as_deref());
        let bound = match spec {
            Some(spec) if self.language_version >= 5 && call.args.iter().any(|arg| arg.name().is_none()) => {
                let bound = spec.bind_args(movement_parser::catalog::plugin_args::PluginCallSite::Plain, &call.args);
                if !bound.misfits.is_empty() {
                    return Ok(());
                }
                Some(bound.args)
            }
            _ => None,
        };
        let args = bound.as_deref().unwrap_or(&call.args);
        // A first argument unnamed fails the call before any is read, on
        // either engine; a later unnamed one is skipped.
        if args.first().is_some_and(|arg| arg.name().is_none()) {
            return Ok(());
        }
        for arg in args {
            match arg {
                CallArg::Expr { name: None, .. } | CallArg::Call { name: None, .. } | CallArg::Node { name: None, .. } => {}
                CallArg::Expr { expr, .. } => {
                    self.slot(expr)?;
                    self.plugin_arg(expr)?;
                }
                // The run fails there, on either engine (`unsupported`);
                // nothing after it is read.
                CallArg::Write { .. } | CallArg::Closure { .. } | CallArg::Type { .. } => return Ok(()),
                // A built-in's call is the value it computes; a function's,
                // what it hands back (`evaluateCallArg`): a value, or one
                // record whose fields hold none, which the plugin is handed
                // as its fields (`recordFields`), as a node argument is.
                CallArg::Call { call: inner, .. } if self.callee(&inner.callee).is_some() => {
                    self.call(inner)?;
                    self.plugin_value(self.call_holders.iter().rev().find(|(at, _)| *at == inner.span).map_or(Holder::Other, |(_, held)| *held))?;
                }
                CallArg::Call { call: inner, .. } if self.calls_closure(&inner.callee) => {
                    self.closure_call(inner)?;
                    self.plugin_value(self.closure_holder(&inner.callee))?;
                }
                // A plugin's call runs first (`executePluginCall`): its text,
                // or its record's fields.
                CallArg::Call { call: inner, .. } if self.plugin(&inner.callee) => {
                    self.plugin_call(inner)?;
                    match plugin_bind(self.plugin_binds, &inner.callee, self.language_version) {
                        Some(PluginBinds::Value | PluginBinds::Nothing | PluginBinds::Record) => {}
                        _ => return refuse("plugin_call_form"),
                    }
                }
                CallArg::Call { call: inner, .. } => {
                    let expr = self.builtin_value(inner)?;
                    self.slot(expr)?;
                    self.plugin_arg(expr)?;
                }
                // A node reads as its fields (`recordFields`): one holding a
                // record would hand the binding object over.
                CallArg::Node { node, .. } => {
                    self.node(node, node.graph.is_some())?;
                    let holds_record = node.entries.iter().any(|entry| matches!(entry, NodeEntry::Value { value, .. } if self.may_hold_record_slot(value)));
                    if holds_record || node.spreads.as_ref().is_some_and(|s| !s.is_empty()) {
                        return refuse("plugin_arg_record");
                    }
                }
            }
        }
        Ok(())
    }

    fn plugin_invocation<'a>(&self, callee: &str, args: impl Iterator<Item = Option<&'a ExprSlot>>) -> Admitted {
        match plugin_bind(self.plugin_binds, callee, self.language_version) {
            None | Some(PluginBinds::Unknown) => return refuse("plugin_call"),
            Some(PluginBinds::Value | PluginBinds::Record | PluginBinds::Records | PluginBinds::Nothing) => {}
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
    /// The extraction call (crate::extract::call): its content walked as an
    /// expression; its shape a declaration in scope (or a name bound to one,
    /// from version 3), or one written in place, whose words read the body's
    /// scope and whose base is one in scope; its settings read clean.
    fn extract_call(&self, call: &ast::ExtractCallExpression) -> Admitted {
        match &call.shape {
            ast::ExtractCallShape::Named { name, .. } if self.shape_aliases.contains(name) => {}
            ast::ExtractCallShape::Named { name, .. } if !self.shapes.contains(name) || self.binds_in_body(name) => return refuse("extract_call_shape"),
            // Written in place: a declaration of the calling body's, its words
            // read in the body's scope (walked here as the body's slots), its
            // base one the body sees.
            ast::ExtractCallShape::Inline { declaration, .. } => {
                let based = declaration.extends.as_ref().is_none_or(|base| self.shapes.contains(&base.name) && !self.binds_in_body(&base.name));
                if !based {
                    return refuse("extract_call_shape");
                }
                self.shape_words(&declaration.root)?;
            }
            _ => {}
        }
        if let Some(config) = &call.config {
            // A written model is held to the snapshot's `models` at run time,
            // as the TypeScript holds it (crate::extract::call).
            if crate::extract::call::read_config(config).is_err() {
                return refuse("extract_call_settings");
            }
        }
        self.slot(&call.content)
    }

    fn extract(&self, extract: &ast::ExtractExpression) -> Admitted {
        // A `from` datum is written into the prompt as its value, a record at
        // any depth as its fields (`fieldsValueOf`, extract/prompt.rs), and
        // a record whose fields are not in hand fails the run as the
        // TypeScript's does: every record a `from` datum may hold runs here.
        extract.from.iter().try_for_each(|slot| self.slot(slot))?;
        self.extract_stages(&extract.stages)
    }

    fn extract_stages(&self, stages: &[ast::ExtractStage]) -> Admitted {
        for stage in stages {
            for plugin in stage.through.iter().flatten() {
                if !self.plugins.contains(&plugin.plugin) {
                    return refuse("plugin_call");
                }
                // From version 5 its arguments are by position, bound as
                // crate::extract binds them; one that does not fit fails the
                // stage before any is read.
                let spec = plugin_import(self.plugin_binds, &plugin.plugin, self.language_version).and_then(|import| import.spec.as_deref());
                let bound = match spec {
                    Some(spec) if self.language_version >= 5 && !plugin.positional.is_empty() => {
                        let bound = spec.bind_stage_args(plugin);
                        if !bound.misfits.is_empty() {
                            continue;
                        }
                        Some(bound.args)
                    }
                    // Unbound, a positional argument is read as nothing would read it.
                    _ if !plugin.positional.is_empty() => return refuse("plugin_call_form"),
                    _ => None,
                };
                for arg in bound.as_deref().unwrap_or(&plugin.args) {
                    // A bare name the body binds as a value may name the
                    // entity's field instead, decided at run time; one bound
                    // to a record is handed its fields, as a plain call's is.
                    let bare = crate::js::trim(&arg.value.raw);
                    if crate::js::is_identifier(bare) && !self.holds_other_than_value(bare) {
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
        !id.contains('.')
            && !crate::stdlib::is_flat_builtin(id)
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
            WriteTarget::Tuple { paths, .. } => paths.iter().try_for_each(|path| self.target_path(path, "write", false))?,
            // `write m.k { … }`: the record a map holds, bound for the write
            // alone (run.ts `bindTargetRoots`); a root that is no member
            // path fails, on either engine.
            WriteTarget::Position { root: PathRoot::Expression { expr }, .. } => {
                if crate::write::member_path_binding_name(expr).is_some() {
                    self.assigned(expr)?;
                }
            }
            // The record the name holds, updated in place (a write's
            // handle moved on to it from version 4); anything else fails as
            // the TypeScript's `executePositionWrite` fails it.
            WriteTarget::Position { root: PathRoot::Name { .. }, .. } => {}
            // A linked write may be a shape write (`target_path`).
            WriteTarget::Linked { path, .. } => self.target_path(path, "write", true)?,
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
    /// `shape_write`: a linked write's, which a declared shape may root.
    fn target_path(&self, path: &PathHead, verb: &str, shape_write: bool) -> Admitted {
        let bound;
        let root = match &path.root {
            Some(PathRoot::Name { name }) => name,
            // A member path's record, bound for the write alone (run.ts
            // `bindTargetRoots`).
            Some(PathRoot::Expression { expr }) if crate::write::member_path_binding_name(expr).is_some() => {
                self.assigned(expr)?;
                bound = crate::write::member_path_binding_name(expr).unwrap_or_default();
                &bound
            }
            _ => return refuse(format!("{verb}_root_expression")),
        };
        // Rooted at any name: the record it holds parents the write (or the
        // engine is the adapter, into a node the run built), and anything
        // else fails as the TypeScript's `linkedPathGraph` fails it. A
        // declared shape's name is a shape write: an in-memory position of
        // its type (`materializeShapeWrite`), its fields held to what a
        // system's write takes; a match against one is not made.
        if self.shapes.contains(root) && !self.binds_in_body(root) && !shape_write {
            return refuse(format!("{verb}_root_not_held"));
        }
        match edge_shape(path) {
            EdgeShape::One { edge, .. } if is_meta_edge(&edge) => refuse("traversal_meta_edge"),
            EdgeShape::One { where_: Some(where_), .. } => self.scoped(&where_.filter),
            EdgeShape::One { where_: None, .. } => Ok(()),
            // More (or less) than one edge: the run fails where the
            // TypeScript's `singleWriteEdge` fails it (crate::write
            // `single_edge`, the same `unsupported`), after what came before.
            EdgeShape::MultiHop => Ok(()),
            // A path the lowering cannot read: the checker refuses it, so no
            // checked program reaches this.
            EdgeShape::Invalid(_) => refuse(format!("{verb}_multi_hop")),
        }
    }

    /// `match <target> { unique by (…) … }` (crate::verbs): a linked target in
    /// a system, keyed `unique by` clauses, field values the evaluator runs.
    fn match_(&self, m: &ast::MatchExpression) -> Admitted {
        match &m.target {
            WriteTarget::Linked { path, .. } => self.target_path(path, "match", false)?,
            // One record at the convergence of its paths, each a linked
            // match's (`resolveTupleWriteTarget` under the verb `match`).
            WriteTarget::Tuple { paths, .. } => paths.iter().try_for_each(|path| self.target_path(path, "match", false))?,
            // The parser refuses a match of a bare alias; a member path's
            // root is bound for the match alone, and either fails as the
            // TypeScript's `resolveWriteTarget` fails it (crate::write).
            WriteTarget::Position { root: PathRoot::Expression { expr }, .. } => {
                if crate::write::member_path_binding_name(expr).is_some() {
                    self.assigned(expr)?;
                }
            }
            WriteTarget::Position { root: PathRoot::Name { .. }, .. } => {}
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
        // A spread of a record is copied by the checker's plan, read off the
        // record as it is (the event's source position too); `...m.k` reads
        // what `m` holds under each key in turn, a map's key or a record's
        // field, bound as `x = m.k` binds it (crate::node
        // `spread_source_binding`); anything else copies nothing, or fails
        // the run as the TypeScript's `spreadMap` and `spreadRecord` fail it.
        // A map holding a record anywhere fails the run as the TypeScript's
        // `spreadIntoGraph` fails it (`holdsRecord`, before the record's key
        // is filed): crate::node `spread_into_graph`.
        for entry in &literal.entries {
            match entry {
                NodeEntry::Value { value, .. } => {
                    // In a graph the event is a record like any other: held
                    // on the edge as its source position (`referencedRecords`).
                    let bare = crate::js::trim(&value.raw);
                    if graph && (records(bare) || self.events.contains(bare)) {
                        continue;
                    }
                    if self.events.contains(bare) {
                        return refuse("node_event_entry");
                    }
                    // `owner: ONLY(msg-[:files]->)` in a graph: the record the
                    // pick lands on, held on the edge as a binding of it is
                    // (`referencedRecords` over `bindSlotValue`).
                    if graph && lowered(&value.raw).is_ok_and(|expr| selection(&expr).is_some()) {
                        self.assigned(value)?;
                        continue;
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
        let (mut extracts, mut members, mut landings) = (self.extracts.clone(), self.members.clone(), self.landings.clone());
        landings.extend(crate::traverse::resources_alias(&head.hops_raw));
        for alias in crate::traverse::head_steps(head).unwrap_or_default().into_iter().filter_map(|step| step.alias) {
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
        if let Some(staged) = self.with_nested(slot, &|names, slot| names.expression(&lowered(&slot.raw)?)) {
            return staged;
        }
        self.expression(&lowered(&slot.raw)?)
    }

    /// A function a nested call names (crate::nested `runsAsCall`): one of
    /// the program's, or a plugin.
    fn nested_function(&self, name: &str) -> bool {
        self.callee(name).is_some() || self.calls_closure(name) || self.value_callee(name) || self.plugin(name)
    }

    /// A slot holding nested calls (crate::nested): each nested call walked
    /// as the right-hand side it is read as — a closure's call, a plugin's,
    /// an extraction call (a movement's is refused: its body is walked only
    /// under the calls statements make, `nested_movement_call`; a
    /// collection op too, which a park inside could not be resumed into,
    /// `expression_closure`) — each operand bound before it as an
    /// expression, and `then` handed the text that reads the names they are
    /// bound to, with those names values that may hold anything.
    fn with_nested(&self, slot: &ExprSlot, then: &dyn Fn(&Names<'_>, &ExprSlot) -> Admitted) -> Option<Admitted> {
        if self.language_version < 3 {
            return None;
        }
        let tree = movement_parser::expr::parse_expression(&slot.raw).ok()?;
        let runs = |call: &movement_parser::tree::MExpr| match call {
            movement_parser::tree::MExpr::Call { callee, .. } => match callee.as_ref() {
                movement_parser::tree::MExpr::Name { name, .. } => {
                    self.nested_function(&name.text) || (!self.binds_any_case(&name.text) && crate::nested::is_call_form(&name.text))
                }
                member => {
                    package_member_written(member).is_some_and(|written| self.plugin(&written))
                        || callee_written(member).is_some_and(|written| self.value_callee(&written))
                }
            },
            _ => false,
        };
        let calls = crate::nested::staged_calls(&tree, &runs);
        if calls.is_empty() {
            return None;
        }
        Some(self.admit_staged(slot, &tree, &calls, then))
    }

    fn admit_staged(&self, slot: &ExprSlot, tree: &movement_parser::tree::MExpr, calls: &[movement_parser::tree::At], then: &dyn Fn(&Names<'_>, &ExprSlot) -> Admitted) -> Admitted {
        let units = movement_parser::util::utf16::Utf16::new(&slot.raw);
        let mut plan = NestedPlan::default();
        let text = self.plan_nested(tree, calls, &units, &mut plan);
        for at in &plan.calls {
            let Ok(value) = crate::nested::nested_call(slot, *at, self.language_version) else { return refuse("nested_call_form") };
            self.nested_value(&value)?;
        }
        let values: BTreeSet<String> = self.values.iter().cloned().chain(plan.names.iter().map(|(n, _)| n.clone())).collect();
        let mut value_holders = self.value_holders.clone();
        value_holders.extend(plan.names.iter().cloned());
        let inner = Names { values: &values, value_holders: &value_holders, instances: self.instances.clone(), ..*self };
        let piece = |raw: &str| ExprSlot { raw: raw.to_string(), span: slot.span, eager: false };
        for bound in &plan.bound {
            inner.assigned(&piece(bound))?;
        }
        then(&inner, &piece(&text))
    }

    /// `stageTree`'s shape, statically (`plan_nested`).
    fn plan_nested(&self, tree: &movement_parser::tree::MExpr, calls: &[movement_parser::tree::At], units: &movement_parser::util::utf16::Utf16, plan: &mut NestedPlan) -> String {
        plan_nested(
            tree,
            calls,
            units,
            plan,
            &|callee| !self.binds_any_case(callee) && crate::js::to_upper_case(callee) == "COALESCE",
            &|callee, text| match self.callees.closure_name(callee, self.binds(callee)).and_then(|name| self.closure_holders.get(name)) {
                Some(held) if self.calls_closure(callee) => *held,
                _ if self.value_callee(callee) => self.callees.value_call_holder(),
                _ if self.callee(callee).is_some() => nested_holder(self.nested_holders, text),
                // A collection op: what the collector read it to hand back.
                _ if is_collection_form(callee) && !self.binds_any_case(callee) && !self.nested_function(callee) => nested_holder(self.nested_holders, text),
                _ if self.nested_function(callee) || self.binds_any_case(callee) || !staged_as_value(callee) => nested_call_holder(callee, plugin_bind(self.plugin_binds, callee, self.language_version)),
                _ => self.text_holder(text),
            },
            &|name| self.holder(name),
        )
    }

    /// What an expression's value holds, its nested calls read as what
    /// each hands back.
    fn text_holder(&self, raw: &str) -> Holder {
        let nested = self.nested_text(raw);
        let names = nested.as_ref().map_or(&[][..], |(_, plan)| plan.names.as_slice());
        let holder = |name: &str| match names.iter().find(|(n, _)| n == name) {
            Some((_, held)) => *held,
            None => self.holder(name),
        };
        lowered(nested.as_ref().map_or(raw, |(text, _)| text.as_str())).map_or(Holder::Other, |expr| value_holder(&expr, &holder))
    }

    /// One nested call's right-hand side.
    fn nested_value(&self, value: &RValue) -> Admitted {
        let RValue::Call { call } = value else {
            return match value {
                RValue::ExtractCall { extract_call } => self.extract_call(extract_call),
                _ => refuse("nested_call_form"),
            };
        };
        // A collection op or `MEMBERS`: a park inside a member could not be
        // resumed into (its frame names the op by its span in the
        // expression).
        if crate::nested::is_call_form(&call.callee) && !self.nested_function(&call.callee) {
            return match self.reading(call)? {
                Some(reading) => self.reading_admitted(&reading, "expression_closure"),
                None => refuse("expression_closure"),
            };
        }
        if self.callee(&call.callee).is_some() {
            if self.unknown_calls.contains(&call.span) {
                return refuse("nested_movement_call");
            }
            return self.call(call);
        }
        if self.calls_closure(&call.callee) {
            return self.closure_call(call);
        }
        if self.value_callee(&call.callee) {
            return self.value_call(call);
        }
        if self.plugin(&call.callee) {
            return self.plugin_call(call);
        }
        // A built-in whose value a member access reads, bound first: the
        // expression it reads as.
        if !crate::nested::is_call_form(&call.callee) && !self.binds_any_case(&call.callee) {
            return self.assigned(self.builtin_value(call)?);
        }
        refuse("expression_closure")
    }

    /// A slot's text with its nested calls read as the names they are bound
    /// to (`plan_nested`), when it holds any.
    fn nested_text(&self, raw: &str) -> Option<(String, NestedPlan)> {
        if self.language_version < 3 {
            return None;
        }
        let tree = movement_parser::expr::parse_expression(raw).ok()?;
        let runs = |call: &movement_parser::tree::MExpr| match call {
            movement_parser::tree::MExpr::Call { callee, .. } => match callee.as_ref() {
                movement_parser::tree::MExpr::Name { name, .. } => {
                    self.nested_function(&name.text) || (!self.binds_any_case(&name.text) && crate::nested::is_call_form(&name.text))
                }
                member => {
                    package_member_written(member).is_some_and(|written| self.plugin(&written))
                        || callee_written(member).is_some_and(|written| self.value_callee(&written))
                }
            },
            _ => false,
        };
        let calls = crate::nested::staged_calls(&tree, &runs);
        if calls.is_empty() {
            return None;
        }
        let units = movement_parser::util::utf16::Utf16::new(raw);
        let mut plan = NestedPlan::default();
        let text = self.plan_nested(&tree, &calls, &units, &mut plan);
        Some((text, plan))
    }

    fn condition(&self, slot: &ExprSlot) -> Admitted {
        if let Ok(tree) = movement_parser::expr::parse_expression(&slot.raw)
            && self.with_nested(slot, &|_, _| Ok(())).is_some()
        {
            // `evaluateStagedCondition`: each top-level conjunct staged on
            // its own, then read as a condition.
            let units = movement_parser::util::utf16::Utf16::new(&slot.raw);
            for conjunct in crate::nested::conjuncts_of(&tree) {
                let part = ExprSlot { raw: units.text(conjunct.at().start, conjunct.at().end), span: slot.span, eager: false };
                match self.with_nested(&part, &|names, staged| names.plain_condition(staged)) {
                    Some(admitted) => admitted?,
                    None => self.plain_condition(&part)?,
                }
            }
            return Ok(());
        }
        self.plain_condition(slot)
    }

    fn plain_condition(&self, slot: &ExprSlot) -> Admitted {
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
            // A record a system describes (the event, a handle, a landed
            // record), the subject or one a graph literal's entries hold, is
            // compared by its record type's schema, with the checker's
            // assignability (`check.compatible`, crate::is_test).
            MovementCondition::IsTest { .. } => Ok(()),
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
            Expression::Traverse { alias_root: Some(_), steps, expression } if steps.is_empty() && matches!(expression.as_ref(), Expression::Exists { .. }) => {
                let Expression::Exists { steps, where_ } = expression.as_ref() else { unreachable!("matched above") };
                self.exists(steps, where_.as_deref())
            }
            // A rootless `EXISTS(-[…]->)`: inside a hop's WHERE, a walk off
            // the landed record (an extraction's entity, or a system's
            // record walked through the run's source, `evaluateExists`);
            // anywhere else the run fails as the TypeScript's evaluator
            // fails it (`unsupported`, crate::eval).
            Expression::Exists { steps, where_ } if scoped => self.exists(steps, where_.as_deref()),
            Expression::Exists { .. } => Ok(()),
            // A resource's field: the current resource's (a `_resources`
            // WHERE), null outside one, as the TypeScript's evaluator reads.
            Expression::Resource { .. } => Ok(()),
            // A kind the TypeScript's evaluator has no case for (the retired
            // `KG_VALUE` / `KG_EXISTS`, which the checker passes): the run
            // fails as it fails it, before any part is read (`unsupported`,
            // crate::eval).
            other if crate::eval::has_no_typescript_case(other) => Ok(()),
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
            // A walk with no root (`-[:a]->.b`, or a resource walk past a hop,
            // whose root the lowering drops): the run fails as the
            // TypeScript's evaluator fails it (`unsupported`, crate::eval).
            Expression::Traverse { alias_root: None, .. } => Ok(()),
            // `-0` runs: this engine lowers the program itself, so the
            // literal is never JSON (a host request carries it as JSON
            // writes it, `0`, as the TypeScript's does). No literal reads as
            // a non-finite number (`1e400` does not parse).
            Expression::Static { value: StaticValue::Number(n) } => {
                if n.0.is_finite() { Ok(()) } else { refuse("static_number") }
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
                ObjectMember::Entry { value, .. } => self.walk(value, scoped),
                ObjectMember::Spread(spread) => self.walk(&spread.expression, scoped),
            }),
            Expression::Concat { parts } => each(parts),
            Expression::Conditional { condition, then, else_ } => {
                self.walk(condition, scoped)?;
                self.walk(then, scoped)?;
                self.walk(else_, scoped)
            }
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
                let fails = fn_ == "error" && movement_parser::version::since(self.language_version, 5);
                if !fails && !FUNCTIONS.contains(&fn_.as_str()) && !self.integration_function(fn_) {
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
        // engines before any request is made. A function's name read as a
        // value (language version 5) is the function, free of records.
        if self.language_version >= 5 && self.movements.contains(name) {
            return Holder::Free;
        }
        if self.file_names.contains(name) { Holder::Other } else { Holder::Free }
    }

    /// Whether a slot's value may hold a record (one it does not lower to
    /// is refused where it is walked).
    /// What a collection op's function parameter holds in its body: the
    /// member (or a REDUCE's accumulator) as the source holds it, but from
    /// version 5 a typed value parameter's is free of records, the checker
    /// holding each member and the start to it (MOV_CALL_ARG_TYPE,
    /// MOV_CALL_ARG_MAYBE_RECORD).
    fn member_param_holder(&self, op: CollectionOp, index: usize, param: &ast::MovementParam, member: Holder) -> Holder {
        if self.language_version >= 5 && self.callees.takes_value(param) { Holder::Free } else { param_holder(op, index, member) }
    }

    fn may_hold_record_slot(&self, slot: &ExprSlot) -> bool {
        // A nested call's value may be anything.
        let nested = self.nested_text(&slot.raw);
        let names = nested.as_ref().map_or(&[][..], |(_, plan)| plan.names.as_slice());
        let holder = |name: &str| match names.iter().find(|(n, _)| n == name) {
            Some((_, held)) => *held,
            None => self.holder(name),
        };
        lowered(nested.as_ref().map_or(&slot.raw, |(text, _)| text)).map_or(true, |expr| may_hold_record(&expr, &holder))
    }

    /// A plugin's argument: one record reads as its fields
    /// (`recordFields`); a record anywhere inside a list or a map is handed
    /// to the plugin as the binding object itself, which this engine's
    /// wire does not carry.
    fn plugin_arg(&self, slot: &ExprSlot) -> Admitted {
        if self.nested_text(&slot.raw).is_some() {
            return if self.may_hold_record_slot(slot) { refuse("plugin_arg_record") } else { Ok(()) };
        }
        let Ok(expr) = lowered(&slot.raw) else { return Ok(()) };
        let one_record = match &expr {
            Expression::AliasRef { name } | Expression::Property { property_type_id: name, field_only: false } if !self.values.contains(name) => !self.lazies.contains(name),
            other => selection(other).is_some() || value_holder(other, &|name| self.holder(name)) == Holder::Record,
        };
        if !one_record && may_hold_record(&expr, &|name| self.holder(name)) { refuse("plugin_arg_record") } else { Ok(()) }
    }

    /// A bare name bound to something that is not a value.
    fn bound_non_value(&self, expr: &Expression) -> bool {
        let (Expression::Property { property_type_id: name, field_only: false } | Expression::AliasRef { name }) = expr else { return false };
        !self.values.contains(name) && (self.is_record(name) || self.instances.contains(name))
    }

    /// `case 'aggregate'`: the folds over a value, a walk read for a field,
    /// or (`COUNT`) the records a walk lands on.
    fn aggregate(&self, fn_: AggregationFunction, inner: &Expression, order_by: Option<&Expression>, scoped: bool) -> Admitted {
        match fn_ {
            AggregationFunction::Llm => refuse("aggregate:llm"),
            // ONLY's failure spells its expression back; a name is what it spells.
            // A walk read as its records keeps its own readings (a binding's
            // whole right-hand side, `selection`); anywhere else it is refused.
            AggregationFunction::Only if crate::formula::spell(inner).is_none() || crate::eval::is_records_walk(inner) => refuse("aggregate:only"),
            // The key is read in each member's own scope (`memberScope`).
            AggregationFunction::Sort => {
                if let Some(key) = order_by {
                    self.walk(key, true)?;
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
    /// A list whose members are each free of records or a map as `Map`
    /// says (what a MAP returning `{ k: co }` hands back): a member read as
    /// that map.
    Rows { depth: u8, lists: bool },
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
            (Holder::Rows { depth: a, lists: x }, Holder::Rows { depth: b, lists: y }) => Holder::Rows { depth: a.max(b), lists: x || y || a != b },
            (Holder::Free, wide @ (Holder::Map { .. } | Holder::List | Holder::Rows { .. })) | (wide @ (Holder::Map { .. } | Holder::List | Holder::Rows { .. }), Holder::Free) => wide,
            _ => Holder::Other,
        }
    }
}

/// Two returns' holders widened to what either may hand back: free of
/// records, one record whose fields are, or anything.
fn returned_join(a: Holder, b: Holder) -> Holder {
    match (a, b) {
        (Holder::Free, Holder::Free) => Holder::Free,
        (Holder::Free | Holder::Record, Holder::Free | Holder::Record) => Holder::Record,
        (Holder::Free | Holder::Map { .. }, Holder::Free | Holder::Map { .. }) => a.join(b),
        _ => Holder::Other,
    }
}

/// What each member of the list `expr` holds (a collection op's
/// parameter): free of records, one record whose fields are, or anything.
fn member_holder(expr: &Expression, holder: &dyn Fn(&str) -> Holder) -> Holder {
    if !may_hold_record(expr, holder) {
        return Holder::Free;
    }
    let one = |e: &Expression| match e {
        Expression::AliasRef { name } | Expression::Property { property_type_id: name, field_only: false } => holder(name) == Holder::Record,
        other => !may_hold_record(other, holder),
    };
    match expr {
        Expression::AliasRef { name } | Expression::Property { property_type_id: name, field_only: false } if matches!(holder(name), Holder::List | Holder::Map { depth: 1, .. }) => Holder::Record,
        Expression::AliasRef { name } | Expression::Property { property_type_id: name, field_only: false } if let Holder::Rows { depth, lists } = holder(name) => Holder::Map { depth, lists },
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
        && let picked @ (Holder::Record | Holder::Map { .. }) = member_holder(expression, holder)
    {
        return picked;
    }
    if let Expression::AliasRef { name } | Expression::Property { property_type_id: name, field_only: false } = expr {
        return match holder(name) {
            wide @ (Holder::Map { .. } | Holder::List | Holder::Rows { .. } | Holder::Record) => wide,
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

/// What a COALESCE or an IF hands back where each operand it may hand back
/// is free of records or one record whose fields hold none: such a record or
/// data, widened as `returned_join` widens two returns. The checker types it
/// the union of the two (B15). `None` for any other expression.
fn either_holder(expr: &Expression, holder: &dyn Fn(&str) -> Holder) -> Option<Holder> {
    let operands: Vec<&Expression> = match expr {
        Expression::Conditional { then, else_, .. } => vec![then.as_ref(), else_.as_ref()],
        Expression::Function { fn_, args } if fn_ == "coalesce" => args.iter().collect(),
        _ => return None,
    };
    operands
        .into_iter()
        .map(|operand| either_holder(operand, holder).unwrap_or_else(|| value_holder(operand, holder)))
        .try_fold(Holder::Free, |held, one| match returned_join(held, one) {
            joined @ (Holder::Free | Holder::Record) => Some(joined),
            _ => None,
        })
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
            Holder::Rows { .. } | Holder::Other => return None,
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
        Expression::AliasRef { name } | Expression::Property { property_type_id: name, .. } => holder(name) != Holder::Free,
        Expression::Traverse { expression, .. } if matches!(expression.as_ref(), Expression::Exists { .. }) => false,
        // A field read, or a walk read for a field: the root's fields; a
        // map's member, or a field read off one.
        Expression::Traverse { alias_root: Some(root), steps, expression } if field_read(expression) => match holder(root) {
            Holder::Free | Holder::Record => false,
            Holder::Map { depth, .. } => !steps.is_empty() || read_depth(expression) <= usize::from(depth),
            Holder::List => !steps.is_empty(),
            Holder::Rows { .. } | Holder::Other => true,
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
            // `...c` of one record copies its fields (`spreadKeysOf`: its
            // dot plane, an edge is a walk), which hold none.
            ObjectMember::Spread(spread) => match spread.expression.as_ref() {
                Expression::AliasRef { name } | Expression::Property { property_type_id: name, field_only: false } if !scoped && holder(name) == Holder::Record => false,
                other => at(other),
            },
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
        Expression::Property { property_type_id, .. } => property_type_id != movement_parser::lowering::POSITION_SENTINEL,
        Expression::EdgeProperty { .. } => true,
        Expression::Traverse { alias_root: Some(_), expression, .. } => field_read(expression),
        _ => false,
    }
}

/// The names a staging binds (crate::nested), which no author can write.
const NESTED_PREFIX: &str = "#nested ";

/// What a slot's nested calls are bound to, in the order they are settled
/// (`Names::plan_nested`).
#[derive(Default)]
struct NestedPlan {
    /// The nested calls, by where they are written.
    calls: Vec<movement_parser::tree::At>,
    /// The operands bound before the last nested call, as the text each is
    /// read as.
    bound: Vec<String>,
    /// Every name bound, with what it holds.
    names: Vec<(String, Holder)>,
}

impl NestedPlan {
    /// What a settled part's text holds, its names read as what they hold.
    fn holder_of(&self, text: &str, outer: &dyn Fn(&str) -> Holder) -> Holder {
        let holder = |name: &str| self.names.iter().find(|(n, _)| n == name).map_or_else(|| outer(name), |(_, held)| *held);
        lowered(text).map_or(Holder::Other, |expr| value_holder(&expr, &holder))
    }

    fn name(&mut self, holder: Holder) -> String {
        let name = format!("{NESTED_PREFIX}{}", self.names.len() + 1);
        self.names.push((name.clone(), holder));
        name
    }
}

/// `stageTree`'s shape, statically: what each settled part is bound to,
/// and the text that reads those names.
fn plan_nested(
    tree: &movement_parser::tree::MExpr,
    calls: &[movement_parser::tree::At],
    units: &movement_parser::util::utf16::Utf16,
    plan: &mut NestedPlan,
    is_coalesce: &dyn Fn(&str) -> bool,
    call_holder: &dyn Fn(&str, &str) -> Holder,
    outer: &dyn Fn(&str) -> Holder,
) -> String {
    use crate::nested::{ShortCircuit, holds, rewritten, short_circuit_of, spelled, value_children};
    let at = tree.at();
    if !holds(tree, calls) {
        return units.text(at.start, at.end);
    }
    if matches!(tree, movement_parser::tree::MExpr::Call { .. }) && calls.contains(&at) {
        plan.calls.push(at);
        let held = match tree {
            movement_parser::tree::MExpr::Call { callee, .. } => match callee_written(callee).or_else(|| package_member_written(callee)) {
                Some(written) => call_holder(&written, &units.text(at.start, at.end)),
                None => Holder::Other,
            },
            _ => Holder::Other,
        };
        return spelled(&plan.name(held));
    }
    if let Some(short) = short_circuit_of(tree, is_coalesce) {
        let operands: Vec<&movement_parser::tree::MExpr> = match &short {
            ShortCircuit::And(a, b) | ShortCircuit::Or(a, b) => vec![*a, *b],
            ShortCircuit::If(c, t, e) => [Some(*c), Some(*t), *e].into_iter().flatten().collect(),
            ShortCircuit::Coalesce(args) => args.clone(),
        };
        // What the short circuit hands back: AND and OR a flag; IF the arm
        // it takes; COALESCE the first of its operands present — free of
        // records only where each it may hand back is (the checker does not
        // see a record through COALESCE, so neither is trusted here).
        let passed: Vec<bool> = match &short {
            ShortCircuit::And(..) | ShortCircuit::Or(..) => vec![false; operands.len()],
            ShortCircuit::If(..) => (0..operands.len()).map(|i| i > 0).collect(),
            ShortCircuit::Coalesce(_) => vec![true; operands.len()],
        };
        let mut free = true;
        for (operand, passed) in operands.into_iter().zip(passed) {
            let text = plan_nested(operand, calls, units, plan, is_coalesce, call_holder, outer);
            if passed {
                free &= plan.holder_of(&text, outer) == Holder::Free;
            }
            plan.bound.push(text);
        }
        return spelled(&plan.name(if free { Holder::Free } else { Holder::Other }));
    }
    let operands = value_children(tree);
    let Some(last) = operands.iter().rposition(|operand| holds(operand, calls)) else { return units.text(at.start, at.end) };
    let mut replaced = Vec::new();
    for operand in &operands[..=last] {
        let text = plan_nested(operand, calls, units, plan, is_coalesce, call_holder, outer);
        let held = plan.holder_of(&text, outer);
        plan.bound.push(text);
        replaced.push((operand.at(), spelled(&plan.name(held))));
    }
    rewritten(units, at, replaced)
}


/// The callee a call in an expression names: a name, or (language version
/// 5) a member of a value written `box.g`, as the statement grammar spells
/// it.
fn callee_written(callee: &movement_parser::tree::MExpr) -> Option<String> {
    use movement_parser::tree::MExpr;
    match callee {
        MExpr::Name { name, .. } => Some(name.text.clone()),
        _ => None,
    }
}

/// `web.fetchUrl` where an expression calls it (language version 5): the
/// one dotted name a package import binds its member to, which only a plugin
/// bind answers for.
fn package_member_written(callee: &movement_parser::tree::MExpr) -> Option<String> {
    use movement_parser::tree::MExpr;
    let MExpr::Member { object, property, .. } = callee else { return None };
    let MExpr::Name { name, .. } = object.as_ref() else { return None };
    (!name.quoted && !property.quoted).then(|| movement_parser::catalog::packages::member_local(&name.text, &property.text))
}

/// A slot's text with its nested calls (crate::nested) read as the names
/// they are bound to: calls of a function `is_function` names, or of a
/// built-in that is no value; `None` when it holds none.
/// What a nested call's value holds, by what it calls: an extraction's
/// records, a plugin's declared output, anything for a function (a
/// closure's is read off its returns, `Bound::closure_call_holder`).
/// Whether a staged call of `callee` is a built-in whose value a member
/// access reads (crate::nested `member_read_calls`), bound as the
/// expression it reads as: no extraction call and no collection op.
/// The expression slots a statement holds itself, not those of a body it
/// holds (a block's, an arm's, a closure's: walked where they are entered).
pub(crate) fn direct_slots(statement: &impl serde::Serialize) -> Vec<ExprSlot> {
    fn loc(json: &serde_json::Value) -> Option<ast::Loc> {
        Some(ast::Loc { line: json.get("line")?.as_u64()? as usize, col: json.get("col")?.as_u64()? as usize })
    }
    fn walk(json: &serde_json::Value, into: &mut Vec<ExprSlot>) {
        match json {
            serde_json::Value::Object(object) => {
                if let (Some(serde_json::Value::String(raw)), Some(span)) = (object.get("raw"), object.get("span"))
                    && let (Some(start), Some(end)) = (span.get("start").and_then(loc), span.get("end").and_then(loc))
                {
                    into.push(ExprSlot::plain(raw.clone(), ast::Span { start, end }));
                    return;
                }
                for (key, value) in object {
                    if key != "body" && key != "closure" {
                        walk(value, into);
                    }
                }
            }
            serde_json::Value::Array(items) => items.iter().for_each(|item| walk(item, into)),
            _ => {}
        }
    }
    let mut slots = Vec::new();
    if let Ok(json) = serde_json::to_value(statement) {
        walk(&json, &mut slots);
    }
    slots
}

/// The calls a statement holds itself (as `direct_slots` reads it) that
/// carry their reading as one expression, a positional call's: each by its
/// callee and the span its call and its expression share.
fn call_readings(statement: &impl serde::Serialize) -> Vec<(String, ast::Span)> {
    fn walk(json: &serde_json::Value, into: &mut Vec<(String, ast::Span)>) {
        match json {
            serde_json::Value::Object(object) => {
                if object.get("kind").and_then(|k| k.as_str()) == Some("call")
                    && let (Some(serde_json::Value::String(callee)), Some(expression)) = (object.get("callee"), object.get("expression"))
                    && let Ok(slot) = serde_json::from_value::<ExprSlot>(expression.clone())
                {
                    into.push((callee.clone(), slot.span));
                }
                for (key, value) in object {
                    if key != "body" && key != "closure" {
                        walk(value, into);
                    }
                }
            }
            serde_json::Value::Array(items) => items.iter().for_each(|item| walk(item, into)),
            _ => {}
        }
    }
    let mut readings = Vec::new();
    if let Ok(json) = serde_json::to_value(statement) {
        walk(&json, &mut readings);
    }
    readings
}

/// Whether a built-in's name is a collection op's (or `MEMBERS`): a call
/// form that is no extraction.
fn is_collection_form(callee: &str) -> bool {
    crate::nested::is_call_form(callee) && !matches!(crate::js::to_upper_case(callee).as_str(), "EXTRACT" | "EXTRACTONE")
}

fn staged_as_value(callee: &str) -> bool {
    !matches!(crate::js::to_upper_case(callee).as_str(), "EXTRACT" | "EXTRACTONE") && !crate::nested::is_call_form(callee)
}

/// What a nested movement call or collection op written as `text` hands
/// back (`Bound::nested_holders`); anything where it was not followed.
fn nested_holder(holders: &[(String, Holder)], text: &str) -> Holder {
    holders.iter().find(|(t, _)| t == text).map_or(Holder::Other, |(_, held)| *held)
}

fn nested_call_holder(callee: &str, plugin: Option<PluginBinds>) -> Holder {
    match crate::js::to_upper_case(callee).as_str() {
        "EXTRACT" => return Holder::List,
        "EXTRACTONE" => return Holder::Record,
        _ => {}
    }
    match plugin {
        Some(PluginBinds::Value) => Holder::Free,
        Some(PluginBinds::Record) => Holder::Record,
        Some(PluginBinds::Records) => Holder::List,
        _ => Holder::Other,
    }
}

fn nested_rewrite(raw: &str, is_function: &dyn Fn(&str) -> bool, call_holder: &dyn Fn(&str, &str) -> Holder, outer: &dyn Fn(&str) -> Holder) -> Option<(String, NestedPlan)> {
    let tree = movement_parser::expr::parse_expression(raw).ok()?;
    let runs = |call: &movement_parser::tree::MExpr| match call {
        movement_parser::tree::MExpr::Call { callee, .. } => match callee.as_ref() {
            movement_parser::tree::MExpr::Name { name, .. } => is_function(&name.text) || crate::nested::is_call_form(&name.text),
            member => callee_written(member).or_else(|| package_member_written(member)).is_some_and(|written| is_function(&written)),
        },
        _ => false,
    };
    let calls = crate::nested::staged_calls(&tree, &runs);
    if calls.is_empty() {
        return None;
    }
    let units = movement_parser::util::utf16::Utf16::new(raw);
    let mut plan = NestedPlan::default();
    let text = plan_nested(
        &tree,
        &calls,
        &units,
        &mut plan,
        &|callee| crate::js::to_upper_case(callee) == "COALESCE",
        call_holder,
        outer,
    );
    Some((text, plan))
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
    spelled(plugins, String::as_str, callee, language_version >= 3).is_some()
}

/// Whether a call's name is read in any letter case: under versions 3 and 4;
/// from 5 letter case counts (design §4.1).
fn folds_case(language_version: u32) -> bool {
    (3..5).contains(&language_version)
}

/// `resolveCallee`'s lookup, the one every name a call resolves goes
/// through: the item named as written, else, where names read in any letter
/// case (`any_case`: from version 3, and where the calling scope binds
/// nothing under the name as written), the first named so in another case.
fn spelled<'a, T: ?Sized + 'a, I>(items: I, name_of: impl Fn(&T) -> &str, written: &str, any_case: bool) -> Option<&'a T>
where
    I: IntoIterator<Item = &'a T> + Clone,
{
    items.clone().into_iter().find(|item| name_of(item) == written).or_else(|| {
        let folded = crate::js::to_lower_case(written);
        any_case.then(|| items.into_iter().find(|item| crate::js::to_lower_case(name_of(item)) == folded)).flatten()
    })
}

/// What a call of the plugin `callee` resolves to binds (`resolveCallee`):
/// the plugin imported as written, or from version 3 the one imported in
/// another letter case.
fn plugin_bind(binds: &BTreeMap<String, PluginImport>, callee: &str, language_version: u32) -> Option<PluginBinds> {
    plugin_import(binds, callee, language_version).map(|import| import.binds)
}

fn plugin_import<'b>(binds: &'b BTreeMap<String, PluginImport>, callee: &str, language_version: u32) -> Option<&'b PluginImport> {
    spelled(binds.keys(), String::as_str, callee, language_version >= 3).and_then(|name| binds.get(name))
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

/// A head whose one hop is `-[…:_resources …]->`: its WHERE.
fn resources_head_filter(head: &PathHead) -> Option<Option<Box<Expression>>> {
    let root = match &head.root {
        Some(PathRoot::Name { name }) => crate::write::spell_name(name),
        _ => "__movement_expression_root__".into(),
    };
    let probe = format!("{root}{}.`__movement_engine_probe__`", head.hops_raw);
    let tree = movement_parser::expr::parse_expression(&probe).ok()?;
    match movement_parser::lowering::lower_expression(&tree, &probe).ok()? {
        Expression::ResourceTraverse { expression_filter, .. } => Some(expression_filter),
        _ => None,
    }
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
        refusals(program, &reachable(program, None, language_version), entry, language_version, catalog, &Libraries::default()).reasons.into_iter().next()
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
        // As a run walks it: slot text re-read under the run's version.
        movement_parser::surface::with_version(language_version, || refusals(&program, &reachable(&program, Some(entry), language_version), picked, language_version, &Plugins(None), &Libraries::default()).reasons)
    }

    /// A movement nothing the entry reaches names is not walked: what it
    /// holds cannot run. One the entry names, directly or through another,
    /// is — by a call, a named arm, a movement handed as a closure, in any
    /// letter case, bare or backtick-quoted.
    #[test]
    fn walks_the_entry_and_what_it_reaches_and_nothing_else() {
        let helper = "movement helper(e: <inbox-[:message]->>) {\n  x = @trigger\n}\n";
        // The helper after the entry: movements are walked in source order.
        let entry = |body: &str| format!("{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}\n{helper}");
        assert_eq!(reasons_of(&entry("  s = msg.`subject`"), "m", 3), Vec::<String>::new(), "an unreached helper");
        assert_eq!(reasons_of(&entry("  s = msg.`subject`"), "helper", 3), ["meta:trigger"], "the helper as the entry");
        for (body, first) in [
            // A call is walked into: what the callee holds is the reason.
            ("  helper(e: msg)", "meta:trigger"),
            ("  r = helper(e: msg)", "meta:trigger"),
            ("  r = HELPER(msg)", "meta:trigger"),
            ("  r = await parallel([helper])", "meta:trigger"),
            // A movement handed to a collection op by name is called once per
            // member; a name read whole (here refused at run time, as the
            // TypeScript refuses it) reaches it too.
            ("  r = MAP([msg], helper)", "meta:trigger"),
            ("  x = \"${`helper`}\"", "meta:trigger"),
        ] {
            let reasons = reasons_of(&entry(body), "m", 3);
            assert_eq!(reasons.first().map(String::as_str), Some(first), "{body}: {reasons:?}");
            assert!(reasons.iter().any(|r| r == "meta:trigger"), "{body} reaches the helper: {reasons:?}");
        }
        // Transitively: the entry names `middle`, which names `helper`.
        let chain = format!("{PRELUDE}{helper}movement middle(e: <inbox-[:message]->>) {{\n  helper(e: e)\n}}\nmovement m(msg: <inbox-[:message]->>) {{\n  middle(e: msg)\n}}");
        assert_eq!(reasons_of(&chain, "m", 3), ["meta:trigger"]);
        // A movement taking a value is refused only where it can run.
        let valued = format!("{PRELUDE}movement v(n: <number[]>) {{\n  x = n\n}}\nmovement m(msg: <inbox-[:message]->>) {{\n  x = 1\n}}");
        assert_eq!(reasons_of(&valued, "m", 3), Vec::<String>::new());
        // Fired itself, it fails the run before its body on either engine.
        assert_eq!(reasons_of(&valued, "v", 3), Vec::<String>::new());
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
        let valued_file = format!("{PRELUDE}y = @trigger\n{helper}movement m(msg: <inbox-[:message]->>) {{\n  x = 1\n}}");
        assert_eq!(reasons_of(&valued_file, "m", 3), ["meta:trigger"]);
    }

    /// The walk goes on past a statement's reason, into the next statement,
    /// an `if`'s arms past its condition and a block's body past its head:
    /// every reason, each once, in the order met, the first the one a walk
    /// that stopped there gives.
    #[test]
    fn notes_every_reason_in_the_order_met() {
        let body = "  x = @trigger\n  y = @trigger\n  if x WITHIN \"7d\" {\n    write msg { a: 1 }\n  }\n  v = 1\n  v-[c:companies]-> {\n    z = TEXT.CHUNKS(c.`name`)\n    await sleep(1h)\n  }\n  helper(e: msg)";
        let source = format!("{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}");
        assert_eq!(
            reasons_of(&source, "m", 3),
            ["meta:trigger", "expression_does_not_lower", "statement:call"]
        );
        assert_eq!(refused(body).as_deref(), Some("meta:trigger"));
        // The file's reasons come first, then each movement's, in source order.
        let file_first = format!("import {{ x }} from \"./lib.mov\"\n{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n  inbox = 1\n  y = @trigger\n}}");
        assert_eq!(reasons_of(&file_first, "m", 3), ["import_from_file", "name_shadowed", "meta:trigger"]);
    }

    #[test]
    fn admits_reads_bindings_branches_writes_nodes_and_sleeps() {
        for body in [
            "  s = msg.`subject`\n  if s CONTAINS \"deal\" AND LENGTH(s) > 3 {\n    t = \"${UPPER(TRIM(s))}!\"\n    return t\n  } else {\n    u = COALESCE(msg.`text`, \"x\")\n  }",
            "  n = UPPER(msg.`subject`)",
            "  co = write crm-[:companies]-> { unique by (`name`) name: msg.`subject` }\n  write co-[:notes]-> { body: co.`name` }\n  write co { stage: \"x\" }",
            "  d = { label: \"x\" }\n  co = write crm-[:companies]-> { name: \"a\" }\n  g = graph { title: d.`label`, owner: co, ...co }\n  n = node { name: d.`label` }\n  write crm-[:companies]-> { ...d, name: g.`title` }",
            "  waited = await sleep(30s)\n  await sleep(1h)",
            // The event spread is a record's, and a member spread reads a record's field.
            "  g = graph { ...msg }\n  co = write crm-[:companies]-> { name: \"a\" }\n  h = graph { ...co.`meta` }",
            "  x = NUMBER.FORMAT(1200000, \"compact\")\n  y = { a: [1, -2] }\n  z = y.`a`",
            // A WITHIN measures from the host's clock, a hop's WHERE's too.
            "  x = msg.`subject` WITHIN \"7d\"\n  if \"2025-12-30\" WITHIN \"7d\" {\n    y = 1\n  }",
            "  crm-[c:companies WHERE `name` WITHIN \"7d\"]-> {\n    y = 1\n  }",
            // The event in a graph is held as its source position.
            "  g = graph { owner: msg }\n  h = graph { title: \"t\", source: msg, inner: { from: msg } }",
        ] {
            assert_eq!(refused(body), None, "{body}");
        }
    }

    #[test]
    fn refuses_each_construct_it_does_not_run_with_its_reason() {
        for (body, reason) in [
            ("  x = @trigger", "meta:trigger"),
            ("  x = FIRST(crm-[:#foo]->)", "traversal_meta_edge"),
            ("  crm-[:#foo]-> {\n    y = 1\n  }", "traversal_meta_edge"),
            ("  write crm-[:#foo]-> { name: \"a\" }", "traversal_meta_edge"),
            ("  x = TEXT.CHUNKS(msg.`subject`)", "expression_does_not_lower"),
            ("  x = 1\n  x = write crm-[:companies]-> { name: \"a\" }", "name_rebound"),
            ("  inbox = 1", "name_shadowed"),
            ("  msg = 1", "name_shadowed"),
            ("  write crm-[:companies]-> bind co { name: \"a\" }", "write_bind"),
            ("  write crm-[:companies]-> { unique by (`name` == \"a\" AND msg-[:replies]->.`y` == 1) name: \"a\" }", "unique_by_reads_beyond_candidate"),
            ("  write crm-[:companies]-> { unique by (`name` CONTAINS \"a\") name: \"a\" }", "unique_by_without_key"),
            ("  n = node { owner: msg }", "node_event_entry"),
            ("  x = MAP([1], { concurrency: \"many\" }, (v) => { return v })", "rvalue:collection"),
            ("  MAP([1], { batch: 4 }, (v) => { return v })", "statement:collection"),
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
        // A member of a value spread into a graph runs since PLAN-08A group E.
        assert_eq!(refused("  held = { k: { name: \"a\" } }\n  g = graph { ...held.k }"), None);
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
        assert_eq!(file(&aliased), None);
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

    /// `ONLY` of an expression its failure spells back (crate::formula), a
    /// walk read for a field among them, is admitted, and so is one picking
    /// the record a walk lands on for a graph's entry (`bindSlotValue`); one
    /// it does not spell (a resource walk) is refused.
    #[test]
    fn admits_an_only_its_failure_can_spell() {
        assert_eq!(refused("  crm-[c:companies]-> {\n    x = ONLY(c-[:deals]->.`name`)\n  }"), None);
        assert_eq!(refused("  x = ONLY([1, 2])"), None);
        assert_eq!(refused("  x = ONLY(msg-[:_resources]->.`name`)").as_deref(), Some("aggregate:only"));
        assert_eq!(refused("  g = graph { file: ONLY(msg-[:files]->) }"), None);
        assert_eq!(refused("  g = node { file: ONLY(msg-[:files]->) }").as_deref(), Some("aggregate:only"));
    }

    /// A closure bound to a name called as a function (`executeClosureCall`):
    /// as a statement, bound, in the construction's spelling, returned and
    /// as another call's argument; refused by name where the program's
    /// closures of that name differ in what their parameters take.
    #[test]
    fn admits_calls_of_a_closure_bound_to_a_name() {
        for body in [
            "  f = (n: <number>) => n + 1\n  r = f(n: 3)",
            "  f = (n: <number>) => n + 1\n  r = f(3)",
            "  f = (n: <number>) => {\n    write crm-[:companies]-> { name: \"a\" }\n  }\n  f(n: 1)",
            "  f = (r) => r.`name`\n  co = write crm-[:companies]-> { name: \"a\" }\n  x = f(r: co)",
            "  f = (n: <number>) => n + 1\n  g = (k: <number>) => k * 2\n  x = g(k: f(n: 1))",
        ] {
            assert_eq!(refused(body), None, "{body}");
        }
        assert_eq!(
            refused("  if msg.`a` {\n    f = (n: <number>) => n\n  } else {\n    f = (n) => n\n  }\n  x = f(n: 1)").as_deref(),
            Some("function_call")
        );
    }

    /// A returned block is its iterations' values, as a bound block's are:
    /// its head's alias bound in it, a park inside joined by its fan-out.
    #[test]
    fn admits_a_returned_block() {
        assert_eq!(refused("  return crm-[c:companies]-> {\n    await sleep(1h)\n    return c.`name`\n  }"), None);
        assert_eq!(refused("  return crm-[c:companies]-> {\n    y = @trigger\n    return c.`name`\n  }").as_deref(), Some("meta:trigger"));
    }

    /// A call written inside an expression (crate::nested): a closure's or
    /// an extraction's, a collection op's is admitted, its operands and the
    /// rest walked over the names they are bound to.
    #[test]
    fn admits_calls_written_inside_an_expression() {
        for body in [
            "  f = (n: <number>) => n * 2\n  write crm-[:notes]-> { body: \"${f(3) + 1}\" }",
            "  f = (n: <number>) => n > 1\n  if msg.`subject` != \"\" AND f(2) {\n    x = 1\n  }",
            "  f = (t: <text>) => UPPER(t)\n  x = COALESCE(msg.`subject`, f(\"a\"))",
        ] {
            assert_eq!(refused(body), None, "{body}");
        }
        // A collection op, its function's body walked as a member's.
        for body in [
            "  x = { all: MAP([1], (v) => v) }",
            "  x = { all: MAP([msg.`subject`], (s) => UPPER(s)) }",
            "  if COUNT(FILTER([msg.`subject`], (s) => s != \"\")) > 0 {\n    x = 1\n  }",
            "  x = FIRST(MAP([msg], (r) => { return r.`subject` }))",
            // What it hands back is what its function returns: values here,
            // read through the map it is bound in.
            "  names = { all: MAP([msg.`subject`, \"beta\"], (s) => UPPER(s)) }\n  write crm-[:notes]-> { body: COALESCE(AT(names.all, 1), \"none\") }",
            "  inc = (v: <number>) => v + 1\n  write crm-[:companies]-> { name: { v: MAP([1, 2], inc) } }",
        ] {
            assert_eq!(refused(body), None, "{body}");
        }
        // A `unique by` condition is lowered, not staged (the checker
        // refuses a closure there).
        assert_eq!(
            refused("  write crm-[c:companies]-> { unique by (`name` == AT(MAP([1], (v) => v), 0)) name: \"a\" }").as_deref(),
            Some("expression_closure")
        );
        // Its body is walked: what it holds is refused by its own name.
        assert_eq!(refused("  x = COUNT(MAP([1], (v) => { y = @trigger\n return v }))").as_deref(), Some("meta:trigger"));
    }

    /// A head walks every hop (`walkSourceHeadPaths`), each hop's alias
    /// naming its own level's record; a pick walks the same.
    #[test]
    fn admits_a_walk_of_many_hops() {
        for body in [
            "  crm-[c:companies]->-[d:deals]-> {\n    x = d.`title`\n    y = c.`name`\n  }",
            "  crm-[c:companies WHERE c.`name` != \"x\" ORDER BY c.`name` LIMIT 2]->-[d:deals LIMIT 1]-> {\n    write crm-[:notes]-> { body: d.`title` }\n  }",
            "  x = FIRST(crm-[:companies]->-[:deals]->)",
        ] {
            assert_eq!(refused(body), None, "{body}");
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
            // The run fails as the TypeScript's `resolvePositionWriteTarget`
            // fails it: no record position.
            "  delete msg",
            "  x = \"a\"\n  delete x",
        ] {
            assert_eq!(refused(body), None, "{body}");
        }
    }

    #[test]
    fn refuses_each_record_verb_form_it_does_not_run_with_its_reason() {
        for (body, reason) in [
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
        assert_eq!(reasons(keeps, "  one = FIRST([msg])\n  keeps(n: one)\n  kept(e: msg)"), Vec::<String>::new(), "where the program keeps a walk, a value may hold one, and a head walks on past it");
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
            // A head off a kept walk walks on past its head.
            "  files = lazy msg-[a:attachments]->\n  files-[f:x]-> {\n    y = 1\n  }",
            // A read off a kept walk walks on past its head.
            "  files = lazy msg-[a:attachments]->\n  x = files-[:x]->.`name`",
            // A head of many hops down a node's edges.
            "  d = node { companies: <Company> }\n  d-[c:companies]->-[f:founder]-> {\n    x = f.`first`\n  }",
        ] {
            assert_eq!(file(&declared(body)), None, "{body}");
        }
        for (body, reason) in [
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
        // A file-level extraction, write or call fails every run as the
        // TypeScript's does, before any body: nothing after it is walked.
        let refused_body = "movement m(msg: <inbox-[:message]->>) {\n  x = @trigger\n}";
        assert_eq!(file(&format!("{PRELUDE}r = extract from [\"a\"] {{\n  node n: \"n\" {{ a: \"a\" }}\n}}\n{refused_body}")), None);
        assert_eq!(file(&format!("{PRELUDE}w = write crm-[:companies]-> {{ name: \"a\" }}\n{refused_body}")), None);
        assert_eq!(file(&format!("{PRELUDE}y = @trigger\nw = write crm-[:companies]-> {{ name: \"a\" }}\n{refused_body}")).as_deref(), Some("meta:trigger"));
        // A statement at file scope runs nothing.
        assert_eq!(file(&format!("{PRELUDE}write crm-[:companies]-> {{ name: \"a\" }}\n{movement}")), None);
        assert_eq!(file(&format!("{PRELUDE}movement v(n: <number[]>) {{\n  x = n\n}}\n{movement}")), None);
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
            ("  Lead = 1", "name_shadowed"),
            ("  Stage = 1", "name_shadowed"),
            ("  tag = 1", "name_shadowed"),
            ("  fetch = 1", "name_shadowed"),
        ] {
            assert_eq!(with(body).as_deref(), Some(reason), "{body}");
        }
        let movement = "movement m(msg: <inbox-[:message]->>) {\n  x = 1\n}";
        // A file-level value reads only the file-level values before it.
        for (value, reason) in [("y = @trigger", "meta:trigger")] {
            assert_eq!(file(&format!("{PRELUDE}{value}\n{movement}")).as_deref(), Some(reason), "{value}");
        }
        // A plugin or a movement called at file level, in either call form:
        // `fileLevelCall` fails the run before any body, on either engine.
        let refused_body = "movement m(msg: <inbox-[:message]->>) {\n  x = @trigger\n}";
        for value in ["page = fetch_url()", "page = fetch_url(url: \"x\")", "page = FETCH_URL(url: \"x\")", "r = m(msg: 1)", "r = M(1)"] {
            assert_eq!(file(&format!("import {{ fetch_url }} from plugins\n{PRELUDE}{value}\n{refused_body}")), None, "{value}");
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
            // A WHERE down an extraction fails the run as the TypeScript's
            // does; an ORDER BY or a LIMIT is not read.
            "\n  x = deals-[c:co WHERE c.`name` == \"a\"]->.`name`",
            "\n  deals-[c:co WHERE `name` == \"x\"]-> {\n    x = 1\n  }",
            "\n  deals-[c:co LIMIT 1]-> {\n    x = 1\n  }",
            "\n  if EXISTS(deals-[c:co ORDER BY `name` LIMIT 1]->) {\n    x = 1\n  }",
            "\n  deals-[c:co]->-[p:people]-> {\n    x = p.`name`\n  }",
            // A `_resources` head: the record's bundle, or the content the
            // extraction read, its WHERE over each resource.
            "\n  msg-[f:_resources]-> {\n    x = f.`name`\n  }",
            "\n  deals-[f:_resources WHERE type == \"FILE\"]-> {\n    write crm-[:notes]-> { body: f.`name` }\n  }",
        ] {
            assert_eq!(with(&format!("{tree}{after}")), None, "{after}");
        }
        for (after, reason) in [
            ("\n  delete deals", "delete_not_record"),
        ] {
            assert_eq!(with(&format!("{tree}{after}")).as_deref(), Some(reason), "{after}");
        }
        for (body, reason) in [
            ("  d = extract from [msg.`text`] {\n    a: \"${@trigger}\"\n  }", "meta:trigger"),
            ("  d = extract from [msg.`text`] through [nowhere(url: msg.`text`)] {\n    a: \"a\"\n  }", "plugin_call"),
        ] {
            assert_eq!(with(body).as_deref(), Some(reason), "{body}");
        }
        // A record named bare as a stage plugin's argument is handed its
        // fields, as a plain call's argument is; a SORT key of any form is
        // read in each member's scope.
        for body in [
            "  d = extract from [SORT([msg.`text`], UPPER(\"a\"))] {\n    a: \"a\"\n  }",
            "  d = extract from [msg.`text`] through [fetch_url(url: msg)] {\n    a: \"a\"\n  }",
            "  co = write crm-[:companies]-> { name: \"Acme\" }\n  d = extract from [msg.`text`] through [fetch_url(url: co)] {\n    a: \"a\"\n  }",
        ] {
            assert_eq!(with(body), None, "{body}");
        }
        // A tier is read off the run's input; `AI()` is the run's call.
        for body in ["  d = extract \"careful\" from [msg.`text`] {\n    a: \"a\"\n  }", "  d = extract from [msg.`text`] {\n    a: \"${AI(\"why\")}\"\n  }", "  x = AI(msg.`text`, \"thorough\")"] {
            assert_eq!(with(body), None, "{body}");
        }
        // A declared shape's words are walked in the file's scope.
        let shaped = |words: &str| file(&format!("{PRELUDE}node Lead {{\n  name: <text> \"{words}\"\n}}\nmovement m(msg: <inbox-[:message]->>) {{\n  x = 1\n}}"));
        assert_eq!(shaped("its name"), None);
        assert_eq!(shaped("its ${@trigger} name").as_deref(), Some("meta:trigger"));
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
            "  said = { page: fetch_url(url: msg.`subject`) }\n  write crm-[:notes]-> { body: COALESCE(said.page, \"none\") }",
            "  page = fetch_url(url: msg.`text`)\n  write crm-[:notes]-> { body: COALESCE(page, \"none\") }",
            "  more = research(name: msg.`subject`)\n  write crm-[:notes]-> { body: more.`summary` }",
            "  fetch_url(url: msg.`text`)",
            "  page = fetch_url()",
            "  page = fetch_url(msg.`text`)",
            "  page = fetch_url(url: TRIM(msg.`text`))",
            "  return fetch_url(url: msg.`text`)",
            "  co = write crm-[:companies]-> { name: \"a\" }\n  page = fetch_url(url: write crm-[:notes]-> { body: \"b\" })",
            "  found = find_files(q: msg.`text`)\n  one = FIRST(found)\n  write crm-[:notes]-> { body: COALESCE(one.`url`, \"none\") }",
        ] {
            assert_eq!(with(body), None, "{body}");
        }
        // From version 3 a plugin's name in any letter case is its call.
        assert_eq!(with("  page = FETCH_URL(url: msg.`text`)"), None);
        // A snapshot that does not say what the plugin hands back refuses
        // its call.
        let unknown = movement_parser::stmt::parse_program(&format!("import {{ fetch_url }} from plugins\n{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n  page = fetch_url(url: \"x\")\n}}"), 3, false).unwrap();
        assert_eq!(refusal(&unknown, 3, &Plugins(None)).as_deref(), Some("plugin_call"));
    }

    /// What the checker holds a program to, read where admission held a
    /// value may be anything: a closure's parameter typed by a position is
    /// one record (a graph the run built among them), its field reads
    /// values; a closure's, a movement's and an extraction's call hands back
    /// what its returns hand back; a map spread of a record copies its
    /// fields. Where the checker does not see a record (through COALESCE or
    /// MULTI), the refusal stays.
    #[test]
    fn reads_the_checkers_types_for_parameters_calls_and_spreads() {
        let shaped = |body: &str| file(&format!("{PRELUDE}node Co {{\n  name: <text>\n}}\ntype Tier = <\"gold\" | \"silver\">\nmovement m(msg: <inbox-[:message]->>) {{\n{body}\n}}"));
        for body in [
            "  x = graph<Co> { name: \"Acme\" }\n  named = (r: <Co>) => {\n    write crm-[:notes]-> { body: r.name }\n  }\n  named(r: x)",
            "  g = graph { name: \"h\", kept: [{ name: \"Acme\" }] }\n  x = FIRST(g-[:kept]->)\n  named = (r: <Co>) => {\n    write crm-[:notes]-> { body: r.name }\n  }\n  named(r: x)",
            "  base = 10\n  add = (v: <number>) => v + base\n  y = add(1)\n  write crm-[:notes]-> { body: \"x\", payload: { y: y, z: add(2) } }",
            "  tag = (t: <text>) => UPPER(t)\n  write crm-[:notes]-> { body: COALESCE(tag(msg.`subject`), \"none\") }",
            "  out = MAP([\"a\", \"b\"], { concurrency: 2 }, (t) => {\n    return UPPER(t)\n  })\n  tiers = MEMBERS(<Tier>)\n  write crm-[:notes]-> { body: \"x\", payload: { out: out, tiers: tiers } }",
            "  write crm-[:companies]-> { name: COALESCE(FIRST(extract([msg.`text`], Co)).name, \"none\") }",
            "  found = extract([msg.`text`], Co)\n  merged = MAP(found, (c) => {\n    return { ...c, tag: UPPER(c.name) }\n  })\n  MAP(merged, (d) => {\n    write crm-[:companies]-> { name: d.tag }\n  })",
            "  rows = MAP([\"p\"], (p) => {\n    return { piece: p, entries: extract([msg.`text`], Co) }\n  })\n  MAP(rows, (row) => {\n    x = FIRST(row.entries)\n    write crm-[:notes]-> { body: x.name }\n  })",
            // A GROUPBY's map of lists of an extraction call's records, and a
            // KEYBY's map of them, read off a member's map field: `AT` reads a
            // key of the map, never a record's.
            "  rows = MAP([\"p\"], (p) => {\n    return { piece: p, entries: extract([p], Co) }\n  })\n  MAP(rows, (x) => {\n    grouped = GROUPBY(x.entries, (e) => e.name)\n    keyed = KEYBY(x.entries, (e) => e.name)\n    write crm-[:companies]-> { name: \"${COUNT(AT(grouped, FIRST(x.entries).name))}|${AT(keyed, FIRST(x.entries).name).name}\" }\n  })",
        ] {
            assert_eq!(shaped(body), None, "{body}");
        }
        let helped = |helper: &str, body: &str| file(&format!("{PRELUDE}{helper}\nmovement m(msg: <inbox-[:message]->>) {{\n{body}\n}}"));
        assert_eq!(helped("function trail(n: <number>): <text> {\n  if n <= 0 {\n    return \"end\"\n  }\n  rest = trail(n - 1)\n  return CONCAT(\"${n}\", rest)\n}", "  write crm-[:notes]-> { body: trail(2) }"), None);
        // A nested call whose value is a record is not read as a value.
        assert_eq!(helped("function made(t: <text>) {\n  co = write crm-[:companies]-> { name: t }\n  return co\n}", "  write crm-[:notes]-> { body: CONCAT(made(\"a\").name, \"!\") }"), Some("nested_movement_call".into()));
        assert_eq!(helped("function trail(n: <number>): <text> {\n  if n <= 0 {\n    return \"end\"\n  }\n  rest = trail(n - 1)\n  return CONCAT(\"${n}\", rest)\n}", "  x = trail(2)\n  write crm-[:notes]-> { body: x }"), None);
        for (body, reason) in [
            ("  co = write crm-[:companies]-> { name: \"a\" }\n  write crm-[:notes]-> { body: COALESCE(co, \"x\") }", "write_field_record"),
            ("  co = write crm-[:companies]-> { name: \"a\" }\n  f = () => COALESCE(co, \"x\")\n  write crm-[:notes]-> { body: f() }", "write_field_record"),
            ("  co = write crm-[:companies]-> { name: \"a\" }\n  f = (c: <crm-[:company]->>) => {\n    return { k: c }\n  }\n  y = f(co)\n  write crm-[:notes]-> { body: \"x\", payload: y }", "write_field_record"),
            ("  co = write crm-[:companies]-> { name: \"a\" }\n  x = graph<Co> { name: COALESCE(co, \"x\") }\n  named = (r: <Co>) => {\n    write crm-[:notes]-> { body: r.name }\n  }\n  named(r: x)", "write_field_record"),
            ("  co = write crm-[:companies]-> { name: \"a\" }\n  f = (t: <text>) => t\n  y = f(COALESCE(co, \"x\"))\n  write crm-[:notes]-> { body: y }", "call_arg_record"),
            ("  co = write crm-[:companies]-> { name: \"a\" }\n  note = (t: <text>) => {\n    write crm-[:notes]-> { body: t }\n  }\n  note(COALESCE(co, \"x\"))", "call_arg_record"),
            ("  co = write crm-[:companies]-> { name: \"a\" }\n  note = (t: <text>) => {\n    write crm-[:notes]-> { body: t }\n  }\n  MAP([COALESCE(co, \"x\")], note)", "call_arg_record"),
        ] {
            assert_eq!(shaped(body).as_deref(), Some(reason), "{body}");
        }
        // A record handed to a position parameter is held to holding none in
        // a field at every call: one built here, or one a call hands back.
        let with_helper = |helper: &str, body: &str| file(&format!("{PRELUDE}node Co {{\n  name: <text>\n}}\n{helper}\nmovement m(msg: <inbox-[:message]->>) {{\n{body}\n}}"));
        let dirty = "  co = write crm-[:companies]-> { name: \"a\" }\n  x = graph<Co> { name: COALESCE(co, \"x\") }";
        let reads = "function hp(r: <Co>) {\n  write crm-[:notes]-> { body: r.name }\n}";
        let passes_on = "function hp(r: <Co>) {\n  named = (q: <Co>) => {\n    write crm-[:notes]-> { body: q.name }\n  }\n  named(q: r)\n}";
        let makes = "function mk(c: <crm-[:company]->>) {\n  g = graph<Co> { name: COALESCE(c, \"x\") }\n  return g\n}";
        assert_eq!(with_helper(reads, &format!("{dirty}\n  hp(r: x)")).as_deref(), Some("position_arg_record"));
        assert_eq!(with_helper(passes_on, &format!("{dirty}\n  hp(r: x)")).as_deref(), Some("position_arg_record"));
        // The closure is walked where it is written, the node it is handed
        // already known to hold one: its field read is refused first.
        assert_eq!(
            with_helper(makes, "  co = write crm-[:companies]-> { name: \"a\" }\n  x = mk(c: co)\n  named = (r: <Co>) => {\n    write crm-[:notes]-> { body: r.name }\n  }\n  named(r: x)").as_deref(),
            Some("write_field_record")
        );
        assert_eq!(with_helper(&format!("{makes}\n{reads}"), "  co = write crm-[:companies]-> { name: \"a\" }\n  x = mk(c: co)\n  hp(r: x)").as_deref(), Some("position_arg_record"));
        assert_eq!(with_helper(reads, "  x = graph<Co> { name: \"Acme\" }\n  hp(r: x)"), None);
        assert_eq!(with_helper(passes_on, "  x = graph<Co> { name: \"Acme\" }\n  hp(r: x)"), None);
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
            // A record in an extraction's input is written as its fields.
            "  rows = crm-[c:companies]->\n  found = extract from [rows] {\n    name: \"the company\"\n  }",
            "  co = write crm-[:companies]-> { name: \"a\" }\n  found = extract from [co, { k: co }] {\n    name: \"the company\"\n  }",
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
            // The run fails as the TypeScript's `spreadIntoGraph` fails it.
            "  co = write crm-[:companies]-> { name: \"a\" }\n  held = { k: co }\n  g = graph { ...held }",
        ] {
            assert_eq!(refused(body), None, "{body}");
        }
        for (body, reason) in [
            ("  rows = crm-[c:companies]->\n  top = FIRST(rows)\n  a = AT(top, \"read\")", "at_record_key"),
            ("  rows = crm-[c:companies]->\n  top = FIRST(rows)\n  key = \"kind\"\n  a = AT(top, key)", "at_record_key"),
        ] {
            assert_eq!(refused(body).as_deref(), Some(reason), "{body}");
        }
    }

    /// A closure called by name inside a library function runs, as the same
    /// body does in the root (PLAN-08A batch review, L2), by order, by name
    /// and nested in an expression.
    #[test]
    fn admits_a_closure_called_by_name_inside_a_library_function() {
        for call in ["f(n)", "f(x: n)", "UPPER(f(n))"] {
            let library = format!("{PRELUDE}export function tag(n: <text>) {{\n  f = (x: <text>) => CONCAT(x, \"-L\")\n  return {call}\n}}");
            let library = movement_parser::stmt::parse_program(&library, 3, false).expect("the library parses");
            let source = format!("{PRELUDE}import {{ tag }} from \"lib/forms\"\nmovement m(msg: <inbox-[:message]->>) {{\n  r = tag(n: msg.`subject`)\n}}");
            let program = movement_parser::stmt::parse_program(&source, 3, false).expect("the program parses");
            let libraries = Libraries([("lib/forms".to_string(), library)].into_iter().collect());
            let declared: Vec<&ast::MovementDeclaration> = program.statements.iter().filter_map(|s| if let Statement::Movement(m) = s { Some(m) } else { None }).collect();
            let picked = entry_of(&declared, Some("m"), 3);
            let reasons = refusals(&program, &reachable(&program, Some("m"), 3), picked, 3, &Plugins(None), &libraries).reasons;
            assert_eq!(reasons, Vec::<String>::new(), "{call}");
        }
    }

    /// A closure bound from a call's value and called by name (merge 11
    /// review, item 4): `mk` a body closure, a file-level one, a function or
    /// a library's function, its returns closures (a literal or a name
    /// bound to one), the call's value a value. A callee one of whose
    /// returns is no closure leaves the name no closure: a call through the
    /// value it holds (language version 5).
    #[test]
    fn admits_a_closure_bound_from_a_call_and_called_by_name() {
        let mk = "mk = (a: <number>) => {\n  return (b: <number>) => a + b\n}\n";
        let use_h = "  h = mk(2)\n  r = h(1)\n  write crm-[:notes]-> { body: CONCAT(\"r\", r) }";
        let reasons = |top: &str, body: &str, library: Option<&str>| {
            let import = if library.is_some() { "import { mk } from \"lib/mk\"\n" } else { "" };
            let source = format!("{PRELUDE}{import}{top}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}");
            let program = movement_parser::stmt::parse_program(&source, 5, false).expect("the program parses");
            let libraries = Libraries(
                library
                    .map(|l| ("lib/mk".to_string(), movement_parser::stmt::parse_program(&format!("{PRELUDE}{l}"), 5, false).expect("the library parses")))
                    .into_iter()
                    .collect(),
            );
            let declared: Vec<&ast::MovementDeclaration> = program.statements.iter().filter_map(|s| if let Statement::Movement(m) = s { Some(m) } else { None }).collect();
            let picked = entry_of(&declared, Some("m"), 5);
            refusals(&program, &reachable(&program, Some("m"), 5), picked, 5, &Plugins(None), &libraries).reasons
        };
        let indented = mk.lines().map(|l| format!("  {l}\n")).collect::<String>();
        let function = "function mk(a: <number>) {\n  return (b: <number>) => a + b\n}\n";
        let named = "mk = (a: <number>) => {\n  g = (b: <number>) => a + b\n  return g\n}\n";
        let none: Vec<String> = Vec::new();
        assert_eq!(reasons("", &format!("{indented}{use_h}"), None), none, "a body closure");
        assert_eq!(reasons(mk, use_h, None), none, "a file-level closure");
        assert_eq!(reasons(function, use_h, None), none, "a function");
        assert_eq!(reasons(named, use_h, None), none, "a returned name");
        assert_eq!(reasons("", use_h, Some(&format!("export {function}"))), none, "a library's function");
        let mixed = "mk = (a: <number>) => {\n  if (a > 1) {\n    return (b: <number>) => a + b\n  }\n  return a\n}\n";
        // From version 5 a name holding a call's value that may be no
        // closure is called through the value it holds: run as the
        // TypeScript runs it, the checker typing the call.
        assert_eq!(reasons(mixed, use_h, None), none, "a return that is no closure");
    }

    /// A collection op's function parameter from version 5: the checker
    /// holds each member, and a REDUCE's start, to the function's typed
    /// parameter (MOV_CALL_ARG_TYPE, MOV_CALL_ARG_MAYBE_RECORD), so a typed
    /// value parameter is read as a value, for a movement by name as for a
    /// closure. Version 4 still walks the movement under every kind.
    #[test]
    fn a_collection_ops_typed_value_parameter_takes_a_value_from_version_5() {
        let put = "movement put(t: <text>) {\n  write crm-[:notes]-> { body: t }\n}\n";
        let reasons = |body: &str, version: u32| {
            let source = format!("{PRELUDE}{put}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}");
            let program = movement_parser::stmt::parse_program(&source, version, false).expect("the test's program parses");
            let declared: Vec<&ast::MovementDeclaration> = program.statements.iter().filter_map(|s| if let Statement::Movement(m) = s { Some(m) } else { None }).collect();
            let entry = declared.iter().copied().find(|m| m.name == "m");
            refusals(&program, &reachable(&program, Some("m"), version), entry, version, &Plugins(None), &Libraries::default()).reasons
        };
        let none: Vec<String> = Vec::new();
        for body in [
            "  MAP([\"a\", \"b\"], put)",
            "  MAP(SPLIT(\"a,b\", \",\"), put)",
            "  MAP([msg.`subject`], put)",
            "  up = (t: <text>) => UPPER(t)\n  r = MAP([msg.`subject`], up)\n  write crm-[:notes]-> { body: \"${COUNT(r)}\" }",
            "  add = (acc: <text>, t: <text>) => CONCAT(acc, t)\n  r = REDUCE([\"a\"], msg.`subject`, add)\n  write crm-[:notes]-> { body: r }",
        ] {
            assert_eq!(reasons(body, 5), none, "{body}");
        }
        assert_eq!(reasons("  MAP([msg.`subject`], put)", 4), vec!["write_field_record".to_string()]);
    }

    /// B15: a value that may be a record and may be data (a COALESCE or an
    /// IF of the two, a name bound to one, a closure's or a function's call
    /// handing one back) handed to a position parameter. Before version 5
    /// the checker passes it and the run binds the record, or fails passing
    /// the data, as the TypeScript does: admitted. A record operand is still
    /// held to holding none in a field.
    #[test]
    fn admits_a_maybe_record_handed_to_a_position_parameter() {
        let hp = "movement hp(r: <crm-[:company]->>) {\n  write crm-[:notes]-> { body: r.name }\n}\n";
        let f = "function f() {\n  a = write crm-[:companies]-> { name: \"A\" }\n  return COALESCE(a, \"x\")\n}\nnode Co {\n  name: <text>\n}\n";
        let reasons = |body: &str| {
            let source = format!("{PRELUDE}{hp}{f}movement m(msg: <inbox-[:message]->>) {{\n  org = write crm-[:companies]-> {{ name: \"A\" }}\n{body}\n}}");
            let program = movement_parser::stmt::parse_program(&source, 4, false).expect("the test's program parses");
            let declared: Vec<&ast::MovementDeclaration> = program.statements.iter().filter_map(|s| if let Statement::Movement(m) = s { Some(m) } else { None }).collect();
            let entry = declared.iter().copied().find(|m| m.name == "m");
            refusals(&program, &reachable(&program, Some("m"), 4), entry, 4, &Plugins(None), &Libraries::default()).reasons
        };
        for body in [
            "  v = COALESCE(org, \"x\")\n  hp(r: v)",
            "  hp(r: COALESCE(org, \"x\"))",
            "  hp(r: COALESCE(org, 3))",
            "  hp(r: COALESCE(org, NULL))",
            "  hp(r: IF msg.`subject` = \"a\" THEN org ELSE \"x\" END)",
            "  c = () => COALESCE(org, \"x\")\n  hp(r: c())",
            "  c = () => COALESCE(org, \"x\")\n  w = c()\n  hp(r: w)",
            "  hp(r: f())",
            "  w = f()\n  hp(r: w)",
            "  n = node { name: \"q\" }\n  hp(r: COALESCE(org, \"x\"))",
        ] {
            assert_eq!(reasons(body), Vec::<String>::new(), "{body}");
        }
        // A node of the body's that holds a record in a field, as an operand.
        let dirty = "  x = graph<Co> { name: COALESCE(org, \"x\") }";
        assert_eq!(reasons(&format!("{dirty}\n  hp(r: IF msg.`subject` = \"a\" THEN x ELSE \"x\" END)")), vec!["position_arg_record".to_string()]);
        assert_eq!(reasons(&format!("{dirty}\n  v = COALESCE(x, \"x\")\n  hp(r: v)")), vec!["position_arg_record".to_string()]);
        // A name bound to a maybe-record and to anything else is not one.
        assert!(reasons("  v = COALESCE(org, \"x\")\n  v = { k: org }\n  hp(r: v)").contains(&"position_arg_record".to_string()));
    }

    /// A call through a value hands back what any function a value may hold
    /// hands back.
    #[test]
    fn a_call_through_a_value_holds_what_its_functions_may() {
        let reasons = |body: &str| {
            let source = format!("{PRELUDE}movement m(msg: <inbox-[:message]->>) {{\n{body}\n}}");
            reasons_of(&source, "m", 5)
        };
        let returns_record = "  mk = () => { return () => { return write crm-[:companies]-> { name: \"a\" } } }\n  g = mk()\n  x = g()\n  write crm-[:notes]-> { body: { k: x } }";
        assert!(!reasons(returns_record).is_empty(), "a record handed back through a value");
        let free = "  mk = () => { return () => { return \"a\" } }\n  g = mk()\n  x = g()\n  write crm-[:notes]-> { body: { k: x } }";
        assert_eq!(reasons(free), Vec::<String>::new());
    }

    /// Closures as values (Dancing Wren, 5): every form closure_values
    /// (apps/api) runs on both engines is admitted whole.
    #[test]
    fn admits_closures_as_values() {
        let top = "function one() {\n  return \"one\"\n}\nfunction pickOne() {\n  return one\n}\nfunction twice() {\n  return 2\n}\nfunction run(h: <(n: <number>) => <number>>) {\n  return h(20)\n}\n";
        let write = |fields: &str| format!("  write graph-[:note]-> {{ payload: {{ {fields} }} }}");
        let lines = |text: &str| text.lines().map(String::from).collect::<Vec<_>>();
        let cases: Vec<(&str, Vec<String>)> = vec![
            ("allJoin", [lines("  k = 7\n  r = all(() => { return k }, () => { return k * 2 }, () => 3)"), vec![write("r: r, second: AT(r, 1)")]].concat()),
            ("allArmParks", [lines("  k = 3\n  r = all(() => {\n    await sleep(1h)\n    return k + 1\n  }, () => { return 10 })"), vec![write("r: r")]].concat()),
            ("everyArmWaiting", [lines("  k = 2\n  r = all(() => {\n    await sleep(1h)\n    return k\n  }, () => {\n    await sleep(2h)\n    return k * 10\n  })"), vec![write("r: r")]].concat()),
            ("namedArms", [lines("  a = () => { return \"a\" }\n  r = all(a, twice)"), vec![write("r: r")]].concat()),
            ("concurrencyOneWithAParkedArm", [lines("  r = all(() => {\n    await sleep(1h)\n    return \"slept\"\n  }, () => {\n    write graph-[:note]-> { body: \"second ran\" }\n    return \"ran\"\n  }, { concurrency: 1 })"), vec![write("r: r")]].concat()),
            ("onErrorWarn", vec!["  r = all(() => { ERROR(\"boom\") }, () => { return 2 }, { onError: \"warn\" })".into(), write("r: r")]),
            ("onErrorIgnoreAfterResume", [lines("  r = all(() => {\n    await sleep(1h)\n    ERROR(\"late\")\n  }, () => { return 2 }, { onError: \"ignore\" })"), vec![write("r: r")]].concat()),
            ("raceArguments", [lines("  a = () => { return \"a\" }\n  r = race(a, () => {\n    await sleep(1h)\n    return \"b\"\n  })"), vec![write("r: r")]].concat()),
            ("closureFromParkedMaker", [lines("  a = 3\n  mk = (n: <number>) => {\n    await sleep(1h)\n    return () => { return a + n }\n  }\n  h = mk(1)\n  x = h()"), vec![write("x: x")]].concat()),
            ("namedFunctionBound", vec!["  g = one".into(), "  x = g()".into(), write("x: x")]),
            ("namedFunctionFromConcise", vec!["  mk = () => one".into(), "  h = mk()".into(), "  x = h()".into(), write("x: x")]),
            ("namedFunctionReturned", vec!["  h = pickOne()".into(), "  x = h()".into(), write("x: x")]),
            ("closureInPlaceArgument", vec!["  k = 2".into(), "  x = run((n) => n + k)".into(), write("x: x")]),
            ("extraArgumentDropped", vec!["  x = run(() => 5)".into(), write("x: x")]),
            ("combinatorArrowBody", vec!["  g = () => race(() => \"first\")".into(), "  r = g()".into(), write("r: r")]),
            ("effectsOnly", [lines("  all(() => {\n    write graph-[:note]-> { body: \"a\" }\n  }, () => {\n    write graph-[:note]-> { body: \"b\" }\n  })"), vec![write("done: 1")]].concat()),
        ];
        let mut refused = Vec::new();
        for (name, body) in cases {
            let source = format!("import {{ manual, kg }} from adapters\nimport {{ kg_cred }} from credentials\nruns = manual()\ngraph = kg(credentials: kg_cred)\n{top}movement recap(go: <runs-[:Invocation]->>) {{\n{}\n}}\nlisten to runs {{}} fire recap\n", body.join("\n"));
            let reasons = reasons_of(&source, "recap", 5);
            if !reasons.is_empty() {
                refused.push(format!("{name}: {reasons:?}"));
            }
        }
        assert!(refused.is_empty(), "{}", refused.join("\n"));
    }

    /// A positional call (version 3 on; the only spelling of a function's
    /// call from version 5) carries its reading as an expression. Where
    /// the call runs as a call — a function's, a plugin's — that slot is the
    /// call itself, not a call nested in one: what it hands back (a node, a
    /// record) is read off the callee as the named call's is.
    #[test]
    fn a_positional_call_is_the_call_it_reads_as() {
        let v4 = "import { email, attio } from adapters\nimport { dealflow_inbox, acme_main } from credentials\ninbox = email(credentials: dealflow_inbox)\ncrm = attio(credentials: acme_main)\n";
        let v5 = "inbox = connect email using dealflow_inbox\ncrm = connect attio using acme_main\n";
        let make = "make(t: <text>) {\n  return node { title: t }\n}\n";
        let keep = "keep(e: <inbox-[:message]->>) {\n  n = node { files: lazy e-[a:files]-> }\n  await sleep(1h)\n  return n\n}\n";
        let pick = "pick(n: <text>) {\n  co = write crm-[:companies]-> { name: n }\n  return co\n}\n";
        let none: Vec<String> = Vec::new();
        for (version, prelude, word) in [(3, v4, "movement"), (4, v4, "movement"), (5, v5, "function")] {
            let file = |helper: &str, body: &str| format!("{prelude}{word} {helper}{word} m(msg: <inbox-[:message]->>) {{\n{body}\n}}\n");
            for (helper, body) in [
                (make, "  n = make(msg.`subject`)\n  x = n.`title`\n  write n { title: \"b\" }"),
                (make, "  n = make(t: msg.`subject`)\n  x = n.`title`"),
                (keep, "  k = keep(msg)\n  keep(msg)"),
                (pick, "  co = pick(\"Acme\")\n  write co { name: \"b\" }"),
                // A closure's call handing back a function's value: the
                // function's call in the closure's return is read for what
                // it hands back.
                ("stamp(t: <text>) {\n  return t\n}\n", "  k = (v: <text>) => stamp(v)\n  x = k(\"a\")\n  write crm-[:notes]-> { body: x }"),
                ("stamp(t: <text>) {\n  return t\n}\n", "  k = (v: <text>) => {\n    await sleep(1h)\n    return stamp(v)\n  }\n  x = k(\"a\")\n  write crm-[:notes]-> { body: x }"),
            ] {
                assert_eq!(reasons_of(&file(helper, body), "m", version), none, "version {version}: {body}");
            }
        }
        // A function's positional call nested in an expression is still read
        // as a value there.
        let nested = format!("{v5}function {make}function m(msg: <inbox-[:message]->>) {{\n  x = Text.upper(make(\"a\"))\n}}\n");
        assert_eq!(reasons_of(&nested, "m", 5), ["nested_movement_call"]);
    }
}

