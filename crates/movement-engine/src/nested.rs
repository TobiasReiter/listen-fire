//! Nested calls (language version 3), as run.ts `stageNestedCalls` runs
//! them (movement-lang checker/nested_calls.ts): a call written inside an
//! expression that the shared evaluator cannot run — a function the program
//! declares, `extract`, a collection op — is read as the right-hand side of
//! a binding to a name only the engine can spell, and the expression reads
//! that name:
//!
//! ```text
//!     y = f(x) + 1      means      `#nested 1` = f(x)
//!                                  y = `#nested 1` + 1
//! ```
//!
//! in the order the text states the calls, and only where they are reached:
//! `AND`, `OR`, `IF` and `COALESCE` do not reach an operand they do not need.
//! Every operand before the last one holding a call is bound first, so the
//! operands still evaluate left to right. The bindings sit in a scope of
//! their own over the expression's.
//!
//! What is staged here is text: the slot's text with each settled part
//! written as the backticked name it is bound to, which reads (lowered) as
//! the tree the TypeScript rewrites to. Nothing downstream reads a slot's
//! offsets, so the names need not keep the text's length.
//!
//! The TypeScript stages a slot whenever it holds a call of those kinds or a
//! call whose value a member access reads (`ONLY(xs).name`); this engine
//! stages the second only alongside the first, and reads `ONLY(xs).name`
//! itself otherwise, to the same value.

use std::cell::Cell;
use std::rc::Rc;

use movement_parser::ast::{ExprSlot, RValue};
use movement_parser::tree::{At, BinaryOp, ListElement, MExpr, MapMember, StringPart};
use movement_parser::util::utf16::Utf16;

use crate::bindings::{Binding, Scope};
use crate::run::{Address, Failure, Run, Stop};

/// The built-ins that are no value: they run as calls (`form.kind !==
/// 'value'`).
const CALL_FORMS: [&str; 8] = ["MAP", "FILTER", "REDUCE", "GROUPBY", "KEYBY", "MEMBERS", "EXTRACT", "EXTRACTONE"];

/// Whether a built-in's name (in any letter case) is one that runs as a
/// call.
pub(crate) fn is_call_form(name: &str) -> bool {
    CALL_FORMS.contains(&crate::js::to_upper_case(name).as_str())
}

/// `sortKeyOf`: `SORT(xs, key)`'s key, read once per member.
fn sort_key_of(e: &MExpr) -> Option<&MExpr> {
    let MExpr::Call { callee, args, .. } = e else { return None };
    let MExpr::Name { name, .. } = callee.as_ref() else { return None };
    if crate::js::to_upper_case(&name.text) != "SORT" {
        return None;
    }
    let key = &args.get(1)?.value;
    let direction = matches!(key, MExpr::Name { name, .. } if matches!(crate::js::to_upper_case(&name.text).as_str(), "ASC" | "DESC"));
    if direction && args.len() == 2 { None } else { Some(key) }
}

/// `valueChildren`: the sub-expressions read once, as values, where `e` is
/// evaluated — in the order they are written.
pub(crate) fn value_children(e: &MExpr) -> Vec<&MExpr> {
    match e {
        MExpr::Literal { .. }
        | MExpr::Name { .. }
        | MExpr::Special { .. }
        | MExpr::Type { .. }
        | MExpr::Declaration { .. }
        | MExpr::Closure { .. }
        | MExpr::Node { .. }
        | MExpr::Graph { .. }
        | MExpr::Mapped { .. }
        | MExpr::Lazy { .. } => Vec::new(),
        MExpr::String { parts, .. } => parts
            .iter()
            .filter_map(|p| match p {
                StringPart::Expr(e) => Some(e),
                StringPart::Text(_) => None,
            })
            .collect(),
        MExpr::Paren { expr, .. } => vec![expr],
        MExpr::List { elements, .. } => elements
            .iter()
            .map(|x| match x {
                ListElement::Expr(e) => e,
                ListElement::Spread(spread) => &spread.expr,
            })
            .collect(),
        MExpr::Map { entries, .. } => entries
            .iter()
            .map(|x| match x {
                MapMember::Entry { value, .. } => value,
                MapMember::Spread(spread) => &spread.expr,
            })
            .collect(),
        MExpr::Member { object, .. } => vec![object],
        MExpr::Index { object, index, .. } => vec![object, index],
        MExpr::Call { args, .. } => {
            let key = sort_key_of(e);
            args.iter().map(|a| &a.value).filter(|v| key.is_none_or(|k| !std::ptr::eq(*v, k))).collect()
        }
        MExpr::Path { root, .. } => root.iter().map(|r| r.as_ref()).collect(),
        MExpr::Unary { operand, .. } | MExpr::Exists { operand, .. } | MExpr::Within { operand, .. } => vec![operand],
        MExpr::Binary { left, right, .. } => vec![left, right],
        MExpr::Where { source, .. } => vec![source],
        MExpr::Is { subject, .. } => vec![subject],
        MExpr::If { condition, then, else_, .. } => {
            let mut children: Vec<&MExpr> = vec![condition, then];
            children.extend(else_.as_deref());
            children
        }
    }
}

