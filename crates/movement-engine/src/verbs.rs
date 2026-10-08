//! The record verbs beside `write`: run.ts's `executeMatch`, `executeLink`
//! (and version 1's `executeCriteriaLink`), `executeUnlinkStatement` and
//! `executeDeleteStatement`, for records in a system (a match among a node
//! this run built is admission's to refuse):
//!
//! - `x = match crm-[c:companies WHERE …]-> { unique by (…) … }`: the first
//!   half of a write — the target, the fields, the identity, the shortlist
//!   narrowed by the target's WHERE, the rules and the judge — binding what
//!   it found (its data read whole where the adapter can), never writing. A
//!   miss ends the enclosing scope quietly (`ScopeEndedQuietly`: a fan-out's
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
use crate::write::{Line, Target, Verb, WriteRecord, describe_binding, record_head, thrown};

/// A record's `{url?, ...data}` (`writeResultData` over a candidate).
fn candidate_data(candidate: &Js) -> JsObject {
    let mut data = JsObject::new();
    let url = unique::get(candidate, "url");
    if !matches!(url, Js::Undefined) {
        data.set("url".into(), url);
    }
    merge_into(&mut data, &unique::get(candidate, "data"));
    data
}

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
    match handle.record.get("origin") {
        Js::Undefined => Js::array(vec![]),
        origin => Js::array(vec![crate::run::summarise(&origin)]),
    }
}

/// `edgeLock`.
fn edge_lock_name(adapter_type: &str, from_id: &Js, edge: &str, to_id: &Js) -> String {
    format!(
        "edge {} {} {} {}",
        js::json_quote(adapter_type),
        js::json_quote(&from_id.to_js_string()),
        js::json_quote(edge),
        js::json_quote(&to_id.to_js_string())
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

/// `ResolvedLinkStatement`: the edge, and the two handles it joins.
struct LinkPlan {
    edge: Edge,
    from: Rc<Handle>,
    to: Rc<Handle>,
}

impl Run<'_> {
    /// `executeMatch`: the record found, bound as a handle (and returned:
    /// a link body links it).
    pub(crate) async fn match_record(&self, m: &MatchExpression, binding_name: Option<&str>, scope: &Rc<Scope>) -> Result<Rc<Handle>, Stop> {
        let resolved = self.write_target(&m.target, scope, Verb::Match).await?;
        let lines: Vec<Line> = m.fields.iter().map(Line::of).collect();
        let evaluated = self.write_fields(&lines, &resolved.adapter, &resolved.record_type, scope).await?;
        let handle_type = crate::write::discriminated_handle_type(resolved.graph.schema.as_ref(), &resolved.record_type, &evaluated.fields);
        let target = Target { handle_type, ..resolved };
        let identity = self.unique_by_identity(&m.unique_by, &target)?;
        let native = unique::get(&evaluated.descriptor, "uniquenessConstraints");
        let constraints = unique::merge(&native, identity.branches.clone());
        let resolve_record = self.identity_record(&evaluated.fields, &identity.overlay, &constraints, &target);
        let (matched, _) = self.resolve_identity(&target, &evaluated.fields, &resolve_record, &constraints, &identity.narrowings, scope).await?;
        // A miss ends the enclosing scope (`ScopeEndedQuietly`, whose message
        // nothing reads).
        let Some(matched) = matched else { return Err(Stop::EndedQuietly) };
        let adapter = &target.adapter;
        let external_id = unique::get(&matched, "externalId");
        let mut data = candidate_data(&matched);
        if adapter.instance.has("readRecord") {
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
        Ok(self.record_write(Js::object(record), binding_name, scope, &target, &[]))
    }

    /// `readRecord {recordType, externalId}`.
    async fn read_record(&self, adapter: &crate::write::TargetAdapter, record_type: &str, external_id: &Js) -> Result<Js, Stop> {
        let read = env::object_of(vec![("recordType", Js::str(record_type)), ("externalId", external_id.clone())]);
        self.call_adapter(&adapter.instance, "readRecord", read).await.map_err(thrown)
    }

    /// `executeLink`.
    pub(crate) async fn link(&self, link: &LinkExpression, binding_name: Option<&str>, scope: &Rc<Scope>) -> Result<(), Stop> {
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
                let found = self.match_record(r#match, binding_name, scope).await?;
                (binding_name.unwrap_or("{ … }").to_string(), Some(Binding::Handle(found)))
            }
            LinkTarget::Handle { name } => (name.clone(), scope.resolve(name)),
        };
        let at = format!("link {} -[:{}]-> {to_name}", link.from, link.edge);
        let plan = self.link_plan(&link.from, &link.edge, &to_name, to, scope, &at).await?;
        if !plan.edge.adapter.instance.has("linkRecords") {
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
        if !plan.edge.adapter.instance.has("unlinkRecords") {
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
        self.with_locks(vec![lock], async { self.call_adapter(&edge.adapter.instance, method, args).await.map_err(thrown) }).await
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
        self.writes.borrow_mut().push(Rc::new(WriteRecord { object: Js::object(record) }));
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
        let (from_id, to_id) = (from.record.get("externalId"), to.record.get("externalId"));
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
        let from_id = from.record.get("externalId");
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
        let descriptor = self.call_adapter(&adapter.instance, "describe", env::object_of(vec![("typeId", Js::str(record_type.clone()))])).await.map_err(thrown)?;
        let authored = if keys.is_empty() { Vec::new() } else { vec![unique::branch(keys)] };
        let constraints = unique::merge(&unique::get(&descriptor, "uniquenessConstraints"), authored);
        let target = crate::write::Target::bare(adapter.clone(), record_type.clone(), graph.clone());
        let (matched, _) = self.resolve_identity(&target, &criteria, &criteria, &constraints, &[], scope).await?;
        let Some(matched) = matched else { return Err(Stop::EndedQuietly) };
        if !adapter.instance.has("linkRecords") {
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
        if adapter.instance.has("readRecord") {
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
        self.writes.borrow_mut().push(Rc::new(WriteRecord { object: Js::object(record) }));
        if let Some(name) = binding_name {
            let mut handle = record_head(&adapter, &record_type, false, !adapter.dry, to_id.clone());
            handle.set("writtenValues".into(), Js::object(JsObject::new()));
            handle.set("resultData".into(), Js::object(data));
            handle.set("provenance".into(), Js::object(JsObject::new()));
            handle.set(
                "origin".into(),
                env::object_of(vec![("kind", Js::str("write")), ("writeIndex", Js::Number(write_index as f64)), ("externalId", to_id)]),
            );
            let handle = Handle { record: Rc::new(WriteRecord { object: Js::object(handle) }), target_type: record_type, graph };
            scope.declare(name, Binding::Handle(Rc::new(handle)));
        }
        Ok(())
    }

    /// `executeDeleteStatement`.
    pub(crate) async fn delete(&self, name: &str, scope: &Rc<Scope>) -> Result<(), Stop> {
        let at = format!("delete {name}");
        let binding = scope.resolve(name);
        let (target, external_id) = self.position_target(name, scope, "delete").await?;
        let adapter = &target.adapter;
        if !adapter.instance.has("deleteRecord") {
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
        let lock = unique::record_lock_name(&adapter.adapter_type, &external_id.to_js_string());
        self.with_locks(vec![lock], async { self.call_adapter(&adapter.instance, "deleteRecord", args).await.map_err(thrown) }).await?;
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
        self.writes.borrow_mut().push(Rc::new(WriteRecord { object: Js::object(record) }));
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
