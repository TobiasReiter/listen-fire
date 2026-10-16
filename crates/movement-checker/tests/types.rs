//! The type core against the TypeScript's answers. The expected values were
//! read off packages/movement-lang/checker/typing.ts run on the same inputs
//! (2026-10-15), except where a test says it pins a reading of the source.

use std::collections::HashMap;
use std::rc::Rc;

use movement_checker::types::field::*;
use movement_checker::types::infer::{EmptyEnv, TypeEnv, Typing};
use movement_checker::types::narrowing::{PresenceProof, negative_presence_proofs, presence_proofs};
use movement_checker::types::position::*;
use movement_checker::slots::expression_of_text;
use movement_parser::ast::{Loc, Span};
use movement_parser::catalog::types::InstanceSchema;

fn en(options: &[&str]) -> Ty {
    Ty::Enum { options: options.iter().map(|o| o.to_string()).collect(), open: None }
}

fn tuple(of: Vec<Ty>) -> Ty {
    Ty::Tuple { of: Rc::new(of.into_iter().map(Some).collect()), rest: None }
}

#[test]
fn a_union_is_canonical() {
    let union = value_union(&[Ty::Number, Ty::Text, en(&["a", "b"]), Ty::Absent]).unwrap();
    assert_eq!(describe_field_type(&union), "(number | text) (or absent)");
    let absorbed = value_union(&[Ty::Json, Ty::Number, Ty::list(Ty::Text)]).unwrap();
    assert_eq!(describe_field_type(&absorbed), "json");
    assert!(value_union(&[Ty::Record(None), Ty::Text]).is_none(), "records and values have no union");
    assert_eq!(describe_field_type(&value_union(&[Ty::Absent]).unwrap()), "null");
}

#[test]
fn a_tuple_widens_by_version() {
    let pair = tuple(vec![Ty::Text, Ty::Number]);
    assert_eq!(describe_field_type(&widen_tuples(Some(pair.clone()), 3).unwrap()), "list of (number | text)");
    assert!(widen_tuples(Some(pair), 2).is_none(), "before version 3 a disagreeing tuple widens to nothing");
    assert_eq!(describe_field_type(&collection_element_of(&tuple(vec![Ty::Text, Ty::Text])).unwrap()), "text");
}

#[test]
fn spelling() {
    let run = Ty::Tuple {
        of: Rc::new(vec![Some(Ty::Text), Some(Ty::Number)]),
        rest: Some(TupleRest { at: 1, of: Some(Rc::new(Ty::Union(Rc::new(vec![Ty::Date, Ty::Number])))) }),
    };
    assert_eq!(describe_field_type(&run), "[text, ...list of (date | number), number]");
    let dict = Ty::Dict { of: Rc::new(Ty::Json), shape: Some(Rc::new([("a".to_string(), Some(Ty::Text)), ("b".to_string(), None)].into_iter().collect())) };
    assert_eq!(describe_field_type(&dict), "{ a: text, b: ? }");
    assert_eq!(describe_field_type(&en(&[])), "enum (no available values)");
    assert_eq!(describe_field_type(&maybe_absent(Ty::list(Ty::Text))), "list of text (or absent)");
}

#[test]
fn fit() {
    assert!(field_assignable(&en(&["a", "b"]), &Ty::Text));
    assert!(!field_assignable(&Ty::Text, &en(&["a", "b"])));
    assert!(field_assignable(&Ty::list(Ty::Number), &Ty::Json));
    assert!(!field_assignable(&Ty::File, &Ty::Json), "a file is a handle, not data");
    assert!(field_assignable(&Ty::Date, &Ty::Datetime));
    assert!(field_assignable(&tuple(vec![Ty::Text, Ty::Number]), &Ty::list(Ty::Text)), "a tuple that widens to nothing is not refused");
    assert!(!field_assignable(&Ty::Union(Rc::new(vec![Ty::Number, Ty::Text])), &Ty::Text));
    assert!(field_type_compatible(&Ty::Number, &Ty::Text));
    assert!(field_type_compatible(&Ty::Text, &Ty::Date));
    assert!(!field_type_compatible(&Ty::Date, &Ty::Number));
    assert_eq!(comparison_category(&Ty::Union(Rc::new(vec![Ty::Date, Ty::Datetime]))), ComparisonCategory::Temporal);
}

