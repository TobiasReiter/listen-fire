// A block head rooted at a VALUE that holds positions.
//
// `found = MAP(pieces, (p) => { return extract … })` is the handbook's
// per-piece reading: a collection op hands each answer back in the currency it
// arrived in, so `found` is a list of extraction ROOTS sitting on the value
// plane. Walking it — `found-[c:company]-> { … }` — is that hop off each root,
// concatenated in list order, which is what a list of anything means everywhere
// else in the language and what a block's returned records already do.
//
// A list LITERAL is that same list written by hand: `both = [one, two]` holds
// the two records themselves, so the same head walks it, in list order. That
// reading belongs to the literal and nowhere else — `"${one}"` still refuses to
// interpolate a record.
//
// What is pinned here: the documented shape runs; the landings come back in
// piece order; one position held on the value plane behaves as the position; a
// literal of records walks exactly as a collection op's answer does; and a
// member that is not a position fails naming what it is, rather than walking
// nothing.

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
  },
): Promise<Awaited<ReturnType<typeof runMovement>>> {
  return runMovement({
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

const PER_PIECE_EXTRACT = [
  'movement intake(msg: <inbox-[:message]->>) {',
  '  pieces = CHUNKS(msg.`text`, { size: 20 })',
  '  found = MAP(pieces, (p) => {',
  '    return extract from [p] {',
  '      node company: "each company named" {',
  '        name: "the company\'s name"',
  '      }',
  '    }',
  '  })',
  '',
].join('\n');

/** The pieces `CHUNKS(…, { size: 20 })` cuts this into, one company per piece. */
const THREE_PIECES = 'Acme raised a seed.\nGlobex raised an A.\nInitech raised a B.';

/** Which company the call in front of us is asking about. */
const namesInPiece = (userMessage: string): string[] =>
  ['Acme', 'Globex', 'Initech'].filter((name) => userMessage.includes(name));

describe('a block head rooted at a value holding extraction roots', () => {
  it('walks every piece\'s companies, in piece order (the handbook\'s chunked rehearsal)', async () => {
    const attio = makeFakeAdapter('attio');
    const llm = perPieceLlm(namesInPiece);

    await run(
      PER_PIECE_EXTRACT +
        [
          '  found-[c:company]-> {',
          '    write crm-[:companies]-> {',
          '      unique by (`name`)',
          '      name: c.name',
          '    }',
          '  }',
          '}',
        ].join('\n'),
      { text: THREE_PIECES, llm: llm.client, attio: attio.adapter },
    );

    // One extraction per piece — the MAP's whole point.
    expect(llm.calls).toHaveLength(3);
    expect(attio.creates.map((w) => w.fields.name)).toEqual(['Acme', 'Globex', 'Initech']);
  });

  it('a single root held on the value plane walks as that root', async () => {
    const attio = makeFakeAdapter('attio');
    const llm = perPieceLlm(namesInPiece);

    await run(
      PER_PIECE_EXTRACT +
        [
          '  one = AT(found, 1)',
          '  one-[c:company]-> {',
          '    write crm-[:companies]-> {',
          '      unique by (`name`)',
          '      name: c.name',
          '    }',
          '  }',
          '}',
        ].join('\n'),
      { text: THREE_PIECES, llm: llm.client, attio: attio.adapter },
    );

    expect(attio.creates.map((w) => w.fields.name)).toEqual(['Globex']);
  });

  it('a member that is not a position is refused where it is WRITTEN, naming both', async () => {
    const attio = makeFakeAdapter('attio');
    const llm = perPieceLlm(namesInPiece);

    await expect(
      run(
        PER_PIECE_EXTRACT +
          [
            '  mixed = [AT(found, 0), msg.`text`]',
            '  mixed-[c:company]-> {',
            '    write crm-[:companies]-> {',
            '      unique by (`name`)',
            '      name: c.name',
            '    }',
            '  }',
            '}',
          ].join('\n'),
        { text: THREE_PIECES, llm: llm.client, attio: attio.adapter },
      ),
    ).rejects.toThrow(/a list holds one kind of thing/);
  });
});

describe('a block head rooted at a value holding synthesised nodes', () => {
  it('walks a declared edge off each node literal in the list', async () => {
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  one = node { label: "A", tag: node { name: "A" } }',
        '  two = node { label: "B", tag: node { name: "B" } }',
        '  both = [one, two]',
        '  both-[t:tag]-> {',
        '    write crm-[:companies]-> {',
        '      unique by (`name`)',
        '      name: t.name',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      { attio: attio.adapter },
    );

    expect(attio.creates.map((w) => w.fields.name)).toEqual(['A', 'B']);
  });

  it('a collection op building the same list walks the same way', async () => {
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  both = MAP(["A", "B"], (n) => {',
        '    return node { label: n, tag: node { name: n } }',
        '  })',
        '  both-[t:tag]-> {',
        '    write crm-[:companies]-> {',
        '      unique by (`name`)',
        '      name: t.name',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      { attio: attio.adapter },
    );

    expect(attio.creates.map((w) => w.fields.name)).toEqual(['A', 'B']);
  });

  it('a member that is text is refused where the list is written, naming both', async () => {
    const attio = makeFakeAdapter('attio');

    await expect(
      run(
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  one = node { label: "A", tag: node { name: "A" } }',
          '  both = [one, msg.`subject`]',
          '  both-[t:tag]-> {',
          '    write crm-[:companies]-> {',
          '      unique by (`name`)',
          '      name: t.name',
          '    }',
          '  }',
          '}',
        ].join('\n'),
        { attio: attio.adapter },
      ),
    ).rejects.toThrow(/a list holds one kind of thing/);
  });

  it('interpolating one of them is refused where it is written, naming the record', async () => {
    const attio = makeFakeAdapter('attio');

    await expect(
      run(
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  one = node { label: "A" }',
          '  t = "${one}"',
          '  write crm-[:companies]-> {',
          '    unique by (`name`)',
          '    name: t',
          '  }',
          '}',
        ].join('\n'),
        { attio: attio.adapter },
      ),
    ).rejects.toThrow(/a node is a record, not a value/);
  });
});

describe('a list literal of extraction roots', () => {
  it('walks both roots, in list order', async () => {
    const attio = makeFakeAdapter('attio');
    const llm = perPieceLlm(namesInPiece);

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  first = extract from [msg.`text`] {',
        '    node company: "each company named" {',
        '      name: "the company\'s name"',
        '    }',
        '  }',
        '  second = extract from ["Globex raised an A."] {',
        '    node company: "each company named" {',
        '      name: "the company\'s name"',
        '    }',
        '  }',
        '  both = [first, second]',
        '  both-[c:company]-> {',
        '    write crm-[:companies]-> {',
        '      unique by (`name`)',
        '      name: c.name',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      { text: 'Acme raised a seed.', llm: llm.client, attio: attio.adapter },
    );

    expect(attio.creates.map((w) => w.fields.name)).toEqual(['Acme', 'Globex']);
  });
});
