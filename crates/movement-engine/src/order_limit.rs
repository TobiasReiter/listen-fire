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
        Some(Expression::Property { property_type_id, .. }) => Some(property_type_id),
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
pub fn apply_hop_order_limit(count: usize, cardinality: Option<&Cardinality>, keys: Option<&[Js]>) -> Vec<usize> {
    let mut order: Vec<usize> = (0..count).collect();
    let Some(cardinality) = cardinality else { return order };
    if cardinality.order_by.is_some() {
        let keys = keys.expect("an ordered hop's keys are read before it is sorted");
        order = sort_by_order_key(keys, cardinality.order_direction);
    }
    if let Some(limit) = cardinality.limit {
        order.truncate(slice_end(limit.0, order.len()));
    }
    order
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
/// Sorted as V8's `Array.prototype.sort` sorts, step for step (its TimSort,
/// below; a comparator's NaN read as 0), so that keys whose text and numeric
/// orders disagree — numbers mixed with texts, a comparator no total order
/// agrees with — land where JavaScript puts them at every length, not only
/// where any stable sort would agree.
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

/// V8's ArrayTimSort (v8/third_party/v8/builtins/array-sort.tq, Node 22's
/// V8 12.4), ported step for step so that a comparator no total order agrees
/// with (keys mixing numbers with text) lands every item where JavaScript
/// lands it: the minimum run length, the runs found and reversed, binary
/// insertion, the pending-run stack and its invariants, the galloping
/// merges with their shared `minGallop`, and the early exits V8 takes when
/// an inconsistent comparator empties a run.
fn v8_sort(items: &mut [usize], compare: &dyn Fn(usize, usize) -> f64) {
    let length = items.len();
    if length < 2 {
        return;
    }
    let mut sort = TimSort { work: items, compare, runs: Vec::new(), min_gallop: MIN_GALLOP };
    let mut remaining = length;
    let mut low = 0;
    let min_run = min_run_length(remaining);
    while remaining != 0 {
        let mut run = sort.count_and_make_run(low, low + remaining);
        if run < min_run {
            let forced = min_run.min(remaining);
            sort.binary_insertion_sort(low, low + run, low + forced);
            run = forced;
        }
        sort.runs.push((low, run));
        sort.merge_collapse();
        low += run;
        remaining -= run;
    }
    sort.merge_force_collapse();
}

/// `kMinGallopWins`, and `minGallop`'s first value.
const MIN_GALLOP: usize = 7;

/// `ComputeMinRunLength`.
fn min_run_length(n: usize) -> usize {
    let (mut n, mut r) = (n, 0);
    while n >= 64 {
        r |= n & 1;
        n >>= 1;
    }
    n + r
}

struct TimSort<'a> {
    work: &'a mut [usize],
    compare: &'a dyn Fn(usize, usize) -> f64,
    /// The pending runs: `(base, length)`.
    runs: Vec<(usize, usize)>,
    min_gallop: usize,
}

/// Which array a gallop reads: the work array, or the merge's copy of a run.
#[derive(Clone, Copy)]
enum Side {
    Work,
    Temp,
}

