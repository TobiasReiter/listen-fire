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
    /// A movement declared in the file (`kind: 'movement'`).
    Movement(String),
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

/// `{kind: 'nodePosition', fields, fieldOrder, fieldProvenance, edges}`, the
/// edges all landed (this engine builds no deferred one).
#[derive(Debug, Default)]
pub struct Node {
    /// As the JavaScript object holds them: in its key order.
    pub fields: crate::js::JsObject,
    pub field_order: Vec<String>,
    pub field_provenance: Vec<(String, crate::env::Trail)>,
    pub edges: Vec<(String, Vec<Binding>)>,
}

/// `{kind: 'handle', handle: WriteRecord, targetType, graph: {kind: 'instance', instance}}`.
#[derive(Debug, Clone)]
pub struct Handle {
    pub record: Rc<crate::write::WriteRecord>,
    pub target_type: String,
    pub graph: Rc<InstanceBinding>,
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
}

impl Scope {
    pub fn root() -> Rc<Scope> {
        Rc::new(Scope::default())
    }

    pub fn child(self: &Rc<Self>) -> Rc<Scope> {
        Rc::new(Scope { bindings: RefCell::default(), parent: Some(self.clone()) })
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

    pub fn resolve(&self, name: &str) -> Option<Binding> {
        if let Some((_, found)) = self.bindings.borrow().iter().find(|(n, _)| n == name) {
            return Some(found.clone());
        }
        self.parent.as_ref().and_then(|p| p.resolve(name))
    }

    /// This scope's own bindings, in declaration order.
    pub fn own_bindings(&self) -> Vec<(String, Binding)> {
        self.bindings.borrow().clone()
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

    fn is_event(&self, name: &str) -> bool {
        matches!(self.resolve(name), Some(Binding::Event))
    }

    fn is_record(&self, name: &str) -> bool {
        matches!(self.resolve(name), Some(Binding::Handle(_) | Binding::Node(_) | Binding::Landed(_)))
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
        position.set("recordType".into(), self.record_type.clone().map_or(Js::Null, Js::String));
        position.set("identity".into(), Js::object(identity));
        Js::object(position)
    }
}
