//! An extracted record as the run reads it (extraction.ts `ExtractEmission`):
//! its fields, each field's extraction origin, its own origin, its resources,
//! and its children by edge name. The extraction keyword that built a tree of
//! them is retired here; what still makes one is an ask's correction answer
//! (`rematerialise_answer`) and a parked TypeScript state's extracted record,
//! resumed (`extractRoot`, `extractPosition`). Also the trace's account of
//! what an extraction call found (`traced_entities_of`).

use std::rc::Rc;


use crate::env;
use crate::js::{self, Js, JsObject};

/// One extracted record, as the run reads it.
#[derive(Debug)]
pub struct Emission {
    pub node_name: String,
    /// Every field the node declares, in declaration order.
    pub fields: JsObject,
    /// Each field's origin, by origin id (the run's table).
    pub provenance: Vec<(String, u32)>,
    /// The entity's own origin; none for the root that no call answered.
    pub origin: Option<u32>,
    /// `Resource` objects: the extract's source content, then what this
    /// record's (and its ancestors') stages fetched.
    pub resources: Vec<Js>,
    pub children: Vec<(String, Vec<Rc<Emission>>)>,
}

impl Emission {
    /// `emission.children.get(edge) ?? []`.
    pub fn children_of(&self, edge: &str) -> &[Rc<Emission>] {
        self.children.iter().find(|(name, _)| name == edge).map_or(&[], |(_, list)| list.as_slice())
    }

    /// The origin `field` was extracted with.
    pub fn origin_of(&self, field: &str) -> Option<u32> {
        self.provenance.iter().find(|(name, _)| name == field).map(|(_, id)| *id)
    }

    /// `serializeEmission`: the descriptor a park writes, each origin as
    /// the run's table holds it.
    pub fn descriptor(&self, origin: &dyn Fn(u32) -> Js) -> Js {
        let mut provenance = JsObject::new();
        for (field, id) in &self.provenance {
            provenance.set(field.clone(), origin(*id));
        }
        let mut children = JsObject::new();
        for (edge, list) in &self.children {
            children.set(edge.clone(), Js::array(list.iter().map(|child| child.descriptor(origin)).collect()));
        }
        let mut members = vec![
            ("nodeName", Js::str(self.node_name.clone())),
            ("fields", Js::object(JsObject::clone_of(&self.fields))),
            ("fieldOrder", Js::array(self.fields.entries().iter().map(|(k, _)| Js::str(k.clone())).collect())),
        ];
        if let Some(files) = crate::file::file_fields_of(&self.fields) {
            members.push(("fileFields", files));
        }
        members.push(("provenance", Js::object(provenance)));
        if let Some(id) = self.origin {
            members.push(("origin", origin(id)));
        }
        members.push(("resources", Js::array(self.resources.clone())));
        members.push(("children", Js::object(children)));
        env::object_of(members)
    }
}

/// `absentIfBlank`: a blank text is absent; a list drops its blank members,
/// and a list left empty is absent.
pub(crate) fn absent_if_blank(value: &Js) -> Js {
    match value {
        Js::Undefined => Js::Null,
        Js::String(text) if js::trim(text.as_form()).is_empty() => Js::Null,
        Js::Array(list) => {
            let kept: Vec<Js> = list.items().iter().map(absent_if_blank).filter(|v| !matches!(v, Js::Null)).collect();
            if kept.is_empty() { Js::Null } else { Js::array(kept) }
        }
        other => other.clone(),
    }
}

fn bump(into: &mut Vec<(String, f64)>, name: &str) {
    match into.iter_mut().find(|(n, _)| n == name) {
        Some(slot) => slot.1 += 1.0,
        None => js::set_entry(into, name.to_string(), 1.0),
    }
}

// ── The trace's sample of what was extracted ────────────────────────────────

const TRACE_ENTITY_CAP: usize = 20;
const TRACE_VALUE_CHARS: usize = 200;

