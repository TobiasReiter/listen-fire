//! The extraction family: `extract from [ … ] { … }` and its `through [ … ]`
//! stages, the `extract(…)` / `extractOne(…)` calls, a plugin called on its
//! own, what an extracted field reads as, and the resource walks. Its codes
//! (PORT.md has where the TypeScript raises each):
//!
//! - MOV_CHUNKS_NOT_TEXT
//! - MOV_EXTRACT_ANNOTATE
//! - MOV_EXTRACT_CALL_NESTED
//! - MOV_EXTRACT_CONFIG
//! - MOV_EXTRACT_CONTENT
//! - MOV_EXTRACT_FIELD_DUPLICATE
//! - MOV_EXTRACT_NEEDS_ANNOTATION
//! - MOV_EXTRACT_SHAPE_COMPUTED
//! - MOV_EXTRACT_SHAPE_NOT_DECLARED
//! - MOV_EXTRACT_TYPE_CONFLICT
//! - MOV_EXTRACT_UNKNOWN_FIELD
//! - MOV_PLUGIN_FED_BY_EXTRACTION
//! - MOV_READ_NOT_FILE
//! - MOV_RESOURCES_NOT_EXTRACTED
//! - MOV_RESOURCE_READ_RETIRED
//! - MOV_RESOURCE_WALK_UNREAD
//! - MOV_THROUGH_ARG_MISSING
//! - MOV_THROUGH_BAD_ARG
//! - MOV_THROUGH_FORWARD_REF
//! - MOV_THROUGH_NOT_PLUGIN

use std::collections::HashSet;

use std::rc::Rc;

use indexmap::IndexMap;
use movement_parser::ast::{
    DeclaredExtractNode, ExtractCallExpression, ExtractCallFinds, ExtractCallShape, ExtractNode, ExtractStage, PluginCall,
    ShapeDeclaration, ShapeNode, Span,
};

use crate::checker::{Checker, SlotOptions};
use crate::families::nodes::place_in_input;
use crate::types::field::{HandleKinds, HeldHandle, HeldStep, spell_held_steps};
use crate::codes;
use crate::scope::{Resolution, ScopeId, SymbolId, SymbolKind};
use crate::meta::did_you_mean;
use crate::slots::{expression_of_slot, is_bare_ident, is_literal_word};
use crate::diagnostic::{Diagnostic, Severity};
use crate::types::Typing;
use crate::types::field::{BaseKind, Ty, base_kind, describe_field_type, field_assignable, field_type_compatible, maybe_absent, strip_absent, unwrap_list};
use crate::types::position::EXTRACT_ROOT_NAME;
use movement_parser::ast::ExprSlot;
use movement_parser::ast::{PathHead, PathRoot};
use movement_parser::catalog::types::InstanceSchema;
use movement_parser::lowering::vocabulary::{OptionType, OptionsContract, vocabulary};
use movement_parser::tree::{Hop, MExpr};
use crate::families::names::spell_name;
use crate::types::field::record_head_position;
use crate::types::position::describe_position;
use movement_parser::lowering::expression::{Expression, ObjectMember, StaticValue};
use crate::types::position::{ExtractField, ExtractNode as ExtractNodeType, LocalEdge, LocalNode, Position};

impl Checker<'_> {
    /// `checkExtractInput`: one input of `extract from [ … ]`, against what
    /// the prompt is built of. An input is text, a file (read as a file), a
    /// record (rendered as its fields — the fields in hand), or a map or list
    /// of those; a list's members are inputs of their own. A file anywhere
    /// below an input would reach the prompt as the engine's own descriptor.
    pub(crate) fn check_extract_input(&mut self, slot: &ExprSlot, scope: ScopeId) {
        let purpose = format!("hands it to an extraction as an input, which reads every field (line {})", slot.span.start.line);
        let locals = self.nodes.local_symbols();
        let inspect: crate::checker::SlotInspect = Rc::new(move |found: HeldHandle, shape: Option<&Ty>| {
            if !found.is_file() {
                return crate::families::plugin_calls::record_as_fields_problem(found, &purpose, &|symbol| locals.contains(&symbol));
            }
            // A file is an input of its own: the value itself, or a member of
            // the list it is (a list's members are inputs).
            let items = usize::from(shape.is_some_and(|shape| matches!(strip_absent(shape), Ty::List { .. } | Ty::Tuple { .. })));
            let own = found.steps.len() <= items && found.steps.iter().all(|step| !matches!(step, HeldStep::Key(_)));
            if own { None } else { Some(found) }
        });
        let options = SlotOptions { held_takes: Some(HandleKinds { record: true, file: true }), inspect_held: Some(&inspect), ..SlotOptions::default() };
        let Some(found) = self.check_expr_slot_with(slot, scope, options).held else { return };
        let written = slot.raw.trim();
        if found.is_file() {
            let own = if is_bare_ident(written) { format!(" (`from [{written}{}]`)", spell_held_steps(&found.steps)) } else { String::new() };
            let repair = match found.steps.last() {
                Some(HeldStep::Key(key)) => format!("'{key}: READ(f)'"),
                _ => "'READ(f)'".to_string(),
            };
            self.report(
                codes::EXTRACT_CONTENT,
                format!(
                    "An extraction reads a file only as an input of its own, and {} — a file, not a value. Hand it over as its own input{own}, or put its text in its place ({repair})",
                    place_in_input(written, &found, "a file")
                ),
                slot.span,
            );
            return;
        }
        let Ty::Record(Some(position)) = strip_absent(&found.handle) else { return };
        let message = if matches!(**position, Position::Meta { .. }) {
            format!(
                "An extraction reads text, files and records, and {} — a connection, not a record. Pass a record read through it, or the fields you want ('{{ name: r.name, … }}')",
                place_in_input(written, &found, &describe_position(position))
            )
        } else {
            format!(
                "An extraction reads a record as its fields, and {}, whose fields are read from its system one at a time. Pass a dict of the fields it needs in its place ('{{ name: r.name, … }}')",
                place_in_input(written, &found, &describe_position(position))
            )
        };
        self.report(codes::EXTRACT_CONTENT, message, slot.span);
    }
}

/// `ThroughFieldsContext`: the names a `through` stage's arguments may read
/// besides the scope's — the fields of the node's earlier stages and its
/// ancestors' — and the ones they may not yet: this stage's and later ones'.
#[derive(Default)]
pub struct ThroughFields {
    pub prior: HashSet<String>,
    pub own_or_later: HashSet<String>,
}

