//! The statement grammar. Ported read for read from the TypeScript grammar it
//! replaced; every message, offset and backtrack that grammar had is pinned by
//! the programs corpus (tests/programs.rs), and the comments below that say
//! "as the TypeScript …" name a behaviour kept for that reason.
//!
//! Hand-rolled, line-oriented recursive descent. Statements and `field: expr`
//! entries are newline-terminated; termination is suspended inside
//! unbalanced ( ) [ ] { }, inside double-quoted strings (which may span
//! newlines and carry ${…} interpolation), and inside backtick-quoted names.
//! `#` starts a comment to end of line, outside strings and backticks, at any
//! bracket depth except directly inside a hop's brackets (`-[#linked]->`).
//! Expression positions are NOT parsed here: they are captured verbatim as
//! `ExprSlot`s for the expression grammar.
//!
//! The source is read as UTF-16 code units, so every offset, slice and
//! column is the one the TypeScript computes on a JavaScript string.

use std::collections::HashSet;

use crate::ast::*;
use crate::lexer::{KEYWORDS, MAX_DEPTH, TOO_DEEP};
use crate::scan::{
    Opaque, OpaqueKind, TooDeep, call_style_if_message, ident_end, is_closer, is_opener, opens_hop, scan_backtick_name,
    scan_ident, scan_member_path, scan_name, skip_opaque, skip_string,
};
use crate::util::utf16::{Utf16, is_ident_char, is_ident_start, is_js_space, to_string, trim, trim_end, trim_start};
use crate::version::{before, since};

/// `MovementParseError`: the BASE message (the TypeScript class appends
/// ` (line N, col M)`) and the point it refers to.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ParseError {
    pub message: String,
    pub loc: Loc,
}

pub type SResult<T> = Result<T, ParseError>;

/// The statement forms that ACT. None of them is an expression, so none can
/// appear as a node-literal entry — this list exists to say that by name
/// (a node literal is effect-free) rather than by syntax error.
const NODE_ENTRY_EFFECTS: [&str; 10] =
    ["write", "match", "link", "unlink", "delete", "extract", "await", "race", "parallel", "callback"];

const LAZY_AWAIT: &str = "'lazy await' can't be both: 'await' waits for the edge to resolve and continues the run there, 'lazy' waits to look until something reads. Pick the one you meant";

const ELVIS_MISUSE: &str = "`?:` is the set-if-empty write-field marker (`Field ?: value`), only valid inside a write body — for a value fallback use `COALESCE(a, b)`; to branch, use an `if` block";

const ASK_STATEMENT_REPLACED: &str = "the `ask` statement was replaced by the ask adapter — construct `ask()`, write the question along a family edge (Check / Provide / Choose / Select / Review / Correct / Draft / Form), then `await` its Response:  asks = ask(); q = write asks-[:Check]-> { Prompt: \"Ship it?\" }; answer = await q-[:Response]->.  For a timeout or escalation, `race` the await against `await sleep(…)` (and a re-delivery branch); the delivery link is the record's readable `Url` field.";

const FALLBACK_RUNG_REPLACED: &str = "a `fallback` rung has no meaning without an `ask` statement, and `ask` was replaced by the ask adapter — express a timeout or escalation by `race`-ing the `await` of the ask's Response against `await sleep(…)` (a losing branch may re-deliver or `ERROR(\"…\")`):  race({ answer = await q-[:Response]-> }, { await sleep(4h); write …re-deliver… }).";

const SLEEP_STATEMENT_REPLACED: &str = "the `sleep` statement was replaced — await it as an expression: `await sleep(4h)`; as a race arm: `await race([q, () => { await sleep(4h) }])`.";

const PARALLEL_BLOCK_RETIRED: &str = "the `parallel { … }` block was replaced by the parallel combinator, which takes its arms as functions and hands back one slot per arm: `r = await parallel([() => { … }, () => { … }])`. An arm that only acts needs no binding: `await parallel([() => { … }, () => { … }])`.";

const RACE_BRANCHES_RETIRED: &str = "a race takes FUNCTIONS, not brace branches: `r = await race([q, () => { await sleep(4h) }])`. The value is one slot per arm, in the order written — the winner's slot holds what its function returned and every other slot is null, so a timeout is `AT(r, 1) != null`.";

/// Under language version 5 `parallel` is retired too, so the rewrite these
/// refusals offer is the `all` that replaced it.
const PARALLEL_AS_ALL: &str = "the join is `all`, which takes its functions as arguments (language version 5): `r = all(() => { … }, () => { … })` — no `await`; one slot per function, in order. One that only acts needs no binding: `all(f, g)`.";

/// Language version 5's race: the arms are arguments, and no `await`.
const RACE_BRANCHES_RETIRED_V5: &str = "a race takes FUNCTIONS as its arguments, not brace branches: `r = race(q, () => { await sleep(4h) })`. The value is one slot per arm, in the order written — the winner's slot holds what its function returned and every other slot is null, so a timeout is `AT(r, 1) != null`.";

const ALL_RETIRED: &str =
    "`all` was replaced by `parallel` — parallel implies all, and all does not imply parallel: `r = await parallel([f, g])`.";

const UNTIL_CADENCE_IS_NAMED: &str = "'until' takes its cadence by name: `await until(<condition>, every: 5m)`. There is no second positional argument — a value to wait FOR is an equality in the condition itself (`await until(a.state == \"done\", every: 5m)`).";

fn type_values_are_text(name: &str) -> String {
    format!(
        "'{name}' is a refinement of text, so each of its values is written as text: `type {name} = <\"A\" | \"B\">`. To type a field as a number or a date, annotate it with that type directly (`<number>`, `<date>`)."
    )
}

/// Spec examples elide statement bodies with a bare ellipsis; accepted as a no-op.
const ELISION: u16 = 0x2026;

fn unit(c: char) -> u16 {
    c as u16
}

fn in_set(c: u16, set: &str) -> bool {
    c < 0x80 && set.as_bytes().contains(&(c as u8))
}

fn utf16_len(text: &str) -> usize {
    crate::util::form::utf16_len(text)
}

fn closer_of(open: u16) -> u16 {
    match open {
        0x28 => unit(')'),
        0x5B => unit(']'),
        _ => unit('}'),
    }
}

/// A name re-spelled as source text: bare when it scans as an identifier,
/// backtick-quoted otherwise (ast.ts `spellName`).
fn spell_name(name: &str) -> String {
    let units: Vec<u16> = crate::util::form::units_vec(name);
    if ident_end(&units, 0) == Some(units.len()) { name.to_string() } else { format!("`{name}`") }
}

/// A path ROOT re-spelled as source text (ast.ts `spellPathRoot`).
fn spell_path_root(root: &PathRoot) -> String {
    match root {
        PathRoot::Name { name } => spell_name(name),
        PathRoot::Expression { expr } => expr.raw.clone(),
    }
}

/// The name a member-path root binds for its write (ast.ts
/// `memberPathBindingName`): the path's names joined, or `None` for a root
/// that is not one member path.
fn member_path_binding_name(expr: &ExprSlot) -> Option<String> {
    let units: Vec<u16> = crate::util::form::units_vec(&expr.raw);
    let raw = trim(&units);
    let (names, end) = scan_member_path(raw, 0)?;
    (end == raw.len()).then(|| names.join("."))
}

/// The bare name a WHERE-less single hop lands on (`-[:company]->`; an alias
/// is tolerated), or `None` for anything pinned or longer — the TypeScript
/// regex `^-\[\s*(?:IDENT\s*)?:\s*(`[^`]+`|IDENT)\s*\]->$` over the trimmed
/// hop, matched by hand.
fn unpinned_hop_name(hop_raw: &str) -> Option<String> {
    let units: Vec<u16> = crate::util::form::units_vec(hop_raw);
    let s = trim(&units);
    let at = |i: usize| s.get(i).copied();
    let skip_space = |mut i: usize| {
        while at(i).is_some_and(is_js_space) {
            i += 1;
        }
        i
    };
    if at(0) != Some(unit('-')) || at(1) != Some(unit('[')) {
        return None;
    }
    let mut i = skip_space(2);
    if let Some(alias_end) = ident_end(s, i) {
        let k = skip_space(alias_end);
        if at(k) == Some(unit(':')) {
            i = k;
        }
    }
    if at(i) != Some(unit(':')) {
        return None;
    }
    i = skip_space(i + 1);
    let name = if at(i) == Some(unit('`')) {
        let close = s.iter().skip(i + 1).position(|&u| u == unit('`'))? + i + 1;
        if close == i + 1 {
            return None;
        }
        let name = to_string(&s[i + 1..close]);
        i = close + 1;
        name
    } else {
        let end = ident_end(s, i)?;
        let name = to_string(&s[i..end]);
        i = end;
        name
    };
    i = skip_space(i);
    (s.get(i..)? == crate::util::form::units_vec("]->").as_slice()).then_some(name)
}

/// The name of a collection op (or `MEMBERS`) written at the head of an
/// expression slot — `/^\s*([A-Z]+)\s*\(/` — a form that is a statement,
/// not a value.
fn nested_collection_value(raw: &str) -> Option<String> {
    let units: Vec<u16> = crate::util::form::units_vec(raw);
    let mut i = 0;
    while units.get(i).copied().is_some_and(is_js_space) {
        i += 1;
    }
    let head_start = i;
    while units.get(i).is_some_and(|&u| (unit('A')..=unit('Z')).contains(&u)) {
        i += 1;
    }
    if i == head_start {
        return None;
    }
    let head = to_string(&units[head_start..i]);
    while units.get(i).copied().is_some_and(is_js_space) {
        i += 1;
    }
    if units.get(i) != Some(&unit('(')) {
        return None;
    }
    (head == "MEMBERS" || CollectionOp::from_spelling(&head).is_some()).then_some(head)
}

/// The prose `scanBalanced` reports with, and where it stops.
struct Scan<'s> {
    /// Characters that end the scan at top level (not consumed).
    stops: &'s str,
    /// The scan may end at end-of-file (only when nothing is left open).
    allow_eof: bool,
    /// `#`-comments are recognised at top level (off inside hop interiors).
    comments: bool,
    context: String,
}

impl<'s> Scan<'s> {
    fn new(stops: &'s str, context: impl Into<String>) -> Self {
        Self { stops, allow_eof: false, comments: true, context: context.into() }
    }

    fn eof_ok(mut self) -> Self {
        self.allow_eof = true;
        self
    }

    fn no_comments(mut self) -> Self {
        self.comments = false;
        self
    }
}

/// What `scanBalanced` stopped at: a stop character, or `None` at the end.
type Stop = Option<u16>;

#[derive(Default, Clone, Copy)]
struct MarkerOptions {
    allow_hops: bool,
    allow_field_tail: bool,
    allow_null: bool,
}

const HOPS: MarkerOptions = MarkerOptions { allow_hops: true, allow_field_tail: false, allow_null: false };
const FIELD_TAIL: MarkerOptions = MarkerOptions { allow_hops: false, allow_field_tail: true, allow_null: false };
const FIELD_TAIL_NULL: MarkerOptions = MarkerOptions { allow_hops: false, allow_field_tail: true, allow_null: true };
const PLAIN: MarkerOptions = MarkerOptions { allow_hops: false, allow_field_tail: false, allow_null: false };

struct Marker {
    text: String,
    hops_raw: Option<String>,
    position: Option<String>,
    nullable: bool,
    span: Span,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Finder {
    Write,
    Match,
    Link,
}

impl Finder {
    fn word(self) -> &'static str {
        match self {
            Finder::Write => "write",
            Finder::Match => "match",
            Finder::Link => "link",
        }
    }
}

pub struct Parser {
    src: Utf16,
    pos: usize,
    line_starts: Vec<usize>,
    /// Read by the `since`/`before` conditionals where the grammar differs.
    version: u32,
    /// Where `src` starts in the file, when it is a slot's text rather than
    /// the whole file — so every span read from it is the file's.
    origin: Loc,
    /// Mark every slot for the eager export (see `ExprSlot::eager`).
    eager: bool,
    /// Recursion depth, bounded by `MAX_DEPTH` for the same two stacks the
    /// expression grammar guards.
    depth: usize,
    /// The local names imported from adapters so far: from version 5 setting
    /// one up is `connect`, and its old construction is refused.
    adapters: Vec<String>,
}

impl Parser {
    pub fn new(source: &str, version: u32, origin: Loc, eager: bool) -> Self {
        let src = Utf16::new(source);
        let mut line_starts = vec![0];
        for (i, &u) in src.units().iter().enumerate() {
            if u == unit('\n') {
                line_starts.push(i + 1);
            }
        }
        Self { src, pos: 0, line_starts, version, origin, eager, depth: 0, adapters: Vec::new() }
    }

    /// `parseNestedCall`'s reading: one call from `start` to the end of the
    /// text — the extraction call, or any other callee's call.
    pub fn parse_nested_call_value(&mut self, start: usize) -> SResult<RValue> {
        self.pos = start;
        let value = if self.at_extract_call() {
            RValue::ExtractCall { extract_call: self.parse_extract_call(start)? }
        } else {
            let callee = self.read_name("the name being called")?;
            self.skip_inline_ws();
            self.expect("(", &format!("to open the call to '{callee}'"))?;
            let args = self.parse_call_args(&callee, start)?;
            RValue::Call { call: self.call_node(callee, args, start) }
        };
        self.skip_all_ws();
        if !self.eof() {
            return self.fail(format!("Expected the call to end here, found {}", self.describe_here()));
        }
        Ok(value)
    }

    pub fn parse_program(&mut self) -> SResult<Program> {
        let mut statements = Vec::new();
        loop {
            self.skip_all_ws();
            if self.eof() {
                return Ok(Program { statements, spelling: Vec::new() });
            }
            if self.peek() == Some(ELISION) {
                self.pos += 1;
                continue;
            }
            statements.push(self.parse_statement()?);
        }
    }

    // ── Source primitives ──

    fn eof(&self) -> bool {
        self.pos >= self.src.len()
    }

    fn peek(&self) -> Option<u16> {
        self.src.at(self.pos)
    }

    fn is(&self, c: char) -> bool {
        self.peek() == Some(unit(c))
    }

    fn is_at(&self, offset: usize, c: char) -> bool {
        self.src.at(self.pos + offset) == Some(unit(c))
    }

    fn starts_with(&self, text: &str) -> bool {
        self.src.starts_with(self.pos, text)
    }

    fn starts_hop(&self) -> bool {
        self.is('-') && self.is_at(1, '[')
    }

    fn text(&self, start: usize, end: usize) -> String {
        self.src.text(start, end)
    }

