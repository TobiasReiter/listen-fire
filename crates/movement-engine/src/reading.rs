//! What an expression reads off the records a run holds: expression.ts's
//! `traverseFrom` and the reads beneath it (`readAdapterTraverse`,
//! `walkMetaSteps`, `readLandings`, `evaluateExists`, `readBindingField`,
//! `readBareName`), rooted at any binding — a record a value holds
//! included, which reads as the record it is.

use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use movement_parser::lowering::POSITION_SENTINEL;
use movement_parser::lowering::expression::{EdgeDirection, EdgeStep, Expression, TraversalStep};

use crate::bindings::{Binding, Callback, Handle, Identity, Landed, Scope, ShapePosition};
use crate::env::Trail;
use crate::eval::{Evaluated, Prov, field_terminal};
use crate::executor::join_all;
use crate::js::Js;
use crate::record;
use crate::run::{Failure, Run};

type Reads<'s, T> = Pin<Box<dyn Future<Output = Result<T, Failure>> + 's>>;

fn unsupported(construct: &str) -> Failure {
    Failure::unsupported(construct, "")
}

/// A `traverse` expression's parts.
fn parts(expr: &Expression) -> (&[TraversalStep], &Expression) {
    let Expression::Traverse { steps, expression, .. } = expr else { unreachable!("a rooted traversal") };
    (steps, expression)
}

/// An `EXISTS` terminal's hops before it, and its own expression.
type Terminal<'e> = (&'e [TraversalStep], Option<&'e Expression>);

/// `existsTerminalOf`: the traversal's `EXISTS` terminal; without
/// `allow_steps`, hops before one are refused.
fn exists_terminal<'e>(expr: &'e Expression, name: &str, allow_steps: bool) -> Result<Option<Terminal<'e>>, Failure> {
    let (steps, terminal) = parts(expr);
    let Expression::Exists { steps: hops, where_ } = terminal else { return Ok(None) };
    if !allow_steps && !steps.is_empty() {
        return Err(unsupported(&format!("EXISTS() after hops from '{name}'")));
    }
    Ok(Some((hops.as_slice(), where_.as_deref())))
}

/// `directFieldRead`: the field a read with no hops names.
fn direct_field<'e>(expr: &'e Expression, name: &str, what: &str) -> Result<&'e str, Failure> {
    let (steps, terminal) = parts(expr);
    if !steps.is_empty() {
        return Err(Failure::unsupported(&format!("traversing from {what} ('{name}')"), "source/handle traversal is E2 scope"));
    }
    let Some(field) = field_terminal(terminal) else {
        return Err(Failure::unsupported(&format!("this read shape on {what} ('{name}')"), "only direct field reads run in E1"));
    };
    if field == POSITION_SENTINEL {
        return Err(unsupported(&format!("aggregating {what} ('{name}') as a position")));
    }
    Ok(field)
}

/// `isOldEdge`: `-[:@old]->`, which the engine answers from a write handle
/// itself and never asks an adapter about (no system has the edge).
pub(crate) fn is_old_edge(step: &EdgeStep) -> bool {
    step.edge_type_id == OLD_EDGE
}

/// `-[:@old]->`'s name (movement-lang `OLD_EDGE`).
pub(crate) const OLD_EDGE: &str = "@old";

/// `startsWithOldEdge`.
pub(crate) fn starts_with_old_edge(steps: &[TraversalStep]) -> bool {
    matches!(steps.first(), Some(TraversalStep::Edge(step)) if is_old_edge(step))
}

/// `walkStartsWithOldEdge`: the walk's first hop is `-[:@old]->`, or, with
/// no hops of its own, a lifted `EXISTS`'s is.
fn walk_starts_with_old_edge(expr: &Expression) -> bool {
    let Expression::Traverse { steps, expression, .. } = expr else { return false };
    if !steps.is_empty() {
        return starts_with_old_edge(steps);
    }
    matches!(expression.as_ref(), Expression::Exists { steps, .. } if starts_with_old_edge(steps))
}

fn none() -> Prov {
    Prov::Built(Trail::default())
}

