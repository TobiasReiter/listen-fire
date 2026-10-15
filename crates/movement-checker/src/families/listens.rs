//! Listens and callbacks: what fires a movement, and with what.
//!
//! Codes: MOV_LISTEN_FILE_LEVEL, MOV_LISTEN_NOT_INSTANCE,
//! MOV_LISTEN_BAD_CONFIG, MOV_LISTEN_DUPLICATE, MOV_LISTEN_ALIAS_DUPLICATE,
//! MOV_LISTEN_CANNOT_FIRE, MOV_LISTEN_PARAM_MISMATCH,
//! MOV_LISTEN_SHAPE_MISMATCH, MOV_LISTEN_MISSING, MOV_CALLBACK_NOT_MOVEMENT,
//! MOV_CALLBACK_PARAM_NOT_VALUE, MOV_CALLBACK_BAD_CONFIG (and
//! MOV_ADAPTER_NOT_CONSTRUCTED and MOV_CALL_NOT_MOVEMENT where a listen
//! raises them).
//!
//! TypeScript: check.ts `checkListen`, `reportMissingListens`, the
//! dispatchable half of `checkMovement`, `checkCallback`,
//! `checkCallbackNamed`, `checkCallbackParamType`, `checkCallbackConfig`.

use std::collections::{HashMap, HashSet};

use movement_parser::ast::{
    CallArg, CallbackExpression, CallbackSubject, ExprSlot, ListenDeclaration, MovementDeclaration, MovementParam, NamedArg, ParamTypeRef,
    Span, TypeRef, ValueType,
};
use movement_parser::catalog::helpers::parse_field_type_name;
use movement_parser::catalog::types::TriggerConfigFormat;
use movement_parser::lowering::expression::{Expression, ListElement, StaticValue};
use serde_json::json;

use indexmap::IndexMap;
use movement_parser::catalog::types::EdgeSchema;

use crate::checker::Checker;
use crate::codes;
use crate::types::Ty;
use crate::types::position::{LocalEdge, LocalNode, Position};
use crate::cron::cron_schedule_error;
use crate::diagnostic::{Diagnostic, Severity};
use crate::families::names::spell_name;
use crate::families::systems::{is_boolean_literal, is_value_param_type};
use crate::meta::did_you_mean;
use crate::scope::{Resolution, ScopeId, SymbolId, SymbolKind};
use crate::slots::{expression_of_slot, is_bare_ident};

mod event_types;
use event_types::{EventRef, Kind};

/// `SUPPRESS_SELF_KEY`: the listen key every listener accepts.
const SUPPRESS_SELF_KEY: &str = "suppress_self";

/// `CALLBACK_CONFIG_KEYS`.
const CALLBACK_CONFIG_KEYS: &[&str] = &["once", "ttl"];

/// What the walk remembers across the file for its listens.
#[derive(Default)]
pub struct ListenState {
    /// Listens seen anywhere (any listen suppresses LISTEN_MISSING).
    count: usize,
    /// Each listen's instance and config, for duplicate detection.
    identities: HashSet<String>,
    /// `movement::alias`, for per-movement alias uniqueness.
    aliases: HashSet<String>,
    /// File-level single-parameter movements a listener could fire.
    dispatchables: Vec<Dispatchable>,
    /// Each movement symbol's parameters and the scope it was declared in
    /// (`ScopeSymbol.movement`).
    movements: HashMap<SymbolId, MovementInfo>,
}

struct Dispatchable {
    movement: String,
    instance_name: String,
    adapter: Option<String>,
    position: Option<String>,
    narrowing_keys: Option<Vec<String>>,
    span: Span,
}

pub struct MovementInfo {
    pub params: Vec<MovementParam>,
    pub decl_scope: ScopeId,
}

/// What a listen's config states, read as its keys are checked.
#[derive(Default)]
struct ConfigRead {
    /// Each single-literal value, by key: the address it subscribes to.
    pins: Vec<(String, String)>,
    /// The `events:` selection.
    selected: Option<Vec<String>>,
    /// A `fields`-format key's bare names, and where they are written.
    fields: Option<(Vec<String>, Span)>,
}

/// `suggestedListenKey`: a movement's name as a slug.
fn suggested_listen_key(movement: &str) -> String {
    let lower = movement.to_lowercase();
    let mut slug = String::new();
    let mut gap = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !slug.is_empty() {
                slug.push('-');
            }
            gap = false;
            slug.push(c);
        } else {
            gap = true;
        }
    }
    if slug.is_empty() { "intake".to_string() } else { slug }
}

/// A file's own listens, set aside while an imported library is checked.
pub struct FileListens {
    count: usize,
    identities: HashSet<String>,
    aliases: HashSet<String>,
    dispatchables: Vec<Dispatchable>,
}

impl ListenState {
    /// Starts a library's file: its listens are its own.
    pub fn enter_file(&mut self) -> FileListens {
        FileListens {
            count: std::mem::take(&mut self.count),
            identities: std::mem::take(&mut self.identities),
            aliases: std::mem::take(&mut self.aliases),
            dispatchables: std::mem::take(&mut self.dispatchables),
        }
    }

    pub fn leave_file(&mut self, outer: FileListens) {
        self.count = outer.count;
        self.identities = outer.identities;
        self.aliases = outer.aliases;
        self.dispatchables = outer.dispatchables;
    }

    /// A movement's parameters and the scope it was declared in.
    pub fn movement_info(&self, id: SymbolId) -> Option<&MovementInfo> {
        self.movements.get(&id)
    }

    /// An imported symbol stands for the library's: its declaration too.
    pub fn adopt(&mut self, local: SymbolId, library: SymbolId) {
        if let Some(info) = self.movements.get(&library) {
            let info = MovementInfo { params: info.params.clone(), decl_scope: info.decl_scope };
            self.movements.insert(local, info);
        }
    }
}