/// Every call reachable as a value from `tree` (calls inside another's
/// arguments included) that `runs` says runs.
fn reachable_calls(tree: &MExpr, runs: &dyn Fn(&MExpr) -> bool, into: &mut Vec<At>) {
    if matches!(tree, MExpr::Call { .. }) && runs(tree) {
        into.push(tree.at());
    }
    for child in value_children(tree) {
        reachable_calls(child, runs, into);
    }
}

/// `hoistingMemberReads`' widening: the calls whose value a member access
/// reads, whatever they call.
fn member_read_calls(tree: &MExpr, into: &mut Vec<At>) {
    if let MExpr::Member { object, .. } = tree
        && let MExpr::Call { callee, .. } = object.as_ref()
        && matches!(callee.as_ref(), MExpr::Name { .. })
    {
        into.push(object.at());
    }
    for child in value_children(tree) {
        member_read_calls(child, into);
    }
}

/// The calls of `tree` that are staged (`nestedCalls` over
/// `hoistingMemberReads`): the calls that run as calls (`runs`), and every
/// call whose value a member access reads (`ONLY(xs).name`), whatever it
/// calls — the shared expression tree reads a field only off a name.
pub(crate) fn staged_calls(tree: &MExpr, runs: &dyn Fn(&MExpr) -> bool) -> Vec<At> {
    let mut read = Vec::new();
    member_read_calls(tree, &mut read);
    let mut calls = Vec::new();
    reachable_calls(tree, &|call| read.contains(&call.at()) || runs(call), &mut calls);
    calls
}

/// Whether `tree` holds one of `calls` where a value is read.
pub(crate) fn holds(tree: &MExpr, calls: &[At]) -> bool {
    (matches!(tree, MExpr::Call { .. }) && calls.contains(&tree.at())) || value_children(tree).into_iter().any(|child| holds(child, calls))
}

/// `shortCircuitOf`: the operators that do not evaluate an operand they do
/// not need.
pub(crate) enum ShortCircuit<'t> {
    And(&'t MExpr, &'t MExpr),
    Or(&'t MExpr, &'t MExpr),
    If(&'t MExpr, &'t MExpr, Option<&'t MExpr>),
    Coalesce(Vec<&'t MExpr>),
}

pub(crate) fn short_circuit_of<'t>(e: &'t MExpr, is_coalesce: &dyn Fn(&str) -> bool) -> Option<ShortCircuit<'t>> {
    match e {
        MExpr::Binary { op: BinaryOp::And, left, right, .. } => Some(ShortCircuit::And(left, right)),
        MExpr::Binary { op: BinaryOp::Or, left, right, .. } => Some(ShortCircuit::Or(left, right)),
        MExpr::If { condition, then, else_, .. } => Some(ShortCircuit::If(condition, then, else_.as_deref())),
        MExpr::Call { callee, args, .. } if matches!(callee.as_ref(), MExpr::Name { name, .. } if is_coalesce(&name.text)) => {
            Some(ShortCircuit::Coalesce(args.iter().map(|a| &a.value).collect()))
        }
        _ => None,
    }
}

/// `conjunctsOf`: a condition's top-level `AND` conjuncts.
pub(crate) fn conjuncts_of(tree: &MExpr) -> Vec<&MExpr> {
    match tree {
        MExpr::Binary { op: BinaryOp::And, left, right, .. } => {
            let mut all = conjuncts_of(left);
            all.extend(conjuncts_of(right));
            all
        }
        other => vec![other],
    }
}

