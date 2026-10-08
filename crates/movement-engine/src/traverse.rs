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
//! Bodies run sequentially, as the TypeScript's do. A body may not park or
//! suspend (admission refuses it): nothing here joins parked iterations.

use std::collections::HashMap;
use std::rc::Rc;

use movement_parser::ast::{PathHead, PathRoot, TraversalBlock};
use movement_parser::catalog::types::InstanceSchema;
use movement_parser::lowering::expression::{EdgeDirection, EdgeStep, Expression, TraversalStep};
use serde_json::Value as Json;

use crate::address::Address;
use crate::bindings::{Binding, InstanceBinding, Landed, Scope};
use crate::env::{self, Trail};
use crate::eval::{ErrorClass, EvalError, Evaluated, Prov};
use crate::executor::join_all;
use crate::host::{self, Instance, ResolveAdapter, Role};
use crate::js::{self, Js};
use crate::order_limit::{self, Substitution};
use crate::run::{Failure, Flow, Run, Stop};
use crate::trace::TraceEntry;
use crate::unique::get;
use crate::write::spell_name;

/// The most pages one traversal walks (adapter.ts `MAX_RELATED_PAGES`).
const MAX_RELATED_PAGES: usize = 10_000;

/// A graph a walk reads through (expression.ts `SourceRead`): the instance,
/// what the read wrapper needs to name its positions, and what the instance
/// said it can do.
#[derive(Debug)]
pub struct Read {
    pub instance: Instance,
    /// The live adapter's own `adapterType`.
    pub adapter_type: String,
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
        }
    }
}

// ── Positions, as translation_graph/types.ts reads and makes them ──

fn record_type(position: &Js) -> Option<String> {
    match get(position, "recordType") {
        Js::String(text) => Some(text),
        _ => None,
    }
}

fn is_stable(position: &Js) -> bool {
    matches!(get(&get(position, "identity"), "kind"), Js::String(kind) if kind == "stable")
}

/// `positionRecordId`.
fn record_id(position: &Js) -> Js {
    if is_stable(position) { get(&get(position, "identity"), "recordId") } else { Js::Undefined }
}

/// `positionData`.
pub(crate) fn position_data(position: &Js) -> Js {
    get(&get(position, "identity"), "data")
}