impl Run<'_> {
    /// `readBareName` (and `evalValueMember`, `member`) of a name bound to
    /// anything but a value: one record reads as itself, a block's returned
    /// records as their list; the rest is not a value.
    pub(crate) fn bare(&self, name: &str, binding: Binding, member: bool) -> Result<Evaluated, Failure> {
        let origins = |b: &Binding| -> Result<Prov, Failure> { Ok(Prov::Built(Trail { origins: self.entity_origins(b)?, direct: None })) };
        if member && record::is_position(&binding) && !matches!(binding, Binding::Positions(_)) {
            let prov = origins(&binding)?;
            return Ok(Evaluated { value: record::held(binding), prov });
        }
        if let Binding::Positions(landings) = &binding {
            let prov = origins(&binding)?;
            return Ok(Evaluated { value: Js::array(landings.iter().cloned().map(record::held).collect()), prov });
        }
        // The receipt read as a plain list: its slots, in order; a slot
        // holding ONE record reads as that record, as a list literal's
        // member does.
        if let Binding::Tuple(slots) = &binding {
            let prov = origins(&binding)?;
            let values = slots
                .iter()
                .map(|slot| match slot {
                    Binding::Value(value) => value.value.clone(),
                    slot if record::is_one_record(slot) => record::held(slot.clone()),
                    _ => Js::Null,
                })
                .collect();
            return Ok(Evaluated { value: Js::array(values), prov });
        }
        // The event is the record that fired the run, read bare as itself
        // (`coalesce(event, record)`), as any record a walk landed on is.
        if record::is_one_record(&binding) || matches!(binding, Binding::Event) {
            let prov = origins(&binding)?;
            return Ok(Evaluated { value: record::held(binding), prov });
        }
        // A function is a value, as a JavaScript function is:
        // a closure read bare is itself, (AST, scope), whoever holds it may
        // call it; a function declared with a name is a closure over the
        // file scope it was declared in — never the caller's — as a
        // collection op's named function already is.
        match &binding {
            Binding::Closure(_) => return Ok(Evaluated { value: record::held(binding), prov: none() }),
            Binding::Movement(declared) => return Ok(Evaluated { value: record::held(self.function_value(declared)?), prov: none() }),
            _ => {}
        }
        Err(unsupported(&format!("reading '{name}' ({}) as a bare value", record::describe(&binding))))
    }

    /// A movement read as a value (language version 5): its parameters and
    /// body as a closure's, over a snapshot of its file's scope.
    pub(crate) fn function_value(&self, declared: &crate::bindings::MovementRef) -> Result<Binding, Failure> {
        let thrown = |stop: crate::run::Stop| match stop {
            crate::run::Stop::Thrown(failure) => failure,
            _ => Failure::engine("MOVENG_RUNTIME", format!("'{}' is not a movement this program declares", declared.name)),
        };
        let (declaration, body_path) = self.declaration(declared).map_err(thrown)?;
        let file = self
            .scope_of_file(&declared.file)
            .ok_or_else(|| Failure::engine("MOVENG_RUNTIME", "no file scope for a movement read as a value".into()))?;
        let ast = movement_parser::ast::ClosureExpression { params: declaration.params, return_type: None, body: declaration.body, span: declaration.span };
        let path = body_path.strip_suffix("/body").unwrap_or(&body_path).to_string();
        Ok(Binding::Closure(Rc::new(crate::bindings::Closure {
            code: crate::flow::Code { ast: Rc::new(ast), path },
            captured: file.capture(),
            self_name: None,
            file_name: None,
            by_reference: false,
        })))
    }

    /// `bindingEntityOrigins`: the origins a record cites, read in a list
    /// of records (a dict taken for one reads its own keys for them).
    pub(crate) fn entity_origins(&self, landing: &Binding) -> Result<Vec<u32>, Failure> {
        Ok(match landing {
            Binding::Handle(handle) => match handle.record().get("origin") {
                origin if !origin.truthy() => Vec::new(),
                origin => vec![self.intern_origin(origin)],
            },
            Binding::Extracted { emission, .. } => emission.origin.into_iter().collect(),
            Binding::Node(node) => {
                let mut origins: Vec<u32> = Vec::new();
                for (_, trail) in &node.borrow().field_provenance {
                    for origin in &trail.origins {
                        if !origins.contains(origin) {
                            origins.push(*origin);
                        }
                    }
                }
                origins
            }
            Binding::Value(value) => value.trail.as_ref().map_or_else(Vec::new, |t| t.origins.clone()),
            Binding::Positions(landings) => {
                let mut origins = Vec::new();
                for landing in landings {
                    origins.extend(self.entity_origins(landing)?);
                }
                origins
            }
            Binding::Tuple(slots) => {
                let mut origins = Vec::new();
                for slot in slots.iter() {
                    origins.extend(self.entity_origins(slot)?);
                }
                origins
            }
            Binding::ShapePosition(position) => {
                // `Object.values(binding.fieldProvenance)`.
                let mut origins: Vec<u32> = Vec::new();
                if let Js::Object(provenance) = &position.field_provenance {
                    for (_, trail) in provenance.entries() {
                        for origin in self.trail_of_provenance(trail).origins {
                            if !origins.contains(&origin) {
                                origins.push(origin);
                            }
                        }
                    }
                }
                origins
            }
            Binding::Resource(resource) => vec![self.mint_origin(resource_origin(resource, None))],
            _ => Vec::new(),
        })
    }

    /// `traverseFrom`: a walk or a field read rooted at `binding`, named
    /// `name` for a message.
    pub(crate) fn read_from<'s>(&'s self, expr: &'s Expression, name: &'s str, binding: Binding, scope: &'s Rc<Scope>, span: &'s Js) -> Reads<'s, Evaluated> {
        Box::pin(async move {
            let (steps, _) = parts(expr);
            match binding {
                Binding::Event => {
                    let source = self.source.borrow().clone().expect("the event is seeded before the body runs");
                    let start = Rc::new(Landed::new(source.position.to_js(), None, source.read.clone()));
                    self.read_adapter(expr, name, "the event position", start, scope, span).await
                }
                Binding::Landed(landed) => self.read_adapter(expr, name, "a traversed source record", landed, scope, span).await,
                Binding::Instance(instance) => {
                    if steps.is_empty() && exists_terminal(expr, name, false)?.is_none() {
                        return Err(Failure::unsupported(
                            &format!("reading fields of '{name}' ({})", record::describe(&Binding::Instance(instance.clone()))),
                            &format!("traverse a collection — {name}-[x:…]->"),
                        ));
                    }
                    let read = self.instance_read(&instance).await?;
                    let start = Rc::new(Landed::new(crate::traverse::meta_position(&instance.adapter_slug), None, read));
                    self.read_adapter(expr, name, &format!("the '{name}' graph"), start, scope, span).await
                }
                Binding::Handle(handle) => {
                    // `-[:@old]->` is answered from the handle itself; past it,
                    // the walk goes on from the record it landed on, as any
                    // walk off a landing does.
                    if walk_starts_with_old_edge(expr) {
                        let exists = exists_terminal(expr, name, true)?;
                        let subject = vec![Binding::Handle(handle)];
                        if let Some((hops, where_)) = exists
                            && steps.is_empty()
                        {
                            let found = self.exists(hops, where_, subject, scope, span).await?;
                            return Ok(Evaluated { value: Js::Bool(found), prov: none() });
                        }
                        let reached = self.walk_meta(subject, steps, name, scope, span).await?;
                        if let Some((hops, where_)) = exists {
                            let found = self.exists(hops, where_, reached, scope, span).await?;
                            return Ok(Evaluated { value: Js::Bool(found), prov: none() });
                        }
                        return self.read_landings(expr, reached, name, "a write handle").await;
                    }
                    if !steps.is_empty() || exists_terminal(expr, name, true)?.is_some() {
                        let (start, read, _) = self.walk_start(name, &Binding::Handle(handle)).await?;
                        return self.read_adapter(expr, name, "a write handle", Rc::new(Landed::new(start, None, read)), scope, span).await;
                    }
                    let field = direct_field(expr, name, "a write handle")?;
                    self.binding_field(&Binding::Handle(handle), field).map_err(|e| Failure::of_eval(e, ""))
                }
                Binding::Extracted { emission, .. } => {
                    let emissions = self.walk_extract(&emission, steps, name, scope, span).await?;
                    let reached: Vec<Binding> =
                        emissions.iter().map(|e| Binding::Extracted { emission: e.clone(), root: false, id: Identity::new() }).collect();
                    if let Some((hops, where_)) = exists_terminal(expr, name, true)? {
                        let found = self.exists(hops, where_, reached, scope, span).await?;
                        return Ok(Evaluated { value: Js::Bool(found), prov: none() });
                    }
                    let (_, terminal) = parts(expr);
                    let Some(field) = field_terminal(terminal) else {
                        return Err(unsupported(&format!("this read shape on an extracted entity ('{name}')")));
                    };
                    if field == POSITION_SENTINEL {
                        // "The positions themselves": each entity's fields.
                        let mut origins = Vec::new();
                        for origin in emissions.iter().filter_map(|e| e.origin) {
                            origins.push(origin);
                        }
                        let value = Js::array(emissions.iter().map(|e| Js::object(crate::js::JsObject::clone_of(&e.fields))).collect());
                        return Ok(Evaluated { value, prov: Prov::Built(Trail { origins, direct: None }) });
                    }
                    let reads = emissions.iter().map(|e| crate::write::emission_field(e, field)).collect::<Result<Vec<_>, _>>().map_err(|e| Failure::of_eval(e, ""))?;
                    Ok(self.collapse(reads))
                }
                Binding::Node(node) => {
                    if !steps.is_empty() || exists_terminal(expr, name, true)?.is_some() {
                        let reached = self.walk_meta(vec![Binding::Node(node)], steps, name, scope, span).await?;
                        if let Some((hops, where_)) = exists_terminal(expr, name, true)? {
                            let found = self.exists(hops, where_, reached, scope, span).await?;
                            return Ok(Evaluated { value: Js::Bool(found), prov: none() });
                        }
                        return self.read_landings(expr, reached, name, "a synthesised node").await;
                    }
                    let field = direct_field(expr, name, "a synthesised node")?;
                    crate::node::node_field(&node.borrow(), field).map_err(|e| Failure::of_eval(e, ""))
                }
                // The read IS the walk; hops past it continue it
                // (`resolveDeferred(binding.walk, expr.steps)`).
                Binding::LazyWalk(walk) => {
                    let reached = self.deferred_landings(&walk, steps).await?;
                    if let Some((hops, where_)) = exists_terminal(expr, name, true)? {
                        let found = self.exists(hops, where_, reached, scope, span).await?;
                        return Ok(Evaluated { value: Js::Bool(found), prov: none() });
                    }
                    self.read_landings(expr, reached, name, "a deferred traversal").await
                }
                Binding::Positions(landings) => {
                    let reached = self.walk_meta(landings, steps, name, scope, span).await?;
                    if let Some((hops, where_)) = exists_terminal(expr, name, true)? {
                        let found = self.exists(hops, where_, reached, scope, span).await?;
                        return Ok(Evaluated { value: Js::Bool(found), prov: none() });
                    }
                    self.read_landings(expr, reached, name, "a block's returned records").await
                }
                // The value plane's own reads are the evaluator's.
                binding @ Binding::Value(_) => {
                    let at = scope.child();
                    at.declare(name, binding);
                    self.evaluate_in(expr, &at, Some(span.clone()), None).await.map_err(crate::write::failure_of)
                }
                Binding::Resource(resource) => {
                    let field = direct_field(expr, name, "a resource")?;
                    Ok(self.resource_field(&resource, field))
                }
                Binding::ShapePosition(position) => {
                    let field = direct_field(expr, name, "a shape position")?;
                    Ok(self.shape_position_field(&position, field))
                }
                // `cb-[k:Called]->`: the calls so far, read off the ledger,
                // as a block head over the callback reads them; hops past
                // them walk on over the records in hand.
                Binding::Callback(callback) if !steps.is_empty() => {
                    let Some((TraversalStep::Edge(step), rest)) = steps.split_first() else {
                        return Err(unsupported(&format!("'{}' hops from a callback ('{name}')", crate::traverse::step_type(&steps[0]))));
                    };
                    if step.edge_type_id != crate::awaits::CALLED {
                        return Err(Failure::unsupported(
                            &format!("'-[:{}]->' on a callback", step.edge_type_id),
                            &format!("a callback has one edge, '{}'", crate::awaits::CALLED),
                        ));
                    }
                    let filter = step.expression_filter.as_deref().map(|filter| (filter.clone(), step.alias.clone()));
                    let called = self.called_landings(&Binding::Callback(callback), filter.as_ref(), scope).await.map_err(crate::write::failure_of)?;
                    let reached = self.walk_meta(called, rest, name, scope, span).await?;
                    if let Some((hops, where_)) = exists_terminal(expr, name, true)? {
                        let found = self.exists(hops, where_, reached, scope, span).await?;
                        return Ok(Evaluated { value: Js::Bool(found), prov: none() });
                    }
                    self.read_landings(expr, reached, name, "a callback's calls").await
                }
                Binding::Callback(callback) => {
                    let field = direct_field(expr, name, "a callback")?;
                    Ok(Evaluated { value: callback_field(&callback, field), prov: none() })
                }
                other => Err(unsupported(&format!("reading '{name}' ({}) in an expression", record::describe(&other)))),
            }
        })
    }

    /// `readAdapterTraverse`: the hops walked through the record's graph,
    /// then an `EXISTS` over what they reached, the records themselves, or
    /// each one's field.
    async fn read_adapter(&self, expr: &Expression, name: &str, what: &str, start: Rc<Landed>, scope: &Rc<Scope>, span: &Js) -> Result<Evaluated, Failure> {
        let exists = exists_terminal(expr, name, true)?;
        let (steps, terminal) = parts(expr);
        // No hops: the start itself, the very record, whose stamped surface
        // every read of it shares.
        let landed = if steps.is_empty() { vec![start] } else { self.walk_adapter(&start.position(), &start.read, steps, name, scope, span).await? };
        if let Some((hops, where_)) = exists {
            let found = self.exists(hops, where_, landed.into_iter().map(Binding::Landed).collect(), scope, span).await?;
            return Ok(Evaluated { value: Js::Bool(found), prov: none() });
        }
        let Some(field) = field_terminal(terminal) else {
            return Err(unsupported(&format!("this read shape on {what} ('{name}')")));
        };
        if field == POSITION_SENTINEL {
            // A fan-out has no single origin to cite.
            return Ok(Evaluated { value: Js::array(landed.into_iter().map(|l| record::held(Binding::Landed(l))).collect()), prov: none() });
        }
        let mut results = Vec::with_capacity(landed.len());
        for record in &landed {
            results.push(self.landed_field(record, field).await?);
        }
        Ok(self.collapse(results))
    }

    /// `walkMetaSteps`: the hops over records in hand — a node's edges, an
    /// extraction's children, a list's members — and, from a record in a
    /// graph, the rest of the walk through that graph.
    pub(crate) fn walk_meta<'s>(&'s self, start: Vec<Binding>, steps: &'s [TraversalStep], name: &'s str, scope: &'s Rc<Scope>, span: &'s Js) -> Reads<'s, Vec<Binding>> {
        Box::pin(async move {
            let Some((step, rest)) = steps.split_first() else { return Ok(start) };
            let TraversalStep::Edge(step) = step else {
                return Err(unsupported(&format!("'{}' hops over a block meta-node ('{name}')", crate::traverse::step_type(step))));
            };
            let mut reached = Vec::new();
            for binding in start {
                match &binding {
                    // A lazy binding IS the walk: the whole remaining chain,
                    // this hop included, continues from it.
                    Binding::LazyWalk(walk) => {
                        reached.extend(self.deferred_landings(walk, steps).await?);
                        continue;
                    }
                    Binding::Landed(landed) => {
                        let walked = self.walk_adapter(&landed.position(), &landed.read, steps, name, scope, span).await?;
                        reached.extend(walked.into_iter().map(Binding::Landed));
                        continue;
                    }
                    // `-[:@old]->` lands on the record the handle holds as it
                    // stood before its write; no system has the edge, so it
                    // never reaches an adapter.
                    Binding::Handle(handle) if is_old_edge(step) => {
                        let mut kept = Vec::new();
                        for landed in Handle::old_landings(handle) {
                            if self.hop_keeps_binding(step, &landed, scope, span).await? {
                                kept.push(landed);
                            }
                        }
                        reached.extend(self.walk_meta(kept, rest, name, scope, span).await?);
                        continue;
                    }
                    Binding::Handle(_) => {
                        let (start, read, _) = self.walk_start(name, &binding).await?;
                        let walked = self.walk_adapter(&start, &read, steps, name, scope, span).await?;
                        reached.extend(walked.into_iter().map(Binding::Landed));
                        continue;
                    }
                    Binding::Value(value) => {
                        reached.extend(self.walk_meta(record::walk_starts(&value.value), steps, name, scope, span).await?);
                        continue;
                    }
                    Binding::Node(node) => {
                        let deferred = node.borrow().edges.iter().find(|(n, _)| *n == step.edge_type_id).and_then(|(_, e)| e.deferred.clone());
                        if let Some(walk) = deferred {
                            if step.expression_filter.is_some() {
                                return Err(Failure::unsupported(
                                    &format!("WHERE filters on a synthesised node's edges ('{name}')"),
                                    "narrow the entry's own traversal instead — the WHERE belongs on the hop the node's edge is built from",
                                ));
                            }
                            reached.extend(self.deferred_landings(&walk, rest).await?);
                            continue;
                        }
                        let landings = node.borrow().landings(&step.edge_type_id);
                        let kept = self.keep_in_memory_hop(landings, step, scope, span).await?;
                        reached.extend(self.walk_meta(kept, rest, name, scope, span).await?);
                        continue;
                    }
                    Binding::Extracted { emission, .. } => {
                        let children: Vec<Binding> = emission
                            .children_of(&step.edge_type_id)
                            .iter()
                            .map(|child| Binding::Extracted { emission: child.clone(), root: false, id: Identity::new() })
                            .collect();
                        let kept = self.keep_in_memory_hop(children, step, scope, span).await?;
                        reached.extend(self.walk_meta(kept, rest, name, scope, span).await?);
                        continue;
                    }
                    _ => {}
                }
                if step.expression_filter.is_some() {
                    return Err(unsupported(&format!("WHERE filters on block meta-node hops ('{name}')")));
                }
                match binding {
                    Binding::Positions(landings) => reached.extend(self.walk_meta(landings, steps, name, scope, span).await?),
                    other => {
                        return Err(unsupported(&format!(
                            "traversing '{}' from {} inside a meta-node read",
                            step.edge_type_id,
                            record::describe(&other)
                        )));
                    }
                }
            }
            Ok(reached)
        })
    }

    /// A deferred walk read bare: the list of what it lands on now.
    pub(crate) async fn deferred_records(&self, walk: &crate::bindings::DeferredWalk) -> Result<Evaluated, Failure> {
        let landed = self.deferred_landings(walk, &[]).await?;
        self.records_held(landed)
    }

    /// Records in hand as the list value holding them, citing each one.
    fn records_held(&self, landed: Vec<Binding>) -> Result<Evaluated, Failure> {
        let mut origins: Vec<u32> = Vec::new();
        for binding in &landed {
            origins.extend(self.entity_origins(binding)?);
        }
        let value = Js::array(
            landed
                .into_iter()
                .map(|b| match b {
                    Binding::Value(value) => value.value,
                    other => record::held(other),
                })
                .collect(),
        );
        Ok(Evaluated { value, prov: Prov::Built(Trail { origins, direct: None }) })
    }

    /// `runDeferredWalk(walk, extraSteps)`: the walk's landings, the hops
    /// past it walked inside it, in the scope it captured.
    async fn deferred_landings(&self, walk: &crate::bindings::DeferredWalk, steps: &[TraversalStep]) -> Result<Vec<Binding>, Failure> {
        Ok(self.run_deferred_past(walk, steps).await.map_err(crate::write::failure_of)?.into_iter().map(|(_, l)| l).collect())
    }

    /// `hopFilterKeeps` over a record in hand: the hop's WHERE, its alias
    /// naming the record, scoped at it.
    pub(crate) async fn hop_keeps_binding(&self, step: &EdgeStep, landed: &Binding, scope: &Rc<Scope>, span: &Js) -> Result<bool, Failure> {
        let Some(filter) = step.expression_filter.as_deref() else { return Ok(true) };
        let at = match &step.alias {
            Some(alias) => {
                let child = scope.child();
                child.declare(alias.clone(), landed.clone());
                child
            }
            None => scope.clone(),
        };
        self.decides(filter, &at, crate::traverse::scoped_at(landed), span).await
    }

    /// `keepInMemoryHop`: one hop over records in hand (an extracted
    /// entity's children, a node literal's landings) from one origin — the
    /// ones its WHERE keeps, and from 5 in its ORDER BY and cut to its LIMIT,
    /// as a hop over a source record is. Versions 1–4 never read an in-memory
    /// hop's ORDER BY or LIMIT, so they still don't.
    pub(crate) async fn keep_in_memory_hop(&self, landings: Vec<Binding>, step: &EdgeStep, scope: &Rc<Scope>, span: &Js) -> Result<Vec<Binding>, Failure> {
        let mut kept = Vec::new();
        for landed in landings {
            if self.hop_keeps_binding(step, &landed, scope, span).await? {
                kept.push(landed);
            }
        }
        self.ordered_bindings(kept, step, scope, span).await
    }

    /// `readLandings`: the records themselves (a value landing as its
    /// value), or each one's field, collapsed.
    async fn read_landings(&self, expr: &Expression, landed: Vec<Binding>, name: &str, what: &str) -> Result<Evaluated, Failure> {
        let (_, terminal) = parts(expr);
        let Some(field) = field_terminal(terminal) else {
            return Err(unsupported(&format!("this read shape on {what} ('{name}')")));
        };
        if field == POSITION_SENTINEL {
            return self.records_held(landed);
        }
        let mut results = Vec::with_capacity(landed.len());
        for binding in &landed {
            results.push(self.landing_field(binding, field, name).await?);
        }
        Ok(self.collapse(results))
    }

    /// `readBindingField`: one field of a record in hand (a value's own,
    /// a node's, an extraction's, a handle's), or of each of a block's
    /// returned records.
    pub(crate) fn read_binding_field(&self, binding: &Binding, field: &str, name: &str) -> Result<Evaluated, Failure> {
        match binding {
            Binding::Handle(_) | Binding::Node(_) | Binding::Extracted { .. } => self.binding_field(binding, field).map_err(|e| Failure::of_eval(e, "")),
            Binding::Value(value) => {
                let trail = value.trail.clone().unwrap_or_default();
                Ok(Evaluated { value: record::project(&value.value, field), prov: Prov::Built(Trail { origins: trail.origins, direct: None }) })
            }
            Binding::Positions(landings) => {
                let reads = landings.iter().map(|b| self.read_binding_field(b, field, name)).collect::<Result<Vec<_>, _>>()?;
                Ok(self.collapse(reads))
            }
            Binding::Resource(resource) => Ok(self.resource_field(resource, field)),
            Binding::ShapePosition(position) => Ok(self.shape_position_field(position, field)),
            Binding::Callback(callback) => Ok(Evaluated { value: callback_field(callback, field), prov: none() }),
            other => Err(unsupported(&format!("reading '{field}' off {} reached through '{name}'", record::describe(other)))),
        }
    }

    /// `evaluateExists`: the hops stepped from every subject, each kept by
    /// the hop's member gate and WHERE and bounded by its ORDER BY / LIMIT
    /// per origin; true when anything is reached and, with a WHERE, when
    /// one reached record holds it (the first that does ends the reading).
    pub(crate) fn exists<'s>(&'s self, steps: &'s [TraversalStep], where_: Option<&'s Expression>, subjects: Vec<Binding>, scope: &'s Rc<Scope>, span: &'s Js) -> Reads<'s, bool> {
        Box::pin(async move {
            let mut cursors = subjects;
            for step in steps {
                let TraversalStep::Edge(step) = step else {
                    return Err(unsupported(&format!("'{}' hops inside EXISTS()", crate::traverse::step_type(step))));
                };
                let mut next = Vec::new();
                for cursor in &cursors {
                    let gate = match cursor {
                        Binding::Landed(landed) => crate::traverse::member_gate(step, &landed.position(), &landed.read).map(|g| (g, landed.read.clone())),
                        _ => None,
                    };
                    let mut kept = Vec::new();
                    for landed in self.step_cursor(cursor, step, scope, span).await? {
                        if let (Some((gate, read)), Binding::Landed(l)) = (&gate, &landed)
                            && !gate.admits(read.schema.as_ref(), &l.position())
                        {
                            continue;
                        }
                        if self.hop_keeps_binding(step, &landed, scope, span).await? {
                            kept.push(landed);
                        }
                    }
                    next.extend(self.ordered_bindings(kept, step, scope, span).await?);
                }
                cursors = next;
                if cursors.is_empty() {
                    break;
                }
            }
            if cursors.is_empty() {
                return Ok(false);
            }
            let Some(where_) = where_ else { return Ok(true) };
            for cursor in &cursors {
                if self.decides(where_, scope, crate::traverse::scoped_at(cursor), span).await? {
                    return Ok(true);
                }
            }
            Ok(false)
        })
    }

    /// `stepExistsCursor`: one hop from a cursor, through the cursor's own
    /// read seam — a graph's (its fetch pushdown with it), an extraction's
    /// children, a node's edge, each of a list's records at once.
    fn step_cursor<'s>(&'s self, cursor: &'s Binding, step: &'s EdgeStep, scope: &'s Rc<Scope>, span: &'s Js) -> Reads<'s, Vec<Binding>> {
        Box::pin(async move {
            match cursor {
                Binding::Landed(landed) => {
                    let read = &landed.read;
                    if step.direction == EdgeDirection::Incoming && !read.incoming {
                        return Err(Failure::unsupported(
                            &format!("incoming EXISTS() hops ('{}')", step.edge_type_id),
                            &format!("source adapter '{}' cannot traverse incoming edges", read.adapter_type),
                        ));
                    }
                    let related = self.related(&landed.position(), step, read, scope, span).await?;
                    Ok(related.into_iter().map(Binding::Landed).collect())
                }
                Binding::Extracted { emission, .. } => Ok(emission
                    .children_of(&step.edge_type_id)
                    .iter()
                    .map(|child| Binding::Extracted { emission: child.clone(), root: false, id: Identity::new() })
                    .collect()),
                Binding::Node(node) => {
                    let deferred = node.borrow().edges.iter().find(|(n, _)| *n == step.edge_type_id).and_then(|(_, e)| e.deferred.clone());
                    match deferred {
                        Some(walk) => Ok(self.run_deferred(&walk).await.map_err(crate::write::failure_of)?.into_iter().map(|(_, l)| l).collect()),
                        None => Ok(node.borrow().landings(&step.edge_type_id)),
                    }
                }
                // `settledAll`: every record's hop at once, in order.
                Binding::Positions(landings) => {
                    let hops: Vec<_> = landings.iter().map(|landing| self.step_cursor(landing, step, scope, span)).collect();
                    let mut reached = Vec::new();
                    let mut failure = None;
                    for result in join_all(hops).await {
                        match result {
                            Ok(found) => reached.extend(found),
                            // The first record's failure, unless a later one met a limit.
                            Err(error) => {
                                if failure.as_ref().is_none_or(|held| matches!(error, Failure::Limit(_)) && !matches!(held, Failure::Limit(_))) {
                                    failure = Some(error);
                                }
                            }
                        }
                    }
                    match failure {
                        Some(error) => Err(error),
                        None => Ok(reached),
                    }
                }
                Binding::Handle(handle) if is_old_edge(step) => Ok(Handle::old_landings(handle)),
                Binding::Handle(_) => {
                    let (start, read, _) = self.walk_start("handle", cursor).await?;
                    let landed = Binding::Landed(Rc::new(Landed::new(start, None, read)));
                    self.step_cursor(&landed, step, scope, span).await
                }
                Binding::Value(value) => self.step_cursor(&Binding::Positions(record::walk_starts(&value.value)), step, scope, span).await,
                other => Err(unsupported(&format!("traversing '{}' from {} inside EXISTS()", step.edge_type_id, record::describe(other)))),
            }
        })
    }

    /// `applyHopOrderLimit` over records of any kind, each key read in its
    /// record's own scope (all at once, as `sortByOrderKey` reads them).
    async fn ordered_bindings(&self, kept: Vec<Binding>, step: &EdgeStep, scope: &Rc<Scope>, span: &Js) -> Result<Vec<Binding>, Failure> {
        let cardinality = step.cardinality.as_ref();
        let keys = match cardinality.and_then(|c| c.order_by.as_deref()) {
            Some(key) => {
                let reads: Vec<_> = kept.iter().map(|landed| self.binding_order_key(key, step, landed, scope, span)).collect();
                Some(join_all(reads).await.into_iter().collect::<Result<Vec<Js>, Failure>>()?)
            }
            None => None,
        };
        let plan = crate::order_limit::apply_hop_order_limit(kept.len(), cardinality, keys.as_deref());
        Ok(plan.into_iter().map(|i| kept[i].clone()).collect())
    }

    /// `hopOrderKeyReader` over one record of any kind.
    async fn binding_order_key(&self, key: &Expression, step: &EdgeStep, landed: &Binding, scope: &Rc<Scope>, span: &Js) -> Result<Js, Failure> {
        let at = match &step.alias {
            Some(alias) => {
                let child = scope.child();
                child.declare(alias.clone(), landed.clone());
                child
            }
            None => scope.clone(),
        };
        let evaluated = self.evaluate_scoped(key, &at, Some(span.clone()), Some(crate::traverse::scoped_at(landed))).await;
        Ok(evaluated.map_err(crate::write::failure_of)?.value)
    }

    /// `memberScope`: `expr` evaluated in the scope of the record `subject`
    /// holds, or of a map held as a value (a SORT key).
    pub(crate) async fn scoped_at_record(&self, expr: &Expression, subject: &Js, scope: &Rc<Scope>, span: Option<Js>) -> Result<Evaluated, Failure> {
        let record = record::binding_of(subject)
            .unwrap_or_else(|| Binding::Value(crate::env::ValueBinding { value: subject.clone(), trail: None, many: false }));
        self.evaluate_scoped(expr, scope, span, Some(crate::traverse::scoped_at(&record))).await.map_err(crate::write::failure_of)
    }
}

