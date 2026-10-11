//! The engine as the adapter of a node the run built (local_edge_adapter.ts):
//! `write deduped-[:companies]-> { unique by (FUZZY `name`), … }` writes into
//! an edge whose store is the edge's own landings, so the ordinary write path
//! (crate::write) runs on top of it — the same identity search, judge, fill
//! modes and outcomes — with no host behind the adapter calls.
//!
//! A landing's id is its index on the edge: landings are appended and never
//! removed or reordered, so a match never moves a record. A landing the run
//! built is compared by its fields and merged into in place; any other (a
//! `link`ed handle, a walked record) is a record of a system, read live and
//! updated through its own system where the store may reach one.
//!
//! The candidate block is this module's own: an exact component blocks on
//! normalised equality, a FUZZY one on a shared distinctive word (the words
//! left once the ones naming a kind of company are dropped), at most
//! `LOCAL_CANDIDATE_CAP` landings.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use crate::bindings::{Binding, Edge, LandingShape, Node, Scope};
use crate::eval::{ErrorClass, Evaluated};
use crate::run::{Failure, Run, Stop};
use crate::write::{Line, Target, TargetAdapter};
use movement_parser::ast;
use crate::env;
use crate::js::{self, Js, JsObject};
use crate::unique;

/// The `adapterType` a write into the run's own graph records.
pub const LOCAL_ADAPTER_TYPE: &str = "local";

/// How many landings one write may arbitrate over (the judge reads them all).
pub const LOCAL_CANDIDATE_CAP: usize = 20;

/// Words that name a kind of thing rather than a thing.
const GENERIC_TOKENS: [&str; 26] = [
    "inc", "ltd", "llc", "gmbh", "ag", "sas", "plc", "co", "corp", "corporation", "limited", "holdings", "ai", "labs", "lab", "technologies",
    "technology", "tech", "software", "robotics", "systems", "solutions", "group", "ventures", "capital", "partners",
];

/// `HOSTNAME_SHAPE` over a value already lower-cased, where its `i` flag
/// changes nothing (case-insensitive without `u` folds only ASCII).
const HOSTNAME_SHAPE: &str = r"^(?:[a-z][a-z0-9+.-]*://)?(?:www\.)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)\.([a-z]{2,})(?:/.*)?$";

/// The real record behind a reference landing (`realRecordOf`): its target
/// adapter, the type it is written under, its graph and its id.
#[derive(Debug, Clone)]
pub struct RealRecord {
    pub adapter: Rc<crate::write::TargetAdapter>,
    pub record_type: String,
    pub graph: Rc<crate::bindings::InstanceBinding>,
    pub external_id: Js,
}

/// Which landings the store is over: an edge of a node the run holds, or
/// (a position write) one landing on its own.
#[derive(Debug)]
pub enum Landings {
    Edge { node: Rc<RefCell<Node>>, edge: String },
    One(Rc<RefCell<Node>>),
}

/// The adapter over one local edge (`LocalEdgeStore`).
#[derive(Debug)]
pub struct LocalEdge {
    pub landings: Landings,
    /// The edge's authored name: what a landing created here landed on.
    pub edge_name: String,
    /// Whether the store may reach a landing that is a reference (a write's
    /// or a match's store); a position write's never meets one.
    pub references: bool,
    /// Whether a candidate search stopped at the cap with landings unread.
    pub capped: Cell<bool>,
    /// The scope of the statement the store serves: a reference is read and
    /// updated through the graph its record lives in, by name.
    pub scope: Rc<Scope>,
    /// Each reference's real record, resolved once.
    real: RefCell<Vec<(Binding, RealRecord)>>,
}

impl LocalEdge {
    pub fn of_edge(node: Rc<RefCell<Node>>, edge: &str, scope: &Rc<Scope>) -> LocalEdge {
        LocalEdge {
            landings: Landings::Edge { node, edge: edge.to_string() },
            edge_name: edge.to_string(),
            references: true,
            capped: Cell::new(false),
            scope: scope.clone(),
            real: RefCell::default(),
        }
    }

    pub fn of_landing(landing: Rc<RefCell<Node>>, edge: &str, scope: &Rc<Scope>) -> LocalEdge {
        LocalEdge {
            landings: Landings::One(landing),
            edge_name: edge.to_string(),
            references: false,
            capped: Cell::new(false),
            scope: scope.clone(),
            real: RefCell::default(),
        }
    }

