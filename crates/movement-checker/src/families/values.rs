//! The values family: what an expression does with its values — arithmetic,
//! comparison, absence, structured (`json`) values, enum literals, dict keys,
//! list and map spreads, ordering keys, `SORT`, and the order a fold reads.
//! Its codes (PORT.md has where the TypeScript raises each):
//!
//! - MOV_ABSENT_REQUIRED
//! - MOV_ARITH_NON_NUMERIC
//! - MOV_COMPARE_TYPE_MISMATCH
//! - MOV_DICT_KEY_NOT_TEXT
//! - MOV_DICT_UNKNOWN_KEY
//! - MOV_ENUM_EMPTY_DOMAIN
//! - MOV_ENUM_UNKNOWN_VALUE
//! - MOV_FOLD_NEEDS_ORDER
//! - MOV_JSON_OPAQUE
//! - MOV_LIST_MIXED
//! - MOV_LIST_SPREAD_NOT_A_LIST
//! - MOV_MAP_KEY_OVERWRITTEN
//! - MOV_MAP_SPREAD_NOT_KEYED
//! - MOV_ORDER_KEY_IMPURE
//! - MOV_ORDER_KEY_MULTI
//! - MOV_PRESENCE_TEST_CONSTANT
//! - MOV_PRESENCE_TEST_ON_TEXT
//! - MOV_SORT_KEY_ON_SCALAR
//! - MOV_SORT_KEY_ON_WALK
//! - MOV_SORT_NEEDS_KEY
//! - MOV_SORT_NOT_COLLECTION
//! - MOV_VALUE_UNLISTED
//!
//! The expression rules run from the type core's hooks (`observe` and the
//! named ones it calls mid-node); the statement rules (a write's absent
//! field, a collection operation's order) are the walk's, in `checker.rs`.

use movement_parser::lowering::expression::{AggregationFunction, ArithmeticOp, Expression, FilterOperator, StaticValue};

use crate::codes;
use crate::diagnostic::Severity;
use crate::types::field::{
    BaseKind, CollectionOrder, Ty, base_kinds, collection_element_of, collection_order_of, comparison_category, describe_field_type,
    field_type_equals, is_maybe_absent, is_record, may_be_closure, closure_not_data_message, members_comparable, strip_absent,
    union_members, unwrap_list, ComparisonCategory,
};
use crate::types::infer::Typing;
use crate::types::narrowing::{POSITION_SENTINEL, bare_name, direct_field_read, is_null_literal};
use crate::types::position::{Position, lookup_property_type};


/// Called by the type core after it types each expression node, children
/// first: `operands` are the direct operands' types in source order (an
/// arithmetic's two sides, a call's arguments, a concat's parts, a
/// conditional's condition, then and else).
pub fn observe(typing: &mut Typing, expr: &Expression, position: Option<&Position>, operands: &[Option<Ty>], _ty: Option<&Ty>) {
    match expr {
        Expression::Concat { parts } => {
            for part in operands {
                require_transparent(typing, part.as_ref(), "combined into text");
            }
            if typing.version >= 5 {
                for (part, ty) in parts.iter().zip(operands) {
                    refuse_file_in_text(typing, part, ty.as_ref());
                }
            }
        }
        Expression::Arithmetic { op, left, right } => {
            let (l, r) = (operands[0].as_ref(), operands[1].as_ref());
            let left_opaque = require_transparent(typing, l, "used in arithmetic");
            let right_opaque = require_transparent(typing, r, "used in arithmetic");
            if (left_opaque && may_be_closure(l)) || (right_opaque && may_be_closure(r)) {
                return;
            }
            if let Some(message) = arithmetic_operands_message(*op, left, right, l, r) {
                typing.report(codes::ARITH_NON_NUMERIC, message);
            }
        }
        Expression::Negate { .. } => {
            let inner = operands[0].as_ref();
            if require_transparent(typing, inner, "negated") && may_be_closure(inner) {
                return;
            }
            if let Some(message) = negate_operand_message(inner) {
                typing.report(codes::ARITH_NON_NUMERIC, message);
            }
        }
        Expression::Compare { op, left, right } => {
            let (l, r) = (operands[0].clone(), operands[1].clone());
            // A closure compared is the closures family's to refuse, said once.
            if closure_operand(typing, &[(left, l.as_ref()), (right, r.as_ref())]) {
                return;
            }
            check_compare_operands(typing, *op, left, right, l.as_ref(), r.as_ref());
        }
        Expression::Traverse { .. } => {
            if let Some(name) = crate::types::narrowing::exists_subject(expr) {
                report_constant_presence_test(typing, name, &format!("EXISTS({name})"), "always true");
            }
        }
        Expression::At { expression, .. } => {
            if at_reads_record(typing, expression, operands[1].as_ref()).is_some() {
                return;
            }
            if !operands[0].as_ref().is_some_and(|inner| matches!(strip_absent(inner), Ty::Dict { .. })) {
                check_fold_order(typing, Fold::At, expression, position);
            }
        }
        Expression::Aggregate { fn_, expression, order_by, .. } => {
            let inner = operands[0].as_ref();
            if *fn_ == AggregationFunction::Sort {
                check_sort(typing, expression, order_by.as_deref(), inner, position);
                return;
            }
            check_fold_order(typing, Fold::Aggregate(*fn_), expression, position);
            let element = inner.map(unwrap_list);
            match fn_ {
                AggregationFunction::Sum | AggregationFunction::Avg => {
                    require_transparent(typing, element.as_ref(), "added up");
                }
                AggregationFunction::Join => {
                    require_transparent(typing, element.as_ref(), "joined into text");
                }
                AggregationFunction::Min | AggregationFunction::Max => {
                    require_transparent(typing, element.as_ref(), "ordered");
                }
                _ => {}
            }
        }
        Expression::Llm { tier, .. } => {
            for (code, message, severity) in ai_tier_diagnostics(tier.as_deref()) {
                match severity {
                    Some(severity) => typing.report_with(code, message, severity),
                    None => typing.report(code, message),
                }
            }
        }
        Expression::Function { fn_, args } => {
            if fn_ == "isnull" && args.len() == 1 {
                refuse_text_presence_test(typing, &args[0], PresenceAsk::Absent);
            }
        }
        _ => {}
    }
}

/// `AT` off a record by a key (anything but a number): a record is no map, so
/// the key would reach the engine's own object, never a field. Asked of the
/// value's structure, so a record in any arm of a choice is one.
fn at_reads_record(typing: &Typing, operand: &Expression, index_ty: Option<&Ty>) -> Option<crate::types::field::HeldHandle> {
    let record = typing.handle_held_by(operand, &crate::types::field::HeldWalk::files_only())?;
    (record.steps.is_empty() && !matches!(strip_absent(index_ty.unwrap_or(&Ty::Absent)), Ty::Number)).then_some(record)
}