impl TimSort<'_> {
    fn order(&self, a: usize, b: usize) -> f64 {
        (self.compare)(a, b)
    }

    fn count_and_make_run(&mut self, low_arg: usize, high: usize) -> usize {
        let low = low_arg + 1;
        if low == high {
            return 1;
        }
        let mut run = 2;
        let descending = self.order(self.work[low], self.work[low - 1]) < 0.0;
        let mut previous = self.work[low];
        for index in low + 1..high {
            let current = self.work[index];
            let order = self.order(current, previous);
            if descending { if order >= 0.0 { break } } else if order < 0.0 { break }
            previous = current;
            run += 1;
        }
        if descending {
            self.work[low_arg..low_arg + run].reverse();
        }
        run
    }

    fn binary_insertion_sort(&mut self, low: usize, start: usize, high: usize) {
        let mut start = if low == start { start + 1 } else { start };
        while start < high {
            let (mut left, mut right) = (low, start);
            let pivot = self.work[start];
            while left < right {
                let mid = left + ((right - left) >> 1);
                if self.order(pivot, self.work[mid]) < 0.0 { right = mid } else { left = mid + 1 }
            }
            self.work.copy_within(left..start, left + 1);
            self.work[left] = pivot;
            start += 1;
        }
    }

    /// `RunInvariantEstablished`.
    fn invariant(&self, n: usize) -> bool {
        if n < 2 {
            return true;
        }
        self.runs[n - 2].1 > self.runs[n - 1].1 + self.runs[n].1
    }

    /// `MergeCollapse`.
    fn merge_collapse(&mut self) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if !self.invariant(n + 1) || !self.invariant(n) {
                if self.runs[n - 1].1 < self.runs[n + 1].1 {
                    n -= 1;
                }
                self.merge_at(n);
            } else if self.runs[n].1 <= self.runs[n + 1].1 {
                self.merge_at(n);
            } else {
                break;
            }
        }
    }

    /// `MergeForceCollapse`.
    fn merge_force_collapse(&mut self) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if n > 0 && self.runs[n - 1].1 < self.runs[n + 1].1 {
                n -= 1;
            }
            self.merge_at(n);
        }
    }

    /// `MergeAt`: runs `i` and `i + 1` merged into one.
    fn merge_at(&mut self, i: usize) {
        let (mut base_a, mut length_a) = self.runs[i];
        let (base_b, mut length_b) = self.runs[i + 1];
        self.runs[i].1 = length_a + length_b;
        self.runs.remove(i + 1);
        let key_right = self.work[base_b];
        let k = self.gallop_right(Side::Work, &[], key_right, base_a, length_a, 0);
        base_a += k;
        length_a -= k;
        if length_a == 0 {
            return;
        }
        let key_left = self.work[base_a + length_a - 1];
        length_b = self.gallop_left(Side::Work, &[], key_left, base_b, length_b, length_b - 1);
        if length_b == 0 {
            return;
        }
        if length_a <= length_b {
            self.merge_low(base_a, length_a, base_b, length_b);
        } else {
            self.merge_high(base_a, length_a, base_b, length_b);
        }
    }

    fn at(&self, side: Side, temp: &[usize], index: usize) -> usize {
        match side {
            Side::Work => self.work[index],
            Side::Temp => temp[index],
        }
    }

    /// `GallopLeft`: where `key` goes in the sorted `length` items from
    /// `base`, before any equal to it, starting the search at `hint`.
    fn gallop_left(&self, side: Side, temp: &[usize], key: usize, base: usize, length: usize, hint: usize) -> usize {
        let (mut last_ofs, mut offset) = (0usize, 1usize);
        if self.order(self.at(side, temp, base + hint), key) < 0.0 {
            let max_ofs = length - hint;
            while offset < max_ofs {
                if self.order(self.at(side, temp, base + hint + offset), key) >= 0.0 {
                    break;
                }
                last_ofs = offset;
                offset = (offset << 1) + 1;
            }
            offset = offset.min(max_ofs);
            last_ofs += hint;
            offset += hint;
        } else {
            let max_ofs = hint + 1;
            while offset < max_ofs {
                if self.order(self.at(side, temp, base + hint - offset), key) < 0.0 {
                    break;
                }
                last_ofs = offset;
                offset = (offset << 1) + 1;
            }
            offset = offset.min(max_ofs);
            let tmp = last_ofs;
            // `lastOfs = hint - offset` may be -1 here; it is incremented
            // before use.
            last_ofs = (hint + 1).wrapping_sub(offset).wrapping_sub(1);
            offset = hint - tmp;
        }
        last_ofs = last_ofs.wrapping_add(1);
        while last_ofs < offset {
            let m = last_ofs + ((offset - last_ofs) >> 1);
            if self.order(self.at(side, temp, base + m), key) < 0.0 { last_ofs = m + 1 } else { offset = m }
        }
        offset
    }

    /// `GallopRight`: where `key` goes in the sorted `length` items from
    /// `base`, after any equal to it, starting the search at `hint`.
    fn gallop_right(&self, side: Side, temp: &[usize], key: usize, base: usize, length: usize, hint: usize) -> usize {
        let (mut last_ofs, mut offset) = (0usize, 1usize);
        if self.order(key, self.at(side, temp, base + hint)) < 0.0 {
            let max_ofs = hint + 1;
            while offset < max_ofs {
                if self.order(key, self.at(side, temp, base + hint - offset)) >= 0.0 {
                    break;
                }
                last_ofs = offset;
                offset = (offset << 1) + 1;
            }
            offset = offset.min(max_ofs);
            let tmp = last_ofs;
            last_ofs = (hint + 1).wrapping_sub(offset).wrapping_sub(1);
            offset = hint - tmp;
        } else {
            let max_ofs = length - hint;
            while offset < max_ofs {
                if self.order(key, self.at(side, temp, base + hint + offset)) < 0.0 {
                    break;
                }
                last_ofs = offset;
                offset = (offset << 1) + 1;
            }
            offset = offset.min(max_ofs);
            last_ofs += hint;
            offset += hint;
        }
        last_ofs = last_ofs.wrapping_add(1);
        while last_ofs < offset {
            let m = last_ofs + ((offset - last_ofs) >> 1);
            if self.order(key, self.at(side, temp, base + m)) < 0.0 { offset = m } else { last_ofs = m + 1 }
        }
        offset
    }

    /// `MergeLow`: run A (the shorter) copied out, merged left to right.
    fn merge_low(&mut self, base_a: usize, length_a: usize, base_b: usize, length_b: usize) {
        let (mut length_a, mut length_b) = (length_a, length_b);
        let temp: Vec<usize> = self.work[base_a..base_a + length_a].to_vec();
        let (mut dest, mut cursor_temp, mut cursor_b) = (base_a, 0usize, base_b);
        self.work[dest] = self.work[cursor_b];
        dest += 1;
        cursor_b += 1;
        enum End {
            Succeed,
            CopyB,
        }
        let end = 'merge: {
            length_b -= 1;
            if length_b == 0 {
                break 'merge End::Succeed;
            }
            if length_a == 1 {
                break 'merge End::CopyB;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let (mut wins_a, mut wins_b) = (0usize, 0usize);
                loop {
                    if self.order(self.work[cursor_b], temp[cursor_temp]) < 0.0 {
                        self.work[dest] = self.work[cursor_b];
                        dest += 1;
                        cursor_b += 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 0 {
                            break 'merge End::Succeed;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    } else {
                        self.work[dest] = temp[cursor_temp];
                        dest += 1;
                        cursor_temp += 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 1 {
                            break 'merge End::CopyB;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP || wins_b >= MIN_GALLOP || first {
                    first = false;
                    min_gallop = min_gallop.saturating_sub(1).max(1);
                    self.min_gallop = min_gallop;
                    wins_a = self.gallop_right(Side::Temp, &temp, self.work[cursor_b], cursor_temp, length_a, 0);
                    if wins_a > 0 {
                        self.work[dest..dest + wins_a].copy_from_slice(&temp[cursor_temp..cursor_temp + wins_a]);
                        dest += wins_a;
                        cursor_temp += wins_a;
                        length_a -= wins_a;
                        if length_a == 1 {
                            break 'merge End::CopyB;
                        }
                        // An inconsistent comparator can empty A here.
                        if length_a == 0 {
                            break 'merge End::Succeed;
                        }
                    }
                    self.work[dest] = self.work[cursor_b];
                    dest += 1;
                    cursor_b += 1;
                    length_b -= 1;
                    if length_b == 0 {
                        break 'merge End::Succeed;
                    }
                    wins_b = self.gallop_left(Side::Work, &[], temp[cursor_temp], cursor_b, length_b, 0);
                    if wins_b > 0 {
                        self.work.copy_within(cursor_b..cursor_b + wins_b, dest);
                        dest += wins_b;
                        cursor_b += wins_b;
                        length_b -= wins_b;
                        if length_b == 0 {
                            break 'merge End::Succeed;
                        }
                    }
                    self.work[dest] = temp[cursor_temp];
                    dest += 1;
                    cursor_temp += 1;
                    length_a -= 1;
                    if length_a == 1 {
                        break 'merge End::CopyB;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        match end {
            End::Succeed => {
                if length_a > 0 {
                    self.work[dest..dest + length_a].copy_from_slice(&temp[cursor_temp..cursor_temp + length_a]);
                }
            }
            End::CopyB => {
                self.work.copy_within(cursor_b..cursor_b + length_b, dest);
                self.work[dest + length_b] = temp[cursor_temp];
            }
        }
    }

    /// `MergeHigh`: run B (the shorter) copied out, merged right to left.
    fn merge_high(&mut self, base_a: usize, length_a: usize, base_b: usize, length_b: usize) {
        let (mut length_a, mut length_b) = (length_a, length_b);
        let temp: Vec<usize> = self.work[base_b..base_b + length_b].to_vec();
        // Cursors run down past the run's start: kept one above, as `isize`
        // would, so `cursor - 1` is V8's index.
        let mut dest = (base_b + length_b - 1) as isize;
        let mut cursor_temp = length_b as isize - 1;
        let mut cursor_a = (base_a + length_a - 1) as isize;
        self.work[dest as usize] = self.work[cursor_a as usize];
        dest -= 1;
        cursor_a -= 1;
        enum End {
            Succeed,
            CopyA,
        }
        let end = 'merge: {
            length_a -= 1;
            if length_a == 0 {
                break 'merge End::Succeed;
            }
            if length_b == 1 {
                break 'merge End::CopyA;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let (mut wins_a, mut wins_b) = (0usize, 0usize);
                loop {
                    if self.order(temp[cursor_temp as usize], self.work[cursor_a as usize]) < 0.0 {
                        self.work[dest as usize] = self.work[cursor_a as usize];
                        dest -= 1;
                        cursor_a -= 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 0 {
                            break 'merge End::Succeed;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    } else {
                        self.work[dest as usize] = temp[cursor_temp as usize];
                        dest -= 1;
                        cursor_temp -= 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 1 {
                            break 'merge End::CopyA;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP || wins_b >= MIN_GALLOP || first {
                    first = false;
                    min_gallop = min_gallop.saturating_sub(1).max(1);
                    self.min_gallop = min_gallop;
                    let k = self.gallop_right(Side::Work, &[], temp[cursor_temp as usize], base_a, length_a, length_a - 1);
                    wins_a = length_a - k;
                    if wins_a > 0 {
                        dest -= wins_a as isize;
                        cursor_a -= wins_a as isize;
                        let from = (cursor_a + 1) as usize;
                        self.work.copy_within(from..from + wins_a, (dest + 1) as usize);
                        length_a -= wins_a;
                        if length_a == 0 {
                            break 'merge End::Succeed;
                        }
                    }
                    self.work[dest as usize] = temp[cursor_temp as usize];
                    dest -= 1;
                    cursor_temp -= 1;
                    length_b -= 1;
                    if length_b == 1 {
                        break 'merge End::CopyA;
                    }
                    let k = self.gallop_left(Side::Temp, &temp, self.work[cursor_a as usize], 0, length_b, length_b - 1);
                    wins_b = length_b - k;
                    if wins_b > 0 {
                        dest -= wins_b as isize;
                        cursor_temp -= wins_b as isize;
                        let from = (cursor_temp + 1) as usize;
                        let to = (dest + 1) as usize;
                        self.work[to..to + wins_b].copy_from_slice(&temp[from..from + wins_b]);
                        length_b -= wins_b;
                        if length_b == 1 {
                            break 'merge End::CopyA;
                        }
                        // An inconsistent comparator can empty B here.
                        if length_b == 0 {
                            break 'merge End::Succeed;
                        }
                    }
                    self.work[dest as usize] = self.work[cursor_a as usize];
                    dest -= 1;
                    cursor_a -= 1;
                    length_a -= 1;
                    if length_a == 0 {
                        break 'merge End::Succeed;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        match end {
            End::Succeed => {
                if length_b > 0 {
                    let to = (dest - (length_b as isize - 1)) as usize;
                    self.work[to..to + length_b].copy_from_slice(&temp[..length_b]);
                }
            }
            End::CopyA => {
                dest -= length_a as isize;
                cursor_a -= length_a as isize;
                let from = (cursor_a + 1) as usize;
                self.work.copy_within(from..from + length_a, (dest + 1) as usize);
                self.work[dest as usize] = temp[cursor_temp as usize];
            }
        }
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
    fn mixed_keys_past_64_records_sort_as_v8_sorts_them() {
        // Node: `sortByOrderKey` over these keys (numbers at even places,
        // their texts at odd), 65 of them.
        let mixed: Vec<Js> = (0..65).map(|i| if i % 2 == 0 { Js::Number(f64::from(i)) } else { Js::str(format!("{i}")) }).collect();
        assert_eq!(sort_by_order_key(&mixed, None)[..12], [0, 1, 2, 3, 4, 10, 11, 13, 16, 18, 20, 22]);
        let numbers: Vec<Js> = (0..100).map(|i| Js::Number(f64::from(100 - i))).chain([Js::Null]).collect();
        assert_eq!(sort_by_order_key(&numbers, None)[0], 99, "one kind and empties: a total order");
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
