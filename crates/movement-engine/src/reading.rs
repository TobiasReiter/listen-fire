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

use crate::bindings::{Binding, Identity, Landed, Scope};
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

/// `existsTerminalOf`: the traversal's `EXISTS` terminal; without
/// `allow_steps`, hops before one are refused.
fn exists_terminal<'e>(expr: &'e Expression, name: &str, allow_steps: bool) -> Result<Option<(&'e [TraversalStep], Option<&'e Expression>)>, Failure> {
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
        // A dict the TypeScript takes for a value binding reads as the value
        // it holds.
        if let Binding::Shaped(dict) = &binding
            && record::kind_of(&binding) == "value"
        {
            let Binding::Value(value) = self.shaped_value(&Js::Object(dict.clone())).map_err(|e| Failure::of_eval(e, ""))? else {
                unreachable!("a shaped value binding reads as a value")
            };
            return Ok(Evaluated { value: value.value, prov: Prov::Built(value.trail.unwrap_or_default()) });
        }
        if record::is_one_record(&binding) {
            let prov = origins(&binding)?;
            return Ok(Evaluated { value: record::held(binding), prov });
        }
        if let Binding::Shaped(dict) = &binding
            && matches!(record::kind_of(&binding).as_str(), "positions" | "tuple")
        {
            return self.bare_shaped_list(&Js::Object(dict.clone()), &record::kind_of(&binding));
        }
        Err(unsupported(&format!("reading '{name}' ({}) as a bare value", record::describe(&binding))))
    }

    /// `readBareName` of a `positions` dict (its `landings`, as they are) or
    /// a `tuple` dict (its `slots`, each a value's value or null): the list
    /// mapped as the TypeScript maps it, its members' origins with it.
    fn bare_shaped_list(&self, this: &Js, kind: &str) -> Result<Evaluated, Failure> {
        let eval = |e| Failure::of_eval(e, "");
        let (key, method) = if kind == "positions" { ("landings", "flatMap") } else { ("slots", "map") };
        let list = record::get(this, key).map_err(eval)?;
        let Js::Array(items) = &list else {
            return Err(eval(if list.is_nullish() {
                record::type_error(&format!("Cannot read properties of {} (reading '{method}')", list.to_js_string()))
            } else {
                record::type_error(&format!("binding.{key}.{method} is not a function"))
            }));
        };
        let members = items.items.iter().map(raw_cursor).collect::<Result<Vec<_>, _>>().map_err(eval)?;
        let value = if kind == "positions" {
            list.clone()
        } else {
            let mut slots = Vec::with_capacity(members.len());
            for member in &members {
                slots.push(match member {
                    Binding::Shaped(dict) if record::kind_of(member) == "value" => record::get(&Js::Object(dict.clone()), "value").map_err(eval)?,
                    _ => Js::Null,
                });
            }
            Js::array(slots)
        };
        let mut origins = Vec::new();
        for member in &members {
            origins.extend(self.entity_origins(member)?);
        }
        Ok(Evaluated { value, prov: Prov::Built(Trail { origins, direct: None }) })
    }

    /// `bindingEntityOrigins`: the origins a record cites, read in a list
    /// of records (a dict taken for one reads its own keys for them).
    pub(crate) fn entity_origins(&self, landing: &Binding) -> Result<Vec<u32>, Failure> {
        let eval = |e| Failure::of_eval(e, "");
        Ok(match landing {
            Binding::Handle(handle) => match handle.record.get("origin") {
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
            Binding::Shaped(dict) => {
                let this = Js::Object(dict.clone());
                let origin_of = |holder: &Js| -> Result<Vec<u32>, Failure> {
                    let origin = record::get(holder, "origin").map_err(eval)?;
                    Ok(if origin.truthy() { vec![self.intern_origin(origin)] } else { Vec::new() })
                };
                match record::kind_of(landing).as_str() {
                    "handle" => origin_of(&record::get(&this, "handle").map_err(eval)?)?,
                    "extractPosition" | "extractRoot" => origin_of(&record::get(&this, "emission").map_err(eval)?)?,
                    "value" => {
                        let Binding::Value(value) = self.shaped_value(&this).map_err(eval)? else { unreachable!("a shaped value binding reads as a value") };
                        value.trail.map_or_else(Vec::new, |t| t.origins)
                    }
                    "shapePosition" | "nodePosition" => {
                        // `Object.values(…)`: nothing throws; any other value
                        // holds no provenance.
                        let provenance = record::get(&this, "fieldProvenance").map_err(eval)?;
                        if provenance.is_nullish() {
                            return Err(Failure::of_eval(record::type_error("Cannot convert undefined or null to object"), ""));
                        }
                        let Js::Object(provenance) = provenance else { return Ok(Vec::new()) };
                        let mut origins: Vec<u32> = Vec::new();
                        for (_, trail) in provenance.entries() {
                            for origin in self.trail_of_provenance(trail).origins {
                                if !origins.contains(&origin) {
                                    origins.push(origin);
                                }
                            }
                        }
                        origins
                    }
                    "resource" => {
                        let resource = record::get(&this, "resource").map_err(eval)?;
                        let mut origin = vec![("kind", Js::str("resource"))];
                        let external_id = record::get(&resource, "externalId").map_err(eval)?;
                        if !matches!(external_id, Js::Undefined) {
                            origin.push(("externalId", external_id));
                        }
                        let name = record::get(&resource, "name").map_err(eval)?;
                        if !matches!(name, Js::Undefined) {
                            origin.push(("name", name));
                        }
                        vec![self.mint_origin(crate::env::object_of(origin))]
                    }
                    // `binding.landings.flatMap(bindingEntityOrigins)`.
                    kind @ ("positions" | "tuple") => {
                        let key = if kind == "positions" { "landings" } else { "slots" };
                        let held = record::get(&this, key).map_err(eval)?;
                        let Js::Array(list) = &held else {
                            if held.is_nullish() {
                                return Err(Failure::of_eval(record::type_error(&format!("Cannot read properties of {} (reading 'flatMap')", held.to_js_string())), ""));
                            }
                            return Err(Failure::of_eval(record::type_error(&format!("binding.{key}.flatMap is not a function")), ""));
                        };
                        let mut origins = Vec::new();
                        for member in &list.items {
                            if member.is_nullish() {
                                return Err(Failure::of_eval(record::type_error(&format!("Cannot read properties of {} (reading 'kind')", member.to_js_string())), ""));
                            }
                            if let Some(binding) = record::binding_of(member) {
                                origins.extend(self.entity_origins(&binding)?);
                            }
                        }
                        origins
                    }
                    _ => Vec::new(),
                }
            }
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
                    if !steps.is_empty() || exists_terminal(expr, name, true)?.is_some() {
                        let (start, read, _) = self.walk_start(name, &Binding::Handle(handle)).await?;
                        return self.read_adapter(expr, name, "a write handle", Rc::new(Landed::new(start, None, read)), scope, span).await;
                    }
                    let field = direct_field(expr, name, "a write handle")?;
                    self.binding_field(&Binding::Handle(handle), field).map_err(|e| Failure::of_eval(e, ""))
                }
                Binding::Extracted { emission, .. } => {
                    let emissions = crate::traverse::walk_extract(&emission, steps, name)?;
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
                Binding::LazyWalk(walk) => {
                    if !steps.is_empty() {
                        return Err(unsupported(&format!("hops past the deferred traversal bound to '{name}'")));
                    }
                    let reached: Vec<Binding> = self.run_deferred(&walk).await.map_err(crate::write::failure_of)?.into_iter().map(|(_, l)| l).collect();
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
                binding @ Binding::Shaped(_) => self.read_shaped(expr, name, binding, scope, span).await,
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
        let landed = if steps.is_empty() { vec![start] } else { self.walk_adapter(&start.position, &start.read, steps, name, scope, span).await? };
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

    /// `readAdapterTraverse` from `start` through `read`: a graph this run
    /// reads, or a dict's own `read`, which fails where the TypeScript calls
    /// into it.
    async fn read_graph(&self, expr: &Expression, name: &str, what: &str, start: Js, read: crate::shaped::GraphRead, scope: &Rc<Scope>, span: &Js) -> Result<Evaluated, Failure> {
        let read = match read {
            crate::shaped::GraphRead::Live(read) => {
                // The read wrapper reads the position's type (and, to restamp
                // it, its identity) before it hands a read or a hop on.
                let (steps, terminal) = parts(expr);
                let asks = !steps.is_empty()
                    || matches!(terminal, Expression::Exists { steps, .. } if !steps.is_empty())
                    || field_terminal(terminal).is_some_and(|f| f != POSITION_SENTINEL);
                if asks {
                    crate::shaped::wrapper_reads(&start, read.start_surface_type.as_deref()).map_err(|e| Failure::of_eval(e, ""))?;
                }
                return self.read_adapter(expr, name, what, Rc::new(Landed::new(start, None, read)), scope, span).await;
            }
            crate::shaped::GraphRead::Foreign(read) => read,
        };
        let eval = |e| Failure::of_eval(e, "");
        let exists = exists_terminal(expr, name, true)?;
        let (steps, terminal) = parts(expr);
        if let Some(step) = steps.first() {
            let TraversalStep::Edge(_) = step else {
                return Err(unsupported(&format!("'{}' hops in a traversal from '{name}'", crate::traverse::step_type(step))));
            };
            // The hop's pushdown asks `read.adapter.runtimeCapabilities()`.
            return Err(eval(crate::shaped::foreign_call(&read, "read", "runtimeCapabilities")));
        }
        let landed = || {
            let mut object = crate::js::JsObject::new();
            object.set("kind".into(), Js::str("sourcePosition"));
            object.set("position".into(), start.clone());
            object.set("read".into(), read.clone());
            Js::object(object)
        };
        if let Some((hops, where_)) = exists {
            let Some(TraversalStep::Edge(step)) = hops.first() else {
                return match (hops.first(), where_) {
                    (Some(step), _) => Err(unsupported(&format!("'{}' hops inside EXISTS()", crate::traverse::step_type(step)))),
                    (None, None) => Ok(Evaluated { value: Js::Bool(true), prov: none() }),
                    (None, Some(_)) => Err(eval(crate::shaped::foreign_call(&read, "seam", "getFieldValue"))),
                };
            };
            return Err(eval(crate::shaped::foreign_related(&read, step.direction == EdgeDirection::Incoming)));
        }
        let Some(field) = field_terminal(terminal) else {
            return Err(unsupported(&format!("this read shape on {what} ('{name}')")));
        };
        if field == POSITION_SENTINEL {
            return Ok(Evaluated { value: Js::array(vec![landed()]), prov: none() });
        }
        Err(eval(crate::shaped::foreign_call(&read, "seam", "getFieldValue")))
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
                if let Binding::Shaped(dict) = &binding {
                    reached.extend(self.walk_meta_shaped(&binding, &Js::Object(dict.clone()), step, steps, rest, name, scope, span).await?);
                    continue;
                }
                match &binding {
                    Binding::LazyWalk(_) => return Err(unsupported(&format!("hops past the deferred traversal bound to '{name}'"))),
                    Binding::Landed(landed) => {
                        let walked = self.walk_adapter(&landed.position, &landed.read, steps, name, scope, span).await?;
                        reached.extend(walked.into_iter().map(Binding::Landed));
                        continue;
                    }
                    Binding::Handle(_) => {
                        let (start, read, _) = self.walk_start(name, &binding).await?;
                        let walked = self.walk_adapter(&start, &read, steps, name, scope, span).await?;
                        reached.extend(walked.into_iter().map(Binding::Landed));
                        continue;
                    }
                    Binding::Value(value) => {
                        if let Some(held) = record::held_binding(&value.value) {
                            let landings = match held {
                                Binding::Positions(landings) => landings,
                                one => vec![one],
                            };
                            reached.extend(self.walk_meta(landings, steps, name, scope, span).await?);
                            continue;
                        }
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
                            if !rest.is_empty() {
                                return Err(unsupported(&format!("hops past the deferred traversal bound to '{name}'")));
                            }
                            reached.extend(self.run_deferred(&walk).await.map_err(crate::write::failure_of)?.into_iter().map(|(_, l)| l));
                            continue;
                        }
                        let mut kept = Vec::new();
                        for landed in node.borrow().landings(&step.edge_type_id) {
                            if self.hop_keeps_binding(step, &landed, scope, span).await? {
                                kept.push(landed);
                            }
                        }
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
                    Binding::Extracted { emission, .. } => {
                        let children: Vec<Binding> = emission
                            .children_of(&step.edge_type_id)
                            .iter()
                            .map(|child| Binding::Extracted { emission: child.clone(), root: false, id: Identity::new() })
                            .collect();
                        reached.extend(self.walk_meta(children, rest, name, scope, span).await?);
                    }
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

    /// `walkMetaSteps` over a dict the TypeScript takes for a record, kind
    /// by kind in the order its checks run.
    #[allow(clippy::too_many_arguments)]
    async fn walk_meta_shaped(
        &self,
        binding: &Binding,
        this: &Js,
        step: &EdgeStep,
        steps: &[TraversalStep],
        rest: &[TraversalStep],
        name: &str,
        scope: &Rc<Scope>,
        span: &Js,
    ) -> Result<Vec<Binding>, Failure> {
        let eval = |e| Failure::of_eval(e, "");
        let kind = record::kind_of(binding);
        let graph = match kind.as_str() {
            "lazyWalk" => return Err(self.shaped_walk(&record::get(this, "walk").map_err(eval)?)),
            "sourcePosition" => Some(self.shaped_source_record(this)?),
            "handle" => Some(self.shaped_handle_record(this, name).await?),
            _ => None,
        };
        if let Some((start, read)) = graph {
            return match read {
                crate::shaped::GraphRead::Live(read) => {
                    crate::shaped::wrapper_reads(&start, read.start_surface_type.as_deref()).map_err(eval)?;
                    Ok(self.walk_adapter(&start, &read, steps, name, scope, span).await?.into_iter().map(Binding::Landed).collect())
                }
                crate::shaped::GraphRead::Foreign(read) => Err(eval(crate::shaped::foreign_call(&read, "read", "runtimeCapabilities"))),
            };
        }
        if kind == "value" {
            let Binding::Value(value) = self.shaped_value(this).map_err(eval)? else { unreachable!("a value") };
            if let Some(held) = record::held_binding(&value.value) {
                let landings = match held {
                    Binding::Positions(landings) => landings,
                    one => vec![one],
                };
                return self.walk_meta(landings, steps, name, scope, span).await;
            }
        }
        if kind == "nodePosition" {
            let edge = record::get(&record::get(this, "edges").map_err(eval)?, &step.edge_type_id).map_err(eval)?;
            if !edge.is_nullish() && matches!(record::get(&edge, "kind").map_err(eval)?, Js::String(k) if k == "deferred") {
                if step.expression_filter.is_some() {
                    return Err(Failure::unsupported(
                        &format!("WHERE filters on a synthesised node's edges ('{name}')"),
                        "narrow the entry's own traversal instead — the WHERE belongs on the hop the node's edge is built from",
                    ));
                }
                return Err(self.shaped_walk(&record::get(&edge, "walk").map_err(eval)?));
            }
            let landings = if edge.is_nullish() { Js::Undefined } else { record::get(&edge, "landings").map_err(eval)? };
            let landings = match landings {
                Js::Undefined | Js::Null => Vec::new(),
                Js::Array(_) | Js::String(_) => self.raw_landings(landings, "")?,
                other => return Err(eval(record::type_error(&format!("{} is not iterable (cannot read property Symbol(Symbol.iterator))", typed(&other))))),
            };
            let mut kept = Vec::new();
            for landed in landings {
                if self.hop_keeps_binding(step, &landed, scope, span).await? {
                    kept.push(landed);
                }
            }
            return self.walk_meta(kept, rest, name, scope, span).await;
        }
        if step.expression_filter.is_some() {
            return Err(unsupported(&format!("WHERE filters on block meta-node hops ('{name}')")));
        }
        match kind.as_str() {
            "blockMeta" => Err(eval(edges_get(this, "binding"))),
            "positions" => {
                let landings = self.raw_landings(record::get(this, "landings").map_err(eval)?, "start")?;
                self.walk_meta(landings, steps, name, scope, span).await
            }
            "extractPosition" | "extractRoot" => {
                let children = record::get(&record::get(this, "emission").map_err(eval)?, "children").map_err(eval)?;
                Err(eval(if children.is_nullish() {
                    record::type_error(&format!("Cannot read properties of {} (reading 'get')", children.to_js_string()))
                } else {
                    record::type_error("binding.emission.children.get is not a function")
                }))
            }
            _ => Err(unsupported(&format!("traversing '{}' from {} inside a meta-node read", step.edge_type_id, record::describe(binding)))),
        }
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

    /// `readLandings`: the records themselves (a value landing as its
    /// value), or each one's field, collapsed.
    async fn read_landings(&self, expr: &Expression, landed: Vec<Binding>, name: &str, what: &str) -> Result<Evaluated, Failure> {
        let (_, terminal) = parts(expr);
        let Some(field) = field_terminal(terminal) else {
            return Err(unsupported(&format!("this read shape on {what} ('{name}')")));
        };
        if field == POSITION_SENTINEL {
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
            return Ok(Evaluated { value, prov: Prov::Built(Trail { origins, direct: None }) });
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
            Binding::Shaped(_) => self.shaped_field(binding, field, name),
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
                        Binding::Landed(landed) => crate::traverse::member_gate(step, &landed.position, &landed.read).map(|g| (g, landed.read.clone())),
                        _ => None,
                    };
                    let mut kept = Vec::new();
                    for landed in self.step_cursor(cursor, step, scope, span).await? {
                        if let (Some((gate, read)), Binding::Landed(l)) = (&gate, &landed)
                            && !gate.admits(read.schema.as_ref(), &l.position)
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
                    let related = self.related(&landed.position, step, read, scope, span).await?;
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
                            Err(error) => {
                                failure.get_or_insert(error);
                            }
                        }
                    }
                    match failure {
                        Some(error) => Err(error),
                        None => Ok(reached),
                    }
                }
                Binding::Handle(_) => {
                    let (start, read, _) = self.walk_start("handle", cursor).await?;
                    let landed = Binding::Landed(Rc::new(Landed::new(start, None, read)));
                    self.step_cursor(&landed, step, scope, span).await
                }
                Binding::Value(value) => match record::held_binding(&value.value) {
                    Some(held) => self.step_cursor(&held, step, scope, span).await,
                    None => Err(unsupported(&format!("traversing '{}' from {} inside EXISTS()", step.edge_type_id, record::describe(cursor)))),
                },
                Binding::Shaped(dict) => self.step_shaped(cursor, &Js::Object(dict.clone()), step, scope, span).await,
                other => Err(unsupported(&format!("traversing '{}' from {} inside EXISTS()", step.edge_type_id, record::describe(other)))),
            }
        })
    }

    /// `stepExistsCursor` of a dict the TypeScript takes for a record: each
    /// kind's case, reading the dict's own keys where the TypeScript does.
    async fn step_shaped(&self, cursor: &Binding, this: &Js, step: &EdgeStep, scope: &Rc<Scope>, span: &Js) -> Result<Vec<Binding>, Failure> {
        let eval = |e| Failure::of_eval(e, "");
        let graph = match record::kind_of(cursor).as_str() {
            "sourcePosition" => Some(self.shaped_source_record(this)?),
            "handle" => Some(self.shaped_handle_record(this, "a write handle").await?),
            "extractRoot" | "extractPosition" => {
                let children = record::get(&record::get(this, "emission").map_err(eval)?, "children").map_err(eval)?;
                return Err(eval(if children.is_nullish() {
                    record::type_error(&format!("Cannot read properties of {} (reading 'get')", children.to_js_string()))
                } else {
                    record::type_error("cursor.emission.children.get is not a function")
                }));
            }
            "blockMeta" => return Err(eval(edges_get(this, "cursor"))),
            "nodePosition" => {
                let edge = record::get(&record::get(this, "edges").map_err(eval)?, &step.edge_type_id).map_err(eval)?;
                if !edge.is_nullish() && matches!(record::get(&edge, "kind").map_err(eval)?, Js::String(k) if k == "deferred") {
                    return Err(self.shaped_walk(&record::get(&edge, "walk").map_err(eval)?));
                }
                let landings = if edge.is_nullish() { Js::Undefined } else { record::get(&edge, "landings").map_err(eval)? };
                return self.raw_landings(if landings.is_nullish() { Js::array(Vec::new()) } else { landings }, "(intermediate value)");
            }
            "positions" => {
                let landings = record::get(this, "landings").map_err(eval)?;
                let Js::Array(list) = &landings else {
                    return Err(eval(if landings.is_nullish() {
                        record::type_error(&format!("Cannot read properties of {} (reading 'map')", landings.to_js_string()))
                    } else {
                        record::type_error("cursor.landings.map is not a function")
                    }));
                };
                let cursors = list.items.iter().map(raw_cursor).collect::<Result<Vec<_>, _>>().map_err(eval)?;
                let hops: Vec<_> = cursors.iter().map(|landing| self.step_cursor(landing, step, scope, span)).collect();
                let mut reached = Vec::new();
                for result in join_all(hops).await {
                    reached.extend(result?);
                }
                return Ok(reached);
            }
            "value" => {
                let Binding::Value(value) = self.shaped_value(this).map_err(eval)? else { unreachable!("a value") };
                return match record::held_binding(&value.value) {
                    Some(held) => self.step_cursor(&held, step, scope, span).await,
                    None => Err(unsupported(&format!("traversing '{}' from {} inside EXISTS()", step.edge_type_id, record::describe(cursor)))),
                };
            }
            _ => None,
        };
        let Some((start, read)) = graph else {
            return Err(unsupported(&format!("traversing '{}' from {} inside EXISTS()", step.edge_type_id, record::describe(cursor))));
        };
        match read {
            crate::shaped::GraphRead::Live(read) => {
                crate::shaped::wrapper_reads(&start, read.start_surface_type.as_deref()).map_err(eval)?;
                self.step_cursor(&Binding::Landed(Rc::new(Landed::new(start, None, read))), step, scope, span).await
            }
            crate::shaped::GraphRead::Foreign(read) => Err(eval(crate::shaped::foreign_related(&read, step.direction == EdgeDirection::Incoming))),
        }
    }

    /// `runDeferredWalk` of a dict's `walk`: its `captured` scope, which data
    /// cannot make a `Map`, is iterated first.
    pub(crate) fn shaped_walk(&self, walk: &Js) -> Failure {
        let eval = |e| Failure::of_eval(e, "");
        match record::get(walk, "captured") {
            Err(error) => eval(error),
            Ok(Js::Array(_) | Js::String(_)) => Failure::unreproduced("running a walk a value holds as data", "the TypeScript engine resolves a block head the data writes"),
            Ok(_) => eval(record::type_error("walk.captured is not iterable")),
        }
    }

    /// What a dict's `landings` hands a walk as its records: each member as
    /// the TypeScript reads it, by its `kind`.
    fn raw_landings(&self, landings: Js, variable: &str) -> Result<Vec<Binding>, Failure> {
        let eval = |e| Failure::of_eval(e, "");
        match &landings {
            Js::Array(list) => list.items.iter().map(raw_cursor).collect::<Result<Vec<_>, _>>().map_err(eval),
            Js::String(text) if text.is_empty() => Ok(Vec::new()),
            Js::String(_) => Err(Failure::unreproduced("walking the characters of a text a value holds as records", "the TypeScript engine iterates them")),
            _ => Err(eval(record::type_error(&format!("{variable} is not iterable")))),
        }
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
        let plan = crate::order_limit::apply_hop_order_limit(kept.len(), cardinality, keys.as_deref()).map_err(|mixed| {
            Failure::unreproduced(
                &format!("ORDER BY over {} records whose keys mix numbers with text or other kinds", mixed.count),
                "past 64 records the order of mixed keys is the JavaScript sort's own; give the key one kind, or run this movement on the TypeScript engine",
            )
        })?;
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
    /// holds (a SORT key).
    pub(crate) async fn scoped_at_record(&self, expr: &Expression, subject: &Js, scope: &Rc<Scope>, span: Option<Js>) -> Result<Evaluated, Failure> {
        let record = record::binding_of(subject).expect("a SORT key is read off a record here");
        self.evaluate_scoped(expr, scope, span, Some(crate::traverse::scoped_at(&record))).await.map_err(crate::write::failure_of)
    }
}

/// The TypeScript's reads of a dict it takes for a binding (`Binding::Shaped`):
/// each kind's case of `traverseFrom` and `readBindingField`, reading the
/// dict's own keys in the order the TypeScript does, so a key it lacks fails
/// where JavaScript's would.
impl Run<'_> {
    fn read_shaped<'s>(&'s self, expr: &'s Expression, name: &'s str, binding: Binding, scope: &'s Rc<Scope>, span: &'s Js) -> Reads<'s, Evaluated> {
        Box::pin(async move {
            let Binding::Shaped(dict) = &binding else { unreachable!("a shaped binding") };
            let this = Js::Object(dict.clone());
            let kind = record::kind_of(&binding);
            let (steps, terminal) = parts(expr);
            let in_hand = steps.is_empty() && !matches!(terminal, Expression::Exists { .. });
            let eval = |e| Failure::of_eval(e, "");
            match kind.as_str() {
                "event" => self.read_from(expr, name, Binding::Event, scope, span).await,
                "sourcePosition" => {
                    let (start, read) = self.shaped_source_record(&this)?;
                    self.read_graph(expr, name, "a traversed source record", start, read, scope, span).await
                }
                // `graphRead` resolves the instance before a read with no
                // hops is refused.
                "instance" => {
                    let slug = record::get(&this, "adapterSlug").map_err(eval)?;
                    let read = self.shaped_instance_read(&this).await;
                    if steps.is_empty() && !matches!(terminal, Expression::Exists { .. }) {
                        // What the resolution would have asked outside the
                        // host contract is not asked; the refusal is the same.
                        if let Err(failure) = read
                            && !matches!(failure, Failure::Engine { class: crate::eval::ErrorClass::Unreproduced, .. })
                        {
                            return Err(failure);
                        }
                        return Err(Failure::unsupported(
                            &format!("reading fields of '{name}' ({})", record::describe(&binding)),
                            &format!("traverse a collection — {name}-[x:…]->"),
                        ));
                    }
                    let start = crate::traverse::meta_position(&slug.to_js_string());
                    self.read_graph(expr, name, &format!("the '{name}' graph"), start, crate::shaped::GraphRead::Live(read?), scope, span).await
                }
                "handle" if !in_hand => {
                    let (start, read) = self.shaped_handle_record(&this, name).await?;
                    self.read_graph(expr, name, "a write handle", start, read, scope, span).await
                }
                "handle" if in_hand => {
                    let field = direct_field(expr, name, "a write handle")?;
                    self.shaped_handle_field(&record::get(&this, "handle").map_err(eval)?, field).map_err(eval)
                }
                "extractRoot" | "extractPosition" if in_hand => {
                    let Some(field) = field_terminal(terminal) else {
                        return Err(unsupported(&format!("this read shape on an extracted entity ('{name}')")));
                    };
                    if field == POSITION_SENTINEL {
                        let emission = record::get(&this, "emission").map_err(eval)?;
                        return Ok(Evaluated { value: Js::array(vec![record::get(&emission, "fields").map_err(eval)?]), prov: none() });
                    }
                    self.shaped_emission_field(&record::get(&this, "emission").map_err(eval)?, field).map_err(eval)
                }
                "blockMeta" => {
                    let field = field_terminal(terminal);
                    if steps.is_empty() && field == Some(POSITION_SENTINEL) {
                        return Ok(Evaluated { value: Js::array(vec![this]), prov: none() });
                    }
                    if !steps.is_empty() && let Some(TraversalStep::Edge(step)) = steps.first()
                        && step.expression_filter.is_some()
                    {
                        return Err(unsupported(&format!("WHERE filters on block meta-node hops ('{name}')")));
                    }
                    let variable = if matches!(terminal, Expression::Exists { .. }) && steps.is_empty() { "cursor" } else { "binding" };
                    if !steps.is_empty() || matches!(terminal, Expression::Exists { steps, .. } if !steps.is_empty()) || field.is_some() {
                        return Err(Failure::of_eval(edges_get(&this, variable), ""));
                    }
                    Err(unsupported(&format!("this read shape on a block meta-node ('{name}')")))
                }
                "resource" => {
                    let field = direct_field(expr, name, "a resource")?;
                    self.shaped_resource_field(&record::get(&this, "resource").map_err(eval)?, field).map_err(eval)
                }
                "shapePosition" => {
                    let field = direct_field(expr, name, "a shape position")?;
                    self.shaped_planar_field(&this, field).map_err(eval)
                }
                "nodePosition" if in_hand => {
                    let field = direct_field(expr, name, "a synthesised node")?;
                    self.shaped_planar_field(&this, field).map_err(eval)
                }
                "nodePosition" => {
                    let reached = self.walk_meta(vec![binding.clone()], steps, name, scope, span).await?;
                    if let Some((hops, where_)) = exists_terminal(expr, name, true)? {
                        let found = self.exists(hops, where_, reached, scope, span).await?;
                        return Ok(Evaluated { value: Js::Bool(found), prov: none() });
                    }
                    self.read_landings(expr, reached, name, "a synthesised node").await
                }
                // `walkExtractSteps` over the dict's `emission`, whose
                // `children` data cannot make a `Map`.
                "extractRoot" | "extractPosition" => {
                    if let Some(step) = steps.first() {
                        let TraversalStep::Edge(edge) = step else {
                            return Err(unsupported(&format!("'{}' hops over the extract result ('{name}')", crate::traverse::step_type(step))));
                        };
                        if edge.expression_filter.is_some() {
                            return Err(unsupported(&format!("WHERE filters on extract-result hops ('{name}')")));
                        }
                        let children = record::get(&record::get(&this, "emission").map_err(eval)?, "children").map_err(eval)?;
                        return Err(eval(if children.is_nullish() {
                            record::type_error(&format!("Cannot read properties of {} (reading 'get')", children.to_js_string()))
                        } else {
                            record::type_error("e.children.get is not a function")
                        }));
                    }
                    // `EXISTS` over the one entity: its hop asks its children.
                    let Some((hops, where_)) = exists_terminal(expr, name, true)? else { unreachable!("an entity read in hand is read above") };
                    self.exists(hops, where_, vec![binding.clone()], scope, span).await.map(|found| Evaluated { value: Js::Bool(found), prov: none() })
                }
                "callback" => {
                    let field = direct_field(expr, name, "a callback")?;
                    Ok(Evaluated { value: shaped_callback_field(&this, field).map_err(eval)?, prov: none() })
                }
                "value" => {
                    let value = self.shaped_value(&this).map_err(eval)?;
                    self.read_from(expr, name, value, scope, span).await
                }
                // `resolveDeferred` runs the walk: its captured scope first.
                "lazyWalk" => Err(self.shaped_walk(&record::get(&this, "walk").map_err(eval)?)),
                // `walkMetaSteps(binding.landings, steps)`: no hops hand back
                // the landings as they are.
                "positions" => {
                    let landings = record::get(&this, "landings").map_err(eval)?;
                    if !steps.is_empty() {
                        let start = self.raw_landings(landings, "start")?;
                        let reached = self.walk_meta(start, steps, name, scope, span).await?;
                        if let Some((hops, where_)) = exists_terminal(expr, name, true)? {
                            let found = self.exists(hops, where_, reached, scope, span).await?;
                            return Ok(Evaluated { value: Js::Bool(found), prov: none() });
                        }
                        return self.read_landings(expr, reached, name, "a block's returned records").await;
                    }
                    if let Some((hops, where_)) = exists_terminal(expr, name, true)? {
                        let cursors = if hops.is_empty() {
                            // `cursors.length > 0`, then each cursor scoped for the WHERE.
                            match &landings {
                                Js::Array(_) | Js::String(_) if where_.is_none() => {
                                    return Ok(Evaluated { value: Js::Bool(!matches!(&landings, Js::Array(l) if l.items.is_empty()) && !matches!(&landings, Js::String(t) if t.is_empty())), prov: none() });
                                }
                                Js::Undefined | Js::Null => return Err(eval(record::type_error(&format!("Cannot read properties of {} (reading 'length')", landings.to_js_string())))),
                                Js::Array(_) | Js::String(_) => self.raw_landings(landings, "cursors")?,
                                _ => return Ok(Evaluated { value: Js::Bool(false), prov: none() }),
                            }
                        } else {
                            self.raw_landings(landings, "cursors")?
                        };
                        let found = self.exists(hops, where_, cursors, scope, span).await?;
                        return Ok(Evaluated { value: Js::Bool(found), prov: none() });
                    }
                    let Some(field) = field_terminal(terminal) else {
                        return Err(unsupported(&format!("this read shape on a block's returned records ('{name}')")));
                    };
                    if field == POSITION_SENTINEL {
                        let Js::Array(list) = &landings else {
                            return Err(eval(if landings.is_nullish() {
                                record::type_error(&format!("Cannot read properties of {} (reading 'map')", landings.to_js_string()))
                            } else {
                                record::type_error("landed.map is not a function")
                            }));
                        };
                        let members = list.items.iter().map(raw_cursor).collect::<Result<Vec<_>, _>>().map_err(eval)?;
                        return self.read_landings(expr, members, name, "a block's returned records").await;
                    }
                    let members = self.raw_landings(landings, "landed")?;
                    self.read_landings(expr, members, name, "a block's returned records").await
                }
                _ => Err(unsupported(&format!("reading '{name}' ({}) in an expression", record::describe(&binding)))),
            }
        })
    }

    /// `readBindingField` of a shaped binding.
    fn shaped_field(&self, binding: &Binding, field: &str, name: &str) -> Result<Evaluated, Failure> {
        let Binding::Shaped(dict) = binding else { unreachable!("a shaped binding") };
        let this = Js::Object(dict.clone());
        let eval = |e| Failure::of_eval(e, "");
        match record::kind_of(binding).as_str() {
            "handle" => self.shaped_handle_field(&record::get(&this, "handle").map_err(eval)?, field).map_err(eval),
            "extractPosition" | "extractRoot" => self.shaped_emission_field(&record::get(&this, "emission").map_err(eval)?, field).map_err(eval),
            "value" => {
                let value = self.shaped_value(&this).map_err(eval)?;
                self.read_binding_field(&value, field, name)
            }
            "resource" => self.shaped_resource_field(&record::get(&this, "resource").map_err(eval)?, field).map_err(eval),
            "shapePosition" | "nodePosition" => self.shaped_planar_field(&this, field).map_err(eval),
            "callback" => Ok(Evaluated { value: shaped_callback_field(&this, field).map_err(eval)?, prov: none() }),
            "blockMeta" => Err(Failure::of_eval(edges_get(&this, "binding"), "")),
            // `binding.landings.map(…)`, each member read by its `kind`.
            "positions" => match record::get(&this, "landings").map_err(eval)? {
                Js::Array(list) => {
                    let mut reads = Vec::with_capacity(list.items.len());
                    for member in &list.items {
                        reads.push(self.read_binding_field(&raw_cursor(member).map_err(eval)?, field, name)?);
                    }
                    Ok(self.collapse(reads))
                }
                landings if landings.is_nullish() => Err(eval(record::type_error(&format!("Cannot read properties of {} (reading 'map')", landings.to_js_string())))),
                _ => Err(eval(record::type_error("binding.landings.map is not a function"))),
            },
            _ => Err(unsupported(&format!("reading '{field}' off {} reached through '{name}'", record::describe(binding)))),
        }
    }

    /// `readHandleField` and `handleFieldProvenance` over a dict's `handle`.
    fn shaped_handle_field(&self, handle: &Js, field: &str) -> Result<Evaluated, crate::eval::EvalError> {
        let or_null = |v: Js| if v.is_nullish() { Js::Null } else { v };
        let value = match field {
            "externalId" => or_null(record::get(handle, "externalId")?),
            "created" => record::get(handle, "created")?,
            "committed" => record::get(handle, "committed")?,
            _ => {
                let written = record::get(handle, "writtenValues")?;
                if js_in(&written, field)? {
                    or_null(record::get(&written, field)?)
                } else {
                    match record::get(handle, "resultData")? {
                        data if data.is_nullish() => Js::Null,
                        data => or_null(record::get(&data, field)?),
                    }
                }
            }
        };
        let origin = record::get(handle, "origin")?;
        if !origin.truthy() {
            return Ok(Evaluated { value, prov: none() });
        }
        let mut read = crate::js::JsObject::new();
        spread_into(&mut read, &origin);
        read.set("field".into(), Js::str(field));
        let id = self.mint_origin(Js::object(read));
        Ok(Evaluated { value, prov: Prov::Built(Trail { origins: vec![id], direct: Some(id) }) })
    }

    /// `readEmissionField` over a dict's `emission`.
    fn shaped_emission_field(&self, emission: &Js, field: &str) -> Result<Evaluated, crate::eval::EvalError> {
        let origin = record::get(&record::get(emission, "provenance")?, field)?;
        let value = record::get(&record::get(emission, "fields")?, field)?;
        let value = if value.is_nullish() { Js::Null } else { value };
        if !origin.truthy() {
            return Ok(Evaluated { value, prov: none() });
        }
        let id = self.intern_origin(origin);
        Ok(Evaluated { value, prov: Prov::Built(Trail { origins: vec![id], direct: Some(id) }) })
    }

    /// The resource case: `resource.data?.[field] ?? null`, cited by the
    /// resource.
    fn shaped_resource_field(&self, resource: &Js, field: &str) -> Result<Evaluated, crate::eval::EvalError> {
        let value = match record::get(resource, "data")? {
            data if data.is_nullish() => Js::Null,
            data => record::get(&data, field)?,
        };
        let value = if value.is_nullish() { Js::Null } else { value };
        let mut origin = vec![("kind", Js::str("resource"))];
        let external_id = record::get(resource, "externalId")?;
        if !matches!(external_id, Js::Undefined) {
            origin.push(("externalId", external_id));
        }
        let name = record::get(resource, "name")?;
        if !matches!(name, Js::Undefined) {
            origin.push(("name", name));
        }
        origin.push(("field", Js::str(field)));
        let id = self.mint_origin(crate::env::object_of(origin));
        Ok(Evaluated { value, prov: Prov::Built(Trail { origins: vec![id], direct: Some(id) }) })
    }

    /// `readShapePositionField` / `readNodePositionField` over a dict's
    /// `fields` and `fieldProvenance`.
    fn shaped_planar_field(&self, this: &Js, field: &str) -> Result<Evaluated, crate::eval::EvalError> {
        let value = record::get(&record::get(this, "fields")?, field)?;
        let value = if value.is_nullish() { Js::Null } else { value };
        let provenance = record::get(&record::get(this, "fieldProvenance")?, field)?;
        Ok(Evaluated { value, prov: Prov::Built(self.trail_of_provenance(&provenance)) })
    }

    /// A dict's `value` case as the value binding it is to the TypeScript.
    fn shaped_value(&self, this: &Js) -> Result<Binding, crate::eval::EvalError> {
        let value = record::get(this, "value")?;
        let provenance = record::get(this, "provenance")?;
        let many = matches!(record::get(this, "many")?, Js::Bool(true));
        let trail = if provenance.is_nullish() { Trail::default() } else { self.trail_of_provenance(&provenance) };
        Ok(Binding::Value(crate::env::ValueBinding { value, trail: Some(trail), many }))
    }

    /// A provenance a dict carries, as a trail: its origins and `direct`,
    /// each the very object, interned.
    fn trail_of_provenance(&self, provenance: &Js) -> Trail {
        let Js::Object(object) = provenance else { return Trail::default() };
        let origins = match object.get("origins") {
            Some(Js::Array(list)) => list.items.iter().map(|o| self.intern_origin(o.clone())).collect(),
            _ => Vec::new(),
        };
        let direct = match object.get("direct") {
            Some(origin) if !matches!(origin, Js::Undefined) => Some(self.intern_origin(origin.clone())),
            _ => None,
        };
        Trail { origins, direct }
    }
}


