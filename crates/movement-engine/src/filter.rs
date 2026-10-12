//! The shared predicate unit (packages/shared/expression/filter.ts):
//! `compareValues`, `compareToNull` and `evaluatePredicate`, the scalar
//! comparison semantics the engine and adapters decide filters by.

use std::future::Future;
use std::pin::Pin;

use movement_parser::lowering::expression::{ArithmeticOp, Expression, FilterOperator, ListElement, LogicalOp};

use crate::eval::{EvalError, static_value};
use crate::executor::ready;
use crate::js::{self, Js};
use crate::js_date::{self, LocalZone};

/// `x == null` / `x != null`: the one loose comparison — absent and null
/// both answer it. Any other operator against null is false.
pub fn compare_to_null(op: FilterOperator, value: &Js) -> bool {
    match op {
        FilterOperator::Eq => value.is_nullish(),
        FilterOperator::Neq => !value.is_nullish(),
        _ => false,
    }
}

/// `compareValues`, a date text read in `local` (the run's zone, as V8 reads
/// one in its process's). `within` reads the wall clock, which this unit
/// does not have: it is answered by TypeScript.
pub fn compare_values(left: &Js, op: FilterOperator, right: &Js, local: LocalZone<'_>) -> Result<bool, EvalError> {
    Ok(match op {
        FilterOperator::Eq => match (left, right) {
            (Js::Array(a), Js::Array(b)) => set_equals(&a.items(), &b.items()),
            _ => js::strict_equals(left, right),
        },
        FilterOperator::Neq => match (left, right) {
            (Js::Array(a), Js::Array(b)) => !set_equals(&a.items(), &b.items()),
            _ => !js::strict_equals(left, right),
        },
        FilterOperator::Gt => relational_order(left, right, local).is_some_and(|c| c > 0.0),
        FilterOperator::Gte => relational_order(left, right, local).is_some_and(|c| c >= 0.0),
        FilterOperator::Lt => relational_order(left, right, local).is_some_and(|c| c < 0.0),
        FilterOperator::Lte => relational_order(left, right, local).is_some_and(|c| c <= 0.0),
        FilterOperator::Exists => !left.is_nullish(),
        FilterOperator::In => match right {
            Js::Array(list) => list.items().iter().any(|item| js::same_value_zero(item, left)),
            _ => false,
        },
        FilterOperator::Contains => match (left, right) {
            (Js::String(l), Js::String(r)) => crate::js_string::includes(l.as_form(), r.as_form()),
            (Js::Array(list), _) => list.items().iter().any(|item| js::same_value_zero(item, right)),
            _ => false,
        },
        FilterOperator::Within => return Err(EvalError::Fallback("WITHIN reads the wall clock".into())),
    })
}

/// Order-insensitive equality of two lists as sets (SameValueZero members).
fn set_equals(a: &[Js], b: &[Js]) -> bool {
    if a.is_empty() && b.is_empty() {
        return true;
    }
    let distinct = |items: &[Js]| {
        let mut seen: Vec<&Js> = Vec::new();
        for item in items {
            if !seen.iter().any(|s| js::same_value_zero(s, item)) {
                seen.push(item);
            }
        }
        seen.len()
    };
    if distinct(a) != distinct(b) {
        return false;
    }
    a.iter().all(|v| b.iter().any(|w| js::same_value_zero(v, w)))
}

/// A finite number, or a numeric text: what orders numerically.
fn to_finite_number(value: &Js) -> Option<f64> {
    match value {
        Js::Number(n) => n.is_finite().then_some(*n),
        Js::String(s) if !js::trim(s.as_form()).is_empty() => Some(js::string_to_number(s.as_form())).filter(|n| n.is_finite()),
        _ => None,
    }
}

/// `toEpochMs`: `new Date(value).getTime()` for what is not a number, a
/// finite number as itself; `None` for NaN.
fn to_epoch_ms(value: &Js, local: LocalZone<'_>) -> Option<f64> {
    match value {
        Js::Undefined | Js::Null => None,
        Js::Number(n) => n.is_finite().then_some(*n),
        // `new Date(true)` is the instant 1 ms after the epoch.
        Js::Bool(b) => Some(f64::from(u8::from(*b))),
        // An object or a list is read as its `String()`.
        other => js_date::parse(&other.to_js_string(), local),
    }
}

