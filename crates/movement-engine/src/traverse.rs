//! Traversal blocks over adapter edges: run.ts `interpretBlock` and the
//! adapter-edge branch of its head walk (`headIterationsFrom` →
//! `walkSourceHeadPaths`), for a head of one hop rooted at a constructed
//! instance, a write's handle or the event:
//!
//! ```text
//! graph-[c:company WHERE `stage` == "Seed" ORDER BY `revenue` DESC LIMIT 2]-> {
//!   write graph-[:note]-> { text: c.`name` }
//! }
//! ```
//!
//! 1. the head's graph: the instance resolved as a source (once per
//!    instance, `instanceSourceRead`) from its meta position; a handle's own
//!    graph from its record; the event's source from the seeded position;
//! 2. the hop's fetch (`closedHopPushdown`): its pure WHERE with the leaves
//!    the scope already holds as scalars swapped in, its ORDER BY when the
//!    key is a bare field, its LIMIT when the sort goes with it
//!    (crate::order_limit);
//! 3. the fetch: `getRelated` through the read wrapper (kg.ts
//!    `surfaceReadAdapter`: the origin stamped with its natural type, each
//!    landing with its target's), or, for an instance that streams,
//!    `iterateRelatedPage` page by page, each page's records filtered before
//!    the next is asked for (`iterateRelatedPages`, its repeated-cursor guard
//!    and page bound included);
//! 4. per landed record: the narrowed member gate (`hopMemberGate`), then
//!    the WHERE, decided as `hopFilterKeeps` decides it (a pure WHERE a
//!    conjunct at a time, each leaf read once; any other through the
//!    evaluator), the hop's alias naming the record;
//! 5. ORDER BY / LIMIT over what was kept (`applyHopOrderLimit`), each key
//!    read off its record;
//! 6. the body once per landing, in order, at the iteration's address
//!    (`s1.i0.s0`), in a scope of its own holding the alias.
//!
//! Bodies run sequentially, as the TypeScript's do, a nested block's at
//! `…i<j>.s<k>.i<m>…`. A body may not park or suspend (admission refuses it):
//! nothing here joins parked iterations. A body that fails fails the run
//! where it stands: the iterations before it keep their writes, the rest
//! never run.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use movement_parser::ast::{PathHead, PathRoot, TraversalBlock};
use movement_parser::catalog::types::InstanceSchema;
use movement_parser::lowering::expression::{EdgeDirection, EdgeStep, Expression, FilterOperator, TraversalStep};
use serde_json::Value as Json;

use crate::address::Address;
use crate::bindings::{Binding, Handle, InstanceBinding, Landed, Scope};
use crate::env::{self, Trail};
use crate::eval::{ErrorClass, EvalError, Evaluated, Prov};
use crate::executor::join_all;
use crate::host::{self, Instance, ResolveAdapter, Role};
use crate::js::{self, Js};
use crate::js_date;
use crate::order_limit::{self, Substitution};
use crate::extract::emission::Emission;
use crate::run::{Failure, Flow, Run, Scoped, Stop};
use crate::trace::TraceEntry;
use crate::unique::get;
use crate::write::spell_name;

/// The most pages one traversal walks (adapter.ts `MAX_RELATED_PAGES`).
const MAX_RELATED_PAGES: usize = 10_000;

/// A graph a walk reads through (expression.ts `SourceRead`): the instance,
/// what the read wrapper needs to name its positions, and what the instance
/// said it can do.
#[derive(Debug, Clone)]
pub struct Read {
    pub instance: Instance,
    /// The live adapter's own `adapterType`.
    pub adapter_type: String,
    /// The instance's name, which a read's origins cite.
    pub instance_name: String,
    pub schema: Option<InstanceSchema>,
    /// The movement parameter's declared position, which names a typeless
    /// event root (the event's source only).
    pub start_surface_type: Option<String>,
    /// `runtimeCapabilities().traversal.incoming`.
    pub incoming: bool,
    /// `runtimeCapabilities().traversal.edgeProperties`.
    pub edge_properties: bool,
    /// The instance streams a traversal (`methods` lists `iterateRelated`),
    /// which the engine walks a page at a time.
    pub streams: bool,
    /// The adapter itself, not the surface-read wrapper over it: a field read
    /// hands it the position as it is (an awaited landing's, run.ts
    /// `declareAwaitResult`).
    pub raw: bool,
}

impl Read {
    /// What `adapters.resolve` answered, as a read.
    pub fn of_resolved(resolved: &Json, instance: Instance, binding: &InstanceBinding, start_surface_type: Option<String>) -> Read {
        let traversal = resolved.get("capabilities").and_then(|c| c.get("traversal"));
        let flag = |name: &str| traversal.and_then(|t| t.get(name)).and_then(Json::as_bool) == Some(true);
        Read {
            streams: instance.has("iterateRelated"),
            adapter_type: resolved.get("adapterType").and_then(Json::as_str).unwrap_or(&binding.adapter_slug).to_string(),
            instance,
            instance_name: binding.name.clone(),
            schema: binding.schema.clone(),
            start_surface_type,
            incoming: flag("incoming"),
            edge_properties: flag("edgeProperties"),
            raw: false,
        }
    }
}

// ── Positions, as translation_graph/types.ts reads and makes them ──

pub(crate) fn record_type(position: &Js) -> Option<String> {
    match get(position, "recordType") {
        Js::String(text) => Some(text),
        _ => None,
    }
}

pub(crate) fn is_stable(position: &Js) -> bool {
    matches!(get(&get(position, "identity"), "kind"), Js::String(kind) if kind == "stable")
}

/// `positionRecordId`.
pub(crate) fn record_id(position: &Js) -> Js {
    if is_stable(position) { get(&get(position, "identity"), "recordId") } else { Js::Undefined }
}

/// `positionData`.
pub(crate) fn position_data(position: &Js) -> Js {
    get(&get(position, "identity"), "data")
}

pub(crate) fn stable_position(adapter_type: Js, record_type: Js, record_id: Js, data: Js) -> Js {
    env::object_of(vec![
        ("adapterType", adapter_type),
        ("recordType", record_type),
        ("identity", env::object_of(vec![("kind", Js::str("stable")), ("recordId", record_id), ("data", data)])),
    ])
}

fn unstable_position(adapter_type: Js, record_type: Js, data: Js) -> Js {
    env::object_of(vec![
        ("adapterType", adapter_type),
        ("recordType", record_type),
        ("identity", env::object_of(vec![("kind", Js::str("unstable")), ("data", data)])),
    ])
}

/// `makeMetaPosition`: the schema root of an adapter.
pub(crate) fn meta_position(adapter_slug: &str) -> Js {
    meta_position_of(Js::str(adapter_slug))
}

/// `makeMetaPosition` of a slug as a binding holds it.
pub(crate) fn meta_position_of(adapter_slug: Js) -> Js {
    unstable_position(adapter_slug, Js::str("meta"), Js::Undefined)
}

/// The read wrapper's `restamp`: the position under a natural type, its
/// inline data kept; the very position when there is no type to give it or
/// it already has that one.
fn restamp(position: &Js, natural: Option<&str>, adapter_type: &str) -> Js {
    let Some(natural) = natural else { return position.clone() };
    if record_type(position).as_deref() == Some(natural) {
        return position.clone();
    }
    let id = record_id(position);
    let data = position_data(position);
    if is_stable(position) && !matches!(id, Js::Undefined) {
        return stable_position(Js::str(adapter_type), Js::str(natural), id, data);
    }
    unstable_position(Js::str(adapter_type), Js::str(natural), data)
}

/// kg.ts `stampedPositionName`: the adapter's own stamp, where the schema
/// knows it as a position.
fn stamped_position_name(schema: Option<&InstanceSchema>, position: &Js) -> Option<String> {
    let concrete = record_type(position)?;
    schema?.positions.contains_key(&concrete).then_some(concrete)
}

