//! Value types (`FieldType` in checker/catalog.ts) and the operations on them
//! that live in checker/typing.ts: absence, unions, tuples widening to
//! lists, equality, fit (assignability) and the author-facing spelling.
//!
//! The TypeScript spells a scalar as a bare string and a composite as a
//! tagged object; here both are one enum, so every `match` is exhaustive.

use movement_parser::catalog::types::{Composite, FieldType as SchemaFieldType, JsMap, Scalar};

use super::position::{ClosureType, PlaneType, Position, describe_position, positions_match, record_field_types, same_starting_point};

#[derive(Debug, Clone)]
pub enum Ty {
    Text,
    Number,
    Boolean,
    Date,
    Datetime,
    File,
    /// The data top type: every data shape fits it, nothing reads from it.
    Json,
    /// The type of the `null` literal, and of nothing else.
    Absent,
    List { of: Box<Ty>, unordered: bool },
    /// A slot is `None` where its value could not be typed.
    Tuple { of: Vec<Option<Ty>>, rest: Option<TupleRest> },
    /// `shape` is a literal's keys, in JavaScript's key order.
    Dict { of: Box<Ty>, shape: Option<JsMap<Option<Ty>>> },
    Enum { options: Vec<String>, open: Option<OpenEnum> },
    /// `T | absent`. Build with `maybe_absent`, which never nests.
    MaybeAbsent(Box<Ty>),
    /// Build only with `value_union`, which keeps the member set canonical.
    Union(Vec<Ty>),
    /// A record held as a value; `None` is a record nobody can name.
    Record(Option<Box<Position>>),
}

#[derive(Debug, Clone)]
pub struct TupleRest {
    pub at: usize,
    pub of: Option<Box<Ty>>,
}

#[derive(Debug, Clone, Default)]
pub struct OpenEnum {
    pub allow_pattern: Option<String>,
}

impl Ty {
    pub fn list(of: Ty) -> Ty {
        Ty::List { of: Box::new(of), unordered: false }
    }

    pub fn record(position: Option<Position>) -> Ty {
        Ty::Record(position.map(Box::new))
    }

    pub fn is_absent_literal(&self) -> bool {
        matches!(self, Ty::Absent)
    }

    /// An adapter surface's type, as the typing layer holds it.
    pub fn from_schema(schema: &SchemaFieldType) -> Ty {
        match schema {
            SchemaFieldType::Scalar(scalar) => match scalar {
                Scalar::Text => Ty::Text,
                Scalar::Number => Ty::Number,
                Scalar::Boolean => Ty::Boolean,
                Scalar::Date => Ty::Date,
                Scalar::Datetime => Ty::Datetime,
                Scalar::File => Ty::File,
                Scalar::Json => Ty::Json,
                Scalar::Absent => Ty::Absent,
            },
            SchemaFieldType::Composite(composite) => match composite {
                Composite::List { of, unordered } => Ty::List { of: Box::new(Ty::from_schema(of)), unordered: *unordered == Some(true) },
                Composite::Tuple { of, rest } => Ty::Tuple {
                    of: of.iter().map(|slot| slot.as_ref().map(Ty::from_schema)).collect(),
                    rest: rest.as_ref().map(|r| TupleRest { at: r.at.0 as usize, of: r.of.as_deref().map(|t| Box::new(Ty::from_schema(t))) }),
                },
                Composite::Dict { of, shape } => Ty::Dict {
                    of: Box::new(Ty::from_schema(of)),
                    shape: shape.as_ref().map(|s| s.iter().map(|(k, v)| (k.clone(), v.as_ref().map(Ty::from_schema))).collect()),
                },
                Composite::Enum { options, open } => {
                    Ty::Enum { options: options.clone(), open: open.as_ref().map(|o| OpenEnum { allow_pattern: o.allow_pattern.clone() }) }
                }
                Composite::MaybeAbsent { of } => maybe_absent(Ty::from_schema(of)),
                Composite::Union { of } => value_union(&of.iter().map(Ty::from_schema).collect::<Vec<_>>()).unwrap_or(Ty::Json),
                // A schema never declares a record (catalog.ts); one carried here names no position.
                Composite::Record { .. } => Ty::Record(None),
            },
        }
    }

    /// `parseFieldTypeName`: a scalar's surface spelling.
    pub fn from_scalar_name(name: &str) -> Option<Ty> {
        Some(match name {
            "text" => Ty::Text,
            "number" => Ty::Number,
            "boolean" => Ty::Boolean,
            "date" => Ty::Date,
            "datetime" => Ty::Datetime,
            "file" => Ty::File,
            "json" => Ty::Json,
            _ => return None,
        })
    }
}

// ── Absence ──

/// `maybeAbsent`: `T | absent`, flattened.
pub fn maybe_absent(ty: Ty) -> Ty {
    match ty {
        Ty::MaybeAbsent(_) => ty,
        other => Ty::MaybeAbsent(Box::new(other)),
    }
}

pub fn maybe_absent_opt(ty: Option<Ty>) -> Option<Ty> {
    ty.map(maybe_absent)
}

/// `stripAbsent`: the present component.
pub fn strip_absent(ty: &Ty) -> &Ty {
    match ty {
        Ty::MaybeAbsent(of) => of,
        other => other,
    }
}

pub fn is_maybe_absent(ty: Option<&Ty>) -> bool {
    matches!(ty, Some(Ty::MaybeAbsent(_)))
}

// ── Shape predicates ──

pub fn is_enum(ty: Option<&Ty>) -> bool {
    matches!(ty, Some(Ty::Enum { .. }))
}

