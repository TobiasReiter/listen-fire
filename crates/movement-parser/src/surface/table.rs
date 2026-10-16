//! The spelling table: every built-in as the tree names it (the spelling of
//! language versions 1–4, which the checkers and engines read) beside its
//! spelling from language version 5 (plans/naming-rethink-2026-10-14/
//! 5_design.md §2). It is the one source of truth: the v5 grammar reads new
//! spellings through it, the refusals of old spellings write their fixes from
//! it, both checkers name built-ins in a program's own spelling through it,
//! and the TypeScript reads it through the WASM (`surface_table`).

use serde::Serialize;

/// How a v5 call's arguments map onto the canonical call's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Shape {
    /// The same arguments in the same order.
    Same,
    /// `map(xs, f, settings)` is `MAP(xs, settings, f)`.
    SettingsLast,
    /// `reduce(xs, f, init)` is `REDUCE(xs, init, f)`.
    ReduceOrder,
    /// `sort(xs, (r) => r.k, { order })` is ``SORT(xs, `k`, DESC)``.
    SortKey,
    /// `ai(p, { tier: t })` is `AI(p, t)`.
    AiTier,
    /// `callback(() => f(x))` is `callback(f(x))`.
    CallbackClosure,
    /// `Text.includes(t, v)` is `t CONTAINS v`.
    Contains,
    /// `List.includes(xs, v)` is `v IN xs`.
    ListIncludes,
    /// `Json.stringify(v)` is `TEXT.SERIALISE(v, "JSON")`.
    JsonStringify,
    /// No v5 call: `ISNULL(x)` is `x == null`.
    NullTest,
    /// No v5 call: `AT(xs, i)` is `xs[i]`.
    Index,
    /// `exists` takes a walk; `EXISTS(value)` is `value != null`.
    ExistsWalk,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Spelling {
    /// The built-in as the tree names it: `UPPER`, `DATE.TODAY`.
    pub canonical: &'static str,
    /// Its spelling from version 5, outside walk brackets: `Text.upper`,
    /// `map`. A v5 spelling that is not a call (`== null`, `xs[i]`) is
    /// written as the shape shows it.
    pub v5: &'static str,
    pub shape: Shape,
    /// Only the old spelling reads this row (a second old name for one new
    /// function, or a built-in whose v5 form is not a call).
    #[serde(rename = "oldOnly")]
    pub old_only: bool,
    /// Only the new spelling reads this row (a v5 function whose canonical
    /// form is an operator or another call's special case).
    #[serde(rename = "newOnly")]
    pub new_only: bool,
}

const fn row(canonical: &'static str, v5: &'static str, shape: Shape) -> Spelling {
    Spelling { canonical, v5, shape, old_only: false, new_only: false }
}

const fn old(canonical: &'static str, v5: &'static str, shape: Shape) -> Spelling {
    Spelling { canonical, v5, shape, old_only: true, new_only: false }
}

const fn new(canonical: &'static str, v5: &'static str, shape: Shape) -> Spelling {
    Spelling { canonical, v5, shape, old_only: false, new_only: true }
}

use Shape::*;