/// The type core's `at` case asks this first: true when it refused the read
/// (`AT_RECORD_KEY`), which then has no type.
pub fn refuse_record_key(typing: &mut Typing, operand: &Expression, index: &Expression, index_ty: Option<&Ty>) -> bool {
    let Some(record) = at_reads_record(typing, operand, index_ty) else { return false };
    let name = typing.bare_name_of(operand).unwrap_or("r").to_string();
    let key = match index {
        Expression::Static { value: StaticValue::String(key) } => Some(key.clone()),
        _ => None,
    };
    let read = format!("{}.{}", quote_name(&name), key.as_deref().map_or_else(|| "`Name`".to_string(), quote_name));
    let said = match &key {
        Some(key) => format!("'{key}' is not a key it holds"),
        None => "its fields are not keys to look up".to_string(),
    };
    typing.report(
        codes::AT_RECORD_KEY,
        format!(
            "AT looks up a list's slot or a map's key, and this {} a record — {said}. Read a field with a dot ({read}), or build a map of the fields you need ({{ name: {}.`Name`, … }}) and look the key up in that",
            if record.may { "may be" } else { "is" },
            quote_name(&name)
        ),
    );
    true
}

/// `refuseFileInText` (language version 5): a file, or one arm that may be
/// one, has no text form but the one READ gives.
fn refuse_file_in_text(typing: &mut Typing, part: &Expression, ty: Option<&Ty>) {
    let may = typing.may_hold_type(part);
    let holds_file = |t: Option<&Ty>| t.is_some_and(|t| crate::types::field::base_kinds(t).contains(&crate::types::field::BaseKind::File));
    if !holds_file(ty) && !holds_file(may.as_ref()) {
        return;
    }
    let definite = ty.is_some_and(|t| matches!(strip_absent(t), Ty::File));
    typing.report(
        codes::FILE_IN_TEXT,
        format!(
            "this {} a file, and a file is not text, so it can't be combined into text — its text is READ(f) ('${{COALESCE(READ(f), \"\")}}'), or write the file into a field that holds files",
            if definite { "is" } else { "may be" }
        ),
    );
}

/// A closure among a value expression's operands (language version 5): the
/// closures family refuses it, and nothing else is said of the expression.
fn closure_operand(typing: &Typing, operands: &[(&Expression, Option<&Ty>)]) -> bool {
    typing.version >= 5 && operands.iter().any(|(operand, ty)| may_be_closure(*ty) || may_be_closure(typing.may_hold_type(operand).as_ref()))
}

// ── Structured values ──

/// `checkJsonOpaque`: a structured value nothing describes, `operation`ed.
pub fn json_opaque_message(ty: Option<&Ty>, operation: &str) -> Option<String> {
    let ty = ty?;
    if !base_kinds(ty).contains(&BaseKind::Json) {
        return None;
    }
    Some(format!(
        "{} is a structured value and nothing describes its shape, so it can't be {operation} — pass it through unchanged into a json field instead",
        describe_field_type(strip_absent(ty))
    ))
}

/// `checkRecordAsValue`: a record where a value is required.
pub fn record_as_value_message(ty: Option<&Ty>, operation: &str) -> Option<String> {
    let ty = ty?;
    if !base_kinds(ty).contains(&BaseKind::Record) {
        return None;
    }
    Some(format!(
        "{} is a record, not a value, so it can't be {operation} — read a field off it ('c.`Name`'), or walk it in a block ('c-[x:edge]-> {{ … }}')",
        describe_field_type(strip_absent(ty))
    ))
}

/// `requireTransparent`: a value an operation reads must be one it can read —
/// not a closure (version 5), not a structured value nothing describes, not a
/// record. True when it was refused.
pub fn require_transparent(typing: &mut Typing, ty: Option<&Ty>, operation: &str) -> bool {
    if typing.version >= 5 && may_be_closure(ty) {
        typing.report(codes::CLOSURE_NOT_DATA, closure_not_data_message(&format!("a value {operation} is")));
        return true;
    }
    if let Some(message) = json_opaque_message(ty, operation) {
        typing.report(codes::JSON_OPAQUE, message);
        return true;
    }
    if let Some(message) = record_as_value_message(ty, operation) {
        typing.report(codes::RECORD_NOT_A_VALUE, message);
        return true;
    }
    false
}

// ── Arithmetic ──

fn arith_symbol(op: ArithmeticOp) -> &'static str {
    match op {
        ArithmeticOp::Add => "+",
        ArithmeticOp::Sub => "-",
        ArithmeticOp::Mul => "*",
        ArithmeticOp::Div => "/",
        ArithmeticOp::Rem => "%",
    }
}

/// `checkArithmeticOperands`.
fn arithmetic_operands_message(op: ArithmeticOp, left: &Expression, right: &Expression, l: Option<&Ty>, r: Option<&Ty>) -> Option<String> {
    let sides = [("left", l), ("right", r)];
    if sides.iter().any(|(_, t)| t.is_some_and(|t| base_kinds(t).contains(&BaseKind::Json))) {
        return None;
    }
    let offenders: Vec<(&str, &Ty)> = sides
        .iter()
        .filter_map(|(label, t)| t.filter(|t| base_kinds(t).iter().any(|k| *k != BaseKind::Number)).map(|t| (*label, t)))
        .collect();
    if offenders.is_empty() {
        return None;
    }
    let described: Vec<String> = offenders.iter().map(|(_, t)| describe_field_type(strip_absent(t))).collect();
    let symbol = arith_symbol(op);
    let subject = if offenders.len() == 1 {
        format!("the {} side of '{symbol}' is {}", offenders[0].0, described[0])
    } else if described[0] == described[1] {
        format!("both sides of '{symbol}' are {}", described[0])
    } else {
        format!("the left side of '{symbol}' is {} and the right side is {}", described[0], described[1])
    };
    let kinds: Vec<BaseKind> = offenders.iter().flat_map(|(_, t)| base_kinds(t)).collect();
    let whole = Expression::Arithmetic { op, left: Box::new(left.clone()), right: Box::new(right.clone()) };
    Some(format!("An arithmetic operation requires numeric operands — {subject}.{}", arithmetic_hint(op, &whole, &kinds)))
}

fn arithmetic_hint(op: ArithmeticOp, whole: &Expression, offending: &[BaseKind]) -> String {
    if offending.contains(&BaseKind::Text) {
        if op != ArithmeticOp::Add {
            return " Wrap it in NUMBER(…) if it holds a number.".to_string();
        }
        return match interpolation_rewrite(whole) {
            Some(rewritten) => format!(" Build the string with \"${{…}}\" interpolation instead: {rewritten}."),
            None => " Build the string with \"${…}\" interpolation instead.".to_string(),
        };
    }
    if offending.contains(&BaseKind::Date) || offending.contains(&BaseKind::Datetime) {
        return " Shift a date with DATE.ADD_DAYS(date, days) instead.".to_string();
    }
    String::new()
}

/// `interpolationRewrite`: the `+` chain as one interpolated string.
fn interpolation_rewrite(expr: &Expression) -> Option<String> {
    fn walk(e: &Expression, parts: &mut Vec<String>) -> bool {
        if let Expression::Arithmetic { op: ArithmeticOp::Add, left, right } = e {
            return walk(left, parts) && walk(right, parts);
        }
        if let Some(literal) = literal_text(e) {
            parts.push(literal);
            return true;
        }
        match operand_source(e) {
            Some(source) => {
                parts.push(format!("${{{source}}}"));
                true
            }
            None => false,
        }
    }
    let mut parts = Vec::new();
    walk(expr, &mut parts).then(|| format!("\"{}\"", parts.concat()))
}

