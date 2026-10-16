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

/// `lowered` as versions 1–4 read it: an alias read's `fieldOnly` mark gone.
fn without_field_only(mut value: Value) -> Value {
    fn strip(value: &mut Value) {
        match value {
            Value::Object(object) => {
                object.remove("fieldOnly");
                object.values_mut().for_each(strip);
            }
            Value::Array(items) => items.iter_mut().for_each(strip),
            _ => {}
        }
    }
    strip(&mut value);
    value
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
    same("coalesce(a, b, \"unknown\")", "COALESCE(a, b, \"unknown\")");
    same("members(<Thesis>)", "MEMBERS(<Thesis>)");
    same("ai(prompt, { tier: \"careful\" })", "AI(prompt, \"careful\")");
    same("callback(() => `Chase`(company))", "callback(`Chase`(company))");
    // Inside an expression `fail` is the call `ERROR(…)`, a value that never
    // arrives (the checkers type it; versions 1–4 never read it as one).
    assert!(findings("coalesce(only(xs), fail(\"no #ops\"))").is_empty());
    assert_eq!(lowered("coalesce(only(xs), fail(\"no #ops\"))", 5), lowered("COALESCE(ONLY(xs), ERROR(\"no #ops\"))", 4));
    // `sort` with no key, by its order alone, or keyed by the member itself.
    same("sort(xs)", "SORT(xs)");
    same("sort(xs, { order: \"desc\" })", "SORT(xs, DESC)");
    same("sort(xs, { order: \"asc\" })", "SORT(xs, asc)");
    assert_eq!(lowered("sort(xs, (x) => x, { order: \"desc\" })", 5), lowered("SORT(xs, DESC)", 4));
}

