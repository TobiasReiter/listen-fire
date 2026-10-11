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

/// The calls of `tree` that are staged, given the calls that run as calls
/// (`runs`): none unless one does; then those and the member-read ones.
pub(crate) fn staged_calls(tree: &MExpr, runs: &dyn Fn(&MExpr) -> bool) -> Vec<At> {
    let mut calls = Vec::new();
    reachable_calls(tree, runs, &mut calls);
    if calls.is_empty() {
        return calls;
    }
    member_read_calls(tree, &mut calls);
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

/// One slot's staging (`NestedCallStaging`).
struct Staging<'s> {
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
        let MExpr::Name { name, .. } = callee.as_ref() else { return false };
        let written = &name.text;
        if let Some(binding) = scope.resolve(written) {
            return matches!(binding, Binding::Movement(_) | Binding::Plugin(_) | Binding::Opaque | Binding::Closure(_));
        }
        if self.version() < 3 {
            return false;
        }
        scope.resolve_function(written).is_some() || (!written.contains('.') && is_call_form(written))
    }

    /// `stageNestedCalls`: the slot with its nested calls run, as the text
    /// that reads the names they were bound to, and the scope those names
    /// are in; `None` when the slot holds none.
    pub(crate) async fn staged(&self, slot: &ExprSlot, scope: &Rc<Scope>) -> Result<Option<(ExprSlot, Rc<Scope>)>, Stop> {
        if self.version() < 3 {
            return Ok(None);
        }
        let Ok(tree) = movement_parser::expr::parse_expression(&slot.raw) else { return Ok(None) };
        let calls = staged_calls(&tree, &|call| self.runs_as_call(call, scope));
        if calls.is_empty() {
            return Ok(None);
        }
        let staging = Staging { slot, units: Utf16::new(&slot.raw), scratch: scope.child(), calls, scope, bound: Cell::new(0) };
        let text = self.stage_tree(&tree, &staging).await?;
        Ok(Some((ExprSlot { raw: text, span: slot.span, eager: false }, staging.scratch)))
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
        let value = nested_call(staging.slot, call.at(), self.version())
            .map_err(|message| Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("invalid nested call (the checker should have caught this): {message}"))))?;
        let at = self.call_sites.borrow().last().map(|site| site.address.clone()).unwrap_or_else(Address::default);
        let name = self.nested_name(staging);
        self.assign(&name, &value, &staging.scratch, &at, "#nested").await?;
        Ok(spelled(&name))
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
            let slot = ExprSlot { raw: text, span: staging.slot.span, eager: false };
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
            let part = ExprSlot { raw: units.text(conjunct.at().start, conjunct.at().end), span: slot.span, eager: false };
            let held = match self.staged(&part, scope).await? {
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