/// §2.1 core words and §2.2 namespaces, in the design's order.
pub const SPELLINGS: &[Spelling] = &[
    // Core words: always there, never qualified.
    row("MAP", "map", SettingsLast),
    row("FILTER", "filter", SettingsLast),
    row("REDUCE", "reduce", ReduceOrder),
    row("COUNT", "count", Same),
    row("FIRST", "first", Same),
    row("ONLY", "only", Same),
    row("EXISTS", "exists", ExistsWalk),
    row("COALESCE", "coalesce", Same),
    row("SORT", "sort", SortKey),
    row("MEMBERS", "members", Same),
    row("AI", "ai", AiTier),
    row("ERROR", "fail", Same),
    row("callback", "callback", CallbackClosure),
    // Text
    row("TRIM", "Text.trim", Same),
    row("LOWER", "Text.lower", Same),
    row("UPPER", "Text.upper", Same),
    row("LENGTH", "Text.length", Same),
    row("SPLIT", "Text.split", Same),
    row("CONCAT", "Text.concat", Same),
    row("JOIN", "Text.join", Same),
    row("TOSTRING", "Text.from", Same),
    row("CHUNKS", "Text.chunks", Same),
    row("TEXT.REGEX_EXTRACT", "Text.regexExtract", Same),
    row("TEXT.SLUG", "Text.slug", Same),
    row("TEXT.PAIRS", "Text.pairs", Same),
    new("CONTAINS", "Text.includes", Contains),
    // Json
    row("TEXT.SERIALISE", "Json.stringify", JsonStringify),
    // Number
    row("ABS", "Number.abs", Same),
    row("ROUND", "Number.round", Same),
    row("FLOOR", "Number.floor", Same),
    row("CEIL", "Number.ceil", Same),
    row("NUMBER", "Number.parse", Same),
    old("TONUMBER", "Number.parse", Same),
    row("NUMBER.FORMAT", "Number.format", Same),
    // Date, DateTime
    row("DATE", "Date.from", Same),
    row("DATE.PARSE", "Date.parse", Same),
    row("DATE.ADD_DAYS", "Date.addDays", Same),
    row("DATE.FORMAT", "Date.format", Same),
    row("DATE.TODAY", "Date.today", Same),
    row("DATETIME", "DateTime.from", Same),
    row("DATETIME.AT", "DateTime.at", Same),
    row("DATE.FORMAT_ISO", "DateTime.toIso", Same),
    // Currency, Url
    row("CURRENCY.GET_NUMBER_FROM_FIGURE", "Currency.numberFromFigure", Same),
    row("CURRENCY.GET_CODE_FROM_FIGURE", "Currency.codeFromFigure", Same),
    row("CURRENCY.FORMAT_FIGURE", "Currency.formatFigure", Same),
    row("URL.HOST", "Url.host", Same),
    // List
    row("SUM", "List.sum", Same),
    row("AVG", "List.avg", Same),
    row("MIN", "List.min", Same),
    row("MAX", "List.max", Same),
    row("LAST", "List.last", Same),
    row("COLLECT", "List.from", Same),
    row("MULTI", "List.compact", Same),
    row("GROUPBY", "List.groupBy", Same),
    row("KEYBY", "List.keyBy", Same),
    new("IN", "List.includes", ListIncludes),
    // File
    row("FILE", "File.from", Same),
    row("READ", "File.read", Same),
    // Not calls from version 5.
    old("ISNULL", "== null", NullTest),
    old("AT", "[]", Index),
];

/// The standard namespaces (§2.2): values that hold functions.
pub const NAMESPACES: &[&str] = &["Text", "Number", "Date", "DateTime", "Currency", "Url", "Json", "List", "File"];

/// The closed CAPS set read inside walk brackets (§4.1): each the member name
/// of one everyday function, upper-cased, namespace dropped. Any letter case.
pub const WALK_CAPS: &[(&str, &str)] = &[
    ("LOWER", "Text.lower"),
    ("UPPER", "Text.upper"),
    ("TRIM", "Text.trim"),
    ("LENGTH", "Text.length"),
    ("ABS", "Number.abs"),
    ("ROUND", "Number.round"),
    ("FLOOR", "Number.floor"),
    ("CEIL", "Number.ceil"),
    ("DATE", "Date.from"),
    ("DATETIME", "DateTime.from"),
    ("NUMBER", "Number.parse"),
    ("COALESCE", "coalesce"),
    ("EXISTS", "exists"),
];

/// Words spelled differently outside walk brackets from version 5 (§2.3).
pub const OPERATORS: &[(&str, &str)] =
    &[("AND", "&&"), ("OR", "||"), ("NOT", "!"), ("TRUE", "true"), ("FALSE", "false"), ("NULL", "null"), ("IS", "is")];

/// Statement words retired or respelled from version 5 (§2.11, §2.12).
pub const STATEMENT_WORDS: &[(&str, &str)] = &[("movement", "function")];

/// The row a v5 spelling (`Text.upper`, `map`) reads as, exactly as written.
pub fn by_v5(written: &str) -> Option<&'static Spelling> {
    SPELLINGS.iter().find(|s| !s.old_only && s.v5 == written)
}

/// The row of a built-in as the tree names it, in any letter case (versions
/// 1–4 read built-in names case-insensitively).
pub fn by_canonical(name: &str) -> Option<&'static Spelling> {
    SPELLINGS.iter().find(|s| !s.new_only && s.canonical.eq_ignore_ascii_case(name))
}

/// The name a diagnostic gives the built-in the tree calls `canonical`, in
/// the spelling of the program's own language version: `UPPER` under 4,
/// `Text.upper` under 5. A name the table does not hold is its own spelling.
pub fn spell(canonical: &str, version: u32) -> String {
    if crate::version::since(version, 5)
        && let Some(s) = by_canonical(canonical)
        && !s.old_only
    {
        return s.v5.to_string();
    }
    canonical.to_string()
}