    /// The landings, as they stand now.
    pub fn all(&self) -> Vec<Binding> {
        match &self.landings {
            Landings::Edge { node, edge } => node.borrow().landings(edge),
            Landings::One(landing) => vec![Binding::Node(landing.clone())],
        }
    }

    /// The landing behind an id, whichever kind it is (`anyLandingAt`).
    pub fn any_landing_at(&self, external_id: &Js) -> Option<Binding> {
        let Js::String(id) = external_id else { return None };
        let index = js::string_to_number(id);
        if !(index.fract() == 0.0 && index.is_finite()) || index < 0.0 {
            return None;
        }
        self.all().into_iter().nth(index as usize)
    }

    /// A landing the run built (`landingAt`).
    pub fn landing_at(&self, external_id: &Js) -> Option<Rc<RefCell<Node>>> {
        match self.any_landing_at(external_id)? {
            Binding::Node(node) => Some(node),
            _ => None,
        }
    }

    /// A landing that is a reference, where this store may reach one.
    pub fn reference_at(&self, external_id: &Js) -> Option<Binding> {
        match self.any_landing_at(external_id)? {
            Binding::Node(_) => None,
            other if self.references => Some(other),
            _ => None,
        }
    }

    /// `landingOf`: the landing a write result's id names.
    pub fn landing_of(&self, external_id: &Js) -> Option<Binding> {
        self.landing_at(external_id).map(Binding::Node).or_else(|| self.reference_at(external_id))
    }

    /// `createRecord`: a landing of the edge's declared shape appended.
    pub fn create(&self, record_type: &str, fields: &Js) -> Js {
        let Landings::Edge { node, edge } = &self.landings else {
            unreachable!("a position write updates; it never creates")
        };
        let shape = node.borrow().edges.iter().find(|(n, _)| n == edge).and_then(|(_, e)| e.shape.clone());
        let written = match fields {
            Js::Object(object) => JsObject::clone_of(object),
            _ => JsObject::new(),
        };
        let declared = shape.as_ref().map_or_else(Vec::new, |s| s.fields.clone());
        let landing = Node {
            field_order: landing_field_order(&declared, &written),
            fields: written,
            field_provenance: Vec::new(),
            landed_on: Some(self.edge_name.clone()),
            edges: landing_edges(shape.as_ref()),
        };
        let landing = Rc::new(RefCell::new(landing));
        let index = {
            let mut owner = node.borrow_mut();
            match owner.edges.iter_mut().find(|(n, _)| n == edge) {
                Some((_, e)) => {
                    e.landings.push(Binding::Node(landing.clone()));
                    e.landings.len() - 1
                }
                None => unreachable!("the write found the edge before it created"),
            }
        };
        let data = Js::object(JsObject::clone_of(&landing.borrow().fields));
        ref_for(index, data, record_type)
    }

    /// `updateRecord` of a landing the run built: merged in place.
    pub fn update_landing(&self, landing: &Rc<RefCell<Node>>, external_id: &Js, record_type: &str, fields: &Js) -> Js {
        let mut node = landing.borrow_mut();
        let mut written: Vec<String> = Vec::new();
        if let Js::Object(object) = fields {
            for (k, v) in object.entries() {
                node.fields.set(k.clone(), v.clone());
                written.push(k.clone());
            }
        }
        let mut order = node.field_order.clone();
        for field in written {
            if !order.contains(&field) {
                order.push(field);
            }
        }
        node.field_order = order;
        let index = match external_id {
            Js::String(id) => js::string_to_number(id),
            _ => f64::NAN,
        };
        let data = Js::object(JsObject::clone_of(&node.fields));
        // `unsupportedAssociation` of a write with no parents: 'none'.
        let mut reference = match ref_for_number(index, data, record_type) {
            Js::Object(object) => JsObject::clone_of(&object),
            _ => JsObject::new(),
        };
        reference.set("association".into(), Js::str("none"));
        Js::object(reference)
    }
}

/// Two bindings that are one record held twice (the TypeScript's object
/// identity).
fn same_binding(a: &Binding, b: &Binding) -> bool {
    match (a, b) {
        (Binding::Node(x), Binding::Node(y)) => Rc::ptr_eq(x, y),
        (Binding::Handle(x), Binding::Handle(y)) => Rc::ptr_eq(x, y),
        (Binding::Landed(x), Binding::Landed(y)) => Rc::ptr_eq(x, y),
        (Binding::Extracted { emission: x, .. }, Binding::Extracted { emission: y, .. }) => Rc::ptr_eq(x, y),
        (Binding::Event, Binding::Event) => true,
        _ => false,
    }
}

