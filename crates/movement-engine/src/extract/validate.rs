//! A model's reply to an extraction call, read as extraction_call.ts reads it
//! with zod (`responseSchema`): each node's records unwrapped from a field's
//! `{ evidence, value }` packaging (`recordListReader`), each field's
//! evidence normalised (`normaliseFieldEvidence`) and its value checked by
//! type (`zodForFieldType`), an entity answered only under keys nothing
//! declares refused (`entitySchemaFor`) — with zod's issues, in zod's order
//! and words, and what the read coerced (`CoercionTracker`).
//!
//! A reply is a map: every key is its own, `__proto__` and `constructor`
//! included, and a declared field the reply leaves out is absent.

use crate::extract::spec::NodeSpec;
use crate::js::{self, Js, JsObject};
use movement_parser::catalog::types::{Composite, FieldType, Scalar};

/// One step of an issue's path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathKey {
    Key(String),
    Index(usize),
}

/// One complaint, as zod words it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub path: Vec<PathKey>,
    pub message: String,
}

/// What a read normalised away (`CoercionTracker`): each keyed
/// `<node>.<field>` in the order first recorded.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Coercions {
    /// A closed enum's non-member, nulled or dropped.
    pub values: Vec<(String, Vec<String>)>,
    /// A citation rewritten to its quote, or to nothing.
    pub evidence: Vec<(String, Vec<String>)>,
    /// How the reply was packaged before its envelope was rebuilt.
    pub envelope: Option<String>,
}

/// A reply that validated: what the schema hands on, and what it coerced.
#[derive(Debug, Clone)]
pub struct Read {
    pub value: Js,
    pub coercions: Coercions,
}

/// extraction_call.ts `responseSchema(spec, sink, finds).safeParse(reply)`:
/// the extraction CALL's answer — every record under `records` (`one`: the
/// one record, or null, under `record`), each field `{ value, evidence }`
/// with its citation normalised (`normaliseCallField`), each nested node a
/// bare list of its own records.
pub fn read_call_reply(spec: &NodeSpec, one: bool, reply: &Js) -> Result<Read, Vec<Issue>> {
    let mut parse = Parse { issues: Vec::new(), path: Vec::new(), coercions: Coercions::default() };
    let value = parse.call_response(spec, one, reply);
    if parse.issues.is_empty() { Ok(Read { value, coercions: parse.coercions }) } else { Err(parse.issues) }
}

/// The issues as the retry prompt and the trace list them (`issueLines`).
pub fn issue_lines(issues: &[Issue]) -> Vec<String> {
    issues.iter().map(|issue| format!("  - {}: {}", joined(&issue.path), issue.message)).collect()
}

/// An issue's path as zod joins it (`path.join('.')`).
pub fn issue_path(issue: &Issue) -> String {
    joined(&issue.path)
}

fn joined(path: &[PathKey]) -> String {
    path.iter()
        .map(|step| match step {
            PathKey::Key(key) => key.clone(),
            PathKey::Index(i) => i.to_string(),
        })
        .collect::<Vec<_>>()
        .join(".")
}

// ── The envelope ─────────────────────────────────────────────────────────────

// ── The extraction call's schema ─────────────────────────────────────────────

/// `recordList`: a node's records, a lone record made a list.
fn call_record_list(value: &Js) -> Js {
    match value {
        Js::Array(_) | Js::Undefined | Js::Null => value.clone(),
        record => Js::array(vec![record.clone()]),
    }
}

/// `singleRecord`: a list holding one record (or none) read as that record
/// (or null); a list of several stays a list, for the schema to refuse.
fn single_record(value: &Js) -> Js {
    match value {
        Js::Array(list) if list.items().len() <= 1 => list.items().first().cloned().unwrap_or(Js::Null),
        other => other.clone(),
    }
}

