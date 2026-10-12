//! What a name in a run is bound to (expression.ts's `Binding`, the kinds
//! this engine runs so far), the lexical scopes that hold them, and the
//! source position the event seeds.

use std::cell::RefCell;
use std::rc::Rc;

use movement_parser::catalog::types::InstanceSchema;

use crate::env::ValueBinding;
use crate::eval::Names;
use crate::js::{Js, JsObject};

#[derive(Debug, Clone)]
pub enum Binding {
    /// A value with its trail (`kind: 'value'`).
    Value(ValueBinding),
    /// The movement's parameter: the triggering event (`kind: 'event'`).
    Event,
    /// A constructed adapter instance (`kind: 'instance'`).
    Instance(Rc<InstanceBinding>),
    /// An import that is not an instance until constructed (`kind: 'opaque'`).
    Opaque,
    /// A movement a file declares (`kind: 'movement'`): the root's, or one
    /// a library exports, which runs in its library's own scope.
    Movement(Rc<MovementRef>),
    /// A node declaration bound to a name (`kind: 'shape'`).
    Shape(Rc<ShapeBinding>),
    /// A plugin the file imports, by its name as registered (`kind:
    /// 'plugin'`).
    Plugin(String),
    /// A write's result (`kind: 'handle'`): the record the write produced,
    /// the type it stands on, and the graph it lives in.
    Handle(Rc<Handle>),
    /// A node the run built (`kind: 'nodePosition'`): a node or graph
    /// literal. Shared, as the TypeScript's object is: two places holding it
    /// hold one node.
    Node(Rc<RefCell<Node>>),
    /// A record a traversal landed on (`kind: 'sourcePosition'`): a block
    /// head's hop alias, one landing per iteration (crate::traverse).
    Landed(Rc<Landed>),
    /// What an extraction yielded (crate::extract): its root (`kind:
    /// 'extractRoot'`, `root`) or one of its entities a block head landed on
    /// (`kind: 'extractPosition'`). `id` is the binding object's own
    /// identity: a walk wraps the same entity in a new one each time.
    Extracted { emission: Rc<crate::extract::emission::Emission>, root: bool, id: Identity },
    /// A walk kept to run at each read (`kind: 'lazyWalk'`): `x = lazy
    /// msg-[a:files]->`.
    LazyWalk(Rc<DeferredWalk>),
    /// A bound block's returned records (`kind: 'positions'`, run.ts
    /// `blockValue`), or a list of records a value holds read as the records
    /// it holds (`heldBinding`).
    Positions(Vec<Binding>),
    /// A `race`'s or a `parallel`'s receipt (`kind: 'tuple'`): slot k is
    /// what arm k returned, a null value where it returned nothing.
    Tuple(Rc<Vec<Binding>>),
    /// A function written in place (`kind: 'closure'`): its body as the
    /// program holds it, the scope it was written in captured flat, and from
    /// version 3 the name its body may call it by.
    Closure(Rc<Closure>),
    /// A minted callback (`kind: 'callback'`): the id and URL the host
    /// minted it under, and its fire-time parameters.
    Callback(Rc<Callback>),
    /// An in-memory record of no graph (`kind: 'shapePosition'`): a fired
    /// callback's `Called` landing.
    ShapePosition(Rc<ShapePosition>),
    /// A file an extraction read (`kind: 'resource'`), its descriptor as a
    /// park holds it.
    Resource(Rc<Js>),
}

/// A movement as a binding names it: its declared name, in the file that
/// declares it (run.ts keeps the declaration and its `fileEnv`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MovementRef {
    pub name: String,
    pub file: crate::program::DeclaringFile,
}

/// `{kind: 'shape', declaration, fileEnv | library, local?}`: the
/// declaration and the file whose `type`s and names it reads; one declared
/// in a body (`local`) reads its words and its base in that body's scope,
/// none once a park has rebuilt it (the running file's then, as
/// serialize.ts's `localShape` rehydrates).
#[derive(Debug)]
pub struct ShapeBinding {
    pub declared: crate::program::DeclaredShape,
    pub local: bool,
    pub declared_in: Option<std::rc::Weak<Scope>>,
}

impl ShapeBinding {
    pub fn of(declared: crate::program::DeclaredShape) -> Rc<ShapeBinding> {
        Rc::new(ShapeBinding { declared, local: false, declared_in: None })
    }

    /// The body scope a local declaration reads, while it stands.
    pub fn body_scope(&self) -> Option<Rc<Scope>> {
        self.declared_in.as_ref().and_then(std::rc::Weak::upgrade)
    }
}

