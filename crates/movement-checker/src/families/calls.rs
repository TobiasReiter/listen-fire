//! The calls family: not yet ported. Its codes (PORT.md has where the
//! TypeScript raises each):
//!
//! - MOV_BUILTIN_ARGS
//! - MOV_BUILTIN_ARG_TYPE
//! - MOV_BUILTIN_NOT_RUN
//! - MOV_BUILTIN_UNUSED
//! - MOV_CALL_ARG_DUPLICATE
//! - MOV_CALL_ARG_MISSING
//! - MOV_CALL_ARG_TYPE
//! - MOV_CALL_ARG_UNKNOWN
//! - MOV_CALL_ARITY
//! - MOV_CALL_NESTED
//! - MOV_CALL_NOT_MOVEMENT
//! - MOV_CALL_RETURNS_NOTHING
//! - MOV_EXPR_CLOSURE_POSITION
//! - MOV_EXPR_PARSE
//! - MOV_FUNCTION_UNKNOWN
//! - MOV_NESTED_CALL_SUSPENDS
//! - MOV_PARAM_NEEDS_TYPE
//! - MOV_PLUGIN_ARGS_NAMED
//! - MOV_PLUGIN_OUTPUT_UNDECLARED
//! - MOV_PLUGIN_ROW_UNDECLARED
//! - MOV_RECURSIVE_RETURN_TYPE
//! - MOV_RETURN_NOT_A_VALUE
//! - MOV_RETURN_OUTSIDE_BODY
//! - MOV_STDLIB_ARG_INVALID
//! - MOV_STDLIB_ARG_NOT_LITERAL

use movement_parser::ast::{RValue, MovementDeclaration, ArmExpression, CallArg, CallStatement, CollectionOp, CollectionOpExpression, ExprSlot, Loc, MembersExpression, Span};
use movement_parser::lowering::HeldAsData;
use movement_parser::lowering::expression::{Expression, StaticValue};
use movement_parser::version::{before, since};

use movement_parser::tree::{At, MExpr, MapMember, StringPart};

use std::collections::HashMap;
use std::rc::Rc;

use crate::checker::Checker;
use crate::codes;
use crate::scope::{Resolution, ScopeId, Symbol, SymbolId, SymbolKind};
use crate::slots::SlotError;
use crate::types::field::{describe_field_type, strip_absent};
use crate::types::stdlib::{Builtin, ParamType, STANDARD_LIBRARY, describe_param_type, lookup_builtin, param_accepts, reads_as_value, stdlib_function_by_id};

/// `describeBuiltin`: the built-in's signature as the author reads it.
pub fn describe_builtin(builtin: &Builtin) -> String {
    builtin.describe()
}

/// A built-in's `form`: how a call of it is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuiltinForm {
    Value,
    Collection,
    Members,
    Extract,
}

pub fn builtin_form(builtin: &Builtin) -> BuiltinForm {
    match builtin.name {
        "MEMBERS" => BuiltinForm::Members,
        "EXTRACT" | "EXTRACTONE" => BuiltinForm::Extract,
        "MAP" | "FILTER" | "REDUCE" | "GROUPBY" | "KEYBY" => BuiltinForm::Collection,
        _ => BuiltinForm::Value,
    }
}

/// `CalleeResolution`.
pub enum Callee {
    /// The program declares it, under this name.
    Declared(String),
    Builtin(&'static Builtin),
    Unknown,
}

use crate::types::field::Ty;
use crate::types::infer::Typing;
use crate::types::position::{ClosureParam, ClosureType, PlaneType, Position, ReturnShape, describe_position};

/// Called by the type core after the values family's `observe`, for every
/// node: a built-in call's argument rules (`checkBuiltinArgs`,
/// `checkStdlibLiteralArgs`) live here. `crate::types::stdlib` has the signatures.
pub fn observe(typing: &mut Typing, expr: &Expression, _position: Option<&Position>, operands: &[Option<Ty>], _ty: Option<&Ty>) {
    match expr {
        Expression::Function { fn_, args } => {
            // `extractOne` was a name like any other before version 3.
            let builtin = if fn_ == "extractone" && typing.version < 3 { None } else { lookup_builtin(fn_) };
            if let Some(builtin) = builtin {
                if refuse_closure_operands(typing, builtin, expr, args, operands) {
                    return;
                }
                check_builtin_args(typing, builtin, operands, args);
            }
            check_stdlib_literal_args(typing, fn_, args);
            if let Some(function) = stdlib_function_by_id(fn_) {
                crate::families::records::check_stdlib_record_arg(typing, function, args, operands);
                crate::families::records::check_stdlib_whole_value_arg(typing, function, operands);
            }
        }
        Expression::Llm { prompt_expression, .. } => {
            if let Some(ai) = lookup_builtin("AI") {
                check_builtin_args(typing, ai, operands, prompt_expression.as_deref().map_or(&[], std::slice::from_ref));
            }
        }
        _ => {}
    }
}

/// `refuseClosureOperands` for a built-in's arguments (language version 5):
/// a closure handed where a value is read. A `function` parameter takes one.
fn refuse_closure_operands(typing: &mut Typing, builtin: &Builtin, whole: &Expression, args: &[Expression], operands: &[Option<Ty>]) -> bool {
    let read: Vec<(&Expression, Option<&Ty>)> = args
        .iter()
        .zip(operands)
        .enumerate()
        .filter(|(index, _)| builtin.param_at(*index).is_none_or(|param| param.ty != ParamType::Function))
        .map(|(_, (arg, ty))| (arg, ty.as_ref()))
        .collect();
    typing.refuse_closure_operands(&read, whole, &format!("handed to {}", builtin.name))
}

/// `checkBuiltinArgs` (language version 3): each argument a value of the
/// kind its parameter takes. A record or a json value is the rule every
/// value-reading site shares; an argument nobody can type stays silent.
fn check_builtin_args(typing: &mut Typing, builtin: &Builtin, args: &[Option<Ty>], exprs: &[Expression]) {
    if typing.version < 3 {
        return;
    }
    for (index, ty) in args.iter().enumerate() {
        let Some(param) = builtin.param_at(index) else { continue };
        if !reads_as_value(param.ty) {
            continue;
        }
        if ty.as_ref().is_some_and(|ty| crate::families::values::require_transparent(typing, Some(ty), &format!("handed to {}", builtin.name))) {
            continue;
        }
        if let Some(expr) = exprs.get(index)
            && refuse_maybe_record_for_builtin(typing, builtin, param, ty.as_ref(), expr)
        {
            continue;
        }
        let Some(ty) = ty else { continue };
        if param_accepts(param.ty, ty) {
            continue;
        }
        typing.report(
            codes::BUILTIN_ARG_TYPE,
            format!(
                "{}'s '{}' takes {}, and this is {} — {}",
                builtin.name,
                param.name,
                describe_param_type(param.ty),
                describe_field_type(strip_absent(ty)),
                builtin.describe()
            ),
        );
    }
}

/// `refuseMaybeRecordForBuiltin`: a value that MAY be a record (or a file)
/// and may be something else — `ROUND(COALESCE(org, 1))` — handed to a
/// built-in's argument that does not take one. Its type cannot say it; what
/// it may hold does. Refused from version 5; an older pin is warned, and the
/// warning blocks the move up. True when it fired.
fn refuse_maybe_record_for_builtin(typing: &mut Typing, builtin: &Builtin, param: &crate::types::stdlib::Param, ty: Option<&Ty>, expr: &Expression) -> bool {
    use crate::types::field::BaseKind;
    let takes_file = param.ty == ParamType::File;
    let shown = ty.map(crate::types::field::base_kinds).unwrap_or_default();
    let hidden = top_level_handles(typing.may_hold_type(expr).as_ref()).into_iter().find(|handle| {
        let kind = if matches!(handle, Ty::File) { BaseKind::File } else { BaseKind::Record };
        !(kind == BaseKind::File && takes_file) && !shown.contains(&kind)
    });
    let Some(hidden) = hidden else { return false };
    let file = matches!(hidden, Ty::File);
    let message = format!(
        "{}'s '{}' takes {}, but this may be {} — {}, not a value, and such a union is not {}, as in TypeScript. {}, or fill every arm with a value",
        builtin.name,
        param.name,
        describe_param_type(param.ty),
        describe_field_type(&hidden),
        if file { "a file" } else { "a record" },
        describe_param_type(param.ty),
        if file { "Pass its text ('READ(f)')" } else { "Narrow it to the record with IS and pass a field off it ('r.`Name`')" }
    );
    if typing.version >= 5 {
        typing.report(codes::CALL_ARG_MAYBE_RECORD, message);
    } else {
        typing.report_upgrade(
            codes::CALL_ARG_MAYBE_RECORD,
            format!(
                "{message}. Before {} {} runs on the {} as it is; from it, this is refused",
                crate::version::describe(5),
                builtin.name,
                if file { "file" } else { "record" }
            ),
        );
    }
    true
}

/// `topLevelHandles`: the records and files a value is, through a union's arms.
fn top_level_handles(ty: Option<&Ty>) -> Vec<Ty> {
    let Some(ty) = ty else { return Vec::new() };
    match strip_absent(ty) {
        record @ Ty::Record(_) => vec![record.clone()],
        Ty::File => vec![Ty::File],
        Ty::Union(members) => members.iter().flat_map(|m| top_level_handles(Some(m))).collect(),
        _ => Vec::new(),
    }
}

/// A literal argument a standard-library function parses: what it is, and
/// what is wrong with a written one (`None` when nothing is, or when this
/// checker cannot tell).
struct LiteralArg {
    index: usize,
    what: &'static str,
    check: fn(&str, &dyn crate::types::infer::TypeEnv) -> Option<String>,
}

/// `literalArgs` of each standard-library function that has them, with its
/// signature.
fn literal_args_of(id: &str) -> Option<(&'static str, &'static [LiteralArg])> {
    const FORMAT: &[LiteralArg] = &[LiteralArg { index: 1, what: "the format pattern", check: check_date_format_pattern }];
    const TODAY: &[LiteralArg] = &[LiteralArg { index: 0, what: "the time zone", check: check_time_zone }];
    const AT: &[LiteralArg] = &[
        LiteralArg { index: 1, what: "the time of day", check: check_wall_clock_time },
        LiteralArg { index: 2, what: "the time zone", check: check_time_zone },
    ];
    const SERIALISE: &[LiteralArg] = &[LiteralArg { index: 1, what: "the format", check: check_serialise_format }];
    const NUMBER_FORMAT: &[LiteralArg] = &[LiteralArg { index: 1, what: "the format style", check: check_number_format_style }];
    Some(match id.to_ascii_lowercase().as_str() {
        "date.format" => ("DATE.FORMAT(value, pattern)", FORMAT),
        "date.today" => ("DATE.TODAY(zone)", TODAY),
        "datetime.at" => ("DATETIME.AT(date, time, zone)", AT),
        "text.serialise" => ("TEXT.SERIALISE(value, format)", SERIALISE),
        "number.format" => ("NUMBER.FORMAT(number, style)", NUMBER_FORMAT),
        _ => return None,
    })
}

/// `checkStdlibLiteralArgs`: a parsed argument is written down, and parses.
fn check_stdlib_literal_args(typing: &mut Typing, id: &str, args: &[Expression]) {
    let Some((signature, declared)) = literal_args_of(id) else { return };
    for literal in declared {
        let Some(arg) = args.get(literal.index) else { continue };
        let Expression::Static { value: StaticValue::String(written) } = arg else {
            typing.report(
                codes::STDLIB_ARG_NOT_LITERAL,
                format!("{signature} reads {}, so it has to be written down — a computed one can't be checked here, and a mistake in it would show up in the output instead. Write the text in place.", literal.what),
            );
            continue;
        };
        if let Some(problem) = (literal.check)(written, typing.env) {
            typing.report(codes::STDLIB_ARG_INVALID, problem);
        }
    }
}

const DATE_FORMAT_TOKENS: &[&str] = &["YYYY", "YY", "MMMM", "MMM", "MM", "M", "DD", "D", "dddd", "ddd", "HH", "H", "mm", "m", "ss", "s"];

/// `checkDateFormatPattern`: every run of letters splits, where the letter
/// changes, into tokens.
fn check_date_format_pattern(pattern: &str, _env: &dyn crate::types::infer::TypeEnv) -> Option<String> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_alphabetic() {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && chars[i].is_ascii_alphabetic() {
            i += 1;
        }
        let part: String = chars[start..i].iter().collect();
        let mut runs = Vec::new();
        let mut j = start;
        while j < i {
            let k = (j..i).find(|&k| chars[k] != chars[j]).unwrap_or(i);
            runs.push(chars[j..k].iter().collect::<String>());
            j = k;
        }
        if runs.iter().all(|run| DATE_FORMAT_TOKENS.contains(&run.as_str())) {
            continue;
        }
        let closest = closest_date_format_token(&part).map(|t| format!(" Did you mean '{t}'?")).unwrap_or_default();
        return Some(format!(
            "'{part}' isn't a date format token.{closest} The tokens are {} (year, month, day, weekday, hour, minute, second); anything that is not a letter is printed as written.",
            DATE_FORMAT_TOKENS.join(", ")
        ));
    }
    None
}

