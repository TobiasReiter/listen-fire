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
//! - **Resume** (`resumeAlongAddress`): the movement's scope re-layered from
//!   the chain's second entry, each `if` arm on the address descended with
//!   its scope rehydrated, the leaf stepped past (or re-entered), then each
//!   enclosing body finished from the statement after its container.
//!
//! A state holding anything else (frames, a journal, a suspension, an
//! `until`, a binding of another kind) is not this engine's to resume: the
//! shim's `rustCanResume` leaves it to the TypeScript engine.

use std::cell::RefCell;
use std::rc::Rc;

use movement_parser::ast::{MovementDeclaration, Statement};
use movement_parser::catalog::helpers::credential_arg_of;
use movement_parser::catalog::snapshot::Args;
use serde::Deserialize;
use serde_json::{Map, Value as Json, json};

use crate::bindings::{Binding, Handle, InstanceBinding, Node, Scope};
use crate::env::{Trail, ValueBinding};
use crate::env::{js_of_json, json_of_js};
use crate::js::{Js, JsObject};
use crate::run::{Address, Failure, Flow, Run, Stop};
use crate::write::WriteRecord;

/// What a resumed segment is handed (`ResumeMovementInput`'s state and mode).
#[derive(Debug, Clone, Deserialize)]
pub struct ResumeInput {
    pub state: Json,
    /// Re-enter AT the parked statement rather than step past it.
    #[serde(default)]
    pub reenter: bool,
}

/// `{version: 1, address, bindingName, presenceBind?, scopeChain}`.
pub(crate) fn parked_state(run: &Run<'_>, address: &str, presence: Option<&str>, scope: &Rc<Scope>) -> Json {
    // One table for the whole state: a node two scopes hold is written once.
    let mut park = Vec::new();
    let chain: Vec<Json> = scope.chain_from_root().iter().map(|s| serialize_scope(run, s, &mut park)).collect();
    let mut state = Map::new();
    state.insert("version".into(), json!(1));
    state.insert("address".into(), json!(address));
    state.insert("bindingName".into(), presence.map_or(Json::Null, |p| json!(p)));
    if presence.is_some() {
        state.insert("presenceBind".into(), json!(true));
    }
    state.insert("scopeChain".into(), Json::Array(chain));
    Json::Object(state)
}

/// The nodes one park has written, numbered as first reached (`ParkWriter`).
type ParkWriter = Vec<*const RefCell<Node>>;

fn serialize_scope(run: &Run<'_>, scope: &Scope, park: &mut ParkWriter) -> Json {
    let mut bindings = Map::new();
    for (name, binding) in scope.own_bindings() {
        bindings.insert(name.clone(), serialize_binding(run, &name, &binding, park));
    }
    json!({ "bindings": bindings })
}

/// `serializeBinding`, for the kinds this engine binds.
fn serialize_binding(run: &Run<'_>, name: &str, binding: &Binding, park: &mut ParkWriter) -> Json {
    match binding {
        Binding::Node(node) => {
            let address = Rc::as_ptr(node);
            if let Some(id) = park.iter().position(|p| *p == address) {
                return json!({ "kind": "nodeRef", "id": id });
            }
            // Numbered before its edges are walked: an edge back here is a
            // reference, not another lap.
            let id = park.len();
            park.push(address);
            let node = node.borrow();
            let mut edges = Map::new();
            for (edge, landings) in &node.edges {
                let landings: Vec<Json> = landings.iter().map(|l| serialize_binding(run, "", l, park)).collect();
                edges.insert(edge.clone(), json!({ "kind": "landed", "landings": landings }));
            }
            let provenance: Map<String, Json> = node.field_provenance.iter().map(|(f, t)| (f.clone(), provenance_of(run, t))).collect();
            json!({
                "kind": "nodePosition",
                "id": id,
                "fields": json_of_js(&Js::object(JsObject::clone_of(&node.fields))),
                "fieldOrder": node.field_order,
                "fieldProvenance": provenance,
                "edges": edges,
            })
        }
        Binding::Event => json!({ "kind": "event" }),
        Binding::Instance(instance) => json!({ "kind": "instance", "instance": identity(instance) }),
        Binding::Opaque => json!({ "kind": "opaque", "what": "import", "name": name }),
        Binding::Movement(movement) => json!({ "kind": "movement", "name": movement }),
        Binding::Handle(handle) => json!({
            "kind": "handle",
            "handle": json_of_js(&handle.record.object),
            "targetType": handle.target_type,
            "graph": { "kind": "instance", "instance": identity(&handle.graph) },
        }),
        Binding::Value(value) => {
            let mut descriptor = Map::new();
            descriptor.insert("kind".into(), json!("value"));
            if !matches!(value.value, Js::Undefined) {
                descriptor.insert("value".into(), json_of_js(&value.value));
            }
            if let Some(trail) = &value.trail {
                descriptor.insert("provenance".into(), provenance_of(run, trail));
            }
            if value.many {
                descriptor.insert("many".into(), json!(true));
            }
            Json::Object(descriptor)
        }
    }
}

