//! The event types a listen fires and the position its movement's parameter
//! names, each read off the listened instance's schema, and whether the
//! parameter accepts each (check.ts `derivedEventTypes`, `positionFromTypeRef`;
//! typing.ts `positionsMatch`, `describePosition`; event_address.ts).
//!
//! TODO(type-core): a narrow local stand-in for `PositionTypeRef` and
//! instance identity. Both sides here are positions of ONE instance (the
//! listen has already refused a parameter typed against another), so the
//! instance token is never compared. The type core's positions replace this.

use movement_parser::ast::TypeRef;
use movement_parser::catalog::types::{Composite, FieldType, InstanceSchema, PositionSchema};
use movement_parser::lowering::expression::{Expression, LogicalOp, StaticValue, TraversalStep};

use crate::slots::expression_of_text;

/// `EVENT_ACTION_FIELD`: the change-kind axis an event node may declare.
pub const EVENT_ACTION_FIELD: &str = "action";
/// `RECORD_DELETED_ACTION`.
const RECORD_DELETED_ACTION: &str = "record.deleted";

/// `EventAddress`: an event edge and the values it pins, in canonical order.
#[derive(Debug, Clone, PartialEq)]
pub struct Address {
    pub event: String,
    pins: Vec<(String, String)>,
}

impl Address {
    pub fn new(event: impl Into<String>, mut pins: Vec<(String, String)>) -> Self {
        pins.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
        Address { event: event.into(), pins }
    }

    fn with(&self, key: &str, value: &str) -> Address {
        let mut pins: Vec<(String, String)> = self.pins.iter().filter(|(k, _)| k != key).cloned().collect();
        pins.push((key.to_string(), value.to_string()));
        Address::new(self.event.clone(), pins)
    }

    /// `eventAddressKey`: the identity a position is filed under. Opaque.
    pub fn key(&self) -> String {
        if self.pins.is_empty() {
            return self.event.clone();
        }
        let pins: Vec<[&str; 2]> = self.pins.iter().map(|(k, v)| [k.as_str(), v.as_str()]).collect();
        serde_json::to_string(&(&self.event, pins)).expect("strings always serialise")
    }

    /// `eventAddressDisplay`.
    pub fn display(&self) -> String {
        if self.pins.is_empty() {
            return self.event.clone();
        }
        let pins: Vec<String> = self.pins.iter().map(|(k, v)| format!("{k}={v}")).collect();
        format!("{} where {}", self.event, pins.join(", "))
    }

    /// `eventAddressSource`: the annotation an author would write for it.
    pub fn source(&self, instance: &str) -> String {
        let pins: Vec<String> = self
            .pins
            .iter()
            .map(|(k, v)| format!("`{k}` == {}", serde_json::to_string(v).expect("strings always serialise")))
            .collect();
        let filter = if pins.is_empty() { String::new() } else { format!(" WHERE {}", pins.join(" AND ")) };
        format!("<{instance}-[:`{}`{filter}]->>", self.event)
    }