/// `sort` by a function key reads as the collection op `SORTBY`, its
/// settings where `MAP`'s go; the old field key is rewritten to a function,
/// its fix safe only where no variable of the field's name is in scope.
#[test]
fn sort_by_a_function_key() {
    for (new, canonical) in [
        ("sort(rows, (r) => Text.lower(r.name), { order: \"desc\" })", "SORTBY(rows, { order: \"desc\" }, (r) => LOWER(r.name))"),
        ("sort(rows, (r) => r.score)", "SORTBY(rows, (r) => r.score)"),
        ("sort(rows, key)", "SORTBY(rows, key)"),
        ("first(sort(rows, (r) => r.score))", "FIRST(SORTBY(rows, (r) => r.score))"),
    ] {
        assert!(findings(new).is_empty(), "{new}: {:?}", findings(new));
        assert_eq!(lowered(new, 5), lowered(canonical, 4), "{new}");
    }
    // The tree's name is no spelling: under 5 it is refused as `sort`'s.
    assert_eq!(upgraded("SORTBY(rows, { order: \"desc\" }, (r) => r.score)"), "sort(rows, (r) => r.score, { order: \"desc\" })");
    // The old field key: a function reading the field, not marked safe on
    // its own — the checker marks it where no variable hides the field.
    let old = findings("SORT(rows, `score`, DESC)");
    assert_eq!(old[0].edits.as_ref().unwrap()[0].text, "sort(rows, (r) => r.score, { order: \"desc\" })");
    assert!(old[0].safe);
    assert_eq!(old[0].unsafe_if_bound, vec!["score".to_string(), "r".to_string()]);
    assert_eq!(upgraded("SORT(rows, `Added At`)"), "sort(rows, (r) => r.`Added At`)");
    assert!(findings("SORT(xs, DESC)")[0].unsafe_if_bound.is_empty());
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
    // A text key stays an index: `d.k` is a field read, which on a record
    // answers where `AT(d, "k")` refused. A non-primary object is grouped,
    // and a grouped object is indexed (`(a).k` does not lower).
    assert_eq!(upgraded("AT(d, \"k\")"), "d[\"k\"]");
    same("d[\"k\"]", "AT(d, \"k\")");
    assert_eq!(upgraded("AT(a + b, 0)"), "(a + b)[0]");
    same("(a + b)[0]", "AT(a + b, 0)");
    assert_eq!(upgraded("AT(IF c THEN d ELSE e END, \"k\")"), "(c ? d : e)[\"k\"]");
    same("(c ? d : e)[\"k\"]", "AT(IF c THEN d ELSE e END, \"k\")");
    assert_eq!(upgraded("AT(COALESCE(d, e), \"k\")"), "coalesce(d, e)[\"k\"]");
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

/// The first hop WHERE in a lowered walk.
fn hop_filter(lowered: &Value) -> Option<Value> {
    match lowered {
        Value::Object(o) => o.get("expressionFilter").cloned().or_else(|| o.values().find_map(hop_filter)),
        Value::Array(items) => items.iter().find_map(hop_filter),
        _ => None,
    }
}

#[test]
fn a_narrowing_key_does_not_depend_on_how_the_field_read_is_spelled() {
    use crate::catalog::helpers::refinement_key;
    let key = |text: &str, version: u32| refinement_key("Record Change", &hop_filter(&lowered(text, version)).expect("a hop WHERE"));
    let alias = key("at-[e:`Record Change` WHERE e.action == \"record.created\" AND e.`table` == \"tblDeals\"]->", 5);
    let bare = key("at-[:`Record Change` WHERE action == \"record.created\" AND `table` == \"tblDeals\"]->", 4);
    assert!(lowered("at-[e:`Record Change` WHERE e.action == \"x\"]->", 5).to_string().contains("fieldOnly"));
    assert_eq!(alias, bare);
    // What a host registers: its own filter, no spelling marks.
    let host = serde_json::json!({ "type": "logical", "op": "and", "operands": [
        { "type": "compare", "op": "eq", "left": { "type": "edge_property", "propertyTypeId": "action" }, "right": { "type": "static", "value": "record.created" } },
        { "type": "compare", "op": "eq", "left": { "type": "edge_property", "propertyTypeId": "table" }, "right": { "type": "static", "value": "tblDeals" } },
    ] });
    let bare_filter = hop_filter(&lowered("at-[:`Record Change` WHERE action == \"record.created\" AND `table` == \"tblDeals\"]->", 4)).unwrap();
    assert_eq!(bare_filter, host);
    assert_eq!(alias, refinement_key("Record Change", &host));
}

#[test]
fn presence_and_walks() {
    same("exists(msg-[:Attachments]->)", "EXISTS(msg-[:Attachments]->)");
    assert_eq!(upgraded("EXISTS(ch.`Topic`)"), "ch.`Topic` != null");
    // Inside walk brackets nothing is respelled: CAPS words, AND, any case.
    let walk = "crm-[c:Companies WHERE c.Categories == \"Customer\" AND LOWER(c.Name) CONTAINS \"x\" ORDER BY c.`Created At` DESC LIMIT 10]->";
    assert!(findings(walk).is_empty(), "{:?}", findings(walk));
    // A field read through the hop's alias is the bare field versions 1–4
    // wrote (the gates and the pushdown see the field they always saw),
    // marked as only ever the field: never a variable of the same name.
    let bare = "crm-[c:Companies WHERE Categories == \"Customer\" AND LOWER(Name) CONTAINS \"x\" ORDER BY `Created At` DESC LIMIT 10]->";
    let read = lowered(walk, 5);
    assert_eq!(read.to_string().matches(r#""fieldOnly":true"#).count(), 3, "{read}");
    assert_eq!(without_field_only(read), lowered(bare, 4));
    // Another hop's alias, and a walk nested in the WHERE, keep their reads.
    let nested = "crm-[c:Companies]->-[t:Team WHERE c.Name == t.Name AND EXISTS(t-[p:Posts WHERE t.Name == Title]->)]->";
    let nested_bare = "crm-[c:Companies]->-[t:Team WHERE c.Name == Name AND EXISTS(t-[p:Posts WHERE t.Name == Title]->)]->";
    let read = lowered(nested, 5);
    assert_eq!(read.to_string().matches(r#""fieldOnly":true"#).count(), 1, "{read}");
    assert_eq!(without_field_only(read), lowered(nested_bare, 4));
    assert!(findings("ch-[m:Messages WHERE lower(m.Text) CONTAINS \"urgent\"]->").is_empty());
    let everyday = findings("ch-[m:Messages WHERE Text.lower(m.Text) CONTAINS \"urgent\"]->");
    assert_eq!(everyday.len(), 1);
    assert_eq!(everyday[0].edits.as_ref().unwrap()[0].text, "LOWER");
    // The refused spelling reads as the walk word it means: the one finding,
    // and no lowering refusal beside it.
    assert_eq!(
        lowered("ch-[m:Messages WHERE Text.lower(m.Text) CONTAINS \"urgent\"]->", 5),
        lowered("ch-[m:Messages WHERE LOWER(m.Text) CONTAINS \"urgent\"]->", 5)
    );
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

#[test]
fn until_takes_its_cadence_as_a_setting() {
    let new = "function f(a: <number>) {\n  await until(a > 1, { every: 1h })\n}\n";
    let old = "movement f(a: <number>) {\n  await until(a > 1, every: 1h)\n}\n";
    assert!(program(new, 5).spelling.is_empty());
    assert_eq!(serde_json::to_value(&program(new, 5).statements).unwrap().pointer("/0/body/0/await/source/every/raw"), Some(&serde_json::json!("1h")));
    assert_eq!(spelling(old)[1].1, "{ every: 1h }");
}

#[test]
fn bang_binds_as_typescript_s_unary_operator() {
    // Under 4 `!` reaches over the comparison; under 5 it takes the operand beside it.
    assert_eq!(lowered("!a == b", 4), lowered("NOT (a == b)", 4));
    assert_eq!(lowered("!a == b", 5), lowered("(NOT a) == b", 4));
    assert_eq!(lowered("!a && b", 5), lowered("NOT a AND b", 4));
    assert_eq!(lowered("!x.done", 5), lowered("NOT x.done", 4));
    // The text whose reading changed is refused; the fix writes out the old reading.
    let f = findings("!a == b");
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0].edits.as_ref().unwrap()[0].text, "!(a == b)");
    assert_eq!(lowered(&upgraded("!a == b"), 5), lowered("!a == b", 4));
    assert_eq!(upgraded("!a + 1 > b && c"), "!(a + 1 > b) && c");
    assert_eq!(lowered(&upgraded("!!a == b"), 5), lowered("!!a == b", 4));
    assert_eq!(lowered(&upgraded("!a IS <crm-[:People]->>"), 5), lowered("NOT a IS <crm-[:People]->>", 4));
    // Written with the parentheses either way, or with nothing for `!` to reach: clean.
    for clean in ["(!a) == b", "!(a == b)", "!a && b", "f(!a, b == c)", "Text.includes(x, \"y\") == !b"] {
        assert!(findings(clean).is_empty(), "{clean}: {:?}", findings(clean));
    }
    // `NOT` keeps its reach (it is refused as a spelling, its fix `!(…)`).
    assert_eq!(upgraded("NOT a == b"), "!(a == b)");
}

#[test]
fn fail_is_the_error_statement() {
    let new = program("function f() {\n  fail(\"no\")\n}\n", 5);
    assert!(new.spelling.is_empty(), "{:?}", new.spelling);
    let (n, o) = (serde_json::to_value(&new.statements).unwrap(), statements("movement f() {\n  ERROR(\"no\")\n}\n", 4));
    assert!(n.pointer("/0/body/0").is_some(), "{n}");
    assert_eq!(n.pointer("/0/body/0").map(|s| s.as_object().unwrap().keys().cloned().collect::<Vec<_>>()), o.pointer("/0/body/0").map(|s| s.as_object().unwrap().keys().cloned().collect::<Vec<_>>()));
    assert_eq!(spelling("function f() {\n  ERROR(\"no\")\n}\n"), vec![("`ERROR` is written `fail` from language version 5".to_string(), "fail".to_string())]);
    // Under 4 `fail` is no statement word.
    assert!(crate::stmt::parse_program("movement f() {\n  ERROR(\"no\")\n}\n", 4, false).unwrap().spelling.is_empty());
}

#[test]
fn a_block_closure_inside_an_expression_is_read_for_old_spellings() {
    // The `if` condition is an expression slot; the statements of the block
    // closure inside it are read by the statement grammar only when the
    // nested call is (long after the parse).
    let source = "function go(xs) {\n  if (count(filter(xs, (r) => {\n    return LENGTH(r) > 0\n  })) > 0) {\n    y = 1\n  }\n}\n";
    let found = program(source, 5).spelling;
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].message, "`LENGTH` is written `Text.length` from language version 5");
    assert_eq!((found[0].span.start.line, found[0].span.start.col), (3, 12));
    // Nested a level deeper, and placed in the file.
    let deeper = "function go(xs) {\n  n = Text.length(Text.trim(f(xs, (r) => {\n    m = Text.trim(g((s) => {\n      return UPPER(s)\n    }))\n    return m\n  })))\n}\n";
    let found = program(deeper, 5).spelling;
    assert_eq!(found.iter().map(|f| (f.span.start.line, f.span.start.col)).collect::<Vec<_>>(), vec![(4, 14)], "{found:?}");
    // A block closure the statement grammar reads at once (a call written
    // as a statement) is reported once, not again through its slot.
    let statement = "function go(xs) {\n  ys = map(xs, (r) => {\n    return UPPER(r)\n  })\n}\n";
    assert_eq!(program(statement, 5).spelling.len(), 1);
    // Under 4 nothing is read for spellings.
    let v4 = "movement go(xs) {\n  if count(FILTER(xs, (r) => {\n    return LENGTH(r) > 0\n  })) > 0 {\n    y = 1\n  }\n}\n";
    assert!(program(v4, 4).spelling.is_empty());
}