#[test]
fn a_mixed_tuple_is_named() {
    let message = mixed_tuple_message(Some(&tuple(vec![Ty::Record(None), Ty::Text]))).unwrap();
    assert!(message.starts_with("a list holds one kind of thing, and this one holds both: a record is a record, and another member is text."));
}

/// Pins coalesceType as read from typing.ts.
#[test]
fn coalesce_discharges_absence_by_its_present_argument() {
    let maybe_text = maybe_absent(Ty::Text);
    assert_eq!(describe_field_type(&coalesce_type(&[Some(maybe_text.clone()), Some(Ty::Text)]).unwrap()), "text");
    assert_eq!(describe_field_type(&coalesce_type(&[Some(maybe_text.clone()), Some(Ty::Absent)]).unwrap()), "text (or absent)");
    assert!(coalesce_type(&[Some(maybe_text), None]).is_none(), "an untyped argument leaves the result unknown");
    assert!(coalesce_type(&[Some(Ty::Text), Some(Ty::Number)]).is_none(), "no shared kind");
    assert!(matches!(coalesce_type(&[Some(Ty::Absent)]), Some(Ty::Absent)));
}

fn crm() -> InstanceRef {
    let schema: InstanceSchema = serde_json::from_value(serde_json::json!({
        "positions": {
            "Company": {
                "properties": { "Name": "text", "Size": { "kind": "maybeAbsent", "of": "number" } },
                "edges": { "people": { "target": "Person" }, "notes": { "target": "Note", "readable": false } },
                "displayName": "company"
            },
            "Person": { "properties": { "Name": "text", "Email": "text" }, "edges": {} },
            "Lead": { "properties": { "Name": "text" }, "edges": { "people": { "target": "Person" } } }
        },
        "collections": { "companies": { "target": "Company" } },
        "unions": { "Party": ["Company", "Lead"] },
        "writableRoots": {}
    }))
    .unwrap();
    Rc::new(Instance { name: "crm".to_string(), schema: Rc::new(schema), declared: None, address: None })
}

#[test]
fn positions_and_their_reads() {
    let crm = crm();
    let meta = Position::Meta { instance: crm.clone() };
    let EdgeLanding::Landed { landing: company, .. } = edge_landing(&meta, "companies", 5) else { panic!("a collection lands") };
    assert_eq!(describe_position(&company), "crm.company");
    assert!(matches!(edge_landing(&meta, "nope", 5), EdgeLanding::Unknown { available } if available == vec!["companies".to_string()]));
    assert!(matches!(edge_landing(&company, "notes", 5), EdgeLanding::Untyped { .. }), "a write-only edge reads nothing");
    let party = position_ref_in(&crm, "Party").unwrap();
    assert!(matches!(edge_landing(&party, "people", 5), EdgeLanding::Landed { .. }), "every variant carries it, to one target");
    assert_eq!(describe_field_type(&lookup_property_type(Some(&party), "Name").unwrap()), "text");
    assert!(lookup_property_type(Some(&party), "Size").is_none(), "not every variant has it");
    let size = lookup_property_type(Some(&company), "Size").unwrap();
    assert!(is_maybe_absent(Some(&size)));
    let narrowed = narrow_present(&company, "Size").unwrap();
    assert!(!is_maybe_absent(lookup_property_type(Some(&narrowed), "Size").as_ref()));
    assert!(narrow_present(&narrowed, "Size").is_none(), "already present");
    let empty = Position::MaybeEmpty(Box::new(company.clone()));
    assert!(is_maybe_absent(lookup_property_type(Some(&empty), "Name").as_ref()));
}

#[test]
fn positions_match_by_instance_and_variant() {
    let other = crm();
    let crm = crm();
    let company = position_ref_in(&crm, "Company").unwrap();
    let party = position_ref_in(&crm, "Party").unwrap();
    assert_eq!(positions_match(&company, &party), Some(true), "a variant fits its union");
    assert_eq!(positions_match(&party, &company), Some(false));
    assert_eq!(positions_match(&company, &position_ref_in(&other, "Company").unwrap()), Some(false), "another instance");
    assert!(field_type_equals(&Ty::record(Some(company.clone())), &Ty::record(Some(position_ref_in(&crm, "Company").unwrap()))));
}