/// `spellPathHead`, for a head rooted at a name.
pub fn spell_path_head(head: &PathHead) -> String {
    let root = match &head.root {
        Some(PathRoot::Name { name }) => spell_name(name),
        Some(PathRoot::Expression { expr }) => expr.raw.clone(),
        None => String::new(),
    };
    format!("{root}{}", head.hops_raw)
}

/// The head's hop chain, probe-parsed (`probeHead`): the one edge hop it
/// walks.
pub(crate) fn head_step(head: &PathHead) -> Result<EdgeStep, String> {
    let root = match &head.root {
        Some(PathRoot::Name { name }) => spell_name(name),
        Some(PathRoot::Expression { .. }) => "__movement_expression_root__".into(),
        None => String::new(),
    };
    let probe = format!("{root}{}.`__movement_engine_probe__`", head.hops_raw);
    let tree = movement_parser::expr::parse_expression(&probe).map_err(|e| format!("{e:?}"))?;
    match movement_parser::lowering::lower_expression(&tree, &probe).map_err(|e| format!("{e:?}"))? {
        Expression::Traverse { mut steps, .. } if steps.len() == 1 => match steps.remove(0) {
            TraversalStep::Edge(step) => Ok(step),
            _ => Err("a hop that is not an edge".into()),
        },
        _ => Err("a head that is not one hop".into()),
    }
}

/// What a head walk yields: each iteration's aliases and its landing.
pub(crate) type Paths = Vec<(Vec<(String, Binding)>, Binding)>;

/// `EXPRESSION_ROOT_PROBE`: what an expression root reads as in the probe.
const EXPRESSION_ROOT_PROBE: &str = "__movement_expression_root__";

/// `probeHead` with `extraSteps` appended: the head's hops when it parses as
/// a traversal, `None` when it parses as anything else.
pub(crate) fn head_probe(root: &str, hops_raw: &str, extra: &[TraversalStep]) -> Result<Option<Vec<TraversalStep>>, Failure> {
    let probe = format!("{root}{hops_raw}.`__movement_engine_probe__`");
    let invalid = |e: String| Failure::engine("MOVENG_RUNTIME", format!("invalid block head (the checker should have caught this): {e}"));
    let tree = movement_parser::expr::parse_expression(&probe).map_err(|e| invalid(format!("{e:?}")))?;
    // Every lowering refusal is a `BridgeError`, which `probeHead` rewraps
    // by its message.
    let steps = match movement_parser::lowering::lower_expression(&tree, &probe).map_err(|e| invalid(e.message))? {
        Expression::Traverse { mut steps, .. } => {
            steps.extend(extra.iter().cloned());
            Some(steps)
        }
        // The resource bundle's hop, which this engine does not walk.
        Expression::ResourceTraverse { .. } => {
            return Err(Failure::unreproduced("a `_resources` block head", "the TypeScript engine resolves the position's resource bundle"));
        }
        _ => None,
    };
    if !extra.is_empty() && steps.is_none() {
        return Err(Failure::unsupported("continuing a walk past a head that is not a traversal", ""));
    }
    Ok(steps)
}

/// A hop over an extraction's entities: an edge, and no WHERE.
fn extract_step(step: &TraversalStep) -> Result<&EdgeStep, Failure> {
    let TraversalStep::Edge(step) = step else {
        return Err(Failure::unsupported(&format!("'{}' hops in a block head over an extract result", step_type(step)), ""));
    };
    if step.expression_filter.is_some() {
        return Err(Failure::unsupported("WHERE filters on extract-result block heads", ""));
    }
    Ok(step)
}

/// The extraction's paths: every hop an edge's children, each hop's alias
/// binding its own level's entity.
fn extract_paths(root: Binding, steps: &[TraversalStep]) -> Result<Paths, Failure> {
    let mut paths: Paths = vec![(Vec::new(), root)];
    for step in steps {
        let step = extract_step(step)?;
        let mut next = Vec::new();
        for (aliases, binding) in &paths {
            let Binding::Extracted { emission, .. } = binding else { unreachable!("an extraction's paths hold its entities") };
            for child in emission.children_of(&step.edge_type_id) {
                let landing = Binding::Extracted { emission: child.clone(), root: false, id: crate::bindings::Identity::new() };
                let mut aliases = aliases.clone();
                if let Some(alias) = &step.alias {
                    aliases.push((alias.clone(), landing.clone()));
                }
                next.push((aliases, landing));
            }
        }
        paths = next;
    }
    Ok(paths)
}

/// An edge of a node's arrow plane: the node's kept walk, or the landings
/// it holds.
enum PlaneEdge {
    Kept(Rc<crate::bindings::DeferredWalk>),
    Landed(Vec<Binding>),
}

/// `continueDeferred`: a walk's iterations under the aliases bound on the
/// way in, the hop's own alias naming each landing.
fn continue_deferred(outer: Vec<(String, Binding)>, iterations: Paths, alias: Option<&str>) -> Paths {
    iterations
        .into_iter()
        .map(|(inner, landing)| {
            let mut aliases = outer.clone();
            aliases.extend(inner);
            if let Some(alias) = alias {
                aliases.push((alias.to_string(), landing.clone()));
            }
            (aliases, landing)
        })
        .collect()
}

/// `scopeOf`: what a position-scoped evaluation over a landing reads.
pub(crate) fn scoped_at(landing: &Binding) -> Scoped {
    match landing {
        Binding::Landed(landed) => Scoped::Landed(landed.clone()),
        Binding::Extracted { emission, .. } => Scoped::Emission(emission.clone()),
        other => Scoped::Binding(other.clone()),
    }
}

/// The member a narrowed polymorphic hop is about (`hopSelection`): the
/// type its records carry, and the hop's declared target.
pub(crate) struct MemberGate {
    member_type: String,
    declared_target: String,
}

/// `hopMemberGate`: a record of another member than the one a WHERE
/// narrowed the hop to is not a match.
pub(crate) fn member_gate(step: &EdgeStep, origin: &Js, read: &Read) -> Option<MemberGate> {
    selection(step.expression_filter.as_deref()?, step, origin, read)
}

fn selection(filter: &Expression, step: &EdgeStep, origin: &Js, read: &Read) -> Option<MemberGate> {
    let schema = read.schema.as_ref()?;
    let selected = schema.selected_members.as_ref()?;
    let declared = record_type(origin)
        .and_then(|from| schema.positions.get(&from)?.edges.get(&step.edge_type_id).map(|e| e.target.clone()))
        .or_else(|| schema.collections.get(&step.edge_type_id).map(|c| c.target.clone()))?;
    let filter = serde_json::to_value(filter).expect("an expression is JSON");
    let key = movement_parser::catalog::helpers::refinement_key(&declared, &filter);
    selected.get(&key).map(|member| MemberGate { member_type: member.clone(), declared_target: declared })
}

impl MemberGate {
    pub(crate) fn admits(&self, schema: Option<&InstanceSchema>, landed: &Js) -> bool {
        match stamped_position_name(schema, landed) {
            None => true,
            Some(stamped) if stamped == self.declared_target => true,
            Some(stamped) => stamped == self.member_type,
        }
    }
}

/// The read wrapper's `landedSurfaceType`: what a hop off a typed position
/// lands on — the declared edge's target outgoing (none for a union
/// target), the type declaring the edge incoming.
fn landed_surface_type(schema: Option<&InstanceSchema>, from: Option<&str>, edge: &str, direction: EdgeDirection) -> Option<String> {
    let schema = schema?;
    let from = from?;
    match direction {
        EdgeDirection::Outgoing => {
            let target = schema.positions.get(from)?.edges.get(edge)?.target.clone();
            (!schema.unions.as_ref().is_some_and(|u| u.contains_key(&target))).then_some(target)
        }
        EdgeDirection::Incoming => {
            schema.positions.iter().find(|(_, p)| p.edges.get(edge).is_some_and(|e| e.target == from)).map(|(name, _)| name.clone())
        }
    }
}

