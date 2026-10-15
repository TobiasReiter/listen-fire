//! A plugin called as a function (`checkPluginApplication`): a function
//! whose body is not visible, so everything a call needs has to be declared
//! — what running it does, what it hands back, what it runs on. Its
//! arguments are named, held to the types it declares, and the call's value
//! is the output it declares. Part of the calls family; MOV_PLUGIN_OUTPUT_CHANGED
//! is the versions family's, MOV_PLUGIN_FED_BY_EXTRACTION and the
//! MOV_THROUGH_* argument rules the extraction family's (a `through [ … ]`
//! stage reads its arguments by the same rules).

use std::collections::HashSet;

use movement_parser::ast::{CallArg, CallStatement, Span};
use movement_parser::catalog::types::{FieldType as SchemaFieldType, PluginOutput, PluginSpec};
use movement_parser::version::before;

use crate::checker::Checker;
use crate::codes;
use crate::diagnostic::{Diagnostic, Severity};
use crate::scope::SymbolId;
use crate::types::field::{CollectionOrder, Ty, describe_field_type, holds_records, list_of, strip_absent};
use crate::types::position::{LocalNode, PlaneType, Position, ReturnShape};

/// What a plugin call's arguments are held to: the types it declares, by name.
pub struct PluginArgTypes<'a> {
    pub declared: Option<&'a movement_parser::catalog::types::JsMap<SchemaFieldType>>,
}

/// `pluginOutputUnder`: the output a plugin hands back under a language version.
pub fn plugin_output_under(spec: &PluginSpec, version: u32) -> Option<&PluginOutput> {
    let earlier = spec.earlier_outputs.iter().flatten().find(|entry| before(version, entry.before));
    earlier.map(|entry| &entry.output).or(spec.output.as_ref())
}

/// `describePluginOutput`.
fn describe_plugin_output(output: &PluginOutput) -> String {
    let fields = |of: &movement_parser::catalog::types::JsMap<SchemaFieldType>| of.0.keys().map(|f| format!("`{f}`")).collect::<Vec<_>>().join(", ");
    match output {
        PluginOutput::Value { type_ } => format!("one {}", describe_field_type(&Ty::from_schema(type_))),
        PluginOutput::Record { fields: of } => format!("one record ({})", fields(of)),
        PluginOutput::Records { fields: of } => format!("a list of records, one per thing it found ({})", fields(of)),
    }
}

/// The record a plugin's output describes: what it found, field by field.
fn found(callee: &str, fields: &movement_parser::catalog::types::JsMap<SchemaFieldType>) -> Position {
    Position::Local(LocalNode {
        label: format!("what '{callee}' found"),
        reads: fields.0.iter().map(|(name, ty)| (name.clone(), Some(Ty::from_schema(ty)))).collect(),
        edges: None,
        run_built: None,
        extracted: None,
    })
}

