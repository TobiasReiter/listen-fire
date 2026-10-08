//! The `write` statement: run.ts's `executeWrite` for the targets this
//! engine runs — a collection of a constructed instance (`write crm-[:companies]->`),
//! an edge off a write's handle or off the event (`write co-[:notes]->`,
//! `write msg-[:replies]->`), and a held record updated in place
//! (`write co { … }`) — with the same adapter calls in the same order:
//!
//! 1. the target adapter resolved (`role: 'target'`, once per instance; a
//!    rehearsal asks the host to wrap it, and the host's wrapper captures);
//! 2. `describe`, then each field evaluated in the author's order (a spread
//!    is the field lines the checker stamped on it), cardinality-coerced;
//! 3. identity: `unique by` ∪ the descriptor's native constraints, the
//!    search record, the identity lock, `resolveEntity`, the rules, and the
//!    judge (`llm.arbitrateEntities`) when the rules cannot say;
//! 4. an update by id (its record lock, `readRecord`, the `?:` / `+:` /
//!    `+?:` merges, no-op suppression) or a create (the required-field gate);
//! 5. the firing record: per-field provenance summarised, the write's origin
//!    interned, the handle bound.

use std::rc::Rc;

use movement_parser::ast::{self, FieldWriteMode, PathRoot, WriteExpression, WriteTarget};
use movement_parser::catalog::types::InstanceSchema;
use movement_parser::lowering::expression::{Expression, TraversalStep};
use serde_json::Value as Json;

use crate::bindings::{Binding, Handle, InstanceBinding, Scope};
use crate::env::{self, Trail};
use crate::eval::{EvalError, Evaluated, Prov};
use crate::executor::HostError;
use crate::host::{self, Instance, ResolveAdapter, Role};
use crate::js::{self, Js, JsObject};
use crate::program::Stamp;
use crate::run::{Failure, Run, Stop};
use crate::unique::{self, Key};

/// A write's firing record (expression.ts `WriteRecord`), held as the very
/// object the TypeScript builds: its keys in the TypeScript's order, so the
/// result, a handle read and a park all see one value.
#[derive(Debug, Clone)]
pub struct WriteRecord {
    pub object: Js,
}

impl WriteRecord {
    pub fn get(&self, key: &str) -> Js {
        unique::get(&self.object, key)
    }

    /// `readHandleField`: the specials, then what was written, then the
    /// adapter's result data, else null.
    pub fn field(&self, field: &str) -> Result<Js, EvalError> {
        match field {
            "externalId" => return Ok(nullish_to_null(self.get("externalId"))),
            "created" => return Ok(self.get("created")),
            "committed" => return Ok(self.get("committed")),
            _ => {}
        }
        if let Js::Object(written) = self.get("writtenValues")
            && let Some(value) = written.get(field)
        {
            return Ok(nullish_to_null(value.clone()));
        }
        if crate::stdlib::is_object_prototype_name(field) {
            return Err(EvalError::Fallback(format!("`{field}` is Object.prototype's")));
        }
        Ok(match self.get("resultData") {
            Js::Object(data) => data.get(field).cloned().map_or(Js::Null, nullish_to_null),
            _ => Js::Null,
        })
    }
}

fn nullish_to_null(value: Js) -> Js {
    if value.is_nullish() { Js::Null } else { value }
}

/// A target adapter the host resolved: its handle, its `adapterType`, and
/// whether writes through it are rehearsed (captured, not committed).
#[derive(Debug)]
pub struct TargetAdapter {
    pub instance: Instance,
    pub adapter_type: String,
    pub dry: bool,
}

/// One parent a linked write hangs off (`ResolvedWriteTarget.parents[n]`).
struct Parent {
    handle_name: String,
    edge_name: String,
    record_type: String,
    external_id: Js,
    data: Option<Js>,
}

/// `ResolvedWriteTarget`.
struct Target {
    adapter: Rc<TargetAdapter>,
    record_type: String,
    graph: Rc<InstanceBinding>,
    parents: Vec<Parent>,
    handle_type: Option<String>,
}

/// What `evaluateWriteFields` hands back.
struct Fields {
    fields: Js,
    provenance: Vec<(String, Option<Trail>)>,
    semantics: Vec<(String, FieldWriteMode)>,
    descriptor: Js,
}

/// One field line, a spread's included: its name, its value's text, the
/// span its literals cite and its write mode.
struct Line {
    name: String,
    slot: ast::ExprSlot,
    semantics: Option<FieldWriteMode>,
}