pub fn is_list(ty: Option<&Ty>) -> bool {
    matches!(ty, Some(Ty::List { .. }))
}

pub fn is_dict(ty: &Ty) -> bool {
    matches!(ty, Ty::Dict { .. })
}

pub fn is_tuple(ty: &Ty) -> bool {
    matches!(ty, Ty::Tuple { .. })
}

/// `isRecordType`: a record, absence aside.
pub fn is_record(ty: Option<&Ty>) -> bool {
    matches!(ty.map(strip_absent), Some(Ty::Record(_)))
}

/// `recordsAlone`: the records a value is, when it is records and nothing
/// else — a record, a union of them, or a tuple of record slots (an edge list).
pub fn records_alone(ty: Option<&Ty>) -> Option<Vec<Ty>> {
    let ty = ty?;
    let variant = strip_absent(ty);
    if let Ty::Record(_) = variant {
        return Some(vec![variant.clone()]);
    }
    let (members, tuple): (Vec<Option<&Ty>>, bool) = match variant {
        Ty::Union(of) => (of.iter().map(Some).collect(), false),
        Ty::Tuple { of, rest } => {
            let mut members: Vec<Option<&Ty>> = of.iter().map(Option::as_ref).collect();
            members.push(rest.as_ref().and_then(|r| r.of.as_deref()));
            (members, true)
        }
        _ => return None,
    };
    let mut found = Vec::new();
    for member in members {
        if member.is_none() && tuple {
            continue;
        }
        found.extend(records_alone(member)?);
    }
    (!found.is_empty()).then_some(found)
}

/// `isCollectionType`: a list or a tuple, absence aside.
pub fn is_collection(ty: Option<&Ty>) -> bool {
    matches!(ty.map(strip_absent), Some(Ty::List { .. } | Ty::Tuple { .. }))
}

// ── Tuples, lists and unions ──

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollectionOrder {
    Ordered,
    Unordered,
    Unknown,
}

/// How a tuple's disagreeing members widen: to their one shared type
/// (`Shared`, before version 3) or to their union (`Union`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Widening {
    Shared,
    Union,
}

pub fn widening_under(version: u32) -> Widening {
    if version < 3 { Widening::Shared } else { Widening::Union }
}

/// `tupleMembers`: every type a tuple's members can have, its run included.
pub fn tuple_members(of: &[Option<Ty>], rest: Option<&TupleRest>) -> Vec<Option<Ty>> {
    let mut members = of.to_vec();
    if let Some(rest) = rest {
        members.push(rest.of.as_deref().cloned());
    }
    members
}

/// `widenTuple`: the list a tuple reads as; `None` when no element can be named.
pub fn widen_tuple(of: &[Option<Ty>], rest: Option<&TupleRest>, widening: Widening) -> Option<Ty> {
    let members: Vec<Option<Ty>> = tuple_members(of, rest).into_iter().map(|m| widen_tuples_by(m, widening)).collect();
    if let Some(shared) = unify_value_types(&members) {
        return Some(Ty::list(shared));
    }
    if widening == Widening::Shared {
        return None;
    }
    let typed: Option<Vec<Ty>> = members.into_iter().collect();
    value_union(&typed?).map(Ty::list)
}

/// `tupleAsList`.
pub fn tuple_as_list(of: &[Option<Ty>], rest: Option<&TupleRest>, version: u32) -> Option<Ty> {
    widen_tuple(of, rest, widening_under(version))
}

/// `widenTuples`: a tuple at the top read as its list, absence kept.
pub fn widen_tuples(ty: Option<Ty>, version: u32) -> Option<Ty> {
    widen_tuples_by(ty, widening_under(version))
}

pub fn widen_tuples_by(ty: Option<Ty>, widening: Widening) -> Option<Ty> {
    let ty = ty?;
    let Ty::Tuple { of, rest } = strip_absent(&ty) else { return Some(ty) };
    let list = widen_tuple(of, rest.as_ref(), widening);
    if is_maybe_absent(Some(&ty)) { maybe_absent_opt(list) } else { list }
}

/// `unwrapList`: through every list (and tuple) to what it holds.
pub fn unwrap_list(ty: &Ty) -> Ty {
    let t = strip_absent(ty);
    match t {
        Ty::List { of, .. } => unwrap_list(of),
        Ty::Tuple { of, rest } => match widen_tuple(of, rest.as_ref(), Widening::Shared) {
            Some(list) => unwrap_list(&list),
            None => t.clone(),
        },
        _ => t.clone(),
    }
}

