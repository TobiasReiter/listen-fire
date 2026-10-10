//! The mapping a walk a dict holds carries (`walk.mapping`), built as
//! run.ts's `mapIterations` builds it from whatever the data holds:
//! `synthesiseNode`, or `buildGraph` where the literal names a graph. Each
//! node built is the very object the TypeScript builds (a `nodePosition`
//! dict), which this engine reads as the TypeScript reads such a dict. The
//! literal is data, so an entry that would evaluate an expression or walk a
//! head, a spread to apply and a shape to build to stay this engine's
//! refusals; the rest — the TypeErrors where the data is not a literal's
//! shape, nested nodes, declared edges, empty graphs — is mirrored.

use std::rc::Rc;

use crate::bindings::Binding;
use crate::eval::EvalError;
use crate::js::{Js, JsObject};
use crate::record::{get, type_error};
use crate::run::Failure;

/// `env.resolve(name)` in the scope the mapping builds in.
pub(crate) type Resolve<'a> = &'a dyn Fn(&Js) -> Option<Binding>;

fn eval(error: EvalError) -> Failure {
    Failure::of_eval(error, "")
}

fn refused(what: &str) -> Failure {
    Failure::unreproduced(&format!("a walk a value holds as data with a mapping that {what}"), "the TypeScript engine evaluates what the data writes")
}

/// The entries `for (const x of value)` walks, or None where it throws.
fn iterated(value: &Js) -> Option<Vec<Js>> {
    match value {
        Js::Array(list) => Some(list.items().clone()),
        Js::String(text) => Some(text.chars().map(|c| Js::String(c.to_string())).collect()),
        _ => None,
    }
}

/// An edge's name as `node.edges[name] = …` keys it: text this engine
/// writes as itself (a key the prototype setter takes, or one a number
/// orders, is refused).
fn edge_name(entry: &Js) -> Result<String, Failure> {
    match get(entry, "name").map_err(eval)? {
        Js::String(name) if name != "__proto__" => Ok(name),
        _ => Err(refused("names an edge by something other than text")),
    }
}

fn new_node() -> JsObject {
    let mut node = JsObject::new();
    node.set("kind".into(), Js::str("nodePosition"));
    node.set("fields".into(), Js::object(JsObject::new()));
    node.set("fieldOrder".into(), Js::array(Vec::new()));
    node.set("fieldProvenance".into(), Js::object(JsObject::new()));
    node
}

fn landed(landings: Vec<Js>) -> Js {
    let mut edge = JsObject::new();
    edge.set("kind".into(), Js::str("landed"));
    edge.set("landings".into(), Js::array(landings));
    Js::object(edge)
}

/// `synthesiseNode(literal, env)`.
pub(crate) fn synthesise_node(literal: &Js, resolve: Resolve<'_>) -> Result<Rc<JsObject>, Failure> {
    if !matches!(get(literal, "graph").map_err(eval)?, Js::Undefined) {
        return build_graph(literal, resolve);
    }
    // An array's `entries` is `Array.prototype.entries`, no list.
    let entries = if matches!(literal, Js::Array(_)) { None } else { iterated(&get(literal, "entries").map_err(eval)?) };
    let entries = entries.ok_or_else(|| eval(type_error("literal.entries is not iterable")))?;
    let mut edges = JsObject::new();
    for entry in entries {
        match get(&entry, "kind").map_err(eval)? {
            Js::String(kind) if kind == "value" => return Err(refused("evaluates a value")),
            Js::String(kind) if kind == "traversal" => return Err(refused("walks a head")),
            Js::String(kind) if kind == "nodes" => {
                let nested = iterated(&get(&entry, "nodes").map_err(eval)?).ok_or_else(|| eval(type_error("entry.nodes is not iterable")))?;
                let landings = nested.iter().map(|n| synthesise_node(n, resolve).map(Js::Object)).collect::<Result<Vec<_>, _>>()?;
                edges.set(edge_name(&entry)?, landed(landings));
            }
            // A declared edge starts empty; one naming a declaration in
            // scope would carry that declaration's landing shape.
            Js::String(kind) if kind == "declared" => {
                let declared = get(&entry, "type").map_err(eval)?;
                if matches!(get(&declared, "hopsRaw").map_err(eval)?, Js::Undefined)
                    && resolve(&get(&declared, "graph").map_err(eval)?).is_some_and(|b| crate::record::kind_of(&b) == "shape")
                {
                    return Err(refused("declares an edge by a declaration in scope"));
                }
                edges.set(edge_name(&entry)?, landed(Vec::new()));
            }
            _ => {}
        }
    }
    let mut node = new_node();
    node.set("edges".into(), Js::object(edges));
    Ok(Rc::new(node))
}

