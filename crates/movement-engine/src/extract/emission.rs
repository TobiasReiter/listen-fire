//! What an extraction yields (extraction.ts `ExtractEmission`): one record
//! per entity, its exported fields, each field's extraction origin (the call
//! site, the field's words, the model's quote), the entity's own origin, the
//! source content it was read from as resources, and its children by edge
//! name. The run binds the root (`extractRoot`); a block head over it lands
//! on the children (`extractPosition`).
//!
//! While the walk runs, an entity is `Working`: every stage's fields so far
//! (`context`), its origins, the files its own stages fetched, its children.
//! `export` turns the finished tree into emissions.

use std::rc::Rc;

use movement_parser::catalog::types::{FieldType, Scalar};

use crate::env;
use crate::extract::spec::{NodeSpec, Region};
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
            ("provenance", Js::object(provenance)),
        ];
        if let Some(id) = self.origin {
            members.push(("origin", origin(id)));
        }
        members.push(("resources", Js::array(self.resources.clone())));
        members.push(("children", Js::object(children)));
        env::object_of(members)
    }
}

/// An entity while its stages run (`WorkingEmission`).
#[derive(Debug)]
pub(crate) struct Working<'s> {
    pub(crate) spec: &'s NodeSpec,
    pub(crate) stage_index: usize,
    /// Every stage's fields so far, working ones included.
    pub(crate) context: JsObject,
    pub(crate) provenance: Vec<(String, u32)>,
    pub(crate) origin: Option<u32>,
    /// The files this entity's own stages fetched.
    pub(crate) resources: Option<Vec<Js>>,
    pub(crate) children: Vec<(String, Vec<Working<'s>>)>,
}

impl<'s> Working<'s> {
    /// The root no call answered: the walk still runs its later stages.
    pub(crate) fn unanswered(spec: &'s NodeSpec) -> Working<'s> {
        Working { spec, stage_index: 0, context: JsObject::new(), provenance: Vec::new(), origin: None, resources: None, children: Vec::new() }
    }

    /// `children.has(name)`.
    pub(crate) fn has_child(&self, name: &str) -> bool {
        self.children.iter().any(|(n, _)| n == name)
    }

    /// `children.set(name, list)`: a name already there keeps its place.
    pub(crate) fn set_children(&mut self, name: String, list: Vec<Working<'s>>) {
        match self.children.iter_mut().find(|(n, _)| *n == name) {
            Some(slot) => slot.1 = list,
            None => self.children.push((name, list)),
        }
    }

    /// `{...emission.context, ...next.context}` and the same over the
    /// origins: a later stage's answer joins the entity.
    pub(crate) fn absorb_stage(&mut self, next: Working<'s>) {
        for (key, value) in next.context.entries() {
            self.context.set(key.clone(), value.clone());
        }
        for (field, id) in next.provenance {
            js::insert_in_object_order(&mut self.provenance, field, id);
        }
        for (name, list) in next.children {
            self.set_children(name, list);
        }
    }

    /// `isEmptyRecord`: every field its stage declares came back absent; a
    /// node declaring none is structural, never empty.
    fn is_empty_record(&self) -> bool {
        let fields = &self.spec.stages[self.stage_index].fields;
        !fields.is_empty() && fields.iter().all(|f| self.context.get(&f.name).is_none_or(Js::is_nullish))
    }
}

/// `projectEmission`: one record of a validated reply as an entity of the
/// region's node — each field's value (blank is absent; `json` as given),
/// its origin at the call's site with the model's quote, and the batched
/// children's records under their names.
pub(crate) fn project<'s>(raw: &JsObject, site: &Region<'s>, site_ref: &dyn Fn(&str) -> Js, mint: &dyn Fn(Js) -> u32) -> Working<'s> {
    let reference = site_ref(&site.site_id);
    let mut context = JsObject::new();
    let mut provenance = Vec::new();
    for field in site.fields() {
        // `raw[field.name]`: through the record's prototype, which a
        // `__proto__` in the reply set (crate::extract::validate).
        let wrapped = js::plain_property(raw, &field.name);
        let value = match &wrapped {
            Js::Object(object) => object.get("value").cloned().unwrap_or(Js::Undefined),
            _ => Js::Undefined,
        };
        let value = if matches!(field.type_, Some(FieldType::Scalar(Scalar::Json))) {
            if value.is_nullish() { Js::Null } else { value }
        } else {
            absent_if_blank(&value)
        };
        context.set(field.name.clone(), value);
        let mut origin = vec![
            ("kind", Js::str("extraction")),
            ("site", reference.clone()),
            ("field", Js::str(field.name.clone())),
            ("description", Js::str(field.description.clone())),
        ];
        if let Js::Object(object) = &wrapped
            && let Some(quote) = object.get("evidence").filter(|e| e.truthy())
        {
            origin.push(("quote", quote.clone()));
        }
        js::insert_in_object_order(&mut provenance, field.name.clone(), mint(env::object_of(origin)));
    }
    let mut children = Vec::new();
    for child in &site.children {
        let records = match js::plain_property(raw, &child.spec.name) {
            Js::Array(list) => list.items().clone(),
            Js::Undefined | Js::Null => Vec::new(),
            other => vec![other],
        };
        let projected = records
            .iter()
            .filter_map(|record| match record {
                Js::Object(object) => Some(project(object, child, site_ref, mint)),
                // An array is an object to `typeof`, and projects as a record
                // with no fields.
                Js::Array(_) => Some(project(&JsObject::new(), child, site_ref, mint)),
                _ => None,
            })
            .collect();
        children.push((child.spec.name.clone(), projected));
    }
    let origin = mint(env::object_of(vec![("kind", Js::str("extraction")), ("site", reference)]));
    Working { spec: site.spec, stage_index: site.stage_index, context, provenance, origin: Some(origin), resources: None, children }
}