/// A record and the records under it as the trace's sample reads them
/// (`TracedTree`): its node's name, its fields, its children in order.
pub(crate) struct TracedTree {
    pub(crate) node_name: String,
    pub(crate) fields: Vec<(String, Js)>,
    pub(crate) children: Vec<TracedTree>,
}

/// `collectTracedEntities` over a tree.
pub(crate) fn traced_entities_of(root: &TracedTree) -> (Js, Js) {
    let mut entities: Vec<(String, Vec<Js>)> = Vec::new();
    let mut truncated: Vec<(String, f64)> = Vec::new();
    collect_traced(root, &mut entities, &mut truncated);
    let mut by_alias = JsObject::new();
    for (alias, list) in entities {
        by_alias.set(alias, Js::array(list));
    }
    let mut counted = JsObject::new();
    for (alias, n) in truncated {
        counted.set(alias, Js::Number(n));
    }
    (Js::object(by_alias), Js::object(counted))
}

fn collect_traced(tree: &TracedTree, into: &mut Vec<(String, Vec<Js>)>, truncated: &mut Vec<(String, f64)>) {
    if !tree.fields.is_empty() {
        let alias = tree.node_name.clone();
        let at = match into.iter().position(|(name, _)| *name == alias) {
            Some(at) => at,
            None => {
                js::set_entry(into, alias.clone(), Vec::new());
                into.iter().position(|(name, _)| *name == alias).expect("just inserted")
            }
        };
        if into[at].1.len() < TRACE_ENTITY_CAP {
            let mut fields = JsObject::new();
            for (name, value) in &tree.fields {
                fields.set(name.clone(), traced_value(value));
            }
            into[at].1.push(env::object_of(vec![("fields", Js::object(fields))]));
        } else {
            bump(truncated, &alias);
        }
    }
    for child in &tree.children {
        collect_traced(child, into, truncated);
    }
}

/// `tracedValue`: absent stays null; anything else a text of at most 200
/// UTF-16 units, marked where it was cut.
fn traced_value(value: &Js) -> Js {
    let text = match value {
        Js::Undefined | Js::Null => return Js::Null,
        Js::String(text) => text.to_string(),
        Js::Array(_) | Js::Object(_) | Js::File(_) => js::json_stringify(value, 0),
        other => other.to_js_string(),
    };
    Js::str(cut(&text, TRACE_VALUE_CHARS))
}

/// A text past `limit` UTF-16 units cut there and marked, as
/// `${text.slice(0, limit)}…` cuts it: a cut through a pair keeps its high
/// half.
pub(crate) fn cut(text: &str, limit: usize) -> String {
    if js::utf16_len(text) <= limit {
        return text.to_string();
    }
    format!("{}…", crate::js_string::slice_units(text, 0, limit))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_is_absent_and_a_list_drops_its_blanks() {
        assert!(matches!(absent_if_blank(&Js::Undefined), Js::Null));
        assert!(matches!(absent_if_blank(&Js::str("  ")), Js::Null));
        let list = absent_if_blank(&Js::array(vec![Js::str(" "), Js::str("a"), Js::Null]));
        assert_eq!(env::json_of_js(&list), serde_json::json!(["a"]));
        assert!(matches!(absent_if_blank(&Js::array(vec![Js::str("")])), Js::Null));
        assert!(matches!(absent_if_blank(&Js::Number(0.0)), Js::Number(_)));
    }

    #[test]
    fn a_long_value_is_cut_at_its_utf16_length() {
        assert_eq!(cut("abc", 3), "abc");
        assert_eq!(cut("abcd", 3), "abc…");
        assert_eq!(cut("a😀b", 2), format!("{}…", crate::js_string::slice_units("a😀", 0, 2)));
        assert_eq!(crate::js_string::units_vec(&cut("a😀b", 2)), [0x61, 0xD83D, 0x2026]);
    }
}
