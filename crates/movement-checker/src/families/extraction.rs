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
    CallStatement, DeclaredExtractNode, ExtractCallExpression, ExtractCallFinds, ExtractCallShape, ExtractNode, ExtractStage, PluginCall,
    ShapeDeclaration, ShapeNode, Span,
};
use movement_parser::catalog::helpers::{borrowed_type_segments, resolve_borrowed_field};
use movement_parser::catalog::types::PluginSpec;

use crate::checker::{Checker, SlotOptions};
use crate::codes;
use crate::scope::{Resolution, ScopeId, SymbolId, SymbolKind};
use crate::meta::did_you_mean;
use crate::slots::{expression_of_slot, is_bare_ident, is_literal_word};
use crate::diagnostic::{Diagnostic, Severity};
use crate::types::Typing;
use crate::types::field::{BaseKind, Ty, base_kind, describe_field_type, field_assignable, field_type_compatible, maybe_absent, strip_absent, unwrap_list};
use crate::types::position::EXTRACT_ROOT_NAME;
use movement_parser::ast::ExprSlot;
use movement_parser::lowering::expression::{Expression, ObjectMember, StaticValue};
use crate::types::position::{ExtractField, ExtractNode as ExtractNodeType, LocalEdge, LocalNode, Position};

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
        self.check_field_child_names_apart(&field_names, &stage_children);
        let declared_children: Vec<(&str, Span)> = declared.map(|d| d.children.iter().map(|c| (c.name.as_str(), c.span)).collect()).unwrap_or_default();
        let own_names: Vec<&str> = stage_fields.iter().map(|f| f.name.as_str()).collect();
        self.check_field_child_names_apart(&own_names, &declared_children);

        let mut prior = inherited.clone();
        for (k, stage) in stages.iter().enumerate() {
            let own_or_later: HashSet<String> = stages[k..].iter().flat_map(|s| &s.fields).map(|f| f.name.clone()).collect();
            for plugin in stage.through.iter().flatten() {
                let fields = ThroughFields { prior: prior.clone(), own_or_later: own_or_later.clone() };
                self.check_plugin_stage(plugin, scope, &fields);
            }
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

    /// `checkFieldChildNamesApart`: a record's fields and its child nodes are
    /// one namespace.
    fn check_field_child_names_apart(&mut self, fields: &[&str], children: &[(&str, Span)]) {
        for (name, span) in children {
            if fields.contains(name) {
                self.report(
                    codes::EXTRACT_FIELD_DUPLICATE,
                    format!("'{name}' is both a field and a child node here — a record's fields and its child nodes share one namespace, so give one of them another name"),
                    *span,
                );
            }
        }
    }

    /// A node declaration's fields and child nodes, one namespace.
    pub fn check_shape_names_apart(&mut self, node: &ShapeNode) {
        let fields: Vec<&str> = node.fields.iter().map(|f| f.name.as_str()).collect();
        let children: Vec<(&str, Span)> = node.children.iter().map(|c| (c.name.as_str(), c.span)).collect();
        self.check_field_child_names_apart(&fields, &children);
    }

    /// The node declaration a symbol is (`declaredExtractShape`), when it is one.
    pub fn declared_extract_shape(&self, id: SymbolId, scope: ScopeId) -> Option<ShapeDeclaration> {
        if !matches!(self.scopes.symbol(id).kind, SymbolKind::Shape | SymbolKind::Binding) {
            return None;
        }
        // TODO(nodes): the declaration's schema (`shapeToSchema`) types its fields.
        let shape = self.listens.shapes.get(&id)?;
        Some(self.inherited_declaration(shape, scope, 0))
    }

    /// `S = Company`: from version 3 a declaration's name read as a value is
    /// the shape itself, a second name for it.
    // TODO(nodes): the TypeScript binds the name as a shape (`kind: 'shape'`);
    // here only the extraction reads it as one.
    pub fn note_shape_alias(&mut self, name: &str, value: &movement_parser::ast::RValue, scope: ScopeId) {
        let movement_parser::ast::RValue::Expr { expr } = value else { return };
        let written = expr.raw.trim();
        if self.version < 3 || !is_bare_ident(written) {
            return;
        }
        let Resolution::Found(shape) = self.scopes.resolve(scope, written) else { return };
        let Some(declaration) = self.listens.shapes.get(&shape).filter(|_| self.scopes.symbol(shape).kind == SymbolKind::Shape).cloned() else { return };
        if let Some(alias) = self.scopes.scope(scope).symbols.get(name).copied() {
            self.listens.shapes.insert(alias, declaration);
        }
    }

    /// Whether every declaration `shape` extends resolves from here. One
    /// imported from another file may extend a name only that file binds;
    /// what it reads as is then not known here.
    // TODO(nodes): fold `extends` where the declaration is made.
    fn bases_known(&self, shape: &ShapeDeclaration, scope: ScopeId, depth: usize) -> bool {
        let Some(base) = &shape.extends else { return true };
        match self.scopes.resolve(scope, &base.name) {
            Resolution::Found(id) if depth < 16 => self.listens.shapes.get(&id).is_some_and(|b| self.bases_known(b, scope, depth + 1)),
            _ => false,
        }
    }

    /// `inheritDeclaration`: `node X extends Y { … }` as the tree it stands
    /// for — Y's fields and nested nodes, then X's own.
    // TODO(nodes): the nodes family folds `extends` where it builds the schema.
    fn inherited_declaration(&self, shape: &ShapeDeclaration, scope: ScopeId, depth: usize) -> ShapeDeclaration {
        let Some(base) = &shape.extends else { return shape.clone() };
        let base = match self.scopes.resolve(scope, &base.name) {
            Resolution::Found(id) if depth < 16 => self.listens.shapes.get(&id).map(|b| self.inherited_declaration(b, scope, depth + 1)),
            _ => None,
        };
        let Some(base) = base else { return shape.clone() };
        let mut folded = shape.clone();
        folded.root.description = shape.root.description.clone().or(base.root.description.clone());
        folded.root.fields = base.root.fields.iter().chain(&shape.root.fields).cloned().collect();
        folded.root.children = base.root.children.iter().chain(&shape.root.children).cloned().collect();
        folded
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
        let shape = self.declared_extract_shape(id, scope);
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
            failure => {
                self.report_resolution_failure(&plugin.plugin, plugin.span, failure);
                None
            }
        };
        let supplied: HashSet<&str> = plugin.args.iter().map(|a| a.name.as_str()).collect();
        report_plugin_missing_args(self, &plugin.plugin, spec, &supplied, plugin.span);
        for arg in &plugin.args {
            report_plugin_bad_arg(self, &plugin.plugin, spec, &arg.name, arg.value.span, false);
            // TODO(calls): the argument's value against what the plugin
            // declares it takes (`checkPluginArgValue`, MOV_CALL_ARG_TYPE).
            self.check_expr_slot_with(&arg.value, scope, SlotOptions { fields: Some(fields), ..SlotOptions::default() });
        }
    }

    /// `checkPluginApplication`, its refusals: a plugin called on its own takes
    /// named arguments, has said what it does and hands back, and is not one
    /// only an extraction can feed; then its arguments, as a stage's are.
    /// (What the call's value is typed as is the calls family's.)
    pub fn check_plugin_application(&mut self, call: &CallStatement, imported_name: &str) {
        let spec = self.catalog.plugin(imported_name);
        if call.args.first().is_some_and(|a| a.name().is_none()) {
            let takes = spec.filter(|s| !s.args.is_empty()).map(|s| format!(" (it takes: {})", s.args.join(", "))).unwrap_or_default();
            self.report(
                codes::PLUGIN_ARGS_NAMED,
                format!("'{}' is a plugin, and a plugin's arguments are named — write each as '<parameter>: <value>'{takes}", call.callee),
                call.span,
            );
            return;
        }
        let supplied: HashSet<&str> = call.args.iter().filter_map(|a| a.name()).collect();
        self.refuse_plain_plugin_call(call, spec, &supplied);
        report_plugin_missing_args(self, &call.callee, spec, &supplied, call.span);
        for arg in &call.args {
            let Some(name) = arg.name() else { continue };
            report_plugin_bad_arg(self, &call.callee, spec, name, crate::families::calls::call_arg_span(arg), true);
        }
    }

    /// `refusePlainPluginCall`: whether the plugin can only run as a stage,
    /// reporting why when it cannot be called on its own.
    fn refuse_plain_plugin_call(&mut self, call: &CallStatement, spec: Option<&PluginSpec>, supplied: &HashSet<&str>) -> bool {
        let Some(spec) = spec else { return false };
        let callee = &call.callee;
        let stage = format!("write it in a 'through [ … ]' (`extract from [ … ] through [{callee}] {{ … }}`)");
        if spec.effects.is_none() {
            self.report(
                codes::PLUGIN_ROW_UNDECLARED,
                format!("'{callee}' is a plugin that hasn't declared what it does, so it can only run as an extraction stage — {stage}."),
                call.span,
            );
            return true;
        }
        if spec.fed_by_extraction == Some(true) {
            self.report(
                codes::PLUGIN_FED_BY_EXTRACTION,
                format!("'{callee}' runs on what an extraction gives it and takes nothing of its own, so it only makes sense as a stage of one — {stage}."),
                call.span,
            );
            return true;
        }
        if spec.output.is_none() {
            self.report(
                codes::PLUGIN_OUTPUT_UNDECLARED,
                format!("'{callee}' is a plugin that hasn't declared what it hands back, so there is nothing to bind — it can only run as an extraction stage, where its output goes to the extractor: {stage}."),
                call.span,
            );
            return true;
        }
        let unfed: Vec<&str> = spec.fed_args.iter().flatten().filter(|f| f.required == Some(true) && !supplied.contains(f.name.as_str())).map(|f| f.name.as_str()).collect();
        if unfed.is_empty() {
            return false;
        }
        let one = unfed.len() == 1;
        let listed = unfed.iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(", ");
        let written = unfed.iter().map(|n| format!("{n}: …")).collect::<Vec<_>>().join(", ");
        self.report(
            codes::PLUGIN_FED_BY_EXTRACTION,
            format!(
                "'{callee}' is missing {} {listed} — inside a 'through [ … ]' the extraction supplies {}, so a call on its own has to say {} (`{callee}({written})`).",
                if one { "the argument" } else { "the arguments" },
                if one { "it" } else { "them" },
                if one { "it" } else { "them" },
            ),
            call.span,
        );
        true
    }
}