/// `closestDateFormatToken`: same case first, then the same letter; the one
/// closest in length, the earliest on a tie.
fn closest_date_format_token(run: &str) -> Option<&'static str> {
    let head = run.chars().next()?;
    let same_case: Vec<&str> = DATE_FORMAT_TOKENS.iter().copied().filter(|t| t.starts_with(head)).collect();
    let same_letter = if same_case.is_empty() {
        DATE_FORMAT_TOKENS.iter().copied().filter(|t| t.chars().next().is_some_and(|c| c.eq_ignore_ascii_case(&head))).collect()
    } else {
        same_case
    };
    let length = run.chars().count();
    same_letter.into_iter().reduce(|best, t| if t.len().abs_diff(length) < best.len().abs_diff(length) { t } else { best })
}

/// `checkTimeZone`: a zone the host's zone database knows.
fn check_time_zone(zone: &str, env: &dyn crate::types::infer::TypeEnv) -> Option<String> {
    match env.is_zone(zone) {
        Some(known) if zone.is_empty() || !known => {
            Some(format!("'{zone}' is not a recognised IANA time zone (e.g. \"Europe/London\", \"America/New_York\", \"UTC\")"))
        }
        _ => None,
    }
}

/// `wallClockTimeError`: a 24-hour `HH:mm` reading.
fn check_wall_clock_time(time: &str, _env: &dyn crate::types::infer::TypeEnv) -> Option<String> {
    let b = time.trim().as_bytes();
    let ok = b.len() == 5
        && b[2] == b':'
        && matches!((b[0], b[1]), (b'0' | b'1', b'0'..=b'9') | (b'2', b'0'..=b'3'))
        && matches!((b[3], b[4]), (b'0'..=b'5', b'0'..=b'9'));
    (!ok).then(|| format!("'{time}' is not a time of day — write it as 24-hour HH:mm (e.g. \"07:00\", \"18:30\")"))
}

fn check_serialise_format(format: &str, _env: &dyn crate::types::infer::TypeEnv) -> Option<String> {
    if format == "JSON" {
        return None;
    }
    let near = if format.eq_ignore_ascii_case("JSON") { "did you mean \"JSON\"? " } else { "" };
    Some(format!("'{format}' isn't a format TEXT.SERIALISE writes — {near}the formats are \"JSON\"."))
}

fn check_number_format_style(style: &str, _env: &dyn crate::types::infer::TypeEnv) -> Option<String> {
    (!matches!(style, "compact" | "grouped")).then(|| format!("'{style}' isn't a number format style — write \"compact\" or \"grouped\"."))
}

/// `spanWithin`: the place `pos` (a UTF-16 offset into the slot's text)
/// stands in the file, through to the slot's end.
pub fn span_within(slot: &ExprSlot, pos: Option<usize>) -> Span {
    let units: Vec<u16> = slot.raw.encode_utf16().collect();
    let Some(pos) = pos.filter(|p| *p <= units.len()) else { return slot.span };
    let Loc { mut line, mut col } = slot.span.start;
    for unit in &units[..pos] {
        if *unit == u16::from(b'\n') {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    Span { start: Loc { line, col }, end: slot.span.end }
}

impl Checker<'_> {
    /// `reportSlotError`: a slot the expression grammar could not read or
    /// lower. From version 5 a closure held as a list's element or a map's
    /// value is refused as a closure kept as data.
    pub fn report_slot_error(&mut self, error: &SlotError, slot: &ExprSlot) {
        if since(self.version, 5)
            && let Some(held) = error.held_as_data
        {
            let place = match held {
                HeldAsData::List => "a list's element is",
                HeldAsData::Map => "a map's value is",
            };
            self.report(codes::CLOSURE_NOT_DATA, crate::types::field::closure_not_data_message(place), span_within(slot, error.pos));
            return;
        }
        self.report(error.code.as_deref().unwrap_or(codes::EXPR_PARSE), error.message.clone(), span_within(slot, error.pos));
    }

    /// `checkPathHead`'s refusal of the probe its hops are read through.
    pub fn report_head_parse_error(&mut self, error: &SlotError, span: Span) {
        match &error.code {
            Some(code) => self.report(code, error.message.clone(), span),
            None => self.report(codes::EXPR_PARSE, format!("Invalid traversal path: {}", error.message), span),
        }
    }
}

/// `sortKeyOf`: `SORT(xs, key)`'s key, read once per member.
pub fn sort_key_of(e: &MExpr) -> Option<&MExpr> {
    let MExpr::Call { callee, args, .. } = e else { return None };
    let MExpr::Name { name, .. } = callee.as_ref() else { return None };
    if !name.text.eq_ignore_ascii_case("SORT") {
        return None;
    }
    let key = &args.get(1)?.value;
    let direction = matches!(key, MExpr::Name { name, .. } if name.text.eq_ignore_ascii_case("ASC") || name.text.eq_ignore_ascii_case("DESC"));
    if direction && args.len() == 2 { None } else { Some(key) }
}

/// `valueChildren` (nested_calls.ts): the sub-expressions read once, as
/// values, where `e` is evaluated.
pub fn value_children(e: &MExpr) -> Vec<&MExpr> {
    use movement_parser::tree::ListElement;
    match e {
        MExpr::String { parts, .. } => parts
            .iter()
            .filter_map(|p| match p {
                StringPart::Expr(e) => Some(e),
                StringPart::Text(_) => None,
            })
            .collect(),
        MExpr::Paren { expr, .. } => vec![expr],
        MExpr::List { elements, .. } => elements
            .iter()
            .map(|x| match x {
                ListElement::Expr(e) => e,
                ListElement::Spread(spread) => &spread.expr,
            })
            .collect(),
        MExpr::Map { entries, .. } => entries
            .iter()
            .map(|x| match x {
                MapMember::Entry { value, .. } => value,
                MapMember::Spread(spread) => &spread.expr,
            })
            .collect(),
        MExpr::Member { object, .. } => vec![object],
        MExpr::Index { object, index, .. } => vec![object, index],
        MExpr::Call { args, .. } => {
            let key = sort_key_of(e);
            args.iter().map(|a| &a.value).filter(|v| key.is_none_or(|k| !std::ptr::eq(*v, k))).collect()
        }
        MExpr::Path { root, .. } => root.iter().map(|r| r.as_ref()).collect(),
        MExpr::Unary { operand, .. } | MExpr::Exists { operand, .. } | MExpr::Within { operand, .. } => vec![operand],
        MExpr::Binary { left, right, .. } => vec![left, right],
        MExpr::Where { source, .. } => vec![source],
        MExpr::Is { subject, .. } => vec![subject],
        MExpr::If { condition, then, else_, .. } => {
            let mut children: Vec<&MExpr> = vec![condition, then];
            children.extend(else_.as_deref());
            children
        }
        _ => Vec::new(),
    }
}

/// `nestedCalls`: the outermost calls `runs` picks, left to right.
fn nested_calls<'t>(tree: &'t MExpr, runs: &dyn Fn(&MExpr) -> bool, into: &mut Vec<&'t MExpr>) {
    if matches!(tree, MExpr::Call { .. }) && runs(tree) {
        into.push(tree);
        return;
    }
    for child in value_children(tree) {
        nested_calls(child, runs, into);
    }
}

/// `hoistingMemberReads`' widening: the calls whose value a member access reads.
fn member_read_calls(tree: &MExpr, into: &mut Vec<At>) {
    if let MExpr::Member { object, .. } = tree
        && let MExpr::Call { callee, .. } = object.as_ref()
        && matches!(callee.as_ref(), MExpr::Name { .. })
    {
        into.push(object.at());
    }
    for child in value_children(tree) {
        member_read_calls(child, into);
    }
}

/// `headHopsExtent`: an extent of a head's probe, placed in the file when it
/// lies within the hops, which the probe carries verbatim and which end where
/// the head does. A chain over several lines has no exact place.
fn head_hops_extent(head: &movement_parser::ast::PathHead, probe_len: usize, at: At) -> Option<Span> {
    if head.hops_raw.contains('\n') {
        return None;
    }
    let hops_len = head.hops_raw.encode_utf16().count();
    // The probe is the root, the hops, then the probe's own field read.
    let offset = probe_len - ".`__movement_head_probe__`".len() - hops_len;
    if at.start < offset || at.end > offset + hops_len {
        return None;
    }
    let end = head.span.end;
    let hops = ExprSlot::plain(head.hops_raw.clone(), Span { start: Loc { line: end.line, col: end.col.saturating_sub(hops_len) }, end });
    Some(span_of_extent(&hops, At { start: at.start - offset, end: at.end - offset }))
}

/// `spanOfExtent`.
pub fn span_of_extent(slot: &ExprSlot, at: At) -> Span {
    Span { start: span_within(slot, Some(at.start)).start, end: span_within(slot, Some(at.end)).start }
}

