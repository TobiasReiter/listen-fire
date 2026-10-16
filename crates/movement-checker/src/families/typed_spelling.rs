//! Language version 5's namespace functions chosen by what a value IS
//! (plans/naming-rethink-2026-10-14/5_design.md §2.2): a list's length is
//! `count(xs)`, text's `Text.length(t)`; a list holds a value by
//! `List.includes(xs, v)`, text by `Text.includes(t, v)`; a list's presence
//! is `count(xs) > 0`, a value's `x != null`. The spelling rewrite
//! (movement_parser::surface) cannot see a type, so its fix for an old
//! spelling is the one whose tree is the old one's (`Text.length`,
//! `Text.includes`, `!= null`); here the checker, which can, rewrites that fix
//! where the operand is a list, and refuses a v5 call given the wrong kind.
//! The TypeScript twin is packages/movement-lang/checker/typed_spelling.ts.

use movement_parser::ast::{ExprSlot, Span};
use movement_parser::tree::{At, BinaryOp, MExpr};
use movement_parser::util::utf16::Utf16;

use crate::checker::Checker;
use crate::codes;
use crate::diagnostic::Diagnostic;
use crate::families::calls::{expression_children, span_of_extent};
use crate::scope::ScopeId;
use crate::types::Typing;
use crate::types::field::{Ty, strip_absent};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ValueKind {
    List,
    Text,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Found {
    /// The parser's MOV_V5_SPELLING finding at `at` takes this message and fix.
    Respell,
    /// A v5 call given the wrong kind of value.
    Misuse,
}

pub struct TypedSpelling {
    pub found: Found,
    pub at: At,
    pub message: String,
    pub text: String,
    /// The fix keeps the meaning: from 5 `count` counts every item, as
    /// `LENGTH` of a list did and as `EXISTS` of one asked (any item at all).
    pub safe: bool,
}

/// Every typed respelling in `tree` (outside walk brackets), `kind_of`
/// giving what an operand is where the checker can tell.
pub fn typed_spellings(tree: &MExpr, raw: &str, kind_of: &mut dyn FnMut(&MExpr) -> Option<ValueKind>) -> Vec<TypedSpelling> {
    let src = Utf16::new(raw);
    let mut out = Vec::new();
    visit(tree, false, &src, kind_of, &mut out);
    out
}

fn visit(e: &MExpr, in_walk: bool, src: &Utf16, kind_of: &mut dyn FnMut(&MExpr) -> Option<ValueKind>, out: &mut Vec<TypedSpelling>) {
    match e {
        MExpr::Path { root, hops, .. } => {
            if let Some(root) = root {
                visit(root, in_walk, src, kind_of, out);
            }
            for hop in hops {
                if let Some(w) = &hop.where_ {
                    visit(w, true, src, kind_of, out);
                }
                if let Some(config) = &hop.config {
                    for member in &config.entries {
                        match member {
                            movement_parser::tree::MapMember::Entry { value, .. } => visit(value, in_walk, src, kind_of, out),
                            movement_parser::tree::MapMember::Spread(s) => visit(&s.expr, in_walk, src, kind_of, out),
                        }
                    }
                }
                if let Some(order) = &hop.order_by {
                    visit(&order.key, true, src, kind_of, out);
                }
            }
            return;
        }
        MExpr::Where { source, predicate, .. } => {
            visit(source, in_walk, src, kind_of, out);
            visit(predicate, true, src, kind_of, out);
            return;
        }
        _ => {}
    }
    for child in expression_children(e) {
        visit(child, in_walk, src, kind_of, out);
    }
    if !in_walk {
        out.extend(here(e, src, kind_of));
    }
}

fn here(e: &MExpr, src: &Utf16, kind_of: &mut dyn FnMut(&MExpr) -> Option<ValueKind>) -> Option<TypedSpelling> {
    let text = |at: At| src.text(at.start, at.end);
    match e {
        MExpr::Call { callee, args, at } if args.len() == 1 => {
            let MExpr::Name { name, .. } = callee.as_ref() else { return None };
            let canonical = name.text.to_ascii_uppercase();
            let arg = &args[0].value;
            let written = text(callee.at());
            if canonical == "LENGTH" && kind_of(arg) == Some(ValueKind::List) {
                let fix = format!("count({})", text(arg.at()));
                return Some(if written == "Text.length" {
                    TypedSpelling { found: Found::Misuse, at: *at, message: "`Text.length` takes text; a list's length is `count(xs)`".into(), text: fix, safe: false }
                } else {
                    TypedSpelling { found: Found::Respell, at: *at, message: format!("`{written}` of a list is written `count(xs)` from language version 5"), text: fix, safe: true }
                });
            }
            if canonical == "EXISTS" && !matches!(arg, MExpr::Path { .. } | MExpr::Where { .. }) && kind_of(arg) == Some(ValueKind::List) {
                let fix = format!("count({}) > 0", text(arg.at()));
                let text = if whole(src, *at) { fix } else { format!("({fix})") };
                return Some(TypedSpelling { found: Found::Respell, at: *at, message: format!("`{written}` of a list is written `count(xs) > 0` from language version 5"), text, safe: true });
            }
            None
        }
        MExpr::Binary { op: BinaryOp::Contains, left, right, at } if kind_of(left) == Some(ValueKind::List) => {
            let fix = format!("List.includes({}, {})", text(left.at()), text(right.at()));
            Some(if text(*at).starts_with("Text.includes") {
                TypedSpelling { found: Found::Misuse, at: *at, message: "`Text.includes` takes text; a list holds a value by `List.includes(xs, v)`".into(), text: fix, safe: false }
            } else {
                TypedSpelling { found: Found::Respell, at: *at, message: "`CONTAINS` on a list is written `List.includes(xs, v)` from language version 5".into(), text: fix, safe: false }
            })
        }
        MExpr::Binary { op: BinaryOp::In, left, right, at } if text(*at).starts_with("List.includes") && kind_of(right) == Some(ValueKind::Text) => {
            let fix = format!("Text.includes({}, {})", text(right.at()), text(left.at()));
            Some(TypedSpelling { found: Found::Misuse, at: *at, message: "`List.includes` takes a list; text holds text by `Text.includes(t, v)`".into(), text: fix, safe: false })
        }
        _ => None,
    }
}

/// `at` is the whole text, or the whole of its sole parentheses (an `if`
/// condition): a rewrite there needs none of its own (the parser's rule).
fn whole(src: &Utf16, at: At) -> bool {
    let before = src.text(0, at.start);
    let after = src.text(at.end, src.len());
    let (before, after) = (before.trim(), after.trim());
    (before.is_empty() && after.is_empty()) || (before == "(" && after == ")")
}

pub fn span_key(span: &Span) -> (usize, usize, usize, usize) {
    (span.start.line, span.start.col, span.end.line, span.end.col)
}

impl Checker<'_> {
    /// `checkTypedSpelling` (version 5): the parser's fix for an old
    /// spelling of a list's length, membership or presence rewritten, and a
    /// v5 call given the wrong kind refused.
    pub fn check_typed_spelling(&mut self, tree: &MExpr, slot: &ExprSlot, scope: ScopeId) {
        if self.type_only > 0 {
            return;
        }
        let found = {
            let env = self.typing_env(scope);
            let mut kind_of = |e: &MExpr| -> Option<ValueKind> {
                let lowered = movement_parser::lowering::lower_expression(e, &slot.raw).ok()?;
                let ty = Typing::new(&env, self.version, slot.span).infer(&lowered)?;
                match strip_absent(&ty) {
                    Ty::List { .. } | Ty::Tuple { .. } => Some(ValueKind::List),
                    Ty::Text | Ty::Enum { .. } => Some(ValueKind::Text),
                    _ => None,
                }
            };
            typed_spellings(tree, self.written_text(slot), &mut kind_of)
        };
        for f in found {
            let span = span_of_extent(slot, f.at);
            let fix = if f.safe {
                serde_json::json!({ "edits": [{ "span": span, "text": f.text }], "safe": true })
            } else {
                serde_json::json!({ "edits": [{ "span": span, "text": f.text }] })
            };
            match f.found {
                Found::Respell => {
                    self.respelled.insert(span_key(&span), (f.message, fix));
                }
                Found::Misuse => self.push(Diagnostic { fix: Some(fix), ..Diagnostic::error(codes::BUILTIN_ARG_TYPE, f.message, span) }),
            }
        }
    }
}