fn literal_text(expr: &Expression) -> Option<String> {
    let Expression::Static { value } = expr else { return None };
    match value {
        StaticValue::Null => None,
        StaticValue::String(s) => (!(s.contains('"') || s.contains('\\') || s.contains('\n') || s.contains("${"))).then(|| s.clone()),
        StaticValue::Number(n) => Some(js_number(n.0)),
        StaticValue::Bool(b) => Some(b.to_string()),
    }
}

/// A number as JavaScript's `String(n)` spells it, for the values a source writes.
fn js_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 { format!("{}", n as i64) } else { format!("{n}") }
}

fn operand_source(expr: &Expression) -> Option<String> {
    match expr {
        Expression::Property { property_type_id } => Some(quote_name(property_type_id)),
        Expression::Meta { key } => Some(format!("@{key}")),
        Expression::AliasRef { name } => Some(quote_name(name)),
        Expression::Traverse { alias_root: Some(root), steps, expression } if steps.is_empty() => match &**expression {
            Expression::Property { property_type_id } => Some(format!("{}.{}", quote_name(root), quote_name(property_type_id))),
            _ => None,
        },
        _ => None,
    }
}

/// `checkNegateOperand`.
fn negate_operand_message(ty: Option<&Ty>) -> Option<String> {
    let ty = ty?;
    let kinds = base_kinds(ty);
    if kinds.contains(&BaseKind::Json) || kinds.iter().all(|k| *k == BaseKind::Number) {
        return None;
    }
    let hint = if kinds.contains(&BaseKind::Text) {
        " Wrap it in NUMBER(…) if it holds a number."
    } else if kinds.contains(&BaseKind::Date) || kinds.contains(&BaseKind::Datetime) {
        " Shift a date with DATE.ADD_DAYS(date, days) instead."
    } else {
        ""
    };
    Some(format!(
        "An arithmetic operation requires numeric operands — the operand of unary '-' is {}.{hint}",
        describe_field_type(strip_absent(ty))
    ))
}

// ── Comparison ──

#[derive(Clone, Copy, PartialEq, Eq)]
enum CompareRule {
    SameCategory,
    ElementWise,
    Duration,
    None,
}

fn compare_rule(op: FilterOperator) -> CompareRule {
    match op {
        FilterOperator::Eq | FilterOperator::Neq | FilterOperator::In | FilterOperator::Contains => CompareRule::ElementWise,
        FilterOperator::Gt | FilterOperator::Gte | FilterOperator::Lt | FilterOperator::Lte => CompareRule::SameCategory,
        FilterOperator::Within => CompareRule::Duration,
        FilterOperator::Exists => CompareRule::None,
    }
}

/// `describeFilterOp`.
pub fn describe_filter_op(op: FilterOperator) -> &'static str {
    match op {
        FilterOperator::Eq => "equals",
        FilterOperator::Neq => "not equals",
        FilterOperator::Contains => "contains",
        FilterOperator::Gt => ">",
        FilterOperator::Gte => ">=",
        FilterOperator::Lt => "<",
        FilterOperator::Lte => "<=",
        FilterOperator::Exists => "exists",
        FilterOperator::In => "in",
        FilterOperator::Within => "within",
    }
}

/// `checkCompareOperands`.
fn check_compare_operands(typing: &mut Typing, op: FilterOperator, left: &Expression, right: &Expression, l: Option<&Ty>, r: Option<&Ty>) {
    if is_null_literal(left) || is_null_literal(right) {
        check_null_comparison(typing, op, left, right, l, r);
        return;
    }
    match compare_rule(op) {
        CompareRule::None => {}
        CompareRule::Duration => {
            if let Some(l) = l.filter(|l| is_maybe_absent(Some(l))) {
                report_absent_in_comparison(typing, l);
            }
            check_within_duration(typing, right);
        }
        CompareRule::ElementWise => {
            let lu = l.map(unwrap_list);
            let ru = r.map(unwrap_list);
            check_comparable(typing, lu.as_ref(), ru.as_ref(), true);
            check_enum_literal_operand(typing, left, lu.as_ref(), ru.as_ref());
            check_enum_literal_operand(typing, right, ru.as_ref(), lu.as_ref());
        }
        CompareRule::SameCategory => {
            if require_transparent(typing, l, "ordered") || require_transparent(typing, r, "ordered") {
                return;
            }
            if let Some(l) = l.filter(|l| is_maybe_absent(Some(l))) {
                report_absent_in_comparison(typing, l);
            }
            if let Some(r) = r.filter(|r| is_maybe_absent(Some(r))) {
                report_absent_in_comparison(typing, r);
            }
            check_comparable(typing, l, r, false);
            check_enum_literal_operand(typing, left, l, r);
            check_enum_literal_operand(typing, right, r, l);
        }
    }
}

/// `checkComparable`: `overlap` for equality and membership, otherwise every
/// pair must order alike.
fn check_comparable(typing: &mut Typing, left: Option<&Ty>, right: Option<&Ty>, overlap: bool) {
    let (Some(left), Some(right)) = (left, right) else { return };
    if is_record(Some(left)) || is_record(Some(right)) {
        if !is_record(Some(left)) || !is_record(Some(right)) {
            report_compare_mismatch(typing, left, right);
        }
        return;
    }
    if require_transparent(typing, Some(left), "compared") || require_transparent(typing, Some(right), "compared") {
        return;
    }
    let left_members = union_members(left);
    let right_members = union_members(right);
    if left_members.len() > 1 || right_members.len() > 1 {
        let pairs: Vec<bool> = left_members.iter().flat_map(|l| right_members.iter().map(move |r| members_comparable(l, r))).collect();
        let fits = if overlap { pairs.iter().any(|p| *p) } else { pairs.iter().all(|p| *p) };
        if !fits {
            report_compare_mismatch(typing, left, right);
        }
        return;
    }
    let left_category = comparison_category(left);
    let right_category = comparison_category(right);
    if left_category == ComparisonCategory::Structural || right_category == ComparisonCategory::Structural {
        if !field_type_equals(left, right) {
            report_compare_mismatch(typing, left, right);
        }
        return;
    }
    if left_category != right_category {
        report_compare_mismatch(typing, left, right);
    }
}

fn report_compare_mismatch(typing: &mut Typing, left: &Ty, right: &Ty) {
    typing.report(
        codes::COMPARE_TYPE_MISMATCH,
        format!(
            "Can't compare a {} to a {} — wrap one side in DATE(…), DATETIME(…), or NUMBER(…) to coerce it.",
            describe_field_type(left),
            describe_field_type(right)
        ),
    );
}

fn report_absent_in_comparison(typing: &mut Typing, ty: &Ty) {
    typing.report(
        codes::ABSENT_REQUIRED,
        format!(
            "this side of the ordered comparison may be absent ({}) — it comes from a branch that might not have run, or an answer that might not be there. Ordering needs a value on both sides: fall back to something that always answers ('COALESCE(…, 0)'), gate on it first ('r-[x:…]-> {{ … }}'), or test it with '==' and order inside that branch. (Equality itself is fine on a maybe-absent value — absent is simply never equal.)",
            describe_field_type(ty)
        ),
    );
}