    fn loc_at(&self, offset: usize) -> Loc {
        let mut lo = 0;
        let mut hi = self.line_starts.len() - 1;
        while lo < hi {
            let mid = (lo + hi + 1) >> 1;
            if self.line_starts[mid] <= offset {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        let col = offset - self.line_starts[lo] + 1;
        if lo == 0 {
            Loc { line: self.origin.line, col: self.origin.col + col - 1 }
        } else {
            Loc { line: self.origin.line + lo, col }
        }
    }

    fn span_from(&self, start: usize) -> Span {
        self.span_between(start, self.pos)
    }

    fn span_between(&self, start: usize, end: usize) -> Span {
        Span { start: self.loc_at(start), end: self.loc_at(end) }
    }

    fn slot(&self, raw: String, span: Span) -> ExprSlot {
        if since(self.version, 5) {
            for finding in crate::surface::slot_findings(&raw, span.start) {
                crate::surface::report(finding);
            }
        }
        ExprSlot { raw, span, eager: self.eager }
    }

    /// An old spelling under version 5 at `start..end`, and its rewrite as
    /// edits (offsets into this parser's text).
    fn spelling(&self, message: impl Into<String>, start: usize, end: usize, edits: Vec<(usize, usize, String)>) {
        use crate::surface::{Fix, SPELLING_CODE, SourceEdit, SpellingFinding};
        let fix = (!edits.is_empty()).then(|| Fix {
            edits: edits.into_iter().map(|(s, e, text)| SourceEdit { span: self.span_between(s, e), text }).collect(),
        });
        crate::surface::report(SpellingFinding { code: SPELLING_CODE.into(), message: message.into(), span: self.span_between(start, end), fix });
    }

    /// From version 5 an `if` condition is parenthesised, as TypeScript's.
    fn require_condition_parens(&self, condition: &ExprSlot, start: usize, end: usize) {
        if !since(self.version, 5) {
            return;
        }
        let whole = |t: &crate::tree::MExpr| t.at().start == 0 && t.at().end == crate::util::form::utf16_len(&condition.raw);
        match crate::expr::parse_expression_raw(&condition.raw) {
            Ok(tree @ crate::tree::MExpr::Paren { .. }) if whole(&tree) => {}
            Ok(_) => self.spelling(
                "from language version 5 an `if` condition is parenthesised: `if (…) {`",
                start,
                end,
                vec![(start, start, "(".into()), (end, end, ")".into())],
            ),
            Err(_) => {}
        }
    }

    fn fail<T>(&self, message: impl Into<String>) -> SResult<T> {
        self.fail_at(message, self.pos)
    }

    fn fail_at<T>(&self, message: impl Into<String>, offset: usize) -> SResult<T> {
        Err(ParseError { message: message.into(), loc: self.loc_at(offset) })
    }

    fn describe_here(&self) -> String {
        if self.eof() {
            return "end of file".into();
        }
        if self.is('\n') {
            return "end of line".into();
        }
        if let Some(id) = self.peek_ident() {
            return format!("'{id}'");
        }
        format!("'{}'", self.src.char_text(self.pos))
    }

    /// One level deeper in the grammar's recursion, refused past `MAX_DEPTH`.
    fn deeper<T>(&mut self, f: impl FnOnce(&mut Self) -> SResult<T>) -> SResult<T> {
        if self.depth >= MAX_DEPTH {
            return self.fail(TOO_DEEP);
        }
        self.depth += 1;
        let result = f(self);
        self.depth -= 1;
        result
    }

    /// Spaces, tabs, and `#`-comments — never crosses a newline.
    fn skip_inline_ws(&mut self) {
        loop {
            if self.is(' ') || self.is('\t') || self.is('\r') {
                self.pos += 1;
            } else if self.is('#') {
                while !self.eof() && !self.is('\n') {
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    /// All whitespace including newlines, plus `#`-comments.
    fn skip_all_ws(&mut self) {
        loop {
            if self.is(' ') || self.is('\t') || self.is('\r') || self.is('\n') {
                self.pos += 1;
            } else if self.is('#') {
                while !self.eof() && !self.is('\n') {
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    fn peek_ident(&self) -> Option<String> {
        scan_ident(self.src.units(), self.pos).map(|(name, _)| name)
    }

    /// `this.peekIdent() === word`.
    fn at_word(&self, word: &str) -> bool {
        ident_end(self.src.units(), self.pos) == Some(self.pos + word.len()) && self.starts_with(word)
    }

    fn read_ident(&mut self, what: &str) -> SResult<String> {
        let Some(id) = self.peek_ident() else {
            return self.fail(format!("Expected {what}, found {}", self.describe_here()));
        };
        self.pos += id.len();
        Ok(id)
    }

    /// A NAME — bare when the exposed name is identifier-safe, backtick-quoted
    /// otherwise. Returns the name verbatim (backticks stripped).
    fn read_name(&mut self, what: &str) -> SResult<String> {
        if self.is('`') {
            return self.read_backtick_name();
        }
        self.read_ident(what)
    }

    fn try_consume(&mut self, text: &str) -> bool {
        if self.starts_with(text) {
            self.pos += utf16_len(text);
            return true;
        }
        false
    }

    fn expect(&mut self, text: &str, context: &str) -> SResult<()> {
        if !self.try_consume(text) {
            return self.fail(format!("Expected '{text}' {context}, found {}", self.describe_here()));
        }
        Ok(())
    }

    fn expect_word(&mut self, word: &str, context: &str) -> SResult<()> {
        if !self.at_word(word) {
            return self.fail(format!("Expected '{word}' {context}, found {}", self.describe_here()));
        }
        self.pos += word.len();
        Ok(())
    }

    /// One dotted identifier path (`crm`, `inbox.message`) — the interior
    /// spelling of every type.
    fn read_dotted_path(&mut self, what: &str) -> SResult<String> {
        let mut path = self.read_name(what)?;
        while self.is('.') {
            self.pos += 1;
            let segment = self.read_name(&format!("a path segment after '{path}.'"))?;
            path = format!("{path}.{segment}");
        }
        Ok(path)
    }

    /// A type slot: types ALWAYS wear angle brackets. A bare spelling errors
    /// with the bracketed fix-it; the dotted form is retired for edges.
    fn read_type_marker(&mut self, context: &str, options: MarkerOptions) -> SResult<Marker> {
        let start = self.pos;
        if !self.is('<') {
            if self.peek_ident().is_some() {
                self.read_dotted_path("a type")?;
                let raw = self.text(start, self.pos);
                let segments: Vec<&str> = raw.split('.').collect();
                if segments.len() == 1 {
                    return self.fail_at(
                        format!("Types are written in angle brackets — wrap the type in angle brackets: <{raw}>"),
                        start,
                    );
                }
                // A bare DOTTED spelling has two fixes stacked (brackets, and
                // the retired dot-for-an-edge) — the fix-it lands on the
                // valid spelling in one hop.
                let tail: String = segments[2..]
                    .iter()
                    .map(|segment| if segment.starts_with('`') { format!(".{segment}") } else { format!(".`{segment}`") })
                    .collect();
                return self.fail_at(
                    format!(
                        "Types are written in angle brackets, and '.' reads a property — write it as: <{}-[:{}]->{tail}>",
                        segments[0], segments[1]
                    ),
                    start,
                );
            }
            return self.fail(format!("Expected a type in angle brackets {context}, found {}", self.describe_here()));
        }
        self.pos += 1;
        self.skip_inline_ws();
        let root_start = self.pos;
        let root = self.read_name(&format!("a type name inside '<…>' {context}"))?;
        if root == "null" {
            return self.fail_at(
                "'null' is not a type on its own — it only marks an extraction field that may be missing, after the field's type: `name: <text | null> \"…\"`",
                root_start,
            );
        }
        if self.is('.') {
            let root_raw = self.text(root_start, self.pos);
            return Err(self.retired_dotted_type(&root, root_raw, start, options));
        }
        self.skip_inline_ws();
        if self.starts_hop() {
            if options.allow_field_tail {
                let text = self.read_borrowed_field_tail(&root, context)?;
                let nullable = self.read_null_suffix(&format!("{root}-[:…]->.…"), options.allow_null)?;
                self.expect(">", &format!("to close the type '<{root}-[:…]->.…'"))?;
                return Ok(Marker { text, hops_raw: None, position: None, nullable, span: self.span_from(start) });
            }
            let (hops_raw, position) = self.read_type_address_hops(&root, context, options.allow_hops)?;
            self.read_null_suffix(&format!("{root}{hops_raw}"), false)?;
            self.expect(">", &format!("to close the type '<{root}'"))?;
            return Ok(Marker {
                text: root,
                hops_raw: Some(hops_raw),
                position,
                nullable: false,
                span: self.span_from(start),
            });
        }
        let nullable = self.read_null_suffix(&root, options.allow_null)?;
        self.expect(">", &format!("to close the type '<{root}'"))?;
        Ok(Marker { text: root, hops_raw: None, position: None, nullable, span: self.span_from(start) })
    }

    /// `<text | null>` — an extraction field that may be missing. Only a
    /// field's annotation takes it, and only the one spelling.
    fn read_null_suffix(&mut self, type_text: &str, allow_null: bool) -> SResult<bool> {
        let mark = self.pos;
        self.skip_inline_ws();
        if !self.is('|') {
            self.pos = mark;
            return Ok(false);
        }
        let bar_start = self.pos;
        self.pos += 1;
        self.skip_inline_ws();
        let member_start = self.pos;
        let member = self.peek_ident();
        if member.as_deref() != Some("null") {
            return self.fail_at(
                if member.as_deref() == Some("absent") {
                    format!("Write a field that may be missing as <{type_text} | null> — 'null' is the spelling, not 'absent'")
                } else {
                    format!(
                        "Only '| null' may follow a type in angle brackets — a field that may be missing is <{type_text} | null>; a closed set of values is declared as its own type (`type Thesis = <\"A\" | \"B\">`)"
                    )
                },
                member_start,
            );
        }
        if !allow_null {
            return self.fail_at(
                format!(
                    "'<{type_text} | null>' is written only on an extraction field's annotation (`name: <text | null> \"…\"`) or a declared node's field (`name: <text | null>`) — nowhere else does a type take '| null'"
                ),
                bar_start,
            );
        }
        self.pos += "null".len();
        self.skip_inline_ws();
        if self.is('|') {
            return self.fail(format!("A field annotation takes one '| null' and nothing more: <{type_text} | null>"));
        }
        Ok(true)
    }

    /// The retired `<inst.Type>` / `<inst.root.field>` spelling: the error
    /// carrying the exact replacement for what the author wrote.
    fn retired_dotted_type(&mut self, root: &str, root_raw: String, marker_start: usize, options: MarkerOptions) -> ParseError {
        let mut raw_segments = vec![root_raw];
        while self.is('.') {
            self.pos += 1;
            let segment_start = self.pos;
            if let Err(e) = self.read_name("a path segment after '.'") {
                return e;
            }
            raw_segments.push(self.text(segment_start, self.pos));
        }
        let wrote = format!("<{}>", raw_segments.join("."));
        let backticked_tail = |raw: &str| if raw.starts_with('`') { raw.to_string() } else { format!("`{raw}`") };
        let message = if raw_segments.len() == 2 {
            let address = format!("<{root}-[:{}]->>", raw_segments[1]);
            format!("'.' reads a property — a type names an EDGE, and an edge is an address. Write '{address}' instead of '{wrote}'.")
        } else if options.allow_field_tail {
            let tail: String = raw_segments[2..].iter().map(|raw| format!(".{}", backticked_tail(raw))).collect();
            let borrowed = format!("<{root}-[:{}]->{tail}>", raw_segments[1]);
            format!("'.' reads a property — the middle of a borrowed type is an EDGE. Write '{borrowed}' instead of '{wrote}'.")
        } else {
            format!("'.' reads a property — a type is a single name or an address ('<{root}-[:…]->>'), got '{wrote}'")
        };
        ParseError { message, loc: self.loc_at(marker_start) }
    }

    /// The ADDRESS form's hop chain inside a type marker — the same `scan_hop`
    /// the traversal grammar uses. An UNPINNED single hop also yields
    /// `position`.
    fn read_type_address_hops(&mut self, text: &str, context: &str, allow_hops: bool) -> SResult<(String, Option<String>)> {
        if !allow_hops {
            return self.fail(format!(
                "A type address ('<{text}-[:…]->>') doesn't fit here — {context} names a single type, e.g. <{text}>"
            ));
        }
        let hops_start = self.pos;
        let mut hops = 0;
        loop {
            self.scan_hop()?;
            hops += 1;
            let after_hop = self.pos;
            self.skip_inline_ws();
            if !self.starts_hop() {
                self.pos = after_hop;
                break;
            }
        }
        let hops_raw = self.text(hops_start, self.pos);
        let position = if hops == 1 { unpinned_hop_name(&hops_raw) } else { None };
        Ok((hops_raw, position))
    }

    /// A borrowed field type: `<crm-[:companies]->.\`funding_stage\`>`, stored
    /// as the resolver's `<instance>.<root>.<field>` segments.
    fn read_borrowed_field_tail(&mut self, root: &str, context: &str) -> SResult<String> {
        self.expect("-[", "to begin the borrowed type’s edge")?;
        self.skip_inline_ws();
        self.expect(":", "after '-[' in the borrowed type")?;
        self.skip_inline_ws();
        let edge = self.read_name(&format!("the borrowed root name {context}"))?;
        self.skip_inline_ws();
        self.expect("]", &format!("after the borrowed root '{edge}'"))?;
        self.expect("->", "to complete the borrowed type’s edge")?;
        if !self.is('.') {
            return self.fail(format!(
                "A borrowed type names a FIELD — add the property tail: <{root}-[:{edge}]->.`field`>"
            ));
        }
        self.pos += 1;
        let field = self.read_name(&format!("the borrowed field name {context}"))?;
        Ok(format!("{root}.{edge}.{field}"))
    }

    /// A backtick-quoted name (single line).
    fn read_backtick_name(&mut self) -> SResult<String> {
        let start = self.pos;
        let Some((name, close)) = scan_backtick_name(self.src.units(), start) else {
            return self.fail_at("Unterminated backtick-quoted name — expected a closing '`'", start);
        };
        self.pos = close + 1;
        Ok(name)
    }

    /// Consumes a complete string (may span newlines; a double-quoted one's
    /// `${…}` is a balanced region).
    fn scan_string(&mut self) -> SResult<()> {
        match skip_string(self.src.units(), self.pos, self.src.len()) {
            Ok(Some(end)) => {
                self.pos = end;
                Ok(())
            }
            Ok(None) => self.unterminated(false, self.pos),
            Err(TooDeep) => self.fail(TOO_DEEP),
        }
    }

    fn unterminated<T>(&self, name: bool, start: usize) -> SResult<T> {
        let (what, shown) = if name {
            ("backtick-quoted name", "'`'".to_string())
        } else if self.src.at(start) == Some(unit('\'')) {
            ("string", "\"'\"".to_string())
        } else {
            ("string", "'\"'".to_string())
        };
        self.fail_at(format!("Unterminated {what} — expected a closing {shown}"), start)
    }

    fn read_quoted_string(&mut self, context: &str) -> SResult<(String, Span)> {
        if !self.is('"') {
            return self.fail(format!("Expected a double-quoted string {context}, found {}", self.describe_here()));
        }
        let start = self.pos;
        self.scan_string()?;
        Ok((self.text(start + 1, self.pos - 1), self.span_from(start)))
    }

    /// The same double-quoted string, read as an ordinary expression slot:
    /// the literal WITH its quotes.
    fn read_string_slot(&mut self, context: &str) -> SResult<ExprSlot> {
        if !self.is('"') {
            return self.fail(format!("Expected a double-quoted string {context}, found {}", self.describe_here()));
        }
        let start = self.pos;
        self.scan_string()?;
        Ok(self.slot(self.text(start, self.pos), self.span_from(start)))
    }

    /// The core raw scanner: advances until one of `stops` appears at top
    /// level — outside ( ) [ ] { } nesting, strings, backtick names, and an
    /// open value-level `IF … END`. The stop is not consumed. Returns the stop
    /// and where meaningful content ended (trailing whitespace and comments
    /// excluded).
    fn scan_balanced(&mut self, options: &Scan) -> SResult<(Stop, usize)> {
        let mut brackets: Vec<(u16, usize, bool)> = Vec::new();
        // An `IF` may span lines; `ELSE IF` continues a chain one END closes,
        // so only an `IF` not after `ELSE` opens a level.
        let mut if_depth = 0usize;
        let mut prev_else = false;
        let mut content_end = self.pos;
        while let Some(c) = self.peek() {
            if brackets.is_empty() && if_depth == 0 && in_set(c, options.stops) {
                return Ok((Some(c), content_end));
            }
            let in_hop = match brackets.last() {
                None => !options.comments,
                Some(&(_, _, hop)) => hop,
            };
            match skip_opaque(self.src.units(), self.pos, in_hop, self.src.len()) {
                Ok(Some(Opaque::Skipped { kind, end })) => {
                    self.pos = end;
                    if kind != OpaqueKind::Comment {
                        content_end = self.pos;
                    }
                    prev_else = false;
                    continue;
                }
                Ok(Some(Opaque::Unterminated { name, start })) => return self.unterminated(name, start),
                Err(TooDeep) => return self.fail(TOO_DEEP),
                Ok(None) => {}
            }
            if is_opener(c) {
                brackets.push((c, self.pos, opens_hop(self.src.units(), self.pos, self.src.len())));
                self.pos += 1;
                content_end = self.pos;
                prev_else = false;
                continue;
            }
            if is_closer(c) {
                let ch = to_string(&[c]);
                let Some((open, offset, _)) = brackets.pop() else {
                    return self.fail(format!("Unbalanced '{ch}' in {}", options.context));
                };
                let want = closer_of(open);
                if c != want {
                    let open_loc = self.loc_at(offset);
                    return self.fail(format!(
                        "Expected '{}' to close the '{}' opened at line {}, col {} — found '{ch}'",
                        to_string(&[want]),
                        to_string(&[open]),
                        open_loc.line,
                        open_loc.col
                    ));
                }
                self.pos += 1;
                content_end = self.pos;
                prev_else = false;
                continue;
            }
            // `?:` is never valid in expression text — it is the write-body
            // marker reached for outside a write body.
            if c == unit('?') && self.is_at(1, ':') {
                return self.fail(ELVIS_MISUSE);
            }
            // Identifiers are consumed whole so `IF`/`END` never match inside
            // a longer word (`notify`, `endpoint`).
            if brackets.is_empty() && is_ident_start(c) {
                let word_start = self.pos;
                while self.peek().is_some_and(is_ident_char) {
                    self.pos += 1;
                }
                let word = self.text(word_start, self.pos);
                if word == "IF" {
                    let mut after = self.pos;
                    while self.src.at(after).is_some_and(|u| u == unit(' ') || u == unit('\t')) {
                        after += 1;
                    }
                    if let Some(message) = call_style_if_message(self.src.units(), after) {
                        return self.fail_at(message, word_start);
                    }
                }
                if word == "IF" && !prev_else {
                    if_depth += 1;
                } else if word == "END" && if_depth > 0 {
                    if_depth -= 1;
                }
                prev_else = word == "ELSE";
                content_end = self.pos;
                continue;
            }
            if !is_js_space(c) {
                content_end = self.pos + 1;
                prev_else = false;
            }
            self.pos += 1;
        }
        if let Some(&(open, offset, _)) = brackets.last() {
            return self.fail_at(
                format!(
                    "Unbalanced '{}' — no matching '{}' before end of file",
                    to_string(&[open]),
                    to_string(&[closer_of(open)])
                ),
                offset,
            );
        }
        if options.allow_eof {
            return Ok((None, content_end));
        }
        self.fail(format!("Unexpected end of file in {}", options.context))
    }

    /// Captures a raw expression span (trimmed) for the expression grammar.
    fn read_expr_slot(&mut self, options: Scan) -> SResult<(ExprSlot, Stop)> {
        if options.stops.contains('\n') {
            self.skip_inline_ws();
        } else {
            self.skip_all_ws();
        }
        let start = self.pos;
        let (stop, content_end) = self.scan_balanced(&options)?;
        if content_end <= start {
            return self.fail_at(format!("Expected an expression {}", options.context), start);
        }
        Ok((self.slot(self.text(start, content_end), self.span_between(start, content_end)), stop))
    }

    // ── Statements ──

    fn parse_statement(&mut self) -> SResult<Statement> {
        self.deeper(Self::parse_statement_here)
    }

    fn parse_statement_here(&mut self) -> SResult<Statement> {
        let start = self.pos;
        if self.starts_hop() {
            return Ok(Statement::Block(self.parse_traversal_block_statement()?));
        }
        // A backticked token is always a NAME, never a keyword.
        if self.is('`') {
            let name = self.read_backtick_name()?;
            return self.parse_identifier_led_statement(name, start, true);
        }
        let Some(word) = self.peek_ident() else {
            return self.fail(format!("Unexpected {} — expected a statement", self.describe_here()));
        };
        if self.at_extract_call() {
            return self.fail_at(
                format!(
                    "An extraction hands back what it found, so it is bound to a name (or returned) — write `found = {word}(content, Shape)`"
                ),
                start,
            );
        }
        match word.as_str() {
            "import" => return Ok(Statement::Import(self.parse_import()?)),
            "export" => return self.parse_export(),
            "shape" => {
                return self.fail_at(
                    "'shape' is not a statement — a declaration IS the record it describes, so declare it as a node: `node <name> { title: <text>  node <edge name> { … } }`, and type a parameter against it with `<name>`",
                    start,
                );
            }
            "node" => {
                if self.at_node_literal() {
                    return self.fail_at(
                        "a `node { … }` literal builds a record — bind it (`deal = node { … }`) or pass it as an argument. To DECLARE the structure a parameter is checked against, name it: `node <name> { title: <text> }`",
                        start,
                    );
                }
                if self.at_node_declaration() {
                    return Ok(Statement::Shape(self.parse_node_declaration()?));
                }
            }
            "type" => {
                if self.at_type_declaration() {
                    return Ok(Statement::Type(self.parse_type_declaration()?));
                }
            }
            "movement" | "function" => return Ok(Statement::Movement(self.parse_movement(&word)?)),
            "listen" => return Ok(Statement::Listen(self.parse_listen()?)),
            "run" => {
                return self.fail_at(
                    "'run' is not a statement — movements are invoked only by listeners. For on-demand runs declare a manual channel: `go = manual()` + `listen to go {} fire <movement>` (\"Run now\" injects an event on that channel); for schedules, `timer = cron()` + `listen to timer { schedule: \"0 9 * * 1\" } fire <movement>`",
                    start,
                );
            }
            "write" => {
                self.pos += word.len();
                let write = self.parse_write_expression(start)?;
                self.expect_statement_end()?;
                return Ok(Statement::Write(WriteStatement { span: write.span, write }));
            }
            "match" => {
                if self.at_match_keyword() {
                    self.pos += word.len();
                    let r#match = self.parse_match_expression(start)?;
                    self.expect_statement_end()?;
                    return Ok(Statement::Match(MatchStatement { span: r#match.span, r#match }));
                }
            }
            "link" => return Ok(Statement::Link(self.parse_link_statement()?)),
            "edge" => {
                return self.fail_at(
                    "'edge' is not a statement — connect two records with 'link a -[:e]-> b'. In a node declaration, nest the node instead: the nesting IS the edge",
                    start,
                );
            }
            "unlink" => return Ok(Statement::Unlink(self.parse_unlink_statement()?)),
            "delete" => return Ok(Statement::Delete(self.parse_delete_statement()?)),
            "refresh" => return Ok(Statement::Refresh(self.parse_refresh_statement()?)),
            "await" => return Ok(Statement::Await(self.parse_await_statement()?)),
            "return" => return Ok(Statement::Return(self.parse_return_statement()?)),
            "race" | "parallel" => {
                let kind = if word == "race" { CombinatorKind::Race } else { CombinatorKind::Parallel };
                if let Some(combinator) = self.try_parse_combinator_statement(kind, start)? {
                    return Ok(Statement::Combinator(combinator));
                }
            }
            // From language version 5 `all(f, g)` is the join; before it, the
            // name was retired in favour of `parallel`.
            "all" if before(self.version, 5) => self.refuse_retired_all(start)?,
            "all" => {
                if let Some(combinator) = self.try_parse_combinator_statement(CombinatorKind::All, start)? {
                    return Ok(Statement::Combinator(combinator));
                }
            }
            "if" => return Ok(Statement::If(self.parse_if()?)),
            "ERROR" => return Ok(Statement::Error(self.parse_error_statement()?)),
            // From version 5 the statement is `fail("…")` (design §2.11).
            "fail" if since(self.version, 5) => return Ok(Statement::Error(self.parse_error_statement()?)),
            "extract" => {
                return self.fail_at("An 'extract' must be bound to a name — write `name = extract from […] { … }`", start);
            }
            "callback" => {
                return self.fail_at(
                    "A 'callback' must be bound to a name — write `cb = callback({ … })`, then use `cb.id` in a button payload (or `cb.url` for a link)",
                    start,
                );
            }
            "else" => return self.fail_at("'else' without a preceding 'if'", start),
            _ => {}
        }

        // A collection op run bare, for its function's effects. Before
        // language version 3 the op is known here by its name; from 3 it is
        // an ordinary call statement.
        let collection_op = if before(self.version, 3) { CollectionOp::from_spelling(&word) } else { None };
        if let Some(op) = collection_op
            && self.followed_by_call(&word)
        {
            self.pos += word.len();
            let collection = self.parse_collection_op(start, &word, op)?;
            self.expect_statement_end()?;
            return Ok(Statement::Collection(CollectionStatement { span: collection.span, collection }));
        }

        self.pos += word.len();
        self.parse_identifier_led_statement(word, start, false)
    }

    /// The forms available once a statement's leading NAME has been read —
    /// assignment, call, or rooted traversal block — shared by the bare-word
    /// and backtick-quoted dispatch. `quoted` keeps the retirement notices
    /// keyed to a bare keyword-shaped word only.
    fn parse_identifier_led_statement(&mut self, word: String, start: usize, quoted: bool) -> SResult<Statement> {
        self.skip_inline_ws();
        if self.is('=') && !self.is_at(1, '=') {
            self.pos += 1;
            let value = self.parse_rvalue()?;
            self.expect_statement_end()?;
            return Ok(Statement::Assign(AssignStatement { name: word, value, span: self.span_from(start) }));
        }
        if self.starts_hop() {
            self.pos = start;
            return Ok(Statement::Block(self.parse_traversal_block_statement()?));
        }
        // A head whose root is an EXPRESSION leads with the same identifier a
        // call does, so the block is tried from the statement's start first.
        let after_word = self.pos;
        self.pos = start;
        if let Some(block) = self.try_parse_traversal_block()? {
            return Ok(Statement::Block(BlockStatement { span: block.span, block }));
        }
        self.pos = after_word;
        if self.is('(') {
            return Ok(Statement::Call(self.parse_call_statement(word, start)?));
        }
        if self.is('?') && self.is_at(1, ':') {
            return self.fail(ELVIS_MISUSE);
        }
        if !quoted {
            if word == "ask" {
                return self.fail_at(ASK_STATEMENT_REPLACED, start);
            }
            if word == "fallback" {
                return self.fail_at(FALLBACK_RUNG_REPLACED, start);
            }
            if word == "sleep" {
                return self.fail_at(SLEEP_STATEMENT_REPLACED, start);
            }
        }
        self.fail(format!(
            "Unexpected {} after '{word}' — expected '=' (binding), '(' (a call), or '-[…]->' (a traversal)",
            self.describe_here()
        ))
    }

    /// After a peeked `ask` in RValue position, is this the RETIRED
    /// ask-statement construction rather than a read of a binding named `ask`?
    fn looks_like_legacy_ask(&mut self) -> bool {
        let save = self.pos;
        self.pos += "ask".len();
        self.skip_inline_ws();
        let legacy = self.is('<') || self.peek_ident().is_some();
        self.pos = save;
        legacy
    }

    fn expect_statement_end(&mut self) -> SResult<()> {
        self.skip_inline_ws();
        // `;` ends a statement just as a newline does.
        if self.is(';') {
            self.pos += 1;
            return Ok(());
        }
        if self.eof() || self.is('\n') || self.is('}') {
            return Ok(());
        }
        self.fail(format!("Unexpected {} — expected the end of the statement", self.describe_here()))
    }

    /// Statements inside `{ … }`; expects and consumes both braces.
    fn parse_block_body(&mut self, context: &str) -> SResult<Vec<Statement>> {
        self.skip_inline_ws();
        let brace_offset = self.pos;
        self.expect("{", &format!("to open {context}"))?;
        let mut body = Vec::new();
        loop {
            self.skip_all_ws();
            if self.eof() {
                return self.fail_at(format!("Expected '}}' to close {context}"), brace_offset);
            }
            if self.is('}') {
                self.pos += 1;
                return Ok(body);
            }
            if self.peek() == Some(ELISION) {
                self.pos += 1;
                continue;
            }
            body.push(self.parse_statement()?);
        }
    }

    // ── import ──

    fn parse_import(&mut self) -> SResult<ImportStatement> {
        let start = self.pos;
        self.pos += "import".len();
        self.skip_inline_ws();
        self.expect("{", "after 'import'")?;
        let mut names = Vec::new();
        loop {
            self.skip_all_ws();
            if self.is('}') {
                self.pos += 1;
                break;
            }
            let name = self.read_name("an imported name")?;
            self.skip_all_ws();
            let mut alias = None;
            if self.at_word("as") {
                self.pos += "as".len();
                self.skip_all_ws();
                alias = Some(self.read_name("a local name after 'as'")?);
                self.skip_all_ws();
            }
            names.push(ImportedName { name, alias });
            if self.is(',') {
                self.pos += 1;
                continue;
            }
            if !self.is('}') {
                return self.fail(format!("Expected ',' or '}}' in the import list, found {}", self.describe_here()));
            }
        }
        if names.is_empty() {
            return self.fail_at("The import list is empty", start);
        }
        self.skip_inline_ws();
        self.expect_word("from", "after the import list")?;
        self.skip_inline_ws();
        let source = if self.is('"') {
            let (path, _) = self.read_quoted_string("as the import path")?;
            ImportSource::File { path }
        } else {
            let ns_offset = self.pos;
            let Some(ns) = self.peek_ident() else {
                return self.fail(format!(
                    "Expected an import source — 'adapters', 'credentials', 'plugins', or a \"file path\" — found {}",
                    self.describe_here()
                ));
            };
            if ns != "adapters" && ns != "credentials" && ns != "plugins" {
                return self.fail_at(
                    format!(
                        "Unknown import source '{ns}' — expected 'adapters', 'credentials', 'plugins', or a quoted \"file path\""
                    ),
                    ns_offset,
                );
            }
            self.pos += ns.len();
            if ns == "adapters" {
                if since(self.version, 5) {
                    for imported in &mut names {
                        if let Some(adapter) = imported.name.strip_prefix(ADAPTER_PACKAGE_PREFIX) {
                            imported.name = adapter.to_string();
                        }
                    }
                }
                self.adapters.extend(names.iter().map(|n| n.alias.clone().unwrap_or_else(|| n.name.clone())));
            }
            ImportSource::Builtin { namespace: ns }
        };
        self.expect_statement_end()?;
        Ok(ImportStatement { names, source, span: self.span_from(start) })
    }

    // ── Assignment right-hand sides ──

    fn parse_rvalue(&mut self) -> SResult<RValue> {
        self.deeper(Self::parse_rvalue_here)
    }

    fn parse_rvalue_here(&mut self) -> SResult<RValue> {
        self.skip_inline_ws();
        if self.eof() || self.is('\n') {
            return self.fail("Expected a value after '='");
        }
        let start = self.pos;
        let word = self.peek_ident();
        let w = word.as_deref();
        if w == Some("write") {
            self.pos += "write".len();
            return Ok(RValue::Write { write: self.parse_write_expression(start)? });
        }
        if w == Some("match") && self.at_match_keyword() {
            self.pos += "match".len();
            return Ok(RValue::Match { r#match: self.parse_match_expression(start)? });
        }
        if w == Some("link") {
            self.pos += "link".len();
            let link = self.parse_link_expression(start)?;
            if !matches!(link.to, LinkTarget::Match { .. }) {
                return self.fail_at(
                    format!(
                        "A link binds only the record it finds — 'x = link {} -[:{}]-> {{ … }}' binds the match; 'link a -[:e]-> b' connects two records you already hold and binds nothing",
                        link.from, link.edge
                    ),
                    start,
                );
            }
            return Ok(RValue::Link { link });
        }
        if self.at_extract_call() {
            let extract_call = self.parse_extract_call(start)?;
            let end = self.pos;
            self.skip_inline_ws();
            match self.peek() {
                None => {
                    self.pos = end;
                    return Ok(RValue::ExtractCall { extract_call });
                }
                Some(next) if in_set(next, "\n};") => {
                    self.pos = end;
                    return Ok(RValue::ExtractCall { extract_call });
                }
                // More follows the call (`extractOne(…).name`): the value is an
                // expression with the call nested in it.
                Some(_) => self.pos = start,
            }
        } else if w == Some("extract") {
            self.pos += "extract".len();
            return Ok(RValue::Extract { extract: self.parse_extract(start)? });
        }
        if w == Some("ask") && self.looks_like_legacy_ask() {
            return self.fail_at(ASK_STATEMENT_REPLACED, start);
        }
        if w == Some("await") {
            self.pos += "await".len();
            return Ok(RValue::Await { r#await: self.parse_await(start)? });
        }
        if w == Some("all") && before(self.version, 5) {
            self.refuse_retired_all(start)?;
        }
        if let Some(kind) = w.and_then(|w| self.combinator_named(w)) {
            let save = self.pos;
            self.pos += kind.word().len();
            self.skip_inline_ws();
            if self.is('{') {
                return self.fail_at(self.parallel_block_retired(), start);
            }
            if self.is('(') {
                return Ok(RValue::Combinator { combinator: self.parse_combinator(start, kind)? });
            }
            self.pos = save;
        }
        if w == Some("callback") {
            self.pos += "callback".len();
            return Ok(RValue::Callback { callback: self.parse_callback(start)? });
        }
        // The collection ops and `MEMBERS` take a FUNCTION and a TYPE, which no
        // expression can hold. Before language version 3 they are read here, by
        // name; from 3 they are calls like any other.
        let legacy_forms = before(self.version, 3);
        if let Some(word) = w
            && legacy_forms
            && let Some(op) = CollectionOp::from_spelling(word)
            && self.followed_by_call(word)
        {
            self.pos += word.len();
            return Ok(RValue::Collection { collection: self.parse_collection_op(start, word, op)? });
        }
        if legacy_forms && w == Some("MEMBERS") && self.followed_by_call("MEMBERS") {
            self.pos += "MEMBERS".len();
            return Ok(RValue::Members { members: self.parse_members(start)? });
        }
        self.refuse_named_node_as_value()?;
        if self.at_node_literal() {
            self.pos += "node".len();
            return Ok(RValue::Node { node: self.parse_node_literal(start)? });
        }
        if self.at_graph_literal() {
            return Ok(RValue::Node { node: self.parse_graph_literal(start)? });
        }
        if self.at_lazy() {
            self.pos += "lazy".len();
            return Ok(RValue::Lazy { lazy: self.parse_lazy(start)? });
        }
        // A brace-led value is a dict literal, read by the expression slot —
        // except the RETIRED inline block (`{ … }.binding`), told apart by the
        // `.name` after the closing brace.
        if self.is('{') && self.at_retired_inline_block() {
            return Ok(RValue::InlineBlock { inline_block: self.parse_inline_block(start)? });
        }
        if self.at_closure() {
            return Ok(RValue::Closure { closure: self.parse_closure(start, "\n}")? });
        }
        if let Some(block) = self.try_parse_traversal_block()? {
            return Ok(RValue::Block { block });
        }
        if since(self.version, 5) && self.at_word("connect") {
            return Ok(RValue::Construct { construct: self.parse_connect()? });
        }
        if let Some(invocation) = self.try_parse_invocation()? {
            if let RValue::Construct { construct } = &invocation {
                self.refuse_adapter_construction(construct, start);
            }
            return Ok(invocation);
        }
        let (slot, _) = self.read_expr_slot(Scan::new("\n}", "for the value after '='").eof_ok())?;
        Ok(RValue::Expr { expr: slot })
    }

    /// A bound NAMED INVOCATION — `crm = attio(credentials: acme_main)` and
    /// `doc = email_to_doc(m: msg)`, one surface form. An argument the
    /// construction grammar cannot hold proves a call; everything else records
    /// as `construct`.
    fn try_parse_invocation(&mut self) -> SResult<Option<RValue>> {
        if !self.at_named_invocation() {
            if let Some(positional) = self.try_parse_invocation_call("\n};")? {
                return Ok(Some(RValue::Call { call: positional }));
            }
            return Ok(self.try_parse_construction()?.map(|construct| RValue::Construct { construct }));
        }
        let start = self.pos;
        let callee = self.read_name("the name being called")?;
        self.skip_inline_ws();
        self.pos += 1;
        let args = self.parse_call_args(&callee, start)?;
        let span = self.span_from(start);
        if args.iter().any(|arg| !matches!(arg, CallArg::Expr { name: Some(_), .. })) {
            return Ok(Some(RValue::Call { call: CallStatement { callee, args, expression: None, span } }));
        }
        let plain = args
            .into_iter()
            .filter_map(|arg| match arg {
                CallArg::Expr { name: Some(name), expr } => Some(NamedArg { name, value: expr, is_type: None }),
                _ => None,
            })
            .collect();
        Ok(Some(RValue::Construct { construct: ConstructionCall { callee, args: plain, span } }))
    }

    /// A zero-argument or otherwise unnamed invocation — `go = manual()`. It
    /// BACKTRACKS, so anything that isn't one falls through to the slot.
    fn try_parse_construction(&mut self) -> SResult<Option<ConstructionCall>> {
        let save = self.pos;
        let Some((callee, end)) = scan_name(self.src.units(), self.pos) else {
            return Ok(None);
        };
        self.pos = end;
        self.skip_inline_ws();
        if !self.is('(') {
            self.pos = save;
            return Ok(None);
        }
        self.pos += 1;
        let mut args = Vec::new();
        loop {
            self.skip_all_ws();
            if self.eof() {
                self.pos = save;
                return Ok(None);
            }
            if self.is(')') {
                self.pos += 1;
                break;
            }
            let Some(name) = self.peek_ident() else {
                self.pos = save;
                return Ok(None);
            };
            self.pos += name.len();
            self.skip_inline_ws();
            if !self.is(':') {
                self.pos = save;
                return Ok(None);
            }
            self.pos += 1;
            let (slot, stop) = self.read_expr_slot(Scan::new(",)", format!("for the argument '{name}'")))?;
            args.push(NamedArg { name, value: slot, is_type: None });
            if stop == Some(unit(',')) {
                self.pos += 1;
            }
        }
        let end = self.pos;
        self.skip_inline_ws();
        if !self.eof() && !self.is('\n') && !self.is('}') {
            self.pos = save;
            return Ok(None);
        }
        self.pos = end;
        Ok(Some(ConstructionCall { callee, args, span: self.span_between(save, end) }))
    }

    // ── Traversal heads and blocks ──

    /// `root-[a:edge]->-[b:other]->` — non-throwing on shape mismatch
    /// (restores position). The root is a NAME where one is written, an
    /// EXPRESSION where what precedes the first hop is anything else.
    fn try_parse_path_head(&mut self) -> SResult<Option<PathHead>> {
        let start = self.pos;
        if let Some((name, end)) = scan_name(self.src.units(), self.pos) {
            self.pos = end;
            self.skip_inline_ws();
            if self.starts_hop() {
                let hops_raw = self.scan_hop_chain()?;
                return Ok(Some(PathHead {
                    root: Some(PathRoot::Name { name }),
                    hops_raw,
                    span: self.span_from(start),
                }));
            }
            self.pos = start;
        } else if self.starts_hop() {
            let hops_raw = self.scan_hop_chain()?;
            return Ok(Some(PathHead { root: None, hops_raw, span: self.span_from(start) }));
        }
        let Some(expr_end) = self.scan_expression_root_end() else {
            self.pos = start;
            return Ok(None);
        };
        let expr = self.slot(self.text(start, expr_end), self.span_between(start, expr_end));
        self.pos = expr_end;
        self.skip_inline_ws();
        let hops_raw = self.scan_hop_chain()?;
        Ok(Some(PathHead { root: Some(PathRoot::Expression { expr }), hops_raw, span: self.span_from(start) }))
    }

    /// One or more `-[…]->` hops, with `-[` already under the cursor.
    fn scan_hop_chain(&mut self) -> SResult<String> {
        let hops_start = self.pos;
        loop {
            self.scan_hop()?;
            let after_hop = self.pos;
            self.skip_inline_ws();
            if !self.starts_hop() {
                self.pos = after_hop;
                break;
            }
        }
        Ok(self.text(hops_start, self.pos))
    }

    /// Where an EXPRESSION root ends — the offset of the first `-[` that is
    /// not inside a bracket or a literal, or `None` when there is none before
    /// the line ends. Peeks only, and never fails: every caller has another
    /// grammar to fall back to.
    fn scan_expression_root_end(&self) -> Option<usize> {
        let src = self.src.units();
        let mut hops: Vec<bool> = Vec::new();
        let mut i = self.pos;
        while i < src.len() {
            let c = src[i];
            // A head is written on one line, and a comment ends the line's code.
            if c == unit('\n') {
                return None;
            }
            if hops.is_empty() && (c == unit(',') || c == unit(';')) {
                return None;
            }
            match skip_opaque(src, i, hops.last().copied().unwrap_or(false), src.len()) {
                Ok(Some(Opaque::Skipped { kind: OpaqueKind::String | OpaqueKind::Name, end })) => {
                    i = end;
                    continue;
                }
                Ok(Some(_)) | Err(TooDeep) => return None,
                Ok(None) => {}
            }
            if hops.is_empty() && c == unit('-') && src.get(i + 1) == Some(&unit('[')) {
                let end = self.pos + trim_end(&src[self.pos..i]).len();
                return self.is_expression_root(end).then_some(end);
            }
            if is_opener(c) {
                hops.push(opens_hop(src, i, src.len()));
            } else if is_closer(c) {
                // A closer with nothing open belongs to whoever opened it.
                hops.pop()?;
            }
            i += 1;
        }
        None
    }

    /// Is `[pos, end)` a head's EXPRESSION root — a parenthesised expression,
    /// or a name immediately followed by a call, a property or an index? The
    /// SPACE decides it: the formula grammar has no juxtaposition.
    fn is_expression_root(&self, end: usize) -> bool {
        let src = self.src.units();
        if end <= self.pos {
            return false;
        }
        if src[self.pos] == unit('(') {
            return true;
        }
        let Some((_, name_end)) = scan_name(src, self.pos) else {
            return false;
        };
        if name_end >= end {
            return false;
        }
        let next = src.get(name_end).copied();
        next == Some(unit('(')) || next == Some(unit('.')) || next == Some(unit('['))
    }

    /// Consumes one `-[…]->` hop. Comments are off inside the brackets.
    fn scan_hop(&mut self) -> SResult<()> {
        self.expect("-[", "to begin a traversal hop")?;
        self.scan_balanced(&Scan::new("]", "the traversal hop").no_comments())?;
        self.pos += 1;
        self.expect("->", "after ']' to complete the traversal hop")
    }

    fn try_parse_traversal_block(&mut self) -> SResult<Option<TraversalBlock>> {
        let save = self.pos;
        let Some(head) = self.try_parse_path_head()? else {
            return Ok(None);
        };
        self.skip_inline_ws();
        if !self.is('{') {
            self.pos = save;
            return Ok(None);
        }
        let body = self.parse_block_body("the traversal block")?;
        Ok(Some(TraversalBlock { head, body, span: self.span_from(save) }))
    }

    fn parse_traversal_block_statement(&mut self) -> SResult<BlockStatement> {
        let start = self.pos;
        let Some(head) = self.try_parse_path_head()? else {
            return self.fail_at(format!("Expected a traversal head, found {}", self.describe_here()), start);
        };
        let body = self.parse_block_body("the traversal block")?;
        let span = self.span_from(start);
        Ok(BlockStatement { block: TraversalBlock { head, body, span }, span })
    }

    // ── Writes ──

    fn parse_write_expression(&mut self, start: usize) -> SResult<WriteExpression> {
        let target = self.parse_write_target(Finder::Write)?;
        let bind = self.try_parse_bind_clause()?;
        let (unique_by, fields, spreads) = self.parse_write_body(Finder::Write)?;
        Ok(WriteExpression {
            target,
            unique_by,
            fields,
            spreads: (!spreads.is_empty()).then_some(spreads),
            bind,
            span: self.span_from(start),
        })
    }

    /// `match <path> { unique by (…) … }` — after the keyword.
    fn parse_match_expression(&mut self, start: usize) -> SResult<MatchExpression> {
        let target = self.parse_write_target(Finder::Match)?;
        if let WriteTarget::Position { root, span } = &target {
            let held = spell_path_root(root);
            return Err(ParseError {
                message: format!(
                    "'{held}' is already a record — a match FINDS one, from where records are: a hop ('match {held}-[:Edge]-> {{ … }}') or an instance's collection ('match crm-[:companies]-> {{ … }}')"
                ),
                loc: span.start,
            });
        }
        let (unique_by, fields) = self.parse_match_body(Finder::Match)?;
        Ok(MatchExpression { target, unique_by, fields, span: self.span_from(start) })
    }

    /// A match body — a write body whose fields are assertions only.
    fn parse_match_body(&mut self, keyword: Finder) -> SResult<(Vec<UniqueClause>, Vec<FieldEntry>)> {
        let (unique_by, fields, spreads) = self.parse_write_body(keyword)?;
        let finder = if keyword == Finder::Link { "link body" } else { "match" };
        if let Some(spread) = spreads.first() {
            let source = &spread.source;
            return Err(ParseError {
                message: format!(
                    "'...{source}' writes, and a {finder} never writes — list the fields it looks the record up by ('name: {source}.name'), or use 'write' when the record should be created or changed"
                ),
                loc: spread.span.start,
            });
        }
        for field in &fields {
            let Some(semantics) = field.semantics else { continue };
            let op = match semantics {
                FieldWriteMode::Fill => "?:",
                FieldWriteMode::Append => "+:",
                FieldWriteMode::AppendMissing => "+?:",
            };
            let name = &field.name;
            return Err(ParseError {
                message: format!(
                    "'{name} {op}' writes, and a {finder} never writes — its fields are the values it looks the record up by. Use '{name}: …', or 'write' when the record should be created or changed"
                ),
                loc: field.span.start,
            });
        }
        Ok((unique_by, fields))
    }

    /// `match` is CONTEXTUAL: the keyword only where a target follows it on
    /// the same line.
    fn at_match_keyword(&self) -> bool {
        if !self.at_word("match") {
            return false;
        }
        let mut i = self.pos + "match".len();
        let blank = |u: Option<u16>| u == Some(unit(' ')) || u == Some(unit('\t'));
        if !blank(self.src.at(i)) {
            return false;
        }
        while blank(self.src.at(i)) {
            i += 1;
        }
        self.src.at(i) == Some(unit('(')) || scan_name(self.src.units(), i).is_some()
    }

    /// The target a write — or a match — addresses.
    fn parse_write_target(&mut self, keyword: Finder) -> SResult<WriteTarget> {
        let kw = keyword.word();
        self.skip_inline_ws();
        let target_start = self.pos;
        if self.is('(') {
            return self.parse_tuple_write_target(target_start, kw);
        }
        let root = self.parse_write_root(kw)?;
        if self.starts_hop() {
            let hops_start = self.pos;
            loop {
                self.scan_hop()?;
                if !self.starts_hop() {
                    break;
                }
            }
            let hops_raw = self.text(hops_start, self.pos);
            let explicit_type = self.try_read_explicit_write_type()?;
            let path = PathHead { root: Some(root), hops_raw, span: self.span_from(target_start) };
            return Ok(WriteTarget::Linked { path, explicit_type, span: self.span_from(target_start) });
        }
        // A bare name or member path updates the record it holds in place
        // (`write a { … }`, `write m.k { … }`).
        Ok(WriteTarget::Position { root, span: self.span_from(target_start) })
    }

    /// Where a write or a match starts: the record a NAME holds, or the one a
    /// MEMBER PATH reaches (`m.k`, `m.k.inner`), read exactly as `x = m.k`
    /// would bind it. Any other expression is bound to a name first.
    fn parse_write_root(&mut self, kw: &str) -> SResult<PathRoot> {
        let start = self.pos;
        let src = self.src.units();
        let (member, name) = match scan_member_path(src, start) {
            Some((_, end)) => (Some(end), None),
            None => (None, scan_name(src, start)),
        };
        let end = member.or(name.as_ref().map(|&(_, end)| end));
        let Some(end) = end.filter(|&end| !matches!(src.get(end), Some(&c) if c == unit('(') || c == unit('['))) else {
            return self.refuse_write_root_expression(kw);
        };
        self.pos = end;
        if let Some((name, _)) = name {
            return Ok(PathRoot::Name { name });
        }
        Ok(PathRoot::Expression { expr: self.slot(self.text(start, end), self.span_between(start, end)) })
    }

    /// A write's root that is neither a name nor a member path: the repair is
    /// to bind it first. With no expression to name, the target is missing.
    fn refuse_write_root_expression<T>(&mut self, kw: &str) -> SResult<T> {
        let expr_end = match self.scan_expression_root_end() {
            Some(end) => Some(end),
            None => self.scan_write_root_expression_end(),
        };
        if let Some(expr_end) = expr_end {
            return self.fail(format!(
                "A {kw} starts from a record a name or a member path holds ('parent', 'm.k') — bind this one first: 'parent = {}', then '{kw} parent-[:edge]-> {{ … }}' or '{kw} parent {{ … }}'.",
                self.text(self.pos, expr_end)
            ));
        }
        self.fail(format!(
            "Expected a {kw} target after '{kw}' — a linked path like '<instance>-[:edge]->' or 'parent-[:edge]->', or a tuple '(a-[:e]->, b-[:f]->)' — found {}",
            self.describe_here()
        ))
    }

    /// Where a write's EXPRESSION root ends when no hop follows it: a call or
    /// an index on a name (`FIRST(xs)`, `rows[0]`), up to the body's `{`.
    /// Peeks only.
    fn scan_write_root_expression_end(&mut self) -> Option<usize> {
        let save = self.pos;
        let (_, name_end) = scan_name(self.src.units(), save)?;
        if !matches!(self.src.at(name_end), Some(c) if c == unit('(') || c == unit('[')) {
            return None;
        }
        let scanned = self.scan_balanced(&Scan::new("{\n", "the write target"));
        self.pos = save;
        let (_, content_end) = scanned.ok()?;
        (content_end > save).then_some(content_end)
    }

    /// `bind <name>` between the write target and the body. Contextual.
    fn try_parse_bind_clause(&mut self) -> SResult<Option<BindClause>> {
        self.skip_inline_ws();
        if !self.at_word("bind") {
            return Ok(None);
        }
        let bind_start = self.pos;
        self.pos += "bind".len();
        self.skip_inline_ws();
        let name = self.read_name("the counterpart record name after 'bind'")?;
        Ok(Some(BindClause { name, span: self.span_from(bind_start) }))
    }

    /// `(company-[:investments]->, investor-[:investments]->)` — the
    /// tuple-path multi-parent target.
    fn parse_tuple_write_target(&mut self, target_start: usize, kw: &str) -> SResult<WriteTarget> {
        self.expect("(", &format!("to open the tuple {kw} target"))?;
        let mut paths = Vec::new();
        loop {
            self.skip_all_ws();
            if self.is(')') {
                self.pos += 1;
                break;
            }
            let Some(path) = self.try_parse_path_head()? else {
                return self.fail(format!(
                    "Expected a linked path like 'parent-[:edge]->' in the tuple {kw} target, found {}",
                    self.describe_here()
                ));
            };
            let held = match &path.root {
                Some(PathRoot::Name { .. }) => true,
                Some(PathRoot::Expression { expr }) => member_path_binding_name(expr).is_some(),
                None => false,
            };
            if !held {
                return self.fail_at(
                    "Every tuple path starts at a record a name or a member path holds — bind the parent first",
                    target_start,
                );
            }
            paths.push(path);
            self.skip_all_ws();
            if self.is(',') {
                self.pos += 1;
                continue;
            }
            if !self.is(')') {
                return self.fail(format!("Expected ',' or ')' in the tuple {kw} target, found {}", self.describe_here()));
            }
        }
        if paths.len() < 2 {
            return self.fail_at(
                format!(
                    "A tuple {kw} target takes two or more parent paths — for one parent, use the linked form '{kw} parent-[:edge]-> {{ … }}'"
                ),
                target_start,
            );
        }
        self.skip_inline_ws();
        let explicit_type = self.try_read_explicit_write_type()?;
        Ok(WriteTarget::Tuple { paths, explicit_type, span: self.span_from(target_start) })
    }

    /// The optional explicit written type on polymorphic targets —
    /// `write fr-[:related]-><company> { … }`.
    fn try_read_explicit_write_type(&mut self) -> SResult<Option<String>> {
        self.skip_inline_ws();
        if self.is('<') {
            return Ok(Some(self.read_type_marker("for the written type", PLAIN)?.text));
        }
        // `bind` follows the target — leave it for `try_parse_bind_clause`.
        if let Some(bare) = self.peek_ident()
            && bare != "bind"
        {
            return self.fail(format!("Types are written in angle brackets — wrap the type in angle brackets: <{bare}>"));
        }
        Ok(None)
    }

    #[allow(clippy::type_complexity)]
    fn parse_write_body(&mut self, keyword: Finder) -> SResult<(Vec<UniqueClause>, Vec<FieldEntry>, Vec<WriteSpread>)> {
        let kw = keyword.word();
        self.skip_inline_ws();
        let brace_offset = self.pos;
        self.expect("{", &format!("to open the {kw} body"))?;
        let mut unique_by = Vec::new();
        let mut fields = Vec::new();
        let mut spreads = Vec::new();
        loop {
            self.skip_all_ws();
            if self.eof() {
                return self.fail_at(format!("Expected '}}' to close the {kw} body"), brace_offset);
            }
            if self.is('}') {
                self.pos += 1;
                return Ok((unique_by, fields, spreads));
            }
            if self.is(',') {
                self.pos += 1;
                continue;
            }
            let entry_start = self.pos;
            if let Some(spread) = self.try_parse_write_spread()? {
                let source = spread.source.clone();
                spreads.push(spread);
                self.finish_node_entry(&source)?;
                continue;
            }
            if self.at_word("unique") {
                self.pos += "unique".len();
                self.skip_inline_ws();
                self.expect_word("by", "after 'unique'")?;
                self.skip_inline_ws();
                unique_by.push(self.parse_unique_clause(entry_start)?);
                continue;
            }
            let name = self.read_name(&format!("a field name or 'unique by' in the {kw} body"))?;
            self.skip_inline_ws();
            // Longest match first: `+?:` · `+:` · `?:` · `:`.
            let semantics = if self.try_consume("+?:") {
                Some(FieldWriteMode::AppendMissing)
            } else if self.try_consume("+:") {
                Some(FieldWriteMode::Append)
            } else if self.try_consume("?:") {
                Some(FieldWriteMode::Fill)
            } else {
                None
            };
            if semantics.is_none() {
                self.expect(":", &format!("after the field name '{name}'"))?;
            }
            let (slot, stop) = self.read_expr_slot(Scan::new(",\n}", format!("for the field '{name}'")))?;
            let span = Span { start: self.loc_at(entry_start), end: slot.span.end };
            fields.push(FieldEntry { name, value: slot, semantics, span });
            if stop == Some(unit(',')) {
                self.pos += 1;
            }
        }
    }

    /// `...e` / `?...e` at an entry's start — consumes nothing when absent.
    fn try_parse_write_spread(&mut self) -> SResult<Option<WriteSpread>> {
        let start = self.pos;
        let fill = self.starts_with("?...");
        if !fill && !self.starts_with("...") {
            return Ok(None);
        }
        let spelled = if fill { "?..." } else { "..." };
        self.pos += spelled.len();
        if !self.peek().is_some_and(|c| is_ident_start(c) || c == unit('`')) {
            return self.fail(format!(
                "'{spelled}' spreads a record's fields into the write — name the record right after it: '{spelled}e'"
            ));
        }
        let root = self.read_name(&format!("the record to spread after '{spelled}'"))?;
        // `...m.k`: a record held under a key of a map spreads as that record.
        let mut members: Vec<String> = Vec::new();
        while self.is('.') && self.src.at(self.pos + 1).is_some_and(|c| is_ident_start(c) || c == unit('`')) {
            self.pos += 1;
            members.push(self.read_name(&format!("the key to read after '{spelled}{root}.'"))?);
        }
        let (source, path) = if members.is_empty() {
            (root, None)
        } else {
            let spelled_path = std::iter::once(&root).chain(&members).map(|n| spell_name(n)).collect::<Vec<_>>().join(".");
            (spelled_path, Some(SpreadPath { root, members }))
        };
        Ok(Some(WriteSpread { source, path, semantics: fill.then_some(FieldWriteMode::Fill), span: self.span_from(start) }))
    }

    fn parse_unique_clause(&mut self, entry_start: usize) -> SResult<UniqueClause> {
        self.expect("(", "after 'unique by'")?;
        let (slot, _) = self.read_expr_slot(Scan::new(")", "in 'unique by (…)'"))?;
        self.expect(")", "to close 'unique by (…)'")?;
        Ok(UniqueClause { predicate: slot, span: self.span_from(entry_start) })
    }

    // ── Node literals ──

    /// Is a `node { … }` literal next? `node` alone is an ordinary name.
    fn at_node_literal(&mut self) -> bool {
        if !self.at_word("node") {
            return false;
        }
        let save = self.pos;
        self.pos += "node".len();
        self.skip_inline_ws();
        let is_literal = self.is('{');
        self.pos = save;
        is_literal
    }

    /// Is `node <name> { … }` — a NAMED declaration — next? Consumes nothing.
    fn at_node_declaration(&mut self) -> bool {
        if !self.at_word("node") {
            return false;
        }
        let save = self.pos;
        self.pos += "node".len();
        self.skip_inline_ws();
        let mut named = false;
        if self.peek().is_some_and(|c| is_ident_start(c) || c == unit('`')) && self.read_name("a name").is_ok() {
            self.skip_inline_ws();
            if self.at_word("extends") {
                named = true;
            } else if self.is(':') {
                self.pos += 1;
                self.skip_inline_ws();
                named = self.is('"');
            } else {
                named = self.is('{');
            }
        }
        self.pos = save;
        named
    }

    /// A NAMED node where a value is expected: refused by name.
    fn refuse_named_node_as_value(&mut self) -> SResult<()> {
        if !self.at_node_declaration() {
            return Ok(());
        }
        self.fail(
            "a named node DECLARES a structure and belongs at the top level of the file — here, build the record with an anonymous literal: `node { … }`",
        )
    }

    /// Is a NAMED invocation — `f(x: …)` — next? Consumes nothing.
    fn at_named_invocation(&mut self) -> bool {
        let save = self.pos;
        let Some((_, end)) = scan_name(self.src.units(), self.pos) else {
            return false;
        };
        self.pos = end;
        self.skip_inline_ws();
        let mut named = false;
        if self.is('(') {
            self.pos += 1;
            self.skip_all_ws();
            if let Some((_, arg_end)) = scan_name(self.src.units(), self.pos) {
                self.pos = arg_end;
                self.skip_inline_ws();
                named = self.is(':');
            }
        }
        self.pos = save;
        named
    }

    /// Is `lazy <traversal>` next? Contextual, like `node`.
    fn at_lazy(&mut self) -> bool {
        if !self.at_word("lazy") {
            return false;
        }
        let save = self.pos;
        self.pos += "lazy".len();
        self.skip_inline_ws();
        let modifies = self.peek().is_some_and(|c| c == unit('-') || c == unit('`') || is_ident_start(c));
        self.pos = save;
        modifies
    }

    /// The deferred traversal, with `lazy` consumed; `start` is the word's.
    fn parse_lazy(&mut self, start: usize) -> SResult<LazyTraversal> {
        self.skip_inline_ws();
        let source_start = self.pos;
        if self.at_word("await") {
            return self.fail_at(LAZY_AWAIT, source_start);
        }
        let Some(head) = self.try_parse_path_head()? else {
            return self.fail_at(
                format!(
                    "Expected a traversal to defer (`lazy crm-[c:Companies]->`) after 'lazy', found {}",
                    self.describe_here()
                ),
                source_start,
            );
        };
        let mapping = self.try_parse_per_item_tail()?;
        Ok(LazyTraversal { head, mapping, span: self.span_from(start) })
    }

    /// The literal's body, with `node` consumed; `start` is the word's.
    fn parse_node_literal(&mut self, start: usize) -> SResult<NodeLiteral> {
        self.deeper(|p| {
            p.skip_inline_ws();
            let brace_offset = p.pos;
            p.expect("{", "to open the node literal")?;
            let mut entries = Vec::new();
            loop {
                p.skip_all_ws();
                if p.eof() {
                    return p.fail_at("Expected '}' to close the node literal", brace_offset);
                }
                if p.is('}') {
                    p.pos += 1;
                    return Ok(NodeLiteral { entries, graph: None, spreads: None, span: p.span_from(start) });
                }
                if p.is(',') {
                    p.pos += 1;
                    continue;
                }
                entries.push(p.parse_node_entry()?);
            }
        })
    }

    /// `name: <value>` — one entry; the value's KIND decides what it declares.
    fn parse_node_entry(&mut self) -> SResult<NodeEntry> {
        let entry_start = self.pos;
        let name = self.read_name("an entry name in the node literal")?;
        self.skip_inline_ws();
        self.expect(":", &format!("after the entry name '{name}'"))?;
        self.skip_inline_ws();

        self.refuse_named_node_as_value()?;
        if self.at_node_literal() {
            let node_start = self.pos;
            self.pos += "node".len();
            let node = self.parse_node_literal(node_start)?;
            self.finish_node_entry(&name)?;
            return Ok(NodeEntry::Nodes { name, nodes: vec![node], span: self.span_from(entry_start) });
        }
        // `[node { … }, …]`, or an ordinary list expression: this backtracks.
        if self.is('[') {
            let save = self.pos;
            if let Some(nodes) = self.try_parse_node_literal_list()? {
                self.finish_node_entry(&name)?;
                return Ok(NodeEntry::Nodes { name, nodes, span: self.span_from(entry_start) });
            }
            self.pos = save;
        }
        // A TYPE — the declared edge. Nothing in the expression grammar opens
        // with `<`.
        if self.is('<') {
            let entry = self.parse_declared_edge_entry(name.clone(), entry_start)?;
            self.finish_node_entry(&name)?;
            return Ok(entry);
        }
        let lazy = self.at_lazy();
        if lazy {
            self.pos += "lazy".len();
            self.skip_inline_ws();
        }
        let save = self.pos;
        if let Some(head) = self.try_parse_path_head()? {
            let mapping = self.try_parse_per_item_tail()?;
            self.finish_node_entry(&name)?;
            return Ok(NodeEntry::Traversal { name, head, lazy, mapping, span: self.span_from(entry_start) });
        }
        self.pos = save;
        self.refuse_non_entry_value(&name, lazy)?;
        let (slot, stop) = self.read_expr_slot(Scan::new(",\n}", format!("for the entry '{name}'")))?;
        if stop == Some(unit(',')) {
            self.pos += 1;
        }
        let span = Span { start: self.loc_at(entry_start), end: slot.span.end };
        Ok(NodeEntry::Value { name, value: slot, span })
    }

    /// `[node { … }, node { … }]` — consumes through `]`, or `None` (the
    /// caller restores the position) for an ordinary list expression.
    fn try_parse_node_literal_list(&mut self) -> SResult<Option<Vec<NodeLiteral>>> {
        self.pos += 1;
        let mut nodes = Vec::new();
        loop {
            self.skip_all_ws();
            if self.eof() {
                return Ok(None);
            }
            if self.is(']') {
                self.pos += 1;
                // An empty `[]` is a list VALUE, not a plural edge.
                return Ok((!nodes.is_empty()).then_some(nodes));
            }
            if self.is(',') {
                self.pos += 1;
                continue;
            }
            if !self.at_node_literal() {
                return Ok(None);
            }
            let node_start = self.pos;
            self.pos += "node".len();
            nodes.push(self.parse_node_literal(node_start)?);
        }
    }

    /// `messages: <slack-[:Channels]->-[:Messages]->>` — the DECLARED edge.
    fn parse_declared_edge_entry(&mut self, name: String, entry_start: usize) -> SResult<NodeEntry> {
        let marker = self.read_type_marker(&format!("for the entry '{name}'"), HOPS)?;
        let sequenced = self.try_parse_entry_ordering(&name)?;
        Ok(NodeEntry::Declared {
            name,
            type_: type_ref_from_marker(marker),
            sequenced,
            span: self.span_from(entry_start),
        })
    }

    /// `messages: <…> order by arrival` — same line only.
    fn try_parse_entry_ordering(&mut self, name: &str) -> SResult<Option<EdgeSequencing>> {
        let save = self.pos;
        self.skip_inline_ws();
        if !self.at_word("order") {
            self.pos = save;
            return Ok(None);
        }
        self.pos += "order".len();
        self.skip_inline_ws();
        if !self.at_word("by") {
            return self.fail(format!(
                "An entry's order is written 'order by' — write '{name}: … order by arrival', found {}",
                self.describe_here()
            ));
        }
        self.pos += "by".len();
        self.skip_inline_ws();
        let sequencing = [EdgeSequencing::Arrival, EdgeSequencing::Document, EdgeSequencing::Chronological]
            .into_iter()
            .find(|known| self.at_word(known.word()));
        let Some(sequencing) = sequencing else {
            return self.fail(format!(
                "'order by' takes one of 'arrival' (the order the links landed), 'document' (the order a source document put them in) or 'chronological' (the order they happened) — found {}",
                self.describe_here()
            ));
        };
        self.pos += sequencing.word().len();
        Ok(Some(sequencing))
    }

    /// After an entry whose value was a literal: the entry ends at a comma, a
    /// newline, or the closing `}`.
    fn finish_node_entry(&mut self, name: &str) -> SResult<()> {
        self.skip_inline_ws();
        if self.is(',') {
            self.pos += 1;
            return Ok(());
        }
        if self.eof() || self.is('\n') || self.is('}') {
            return Ok(());
        }
        self.fail(format!("Expected ',' or a newline after the entry '{name}', found {}", self.describe_here()))
    }

    /// An entry value that is an effect, or a `lazy` with nothing to defer —
    /// refused by NAME.
    fn refuse_non_entry_value(&self, name: &str, saw_lazy: bool) -> SResult<()> {
        let word = self.peek_ident();
        if saw_lazy {
            return self.fail(if word.as_deref() == Some("await") {
                LAZY_AWAIT.to_string()
            } else {
                format!(
                    "'lazy' defers a TRAVERSAL, and the entry '{name}' has none to defer — write 'lazy <source>-[:Edge]->', or drop 'lazy' and give the entry a value"
                )
            });
        }
        if let Some(word) = word
            && NODE_ENTRY_EFFECTS.contains(&word.as_str())
        {
            return self.fail(format!(
                "A node literal only computes — '{word}' acts, and a node's entries can't. Move the '{word}' above the literal and read its result in the entry '{name}'"
            ));
        }
        Ok(())
    }

    /// `files: m-[a:Attachments]-> node { … }` — PER-ITEM synthesis; same
    /// line only.
    fn try_parse_per_item_tail(&mut self) -> SResult<Option<NodeLiteral>> {
        self.skip_inline_ws();
        if !self.at_node_literal() {
            return Ok(None);
        }
        let node_start = self.pos;
        self.pos += "node".len();
        Ok(Some(self.parse_node_literal(node_start)?))
    }

    // ── Graph literals ──

    /// Is `graph { … }` or `graph<Shape> { … }` next? Contextual.
    fn at_graph_literal(&mut self) -> bool {
        if !self.at_word("graph") {
            return false;
        }
        let save = self.pos;
        self.pos += "graph".len();
        self.skip_inline_ws();
        let mut opens = false;
        if self.is('{') {
            opens = true;
        } else if self.is('<') {
            self.pos += 1;
            self.skip_inline_ws();
            if let Some((_, end)) = scan_name(self.src.units(), self.pos) {
                self.pos = end;
                self.skip_inline_ws();
                if self.is('>') {
                    self.pos += 1;
                    self.skip_inline_ws();
                    opens = self.is('{');
                }
            }
        }
        self.pos = save;
        opens
    }

    /// `graph<Shape> { … }` with `graph` at the cursor; `start` is its offset.
    fn parse_graph_literal(&mut self, start: usize) -> SResult<NodeLiteral> {
        self.pos += "graph".len();
        self.skip_inline_ws();
        let mut shape = None;
        if self.is('<') {
            let marker_start = self.pos;
            self.pos += 1;
            self.skip_inline_ws();
            let name = self.read_name("the node declaration inside 'graph<…>'")?;
            self.skip_inline_ws();
            self.expect(">", &format!("to close 'graph<{name}'"))?;
            shape = Some(NamedSpan { name, span: self.span_from(marker_start) });
        }
        self.parse_graph_body(start, GraphForm { shape })
    }

    /// A graph literal's body: a write body's field syntax, read with the
    /// node literal's entry rules; the write body's own words are refused.
    fn parse_graph_body(&mut self, start: usize, form: GraphForm) -> SResult<NodeLiteral> {
        self.deeper(|p| {
            p.skip_inline_ws();
            let brace_offset = p.pos;
            p.expect("{", "to open the graph literal")?;
            let mut entries = Vec::new();
            let mut spreads = Vec::new();
            loop {
                p.skip_all_ws();
                if p.eof() {
                    return p.fail_at("Expected '}' to close the graph literal", brace_offset);
                }
                if p.is('}') {
                    p.pos += 1;
                    return Ok(NodeLiteral {
                        entries,
                        graph: Some(form),
                        spreads: (!spreads.is_empty()).then_some(spreads),
                        span: p.span_from(start),
                    });
                }
                if p.is(',') {
                    p.pos += 1;
                    continue;
                }
                let spread_start = p.pos;
                if let Some(spread) = p.try_parse_write_spread()? {
                    if spread.semantics == Some(FieldWriteMode::Fill) {
                        let source = &spread.source;
                        return p.fail_at(
                            format!(
                                "'?...{source}' fills only the fields that are still empty, and a graph literal starts empty — write '...{source}'"
                            ),
                            spread_start,
                        );
                    }
                    let source = spread.source;
                    spreads.push(MapSpread {
                        source: source.clone(),
                        path: spread.path,
                        after: entries.len(),
                        span: spread.span,
                    });
                    p.finish_node_entry(&source)?;
                    continue;
                }
                if p.at_word("unique") {
                    return p.fail(
                        "'unique by' says how a write finds the record it changes, and a graph literal finds nothing — it builds a new local graph",
                    );
                }
                entries.push(p.parse_graph_entry()?);
            }
        })
    }

    /// `name: <value>` in a graph body.
    fn parse_graph_entry(&mut self) -> SResult<NodeEntry> {
        let entry_start = self.pos;
        let name = self.read_name("a field name in the graph literal")?;
        self.skip_inline_ws();
        for op in ["+?:", "+:", "?:"] {
            if self.starts_with(op) {
                return self.fail(format!(
                    "'{name} {op}' merges into a value already there, and a graph literal starts empty — write '{name}: …'"
                ));
            }
        }
        self.expect(":", &format!("after the field name '{name}'"))?;
        self.skip_inline_ws();

        if self.is('{') {
            let node = self.parse_graph_body(self.pos, GraphForm { shape: None })?;
            self.finish_node_entry(&name)?;
            return Ok(NodeEntry::Nodes { name, nodes: vec![node], span: self.span_from(entry_start) });
        }
        if self.is('[') {
            let save = self.pos;
            if let Some(nodes) = self.try_parse_graph_body_list()? {
                self.finish_node_entry(&name)?;
                return Ok(NodeEntry::Nodes { name, nodes, span: self.span_from(entry_start) });
            }
            self.pos = save;
        }
        self.refuse_in_graph_body(&name)?;
        let save = self.pos;
        if let Some(head) = self.try_parse_path_head()? {
            self.skip_inline_ws();
            let mapping =
                if self.is('{') { Some(self.parse_graph_body(self.pos, GraphForm { shape: None })?) } else { None };
            self.finish_node_entry(&name)?;
            return Ok(NodeEntry::Traversal { name, head, lazy: false, mapping, span: self.span_from(entry_start) });
        }
        self.pos = save;
        self.refuse_non_entry_value(&name, false)?;
        let (slot, stop) = self.read_expr_slot(Scan::new(",\n}", format!("for the field '{name}'")))?;
        if stop == Some(unit(',')) {
            self.pos += 1;
        }
        let span = Span { start: self.loc_at(entry_start), end: slot.span.end };
        Ok(NodeEntry::Value { name, value: slot, span })
    }

    /// `[{ … }, { … }]` — the plural child, or `None` for a list value.
    fn try_parse_graph_body_list(&mut self) -> SResult<Option<Vec<NodeLiteral>>> {
        self.pos += 1;
        let mut nodes = Vec::new();
        loop {
            self.skip_all_ws();
            if self.eof() {
                return Ok(None);
            }
            if self.is(']') {
                self.pos += 1;
                return Ok((!nodes.is_empty()).then_some(nodes));
            }
            if self.is(',') {
                self.pos += 1;
                continue;
            }
            if !self.is('{') {
                return Ok(None);
            }
            nodes.push(self.parse_graph_body(self.pos, GraphForm { shape: None })?);
        }
    }

    /// The node literal's entry spellings, refused inside a graph body.
    fn refuse_in_graph_body(&mut self, name: &str) -> SResult<()> {
        if self.at_node_literal() || self.at_graph_literal() {
            return self.fail(format!(
                "inside a graph literal a child node is written as its body alone — '{name}: {{ … }}'"
            ));
        }
        if self.is('<') {
            return self.fail(format!(
                "'{name}: <…>' declares an empty edge, which is the node literal's spelling — in a graph literal, give the graph a shape ('graph<Shape> {{ … }}') and every child node it declares starts empty"
            ));
        }
        if self.at_lazy() {
            return self.fail(format!(
                "a graph literal's bare walk already holds references to the records, so their fields read live — drop 'lazy'; to put off the walk itself, make it a function ('{name} = () => …') and call it where it is needed"
            ));
        }
        Ok(())
    }

    // ── Calls ──

    fn parse_call_statement(&mut self, callee: String, start: usize) -> SResult<CallStatement> {
        self.pos += 1;
        let args = self.parse_call_args(&callee, start)?;
        let call = self.call_node(callee, args, start);
        self.expect_statement_end()?;
        Ok(call)
    }

    /// The call just read, from `start` to here — with its reading as one
    /// expression when its arguments are positional.
    fn call_node(&self, callee: String, args: Vec<CallArg>, start: usize) -> CallStatement {
        let span = self.span_from(start);
        let positional = args.first().is_some_and(|arg| arg.name().is_none());
        let expression = positional.then(|| self.slot(self.text(start, self.pos), span));
        CallStatement { callee, args, expression, span }
    }

    /// `node { … }` or `graph<Shape> { … }` where an argument is written.
    fn try_parse_position_literal(&mut self) -> SResult<Option<NodeLiteral>> {
        let start = self.pos;
        if self.at_node_literal() {
            self.pos += "node".len();
            return Ok(Some(self.parse_node_literal(start)?));
        }
        if self.at_graph_literal() {
            return Ok(Some(self.parse_graph_literal(start)?));
        }
        Ok(None)
    }

    /// A call's argument list — all positional or all named — with the
    /// opening `(` consumed; consumes through the closing `)`.
    fn parse_call_args(&mut self, callee: &str, start: usize) -> SResult<Vec<CallArg>> {
        self.deeper(|p| p.parse_call_args_here(callee, start))
    }

    fn parse_call_args_here(&mut self, callee: &str, start: usize) -> SResult<Vec<CallArg>> {
        let mut args: Vec<CallArg> = Vec::new();
        loop {
            self.skip_all_ws();
            if self.eof() {
                return self.fail_at(format!("Expected ')' to close the call to '{callee}'"), start);
            }
            if self.is(')') {
                self.pos += 1;
                break;
            }
            let arg_start = self.pos;
            let name = self.read_call_arg_name();
            // Positional arguments arrived with language version 3.
            if name.is_none() && !since(self.version, 3) {
                return self.fail_at(
                    format!(
                        "Arguments to '{callee}' are named — write each as '<parameter>: <value>', naming '{callee}'s parameters in order (e.g. {callee}(param: value))"
                    ),
                    arg_start,
                );
            }
            self.refuse_mixed_args(callee, &args, name.as_deref(), arg_start)?;
            // A function written in place and a type: what `MAP` and `MEMBERS`
            // take from version 3, read for every callee.
            if since(self.version, 3) && self.at_closure() {
                let closure = self.parse_closure(self.pos, ",)")?;
                args.push(CallArg::Closure { name, span: closure.span, closure });
                self.end_call_arg("closure")?;
                continue;
            }
            if since(self.version, 3) && self.is('<') {
                let type_start = self.pos;
                let marker = self.read_type_marker(
                    "for a type argument — a type you declare (<Thesis>) or another field's option set (<crm-[:companies]->.`funding_stage`>)",
                    FIELD_TAIL,
                )?;
                args.push(CallArg::Type { name, type_: marker.text, span: self.span_from(type_start) });
                self.end_call_arg("type")?;
                continue;
            }
            self.refuse_named_node_as_value()?;
            if let Some(node) = self.try_parse_position_literal()? {
                args.push(CallArg::Node { name, node });
                self.skip_all_ws();
                if self.is(',') {
                    self.pos += 1;
                } else if !self.is(')') {
                    return self.fail(format!("Expected ',' or ')' after the node argument, found {}", self.describe_here()));
                }
                continue;
            }
            if self.at_lazy() {
                let pass = match &name {
                    Some(name) => format!("'{name}: files'"),
                    None => "'files'".to_string(),
                };
                return self.fail(format!(
                    "'lazy' defers a traversal, and an argument takes a value or a position — bind the deferred traversal above ('files = lazy …') and pass {pass}, or hand it through a 'node {{ {}: lazy … }}'",
                    name.as_deref().unwrap_or("files")
                ));
            }
            if self.at_word("write") {
                let write_start = self.pos;
                self.pos += "write".len();
                let write = self.parse_write_expression(write_start)?;
                args.push(CallArg::Write { name, write });
                self.skip_all_ws();
                if self.is(',') {
                    self.pos += 1;
                } else if !self.is(')') {
                    return self.fail(format!(
                        "Expected ',' or ')' after the write argument, found {}",
                        self.describe_here()
                    ));
                }
                continue;
            }
            // A CALL passed on — parsed structurally, because a call's value is
            // a node, and an expression cannot hold one.
            if let Some(nested) = self.try_parse_invocation_call(",)")? {
                args.push(CallArg::Call { name, call: nested });
                self.skip_all_ws();
                if self.is(',') {
                    self.pos += 1;
                }
                continue;
            }
            let which = match &name {
                Some(name) => format!("'{name}'"),
                None => (args.len() + 1).to_string(),
            };
            let (slot, stop) = self.read_expr_slot(Scan::new(",)", format!("for the argument {which} of '{callee}'")))?;
            args.push(CallArg::Expr { name, expr: slot });
            if stop == Some(unit(',')) {
                self.pos += 1;
            }
        }
        Ok(args)
    }

    /// A named argument's `<parameter>:` prefix, consumed — or `None`,
    /// consuming nothing, for a positional one.
    fn read_call_arg_name(&mut self) -> Option<String> {
        let (name, end) = scan_name(self.src.units(), self.pos)?;
        let save = self.pos;
        self.pos = end;
        self.skip_inline_ws();
        if self.try_consume(":") {
            self.skip_inline_ws();
            return Some(name);
        }
        self.pos = save;
        None
    }

    /// After an argument read by its own grammar: the `,` that ends it, or
    /// the `)` that closes the call.
    fn end_call_arg(&mut self, what: &str) -> SResult<()> {
        self.skip_all_ws();
        if self.is(',') {
            self.pos += 1;
        } else if !self.is(')') {
            return self.fail(format!("Expected ',' or ')' after the {what} argument, found {}", self.describe_here()));
        }
        Ok(())
    }

    /// One call is all positional or all named — never a mix.
    fn refuse_mixed_args(&self, callee: &str, earlier: &[CallArg], name: Option<&str>, at: usize) -> SResult<()> {
        let Some(first) = earlier.first() else { return Ok(()) };
        if first.name().is_none() == name.is_none() {
            return Ok(());
        }
        self.fail_at(
            match name {
                None => format!(
                    "The arguments to '{callee}' are named, and this one isn't — a call passes every argument by position ('{callee}(a, b)') or every one by name ('{callee}(x: a, y: b)'), never a mix"
                ),
                Some(name) => format!(
                    "The arguments to '{callee}' are positional, and '{name}:' names this one — a call passes every argument by position ('{callee}(a, b)') or every one by name ('{callee}(x: a, y: b)'), never a mix"
                ),
            },
            at,
        )
    }

    /// A whole call written where a value goes, ending where the value does:
    /// at one of `stops`, or at the end of input. Consumes nothing otherwise.
    fn try_parse_invocation_call(&mut self, stops: &str) -> SResult<Option<CallStatement>> {
        if !self.at_named_invocation() && !self.at_positional_invocation() {
            return Ok(None);
        }
        let save = self.pos;
        let callee = self.read_name("the name being called")?;
        self.skip_inline_ws();
        self.pos += 1;
        let args = self.parse_call_args(&callee, save)?;
        let call = self.call_node(callee, args, save);
        let end = self.pos;
        self.skip_inline_ws();
        match self.peek() {
            None => {
                self.pos = end;
                Ok(Some(call))
            }
            Some(next) if in_set(next, stops) => {
                self.pos = end;
                Ok(Some(call))
            }
            Some(_) => {
                self.pos = save;
                Ok(None)
            }
        }
    }

    /// Is a POSITIONAL invocation next — `f(a, …)`? A reserved word of the
    /// expression grammar is grammar, not a name, unless backtick-quoted.
    fn at_positional_invocation(&mut self) -> bool {
        if !since(self.version, 3) {
            return false;
        }
        let save = self.pos;
        let Some((name, end)) = scan_name(self.src.units(), self.pos) else {
            return false;
        };
        if !self.is('`') && KEYWORDS.contains(&name.to_ascii_uppercase().as_str()) {
            return false;
        }
        self.pos = end;
        self.skip_inline_ws();
        let mut positional = false;
        if self.is('(') {
            self.pos += 1;
            self.skip_all_ws();
            positional = !self.eof() && !self.is(')') && self.read_call_arg_name().is_none();
        }
        self.pos = save;
        positional
    }

    // ── link / edge arrows ──

    fn parse_edge_parts(&mut self) -> SResult<(String, String, String)> {
        self.skip_inline_ws();
        let from = self.read_name("the edge's source — a bound name")?;
        self.skip_inline_ws();
        self.expect("-[", "to begin the edge arrow '-[:name]->'")?;
        self.expect(":", "after '-[' in the edge arrow")?;
        let edge = self.read_name("the edge name")?;
        self.expect("]", &format!("after the edge name '{edge}'"))?;
        self.expect("->", "to complete the edge arrow")?;
        self.skip_inline_ws();
        let to = self.read_name("the edge's target — a bound name")?;
        Ok((from, edge, to))
    }

    /// After the `link` keyword: `from -[:edge]->`, then a bound name or a
    /// match body. The body form desugars here into the match of the hop.
    fn parse_link_expression(&mut self, start: usize) -> SResult<LinkExpression> {
        self.skip_inline_ws();
        let from_start = self.pos;
        let from = self.read_name("the link's source — a bound name")?;
        self.skip_inline_ws();
        let arrow_start = self.pos;
        self.expect("-[", "to begin the link arrow '-[:name]->'")?;
        self.expect(":", "after '-[' in the link arrow")?;
        let edge = self.read_name("the edge name")?;
        self.expect("]", &format!("after the edge name '{edge}'"))?;
        self.expect("->", "to complete the link arrow")?;
        let hops_raw = self.text(arrow_start, self.pos);
        let path_span = self.span_from(from_start);
        self.skip_inline_ws();
        let target_start = self.pos;
        let mut explicit_type = None;
        if self.is('<') {
            explicit_type = Some(self.read_type_marker("for the found type", PLAIN)?.text);
        } else if !self.is('{') {
            let Some((name, end)) = scan_name(self.src.units(), self.pos) else {
                return self.fail_at(
                    format!(
                        "Expected a bound handle or a match body '{{ … }}' after the link arrow, found {}",
                        self.describe_here()
                    ),
                    target_start,
                );
            };
            self.pos = end;
            self.skip_inline_ws();
            if self.is('{') {
                // `link c -[:e]-> Companies { … }` — a type without brackets.
                return self.fail_at(
                    format!("Types are written in angle brackets — wrap the type in angle brackets: <{name}>"),
                    target_start,
                );
            }
            self.pos = end;
            return Ok(LinkExpression { from, edge, to: LinkTarget::Handle { name }, span: self.span_from(start) });
        }
        let target_span = self.span_from(from_start);
        let body_start = self.pos;
        let (unique_by, fields) = self.parse_match_body(Finder::Link)?;
        let path = PathHead { root: Some(PathRoot::Name { name: from.clone() }), hops_raw, span: path_span };
        let implied_identity = unique_by.is_empty() && !fields.is_empty();
        let unique_by =
            if implied_identity { vec![self.link_body_identity(&fields, self.span_from(body_start))] } else { unique_by };
        let r#match = MatchExpression {
            target: WriteTarget::Linked { path, explicit_type, span: target_span },
            unique_by,
            fields,
            span: self.span_from(from_start),
        };
        Ok(LinkExpression { from, edge, to: LinkTarget::Match { r#match, implied_identity }, span: self.span_from(start) })
    }

    /// The identity of a `link` body that names none: all of its fields,
    /// exactly — one clause, an AND over every field it asserts.
    fn link_body_identity(&self, fields: &[FieldEntry], span: Span) -> UniqueClause {
        let raw = fields.iter().map(|field| spell_name(&field.name)).collect::<Vec<_>>().join(", ");
        UniqueClause { predicate: self.slot(raw, span), span }
    }

    fn parse_link_statement(&mut self) -> SResult<LinkStatement> {
        let start = self.pos;
        self.pos += "link".len();
        let link = self.parse_link_expression(start)?;
        self.expect_statement_end()?;
        Ok(LinkStatement { link, span: self.span_from(start) })
    }

    /// `unlink a -[:e]-> b` — the inverse of the bare-handle `link`.
    fn parse_unlink_statement(&mut self) -> SResult<UnlinkStatement> {
        let start = self.pos;
        self.pos += "unlink".len();
        let (from, edge, to) = self.parse_edge_parts()?;
        self.expect_statement_end()?;
        Ok(UnlinkStatement { from, edge, to, span: self.span_from(start) })
    }

    /// `delete <handle>`.
    fn parse_delete_statement(&mut self) -> SResult<DeleteStatement> {
        let start = self.pos;
        self.pos += "delete".len();
        self.skip_inline_ws();
        let name = self.read_name("the handle to delete — a bound name after 'delete'")?;
        self.expect_statement_end()?;
        Ok(DeleteStatement { name, span: self.span_from(start) })
    }

    /// `refresh <handle>`.
    fn parse_refresh_statement(&mut self) -> SResult<RefreshStatement> {
        let start = self.pos;
        self.pos += "refresh".len();
        self.skip_inline_ws();
        let name_start = self.pos;
        let name = self.read_name("the handle to refresh — a bound name after 'refresh'")?;
        let name_span = self.span_from(name_start);
        self.expect_statement_end()?;
        Ok(RefreshStatement { name, name_span, span: self.span_from(start) })
    }

    // ── await ──

    /// `await <head>-[:Edge WHERE …]->`, `await FIRST(…)`, `await sleep(…)`,
    /// `await until(…)`, `await race(…)` / `await parallel(…)`. `start` is the
    /// keyword's position; `pos` is just past it.
    fn parse_await(&mut self, start: usize) -> SResult<AwaitExpression> {
        self.skip_inline_ws();
        let source_start = self.pos;
        if self.at_word("sleep") {
            let save = self.pos;
            self.pos += "sleep".len();
            self.skip_inline_ws();
            if self.is('(') {
                self.pos += 1;
                self.skip_inline_ws();
                let duration = self.parse_duration()?;
                self.skip_inline_ws();
                self.expect(")", "to close 'await sleep(<duration>)'")?;
                return Ok(AwaitExpression {
                    source: AwaitSource::Sleep { duration, span: self.span_from(source_start) },
                    span: self.span_from(start),
                });
            }
            self.pos = save;
        }
        if self.at_word("until") {
            let save = self.pos;
            self.pos += "until".len();
            self.skip_inline_ws();
            if self.is('(') {
                self.pos += 1;
                self.skip_all_ws();
                if self.is('{') {
                    return self.fail(
                        "an 'until' condition that needs statements is a closure: `await until(() => { refresh a; return a.`State` == \"done\" }, every: 5m)`",
                    );
                }
                let condition = if self.at_closure() {
                    UntilCondition::Closure { closure: self.parse_closure(self.pos, ",)")? }
                } else {
                    let (slot, _) = self.read_expr_slot(Scan::new(",)", "for the 'until' condition"))?;
                    UntilCondition::Expr { expr: slot }
                };
                self.skip_all_ws();
                // The cadence is the only other thing an `until` takes, and it
                // is NAMED.
                let mut every = None;
                if self.is(',') {
                    self.pos += 1;
                    self.skip_all_ws();
                    let arg_start = self.pos;
                    // From version 5 the cadence is a setting: `{ every: 1h }`.
                    let settings = since(self.version, 5) && self.is('{');
                    if settings {
                        self.pos += 1;
                        self.skip_all_ws();
                    }
                    if !self.at_word("every") {
                        return self.fail_at(UNTIL_CADENCE_IS_NAMED, arg_start);
                    }
                    self.pos += "every".len();
                    self.skip_inline_ws();
                    self.expect(":", "after 'every' in 'await until(<condition>, every: <duration>)'")?;
                    self.skip_inline_ws();
                    every = Some(self.parse_duration()?);
                    self.skip_all_ws();
                    if settings {
                        self.expect("}", "to close 'await until(<condition>, { every: <duration> })'")?;
                        self.skip_all_ws();
                    } else if since(self.version, 5) {
                        let end = self.pos;
                        let written = self.text(arg_start, end).trim_end().to_string();
                        let written_end = arg_start + crate::util::form::utf16_len(&written);
                        self.spelling(
                            "from language version 5 `until`'s cadence is a setting: `{ every: … }`",
                            arg_start,
                            written_end,
                            vec![(arg_start, written_end, format!("{{ {written} }}"))],
                        );
                    }
                }
                self.expect(")", "to close 'await until(<condition>, every: <duration>)'")?;
                return Ok(AwaitExpression {
                    source: AwaitSource::Until { condition, every, span: self.span_from(source_start) },
                    span: self.span_from(start),
                });
            }
            self.pos = save;
        }
        if self.at_word("all") && before(self.version, 5) {
            self.refuse_retired_all(source_start)?;
        }
        for kind in [CombinatorKind::Race, CombinatorKind::Parallel, CombinatorKind::All] {
            if self.at_word(kind.word()) {
                let save = self.pos;
                self.pos += kind.word().len();
                self.skip_inline_ws();
                if self.is('(') {
                    let combinator = self.parse_combinator(source_start, kind)?;
                    return Ok(AwaitExpression {
                        source: AwaitSource::Combinator { combinator, span: self.span_from(source_start) },
                        span: self.span_from(start),
                    });
                }
                self.pos = save;
            }
        }
        if self.at_word("FIRST") {
            let save = self.pos;
            self.pos += "FIRST".len();
            self.skip_inline_ws();
            if self.is('(') {
                self.pos += 1;
                self.skip_inline_ws();
                let Some(head) = self.try_parse_path_head()? else {
                    return self.fail_at(
                        format!(
                            "Expected a traversal inside 'await FIRST(…)' (`await FIRST(a-[:Response]->)`), found {}",
                            self.describe_here()
                        ),
                        source_start,
                    );
                };
                self.skip_inline_ws();
                self.expect(")", "to close 'await FIRST(<traversal>)'")?;
                return Ok(AwaitExpression {
                    source: AwaitSource::First { head, span: self.span_from(source_start) },
                    span: self.span_from(start),
                });
            }
            self.pos = save;
        }
        let Some(head) = self.try_parse_path_head()? else {
            return self.fail_at(
                format!(
                    "Expected `await FIRST(a-[:Response]->)`, `await sleep(<duration>)`, or `await until(<condition>)` after 'await', found {}",
                    self.describe_here()
                ),
                source_start,
            );
        };
        Ok(AwaitExpression {
            source: AwaitSource::Traversal { head, span: self.span_from(source_start) },
            span: self.span_from(start),
        })
    }

    /// The unbound statement form; `parse_await` leaves the terminator to the
    /// caller.
    fn parse_await_statement(&mut self) -> SResult<AwaitStatement> {
        let start = self.pos;
        self.pos += "await".len();
        let r#await = self.parse_await(start)?;
        self.expect_statement_end()?;
        Ok(AwaitStatement { r#await, span: self.span_from(start) })
    }

    // ── the concurrency combinators ──

    /// `race([…])` / `parallel([…])` written as a STATEMENT; `None` when the
    /// word is an ordinary name here.
    fn try_parse_combinator_statement(&mut self, kind: CombinatorKind, start: usize) -> SResult<Option<CombinatorStatement>> {
        let save = self.pos;
        self.pos += kind.word().len();
        self.skip_inline_ws();
        if self.is('{') {
            return self.fail_at(self.parallel_block_retired(), start);
        }
        if !self.is('(') {
            self.pos = save;
            return Ok(None);
        }
        let combinator = self.parse_combinator(start, kind)?;
        self.expect_statement_end()?;
        Ok(Some(CombinatorStatement { combinator, span: self.span_from(start) }))
    }

    /// `all` is not a name any more where it leads a call.
    fn refuse_retired_all(&mut self, start: usize) -> SResult<()> {
        let save = self.pos;
        self.pos += "all".len();
        self.skip_inline_ws();
        let is_call = self.is('(');
        self.pos = save;
        if is_call {
            return self.fail_at(ALL_RETIRED, start);
        }
        Ok(())
    }

    /// The combinator a word leading a value names: `race` and `parallel` on
    /// every version, `all` from language version 5.
    fn combinator_named(&self, word: &str) -> Option<CombinatorKind> {
        match word {
            "race" => Some(CombinatorKind::Race),
            "parallel" => Some(CombinatorKind::Parallel),
            "all" if since(self.version, 5) => Some(CombinatorKind::All),
            _ => None,
        }
    }

    fn parallel_block_retired(&self) -> String {
        if since(self.version, 5) {
            return format!("the `parallel {{ … }}` block was retired: {PARALLEL_AS_ALL}");
        }
        PARALLEL_BLOCK_RETIRED.to_string()
    }

    /// `race(<arms>)` / `parallel(<arms>)` / `all(<arms>)`; `pos` is just past
    /// the keyword. From language version 5 the arms are the call's
    /// ARGUMENTS — `race(q, () => { … })`, `all(f, g, { concurrency: 2 })` —
    /// as TypeScript's `Promise.all` takes its promises: a closure is not
    /// data, so there is no list of them to pass. A bracket is still read, so
    /// the checker can refuse it with the rewrite.
    fn parse_combinator(&mut self, start: usize, kind: CombinatorKind) -> SResult<CombinatorExpression> {
        let k = kind.word();
        self.skip_inline_ws();
        self.expect("(", &format!("to open '{k}(…)'"))?;
        self.skip_all_ws();
        let v5 = since(self.version, 5);
        if self.is('{') {
            return self.fail_at(if v5 { RACE_BRANCHES_RETIRED_V5 } else { RACE_BRANCHES_RETIRED }, start);
        }
        if v5 && !self.is('[') {
            return self.parse_argument_arms(start, kind);
        }
        let arms = if self.is('[') { self.parse_literal_arms(kind)? } else { self.parse_dynamic_arms(kind)? };
        self.skip_all_ws();
        self.expect(")", &format!("to close '{k}([…])'"))?;
        Ok(CombinatorExpression { kind, arms, settings: None, span: self.span_from(start) })
    }

    /// `race(q, () => { … })` / `all(f, g, { concurrency: 2 })` (language
    /// version 5): each argument an arm — a closure written in place, or a
    /// function's name — and, last, the settings record `all` may be given.
    /// `pos` is just past the `(`.
    fn parse_argument_arms(&mut self, start: usize, kind: CombinatorKind) -> SResult<CombinatorExpression> {
        let k = kind.word();
        let arms_start = self.pos;
        let mut arms = Vec::new();
        let mut settings = None;
        loop {
            self.skip_all_ws();
            if self.eof() {
                return self.fail_at(format!("Expected an arm or ')' to close '{k}(…)'"), start);
            }
            if self.is(')') {
                break;
            }
            if self.is('{') {
                // The settings record — the last argument, as `MAP`'s is the
                // one before its function.
                settings = Some(self.read_expr_slot(Scan::new(",)", format!("for the settings '{k}' runs with")))?.0);
                self.skip_all_ws();
                if self.is(',') {
                    self.pos += 1;
                }
                self.skip_all_ws();
                if !self.is(')') {
                    return self.fail(format!("'{k}' takes its settings last — `{k}(f, g, {{ concurrency: 2 }})`"));
                }
                break;
            }
            arms.push(self.parse_arm(k, "An argument of")?);
            self.skip_all_ws();
            if self.is(',') {
                self.pos += 1;
                continue;
            }
            if self.is(')') {
                break;
            }
            return self.fail(format!("Expected ',' between arms or ')' to close '{k}(…)', found {}", self.describe_here()));
        }
        let arms_span = self.span_from(arms_start);
        self.expect(")", &format!("to close '{k}(…)'"))?;
        if arms.is_empty() {
            return self.fail_at(
                match kind {
                    CombinatorKind::Race => {
                        "A race over no arms can never settle — give it at least one function to run: `race(q, () => { await sleep(4h) })`"
                            .to_string()
                    }
                    CombinatorKind::Parallel | CombinatorKind::All => {
                        format!("'{k}' over no functions runs nothing — give it at least one: `{k}(f, g)`")
                    }
                },
                start,
            );
        }
        Ok(CombinatorExpression { kind, arms: CombinatorArms::Arguments { arms, span: arms_span }, settings, span: self.span_from(start) })
    }

    /// `[f, () => { … }]` — the arms written down.
    fn parse_literal_arms(&mut self, kind: CombinatorKind) -> SResult<CombinatorArms> {
        let k = kind.word();
        let start = self.pos;
        self.pos += 1;
        let mut arms = Vec::new();
        loop {
            self.skip_all_ws();
            if self.eof() {
                return self.fail_at(format!("Expected an arm or ']' to close '{k}([…])'"), start);
            }
            if self.is(']') {
                self.pos += 1;
                break;
            }
            arms.push(self.parse_arm(k, "An arm of")?);
            self.skip_all_ws();
            if self.is(',') {
                self.pos += 1;
                continue;
            }
            if self.is(']') {
                self.pos += 1;
                break;
            }
            return self.fail(format!("Expected ',' between arms or ']' to close, found {}", self.describe_here()));
        }
        if arms.is_empty() {
            return self.fail_at(
                match kind {
                    CombinatorKind::Race => {
                        "A race over no arms can never settle — give it at least one function to run: `await race([q, () => { await sleep(4h) }])`"
                    }
                    CombinatorKind::Parallel | CombinatorKind::All => {
                        "A parallel over no arms runs nothing — give it at least one function: `await parallel([f, g])`"
                    }
                },
                start,
            );
        }
        Ok(CombinatorArms::Literal { arms, span: self.span_from(start) })
    }

    /// A function written where a function VALUE is expected — a closure in
    /// place, or the name of one.
    fn parse_arm(&mut self, what: &str, role: &str) -> SResult<ArmExpression> {
        let start = self.pos;
        if self.at_closure() {
            let closure = self.parse_closure(start, ",)]")?;
            return Ok(ArmExpression::Closure { closure, span: self.span_from(start) });
        }
        if self.is('{') {
            return self.fail_at(
                format!("{role} '{what}' is a FUNCTION, not a block — wrap the statements in a closure: `() => {{ … }}`"),
                start,
            );
        }
        let name = if self.is('`') { Some(self.read_backtick_name()?) } else { self.peek_ident() };
        let Some(name) = name.filter(|name| !name.is_empty()) else {
            return self.fail_at(
                format!(
                    "Expected {} '{what}' — a function's name, or a closure (`() => {{ … }}`) — found {}",
                    role.to_lowercase(),
                    self.describe_here()
                ),
                start,
            );
        };
        // TypeScript advances past the name unless the next character is a
        // backtick — even after a backtick name, which it has already passed.
        // The port keeps the double step.
        if !self.is('`') {
            self.pos += utf16_len(&name);
        }
        self.skip_inline_ws();
        if self.is('(') {
            return self.fail_at(
                format!(
                    "'{name}(…)' CALLS the function here; '{what}' is given the function itself, so it can call it. Write '{name}', or wrap the call: `() => {{ {name}(…) }}`"
                ),
                start,
            );
        }
        Ok(ArmExpression::Ref { name, span: self.span_from(start) })
    }

    // ── the collection ops ──

    /// `MAP(xs, f)` and its siblings; `REDUCE(xs, init, f)`; `MAP(xs, { … }, f)`.
    fn parse_collection_op(&mut self, start: usize, spelling: &str, op: CollectionOp) -> SResult<CollectionOpExpression> {
        self.skip_inline_ws();
        self.expect("(", &format!("to open '{spelling}(…)'"))?;
        let configurable = matches!(op, CollectionOp::Map | CollectionOp::Filter);
        let shape = if op == CollectionOp::Reduce {
            format!("{spelling}(<collection>, <starting value>, <function>)")
        } else if configurable {
            format!("{spelling}(<collection>, <function>) or {spelling}(<collection>, {{ <settings> }}, <function>)")
        } else {
            format!("{spelling}(<collection>, <function>)")
        };
        let source = self.read_collection_arg(spelling, &format!("the collection '{spelling}' reads"), &shape)?;
        let init = if op == CollectionOp::Reduce {
            Some(self.read_collection_arg(spelling, &format!("the value '{spelling}' starts from"), &shape)?)
        } else {
            None
        };
        self.skip_all_ws();
        let config = if configurable && self.is('{') {
            Some(self.read_collection_arg(spelling, &format!("the settings '{spelling}' runs with"), &shape)?)
        } else {
            None
        };
        self.skip_all_ws();
        let fn_start = self.pos;
        let r#fn = self.parse_arm(spelling, "The function for")?;
        self.skip_all_ws();
        if configurable && config.is_none() && self.is(',') {
            return self.fail_at(
                format!(
                    "'{spelling}' takes its settings as a record written in place, between the collection and the function — `{spelling}(xs, {{ onError: \"warn\", concurrency: 4 }}, f)`"
                ),
                fn_start,
            );
        }
        self.expect(")", &format!("to close '{spelling}(…)'"))?;
        Ok(CollectionOpExpression { op, source, init, config, r#fn, span: self.span_from(start) })
    }

    /// One value argument of a collection op, up to the comma that ends it.
    fn read_collection_arg(&mut self, spelling: &str, what: &str, shape: &str) -> SResult<ExprSlot> {
        let start = self.pos;
        let (slot, stop) = self.read_expr_slot(Scan::new(",)", format!("for {what}")))?;
        if stop != Some(unit(',')) {
            return self.fail(format!("'{spelling}' takes {shape} — the function is missing"));
        }
        self.pos += 1;
        if let Some(nested) = nested_collection_value(&slot.raw) {
            return self.fail_at(
                format!(
                    "'{nested}' is read on its own line, not inside '{spelling}(…)' — bind it first, then pass the name: `answer = {nested}(…)` then `{spelling}(answer, …)`"
                ),
                start,
            );
        }
        Ok(slot)
    }

    /// `MEMBERS(<Thesis>)` — the argument is a TYPE.
    fn parse_members(&mut self, start: usize) -> SResult<MembersExpression> {
        self.skip_inline_ws();
        self.expect("(", "to open 'MEMBERS(<…>)'")?;
        self.skip_all_ws();
        let type_start = self.pos;
        let marker = self.read_type_marker(
            "for 'MEMBERS' — a type you declare (<Thesis>) or another field's option set (<crm-[:companies]->.`funding_stage`>)",
            FIELD_TAIL,
        )?;
        let type_span = self.span_from(type_start);
        self.skip_all_ws();
        self.expect(")", "to close 'MEMBERS(<…>)'")?;
        Ok(MembersExpression { type_: marker.text, span: self.span_from(start), type_span })
    }

    /// Arms built at run time — an ordinary expression.
    fn parse_dynamic_arms(&mut self, kind: CombinatorKind) -> SResult<CombinatorArms> {
        let start = self.pos;
        let (slot, _) = self.read_expr_slot(Scan::new(")", format!("for the arms of '{}(…)'", kind.word())))?;
        Ok(CombinatorArms::Dynamic { expr: slot, span: self.span_from(start) })
    }

    // ── callback ──

    /// `callback(<subject>)` / `callback(<subject>, { …config… })`.
    fn parse_callback(&mut self, start: usize) -> SResult<CallbackExpression> {
        self.skip_inline_ws();
        self.expect("(", "to open 'callback(…)'")?;
        self.skip_all_ws();
        let subject = self.parse_callback_subject()?;
        self.skip_all_ws();
        let mut config = Vec::new();
        let mut config_span = None;
        if self.is(',') {
            self.pos += 1;
            self.skip_all_ws();
            let config_start = self.pos;
            config = self.parse_callback_config()?;
            config_span = Some(self.span_from(config_start));
            self.skip_all_ws();
        }
        self.expect(")", "to close 'callback(…)'")?;
        Ok(CallbackExpression { subject, config, config_span, span: self.span_from(start) })
    }

    fn parse_callback_subject(&mut self) -> SResult<CallbackSubject> {
        let start = self.pos;
        // `callback()` — an anonymous movement with an empty body.
        if self.is(')') {
            let span = self.span_from(start);
            return Ok(CallbackSubject::Inline {
                closure: ClosureExpression { params: vec![], return_type: None, body: vec![], span },
                span,
            });
        }
        // `callback({ … })` — the closure with its parameter list elided.
        if self.is('{') {
            let body = self.parse_block_body("a callback body")?;
            let span = self.span_from(start);
            return Ok(CallbackSubject::Inline {
                closure: ClosureExpression { params: vec![], return_type: None, body, span },
                span,
            });
        }
        // `callback((d: <date>) => { … })` and body-less `callback((d: <date>))`.
        if self.is('(') {
            let closure_start = self.pos;
            self.pos += 1;
            let params = self.parse_param_list()?;
            self.skip_all_ws();
            if self.is(')') || self.is(',') {
                return Ok(CallbackSubject::Inline {
                    closure: ClosureExpression { params, return_type: None, body: vec![], span: self.span_from(closure_start) },
                    span: self.span_from(start),
                });
            }
            self.expect("=>", "between a callback's parameters and its body")?;
            self.skip_all_ws();
            let body = self.parse_block_body("a callback body")?;
            return Ok(CallbackSubject::Inline {
                closure: ClosureExpression { params, return_type: None, body, span: self.span_from(closure_start) },
                span: self.span_from(start),
            });
        }
        // `callback(<movementName>)` / `callback(<movementName>(…))`.
        let name_start = self.pos;
        let movement = self.read_name("a callback body ('{ … }' or '(<params>) => { … }') or the name of a movement")?;
        let name_span = self.span_from(name_start);
        let mut args = Vec::new();
        if self.is('(') {
            self.pos += 1;
            args = self.parse_call_args(&movement, name_start)?;
        }
        Ok(CallbackSubject::Named { movement, args, name_span, span: self.span_from(start) })
    }

    /// `{ once: FALSE, ttl: 2d }` — read as raw named args; the checker owns
    /// the vocabulary.
    fn parse_callback_config(&mut self) -> SResult<Vec<NamedArg>> {
        let brace_offset = self.pos;
        self.expect("{", "to open a callback's config (e.g. { once: FALSE, ttl: 2d })")?;
        let mut config = Vec::new();
        loop {
            self.skip_all_ws();
            if self.eof() {
                return self.fail_at("Expected '}' to close the callback's config", brace_offset);
            }
            if self.is('}') {
                self.pos += 1;
                return Ok(config);
            }
            if self.is(',') {
                self.pos += 1;
                continue;
            }
            let name = self.read_ident("a callback config key (e.g. 'once', 'ttl')")?;
            self.skip_inline_ws();
            self.expect(":", &format!("after the callback config key '{name}'"))?;
            let (slot, _) = self.read_expr_slot(Scan::new(",}\n", format!("for the callback config '{name}'")))?;
            config.push(NamedArg { name, value: slot, is_type: None });
        }
    }

    // ── return + closures ──

    /// `return <value>` — an ordinary right-hand side.
    fn parse_return_statement(&mut self) -> SResult<ReturnStatement> {
        let start = self.pos;
        self.pos += "return".len();
        self.skip_inline_ws();
        if self.eof() || self.is('\n') || self.is('}') || self.is(';') {
            return self.fail_at(
                "'return' hands a value back — write `return <value>`. A body that hands nothing back simply has no 'return'.",
                start,
            );
        }
        let value = self.parse_rvalue()?;
        self.expect_statement_end()?;
        Ok(ReturnStatement { value, span: self.span_from(start), concise: false })
    }

    /// Is this word immediately CALLED? Restores the position.
    fn followed_by_call(&mut self, word: &str) -> bool {
        let save = self.pos;
        self.pos += utf16_len(word);
        self.skip_inline_ws();
        let called = self.is('(');
        self.pos = save;
        called
    }

    /// Is the parser at `{ … }.name` — the retired inline block? Found by
    /// scanning to the matching brace; an unbalanced brace is "no".
    fn at_retired_inline_block(&mut self) -> bool {
        let save = self.pos;
        let found = (|| {
            self.pos += 1;
            self.scan_balanced(&Scan::new("}", "a brace-led value"))?;
            self.pos += 1;
            self.skip_inline_ws();
            Ok::<bool, ParseError>(self.is('.'))
        })();
        self.pos = save;
        found.unwrap_or(false)
    }

    /// Is the parser at `(<params>) => {`? The ARROW claims the form, found
    /// by scanning to the matching `)` and looking past it.
    fn at_closure(&mut self) -> bool {
        if !self.is('(') {
            return false;
        }
        let save = self.pos;
        let found = (|| {
            self.pos += 1;
            self.scan_balanced(&Scan::new(")", "a closure's parameter list"))?;
            self.pos += 1;
            self.parse_return_annotation()?;
            self.skip_all_ws();
            Ok::<bool, ParseError>(self.is('=') && self.is_at(1, '>'))
        })();
        self.pos = save;
        found.unwrap_or(false)
    }

    /// `(<params>) => { … }` — an anonymous closure; `start` is the `(`.
    fn parse_closure(&mut self, start: usize, stops: &str) -> SResult<ClosureExpression> {
        self.expect("(", "to open the closure parameter list")?;
        let params = self.parse_param_list()?;
        let return_type = self.parse_return_annotation()?;
        self.skip_all_ws();
        self.expect("=>", "between a closure's parameters and its body")?;
        self.skip_all_ws();
        // `(x) => x * 2` is `(x) => { return x * 2 }` with the ceremony elided
        // (language version 3).
        if !self.is('{') && since(self.version, 3) {
            // `(f) => f()` is `(f) => { return f() }` (language version 5): a body
            // that is one call returns the call, so a callee that waits parks the
            // run as a returned call does — inside an expression it could not.
            // `() => await sleep(1h)` is `() => { return await sleep(1h) }`
            // (language version 5), as TypeScript's `async () => await x` is — and
            // a retired `await race(…)` there is refused with its rewrite.
            if since(self.version, 5) && self.peek_ident().as_deref() == Some("await") {
                let await_start = self.pos;
                self.pos += "await".len();
                let awaited = self.parse_await(await_start)?;
                let body = vec![Statement::Return(ReturnStatement {
                    value: RValue::Await { r#await: awaited },
                    span: self.span_from(await_start),
                    concise: false,
                })];
                return Ok(ClosureExpression { params, return_type, body, span: self.span_from(start) });
            }
            // `() => all(f, g)` / `() => race(f, g)` (language version 5) returns
            // the combinator's answer, as a returned call does.
            if since(self.version, 5)
                && let Some(word) = self.peek_ident()
                && let Some(kind) = self.combinator_named(&word)
            {
                let word_start = self.pos;
                self.pos += kind.word().len();
                self.skip_inline_ws();
                if self.is('(') {
                    let combinator = self.parse_combinator(word_start, kind)?;
                    let body = vec![Statement::Return(ReturnStatement {
                        value: RValue::Combinator { combinator },
                        span: self.span_from(word_start),
                        concise: false,
                    })];
                    return Ok(ClosureExpression { params, return_type, body, span: self.span_from(start) });
                }
                self.pos = word_start;
            }
            if since(self.version, 5) {
                if let Some((value, span)) = self.concise_body_call(stops)? {
                    let body = vec![Statement::Return(ReturnStatement { value, span, concise: true })];
                    return Ok(ClosureExpression { params, return_type, body, span: self.span_from(start) });
                }
            }
            let (slot, _) = self.read_expr_slot(Scan::new(stops, "for the closure body"))?;
            let span = slot.span;
            let body = vec![Statement::Return(ReturnStatement { value: RValue::Expr { expr: slot }, span, concise: false })];
            return Ok(ClosureExpression { params, return_type, body, span: self.span_from(start) });
        }
        let body = self.parse_block_body("a closure body")?;
        Ok(ClosureExpression { params, return_type, body, span: self.span_from(start) })
    }

    /// A concise closure body that is ONE call and nothing more, as the value a
    /// `return` would hand back; `None` (consuming nothing) otherwise.
    fn concise_body_call(&mut self, stops: &str) -> SResult<Option<(RValue, Span)>> {
        let save = self.pos;
        if let Some(call) = self.try_parse_invocation_call(stops)? {
            let span = call.span;
            return Ok(Some((RValue::Call { call }, span)));
        }
        // `f()` — no argument to tell a call from a construction, so it is
        // recorded as `x = f()` is, and resolution decides.
        if let Some((name, end)) = scan_name(self.src.units(), self.pos) {
            if self.is('`') || !KEYWORDS.contains(&name.to_ascii_uppercase().as_str()) {
                self.pos = end;
                self.skip_inline_ws();
                if self.is('(') {
                    self.pos += 1;
                    self.skip_all_ws();
                    if self.is(')') {
                        self.pos += 1;
                        let span = self.span_from(save);
                        let end = self.pos;
                        self.skip_inline_ws();
                        let at_stop = match self.peek() {
                            None => true,
                            Some(next) => in_set(next, stops),
                        };
                        if at_stop {
                            self.pos = end;
                            let construct = ConstructionCall { callee: name, args: Vec::new(), span };
                            return Ok(Some((RValue::Construct { construct }, span)));
                        }
                    }
                }
            }
        }
        self.pos = save;
        Ok(None)
    }

    /// `{ …statements… }.binding` — the RETIRED inline block; `start` is `{`.
    fn parse_inline_block(&mut self, start: usize) -> SResult<InlineBlockExpression> {
        let body = self.parse_block_body("an inline block expression")?;
        self.skip_inline_ws();
        if !self.is('.') {
            return self.fail_at(
                format!(
                    "An inline block expression is read by one of its bindings — write `{{ … }}.name`, found {}",
                    self.describe_here()
                ),
                start,
            );
        }
        self.pos += 1;
        let binding_start = self.pos;
        let binding = self.read_name("a binding name after '{ … }.'")?;
        let binding_span = self.span_from(binding_start);
        Ok(InlineBlockExpression { body, binding, binding_span, span: self.span_from(start) })
    }

    // ── if ──

    fn parse_if(&mut self) -> SResult<IfStatement> {
        let start = self.pos;
        self.pos += "if".len();
        let mut arms = Vec::new();
        let mut else_arm = None;
        let mut arm_start = start;
        loop {
            // The condition runs up to the block's `{` and may wrap lines.
            self.skip_all_ws();
            let condition_start = self.pos;
            let (condition, stop) = self.read_expr_slot(Scan::new("{", "for the 'if' condition"))?;
            if stop != Some(unit('{')) {
                return self.fail("Expected '{' after the 'if' condition");
            }
            let condition_end = condition_start + crate::util::form::utf16_len(&condition.raw);
            self.require_condition_parens(&condition, condition_start, condition_end);
            let body = self.parse_block_body("the 'if' branch")?;
            arms.push(IfArm { condition, body, span: self.span_from(arm_start) });
            let save = self.pos;
            self.skip_all_ws();
            if !self.at_word("else") {
                self.pos = save;
                break;
            }
            let else_start = self.pos;
            self.pos += "else".len();
            self.skip_inline_ws();
            if self.at_word("if") {
                self.pos += "if".len();
                arm_start = else_start;
                continue;
            }
            let body = self.parse_block_body("the 'else' branch")?;
            else_arm = Some(ElseArm { body, span: self.span_from(else_start) });
            break;
        }
        Ok(IfStatement { arms, else_arm, span: self.span_from(start) })
    }

    /// A bare unit-suffixed duration literal; the unit grammar is the checker's.
    fn parse_duration(&mut self) -> SResult<DurationLiteral> {
        let start = self.pos;
        while self.peek().is_some_and(|c| c < 0x80 && (c as u8).is_ascii_alphanumeric()) {
            self.pos += 1;
        }
        let raw = self.text(start, self.pos);
        if !raw.bytes().any(|b| b.is_ascii_digit()) {
            return self.fail_at("Expected a duration literal (e.g. 4h, 2d, 90m, 1h30m)", start);
        }
        Ok(DurationLiteral { raw, span: self.span_from(start) })
    }

    /// `ERROR("message")` as a statement.
    fn parse_error_statement(&mut self) -> SResult<ErrorStatement> {
        let start = self.pos;
        let message = self.parse_error_call()?;
        self.expect_statement_end()?;
        Ok(ErrorStatement { message, span: self.span_from(start) })
    }

    fn parse_error_call(&mut self) -> SResult<ExprSlot> {
        let start = self.pos;
        let word = if since(self.version, 5) && self.at_word("fail") { "fail" } else { "ERROR" };
        self.expect_word(word, "an 'ERROR(…)' call")?;
        if word == "ERROR" && since(self.version, 5) {
            self.spelling("`ERROR` is written `fail` from language version 5", start, self.pos, vec![(start, self.pos, "fail".into())]);
        }
        self.skip_inline_ws();
        self.expect("(", if word == "fail" { "after 'fail'" } else { "after 'ERROR'" })?;
        let (slot, _) = self.read_expr_slot(Scan::new(")", "for the ERROR message"))?;
        self.expect(")", "to close the 'ERROR(…)' message")?;
        Ok(slot)
    }

    // ── node declarations ──

    /// `node doc { … }` — a NAMED node declaration, `node` at the cursor.
    fn parse_node_declaration(&mut self) -> SResult<ShapeDeclaration> {
        let start = self.pos;
        self.pos += "node".len();
        self.skip_inline_ws();
        let name = self.read_name("a name after 'node'")?;
        let base = self.parse_extends_clause(&name)?;
        let root = self.parse_declared_node(&name, start)?;
        Ok(ShapeDeclaration { name, root, extends: base, exported: None, span: self.span_from(start) })
    }

    /// `extends Entry` after a declaration's name. One base.
    fn parse_extends_clause(&mut self, name: &str) -> SResult<Option<NamedSpan>> {
        self.skip_inline_ws();
        if !self.at_word("extends") {
            return Ok(None);
        }
        let start = self.pos;
        self.pos += "extends".len();
        self.skip_inline_ws();
        let base = self.read_name(&format!(
            "the node declaration '{name}' extends, after 'extends' (`node {name} extends Entry {{ … }}`)"
        ))?;
        let span = self.span_from(start);
        self.skip_inline_ws();
        if self.is(',') || self.at_word("extends") {
            return self.fail(format!(
                "'{name}' extends one node declaration — declare the fields '{base}' shares with the other one as a node of their own, and extend that"
            ));
        }
        Ok(Some(NamedSpan { name: base, span }))
    }

    /// Is `type <name> = …` next? Consumes nothing.
    fn at_type_declaration(&mut self) -> bool {
        if !self.at_word("type") {
            return false;
        }
        let save = self.pos;
        self.pos += "type".len();
        self.skip_inline_ws();
        let mut declares = false;
        if self.peek().is_some_and(|c| is_ident_start(c) || c == unit('`')) && self.read_name("a name").is_ok() {
            self.skip_inline_ws();
            declares = self.is('=');
        }
        self.pos = save;
        declares
    }

    /// `type Thesis = <"A" | "B">`.
    fn parse_type_declaration(&mut self) -> SResult<TypeDeclaration> {
        let start = self.pos;
        self.pos += "type".len();
        self.skip_inline_ws();
        let name = self.read_name("a name after 'type'")?;
        self.skip_inline_ws();
        self.expect("=", &format!("after the declared type '{name}' (`type {name} = <\"A\" | \"B\">`)"))?;
        self.skip_inline_ws();
        self.expect("<", &format!("to open '{name}'s values (`<\"A\" | \"B\">`)"))?;
        let mut options = Vec::new();
        loop {
            self.skip_all_ws();
            if !self.is('"') {
                return self.fail(type_values_are_text(&name));
            }
            options.push(self.read_quoted_string(&format!("as a value of '{name}'"))?.0);
            self.skip_all_ws();
            if !self.try_consume("|") {
                break;
            }
        }
        self.expect(">", &format!("to close '{name}'s values"))?;
        self.expect_statement_end()?;
        Ok(TypeDeclaration { name, options, span: self.span_from(start) })
    }

    /// One node of a declaration tree: its fields, then its nested children.
    fn parse_declared_node(&mut self, name: &str, start: usize) -> SResult<ShapeNode> {
        self.deeper(|p| p.parse_declared_node_here(name, start))
    }

    fn parse_declared_node_here(&mut self, name: &str, start: usize) -> SResult<ShapeNode> {
        self.skip_inline_ws();
        let mut description = None;
        if self.try_consume(":") {
            self.skip_inline_ws();
            description = Some(self.read_string_slot(&format!("describing the node '{name}'"))?);
            self.skip_inline_ws();
        }
        if self.at_word("extends") {
            return self.fail(match &description {
                Some(description) => format!(
                    "'extends' comes straight after the name, before the node's words — write 'node {name} extends <base>: {} {{ … }}'",
                    description.raw
                ),
                None => "'extends' belongs to a node declared at the top level of the file — a nested node is spelled out where it is nested".to_string(),
            });
        }
        let brace_offset = self.pos;
        self.expect("{", &format!("to open the node '{name}'"))?;
        let mut fields = Vec::new();
        let mut children = Vec::new();
        loop {
            self.skip_all_ws();
            if self.eof() {
                return self.fail_at(format!("Expected '}}' to close the node '{name}'"), brace_offset);
            }
            if self.is('}') {
                self.pos += 1;
                break;
            }
            if self.at_word("edge") {
                return self.fail(format!(
                    "'edge' lines are retired — nest the node inside the one that reaches it, and the nesting IS the edge: 'node {name} {{ … node <edge name> {{ … }} }}'"
                ));
            }
            if self.at_node_literal() {
                return self.fail(format!(
                    "a nested node in the declaration '{name}' is NAMED, and its name is the relationship that reaches it — write 'node <edge name> {{ … }}'"
                ));
            }
            if self.at_word("node") {
                let child_start = self.pos;
                self.pos += "node".len();
                self.skip_inline_ws();
                let child_name = self.read_name("a name after 'node'")?;
                let mut child = self.parse_declared_node(&child_name, child_start)?;
                // `order by arrival` after the child's closing `}`.
                if let Some(sequenced) = self.try_parse_entry_ordering(&child_name)? {
                    child.sequenced = Some(sequenced);
                }
                self.expect_statement_end()?;
                children.push(child);
                continue;
            }
            let field_start = self.pos;
            let field_name = self.read_name("a field name")?;
            self.skip_inline_ws();
            self.expect(":", &format!("after the field name '{field_name}'"))?;
            self.skip_inline_ws();
            let marker =
                self.read_type_marker(&format!("for the field '{field_name}' (e.g. <text>, <number>)"), FIELD_TAIL_NULL)?;
            self.skip_inline_ws();
            let field_description = if self.is('"') {
                Some(self.read_string_slot(&format!("describing the field '{field_name}'"))?)
            } else {
                None
            };
            fields.push(ShapeField {
                name: field_name,
                type_: marker.text,
                nullable: marker.nullable.then_some(true),
                description: field_description,
                span: self.span_from(field_start),
            });
            self.expect_statement_end()?;
        }
        Ok(ShapeNode { name: name.to_string(), description, fields, children, sequenced: None, span: self.span_from(start) })
    }

    // ── export ──

    /// `export movement …` / `export node …`.
    fn parse_export(&mut self) -> SResult<Statement> {
        let start = self.pos;
        self.pos += "export".len();
        self.skip_inline_ws();
        let next = self.peek_ident();
        if let Some(keyword) = next.as_deref()
            && (keyword == "movement" || keyword == "function")
        {
            let mut declaration = self.parse_movement(keyword)?;
            declaration.exported = Some(true);
            declaration.span = self.span_from(start);
            return Ok(Statement::Movement(declaration));
        }
        if next.as_deref() == Some("node") && self.at_node_declaration() {
            let mut declaration = self.parse_node_declaration()?;
            declaration.exported = Some(true);
            declaration.span = self.span_from(start);
            return Ok(Statement::Shape(declaration));
        }
        self.fail_at(
            "'export' marks a declaration as offered to other files — write `export movement <name>(…) { … }` or `export node <name> { … }`",
            start,
        )
    }

    // ── movement ──

    /// `movement <name>(…) { … }` / `function <name>(…) { … }` — one
    /// declaration, two spellings; `keyword` is echoed by the diagnostics.
    fn parse_movement(&mut self, keyword: &str) -> SResult<MovementDeclaration> {
        let start = self.pos;
        if since(self.version, 5) && keyword == "movement" {
            self.spelling("from language version 5 a declaration is a `function`", start, start + keyword.len(), vec![(start, start + keyword.len(), "function".into())]);
        }
        self.pos += keyword.len();
        self.skip_inline_ws();
        let name = self.read_name(&format!("a name after '{keyword}'"))?;
        self.skip_inline_ws();
        self.expect("(", &format!("after the {keyword} name '{name}'"))?;
        let params = self.parse_param_list()?;
        let return_type = self.parse_return_annotation()?;
        let body = self.parse_block_body(&format!("the {keyword} '{name}'"))?;
        Ok(MovementDeclaration { name, params, return_type, body, exported: None, span: self.span_from(start) })
    }

    /// A typed parameter list with the `(` consumed; through the `)`.
    fn parse_param_list(&mut self) -> SResult<Vec<MovementParam>> {
        let mut params = Vec::new();
        loop {
            self.skip_all_ws();
            if self.is(')') {
                self.pos += 1;
                break;
            }
            let param_start = self.pos;
            let param_name = self.read_name("a parameter name")?;
            self.skip_inline_ws();
            // No `: <type>` — the CALLER supplies it; the checker owns the rule.
            if self.is(',') || self.is(')') {
                params.push(MovementParam { name: param_name, type_: None, span: self.span_from(param_start) });
                if self.is(',') {
                    self.pos += 1;
                    continue;
                }
                self.pos += 1;
                break;
            }
            self.expect(":", &format!("after the parameter '{param_name}'"))?;
            self.skip_all_ws();
            let type_ = self.read_param_type(&param_name, None)?;
            params.push(MovementParam { name: param_name, type_: Some(type_), span: self.span_from(param_start) });
            self.skip_all_ws();
            if self.is(',') {
                self.pos += 1;
                continue;
            }
            if !self.is(')') {
                return self.fail(format!("Expected ',' or ')' in the parameter list, found {}", self.describe_here()));
            }
        }
        Ok(params)
    }

    /// A parameter's (or a return's) written type, the opening `<` next.
    fn read_param_type(&mut self, param_name: &str, context: Option<&str>) -> SResult<ParamTypeRef> {
        if let Some(value_type) = self.try_read_value_type_marker(param_name)? {
            return Ok(ParamTypeRef::Value(value_type));
        }
        let context = match context {
            Some(context) => context.to_string(),
            None => format!("for the parameter '{param_name}' (e.g. <inbox-[:message]->>)"),
        };
        let marker = self.read_type_marker(&context, HOPS)?;
        Ok(ParamTypeRef::Name(type_ref_from_marker(marker)))
    }

    /// `): <number>` — the type a function declares it returns (version 3).
    fn parse_return_annotation(&mut self) -> SResult<Option<ParamTypeRef>> {
        if !since(self.version, 3) {
            return Ok(None);
        }
        let save = self.pos;
        self.skip_inline_ws();
        if !self.is(':') {
            self.pos = save;
            return Ok(None);
        }
        self.pos += 1;
        self.skip_inline_ws();
        if !self.is('<') {
            return self.fail("Expected a return type after ':' — written as a parameter's is, e.g. ': <number>'");
        }
        Ok(Some(self.read_param_type("return", Some("for the return type (e.g. <number>)"))?))
    }

    /// `<text[]>` / `<{ mode: text, owner?: text }>` — a VALUE type written
    /// out in full. Consumes nothing for a plain name or an address.
    fn try_read_value_type_marker(&mut self, param_name: &str) -> SResult<Option<ValueType>> {
        let start = self.pos;
        if self.at_closure_type() {
            let closure = self.read_closure_type(param_name)?;
            return Ok(Some(self.read_list_suffix(closure, start)?));
        }
        if !self.is('<') || !since(self.version, 3) {
            return Ok(None);
        }
        self.pos += 1;
        self.skip_inline_ws();
        if !self.is('{') {
            let Some((_, end)) = scan_name(self.src.units(), self.pos) else {
                self.pos = start;
                return Ok(None);
            };
            self.pos = end;
            self.skip_inline_ws();
            let is_list = self.is('[') && trim_start(self.src.slice(self.pos + 1, self.src.len())).first() == Some(&unit(']'));
            self.pos = start + 1;
            self.skip_inline_ws();
            if !is_list {
                self.pos = start;
                return Ok(None);
            }
        }
        let member = self.read_value_type_member(param_name)?;
        self.skip_inline_ws();
        self.expect(">", &format!("to close the type of the parameter '{param_name}'"))?;
        let span = self.span_from(start);
        match member {
            ValueType::Name { .. } => {
                self.fail_at(format!("Expected a list or record type for the parameter '{param_name}'"), start)
            }
            ValueType::List { of, .. } => Ok(Some(ValueType::List { of, span })),
            ValueType::Record { keys, .. } => Ok(Some(ValueType::Record { keys, span })),
            ValueType::Closure { params, returns, .. } => Ok(Some(ValueType::Closure { params, returns, span })),
        }
    }

    /// At `<(` — a closure type's opening?
    fn at_closure_type(&self) -> bool {
        if !self.is('<') {
            return false;
        }
        let mut offset = 1;
        while self.is_at(offset, ' ') || self.is_at(offset, '\t') {
            offset += 1;
        }
        self.is_at(offset, '(')
    }

    /// `<(c: <Company>) => <text>>` — a closure type (language version 5),
    /// TypeScript's `(c: Company) => string`. The parameters are a function's own
    /// parameter list, every one typed; the return is written as a function's
    /// return annotation is. A closure that returns a list is
    /// `<() => <text[]>>`; `<() => <text>>[]` reads (the caller reads the
    /// `[]`), and the checker refuses it — a closure is not data, so there is
    /// no list of them.
    fn read_closure_type(&mut self, param_name: &str) -> SResult<ValueType> {
        let start = self.pos;
        if before(self.version, 5) {
            return self.fail_at(
                format!(
                    "A closure type ('<(c: <Company>) => <text>>') is written from language version 5 (Dancing Wren); this movement is pinned to version {}, where a closure is not a value — move the movement up to version 5 to type '{param_name}' as a closure",
                    self.version
                ),
                start,
            );
        }
        self.pos += 1;
        self.skip_inline_ws();
        self.expect("(", "to open a closure type's parameter list")?;
        let params = self.parse_param_list()?;
        for param in &params {
            if param.type_.is_none() {
                return self.fail_at(
                    format!(
                        "A closure type's parameter '{0}' needs a type — a caller of the closure is checked against it: write '{0}: <text>' (or whatever it takes)",
                        param.name
                    ),
                    start,
                );
            }
        }
        self.skip_inline_ws();
        self.expect("=>", "between a closure type's parameters and its return type (e.g. '<(c: <Company>) => <text>>')")?;
        self.skip_inline_ws();
        if !self.is('<') {
            return self.fail("Expected a closure type's return type after '=>', in angle brackets: '<() => <text>>'");
        }
        let returns = self.read_param_type(param_name, Some("for the return type of a closure type (e.g. '<() => <text>>')"))?;
        self.skip_inline_ws();
        if self.is('[') {
            return self.fail(
                "A closure type's return is written in its own angle brackets, so '[]' here is ambiguous — a closure that returns a list is '<() => <text[]>>'",
            );
        }
        self.expect(">", &format!("to close the closure type of '{param_name}'"))?;
        Ok(ValueType::Closure { params, returns: Box::new(returns), span: self.span_from(start) })
    }

    /// `<…>[]` — the written type as the element of a list, once per `[]`.
    fn read_list_suffix(&mut self, of: ValueType, start: usize) -> SResult<ValueType> {
        let mut member = of;
        loop {
            let save = self.pos;
            self.skip_inline_ws();
            if !self.try_consume("[") {
                self.pos = save;
                return Ok(member);
            }
            self.skip_inline_ws();
            self.expect("]", "to close '[]' — a list type is written '<text>[]'")?;
            member = ValueType::List { of: Box::new(member), span: self.span_from(start) };
        }
    }

    /// One member of a written value type: `text`, `text[]`, `{ k: text }`, …
    fn read_value_type_member(&mut self, param_name: &str) -> SResult<ValueType> {
        self.deeper(|p| p.read_value_type_member_here(param_name))
    }

    fn read_value_type_member_here(&mut self, param_name: &str) -> SResult<ValueType> {
        let start = self.pos;
        let mut member = if self.is('{') {
            self.read_value_record_type(param_name)?
        } else if self.at_closure_type() {
            self.read_closure_type(param_name)?
        } else if self.is('<') {
            return self.fail(format!(
                "Inside a type's angle brackets the members are bare type names — write '{param_name}: <{{ key: text }}>', not '<{{ key: <text> }}>'"
            ));
        } else {
            let name = self.read_name(&format!("a type name for the parameter '{param_name}'"))?;
            ValueType::Name { name, span: self.span_from(start) }
        };
        loop {
            let save = self.pos;
            self.skip_inline_ws();
            if !self.try_consume("[") {
                self.pos = save;
                break;
            }
            self.skip_inline_ws();
            self.expect("]", "to close '[]' — a list type is written 'text[]'")?;
            member = ValueType::List { of: Box::new(member), span: self.span_from(start) };
        }
        Ok(member)
    }

    /// `{ mode: text, owner?: text }` — keys separated by ',', ';' or newlines.
    fn read_value_record_type(&mut self, param_name: &str) -> SResult<ValueType> {
        let start = self.pos;
        self.pos += 1;
        let mut keys = Vec::new();
        let mut seen = HashSet::new();
        loop {
            self.skip_all_ws();
            if self.try_consume("}") {
                break;
            }
            if self.eof() {
                return self.fail_at(format!("Expected '}}' to close the record type of '{param_name}'"), start);
            }
            let key_start = self.pos;
            let name = self.read_name(&format!("a key in the record type of '{param_name}'"))?;
            if seen.contains(&name) {
                return self.fail_at(
                    format!("The key '{name}' is written twice in the record type of '{param_name}'"),
                    key_start,
                );
            }
            seen.insert(name.clone());
            self.skip_inline_ws();
            let optional = self.try_consume("?");
            self.skip_inline_ws();
            self.expect(
                ":",
                &format!("after the key '{name}' (e.g. '{name}: text', or '{name}?: text' for a key that may be left out)"),
            )?;
            self.skip_inline_ws();
            let type_ = self.read_value_type_member(param_name)?;
            keys.push(ValueTypeKey { name, type_, optional: optional.then_some(true), span: self.span_from(key_start) });
            self.skip_inline_ws();
            if self.is(',') || self.is(';') {
                self.pos += 1;
            } else if !self.is('\n') && !self.is('}') {
                return self.fail(format!(
                    "Expected ',' or '}}' in the record type of '{param_name}', found {}",
                    self.describe_here()
                ));
            }
        }
        Ok(ValueType::Record { keys, span: self.span_from(start) })
    }

    // ── listen ──

    /// `listen to <name> { <named-config> } fire <movement>` — config optional.
    /// An inline construction still PARSES so the checker can point at the fix.
    fn parse_listen(&mut self) -> SResult<ListenDeclaration> {
        let start = self.pos;
        self.pos += "listen".len();
        self.skip_inline_ws();
        let mut alias = None;
        if self.at_word("as") {
            self.pos += "as".len();
            self.skip_inline_ws();
            alias = Some(self.read_quoted_string("after `listen as` (e.g. listen as \"Alice's meetings\")")?.0);
            self.skip_inline_ws();
        }
        self.expect_word("to", "after 'listen'")?;
        self.skip_inline_ws();
        let instance_start = self.pos;
        let instance = self.read_name("an instance name after 'listen to'")?;
        let mut construct = None;
        if self.is('(') {
            let construct_start = instance_start;
            self.pos += 1;
            let mut args = Vec::new();
            loop {
                self.skip_all_ws();
                if self.eof() {
                    return self.fail_at(format!("Expected ')' to close 'listen to {instance}(…)'"), construct_start);
                }
                if self.is(')') {
                    self.pos += 1;
                    break;
                }
                if self.is(',') {
                    self.pos += 1;
                    continue;
                }
                let arg_name = self.read_ident(&format!("a construction argument of '{instance}'"))?;
                self.skip_inline_ws();
                self.expect(":", &format!("after the construction argument '{arg_name}'"))?;
                let (slot, stop) =
                    self.read_expr_slot(Scan::new(",)", format!("for the construction argument '{arg_name}'")))?;
                args.push(NamedArg { name: arg_name, value: slot, is_type: None });
                if stop == Some(unit(',')) {
                    self.pos += 1;
                }
            }
            construct = Some(ConstructionCall { callee: instance.clone(), args, span: self.span_from(construct_start) });
        }
        self.skip_inline_ws();
        let mut config = Vec::new();
        if self.is('{') {
            let brace_offset = self.pos;
            self.pos += 1;
            loop {
                self.skip_all_ws();
                if self.eof() {
                    return self.fail_at("Expected '}' to close the listener config", brace_offset);
                }
                if self.is('}') {
                    self.pos += 1;
                    break;
                }
                if self.is(',') {
                    self.pos += 1;
                    continue;
                }
                let name = self.read_ident("a config key in the listener config")?;
                self.skip_inline_ws();
                self.expect(":", &format!("after the config key '{name}'"))?;
                self.skip_inline_ws();
                if self.is('<') {
                    // A TYPE value — `type: <company>` in a kg listen; the AST
                    // stores the bare spelling.
                    let marker = self.read_type_marker(&format!("for the config key '{name}'"), PLAIN)?;
                    config.push(NamedArg { name, value: self.slot(marker.text, marker.span), is_type: Some(true) });
                    self.skip_inline_ws();
                    if self.is(',') {
                        self.pos += 1;
                    }
                    continue;
                }
                let (slot, stop) = self.read_expr_slot(Scan::new(",\n}", format!("for the config key '{name}'")))?;
                config.push(NamedArg { name, value: slot, is_type: None });
                if stop == Some(unit(',')) {
                    self.pos += 1;
                }
            }
            self.skip_inline_ws();
        }
        self.expect_word(
            "fire",
            &format!("after 'listen to {instance}{}'", if config.is_empty() { "" } else { " { … }" }),
        )?;
        self.skip_inline_ws();
        let movement = self.read_name("a movement name after 'fire'")?;
        self.expect_statement_end()?;
        Ok(ListenDeclaration { instance, alias, construct, config, movement, span: self.span_from(start) })
    }

    // ── extract(content, Shape, config) and extractOne(…) ──

    /// The extraction call next, if one is — from language version 3, in any
    /// letter case.
    fn extract_call_ahead(&mut self) -> Option<(String, ExtractCallFinds)> {
        if before(self.version, 3) {
            return None;
        }
        let word = self.peek_ident()?;
        if !self.followed_by_call(&word) {
            return None;
        }
        match word.to_ascii_lowercase().as_str() {
            "extract" => Some((word, ExtractCallFinds::Each)),
            "extractone" => Some((word, ExtractCallFinds::One)),
            _ => None,
        }
    }

    fn at_extract_call(&mut self) -> bool {
        self.extract_call_ahead().is_some()
    }

    /// `extract(content, Shape[, { … }])` or `extractOne(…)`.
    fn parse_extract_call(&mut self, start: usize) -> SResult<ExtractCallExpression> {
        let Some((word, finds)) = self.extract_call_ahead() else {
            return self.fail(format!("Expected 'extract(…)' or 'extractOne(…)', found {}", self.describe_here()));
        };
        self.pos += word.len();
        self.skip_inline_ws();
        self.expect("(", &format!("to open '{word}(…)'"))?;
        let usage = format!("{word}(<content>, <Shape>) or {word}(<content>, <Shape>, {{ tier: 'careful' }})");
        let (content, stop) = self.read_expr_slot(Scan::new(",)", format!("for the content '{word}' reads")))?;
        if stop != Some(unit(',')) {
            return self.fail(format!("'{word}' takes {usage} — the shape is missing"));
        }
        self.pos += 1;
        self.skip_all_ws();
        let shape = self.parse_extract_call_shape()?;
        self.skip_all_ws();
        let mut config = None;
        if self.is(',') {
            self.pos += 1;
            config = Some(self.read_expr_slot(Scan::new(",)", format!("for the settings '{word}' runs with")))?.0);
            self.skip_all_ws();
            if self.is(',') {
                return self.fail(format!("'{word}' takes {usage} — nothing follows the settings"));
            }
        }
        self.skip_all_ws();
        self.expect(")", &format!("to close '{word}(…)'"))?;
        Ok(ExtractCallExpression { finds, content, shape, config, span: self.span_from(start) })
    }

    /// The shape argument: a declaration's NAME, or the declaration written in
    /// place; anything else is COMPUTED, kept so the checker can refuse it.
    fn parse_extract_call_shape(&mut self) -> SResult<ExtractCallShape> {
        let start = self.pos;
        if self.at_node_literal() {
            return self.fail(
                "'node { … }' builds a record — its strings are values, not descriptions — so it is not a shape. Write the declaration with its header (`extract(content, node Company: \"each company named\" { name: \"…\" })`), or declare it and pass its name",
            );
        }
        if self.at_graph_literal() {
            return self.fail(
                "'graph { … }' builds a local graph value, and 'extract' takes a SHAPE — pass a node declaration's name (`extract(content, Company)`), or write the declaration in place (`node Company: \"…\" { … }`)",
            );
        }
        if self.at_node_declaration() {
            let declaration = self.parse_node_declaration()?;
            let span = declaration.span;
            return Ok(ExtractCallShape::Inline { declaration, span });
        }
        if self.is('<') {
            return self.fail(
                "the shape is a node declaration passed by its name, without the type brackets — `extract(content, Company)`",
            );
        }
        if let Some((name, end)) = scan_name(self.src.units(), self.pos) {
            let save = self.pos;
            self.pos = end;
            self.skip_all_ws();
            if self.is(',') || self.is(')') {
                return Ok(ExtractCallShape::Named { name, span: self.span_between(start, end) });
            }
            self.pos = save;
        }
        let (slot, _) = self.read_expr_slot(Scan::new(",)", "for the shape 'extract' fills"))?;
        Ok(ExtractCallShape::Computed { span: slot.span, expr: slot })
    }

    // ── extract ──

    fn parse_extract(&mut self, start: usize) -> SResult<ExtractExpression> {
        self.skip_inline_ws();
        // `extract "thorough" from […]` — the optional tier, read verbatim.
        let mut tier = None;
        if self.is('"') {
            tier = Some(self.read_quoted_string("as the extract's tier")?.0);
            self.skip_inline_ws();
        }
        self.expect_word("from", "after 'extract'")?;
        self.skip_inline_ws();
        let bracket_offset = self.pos;
        self.expect("[", "after 'extract from'")?;
        let mut from = Vec::new();
        loop {
            self.skip_all_ws();
            if self.is(']') {
                self.pos += 1;
                break;
            }
            let (slot, stop) = self.read_expr_slot(Scan::new(",]", "in the 'extract from […]' data list"))?;
            from.push(slot);
            if stop == Some(unit(',')) {
                self.pos += 1;
            }
        }
        if from.is_empty() {
            return self.fail_at("'extract from […]' needs at least one data item", bracket_offset);
        }
        let mut stages = Vec::new();
        let first_through = self.try_parse_through()?;
        self.skip_all_ws();
        if !self.is('{') {
            return self.fail(format!("Expected '{{' to open the extraction stage, found {}", self.describe_here()));
        }
        stages.push(self.parse_extract_stage(first_through)?);
        self.parse_chained_stages(&mut stages)?;
        Ok(ExtractExpression { from, stages, tier, span: self.span_from(start) })
    }

    /// Repeated `through [plugins] { stage }` chains following a stage.
    fn parse_chained_stages(&mut self, stages: &mut Vec<ExtractStage>) -> SResult<()> {
        loop {
            let Some(through) = self.try_parse_through()? else {
                return Ok(());
            };
            self.skip_all_ws();
            if !self.is('{') {
                return self.fail(format!(
                    "Expected '{{' to open the extraction stage after 'through […]', found {}",
                    self.describe_here()
                ));
            }
            stages.push(self.parse_extract_stage(Some(through))?);
        }
    }

    /// `through [scrub, fetch(urls: urls)]` — restores position if absent.
    fn try_parse_through(&mut self) -> SResult<Option<Vec<PluginCall>>> {
        let save = self.pos;
        self.skip_all_ws();
        if !self.at_word("through") {
            self.pos = save;
            return Ok(None);
        }
        let through_offset = self.pos;
        self.pos += "through".len();
        self.skip_inline_ws();
        self.expect("[", "after 'through'")?;
        let mut plugins = Vec::new();
        loop {
            self.skip_all_ws();
            if self.is(']') {
                self.pos += 1;
                break;
            }
            let plugin_start = self.pos;
            let plugin = self.read_ident("a plugin name in 'through […]'")?;
            let mut args = Vec::new();
            self.skip_inline_ws();
            if self.is('(') {
                self.pos += 1;
                loop {
                    self.skip_all_ws();
                    if self.is(')') {
                        self.pos += 1;
                        break;
                    }
                    let arg_name = self.read_ident(&format!("an argument name for the plugin '{plugin}'"))?;
                    self.skip_inline_ws();
                    self.expect(":", &format!("after the argument '{arg_name}'"))?;
                    let (slot, stop) = self.read_expr_slot(Scan::new(",)", format!("for the argument '{arg_name}'")))?;
                    args.push(NamedArg { name: arg_name, value: slot, is_type: None });
                    if stop == Some(unit(',')) {
                        self.pos += 1;
                    }
                }
            }
            plugins.push(PluginCall { plugin, args, span: self.span_from(plugin_start) });
            self.skip_all_ws();
            if self.is(',') {
                self.pos += 1;
                continue;
            }
            if !self.is(']') {
                return self.fail(format!("Expected ',' or ']' in 'through […]', found {}", self.describe_here()));
            }
        }
        if plugins.is_empty() {
            return self.fail_at("'through […]' needs at least one plugin", through_offset);
        }
        Ok(Some(plugins))
    }

    fn parse_extract_stage(&mut self, through: Option<Vec<PluginCall>>) -> SResult<ExtractStage> {
        self.deeper(|p| p.parse_extract_stage_here(through))
    }

    fn parse_extract_stage_here(&mut self, through: Option<Vec<PluginCall>>) -> SResult<ExtractStage> {
        let brace_offset = self.pos;
        self.expect("{", "to open the extraction stage")?;
        let mut fields = Vec::new();
        let mut children = Vec::new();
        loop {
            self.skip_all_ws();
            if self.eof() {
                return self.fail_at("Expected '}' to close the extraction stage", brace_offset);
            }
            if self.is('}') {
                self.pos += 1;
                break;
            }
            if self.at_word("node") {
                children.push(self.parse_extract_node()?);
                continue;
            }
            let field_start = self.pos;
            let name = self.read_name("a field name or 'node' in the extraction stage")?;
            self.skip_inline_ws();
            self.expect(":", &format!("after '{name}'"))?;
            self.skip_inline_ws();
            let mut type_ = None;
            let mut nullable = false;
            if !self.is('"') {
                let marker = self.read_type_marker(
                    &format!("or a double-quoted description for the extract field '{name}'"),
                    FIELD_TAIL_NULL,
                )?;
                nullable = marker.nullable;
                let text = marker.text;
                self.skip_all_ws();
                if !self.is('"') {
                    return self.fail(format!(
                        "Expected a double-quoted description for the extract field '{name}' after the type '<{text}{}>', found {}",
                        if nullable { " | null" } else { "" },
                        self.describe_here()
                    ));
                }
                type_ = Some(text);
            }
            let description = self.read_string_slot(&format!("for the extract field '{name}'"))?;
            fields.push(ExtractField {
                name,
                type_,
                nullable: nullable.then_some(true),
                description,
                span: self.span_from(field_start),
            });
            self.expect_statement_end()?;
        }
        Ok(ExtractStage { through, fields, children, span: self.span_from(brace_offset) })
    }

    fn parse_extract_node(&mut self) -> SResult<ExtractNode> {
        let start = self.pos;
        self.pos += "node".len();
        self.skip_inline_ws();
        let name = self.read_name("a node name after 'node'")?;
        self.skip_inline_ws();
        self.expect(":", &format!("after the node name '{name}'"))?;
        self.skip_all_ws();
        if self.is('<') {
            return self.parse_declared_extract_node(name, start);
        }
        if !self.is('"') {
            return self.fail(format!(
                "Expected a double-quoted description for the node '{name}' (or a declared node as its shape, `node {name}: <Entry>`), found {}",
                self.describe_here()
            ));
        }
        let description = self.read_string_slot(&format!("for the node '{name}'"))?;
        self.skip_all_ws();
        if !self.is('{') {
            return self.fail(format!(
                "Expected '{{' to open the node '{name}'s extraction stage, found {}",
                self.describe_here()
            ));
        }
        let mut stages = vec![self.parse_extract_stage(None)?];
        self.parse_chained_stages(&mut stages)?;
        Ok(ExtractNode::Inline(InlineExtractNode { name, description, stages, span: self.span_from(start) }))
    }

    /// `node entry: <Entry> "…" through […] { … }` — only `through` stages may
    /// follow the declaration.
    fn parse_declared_extract_node(&mut self, name: String, start: usize) -> SResult<ExtractNode> {
        let marker_start = self.pos;
        let marker = self.read_type_marker(&format!("as the shape of the node '{name}'"), PLAIN)?;
        let declared = DeclaredType { type_: marker.text, span: self.span_from(marker_start) };
        self.skip_inline_ws();
        let description =
            if self.is('"') { Some(self.read_string_slot(&format!("for the node '{name}'"))?) } else { None };
        self.skip_inline_ws();
        if self.is('{') {
            return self.fail(format!(
                "'{name}' takes its fields from <{}> — change a field in a following 'through […] {{ … }}' stage, or write the node inline ('node {name}: \"…\" {{ … }}') instead of naming a declaration",
                declared.type_
            ));
        }
        let mut stages = Vec::new();
        self.parse_chained_stages(&mut stages)?;
        if stages.is_empty() {
            self.expect_statement_end()?;
        }
        Ok(ExtractNode::Declared(DeclaredExtractNode { name, declared, description, stages, span: self.span_from(start) }))
    }
}

/// A `<…>` type marker → `TypeRef`.
fn type_ref_from_marker(marker: Marker) -> TypeRef {
    TypeRef { graph: marker.text, position: marker.position, hops_raw: marker.hops_raw, span: marker.span }
}

/// The whole-file entry: a program, or the one error that stopped the parse.
pub fn parse_program(source: &str, version: u32, eager: bool) -> SResult<Program> {
    let (program, spelling) =
        crate::surface::collecting(version, || Parser::new(source, version, Loc { line: 1, col: 1 }, eager).parse_program());
    let mut program = program?;
    program.spelling = spelling;
    Ok(program)
}

/// An adapter package's tag (`` `@lf/attio` ``), until packages are more than
/// the built-in adapters: the tag names the adapter after the prefix.
const ADAPTER_PACKAGE_PREFIX: &str = "@lf/";

impl Parser {
    /// `connect attio using acme { dryRun: true }` (version 5): the
    /// construction `attio(credentials: acme, dry_run: true)` versions 1–4
    /// write, so nothing downstream learns a second form.
    fn parse_connect(&mut self) -> SResult<ConstructionCall> {
        let start = self.pos;
        self.pos += "connect".len();
        self.skip_inline_ws();
        let callee = self.read_name("the adapter after 'connect'")?;
        let mut args = Vec::new();
        self.skip_inline_ws();
        if self.at_word("using") {
            self.pos += "using".len();
            self.skip_inline_ws();
            let at = self.pos;
            let credential = self.read_name("the credential after 'using'")?;
            let span = self.span_between(at, self.pos);
            args.push(NamedArg { name: "credentials".into(), value: ExprSlot { raw: credential, span, eager: self.eager }, is_type: None });
            self.skip_inline_ws();
        }
        if self.is('{') {
            let open = self.pos;
            let (settings, _) = self.read_expr_slot(Scan::new("\n}", "for the connection's settings").eof_ok())?;
            let tree = crate::expr::parse_expression_raw(&settings.raw).map_err(|e| ParseError {
                message: format!("the connection's settings must be a record: {}", e.message),
                loc: self.loc_at(open + e.pos),
            })?;
            let crate::tree::MExpr::Map { entries, .. } = &tree else {
                return self.fail_at("the connection's settings are a record: `{ dryRun: true }`", open);
            };
            let src = crate::util::utf16::Utf16::new(&settings.raw);
            for entry in entries {
                let crate::tree::MapMember::Entry { key: crate::tree::MapKey::Name(key), value } = entry else {
                    return self.fail_at("a connection setting is `name: value`", open);
                };
                let at = value.at();
                let raw = src.text(at.start, at.end);
                let span = Span {
                    start: crate::surface::loc_in(&src, settings.span.start, at.start),
                    end: crate::surface::loc_in(&src, settings.span.start, at.end),
                };
                args.push(NamedArg { name: snake_case(&key.text), value: self.slot(raw, span), is_type: None });
            }
        }
        Ok(ConstructionCall { callee, args, span: self.span_from(start) })
    }

    /// From version 5 an adapter is set up with `connect`; its construction
    /// is refused with the rewrite.
    fn refuse_adapter_construction(&self, construct: &ConstructionCall, start: usize) {
        if !since(self.version, 5) || !self.adapters.contains(&construct.callee) {
            return;
        }
        let mut text = format!("connect {}", construct.callee);
        let mut settings = Vec::new();
        for arg in &construct.args {
            if arg.name == "credentials" {
                text.push_str(&format!(" using {}", arg.value.raw.trim()));
            } else {
                settings.push(format!("{}: {}", camel_case(&arg.name), arg.value.raw.trim()));
            }
        }
        if !settings.is_empty() {
            text.push_str(&format!(" {{ {} }}", settings.join(", ")));
        }
        let end = self.pos;
        let message = format!("from language version 5 an adapter is set up with `{text}`");
        self.spelling(message, start, end, vec![(start, end, text)]);
    }
}

fn snake_case(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn camel_case(name: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn program(source: &str) -> Value {
        crate::parse_program(source, 3).unwrap_or_else(|e| panic!("{source:?}: {e}"))
    }

    fn error(source: &str) -> Value {
        match crate::parse_program(source, 3) {
            Ok(ast) => panic!("{source:?} parsed: {ast}"),
            Err(e) => e,
        }
    }

    #[test]
    fn columns_count_utf16_units() {
        // 🌍 is two UTF-16 units, é one.
        let ast = program("x = \"🌍 é\"\n`Café 🌍` = 2");
        assert_eq!(ast.pointer("/statements/0/value/expr/span"), Some(&json!({ "start": { "line": 1, "col": 5 }, "end": { "line": 1, "col": 11 } })));
        assert_eq!(ast.pointer("/statements/1/name"), Some(&json!("Café 🌍")));
        assert_eq!(ast.pointer("/statements/1/value/expr/span/start"), Some(&json!({ "line": 2, "col": 13 })));
    }

    #[test]
    fn an_error_after_an_astral_character_points_in_utf16_columns() {
        assert_eq!(
            error("delete `🌍` extra"),
            json!({ "message": "Unexpected 'extra' — expected the end of the statement", "loc": { "line": 1, "col": 13 } })
        );
    }

    #[test]
    fn a_carriage_return_is_whitespace_and_only_a_newline_ends_a_line() {
        let ast = program("x = 1\r\ny = 2\r\n");
        assert_eq!(ast.pointer("/statements/0/value/expr/raw"), Some(&json!("1")));
        assert_eq!(ast.pointer("/statements/1/span/start"), Some(&json!({ "line": 2, "col": 1 })));
        // A lone `\r` does not start a line.
        let ast = program("x = 1 \r y = 2");
        assert_eq!(ast.pointer("/statements/0/value/expr/raw"), Some(&json!("1 \r y = 2")));
    }

    #[test]
    fn an_unknown_version_reads_as_the_current_one() {
        let source = "f(x)\ny = MAP(xs, (x) => x)";
        assert_eq!(crate::parse_program(source, 99), crate::parse_program(source, 5));
        assert_eq!(crate::parse_program(source, 4), crate::parse_program(source, 3));
        assert!(crate::parse_program(source, 2).is_err(), "positional calls arrived in version 3");
    }

    #[test]
    fn the_legacy_collection_forms_are_read_before_version_3() {
        let ast = crate::parse_program("y = MAP(xs, f)", 2).unwrap();
        assert_eq!(ast.pointer("/statements/0/value/kind"), Some(&json!("collection")));
        let ast = crate::parse_program("y = MAP(xs, f)", 3).unwrap();
        assert_eq!(ast.pointer("/statements/0/value/kind"), Some(&json!("call")));
    }

    #[test]
    fn absent_optionals_are_omitted() {
        let ast = program("movement f(m: <text>) { write crm-[:companies]-> { name: m } }");
        let movement = &ast["statements"][0];
        assert!(movement.get("returnType").is_none());
        assert!(movement.get("exported").is_none());
        let write = &movement["body"][0]["write"];
        assert!(write.get("spreads").is_none() && write.get("bind").is_none());
        assert!(write["target"].get("explicitType").is_none());
        assert!(write["fields"][0].get("semantics").is_none());
    }

    #[test]
    fn a_match_on_a_position_errors_at_the_target() {
        assert_eq!(
            error("x = match   a { name: n }")["loc"],
            json!({ "line": 1, "col": 13 })
        );
    }

    #[test]
    fn nesting_past_the_limit_is_refused_not_overflowed() {
        // Far past the limit, so a construct that recursed unguarded would
        // overflow the test thread's stack instead.
        let depth = 2_000;
        let cases = [
            ("a-[:e]-> { ".repeat(depth), "statement blocks"),
            (format!("x = {}", "node { a: ".repeat(depth)), "node literals"),
            (format!("x = graph {{ {}", "a: { ".repeat(depth)), "graph bodies"),
            ("f(g(".repeat(depth), "nested calls"),
            (format!("x = (y) => {{ {}", "f((y) => { ".repeat(depth)), "closures"),
            (format!("movement m(p: <{}", "{ k: ".repeat(depth)), "record types"),
            (format!("x = \"{}", "${\"".repeat(depth)), "interpolations"),
            (format!("x = extract from [a] {{ {} }}", "node n: \"d\" { ".repeat(depth)), "extract nodes"),
            (format!("node N {{ {}", "node c { ".repeat(depth)), "declared nodes"),
            (format!("if a {{ {}", "if b { ".repeat(depth)), "if arms"),
            (format!("x = {}", "callback({ y = ".repeat(depth)), "callbacks"),
            (format!("x = {}", "MAP(xs, (v) => { y = ".repeat(depth)), "collection functions"),
        ];
        // Unoptimised frames are several times a release build's, and this
        // macOS hangs rather than aborts on a native stack overflow, so the
        // debug test gets room; the WASM build's margin is measured
        // separately (the crate README).
        let checked = std::thread::Builder::new()
            .stack_size(256 << 20)
            .spawn(move || {
                for (source, what) in cases {
                    assert_eq!(error(&source)["message"], json!(TOO_DEEP), "{what}");
                }
            })
            .expect("spawning the deep-nesting thread")
            .join();
        if let Err(panic) = checked {
            std::panic::resume_unwind(panic);
        }
    }

    #[test]
    fn the_unpinned_hop_name_matches_the_typescript_regex() {
        assert_eq!(unpinned_hop_name("-[:company]->").as_deref(), Some("company"));
        assert_eq!(unpinned_hop_name(" -[ c : company ]-> ").as_deref(), Some("company"));
        assert_eq!(unpinned_hop_name("-[:`Record Change`]->").as_deref(), Some("Record Change"));
        assert_eq!(unpinned_hop_name("-[:company WHERE x]->"), None);
        assert_eq!(unpinned_hop_name("-[:``]->"), None);
        assert_eq!(unpinned_hop_name("-[c company]->"), None);
    }

    #[test]
    fn a_nested_collection_head_is_found_as_the_regex_finds_it() {
        assert_eq!(nested_collection_value("  MAP (xs, f)").as_deref(), Some("MAP"));
        assert_eq!(nested_collection_value("MEMBERS(<T>)").as_deref(), Some("MEMBERS"));
        assert_eq!(nested_collection_value("UPPER(x)"), None);
        assert_eq!(nested_collection_value("Map(x)"), None);
    }

    #[test]
    fn a_backtick_arm_name_takes_the_typescript_double_step() {
        // TypeScript advances by the name's length again after reading a
        // backticked arm name, so the span runs past the token.
        let ast = crate::parse_program("x = MAP(xs, `ab`  )", 2).unwrap();
        assert_eq!(ast.pointer("/statements/0/value/collection/fn/span/end/col"), Some(&json!(19)));
    }
}
