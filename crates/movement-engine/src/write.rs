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
        // `field in writtenValues` finds its prototype's names too.
        if let Js::Object(written) = self.get("writtenValues")
            && (written.get(field).is_some() || crate::js::is_object_prototype_name(field))
        {
            return Ok(nullish_to_null(crate::js::object_property(&written, field)));
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

/// A target adapter: its `adapterType`, whether writes through it are
/// rehearsed (captured, not committed), and what answers its calls.
#[derive(Debug)]
pub struct TargetAdapter {
    pub adapter_type: String,
    pub dry: bool,
    pub through: Through,
}

/// Who answers a target adapter's calls: the host, for the instance it
/// resolved; or this engine, for an edge of a node the run built.
#[derive(Debug)]
pub enum Through {
    Host(Instance),
    Local(Rc<crate::local::LocalEdge>),
}

impl TargetAdapter {
    /// The store over a run-built node's edge (`localEdgeAdapter`).
    pub fn local(edge: crate::local::LocalEdge) -> TargetAdapter {
        TargetAdapter { adapter_type: crate::local::LOCAL_ADAPTER_TYPE.into(), dry: false, through: Through::Local(Rc::new(edge)) }
    }

    /// Whether the adapter implements `method`.
    pub fn has(&self, method: &str) -> bool {
        match &self.through {
            Through::Host(instance) => instance.has(method),
            Through::Local(_) => matches!(
                method,
                "listEntryPoints" | "describe" | "resolveEntity" | "createRecord" | "updateRecord" | "readRecord" | "deleteRecord" | "getFieldValue" | "getRelated"
            ),
        }
    }

    pub fn local_edge(&self) -> Option<&Rc<crate::local::LocalEdge>> {
        match &self.through {
            Through::Local(edge) => Some(edge),
            Through::Host(_) => None,
        }
    }
}

/// One parent a linked write hangs off (`ResolvedWriteTarget.parents[n]`).
pub(crate) struct Parent {
    handle_name: String,
    edge_name: String,
    record_type: String,
    external_id: Js,
    data: Option<Js>,
}

/// One path's parent (`resolveLinkedParent`'s answer).
struct LinkedParent {
    graph: Rc<InstanceBinding>,
    record_type: String,
    root_name: String,
    parent: Parent,
    where_: Option<TargetWhere>,
}

/// `ResolvedWriteTarget`.
pub(crate) struct Target {
    pub(crate) adapter: Rc<TargetAdapter>,
    pub(crate) record_type: String,
    /// The system the record lives in; none for an edge of a node the run
    /// built, which has no system behind it (`WriteDestination`).
    pub(crate) graph: Option<Rc<InstanceBinding>>,
    pub(crate) parents: Vec<Parent>,
    pub(crate) handle_type: Option<String>,
    /// The target edge's WHERE, when it carries one.
    pub(crate) where_: Vec<TargetWhere>,
}

impl Target {
    /// A target with no parents and no WHERE: what a criteria link searches.
    /// An edge of a node the run built: its store, the edge's name as the
    /// written type, no system, no parents (`WriteDestination`).
    pub(crate) fn local(adapter: Rc<TargetAdapter>, edge: &str) -> Target {
        Target { adapter, record_type: edge.to_string(), graph: None, parents: Vec::new(), handle_type: None, where_: Vec::new() }
    }

    pub(crate) fn bare(adapter: Rc<TargetAdapter>, record_type: String, graph: Rc<InstanceBinding>) -> Target {
        Target { adapter, record_type, graph: Some(graph), parents: Vec::new(), handle_type: None, where_: Vec::new() }
    }
}

/// Which statement a target is resolved for: its messages name it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verb {
    Write,
    Match,
    Link,
}

/// What `evaluateWriteFields` hands back.
pub(crate) struct Fields {
    pub(crate) fields: Js,
    pub(crate) provenance: Vec<(String, Option<Trail>)>,
    semantics: Vec<(String, FieldWriteMode)>,
    pub(crate) descriptor: Js,
    /// Per field, the citation an untransformed extracted value earns
    /// (`fieldEvidenceFromProvenance`).
    evidence: Vec<(String, Js)>,
    /// The source content of every extracted record a field reads
    /// (`collectWriteResources`), once each by id.
    resources: Vec<Js>,
}

impl Fields {
    /// `evidenceForWrite`: the citations of the fields written, none when
    /// none has one.
    fn evidence_for(&self, written: &Js) -> Js {
        let Js::Object(written) = written else { return Js::Undefined };
        let mut evidence = JsObject::new();
        for (field, _) in written.entries() {
            if let Some((_, cited)) = self.evidence.iter().find(|(name, _)| name == field) {
                evidence.set(field.clone(), cited.clone());
            }
        }
        if evidence.entries().is_empty() { Js::Undefined } else { Js::object(evidence) }
    }
}

/// One field line, a spread's included: its name, its value's text, the
/// span its literals cite and its write mode.
pub(crate) struct Line {
    name: String,
    slot: ast::ExprSlot,
    semantics: Option<FieldWriteMode>,
}

impl Line {
    /// A field line as written (a match's, which has no spreads).
    pub(crate) fn of(field: &ast::FieldEntry) -> Line {
        Line { name: field.name.clone(), slot: field.value.clone(), semantics: field.semantics }
    }
}