/// `readCallbackField`.
fn shaped_callback_field(this: &Js, field: &str) -> Result<Js, crate::eval::EvalError> {
    match field {
        "id" => record::get(this, "callbackId"),
        "url" => record::get(this, "url"),
        _ => Ok(Js::Null),
    }
}

/// `<variable>.edges.get(…)` on a dict, whose `edges` is no `Map`.
fn edges_get(this: &Js, variable: &str) -> crate::eval::EvalError {
    match record::get(this, "edges") {
        Err(error) => error,
        Ok(edges) if edges.is_nullish() => record::type_error(&format!("Cannot read properties of {} (reading 'get')", edges.to_js_string())),
        Ok(_) => record::type_error(&format!("{variable}.edges.get is not a function")),
    }
}

/// `key in value`: its own keys and its prototype's; a TypeError on anything
/// that is not an object.
fn js_in(value: &Js, key: &str) -> Result<bool, crate::eval::EvalError> {
    match value {
        Js::Object(object) => Ok(object.get(key).is_some() || crate::js::is_object_prototype_name(key)),
        Js::Record(record) => Ok(key == "kind" || !matches!(record::own_property(record, key)?, Js::Null) || crate::js::is_object_prototype_name(key)),
        Js::Array(list) => Ok(key == "length" || key.parse::<usize>().is_ok_and(|i| i < list.items.len())),
        Js::Function(_) => Ok(matches!(key, "length" | "name" | "prototype")),
        other => Err(record::type_error(&format!("Cannot use 'in' operator to search for '{key}' in {}", other.to_js_string()))),
    }
}

