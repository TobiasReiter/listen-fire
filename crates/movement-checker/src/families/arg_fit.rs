//! A call's arguments against the parameters they bind (`checkCallArg`):
//! each argument is checked in its own right, then held to its parameter —
//! a value against a value type (TypeScript's assignability, with its
//! excess-property check for a record literal), a record against a record
//! position. Part of the calls family (MOV_CALL_ARG_TYPE); the records
//! family's MOV_CALL_ARG_MAYBE_RECORD is raised here too.

use movement_parser::ast::{CallArg, ExprSlot, Span};
use movement_parser::lowering::expression::{Expression, ObjectMember, StaticValue};
use movement_parser::surface::phrase::spell_word;
use movement_parser::version::since;

use crate::checker::Checker;
use crate::codes;
use crate::families::calls::CallReading;
use crate::families::plugin_calls::PluginArgTypes;
use crate::meta::did_you_mean;
use crate::scope::{Resolution, ScopeId, SymbolId};
use crate::slots::is_bare_ident;
use crate::types::scope_env::SymbolTypes;
use crate::types::field::{
    HeldWalk, Ty, describe_field_type, field_assignable, handle_within, holds_records, is_maybe_absent, mixes_record_with_value, spell_held_steps, strip_absent,
    values_beside_record,
};
use crate::types::field::shows_more_handles;
use crate::types::position::{ClosureParam, Position, ReturnShape, describe_position, positions_match, system_difference};

/// `ArgFit`: whose argument this is, the parameter it binds, and its place.
pub struct ArgFit<'a> {
    pub callee: &'a str,
    pub param: Option<&'a ClosureParam>,
    pub index: usize,
    pub positional: bool,
    /// A plugin's call: its arguments are held to what it declares.
    pub plugin: Option<&'a PluginArgTypes<'a>>,
    /// Who makes the call and what it hands, where no author wrote a call:
    /// a collection op hands each member to its function.
    pub caller: Option<ArgCaller>,
}

pub struct ArgCaller {
    pub callee: String,
    pub argument: String,
}

/// `calleeWords`: the callee as a diagnostic names it.
fn callee_words(fit: &ArgFit) -> String {
    fit.caller.as_ref().map_or_else(|| format!("'{}'", fit.callee), |caller| caller.callee.clone())
}

impl ArgFit<'_> {
    fn field_type(&self) -> Option<&Ty> {
        self.param.and_then(|p| p.plane.field.as_ref())
    }

    fn pos_type(&self) -> Option<&Position> {
        self.param.and_then(|p| p.plane.pos.as_deref())
    }
}

/// What a record falls short of a parameter's need by (`fieldsInHandShortfall`).
pub struct Shortfall {
    pub what: String,
    pub why: String,
    pub whose: &'static str,
}

/// `describeArgPlace`: a positional argument is named for the author.
pub(crate) fn describe_arg_place(fit: &ArgFit) -> String {
    if !fit.positional {
        return String::new();
    }
    match fit.param {
        Some(param) => format!(" for '{}' (argument {})", param.name, fit.index + 1),
        None => format!(" (argument {})", fit.index + 1),
    }
}

/// `ArgValueOptions`: where a value argument is written, whether it is a
/// fresh record literal, and its parse (a string literal is its own type).
#[derive(Clone, Copy)]
struct ValueArg<'a> {
    span: Span,
    literal: bool,
    parsed: Option<&'a Expression>,
    slot: Option<&'a ExprSlot>,
}

impl ValueArg<'_> {
    fn at(span: Span) -> Self {
        ValueArg { span, literal: false, parsed: None, slot: None }
    }
}

fn record_of(position: Position) -> Ty {
    Ty::record(Some(position))
}

/// `valueOfReturn`.
fn value_of_return(shape: &ReturnShape) -> Option<Ty> {
    if let Some(field) = &shape.plane.field {
        return Some(field.clone());
    }
    shape.plane.pos.as_deref().map(|p| record_of(p.clone()))
}