/// `relationalOrder`: numerically when both are numbers (or numeric
/// texts), else chronologically when both read as dates, else as text when
/// both are texts; `None` when the two do not order.
fn relational_order(left: &Js, right: &Js, local: LocalZone<'_>) -> Option<f64> {
    if let (Some(l), Some(r)) = (to_finite_number(left), to_finite_number(right)) {
        return Some(js::math_sign(l - r));
    }
    if let (Some(l), Some(r)) = (to_epoch_ms(left, local), to_epoch_ms(right, local)) {
        return Some(js::math_sign(l - r));
    }
    match (left, right) {
        (Js::String(l), Js::String(r)) => Some(match js::utf16_cmp(l.as_form(), r.as_form()) {
            std::cmp::Ordering::Less => -1.0,
            std::cmp::Ordering::Equal => 0.0,
            std::cmp::Ordering::Greater => 1.0,
        }),
        _ => None,
    }
}

/// `isNullLiteral`: the `null` literal as written.
pub fn is_null_literal(expr: &Expression) -> bool {
    matches!(expr, Expression::Static { value: movement_parser::lowering::expression::StaticValue::Null })
}

/// `evaluatePredicate`: a pure predicate over leaf names `read` answers
/// (absent for a name it does not know), a date text read in `local`. The
/// engine evaluates through `eval`, whose semantics this mirrors; adapters
/// filter through this.
pub fn evaluate_predicate(expr: &Expression, read: &dyn Fn(&str) -> Js, local: LocalZone<'_>) -> Result<Js, EvalError> {
    ready(evaluate_predicate_with(expr, read, PredicateOptions { ask: None, local }))
}

/// A comparison `compare_values` handed back, being answered by the host.
pub type Comparing<'p> = Pin<Box<dyn Future<Output = Result<bool, EvalError>> + 'p>>;

/// What answers a comparison `compare_values` hands back.
pub type AskCompare<'p> = dyn Fn(FilterOperator, Js, Js) -> Comparing<'p> + 'p;

/// What a predicate's comparisons read beyond their operands: what answers
/// one `compare_values` hands back (`WITHIN`, which reads the wall clock),
/// where given — a run asks the TypeScript member, and the walk resumes
/// where it asked — and the zone a date text is read in.
#[derive(Clone, Copy)]
pub struct PredicateOptions<'p> {
    pub ask: Option<&'p AskCompare<'p>>,
    pub local: LocalZone<'p>,
}

/// `evaluatePredicate`, its comparisons as `options` say.
pub fn evaluate_predicate_with<'p>(
    expr: &'p Expression,
    read: &'p dyn Fn(&str) -> Js,
    options: PredicateOptions<'p>,
) -> Pin<Box<dyn Future<Output = Result<Js, EvalError>> + 'p>> {
    Box::pin(async move { predicate_in_place(expr, read, options).await })
}

async fn predicate_in_place<'p>(expr: &'p Expression, read: &'p dyn Fn(&str) -> Js, options: PredicateOptions<'p>) -> Result<Js, EvalError> {
    let eval = |e: &'p Expression| evaluate_predicate_with(e, read, options);
    Ok(match expr {
        Expression::Static { value } => static_value(value),
        Expression::Property { property_type_id } | Expression::EdgeProperty { property_type_id } => read(property_type_id),
        Expression::AliasRef { name } => read(name),
        Expression::Meta { key } => read(&format!("@{key}")),
        // A zero-step walk (`t.\`field\``) is a leaf the caller read
        // already, under its `t.field` key.
        Expression::Traverse { steps, .. } if steps.is_empty() => read(&leaf_read_key(expr)),
        Expression::List { elements } => {
            let mut items = Vec::new();
            for element in elements {
                match element {
                    ListElement::Expression(e) => items.push(eval(e).await?),
                    ListElement::Spread(spread) => match eval(&spread.expression).await? {
                        Js::Array(list) => items.extend(list.items().iter().cloned()),
                        other => {
                            let what = if other.is_nullish() { "null" } else { other.type_of() };
                            return Err(EvalError::error(format!("'...' spreads a list into a list, and this value is {what}")));
                        }
                    },
                }
            }
            Js::array(items)
        }
        Expression::Concat { parts } => {
            let mut text = String::new();
            for part in parts {
                let v = eval(part).await?;
                if !v.is_nullish() {
                    text.push_str(&v.to_js_string());
                }
            }
            Js::str(text)
        }
        Expression::Conditional { condition, then, else_ } => {
            if eval(condition).await?.truthy() { eval(then).await? } else { eval(else_).await? }
        }
        Expression::Compare { op, left, right } => {
            // Both sides are read first, as the TypeScript does.
            let l = eval(left).await?;
            let r = eval(right).await?;
            Js::Bool(if is_null_literal(left) {
                compare_to_null(*op, &r)
            } else if is_null_literal(right) {
                compare_to_null(*op, &l)
            } else {
                match (compare_values(&l, *op, &r, options.local), options.ask) {
                    (Err(EvalError::Fallback(_)), Some(ask)) => ask(*op, l, r).await?,
                    (other, _) => other?,
                }
            })
        }
        Expression::Logical { op, operands } => {
            let wanted = matches!(op, LogicalOp::Or);
            for operand in operands {
                if eval(operand).await?.truthy() == wanted {
                    return Ok(Js::Bool(wanted));
                }
            }
            Js::Bool(!wanted)
        }
        Expression::Not { expression } => Js::Bool(!eval(expression).await?.truthy()),
        Expression::Negate { expression } => Js::Number(-eval(expression).await?.to_number()),
        Expression::Arithmetic { op, left, right } => {
            let l = eval(left).await?.to_number();
            let r = eval(right).await?.to_number();
            arithmetic(*op, l, r)
        }
        Expression::At { expression, index } => {
            let value = eval(expression).await?;
            let index = eval(index).await?.to_number();
            at_index(&value, index)
        }
        _ => return Err(EvalError::Fallback("not a pure predicate kind this unit evaluates".into())),
    })
}

