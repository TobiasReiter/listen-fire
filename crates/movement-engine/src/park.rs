//! A flow parked and resumed: serialize.ts's `ParkedScopeState` (version 1),
//! written and read exactly as the TypeScript engine writes and reads it, so
//! a run parked by either engine resumes on either.
//!
//! - **Park** (`sleep`): the leaf's address, `bindingName` (and
//!   `presenceBind` for `x = await sleep(…)`), and the scope chain root
//!   first — the file scope, the movement's, one per `if` arm descended —
//!   each scope's own bindings in declaration order, as `serializeBinding`
//!   writes them for the kinds this engine holds: `event`, `instance`,
//!   `opaque`, `movement`, `value` (its JSON round trip and its trail's
//!   origins) and `handle` (the write record itself, its type and graph).
//! - **Suspension** (run.ts `suspendFlow`): the flow stops just before a
//!   statement, its state `suspended`, with a `journal` of the calls the
//!   statement had finished — always empty here, as this engine runs no
//!   calls. A flow suspends when the run meets its cost cap (the statement
//!   about to spend: `suspendAtLimit`, which first marks the run paused,
//!   `commitLimitPause`, and says so on the trace), at each statement of a
//!   run already paused (`limitPaused`), and at a `suspendAt` address. A
//!   host whose sink cannot suspend (it serves no `commitSuspension`, read
//!   off `SegmentInput::serves`) is asked nothing, and the run goes on (a
//!   pause), fails on its cap, or fails for want of a park (`suspendAt`), as
//!   the TypeScript does.
//! - **Resume** (`resumeAlongAddress`): the movement's scope re-layered from
//!   the chain's second entry, each `if` arm on the address descended with
//!   its scope rehydrated, the leaf stepped past (or re-entered: a
//!   suspension's operator resume), then each enclosing body finished from
//!   the statement after its container.
//!
//! A state holding anything else (frames, a journal with calls in it, an
//! `until`, a binding of another kind) is not this engine's to resume:
//! `resume_refusal` refuses it, before the run asks its host for anything,
//! and the shim resumes it on the TypeScript engine.

use std::cell::RefCell;
use std::rc::Rc;

use movement_parser::ast::{MovementDeclaration, Statement};
use movement_parser::catalog::helpers::credential_arg_of;
use movement_parser::catalog::snapshot::Args;
use serde::Deserialize;
use serde_json::Value as Json;

use crate::bindings::{Binding, Handle, InstanceBinding, Node, Scope};
use crate::env::{Trail, ValueBinding};
use crate::env::{encode_plain, json_round_trip, object_of};
use crate::host;
use crate::ledger::CapExceeded;
use crate::trace::TraceEntry;
use crate::js::{Js, JsObject};
use crate::run::{Address, Failure, Flow, Run, Stop};
use crate::write::WriteRecord;

/// What a resumed segment is handed (`ResumeMovementInput`'s state and mode).
#[derive(Debug, Clone, Deserialize)]
pub struct ResumeInput {
    /// On the eval wire (crate::env): its objects in their stored key order.
    pub state: Json,
    /// Re-enter AT the parked statement rather than step past it.
    #[serde(default)]
    pub reenter: bool,
}

/// `{version: 1, address, bindingName, presenceBind?, scopeChain}`, as the
/// JavaScript object the TypeScript writes: every key in its order (it
/// crosses to the host on the eval wire).
pub(crate) fn parked_state(run: &Run<'_>, address: &str, presence: Option<&str>, scope: &Rc<Scope>) -> Result<Js, Failure> {
    let mut state = vec![
        ("version", Js::Number(1.0)),
        ("address", Js::str(address)),
        ("bindingName", presence.map_or(Js::Null, Js::str)),
    ];
    if presence.is_some() {
        state.push(("presenceBind", Js::Bool(true)));
    }
    state.push(("scopeChain", scope_chain(run, scope)?));
    Ok(object_of(state))
}

/// `{version: 1, address, bindingName: null, suspended: true, journal: [],
/// scopeChain}`, as `suspendFlow` writes it.
pub(crate) fn suspended_state(run: &Run<'_>, address: &str, scope: &Rc<Scope>) -> Result<Js, Failure> {
    Ok(object_of(vec![
        ("version", Js::Number(1.0)),
        ("address", Js::str(address)),
        ("bindingName", Js::Null),
        ("suspended", Js::Bool(true)),
        ("journal", Js::array(Vec::new())),
        ("scopeChain", scope_chain(run, scope)?),
    ]))
}

