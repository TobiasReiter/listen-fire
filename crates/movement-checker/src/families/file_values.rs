//! A file-level value, from version 5 (`fileValueRefusal`,
//! `reportFileValue` and the file-value half of `hoistNestedCalls` in
//! checker/check.ts). The file's values are worked out before every run of
//! every function in it, with no event in scope, and again on every resume:
//! a call there would run again each time, spending again and answering
//! differently, and a write, a walk or a wait has nothing to run about. So a
//! file-level value is a value: a literal, a built-in's value, a closure, a
//! construction.
//!
//! - MOV_FILE_VALUE_RUNS

use movement_parser::ast::{RValue, Span};

use crate::checker::Checker;
use crate::codes;
use crate::families::calls::{CallPosition, CallReading, read_one_call};
use crate::scope::ScopeId;

impl Checker<'_> {
    /// `reportFileValueKind`: a right-hand side that is not a value.
    pub(crate) fn report_file_value_kind(&mut self, name: &str, value: &RValue, span: Span, scope: ScopeId) {
        if let Some(holding) = self.file_value_refusal(value, scope) {
            self.report_file_value(name, &holding, span);
        }
    }

    fn file_value_refusal(&self, value: &RValue, scope: ScopeId) -> Option<String> {
        let what = match value {
            RValue::Expr { .. } | RValue::Closure { .. } => return None,
            RValue::Construct { construct } => {
                return self.call_in_construct_position(construct, scope).map(|_| format!("a call to '{}'", construct.callee));
            }
            RValue::Call { call } => {
                return match read_one_call(call, &self.resolve_callee(&call.callee, scope), CallPosition::Value) {
                    CallReading::Value(_) | CallReading::Refused { .. } => None,
                    CallReading::Function | CallReading::Collection(_) | CallReading::Members(_) => Some(format!("a call to '{}'", call.callee)),
                };
            }
            RValue::Write { .. } => "a write",
            RValue::Match { .. } => "a match",
            RValue::Link { .. } => "a link",
            RValue::Extract { .. } | RValue::ExtractCall { .. } => "an extraction",
            RValue::Block { .. } | RValue::InlineBlock { .. } => "a block",
            RValue::Await { .. } | RValue::Combinator { .. } => "a wait",
            RValue::Collection { .. } | RValue::Members { .. } => "a collection operation",
            RValue::Callback { .. } => "a callback",
            RValue::Node { .. } => "a node",
            RValue::Lazy { .. } => "a walk",
        };
        Some(what.to_string())
    }

    /// `reportFileValue`.
    pub(crate) fn report_file_value(&mut self, name: &str, holding: &str, span: Span) {
        self.report(
            codes::FILE_VALUE_RUNS,
            format!("'{name}' is a file-level value, worked out before every run with no event in scope, so it holds a value only — not {holding}. Do it inside the function that uses it."),
            span,
        );
    }
}