/// `absentIfBlank`: a blank text is absent; a list drops its blank members,
/// and a list left empty is absent.
pub(crate) fn absent_if_blank(value: &Js) -> Js {
    match value {
        Js::Undefined => Js::Null,
        Js::String(text) if js::trim(text).is_empty() => Js::Null,
        Js::Array(list) => {
            let kept: Vec<Js> = list.items().iter().map(absent_if_blank).filter(|v| !matches!(v, Js::Null)).collect();
            if kept.is_empty() { Js::Null } else { Js::array(kept) }
        }
        other => other.clone(),
    }
}

/// `countEmptyEmissions`: per node name, the records whose own fields all
/// came back absent, counted before any is dropped.
pub(crate) fn count_empty(emissions: &[Working<'_>], into: &mut Vec<(String, f64)>) {
    for emission in emissions {
        if emission.is_empty_record() {
            bump(into, &emission.spec.name);
        }
        for (_, children) in &emission.children {
            count_empty(children, into);
        }
    }
}

/// `dropEmptyEmissions`: a record with nothing in it is dropped, judged
/// bottom-up, so a fieldless parent survives on its children.
pub(crate) fn drop_empty<'s>(emissions: Vec<Working<'s>>, dropped: &mut Vec<(String, f64)>) -> Vec<Working<'s>> {
    let mut kept = Vec::new();
    for mut emission in emissions {
        let mut carries_children = false;
        for (_, children) in emission.children.iter_mut() {
            let survivors = drop_empty(std::mem::take(children), dropped);
            carries_children |= !survivors.is_empty();
            *children = survivors;
        }
        if carries_children || !emission.is_empty_record() {
            kept.push(emission);
        } else {
            bump(dropped, &emission.spec.name);
        }
    }
    kept
}

fn bump(into: &mut Vec<(String, f64)>, name: &str) {
    match into.iter_mut().find(|(n, _)| n == name) {
        Some(slot) => slot.1 += 1.0,
        None => js::insert_in_object_order(into, name.to_string(), 1.0),
    }
}