/// `text` of `at` with each of `replaced` (inside it, in order) written in
/// its place.
pub(crate) fn rewritten(units: &Utf16, at: At, mut replaced: Vec<(At, String)>) -> String {
    replaced.sort_by_key(|(at, _)| at.start);
    let mut out = String::new();
    let mut from = at.start;
    for (part, text) in replaced {
        out.push_str(&units.text(from, part.start));
        out.push_str(&text);
        from = part.end;
    }
    out.push_str(&units.text(from, at.end));
    out
}

/// The place of a list element closure a staged text no longer holds.
const NOT_CARRIED: usize = usize::MAX;

/// A piece of `origin`'s text, staged or cut, as a slot holding `origin`'s
/// list element closures again at their places in `text`. Its closures keep
/// `origin`'s order, so the k-th is the program's k-th; one `text` no longer
/// holds (a nested call's argument, settled) is `NOT_CARRIED`. The
/// TypeScript keeps the offsets of the original slot instead
/// (`slotOfTree`); this engine's staged text does not keep them, so each
/// closure is found again by its own text, in order.
pub(crate) fn carried(origin: &ExprSlot, text: String, span: movement_parser::ast::Span) -> ExprSlot {
    if origin.closures.is_empty() {
        return ExprSlot::plain(text, span);
    }
    let extents = |raw: &str| {
        movement_parser::expr::parse_expression(raw).map(|tree| movement_parser::tree::closure_extents_in_lists(&tree)).unwrap_or_default()
    };
    let (old_units, new_units) = (Utf16::new(&origin.raw), Utf16::new(&text));
    let old: Vec<At> = extents(&origin.raw);
    let mut closures: Vec<movement_parser::ast::SlotClosure> =
        origin.closures.iter().map(|c| movement_parser::ast::SlotClosure { at: NOT_CARRIED, closure: c.closure.clone() }).collect();
    let mut next = 0;
    for found in extents(&text) {
        let written = new_units.text(found.start, found.end);
        while next < origin.closures.len() {
            let candidate = next;
            next += 1;
            let same = old.iter().find(|at| at.start == origin.closures[candidate].at).is_some_and(|at| old_units.text(at.start, at.end) == written);
            if same {
                closures[candidate].at = found.start;
                break;
            }
        }
    }
    ExprSlot { raw: text, span, eager: false, closures }
}

/// The offsets the lowering reads a slot's list element closures at.
pub(crate) fn closure_offsets(slot: &ExprSlot) -> Vec<usize> {
    slot.closures.iter().map(|c| c.at).filter(|at| *at != NOT_CARRIED).collect()
}

/// The backticked spelling of a name the staging binds.
pub(crate) fn spelled(name: &str) -> String {
    format!("`{name}`")
}

/// The call written at `at` in `slot` read by the statement grammar as the
/// right-hand side of a binding (`parseNestedCall`), its spans the file's.
pub(crate) fn nested_call(slot: &ExprSlot, at: At, version: u32) -> Result<RValue, String> {
    let head = Utf16::new(&slot.raw).text(0, at.end);
    movement_parser::stmt::Parser::new(&head, version, slot.span.start, true).parse_nested_call_value(at.start).map_err(|e| e.message)
}

/// Where each expression slot is written in the program (crate::program
/// `node_at`'s paths), by its span. A span the program writes twice keeps
/// its first place, in the tree's order; a nested call's slots, once it is
/// read, are where they are in it: the checker read its arguments there
/// (a built-in's call holds the same text as its own arguments too).
pub(crate) type SlotPaths = std::collections::BTreeMap<(usize, usize, usize, usize), String>;

fn span_key(span: &movement_parser::ast::Span) -> (usize, usize, usize, usize) {
    (span.start.line, span.start.col, span.end.line, span.end.col)
}

/// Every slot in `node` (at `path`), by its span, over any noted before
/// when `over`.
fn register_slots(node: &serde_json::Value, path: &str, over: bool, into: &mut SlotPaths) {
    if let Some(slot) = crate::program::slot_of(node) {
        let key = span_key(&slot.span);
        if over || !into.contains_key(&key) {
            into.insert(key, path.to_string());
        }
        // A list element closure's body (language version 5) holds slots
        // of its own.
        if let Some(closures) = node.get("closures") {
            register_slots(closures, &format!("{path}/closures"), over, into);
        }
        return;
    }
    match node {
        serde_json::Value::Object(object) => {
            for (key, child) in object {
                register_slots(child, &format!("{path}/{}", key.replace('~', "~0").replace('/', "~1")), over, into);
            }
        }
        serde_json::Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                register_slots(child, &format!("{path}/{index}"), over, into);
            }
        }
        _ => {}
    }
}

