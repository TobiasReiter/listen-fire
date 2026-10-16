//! The run's spend account as one segment of this engine keeps it
//! (run_context.ts `RunLedger`): every priced host call is handed the run's
//! remaining budget and reports what it spent as cost lines, which are
//! charged here. The segment's charges go back to the run host with the
//! segment's `done` (`cost`), which charges them to the run.
//!
//! The account belongs to the run: a segment is seeded with what the run
//! spent before it (`priorMicrodollars`), and the cap counts from
//! `capBaselineMicrodollars`. The engine refuses one priced call itself: a
//! priced plugin once the run has spent its cap (`plugin_refusal`), before
//! the host is asked. Any other the host refuses past the budget, and that
//! refusal, once charged, is the run's cap met (`exceeded`) when the run's
//! own figures say so, at which the run suspends (crate::park); otherwise it
//! fails the statement with the host's message, as run_context.ts `charged`
//! does.

use std::cell::RefCell;

use movement_parser::catalog::types::{JsMap, PluginSpec};

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

    /// What the run has spent against its cap (`sinceReset`).
    fn since_reset(&self) -> f64 {
        self.spend.prior_microdollars + self.segment_microdollars() - self.spend.cap_baseline_microdollars
    }

    /// What the next priced call may spend: `{remainingMicrodollars}`, null
    /// with no cap.
    pub fn budget(&self) -> Json {
        let remaining = self.spend.cap_microdollars.map(|cap| cap - self.since_reset());
        json!({ "remainingMicrodollars": remaining })
    }

    /// The cap met, in the run's own figures (`exceeded`): spent at or past
    /// it. `None` while it is not, or with no cap.
    pub fn exceeded(&self) -> Option<CapExceeded> {
        let cap = self.spend.cap_microdollars?;
        let spent = self.since_reset();
        (spent >= cap).then_some(CapExceeded { cap_microdollars: cap, spent_microdollars: spent })
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

    /// Whether invoking `plugin` is refused before it starts (run_context.ts
    /// `pricedCalls`): it is priced, and the run has spent its cap. The
    /// plugin is found as `pluginSpecNamed` finds it, dashes read as
    /// underscores; one the catalog does not know is not priced.
    pub fn plugin_refusal(&self, plugins: &JsMap<PluginSpec>, plugin: &str) -> Option<CapExceeded> {
        crate::plugin::spec_named(plugins, plugin).filter(|spec| spec.priced())?;
        self.exceeded()
    }
}

/// The run met its cost cap (lib/run_cost.ts `RunCostCapExceeded`): the cap,
/// and what the run had spent against it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CapExceeded {
    pub cap_microdollars: f64,
    pub spent_microdollars: f64,
}

impl CapExceeded {
    /// `{class: "RunCostCapExceeded", capMicrodollars, spentMicrodollars}`:
    /// the shim rebuilds the error from its figures, message and all.
    pub fn to_json(self) -> Json {
        json!({
            "class": "RunCostCapExceeded",
            "capMicrodollars": self.cap_microdollars,
            "spentMicrodollars": self.spent_microdollars,
        })
    }

    /// `RunCostCapExceeded`'s message: the whole failure an author sees
    /// where the run cannot suspend.
    pub fn message(self) -> String {
        format!(
            "Run cost cap reached: this run has spent {} on model calls and paid services, and the limit set by {RUN_COST_CAP_ENV_VAR} is {}. The run was stopped before its next priced call in case something was looping. If this run legitimately needs more, raise {RUN_COST_CAP_ENV_VAR} in the server's environment (or unset it to remove the cap).",
            format_usd(self.spent_microdollars),
            format_usd(self.cap_microdollars),
        )
    }

    /// What a run paused at its cap says on its trace (run.ts
    /// `runPausedMessage`).
    pub fn paused_message(self) -> String {
        format!(
            "Paused: cost limit reached. The run has spent {} against a limit of {} ({RUN_COST_CAP_ENV_VAR}). Every branch stopped before its next statement; resume the run to carry on from there, with its usage reset.",
            format_usd(self.spent_microdollars),
            format_usd(self.cap_microdollars),
        )
    }
}

/// The knob the cap is set by (lib/run_cost.ts).
const RUN_COST_CAP_ENV_VAR: &str = "MOVEMENT_MAX_RUN_COST_USD";

/// lib/run_cost.ts `formatUsd`: dollars to four places, then one or two
/// trailing zeros dropped (`$0.10`, `$1.00`, `$0.0312`).
fn format_usd(microdollars: f64) -> String {
    let fixed = crate::js::to_fixed(microdollars / 1_000_000.0, 4);
    let zeros = fixed.len() - fixed.trim_end_matches('0').len();
    format!("${}", &fixed[..fixed.len() - zeros.min(2)])
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
    fn the_cap_is_met_at_or_past_it_counting_from_the_baseline() {
        let ledger = Ledger::new(&Spend { prior_microdollars: 50.0, cap_baseline_microdollars: 20.0, cap_microdollars: Some(100.0) });
        assert_eq!(ledger.exceeded(), None);
        ledger.charge(Some(&json!([{ "source": "model:judge", "microdollars": 69 }]))).unwrap();
        assert_eq!(ledger.exceeded(), None);
        ledger.charge(Some(&json!([{ "source": "model:judge", "microdollars": 1 }]))).unwrap();
        assert_eq!(ledger.exceeded(), Some(CapExceeded { cap_microdollars: 100.0, spent_microdollars: 100.0 }));
        assert_eq!(Ledger::new(&Spend { prior_microdollars: 1e9, ..Spend::default() }).exceeded(), None);
    }

    #[test]
    fn dollars_format_as_format_usd_formats_them() {
        assert_eq!(format_usd(100_000.0), "$0.10");
        assert_eq!(format_usd(1_000_000.0), "$1.00");
        assert_eq!(format_usd(31_250.0), "$0.0313");
        assert_eq!(format_usd(1_234.0), "$0.0012");
        assert_eq!(format_usd(10_000.0), "$0.01");
        assert_eq!(format_usd(0.0), "$0.00");
    }

    #[test]
    fn a_priced_plugin_is_refused_once_the_cap_is_spent() {
        let plugins: JsMap<PluginSpec> = serde_json::from_value(json!({
            "fetch_url": { "args": ["url"], "priced": true },
            "free_lookup": { "args": [], "priced": false },
        }))
        .unwrap();
        let ledger = Ledger::new(&Spend { cap_microdollars: Some(100.0), ..Spend::default() });
        assert_eq!(ledger.plugin_refusal(&plugins, "fetch_url"), None);
        ledger.charge(Some(&json!([{ "source": "model:extract", "microdollars": 100 }]))).unwrap();
        let spent = Some(CapExceeded { cap_microdollars: 100.0, spent_microdollars: 100.0 });
        assert_eq!(ledger.plugin_refusal(&plugins, "fetch_url"), spent);
        assert_eq!(ledger.plugin_refusal(&plugins, "fetch-url"), spent);
        assert_eq!(ledger.plugin_refusal(&plugins, "free_lookup"), None);
        assert_eq!(ledger.plugin_refusal(&plugins, "unknown"), None);
    }

    #[test]
    fn a_malformed_cost_line_fails() {
        let ledger = Ledger::new(&Spend::default());
        assert!(ledger.charge(Some(&json!([{ "source": "x", "microdollars": -1 }]))).is_err());
        assert!(ledger.charge(Some(&json!([{ "microdollars": 1 }]))).is_err());
        assert!(ledger.charge(None).is_ok());
    }
}
