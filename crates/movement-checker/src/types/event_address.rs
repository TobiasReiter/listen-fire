//! Event addresses (checker/event_address.ts): a parameter type's one hop
//! and the pins its WHERE states (`<at-[:`Record Change` WHERE `action` ==
//! "record.created"]->>`) name a position the host grafted under the
//! address's key. The key is opaque: built and compared, never parsed.

use movement_parser::lowering::expression::{Expression, LogicalOp, StaticValue, TraversalStep};

use crate::families::walks::is_pure_predicate;

use super::position::{InstanceRef, Position, position_ref_in};

#[derive(Debug, Clone, PartialEq)]
pub struct EventAddress {
    pub event: String,
    /// In the order the pins were written.
    pub narrowing: Vec<(String, String)>,
}

/// `eventAddressOfHops`: one hop, and the pins its WHERE states.
pub fn event_address_of_hops(hops_raw: &str) -> Option<EventAddress> {
    let probe = format!("__movement_path_root__{}.`__movement_path_probe__`", hops_raw.trim());
    let Expression::Traverse { steps, .. } = crate::slots::expression_of_text(&probe).ok()? else { return None };
    let [TraversalStep::Edge(step)] = steps.as_slice() else { return None };
    let narrowing = address_narrowing(step.expression_filter.as_deref())?;
    Some(EventAddress { event: step.edge_type_id.clone(), narrowing })
}

/// `addressNarrowing`: a conjunction of `` `key` == "literal" ``.
fn address_narrowing(filter: Option<&Expression>) -> Option<Vec<(String, String)>> {
    let Some(filter) = filter else { return Some(Vec::new()) };
    if !is_pure_predicate(filter) {
        return None;
    }
    let mut pins = Vec::new();
    collect_pins(filter, &mut pins).then_some(pins)
}

fn collect_pins(expr: &Expression, into: &mut Vec<(String, String)>) -> bool {
    if let Expression::Logical { op: LogicalOp::And, operands } = expr {
        return operands.iter().all(|child| collect_pins(child, into));
    }
    let Expression::Compare { op: movement_parser::lowering::expression::FilterOperator::Eq, left, right } = expr else { return false };
    let (key, value) = match (side(left), side(right)) {
        (Some(Side::Read(key)), Some(Side::Literal(value))) | (Some(Side::Literal(value)), Some(Side::Read(key))) => (key, value),
        _ => return false,
    };
    match into.iter().find(|(k, _)| *k == key) {
        Some((_, existing)) => *existing == value,
        None => {
            into.push((key, value));
            true
        }
    }
}

enum Side {
    Read(String),
    Literal(String),
}

fn side(expr: &Expression) -> Option<Side> {
    match expr {
        Expression::Static { value: StaticValue::String(text) } => Some(Side::Literal(text.clone())),
        Expression::Property { property_type_id, .. } | Expression::EdgeProperty { property_type_id, .. } => Some(Side::Read(property_type_id.clone())),
        _ => None,
    }
}

/// `eventAddressKey`: the bare event, or `[event, pins]` with the pins sorted.
pub fn event_address_key(address: &EventAddress) -> String {
    if address.narrowing.is_empty() {
        return address.event.clone();
    }
    let mut pins = address.narrowing.clone();
    pins.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    serde_json::to_string(&(&address.event, pins)).unwrap_or_else(|_| unreachable!("strings always serialise"))
}

/// `positionFromAddress`: the position an address names, narrowed to its
/// event when it pins anything. An address that names nothing is `never`,
/// not an error.
pub fn position_from_address(instance: &InstanceRef, hops_raw: &str) -> Option<Position> {
    let address = event_address_of_hops(hops_raw)?;
    let resolved = position_ref_in(instance, &event_address_key(&address))?;
    let narrowed = !address.narrowing.is_empty();
    Some(match resolved {
        Position::Position(mut p) => {
            if narrowed {
                p.narrows_event = Some(address.event);
            }
            Position::Position(p)
        }
        Position::Union(mut u) => {
            if narrowed {
                u.narrows_event = Some(address.event.clone());
            }
            u.address = Some(address);
            Position::Union(u)
        }
        other => other,
    })
}

/// `narrowingPrefixKey`: the pins so far as the key `eventNarrowingValues`
/// files the next hop's options under — `JSON.stringify` of the pairs, sorted.
pub fn narrowing_prefix_key(pins: &[(String, String)]) -> String {
    let mut pins = pins.to_vec();
    pins.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    serde_json::to_string(&pins).unwrap_or_default()
}