impl Run<'_> {
    /// `executeWrite`. `path` is the write expression's AST path, where the
    /// checker's spread stamps are keyed.
    pub(crate) async fn write(&self, write: &WriteExpression, binding_name: Option<&str>, scope: &Rc<Scope>, path: &str) -> Result<(), Stop> {
        let lines = self.write_lines(write, path)?;
        if write.bind.is_some() {
            return Err(thrown(Failure::unsupported("a bound write", "the Rust engine runs identity writes")));
        }
        if let WriteTarget::Position { alias, .. } = &write.target {
            return self.position_write(alias, &lines, binding_name, scope).await;
        }
        let resolved = self.write_target(write, scope).await?;
        let evaluated = self.write_fields(&lines, &resolved.adapter, &resolved.record_type, scope).await?;
        let handle_type = discriminated_handle_type(resolved.graph.schema.as_ref(), &resolved.record_type, &evaluated.fields);
        let target = Target { handle_type, ..resolved };
        let identity = self.unique_by_identity(write, &target)?;
        let native = unique::get(&evaluated.descriptor, "uniquenessConstraints");
        let constraints = unique::merge(&native, identity.branches.clone());
        let resolve_record = self.identity_record(&evaluated.fields, &identity.overlay, &constraints, &target);
        let parent_links = parent_links(&target);
        let lock_names = unique::identity_lock_names(
            &target.adapter.adapter_type,
            &target.record_type,
            &constraints,
            &resolve_record,
            &evaluated.fields,
            self.version(),
        );
        let record = self
            .with_locks(lock_names, self.find_then_write(&target, &evaluated, &resolve_record, &constraints, &identity.narrowings, &parent_links))
            .await?;
        self.record_write(record, binding_name, scope, &target, &evaluated.provenance);
        Ok(())
    }

    /// The write's field lines, its spreads written out (`expandWriteSpreads`)
    /// from the fields the checker stamped on each.
    fn write_lines(&self, write: &WriteExpression, path: &str) -> Result<Vec<Line>, Stop> {
        let mut lines: Vec<Line> = write
            .fields
            .iter()
            .map(|f| Line { name: f.name.clone(), slot: f.value.clone(), semantics: f.semantics })
            .collect();
        let spreads = write.spreads.as_deref().unwrap_or_default();
        if spreads.is_empty() {
            return Ok(lines);
        }
        let mut written: Vec<String> = lines.iter().map(|l| l.name.clone()).collect();
        let mut expanded: Vec<Line> = Vec::new();
        for (index, spread) in spreads.iter().enumerate().rev() {
            let at = format!("{path}/spreads/{index}");
            let Some(Stamp::SpreadFields(fields)) = self.checked.root.stamps.get(&at) else {
                return Err(thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!(
                        "'...{}' has no field list — the program was not checked, or the checker should have refused this spread",
                        spread.source
                    ),
                )));
            };
            let mut these = Vec::new();
            for name in fields {
                if written.contains(name) {
                    continue;
                }
                written.push(name.clone());
                these.push(Line {
                    name: name.clone(),
                    slot: ast::ExprSlot {
                        raw: format!("{}.{}", spell_name(&spread.source), spell_name(name)),
                        span: spread.span,
                        eager: false,
                    },
                    semantics: spread.semantics,
                });
            }
            these.extend(expanded);
            expanded = these;
        }
        lines.extend(expanded);
        Ok(lines)
    }

    /// `resolveWriteTarget` for a linked target: a collection of an instance,
    /// or one edge off a handle or the event.
    async fn write_target(&self, write: &WriteExpression, scope: &Rc<Scope>) -> Result<Target, Stop> {
        let (path, explicit_type) = match &write.target {
            WriteTarget::Linked { path, explicit_type, .. } => (path, explicit_type),
            WriteTarget::Tuple { .. } => return Err(thrown(Failure::unsupported("a tuple write", "the Rust engine runs linked writes"))),
            WriteTarget::Position { .. } => unreachable!("position writes are dispatched first"),
        };
        let root_name = match &path.root {
            Some(PathRoot::Name { name }) => Some(name.clone()),
            _ => None,
        };
        let root = root_name.as_deref().and_then(|name| scope.resolve(name));
        if let Some(Binding::Instance(instance)) = &root {
            let (edge, _) = self.single_edge(path, "a linked write walks exactly one declared edge from its root")?;
            let record_type = explicit_type
                .clone()
                .or_else(|| instance.schema.as_ref().and_then(|s| s.collections.0.get(&edge)).map(|c| c.target.clone()))
                .unwrap_or(edge);
            let adapter = self.target_adapter(instance).await?;
            return Ok(Target { adapter, record_type, graph: instance.clone(), parents: Vec::new(), handle_type: None });
        }
        let name = root_name.unwrap_or_default();
        let describe = |b: &Option<Binding>| b.as_ref().map_or("not in scope".to_string(), |b| describe_binding(b).to_string());
        // `linkedPathGraph`, then `resolveLinkedParent`.
        let graph = match &root {
            Some(Binding::Handle(handle)) => handle.graph.clone(),
            Some(Binding::Event) => self.source_instance.borrow().clone().ok_or_else(|| thrown(self.unnamed_graph(&name)))?,
            other => {
                return Err(thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!(
                        "a linked write's path must start at a bound write handle or a traversed record — '{name}' is {}",
                        describe(other)
                    ),
                )));
            }
        };
        let (parent_type, parent_id, parent_data) = match &root {
            Some(Binding::Handle(handle)) => (handle.target_type.clone(), handle.record.get("externalId"), Some(handle.record.get("resultData"))),
            _ => {
                let source = self.source.borrow().clone().expect("the event is seeded before the body runs");
                let position = &source.position;
                match (&position.record_id, &position.record_type) {
                    (Some(id), Some(record_type)) => (record_type.clone(), Js::str(id.clone()), Some(position.data.clone())),
                    _ => {
                        return Err(thrown(Failure::engine(
                            "MOVENG_RUNTIME",
                            format!("'{name}' (the event) carries no durable record id — this source's events can't parent a linked write"),
                        )));
                    }
                }
            }
        };
        let (edge, _) = self.single_edge(path, "a linked write walks exactly one declared edge from its parent handle")?;
        let record_type = infer_linked_type(graph.schema.as_ref(), &parent_type, &edge, explicit_type.as_deref(), &name)?;
        let data = parent_data.filter(|d| matches!(d, Js::Object(_) | Js::Array(_)));
        let adapter = self.target_adapter(&graph).await?;
        Ok(Target {
            adapter,
            record_type,
            graph,
            parents: vec![Parent { handle_name: name, edge_name: edge.clone(), record_type: parent_type, external_id: parent_id, data }],
            handle_type: None,
        })
    }

    /// `singleWriteEdge`: the one edge step a linked path walks.
    fn single_edge(&self, path: &ast::PathHead, detail: &str) -> Result<(String, bool), Stop> {
        match edge_shape(path) {
            EdgeShape::One { edge } => Ok((edge, false)),
            EdgeShape::Narrowed => Err(thrown(Failure::unsupported("a WHERE on a write's target", "the Rust engine runs unnarrowed targets"))),
            EdgeShape::MultiHop => Err(thrown(Failure::unsupported("multi-hop linked writes", detail))),
            EdgeShape::Invalid(e) => {
                Err(thrown(Failure::engine("MOVENG_RUNTIME", format!("invalid block head (the checker should have caught this): {e}"))))
            }
        }
    }

    fn unnamed_graph(&self, name: &str) -> Failure {
        Failure::engine(
            "MOVENG_RUNTIME",
            format!(
                "a linked write's parent — the system '{name}' came from can't be determined, so there is no target to act on. Root the path at a NAMED system: construct one (`crm = attio(credentials: …)`) and start the traversal from that name"
            ),
        )
    }

    /// `targetAdapterFor`: one resolve per instance, rehearsed when the run
    /// or the instance's own construction says so.
    async fn target_adapter(&self, instance: &InstanceBinding) -> Result<Rc<TargetAdapter>, Stop> {
        let dry = self.input.dry_run
            || instance.construction_config.iter().any(|(k, v)| k == "dry_run" && js::trim(v).to_lowercase() == "true");
        let credentials_id = instance.credential_name.as_deref().and_then(|name| self.credential_id(name));
        let construction_args: std::collections::BTreeMap<String, String> = instance
            .construction_config
            .iter()
            .filter(|(k, _)| k != "dry_run")
            .map(|(k, v)| (k.clone(), unquote_construction_arg(v)))
            .collect();
        let key = format!("{dry} {} {} {:?}", instance.adapter_slug, credentials_id.as_deref().unwrap_or(""), construction_args);
        if let Some((_, cached)) = self.targets.borrow().iter().find(|(k, _)| *k == key) {
            return Ok(cached.clone());
        }
        let resolved = self
            .ask(host::adapters::resolve(self.segment(), &ResolveAdapter {
                adapter_type: instance.adapter_slug.clone(),
                credentials_id,
                construction_args: (!construction_args.is_empty()).then_some(construction_args),
                role: Role::Target,
                dry_run: dry,
            }))
            .await
            .map_err(thrown)?
            .unwrap_or(Json::Null);
        let handle = host::instance_of(&resolved)
            .ok_or_else(|| thrown(Failure::engine("MOVENG_RUNTIME", format!("adapters.resolve answered {resolved}"))))?;
        let adapter_type = resolved.get("adapterType").and_then(Json::as_str).unwrap_or(&instance.adapter_slug).to_string();
        let target = Rc::new(TargetAdapter { instance: handle, adapter_type, dry });
        self.targets.borrow_mut().push((key, target.clone()));
        Ok(target)
    }

    /// `evaluateWriteFields`: `describe`, then each line in order.
    async fn write_fields(&self, lines: &[Line], adapter: &TargetAdapter, record_type: &str, scope: &Rc<Scope>) -> Result<Fields, Stop> {
        let descriptor = self.call_adapter(&adapter.instance, "describe", env::object_of(vec![("typeId", Js::str(record_type))])).await.map_err(thrown)?;
        let described: Vec<Js> = match unique::get(&descriptor, "fields") {
            Js::Array(list) => list.items.clone(),
            _ => Vec::new(),
        };
        let mut fields = JsObject::new();
        let mut provenance: Vec<(String, Option<Trail>)> = Vec::new();
        let mut semantics = Vec::new();
        for line in lines {
            let evaluated = self.evaluate_slot(&line.slot, scope).await?;
            if matches!(evaluated.value, Js::Undefined) {
                continue;
            }
            // `new Map(fields.map((f) => [f.displayName, f]))`: the last wins.
            let field = described.iter().rev().find(|f| matches!(unique::get(f, "displayName"), Js::String(n) if n == line.name));
            fields.set(line.name.clone(), coerce_for_cardinality(evaluated.value, field));
            let trail = self.trail_of(&evaluated.prov, scope);
            match provenance.iter_mut().find(|(n, _)| *n == line.name) {
                Some(slot) => slot.1 = trail,
                None => provenance.push((line.name.clone(), trail)),
            }
            if let Some(mode) = line.semantics {
                match semantics.iter_mut().find(|(n, _): &&mut (String, FieldWriteMode)| *n == line.name) {
                    Some(slot) => slot.1 = mode,
                    None => semantics.push((line.name.clone(), mode)),
                }
            }
        }
        Ok(Fields { fields: Js::object(fields), provenance, semantics, descriptor })
    }

    /// A slot evaluated as `evaluateSlot` evaluates it: lowered, its literals
    /// citing the slot's span.
    pub(crate) async fn evaluate_slot(&self, slot: &ast::ExprSlot, scope: &Rc<Scope>) -> Result<Evaluated, Stop> {
        let expr = crate::run::lowered(slot, |tree| movement_parser::lowering::lower_expression(tree, &slot.raw), "expression").map_err(thrown)?;
        self.evaluate(&expr, scope, slot).await
    }

    fn trail_of(&self, prov: &Prov, scope: &Scope) -> Option<Trail> {
        match prov {
            Prov::Binding(name) => crate::eval::Names::value(scope, name).and_then(|b| b.trail),
            Prov::Built(trail) => Some(trail.clone()),
        }
    }

    /// `uniqueByIdentity`: the clauses' key branches, the literal values a
    /// key compared with, and each clause's conjuncts that narrow what its
    /// key finds.
    fn unique_by_identity(&self, write: &WriteExpression, target: &Target) -> Result<Identity, Stop> {
        let mut branches = Vec::new();
        let mut overlay: Vec<(String, Js)> = Vec::new();
        let mut narrowings = Vec::new();
        for clause in &write.unique_by {
            let mut all: Vec<(String, bool)> = Vec::new();
            let mut non_key: Vec<Expression> = Vec::new();
            for part in unique::split_conjuncts(&clause.predicate.raw) {
                let slot = ast::ExprSlot { raw: part.raw.clone(), span: clause.predicate.span, eager: false };
                let expr = crate::run::lowered(&slot, |tree| movement_parser::lowering::lower_expression(tree, &slot.raw), "expression").map_err(thrown)?;
                for conjunct in unique::and_conjuncts(&expr) {
                    match unique::identity_key(conjunct) {
                        None => non_key.push(conjunct.clone()),
                        Some(Key::Compared { name, with }) => {
                            all.push((name.clone(), part.fuzzy));
                            if let Some(value) = unique::static_of(with) {
                                match overlay.iter_mut().find(|(n, _)| *n == name) {
                                    Some(slot) => slot.1 = value,
                                    None => overlay.push((name, value)),
                                }
                            }
                        }
                        Some(Key::Bare(name)) => {
                            let field = target.parents.iter().find(|p| p.handle_name == name).map_or(name, |p| p.edge_name.clone());
                            all.push((field, part.fuzzy));
                        }
                    }
                }
            }
            if all.is_empty() {
                return Err(thrown(Failure::unsupported(
                    &format!("a 'unique by' clause with no key ('{}')", clause.predicate.raw),
                    "add the field or parent that finds the record, or move the test onto a WHERE on the target",
                )));
            }
            let narrowing = match non_key.len() {
                0 => None,
                1 => non_key.pop(),
                _ => Some(Expression::Logical { op: movement_parser::lowering::expression::LogicalOp::And, operands: non_key }),
            };
            narrowings.push(narrowing);
            branches.push(unique::branch(all));
        }
        Ok(Identity { branches, overlay, narrowings })
    }

    /// `identityShortlist`: one search by every key together, or, when a
    /// clause narrows, one per key, each narrowed by its clause, merged in key
    /// order with the first sighting kept.
    async fn identity_shortlist(&self, target: &Target, resolve_record: &Js, constraints: &Js, narrowings: &[Option<Expression>]) -> Result<Vec<Js>, Stop> {
        if narrowings.iter().all(Option::is_none) {
            return self.search(target, resolve_record, constraints).await;
        }
        let all = unique::branches(constraints);
        // The authored keys follow the target's own, which no clause narrows.
        let native = all.len() - narrowings.len();
        let mut shortlist: Vec<Js> = Vec::new();
        let mut seen: Vec<Js> = Vec::new();
        for (index, key) in all.iter().enumerate() {
            let mut only = JsObject::new();
            only.set("any".into(), Js::array(vec![key.clone()]));
            let found = self.search(target, resolve_record, &Js::object(only)).await?;
            let kept = match index.checked_sub(native).and_then(|i| narrowings[i].as_ref()) {
                Some(narrowing) => self.narrow_by_predicate(target, found, narrowing).await?,
                None => found,
            };
            for candidate in kept {
                let id = unique::get(&candidate, "externalId");
                if seen.iter().any(|s| js::same_value_zero(s, &id)) {
                    continue;
                }
                seen.push(id);
                shortlist.push(candidate);
            }
        }
        Ok(shortlist)
    }

    /// `resolveEntity`'s candidates.
    async fn search(&self, target: &Target, resolve_record: &Js, constraints: &Js) -> Result<Vec<Js>, Stop> {
        let mut search = JsObject::new();
        search.set("record".into(), resolve_record.clone());
        search.set("recordType".into(), Js::str(target.record_type.clone()));
        search.set("candidates".into(), Js::array(vec![]));
        search.set("constraints".into(), constraints.clone());
        let found = self.call_adapter(&target.adapter.instance, "resolveEntity", Js::object(search)).await.map_err(thrown)?;
        Ok(match unique::get(&found, "candidates") {
            Js::Array(list) => list.items.clone(),
            _ => Vec::new(),
        })
    }

    /// `narrowCandidatesByPredicate`: each candidate's own fields (its record
    /// read when the search's snapshot lacks one the test reads) against the
    /// clause's other conjuncts.
    async fn narrow_by_predicate(&self, target: &Target, candidates: Vec<Js>, predicate: &Expression) -> Result<Vec<Js>, Stop> {
        let fields = crate::filter::pure_leaf_keys(predicate).ok_or_else(|| {
            thrown(Failure::unsupported("a 'unique by' test that reads beyond the candidate", "move it onto a WHERE on the target"))
        })?;
        let mut kept = Vec::new();
        for candidate in candidates {
            let mut data = match unique::get(&candidate, "data") {
                Js::Object(object) => JsObject::clone_of(&object),
                _ => JsObject::new(),
            };
            let lacks = fields.iter().any(|f| data.get(f).is_none() && !crate::stdlib::is_object_prototype_name(f));
            if lacks && target.adapter.instance.has("readRecord") {
                let mut read = JsObject::new();
                read.set("recordType".into(), Js::str(target.record_type.clone()));
                read.set("externalId".into(), unique::get(&candidate, "externalId"));
                if let Js::Object(current) = self.call_adapter(&target.adapter.instance, "readRecord", Js::object(read)).await.map_err(thrown)? {
                    for (k, v) in current.entries() {
                        data.set(k.clone(), v.clone());
                    }
                }
            }
            if self.predicate_holds(predicate, &data).await? {
                kept.push(candidate);
            }
        }
        Ok(kept)
    }

    /// `evaluatePredicate` over one record, a comparison this engine hands
    /// back (`WITHIN`) answered by the TypeScript comparator.
    async fn predicate_holds(&self, predicate: &Expression, data: &JsObject) -> Result<bool, Stop> {
        let answers: std::cell::RefCell<Vec<bool>> = std::cell::RefCell::default();
        loop {
            let cursor = std::cell::Cell::new(0usize);
            let pending: std::cell::RefCell<Option<(movement_parser::lowering::expression::FilterOperator, Js, Js)>> = std::cell::RefCell::default();
            let read = |name: &str| data.get(name).cloned().unwrap_or(Js::Undefined);
            let compare = |l: &Js, op, r: &Js| match crate::filter::compare_values(l, op, r) {
                Err(EvalError::Fallback(_)) => {
                    let at = cursor.get();
                    if let Some(&answer) = answers.borrow().get(at) {
                        cursor.set(at + 1);
                        return Ok(answer);
                    }
                    *pending.borrow_mut() = Some((op, l.clone(), r.clone()));
                    Err(EvalError::Suspend)
                }
                other => other,
            };
            match crate::filter::evaluate_predicate_with(predicate, &read, &compare) {
                Ok(value) => return Ok(value.truthy()),
                Err(EvalError::Suspend) => {
                    let (op, l, r) = pending.borrow_mut().take().expect("a suspended predicate asked");
                    let op = serde_json::to_value(op).expect("an operator is JSON");
                    let request = host::builtins::compare(op.as_str().unwrap_or_default(), env::encode_plain(&l), env::encode_plain(&r));
                    let answer = self.ask(request).await.map_err(thrown)?.unwrap_or(Json::Null);
                    let value = answer.get("value").and_then(|v| env::decode(v).ok()).ok_or_else(|| {
                        thrown(Failure::engine("MOVENG_RUNTIME", format!("the comparator answered {answer}")))
                    })?;
                    answers.borrow_mut().push(value.truthy());
                }
                Err(EvalError::Thrown { class, message }) => return Err(thrown(Failure::Engine { class, message })),
                Err(EvalError::Fallback(reason)) => {
                    return Err(thrown(Failure::unsupported(&format!("this reading ({reason})"), "the Rust engine does not reproduce it")));
                }
            }
        }
    }

    /// `identityRecord`.
    fn identity_record(&self, fields: &Js, overlay: &[(String, Js)], constraints: &Js, target: &Target) -> Js {
        let mut record = JsObject::new();
        if let Js::Object(fields) = fields {
            for (k, v) in fields.entries() {
                record.set(k.clone(), v.clone());
            }
        }
        for (k, v) in overlay {
            record.set(k.clone(), v.clone());
        }
        let mut constraint_fields: Vec<String> = Vec::new();
        for branch in unique::branches(constraints) {
            for entry in unique::entries(&branch) {
                let field = unique::field_of(&entry);
                if !constraint_fields.contains(&field) {
                    constraint_fields.push(field);
                }
            }
        }
        for field in &constraint_fields {
            if unique::is_blank(record.get(field).unwrap_or(&Js::Undefined), self.version()) {
                record.set(field.clone(), Js::Null);
            }
        }
        for parent in &target.parents {
            if matches!(parent.external_id, Js::Undefined) {
                continue;
            }
            if constraint_fields.contains(&parent.edge_name) {
                let mut id = JsObject::new();
                id.set("id".into(), parent.external_id.clone());
                record.set(parent.edge_name.clone(), Js::object(id));
            }
        }
        Js::object(record)
    }

    /// `findThenWrite`: the search, the rules and the judge, then an update
    /// of what was found or a create.
    async fn find_then_write(
        &self,
        target: &Target,
        fields: &Fields,
        resolve_record: &Js,
        constraints: &Js,
        narrowings: &[Option<Expression>],
        parent_links: &[Js],
    ) -> Result<Js, Stop> {
        let candidates = self.identity_shortlist(target, resolve_record, constraints, narrowings).await?;
        let mut judge_unavailable = None;
        let chosen = match unique::arbitrate_without_judge(&fields.fields, &candidates, constraints, self.version()) {
            Some(decided) => decided,
            None => {
                let request = host::llm::arbitrate_entities(
                    self.segment(),
                    host::llm::Arbitration {
                        asserted: env::encode_plain(&fields.fields),
                        candidates: env::encode_plain(&Js::array(candidates.clone())),
                        record_type: &target.record_type,
                        constraints: env::encode_plain(constraints),
                        language_version: self.version(),
                    },
                    self.ledger.budget(),
                );
                let answer = self.ask(request).await.map_err(thrown)?.unwrap_or(Json::Null);
                // A priced call: what it spent is charged, a refusal included,
                // before the answer is read (run_context.ts `charged`).
                self.ledger
                    .charge(answer.get("cost"))
                    .map_err(|message| thrown(Failure::Engine { class: crate::eval::ErrorClass::Error, message }))?;
                if let Some(error) = answer.get("error") {
                    let message = error.get("message").and_then(Json::as_str).unwrap_or_default().to_string();
                    return Err(thrown(Failure::Engine { class: crate::eval::ErrorClass::Error, message }));
                }
                judge_unavailable = answer.get("judgeUnavailable").and_then(Json::as_str).map(String::from);
                judged_index(&answer)
            }
        };
        let matched = chosen.and_then(|i| candidates.get(i)).map(|c| unique::get(c, "externalId"));
        if let Some(external_id) = matched.filter(|id| !matches!(id, Js::Undefined)) {
            if let Some(updated) = self.apply_update(target, &external_id, fields, parent_links).await? {
                return Ok(updated);
            }
        }
        let created = self.apply_create(target, fields, parent_links).await?;
        Ok(match judge_unavailable {
            Some(message) => with_key(&created, "note", Js::str(format!("judge unavailable: {message}; created rather than merged"))),
            None => created,
        })
    }

    /// `applyUpdate`: the record held while its current values are read and
    /// merged into. `None` when the adapter reports it gone.
    async fn apply_update(&self, target: &Target, external_id: &Js, fields: &Fields, parent_links: &[Js]) -> Result<Option<Js>, Stop> {
        let name = unique::record_lock_name(&target.adapter.adapter_type, &external_id.to_js_string());
        self.with_locks(vec![name], self.merge_into_record(target, external_id, fields, parent_links)).await
    }

    async fn merge_into_record(&self, target: &Target, external_id: &Js, fields: &Fields, parent_links: &[Js]) -> Result<Option<Js>, Stop> {
        let adapter = &target.adapter;
        let keys: Vec<Js> = match &fields.fields {
            Js::Object(object) => object.entries().iter().map(|(k, _)| Js::str(k.clone())).collect(),
            _ => Vec::new(),
        };
        let current = if adapter.instance.has("readRecord") {
            let mut read = JsObject::new();
            read.set("recordType".into(), Js::str(target.record_type.clone()));
            read.set("externalId".into(), external_id.clone());
            read.set("fieldIds".into(), Js::array(keys));
            self.call_adapter(&adapter.instance, "readRecord", Js::object(read)).await.map_err(thrown)?
        } else {
            Js::Null
        };
        let has_current = current.truthy();
        let mut to_write = JsObject::new();
        if let Js::Object(object) = &fields.fields {
            for (field, value) in object.entries() {
                let mode = fields.semantics.iter().find(|(n, _)| n == field).map(|(_, m)| *m);
                let now = unique::get(&current, field);
                match mode {
                    Some(FieldWriteMode::Fill) => {
                        if !is_empty_field_value(&now) {
                            continue;
                        }
                        to_write.set(field.clone(), value.clone());
                    }
                    Some(mode @ (FieldWriteMode::Append | FieldWriteMode::AppendMissing)) => {
                        let current_list = to_field_array(&now);
                        let incoming = to_field_array(value);
                        let mut merged = current_list.clone();
                        for v in incoming {
                            if mode == FieldWriteMode::Append || !current_list.iter().any(|c| deep_equal(c, &v)) {
                                merged.push(v);
                            }
                        }
                        let merged = Js::array(merged);
                        if has_current && deep_equal(&merged, &Js::array(current_list)) {
                            continue;
                        }
                        to_write.set(field.clone(), merged);
                    }
                    None => {
                        if has_current && deep_equal(value, &now) {
                            continue;
                        }
                        to_write.set(field.clone(), value.clone());
                    }
                }
            }
        }
        let parents = parent_summaries(parent_links);
        let changed = !to_write.entries().is_empty();
        if !changed && parent_links.is_empty() {
            let mut record = record_head(adapter, &target.record_type, false, !adapter.dry, external_id.clone());
            record.set("writtenValues".into(), Js::object(JsObject::new()));
            record.set("outcome".into(), Js::str("noop"));
            record.set("provenance".into(), Js::object(JsObject::new()));
            if let Some(parents) = parents {
                record.set("parents".into(), parents);
            }
            return Ok(Some(Js::object(record)));
        }
        let to_write = Js::object(to_write);
        let mut update = JsObject::new();
        update.set("recordType".into(), Js::str(target.record_type.clone()));
        update.set("externalId".into(), external_id.clone());
        update.set("fields".into(), to_write.clone());
        update.set("evidence".into(), Js::Undefined);
        update.set("mutationContext".into(), self.mutation_context.borrow().clone());
        update.set("parentLinks".into(), Js::array(parent_links.to_vec()));
        let updated = self.call_adapter(&adapter.instance, "updateRecord", Js::object(update)).await.map_err(thrown)?;
        if let Js::Object(object) = &updated
            && object.get("notFound").is_some()
        {
            return Ok(None);
        }
        let association = unique::get(&updated, "association");
        if matches!(&association, Js::String(a) if a == "unsupported") {
            let parent = &parent_links[0];
            return Err(thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!(
                    "'{}' cannot attach an existing {} to {} {} through {}",
                    adapter.adapter_type,
                    target.record_type,
                    unique::get(parent, "recordType").to_js_string(),
                    unique::get(parent, "externalId").to_js_string(),
                    unique::get(parent, "edgeName").to_js_string(),
                ),
            )));
        }
        let mut record = record_head(adapter, &target.record_type, false, !adapter.dry, external_id.clone());
        record.set("writtenValues".into(), to_write);
        record.set("resultData".into(), write_result_data(&updated));
        record.set("outcome".into(), Js::str(if changed { "update" } else { "attach" }));
        record.set("provenance".into(), Js::object(JsObject::new()));
        if let Some(parents) = parents {
            record.set("parents".into(), parents);
        }
        if let Js::String(a) = &association
            && (a == "made" || a == "already")
        {
            record.set("association".into(), association.clone());
        }
        Ok(Some(Js::object(record)))
    }

    /// `applyCreate`: the required-field gate, then the create.
    async fn apply_create(&self, target: &Target, fields: &Fields, parent_links: &[Js]) -> Result<Js, Stop> {
        let satisfied: Vec<String> = parent_links.iter().map(|p| unique::get(p, "edgeName").to_js_string()).collect();
        let is_root = target.parents.is_empty();
        let described: Vec<Js> = match unique::get(&fields.descriptor, "fields") {
            Js::Array(list) => list.items.clone(),
            _ => Vec::new(),
        };
        let missing: Vec<String> = described
            .iter()
            .filter(|f| {
                let hide = unique::get(f, "hideOn");
                unique::get(f, "required").truthy()
                    && unique::get(f, "writable").truthy()
                    && !(matches!(&hide, Js::String(h) if h == "root") && is_root)
                    && !(matches!(&hide, Js::String(h) if h == "child") && !is_root)
            })
            .map(|f| unique::get(f, "displayName").to_js_string())
            .filter(|name| is_empty_write_value(&unique::get(&fields.fields, name)) && !satisfied.contains(name))
            .collect();
        if !missing.is_empty() {
            let label = match unique::get(&fields.descriptor, "displayName") {
                Js::Undefined | Js::Null => target.record_type.clone(),
                other => other.to_js_string(),
            };
            return Err(thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!(
                    "cannot create a {label} record: required field(s) {} have no value",
                    missing.iter().map(|f| format!("\"{f}\"")).collect::<Vec<_>>().join(", ")
                ),
            )));
        }
        let adapter = &target.adapter;
        let mut create = JsObject::new();
        create.set("recordType".into(), Js::str(target.record_type.clone()));
        create.set("fields".into(), fields.fields.clone());
        create.set("evidence".into(), Js::Undefined);
        create.set("mutationContext".into(), self.mutation_context.borrow().clone());
        create.set("parentLinks".into(), Js::array(parent_links.to_vec()));
        create.set("bridgeToExternal".into(), Js::Undefined);
        let created = self.call_adapter(&adapter.instance, "createRecord", Js::object(create)).await.map_err(thrown)?;
        let mut record = record_head(adapter, &target.record_type, true, !adapter.dry, unique::get(&created, "externalId"));
        record.set("writtenValues".into(), fields.fields.clone());
        record.set("resultData".into(), write_result_data(&created));
        record.set("outcome".into(), Js::str("create"));
        record.set("provenance".into(), Js::object(JsObject::new()));
        if let Some(parents) = parent_summaries(parent_links) {
            record.set("parents".into(), parents);
        }
        Ok(Js::object(record))
    }

    /// `executePositionWrite` for a held handle: an update by its id.
    async fn position_write(&self, alias: &str, lines: &[Line], binding_name: Option<&str>, scope: &Rc<Scope>) -> Result<(), Stop> {
        let handle = match scope.resolve(alias) {
            Some(Binding::Handle(handle)) => handle,
            None => return Err(thrown(Failure::engine("MOVENG_RUNTIME", format!("'{alias}' is not in scope — the checker should have caught this")))),
            Some(other) => {
                return Err(thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!(
                        "'{alias}' is {} — 'write {alias} {{ … }}' needs a record position (a traversal alias or a prior write result)",
                        describe_binding(&other)
                    ),
                )));
            }
        };
        let external_id = handle.record.get("externalId");
        if matches!(external_id, Js::Undefined) {
            return Err(thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!(
                    "can't update '{alias}' — it has no stable record to update (an inbound payload, an extracted node, or a write that produced no record). Create a new record instead"
                ),
            )));
        }
        let adapter = self.target_adapter(&handle.graph).await?;
        let target = Target { adapter, record_type: handle.target_type.clone(), graph: handle.graph.clone(), parents: Vec::new(), handle_type: None };
        let fields = self.write_fields(lines, &target.adapter, &target.record_type, scope).await?;
        let Some(record) = self.apply_update(&target, &external_id, &fields, &[]).await? else {
            return Err(thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!(
                    "'write {alias} {{ … }}' — the record ({} {}) no longer exists",
                    target.adapter.adapter_type,
                    external_id.to_js_string()
                ),
            )));
        };
        self.record_write(record, binding_name, scope, &target, &fields.provenance);
        Ok(())
    }

    /// `recordWrite`: the firing record finished — each written field's
    /// trail summarised, the binding's name, the interned origin — onto the
    /// run's writes, and the handle bound.
    fn record_write(&self, record: Js, binding_name: Option<&str>, scope: &Scope, target: &Target, provenance: &[(String, Option<Trail>)]) {
        let write_index = self.writes.borrow().len();
        let Js::Object(object) = &record else { unreachable!("a write record is an object") };
        let mut object = JsObject::clone_of(object);
        let mut summarised = JsObject::new();
        if let Js::Object(written) = object.get("writtenValues").cloned().unwrap_or(Js::Undefined) {
            for (field, _) in written.entries() {
                let trail = provenance.iter().find(|(n, _)| n == field).and_then(|(_, t)| t.clone()).unwrap_or_default();
                summarised.set(field.clone(), Js::array(trail.origins.iter().map(|&id| self.summarised_origin(id)).collect()));
            }
        }
        object.set("provenance".into(), Js::object(summarised));
        if let Some(name) = binding_name {
            object.set("bindingName".into(), Js::str(name));
        }
        let external_id = object.get("externalId").cloned().unwrap_or(Js::Undefined);
        let mut origin = vec![("kind", Js::str("write")), ("writeIndex", Js::Number(write_index as f64))];
        if !matches!(external_id, Js::Undefined) {
            origin.push(("externalId", external_id.clone()));
        }
        object.set("origin".into(), env::object_of(origin));
        let record = Rc::new(WriteRecord { object: Js::object(object) });
        self.writes.borrow_mut().push(record.clone());
        let handle = Handle {
            record,
            target_type: target.handle_type.clone().unwrap_or_else(|| target.record_type.clone()),
            graph: target.graph.clone(),
        };
        if let Some(name) = binding_name {
            scope.declare(name, Binding::Handle(Rc::new(handle)));
        }
    }

    /// A field read off a record the run holds (`readBindingField`): a
    /// node's field with its own trail, or a handle's with the read's origin
    /// (`fromOrigin({...handle.origin, field})`).
    pub(crate) fn record_field(&self, root: &str, field: &str, scope: &Scope) -> Result<Evaluated, EvalError> {
        let handle = match scope.resolve(root) {
            Some(Binding::Handle(handle)) => handle,
            Some(Binding::Node(node)) => return crate::node::node_field(&node.borrow(), field),
            _ => return Err(EvalError::engine("MOVENG_RUNTIME", format!("'{root}' is not a record in scope"))),
        };
        let value = handle.record.field(field)?;
        let trail = match handle.record.get("origin") {
            Js::Object(origin) => {
                let mut read = JsObject::clone_of(&origin);
                read.set("field".into(), Js::str(field));
                let id = self.mint_origin(Js::object(read));
                Trail { origins: vec![id], direct: Some(id) }
            }
            _ => Trail::default(),
        };
        Ok(Evaluated { value, prov: Prov::Built(trail) })
    }

    /// An adapter method with its one argument object, on the eval wire both
    /// ways. The host's error as data fails the statement as the
    /// TypeScript's stand-in raises it (host_adapter.ts `hostCallFailure`):
    /// the shim holds that very error, under the `ref` the error carries.
    pub(crate) async fn call_adapter(&self, instance: &Instance, method: &str, args: Js) -> Result<Js, Failure> {
        let answer = self.ask(host::adapters::call(self.segment(), instance, method, env::encode_plain(&args))).await?;
        match host::call_answer(answer).map_err(|e| Failure::engine("MOVENG_RUNTIME", e))? {
            host::CallAnswer::Result(Some(wire)) => env::decode(&wire).map_err(|e| Failure::engine("MOVENG_RUNTIME", e)),
            host::CallAnswer::Result(None) => Ok(Js::Undefined),
            host::CallAnswer::Error(error) => Err(Failure::Host(HostError { detail: error })),
        }
    }

    /// An effect run holding the cross-run locks it needs, let go however it
    /// ends (`EffectLocks.withLocks` beneath the run's own flows, which in
    /// this engine never run at once).
    async fn with_locks<T>(&self, names: Vec<String>, effect: impl std::future::Future<Output = Result<T, Stop>>) -> Result<T, Stop> {
        let mut names = names;
        names.sort();
        names.dedup();
        if names.is_empty() {
            return effect.await;
        }
        let held = self.ask(host::locks::acquire(self.segment(), &names)).await.map_err(thrown)?;
        let token = held
            .as_ref()
            .and_then(|answer| answer.get("token"))
            .and_then(Json::as_str)
            .map(String::from)
            .ok_or_else(|| thrown(Failure::engine("MOVENG_RUNTIME", format!("locks.acquire answered {held:?}, not {{token}}"))))?;
        let outcome = effect.await;
        let released = self.ask(host::locks::release(self.segment(), &token)).await.map_err(thrown);
        let value = outcome?;
        released?;
        Ok(value)
    }
}

