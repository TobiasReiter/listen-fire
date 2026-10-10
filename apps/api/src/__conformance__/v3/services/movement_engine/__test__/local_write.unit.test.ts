// Engine coverage for a WRITE into a run-local node's edge — in-process
// deduplication, reusing the write's own vocabulary.
//
// The point of the design is that NOTHING about a write changes when its
// destination is the run's own graph: the same `unique by` lowering, the same
// candidate arbitration and the same single judge, the same `?:` fill against
// what is already there, the same create / update / noop outcomes. So what is
// worth pinning is exactly that — that an edge with a landing on it merges
// rather than accumulating, that a FUZZY block reaches the judge only when
// there is something to judge, and that the row the firing log gets says it
// touched no system.
//
// Mirrors the harness of node_synthesis.unit.test.ts.

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

// The ONE judge — mocked at the LLM seam, so the real arbitration (the
// short-circuits, the exactness rule) still runs and only the decision is
// injected.
jest.mock('../../../lib/prompts/execute', () => ({
  execute: jest.fn(),
  parseJsonReply: jest.fn(),
  flattenMessages: jest.fn(),
}));

import { execute } from '../../../lib/prompts/execute';
import { runMovement } from '../run';

import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { containerAssociation, type Adapter, type RuntimeCapabilities } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000021' as TeamId;
const mockExecute = execute as jest.MockedFunction<typeof execute>;

/** The judge's reply shape ({match_index, confidence, reasoning}). */
const judged = (match_index: number | null, confidence = 0.9) =>
  ({ match_index, confidence, reasoning: 'test' }) as never;

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
  return { pipelineInputId: 'pi-local-write', adapterType: 'email', triggerType: 'webhook', payload };
}

/** The movement body, wrapped — every case declares the same deduping node. */
function run(body: string[], adapters: { email: Adapter; attio: Adapter }) {
  return runWith('  deduped = node { companies: <Company> }', body, adapters);
}

/** The same wrapper with the deduping node spelled by the caller — the nested
 *  cases dedupe `<Entry>`, which carries an edge of its own. */
function runWith(
  declaration: string,
  body: string[],
  adapters: { email: Adapter; attio: Adapter },
) {
  const source =
    PRELUDE +
    [
      'movement intake(msg: <inbox-[:message]->>) {',
      '  crm = attio(credentials: acme_main)',
      declaration,
      ...body,
      '}',
    ].join('\n');
  return runMovement({
    source,
    movementName: 'intake',
    event: webhookEvent({}),
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: (name) => CREDENTIAL_IDS[name],
    resolveAdapter: ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'email') return adapters.email;
      if (adapterType === 'attio') return adapters.attio;
      throw new Error(`test: no fake adapter for '${adapterType}'`);
    },
  });
}

/** `deduped`'s landings, read back through an ordinary traversal into a real
 *  write — the only honest way to see what is on the edge. */
const READ_BACK = [
  '  deduped-[c:companies]-> {',
  '    write crm-[:companies]-> { name: c.`name`, summary: c.`summary` }',
  '  }',
];

beforeEach(() => {
  mockExecute.mockReset();
});

describe('two writes of the same thing are one landing', () => {
  it('matches by an exact component, and `?:` fills only what is absent', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const result = await run(
      [
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '    summary ?: "filled"',
        '  }',
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '    summary ?: "ignored"',
        '  }',
        ...READ_BACK,
      ],
      { email: email.adapter, attio: attio.adapter },
    );

    // ONE landing: the second write filled what was absent, the third found it
    // already there and wrote nothing.
    expect(attio.creates.map((w) => w.fields)).toEqual([{ name: 'Acme', summary: 'filled' }]);
    expect(mockExecute).not.toHaveBeenCalled();

    const local = result.writes.filter((w) => w.local !== undefined);
    expect(local.map((w) => w.outcome)).toEqual(['create', 'update', 'noop']);
    expect(local.map((w) => w.writtenValues)).toEqual([
      { name: 'Acme' },
      { summary: 'filled' },
      {},
    ]);
  });

  it('a second identical write sends nothing at all', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const result = await run(
      [
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    expect(result.writes.map((w) => w.outcome)).toEqual(['create', 'noop']);
  });
});