/// One slot's staging (`NestedCallStaging`).
struct Staging<'s> {
    /// The slot as the statement holds it: where the calls' extents are
    /// (`originalSlot`).
    origin: &'s ExprSlot,
    /// Where the staged text starts in the origin's (UTF-16 units).
    offset: usize,
    slot: &'s ExprSlot,
    units: Utf16,
    /// The bindings' scope, over the slot's.
    scratch: Rc<Scope>,
    calls: Vec<At>,
    /// The slot's own scope: `COALESCE` resolved there.
    scope: &'s Rc<Scope>,
    bound: Cell<usize>,
}

type Staged<'s> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, Stop>> + 's>>;
type Settled<'s> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Binding, Stop>> + 's>>;

impl Run<'_> {
    /// `runsAsCall`: a function the program declares (bound exactly, or
    /// from version 3 a function in any letter case), or a built-in that is
    /// no value.
    pub(crate) fn runs_as_call(&self, call: &MExpr, scope: &Scope) -> bool {
        let MExpr::Call { callee, .. } = call else { return false };
        // `box.g()` (language version 5): the member a value holds, called.
        if let MExpr::Member { object, property, .. } = callee.as_ref() {
            return matches!(object.as_ref(), MExpr::Name { name, .. } if self.member_callee_object(&format!("{}.{}", name.text, property.text), scope));
        }
        let MExpr::Name { name, .. } = callee.as_ref() else { return false };
        let written = &name.text;
        if let Some(binding) = scope.resolve(written) {
            return matches!(binding, Binding::Movement(_) | Binding::Plugin(_) | Binding::Opaque | Binding::Closure(_));
        }
        if self.version() < 3 {
            return false;
        }
        scope.resolve_function(written).is_some() || (!written.contains('.') && is_call_form(written)) || self.member_callee_object(written, scope)
    }

    /// `box.g` (language version 5): a dotted callee whose object is a
    /// value calls the member it holds under the key (run.ts
    /// `memberCallee`, the checker's), run first as any call in an
    /// expression is.
    pub(crate) fn member_callee_object(&self, written: &str, scope: &Scope) -> bool {
        let ident = |part: &str| {
            let mut chars = part.chars();
            chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        };
        let Some((object, key)) = written.split_once('.') else { return false };
        self.version() >= 5 && ident(object) && ident(key) && matches!(scope.resolve(object), Some(Binding::Value(_)))
    }

    /// `stageNestedCalls`: the slot with its nested calls run, as the text
    /// that reads the names they were bound to, and the scope those names
    /// are in; `None` when the slot holds none.
    pub(crate) async fn staged(&self, slot: &ExprSlot, scope: &Rc<Scope>) -> Result<Option<(ExprSlot, Rc<Scope>)>, Stop> {
        self.staged_part(slot, slot, 0, scope).await
    }

    /// `staged` of `slot`, a part of `origin` starting `offset` units in.
    async fn staged_part(&self, origin: &ExprSlot, slot: &ExprSlot, offset: usize, scope: &Rc<Scope>) -> Result<Option<(ExprSlot, Rc<Scope>)>, Stop> {
        if self.version() < 3 {
            return Ok(None);
        }
        let Ok(tree) = movement_parser::expr::parse_expression(&slot.raw) else { return Ok(None) };
        let calls = staged_calls(&tree, &|call| self.runs_as_call(call, scope));
        if calls.is_empty() {
            return Ok(None);
        }
        let staging = Staging { origin, offset, slot, units: Utf16::new(&slot.raw), scratch: scope.child(), calls, scope, bound: Cell::new(0) };
        let text = self.stage_tree(&tree, &staging).await?;
        Ok(Some((carried(origin, text, slot.span), staging.scratch)))
    }

    /// `stageTree`: `tree` with its nested calls run, in order.
    fn stage_tree<'s>(&'s self, tree: &'s MExpr, staging: &'s Staging<'s>) -> Staged<'s> {
        Box::pin(async move {
            if !holds(tree, &staging.calls) {
                return Ok(staging.units.text(tree.at().start, tree.at().end));
            }
            if matches!(tree, MExpr::Call { .. }) && staging.calls.contains(&tree.at()) {
                return self.settle_nested_call(tree, staging).await;
            }
            let is_coalesce = |callee: &str| self.is_coalesce(callee, staging.scope);
            if let Some(short) = short_circuit_of(tree, &is_coalesce) {
                let binding = self.settle_short_circuit(short, staging).await?;
                return Ok(self.bind_settled(binding, staging));
            }
            let operands = value_children(tree);
            let Some(last) = operands.iter().rposition(|operand| holds(operand, &staging.calls)) else {
                return Ok(staging.units.text(tree.at().start, tree.at().end));
            };
            let mut replaced = Vec::new();
            for operand in &operands[..=last] {
                let binding = self.settled_binding(operand, staging).await?;
                replaced.push((operand.at(), self.bind_settled(binding, staging)));
            }
            Ok(rewritten(&staging.units, tree.at(), replaced))
        })
    }

    /// `settleNestedCall`: one nested call, run as the right-hand side of a
    /// binding, under the running statement's step.
    async fn settle_nested_call(&self, call: &MExpr, staging: &Staging<'_>) -> Result<String, Stop> {
        let extent = At { start: call.at().start + staging.offset, end: call.at().end + staging.offset };
        let value = nested_call(staging.origin, extent, self.version())
            .map_err(|message| Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("invalid nested call (the checker should have caught this): {message}"))))?;
        let at = self.call_sites.borrow().last().map(|site| site.address.clone()).unwrap_or_else(Address::default);
        let name = self.nested_name(staging);
        let path = self.nested_path(staging.origin, extent, &value, &staging.scope.written_in());
        self.assign(&name, &value, &staging.scratch, &at, &path).await?;
        Ok(spelled(&name))
    }

    /// The place of the call at `extent` in `slot`, a slot of code written
    /// in `file` (crate::program `node_at`), its own slots noted where they
    /// are.
    pub(crate) fn nested_path(&self, slot: &ExprSlot, extent: At, value: &RValue, file: &crate::program::DeclaringFile) -> String {
        let mut by_file = self.slot_paths.borrow_mut();
        let paths = self.slot_paths_of(&mut by_file, file);
        let Some(slot_path) = paths.get(&span_key(&slot.span)) else { return "#nested".to_string() };
        let path = format!("{slot_path}/nested/{}-{}", extent.start, extent.end);
        register_slots(&serde_json::to_value(value).expect("an AST is always JSON"), &format!("{path}/value"), true, paths);
        path
    }

    fn slot_paths_of<'m>(
        &self,
        by_file: &'m mut std::collections::BTreeMap<crate::program::DeclaringFile, SlotPaths>,
        file: &crate::program::DeclaringFile,
    ) -> &'m mut SlotPaths {
        by_file.entry(file.clone()).or_insert_with(|| {
            let mut paths = SlotPaths::new();
            self.checked.with_file(file, |written| register_slots(&written.tree, &crate::program::in_file(file, ""), false, &mut paths));
            paths
        })
    }

    /// `evaluateSlot`'s first step (language version 5): a closure written
    /// as a list element is a value, (AST, scope), holding the scope it is
    /// written in by REFERENCE, as a closure bound to a name does — bound
    /// in a scope around the slot under the name the lowering reads it by
    /// (`slot_closure_name`). `None` where the slot holds none, or `scope`
    /// is already that scope.
    pub(crate) fn around_slot(&self, slot: &ExprSlot, scope: &Rc<Scope>) -> Option<Rc<Scope>> {
        let mut written = slot.closures.iter().enumerate().filter(|(_, c)| c.at != NOT_CARRIED).peekable();
        let (_, first) = written.peek()?;
        if scope.resolve_own(&movement_parser::ast::slot_closure_name(first.at)).is_some() {
            return None;
        }
        let file = scope.written_in();
        let slot_path = {
            let mut by_file = self.slot_paths.borrow_mut();
            self.slot_paths_of(&mut by_file, &file).get(&span_key(&slot.span)).cloned().unwrap_or_else(|| "#slot".to_string())
        };
        let around = scope.child();
        for (index, written) in written {
            let code = crate::flow::Code { ast: Rc::new(written.closure.clone()), path: format!("{slot_path}/closures/{index}/closure") };
            let closure = crate::bindings::Closure { code, captured: scope.clone(), self_name: None, file_name: None, by_reference: true };
            around.declare(movement_parser::ast::slot_closure_name(written.at), Binding::Closure(Rc::new(closure)));
        }
        Some(around)
    }

    /// `settleShortCircuit`: `AND` / `OR` / `IF` / `COALESCE`, reaching only
    /// the operands it needs.
    async fn settle_short_circuit(&self, short: ShortCircuit<'_>, staging: &Staging<'_>) -> Result<Binding, Stop> {
        let constant = |value: crate::js::Js| crate::record::bind_value(value, Some(crate::env::Trail::default()), false);
        match short {
            ShortCircuit::And(left, right) | ShortCircuit::Or(left, right) => {
                let and = matches!(short, ShortCircuit::And(..));
                let left = truthy(&self.settled_binding(left, staging).await?);
                if if and { !left } else { left } {
                    return Ok(constant(crate::js::Js::Bool(left)));
                }
                Ok(constant(crate::js::Js::Bool(truthy(&self.settled_binding(right, staging).await?))))
            }
            ShortCircuit::If(condition, then, else_) => {
                if truthy(&self.settled_binding(condition, staging).await?) {
                    return self.settled_binding(then, staging).await;
                }
                // An IF with no ELSE is the empty text there.
                match else_ {
                    Some(else_) => self.settled_binding(else_, staging).await,
                    None => Ok(constant(crate::js::Js::str(""))),
                }
            }
            ShortCircuit::Coalesce(args) => {
                for arg in args {
                    let binding = self.settled_binding(arg, staging).await?;
                    if present(&binding) {
                        return Ok(binding);
                    }
                }
                Ok(constant(crate::js::Js::Null))
            }
        }
    }

    /// `settledBinding`: a sub-expression's binding, its nested calls run
    /// first.
    fn settled_binding<'s>(&'s self, expr: &'s MExpr, staging: &'s Staging<'s>) -> Settled<'s> {
        Box::pin(async move {
            let text = self.stage_tree(expr, staging).await?;
            let slot = carried(staging.origin, text, staging.slot.span);
            self.bind_slot_binding(&slot, &staging.scratch).await
        })
    }

    /// `bindSettled`: `binding` under a fresh name.
    fn bind_settled(&self, binding: Binding, staging: &Staging<'_>) -> String {
        let name = self.nested_name(staging);
        staging.scratch.declare(name.clone(), binding);
        spelled(&name)
    }

    /// `nestedBindingName`.
    fn nested_name(&self, staging: &Staging<'_>) -> String {
        staging.bound.set(staging.bound.get() + 1);
        format!("#nested {}", staging.bound.get())
    }

    /// Whether `callee` resolves to the built-in `COALESCE`.
    fn is_coalesce(&self, callee: &str, scope: &Scope) -> bool {
        scope.resolve(callee).is_none() && scope.resolve_function(callee).is_none() && crate::js::to_upper_case(callee) == "COALESCE"
    }

    /// `evaluateStagedCondition`: a condition holding nested calls, its
    /// top-level `AND` conjuncts in order, each with its own nested calls
    /// run only once the ones before it held.
    pub(crate) async fn staged_condition(&self, slot: &ExprSlot, scope: &Rc<Scope>) -> Result<Option<bool>, Stop> {
        if self.version() < 3 {
            return Ok(None);
        }
        let Ok(tree) = movement_parser::expr::parse_expression(&slot.raw) else { return Ok(None) };
        if staged_calls(&tree, &|call| self.runs_as_call(call, scope)).is_empty() {
            return Ok(None);
        }
        let units = Utf16::new(&slot.raw);
        for conjunct in conjuncts_of(&tree) {
            let part = carried(slot, units.text(conjunct.at().start, conjunct.at().end), slot.span);
            let held = match self.staged_part(slot, &part, conjunct.at().start, scope).await? {
                Some((staged, scratch)) => Box::pin(self.condition(&staged, &scratch)).await?,
                None => Box::pin(self.condition(&part, scope)).await?,
            };
            if !held {
                return Ok(Some(false));
            }
        }
        Ok(Some(true))
    }
}

/// `bindingTruthy`.
fn truthy(binding: &Binding) -> bool {
    match binding {
        Binding::Value(value) => value.value.truthy(),
        _ => true,
    }
}

/// `bindingPresent`: presence as `COALESCE` reads it.
fn present(binding: &Binding) -> bool {
    match binding {
        Binding::Value(value) => !value.value.is_nullish(),
        _ => true,
    }
}
