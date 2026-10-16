//! The walks family: what a walk may step along and read off where it lands
//! (`stepEdge`, `readProperty`, `gateHopCapability`, `checkHopLimitOrder`,
//! `checkMetaKey` in typing.ts; `checkPathHead` in check.ts). The type core
//! decides where a step lands; this module reports why one did not, and what
//! a hop asks of a source that cannot do it.
//!
//! Its codes (PORT.md has where the TypeScript raises each):
//!
//! - MOV_AMBIGUOUS_PROPERTY
//! - MOV_ARTIFICIAL_EDGE_UNKNOWN
//! - MOV_AWAIT_IMPURE_WHERE
//! - MOV_AWAIT_REQUIRED
//! - MOV_HEAD_NOT_A_POSITION
//! - MOV_HOP_CONFIG_UNREAD
//! - MOV_HOP_FILTER_ENGINE
//! - MOV_HOP_FILTER_RESIDUAL
//! - MOV_HOP_FILTER_UNSUPPORTED
//! - MOV_HOP_LIMIT_UNSUPPORTED
//! - MOV_HOP_ORDER_ENGINE
//! - MOV_HOP_ORDER_UNSUPPORTED
//! - MOV_LIMIT_NEEDS_ORDER
//! - MOV_META_HOP_RETIRED
//! - MOV_META_UNKNOWN_KEY
//! - MOV_NARROWING
//! - MOV_OLD_EDGE_NOT_A_WRITE
//! - MOV_PARENT_READ_RETIRED
//! - MOV_SHAPE_HOP_RETIRED
//! - MOV_TRANSFORM_HOP_RETIRED
//! - MOV_TRAVERSE_UNKNOWN_EDGE
//! - MOV_UNDESCRIBED_POSITION
//! - MOV_UNKNOWN_POSITION
//! - MOV_UNKNOWN_PROPERTY
//! - MOV_UNREACHABLE_BRANCH

use movement_parser::ast::{PathHead, PathRoot};
use movement_parser::catalog::types::{EdgeCapability, EdgeSchema, PositionSchema, PushMode};
use movement_parser::lowering::expression::{EdgeStep, Expression, FilterOperator, ListElement, OrderDirection, TraversalStep};

use crate::codes;
use crate::diagnostic::Severity;
use crate::scope::{Resolution, ScopeId};
use crate::types::field::{CollectionOrder, Ty, describe_field_type, holds_records, record_head_position, widen_tuples};
use crate::types::scope_env::SymbolTypes;
use crate::types::infer::Typing;
use crate::types::position::{EdgeLanding, Position, describe_position, display_name_of, is_artificial_edge, position_schema_of_ref};

/// The engine-made edge to the record as it stood before a write.
pub const OLD_EDGE: &str = "@old";

/// `POSITION_SENTINEL`: a read of "the positions themselves".
const POSITION_SENTINEL: &str = "__movement_position__";

/// Called by the type core after each edge step it types (`stepEdge`):
/// `landing` is `None` when the walk had already lost its position.
pub fn observe_step(typing: &mut Typing, from: Option<&Position>, step: &EdgeStep, landing: Option<&EdgeLanding>) {
    if let Some(from) = from {
        report_step(typing, from, &step.edge_type_id, step.expression_filter.as_deref());
    }
    crate::families::writes::report_write_only_edge(typing, from, step, landing);
}

/// `stepEdge`, the reporting half: what the TypeScript says while stepping
/// `edge` off `from`.
fn report_step(typing: &mut Typing, from: &Position, edge: &str, filter: Option<&Expression>) {
    if edge.starts_with('#') && typing.version >= 5 {
        return;
    }
    if is_artificial_edge(edge) && !matches!(from, Position::MaybeEmpty(_)) && typing.version >= 4 {
        report_artificial_step(typing, from, edge);
        return;
    }
    match from {
        Position::Meta { instance } => {
            if !instance.schema.collections.contains_key(edge) {
                let available: Vec<&str> = instance.schema.collections.keys().map(String::as_str).collect();
                typing.report(
                    codes::TRAVERSE_UNKNOWN_EDGE,
                    format!("'{}' has no collection '{edge}'{}", instance.name, it_has(&available)),
                );
            }
        }
        Position::Position(_) | Position::Handle(_) => {
            let schema = match (position_schema_of_ref(from), from) {
                (Some(schema), _) => schema.into_owned(),
                (None, Position::Handle(h)) if h.edges.is_some() => {
                    let edges = h.edges.clone().unwrap_or_else(|| unreachable!("checked above"));
                    let Ok(mut schema) = serde_json::from_value::<PositionSchema>(serde_json::json!({ "properties": {}, "edges": {} })) else { return };
                    schema.edges = edges;
                    schema
                }
                _ => return,
            };
            let Some(edge_schema) = schema.edges.get(edge) else {
                if report_undescribed(typing, from, &schema, &format!("the edge '{edge}'")) || schema.open_properties == Some(true) {
                    return;
                }
                let available: Vec<&str> = schema.edges.keys().map(String::as_str).collect();
                typing.report(codes::TRAVERSE_UNKNOWN_EDGE, format!("{} has no edge '{edge}'{}", describe_position(from), it_has(&available)));
                return;
            };
            if edge_schema.awaitable == Some(true) {
                if typing.awaited {
                    if filter.is_some_and(|f| !is_pure_predicate(f)) {
                        report_await_impure_where(typing, edge);
                    }
                    return;
                }
                if !edge_is_readable(edge_schema) {
                    typing.report(
                        codes::AWAIT_REQUIRED,
                        format!(
                            "'-[:{edge}]->' on {} resolves only when it is answered — read it with 'await' (`await …-[:{edge}]->`). A bare traversal reads now and would yield nothing until then.",
                            describe_position(from)
                        ),
                    );
                    return;
                }
                if edge_schema.watchable == Some(true) {
                    typing.watchable_reads.push(edge.to_string());
                }
            }
            // A write-only edge is the writes family's (MOV_WRITE_ONLY_EDGE).
        }
        Position::Union(u) => {
            if u.variants.is_empty() {
                typing.report(
                    codes::UNREACHABLE_BRANCH,
                    format!("the tests above already cover every kind this can be, so nothing reaches here — '{edge}' can't be traversed"),
                );
                return;
            }
            let carrying: Vec<&String> =
                u.variants.iter().filter(|v| u.instance.schema.positions.get(*v).is_some_and(|p| p.edges.contains_key(edge))).collect();
            if !carrying.is_empty()
                && carrying.iter().all(|v| !edge_is_readable(&u.instance.schema.positions[v.as_str()].edges[edge]))
            {
                return; // MOV_WRITE_ONLY_EDGE: the writes family's.
            }
            if carrying.len() == u.variants.len() {
                return;
            }
            if !carrying.is_empty() {
                let shown: Vec<String> = carrying.iter().map(|v| format!("{}'s {}", u.instance.name, display_name_of(&u.instance, v))).collect();
                let example = narrowing_example(u, &carrying);
                typing.report(
                    codes::NARROWING,
                    format!("'{edge}' is an edge of {} only — narrow with an IS test (e.g. `{example}`) before traversing it", shown.join(" / ")),
                );
                return;
            }
            typing.report(codes::TRAVERSE_UNKNOWN_EDGE, format!("no variant of {} has an edge '{edge}'", describe_position(from)));
        }
        Position::Extract { node, .. } => {
            if !node.declared && !node.children.contains_key(edge) {
                let available: Vec<&str> = node.children.keys().map(String::as_str).collect();
                typing.report(codes::TRAVERSE_UNKNOWN_EDGE, format!("{} has no nested node '{edge}'{}", describe_position(from), it_has(&available)));
            }
        }
        Position::Closure(closure) => {
            typing.report(
                codes::TRAVERSE_UNKNOWN_EDGE,
                format!("{} is a closure — there is nothing to traverse off one. Call it, and traverse what it returns.", closure.label),
            );
        }
        Position::Local(local) => match local.edges.as_ref().and_then(|e| e.get(edge)) {
            None => {
                let available: Vec<&str> = local.edges.iter().flat_map(|e| e.keys()).map(String::as_str).collect();
                let message = if available.is_empty() {
                    let reads: Vec<String> = local.reads.keys().map(|name| format!("'.{name}'")).collect();
                    format!("{} has no edges — read what it carries with a dot: {}", local.label, reads.join(" or "))
                } else {
                    format!("{} has no edge '{edge}' — it has: {}", local.label, available.join(", "))
                };
                typing.report(codes::TRAVERSE_UNKNOWN_EDGE, message);
            }
            Some(local_edge) => {
                if local_edge.schema.awaitable == Some(true) && typing.awaited && filter.is_some_and(|f| !is_pure_predicate(f)) {
                    report_await_impure_where(typing, edge);
                }
            }
        },
        Position::MaybeEmpty(of) => report_step(typing, of, edge, filter),
    }
}

