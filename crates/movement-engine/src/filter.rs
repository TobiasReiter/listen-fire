//! The shared predicate unit (packages/shared/expression/filter.ts):
//! `compareValues`, `compareToNull` and `evaluatePredicate`, the scalar
//! comparison semantics the engine and adapters decide filters by.

use movement_parser::lowering::expression::{ArithmeticOp, Expression, FilterOperator, ListElement, LogicalOp};

use crate::eval::{EvalError, static_value};
use crate::js::{self, Js};
use crate::js_date;

/// `x == null` / `x != null`: the one loose comparison — absent and null
/// both answer it. Any other operator against null is false.
pub fn compare_to_null(op: FilterOperator, value: &Js) -> bool {
    match op {
        FilterOperator::Eq => value.is_nullish(),
        FilterOperator::Neq => !value.is_nullish(),
        _ => false,
    }
}

/// `compareValues`. `within` reads the wall clock, which this unit does not
/// have: it is answered by TypeScript.
pub fn compare_values(left: &Js, op: FilterOperator, right: &Js) -> Result<bool, EvalError> {
    Ok(match op {
        FilterOperator::Eq => match (left, right) {
            (Js::Array(a), Js::Array(b)) => set_equals(&a.items, &b.items),
            _ => js::strict_equals(left, right),
        },
        FilterOperator::Neq => match (left, right) {
            (Js::Array(a), Js::Array(b)) => !set_equals(&a.items, &b.items),
            _ => !js::strict_equals(left, right),
        },
        FilterOperator::Gt => relational_order(left, right)?.is_some_and(|c| c > 0.0),
        FilterOperator::Gte => relational_order(left, right)?.is_some_and(|c| c >= 0.0),
        FilterOperator::Lt => relational_order(left, right)?.is_some_and(|c| c < 0.0),
        FilterOperator::Lte => relational_order(left, right)?.is_some_and(|c| c <= 0.0),
        FilterOperator::Exists => !left.is_nullish(),
        FilterOperator::In => match right {
            Js::Array(list) => list.items.iter().any(|item| js::same_value_zero(item, left)),
            _ => false,
        },
        FilterOperator::Contains => match (left, right) {
            (Js::String(l), Js::String(r)) => l.contains(r.as_str()),
            (Js::Array(list), _) => list.items.iter().any(|item| js::same_value_zero(item, right)),
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
        Js::String(s) if !js::trim(s).is_empty() => Some(js::string_to_number(s)).filter(|n| n.is_finite()),
        _ => None,
    }
}

/// `toEpochMs`: `new Date(value).getTime()` for what is not a number.
fn to_epoch_ms(value: &Js) -> js_date::Parsed {
    match value {
        Js::Undefined | Js::Null => js_date::Parsed::Invalid,
        Js::Number(n) => if n.is_finite() { js_date::Parsed::Valid(*n) } else { js_date::Parsed::Invalid },
        // `new Date(true)` is the instant 1 ms after the epoch.
        Js::Bool(b) => js_date::Parsed::Valid(f64::from(u8::from(*b))),
        // An object or a list is read as its `String()`.
        other => js_date::parse(&other.to_js_string()),
    }
}

/// `relationalOrder`: numerically, else chronologically, else as text;
/// `None` when the two do not order. A text only V8's date parser reads is
/// handed back to TypeScript — unless the other side could never be a date,
/// when the answer does not depend on it.
fn relational_order(left: &Js, right: &Js) -> Result<Option<f64>, EvalError> {
    if let (Some(l), Some(r)) = (to_finite_number(left), to_finite_number(right)) {
        return Ok(Some(js::math_sign(l - r)));
    }
    use js_date::Parsed::{Invalid, Unknown, Valid};
    match (to_epoch_ms(left), to_epoch_ms(right)) {
        (Valid(l), Valid(r)) => return Ok(Some(js::math_sign(l - r))),
        (Invalid, _) | (_, Invalid) => {}
        (Unknown, _) | (_, Unknown) => {
            return Err(EvalError::Fallback("a comparison of texts only V8's date parser reads".into()));
        }
    }
    Ok(match (left, right) {
        (Js::String(l), Js::String(r)) => Some(match js::utf16_cmp(l, r) {
            std::cmp::Ordering::Less => -1.0,
            std::cmp::Ordering::Equal => 0.0,
            std::cmp::Ordering::Greater => 1.0,
        }),
        _ => None,
    })
}

/// `isNullLiteral`: the `null` literal as written.
pub fn is_null_literal(expr: &Expression) -> bool {
    matches!(expr, Expression::Static { value: movement_parser::lowering::expression::StaticValue::Null })
}

/// `evaluatePredicate`: a pure predicate over leaf names `read` answers
/// (absent for a name it does not know). The engine evaluates through
/// `eval`, whose semantics this mirrors; adapters filter through this.
pub fn evaluate_predicate(expr: &Expression, read: &dyn Fn(&str) -> Js) -> Result<Js, EvalError> {
    let eval = |e: &Expression| evaluate_predicate(e, read);
    Ok(match expr {
        Expression::Static { value } => static_value(value),
        Expression::Property { property_type_id } | Expression::EdgeProperty { property_type_id } => read(property_type_id),
        Expression::AliasRef { name } => read(name),
        Expression::Meta { key } => read(&format!("@{key}")),
        Expression::List { elements } => {
            let mut items = Vec::new();
            for element in elements {
                match element {
                    ListElement::Expression(e) => items.push(eval(e)?),
                    ListElement::Spread(spread) => match eval(&spread.expression)? {
                        Js::Array(list) => items.extend(list.items.iter().cloned()),
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
                let v = eval(part)?;
                if !v.is_nullish() {
                    text.push_str(&v.to_js_string());
                }
            }
            Js::String(text)
        }
        Expression::Conditional { condition, then, else_ } => {
            if eval(condition)?.truthy() { eval(then)? } else { eval(else_)? }
        }
        Expression::Compare { op, left, right } => {
            // Both sides are read first, as the TypeScript does.
            let l = eval(left)?;
            let r = eval(right)?;
            Js::Bool(if is_null_literal(left) {
                compare_to_null(*op, &r)
            } else if is_null_literal(right) {
                compare_to_null(*op, &l)
            } else {
                compare_values(&l, *op, &r)?
            })
        }
        Expression::Logical { op, operands } => {
            let wanted = matches!(op, LogicalOp::Or);
            for operand in operands {
                if eval(operand)?.truthy() == wanted {
                    return Ok(Js::Bool(wanted));
                }
            }
            Js::Bool(!wanted)
        }
        Expression::Not { expression } => Js::Bool(!eval(expression)?.truthy()),
        Expression::Negate { expression } => Js::Number(-eval(expression)?.to_number()),
        Expression::Arithmetic { op, left, right } => {
            let l = eval(left)?.to_number();
            let r = eval(right)?.to_number();
            arithmetic(*op, l, r)
        }
        Expression::At { expression, index } => {
            let value = eval(expression)?;
            let index = eval(index)?.to_number();
            at_index(&value, index)
        }
        _ => return Err(EvalError::Fallback("not a pure predicate kind this unit evaluates".into())),
    })
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
            let len = list.items.len() as f64;
            let resolved = if index < 0.0 { len + index } else { index };
            if resolved < 0.0 || resolved >= len { Js::Null } else { list.items[resolved as usize].clone() }
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
        let eq = |a: &Js, b: &Js| compare_values(a, FilterOperator::Eq, b).unwrap();
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
        let gt = |a: Js, b: Js| compare_values(&a, FilterOperator::Gt, &b).unwrap();
        assert!(gt(s("10"), s("9")));
        assert!(gt(s(" 10 "), Js::Number(9.0)));
        assert!(gt(s("2026-03-12T10:00:00Z"), s("2026-03-12")));
        assert!(gt(s("banana"), s("apple")));
        assert!(!gt(s("b"), Js::Number(1.0)));
        assert!(gt(Js::Bool(true), Js::Bool(false)));
        assert!(!gt(Js::Null, Js::Number(-1.0)));
        assert!(matches!(compare_values(&s("a 1"), FilterOperator::Lt, &s("b 2")), Err(EvalError::Fallback(_))));
        // One side can never be a date, so the other's reading cannot matter.
        assert!(compare_values(&s("a 1"), FilterOperator::Lt, &s("b")).unwrap());
    }

    #[test]
    fn membership_uses_same_value_zero() {
        let nan = Js::Number(f64::NAN);
        assert!(compare_values(&nan, FilterOperator::In, &Js::array(vec![nan.clone()])).unwrap());
        assert!(compare_values(&s("seed round"), FilterOperator::Contains, &s("seed")).unwrap());
        assert!(!compare_values(&Js::Number(1.0), FilterOperator::Contains, &s("1")).unwrap());
        assert!(!compare_values(&s("x"), FilterOperator::In, &s("xyz")).unwrap());
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
            evaluate_predicate(&Expression::Compare { op: FilterOperator::Eq, left: Box::new(e), right: Box::new(null.clone()) }, &read)
                .unwrap()
        };
        assert!(matches!(is_null(prop("missing")), Js::Bool(true)));
        assert!(matches!(is_null(prop("empty")), Js::Bool(true)));
        assert!(matches!(is_null(prop("x")), Js::Bool(false)));
        let negate = Expression::Negate { expression: Box::new(prop("x")) };
        assert!(matches!(evaluate_predicate(&negate, &read).unwrap(), Js::Number(n) if n == -5.0));
        let missing_eq_empty = Expression::Compare { op: FilterOperator::Eq, left: Box::new(prop("missing")), right: Box::new(prop("empty")) };
        assert!(matches!(evaluate_predicate(&missing_eq_empty, &read).unwrap(), Js::Bool(false)));
    }

    #[test]
    fn remainder_and_division_by_zero() {
        assert!(matches!(arithmetic(ArithmeticOp::Rem, -7.0, 20.0), Js::Number(n) if n == -7.0));
        assert!(matches!(arithmetic(ArithmeticOp::Rem, 7.0, -3.0), Js::Number(n) if n == 1.0));
        assert!(matches!(arithmetic(ArithmeticOp::Rem, 7.0, 0.0), Js::Null));
        assert!(matches!(arithmetic(ArithmeticOp::Div, 7.0, -0.0), Js::Null));
    }
}
