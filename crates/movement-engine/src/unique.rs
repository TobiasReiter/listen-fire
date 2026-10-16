//! Identity: what a write searches by and how a search's candidates are
//! decided — run.ts's `uniqueByIdentity` / `identityRecord`, movement-lang's
//! `splitUniquenessConjuncts` / `identityKeyOf` (expression/bridge.ts), and
//! translation_graph/uniqueness.ts's `arbitrateWithoutJudge`. The judge
//! itself is a host call (`llm.arbitrateEntities`); everything the rules
//! decide without one is decided here.
//!
//! Constraints stay JavaScript values (`{any: [{all: [{field, fuzzy?}]}]}`):
//! the adapter receives the very objects its own `describe` handed out,
//! merged with the ones the program wrote.

use movement_parser::lowering::expression::{Expression, LogicalOp};

use crate::filter::is_null_literal;
use crate::js::{self, Js, JsObject};

/// One top-level component of a `unique by (…)` predicate, its FUZZY
/// modifier lifted off (`UniquenessConjunct`).
#[derive(Debug, Clone, PartialEq)]
pub struct Conjunct {
    pub raw: String,
    pub fuzzy: bool,
}

/// `splitUniquenessConjuncts`: the predicate split on its top-level commas
/// (strings, backticks and brackets blanked first), each part's leading
/// `FUZZY` lifted. Positions are UTF-16 units, as the TypeScript's are.
pub fn split_conjuncts(raw: &str) -> Vec<Conjunct> {
    let units: Vec<u16> = crate::js_string::units_vec(raw);
    let blanked = blank_literals(&units);
    let mut depth: i64 = 0;
    let mut spans = Vec::new();
    let mut start = 0;
    for (i, &unit) in blanked.iter().enumerate() {
        let at = match unit {
            u if u == u16::from(b'(') || u == u16::from(b'[') || u == u16::from(b'{') => {
                let at = depth;
                depth += 1;
                at
            }
            u if u == u16::from(b')') || u == u16::from(b']') || u == u16::from(b'}') => {
                depth -= 1;
                depth
            }
            _ => depth,
        };
        if unit == u16::from(b',') && at == 0 {
            spans.push((start, i));
            start = i + 1;
        }
    }
    spans.push((start, units.len()));
    spans
        .into_iter()
        .map(|(from, to)| {
            let text = crate::js_string::text_of_units(&units[from..to]);
            match strip_fuzzy(&text) {
                Some(rest) => Conjunct { raw: js::trim(rest).to_string(), fuzzy: true },
                None => Conjunct { raw: js::trim(&text).to_string(), fuzzy: false },
            }
        })
        .collect()
}

/// `/^\s*FUZZY\b\s*/`: the text after the modifier, when it leads.
fn strip_fuzzy(text: &str) -> Option<&str> {
    let rest = text.trim_start_matches(char::is_whitespace);
    let after = rest.strip_prefix("FUZZY")?;
    // `\b`: the next character is not a word character.
    if after.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    Some(after.trim_start_matches(char::is_whitespace))
}

/// A same-length copy with every string and backtick literal blanked
/// (`blankLiterals`); an unterminated one blanks to the end.
fn blank_literals(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        let ch = units[i];
        if ch == u16::from(b'"') || ch == u16::from(b'\'') || ch == u16::from(b'`') {
            let end = if ch == u16::from(b'`') { skip_backtick(units, i) } else { skip_string(units, i) };
            out.extend(std::iter::repeat_n(u16::from(b' '), end - i));
            i = end;
            continue;
        }
        out.push(ch);
        i += 1;
    }
    out
}

fn skip_backtick(units: &[u16], start: usize) -> usize {
    let mut i = start + 1;
    while i < units.len() {
        if units[i] == u16::from(b'\\') && i + 1 < units.len() {
            i += 2;
            continue;
        }
        if units[i] == u16::from(b'`') {
            return i + 1;
        }
        i += 1;
    }
    units.len()
}

