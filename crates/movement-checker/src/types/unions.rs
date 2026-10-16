//! THE UNION RULE — what a value that may be one of several records is, as
//! TypeScript's union: `A | A` IS `A`, and `Person | Company` reads, walks and
//! writes only what both offer. Every place a value can be one of several
//! records asks this: an `IF`, a `COALESCE`, a function's returns, a list's
//! members (a literal, `MULTI`).
//!
//! Members of one type join into that type, keeping only what EVERY member
//! vouches for, so no arm is preferred: a field a guard proved present where
//! every arm proved it, an `-[:@old]->` where every member was written, a
//! field read as set where every write set it (`merge_one_type`). Members of
//! different types make a `Position::OneOf`. Versioned with one switch
//! (`RecordJoin`): from language version 5 the rule applies; before it every
//! site answers as it always had, and the check that withheld a joined answer
//! is checked again joining, so what 5 would refuse is an upgrade warning.

use std::cell::Cell;
use std::collections::BTreeSet;
use std::rc::Rc;

use super::field::{Ty, field_type_equals, is_maybe_absent, maybe_absent, strip_absent, value_union};
use super::position::{HandleIdentity, HandlePosition, Position, same_instance, same_starting_point};

/// Whether this check applies the union rule before version 5, and whether a
/// check that did not apply it met a site where it would have answered
/// otherwise. Shared by the root file's checker and every library's in one
/// check.
#[derive(Debug, Default)]
pub struct RecordUnions {
    pub join_before5: bool,
    pub withheld: Cell<bool>,
}

/// One site's view of `RecordUnions`: whether it joins, and where to say it
/// withheld a joined answer.
#[derive(Debug, Clone, Copy)]
pub struct RecordJoin<'a> {
    pub joins: bool,
    withheld: Option<&'a Cell<bool>>,
}

impl<'a> RecordJoin<'a> {
    pub fn under(version: u32, unions: Option<&'a RecordUnions>) -> Self {
        RecordJoin { joins: version >= 5 || unions.is_some_and(|u| u.join_before5), withheld: unions.map(|u| &u.withheld) }
    }

    pub fn withhold(&self) {
        if let Some(withheld) = self.withheld {
            withheld.set(true);
        }
    }
}

/// The TypeScript's `===` between a joined answer and a site's old one: the
/// joined answer is the first member's own value where nothing changed.
fn same_answer(a: &Ty, b: &Ty) -> bool {
    match (a, b) {
        (Ty::Record(Some(a)), Ty::Record(Some(b))) => Rc::ptr_eq(a, b),
        (Ty::Record(None), Ty::Record(None)) => true,
        (Ty::MaybeAbsent(a), Ty::MaybeAbsent(b)) => Rc::ptr_eq(a, b),
        _ => false,
    }
}

/// `joinedUnder`: `joined` where the check joins, else what the site answered
/// before (`old`), telling the rule where the two differ.
pub fn joined_under(rule: Option<RecordJoin>, joined: Option<Ty>, old: Option<Ty>) -> Option<Ty> {
    let Some(joined) = joined else { return old };
    if old.as_ref().is_some_and(|old| same_answer(&joined, old)) {
        return old;
    }
    match rule {
        Some(rule) if rule.joins => Some(joined),
        Some(rule) => {
            rule.withhold();
            old
        }
        None => old,
    }
}

/// `oneRecordOf`: the records `types` may be, as one value. A record nobody
/// can name among them leaves the whole unnamed (unknown stays unknown); a
/// maybe-absent member makes the whole maybe absent. `None` where a member is
/// not a record (`null` included: `IF c THEN r ELSE NULL END` is a value that
/// may be a record, and stays one) or is a closure (`oneOfClosures`'s). The
/// first member itself where it already says everything.
pub fn one_record_of(types: &[Ty]) -> Option<Ty> {
    let mut may_be_absent = false;
    let mut unnamed = false;
    let mut positions: Vec<&Position> = Vec::new();
    for ty in types {
        if is_maybe_absent(Some(ty)) {
            may_be_absent = true;
        }
        let Ty::Record(position) = strip_absent(ty) else { return None };
        match position {
            None => unnamed = true,
            Some(position) if position.is_closure() => return None,
            Some(position) => positions.push(position),
        }
    }
    let first = types.first()?;
    let Ty::Record(first_position) = strip_absent(first) else { return None };
    let joined = if unnamed { None } else { Some(join_positions(&positions)?) };
    let is_first = match &joined {
        None => first_position.is_none(),
        Some(joined) => joined.is_head && first_position.is_some(),
    };
    if is_first && is_maybe_absent(Some(first)) == may_be_absent {
        return Some(first.clone());
    }
    let record = Ty::record(joined.map(|j| j.position));
    Some(if may_be_absent { maybe_absent(record) } else { record })
}

/// What `join_positions` answers, and whether it is its first input itself.
pub struct Joined {
    pub position: Position,
    pub is_head: bool,
}

/// A member being joined: an input still as it came (and which input, `via`
/// its maybe-empty wrapper or not), or a merge's new position.
enum Member<'p> {
    Input { position: &'p Position, index: usize, via_maybe_empty: bool },
    Merged(Box<Position>),
}

impl Member<'_> {
    fn position(&self) -> &Position {
        match self {
            Member::Input { position, .. } => position,
            Member::Merged(position) => position,
        }
    }
}

