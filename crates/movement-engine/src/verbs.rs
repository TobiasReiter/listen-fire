//! The record verbs beside `write`: run.ts's `executeMatch`, `executeLink`
//! (and version 1's `executeCriteriaLink`), `executeUnlinkStatement` and
//! `executeDeleteStatement`, for records in a system (a match among a node
//! this run built is admission's to refuse):
//!
//! - `x = match crm-[c:companies WHERE …]-> { unique by (…) … }`: the first
//!   half of a write — the target, the fields, the identity, the shortlist
//!   narrowed by the target's WHERE, the rules and the judge — binding what
//!   it found (its data read whole where the adapter can), never writing. A
//!   miss binds absent and the block carries on from version 4; before it
//!   ends the enclosing scope quietly (`ScopeEndedQuietly`: a fan-out's
//!   iteration skips, the movement's body stops, nothing fails);
//! - `link a -[:e]-> b`, `link a -[:e]-> { match body }` (from version 2 the
//!   match then the link; in version 1 a body without its own `unique by` is
//!   criteria, found and linked as one row) and `unlink a -[:e]-> b`: two
//!   handles in one graph, the edge checked against the from side's type,
//!   then `linkRecords` / `unlinkRecords` under the edge's lock;
//! - `delete x`: the record a handle or a traversed record stands on,
//!   through `deleteRecord` under the record's lock.
//!
//! Each lands on the firing record as the TypeScript's does: a match's row
//! as a write's (`recordWrite`), a link's, an unlink's and a delete's pushed
//! as they are.

use std::rc::Rc;

use movement_parser::ast::{LinkExpression, LinkTarget, MatchExpression, UnlinkStatement, WriteTarget};

use crate::bindings::{Binding, Handle, Scope};
use crate::env;
use crate::js::{self, Js, JsObject};
use crate::run::{Failure, Run, Stop};
use crate::unique;
use crate::write::{Line, Target, Verb, WriteRecord, Written, candidate_data, describe_binding, record_head, thrown};

fn merge_into(into: &mut JsObject, bag: &Js) {
    if let Js::Object(bag) = bag {
        for (k, v) in bag.entries() {
            into.set(k.clone(), v.clone());
        }
    }
}

/// A handle's write origin, summarised: the provenance a link's or a
/// delete's row carries for it (`summariseTrail(handleTrail(handle))`).
fn handle_provenance(handle: &Handle) -> Js {
    match handle.record().get("origin") {
        Js::Undefined => Js::array(vec![]),
        origin => Js::array(vec![crate::run::summarise(&origin)]),
    }
}

/// `edgeLock`.
fn edge_lock_name(adapter_type: &str, from_id: &Js, edge: &str, to_id: &Js) -> String {
    format!(
        "edge {} {} {} {}",
        js::json_quote(adapter_type),
        unique::lock_part(from_id),
        js::json_quote(edge),
        unique::lock_part(to_id)
    )
}

fn endpoint(record_type: &str, external_id: &Js) -> Js {
    env::object_of(vec![("recordType", Js::str(record_type)), ("externalId", external_id.clone())])
}

/// One edge between two records of one system, as `linkRecords` and
/// `unlinkRecords` are handed it.
struct Edge {
    adapter: Rc<crate::write::TargetAdapter>,
    name: String,
    from_type: String,
    from_id: Js,
    to_type: String,
    to_id: Js,
}

/// `MatchMissPolicy`: what a match that found nothing does.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum OnMiss {
    /// Version 4 on: the name binds absent and the block carries on.
    Absent,
    /// Before version 4 (and a link's body, which version 4 refuses): the
    /// enclosing scope ends quietly.
    EndScope,
}

/// A match's target as the author wrote it (`describeMatchTarget`).
pub(crate) fn describe_match_target(m: &MatchExpression) -> String {
    let spell = |path: &movement_parser::ast::PathHead| {
        let root = match &path.root {
            Some(movement_parser::ast::PathRoot::Name { name }) => name.as_str(),
            _ => "",
        };
        format!("{root}{}", path.hops_raw)
    };
    match &m.target {
        WriteTarget::Linked { path, .. } => spell(path),
        WriteTarget::Tuple { paths, .. } => format!("({})", paths.iter().map(spell).collect::<Vec<_>>().join(", ")),
        WriteTarget::Position { .. } => String::new(),
    }
}