/// `nestedCallName`.
pub fn nested_call_name(span: Span) -> String {
    format!("#call@{}:{}", span.start.line, span.start.col)
}

impl Checker<'_> {
    /// `resolveCallee`: the program's own scopes first, exactly as written,
    /// then (from version 3) a function in any letter case, then the
    /// standard library.
    pub fn resolve_callee(&self, written: &str, scope: ScopeId) -> Callee {
        if !matches!(self.scopes.resolve(scope, written), Resolution::Unknown) {
            return Callee::Declared(written.to_string());
        }
        if !since(self.version, 3) {
            return Callee::Unknown;
        }
        if let Some(id) = self.scopes.resolve_function(scope, written) {
            return Callee::Declared(self.scopes.symbol(id).name.clone());
        }
        match lookup_builtin(written) {
            Some(builtin) if !builtin.name.contains('.') => Callee::Builtin(builtin),
            _ => Callee::Unknown,
        }
    }

    /// `calledClosure`, as a yes or no: the name holds a closure a call runs.
    pub fn calls_closure(&self, symbol: &Symbol) -> bool {
        if !since(self.version, 3) {
            return false;
        }
        if symbol.is_closure || symbol.types.pos.as_ref().is_some_and(|p| p.is_closure()) {
            return true;
        }
        if !since(self.version, 5) || symbol.kind == SymbolKind::Movement || symbol.types.pos.is_some() {
            return false;
        }
        symbol.types.field.as_ref().is_some_and(closure_of_value)
    }

    /// `runsAsCall`: a function the program declares, or a built-in that is
    /// not a value.
    pub fn runs_as_call(&self, call: &MExpr, scope: ScopeId) -> bool {
        let MExpr::Call { callee, .. } = call else { return false };
        let MExpr::Name { name, .. } = callee.as_ref() else { return false };
        match self.resolve_callee(&name.text, scope) {
            Callee::Declared(declared) => match self.scopes.resolve(scope, &declared) {
                Resolution::Found(id) => {
                    let symbol = self.scopes.symbol(id);
                    symbol.is_function() || self.calls_closure(symbol)
                }
                _ => false,
            },
            Callee::Builtin(builtin) => builtin_form(builtin) != BuiltinForm::Value,
            Callee::Unknown => false,
        }
    }

    /// `hoistNestedCalls`: each call the engine runs inside the slot is
    /// checked as the right-hand side of a binding to a name only the engine
    /// spells, and the slot comes back reading those names in the calls'
    /// places. None when the slot holds no such call.
    pub fn hoist_nested_calls(&mut self, slot: &ExprSlot, scope: ScopeId) -> Option<ExprSlot> {
        let (calls, rewritten) = self.nested_call_rewrite(slot, scope)?;
        let units: Vec<u16> = slot.raw.encode_utf16().collect();
        for HoistedCall { at, span, name } in calls {
            let head = String::from_utf16_lossy(&units[..at.end]);
            let mut bound = crate::checker::Bound::default();
            let parsed = movement_parser::stmt::Parser::new(&head, self.version, slot.span.start, true).parse_nested_call_value(at.start);
            match &parsed {
                Ok(value) => {
                    self.open_effect_frame();
                    self.enter_nested_call(slot.span, at);
                    bound = self.check_rvalue(value, scope, None, span);
                    self.leave_nested_call();
                    let row = self.close_effect_frame();
                    let callee = match value {
                        RValue::Call { call } => Some(&call.callee),
                        RValue::Construct { construct } => Some(&construct.callee),
                        _ => None,
                    };
                    if row && let Some(callee) = callee {
                        self.report(
                            codes::NESTED_CALL_SUSPENDS,
                            format!("'{callee}' may wait ('await'), and a wait parks the run where it is written — inside an expression there is no place to come back to. Call it on its own line and use the name: `answer = {callee}(…)`"),
                            span,
                        );
                    }
                    self.absorb_suspend(row);
                }
                Err(e) => self.report(codes::EXPR_PARSE, format!("{} (line {}, col {})", e.message, e.loc.line, e.loc.col), span),
            }
            let symbol = self.scopes.add_symbol(Symbol::new(&name, SymbolKind::Binding, span));
            self.scopes.declare(scope, symbol);
            // The name holds what the call hands back, as a binding of it
            // would (`boundCallShape`), typed in the order a binding is.
            if let Ok(value) = &parsed
                && let Some(types) = self.bound_types(Some(&name), value, &bound, scope)
            {
                self.set_types(scope, &name, types);
            }
        }
        Some(rewritten)
    }

    /// `hoistNestedCalls`, the rewrite: each call an expression runs (in
    /// source order), where it is and the name it is hoisted to, and the slot
    /// with each call replaced by its name — padded to the call's length so
    /// every later offset into the text is the original's.
    pub fn nested_call_rewrite(&self, slot: &ExprSlot, scope: ScopeId) -> Option<(Vec<HoistedCall>, ExprSlot)> {
        if !since(self.version, 3) {
            return None;
        }
        let tree = movement_parser::expr::parse_expression(&slot.raw).ok()?;
        let mut read = Vec::new();
        member_read_calls(&tree, &mut read);
        let mut calls = Vec::new();
        nested_calls(&tree, &|call| read.contains(&call.at()) || self.runs_as_call(call, scope), &mut calls);
        if calls.is_empty() {
            return None;
        }
        let units: Vec<u16> = slot.raw.encode_utf16().collect();
        let mut rewritten: Vec<u16> = Vec::with_capacity(units.len());
        let mut from = 0;
        let mut hoisted = Vec::new();
        for call in calls {
            let at = call.at();
            let span = span_of_extent(slot, at);
            let name = nested_call_name(span);
            rewritten.extend_from_slice(&units[from..at.start]);
            let spelled: Vec<u16> = format!("`{name}`").encode_utf16().collect();
            let extent = &units[at.start..at.end];
            rewritten.extend_from_slice(&spelled);
            for unit in extent.iter().skip(spelled.len()) {
                rewritten.push(if *unit == u16::from(b'\n') { *unit } else { u16::from(b' ') });
            }
            from = at.end;
            hoisted.push(HoistedCall { at, span, name });
        }
        rewritten.extend_from_slice(&units[from..]);
        Some((hoisted, ExprSlot::plain(String::from_utf16_lossy(&rewritten), slot.span)))
    }
}

/// A call hoisted out of an expression: where it is, and the name it gets.
pub struct HoistedCall {
    pub at: At,
    pub span: Span,
    pub name: String,
}

/// `closureOfValue`: a value that is a closure (every member of a union one).
pub fn closure_of_value(ty: &Ty) -> bool {
    match ty {
        Ty::Record(Some(position)) => position.is_closure(),
        Ty::Union(members) => !members.is_empty() && members.iter().all(closure_of_value),
        _ => false,
    }
}

/// `closuresOfValue`: the closures a value is — a record of closure type, or
/// a union of them; `None` when it may be something else.
pub fn closures_of_value(ty: &Ty) -> Option<Vec<ClosureType>> {
    match ty {
        Ty::Record(Some(position)) => match position.as_ref() {
            Position::Closure(closure) => Some(vec![closure.clone()]),
            _ => None,
        },
        Ty::Union(members) => {
            let mut found: Vec<ClosureType> = Vec::new();
            for member in members {
                found.extend(closures_of_value(member)?);
            }
            (!found.is_empty()).then_some(found)
        }
        _ => None,
    }
}

/// `CallReading`: how a call reads where it is written.
pub enum CallReading {
    Function,
    Value(ExprSlot),
    Collection(CollectionOpExpression),
    Members(MembersExpression),
    Refused { code: &'static str, message: String, span: Span },
}

/// `CallPosition`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CallPosition {
    Statement,
    Value,
    Argument,
}

/// `describeArgForm`.
fn describe_arg_form(arg: &CallArg) -> &'static str {
    match arg {
        CallArg::Expr { .. } | CallArg::Call { .. } => "a value",
        CallArg::Closure { .. } => "a function",
        CallArg::Type { .. } => "a type",
        CallArg::Node { .. } => "a node literal",
        CallArg::Write { .. } => "a write",
    }
}

fn args_refusal(message: String, span: Span) -> CallReading {
    CallReading::Refused { code: codes::BUILTIN_ARGS, message, span }
}

/// `readOneCall`.
fn read_one_call(call: &CallStatement, resolution: &Callee, position: CallPosition) -> CallReading {
    let Callee::Builtin(builtin) = resolution else { return CallReading::Function };
    let callee = &call.callee;
    if call.args.iter().any(|arg| arg.name().is_some()) {
        return args_refusal(format!("'{callee}' is a built-in, and a built-in takes its arguments in order — {}", describe_builtin(builtin)), call.span);
    }
    let form = builtin_form(builtin);
    if position == CallPosition::Argument && form != BuiltinForm::Value
        && let Some(expression) = &call.expression
    {
        return CallReading::Value(expression.clone());
    }
    match form {
        BuiltinForm::Value => {
            if position == CallPosition::Statement {
                return CallReading::Refused {
                    code: codes::BUILTIN_UNUSED,
                    message: format!("'{callee}(…)' computes a value and does nothing else, so as a statement it is lost — bind it (`x = {callee}(…)`) or pass it on"),
                    span: call.span,
                };
            }
            if let Some(misfit) = call.args.iter().find(|arg| !matches!(arg, CallArg::Expr { .. } | CallArg::Call { .. })) {
                return args_refusal(format!("'{callee}' takes values, not {} — {}", describe_arg_form(misfit), describe_builtin(builtin)), call.span);
            }
            match &call.expression {
                Some(expression) => CallReading::Value(expression.clone()),
                None => args_refusal(format!("'{callee}' takes {}", describe_builtin(builtin)), call.span),
            }
        }
        BuiltinForm::Collection => collection_reading(call, builtin),
        BuiltinForm::Members => {
            if position == CallPosition::Statement {
                return CallReading::Refused {
                    code: codes::BUILTIN_UNUSED,
                    message: format!("'{callee}(…)' reads a type's values and does nothing else — bind it: `values = {callee}(<…>)`"),
                    span: call.span,
                };
            }
            match call.args.as_slice() {
                [CallArg::Type { type_, span, .. }] => {
                    CallReading::Members(MembersExpression { type_: type_.clone(), span: call.span, type_span: *span })
                }
                _ => args_refusal(
                    format!("'{callee}' takes one type — a type you declare ({callee}(<Thesis>)) or another field's option set ({callee}(<crm-[:companies]->.`funding_stage`>))"),
                    call.span,
                ),
            }
        }
        BuiltinForm::Extract => {
            args_refusal(format!("'{callee}(…)' is the extraction call — bind what it finds: `found = {callee}(content, Shape)`"), call.span)
        }
    }
}

/// `valueSlot`: a value argument's expression, or why it is not one.
fn value_slot(arg: &CallArg) -> Result<&ExprSlot, String> {
    match arg {
        CallArg::Expr { expr, .. } => Ok(expr),
        CallArg::Call { call, .. } => call.expression.as_ref().ok_or_else(|| format!("a named call is not a value — bind '{}(…)' first", call.callee)),
        other => Err(format!("{} is not a value", describe_arg_form(other))),
    }
}

