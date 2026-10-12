//! A model's reply to one region, read as extraction.ts reads it with zod
//! (`responseSchemaFor`): the envelope found where the model put it
//! (`envelopeReader`), each node's records unwrapped from a field's
//! `{ evidence, value }` packaging (`recordListReader`), each field's
//! evidence normalised (`normaliseFieldEvidence`) and its value checked by
//! type (`zodForFieldType`), an entity answered only under keys nothing
//! declares refused (`entitySchemaFor`) — with zod's issues, in zod's order
//! and words, and what the read coerced (`CoercionTracker`).
//!
//! Two accidents of JavaScript objects under zod are reproduced (README,
//! "Transition artefacts to mirror", row 5): zod reads a declared key
//! through the reply's prototype, so a field named after an
//! `Object.prototype` member (`constructor`, `toString`, …) that the reply
//! leaves out is a function, and fails (`expected object, received
//! function`); and zod writes each key it hands on with `object[key] =
//! value`, so a `__proto__` the reply writes becomes the record's prototype
//! (an object or `null`; anything else is dropped). A field DECLARED
//! `__proto__` is no key of zod's shape at all (`shape.__proto__ = …` set
//! the shape's prototype), so it is never checked, nor counted as declared.

use crate::extract::spec::{NodeSpec, Region};
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

