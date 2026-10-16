//! The v5 surface read into the canonical tree. From language version 5 an
//! expression is written in the everyday spelling (`Text.upper(x)`, `a && b`,
//! `c ? a : b`, `map(xs, f, settings)`); the tree every checker and engine
//! reads is the one versions 1–4 parse (`UPPER(x)`, `a AND b`, `IF … END`,
//! `MAP(xs, settings, f)`). This pass rewrites the first into the second, so
//! nothing downstream learns a second spelling, and reports every old
//! spelling it meets as a finding carrying the exact rewrite.
//!
//! It runs on a tree the grammar built, before lowering: a pure rewrite of
//! names and argument order. What it cannot rewrite without the checker's
//! knowledge (a callee's signature, a value's type) it reports as not yet
//! supported rather than guessing.

use crate::tree::{
    self, At, BinaryOp, CallArg, ClosureBody, LiteralValue, MExpr, MapKey, MapMember, Name, Quote, StringPart, UnaryOp,
};
use crate::util::utf16::Utf16;

use super::table::{self, Shape, Spelling};
use super::{Edit, Finding, NOT_YET_CODE, SPELLING_CODE, UNKNOWN_MEMBER_CODE};

pub struct Canon<'s> {
    src: &'s Utf16,
    pub findings: Vec<Finding>,
}

fn hole() -> MExpr {
    MExpr::Literal { value: LiteralValue::Null(()), at: At { start: 0, end: 0 } }
}

fn take(e: &mut MExpr) -> MExpr {
    std::mem::replace(e, hole())
}

fn name_expr(text: &str, at: At) -> MExpr {
    MExpr::Name { name: Name { text: text.to_string(), quoted: false, at }, at, field: false }
}

/// The canonical callee for a row: `UPPER` is a name, `DATE.TODAY` a member.
fn canonical_callee(canonical: &str, at: At) -> MExpr {
    match canonical.split_once('.') {
        Some((ns, member)) => MExpr::Member {
            object: Box::new(name_expr(ns, at)),
            property: Name { text: member.to_string(), quoted: false, at },
            at,
        },
        None => name_expr(canonical, at),
    }
}

/// A field name as source: bare when it can be, backticked otherwise.
fn field_source(name: &str) -> String {
    if is_ident(name) {
        name.to_string()
    } else {
        format!("`{}`", name.replace('`', "\\`"))
    }
}