fn skip_string(units: &[u16], start: usize) -> usize {
    let quote = units[start];
    let mut i = start + 1;
    while i < units.len() {
        let ch = units[i];
        if ch == u16::from(b'\\') && i + 1 < units.len() {
            i += 2;
            continue;
        }
        if quote == u16::from(b'"') && ch == u16::from(b'$') && units.get(i + 1) == Some(&u16::from(b'{')) {
            i = skip_interpolation(units, i + 2);
            continue;
        }
        if ch == quote {
            return i + 1;
        }
        i += 1;
    }
    units.len()
}

fn skip_interpolation(units: &[u16], start: usize) -> usize {
    let mut depth = 1;
    let mut i = start;
    while i < units.len() {
        let ch = units[i];
        if ch == u16::from(b'"') || ch == u16::from(b'\'') {
            i = skip_string(units, i);
            continue;
        }
        if ch == u16::from(b'`') {
            i = skip_backtick(units, i);
            continue;
        }
        if ch == u16::from(b'{') {
            depth += 1;
        } else if ch == u16::from(b'}') {
            depth -= 1;
            if depth == 0 {
                return i + 1;
            }
        }
        i += 1;
    }
    units.len()
}

/// `flattenAndConjuncts`: the top-level AND-ed conjuncts.
pub fn and_conjuncts(expr: &Expression) -> Vec<&Expression> {
    match expr {
        Expression::Logical { op: LogicalOp::And, operands } => operands.iter().flat_map(and_conjuncts).collect(),
        other => vec![other],
    }
}

/// What a conjunct contributes to the key (`identityKeyOf`): a bare name, or
/// `field == value`. `None` for any other conjunct, which narrows instead.
pub enum Key<'e> {
    Bare(String),
    Compared { name: String, with: &'e Expression },
}