/// The scopes root first, as one park writes them.
fn scope_chain(run: &Run<'_>, scope: &Rc<Scope>) -> Result<Js, Failure> {
    // One table for the whole state: a node two scopes hold is written once.
    let mut park = Vec::new();
    Ok(Js::array(scope.chain_from_root().iter().map(|s| serialize_scope(run, s, &mut park)).collect::<Result<_, _>>()?))
}

/// The nodes one park has written, numbered as first reached (`ParkWriter`).
type ParkWriter = Vec<*const RefCell<Node>>;

fn serialize_scope(run: &Run<'_>, scope: &Scope, park: &mut ParkWriter) -> Result<Js, Failure> {
    let mut bindings = JsObject::new();
    for (name, binding) in scope.own_bindings() {
        bindings.set(name.clone(), serialize_binding(run, &name, &binding, park)?);
    }
    Ok(object_of(vec![("bindings", Js::object(bindings))]))
}

/// `serializeBinding`, for the kinds this engine binds.
fn serialize_binding(run: &Run<'_>, name: &str, binding: &Binding, park: &mut ParkWriter) -> Result<Js, Failure> {
    let kind = |k: &str| ("kind", Js::str(k));
    Ok(match binding {
        Binding::Node(node) => {
            let address = Rc::as_ptr(node);
            if let Some(id) = park.iter().position(|p| *p == address) {
                return Ok(object_of(vec![kind("nodeRef"), ("id", Js::Number(id as f64))]));
            }
            // Numbered before its edges are walked: an edge back here is a
            // reference, not another lap.
            let id = park.len();
            park.push(address);
            let node = node.borrow();
            let mut edges = JsObject::new();
            for (edge, landings) in &node.edges {
                let landings: Vec<Js> = landings.iter().map(|l| serialize_binding(run, "", l, park)).collect::<Result<_, _>>()?;
                edges.set(edge.clone(), object_of(vec![kind("landed"), ("landings", Js::array(landings))]));
            }
            let mut provenance = JsObject::new();
            for (field, trail) in &node.field_provenance {
                provenance.set(field.clone(), provenance_of(run, trail));
            }
            let mut members = vec![
                kind("nodePosition"),
                ("id", Js::Number(id as f64)),
                ("fields", Js::object(JsObject::clone_of(&node.fields))),
                ("fieldOrder", Js::array(node.field_order.iter().map(|f| Js::str(f.clone())).collect())),
                ("fieldProvenance", Js::object(provenance)),
            ];
            if let Some(edge) = &node.landed_on {
                members.push(("landedOn", Js::str(edge.clone())));
            }
            members.push(("edges", Js::object(edges)));
            object_of(members)
        }
        Binding::Event => object_of(vec![kind("event")]),
        Binding::Instance(instance) => object_of(vec![kind("instance"), ("instance", identity(instance))]),
        Binding::Opaque => object_of(vec![kind("opaque"), ("what", Js::str("import")), ("name", Js::str(name))]),
        Binding::Movement(movement) => object_of(vec![kind("movement"), ("name", Js::str(movement.clone()))]),
        Binding::Shape(shape) => object_of(vec![kind("shape"), ("name", Js::str(shape.clone()))]),
        // A plugin travels as the import it is, re-resolved by its slot name.
        Binding::Plugin(_) => object_of(vec![kind("opaque"), ("what", Js::str("a plugin")), ("name", Js::str(name))]),
        Binding::Handle(handle) => object_of(vec![
            kind("handle"),
            ("handle", handle.record.object.clone()),
            ("targetType", Js::str(handle.target_type.clone())),
            ("graph", object_of(vec![kind("instance"), ("instance", identity(&handle.graph))])),
        ]),
        Binding::Value(value) => {
            // `assertJsonSerializable`: the value as it will come back.
            let mut descriptor = vec![kind("value"), ("value", json_round_trip(&value.value))];
            if let Some(trail) = &value.trail {
                descriptor.push(("provenance", provenance_of(run, trail)));
            }
            if value.many {
                descriptor.push(("many", Js::Bool(true)));
            }
            object_of(descriptor)
        }
        // A record a pick bound (`top = FIRST(…)`): admission refuses every
        // park inside a block, so no hop alias reaches here. Its read is
        // named only when it is not the event's source (the TypeScript binds
        // none there), and a pick keeps no edge properties.
        Binding::Landed(landed) => {
            let mut descriptor = vec![kind("sourcePosition"), ("position", json_round_trip(&landed.position))];
            if let Some(properties) = &landed.edge_properties {
                descriptor.push(("edgeProperties", json_round_trip(properties)));
            }
            let from_source = run.source.borrow().as_ref().is_some_and(|source| Rc::ptr_eq(&source.read, &landed.read));
            if !from_source {
                descriptor.push(("read", object_of(vec![("instanceName", Js::str(landed.read.instance_name.clone()))])));
            }
            object_of(descriptor)
        }
        Binding::Positions(landings) => {
            let landings: Vec<Js> = landings.iter().map(|l| serialize_binding(run, "", l, park)).collect::<Result<_, _>>()?;
            object_of(vec![kind("positions"), ("landings", Js::array(landings))])
        }
        // The extraction ran: its output is data, never run again.
        Binding::Extracted { emission, root } => object_of(vec![
            kind(if *root { "extractRoot" } else { "extractPosition" }),
            ("emission", emission.descriptor(&|id| run.origin(id))),
        ]),
    })
}

