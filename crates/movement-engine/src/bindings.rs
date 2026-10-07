//! What a name in a run is bound to (expression.ts's `Binding`, the kinds
//! this engine runs so far), the lexical scopes that hold them, and the
//! source position the event seeds.

use std::cell::RefCell;
use std::collections::HashMap;
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
    bindings: RefCell<HashMap<String, Binding>>,
    parent: Option<Rc<Scope>>,
}

impl Scope {
    pub fn root() -> Rc<Scope> {
        Rc::new(Scope::default())
    }

    pub fn child(self: &Rc<Self>) -> Rc<Scope> {
        Rc::new(Scope { bindings: RefCell::default(), parent: Some(self.clone()) })
    }

    pub fn declare(&self, name: impl Into<String>, binding: Binding) {
        self.bindings.borrow_mut().insert(name.into(), binding);
    }

    pub fn resolve(&self, name: &str) -> Option<Binding> {
        if let Some(found) = self.bindings.borrow().get(name) {
            return Some(found.clone());
        }
        self.parent.as_ref().and_then(|p| p.resolve(name))
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
