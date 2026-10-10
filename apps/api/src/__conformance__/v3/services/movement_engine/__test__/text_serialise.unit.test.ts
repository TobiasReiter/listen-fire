// TEXT.SERIALISE over the values a run holds — a record with its nested nodes,
// a dict, a list, an extracted node. Mirrors the harness of text_pairs_record_arg.unit.test.ts.

// ── Jest module workarounds (mirrors run.unit.test.ts) ──────────────────────

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

jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

import { runMovement } from '../run';
import type {
  LlmCallInput,
  LlmCallResult,
  LlmClient,
} from '../../translation_graph/engine/batched_extraction';

import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { containerAssociation, type Adapter, type RuntimeCapabilities } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000041' as TeamId;

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

const catalog = staticCatalogFromManifests({
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
  'inbox = email()',
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
  return { pipelineInputId: 'pi-text-serialise', adapterType: 'email', triggerType: 'webhook', payload };
}

/** Answers every extraction call with one company, its fields in the REVERSE
 *  of their declared order — so the rendered order can only be the declaration's. */
const llm: LlmClient = {
  async call(input: LlmCallInput): Promise<LlmCallResult> {
    const key = /one key — `([^`]+)`/.exec(input.system)?.[1];
    if (!key) throw new Error(`test: no answer key in the system prompt:\n${input.system}`);
    const wrap = (value: unknown) => ({ evidence: 'q', value });
    return {
      parsedJson: { [key]: [{ company: [{ stage: wrap('Seed'), name: wrap('Acme') }] }] },
    };
  },
};

/** Runs the body and answers with the `name` of every CRM create, in order —
 *  where each case writes what TEXT.SERIALISE rendered. */
async function run(body: string[]): Promise<unknown[]> {
  const email = makeFakeAdapter('email');
  const attio = makeFakeAdapter('attio');
  const source =
    PRELUDE +
    [
      'movement intake(msg: <inbox-[:message]->>) {',
      '  crm = attio(credentials: acme_main)',
      ...body,
      '}',
    ].join('\n');
  await runMovement({
    source,
    movementName: 'intake',
    event: webhookEvent({ text: 'Acme raised a seed.' }),
    teamId: TEAM_ID,
    catalog,
    llm,
    resolveCredentialId: (name) => CREDENTIAL_IDS[name],
    resolveAdapter: ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'email') return email.adapter;
      if (adapterType === 'attio') return attio.adapter;
      throw new Error(`test: no fake adapter for '${adapterType}'`);
    },
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

const json = (value: unknown): string => JSON.stringify(value, null, 2);

describe('TEXT.SERIALISE over a value the run holds', () => {
  it('a node literal: fields sorted, its nested node under the edge name as a list', async () => {
    await expect(
      run([
        '  d = node { b: 2, a: "x", flag: true, sub: node { z: 1, y: "w" } }',
        '  write crm-[:companies]-> { name: TEXT.SERIALISE(d, "JSON") }',
      ]),
    ).resolves.toEqual([json({ a: 'x', b: 2, flag: true, sub: [{ y: 'w', z: 1 }] })]);
  });

  it("a collecting node's entry: absent fields are null, a linked founder nests under its edge", async () => {
    await expect(
      run([
        ...COLLECTED,
        '  deduped-[e:entries]-> {',
        '    write crm-[:companies]-> { name: TEXT.SERIALISE(e, "JSON") }',
        '  }',
      ]),
    ).resolves.toEqual([
      json({ founder: [{ first: 'Jane' }], hot: false, name: 'Acme', raised: 5, stage: null }),
    ]);
  });

  it('an extracted node reached in a block', async () => {
    await expect(
      run([
        '  x = extract from [msg.`text`] {',
        '    node company: "each company named" {',
        '      name: "the company\'s name"',
        '      stage: "its funding stage"',
        '    }',
        '  }',
        '  x-[c:company]-> {',
        '    write crm-[:companies]-> { name: TEXT.SERIALISE(c, "JSON") }',
        '  }',
      ]),
    ).resolves.toEqual([json({ name: 'Acme', stage: 'Seed' })]);
  });

  it('a dict holding a record and a list: records inside are read down too', async () => {
    await expect(
      run([
        '  d = node { name: "Acme", n: 1 }',
        '  write crm-[:companies]-> { name: TEXT.SERIALISE({ who: d, tags: ["b", "a"] }, "JSON") }',
      ]),
    ).resolves.toEqual([json({ tags: ['b', 'a'], who: { n: 1, name: 'Acme' } })]);
  });

  it('a FIRST(…) answer over the collected entries', async () => {
    await expect(
      run([
        ...COLLECTED,
        '  all = deduped-[e:entries]-> { return e }',
        '  top = FIRST(all)',
        '  write crm-[:companies]-> { name: TEXT.SERIALISE(top, "JSON") }',
      ]),
    ).resolves.toEqual([
      json({ founder: [{ first: 'Jane' }], hot: false, name: 'Acme', raised: 5, stage: null }),
    ]);
  });

  it("a created system record: its edges were never walked, so none appears (absent, never `[]`)", async () => {
    await expect(
      run([
        '  c = write crm-[:companies]-> { name: "Acme" }',
        '  write crm-[:companies]-> { name: TEXT.SERIALISE(c, "JSON") }',
      ]),
    ).resolves.toEqual(['Acme', json({ name: 'Acme' })]);
  });

  it("a run-built entry with no founder: the run holds its edge, so it prints as `[]`", async () => {
    await expect(
      run([
        '  deduped = node { entries: <Entry> }',
        '  h = write deduped-[:entries]-> { name: "Acme" }',
        '  write crm-[:companies]-> { name: TEXT.SERIALISE(h, "JSON") }',
      ]),
    ).resolves.toEqual([json({ founder: [], hot: null, name: 'Acme', raised: null, stage: null })]);
  });

  it('a run-built entry whose founder edge a block walked prints its members', async () => {
    await expect(
      run([
        ...COLLECTED,
        '  deduped-[e:entries]-> {',
        '    e-[f:founder]-> {',
        '      write crm-[:companies]-> { name: f.first }',
        '    }',
        '    write crm-[:companies]-> { name: TEXT.SERIALISE(e, "JSON") }',
        '  }',
      ]),
    ).resolves.toEqual([
      'Jane',
      json({ founder: [{ first: 'Jane' }], hot: false, name: 'Acme', raised: 5, stage: null }),
    ]);
  });

  it('scalars', async () => {
    await expect(
      run([
        '  write crm-[:companies]-> { name: TEXT.SERIALISE("a\\"b", "JSON") }',
        '  write crm-[:companies]-> { name: TEXT.SERIALISE(3, "JSON") }',
      ]),
    ).resolves.toEqual(['"a\\"b"', '3']);
  });

  it('key order in the source never changes the bytes', async () => {
    const [one, other] = await run([
      '  write crm-[:companies]-> { name: TEXT.SERIALISE({ b: 1, a: { d: 1, c: 2 } }, "JSON") }',
      '  write crm-[:companies]-> { name: TEXT.SERIALISE({ a: { c: 2, d: 1 }, b: 1 }, "JSON") }',
    ]);
    expect(one).toBe(other);
  });

  it('inside `${…}` interpolation', async () => {
    await expect(
      run([
        '  d = node { a: 1 }',
        '  write crm-[:companies]-> { name: "rec: ${TEXT.SERIALISE(d, "JSON")}" }',
      ]),
    ).resolves.toEqual([`rec: ${json({ a: 1 })}`]);
  });
});

