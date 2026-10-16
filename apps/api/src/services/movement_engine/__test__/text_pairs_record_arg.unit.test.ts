// TEXT.PAIRS over a RECORD the run holds — the Morning Recap shape, where the
// argument is a collecting node's entry, an extracted node, a synthesised
// node or a first(…) answer rather than a dict literal. Each arrives as its
// fields in declaration order, never as the engine's own binding object.
//
// Mirrors the harness of local_write.unit.test.ts.

// ── Jest module workarounds (mirrors run.unit.test.ts) ──────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('movement-engine/services/knowledge_pipeline/output_v3/schemas');

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

jest.mock('movement-engine/services/logger', () => ({
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

import { runMovement } from 'movement-engine/services/movement_engine/run';
import type { ExtractCallLlmClient } from 'movement-engine/services/movement_engine/extraction_call';

import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import { containerAssociation, type Adapter, type RuntimeCapabilities } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { positionData } from 'movement-engine/services/translation_graph/types';
import { tenantIdOf } from 'engine-contracts';
import { makeTestHost } from 'movement-engine/services/movement_engine/test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000041');

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

interface RecordedWrite {
  recordType: string;
  fields: Record<string, unknown>;
}

function makeFakeAdapter(adapterType: string): { adapter: Adapter; creates: RecordedWrite[] } {
  const creates: RecordedWrite[] = [];
  const adapter: Adapter = {
    adapterType,
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => permissiveCaps(),
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
      return { adapterType, externalId: `ext-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      return {
        adapterType,
        externalId: input.externalId,
        data: {},
        association: containerAssociation(input),
      };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

const catalog = staticCatalogSnapshot({
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
});

const CREDENTIAL_IDS: Record<string, string> = {
  dealflow_inbox: 'cred-email-1',
  acme_main: 'cred-attio-1',
};

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  '',
  'inbox = connect email',
  '',
  'node Entry {',
  '  name: <text>',
  '  stage: <text>',
  '  raised: <number>',
  '  hot: <boolean>',
  '  node founder {',
  '    first: <text>',
  '  }',
  '}',
  '',
].join('\n');

function webhookEvent(payload: Record<string, unknown>): TriggerEvent {
  return { pipelineInputId: 'pi-text-pairs', adapterType: 'email', triggerType: 'webhook', payload };
}

/** Answers every extraction call with one company, its fields in the REVERSE
 *  of their declared order — so the rendered order can only be the declaration's. */
const llm: ExtractCallLlmClient = {
  async call() {
    const wrap = (value: unknown) => ({ evidence: 'q', value });
    return {
      parsedJson: { record: { company: [{ stage: wrap('Seed'), name: wrap('Acme') }] } },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    };
  },
};
  },
};

/** Runs the body and answers with the `name` of every CRM create, in order —
 *  where each case writes what TEXT.PAIRS rendered. */
async function run(body: string[]): Promise<unknown[]> {
  const email = makeFakeAdapter('email');
  const attio = makeFakeAdapter('attio');
  const source =
    PRELUDE +
    [
      'function intake(msg: <inbox-[:message]->>) {',
      '  crm = connect attio using acme_main',
      ...body,
      '}',
    ].join('\n');
  await runMovement({
    source,
    movementName: 'intake',
    event: webhookEvent({ text: 'Acme raised a seed.' }),
    teamId: TEAM_ID,
    catalog,
    credentialIds: CREDENTIAL_IDS,
    host: makeTestHost({
      adapters: {
        resolve: ({ adapterType }: { adapterType: string }) => {
          if (adapterType === 'email') return email.adapter;
          if (adapterType === 'attio') return attio.adapter;
          throw new Error(`test: no fake adapter for '${adapterType}'`);
        },
      },
      llm: { extractCall: llm },
    }),
  });
  return attio.creates.map((w) => w.fields.name);
}

/** A collecting node holding one Acme entry, written out of declared order and
 *  then merged — `hot` arrives last, `stage` never, and a founder is linked on. */
const COLLECTED = [
  '  deduped = node { entries: <Entry> }',
  '  h = write deduped-[:entries]-> { unique by (`name`)',
  '    raised: 5',
  '    name: "Acme"',
  '  }',
  '  write deduped-[:entries]-> { unique by (`name`)',
  '    name: "Acme"',
  '    hot ?: false',
  '  }',
  '  jane = node { first: "Jane" }',
  '  link h -[:founder]-> jane',
];

describe('TEXT.PAIRS over a record the run holds', () => {
  it("a collecting node's entry: declared order, absent empty, the nested founder omitted", async () => {
    await expect(
      run([
        ...COLLECTED,
        '  deduped-[e:entries]-> {',
        '    write crm-[:companies]-> { name: Text.pairs(e) }',
        '  }',
      ]),
    ).resolves.toEqual(['name=Acme | stage= | raised=5 | hot=false']);
  });

  it('an extracted node reached in a block', async () => {
    await expect(
      run([
        '  x = extractOne([msg.`text`], node Found: "the companies named" {',
        '    node company: "each company named" {',
        '      name: <text> "the company\'s name"',
        '      stage: <text> "its funding stage"',
        '    }',
        '  })',
        '  if (x == null) { fail("nothing extracted") }',
        '  x-[c:company]-> {',
        '    write crm-[:companies]-> { name: Text.pairs(c) }',
        '  }',
      ]),
    ).resolves.toEqual(['name=Acme | stage=Seed']);
  });

  it('a `node { … }` literal bound to a name, its nested node omitted', async () => {
    await expect(
      run([
        '  d = node { b: 2, a: "x", flag: true, sub: node { z: 1 } }',
        '  write crm-[:companies]-> { name: Text.pairs(d) }',
      ]),
    ).resolves.toEqual(['b=2 | a=x | flag=true']);
  });

  it('a first(…) answer over the collected entries', async () => {
    await expect(
      run([
        ...COLLECTED,
        '  write deduped-[:entries]-> { unique by (`name`)',
        '    name: "Beta"',
        '  }',
        '  entries = deduped-[e:entries]-> { return e }',
        '  top = first(entries)',
        '  write crm-[:companies]-> { name: Text.pairs(top, "; ") }',
      ]),
    ).resolves.toEqual(['name=Acme; stage=; raised=5; hot=false']);
  });

  it('inside `${…}` interpolation', async () => {
    await expect(
      run([
        ...COLLECTED,
        '  deduped-[e:entries]-> {',
        '    write crm-[:companies]-> { name: "entry: ${Text.pairs(e)}" }',
        '  }',
      ]),
    ).resolves.toEqual(['entry: name=Acme | stage= | raised=5 | hot=false']);
  });
});
