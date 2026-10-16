//! Value types (`FieldType` in checker/catalog.ts) and the operations on them
//! that live in checker/typing.ts: absence, unions, tuples widening to
//! lists, equality, fit (assignability) and the author-facing spelling.
//!
//! The TypeScript spells a scalar as a bare string and a composite as a
//! tagged object; here both are one enum, so every `match` is exhaustive.

use std::collections::HashMap;
use std::rc::Rc;

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
    /// What a value that never arrives has (`fail("…")`, from language
    /// version 5): TypeScript's `never`. It fits every type, and a union with
    /// it is the union's other members.
    Never,
    List { of: Rc<Ty>, unordered: bool },
    /// A slot is `None` where its value could not be typed.
    Tuple { of: Rc<Vec<Option<Ty>>>, rest: Option<TupleRest> },
    /// `shape` is a literal's keys, in JavaScript's key order.
    Dict { of: Rc<Ty>, shape: Option<Rc<JsMap<Option<Ty>>>> },
    Enum { options: Vec<String>, open: Option<OpenEnum> },
    /// `T | absent`. Build with `maybe_absent`, which never nests.
    MaybeAbsent(Rc<Ty>),
    /// Build only with `value_union`, which keeps the member set canonical.
    Union(Rc<Vec<Ty>>),
    /// A record held as a value; `None` is a record nobody can name.
    Record(Option<Rc<Position>>),
}

#[derive(Debug, Clone)]
pub struct TupleRest {
    pub at: usize,
    pub of: Option<Rc<Ty>>,
}

#[derive(Debug, Clone, Default)]
pub struct OpenEnum {
    pub allow_pattern: Option<String>,
}

impl Ty {
    pub fn list(of: Ty) -> Ty {
        Ty::List { of: Rc::new(of), unordered: false }
    }