/// The candidate the judge picked: `candidates[index]`, where anything but a
/// non-negative integer (negative, fractional, null, absent) finds nothing and
/// the write creates, as the TypeScript's lookup does. An index past the end
/// finds nothing too, which the caller's `candidates.get` answers.
fn judged_index(answer: &Json) -> Option<usize> {
    answer.get("index").and_then(Json::as_f64).filter(|i| *i >= 0.0 && i.fract() == 0.0).map(|i| i as usize)
}

struct Identity {
    branches: Vec<Js>,
    overlay: Vec<(String, Js)>,
    /// Per authored clause, the conjuncts that narrow what its key finds.
    narrowings: Vec<Option<Expression>>,
}

fn thrown(failure: Failure) -> Stop {
    Stop::Thrown(failure)
}

/// The first keys of a write record, in the TypeScript's order.
fn record_head(adapter: &TargetAdapter, record_type: &str, created: bool, committed: bool, external_id: Js) -> JsObject {
    let mut record = JsObject::new();
    record.set("adapterType".into(), Js::str(adapter.adapter_type.clone()));
    record.set("recordType".into(), Js::str(record_type));
    record.set("created".into(), Js::Bool(created));
    record.set("committed".into(), Js::Bool(committed));
    record.set("externalId".into(), external_id);
    record
}