/// `responseSchemaFor(region).safeParse(reply)`.
pub fn read_reply(region: &Region<'_>, reply: &Js) -> Result<Read, Vec<Issue>> {
    let mut parse = Parse { issues: Vec::new(), path: Vec::new(), coercions: Coercions::default() };
    let reply = envelope(region, reply, &mut parse.coercions);
    let value = parse.response(region, &reply);
    if parse.issues.is_empty() { Ok(Read { value, coercions: parse.coercions }) } else { Err(parse.issues) }
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

/// `retryInstruction`: a complaint at the top of the reply is about its
/// packaging, so the envelope is shown; any other asks for the values fixed.
pub fn retry_instruction(region: &Region<'_>, issues: &[Issue]) -> String {
    let packaging = issues.iter().any(|issue| match issue.path.as_slice() {
        [] => true,
        [PathKey::Key(key)] => *key == region.site_id,
        _ => false,
    });
    if packaging {
        format!(
            "The SHAPE of your response was wrong: the entire answer belongs under one key, `{}`, whose value is a JSON array of records. Keep the values you already extracted and return them in exactly this envelope:\n{}",
            region.site_id,
            envelope_example(region)
        )
    } else {
        "Please fix ONLY the invalid values and return the complete corrected JSON.".to_string()
    }
}

/// `envelopeExample`: the envelope a region asks for, written out.
pub fn envelope_example(region: &Region<'_>) -> String {
    let fields = region.fields().iter().map(|f| format!("\"{}\": {{\"evidence\": string|null, \"value\": …}}", f.name));
    let children = region.children.iter().map(|c| format!("\"{}\": [ … ]", c.spec.name));
    format!("{{\"{}\": [ {{ {} }} ] }}", region.site_id, fields.chain(children).collect::<Vec<_>>().join(", "))
}

/// `unansweredDetail`: which of the two failures a rejected reply was —
/// `answered` is the reply as the model wrote it.
pub fn unanswered_detail(region: &Region<'_>, answered: &Js, issues: &[Issue]) -> String {
    let keys: Vec<String> = match answered {
        Js::Object(object) => object.entries().iter().map(|(k, _)| k.clone()).collect(),
        Js::Array(list) => (0..list.items().len()).map(|i| i.to_string()).collect(),
        _ => Vec::new(),
    };
    if keys.contains(&region.site_id) {
        let first = match issues.first() {
            None => "the schema could not read what was inside".to_string(),
            Some(issue) if issue.path.is_empty() => issue.message.clone(),
            Some(issue) => format!("at `{}`, {}", joined(&issue.path), issue.message),
        };
        format!("The reply answered under `{}`, but {first}. ", region.site_id)
    } else if !keys.is_empty() {
        format!("The reply came back under {}, not `{}`. ", quote_keys(&keys), region.site_id)
    } else {
        "The reply carried nothing the schema could read. ".to_string()
    }
}

/// `quoteKeys`: at most six, each in backticks.
pub fn quote_keys(keys: &[String]) -> String {
    let named: Vec<String> = keys.iter().take(NAMED_KEYS).map(|k| format!("`{k}`")).collect();
    if keys.len() > NAMED_KEYS { format!("{}, …", named.join(", ")) } else { named.join(", ") }
}

const NAMED_KEYS: usize = 6;

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

/// `envelopeReader`: the region's records found when the reply put them
/// somewhere other than under the answer key — bare, or under one key of
/// the model's own — recognised by shape, never by label.
fn envelope(region: &Region<'_>, reply: &Js, coercions: &mut Coercions) -> Js {
    if region.declares_nothing() {
        return reply.clone();
    }
    if let Js::Object(object) = reply
        && object.get(&region.site_id).is_some()
    {
        return reply.clone();
    }
    let answer = |records: Js| {
        let mut object = JsObject::new();
        object.set(region.site_id.clone(), records);
        Js::object(object)
    };
    if let Some(records) = region_records(region, reply) {
        coercions.envelope = Some(if matches!(reply, Js::Array(_)) { "a bare list of records" } else { "a bare record" }.to_string());
        return answer(records);
    }
    if let Js::Object(object) = reply
        && let [(key, labelled)] = object.entries()
        && !region.declares(key)
        && let Some(records) = region_records(region, labelled)
    {
        coercions.envelope = Some(format!("keyed `{key}`"));
        return answer(records);
    }
    reply.clone()
}

/// `regionRecords`: one of the region's records, or a non-empty list of them.
fn region_records(region: &Region<'_>, value: &Js) -> Option<Js> {
    if declared_record(region, value) {
        return Some(Js::array(vec![value.clone()]));
    }
    match value {
        Js::Array(list) if !list.items().is_empty() && list.items().iter().all(|item| declared_record(region, item)) => Some(value.clone()),
        _ => None,
    }
}

/// `isDeclaredRecord`: an object with keys, every one of them declared.
fn declared_record(region: &Region<'_>, value: &Js) -> bool {
    matches!(value, Js::Object(object) if !object.entries().is_empty() && object.entries().iter().all(|(k, _)| region.declares(k)))
}

/// `recordListReader`: a node's records, the `{ evidence, value }` packaging
/// taken off a list it does not belong to, and a lone record made a list. A
/// node declaring `value` or `evidence` is answered with objects keyed so,
/// which are its records.
fn record_list(site: &Region<'_>, value: &Js) -> Js {
    let ambiguous = site.declares("value") || site.declares("evidence");
    let records = match value {
        Js::Object(object) if !ambiguous && evidence_envelope(object) => object.get("value").cloned().unwrap_or(Js::Undefined),
        other => other.clone(),
    };
    match records {
        Js::Array(_) | Js::Undefined | Js::Null => records,
        record => Js::array(vec![record]),
    }
}

/// `isEvidenceEnvelope`: `value`, and nothing but an optional `evidence`.
fn evidence_envelope(object: &JsObject) -> bool {
    object.get("value").is_some() && object.entries().iter().all(|(k, _)| k == "value" || k == "evidence")
}

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
                Some(Js::String(text)) if !js::trim(text).is_empty() && js::trim(text).bytes().all(|b| b.is_ascii_digit()) => {
                    Js::Number(js::string_to_number(js::trim(text)))
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
                out.assign(k.clone(), value.clone());
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
        for (key, kind) in fields.chain(children).filter(|(key, _)| key != "__proto__") {
            js::insert_in_object_order(&mut declared, key, kind);
        }
        let declared_names: Vec<String> = declared.iter().map(|(k, _)| k.clone()).collect();
        let before = self.issues.len();
        let mut out = JsObject::new();
        for (key, kind) in &declared {
            let raw = object.get(key).cloned().or_else(|| js::is_object_prototype_name(key).then(|| js::plain_property(object, key)));
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
                out.assign(key.clone(), value.clone());
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

/// One key an entity declares: a field, or a child node.
enum Declared<'r, 's> {
    Field(&'s crate::extract::spec::FieldSpec),
    Child(&'r Region<'s>),
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
        Js::Function(_) => "function",
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

    /// The answer key, required, holding the region's records; any other
    /// key passes through.
    fn response(&mut self, region: &Region<'_>, reply: &Js) -> Js {
        let Js::Object(object) = reply else {
            self.expected("object", reply);
            return Js::Undefined;
        };
        let under = object.get(&region.site_id).cloned().unwrap_or(Js::Undefined);
        let records = self.at(PathKey::Key(region.site_id.clone()), |p| p.records(region, &record_list(region, &under)));
        let mut out = JsObject::new();
        out.set(region.site_id.clone(), records);
        for (key, value) in object.entries() {
            if *key != region.site_id {
                out.assign(key.clone(), value.clone());
            }
        }
        Js::object(out)
    }

    /// `z.array(entitySchemaFor(site))`.
    fn records(&mut self, site: &Region<'_>, value: &Js) -> Js {
        let Js::Array(list) = value else {
            self.expected("array", value);
            return Js::Undefined;
        };
        let items = list.items().iter().enumerate().map(|(i, item)| self.at(PathKey::Index(i), |p| p.entity(site, item))).collect();
        Js::array(items)
    }

    /// `entitySchemaFor`: the declared keys checked, the rest passed
    /// through, and an entity answered only under undeclared keys refused.
    fn entity(&mut self, site: &Region<'_>, value: &Js) -> Js {
        let Js::Object(object) = value else {
            self.expected("object", value);
            return Js::Undefined;
        };
        // The schema's keys in the order a JavaScript object holds them: a
        // child named like a field takes the field's place.
        // `shape.__proto__ = …` sets the shape's prototype: no key of it.
        let mut declared: Vec<(String, Declared<'_, '_>)> = Vec::new();
        let fields = site.fields().iter().map(|f| (f.name.clone(), Declared::Field(f)));
        let children = site.children.iter().map(|c| (c.spec.name.clone(), Declared::Child(c)));
        for (key, kind) in fields.chain(children).filter(|(key, _)| key != "__proto__") {
            js::insert_in_object_order(&mut declared, key, kind);
        }
        let declared_names: Vec<String> = declared.iter().map(|(k, _)| k.clone()).collect();
        let before = self.issues.len();
        let mut out = JsObject::new();
        for (key, kind) in &declared {
            // `input[key]`, read through the reply's prototype: a member
            // of `Object.prototype` the reply leaves out is its function.
            let raw = object.get(key).cloned().or_else(|| js::is_object_prototype_name(key).then(|| js::plain_property(object, key)));
            let parsed = self.at(PathKey::Key(key.clone()), |p| match kind {
                Declared::Field(field) => {
                    let ctx = format!("{}.{}", site.spec.name, field.name);
                    p.field(field.type_.as_ref(), raw.as_ref().unwrap_or(&Js::Undefined), &ctx)
                }
                Declared::Child(child) => match raw.as_ref().unwrap_or(&Js::Undefined) {
                    Js::Undefined => Js::Undefined,
                    Js::Null => Js::Null,
                    given => p.records(child, &record_list(child, given)),
                },
            });
            if raw.is_some() || !matches!(parsed, Js::Undefined) {
                out.set(key.clone(), parsed);
            }
        }
        for (key, value) in object.entries() {
            if !declared_names.contains(key) {
                out.assign(key.clone(), value.clone());
            }
        }
        // The refinement runs on an entity whose own parse raised nothing,
        // as zod runs a check.
        if self.issues.len() == before && !declared.is_empty() {
            let keys: Vec<String> = out.entries().iter().map(|(k, _)| k.clone()).collect();
            if !keys.is_empty() && !keys.iter().any(|k| declared_names.contains(k)) {
                self.issue(format!(
                    "this entity was answered under {} — none of which it declares. Its fields are {}; answer under those names.",
                    quote_keys(&keys),
                    quote_keys(&declared_names)
                ));
            }
        }
        Js::object(out)
    }

    /// `wrapFieldEvidence`: absent, null, or `{ evidence, value }`, its
    /// evidence normalised first.
    fn field(&mut self, type_: Option<&FieldType>, raw: &Js, ctx: &str) -> Js {
        let raw = self.normalised_evidence(raw, ctx);
        let Js::Object(object) = &raw else {
            if raw.is_nullish() {
                return raw;
            }
            self.expected("object", &raw);
            return Js::Undefined;
        };
        let mut out = JsObject::new();
        let evidence = object.get("evidence").cloned();
        let checked = self.at(PathKey::Key("evidence".into()), |p| match evidence.clone().unwrap_or(Js::Undefined) {
            ok @ (Js::String(_) | Js::Null) => ok,
            other => {
                p.expected("string", &other);
                Js::Undefined
            }
        });
        if evidence.is_some() || !matches!(checked, Js::Undefined) {
            out.set("evidence".into(), checked);
        }
        let value = object.get("value").cloned();
        let parsed = self.at(PathKey::Key("value".into()), |p| p.value(type_, value.as_ref().unwrap_or(&Js::Undefined), ctx));
        if value.is_some() || !matches!(parsed, Js::Undefined) {
            out.set("value".into(), parsed);
        }
        Js::object(out)
    }

    /// `normaliseFieldEvidence`: on an object carrying `value`, a missing
    /// citation is null and one that is not text is its quote, or null.
    fn normalised_evidence(&mut self, raw: &Js, ctx: &str) -> Js {
        let Js::Object(object) = raw else { return raw.clone() };
        if object.get("value").is_none() {
            return raw.clone();
        }
        let replaced = match object.get("evidence") {
            Some(Js::String(_) | Js::Null) => return raw.clone(),
            None => Js::Null,
            Some(evidence) => {
                push(&mut self.coercions.evidence, ctx, js::json_stringify(evidence, 0));
                salvaged_quote(evidence).map_or(Js::Null, Js::str)
            }
        };
        let mut copy = JsObject::clone_of(object);
        copy.set("evidence".into(), replaced);
        Js::object(copy)
    }

    /// `zodForFieldType`.
    fn value(&mut self, type_: Option<&FieldType>, value: &Js, ctx: &str) -> Js {
        let Some(type_) = type_ else { return value.clone() };
        match type_ {
            FieldType::Scalar(Scalar::Text | Scalar::Date | Scalar::Datetime | Scalar::File) => self.nullable(value, "string", |v| matches!(v, Js::String(_))),
            FieldType::Scalar(Scalar::Number) => self.nullable(value, "number", |v| matches!(v, Js::Number(n) if n.is_finite())),
            FieldType::Scalar(Scalar::Boolean) => self.nullable(value, "boolean", |v| matches!(v, Js::Bool(_))),
            FieldType::Scalar(Scalar::Json) => value.clone(),
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
                if matches!(value, Js::String(s) if js::trim(s).is_empty()) {
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
            if matches!(item, Js::String(s) if js::trim(s).is_empty()) {
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
    let trimmed = js::trim(candidate);
    if let Some(exact) = options.iter().find(|o| *o == trimmed) {
        return Some(exact.clone());
    }
    let lowered = js::to_lower_case(trimmed);
    options.iter().find(|o| js::to_lower_case(o) == lowered).cloned()
}

/// `salvagedQuote`: the quote in a citation that is not text — under
/// `quote`, `text` or `evidence`, or the one string anywhere in it.
fn salvaged_quote(evidence: &Js) -> Option<String> {
    if let Js::String(s) = evidence {
        return Some(s.to_string());
    }
    if let Js::Object(object) = evidence {
        for key in ["quote", "text", "evidence"] {
            if let Some(Js::String(named)) = object.get(key)
                && !js::trim(named).is_empty()
            {
                return Some(named.to_string());
            }
        }
    }
    let mut found = Vec::new();
    string_leaves(evidence, EVIDENCE_SALVAGE_DEPTH, &mut found);
    if found.len() == 1 { found.pop() } else { None }
}

const EVIDENCE_SALVAGE_DEPTH: usize = 4;

fn string_leaves(value: &Js, depth: usize, into: &mut Vec<String>) {
    if into.len() > 1 {
        return;
    }
    match value {
        Js::String(s) => {
            if !js::trim(s).is_empty() {
                into.push(s.to_string());
            }
        }
        _ if depth == 0 => {}
        Js::Array(list) => list.items().iter().for_each(|item| string_leaves(item, depth - 1, into)),
        Js::Object(object) => object.entries().iter().for_each(|(_, item)| string_leaves(item, depth - 1, into)),
        _ => {}
    }
}

/// `pushCoercion`: past 80 UTF-16 units a rendering is cut and marked.
fn push(into: &mut Vec<(String, Vec<String>)>, key: &str, rendered: String) {
    let rendered = if js::utf16_len(&rendered) > 80 { crate::extract::emission::cut(&rendered, 80) } else { rendered };
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

    /// zod reads `constructor` through the prototype and fails the reply
    /// that leaves it out (README, row 5); a `__proto__` the reply writes
    /// becomes the record's prototype, and a declared one is no key.
    #[test]
    fn a_field_named_after_a_prototype_member_reads_through_the_prototype() {
        let spec = node(&["constructor", "name"]);
        let region = Region::plan(&spec, 0, true, &mut || 1);
        let issues = read_reply(&region, &reply(r#"{"x:n#1": [{"name": {"evidence": "e", "value": "Acme"}}]}"#)).expect_err("a function is no field");
        assert_eq!(issue_lines(&issues), ["  - x:n#1.0.constructor: Invalid input: expected object, received function"]);
        let spec = node(&["__proto__", "name"]);
        let region = Region::plan(&spec, 0, true, &mut || 1);
        let read = read_reply(&region, &reply(r#"{"x:n#1": [{"__proto__": {"evidence": 5, "value": "x"}}]}"#)).expect("a declared `__proto__` is never checked");
        let Js::Object(answer) = &read.value else { panic!("an object") };
        let Some(Js::Array(records)) = answer.get("x:n#1") else { panic!("a list") };
        let Js::Object(record) = &records.items()[0] else { panic!("a record") };
        assert!(record.entries().is_empty());
        assert!(matches!(&record.proto, Some(Js::Object(proto)) if proto.get("value").is_some()));
    }

    /// A number past the double range crosses the eval wire as the
    /// `Infinity` `JSON.parse` made of it, and is refused as zod refuses it
    /// (README, "Transition artefacts to mirror"); over a JSON host it is already `null`,
    /// which reads clean on both engines.
    #[test]
    fn a_number_past_the_double_range_is_refused_as_zod_refuses_it() {
        let spec = NodeSpec {
            name: "n".into(),
            description: String::new(),
            stages: vec![StageSpec {
                through: Vec::new(),
                fields: vec![FieldSpec { name: "amount".into(), description: String::new(), type_: Some(FieldType::Scalar(Scalar::Number)), nullable: false }],
                children: Vec::new(),
            }],
            exported: Vec::new(),
        };
        let region = Region::plan(&spec, 0, true, &mut || 1);
        let wired = |value: serde_json::Value| {
            crate::env::decode(&serde_json::json!(["o", 0, [["x:n#1", ["l", 1, [["o", 2, [["amount", ["o", 3, [["evidence", "e"], ["value", value]]]]]]]]]]])).unwrap()
        };
        let Err(issues) = read_reply(&region, &wired(serde_json::json!(["n", "Infinity"]))) else { panic!("Infinity is not a number zod reads") };
        assert_eq!(issue_lines(&issues), ["  - x:n#1.0.amount.value: Invalid input: expected number, received number"]);
        assert!(read_reply(&region, &wired(serde_json::Value::Null)).is_ok(), "null reads clean");
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

    #[test]
    fn the_retry_shows_the_envelope_only_for_a_packaging_complaint() {
        let spec = node(&["name"]);
        let region = Region::plan(&spec, 0, true, &mut || 7);
        let Err(issues) = read_reply(&region, &reply(r#"{"x:n#7": [{"name": 5}]}"#)) else { panic!("a bare value is not a field") };
        assert_eq!(issue_lines(&issues), ["  - x:n#7.0.name: Invalid input: expected object, received number"]);
        assert_eq!(retry_instruction(&region, &issues), "Please fix ONLY the invalid values and return the complete corrected JSON.");
        let Err(issues) = read_reply(&region, &reply("{}")) else { panic!("the answer key is required") };
        assert!(retry_instruction(&region, &issues).ends_with(r#"{"x:n#7": [ { "name": {"evidence": string|null, "value": …} } ] }"#));
    }
}
