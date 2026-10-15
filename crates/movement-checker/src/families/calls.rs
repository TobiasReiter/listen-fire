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
//! - MOV_RETURN_PLANE_MISMATCH
//! - MOV_RETURN_TYPE
//! - MOV_STDLIB_ARG_INVALID
//! - MOV_STDLIB_ARG_NOT_LITERAL

use movement_parser::ast::{ArmExpression, CallArg, CallStatement, CollectionOp, CollectionOpExpression, ExprSlot, Loc, MembersExpression, Span};
use movement_parser::lowering::HeldAsData;
use movement_parser::lowering::expression::Expression;
use movement_parser::version::since;

use movement_parser::tree::{At, MExpr, MapMember, StringPart};

use crate::checker::Checker;
use crate::codes;
use crate::scope::{Resolution, ScopeId, Symbol, SymbolKind};
use crate::slots::SlotError;
use crate::types::stdlib::{Builtin, lookup_builtin};

/// `describeBuiltin` for each flat built-in (generated from
/// `standardLibrary()`), with its form.
const DESCRIBED: &[(&str, &str, &str)] = &[
    ("ISNULL", "ISNULL(value)", "value"),
    ("COALESCE", "COALESCE(…values)", "value"),
    ("TRIM", "TRIM(text)", "value"),
    ("LOWER", "LOWER(text)", "value"),
    ("UPPER", "UPPER(text)", "value"),
    ("LENGTH", "LENGTH(value)", "value"),
    ("ABS", "ABS(number)", "value"),
    ("ROUND", "ROUND(number, places?)", "value"),
    ("FLOOR", "FLOOR(number)", "value"),
    ("CEIL", "CEIL(number)", "value"),
    ("TOSTRING", "TOSTRING(value)", "value"),
    ("TONUMBER", "TONUMBER(value)", "value"),
    ("MULTI", "MULTI(…values)", "value"),
    ("SPLIT", "SPLIT(text, separator?)", "value"),
    ("DATE", "DATE(value)", "value"),
    ("DATETIME", "DATETIME(value)", "value"),
    ("NUMBER", "NUMBER(value)", "value"),
    ("FIRST", "FIRST(collection)", "value"),
    ("LAST", "LAST(collection)", "value"),
    ("ONLY", "ONLY(collection)", "value"),
    ("COUNT", "COUNT(collection)", "value"),
    ("SUM", "SUM(collection)", "value"),
    ("AVG", "AVG(collection)", "value"),
    ("MIN", "MIN(collection)", "value"),
    ("MAX", "MAX(collection)", "value"),
    ("JOIN", "JOIN(collection, separator?)", "value"),
    ("COLLECT", "COLLECT(collection)", "value"),
    ("LLM_AGG", "LLM_AGG(collection, instruction?)", "value"),
    ("AI", "AI(prompt, tier?)", "value"),
    ("CONCAT", "CONCAT(…parts)", "value"),
    ("KG_EXISTS", "KG_EXISTS(query, …params)", "value"),
    ("KG_VALUE", "KG_VALUE(query, …params)", "value"),
    ("EXTRACT_VALUE", "EXTRACT_VALUE(…values)", "value"),
    ("AT", "AT(collection, index)", "value"),
    ("SORT", "SORT(collection, key?, direction?)", "value"),
    ("FILE", "FILE(content, type)", "value"),
    ("READ", "READ(file)", "value"),
    ("CHUNKS", "CHUNKS(text, options)", "value"),
    ("EXISTS", "EXISTS(walk)", "value"),
    ("MAP", "MAP(collection, settings?, function)", "collection"),
    ("FILTER", "FILTER(collection, settings?, function)", "collection"),
    ("REDUCE", "REDUCE(collection, start, function)", "collection"),
    ("GROUPBY", "GROUPBY(collection, key)", "collection"),
    ("KEYBY", "KEYBY(collection, key)", "collection"),
    ("MEMBERS", "MEMBERS(type)", "members"),
    ("EXTRACT", "EXTRACT(content, shape, settings?)", "extract"),
    ("EXTRACTONE", "EXTRACTONE(content, shape, settings?)", "extract"),
    ("CURRENCY.GET_NUMBER_FROM_FIGURE", "CURRENCY.GET_NUMBER_FROM_FIGURE(figure)", "value"),
    ("CURRENCY.GET_CODE_FROM_FIGURE", "CURRENCY.GET_CODE_FROM_FIGURE(figure)", "value"),
    ("CURRENCY.FORMAT_FIGURE", "CURRENCY.FORMAT_FIGURE(number, code)", "value"),
    ("DATE.PARSE", "DATE.PARSE(text)", "value"),
    ("DATE.ADD_DAYS", "DATE.ADD_DAYS(date, days)", "value"),
    ("DATE.FORMAT", "DATE.FORMAT(value, pattern)", "value"),
    ("DATE.FORMAT_ISO", "DATE.FORMAT_ISO(value)", "value"),
    ("DATE.TODAY", "DATE.TODAY(zone)", "value"),
    ("DATETIME.AT", "DATETIME.AT(date, time, zone)", "value"),
    ("TEXT.REGEX_EXTRACT", "TEXT.REGEX_EXTRACT(text, pattern, group?)", "value"),
    ("TEXT.SLUG", "TEXT.SLUG(text)", "value"),
    ("TEXT.PAIRS", "TEXT.PAIRS(record, separator?)", "value"),
    ("TEXT.SERIALISE", "TEXT.SERIALISE(value, format)", "value"),
    ("URL.HOST", "URL.HOST(text)", "value"),
    ("NUMBER.FORMAT", "NUMBER.FORMAT(number, style)", "value"),
];