// ── A walk's fields through its alias (design §2.5) ──
//
// From version 5 a hop's WHERE and ORDER BY read its record's fields through
// the hop's alias (`c.Name`); a bare name there is a variable from outside the
// walk, as it is everywhere else. The parser reads `c.Name` into the bare
// field the canonical tree has always held, marked as only ever the field
// (`MExpr::Name::field`), so a name the source writes bare that the scope
// does not bind is the old spelling of a field: refused, its fix the alias
// read, with an alias added to a hop that has none. A postfix `walk WHERE p`
// moves into the last hop.

/// A walk-field finding: where, the message, and the fix's edits (offsets
/// into the slot's text).
pub struct WalkField {
    pub at: At,
    pub message: String,
    pub edits: Vec<(At, String)>,
    /// The fix keeps the meaning: an alias read for a name the scope does not
    /// bind is the field the bare name read. Moving a postfix WHERE into the
    /// hop is not proved to.
    pub safe: bool,
}

/// Every bare field in `tree`'s walks, `binds` telling whether the scope
/// binds a name (then it is an outer variable).
pub fn walk_fields(tree: &MExpr, raw: &str, binds: &dyn Fn(&str) -> bool) -> Vec<WalkField> {
    let src = Utf16::new(raw);
    let mut out = Vec::new();
    walk_visit(tree, &[], &src, binds, &mut out);
    out
}