fn with_key(record: &Js, key: &str, value: Js) -> Js {
    let Js::Object(object) = record else { return record.clone() };
    let mut object = JsObject::clone_of(object);
    object.set(key.into(), value);
    Js::object(object)
}

/// The parent links a write hands its adapter: each parent that produced a
/// record.
fn parent_links(target: &Target) -> Vec<Js> {
    target
        .parents
        .iter()
        .filter(|p| !matches!(p.external_id, Js::Undefined))
        .map(|p| {
            let mut link = JsObject::new();
            link.set("recordType".into(), Js::str(p.record_type.clone()));
            link.set("externalId".into(), p.external_id.clone());
            link.set("edgeName".into(), Js::str(p.edge_name.clone()));
            if let Some(data) = &p.data {
                link.set("data".into(), data.clone());
            }
            Js::object(link)
        })
        .collect()
}

/// `parentSummaries`.
fn parent_summaries(links: &[Js]) -> Option<Js> {
    if links.is_empty() {
        return None;
    }
    Some(Js::array(
        links
            .iter()
            .map(|link| {
                let mut summary = JsObject::new();
                for key in ["recordType", "externalId", "edgeName"] {
                    summary.set(key.into(), unique::get(link, key));
                }
                Js::object(summary)
            })
            .collect(),
    ))
}

