// The host's half of the run cost cap: what the cap reads, and the meter one
// priced host call runs under — what it charges, and when its next priced step
// is refused. (The run's own account is the engine's:
// movement_engine/__test__/run_context.unit.test.ts.)

jest.mock('../../services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const insertInto = jest.fn();
jest.mock('../kysely', () => ({ getQb: () => ({ insertInto }) }));

import { LlmUsageContext, recordLlmUsage } from '../llm_usage';
import {
  BudgetExhausted,
  costEnvelopeMicrodollars,
  formatUsd,
  isBudgetExhausted,
  NO_BUDGET_LIMIT,
  RUN_COST_CAP_ENV_VAR,
  type Budget,
  type CostSource,
} from '../run_cost';
import {
  assertRunBudget,
  assertRunCostCapConfigured,
  isInsideSpendMeter,
  parseRunCostCap,
  reportRunCost,
  runCostCapFromEnv,
  withSpendMeter,
} from '../run_spend';

const ENV_VAR = 'MOVEMENT_MAX_RUN_COST_USD';
const DOLLAR = 1_000_000;

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
  insertInto.mockReset();
  insertInto.mockReturnValue({ values: () => ({ execute: async () => undefined }) });
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = saved;
});

const SCRAPE: CostSource = { kind: 'service', name: 'brightdata.web_unlocker' };

/** A priced step's charge, as any reporter makes it. */
function charge(microdollars: number, source: CostSource = SCRAPE): void {
  reportRunCost({ source, microdollars });
}

const budget = (remainingMicrodollars: number | null): Budget => ({ remainingMicrodollars });

async function refusal(promise: Promise<unknown>): Promise<BudgetExhausted> {
  try {
    await promise;
  } catch (err) {
    if (isBudgetExhausted(err)) return err;
    throw err;
  }
  throw new Error('the call was not refused');
}

describe('the env var', () => {
  it('is named MOVEMENT_MAX_RUN_COST_USD', () => {
    expect(RUN_COST_CAP_ENV_VAR).toBe(ENV_VAR);
  });

  it('unset or blank means no cap', () => {
    expect(parseRunCostCap(undefined)).toBeUndefined();
    expect(parseRunCostCap('  ')).toBeUndefined();
    expect(() => assertRunCostCapConfigured({})).not.toThrow();
  });

  it('a positive number of dollars is the cap, in microdollars', () => {
    expect(parseRunCostCap('5')).toBe(5 * DOLLAR);
    expect(parseRunCostCap('0.25')).toBe(250_000);
  });

  it('the run host reads it once, as the cap it hands the run', () => {
    expect(runCostCapFromEnv({})).toBeUndefined();
    expect(runCostCapFromEnv({ [ENV_VAR]: '2.5' })).toBe(2.5 * DOLLAR);
  });

  it.each(['0', '-1', 'five', '5usd', 'Infinity', 'NaN'])('boot refuses %p, naming the variable', (raw) => {
    expect(() => assertRunCostCapConfigured({ [ENV_VAR]: raw })).toThrow(
      new RegExp(`^${ENV_VAR}="${raw}" is not a positive number of US dollars`),
    );
  });
});

describe("a priced call's meter", () => {
  it('with no limit, spends without refusal and answers every line it spent', async () => {
    const { value, cost } = await withSpendMeter(NO_BUDGET_LIMIT, async () => {
      for (let i = 0; i < 100; i++) {
        assertRunBudget();
        charge(DOLLAR);
      }
      return 'done';
    });
    expect(value).toBe('done');
    expect(cost).toEqual([{ source: 'service:brightdata.web_unlocker', microdollars: 100 * DOLLAR }]);
  });

  it('the step that crosses the budget goes through; the NEXT priced step is refused, carrying what was spent', async () => {
    const err = await refusal(
      withSpendMeter(budget(2.5 * DOLLAR), async () => {
        assertRunBudget();
        charge(2 * DOLLAR);
        assertRunBudget();
        charge(DOLLAR); // over now
        assertRunBudget();
      }),
    );
    expect(err.cost).toEqual([{ source: 'service:brightdata.web_unlocker', microdollars: 3 * DOLLAR }]);
  });

  it('a budget already spent refuses the first priced step', async () => {
    const err = await refusal(withSpendMeter(budget(0), async () => assertRunBudget()));
    expect(err.cost).toEqual([]);
    await refusal(withSpendMeter(budget(-DOLLAR), async () => assertRunBudget()));
  });

  it('a refusal caught and rethrown deep inside still carries every line the call spent', async () => {
    const err = await refusal(
      withSpendMeter(budget(DOLLAR), async () => {
        charge(DOLLAR);
        charge(500, { kind: 'model', name: 'claude-sonnet-5' });
        try {
          assertRunBudget();
        } catch (inner) {
          charge(200, { kind: 'model', name: 'claude-sonnet-5' });
          throw inner;
        }
      }),
    );
    expect(err.cost).toEqual([
      { source: 'service:brightdata.web_unlocker', microdollars: DOLLAR },
      { source: 'model:claude-sonnet-5', microdollars: 700 },
    ]);
  });

  it('two calls in flight meter apart', async () => {
    const call = (microdollars: number) =>
      withSpendMeter(NO_BUDGET_LIMIT, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        charge(microdollars);
      });
    const [a, b] = await Promise.all([call(1_000), call(2_000)]);
    expect(a.cost).toEqual([{ source: 'service:brightdata.web_unlocker', microdollars: 1_000 }]);
    expect(b.cost).toEqual([{ source: 'service:brightdata.web_unlocker', microdollars: 2_000 }]);
  });

  it('concurrent steps of one call charge the one meter, and none of it is lost', async () => {
    const err = await refusal(
      withSpendMeter(budget(2.5 * DOLLAR), async () => {
        await Promise.all(
          Array.from({ length: 20 }, async (_, i) => {
            await new Promise((resolve) => setTimeout(resolve, (i * 7) % 5));
            charge(100_000);
          }),
        );
        assertRunBudget();
        charge(500_000);
        assertRunBudget();
      }),
    );
    expect(err.cost).toEqual([{ source: 'service:brightdata.web_unlocker', microdollars: 2.5 * DOLLAR }]);
  });

  it('outside a metered call nothing is charged and nothing is refused', () => {
    expect(isInsideSpendMeter()).toBe(false);
    charge(100 * DOLLAR);
    expect(() => assertRunBudget()).not.toThrow();
  });
});