fn report_await_impure_where(typing: &mut Typing, edge: &str) {
    typing.report(
        codes::AWAIT_IMPURE_WHERE,
        format!(
            "The WHERE on '-[:{edge}]->' has to run in the app (it uses AI() or EXISTS), which an 'await' can't do — its condition is evaluated against each candidate without re-running the movement. Narrow it with a pure predicate over the awaited record's own fields."
        ),
    );
}

/// `stepArtificialEdge`, the reporting half.
fn report_artificial_step(typing: &mut Typing, from: &Position, edge: &str) {
    if edge != OLD_EDGE {
        typing.report(
            codes::ARTIFICIAL_EDGE_UNKNOWN,
            format!("'-[:{edge}]->': '@' names an edge the engine makes, not one a system declares — the only one is '{OLD_EDGE}' (the record as it stood before a write)"),
        );
        return;
    }
    if matches!(from, Position::Handle(h) if h.written) {
        return;
    }
    typing.report(
        codes::OLD_EDGE_NOT_A_WRITE,
        format!(
            "only a handle a write returned has an '{OLD_EDGE}' (the record as it stood before that write), and {} is not one — a record a match or a traversal found already is the record as it stands, so read it directly",
            describe_position(from)
        ),
    );
}

/// `edgeIsReadable`: an edge reads unless it says it does not.
fn edge_is_readable(edge: &EdgeSchema) -> bool {
    edge.readable != Some(false)
}

/// ` — it has: a, b` when there is anything to list.
fn it_has(available: &[&str]) -> String {
    if available.is_empty() { String::new() } else { format!(" — it has: {}", available.join(", ")) }
}

/// `reportUndescribed`: true when nothing can be checked against `schema`
/// (reported when it is undescribed; silent while it is pending).
fn report_undescribed(typing: &mut Typing, position: &Position, schema: &PositionSchema, what: &str) -> bool {
    if schema.pending == Some(true) {
        return true;
    }
    if schema.undescribed != Some(true) {
        return false;
    }
    typing.report(
        codes::UNDESCRIBED_POSITION,
        format!(
            "nothing describes {}, so {what} can't be checked here — it would be null at run time. Narrow the type that reaches it to a concrete one first.",
            describe_position(position)
        ),
    );
    true
}

/// `reportAmbiguousProperty`.
fn report_ambiguous_property(typing: &mut Typing, position: &Position, schema: &PositionSchema, property: &str) {
    if !schema.ambiguous_properties.as_ref().is_some_and(|names| names.iter().any(|n| n == property)) {
        return;
    }
    typing.report_with(
        codes::AMBIGUOUS_PROPERTY,
        format!(
            "{} has more than one field named '{property}' — this reads the first one. Rename one of them in the connected system to be sure which you get.",
            describe_position(position)
        ),
        Severity::Warning,
    );
}

/// `surfaceNotEnumerated`.
fn surface_not_enumerated(schema: Option<&PositionSchema>) -> bool {
    schema.is_some_and(|s| s.open_properties == Some(true) || s.undescribed == Some(true) || s.pending == Some(true))
}

fn is_write_only(schema: &PositionSchema, property: &str) -> bool {
    schema.write_only_properties.as_ref().is_some_and(|names| names.iter().any(|n| n == property))
}

/// Called by the type core after each dot read off a record (`readProperty`).
pub fn observe_read(typing: &mut Typing, position: Option<&Position>, property: &str, ty: Option<&Ty>) {
    if let Some(position) = position
        && property != POSITION_SENTINEL
    {
        report_read(typing, position, property);
        crate::families::writes::report_write_only_property(typing, Some(position), property, ty);
    }
}

/// `refuseUnsentFile` (language version 5): a write handle's file field the
/// write did not send holds the system's description of the file, not the file.
fn refuse_unsent_file(typing: &mut Typing, handle: &crate::types::position::HandlePosition, property: &str, ty: &Ty) {
    if typing.version < 5 || !handle.written || handle.set_fields.as_ref().is_some_and(|set| set.contains(property)) {
        return;
    }
    if !crate::types::field::base_kinds(&crate::types::field::unwrap_list(crate::types::field::strip_absent(ty))).contains(&crate::types::field::BaseKind::File) {
        return;
    }
    typing.report(
        codes::HANDLE_FILE_NOT_SENT,
        format!("'{property}' is a file this write did not send, so the write's handle holds the system's description of it, not the file — read the record back through its edge to get the file, as a walk read does (`h-[:Files]->`), or send the file in this write"),
    );
}