impl Checker<'_> {
    /// `resolveNameWithFields`: a name a stage's argument reads may be a field
    /// an earlier stage extracted; one this stage or a later one extracts is
    /// read before it exists.
    pub fn resolve_name_with_fields(&mut self, name: &str, span: Span, scope: ScopeId, fields: Option<&ThroughFields>) {
        if let Some(fields) = fields {
            if fields.prior.contains(name) {
                return;
            }
            if fields.own_or_later.contains(name) {
                self.report(
                    codes::THROUGH_FORWARD_REF,
                    format!("'{name}' is extracted by this stage (or a later one) — a 'through' pipeline runs before its stage, so it can only read fields from the node's earlier stages"),
                    span,
                );
                return;
            }
        }
        self.resolve_name(name, span, scope);
    }

    /// `checkExtractStages`: each stage's `through` calls may read the fields
    /// of the stages before it (and the ancestors'); its fields are named once;
    /// a field and a child node never share a name; a child taking a declared
    /// shape names a declaration, whose fields its later stages may read.
    /// Descriptions are checked as any string slot, against the scope.
    pub fn check_extract_stages(&mut self, stages: &[ExtractStage], scope: ScopeId, inherited: &HashSet<String>, declared: Option<&ShapeNode>) {
        let stage_fields: Vec<&movement_parser::ast::ExtractField> = stages.iter().flat_map(|s| &s.fields).collect();
        let stage_children: Vec<(&str, Span)> = stages.iter().flat_map(|s| &s.children).map(extract_node_name_span).collect();
        let mut field_names: Vec<&str> = declared.map(|d| d.fields.iter().map(|f| f.name.as_str()).collect()).unwrap_or_default();
        field_names.extend(stage_fields.iter().map(|f| f.name.as_str()));
        self.check_field_child_names_apart(field_names.iter().copied(), stage_children.iter().copied());
        let declared_children: Vec<(&str, Span)> = declared.map(|d| d.children.iter().map(|c| (c.name.as_str(), c.span)).collect()).unwrap_or_default();
        let own_names: Vec<&str> = stage_fields.iter().map(|f| f.name.as_str()).collect();
        self.check_field_child_names_apart(own_names.iter().copied(), declared_children.iter().copied());

        let mut prior = inherited.clone();
        for (k, stage) in stages.iter().enumerate() {
            let own_or_later: HashSet<String> = stages[k..].iter().flat_map(|s| &s.fields).map(|f| f.name.clone()).collect();
            for plugin in stage.through.iter().flatten() {
                let fields = ThroughFields { prior: prior.clone(), own_or_later: own_or_later.clone() };
                self.check_plugin_stage(plugin, scope, &fields);
            }
            self.check_no_prototype_name(stage.fields.iter().map(|f| (f.name.as_str(), f.span)).chain(stage.children.iter().map(extract_node_name_span)));
            let mut seen = HashSet::new();
            for field in &stage.fields {
                if !seen.insert(field.name.as_str()) {
                    self.report(
                        codes::EXTRACT_FIELD_DUPLICATE,
                        format!("'{}' is declared twice in this node — each field names one thing", field.name),
                        field.span,
                    );
                }
                self.check_expr_slot(&field.description, scope);
            }
            prior.extend(stage.fields.iter().map(|f| f.name.clone()));
            for child in &stage.children {
                match child {
                    ExtractNode::Inline(node) => {
                        self.check_expr_slot(&node.description, scope);
                        self.check_extract_stages(&node.stages, scope, &prior, None);
                    }
                    ExtractNode::Declared(node) => {
                        if let Some(description) = &node.description {
                            self.check_expr_slot(description, scope);
                        }
                        // The declaration is the node's first stage; the
                        // `through` stages after it may read its fields.
                        let shape = self.resolve_extract_shape(node, scope);
                        let mut inherited = prior.clone();
                        if let Some(shape) = &shape {
                            inherited.extend(shape.root.fields.iter().map(|f| f.name.clone()));
                        }
                        self.check_extract_stages(&node.stages, scope, &inherited, shape.as_ref().map(|s| &s.root));
                    }
                }
            }
        }
    }

    /// The declaration a symbol names (`declaredExtractShape`): its tree with
    /// `extends` folded in, and its settled schema. A second name for one
    /// (`S = Company`) carries it too.
    pub fn declared_extract_shape(&self, id: SymbolId) -> Option<crate::families::nodes::Declared> {
        if !matches!(self.scopes.symbol(id).kind, SymbolKind::Shape | SymbolKind::Binding) {
            return None;
        }
        self.nodes.declared(id).cloned()
    }

    /// `S = Company`: from version 3 a declaration's name read as a value is
    /// the shape itself, a second name for it. The TypeScript binds the name
    /// as a shape (`kind: 'shape'`); here it stays a binding that carries the
    /// declaration, which only an extraction reads.
    pub fn note_shape_alias(&mut self, name: &str, value: &movement_parser::ast::RValue, scope: ScopeId) {
        let movement_parser::ast::RValue::Expr { expr } = value else { return };
        let written = expr.raw.trim();
        if self.version < 3 || !is_bare_ident(written) {
            return;
        }
        let Resolution::Found(shape) = self.scopes.resolve(scope, written) else { return };
        if self.scopes.symbol(shape).kind != SymbolKind::Shape {
            return;
        }
        if let Some(alias) = self.scopes.scope(scope).symbols.get(name).copied() {
            self.nodes.adopt(alias, shape);
        }
    }

    /// `resolveExtractShape`: the declaration `node entry: <Entry>` takes as
    /// its shape, refused with the fix when the name is not one.
    fn resolve_extract_shape(&mut self, node: &movement_parser::ast::DeclaredExtractNode, scope: ScopeId) -> Option<ShapeDeclaration> {
        let (type_, span) = (&node.declared.type_, node.declared.span);
        let id = match self.scopes.resolve(scope, type_) {
            Resolution::Found(id) => id,
            failure => {
                self.report_resolution_failure(type_, span, failure);
                return None;
            }
        };
        let shape = self.declared_extract_shape(id).map(|d| d.declaration);
        if shape.is_none() {
            let kind = self.scopes.symbol(id).kind.describe();
            self.report(
                codes::EXTRACT_SHAPE_NOT_DECLARED,
                format!(
                    "'{type_}' is {kind}, not a node declaration — an extraction node takes its shape from a declared node ('node {type_}: \"…\" {{ … }}' at the top of the file), or spells its fields inline ('node {}: \"…\" {{ … }}')",
                    node.name
                ),
                span,
            );
        }
        shape
    }

    /// `bindPluginStage` (version 5): a stage's arguments by position, as the
    /// named ones versions 1–4 write, each misfit reported. A stage still
    /// written with named arguments leaves the plugin's order for the
    /// parser's finding's fix.
    fn bind_plugin_stage(&mut self, plugin: &PluginCall, spec: Option<&movement_parser::catalog::types::PluginSpec>) -> Vec<movement_parser::ast::NamedArg> {
        let Some(spec) = spec.filter(|_| movement_parser::version::since(self.version, 5)) else { return plugin.args.clone() };
        use movement_parser::catalog::plugin_args::PluginCallSite;
        if let Some(first) = plugin.args.first() {
            let at = first.value.span.start;
            self.named_orders.insert((at.line, at.col), crate::families::plugin_calls::plugin_arg_order(spec, PluginCallSite::Stage));
        }
        let bound = spec.bind_stage_args(plugin);
        let positional = spec.positional_params(PluginCallSite::Stage);
        for misfit in &bound.misfits {
            self.report(codes::THROUGH_BAD_ARG, misfit.message(&plugin.plugin, &positional), misfit.span());
        }
        bound.args
    }

    /// `checkPluginCall`: one `through` stage — a plugin, called on what the
    /// extraction feeds it and the arguments written.
    fn check_plugin_stage(&mut self, plugin: &PluginCall, scope: ScopeId, fields: &ThroughFields) {
        let spec = match self.scopes.resolve(scope, &plugin.plugin) {
            Resolution::Found(id) => {
                let symbol = self.scopes.symbol(id);
                if symbol.kind == SymbolKind::Plugin {
                    let name = symbol.imported_name.clone().unwrap_or_else(|| plugin.plugin.clone());
                    self.catalog.plugin(&name)
                } else {
                    let kind = symbol.kind.describe();
                    self.report(
                        codes::THROUGH_NOT_PLUGIN,
                        format!("'{}' is {kind}, not a plugin — 'through […]' takes imported plugins", plugin.plugin),
                        plugin.span,
                    );
                    None
                }
            }
            Resolution::Unknown if let Some(message) = self.unknown_package_member(&plugin.plugin) => {
                self.report(codes::V5_UNKNOWN_MEMBER, message, plugin.span);
                None
            }
            failure => {
                self.report_resolution_failure(&plugin.plugin, plugin.span, failure);
                None
            }
        };
        let spec = spec.cloned();
        // A stage is the same call as a plain one, in the position that
        // feeds the extraction: it folds the same row (only waiting is modelled).
        if let Some(effects) = spec.as_ref().and_then(|s| s.effects.as_ref()) {
            self.absorb_suspend(effects.suspend == Some(true));
        }
        let args = self.bind_plugin_stage(plugin, spec.as_ref());
        let supplied: HashSet<&str> = args.iter().map(|a| a.name.as_str()).collect();
        self.report_plugin_missing_args(&plugin.plugin, spec.as_ref(), &supplied, plugin.span);
        for arg in &args {
            self.report_plugin_bad_arg(&plugin.plugin, spec.as_ref(), &arg.name, arg.value.span, false);
            // Held to what the plugin takes exactly as a plain call's argument is.
            let declared = spec.as_ref().and_then(|s| s.arg_types.as_ref()).and_then(|t| t.0.get(&arg.name));
            let held_takes = Some(crate::families::plugin_calls::plugin_arg_held_takes(declared));
            let typed = self.check_expr_slot_with(&arg.value, scope, SlotOptions { fields: Some(fields), held_takes, ..SlotOptions::default() });
            let record = self.bare_slot_position_type(&arg.value, scope).or_else(|| crate::types::field::record_in(typed.ty.as_ref()).flatten());
            self.check_plugin_arg_value(crate::families::plugin_calls::PluginArg {
                callee: &plugin.plugin,
                declared,
                name: &arg.name,
                record: record.as_ref(),
                value: typed.ty.as_ref(),
                held: typed.held,
                may_hold: typed.may_hold.as_ref(),
                span: arg.value.span,
            });
        }
    }
}

