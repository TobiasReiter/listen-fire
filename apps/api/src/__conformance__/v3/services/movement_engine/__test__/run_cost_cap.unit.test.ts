// The optional per-run cost cap through the REAL interpreter: a run's spend is
// on its result, a run over its cap fails at its next priced call, and MAP's
// `onError` cannot forgive that.
//
// The members' work is a plugin standing in for a model call: it asks the
// run's account first and is charged through `recordLlmUsage`, exactly as the
// model clients are.

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../knowledge_pipeline/output_v3/schemas');

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??=
  'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.SCRAPER_API_KEY ??= 'unit-test-unused';

function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_target: object, prop: string | symbol): unknown {
      if (prop === 'execute') return async () => [];
      if (prop === 'executeTakeFirst') return async () => null;
      if (prop === 'then') return undefined;
      return () => mockChainable();
    },
  };
  return new Proxy({}, handler);
}
jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockChainable()),
  getAutomationsQb: jest.fn(() => mockChainable()),
  getQb: jest.fn(() => mockChainable()),
  getCoreQb: jest.fn(() => mockChainable()),
}));

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../context', () => ({
  unsafeCurrentContext: () => undefined,
  currentContext: () => ({
    user: undefined,
    runAsync: async <T>(fn: () => Promise<T>) => fn(),
  }),
}));

jest.mock('../../translation_graph/adapters/knowledge_graph', () => ({
  KG_ADAPTER_TYPE: 'kg',
  KG_MANIFEST: {
    adapterType: 'kg',
    displayName: 'Knowledge Graph',
    supportedTriggers: ['mutation'],
    methods: [
      'listEntryPoints', 'describe', 'resolveEntity', 'getDedupRules',
      'getFieldValue', 'getRelated', 'createRecord', 'updateRecord',
      'getPriorMatch', 'recordLink',
    ],
    triggerKinds: ['KG_MUTATION'],
  },
  createKnowledgeGraphAdapter: jest.fn(() => ({ adapterType: 'kg' })),
}));

jest.mock('../../knowledge_pipeline/facts', () => ({
  extractFactsForResource: jest.fn(async () => []),
}));
jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => '{}'),
  anthropicChatDetailed: jest.fn(async () => ({
    text: '{}',
    stopReason: 'end_turn',
    truncated: false,
  })),
  MAX_CHAT_CONTINUATIONS: 5,
}));

jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

import { runFailureCause, runMovement, MovementRunFailed } from '../run';
import type { MovementTransformInvoker } from '../extraction';
import type { MovementTraceEntry } from '../expression';
import { recordLlmUsage } from '../../../lib/llm_usage';
import { assertRunBudget, RunCostCapExceeded } from '../../../lib/run_spend';

import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { type Adapter, type RuntimeCapabilities } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData, type TransformOutputShape } from '../../translation_graph/types';
import { getTransform } from '../../translation_graph/engine/transforms/registry';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000052' as TeamId;
const ENV_VAR = 'MOVEMENT_MAX_RUN_COST_USD';
const DOLLAR = 1_000_000;

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = saved;
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeFakeAdapter(adapterType: string) {
  const creates: Array<{ recordType: string; fields: Record<string, unknown> }> = [];
  const adapter: Adapter = {
    adapterType,
    supportedTriggers: [] as never[],
    runtimeCapabilities: (): RuntimeCapabilities => ({
      traversal: { incoming: true, edgeProperties: true },
      resources: true,
    }),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      creates.push({ recordType: input.recordType, fields: input.fields });
      return { adapterType, externalId: `ext-${creates.length}`, data: { ...input.fields } };
    },
    async updateRecord() {
      throw new Error('test: no updates expected');
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

const catalog = staticCatalogFromManifests({
  credentials: { acme_main: { adapters: ['attio'] } },
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  'import { fetch_url } from plugins',
  '',
  'inbox = email()',
  'crm = attio(credentials: acme_main)',
  '',
].join('\n');

const DELAY_MS: Record<string, number> = { a: 20, b: 5, c: 15, d: 1, e: 10 };
const MEMBERS = '["a", "b", "c", "d", "e"]';

/** A `fetch_url` that costs one dollar a call: refused first if the run has
 *  spent its cap, then charged as a model call is (500K input tokens of
 *  claude-sonnet-5 at $2/M). */
function pricedInvoker() {
  const charged: string[] = [];
  const invoker: MovementTransformInvoker = {
    declaredOutput: (plugin) => realOutput(plugin),
    async invoke({ config }) {
      const url = String(config.url);
      assertRunBudget();
      await sleep(DELAY_MS[url] ?? 0);
      await recordLlmUsage({
        resolved: { preferred: 'claude-sonnet-5', provider: 'anthropic', wireModel: 'claude-sonnet-5' },
        callType: 'chat',
        inputTokens: 500_000,
        outputTokens: 0,
      });
      charged.push(url);
      return { text: `got-${url}` };
    },
  };
  return { invoker, charged };
}

function realOutput(plugin: string): TransformOutputShape | undefined {
  const impl = getTransform(plugin) ?? getTransform(plugin.replace(/_/g, '-'));
  return impl?.signature.output;
}

function webhookEvent(): TriggerEvent {
  return {
    pipelineInputId: 'pi-run-cost-cap',
    adapterType: 'email',
    triggerType: 'webhook',
    payload: { subject: 'Acme' },
  };
}

async function run(
  source: string,
  invoker: MovementTransformInvoker,
  options: { priorSpentMicrodollars?: number } = {},
) {
  const email = makeFakeAdapter('email');
  const attio = makeFakeAdapter('attio');
  const result = await runMovement({
    source: PRELUDE + source,
    movementName: 'intake',
    event: webhookEvent(),
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: (name) => (name === 'acme_main' ? 'cred-attio-1' : undefined),
    resolveAdapter: ({ adapterType }: { adapterType: string }) =>
      adapterType === 'email' ? email.adapter : attio.adapter,
    transformInvoker: invoker,
    ...options,
  });
  return { result, attio };
}

function mapMovement(settings: string): string {
  const config = settings === '' ? '' : `${settings}, `;
  return [
    'movement intake(m: <inbox-[:message]->>) {',
    `  pages = MAP(${MEMBERS}, ${config}(u) => {`,
    '    page = fetch_url(url: u)',
    '    return COALESCE(page, "none")',
    '  })',
    '  write crm-[:companies]-> { name: m.`subject`, summary: JOIN(pages, ",") }',
    '}',
  ].join('\n');
}

async function failureOf(promise: Promise<unknown>): Promise<MovementRunFailed> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof MovementRunFailed) return err;
    throw err;
  }
  throw new Error('the run did not fail');
}