type Answering<'s> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Js, Failure>> + 's>>;

impl Run<'_> {
    /// One method of the store over a local edge, as local_edge_adapter.ts
    /// answers it.
    pub(crate) fn local_call<'s>(&'s self, edge: &'s LocalEdge, method: &'s str, args: Js) -> Answering<'s> {
        Box::pin(async move {
            let get = |key: &str| unique::get(&args, key);
            match method {
                "listEntryPoints" => Ok(Js::array(Vec::new())),
                // Nothing describes a local edge: no required-field gate, no
                // cardinality coercion.
                "describe" => Ok(Js::Null),
                "resolveEntity" => {
                    let record = get("record");
                    let constraints = get("constraints");
                    let record_type = get("recordType").to_js_string();
                    let landings = edge.all();
                    let mut candidates = Vec::new();
                    for (index, landing) in landings.iter().enumerate() {
                        let data = match landing {
                            Binding::Node(node) => Js::object(JsObject::clone_of(&node.borrow().fields)),
                            other if edge.references => self.reference_fields(other, &fields_of(&record, &constraints)).await?,
                            _ => continue,
                        };
                        if !landing_blocks(&constraints, &record, &data) {
                            continue;
                        }
                        candidates.push(ref_for(index, data, &record_type));
                        if candidates.len() >= LOCAL_CANDIDATE_CAP {
                            edge.capped.set(index < landings.len() - 1);
                            break;
                        }
                    }
                    Ok(env::object_of(vec![("candidates", Js::array(candidates))]))
                }
                "createRecord" => Ok(edge.create(&get("recordType").to_js_string(), &get("fields"))),
                "updateRecord" => {
                    let external_id = get("externalId");
                    if let Some(reference) = edge.reference_at(&external_id) {
                        let real = self.real_record(edge, &reference).await?;
                        let Js::Object(update) = &args else { unreachable!("an update is an object") };
                        let mut sent = JsObject::clone_of(update);
                        sent.set("recordType".into(), Js::str(real.record_type.clone()));
                        sent.set("externalId".into(), real.external_id.clone());
                        let updated = self.store_call(&real.adapter, "updateRecord", Js::object(sent)).await?;
                        if let Js::Object(object) = &updated
                            && object.get("notFound").is_some()
                        {
                            return Ok(updated);
                        }
                        // The id stays the store's, so the write finds the landing it hit.
                        let mut answered = match &updated {
                            Js::Object(object) => JsObject::clone_of(object),
                            _ => JsObject::new(),
                        };
                        answered.set("adapterType".into(), Js::str(LOCAL_ADAPTER_TYPE));
                        answered.set("externalId".into(), external_id);
                        answered.set("recordType".into(), get("recordType"));
                        return Ok(Js::object(answered));
                    }
                    match edge.landing_at(&external_id) {
                        Some(landing) => Ok(edge.update_landing(&landing, &external_id, &get("recordType").to_js_string(), &get("fields"))),
                        None => Ok(env::object_of(vec![("notFound", Js::Bool(true))])),
                    }
                }
                "readRecord" => {
                    let external_id = get("externalId");
                    if let Some(reference) = edge.reference_at(&external_id) {
                        let fields: Vec<String> = match get("fieldIds") {
                            Js::Array(list) => list.items().iter().map(Js::to_js_string).collect(),
                            _ => Vec::new(),
                        };
                        return self.reference_fields(&reference, &fields).await;
                    }
                    Ok(edge.landing_at(&external_id).map_or(Js::Null, |landing| Js::object(JsObject::clone_of(&landing.borrow().fields))))
                }
                "deleteRecord" => Err(plain_error(not_a_source(&edge.edge_name, "deleting a record"))),
                "getFieldValue" => Err(plain_error(not_a_source(&edge.edge_name, "reading a field"))),
                "getRelated" => Err(plain_error(not_a_source(&edge.edge_name, "traversing an edge"))),
                other => Err(Failure::engine("MOVENG_RUNTIME", format!("'{}' has no method '{other}'", edge.edge_name))),
            }
        })
    }

    /// `readReferenceFields`: the referenced record's current values for
    /// `fields`, read live, an absent one left out.
    async fn reference_fields(&self, landing: &Binding, fields: &[String]) -> Result<Js, Failure> {
        let mut values = JsObject::new();
        for field in fields {
            let read = self.landing_field(landing, field, field).await?;
            if !read.value.is_nullish() {
                values.set(field.clone(), read.value);
            }
        }
        Ok(Js::object(values))
    }

    /// `readLandingField`: a walked record through its adapter, anything
    /// else the run holds in hand.
    pub(crate) async fn landing_field(&self, landing: &Binding, field: &str, name: &str) -> Result<Evaluated, Failure> {
        match landing {
            Binding::Landed(landed) => self.landed_field(landed, field).await,
            other => self.read_binding_field(other, field, name),
        }
    }

    /// `realRecordOf`: the update destination of a reference, once.
    pub(crate) async fn real_record(&self, edge: &LocalEdge, landing: &Binding) -> Result<RealRecord, Failure> {
        if let Some((_, real)) = edge.real.borrow().iter().find(|(b, _)| same_binding(b, landing)) {
            return Ok(real.clone());
        }
        let alias = format!("{} landing", edge.edge_name);
        let (target, external_id) = self.position_target_of(&alias, Some(landing.clone()), &edge.scope, "update").await.map_err(crate::write::failure_of)?;
        let graph = target.graph.expect("a position write target is a system's");
        let real = RealRecord { adapter: target.adapter, record_type: target.record_type, graph, external_id };
        edge.real.borrow_mut().push((landing.clone(), real.clone()));
        Ok(real)
    }
}