describe('one entry point for every price', () => {
  it('every charge is summed by where it went', async () => {
    const { cost } = await withSpendMeter(NO_BUDGET_LIMIT, async () => {
      charge(1_500);
      charge(1_500);
      charge(2 * DOLLAR, { kind: 'model', name: 'claude-sonnet-5' });
      charge(700, { kind: 'plugin', name: 'fetch_url' });
    });
    expect(cost).toEqual([
      { source: 'service:brightdata.web_unlocker', microdollars: 3_000 },
      { source: 'model:claude-sonnet-5', microdollars: 2 * DOLLAR },
      { source: 'plugin:fetch_url', microdollars: 700 },
    ]);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('a cost of %p is refused, naming its source', (bad) => {
    expect(() => charge(bad)).toThrow(/service:brightdata\.web_unlocker reported a cost of/);
  });
});

describe('the cost envelope', () => {
  it('a price already worked out is charged as given', () => {
    expect(costEnvelopeMicrodollars({ microdollars: 1_500 })).toBe(1_500);
  });

  it('usage and a unit price are multiplied, to whole microdollars', () => {
    expect(costEnvelopeMicrodollars({ quantity: 3, unit: 'page', unitPriceMicrodollars: 1_500.4 })).toBe(4_501);
  });

  it.each([
    { microdollars: -1 },
    { microdollars: '5' },
    { quantity: 2, unit: 'page' },
    { quantity: 2, unit: '', unitPriceMicrodollars: 5 },
    { microdollars: 5, extra: true },
    null,
  ])('refuses %p rather than charging garbage', (bad) => {
    expect(() => costEnvelopeMicrodollars(bad)).toThrow(/a cost report must be/);
  });
});

describe('what a model call charges', () => {
  it('recordLlmUsage charges the call what it priced it at — the same number as the usage row', async () => {
    const values = jest.fn().mockReturnValue({ execute: async () => undefined });
    insertInto.mockReturnValue({ values });
    const { cost } = await withSpendMeter(NO_BUDGET_LIMIT, async () => {
      await new LlmUsageContext({ teamId: 'team-1' }).runAsync(async () => {
        await recordLlmUsage({
          resolved: { preferred: 'claude-sonnet-5', provider: 'anthropic', wireModel: 'claude-sonnet-5' },
          callType: 'chat',
          inputTokens: 1_000_000,
          outputTokens: 100_000,
        });
      });
    });
    // $2/M in + $10/M out, under the model's own name.
    expect(cost).toEqual([{ source: 'model:claude-sonnet-5', microdollars: 3 * DOLLAR }]);
    expect(values.mock.calls[0]?.[0].cost_microdollars).toBe(3 * DOLLAR);
  });

  it('charges before its first await, so the next priced step already sees it', async () => {
    await refusal(
      withSpendMeter(budget(2 * DOLLAR), async () => {
        void recordLlmUsage({
          resolved: { preferred: 'claude-sonnet-5', provider: 'anthropic', wireModel: 'claude-sonnet-5' },
          callType: 'chat',
          inputTokens: 1_000_000,
          outputTokens: 0,
        });
        assertRunBudget();
      }),
    );
  });

  it('a call with no team context is still charged; nothing is written', async () => {
    const { cost } = await withSpendMeter(NO_BUDGET_LIMIT, async () => {
      await recordLlmUsage({
        resolved: { provider: 'jev', wireModel: 'jev-latest' },
        callType: 'structured',
        inputTokens: 10,
        outputTokens: 10,
      });
      await recordLlmUsage({
        resolved: { preferred: 'claude-sonnet-5', provider: 'anthropic', wireModel: 'claude-sonnet-5' },
        callType: 'chat',
        inputTokens: 500_000,
        outputTokens: 0,
      });
    });
    expect(cost.reduce((sum, line) => sum + line.microdollars, 0)).toBe(DOLLAR);
    expect(insertInto).not.toHaveBeenCalled();
  });
});

describe('formatUsd — the dollars an author reads about the cap', () => {
  it('keeps cents, and the further decimals a small amount has', () => {
    expect(formatUsd(3 * DOLLAR)).toBe('$3.00');
    expect(formatUsd(1.5 * DOLLAR)).toBe('$1.50');
    expect(formatUsd(16_000)).toBe('$0.016');
    expect(formatUsd(16_300)).toBe('$0.0163');
    expect(formatUsd(20_000)).toBe('$0.02');
  });
});
