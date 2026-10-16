//! Every construct of the design's §2: under version 5 the new spelling reads
//! as the old one does under 4 (the same lowering), and the old spelling is
//! refused with a fix whose result reads the same again.

use serde_json::Value;

use super::{Edit, canonicalize, with_version};
use crate::util::utf16::Utf16;

fn lowered(text: &str, version: u32) -> Value {
    with_version(version, || {
        let tree = crate::expr::parse_expression(text).unwrap_or_else(|e| panic!("{text}: {e:?}"));
        match crate::lowering::lower_expression(&tree, text) {
            Ok(e) => serde_json::to_value(e).unwrap(),
            Err(r) => serde_json::json!({ "refused": r.message }),
        }
    })
}

fn findings(text: &str) -> Vec<super::Finding> {
    with_version(5, || {
        let mut tree = crate::expr::parse_expression_raw(text).unwrap_or_else(|e| panic!("{text}: {e:?}"));
        canonicalize(&mut tree, &Utf16::new(text))
    })
}

fn apply(text: &str, edits: &[Edit]) -> String {
    let src = Utf16::new(text);
    let mut edits = edits.to_vec();
    edits.sort_by_key(|e| std::cmp::Reverse(e.at.start));
    let mut units = src.units().to_vec();
    for e in edits {
        units.splice(e.at.start..e.at.end, e.text.encode_utf16());
    }
    String::from_utf16(&units).unwrap()
}

/// Applies every fix, outermost first, until none is left (an outer fix is
/// written from the original text, so an inner one comes round again).
fn upgraded(text: &str) -> String {
    let mut text = text.to_string();
    for _ in 0..8 {
        let found = findings(&text);
        if found.is_empty() {
            return text;
        }
        let mut taken: Vec<Edit> = Vec::new();
        for f in found.iter().rev() {
            for e in f.edits.clone().unwrap_or_else(|| panic!("{text}: no fix for {}", f.message)) {
                if taken.iter().all(|t| e.at.end <= t.at.start || e.at.start >= t.at.end) {
                    taken.push(e);
                }
            }
        }
        text = apply(&text, &taken);
    }
    panic!("{text}: fixes did not settle")
}

/// `new` under 5 reads as `old` under 4; `old` under 5 is refused, and its
/// fixes give a text that reads as `new` does.
fn same(new: &str, old: &str) {
    assert!(findings(new).is_empty(), "{new}: {:?}", findings(new));
    let want = lowered(old, 4);
    assert_eq!(lowered(new, 5), want, "{new} vs {old}");
    assert!(!findings(old).is_empty(), "{old} is refused under 5");
    let fixed = upgraded(old);
    assert_eq!(lowered(&fixed, 5), want, "{old} upgraded to {fixed}");
}

#[test]
fn core_words() {
    same("map(rows, (r) => r.Name, { concurrency: 2 })", "MAP(rows, { concurrency: 2 }, (r) => r.Name)");
    same("filter(lines, (t) => Text.length(t) > 0)", "FILTER(lines, (t) => LENGTH(t) > 0)");
    same("reduce(lines, (acc, t) => acc + Text.length(t), 0)", "REDUCE(lines, 0, (acc, t) => acc + LENGTH(t))");
    same("count(co-[t:Team]->)", "COUNT(co-[t:Team]->)");
    same("first(xs)", "FIRST(xs)");
    same("only(co-[t:Team]->)", "ONLY(co-[t:Team]->)");
    same("sort(rows, (r) => r.score, { order: \"desc\" })", "SORT(rows, `score`, DESC)");
    same("coalesce(a, b, \"unknown\")", "COALESCE(a, b, \"unknown\")");
    same("members(<Thesis>)", "MEMBERS(<Thesis>)");
    same("ai(prompt, { tier: \"careful\" })", "AI(prompt, \"careful\")");
    same("fail(\"no #ops channel\")", "ERROR(\"no #ops channel\")");
    same("callback(() => `Chase`(company))", "callback(`Chase`(company))");
    same("coalesce(only(xs), fail(\"no #ops\"))", "COALESCE(ONLY(xs), ERROR(\"no #ops\"))");
}