/// `{kind: 'callback', callbackId, url, params}`.
#[derive(Debug)]
pub struct Callback {
    pub callback_id: Js,
    pub url: Js,
    pub params: Js,
}

/// `{kind: 'shapePosition', shape, node, fields, fieldProvenance}`.
#[derive(Debug)]
pub struct ShapePosition {
    pub shape: Js,
    pub node: Js,
    pub fields: Js,
    pub field_provenance: Js,
}

/// `{kind: 'closure', closure, captured, self?}`.
#[derive(Debug)]
pub struct Closure {
    pub code: crate::flow::Code<movement_parser::ast::ClosureExpression>,
    pub captured: Rc<Scope>,
    pub self_name: Option<String>,
}

/// The identity of a binding object the TypeScript engine makes where this
/// engine makes no `Rc` of its own: a clone is the same object, a new one is
/// not.
#[derive(Debug, Clone, Default)]
pub struct Identity(Rc<()>);

impl Identity {
    pub fn new() -> Identity {
        Identity::default()
    }
}

impl PartialEq for Identity {
    fn eq(&self, other: &Identity) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

impl Binding {
    /// `a === b` of the two binding objects: a clone of a binding is the same
    /// object, as a name read twice is in the TypeScript engine.
    pub fn is(&self, other: &Binding) -> bool {
        if std::ptr::eq(self, other) {
            return true;
        }
        match (self, other) {
            (Binding::Event, Binding::Event) => true,
            (Binding::Instance(a), Binding::Instance(b)) => Rc::ptr_eq(a, b),
            (Binding::Handle(a), Binding::Handle(b)) => Rc::ptr_eq(a, b),
            (Binding::Node(a), Binding::Node(b)) => Rc::ptr_eq(a, b),
            (Binding::Landed(a), Binding::Landed(b)) => Rc::ptr_eq(a, b),
            (Binding::Extracted { id: a, .. }, Binding::Extracted { id: b, .. }) => a == b,
            (Binding::LazyWalk(a), Binding::LazyWalk(b)) => Rc::ptr_eq(a, b),
            (Binding::Tuple(a), Binding::Tuple(b)) => Rc::ptr_eq(a, b),
            (Binding::Closure(a), Binding::Closure(b)) => Rc::ptr_eq(a, b),
            (Binding::Callback(a), Binding::Callback(b)) => Rc::ptr_eq(a, b),
            (Binding::ShapePosition(a), Binding::ShapePosition(b)) => Rc::ptr_eq(a, b),
            (Binding::Resource(a), Binding::Resource(b)) => Rc::ptr_eq(a, b),
            // A block's returned records are one object only as the record
            // holding them is (the same allocation, above): two lists of the
            // same landings are two objects, as two `positions` bindings are.
            (Binding::Positions(_), Binding::Positions(_)) => false,
            _ => false,
        }
    }
}

/// `{kind: 'sourcePosition', position, edgeProperties?, read?}`.
#[derive(Debug)]
pub struct Landed {
    /// The position as the adapter (or the read wrapper's restamp) answered
    /// it, kept as that very object: it is what the next call is handed.
    pub position: Js,
    /// The walked edge's inline properties, when the adapter answered any.
    pub edge_properties: Option<Js>,
    /// The graph it was landed in, which its fields are read through.
    pub read: Rc<crate::traverse::Read>,
    /// The position as the read wrapper stamps it for a field read, made
    /// once: every read of the record names one object, so it crosses to the
    /// host once (a streamed landing is not restamped as it lands, and would
    /// otherwise be stamped afresh per read).
    pub surface: std::cell::OnceCell<Js>,
}

impl Landed {
    pub fn new(position: Js, edge_properties: Option<Js>, read: Rc<crate::traverse::Read>) -> Landed {
        Landed { position, edge_properties, read, surface: std::cell::OnceCell::new() }
    }
}

/// `{kind: 'nodePosition', fields, fieldOrder, fieldProvenance, landedOn?,
/// edges}`, the edges all landed (this engine builds no deferred one).
#[derive(Debug, Default)]
pub struct Node {
    /// As the JavaScript object holds them: in its key order.
    pub fields: crate::js::JsObject,
    pub field_order: Vec<String>,
    pub field_provenance: Vec<(String, crate::env::Trail)>,
    /// The edge of a graph this run built that the node landed on, the first
    /// one only (run.ts `setGraphEdge`): what makes it a record of the run's
    /// own graph, updatable in place.
    pub landed_on: Option<String>,
    pub edges: Vec<(String, Edge)>,
}

impl Node {
    /// The landings of the edge `name`, none when the node has no such edge
    /// (`nodeEdgeLandings`).
    pub fn landings(&self, name: &str) -> Vec<Binding> {
        self.edges.iter().find(|(n, _)| n == name).map(|(_, e)| e.landings.clone()).unwrap_or_default()
    }
}

/// `{kind: 'landed', landings, landingShape?}`: what the edge holds, in the
/// order it came to hold it (a write appends, a `link` appends), and, for a
/// declared edge, what a landing a write creates on it carries.
#[derive(Debug, Default, Clone)]
pub struct Edge {
    pub landings: Vec<Binding>,
    pub shape: Option<LandingShape>,
    /// A `lazy` entry's edge (`{kind: 'deferred', walk}`): it holds no
    /// landings, and every read of it runs the walk again.
    pub deferred: Option<Rc<DeferredWalk>>,
}

impl Edge {
    pub fn landed(landings: Vec<Binding>) -> Edge {
        Edge { landings, shape: None, deferred: None }
    }
}

/// `DeferredWalk`: a traversal as written, the scope it was written in
/// captured flat (`captureScope`: later bindings never reach it), and the
/// per-item tail its landings are synthesised through, if any.
#[derive(Debug)]
pub struct DeferredWalk {
    pub head: movement_parser::ast::PathHead,
    /// The head's AST path: a park writes the head as the program holds it.
    pub head_path: String,
    pub captured: Rc<Scope>,
    /// The tail literal, and its AST path.
    pub mapping: Option<(movement_parser::ast::NodeLiteral, String)>,
}

/// `LocalLandingShape`: a declared node's field names in declaration order
/// and its nested nodes, each a shape of its own.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct LandingShape {
    pub fields: Vec<String>,
    pub edges: Vec<(String, LandingShape)>,
}