impl Checker<'_> {
    /// The plugin a callable symbol names, by its catalog name.
    pub fn plugin_spec_of(&self, id: SymbolId, written: &str) -> Option<&PluginSpec> {
        let symbol = self.scopes.symbol(id);
        self.catalog.plugin(symbol.imported_name.as_deref().unwrap_or(written))
    }

    /// `checkPluginApplication`: a plugin's call, and the value it hands back.
    pub fn check_plugin_application(&mut self, call: &CallStatement, id: SymbolId, scope: crate::scope::ScopeId) -> ReturnShape {
        let spec = self.plugin_spec_of(id, &call.callee).cloned();
        if let Some(effects) = spec.as_ref().and_then(|s| s.effects.as_ref()) {
            self.absorb_suspend(effects.suspend == Some(true));
        }
        if call.args.first().is_some_and(|a| a.name().is_none()) {
            let takes = match &spec {
                Some(spec) if !spec.args.is_empty() => format!(" (it takes: {})", spec.args.join(", ")),
                _ => String::new(),
            };
            self.report(
                codes::PLUGIN_ARGS_NAMED,
                format!("'{}' is a plugin, and a plugin's arguments are named — write each as '<parameter>: <value>'{takes}", call.callee),
                call.span,
            );
            return ReturnShape::default();
        }
        let supplied: HashSet<&str> = call.args.iter().filter_map(CallArg::name).collect();
        let stage_only = self.refuse_plain_plugin_call(call, spec.as_ref(), &supplied);
        self.report_plugin_missing_args(&call.callee, spec.as_ref(), &supplied, call.span);
        for arg in &call.args {
            let Some(name) = arg.name() else { continue };
            self.report_plugin_bad_arg(&call.callee, spec.as_ref(), name, crate::families::calls::call_arg_span(arg), true);
            let declared = spec.as_ref().and_then(|s| s.arg_types.as_ref()).and_then(|t| t.0.get(name));
            self.report_plugin_arg_type(&call.callee, declared, arg, scope);
        }
        let Some(spec) = spec else { return ReturnShape::default() };
        if stage_only || spec.output.is_none() {
            return ReturnShape::default();
        }
        self.report_plugin_output_changed(call, &spec);
        let Some(output) = plugin_output_under(&spec, self.version) else { return ReturnShape::default() };
        let plane = match output {
            PluginOutput::Value { type_ } => PlaneType { field: Some(Ty::from_schema(type_)), pos: None },
            PluginOutput::Record { fields } => PlaneType { pos: Some(Box::new(found(&call.callee, fields))), field: None },
            // One record per thing found, in the order the plugin found them.
            PluginOutput::Records { fields } => {
                PlaneType { field: Some(list_of(Ty::record(Some(found(&call.callee, fields))), CollectionOrder::Ordered)), pos: None }
            }
        };
        ReturnShape { returns: true, plane, may_hold: None }
    }

    /// `refusePlainPluginCall`: whether this plugin can only run as an
    /// extraction stage, reporting why.
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
        let unfed: Vec<&str> = spec.fed_args.iter().flatten().filter(|fed| fed.required == Some(true) && !supplied.contains(fed.name.as_str())).map(|fed| fed.name.as_str()).collect();
        if !unfed.is_empty() {
            let one = unfed.len() == 1;
            let listed = unfed.iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(", ");
            let spelled = unfed.iter().map(|n| format!("{n}: …")).collect::<Vec<_>>().join(", ");
            self.report(
                codes::PLUGIN_FED_BY_EXTRACTION,
                format!(
                    "'{callee}' is missing {} {listed} — inside a 'through [ … ]' the extraction supplies {}, so a call on its own has to say {} (`{callee}({spelled})`).",
                    if one { "the argument" } else { "the arguments" },
                    if one { "it" } else { "them" },
                    if one { "it" } else { "them" },
                ),
                call.span,
            );
            return true;
        }
        false
    }

    /// `reportPluginBadArg`: an argument the plugin's registry entry does not
    /// list. A plain call also takes the arguments a stage is fed.
    pub fn report_plugin_bad_arg(&mut self, name: &str, spec: Option<&PluginSpec>, arg: &str, span: Span, plain: bool) {
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
        self.report(codes::THROUGH_BAD_ARG, format!("'{name}' does not accept an argument '{arg}'{list}"), span);
    }

    /// `reportPluginMissingArgs`: a required argument the call never supplies.
    pub fn report_plugin_missing_args(&mut self, name: &str, spec: Option<&PluginSpec>, supplied: &HashSet<&str>, span: Span) {
        let missing: Vec<&String> = spec.and_then(|s| s.required_args.as_ref()).into_iter().flatten().filter(|a| !supplied.contains(a.as_str())).collect();
        if missing.is_empty() {
            return;
        }
        let which = if missing.len() == 1 { "the required argument" } else { "required arguments" };
        let listed = missing.iter().map(|a| format!("'{a}'")).collect::<Vec<_>>().join(", ");
        self.report(codes::THROUGH_ARG_MISSING, format!("'{name}' is missing {which} {listed}"), span);
    }

    /// `reportPluginArgType`: an argument that is not an expression, against
    /// what the plugin declares it takes (an expression is held where the
    /// argument is checked).
    fn report_plugin_arg_type(&mut self, callee: &str, declared: Option<&SchemaFieldType>, arg: &CallArg, scope: crate::scope::ScopeId) {
        let name = arg.name().unwrap_or("");
        match arg {
            CallArg::Expr { .. } | CallArg::Closure { .. } | CallArg::Type { .. } => {}
            CallArg::Call { call, .. } => {
                match self.read_call(call, scope, crate::families::calls::CallPosition::Argument) {
                    crate::families::calls::CallReading::Value(_) => {}
                    crate::families::calls::CallReading::Refused { code, message, span } => self.report(code, message, span),
                    _ => {
                        // A function's call: it runs, and its value is the argument.
                        let shape = self.check_call(call, scope);
                        let record = shape.plane.pos.as_deref().cloned().or_else(|| crate::types::field::record_in(shape.plane.field.as_ref()).flatten());
                        let value = shape.plane.field.clone().or_else(|| shape.plane.pos.as_deref().map(|p| Ty::record(Some(p.clone()))));
                        self.check_plugin_arg_value(callee, declared, name, record.as_ref(), value.as_ref(), call.span);
                    }
                }
            }
            CallArg::Node { node, .. } => {
                if is_structured_or_open(declared) {
                    let synthesised = self.check_node_literal(node, scope);
                    let value = synthesised.clone().map(|p| Ty::record(Some(p)));
                    self.check_plugin_arg_value(callee, declared, name, synthesised.as_ref(), value.as_ref(), node.span);
                    return;
                }
                self.refuse_plugin_record_in_place(callee, declared, arg);
            }
            CallArg::Write { .. } => self.refuse_plugin_record_in_place(callee, declared, arg),
        }
    }

    /// `checkPluginArgValue`: a plugin argument's value against its declared type.
    pub fn check_plugin_arg_value(&mut self, callee: &str, declared: Option<&SchemaFieldType>, name: &str, record: Option<&Position>, value: Option<&Ty>, span: Span) {
        // TODO(records): where the plugin takes structured data (or declares
        // nothing), it is handed the record's fields — a record or file held
        // inside the value, and a record whose fields are read from its system
        // one at a time, are refused (`handleInPluginArgMessage`,
        // `recordAsFieldsProblem`); and a declared value type refuses a file
        // held below the whole value. Both need the held-handle walk
        // (`HeldHandle`) the type core does not carry.
        let Some(declared) = declared.filter(|d| !is_json(d)) else { return };
        if record.is_some() || value.is_some_and(|v| holds_records(Some(strip_absent(v)))) {
            self.report(
                codes::CALL_ARG_TYPE,
                format!(
                    "'{callee}' takes {} for '{name}', and this is a record — pass one of its fields ('{name}: r.website')",
                    describe_field_type(&Ty::from_schema(declared))
                ),
                span,
            );
        }
    }

    /// `refusePluginRecordInPlace`: a write, or a node literal where a plain
    /// value is taken, written in place as a plugin argument.
    fn refuse_plugin_record_in_place(&mut self, callee: &str, declared: Option<&SchemaFieldType>, arg: &CallArg) {
        let name = arg.name().unwrap_or("");
        let takes = match declared {
            None => "a value".to_string(),
            Some(d) if is_json(d) => "structured data".to_string(),
            Some(d) => describe_field_type(&Ty::from_schema(d)),
        };
        let is_write = matches!(arg, CallArg::Write { .. });
        let what = if is_write { "a write" } else { "a 'node { … }' literal" };
        let repair = if is_write {
            let whole = if is_structured_or_open(declared) { format!("'{name}: r' or ") } else { String::new() };
            format!("Run the write first ('r = write …') and pass {whole}one of its fields ('{name}: r.name')")
        } else {
            format!("Pass one of the values it would hold ('{name}: …')")
        };
        self.report(
            codes::CALL_ARG_TYPE,
            format!("'{callee}' takes {takes} for '{name}', and this is {what} written in place — a record, and a plugin's arguments are values. {repair}"),
            crate::families::calls::call_arg_span(arg),
        );
    }

    /// `reportPluginOutputChanged`: on a check for a move up, a plugin whose
    /// output changed shape between the pin and the version checked.
    fn report_plugin_output_changed(&mut self, call: &CallStatement, spec: &PluginSpec) {
        let Some(changed) = spec.earlier_outputs.iter().flatten().find(|entry| self.upgrade_crosses(entry.before)) else { return };
        let Some(now) = plugin_output_under(spec, self.version) else { return };
        let message = format!(
            "'{}' called on its own hands back {} since language version {}; before it, {}. Check that this call reads its result as the new shape.",
            call.callee,
            describe_plugin_output(now),
            crate::version::describe(changed.before),
            describe_plugin_output(&changed.output)
        );
        let mut diagnostic = Diagnostic::error(codes::PLUGIN_OUTPUT_CHANGED, message, call.span);
        diagnostic.severity = Some(Severity::Warning);
        diagnostic.upgrade = Some(true);
        self.push(diagnostic);
    }
}

fn is_json(declared: &SchemaFieldType) -> bool {
    matches!(Ty::from_schema(declared), Ty::Json)
}

/// Structured data, or no declared type: the plugin takes a record's fields.
fn is_structured_or_open(declared: Option<&SchemaFieldType>) -> bool {
    declared.is_none_or(is_json)
}