/// A record's key, as `const { [key]: _, ...row } = record` drops it.
fn without(record: &Js, keys: &[&str]) -> JsObject {
    let mut row = JsObject::new();
    if let Js::Object(object) = record {
        for (k, v) in object.entries() {
            if !keys.contains(&k.as_str()) {
                row.set(k.clone(), v.clone());
            }
        }
    }
    row
}

/// `{edge, candidatesCapped?: true}`.
fn local_note(edge: &LocalEdge) -> Js {
    let mut note = vec![("edge", Js::str(edge.edge_name.clone()))];
    if edge.capped.get() {
        note.push(("candidatesCapped", Js::Bool(true)));
    }
    env::object_of(note)
}

impl Run<'_> {
    /// `executeLocalWrite`: a write into an edge of a node this run built,
    /// through the store over that edge. What it hands back is the landing
    /// itself; the firing log gets a `local` row, uncommitted.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn local_write(
        &self,
        write: &ast::WriteExpression,
        lines: &[Line],
        path: &ast::PathHead,
        node: Rc<RefCell<Node>>,
        binding_name: Option<&str>,
        scope: &Rc<Scope>,
    ) -> Result<Binding, Stop> {
        let root = root_name(path);
        let (edge_name, where_) = self.single_edge(path, "a linked write walks exactly one declared edge from its root")?;
        let at = format!("write {root}-[:{edge_name}]->");
        refuse_target_where(where_.is_some(), &at)?;
        if write.bind.is_some() {
            return Err(Stop::Thrown(Failure::unsupported(
                &format!("'bind' on a write into a node this run built ({at})"),
                "a binding is a correspondence between a record here and a record in a system; a landing on the run's own edge has no system to correspond with",
            )));
        }
        appendable(&node, &edge_name, &at, &root)?;
        let store = Rc::new(TargetAdapter::local(LocalEdge::of_edge(node, &edge_name, scope)));
        let target = Target::local(store.clone(), &edge_name);
        let fields = self.write_fields(lines, &store, &edge_name, scope).await?;
        let identity = self.unique_by_identity(&write.unique_by, &target)?;
        let constraints = unique::merge(&Js::Undefined, identity.branches.clone());
        let resolve_record = overlaid(&fields.fields, &identity.overlay);
        let locks = unique::identity_lock_requests(LOCAL_ADAPTER_TYPE, &edge_name, &constraints, &resolve_record, &fields.fields, self.version());
        let record = self
            .with_locks(locks, self.find_then_write(&target, &fields, &resolve_record, &constraints, &identity.narrowings, &[], scope))
            .await?;
        let edge = store.local_edge().expect("the store is the edge's");
        let external_id = unique::get(&record, "externalId");
        let Some(landing) = edge.landing_of(&external_id) else {
            return Err(Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("{at}: the write produced no landing on '{edge_name}'"))));
        };
        let Binding::Node(built) = &landing else {
            // It matched a reference, so the write was to the real record:
            // logged as one, against the system it reached.
            let real = self.real_record(edge, &landing).await.map_err(Stop::Thrown)?;
            let mut row = without(&record, &["externalId", "local"]);
            row.set("adapterType".into(), Js::str(real.adapter.adapter_type.clone()));
            row.set("recordType".into(), Js::str(real.record_type.clone()));
            row.set("externalId".into(), real.external_id.clone());
            row.set("committed".into(), Js::Bool(!real.adapter.dry));
            let destination = Target::bare(real.adapter.clone(), real.record_type.clone(), real.graph.clone());
            self.record_write(Js::object(row), None, scope, &destination, &fields.provenance);
            if let Some(name) = binding_name {
                scope.declare(name, landing.clone());
            }
            return Ok(landing);
        };
        self.landing_trails(built, &record, &fields.provenance);
        let mut row = without(&record, &["externalId"]);
        row.set("committed".into(), Js::Bool(false));
        row.set("local".into(), local_note(edge));
        self.record_local_write(row, &fields.provenance, binding_name);
        if let Some(name) = binding_name {
            scope.declare(name, landing.clone());
        }
        Ok(landing)
    }

    /// `executeLocalPositionWrite`: `write e { … }` where `e` is a landing on
    /// one of the run's own edges, merged into in place.
    pub(crate) async fn local_position_write(&self, alias: &str, lines: &[Line], landing: Rc<RefCell<Node>>, binding_name: Option<&str>, scope: &Rc<Scope>) -> Result<Binding, Stop> {
        let Some(edge_name) = landing.borrow().landed_on.clone() else {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!(
                    "'write {alias} {{ … }}' — '{alias}' is a node this run synthesised, not a record on one of its edges, so there is no record to update. Write it onto an edge ('write node-[:edge]-> {{ … }}') and update what that hands back"
                ),
            )));
        };
        let store = Rc::new(TargetAdapter::local(LocalEdge::of_landing(landing.clone(), &edge_name, scope)));
        let target = Target::local(store.clone(), &edge_name);
        let fields = self.write_fields(lines, &store, &edge_name, scope).await?;
        // The landing's own lock is the run's alone.
        let Some(record) = self.apply_update(&target, &Js::str("0"), &fields, &[], Vec::new()).await? else {
            return Err(Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("'write {alias} {{ … }}' — the landing on '{edge_name}' is gone"))));
        };
        self.landing_trails(&landing, &record, &fields.provenance);
        let mut row = without(&record, &["externalId"]);
        row.set("committed".into(), Js::Bool(false));
        row.set("local".into(), env::object_of(vec![("edge", Js::str(edge_name))]));
        self.record_local_write(row, &fields.provenance, binding_name);
        if let Some(name) = binding_name {
            scope.declare(name, Binding::Node(landing.clone()));
        }
        Ok(Binding::Node(landing))
    }

    /// `executeLocalMatch`: a match among the landings of a node this run
    /// built, by the identity a local write's means; it binds the landing.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn local_match(
        &self,
        m: &ast::MatchExpression,
        path: &ast::PathHead,
        node: Rc<RefCell<Node>>,
        binding_name: Option<&str>,
        scope: &Rc<Scope>,
        at: &str,
        on_miss: crate::verbs::OnMiss,
    ) -> Result<Binding, Stop> {
        let root = root_name(path);
        let (edge_name, where_) = self.single_edge(path, "a linked write walks exactly one declared edge from its root")?;
        refuse_target_where(where_.is_some(), at)?;
        appendable(&node, &edge_name, at, &root)?;
        let store = Rc::new(TargetAdapter::local(LocalEdge::of_edge(node, &edge_name, scope)));
        let target = Target::local(store.clone(), &edge_name);
        let lines: Vec<Line> = m.fields.iter().map(Line::of).collect();
        let fields = self.write_fields(&lines, &store, &edge_name, scope).await?;
        let identity = self.unique_by_identity(&m.unique_by, &target)?;
        let constraints = unique::merge(&Js::Undefined, identity.branches.clone());
        let resolve_record = overlaid(&fields.fields, &identity.overlay);
        let (matched, judge_unavailable) = self.resolve_identity(&target, &fields.fields, &resolve_record, &constraints, &identity.narrowings, scope).await?;
        let edge = store.local_edge().expect("the store is the edge's");
        let Some(landing) = matched.and_then(|m| edge.landing_of(&unique::get(&m, "externalId"))) else {
            let unavailable = judge_unavailable.as_ref().map(|j| format!(" (judge unavailable: {j})")).unwrap_or_default();
            let reason = format!("{at}: no landing on '{edge_name}' matched{unavailable}");
            return self.missed(on_miss, binding_name, scope, reason, judge_unavailable);
        };
        let mut row = JsObject::new();
        row.set("kind".into(), Js::str("match"));
        row.set("adapterType".into(), Js::str(LOCAL_ADAPTER_TYPE));
        row.set("recordType".into(), Js::str(edge_name));
        row.set("created".into(), Js::Bool(false));
        row.set("committed".into(), Js::Bool(false));
        row.set("writtenValues".into(), Js::object(JsObject::new()));
        row.set("provenance".into(), Js::object(JsObject::new()));
        row.set("local".into(), local_note(edge));
        self.record_local_write(row, &[], binding_name);
        if let Some(name) = binding_name {
            scope.declare(name, landing.clone());
        }
        Ok(landing)
    }

    /// `appendLocalLanding`: `link sent -[:posted]-> one` onto an edge of a
    /// node this run built. Nothing reaches a system, so nothing lands on the
    /// firing record: what grew is the run's own graph.
    pub(crate) fn append_landing(&self, from: &str, edge_name: &str, to_name: &str, node: &Rc<RefCell<Node>>, scope: &Scope) -> Result<(), Stop> {
        let at = format!("link {from} -[:{edge_name}]->");
        appendable(node, edge_name, &at, from)?;
        let Some(to) = scope.resolve(to_name) else {
            return Err(Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("'{to_name}' is not in scope — the checker should have caught this"))));
        };
        if !matches!(to, Binding::Event | Binding::Handle(_) | Binding::Landed(_) | Binding::Node(_) | Binding::Extracted { .. }) {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("{at} {to_name}: an edge lands on a position — '{to_name}' is {}", crate::write::describe_binding(&to)),
            )));
        }
        if let Binding::Node(landing) = &to
            && !Rc::ptr_eq(landing, node)
        {
            landing.borrow_mut().landed_on.get_or_insert_with(|| edge_name.to_string());
        }
        let mut owner = node.borrow_mut();
        if let Binding::Node(landing) = &to
            && Rc::ptr_eq(landing, node)
        {
            owner.landed_on.get_or_insert_with(|| edge_name.to_string());
        }
        let edge = owner.edges.iter_mut().find(|(n, _)| n == edge_name).map(|(_, e)| e).expect("checked appendable above");
        edge.landings.push(to);
        Ok(())
    }

    /// Each field the write sent, its trail onto the landing; a field the
    /// write suppressed keeps the trail it had.
    fn landing_trails(&self, landing: &Rc<RefCell<Node>>, record: &Js, provenance: &[(String, Option<crate::env::Trail>)]) {
        let Js::Object(written) = unique::get(record, "writtenValues") else { return };
        let mut node = landing.borrow_mut();
        for (field, _) in written.entries() {
            let trail = provenance.iter().find(|(n, _)| n == field).and_then(|(_, t)| t.clone()).unwrap_or_default();
            match node.field_provenance.iter_mut().find(|(f, _)| f == field) {
                Some(slot) => slot.1 = trail,
                None => node.field_provenance.push((field.clone(), trail)),
            }
        }
    }

    /// `recordLocalWrite`: the firing-log row of a write with no system
    /// behind it.
    fn record_local_write(&self, mut row: JsObject, provenance: &[(String, Option<crate::env::Trail>)], binding_name: Option<&str>) {
        self.summarise_written(&mut row, provenance, binding_name);
        let write_index = self.writes.borrow().len();
        row.set("origin".into(), env::object_of(vec![("kind", Js::str("write")), ("writeIndex", Js::Number(write_index as f64))]));
        self.append_write(Rc::new(crate::write::WriteRecord { object: Js::object(row) }));
    }

    /// What an update of a local landing holds (`updateLocks`): nothing the
    /// host sees for a landing the run built; for a reference, the real
    /// record and the identity keys a direct write by the same `unique by`
    /// takes in its system.
    pub(crate) async fn local_update_locks(&self, edge: &LocalEdge, external_id: &Js, constraints: &Js, resolve_record: &Js, fields: &Js) -> Result<Vec<crate::flow::LockRequest>, Failure> {
        match edge.landing_of(external_id) {
            None => Ok(vec![crate::flow::LockRequest::exclusive(unique::record_lock_name(LOCAL_ADAPTER_TYPE, external_id))]),
            Some(Binding::Node(_)) => Ok(Vec::new()),
            Some(reference) => {
                let real = self.real_record(edge, &reference).await?;
                let mut locks = vec![crate::flow::LockRequest::exclusive(unique::record_lock_name(&real.adapter.adapter_type, &real.external_id))];
                locks.extend(unique::identity_lock_requests(&real.adapter.adapter_type, &real.record_type, constraints, resolve_record, fields, self.version()));
                Ok(locks)
            }
        }
    }
}