const warnings = (trace: MovementTraceEntry[]) => trace.filter((e) => e.kind === 'warning');

describe('with no cap set', () => {
  it('a run spends what it spends, and its result says how much', async () => {
    const plugin = pricedInvoker();
    const { result, attio } = await run(mapMovement('{ concurrency: 5 }'), plugin.invoker);
    expect(attio.creates[0]?.fields.summary).toBe('got-a,got-b,got-c,got-d,got-e');
    // Five members running together, each charged a dollar to the one account.
    expect(result.spentMicrodollars).toBe(5 * DOLLAR);
  });

  it('a run that made no priced call carries no spend', async () => {
    const { result } = await run(
      [
        'movement intake(m: <inbox-[:message]->>) {',
        '  write crm-[:companies]-> { name: m.`subject` }',
        '}',
      ].join('\n'),
      pricedInvoker().invoker,
    );
    expect(result.spentMicrodollars).toBeUndefined();
  });
});

describe('with a cap set', () => {
  beforeEach(() => {
    process.env[ENV_VAR] = '2.5';
  });

  it('the run fails at the priced call after the one that crossed the cap, saying so', async () => {
    const plugin = pricedInvoker();
    const failure = await failureOf(run(mapMovement(''), plugin.invoker));
    // a, b, c each spent a dollar; c took the run to $3, so d was refused.
    expect(plugin.charged).toEqual(['a', 'b', 'c']);
    const cause = runFailureCause(failure);
    expect(cause).toBeInstanceOf(RunCostCapExceeded);
    expect(failure.message).toMatch(/^Run cost cap reached: this run has spent \$3\.00 on model calls and paid services/);
    expect(failure.message).toContain('MOVEMENT_MAX_RUN_COST_USD is $2.50');
    // What it spent is on what the failed run hands back.
    expect(failure.partial.spentMicrodollars).toBe(3 * DOLLAR);
  });

  it.each(['ignore', 'warn'])('MAP onError: "%s" cannot forgive it', async (onError) => {
    const plugin = pricedInvoker();
    const failure = await failureOf(run(mapMovement(`{ onError: "${onError}" }`), plugin.invoker));
    expect(runFailureCause(failure)).toBeInstanceOf(RunCostCapExceeded);
    expect(plugin.charged).toEqual(['a', 'b', 'c']);
    expect(warnings(failure.partial.trace)).toEqual([]);
  });

  it('members running together share the account: their spend adds up, and the next priced call is refused', async () => {
    const plugin = pricedInvoker();
    const failure = await failureOf(
      run(
        [
          'movement intake(m: <inbox-[:message]->>) {',
          `  pages = MAP(${MEMBERS}, { onError: "ignore", concurrency: 5 }, (u) => {`,
          '    page = fetch_url(url: u)',
          '    return COALESCE(page, "none")',
          '  })',
          '  after = fetch_url(url: "f")',
          '  write crm-[:companies]-> { name: m.`subject`, summary: JOIN(pages, ",") }',
          '}',
        ].join('\n'),
        plugin.invoker,
      ),
    );
    // All five started under the cap and ran together, so all five were
    // charged — the cap bounds what is STARTED, not what is already in flight.
    expect([...plugin.charged].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(failure.partial.spentMicrodollars).toBe(5 * DOLLAR);
    // The call after them was the one refused.
    expect(runFailureCause(failure)).toBeInstanceOf(RunCostCapExceeded);
    expect(failure.message).toContain('this run has spent $5.00');
  });

  it('a run under its cap is untouched', async () => {
    process.env[ENV_VAR] = '10';
    const plugin = pricedInvoker();
    const { result } = await run(mapMovement('{ concurrency: 2 }'), plugin.invoker);
    expect(result.spentMicrodollars).toBe(5 * DOLLAR);
  });
});

// ── The account belongs to the run ─────────────────────────────────────────

const ONE_FETCH = [
  'movement intake(m: <inbox-[:message]->>) {',
  '  page = fetch_url(url: "a")',
  '  write crm-[:companies]-> { name: m.`subject`, summary: COALESCE(page, "none") }',
  '}',
].join('\n');

describe('a resumed segment', () => {
  beforeEach(() => {
    process.env[ENV_VAR] = '2.5';
  });

  it("carries what the run spent before it parked: its result shows both the segment's and the run's spend", async () => {
    const plugin = pricedInvoker();
    const { result } = await run(ONE_FETCH, plugin.invoker, { priorSpentMicrodollars: DOLLAR });
    expect(result.spentMicrodollars).toBe(DOLLAR);
    expect(result.runSpentMicrodollars).toBe(2 * DOLLAR);
    expect(result.spentBySource).toEqual({ 'model:claude-sonnet-5': DOLLAR });
  });

  it('meets the cap the run reached in earlier segments: a run cannot escape it by parking', async () => {
    const plugin = pricedInvoker();
    const failure = await failureOf(run(ONE_FETCH, plugin.invoker, { priorSpentMicrodollars: 3 * DOLLAR }));
    expect(runFailureCause(failure)).toBeInstanceOf(RunCostCapExceeded);
    expect(failure.message).toContain('this run has spent $3.00');
    expect(plugin.charged).toEqual([]);
    // Nothing spent in this segment, but the run's figure is still on it.
    expect(failure.partial.spentMicrodollars).toBeUndefined();
    expect(failure.partial.runSpentMicrodollars).toBe(3 * DOLLAR);
  });
});

// ── Plugins that price their own work ───────────────────────────────────────

describe('a plugin that prices its own work', () => {
  function selfPricedInvoker(options: { priced: boolean }) {
    const invoked: string[] = [];
    const invoker: MovementTransformInvoker = {
      declaredOutput: (plugin) => realOutput(plugin),
      isPriced: () => options.priced,
      async invoke({ config }) {
        invoked.push(String(config.url));
        return {
          text: `got-${String(config.url)}`,
          cost: { quantity: 2, unit: 'request', unitPriceMicrodollars: 1_500 },
        };
      },
    };
    return { invoker, invoked };
  }

  it('is charged what its result reports, under its own name', async () => {
    const plugin = selfPricedInvoker({ priced: true });
    const { result } = await run(ONE_FETCH, plugin.invoker);
    expect(result.spentMicrodollars).toBe(3_000);
    expect(result.spentBySource).toEqual({ 'plugin:fetch_url': 3_000 });
  });

  it('a priced plugin is not started once the run has spent its cap', async () => {
    process.env[ENV_VAR] = '1';
    const plugin = selfPricedInvoker({ priced: true });
    const failure = await failureOf(run(ONE_FETCH, plugin.invoker, { priorSpentMicrodollars: DOLLAR }));
    expect(runFailureCause(failure)).toBeInstanceOf(RunCostCapExceeded);
    expect(plugin.invoked).toEqual([]);
  });

  it('an unpriced plugin is not asked first', async () => {
    process.env[ENV_VAR] = '1';
    const plugin = selfPricedInvoker({ priced: false });
    await run(ONE_FETCH, plugin.invoker, { priorSpentMicrodollars: DOLLAR });
    expect(plugin.invoked).toEqual(['a']);
  });

  it('a malformed cost report fails the run rather than charging nothing', async () => {
    const invoker: MovementTransformInvoker = {
      declaredOutput: (plugin) => realOutput(plugin),
      async invoke() {
        return { text: 'x', cost: { microdollars: -5 } };
      },
    };
    const failure = await failureOf(run(ONE_FETCH, invoker));
    expect(failure.message).toMatch(/a cost report must be/);
  });
});