fn extract_node_name_span(node: &ExtractNode) -> (&str, Span) {
    match node {
        ExtractNode::Inline(n) => (n.name.as_str(), n.span),
        ExtractNode::Declared(n) => (n.name.as_str(), n.span),
    }
}

// ── The extract result graph: what an extraction hands back ──

/// One extracted field as typing reads it.
fn extract_field(explicit: Option<Ty>, annotated: bool, nullable: bool, span: Span) -> ExtractField {
    let reads_as_present_text = !nullable && (matches!(explicit, Some(Ty::Text)) || (explicit.is_none() && !annotated));
    ExtractField { explicit, reads_as_present_text, annotated, span, suggested: Default::default() }
}

fn empty_extract_node(name: &str) -> ExtractNodeType {
    ExtractNodeType { name: name.to_string(), properties: Default::default(), children: Default::default(), declared: false }
}

/// `shapeExtractGraph`: one node of a declaration, read as the extract node
/// it describes; `key` is its position in the declaration's schema
/// (`Entry.founder`). The schema carries `<T | null>` as `T | absent`; an
/// extraction keeps the surface type and the author's `| null` apart.
fn shape_extract_graph(name: &str, shape: &ShapeNode, key: &str, schema: &InstanceSchema) -> ExtractNodeType {
    let mut graph = empty_extract_node(name);
    for child in &shape.children {
        graph.children.insert(child.name.clone(), Rc::new(shape_extract_graph(&child.name, child, &format!("{key}.{}", child.name), schema)));
    }
    let properties = schema.positions.get(key).map(|p| &p.properties);
    for field in &shape.fields {
        let explicit = properties.and_then(|p| p.get(&field.name)).map(|t| strip_absent(&Ty::from_schema(t)).clone());
        graph.properties.insert(field.name.clone(), extract_field(explicit, true, field.nullable == Some(true), field.span));
    }
    graph
}

impl Checker<'_> {
    /// `buildExtractGraph`, the typing half: every field a node declares
    /// across its stages (a later stage's re-declaration wins), and its nested
    /// nodes.
    pub fn extract_graph(&self, name: &str, stages: &[ExtractStage], scope: ScopeId) -> ExtractNodeType {
        let mut node = empty_extract_node(name);
        self.apply_extract_stages(&mut node, stages, scope);
        node
    }

    fn apply_extract_stages(&self, node: &mut ExtractNodeType, stages: &[ExtractStage], scope: ScopeId) {
        for stage in stages {
            for child in &stage.children {
                let (name, graph) = match child {
                    ExtractNode::Inline(inline) => (&inline.name, self.extract_graph(&inline.name, &inline.stages, scope)),
                    ExtractNode::Declared(declared) => (&declared.name, self.declared_extract_graph(declared, scope)),
                };
                node.children.insert(name.clone(), Rc::new(graph));
            }
            for field in &stage.fields {
                let explicit = field.type_.as_deref().and_then(|t| self.annotation_type(t, scope));
                node.properties.insert(field.name.clone(), extract_field(explicit, field.type_.is_some(), field.nullable == Some(true), field.span));
            }
        }
    }

    /// `declaredExtractGraph`: a node taking a declaration as its shape — the
    /// declaration is its first stage, the `through` stages apply on top.
    fn declared_extract_graph(&self, node: &DeclaredExtractNode, scope: ScopeId) -> ExtractNodeType {
        let (declared, known) = match self.scopes.resolve(scope, &node.declared.type_) {
            // A declaration whose schema is not known here (one imported
            // from a file this check did not read) reads untyped.
            Resolution::Found(id) => (self.declared_extract_shape(id), self.scopes.symbol(id).kind != SymbolKind::Shape || self.nodes.declared(id).is_some()),
            _ => (None, true),
        };
        let mut graph = match declared {
            Some(d) => shape_extract_graph(&node.name, &d.declaration.root, &d.declaration.name, &d.instance.schema),
            None => empty_extract_node(&node.name),
        };
        graph.declared = !known;
        self.apply_extract_stages(&mut graph, &node.stages, scope);
        graph
    }

    /// What `extract(…)` / `extractOne(…)` hands back: the shape's records, in
    /// the order the content gave them, or the one it describes (or none).
    pub fn extract_call_type(&self, call: &ExtractCallExpression, scope: ScopeId) -> Option<Ty> {
        let node = match &call.shape {
            ExtractCallShape::Named { name, .. } => match self.scopes.resolve(scope, name) {
                Resolution::Found(id) => {
                    let d = self.declared_extract_shape(id)?;
                    shape_extract_graph(&d.declaration.name, &d.declaration.root, &d.declaration.name, &d.instance.schema)
                }
                _ => return None,
            },
            ExtractCallShape::Inline { declaration, .. } => {
                let schema = self.settled_schema_of(declaration, scope);
                shape_extract_graph(&declaration.name, &declaration.root, &declaration.name, &schema)
            }
            ExtractCallShape::Computed { .. } => return None,
        };
        let record = Ty::record(Some(extracted_record_type(&node)));
        Some(match call.finds {
            ExtractCallFinds::Each => Ty::list(record),
            ExtractCallFinds::One => maybe_absent(record),
        })
    }
}