fn direction_text(direction: EdgeDirection) -> &'static str {
    match direction {
        EdgeDirection::Outgoing => "outgoing",
        EdgeDirection::Incoming => "incoming",
    }
}

fn list_items(value: &Js) -> Result<Vec<Js>, Failure> {
    match value {
        Js::Array(list) => Ok(list.items().clone()),
        other => Err(Failure::engine("MOVENG_RUNTIME", format!("a traversal answered {} where a list of records was due", other.type_of()))),
    }
}

impl Run<'_> {
    /// `interpretBlock` for a block whose head walks one hop; bound
    /// (`x = … { return … }`), the iterations' returned values are `x`.
    pub(crate) async fn block(&self, block: &TraversalBlock, binding_name: Option<&str>, scope: &Rc<Scope>, at: &Address, path: &str) -> Result<Flow, Stop> {
        let iterations = self.head_iterations(&block.head, scope).await?;
        self.trace(TraceEntry::Block { root: spell_path_head(&block.head), positions: iterations.len() });
        let body = format!("{path}/block/body");
        let mut returned: Vec<Binding> = Vec::new();
        let mut finished: Vec<(usize, Binding)> = Vec::new();
        let mut parked = 0;
        for (index, (aliases, _)) in iterations.into_iter().enumerate() {
            // Per-landing isolation: an iteration's bindings never reach the
            // next, and the only way a value leaves one is its `return`,
            // which an unbound block has nowhere to put.
            let iteration = scope.child();
            for (alias, landed) in aliases {
                iteration.declare(alias, landed);
            }
            let flow = match self.body(&block.body, &iteration, &at.iter(index), &body, 0).await {
                // A parked iteration keeps its leaf (at its `i j`) but does
                // not halt the fan-out: the next runs its own prefix and
                // parks at its own.
                Err(Stop::Parked(_)) => {
                    parked += 1;
                    continue;
                }
                // A match inside found nothing: this iteration skips, the
                // next runs.
                Err(Stop::EndedQuietly) => continue,
                other => other?,
            };
            // The one way a value leaves an iteration is its `return`.
            if let Flow::Returned = flow
                && let Some(value) = iteration.resolve_own(crate::run::RETURN_SLOT)
            {
                returned.push(value.clone());
                finished.push((index, value));
            }
        }
        if let Some(name) = binding_name {
            scope.declare(name, block_value(returned));
        }
        // An iteration parked: the fan-out is a pending join at its own
        // address, what the finished ones returned kept at its frame.
        if parked > 0 {
            let frame = at.encode();
            for (index, value) in &finished {
                let exports = env::object_of(vec![(crate::run::RETURN_SLOT, crate::park::serialize_alone(self, value).map_err(Stop::Thrown)?)]);
                self.persist_branch_export(&frame, &at.iter(*index).encode(), *index as i64, &exports).await?;
            }
            self.record_join(&frame, parked).await?;
            return Err(Stop::Parked(frame));
        }
        Ok(Flow::FellThrough)
    }

    /// `resolveHeadIterations`: each iteration's aliases and the record it
    /// landed on. The root is a name in scope, or an expression bound as
    /// `x = <expression>` binds it (`bindSlotValue`).
    pub(crate) async fn head_iterations(&self, head: &PathHead, scope: &Rc<Scope>) -> Result<Paths, Stop> {
        self.head_iterations_past(head, scope, &[]).await
    }

    /// `resolveHeadIterations(head, env, extraSteps)`: the head's hops and
    /// `extra` after them, one walk.
    pub(crate) async fn head_iterations_past(&self, head: &PathHead, scope: &Rc<Scope>, extra: &[TraversalStep]) -> Result<Paths, Stop> {
        let probe_root = match &head.root {
            Some(PathRoot::Name { name }) => spell_name(name),
            Some(PathRoot::Expression { .. }) => EXPRESSION_ROOT_PROBE.into(),
            None => String::new(),
        };
        let steps = head_probe(&probe_root, &head.hops_raw, extra).map_err(Stop::Thrown)?;
        let span = env::js_of_serialized(&head.span);
        let (binding, root) = match &head.root {
            Some(PathRoot::Name { name }) => (scope.resolve(name), spell_name(name)),
            Some(PathRoot::Expression { expr }) => (Some(self.bind_slot_binding(expr, scope).await?), expr.raw.clone()),
            None => return Err(Stop::Thrown(Failure::unsupported("rootless block heads (relative traversal)", "root the head at a named binding"))),
        };
        let binding = binding
            .ok_or_else(|| Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("'{root}' is not in scope — the checker should have caught this"))))?;
        self.head_iterations_from(binding, &root, steps.as_deref(), scope, &span).await
    }

    /// `headIterationsFrom`: the head's hops off one root — each of a
    /// block's returned records, each record a value holds, an extraction's
    /// entities under the edges, a node's arrow plane, a kept walk run on, or
    /// the records an adapter walk lands on. `steps` is `None` where the head
    /// probed as no traversal.
    pub(crate) fn head_iterations_from<'s>(
        &'s self,
        binding: Binding,
        root: &'s str,
        steps: Option<&'s [TraversalStep]>,
        scope: &'s Rc<Scope>,
        span: &'s Js,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Paths, Stop>> + 's>> {
        Box::pin(async move {
            let over = |what: String| Stop::Thrown(Failure::unsupported(&format!("this block head over {what}"), ""));
            match binding {
                // The hops off each returned record, concatenated.
                Binding::Positions(landings) => {
                    let mut iterations = Vec::new();
                    for landing in landings {
                        iterations.extend(self.head_iterations_from(landing, root, steps, scope, span).await?);
                    }
                    Ok(iterations)
                }
                // `deals-[c:company]-> { … }`: the extract's own entities under
                // those edges, in hand; no host is asked. Its ORDER BY and LIMIT
                // are not read, as the TypeScript does not read them.
                extracted @ Binding::Extracted { .. } => {
                    let Some(steps) = steps else { return Err(over("an extract result".into())) };
                    extract_paths(extracted, steps).map_err(Stop::Thrown)
                }
                // `d-[c:company]-> { … }`: the node's arrow plane.
                node @ Binding::Node(_) => {
                    let Some(steps) = steps else { return Err(over(crate::record::describe(&node))) };
                    self.walk_node_plane(vec![(Vec::new(), node)], steps, scope, span).await
                }
                // A lazy binding IS the walk: the whole chain continues from it.
                Binding::LazyWalk(walk) => {
                    let Some(steps) = steps else { return Err(over(crate::record::describe_kind("lazyWalk"))) };
                    self.run_deferred_past(&walk, steps).await
                }
                // `found = MAP(pieces, …)`: a value holding records, each the
                // root of the same hops, in the list's order.
                Binding::Value(value) => {
                    let list = matches!(value.value, Js::Array(_));
                    let members = match &value.value {
                        Js::Array(items) => items.items().clone(),
                        other => vec![other.clone()],
                    };
                    let mut iterations = Vec::new();
                    for member in members {
                        let Some(position) = crate::record::binding_of(&member) else {
                            let held = if list { format!("one of the values in '{root}' is") } else { format!("'{root}' is") };
                            return Err(Stop::Thrown(Failure::engine(
                                "MOVENG_RUNTIME",
                                format!(
                                    "{held} {}, and a hop walks from a POSITION — there is nothing here to hop from. A block head starts at a record, an extraction's result, or a list of them ('MAP(pieces, (p) => {{ return extract … }})').",
                                    describe_head_value(&member)
                                ),
                            )));
                        };
                        iterations.extend(self.head_iterations_from(position, root, steps, scope, span).await?);
                    }
                    Ok(iterations)
                }
                // `cb-[c:Called]-> { … }`: the calls so far, read off the
                // ledger; none before anything fires is an empty walk.
                callback @ Binding::Callback(_) => match steps {
                    Some([TraversalStep::Edge(step)]) if step.edge_type_id == crate::awaits::CALLED => {
                        let filter = step.expression_filter.as_deref().map(|filter| (filter.clone(), step.alias.clone()));
                        let landings = self.called_landings(&callback, filter.as_ref(), scope).await?;
                        Ok(landings
                            .into_iter()
                            .map(|landing| {
                                let aliases = step.alias.iter().map(|alias| (alias.clone(), landing.clone())).collect();
                                (aliases, landing)
                            })
                            .collect())
                    }
                    Some([TraversalStep::Edge(step)]) => Err(Stop::Thrown(Failure::unsupported(
                        &format!("'-[:{}]->' on a callback", step.edge_type_id),
                        &format!("a callback has one edge, '{}'", crate::awaits::CALLED),
                    ))),
                    _ => Err(Stop::Thrown(Failure::unsupported("this block head over a callback", ""))),
                },
                // `org-[w:@old]-> { … }`: the record before `org`'s write,
                // which the handle holds itself (no system has the edge): one
                // iteration, or none when the write created the record. Hops
                // past it walk on from that record, as a head rooted there
                // would (`oldEdgeHeadIterations`).
                Binding::Handle(handle) if steps.is_some_and(crate::reading::starts_with_old_edge) => {
                    let Some([TraversalStep::Edge(step), rest @ ..]) = steps else { unreachable!("the head starts with -[:@old]->") };
                    let Some(old) = Handle::old_landings(&handle).into_iter().next() else { return Ok(Vec::new()) };
                    if !self.hop_keeps_binding(step, &old, scope, span).await.map_err(Stop::Thrown)? {
                        return Ok(Vec::new());
                    }
                    let aliases: Vec<(String, Binding)> = step.alias.iter().map(|alias| (alias.clone(), old.clone())).collect();
                    if rest.is_empty() {
                        return Ok(vec![(aliases, old)]);
                    }
                    let onward = self.head_iterations_from(old, root, Some(rest), scope, span).await?;
                    Ok(onward
                        .into_iter()
                        .map(|(bindings, landing)| {
                            let mut merged = aliases.clone();
                            for (name, binding) in bindings {
                                match merged.iter_mut().find(|(n, _)| *n == name) {
                                    Some(slot) => slot.1 = binding,
                                    None => merged.push((name, binding)),
                                }
                            }
                            (merged, landing)
                        })
                        .collect())
                }
                binding @ (Binding::Instance(_) | Binding::Handle(_) | Binding::Event | Binding::Landed(_)) => {
                    let Some(steps) = steps else { return Err(over(crate::record::describe(&binding))) };
                    let (start, read) = self.head_start(&binding, root).await.map_err(Stop::Thrown)?;
                    self.source_head_paths(&start, read, steps, scope, span).await.map_err(Stop::Thrown)
                }
                other => Err(Stop::Thrown(Failure::unsupported(&format!("block heads rooted at '{root}' (a {} binding)", crate::record::kind_of(&other)), ""))),
            }
        })
    }

    /// `walkSourceHeadPaths`: each hop off every path the hop before it
    /// reached, in order (breadth first, as the TypeScript asks), each hop's
    /// alias naming its own level's record on its path.
    pub(crate) async fn source_head_paths(&self, start: &Js, read: Rc<Read>, steps: &[TraversalStep], scope: &Rc<Scope>, span: &Js) -> Result<Paths, Failure> {
        let mut paths: Vec<(Vec<(String, Binding)>, Rc<Landed>)> = vec![(Vec::new(), Rc::new(Landed::new(start.clone(), None, read.clone())))];
        for step in steps {
            let TraversalStep::Edge(step) = step else {
                return Err(Failure::unsupported(&format!("'{}' hops in a block head over the source graph", step_type(step)), ""));
            };
            if step.direction == EdgeDirection::Incoming && !read.incoming {
                return Err(Failure::unsupported(
                    &format!("incoming block-head hops ('{}')", step.edge_type_id),
                    &format!("source adapter '{}' cannot traverse incoming edges", read.adapter_type),
                ));
            }
            // Closed over the head's own scope, once for the hop.
            let pushdown = self.pushdown_args(step, &read, scope, span).await;
            let mut next = Vec::new();
            for (aliases, cursor) in &paths {
                let kept = self.fetch(&cursor.position, step, &read, Fetch { pushdown: &pushdown, paged: read.streams }, scope, span).await?;
                for landed in self.ordered(kept, step, scope, span).await? {
                    let mut aliases = aliases.clone();
                    if let Some(alias) = &step.alias {
                        aliases.push((alias.clone(), Binding::Landed(landed.clone())));
                    }
                    next.push((aliases, landed));
                }
            }
            paths = next;
            if paths.is_empty() {
                return Ok(Vec::new());
            }
        }
        Ok(paths.into_iter().map(|(aliases, landed)| (aliases, Binding::Landed(landed))).collect())
    }

    /// `walkNodePlane`: each hop crosses one edge of a synthesised node,
    /// fanning out over its landings, path by path; a deferred edge hands the
    /// rest of the chain to its kept walk, and past a source record the
    /// source's own walker takes the rest.
    pub(crate) fn walk_node_plane<'s>(
        &'s self,
        paths: Paths,
        steps: &'s [TraversalStep],
        scope: &'s Rc<Scope>,
        span: &'s Js,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Paths, Stop>> + 's>> {
        Box::pin(async move {
            let Some((first, rest)) = steps.split_first() else { return Ok(paths) };
            let TraversalStep::Edge(step) = first else {
                return Err(Stop::Thrown(Failure::unsupported(&format!("'{}' hops over a synthesised node", step_type(first)), "")));
            };
            let mut reached = Vec::new();
            for (aliases, binding) in paths {
                let edge = match &binding {
                    Binding::LazyWalk(walk) => {
                        reached.extend(continue_deferred(aliases, self.run_deferred_past(walk, steps).await?, None));
                        continue;
                    }
                    Binding::Landed(landed) => {
                        let onward = self.source_head_paths(&landed.position, landed.read.clone(), steps, scope, span).await.map_err(Stop::Thrown)?;
                        reached.extend(continue_deferred(aliases, onward, None));
                        continue;
                    }
                    Binding::Node(node) => {
                        let deferred = node.borrow().edges.iter().find(|(n, _)| *n == step.edge_type_id).and_then(|(_, e)| e.deferred.clone());
                        match deferred {
                            Some(walk) => PlaneEdge::Kept(walk),
                            None => PlaneEdge::Landed(node.borrow().landings(&step.edge_type_id)),
                        }
                    }
                    other => {
                        return Err(Stop::Thrown(Failure::unsupported(
                            &format!("hopping past a '{}' landing that is {}", step.edge_type_id, crate::record::describe(other)),
                            "traverse the edge into a block and walk on from the landing there",
                        )));
                    }
                };
                let landings = match edge {
                    PlaneEdge::Landed(landings) => landings,
                    kept => {
                        if step.expression_filter.is_some() {
                            return Err(Stop::Thrown(Failure::unsupported(
                                "WHERE filters on a lazy entry's hop",
                                "narrow the entry's own traversal instead — the WHERE belongs on the hop the node's edge is built from",
                            )));
                        }
                        if let (false, Some(alias)) = (rest.is_empty(), &step.alias) {
                            // The alias would name a position part-way through
                            // the merged walk, and the walk binds its own hops'
                            // aliases, not this one.
                            return Err(Stop::Thrown(Failure::unsupported(
                                &format!("naming a deferred edge's landing ('{alias}') while hopping past it"),
                                "drop the alias, or bind the deferred traversal above and traverse from there",
                            )));
                        }
                        let iterations = match kept {
                            PlaneEdge::Kept(walk) => self.run_deferred_past(&walk, rest).await?,
                            PlaneEdge::Landed(_) => unreachable!("taken above"),
                        };
                        reached.extend(continue_deferred(aliases, iterations, step.alias.as_deref()));
                        continue;
                    }
                };
                let mut next = Vec::new();
                for landing in landings {
                    if !self.hop_keeps_binding(step, &landing, scope, span).await.map_err(Stop::Thrown)? {
                        continue;
                    }
                    let mut aliases = aliases.clone();
                    if let Some(alias) = &step.alias {
                        aliases.push((alias.clone(), landing.clone()));
                    }
                    next.push((aliases, landing));
                }
                reached.extend(self.walk_node_plane(next, rest, scope, span).await?);
            }
            Ok(reached)
        })
    }

    /// Where a head walks from and through which graph (`headIterationsFrom`
    /// for a root that is an instance, a handle, the event or a record a walk
    /// landed on).
    async fn head_start(&self, binding: &Binding, root: &str) -> Result<(Js, Rc<Read>), Failure> {
        let (read, start) = match binding {
            Binding::Instance(instance) => (self.instance_read(instance).await?, meta_position(&instance.adapter_slug)),
            Binding::Handle(handle) => {
                // A handle that bound no record has no position to walk from.
                let external_id = handle.record().get("externalId");
                if matches!(external_id, Js::Undefined) {
                    return Err(Failure::engine(
                        "MOVENG_UNSUPPORTED",
                        format!("block heads rooted at '{root}' (a handle binding) is not supported by the movement engine yet"),
                    ));
                }
                let start = stable_position(handle.record().get("adapterType"), Js::str(handle.target_type.clone()), external_id, handle.record().get("resultData"));
                (self.instance_read(&handle.graph).await?, start)
            }
            Binding::Event => {
                let source = self.source.borrow().clone().expect("the event is seeded before the body runs");
                (source.read.clone(), source.position.to_js())
            }
            // A nested block: the hop off an enclosing block's landing, from
            // its own position, through the graph it was landed in.
            Binding::Landed(landed) => (landed.read.clone(), landed.position.clone()),
            _ => unreachable!("an adapter head is rooted at an instance, a handle, the event or a landing"),
        };
        Ok((start, read))
    }

    /// The records `FIRST`/`LAST`/`ONLY` of a bare walk picks from
    /// (`selectedPositionBinding`): the walk a block head takes.
    pub(crate) async fn selection_landings(&self, root: &str, step: &EdgeStep, scope: &Rc<Scope>, slot: &movement_parser::ast::ExprSlot) -> Result<Vec<Rc<Landed>>, Failure> {
        let span = env::js_of_serialized(&slot.span);
        let binding = scope.resolve(root).ok_or_else(|| Failure::engine("MOVENG_RUNTIME", format!("'{root}' is not in scope — the checker should have caught this")))?;
        let (start, read, _) = self.walk_start(root, &binding).await?;
        self.walk(&start, step, read, scope, &span).await
    }

    /// `instanceSourceRead`: the instance resolved as a source, once per
    /// (adapter, credential, construction arguments).
    pub(crate) async fn instance_read(&self, instance: &InstanceBinding) -> Result<Rc<Read>, Failure> {
        let adapter_type = instance.adapter_slug.clone();
        let credentials_id = instance.credential_name.as_deref().and_then(|name| self.credential_id(name));
        let construction_args: std::collections::BTreeMap<String, String> = instance
            .construction_config
            .iter()
            .filter(|(k, _)| k != "dry_run")
            .map(|(k, v)| (k.clone(), crate::write::unquote_construction_arg(v)))
            .collect();
        let key = format!("source::{}::{}::{:?}", instance.adapter_slug, credentials_id.as_deref().unwrap_or(""), construction_args);
        if let Some((_, cached)) = self.source_reads.borrow().iter().find(|(k, _)| *k == key) {
            return Ok(cached.clone());
        }
        let resolved = self
            .resolve_adapter(&ResolveAdapter {
                adapter_type,
                credentials_id,
                construction_args: (!construction_args.is_empty()).then_some(construction_args),
                role: Role::Source,
                dry_run: false,
            })
            .await?
            .unwrap_or(Json::Null);
        let handle = host::instance_of(&resolved).ok_or_else(|| Failure::engine("MOVENG_RUNTIME", format!("adapters.resolve answered {resolved}")))?;
        let read = Rc::new(Read::of_resolved(&resolved, handle, instance, None));
        self.source_reads.borrow_mut().push((key, read.clone()));
        Ok(read)
    }

    /// `walkSourceHeadPaths` for one hop from `start`.
    pub(crate) async fn walk(&self, start: &Js, step: &EdgeStep, read: Rc<Read>, scope: &Rc<Scope>, span: &Js) -> Result<Vec<Rc<Landed>>, Failure> {
        if step.direction == EdgeDirection::Incoming && !read.incoming {
            return Err(Failure::unsupported(
                &format!("incoming block-head hops ('{}')", step.edge_type_id),
                &format!("source adapter '{}' cannot traverse incoming edges", read.adapter_type),
            ));
        }
        let pushdown = self.pushdown_args(step, &read, scope, span).await;
        let kept = self.fetch(start, step, &read, Fetch { pushdown: &pushdown, paged: read.streams }, scope, span).await?;
        self.ordered(kept, step, scope, span).await
    }

    /// What one hop's fetch is asked beyond its edge (`closedHopPushdown`):
    /// its WHERE closed over the scope, its ORDER BY and LIMIT where they go
    /// with it.
    async fn pushdown_args(&self, step: &EdgeStep, read: &Read, scope: &Rc<Scope>, span: &Js) -> Vec<(String, Js)> {
        let pushdown = order_limit::hop_pushdown(step);
        let substitutions = self.closed_over(&pushdown, step, read, scope, span).await;
        pushdown.members(&substitutions)
    }

    /// One hop's fetch from `start`, through the read wrapper's `getRelated`
    /// or, `paged`, the instance's stream a page at a time; each record kept
    /// when it is a member the hop is about and its WHERE holds.
    async fn fetch(&self, start: &Js, step: &EdgeStep, read: &Rc<Read>, how: Fetch<'_>, scope: &Rc<Scope>, span: &Js) -> Result<Vec<Rc<Landed>>, Failure> {
        let Fetch { pushdown, paged } = how;
        let gate = member_gate(step, start, read);
        let mut args = vec![("fieldId", Js::str(step.edge_type_id.clone())), ("direction", Js::str(direction_text(step.direction)))];
        args.extend(pushdown.iter().map(|(k, v)| (k.as_str(), v.clone())));
        let mut kept = Vec::new();
        if paged {
            // The instance's stream, a page at a time (host_adapter.ts
            // `iterateRelated` over `iterateRelatedPage`): through no read
            // wrapper, as its Proxy forwards the stream untouched.
            let mut cursor: Option<Js> = None;
            let mut pages = 1;
            loop {
                let mut page_args = args.clone();
                if let Some(cursor) = &cursor {
                    page_args.push(("cursor", cursor.clone()));
                }
                let page = self.call_adapter_at(&read.instance, "iterateRelatedPage", start, page_args).await?;
                let next = get(&page, "nextCursor");
                if let Some(previous) = cursor.as_ref().filter(|_| !next.is_nullish())
                    && js::json_stringify(&next, 0) == js::json_stringify(previous, 0)
                {
                    return Err(Failure::Engine {
                        class: ErrorClass::Error,
                        message: format!(
                            "paged traversal: the page for cursor {} answered the same cursor again, so it would never end.",
                            js::json_stringify(previous, 0)
                        ),
                    });
                }
                for item in list_items(&get(&page, "items"))? {
                    self.keep(&mut kept, get(&item, "position"), &item, step, read, gate.as_ref(), scope, span).await?;
                }
                if next.is_nullish() {
                    break;
                }
                if pages >= MAX_RELATED_PAGES {
                    return Err(Failure::Engine {
                        class: ErrorClass::Error,
                        message: format!("paged traversal: still not exhausted after {MAX_RELATED_PAGES} pages; refusing to walk further."),
                    });
                }
                cursor = Some(next);
                pages += 1;
            }
        } else {
            for (position, item) in self.related_items(start, step, read, args).await? {
                self.keep(&mut kept, position, &item, step, read, gate.as_ref(), scope, span).await?;
            }
        }
        Ok(kept)
    }

    /// The read wrapper's `getRelated`, each record answered restamped: a
    /// hop off the meta root is a collection scan, its records stamped with
    /// the collection's target; any other is stamped from its origin's
    /// natural type.
    async fn related_items(&self, start: &Js, step: &EdgeStep, read: &Rc<Read>, args: Vec<(&str, Js)>) -> Result<Vec<(Js, Js)>, Failure> {
        let schema = read.schema.as_ref();
        let (from, landed_type) = if record_type(start).as_deref() == Some("meta") {
            (start.clone(), schema.and_then(|s| s.collections.get(&step.edge_type_id)).map(|c| c.target.clone()))
        } else {
            let surface = record_type(start).or_else(|| read.start_surface_type.clone());
            let from = restamp(start, surface.as_deref(), &read.adapter_type);
            (from, landed_surface_type(schema, surface.as_deref(), &step.edge_type_id, step.direction))
        };
        let related = self.call_adapter_at(&read.instance, "getRelated", &from, args).await?;
        let mut items = Vec::new();
        for item in list_items(&related)? {
            let position = get(&item, "position");
            let natural = stamped_position_name(schema, &position).or_else(|| landed_type.clone());
            items.push((restamp(&position, natural.as_deref(), &read.adapter_type), item));
        }
        Ok(items)
    }

    /// `stepExistsCursor` from a record in a graph: the hop's `getRelated`
    /// with its pushdown, every record it answered (the gate and the WHERE
    /// are the caller's).
    pub(crate) async fn related(&self, start: &Js, step: &EdgeStep, read: &Rc<Read>, scope: &Rc<Scope>, span: &Js) -> Result<Vec<Rc<Landed>>, Failure> {
        let pushdown = self.pushdown_args(step, read, scope, span).await;
        let mut args = vec![("fieldId", Js::str(step.edge_type_id.clone())), ("direction", Js::str(direction_text(step.direction)))];
        args.extend(pushdown.iter().map(|(k, v)| (k.as_str(), v.clone())));
        Ok(self
            .related_items(start, step, read, args)
            .await?
            .into_iter()
            .map(|(position, item)| {
                let edge_properties = match get(&item, "edgeProperties") {
                    Js::Undefined => None,
                    properties => Some(properties),
                };
                Rc::new(Landed::new(position, edge_properties, read.clone()))
            })
            .collect())
    }

    /// ORDER BY / LIMIT over what one fetch kept (`applyHopOrderLimit`),
    /// each key read off its record (all at once, as `sortByOrderKey`'s
    /// `Promise.all` reads them).
    async fn ordered(&self, kept: Vec<Rc<Landed>>, step: &EdgeStep, scope: &Rc<Scope>, span: &Js) -> Result<Vec<Rc<Landed>>, Failure> {
        let cardinality = step.cardinality.as_ref();
        let keys = match cardinality.and_then(|c| c.order_by.as_deref()) {
            Some(key) => {
                let reads: Vec<_> = kept.iter().map(|landed| self.order_key(key, step, landed.clone(), scope, span)).collect();
                Some(join_all(reads).await.into_iter().collect::<Result<Vec<Js>, Failure>>()?)
            }
            None => None,
        };
        let plan = order_limit::apply_hop_order_limit(kept.len(), cardinality, keys.as_deref());
        Ok(plan.into_iter().map(|i| kept[i].clone()).collect())
    }

    /// One record the fetch answered: kept when it is a member the hop is
    /// about and its WHERE holds.
    #[allow(clippy::too_many_arguments)]
    async fn keep(
        &self,
        kept: &mut Vec<Rc<Landed>>,
        position: Js,
        item: &Js,
        step: &EdgeStep,
        read: &Rc<Read>,
        gate: Option<&MemberGate>,
        scope: &Rc<Scope>,
        span: &Js,
    ) -> Result<(), Failure> {
        if gate.is_some_and(|gate| !gate.admits(read.schema.as_ref(), &position)) {
            return Ok(());
        }
        let edge_properties = match get(item, "edgeProperties") {
            Js::Undefined => None,
            properties => Some(properties),
        };
        let landed = Rc::new(Landed::new(position, edge_properties, read.clone()));
        if let Some(filter) = step.expression_filter.as_deref()
            && !self.hop_keeps(filter, step, landed.clone(), scope, span).await?
        {
            return Ok(());
        }
        kept.push(landed);
        Ok(())
    }

    /// `closedHopPushdown`: each leaf of the pushed WHERE that names a
    /// scalar the hop's scope already holds, with that scalar. What reads
    /// the hop's own record stays a reference — its alias, a bare field, a
    /// bare name on an edge that can carry inline properties — as does
    /// anything not bound to a scalar, an ambient, and a read that fails
    /// here (the engine reads it again per record and reports it there).
    async fn closed_over<'s>(
        &self,
        pushdown: &order_limit::Pushdown<'s>,
        step: &EdgeStep,
        read: &Read,
        scope: &Rc<Scope>,
        span: &Js,
    ) -> Vec<Substitution<'s>> {
        let Some(where_) = pushdown.where_ else { return Vec::new() };
        let bound = |name: &str| -> Option<Js> {
            if step.alias.as_deref() == Some(name) {
                return None;
            }
            match scope.resolve(name) {
                Some(Binding::Value(value)) => order_limit::pushable_scalar(&value.value),
                _ => None,
            }
        };
        let mut substitutions = Vec::new();
        for leaf in crate::filter::pure_leaf_reads(where_).expect("a pushed WHERE is pure") {
            let value = match leaf {
                Expression::Meta { .. } => None,
                Expression::EdgeProperty { property_type_id } => if read.edge_properties { None } else { bound(property_type_id) },
                Expression::Property { property_type_id } => bound(property_type_id),
                Expression::AliasRef { name } => bound(name),
                Expression::Traverse { alias_root, .. } => match alias_root {
                    Some(root) if step.alias.as_deref() != Some(root.as_str()) => {
                        match self.evaluate_in(leaf, scope, Some(span.clone()), None).await {
                            Ok(evaluated) => order_limit::pushable_scalar(&evaluated.value),
                            Err(_) => None,
                        }
                    }
                    _ => None,
                },
                _ => None,
            };
            if let Some(value) = value {
                substitutions.push(Substitution { leaf, value });
            }
        }
        substitutions
    }

    /// `hopFilterKeeps`: the WHERE over one landed record, the hop's alias
    /// naming it. A pure WHERE is decided a top-level conjunct at a time,
    /// each leaf read once when its conjunct is reached (`decidePurePredicate`:
    /// a false conjunct ends it, so no field it ruled out is read); any other
    /// is evaluated whole.
    async fn hop_keeps(&self, filter: &Expression, step: &EdgeStep, landed: Rc<Landed>, scope: &Rc<Scope>, span: &Js) -> Result<bool, Failure> {
        let at = self.landed_scope(step, &landed, scope);
        self.decides(filter, &at, Scoped::Landed(landed), span).await
    }

    /// `evalScopedFilter`, its answer's truthiness: a filter scoped at
    /// `subject`, a pure one decided a conjunct at a time.
    pub(crate) async fn decides(&self, filter: &Expression, at: &Rc<Scope>, subject: Scoped, span: &Js) -> Result<bool, Failure> {
        if crate::filter::pure_leaf_reads(filter).is_none() {
            return Ok(self.evaluate_scoped(filter, at, Some(span.clone()), Some(subject)).await.map_err(stopped)?.value.truthy());
        }
        let mut reads: HashMap<String, Js> = HashMap::new();
        let mut last = Js::Bool(true);
        for conjunct in crate::unique::and_conjuncts(filter) {
            for leaf in crate::filter::pure_leaf_reads(conjunct).expect("a conjunct of a pure predicate is pure") {
                let key = crate::filter::leaf_read_key(leaf);
                if !reads.contains_key(&key) {
                    let value = self.evaluate_scoped(leaf, at, Some(span.clone()), Some(subject.clone())).await.map_err(stopped)?.value;
                    reads.insert(key, value);
                }
            }
            let read = |name: &str| reads.get(name).cloned().unwrap_or(Js::Undefined);
            // The host's clock is asked once per conjunct that reaches a
            // `WITHIN` (expression.ts `decideWithClock`), not per `WITHIN`.
            let now: RefCell<Option<String>> = RefCell::new(None);
            let now = &now;
            let ask = |op: FilterOperator, l: Js, r: Js| -> crate::filter::Comparing<'_> {
                Box::pin(async move { self.compare(op, l, r, now).await })
            };
            last = crate::filter::evaluate_predicate_with(conjunct, &read, crate::filter::PredicateOptions { ask: Some(&ask), local: self.local_zone() })
                .await
                .map_err(|e| Failure::of_eval(e, "the Rust engine does not reproduce it"))?;
            if !last.truthy() {
                return Ok(false);
            }
        }
        Ok(last.truthy())
    }

    /// Where a walk off `name` starts, the graph it reads through, and what
    /// `name` is, for a message (`traverseFrom`'s cases).
    pub(crate) async fn walk_start(&self, name: &str, binding: &Binding) -> Result<(Js, Rc<Read>, String), Failure> {
        match binding {
            Binding::Event => {
                let source = self.source.borrow().clone().expect("the event is seeded before the body runs");
                Ok((source.position.to_js(), source.read.clone(), "the event position".into()))
            }
            Binding::Landed(landed) => Ok((landed.position.clone(), landed.read.clone(), "a traversed source record".into())),
            Binding::Instance(instance) => Ok((meta_position(&instance.adapter_slug), self.instance_read(instance).await?, format!("the '{name}' graph"))),
            Binding::Handle(handle) => {
                // `handleRecord`: a handle that bound no record has none to walk from.
                let external_id = handle.record().get("externalId");
                if matches!(external_id, Js::Undefined) {
                    return Err(Failure::unsupported(&format!("traversing from a write handle ('{name}')"), "the handle bound no readable record to traverse from"));
                }
                let start = stable_position(handle.record().get("adapterType"), Js::str(handle.target_type.clone()), external_id, handle.record().get("resultData"));
                Ok((start, self.instance_read(&handle.graph).await?, "a write handle".into()))
            }
            // A pick that found nothing (`top = FIRST(…)`, null).
            Binding::Value(_) => Err(Failure::unsupported(&format!("traversing from a value binding ('{name}')"), "source/handle traversal is E2 scope")),
            _ => Err(Failure::unreproduced(&format!("reading '{name}' in an expression"), "the Rust engine walks from the event, an instance, a handle or a landed record")),
        }
    }

    /// `walkAdapterPositions`: plain edge hops from `start`, each hop's
    /// pushdown closed over the scope once, each origin's fetch filtered,
    /// ordered and bounded on its own. No hops: the start itself.
    pub(crate) async fn walk_adapter(&self, start: &Js, read: &Rc<Read>, steps: &[TraversalStep], name: &str, scope: &Rc<Scope>, span: &Js) -> Result<Vec<Rc<Landed>>, Failure> {
        let mut landed = vec![Rc::new(Landed::new(start.clone(), None, read.clone()))];
        for step in steps {
            let TraversalStep::Edge(step) = step else {
                return Err(Failure::engine(
                    "MOVENG_UNSUPPORTED",
                    format!("'{}' hops in a traversal from '{name}' is not supported by the movement engine yet", step_type(step)),
                ));
            };
            if step.direction == EdgeDirection::Incoming && !read.incoming {
                return Err(Failure::unsupported(
                    &format!("incoming hops ('{}')", step.edge_type_id),
                    &format!("source adapter '{}' cannot traverse incoming edges", read.adapter_type),
                ));
            }
            let pushdown = self.pushdown_args(step, read, scope, span).await;
            let mut next = Vec::new();
            for cursor in &landed {
                let kept = self.fetch(&cursor.position, step, read, Fetch { pushdown: &pushdown, paged: false }, scope, span).await?;
                next.extend(self.ordered(kept, step, scope, span).await?);
            }
            landed = next;
            if landed.is_empty() {
                break;
            }
        }
        Ok(landed)
    }

    /// `collapse`: nothing read is null, one read is itself, several are
    /// their values, their trails unioned.
    pub(crate) fn collapse(&self, mut results: Vec<Evaluated>) -> Evaluated {
        match results.len() {
            0 => Evaluated { value: Js::Null, prov: Prov::Built(Trail::default()) },
            1 => results.remove(0),
            _ => {
                let mut origins: Vec<u32> = Vec::new();
                for result in &results {
                    let Prov::Built(trail) = &result.prov else { unreachable!("a walk's reads build their trails") };
                    for &origin in &trail.origins {
                        if !origins.contains(&origin) {
                            origins.push(origin);
                        }
                    }
                }
                Evaluated {
                    value: Js::array(results.into_iter().map(|r| r.value).collect()),
                    prov: Prov::Built(Trail { origins, direct: None }),
                }
            }
        }
    }

    /// `hopOrderKeyReader`: the hop's ORDER BY key over one landed record.
    async fn order_key(&self, key: &Expression, step: &EdgeStep, landed: Rc<Landed>, scope: &Rc<Scope>, span: &Js) -> Result<Js, Failure> {
        let at = self.landed_scope(step, &landed, scope);
        Ok(self.evaluate_in(key, &at, Some(span.clone()), Some(landed)).await.map_err(stopped)?.value)
    }

    /// The hop's own scope over one landed record: its alias names it.
    fn landed_scope(&self, step: &EdgeStep, landed: &Rc<Landed>, scope: &Rc<Scope>) -> Rc<Scope> {
        match &step.alias {
            Some(alias) => {
                let child = scope.child();
                child.declare(alias.clone(), Binding::Landed(landed.clone()));
                child
            }
            None => scope.clone(),
        }
    }

    /// The shared comparator for a reading `compare_values` hands back, in a
    /// pure predicate's decision; a `WITHIN` measures from `now`, the host's
    /// clock asked the first time the decision reaches one.
    pub(crate) async fn compare(
        &self,
        op: FilterOperator,
        left: Js,
        right: Js,
        now: &RefCell<Option<String>>,
    ) -> Result<bool, EvalError> {
        let within = matches!(op, FilterOperator::Within);
        if within && now.borrow().is_none() {
            let asked = self.clock_now().await.map_err(Failure::into_eval)?;
            *now.borrow_mut() = Some(js_date::to_iso_string(asked));
        }
        let request = self.compare_request_at(op, &left, &right, if within { now.borrow().clone() } else { None }.as_deref()).map_err(Failure::into_eval)?;
        let answer = self.ask(request).await.map_err(Failure::into_eval)?.unwrap_or(Json::Null);
        let value = answer
            .get("value")
            .and_then(|v| self.wire.decode(v).ok())
            .ok_or_else(|| EvalError::engine("MOVENG_RUNTIME", format!("the comparator answered {answer}")))?;
        Ok(value.truthy())
    }

    /// A name a position-scoped evaluation reads off its landed record
    /// (`case 'edge_property'` / `readScopedProperty`): for an edge
    /// property, the walked edge's inline property first, then a value
    /// binding of that name; then the record's field.
    pub(crate) async fn scoped_field(&self, landed: &Landed, field: &str, edge: bool, scope: &Scope) -> Result<Evaluated, Failure> {
        if edge {
            let inline = landed.edge_properties.as_ref().map_or(Js::Undefined, |p| get(p, field));
            if !matches!(inline, Js::Undefined) {
                return Ok(Evaluated { value: inline, prov: Prov::Built(Trail::default()) });
            }
            if let Some(Binding::Value(value)) = scope.resolve(field) {
                return Ok(Evaluated { value: value.value, prov: Prov::Built(value.trail.unwrap_or_default()) });
            }
        }
        self.landed_field(landed, field).await
    }

    /// `readSourcePositionField` for a landed record: the adapter's
    /// `getFieldValue` through the read wrapper, a `field_miss` traced for a
    /// field a raw-payload position does not carry, and the read's
    /// `source_field` origin.
    pub(crate) async fn landed_field(&self, landed: &Landed, field: &str) -> Result<Evaluated, Failure> {
        let read = &landed.read;
        let position = landed.surface.get_or_init(|| {
            if read.raw {
                return landed.position.clone();
            }
            let natural = record_type(&landed.position).or_else(|| read.start_surface_type.clone());
            restamp(&landed.position, natural.as_deref(), &read.adapter_type)
        });
        let value = self.call_adapter_at(&read.instance, "getFieldValue", position, vec![("fieldId", Js::str(field))]).await?;
        let stable = is_stable(&landed.position);
        if value.is_nullish() && !stable {
            self.trace_miss_in(&read.instance_name, &position_data(&landed.position), field);
        }
        let mut entries = vec![
            ("kind", Js::str("source_field")),
            ("instance", Js::str(read.instance_name.clone())),
            ("adapterType", Js::str(read.adapter_type.clone())),
        ];
        if stable && let Some(record_type) = record_type(&landed.position) {
            entries.push(("recordType", Js::str(record_type)));
        }
        let id = record_id(&landed.position);
        if !matches!(id, Js::Undefined) {
            entries.push(("externalId", id));
        }
        entries.push(("field", Js::str(field)));
        let origin = self.mint_origin(env::object_of(entries));
        Ok(Evaluated { value, prov: Prov::Built(Trail { origins: vec![origin], direct: Some(origin) }) })
    }

    /// An adapter method whose argument object leads with `position`, the
    /// position sent by handle (crate::host `call_at`): registered with the
    /// host the first time it is named, by its number after.
    pub(crate) async fn call_adapter_at(&self, instance: &Instance, method: &str, position: &Js, rest: Vec<(&str, Js)>) -> Result<Js, Failure> {
        let Js::Object(object) = position else {
            let mut args = vec![("position", position.clone())];
            args.extend(rest);
            return self.call_adapter(instance, method, env::object_of(args)).await;
        };
        let (reference, first) = self.positions.borrow_mut().register(object);
        let value = if first { Some(self.encode(position)?) } else { None };
        let arg = host::adapters::PositionArg { reference, value };
        let request = host::adapters::call_at(self.segment(), instance, method, arg, self.encode(&env::object_of(rest))?);
        self.adapter_answer(self.ask(request).await?)
    }
}

