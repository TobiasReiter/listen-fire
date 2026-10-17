//! What one segment may consume, so a host can run movements it did not
//! write (docs/contracts/run-limits.md). The host sets them in the segment's
//! input (`limits`); each absent one is its safe default. Exceeding one ends
//! the segment with a coded `MovementEngineError` that nothing in the
//! movement can forgive or catch.
//!
//! The engine reads no clock, so a segment's wall-clock limit is the run
//! host's to keep; the step budget is what bounds the work between two host
//! requests.

use std::cell::Cell;

use serde::Deserialize;

use crate::js::Js;

/// The host's limits for one segment.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Limits {
    /// Statements run plus expressions evaluated.
    pub max_steps: u64,
    /// One text's size, in UTF-8 bytes.
    pub max_text_bytes: usize,
    /// One list's members, or one map's keys.
    pub max_collection_items: usize,
    /// The segment's `done`, as JSON text.
    pub max_result_bytes: usize,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { max_steps: 10_000_000, max_text_bytes: 16 * 1024 * 1024, max_collection_items: 1_000_000, max_result_bytes: 64 * 1024 * 1024 }
    }
}

/// A limit met: which one, and what it was.
#[derive(Debug, Clone, PartialEq)]
pub struct LimitExceeded {
    pub code: &'static str,
    pub message: String,
}

impl LimitExceeded {
    fn new(code: &'static str, message: String) -> LimitExceeded {
        LimitExceeded { code, message: format!("{message}. The segment was stopped so one movement cannot exhaust its host; the host sets this limit.") }
    }

    pub fn steps(limit: u64) -> LimitExceeded {
        LimitExceeded::new("MOVENG_LIMIT_STEPS", format!("this segment ran more than {limit} statements and expressions"))
    }

    pub fn result(bytes: usize, limit: usize) -> LimitExceeded {
        LimitExceeded::new("MOVENG_LIMIT_RESULT_SIZE", format!("this segment's result is {bytes} bytes, over the limit of {limit}"))
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "class": "MovementEngineError", "code": self.code, "message": self.message })
    }
}

/// One segment's consumption, against its limits.
#[derive(Default)]
pub struct Meter {
    steps: Cell<u64>,
}

impl Meter {
    /// One more statement or expression.
    pub fn step(&self, limits: &Limits) -> Result<(), LimitExceeded> {
        let steps = self.steps.get() + 1;
        self.steps.set(steps);
        if steps > limits.max_steps { Err(LimitExceeded::steps(limits.max_steps)) } else { Ok(()) }
    }
}

/// A value held to the size limits: its own size, not its members' (each
/// member was a value once, and was held to them then).
pub fn admit(value: &Js, limits: &Limits) -> Result<(), LimitExceeded> {
    match value {
        Js::String(text) if text.as_str().len() > limits.max_text_bytes => Err(LimitExceeded::new(
            "MOVENG_LIMIT_TEXT_SIZE",
            format!("a text of {} bytes is over the limit of {}", text.as_str().len(), limits.max_text_bytes),
        )),
        Js::Array(list) if list.items().len() > limits.max_collection_items => Err(LimitExceeded::new(
            "MOVENG_LIMIT_COLLECTION_SIZE",
            format!("a list of {} members is over the limit of {}", list.items().len(), limits.max_collection_items),
        )),
        Js::Object(map) if map.entries().len() > limits.max_collection_items => Err(LimitExceeded::new(
            "MOVENG_LIMIT_COLLECTION_SIZE",
            format!("a map of {} keys is over the limit of {}", map.entries().len(), limits.max_collection_items),
        )),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_step_budget_refuses_the_step_past_it() {
        let limits = Limits { max_steps: 2, ..Limits::default() };
        let meter = Meter::default();
        assert!(meter.step(&limits).is_ok());
        assert!(meter.step(&limits).is_ok());
        assert_eq!(meter.step(&limits).unwrap_err().code, "MOVENG_LIMIT_STEPS");
    }

    #[test]
    fn a_value_past_a_size_limit_is_refused() {
        let limits = Limits { max_text_bytes: 3, max_collection_items: 2, ..Limits::default() };
        assert!(admit(&Js::str("abc"), &limits).is_ok());
        assert_eq!(admit(&Js::str("abcd"), &limits).unwrap_err().code, "MOVENG_LIMIT_TEXT_SIZE");
        assert!(admit(&Js::array(vec![Js::Null, Js::Null]), &limits).is_ok());
        assert_eq!(admit(&Js::array(vec![Js::Null; 3]), &limits).unwrap_err().code, "MOVENG_LIMIT_COLLECTION_SIZE");
    }

    #[test]
    fn absent_limits_are_the_defaults() {
        let limits: Limits = serde_json::from_str(r#"{"maxSteps": 5}"#).unwrap();
        assert_eq!(limits.max_steps, 5);
        assert_eq!(limits.max_text_bytes, Limits::default().max_text_bytes);
    }
}
