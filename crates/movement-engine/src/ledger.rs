//! The run's spend account as one segment of this engine keeps it
//! (run_context.ts `RunLedger`): every priced host call is handed the run's
//! remaining budget and reports what it spent as cost lines, which are
//! charged here. The segment's charges go back to the run host with the
//! segment's `done` (`cost`), which charges them to the run.
//!
//! The account belongs to the run: a segment is seeded with what the run
//! spent before it (`priorMicrodollars`), and the cap counts from
//! `capBaselineMicrodollars`. This engine cannot suspend a run at its cap,
//! so the shim's allow-list declines a capped run whose program can make a
//! priced call; a budget refusal reaching this engine fails the statement
//! with the host's message.

use std::cell::RefCell;

use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};

/// The run's figures as the segment starts.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spend {
    #[serde(default)]
    pub prior_microdollars: f64,
    #[serde(default)]
    pub cap_baseline_microdollars: f64,
    /// Absent: no cap.
    #[serde(default)]
    pub cap_microdollars: Option<f64>,
}

/// One charge: what a call spent, by source (`kind:name`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CostLine {
    pub source: String,
    pub microdollars: f64,
}

pub struct Ledger {
    spend: Spend,
    /// This segment's charges, merged by source in the order first charged.
    by_source: RefCell<Vec<CostLine>>,
}

impl Ledger {
    pub fn new(spend: &Spend) -> Ledger {
        Ledger { spend: spend.clone(), by_source: RefCell::default() }
    }

    fn segment_microdollars(&self) -> f64 {
        self.by_source.borrow().iter().map(|line| line.microdollars).sum()
    }

    /// What the next priced call may spend: `{remainingMicrodollars}`, null
    /// with no cap.
    pub fn budget(&self) -> Json {
        let remaining = self.spend.cap_microdollars.map(|cap| {
            cap - (self.spend.prior_microdollars + self.segment_microdollars() - self.spend.cap_baseline_microdollars)
        });
        json!({ "remainingMicrodollars": remaining })
    }

    /// Charge an answer's `cost`. A malformed line fails, with the
    /// TypeScript ledger's message: a host that misreports a price is broken.
    pub fn charge(&self, cost: Option<&Json>) -> Result<(), String> {
        let Some(cost) = cost else { return Ok(()) };
        let lines = cost.as_array().ok_or_else(|| malformed(cost))?;
        for line in lines {
            let source = line.get("source").and_then(Json::as_str);
            let microdollars = line.get("microdollars").and_then(Json::as_f64).filter(|m| m.is_finite() && *m >= 0.0);
            let (Some(source), Some(microdollars)) = (source, microdollars) else { return Err(malformed(line)) };
            // `Math.round`: half rounds up.
            let microdollars = (microdollars + 0.5).floor();
            let mut by_source = self.by_source.borrow_mut();
            match by_source.iter_mut().find(|l| l.source == source) {
                Some(existing) => existing.microdollars += microdollars,
                None => by_source.push(CostLine { source: source.to_string(), microdollars }),
            }
        }
        Ok(())
    }

    /// The segment's charges, for its `done`.
    pub fn cost_lines(&self) -> Vec<CostLine> {
        self.by_source.borrow().clone()
    }
}

fn malformed(line: &Json) -> String {
    format!("a cost report must be {{ source, microdollars }} with a non-negative, finite number of microdollars; got {line}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_budget_is_the_cap_less_what_the_run_spent_since_its_baseline() {
        let ledger = Ledger::new(&Spend { prior_microdollars: 50.0, cap_baseline_microdollars: 20.0, cap_microdollars: Some(100.0) });
        assert_eq!(ledger.budget(), json!({ "remainingMicrodollars": 70.0 }));
        ledger.charge(Some(&json!([{ "source": "model:judge", "microdollars": 9.5 }, { "source": "model:judge", "microdollars": 1 }]))).unwrap();
        assert_eq!(ledger.cost_lines(), vec![CostLine { source: "model:judge".into(), microdollars: 11.0 }]);
        assert_eq!(ledger.budget(), json!({ "remainingMicrodollars": 59.0 }));
        assert_eq!(Ledger::new(&Spend::default()).budget(), json!({ "remainingMicrodollars": null }));
    }

    #[test]
    fn a_malformed_cost_line_fails() {
        let ledger = Ledger::new(&Spend::default());
        assert!(ledger.charge(Some(&json!([{ "source": "x", "microdollars": -1 }]))).is_err());
        assert!(ledger.charge(Some(&json!([{ "microdollars": 1 }]))).is_err());
        assert!(ledger.charge(None).is_ok());
    }
}