/// The name a target's path is rooted at.
fn root_name(path: &ast::PathHead) -> String {
    match &path.root {
        Some(ast::PathRoot::Name { name }) => name.clone(),
        _ => String::new(),
    }
}

/// `{...fields, ...identity.valueOverlay}`.
fn overlaid(fields: &Js, overlay: &[(String, Js)]) -> Js {
    let mut record = match fields {
        Js::Object(object) => JsObject::clone_of(object),
        _ => JsObject::new(),
    };
    for (k, v) in overlay {
        record.set(k.clone(), v.clone());
    }
    Js::object(record)
}

/// `refuseLocalTargetWhere`.
fn refuse_target_where(has_where: bool, at: &str) -> Result<(), Stop> {
    if !has_where {
        return Ok(());
    }
    Err(Stop::Thrown(Failure::unsupported(
        &format!("WHERE on the target of '{at}' — an edge of a node this run built"),
        "say which landing you mean in 'unique by (…)' instead",
    )))
}

/// The node holds the edge the statement appends to.
fn appendable(node: &Rc<RefCell<Node>>, edge: &str, at: &str, root: &str) -> Result<(), Stop> {
    if node.borrow().edges.iter().any(|(n, e)| n == edge && e.deferred.is_none()) {
        return Ok(());
    }
    Err(Stop::Thrown(Failure::engine(
        "MOVENG_RUNTIME",
        format!("{at}: '{root}' has no appendable edge '{edge}' — the checker should have caught this"),
    )))
}