#[test]
fn namespaces() {
    for (new, old) in [
        ("Text.upper(Text.trim(m.Subject))", "UPPER(TRIM(m.Subject))"),
        ("Text.lower(t)", "LOWER(t)"),
        ("Text.split(t, \",\")", "SPLIT(t, \",\")"),
        ("Text.concat(a, b)", "CONCAT(a, b)"),
        ("Text.join(xs, \", \")", "JOIN(xs, \", \")"),
        ("Text.from(v)", "TOSTRING(v)"),
        ("Text.chunks(t, { size: 10, overlap: 2 })", "CHUNKS(t, { size: 10, overlap: 2 })"),
        ("Text.regexExtract(t, \"a+\")", "TEXT.REGEX_EXTRACT(t, \"a+\")"),
        ("Text.slug(t)", "TEXT.SLUG(t)"),
        ("Text.pairs(r)", "TEXT.PAIRS(r)"),
        ("Json.stringify(v)", "TEXT.SERIALISE(v, \"JSON\")"),
        ("Text.includes(x, \"pdf\")", "x CONTAINS \"pdf\""),
        ("Number.abs(n)", "ABS(n)"),
        ("Number.round(n)", "ROUND(n)"),
        ("Number.floor(n)", "FLOOR(n)"),
        ("Number.ceil(n)", "CEIL(n)"),
        ("Number.parse(v)", "NUMBER(v)"),
        ("Number.format(n, \"compact\")", "NUMBER.FORMAT(n, \"compact\")"),
        ("Date.from(v)", "DATE(v)"),
        ("Date.parse(t)", "DATE.PARSE(t)"),
        ("Date.addDays(d, 3)", "DATE.ADD_DAYS(d, 3)"),
        ("Date.format(v, \"yyyy\")", "DATE.FORMAT(v, \"yyyy\")"),
        ("Date.today(zone)", "DATE.TODAY(zone)"),
        ("DateTime.from(v)", "DATETIME(v)"),
        ("DateTime.at(d, \"09:00\", zone)", "DATETIME.AT(d, \"09:00\", zone)"),
        ("DateTime.toIso(v)", "DATE.FORMAT_ISO(v)"),
        ("Currency.numberFromFigure(f)", "CURRENCY.GET_NUMBER_FROM_FIGURE(f)"),
        ("Currency.codeFromFigure(f)", "CURRENCY.GET_CODE_FROM_FIGURE(f)"),
        ("Currency.formatFigure(n, \"USD\")", "CURRENCY.FORMAT_FIGURE(n, \"USD\")"),
        ("Url.host(t)", "URL.HOST(t)"),
        ("List.sum(xs)", "SUM(xs)"),
        ("List.avg(xs)", "AVG(xs)"),
        ("List.min(xs)", "MIN(xs)"),
        ("List.max(xs)", "MAX(xs)"),
        ("List.last(xs)", "LAST(xs)"),
        ("List.from(co-[t:Team]->)", "COLLECT(co-[t:Team]->)"),
        ("List.compact(a, b)", "MULTI(a, b)"),
        ("List.groupBy(xs, (x) => x.k)", "GROUPBY(xs, (x) => x.k)"),
        ("List.keyBy(xs, (x) => x.k)", "KEYBY(xs, (x) => x.k)"),
        ("List.includes(xs, v)", "v IN xs"),
        ("File.from(content, \"pdf\")", "FILE(content, \"pdf\")"),
        ("File.read(f)", "READ(f)"),
        ("xs[0]", "AT(xs, 0)"),
        ("d[key]", "AT(d, key)"),
    ] {
        same(new, old);
    }
    // `d.k` already reads a map's field under 5 (a member read, not `AT`).
    assert_eq!(upgraded("AT(d, \"k\")"), "d.k");
}

#[test]
fn operators_and_conditionals() {
    same("x != null && (a || b)", "x != NULL AND (a OR b)");
    same("domain != null ? \"https://${domain}\" : \"\"", "IF domain != NULL THEN \"https://${domain}\" ELSE \"\" END");
    // A presence test changes its tree, not only its spelling (`ISNULL` and
    // `EXISTS` on a value become comparisons with null): the rewrite is
    // pinned as text.
    assert_eq!(upgraded("NOT ISNULL(x) AND (a OR b)"), "!(x == null) && (a || b)");
    assert_eq!(upgraded("IF EXISTS(domain) THEN 1 ELSE 2 END"), "(domain != null) ? 1 : 2");
    assert_eq!(upgraded("ISNULL(x)"), "x == null");
    same("[true, false, null]", "[TRUE, FALSE, NULL]");
    same("rec is <crm-[:People]->>", "rec IS <crm-[:People]->>");
    same("!done", "NOT done");
    same("a ? b ? 1 : 2 : 3", "IF a THEN IF b THEN 1 ELSE 2 END ELSE 3 END");
}