/// `readProperty`, the reporting half. A write-only field is the writes
/// family's (MOV_WRITE_ONLY_PROPERTY), an extracted node's the extraction
/// family's, a retired handle field the records family's.
fn report_read(typing: &mut Typing, position: &Position, property: &str) {
    match position {
        Position::Handle(h) => {
            if let Some(declared) = h.result_shape.get(property) {
                refuse_unsent_file(typing, h, property, declared);
                return;
            }
            let schema = position_schema_of_ref(position).map(|s| s.into_owned());
            if let Some(schema) = &schema
                && let Some(from_position) = schema.properties.get(property)
            {
                refuse_unsent_file(typing, h, property, &Ty::from_schema(from_position));
                report_ambiguous_property(typing, position, schema, property);
                return;
            }
            if schema.as_ref().is_some_and(|s| is_write_only(s, property)) {
                return;
            }
            if h.written && crate::families::records::is_retired_handle_field(property) && typing.version >= 4 {
                crate::families::records::report_handle_field_retired(typing, property);
                return;
            }
            if let Some(schema) = &schema
                && (report_undescribed(typing, position, schema, &format!("the field '{property}'")) || schema.open_properties == Some(true))
            {
                return;
            }
            let mut available: Vec<String> = h.result_shape.keys().cloned().collect();
            for name in schema.iter().flat_map(|s| s.properties.keys()) {
                if !available.contains(name) {
                    available.push(name.clone());
                }
            }
            let available: Vec<&str> = available.iter().map(String::as_str).collect();
            typing.report(
                codes::UNKNOWN_PROPERTY,
                format!(
                    "{} has no field '{property}'{}{}",
                    describe_position(position),
                    if available.is_empty() { String::new() } else { format!(" — it carries: {}", available.join(", ")) },
                    did_you_mean(property, &available)
                ),
            );
        }
        Position::Position(p) => {
            let Some(schema) = p.instance.schema.positions.get(&p.position) else { return };
            if schema.properties.contains_key(property) {
                report_ambiguous_property(typing, position, schema, property);
                return;
            }
            if is_write_only(schema, property) || report_undescribed(typing, position, schema, &format!("the field '{property}'")) {
                return;
            }
            if schema.open_properties == Some(true) {
                return;
            }
            let available: Vec<&str> = schema.properties.keys().map(String::as_str).collect();
            let hint = match p.instance.schema.narrow_by.as_ref().and_then(|n| n.get(&p.position)).map(Vec::as_slice) {
                Some([first, rest @ ..]) => {
                    let others = if rest.is_empty() {
                        String::new()
                    } else {
                        format!(" (or {})", rest.iter().map(|f| format!("`{f}`")).collect::<Vec<_>>().join(", "))
                    };
                    format!(
                        ". If it is a field of one {} only, narrow the hop that lands here to it: test `{first}` == \"…\"{others} in its WHERE",
                        display_name_of(&p.instance, &p.position)
                    )
                }
                _ => String::new(),
            };
            typing.report(
                codes::UNKNOWN_PROPERTY,
                format!("{} has no field '{property}'{}{}{hint}", describe_position(position), it_has(&available), did_you_mean(property, &available)),
            );
        }
        Position::Union(u) => {
            if u.variants.is_empty() {
                typing.report(
                    codes::UNREACHABLE_BRANCH,
                    format!("the tests above already cover every kind this can be, so nothing reaches here — '{property}' can't be read"),
                );
                return;
            }
            let schemas: Vec<Option<&PositionSchema>> = u.variants.iter().map(|v| u.instance.schema.positions.get(v)).collect();
            let carrying: Vec<&String> =
                u.variants.iter().zip(&schemas).filter(|(_, s)| s.is_some_and(|s| s.properties.contains_key(property))).map(|(v, _)| v).collect();
            if carrying.is_empty() {
                if schemas.iter().any(|s| s.is_some_and(|s| is_write_only(s, property))) {
                    return;
                }
                if schemas.iter().any(|s| s.is_none() || surface_not_enumerated(*s)) {
                    return;
                }
                let mut available: Vec<&str> = Vec::new();
                for name in schemas.iter().flatten().flat_map(|s| s.properties.keys()) {
                    if !available.contains(&name.as_str()) {
                        available.push(name);
                    }
                }
                typing.report(
                    codes::UNKNOWN_PROPERTY,
                    format!(
                        "no variant of {} has a field '{property}'{}",
                        describe_position(position),
                        if available.is_empty() { String::new() } else { format!(" — its variants have: {}", available.join(", ")) }
                    ),
                );
                return;
            }
            if carrying.len() < u.variants.len() {
                let shown: Vec<String> = carrying.iter().map(|v| format!("{}'s {}", u.instance.name, display_name_of(&u.instance, v))).collect();
                typing.report(
                    codes::NARROWING,
                    format!(
                        "'{property}' is a field of {} only — narrow with an IS test (e.g. `x IS <{}-[:`{}`]->>`) before reading it",
                        shown.join(" / "),
                        u.instance.name,
                        carrying[0]
                    ),
                );
            }
        }
        Position::MaybeEmpty(of) => report_read(typing, of, property),
        Position::Local(local) => {
            if local.reads.contains_key(property) {
                return;
            }
            if local.edges.as_ref().is_some_and(|e| e.contains_key(property)) {
                typing.report(
                    codes::UNKNOWN_PROPERTY,
                    format!("'{property}' is an edge of {} — traverse it ('-[x:{property}]->'), don't read it as a value", local.label),
                );
                return;
            }
            let available: Vec<&str> = local.reads.keys().map(String::as_str).collect();
            typing.report(
                codes::UNKNOWN_PROPERTY,
                format!(
                    "{} has no '{property}'{}",
                    local.label,
                    if available.is_empty() { String::new() } else { format!(" — it carries: {}", available.join(", ")) }
                ),
            );
        }
        Position::Closure(closure) => {
            typing.report(
                codes::UNKNOWN_PROPERTY,
                format!("{} is a closure — there is nothing to read off one. Call it, and read what it returns.", closure.label),
            );
        }
        Position::Extract { .. } | Position::Meta { .. } => {}
    }
}

/// Called by the type core once a hop's ordering is known, before its WHERE
/// is typed (`checkHopLimitOrder`).
pub fn observe_hop_order(typing: &mut Typing, step: &EdgeStep, ordering: CollectionOrder) {
    let Some(cardinality) = &step.cardinality else { return };
    let Some(limit) = &cardinality.limit else { return };
    if cardinality.order_by.is_some() || ordering != CollectionOrder::Unordered {
        return;
    }
    let n = js_number(limit.0);
    let edge = &step.edge_type_id;
    typing.report(
        codes::LIMIT_NEEDS_ORDER,
        format!(
            "'{edge}' comes back in no particular order, so 'LIMIT {n}' takes some {n} of them — a different {n} each run. Say which ones you mean with an ORDER BY (`-[:{edge} ORDER BY `…` DESC LIMIT {n}]->`)."
        ),
    );
}

/// A number as JavaScript prints it, for the integers and plain decimals a
/// LIMIT holds.
fn js_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 { format!("{}", n as i64) } else { format!("{n}") }
}

/// Called by the type core once a hop's WHERE and ORDER BY are typed
/// (`gateHopCapability`): `from` is where the hop left, `target` where it landed.
pub fn observe_hop(typing: &mut Typing, from: Option<&Position>, step: &EdgeStep, target: Option<&Position>) {
    let Some(from) = from else { return };
    let edge = step.edge_type_id.as_str();
    let Some(capability) = edge_capability_for(from, edge) else { return };
    let target_schema = target.and_then(position_schema_of_ref).map(|s| s.into_owned());
    let root = matches!(from, Position::Meta { .. });
    if let Some(filter) = step.expression_filter.as_deref() {
        gate_filter(typing, &capability, filter, edge, target_schema.as_ref(), root);
    }
    if let Some(order_by) = step.cardinality.as_ref().and_then(|c| c.order_by.as_deref()) {
        let direction = step.cardinality.as_ref().and_then(|c| c.order_direction).unwrap_or(OrderDirection::Asc);
        gate_order(typing, &capability, order_by, direction, edge, target_schema.as_ref(), root);
    }
    if step.cardinality.as_ref().is_some_and(|c| c.limit.is_some()) && !capability.supports_limit {
        typing.report(codes::HOP_LIMIT_UNSUPPORTED, format!("'{edge}' can't be limited here — this source doesn't support LIMIT across that relationship."));
    }
}