/// `valueUnion`: `A | B | …` in its canonical form. `None` for a mixture of
/// records and values, or no members.
pub fn value_union(types: &[Ty]) -> Option<Ty> {
    if types.is_empty() {
        return None;
    }
    let mut absent = false;
    let mut flat: Vec<Ty> = Vec::new();
    fn add(ty: &Ty, absent: &mut bool, flat: &mut Vec<Ty>) {
        if is_maybe_absent(Some(ty)) {
            *absent = true;
        }
        match strip_absent(ty) {
            Ty::Absent => *absent = true,
            Ty::Union(members) => members.iter().for_each(|m| add(m, absent, flat)),
            present => flat.push(present.clone()),
        }
    }
    types.iter().for_each(|t| add(t, &mut absent, &mut flat));
    let with_absence = |one: Ty| if absent { maybe_absent(one) } else { one };
    if flat.is_empty() {
        return Some(Ty::Absent);
    }
    let records = flat.iter().filter(|m| is_record(Some(m))).count();
    if records > 0 {
        if records != flat.len() {
            return None;
        }
        let members: Vec<Option<Ty>> = flat.into_iter().map(Some).collect();
        return unify_value_types(&members).map(with_absence);
    }
    let kept: Vec<Ty> = flat
        .iter()
        .enumerate()
        .filter(|(i, member)| {
            !flat.iter().enumerate().any(|(j, other)| j != *i && member_absorbs(other, member) && (j < *i || !member_absorbs(member, other)))
        })
        .map(|(_, m)| m.clone())
        .collect();
    if kept.len() == 1 {
        return Some(with_absence(kept.into_iter().next().unwrap_or(Ty::Absent)));
    }
    let mut keyed: Vec<(String, Ty)> = kept.into_iter().map(|m| (describe_field_type(&m), m)).collect();
    keyed.sort_by(|a, b| a.0.cmp(&b.0));
    Some(with_absence(Ty::Union(keyed.into_iter().map(|(_, m)| m).collect())))
}

fn member_absorbs(wide: &Ty, narrow: &Ty) -> bool {
    if field_type_equals(wide, narrow) {
        return true;
    }
    match wide {
        Ty::Json => is_data_shaped(narrow),
        Ty::Text => is_enum(Some(narrow)),
        _ => false,
    }
}

/// `unionMembers`: a union's members, or the one type; absence peeled.
pub fn union_members(ty: &Ty) -> Vec<Ty> {
    match strip_absent(ty) {
        Ty::Union(members) => members.clone(),
        present => vec![present.clone()],
    }
}

/// `armsUnion`: what the arms of a choice may hold, side by side. Not a
/// canonical union: a walk input, never a type a reader sees.
pub fn arms_union(arms: &[Option<Ty>]) -> Option<Ty> {
    let known: Vec<Ty> = arms.iter().flatten().cloned().collect();
    if known.is_empty() {
        return None;
    }
    if arms.len() == 1 { known.into_iter().next() } else { Some(Ty::Union(known)) }
}

/// `unifyValueTypes`: the one type every member shares.
pub fn unify_value_types(types: &[Option<Ty>]) -> Option<Ty> {
    let first = types.first()?.as_ref()?;
    if types.iter().all(|t| t.as_ref().is_some_and(|t| field_type_equals(t, first))) {
        return Some(first.clone());
    }
    if types.iter().all(|t| is_record(t.as_ref())) {
        return Some(Ty::Record(None));
    }
    let unshaped: Vec<Option<Ty>> = types.iter().map(|t| t.as_ref().map(without_shape)).collect();
    let head = unshaped[0].as_ref()?;
    if unshaped.iter().all(|t| t.as_ref().is_some_and(|t| field_type_equals(t, head))) {
        return Some(head.clone());
    }
    None
}

fn without_shape(ty: &Ty) -> Ty {
    match strip_absent(ty) {
        Ty::Dict { of, .. } => {
            let unshaped = Ty::Dict { of: of.clone(), shape: None };
            if is_maybe_absent(Some(ty)) { maybe_absent(unshaped) } else { unshaped }
        }
        _ => ty.clone(),
    }
}

/// `mixedTupleMessage`: a tuple of records and values read as a list.
pub fn mixed_tuple_message(ty: Option<&Ty>) -> Option<String> {
    let Ty::Tuple { of, rest } = strip_absent(ty?) else { return None };
    let members: Vec<Ty> = tuple_members(of, rest.as_ref()).into_iter().flatten().collect();
    let record = members.iter().find(|m| is_record(Some(m)));
    let value = members.iter().find(|m| !is_record(Some(m)) && !matches!(strip_absent(m), Ty::Absent));
    if let (Some(record), Some(value)) = (record, value) {
        let shown = widen_tuples_by(Some(value.clone()), Widening::Shared).unwrap_or_else(|| value.clone());
        return Some(format!(
            "a list holds one kind of thing, and this one holds both: {} is a record, and another member is {}. A tuple may hold both — read one slot with 'AT(t, 0)' — but read as a list it may not. Build a list of records and walk it ('both = [one, two]' … 'both-[c:company]-> {{ … }}'), or read the records' fields first and build a list of the values.",
            describe_field_type(strip_absent(record)),
            describe_field_type(&shown)
        ));
    }
    members.iter().find_map(|m| mixed_tuple_message(Some(m)))
}

/// `collectionElementOf`: what one member of a collection is.
pub fn collection_element_of(ty: &Ty) -> Option<Ty> {
    match strip_absent(ty) {
        Ty::List { of, .. } => Some((**of).clone()),
        Ty::Tuple { of, rest } => match widen_tuple(of, rest.as_ref(), Widening::Shared)? {
            Ty::List { of, .. } => Some(*of),
            _ => None,
        },
        Ty::Union(members) => {
            let elements: Option<Vec<Ty>> = members.iter().map(collection_element_of).collect();
            value_union(&elements?)
        }
        _ => None,
    }
}

/// `collectionOrderOf`.
pub fn collection_order_of(ty: Option<&Ty>) -> CollectionOrder {
    match ty.map(strip_absent) {
        Some(Ty::Tuple { .. }) => CollectionOrder::Ordered,
        Some(Ty::List { unordered, .. }) => {
            if *unordered {
                CollectionOrder::Unordered
            } else {
                CollectionOrder::Ordered
            }
        }
        _ => CollectionOrder::Unknown,
    }
}