impl Checker<'_> {
    /// Remembers a movement's declaration on its symbol, once declared in `scope`.
    pub fn note_movement(&mut self, scope: ScopeId, movement: &MovementDeclaration) {
        if let Some(id) = self.scopes.scope(scope).symbols.get(&movement.name).copied() {
            self.listens.movements.insert(id, MovementInfo { params: movement.params.clone(), decl_scope: scope });
        }
    }

    /// The dispatchable half of `checkMovement`'s parameter loop: a file-level
    /// movement of one parameter typed against an instance is one a listener
    /// could fire. `graph` is what the parameter type's name resolved to.
    pub fn note_dispatchable(&mut self, movement: &MovementDeclaration, type_: &TypeRef, graph: Option<SymbolId>, scope: ScopeId) {
        if self.scopes.scope(scope).parent.is_some() || movement.params.len() != 1 {
            return;
        }
        let Some(symbol) = graph.map(|id| self.scopes.symbol(id)) else { return };
        if symbol.kind != SymbolKind::Instance {
            return;
        }
        let instance = symbol.instance.as_deref();
        self.listens.dispatchables.push(Dispatchable {
            movement: movement.name.clone(),
            instance_name: type_.graph.clone(),
            adapter: symbol.adapter.clone(),
            position: type_.position.clone(),
            narrowing_keys: instance.and_then(|i| i.schema.as_ref()).and_then(|s| s.event_narrowing_keys.clone()),
            span: Span { start: movement.span.start, end: movement.span.start },
        });
    }

    /// `reportMissingListens`: a file that declares a dispatchable movement
    /// but no listen is told, with a listen line to paste.
    pub fn report_missing_listens(&mut self) {
        if self.listens.count > 0 {
            return;
        }
        let dispatchables = std::mem::take(&mut self.listens.dispatchables);
        for d in &dispatchables {
            let spec = d.adapter.as_deref().and_then(|a| self.catalog.adapter(a));
            let vocabulary = spec.and_then(|s| s.trigger_config.as_ref());
            let required = spec.and_then(|s| s.trigger_config_required.clone()).unwrap_or_default();
            let address_tail = d.narrowing_keys.as_ref().and_then(|k| k.last());
            let cron = spec
                .and_then(|s| s.trigger_config_formats.as_ref())
                .and_then(|f| f.0.get("schedule"))
                .is_some_and(|f| *f == TriggerConfigFormat::Cron);
            let config = if cron {
                " { schedule: \"0 9 * * 1\" }".to_string()
            } else if !required.is_empty() {
                let keys: Vec<String> = required
                    .iter()
                    .map(|key| match &d.position {
                        Some(position) if Some(key) == address_tail => format!("{key}: \"{position}\""),
                        _ if key == "key" => format!("key: \"{}\"", suggested_listen_key(&d.movement)),
                        _ => format!("{key}: \"…\""),
                    })
                    .collect();
                format!(" {{ {} }}", keys.join(", "))
            } else if vocabulary.is_some_and(|v| v.iter().any(|k| k == "key")) {
                format!(" {{ key: \"{}\" }}", suggested_listen_key(&d.movement))
            } else {
                String::new()
            };
            let mut info = Diagnostic::error(
                codes::LISTEN_MISSING,
                format!(
                    "'{}' has no listener, so nothing dispatches it — add a listen statement, e.g. listen to {}{config} fire {}",
                    d.movement, d.instance_name, d.movement
                ),
                d.span,
            );
            info.severity = Some(Severity::Info);
            self.push(info);
        }
    }

    /// `checkListen`: `listen to <instance> { <config> } fire <movement>`.
    pub fn check_listen(&mut self, statement: &ListenDeclaration, scope: ScopeId) {
        self.listens.count += 1;
        if self.scopes.scope(scope).parent.is_some() {
            self.report(
                codes::LISTEN_FILE_LEVEL,
                "'listen' is a file-level statement — it declares the file's listeners, so move it out of this block",
                statement.span,
            );
            return;
        }
        let instance_id = self.resolve_reference(&statement.instance, statement.span, scope);
        let instance_kind = instance_id.map(|id| self.scopes.symbol(id).kind);
        if let Some(construct) = &statement.construct {
            let adapter = match instance_id.map(|id| self.scopes.symbol(id)) {
                Some(symbol) if symbol.kind == SymbolKind::Adapter => symbol.imported_name.clone().unwrap_or_else(|| symbol.name.clone()),
                _ => construct.callee.clone(),
            };
            let message = format!(
                "'listen to {}(…)' constructs an instance inline — construct and name it first, then listen by name: 'go = {}' … 'listen to go {{}} fire {}'",
                statement.instance,
                self.construction_call(&adapter),
                statement.movement
            );
            self.report(codes::ADAPTER_NOT_CONSTRUCTED, message, statement.span);
        } else if let Some(symbol) = instance_id.map(|id| self.scopes.symbol(id)) {
            if symbol.kind == SymbolKind::Adapter {
                let adapter = symbol.imported_name.clone().unwrap_or_else(|| symbol.name.clone());
                let message = format!(
                    "'{}' is an adapter, not an instance — construct and name an instance first, then listen to it by name: 'go = {}' … 'listen to go {{}} fire {}'",
                    statement.instance,
                    self.construction_call(&adapter),
                    statement.movement
                );
                self.report(codes::ADAPTER_NOT_CONSTRUCTED, message, statement.span);
            } else if symbol.kind != SymbolKind::Instance {
                let message = format!(
                    "'{}' is {} — 'listen to' names a constructed adapter instance (e.g. inbox = email(credentials: …))",
                    statement.instance,
                    symbol.kind.describe()
                );
                self.report(codes::LISTEN_NOT_INSTANCE, message, statement.span);
            }
        }

        if let Some(arg) = statement.config.iter().find(|a| a.name == SUPPRESS_SELF_KEY)
            && (arg.is_type == Some(true) || !is_boolean_literal(arg.value.raw.trim()))
        {
            self.report(
                codes::LISTEN_BAD_CONFIG,
                format!(
                    "'{SUPPRESS_SELF_KEY}' takes a boolean literal — write {SUPPRESS_SELF_KEY}: true to ignore this system's own writes echoing back (the 2-way-sync case), or omit it (the default is off)"
                ),
                arg.value.span,
            );
        }

        let instance = instance_id.filter(|_| instance_kind == Some(SymbolKind::Instance)).map(|id| self.scopes.symbol(id));
        let adapter_name = instance.and_then(|s| s.adapter.clone());
        let construction_args = instance.and_then(|s| s.instance.as_ref()).map(|i| i.construction_args.clone()).unwrap_or_default();
        let spec = adapter_name.as_deref().and_then(|a| self.catalog.adapter(a));
        let adapter_label = adapter_name.clone().unwrap_or_else(|| "undefined".to_string());
        for required in spec.and_then(|s| s.trigger_config_required.as_ref()).into_iter().flatten() {
            if statement.config.iter().any(|a| &a.name == required) {
                continue;
            }
            let position_supplies = spec
                .is_some_and(|s| s.construction_args.iter().any(|a| a.kind == movement_parser::catalog::types::ArgKind::Position && &a.name == required))
                && construction_args.get(required).is_some_and(|v| !v.trim().is_empty());
            if position_supplies {
                continue;
            }
            let format = spec.and_then(|s| s.trigger_config_formats.as_ref()).and_then(|f| f.0.get(required));
            let example = if format == Some(&TriggerConfigFormat::Cron) {
                "\"0 9 * * 1\"".to_string()
            } else if required == "key" {
                format!("\"{}\"", suggested_listen_key(&statement.movement))
            } else {
                "\"…\"".to_string()
            };
            let why = spec.and_then(|s| s.trigger_config_required_why.as_ref()).and_then(|w| w.0.get(required));
            let rewritten =
                format!("listen to {} {{ {required}: {example} }} fire {}", spell_name(&statement.instance), spell_name(&statement.movement));
            let exact = required == "key" && statement.config.is_empty() && statement.alias.is_none() && statement.construct.is_none();
            let why = why.map(|w| format!(" ({w})")).unwrap_or_default();
            let mut diagnostic = Diagnostic::error(
                codes::LISTEN_BAD_CONFIG,
                format!("a '{adapter_label}' listener requires a '{required}' config{why} — e.g. {rewritten}"),
                statement.span,
            );
            if exact {
                diagnostic.fix = Some(json!({ "edits": [{ "span": statement.span, "text": rewritten }] }));
            }
            self.push(diagnostic);
        }
        let mut read = ConfigRead::default();
        for arg in &statement.config {
            if arg.name == SUPPRESS_SELF_KEY {
                continue;
            }
            self.check_listen_config_arg(arg, spec, &adapter_label, scope, &mut read);
        }

        let schema = instance_id
            .map(|id| self.scopes.symbol(id))
            .and_then(|s| s.instance.clone())
            .filter(|i| i.schema.is_some());
        let schema = schema.as_ref().and_then(|i| i.schema.as_ref());
        let subscribed = read.selected.clone().or_else(|| spec.and_then(|s| s.default_events.clone()));
        if let Some(schema) = schema {
            let span_for = |key: &str| statement.config.iter().find(|a| a.name == key).map_or(statement.span, |a| a.value.span);
            self.check_hop_pins(schema, &read.pins, span_for);
        }
        let event_types = schema.and_then(|schema| event_types::derived_event_types(schema, subscribed.as_deref(), &read.pins));
        if let (Some((names, span)), Some(schema), Some(event_types)) = (&read.fields, schema, &event_types) {
            self.check_listen_fields(schema, event_types, names, *span);
        }

        let mut config: Vec<String> = statement.config.iter().map(|a| format!("{}={}", a.name, a.value.raw.trim())).collect();
        config.sort();
        let identity = format!("{}::{}", statement.instance, config.join(","));
        if !self.listens.identities.insert(identity) {
            let braces = if statement.config.is_empty() { "" } else { " { … }" };
            self.report(
                codes::LISTEN_DUPLICATE,
                format!(
                    "Duplicate listener — an identical 'listen to {}{braces}' already exists; two listens on the same instance must differ in config",
                    statement.instance
                ),
                statement.span,
            );
        }
        if let Some(alias) = &statement.alias
            && !self.listens.aliases.insert(format!("{}::{alias}", statement.movement))
        {
            self.report(
                codes::LISTEN_ALIAS_DUPLICATE,
                format!("Two lanes of '{}' are both named \"{alias}\" — give each listen a distinct alias", statement.movement),
                statement.span,
            );
        }

        let callee = self.callee_name(&statement.movement, scope);
        let Some(movement_id) = self.resolve_reference(&callee, statement.span, scope) else { return };
        let movement_kind = self.scopes.symbol(movement_id).kind;
        if movement_kind == SymbolKind::FileImport {
            return;
        }
        if movement_kind != SymbolKind::Movement {
            self.report(
                codes::CALL_NOT_MOVEMENT,
                format!(
                    "'{}' is {}, not a movement — 'fire' names a movement declared in this file",
                    statement.movement,
                    movement_kind.describe()
                ),
                statement.span,
            );
            return;
        }
        let Some(info) = self.listens.movements.get(&movement_id) else { return };
        let (params, decl_scope) = (info.params.clone(), info.decl_scope);
        if params.len() != 1 {
            self.report(
                codes::LISTEN_PARAM_MISMATCH,
                format!(
                    "'{}' takes {} parameters — a movement fired by a listener takes exactly one, the event position",
                    statement.movement,
                    params.len()
                ),
                statement.span,
            );
            return;
        }
        let Some(instance_id) = instance_id.filter(|_| instance_kind == Some(SymbolKind::Instance)) else { return };
        if let Some(spec) = spec
            && spec.can_fire != Some(true)
        {
            self.report(
                codes::LISTEN_CANNOT_FIRE,
                format!(
                    "'{}' can't start an automation — it has no way to tell us when something changes there. Use it as somewhere to write to, and start this from something that can notify us (a schedule, an inbox, a chat message, or a record change in a system that reports one)",
                    statement.instance
                ),
                statement.span,
            );
            return;
        }
        let param = &params[0];
        let Some(type_) = &param.type_ else { return };
        if is_value_param_type(self, type_, decl_scope) {
            self.report(
                codes::LISTEN_PARAM_MISMATCH,
                format!(
                    "'{}' takes '{}: <{}>', a value, but a listener fires its movement with an event position of '{}' — type the parameter as one ('<{}-[:…]->>')",
                    statement.movement,
                    param.name,
                    spell_param_type(type_),
                    statement.instance,
                    statement.instance
                ),
                statement.span,
            );
            return;
        }
        let ParamTypeRef::Name(declared) = type_ else { return };
        let Resolution::Found(param_graph) = self.scopes.resolve(decl_scope, &declared.graph) else { return };
        if self.scopes.symbol(param_graph).kind == SymbolKind::Shape {
            let instance = self.scopes.symbol(instance_id).instance.clone();
            if let Some(shape) = self.declared_node(param_graph).map(|d| d.instance.clone()) {
                let schema = instance.as_ref().and_then(|i| i.schema.as_ref());
                self.check_listen_shape_conformance(&shape.schema, &shape.name, schema, &declared.graph, statement);
            }
            return;
        }
        if param_graph != instance_id {
            let param_type = format!("{}{}", declared.graph, declared.hops_raw.as_deref().unwrap_or(""));
            self.report(
                codes::LISTEN_PARAM_MISMATCH,
                format!(
                    "'{}' takes '{}: <{param_type}>', but this listener fires with an event position of '{}' — the parameter's type must equal the listened instance's event position type (a '<{}-[:…]->>' position, not '<{param_type}>')",
                    statement.movement, param.name, statement.instance, statement.instance
                ),
                statement.span,
            );
        }
        let (Some(schema), Some(event_types)) = (schema, &event_types) else { return };
        let Some(param_type) = event_types::param_position(schema, declared) else { return };
        let Some(mismatch) = event_types.iter().find(|t| !event_types::positions_match(t, &param_type)) else { return };
        let wrote = format!("<{}{}>", declared.graph, declared.hops_raw.as_deref().unwrap_or(""));
        let instance = &statement.instance;
        let movement = &statement.movement;
        let fires = event_types::describe_event_type(schema, mismatch, instance);
        if let Some((signature, binding, event_param)) =
            event_types::record_signature_rewrite(schema, instance, mismatch, &param.name, &param_type)
        {
            self.report(
                codes::LISTEN_PARAM_MISMATCH,
                format!(
                    "'{movement}' takes '{}: {wrote}', but this listener fires {fires} — the EVENT, not the record it is about. Type the parameter against the event and reach the record in one hop: '{movement}({event_param}: {signature})', then wrap the body in '{binding}'.",
                    param.name
                ),
                statement.span,
            );
            return;
        }
        let example = event_types::event_traversal_example(schema, &param.name, instance);
        let tail = match example {
            None => ".".to_string(),
            Some(example) => format!(" — e.g. `{example}` (a delete event has no record to read)."),
        };
        self.report(
            codes::LISTEN_PARAM_MISMATCH,
            format!(
                "'{movement}' takes '{}: {wrote}' ({}), but this listener fires {fires}. Every listen firing a movement must satisfy its signature — either narrow this listen to what '{movement}' accepts, or widen the signature{tail}",
                param.name,
                event_types::describe_position(schema, &param_type, &declared.graph)
            ),
            statement.span,
        );
    }

    /// `checkListenShapeConformance`: the instance's event position against
    /// the node declaration the movement's parameter names (its schema, any
    /// base folded in).
    fn check_listen_shape_conformance(
        &mut self,
        shape: &movement_parser::catalog::types::InstanceSchema,
        shape_name: &str,
        schema: Option<&movement_parser::catalog::types::InstanceSchema>,
        written: &str,
        statement: &ListenDeclaration,
    ) {
        if !shape.positions.contains_key(shape_name) {
            return;
        }
        let event = schema.and_then(|s| s.event_position.as_ref().and_then(|e| s.positions.get(e).map(|p| (e, p))));
        let Some((event_name, event_position)) = event else {
            let mut info = Diagnostic::error(
                codes::LISTEN_SHAPE_MISMATCH,
                format!(
                    "'{}' isn't connected (or its event schema is unknown) — conformance to the declaration '{written}' is unchecked for this lane",
                    statement.instance
                ),
                statement.span,
            );
            info.severity = Some(Severity::Info);
            return self.push(info);
        };
        if surface_not_enumerated(event_position) {
            let mut info = Diagnostic::error(
                codes::LISTEN_SHAPE_MISMATCH,
                format!(
                    "'{}'s event schema can't be introspected — conformance to the declaration '{written}' is unchecked for this lane",
                    statement.instance
                ),
                statement.span,
            );
            info.severity = Some(Severity::Info);
            return self.push(info);
        }
        let schema = schema.expect("an event position is read off a schema");
        let mut visited = HashSet::new();
        self.conform_shape_node(shape, shape_name, schema, event_name, statement, &mut visited, "");
    }

    /// `conformShapeNode`: every field and nested node the declaration
    /// requires, present on the instance's position and assignable.
    #[allow(clippy::too_many_arguments)]
    fn conform_shape_node(
        &mut self,
        shape: &movement_parser::catalog::types::InstanceSchema,
        node_name: &str,
        schema: &movement_parser::catalog::types::InstanceSchema,
        position_name: &str,
        statement: &ListenDeclaration,
        visited: &mut HashSet<String>,
        path: &str,
    ) {
        if !visited.insert(format!("{node_name}::{position_name}")) {
            return;
        }
        let (Some(node), Some(position)) = (shape.positions.get(node_name), schema.positions.get(position_name)) else { return };
        if surface_not_enumerated(position) {
            return;
        }
        let (instance, movement) = (&statement.instance, &statement.movement);
        for (field, declared) in node.properties.iter() {
            let Some(source) = position.properties.get(field) else {
                let message = if path.is_empty() {
                    format!("'{instance}' has no field `{field}` that the declaration '{node_name}' requires — this lane can't fire '{movement}'")
                } else {
                    format!("'{instance}' {path}has no field `{field}` that the declaration '{node_name}' requires")
                };
                self.report(codes::LISTEN_SHAPE_MISMATCH, message, statement.span);
                continue;
            };
            if !crate::types::field::field_assignable(&crate::types::field::Ty::from_schema(source), &crate::types::field::Ty::from_schema(declared)) {
                let describe = |t: &movement_parser::catalog::types::FieldType| movement_parser::catalog::helpers::describe_field_type(t).unwrap_or_default();
                let message = format!(
                    "'{instance}'{}`{field}` ({}) doesn't fit declared field `{field}` ({})",
                    if path.is_empty() { ".".to_string() } else { format!(" {path}") },
                    describe(source),
                    describe(declared)
                );
                self.report(codes::LISTEN_SHAPE_MISMATCH, message, statement.span);
            }
        }
        for (child, shape_edge) in node.edges.iter() {
            let Some(edge) = position.edges.get(child) else {
                let message = if path.is_empty() {
                    format!("'{instance}' has no relationship '{child}' that the declaration '{node_name}' requires")
                } else {
                    format!("'{instance}' {path}has no relationship '{child}' that the declaration '{node_name}' requires")
                };
                self.report(codes::LISTEN_SHAPE_MISMATCH, message, statement.span);
                continue;
            };
            let child_path = format!("{path}{child} → ");
            self.conform_shape_node(shape, &shape_edge.target, schema, &edge.target, statement, visited, &child_path);
        }
    }

    /// `checkHopPins`: each pin of a listen's address against what the
    /// adapter published as legal under the pins before it.
    fn check_hop_pins(&mut self, schema: &movement_parser::catalog::types::InstanceSchema, pins: &[(String, String)], span_for: impl Fn(&str) -> Span) {
        let (Some(keys), Some(values)) = (&schema.event_narrowing_keys, &schema.event_narrowing_values) else { return };
        let mut pinned: Vec<(String, String)> = Vec::new();
        for key in keys {
            let Some((_, value)) = pins.iter().find(|(k, _)| k == key) else { return };
            let Some(options) = values.get(&crate::types::event_address::narrowing_prefix_key(&pinned)).and_then(|v| v.get(key)) else { return };
            let domain = crate::types::field::Ty::Enum { options: options.clone(), open: None };
            if let Some(found) = crate::families::values::check_enum_literal(value, &domain) {
                let mut diagnostic = crate::diagnostic::Diagnostic::error(found.code, found.message, span_for(key));
                diagnostic.severity = found.severity;
                return self.push(diagnostic);
            }
            pinned.push((key.clone(), value.clone()));
        }
    }

    /// The `fields:` names, against what the listen's events land on (or the
    /// record each is about, where the event declares a subject edge).
    fn check_listen_fields(
        &mut self,
        schema: &movement_parser::catalog::types::InstanceSchema,
        event_types: &[EventRef],
        names: &[String],
        span: Span,
    ) {
        let mut known: Vec<&String> = Vec::new();
        let mut described = false;
        for type_ in event_types.iter().filter(|t| t.kind == Kind::Position) {
            let Some(landed) = schema.positions.get(&type_.key) else { continue };
            let position = event_types::subject_of(schema, landed).map_or(landed, |(_, _, p)| p);
            if position.undescribed == Some(true) {
                continue;
            }
            described = true;
            for name in position.properties.keys() {
                if !known.contains(&name) {
                    known.push(name);
                }
            }
        }
        if !described {
            return;
        }
        let mut sorted: Vec<&String> = known.clone();
        sorted.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let one_of = if sorted.is_empty() {
            String::new()
        } else {
            format!(" — one of: {}", sorted.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "))
        };
        for name in names.iter().filter(|n| !known.contains(n)) {
            self.report(codes::LISTEN_BAD_CONFIG, format!("'{name}' is not a property of what this listener watches{one_of}"), span);
        }
    }

    /// One config key of a listen, against the adapter's vocabulary and formats.
    fn check_listen_config_arg(
        &mut self,
        arg: &NamedArg,
        spec: Option<&movement_parser::catalog::types::AdapterSpec>,
        adapter: &str,
        scope: ScopeId,
        read: &mut ConfigRead,
    ) {
        let vocabulary: &[String] = spec.and_then(|s| s.trigger_config.as_deref()).unwrap_or(&[]);
        if spec.is_some() && !vocabulary.contains(&arg.name) {
            let accepted = if vocabulary.is_empty() {
                " — they take no config".to_string()
            } else {
                format!(" — they accept: {}", vocabulary.join(", "))
            };
            self.report(
                codes::LISTEN_BAD_CONFIG,
                format!("'{adapter}' listeners do not accept a config key '{}'{accepted}", arg.name),
                arg.value.span,
            );
            return;
        }
        let raw = arg.value.raw.trim();
        if arg.is_type == Some(true) {
            self.report(
                codes::LISTEN_BAD_CONFIG,
                format!(
                    "'{}' takes a plain value — '<{raw}>' is a type reference, and listen config is quoted values: {}: \"{raw}\"",
                    arg.name, arg.name
                ),
                arg.value.span,
            );
            return;
        }
        let span = arg.value.span;
        if let Some([literal]) = static_string_values(&arg.value).as_deref()
            && !is_list_slot(&arg.value)
        {
            read.pins.retain(|(k, _)| k != &arg.name);
            read.pins.push((arg.name.clone(), literal.clone()));
        }
        if let Some(options) = spec.and_then(|s| s.trigger_config_options.as_ref()).and_then(|o| o.0.get(&arg.name)) {
            match static_string_values(&arg.value).filter(|_| is_list_slot(&arg.value)) {
                None => {
                    let example = options.first().map_or("\"…\"".to_string(), |o| format!("\"{o}\""));
                    let one_of = if options.is_empty() { String::new() } else { format!(" — one of: {}", options.join(", ")) };
                    self.report(
                        codes::LISTEN_BAD_CONFIG,
                        format!("'{}' is a list of events{one_of} — e.g. {}: [{example}]", arg.name, arg.name),
                        span,
                    );
                }
                Some(values) => {
                    read.selected = Some(values.clone());
                    for value in values.iter().filter(|v| !options.contains(v)) {
                        self.report(
                            codes::LISTEN_BAD_CONFIG,
                            format!("'{value}' is not an event '{adapter}' can subscribe to — one of: {}", options.join(", ")),
                            span,
                        );
                    }
                }
            }
        }
        let format = spec.and_then(|s| s.trigger_config_formats.as_ref()).and_then(|f| f.0.get(&arg.name)).copied();
        match format {
            Some(TriggerConfigFormat::Cron) => match static_string_values(&arg.value).as_deref() {
                Some([value]) => {
                    if let Some(error) = cron_schedule_error(value) {
                        self.report(
                            codes::LISTEN_BAD_CONFIG,
                            format!(
                                "'{value}' is not a valid schedule — {error}. Five fields: minute hour day-of-month month day-of-week, e.g. \"0 9 * * 1\" is 09:00 every Monday"
                            ),
                            span,
                        );
                    }
                }
                _ => self.report(
                    codes::LISTEN_BAD_CONFIG,
                    format!(
                        "'{}' takes one quoted cron expression — e.g. {}: \"0 9 * * 1\" (minute hour day-of-month month day-of-week, UTC unless a timezone is set)",
                        arg.name, arg.name
                    ),
                    span,
                ),
            },
            Some(TriggerConfigFormat::Timezone) => {
                match static_string_values(&arg.value).as_deref() {
                    Some([zone]) => {
                        if let Some(problem) = crate::host::time_zone_error(self.zones, zone) {
                            self.report(
                                codes::LISTEN_BAD_CONFIG,
                                format!("{problem}. The schedule then fires at that local wall-clock time, with daylight-savings handled for you"),
                                span,
                            );
                        }
                    }
                    _ => self.report(
                        codes::LISTEN_BAD_CONFIG,
                        format!("'{}' takes one quoted IANA time zone — e.g. {}: \"Europe/London\"", arg.name, arg.name),
                        span,
                    ),
                }
            }
            Some(TriggerConfigFormat::Strings) => {
                let values = static_string_values(&arg.value);
                let well_formed = is_list_slot(&arg.value)
                    && values.as_ref().is_some_and(|v| !v.is_empty() && v.iter().all(|s| !s.trim().is_empty()));
                if !well_formed {
                    self.report(
                        codes::LISTEN_BAD_CONFIG,
                        format!("'{}' is a non-empty list of quoted, non-empty names — e.g. {}: [\"…\"]", arg.name, arg.name),
                        span,
                    );
                    return;
                }
            }
            Some(TriggerConfigFormat::Fields) => {
                match bare_name_values(&arg.value) {
                    None => self.report(
                        codes::LISTEN_BAD_CONFIG,
                        format!("'{}' is a list of the watched type's properties, bare — e.g. {}: [domains]", arg.name, arg.name),
                        span,
                    ),
                    Some(names) => read.fields = Some((names, span)),
                }
                return;
            }
            None => {}
        }
        self.check_expr_slot(&arg.value, scope);
    }

    /// `checkCallback`: `callback({ … })` or `callback(movement, args…)`.
    /// Hands back the fire-time signature (`CallbackParams`).
    pub fn check_callback(&mut self, callback: &CallbackExpression, scope: ScopeId) -> Vec<(String, Option<Ty>)> {
        let params = match &callback.subject {
            CallbackSubject::Inline { closure, .. } => {
                // TODO(type-core): the TypeScript checks each parameter's type as
                // the closure declares it; here they are checked just before.
                let params = closure
                    .params
                    .iter()
                    .map(|param| (param.name.clone(), self.check_callback_param_type(param.type_.as_ref(), &param.name, Some(scope), None)))
                    .collect();
                let (_, suspends) = self.check_closure_walked(closure, scope, None, "a callback body", 0);
                if suspends {
                    self.refuse_unresumable_wait("a callback body", closure.span);
                }
                self.absorb_suspend(suspends);
                params
            }
            CallbackSubject::Named { movement, args, name_span, span } => self.check_callback_named(movement, args, *name_span, *span, scope),
        };
        self.check_callback_config(&callback.config, scope);
        params
    }

    /// `checkCallbackNamed`: a movement deferred by name; the parameters its
    /// arguments leave out are the callback's fire-time signature.
    fn check_callback_named(&mut self, movement: &str, args: &[CallArg], name_span: Span, span: Span, scope: ScopeId) -> Vec<(String, Option<Ty>)> {
        let callee = match self.scopes.resolve(scope, &self.callee_name(movement, scope)) {
            Resolution::Found(id) => Some(id),
            _ => None,
        };
        let kind = callee.map(|id| self.scopes.symbol(id).kind);
        if !matches!(kind, Some(SymbolKind::Movement | SymbolKind::FileImport)) {
            let message = match kind {
                None => format!(
                    "'{movement}' is not a movement in this file{} — a callback defers an inline body ('callback({{ … }})') or a movement by name",
                    did_you_mean(movement, &self.movement_names_in_scope(scope))
                ),
                Some(kind) => format!(
                    "'{movement}' is {}, not a movement — a callback defers an inline body ('callback({{ … }})') or a movement by name",
                    kind.describe()
                ),
            };
            self.report(codes::CALLBACK_NOT_MOVEMENT, message, name_span);
        }
        self.check_callback_suspends(movement, name_span, scope);
        self.check_callback_arguments(movement, args, span, scope);
        if kind != Some(SymbolKind::Movement) {
            return Vec::new();
        }
        let Some(info) = callee.and_then(|id| self.listens.movements.get(&id)) else { return Vec::new() };
        let params = info.params.clone();
        let mut supplied = HashSet::new();
        for (index, arg) in args.iter().enumerate() {
            match call_arg_name(arg) {
                Some(name) => {
                    supplied.insert(name.to_string());
                }
                None => {
                    if let Some(param) = params.get(index) {
                        supplied.insert(param.name.clone());
                    }
                }
            }
        }
        params
            .iter()
            .filter(|p| !supplied.contains(&p.name))
            .map(|param| (param.name.clone(), self.check_callback_param_type(param.type_.as_ref(), &param.name, None, Some(name_span))))
            .collect()
    }

    /// `checkCallbackParamType`: a fire-time parameter is one scalar a
    /// platform sends. `scope` is set when the callback declares it itself.
    /// The parameter's scalar type, when it has one.
    fn check_callback_param_type(&mut self, type_: Option<&ParamTypeRef>, name: &str, scope: Option<ScopeId>, at: Option<Span>) -> Option<Ty> {
        let type_ = type_?;
        let reference = match type_ {
            ParamTypeRef::Value(value) => {
                let message = format!(
                    "a callback's parameter '{name}' is a value the platform sends when the callback fires, one per control, so it has to be a single scalar type (<text>, <number>, <boolean>, <date>, <datetime>, <json>, <file>) — '<{}>' is more than one. Supply it as a fixed argument instead.",
                    spell_value_type(value)
                );
                self.report(codes::CALLBACK_PARAM_NOT_VALUE, message, at.unwrap_or(value_type_span(value)));
                return None;
            }
            ParamTypeRef::Name(reference) => reference,
        };
        if reference.hops_raw.is_none()
            && let Some(scalar) = parse_field_type_name(Some(&reference.graph))
        {
            return Some(Ty::from_schema(&scalar));
        }
        let span = at.unwrap_or(reference.span);
        if let Some(scope) = scope {
            self.resolve_name(&reference.graph, span, scope);
        }
        let message = format!(
            "a callback's parameter '{name}' is a value the platform sends when the callback fires, so it has to be a scalar type (<text>, <number>, <boolean>, <date>, <datetime>, <json>, <file>) — '<{}{}>' is a record position, which nothing can hand us. Supply it as a fixed argument instead.",
            reference.graph,
            reference.hops_raw.as_deref().unwrap_or("")
        );
        self.report(codes::CALLBACK_PARAM_NOT_VALUE, message, span);
        None
    }

    /// `checkCallbackConfig`: `{ once: <boolean>, ttl: <duration> }`, closed.
    fn check_callback_config(&mut self, config: &[NamedArg], scope: ScopeId) {
        let mut seen = HashSet::new();
        for entry in config {
            let raw = entry.value.raw.trim();
            if !seen.insert(entry.name.as_str()) {
                self.report(
                    codes::CALLBACK_BAD_CONFIG,
                    format!("Duplicate callback config '{}' — each setting is given once", entry.name),
                    entry.value.span,
                );
            }
            match entry.name.as_str() {
                "once" => match scalar_literal_kind(raw) {
                    Some(kind) if kind != "boolean" => self.report(
                        codes::CALLBACK_BAD_CONFIG,
                        format!("'once' says whether the callback may fire more than once — write TRUE or FALSE, not {raw}"),
                        entry.value.span,
                    ),
                    Some(_) => {}
                    None => self.check_expr_slot(&entry.value, scope),
                },
                "ttl" => {
                    if !is_valid_duration(raw) {
                        self.report(
                            codes::CALLBACK_BAD_CONFIG,
                            format!("'{raw}' is not a valid ttl — use unit-suffixed duration literals like 4h, 2d, 90m, 1h30m"),
                            entry.value.span,
                        );
                    }
                }
                other => self.report(
                    codes::CALLBACK_BAD_CONFIG,
                    format!(
                        "'{other}' is not a callback setting{} — a callback takes: {}",
                        did_you_mean(other, CALLBACK_CONFIG_KEYS),
                        CALLBACK_CONFIG_KEYS.join(", ")
                    ),
                    entry.value.span,
                ),
            }
        }
    }

    /// `movementNamesInScope`: innermost first, each once.
    fn movement_names_in_scope(&self, scope: ScopeId) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        let mut at = Some(scope);
        while let Some(id) = at {
            let s = self.scopes.scope(id);
            for symbol in s.symbols.values().map(|id| self.scopes.symbol(*id)) {
                if symbol.kind == SymbolKind::Movement && !names.contains(&symbol.name) {
                    names.push(symbol.name.clone());
                }
            }
            at = s.parent;
        }
        names
    }
}