/// `isPurePredicate` then `pureLeafReads`: the leaf read nodes a pure
/// predicate references, in traversal order (callers dedupe by
/// `leaf_read_key`); `None` for one that is not pure.
pub fn pure_leaf_reads(expr: &Expression) -> Option<Vec<&Expression>> {
    let mut leaves = Vec::new();
    leaf_reads(expr, &mut leaves).then_some(leaves)
}

fn leaf_reads<'e>(expr: &'e Expression, into: &mut Vec<&'e Expression>) -> bool {
    fn all<'e>(items: &'e [Expression], into: &mut Vec<&'e Expression>) -> bool {
        items.iter().all(|e| leaf_reads(e, into))
    }
    match expr {
        Expression::Static { .. } => true,
        Expression::Property { .. } | Expression::EdgeProperty { .. } | Expression::AliasRef { .. } | Expression::Meta { .. } => {
            into.push(expr);
            true
        }
        Expression::Traverse { steps, expression, .. } if steps.is_empty() => {
            if !matches!(expression.as_ref(), Expression::Property { .. } | Expression::EdgeProperty { .. } | Expression::AliasRef { .. }) {
                return false;
            }
            into.push(expr);
            true
        }
        Expression::List { elements } => elements.iter().all(|e| match e {
            ListElement::Expression(e) => leaf_reads(e, into),
            ListElement::Spread(spread) => leaf_reads(&spread.expression, into),
        }),
        Expression::Concat { parts } => all(parts, into),
        Expression::Conditional { condition, then, else_ } => {
            leaf_reads(condition, into) && leaf_reads(then, into) && leaf_reads(else_, into)
        }
        Expression::Compare { left, right, .. } | Expression::Arithmetic { left, right, .. } => leaf_reads(left, into) && leaf_reads(right, into),
        Expression::Logical { operands, .. } => all(operands, into),
        Expression::Not { expression } | Expression::Negate { expression } => leaf_reads(expression, into),
        Expression::At { expression, index } => leaf_reads(expression, into) && leaf_reads(index, into),
        _ => false,
    }
}

/// `leafReadKey`: the name a pure leaf read is resolved under and read back
/// by (`t.field` for a zero-step traversal, `@key` for an ambient).
pub fn leaf_read_key(leaf: &Expression) -> String {
    match leaf {
        Expression::AliasRef { name } => name.clone(),
        Expression::Property { property_type_id } | Expression::EdgeProperty { property_type_id } => property_type_id.clone(),
        Expression::Meta { key } => format!("@{key}"),
        Expression::Traverse { alias_root, expression, .. } => {
            let inner = match expression.as_ref() {
                Expression::Property { property_type_id } | Expression::EdgeProperty { property_type_id } => property_type_id.clone(),
                Expression::AliasRef { name } => name.clone(),
                Expression::Traverse { .. } => leaf_read_key(expression),
                _ => String::new(),
            };
            format!("{}.{inner}", alias_root.as_deref().unwrap_or(""))
        }
        _ => String::new(),
    }
}