/// `armOf`: the function argument — a closure written in place, or a function's name.
fn arm_of(arg: &CallArg, spelling: &str) -> Result<ArmExpression, String> {
    match arg {
        CallArg::Closure { closure, span, .. } => Ok(ArmExpression::Closure { closure: closure.clone(), span: *span }),
        CallArg::Expr { expr, .. } => {
            let raw = expr.raw.trim();
            let units: Vec<u16> = raw.encode_utf16().collect();
            match movement_parser::scan::scan_name(&units, 0) {
                Some((name, end)) if end == units.len() => Ok(ArmExpression::Ref { name, span: expr.span }),
                _ => Err(format!("The function for '{spelling}' is a function's name, or a closure (`(x) => {{ … }}`) — not the expression '{raw}'")),
            }
        }
        CallArg::Call { call, .. } => Err(format!(
            "'{0}(…)' CALLS the function here; '{spelling}' is given the function itself, so it can call it. Write '{0}', or wrap the call: `() => {{ {0}(…) }}`",
            call.callee
        )),
        other => Err(format!("The function for '{spelling}' is a function's name, or a closure (`(x) => {{ … }}`) — not {}", describe_arg_form(other))),
    }
}

/// `collectionReading`: `MAP(xs, f)` and its kin, the arguments in the
/// places the op reads them.
fn collection_reading(call: &CallStatement, builtin: &Builtin) -> CallReading {
    let spelling = &call.callee;
    let op = match builtin.name {
        "MAP" => CollectionOp::Map,
        "FILTER" => CollectionOp::Filter,
        "REDUCE" => CollectionOp::Reduce,
        "GROUPBY" => CollectionOp::Groupby,
        _ => CollectionOp::Keyby,
    };
    let configurable = matches!(op, CollectionOp::Map | CollectionOp::Filter);
    let shape = if op == CollectionOp::Reduce {
        format!("{spelling}(<collection>, <starting value>, <function>)")
    } else if configurable {
        format!("{spelling}(<collection>, <function>) or {spelling}(<collection>, {{ <settings> }}, <function>)")
    } else {
        format!("{spelling}(<collection>, <function>)")
    };
    let refused = |message: String| args_refusal(message, call.span);
    let args = &call.args;
    let counts: &[usize] = if op == CollectionOp::Reduce { &[3] } else if configurable { &[2, 3] } else { &[2] };
    if !counts.contains(&args.len()) {
        return refused(if args.len() < 2 { format!("'{spelling}' takes {shape} — the function is missing") } else { format!("'{spelling}' takes {shape}") });
    }
    let source = match value_slot(&args[0]) {
        Ok(slot) => slot.clone(),
        Err(why) => return refused(format!("{why} for the collection '{spelling}' reads")),
    };
    let (mut init, mut config) = (None, None);
    if op == CollectionOp::Reduce {
        match value_slot(&args[1]) {
            Ok(slot) => init = Some(slot.clone()),
            Err(why) => return refused(format!("{why} for the value '{spelling}' starts from")),
        }
    } else if args.len() == 3 {
        match value_slot(&args[1]) {
            Ok(slot) if slot.raw.trim_start().starts_with('{') => config = Some(slot.clone()),
            _ => {
                return refused(format!(
                    "'{spelling}' takes its settings as a record written in place, between the collection and the function — `{spelling}(xs, {{ onError: \"warn\", concurrency: 4 }}, f)`"
                ));
            }
        }
    }
    match arm_of(&args[args.len() - 1], spelling) {
        Ok(r#fn) => CallReading::Collection(CollectionOpExpression { op, source, init, config, r#fn, span: call.span }),
        Err(why) => refused(why),
    }
}

impl Checker<'_> {
    /// `readCallAt`: how the call reads where it is written. A built-in's
    /// reading also reads every call among its arguments, as an argument.
    pub fn read_call(&self, call: &CallStatement, scope: ScopeId, position: CallPosition) -> CallReading {
        let reading = read_one_call(call, &self.resolve_callee(&call.callee, scope), position);
        if matches!(reading, CallReading::Function | CallReading::Refused { .. }) {
            return reading;
        }
        for arg in &call.args {
            let CallArg::Call { call: nested, .. } = arg else { continue };
            let inner = self.read_call(nested, scope, CallPosition::Argument);
            if matches!(inner, CallReading::Refused { .. }) {
                return inner;
            }
        }
        reading
    }

    /// The call statement (`checkStatement`'s call case).
    pub fn check_call_statement(&mut self, call: &CallStatement, scope: ScopeId) {
        match self.read_call(call, scope, CallPosition::Statement) {
            CallReading::Function => {
                self.check_call(call, scope);
            }
            CallReading::Collection(collection) => {
                self.check_collection_op(&collection, scope);
            }
            CallReading::Refused { code, message, span } => self.report(code, message, span),
            CallReading::Value(expr) => self.check_expr_slot(&expr, scope),
            CallReading::Members(members) => {
                self.check_members(&members, scope);
            }
        }
    }

    /// `checkRValue`'s call case: what a function's call hands back where it
    /// binds (`boundCallShape`'s value), or the collection op it computes;
    /// nothing for a built-in read as a value.
    pub fn check_call_rvalue(&mut self, call: &CallStatement, scope: ScopeId, span: Span) -> crate::checker::Bound {
        match self.read_call(call, scope, CallPosition::Value) {
            CallReading::Function => {
                let returned = self.check_call(call, scope);
                self.note_bound_self_call(&call.callee, span, scope);
                if self.callee_returns(&call.callee, scope) == Some(false) {
                    self.report_call_returns_nothing(&call.callee, span);
                }
                return crate::checker::Bound { returned: Some(returned), ..Default::default() };
            }
            CallReading::Value(expr) => self.check_expr_slot(&expr, scope),
            CallReading::Collection(collection) => {
                let (returned, arms_each_return) = self.check_collection_op_arms(&collection, scope);
                return crate::checker::Bound { returned: Some(returned), arms_each_return, ..Default::default() };
            }
            CallReading::Members(members) => {
                self.check_members(&members, scope);
            }
            CallReading::Refused { code, message, span } => self.report(code, message, span),
        }
        crate::checker::Bound::default()
    }
}

/// Where a checked tree's places are in the file: within a slot, or all at
/// a block head's span.
#[derive(Clone, Copy)]
pub enum TreeAt<'s> {
    Slot(&'s ExprSlot),
    /// A block head, read through its probe (`probe_len` UTF-16 units).
    Head { head: &'s movement_parser::ast::PathHead, probe_len: usize },
}

impl TreeAt<'_> {
    fn span_of(&self, at: At) -> Span {
        match self {
            TreeAt::Slot(slot) => span_within(slot, Some(at.start)),
            TreeAt::Head { head, .. } => head.span,
        }
    }

    /// `extentOf`: where an extent of the tree is exactly, when it has one
    /// place in the file — what an exact rewrite needs.
    pub fn extent_of(&self, at: At) -> Option<Span> {
        match self {
            TreeAt::Slot(slot) => Some(span_of_extent(slot, at)),
            TreeAt::Head { head, probe_len } => head_hops_extent(head, *probe_len, at),
        }
    }
}

/// `children` (expression/lower.ts): every sub-expression of a node.
pub fn expression_children(e: &MExpr) -> Vec<&MExpr> {
    use movement_parser::tree::{ClosureBody, EntryValue, LiteralEntry};
    fn entry_values(entries: &[LiteralEntry]) -> impl Iterator<Item = &MExpr> {
        entries.iter().filter_map(|x| match &x.value {
            EntryValue::Expr(v) => Some(v),
            EntryValue::DeclaredEdge(_) => None,
        })
    }
    match e {
        MExpr::Call { callee, args, .. } => std::iter::once(callee.as_ref()).chain(args.iter().map(|a| &a.value)).collect(),
        MExpr::Path { root, hops, .. } => {
            let mut out: Vec<&MExpr> = root.as_deref().into_iter().collect();
            for hop in hops {
                out.extend(hop.where_.as_ref());
                if let Some(config) = &hop.config {
                    out.extend(config.entries.iter().map(|x| match x {
                        MapMember::Spread(s) => &s.expr,
                        MapMember::Entry { value, .. } => value,
                    }));
                }
                out.extend(hop.order_by.as_ref().map(|o| &o.key));
            }
            out
        }
        MExpr::Where { source, predicate, .. } => vec![source, predicate],
        MExpr::Closure { body, .. } => match body.as_ref() {
            ClosureBody::Expr { expr } => vec![expr],
            ClosureBody::Block { .. } => Vec::new(),
        },
        MExpr::Node { entries, .. } => entry_values(entries).collect(),
        MExpr::Graph { entries, spreads, .. } => entry_values(entries).chain(spreads.iter()).collect(),
        MExpr::Mapped { source, body, .. } => vec![source, body],
        MExpr::Lazy { walk, .. } => vec![walk],
        _ => value_children(e),
    }
}

/// `builtinArity`.
fn builtin_arity(builtin: &Builtin) -> (usize, Option<usize>) {
    use crate::types::stdlib::Arity;
    let min = builtin.params.iter().filter(|p| p.arity == Arity::One).count();
    let max = if builtin.params.iter().any(|p| p.arity == Arity::Rest) { None } else { Some(builtin.params.len()) };
    (min, max)
}

/// `nestedMessage`.
pub fn nested_message(callee: &str) -> String {
    format!("'{callee}(…)' runs once where it is written, and a walk's WHERE, ORDER BY and settings are read once per landing — bind it first, then use the name: `answer = {callee}(…)`")
}

/// `sortKeyNestedMessage`.
fn sort_key_nested_message(callee: &str) -> String {
    format!("'{callee}(…)' runs once where it is written, and SORT reads its key once per member — every member would sort by that one answer. Work the key out per member first, then sort by it: `keyed = MAP(xs, (x) => {{ return {{ item: x, key: {callee}(…) }} }})`, then `SORT(keyed, key)`")
}

/// `builtinNotRun`.
fn builtin_not_run(builtin: &Builtin) -> Option<&'static str> {
    (builtin.name == "LLM_AGG").then_some(
        "is not run by the movement engine — the run would fail where it is reached, and its instruction never reaches a model. Join the members and ask the model directly: `notes = JOIN(xs, \"\\n\")`, then `AI(\"Summarise these: ${notes}\")`",
    )
}

/// `computedArgNotRead`: the argument a built-in would drop because it is
/// computed, not written in place.
fn computed_arg_not_read<'t>(builtin: &Builtin, args: &'t [movement_parser::tree::CallArg]) -> Option<(&'t MExpr, &'static str)> {
    const QUERY: &str = "reads its query only as text written in place (\"MATCH …\") — a computed query is not read. Write the query out, and pass the values it needs as its parameters ($0, $1, …)";
    let (index, message) = match builtin.name {
        "KG_EXISTS" | "KG_VALUE" => (0, QUERY),
        "JOIN" => (1, "reads its separator only as text written in place (`JOIN(xs, \", \")`) — a computed one is not read"),
        _ => return None,
    };
    let arg = &args.get(index)?.value;
    if is_text_written_in_place(arg) { None } else { Some((arg, message)) }
}