fn call_arg_name(arg: &CallArg) -> Option<&str> {
    match arg {
        CallArg::Expr { name, .. }
        | CallArg::Write { name, .. }
        | CallArg::Node { name, .. }
        | CallArg::Call { name, .. }
        | CallArg::Closure { name, .. }
        | CallArg::Type { name, .. } => name.as_deref(),
    }
}

/// `scalarLiteralType`, as the kind's name: a bare literal's type.
fn scalar_literal_kind(raw: &str) -> Option<&'static str> {
    let upper = raw.to_uppercase();
    if upper == "TRUE" || upper == "FALSE" {
        return Some("boolean");
    }
    if upper == "NULL" {
        return None;
    }
    let digits = raw.strip_prefix('-').unwrap_or(raw);
    let (whole, fraction) = digits.split_once('.').map_or((digits, None), |(w, f)| (w, Some(f)));
    let all_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if all_digits(whole) && fraction.is_none_or(all_digits) {
        return Some("number");
    }
    if is_quoted(raw, '"') || is_quoted(raw, '\'') {
        return Some("text");
    }
    None
}

/// `/^"(?:[^"\\]|\\.)*"$/` for either quote.
fn is_quoted(raw: &str, quote: char) -> bool {
    let Some(inner) = raw.strip_prefix(quote).and_then(|r| r.strip_suffix(quote)) else { return false };
    if raw.len() < 2 {
        return false;
    }
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == quote {
            return false;
        }
        if c == '\\' && chars.next().is_none() {
            return false;
        }
    }
    true
}

