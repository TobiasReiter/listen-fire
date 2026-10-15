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

use movement_parser::ast::{CallStatement, ExtractNode, ExtractStage, PluginCall, ShapeDeclaration, ShapeNode, Span};
use movement_parser::catalog::types::PluginSpec;

use crate::checker::{Checker, SlotOptions};
use crate::codes;
use crate::scope::{Resolution, ScopeId, SymbolId, SymbolKind};

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
    pub fn declared_extract_shape(&self, id: SymbolId) -> Option<ShapeDeclaration> {
        if self.scopes.symbol(id).kind != SymbolKind::Shape {
            return None;
        }
        // TODO(nodes): the declaration's schema (`shapeToSchema`) types its fields.
        self.listens.shapes.get(&id).cloned()
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
        let shape = self.declared_extract_shape(id);
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