fn closure(params: Vec<PlaneType>, returns: Option<PlaneType>) -> Ty {
    let params = params.into_iter().enumerate().map(|(i, plane)| ClosureParam { name: format!("p{i}"), plane }).collect();
    let returns = match returns {
        Some(plane) => ReturnShape { returns: true, plane, may_hold: None },
        None => ReturnShape::default(),
    };
    Ty::record(Some(Position::Closure(ClosureType::new("a closure", params, returns, None))))
}

fn field(ty: Ty) -> PlaneType {
    PlaneType { field: Some(ty), pos: None }
}

#[test]
fn closures_fit_contravariantly() {
    let takes_text = closure(vec![field(Ty::Text)], Some(field(Ty::Number)));
    let takes_enum = closure(vec![field(en(&["a"]))], Some(field(Ty::Number)));
    // A function of any text may stand where a function of an enum is asked for, not the reverse.
    assert!(field_assignable(&takes_text, &takes_enum));
    assert!(!field_assignable(&takes_enum, &takes_text));
    let returns_enum = closure(vec![field(Ty::Text)], Some(field(en(&["a"]))));
    let returns_text = closure(vec![field(Ty::Text)], Some(field(Ty::Text)));
    assert!(field_assignable(&returns_enum, &returns_text), "the return is covariant");
    assert!(!field_assignable(&returns_text, &returns_enum));
    let fewer = closure(vec![], Some(field(Ty::Number)));
    assert!(field_assignable(&fewer, &takes_text), "a closure may ignore parameters");
    assert!(!field_assignable(&takes_text, &fewer));
    let nothing = closure(vec![field(Ty::Text)], None);
    assert!(field_assignable(&takes_text, &nothing), "a target that returns nothing takes any return");
    assert!(!field_assignable(&nothing, &takes_text));
    assert_eq!(describe_field_type(&takes_text), "a closure returning number");
    assert!(field_assignable(&Ty::list(takes_text.clone()), &Ty::list(takes_enum)));
}

#[test]
fn handles_inside_values() {
    let held = handle_within(Some(&Ty::Dict { of: Rc::new(Ty::Text), shape: Some(Rc::new([("f".to_string(), Some(Ty::File))].into_iter().collect())) }), &HeldWalk::default())
        .unwrap();
    assert_eq!(spell_held_steps(&held.steps), ".f");
    assert!(held.is_file());
    assert!(handle_refused_by(Some(&Ty::list(Ty::File)), Some(&Ty::list(Ty::File))).is_none(), "a file list takes files");
    assert!(handle_refused_by(Some(&Ty::list(Ty::File)), Some(&Ty::Json)).is_some());
    assert!(mixes_record_with_value(Some(&Ty::Union(Rc::new(vec![Ty::Record(None), Ty::Text])))));
    assert!(!mixes_record_with_value(Some(&Ty::Union(Rc::new(vec![Ty::Text, Ty::Number])))));
}

fn infer<'e>(source: &str, env: &'e dyn TypeEnv, version: u32) -> (Option<Ty>, Typing<'e>, movement_parser::lowering::expression::Expression) {
    let expr = expression_of_text(source).unwrap_or_else(|e| panic!("{source}: {}", e.message));
    let mut typing = Typing::new(env, version, Span { start: Loc { line: 1, col: 1 }, end: Loc { line: 1, col: 1 } });
    let ty = typing.infer(&expr);
    (ty, typing, expr)
}

fn spelled(source: &str, env: &dyn TypeEnv, version: u32) -> String {
    infer(source, env, version).0.as_ref().map_or("?".to_string(), describe_field_type)
}