// `order by arrival` is the AUTHOR's claim about this edge; what backs it is
// the runtime's own behaviour — `link`/`write` append, and a merge writes into
// the record already on the edge rather than moving it to the end.
describe('an entry that says `order by arrival` reads back in landing order', () => {
  const ORDERED = '  deduped = node { companies: <Company> order by arrival }';

  it('a merge writes into the record already there — the first written is still first', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await runWith(
      ORDERED,
      [
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Beta"',
        '  }',
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Gamma"',
        '  }',
        // The merge lands on the FIRST landing, filling what was absent.
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '    summary ?: "filled"',
        '  }',
        ...READ_BACK,
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    expect(attio.creates.map((w) => w.fields)).toEqual([
      { name: 'Acme', summary: 'filled' },
      { name: 'Beta', summary: null },
      { name: 'Gamma', summary: null },
    ]);
  });

  it('JOIN over the edge is the landing order, with no ORDER BY anywhere', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await runWith(
      ORDERED,
      [
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Beta"',
        '  }',
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Gamma"',
        '  }',
        '  joined = JOIN(deduped-[c:companies]->.`name`, ", ")',
        '  write crm-[:companies]-> { name: joined }',
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    expect(attio.creates.map((w) => w.fields.name)).toEqual(['Acme, Beta, Gamma']);
  });
});

describe('a FUZZY component blocks on the distinctive word', () => {
  it('two names sharing only the kind word never reach the judge', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await run(
      [
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Faction AI"',
        '  }',
        '  write deduped-[:companies]-> { unique by (FUZZY `name`)',
        '    name: "Actions AI"',
        '  }',
        ...READ_BACK,
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    expect(attio.creates.map((w) => w.fields.name)).toEqual(['Faction AI', 'Actions AI']);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('the judge picks one of the blocked landings, and the write merges into it', async () => {
    mockExecute.mockResolvedValue(judged(0));
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await run(
      [
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Faction AI"',
        '  }',
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Faction Labs"',
        '  }',
        '  write deduped-[:companies]-> { unique by (FUZZY `name`)',
        '    name: "Faction"',
        '    summary: "the merged one"',
        '  }',
        ...READ_BACK,
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    // Two landings, and the merged one kept its place and took the new name.
    // (The untouched landing reads its absent field as null, as any synthesised
    // node's does — nothing about that is this write's doing.)
    expect(attio.creates.map((w) => w.fields)).toEqual([
      { name: 'Faction', summary: 'the merged one' },
      { name: 'Faction Labs', summary: null },
    ]);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('a declined judgement is a second landing, not a merge', async () => {
    mockExecute.mockResolvedValue(judged(null));
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await run(
      [
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Faction AI"',
        '  }',
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Faction Labs"',
        '  }',
        '  write deduped-[:companies]-> { unique by (FUZZY `name`)',
        '    name: "Faction"',
        '  }',
        ...READ_BACK,
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    expect(attio.creates.map((w) => w.fields.name)).toEqual([
      'Faction AI',
      'Faction Labs',
      'Faction',
    ]);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('a THROWN judge still creates (never errors the write) but marks the write with a note', async () => {
    mockExecute.mockRejectedValue(new Error('anthropic 529'));
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const result = await run(
      [
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Faction AI"',
        '  }',
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Faction Labs"',
        '  }',
        '  write deduped-[:companies]-> { unique by (FUZZY `name`)',
        '    name: "Faction"',
        '  }',
        ...READ_BACK,
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    // Same observable outcome as a considered decline — a create, not an
    // error — but the write is no longer indistinguishable from an honest
    // "no match": it carries a note saying the judge never got an answer.
    expect(attio.creates.map((w) => w.fields.name)).toEqual([
      'Faction AI',
      'Faction Labs',
      'Faction',
    ]);
    const thirdLocalWrite = result.writes.filter((w) => w.local !== undefined)[2];
    expect(thirdLocalWrite.note).toBe(
      'judge unavailable: anthropic 529; created rather than merged',
    );
  });
});

describe('the row the firing log gets', () => {
  it('says it touched no system — local, uncommitted, no external id', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const result = await run(
      [
        '  c = write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    expect(result.writes).toHaveLength(1);
    const row = result.writes[0];
    expect(row.adapterType).toBe('local');
    expect(row.recordType).toBe('companies');
    expect(row.local).toEqual({ edge: 'companies' });
    expect(row.committed).toBe(false);
    expect(row.externalId).toBeUndefined();
    expect(row.bindingName).toBe('c');
  });

  it('a handle the write bound reads its own fields, and links onto another edge', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await run(
      [
        '  also = node { companies: <Company> }',
        '  c = write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  link also -[:companies]-> c',
        '  also-[x:companies]-> {',
        '    write crm-[:companies]-> { name: x.`name` }',
        '  }',
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    expect(attio.creates.map((w) => w.fields)).toEqual([{ name: 'Acme' }]);
  });
});

// A landing written into a shape-typed edge is a whole node of that shape, so
// the edges the declaration nested on it are there to grow — empty at the
// create, appended in program order by `link`, and read back by an ordinary
// two-hop traversal. A MERGE writes into the landing already there, which is
// what keeps the founders an earlier write linked.
describe('the nested edges a written landing carries', () => {
  const NESTED = '  deduped = node { entries: <Entry> }';

  /** The two hops, read back into real writes — the only honest way to see
   *  what is on the nested edge, and in what order. */
  const READ_FOUNDERS = [
    '  deduped-[x:entries]-> {',
    '    x-[f:founder]-> {',
    '      write crm-[:companies]-> { name: f.`first`, summary: f.`last` }',
    '    }',
    '  }',
  ];

  it('link appends to the nested edge, and the traversal reads them in link order', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await runWith(
      NESTED,
      [
        '  h = write deduped-[:entries]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  jane = node { first: "Jane", last: "Doe" }',
        '  john = node { first: "John", last: "Roe" }',
        '  link h -[:founder]-> jane',
        '  link h -[:founder]-> john',
        ...READ_FOUNDERS,
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    expect(attio.creates.map((w) => w.fields)).toEqual([
      { name: 'Jane', summary: 'Doe' },
      { name: 'John', summary: 'Roe' },
    ]);
  });

  it('a merged write keeps the first landing’s founders, and new links append to them', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const result = await runWith(
      NESTED,
      [
        '  first = write deduped-[:entries]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  jane = node { first: "Jane", last: "Doe" }',
        '  link first -[:founder]-> jane',
        '  again = write deduped-[:entries]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  john = node { first: "John", last: "Roe" }',
        '  link again -[:founder]-> john',
        ...READ_FOUNDERS,
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    // ONE entry, and the second write's handle IS the first landing — so the
    // founders accumulate on it rather than the second link landing nowhere.
    expect(result.writes.filter((w) => w.local !== undefined).map((w) => w.outcome)).toEqual([
      'create',
      'noop',
    ]);
    expect(attio.creates.map((w) => w.fields)).toEqual([
      { name: 'Jane', summary: 'Doe' },
      { name: 'John', summary: 'Roe' },
    ]);
  });

  it('a write into the nested edge builds there, and merges by its own identity', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await runWith(
      NESTED,
      [
        '  h = write deduped-[:entries]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  write h-[:founder]-> { unique by (`first`)',
        '    first: "Jane"',
        '    last: "Doe"',
        '  }',
        '  write h-[:founder]-> { unique by (`first`)',
        '    first: "Jane"',
        '    last ?: "ignored"',
        '  }',
        ...READ_FOUNDERS,
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    expect(attio.creates.map((w) => w.fields)).toEqual([{ name: 'Jane', summary: 'Doe' }]);
  });
});

// `node founder { … } order by arrival` — the same claim a top-level entry
// makes, said about a NESTED edge instead. What backs it is unchanged: `link`
// and `write` append to the edge's landings, and a merge fills the record
// already there rather than moving it to the end — so FIRST and a full
// traversal agree on the order without either statement changing.
describe('a nested entry that says `order by arrival` reads back founders in landing order', () => {
  const NESTED = '  deduped = node { entries: <OrderedEntry> }';
  // The ruling's own idiom: collect the founder names by a traversal-headed
  // block (a MAP over the edge, which preserves the hop's ordering), then fold
  // that value list — FIRST for the lead, JOIN to see every name in order.
  const READ_BACK = [
    '  deduped-[x:entries]-> {',
    '    names = x-[f:founder]-> { return f.`first` }',
    '    lead = FIRST(names)',
    // FIRST answers `T | absent` (an empty list has no first) — discharge it
    // the way the checker offers, same as any other maybe-absent read.
    '    write crm-[:companies]-> { name: "lead", summary: COALESCE(lead, "none") }',
    '    write crm-[:companies]-> { name: JOIN(names, ", "), summary: "all" }',
    '  }',
  ];

  it('FIRST is the first founder written; a merged write appends a fourth to the end', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await runWith(
      NESTED,
      [
        '  h = write deduped-[:entries]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  write h-[:founder]-> { unique by (`first`)',
        '    first: "Jane"',
        '    last: "Doe"',
        '  }',
        '  write h-[:founder]-> { unique by (`first`)',
        '    first: "John"',
        '    last: "Roe"',
        '  }',
        '  write h-[:founder]-> { unique by (`first`)',
        '    first: "Jo"',
        '    last: "Bloggs"',
        '  }',
        // A merge onto the same entry — `again` is the same landing `h` is.
        '  again = write deduped-[:entries]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  write again-[:founder]-> { unique by (`first`)',
        '    first: "Meg"',
        '    last: "Fourth"',
        '  }',
        ...READ_BACK,
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    // FIRST is still the first founder ever written, after the merge and the
    // fourth write; JOIN shows the fourth appended last.
    expect(attio.creates.map((w) => w.fields)).toEqual([
      { name: 'lead', summary: 'Jane' },
      { name: 'Jane, John, Jo, Meg', summary: 'all' },
    ]);
  });
});