/// `extractedRecordType`: one record `extract(content, Shape)` hands back — a
/// run-local record whose fields read by the keyword's rule, each nested
/// node an edge of records of its own, in the content's order.
fn extracted_record_type(node: &ExtractNodeType) -> Position {
    let mut reads = IndexMap::new();
    let mut fields = IndexMap::new();
    for (name, field) in &node.properties {
        fields.insert(name.clone(), field.explicit.clone().unwrap_or(Ty::Text));
        let read = if field.reads_as_present_text { Some(Ty::Text) } else { field.explicit.clone().map(maybe_absent) };
        reads.insert(name.clone(), read);
    }
    let mut edges = IndexMap::new();
    for (name, child) in &node.children {
        let schema = serde_json::from_value(serde_json::json!({ "target": name, "readable": true, "sequenced": "document" }))
            .unwrap_or_else(|_| crate::types::position::edge_schema_to(name));
        edges.insert(name.clone(), LocalEdge { schema, target: Some(extracted_record_type(child)), structural: true, deferred: false, references: false });
    }
    Position::Local(LocalNode { label: format!("an extracted '{}' record", node.name), reads, edges: Some(edges), run_built: None, extracted: Some(fields) })
}

// ── The extraction call: `extract(content, Shape, { … })` ──

/// The settings `extract(…)` takes, each with what it is for (extract_config.ts `SETTINGS`).
const SETTINGS: &[(&str, &str)] = &[
    ("tier", "how much the job is worth: 'quick', 'careful', 'thorough'"),
    ("model", "a model this deployment can reach, by its name ('claude-opus-5'), in place of the tier's"),
    ("effort", "how hard that model thinks: 'low', 'medium', 'high', 'xhigh', in place of the tier's"),
];
const AI_TIERS: &[&str] = &["quick", "careful", "thorough"];
const AI_TIER_ALIASES: &[&str] = &["smart"];
const AI_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh"];

impl Checker<'_> {
    /// `checkExtractCall`: the content, the settings, and the shape.
    pub fn check_extract_call(&mut self, call: &ExtractCallExpression, scope: ScopeId) {
        self.check_extract_call_content(&call.content, scope);
        if let Some(config) = &call.config {
            self.check_extract_call_config(config);
        }
        self.resolve_extract_call_shape(&call.shape, scope);
    }

    /// `resolveExtractCallShape`: the declaration the shape argument names or
    /// writes in place — refused, with the fix, when it is anything else.
    fn resolve_extract_call_shape(&mut self, shape: &ExtractCallShape, scope: ScopeId) {
        match shape {
            ExtractCallShape::Inline { declaration, .. } => {
                // Written in the argument, it names the shape for this call and nothing after it.
                let own = self.scopes.open(Some(scope));
                self.check_statement(&movement_parser::ast::Statement::Shape(declaration.clone()), own);
            }
            ExtractCallShape::Named { name, span } => {
                let id = match self.scopes.resolve(scope, name) {
                    Resolution::Found(id) => id,
                    failure => return self.report_resolution_failure(name, *span, failure),
                };
                let kind = self.scopes.symbol(id).kind;
                if self.declared_extract_shape(id).is_none() && kind != SymbolKind::Shape {
                    self.report(
                        codes::EXTRACT_SHAPE_COMPUTED,
                        format!(
                            "'{name}' is {}, and 'extract' takes a node declaration — the records it hands back are of that shape, so the shape has to be known when the program is checked. Declare it (`node {name}: \"…\" {{ … }}`) and pass its name, or write it in place.",
                            kind.describe()
                        ),
                        *span,
                    );
                }
            }
            ExtractCallShape::Computed { expr, span } => {
                self.check_expr_slot(expr, scope);
                self.report(
                    codes::EXTRACT_SHAPE_COMPUTED,
                    "'extract' takes a node declaration by its name (`extract(content, Company)`) or written in place (`extract(content, node Company: \"…\" { … })`) — the records it hands back are of that shape, so a shape worked out at run time types nothing",
                    *span,
                );
            }
        }
    }

    /// `checkExtractCallContent`: the content is a list of text and files. It
    /// is held, not read, so each item is judged on its own.
    fn check_extract_call_content(&mut self, content: &ExprSlot, scope: ScopeId) {
        let typed = self.check_expr_slot_as(content, scope, true);
        let written = content.raw.trim();
        let name = if is_bare_ident(written) && !is_literal_word(written) {
            Some(written)
        } else {
            typed.expr.as_ref().and_then(crate::types::narrowing::bare_name)
        };
        if let Some(name) = name
            && self.is_node_plane_name(name, scope)
        {
            self.report(
                codes::EXTRACT_CONTENT,
                format!("'{written}' is a record, and 'extract' reads text and files — render it as text and put it in the content list: `extract([TEXT.SERIALISE({written}, 'JSON')], …)`"),
                content.span,
            );
            return;
        }
        let Some(ty) = typed.ty else { return };
        if let Some(problem) = extract_content_problem(&ty, written) {
            self.report(codes::EXTRACT_CONTENT, problem, content.span);
        }
    }

    /// `nodePlaneSymbol`: whether `name` is bound to a record rather than a value.
    fn is_node_plane_name(&self, name: &str, scope: ScopeId) -> bool {
        let Resolution::Found(id) = self.scopes.resolve(scope, name) else { return false };
        let symbol = self.scopes.symbol(id);
        symbol.types.pos.is_some() || symbol.types.is_record || symbol.is_closure
    }

    /// `checkExtractCallConfig`: the settings record is read, not typed.
    fn check_extract_call_config(&mut self, config: &ExprSlot) {
        let parsed = match expression_of_slot(config) {
            Ok(parsed) => parsed,
            Err(error) => return self.report_slot_error(&error, config),
        };
        for problem in read_extract_call_config(&parsed, self.catalog.models()) {
            self.report(codes::EXTRACT_CONFIG, problem, config.span);
        }
    }
}

