//! An event address written as a type (`<crm-[:`Record Change` WHERE
//! `table` == "Deals"]->>`), resolved to the position the host grafted
//! under the same key (checker/event_address.ts, `positionFromAddress` in
//! check.ts). The key is only compared, never parsed.

use std::collections::BTreeMap;

use movement_parser::lowering::expression::{Expression, FilterOperator, LogicalOp, StaticValue, TraversalStep};

use super::position::{InstanceRef, Position, position_ref_in};
use crate::slots::expression_of_text;

/// `EventAddress`: the event edge, and the values its WHERE pins.
pub struct EventAddress {
    pub event: String,
    pub narrowing: BTreeMap<String, String>,
}

/// `eventAddressOfHops`: one edge hop whose WHERE only pins literals.
pub fn event_address_of_hops(hops_raw: &str) -> Option<EventAddress> {
    let trimmed = hops_raw.trim();
    if !trimmed.starts_with("-[") {
        return None;
    }
    let parsed = expression_of_text(&format!("__movement_path_root__{trimmed}.`__movement_path_probe__`")).ok()?;
    let Expression::Traverse { steps, .. } = parsed else { return None };
    let [TraversalStep::Edge(step)] = steps.as_slice() else { return None };
    let mut narrowing = BTreeMap::new();
    if let Some(filter) = &step.expression_filter
        && !collect_pins(filter, &mut narrowing)
    {
        return None;
    }
    Some(EventAddress { event: step.edge_type_id.clone(), narrowing })
}

fn collect_pins(expr: &Expression, into: &mut BTreeMap<String, String>) -> bool {
    if let Expression::Logical { op: LogicalOp::And, operands } = expr {
        return operands.iter().all(|child| collect_pins(child, into));
    }
    let Some((key, value)) = pin_of(expr) else { return false };
    if into.get(&key).is_some_and(|existing| *existing != value) {
        return false;
    }
    into.insert(key, value);
    true
}

enum Side {
    Read(String),
    Literal(String),
}

fn pin_of(expr: &Expression) -> Option<(String, String)> {
    let Expression::Compare { op: FilterOperator::Eq, left, right } = expr else { return None };
    match (side_of(left)?, side_of(right)?) {
        (Side::Read(key), Side::Literal(value)) | (Side::Literal(value), Side::Read(key)) => Some((key, value)),
        _ => None,
    }
}

fn side_of(expr: &Expression) -> Option<Side> {
    match expr {
        Expression::Static { value: StaticValue::String(value) } => Some(Side::Literal(value.clone())),
        Expression::Property { property_type_id } | Expression::EdgeProperty { property_type_id } => Some(Side::Read(property_type_id.clone())),
        _ => None,
    }
}

/// `eventAddressKey`: the event's name when nothing is pinned, else the
/// opaque JSON of the event and its sorted pins.
pub fn event_address_key(address: &EventAddress) -> String {
    if address.narrowing.is_empty() {
        return address.event.clone();
    }
    let pins: Vec<(&String, &String)> = address.narrowing.iter().collect();
    serde_json::to_string(&(&address.event, pins)).unwrap_or_else(|_| address.event.clone())
}

/// `positionFromAddress`: the position an address names, narrowed to its
/// event when it pins anything.
pub fn position_from_address(instance: &InstanceRef, hops_raw: &str) -> Option<Position> {
    let address = event_address_of_hops(hops_raw)?;
    let resolved = position_ref_in(instance, &event_address_key(&address))?;
    if address.narrowing.is_empty() {
        return Some(resolved);
    }
    Some(match resolved {
        Position::Position(mut p) => {
            p.narrows_event = Some(address.event);
            Position::Position(p)
        }
        Position::Union(mut u) => {
            u.narrows_event = Some(address.event);
            Position::Union(u)
        }
        other => other,
    })
}