#[test]
fn presence_and_walks() {
    same("exists(msg-[:Attachments]->)", "EXISTS(msg-[:Attachments]->)");
    assert_eq!(upgraded("EXISTS(ch.`Topic`)"), "ch.`Topic` != null");
    // Inside walk brackets nothing is respelled: CAPS words, AND, any case.
    let walk = "crm-[c:Companies WHERE c.Categories == \"Customer\" AND LOWER(c.Name) CONTAINS \"x\" ORDER BY c.`Created At` DESC LIMIT 10]->";
    assert!(findings(walk).is_empty(), "{:?}", findings(walk));
    assert_eq!(lowered(walk, 5), lowered(walk, 4));
    assert!(findings("ch-[m:Messages WHERE lower(m.Text) CONTAINS \"urgent\"]->").is_empty());
    let everyday = findings("ch-[m:Messages WHERE Text.lower(m.Text) CONTAINS \"urgent\"]->");
    assert_eq!(everyday.len(), 1);
    assert_eq!(everyday[0].edits.as_ref().unwrap()[0].text, "LOWER");
}

#[test]
fn wrong_case_and_unknown_members() {
    let f = findings("Upper(x)");
    assert_eq!(f[0].message, "`Upper` is written `Text.upper` from language version 5");
    let f = findings("Map(xs, f)");
    assert_eq!(f[0].edits.as_ref().unwrap()[0].text, "map");
    let f = findings("Text.uper(x)");
    assert_eq!((f[0].code, f[0].message.as_str()), (super::UNKNOWN_MEMBER_CODE, "`Text` has no member `uper`"));
    let f = findings("Text.Upper(x)");
    assert_eq!(f[0].message, "`Text` has no member `Upper` — did you mean `Text.upper`?");
}

#[test]
fn version_4_reads_as_before() {
    // `&&` and `? :` are not version 4's: refused exactly as before.
    for text in ["a && b", "a ? b : c"] {
        let v4 = with_version(4, || crate::expr::parse_expression(text).map(|_| ()).map_err(|e| e.message));
        let none = crate::expr::parse_expression(text).map(|_| ()).map_err(|e| e.message);
        assert!(v4.is_err(), "{text}");
        assert_eq!(v4, none);
    }
    // `Text.upper(x)` keeps version 4's reading (a call on the value `Text`).
    assert_eq!(lowered("Text.upper(x)", 4), lowered("Text.upper(x)", 0));
    assert_ne!(lowered("Text.upper(x)", 4), lowered("Text.upper(x)", 5));
}

fn program(source: &str, version: u32) -> crate::ast::Program {
    crate::stmt::parse_program(source, version, false).unwrap_or_else(|e| panic!("{source}: {e:?}"))
}

/// The program with its spelling findings set aside, as JSON.
fn statements(source: &str, version: u32) -> Value {
    serde_json::to_value(&program(source, version).statements).unwrap()
}

fn spelling(source: &str) -> Vec<(String, String)> {
    program(source, 5).spelling.into_iter().map(|f| (f.message, f.fix.map(|f| f.edits[0].text.clone()).unwrap_or_default())).collect()
}

#[test]
fn adapter_setup_is_connect() {
    let new = "import { `@lf/attio` as attio } from adapters\nimport { acme_main as acme } from credentials\ncrm = connect attio using acme { dryRun: true }\ninbox = connect email\n";
    let old = "import { attio } from adapters\nimport { acme_main as acme } from credentials\ncrm = attio(credentials: acme, dry_run: true)\ninbox = email()\n";
    assert!(program(new, 5).spelling.is_empty(), "{:?}", program(new, 5).spelling);
    let (n, o) = (statements(new, 5), statements(old, 4));
    assert_eq!(n.pointer("/0/names/0/name"), o.pointer("/0/names/0/name"));
    assert_eq!(n.pointer("/2/value/construct/callee"), o.pointer("/2/value/construct/callee"));
    let args = |v: &Value| v.pointer("/2/value/construct/args").unwrap().as_array().unwrap().iter().map(|a| (a["name"].clone(), a["value"]["raw"].clone())).collect::<Vec<_>>();
    assert_eq!(args(&n), args(&o));
    assert_eq!(n.pointer("/3/value/construct/callee"), Some(&serde_json::json!("email")));
    let refused = spelling(old);
    assert_eq!(refused[0].1, "connect attio using acme { dryRun: true }");
}

#[test]
fn declarations_conditions_and_errors() {
    assert_eq!(
        spelling("movement f() {\n  if x != null {\n    y = 1\n  }\n}\n"),
        vec![
            ("from language version 5 a declaration is a `function`".to_string(), "function".to_string()),
            ("from language version 5 an `if` condition is parenthesised: `if (…) {`".to_string(), "(".to_string()),
        ]
    );
    assert!(spelling("function f() {\n  if (x != null && y) {\n    fail(\"no\")\n  } else if (z) {\n  }\n}\n").is_empty());
    // Under 4 nothing is refused, and the old surface parses as before.
    assert!(program("movement f() {\n  if x {\n    ERROR(\"no\")\n  }\n}\n", 4).spelling.is_empty());
}