/// `serializeInstanceIdentity`.
fn identity(instance: &InstanceBinding) -> Js {
    let mut identity = vec![("name", Js::str(instance.name.clone())), ("adapterSlug", Js::str(instance.adapter_slug.clone()))];
    if let Some(credential) = &instance.credential_name {
        identity.push(("credentialName", Js::str(credential.clone())));
    }
    if !instance.construction_config.is_empty() {
        let mut config = JsObject::new();
        for (k, v) in &instance.construction_config {
            config.set(k.clone(), Js::str(v.clone()));
        }
        identity.push(("constructionConfig", Js::object(config)));
    }
    object_of(identity)
}

/// A trail as the TypeScript's `Provenance`: the origins themselves.
fn provenance_of(run: &Run<'_>, trail: &Trail) -> Js {
    let origins = run.origins.borrow();
    let origin = |id: &u32| origins.get(*id as usize).cloned().unwrap_or(Js::Null);
    let mut provenance = vec![("origins", Js::array(trail.origins.iter().map(origin).collect()))];
    if let Some(direct) = &trail.direct {
        provenance.push(("direct", origin(direct)));
    }
    object_of(provenance)
}

/// Why this engine does not resume `state` (on the eval wire), or `None`
/// when it does: a timer park's or a suspension's state of version 1 — no
/// frames, no call in its journal, no `until` — whose address steps only
/// into `if` arms, and whose scopes hold only the binding kinds this engine
/// binds, with no extraction among their origins and no record held in a
/// value.
pub fn resume_refusal(state: &Json) -> Option<String> {
    let Ok(state) = crate::env::decode(state) else { return Some("resume_state_does_not_read".into()) };
    if !matches!(at(&state, "version"), Some(Js::Number(n)) if *n == 1.0) {
        return Some("resume_state_version".into());
    }
    for (key, reason) in [("frames", "resume_state_frames"), ("until", "resume_state_until")] {
        if at(&state, key).is_some() {
            return Some(reason.into());
        }
    }
    // A journal of calls to replay is a call this engine would have to run.
    if at(&state, "journal").is_some_and(|journal| !matches!(journal, Js::Array(list) if list.items.is_empty())) {
        return Some("resume_state_journal".into());
    }
    if at(&state, "suspended").is_some_and(|suspended| !matches!(suspended, Js::Bool(true))) {
        return Some("resume_state_suspended".into());
    }
    if !text(at(&state, "address")).is_some_and(steps_only_into_if_arms) {
        return Some("resume_state_address".into());
    }
    let scopes = items(at(&state, "scopeChain"));
    // The file scope is rebuilt from the program on resume (`prepare`), as
    // the TypeScript re-derives its declarations by name: a declared shape
    // there is the program's, not the state's.
    let file_shape = |i: usize, descriptor: &Js| i == 0 && text(at(descriptor, "kind")) == Some("shape");
    scopes
        .iter()
        .enumerate()
        .flat_map(|(i, scope)| pairs(at(scope, "bindings")).into_iter().map(move |(_, d)| (i, d)))
        .find_map(|(i, descriptor)| if file_shape(i, descriptor) { None } else { descriptor_refusal(descriptor) })
}

/// `/^s\d+(\.b\d+\.s\d+)*$/`.
fn steps_only_into_if_arms(address: &str) -> bool {
    let steps: Vec<&str> = address.split('.').collect();
    steps.len() % 2 == 1
        && steps.iter().enumerate().all(|(i, step)| {
            let kind = if i % 2 == 0 { 's' } else { 'b' };
            step.strip_prefix(kind).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        })
}