/// `checkWithinDuration`.
fn check_within_duration(typing: &mut Typing, operand: &Expression) {
    let Expression::Static { value } = operand else { return };
    if let StaticValue::String(s) = value
        && is_duration(s)
    {
        return;
    }
    let shown = match value {
        StaticValue::String(s) => serde_json::to_string(s).unwrap_or_default(),
        StaticValue::Number(n) => js_number(n.0),
        StaticValue::Bool(b) => b.to_string(),
        StaticValue::Null => "null".to_string(),
    };
    typing.report(
        codes::COMPARE_TYPE_MISMATCH,
        format!("WITHIN takes a duration literal — a number with a unit, like 30d (days), 12h (hours), or 1w (weeks); got {shown}."),
    );
}

fn is_duration(s: &str) -> bool {
    let Some(unit) = s.chars().last() else { return false };
    let digits = &s[..s.len() - unit.len_utf8()];
    matches!(unit, 'd' | 'h' | 'w') && !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
}

/// `checkEnumLiteralOperand`: a text literal compared to an enum is one of
/// its values.
fn check_enum_literal_operand(typing: &mut Typing, operand: &Expression, operand_ty: Option<&Ty>, other: Option<&Ty>) {
    let Expression::Static { value: StaticValue::String(literal) } = operand else { return };
    if !matches!(operand_ty, Some(Ty::Text)) {
        return;
    }
    let Some(other @ Ty::Enum { .. }) = other else { return };
    if let Some(found) = check_enum_literal(literal, other) {
        report_enum(typing, found);
    }
}

/// `checkNullComparison`.
fn check_null_comparison(typing: &mut Typing, op: FilterOperator, left: &Expression, right: &Expression, l: Option<&Ty>, r: Option<&Ty>) {
    if op != FilterOperator::Eq && op != FilterOperator::Neq {
        typing.report(
            codes::COMPARE_TYPE_MISMATCH,
            format!(
                "'{}' can't be used with null — null is the absence of a value, so only '==' and '!=' say anything about it.",
                describe_filter_op(op)
            ),
        );
        return;
    }
    let eq = op == FilterOperator::Eq;
    for (subject, subject_ty) in [(left, l), (right, r)] {
        if is_null_literal(subject) {
            continue;
        }
        if refuse_text_presence_test(typing, subject, if eq { PresenceAsk::Absent } else { PresenceAsk::Present }) {
            continue;
        }
        let Some(label) = subject_label(subject) else { continue };
        let absent = match subject_ty {
            Some(ty) => Some(is_maybe_absent(Some(ty))),
            None => typing.name_may_be_absent(bare_name(subject).unwrap_or("")),
        };
        if absent != Some(false) {
            continue;
        }
        typing.report_with(
            codes::PRESENCE_TEST_CONSTANT,
            format!(
                "'{label}' always has a value here, so '{label} {} null' is {} — nothing on this path can make it absent.",
                if eq { "==" } else { "!=" },
                if eq { "always false" } else { "always true" }
            ),
            Severity::Info,
        );
    }
}

/// `subjectLabel`: a presence test's subject as the author spelled it.
fn subject_label(expr: &Expression) -> Option<String> {
    if let Some(name) = bare_name(expr) {
        return Some(name.to_string());
    }
    direct_field_read(expr).map(|(root, property)| format!("{root}.{}", quote_name(&property)))
}

/// `reportConstantPresenceTest`.
fn report_constant_presence_test(typing: &mut Typing, name: &str, test: &str, verdict: &str) {
    if typing.name_may_be_absent(name) != Some(false) {
        return;
    }
    typing.report_with(
        codes::PRESENCE_TEST_CONSTANT,
        format!("'{name}' always has a value here, so '{test}' is {verdict} — nothing on this path can make it absent."),
        Severity::Info,
    );
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PresenceAsk {
    Present,
    Absent,
}

/// `refuseTextPresenceTest`: an extracted text is never absent. True when it fired.
fn refuse_text_presence_test(typing: &mut Typing, subject: &Expression, asks: PresenceAsk) -> bool {
    if typing.version < 2 {
        return false;
    }
    let Some((root, property)) = direct_field_read(subject) else { return false };
    let Some(Position::Extract { node, .. }) = typing.root_type(&root) else { return false };
    let Some(declared) = node.properties.get(&property) else { return false };
    if !declared.reads_as_present_text {
        return false;
    }
    let label = format!("{root}.{}", quote_name(&property));
    let (verdict, fix) = match asks {
        PresenceAsk::Present => ("always true", format!("`{label} != \"\"` (or `LENGTH({label}) > 0`)")),
        PresenceAsk::Absent => ("always false", format!("`{label} == \"\"`")),
    };
    typing.report(
        codes::PRESENCE_TEST_ON_TEXT,
        format!(
            "'{label}' is extracted text, and a text the model did not find is \"\" — never absent — so testing it for null is {verdict}. Annotate it `<text | null>` to keep the null test, or test whether it is empty instead: {fix}."
        ),
    );
    true
}

// ── Enums ──

/// What an enum rule reports: a code, a message, and a severity when it is no error.
pub struct EnumDiagnostic {
    pub code: &'static str,
    pub message: String,
    pub severity: Option<Severity>,
}

fn report_enum(typing: &mut Typing, found: EnumDiagnostic) {
    match found.severity {
        Some(severity) => typing.report_with(found.code, found.message, severity),
        None => typing.report(found.code, found.message),
    }
}

/// `checkEnumDomain`: a closed enum with no options accepts nothing.
pub fn check_enum_domain(enum_ty: &Ty, subject: &str) -> Option<EnumDiagnostic> {
    let Ty::Enum { options, open } = enum_ty else { return None };
    if open.is_some() || !options.is_empty() {
        return None;
    }
    Some(EnumDiagnostic {
        code: codes::ENUM_EMPTY_DOMAIN,
        message: format!(
            "{subject} has no values to choose from — the connected system currently offers none, so its option set is empty. No value can satisfy it, which makes this impossible rather than mistaken: it is not a typo, and no spelling would work. Nothing can use this field until an option exists."
        ),
        severity: None,
    })
}

/// `checkEnumLiteral`: a text literal where an enum's value goes is one of its options.
pub fn check_enum_literal(literal: &str, enum_ty: &Ty) -> Option<EnumDiagnostic> {
    if let Some(empty) = check_enum_domain(enum_ty, "This field") {
        return Some(empty);
    }
    let Ty::Enum { options, open } = enum_ty else { return None };
    if options.iter().any(|o| o == literal) {
        return None;
    }
    let did_you_mean = |closest: Option<&str>| closest.map_or(String::new(), |c| format!(" Did you mean \"{c}\"?"));
    if let Some(open) = open {
        if let Some(pattern) = &open.allow_pattern {
            match pattern_matches(pattern, literal) {
                Some(true) => return None,
                Some(false) => {}
                None => return None,
            }
        }
        let closest = closest_by_edit_distance(literal, options);
        let known: Vec<&str> = options.iter().take(20).map(String::as_str).collect();
        return Some(EnumDiagnostic {
            code: codes::VALUE_UNLISTED,
            message: format!(
                "\"{literal}\" isn't among the known values here (the list may be incomplete) — known: {}.{}",
                known.join(" | "),
                did_you_mean(closest)
            ),
            severity: Some(Severity::Warning),
        });
    }
    let closest = closest_by_edit_distance(literal, options);
    Some(EnumDiagnostic {
        code: codes::ENUM_UNKNOWN_VALUE,
        message: format!(
            "\"{literal}\" isn't a value of {} — expected one of: {}.{}",
            describe_field_type(enum_ty),
            options.join(" | "),
            did_you_mean(closest)
        ),
        severity: None,
    })
}

/// `checkAddressPins`: each value an event address pins is one its hop
/// offers — the `action` pin against the event node's own enum, then the hop
/// pins in the order the adapter keys them, each against the options
/// published under the pins before it. A pin nobody can vouch for ends the
/// walk; an error ends it too.
pub fn address_pin_diagnostics(schema: &movement_parser::catalog::types::InstanceSchema, address: &crate::types::event_address::EventAddress) -> Vec<EnumDiagnostic> {
    let pin = |key: &str| address.narrowing.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.clone());
    let mut found = Vec::new();
    let action_type = schema.positions.get(&address.event).and_then(|p| p.properties.get("action")).map(Ty::from_schema);
    if let (Some(action), Some(action_type @ Ty::Enum { .. })) = (pin("action"), action_type)
        && let Some(diagnostic) = check_enum_literal(&action, &action_type)
    {
        let is_error = diagnostic.severity.is_none();
        found.push(diagnostic);
        if is_error {
            return found;
        }
    }
    let (Some(keys), Some(values)) = (&schema.event_narrowing_keys, &schema.event_narrowing_values) else { return found };
    let mut pinned: Vec<(String, String)> = Vec::new();
    for key in keys {
        let Some(value) = pin(key) else { return found };
        let Some(options) = values.get(&crate::types::event_address::narrowing_prefix_key(&pinned)).and_then(|v| v.get(key)) else { return found };
        if let Some(diagnostic) = check_enum_literal(&value, &Ty::Enum { options: options.clone(), open: None }) {
            found.push(diagnostic);
            return found;
        }
        pinned.push((key.clone(), value));
    }
    found
}

