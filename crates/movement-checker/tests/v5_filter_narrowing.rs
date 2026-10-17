//! From version 5 a `filter` whose function's own test keeps only members
//! that are there answers a list of present members, as TypeScript's inferred
//! type predicate makes `xs.filter(x => x != null)` a `T[]`. The narrowing is
//! the body's: `x != null` returned, `!(x == null)`, a guard clause that
//! returns `false` above a `return true`, a conjunction — every `return` that
//! may keep a member proves it present. So the filtered list clears
//! MOV_ABSENT_REQUIRED on `List.sum` and its siblings. Nothing is keyed on a
//! name. Versions 1–4 keep the members' type as it was. The TypeScript twin is
//! packages/movement-lang/checker/__test__/v5_filter_narrowing.unit.test.ts,
//! same programs, same answers.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"contractVersion":1,"adapters":{},"credentials":{},"plugins":{}}"#;

/// Each error `body` draws under `version`, as (code, message).
fn diagnostics(body: &str, version: u32) -> Vec<(String, String)> {
    let declaration = if version >= 5 { "function" } else { "movement" };
    let source = format!("{declaration} go(t: <text>, xs: <number[]>) {{\n{body}\n}}");
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let diagnostics = check_source(&source, &catalog, options).unwrap_or_else(|e| panic!("{source}: {e:?}"));
    diagnostics.into_iter().filter(|d| d.severity.is_none()).map(|d| (d.code, d.message)).collect()
}

/// The absence refusals a sum over `filter(ns, <fn>)` draws, `ns` a list
/// that may hold an absent member.
fn summed(function: &str) -> Vec<String> {
    diagnostics(&format!("  ns = map(xs, (x) => Number.parse(t))\n  ys = filter(ns, {function})\n  s = List.sum(ys)"), 5)
        .into_iter()
        .filter(|(code, _)| code == "MOV_ABSENT_REQUIRED")
        .map(|(_, message)| message)
        .collect()
}

#[test]
fn under_5_a_test_that_keeps_only_present_members_narrows() {
    for function in [
        "(n) => n != null",
        "(n) => null != n",
        "(n) => !(n == null)",
        "(n) => n != null && n > 3",
        "(n) => {\n    if (n == null) {\n      return false\n    }\n    return true\n  }",
        "(n) => {\n    if (n != null) {\n      return true\n    }\n    return false\n  }",
    ] {
        assert_eq!(summed(function), Vec::<String>::new(), "{function}");
    }
}

#[test]
fn under_5_the_filter_written_inside_the_fold_clears_it_too() {
    assert_eq!(diagnostics("  ns = map(xs, (x) => Number.parse(t))\n  s = List.sum(filter(ns, (n) => n != null)) + 1", 5), Vec::new());
}

#[test]
fn under_5_a_test_that_may_keep_an_absent_member_does_not() {
    for function in [
        "(n) => true",
        "(n) => n == null",
        "(n) => {\n    if (n == null) {\n      return true\n    }\n    return n > 3\n  }",
        "(n) => n != null || t == \"\"",
    ] {
        assert_eq!(summed(function).len(), 1, "{function}");
    }
}

#[test]
fn under_5_the_folds_remedy_offers_the_filter_form() {
    assert!(summed("(n) => true")[0].contains("'List.sum(filter(ys, (x) => x != null))'"));
}

#[test]
fn under_1_to_4_a_filter_keeps_its_members_type_as_it_was() {
    // A text built-in names the list it is handed, members' absence and all.
    for version in [3, 4] {
        let named: Vec<String> = diagnostics("  ns = MAP(xs, (x) => FIRST(xs))\n  ys = FILTER(ns, (n) => NOT ISNULL(n))\n  u = UPPER(ys)", version)
            .into_iter()
            .filter(|(code, _)| code == "MOV_BUILTIN_ARG_TYPE")
            .map(|(_, message)| message)
            .collect();
        assert!(named.join(",").contains("number (or absent)"), "{version}: {named:?}");
    }
}

#[test]
fn under_5_the_list_the_filter_answers_is_a_list_of_present_members() {
    let found: Vec<String> = diagnostics("  ns = map(xs, (x) => Number.parse(t))\n  ys = filter(ns, (n) => n != null)\n  u = Text.upper(ys)", 5)
        .into_iter()
        .filter(|(code, _)| code == "MOV_BUILTIN_ARG_TYPE")
        .map(|(_, message)| message)
        .collect();
    assert_eq!(found.len(), 1);
    assert!(!found[0].contains("absent"), "{found:?}");
}