/// `isValidDuration`: `4h`, `2d`, `90m`, `1h30m`.
pub fn is_valid_duration(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut i = 0;
    while i < bytes.len() {
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start || i >= bytes.len() || !b"smhdw".contains(&bytes[i]) {
            return false;
        }
        i += 1;
    }
    true
}

/// `staticStringValues`: a string literal, or a list of them.
fn static_string_values(slot: &ExprSlot) -> Option<Vec<String>> {
    let string_of = |e: &Expression| match e {
        Expression::Static { value: StaticValue::String(s) } => Some(s.clone()),
        _ => None,
    };
    match expression_of_slot(slot).ok()? {
        Expression::List { elements } => elements
            .iter()
            .map(|element| match element {
                ListElement::Expression(e) => string_of(e),
                ListElement::Spread(_) => None,
            })
            .collect(),
        parsed => string_of(&parsed).map(|s| vec![s]),
    }
}

/// `isListSlot`: written as a bracketed list.
fn is_list_slot(slot: &ExprSlot) -> bool {
    matches!(expression_of_slot(slot), Ok(Expression::List { .. }))
}

/// `bareNameValues`: a bare name, or a list of them.
fn bare_name_values(slot: &ExprSlot) -> Option<Vec<String>> {
    let trimmed = slot.raw.trim();
    if is_bare_ident(trimmed) {
        return Some(vec![trimmed.to_string()]);
    }
    let Expression::List { elements } = expression_of_slot(slot).ok()? else { return None };
    elements
        .iter()
        .map(|element| match element {
            ListElement::Expression(Expression::Property { property_type_id }) => Some(property_type_id.clone()),
            _ => None,
        })
        .collect()
}

