//! The closures family: not yet ported. Its codes (PORT.md has where the
//! TypeScript raises each):
//!
//! - MOV_BLOCK_READ_BACK_RETIRED
//! - MOV_BLOCK_RETURNS_NOTHING
//! - MOV_CLOSURE_NOT_DATA
//! - MOV_COLLECTION_OP_ARITY
//! - MOV_COLLECTION_OP_CONFIG
//! - MOV_COLLECTION_OP_NOT_A_COLLECTION
//! - MOV_COLLECTION_OP_RETURNS_NOTHING
//! - MOV_COLLECTION_OP_SUSPENDS
//! - MOV_COMBINATOR_ARMS_ARE_ARGUMENTS
//! - MOV_COMBINATOR_ARM_NOT_FUNCTION
//! - MOV_COMBINATOR_ARM_TAKES_NOTHING
//! - MOV_COMBINATOR_NEEDS_AWAIT
//! - MOV_COMBINATOR_NO_AWAIT
//! - MOV_INLINE_BLOCK_RETIRED
//! - MOV_PARALLEL_RETIRED


use movement_parser::ast::{
    ArmExpression, ClosureExpression, CollectionOp, CollectionOpExpression, CombinatorArms, CombinatorExpression, CombinatorKind, Loc, RValue,
    Span, Statement,
};
use movement_parser::version::{before, since};
use serde_json::json;

use crate::checker::Checker;
use crate::codes;
use crate::diagnostic::Diagnostic;
use crate::scope::{Resolution, ScopeId, Symbol, SymbolKind};

/// Whether a body hands a value back: a `return` at its own level or in an
/// `if` arm (a block, a closure or a movement inside it returns for itself).
pub fn body_returns(statements: &[Statement]) -> bool {
    statements.iter().any(|statement| match statement {
        Statement::Return(_) => true,
        Statement::If(s) => s.arms.iter().any(|arm| body_returns(&arm.body)) || s.else_arm.as_ref().is_some_and(|e| body_returns(&e.body)),
        _ => false,
    })
}

fn kind_name(kind: CombinatorKind) -> &'static str {
    match kind {
        CombinatorKind::Race => "race",
        CombinatorKind::Parallel => "parallel",
        CombinatorKind::All => "all",
    }
}

fn op_spelling(op: CollectionOp) -> &'static str {
    match op {
        CollectionOp::Map => "MAP",
        CollectionOp::Filter => "FILTER",
        CollectionOp::Reduce => "REDUCE",
        CollectionOp::Groupby => "GROUPBY",
        CollectionOp::Keyby => "KEYBY",
    }
}

/// `shiftLoc`.
fn shift(loc: Loc, by: isize) -> Loc {
    Loc { line: loc.line, col: loc.col.saturating_add_signed(by) }
}

fn edit(start: Loc, end: Loc, text: &str) -> serde_json::Value {
    json!({ "span": Span { start, end }, "text": text })
}

fn arm_span(arm: &ArmExpression) -> Span {
    match arm {
        ArmExpression::Closure { span, .. } | ArmExpression::Ref { span, .. } => *span,
    }
}

impl Checker<'_> {
    /// `declareClosureSelf`: a closure bound to a name may call itself by
    /// that name (version 3); a parameter of the same name shadows it.
    pub fn declare_closure_self(&mut self, name: &str, closure: &ClosureExpression, body: ScopeId) {
        if !since(self.version, 3) || closure.params.iter().any(|p| p.name == name) {
            return;
        }
        let mut symbol = Symbol::new(name, SymbolKind::Binding, closure.span);
        symbol.is_closure = true;
        let id = self.scopes.add_symbol(symbol);
        self.scopes.declare(body, id);
    }
}

