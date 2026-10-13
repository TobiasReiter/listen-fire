// Engine coverage for `match` — the identity half of a write, on its own.
//
// What is worth pinning is that a match runs EXACTLY the identity a write
// runs (the same arbitration, the same one judge for a lone fuzzy hit), that
// a hit binds the record and the block goes on, and that a miss — including
// the judge declining — ends the scope with nothing written. The same holds
// against a node this run built, through the same stand-in adapter a local
// write resolves against.
//
// Mirrors the harness of local_write.unit.test.ts (the judge mocked at the
// LLM seam, so the real arbitration still runs).

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

// The judge is the host's (`host.llm.arbitrateEntities`, mocked below); the
// engine's own rules (the short-circuits, the exactness rule) still run. The
// prompt layer is stubbed so nothing below the host is ever reached.
jest.mock('../../../lib/prompts/execute', () => ({
  execute: jest.fn(),
  parseJsonReply: jest.fn(),
  flattenMessages: jest.fn(),
}));

import { runMovement } from '../run';

import type { InstanceSchema, LanguageVersion } from 'movement-lang';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import {
  containerAssociation,
  type Adapter,
  type ExternalRecordRef,
  type RuntimeCapabilities,
} from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData } from '../../translation_graph/types';
import { tenantIdOf } from 'engine-contracts';
import type { ArbitrateEntities } from '../host';
import { makeTestHost } from '../test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000021');
/** The host's judge: the candidate index it picks, or null to decline. */
const arbitrateEntities = jest.fn<ReturnType<ArbitrateEntities>, Parameters<ArbitrateEntities>>();

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

interface RecordedWrite {
  recordType: string;
  fields: Record<string, unknown>;
}