/// `isPurePredicate` then `pureLeafReads(…).map(leafReadKey)`: the names a
/// pure predicate reads, in traversal order; `None` for one that is not pure.
pub fn pure_leaf_keys(expr: &Expression) -> Option<Vec<String>> {
    let mut keys = Vec::new();
    leaf_keys(expr, &mut keys).then_some(keys)
}

fn leaf_keys(expr: &Expression, into: &mut Vec<String>) -> bool {
    fn all(items: &[Expression], into: &mut Vec<String>) -> bool {
        items.iter().all(|e| leaf_keys(e, into))
    }
    match expr {
        Expression::Static { .. } => true,
        Expression::Property { property_type_id } | Expression::EdgeProperty { property_type_id } => {
            into.push(property_type_id.clone());
            true
        }
        Expression::AliasRef { name } => {
            into.push(name.clone());
            true
        }
        Expression::Meta { key } => {
            into.push(format!("@{key}"));
            true
        }
        Expression::Traverse { alias_root, steps, expression } if steps.is_empty() => {
            let inner = match expression.as_ref() {
                Expression::Property { property_type_id } | Expression::EdgeProperty { property_type_id } => property_type_id.clone(),
                Expression::AliasRef { name } => name.clone(),
                _ => return false,
            };
            into.push(format!("{}.{inner}", alias_root.as_deref().unwrap_or("")));
            true
        }
        Expression::List { elements } => elements.iter().all(|e| match e {
            ListElement::Expression(e) => leaf_keys(e, into),
            ListElement::Spread(spread) => leaf_keys(&spread.expression, into),
        }),
        Expression::Concat { parts } => all(parts, into),
        Expression::Conditional { condition, then, else_ } => {
            leaf_keys(condition, into) && leaf_keys(then, into) && leaf_keys(else_, into)
        }
        Expression::Compare { left, right, .. } | Expression::Arithmetic { left, right, .. } => leaf_keys(left, into) && leaf_keys(right, into),
        Expression::Logical { operands, .. } => all(operands, into),
        Expression::Not { expression } | Expression::Negate { expression } => leaf_keys(expression, into),
        Expression::At { expression, index } => leaf_keys(expression, into) && leaf_keys(index, into),
        _ => false,
    }
}

/// `l op r` on two numbers: `/` and `%` by zero are null, and `%` keeps the
/// dividend's sign (as Rust's `%` does).
pub fn arithmetic(op: ArithmeticOp, l: f64, r: f64) -> Js {
    match op {
        ArithmeticOp::Add => Js::Number(l + r),
        ArithmeticOp::Sub => Js::Number(l - r),
        ArithmeticOp::Mul => Js::Number(l * r),
        ArithmeticOp::Div => if r == 0.0 { Js::Null } else { Js::Number(l / r) },
        ArithmeticOp::Rem => if r == 0.0 { Js::Null } else { Js::Number(l % r) },
    }
}