impl Checker<'_> {
    /// A closure bound to a name: whether its body hands a value back.
    pub fn note_closure_returns(&mut self, name: &str, value: &RValue, scope: ScopeId) {
        let RValue::Closure { closure } = value else { return };
        if let Some(id) = self.scopes.scope(scope).symbols.get(name).copied() {
            let returns = closure.return_type.is_some() || body_returns(&closure.body);
            self.function_returns.insert(id, returns);
        }
    }

    fn report_fixed(&mut self, code: &str, message: String, span: Span, edits: Vec<serde_json::Value>) {
        let mut diagnostic = Diagnostic::error(code, message, span);
        diagnostic.fix = Some(json!({ "edits": edits }));
        self.push(diagnostic);
    }

    /// `reportCombinatorForm`: before version 5 a combinator is awaited; from
    /// 5 `parallel` is retired, the arms are arguments and nothing awaits it.
    pub fn report_combinator_form(&mut self, expr: &CombinatorExpression, awaited: Option<Span>) {
        let kind = kind_name(expr.kind);
        if before(self.version, 5) {
            if awaited.is_none() {
                self.report(
                    codes::COMBINATOR_NEEDS_AWAIT,
                    format!("'{kind}([…])' does not park by itself — it composes a wait, and 'await' is what parks: write 'await {kind}([…])'"),
                    expr.span,
                );
            }
            return;
        }
        if expr.kind == CombinatorKind::Parallel {
            self.report_parallel_retired(expr, awaited.unwrap_or(expr.span));
            return;
        }
        if let CombinatorArms::Literal { span, .. } = &expr.arms {
            self.report_fixed(
                codes::COMBINATOR_ARMS_ARE_ARGUMENTS,
                format!("'{kind}' takes its functions as arguments, not in a list — a closure is not data, so there is no list of them to pass. Write '{kind}(f, g)'"),
                *span,
                vec![edit(span.start, shift(span.start, 1), ""), edit(shift(span.end, -1), span.end, "")],
            );
        }
        if let Some(awaited) = awaited {
            self.report_fixed(
                codes::COMBINATOR_NO_AWAIT,
                format!("'await' marks where the run itself parks — a sleep, an until, an answer read — and '{kind}(…)' does not park by itself: its arms may, and the run parks where they do. Write '{kind}(…)' without 'await'"),
                awaited,
                vec![edit(awaited.start, expr.span.start, "")],
            );
        }
        if let Some(settings) = &expr.settings
            && expr.kind == CombinatorKind::Race
        {
            self.report(
                codes::COLLECTION_OP_CONFIG,
                "'race' takes no settings — it settles on the first arm to finish, so every arm runs at once. 'all' takes { concurrency, onError }",
                settings.span,
            );
        }
    }

    /// `reportParallelRetired`.
    fn report_parallel_retired(&mut self, expr: &CombinatorExpression, written: Span) {
        let message = "'parallel' is retired — 'all' is the same join, its functions passed as arguments: every one runs, and the answer is what each returned, in their order";
        let no_await = "no 'await': 'all' does not park by itself, and an arm that waits parks the run";
        match &expr.arms {
            CombinatorArms::Dynamic { .. } => self.report(
                codes::PARALLEL_RETIRED,
                format!("{message}. Write 'all(f, g, …)', naming each function — a closure is not data, so there is no list of them to pass — and {no_await}"),
                written,
            ),
            CombinatorArms::Literal { span, .. } => self.report_fixed(
                codes::PARALLEL_RETIRED,
                format!("{message}. Write 'all(…)' — {no_await}"),
                written,
                vec![edit(written.start, shift(span.start, 1), "all("), edit(shift(span.end, -1), expr.span.end, ")")],
            ),
            CombinatorArms::Arguments { .. } => self.report_fixed(
                codes::PARALLEL_RETIRED,
                format!("{message}. Write 'all(…)' — {no_await}"),
                written,
                vec![edit(written.start, shift(expr.span.start, "parallel".len() as isize), "all")],
            ),
        }
    }

    pub fn check_combinator(&mut self, combinator: &CombinatorExpression, scope: ScopeId) {
        let kind = kind_name(combinator.kind);
        match &combinator.arms {
            CombinatorArms::Literal { arms, .. } | CombinatorArms::Arguments { arms, .. } => {
                for arm in arms {
                    self.check_arm(arm, kind, scope, 0);
                }
            }
            CombinatorArms::Dynamic { expr, .. } => self.check_expr_slot(expr, scope),
        }
        if let Some(settings) = &combinator.settings {
            self.check_expr_slot(settings, scope);
        }
    }

    /// `checkArm`: a closure written in place, or the name of a function. The
    /// caller supplies `expected` arguments. Whether it hands a value back,
    /// when that is known.
    fn check_arm(&mut self, arm: &ArmExpression, kind: &str, scope: ScopeId, expected: usize) -> Option<bool> {
        match arm {
            ArmExpression::Closure { closure, span } => {
                let returns = self.check_closure_as(closure, scope, None, &format!("an arm of '{kind}'"), 0);
                if closure.params.len() != expected {
                    self.report_arm_arity(kind, expected, closure.params.len(), closure.params.first().map(|p| p.name.as_str()), *span);
                }
                Some(!returns.is_empty() || closure.return_type.is_some())
            }
            ArmExpression::Ref { name, span } => self.check_named_arm(name, *span, kind, scope, expected),
        }
    }

    fn check_named_arm(&mut self, written: &str, span: Span, kind: &str, scope: ScopeId, expected: usize) -> Option<bool> {
        let callee = self.callee_name(written, scope);
        let id = match self.scopes.resolve(scope, &callee) {
            Resolution::Found(id) => id,
            failure => {
                self.report_resolution_failure(&callee, span, failure);
                return None;
            }
        };
        let symbol = self.scopes.symbol(id).clone();
        if symbol.kind == SymbolKind::Movement {
            if let Some(params) = self.movement_params.get(&id).cloned()
                && params.len() != expected
            {
                self.report_arm_arity(kind, expected, params.len(), params.first().map(String::as_str), span);
            }
            return self.function_returns.get(&id).copied();
        }
        if let Some(crate::types::position::Position::Closure(closure)) = &symbol.types.pos {
            if closure.params.len() != expected {
                self.report_arm_arity(kind, expected, closure.params.len(), closure.params.first().map(|p| p.name.as_str()), span);
            }
            return self.function_returns.get(&id).copied();
        }
        if symbol.kind == SymbolKind::FileImport || symbol.is_closure {
            return None;
        }
        self.report(
            codes::COMBINATOR_ARM_NOT_FUNCTION,
            format!("'{written}' is {}, and '{kind}' RUNS its arms — an arm has to be a function. Name a movement, or write the work as a closure: `() => {{ … }}`.", symbol.kind.describe()),
            span,
        );
        None
    }

    /// `reportArmArity`.
    fn report_arm_arity(&mut self, kind: &str, expected: usize, got: usize, param: Option<&str>, span: Span) {
        if expected == 0 {
            let which = param.map_or_else(|| "a parameter".to_string(), |p| format!("'{p}'"));
            self.report(
                codes::COMBINATOR_ARM_TAKES_NOTHING,
                format!("'{kind}' calls its arms with nothing, so {which} could only ever arrive null. Take no parameters — a closure already sees everything in scope where it is written."),
                span,
            );
            return;
        }
        let message = if expected == 1 {
            format!("'{kind}' calls its function with one member at a time, and this one takes {got}: write '(member) => {{ … }}'")
        } else {
            format!("'{kind}' calls its function with two things — the value carried so far and the next member — and this one takes {got}: write '(carried, member) => {{ … }}'")
        };
        self.report(codes::COLLECTION_OP_ARITY, message, span);
    }

    /// `checkCollectionOp`, the parts that need no types: the slots, and the
    /// function the op is given.
    pub fn check_collection_op(&mut self, op: &CollectionOpExpression, scope: ScopeId) {
        let spelling = op_spelling(op.op);
        self.check_expr_slot(&op.source, scope);
        if let Some(init) = &op.init {
            self.check_expr_slot(init, scope);
        }
        if let Some(config) = &op.config {
            self.check_expr_slot(config, scope);
        }
        let arity = if op.op == CollectionOp::Reduce { 2 } else { 1 };
        let returns = match &op.r#fn {
            ArmExpression::Closure { closure, span } => {
                if closure.params.len() != arity {
                    self.report_arm_arity(spelling, arity, closure.params.len(), closure.params.first().map(|p| p.name.as_str()), *span);
                }
                let returned = self.check_closure_as(closure, scope, None, &format!("the function for '{spelling}'"), arity);
                Some(!returned.is_empty() || closure.return_type.is_some())
            }
            ArmExpression::Ref { name, span } => self.check_named_arm(name, *span, spelling, scope, arity),
        };
        if op.op != CollectionOp::Map && returns == Some(false) {
            self.report(
                codes::COLLECTION_OP_RETURNS_NOTHING,
                format!("the function for '{spelling}' hands nothing back, so there is nothing for '{spelling}' to do with each member — 'return' the answer for one."),
                arm_span(&op.r#fn),
            );
        }
    }
}
