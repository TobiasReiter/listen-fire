//! Nodes the run builds: run.ts's `synthesiseNode` (`{ title: …, people:
//! [{…}] }`) and `buildGraph` (`graph { … }`) for what this engine holds —
//! value entries, nested literals, a reference entry holding a record the
//! run holds (the checker's `reference` stamp: an EDGE holding it, never a
//! field), a record spread copied by the checker's plan (the `copy` stamp)
//! and a map spread. A graph with a shape, a traversal entry, a declared
//! edge, or a copy plan that walks edges is not this engine's yet.

use std::cell::RefCell;
use std::rc::Rc;

use movement_parser::ast::{MapSpread, NodeEntry, NodeLiteral, ShapeNode};
use serde_json::Value as Json;

use crate::bindings::{Binding, DeferredWalk, Edge, LandingShape, Node, Scope, ShapeBinding};
use crate::env::Trail;
use crate::eval::{EvalError, Evaluated, Prov};
use crate::js::{Js, JsObject};
use crate::program::Stamp;
use crate::run::{Failure, Run, Stop};

type Built<'s> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Rc<RefCell<Node>>, Stop>> + 's>>;
type Iterations<'s> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<(Vec<(String, Binding)>, Binding)>, Stop>> + 's>>;

/// `readNodePositionField`: the field (`fields[field] ?? null`, through
/// the plain object's prototype), its own trail.
pub fn node_field(node: &Node, field: &str) -> Result<Evaluated, EvalError> {
    let value = crate::record::project_object(&node.fields, field);
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

    /// `setGraphEdge`: a shape child says what a landing a write makes on
    /// the edge later carries, as a declared edge does.
    fn set_edge(&mut self, name: &str, landings: Vec<Binding>, child: Option<&ShapeNode>) {
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
        self.put(name, Edge { landings, shape: child.map(declared_landing_shape), deferred: None });
    }

    /// `edges[name] = landed`: a name already there keeps its place.
    fn put_edge(&mut self, name: &str, landings: Vec<Binding>) {
        self.put(name, Edge::landed(landings));
    }

    pub(crate) fn put(&mut self, name: &str, edge: Edge) {
        match self.edges.iter_mut().find(|(e, _)| e == name) {
            Some(slot) => slot.1 = edge,
            None => self.edges.push((name.to_string(), edge)),
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
                return self.build_graph(literal, graph.shape.as_ref().map(|s| s.name.as_str()), scope, path).await;
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
                    // A declared edge starts empty and grows by a write or a
                    // `link`; a declared node also says what a landing a write
                    // creates here carries. The address spelling carries none.
                    NodeEntry::Declared { name, type_, .. } => {
                        let shape = match (&type_.hops_raw, scope.resolve(&type_.graph)) {
                            (None, Some(Binding::Shape(shape))) => Some(self.landing_shape_of_declared(&shape).map_err(Stop::Thrown)?),
                            _ => None,
                        };
                        node.put(name, Edge { landings: Vec::new(), shape, deferred: None });
                    }
                    NodeEntry::Traversal { name, head, lazy: false, mapping, .. } => {
                        let landings = self.walk_landings(head, mapping.as_ref(), scope, &format!("{path}/entries/{index}/mapping")).await?;
                        node.put_edge(name, landings);
                    }
                    // `lazy`: the walk is kept, and run at every read.
                    NodeEntry::Traversal { name, head, lazy: true, mapping, .. } => {
                        let walk = self.defer_walk(head, mapping.as_ref(), scope, &format!("{path}/entries/{index}"));
                        node.put(name, Edge { landings: Vec::new(), shape: None, deferred: Some(walk) });
                    }
                }
            }
            Ok(Rc::new(RefCell::new(node)))
        })
    }

    /// `declaredLandingShape` of the declaration as the whole tree it stands
    /// for (`resolvedShape`).
    pub(crate) fn landing_shape_of_declared(&self, shape: &ShapeBinding) -> Result<LandingShape, Failure> {
        Ok(declared_landing_shape(&self.resolved_shape(shape)?))
    }

    /// `deferWalk`: the walk as written and the scope it was written in.
    /// `deferWalk`: the walk kept, with the scope it is written in captured.
    /// `path` is the walk's own AST path (its `head` and `mapping` are under
    /// it).
    pub(crate) fn defer_walk(&self, head: &movement_parser::ast::PathHead, mapping: Option<&NodeLiteral>, scope: &Rc<Scope>, path: &str) -> Rc<DeferredWalk> {
        Rc::new(DeferredWalk {
            head: head.clone(),
            head_path: format!("{path}/head"),
            captured: scope.capture(),
            mapping: mapping.map(|m| (m.clone(), format!("{path}/mapping"))),
        })
    }

    /// `runDeferredWalk`: a kept walk run now, against the live source, in
    /// the scope it captured; each iteration's aliases and landing (a mapped
    /// walk's landings are its tail's nodes, and bind no alias).
    pub(crate) fn run_deferred<'s>(&'s self, walk: &'s DeferredWalk) -> Iterations<'s> {
        self.run_deferred_past(walk, &[])
    }

    /// `runDeferredWalk(walk, extraSteps)`: the hops past the walk continue
    /// it, in the scope it captured; past a mapping they are hops on the
    /// mapped nodes' arrow plane.
    pub(crate) fn run_deferred_past<'s>(&'s self, walk: &'s DeferredWalk, extra: &'s [movement_parser::lowering::expression::TraversalStep]) -> Iterations<'s> {
        Box::pin(async move {
            let Some((mapping, path)) = &walk.mapping else { return self.head_iterations_past(&walk.head, &walk.captured, extra).await };
            let iterations = self.head_iterations(&walk.head, &walk.captured).await?;
            let mut mapped = Vec::with_capacity(iterations.len());
            for (aliases, _) in iterations {
                let item = walk.captured.child();
                for (alias, binding) in aliases {
                    item.declare(alias, binding);
                }
                mapped.push((Vec::new(), Binding::Node(self.synthesise_node(mapping, &item, path).await?)));
            }
            if extra.is_empty() {
                return Ok(mapped);
            }
            let span = crate::env::js_of_serialized(&walk.head.span);
            self.walk_node_plane(mapped, extra, &walk.captured, &span).await
        })
    }

    /// `walkLandings`: a traversal entry's landings, walked now as a block
    /// head walks, each mapped through the tail literal when it has one.
    async fn walk_landings(&self, head: &movement_parser::ast::PathHead, mapping: Option<&NodeLiteral>, scope: &Rc<Scope>, path: &str) -> Result<Vec<Binding>, Stop> {
        let iterations = self.head_iterations(head, scope).await?;
        let Some(mapping) = mapping else { return Ok(iterations.into_iter().map(|(_, landing)| landing).collect()) };
        let mut mapped = Vec::with_capacity(iterations.len());
        for (aliases, _) in iterations {
            let item = scope.child();
            for (alias, binding) in aliases {
                item.declare(alias, binding);
            }
            mapped.push(Binding::Node(self.synthesise_node(mapping, &item, path).await?));
        }
        Ok(mapped)
    }

    /// `buildGraph`: a graph built as a value; with a shape, each child edge
    /// it declares made (empty where the literal wrote none) and the value
    /// checked against it where the keys came from a map nobody could type,
    /// and from version 3 always for presence.
    async fn build_graph(&self, literal: &NodeLiteral, shape_name: Option<&str>, scope: &Rc<Scope>, path: &str) -> Result<Rc<RefCell<Node>>, Stop> {
        let Some(name) = shape_name else { return self.build_graph_body(literal, scope, path, None).await };
        let Some(Binding::Shape(declared)) = scope.resolve(name) else {
            return Err(Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("'graph<{name}>' names no node declaration in scope"))));
        };
        let shape = self.resolved_shape(&declared).map_err(Stop::Thrown)?;
        let built = self.build_graph_body(literal, scope, path, Some(&shape)).await?;
        let spreads = spreads_anywhere(literal);
        if (spreads || self.version() >= 3)
            && let Some(misfit) = graph_value_misfit(&Binding::Node(built.clone()), &shape, "", !spreads)
        {
            return Err(Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("the value built for 'graph<{name}>' doesn't fit it: {misfit}"))));
        }
        Ok(built)
    }

    /// `buildGraphBody`: members in the order written, a later one
    /// overwriting an earlier, a spread's keys included.
    fn build_graph_body<'s>(&'s self, literal: &'s NodeLiteral, scope: &'s Rc<Scope>, path: &'s str, shape: Option<&'s ShapeNode>) -> Built<'s> {
        Box::pin(async move {
            let node = Rc::new(RefCell::new(Node::default()));
            let spreads: Vec<(usize, &MapSpread)> = literal.spreads.as_deref().unwrap_or_default().iter().enumerate().collect();
            for (index, entry) in literal.entries.iter().enumerate() {
                self.apply_spreads(&node, &spreads, index, scope, path, shape).await?;
                let entry_name = match entry {
                    NodeEntry::Value { name, .. } | NodeEntry::Nodes { name, .. } | NodeEntry::Declared { name, .. } | NodeEntry::Traversal { name, .. } => name,
                };
                let child = shape.and_then(|s| s.children.iter().find(|c| c.name == *entry_name));
                match entry {
                    NodeEntry::Value { name, value, .. } => {
                        let at = format!("{path}/entries/{index}");
                        if matches!(self.checked.stamp(&at), Some(Stamp::Reference)) {
                            let bound = self.bind_slot_binding(value, scope).await?;
                            let landings = self.referenced(name, bound)?;
                            node.borrow_mut().set_edge(name, landings, child);
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
                            landings.push(Binding::Node(self.build_graph_body(nested, scope, &at, child).await?));
                        }
                        node.borrow_mut().set_edge(name, landings, child);
                    }
                    // A walk in a graph lands where the literal stands, each
                    // landing mapped through its tail as a graph body.
                    NodeEntry::Traversal { name, head, mapping, .. } => {
                        let landings = match mapping {
                            None => self.walk_landings(head, None, scope, path).await?,
                            Some(mapping) => {
                                let at = format!("{path}/entries/{index}/mapping");
                                let mut built = Vec::new();
                                for (aliases, _) in self.head_iterations(head, scope).await? {
                                    let item = scope.child();
                                    for (alias, binding) in aliases {
                                        item.declare(alias, binding);
                                    }
                                    built.push(Binding::Node(self.build_graph_body(mapping, &item, &at, child).await?));
                                }
                                built
                            }
                        };
                        node.borrow_mut().set_edge(name, landings, child);
                    }
                    NodeEntry::Declared { name, .. } => {
                        return Err(Stop::Thrown(Failure::engine(
                            "MOVENG_RUNTIME",
                            format!("a declared edge ('{name}') inside a graph literal — the parser refuses one"),
                        )));
                    }
                }
            }
            self.apply_spreads(&node, &spreads, literal.entries.len(), scope, path, shape).await?;
            if let Some(shape) = shape {
                let mut n = node.borrow_mut();
                for child in &shape.children {
                    if !n.edges.iter().any(|(e, _)| *e == child.name) {
                        n.set_edge(&child.name, Vec::new(), Some(child));
                    }
                }
                // Declaration order, then whatever else a spread brought along.
                let declared: Vec<String> = shape.fields.iter().map(|f| f.name.clone()).collect();
                let rest: Vec<String> = n.field_order.iter().filter(|f| !declared.contains(f)).cloned().collect();
                n.field_order = declared.into_iter().chain(rest).collect();
            }
            Ok(node)
        })
    }

    async fn apply_spreads(&self, node: &Rc<RefCell<Node>>, spreads: &[(usize, &MapSpread)], at: usize, scope: &Rc<Scope>, path: &str, shape: Option<&ShapeNode>) -> Result<(), Stop> {
        for (j, spread) in spreads.iter().filter(|(_, s)| s.after == at) {
            match self.checked.stamp(&format!("{path}/spreads/{j}")) {
                Some(Stamp::Copy(plan)) => self.spread_record(node, spread, &plan, scope, shape).await?,
                _ => {
                    if let Some(map) = self.spread_map(spread, scope).await? {
                        spread_into_graph(&mut node.borrow_mut(), &map, shape)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// run.ts `shapeChain`: the declaration and each base its `extends`
    /// names, `shape` first, each base found where the one naming it was
    /// declared — a library's in its library, one declared in a body in that
    /// body's scope, any other in its file.
    pub(crate) fn shape_chain(&self, shape: &ShapeBinding) -> Result<Vec<movement_parser::ast::ShapeDeclaration>, Failure> {
        let mut chain: Vec<(movement_parser::ast::ShapeDeclaration, crate::program::DeclaringFile)> = Vec::new();
        let mut at = (shape.declared.clone(), shape.body_scope());
        loop {
            let (declared, body) = at;
            if chain.iter().any(|(c, file)| c.name == declared.declaration.name && *file == declared.file) {
                return Err(Failure::engine("MOVENG_RUNTIME", format!("'{}' extends itself — the checker should have caught this", shape.declared.declaration.name)));
            }
            let base = declared.declaration.extends.clone();
            chain.push((declared.declaration.clone(), declared.file.clone()));
            let Some(base) = base else { break };
            let next = match &body {
                Some(scope) => match scope.resolve(&base.name) {
                    Some(Binding::Shape(found)) => Some((found.declared.clone(), found.body_scope())),
                    _ => None,
                },
                None => self.checked.declarations.of_file(&declared.file).and_then(|d| d.shapes.get(&base.name)).map(|found| (found.clone(), None)),
            };
            at = next.ok_or_else(|| {
                Failure::engine(
                    "MOVENG_RUNTIME",
                    format!("'{}' extends '{}', which is not a node declaration in scope — the checker should have caught this", declared.declaration.name, base.name),
                )
            })?;
        }
        Ok(chain.into_iter().map(|(declaration, _)| declaration).collect())
    }

    /// The declaration as the whole tree it stands for (`resolvedShape` →
    /// `inheritDeclaration`): each base's fields and nodes ahead of its own.
    pub(crate) fn resolved_shape(&self, shape: &ShapeBinding) -> Result<ShapeNode, Failure> {
        let chain = self.shape_chain(shape)?;
        let mut links = chain.into_iter().rev();
        let mut resolved = links.next().expect("a chain holds its declaration").root;
        for link in links {
            let mut root = link.root;
            root.description = root.description.or(resolved.description);
            root.fields = resolved.fields.into_iter().chain(root.fields).collect();
            root.children = resolved.children.into_iter().chain(root.children).collect();
            resolved = root;
        }
        Ok(resolved)
    }

    /// `referencedRecords`: the records a reference entry holds, themselves —
    /// a value's each as itself, a block's returned records, the event as its
    /// position.
    fn referenced(&self, name: &str, bound: Binding) -> Result<Vec<Binding>, Stop> {
        match bound {
            Binding::Value(value) => {
                let held = match &value.value {
                    Js::Array(list) => list.items().clone(),
                    other => vec![other.clone()],
                };
                let mut records = Vec::new();
                for member in held.iter().filter(|member| !member.is_nullish()) {
                    let Some(record) = crate::record::binding_of(member) else {
                        return Err(Stop::Thrown(Failure::engine(
                            "MOVENG_RUNTIME",
                            format!("'{name}' holds records, and one of them is a {} — the program was not checked", member.type_of()),
                        )));
                    };
                    records.extend(self.referenced(name, record)?);
                }
                Ok(records)
            }
            Binding::Positions(landings) => Ok(landings),
            Binding::Event => Ok(vec![self.event_record()]),
            binding @ (Binding::Landed(_) | Binding::Handle(_) | Binding::Node(_) | Binding::Extracted { .. }) => Ok(vec![binding]),
            other => Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("'{name}' holds a record, and the value is {} — the program was not checked", crate::record::describe(&other)),
            ))),
        }
    }

    /// `eventRecord`: the trigger's own record, as the source position it is.
    fn event_record(&self) -> Binding {
        let source = self.source.borrow().clone().expect("the event is seeded before the body runs");
        Binding::Landed(Rc::new(crate::bindings::Landed::new(source.position.to_js(), None, source.read.clone())))
    }

    /// `spreadSourceBinding`: the binding a spread copies from, its name's,
    /// or for `...m.k` what `m` holds under each key in turn, bound as `x =
    /// m.k` binds it: a map's key (`held[key] ?? null`), or a record's field
    /// read off it (`readLandingField`); none where a step is neither. The
    /// event is a record like any other: its source position.
    async fn spread_source_binding(&self, spread: &MapSpread, scope: &Scope) -> Result<Option<Binding>, Stop> {
        let root = scope.resolve(spread.path.as_ref().map_or(&spread.source, |path| &path.root));
        let mut bound = match root {
            Some(Binding::Event) => Some(self.event_record()),
            other => other,
        };
        for key in spread.path.iter().flat_map(|path| &path.members) {
            match &bound {
                Some(
                    record @ (Binding::Landed(_)
                    | Binding::Handle(_)
                    | Binding::Node(_)
                    | Binding::ShapePosition(_)
                    | Binding::Extracted { .. }
                    | Binding::Resource(_)
                    | Binding::Positions(_)),
                ) => {
                    let read = self.landing_field(record, key, &spread.source).await.map_err(Stop::Thrown)?;
                    let trail = match read.prov {
                        Prov::Built(trail) => trail,
                        prov @ Prov::Binding(_) => self.trail_or_none(&prov, scope),
                    };
                    let value = if read.value.is_nullish() { Js::Null } else { read.value };
                    bound = Some(crate::record::bind_value(value, Some(trail), false));
                }
                Some(Binding::Value(held)) if crate::js::is_dict(&held.value) => {
                    let Js::Object(map) = &held.value else { return Ok(None) };
                    // `held[key] ?? null`.
                    let value = match crate::js::object_property(map, key) {
                        value if value.is_nullish() => Js::Null,
                        value => value,
                    };
                    bound = Some(crate::record::bind_value(value, held.trail.clone(), false));
                }
                _ => return Ok(None),
            }
        }
        Ok(bound)
    }

    /// `spreadRecordIntoGraph`: the record copied by the checker's plan, its
    /// fields and planned edges laid over what the node holds so far.
    async fn spread_record(&self, node: &Rc<RefCell<Node>>, spread: &MapSpread, plan: &Json, scope: &Scope, shape: Option<&ShapeNode>) -> Result<(), Stop> {
        // `spreadRecord`: the record held as a value or bound as one; none
        // at all copies nothing.
        let bound = match self.spread_source_binding(spread, scope).await? {
            None => return Ok(()),
            Some(Binding::Value(value)) if value.value.is_nullish() => return Ok(()),
            Some(Binding::Value(value)) => crate::record::binding_of(&value.value),
            other => other,
        };
        let record = match bound {
            Some(Binding::Positions(landings)) if landings.len() > 1 => {
                return Err(Stop::Thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!("'...{}' copies one record's fields, and '{}' holds {}", spread.source, spread.source, landings.len()),
                )));
            }
            Some(Binding::Positions(landings)) => match landings.into_iter().next() {
                Some(landing) => landing,
                None => return Ok(()),
            },
            Some(binding @ (Binding::Handle(_) | Binding::Node(_) | Binding::Landed(_) | Binding::Extracted { .. })) => binding,
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
        let copy = self.snapshot_record(&record, plan).await?;
        let copy = copy.borrow();
        let fields = plan_fields(plan);
        let mut n = node.borrow_mut();
        for field in &fields {
            n.delete_edge(field);
            n.note_field(field);
            match (copy.fields.get(field), copy.field_provenance.iter().find(|(f, _)| f == field)) {
                (Some(value), trail) => n.set_field(field, value.clone(), trail.map(|(_, t)| t.clone()).unwrap_or_default()),
                (None, _) => n.delete_field(field),
            }
        }
        for (name, edge) in &copy.edges {
            n.delete_field(name);
            n.field_order.retain(|f| f != name);
            let child = shape.and_then(|s| s.children.iter().find(|c| c.name == *name));
            n.set_edge(name, edge.landings.clone(), child);
        }
        Ok(())
    }

    /// `snapshotRecord`: a record copied by a plan — each planned field read
    /// off it now (an absent one copied absent), each planned edge walked one
    /// hop on the node plane and its landings copied by the edge's plan.
    fn snapshot_record<'s>(&'s self, record: &'s Binding, plan: &'s Json) -> Built<'s> {
        Box::pin(async move {
            let fields = plan_fields(plan);
            let mut copy = Node { field_order: fields.clone(), ..Node::default() };
            for field in &fields {
                let read = self.landing_field(record, field, field).await.map_err(Stop::Thrown)?;
                if read.value.is_nullish() {
                    continue;
                }
                let trail = match read.prov {
                    Prov::Built(trail) => trail,
                    Prov::Binding(_) => Trail::default(),
                };
                copy.fields.set(field.clone(), read.value);
                copy.field_provenance.push((field.clone(), trail));
            }
            for (edge, nested) in plan.get("edges").and_then(Json::as_object).into_iter().flatten() {
                let mut landings = Vec::new();
                for landing in self.node_plane_hop(record, edge).await? {
                    landings.push(Binding::Node(self.snapshot_record(&landing, nested).await?));
                }
                copy.put(edge, Edge::landed(landings));
            }
            Ok(Rc::new(RefCell::new(copy)))
        })
    }

    /// `walkNodePlane` of one plain hop from one record: a node's landings
    /// (a lazy entry's walk run now), a walked record's through its own
    /// graph; past any other landing the walk does not go.
    async fn node_plane_hop(&self, record: &Binding, edge: &str) -> Result<Vec<Binding>, Stop> {
        match record {
            Binding::Node(node) => {
                let deferred = node.borrow().edges.iter().find(|(n, _)| n == edge).and_then(|(_, e)| e.deferred.clone());
                match deferred {
                    Some(walk) => Ok(self.run_deferred(&walk).await?.into_iter().map(|(_, landing)| landing).collect()),
                    None => Ok(node.borrow().landings(edge)),
                }
            }
            Binding::Landed(landed) => {
                let step = plain_hop(edge);
                let span = Js::Undefined;
                let reached = self.walk(&landed.position(), &step, landed.read.clone(), &Scope::root(), &span).await.map_err(Stop::Thrown)?;
                Ok(reached.into_iter().map(Binding::Landed).collect())
            }
            other => Err(Stop::Thrown(Failure::unsupported(
                &format!("hopping past a '{edge}' landing that is {}", crate::write::describe_binding(other)),
                "traverse the edge into a block and walk on from the landing there",
            ))),
        }
    }

    /// `spreadMap`: the map a `...v` spreads, `None` when it is absent.
    async fn spread_map(&self, spread: &MapSpread, scope: &Scope) -> Result<Option<JsObject>, Stop> {
        let bound = self.spread_source_binding(spread, scope).await?;
        let value = match &bound {
            Some(Binding::Value(v)) => v.value.clone(),
            _ => Js::Undefined,
        };
        if matches!(bound, Some(Binding::Value(_))) && value.is_nullish() {
            return Ok(None);
        }
        match &value {
            Js::Object(object) => Ok(Some(JsObject::clone_of(object))),
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

/// `declaredLandingShape` of each nested node, by name: a name written twice
/// keeps its first place and its last tree.
fn landing_edges_of(children: &[&movement_parser::ast::ShapeNode]) -> Vec<(String, LandingShape)> {
    let mut edges: Vec<(String, LandingShape)> = Vec::new();
    for child in children {
        let nested: Vec<&movement_parser::ast::ShapeNode> = child.children.iter().collect();
        let shape = LandingShape { fields: child.fields.iter().map(|f| f.name.clone()).collect(), edges: landing_edges_of(&nested) };
        match edges.iter_mut().find(|(n, _)| *n == child.name) {
            Some(slot) => slot.1 = shape,
            None => edges.push((child.name.clone(), shape)),
        }
    }
    edges
}

/// `declaredLandingShape`.
fn declared_landing_shape(node: &ShapeNode) -> LandingShape {
    let children: Vec<&ShapeNode> = node.children.iter().collect();
    LandingShape { fields: node.fields.iter().map(|f| f.name.clone()).collect(), edges: landing_edges_of(&children) }
}

/// A copy plan's fields.
fn plan_fields(plan: &Json) -> Vec<String> {
    plan.get("fields").and_then(Json::as_array).map_or_else(Vec::new, |list| list.iter().filter_map(|f| f.as_str().map(String::from)).collect())
}

/// One outgoing hop down `edge`, as a plan's edge walks it: no alias, no
/// WHERE, no ORDER BY.
fn plain_hop(edge: &str) -> movement_parser::lowering::expression::EdgeStep {
    movement_parser::lowering::expression::EdgeStep {
        edge_type_id: edge.to_string(),
        direction: movement_parser::lowering::expression::EdgeDirection::Outgoing,
        alias: None,
        cardinality: None,
        filter: None,
        expression_filter: None,
    }
}

/// `spreadsAnywhere`: does any body of this graph literal take keys from a map?
fn spreads_anywhere(literal: &NodeLiteral) -> bool {
    literal.spreads.is_some()
        || literal.entries.iter().any(|entry| match entry {
            NodeEntry::Nodes { nodes, .. } => nodes.iter().any(spreads_anywhere),
            NodeEntry::Traversal { mapping: Some(mapping), .. } => spreads_anywhere(mapping),
            _ => false,
        })
}

/// `graphValueMisfit`: what a built graph lacks of its shape (every field
/// present unless nullable; unless only presence is asked, each primitive
/// its kind), recursively through its children's landings.
fn graph_value_misfit(binding: &Binding, shape: &ShapeNode, path: &str, presence_only: bool) -> Option<String> {
    let Binding::Node(node) = binding else { return None };
    let node = node.borrow();
    for field in &shape.fields {
        let value = node.fields.get(&field.name).cloned().unwrap_or(Js::Undefined);
        if value.is_nullish() {
            if field.nullable == Some(true) {
                continue;
            }
            return Some(format!("it has no {path}`{}`", field.name));
        }
        if presence_only {
            continue;
        }
        let want = match field.type_.as_str() {
            "text" => Some("string"),
            "number" => Some("number"),
            "boolean" => Some("boolean"),
            _ => None,
        };
        if let Some(want) = want
            && value.type_of() != want
        {
            return Some(format!("its {path}`{}` is a {}, not {}", field.name, value.type_of(), field.type_));
        }
    }
    for child in &shape.children {
        let landings = node.edges.iter().find(|(e, _)| *e == child.name).filter(|(_, e)| e.deferred.is_none()).map(|(_, e)| e.landings.clone()).unwrap_or_default();
        for landing in &landings {
            if let Some(misfit) = graph_value_misfit(landing, child, &format!("{path}{} → ", child.name), presence_only) {
                return Some(misfit);
            }
        }
    }
    None
}

/// `spreadIntoGraph`: a map's keys into a graph node — a nested map, or a
/// list of nothing but maps, is a child where the shape says so (and
/// everywhere without one); anything else a field, an absent one deleted.
fn spread_into_graph(node: &mut Node, map: &JsObject, shape: Option<&ShapeNode>) -> Result<(), Stop> {
    for (key, value) in map.entries() {
        // A graph built from a map holds values and nested maps; a record
        // under a key is neither (`holdsRecord`).
        if crate::record::holds_records(value) {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("'{key}' holds a record, and a map spread into a graph copies values and maps — a graph field cannot hold a record (the checker should have caught this)"),
            )));
        }
        let child = shape.and_then(|s| s.children.iter().find(|c| c.name == *key));
        let maps = as_map_list(value);
        let as_child = if shape.is_some() { child.is_some() } else { maps.is_some() };
        if as_child && maps.is_none() {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!(
                    "'{key}' is a child node, and the map spread into the graph holds {} there — it needs a map, or a list of maps",
                    match value {
                        Js::Array(_) => "a list that is not all maps".to_string(),
                        other => format!("a {}", other.type_of()),
                    }
                ),
            )));
        }
        match maps.filter(|_| as_child) {
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
                    spread_into_graph(&mut landing, &nested, child)?;
                    landings.push(Binding::Node(Rc::new(RefCell::new(landing))));
                }
                node.set_edge(key, landings, child);
            }
        }
    }
    Ok(())
}

/// `asMapList`: one map, or a list of nothing but maps.
fn as_map_list(value: &Js) -> Option<Vec<JsObject>> {
    let dict = |v: &Js| match v {
        // `isDictValue`: a dict shaped like a binding is a dict too.
        Js::Object(o) => Some(JsObject::clone_of(o)),
        _ => None,
    };
    match value {
        Js::Object(_) if crate::js::is_dict(value) => dict(value).map(|o| vec![o]),
        Js::Array(list) if !list.items().is_empty() && list.items().iter().all(crate::js::is_dict) => list.items().iter().map(dict).collect(),
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
        graph.borrow_mut().set_edge("me", vec![Binding::Node(graph.clone()), Binding::Node(other.clone())], None);
        graph.borrow_mut().set_edge("again", vec![Binding::Node(graph.clone()), Binding::Node(other.clone())], None);
        assert_eq!(graph.borrow().landed_on.as_deref(), Some("me"));
        assert_eq!(other.borrow().landed_on.as_deref(), Some("me"));
    }
}