fn walk_visit(e: &MExpr, aliases: &[String], src: &Utf16, binds: &dyn Fn(&str) -> bool, out: &mut Vec<WalkField>) {
    let mut here: Vec<String> = aliases.to_vec();
    if let MExpr::Path { hops, .. } = e {
        here.extend(hops.iter().filter_map(|h| h.alias.as_ref().map(|a| a.text.clone())));
        for hop in hops {
            let mut names = Vec::new();
            if let Some(w) = &hop.where_ {
                bare_names(w, &mut names);
            }
            if let Some(order) = &hop.order_by {
                bare_names(&order.key, &mut names);
            }
            let fields: Vec<&movement_parser::tree::Name> = names.into_iter().filter(|n| is_field(n, &here, binds)).collect();
            let Some(first) = fields.first() else { continue };
            let (alias, insert) = alias_of(hop, &here, src, binds);
            let mut edits: Vec<(At, String)> = insert.into_iter().collect();
            edits.extend(fields.iter().map(|n| (n.at, format!("{alias}.{}", src.text(n.at.start, n.at.end)))));
            let written = src.text(first.at.start, first.at.end);
            let message = format!(
                "from language version 5 a walk's field is read through the hop's alias: `{alias}.{written}` (a bare name inside the brackets is a variable from outside the walk)"
            );
            out.push(WalkField { at: first.at, message, edits, safe: true });
        }
    }
    if let MExpr::Where { source, predicate, at } = e
        && let MExpr::Path { hops, .. } = source.as_ref()
        && let Some(last) = hops.last()
    {
        let mut names = Vec::new();
        bare_names(predicate, &mut names);
        let fields: Vec<&movement_parser::tree::Name> = names.into_iter().filter(|n| is_field(n, &here, binds)).collect();
        let simple = last.where_.is_none() && last.order_by.is_none() && last.limit.is_none() && last.config.is_none();
        let message = "from language version 5 a walk's filter is written inside its last hop, its fields through the hop's alias: `-[a:Edge WHERE a.Field …]->`".to_string();
        let edits = if simple {
            let (alias, insert) = alias_of(last, &here, src, binds);
            let mut predicate_text: Vec<(usize, usize, String)> =
                fields.iter().map(|n| (n.at.start, n.at.end, format!("{alias}.{}", src.text(n.at.start, n.at.end)))).collect();
            predicate_text.sort_by_key(|(s, _, _)| std::cmp::Reverse(*s));
            let p = predicate.at();
            let mut moved: Vec<u16> = src.units()[p.start..p.end].to_vec();
            for (s, e, t) in predicate_text {
                moved.splice(s - p.start..e - p.start, t.encode_utf16());
            }
            let moved = String::from_utf16_lossy(&moved);
            let s = source.at();
            let mut pieces: Vec<(usize, String)> = vec![(last.label.at.end, format!(" WHERE {moved}"))];
            if let Some((at, text)) = insert {
                pieces.push((at.start, text));
            }
            pieces.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
            let mut walk: Vec<u16> = src.units()[s.start..s.end].to_vec();
            for (at, text) in pieces {
                walk.splice(at - s.start..at - s.start, text.encode_utf16());
            }
            vec![(*at, String::from_utf16_lossy(&walk))]
        } else {
            Vec::new()
        };
        out.push(WalkField { at: *at, message, edits, safe: false });
    }
    for child in expression_children(e) {
        walk_visit(child, &here, src, binds, out);
    }
}

/// The names `e` reads bare (not through the hop's alias), outside any walk
/// nested in it (whose hops are read on their own) and never a call's callee.
fn bare_names<'e>(e: &'e MExpr, out: &mut Vec<&'e movement_parser::tree::Name>) {
    match e {
        MExpr::Name { field: true, .. } => {}
        MExpr::Name { name, .. } => out.push(name),
        MExpr::Path { .. } | MExpr::Where { .. } => {}
        MExpr::Call { args, .. } => args.iter().for_each(|a| bare_names(&a.value, out)),
        _ => expression_children(e).into_iter().for_each(|c| bare_names(c, out)),
    }
}

/// A name written bare that is no alias, no `edge` and no variable in scope.
fn is_field(name: &movement_parser::tree::Name, aliases: &[String], binds: &dyn Fn(&str) -> bool) -> bool {
    !aliases.contains(&name.text) && !name.text.eq_ignore_ascii_case("edge") && !binds(&name.text)
}

