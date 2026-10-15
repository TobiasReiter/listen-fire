// What ONE priced host call spends, metered where the money is spent.
//
// The failure the run's cost cap catches is a run that is working, not stuck:
// a loop, or a recursion that keeps finding more to do, each step of it an
// honest model call or paid scrape. The ENGINE keeps the run's account
// (movement_engine/run_context.ts): it hands every priced host call a `Budget`
// (what the run may still spend) and charges the `CostLine`s the call reports
// back. This file is the host's half: the meter one call runs under.
//
// ── One entry point for every price ─────────────────────────────────────────
//
// Anything that costs money reports it through `reportRunCost`, with where the
// money went (`CostSource`), and asks `assertRunBudget` before it starts. Model
// calls do it from `recordLlmUsage`, which prices every call from the same
// table its `llm_usage` row is priced from, so "what this run spent on models"
// and the run's usage rows never disagree about a price. A pay-as-you-go
// service reports from its own client (Bright Data's Web Unlocker, in
// `services/scraper.ts`). A plugin returns a `CostEnvelope` on its result and
// the host's plugin invoker turns it into a cost line.
//
// The meter is ambient — on purpose, and on the HOST side only. The model and
// service clients sit far below the host call that reached them (a plugin's
// third scrape, a judge's fallback model), shared by every caller in the
// process, so the call's budget arrives the way its billing context does
// (`lib/llm_usage.ts`): set by the host around the call it serves
// (`withSpendMeter`). The engine never reads or opens it.
//
// Outside a metered call (the knowledge pipeline, scripts, tests) there is no
// meter: nothing is refused and nothing is charged.
//
// The cap is read from the environment ONCE per run, by the run host
// (`runCostCapFromEnv`), and travels as data; boot refuses a cap set to
// nonsense (`assertRunCostCapConfigured`).

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  BudgetExhausted,
  costSourceKey,
  isBudgetExhausted,
  RUN_COST_CAP_ENV_VAR,
  type Budget,
  type CostLine,
  type RunCostReport,
} from 'movement-engine/lib/run_cost';

/** The cap in microdollars, or undefined for no cap. Throws on a value that is
 *  set but is not a positive number — a typo here must not read as "no cap". */
export function parseRunCostCap(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const dollars = Number(raw.trim());
  if (!Number.isFinite(dollars) || dollars <= 0) {
    throw new Error(
      `${RUN_COST_CAP_ENV_VAR}="${raw}" is not a positive number of US dollars. ` +
        `Set it to the most one movement run may spend on model calls and paid services (e.g. ${RUN_COST_CAP_ENV_VAR}=5), ` +
        'or leave it unset for no cap.',
    );
  }
  return Math.round(dollars * 1_000_000);
}

/** Boot: refuse a cap that is set to nonsense, rather than letting the first
 *  run find out. */
export function assertRunCostCapConfigured(env: NodeJS.ProcessEnv = process.env): void {
  parseRunCostCap(env[RUN_COST_CAP_ENV_VAR]);
}

/** The cap a run starts with — read when the run host starts (or resumes) it,
 *  so ops can move the cap without a restart, and handed to the engine as
 *  `costCapMicrodollars`. */
export function runCostCapFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return parseRunCostCap(env[RUN_COST_CAP_ENV_VAR]);
}

// ── The meter ───────────────────────────────────────────────────────────────

/** What one priced host call — or one segment's adapter calls — has spent,
 *  refusing priced work past its budget. */
export class SpendMeter {
  // Concurrent steps inside one call charge this one object. JavaScript runs
  // each charge to completion, so no two can interleave.
  private spent = 0;
  private readonly bySource = new Map<string, number>();

  constructor(private readonly budget: Budget) {}

  charge(report: RunCostReport): void {
    const key = costSourceKey(report.source);
    this.spent += report.microdollars;
    this.bySource.set(key, (this.bySource.get(key) ?? 0) + report.microdollars);
  }

  check(): void {
    const remaining = this.budget.remainingMicrodollars;
    if (remaining !== null && this.spent >= remaining) throw new BudgetExhausted(this.cost());
  }

  cost(): CostLine[] {
    return [...this.bySource].map(([source, microdollars]) => ({ source, microdollars }));
  }
}

const asyncLocalStorage = new AsyncLocalStorage<SpendMeter>();

/** Run `fn` charging `meter` — synchronous or not, exactly as `fn` is. For a
 *  host scope that outlives one call (a segment's adapter calls); a single
 *  priced call uses `withSpendMeter`. */
export function underSpendMeter<T>(meter: SpendMeter, fn: () => T): T {
  return asyncLocalStorage.run(meter, fn);
}

/**
 * Serve one priced host call under its budget: every priced step inside it is
 * refused once the call has spent what the budget allows, and what it spent
 * comes back as cost lines. A call refused partway throws `BudgetExhausted`
 * carrying everything it spent up to then — however deep the refusal was
 * caught and rethrown, the lines are the meter's.
 */
export async function withSpendMeter<T>(
  budget: Budget,
  fn: () => Promise<T>,
): Promise<{ value: T; cost: CostLine[] }> {
  const meter = new SpendMeter(budget);
  try {
    const value = await asyncLocalStorage.run(meter, fn);
    return { value, cost: meter.cost() };
  } catch (err) {
    if (isBudgetExhausted(err)) throw new BudgetExhausted(meter.cost());
    throw err;
  }
}

/** Charge priced work to the call being served. No-op outside one. */
export function reportRunCost(report: RunCostReport): void {
  if (!Number.isFinite(report.microdollars) || report.microdollars < 0) {
    throw new Error(
      `${costSourceKey(report.source)} reported a cost of ${report.microdollars} microdollars; a cost is a non-negative number`,
    );
  }
  asyncLocalStorage.getStore()?.charge({ ...report, microdollars: Math.round(report.microdollars) });
}

/** Refuse priced work once the call has spent its budget. Call it BEFORE
 *  starting the work. No-op outside a metered call, and when the run has no
 *  cap. */
export function assertRunBudget(): void {
  asyncLocalStorage.getStore()?.check();
}

/** Whether priced work done here is done on a run's behalf. */
export function isInsideSpendMeter(): boolean {
  return asyncLocalStorage.getStore() !== undefined;
}