/// `stringLiteralOf`.
fn string_literal_of(expr: Option<&Expression>) -> Option<&str> {
    match expr {
        Some(Expression::Static { value: StaticValue::String(text) }) => Some(text),
        _ => None,
    }
}

/// `isRecordLiteralSlot`.
fn is_record_literal_slot(slot: &ExprSlot) -> bool {
    slot.raw.trim().starts_with('{')
}

/// `listArgumentRewrite`.
fn list_argument_rewrite(slot: &ExprSlot) -> String {
    let raw = slot.raw.trim();
    if raw.contains("->") { format!("[...{raw}]") } else { format!("[{raw}]") }
}

/// `planeOfReturn` for a call's value: a name bound to it is on the plane
/// the callee's `return` was written on; a return nobody could type binds
/// neither.
pub fn types_of_return(returned: &ReturnShape) -> SymbolTypes {
    if !returned.returns {
        return SymbolTypes::default();
    }
    if let Some(field) = &returned.plane.field {
        return SymbolTypes { field: Some(field.clone()), may_hold: returned.may_hold.clone(), ..SymbolTypes::default() };
    }
    if let Some(pos) = &returned.plane.pos {
        return SymbolTypes { pos: Some((**pos).clone()), ..SymbolTypes::default() };
    }
    SymbolTypes { may_hold: returned.may_hold.clone(), ..SymbolTypes::default() }
}