/// `AT(list, n)` on a list or a scalar: a non-integer index is null, a
/// scalar is a one-element list, a negative index counts from the end.
pub fn at_index(value: &Js, index: f64) -> Js {
    if !js::is_integer(index) {
        return Js::Null;
    }
    match value {
        Js::Array(list) => {
            let len = list.items().len() as f64;
            let resolved = if index < 0.0 { len + index } else { index };
            if resolved < 0.0 || resolved >= len { Js::Null } else { list.items()[resolved as usize].clone() }
        }
        Js::Undefined | Js::Null => Js::Null,
        other => if index == 0.0 || index == -1.0 { other.clone() } else { Js::Null },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::JsObject;

    fn s(text: &str) -> Js {
        Js::str(text)
    }

    #[test]
    fn equality_is_strict_and_lists_compare_as_sets() {
        let eq = |a: &Js, b: &Js| compare_values(a, FilterOperator::Eq, b, LocalZone::UTC).unwrap();
        assert!(eq(&Js::array(vec![s("a"), s("b"), s("a")]), &Js::array(vec![s("b"), s("a")])));
        assert!(!eq(&Js::array(vec![s("a")]), &Js::array(vec![s("a"), s("b")])));
        assert!(eq(&Js::array(vec![]), &Js::array(vec![])));
        assert!(!eq(&s("0"), &Js::Number(0.0)));
        assert!(!eq(&Js::Undefined, &Js::Null));
        assert!(eq(&Js::array(vec![Js::Number(f64::NAN)]), &Js::array(vec![Js::Number(f64::NAN)])));
        assert!(!eq(&Js::object(JsObject::new()), &Js::object(JsObject::new())));
    }

    #[test]
    fn ordering_is_numeric_then_by_date_then_textual() {
        let gt = |a: Js, b: Js| compare_values(&a, FilterOperator::Gt, &b, LocalZone::UTC).unwrap();
        assert!(gt(s("10"), s("9")));
        assert!(gt(s(" 10 "), Js::Number(9.0)));
        assert!(gt(s("2026-03-12T10:00:00Z"), s("2026-03-12")));
        assert!(gt(s("banana"), s("apple")));
        assert!(!gt(s("b"), Js::Number(1.0)));
        assert!(gt(Js::Bool(true), Js::Bool(false)));
        assert!(!gt(Js::Null, Js::Number(-1.0)));
        // Both read as dates (V8's legacy parser: 2001-01-01 and 2002-01-01).
        assert!(!gt(s("a 1"), s("b 2")) && gt(s("b 2"), s("a 1")));
        assert!(gt(s("a 1"), s("Item 5 of 9")));
        // Only one does: as text.
        assert!(compare_values(&s("a 1"), FilterOperator::Lt, &s("b"), LocalZone::UTC).unwrap());
    }

    #[test]
    fn membership_uses_same_value_zero() {
        let nan = Js::Number(f64::NAN);
        assert!(compare_values(&nan, FilterOperator::In, &Js::array(vec![nan.clone()]), LocalZone::UTC).unwrap());
        assert!(compare_values(&s("seed round"), FilterOperator::Contains, &s("seed"), LocalZone::UTC).unwrap());
        assert!(!compare_values(&Js::Number(1.0), FilterOperator::Contains, &s("1"), LocalZone::UTC).unwrap());
        assert!(!compare_values(&s("x"), FilterOperator::In, &s("xyz"), LocalZone::UTC).unwrap());
    }

    #[test]
    fn null_is_the_one_loose_comparison() {
        assert!(compare_to_null(FilterOperator::Eq, &Js::Undefined));
        assert!(compare_to_null(FilterOperator::Eq, &Js::Null));
        assert!(!compare_to_null(FilterOperator::Eq, &Js::Bool(false)));
        assert!(!compare_to_null(FilterOperator::Eq, &Js::Number(0.0)));
        assert!(!compare_to_null(FilterOperator::Gt, &Js::Null));
        assert!(compare_to_null(FilterOperator::Neq, &s("")));
    }

    #[test]
    fn evaluate_predicate_reads_through_the_scope() {
        let prop = |id: &str| Expression::Property { property_type_id: id.into() };
        let null = Expression::Static { value: movement_parser::lowering::expression::StaticValue::Null };
        let read = |name: &str| match name {
            "x" => Js::Number(5.0),
            "empty" => Js::Null,
            _ => Js::Undefined,
        };
        let is_null = |e: Expression| {
            evaluate_predicate(&Expression::Compare { op: FilterOperator::Eq, left: Box::new(e), right: Box::new(null.clone()) }, &read, LocalZone::UTC)
                .unwrap()
        };
        assert!(matches!(is_null(prop("missing")), Js::Bool(true)));
        assert!(matches!(is_null(prop("empty")), Js::Bool(true)));
        assert!(matches!(is_null(prop("x")), Js::Bool(false)));
        let negate = Expression::Negate { expression: Box::new(prop("x")) };
        assert!(matches!(evaluate_predicate(&negate, &read, LocalZone::UTC).unwrap(), Js::Number(n) if n == -5.0));
        let missing_eq_empty = Expression::Compare { op: FilterOperator::Eq, left: Box::new(prop("missing")), right: Box::new(prop("empty")) };
        assert!(matches!(evaluate_predicate(&missing_eq_empty, &read, LocalZone::UTC).unwrap(), Js::Bool(false)));
    }

    #[test]
    fn remainder_and_division_by_zero() {
        assert!(matches!(arithmetic(ArithmeticOp::Rem, -7.0, 20.0), Js::Number(n) if n == -7.0));
        assert!(matches!(arithmetic(ArithmeticOp::Rem, 7.0, -3.0), Js::Number(n) if n == 1.0));
        assert!(matches!(arithmetic(ArithmeticOp::Rem, 7.0, 0.0), Js::Null));
        assert!(matches!(arithmetic(ArithmeticOp::Div, 7.0, -0.0), Js::Null));
    }
}