/// `normaliseCallField`: a field's citation as the model may write it — the
/// object asked for, a bare quote, or nothing — made `{ item?, quote? }` or
/// null; the value left as written.
fn normalise_call_field(raw: &Js) -> Js {
    let Js::Object(object) = raw else { return raw.clone() };
    if object.get("value").is_none() {
        return raw.clone();
    }
    let evidence = match object.get("evidence") {
        None | Some(Js::Undefined | Js::Null) => Js::Null,
        Some(Js::String(quote)) => crate::env::object_of(vec![("quote", Js::str(quote.clone()))]),
        Some(Js::Object(evidence)) => {
            let item = match evidence.get("item") {
                Some(Js::String(text)) if !js::trim(text.as_str()).is_empty() && js::trim(text.as_str()).bytes().all(|b| b.is_ascii_digit()) => {
                    Js::Number(js::string_to_number(js::trim(text.as_str())))
                }
                Some(other) => other.clone(),
                None => Js::Undefined,
            };
            let quote = [evidence.get("quote"), evidence.get("text")].into_iter().flatten().find(|q| matches!(q, Js::String(_))).cloned();
            let mut members = Vec::new();
            if let Js::Number(n) = item
                && js::is_integer(n)
            {
                members.push(("item", item));
            }
            if let Some(quote) = quote {
                members.push(("quote", quote));
            }
            crate::env::object_of(members)
        }
        Some(_) => Js::Null,
    };
    let mut copy = JsObject::clone_of(object);
    copy.set("evidence".into(), evidence);
    Js::object(copy)
}

impl Parse {
    /// The answer key, required; any other key passes through.
    fn call_response(&mut self, spec: &NodeSpec, one: bool, reply: &Js) -> Js {
        let Js::Object(object) = reply else {
            self.expected("object", reply);
            return Js::Undefined;
        };
        let key = if one { "record" } else { "records" };
        let under = object.get(key).cloned();
        let parsed = self.at(PathKey::Key(key.into()), |p| {
            let given = under.clone().unwrap_or(Js::Undefined);
            if one { p.call_one(spec, &given) } else { p.call_records(spec, &call_record_list(&given)) }
        });
        let mut out = JsObject::new();
        if under.is_some() || !matches!(parsed, Js::Undefined) {
            out.set(key.into(), parsed);
        }
        for (k, value) in object.entries() {
            if k != key {
                out.set(k.clone(), value.clone());
            }
        }
        Js::object(out)
    }

    /// `z.array(recordSchema(spec))`.
    fn call_records(&mut self, spec: &NodeSpec, value: &Js) -> Js {
        let Js::Array(list) = value else {
            self.expected("array", value);
            return Js::Undefined;
        };
        let items = list.items().iter().enumerate().map(|(i, item)| self.at(PathKey::Index(i), |p| p.call_record(spec, item))).collect();
        Js::array(items)
    }

    /// `extractOne`'s answer: several records refused (the pipe goes no
    /// further), else the record or null.
    fn call_one(&mut self, spec: &NodeSpec, value: &Js) -> Js {
        let value = single_record(value);
        match &value {
            Js::Array(list) => {
                self.issue(format!("{} records were answered, and this asks for the single one — answer one object, or null", list.items().len()));
                Js::Undefined
            }
            Js::Null => Js::Null,
            record => self.call_record(spec, record),
        }
    }