/// `writeResultData`: the top-level `url`, then the data bag.
fn write_result_data(written: &Js) -> Js {
    let mut data = JsObject::new();
    let url = unique::get(written, "url");
    if !matches!(url, Js::Undefined) {
        data.set("url".into(), url);
    }
    if let Js::Object(bag) = unique::get(written, "data") {
        for (k, v) in bag.entries() {
            data.set(k.clone(), v.clone());
        }
    }
    Js::object(data)
}

/// `coerceValueForFieldCardinality`.
fn coerce_for_cardinality(value: Js, field: Option<&Js>) -> Js {
    if value.is_nullish() {
        return value;
    }
    let many = field.is_some_and(|f| matches!(unique::get(f, "cardinality"), Js::String(c) if c == "many"));
    match (&value, many) {
        (Js::Array(_), true) => value,
        (_, true) => Js::array(vec![value]),
        (Js::Array(list), false) => {
            if field.is_some_and(|f| matches!(unique::get(f, "kind"), Js::String(k) if k == "json")) {
                return value.clone();
            }
            Js::str(list.items.iter().filter(|v| !v.is_nullish()).map(Js::to_js_string).collect::<Vec<_>>().join(", "))
        }
        _ => value,
    }
}

/// `isEmptyWriteValue`.
fn is_empty_write_value(value: &Js) -> bool {
    match value {
        Js::Undefined | Js::Null => true,
        Js::String(s) => s.is_empty(),
        Js::Array(list) => list.items.is_empty(),
        _ => false,
    }
}