fn descriptor_refusal(descriptor: &Js) -> Option<String> {
    let plain = |provenance: Option<&Js>| {
        let Some(provenance) = provenance else { return true };
        items(at(provenance, "origins")).iter().chain(at(provenance, "direct")).all(|o| text(at(o, "kind")) != Some("extraction"))
    };
    match text(at(descriptor, "kind")) {
        Some("event" | "instance" | "opaque" | "movement" | "handle" | "nodeRef") => None,
        Some("value") => {
            if !plain(at(descriptor, "provenance")) {
                return Some("resume_state_extraction_origin".into());
            }
            let value = at(descriptor, "value").unwrap_or(&Js::Undefined);
            crate::eval::holds_binding(value, true).then(|| "resume_state_value_holds_record".into())
        }
        Some("nodePosition") => {
            if !pairs(at(descriptor, "fieldProvenance")).iter().all(|(_, p)| plain(Some(p))) {
                return Some("resume_state_extraction_origin".into());
            }
            for (_, edge) in pairs(at(descriptor, "edges")) {
                if text(at(edge, "kind")) != Some("landed") || at(edge, "landing").is_some() || at(edge, "landingShape").is_some() {
                    return Some("resume_state_deferred_edge".into());
                }
                if let Some(reason) = items(at(edge, "landings")).iter().find_map(descriptor_refusal) {
                    return Some(reason);
                }
            }
            None
        }
        // A bound block that returned nothing; returned records are the
        // TypeScript engine's to resume.
        Some("positions") if items(at(descriptor, "landings")).is_empty() => None,
        Some("positions") => Some("resume_state_returned_records".into()),
        other => Some(format!("resume_state_kind:{}", other.unwrap_or("undefined"))),
    }
}

// ── Suspension ──

impl Run<'_> {
    /// Before a statement (run.ts `interpretBody`): a paused run's flow
    /// suspends where it can, and a `suspendAt` address suspends it, once.
    pub(crate) async fn suspend_before(&self, at: &Address, scope: &Rc<Scope>) -> Result<(), Stop> {
        if self.limit_paused.get() && self.can_suspend() {
            return Err(self.suspend_flow(at, scope).await?);
        }
        let address = at.encode();
        let pending = {
            let mut pending = self.pending_suspensions.borrow_mut();
            pending.iter().position(|a| *a == address).map(|i| pending.remove(i))
        };
        if pending.is_some() {
            return Err(if self.can_suspend() { self.suspend_flow(at, scope).await? } else { nowhere_to_park(&address) });
        }
        Ok(())
    }

    /// `suspendAtLimit`: the run met its cost cap in the statement at `at`.
    /// The first time, the run is marked paused and says so; then the flow
    /// suspends just before the statement. What the statement ends with: the
    /// park, or, where the sink cannot suspend, the cap as the run's failure.
    pub(crate) async fn suspend_at_limit(&self, cap: CapExceeded, at: &Address, scope: &Rc<Scope>) -> Stop {
        match self.pause_at_limit(cap, at, scope).await {
            Ok(stop) | Err(stop) => stop,
        }
    }

    async fn pause_at_limit(&self, cap: CapExceeded, at: &Address, scope: &Rc<Scope>) -> Result<Stop, Stop> {
        if !self.can_suspend() {
            return Ok(Stop::Thrown(Failure::CapExceeded(cap)));
        }
        if !self.limit_paused.get() {
            // A sink that can suspend but keeps no pause is skipped, as
            // `commitLimitPause?.` skips it.
            if self.serves("park.sink.commitLimitPause") {
                self.ask(host::park::commit_limit_pause(self.segment(), &cap)).await.map_err(Stop::Thrown)?;
            }
            self.limit_paused.set(true);
            self.trace(TraceEntry::Warning { code: "RUN_PAUSED_COST_CAP".into(), message: cap.paused_message() });
        }
        self.suspend_flow(at, scope).await
    }

    /// run.ts `canSuspend`: the host's park sink commits suspensions.
    fn can_suspend(&self) -> bool {
        self.serves("park.sink.commitSuspension")
    }

    /// `suspendFlow`: the suspended state committed and the flow parked at
    /// `at`. Asked only where the sink can suspend.
    async fn suspend_flow(&self, at: &Address, scope: &Rc<Scope>) -> Result<Stop, Stop> {
        let address = at.encode();
        let state = suspended_state(self, &address, scope).map_err(Stop::Thrown)?;
        let request = host::park::commit_suspension(self.segment(), &address, encode_plain(&state));
        self.ask(request).await.map_err(Stop::Thrown)?;
        self.trace(TraceEntry::Gate { outcome: false });
        Ok(Stop::Parked(address))
    }
}

fn nowhere_to_park(address: &str) -> Stop {
    Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("the run was asked to suspend at '{address}' and has nowhere durable to park")))
}