/// `listOf`.
pub fn list_of(of: Ty, ordering: CollectionOrder) -> Ty {
    Ty::List { of: Box::new(of), unordered: ordering == CollectionOrder::Unordered }
}

/// `tupleSlotType`: what `AT(t, index)` reads off a tuple.
pub fn tuple_slot_type(of: &[Option<Ty>], rest: Option<&TupleRest>, index: Option<i64>, version: u32) -> Option<Ty> {
    let any_of = |members: Vec<Option<Ty>>| -> Option<Ty> {
        match tuple_as_list(&members, None, version)? {
            Ty::List { of, .. } => Some(maybe_absent(*of)),
            _ => None,
        }
    };
    let Some(index) = index else { return any_of(tuple_members(of, rest)) };
    let len = of.len() as i64;
    let Some(rest) = rest else {
        let resolved = if index < 0 { len + index } else { index };
        if resolved < 0 || resolved >= len {
            return Some(Ty::Absent);
        }
        return of[resolved as usize].clone();
    };
    let at = rest.at as i64;
    let run = rest.of.as_deref().cloned();
    if index >= 0 {
        if index < at {
            return of.get(index as usize).cloned().flatten();
        }
        let mut members = vec![run];
        members.extend(of[rest.at.min(of.len())..].iter().cloned());
        return any_of(members);
    }
    let from_end = len + index;
    if from_end >= at {
        return if from_end >= 0 { of.get(from_end as usize).cloned().flatten() } else { None };
    }
    let mut members: Vec<Option<Ty>> = of[..rest.at.min(of.len())].to_vec();
    members.push(run);
    any_of(members)
}

/// `coalesceType`: `COALESCE(a, b, …)` typed as TypeScript types `a ?? b`.
pub fn coalesce_type(args: &[Option<Ty>]) -> Option<Ty> {
    let typed: Vec<&Ty> = args.iter().map(Option::as_ref).collect::<Option<_>>()?;
    let valued: Vec<&Ty> = typed.into_iter().filter(|t| !matches!(t, Ty::Absent)).collect();
    if valued.is_empty() {
        return Some(Ty::Absent);
    }
    let kinds: Vec<&Ty> = valued.iter().map(|t| strip_absent(t)).collect();
    let shared = if kinds.iter().all(|k| field_type_equals(k, kinds[0])) { Some(kinds[0].clone()) } else { None };
    if valued.iter().any(|t| !is_maybe_absent(Some(t))) {
        return shared;
    }
    match shared {
        Some(shared) => Some(maybe_absent(shared)),
        None => valued.iter().find(|t| is_maybe_absent(Some(t))).map(|t| (*t).clone()),
    }
}

/// `multiType`: `MULTI(a, b, …)` — a list where the members share a record or a file.
pub fn multi_type(args: &[Option<Ty>]) -> Option<Ty> {
    let mut members: Vec<Option<Ty>> = Vec::new();
    for arg in args {
        let present = strip_absent(arg.as_ref()?);
        match present {
            Ty::Absent => continue,
            Ty::List { of, .. } => members.push(Some(strip_absent(of).clone())),
            Ty::Tuple { of, rest } => {
                members.extend(of.iter().map(|slot| slot.as_ref().map(|s| strip_absent(s).clone())));
                if let Some(run) = rest.as_ref().and_then(|r| r.of.as_deref()) {
                    members.push(Some(strip_absent(run).clone()));
                }
            }
            other => members.push(Some(other.clone())),
        }
    }
    let shared = unify_value_types(&members)?;
    handle_within(Some(&shared), &HeldWalk::default())?;
    Some(list_of(shared, CollectionOrder::Ordered))
}

// ── Kinds and categories ──

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaseKind {
    Text,
    Number,
    Boolean,
    Date,
    Datetime,
    File,
    Json,
    Absent,
    Record,
}

/// `baseKinds`: the base kind of each member a value may be.
pub fn base_kinds(ty: &Ty) -> Vec<BaseKind> {
    union_members(&unwrap_list(ty)).iter().map(member_base_kind).collect()
}

/// `baseKind`: `None` is the TypeScript's `'mixed'`.
pub fn base_kind(ty: &Ty) -> Option<BaseKind> {
    let kinds = base_kinds(ty);
    if kinds.iter().all(|k| *k == kinds[0]) { kinds.first().copied() } else { None }
}

fn member_base_kind(ty: &Ty) -> BaseKind {
    match unwrap_list(ty) {
        Ty::Record(_) => BaseKind::Record,
        Ty::Tuple { .. } | Ty::Dict { .. } | Ty::Union(_) => BaseKind::Json,
        Ty::Enum { .. } | Ty::MaybeAbsent(_) | Ty::List { .. } | Ty::Text => BaseKind::Text,
        Ty::Number => BaseKind::Number,
        Ty::Boolean => BaseKind::Boolean,
        Ty::Date => BaseKind::Date,
        Ty::Datetime => BaseKind::Datetime,
        Ty::File => BaseKind::File,
        Ty::Json => BaseKind::Json,
        Ty::Absent => BaseKind::Absent,
    }
}

/// `holdsOneValue`: each value of this type stands alone, not several.
pub fn holds_one_value(ty: &Ty) -> bool {
    match strip_absent(ty) {
        Ty::List { .. } | Ty::Tuple { .. } | Ty::Json => false,
        Ty::Union(members) => members.iter().all(holds_one_value),
        Ty::Text | Ty::Number | Ty::Boolean | Ty::Date | Ty::Datetime | Ty::File | Ty::Absent | Ty::Dict { .. } | Ty::Enum { .. } | Ty::Record(_) | Ty::MaybeAbsent(_) => true,
    }
}