/// `{kind: 'handle', handle: WriteRecord, targetType, graph: {kind: 'instance', instance}}`.
///
/// The record it names is held in a cell: from version 4, `write org { … }`
/// moves the handle `org` on to the updated record in place (run.ts
/// `recordWrite`'s `into`), and every scope holding it reads the update.
/// The record before its write (`-[:@old]->`) is held beside it: the
/// TypeScript keeps it on the write record, which one handle alone holds.
#[derive(Debug)]
pub struct Handle {
    state: RefCell<HandleState>,
    pub target_type: String,
    pub graph: Rc<InstanceBinding>,
}

#[derive(Debug)]
struct HandleState {
    record: Rc<crate::write::WriteRecord>,
    old: Old,
}

/// What `-[:@old]->` lands on from a handle (expression.ts `WriteRecord.old`,
/// version 4 on).
#[derive(Debug, Clone)]
pub enum Old {
    /// The write created the record (or the version is before 4): nothing.
    Nothing,
    /// A rehearsed write that found a record: nothing changed, so the
    /// record before is the handle itself (`old === binding`).
    Itself,
    /// A snapshot of the record as the write found it, or the handle as it
    /// stood before an in-place write (its own `old` keeping the chain).
    Was(Rc<Handle>),
}

impl Handle {
    pub fn new(record: Rc<crate::write::WriteRecord>, old: Old, target_type: String, graph: Rc<InstanceBinding>) -> Handle {
        Handle { state: RefCell::new(HandleState { record, old }), target_type, graph }
    }

    /// The write record the handle names now.
    pub fn record(&self) -> Rc<crate::write::WriteRecord> {
        self.state.borrow().record.clone()
    }

    pub fn old(&self) -> Old {
        self.state.borrow().old.clone()
    }

    /// `binding.handle = record`: the handle moves on to a new record, with
    /// the record before it.
    pub fn move_to(&self, record: Rc<crate::write::WriteRecord>, old: Old) {
        *self.state.borrow_mut() = HandleState { record, old };
    }

    /// `oldEdgeLandings`: where `-[:@old]->` lands from the handle `this`.
    pub fn old_landings(this: &Rc<Handle>) -> Vec<Binding> {
        match this.old() {
            Old::Nothing => Vec::new(),
            Old::Itself => vec![Binding::Handle(this.clone())],
            Old::Was(old) => vec![Binding::Handle(old)],
        }
    }