    fn is_narrowed(&self) -> bool {
        !self.pins.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Kind {
    /// The instance itself (`<inst>`).
    Meta,
    Position,
    Union { variants: Vec<String> },
}

/// A position of the listened instance.
#[derive(Debug, Clone)]
pub struct EventRef {
    pub kind: Kind,
    /// The position or union key (empty for the instance itself).
    pub key: String,
    pub narrows_event: Option<String>,
    pub display: Option<String>,
    pub address: Option<Address>,
}

impl EventRef {
    fn plain(kind: Kind, key: impl Into<String>) -> Self {
        EventRef { kind, key: key.into(), narrows_event: None, display: None, address: None }
    }
}

/// `positionRefIn`: a union first, then a position.
fn position_ref_in(schema: &InstanceSchema, name: &str) -> Option<EventRef> {
    if let Some(variants) = schema.unions.as_ref().and_then(|u| u.get(name)) {
        return Some(EventRef::plain(Kind::Union { variants: variants.clone() }, name));
    }
    schema.positions.get(name).map(|_| EventRef::plain(Kind::Position, name))
}

fn enum_options(type_: Option<&FieldType>) -> Option<&Vec<String>> {
    match type_ {
        Some(FieldType::Composite(Composite::Enum { options, .. })) => Some(options),
        _ => None,
    }
}

/// `listenNarrowing`: the address a listen's config states, when it names
/// every declared hop (none declared: the empty address).
fn listen_narrowing(keys: Option<&Vec<String>>, config: &[(String, String)]) -> Option<Vec<(String, String)>> {
    let Some(keys) = keys.filter(|k| !k.is_empty()) else { return Some(Vec::new()) };
    keys.iter().map(|key| config.iter().find(|(k, _)| k == key).map(|(_, v)| (key.clone(), v.clone()))).collect()
}

/// `derivedEventTypes`: the type(s) a listen fires, from its config alone;
/// none when the instance declares no event edges.
pub fn derived_event_types(schema: &InstanceSchema, selected: Option<&[String]>, config: &[(String, String)]) -> Option<Vec<EventRef>> {
    let event_positions = schema.event_positions.as_ref().filter(|e| !e.is_empty())?;
    let narrowing = listen_narrowing(schema.event_narrowing_keys.as_ref(), config).unwrap_or_default();
    let ref_for = |address: Address| -> EventRef {
        let mut base = match position_ref_in(schema, &address.key()) {
            Some(resolved) => resolved,
            None => EventRef::plain(Kind::Position, address.key()),
        };
        if address.is_narrowed() {
            base.narrows_event = Some(address.event.clone());
            base.display = Some(address.display());
        }
        base.address = Some(address);
        base
    };
    let mut derived = Vec::new();
    for event_position in event_positions {
        let event = &event_position.position;
        let delivered: Option<Vec<&String>> =
            selected.map(|s| s.iter().filter(|v| event_position.on.as_ref().is_none_or(|on| on.contains(v))).collect());
        if delivered.as_ref().is_some_and(Vec::is_empty) {
            continue;
        }
        let address = Address::new(event.clone(), narrowing.clone());
        let action_enum = enum_options(schema.positions.get(event).and_then(|p| p.properties.get(EVENT_ACTION_FIELD)));
        let (Some(action_enum), Some(delivered)) = (action_enum, delivered) else {
            derived.push(ref_for(address));
            continue;
        };
        let mut pinnable: Vec<&String> = Vec::new();
        for value in delivered.into_iter().filter(|v| action_enum.contains(v)) {
            if !pinnable.contains(&value) {
                pinnable.push(value);
            }
        }
        if pinnable.is_empty() || action_enum.iter().all(|v| pinnable.contains(&v)) {
            derived.push(ref_for(address));
            continue;
        }
        if let [only] = pinnable.as_slice() {
            derived.push(ref_for(address.with(EVENT_ACTION_FIELD, only)));
            continue;
        }
        let display = address.is_narrowed().then(|| address.display());
        derived.push(EventRef {
            kind: Kind::Union { variants: pinnable.iter().map(|v| address.with(EVENT_ACTION_FIELD, v).key()).collect() },
            key: address.key(),
            narrows_event: Some(event.clone()),
            display,
            address: Some(address),
        });
    }
    (!derived.is_empty()).then_some(derived)
}

/// `positionFromTypeRef` for a parameter typed against an instance.
pub fn param_position(schema: &InstanceSchema, declared: &TypeRef) -> Option<EventRef> {
    if let Some(hops) = &declared.hops_raw {
        let address = address_of_hops(hops)?;
        let mut resolved = position_ref_in(schema, &address.key())?;
        if address.is_narrowed() {
            resolved.narrows_event = Some(address.event.clone());
        }
        resolved.address = Some(address);
        return Some(resolved);
    }
    match &declared.position {
        None => Some(EventRef::plain(Kind::Meta, "")),
        Some(position) => position_ref_in(schema, position),
    }
}

/// `eventAddressOfHops`: one hop, and the pins its WHERE states.
fn address_of_hops(hops_raw: &str) -> Option<Address> {
    let trimmed = hops_raw.trim();
    if !trimmed.starts_with("-[") {
        return None;
    }
    let probe = format!("__movement_path_root__{trimmed}.`__movement_path_probe__`");
    let Expression::Traverse { steps, .. } = expression_of_text(&probe).ok()? else { return None };
    let [TraversalStep::Edge(step)] = steps.as_slice() else { return None };
    let mut pins = Vec::new();
    if let Some(filter) = step.expression_filter.as_deref()
        && !collect_pins(filter, &mut pins)
    {
        return None;
    }
    Some(Address::new(step.edge_type_id.clone(), pins))
}

/// `collectPins`: a conjunction of `` `key` == "literal" ``.
fn collect_pins(expr: &Expression, into: &mut Vec<(String, String)>) -> bool {
    if let Expression::Logical { op: LogicalOp::And, operands } = expr {
        return operands.iter().all(|child| collect_pins(child, into));
    }
    let Expression::Compare { op, left, right } = expr else { return false };
    if !matches!(op, movement_parser::lowering::expression::FilterOperator::Eq) {
        return false;
    }
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
        Expression::Static { value: StaticValue::String(value) } => Some(Side::Literal(value.clone())),
        Expression::Property { property_type_id } | Expression::EdgeProperty { property_type_id } => Some(Side::Read(property_type_id.clone())),
        _ => None,
    }
}

fn accepts_any_narrowing(param: &EventRef, arg_narrows: Option<&String>) -> bool {
    param.narrows_event.is_none() && arg_narrows == Some(&param.key)
}

/// `positionsMatch` for an event type against the parameter's position,
/// both of one instance.
pub fn positions_match(arg: &EventRef, param: &EventRef) -> bool {
    match (&param.kind, &arg.kind) {
        (Kind::Position, Kind::Position) => arg.key == param.key || accepts_any_narrowing(param, arg.narrows_event.as_ref()),
        (Kind::Position, Kind::Union { .. }) => accepts_any_narrowing(param, arg.narrows_event.as_ref()),
        (Kind::Union { .. }, Kind::Union { .. }) => arg.key == param.key || accepts_any_narrowing(param, arg.narrows_event.as_ref()),
        (Kind::Union { variants }, Kind::Position) => {
            variants.contains(&arg.key) || accepts_any_narrowing(param, arg.narrows_event.as_ref())
        }
        (Kind::Meta, Kind::Meta) => true,
        _ => false,
    }
}

fn display_name_of(schema: &InstanceSchema, position: &str) -> String {
    schema.positions.get(position).and_then(|p| p.display_name.clone()).unwrap_or_else(|| position.to_string())
}

/// `describeEventType`: the display, never the key.
pub fn describe_event_type(schema: &InstanceSchema, type_: &EventRef, instance: &str) -> String {
    match &type_.kind {
        Kind::Union { variants } => type_
            .display
            .clone()
            .unwrap_or_else(|| variants.iter().map(|v| display_name_of(schema, v)).collect::<Vec<_>>().join(" | ")),
        Kind::Position => type_.display.clone().unwrap_or_else(|| display_name_of(schema, &type_.key)),
        Kind::Meta => describe_position(schema, type_, instance),
    }
}

/// `describePosition`.
pub fn describe_position(schema: &InstanceSchema, type_: &EventRef, instance: &str) -> String {
    match &type_.kind {
        Kind::Meta => format!("'{instance}' (the instance itself)"),
        Kind::Position => format!("{instance}.{}", display_name_of(schema, &type_.key)),
        Kind::Union { variants } if variants.is_empty() => "a record kind the branches above already cover".to_string(),
        Kind::Union { .. } => {
            let name = schema
                .union_display_names
                .as_ref()
                .and_then(|n| n.get(&type_.key).cloned())
                .or_else(|| type_.display.clone())
                .unwrap_or_else(|| type_.key.clone());
            format!("{instance}.{name}")
        }
    }
}

/// `subjectOf`: the record an event position is about, by the edge the
/// adapter marked `subject`.
pub fn subject_of<'s>(schema: &'s InstanceSchema, event: &'s PositionSchema) -> Option<(&'s str, &'s str, &'s PositionSchema)> {
    event.edges.iter().filter(|(_, e)| e.subject == Some(true)).find_map(|(edge, e)| {
        schema.positions.get(&e.target).map(|position| (edge.as_str(), e.target.as_str(), position))
    })
}

