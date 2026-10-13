//! A condition's `IS <type>` test (run.ts `evaluateIsTest`): is this
//! subject's runtime kind the one named? Decided from what the run holds —
//! the event's seeded position and its canonical address, a handle's graph
//! and type, a landed record's stamp, a declared node's structure — never
//! from a host call.
//!
//! Where the kind is not knowable (an undiscriminated event, a record its
//! system returned unstamped, an address axis the event does not carry) the
//! run fails rather than pick a branch, as the TypeScript does. A declared
//! node is compared structurally (checker/conformance.ts `surfaceMisfit`)
//! for a subject whose structure is its own entries — a node the run built,
//! an extracted entity; a record whose structure is a schema's types (the
//! subject itself, or one a node's edge holds) is compared by the checker's
//! assignability, asked of the host (`check.compatible`), which this engine
//! does not carry.

use std::cell::RefCell;
use std::rc::Rc;

use movement_parser::lowering::condition::IsType;
use movement_parser::lowering::expression::{Expression, FilterOperator, LogicalOp, StaticValue, TraversalStep};

use crate::bindings::{Binding, Node, Scope, ShapeBinding};
use crate::extract::emission::Emission;
use crate::run::{EventAddress, Failure, Run, event_address_key};

impl Run<'_> {
    pub(crate) async fn is_test(&self, subject_raw: &str, type_: &IsType, scope: &Scope) -> Result<bool, Failure> {
        let name = crate::js::trim(subject_raw);
        if !bare_ident(name) {
            return Ok(false);
        }
        let (Some(subject), Some(graph)) = (scope.resolve(name), scope.resolve(&type_.graph)) else { return Ok(false) };
        if let Binding::Shape(shape) = &graph
            && type_.hops_raw.is_none()
        {
            return self.declared_node_test(name, &subject, shape, scope).await;
        }
        let graph_named = |instance: &str| matches!(&graph, Binding::Instance(i) if i.name == instance);
        match subject {
            Binding::Event => {
                let Some(source) = self.source.borrow().clone() else { return Ok(false) };
                if !graph_named(&source.instance_name) {
                    return Ok(false);
                }
                if type_.position.is_none() && type_.hops_raw.is_none() {
                    return Ok(true);
                }
                // An ADDRESS test is true when its pins are a subset of the
                // seed's own address, agreeing on every value; an axis the
                // seed never pinned is "can't tell".
                if let Some(hops) = &type_.hops_raw {
                    let Some(test) = event_address_of_hops(hops) else { return Ok(false) };
                    if let Some(seed) = &source.address {
                        if test.event != seed.event {
                            return Ok(false);
                        }
                        let pin = |key: &str| seed.narrowing.iter().find(|(k, _)| k == key).map(|(_, v)| v);
                        let unpinned: Vec<&str> = test.narrowing.iter().filter(|(k, _)| pin(k).is_none()).map(|(k, _)| k.as_str()).collect();
                        if !unpinned.is_empty() {
                            return Err(undiscriminated(name, &unpinned_axis(&unpinned)));
                        }
                        return Ok(test.narrowing.iter().all(|(k, v)| pin(k) == Some(v)));
                    }
                    let Some(keyed) = &source.position.record_type else { return Err(undiscriminated(name, UNDISCRIMINATED_EVENT)) };
                    return Ok(event_address_key(&test) == *keyed);
                }
                if source.address.as_ref().is_some_and(|seed| type_.position.as_deref() == Some(seed.event.as_str())) {
                    return Ok(true);
                }
                let Some(record_type) = &source.position.record_type else { return Err(undiscriminated(name, UNDISCRIMINATED_EVENT)) };
                Ok(type_.position.as_deref() == Some(record_type.as_str()))
            }
            Binding::Handle(handle) => {
                if type_.hops_raw.is_some() || !graph_named(&handle.graph.name) {
                    return Ok(false);
                }
                Ok(type_.position.as_ref().is_none_or(|p| *p == handle.target_type))
            }
            Binding::Landed(landed) => {
                // An address names an event narrowing; a landed record is never one.
                if type_.hops_raw.is_some() || !graph_named(&landed.read.instance_name) {
                    return Ok(false);
                }
                let Some(record_type) = crate::traverse::record_type(&landed.position()) else { return Err(undiscriminated(name, UNSTAMPED_LANDING)) };
                Ok(type_.position.as_ref().is_none_or(|p| *p == record_type))
            }
            _ => Ok(false),
        }
    }

    /// `evaluateDeclaredNodeTest`: does the subject carry everything the
    /// declaration declares? A subject that is no record is an ordinary
    /// false.
    async fn declared_node_test(&self, name: &str, subject: &Binding, declared: &ShapeBinding, scope: &Scope) -> Result<bool, Failure> {
        let supplied = match subject {
            Binding::Node(node) => Surface::Node(node.clone()),
            Binding::Extracted { emission, .. } => Surface::Emission(emission.clone()),
            // A record a system describes is compared by its record type's
            // schema, with the checker's own assignability (`check.compatible`).
            Binding::Event => {
                let source = self.source.borrow().clone();
                let instance = self.source_instance.borrow().clone();
                let Some(record_type) = source.as_ref().and_then(|s| s.position.record_type.clone()) else { return Err(undiscriminated(name, UNDISCRIMINATED_EVENT)) };
                return self.typed_record_fits(name, instance.as_ref().and_then(|i| i.schema.as_ref()), &record_type, declared).await;
            }
            Binding::Handle(handle) => return self.typed_record_fits(name, handle.graph.schema.as_ref(), &handle.target_type, declared).await,
            Binding::Landed(landed) => {
                let Some(record_type) = crate::traverse::record_type(&landed.position()) else { return Err(undiscriminated(name, UNSTAMPED_LANDING)) };
                // The graph the landing was yielded from (`graphSchemaOf`).
                let schema = match scope.resolve(&landed.read.instance_name) {
                    Some(Binding::Instance(instance)) => instance.schema.clone(),
                    _ => landed.read.schema.clone(),
                };
                return self.typed_record_fits(name, schema.as_ref(), &record_type, declared).await;
            }
            _ => return Ok(false),
        };
        let required = self.required_shape(declared)?;
        Ok(!self.misfits(&supplied, &required, declared, &[], scope).await?)
    }

    /// `surfaceMisfit` over a synthesised subject: a field the declaration
    /// requires and the subject lacks is a misfit; an edge the subject lacks
    /// is the empty set, and an edge it has is compared at its first
    /// landing. `path` is the declared edges walked from the declaration's
    /// root to `required`. A landing that is a system's record is compared by
    /// its record type's schema at that place in the declaration, by the
    /// checker (`check.compatible`); one whose kind or structure the run
    /// cannot see is the comparator's ordinary unknown, and fits
    /// (`subjectSurface` gives no surface below the root).
    async fn misfits(&self, supplied: &Surface, required: &Required, declaration: &ShapeBinding, path: &[String], scope: &Scope) -> Result<bool, Failure> {
        if required.fields.iter().any(|field| !supplied.has_property(field)) {
            return Ok(true);
        }
        for (name, child) in &required.children {
            let Some(landing) = supplied.edge(name) else { continue };
            let mut below = path.to_vec();
            below.push(name.clone());
            let inner = match landing {
                Some(Binding::Node(node)) => Surface::Node(node),
                Some(Binding::Extracted { emission, .. }) => Surface::Emission(emission),
                Some(record @ (Binding::Event | Binding::Landed(_) | Binding::Handle(_))) => {
                    if !self.nested_record_fits(&record, declaration, &below, scope).await? {
                        return Ok(true);
                    }
                    continue;
                }
                // Nothing landed, or no record: nothing to compare, which fits.
                _ => continue,
            };
            if Box::pin(self.misfits(&inner, child, declaration, &below, scope)).await? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// A system's record a synthesised node's edge holds, against the
    /// declaration's node at `path` (`subjectSurface` then `surfaceMisfit`
    /// across the edge): a record of no known type, or one no schema
    /// enumerates, fits.
    async fn nested_record_fits(&self, record: &Binding, declaration: &ShapeBinding, path: &[String], scope: &Scope) -> Result<bool, Failure> {
        let (schema, record_type) = match record {
            Binding::Event => {
                let source = self.source.borrow().clone();
                let instance = self.source_instance.borrow().clone();
                (instance.and_then(|i| i.schema.clone()), source.and_then(|s| s.position.record_type.clone()))
            }
            Binding::Handle(handle) => (handle.graph.schema.clone(), Some(handle.target_type.clone())),
            Binding::Landed(landed) => {
                let schema = match scope.resolve(&landed.read.instance_name) {
                    Some(Binding::Instance(instance)) => instance.schema.clone(),
                    _ => landed.read.schema.clone(),
                };
                (schema, crate::traverse::record_type(&landed.position()))
            }
            _ => return Ok(true),
        };
        let (Some(schema), Some(record_type)) = (schema, record_type) else { return Ok(true) };
        let answer = self.ask_compatible(&schema, &record_type, declaration, path).await?;
        if answer.get("undescribed").is_some() {
            return Ok(true);
        }
        compatible_fits(&answer)
    }

    /// `check.compatible` of the declaration, in the file that declares it.
    async fn ask_compatible(&self, schema: &movement_parser::catalog::types::InstanceSchema, record_type: &str, declaration: &ShapeBinding, path: &[String]) -> Result<serde_json::Value, Failure> {
        let schema = serde_json::to_value(schema).map_err(|e| Failure::engine("MOVENG_RUNTIME", e.to_string()))?;
        let file = match &declaration.declared.file {
            crate::program::DeclaringFile::Library(path) => Some(path.as_str()),
            crate::program::DeclaringFile::Root | crate::program::DeclaringFile::Parked(_) => None,
        };
        let name = declaration.declared.declaration.name.as_str();
        let request = crate::host::check::compatible(&self.input.source, self.version(), file, name, schema, record_type, path);
        Ok(self.ask(request).await?.unwrap_or(serde_json::Value::Null))
    }

    /// `positionSurface` then `surfaceMisfit`, asked of the checker: a
    /// schema that enumerates nothing at the record's type is "can't tell".
    async fn typed_record_fits(&self, name: &str, schema: Option<&movement_parser::catalog::types::InstanceSchema>, record_type: &str, shape: &ShapeBinding) -> Result<bool, Failure> {
        let undescribed = || undiscriminated(name, &format!("nothing describes the structure of a '{record_type}'"));
        let Some(schema) = schema else { return Err(undescribed()) };
        let answer = self.ask_compatible(schema, record_type, shape, &[]).await?;
        if answer.get("undescribed").is_some() {
            return Err(undescribed());
        }
        compatible_fits(&answer)
    }

    /// The declaration as the whole tree it stands for (`resolvedShape`):
    /// each `extends` folded in, the base's fields and nodes first, a node
    /// of its own replacing the base's of that name.
    fn required_shape(&self, shape: &ShapeBinding) -> Result<Required, Failure> {
        let chain = self.shape_chain(shape)?;
        let mut folded: Option<Required> = None;
        for link in chain.iter().rev() {
            let own = Required::of(&link.root);
            folded = Some(match folded {
                None => own,
                Some(base) => base.extended_by(own),
            });
        }
        Ok(folded.expect("a chain holds its declaration"))
    }
}

/// What a declared node requires: its fields by name and its nodes.
struct Required {
    fields: Vec<String>,
    children: Vec<(String, Required)>,
}

impl Required {
    fn of(node: &movement_parser::ast::ShapeNode) -> Required {
        Required {
            fields: node.fields.iter().map(|f| f.name.clone()).collect(),
            children: node.children.iter().map(|c| (c.name.clone(), Required::of(c))).collect(),
        }
    }

    fn extended_by(mut self, own: Required) -> Required {
        for field in own.fields {
            if !self.fields.contains(&field) {
                self.fields.push(field);
            }
        }
        for (name, child) in own.children {
            match self.children.iter_mut().find(|(n, _)| *n == name) {
                Some(slot) => slot.1 = child,
                None => self.children.push((name, child)),
            }
        }
        self
    }
}

/// A subject whose structure is its own entries (`synthesisedSurface`):
/// every entry name declared and untyped, one landing per edge.
enum Surface {
    Node(Rc<RefCell<Node>>),
    Emission(Rc<Emission>),
}

impl Surface {
    fn has_property(&self, name: &str) -> bool {
        match self {
            Surface::Node(node) => node.borrow().fields.get(name).is_some(),
            Surface::Emission(emission) => emission.fields.get(name).is_some(),
        }
    }

    /// The edge's first landing, when the subject has the edge at all.
    fn edge(&self, name: &str) -> Option<Option<Binding>> {
        match self {
            Surface::Node(node) => node.borrow().edges.iter().find(|(n, _)| n == name).map(|(_, edge)| edge.landings.first().cloned()),
            Surface::Emission(emission) => emission
                .children
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, children)| children.first().map(|child| Binding::Extracted { emission: child.clone(), root: false, id: crate::bindings::Identity::new() })),
        }
    }
}

