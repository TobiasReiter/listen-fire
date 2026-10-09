//! Nodes the run builds: run.ts's `synthesiseNode` (`{ title: …, people:
//! [{…}] }`) and `buildGraph` (`graph { … }`) for what this engine holds —
//! value entries, nested literals, a reference entry holding a record the
//! run holds (the checker's `reference` stamp: an EDGE holding it, never a
//! field), a record spread copied by the checker's plan (the `copy` stamp)
//! and a map spread. A graph with a shape, a traversal entry, a declared
//! edge, or a copy plan that walks edges is not this engine's yet.

use std::cell::RefCell;
use std::rc::Rc;

use movement_parser::ast::{MapSpread, NodeEntry, NodeLiteral};
use serde_json::Value as Json;

use crate::bindings::{Binding, Node, Scope};
use crate::env::Trail;
use crate::eval::{EvalError, Evaluated, Prov};
use crate::js::{Js, JsObject};
use crate::program::Stamp;
use crate::run::{Failure, Run, Stop};

type Built<'s> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Rc<RefCell<Node>>, Stop>> + 's>>;

/// `readNodePositionField`: the field, its own trail.
pub fn node_field(node: &Node, field: &str) -> Result<Evaluated, EvalError> {
    let value = match node.fields.get(field) {
        Some(value) if !value.is_nullish() => value.clone(),
        Some(_) => Js::Null,
        None if crate::stdlib::is_object_prototype_name(field) => {
            return Err(EvalError::Fallback(format!("`{field}` is Object.prototype's")));
        }
        None => Js::Null,
    };
    let trail = node.field_provenance.iter().find(|(f, _)| f == field).map(|(_, t)| t.clone()).unwrap_or_default();
    Ok(Evaluated { value, prov: Prov::Built(trail) })
}

impl Node {
    fn set_field(&mut self, name: &str, value: Js, trail: Trail) {
        self.fields.set(name.to_string(), value);
        match self.field_provenance.iter_mut().find(|(f, _)| f == name) {
            Some(slot) => slot.1 = trail,
            None => self.field_provenance.push((name.to_string(), trail)),
        }
    }

    fn delete_field(&mut self, name: &str) {
        self.fields = without(&self.fields, name);
        self.field_provenance.retain(|(f, _)| f != name);
    }

    fn delete_edge(&mut self, name: &str) {
        self.edges.retain(|(e, _)| e != name);
    }

    /// `noteGraphField`.
    fn note_field(&mut self, name: &str) {
        if !self.field_order.iter().any(|f| f == name) {
            self.field_order.push(name.to_string());
        }
    }

    /// `setGraphEdge` (no shape).
    fn set_edge(&mut self, name: &str, landings: Vec<Binding>) {
        self.delete_field(name);
        self.field_order.retain(|f| f != name);
        // A node the graph builds on its edge has landed there; first edge wins.
        for landing in &landings {
            if let Binding::Node(node) = landing {
                // A landing that is this node itself is the one borrowed now.
                if std::ptr::eq(node.as_ptr().cast_const(), &*self) {
                    self.landed_on.get_or_insert_with(|| name.to_string());
                } else {
                    node.borrow_mut().landed_on.get_or_insert_with(|| name.to_string());
                }
            }
        }
        self.put_edge(name, landings);
    }

    /// `edges[name] = landed`: a name already there keeps its place.
    fn put_edge(&mut self, name: &str, landings: Vec<Binding>) {
        match self.edges.iter_mut().find(|(e, _)| e == name) {
            Some(slot) => slot.1 = landings,
            None => self.edges.push((name.to_string(), landings)),
        }
    }
}

/// `delete object[key]`.
fn without(object: &JsObject, key: &str) -> JsObject {
    let mut kept = JsObject::new();
    for (k, v) in object.entries() {
        if k != key {
            kept.set(k.clone(), v.clone());
        }
    }
    kept
}