    /// `recordSchema`: the declared keys checked, the rest passed through,
    /// and a record answered only under undeclared keys refused.
    fn call_record(&mut self, spec: &NodeSpec, value: &Js) -> Js {
        let Js::Object(object) = value else {
            self.expected("object", value);
            return Js::Undefined;
        };
        let stage = spec.stages.first();
        let mut declared: Vec<(String, CallDeclared<'_>)> = Vec::new();
        let fields = stage.into_iter().flat_map(|s| &s.fields).map(|f| (f.name.clone(), CallDeclared::Field(f)));
        let children = stage.into_iter().flat_map(|s| &s.children).map(|c| (c.name.clone(), CallDeclared::Child(c)));
        for (key, kind) in fields.chain(children) {
            js::set_entry(&mut declared, key, kind);
        }
        let declared_names: Vec<String> = declared.iter().map(|(k, _)| k.clone()).collect();
        let before = self.issues.len();
        let mut out = JsObject::new();
        for (key, kind) in &declared {
            let raw = object.get(key).cloned();
            let given = raw.clone().unwrap_or(Js::Undefined);
            let parsed = self.at(PathKey::Key(key.clone()), |p| match kind {
                CallDeclared::Field(field) => p.call_field(field.type_.as_ref(), &given, &format!("{}.{}", spec.name, field.name)),
                CallDeclared::Child(child) => match &given {
                    Js::Undefined => Js::Undefined,
                    Js::Null => Js::Null,
                    given => p.call_records(child, &call_record_list(given)),
                },
            });
            if raw.is_some() || !matches!(parsed, Js::Undefined) {
                out.set(key.clone(), parsed);
            }
        }
        for (key, value) in object.entries() {
            if !declared_names.contains(key) {
                out.set(key.clone(), value.clone());
            }
        }
        if self.issues.len() == before && !declared.is_empty() {
            let keys: Vec<String> = out.entries().iter().map(|(k, _)| k.clone()).collect();
            if !keys.is_empty() && !keys.iter().any(|k| declared_names.contains(k)) {
                let quoted = |names: &[String]| names.iter().map(|k| format!("`{k}`")).collect::<Vec<_>>().join(", ");
                self.issue(format!("this record was answered under {} — its fields are {}", quoted(&keys), quoted(&declared_names)));
            }
        }
        Js::object(out)
    }

    /// `fieldSchema`: absent, null, or `{ value, evidence }` — the value by
    /// type, then the citation.
    fn call_field(&mut self, type_: Option<&FieldType>, raw: &Js, ctx: &str) -> Js {
        let raw = normalise_call_field(raw);
        let Js::Object(object) = &raw else {
            if raw.is_nullish() {
                return raw;
            }
            self.expected("object", &raw);
            return Js::Undefined;
        };
        let mut out = JsObject::new();
        let value = object.get("value").cloned();
        let parsed = self.at(PathKey::Key("value".into()), |p| p.value(type_, value.as_ref().unwrap_or(&Js::Undefined), ctx));
        if value.is_some() || !matches!(parsed, Js::Undefined) {
            out.set("value".into(), parsed);
        }
        let evidence = object.get("evidence").cloned();
        let checked = self.at(PathKey::Key("evidence".into()), |p| p.citation(evidence.as_ref().unwrap_or(&Js::Undefined)));
        if evidence.is_some() || !matches!(checked, Js::Undefined) {
            out.set("evidence".into(), checked);
        }
        Js::object(out)
    }

    /// `citation`: `{ item?: integer, quote?: string }`, or null.
    fn citation(&mut self, value: &Js) -> Js {
        let Js::Object(object) = value else {
            if matches!(value, Js::Null) {
                return Js::Null;
            }
            self.expected("object", value);
            return Js::Undefined;
        };
        let mut out = JsObject::new();
        if let Some(item) = object.get("item") {
            let checked = self.at(PathKey::Key("item".into()), |p| match item {
                Js::Undefined => Js::Undefined,
                // zod's `int()` is a SAFE integer.
                Js::Number(n) if n.is_finite() && js::is_integer(*n) && n.abs() <= MAX_SAFE_INTEGER => item.clone(),
                Js::Number(n) if n.is_finite() && js::is_integer(*n) => {
                    p.issue(if *n > 0.0 {
                        "Too big: expected int to be <9007199254740991".into()
                    } else {
                        "Too small: expected int to be >-9007199254740991".into()
                    });
                    Js::Undefined
                }
                Js::Number(n) if n.is_finite() => {
                    p.issue("Invalid input: expected int, received number".into());
                    Js::Undefined
                }
                other => {
                    p.expected("number", other);
                    Js::Undefined
                }
            });
            out.set("item".into(), checked);
        }
        if let Some(quote) = object.get("quote") {
            let checked = self.at(PathKey::Key("quote".into()), |p| match quote {
                Js::Undefined | Js::String(_) => quote.clone(),
                other => {
                    p.expected("string", other);
                    Js::Undefined
                }
            });
            out.set("quote".into(), checked);
        }
        Js::object(out)
    }
}

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9007199254740991.0;

/// One key a call's record declares.
enum CallDeclared<'s> {
    Field(&'s crate::extract::spec::FieldSpec),
    Child(&'s NodeSpec),
}

// ── The schema ───────────────────────────────────────────────────────────────

struct Parse {
    issues: Vec<Issue>,
    path: Vec<PathKey>,
    coercions: Coercions,
}

/// zod's name for what it was handed (`received …`).
fn received(value: &Js) -> &'static str {
    match value {
        Js::Undefined => "undefined",
        Js::Null => "null",
        Js::Bool(_) => "boolean",
        Js::Number(n) if n.is_nan() => "NaN",
        Js::Number(_) => "number",
        Js::String(_) => "string",
        Js::Array(_) => "array",
        // A reply is JSON: it holds neither.
        Js::Object(_) | Js::Record(_) | Js::File(_) => "object",
    }
}

impl Parse {
    fn at<T>(&mut self, step: PathKey, within: impl FnOnce(&mut Parse) -> T) -> T {
        self.path.push(step);
        let out = within(self);
        self.path.pop();
        out
    }

