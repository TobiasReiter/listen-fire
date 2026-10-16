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
    MExpr::Name { name: Name { text: text.to_string(), quoted: false, at }, at }
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

    fn whole(&self, at: At) -> bool {
        self.text(At { start: 0, end: at.start }).trim().is_empty() && self.text(At { start: at.end, end: self.src.len() }).trim().is_empty()
    }

    /// `text`, parenthesised unless it is the whole expression.
    fn grouped(&self, at: At, text: String) -> String {
        if self.whole(at) { text } else { format!("({text})") }
    }

    fn old(&mut self, at: At, message: String, edit: Option<Edit>) {
        self.findings.push(Finding { code: SPELLING_CODE, message, at, edits: edit.map(|e| vec![e]) });
    }

    fn not_yet(&mut self, at: At, message: String) {
        self.findings.push(Finding { code: NOT_YET_CODE, message, at, edits: None });
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
                    }
                }
            }
            MExpr::Where { source, predicate, .. } => {
                self.visit(source, in_walk);
                self.visit(predicate, true);
            }
            _ => tree::exclusive::expr(e, &mut |child| self.visit(child, in_walk)),
        }
        if in_walk { self.inside_walk(e) } else { self.outside_walk(e) }
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
            MExpr::Call { .. } => self.call(e),
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
            BinaryOp::Contains if word.eq_ignore_ascii_case("CONTAINS") => {
                let right_text = self.text(right);
                let namespace = if right_text.starts_with('"') || right_text.starts_with('\'') { "Text" } else { "List" };
                let text = format!("{namespace}.includes({}, {right_text})", self.text(left));
                self.old(whole, format!("`CONTAINS` outside walk brackets is written `{namespace}.includes(…)`"), Some(Edit { at: whole, text }));
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
            self.findings.push(Finding { code: UNKNOWN_MEMBER_CODE, message, at: callee_at, edits });
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
            Shape::Index => {
                let key = args.get(1).and_then(|k| match &k.value {
                    MExpr::String { parts, .. } => match parts.as_slice() {
                        [StringPart::Text(t)] if is_ident(t) => Some(t.clone()),
                        _ => None,
                    },
                    _ => None,
                });
                let text = match key {
                    Some(k) => format!("{}.{k}", a(0)),
                    None => format!("{}[{}]", a(0), a(1)),
                };
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
        self.old(at, message, edit);
    }

    /// Reads a v5 call into the canonical one.
    fn rewrite(&mut self, row: &Spelling, e: &mut MExpr) {
        let MExpr::Call { callee, args, at } = e else { return };
        let at = *at;
        let callee_at = callee.at();
        // `fail(…)` is a statement (`ERROR(…)`); no version has a value that
        // never returns, which the design's `coalesce(x, fail("…"))` needs.
        if row.canonical == "ERROR" {
            self.not_yet(at, "for now `fail(…)` is a statement of its own: `if (x == null) { fail(\"…\") }`".into());
            return;
        }
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
            Shape::SortKey => {
                if !self.sort_key(args) {
                    self.not_yet(at, "for now `sort`'s key is absent, the member itself `(r) => r`, or one field `(r) => r.field`, and its settings `{ order: \"asc\" | \"desc\" }`".into());
                    return;
                }
            }
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

    /// `sort(xs, (r) => r.field, { order: "desc" })` → ``SORT(xs, `field`, DESC)``;
    /// `sort(xs)` and `sort(xs, { order: "desc" })` sort plain values by
    /// themselves, as `SORT(xs)` and `SORT(xs, DESC)` do, and so does the
    /// key `(r) => r`.
    fn sort_key(&mut self, args: &mut Vec<CallArg>) -> bool {
        let settings_last = args.len() > 1 && matches!(args.last().map(|a| &a.value), Some(MExpr::Map { .. }));
        let order = if settings_last {
            let Some(MExpr::Map { entries, .. }) = args.last().map(|a| &a.value) else { return false };
            match entries.as_slice() {
                [MapMember::Entry { key: MapKey::Name(k), value: MExpr::String { parts, at, .. } }] if k.text == "order" => match parts.as_slice() {
                    [StringPart::Text(t)] if t == "asc" || t == "desc" => Some((t.to_ascii_uppercase(), *at)),
                    _ => return false,
                },
                _ => return false,
            }
        } else {
            None
        };
        let keyed = args.len() == if settings_last { 3 } else { 2 };
        if args.len() > 3 || (settings_last && args.len() == 3 && !keyed) {
            return false;
        }
        // The key: `None` sorts each member by itself.
        let key = if keyed {
            let Some(MExpr::Closure { params, body, .. }) = args.get(1).map(|a| &a.value) else { return false };
            let [param] = params.as_slice() else { return false };
            let ClosureBody::Expr { expr } = body.as_ref() else { return false };
            match expr {
                MExpr::Name { name, .. } if name.text == param.name.text && !name.quoted => None,
                MExpr::Member { object, property, .. } => match object.as_ref() {
                    MExpr::Name { name, .. } if name.text == param.name.text => Some(property.clone()),
                    _ => return false,
                },
                _ => return false,
            }
        } else {
            None
        };
        if let Some((direction, at)) = order {
            let last = args.len() - 1;
            args[last].value = name_expr(&direction, at);
        }
        match key {
            Some(key) => {
                let key_at = args[1].value.at();
                args[1].value = MExpr::Name { name: Name { text: key.text, quoted: true, at: key_at }, at: key_at };
            }
            None if keyed => {
                args.remove(1);
            }
            None => {}
        }
        true
    }
}