fn stable_position(adapter_type: Js, record_type: Js, record_id: Js, data: Js) -> Js {
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
fn meta_position(adapter_slug: &str) -> Js {
    unstable_position(Js::str(adapter_slug), Js::str("meta"), Js::Undefined)
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

/// The member a narrowed polymorphic hop is about (`hopSelection`): the
/// type its records carry, and the hop's declared target.
struct MemberGate {
    member_type: String,
    declared_target: String,
}

/// `hopMemberGate`: a record of another member than the one a WHERE
/// narrowed the hop to is not a match.
fn member_gate(step: &EdgeStep, origin: &Js, read: &Read) -> Option<MemberGate> {
    let filter = step.expression_filter.as_deref()?;
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
    fn admits(&self, schema: Option<&InstanceSchema>, landed: &Js) -> bool {
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
        Js::Array(list) => Ok(list.items.clone()),
        other => Err(Failure::engine("MOVENG_RUNTIME", format!("a traversal answered {} where a list of records was due", other.type_of()))),
    }
}

impl Run<'_> {
    /// `interpretBlock` for an unbound block whose head walks one hop.
    pub(crate) async fn block(&self, block: &TraversalBlock, scope: &Rc<Scope>, at: &Address, path: &str) -> Result<Flow, Stop> {
        let step = head_step(&block.head)
            .map_err(|e| Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("invalid block head (the checker should have caught this): {e}"))))?;
        let span = env::js_of_serialized(&block.head.span);
        let landings = self.head_landings(&block.head, &step, scope, &span).await.map_err(Stop::Thrown)?;
        self.trace(TraceEntry::Block { root: spell_path_head(&block.head), positions: landings.len() });
        let body = format!("{path}/block/body");
        for (index, landed) in landings.into_iter().enumerate() {
            // Per-landing isolation: an iteration's bindings never reach the
            // next, and the only way a value leaves one is its `return`,
            // which an unbound block has nowhere to put.
            let iteration = scope.child();
            if let Some(alias) = &step.alias {
                iteration.declare(alias.clone(), Binding::Landed(landed));
            }
            self.body(&block.body, &iteration, &at.iter(index), &body, 0).await?;
        }
        Ok(Flow::FellThrough)
    }

    /// The head's landings (`headIterationsFrom` for a root that is an
    /// instance, a handle or the event).
    async fn head_landings(&self, head: &PathHead, step: &EdgeStep, scope: &Rc<Scope>, span: &Js) -> Result<Vec<Rc<Landed>>, Failure> {
        let Some(PathRoot::Name { name }) = &head.root else {
            unreachable!("admission refuses a head that is not rooted at a name")
        };
        let (read, start) = match scope.resolve(name) {
            Some(Binding::Instance(instance)) => (self.instance_read(&instance).await?, meta_position(&instance.adapter_slug)),
            Some(Binding::Handle(handle)) => {
                // A handle that bound no record has no position to walk from.
                let external_id = handle.record.get("externalId");
                if matches!(external_id, Js::Undefined) {
                    return Err(Failure::engine(
                        "MOVENG_UNSUPPORTED",
                        format!("block heads rooted at '{}' (a handle binding) is not supported by the movement engine yet", spell_name(name)),
                    ));
                }
                let start = stable_position(handle.record.get("adapterType"), Js::str(handle.target_type.clone()), external_id, handle.record.get("resultData"));
                (self.instance_read(&handle.graph).await?, start)
            }
            Some(Binding::Event) => {
                let source = self.source.borrow().clone().expect("the event is seeded before the body runs");
                (source.read.clone(), source.position.to_js())
            }
            _ => unreachable!("admission roots a head at an instance, a handle or the event"),
        };
        self.walk(&start, step, read, scope, span).await
    }

    /// `instanceSourceRead`: the instance resolved as a source, once per
    /// (adapter, credential, construction arguments).
    async fn instance_read(&self, instance: &InstanceBinding) -> Result<Rc<Read>, Failure> {
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
            .ask(host::adapters::resolve(self.segment(), &ResolveAdapter {
                adapter_type: instance.adapter_slug.clone(),
                credentials_id,
                construction_args: (!construction_args.is_empty()).then_some(construction_args),
                role: Role::Source,
                dry_run: false,
            }))
            .await?
            .unwrap_or(Json::Null);
        let handle = host::instance_of(&resolved).ok_or_else(|| Failure::engine("MOVENG_RUNTIME", format!("adapters.resolve answered {resolved}")))?;
        let read = Rc::new(Read::of_resolved(&resolved, handle, instance, None));
        self.source_reads.borrow_mut().push((key, read.clone()));
        Ok(read)
    }

    /// `walkSourceHeadPaths` for one hop from `start`.
    async fn walk(&self, start: &Js, step: &EdgeStep, read: Rc<Read>, scope: &Rc<Scope>, span: &Js) -> Result<Vec<Rc<Landed>>, Failure> {
        if step.direction == EdgeDirection::Incoming && !read.incoming {
            return Err(Failure::unsupported(
                &format!("incoming block-head hops ('{}')", step.edge_type_id),
                &format!("source adapter '{}' cannot traverse incoming edges", read.adapter_type),
            ));
        }
        let pushdown = order_limit::hop_pushdown(step);
        let substitutions = self.closed_over(&pushdown, step, &read, scope, span).await;
        let gate = member_gate(step, start, &read);
        let mut args = vec![("fieldId", Js::str(step.edge_type_id.clone())), ("direction", Js::str(direction_text(step.direction)))];
        let members = pushdown.members(&substitutions);
        args.extend(members.iter().map(|(k, v)| (k.as_str(), v.clone())));
        let mut kept = Vec::new();
        if read.streams {
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
                    self.keep(&mut kept, get(&item, "position"), &item, step, &read, gate.as_ref(), scope, span).await?;
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
            // The read wrapper's `getRelated`: a hop off the meta root is a
            // collection scan, its records stamped with the collection's
            // target; any other is stamped from its origin's natural type.
            let schema = read.schema.as_ref();
            let (from, landed_type) = if record_type(start).as_deref() == Some("meta") {
                (start.clone(), schema.and_then(|s| s.collections.get(&step.edge_type_id)).map(|c| c.target.clone()))
            } else {
                let surface = record_type(start).or_else(|| read.start_surface_type.clone());
                let from = restamp(start, surface.as_deref(), &read.adapter_type);
                (from, landed_surface_type(schema, surface.as_deref(), &step.edge_type_id, step.direction))
            };
            let related = self.call_adapter_at(&read.instance, "getRelated", &from, args).await?;
            for item in list_items(&related)? {
                let position = get(&item, "position");
                let natural = stamped_position_name(schema, &position).or_else(|| landed_type.clone());
                let position = restamp(&position, natural.as_deref(), &read.adapter_type);
                self.keep(&mut kept, position, &item, step, &read, gate.as_ref(), scope, span).await?;
            }
        }
        // ORDER BY / LIMIT over what was kept, each key read off its record
        // (all at once, as `sortByOrderKey`'s `Promise.all` reads them).
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
        if crate::filter::pure_leaf_reads(filter).is_none() {
            return Ok(self.evaluate_in(filter, &at, Some(span.clone()), Some(landed)).await.map_err(stopped)?.value.truthy());
        }
        let mut reads: HashMap<String, Js> = HashMap::new();
        let mut last = Js::Bool(true);
        for conjunct in crate::unique::and_conjuncts(filter) {
            for leaf in crate::filter::pure_leaf_reads(conjunct).expect("a conjunct of a pure predicate is pure") {
                let key = crate::filter::leaf_read_key(leaf);
                if !reads.contains_key(&key) {
                    let value = self.evaluate_in(leaf, &at, Some(span.clone()), Some(landed.clone())).await.map_err(stopped)?.value;
                    reads.insert(key, value);
                }
            }
            let read = |name: &str| reads.get(name).cloned().unwrap_or(Js::Undefined);
            let ask = |op: movement_parser::lowering::expression::FilterOperator, l: Js, r: Js| -> crate::filter::Comparing<'_> {
                Box::pin(async move { self.compare(op, l, r).await })
            };
            last = crate::filter::evaluate_predicate_with(conjunct, &read, Some(&ask))
                .await
                .map_err(|e| Failure::of_eval(e, "the Rust engine does not reproduce it"))?;
            if !last.truthy() {
                return Ok(false);
            }
        }
        Ok(last.truthy())
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

    /// The shared comparator for a reading `compare_values` hands back.
    async fn compare(&self, op: movement_parser::lowering::expression::FilterOperator, left: Js, right: Js) -> Result<bool, EvalError> {
        let op = serde_json::to_value(op).expect("an operator is JSON");
        let request = host::builtins::compare(op.as_str().unwrap_or_default(), env::encode_plain(&left), env::encode_plain(&right));
        let answer = self.ask(request).await.map_err(Failure::into_eval)?.unwrap_or(Json::Null);
        let value = answer
            .get("value")
            .and_then(|v| env::decode(v).ok())
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
        let value = first.then(|| env::encode_plain(position));
        let arg = host::adapters::PositionArg { reference, value };
        let request = host::adapters::call_at(self.segment(), instance, method, arg, env::encode_plain(&env::object_of(rest)));
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

/// A reading this engine hands back fails the run (a hop's WHERE or ORDER
/// BY never falls back: the run is this engine's).
fn stopped(stop: Stop) -> Failure {
    match stop {
        Stop::Thrown(failure) => failure,
        _ => unreachable!("an evaluation stops only by failing"),
    }
}