/// `new Error(message)`.
fn plain_error(message: String) -> Failure {
    Failure::Engine { class: ErrorClass::Error, message }
}

/// `refFor`: `{adapterType: 'local', externalId: String(index), recordType, data}`.
pub fn ref_for(index: usize, data: Js, record_type: &str) -> Js {
    ref_for_number(index as f64, data, record_type)
}

fn ref_for_number(index: f64, data: Js, record_type: &str) -> Js {
    env::object_of(vec![
        ("adapterType", Js::str(LOCAL_ADAPTER_TYPE)),
        ("externalId", Js::str(js::number_to_string(index))),
        ("recordType", Js::str(record_type)),
        ("data", data),
    ])
}

/// `landingFieldOrder`: what the declaration names, then what a write carried
/// beyond it.
fn landing_field_order(declared: &[String], written: &JsObject) -> Vec<String> {
    let mut order = declared.to_vec();
    for (field, _) in written.entries() {
        if !declared.contains(field) {
            order.push(field.clone());
        }
    }
    order
}

/// `landingEdges`: one empty appendable edge per nested node the declaration
/// names, each carrying its own nested names.
fn landing_edges(shape: Option<&LandingShape>) -> Vec<(String, Edge)> {
    shape.map_or_else(Vec::new, |shape| {
        shape.edges.iter().map(|(name, nested)| (name.clone(), Edge { landings: Vec::new(), shape: Some(nested.clone()), deferred: None })).collect()
    })
}

