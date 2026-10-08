//! packages/shared/expression/order_limit.ts: what one hop pushes to the
//! adapter for its fetch (`hopPushdown`, closed over the hop's scope as
//! expression.ts `closedHopPushdown` closes it), and the hop's ORDER BY /
//! LIMIT applied to what came back (`applyHopOrderLimit`).
//!
//! Pushing is an optimisation: the adapter may honour any of it or none,
//! and the engine filters, sorts and slices what comes back regardless.
//! What the adapter is ASKED is part of the contract all the same, so it is
//! built here exactly as the TypeScript builds it, key for key
//! (tests/order_limit_pin.rs holds it to the TypeScript's own answers).

use movement_parser::lowering::expression::{Cardinality, EdgeStep, Expression, ListElement, OrderDirection};

use crate::env;
use crate::js::{self, Js, JsObject};

/// `compareOrderValues`: numbers numerically, everything else as text;
/// empty (null, undefined) last whatever the direction. As the comparator a
/// JavaScript sort is handed, so `a - b` may be NaN.
pub fn compare_order_values(a: &Js, b: &Js) -> f64 {
    match (a.is_nullish(), b.is_nullish()) {
        (true, true) => return 0.0,
        (true, false) => return 1.0,
        (false, true) => return -1.0,
        _ => {}
    }
    if let (Js::Number(a), Js::Number(b)) = (a, b) {
        return a - b;
    }
    match js::utf16_cmp(&a.to_js_string(), &b.to_js_string()) {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
    }
}

/// `orderKeyProperty`: the bare property of the landed record an ordering
/// key names, the one key shape an adapter can be asked to sort by.
pub fn order_key_property(key: Option<&Expression>) -> Option<&str> {
    match key {
        Some(Expression::Property { property_type_id }) => Some(property_type_id),
        _ => None,
    }
}

fn direction_text(direction: Option<OrderDirection>) -> &'static str {
    match direction {
        Some(OrderDirection::Desc) => "desc",
        Some(OrderDirection::Asc) | None => "asc",
    }
}

/// `hopPushdown`: the WHERE when it is pure, the ORDER BY when its key is a
/// bare property, and the LIMIT when the sort it came with is pushed too (a
/// truncated fetch the engine then sorts would answer the wrong records).
pub struct Pushdown<'s> {
    pub where_: Option<&'s Expression>,
    pub order_by: Option<(&'s str, &'static str)>,
    pub limit: Option<f64>,
}

pub fn hop_pushdown(step: &EdgeStep) -> Pushdown<'_> {
    let where_ = step.expression_filter.as_deref().filter(|filter| crate::filter::pure_leaf_reads(filter).is_some());
    let cardinality = step.cardinality.as_ref();
    let key = cardinality.and_then(|c| c.order_by.as_deref());
    let property = order_key_property(key);
    let pushes_order = key.is_none() || property.is_some();
    Pushdown {
        where_,
        order_by: property.map(|p| (p, direction_text(cardinality.and_then(|c| c.order_direction)))),
        limit: cardinality.and_then(|c| c.limit).filter(|_| pushes_order).map(|n| n.0),
    }
}

/// A leaf of the pushed WHERE swapped for the scalar the hop's scope
/// already holds (`closedHopPushdown`): by node, as `replacePureLeaves`
/// keys by identity.
pub struct Substitution<'e> {
    pub leaf: &'e Expression,
    pub value: Js,
}

impl Pushdown<'_> {
    /// The pushdown's members as the getRelated input spreads them, in
    /// `hopPushdown`'s key order: `where`, `orderBy`, `limit`.
    pub fn members(&self, substitutions: &[Substitution<'_>]) -> Vec<(String, Js)> {
        let mut members = Vec::new();
        if let Some(where_) = self.where_ {
            members.push(("where".to_string(), replace_pure_leaves(where_, substitutions)));
        }
        if let Some((field, direction)) = self.order_by {
            members.push(("orderBy".to_string(), env::object_of(vec![("fieldId", Js::str(field)), ("direction", Js::str(direction))])));
        }
        if let Some(limit) = self.limit {
            members.push(("limit".to_string(), Js::Number(limit)));
        }
        members
    }
}

