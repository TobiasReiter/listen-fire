//! Program text a diagnostic suggests (`'if EXISTS(x)'`, `AT(r, 0)`,
//! `IF … THEN "Yes" ELSE "No" END`), in the spelling of the program's own
//! language version. A message writes its suggestion once, in the canonical
//! spelling, and passes it through `spell_code`: under versions 1–4 the text
//! is returned as it is; from version 5 it is rewritten by the very fixes the
//! parser attaches to an old spelling, so a suggestion can never drift from
//! what the upgrade writes. `…` in a suggestion stands for any expression.

use crate::ast::Loc;
use crate::util::utf16::Utf16;

use super::table::OPERATORS;
use super::{Edit, canonicalize, with_version};

/// What `…` reads as while the suggestion is parsed: a name no program
/// writes, and in a statement a call of it (a statement is never a bare name).
const ELLIPSIS: &str = "__ellipsis__";
const ELLIPSIS_STATEMENT: &str = "__ellipsis__()";

/// The statement a suggestion that is a statement is parsed inside, and
/// taken back out of.
const BODY_OPEN: &str = "function __phrase__() {\n";
const BODY_CLOSE: &str = "\n}\n";

/// `text` (program text in the canonical, version 1–4 spelling) as
/// `version` spells it. A word the operators row holds (`AND`, `TRUE`) is
/// that row's spelling; an expression or a statement is rewritten by its
/// spelling fixes until none is left. A text neither grammar reads is
/// returned as it is.
pub fn spell_code(text: &str, version: u32) -> String {
    if !crate::version::since(version, 5) {
        return text.to_string();
    }
    if let Some((_, v5)) = OPERATORS.iter().find(|(old, _)| *old == text) {
        return (*v5).to_string();
    }
    expression(&text.replace('…', ELLIPSIS))
        .map(|spelled| spelled.replace(ELLIPSIS, "…"))
        .or_else(|| statements(&text.replace('…', ELLIPSIS_STATEMENT)).map(|spelled| spelled.replace(ELLIPSIS_STATEMENT, "…")))
        .unwrap_or_else(|| text.to_string())
}

/// A word of code in prose (`negated by NOT`, `narrow with an IS test`):
/// bare up to version 4, where it is a CAPS word; quoted from 5, where it is
/// a symbol or lower case (`negated by '!'`).
pub fn spell_word(word: &str, version: u32) -> String {
    if crate::version::since(version, 5) { format!("'{}'", spell_code(word, version)) } else { word.to_string() }
}

/// The head of an `if` a diagnostic suggests (`if EXISTS(x)`): from version 5
/// its condition is parenthesised and respelled (`if (x != null)`). For a
/// suggestion whose body is not code.
pub fn spell_if(condition: &str, version: u32) -> String {
    if crate::version::since(version, 5) { format!("if ({})", spell_code(condition, version)) } else { format!("if {condition}") }
}

/// An adapter set up with `args` (name, value), the credential among them
/// named `credential`.
pub struct Connection<'a> {
    pub adapter: &'a str,
    pub args: &'a [(&'a str, &'a str)],
    pub credential: Option<&'a str>,
}

/// The connection as `version` writes it: `attio(credentials: …)` up to 4,
/// `connect attio using … { dryRun: true }` from 5 (the credential after
/// `using`, every other argument a setting). The parser's refusal of an old
/// construction writes its fix with it.
pub fn connection(c: &Connection, version: u32) -> String {
    if !crate::version::since(version, 5) {
        let args: Vec<String> = c.args.iter().map(|(name, value)| format!("{name}: {value}")).collect();
        return format!("{}({})", c.adapter, args.join(", "));
    }
    let mut text = format!("connect {}", name_source(c.adapter));
    if let Some((_, value)) = c.args.iter().find(|(name, _)| Some(*name) == c.credential) {
        text.push_str(&format!(" using {value}"));
    }
    let settings: Vec<String> =
        c.args.iter().filter(|(name, _)| Some(*name) != c.credential).map(|(name, value)| format!("{}: {value}", camel_case(name))).collect();
    if !settings.is_empty() {
        text.push_str(&format!(" {{ {} }}", settings.join(", ")));
    }
    text
}

/// A name as source: bare when it is an identifier, backticked otherwise.
fn name_source(name: &str) -> String {
    let mut chars = name.chars();
    let ident = matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ident { name.to_string() } else { format!("`{name}`") }
}