pub fn identity_key(conjunct: &Expression) -> Option<Key<'_>> {
    match conjunct {
        Expression::Property { property_type_id, .. } | Expression::EdgeProperty { property_type_id, .. } => {
            Some(Key::Bare(property_type_id.clone()))
        }
        Expression::AliasRef { name } => Some(Key::Bare(name.clone())),
        Expression::Compare { op, left, right } if *op == movement_parser::lowering::expression::FilterOperator::Eq => {
            match left.as_ref() {
                Expression::Property { property_type_id, .. } | Expression::EdgeProperty { property_type_id, .. } => {
                    Some(Key::Compared { name: property_type_id.clone(), with: right })
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// `is_null_literal`'s cousin: whether a key's comparand is a literal, whose
/// value rides the search record (`valueOverlay`).
pub fn static_of(expr: &Expression) -> Option<Js> {
    match expr {
        Expression::Static { value } => Some(crate::eval::static_value(value)),
        _ if is_null_literal(expr) => Some(Js::Null),
        _ => None,
    }
}

// ── Reading constraints (`{any: [{all: [{field, fuzzy?}]}]}`) ──

/// The branches of a constraints value.
pub fn branches(constraints: &Js) -> Vec<Js> {
    match get(constraints, "any") {
        Js::Array(list) => list.items().clone(),
        _ => Vec::new(),
    }
}

/// One branch's entries.
pub fn entries(branch: &Js) -> Vec<Js> {
    match get(branch, "all") {
        Js::Array(list) => list.items().clone(),
        _ => Vec::new(),
    }
}

/// An entry's field, as `record[entry.field]` reads it.
pub fn field_of(entry: &Js) -> String {
    get(entry, "field").to_js_string()
}

pub fn is_fuzzy(entry: &Js) -> bool {
    matches!(get(entry, "fuzzy"), Js::Bool(true))
}

pub fn get(value: &Js, key: &str) -> Js {
    match value {
        Js::Object(object) => object.get(key).cloned().unwrap_or(Js::Undefined),
        Js::File(file) => file.display.get(key).cloned().unwrap_or(Js::Undefined),
        _ => Js::Undefined,
    }
}

/// `mergeUniqueness(a, b)`: `{any: [...a.any, ...b.any]}`.
pub fn merge(native: &Js, authored: Vec<Js>) -> Js {
    let mut any = branches(native);
    any.extend(authored);
    let mut object = JsObject::new();
    object.set("any".into(), Js::array(any));
    Js::object(object)
}

/// `{all: [{field, fuzzy?: true}…]}`.
pub fn branch(entries: Vec<(String, bool)>) -> Js {
    let all = entries
        .into_iter()
        .map(|(field, fuzzy)| {
            let mut entry = JsObject::new();
            entry.set("field".into(), Js::str(field));
            if fuzzy {
                entry.set("fuzzy".into(), Js::Bool(true));
            }
            Js::object(entry)
        })
        .collect();
    let mut object = JsObject::new();
    object.set("all".into(), Js::array(all));
    Js::object(object)
}

/// `isBlankIdentityValue`: absent, or text with nothing in it.
pub fn is_blank(value: &Js) -> bool {
    match value {
        Js::Undefined | Js::Null => true,
        Js::String(text) => js::trim(text.as_form()).is_empty(),
        _ => false,
    }
}

/// `fieldValuesMatch`: case-insensitive equality, a multi-value candidate
/// matching when the asserted scalar is among its values.
fn values_match(asserted: &Js, candidate: &Js) -> bool {
    if is_blank(asserted) || is_blank(candidate) {
        return false;
    }
    let target = js::to_lower_case(&asserted.to_js_string());
    let pool = match candidate {
        Js::Array(list) => list.items().clone(),
        other => vec![other.clone()],
    };
    pool.iter().any(|v| !v.is_nullish() && js::to_lower_case(&v.to_js_string()) == target)
}

/// `candidateIsAllExact`.
fn all_exact(constraints: &Js, asserted: &Js, data: &Js) -> bool {
    branches(constraints).iter().any(|branch| {
        let all = entries(branch);
        !all.is_empty()
            && all.iter().all(|entry| {
                let field = field_of(entry);
                values_match(&get(asserted, &field), &get(data, &field))
            })
    })
}

/// `constraintsHaveFuzzyEntry`.
pub fn has_fuzzy(constraints: &Js) -> bool {
    branches(constraints).iter().any(|branch| entries(branch).iter().any(is_fuzzy))
}

/// What the rules decide with no judge (`arbitrateWithoutJudge`): `Some(None)`
/// no match, `Some(Some(i))` candidate `i`, `None` only a judge can say.
pub fn arbitrate_without_judge(asserted: &Js, candidates: &[Js], constraints: &Js) -> Option<Option<usize>> {
    if candidates.is_empty() {
        return Some(None);
    }
    let exact: Vec<usize> = candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| all_exact(constraints, asserted, &get(c, "data")))
        .map(|(i, _)| i)
        .collect();
    if exact.len() == 1 {
        return Some(Some(exact[0]));
    }
    if candidates.len() == 1 && !has_fuzzy(constraints) {
        return Some(Some(0));
    }
    None
}

/// The locks an identity write takes (effect_locks.ts `identityLocks`): a
/// lock per key it searches by — (system, record type, which fields, their
/// values), taken by this run only — plus a lock over its record type shared
/// with every write searching by the same set of keys; a fuzzy key, or a key
/// value with no exact text, holds the record type alone, exclusively.
pub(crate) fn identity_lock_requests(adapter_type: &str, record_type: &str, constraints: &Js, record: &Js, fields: &Js) -> Vec<crate::flow::LockRequest> {
    use crate::flow::{LockMode, LockRequest};
    let any = branches(constraints);
    if any.is_empty() {
        return Vec::new();
    }
    let type_lock = format!("identity {} {}", js::json_quote(adapter_type), js::json_quote(record_type));
    let whole_type = vec![LockRequest::exclusive(type_lock.clone())];
    if has_fuzzy(constraints) {
        return whole_type;
    }
    // Each branch's fields, distinct and sorted (`[...new Set(…)].sort()`).
    let branch_fields: Vec<Vec<String>> = any
        .iter()
        .map(|branch| {
            let mut fields_of: Vec<String> = Vec::new();
            for entry in entries(branch) {
                let field = field_of(&entry);
                if !fields_of.contains(&field) {
                    fields_of.push(field);
                }
            }
            fields_of.sort();
            fields_of
        })
        .collect();
    let mut keys: Vec<LockRequest> = Vec::new();
    for fields_of in &branch_fields {
        let mut value_sets: Vec<Vec<String>> = Vec::new();
        let mut searchable = true;
        for field in fields_of {
            let mut values: Vec<String> = Vec::new();
            for raw in [get(record, field), get(fields, field)] {
                if is_blank(&raw) {
                    continue;
                }
                let Some(folded) = fold_key_value(&raw) else { return whole_type };
                if !values.contains(&folded) {
                    values.push(folded);
                }
            }
            if values.is_empty() {
                searchable = false;
            }
            value_sets.push(values);
        }
        if !searchable {
            continue;
        }
        let signature = js::json_quote(&fields_of.join(","));
        for combination in cartesian(&value_sets) {
            let stable = format!("[{}]", combination.iter().map(|v| js::json_quote(v)).collect::<Vec<_>>().join(","));
            keys.push(LockRequest {
                name: format!("key {} {} {signature} {stable}", js::json_quote(adapter_type), js::json_quote(record_type)),
                mode: LockMode::Exclusive,
                in_run_only: true,
            });
        }
    }
    if keys.is_empty() {
        return Vec::new();
    }
    let mut groups: Vec<String> = branch_fields.iter().map(|fields_of| fields_of.join(",")).collect();
    groups.sort();
    groups.dedup();
    let mut requests = vec![LockRequest { name: type_lock, mode: LockMode::Shared(groups.join(" | ")), in_run_only: false }];
    requests.extend(keys);
    requests
}

/// The cross-run names an identity write takes (`identityLocks` through
/// `crossRunNames`): its record type's lock, or nothing.
pub fn identity_lock_names(adapter_type: &str, record_type: &str, constraints: &Js, record: &Js, fields: &Js) -> Vec<String> {
    crate::flow::cross_run_names(&identity_lock_requests(adapter_type, record_type, constraints, record, fields))
}

/// `cartesian`: every combination, one value from each set, in order.
fn cartesian(sets: &[Vec<String>]) -> Vec<Vec<String>> {
    sets.iter().fold(vec![Vec::new()], |combinations, values| {
        combinations.iter().flat_map(|prefix| values.iter().map(move |value| [prefix.clone(), vec![value.clone()]].concat())).collect()
    })
}

/// `foldKeyValue`: a key value folded so that any two values a system could
/// consider the same fold to the same text; `None` for a value with no
/// exact text (a list, a structured value).
fn fold_key_value(value: &Js) -> Option<String> {
    match value {
        Js::Number(_) | Js::Bool(_) => Some(value.to_js_string()),
        Js::String(text) => Some(fold_text(text.as_form())),
        // A parent folded in under its edge's name: a record id, exactly.
        Js::Object(object) if object.entries().len() == 1 => match object.get("id") {
            Some(Js::String(id)) => Some(format!("@{id}")),
            _ => None,
        },
        _ => None,
    }
}

/// `foldText`: case and accents gone, a URL's scheme, `www.` and path gone,
/// then everything but letters and digits gone.
fn fold_text(text: &str) -> String {
    let decomposed = crate::env_services::current().normalize(text, crate::env_services::NormalForm::Nfkd);
    let unmarked: String = decomposed.chars().filter(|c| !crate::marks::is_mark(*c)).collect();
    let mut folded = js::to_lower_case(js::trim(&unmarked));
    let scheme_end = scheme_length(&folded);
    if let Some(end) = scheme_end {
        folded = folded[end..].to_string();
    }
    if scheme_end.is_some() || host_then_path(&folded) {
        folded = folded.split(['/', '?', '#']).next().unwrap_or("").to_string();
    }
    if let Some(rest) = folded.strip_prefix("www.") {
        folded = rest.to_string();
    }
    folded.chars().filter(|c| c.is_alphanumeric()).collect()
}

/// `/^[a-z][a-z0-9+.-]*:\/\//`'s length, when it matches.
fn scheme_length(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    if !bytes.first().is_some_and(u8::is_ascii_lowercase) {
        return None;
    }
    let mut end = 1;
    while end < bytes.len() && (bytes[end].is_ascii_lowercase() || bytes[end].is_ascii_digit() || matches!(bytes[end], b'+' | b'.' | b'-')) {
        end += 1;
    }
    text[end..].starts_with("://").then_some(end + 3)
}

/// `/^[^\s/@]+\.[^\s/@]+\//`: a host with a dot inside it, then a path.
fn host_then_path(text: &str) -> bool {
    let outside = |c: char| c.is_whitespace() || c == '/' || c == '@';
    let head: String = text.chars().take_while(|c| !outside(*c)).collect();
    let rest = &text[head.len()..];
    let dotted = head.char_indices().any(|(i, c)| c == '.' && i > 0 && i + c.len_utf8() < head.len());
    dotted && rest.starts_with('/')
}

/// `recordLock`'s name.
pub fn record_lock_name(adapter_type: &str, external_id: &Js) -> String {
    format!("record {} {}", js::json_quote(adapter_type), lock_part(external_id))
}

/// effect_locks.ts `part`: `JSON.stringify` of the value as the adapter
/// answered it — a numeric id is `42`, not `"42"` — and, inside the
/// template literal, `undefined` for an absent one.
pub fn lock_part(value: &Js) -> String {
    match value {
        Js::Undefined => "undefined".into(),
        other => js::json_stringify(other, 0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raws(text: &str) -> Vec<(String, bool)> {
        split_conjuncts(text).into_iter().map(|c| (c.raw, c.fuzzy)).collect()
    }

    #[test]
    fn a_predicate_splits_on_top_level_commas_and_lifts_fuzzy() {
        assert_eq!(raws("`name`"), [("`name`".into(), false)]);
        assert_eq!(raws("FUZZY `name`, `domain`"), [("`name`".into(), true), ("`domain`".into(), false)]);
        assert_eq!(raws("`a` == \"x, y\", WITHIN(7, days)"), [("`a` == \"x, y\"".into(), false), ("WITHIN(7, days)".into(), false)]);
        assert_eq!(raws("FUZZYish"), [("FUZZYish".into(), false)]);
        assert_eq!(raws("`a,b`"), [("`a,b`".into(), false)]);
    }

    fn object(entries: &[(&str, Js)]) -> Js {
        let mut o = JsObject::new();
        for (k, v) in entries {
            o.set((*k).into(), v.clone());
        }
        Js::object(o)
    }

    #[test]
    fn the_rules_decide_what_needs_no_judge() {
        let constraints = merge(&Js::Undefined, vec![branch(vec![("name".into(), false)])]);
        let asserted = object(&[("name", Js::str("Acme"))]);
        let candidate = |name: &str| object(&[("data", object(&[("name", Js::str(name))]))]);
        assert_eq!(arbitrate_without_judge(&asserted, &[], &constraints), Some(None));
        assert_eq!(arbitrate_without_judge(&asserted, &[candidate("ACME")], &constraints), Some(Some(0)));
        assert_eq!(arbitrate_without_judge(&asserted, &[candidate("x"), candidate("acme")], &constraints), Some(Some(1)));
        assert_eq!(arbitrate_without_judge(&asserted, &[candidate("x"), candidate("y")], &constraints), None);
        let fuzzy = merge(&Js::Undefined, vec![branch(vec![("name".into(), true)])]);
        assert_eq!(arbitrate_without_judge(&asserted, &[candidate("Acme Inc")], &fuzzy), None);
    }

    #[test]
    fn an_identity_write_locks_its_type_only_when_it_can_search() {
        let constraints = merge(&Js::Undefined, vec![branch(vec![("name".into(), false)])]);
        let named = object(&[("name", Js::str("Acme"))]);
        let blank = object(&[("name", Js::str("  "))]);
        assert_eq!(identity_lock_names("attio", "company", &constraints, &named, &named), [r#"identity "attio" "company""#]);
        // A record's lock names its id as the adapter answered it.
        assert_eq!(record_lock_name("attio", &Js::Number(42.0)), r#"record "attio" 42"#);
        assert_eq!(record_lock_name("attio", &Js::str("42")), r#"record "attio" "42""#);
        assert!(identity_lock_names("attio", "company", &constraints, &blank, &blank).is_empty());
        assert!(identity_lock_names("attio", "company", &merge(&Js::Undefined, vec![]), &named, &named).is_empty());
        let listed = object(&[("name", Js::array(vec![Js::str("a")]))]);
        assert_eq!(identity_lock_names("attio", "company", &constraints, &listed, &listed).len(), 1);
    }
}