// ── Resume ──

impl Run<'_> {
    /// `resumeAlongAddress` for a leaf inside `if` arms of the dispatched
    /// movement's body.
    pub(crate) async fn resume(&self, resume: &crate::park::ResumeInput, movement: &MovementDeclaration, scope: &Rc<Scope>, path: &str) -> Result<(), Stop> {
        // The state as it was stored, keys in their stored order (on the eval
        // wire, as the event is): values, records and configs keep it.
        let state = &crate::env::decode(&resume.state).map_err(|e| Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("the parked state does not read: {e}"))))?;
        let state_address = text(at(state, "address")).unwrap_or("").to_string();
        let malformed = |why: &str| {
            Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("malformed parked address '{state_address}' — {why}"),
            ))
        };
        let address = parse_address(&state_address)
            .ok_or_else(|| malformed("its steps do not read"))?;
        if address.last().is_none_or(|(kind, _)| *kind != 's') {
            return Err(malformed("a parked leaf ends at a statement"));
        }
        let chain: Vec<Js> = items(at(state, "scopeChain")).to_vec();
        let park = ParkReader::default();
        self.rehydrate_into(chain.get(1), scope, &park)?;

        // The descent: each statement step but the last is an `if` the
        // address branches into.
        struct Level {
            statements: Vec<Statement>,
            scope: Rc<Scope>,
            address: Address,
            path: String,
            container: usize,
        }
        let mut spine: Vec<Level> = Vec::new();
        let mut statements = movement.body.clone();
        let mut current = scope.clone();
        let mut frame = Address::default();
        let mut at_path = path.to_string();
        let mut chain_index = 2;
        let mut i = 0;
        while i + 1 < address.len() {
            let (kind, index) = address[i];
            let (descent, branch) = address[i + 1];
            // Admission resumes no other address (`resume_refusal`), and runs
            // no other container (crate::admit).
            if kind != 's' || descent != 'b' {
                return Err(malformed(&format!("step {} is '{descent}', which this engine does not descend", i + 1)));
            }
            let Some(Statement::If(container)) = statements.get(index) else {
                return Err(Stop::Thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!(
                        "resume: address descends 'branch' into a statement other than `if` (parked '{state_address}')"
                    ),
                )));
            };
            let (body, body_path) = match container.arms.get(branch) {
                Some(arm) => (arm.body.clone(), format!("{at_path}/{index}/arms/{branch}/body")),
                None => match &container.else_arm {
                    Some(arm) => (arm.body.clone(), format!("{at_path}/{index}/elseArm/body")),
                    None => {
                        return Err(Stop::Thrown(Failure::engine(
                            "MOVENG_RUNTIME",
                            format!(
                                "resume: if branch {branch} has no body (parked '{state_address}')"
                            ),
                        )));
                    }
                },
            };
            let child = current.child();
            self.rehydrate_into(chain.get(chain_index), &child, &park)?;
            chain_index += 1;
            spine.push(Level { statements: statements.clone(), scope: current.clone(), address: frame.clone(), path: at_path.clone(), container: index });
            frame = frame.stmt(index).branch(branch);
            statements = body;
            current = child;
            at_path = body_path;
            i += 2;
        }
        if let Some(id) = park.unfilled() {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("the parked state refers to run-built node(s) #{id} that it never wrote"),
            )));
        }
        let (_, leaf) = address[address.len() - 1];
        let binding_name = text(at(state, "bindingName"));
        if !resume.reenter
            && matches!(at(state, "presenceBind"), Some(Js::Bool(true)))
            && let Some(name) = binding_name
        {
            current.declare(name, Binding::Value(ValueBinding { value: Js::Bool(true), trail: Some(Trail::default()), many: false }));
        }
        let mut flow = if resume.reenter {
            self.body(&statements, &current, &frame, &at_path, leaf).await?
        } else if matches!(statements.get(leaf), Some(Statement::Return(_))) {
            Flow::Returned
        } else {
            self.body(&statements, &current, &frame, &at_path, leaf + 1).await?
        };
        // Each enclosing body goes on from the statement after its `if`; a
        // `return` inside an arm returns from the movement.
        while let Some(level) = spine.pop() {
            if let Flow::Returned = flow {
                break;
            }
            flow = self.body(&level.statements, &level.scope, &level.address, &level.path, level.container + 1).await?;
        }
        Ok(())
    }

    /// `rehydrateScopeInto`: a scope's bindings declared into `scope`, the
    /// trigger's own live ones kept.
    fn rehydrate_into(&self, serialized: Option<&Js>, scope: &Rc<Scope>, park: &ParkReader) -> Result<(), Stop> {
        let Some(bindings) = serialized.and_then(|s| at(s, "bindings")) else { return Ok(()) };
        for (name, descriptor) in pairs(Some(bindings)) {
            let kind = text(at(descriptor, "kind")).unwrap_or("");
            if scope.resolve(name).is_some() && matches!(kind, "event" | "instance" | "movement" | "shape") {
                continue;
            }
            // Past `prepareMovement` the run has touched its source, so what
            // does not rehydrate fails the run, as it does on TypeScript.
            let binding = self.rehydrate(descriptor, park).map_err(|e| Stop::Thrown(Failure::engine("MOVENG_RUNTIME", e)))?;
            scope.declare(name.clone(), binding);
        }
        Ok(())
    }

    /// `rehydrateBinding`, for the kinds this engine binds.
    fn rehydrate(&self, descriptor: &Js, park: &ParkReader) -> Result<Binding, String> {
        match text(at(descriptor, "kind")) {
            Some("nodeRef") => Ok(Binding::Node(park.numbered(id_of(at(descriptor, "id")).ok_or("a nodeRef without an id")?))),
            Some("nodePosition") => {
                let node = match id_of(at(descriptor, "id")) {
                    Some(id) => {
                        let node = park.numbered(id);
                        park.filled(id);
                        node
                    }
                    None => Rc::new(RefCell::new(Node::default())),
                };
                let fields = pairs(at(descriptor, "fields")).to_vec();
                let order: Vec<String> = match at(descriptor, "fieldOrder") {
                    Some(order) => items(Some(order)).iter().filter_map(|f| text(Some(f)).map(String::from)).collect(),
                    None => fields.iter().map(|(k, _)| k.clone()).collect(),
                };
                // `inOrder`: the order kept, then whatever else the map holds.
                let mut ordered = JsObject::new();
                for key in &order {
                    if let Some((_, value)) = fields.iter().find(|(k, _)| k == key) {
                        ordered.set(key.clone(), value.clone());
                    }
                }
                for (key, value) in &fields {
                    if ordered.get(key).is_none() {
                        ordered.set(key.clone(), value.clone());
                    }
                }
                let mut provenance = Vec::new();
                for (field, trail) in pairs(at(descriptor, "fieldProvenance")) {
                    provenance.push((field.clone(), self.rehydrate_trail(trail)?));
                }
                let mut edges = Vec::new();
                for (edge, landed) in pairs(at(descriptor, "edges")) {
                    if text(at(landed, "kind")) != Some("landed") {
                        return Err("a deferred edge is not this engine's to resume".into());
                    }
                    let mut landings = Vec::new();
                    for landing in items(at(landed, "landings")) {
                        landings.push(self.rehydrate(landing, park)?);
                    }
                    edges.push((edge.clone(), landings));
                }
                let landed_on = text(at(descriptor, "landedOn")).map(String::from);
                *node.borrow_mut() = Node { fields: ordered, field_order: order, field_provenance: provenance, landed_on, edges };
                Ok(Binding::Node(node))
            }
            Some("positions") => {
                let mut landings = Vec::new();
                for landing in items(at(descriptor, "landings")) {
                    landings.push(self.rehydrate(landing, park)?);
                }
                Ok(Binding::Positions(landings))
            }
            Some("event") => Ok(Binding::Event),
            Some("opaque") => Ok(Binding::Opaque),
            Some("movement") => Ok(Binding::Movement(text(at(descriptor, "name")).unwrap_or("").to_string())),
            Some("instance") => Ok(Binding::Instance(Rc::new(self.rehydrate_instance(at(descriptor, "instance").unwrap_or(&Js::Null))?))),
            Some("value") => {
                let value = at(descriptor, "value").cloned().unwrap_or(Js::Undefined);
                let trail = at(descriptor, "provenance").map(|p| self.rehydrate_trail(p)).transpose()?;
                let many = matches!(at(descriptor, "many"), Some(Js::Bool(true)));
                Ok(Binding::Value(ValueBinding { value, trail, many }))
            }
            Some("handle") => {
                let record = at(descriptor, "handle").ok_or("a handle descriptor without its record")?;
                let target_type = text(at(descriptor, "targetType")).ok_or("a handle without a targetType")?;
                let graph = at(descriptor, "graph").and_then(|g| at(g, "instance")).ok_or("a handle without its graph")?;
                Ok(Binding::Handle(Rc::new(Handle {
                    record: Rc::new(WriteRecord { object: record.clone() }),
                    target_type: target_type.to_string(),
                    graph: Rc::new(self.rehydrate_instance(graph)?),
                })))
            }
            other => Err(format!("a parked binding of kind {other:?} is not this engine's to resume")),
        }
    }

    /// `rehydrateInstance`: the identity's schema instantiated again, live;
    /// an instance the snapshot no longer holds (its adapter uninstalled, its
    /// credential gone or moved) fails the resume rather than run untyped.
    fn rehydrate_instance(&self, identity: &Js) -> Result<InstanceBinding, String> {
        let text = |key: &str| text(at(identity, key)).map(String::from);
        let name = text("name").ok_or("an instance identity without a name")?;
        let adapter_slug = text("adapterSlug").ok_or("an instance identity without an adapterSlug")?;
        let credential_name = text("credentialName");
        let construction_config: Vec<(String, String)> = pairs(at(identity, "constructionConfig"))
            .iter()
            .map(|(k, v)| (k.clone(), match v { Js::String(s) => s.clone(), _ => String::new() }))
            .collect();
        let spec = self.catalog.adapter(&adapter_slug);
        let credential_arg = spec.and_then(credential_arg_of).map_or_else(|| "credentials".to_string(), |a| a.name.clone());
        let mut spelled: Vec<(String, String)> = construction_config.clone();
        if let Some(credential) = &credential_name {
            spelled.push((credential_arg.clone(), credential.clone()));
        }
        let in_snapshot = spec.is_some()
            && credential_name
                .as_deref()
                .is_none_or(|c| self.catalog.credential(c).is_some_and(|spec| spec.adapters.iter().any(|a| *a == adapter_slug)));
        if !in_snapshot {
            let args = spelled.iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join(", ");
            return Err(format!("instance {adapter_slug}({args}) is not in the catalog snapshot"));
        }
        let mut args = Args::default();
        for (k, v) in &spelled {
            args.0.insert(k.clone(), v.clone());
        }
        let schema = self.catalog.instantiate(&adapter_slug, &args).cloned();
        Ok(InstanceBinding { name, adapter_slug, credential_name, construction_config, schema })
    }

    /// A parked trail's origins, each one more origin in this run's table.
    fn rehydrate_trail(&self, provenance: &Js) -> Result<Trail, String> {
        let origins = at(provenance, "origins").ok_or("a trail without origins")?;
        let origins = items(Some(origins)).iter().map(|o| self.mint_origin(o.clone())).collect();
        let direct = at(provenance, "direct").map(|d| self.mint_origin(d.clone()));
        Ok(Trail { origins, direct })
    }
}