/// The hop's alias, and the edit that adds it when it has none: its label's
/// first letter lower-cased, numbered past any name already taken.
fn alias_of(hop: &movement_parser::tree::Hop, taken: &[String], src: &Utf16, binds: &dyn Fn(&str) -> bool) -> (String, Option<(At, String)>) {
    if let Some(alias) = &hop.alias {
        return (alias.text.clone(), None);
    }
    let stem = hop.label.text.chars().find(|c| c.is_ascii_alphabetic()).map_or("x".to_string(), |c| c.to_ascii_lowercase().to_string());
    let free = |n: &str| !taken.iter().any(|t| t == n) && !binds(n);
    let alias = std::iter::once(stem.clone()).chain((2..).map(|i| format!("{stem}{i}"))).find(|n| free(n)).expect("a free name");
    let open = (hop.at.start..hop.label.at.start).find(|&i| src.units()[i] == b'[' as u16).map_or(hop.label.at.start, |i| i + 1);
    // `[:label` takes the alias before its colon; a hop written without one
    // (`[#linked`) takes the colon too.
    let text = if src.units().get(open) == Some(&(b':' as u16)) { alias.clone() } else { format!("{alias}:") };
    (alias, Some((At { start: open, end: open }, text)))
}

impl Checker<'_> {
    /// `checkWalkFields` (version 5): a walk's fields through its alias, in
    /// a slot or a block head (read through its probe, `raw`).
    pub fn check_walk_fields(&mut self, tree: &MExpr, raw: &str, place: crate::families::calls::TreeAt, scope: ScopeId) {
        if self.type_only > 0 {
            return;
        }
        let found = {
            let binds = |name: &str| matches!(self.scopes.resolve(scope, name), crate::scope::Resolution::Found(_) | crate::scope::Resolution::Pending);
            walk_fields(tree, raw, &binds)
        };
        for f in found {
            let span = place.span_of(f.at);
            let edits: Option<Vec<serde_json::Value>> =
                f.edits.iter().map(|(at, text)| place.extent_of(*at).map(|span| serde_json::json!({ "span": span, "text": text }))).collect();
            let fix = edits.filter(|e| !e.is_empty()).map(|edits| if f.safe { serde_json::json!({ "edits": edits, "safe": true }) } else { serde_json::json!({ "edits": edits }) });
            self.push(Diagnostic { fix, ..Diagnostic::error(codes::V5_SPELLING, f.message, span) });
        }
    }
}

// ── Arguments by position (design §2.7) ──

/// A callee's parameters as a call passes them from version 5: in order,
/// then (a plugin's) the names its settings record takes.
#[derive(Debug, Clone)]
pub struct ArgOrder {
    pub positional: Vec<String>,
    /// `None` for a function: every parameter is positional.
    pub settings: Option<Vec<String>>,
}

/// The parser's finding for a call with named arguments, its fix the
/// arguments in the order of the callee's parameters, a plugin's settings in
/// a trailing record: kept only for a callee whose parameters the check saw,
/// and without a fix where the names do not match the parameters (the call's
/// own diagnostics say why).
pub fn positional(
    finding: &movement_parser::surface::SpellingFinding,
    named: &movement_parser::surface::NamedCall,
    orders: &std::collections::HashMap<(usize, usize), ArgOrder>,
) -> Option<Diagnostic> {
    let first = named.args.first()?;
    let order = orders.get(&(first.at.line, first.at.col))?;
    let ordered: Option<Vec<&movement_parser::surface::NamedArg>> = order.positional.iter().map(|p| named.args.iter().find(|a| &a.name == p)).collect();
    let settings: Vec<&movement_parser::surface::NamedArg> = named.args.iter().filter(|a| !order.positional.contains(&a.name)).collect();
    let settles = match &order.settings {
        None => settings.is_empty(),
        Some(names) => settings.iter().all(|a| names.contains(&a.name)),
    };
    let fix = ordered.filter(|o| settles && o.len() + settings.len() == named.args.len()).map(|ordered| {
        let mut texts: Vec<String> = ordered.iter().map(|a| a.text.clone()).collect();
        if !settings.is_empty() {
            texts.push(format!("{{ {} }}", settings.iter().map(|a| format!("{}: {}", a.name, a.text)).collect::<Vec<_>>().join(", ")));
        }
        // Safe when the arguments keep the order they were written in: moved,
        // they would be evaluated in another order.
        let kept = ordered.iter().chain(&settings).zip(&named.args).all(|(a, b)| std::ptr::eq(*a, b));
        if kept {
            serde_json::json!({ "edits": [{ "span": finding.span, "text": texts.join(", ") }], "safe": true })
        } else {
            serde_json::json!({ "edits": [{ "span": finding.span, "text": texts.join(", ") }] })
        }
    });
    Some(Diagnostic { fix, ..Diagnostic::error(&finding.code, finding.message.clone(), finding.span) })
}