/// `edgeCapabilityFor`.
fn edge_capability_for(from: &Position, edge: &str) -> Option<EdgeCapability> {
    match from {
        Position::Meta { instance } => instance.schema.collections.get(edge)?.capability.clone(),
        Position::Position(_) | Position::Handle(_) => position_schema_of_ref(from)?.edges.get(edge)?.capability.clone(),
        _ => None,
    }
}

fn gate_filter(typing: &mut Typing, cap: &EdgeCapability, filter: &Expression, edge: &str, target: Option<&PositionSchema>, root: bool) {
    match cap.filter {
        None => typing.report(
            codes::HOP_FILTER_UNSUPPORTED,
            format!("'{edge}' can't be filtered here — this source doesn't support a WHERE across that relationship."),
        ),
        Some(PushMode::Native) if !is_pure_predicate(filter) => typing.report(
            codes::HOP_FILTER_UNSUPPORTED,
            format!(
                "This filter has to run in the app (it uses AI() or EXISTS), which isn't possible over '{edge}' — an unbounded source. Narrow to a bounded relationship first, then filter."
            ),
        ),
        Some(PushMode::Native) => {
            let Some(target) = target else { return };
            let Some(caps) = &target.property_capabilities else { return };
            let mut pushed: Vec<String> = Vec::new();
            let mut residual: Vec<String> = Vec::new();
            for (field, op) in collect_filter_predicates(filter) {
                if !target.properties.contains_key(&field) {
                    continue;
                }
                let supported =
                    caps.get(&field).and_then(|c| c.filter_operators.as_ref()).is_some_and(|ops| ops.iter().any(|o| filter_op_name(o) == op.0));
                let described = format!("`{field}` ({})", op.1);
                if supported { pushed.push(described) } else { residual.push(described) }
            }
            if !residual.is_empty() && pushed.is_empty() {
                typing.report(
                    codes::HOP_FILTER_UNSUPPORTED,
                    format!(
                        "This source can't filter '{edge}' by {} — reading it would mean fetching every record and filtering here. Narrow it by something the source can filter first.",
                        residual.join(" or ")
                    ),
                );
            } else if !residual.is_empty() {
                typing.report_with(
                    codes::HOP_FILTER_RESIDUAL,
                    format!(
                        "{} on '{edge}' can't be filtered by the source, so those run here on what comes back — the rest of the WHERE narrows it first. The records you get are the same either way; the fetch is bigger.",
                        residual.join(" and ")
                    ),
                    Severity::Warning,
                );
            }
        }
        Some(PushMode::Bounded) if root => typing.report_with(
            codes::HOP_FILTER_ENGINE,
            format!(
                "WHERE on '{edge}' runs here, not at the source — the whole collection is fetched first and filtered afterwards. The records you get are the same either way; the fetch is bigger."
            ),
            Severity::Warning,
        ),
        Some(PushMode::Bounded) => {}
    }
}

fn gate_order(
    typing: &mut Typing,
    cap: &EdgeCapability,
    order_by: &Expression,
    direction: OrderDirection,
    edge: &str,
    target: Option<&PositionSchema>,
    root: bool,
) {
    let Expression::Property { property_type_id: field } = order_by else {
        if cap.order.is_some() {
            typing.report_with(
                codes::HOP_ORDER_ENGINE,
                format!(
                    "ORDER BY on '{edge}' runs here, not at the source — this key is read off each record in turn, so the sort happens after the fetch. The order you get is the one you asked for."
                ),
                Severity::Warning,
            );
        }
        return;
    };
    let natural = cap.natural_order.as_ref().is_some_and(|n| {
        n.field == *field
            && matches!(
                (n.direction, direction),
                (movement_parser::catalog::types::Direction::Asc, OrderDirection::Asc)
                    | (movement_parser::catalog::types::Direction::Desc, OrderDirection::Desc)
            )
    });
    if natural {
        return;
    }
    match cap.order {
        None => typing.report(
            codes::HOP_ORDER_UNSUPPORTED,
            format!("'{edge}' can't be ordered here — this source doesn't support ORDER BY across that relationship."),
        ),
        Some(PushMode::Native) => {
            let Some(target) = target else { return };
            let Some(caps) = &target.property_capabilities else { return };
            if target.properties.contains_key(field) && caps.get(field).and_then(|c| c.orderable) != Some(true) {
                typing.report(
                    codes::HOP_ORDER_UNSUPPORTED,
                    format!("This source can't order '{edge}' by `{field}` — that field isn't orderable server-side."),
                );
            }
        }
        Some(PushMode::Bounded) if root => typing.report_with(
            codes::HOP_ORDER_ENGINE,
            format!(
                "ORDER BY on '{edge}' runs here, not at the source — everything the WHERE lets through is fetched first and sorted afterwards. The order you get is the one you asked for; the fetch is bigger."
            ),
            Severity::Warning,
        ),
        Some(PushMode::Bounded) => {}
    }
}

/// An operator's wire name and how a diagnostic says it (`FILTER_OP_LABELS`).
fn filter_op(op: FilterOperator) -> (&'static str, &'static str) {
    match op {
        FilterOperator::Eq => ("eq", "equals"),
        FilterOperator::Neq => ("neq", "not equals"),
        FilterOperator::Contains => ("contains", "contains"),
        FilterOperator::Gt => ("gt", ">"),
        FilterOperator::Gte => ("gte", ">="),
        FilterOperator::Lt => ("lt", "<"),
        FilterOperator::Lte => ("lte", "<="),
        FilterOperator::Exists => ("exists", "exists"),
        FilterOperator::In => ("in", "in"),
        FilterOperator::Within => ("within", "within"),
    }
}

fn filter_op_name(op: &movement_parser::catalog::types::FilterOperator) -> &'static str {
    use movement_parser::catalog::types::FilterOperator as Op;
    match op {
        Op::Eq => "eq",
        Op::Neq => "neq",
        Op::Contains => "contains",
        Op::Gt => "gt",
        Op::Gte => "gte",
        Op::Lt => "lt",
        Op::Lte => "lte",
        Op::Exists => "exists",
        Op::In => "in",
        Op::Within => "within",
    }
}

/// `collectFilterPredicates`: the (field, operator) pairs a hop WHERE
/// constrains directly, walked through boolean structure.
fn collect_filter_predicates(expr: &Expression) -> Vec<(String, (&'static str, &'static str))> {
    let mut out = Vec::new();
    fn visit(e: &Expression, out: &mut Vec<(String, (&'static str, &'static str))>) {
        match e {
            Expression::Compare { op, left, right } => {
                if let Expression::Property { property_type_id } | Expression::EdgeProperty { property_type_id } = &**left {
                    out.push((property_type_id.clone(), filter_op(*op)));
                }
                visit(left, out);
                visit(right, out);
            }
            Expression::Logical { operands, .. } => operands.iter().for_each(|o| visit(o, out)),
            Expression::Not { expression } => visit(expression, out),
            Expression::Conditional { condition, then, else_ } => {
                visit(condition, out);
                visit(then, out);
                visit(else_, out);
            }
            _ => {}
        }
    }
    visit(expr, &mut out);
    out
}