/// `dry_run` as a v5 setting is spelled: `dryRun`.
pub fn camel_case(name: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in name.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// The fixes applied outermost first, round after round: an outer fix is
/// written from the text before it, so an inner one comes round again.
const ROUNDS: usize = 8;

fn expression(text: &str) -> Option<String> {
    let mut text = text.to_string();
    for _ in 0..ROUNDS {
        let found = with_version(5, || {
            crate::expr::parse_expression_raw(&text).map(|mut tree| canonicalize(&mut tree, &Utf16::new(&text)))
        })
        .ok()?;
        let edits: Vec<Edit> = found.into_iter().flat_map(|f| f.edits.unwrap_or_default()).collect();
        if edits.is_empty() {
            return Some(text);
        }
        text = apply(&text, disjoint(edits.into_iter().map(|e| (e.at.start, e.at.end, e.text))));
    }
    Some(text)
}

fn statements(text: &str) -> Option<String> {
    let mut whole = format!("{BODY_OPEN}{text}{BODY_CLOSE}");
    for _ in 0..ROUNDS {
        let program = crate::stmt::parse_program(&whole, 5, false).ok()?;
        let src = Utf16::new(&whole);
        let edits: Vec<(usize, usize, String)> = program
            .spelling
            .into_iter()
            .flat_map(|f| f.fix.map(|f| f.edits).unwrap_or_default())
            .map(|e| (offset(&src, e.span.start), offset(&src, e.span.end), e.text))
            .collect();
        if edits.is_empty() {
            break;
        }
        whole = apply(&whole, disjoint(edits.into_iter()));
    }
    let body = whole.strip_prefix(BODY_OPEN)?.strip_suffix(BODY_CLOSE)?;
    Some(body.to_string())
}

/// The edits that overlap none taken before them, the latest first (the
/// innermost finding is reported first, so the outermost wins).
fn disjoint(edits: impl DoubleEndedIterator<Item = (usize, usize, String)>) -> Vec<(usize, usize, String)> {
    let mut taken: Vec<(usize, usize, String)> = Vec::new();
    for (start, end, text) in edits.rev() {
        if taken.iter().all(|(s, e, _)| end <= *s || start >= *e) {
            taken.push((start, end, text));
        }
    }
    taken
}

fn apply(text: &str, mut edits: Vec<(usize, usize, String)>) -> String {
    // Last in the text first; at one offset the replacement before the
    // insertion, so `(` lands ahead of what replaced the text after it.
    edits.sort_by_key(|(start, end, _)| std::cmp::Reverse((*start, *end)));
    let mut units = Utf16::new(text).units().to_vec();
    for (start, end, replacement) in edits {
        units.splice(start..end, replacement.encode_utf16());
    }
    String::from_utf16_lossy(&units)
}

/// The UTF-16 offset of a 1-based line and column.
fn offset(src: &Utf16, at: Loc) -> usize {
    let units = src.units();
    let mut line = 1;
    let mut start = 0;
    for (i, &u) in units.iter().enumerate() {
        if line == at.line {
            break;
        }
        if u == b'\n' as u16 {
            line += 1;
            start = i + 1;
        }
    }
    (start + at.col - 1).min(units.len())
}

#[cfg(test)]
mod tests {
    use super::spell_code;

    #[test]
    fn version_4_is_untouched() {
        for text in ["EXISTS(x)", "AT(r, 0)", "IF … THEN \"Yes\" ELSE \"No\" END", "AND", "if ISNULL(x) { ERROR(\"…\") }"] {
            assert_eq!(spell_code(text, 4), text);
        }
    }

    #[test]
    fn connections() {
        use super::{Connection, connection};
        let attio = Connection { adapter: "attio", args: &[("credentials", "acme"), ("dry_run", "true")], credential: Some("credentials") };
        assert_eq!(connection(&attio, 4), "attio(credentials: acme, dry_run: true)");
        assert_eq!(connection(&attio, 5), "connect attio using acme { dryRun: true }");
        assert_eq!(connection(&Connection { adapter: "kg", args: &[], credential: None }, 5), "connect kg");
        assert_eq!(super::spell_word("NOT", 4), "NOT");
        assert_eq!(super::spell_word("NOT", 5), "'!'");
        assert_eq!(super::spell_if("EXISTS(co)", 5), "if (co != null)");
    }

    #[test]
    fn suggestions_in_version_5() {
        for (old, new) in [
            ("EXISTS(channel)", "channel != null"),
            ("EXISTS(ch.`Topic`)", "ch.`Topic` != null"),
            ("ISNULL(x)", "x == null"),
            ("AT(t, 0)", "t[0]"),
            ("a: AT(r, 0)", "a: AT(r, 0)"),
            ("COALESCE(READ(f), \"\")", "coalesce(File.read(f), \"\")"),
            ("IF … THEN \"Yes\" ELSE \"No\" END", "… ? \"Yes\" : \"No\""),
            ("IF … THEN … ELSE … END", "… ? … : …"),
            ("AND", "&&"),
            ("NOT", "!"),
            ("TRUE", "true"),
            ("EXISTS(h-[:@old]->)", "exists(h-[:@old]->)"),
            ("FIRST(h-[:@old]->) == h", "first(h-[:@old]->) == h"),
            ("crm-[c:Companies WHERE LOWER(c.Name) CONTAINS \"x\"]->", "crm-[c:Companies WHERE LOWER(c.Name) CONTAINS \"x\"]->"),
            ("if ISNULL(x) { ERROR(\"…\") }", "if (x == null) { fail(\"…\") }"),
            ("if EXISTS(x) { … }", "if (x != null) { … }"),
            ("not code at all, really", "not code at all, really"),
            ("x IS <crm-[:`…` WHERE …]->>", "x is <crm-[:`…` WHERE …]->>"),
            ("await until(() => { return EXISTS(t-[:Shipment]->) }, every: 15m)", "await until(() => { return exists(t-[:Shipment]->) }, { every: 15m })"),
            ("if to != null { link a -[:e]-> to }", "if (to != null) { link a -[:e]-> to }"),
            ("COALESCE(x.`Name`, \"unknown\")", "coalesce(x.`Name`, \"unknown\")"),
        ] {
            assert_eq!(spell_code(old, 5), new, "{old}");
        }
    }
}