const AI_TIERS: [&str; 3] = ["quick", "careful", "thorough"];

/// `aiTierDiagnostics`: a written tier, judged.
pub fn ai_tier_diagnostics(written: Option<&str>) -> Vec<(&'static str, String, Option<Severity>)> {
    let Some(written) = written else { return Vec::new() };
    if AI_TIERS.contains(&written) {
        return Vec::new();
    }
    let tiers = AI_TIERS.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(" | ");
    if written == "smart" {
        let legacy = "careful";
        return vec![(
            codes::AI_TIER_LEGACY,
            format!(
                "\"{written}\" is the old spelling of the \"{legacy}\" tier and still means it — write `\"{legacy}\"` instead, which is the word the tiers are named in ({tiers})."
            ),
            Some(Severity::Info),
        )];
    }
    let candidates: Vec<String> = AI_TIERS.iter().map(|t| t.to_string()).collect();
    let closest = closest_by_edit_distance(written, &candidates);
    vec![(
        codes::ENUM_UNKNOWN_VALUE,
        format!(
            "\"{written}\" isn't a tier — expected one of: {tiers}.{}",
            closest.map_or(String::new(), |c| format!(" Did you mean \"{c}\"?"))
        ),
        None,
    )]
}

// ── Dicts ──

/// A literal key a dict written as a literal does not have (`reportUnknownDictKey`).
pub fn unknown_dict_key(typing: &mut Typing, key: &str, keys: &[String]) {
    let closest = closest_by_edit_distance(key, keys);
    let written = if keys.is_empty() { "no keys at all".to_string() } else { keys.iter().map(|k| format!("\"{k}\"")).collect::<Vec<_>>().join(", ") };
    typing.report(
        codes::DICT_UNKNOWN_KEY,
        format!(
            "this dict has no key \"{key}\" — it was written with: {written}.{}",
            closest.map_or(String::new(), |c| format!(" Did you mean \"{c}\"?"))
        ),
    );
}

/// `requireDictKey`: a dict is keyed by text.
pub fn require_dict_key(typing: &mut Typing, ty: Option<&Ty>, where_: &str) {
    let Some(ty) = ty else { return };
    let key = strip_absent(ty);
    match key {
        Ty::Text | Ty::Enum { .. } => return,
        Ty::Union(members) if members.iter().all(|m| matches!(m, Ty::Text | Ty::Enum { .. })) => return,
        _ => {}
    }
    let repair = if matches!(key, Ty::Date | Ty::Datetime) {
        "write the spelling down — `DATE.FORMAT(d, \"YYYY-MM-DD\")`"
    } else {
        "write it into text — `\"${…}\"`"
    };
    let described = describe_field_type(key);
    typing.report(
        codes::DICT_KEY_NOT_TEXT,
        format!("a dict is keyed by text, and this key is {described} ({where_}). There is no one way to spell {described} as text, so {repair}."),
    );
}

// ── Spreads ──

/// `spreadParts`, the judging half: what `...x` splices into a list must be
/// there and must be several things.
pub fn list_spread(typing: &mut Typing, spread: &Ty) {
    if is_maybe_absent(Some(spread)) {
        typing.report(
            codes::ABSENT_REQUIRED,
            format!(
                "'...' splices a list's members into this list, and what it spreads may be absent ({}, or nothing) — guard it, or spread a list that is always there ('...COALESCE(xs, [])').",
                describe_field_type(strip_absent(spread))
            ),
        );
    }
    let present = strip_absent(spread);
    match present {
        Ty::Tuple { .. } | Ty::List { .. } => {}
        Ty::Union(_) => {
            if collection_element_of(present).is_none() {
                typing.report(
                    codes::LIST_SPREAD_NOT_A_LIST,
                    format!(
                        "'...' splices a list's members into this list, and this is {} — which may be one thing, not several. Spread a list ('[a, ...xs]').",
                        describe_field_type(present)
                    ),
                );
            }
        }
        _ => typing.report(
            codes::LIST_SPREAD_NOT_A_LIST,
            format!(
                "'...' splices a list's members into this list, and this is {} — one thing, not several. Write it as a member ('[a, x]') rather than spreading it, or spread a list ('[a, ...xs]').",
                describe_field_type(present)
            ),
        ),
    }
}

/// `spreadKeys`, the refusal: what `...x` copies into a map has no keys in hand.
pub fn map_spread_not_keyed(typing: &mut Typing, present: &Ty) {
    let message = if matches!(present, Ty::Record(_)) {
        "'...' copies a record's fields into this map, and this record's fields are read from its system one at a time — the program doesn't hold them. Write the fields you want ('{ name: r.name, … }')".to_string()
    } else {
        format!(
            "'...' copies a map's keys (or a record's fields) into this map, and this is {} — it has no keys. Write it under a key ('{{ k: x }}'), or spread a map or a record",
            describe_field_type(present)
        )
    };
    typing.report(codes::MAP_SPREAD_NOT_KEYED, message);
}

/// `{ k: v, ...m }` where `m` always has `k`.
pub fn map_key_overwritten(typing: &mut Typing, key: &str) {
    typing.report(
        codes::MAP_KEY_OVERWRITTEN,
        format!("'{key}' is written before a spread that always has '{key}', so the spread overwrites it — move '{key}: …' after the spread to override it, or drop it"),
    );
}

