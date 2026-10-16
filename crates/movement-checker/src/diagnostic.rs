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

/// An old spelling under language version 5 (`Program.spelling`): refused,
/// its rewrite as the fix.
pub fn of_spelling(finding: &movement_parser::surface::SpellingFinding) -> Diagnostic {
    Diagnostic {
        fix: finding.fix.as_ref().map(|f| serde_json::to_value(f).expect("a fix is JSON")),
        ..Diagnostic::error(&finding.code, finding.message.clone(), finding.span)
    }
}

/// The diagnostic's message naming built-ins as the program's own version
/// spells them (`UPPER` under 4, `Text.upper` under 5): the one place the
/// spelling table reaches every message.
pub fn in_spelling_of(mut d: Diagnostic, version: u32) -> Diagnostic {
    d.message = movement_parser::surface::table::spell_message(&d.message, version);
    d
}