#[test]
fn literals_and_operators() {
    assert_eq!(spelled("1 + 2", &EmptyEnv, 5), "number");
    assert_eq!(spelled("\"a\" == \"b\"", &EmptyEnv, 5), "boolean");
    assert_eq!(spelled("NULL", &EmptyEnv, 5), "null");
    assert_eq!(spelled("COALESCE(NULL, \"x\")", &EmptyEnv, 5), "text");
    assert_eq!(spelled("IF TRUE THEN 1 ELSE 2 END", &EmptyEnv, 5), "number");
    assert_eq!(spelled("IF TRUE THEN 1 ELSE \"x\" END", &EmptyEnv, 5), "?");
    assert_eq!(spelled("[1, \"a\"]", &EmptyEnv, 5), "list of (number | text)");
    assert_eq!(spelled("{ a: 1, b: 2 }", &EmptyEnv, 5), "{ a: number, b: number }");
    assert_eq!(spelled("SPLIT(\"a,b\")", &EmptyEnv, 5), "list of text");
    assert_eq!(spelled("DATE.PARSE(\"x\")", &EmptyEnv, 5), "date (or absent)");
    assert_eq!(spelled("AT([1, \"a\"], 0)", &EmptyEnv, 5), "number");
    assert_eq!(spelled("AT({ a: 1 }, \"a\")", &EmptyEnv, 5), "number");
}

#[derive(Default)]
struct Env {
    roots: HashMap<String, Position>,
    scalars: HashMap<String, Ty>,
}

impl TypeEnv for Env {
    fn resolve_root(&self, name: &str) -> Option<Position> {
        self.roots.get(name).cloned()
    }
    fn resolve_scalar(&self, name: &str) -> Option<Ty> {
        self.scalars.get(name).cloned()
    }
}

#[test]
fn names_walks_and_narrowing() {
    let crm = crm();
    let mut env = Env::default();
    env.roots.insert("crm".to_string(), Position::Meta { instance: crm.clone() });
    env.roots.insert("co".to_string(), position_ref_in(&crm, "Company").unwrap());
    env.scalars.insert("n".to_string(), maybe_absent(Ty::Number));
    assert_eq!(spelled("co.Name", &env, 5), "text");
    assert_eq!(spelled("co.Size", &env, 5), "number (or absent)");
    assert_eq!(spelled("crm-[:companies]->", &env, 5), "list of crm.company");
    assert_eq!(spelled("COUNT(co-[:people]->)", &env, 5), "number");
    assert_eq!(spelled("FIRST(co-[:people]->)", &env, 5), "crm.Person (or absent)");
    assert_eq!(spelled("IF n != NULL THEN n ELSE 0 END", &env, 5), "number", "the guard narrows the then arm");
    assert_eq!(spelled("IF co.Size != NULL THEN co.Size ELSE 0 END", &env, 5), "number");
    assert_eq!(spelled("IF co.Size != NULL THEN co.Size ELSE 0 END", &env, 2), "number (or absent)", "before version 3 a field is not narrowed; the arms agree, absence aside");
    assert_eq!(spelled("co", &env, 5), "crm.company");
}

#[test]
fn a_choice_may_hold_a_record() {
    let crm = crm();
    let mut env = Env::default();
    env.roots.insert("co".to_string(), position_ref_in(&crm, "Company").unwrap());
    let (ty, typing, expr) = infer("COALESCE(co, \"none\")", &env, 5);
    assert!(ty.is_none(), "a record and a value share no kind");
    let held = typing.may_hold_type(&expr).unwrap();
    assert!(mixes_record_with_value(Some(&held)));
    assert_eq!(describe_field_type(&values_beside_record(Some(&held))[0]), "text");
}

#[test]
fn presence_proofs_read_conditions() {
    let mut no_type = |_: &movement_parser::lowering::expression::Expression| -> Option<Ty> { Some(Ty::Text) };
    let expr = expression_of_text("x != NULL AND y.f == \"a\"").unwrap();
    assert_eq!(
        presence_proofs(&expr, &mut no_type),
        vec![
            PresenceProof::Binding { root: "x".to_string() },
            PresenceProof::NonBlank { root: "y".to_string(), property: Some("f".to_string()) },
            PresenceProof::Field { root: "y".to_string(), property: "f".to_string() },
        ]
    );
    let negated = expression_of_text("ISNULL(x) OR y == NULL").unwrap();
    assert_eq!(
        negative_presence_proofs(&negated, &mut no_type),
        vec![PresenceProof::Binding { root: "x".to_string() }, PresenceProof::Binding { root: "y".to_string() }]
    );
}