/// Rewrites every built-in a message names (`UPPER`, `UPPER(text)`,
/// `DATE.TODAY`: a word in capitals the table holds) into the program's
/// spelling: the one place both checkers route a message through, so a
/// message's wording never carries its own copy of a spelling.
pub fn spell_message(message: &str, version: u32) -> String {
    if !crate::version::since(version, 5) {
        return message.to_string();
    }
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::with_capacity(message.len());
    let mut chars = message.char_indices().peekable();
    let mut previous: Option<char> = None;
    // Inside walk brackets (`-[c:Companies WHERE LOWER(c.Name) …]->`) a
    // built-in keeps its CAPS walk word in every version (§2.5).
    let mut walk_depth = 0usize;
    while let Some((i, c)) = chars.next() {
        let next = chars.peek().map(|&(_, d)| d);
        if c == '-' && next == Some('[') {
            walk_depth += 1;
        } else if c == ']' && walk_depth > 0 && next == Some('-') {
            walk_depth -= 1;
        }
        let starts_word = walk_depth == 0 && c.is_ascii_uppercase() && !previous.is_some_and(|p| is_word(p) || p == '.');
        if !starts_word {
            out.push(c);
            previous = Some(c);
            continue;
        }
        let mut end = i + c.len_utf8();
        while let Some(&(j, d)) = chars.peek() {
            if d.is_ascii_uppercase() || d.is_ascii_digit() || d == '_' || d == '.' {
                end = j + d.len_utf8();
                chars.next();
            } else {
                break;
            }
        }
        let next_is_word = chars.peek().is_some_and(|&(_, d)| is_word(d));
        let mut word = &message[i..end];
        let mut trailing = "";
        if let Some(stripped) = word.strip_suffix('.') {
            word = stripped;
            trailing = ".";
        }
        match by_canonical(word) {
            Some(s) if !next_is_word && s.canonical == word && !s.old_only && !s.new_only => out.push_str(s.v5),
            _ => out.push_str(word),
        }
        out.push_str(trailing);
        previous = message[..end].chars().last();
    }
    out
}

/// The table as the TypeScript reads it (`surface_table` across the WASM).
#[derive(Serialize)]
pub struct Table {
    pub spellings: &'static [Spelling],
    pub namespaces: &'static [&'static str],
    #[serde(rename = "walkCaps")]
    pub walk_caps: &'static [(&'static str, &'static str)],
    pub operators: &'static [(&'static str, &'static str)],
    #[serde(rename = "statementWords")]
    pub statement_words: &'static [(&'static str, &'static str)],
}

pub const TABLE: Table =
    Table { spellings: SPELLINGS, namespaces: NAMESPACES, walk_caps: WALK_CAPS, operators: OPERATORS, statement_words: STATEMENT_WORDS };

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_walk_word_is_its_everyday_member_upper_cased() {
        for (caps, everyday) in WALK_CAPS {
            // `DATE` is `Date.from`, `NUMBER` is `Number.parse`: a
            // conversion's walk word is its namespace (design §4.1's list
            // departs from its own member rule there).
            let member = everyday.rsplit('.').next().unwrap();
            let namespace = everyday.split('.').next().unwrap();
            assert!(member.to_ascii_uppercase() == *caps || namespace.to_ascii_uppercase() == *caps, "{caps} / {everyday}");
            assert!(by_v5(everyday).is_some(), "{everyday} has a row");
        }
    }

    #[test]
    fn no_two_new_spellings_collide() {
        let mut seen = std::collections::HashSet::new();
        for s in SPELLINGS.iter().filter(|s| !s.old_only) {
            assert!(seen.insert(s.v5), "{} twice", s.v5);
        }
    }

    #[test]
    fn spelling_follows_the_version() {
        assert_eq!(spell("UPPER", 4), "UPPER");
        assert_eq!(spell("UPPER", 5), "Text.upper");
        assert_eq!(spell("date.today", 5), "Date.today");
        assert_eq!(spell("my_function", 5), "my_function");
        assert_eq!(spell_message("`UPPER(x)` expects text; `MAP` too", 5), "`Text.upper(x)` expects text; `map` too");
        assert_eq!(spell_message("`UPPER(x)` expects text", 4), "`UPPER(x)` expects text");
        assert_eq!(spell_message("`Name` is not `AT`", 5), "`Name` is not `AT`");
        assert_eq!(spell_message("UPPER's 'text' takes text — UPPER(text)", 5), "Text.upper's 'text' takes text — Text.upper(text)");
        assert_eq!(spell_message("DATE.TODAY needs a zone. MAPPED UPPERCASE COUNT.", 5), "Date.today needs a zone. MAPPED UPPERCASE count.");
        assert_eq!(
            spell_message("`COUNT(crm-[c:Companies WHERE LOWER(c.Name) == \"x\"]->)` and LOWER", 5),
            "`count(crm-[c:Companies WHERE LOWER(c.Name) == \"x\"]->)` and Text.lower"
        );
    }
}