/// `isDataShaped`: no record and no file anywhere inside.
pub fn is_data_shaped(ty: &Ty) -> bool {
    handle_within(Some(ty), &HeldWalk::default()).is_none()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComparisonCategory {
    Temporal,
    Numeric,
    Textual,
    Boolean,
    Structural,
    Record,
    Opaque,
    Absent,
}

/// `comparisonCategory`.
pub fn comparison_category(ty: &Ty) -> ComparisonCategory {
    match strip_absent(ty) {
        Ty::Record(_) => ComparisonCategory::Record,
        Ty::Enum { .. } | Ty::Text => ComparisonCategory::Textual,
        Ty::List { .. } | Ty::Tuple { .. } | Ty::Dict { .. } | Ty::MaybeAbsent(_) | Ty::File => ComparisonCategory::Structural,
        Ty::Date | Ty::Datetime => ComparisonCategory::Temporal,
        Ty::Number => ComparisonCategory::Numeric,
        Ty::Boolean => ComparisonCategory::Boolean,
        Ty::Json => ComparisonCategory::Opaque,
        Ty::Absent => ComparisonCategory::Absent,
        Ty::Union(members) => {
            let categories: Vec<ComparisonCategory> = members.iter().map(comparison_category).collect();
            if categories.iter().all(|c| *c == categories[0]) { categories[0] } else { ComparisonCategory::Structural }
        }
    }
}

/// `membersComparable`.
pub fn members_comparable(left: &Ty, right: &Ty) -> bool {
    let category = comparison_category(left);
    category == comparison_category(right) && (category != ComparisonCategory::Structural || field_type_equals(left, right))
}

// ── Handles held inside a value ──

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeldStep {
    Key(String),
    Slot(usize),
    Member,
}

/// `HeldHandle`: a record or a file found inside a value, and where.
#[derive(Debug, Clone)]
pub struct HeldHandle {
    pub steps: Vec<HeldStep>,
    pub handle: Ty,
    /// Found in one member of a union: the value may hold it.
    pub may: bool,
}

impl HeldHandle {
    pub fn is_file(&self) -> bool {
        matches!(self.handle, Ty::File)
    }
}

/// `HeldWalk`: the handle kinds a destination takes (those are not reported).
#[derive(Clone, Default)]
pub struct HeldWalk {
    pub steps: Vec<HeldStep>,
    pub accepts_record: bool,
    pub accepts_file: bool,
    /// `HeldWalk.inspect`: for a target that takes an object only on terms
    /// (an extraction prompt renders a record as its fields, which must be in
    /// hand) — asked of EVERY accepted object the walk meets, at any depth
    /// and in any arm, instead of passing over it. What it answers is what
    /// the walk found.
    pub inspect: Option<InspectHeld>,
}

/// What `HeldWalk::inspect` asks of an accepted object.
pub type InspectHeld = std::rc::Rc<dyn Fn(HeldHandle) -> Option<HeldHandle>>;

impl std::fmt::Debug for HeldWalk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HeldWalk")
            .field("steps", &self.steps)
            .field("accepts_record", &self.accepts_record)
            .field("accepts_file", &self.accepts_file)
            .field("inspect", &self.inspect.is_some())
            .finish()
    }
}

/// `HandleKind`s a target takes (`ReadonlySet<HandleKind>`).
#[derive(Debug, Clone, Copy, Default)]
pub struct HandleKinds {
    pub record: bool,
    pub file: bool,
}

impl HandleKinds {
    /// `handleKindsTaken(target)`.
    pub fn taken_by(target: Option<&Ty>) -> HandleKinds {
        let (record, file) = target.map(kinds_held_by).unwrap_or((false, false));
        HandleKinds { record, file }
    }

    /// `heldWalk(kinds)`.
    pub fn walk(self) -> HeldWalk {
        HeldWalk { steps: Vec::new(), accepts_record: self.record, accepts_file: self.file, inspect: None }
    }
}

impl HeldWalk {
    pub fn into(&self, step: HeldStep) -> HeldWalk {
        let mut next = self.clone();
        next.steps.push(step);
        next
    }

    /// `heldWalk(FILES_ONLY)`.
    pub fn files_only() -> HeldWalk {
        HeldWalk { accepts_file: true, ..HeldWalk::default() }
    }

    /// `heldWalk(handleKindsTaken(target))`: the kinds `target` holds.
    pub fn taken_by(target: Option<&Ty>) -> HeldWalk {
        let (record, file) = target.map(kinds_held_by).unwrap_or((false, false));
        HeldWalk { steps: Vec::new(), accepts_record: record, accepts_file: file, inspect: None }
    }

    /// An accepted object, handed to the walk's inspection if it has one (`acceptedHandle`).
    fn accepted(&self, handle: Ty) -> Option<HeldHandle> {
        self.inspect.as_ref().and_then(|inspect| inspect(HeldHandle { steps: self.steps.clone(), handle, may: false }))
    }
}

fn kinds_held_by(ty: &Ty) -> (bool, bool) {
    let merge = |members: &mut dyn Iterator<Item = &Ty>| members.map(kinds_held_by).fold((false, false), |a, b| (a.0 || b.0, a.1 || b.1));
    match strip_absent(ty) {
        Ty::Record(_) => (true, false),
        Ty::File => (false, true),
        Ty::List { of, .. } => kinds_held_by(of),
        Ty::Tuple { of, rest } => merge(&mut of.iter().flatten().chain(rest.iter().filter_map(|r| r.of.as_deref()))),
        Ty::Dict { of, shape } => merge(&mut shape.iter().flat_map(|s| s.values().flatten()).chain(std::iter::once(&**of))),
        Ty::Union(members) => merge(&mut members.iter()),
        _ => (false, false),
    }
}