    /// `snapshotOfHandle`: the record the handle names as it stands now, a
    /// distinct position (`snapshot: true`), its value bags copied, its own
    /// `old` kept so the chain walks (a handle that was its own `old` stays
    /// its own in the snapshot).
    pub fn snapshot(&self) -> Rc<Handle> {
        let record = self.record();
        let mut object = match &record.object {
            Js::Object(object) => JsObject::clone_of(object),
            _ => JsObject::new(),
        };
        for bag in ["writtenValues", "resultData"] {
            if let Some(Js::Object(values)) = object.get(bag).cloned() {
                object.set(bag.into(), Js::object(JsObject::clone_of(&values)));
            }
        }
        object.set("snapshot".into(), Js::Bool(true));
        Rc::new(Handle::new(Rc::new(crate::write::WriteRecord { object: Js::object(object) }), self.old(), self.target_type.clone(), self.graph.clone()))
    }
}

/// `{kind: 'instance', name, adapterSlug, credentialName?, constructionConfig?, schema}`.
#[derive(Debug, Clone)]
pub struct InstanceBinding {
    pub name: String,
    pub adapter_slug: String,
    pub credential_name: Option<String>,
    pub construction_config: Vec<(String, String)>,
    pub schema: Option<InstanceSchema>,
}

/// One lexical scope: its own bindings and the scope it sits in. Declaring
/// into a scope a child already reads is what a body does (a statement
/// after an `if` arm declares into the scope the arm forked from).
#[derive(Debug, Default)]
pub struct Scope {
    /// In the order declared, as a `Map` keeps them (a park writes them so).
    bindings: RefCell<Vec<(String, Binding)>>,
    parent: Option<Rc<Scope>>,
    /// A file's own scope (run.ts's `fileTypes` registry keys on it): the
    /// `type`s, shapes and words of the code that runs under it are that
    /// file's. A scope rooted anywhere else (a closure's capture, a scope a
    /// park rebuilt) reads the running file's, as `typesIn` falls back.
    file_env: Option<crate::program::DeclaringFile>,
    /// The file the code running in this scope is written in, nearest
    /// first: a file's scope, and a closure's call over its capture (the
    /// closure's code says where it is written). What its slots' AST paths
    /// are read in.
    written_in: Option<crate::program::DeclaringFile>,
}

impl Scope {
    pub fn root() -> Rc<Scope> {
        Rc::new(Scope::default())
    }

    /// A scope of its own for code written in `file` (a capture rebuilt).
    pub fn root_written_in(file: crate::program::DeclaringFile) -> Rc<Scope> {
        Rc::new(Scope { written_in: Some(file), ..Scope::default() })
    }

    /// A file's own scope.
    pub fn of_file(file: crate::program::DeclaringFile) -> Rc<Scope> {
        Rc::new(Scope { file_env: Some(file.clone()), written_in: Some(file), ..Scope::default() })
    }

    pub fn child(self: &Rc<Self>) -> Rc<Scope> {
        Rc::new(Scope { parent: Some(self.clone()), ..Scope::default() })
    }

    /// A child for code written in `file` (a closure's body over its capture).
    pub fn child_written_in(self: &Rc<Self>, file: crate::program::DeclaringFile) -> Rc<Scope> {
        Rc::new(Scope { parent: Some(self.clone()), written_in: Some(file), ..Scope::default() })
    }

    /// `typesIn`: the file this scope's chain is rooted in, or the running
    /// (root) file's where the chain is rooted in no file's scope.
    pub fn file_env(&self) -> crate::program::DeclaringFile {
        match &self.parent {
            Some(parent) => parent.file_env(),
            None => self.file_env.clone().unwrap_or(crate::program::DeclaringFile::Root),
        }
    }

    /// The file the code running here is written in (`written_in`).
    pub fn written_in(&self) -> crate::program::DeclaringFile {
        match (&self.written_in, &self.parent) {
            (Some(file), _) => file.clone(),
            (None, Some(parent)) => parent.written_in(),
            (None, None) => crate::program::DeclaringFile::Root,
        }
    }

    /// `Map.set`: a name already declared here keeps its place.
    pub fn declare(&self, name: impl Into<String>, binding: Binding) {
        let name = name.into();
        let mut bindings = self.bindings.borrow_mut();
        match bindings.iter_mut().find(|(n, _)| *n == name) {
            Some(slot) => slot.1 = binding,
            None => bindings.push((name, binding)),
        }
    }

    /// A binding this scope itself holds, not one it sees from outside.
    pub fn resolve_own(&self, name: &str) -> Option<Binding> {
        self.bindings.borrow().iter().find(|(n, _)| n == name).map(|(_, b)| b.clone())
    }

    pub fn resolve(&self, name: &str) -> Option<Binding> {
        if let Some((_, found)) = self.bindings.borrow().iter().find(|(n, _)| n == name) {
            return Some(found.clone());
        }
        self.parent.as_ref().and_then(|p| p.resolve(name))
    }

