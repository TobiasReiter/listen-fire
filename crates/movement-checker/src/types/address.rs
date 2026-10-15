//! Event addresses (checker/event_address.ts): a parameter typed
//! `<crm-[:`Record Change` WHERE `action` == "record.created"]->>` names the
//! event node and the values it pins. Its key (`eventAddressKey`) is the
//! position the host grafted for it; it is compared, never parsed.

use movement_parser::lowering::expression::{Expression, FilterOperator, LogicalOp, StaticValue, TraversalStep};

use crate::slots::expression_of_text;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventAddress {
    pub event: String,
    /// Key → pinned value, in the order written.
    pub narrowing: Vec<(String, String)>,
}

/// `eventAddressOfHops`: one hop and the pins its WHERE states, or `None`
/// when the hops are no address.
pub fn event_address_of_hops(hops_raw: &str) -> Option<EventAddress> {
    let trimmed = hops_raw.trim();
    if !trimmed.starts_with("-[") {
        return None;
    }
    let probe = format!("__movement_path_root__{trimmed}.`__movement_path_probe__`");
    let Expression::Traverse { steps, .. } = expression_of_text(&probe).ok()? else { return None };
    let [TraversalStep::Edge(step)] = steps.as_slice() else { return None };
    let mut narrowing = Vec::new();
    if let Some(filter) = step.expression_filter.as_deref()
        && !collect_pins(filter, &mut narrowing)
    {
        return None;
    }
    Some(EventAddress { event: step.edge_type_id.clone(), narrowing })
}

fn collect_pins(expr: &Expression, into: &mut Vec<(String, String)>) -> bool {
    if let Expression::Logical { op: LogicalOp::And, operands } = expr {
        return operands.iter().all(|child| collect_pins(child, into));
    }
    let Expression::Compare { op: FilterOperator::Eq, left, right } = expr else { return false };
    let pin = match (side(left), side(right)) {
        (Some(Side::Read(key)), Some(Side::Literal(value))) | (Some(Side::Literal(value)), Some(Side::Read(key))) => (key, value),
        _ => return false,
    };
    match into.iter().find(|(k, _)| *k == pin.0) {
        Some((_, existing)) => *existing == pin.1,
        None => {
            into.push(pin);
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
        Expression::Property { property_type_id } | Expression::EdgeProperty { property_type_id } => Some(Side::Read(property_type_id.clone())),
        _ => None,
    }
}

/// `eventAddressKey`: the bare event name, or `JSON.stringify([event, pins])`
/// with the pins sorted by key as JavaScript compares strings.
pub fn event_address_key(address: &EventAddress) -> String {
    if address.narrowing.is_empty() {
        return address.event.clone();
    }
    let mut pins = address.narrowing.clone();
    pins.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    serde_json::to_string(&serde_json::json!([address.event, pins])).unwrap_or_default()
}