// ── Order ──

#[derive(Clone, Copy)]
enum Fold {
    At,
    Aggregate(AggregationFunction),
}

/// `checkFoldOrder`: an order-sensitive fold over a collection whose order means nothing.
fn check_fold_order(typing: &mut Typing, fold: Fold, argument: &Expression, position: Option<&Position>) {
    let (spelling, which) = match fold {
        Fold::At => ("AT", "at"),
        Fold::Aggregate(AggregationFunction::First) => ("FIRST", "first"),
        Fold::Aggregate(AggregationFunction::Last) => ("LAST", "last"),
        Fold::Aggregate(AggregationFunction::Join) => ("JOIN", "join"),
        Fold::Aggregate(_) => return,
    };
    let (order, subject) = collection_ordering(typing, argument, position);
    if order != CollectionOrder::Unordered {
        return;
    }
    let named = subject.as_ref().map_or("this collection".to_string(), |s| format!("'{s}'"));
    let order_by_fix = match &subject {
        Some(subject) if matches!(argument, Expression::Traverse { .. }) => format!(
            " Order the hop (`-[:{subject} ORDER BY `…` DESC]->`), or reach for a relationship the source keeps in order."
        ),
        _ => " Order the traversal it came from, or reach for a relationship the source keeps in order.".to_string(),
    };
    let meaning = match which {
        "join" => format!("{spelling} writes the values out in the order they come in, and {named} comes back in no particular order — the same line would read differently run to run."),
        "at" => format!("{spelling} reads a position in a sequence, and {named} comes back in no particular order — every index picks an arbitrary member."),
        _ => {
            let end = if which == "last" { "last" } else { "first" };
            format!("{spelling} takes the {end} of a sequence, and {named} comes back in no particular order — so there is no {end}.")
        }
    };
    let only_fix = if matches!(which, "first" | "last") {
        " If you mean the one that matched, write ONLY(…) — it answers that one and fails the run if there turns out to be more than one."
    } else {
        ""
    };
    typing.report(codes::FOLD_NEEDS_ORDER, format!("{meaning}{only_fix}{order_by_fix}"));
}

/// `collectionOrdering`: the order a collection comes back in, and what to call it.
pub fn collection_ordering(typing: &Typing, expr: &Expression, position: Option<&Position>) -> (CollectionOrder, Option<String>) {
    match expr {
        Expression::Traverse { .. } => match typing.walk_ordering_of(expr) {
            Some((order, edge)) => (*order, edge.clone()),
            None => (CollectionOrder::Unknown, None),
        },
        Expression::List { .. } => (CollectionOrder::Ordered, None),
        Expression::Aggregate { fn_: AggregationFunction::Sort, .. } => (CollectionOrder::Ordered, None),
        Expression::Aggregate { fn_: AggregationFunction::Collect, expression, .. } => collection_ordering(typing, expression, position),
        Expression::Property { property_type_id: name } | Expression::EdgeProperty { property_type_id: name } | Expression::AliasRef { name } => {
            let ty = position.and_then(|p| lookup_property_type(Some(p), name)).or_else(|| typing.scalar_type(name));
            (collection_order_of(ty.as_ref()), Some(name.clone()))
        }
        _ => (CollectionOrder::Unknown, None),
    }
}

/// `checkOrderingKey`: one value per element, read from the element alone.
pub fn ordering_key(typing: &mut Typing, key: &Expression, key_ty: Option<&Ty>, site: &str) {
    if let Some(call) = impure_key_call(key) {
        typing.report(
            codes::ORDER_KEY_IMPURE,
            format!("{site} reads this key once per record and compares the answers, so it has to be a function of the record — {call} isn't. Read a field, or a short path to one."),
        );
        return;
    }
    if key_ty.is_some_and(|t| collection_element_of(t).is_some()) {
        typing.report(
            codes::ORDER_KEY_MULTI,
            format!("{site} needs one value per record to rank it by, and this key answers with several. Fold it to one (MIN(…), MAX(…), FIRST(…)), or key on a single-valued field."),
        );
    }
}

/// `impureKeyCall`: the call inside a key that is no function of the element.
fn impure_key_call(expr: &Expression) -> Option<&'static str> {
    match expr {
        Expression::Llm { .. } => Some("AI(…)"),
        Expression::ExtractValue { .. } => Some("EXTRACT_VALUE(…)"),
        Expression::KgExists { .. } => Some("KG_EXISTS(…)"),
        Expression::KgValue { .. } => Some("KG_VALUE(…)"),
        other => sub_expressions(other).into_iter().find_map(impure_key_call),
    }
}