/// `spellParamType`: a parameter's type as written, without the brackets.
pub fn spell_param_type(type_: &ParamTypeRef) -> String {
    match type_ {
        ParamTypeRef::Value(value) => spell_value_type(value),
        ParamTypeRef::Name(reference) => format!("{}{}", reference.graph, reference.hops_raw.as_deref().unwrap_or("")),
    }
}

/// `spellValueType`.
pub fn spell_value_type(type_: &ValueType) -> String {
    match type_ {
        ValueType::Name { name, .. } => name.clone(),
        ValueType::List { of, .. } => match of.as_ref() {
            ValueType::Closure { .. } => format!("<{}>[]", spell_value_type(of)),
            _ => format!("{}[]", spell_value_type(of)),
        },
        ValueType::Record { keys, .. } => {
            let keys: Vec<String> = keys
                .iter()
                .map(|k| format!("{}{}: {}", k.name, if k.optional == Some(true) { "?" } else { "" }, spell_value_type(&k.type_)))
                .collect();
            format!("{{ {} }}", keys.join(", "))
        }
        ValueType::Closure { params, returns, .. } => {
            let params: Vec<String> = params
                .iter()
                .map(|p| format!("{}: <{}>", p.name, p.type_.as_ref().map_or("?".to_string(), spell_param_type)))
                .collect();
            format!("({}) => <{}>", params.join(", "), spell_param_type(returns))
        }
    }
}

