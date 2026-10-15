//! A diagnostic as the TypeScript checker reports it (`Diagnostic` in
//! checker/check.ts): an absent severity means an error.

use movement_parser::ast::Span;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warning,
    Info,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    pub span: Span,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<Severity>,
    /// Emitted only because this check is for a move up (`upgradingFrom`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upgrade: Option<bool>,
    /// The exact rewrite that resolves it (`DiagnosticFix`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<Value>,
}

impl Diagnostic {
    pub fn error(code: &str, message: impl Into<String>, span: Span) -> Self {
        Diagnostic { code: code.to_string(), message: message.into(), span, severity: None, upgrade: None, fix: None }
    }

    pub fn is_error(&self) -> bool {
        self.severity.is_none()
    }
}