/// `{...value}` into `object`: an object's own keys, a text's characters.
fn spread_into(object: &mut crate::js::JsObject, value: &Js) {
    match value {
        Js::Object(source) => {
            for (key, item) in source.entries() {
                object.set(key.clone(), item.clone());
            }
        }
        Js::String(text) => {
            for (index, c) in text.encode_utf16().enumerate() {
                object.set(index.to_string(), Js::String(String::from_utf16_lossy(&[c])));
            }
        }
        _ => {}
    }
}

/// A member of a dict's `landings` as a cursor the TypeScript switches on by
/// its `kind`: a dict as the record it is shaped like (or a kind none of the
/// switches names), anything else a cursor of no kind — and `null` or
/// `undefined`, whose `kind` cannot be read.
fn raw_cursor(member: &Js) -> Result<Binding, crate::eval::EvalError> {
    match member {
        Js::Object(dict) => Ok(Binding::Shaped(dict.clone())),
        Js::Undefined | Js::Null => Err(record::type_error(&format!("Cannot read properties of {} (reading 'kind')", member.to_js_string()))),
        _ => Ok(Binding::Shaped(Rc::new(crate::js::JsObject::new()))),
    }
}

/// How V8 names a value it cannot iterate that no variable names: its type,
/// then the value where it prints one.
fn typed(value: &Js) -> String {
    match value {
        Js::Bool(_) | Js::Number(_) => format!("{} {}", value.type_of(), value.to_js_string()),
        other => other.type_of().to_string(),
    }
}