/// `showsMoreHandles`: does `wider` hold a kind of engine object `ty` does not show?
pub fn shows_more_handles(wider: &Ty, ty: Option<&Ty>) -> bool {
    let (record, file) = kinds_held_by(wider);
    let (shown_record, shown_file) = ty.map(kinds_held_by).unwrap_or((false, false));
    (record && !shown_record) || (file && !shown_file)
}

/// `handleWithin`: the first record or file inside `ty` the walk does not accept.
pub fn handle_within(ty: Option<&Ty>, walk: &HeldWalk) -> Option<HeldHandle> {
    match strip_absent(ty?) {
        Ty::Record(position) if walk.accepts_record => walk.accepted(Ty::Record(position.clone())),
        Ty::Record(position) => Some(HeldHandle { steps: walk.steps.clone(), handle: Ty::Record(position.clone()), may: false }),
        Ty::File if walk.accepts_file => walk.accepted(Ty::File),
        Ty::File => Some(HeldHandle { steps: walk.steps.clone(), handle: Ty::File, may: false }),
        list @ (Ty::List { .. } | Ty::Tuple { .. }) => handle_among_members(Some(list), walk, HeldStep::Slot),
        Ty::Dict { of, shape } => {
            for (key, value) in shape.iter().flat_map(|s| s.iter()) {
                if let Some(held) = handle_within(value.as_ref(), &walk.into(HeldStep::Key(key.clone()))) {
                    return Some(held);
                }
            }
            handle_within(Some(of), &walk.into(HeldStep::Member))
        }
        Ty::Union(members) => members.iter().find_map(|m| handle_within(Some(m), walk)).map(|held| HeldHandle { may: true, ..held }),
        _ => None,
    }
}

/// `handleAmongMembers`: a handle among a collection's members, each one
/// `step_for(slot)` further into the walk (a spread splices members, so it
/// asks with every slot unnumbered: `|_| HeldStep::Member`).
pub fn handle_among_members(ty: Option<&Ty>, walk: &HeldWalk, step_for: fn(usize) -> HeldStep) -> Option<HeldHandle> {
    match strip_absent(ty?) {
        Ty::List { of, .. } => handle_within(Some(of), &walk.into(HeldStep::Member)),
        Ty::Tuple { of, rest } => {
            for (index, slot) in of.iter().enumerate() {
                if let Some(held) = handle_within(slot.as_ref(), &walk.into(step_for(index))) {
                    return Some(held);
                }
            }
            handle_within(rest.as_ref().and_then(|r| r.of.as_deref()), &walk.into(HeldStep::Member))
        }
        Ty::Union(members) => members.iter().find_map(|m| handle_among_members(Some(m), walk, step_for)).map(|held| HeldHandle { may: true, ..held }),
        _ => None,
    }
}

/// `handleRefusedBy`: a handle in `value` that `target` does not take.
pub fn handle_refused_by(value: Option<&Ty>, target: Option<&Ty>) -> Option<HeldHandle> {
    handle_within(value, &HeldWalk::taken_by(target))
}

/// `handleSpreadOf`: a handle a `...` spread of `ty` would copy.
pub fn handle_spread_of(ty: Option<&Ty>, walk: &HeldWalk) -> Option<HeldHandle> {
    match strip_absent(ty?) {
        Ty::Record(position) => {
            let fields = record_field_types(position.as_deref()?)?;
            fields.iter().find_map(|(field, field_ty)| handle_within(field_ty.as_ref(), &walk.into(HeldStep::Key(field.clone()))))
        }
        Ty::Union(members) => members.iter().find_map(|m| handle_spread_of(Some(m), walk)).map(|held| HeldHandle { may: true, ..held }),
        Ty::File => None,
        _ => handle_within(ty, walk),
    }
}

/// `spellHeldSteps`.
pub fn spell_held_steps(steps: &[HeldStep]) -> String {
    steps
        .iter()
        .map(|step| match step {
            HeldStep::Key(key) => format!(".{}", crate::families::names::spell_name(key)),
            HeldStep::Slot(index) => format!("[{index}]"),
            HeldStep::Member => "[…]".to_string(),
        })
        .collect()
}

// ── Records inside values ──

/// `recordIn`: the record a value is or holds, through lists and tuples;
/// the inner `None` is a record nobody can name.
pub fn record_in(ty: Option<&Ty>) -> Option<Option<Position>> {
    match strip_absent(ty?) {
        Ty::Tuple { of, rest } => record_in(widen_tuple(of, rest.as_ref(), Widening::Shared).as_ref()),
        Ty::List { of, .. } => record_in(Some(of)),
        Ty::Record(position) => Some(position.as_deref().cloned()),
        _ => None,
    }
}

/// `recordHeadPosition`: the position a walk off this value starts from.
pub fn record_head_position(ty: Option<&Ty>) -> Option<Position> {
    record_in(ty).flatten()
}

/// `holdsRecords`.
pub fn holds_records(ty: Option<&Ty>) -> bool {
    record_in(ty).is_some()
}