/// `isEmptyFieldValue`: an empty string is a value here.
fn is_empty_field_value(value: &Js) -> bool {
    match value {
        Js::Undefined | Js::Null => true,
        Js::Array(list) => list.items.is_empty(),
        _ => false,
    }
}

/// `toFieldArray`.
fn to_field_array(value: &Js) -> Vec<Js> {
    match value {
        Js::Undefined | Js::Null => Vec::new(),
        Js::Array(list) => list.items.clone(),
        other => vec![other.clone()],
    }
}

/// run.ts's `deepEqual`.
pub fn deep_equal(a: &Js, b: &Js) -> bool {
    if js::strict_equals(a, b) {
        return true;
    }
    match (a, b) {
        (Js::Null, _) | (_, Js::Null) => false,
        (Js::Array(x), Js::Array(y)) => x.items.len() == y.items.len() && x.items.iter().zip(&y.items).all(|(p, q)| deep_equal(p, q)),
        (Js::Object(x), Js::Object(y)) => {
            x.entries().len() == y.entries().len()
                && x.entries().iter().all(|(k, v)| deep_equal(v, y.get(k).unwrap_or(&Js::Undefined)))
        }
        _ => false,
    }
}

/// `discriminatedHandleType`: the variant a discriminated write's own body
/// named, when it names one that mints a position.
fn discriminated_handle_type(schema: Option<&InstanceSchema>, record_type: &str, fields: &Js) -> Option<String> {
    let schema = schema?;
    let shape = schema
        .writable_roots
        .0
        .get(record_type)
        .or_else(|| schema.create_shapes.as_ref().and_then(|c| c.0.get(record_type)))?;
    let discriminated = shape.discriminated.as_ref()?;
    let Js::String(value) = unique::get(fields, &discriminated.discriminant) else { return None };
    let position = discriminated.variants.0.get(&value)?.position.clone()?;
    schema.positions.0.contains_key(&position).then_some(position)
}