fn is_text_written_in_place(e: &MExpr) -> bool {
    match e {
        MExpr::Paren { expr, .. } => is_text_written_in_place(expr),
        MExpr::String { parts, .. } => parts.iter().all(|p| matches!(p, StringPart::Text(_))),
        _ => false,
    }
}

/// `editDistance`, over UTF-16 units as JavaScript strings index.
fn edit_distance(a: &[u16], b: &[u16]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr = vec![0; b.len() + 1];
    for i in 1..=a.len() {
        curr[0] = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        prev.clone_from(&curr);
    }
    prev[b.len()]
}

/// `closestByEditDistance` (meta.ts).
pub fn closest_by_edit_distance(value: &str, candidates: &[String]) -> Option<String> {
    let v: Vec<u16> = value.encode_utf16().collect();
    let mut best: Option<(&String, usize)> = None;
    for candidate in candidates {
        let distance = edit_distance(&v, &candidate.encode_utf16().collect::<Vec<_>>());
        if best.is_none_or(|(_, d)| distance < d) {
            best = Some((candidate, distance));
        }
    }
    let (best, distance) = best?;
    let threshold = 2.max(v.len().max(best.encode_utf16().count()) / 3);
    (distance <= threshold || value.contains(best.as_str()) || best.contains(value)).then(|| best.clone())
}

impl Checker<'_> {
    /// `Scope.functionNames`: every function in scope, innermost first.
    fn function_names(&self, scope: ScopeId) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        let mut at = Some(scope);
        while let Some(id) = at {
            let s = self.scopes.scope(id);
            for symbol in s.symbols.values().map(|id| self.scopes.symbol(*id)) {
                if (symbol.is_function() || symbol.types.pos.as_ref().is_some_and(|p| p.is_closure())) && !names.contains(&symbol.name) {
                    names.push(symbol.name.clone());
                }
            }
            at = s.parent;
        }
        names
    }

    /// `closestFunctionName`.
    pub fn closest_function_name(&self, name: &str, scope: ScopeId) -> Option<String> {
        let mut folded: Vec<(String, String)> = Vec::new();
        let flat = STANDARD_LIBRARY.iter().map(|b| b.name.to_string()).filter(|n| !n.contains('.'));
        for candidate in self.function_names(scope).into_iter().chain(flat) {
            let lower = candidate.to_lowercase();
            if !folded.iter().any(|(l, _)| *l == lower) {
                folded.push((lower, candidate));
            }
        }
        let keys: Vec<String> = folded.iter().map(|(l, _)| l.clone()).collect();
        let closest = closest_by_edit_distance(&name.to_lowercase(), &keys)?;
        folded.into_iter().find(|(l, _)| *l == closest).map(|(_, c)| c)
    }

    /// `unknownFunctionMessage`.
    pub fn unknown_function_message(&self, name: &str, scope: ScopeId, corrected: Option<&str>) -> String {
        let hint = match (self.closest_function_name(name, scope), corrected) {
            (None, _) => String::new(),
            (Some(closest), Some(corrected)) => format!(" — did you mean '{closest}'? Write '{corrected}'"),
            (Some(closest), None) => format!(" — did you mean '{closest}'?"),
        };
        format!("Unknown function '{name}'{hint} — a call names a movement or function declared or imported here, or a built-in")
    }

    /// `checkSlotExpression` / `checkExpressionTree` (version 3): what the
    /// lowering would otherwise decide silently about an expression's calls
    /// and `IF`s.
    pub fn check_slot_expression(&mut self, slot: &ExprSlot, scope: ScopeId, write_field: bool) {
        if !since(self.version, 3) {
            return;
        }
        let Ok(tree) = movement_parser::expr::parse_expression(&slot.raw) else { return };
        self.visit_expression_tree(&tree, false, false, (TreeAt::Slot(slot), None), scope, write_field);
    }

    /// The calls in a block head's hops (version 3), read through the probe
    /// the head is parsed as; every place is the head's.
    pub fn check_head_expression(&mut self, probe: &str, head: &movement_parser::ast::PathHead, scope: ScopeId) {
        if !since(self.version, 3) {
            return;
        }
        let Ok(tree) = movement_parser::expr::parse_expression(probe) else { return };
        // The probe reads a field off the head's walk; that walk is the head.
        let walk = match &tree {
            MExpr::Member { object, .. } => Some(object.as_ref() as *const MExpr),
            _ => None,
        };
        let at_ = TreeAt::Head { head, probe_len: probe.encode_utf16().count() };
        self.visit_expression_tree(&tree, false, false, (at_, walk), scope, false);
    }

    fn visit_expression_tree(&mut self, expr: &MExpr, per_member: bool, in_resource_where: bool, place: (TreeAt, Option<*const MExpr>), scope: ScopeId, write_field: bool) {
        let (at_, head) = place;
        if let MExpr::Path { root, hops, at } = expr {
            self.check_walk_keeps_what_is_written(hops, at_.span_of(*at));
            self.check_resource_walk(root.as_deref(), hops, at_.span_of(*at), head == Some(expr as *const MExpr));
        }
        if let MExpr::Special { text, at } = expr {
            self.check_special_record_read(text, at_.span_of(*at), at_.extent_of(*at), in_resource_where);
        }
        if let MExpr::If { else_: None, at, .. } = expr {
            self.report(
                codes::IF_WITHOUT_ELSE,
                "this IF has no ELSE, so where its condition fails it is \"\" (empty text), whatever THEN gives — say what it is there: 'IF … THEN … ELSE … END'",
                at_.span_of(*at),
            );
        }
        if let MExpr::Call { callee, args, at } = expr {
            match callee.as_ref() {
                MExpr::Name { name, .. } => {
                    let written = name.text.as_str();
                    if per_member && self.runs_as_call(expr, scope) && !self.is_extract_call(written, scope) {
                        self.report(codes::CALL_NESTED, sort_key_nested_message(written), at_.span_of(*at));
                        return;
                    }
                    self.check_call_in_expression(expr, written, args, at_, scope, write_field);
                }
                MExpr::Member { object, property, .. } => {
                    if let MExpr::Name { name, .. } = object.as_ref() {
                        self.check_dotted_call(&name.text, &property.text, at_.span_of(*at), scope, write_field);
                    }
                }
                _ => {}
            }
        }
        let key = sort_key_of(expr);
        // A resource hop's WHERE reads the resource's own fields by bare name.
        let resource_wheres: Vec<&MExpr> = match expr {
            MExpr::Path { hops, .. } => hops.iter().filter(|h| crate::families::extraction::is_resource_hop(h)).filter_map(|h| h.where_.as_ref()).collect(),
            _ => Vec::new(),
        };
        for child in expression_children(expr) {
            let keyed = key.is_some_and(|k| std::ptr::eq(k, child));
            let in_where = in_resource_where || resource_wheres.iter().any(|w| std::ptr::eq(*w, child));
            self.visit_expression_tree(child, per_member || keyed, in_where, place, scope, write_field);
        }
    }

    fn is_extract_call(&self, written: &str, scope: ScopeId) -> bool {
        matches!(self.resolve_callee(written, scope), Callee::Builtin(b) if builtin_form(b) == BuiltinForm::Extract)
    }

    /// `checkDottedCall`: `o.f(…)` where `f` is no built-in, outside a write
    /// field (version 5).
    fn check_dotted_call(&mut self, object: &str, key: &str, span: Span, scope: ScopeId, write_field: bool) {
        if !since(self.version, 5) || write_field {
            return;
        }
        if !matches!(self.scopes.resolve(scope, object), Resolution::Found(_)) || lookup_builtin(key).is_some() {
            return;
        }
        self.report(
            codes::FUNCTION_UNKNOWN,
            format!("'{object}.{key}(…)' runs '{key}' in '{object}', and '{key}' is no built-in — there is nothing to run there. There are no methods: a dot on a record or map reads a field, and a closure is never held under a key. Call a function by name ('{key}({object})'), or a closure kept in a variable ('g = …', then 'g()')"),
            span,
        );
    }

    /// `checkCallInExpression`.
    fn check_call_in_expression(
        &mut self,
        call: &MExpr,
        written: &str,
        args: &[movement_parser::tree::CallArg],
        at_: TreeAt,
        scope: ScopeId,
        write_field: bool,
    ) {
        let span = at_.span_of(call.at());
        match self.resolve_callee(written, scope) {
            Callee::Builtin(builtin) => {
                let form = builtin_form(builtin);
                if form == BuiltinForm::Extract {
                    return;
                }
                if form != BuiltinForm::Value {
                    self.report(codes::CALL_NESTED, nested_message(written), span);
                    return;
                }
                let (min, max) = builtin_arity(builtin);
                let count = args.len();
                if count < min || max.is_some_and(|max| count > max) {
                    let expected = match max {
                        Some(max) if max == min => format!("{min}"),
                        None => format!("at least {min}"),
                        Some(max) => format!("{min} to {max}"),
                    };
                    let plural = if max == Some(1) { "" } else { "s" };
                    self.report(codes::BUILTIN_ARGS, format!("'{written}' takes {expected} argument{plural}, got {count} — {}", describe_builtin(builtin)), span);
                    return;
                }
                if let Some(not_run) = builtin_not_run(builtin) {
                    self.report(codes::BUILTIN_NOT_RUN, format!("'{written}' {not_run}"), span);
                    return;
                }
                if let Some((arg, message)) = computed_arg_not_read(builtin, args) {
                    self.report(codes::BUILTIN_ARGS, format!("'{written}' {message}"), at_.span_of(arg.at()));
                }
            }
            Callee::Declared(declared) => {
                let Resolution::Found(id) = self.scopes.resolve(scope, &declared) else { return };
                let symbol = self.scopes.symbol(id).clone();
                if symbol.is_function() || self.calls_closure(&symbol) {
                    self.report(codes::CALL_NESTED, nested_message(written), span);
                    return;
                }
                if let Some(message) = self.not_a_closure_message(&symbol, written) {
                    self.report(codes::CALL_NOT_MOVEMENT, message, span);
                    return;
                }
                self.report(codes::CALL_NOT_MOVEMENT, format!("'{written}' is {}, not a function — only functions are called", symbol.kind.describe()), span);
            }
            Callee::Unknown => {
                if write_field {
                    return;
                }
                let MExpr::Call { callee, at, .. } = call else { return };
                let slot = match at_ {
                    TreeAt::Slot(slot) => Some(slot),
                    TreeAt::Head { .. } => None,
                };
                let fix = slot.and_then(|slot| self.closest_function_name(written, scope).map(|to| (slot, to))).map(|(slot, to)| {
                    let spelled = if to.chars().any(char::is_whitespace) { format!("`{to}`") } else { to };
                    let units: Vec<u16> = slot.raw.encode_utf16().collect();
                    let c = callee.at();
                    let corrected = format!(
                        "{}{spelled}{}",
                        String::from_utf16_lossy(&units[at.start..c.start]),
                        String::from_utf16_lossy(&units[c.end..at.end])
                    );
                    (corrected, serde_json::json!({ "edits": [{ "span": span_of_extent(slot, c), "text": spelled }] }))
                });
                let message = self.unknown_function_message(written, scope, fix.as_ref().map(|(c, _)| c.as_str()));
                let mut diagnostic = crate::diagnostic::Diagnostic::error(codes::FUNCTION_UNKNOWN, message, span);
                diagnostic.fix = fix.map(|(_, edit)| edit);
                self.push(diagnostic);
            }
        }
    }

    /// `notAClosureMessage`: why calling a name that is a value is refused
    /// under version 5.
    pub fn not_a_closure_message(&self, callee: &Symbol, written: &str) -> Option<String> {
        if !since(self.version, 5) || !matches!(callee.kind, SymbolKind::Binding | SymbolKind::Param) {
            return None;
        }
        if callee.types.pos.is_some() || self.calls_closure(callee) {
            return None;
        }
        Some(match &callee.types.field {
            None => format!("'{written}' is called, and nothing says it is a function — its type is unknown here. Call a closure whose type the program shows: one bound to a name ('g = label', then 'g()'), or a parameter typed as one ('f: <() => <text>>')"),
            Some(ty) => {
                let tail = if crate::types::field::may_be_closure(Some(ty)) { " — it may not be a closure" } else { ", not a function" };
                format!("'{written}' is called, and it is {}{tail}. Only a closure is called: narrow it to one, or call one whose type the program shows", crate::types::field::describe_field_type(ty))
            }
        })
    }
}