/// The positions a segment has named to its host, by handle number: empty
/// as a segment starts, never written into a park (a resumed run's segment
/// numbers its positions from 0 again). Each object is held, so its address
/// cannot be reused by another while the table looks it up by that address.
#[derive(Default)]
pub(crate) struct PositionTable {
    held: Vec<Rc<js::JsObject>>,
    by_address: HashMap<*const js::JsObject, u32>,
}

impl PositionTable {
    /// The object's handle, and whether this is the first time it is named.
    fn register(&mut self, object: &Rc<js::JsObject>) -> (u32, bool) {
        if let Some(&reference) = self.by_address.get(&Rc::as_ptr(object)) {
            return (reference, false);
        }
        let reference = self.held.len() as u32;
        self.held.push(object.clone());
        self.by_address.insert(Rc::as_ptr(object), reference);
        (reference, true)
    }
}

/// `describeHeadValue`.
fn describe_head_value(value: &Js) -> &'static str {
    match value {
        Js::Undefined | Js::Null => "nothing",
        Js::Array(_) => "a list",
        Js::String(_) => "text",
        Js::Number(_) => "a number",
        Js::Bool(_) => "true or false",
        _ => "a plain value",
    }
}

/// run.ts `blockValue`: values returned bind as the list of them, their
/// trails unioned; anything else (here: nothing returned) as the returned
/// records.
pub(crate) fn block_value(returned: Vec<Binding>) -> Binding {
    let values: Option<Vec<crate::env::ValueBinding>> =
        returned.iter().map(|b| if let Binding::Value(v) = b { Some(v.clone()) } else { None }).collect();
    match values {
        Some(values) if !values.is_empty() => {
            let mut origins: Vec<u32> = Vec::new();
            for value in &values {
                for &origin in value.trail.as_ref().map_or(&[][..], |t| &t.origins[..]) {
                    if !origins.contains(&origin) {
                        origins.push(origin);
                    }
                }
            }
            Binding::Value(crate::env::ValueBinding {
                value: Js::array(values.into_iter().map(|v| v.value).collect()),
                trail: Some(crate::env::Trail { origins, direct: None }),
                many: false,
            })
        }
        _ => Binding::Positions(returned),
    }
}