/// `joinPositions`: the position a value that may be at any of these is — one
/// type where they are one, a `OneOf` where they are not, maybe-empty where
/// any member may be.
pub fn join_positions(positions: &[&Position]) -> Option<Joined> {
    let mut may_be_empty = false;
    let mut members: Vec<Member> = Vec::new();
    fn add<'p>(position: &'p Position, origin: Option<(usize, bool)>, members: &mut Vec<Member<'p>>, may_be_empty: &mut bool) {
        match position {
            Position::MaybeEmpty(of) => {
                *may_be_empty = true;
                let origin = origin.and_then(|(index, via)| (!via).then_some((index, true)));
                add(of, origin, members, may_be_empty);
                return;
            }
            Position::OneOf(of) => {
                of.iter().for_each(|member| add(member, None, members, may_be_empty));
                return;
            }
            _ => {}
        }
        for member in members.iter_mut() {
            match merge_one_type(member.position(), position) {
                Some(Merged::Same) => return,
                Some(Merged::New(merged)) => {
                    *member = Member::Merged(merged);
                    return;
                }
                None => {}
            }
        }
        members.push(match origin {
            Some((index, via_maybe_empty)) => Member::Input { position, index, via_maybe_empty },
            None => Member::Merged(Box::new(position.clone())),
        });
    }
    for (index, position) in positions.iter().enumerate() {
        add(position, Some((index, false)), &mut members, &mut may_be_empty);
    }
    let head = members.first()?;
    if members.len() == 1
        && let Member::Input { index: 0, via_maybe_empty, .. } = head
        && *via_maybe_empty == may_be_empty
    {
        return Some(Joined { position: positions[0].clone(), is_head: true });
    }
    let one = if members.len() == 1 {
        head.position().clone()
    } else {
        Position::OneOf(members.iter().map(|m| m.position().clone()).collect())
    };
    Some(Joined { position: if may_be_empty { Position::MaybeEmpty(Box::new(one)) } else { one }, is_head: false })
}

enum Merged {
    /// The first position already says what both do.
    Same,
    New(Box<Position>),
}

/// `mergeOneType`: two positions as ONE type, where they are one — the same
/// place to start a walk from, keeping what both vouch for.
fn merge_one_type(a: &Position, b: &Position) -> Option<Merged> {
    if std::ptr::eq(a, b) {
        return Some(Merged::Same);
    }
    match (a, b) {
        (Position::Handle(a), Position::Handle(b)) => join_handles(a, b),
        (Position::Extract { node: x, present: p }, Position::Extract { node: y, present: q }) => Rc::ptr_eq(x, y).then(|| {
            let present = shared_present(p, q);
            if present.len() == p.len() { Merged::Same } else { Merged::New(Box::new(Position::Extract { node: x.clone(), present })) }
        }),
        (Position::Position(x), Position::Position(y)) if same_starting_point(a, b) => {
            let present = shared_present(&x.present, &y.present);
            Some(if present.len() == x.present.len() {
                Merged::Same
            } else {
                Merged::New(Box::new(Position::Position(super::position::RecordPosition { present, ..x.clone() })))
            })
        }
        _ => same_starting_point(a, b).then_some(Merged::Same),
    }
}

/// `sharedPresent`: what two guards both proved present.
fn shared_present(a: &BTreeSet<String>, b: &BTreeSet<String>) -> BTreeSet<String> {
    a.intersection(b).cloned().collect()
}

/// `joinHandles`: two write handles of one type, as one — written where both
/// were, a field read as set where every write set it.
fn join_handles(a: &HandlePosition, b: &HandlePosition) -> Option<Merged> {
    if a.identity.is(&b.identity) {
        return Some(Merged::Same);
    }
    if !same_instance(&a.instance, &b.instance) || a.position.is_none() || a.position != b.position {
        return None;
    }
    let same_shape = a.result_shape.len() == b.result_shape.len()
        && a.result_shape.iter().all(|(key, ty)| b.result_shape.get(key).is_some_and(|other| field_type_equals(ty, other)));
    let same_edges = match (&a.edges, &b.edges) {
        (None, None) => true,
        (Some(x), Some(y)) => x.len() == y.len() && x.iter().all(|(key, edge)| y.get(key) == Some(edge)),
        (Some(x), None) | (None, Some(x)) => x.is_empty(),
    };
    let same_landings = match (&a.generic_landings, &b.generic_landings) {
        (None, None) => true,
        (Some(x), Some(y)) => x.len() == y.len() && x.iter().all(|(key, landing)| y.get(key) == Some(landing)),
        (Some(x), None) | (None, Some(x)) => x.is_empty(),
    };
    if !same_shape || !same_edges || !same_landings {
        return None;
    }
    let written = a.written && b.written;
    // No `set_fields` on a written handle means its write vouched for nothing.
    let set_fields = match (&a.set_fields, &b.set_fields) {
        (Some(x), Some(y)) if written => Some(x.intersection(y).cloned().collect()),
        _ => None,
    };
    Some(Merged::New(Box::new(Position::Handle(HandlePosition { written, set_fields, identity: HandleIdentity::default(), ..a.clone() }))))
}

/// `joinFieldTypes`: what a field every member of a `OneOf` carries is —
/// their union: records joined by the union rule, values by `value_union`.
pub fn join_field_types(types: &[Ty]) -> Option<Ty> {
    let first = types.first()?;
    if let Some(records) = one_record_of(types) {
        return Some(records);
    }
    if types.iter().all(|ty| field_type_equals(ty, first)) {
        return Some(first.clone());
    }
    value_union(types)
}