/// `readExtractCallConfig`, its problems: the settings written out one by
/// one, each a word written down, each one the platform knows.
fn read_extract_call_config(record: &Expression, models: Option<&[String]>) -> Vec<String> {
    let inventory = SETTINGS.iter().map(|(key, summary)| format!("{key} — {summary}")).collect::<Vec<_>>().join("; ");
    let Expression::Object { entries } = record else {
        return vec![format!(
            "'extract' takes its settings as a record written in place — `extract(content, Shape, {{ tier: 'careful' }})`. The settings are: {inventory}"
        )];
    };
    let keys: Vec<&str> = SETTINGS.iter().map(|(key, _)| *key).collect();
    let mut problems = Vec::new();
    let mut written: Vec<(&str, &Expression)> = Vec::new();
    for entry in entries {
        match entry {
            ObjectMember::Spread(_) => {
                problems.push(format!("'extract' takes its settings written out one by one — a spread ('...') is not accepted here. The settings are: {inventory}"))
            }
            ObjectMember::Entry { key, .. } if !keys.contains(&key.as_str()) => {
                problems.push(format!("'extract' has no setting '{key}'{}. The settings are: {inventory}", did_you_mean(key, &keys)))
            }
            ObjectMember::Entry { key, .. } if written.iter().any(|(k, _)| k == key) => problems.push(format!("'extract' is given '{key}' twice — write it once")),
            ObjectMember::Entry { key, value } => written.push((key, value)),
        }
    }
    let word = |key: &str, problems: &mut Vec<String>| -> Option<String> {
        let (_, value) = written.iter().find(|(k, _)| *k == key)?;
        match value {
            Expression::Static { value: StaticValue::String(word) } => Some(word.clone()),
            _ => {
                problems.push(format!("'extract': '{key}' is written down, not worked out — write {key}: '…' as a quoted word"));
                None
            }
        }
    };
    let quoted = |words: &[&str]| words.iter().map(|w| format!("'{w}'")).collect::<Vec<_>>().join(", ");
    if let Some(tier) = word("tier", &mut problems)
        && !AI_TIERS.contains(&tier.as_str())
        && !AI_TIER_ALIASES.contains(&tier.as_str())
    {
        problems.push(format!("'extract': there is no tier '{tier}'{} — write one of {}", did_you_mean(&tier, AI_TIERS), quoted(AI_TIERS)));
    }
    if let Some(effort) = word("effort", &mut problems)
        && !AI_EFFORTS.contains(&effort.as_str())
    {
        problems.push(format!("'extract': there is no effort '{effort}'{} — write one of {}", did_you_mean(&effort, AI_EFFORTS), quoted(AI_EFFORTS)));
    }
    if let Some(model) = word("model", &mut problems)
        && let Some(models) = models
        && !models.contains(&model)
    {
        problems.push(if models.is_empty() {
            format!("'extract': this deployment reaches no model it can name, so '{model}' cannot be asked for here — drop 'model' and let the tier choose")
        } else {
            let reached = models.iter().map(|m| format!("'{m}'")).collect::<Vec<_>>().join(", ");
            format!("'extract': '{model}' is not a model this deployment reaches{} — it reaches {reached}", did_you_mean(&model, models))
        });
    }
    problems
}

/// `extractContentProblem`: why `extract` cannot read this content as it is.
fn extract_content_problem(ty: &Ty, written: &str) -> Option<String> {
    match strip_absent(ty) {
        Ty::List { of, .. } => extract_content_item_problem(of, "each item"),
        Ty::Tuple { of, rest } => {
            for (index, slot) in of.iter().enumerate() {
                if let Some(slot) = slot
                    && let Some(problem) = extract_content_item_problem(slot, &format!("item {index}"))
                {
                    return Some(problem);
                }
            }
            rest.as_ref().and_then(|r| r.of.as_deref()).and_then(|of| extract_content_item_problem(of, "each item the spread adds"))
        }
        Ty::Record(_) => Some(format!(
            "'extract' reads text and files, and this is a record — render it as text in the content list: `extract([TEXT.SERIALISE({written}, 'JSON')], …)`"
        )),
        _ => Some(format!("'extract' reads a LIST of text and files, and this is {} — write it as a list: `extract([{written}], …)`", describe_field_type(ty))),
    }
}

fn extract_content_item_problem(ty: &Ty, which: &str) -> Option<String> {
    match strip_absent(ty) {
        Ty::Text | Ty::Enum { .. } | Ty::File | Ty::Absent | Ty::Never => None,
        Ty::Union(members) => members.iter().find_map(|m| extract_content_item_problem(m, which)),
        Ty::Record(_) => Some(format!(
            "{which} of the content is a record, and 'extract' reads text and files — render the record as text first: `TEXT.SERIALISE(record, 'JSON')`"
        )),
        Ty::Dict { .. } | Ty::Json => Some(format!(
            "{which} of the content is {}, and 'extract' reads text and files — render it as text first: `TEXT.SERIALISE(value, 'JSON')`",
            describe_field_type(ty)
        )),
        Ty::List { .. } | Ty::Tuple { .. } => {
            Some(format!("{which} of the content is itself a list — spread it into the content so each of its items is one item: `[a, ...items]`"))
        }
        Ty::Number | Ty::Boolean | Ty::Date | Ty::Datetime => Some(format!(
            "{which} of the content is {}, and 'extract' reads text and files — write it into text (`\"… ${{value}} …\"`) or render it with `TEXT.SERIALISE(value, 'JSON')`",
            describe_field_type(ty)
        )),
        Ty::MaybeAbsent(of) => extract_content_item_problem(of, which),
    }
}

// ── Reading an extracted field ──