/// How one hop's fetch asks: what it pushes beyond its edge, and whether it
/// walks the instance's stream a page at a time (a block head's walk) or
/// asks `getRelated` once (an expression's).
#[derive(Clone, Copy)]
struct Fetch<'a> {
    pushdown: &'a [(String, Js)],
    paged: bool,
}

/// `walkExtractSteps`: plain hops down an extraction's result, each to the
/// children under that edge.
pub(crate) fn walk_extract(root: &Rc<Emission>, steps: &[TraversalStep], name: &str) -> Result<Vec<Rc<Emission>>, Failure> {
    let mut current = vec![root.clone()];
    for step in steps {
        let TraversalStep::Edge(step) = step else {
            return Err(Failure::engine(
                "MOVENG_UNSUPPORTED",
                format!("'{}' hops over the extract result ('{name}') is not supported by the movement engine yet", step_type(step)),
            ));
        };
        if step.expression_filter.is_some() {
            return Err(Failure::engine(
                "MOVENG_UNSUPPORTED",
                format!("WHERE filters on extract-result hops ('{name}') is not supported by the movement engine yet"),
            ));
        }
        current = current.iter().flat_map(|e| e.children_of(&step.edge_type_id).to_vec()).collect();
    }
    Ok(current)
}

/// A step's own `type`.
pub(crate) fn step_type(step: &TraversalStep) -> &'static str {
    match step {
        TraversalStep::Edge(_) => "edge",
        TraversalStep::LinkBack {} => "linkBack",
        TraversalStep::Resource(_) => "resource",
        TraversalStep::MetaEdge(_) => "meta_edge",
    }
}

/// A reading this engine hands back fails the run (a hop's WHERE or ORDER
/// BY never falls back: the run is this engine's).
fn stopped(stop: Stop) -> Failure {
    match stop {
        Stop::Thrown(failure) => failure,
        _ => unreachable!("an evaluation stops only by failing"),
    }
}
