//! From version 5 a number computed from a value that may be absent is refused
//! (MOV_ABSENT_REQUIRED): `+ - * / %`, unary minus, a built-in's number
//! parameter (`Number.round(n)`), and a fold over a list that may hold an
//! absent member (`List.sum`, `List.avg`, `List.min`, `List.max`). The engine
//! reads an absent value as 0 there, so the run computed a number nobody
//! meant; TypeScript refuses `n + 1` on `number | undefined` for the same
//! reason. A `!= null` guard, a guard clause that leaves, `coalesce`, and `?:`
//! each clear it; a fold's list is cleared by `List.compact` or a `coalesce`
//! map. Versions 1–4 keep reading absent as 0, and a move up across 5 is
//! warned of. The TypeScript twin is
//! checker/__test__/v5_absent_arithmetic.unit.test.ts, same programs, same
//! messages.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"contractVersion":1,"adapters":{"crm":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"crm_cred":{"positions":{"company":{"properties":{"name":"text"},"edges":{}}},"collections":{"companies":{"target":"company"}}}}}},"credentials":{"crm_cred":{"adapters":["crm"]}},"plugins":{}}"#;

const SEE: &str = " (see handbook: front#maybe-absent)";
const MAYBE: &str = "number (or absent)";

fn absent(body: &str, version: u32, upgrading_from: Option<u32>) -> Vec<(&'static str, String)> {
    let (setup, declaration) = if version >= 5 { ("c = connect crm using crm_cred", "function") } else { ("c = crm(credentials: crm_cred)", "movement") };
    let source = format!("import {{ crm }} from adapters\nimport {{ crm_cred }} from credentials\n{setup}\n{declaration} go(t: <text>, xs: <number[]>) {{\n{body}\n}}");
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let diagnostics = check_source(&source, &catalog, options).unwrap_or_else(|e| panic!("{source}: {e:?}"));
    diagnostics
        .into_iter()
        .filter(|d| d.code == "MOV_ABSENT_REQUIRED")
        .map(|d| (if d.severity.is_none() { "error" } else { "warning" }, d.message))
        .collect()
}

fn guarded(name: &str) -> String {
    format!("Guard it ('if ({name} != null) {{ … }}'), or fall back to a value that is always there ('coalesce({name}, 0)').{SEE}")
}

fn unnamed() -> String {
    format!("Guard it with a '!= null' test, or fall back to a value that is always there ('coalesce(…, 0)').{SEE}")
}

fn none() -> Vec<(&'static str, String)> {
    Vec::new()
}

#[test]
fn under_5_an_operator_refuses_an_operand_that_may_be_absent_on_either_side() {
    assert_eq!(
        absent("  n = Number.parse(t)\n  m = n + 1", 5, None),
        vec![("error", format!("'n' may be absent ({MAYBE}), and '+' needs a number on both sides (it reads an absent value as 0). {}", guarded("n")))]
    );
    assert_eq!(
        absent("  n = Number.parse(t)\n  m = 2 * n", 5, None),
        vec![("error", format!("'n' may be absent ({MAYBE}), and '*' needs a number on both sides (it reads an absent value as 0). {}", guarded("n")))]
    );
    assert_eq!(
        absent("  m = first(xs) % 2", 5, None),
        vec![("error", format!("This value may be absent ({MAYBE}), and '%' needs a number on both sides (it reads an absent value as 0). {}", unnamed()))]
    );
}

#[test]
fn under_5_unary_minus_refuses_one() {
    assert_eq!(
        absent("  m = -Number.parse(t)", 5, None),
        vec![("error", format!("This value may be absent ({MAYBE}), and unary '-' needs a number (it reads an absent value as 0). {}", unnamed()))]
    );
}

#[test]
fn under_5_a_builtins_number_parameter_refuses_one() {
    assert_eq!(
        absent("  n = Number.parse(t)\n  m = Number.round(n)", 5, None),
        vec![("error", format!("'n' may be absent ({MAYBE}), and Number.round's 'number' takes a number. {}", guarded("n")))]
    );
}

#[test]
fn under_5_a_fold_refuses_a_list_that_may_hold_an_absent_member() {
    assert_eq!(
        absent("  ys = map(xs, (x) => Number.parse(t))\n  s = List.sum(ys)", 5, None),
        vec![("error", format!("'ys' may hold an absent member ({MAYBE}), and List.sum reads an absent member as 0. Drop the absent members first ('List.sum(List.compact(ys))'), or fill them ('List.sum(map(ys, (x) => coalesce(x, 0)))').{SEE}"))]
    );
    assert_eq!(absent("  ys = map(xs, (x) => Number.parse(t))\n  s = List.max(ys)", 5, None).len(), 1);
}

#[test]
fn under_5_a_guard_a_guard_clause_that_leaves_coalesce_and_the_conditional_each_clear_it() {
    assert_eq!(absent("  n = Number.parse(t)\n  if (n != null) {\n    m = n + 1\n  }", 5, None), none());
    assert_eq!(absent("  n = Number.parse(t)\n  if (n == null) {\n    fail(\"no number\")\n  }\n  m = -n", 5, None), none());
    assert_eq!(absent("  m = Number.round(coalesce(Number.parse(t), 0)) + 1", 5, None), none());
    assert_eq!(absent("  n = Number.parse(t)\n  m = n != null ? n * 2 : 0", 5, None), none());
}

#[test]
fn under_5_a_folds_list_is_cleared_by_dropping_or_filling_its_absent_members() {
    assert_eq!(absent("  ys = map(xs, (x) => Number.parse(t))\n  s = List.sum(List.compact(ys))", 5, None), none());
    assert_eq!(absent("  ys = map(xs, (x) => Number.parse(t))\n  s = List.avg(map(ys, (y) => coalesce(y, 0)))", 5, None), none());
    assert_eq!(absent("  s = List.sum(xs) + count(xs)", 5, None), none());
}

#[test]
fn under_1_to_4_a_number_that_may_be_absent_is_read_as_0_as_it_always_was() {
    for version in [3, 4] {
        assert_eq!(absent("  m = FIRST(xs) + 1\n  k = -LAST(xs)\n  r = ROUND(FIRST(xs))", version, None), none(), "version {version}");
    }
}

#[test]
fn a_move_up_across_5_is_warned_of() {
    assert_eq!(
        absent("  m = first(xs) + 1", 5, Some(4)),
        vec![("warning", format!("since \"Dancing Wren\" (5) a number computed from a value that may be absent is refused; before, the absent value was read as 0. This value may be absent ({MAYBE}), and '+' needs a number on both sides (it reads an absent value as 0). Guard it with a '!= null' test, or fall back to a value that is always there ('coalesce(…, 0)'), then upgrade.{SEE}"))]
    );
}
