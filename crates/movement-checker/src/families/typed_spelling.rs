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
                    TypedSpelling { found: Found::Misuse, at: *at, message: "`Text.length` takes text; a list's length is `count(xs)`".into(), text: fix }
                } else {
                    TypedSpelling { found: Found::Respell, at: *at, message: format!("`{written}` of a list is written `count(xs)` from language version 5"), text: fix }
                });
            }
            if canonical == "EXISTS" && !matches!(arg, MExpr::Path { .. } | MExpr::Where { .. }) && kind_of(arg) == Some(ValueKind::List) {
                let fix = format!("count({}) > 0", text(arg.at()));
                let text = if whole(src, *at) { fix } else { format!("({fix})") };
                return Some(TypedSpelling { found: Found::Respell, at: *at, message: format!("`{written}` of a list is written `count(xs) > 0` from language version 5"), text });
            }
            None
        }
        MExpr::Binary { op: BinaryOp::Contains, left, right, at } if kind_of(left) == Some(ValueKind::List) => {
            let fix = format!("List.includes({}, {})", text(left.at()), text(right.at()));
            Some(if text(*at).starts_with("Text.includes") {
                TypedSpelling { found: Found::Misuse, at: *at, message: "`Text.includes` takes text; a list holds a value by `List.includes(xs, v)`".into(), text: fix }
            } else {
                TypedSpelling { found: Found::Respell, at: *at, message: "`CONTAINS` on a list is written `List.includes(xs, v)` from language version 5".into(), text: fix }
            })
        }
        MExpr::Binary { op: BinaryOp::In, left, right, at } if text(*at).starts_with("List.includes") && kind_of(right) == Some(ValueKind::Text) => {
            let fix = format!("Text.includes({}, {})", text(right.at()), text(left.at()));
            Some(TypedSpelling { found: Found::Misuse, at: *at, message: "`List.includes` takes a list; text holds text by `Text.includes(t, v)`".into(), text: fix })
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
            typed_spellings(tree, &slot.raw, &mut kind_of)
        };
        for f in found {
            let span = span_of_extent(slot, f.at);
            let fix = serde_json::json!({ "edits": [{ "span": span, "text": f.text }] });
            match f.found {
                Found::Respell => {
                    self.respelled.insert(span_key(&span), (f.message, fix));
                }
                Found::Misuse => self.push(Diagnostic { fix: Some(fix), ..Diagnostic::error(codes::BUILTIN_ARG_TYPE, f.message, span) }),
            }
        }
    }
}