/// `callArgSpan`.
pub(crate) fn call_arg_span(arg: &CallArg) -> Span {
    match arg {
        CallArg::Expr { expr, .. } => expr.span,
        CallArg::Write { write, .. } => write.span,
        CallArg::Node { node, .. } => node.span,
        CallArg::Call { call, .. } => call.span,
        CallArg::Closure { span, .. } | CallArg::Type { span, .. } => *span,
    }
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

impl Checker<'_> {
    /// What a movement declares, against its symbol, for its calls.
    pub fn note_movement_params(&mut self, movement: &MovementDeclaration, scope: ScopeId) {
        if let Some(id) = self.scopes.scope(scope).symbols.get(&movement.name).copied()
            && self.scopes.symbol(id).kind == SymbolKind::Movement
        {
            self.register_movement(id, movement, scope);
            let returns = movement.return_type.is_some() || crate::families::closures::body_returns(&movement.body);
            self.function_returns.insert(id, returns);
        }
    }

    /// `checkCall`: a function's call — its callee, its arity, and its
    /// arguments against the parameters they bind.
    pub fn check_call(&mut self, call: &CallStatement, scope: ScopeId) -> crate::types::position::ReturnShape {
        let mut params = None;
        let mut value = crate::types::position::ReturnShape::default();
        let callee = self.callee_name(&call.callee, scope);
        let resolution = self.scopes.resolve(scope, &callee);
        // Before version 3 a built-in is not a callee (no standard library).
        if matches!(resolution, Resolution::Found(_)) || !crate::families::names::is_builtin_name(&call.callee) {
            match resolution {
                Resolution::Found(id) => (params, value) = self.check_callee(call, id, scope),
                Resolution::Unknown
                    if since(self.version, 3) && self.catalog.adapter(&callee).is_none() && self.catalog.plugin(&callee).is_none() =>
                {
                    let message = self.unknown_function_message(&call.callee, scope, None);
                    self.report(codes::FUNCTION_UNKNOWN, message, call.span);
                }
                failure => self.report_resolution_failure(&callee, call.span, failure),
            }
        }
        let names: Option<Vec<String>> = params.as_ref().map(|ps| ps.iter().map(|p| p.name.clone()).collect());
        self.check_argument_bindings(&call.callee, &call.args, names.as_deref(), call.span, false);
        // A plugin's argument values are held to what it declares it takes.
        let plugin = match self.scopes.resolve(scope, &callee) {
            Resolution::Found(id) if self.scopes.symbol(id).kind == SymbolKind::Plugin => {
                Some(self.plugin_spec_of(id, &call.callee).and_then(|s| s.arg_types.clone()))
            }
            _ => None,
        };
        let plugin = plugin.as_ref().map(|declared| crate::families::plugin_calls::PluginArgTypes { declared: declared.as_ref() });
        self.check_call_args(&call.callee, &call.args, params.as_deref(), plugin.as_ref(), scope);
        value
    }

    /// `checkCallbackNamed`'s arguments: bound partially, as the rest are
    /// what the callback is fired with, and each held to its parameter.
    pub fn check_callback_arguments(&mut self, movement: &str, args: &[CallArg], span: Span, scope: ScopeId) {
        let callee = self.callee_name(movement, scope);
        let params = match self.scopes.resolve(scope, &callee) {
            Resolution::Found(id) if self.scopes.symbol(id).kind == SymbolKind::Movement => self.movement_declared_params(id),
            _ => None,
        };
        let names: Option<Vec<String>> = params.as_ref().map(|ps| ps.iter().map(|p| p.name.clone()).collect());
        self.check_argument_bindings(movement, args, names.as_deref(), span, true);
        self.check_call_args(movement, args, params.as_deref(), None, scope);
    }

    /// The closure a callable name holds, as its signature says.
    pub fn called_closure(&self, id: SymbolId) -> Option<crate::types::position::ClosureType> {
        let symbol = self.scopes.symbol(id);
        if !self.calls_closure(symbol) {
            return None;
        }
        match (&symbol.types.pos, &symbol.types.field) {
            (Some(Position::Closure(c)), _) => Some(c.clone()),
            // From version 5 a closure is a value like any other, so a name
            // whose value is one, or one of several, is called as TypeScript
            // calls `f: (() => A) | (() => B)`.
            (None, Some(ty)) => closures_of_value(ty).map(|closures| crate::types::position::one_of_closures(&closures, true)),
            _ => None,
        }
    }

    /// `functionAsValue`: a function declared with a name, read as a value
    /// (version 5), is a closure like any other, as a TypeScript function
    /// declaration is — its parameters and what calling it returns. One type
    /// per declaration once its body is known; while that body is still
    /// being walked, the type is worked out afresh at each read.
    pub fn function_as_value(&mut self, id: SymbolId) -> Option<crate::types::position::ClosureType> {
        if self.scopes.symbol(id).kind != SymbolKind::Movement || before(self.version, 5) {
            return None;
        }
        if let Some(known) = self.function_values.get(&id) {
            return Some(known.clone());
        }
        let params = self.movement_declared_params(id).unwrap_or_default();
        let returns = self.movement_return(id);
        let written_at = self.scopes.symbol(id).span;
        let closure = crate::types::position::ClosureType::new("a closure", params, returns, Some(written_at));
        if self.inference.inferred.get(&self.declared_id(id)) != Some(&false) {
            self.function_values.insert(id, closure.clone());
        }
        Some(closure)
    }

    /// Types each function among `names` the typing about to run reads as a value.
    pub fn type_function_values<'n>(&mut self, names: impl IntoIterator<Item = &'n str>, scope: ScopeId) {
        if before(self.version, 5) {
            return;
        }
        for name in names {
            if let Resolution::Found(id) = self.scopes.resolve(scope, name)
                && self.scopes.symbol(id).kind == SymbolKind::Movement
            {
                self.function_as_value(id);
            }
        }
    }

    /// The function a movement's parameter belongs to, for its need cell.
    pub fn movement_param_of(&self, name: &str, scope: ScopeId) -> crate::binding_types::ParamOf {
        let id = self.scopes.scope(scope).symbols.get(name).copied();
        let owner = id.map(|id| crate::binding_types::NeedOwner::Function(self.declared_id(id)));
        crate::binding_types::ParamOf { owner, function: name.to_string() }
    }

    /// A movement's declaration and the scope it is declared in.
    pub fn movement_declaration(&self, id: SymbolId) -> Option<(Rc<MovementDeclaration>, ScopeId)> {
        self.inference.declarations.get(&self.declared_id(id)).map(|(m, scope)| (m.clone(), *scope))
    }

    /// The callee a call resolved to: the parameters its arguments bind, when
    /// known, and what the call hands back.
    fn check_callee(&mut self, call: &CallStatement, id: crate::scope::SymbolId, scope: ScopeId) -> (Option<Vec<ClosureParam>>, ReturnShape) {
        let callee = self.scopes.symbol(id).clone();
        let count = call.args.len();
        if callee.kind == SymbolKind::Movement {
            self.call_movement(id);
            let params = self.movement_declared_params(id);
            if let Some(params) = &params
                && params.len() != count
            {
                self.report(codes::CALL_ARITY, format!("'{}' takes {} argument{}, got {count}", call.callee, params.len(), plural(params.len())), call.span);
            }
            return (params, self.movement_return(id));
        }
        if callee.kind == SymbolKind::Plugin {
            return (None, self.check_plugin_application(call, id, scope));
        }
        if self.calls_closure(&callee) {
            self.note_self_call(id, call.span);
            let suspends = self.closure_suspends(id);
            self.absorb_suspend(suspends);
            let Some(closure) = self.called_closure(id) else { return (None, ReturnShape::default()) };
            let params = self.closure_call_params(call, &closure);
            return (Some(params), closure.returns);
        }
        if let Some(message) = self.not_a_closure_message(&callee, &call.callee) {
            self.report(codes::CALL_NOT_MOVEMENT, message, call.span);
        } else if callee.kind != SymbolKind::FileImport {
            self.report(
                codes::CALL_NOT_MOVEMENT,
                format!("'{}' is {}, not a movement — only movements are called", call.callee, callee.kind.describe()),
                call.span,
            );
        }
        (None, ReturnShape::default())
    }

    /// `closureCallParams`: the parameters a call through a closure value is
    /// held to, its arity checked. One of several closures is called as
    /// TypeScript calls a union of function types: every candidate's arity,
    /// and an argument that fits every candidate's parameter. Before version 5
    /// the closures a body's returns hand back are called as the first of
    /// them, so what version 5 holds the call to is an upgrade warning.
    fn closure_call_params(&mut self, call: &CallStatement, closure: &ClosureType) -> Vec<ClosureParam> {
        let candidates: Vec<ClosureType> = closure.candidates().into_iter().cloned().collect();
        let given = call.args.len();
        let strict = candidates.len() == 1 || since(self.version, 5);
        let say = |this: &mut Self, code: &str, message: String| {
            if strict {
                this.report(code, message, call.span);
            } else {
                this.report_upgrade_warning(
                    code,
                    format!("{message}. Before {} the call is typed by the first; from it, this is refused", crate::version::describe(5)),
                    call.span,
                );
            }
        };
        let mut arities: Vec<usize> = Vec::new();
        for candidate in &candidates {
            if !arities.contains(&candidate.params.len()) {
                arities.push(candidate.params.len());
            }
        }
        if !strict && closure.params.len() != given {
            let arity = closure.params.len();
            self.report(codes::CALL_ARITY, format!("'{}' takes {arity} argument{}, got {given}", call.callee, plural(arity)), call.span);
        } else if arities.iter().any(|&arity| arity != given) {
            let arity = if let [only] = arities.as_slice() {
                format!("takes {only} argument{}", plural(*only))
            } else {
                format!("may be any of several closures, taking {} arguments", arities.iter().map(usize::to_string).collect::<Vec<_>>().join(" or "))
            };
            say(self, codes::CALL_ARITY, format!("'{}' {arity}, got {given}", call.callee));
        }
        if candidates.len() == 1 {
            return closure.params.clone();
        }
        if !strict {
            self.warn_later_closure_returns(call, &candidates);
        }
        if arities.len() != 1 {
            return closure.params.clone();
        }
        let mut disagreements = Vec::new();
        let held = params_of_candidates(&candidates, |index, first, second| disagreements.push((index, first.clone(), second.clone())));
        for (index, first, second) in disagreements {
            let describe = |param: Option<&ClosureParam>| match param {
                Some(ClosureParam { plane: PlaneType { field: Some(field), .. }, .. }) => describe_field_type(field),
                Some(ClosureParam { plane: PlaneType { pos: Some(pos), .. }, .. }) => describe_position(pos),
                _ => "anything".to_string(),
            };
            let (a, b) = (first.params.get(index), second.params.get(index));
            let name = |p: Option<&ClosureParam>| p.map_or_else(|| "undefined".to_string(), |p| p.name.clone());
            say(
                self,
                codes::CALL_ARG_TYPE,
                format!(
                    "'{}' may be any of several closures, and two disagree about argument {}: {} takes {} for '{}', and {} takes {} for '{}'. No argument fits both, so no call fits every closure it may be, as in TypeScript. Give them parameters one argument fits, or call each where it is known",
                    call.callee,
                    index + 1,
                    describe_position(&Position::Closure(first.clone())),
                    describe(a),
                    name(a),
                    describe_position(&Position::Closure(second.clone())),
                    describe(b),
                    name(b),
                ),
            );
        }
        if strict { held } else { closure.params.clone() }
    }

    /// Before version 5: a later candidate may hand back a record the first —
    /// which types the call — does not. From 5 the call is any of their
    /// returns, so each use of it is checked as one that may be that record.
    fn warn_later_closure_returns(&mut self, call: &CallStatement, candidates: &[ClosureType]) {
        let first = &candidates[0].returns;
        let every = crate::types::position::union_returns(&candidates.iter().map(|c| c.returns.clone()).collect::<Vec<_>>());
        let shown = first.may_hold.clone().or_else(|| first.plane.field.clone()).or_else(|| crate::types::field::record_value_of(first.plane.pos.as_deref()));
        let held = every.may_hold.as_ref().or(every.plane.field.as_ref());
        let Some(hidden) = crate::types::field::handle_within(held, &crate::types::field::HeldWalk::taken_by(shown.as_ref())) else { return };
        self.report_upgrade_warning(
            codes::CALL_CLOSURE_RETURNS,
            format!(
                "'{}' may be any of several closures, and calling one other than the first may hand back {}. Before {} the call is typed by the first; from it, the call is any of their returns, and a use that takes no record is refused",
                call.callee,
                describe_field_type(&hidden.handle),
                crate::version::describe(5)
            ),
            call.span,
        );
    }

    /// `checkArgumentBindings`: named arguments given once, each naming a
    /// parameter, and every parameter supplied.
    fn check_argument_bindings(&mut self, callee: &str, args: &[CallArg], params: Option<&[String]>, span: Span, partial: bool) {
        let mut seen: Vec<&str> = Vec::new();
        for arg in args {
            let Some(name) = arg.name() else { continue };
            if seen.contains(&name) {
                self.report(codes::CALL_ARG_DUPLICATE, format!("Duplicate argument '{name}' — each of '{callee}'s parameters is supplied once"), call_arg_span(arg));
            }
            seen.push(name);
        }
        let Some(params) = params else { return };
        for arg in args {
            if let Some(name) = arg.name()
                && !params.iter().any(|p| p == name)
            {
                let list = if params.is_empty() { "(none)".to_string() } else { params.join(", ") };
                self.report(codes::CALL_ARG_UNKNOWN, format!("'{name}' is not a parameter of '{callee}' — its parameters are: {list}"), call_arg_span(arg));
            }
        }
        if partial {
            return;
        }
        let supplied: Vec<&str> = args.iter().enumerate().filter_map(|(i, arg)| arg.name().or(params.get(i).map(String::as_str))).collect();
        let missing: Vec<&String> = params.iter().filter(|p| !supplied.contains(&p.as_str())).collect();
        if !missing.is_empty() {
            let which = if missing.len() == 1 { "the argument" } else { "arguments" };
            let listed = missing.iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(", ");
            let positional = args.first().is_some_and(|a| a.name().is_none());
            let how = if positional { format!("pass one argument per parameter, in order: {callee}({})", params.join(", ")) } else { "supply every parameter by name".to_string() };
            self.report(codes::CALL_ARG_MISSING, format!("'{callee}' is missing {which} {listed} — {how}"), span);
        }
    }
}