/// `subExpressions`: every expression written inside one.
fn sub_expressions(expr: &Expression) -> Vec<&Expression> {
    use movement_parser::lowering::expression::{ListElement, ObjectMember, TraversalStep};
    match expr {
        Expression::Traverse { steps, expression, .. } => {
            let mut out = vec![&**expression];
            out.extend(steps.iter().filter_map(|s| match s {
                TraversalStep::Edge(edge) => edge.expression_filter.as_deref(),
                _ => None,
            }));
            out
        }
        Expression::ResourceTraverse { expression_filter, expression, .. } => match expression_filter {
            Some(filter) => vec![&**filter, &**expression],
            None => vec![&**expression],
        },
        Expression::Aggregate { expression, order_by, .. } => match order_by {
            Some(key) => vec![&**expression, &**key],
            None => vec![&**expression],
        },
        Expression::Not { expression } | Expression::Negate { expression } => vec![&**expression],
        Expression::At { expression, index } => vec![&**expression, &**index],
        Expression::Arithmetic { left, right, .. } | Expression::Compare { left, right, .. } => vec![&**left, &**right],
        Expression::Logical { operands, .. } => operands.iter().collect(),
        Expression::Concat { parts } => parts.iter().collect(),
        Expression::Conditional { condition, then, else_ } => vec![&**condition, &**then, &**else_],
        Expression::Function { args, .. } => args.iter().collect(),
        Expression::Exists { where_, .. } => where_.as_deref().into_iter().collect(),
        Expression::List { elements } => elements
            .iter()
            .map(|e| match e {
                ListElement::Expression(e) => e,
                ListElement::Spread(s) => &s.expression,
            })
            .collect(),
        Expression::Object { entries } => entries
            .iter()
            .map(|e| match e {
                ObjectMember::Entry { value, .. } => value,
                ObjectMember::Spread(s) => &s.expression,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `inferSort`, the judging half.
fn check_sort(typing: &mut Typing, argument: &Expression, order_by: Option<&Expression>, inner: Option<&Ty>, position: Option<&Position>) {
    let members = sort_element_position(typing, argument, position);
    let element = inner.map(unwrap_list);
    if is_bare_walk(argument) {
        typing.report(
            codes::SORT_KEY_ON_WALK,
            "SORT reads a key off each record, and a walk written inside the call hands its records over without the graph they came from. Bind the walk first — `entries = … { return … }` — then SORT the name.",
        );
    } else if order_by.is_none() && (members.is_some() || element.as_ref().is_some_and(is_keyed_value)) {
        typing.report(
            codes::SORT_NEEDS_KEY,
            format!(
                "SORT is ordering {}, and one of those has no order of its own — say what to rank them by: SORT(…, `Added At`, DESC).",
                if members.is_some() { "records" } else { "values with named parts" }
            ),
        );
    } else if let Some(order_by) = order_by {
        if members.is_none() && element.as_ref().is_some_and(is_plain_value) {
            typing.report(
                codes::SORT_KEY_ON_SCALAR,
                "SORT reads this key off each member, and these members are plain values — there is nothing to read it from. Order them by themselves: SORT(…) or SORT(…, DESC).",
            );
        } else {
            let key_ty = typing.infer_at(order_by, members.as_ref());
            ordering_key(typing, order_by, key_ty.as_ref(), "SORT");
        }
    } else if members.is_none()
        && let Some(inner) = inner
        && collection_element_of(inner).is_none()
        && !matches!(argument, Expression::Traverse { steps, .. } if !steps.is_empty())
        && is_plain_value(inner)
    {
        typing.report(codes::SORT_NOT_COLLECTION, "SORT orders a collection, and this is one value — there is nothing to put in order.");
    }
}

/// `sortElementPosition`: where a `SORT`'s members stand, when they are records.
fn sort_element_position(typing: &Typing, argument: &Expression, position: Option<&Position>) -> Option<Position> {
    match argument {
        Expression::Traverse { steps, .. } => {
            if steps.is_empty() {
                None
            } else {
                typing.walk_destination_of(argument).cloned()
            }
        }
        Expression::Property { property_type_id } if position.is_none() => typing.root_type(property_type_id),
        Expression::AliasRef { name } => typing.root_type(name),
        _ => None,
    }
}

/// `isBareWalk`: a walk read for its landings.
fn is_bare_walk(expr: &Expression) -> bool {
    matches!(expr, Expression::Traverse { steps, expression, .. }
        if !steps.is_empty() && matches!(&**expression, Expression::Property { property_type_id } if property_type_id == POSITION_SENTINEL))
}

/// `isKeyedValue`: a value read by name — a dict, a record.
fn is_keyed_value(ty: &Ty) -> bool {
    match strip_absent(ty) {
        Ty::Dict { .. } | Ty::Record(_) => true,
        Ty::Union(members) => members.iter().all(is_keyed_value),
        _ => false,
    }
}

/// `isPlainValue`: no fields to key on, an order of its own.
fn is_plain_value(ty: &Ty) -> bool {
    match strip_absent(ty) {
        Ty::Text | Ty::Number | Ty::Boolean | Ty::Date | Ty::Datetime | Ty::Enum { .. } => true,
        Ty::Union(members) => members.iter().all(is_plain_value),
        _ => false,
    }
}

// ── Spelling ──

/// `quoteName`: a name as source text, backticked (and escaped) when it is not bare.
pub fn quote_name(name: &str) -> String {
    let mut chars = name.chars();
    let bare = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if bare {
        return name.to_string();
    }
    let escaped: String = name.chars().flat_map(|c| if c == '\\' || c == '`' { vec!['\\', c] } else { vec![c] }).collect();
    format!("`{escaped}`")
}

/// `closestByEditDistance`: the did-you-mean, measured in UTF-16 units as
/// JavaScript measures a string.
pub fn closest_by_edit_distance<'a>(value: &str, candidates: &'a [String]) -> Option<&'a str> {
    let units: Vec<u16> = value.encode_utf16().collect();
    let mut best: Option<(&str, usize, usize)> = None;
    for candidate in candidates {
        let other: Vec<u16> = candidate.encode_utf16().collect();
        let distance = edit_distance(&units, &other);
        if best.is_none_or(|(_, d, _)| distance < d) {
            best = Some((candidate, distance, other.len()));
        }
    }
    let (best, distance, best_len) = best?;
    let threshold = 2.max(units.len().max(best_len) / 3);
    if distance <= threshold || value.contains(best) || best.contains(value) {
        return Some(best);
    }
    None
}

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

// ── Allow patterns ──

/// One element of an id pattern: a set of characters and how often it repeats.
struct Atom {
    chars: Vec<(char, char)>,
    negated: bool,
    any: bool,
    min: usize,
    max: usize,
}

/// `new RegExp(pattern).test(text)` for the patterns an adapter writes for
/// id-shaped values: anchors, literals, `.`, character classes with ranges,
/// and the quantifiers `? * + {n} {n,} {n,m}`. `None` for anything beyond
/// that, which the TypeScript's unparseable pattern also answers with silence.
fn pattern_matches(pattern: &str, text: &str) -> Option<bool> {
    let p: Vec<char> = pattern.chars().collect();
    let (mut i, mut anchored_start, mut anchored_end) = (0, false, false);
    if p.first() == Some(&'^') {
        anchored_start = true;
        i = 1;
    }
    let mut end = p.len();
    if end > i && p[end - 1] == '$' && (end < 2 || p[end - 2] != '\\') {
        anchored_end = true;
        end -= 1;
    }
    let mut atoms: Vec<Atom> = Vec::new();
    while i < end {
        let mut atom = match p[i] {
            '[' => {
                let mut j = i + 1;
                let negated = p.get(j) == Some(&'^');
                if negated {
                    j += 1;
                }
                let mut chars = Vec::new();
                while j < end && p[j] != ']' {
                    let mut c = p[j];
                    if c == '\\' {
                        j += 1;
                        c = *p.get(j)?;
                        if c.is_ascii_alphanumeric() {
                            return None;
                        }
                    }
                    if p.get(j + 1) == Some(&'-') && p.get(j + 2).is_some_and(|n| *n != ']') {
                        chars.push((c, p[j + 2]));
                        j += 3;
                    } else {
                        chars.push((c, c));
                        j += 1;
                    }
                }
                if j >= end {
                    return None;
                }
                i = j + 1;
                Atom { chars, negated, any: false, min: 1, max: 1 }
            }
            '.' => {
                i += 1;
                Atom { chars: Vec::new(), negated: false, any: true, min: 1, max: 1 }
            }
            '\\' => {
                let c = *p.get(i + 1)?;
                if c.is_ascii_alphanumeric() {
                    return None;
                }
                i += 2;
                Atom { chars: vec![(c, c)], negated: false, any: false, min: 1, max: 1 }
            }
            '(' | ')' | '|' | '*' | '+' | '?' | '{' | '^' | '$' => return None,
            c => {
                i += 1;
                Atom { chars: vec![(c, c)], negated: false, any: false, min: 1, max: 1 }
            }
        };
        match p.get(i).filter(|_| i < end) {
            Some('?') => (atom.min, atom.max, i) = (0, 1, i + 1),
            Some('*') => (atom.min, atom.max, i) = (0, usize::MAX, i + 1),
            Some('+') => (atom.min, atom.max, i) = (1, usize::MAX, i + 1),
            Some('{') => {
                let close = (i..end).find(|k| p[*k] == '}')?;
                let inner: String = p[i + 1..close].iter().collect();
                let (lo, hi) = match inner.split_once(',') {
                    None => {
                        let n = inner.parse().ok()?;
                        (n, n)
                    }
                    Some((lo, "")) => (lo.parse().ok()?, usize::MAX),
                    Some((lo, hi)) => (lo.parse().ok()?, hi.parse().ok()?),
                };
                (atom.min, atom.max, i) = (lo, hi, close + 1);
            }
            _ => {}
        }
        atoms.push(atom);
    }
    let t: Vec<char> = text.chars().collect();
    fn accepts(atom: &Atom, c: char) -> bool {
        if atom.any {
            return c != '\n';
        }
        atom.chars.iter().any(|(lo, hi)| *lo <= c && c <= *hi) != atom.negated
    }
    fn matches_at(atoms: &[Atom], t: &[char], at: usize, anchored_end: bool) -> bool {
        let Some((atom, rest)) = atoms.split_first() else { return !anchored_end || at == t.len() };
        let mut count = 0;
        while count < atom.min {
            if at + count >= t.len() || !accepts(atom, t[at + count]) {
                return false;
            }
            count += 1;
        }
        let mut most = count;
        while most < atom.max && at + most < t.len() && accepts(atom, t[at + most]) {
            most += 1;
        }
        (count..=most).rev().any(|n| matches_at(rest, t, at + n, anchored_end))
    }
    let starts: Vec<usize> = if anchored_start { vec![0] } else { (0..=t.len()).collect() };
    Some(starts.into_iter().any(|start| matches_at(&atoms, &t, start, anchored_end)))
}

// ── Event addresses ──

impl crate::checker::Checker<'_> {
    /// `checkAddressPins` for the address `hops` off the instance `graph` names.
    pub fn check_address_pins(&mut self, graph: &str, hops: &str, span: movement_parser::ast::Span, scope: crate::scope::ScopeId) {
        let crate::scope::Resolution::Found(id) = self.scopes.resolve(scope, graph) else { return };
        let schema = match &self.scopes.symbol(id).types.pos {
            Some(Position::Meta { instance }) => instance.schema.clone(),
            _ => return,
        };
        let Some(address) = crate::types::event_address::event_address_of_hops(hops) else { return };
        for found in address_pin_diagnostics(&schema, &address) {
            let mut diagnostic = crate::diagnostic::Diagnostic::error(found.code, found.message, span);
            diagnostic.severity = found.severity;
            self.push(diagnostic);
        }
    }
}

// ── Required records ──

impl crate::checker::Checker<'_> {
    /// `reportAbsentEdgeEnd` (version 4): an end of a link or unlink that may
    /// not be there; only the first such end is reported.
    pub fn report_absent_edge_end(&mut self, verb: &str, from: &str, edge: &str, to: Option<&str>, span: movement_parser::ast::Span, scope: crate::scope::ScopeId) {
        if self.version < 4 {
            return;
        }
        for name in std::iter::once(from).chain(to) {
            let pos = match self.scopes.resolve(scope, name) {
                crate::scope::Resolution::Found(id) => self.scopes.symbol(id).types.pos.clone(),
                _ => None,
            };
            let Some(Position::MaybeEmpty(of)) = pos else { continue };
            self.report(
                codes::ABSENT_REQUIRED,
                format!(
                    "'{name}' is {} that may not be there, so this {verb} can't be guaranteed to happen — and nothing in this statement says it might be skipped. Test it first: 'if {name} != null {{ {verb} {from} -[:{edge}]-> {} }}'.",
                    crate::types::position::describe_position(&of),
                    to.unwrap_or("…")
                ),
                span,
            );
            return;
        }
    }
}