/// `exportEmission`: the finished entity — its exported fields (a text
/// nobody found handed over as `""` from version 2), the origins of those,
/// and the resources it was read from: what it inherits, then what its own
/// stages fetched, which its children inherit too.
pub(crate) fn export(working: Working<'_>, inherited: &[Js], language_version: u32) -> Rc<Emission> {
    let resources: Vec<Js> = match &working.resources {
        Some(own) => inherited.iter().chain(own).cloned().collect(),
        None => inherited.to_vec(),
    };
    let text_fields = present_text_fields(working.spec, language_version);
    let mut fields = JsObject::new();
    let mut provenance = Vec::new();
    for name in &working.spec.exported {
        let value = working.context.get(name).cloned().unwrap_or(Js::Null);
        let value = if value.is_nullish() && text_fields.contains(name) {
            Js::str("")
        } else if value.is_nullish() {
            Js::Null
        } else {
            value
        };
        fields.set(name.clone(), value);
        if let Some((_, id)) = working.provenance.iter().find(|(field, _)| field == name) {
            js::insert_in_object_order(&mut provenance, name.clone(), *id);
        }
    }
    let children = working
        .children
        .into_iter()
        .map(|(name, list)| (name, list.into_iter().map(|child| export(child, &resources, language_version)).collect()))
        .collect();
    Rc::new(Emission { node_name: working.spec.name.clone(), fields, provenance, origin: working.origin, resources, children })
}

/// `presentTextFields`: the fields a program reads as present text — plain
/// text (or untyped), by the stage that last declares them, not `| null`.
/// Version 1 hands an unfound text over absent like any other field.
fn present_text_fields(spec: &NodeSpec, language_version: u32) -> Vec<String> {
    if language_version < 2 {
        return Vec::new();
    }
    let mut declared: Vec<(&str, &crate::extract::spec::FieldSpec)> = Vec::new();
    for field in spec.stages.iter().flat_map(|stage| &stage.fields) {
        match declared.iter_mut().find(|(name, _)| *name == field.name) {
            Some(slot) => slot.1 = field,
            None => declared.push((&field.name, field)),
        }
    }
    declared
        .into_iter()
        .filter(|(_, field)| !field.nullable && matches!(field.type_, None | Some(FieldType::Scalar(Scalar::Text))))
        .map(|(name, _)| name.to_string())
        .collect()
}

// ── The trace's sample of what was extracted ────────────────────────────────

const TRACE_ENTITY_CAP: usize = 20;
const TRACE_VALUE_CHARS: usize = 200;

/// `collectTracedEntities`: depth first, by node name, each record's fields
/// as display text, at most twenty per name and the rest counted: the
/// `entities` and `truncatedCount` objects, each in the order first met.
pub(crate) fn traced_entities(root: &Emission) -> (Js, Js) {
    traced_entities_of(&traced_tree(root))
}

/// A record and the records under it as the trace's sample reads them
/// (`TracedTree`): its node's name, its fields, its children in order.
pub(crate) struct TracedTree {
    pub(crate) node_name: String,
    pub(crate) fields: Vec<(String, Js)>,
    pub(crate) children: Vec<TracedTree>,
}

fn traced_tree(emission: &Emission) -> TracedTree {
    TracedTree {
        node_name: emission.node_name.clone(),
        fields: emission.fields.entries().to_vec(),
        children: emission.children.iter().flat_map(|(_, list)| list.iter().map(|child| traced_tree(child))).collect(),
    }
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
                js::insert_in_object_order(into, alias.clone(), Vec::new());
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
        Js::String(text) => text.clone(),
        Js::Array(_) | Js::Object(_) => js::json_stringify(value, 0),
        other => other.to_js_string(),
    };
    Js::str(cut(&text, TRACE_VALUE_CHARS))
}

/// A text past `limit` UTF-16 units cut there and marked, as
/// `${text.slice(0, limit)}…` cuts it.
pub(crate) fn cut(text: &str, limit: usize) -> String {
    if js::utf16_len(text) <= limit {
        return text.to_string();
    }
    let mut units = 0;
    let head: String = text
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= limit
        })
        .collect();
    format!("{head}…")
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
        assert_eq!(cut("a😀b", 2), "a…");
    }
}
