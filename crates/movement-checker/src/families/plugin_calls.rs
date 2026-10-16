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
use crate::types::field::{CollectionOrder, HandleKinds, HeldHandle, HeldStep, Ty, describe_field_type, holds_records, list_of, spell_held_steps, strip_absent};
use crate::types::position::{LocalNode, PlaneType, Position, ReturnShape, describe_position};

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
                        // A function's call: it runs, and its value is the
                        // argument — a value bound, as `boundCallShape` reads it.
                        let shape = self.check_call(call, scope);
                        self.note_bound_self_call(&call.callee, call.span, scope);
                        if self.callee_returns(&call.callee, scope) == Some(false) {
                            self.report_call_returns_nothing(&call.callee, call.span);
                        }
                        let record = shape.plane.pos.as_deref().cloned().or_else(|| crate::types::field::record_in(shape.plane.field.as_ref()).flatten());
                        let value = shape.plane.field.clone().or_else(|| shape.plane.pos.as_deref().map(|p| Ty::record(Some(p.clone()))));
                        self.check_plugin_arg_value(PluginArg { callee, declared, name, record: record.as_ref(), value: value.as_ref(), held: None, may_hold: None, span: call.span });
                    }
                }
            }
            CallArg::Node { node, .. } => {
                if is_structured_or_open(declared) {
                    let synthesised = self.check_node_literal(node, scope);
                    let value = synthesised.clone().map(|p| Ty::record(Some(p)));
                    self.check_plugin_arg_value(PluginArg { callee, declared, name, record: synthesised.as_ref(), value: value.as_ref(), held: None, may_hold: None, span: node.span });
                    return;
                }
                self.refuse_plugin_record_in_place(callee, declared, arg);
            }
            CallArg::Write { .. } => self.refuse_plugin_record_in_place(callee, declared, arg),
        }
    }

    /// `checkPluginArgValue`: a plugin argument's value against its declared type.
    pub fn check_plugin_arg_value(&mut self, arg: PluginArg) {
        let PluginArg { callee, declared, name, record, value, held, may_hold, span } = arg;
        // Where a plugin takes a record at all (structured data, or no
        // declared type), it takes it as the WHOLE argument and is handed its
        // fields. A record anywhere inside that value reaches the plugin as
        // the engine's own description of it; so does a file anywhere in it.
        if is_structured_or_open(declared) {
            if let Some(held) = held.as_ref().filter(|h| !h.steps.is_empty() || h.is_file()) {
                self.report(codes::CALL_ARG_TYPE, handle_in_plugin_arg_message(callee, name, held), span);
                return;
            }
            // The whole argument a record is handed its fields, all at once:
            // none may be a file, and a record whose fields are read from its
            // system one at a time has none to hand.
            let whole = held.or_else(|| record.map(|r| HeldHandle { steps: Vec::new(), handle: Ty::record(Some(r.clone())), may: false }));
            let purpose = format!("hands it to '{callee}' as '{name}', which takes every field (line {})", span.start.line);
            let Some(problem) = whole.and_then(|whole| self.record_as_fields_problem(whole, &purpose)) else { return };
            if problem.is_file() {
                self.report(codes::CALL_ARG_TYPE, handle_in_plugin_arg_message(callee, name, &problem), span);
                return;
            }
            let Ty::Record(Some(position)) = strip_absent(&problem.handle) else { return };
            self.report(
                codes::CALL_ARG_TYPE,
                format!(
                    "'{callee}' takes every field of the record it is given as '{name}', and this {} {}, whose fields are read from its system one at a time. Pass a dict of the fields it needs ('{name}: {{ name: r.name, … }}')",
                    if problem.may { "may be" } else { "is" },
                    describe_position(position)
                ),
                span,
            );
            return;
        }
        let Some(declared) = declared else { return };
        if record.is_some() || value.is_some_and(|v| holds_records(Some(strip_absent(v)))) {
            self.report(
                codes::CALL_ARG_TYPE,
                format!(
                    "'{callee}' takes {} for '{name}', and this is a record — pass one of its fields ('{name}: r.website')",
                    describe_field_type(&Ty::from_schema(declared))
                ),
                span,
            );
            return;
        }
        // A declared value type takes what it holds and nothing else of the
        // engine's: a text argument no file and no record, at any depth or in
        // any arm; a file argument a file as the whole value, never one
        // inside a map or a list.
        let declared_ty = Ty::from_schema(declared);
        let misplaced = held.or_else(|| if matches!(strip_absent(&declared_ty), Ty::File) { file_below_whole(may_hold.or(value)) } else { None });
        let Some(misplaced) = misplaced else { return };
        self.report(codes::CALL_ARG_TYPE, handle_in_typed_plugin_arg_message(callee, name, &declared_ty, &misplaced), span);
    }

    /// `recordAsFieldsProblem`: a record handed over as its fields — a file
    /// among them, or a record whose fields its system reads one at a time
    /// (the problem); `None` where the program holds them in hand.
    fn record_as_fields_problem(&self, held: HeldHandle, purpose: &str) -> Option<HeldHandle> {
        let Ty::Record(Some(position)) = strip_absent(&held.handle) else { return None };
        let walk = crate::types::field::HeldWalk { steps: held.steps.clone(), accepts_record: true, accepts_file: false };
        if let Some(file_field) = crate::types::field::handle_spread_of(Some(&held.handle), &walk) {
            return Some(HeldHandle { may: file_field.may || held.may, ..file_field });
        }
        if self.holds_fields_in_hand(position) {
            crate::types::position::note_fields_needed(Some(position), || purpose.to_string());
            return None;
        }
        Some(held)
    }

    /// `holdsFieldsInHand` with the declared shapes' graphs told apart from a
    /// system's: a declared node's fields are the program's own.
    pub fn holds_fields_in_hand(&self, position: &Position) -> bool {
        match position {
            Position::Position(p) => p.instance.declared.is_some_and(|symbol| self.nodes.is_local(symbol)),
            Position::Union(u) => u.instance.declared.is_some_and(|symbol| self.nodes.is_local(symbol)),
            Position::MaybeEmpty(of) => self.holds_fields_in_hand(of),
            _ => crate::types::infer::holds_fields_in_hand(position),
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

/// A plugin argument's value, as `checkPluginArgValue` judges it.
pub struct PluginArg<'a> {
    pub callee: &'a str,
    pub declared: Option<&'a SchemaFieldType>,
    pub name: &'a str,
    pub record: Option<&'a Position>,
    pub value: Option<&'a Ty>,
    /// The record or file the value holds that the declared type does not take.
    pub held: Option<HeldHandle>,
    /// What the value may turn out to be, arm by arm.
    pub may_hold: Option<&'a Ty>,
    pub span: Span,
}

/// `pluginArgSlotOptions`: for a declared value type, the engine objects that
/// type takes are passed over; structured data (or no declared type) finds
/// every object, the record handed whole included.
pub fn plugin_arg_held_takes(declared: Option<&SchemaFieldType>) -> HandleKinds {
    match declared.filter(|d| !is_json(d)) {
        None => HandleKinds::default(),
        Some(declared) => HandleKinds::taken_by(Some(&Ty::from_schema(declared))),
    }
}

/// `handleInPluginArgMessage`.
fn handle_in_plugin_arg_message(callee: &str, name: &str, held: &HeldHandle) -> String {
    let said = format!(
        "'{callee}' takes structured data for '{name}', and '{name}{}' {} {}",
        spell_held_steps(&held.steps),
        if held.may { "may be" } else { "is" },
        describe_field_type(&held.handle)
    );
    if held.is_file() {
        let at = if held.steps.is_empty() { repair_at(Some(name), None, "READ(f)") } else { repair_at(None, Some(held), "READ(f)") };
        return format!("{said} — a file, not a value. A file goes to a plugin only as an argument it takes a file for; inside a value, put its text in its place ({at}).");
    }
    format!(
        "{said} — a record, not a value. A record goes to a plugin only as the whole argument ('{name}: r', which hands it the record's fields); inside a value, write a field off it ({}).",
        repair_at(None, Some(held), "r.`Name`")
    )
}

/// `handleInTypedPluginArgMessage`: a declared value type's argument holding
/// a record or a file the type does not take, where it sits.
fn handle_in_typed_plugin_arg_message(callee: &str, name: &str, declared: &Ty, held: &HeldHandle) -> String {
    let direct = held.steps.is_empty();
    let where_ = if direct { "this".to_string() } else { format!("'{name}{}'", spell_held_steps(&held.steps)) };
    let said = format!("'{callee}' takes {} for '{name}', and {where_} {} {}", describe_field_type(declared), if held.may { "may be" } else { "is" }, describe_field_type(&held.handle));
    let at = |repair: &str| if direct { repair_at(Some(name), None, repair) } else { repair_at(None, Some(held), repair) };
    if held.is_file() {
        let as_whole = if matches!(strip_absent(declared), Ty::File) { format!("hand it over as the whole argument ('{name}: f'), or ") } else { String::new() };
        return format!("{said} — a file, not a value. A file goes to a plugin only as an argument it takes a file for; {as_whole}put its text in its place ({}).", at("READ(f)"));
    }
    format!("{said} — a record, not a value. Pass one of its fields ({}).", at("r.`Name`"))
}

/// `repairAt`: a repair, placed under the key the engine object sat at where
/// there is one (or under the argument's own name).
fn repair_at(name: Option<&str>, held: Option<&HeldHandle>, repair: &str) -> String {
    let place = name.map(str::to_string).or_else(|| match held.and_then(|h| h.steps.last()) {
        Some(HeldStep::Key(key)) => Some(key.clone()),
        _ => None,
    });
    match place {
        Some(place) => format!("'{place}: {repair}'"),
        None => format!("'{repair}'"),
    }
}

/// `fileBelowWhole`: a file somewhere below the value — under a key, as a
/// member — in any arm; a file that is the whole value (or one arm) is not one.
fn file_below_whole(ty: Option<&Ty>) -> Option<HeldHandle> {
    let ty = ty?;
    match strip_absent(ty) {
        Ty::Union(members) => members.iter().find_map(|member| file_below_whole(Some(member))).map(|held| HeldHandle { may: true, ..held }),
        Ty::File => None,
        _ => crate::types::field::handle_within(Some(ty), &HandleKinds { record: true, file: false }.walk()),
    }
}

/// Structured data, or no declared type: the plugin takes a record's fields.
fn is_structured_or_open(declared: Option<&SchemaFieldType>) -> bool {
    declared.is_none_or(is_json)
}