fn value_type_span(type_: &ValueType) -> Span {
    match type_ {
        ValueType::Name { span, .. } | ValueType::List { span, .. } | ValueType::Record { span, .. } | ValueType::Closure { span, .. } => *span,
    }
}

/// `surfaceNotEnumerated`: a position whose fields nobody listed.
fn surface_not_enumerated(position: &movement_parser::catalog::types::PositionSchema) -> bool {
    position.open_properties == Some(true) || position.undescribed == Some(true) || position.pending == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_a_movement_name() {
        assert_eq!(suggested_listen_key("Log Sender"), "log-sender");
        assert_eq!(suggested_listen_key("  "), "intake");
        assert_eq!(suggested_listen_key("a__b9"), "a-b9");
    }

    #[test]
    fn reads_durations_and_literals() {
        assert!(is_valid_duration("1h30m"));
        assert!(!is_valid_duration("1x"));
        assert!(!is_valid_duration("h"));
        assert_eq!(scalar_literal_kind("-3.5"), Some("number"));
        assert_eq!(scalar_literal_kind("\"x\""), Some("text"));
        assert_eq!(scalar_literal_kind("yes"), None);
    }
}

/// `callbackType`: a callback is a local node with `.id` / `.url` reads and an
/// awaitable `Called` edge, landing on the call — `At` plus one field per
/// typed fire-time parameter.
pub fn callback_type(params: Vec<(String, Option<Ty>)>) -> Position {
    let mut fields = IndexMap::new();
    fields.insert("At".to_string(), Some(Ty::Datetime));
    for (name, ty) in params {
        if let Some(ty) = ty {
            fields.insert(name, Some(ty));
        }
    }
    let call = Position::Local(LocalNode { label: "a callback's call".to_string(), reads: fields, edges: None, run_built: None, extracted: None });
    let schema = EdgeSchema {
        target: "Called".to_string(),
        awaitable: Some(true),
        watchable: Some(true),
        resolves_empty: Some(true),
        sequenced: Some(movement_parser::catalog::types::EdgeSequencing::Arrival),
        ..crate::types::position::edge_schema_to("Called")
    };
    let mut edges = IndexMap::new();
    edges.insert("Called".to_string(), LocalEdge { schema, target: Some(call), structural: false, deferred: false, references: false });
    let reads = IndexMap::from([("id".to_string(), Some(Ty::Text)), ("url".to_string(), Some(Ty::Text))]);
    Position::Local(LocalNode { label: "a callback".to_string(), reads, edges: Some(edges), run_built: None, extracted: None })
}