/// `isPurePredicate`: every node is one the shared filter unit evaluates
/// with no adapter, no AI and no walk.
pub fn is_pure_predicate(expr: &Expression) -> bool {
    match expr {
        Expression::Traverse { steps, expression, .. } => steps.is_empty() && is_pure_predicate(expression),
        Expression::Static { .. } | Expression::Property { .. } | Expression::EdgeProperty { .. } | Expression::AliasRef { .. } | Expression::Meta { .. } => {
            true
        }
        Expression::List { elements } => elements.iter().all(|e| match e {
            ListElement::Expression(e) => is_pure_predicate(e),
            ListElement::Spread(s) => is_pure_predicate(&s.expression),
        }),
        Expression::Compare { left, right, .. } | Expression::Arithmetic { left, right, .. } => is_pure_predicate(left) && is_pure_predicate(right),
        Expression::Logical { operands, .. } => operands.iter().all(is_pure_predicate),
        Expression::Not { expression } | Expression::Negate { expression } => is_pure_predicate(expression),
        Expression::Concat { parts } => parts.iter().all(is_pure_predicate),
        Expression::Conditional { condition, then, else_ } => is_pure_predicate(condition) && is_pure_predicate(then) && is_pure_predicate(else_),
        Expression::At { expression, index } => is_pure_predicate(expression) && is_pure_predicate(index),
        _ => false,
    }
}

/// Called by the type core for each `@key` read (`checkMetaKey`).
pub fn observe_meta(typing: &mut Typing, key: &str) {
    if META_KEYS.contains(&key) {
        return;
    }
    let closest = closest_by_edit_distance(key, META_KEYS);
    typing.report(
        codes::META_UNKNOWN_KEY,
        format!("'@{key}' isn't a known meta field.{}", closest.map_or(String::new(), |c| format!(" Did you mean '@{c}'?"))),
    );
}

/// `MOVEMENT_META_KEYS`, in the TypeScript's order (the first closest wins).
const META_KEYS: &[&str] = &["current_date", "current_timestamp", "user_email", "user_name", "user_id", "actor_email", "actor_name", "actor_id"];

/// `didYouMean`: ` — did you mean 'x'?` when a close candidate exists.
pub fn did_you_mean(value: &str, candidates: &[&str]) -> String {
    closest_by_edit_distance(value, candidates).map_or(String::new(), |c| format!(" — did you mean '{c}'?"))
}

/// `closestByEditDistance`, over UTF-16 units as the TypeScript counts.
pub fn closest_by_edit_distance<'a>(value: &str, candidates: &[&'a str]) -> Option<&'a str> {
    let units = movement_parser::util::form::units_vec(value);
    let mut best: Option<(&'a str, usize, usize)> = None;
    for candidate in candidates {
        let other = movement_parser::util::form::units_vec(candidate);
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

// ── Path heads (`checkPathHead`, and the walk each block, lazy entry and
// awaited head types its hops with) ──

/// Where a head's walk went: each hop alias's landing, and the last.
pub struct HeadWalk {
    pub locals: indexmap::IndexMap<String, Option<Position>>,
    pub landed: Option<Position>,
    pub last_edge_schema: Option<EdgeSchema>,
    pub ordering: CollectionOrder,
}

impl crate::checker::Checker<'_> {
    /// The hops a head walks (`parsed.steps` of its probe), when it parses to
    /// a plain hop chain.
    fn head_steps(head: &PathHead) -> Option<Vec<TraversalStep>> {
        let root = match &head.root {
            None => String::new(),
            Some(PathRoot::Name { name }) => crate::families::names::spell_name(name),
            Some(PathRoot::Expression { .. }) => "__movement_expression_root__".to_string(),
        };
        match crate::slots::expression_of_text(&format!("{root}{}.`__movement_head_probe__`", head.hops_raw)).ok()? {
            Expression::Traverse { steps, .. } => Some(steps),
            _ => None,
        }
    }

    /// `rootValueType`: what a head's root holds on the value plane.
    fn head_root_value_type(&self, head: &PathHead, scope: ScopeId) -> Option<Ty> {
        match &head.root {
            Some(PathRoot::Expression { expr }) => self.type_of_slot(expr, scope).and_then(|(_, ty, _)| ty),
            Some(PathRoot::Name { name }) => {
                let types = self.symbol_types(name, scope)?;
                if types.pos.is_some() {
                    return None;
                }
                widen_tuples(types.field.clone(), self.version)
            }
            None => None,
        }
    }

    fn symbol_types(&self, name: &str, scope: ScopeId) -> Option<&SymbolTypes> {
        match self.scopes.resolve(scope, name) {
            Resolution::Found(id) => Some(&self.scopes.symbol(id).types),
            _ => None,
        }
    }

    /// `rootType`: where a head's walk starts.
    fn head_root_type(&self, head: &PathHead, scope: ScopeId) -> Option<Position> {
        let symbol_pos = match &head.root {
            Some(PathRoot::Name { name }) => self.symbol_types(name, scope).and_then(|t| t.pos.clone()),
            _ => None,
        };
        symbol_pos.or_else(|| record_head_position(self.head_root_value_type(head, scope).as_ref()))
    }

    /// `checkPathHead`'s MOV_HEAD_NOT_A_POSITION: a hop off a root whose value
    /// type is known and holds no record.
    pub fn report_head_not_a_position(&mut self, head: &PathHead, scope: ScopeId) {
        let Some(root) = &head.root else { return };
        if Self::head_steps(head).is_none() {
            return;
        }
        let Some(value) = self.head_root_value_type(head, scope) else { return };
        if holds_records(Some(&value)) {
            return;
        }
        let spelled = match root {
            PathRoot::Name { name } => crate::families::names::spell_name(name),
            PathRoot::Expression { expr } => expr.raw.clone(),
        };
        self.report(
            codes::HEAD_NOT_A_POSITION,
            format!(
                "'{spelled}' is {}, and a hop walks from a POSITION — there is nothing here to hop from. A head starts at a record, an extraction's result, or a list of them ('found = MAP(pieces, (p) => {{ return extract … }})'); read a value with the value functions instead.",
                describe_field_type(&value)
            ),
            head.span,
        );
    }

    /// `slotTyping(scope, head.span).walkSteps(rootType, steps)`: types the
    /// head's hops, reporting what the walk reports.
    pub fn walk_head(&mut self, head: &PathHead, scope: ScopeId, awaited: bool) -> Option<HeadWalk> {
        let steps = Self::head_steps(head)?;
        let start = self.head_root_type(head, scope)?;
        let (walk, diagnostics, watchable) = {
            let env = self.typing_env(scope);
            let mut typing = Typing::new(&env, self.version, head.span);
            let landed = typing.walk_steps(Some(start), &steps, awaited);
            let walk = HeadWalk {
                locals: typing.locals.clone(),
                landed,
                last_edge_schema: typing.last_edge_schema.clone(),
                ordering: typing.last_ordering,
            };
            (walk, std::mem::take(&mut typing.diagnostics), std::mem::take(&mut typing.watchable_reads))
        };
        self.effects.note_watchable_reads(&watchable);
        for diagnostic in diagnostics {
            self.push(diagnostic);
        }
        Some(walk)
    }

    /// Gives each hop alias declared in `landing` the position its hop landed on.
    pub fn type_hop_aliases(&mut self, landing: ScopeId, aliases: &[String], walk: Option<&HeadWalk>) {
        let Some(walk) = walk else { return };
        for alias in aliases {
            if let Some(Some(pos)) = walk.locals.get(alias) {
                self.set_types(landing, alias, SymbolTypes { pos: Some(pos.clone()), ..SymbolTypes::default() });
            }
        }
    }
}

impl crate::checker::Checker<'_> {
    /// `positionFromTypeRefStrict`, the reporting half: a written parameter
    /// type naming a position its graph's schema does not have.
    pub fn report_param_position(&mut self, type_: &movement_parser::ast::ParamTypeRef, scope: ScopeId) {
        let movement_parser::ast::ParamTypeRef::Name(reference) = type_ else { return };
        if reference.hops_raw.is_none() && reference.position.is_none() {
            return;
        }
        let Resolution::Found(id) = self.scopes.resolve(scope, &reference.graph) else { return };
        let symbol = self.scopes.symbol(id);
        if symbol.kind == crate::scope::SymbolKind::Adapter {
            return;
        }
        if symbol.kind == crate::scope::SymbolKind::Shape {
            if reference.hops_raw.is_some() {
                let graph = &reference.graph;
                let name = reference.position.as_deref().unwrap_or("name");
                self.report(
                    codes::SHAPE_HOP_RETIRED,
                    format!(
                        "'{graph}' is a declared node — the structure a parameter is checked against — and it IS the record it describes, so there is nothing to hop through: write '<{graph}>'. Its nested nodes are edges you traverse off the parameter instead ('d-[x:{name}]->')"
                    ),
                    reference.span,
                );
            }
            return;
        }
        if let Some(hops) = &reference.hops_raw {
            self.report_meta_hops_in_type_ref(hops, reference.span);
            self.check_address_pins(&reference.graph, hops, reference.span, scope);
        }
        let symbol = self.scopes.symbol(id);
        let Some(Position::Meta { instance }) = &symbol.types.pos else { return };
        let Some(position) = &reference.position else { return };
        let resolved = match &reference.hops_raw {
            Some(hops) => crate::types::event_address::position_from_address(instance, hops),
            None => crate::types::position::position_ref_in(instance, position),
        };
        if resolved.is_some() {
            return;
        }
        let mut available: Vec<&str> = instance.schema.unions.iter().flat_map(|u| u.keys()).map(String::as_str).collect();
        for name in instance.schema.positions.keys() {
            if !available.contains(&name.as_str()) {
                available.push(name);
            }
        }
        let message = format!("'{}' has no position type '{position}'{}", reference.graph, it_has(&available));
        self.report(codes::UNKNOWN_POSITION, message, reference.span);
    }
}