function makeFakeAdapter(
  adapterType: string,
  /** What `resolveEntity` finds, by the record type asked for. */
  candidates: Record<string, ExternalRecordRef[]> = {},
): { adapter: Adapter; creates: RecordedWrite[] } {
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
    async resolveEntity({ recordType }) {
      return { candidates: candidates[recordType] ?? [] };
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

/** A CRM whose companies resolve by similarity — so `FUZZY` is honest here —
 *  and whose notes are what a hit goes on to write. */
const crmSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text', summary: 'text' }, edges: {} },
    note: { properties: { title: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: {
      fields: { name: 'text', summary: 'text' },
      resultShape: { externalId: 'text', name: 'text', summary: 'text' },
      fuzzyResolution: true,
    },
    note: { fields: { title: 'text' }, resultShape: { externalId: 'text', title: 'text' } },
  },
};

const catalog = staticCatalogSnapshot({
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
  instanceSchemas: { attio: crmSchema },
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
  'node Company {',
  '  name: <text>',
  '  summary: <text>',
  '}',
  '',
  // A declaration is a TREE, and a landing written into an `<Entry>` edge is an
  // Entry — so it carries `founder` the way the literal carries `entries`.
  'node Entry {',
  '  name: <text>',
  '  node founder {',
  '    first: <text>',
  '    last: <text>',
  '  }',
  '}',
  '',
  // Same tree, but `founder` says its order — the nested form of `order by
  // arrival`, read back by FIRST/JOIN exactly as a top-level entry is.
  'node OrderedEntry {',
  '  name: <text>',
  '  node founder {',
  '    first: <text>',
  '    last: <text>',
  '  } order by arrival',
  '}',
  '',
].join('\n');

function webhookEvent(payload: Record<string, unknown>): TriggerEvent {
  return { pipelineInputId: 'pi-match', adapterType: 'email', triggerType: 'webhook', payload };
}

function run(
  body: string[],
  adapters: { email: Adapter; attio: Adapter },
  options: { languageVersion?: LanguageVersion } = {},
) {
  const source =
    PRELUDE +
    [
      'movement intake(msg: <inbox-[:message]->>) {',
      '  crm = attio(credentials: acme_main)',
      '  deduped = node { companies: <Company> }',
      ...body,
      '}',
    ].join('\n');
  return runMovement({
    source,
    movementName: 'intake',
    ...options,
    event: webhookEvent({}),
    teamId: TEAM_ID,
    catalog,
    credentialIds: CREDENTIAL_IDS,
    host: makeTestHost({
      llm: { arbitrateEntities },
      adapters: {
        resolve: ({ adapterType }: { adapterType: string }) => {
          if (adapterType === 'email') return adapters.email;
          if (adapterType === 'attio') return adapters.attio;
          throw new Error(`test: no fake adapter for '${adapterType}'`);
        },
      },
    }),
  });
}

const ACME: ExternalRecordRef = {
  adapterType: 'attio',
  externalId: 'co-1',
  data: { name: 'Acme Incorporated', summary: 'already there' },
};

beforeEach(() => {
  arbitrateEntities.mockReset();
});

describe('a match against a system', () => {
  const FUZZY_MATCH = [
    '  co = match crm-[:companies]-> { unique by (FUZZY `name`)',
    '    name: "Acme"',
    '  }',
    '  if co != null { write crm-[:notes]-> { title: co.`summary` } }',
  ];

  it('a lone fuzzy hit goes to the judge; accepted, the handle is the record and the block runs', async () => {
    arbitrateEntities.mockResolvedValue({ index: 0 });
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio', { company: [ACME] });
    const result = await run(FUZZY_MATCH, { email: email.adapter, attio: attio.adapter });

    expect(arbitrateEntities).toHaveBeenCalledTimes(1);
    expect(arbitrateEntities.mock.calls[0][0]).toMatchObject({ candidates: [ACME] });
    // Nothing about the company was created or sent; the note read it.
    expect(attio.creates).toEqual([{ recordType: 'note', fields: { title: 'already there' } }]);
    expect(result.writes.map((w) => [w.kind ?? 'write', w.externalId, w.created, w.committed])).toEqual([
      ['match', 'co-1', false, false],
      ['write', 'ext-1', true, true],
    ]);
  });

  it('under version 3 the judge declining is a miss: the scope ends, nothing is written', async () => {
    arbitrateEntities.mockResolvedValue({ index: null });
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio', { company: [ACME] });
    const result = await run(FUZZY_MATCH, { email: email.adapter, attio: attio.adapter }, { languageVersion: 3 });

    expect(arbitrateEntities).toHaveBeenCalledTimes(1);
    expect(attio.creates).toEqual([]);
    expect(result.writes).toEqual([]);
  });

  it('a lone EXACT hit needs no judge', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio', { company: [ACME] });
    await run(
      [
        '  co = match crm-[:companies]-> { unique by (`name`), name: "Acme Incorporated" }',
        '  if co != null { write crm-[:notes]-> { title: co.`summary` } }',
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    expect(arbitrateEntities).not.toHaveBeenCalled();
    expect(attio.creates).toEqual([{ recordType: 'note', fields: { title: 'already there' } }]);
  });

  it('under version 3 an unbound match is a gate: what follows runs only when the record exists', async () => {
    const gate = [
      '  match crm-[:companies]-> { unique by (`name`), name: "Acme Incorporated" }',
      '  write crm-[:notes]-> { title: "known company" }',
    ];
    const hit = makeFakeAdapter('attio', { company: [ACME] });
    await run(gate, { email: makeFakeAdapter('email').adapter, attio: hit.adapter }, { languageVersion: 3 });
    expect(hit.creates.map((c) => c.fields.title)).toEqual(['known company']);

    const miss = makeFakeAdapter('attio');
    const result = await run(gate, { email: makeFakeAdapter('email').adapter, attio: miss.adapter }, { languageVersion: 3 });
    expect(miss.creates).toEqual([]);
    expect(result.writes).toEqual([]);
  });
});

describe('the shortlist narrowed by a non-equality conjunct', () => {
  it('binds the candidate the arbiter chose from the NARROWED list, not the one at its index before', async () => {
    const stale: ExternalRecordRef = {
      adapterType: 'attio',
      externalId: 'co-stale',
      data: { name: 'Acme', summary: 'stale' },
    };
    const fresh: ExternalRecordRef = {
      adapterType: 'attio',
      externalId: 'co-fresh',
      data: { name: 'Acme', summary: 'fresh' },
    };
    const attio = makeFakeAdapter('attio', { company: [stale, fresh] });
    const result = await run(
      [
        '  co = match crm-[:companies]-> { unique by (`name`, `summary` != "stale"), name: "Acme" }',
        '  if co != null { write crm-[:notes]-> { title: co.`summary` } }',
      ],
      { email: makeFakeAdapter('email').adapter, attio: attio.adapter },
    );
    expect(result.writes[0]).toMatchObject({ kind: 'match', externalId: 'co-fresh' });
    expect(attio.creates).toEqual([{ recordType: 'note', fields: { title: 'fresh' } }]);
  });
});

describe('a match against a node this run built', () => {
  it('finds the landing a write put there, and binds it', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const result = await run(
      [
        '  write deduped-[:companies]-> { unique by (`name`), name: "Acme", summary: "first" }',
        '  hit = match deduped-[:companies]-> { unique by (`name`), name: "Acme" }',
        '  if hit != null { write crm-[:notes]-> { title: hit.`summary` } }',
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    expect(attio.creates).toEqual([{ recordType: 'note', fields: { title: 'first' } }]);
    const found = result.writes.find((w) => w.kind === 'match');
    expect(found).toMatchObject({ kind: 'match', local: { edge: 'companies' }, committed: false, writtenValues: {} });
  });

  it('under version 3 a miss ends the scope and adds nothing to the edge', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await run(
      [
        '  write deduped-[:companies]-> { unique by (`name`), name: "Acme" }',
        '  match deduped-[:companies]-> { unique by (`name`), name: "Beta" }',
        '  write crm-[:notes]-> { title: "never" }',
      ],
      { email: email.adapter, attio: attio.adapter },
      { languageVersion: 3 },
    );
    expect(attio.creates).toEqual([]);
  });
});

describe('a miss under language version 4', () => {
  const NAMED_MISS = [
    '  existing = match crm-[:companies]-> { unique by (`name`), name: "Nope Ltd" }',
    '  write crm-[:notes]-> { title: IF existing == null THEN "absent" ELSE "found" END }',
  ];

  // The fake answers by record type alone, so a miss is a CRM with no companies.
  it('binds absent and the next statement runs', async () => {
    const attio = makeFakeAdapter('attio');
    const result = await run(NAMED_MISS, { email: makeFakeAdapter('email').adapter, attio: attio.adapter });
    expect(attio.creates).toEqual([{ recordType: 'note', fields: { title: 'absent' } }]);
    // No match row on a miss: the run log shows only what was found or written.
    expect(result.writes.map((w) => w.kind ?? 'write')).toEqual(['write']);
  });

  it('a judge outage binds absent, and the trace says the judge never answered', async () => {
    // The host's judge reports its outage rather than throwing.
    arbitrateEntities.mockResolvedValue({ index: null, judgeUnavailable: 'anthropic 529' });
    const attio = makeFakeAdapter('attio', { company: [ACME] });
    const result = await run(
      [
        '  existing = match crm-[:companies]-> { unique by (FUZZY `name`), name: "Acme" }',
        NAMED_MISS[1],
      ],
      { email: makeFakeAdapter('email').adapter, attio: attio.adapter },
    );
    expect(arbitrateEntities).toHaveBeenCalled();
    expect(attio.creates).toEqual([{ recordType: 'note', fields: { title: 'absent' } }]);
    const warnings = result.trace.filter(
      (e): e is Extract<typeof e, { kind: 'warning' }> => e.kind === 'warning',
    );
    expect(warnings.map((w) => w.code)).toEqual(['MOVENG_MATCH_JUDGE_UNAVAILABLE']);
    expect(warnings[0].message).toContain('judge unavailable: anthropic 529');
  });

  it('a hit binds the record exactly as before', async () => {
    const attio = makeFakeAdapter('attio', { company: [ACME] });
    await run([NAMED_MISS[0].replace('Nope Ltd', 'Acme Incorporated'), NAMED_MISS[1]], {
      email: makeFakeAdapter('email').adapter,
      attio: attio.adapter,
    });
    expect(attio.creates).toEqual([{ recordType: 'note', fields: { title: 'found' } }]);
  });

  it('under version 3 the same miss still ends the scope', async () => {
    const attio = makeFakeAdapter('attio');
    const result = await run(
      NAMED_MISS,
      { email: makeFakeAdapter('email').adapter, attio: attio.adapter },
      { languageVersion: 3 },
    );
    expect(attio.creates).toEqual([]);
    expect(result.writes).toEqual([]);
  });

  it('a miss against a node this run built binds absent too', async () => {
    const attio = makeFakeAdapter('attio');
    const result = await run(
      [
        '  write deduped-[:companies]-> { unique by (`name`), name: "Acme" }',
        '  missing = match deduped-[:companies]-> { unique by (`name`), name: "Beta" }',
        '  write crm-[:notes]-> { title: IF missing == null THEN "absent" ELSE "found" END }',
      ],
      { email: makeFakeAdapter('email').adapter, attio: attio.adapter },
    );
    expect(attio.creates).toEqual([{ recordType: 'note', fields: { title: 'absent' } }]);
    expect(result.writes.some((w) => w.kind === 'match')).toBe(false);
  });
});