/// `readExtractField`: a dot read off an extracted node. A typed field may
/// not have been found, so it reads `T | absent`; text is handed over as `""`
/// when not found, so it is present. An annotation the write target
/// contradicts is refused at the annotation; an unannotated field written
/// into a target that needs something text cannot be is refused, and one
/// written into an option set earns the nudge to annotate it.
pub fn read_extract_field(typing: &mut Typing, node: &ExtractNodeType, property: &str) -> Option<Ty> {
    if node.declared {
        return None;
    }
    let node_label = if node.name == EXTRACT_ROOT_NAME { "the extract result".to_string() } else { format!("the extracted node '{}'", node.name) };
    let Some(field) = node.properties.get(property) else {
        let available: Vec<&str> = node.properties.keys().map(String::as_str).collect();
        let list = if available.is_empty() { String::new() } else { format!(" — it declares: {}", available.join(", ")) };
        typing.report(codes::EXTRACT_UNKNOWN_FIELD, format!("'{property}' is not a field of {node_label}{list}"));
        return None;
    };
    let write_target = typing.write_target.clone();
    if let Some(explicit) = &field.explicit {
        let annotated = unwrap_list(explicit);
        if let Some((target, path)) = &write_target
            && field_type_compatible(explicit, target)
            && target_constrains_extraction(target)
            && !field_assignable(&annotated, &unwrap_list(target))
        {
            let unwrapped = unwrap_list(target);
            let enum_options = match &unwrapped {
                Ty::Enum { options, .. } => Some(options),
                _ => None,
            };
            let into = path.as_ref().map(|p| format!(" {p},")).unwrap_or_default();
            let mismatch = match enum_options {
                Some(options) => format!(
                    "a field whose options are ({}) — {}",
                    options.join(" | "),
                    if matches!(annotated, Ty::Enum { .. }) { "the option sets differ".to_string() } else { format!("{} isn't constrained to them", describe_field_type(&annotated)) }
                ),
                None => format!("a {} field — the annotation doesn't constrain the extraction to that type", describe_field_type(target)),
            };
            let borrow = path
                .as_ref()
                .map(|p| {
                    format!(
                        "; borrow the target's {} (`{property}: <{}> \"…\"`) or align the annotation",
                        if enum_options.is_some() { "options" } else { "type" },
                        borrowed_annotation_spelling(p)
                    )
                })
                .unwrap_or_default();
            typing.diagnostics.push(Diagnostic::error(
                codes::EXTRACT_TYPE_CONFLICT,
                format!("'{property}' on {node_label} is annotated as {}, but it is written into{into} {mismatch}{borrow}", describe_field_type(explicit)),
                field.span,
            ));
        }
        // Version 1: every annotated field is optional, text included.
        if typing.version < 2 {
            return Some(maybe_absent(explicit.clone()));
        }
        return Some(if field.reads_as_present_text { Ty::Text } else { maybe_absent(explicit.clone()) });
    }
    // An annotation that did not resolve here stays untyped and unremarked.
    if field.annotated {
        return None;
    }
    if typing.version < 2 {
        if let Some((target, path)) = &write_target
            && !matches!(strip_absent(target), Ty::Text | Ty::Json)
        {
            suggest_annotation(typing, field, property, &node_label, target, path.as_deref());
        }
        return None;
    }
    let Some((target, path)) = write_target else { return Some(Ty::Text) };
    match base_kind(&target) {
        Some(BaseKind::Text | BaseKind::Json | BaseKind::Absent) => {
            if matches!(unwrap_list(&target), Ty::Enum { .. }) {
                suggest_annotation(typing, field, property, &node_label, &target, path.as_deref());
            }
            return Some(Ty::Text);
        }
        Some(BaseKind::Record) => return Some(Ty::Text),
        _ => {}
    }
    let primitive = describe_field_type(&unwrap_list(&target));
    let borrow = path.as_deref().map(|p| format!(" (or borrow the field's own type: `{property}: <{}> \"…\"`)", borrowed_annotation_spelling(p))).unwrap_or_default();
    typing.report(
        codes::EXTRACT_NEEDS_ANNOTATION,
        format!(
            "'{property}' on {node_label} is text — a field with no annotation asks the model for words — and it is written into a {} field{}. Annotate it so the model answers a {primitive}: `{property}: <{primitive}> \"…\"`{borrow}. An annotated {primitive} may not be found, so write it with '?:' (set-if-empty), or fall back with COALESCE.",
            describe_field_type(&target),
            path.as_deref().map(|p| format!(" ({p})")).unwrap_or_default(),
        ),
    );
    None
}

/// The extraction diagnostics a read raises only against the field it is
/// written into: the write's own typing of the value reports them.
pub fn reads_write_target(code: &str) -> bool {
    [codes::EXTRACT_NEEDS_ANNOTATION, codes::EXTRACT_TYPE_CONFLICT, codes::EXTRACT_ANNOTATE].contains(&code)
}

/// `suggestAnnotation`: the info nudge toward an annotation that would add a
/// constraint, said once per field and target.
fn suggest_annotation(typing: &mut Typing, field: &ExtractField, property: &str, node_label: &str, target: &Ty, path: Option<&str>) {
    let annotation = match (path, target) {
        (Some(path), _) => path.to_string(),
        (None, Ty::Text | Ty::Number | Ty::Boolean | Ty::Date | Ty::Datetime | Ty::File | Ty::Json | Ty::Absent) => describe_field_type(target),
        _ => return,
    };
    if !field.suggested.borrow_mut().insert(annotation.clone()) {
        return;
    }
    let mut diagnostic = Diagnostic::error(
        codes::EXTRACT_ANNOTATE,
        format!(
            "'{property}' on {node_label} flows into a {} field{} — annotate it as such (`{property}: <{}> \"…\"`) so the extraction is constrained by the target's type; only explicit annotations constrain extraction. An annotated field reads as its type OR absent, so discharge that in the same edit — write the target field with '?:' (set-if-empty), wrap the read in COALESCE, or guard on it — since a plain field is refused a value that may be absent",
            describe_field_type(target),
            path.map(|p| format!(" ({p})")).unwrap_or_default(),
            borrowed_annotation_spelling(&annotation),
        ),
        field.span,
    );
    diagnostic.severity = Some(Severity::Info);
    typing.diagnostics.push(diagnostic);
}

/// `targetConstrainsExtraction`: a target an annotation could be wrong for —
/// a closed option set, or a type text is not.
fn target_constrains_extraction(target: &Ty) -> bool {
    match unwrap_list(target) {
        Ty::Enum { open, .. } => open.is_none(),
        Ty::Number | Ty::Boolean | Ty::Date | Ty::Datetime | Ty::File | Ty::Absent => true,
        Ty::Union(members) => members.iter().any(target_constrains_extraction),
        _ => false,
    }
}

/// `borrowedAnnotationSpelling`: `<instance>.<root>.<field>` as it is written.
fn borrowed_annotation_spelling(path: &str) -> String {
    match path.split('.').collect::<Vec<_>>().as_slice() {
        [graph, root, field] => format!("{graph}-[:{root}]->.`{field}`"),
        _ => path.to_string(),
    }
}

// ── Built-ins an extraction's content goes through ──

/// An extraction call written inside an expression: from version 3 it runs a
/// model once per landing or member, so it is bound first.
pub fn observe_function(typing: &mut Typing, function: &str) {
    let spelled = match function {
        "extract" => "extract",
        "extractone" => "extractOne",
        _ => return,
    };
    if typing.version >= 3 {
        typing.report(
            codes::EXTRACT_CALL_NESTED,
            format!("'{spelled}(…)' runs a model over its content, and a walk's WHERE is read once per landing (a SORT key once per member) — bind it first, then use the name: `found = {spelled}(content, Shape)`"),
        );
    }
}

/// `typeReadCall`: `READ(file)` is the file's text, or nothing; only a file
/// has bytes to read.
pub fn type_read_call(typing: &mut Typing, args: &[Option<Ty>]) -> Option<Ty> {
    if let Some(Some(arg)) = args.first()
        && !matches!(strip_absent(arg), Ty::File)
    {
        typing.report(
            codes::READ_NOT_FILE,
            format!(
                "READ(file) reads a file's text, and this is {} — name the file itself (an attachment's file field), or drop the READ if you already have the text.",
                describe_field_type(strip_absent(arg))
            ),
        );
    }
    Some(maybe_absent(Ty::Text))
}