impl Checker<'_> {
    /// A bound block whose body returns nothing.
    pub fn report_block_returns_nothing(&mut self, block: &movement_parser::ast::TraversalBlock, name: Option<&str>) {
        let root = match &block.head.root {
            Some(movement_parser::ast::PathRoot::Name { name }) => crate::families::names::spell_name(name),
            Some(movement_parser::ast::PathRoot::Expression { expr }) => expr.raw.clone(),
            None => String::new(),
        };
        self.report(
            codes::BLOCK_RETURNS_NOTHING,
            format!(
                "this block hands nothing back, so there is nothing to bind — 'return' the value you want out of it (`{} = {root}{} {{ … return <value> }}`), or drop the binding and let it run for its effects",
                name.unwrap_or("names"),
                block.head.hops_raw
            ),
            block.span,
        );
    }
}

impl Checker<'_> {
    /// Whether the function a callee names hands a value back, when the
    /// program shows its body (`calleeReturnKnown`).
    pub fn callee_returns(&self, written: &str, scope: ScopeId) -> Option<bool> {
        let callee = self.callee_name(written, scope);
        let Resolution::Found(id) = self.scopes.resolve(scope, &callee) else { return None };
        let symbol = self.scopes.symbol(id);
        if symbol.kind != SymbolKind::Movement && !self.calls_closure(symbol) {
            return None;
        }
        self.function_returns.get(&id).copied()
    }

    /// `reportCallReturnsNothing`.
    pub fn report_call_returns_nothing(&mut self, callee: &str, span: Span) {
        self.report(
            codes::CALL_RETURNS_NOTHING,
            format!("'{callee}' returns nothing, so there is no value to bind — a call's value is what it returns. Add a 'return' to '{callee}', or call it as a statement."),
            span,
        );
    }

    /// `reportParamNeedsType`.
    pub fn report_param_needs_type(&mut self, name: &str, span: Span, what: &str) {
        self.report(
            codes::PARAM_NEEDS_TYPE,
            format!("'{name}' needs a type — {what} declares what it accepts, so a caller can be checked against it: write '{name}: <text>' (or whatever it takes). A parameter goes untyped only where the caller supplies the type, which is the function a collection op is given."),
            span,
        );
    }
}

impl Checker<'_> {
    /// `callInConstructPosition`: `name(arg: …)` is one surface form, and a
    /// function's name there is a call, not a construction.
    pub fn call_in_construct_position(&self, construct: &movement_parser::ast::ConstructionCall, scope: ScopeId) -> Option<CallStatement> {
        let callee = self.callee_name(&construct.callee, scope);
        let Resolution::Found(id) = self.scopes.resolve(scope, &callee) else { return None };
        let symbol = self.scopes.symbol(id);
        let value = since(self.version, 5) && matches!(symbol.kind, SymbolKind::Binding | SymbolKind::Param);
        if !matches!(symbol.kind, SymbolKind::Movement | SymbolKind::Plugin) && !value && !self.calls_closure(symbol) {
            return None;
        }
        Some(CallStatement {
            callee: construct.callee.clone(),
            args: construct.args.iter().map(|a| CallArg::Expr { name: Some(a.name.clone()), expr: a.value.clone() }).collect(),
            expression: None,
            span: construct.span,
        })
    }

    /// A construction handed back (`return crm(…)`): an instance is not a value.
    pub fn report_construction_returned(&mut self, construct: &movement_parser::ast::ConstructionCall, span: Span) {
        self.report(
            codes::RETURN_NOT_A_VALUE,
            format!("'{}(…)' constructs an instance, and an instance is not a value to hand back — its schema belongs to the credential it was built with. Construct it in the movement that uses it.", construct.callee),
            span,
        );
    }
}

/// One strongly connected component of the call graph: movements that can
/// each reach the others (`CallCycle`, call_cycles.ts).
struct CallCycle {
    members: Vec<SymbolId>,
    /// Each walked member's own body's flag, calls into the component left out.
    rows: Vec<(SymbolId, bool)>,
    closed: bool,
    /// The stack depth of the member entered first: the component closes
    /// when that walk finishes.
    root_depth: usize,
    /// The first loop found, by name (`even → odd → even`), for messages.
    chain: Vec<String>,
}

impl CallCycle {
    /// `chainFrom`: the loop rotated to start and end at `name`.
    fn chain_from(&self, name: &str) -> Vec<String> {
        let ring = &self.chain[..self.chain.len().saturating_sub(1)];
        let Some(at) = ring.iter().position(|n| n == name) else { return self.chain.clone() };
        let mut rotated: Vec<String> = ring[at..].iter().chain(ring[..at].iter()).cloned().collect();
        rotated.push(name.to_string());
        rotated
    }
}

/// What a movement's body hands back and whether it may wait, learned by
/// walking it type-only when a call reaches it (`inferMovement`), and the
/// stack of bodies being so walked, where call cycles are found
/// (`InferenceStack`: Tarjan's algorithm run on the checker's own recursion).
#[derive(Default)]
pub struct Inference {
    declarations: HashMap<SymbolId, (Rc<MovementDeclaration>, ScopeId)>,
    /// Started (false) or finished (true).
    inferred: HashMap<SymbolId, bool>,
    /// Whether each movement's body may wait, once known.
    suspends: HashMap<SymbolId, bool>,
    /// What each movement's body hands back, once walked.
    returned: HashMap<SymbolId, ReturnShape>,
    /// An imported movement stands for the library's declaration: its
    /// body is walked once, and every call shares what was learned.
    adopted: HashMap<SymbolId, SymbolId>,
    walking: HashMap<SymbolId, usize>,
    cycle_of: HashMap<SymbolId, usize>,
    cycles: Vec<CallCycle>,
    stack: Vec<SymbolId>,
}