impl Run<'_> {
    /// `synthesiseNode`; `path` is the literal's AST path.
    pub(crate) fn synthesise_node<'s>(&'s self, literal: &'s NodeLiteral, scope: &'s Rc<Scope>, path: &'s str) -> Built<'s> {
        Box::pin(async move {
            if let Some(graph) = &literal.graph {
                if graph.shape.is_some() {
                    return Err(Stop::Thrown(Failure::unsupported("a graph with a shape", "the Rust engine builds graphs without one")));
                }
                return self.build_graph_body(literal, scope, path).await;
            }
            let mut node = Node::default();
            for (index, entry) in literal.entries.iter().enumerate() {
                match entry {
                    NodeEntry::Value { name, value, .. } => {
                        node.field_order.push(name.clone());
                        let evaluated = self.evaluate_slot(value, scope).await?;
                        if matches!(evaluated.value, Js::Undefined) {
                            continue;
                        }
                        let trail = self.trail_or_none(&evaluated.prov, scope);
                        node.set_field(name, evaluated.value, trail);
                    }
                    NodeEntry::Nodes { name, nodes, .. } => {
                        let mut landings = Vec::new();
                        for (k, nested) in nodes.iter().enumerate() {
                            let at = format!("{path}/entries/{index}/nodes/{k}");
                            landings.push(Binding::Node(self.synthesise_node(nested, scope, &at).await?));
                        }
                        node.put_edge(name, landings);
                    }
                    NodeEntry::Declared { .. } | NodeEntry::Traversal { .. } => {
                        return Err(Stop::Thrown(Failure::unsupported("this node entry", "the Rust engine builds value entries and nested nodes")));
                    }
                }
            }
            Ok(Rc::new(RefCell::new(node)))
        })
    }

    /// `buildGraphBody` (no shape): members in the order written, a later
    /// one overwriting an earlier, a spread's keys included.
    fn build_graph_body<'s>(&'s self, literal: &'s NodeLiteral, scope: &'s Rc<Scope>, path: &'s str) -> Built<'s> {
        Box::pin(async move {
            let node = Rc::new(RefCell::new(Node::default()));
            let spreads: Vec<(usize, &MapSpread)> = literal.spreads.as_deref().unwrap_or_default().iter().enumerate().collect();
            for (index, entry) in literal.entries.iter().enumerate() {
                self.apply_spreads(&node, &spreads, index, scope, path).await?;
                match entry {
                    NodeEntry::Value { name, value, .. } => {
                        let at = format!("{path}/entries/{index}");
                        if matches!(self.checked.root.stamps.get(&at), Some(Stamp::Reference)) {
                            let landings = self.referenced_records(name, &value.raw, scope)?;
                            node.borrow_mut().set_edge(name, landings);
                            continue;
                        }
                        let evaluated = self.evaluate_slot(value, scope).await?;
                        let trail = self.trail_or_none(&evaluated.prov, scope);
                        let mut n = node.borrow_mut();
                        n.delete_edge(name);
                        n.note_field(name);
                        if matches!(evaluated.value, Js::Undefined) {
                            n.delete_field(name);
                            continue;
                        }
                        n.set_field(name, evaluated.value, trail);
                    }
                    NodeEntry::Nodes { name, nodes, .. } => {
                        let mut landings = Vec::new();
                        for (k, nested) in nodes.iter().enumerate() {
                            let at = format!("{path}/entries/{index}/nodes/{k}");
                            landings.push(Binding::Node(self.build_graph_body(nested, scope, &at).await?));
                        }
                        node.borrow_mut().set_edge(name, landings);
                    }
                    NodeEntry::Traversal { .. } => {
                        return Err(Stop::Thrown(Failure::unsupported("a traversal entry", "the Rust engine builds value entries and nested nodes")));
                    }
                    NodeEntry::Declared { name, .. } => {
                        return Err(Stop::Thrown(Failure::engine(
                            "MOVENG_RUNTIME",
                            format!("a declared edge ('{name}') inside a graph literal — the parser refuses one"),
                        )));
                    }
                }
            }
            self.apply_spreads(&node, &spreads, literal.entries.len(), scope, path).await?;
            Ok(node)
        })
    }

    async fn apply_spreads(&self, node: &Rc<RefCell<Node>>, spreads: &[(usize, &MapSpread)], at: usize, scope: &Rc<Scope>, path: &str) -> Result<(), Stop> {
        for (j, spread) in spreads.iter().filter(|(_, s)| s.after == at) {
            match self.checked.root.stamps.get(&format!("{path}/spreads/{j}")) {
                Some(Stamp::Copy(plan)) => self.spread_record(node, spread, plan, scope)?,
                _ => {
                    if let Some(map) = self.spread_map(spread, scope)? {
                        spread_into_graph(&mut node.borrow_mut(), &map)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// `referencedRecords`: the records a reference entry holds, themselves.
    fn referenced_records(&self, name: &str, raw: &str, scope: &Scope) -> Result<Vec<Binding>, Stop> {
        let bare = crate::js::trim(raw);
        match scope.resolve(bare) {
            Some(binding @ (Binding::Handle(_) | Binding::Node(_))) => Ok(vec![binding]),
            Some(Binding::Value(value)) => {
                let held = match &value.value {
                    Js::Array(list) => list.items.clone(),
                    other => vec![other.clone()],
                };
                match held.iter().find(|member| !member.is_nullish()) {
                    None => Ok(Vec::new()),
                    Some(member) => Err(Stop::Thrown(Failure::engine(
                        "MOVENG_RUNTIME",
                        format!("'{name}' holds records, and one of them is a {} — the program was not checked", member.type_of()),
                    ))),
                }
            }
            _ => Err(Stop::Thrown(Failure::unsupported("this reference entry", "the Rust engine holds the run's own records"))),
        }
    }

    /// `spreadRecordIntoGraph`: the record copied by the checker's plan.
    fn spread_record(&self, node: &Rc<RefCell<Node>>, spread: &MapSpread, plan: &Json, scope: &Scope) -> Result<(), Stop> {
        let record = match scope.resolve(&spread.source) {
            Some(Binding::Value(value)) if value.value.is_nullish() => return Ok(()),
            Some(binding @ (Binding::Handle(_) | Binding::Node(_))) => binding,
            _ => {
                return Err(Stop::Thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!(
                        "'...{}' copies a record's fields, and '{}' holds no record — the program was not checked",
                        spread.source, spread.source
                    ),
                )));
            }
        };
        let fields: Vec<String> = plan.get("fields").and_then(Json::as_array).map_or_else(Vec::new, |list| {
            list.iter().filter_map(|f| f.as_str().map(String::from)).collect()
        });
        if plan.get("edges").and_then(Json::as_object).is_some_and(|edges| !edges.is_empty()) {
            return Err(Stop::Thrown(Failure::unsupported("copying a record's edges into a graph", "the Rust engine copies fields")));
        }
        // `snapshotRecord`: each planned field read off the record now, an
        // absent one copied absent.
        let mut copied: Vec<(String, Js, Trail)> = Vec::new();
        for field in &fields {
            let read = match &record {
                Binding::Node(n) => node_field(&n.borrow(), field),
                _ => self.record_field(&spread.source, field, scope),
            }
            .map_err(|e| match e {
                EvalError::Thrown { class, message } => Stop::Thrown(Failure::Engine { class, message }),
                other => Stop::Thrown(Failure::unsupported(&format!("this reading ({other:?})"), "the Rust engine does not reproduce it")),
            })?;
            if read.value.is_nullish() {
                continue;
            }
            let trail = match read.prov {
                Prov::Built(trail) => trail,
                Prov::Binding(_) => Trail::default(),
            };
            copied.push((field.clone(), read.value, trail));
        }
        let mut n = node.borrow_mut();
        for field in &fields {
            n.delete_edge(field);
            n.note_field(field);
            match copied.iter().find(|(f, _, _)| f == field) {
                Some((_, value, trail)) => n.set_field(field, value.clone(), trail.clone()),
                None => n.delete_field(field),
            }
        }
        Ok(())
    }

    /// `spreadMap`: the map a `...v` spreads, `None` when it is absent.
    fn spread_map(&self, spread: &MapSpread, scope: &Scope) -> Result<Option<JsObject>, Stop> {
        let bound = scope.resolve(&spread.source);
        let value = match &bound {
            Some(Binding::Value(v)) => v.value.clone(),
            _ => Js::Undefined,
        };
        if matches!(bound, Some(Binding::Value(_))) && value.is_nullish() {
            return Ok(None);
        }
        match &value {
            Js::Object(object) if !crate::stdlib::is_binding_shaped(&value) => Ok(Some(JsObject::clone_of(object))),
            _ => Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!(
                    "'...{}' spreads a map into a graph, and '{}' holds {}",
                    spread.source,
                    spread.source,
                    match &value {
                        Js::Undefined => "no value".to_string(),
                        Js::Array(_) => "a list".to_string(),
                        other => format!("a {}", other.type_of()),
                    }
                ),
            ))),
        }
    }

    /// A bound value's trail, `?? NO_PROVENANCE`.
    pub(crate) fn trail_or_none(&self, prov: &Prov, scope: &Scope) -> Trail {
        match prov {
            Prov::Binding(name) => crate::eval::Names::value(scope, name).and_then(|b| b.trail).unwrap_or_default(),
            Prov::Built(trail) => trail.clone(),
        }
    }
}