    pub fn record(position: Option<Position>) -> Ty {
        Ty::Record(position.map(Rc::new))
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
                Scalar::Never => Ty::Never,
            },
            SchemaFieldType::Composite(composite) => match composite {
                Composite::List { of, unordered } => Ty::List { of: Rc::new(Ty::from_schema(of)), unordered: *unordered == Some(true) },
                Composite::Tuple { of, rest } => Ty::Tuple {
                    of: Rc::new(of.iter().map(|slot| slot.as_ref().map(Ty::from_schema)).collect()),
                    rest: rest.as_ref().map(|r| TupleRest { at: r.at.0 as usize, of: r.of.as_deref().map(|t| Rc::new(Ty::from_schema(t))) }),
                },
                Composite::Dict { of, shape } => Ty::Dict {
                    of: Rc::new(Ty::from_schema(of)),
                    shape: shape.as_ref().map(|s| Rc::new(s.iter().map(|(k, v)| (k.clone(), v.as_ref().map(Ty::from_schema))).collect())),
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

    /// The inverse of `from_schema`, for a type the program spelled where the
    /// TypeScript holds one surface for both (an extracted record's fields
    /// as a write shape). A record keeps no position, as a schema's never does.
    pub fn to_schema(&self) -> SchemaFieldType {
        let composite = match self {
            Ty::Text => return SchemaFieldType::Scalar(Scalar::Text),
            Ty::Number => return SchemaFieldType::Scalar(Scalar::Number),
            Ty::Boolean => return SchemaFieldType::Scalar(Scalar::Boolean),
            Ty::Date => return SchemaFieldType::Scalar(Scalar::Date),
            Ty::Datetime => return SchemaFieldType::Scalar(Scalar::Datetime),
            Ty::File => return SchemaFieldType::Scalar(Scalar::File),
            Ty::Json => return SchemaFieldType::Scalar(Scalar::Json),
            Ty::Absent => return SchemaFieldType::Scalar(Scalar::Absent),
            Ty::Never => return SchemaFieldType::Scalar(Scalar::Never),
            Ty::List { of, unordered } => Composite::List { of: Box::new(of.to_schema()), unordered: unordered.then_some(true) },
            Ty::Tuple { of, rest } => Composite::Tuple {
                of: of.iter().map(|slot| slot.as_ref().map(Ty::to_schema)).collect(),
                rest: rest.as_ref().map(|r| movement_parser::catalog::types::TupleRest {
                    at: movement_parser::tree::JsNumber(r.at as f64),
                    of: r.of.as_deref().map(|t| Box::new(t.to_schema())),
                }),
            },
            Ty::Dict { of, shape } => Composite::Dict {
                of: Box::new(of.to_schema()),
                shape: shape.as_ref().map(|s| s.iter().map(|(k, v)| (k.clone(), v.as_ref().map(Ty::to_schema))).collect()),
            },
            Ty::Enum { options, open } => Composite::Enum {
                options: options.clone(),
                open: open.as_ref().map(|o| movement_parser::catalog::types::OpenEnum { allow_pattern: o.allow_pattern.clone() }),
            },
            Ty::MaybeAbsent(of) => Composite::MaybeAbsent { of: Box::new(of.to_schema()) },
            Ty::Union(of) => Composite::Union { of: of.iter().map(Ty::to_schema).collect() },
            Ty::Record(_) => Composite::Record { position: None },
        };
        SchemaFieldType::Composite(composite)
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

// ── Shared nesting ──

/// The identity of a composite type's own allocation. A nested type is held
/// once and shared wherever it recurs (a closure chain's `{ k: a(), j: a() }`
/// holds `a()`'s type twice, not two copies of it), so a walk over a type
/// remembers the nodes it has been through by this key and visits each
/// distinct node once. Equal keys mean the same type, as an `Rc` is never
/// changed while it is shared. `None` for a type with no nesting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeKey(u8, usize, usize, usize);

impl Ty {
    pub fn node_key(&self) -> Option<NodeKey> {
        fn at<T: ?Sized>(rc: &Rc<T>) -> usize {
            Rc::as_ptr(rc) as *const u8 as usize
        }
        Some(match self {
            Ty::List { of, unordered } => NodeKey(1, at(of), usize::from(*unordered), 0),
            Ty::Tuple { of, rest } => NodeKey(
                2,
                at(of),
                rest.as_ref().and_then(|r| r.of.as_ref()).map_or(0, at),
                rest.as_ref().map_or(usize::MAX, |r| r.at),
            ),
            Ty::Dict { of, shape } => NodeKey(3, at(of), shape.as_ref().map_or(0, at), 0),
            Ty::MaybeAbsent(of) => NodeKey(4, at(of), 0, 0),
            Ty::Union(members) => NodeKey(5, at(members), 0, 0),
            _ => return None,
        })
    }

    /// The types nested directly inside this one.
    pub fn children(&self) -> Vec<&Ty> {
        match self {
            Ty::List { of, .. } | Ty::MaybeAbsent(of) => vec![&**of],
            Ty::Tuple { of, rest } => of.iter().flatten().chain(rest.as_ref().and_then(|r| r.of.as_deref())).collect(),
            Ty::Dict { of, shape } => shape.iter().flat_map(|s| s.values().flatten()).chain(std::iter::once(&**of)).collect(),
            Ty::Union(members) => members.iter().collect(),
            _ => Vec::new(),
        }
    }
}

// ── The size limit ──

/// How many structurally distinct parts an inferred type may have before the
/// checker stops growing it (`MOV_TYPE_TOO_LARGE`). A safety limit, not
/// language semantics: every walk over a type is linear in its distinct
/// parts, so this bounds the time one program can take to check.
pub const TYPE_PARTS_LIMIT: usize = 10_000;

/// `typesTooLarge`: do these types, together, have more than
/// `TYPE_PARTS_LIMIT` structurally distinct parts? A part is a type anywhere
/// inside them, a bare scalar included; two parts with the same structure are
/// one part however often, and through however many paths, they occur — so
/// the answer does not depend on how much of the type is shared in memory.
/// A dict's keys count in sorted order, a union's members as a set, and a
/// record by the position it holds.
pub fn types_too_large(types: &[Option<&Ty>]) -> bool {
    let mut parts = Parts::default();
    types.iter().flatten().try_for_each(|ty| parts.part_of(ty).map(|_| ())).is_err()
}

#[derive(Default)]
struct Parts {
    of_node: HashMap<NodeKey, usize>,
    of_structure: HashMap<String, usize>,
    of_position: HashMap<usize, usize>,
}

/// The limit is passed: the count stops there.
struct TooLarge;

impl Parts {
    fn part_of(&mut self, ty: &Ty) -> Result<usize, TooLarge> {
        let node = ty.node_key();
        if let Some(id) = node.and_then(|k| self.of_node.get(&k)) {
            return Ok(*id);
        }
        let structure = self.structure_of(ty)?;
        let next = self.of_structure.len();
        let id = *self.of_structure.entry(structure).or_insert(next);
        if self.of_structure.len() > TYPE_PARTS_LIMIT {
            return Err(TooLarge);
        }
        if let Some(node) = node {
            self.of_node.insert(node, id);
        }
        Ok(id)
    }

    fn slot(&mut self, ty: Option<&Ty>) -> Result<String, TooLarge> {
        Ok(match ty {
            Some(ty) => self.part_of(ty)?.to_string(),
            None => "-1".to_string(),
        })
    }

    /// One part's structure, its own parts named by their ids.
    fn structure_of(&mut self, ty: &Ty) -> Result<String, TooLarge> {
        Ok(match ty {
            Ty::Text => "text".to_string(),
            Ty::Number => "number".to_string(),
            Ty::Boolean => "boolean".to_string(),
            Ty::Date => "date".to_string(),
            Ty::Datetime => "datetime".to_string(),
            Ty::File => "file".to_string(),
            Ty::Json => "json".to_string(),
            Ty::Absent => "absent".to_string(),
            Ty::Never => "never".to_string(),
            Ty::List { of, unordered } => format!("list{}({})", if *unordered { "~" } else { "" }, self.part_of(of)?),
            Ty::Tuple { of, rest } => {
                let slots = of.iter().map(|slot| self.slot(slot.as_ref())).collect::<Result<Vec<_>, _>>()?.join(",");
                let run = match rest {
                    Some(rest) => format!(";{}:{}", rest.at, self.slot(rest.of.as_deref())?),
                    None => String::new(),
                };
                format!("tuple({slots}{run})")
            }
            Ty::Dict { of, shape } => {
                let of = self.part_of(of)?;
                let keys = match shape {
                    Some(shape) => {
                        let mut keys: Vec<&String> = shape.keys().collect();
                        keys.sort();
                        let keys = keys
                            .into_iter()
                            .map(|key| Ok(format!("{}:{}", serde_json::to_string(key).unwrap_or_default(), self.slot(shape[key].as_ref())?)))
                            .collect::<Result<Vec<_>, _>>()?;
                        format!("{{{}}}", keys.join(","))
                    }
                    None => String::new(),
                };
                format!("dict({of}{keys})")
            }
            Ty::Union(members) => {
                let mut ids = members.iter().map(|m| self.part_of(m)).collect::<Result<Vec<_>, _>>()?;
                ids.sort_unstable();
                ids.dedup();
                format!("union({})", ids.iter().map(usize::to_string).collect::<Vec<_>>().join(","))
            }
            Ty::MaybeAbsent(of) => format!("maybe({})", self.part_of(of)?),
            Ty::Enum { options, open } => format!(
                "enum({}{})",
                serde_json::to_string(options).unwrap_or_default(),
                open.as_ref().map_or(String::new(), |o| format!("~{}", serde_json::to_string(&o.allow_pattern).unwrap_or_default()))
            ),
            Ty::Record(None) => "record".to_string(),
            Ty::Record(Some(position)) => {
                let next = self.of_position.len();
                format!("record@{}", self.of_position.entry(Rc::as_ptr(position) as usize).or_insert(next))
            }
        })
    }
}

/// `typeTooLargeMessage`.
pub fn type_too_large_message(name: &str) -> String {
    format!(
        "'{name}' builds a type too large to check (over {TYPE_PARTS_LIMIT} parts) — split the value into named parts or declare its shape (node <Name> {{ … }})"
    )
}

// ── Absence ──

/// `maybeAbsent`: `T | absent`, flattened.
pub fn maybe_absent(ty: Ty) -> Ty {
    match ty {
        Ty::MaybeAbsent(_) => ty,
        // `never | null` is `null`.
        Ty::Never => Ty::Absent,
        other => Ty::MaybeAbsent(Rc::new(other)),
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
    widen_tuple_in(of, rest, widening, &mut HashMap::new())
}

/// A tuple nested in itself many times over (`[a(), a(), a()]` a link
/// further each time) widens each distinct tuple once.
fn widen_tuple_in(of: &[Option<Ty>], rest: Option<&TupleRest>, widening: Widening, widened: &mut HashMap<NodeKey, Option<Ty>>) -> Option<Ty> {
    let members: Vec<Option<Ty>> = tuple_members(of, rest).into_iter().map(|m| widen_tuples_in(m, widening, widened)).collect();
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
    widen_tuples_in(ty, widening, &mut HashMap::new())
}

fn widen_tuples_in(ty: Option<Ty>, widening: Widening, widened: &mut HashMap<NodeKey, Option<Ty>>) -> Option<Ty> {
    let ty = ty?;
    let tuple = strip_absent(&ty);
    let Ty::Tuple { of, rest } = tuple else { return Some(ty) };
    let key = tuple.node_key();
    let list = match key.and_then(|k| widened.get(&k)) {
        Some(list) => list.clone(),
        None => {
            let list = widen_tuple_in(of, rest.as_ref(), widening, widened);
            if let Some(key) = key {
                widened.insert(key, list.clone());
            }
            list
        }
    };
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
            // A member that never arrives adds nothing (TypeScript's `never`).
            Ty::Never => {}
            Ty::Union(members) => members.iter().for_each(|m| add(m, absent, flat)),
            present => flat.push(present.clone()),
        }
    }
    types.iter().for_each(|t| add(t, &mut absent, &mut flat));
    let with_absence = |one: Ty| if absent { maybe_absent(one) } else { one };
    if flat.is_empty() {
        return Some(if !absent && types.iter().all(|t| matches!(t, Ty::Never)) { Ty::Never } else { Ty::Absent });
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
    Some(with_absence(Ty::Union(Rc::new(keyed.into_iter().map(|(_, m)| m).collect()))))
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
        Ty::Union(members) => members.to_vec(),
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
    if arms.len() == 1 { known.into_iter().next() } else { Some(Ty::Union(Rc::new(known))) }
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
pub fn mixed_tuple_message(ty: Option<&Ty>, version: u32) -> Option<String> {
    let Ty::Tuple { of, rest } = strip_absent(ty?) else { return None };
    let members: Vec<Ty> = tuple_members(of, rest.as_ref()).into_iter().flatten().collect();
    let record = members.iter().find(|m| is_record(Some(m)));
    let value = members.iter().find(|m| !is_record(Some(m)) && !matches!(strip_absent(m), Ty::Absent));
    if let (Some(record), Some(value)) = (record, value) {
        let shown = widen_tuples_by(Some(value.clone()), Widening::Shared).unwrap_or_else(|| value.clone());
        return Some(format!(
            "a list holds one kind of thing, and this one holds both: {} is a record, and another member is {}. A tuple may hold both — read one slot with '{}' — but read as a list it may not. Build a list of records and walk it ('both = [one, two]' … 'both-[c:company]-> {{ … }}'), or read the records' fields first and build a list of the values.",
            describe_field_type(strip_absent(record)),
            describe_field_type(&shown),
            movement_parser::surface::phrase::spell_code("AT(t, 0)", version)
        ));
    }
    members.iter().find_map(|m| mixed_tuple_message(Some(m), version))
}

/// `collectionElementOf`: what one member of a collection is.
pub fn collection_element_of(ty: &Ty) -> Option<Ty> {
    match strip_absent(ty) {
        Ty::List { of, .. } => Some((**of).clone()),
        Ty::Tuple { of, rest } => match widen_tuple(of, rest.as_ref(), Widening::Shared)? {
            Ty::List { of, .. } => Some(Rc::unwrap_or_clone(of)),
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
    Ty::List { of: Rc::new(of), unordered: ordering == CollectionOrder::Unordered }
}

/// `tupleSlotType`: what `AT(t, index)` reads off a tuple.
pub fn tuple_slot_type(of: &[Option<Ty>], rest: Option<&TupleRest>, index: Option<i64>, version: u32) -> Option<Ty> {
    let any_of = |members: Vec<Option<Ty>>| -> Option<Ty> {
        match tuple_as_list(&members, None, version)? {
            Ty::List { of, .. } => Some(maybe_absent(Rc::unwrap_or_clone(of))),
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
    // An argument that never arrives ends the search: `coalesce(x,
    // fail("…"))` is `x` present, or the run has failed there, and nothing
    // after it is reached.
    if let Some(cut) = args.iter().position(|t| matches!(t, Some(Ty::Never))) {
        if cut == 0 {
            return Some(Ty::Never);
        }
        return match coalesce_type(&args[..cut])? {
            Ty::MaybeAbsent(of) => Some(Rc::unwrap_or_clone(of)),
            Ty::Absent => Some(Ty::Never),
            other => Some(other),
        };
    }
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
        // Never written: it fits wherever absence does.
        Ty::Absent | Ty::Never => BaseKind::Absent,
    }
}

/// `holdsOneValue`: each value of this type stands alone, not several.
pub fn holds_one_value(ty: &Ty) -> bool {
    match strip_absent(ty) {
        Ty::List { .. } | Ty::Tuple { .. } | Ty::Json => false,
        Ty::Union(members) => members.iter().all(holds_one_value),
        Ty::Text | Ty::Number | Ty::Boolean | Ty::Date | Ty::Datetime | Ty::File | Ty::Absent | Ty::Never | Ty::Dict { .. } | Ty::Enum { .. } | Ty::Record(_) | Ty::MaybeAbsent(_) => true,
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
        Ty::Absent | Ty::Never => ComparisonCategory::Absent,
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
    kinds_held_in(ty, &mut HashMap::new())
}

fn kinds_held_in(ty: &Ty, seen: &mut HashMap<NodeKey, (bool, bool)>) -> (bool, bool) {
    fn walk(ty: &Ty, seen: &mut HashMap<NodeKey, (bool, bool)>) -> (bool, bool) {
        let ty = strip_absent(ty);
        let key = ty.node_key();
        if let Some(found) = key.and_then(|k| seen.get(&k)) {
            return *found;
        }
        let found = match ty {
            Ty::Record(_) => (true, false),
            Ty::File => (false, true),
            Ty::List { .. } | Ty::Tuple { .. } | Ty::Dict { .. } | Ty::Union(_) => {
                ty.children().into_iter().map(|m| walk(m, seen)).fold((false, false), |a, b| (a.0 || b.0, a.1 || b.1))
            }
            _ => (false, false),
        };
        if let Some(key) = key {
            seen.insert(key, found);
        }
        found
    }
    walk(ty, seen)
}

/// `showsMoreHandles`: does `wider` hold a kind of engine object `ty` does not show?
pub fn shows_more_handles(wider: &Ty, ty: Option<&Ty>) -> bool {
    let (record, file) = kinds_held_by(wider);
    let (shown_record, shown_file) = ty.map(kinds_held_by).unwrap_or((false, false));
    (record && !shown_record) || (file && !shown_file)
}

/// `handleWithin`: the first record or file inside `ty` the walk does not accept.
pub fn handle_within(ty: Option<&Ty>, walk: &HeldWalk) -> Option<HeldHandle> {
    handle_within_in(ty, walk, &mut HeldNothing::default())
}

/// What one search knows of the parts it has met. A part that holds no
/// record or file is passed over by any search. What a search finds in a
/// part does not depend on where the part sits, unless an inspection reads
/// the steps to it, so the parts it found nothing in are remembered only by
/// a search without one.
#[derive(Default)]
struct HeldNothing {
    empty: std::collections::HashSet<NodeKey>,
    kinds: HashMap<NodeKey, (bool, bool)>,
}

impl HeldNothing {
    fn knows(&mut self, ty: &Ty, walk: &HeldWalk) -> bool {
        if walk.inspect.is_none() && ty.node_key().is_some_and(|k| self.empty.contains(&k)) {
            return true;
        }
        ty.node_key().is_some() && kinds_held_in(ty, &mut self.kinds) == (false, false)
    }

    fn after(&mut self, ty: &Ty, walk: &HeldWalk, found: Option<HeldHandle>) -> Option<HeldHandle> {
        if found.is_none()
            && walk.inspect.is_none()
            && let Some(key) = ty.node_key()
        {
            self.empty.insert(key);
        }
        found
    }
}

fn handle_within_in(ty: Option<&Ty>, walk: &HeldWalk, nothing: &mut HeldNothing) -> Option<HeldHandle> {
    let ty = strip_absent(ty?);
    if nothing.knows(ty, walk) {
        return None;
    }
    let found = handle_within_node(ty, walk, nothing);
    nothing.after(ty, walk, found)
}

fn handle_within_node(ty: &Ty, walk: &HeldWalk, nothing: &mut HeldNothing) -> Option<HeldHandle> {
    match ty {
        Ty::Record(position) if walk.accepts_record => walk.accepted(Ty::Record(position.clone())),
        Ty::Record(position) => Some(HeldHandle { steps: walk.steps.clone(), handle: Ty::Record(position.clone()), may: false }),
        Ty::File if walk.accepts_file => walk.accepted(Ty::File),
        Ty::File => Some(HeldHandle { steps: walk.steps.clone(), handle: Ty::File, may: false }),
        list @ (Ty::List { .. } | Ty::Tuple { .. }) => among_members_node(list, walk, HeldStep::Slot, nothing),
        Ty::Dict { of, shape } => {
            for (key, value) in shape.iter().flat_map(|s| s.iter()) {
                if let Some(held) = handle_within_in(value.as_ref(), &walk.into(HeldStep::Key(key.clone())), nothing) {
                    return Some(held);
                }
            }
            handle_within_in(Some(of), &walk.into(HeldStep::Member), nothing)
        }
        Ty::Union(members) => members.iter().find_map(|m| handle_within_in(Some(m), walk, nothing)).map(|held| HeldHandle { may: true, ..held }),
        _ => None,
    }
}

/// `handleAmongMembers`: a handle among a collection's members, each one
/// `step_for(slot)` further into the walk (a spread splices members, so it
/// asks with every slot unnumbered: `|_| HeldStep::Member`).
pub fn handle_among_members(ty: Option<&Ty>, walk: &HeldWalk, step_for: fn(usize) -> HeldStep) -> Option<HeldHandle> {
    among_members_node(strip_absent(ty?), walk, step_for, &mut HeldNothing::default())
}

fn among_members_node(ty: &Ty, walk: &HeldWalk, step_for: fn(usize) -> HeldStep, nothing: &mut HeldNothing) -> Option<HeldHandle> {
    match ty {
        Ty::List { of, .. } => handle_within_in(Some(of), &walk.into(HeldStep::Member), nothing),
        Ty::Tuple { of, rest } => {
            for (index, slot) in of.iter().enumerate() {
                if let Some(held) = handle_within_in(slot.as_ref(), &walk.into(step_for(index)), nothing) {
                    return Some(held);
                }
            }
            handle_within_in(rest.as_ref().and_then(|r| r.of.as_deref()), &walk.into(HeldStep::Member), nothing)
        }
        Ty::Union(members) => members
            .iter()
            .find_map(|m| among_members_node(strip_absent(m), walk, step_for, nothing))
            .map(|held| HeldHandle { may: true, ..held }),
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

fn slots_agree(left: &[Option<&Ty>], right: &[Option<&Ty>], known: &mut HashMap<(NodeKey, NodeKey), bool>) -> bool {
    left.len() == right.len()
        && left.iter().zip(right).all(|(l, r)| match (l, r) {
            (Some(l), Some(r)) => equals_in(l, r, known),
            (None, None) => true,
            _ => false,
        })
}

/// `fieldTypeEquals`: absence aside at the top, structurally.
pub fn field_type_equals(a: &Ty, b: &Ty) -> bool {
    equals_in(a, b, &mut HashMap::new())
}

/// Each pair of distinct nodes is compared once: a shared node is equal to
/// itself without a look inside, and a pair met again answers as it did.
fn equals_in(a: &Ty, b: &Ty, known: &mut HashMap<(NodeKey, NodeKey), bool>) -> bool {
    let (left, right) = (strip_absent(a), strip_absent(b));
    let pair = left.node_key().zip(right.node_key());
    if let Some((l, r)) = pair {
        if l == r {
            return true;
        }
        if let Some(answer) = known.get(&(l, r)) {
            return *answer;
        }
    }
    let answer = equals_node(left, right, known);
    if let Some(pair) = pair {
        known.insert(pair, answer);
    }
    answer
}

fn equals_node(left: &Ty, right: &Ty, known: &mut HashMap<(NodeKey, NodeKey), bool>) -> bool {
    match (left, right) {
        (Ty::Text, Ty::Text)
        | (Ty::Number, Ty::Number)
        | (Ty::Boolean, Ty::Boolean)
        | (Ty::Date, Ty::Date)
        | (Ty::Datetime, Ty::Datetime)
        | (Ty::File, Ty::File)
        | (Ty::Json, Ty::Json)
        | (Ty::Absent, Ty::Absent) => true,
        (Ty::List { of: l, .. }, Ty::List { of: r, .. }) => equals_in(l, r, known),
        (Ty::Tuple { of: l, rest: lr }, Ty::Tuple { of: r, rest: rr }) => {
            fn slots(of: &[Option<Ty>]) -> Vec<Option<&Ty>> {
                of.iter().map(Option::as_ref).collect()
            }
            if !slots_agree(&slots(l), &slots(r), known) {
                return false;
            }
            match (lr, rr) {
                (None, None) => true,
                (Some(lr), Some(rr)) => lr.at == rr.at && slots_agree(&[lr.of.as_deref()], &[rr.of.as_deref()], known),
                _ => false,
            }
        }
        (Ty::Dict { of: lo, shape: ls }, Ty::Dict { of: ro, shape: rs }) => {
            if !equals_in(lo, ro, known) {
                return false;
            }
            match (ls, rs) {
                (None, None) => true,
                (Some(ls), Some(rs)) => {
                    ls.len() == rs.len()
                        && ls.iter().all(|(key, slot)| match rs.get(key) {
                            None => false,
                            Some(other) => match (slot, other) {
                                (Some(s), Some(o)) => equals_in(s, o, known),
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
        (Ty::MaybeAbsent(l), Ty::MaybeAbsent(r)) => equals_in(l, r, known),
        (Ty::Union(l), Ty::Union(r)) => l.len() == r.len() && l.iter().all(|m| r.iter().any(|o| equals_in(m, o, known))),
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
    // A value that never arrives fits wherever it is written (TypeScript's `never`).
    if matches!(source, Ty::Never) || field_type_equals(source, target) {
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
        Ty::Never => "never".to_string(),
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