/// `recordSignatureRewrite`: the signature that names the event a listen
/// fires, when the parameter names the record that event is about.
pub fn record_signature_rewrite(
    schema: &InstanceSchema,
    instance: &str,
    fires: &EventRef,
    param_name: &str,
    param: &EventRef,
) -> Option<(String, String, String)> {
    let landed: Vec<&String> = match &fires.kind {
        Kind::Union { variants } => variants.iter().collect(),
        Kind::Position => vec![&fires.key],
        Kind::Meta => return None,
    };
    let address = fires.address.as_ref()?;
    if param.kind != Kind::Position {
        return None;
    }
    for key in landed {
        let Some(position) = schema.positions.get(key) else { continue };
        let Some((edge, target, _)) = subject_of(schema, position) else { continue };
        if target != param.key {
            continue;
        }
        let event_param = if param_name == "event" { "change" } else { "event" };
        return Some((address.source(instance), format!("{event_param}-[{param_name}:{edge}]-> {{ … }}"), event_param.to_string()));
    }
    None
}

/// `eventTraversalExample`: reaching the record, from this instance's own
/// event surface.
/// `version` spells the `if` it suggests.
pub fn event_traversal_example(schema: &InstanceSchema, param_name: &str, instance: &str, version: u32) -> Option<String> {
    for event_position in schema.event_positions.iter().flatten() {
        let event = &event_position.position;
        let Some(position) = schema.positions.get(event) else { continue };
        let actions = enum_options(position.properties.get(EVENT_ACTION_FIELD)).cloned().unwrap_or_default();
        let Some(action) = actions.iter().find(|a| *a != RECORD_DELETED_ACTION) else { continue };
        let Some((edge, edge_schema)) =
            position.edges.iter().find(|(_, e)| e.requires_live_record != Some(true) || action != RECORD_DELETED_ACTION)
        else {
            continue;
        };
        let field = schema.positions.get(&edge_schema.target).and_then(|p| p.properties.keys().next());
        let read = field.map_or("…".to_string(), |f| format!("… r.`{f}`"));
        let test = movement_parser::surface::phrase::spell_if(
            &format!("{param_name} IS <{instance}-[:`{event}` WHERE `{EVENT_ACTION_FIELD}` == \"{action}\"]->>"),
            version,
        );
        return Some(format!("{test} {{ {param_name}-[r:{edge}]-> {{ {read} }} }}"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_an_address_as_the_host_does() {
        let address = Address::new("Record Change", vec![("table".into(), "t".into()), ("base".into(), "b".into())]);
        assert_eq!(address.key(), r#"["Record Change",[["base","b"],["table","t"]]]"#);
        assert_eq!(address.display(), "Record Change where base=b, table=t");
        assert_eq!(Address::new("Tick", vec![]).key(), "Tick");
        let parsed = address_of_hops("-[:`Record Change` WHERE `table` == \"t\" AND `base` == \"b\"]->").unwrap();
        assert_eq!(parsed, address);
    }
}
