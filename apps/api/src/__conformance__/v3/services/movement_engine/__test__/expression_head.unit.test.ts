// A block head that starts at an EXPRESSION, run.
//
// `AT(both, 1)-[t:tag]-> { … }` is the same walk as binding `AT(both, 1)` to a
// name and hopping off the name. The engine evaluates the root once, at the
// head, through the SAME reading a binding gets — so the two forms cannot
// drift apart — and hands the value to the walk that already knows what to do
// with a value holding records.
//
// Laziness is unchanged by it: a deferred head evaluates its root at the READ,
// out of the scope the walk captured, which is the moment the rest of the walk
// happens too. That is what lets a parked run resume one: the recipe travels,
// the answer does not.
//
// What is pinned here: the three shapes run; the inline form writes exactly
// what the bound form writes; a lazy head with an expression root defers,
// serialises, and resumes; and the head's own bracket applies off each root.

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

import { mockCatalog, type InstanceSchema } from 'movement-lang';
import { runMovement } from '../run';
import type {
  LlmCallInput,
  LlmCallResult,
} from '../../translation_graph/engine/batched_extraction';
import type {
  Adapter,
  RuntimeCapabilities,
} from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000030' as TeamId;

// ── Fake adapters ───────────────────────────────────────────────────────────

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
      return {
        adapterType,
        externalId: `ext-${adapterType}-${creates.length}`,
        data: {},
      };
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

function makeResolver(byType: Record<string, Adapter>) {
  return ({ adapterType }: { adapterType: string }) => {
    const adapter = byType[adapterType];
    if (!adapter) throw new Error(`test: no fake adapter for '${adapterType}'`);
    return adapter;
  };
}

function webhookEvent(payload: Record<string, unknown>): TriggerEvent {
  return {
    pipelineInputId: 'pi-value-binding-head',
    adapterType: 'email',
    triggerType: 'webhook',
    payload,
  };
}

// ── The LLM shim ────────────────────────────────────────────────────────────

const wrap = (value: unknown) => ({ evidence: 'q', value });

/** Answers under whatever key the call asked for, from the names the caller
 *  reads off the piece the call is about — a per-piece extraction mints its own
 *  call site, so the queue position says nothing useful. */