/// `replacePureLeaves`: the predicate as the JavaScript object the
/// lowering wrote, with the substituted leaves swapped for `{type: 'static',
/// value}`. A node it descends is copied as `{...expr, child: …}` copies it,
/// every key in its place; any other is written as it is.
pub fn replace_pure_leaves(expr: &Expression, substitutions: &[Substitution<'_>]) -> Js {
    if let Some(found) = substitutions.iter().find(|s| std::ptr::eq(s.leaf, expr)) {
        return env::object_of(vec![("type", Js::str("static")), ("value", found.value.clone())]);
    }
    let whole = || env::js_of_serialized(expr);
    let rebuilt = |children: Vec<(&str, Js)>| {
        let Js::Object(object) = whole() else { unreachable!("an expression is an object") };
        let mut object = JsObject::clone_of(&object);
        for (key, child) in children {
            object.set(key.to_string(), child);
        }
        Js::object(object)
    };
    let each = |items: &[Expression]| Js::array(items.iter().map(|e| replace_pure_leaves(e, substitutions)).collect());
    match expr {
        Expression::List { elements } => {
            let items = elements
                .iter()
                .map(|element| match element {
                    ListElement::Expression(e) => replace_pure_leaves(e, substitutions),
                    ListElement::Spread(spread) => {
                        let Js::Object(object) = env::js_of_serialized(element) else {
                            unreachable!("a spread is an object")
                        };
                        let mut object = JsObject::clone_of(&object);
                        object.set("expression".into(), replace_pure_leaves(&spread.expression, substitutions));
                        Js::object(object)
                    }
                })
                .collect();
            rebuilt(vec![("elements", Js::array(items))])
        }
        Expression::Compare { left, right, .. } | Expression::Arithmetic { left, right, .. } => {
            rebuilt(vec![("left", replace_pure_leaves(left, substitutions)), ("right", replace_pure_leaves(right, substitutions))])
        }
        Expression::Logical { operands, .. } => rebuilt(vec![("operands", each(operands))]),
        Expression::Not { expression } | Expression::Negate { expression } => {
            rebuilt(vec![("expression", replace_pure_leaves(expression, substitutions))])
        }
        Expression::Concat { parts } => rebuilt(vec![("parts", each(parts))]),
        Expression::Conditional { condition, then, else_ } => rebuilt(vec![
            ("condition", replace_pure_leaves(condition, substitutions)),
            ("then", replace_pure_leaves(then, substitutions)),
            ("else", replace_pure_leaves(else_, substitutions)),
        ]),
        Expression::At { expression, index } => rebuilt(vec![
            ("expression", replace_pure_leaves(expression, substitutions)),
            ("index", replace_pure_leaves(index, substitutions)),
        ]),
        _ => whole(),
    }
}

/// `asPushableScalar`: what a value can stand in as a `static` operand. Null
/// and absent are not: `x == NULL` is a presence question the engine answers.
pub fn pushable_scalar(value: &Js) -> Option<Js> {
    matches!(value, Js::String(_) | Js::Number(_) | Js::Bool(_)).then(|| value.clone())
}

/// `applyHopOrderLimit` over `count` items whose ORDER BY keys `keys` holds
/// (read only when the hop orders): the items' indices, sorted and sliced.
pub fn apply_hop_order_limit(count: usize, cardinality: Option<&Cardinality>, keys: Option<&[Js]>) -> Result<Vec<usize>, MixedKeys> {
    let mut order: Vec<usize> = (0..count).collect();
    let Some(cardinality) = cardinality else { return Ok(order) };
    if cardinality.order_by.is_some() {
        let keys = keys.expect("an ordered hop's keys are read before it is sorted");
        if keys.len() > INSERTION_SORTED && mixed_kinds(keys) {
            return Err(MixedKeys { count: keys.len() });
        }
        order = sort_by_order_key(keys, cardinality.order_direction);
    }
    if let Some(limit) = cardinality.limit {
        order.truncate(slice_end(limit.0, order.len()));
    }
    Ok(order)
}

/// The most items V8 sorts by binary insertion alone, which this engine
/// reproduces for any comparator.
const INSERTION_SORTED: usize = 64;

/// An ORDER BY over more than 64 records whose keys mix numbers with other
/// kinds: the comparator is no total order, V8's merge of its runs decides
/// where records land, and this engine does not reproduce that merge. The run
/// fails rather than order them differently (the language-version bump gives
/// mixed keys one total order).
#[derive(Debug, Clone, PartialEq)]
pub struct MixedKeys {
    pub count: usize,
}

/// Whether the keys that are not empty mix numbers with other kinds (two
/// numbers compare as numbers, anything else as text).
fn mixed_kinds(keys: &[Js]) -> bool {
    let present = || keys.iter().filter(|k| !k.is_nullish());
    present().any(|k| matches!(k, Js::Number(_))) && present().any(|k| !matches!(k, Js::Number(_)))
}

/// `slice(0, limit)`'s end: the limit truncated toward zero, counted from
/// the end when negative, clamped to the list.
fn slice_end(limit: f64, len: usize) -> usize {
    if limit.is_nan() {
        return 0;
    }
    let end = limit.trunc();
    let len_f = len as f64;
    let end = if end < 0.0 { (len_f + end).max(0.0) } else { end.min(len_f) };
    end as usize
}

/// `sortByOrderKey`: a stable sort of the items by their keys, empty keys
/// last whatever the direction, ties in arrival order. The order of the
/// indices into `keys`.
///
/// Sorted as V8's `Array.prototype.sort` sorts (its TimSort: the leading run,
/// reversed when strictly descending, then binary insertion; a comparator's
/// NaN read as 0), so that keys whose text and numeric orders disagree — a
/// comparator no total order agrees with — still land where JavaScript puts
/// them. Up to 64 items that is V8's whole algorithm; past it the runs are
/// merged stably, which agrees with V8 for every comparator that is a total
/// order (keys of one kind always are).
pub fn sort_by_order_key(keys: &[Js], direction: Option<OrderDirection>) -> Vec<usize> {
    let sign = if matches!(direction, Some(OrderDirection::Desc)) { -1.0 } else { 1.0 };
    let compare = |a: usize, b: usize| -> f64 {
        let by_key = compare_order_values(&keys[a], &keys[b]);
        let result = if by_key != 0.0 {
            if keys[a].is_nullish() || keys[b].is_nullish() { by_key } else { by_key * sign }
        } else {
            a as f64 - b as f64
        };
        if result.is_nan() { 0.0 } else { result }
    };
    let mut items: Vec<usize> = (0..keys.len()).collect();
    v8_sort(&mut items, &compare);
    items
}

/// V8's ArrayTimSort (third_party/v8 builtins/array-sort.tq) for one run
/// list: `ComputeMinRunLength`, `CountAndMakeRun`, `BinaryInsertionSort`,
/// and a stable merge of the runs.
fn v8_sort(items: &mut [usize], compare: &dyn Fn(usize, usize) -> f64) {
    let n = items.len();
    if n < 2 {
        return;
    }
    let min_run = {
        let (mut n, mut r) = (n, 0);
        while n >= 64 {
            r |= n & 1;
            n >>= 1;
        }
        n + r
    };
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut low = 0;
    while low < n {
        let remaining = n - low;
        let mut run = count_and_make_run(items, low, low + remaining, compare);
        if run < min_run {
            let forced = min_run.min(remaining);
            binary_insertion_sort(items, low, low + run, low + forced, compare);
            run = forced;
        }
        runs.push((low, low + run));
        low += run;
    }
    while runs.len() > 1 {
        let mut merged = Vec::new();
        for pair in runs.chunks(2) {
            match pair {
                [(a, mid), (_, b)] => {
                    merge(items, *a, *mid, *b, compare);
                    merged.push((*a, *b));
                }
                [single] => merged.push(*single),
                _ => unreachable!("chunks of two"),
            }
        }
        runs = merged;
    }
}

fn count_and_make_run(items: &mut [usize], low_arg: usize, high: usize, compare: &dyn Fn(usize, usize) -> f64) -> usize {
    let low = low_arg + 1;
    if low == high {
        return 1;
    }
    let mut run = 2;
    let descending = compare(items[low], items[low - 1]) < 0.0;
    let mut previous = items[low];
    for index in low + 1..high {
        let current = items[index];
        let order = compare(current, previous);
        if descending { if order >= 0.0 { break } } else if order < 0.0 { break }
        previous = current;
        run += 1;
    }
    if descending {
        items[low_arg..low_arg + run].reverse();
    }
    run
}

fn binary_insertion_sort(items: &mut [usize], low: usize, start: usize, high: usize, compare: &dyn Fn(usize, usize) -> f64) {
    let mut start = if low == start { start + 1 } else { start };
    while start < high {
        let (mut left, mut right) = (low, start);
        let pivot = items[start];
        while left < right {
            let mid = left + ((right - left) >> 1);
            if compare(pivot, items[mid]) < 0.0 { right = mid } else { left = mid + 1 }
        }
        items.copy_within(left..start, left + 1);
        items[left] = pivot;
        start += 1;
    }
}

/// A stable merge of two adjacent sorted runs: on a tie the left run's item
/// first.
fn merge(items: &mut [usize], low: usize, mid: usize, high: usize, compare: &dyn Fn(usize, usize) -> f64) {
    let left: Vec<usize> = items[low..mid].to_vec();
    let right: Vec<usize> = items[mid..high].to_vec();
    let (mut i, mut j, mut k) = (0, 0, low);
    while i < left.len() && j < right.len() {
        if compare(right[j], left[i]) < 0.0 {
            items[k] = right[j];
            j += 1;
        } else {
            items[k] = left[i];
            i += 1;
        }
        k += 1;
    }
    for &item in left[i..].iter().chain(&right[j..]) {
        items[k] = item;
        k += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_keys_sort_last_whatever_the_direction_and_ties_keep_their_order() {
        let keys = [Js::Number(10.0), Js::Null, Js::Number(30.0), Js::Number(10.0), Js::Undefined, Js::Number(20.0)];
        assert_eq!(sort_by_order_key(&keys, None), [0, 3, 5, 2, 1, 4]);
        assert_eq!(sort_by_order_key(&keys, Some(OrderDirection::Desc)), [2, 5, 0, 3, 1, 4]);
    }

    #[test]
    fn mixed_keys_past_64_records_are_refused_not_ordered() {
        let cardinality = Cardinality {
            mode: movement_parser::lowering::expression::CardinalityMode::All,
            limit: None,
            order_by: Some(Box::new(Expression::Property { property_type_id: "k".into() })),
            order_direction: None,
        };
        let mixed = |n: usize| -> Vec<Js> { (0..n).map(|i| if i % 2 == 0 { Js::Number(i as f64) } else { Js::str(format!("{i}")) }).collect() };
        assert!(apply_hop_order_limit(64, Some(&cardinality), Some(&mixed(64))).is_ok(), "64 or fewer: V8's insertion sort, reproduced");
        assert_eq!(apply_hop_order_limit(65, Some(&cardinality), Some(&mixed(65))), Err(MixedKeys { count: 65 }));
        let numbers: Vec<Js> = (0..100).map(|i| Js::Number(f64::from(100 - i))).chain([Js::Null]).collect();
        assert!(apply_hop_order_limit(101, Some(&cardinality), Some(&numbers)).is_ok(), "one kind and empties: a total order");
    }

    #[test]
    fn a_limit_slices_as_javascript_slices() {
        assert_eq!(slice_end(2.0, 5), 2);
        assert_eq!(slice_end(2.9, 5), 2);
        assert_eq!(slice_end(9.0, 5), 5);
        assert_eq!(slice_end(-1.0, 5), 4);
        assert_eq!(slice_end(-9.0, 5), 0);
        assert_eq!(slice_end(f64::NAN, 5), 0);
    }
}