/// `ResolvedLinkStatement`: the edge, and the two handles it joins.
struct LinkPlan {
    edge: Edge,
    from: Rc<Handle>,
    to: Rc<Handle>,
}

impl Run<'_> {
    /// What a match statement or a bound match does when it finds nothing.
    pub(crate) fn match_miss_policy(&self) -> OnMiss {
        if movement_parser::version::since(self.version(), 4) { OnMiss::Absent } else { OnMiss::EndScope }
    }

    /// `missed`: a match that found nothing binds absent, or ends the
    /// enclosing scope. Under `Absent`, a judge that never answered leaves a
    /// warning: "not found" is then a guess, and a program that creates on
    /// absent would duplicate.
    pub(crate) fn missed(&self, on_miss: OnMiss, binding_name: Option<&str>, scope: &Scope, reason: String, judge_unavailable: Option<String>) -> Result<Binding, Stop> {
        match on_miss {
            OnMiss::Absent => {
                if judge_unavailable.is_some() {
                    self.trace(crate::trace::TraceEntry::Warning {
                        code: "MOVENG_MATCH_JUDGE_UNAVAILABLE".into(),
                        message: format!("{reason}; the judge was unavailable, so the match was treated as finding nothing"),
                    });
                }
                let absent = Binding::Value(env::ValueBinding { value: Js::Null, trail: None, many: false });
                if let Some(name) = binding_name {
                    scope.declare(name, absent.clone());
                }
                Ok(absent)
            }
            OnMiss::EndScope => Err(Stop::EndedQuietly),
        }
    }

    /// `executeMatch`: the record found, bound as a handle (and returned:
    /// a link body links it).
    pub(crate) async fn match_record(&self, m: &MatchExpression, binding_name: Option<&str>, scope: &Rc<Scope>, on_miss: OnMiss) -> Result<Binding, Stop> {
        let at = format!("match {}", describe_match_target(m));
        // Among the landings of a node this run built.
        if let WriteTarget::Linked { path, .. } = &m.target
            && let Some(movement_parser::ast::PathRoot::Name { name }) = &path.root
            && let Some(Binding::Node(node)) = scope.resolve(name)
        {
            return self.local_match(m, path, node, binding_name, scope, &at, on_miss).await;
        }
        let resolved = self.write_target(&m.target, scope, Verb::Match).await?;
        let lines: Vec<Line> = m.fields.iter().map(Line::of).collect();
        let evaluated = self.write_fields(&lines, &resolved.adapter, &resolved.record_type, scope).await?;
        let handle_type = crate::write::discriminated_handle_type(resolved.graph.as_ref().and_then(|g| g.schema.as_ref()), &resolved.record_type, &evaluated.fields);
        let target = Target { handle_type, ..resolved };
        let identity = self.unique_by_identity(&m.unique_by, &target)?;
        let native = unique::get(&evaluated.descriptor, "uniquenessConstraints");
        let constraints = unique::merge(&native, identity.branches.clone());
        let resolve_record = self.identity_record(&evaluated.fields, &identity.overlay, &constraints, &target);
        let (matched, judge_unavailable) = self.resolve_identity(&target, &evaluated.fields, &resolve_record, &constraints, &identity.narrowings, scope).await?;
        let Some(matched) = matched else {
            let unavailable = judge_unavailable.as_ref().map(|j| format!(" (judge unavailable: {j})")).unwrap_or_default();
            let reason = format!("{at}: no existing {} matched{unavailable}", target.record_type);
            return self.missed(on_miss, binding_name, scope, reason, judge_unavailable);
        };
        let adapter = &target.adapter;
        let external_id = unique::get(&matched, "externalId");
        let mut data = candidate_data(&matched);
        if adapter.has("readRecord") {
            let current = self.read_record(adapter, &target.record_type, &external_id).await?;
            if current.truthy() {
                merge_into(&mut data, &current);
            }
        }
        let record_type = target.handle_type.clone().unwrap_or_else(|| target.record_type.clone());
        let mut record = JsObject::new();
        record.set("kind".into(), Js::str("match"));
        record.set("adapterType".into(), Js::str(adapter.adapter_type.clone()));
        record.set("recordType".into(), Js::str(record_type));
        // Nothing was created and nothing was sent, so nothing was committed.
        record.set("created".into(), Js::Bool(false));
        record.set("committed".into(), Js::Bool(false));
        record.set("externalId".into(), external_id);
        record.set("writtenValues".into(), Js::object(JsObject::new()));
        record.set("resultData".into(), Js::object(data));
        record.set("provenance".into(), Js::object(JsObject::new()));
        Ok(Binding::Handle(self.record_write(Written::plain(Js::object(record)), crate::write::Recorded { binding_name, scope, target: &target, provenance: &[], into: None })))
    }

    /// `readRecord {recordType, externalId}`.
    async fn read_record(&self, adapter: &crate::write::TargetAdapter, record_type: &str, external_id: &Js) -> Result<Js, Stop> {
        let read = env::object_of(vec![("recordType", Js::str(record_type)), ("externalId", external_id.clone())]);
        self.store_call(adapter, "readRecord", read).await.map_err(thrown)
    }

    /// `executeLink`.
    pub(crate) async fn link(&self, link: &LinkExpression, binding_name: Option<&str>, scope: &Rc<Scope>) -> Result<(), Stop> {
        if let Some(Binding::Node(node)) = scope.resolve(&link.from) {
            return match &link.to {
                LinkTarget::Match { .. } => Err(thrown(Failure::unsupported(
                    &format!("link {} -[:{}]-> {{ … }} on a node this run built", link.from, link.edge),
                    "the body would find among what the edge already holds — the checker should have caught this",
                ))),
                LinkTarget::Handle { name } => self.append_landing(&link.from, &link.edge, name, &node, scope),
            };
        }
        // Version 1's body form was its own statement: criteria find the
        // record and the link lands as one row. A body with an authored
        // `unique by` never parsed under version 1, and runs as the match it is.
        if let LinkTarget::Match { r#match, implied_identity } = &link.to {
            let authored = !implied_identity && !r#match.unique_by.is_empty();
            if !authored && self.version() < 2 {
                return self.criteria_link(link, r#match, binding_name, scope).await;
            }
        }
        let (to_name, to) = match &link.to {
            LinkTarget::Match { r#match, .. } => {
                // Version 4 refuses this form, so a miss here always ends
                // the scope.
                let found = self.match_record(r#match, binding_name, scope, OnMiss::EndScope).await?;
                (binding_name.unwrap_or("{ … }").to_string(), Some(found))
            }
            LinkTarget::Handle { name } => (name.clone(), scope.resolve(name)),
        };
        let at = format!("link {} -[:{}]-> {to_name}", link.from, link.edge);
        let plan = self.link_plan(&link.from, &link.edge, &to_name, to, scope, &at).await?;
        if !plan.edge.adapter.has("linkRecords") {
            return Err(thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!(
                    "{at}: the '{}' adapter cannot link two existing records (no linkRecords capability) — express the relationship as a linked write (write {}-[:{}]-> {{ … }}) instead",
                    plan.edge.adapter.adapter_type, link.from, link.edge
                ),
            )));
        }
        let linked = self.edge_call(&plan.edge, "linkRecords").await?;
        self.record_link(&plan, "link", unique::get(&linked, "created"));
        Ok(())
    }

    /// `executeUnlinkStatement`.
    pub(crate) async fn unlink(&self, statement: &UnlinkStatement, scope: &Rc<Scope>) -> Result<(), Stop> {
        let at = format!("unlink {} -[:{}]-> {}", statement.from, statement.edge, statement.to);
        let plan = self.link_plan(&statement.from, &statement.edge, &statement.to, scope.resolve(&statement.to), scope, &at).await?;
        if !plan.edge.adapter.has("unlinkRecords") {
            return Err(thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!(
                    "{at}: the '{}' adapter cannot sever a link between two existing records (no unlinkRecords capability)",
                    plan.edge.adapter.adapter_type
                ),
            )));
        }
        let unlinked = self.edge_call(&plan.edge, "unlinkRecords").await?;
        self.record_link(&plan, "unlink", unique::get(&unlinked, "removed"));
        Ok(())
    }

    /// `linkRecords` / `unlinkRecords {from, edgeName, to, mutationContext}`
    /// under the edge's lock.
    async fn edge_call(&self, edge: &Edge, method: &str) -> Result<Js, Stop> {
        let lock = edge_lock_name(&edge.adapter.adapter_type, &edge.from_id, &edge.name, &edge.to_id);
        let args = env::object_of(vec![
            ("from", endpoint(&edge.from_type, &edge.from_id)),
            ("edgeName", Js::str(edge.name.clone())),
            ("to", endpoint(&edge.to_type, &edge.to_id)),
            ("mutationContext", self.mutation_context.borrow().clone()),
        ]);
        self.with_locks(vec![crate::flow::LockRequest::exclusive(lock)], async { self.store_call(&edge.adapter, method, args).await.map_err(thrown) }).await
    }

    /// `recordLinkStatement`.
    fn record_link(&self, plan: &LinkPlan, kind: &str, changed: Js) {
        let edge = &plan.edge;
        let mut record = JsObject::new();
        record.set("kind".into(), Js::str(kind));
        record.set("adapterType".into(), Js::str(edge.adapter.adapter_type.clone()));
        record.set("recordType".into(), Js::str(edge.from_type.clone()));
        record.set("created".into(), changed);
        record.set("committed".into(), Js::Bool(!edge.adapter.dry));
        record.set("externalId".into(), edge.from_id.clone());
        record.set("writtenValues".into(), Js::object(JsObject::new()));
        record.set(
            "link".into(),
            env::object_of(vec![
                ("edgeName", Js::str(edge.name.clone())),
                ("toRecordType", Js::str(edge.to_type.clone())),
                ("toExternalId", edge.to_id.clone()),
            ]),
        );
        record.set(
            "provenance".into(),
            env::object_of(vec![("from", handle_provenance(&plan.from)), ("to", handle_provenance(&plan.to))]),
        );
        self.append_write(Rc::new(WriteRecord { object: Js::object(record) }));
    }

    /// `resolveLinkStatement`: two handles in one graph, the edge the from
    /// side's type declares (where the schema declares the type), and both
    /// records' ids.
    async fn link_plan(&self, from_name: &str, edge: &str, to_name: &str, to: Option<Binding>, scope: &Rc<Scope>, at: &str) -> Result<LinkPlan, Stop> {
        let from = endpoint_handle(from_name, scope.resolve(from_name), at)?;
        let to = endpoint_handle(to_name, to, at)?;
        let graph = from.graph.clone();
        if !Rc::ptr_eq(&to.graph, &graph) {
            return Err(thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!(
                    "{at}: both handles must live in the same graph — '{from_name}' is in '{}' and '{to_name}' is in '{}'",
                    graph.name, to.graph.name
                ),
            )));
        }
        let from_position = graph.schema.as_ref().and_then(|s| s.positions.0.get(&from.target_type));
        let declared = from_position.and_then(|p| p.edges.0.get(edge));
        if from_position.is_some() && declared.is_none() {
            return Err(thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("{at}: '{edge}' is not a declared edge of {} — the edge resolves against the from-side's type", from.target_type),
            )));
        }
        if let Some(declared) = declared
            && declared.polymorphic != Some(true)
            && declared.target != to.target_type
        {
            return Err(thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("{at}: '{edge}' connects {} to {}, but '{to_name}' is a {} handle", from.target_type, declared.target, to.target_type),
            )));
        }
        let (from_id, to_id) = (from.record().get("externalId"), to.record().get("externalId"));
        if matches!(from_id, Js::Undefined) || matches!(to_id, Js::Undefined) {
            let missing = if matches!(from_id, Js::Undefined) { from_name } else { to_name };
            return Err(thrown(Failure::engine("MOVENG_RUNTIME", format!("{at}: '{missing}' carries no written record id to link"))));
        }
        let adapter = self.target_adapter(&graph).await?;
        let edge = Edge { adapter, name: edge.to_string(), from_type: from.target_type.clone(), from_id, to_type: to.target_type.clone(), to_id };
        Ok(LinkPlan { edge, from, to })
    }

    /// `executeCriteriaLink` (version 1): the body's fields are criteria
    /// only, merged with the found type's native rules; the record found is
    /// linked and bound, and the run log gets the link alone.
    async fn criteria_link(&self, link: &LinkExpression, body: &MatchExpression, binding_name: Option<&str>, scope: &Rc<Scope>) -> Result<(), Stop> {
        let at = format!("link {} -[:{}]-> {{ … }}", link.from, link.edge);
        let from = endpoint_handle(&link.from, scope.resolve(&link.from), &at)?;
        let graph = from.graph.clone();
        let explicit = match &body.target {
            WriteTarget::Linked { explicit_type, .. } => explicit_type.as_deref(),
            _ => None,
        };
        let record_type = crate::write::infer_linked_type(graph.schema.as_ref(), &from.target_type, &link.edge, explicit, &link.from, Verb::Link)?;
        let from_id = from.record().get("externalId");
        if matches!(from_id, Js::Undefined) {
            return Err(thrown(Failure::engine("MOVENG_RUNTIME", format!("{at}: '{}' carries no written record id to link", link.from))));
        }
        let adapter = self.target_adapter(&graph).await?;
        let mut criteria = JsObject::new();
        for field in &body.fields {
            let value = self.evaluate_slot(&field.value, scope).await?.value;
            if !matches!(value, Js::Undefined) {
                criteria.set(field.name.clone(), value);
            }
        }
        let keys: Vec<(String, bool)> = criteria.entries().iter().map(|(k, _)| (k.clone(), false)).collect();
        let criteria = Js::object(criteria);
        let descriptor = self.store_call(&adapter, "describe", env::object_of(vec![("typeId", Js::str(record_type.clone()))])).await.map_err(thrown)?;
        let authored = if keys.is_empty() { Vec::new() } else { vec![unique::branch(keys)] };
        let constraints = unique::merge(&unique::get(&descriptor, "uniquenessConstraints"), authored);
        let target = crate::write::Target::bare(adapter.clone(), record_type.clone(), graph.clone());
        let (matched, _) = self.resolve_identity(&target, &criteria, &criteria, &constraints, &[], scope).await?;
        let Some(matched) = matched else { return Err(Stop::EndedQuietly) };
        if !adapter.has("linkRecords") {
            return Err(thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("{at}: the '{}' adapter cannot link two existing records (no linkRecords capability)", adapter.adapter_type),
            )));
        }
        let to_id = unique::get(&matched, "externalId");
        let edge = Edge {
            adapter: adapter.clone(),
            name: link.edge.clone(),
            from_type: from.target_type.clone(),
            from_id: from_id.clone(),
            to_type: record_type.clone(),
            to_id: to_id.clone(),
        };
        let linked = self.edge_call(&edge, "linkRecords").await?;
        let mut data = candidate_data(&matched);
        if adapter.has("readRecord") {
            let current = self.read_record(&adapter, &record_type, &to_id).await?;
            if current.truthy() {
                merge_into(&mut data, &current);
            }
        }
        let write_index = self.writes.borrow().len();
        let mut record = JsObject::new();
        record.set("kind".into(), Js::str("link"));
        record.set("adapterType".into(), Js::str(adapter.adapter_type.clone()));
        record.set("recordType".into(), Js::str(from.target_type.clone()));
        record.set("created".into(), unique::get(&linked, "created"));
        record.set("committed".into(), Js::Bool(!adapter.dry));
        record.set("externalId".into(), from_id);
        record.set("writtenValues".into(), Js::object(JsObject::new()));
        record.set(
            "link".into(),
            env::object_of(vec![
                ("edgeName", Js::str(link.edge.clone())),
                ("toRecordType", Js::str(record_type.clone())),
                ("toExternalId", to_id.clone()),
                ("foundTarget", Js::Bool(true)),
            ]),
        );
        // The to side was found, not written: no write origin to chain.
        record.set("provenance".into(), env::object_of(vec![("from", handle_provenance(&from)), ("to", Js::array(vec![]))]));
        if let Some(name) = binding_name {
            record.set("bindingName".into(), Js::str(name));
        }
        self.append_write(Rc::new(WriteRecord { object: Js::object(record) }));
        if let Some(name) = binding_name {
            let mut handle = record_head(&adapter, &record_type, false, !adapter.dry, to_id.clone());
            handle.set("writtenValues".into(), Js::object(JsObject::new()));
            handle.set("resultData".into(), Js::object(data));
            handle.set("provenance".into(), Js::object(JsObject::new()));
            handle.set(
                "origin".into(),
                env::object_of(vec![("kind", Js::str("write")), ("writeIndex", Js::Number(write_index as f64)), ("externalId", to_id)]),
            );
            let handle = Handle::new(Rc::new(WriteRecord { object: Js::object(handle) }), crate::bindings::Old::Nothing, record_type, graph);
            scope.declare(name, Binding::Handle(Rc::new(handle)));
        }
        Ok(())
    }

    /// `executeDeleteStatement`.
    pub(crate) async fn delete(&self, name: &str, scope: &Rc<Scope>) -> Result<(), Stop> {
        let at = format!("delete {name}");
        let binding = scope.resolve(name);
        let crate::write::PositionTarget { target, external_id, .. } = self.position_target(name, scope, "delete").await?;
        let adapter = &target.adapter;
        if !adapter.has("deleteRecord") {
            return Err(thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("{at}: the '{}' adapter cannot delete records (no deleteRecord capability)", adapter.adapter_type),
            )));
        }
        let args = env::object_of(vec![
            ("recordType", Js::str(target.record_type.clone())),
            ("externalId", external_id.clone()),
            ("mutationContext", self.mutation_context.borrow().clone()),
        ]);
        let lock = unique::record_lock_name(&adapter.adapter_type, &external_id);
        self.with_locks(vec![crate::flow::LockRequest::exclusive(lock)], async { self.store_call(adapter, "deleteRecord", args).await.map_err(thrown) }).await?;
        let mut record = JsObject::new();
        record.set("kind".into(), Js::str("delete"));
        record.set("adapterType".into(), Js::str(adapter.adapter_type.clone()));
        record.set("recordType".into(), Js::str(target.record_type.clone()));
        record.set("created".into(), Js::Bool(false));
        record.set("committed".into(), Js::Bool(!adapter.dry));
        record.set("externalId".into(), external_id);
        record.set("writtenValues".into(), Js::object(JsObject::new()));
        let provenance = match &binding {
            Some(Binding::Handle(handle)) => env::object_of(vec![("record", handle_provenance(handle))]),
            _ => Js::object(JsObject::new()),
        };
        record.set("provenance".into(), provenance);
        self.append_write(Rc::new(WriteRecord { object: Js::object(record) }));
        Ok(())
    }
}

/// `resolveEdgeEndpoint`: a link's endpoints are written handles.
fn endpoint_handle(name: &str, binding: Option<Binding>, at: &str) -> Result<Rc<Handle>, Stop> {
    match binding {
        None => Err(thrown(Failure::engine("MOVENG_RUNTIME", format!("'{name}' is not in scope — the checker should have caught this")))),
        Some(Binding::Handle(handle)) => Ok(handle),
        Some(other) => Err(thrown(Failure::engine(
            "MOVENG_RUNTIME",
            format!("{at}: link statements connect written handles — '{name}' is {}", describe_binding(&other)),
        ))),
    }
}
