// What priced work costs, in the vocabulary both sides of the engine/host seam
// share: where the money went, what a priced host call is allowed to spend
// (`Budget`), what it reports it spent (`CostLine`), and the two ways running
// out is said — the host's (`BudgetExhausted`, at the priced call that found
// the budget spent) and the run's (`RunCostCapExceeded`, which the engine
// raises from its own ledger and suspends on).
//
// Pure: no storage, no environment. The engine keeps the run's ledger
// (movement_engine/run_context.ts) and the host meters each priced call it
// serves (`lib/run_spend.ts`); both speak these shapes.
//
// The cap itself is OPTIONAL: unset means no cap. When set it is a positive
// number of US dollars, read once by the run host and handed to the run as
// data (`RunMovementInput.costCapMicrodollars`).

import { z } from 'zod';

import type { Budget, CostLine } from 'engine-contracts';

export type { Budget, CostLine };

export const RUN_COST_CAP_ENV_VAR = 'MOVEMENT_MAX_RUN_COST_USD';

/**
 * Dollars as an author reads them about the cap: cents always, and up to four
 * decimals where the amount has them — a $0.016 cap must not read as $0.02, nor
 * a spend just past it as the same figure as the cap.
 */
export function formatUsd(microdollars: number): string {
  const fixed = (microdollars / 1_000_000).toFixed(4);
  return `$${fixed.replace(/0{1,2}$/, '')}`;
}

// ── Where the money went ────────────────────────────────────────────────────

/**
 * What a charge was for, so an author can see what cost what.
 *
 * - `model`    — a model call; `name` is the model the provider served.
 * - `service`  — a pay-as-you-go third-party API called from inside our own
 *                code (a plugin or an adapter); `name` is `<vendor>.<product>`,
 *                e.g. `brightdata.web_unlocker`.
 * - `plugin`   — a plugin that priced its own invocation (a `CostEnvelope` on
 *                its result); `name` is the plugin.
 * - `function` — an external function (defined by a manifest, run remotely)
 *                that priced its own invocation; `name` is the function.
 * - `adapter`  — an adapter call into a system that bills per call.
 */
export type CostSourceKind = 'model' | 'service' | 'plugin' | 'function' | 'adapter';

export interface CostSource {
  kind: CostSourceKind;
  name: string;
}

export interface RunCostReport {
  source: CostSource;
  /** What it cost, in microdollars (a millionth of a US dollar). */
  microdollars: number;
}

/** The key a source's spend is summed under in a run's breakdown — and the
 *  `source` of the `CostLine` a priced host call reports it under. */
export function costSourceKey(source: CostSource): string {
  return `${source.kind}:${source.name}`;
}

// ── Across the seam ─────────────────────────────────────────────────────────
//
// `Budget` and `CostLine` are the contract's (`engine-contracts`).

export const NO_BUDGET_LIMIT: Budget = { remainingMicrodollars: null };

/**
 * Thrown by the host at the priced step that found its call's budget already
 * spent, carrying what the call spent before it got there (`cost`) so the
 * engine still charges it. The engine turns it into `RunCostCapExceeded` with
 * the run's own figures; outside a run it never arises (no budget, no meter).
 */
export class BudgetExhausted extends Error {
  constructor(readonly cost: CostLine[]) {
    super("this run's cost budget is spent: the priced call was refused before it started");
    this.name = 'BudgetExhausted';
  }
}

export function isBudgetExhausted(err: unknown): err is BudgetExhausted {
  return err instanceof BudgetExhausted;
}

/** Raised by the engine at the priced call AFTER the one that took the run to
 *  its cap. A movement run suspends on it (movement_engine/run.ts,
 *  `suspendAtLimit`); where the run cannot suspend, its message is the whole
 *  failure surface an author sees, so it says the cap, the spend, and the
 *  knob. */
export class RunCostCapExceeded extends Error {
  constructor(
    readonly capMicrodollars: number,
    /** What the run has spent against the cap: every segment since it was
     *  last resumed from a limit pause (its whole spend if it never was). */
    readonly spentMicrodollars: number,
  ) {
    super(
      `Run cost cap reached: this run has spent ${formatUsd(spentMicrodollars)} on model calls and paid services, ` +
        `and the limit set by ${RUN_COST_CAP_ENV_VAR} is ${formatUsd(capMicrodollars)}. ` +
        'The run was stopped before its next priced call in case something was looping. ' +
        `If this run legitimately needs more, raise ${RUN_COST_CAP_ENV_VAR} in the server's environment ` +
        '(or unset it to remove the cap).',
    );
    this.name = 'RunCostCapExceeded';
  }
}

export function isRunCostCapExceeded(err: unknown): err is RunCostCapExceeded {
  return err instanceof RunCostCapExceeded;
}

/** What a run has spent, as its record carries it. */
export interface RunSpend {
  /** This segment only — since the run last resumed (or started). */
  segmentMicrodollars: number;
  /** The whole run: every earlier segment plus this one. What the cap reads. */
  runMicrodollars: number;
  /** This segment's spend by `costSourceKey`. Segments add up, so the run's
   *  breakdown is the sum of its segments'. */
  bySource: Record<string, number>;
}

// ── The cost envelope ───────────────────────────────────────────────────────

/**
 * THE shape anything outside the engine uses to say what an invocation cost —
 * a bundled plugin's `TransformOutput.cost` today, and the result an external
 * function returns over its protocol tomorrow. One shape, so the host prices
 * both the same way. Either:
 *
 *   { "microdollars": 1500 }
 *       — the price, already worked out, in millionths of a US dollar.
 *
 *   { "quantity": 3, "unit": "request", "unitPriceMicrodollars": 1500 }
 *       — usage and the unit price; the host multiplies. `unit` is for the
 *         reader, never parsed.
 *
 * Both are non-negative and finite; anything else is refused at the boundary
 * (`costEnvelopeMicrodollars`) rather than charged as garbage. A function that
 * spends nothing leaves the envelope off. A function that WILL spend should
 * also declare itself priced (`TransformImpl.priced`, or the same flag on an
 * external function's manifest), so the engine checks the run's budget before
 * invoking it rather than finding out afterwards.
 */
export const CostEnvelopeSchema = z.union([
  // zod 4's number already refuses Infinity and NaN.
  z.strictObject({ microdollars: z.number().nonnegative() }),
  z.strictObject({
    quantity: z.number().nonnegative(),
    unit: z.string().min(1),
    unitPriceMicrodollars: z.number().nonnegative(),
  }),
]);

export type CostEnvelope = z.infer<typeof CostEnvelopeSchema>;

/** What an envelope says it cost, in whole microdollars. Throws on an envelope
 *  that is not one — a function that misreports its price is a broken function,
 *  and charging it nothing would be the silent version of that. */
export function costEnvelopeMicrodollars(envelope: unknown): number {
  const parsed = CostEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new Error(
      `a cost report must be { microdollars } or { quantity, unit, unitPriceMicrodollars }, ` +
        `non-negative and finite; got ${JSON.stringify(envelope)}`,
    );
  }
  const cost = parsed.data;
  return Math.round(
    'microdollars' in cost ? cost.microdollars : cost.quantity * cost.unitPriceMicrodollars,
  );
}