/// The IS test a NARROWING message suggests: the first `action` option whose
/// narrowing of the union's own address carries what was asked for.
fn narrowing_example(u: &crate::types::position::UnionPosition, carrying: &[&String]) -> String {
    let fallback = format!("x IS <{}-[:`…` WHERE …]->>", u.instance.name);
    let Some(address) = &u.address else { return fallback };
    let action = u.instance.schema.positions.get(&address.event).and_then(|p| p.properties.get("action")).map(Ty::from_schema);
    let Some(Ty::Enum { options, .. }) = action else { return fallback };
    for option in options {
        let mut narrowing: Vec<(String, String)> = address.narrowing.iter().filter(|(k, _)| k != "action").cloned().collect();
        match address.narrowing.iter().position(|(k, _)| k == "action") {
            Some(at) => narrowing.insert(at.min(narrowing.len()), ("action".to_string(), option.clone())),
            None => narrowing.push(("action".to_string(), option.clone())),
        }
        let key = crate::types::event_address::event_address_key(&crate::types::event_address::EventAddress { event: address.event.clone(), narrowing });
        if carrying.iter().any(|v| **v == key) {
            return format!("x IS <{}-[:`{}` WHERE `action` == \"{option}\"]->>", u.instance.name, address.event);
        }
    }
    fallback
}

// ── IS-test narrowing (`checkCondition`'s isTest case, `checkIf`'s
// elimination down the arms) ──

/// What the failed `IS` tests above an arm ruled out, per subject name.
pub type RuledOut = indexmap::IndexMap<String, Vec<String>>;

/// `residualUnion`: a union with only `remaining` left; one left is that position.
fn residual_union(union: &crate::types::position::UnionPosition, remaining: &[String]) -> Position {
    let mut variants: Vec<String> = remaining.to_vec();
    variants.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    variants.dedup();
    if variants.len() == 1 {
        return Position::record(union.instance.clone(), variants[0].clone());
    }
    let key = serde_json::to_string(&("union", &variants)).unwrap_or_default();
    let display = variants.iter().map(|v| display_name_of(&union.instance, v)).collect::<Vec<_>>().join(" | ");
    Position::Union(crate::types::position::UnionPosition {
        instance: union.instance.clone(),
        union: key,
        variants,
        narrows_event: None,
        display: Some(display),
        address: None,
        parameter: union.parameter.clone(),
    })
}

/// `ruledOutVariant`: the variant a failed test disproves, if any.
fn ruled_out_variant(type_: &movement_parser::lowering::condition::IsType, union: &crate::types::position::UnionPosition) -> Option<String> {
    let Some(hops) = &type_.hops_raw else { return type_.position.clone() };
    let test = crate::types::event_address::event_address_of_hops(hops)?;
    let subject = union.address.clone().unwrap_or(crate::types::event_address::EventAddress { event: union.union.clone(), narrowing: Vec::new() });
    if subject.event != test.event {
        return None;
    }
    let merged = merge_pins(&subject.narrowing, &test.narrowing)?;
    let key = crate::types::event_address::event_address_key(&crate::types::event_address::EventAddress { event: test.event, narrowing: merged });
    union.variants.contains(&key).then_some(key)
}

/// The subject's pins extended by the test's; `None` when they contradict.
fn merge_pins(subject: &[(String, String)], test: &[(String, String)]) -> Option<Vec<(String, String)>> {
    let mut merged = subject.to_vec();
    for (key, value) in test {
        match merged.iter().find(|(k, _)| k == key) {
            Some((_, existing)) if existing != value => return None,
            Some(_) => {}
            None => merged.push((key.clone(), value.clone())),
        }
    }
    Some(merged)
}