/// A `check.compatible` answer's verdict.
fn compatible_fits(answer: &serde_json::Value) -> Result<bool, Failure> {
    answer.get("fits").and_then(serde_json::Value::as_bool).ok_or_else(|| Failure::engine("MOVENG_RUNTIME", format!("check.compatible answered {answer}")))
}

/// `/^[A-Za-z_][A-Za-z0-9_]*$/`.
fn bare_ident(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

const UNDISCRIMINATED_EVENT: &str = "the event arrived without a discriminated kind, so the trigger never said which one it was";
const UNSTAMPED_LANDING: &str = "the connected system returned it without a record type";

fn unpinned_axis(axes: &[&str]) -> String {
    let named: Vec<String> = axes.iter().map(|a| format!("'{a}'")).collect();
    format!("the event carries no {}, and this test asks about {}", named.join(" or "), if axes.len() == 1 { "it" } else { "them" })
}

/// `undiscriminatedIsTest`.
fn undiscriminated(name: &str, reason: &str) -> Failure {
    Failure::engine(
        "MOVENG_RUNTIME",
        format!(
            "can't tell what kind of record '{name}' is — {reason}. An 'IS' test needs a record whose kind is known, so this run stopped rather than pick a branch that might be wrong"
        ),
    )
}

/// `eventAddressOfHops`: a marker's one hop and the pins its WHERE states,
/// or none when it states no address.
fn event_address_of_hops(hops_raw: &str) -> Option<EventAddress> {
    let trimmed = crate::js::trim(hops_raw);
    if !trimmed.starts_with("-[") {
        return None;
    }
    let probe = format!("__movement_path_root__{trimmed}.`__movement_path_probe__`");
    let tree = movement_parser::expr::parse_expression(&probe).ok()?;
    let Expression::Traverse { steps, .. } = movement_parser::lowering::lower_expression(&tree, &probe).ok()? else { return None };
    let [TraversalStep::Edge(step)] = steps.as_slice() else { return None };
    let mut narrowing = Vec::new();
    if let Some(filter) = step.expression_filter.as_deref() {
        crate::filter::pure_leaf_reads(filter)?;
        if !collect_pins(filter, &mut narrowing) {
            return None;
        }
    }
    Some(EventAddress { event: step.edge_type_id.clone(), narrowing })
}

/// `collectPins`: a conjunction of `` `key` == "literal" ``, no key pinned
/// to two values.
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
        Expression::Property { .. } | Expression::EdgeProperty { .. } => Some(Side::Read(crate::filter::leaf_read_key(expr))),
        _ => None,
    }
}