/// `typeChunksCall`: `CHUNKS(text, { … })` is always a list of text; only a
/// text has pieces.
pub fn type_chunks_call(typing: &mut Typing, args: &[Option<Ty>]) -> Ty {
    if let Some(Some(arg)) = args.first()
        && !matches!(strip_absent(arg), Ty::Text)
    {
        typing.report(
            codes::CHUNKS_NOT_TEXT,
            format!(
                "CHUNKS(text, {{ size | entities, overlap }}) cuts a text into pieces, and this is {} — read the text out of it first (a file's text is READ(file)).",
                describe_field_type(strip_absent(arg))
            ),
        );
    }
    Ty::list(Ty::Text)
}

// ── Resource walks: `-[:_resources]->` ──

/// `endingHop(hop) === 'resources'`: a hop a walk can only end in, which
/// lowers to a node of its own.
pub fn is_resource_hop(hop: &Hop) -> bool {
    let label = hop.label.text.as_str();
    let base = label.split(|c: char| c == ':' || c.is_whitespace()).next().unwrap_or(label);
    base == "_resources" || base == "#resources"
}

/// What `@resource.…` could read (`RESOURCE_FIELDS`).
const RESOURCE_FIELDS: &[&str] = &["name", "url", "type", "document_url", "content", "contentType"];

impl Checker<'_> {
    /// `checkWalkKeepsWhatIsWritten`, the resource half: a walk ending in a
    /// resource hop keeps neither the hops before it (a block head) nor its
    /// root (a walk read as a value); a rootless one read the event's record.
    pub fn check_resource_walk(&mut self, root: Option<&MExpr>, hops: &[Hop], span: Span, is_head: bool) {
        if !hops.last().is_some_and(is_resource_hop) {
            return;
        }
        if is_head && hops.len() > 1 {
            self.report(
                codes::RESOURCE_WALK_UNREAD,
                "a block head that ends in -[:_resources]-> walks only the hops before it — the -[:_resources]-> hop is never read, so the body would run once per record those hops reach, not once per resource. Walk to the record in one block, then its resources as the one hop of a block inside: '…-[m:…]-> { m-[f:_resources]-> { … } }'",
                span,
            );
            return;
        }
        if is_head {
            return;
        }
        let Some(root) = root else {
            if self.version >= 5 {
                self.report(
                    codes::RESOURCES_NOT_EXTRACTED,
                    "'-[:_resources]->' with no root reads the event's record, and '-[:_resources]->' is read only off an extraction's result — the source content the extraction read ('found = extract …', then 'found-[f:_resources]-> { … }'). For the event's files, name the event as a parameter and walk the edge its system declares to them.",
                    span,
                );
            }
            return;
        };
        let root = match root {
            MExpr::Name { name, .. } => name.text.as_str(),
            _ => "the root",
        };
        self.report(
            codes::RESOURCE_WALK_UNREAD,
            format!("a walk that ends in -[:_resources]-> is read here from no record — '{root}' would be dropped, and the resources read would not be {root}'s. Walk {root}'s resources as a block: '{root}-[f:_resources]-> {{ … f.`url` … }}'"),
            span,
        );
    }

    /// `checkSpecialRecordRead`: `@parent.<field>` and `@resource.<field>`
    /// read the translation graph, which a run does not have. Inside a
    /// resource hop's WHERE, `@resource.<field>` is the bare field name, so
    /// the rewrite is exact.
    pub fn check_special_record_read(&mut self, text: &str, span: Span, extent: Option<Span>, in_resource_where: bool) {
        let read = text.strip_prefix('@').unwrap_or(text);
        if let Some(field) = read.strip_prefix("parent.") {
            self.report(
                codes::PARENT_READ_RETIRED,
                format!("'@parent.{field}' is retired — it read the translation graph's parent result, which a movement run does not have. Keep the parent write's handle and write the child off it: 'co = write crm-[:Companies]-> {{ … }}', then 'write co-[:Team]-> {{ … }}'"),
                span,
            );
            return;
        }
        let Some(field) = read.strip_prefix("resource.") else { return };
        let known = RESOURCE_FIELDS.contains(&field);
        if !in_resource_where || !known {
            let message = if in_resource_where {
                format!(
                    "'@resource.{field}' is retired, and a resource has no field '{field}' — it has {}{}. Inside a -[:_resources WHERE …]-> filter, write the field's bare name",
                    RESOURCE_FIELDS.join(", "),
                    did_you_mean(field, RESOURCE_FIELDS)
                )
            } else {
                format!(
                    "'@resource.{field}' is retired — outside a -[:_resources WHERE …]-> filter it was always null. Walk the record's resources and read the field off the landing: 'r-[f:_resources]-> {{ … f.`{}` … }}'",
                    if known { field } else { "url" }
                )
            };
            self.report(codes::RESOURCE_READ_RETIRED, message, span);
            return;
        }
        let mut diagnostic = Diagnostic::error(
            codes::RESOURCE_READ_RETIRED,
            format!("'@resource.{field}' is retired — inside a -[:_resources WHERE …]-> filter, write the field's bare name: '{field}'"),
            span,
        );
        if let Some(extent) = extent {
            diagnostic.fix = Some(serde_json::json!({ "edits": [{ "span": extent, "text": field }] }));
        }
        self.push(diagnostic);
    }
}