impl Checker<'_> {
    /// A movement declaration, kept so a call above it can walk its body.
    pub fn register_movement(&mut self, id: SymbolId, movement: &MovementDeclaration, scope: ScopeId) {
        self.inference.declarations.entry(id).or_insert_with(|| (Rc::new(movement.clone()), scope));
        self.note_declared_file(id);
    }

    /// An imported movement's symbol is the library's for inference.
    pub fn adopt_movement(&mut self, local: SymbolId, library: SymbolId) {
        if self.inference.declarations.contains_key(&library) {
            self.inference.adopted.insert(local, library);
        }
    }

    /// The symbol a movement's declaration is filed under.
    pub(crate) fn declared_id(&self, id: SymbolId) -> SymbolId {
        self.inference.adopted.get(&id).copied().unwrap_or(id)
    }

    /// What the movement's body was found to hand back, once walked.
    pub fn movement_inferred_return(&self, id: SymbolId) -> Option<ReturnShape> {
        self.inference.returned.get(&self.declared_id(id)).cloned()
    }

    /// A call reaches movement `id`: what it returns is inferred from its
    /// body unless declared (from version 5 the declaration is the answer),
    /// and what it does is the caller's.
    pub fn call_movement(&mut self, id: SymbolId) {
        let id = self.declared_id(id);
        let declared = self.inference.declarations.get(&id).is_some_and(|(m, _)| m.return_type.is_some()) && since(self.version, 3);
        if !(declared && since(self.version, 5)) {
            self.infer_movement(id);
        }
        let suspends = self.movement_suspends(id);
        self.absorb_suspend(suspends);
    }

    /// `movementEffects`, the suspend flag of it.
    pub fn movement_suspends(&mut self, id: SymbolId) -> bool {
        let id = self.declared_id(id);
        if !self.inference.declarations.contains_key(&id) {
            return false;
        }
        if since(self.version, 3) && self.reaches(id) {
            return false;
        }
        if let Some(known) = self.inference.suspends.get(&id) {
            return *known;
        }
        if !self.inference.inferred.contains_key(&id) {
            self.infer_movement(id);
        }
        if since(self.version, 3) && self.reaches(id) {
            return false;
        }
        self.inference.suspends.get(&id).copied().unwrap_or(false)
    }

    /// `inferMovement`: walks the body type-only, reporting nothing.
    pub fn infer_movement(&mut self, id: SymbolId) {
        let id = self.declared_id(id);
        match self.inference.inferred.get(&id) {
            Some(true) => return,
            Some(false) => {
                if since(self.version, 3) {
                    self.reaches(id);
                }
                return;
            }
            None => {}
        }
        let Some((movement, declared_in)) = self.inference.declarations.get(&id).cloned() else { return };
        self.inference.inferred.insert(id, false);
        let body = self.scopes.open(Some(declared_in));
        self.type_only += 1;
        self.enter_declared_file(id);
        for param in &movement.params {
            let is_closure = matches!(&param.type_, Some(movement_parser::ast::ParamTypeRef::Value(movement_parser::ast::ValueType::Closure { .. })));
            self.declare_param(body, &param.name, param.span, is_closure);
            if let Some(type_) = &param.type_ {
                let of = crate::binding_types::ParamOf { owner: Some(crate::binding_types::NeedOwner::Function(id)), function: movement.name.clone() };
                self.type_param(body, &param.name, type_, declared_in, &of);
            }
        }
        let what = format!("'{}'", movement.name);
        let walked = if since(self.version, 3) {
            self.enter_inference(id);
            self.open_effect_frame();
            let walked = self.check_body(&movement.body, body, what);
            let row = self.close_effect_frame();
            self.leave_inference(id, row);
            walked
        } else {
            self.open_effect_frame();
            let walked = self.check_body(&movement.body, body, what);
            let row = self.close_effect_frame();
            self.record_movement_row(id, row);
            walked
        };
        self.leave_declared_file();
        self.type_only -= 1;
        // A node the body builds is labelled by whose value it is, which is
        // the useful text at a call site; nothing else about its type changes.
        let mut returned = walked.value;
        // A parameter handed back is the caller's record again: what this
        // body needs of it was said at the call that handed it over.
        returned.plane.pos = returned.plane.pos.map(|pos| Box::new(crate::types::position::without_parameter(*pos)));
        if let Some(Position::Local(local)) = returned.plane.pos.as_deref_mut() {
            local.label = format!("the value of '{}'", movement.name);
        }
        self.inference.returned.insert(id, returned);
        self.inference.inferred.insert(id, true);
    }

    /// `recordMovementRow`: the row filed on the declaration, unless the
    /// movement is in a call cycle, whose members share the cycle's.
    pub fn record_movement_row(&mut self, id: SymbolId, row: bool) {
        if !self.inference.cycle_of.contains_key(&id) {
            self.inference.suspends.insert(id, row);
        }
    }

    /// `checkMovement`'s cycle half: a movement in a call cycle declares
    /// what it returns, unless its body returns nothing.
    pub fn report_movement_cycle(&mut self, id: SymbolId, movement: &MovementDeclaration, returns: bool) {
        let Some(cycle) = self.inference.cycle_of.get(&id).copied() else { return };
        if movement.return_type.is_some() || !returns || !since(self.version, 3) {
            return;
        }
        let chain = self.inference.cycles[cycle].chain_from(&movement.name);
        let chain: Vec<&str> = chain.iter().map(String::as_str).collect();
        self.report(
            codes::RECURSIVE_RETURN_TYPE,
            crate::families::closures::recursive_return_type_message(&movement.name, &chain, &format!("function {}(…): <number> {{ … }}", movement.name)),
            Span { start: movement.span.start, end: movement.span.start },
        );
    }

    fn enter_inference(&mut self, id: SymbolId) {
        self.inference.walking.insert(id, self.inference.stack.len());
        self.inference.stack.push(id);
    }

    /// `reaches`: true when reaching `target` closes a loop — it is still
    /// being walked, or belongs to a component still open — and then every
    /// body on the stack from the component's first member up is in it.
    fn reaches(&mut self, target: SymbolId) -> bool {
        let open = self.inference.cycle_of.get(&target).copied().filter(|c| !self.inference.cycles[*c].closed);
        let walking = self.inference.walking.get(&target).copied();
        if walking.is_none() && open.is_none() {
            return false;
        }
        let root_depth = walking.unwrap_or(usize::MAX).min(open.map_or(usize::MAX, |c| self.inference.cycles[c].root_depth));
        let cycle = match open {
            Some(cycle) => cycle,
            None => {
                let from = walking.unwrap_or(root_depth);
                let mut chain: Vec<String> = self.inference.stack[from..].iter().map(|m| self.scopes.symbol(*m).name.clone()).collect();
                chain.push(self.scopes.symbol(target).name.clone());
                self.inference.cycles.push(CallCycle { members: Vec::new(), rows: Vec::new(), closed: false, root_depth, chain });
                self.inference.cycles.len() - 1
            }
        };
        let cycle_root = &mut self.inference.cycles[cycle].root_depth;
        *cycle_root = (*cycle_root).min(root_depth);
        for depth in root_depth..self.inference.stack.len() {
            let member = self.inference.stack[depth];
            self.join_cycle(cycle, member);
        }
        self.join_cycle(cycle, target);
        true
    }

    fn join_cycle(&mut self, cycle: usize, member: SymbolId) {
        let other = self.inference.cycle_of.get(&member).copied();
        if other == Some(cycle) {
            return;
        }
        // Two loops that share a function are one component.
        if let Some(other) = other
            && !self.inference.cycles[other].closed
        {
            let merged = std::mem::take(&mut self.inference.cycles[other].members);
            let rows = std::mem::take(&mut self.inference.cycles[other].rows);
            let other_root = self.inference.cycles[other].root_depth;
            let target = &mut self.inference.cycles[cycle];
            target.root_depth = target.root_depth.min(other_root);
            for each in merged {
                if !target.members.contains(&each) {
                    target.members.push(each);
                }
                self.inference.cycle_of.insert(each, cycle);
            }
            self.inference.cycles[cycle].rows.extend(rows);
        }
        self.inference.cycle_of.insert(member, cycle);
        if !self.inference.cycles[cycle].members.contains(&member) {
            self.inference.cycles[cycle].members.push(member);
        }
    }

    /// `leave`: outside any component the row is the movement's; inside one
    /// it waits for the component to close, when every member gets the union.
    fn leave_inference(&mut self, id: SymbolId, row: bool) {
        let depth = self.inference.walking.remove(&id);
        self.inference.stack.pop();
        let cycle = self.inference.cycle_of.get(&id).copied();
        let Some(cycle) = cycle.filter(|c| !self.inference.cycles[*c].closed) else {
            self.inference.suspends.insert(id, row);
            return;
        };
        self.inference.cycles[cycle].rows.push((id, row));
        if depth != Some(self.inference.cycles[cycle].root_depth) {
            return;
        }
        let shared = self.inference.cycles[cycle].rows.iter().any(|(_, r)| *r);
        for member in self.inference.cycles[cycle].members.clone() {
            self.inference.suspends.insert(member, shared);
        }
        self.inference.cycles[cycle].closed = true;
    }
}

/// `paramTakesAll`: does every argument `narrow` takes fit `wide` too? An
/// untyped parameter takes anything; a value and a record parameter share no
/// argument.
fn param_takes_all(narrow: &PlaneType, wide: &PlaneType) -> bool {
    match (narrow, wide) {
        (_, PlaneType { field: None, pos: None }) => true,
        (PlaneType { field: Some(n), .. }, PlaneType { field: Some(w), .. }) => crate::types::field::field_assignable(n, w),
        (PlaneType { pos: Some(n), .. }, PlaneType { pos: Some(w), .. }) => crate::types::position::positions_match(n, w) != Some(false),
        _ => false,
    }
}

/// `paramsOfCandidates`: the parameters a call of one of several closures is
/// held to — TypeScript's rule for a union of function types. Each place
/// takes the candidate parameter every other one takes too; where none is
/// that narrow, `disagree` names two candidates and the place is left untyped.
fn params_of_candidates(candidates: &[ClosureType], mut disagree: impl FnMut(usize, &ClosureType, &ClosureType)) -> Vec<ClosureParam> {
    let Some(first) = candidates.first() else { return Vec::new() };
    let untyped = PlaneType::default();
    first
        .params
        .iter()
        .enumerate()
        .map(|(index, own)| {
            let at: Vec<Option<&ClosureParam>> = candidates.iter().map(|c| c.params.get(index)).collect();
            let narrowest = at.iter().flatten().find(|param| at.iter().all(|other| other.is_none_or(|other| param_takes_all(&param.plane, &other.plane))));
            if let Some(narrowest) = narrowest {
                return (*narrowest).clone();
            }
            let plane_at = |i: usize| at[i].map_or(&untyped, |p| &p.plane);
            let first_off = (1..candidates.len()).find(|&i| !param_takes_all(&own.plane, plane_at(i)) && !param_takes_all(plane_at(i), &own.plane));
            disagree(index, first, &candidates[first_off.unwrap_or(1)]);
            ClosureParam { name: own.name.clone(), plane: PlaneType::default() }
        })
        .collect()
}
