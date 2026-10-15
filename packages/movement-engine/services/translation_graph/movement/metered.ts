// Serving a priced host call: under its request's budget, answering what it
// spent, and answering a refusal past the budget rather than throwing it
// across the host boundary. Every shell's host wraps its model calls this way.

import type { Costed, PricedAnswer } from '../../movement_engine/host';

import { isBudgetExhausted, type Budget, type CostLine } from '../../../lib/run_cost';
import { withSpendMeter } from '../../../lib/run_spend';

/** Serve one priced call under its request's budget; the answer comes back
 *  with every line spent — the meter's, and any the call reported of its own
 *  (a plugin's cost envelope). */
export async function metered<Request extends { budget: Budget }, Output extends object>(
  request: Request,
  call: (request: Request) => Promise<Costed<Output>>,
): Promise<PricedAnswer<Output>> {
  return refusingPastBudget(async () => {
    const { value, cost } = await withSpendMeter(request.budget, () => call(request));
    const lines: CostLine[] = [...cost, ...(value.cost ?? [])];
    return { ...value, cost: lines };
  });
}

/** A priced call refused past its budget answers the refusal, with what it
 *  spent first, rather than throwing it across the boundary. */
export async function refusingPastBudget<Output extends object>(
  call: () => Promise<Costed<Output>>,
): Promise<PricedAnswer<Output>> {
  try {
    return await call();
  } catch (error) {
    if (!isBudgetExhausted(error)) throw error;
    return { error: { kind: 'budget', message: error.message }, cost: error.cost };
  }
}