impl crate::checker::Checker<'_> {
    fn graph_instance(&self, graph: &str, scope: ScopeId) -> Option<crate::types::position::InstanceRef> {
        match self.symbol_types(graph, scope)?.pos.as_ref()? {
            Position::Meta { instance } => Some(instance.clone()),
            _ => None,
        }
    }

    fn union_of(&self, name: &str, scope: ScopeId) -> Option<crate::types::position::UnionPosition> {
        match self.symbol_types(name, scope)?.pos.as_ref()? {
            Position::Union(u) => Some(u.clone()),
            _ => None,
        }
    }

    /// Re-declares `name` (resolved from `scope`) into `into` with a sharper position.
    fn declare_narrowed(&mut self, name: &str, scope: ScopeId, into: ScopeId, position: Option<Position>) {
        let Resolution::Found(id) = self.scopes.resolve(scope, name) else { return };
        let mut symbol = self.scopes.symbol(id).clone();
        symbol.types.pos = position;
        let narrowed = self.scopes.add_symbol(symbol);
        self.scopes.declare(into, narrowed);
    }

    /// The `IS` test's walks rules: an unknown position, and the narrowing a
    /// positive test declares into the arm (`narrow_into`).
    pub fn check_is_test(
        &mut self,
        subject_raw: &str,
        type_: &movement_parser::lowering::condition::IsType,
        span: movement_parser::ast::Span,
        scope: ScopeId,
        narrow_into: Option<ScopeId>,
    ) {
        let subject = subject_raw.trim();
        let bare = crate::slots::is_bare_ident(subject);
        let Resolution::Found(graph_id) = self.scopes.resolve(scope, &type_.graph) else { return };
        if self.scopes.symbol(graph_id).kind == crate::scope::SymbolKind::Shape {
            if type_.position.is_some() || type_.hops_raw.is_some() {
                let graph = crate::families::names::spell_name(&type_.graph);
                let name = crate::families::names::spell_name(type_.position.as_deref().unwrap_or("name"));
                self.report(
                    codes::SHAPE_HOP_RETIRED,
                    format!(
                        "'{}' is a declared node — it IS the record it describes, so there is nothing to hop through: write '{subject} IS <{graph}>'. Its nested nodes are edges you traverse off the value instead ('{subject}-[x:{name}]->')",
                        type_.graph
                    ),
                    span,
                );
                return;
            }
            // A structural test: the arm keeps every member that conforms
            // (or that nothing could compare).
            if let Some(into) = narrow_into
                && let Some(union) = self.union_of(subject, scope)
            {
                let conforming: Vec<String> =
                    union.variants.iter().filter(|v| self.conforms_to_declared_node(&union.instance, v, graph_id) != Some(false)).cloned().collect();
                if conforming.len() != union.variants.len() {
                    self.declare_narrowed(subject, scope, into, Some(residual_union(&union, &conforming)));
                }
            }
            return;
        }
        let instance = self.graph_instance(&type_.graph, scope);
        if let (Some(instance), Some(position)) = (&instance, &type_.position)
            && crate::types::position::position_ref_in(instance, position).is_none()
        {
            let mut available: Vec<&str> = instance.schema.unions.iter().flat_map(|u| u.keys()).map(String::as_str).collect();
            for name in instance.schema.positions.keys() {
                if !available.contains(&name.as_str()) {
                    available.push(name);
                }
            }
            let message = format!("'{}' has no position type '{position}'{}", type_.graph, it_has(&available));
            self.report(codes::UNKNOWN_POSITION, message, span);
        }
        if let Some(hops) = &type_.hops_raw {
            self.check_address_pins(&type_.graph, hops, span, scope);
        }
        let (Some(into), Some(instance), true) = (narrow_into, instance, bare) else { return };
        let subject_pos = self.symbol_types(subject, scope).and_then(|t| t.pos.clone());
        if let (Some(Position::Union(union)), Some(position)) = (&subject_pos, &type_.position)
            && crate::types::position::same_instance(&union.instance, &instance)
            && union.variants.contains(position)
        {
            self.declare_narrowed(subject, scope, into, Some(Position::record(instance.clone(), position.clone())));
        }
        // The same type guard on a value that may be a record or may be
        // something else (`v = COALESCE(org, "x")`): inside the arm it IS the
        // record the test names — TypeScript's `Org | string` narrowed.
        if let (None, Some(position), None) = (&subject_pos, &type_.position, &type_.hops_raw)
            && let Resolution::Found(id) = self.scopes.resolve(scope, subject)
            && {
                let types = &self.scopes.symbol(id).types;
                crate::types::field::mixes_record_with_value(types.field.as_ref()) || crate::types::field::mixes_record_with_value(types.may_hold.as_ref())
            }
        {
            let narrowed = Position::record(instance.clone(), position.clone());
            let mut symbol = self.scopes.symbol(id).clone();
            symbol.types.may_hold = None;
            symbol.types.field = Some(Ty::record(Some(narrowed.clone())));
            symbol.types.pos = Some(narrowed);
            let narrowed = self.scopes.add_symbol(symbol);
            self.scopes.declare(into, narrowed);
        }
        let Some(hops) = &type_.hops_raw else { return };
        let Some(test) = crate::types::event_address::event_address_of_hops(hops) else { return };
        let (subject_instance, subject_address) = match &subject_pos {
            Some(Position::Position(p)) => (&p.instance, crate::types::event_address::EventAddress { event: p.position.clone(), narrowing: Vec::new() }),
            Some(Position::Union(u)) => {
                (&u.instance, u.address.clone().unwrap_or(crate::types::event_address::EventAddress { event: u.union.clone(), narrowing: Vec::new() }))
            }
            _ => return,
        };
        if !crate::types::position::same_instance(subject_instance, &instance) || subject_address.event != test.event {
            return;
        }
        let Some(merged) = merge_pins(&subject_address.narrowing, &test.narrowing) else { return };
        let address = crate::types::event_address::EventAddress { event: test.event, narrowing: merged };
        let narrowed = !address.narrowing.is_empty();
        let resolved = match crate::types::position::position_ref_in(&instance, &crate::types::event_address::event_address_key(&address)) {
            Some(Position::Position(mut p)) => {
                if narrowed {
                    p.narrows_event = Some(address.event.clone());
                }
                Position::Position(p)
            }
            Some(Position::Union(mut u)) => {
                if narrowed {
                    u.narrows_event = Some(address.event.clone());
                }
                u.address = Some(address);
                Position::Union(u)
            }
            _ => return,
        };
        self.declare_narrowed(subject, scope, into, Some(resolved));
    }

    /// `collectIsElimination`: a bare `IS` that failed rules its variant out.
    pub fn collect_is_elimination(&self, condition: &movement_parser::lowering::condition::MovementCondition, scope: ScopeId, ruled_out: &mut RuledOut) {
        let movement_parser::lowering::condition::MovementCondition::IsTest { subject_raw, type_ } = condition else { return };
        let subject = subject_raw.trim();
        if !crate::slots::is_bare_ident(subject) {
            return;
        }
        let Some(union) = self.union_of(subject, scope) else { return };
        let Resolution::Found(graph) = self.scopes.resolve(scope, &type_.graph) else { return };
        if self.scopes.symbol(graph).kind == crate::scope::SymbolKind::Shape {
            if type_.position.is_some() || type_.hops_raw.is_some() {
                return;
            }
            // Only a member proved to conform is ruled out by the failure.
            let conforming: Vec<String> =
                union.variants.iter().filter(|v| self.conforms_to_declared_node(&union.instance, v, graph) == Some(true)).cloned().collect();
            let eliminated = ruled_out.entry(subject.to_string()).or_default();
            for variant in conforming {
                if !eliminated.contains(&variant) {
                    eliminated.push(variant);
                }
            }
            return;
        }
        let Some(instance) = self.graph_instance(&type_.graph, scope) else { return };
        if !crate::types::position::same_instance(&union.instance, &instance) {
            return;
        }
        let Some(variant) = ruled_out_variant(type_, &union) else { return };
        let eliminated = ruled_out.entry(subject.to_string()).or_default();
        if !eliminated.contains(&variant) {
            eliminated.push(variant);
        }
    }

    /// `declareEliminated`: each subject, its union minus what was ruled out.
    pub fn declare_eliminated(&mut self, ruled_out: &RuledOut, scope: ScopeId, into: ScopeId) {
        for (name, eliminated) in ruled_out {
            let Some(union) = self.union_of(name, scope) else { continue };
            let remaining: Vec<String> = union.variants.iter().filter(|v| !eliminated.contains(v)).cloned().collect();
            if remaining.len() == union.variants.len() {
                continue;
            }
            self.declare_narrowed(name, scope, into, Some(residual_union(&union, &remaining)));
        }
    }
}