/// `valuesBesideRecord`: the value members of a union that also holds a record.
pub fn values_beside_record(ty: Option<&Ty>) -> Vec<Ty> {
    let Some(ty) = ty else { return Vec::new() };
    let mut members = Vec::new();
    fn add(member: &Ty, members: &mut Vec<Ty>) {
        match strip_absent(member) {
            Ty::Union(of) => of.iter().for_each(|m| add(m, members)),
            stripped => members.push(stripped.clone()),
        }
    }
    add(ty, &mut members);
    let present: Vec<Ty> = members.into_iter().filter(|m| !matches!(m, Ty::Absent)).collect();
    if present.iter().any(|m| matches!(m, Ty::Record(_))) { present.into_iter().filter(|m| !matches!(m, Ty::Record(_))).collect() } else { Vec::new() }
}

/// `mixesRecordWithValue`: the mixed record/value case of a `COALESCE` or an `IF`.
pub fn mixes_record_with_value(ty: Option<&Ty>) -> bool {
    !values_beside_record(ty).is_empty()
}

/// `recordValueOf`: a position held as a value.
pub fn record_value_of(position: Option<&Position>) -> Option<Ty> {
    let position = position?;
    let record = Ty::record(Some(position.clone()));
    Some(if matches!(position, Position::MaybeEmpty(_)) { maybe_absent(record) } else { record })
}

// ── Equality and fit ──

fn slots_agree(left: &[Option<Ty>], right: &[Option<Ty>]) -> bool {
    left.len() == right.len()
        && left.iter().zip(right).all(|(l, r)| match (l, r) {
            (Some(l), Some(r)) => field_type_equals(l, r),
            (None, None) => true,
            _ => false,
        })
}

/// `fieldTypeEquals`: absence aside at the top, structurally.
pub fn field_type_equals(a: &Ty, b: &Ty) -> bool {
    let (left, right) = (strip_absent(a), strip_absent(b));
    match (left, right) {
        (Ty::Text, Ty::Text)
        | (Ty::Number, Ty::Number)
        | (Ty::Boolean, Ty::Boolean)
        | (Ty::Date, Ty::Date)
        | (Ty::Datetime, Ty::Datetime)
        | (Ty::File, Ty::File)
        | (Ty::Json, Ty::Json)
        | (Ty::Absent, Ty::Absent) => true,
        (Ty::List { of: l, .. }, Ty::List { of: r, .. }) => field_type_equals(l, r),
        (Ty::Tuple { of: l, rest: lr }, Ty::Tuple { of: r, rest: rr }) => {
            if !slots_agree(l, r) {
                return false;
            }
            match (lr, rr) {
                (None, None) => true,
                (Some(lr), Some(rr)) => lr.at == rr.at && slots_agree(&[lr.of.as_deref().cloned()], &[rr.of.as_deref().cloned()]),
                _ => false,
            }
        }
        (Ty::Dict { of: lo, shape: ls }, Ty::Dict { of: ro, shape: rs }) => {
            if !field_type_equals(lo, ro) {
                return false;
            }
            match (ls, rs) {
                (None, None) => true,
                (Some(ls), Some(rs)) => {
                    ls.len() == rs.len()
                        && ls.iter().all(|(key, slot)| match rs.get(key) {
                            None => false,
                            Some(other) => match (slot, other) {
                                (Some(s), Some(o)) => field_type_equals(s, o),
                                (None, None) => true,
                                _ => false,
                            },
                        })
                }
                _ => false,
            }
        }
        (Ty::Record(l), Ty::Record(r)) => match (l, r) {
            (None, None) => true,
            (Some(l), Some(r)) => same_starting_point(l, r),
            _ => false,
        },
        (Ty::Enum { options: l, .. }, Ty::Enum { options: r, .. }) => l == r,
        (Ty::MaybeAbsent(l), Ty::MaybeAbsent(r)) => field_type_equals(l, r),
        (Ty::Union(l), Ty::Union(r)) => l.len() == r.len() && l.iter().all(|m| r.iter().any(|o| field_type_equals(m, o))),
        _ => false,
    }
}

/// `fieldTypeCompatible`: whether a value may be written into a field of `target`.
pub fn field_type_compatible(value: &Ty, target: &Ty) -> bool {
    if handle_refused_by(Some(value), Some(target)).is_some() {
        return false;
    }
    let Some(written) = widen_tuples_by(Some(value.clone()), Widening::Shared) else { return true };
    let targets = base_kinds(target);
    base_kinds(&written).iter().all(|v| targets.iter().any(|t| base_kind_writable(*v, *t)))
}

fn base_kind_writable(v: BaseKind, t: BaseKind) -> bool {
    use BaseKind as K;
    if v == K::Absent {
        return true;
    }
    if v == K::Record || t == K::Record {
        return false;
    }
    if t == K::Json {
        return v != K::File;
    }
    if v == K::Json {
        return false;
    }
    t == K::Text || v == t || (v == K::Text && t == K::Date)
}

fn closure_of_record(ty: &Ty) -> Option<&ClosureType> {
    match ty {
        Ty::Record(Some(position)) => match &**position {
            Position::Closure(closure) => Some(closure),
            _ => None,
        },
        _ => None,
    }
}

/// `mayBeClosure`.
pub fn may_be_closure(ty: Option<&Ty>) -> bool {
    match ty.map(strip_absent) {
        Some(Ty::Union(members)) => members.iter().any(|m| may_be_closure(Some(m))),
        Some(t) => closure_of_record(t).is_some(),
        None => false,
    }
}

/// `closureNotDataMessage`.
pub fn closure_not_data_message(where_: &str) -> String {
    format!(
        "{where_} a closure, and a closure is not data — keep it in a variable ('g = …', called as 'g()') or pass it as an argument ('all(f, g)', 'MAP(xs, (x) => …)')"
    )
}