    fn issue(&mut self, message: String) {
        self.issues.push(Issue { path: self.path.clone(), message });
    }

    fn expected(&mut self, expected: &str, value: &Js) {
        self.issue(format!("Invalid input: expected {expected}, received {}", received(value)));
    }

    /// `zodForFieldType`.
    fn value(&mut self, type_: Option<&FieldType>, value: &Js, ctx: &str) -> Js {
        let Some(type_) = type_ else { return value.clone() };
        match type_ {
            FieldType::Scalar(Scalar::Text | Scalar::Date | Scalar::Datetime | Scalar::File) => self.nullable(value, "string", |v| matches!(v, Js::String(_))),
            FieldType::Scalar(Scalar::Number) => self.nullable(value, "number", |v| matches!(v, Js::Number(n) if n.is_finite())),
            FieldType::Scalar(Scalar::Boolean) => self.nullable(value, "boolean", |v| matches!(v, Js::Bool(_))),
            FieldType::Scalar(Scalar::Json) => value.clone(),
            // No value is one that never arrives.
            FieldType::Scalar(Scalar::Never) => {
                self.expected("nothing", value);
                Js::Undefined
            }
            FieldType::Scalar(Scalar::Absent) => {
                if !matches!(value, Js::Null) {
                    self.expected("null", value);
                    return Js::Undefined;
                }
                Js::Null
            }
            FieldType::Composite(Composite::MaybeAbsent { of }) => self.value(Some(of), value, ctx),
            FieldType::Composite(Composite::List { of, .. }) => self.list(of, value, ctx),
            FieldType::Composite(Composite::Tuple { .. } | Composite::Dict { .. } | Composite::Record { .. }) => value.clone(),
            FieldType::Composite(Composite::Union { of }) if of.len() >= 2 => self.union(of, value, ctx),
            FieldType::Composite(Composite::Union { .. }) => value.clone(),
            FieldType::Composite(Composite::Enum { options, open: _ }) if options.is_empty() => {
                self.nullable(value, "string", |v| matches!(v, Js::String(_)))
            }
            FieldType::Composite(Composite::Enum { options, open }) => {
                if matches!(value, Js::String(s) if js::trim(s.as_str()).is_empty()) {
                    return Js::Null;
                }
                if let Some(matched) = match_option(value, options) {
                    return Js::str(matched);
                }
                if open.is_some() {
                    return if matches!(value, Js::String(_)) { value.clone() } else { Js::Null };
                }
                if !value.is_nullish() {
                    push(&mut self.coercions.values, ctx, value.to_js_string());
                }
                Js::Null
            }
        }
    }

    /// `z.<kind>().nullable()`.
    fn nullable(&mut self, value: &Js, expected: &str, is: impl Fn(&Js) -> bool) -> Js {
        if matches!(value, Js::Null) || is(value) {
            return value.clone();
        }
        self.expected(expected, value);
        Js::Undefined
    }