impl Run<'_> {
    /// The resource case: `resource.data?.[field] ?? null`, cited by the
    /// resource.
    pub(crate) fn resource_field(&self, resource: &Js, field: &str) -> Evaluated {
        let value = match record::get(resource, "data") {
            Ok(data) if !data.is_nullish() => record::get(&data, field).unwrap_or(Js::Undefined),
            _ => Js::Null,
        };
        let value = if value.is_nullish() { Js::Null } else { value };
        let id = self.mint_origin(resource_origin(resource, Some(field)));
        Evaluated { value, prov: Prov::Built(Trail { origins: vec![id], direct: Some(id) }) }
    }

    /// `readShapePositionField`: its `fields` and `fieldProvenance`.
    fn shape_position_field(&self, position: &ShapePosition, field: &str) -> Evaluated {
        let value = record::get(&position.fields, field).unwrap_or(Js::Undefined);
        let value = if value.is_nullish() { Js::Null } else { value };
        let provenance = record::get(&position.field_provenance, field).unwrap_or(Js::Undefined);
        Evaluated { value, prov: Prov::Built(self.trail_of_provenance(&provenance)) }
    }

    /// A provenance a record carries as data, as a trail: its origins and
    /// `direct`, each the very object, interned.
    fn trail_of_provenance(&self, provenance: &Js) -> Trail {
        let Js::Object(object) = provenance else { return Trail::default() };
        let origins = match object.get("origins") {
            Some(Js::Array(list)) => list.items().iter().map(|o| self.intern_origin(o.clone())).collect(),
            _ => Vec::new(),
        };
        let direct = match object.get("direct") {
            Some(origin) if !matches!(origin, Js::Undefined) => Some(self.intern_origin(origin.clone())),
            _ => None,
        };
        Trail { origins, direct }
    }
}

/// `resourceOrigin`: `{kind: 'resource', externalId?, name?, field?}`.
fn resource_origin(resource: &Js, field: Option<&str>) -> Js {
    let mut origin = vec![("kind", Js::str("resource"))];
    for key in ["externalId", "name"] {
        let value = record::get(resource, key).unwrap_or(Js::Undefined);
        if !matches!(value, Js::Undefined) {
            origin.push((key, value));
        }
    }
    if let Some(field) = field {
        origin.push(("field", Js::str(field)));
    }
    crate::env::object_of(origin)
}

/// `readCallbackField`.
fn callback_field(callback: &Callback, field: &str) -> Js {
    match field {
        "id" => callback.callback_id.clone(),
        "url" => callback.url.clone(),
        _ => Js::Null,
    }
}