// ── Reading a stored state (a JavaScript value, in its stored key order) ──

/// `value[key]`, absent for `undefined` as a stored key's absence reads.
fn at<'v>(value: &'v Js, key: &str) -> Option<&'v Js> {
    match value {
        Js::Object(object) => object.get(key).filter(|v| !matches!(v, Js::Undefined)),
        _ => None,
    }
}

fn text(value: Option<&Js>) -> Option<&str> {
    match value {
        Some(Js::String(s)) => Some(s),
        _ => None,
    }
}

fn items(value: Option<&Js>) -> &[Js] {
    match value {
        Some(Js::Array(list)) => &list.items,
        _ => &[],
    }
}

fn pairs(value: Option<&Js>) -> &[(String, Js)] {
    match value {
        Some(Js::Object(object)) => object.entries(),
        _ => &[],
    }
}

fn id_of(value: Option<&Js>) -> Option<u64> {
    match value {
        Some(Js::Number(n)) if *n >= 0.0 && n.fract() == 0.0 => Some(*n as u64),
        _ => None,
    }
}

/// The reading side of one park's node table (`ParkReader`): each number is
/// the one node every reference to it rehydrates to.
#[derive(Default)]
struct ParkReader {
    nodes: RefCell<Vec<(u64, Rc<RefCell<Node>>)>>,
    unfilled: RefCell<Vec<u64>>,
}