impl Checker<'_> {
    /// `movementParams`: a movement's parameters with the types they declare,
    /// resolved where the movement is declared. An unannotated one has none.
    /// An imported movement carries the library's declaration.
    pub fn movement_declared_params(&self, id: SymbolId) -> Option<Vec<ClosureParam>> {
        let info = self.listens.movement_info(id)?;
        let function = self.movement_declaration(id).map_or_else(|| self.scopes.symbol(id).name.clone(), |(movement, _)| movement.name.clone());
        let of = crate::binding_types::ParamOf { owner: Some(crate::binding_types::NeedOwner::Function(self.declared_id(id))), function };
        Some(
            info.params
                .iter()
                .map(|param| ClosureParam {
                    name: param.name.clone(),
                    plane: param.type_.as_ref().map(|t| self.parameter_plane(&of, &param.name, self.plane_type_of(t, info.decl_scope))).unwrap_or_default(),
                })
                .collect(),
        )
    }

    /// `movementReturnType`: what a call of a movement hands back — what it
    /// declares (version 3), else what its body was found to hand back. A
    /// call reached while that body is still being walked gets the unknown.
    /// An imported movement answers with its library declaration.
    pub fn movement_return(&mut self, id: SymbolId) -> ReturnShape {
        let Some((movement, declared_in)) = self.movement_declaration(id) else { return crate::families::returns::unknown_return() };
        let written = movement.return_type.as_ref().filter(|_| since(self.version, 3));
        if !(written.is_some() && since(self.version, 5)) {
            self.infer_movement(id);
        }
        let inferred = self.movement_inferred_return(id);
        let Some(written) = written else {
            return inferred.unwrap_or_else(crate::families::returns::unknown_return);
        };
        let declared = ReturnShape { returns: true, plane: self.plane_type_of(written, declared_in), may_hold: None };
        // Before version 5 a declaration that does not take what a return may
        // hold is not refused where it is written, so the call still carries
        // what the body may hand back.
        if since(self.version, 5) {
            return declared;
        }
        match inferred.and_then(|i| i.may_hold).filter(|held| shows_more_handles(held, declared.plane.field.as_ref())) {
            Some(held) => ReturnShape { may_hold: Some(held), ..declared },
            None => declared,
        }
    }

    /// Each argument checked, and held to the parameter it binds — by name,
    /// or by its place among `params`.
    pub fn check_call_args(&mut self, callee: &str, args: &[CallArg], params: Option<&[ClosureParam]>, plugin: Option<&PluginArgTypes>, scope: ScopeId) {
        for (index, arg) in args.iter().enumerate() {
            let param = params.and_then(|params| {
                let name = arg.name().or_else(|| params.get(index).map(|p| p.name.as_str()))?;
                params.iter().find(|p| p.name == name)
            });
            let fit = ArgFit { callee, param, index, positional: arg.name().is_none(), plugin, caller: None };
            self.check_call_arg(&fit, arg, scope);
        }
    }

    /// `checkCallArg`: one argument, in its own right and against its parameter.
    fn check_call_arg(&mut self, fit: &ArgFit, arg: &CallArg, scope: ScopeId) {
        match arg {
            CallArg::Expr { expr, name } => self.check_expr_arg(fit, name.as_deref(), expr, scope),
            CallArg::Write { write, .. } => {
                let handle = self.check_write(write, scope, None, true);
                match fit.field_type() {
                    Some(param) => self.check_value_arg_fit(fit, param, handle.map(record_of).as_ref(), ValueArg::at(write.span)),
                    None => {
                        self.check_call_arg_fit(fit, handle.as_ref(), fit.pos_type(), write.span);
                        self.check_arg_fields_in_hand(fit, handle.as_ref(), write.span);
                    }
                }
            }
            CallArg::Node { node, .. } => {
                let synthesised = self.check_node_literal(node, scope);
                match fit.field_type() {
                    Some(param) => self.check_value_arg_fit(fit, param, synthesised.map(record_of).as_ref(), ValueArg::at(node.span)),
                    None => {
                        self.check_call_arg_fit(fit, synthesised.as_ref(), fit.pos_type(), node.span);
                        self.check_arg_fields_in_hand(fit, synthesised.as_ref(), node.span);
                    }
                }
            }
            CallArg::Closure { closure, span, .. } if since(self.version, 5) => {
                // A plugin's argument is never closure-typed: the mismatch is
                // the error, so the closure is not checked against nothing.
                if fit.plugin.is_some() {
                    self.report(
                        codes::CALL_ARG_TYPE,
                        format!("The argument{} to '{}' is a function written in place, and a plugin takes a value, not a function", describe_arg_place(fit), fit.callee),
                        *span,
                    );
                    return;
                }
                let label = format!("the argument{} to '{}'", describe_arg_place(fit), fit.callee);
                // The parameter's closure type supplies the types its
                // parameters leave out (contextual typing).
                let supplied = fit.field_type().and_then(closure_of_value).map_or(0, |expected| expected.params.len());
                let body = self.check_closure_as(closure, scope, None, &label, supplied);
                // Held to the parameter's type with what its body hands back.
                let returns = self.closure_returns(closure, body.value, scope);
                let value = self.closure_type(closure, scope).map(|c| record_of(Position::Closure(crate::types::position::ClosureType { returns, ..c })));
                if let Some(param) = fit.field_type() {
                    self.check_value_arg_fit(fit, param, value.as_ref(), ValueArg::at(*span));
                } else if let Some(param) = fit.pos_type() {
                    self.report(
                        codes::CALL_ARG_TYPE,
                        format!(
                            "'{}' expects {}{}, but this argument is a closure — a record parameter takes a record; declare the parameter as a closure type ('<() => <text>>') to pass a function",
                            fit.callee,
                            describe_position(param),
                            describe_arg_place(fit)
                        ),
                        *span,
                    );
                }
            }
            // Before version 5 a function is not a value.
            CallArg::Closure { span, .. } | CallArg::Type { span, .. } => {
                let what = if matches!(arg, CallArg::Closure { .. }) { "a function written in place" } else { "a type" };
                self.report(
                    codes::CALL_ARG_TYPE,
                    format!(
                        "The argument{} to '{}' is {what}, which is not a value an argument can carry — only a built-in that takes one (MAP, FILTER, REDUCE, GROUPBY, KEYBY, MEMBERS) is handed one",
                        describe_arg_place(fit),
                        fit.callee
                    ),
                    *span,
                );
            }
            CallArg::Call { call, .. } => match self.read_call(call, scope, crate::families::calls::CallPosition::Argument) {
                // A built-in called here is the value it computes.
                CallReading::Value(expr) => self.check_expr_arg(fit, arg.name(), &expr, scope),
                CallReading::Refused { code, message, span } => self.report(code, message, span),
                _ => {
                    let value = self.check_call(call, scope);
                    if let Some(param) = fit.field_type() {
                        self.check_value_arg_fit(fit, param, value_of_return(&value).as_ref(), ValueArg::at(call.span));
                        return;
                    }
                    let pos = value.plane.pos.as_deref();
                    self.refuse_value_for_position(fit, if pos.is_none() { value.plane.field.as_ref() } else { None }, call.span);
                    if pos.is_none() {
                        self.refuse_maybe_record_for_position(fit, &[value.may_hold.as_ref(), value.plane.field.as_ref()], call.span, &format!("{}(…)", call.callee));
                    }
                    self.check_call_arg_fit(fit, pos, fit.pos_type(), call.span);
                    self.check_arg_fields_in_hand(fit, pos, call.span);
                }
            },
        }
    }

    /// `checkCallArg`'s expression case.
    fn check_expr_arg(&mut self, fit: &ArgFit, name: Option<&str>, expr: &ExprSlot, scope: ScopeId) {
        let plugin_declared = fit.plugin.and_then(|plugin| name.and_then(|name| plugin.declared.and_then(|d| d.0.get(name))));
        let held_takes = fit.plugin.map(|_| crate::families::plugin_calls::plugin_arg_held_takes(plugin_declared));
        let typed = self.check_expr_slot_with(expr, scope, crate::checker::SlotOptions { held_takes, ..crate::checker::SlotOptions::default() });
        let arg_type = self.bare_slot_position_type(expr, scope);
        // A plugin's named argument: a value against what the plugin takes
        // (a positional one is refused where the call is checked).
        if let (Some(_), Some(name)) = (fit.plugin, name) {
            let record = arg_type.clone().or_else(|| crate::types::field::record_in(typed.ty.as_ref()).flatten());
            self.check_plugin_arg_value(crate::families::plugin_calls::PluginArg {
                callee: fit.callee,
                declared: plugin_declared,
                name,
                record: record.as_ref(),
                value: typed.ty.as_ref(),
                held: typed.held,
                may_hold: typed.may_hold.as_ref(),
                span: expr.span,
            });
            return;
        }
        if let Some(param) = fit.field_type() {
            if arg_type.is_none() {
                self.refuse_maybe_record_for_value(fit, param, typed.ty.as_ref(), typed.may_hold.as_ref(), expr.span, expr.raw.trim());
            }
            let value = arg_type.clone().map(record_of).or(typed.ty);
            let options = ValueArg { span: expr.span, literal: is_record_literal_slot(expr), parsed: typed.expr.as_ref(), slot: Some(expr) };
            self.check_value_arg_fit(fit, param, value.as_ref(), options);
            return;
        }
        self.refuse_value_for_position(fit, if arg_type.is_none() { typed.ty.as_ref() } else { None }, expr.span);
        if arg_type.is_none() {
            self.refuse_maybe_record_for_position(fit, &[typed.may_hold.as_ref(), typed.ty.as_ref()], expr.span, expr.raw.trim());
        }
        self.check_call_arg_fit(fit, arg_type.as_ref(), fit.pos_type(), expr.span);
        let arg = arg_type.or_else(|| crate::types::field::record_in(typed.ty.as_ref()).flatten());
        self.check_arg_fields_in_hand(fit, arg.as_ref(), expr.span);
    }

    /// `checkArgFieldsInHand`: a record argument against what the callee's
    /// body needs of it (`FieldsNeed`) — TypeScript's parameter-versus-
    /// argument check, on whether the record's fields are in hand. The
    /// calling function's own parameter, passed on, takes on the callee's
    /// need instead: its callers answer for it.
    fn check_arg_fields_in_hand(&mut self, fit: &ArgFit, arg: Option<&Position>, span: Span) {
        let (Some(need), Some(arg)) = (crate::types::position::parameter_need_of(fit.pos_type()), arg) else { return };
        let param = need.borrow().param.clone();
        let Some(shortfall) = self.fields_in_hand_shortfall(&need, arg, &format!("passes it to '{}' as '{param}' (line {})", fit.callee, span.start.line)) else { return };
        self.report(
            codes::CALL_ARG_OPAQUE_RECORD,
            format!(
                "'{callee}' needs every field of {} in hand — its body {} — and this argument is {}, {}{}. Copy the fields it needs into a record the program holds and pass that ('node {{ name: r.name, … }}'), or have '{callee}' read the fields it uses one by one",
                shortfall.what,
                shortfall.why,
                describe_position(arg),
                shortfall.whose,
                describe_arg_place(fit),
                callee = fit.callee
            ),
            span,
        );
    }

    /// `fieldsInHandShortfall`: what `record` falls short of `need` by, if
    /// anything — the fields of the record itself, or of the records reached
    /// through its edges. A record that is itself a parameter of the function
    /// being checked, with its fields in hand there, files `need` as its own
    /// (`passedTo`, said `at`).
    pub(crate) fn fields_in_hand_shortfall(&self, need: &crate::types::position::NeedRef, record: &Position, at: &str) -> Option<Shortfall> {
        use crate::types::position::{FieldsReach, fields_needed_by, parameter_need_of};
        let in_hand = self.holds_fields_in_hand(record);
        let own = parameter_need_of(Some(record));
        if in_hand && let Some(own) = own {
            let already = std::rc::Rc::ptr_eq(&own, need) || own.borrow().passed_to.iter().any(|(onward, _)| std::rc::Rc::ptr_eq(onward, need));
            if !already {
                own.borrow_mut().passed_to.push((need.clone(), at.to_string()));
            }
            return None;
        }
        let param = need.borrow().param.clone();
        let why = if in_hand { None } else { fields_needed_by(need, FieldsReach::Record, &mut Vec::new()) };
        if let Some(why) = why {
            return Some(Shortfall { what: format!("'{param}'"), why, whose: "whose fields are read from its system one at a time" });
        }
        if self.holds_reached_fields_in_hand(record) {
            return None;
        }
        let why = fields_needed_by(need, FieldsReach::Reached, &mut Vec::new())?;
        Some(Shortfall { what: format!("the records '{param}' leads to"), why, whose: "whose linked records are the system's, read one field at a time" })
    }

    /// `holdsReachedFieldsInHand`: does the checker hold the fields of the
    /// records reached through this record's edges? A walked child of a
    /// system's record is the system's record; a record the run built (or
    /// extracted, or a declared shape's) holds its children, unless it holds
    /// a system's records by reference.
    fn holds_reached_fields_in_hand(&self, position: &Position) -> bool {
        let declared = |instance: &crate::types::position::InstanceRef| instance.declared.is_some_and(|symbol| self.nodes.is_local(symbol));
        match position {
            Position::Extract { .. } => true,
            Position::Local(_) => crate::families::records::live_reference_within(position, &declared, &String::new).is_none(),
            Position::MaybeEmpty(of) => self.holds_reached_fields_in_hand(of),
            Position::Handle(handle) => declared(&handle.instance),
            Position::Position(record) => declared(&record.instance),
            Position::Union(union) => declared(&union.instance),
            Position::Meta { .. } | Position::Closure(_) => false,
        }
    }

    /// `bareSlotPositionType`: the record a bare name denotes.
    pub(crate) fn bare_slot_position_type(&self, slot: &ExprSlot, scope: ScopeId) -> Option<Position> {
        let trimmed = slot.raw.trim();
        if !is_bare_ident(trimmed) {
            return None;
        }
        let Resolution::Found(id) = self.scopes.resolve(scope, trimmed) else { return None };
        crate::binding_types::symbol_position(&self.scopes.symbol(id).types)
    }

    /// `refuseValueForPosition` (version 3): a value handed to a parameter that takes a record.
    fn refuse_value_for_position(&mut self, fit: &ArgFit, value: Option<&Ty>, span: Span) {
        let (Some(position), Some(value)) = (fit.pos_type(), value) else { return };
        if holds_records(Some(value)) || !since(self.version, 3) {
            return;
        }
        self.report(
            codes::CALL_ARG_TYPE,
            format!(
                "'{}' expects {}{}, but this argument is {} — a record parameter takes a record (a bound record, a node, or a write); declare the parameter as a value type ('<text>', '<{{ … }}>') to pass a value",
                fit.callee,
                describe_position(position),
                describe_arg_place(fit),
                describe_field_type(value)
            ),
            span,
        );
    }

    /// `refuseMaybeRecordForPosition` (version 5): a value that may be a
    /// record and may be something else is no record.
    fn refuse_maybe_record_for_position(&mut self, fit: &ArgFit, types: &[Option<&Ty>], span: Span, written: &str) {
        let Some(position) = fit.pos_type() else { return };
        if !since(self.version, 5) {
            return;
        }
        let Some(mixed) = types.iter().copied().find(|t| mixes_record_with_value(*t)).flatten() else { return };
        let mut others: Vec<String> = Vec::new();
        for member in values_beside_record(Some(mixed)) {
            let described = describe_field_type(&member);
            if !others.contains(&described) {
                others.push(described);
            }
        }
        self.report(
            codes::CALL_ARG_MAYBE_RECORD,
            format!(
                "'{}' expects {}{}, but '{written}' may be {} — a record or {}, and such a union is no record, as in TypeScript. Narrow it to the record with {} before passing it, handle the case where it is not one, or fill the other arm with a record so the argument is always one",
                fit.callee,
                describe_position(position),
                describe_arg_place(fit),
                describe_field_type(mixed),
                others.join(" or "),
                spell_word("IS", self.version)
            ),
            span,
        );
    }

    /// `refuseMaybeRecordForValue`: a value that may be a record (or a file)
    /// and may be something else, handed to a value parameter that takes
    /// neither. Its type cannot say so (no union mixes a record with a value);
    /// what it may hold does. Refused from version 5; from 3 the call ran with
    /// the record passed through, so an older pin is warned.
    pub(crate) fn refuse_maybe_record_for_value(&mut self, fit: &ArgFit, param: &Ty, value: Option<&Ty>, may_hold: Option<&Ty>, span: Span, written: &str) {
        if !since(self.version, 3) || may_hold.is_none() {
            return;
        }
        let walk = HeldWalk::taken_by(Some(param));
        let Some(hidden) = handle_within(may_hold, &walk) else { return };
        // The value's own type shows the record: the fit check says it.
        if handle_within(value, &walk).is_some() {
            return;
        }
        let steps = spell_held_steps(&hidden.steps);
        let file = matches!(hidden.handle, Ty::File);
        let held = describe_field_type(&hidden.handle);
        let where_ = if steps.is_empty() { format!("may be {held}") } else { format!("may hold {held} at '{steps}'") };
        let repair = if file {
            "Pass its text ('READ(f)')".to_string()
        } else {
            format!("Narrow it to the record with {} and pass a field off it ('r.`Name`')", spell_word("IS", self.version))
        };
        let argument = fit.caller.as_ref().map_or_else(|| format!("'{written}'"), |caller| caller.argument.clone());
        let param_words = describe_field_type(param);
        let message = format!(
            "{} expects {param_words}{}, but {argument} {where_} — {}, not a value, and such a union is no {param_words}, as in TypeScript. {repair}, or fill every arm with a value",
            callee_words(fit),
            describe_arg_place(fit),
            if file { "a file" } else { "a record" }
        );
        if since(self.version, 5) {
            self.report(codes::CALL_ARG_MAYBE_RECORD, message, span);
            return;
        }
        self.report_upgrade_warning(
            codes::CALL_ARG_MAYBE_RECORD,
            format!(
                "{message}. Before {} the {} is passed through as it is; from it, this is refused",
                crate::version::describe(5),
                if file { "file" } else { "record" }
            ),
            span,
        );
    }

    /// `checkValueArgFit` for a value no author wrote (a member an op hands its function).
    pub(crate) fn check_value_arg_fit_at(&mut self, fit: &ArgFit, param_ty: &Ty, arg_ty: Option<&Ty>, span: Span) {
        self.check_value_arg_fit(fit, param_ty, arg_ty, ValueArg::at(span));
    }

    /// `checkCallArgFit` for a record no author wrote.
    pub(crate) fn check_call_arg_fit_at(&mut self, fit: &ArgFit, arg: Option<&Position>, param: &Position, span: Span) {
        self.check_call_arg_fit(fit, arg, Some(param), span);
    }

    /// `checkValueArgFit`: a value argument against a value parameter.
    fn check_value_arg_fit(&mut self, fit: &ArgFit, param_ty: &Ty, arg_ty: Option<&Ty>, options: ValueArg) {
        let Some(arg_ty) = arg_ty else { return };
        let span = options.span;
        let expected = format!("{} expects {}{}", callee_words(fit), describe_field_type(param_ty), describe_arg_place(fit));
        let argument = fit.caller.as_ref().map_or("this argument", |caller| caller.argument.as_str());
        if let Some(literal) = string_literal_of(options.parsed)
            && self.report_enum_literal(literal, strip_absent(param_ty), span)
        {
            return;
        }
        if is_maybe_absent(Some(arg_ty)) && !is_maybe_absent(Some(param_ty)) {
            self.report(
                codes::CALL_ARG_TYPE,
                format!("{expected}, but {argument} may be absent — fill it first ('COALESCE(x, …)') or declare the parameter as a record key that may be left out ('{{ key?: … }}')"),
                span,
            );
            return;
        }
        let param = strip_absent(param_ty);
        let arg = strip_absent(arg_ty);
        if let Ty::Dict { shape: Some(keys), .. } = param {
            self.check_record_arg_fit(&expected, keys, arg, options);
            return;
        }
        if field_assignable(arg, param) {
            return;
        }
        let as_list = match (options.slot, param) {
            (Some(slot), Ty::List { of, .. }) if field_assignable(arg, of) => Some((slot.span, list_argument_rewrite(slot))),
            _ => None,
        };
        let message = match &as_list {
            Some((_, text)) => format!("{expected}, but {argument} is {} — pass it as a list: '{text}'", describe_field_type(arg)),
            None => format!("{expected}, but {argument} is {}", describe_field_type(arg)),
        };
        let mut diagnostic = crate::diagnostic::Diagnostic::error(codes::CALL_ARG_TYPE, message, span);
        if let Some((at, text)) = as_list {
            diagnostic.fix = Some(serde_json::json!({ "edits": [{ "span": at, "text": text }] }));
        }
        self.push(diagnostic);
    }

    /// `checkRecordArgFit`: a value against a record parameter's declared keys.
    fn check_record_arg_fit(&mut self, expected: &str, keys: &movement_parser::catalog::types::JsMap<Option<Ty>>, arg: &Ty, options: ValueArg) {
        let span = options.span;
        let Ty::Dict { shape: supplied, .. } = arg else {
            self.report(codes::CALL_ARG_TYPE, format!("{expected}, but this argument is {}", describe_field_type(arg)), span);
            return;
        };
        let required: Vec<&String> = keys.0.iter().filter(|(_, t)| t.as_ref().is_some_and(|t| !is_maybe_absent(Some(t)))).map(|(k, _)| k).collect();
        let quoted = |names: &[&String]| names.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(", ");
        let Some(supplied) = supplied else {
            if !required.is_empty() {
                self.report(
                    codes::CALL_ARG_TYPE,
                    format!("{expected}, but this argument is {}, whose keys are data — nothing says it has {}", describe_field_type(arg), quoted(&required)),
                    span,
                );
            }
            return;
        };
        let missing: Vec<&String> = required.iter().copied().filter(|k| !supplied.0.contains_key(k.as_str())).collect();
        if !missing.is_empty() {
            let which = if missing.len() == 1 { "the key" } else { "the keys" };
            self.report(codes::CALL_ARG_TYPE, format!("{expected}, but this argument is missing {which} {}", quoted(&missing)), span);
        }
        if options.literal {
            let excess: Vec<&String> = supplied.0.keys().filter(|k| !keys.0.contains_key(k.as_str())).collect();
            if let Some(first) = excess.first() {
                let which = if excess.len() == 1 { "key" } else { "keys" };
                let known: Vec<&String> = keys.0.keys().collect();
                self.report(codes::CALL_ARG_TYPE, format!("{expected}, which has no {which} {}{}", quoted(&excess), did_you_mean(first, &known)), span);
            }
        }
        let written: &[ObjectMember] = match options.parsed {
            Some(Expression::Object { entries }) => entries,
            _ => &[],
        };
        for (key, key_ty) in &keys.0 {
            let (Some(key_ty), Some(Some(given))) = (key_ty, supplied.0.get(key)) else { continue };
            let literal = written.iter().find_map(|entry| match entry {
                ObjectMember::Entry { key: k, value } if k == key => string_literal_of(Some(value)),
                _ => None,
            });
            if let Some(literal) = literal
                && self.report_enum_literal(literal, strip_absent(key_ty), span)
            {
                continue;
            }
            if is_maybe_absent(Some(given)) && !is_maybe_absent(Some(key_ty)) {
                self.report(codes::CALL_ARG_TYPE, format!("{expected}, and its key '{key}' is required, but the value given for it may be absent"), span);
                continue;
            }
            if !field_assignable(given, key_ty) {
                self.report(
                    codes::CALL_ARG_TYPE,
                    format!(
                        "{expected}, and its key '{key}' takes {}, but the value given for it is {}",
                        describe_field_type(strip_absent(key_ty)),
                        describe_field_type(strip_absent(given))
                    ),
                    span,
                );
            }
        }
    }

    /// `reportEnumLiteral`: a string literal against a closed option set.
    /// True when the target is one (the literal has then been judged).
    fn report_enum_literal(&mut self, literal: &str, target: &Ty, span: Span) -> bool {
        if !matches!(target, Ty::Enum { .. }) {
            return false;
        }
        if let Some(diagnostic) = crate::families::values::check_enum_literal(literal, target) {
            let mut reported = crate::diagnostic::Diagnostic::error(diagnostic.code, diagnostic.message, span);
            reported.severity = diagnostic.severity;
            self.push(reported);
        }
        true
    }

    /// `checkCallArgFit`: the argument's record against the parameter's position.
    fn check_call_arg_fit(&mut self, fit: &ArgFit, arg: Option<&Position>, param: Option<&Position>, span: Span) {
        let (Some(arg), Some(param)) = (arg, param) else { return };
        let place = describe_arg_place(fit);
        if matches!(arg, Position::Local(_)) {
            if let Some(misfit) = crate::families::nodes::structural_misfit(arg, param, self.version) {
                self.report(codes::NODE_ARG_SHAPE, format!("'{}' expects {}{place}, and {misfit}", fit.callee, describe_position(param)), span);
            }
            return;
        }
        // A declared node belongs to no system, so there is no identity to
        // match: the argument fits when it carries the structure.
        if let Position::Position(p) = param
            && p.instance.declared.is_some()
        {
            if let Some(misfit) = crate::families::nodes::declared_param_misfit(arg, p, self.version) {
                self.report(codes::CALL_ARG_TYPE, format!("'{}' expects a <{}> record{place}, and {misfit}", fit.callee, p.position), span);
            }
            return;
        }
        if positions_match(arg, param) == Some(false) {
            self.report(
                codes::CALL_ARG_TYPE,
                format!(
                    "'{}' expects {}{}, but this argument is {}{}",
                    fit.callee,
                    describe_position(param),
                    describe_arg_place(fit),
                    describe_position(arg),
                    system_difference(arg, param)
                ),
                span,
            );
        }
    }
}

/// `closureOfValue`: the closure a value type is (every member of a union one).
fn closure_of_value(ty: &Ty) -> Option<crate::types::position::ClosureType> {
    match strip_absent(ty) {
        Ty::Record(Some(position)) => match position.as_ref() {
            Position::Closure(closure) => Some(closure.clone()),
            _ => None,
        },
        _ => None,
    }
}