/// `describeBuiltin`: the built-in's signature as the author reads it.
pub fn describe_builtin(builtin: &Builtin) -> String {
    DESCRIBED.iter().find(|(name, ..)| *name == builtin.name).map_or_else(|| format!("{}(…)", builtin.name), |(_, d, _)| d.to_string())
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
    match DESCRIBED.iter().find(|(name, ..)| *name == builtin.name).map(|(.., form)| *form) {
        Some("members") => BuiltinForm::Members,
        Some("extract") => BuiltinForm::Extract,
        Some("collection") => BuiltinForm::Collection,
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
use crate::types::position::Position;

/// Called by the type core after the values family's `observe`, for every
/// node: a built-in call's argument rules (`checkBuiltinArgs`,
/// `checkStdlibLiteralArgs`) live here. `crate::types::stdlib` has the signatures.
pub fn observe(_typing: &mut Typing, _expr: &Expression, _position: Option<&Position>, _operands: &[Option<Ty>], _ty: Option<&Ty>) {}

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
        for call in calls {
            let at = call.at();
            let span = span_of_extent(slot, at);
            let name = nested_call_name(span);
            let head = String::from_utf16_lossy(&units[..at.end]);
            match movement_parser::stmt::Parser::new(&head, self.version, slot.span.start, true).parse_nested_call_value(at.start) {
                Ok(value) => {
                    self.check_rvalue(&value, scope, None);
                }
                Err(e) => self.report(codes::EXPR_PARSE, format!("{} (line {}, col {})", e.message, e.loc.line, e.loc.col), span),
            }
            let symbol = self.scopes.add_symbol(Symbol::new(&name, SymbolKind::Binding, span));
            self.scopes.declare(scope, symbol);
            rewritten.extend_from_slice(&units[from..at.start]);
            // The name in the call's place, padded to the call's length so
            // every later offset into the text is the original's.
            let spelled: Vec<u16> = format!("`{name}`").encode_utf16().collect();
            let extent = &units[at.start..at.end];
            rewritten.extend_from_slice(&spelled);
            for unit in extent.iter().skip(spelled.len()) {
                rewritten.push(if *unit == u16::from(b'\n') { *unit } else { u16::from(b' ') });
            }
            from = at.end;
        }
        rewritten.extend_from_slice(&units[from..]);
        Some(ExprSlot::plain(String::from_utf16_lossy(&rewritten), slot.span))
    }
}

/// `closureOfValue`: a value that is a closure (every member of a union one).
pub fn closure_of_value(ty: &Ty) -> bool {
    match ty {
        Ty::Record(Some(position)) => position.is_closure(),
        Ty::Union(members) => !members.is_empty() && members.iter().all(closure_of_value),
        _ => false,
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
            CallReading::Function => self.check_call(call, scope),
            CallReading::Collection(collection) => self.check_collection_op(&collection, scope),
            CallReading::Refused { code, message, span } => self.report(code, message, span),
            CallReading::Value(expr) => self.check_expr_slot(&expr, scope),
            CallReading::Members(_) => {}
        }
    }

    /// `checkRValue`'s call case: a built-in is the value, collection op or
    /// type query it computes.
    pub fn check_call_rvalue(&mut self, call: &CallStatement, scope: ScopeId) {
        match self.read_call(call, scope, CallPosition::Value) {
            CallReading::Function => self.check_call(call, scope),
            CallReading::Value(expr) => self.check_expr_slot(&expr, scope),
            CallReading::Collection(collection) => self.check_collection_op(&collection, scope),
            CallReading::Members(_) => {}
            CallReading::Refused { code, message, span } => self.report(code, message, span),
        }
    }

    /// `checkCallArg`'s call case: a built-in called here is the value it computes.
    pub fn check_call_in_argument(&mut self, call: &CallStatement, scope: ScopeId) {
        match self.read_call(call, scope, CallPosition::Argument) {
            CallReading::Value(expr) => self.check_expr_slot(&expr, scope),
            CallReading::Refused { code, message, span } => self.report(code, message, span),
            _ => self.check_call(call, scope),
        }
    }
}