/// `inferLinkedSurfaceType`.
fn infer_linked_type(schema: Option<&InstanceSchema>, parent_type: &str, edge_name: &str, explicit: Option<&str>, root_name: &str) -> Result<String, Stop> {
    let edge = schema.and_then(|s| {
        s.positions.0.get(parent_type).and_then(|p| p.edges.0.get(edge_name)).or_else(|| {
            s.writable_roots
                .0
                .get(parent_type)
                .or_else(|| s.create_shapes.as_ref().and_then(|c| c.0.get(parent_type)))
                .and_then(|w| w.edges.as_ref())
                .and_then(|e| e.0.get(edge_name))
        })
    });
    if edge.is_some_and(|e| e.polymorphic == Some(true)) && explicit.is_none() {
        return Err(thrown(Failure::engine(
            "MOVENG_RUNTIME",
            format!("'{edge_name}' is polymorphic — say which type this write creates: write …-[:{edge_name}]-><type> {{ … }}"),
        )));
    }
    if let Some(explicit) = explicit {
        return Ok(explicit.to_string());
    }
    if let Some(edge) = edge {
        return Ok(edge.target.clone());
    }
    Err(thrown(Failure::engine(
        "MOVENG_RUNTIME",
        format!(
            "cannot infer the written type for edge '{edge_name}' from '{root_name}' (a {parent_type} handle) — name it explicitly: write …-[:{edge_name}]-><type> {{ … }}"
        ),
    )))
}