impl Run<'_> {
    /// `executeWrite`. `path` is the write expression's AST path, where the
    /// checker's spread stamps are keyed.
    /// What it hands back is what a write argument passes on: the handle, or
    /// the landing a write into a run-built node's edge made or merged into.
    pub(crate) async fn write(&self, write: &WriteExpression, binding_name: Option<&str>, scope: &Rc<Scope>, path: &str) -> Result<Binding, Stop> {
        let lines = self.write_lines(write, path)?;
        // Into an edge of a node this run built: the engine is the adapter.
        if let WriteTarget::Linked { path, .. } = &write.target
            && let Some(PathRoot::Name { name }) = &path.root
            && let Some(Binding::Node(node)) = scope.resolve(name)
        {
            return self.local_write(write, &lines, path, node, binding_name, scope).await;
        }
        if write.bind.is_some() {
            return Err(thrown(Failure::unreproduced("a bound write", "the Rust engine runs identity writes")));
        }
        match &write.target {
            WriteTarget::Position { root: PathRoot::Name { name }, .. } => {
                if let Some(Binding::Node(landing)) = scope.resolve(name) {
                    return self.local_position_write(name, &lines, landing, binding_name, scope).await;
                }
                return self.position_write(name, &lines, binding_name, scope).await;
            }
            // Admission refuses it (`write_position_member_path`).
            WriteTarget::Position { root: PathRoot::Expression { .. }, .. } => {
                return Err(thrown(Failure::unreproduced("a write from a member path", "the Rust engine runs writes from a name")));
            }
            WriteTarget::Linked { .. } | WriteTarget::Tuple { .. } => {}
        }
        let resolved = self.write_target(&write.target, scope, Verb::Write).await?;
        let evaluated = self.write_fields(&lines, &resolved.adapter, &resolved.record_type, scope).await?;
        let handle_type = discriminated_handle_type(resolved.graph.as_ref().and_then(|g| g.schema.as_ref()), &resolved.record_type, &evaluated.fields);
        let target = Target { handle_type, ..resolved };
        let identity = self.unique_by_identity(&write.unique_by, &target)?;
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
            .with_locks(lock_names, self.find_then_write(&target, &evaluated, &resolve_record, &constraints, &identity.narrowings, &parent_links, scope))
            .await?;
        Ok(Binding::Handle(self.record_write(record, binding_name, scope, &target, &evaluated.provenance)))
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
                // `spreadSourceText`: a member path as written, a name spelled.
                let source = if spread.path.is_some() { spread.source.clone() } else { spell_name(&spread.source) };
                these.push(Line {
                    name: name.clone(),
                    slot: ast::ExprSlot {
                        raw: format!("{source}.{}", spell_name(name)),
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
    /// or one edge off a handle, the event or a traversed record (a block's
    /// hop alias).
    pub(crate) async fn write_target(&self, target: &WriteTarget, scope: &Rc<Scope>, verb: Verb) -> Result<Target, Stop> {
        let (path, explicit_type) = match target {
            WriteTarget::Linked { path, explicit_type, .. } => (path, explicit_type),
            WriteTarget::Tuple { paths, explicit_type, .. } => return self.tuple_target(paths, explicit_type.as_deref(), scope, verb).await,
            WriteTarget::Position { .. } => unreachable!("position writes are dispatched first"),
        };
        let root_name = match &path.root {
            Some(PathRoot::Name { name }) => Some(name.clone()),
            _ => None,
        };
        let root = root_name.as_deref().and_then(|name| scope.resolve(name));
        if let Some(Binding::Instance(instance)) = &root {
            let (edge, where_) = self.single_edge(path, "a linked write walks exactly one declared edge from its root")?;
            let record_type = explicit_type
                .clone()
                .or_else(|| instance.schema.as_ref().and_then(|s| s.collections.0.get(&edge)).map(|c| c.target.clone()))
                .unwrap_or(edge);
            let adapter = self.target_adapter(instance).await?;
            return Ok(Target { adapter, record_type, graph: Some(instance.clone()), parents: Vec::new(), handle_type: None, where_: where_.into_iter().collect() });
        }
        let parent = self.linked_parent(path, explicit_type.as_deref(), root_name.as_deref(), root, scope, verb, false).await?;
        let adapter = self.target_adapter(&parent.graph).await?;
        Ok(Target {
            adapter,
            record_type: parent.record_type,
            graph: Some(parent.graph),
            parents: vec![parent.parent],
            handle_type: None,
            where_: parent.where_.into_iter().collect(),
        })
    }

    /// `resolveTupleWriteTarget`: one record at the convergence of every
    /// path, each resolved as a linked write's parent; all in one graph, all
    /// inferring one type, every path's WHERE a condition on the record.
    async fn tuple_target(&self, paths: &[ast::PathHead], explicit_type: Option<&str>, scope: &Rc<Scope>, verb: Verb) -> Result<Target, Stop> {
        let mut resolved = Vec::with_capacity(paths.len());
        for path in paths {
            let root_name = match &path.root {
                Some(PathRoot::Name { name }) => Some(name.clone()),
                _ => None,
            };
            let root = root_name.as_deref().and_then(|name| scope.resolve(name));
            resolved.push(self.linked_parent(path, explicit_type, root_name.as_deref(), root, scope, verb, true).await?);
        }
        let Some((first, rest)) = resolved.split_first() else {
            return Err(thrown(Failure::engine("MOVENG_RUNTIME", "a tuple write with no paths — the checker should have caught this".into())));
        };
        for other in rest {
            if !Rc::ptr_eq(&other.graph, &first.graph) {
                return Err(thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!(
                        "a tuple write's paths must land in the same graph — '{}' is in '{}' and '{}' is in '{}'",
                        first.root_name, first.graph.name, other.root_name, other.graph.name
                    ),
                )));
            }
            if other.record_type != first.record_type {
                return Err(thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!(
                        "the tuple's paths must converge on ONE written type — '{}-[:{}]->' infers '{}' but '{}-[:{}]->' infers '{}'",
                        first.root_name, first.parent.edge_name, first.record_type, other.root_name, other.parent.edge_name, other.record_type
                    ),
                )));
            }
        }
        let graph = first.graph.clone();
        let record_type = first.record_type.clone();
        let adapter = self.target_adapter(&graph).await?;
        let mut parents = Vec::new();
        let mut where_ = Vec::new();
        for parent in resolved {
            parents.push(parent.parent);
            where_.extend(parent.where_);
        }
        Ok(Target { adapter, record_type, graph: Some(graph), parents, handle_type: None, where_ })
    }

    /// `resolveLinkedParent` (with, for a linked write, `linkedPathGraph`
    /// first): the record the path's root names parents the write, one
    /// declared edge down, in the graph it lives in.
    #[allow(clippy::too_many_arguments)]
    async fn linked_parent(
        &self,
        path: &ast::PathHead,
        explicit_type: Option<&str>,
        root_name: Option<&str>,
        root: Option<Binding>,
        scope: &Scope,
        verb: Verb,
        tuple: bool,
    ) -> Result<LinkedParent, Stop> {
        let name = root_name.unwrap_or_default().to_string();
        let describe = |b: &Option<Binding>| b.as_ref().map_or("not in scope".to_string(), |b| describe_binding(b).to_string());
        // `linkedPathGraph`: a linked write's graph is resolved first; a
        // tuple's after each path's own checks.
        let graph_of = |root: &Option<Binding>| -> Result<Rc<InstanceBinding>, Stop> {
            match root {
                Some(Binding::Handle(handle)) => Ok(handle.graph.clone()),
                Some(Binding::Event) => self.source_instance.borrow().clone().ok_or_else(|| thrown(self.unnamed_graph(&name))),
                // The graph the record was read from: its constructed instance by
                // name, or, read off the event's source, the source's instance.
                Some(Binding::Landed(landed)) => self.landed_graph(landed, scope).ok_or_else(|| thrown(self.unnamed_graph(&name))),
                other => Err(thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!("a linked write's path must start at a bound write handle or a traversed record — '{name}' is {}", describe(other)),
                ))),
            }
        };
        let early = if tuple { None } else { Some(graph_of(&root)?) };
        if tuple && (root_name.is_none() || !matches!(root, Some(Binding::Handle(_) | Binding::Landed(_) | Binding::Event))) {
            return Err(thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("a linked write's path must start at a bound write handle, a traversed record, or the event — '{name}' is {}", describe(&root)),
            )));
        }
        let (parent_type, parent_id, parent_data) = match &root {
            Some(Binding::Handle(handle)) => (handle.target_type.clone(), handle.record.get("externalId"), Some(handle.record.get("resultData"))),
            Some(Binding::Landed(landed)) => {
                let position = &landed.position;
                match (crate::traverse::record_type(position), crate::traverse::is_stable(position)) {
                    (Some(record_type), true) => (record_type, crate::traverse::record_id(position), Some(crate::traverse::position_data(position))),
                    _ => {
                        return Err(thrown(Failure::engine(
                            "MOVENG_RUNTIME",
                            format!(
                                "'{name}' is a traversed position without a stable record id — only positions with durable native identity (e.g. a WHERE-selected Spreadsheet or Channel) can parent a linked write"
                            ),
                        )));
                    }
                }
            }
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
        let (edge, where_) = self.single_edge(path, "a linked write walks exactly one declared edge from its parent handle")?;
        let graph = match early {
            Some(graph) => graph,
            None => graph_of(&root)?,
        };
        let record_type = infer_linked_type(graph.schema.as_ref(), &parent_type, &edge, explicit_type, &name, verb)?;
        let data = parent_data.filter(|d| matches!(d, Js::Object(_) | Js::Array(_)));
        Ok(LinkedParent {
            graph,
            record_type,
            root_name: name.clone(),
            parent: Parent { handle_name: name, edge_name: edge, record_type: parent_type, external_id: parent_id, data },
            where_,
        })
    }

    /// The instance a traversed record lives in (`linkedPathGraph`): read
    /// off the event's source, the source's own; otherwise the constructed
    /// instance its read names.
    pub(crate) fn landed_graph(&self, landed: &crate::bindings::Landed, scope: &Scope) -> Option<Rc<InstanceBinding>> {
        let source = self.source.borrow().clone();
        if source.as_ref().is_some_and(|s| Rc::ptr_eq(&s.read, &landed.read)) {
            return self.source_instance.borrow().clone();
        }
        match scope.resolve(&landed.read.instance_name) {
            Some(Binding::Instance(instance)) => Some(instance),
            _ => None,
        }
    }

    /// `singleWriteEdge`: the one edge step a linked path walks, and its WHERE.
    pub(crate) fn single_edge(&self, path: &ast::PathHead, detail: &str) -> Result<(String, Option<TargetWhere>), Stop> {
        match edge_shape(path) {
            EdgeShape::One { edge, where_ } => Ok((edge, where_)),
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
    pub(crate) async fn target_adapter(&self, instance: &InstanceBinding) -> Result<Rc<TargetAdapter>, Stop> {
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
        let target = Rc::new(TargetAdapter { adapter_type, dry, through: Through::Host(handle) });
        self.targets.borrow_mut().push((key, target.clone()));
        Ok(target)
    }

    /// `evaluateWriteFields`: `describe`, then each line in order.
    pub(crate) async fn write_fields(&self, lines: &[Line], adapter: &TargetAdapter, record_type: &str, scope: &Rc<Scope>) -> Result<Fields, Stop> {
        let descriptor = self.store_call(&adapter, "describe", env::object_of(vec![("typeId", Js::str(record_type))])).await.map_err(thrown)?;
        let described: Vec<Js> = match unique::get(&descriptor, "fields") {
            Js::Array(list) => list.items().clone(),
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
        let mut evidence = Vec::new();
        for (name, trail) in &provenance {
            let direct = trail.as_ref().and_then(|t| t.direct).map(|id| self.origin(id));
            if let Some(origin) = direct
                && matches!(unique::get(&origin, "kind"), Js::String(kind) if kind == "extraction")
                && unique::get(&origin, "quote").truthy()
            {
                evidence.push((name.clone(), env::object_of(vec![("quote", unique::get(&origin, "quote")), ("type", Js::str("extraction"))])));
            }
        }
        let resources = self.write_resources(lines, scope);
        Ok(Fields { fields: Js::object(fields), provenance, semantics, descriptor, evidence, resources })
    }

    /// `collectWriteResources`: the names each field's text reads (field
    /// names in backticks, and a name after a dot, are not names), and of
    /// those bound to what an extraction yielded, the source content it
    /// was read from, once each by id.
    fn write_resources(&self, lines: &[Line], scope: &Scope) -> Vec<Js> {
        let mut seen: Vec<String> = Vec::new();
        let mut out = Vec::new();
        for line in lines {
            for name in referenced_identifiers(&line.slot.raw) {
                let Some(Binding::Extracted { emission, .. }) = scope.resolve(&name) else { continue };
                for resource in &emission.resources {
                    // `resource.id ?? resource.externalId`.
                    let key = match unique::get(resource, "id") {
                        id if id.is_nullish() => unique::get(resource, "externalId"),
                        id => id,
                    };
                    let key = (!matches!(key, Js::Undefined)).then(|| key.to_js_string());
                    if let Some(key) = key {
                        if seen.contains(&key) {
                            continue;
                        }
                        seen.push(key);
                    }
                    out.push(resource.clone());
                }
            }
        }
        out
    }

    /// A slot evaluated as `evaluateSlot` evaluates it: lowered, its literals
    /// citing the slot's span.
    pub(crate) async fn evaluate_slot(&self, slot: &ast::ExprSlot, scope: &Rc<Scope>) -> Result<Evaluated, Stop> {
        let expr = crate::run::lowered(slot, |tree| movement_parser::lowering::lower_expression(tree, &slot.raw), "expression").map_err(thrown)?;
        self.evaluate(&expr, scope, slot).await
    }

    pub(crate) fn trail_of(&self, prov: &Prov, scope: &Scope) -> Option<Trail> {
        match prov {
            Prov::Binding(name) => crate::eval::Names::value(scope, name).and_then(|b| b.trail),
            Prov::Built(trail) => Some(trail.clone()),
        }
    }

    /// `uniqueByIdentity`: the clauses' key branches, the literal values a
    /// key compared with, and each clause's conjuncts that narrow what its
    /// key finds.
    pub(crate) fn unique_by_identity(&self, unique_by: &[ast::UniqueClause], target: &Target) -> Result<Identity, Stop> {
        let mut branches = Vec::new();
        let mut overlay: Vec<(String, Js)> = Vec::new();
        let mut narrowings = Vec::new();
        for clause in unique_by {
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
        let found = self.store_call(&target.adapter, "resolveEntity", Js::object(search)).await.map_err(thrown)?;
        Ok(match unique::get(&found, "candidates") {
            Js::Array(list) => list.items().clone(),
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
            let lacks = fields.iter().any(|f| data.get(f).is_none() && !crate::js::is_object_prototype_name(f));
            if lacks && target.adapter.has("readRecord") {
                let mut read = JsObject::new();
                read.set("recordType".into(), Js::str(target.record_type.clone()));
                read.set("externalId".into(), unique::get(&candidate, "externalId"));
                if let Js::Object(current) = self.store_call(&target.adapter, "readRecord", Js::object(read)).await.map_err(thrown)? {
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
    /// back (`WITHIN`) answered by the TypeScript comparator, the host's
    /// clock asked once for the record (run.ts `decideWithClock`).
    async fn predicate_holds(&self, predicate: &Expression, data: &JsObject) -> Result<bool, Stop> {
        let read = |name: &str| data.get(name).cloned().unwrap_or(Js::Undefined);
        let now = std::cell::RefCell::new(None);
        let now = &now;
        let ask = |op: movement_parser::lowering::expression::FilterOperator, l: Js, r: Js| -> crate::filter::Comparing<'_> {
            Box::pin(async move { self.compare(op, l, r, now).await })
        };
        match crate::filter::evaluate_predicate_with(predicate, &read, Some(&ask)).await {
            Ok(value) => Ok(value.truthy()),
            Err(error) => Err(thrown(Failure::of_eval(error, "the Rust engine does not reproduce it"))),
        }
    }

    /// `identityRecord`.
    pub(crate) fn identity_record(&self, fields: &Js, overlay: &[(String, Js)], constraints: &Js, target: &Target) -> Js {
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

    /// `resolveIdentity`: the shortlist (each key's candidates narrowed by
    /// its clause), then the target's WHERE over what is left, then the rules
    /// and, when they cannot say, the judge. The candidate chosen, and why
    /// the judge could not be asked, if it could not.
    pub(crate) async fn resolve_identity(
        &self,
        target: &Target,
        asserted: &Js,
        resolve_record: &Js,
        constraints: &Js,
        narrowings: &[Option<Expression>],
        scope: &Rc<Scope>,
    ) -> Result<(Option<Js>, Option<String>), Stop> {
        let shortlist = self.identity_shortlist(target, resolve_record, constraints, narrowings).await?;
        // The target's WHERE runs last, on the smallest list: it reads each
        // candidate as the record it is.
        let candidates = if target.where_.is_empty() { shortlist } else { self.narrow_by_target_where(target, shortlist, scope).await? };
        let (chosen, judge_unavailable) = match unique::arbitrate_without_judge(asserted, &candidates, constraints, self.version()) {
            Some(decided) => (decided, None),
            None => self.judge(asserted, &candidates, &target.record_type, constraints).await?,
        };
        Ok((chosen.and_then(|i| candidates.get(i)).cloned(), judge_unavailable))
    }

    /// The judge (`llm.arbitrateEntities`), a priced call: the index it
    /// picked, and why it could not judge, if it could not.
    async fn judge(&self, asserted: &Js, candidates: &[Js], record_type: &str, constraints: &Js) -> Result<(Option<usize>, Option<String>), Stop> {
        let request = host::llm::arbitrate_entities(
            self.segment(),
            host::llm::Arbitration {
                asserted: self.encode(asserted).map_err(Stop::Thrown)?,
                candidates: self.encode(&Js::array(candidates.to_vec())).map_err(Stop::Thrown)?,
                record_type,
                constraints: self.encode(constraints).map_err(Stop::Thrown)?,
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
            // A budget refusal is the run's cap, from the run's own
            // figures, where they say it is met.
            if error.get("kind").and_then(Json::as_str) == Some("budget")
                && let Some(cap) = self.ledger.exceeded()
            {
                return Err(thrown(Failure::CapExceeded(cap)));
            }
            let message = error.get("message").and_then(Json::as_str).unwrap_or_default().to_string();
            return Err(thrown(Failure::Engine { class: crate::eval::ErrorClass::Error, message }));
        }
        Ok((judged_index(&answer), answer.get("judgeUnavailable").and_then(Json::as_str).map(String::from)))
    }

    /// `narrowCandidatesByTargetWhere`: each candidate read as the record it
    /// is — its snapshot under what `readRecord` answers, a stable position
    /// of the handle's type read through the target graph as a source — and
    /// kept when every WHERE on the target holds of it, the hop's alias
    /// naming it. The shortlist's order is kept.
    async fn narrow_by_target_where(&self, target: &Target, candidates: Vec<Js>, scope: &Rc<Scope>) -> Result<Vec<Js>, Stop> {
        if candidates.is_empty() {
            return Ok(candidates);
        }
        let graph = target.graph.as_ref().expect("a target WHERE is a system's: a local edge refuses one");
        let read = self.instance_read(graph).await.map_err(thrown)?;
        let adapter = &target.adapter;
        let record_type = target.handle_type.clone().unwrap_or_else(|| target.record_type.clone());
        let mut kept = Vec::new();
        for candidate in candidates {
            let external_id = unique::get(&candidate, "externalId");
            let current = if adapter.has("readRecord") {
                let mut read = JsObject::new();
                read.set("recordType".into(), Js::str(target.record_type.clone()));
                read.set("externalId".into(), external_id.clone());
                self.store_call(&adapter, "readRecord", Js::object(read)).await.map_err(thrown)?
            } else {
                Js::Null
            };
            let mut data = JsObject::new();
            let url = unique::get(&candidate, "url");
            if !matches!(url, Js::Undefined) {
                data.set("url".into(), url);
            }
            for bag in [unique::get(&candidate, "data"), current] {
                if let Js::Object(bag) = bag {
                    for (k, v) in bag.entries() {
                        data.set(k.clone(), v.clone());
                    }
                }
            }
            let position = crate::traverse::stable_position(Js::str(adapter.adapter_type.clone()), Js::str(record_type.clone()), external_id, Js::object(data));
            let landed = Rc::new(crate::bindings::Landed::new(position, None, read.clone()));
            let mut passes = true;
            for where_ in &target.where_ {
                let at = scope.child();
                if let Some(alias) = &where_.alias {
                    at.declare(alias.clone(), Binding::Landed(landed.clone()));
                }
                if !self.evaluate_in(&where_.filter, &at, None, Some(landed.clone())).await?.value.truthy() {
                    passes = false;
                    break;
                }
            }
            if passes {
                kept.push(candidate);
            }
        }
        Ok(kept)
    }

    /// `findThenWrite`: the search, the rules and the judge, then an update
    /// of what was found or a create.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn find_then_write(
        &self,
        target: &Target,
        fields: &Fields,
        resolve_record: &Js,
        constraints: &Js,
        narrowings: &[Option<Expression>],
        parent_links: &[Js],
        scope: &Rc<Scope>,
    ) -> Result<Js, Stop> {
        let (chosen, judge_unavailable) = self.resolve_identity(target, &fields.fields, resolve_record, constraints, narrowings, scope).await?;
        let matched = chosen.map(|c| unique::get(&c, "externalId"));
        if let Some(external_id) = matched.filter(|id| !matches!(id, Js::Undefined)) {
            let locks = match target.adapter.local_edge() {
                None => vec![unique::record_lock_name(&target.adapter.adapter_type, &external_id)],
                Some(edge) => self.local_update_locks(edge, &external_id, constraints, resolve_record, &fields.fields).await.map_err(thrown)?,
            };
            if let Some(updated) = self.apply_update(target, &external_id, fields, parent_links, locks).await? {
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
    pub(crate) async fn apply_update(&self, target: &Target, external_id: &Js, fields: &Fields, parent_links: &[Js], locks: Vec<String>) -> Result<Option<Js>, Stop> {
        self.with_locks(locks, self.merge_into_record(target, external_id, fields, parent_links)).await
    }

    async fn merge_into_record(&self, target: &Target, external_id: &Js, fields: &Fields, parent_links: &[Js]) -> Result<Option<Js>, Stop> {
        let adapter = &target.adapter;
        let keys: Vec<Js> = match &fields.fields {
            Js::Object(object) => object.entries().iter().map(|(k, _)| Js::str(k.clone())).collect(),
            _ => Vec::new(),
        };
        let current = if adapter.has("readRecord") {
            let mut read = JsObject::new();
            read.set("recordType".into(), Js::str(target.record_type.clone()));
            read.set("externalId".into(), external_id.clone());
            read.set("fieldIds".into(), Js::array(keys));
            self.store_call(&adapter, "readRecord", Js::object(read)).await.map_err(thrown)?
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
        // An extract-fed write whose fields all match still records its
        // source content against the record.
        if !changed && fields.resources.is_empty() && parent_links.is_empty() {
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
        update.set("evidence".into(), fields.evidence_for(&to_write));
        if !fields.resources.is_empty() {
            update.set("resources".into(), Js::array(fields.resources.clone()));
        }
        update.set("mutationContext".into(), self.mutation_context.borrow().clone());
        update.set("parentLinks".into(), Js::array(parent_links.to_vec()));
        let updated = self.store_call(&adapter, "updateRecord", Js::object(update)).await.map_err(thrown)?;
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
            Js::Array(list) => list.items().clone(),
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
        create.set("evidence".into(), fields.evidence_for(&fields.fields));
        if !fields.resources.is_empty() {
            create.set("resources".into(), Js::array(fields.resources.clone()));
        }
        create.set("mutationContext".into(), self.mutation_context.borrow().clone());
        create.set("parentLinks".into(), Js::array(parent_links.to_vec()));
        create.set("bridgeToExternal".into(), Js::Undefined);
        let created = self.store_call(&adapter, "createRecord", Js::object(create)).await.map_err(thrown)?;
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

    /// `executePositionWrite`: an update by the id of the record the alias
    /// stands on — a write's handle, or a traversed record.
    async fn position_write(&self, alias: &str, lines: &[Line], binding_name: Option<&str>, scope: &Rc<Scope>) -> Result<Binding, Stop> {
        let (target, external_id) = self.position_target(alias, scope, "update").await?;
        let fields = self.write_fields(lines, &target.adapter, &target.record_type, scope).await?;
        let lock = unique::record_lock_name(&target.adapter.adapter_type, &external_id);
        let Some(record) = self.apply_update(&target, &external_id, &fields, &[], vec![lock]).await? else {
            return Err(thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!(
                    "'write {alias} {{ … }}' — the record ({} {}) no longer exists",
                    target.adapter.adapter_type,
                    external_id.to_js_string()
                ),
            )));
        };
        Ok(Binding::Handle(self.record_write(record, binding_name, scope, &target, &fields.provenance)))
    }

    /// `resolvePositionWriteTarget`: the record an alias stands on, as an
    /// update's (or a delete's) destination, and its id. A traversed record
    /// is written through its graph's target adapter, under the type its
    /// position names; a handle under the type it stands on.
    pub(crate) async fn position_target(&self, alias: &str, scope: &Rc<Scope>, action: &str) -> Result<(Target, Js), Stop> {
        self.position_target_of(alias, scope.resolve(alias), scope, action).await
    }

    /// `resolvePositionWriteTarget` of a binding in hand, `alias` naming it
    /// in the messages.
    pub(crate) async fn position_target_of(&self, alias: &str, binding: Option<Binding>, scope: &Rc<Scope>, action: &str) -> Result<(Target, Js), Stop> {
        let unstable = || {
            thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!(
                    "can't update '{alias}' — it has no stable record to update (an inbound payload, an extracted node, or a write that produced no record). Create a new record instead"
                ),
            ))
        };
        let target = |adapter, record_type, graph| Target { adapter, record_type, graph: Some(graph), parents: Vec::new(), handle_type: None, where_: Vec::new() };
        match binding {
            None => Err(thrown(Failure::engine("MOVENG_RUNTIME", format!("'{alias}' is not in scope — the checker should have caught this")))),
            Some(Binding::Landed(landed)) => {
                let position = &landed.position;
                if !crate::traverse::is_stable(position) {
                    return Err(unstable());
                }
                let Some(record_type) = crate::traverse::record_type(position) else {
                    return Err(thrown(Failure::engine(
                        "MOVENG_RUNTIME",
                        format!("can't {action} '{alias}' — its record type is unknown (an un-narrowed position). Narrow it with an IS test first"),
                    )));
                };
                let name = &landed.read.instance_name;
                let Some(Binding::Instance(instance)) = scope.resolve(name) else {
                    return Err(thrown(Failure::engine(
                        "MOVENG_RUNTIME",
                        format!("can't {action} '{alias}' — its graph '{name}' is not a constructed instance in scope"),
                    )));
                };
                let adapter = self.target_adapter(&instance).await?;
                Ok((target(adapter, record_type, instance), crate::traverse::record_id(position)))
            }
            Some(Binding::Handle(handle)) => {
                let external_id = handle.record.get("externalId");
                if matches!(external_id, Js::Undefined) {
                    return Err(unstable());
                }
                let adapter = self.target_adapter(&handle.graph).await?;
                Ok((target(adapter, handle.target_type.clone(), handle.graph.clone()), external_id))
            }
            Some(other) => {
                let statement = if action == "delete" { format!("delete {alias}") } else { format!("write {alias} {{ … }}") };
                Err(thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!("'{alias}' is {} — '{statement}' needs a record position (a traversal alias or a prior write result)", describe_binding(&other)),
                )))
            }
        }
    }

    /// `recordWrite`: the firing record finished — each written field's
    /// trail summarised, the binding's name, the interned origin — onto the
    /// run's writes, and the handle bound.
    pub(crate) fn record_write(
        &self,
        record: Js,
        binding_name: Option<&str>,
        scope: &Scope,
        target: &Target,
        provenance: &[(String, Option<Trail>)],
    ) -> Rc<Handle> {
        let write_index = self.writes.borrow().len();
        let Js::Object(object) = &record else { unreachable!("a write record is an object") };
        let mut object = JsObject::clone_of(object);
        self.summarise_written(&mut object, provenance, binding_name);
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
            graph: target.graph.clone().expect("a write bound as a handle is in a system"),
        };
        let handle = Rc::new(handle);
        if let Some(name) = binding_name {
            scope.declare(name, Binding::Handle(handle.clone()));
        }
        handle
    }

    /// The firing record's `provenance` for each field it wrote, and the
    /// name it was bound to.
    pub(crate) fn summarise_written(&self, object: &mut JsObject, provenance: &[(String, Option<Trail>)], binding_name: Option<&str>) {
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
    }

    /// `readBindingField` for a record the run holds in hand: a node's field
    /// with its own trail, an extraction's, or a handle's with the read's
    /// origin.
    pub(crate) fn binding_field(&self, binding: &Binding, field: &str) -> Result<Evaluated, EvalError> {
        let handle = match binding {
            Binding::Handle(handle) => handle,
            Binding::Node(node) => return crate::node::node_field(&node.borrow(), field),
            Binding::Extracted { emission, .. } => return emission_field(emission, field),
            other => return Err(EvalError::engine("MOVENG_RUNTIME", format!("{} is not a record in hand", describe_binding(other)))),
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

    /// A target adapter's method: the host's for an instance it resolved,
    /// this engine's own for a run-built node's edge.
    pub(crate) async fn store_call(&self, adapter: &TargetAdapter, method: &str, args: Js) -> Result<Js, Failure> {
        match &adapter.through {
            Through::Host(instance) => self.call_adapter(instance, method, args).await,
            Through::Local(edge) => self.local_call(edge, method, args).await,
        }
    }

    /// An adapter method with its one argument object, on the eval wire both
    /// ways. The host's error as data fails the statement as the
    /// TypeScript's stand-in raises it (host_adapter.ts `hostCallFailure`):
    /// the shim holds that very error, under the `ref` the error carries.
    pub(crate) async fn call_adapter(&self, instance: &Instance, method: &str, args: Js) -> Result<Js, Failure> {
        let answer = self.ask(host::adapters::call(self.segment(), instance, method, self.encode(&args)?)).await?;
        self.adapter_answer(answer)
    }

    /// An `adapters.call` answer: the result off the eval wire, or the
    /// host's error as the stand-in raises it.
    pub(crate) fn adapter_answer(&self, answer: Option<Json>) -> Result<Js, Failure> {
        match host::call_answer(answer).map_err(|e| Failure::engine("MOVENG_RUNTIME", e))? {
            host::CallAnswer::Result(Some(wire)) => self.wire.decode(&wire).map_err(|e| Failure::engine("MOVENG_RUNTIME", e)),
            host::CallAnswer::Result(None) => Ok(Js::Undefined),
            host::CallAnswer::Error(error) => Err(Failure::Host(HostError { detail: error })),
        }
    }

    /// An effect run holding the cross-run locks it needs, let go however it
    /// ends (`EffectLocks.withLocks` beneath the run's own flows, which in
    /// this engine never run at once).
    pub(crate) async fn with_locks<T>(&self, names: Vec<String>, effect: impl std::future::Future<Output = Result<T, Stop>>) -> Result<T, Stop> {
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

pub(crate) struct Identity {
    pub(crate) branches: Vec<Js>,
    pub(crate) overlay: Vec<(String, Js)>,
    /// Per authored clause, the conjuncts that narrow what its key finds.
    pub(crate) narrowings: Vec<Option<Expression>>,
}

pub(crate) fn thrown(failure: Failure) -> Stop {
    Stop::Thrown(failure)
}

/// The failure a statement's step stopped with, where the step can only
/// throw (a target's resolution).
pub(crate) fn failure_of(stop: Stop) -> Failure {
    match stop {
        Stop::Thrown(failure) => failure,
        _ => unreachable!("resolving a target only throws"),
    }
}

/// The first keys of a write record, in the TypeScript's order.
pub(crate) fn record_head(adapter: &TargetAdapter, record_type: &str, created: bool, committed: bool, external_id: Js) -> JsObject {
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
            Js::str(list.items().iter().filter(|v| !v.is_nullish()).map(Js::to_js_string).collect::<Vec<_>>().join(", "))
        }
        _ => value,
    }
}

/// `isEmptyWriteValue`.
fn is_empty_write_value(value: &Js) -> bool {
    match value {
        Js::Undefined | Js::Null => true,
        Js::String(s) => s.is_empty(),
        Js::Array(list) => list.items().is_empty(),
        _ => false,
    }
}

/// `isEmptyFieldValue`: an empty string is a value here.
fn is_empty_field_value(value: &Js) -> bool {
    match value {
        Js::Undefined | Js::Null => true,
        Js::Array(list) => list.items().is_empty(),
        _ => false,
    }
}

/// `toFieldArray`.
fn to_field_array(value: &Js) -> Vec<Js> {
    match value {
        Js::Undefined | Js::Null => Vec::new(),
        Js::Array(list) => list.items().clone(),
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
        (Js::Array(x), Js::Array(y)) => x.items().len() == y.items().len() && x.items().iter().zip(y.items().iter()).all(|(p, q)| deep_equal(p, q)),
        (Js::Object(x), Js::Object(y)) => {
            x.entries().len() == y.entries().len()
                && x.entries().iter().all(|(k, v)| deep_equal(v, y.get(k).unwrap_or(&Js::Undefined)))
        }
        _ => false,
    }
}

/// `discriminatedHandleType`: the variant a discriminated write's own body
/// named, when it names one that mints a position.
pub(crate) fn discriminated_handle_type(schema: Option<&InstanceSchema>, record_type: &str, fields: &Js) -> Option<String> {
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
pub(crate) fn infer_linked_type(
    schema: Option<&InstanceSchema>,
    parent_type: &str,
    edge_name: &str,
    explicit: Option<&str>,
    root_name: &str,
    verb: Verb,
) -> Result<String, Stop> {
    let keyword = match verb {
        Verb::Write => "write",
        Verb::Match => "match",
        Verb::Link => "link",
    };
    let (creates, written) = if verb == Verb::Write { ("write creates", "written") } else { ("match finds", "found") };
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
            format!("'{edge_name}' is polymorphic — say which type this {creates}: {keyword} …-[:{edge_name}]-><type> {{ … }}"),
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
            "cannot infer the {written} type for edge '{edge_name}' from '{root_name}' (a {parent_type} handle) — name it explicitly: {keyword} …-[:{edge_name}]-><type> {{ … }}"
        ),
    )))
}

/// `describeBinding`, for the kinds this engine binds.
pub fn describe_binding(binding: &Binding) -> String {
    let described = match binding {
        Binding::Shaped(_) => return crate::record::describe(binding),
        Binding::Value(_) => "a value binding",
        Binding::Event => "the movement parameter (the event position)",
        Binding::Instance(_) => "a constructed adapter instance",
        Binding::Opaque => "an import",
        Binding::Movement(_) => "a movement declaration",
        Binding::Shape(_) => "a shape declaration",
        Binding::Plugin(_) => "a plugin",
        Binding::Handle(_) => "a write handle",
        Binding::Node(_) => "a synthesised node",
        Binding::Landed(_) => "a traversed source record",
        Binding::Positions(_) => "a block's returned records",
        Binding::LazyWalk(_) => "a deferred traversal",
        Binding::Extracted { root: true, .. } => "an extract result",
        Binding::Extracted { root: false, .. } => "an extracted entity",
    };
    described.to_string()
}

/// `referencedIdentifiers`: the names a field's text reads — backticked
/// segments (field names) blanked out, a name after a dot skipped — each
/// once, in the order first read.
fn referenced_identifiers(raw: &str) -> Vec<String> {
    let mut without_fields = String::new();
    let mut quoted = false;
    for c in raw.chars() {
        match c {
            '`' if !quoted => quoted = true,
            '`' => {
                quoted = false;
                without_fields.push(' ');
            }
            _ if quoted => {}
            c => without_fields.push(c),
        }
    }
    // An unclosed backtick stays text, as the regex leaves it.
    if quoted {
        let tail = raw.rfind('`').map_or("", |at| &raw[at..]);
        without_fields.push_str(tail);
    }
    let chars: Vec<char> = without_fields.chars().collect();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut names: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !word(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && word(chars[i]) {
            i += 1;
        }
        let token: String = chars[start..i].iter().collect();
        let after_dot = start > 0 && chars[start - 1] == '.';
        if !after_dot && !token.chars().next().is_some_and(|c| c.is_ascii_digit()) && !names.contains(&token) {
            names.push(token);
        }
    }
    names
}

/// `spellName`: bare when an ASCII identifier, backticked otherwise.
/// What a linked write's path walks: one edge (and the WHERE on it, when
/// the author narrowed it), more, or nothing a probe reads. Admission
/// (crate::admit) and the write read the same probe.
pub(crate) enum EdgeShape {
    One { edge: String, where_: Option<TargetWhere> },
    MultiHop,
    Invalid(String),
}

/// A WHERE on a write's or a match's target edge (run.ts `TargetWhere`): it
/// narrows the identity shortlist, each candidate read as the record it is,
/// the hop's alias naming it.
#[derive(Debug, Clone)]
pub(crate) struct TargetWhere {
    pub alias: Option<String>,
    pub filter: Expression,
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
            TraversalStep::Edge(step) => EdgeShape::One {
                edge: step.edge_type_id.clone(),
                where_: step.expression_filter.as_deref().map(|filter| TargetWhere { alias: step.alias.clone(), filter: filter.clone() }),
            },
            _ => EdgeShape::MultiHop,
        },
        _ => EdgeShape::MultiHop,
    }
}

/// `readEmissionField`: the field as extracted, cited by its own origin,
/// which every read shares.
pub(crate) fn emission_field(emission: &crate::extract::emission::Emission, field: &str) -> Result<Evaluated, EvalError> {
    let value = crate::record::project_object(&emission.fields, field);
    let trail = emission.origin_of(field).map_or_else(Trail::default, |id| Trail { origins: vec![id], direct: Some(id) });
    Ok(Evaluated { value, prov: Prov::Built(trail) })
}

/// `spellName`: bare when an ASCII identifier, backticked otherwise.
pub fn spell_name(name: &str) -> String {
    let mut chars = name.chars();
    let ident = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ident { name.to_string() } else { format!("`{name}`") }
}

/// `unquoteConstructionArg`.
pub(crate) fn unquote_construction_arg(raw: &str) -> String {
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