/// `fieldAssignable`: TypeScript's `source extends target`, absence aside.
pub fn field_assignable(source: &Ty, target: &Ty) -> bool {
    let source = strip_absent(source);
    let target = strip_absent(target);
    if field_type_equals(source, target) {
        return true;
    }
    if let (Some(s), Some(t)) = (closure_of_record(source), closure_of_record(target)) {
        return closure_assignable(s, t);
    }
    if let Ty::List { of: target_of, .. } = target
        && closure_of_record(strip_absent(target_of)).is_some()
    {
        let source_list = match source {
            Ty::Tuple { of, rest } => widen_tuple(of, rest.as_ref(), Widening::Shared),
            other => Some(other.clone()),
        };
        if let Some(Ty::List { of, .. }) = source_list {
            return field_assignable(&of, target_of);
        }
    }
    if handle_refused_by(Some(source), Some(target)).is_some() {
        return false;
    }
    if let Ty::Union(members) = source {
        return members.iter().all(|m| field_assignable(m, target));
    }
    if let Ty::Union(members) = target {
        return members.iter().any(|m| field_assignable(source, m));
    }
    if let (Ty::Tuple { of, rest }, false) = (source, is_tuple(target)) {
        return widen_tuple(of, rest.as_ref(), Widening::Shared).is_none_or(|list| field_assignable(&list, target));
    }
    if matches!(target, Ty::Json) {
        return is_data_shaped(source);
    }
    if matches!(source, Ty::Json) {
        return false;
    }
    if base_kind(source) == Some(BaseKind::Record) || base_kind(target) == Some(BaseKind::Record) {
        return false;
    }
    if matches!(target, Ty::Text) && (matches!(source, Ty::Text) || is_enum(Some(source))) {
        return true;
    }
    if is_enum(Some(target)) {
        return false;
    }
    let category = comparison_category(source);
    category == comparison_category(target) && category != ComparisonCategory::Structural
}

/// `planeFits`: a value on either plane against what a slot accepts.
pub fn plane_fits(source: &PlaneType, target: &PlaneType) -> bool {
    if let Some(target_field) = &target.field {
        if let Some(source_field) = &source.field {
            return field_assignable(source_field, target_field);
        }
        return source.pos.as_deref().is_none_or(|p| record_value_of(Some(p)).is_some_and(|r| field_assignable(&r, target_field)));
    }
    if let Some(target_pos) = &target.pos {
        if let Some(source_pos) = &source.pos {
            return positions_match(source_pos, target_pos) != Some(false);
        }
        return source.field.as_ref().is_none_or(|f| is_record(Some(f)));
    }
    true
}

/// `closureAssignable`: parameters contravariant, the return covariant.
pub fn closure_assignable(source: &ClosureType, target: &ClosureType) -> bool {
    if source.params.len() > target.params.len() {
        return false;
    }
    if !source.params.iter().zip(&target.params).all(|(param, target_param)| plane_fits(&target_param.plane, &param.plane)) {
        return false;
    }
    if !target.returns.returns {
        return true;
    }
    if !source.returns.returns {
        return false;
    }
    let returned = match &source.returns.may_hold {
        Some(held) => PlaneType { field: Some(held.clone()), pos: None },
        None => source.returns.plane.clone(),
    };
    plane_fits(&returned, &target.returns.plane)
}

// ── Spelling ──

/// `describeFieldType`: a type in the author's words.
pub fn describe_field_type(ty: &Ty) -> String {
    match ty {
        Ty::Absent => "null".to_string(),
        Ty::Text => "text".to_string(),
        Ty::Number => "number".to_string(),
        Ty::Boolean => "boolean".to_string(),
        Ty::Date => "date".to_string(),
        Ty::Datetime => "datetime".to_string(),
        Ty::File => "file".to_string(),
        Ty::Json => "json".to_string(),
        Ty::MaybeAbsent(of) => format!("{} (or absent)", describe_member(of)),
        Ty::List { of, .. } => format!("list of {}", describe_member(of)),
        Ty::Union(members) => members.iter().map(describe_field_type).collect::<Vec<_>>().join(" | "),
        Ty::Tuple { of, rest } => {
            let mut slots: Vec<String> = of.iter().map(|slot| slot.as_ref().map_or("?".to_string(), describe_field_type)).collect();
            if let Some(rest) = rest {
                let run = rest.of.as_deref().map_or("?".to_string(), describe_member);
                slots.insert(rest.at.min(slots.len()), format!("...list of {run}"));
            }
            format!("[{}]", slots.join(", "))
        }
        Ty::Dict { of, shape } => match shape {
            Some(shape) => {
                let keys: Vec<String> =
                    shape.iter().map(|(key, slot)| format!("{key}: {}", slot.as_ref().map_or("?".to_string(), describe_field_type))).collect();
                format!("{{ {} }}", keys.join(", "))
            }
            None => format!("dict of {}", describe_member(of)),
        },
        Ty::Record(position) => position.as_deref().map_or("a record".to_string(), describe_position),
        Ty::Enum { options, open } => {
            if open.is_some() {
                format!("known values ({}, …)", options.join(" | "))
            } else if options.is_empty() {
                "enum (no available values)".to_string()
            } else {
                format!("enum ({})", options.join(" | "))
            }
        }
    }
}

fn describe_member(ty: &Ty) -> String {
    let described = describe_field_type(ty);
    if matches!(ty, Ty::Union(_)) { format!("({described})") } else { described }
}