/// `spreadIntoGraph` (no shape): a nested map, or a list of nothing but
/// maps, is child nodes; anything else a field, an absent one deleted.
fn spread_into_graph(node: &mut Node, map: &JsObject) -> Result<(), Stop> {
    for (key, value) in map.entries() {
        match as_map_list(value) {
            None => {
                node.delete_edge(key);
                node.note_field(key);
                if value.is_nullish() {
                    node.delete_field(key);
                    continue;
                }
                node.set_field(key, value.clone(), Trail::default());
            }
            Some(maps) => {
                node.delete_field(key);
                node.field_order.retain(|f| f != key);
                let mut landings = Vec::new();
                for nested in maps {
                    let mut landing = Node::default();
                    spread_into_graph(&mut landing, &nested)?;
                    landings.push(Binding::Node(Rc::new(RefCell::new(landing))));
                }
                node.set_edge(key, landings);
            }
        }
    }
    Ok(())
}

/// `asMapList`: one map, or a list of nothing but maps.
fn as_map_list(value: &Js) -> Option<Vec<JsObject>> {
    let dict = |v: &Js| match v {
        Js::Object(o) if !crate::stdlib::is_binding_shaped(v) => Some(JsObject::clone_of(o)),
        _ => None,
    };
    match value {
        Js::Object(_) => dict(value).map(|o| vec![o]),
        Js::Array(list) if !list.items.is_empty() => list.items.iter().map(dict).collect(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_node_landed_on_an_edge_is_marked_by_the_first_edge_itself_included() {
        let graph = Rc::new(RefCell::new(Node::default()));
        let other = Rc::new(RefCell::new(Node::default()));
        graph.borrow_mut().set_edge("me", vec![Binding::Node(graph.clone()), Binding::Node(other.clone())]);
        graph.borrow_mut().set_edge("again", vec![Binding::Node(graph.clone()), Binding::Node(other.clone())]);
        assert_eq!(graph.borrow().landed_on.as_deref(), Some("me"));
        assert_eq!(other.borrow().landed_on.as_deref(), Some("me"));
    }
}