/// `normaliseIdentityValue`: trimmed, case folded, whitespace collapsed; a
/// list folds to its values in order.
pub fn normalise_identity_value(value: &Js) -> String {
    let flat = match value {
        Js::Undefined | Js::Null => return String::new(),
        Js::Array(list) => list.items().iter().filter(|v| !v.is_nullish()).map(Js::to_js_string).collect::<Vec<_>>().join(" "),
        other => other.to_js_string(),
    };
    let lowered = js::to_lower_case(js::trim(&flat));
    let mut collapsed = String::with_capacity(lowered.len());
    let mut in_space = false;
    for c in lowered.chars() {
        if js::is_js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    collapsed
}

/// `identityValuesEqual`: an absent asserted value identifies nothing.
pub fn identity_values_equal(a: &Js, b: &Js) -> bool {
    let left = normalise_identity_value(a);
    !left.is_empty() && left == normalise_identity_value(b)
}

/// `hostnameLabels`: a hostname-shaped value's registrable-domain labels.
fn hostname_labels(normalised: &str) -> Option<Vec<String>> {
    let shape = crate::js_regex::Regex::new(HOSTNAME_SHAPE).expect("the hostname shape is a valid pattern");
    let found = shape.exec(normalised)?;
    let labels = found.get(1).cloned().flatten()?;
    Some(String::from_utf16_lossy(&labels).split('.').map(String::from).collect())
}

/// `distinctiveTokens`: the words of a value, the kind-naming ones dropped.
pub fn distinctive_tokens(value: &Js) -> Vec<String> {
    let normalised = normalise_identity_value(value);
    let source = match hostname_labels(&normalised) {
        Some(labels) => labels.join(" "),
        None => normalised,
    };
    source
        .split(|c: char| !crate::letter_number::is_letter_or_number(c))
        .filter(|word| !word.is_empty() && !GENERIC_TOKENS.contains(word))
        .map(String::from)
        .collect()
}

/// `sharesDistinctiveToken`: exactness where one side has no distinctive word.
pub fn shares_distinctive_token(a: &Js, b: &Js) -> bool {
    let left = distinctive_tokens(a);
    let right = distinctive_tokens(b);
    if left.is_empty() || right.is_empty() {
        return identity_values_equal(a, b);
    }
    right.iter().any(|token| left.contains(token))
}

/// `landingBlocks`: whether a landing satisfies some whole branch of the
/// write's identity.
pub fn landing_blocks(constraints: &Js, asserted: &Js, data: &Js) -> bool {
    unique::branches(constraints).iter().any(|branch| {
        let entries = unique::entries(branch);
        !entries.is_empty()
            && entries.iter().all(|entry| {
                let field = unique::field_of(entry);
                let (mine, theirs) = (unique::get(asserted, &field), unique::get(data, &field));
                if unique::is_fuzzy(entry) { shares_distinctive_token(&mine, &theirs) } else { identity_values_equal(&mine, &theirs) }
            })
    })
}

/// `fieldsOf`: the fields a candidate is compared and merged by.
pub fn fields_of(record: &Js, constraints: &Js) -> Vec<String> {
    let mut fields: Vec<String> = Vec::new();
    if let Js::Object(object) = record {
        for (k, _) in object.entries() {
            if !fields.contains(k) {
                fields.push(k.clone());
            }
        }
    }
    for branch in unique::branches(constraints) {
        for entry in unique::entries(&branch) {
            let field = unique::field_of(&entry);
            if !fields.contains(&field) {
                fields.push(field);
            }
        }
    }
    fields
}

/// The error a store raises for what no local edge does (`notASource`).
pub fn not_a_source(edge: &str, what: &str) -> String {
    format!(
        "'{edge}' is an edge of a node this run built — it holds what the run wrote, so {what} off it goes through the node's own landings, not through an adapter"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_normalise_and_compare_as_the_store_compares_them() {
        assert_eq!(normalise_identity_value(&Js::str("  Acme \t  Corp\n")), "acme corp");
        assert_eq!(normalise_identity_value(&Js::array(vec![Js::str("A"), Js::Null, Js::Number(2.0)])), "a 2");
        assert!(!identity_values_equal(&Js::str(" "), &Js::str("")));
        assert!(identity_values_equal(&Js::str("ACME"), &Js::str("acme ")));
    }

    #[test]
    fn a_fuzzy_block_shares_a_distinctive_word() {
        assert_eq!(distinctive_tokens(&Js::str("Faction AI, Inc.")), ["faction"]);
        assert!(!shares_distinctive_token(&Js::str("Actions AI"), &Js::str("Faction AI")));
        assert!(shares_distinctive_token(&Js::str("Faction AI"), &Js::str("Faction")));
        // Nothing but kind words: exactness.
        assert!(shares_distinctive_token(&Js::str("AI Labs"), &Js::str("ai labs")));
        assert!(!shares_distinctive_token(&Js::str("AI Labs"), &Js::str("AI")));
        // A bare domain tokenises from its registrable labels.
        assert_eq!(distinctive_tokens(&Js::str("https://www.oriqx.com/about")), ["oriqx"]);
        assert!(!shares_distinctive_token(&Js::str("oriqx.com"), &Js::str("pavoai.com")));
        // Letters of every script are words; a combining vowel sign is not a
        // letter, so it splits a word as the JavaScript split does.
        assert_eq!(distinctive_tokens(&Js::str("Café-Zürich")), ["café", "zürich"]);
        assert_eq!(distinctive_tokens(&Js::str("हिंदी")), ["ह", "द"]);
    }
}