function perPieceLlm(names: (userMessage: string) => string[]): {
  calls: LlmCallInput[];
  client: { call(input: LlmCallInput): Promise<LlmCallResult> };
} {
  const calls: LlmCallInput[] = [];
  return {
    calls,
    client: {
      async call(input: LlmCallInput): Promise<LlmCallResult> {
        calls.push(input);
        const key = /one key — `([^`]+)`/.exec(input.system)?.[1];
        if (!key) throw new Error(`test: no answer key in the system prompt:\n${input.system}`);
        return {
          parsedJson: {
            [key]: [
              { company: names(input.userMessage).map((name) => ({ name: wrap(name) })) },
            ],
          },
        };
      },
    },
  };
}

// ── Catalog ─────────────────────────────────────────────────────────────────

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const attioSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' } },
  writableRoots: {
    company: {
      fields: { name: 'text' },
      resultShape: { externalId: 'text', name: 'text' },
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    email: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: emailSchema,
    },
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: attioSchema,
    },
  },
  credentials: {
    dealflow_inbox: { adapters: ['email'] },
    acme_main: { adapters: ['attio'] },
  },
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  '',
].join('\n');

function run(
  source: string,
  opts: {
    text?: string;
    llm?: { call(input: LlmCallInput): Promise<LlmCallResult> };
    attio: Adapter;
    languageVersion?: number;
  },
): Promise<Awaited<ReturnType<typeof runMovement>>> {
  return runMovement({
    ...(opts.languageVersion !== undefined ? { languageVersion: opts.languageVersion } : {}),
    source: PRELUDE + source,
    movementName: 'intake',
    event: webhookEvent({ subject: 'Deals', text: opts.text ?? '' }),
    teamId: TEAM_ID,
    catalog,
    resolveAdapter: makeResolver({
      email: makeFakeAdapter('email').adapter,
      attio: opts.attio,
    }),
    ...(opts.llm ? { llm: opts.llm } : {}),
  });
}

// ═════════════════════════════════════════════════════════════════════════════

const TWO_NODES = [
  'movement intake(msg: <inbox-[:message]->>) {',
  '  one = node { label: "A", tag: node { name: "A" } }',
  '  two = node { label: "B", tag: node { name: "B" } }',
  '  both = [one, two]',
  '',
].join('\n');

const WRITE_TAG = [
  '    write crm-[:companies]-> {',
  '      unique by (`name`)',
  '      name: t.name',
  '    }',
  '  }',
  '}',
].join('\n');

describe('a block head rooted at an expression', () => {
  it('a call picking one record out of a list walks that record', async () => {
    const attio = makeFakeAdapter('attio');

    await run(TWO_NODES + ['  AT(both, 1)-[t:tag]-> {', WRITE_TAG].join('\n'), {
      attio: attio.adapter,
    });

    expect(attio.creates.map((w) => w.fields.name)).toEqual(['B']);
  });

  it('writes exactly what binding it first writes — the two forms are one walk', async () => {
    const inline = makeFakeAdapter('attio');
    const bound = makeFakeAdapter('attio');

    await run(TWO_NODES + ['  AT(both, 1)-[t:tag]-> {', WRITE_TAG].join('\n'), {
      attio: inline.adapter,
    });
    await run(
      TWO_NODES + ['  first = AT(both, 1)', '  first-[t:tag]-> {', WRITE_TAG].join('\n'),
      { attio: bound.adapter },
    );

    expect(inline.creates).toEqual(bound.creates);
    expect(inline.creates.map((w) => w.fields.name)).toEqual(['B']);
  });

  it('a singleton fold over a list of records walks the one it picked', async () => {
    const attio = makeFakeAdapter('attio');

    await run(TWO_NODES + ['  ONLY([two])-[t:tag]-> {', WRITE_TAG].join('\n'), {
      attio: attio.adapter,
    });

    expect(attio.creates.map((w) => w.fields.name)).toEqual(['B']);
  });

  it('a record held in a map, read by its key', async () => {
    const attio = makeFakeAdapter('attio');

    await run(
      TWO_NODES +
        [
          '  held = KEYBY(both, (n) => { return n.label })',
          '  AT(held, "B")-[t:tag]-> {',
          WRITE_TAG,
        ].join('\n'),
      { attio: attio.adapter },
    );

    expect(attio.creates.map((w) => w.fields.name)).toEqual(['B']);
  });

  // Version 2 read a literal's slot as what its members share — a record of
  // no named position — so this walk was never checked against the second
  // record, and it runs zero times. Version 3 reads the slot exactly and
  // refuses the walk at save.
  it('a hop the root has not got runs the body zero times, like any empty traversal (version 2)', async () => {
    const attio = makeFakeAdapter('attio');

    await run(TWO_NODES + ['  AT(both, 1)-[t:missing]-> {', WRITE_TAG].join('\n'), {
      attio: attio.adapter,
      languageVersion: 2,
    });

    expect(attio.creates).toEqual([]);
  });

  it('a hop the slot has not got is refused before the run under version 3', async () => {
    const attio = makeFakeAdapter('attio');

    await expect(
      run(TWO_NODES + ['  AT(both, 1)-[t:missing]-> {', WRITE_TAG].join('\n'), { attio: attio.adapter }),
    ).rejects.toThrow('MOV_TRAVERSE_UNKNOWN_EDGE');
    expect(attio.creates).toEqual([]);
  });
});

describe('a deferred head with an expression root', () => {
  it('defers, and reads the same records the eager form reads', async () => {
    const lazyWrites = makeFakeAdapter('attio');
    const eagerWrites = makeFakeAdapter('attio');

    const LAZY = [
      '  d = node { tags: lazy AT(both, 1)-[t:tag]-> }',
      '  d-[t:tags]-> {',
      WRITE_TAG,
    ].join('\n');
    const EAGER = [
      '  d = node { tags: AT(both, 1)-[t:tag]-> }',
      '  d-[t:tags]-> {',
      WRITE_TAG,
    ].join('\n');

    await run(TWO_NODES + LAZY, { attio: lazyWrites.adapter });
    await run(TWO_NODES + EAGER, { attio: eagerWrites.adapter });

    expect(lazyWrites.creates.map((w) => w.fields.name)).toEqual(['B']);
    expect(lazyWrites.creates).toEqual(eagerWrites.creates);
  });
});