impl crate::checker::Checker<'_> {
    /// `checkWalkKeepsWhatIsWritten`, the hop half: what the lowering would
    /// drop from a walk written in an expression. A walk ending in a resource
    /// hop is the extraction family's.
    pub fn check_walk_keeps_what_is_written(&mut self, hops: &[movement_parser::tree::Hop], span: movement_parser::ast::Span) {
        for hop in hops {
            let label = hop.label.text.as_str();
            if label == "#transform" {
                let message = self.transform_hop_retired_message(hop);
                self.report(codes::TRANSFORM_HOP_RETIRED, message, span);
                continue;
            }
            // `endingHop`: the label up to its first ':' or space.
            let base = label.split(|c: char| c == ':' || c.is_whitespace()).next().unwrap_or(label);
            if base == "#linked" {
                self.report(codes::LINKED_HOP_RETIRED, crate::families::writes::linked_hop_retired_message(self.version), span);
                continue;
            }
            // `isRetiredMetaHop`: from version 5 its own diagnostic, never the settings one.
            if self.version >= 5 && label.starts_with('#') && label != "#extract" {
                self.report(codes::META_HOP_RETIRED, meta_hop_retired_message(label), span);
                continue;
            }
            if hop.config.is_some() {
                self.report(
                    codes::HOP_CONFIG_UNREAD,
                    format!("the settings '{{ … }}' on the hop '{label}' are not read — a hop takes no settings. Remove them, or say what they mean in the hop's WHERE"),
                    span,
                );
            }
        }
    }

    /// `reportMetaHopsInTypeRef` (language version 5): a type's address walks
    /// no `#` hop either, refused where the address is written.
    pub fn report_meta_hops_in_type_ref(&mut self, hops_raw: &str, span: movement_parser::ast::Span) {
        if self.version < 5 {
            return;
        }
        // `hopsOfAddress`: the address read by the expression grammar; none
        // when it does not parse (the address's own check says so).
        let parsed = movement_parser::expr::parse_expression(&format!("__address_probe__{hops_raw}"));
        let Ok(movement_parser::tree::MExpr::Path { hops, .. }) = &parsed else { return };
        for hop in hops {
            if hop.label.text.starts_with('#') && hop.label.text != "#extract" {
                self.report(codes::META_HOP_RETIRED, meta_hop_retired_message(&hop.label.text), span);
            }
        }
    }

    /// `transformHopRetiredMessage`: the call to write instead, named from
    /// the hop's `plugin` setting when the catalog knows it.
    fn transform_hop_retired_message(&self, hop: &movement_parser::tree::Hop) -> String {
        use crate::families::names::{import_line, spell_name};
        use movement_parser::tree::{MExpr, MapKey, MapMember, StringPart};
        let lead = "the '#transform' hop is retired — the movement engine never runs it. Import the plugin and call it with the value it reads";
        let plugin = hop.config.as_ref().and_then(|config| {
            config.entries.iter().find_map(|entry| match entry {
                MapMember::Entry { key, value } if map_key_text(key) == "plugin" => Some(value),
                _ => None,
            })
        });
        let plugin = match plugin {
            Some(MExpr::String { parts, .. }) => match parts.as_slice() {
                [StringPart::Text(text)] => Some(text.as_str()),
                _ => None,
            },
            _ => None,
        };
        fn map_key_text(key: &MapKey) -> &str {
            match key {
                MapKey::Name(name) => &name.text,
                MapKey::String(key) => &key.text,
            }
        }
        let Some((plugin, spec)) = plugin.and_then(|p| self.catalog.plugin(p).map(|spec| (p, spec))) else {
            return format!("{lead}, e.g. '{}', then 'page = fetch_url(url: m.u)'", import_line("fetch_url", "plugins"));
        };
        if self.version >= 5 {
            return transform_hop_as_function(plugin, spec);
        }
        let args = spec.required_args.iter().flatten().map(|arg| format!("{arg}: …")).collect::<Vec<_>>().join(", ");
        format!(
            "{lead}: '{}', then 'out = {}({})'",
            import_line(plugin, "plugins"),
            spell_name(plugin),
            if args.is_empty() { "…" } else { &args }
        )
    }
}

/// `transformHopAsFunction` (language version 5): a plugin is a function, or
/// a stage of an extraction when it has no output of its own.
fn transform_hop_as_function(plugin: &str, spec: &movement_parser::catalog::types::PluginSpec) -> String {
    use crate::families::names::{import_line, spell_name};
    let lead = "the '#transform' hop is retired — there are no meta edges, and a plugin is a function";
    let name = spell_name(plugin);
    if spec.effects.is_none() || spec.fed_by_extraction == Some(true) || spec.output.is_none() {
        return format!("{lead}, but '{plugin}' runs only as a stage of an extraction: '{}', then 'extract from [ … ] through [{name}] {{ … }}'", import_line(plugin, "plugins"));
    }
    let required: Vec<String> = spec
        .required_args
        .iter()
        .flatten()
        .cloned()
        .chain(spec.fed_args.iter().flatten().filter(|fed| fed.required == Some(true)).map(|fed| fed.name.clone()))
        .map(|arg| format!("{arg}: …"))
        .collect();
    let args = required.join(", ");
    format!(
        "{lead}: import it and call it, and bind what it hands back like any function's result — '{}', then 'out = {name}({})'",
        import_line(plugin, "plugins"),
        if args.is_empty() { "…" } else { &args }
    )
}

/// `metaHopRetiredMessage` (language version 5).
fn meta_hop_retired_message(label: &str) -> String {
    let lead = format!("'-[:{label}]->' is a '#' hop, and '#' hops are retired — there are no meta edges, only the edges a system declares");
    if label == "#transform" {
        return format!("{lead}. A plugin is a function: import it and call it ('import {{ fetch_url }} from plugins', then 'page = fetch_url(url: …)')");
    }
    if label == "#linked" || label.starts_with("#linked ") {
        return format!("{lead}. Keep the write's handle and read from it ('rec = write crm-[:Companies]-> {{ … }}', then 'rec.<field>')");
    }
    if label.split(|c: char| c == ':' || c.is_whitespace()).next() == Some("#resources") {
        return format!("{lead}. '#resources' is the old spelling of the resource edge: write '-[f:_resources]->' off an extraction's result, or walk the edge a system declares to a record's files");
    }
    format!("{lead}. Walk an edge the record has; for what a plugin computes, import the plugin and call it ('import {{ fetch_url }} from plugins', then 'page = fetch_url(url: …)')")
}