    /// `resolveFunction`: the declared name of a function in scope (a
    /// movement, a plugin, an import, a closure) written `name` in another
    /// letter case.
    pub fn resolve_function(&self, name: &str) -> Option<String> {
        let folded = crate::js::to_lower_case(name);
        let own = self.bindings.borrow().iter().find_map(|(bound, binding)| {
            let callable = matches!(binding, Binding::Movement(_) | Binding::Plugin(_) | Binding::Opaque | Binding::Closure(_));
            (callable && crate::js::to_lower_case(bound) == folded).then(|| bound.clone())
        });
        own.or_else(|| self.parent.as_ref().and_then(|p| p.resolve_function(name)))
    }

    /// This scope's own bindings, in declaration order.
    pub fn own_bindings(&self) -> Vec<(String, Binding)> {
        self.bindings.borrow().clone()
    }

    /// `captureScope`: every binding the chain holds, flat, in a scope of
    /// its own — an inner binding over an outer one of its name, in the
    /// outer's place.
    pub fn capture(self: &Rc<Self>) -> Rc<Scope> {
        let captured = Rc::new(Scope { written_in: Some(self.written_in()), ..Scope::default() });
        for scope in self.chain_from_root() {
            for (name, binding) in scope.own_bindings() {
                captured.declare(name, binding);
            }
        }
        captured
    }

    /// `capture`, for code written in `file` (a movement handed where a
    /// closure goes runs over its caller's scope).
    pub fn capture_written_in(self: &Rc<Self>, file: crate::program::DeclaringFile) -> Rc<Scope> {
        let captured = self.capture();
        Rc::new(Scope { bindings: RefCell::new(captured.own_bindings()), parent: None, file_env: None, written_in: Some(file) })
    }

    /// The lexical chain, root first, this scope last (`chainFromRoot`).
    pub fn chain_from_root(self: &Rc<Self>) -> Vec<Rc<Scope>> {
        let mut chain = vec![self.clone()];
        while let Some(parent) = chain.last().and_then(|s| s.parent.clone()) {
            chain.push(parent);
        }
        chain.reverse();
        chain
    }
}

impl Names for Scope {
    fn value(&self, name: &str) -> Option<ValueBinding> {
        match self.resolve(name)? {
            Binding::Value(value) => Some(value),
            _ => None,
        }
    }

    fn binding(&self, name: &str) -> Option<Binding> {
        self.resolve(name)
    }

    fn is_event(&self, name: &str) -> bool {
        matches!(self.resolve(name), Some(Binding::Event))
    }

    /// `binding.kind !== 'value'`.
    fn binds_non_value(&self, name: &str) -> bool {
        self.resolve(name).is_some_and(|binding| !matches!(binding, Binding::Value(_)))
    }
}

/// translation_graph/types.ts's `Position`: `{adapterType, recordType,
/// identity: {kind: 'stable', recordId, data} | {kind: 'unstable', data}}`.
/// `data` is always there, `undefined` when nothing was carried, as
/// `makeStablePosition` / `makeUnstablePosition` write it.
#[derive(Debug, Clone)]
pub struct Position {
    pub adapter_type: String,
    pub record_type: Option<String>,
    pub record_id: Option<String>,
    pub data: Js,
}

impl Position {
    pub fn stable(adapter_type: &str, record_type: Option<String>, record_id: String, data: Js) -> Position {
        Position { adapter_type: adapter_type.to_string(), record_type, record_id: Some(record_id), data }
    }

    pub fn unstable(adapter_type: &str, record_type: Option<String>, data: Js) -> Position {
        Position { adapter_type: adapter_type.to_string(), record_type, record_id: None, data }
    }

    pub fn is_stable(&self) -> bool {
        self.record_id.is_some()
    }

    /// The position as the JavaScript object the adapter receives.
    pub fn to_js(&self) -> Js {
        let mut identity = JsObject::new();
        identity.set("kind".into(), Js::str(if self.is_stable() { "stable" } else { "unstable" }));
        if let Some(id) = &self.record_id {
            identity.set("recordId".into(), Js::str(id.clone()));
        }
        identity.set("data".into(), self.data.clone());
        let mut position = JsObject::new();
        position.set("adapterType".into(), Js::str(self.adapter_type.clone()));
        position.set("recordType".into(), self.record_type.clone().map_or(Js::Null, Js::str));
        position.set("identity".into(), Js::object(identity));
        Js::object(position)
    }
}