/// `serializeInstanceIdentity`.
fn identity(instance: &InstanceBinding) -> Json {
    let mut identity = Map::new();
    identity.insert("name".into(), json!(instance.name));
    identity.insert("adapterSlug".into(), json!(instance.adapter_slug));
    if let Some(credential) = &instance.credential_name {
        identity.insert("credentialName".into(), json!(credential));
    }
    if !instance.construction_config.is_empty() {
        let config: Map<String, Json> = instance.construction_config.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        identity.insert("constructionConfig".into(), Json::Object(config));
    }
    Json::Object(identity)
}

/// A trail as the TypeScript's `Provenance`: the origins themselves.
fn provenance_of(run: &Run<'_>, trail: &Trail) -> Json {
    let origins = run.origins.borrow();
    let origin = |id: &u32| origins.get(*id as usize).cloned().unwrap_or(Json::Null);
    let mut provenance = Map::new();
    provenance.insert("origins".into(), Json::Array(trail.origins.iter().map(origin).collect()));
    if let Some(direct) = &trail.direct {
        provenance.insert("direct".into(), origin(direct));
    }
    Json::Object(provenance)
}

// ── Resume ──

impl Run<'_> {
    /// `resumeAlongAddress` for a leaf inside `if` arms of the dispatched
    /// movement's body.
    pub(crate) async fn resume(&self, resume: &crate::park::ResumeInput, movement: &MovementDeclaration, scope: &Rc<Scope>, path: &str) -> Result<(), Stop> {
        let state = &resume.state;
        let malformed = |why: &str| {
            Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("malformed parked address '{}' — {why}", state.get("address").and_then(Json::as_str).unwrap_or("")),
            ))
        };
        let address = parse_address(state.get("address").and_then(Json::as_str).unwrap_or(""))
            .ok_or_else(|| malformed("its steps do not read"))?;
        if address.last().is_none_or(|(kind, _)| *kind != 's') {
            return Err(malformed("a parked leaf ends at a statement"));
        }
        let chain: Vec<Json> = state.get("scopeChain").and_then(Json::as_array).cloned().unwrap_or_default();
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
            // The shim resumes no other address (`rustCanResume`), and runs no
            // other container (`rustCanRun`).
            if kind != 's' || descent != 'b' {
                return Err(malformed(&format!("step {} is '{descent}', which this engine does not descend", i + 1)));
            }
            let Some(Statement::If(container)) = statements.get(index) else {
                return Err(Stop::Thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!(
                        "resume: address descends 'branch' into a statement other than `if` (parked '{}')",
                        state.get("address").and_then(Json::as_str).unwrap_or("")
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
                                "resume: if branch {branch} has no body (parked '{}')",
                                state.get("address").and_then(Json::as_str).unwrap_or("")
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
        let binding_name = state.get("bindingName").and_then(Json::as_str);
        if !resume.reenter
            && state.get("presenceBind").and_then(Json::as_bool) == Some(true)
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
    fn rehydrate_into(&self, serialized: Option<&Json>, scope: &Rc<Scope>, park: &ParkReader) -> Result<(), Stop> {
        let Some(bindings) = serialized.and_then(|s| s.get("bindings")).and_then(Json::as_object) else { return Ok(()) };
        for (name, descriptor) in bindings {
            let kind = descriptor.get("kind").and_then(Json::as_str).unwrap_or("");
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
    fn rehydrate(&self, descriptor: &Json, park: &ParkReader) -> Result<Binding, String> {
        match descriptor.get("kind").and_then(Json::as_str) {
            Some("nodeRef") => Ok(Binding::Node(park.numbered(descriptor.get("id").and_then(Json::as_u64).ok_or("a nodeRef without an id")?))),
            Some("nodePosition") => {
                let node = match descriptor.get("id").and_then(Json::as_u64) {
                    Some(id) => {
                        let node = park.numbered(id);
                        park.filled(id);
                        node
                    }
                    None => Rc::new(RefCell::new(Node::default())),
                };
                let fields = descriptor.get("fields").and_then(Json::as_object).cloned().unwrap_or_default();
                let order: Vec<String> = match descriptor.get("fieldOrder").and_then(Json::as_array) {
                    Some(order) => order.iter().filter_map(|f| f.as_str().map(String::from)).collect(),
                    None => fields.keys().cloned().collect(),
                };
                // `inOrder`: the order kept, then whatever else the map holds.
                let mut ordered = JsObject::new();
                for key in &order {
                    if let Some(value) = fields.get(key) {
                        ordered.set(key.clone(), js_of_json(value));
                    }
                }
                for (key, value) in &fields {
                    if ordered.get(key).is_none() {
                        ordered.set(key.clone(), js_of_json(value));
                    }
                }
                let mut provenance = Vec::new();
                for (field, trail) in descriptor.get("fieldProvenance").and_then(Json::as_object).cloned().unwrap_or_default() {
                    provenance.push((field, self.rehydrate_trail(&trail)?));
                }
                let mut edges = Vec::new();
                for (edge, landed) in descriptor.get("edges").and_then(Json::as_object).cloned().unwrap_or_default() {
                    if landed.get("kind").and_then(Json::as_str) != Some("landed") {
                        return Err("a deferred edge is not this engine's to resume".into());
                    }
                    let mut landings = Vec::new();
                    for landing in landed.get("landings").and_then(Json::as_array).cloned().unwrap_or_default() {
                        landings.push(self.rehydrate(&landing, park)?);
                    }
                    edges.push((edge, landings));
                }
                *node.borrow_mut() = Node { fields: ordered, field_order: order, field_provenance: provenance, edges };
                Ok(Binding::Node(node))
            }
            Some("event") => Ok(Binding::Event),
            Some("opaque") => Ok(Binding::Opaque),
            Some("movement") => Ok(Binding::Movement(descriptor.get("name").and_then(Json::as_str).unwrap_or("").to_string())),
            Some("instance") => Ok(Binding::Instance(Rc::new(self.rehydrate_instance(descriptor.get("instance").unwrap_or(&Json::Null))?))),
            Some("value") => {
                let value = descriptor.get("value").map_or(Js::Undefined, js_of_json);
                let trail = descriptor.get("provenance").map(|p| self.rehydrate_trail(p)).transpose()?;
                let many = descriptor.get("many").and_then(Json::as_bool) == Some(true);
                Ok(Binding::Value(ValueBinding { value, trail, many }))
            }
            Some("handle") => {
                let record = descriptor.get("handle").ok_or("a handle descriptor without its record")?;
                let target_type = descriptor.get("targetType").and_then(Json::as_str).ok_or("a handle without a targetType")?;
                let graph = descriptor.get("graph").and_then(|g| g.get("instance")).ok_or("a handle without its graph")?;
                Ok(Binding::Handle(Rc::new(Handle {
                    record: Rc::new(WriteRecord { object: js_of_json(record) }),
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
    fn rehydrate_instance(&self, identity: &Json) -> Result<InstanceBinding, String> {
        let text = |key: &str| identity.get(key).and_then(Json::as_str).map(String::from);
        let name = text("name").ok_or("an instance identity without a name")?;
        let adapter_slug = text("adapterSlug").ok_or("an instance identity without an adapterSlug")?;
        let credential_name = text("credentialName");
        let construction_config: Vec<(String, String)> = identity
            .get("constructionConfig")
            .and_then(Json::as_object)
            .map(|config| config.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect())
            .unwrap_or_default();
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
    fn rehydrate_trail(&self, provenance: &Json) -> Result<Trail, String> {
        let origins = provenance.get("origins").and_then(Json::as_array).ok_or("a trail without origins")?;
        let origins = origins.iter().map(|o| self.mint_origin(o.clone())).collect();
        let direct = provenance.get("direct").map(|d| self.mint_origin(d.clone()));
        Ok(Trail { origins, direct })
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

    #[test]
    fn addresses_parse_back() {
        assert_eq!(parse_address("s1.b0.s2"), Some(vec![('s', 1), ('b', 0), ('s', 2)]));
        assert_eq!(parse_address("s1.x0"), None);
    }

}