fn is_ident(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// From version 5 a hop's WHERE and ORDER BY read its record's fields
/// through its alias (`c.Name`, design §2.5); the canonical tree reads them
/// bare, as versions 1–4 wrote them, so the gates and the pushdown see the
/// field they always saw. The bare name keeps the alias read's extent and is
/// marked as only ever the field (`MExpr::Name::field`), so neither a checker
/// nor an engine reads it as a variable of the same name; a name written bare
/// is an outer variable from 5 (refused when it is not one). A walk nested in
/// the WHERE keeps its own hops' reads: a bare name there is ITS record's
/// field.
fn through_alias(e: &mut MExpr, alias: &str) {
    if let MExpr::Member { object, property, at } = e
        && matches!(object.as_ref(), MExpr::Name { name, .. } if name.text == alias && !name.quoted)
    {
        *e = MExpr::Name { name: Name { text: property.text.clone(), quoted: property.quoted, at: *at }, at: *at, field: true };
        return;
    }
    match e {
        MExpr::Path { root, .. } => {
            if let Some(root) = root {
                through_alias(root, alias);
            }
        }
        MExpr::Where { source, .. } => through_alias(source, alias),
        _ => tree::exclusive::expr(e, &mut |child| through_alias(child, alias)),
    }
}

/// The `!` an expression tighter than `&&` begins with, when versions 1–4
/// would have read that `!` over the whole of it.
fn bang_on_left(e: &MExpr) -> Option<At> {
    let left = match e {
        MExpr::Binary { op: BinaryOp::And | BinaryOp::Or, .. } => return None,
        MExpr::Binary { left, .. } => left,
        MExpr::Is { subject, .. } => subject,
        MExpr::Within { operand, .. } | MExpr::Exists { operand, .. } => operand,
        _ => return None,
    };
    let mut first = left.as_ref();
    loop {
        first = match first {
            MExpr::Unary { op: UnaryOp::Not, at, .. } => {
                return (at.start == e.at().start && at.end > at.start).then_some(*at);
            }
            MExpr::Binary { op: BinaryOp::And | BinaryOp::Or, .. } => return None,
            MExpr::Binary { left, .. } => left,
            MExpr::Is { subject, .. } => subject,
            MExpr::Within { operand, .. } | MExpr::Exists { operand, .. } => operand,
            _ => return None,
        };
    }
}

/// How `sort(…)` reads (`Canon::sort_key`).
enum SortReading {
    /// `SORT(xs)` or `SORT(xs, DESC)`: plain values by themselves.
    Plain,
    /// `SORTBY(xs, settings, f)`: by a function key.
    ByFunction,
    /// A keyless sort whose order is not written in place.
    NotYet,
}

/// `(x) => x`: the member itself.
fn is_identity(e: &MExpr) -> bool {
    let MExpr::Closure { params, body, .. } = e else { return false };
    let [param] = params.as_slice() else { return false };
    matches!(body.as_ref(), ClosureBody::Expr { expr } if matches!(expr, MExpr::Name { name, .. } if name.text == param.name.text && !name.quoted))
}

fn is_walk(e: &MExpr) -> bool {
    matches!(e, MExpr::Path { .. } | MExpr::Where { .. })
}

fn is_primary(e: &MExpr) -> bool {
    matches!(
        e,
        MExpr::Literal { .. }
            | MExpr::String { .. }
            | MExpr::Name { .. }
            | MExpr::Special { .. }
            | MExpr::Paren { .. }
            | MExpr::List { .. }
            | MExpr::Map { .. }
            | MExpr::Member { .. }
            | MExpr::Index { .. }
            | MExpr::Call { .. }
    )
}

impl<'s> Canon<'s> {
    pub fn new(src: &'s Utf16) -> Self {
        Canon { src, findings: Vec::new() }
    }

    fn text(&self, at: At) -> String {
        self.src.text(at.start, at.end)
    }

    /// `at` is the whole text, or all that is inside a pair of parentheses
    /// (an `if` condition from version 5, a group, a call's one argument): a
    /// rewrite there needs no parentheses of its own.
    fn whole(&self, at: At) -> bool {
        let before = self.text(At { start: 0, end: at.start });
        let after = self.text(At { start: at.end, end: self.src.len() });
        let (before, after) = (before.trim(), after.trim());
        (before.is_empty() && after.is_empty()) || (before.ends_with('(') && after.starts_with(')'))
    }

    /// `text`, parenthesised unless it is the whole expression.
    fn grouped(&self, at: At, text: String) -> String {
        if self.whole(at) { text } else { format!("({text})") }
    }

    /// An old spelling whose rewrite reads into the tree the old one did.
    fn old(&mut self, at: At, message: String, edit: Option<Edit>) {
        self.old_kept(at, message, edit, true);
    }

    /// An old spelling, `safe` saying whether its rewrite provably keeps the
    /// meaning (`Fix::safe`).
    fn old_kept(&mut self, at: At, message: String, edit: Option<Edit>, safe: bool) {
        self.findings.push(Finding { code: SPELLING_CODE, message, at, edits: edit.map(|e| vec![e]), unless_bound: None, safe, unsafe_if_bound: Vec::new() });
    }

    fn not_yet(&mut self, at: At, message: String) {
        self.findings.push(Finding { code: NOT_YET_CODE, message, at, edits: None, unless_bound: None, safe: false, unsafe_if_bound: Vec::new() });
    }

    pub fn visit(&mut self, e: &mut MExpr, in_walk: bool) {
        match e {
            MExpr::Path { root, hops, .. } => {
                if let Some(root) = root {
                    self.visit(root, in_walk);
                }
                for hop in hops {
                    if let Some(w) = &mut hop.where_ {
                        self.visit(w, true);
                        if let Some(alias) = &hop.alias {
                            through_alias(w, &alias.text);
                        }
                    }
                    if let Some(config) = &mut hop.config {
                        for member in &mut config.entries {
                            match member {
                                MapMember::Entry { value, .. } => self.visit(value, in_walk),
                                MapMember::Spread(s) => self.visit(&mut s.expr, in_walk),
                            }
                        }
                    }
                    if let Some(order) = &mut hop.order_by {
                        self.visit(&mut order.key, true);
                        if let Some(alias) = &hop.alias {
                            through_alias(&mut order.key, &alias.text);
                        }
                    }
                }
            }
            MExpr::Where { source, predicate, .. } => {
                self.visit(source, in_walk);
                self.visit(predicate, true);
            }
            _ => tree::exclusive::expr(e, &mut |child| self.visit(child, in_walk)),
        }
        self.negation_reach(e);
        if in_walk { self.inside_walk(e) } else { self.outside_walk(e) }
    }

    // ── `!` binds as TypeScript's unary operator ──

    /// `!a == b` is `(!a) == b` from version 5; versions 1–4 read the `!`
    /// over the whole comparison, `!(a == b)`. The meaning changed, not the
    /// spelling, so the text is refused and the fix writes the old reading
    /// out: an upgrade keeps what the movement did, and a new author writes
    /// the parentheses they mean. The outermost expression the old `!` would
    /// have reached carries the finding (it is visited after the inner ones).
    fn negation_reach(&mut self, e: &MExpr) {
        let Some(bang) = bang_on_left(e) else { return };
        let at = e.at();
        let rest = self.text(At { start: bang.start + 1, end: at.end });
        let message = format!(
            "from language version 5 `!` applies to the operand beside it: `{}` is `(!{}) …`, where versions 1–4 read `!({})` — write the parentheses",
            self.text(at),
            self.text(At { start: bang.start + 1, end: bang.end }).trim_start(),
            rest.trim_start()
        );
        let finding = Finding { code: SPELLING_CODE, message, at, edits: Some(vec![Edit { at, text: format!("!({})", rest.trim_start()) }]), unless_bound: None, safe: true, unsafe_if_bound: Vec::new() };
        let same_bang = |f: &Finding| f.code == SPELLING_CODE && f.at.start == bang.start && f.message.starts_with("from language version 5 `!`");
        match self.findings.iter_mut().find(|f| same_bang(f)) {
            Some(inner) => *inner = finding,
            None => self.findings.push(finding),
        }
    }

    // ── Inside walk brackets: CAPS words in any case; the everyday spelling is refused ──

    fn inside_walk(&mut self, e: &mut MExpr) {
        let MExpr::Call { callee, .. } = e else { return };
        let MExpr::Member { object, property, at } = callee.as_ref() else { return };
        let MExpr::Name { name: ns, .. } = object.as_ref() else { return };
        let written = format!("{}.{}", ns.text, property.text);
        if let Some((caps, _)) = table::WALK_CAPS.iter().find(|(_, everyday)| *everyday == written) {
            let message = format!("inside walk brackets `{written}` is written `{caps}`");
            self.old(*at, message, Some(Edit { at: *at, text: caps.to_string() }));
            return;
        }
        // `Text.includes(t, v)` and `List.includes(xs, v)` read inside the
        // brackets as they read outside: the `t CONTAINS v` and `v IN xs`
        // written there.
        if let Some(row) = table::by_v5(&written).filter(|row| matches!(row.shape, Shape::Contains | Shape::ListIncludes)) {
            self.rewrite(row, e);
        }
    }

    // ── Outside walk brackets: the everyday spelling ──

    fn outside_walk(&mut self, e: &mut MExpr) {
        match e {
            MExpr::Literal { value: LiteralValue::Bool(_) | LiteralValue::Null(()), at } => {
                let written = self.text(*at);
                let lower = written.to_ascii_lowercase();
                if written != lower {
                    self.old(*at, format!("`{written}` is written `{lower}`"), Some(Edit { at: *at, text: lower }));
                }
            }
            MExpr::Binary { op, left, right, at } => {
                let (left_at, right_at, whole) = (left.at(), right.at(), *at);
                self.binary(*op, left_at, right_at, whole);
            }
            MExpr::Unary { op: UnaryOp::Not, operand, at } => {
                let written = self.text(*at);
                if written.get(..3).is_some_and(|w| w.eq_ignore_ascii_case("NOT")) {
                    let operand_text = self.text(operand.at());
                    let text = if is_primary(operand) { format!("!{operand_text}") } else { format!("!({operand_text})") };
                    self.old(*at, "`NOT` is written `!` outside walk brackets".into(), Some(Edit { at: *at, text }));
                }
            }
            MExpr::If { condition, then, else_, at } => {
                let written = self.text(*at);
                if written.get(..2).is_some_and(|w| w.eq_ignore_ascii_case("IF")) {
                    let otherwise = else_.as_ref().map_or_else(|| "null".to_string(), |x| self.text(x.at()));
                    let text = self.grouped(*at, format!("{} ? {} : {otherwise}", self.text(condition.at()), self.text(then.at())));
                    self.old(*at, "`IF … THEN … ELSE … END` is written `c ? a : b`".into(), Some(Edit { at: *at, text }));
                }
            }
            MExpr::Is { subject, at, .. } => {
                let after = At { start: subject.at().end, end: at.end };
                let gap = self.text(after);
                let lead = gap.len() - gap.trim_start().len();
                if let Some(word) = gap.trim_start().get(..2)
                    && word != "is"
                    && word.eq_ignore_ascii_case("is")
                {
                    let start = after.start + gap[..lead].encode_utf16().count();
                    let word_at = At { start, end: start + 2 };
                    self.old(word_at, format!("`{word}` is written `is`"), Some(Edit { at: word_at, text: "is".into() }));
                }
            }
            MExpr::Index { object, index, at } => {
                let call = MExpr::Call {
                    callee: Box::new(name_expr("AT", At { start: at.start, end: at.start })),
                    args: vec![CallArg { name: None, value: take(object) }, CallArg { name: None, value: take(index) }],
                    at: *at,
                };
                *e = call;
            }
            MExpr::Call { callee, .. } => {
                // A finding about a bare callee's name stands only where the
                // program does not bind that name (§4.2).
                let bare = match callee.as_ref() {
                    MExpr::Name { name, .. } if !name.quoted => Some(name.text.clone()),
                    _ => None,
                };
                let before = self.findings.len();
                self.call(e);
                for finding in &mut self.findings[before..] {
                    finding.unless_bound.clone_from(&bare);
                }
            }
            _ => {}
        }
    }

    fn binary(&mut self, op: BinaryOp, left: At, right: At, whole: At) {
        let gap_at = At { start: left.end, end: right.start };
        let gap = self.text(gap_at);
        let word = gap.trim();
        let lead = gap.len() - gap.trim_start().len();
        let word_start = gap_at.start + gap[..lead].encode_utf16().count();
        let word_at = At { start: word_start, end: word_start + word.encode_utf16().count() };
        match op {
            BinaryOp::And | BinaryOp::Or => {
                let new = if op == BinaryOp::And { "&&" } else { "||" };
                if word != new {
                    self.old(word_at, format!("`{word}` is written `{new}` outside walk brackets"), Some(Edit { at: word_at, text: new.into() }));
                }
            }
            // `Text.includes(l, r)` is the call whose tree is `l CONTAINS r`,
            // whatever `l` is; the checker, which knows when `l` is a list,
            // writes `List.includes` there (checker typed_spelling).
            BinaryOp::Contains if word.eq_ignore_ascii_case("CONTAINS") => {
                let text = format!("Text.includes({}, {})", self.text(left), self.text(right));
                self.old(whole, "`CONTAINS` outside walk brackets is written `Text.includes(t, v)` (a list's is `List.includes(xs, v)`)".into(), Some(Edit { at: whole, text }));
            }
            BinaryOp::In if word.eq_ignore_ascii_case("IN") => {
                let text = format!("List.includes({}, {})", self.text(right), self.text(left));
                self.old(whole, "`IN` outside walk brackets is written `List.includes(xs, v)`".into(), Some(Edit { at: whole, text }));
            }
            _ => {}
        }
    }

    fn call(&mut self, e: &mut MExpr) {
        let MExpr::Call { callee, args, at } = e else { return };
        let at = *at;
        let callee_at = callee.at();
        let written = match callee.as_ref() {
            MExpr::Name { name, .. } if !name.quoted => Some(name.text.clone()),
            MExpr::Member { object, property, .. } => match object.as_ref() {
                MExpr::Name { name, .. } if !name.quoted && !property.quoted => Some(format!("{}.{}", name.text, property.text)),
                _ => None,
            },
            _ => None,
        };
        let Some(written) = written else { return };

        // A v5 spelling, exactly as written: read into the canonical call.
        if let Some(row) = table::by_v5(&written) {
            if self.is_old_shape(row, args) {
                self.old_call(row, &written, args, at, callee_at);
                return;
            }
            self.rewrite(row, e);
            return;
        }
        // A namespace the language holds, with no such member.
        if let Some((ns, member)) = written.split_once('.')
            && table::NAMESPACES.contains(&ns)
        {
            let near = table::SPELLINGS.iter().find(|s| !s.old_only && s.v5.eq_ignore_ascii_case(&written));
            let message = match near {
                Some(s) => format!("`{ns}` has no member `{member}` — did you mean `{}`?", s.v5),
                None => format!("`{ns}` has no member `{member}`"),
            };
            let edits = near.map(|s| vec![Edit { at: callee_at, text: s.v5.to_string() }]);
            // A did-you-mean is a guess at what was meant, never safe.
            self.findings.push(Finding { code: UNKNOWN_MEMBER_CODE, message, at: callee_at, edits, unless_bound: None, safe: false, unsafe_if_bound: Vec::new() });
            return;
        }
        // An old spelling: refused with its rewrite.
        if let Some(row) = table::by_canonical(&written) {
            self.old_call(row, &written, args, at, callee_at);
            return;
        }
        // A core word or a namespace in the wrong letter case.
        if let Some(row) = table::SPELLINGS.iter().find(|s| !s.old_only && s.v5.eq_ignore_ascii_case(&written)) {
            let message = format!("`{written}` — did you mean `{}`?", row.v5);
            self.old(callee_at, message, Some(Edit { at: callee_at, text: row.v5.to_string() }));
        }
    }

    /// A v5 name written with the old call's arguments (`callback(f(x))`,
    /// `exists(value)`): the name is right, the shape is not.
    fn is_old_shape(&self, row: &Spelling, args: &[CallArg]) -> bool {
        match row.shape {
            Shape::CallbackClosure => args.first().is_some_and(|a| !matches!(a.value, MExpr::Closure { .. })),
            Shape::ExistsWalk => args.first().is_some_and(|a| !is_walk(&a.value)),
            _ => false,
        }
    }

    fn arg_text(&self, args: &[CallArg], i: usize) -> String {
        args.get(i).map(|a| self.text(a.value.at())).unwrap_or_default()
    }

    /// The finding for an old spelling, with the rewrite its shape gives.
    fn old_call(&mut self, row: &Spelling, written: &str, args: &[CallArg], at: At, callee_at: At) {
        let a = |i: usize| self.arg_text(args, i);
        let rename = Edit { at: callee_at, text: row.v5.to_string() };
        let (message, edit) = match row.shape {
            Shape::Same | Shape::Contains | Shape::ListIncludes => (format!("`{written}` is written `{}` from language version 5", row.v5), Some(rename)),
            Shape::SettingsLast if args.len() == 3 => {
                (format!("`{written}` is written `{}`, its settings last", row.v5), Some(Edit { at, text: format!("{}({}, {}, {})", row.v5, a(0), a(2), a(1)) }))
            }
            Shape::SettingsLast => (format!("`{written}` is written `{}`", row.v5), Some(rename)),
            Shape::ReduceOrder if args.len() == 3 => (
                format!("`{written}` is written `{}`, its function before its start", row.v5),
                Some(Edit { at, text: format!("{}({}, {}, {})", row.v5, a(0), a(2), a(1)) }),
            ),
            Shape::ReduceOrder => (format!("`{written}` is written `{}`", row.v5), Some(rename)),
            Shape::SortKey => {
                let direction = |e: &MExpr| match e {
                    MExpr::Name { name, .. } if name.text.eq_ignore_ascii_case("ASC") || name.text.eq_ignore_ascii_case("DESC") => {
                        Some(format!("{{ order: \"{}\" }}", name.text.to_ascii_lowercase()))
                    }
                    _ => None,
                };
                let values: Vec<&MExpr> = args.iter().map(|a| &a.value).collect();
                // `/^(ASC|DESC)$/i` last is the direction, as the lowering reads it.
                let (rest, order) = match values.split_last() {
                    Some((last, rest)) if !rest.is_empty() && direction(last).is_some() => (rest, direction(last)),
                    _ => (values.as_slice(), None),
                };
                let key = match rest {
                    [_] => Some(None),
                    [_, MExpr::Name { name, .. }] => Some(Some(format!("(r) => r.{}", field_source(&name.text)))),
                    _ => None,
                };
                let message = format!("`{written}` is written `{}`, its key a function", row.v5);
                match key {
                    Some(key) => {
                        let text = [Some(a(0)), key, order].into_iter().flatten().collect::<Vec<_>>().join(", ");
                        (message, Some(Edit { at, text: format!("{}({text})", row.v5) }))
                    }
                    None => (message, None),
                }
            }
            Shape::AiTier if args.len() == 2 => (
                format!("`{written}` is written `{}`, its tier a setting", row.v5),
                Some(Edit { at, text: format!("{}({}, {{ tier: {} }})", row.v5, a(0), a(1)) }),
            ),
            Shape::AiTier => (format!("`{written}` is written `{}`", row.v5), Some(rename)),
            Shape::CallbackClosure => (
                "`callback(f(x))` is written `callback(() => f(x))` from language version 5".into(),
                Some(Edit { at, text: format!("callback(() => {})", a(0)) }),
            ),
            Shape::JsonStringify => {
                let format = args.get(1).map(|f| self.text(f.value.at()).trim_matches(['"', '\'']).to_ascii_uppercase());
                let message = format!("`{written}` is written `{}`", row.v5);
                if format.as_deref() == Some("JSON") { (message, Some(Edit { at, text: format!("{}({})", row.v5, a(0)) })) } else { (message, None) }
            }
            Shape::NullTest => (
                format!("`{written}(x)` is written `x == null` from language version 5"),
                Some(Edit { at, text: self.grouped(at, format!("{} == null", a(0))) }),
            ),
            // Always `x[k]`, which reads back into `AT(x, k)`: `x.k` is a
            // field read, which on a record answers where `AT` refused, and
            // whether `x` is a record only the checker knows. The object is
            // parenthesised unless it is a primary (`a + b[0]` is not
            // `AT(a + b, 0)`).
            Shape::Index => {
                let object = match args.first() {
                    Some(o) if !is_primary(&o.value) => format!("({})", a(0)),
                    _ => a(0),
                };
                let text = format!("{object}[{}]", a(1));
                (format!("`{written}(x, i)` is written `x[i]` from language version 5"), Some(Edit { at, text }))
            }
            Shape::ExistsWalk => match args.first() {
                Some(arg) if is_walk(&arg.value) => (format!("`{written}` is written `exists`"), Some(rename)),
                _ => (
                    "`exists` takes a walk; a value's presence is written `x != null`".into(),
                    Some(Edit { at, text: self.grouped(at, format!("{} != null", a(0))) }),
                ),
            },
        };
        // Proved only where the rewrite reads into the old tree. Not proved:
        // `== null` / `!= null` (a comparison where the old text was a call,
        // which the engines answer alike only for what sem1 pinned).
        let safe = match row.shape {
            Shape::NullTest => false,
            Shape::ExistsWalk => args.first().is_some_and(|arg| is_walk(&arg.value)),
            _ => true,
        };
        // A sort key read off a bare name read an outer variable of that name
        // first, and the rewrite reads the member's field: the same only
        // where no such variable is in scope (nor one the parameter `r`
        // would hide), which the checker decides.
        let unsafe_if_bound = match (row.shape, args.get(1).map(|a| &a.value)) {
            (Shape::SortKey, Some(MExpr::Name { name, .. })) if !name.text.eq_ignore_ascii_case("ASC") && !name.text.eq_ignore_ascii_case("DESC") => {
                vec![name.text.clone(), "r".to_string()]
            }
            _ => Vec::new(),
        };
        self.findings.push(Finding { code: SPELLING_CODE, message, at, edits: edit.map(|e| vec![e]), unless_bound: None, safe, unsafe_if_bound });
    }

    /// Reads a v5 call into the canonical one.
    fn rewrite(&mut self, row: &Spelling, e: &mut MExpr) {
        let MExpr::Call { callee, args, at } = e else { return };
        let at = *at;
        let callee_at = callee.at();
        match row.shape {
            Shape::Contains => {
                if args.len() != 2 {
                    return;
                }
                let right = args.pop().unwrap().value;
                let left = args.pop().unwrap().value;
                *e = MExpr::Binary { op: BinaryOp::Contains, left: Box::new(left), right: Box::new(right), at };
                return;
            }
            Shape::ListIncludes => {
                if args.len() != 2 {
                    return;
                }
                let value = args.pop().unwrap().value;
                let list = args.pop().unwrap().value;
                *e = MExpr::Binary { op: BinaryOp::In, left: Box::new(value), right: Box::new(list), at };
                return;
            }
            Shape::SettingsLast | Shape::ReduceOrder if args.len() == 3 => args.swap(1, 2),
            Shape::SortKey => match self.sort_key(args) {
                SortReading::Plain => {}
                // `sort(xs, f, settings)` is `SORTBY(xs, settings, f)`: a
                // collection op, its function run once per member.
                SortReading::ByFunction => {
                    if args.len() == 3 {
                        args.swap(1, 2);
                    }
                    **callee = canonical_callee(table::SORT_BY, callee_at);
                    return;
                }
                SortReading::NotYet => {
                    self.not_yet(at, "for now `sort` with no key takes its order written in place: `sort(xs, { order: \"asc\" | \"desc\" })`".into());
                    return;
                }
            },
            Shape::AiTier if args.len() == 2 => {
                let tier = match &mut args[1].value {
                    MExpr::Map { entries, .. } if entries.len() == 1 => match &mut entries[0] {
                        MapMember::Entry { key: MapKey::Name(k), value } if k.text == "tier" => Some(take(value)),
                        _ => None,
                    },
                    _ => None,
                };
                match tier {
                    Some(tier) => args[1].value = tier,
                    None => {
                        self.not_yet(at, "for now `ai`'s settings hold only `tier`".into());
                        return;
                    }
                }
            }
            Shape::CallbackClosure => {
                let body = match args.first_mut().map(|a| &mut a.value) {
                    Some(MExpr::Closure { params, body, .. }) if params.is_empty() => match body.as_mut() {
                        ClosureBody::Expr { expr } => Some(take(expr)),
                        ClosureBody::Block { .. } => None,
                    },
                    _ => None,
                };
                match body {
                    Some(body) => args[0].value = body,
                    None => {
                        self.not_yet(at, "for now `callback` takes `() => f(x)`: no parameters, one call".into());
                        return;
                    }
                }
            }
            Shape::JsonStringify => {
                let end = At { start: at.end, end: at.end };
                args.push(CallArg { name: None, value: MExpr::String { quote: Quote::Double, parts: vec![StringPart::Text("JSON".into())], at: end } });
            }
            _ => {}
        }
        **callee = canonical_callee(row.canonical, callee_at);
    }

    /// `sort(xs)` and `sort(xs, { order: "desc" })` sort plain values by
    /// themselves, as `SORT(xs)` and `SORT(xs, DESC)` do, and so does the key
    /// `(x) => x`; any other key is a function (`SORTBY`), run per member
    /// with the member bound to its parameter — never a name read in the
    /// member's scope, where an outer variable would hide its field.
    fn sort_key(&mut self, args: &mut Vec<CallArg>) -> SortReading {
        let is_settings = |e: &MExpr| matches!(e, MExpr::Map { .. });
        let keyed = match args.len() {
            0 | 1 => false,
            2 => !is_settings(&args[1].value),
            _ => true,
        };
        if keyed && !is_identity(&args[1].value) {
            return SortReading::ByFunction;
        }
        if args.len() > 3 {
            return SortReading::ByFunction;
        }
        let settings_last = args.len() > 1 && is_settings(&args[args.len() - 1].value);
        if keyed && args.len() == 3 && !settings_last {
            return SortReading::ByFunction;
        }
        let order = if settings_last {
            let Some(MExpr::Map { entries, .. }) = args.last().map(|a| &a.value) else { return SortReading::NotYet };
            match entries.as_slice() {
                [MapMember::Entry { key: MapKey::Name(k), value: MExpr::String { parts, at, .. } }] if k.text == "order" => match parts.as_slice() {
                    [StringPart::Text(t)] if t == "asc" || t == "desc" => Some((t.to_ascii_uppercase(), *at)),
                    _ => return SortReading::NotYet,
                },
                _ => return SortReading::NotYet,
            }
        } else {
            None
        };
        if let Some((direction, at)) = order {
            let last = args.len() - 1;
            args[last].value = name_expr(&direction, at);
        }
        if keyed {
            args.remove(1);
        }
        SortReading::Plain
    }
}