/// What a write field's absence rule needs of the write around it: the
/// writes family resolves the target, this family judges the value.
pub struct WriteFieldAbsence<'a> {
    pub field: &'a movement_parser::ast::FieldEntry,
    /// The spread the field was written by (`...v`), when it was.
    pub spread: Option<&'a str>,
    /// The field's declared type on the target (`root.fields[name]`), when known.
    pub target_type: Option<&'a Ty>,
    /// The field's value as its slot typed it.
    pub value_type: Option<&'a Ty>,
    /// `graph.type`, or the target as the write describes it.
    pub root_description: &'a str,
    /// An update, or a field the target does not require on create.
    pub may_leave_unset: bool,
    /// The field is part of the write's `unique by` identity.
    pub identifies: bool,
}

/// `checkWrite`'s require-present rule for one field: a value that may be
/// absent can't fill a plain field (`?:` is its home), unless the field itself
/// may be absent. `None` when the field takes the value.
pub fn write_field_absence(input: WriteFieldAbsence) -> Option<crate::diagnostic::Diagnostic> {
    let value_type = input.value_type.filter(|t| is_maybe_absent(Some(t)))?;
    if matches!(input.field.semantics, Some(movement_parser::ast::FieldWriteMode::Fill)) || is_maybe_absent(input.target_type) {
        return None;
    }
    let field = input.field;
    let span = field.value.span;
    let described = describe_field_type(value_type);
    if let Some(spread) = input.spread {
        return Some(crate::diagnostic::Diagnostic::error(
            codes::ABSENT_REQUIRED,
            format!(
                "'{}' on {} needs a value, but '...{spread}' writes '{spread}.{}', which may be absent ({described}). Spread it set-if-empty ('?...{spread}'), or write '{}' on its own line with a value that is always there",
                field.name, input.root_description, field.name, field.name
            ),
            span,
        ));
    }
    let raw = field.value.raw.trim();
    let label = crate::families::names::spell_name(&field.name);
    let lead = format!("'{}' on {} needs a value, but '{raw}' may be absent ({described})", field.name, input.root_description);
    if input.identifies {
        return Some(crate::diagnostic::Diagnostic::error(
            codes::ABSENT_REQUIRED,
            format!("{lead}, and it identifies the record, so a fallback would merge every record written without it into one — write only when it is there: put the write inside 'if {raw} != null {{ … }}'"),
            span,
        ));
    }
    let unset = input.may_leave_unset.then(|| format!("'{label} ?: {raw}' to leave it unset when absent"));
    let Some(fallback) = fallback_literal(strip_absent(value_type)) else {
        let lead_in = match &unset {
            Some(unset) => format!("Write {unset}, or"),
            None => "Either".to_string(),
        };
        return Some(crate::diagnostic::Diagnostic::error(
            codes::ABSENT_REQUIRED,
            format!("{lead} — it comes from a branch that might not have run, or an answer that might not be there. {lead_in} test it with '==' and write inside that branch, or gate on it first ('r-[x:…]-> {{ write … }}')"),
            span,
        ));
    };
    let coalesced = format!("COALESCE({raw}, {fallback})");
    let mut diagnostic = crate::diagnostic::Diagnostic::error(
        codes::ABSENT_REQUIRED,
        format!(
            "{lead} — write '{label}: {coalesced}' to fall back to a value that is always there{}",
            unset.map_or(String::new(), |u| format!(", or {u}"))
        ),
        span,
    );
    diagnostic.fix = Some(serde_json::json!({ "edits": [{ "span": span, "text": coalesced }] }));
    Some(diagnostic)
}

/// `fallbackLiteral`: a value of this type that is always there.
fn fallback_literal(ty: &Ty) -> Option<&'static str> {
    match ty {
        Ty::Text => Some("\"unknown\""),
        Ty::Number => Some("0"),
        Ty::Boolean => Some("false"),
        Ty::List { .. } => Some("[]"),
        _ => None,
    }
}