impl Checker<'_> {
    /// `checkPathHead`'s resource rule (version 5): a head of one
    /// `-[:_resources]->` hop reads an extraction's source content, so its
    /// root has to be an extraction's result.
    pub fn check_head_resources(&mut self, head: &PathHead, probe: &str, root_name: Option<&str>, scope: ScopeId) {
        if self.version < 5 {
            return;
        }
        let Ok(tree) = movement_parser::expr::parse_expression(probe) else { return };
        let MExpr::Member { object, .. } = &tree else { return };
        let MExpr::Path { hops, .. } = object.as_ref() else { return };
        // `#resources`, its old spelling, is a retired `#` hop of its own.
        let [hop] = hops.as_slice() else { return };
        if !is_resource_hop(hop) || hop.label.text.starts_with('#') {
            return;
        }
        let root_type = match &head.root {
            None => None,
            Some(PathRoot::Name { name }) => {
                use crate::types::TypeEnv as _;
                let env = self.typing_env(scope);
                env.resolve_root(name).or_else(|| record_head_position(crate::types::field::widen_tuples_joining(env.resolve_scalar(name), self.version, self.record_join()).as_ref()))
            }
            Some(PathRoot::Expression { expr }) => {
                let held = self.type_of_slot(expr, scope).and_then(|(_, ty, _)| ty);
                record_head_position(held.as_ref())
            }
        };
        self.check_resources_of_extraction(root_type.as_ref(), root_name, head.span);
    }

    /// `checkResourcesOfExtraction`: the rule is structural — is the root an
    /// extraction's result? — and only the "write this instead" reads the
    /// schema. A record holding a file itself is pointed at its file field.
    fn check_resources_of_extraction(&mut self, root_type: Option<&Position>, root_name: Option<&str>, span: Span) {
        let shown = root_name.unwrap_or("the root");
        let lead = "'-[:_resources]->' is read only off an extraction's result — the source content the extraction read ('found = extract …', then 'found-[f:_resources]-> { … }')";
        let Some(root_type) = root_type else {
            // A head with no root is the engine's to refuse, in every version.
            let Some(_) = root_name else { return };
            self.report(
                codes::RESOURCES_NOT_EXTRACTED,
                format!("'{shown}' is not provably an extraction's result, and {lead}. A record reaches its files over an edge its system declares: walk that edge instead."),
                span,
            );
            return;
        };
        let position = unwrap_maybe_empty(root_type);
        if matches!(position, Position::Extract { .. }) {
            return;
        }
        // One of several records (an IF of extractions' results) is one when
        // every member is.
        if let Position::OneOf(members) = position
            && members.iter().all(|member| matches!(unwrap_maybe_empty(member), Position::Extract { .. }))
        {
            return;
        }
        let system_positions = match position {
            Position::Position(p) => Some((&p.instance, vec![p.position.clone()])),
            Position::Handle(h) => Some((&h.instance, h.position.iter().cloned().collect())),
            Position::Union(u) => Some((&u.instance, u.variants.clone())),
            _ => None,
        };
        let instead = match system_positions {
            None => String::new(),
            Some((instance, positions)) => {
                let schema = &instance.schema;
                let system = format!("'{}'", instance.name);
                let mut own_files: Vec<&str> = Vec::new();
                for p in &positions {
                    for (field, ty) in schema.positions.get(p).map(|s| s.properties.iter()).into_iter().flatten() {
                        if holds_file(&Ty::from_schema(ty)) && !own_files.contains(&field.as_str()) {
                            own_files.push(field);
                        }
                    }
                }
                let edges = file_edges_of(schema, &positions);
                if let Some(first) = own_files.first() {
                    let listed = own_files.iter().map(|f| format!("'{f}'")).collect::<Vec<_>>().join(" or ");
                    format!(" {} holds its file itself, in {listed}: read '{shown}.{}'.", describe_position(position), spell_name(first))
                } else if let Some(first) = edges.first() {
                    let listed = edges.iter().map(|e| format!("'{e}'")).collect::<Vec<_>>().join(" or ");
                    format!(" {system} reaches a record's files over {listed}: write '{shown}-[f:{}]-> {{ … }}'.", spell_name(first))
                } else {
                    format!(" {system} exposes no files on {} — it declares no edge to a record that holds one.", describe_position(position))
                }
            }
        };
        self.report(codes::RESOURCES_NOT_EXTRACTED, format!("'{shown}' is {}, and {lead}.{instead}", describe_position(position)), span);
    }
}

fn unwrap_maybe_empty(position: &Position) -> &Position {
    match position {
        Position::MaybeEmpty(of) => unwrap_maybe_empty(of),
        other => other,
    }
}

/// `holdsFile`: a file, or a collection that holds one.
fn holds_file(ty: &Ty) -> bool {
    match ty {
        Ty::File => true,
        Ty::List { of, .. } | Ty::Dict { of, .. } => holds_file(of),
        Ty::MaybeAbsent(of) => holds_file(of),
        Ty::Tuple { of, .. } => of.iter().flatten().any(holds_file),
        _ => false,
    }
}

/// `fileEdgesOf`: the edges a record reaches files over — the one its system
/// declared as its resources, else every readable edge to a record holding a file.
fn file_edges_of(schema: &InstanceSchema, positions: &[String]) -> Vec<String> {
    let mut declared: Vec<String> = Vec::new();
    let mut filed: Vec<String> = Vec::new();
    for position in positions {
        for (name, edge) in schema.positions.get(position).map(|p| p.edges.iter()).into_iter().flatten() {
            if edge.readable == Some(false) {
                continue;
            }
            if edge.resources == Some(true) {
                if !declared.contains(name) {
                    declared.push(name.clone());
                }
                continue;
            }
            let landings = schema.unions.as_ref().and_then(|u| u.get(&edge.target)).cloned().unwrap_or_else(|| vec![edge.target.clone()]);
            let holds = landings.iter().any(|l| schema.positions.get(l).is_some_and(|p| p.properties.values().any(|t| holds_file(&Ty::from_schema(t)))));
            if holds && !filed.contains(name) {
                filed.push(name.clone());
            }
        }
    }
    if declared.is_empty() { filed } else { declared }
}

/// `builtinOptionsFor`: the options map a built-in declares (`CHUNKS`'s).
pub fn options_contract(function: &str) -> Option<&'static OptionsContract> {
    vocabulary().options_for(function)
}

/// `typeOptionsMap`: each value of a built-in's options map, typed against
/// the key's declared type. The map itself is call shape, not a value.
pub fn type_options_map(typing: &mut Typing, arg: &Expression, contract: &OptionsContract, position: Option<&Position>) -> Option<Ty> {
    let Expression::Object { entries } = arg else { return None };
    for entry in entries {
        let ObjectMember::Entry { key, value } = entry else { continue };
        let got = typing.infer_at(value, position);
        let Some(option) = contract.options.iter().find(|o| o.key == key) else { continue };
        let want = match option.type_ {
            OptionType::Number => Ty::Number,
            OptionType::Text => Ty::Text,
            OptionType::Literal => continue,
        };
        let Some(got) = got else { continue };
        if !crate::types::field::field_type_equals(strip_absent(&got), &want) {
            typing.report(
                codes::OPTION_INVALID,
                format!(
                    "{}: '{key}' is {}, so it is a {} — and this is {}.",
                    contract.signature,
                    option.summary,
                    describe_field_type(&want),
                    describe_field_type(strip_absent(&got))
                ),
            );
        } else if matches!(got, Ty::MaybeAbsent(_)) {
            typing.report(
                codes::OPTION_INVALID,
                format!(
                    "{}: '{key}' is {}, and this may not answer at all — fill it in ('COALESCE(…, 2000)') so the run always has one.",
                    contract.signature, option.summary
                ),
            );
        }
    }
    None
}

// ── Annotations: what an extract field's `<…>` names ──

impl Checker<'_> {
    /// The annotations `buildExtractGraph` resolves, in the order it meets
    /// them: per stage, the nested nodes first, then the stage's fields.
    pub fn resolve_extract_annotations(&mut self, stages: &[ExtractStage], scope: ScopeId) {
        for stage in stages {
            for child in &stage.children {
                let stages = match child {
                    ExtractNode::Inline(inline) => &inline.stages,
                    ExtractNode::Declared(declared) => &declared.stages,
                };
                self.resolve_extract_annotations(stages, scope);
            }
            for field in &stage.fields {
                if let Some(written) = &field.type_ {
                    self.resolve_named_type(written, field.span, scope);
                }
            }
        }
    }
}