fn extract_node_name_span(node: &ExtractNode) -> (&str, Span) {
    match node {
        ExtractNode::Inline(n) => (n.name.as_str(), n.span),
        ExtractNode::Declared(n) => (n.name.as_str(), n.span),
    }
}

/// `reportPluginBadArg`: an argument the plugin's registry entry does not
/// list. A plain call also takes the arguments a stage is fed.
fn report_plugin_bad_arg(checker: &mut Checker, name: &str, spec: Option<&PluginSpec>, arg: &str, span: Span, plain: bool) {
    let Some(spec) = spec else { return };
    if spec.args.iter().any(|a| a == arg) {
        return;
    }
    let fed: Vec<&str> = spec.fed_args.iter().flatten().map(|f| f.name.as_str()).collect();
    if plain && fed.contains(&arg) {
        return;
    }
    let mut accepted: Vec<&str> = spec.args.iter().map(String::as_str).collect();
    if plain {
        accepted.extend(fed);
    }
    let list = if accepted.is_empty() { String::new() } else { format!(" — it accepts: {}", accepted.join(", ")) };
    checker.report(codes::THROUGH_BAD_ARG, format!("'{name}' does not accept an argument '{arg}'{list}"), span);
}

/// `reportPluginMissingArgs`: a required argument the call never supplies.
fn report_plugin_missing_args(checker: &mut Checker, name: &str, spec: Option<&PluginSpec>, supplied: &HashSet<&str>, span: Span) {
    let missing: Vec<String> = spec.and_then(|s| s.required_args.as_ref()).into_iter().flatten().filter(|a| !supplied.contains(a.as_str())).map(|a| format!("'{a}'")).collect();
    if missing.is_empty() {
        return;
    }
    let which = if missing.len() == 1 { "the required argument" } else { "required arguments" };
    checker.report(codes::THROUGH_ARG_MISSING, format!("'{name}' is missing {which} {}", missing.join(", ")), span);
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

impl Checker<'_> {
    /// An annotation's type, as `resolveNamedType` resolves it: a primitive, a
    /// type the program declares, or a borrowed `<instance>.<root>.<field>`.
    /// Typing only: what it reports when the name resolves to nothing is the
    /// nodes family's (MOV_UNKNOWN_TYPE_NAME, MOV_BORROW_*).
    pub fn annotation_type(&self, written: &str, scope: ScopeId) -> Option<Ty> {
        let Some(segments) = borrowed_type_segments(Some(written)) else {
            return Ty::from_scalar_name(written).or_else(|| self.declared_type_in(written, scope));
        };
        let [graph, root, field] = segments.as_slice() else { return None };
        let Resolution::Found(id) = self.scopes.resolve(scope, graph) else { return None };
        // TODO(nodes): a declared node as the graph a type is borrowed from.
        let Some(Position::Meta { instance }) = &self.scopes.symbol(id).types.pos else { return None };
        resolve_borrowed_field(&instance.schema, root, field).map(Ty::from_schema)
    }

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
        let (shape, known) = match self.scopes.resolve(scope, &node.declared.type_) {
            Resolution::Found(id) => (self.declared_extract_shape(id, scope), self.listens.shapes.get(&id).is_none_or(|s| self.bases_known(s, scope, 0))),
            _ => (None, true),
        };
        let mut graph = match shape {
            Some(shape) => self.shape_extract_graph(&node.name, &shape.root, scope),
            None => empty_extract_node(&node.name),
        };
        graph.declared = !known;
        self.apply_extract_stages(&mut graph, &node.stages, scope);
        graph
    }

    /// `shapeExtractGraph`: one node of a declaration, read as the extract
    /// node it describes. A field's type is the one the declaration's schema
    /// gives it: an annotation that resolves to nothing reads as text.
    // TODO(nodes): read it off the declaration's schema (`shapeToSchema`,
    // `extends` folded in) once the nodes family builds one.
    fn shape_extract_graph(&self, name: &str, shape: &ShapeNode, scope: ScopeId) -> ExtractNodeType {
        let mut graph = empty_extract_node(name);
        for child in &shape.children {
            graph.children.insert(child.name.clone(), Rc::new(self.shape_extract_graph(&child.name, child, scope)));
        }
        for field in &shape.fields {
            let explicit = self.annotation_type(&field.type_, scope).unwrap_or(Ty::Text);
            graph.properties.insert(field.name.clone(), extract_field(Some(explicit), true, field.nullable == Some(true), field.span));
        }
        graph
    }

    /// What `extract(…)` / `extractOne(…)` hands back: the shape's records, in
    /// the order the content gave them, or the one it describes (or none).
    pub fn extract_call_type(&self, call: &ExtractCallExpression, scope: ScopeId) -> Option<Ty> {
        let declaration = match &call.shape {
            ExtractCallShape::Named { name, .. } => match self.scopes.resolve(scope, name) {
                Resolution::Found(id) => self.declared_extract_shape(id, scope).filter(|s| self.bases_known(s, scope, 0))?,
                _ => return None,
            },
            ExtractCallShape::Inline { declaration, .. } => declaration.clone(),
            ExtractCallShape::Computed { .. } => return None,
        };
        let node = self.shape_extract_graph(&declaration.name, &declaration.root, scope);
        let record = Ty::Record(Some(Box::new(extracted_record_type(&node))));
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
        edges.insert(name.clone(), LocalEdge { schema, target: Some(extracted_record_type(child)) });
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
                if self.declared_extract_shape(id, scope).is_none() && kind != SymbolKind::Shape {
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
        Ty::Text | Ty::Enum { .. } | Ty::File | Ty::Absent => None,
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