    /// `zodForListOfFieldType`: a multiselect keeps each entry's canonical
    /// option, an open one an unmatched text as written, and a closed one
    /// drops (and records) a non-member; any other list checks each entry.
    fn list(&mut self, element: &FieldType, value: &Js, ctx: &str) -> Js {
        let options = match element {
            FieldType::Composite(Composite::Enum { options, open }) if !options.is_empty() => Some((options, open.is_some())),
            _ => None,
        };
        let Js::Array(list) = value else {
            if matches!(value, Js::Null) {
                return Js::Null;
            }
            self.expected("array", value);
            return Js::Undefined;
        };
        let Some((options, open)) = options else {
            let items = list.items().iter().enumerate().map(|(i, item)| self.at(PathKey::Index(i), |p| p.value(Some(element), item, ctx))).collect();
            return Js::array(items);
        };
        let mut kept = Vec::new();
        for item in list.items().iter() {
            if matches!(item, Js::String(s) if js::trim(s.as_str()).is_empty()) {
                continue;
            }
            if let Some(matched) = match_option(item, options) {
                kept.push(Js::str(matched));
            } else if open {
                if matches!(item, Js::String(_)) {
                    kept.push(item.clone());
                }
            } else if !item.is_nullish() {
                push(&mut self.coercions.values, ctx, item.to_js_string());
            }
        }
        Js::array(kept)
    }

    /// `z.union`: the first member that reads the value; none, and the one
    /// issue zod raises for the union.
    fn union(&mut self, members: &[FieldType], value: &Js, ctx: &str) -> Js {
        for member in members {
            let mut trial = Parse { issues: Vec::new(), path: self.path.clone(), coercions: self.coercions.clone() };
            let read = trial.value(Some(member), value, ctx);
            if trial.issues.is_empty() {
                self.coercions = trial.coercions;
                return read;
            }
        }
        self.issue("Invalid input".into());
        Js::Undefined
    }
}

/// `matchOption`: the option spelled exactly (trimmed), else the one equal
/// ignoring case.
fn match_option(candidate: &Js, options: &[String]) -> Option<String> {
    let Js::String(candidate) = candidate else { return None };
    let trimmed = js::trim(candidate.as_str());
    if let Some(exact) = options.iter().find(|o| *o == trimmed) {
        return Some(exact.clone());
    }
    let lowered = js::to_lower_case(trimmed);
    options.iter().find(|o| js::to_lower_case(o) == lowered).cloned()
}

/// `pushCoercion`: past 80 characters a rendering is cut and marked.
fn push(into: &mut Vec<(String, Vec<String>)>, key: &str, rendered: String) {
    let rendered = if js::len_chars(&rendered) > 80 { crate::extract::emission::cut(&rendered, 80) } else { rendered };
    match into.iter_mut().find(|(k, _)| k == key) {
        Some((_, list)) => list.push(rendered),
        None => into.push((key.to_string(), vec![rendered])),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::spec::{FieldSpec, NodeSpec, StageSpec};

    fn node(fields: &[&str]) -> NodeSpec {
        let fields = fields.iter().map(|name| FieldSpec { name: name.to_string(), description: String::new(), type_: None, nullable: false }).collect();
        NodeSpec { name: "n".into(), description: String::new(), stages: vec![StageSpec { through: Vec::new(), fields, children: Vec::new() }], exported: Vec::new() }
    }

    fn reply(text: &str) -> Js {
        crate::env::js_of_serialized(&serde_json::from_str::<Box<serde_json::value::RawValue>>(text).unwrap())
    }

    /// A citation's `item` is a safe integer, as zod's `int()` holds it.
    #[test]
    fn a_citation_item_past_the_safe_integers_is_refused_as_zod_refuses_it() {
        let spec = node(&["name"]);
        for (item, line) in [
            ("1e20", "  - records.0.name.evidence.item: Too big: expected int to be <9007199254740991"),
            ("9007199254740992", "  - records.0.name.evidence.item: Too big: expected int to be <9007199254740991"),
            ("-9007199254740992", "  - records.0.name.evidence.item: Too small: expected int to be >-9007199254740991"),
        ] {
            let reply = reply(&format!(r#"{{"records": [{{"name": {{"evidence": {{"item": {item}}}}}}}]}}"#));
            let Err(issues) = read_call_reply(&spec, false, &reply) else { panic!("{item} is no safe integer") };
            assert!(issue_lines(&issues).contains(&line.to_string()), "{item}: {:?}", issue_lines(&issues));
        }
        let ok = reply(r#"{"records": [{"name": {"value": "a", "evidence": {"item": 9007199254740991}}}]}"#);
        assert!(read_call_reply(&spec, false, &ok).is_ok());
    }
}