/// `buildGraph(literal, env)`: the shape the graph names, then its body.
fn build_graph(literal: &Js, resolve: Resolve<'_>) -> Result<Rc<JsObject>, Failure> {
    let optional = |value: &Js, key: &str| if value.is_nullish() { Ok(Js::Undefined) } else { get(value, key).map_err(eval) };
    let name = optional(&optional(&get(literal, "graph").map_err(eval)?, "shape")?, "name")?;
    if !matches!(name, Js::Undefined) {
        if resolve(&name).is_some_and(|b| crate::record::kind_of(&b) == "shape") {
            return Err(refused("builds a graph to a declaration in scope"));
        }
        let name = name.to_text().map_err(|e| eval(type_error(&e.message)))?;
        return Err(Failure::engine("MOVENG_RUNTIME", format!("'graph<{name}>' names no node declaration in scope")));
    }
    build_graph_body(literal)
}

/// `buildGraphBody(literal, env, undefined)`.
fn build_graph_body(literal: &Js) -> Result<Rc<JsObject>, Failure> {
    let entries = match literal {
        Js::Array(_) => None,
        literal => match get(literal, "entries").map_err(eval)? {
            Js::Array(list) => Some(list.items().clone()),
            nullish @ (Js::Undefined | Js::Null) => return Err(eval(type_error(&format!("Cannot read properties of {} (reading 'entries')", nullish.to_js_string())))),
            _ => None,
        },
    };
    let entries = entries.ok_or_else(|| eval(type_error("literal.entries.entries is not a function or its return value is not iterable")))?;
    let spreads_at = |index: usize| -> Result<(), Failure> {
        let spreads = match get(literal, "spreads").map_err(eval)? {
            Js::Undefined | Js::Null => return Ok(()),
            Js::Array(list) => list.items().clone(),
            _ => return Err(eval(type_error("(literal.spreads ?? []).filter is not a function"))),
        };
        for spread in spreads {
            if crate::js::strict_equals(&get(&spread, "after").map_err(eval)?, &Js::Number(index as f64)) {
                return Err(refused("spreads a value into a graph"));
            }
        }
        Ok(())
    };
    let mut edges = JsObject::new();
    for (index, entry) in entries.iter().enumerate() {
        spreads_at(index)?;
        match get(entry, "kind").map_err(eval)? {
            Js::String(kind) if kind == "value" => return Err(refused("evaluates a value")),
            Js::String(kind) if kind == "traversal" => return Err(refused("walks a head")),
            Js::String(kind) if kind == "nodes" => {
                let nested = iterated(&get(entry, "nodes").map_err(eval)?).ok_or_else(|| eval(type_error("entry.nodes is not iterable")))?;
                let landings = nested.iter().map(build_graph_body).collect::<Result<Vec<_>, _>>()?;
                let name = edge_name(entry)?;
                // `setGraphEdge`: a node built on the edge has landed there.
                let landings = landings.into_iter().map(|landing| Js::Object(landed_on(landing, &name))).collect();
                edges.set(name, landed(landings));
            }
            Js::String(kind) if kind == "declared" => {
                let name = get(entry, "name").map_err(eval)?.to_text().map_err(|e| eval(type_error(&e.message)))?;
                return Err(Failure::engine("MOVENG_RUNTIME", format!("a declared edge ('{name}') inside a graph literal — the parser refuses one")));
            }
            _ => {}
        }
    }
    spreads_at(entries.len())?;
    let mut node = new_node();
    node.set("edges".into(), Js::object(edges));
    Ok(Rc::new(node))
}

/// A node `buildGraphBody` built, marked as landed on `edge`.
fn landed_on(node: Rc<JsObject>, edge: &str) -> Rc<JsObject> {
    let mut node = JsObject::clone_of(&node);
    if node.get("landedOn").is_none() {
        node.set("landedOn".into(), Js::str(edge));
    }
    Rc::new(node)
}