/// `describeBinding`, for the kinds this engine binds.
pub fn describe_binding(binding: &Binding) -> &'static str {
    match binding {
        Binding::Value(_) => "a value binding",
        Binding::Event => "the movement parameter (the event position)",
        Binding::Instance(_) => "a constructed adapter instance",
        Binding::Opaque => "an import",
        Binding::Movement(_) => "a movement declaration",
        Binding::Handle(_) => "a write handle",
        Binding::Node(_) => "a synthesised node",
    }
}

/// `spellName`: bare when an ASCII identifier, backticked otherwise.
/// What a linked write's path walks: one edge (with or without a WHERE),
/// more, or nothing a probe reads. Admission (crate::admit) and the write
/// read the same probe.
pub(crate) enum EdgeShape {
    One { edge: String },
    Narrowed,
    MultiHop,
    Invalid(String),
}

pub(crate) fn edge_shape(path: &ast::PathHead) -> EdgeShape {
    let root = match &path.root {
        Some(PathRoot::Name { name }) => spell_name(name),
        Some(PathRoot::Expression { .. }) => "__movement_expression_root__".into(),
        None => String::new(),
    };
    let probe = format!("{root}{}.`__movement_engine_probe__`", path.hops_raw);
    let expr = match movement_parser::expr::parse_expression(&probe) {
        Ok(tree) => match movement_parser::lowering::lower_expression(&tree, &probe) {
            Ok(expr) => expr,
            Err(e) => return EdgeShape::Invalid(format!("{e:?}")),
        },
        Err(e) => return EdgeShape::Invalid(format!("{e:?}")),
    };
    match &expr {
        Expression::Traverse { steps, .. } if steps.len() == 1 => match &steps[0] {
            TraversalStep::Edge(step) if step.expression_filter.is_some() => EdgeShape::Narrowed,
            TraversalStep::Edge(step) => EdgeShape::One { edge: step.edge_type_id.clone() },
            _ => EdgeShape::MultiHop,
        },
        _ => EdgeShape::MultiHop,
    }
}

pub fn spell_name(name: &str) -> String {
    let mut chars = name.chars();
    let ident = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ident { name.to_string() } else { format!("`{name}`") }
}

/// `unquoteConstructionArg`.
fn unquote_construction_arg(raw: &str) -> String {
    let t = js::trim(raw);
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        return t[1..t.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\");
    }
    t.to_string()
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_judge_picks_only_by_a_non_negative_integer_index() {
        assert_eq!(judged_index(&json!({ "index": 1 })), Some(1));
        assert_eq!(judged_index(&json!({ "index": 0.0 })), Some(0));
        assert_eq!(judged_index(&json!({ "index": 7 })), Some(7), "past the end: the caller's lookup finds nothing");
        for none in [json!({ "index": -1 }), json!({ "index": 0.5 }), json!({ "index": null }), json!({}), json!({ "index": "1" })] {
            assert_eq!(judged_index(&none), None, "{none}");
        }
    }
}