impl ParkReader {
    fn numbered(&self, id: u64) -> Rc<RefCell<Node>> {
        if let Some((_, node)) = self.nodes.borrow().iter().find(|(i, _)| *i == id) {
            return node.clone();
        }
        let node = Rc::new(RefCell::new(Node::default()));
        self.nodes.borrow_mut().push((id, node.clone()));
        self.unfilled.borrow_mut().push(id);
        node
    }

    fn filled(&self, id: u64) {
        self.unfilled.borrow_mut().retain(|i| *i != id);
    }

    fn unfilled(&self) -> Option<u64> {
        self.unfilled.borrow().first().copied()
    }
}

/// `parseAddress` for the steps this engine runs (`s`, `b`).
fn parse_address(text: &str) -> Option<Vec<(char, usize)>> {
    if text.is_empty() {
        return Some(Vec::new());
    }
    text.split('.')
        .map(|step| {
            let mut chars = step.chars();
            let kind = chars.next()?;
            let index = chars.as_str().parse().ok()?;
            matches!(kind, 's' | 'b' | 'i' | 'c').then_some((kind, index))
        })
        .collect()
}

/// `durationToMs`: unit-suffixed parts (`1h30m`), `None` for a text that is
/// not one.
pub fn duration_ms(raw: &str) -> Option<f64> {
    let mut total = 0.0;
    let mut digits = String::new();
    let mut any = false;
    for c in raw.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
            continue;
        }
        let unit = match c {
            's' => 1_000.0,
            'm' => 60_000.0,
            'h' => 3_600_000.0,
            'd' => 86_400_000.0,
            'w' => 604_800_000.0,
            _ => return None,
        };
        if digits.is_empty() {
            return None;
        }
        total += digits.parse::<f64>().ok()? * unit;
        digits.clear();
        any = true;
    }
    (any && digits.is_empty()).then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_read_as_duration_to_ms_reads_them() {
        assert_eq!(duration_ms("30s"), Some(30_000.0));
        assert_eq!(duration_ms("1h30m"), Some(5_400_000.0));
        assert_eq!(duration_ms("2d"), Some(172_800_000.0));
        assert_eq!(duration_ms("h"), None);
        assert_eq!(duration_ms("30"), None);
    }

    /// A record a pick bound parks as serialize.ts writes a source
    /// position: the position, and the graph it was read from by name.
    #[test]
    fn a_picked_record_parks_as_the_typescript_writes_it() {
        let input: crate::run::SegmentInput = serde_json::from_value(serde_json::json!({
            "source": "movement m(msg: <inbox-[:message]->>) {\n  x = 1\n}", "languageVersion": 3, "event": null,
            "segmentId": "g1", "serves": [], "now": "2026-03-12T12:00:00.000Z",
            "catalog": { "adapters": {}, "credentials": {}, "plugins": {} },
        }))
        .unwrap();
        let ledger = crate::ledger::Ledger::new(&input.spend);
        let host = crate::executor::Host::default();
        let root = crate::program::parse(&input.source, 3).unwrap();
        let checked = crate::program::join_check(root, &serde_json::json!({ "diagnostics": [], "stamps": [] }), 3).unwrap();
        let run = Run {
            host: &host,
            input: &input,
            ledger: &ledger,
            event: Js::Undefined,
            now_ms: 0.0,
            catalog: movement_parser::catalog::types::CatalogSnapshot::load(input.catalog.get()).unwrap(),
            checked,
            import_originals: RefCell::default(),
            source: RefCell::default(),
            source_instance: RefCell::default(),
            origins: RefCell::default(),
            misses: RefCell::default(),
            trace: crate::trace::FlowTrace::default(),
            movement_name: RefCell::default(),
            writes: RefCell::default(),
            targets: RefCell::default(),
            mutation_context: RefCell::new(Js::Undefined),
            limit_paused: std::cell::Cell::new(false),
            pending_suspensions: RefCell::default(),
            source_reads: RefCell::default(),
            positions: RefCell::default(),
            extraction_sites: RefCell::default(),
            reply_digests: std::cell::Cell::new(0),
            unfetched_files: RefCell::default(),
            log_lines: RefCell::default(),
        };
        let read = Rc::new(crate::traverse::Read {
            instance: crate::host::Instance { id: "i1".into(), methods: Rc::new(Vec::new()) },
            adapter_type: "graph".into(),
            instance_name: "kg".into(),
            schema: None,
            start_surface_type: None,
            incoming: false,
            edge_properties: false,
            streams: false,
        });
        let scope = Scope::root();
        scope.declare("c", Binding::Landed(Rc::new(crate::bindings::Landed::new(Js::Undefined, None, read))));
        for state in [parked_state(&run, "s0", None, &scope), suspended_state(&run, "s0", &scope)] {
            let state = crate::env::encode_plain(&state.expect("a picked record parks"));
            let text = state.to_string();
            assert!(text.contains(r#"[["kind","sourcePosition"],["position",["u"]],["read",["o","#), "{text}");
            assert!(text.contains(r#"[["instanceName","kg"]]"#), "{text}");
        }
    }

    #[test]
    fn addresses_parse_back() {
        assert_eq!(parse_address("s1.b0.s2"), Some(vec![('s', 1), ('b', 0), ('s', 2)]));
        assert_eq!(parse_address("s1.x0"), None);
    }

}
