// A node declaration reused as an extraction's shape, and a write body's
// spread, through the real engine: the prompt a declared node assembles must be
// the inline block's, and `...e` / `?...e` must write what the lines they stand
// for would.

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
// The TG-side parity run drives the PRODUCTION batcher, whose LlmClient
// wraps `anthropicChat` — the per-test responder is installed on this mock.
jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => '{}'),
  anthropicChatDetailed: jest.fn(async () => ({
    text: '{}',
    stopReason: 'end_turn',
    truncated: false,
  })),
  MAX_CHAT_CONTINUATIONS: 5,
}));

// A plugin that stored a document hands back the document's id; the invoker
// looks the stored object up. No database here — the lookup is answered from
// this table, which each test fills.
const storedDocuments = new Map<string, { id: string; description: string; objectUri: string }>();
jest.mock('../../document', () => ({
  DocumentService: {
    getById: jest.fn(async (id: string) => {
      const found = storedDocuments.get(id);
      if (!found) throw new Error(`Could not find document ${id}`);
      return found;
    }),
  },
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
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import type {
  Adapter,
  RuntimeCapabilities,
  ExternalRecordRef,
} from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as TeamId;


// ── Fake adapters (per run.unit.test.ts patterns) ───────────────────────────

function permissiveCaps(): RuntimeCapabilities {
  return {
    traversal: { incoming: true, edgeProperties: true },
    resources: true,
  };
}

interface RecordedWrite {
  recordType: string;
  externalId?: string;
  fields: Record<string, unknown>;
}

function makeFakeAdapter(
  adapterType: string,
  opts: {
    resolveCandidates?: (record: Record<string, unknown>) => ExternalRecordRef[];
    createResult?: (n: number) => { externalId: string; url?: string };
  } = {},
): { adapter: Adapter; creates: RecordedWrite[]; updates: RecordedWrite[] } {
  const creates: RecordedWrite[] = [];
  const updates: RecordedWrite[] = [];
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
    async resolveEntity({ record }) {
      return { candidates: opts.resolveCandidates?.(record) ?? [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      const result = opts.createResult?.(creates.length + 1) ?? {
        externalId: `ext-${adapterType}-${creates.length + 1}`,
      };
      creates.push({ recordType: input.recordType, fields: input.fields });
      return { adapterType, externalId: result.externalId, url: result.url, data: {} };
    },
    async updateRecord(input) {
      updates.push({
        recordType: input.recordType,
        externalId: input.externalId,
        fields: input.fields,
      });
      return { adapterType, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates, updates };
}

function makeResolver(byType: Record<string, Adapter>) {
  return ({ adapterType }: { adapterType: string }) => {
    const adapter = byType[adapterType];
    if (!adapter) throw new Error(`test: no fake adapter for '${adapterType}'`);
    return adapter;
  };
}

function webhookEvent(adapterType: string, payload: Record<string, unknown>): TriggerEvent {
  return {
    pipelineInputId: 'pi-movement-extraction',
    adapterType,
    triggerType: 'webhook',
    payload,
  };
}


/** A movement-engine LlmClient that records calls and answers from a
 *  queue of hand-written nested responses. */
function queuedMovementLlm(responses: unknown[]): {
  calls: LlmCallInput[];
  client: { call(input: LlmCallInput): Promise<LlmCallResult> };
} {
  const calls: LlmCallInput[] = [];
  return {
    calls,
    client: {
      async call(input: LlmCallInput): Promise<LlmCallResult> {
        calls.push(input);
        if (calls.length > responses.length) {
          throw new Error(`test: unexpected extraction call #${calls.length}:\n${input.system}`);
        }
        return { parsedJson: responses[calls.length - 1] };
      },
    },
  };
}

const wrap = (value: unknown) => ({ evidence: 'q', value });

// ── The movements under test ────────────────────────────────────────────────

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};
const attioSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text', stage: 'text', thesis: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' } },
  writableRoots: {
    company: {
      fields: { name: 'text', stage: 'text', thesis: 'text' },
      resultShape: { externalId: 'text', name: 'text', stage: 'text', thesis: 'text' },
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: attioSchema },
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
  'type Thesis = <"Consumer" | "Infra">',
  'rules = "route infra to Infra"',
].join('\n');

const ENTRY = [
  'node Entry: "each company pitched in this message" {',
  '  name: <text> "the company\'s name"',
  '  stage: <text> "the funding stage"',
  '  thesis: <Thesis> "the thesis it routes to. ${rules}"',
  '  node founder: "each founder named" { first: <text> "given names" }',
  '}',
].join('\n');

/** The same tree, spelled out inline — what `node entry: <Entry>` stands for. */
const INLINE_ENTRY = [
  '    node entry: "each company pitched in this message" {',
  '      name: <text> "the company\'s name"',
  '      stage: <text> "the funding stage"',
  '      thesis: <Thesis> "the thesis it routes to. ${rules}"',
  '      node founder: "each founder named" { first: <text> "given names" }',
  '    }',
];

function movement(declarations: string, tree: string[], after: string[] = []): string {
  return [
    PRELUDE,
    declarations,
    'movement m(msg: <inbox-[:message]->>) {',
    '  found = extract from [msg.`text`] {',
    ...tree,
    '  }',
    ...after,
    '}',
  ].join('\n');
}

const REPLY = {
  'x:extract_result#1': [
    {
      entry: [
        {
          name: wrap('Acme'),
          stage: wrap('Seed'),
          thesis: wrap('Infra'),
          founder: [{ first: wrap('Ada') }],
        },
      ],
    },
  ],
};

async function run(
  source: string,
  {
    attio = makeFakeAdapter('attio'),
    movementName,
    reply = REPLY,
  }: { attio?: ReturnType<typeof makeFakeAdapter>; movementName?: string; reply?: unknown } = {},
) {
  const llm = queuedMovementLlm([reply]);
  const writes: CapturedWrite[] = [];
  await runMovement({
    source,
    event: webhookEvent('email', { subject: 'Deals', text: 'Acme (Ada) is raising a Seed.' }),
    teamId: TEAM_ID,
    catalog,
    resolveAdapter: makeResolver({ email: makeFakeAdapter('email').adapter, attio: attio.adapter }),
    ...(movementName !== undefined ? { movementName } : {}),
    llm: llm.client,
    dryRun: true,
    writeSink: (w) => writes.push(w),
  });
  return { calls: llm.calls, writes };
}

// ═════════════════════════════════════════════════════════════════════════════

describe('an extraction node that takes a declaration as its shape', () => {
  it('assembles the SAME prompt as the inline block the declaration spells out', async () => {
    const declared = await run(movement(ENTRY, ['    node entry: <Entry>']));
    const inline = await run(movement('', INLINE_ENTRY));
    expect(declared.calls).toHaveLength(1);
    expect(declared.calls[0].system).toEqual(inline.calls[0].system);
    expect(declared.calls[0].userMessage).toEqual(inline.calls[0].userMessage);
    // The declaration's words reached the model — interpolation included — and
    // its refinement constrained the field.
    expect(declared.calls[0].system).toContain('each company pitched in this message');
    expect(declared.calls[0].system).toContain('the thesis it routes to. route infra to Infra');
    expect(declared.calls[0].system).toContain('`thesis` (enum: Consumer | Infra)');
    expect(declared.calls[0].system).toContain('each founder named');
  });

  it('a use-site description replaces the declaration\'s record-level one', async () => {
    const declared = await run(movement(ENTRY, ['    node entry: <Entry> "each deal, one per company"']));
    expect(declared.calls[0].system).toContain('each deal, one per company');
    expect(declared.calls[0].system).not.toContain('each company pitched in this message');
    // Its fields' words are untouched.
    expect(declared.calls[0].system).toContain("the company's name");
  });

  it('extracts an undescribed field by its name alone', async () => {
    const bare = ['node Entry: "each company" {', '  name: <text>', '}'].join('\n');
    const { calls } = await run(movement(bare, ['    node entry: <Entry>']));
    expect(calls[0].system).toMatch(/^ {4}- `name` \(text\)$/m);
  });

  it('walks records of the declared structure, nested nodes included', async () => {
    const { writes } = await run(
      movement(ENTRY, ['    node entry: <Entry>'], [
        '  found-[e:entry]-> {',
        '    e-[f:founder]-> {',
        '      write crm-[:companies]-> { name: COALESCE(f.first, "?"), stage ?: e.stage }',
        '    }',
        '  }',
      ]),
    );
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'create', fields: { name: 'Ada', stage: 'Seed' } }),
    ]);
  });
});

describe('presence on a declared shape — exactly as on the inline block', () => {
  /** The model found the name, and neither the stage (text) nor the thesis
   *  (a refinement). */
  const SPARSE = {
    'x:extract_result#1': [{ entry: [{ name: wrap('Acme'), stage: null, thesis: null, founder: [] }] }],
  };
  const both = async (after: string[]) => {
    const declared = await run(movement(ENTRY, ['    node entry: <Entry>'], after), { reply: SPARSE });
    const inline = await run(movement('', INLINE_ENTRY, after), { reply: SPARSE });
    expect(declared.writes).toEqual(inline.writes);
    return declared.writes;
  };

  it('hands a text nobody found over as "" — a plain write and an interpolation take it', async () => {
    const writes = await both([
      '  found-[e:entry]-> {',
      '    write crm-[:companies]-> { name: e.name, stage: e.stage, thesis ?: "(${e.stage})" }',
      '  }',
    ]);
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'create', fields: { name: 'Acme', stage: '', thesis: '()' } }),
    ]);
  });

  it('keeps a typed field nobody found absent — a guard on it skips its arm', async () => {
    const writes = await both([
      '  found-[e:entry]-> {',
      '    if EXISTS(e.thesis) { write crm-[:companies]-> { name: e.name, thesis: e.thesis } }',
      '    write crm-[:companies]-> { name: "after", thesis ?: e.thesis }',
      '  }',
    ]);
    // Absent (null to a fill), never "" — the guarded write never ran.
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'create', fields: { name: 'after', thesis: null } }),
    ]);
  });
});

describe('a guard on a typed field of a declared shape', () => {
  it('narrows it present in the arm, so a plain write of it saves and runs', async () => {
    const { writes } = await run(
      movement(ENTRY, ['    node entry: <Entry>'], [
        '  found-[e:entry]-> {',
        '    if EXISTS(e.thesis) { write crm-[:companies]-> { name: e.name, thesis: e.thesis } }',
        '  }',
      ]),
    );
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'create', fields: { name: 'Acme', thesis: 'Infra' } }),
    ]);
  });
});

describe('a spread in a write body', () => {
  const spreading = (body: string) =>
    movement(ENTRY, ['    node entry: <Entry>'], [
      '  found-[e:entry]-> {',
      `    write crm-[:companies]-> { ${body} }`,
      '  }',
    ]);

  it('`?...e` writes every FIELD of the record — never its nested nodes', async () => {
    const { writes } = await run(spreading('unique by (name), ?...e'));
    expect(writes).toEqual([
      expect.objectContaining({
        kind: 'create',
        fields: { name: 'Acme', stage: 'Seed', thesis: 'Infra' },
      }),
    ]);
  });

  it('an explicit line wins over the spread for its field', async () => {
    const { writes } = await run(spreading('stage: "Series A", ?...e'));
    expect(writes).toEqual([
      expect.objectContaining({ fields: { stage: 'Series A', name: 'Acme', thesis: 'Infra' } }),
    ]);
  });

  it('`?...e` is set-if-empty: a matched record keeps the values it has', async () => {
    const attio = makeFakeAdapter('attio', {
      resolveCandidates: () => [{ adapterType: 'attio', externalId: 'existing-1', data: {} }],
    });
    attio.adapter.readRecord = async () => ({ name: 'Acme', stage: 'Series B', thesis: null });
    const { writes } = await run(spreading('unique by (name), ?...e'), { attio });
    // `stage` is already set, so the fill leaves it; `thesis` is empty and fills.
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'update', externalId: 'existing-1', fields: { thesis: 'Infra' } }),
    ]);
  });
});

describe('an IMPORTED declaration', () => {
  it("reads its words in its library's scope, not the importer's", async () => {
    const library = [
      'lens = "route by the library\'s lens"',
      'export node Entry: "each company pitched" {',
      '  name: <text> "the name, ${lens}"',
      '}',
    ].join('\n');
    const source = [
      PRELUDE,
      'import { Entry } from "lib/entries"',
      // The importer binds the same name — the library's must still win.
      'lens = "the importer\'s lens"',
      'movement m(msg: <inbox-[:message]->>) {',
      '  found = extract from [msg.`text`] {',
      '    node entry: <Entry>',
      '  }',
      '}',
    ].join('\n');
    const llm = queuedMovementLlm([{ 'x:extract_result#1': [{ entry: [] }] }]);
    await runMovement({
      source,
      event: webhookEvent('email', { subject: 'Deals', text: 'Acme is raising.' }),
      teamId: TEAM_ID,
      catalog,
      resolveFile: (path) => (path === 'lib/entries' ? { source: library } : undefined),
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
      }),
      llm: llm.client,
      dryRun: true,
    });
    expect(llm.calls[0].system).toContain("the name, route by the library's lens");
    expect(llm.calls[0].system).not.toContain("the importer's lens");
  });

  /** Runs `node entry: <Entry>` imported from a library that declares it
   *  (and its refinement) as `library`; the importer adds `importerLines`. */
  async function extractImported(library: string, importerLines: string[] = []) {
    const source = [
      PRELUDE,
      'import { Entry } from "lib/entries"',
      ...importerLines,
      'movement m(msg: <inbox-[:message]->>) {',
      '  found = extract from [msg.`text`] {',
      '    node entry: <Entry>',
      '  }',
      '}',
    ].join('\n');
    const llm = queuedMovementLlm([{ 'x:extract_result#1': [{ entry: [] }] }]);
    await runMovement({
      source,
      event: webhookEvent('email', { subject: 'Deals', text: 'Acme is raising.' }),
      teamId: TEAM_ID,
      catalog,
      resolveFile: (path) => (path === 'lib/entries' ? { source: library } : undefined),
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
      }),
      llm: llm.client,
      dryRun: true,
    });
    return llm.calls[0].system;
  }

  it("constrains a field by a refinement only its library declares", async () => {
    const system = await extractImported(
      [
        'type Verdict = <"Keep" | "Drop">',
        'export node Entry: "each company pitched" {',
        '  verdict: <Verdict> "whether to keep it"',
        '}',
      ].join('\n'),
    );
    expect(system).toContain('`verdict` (enum: Keep | Drop)');
  });

  it("resolves a refinement the importer also names to the library's", async () => {
    // PRELUDE declares `Thesis` as Consumer | Infra — the library's own wins.
    const system = await extractImported(
      [
        'type Thesis = <"Fintech" | "Health">',
        'export node Entry: "each company pitched" {',
        '  thesis: <Thesis> "the thesis"',
        '}',
      ].join('\n'),
    );
    expect(system).toContain('`thesis` (enum: Fintech | Health)');
    expect(system).not.toContain('Consumer');
  });

  it('an IMPORTED function extracts with its own file\'s refinements, inline and declared', async () => {
    const library = [
      PRELUDE,
      'type Verdict = <"Keep" | "Drop">',
      'node Local: "each company" { verdict: <Verdict> "keep or drop it" }',
      'export node Note { body: <text> }',
      'export function triage(n: <Note>) {',
      '  found = extract from [n.body] {',
      '    overall: <Verdict> "the batch as a whole"',
      '    node entry: <Local>',
      '  }',
      '}',
    ].join('\n');
    const source = [
      PRELUDE,
      'import { triage } from "lib/triage"',
      'movement m(msg: <inbox-[:message]->>) {',
      '  triage(n: node { body: msg.`text` })',
      '}',
    ].join('\n');
    const llm = queuedMovementLlm([{ 'x:extract_result#1': [{ entry: [] }] }]);
    await runMovement({
      source,
      event: webhookEvent('email', { subject: 'Deals', text: 'Acme is raising.' }),
      teamId: TEAM_ID,
      catalog,
      resolveFile: (path) => (path === 'lib/triage' ? { source: library } : undefined),
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
      }),
      llm: llm.client,
      dryRun: true,
    });
    expect(llm.calls[0].system).toContain('`overall` (enum: Keep | Drop)');
    expect(llm.calls[0].system).toContain('`verdict` (enum: Keep | Drop)');
  });
});

describe('a spread of a declared structure, or of a record built in memory', () => {
  const DEAL = ['node Deal {', '  name:  <text>', '  stage: <text>', '}'].join('\n');
  const RECORD_DEAL = ['function record_deal(d: <Deal>) {', '  write crm-[:companies]-> { ...d }', '}'];

  it('writes the DECLARED fields of a `<Deal>` parameter — not whatever else the value carries', async () => {
    // The record handed over also carries `thesis`; `Deal` does not declare it.
    const source = movement([ENTRY, DEAL, ...RECORD_DEAL].join('\n'), ['    node entry: <Entry>'], [
      '  found-[e:entry]-> {',
      '    n = node { name: COALESCE(e.name, "?"), stage: COALESCE(e.stage, "?"), thesis: COALESCE(e.thesis, "?") }',
      '    record_deal(d: n)',
      '  }',
    ]);
    const { writes } = await run(source, { movementName: 'm' });
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'create', fields: { name: 'Acme', stage: 'Seed' } }),
    ]);
  });

  it('writes every field of a `node { … }` literal, and none of its edges', async () => {
    const source = movement(ENTRY, ['    node entry: <Entry>'], [
      '  found-[e:entry]-> {',
      '    n = node { name: COALESCE(e.name, "?"), stage: "Seed", founder: node { name: "Ada" } }',
      '    write crm-[:companies]-> { ...n }',
      '  }',
    ]);
    const { writes } = await run(source);
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'create', fields: { name: 'Acme', stage: 'Seed' } }),
    ]);
  });

  it('spreads inside an IMPORTED callee — the library was checked, so its spread was resolved', async () => {
    const library = [
      PRELUDE,
      'export node Deal {',
      '  name:  <text>',
      '  stage: <text>',
      '}',
      'export function record_deal(d: <Deal>) {',
      '  write crm-[:companies]-> { ...d }',
      '}',
    ].join('\n');
    const source = [
      PRELUDE,
      'import { record_deal } from "lib/deals"',
      'movement m(msg: <inbox-[:message]->>) {',
      '  record_deal(d: node { name: msg.`subject`, stage: "Seed" })',
      '}',
    ].join('\n');
    const writes: CapturedWrite[] = [];
    await runMovement({
      source,
      event: webhookEvent('email', { subject: 'Acme', text: '' }),
      teamId: TEAM_ID,
      catalog,
      resolveFile: (path) => (path === 'lib/deals' ? { source: library } : undefined),
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
      }),
      llm: queuedMovementLlm([]).client,
      dryRun: true,
      writeSink: (w) => writes.push(w),
    });
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'create', fields: { name: 'Acme', stage: 'Seed' } }),
    ]);
  });
});

describe('`<text | null>` — a text nobody found arrives null', () => {
  const NULLABLE_ENTRY = ENTRY.replace('stage: <text> "the funding stage"', 'stage: <text | null> "the funding stage"');
  const NULLABLE_INLINE = INLINE_ENTRY.map((line) =>
    line.replace('stage: <text> "the funding stage"', 'stage: <text | null> "the funding stage"'),
  );
  /** Neither the name (`<text>`) nor the stage (`<text | null>`) was found. */
  const BLANK = {
    'x:extract_result#1': [{ entry: [{ name: null, stage: null, thesis: wrap('Infra'), founder: [] }] }],
  };
  /** The stage is null, the name "", in the same record; a found stage is its text. */
  const AFTER = [
    '  found-[e:entry]-> {',
    '    write crm-[:companies]-> { name: e.name, thesis ?: e.thesis, stage ?: e.stage }',
    '    if e.stage == null { write crm-[:companies]-> { name: "no stage", thesis: e.name } }',
    '  }',
  ];

  it('while `<text>` in the same extraction arrives "" — inline and declared alike', async () => {
    for (const source of [
      movement('', NULLABLE_INLINE, AFTER),
      movement(NULLABLE_ENTRY, ['    node entry: <Entry>'], AFTER),
    ]) {
      const { writes } = await run(source, { reply: BLANK });
      expect(writes).toEqual([
        expect.objectContaining({ kind: 'create', fields: { name: '', thesis: 'Infra', stage: null } }),
        expect.objectContaining({ kind: 'create', fields: { name: 'no stage', thesis: '' } }),
      ]);
    }
  });

  it('a found value is the text', async () => {
    const { writes } = await run(movement(NULLABLE_ENTRY, ['    node entry: <Entry>'], AFTER));
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'create', fields: { name: 'Acme', thesis: 'Infra', stage: 'Seed' } }),
    ]);
  });

  it("a collecting node's entry holds an unfound one absent, so `!= null` is a real test", async () => {
    // The Project A shape: extracted records merged into a collecting node
    // typed by the declaration, then read back off its entries.
    const COLLECT = [
      '  deduped = node { entries: <Entry> order by arrival }',
      '  found-[e:entry]-> { write deduped-[:entries]-> { unique by (name), ?...e } }',
      '  deduped-[x:entries]-> {',
      '    if x.stage != null {',
      '      write crm-[:companies]-> { name: x.name, stage: x.stage }',
      '    } else {',
      '      write crm-[:companies]-> { name: x.name, thesis: "no stage" }',
      '    }',
      '  }',
    ];
    const source = movement(NULLABLE_ENTRY, ['    node entry: <Entry>'], COLLECT);
    const unfound = {
      'x:extract_result#1': [{ entry: [{ name: wrap('Acme'), stage: null, thesis: wrap('Infra'), founder: [] }] }],
    };
    expect((await run(source, { reply: unfound })).writes).toEqual([
      expect.objectContaining({ kind: 'create', fields: { name: 'Acme', thesis: 'no stage' } }),
    ]);
    expect((await run(source)).writes).toEqual([
      expect.objectContaining({ kind: 'create', fields: { name: 'Acme', stage: 'Seed' } }),
    ]);
  });

  it('the model is asked exactly what `<text>` asks', async () => {
    const plain = await run(movement(ENTRY, ['    node entry: <Entry>']));
    const nullable = await run(movement(NULLABLE_ENTRY, ['    node entry: <Entry>']));
    expect(nullable.calls[0].system).toEqual(plain.calls[0].system);
    expect(nullable.calls[0].userMessage).toEqual(plain.calls[0].userMessage);
    const inline = await run(movement('', NULLABLE_INLINE));
    expect(inline.calls[0].system).toEqual(plain.calls[0].system);
  });
});

describe('`node X extends Y` as an extraction shape', () => {
  /** Entry, with one field the first prompt must not see. */
  const RECAP = [
    ENTRY,
    'node `Recap Entry` extends Entry {',
    '  diverse_founder: <text | null> "whether a founder is from an under-represented group"',
    '}',
  ].join('\n');
  /** The same tree as one declaration — what `extends` stands for. */
  const RECAP_FLAT = [
    'node `Recap Entry`: "each company pitched in this message" {',
    '  name: <text> "the company\'s name"',
    '  stage: <text> "the funding stage"',
    '  thesis: <Thesis> "the thesis it routes to. ${rules}"',
    '  node founder: "each founder named" { first: <text> "given names" }',
    '  diverse_founder: <text | null> "whether a founder is from an under-represented group"',
    '}',
  ].join('\n');

  it('assembles the SAME prompt as the flattened declaration', async () => {
    const inherited = await run(movement(RECAP, ['    node entry: <`Recap Entry`>']));
    const flat = await run(movement(RECAP_FLAT, ['    node entry: <`Recap Entry`>']));
    expect(inherited.calls).toHaveLength(1);
    expect(inherited.calls[0].system).toEqual(flat.calls[0].system);
    expect(inherited.calls[0].userMessage).toEqual(flat.calls[0].userMessage);
    // Y's words — interpolation and refinement included — reached the model,
    // and so did X's own field.
    expect(inherited.calls[0].system).toContain('each company pitched in this message');
    expect(inherited.calls[0].system).toContain('the thesis it routes to. route infra to Infra');
    expect(inherited.calls[0].system).toContain('`thesis` (enum: Consumer | Infra)');
    expect(inherited.calls[0].system).toContain('under-represented group');
    // …while the base alone still asks nothing about it.
    const base = await run(movement(RECAP, ['    node entry: <Entry>']));
    expect(base.calls[0].system).not.toContain('under-represented group');
  });

  it("walks records carrying the base's fields and nested nodes", async () => {
    const { writes } = await run(
      movement(RECAP, ['    node entry: <`Recap Entry`>'], [
        '  found-[e:entry]-> {',
        '    e-[f:founder]-> {',
        '      write crm-[:companies]-> { name: COALESCE(f.first, "?"), stage ?: e.stage }',
        '    }',
        '  }',
      ]),
    );
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'create', fields: { name: 'Ada', stage: 'Seed' } }),
    ]);
  });

  /** `node entry: <Recap>`, with `library` at lib/entries and the importer's
   *  own declarations. */
  async function extractFrom(library: string, importerLines: string[]) {
    const source = [
      PRELUDE,
      ...importerLines,
      'movement m(msg: <inbox-[:message]->>) {',
      '  found = extract from [msg.`text`] {',
      '    node entry: <Recap>',
      '  }',
      '}',
    ].join('\n');
    const llm = queuedMovementLlm([{ 'x:extract_result#1': [{ entry: [] }] }]);
    await runMovement({
      source,
      event: webhookEvent('email', { subject: 'Deals', text: 'Acme is raising.' }),
      teamId: TEAM_ID,
      catalog,
      resolveFile: (path) => (path === 'lib/entries' ? { source: library } : undefined),
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
      }),
      llm: llm.client,
      dryRun: true,
    });
    return llm.calls[0].system;
  }

  const LIBRARY = [
    'lens = "the library\'s lens"',
    'type Verdict = <"Keep" | "Drop">',
    'export node Entry: "each company, by ${lens}" {',
    '  name: <text> "the name, by ${lens}"',
    '  verdict: <Verdict> "whether to keep it"',
    '}',
  ].join('\n');

  it("reads an IMPORTED base's words and types in ITS file, and X's own in X's", async () => {
    const system = await extractFrom(LIBRARY, [
      'import { Entry } from "lib/entries"',
      'lens = "the importer\'s lens"',
      'node Recap extends Entry { note: <text> "a note, by ${lens}" }',
    ]);
    expect(system).toContain("each company, by the library's lens");
    expect(system).toContain("the name, by the library's lens");
    expect(system).toContain('`verdict` (enum: Keep | Drop)');
    expect(system).toContain("a note, by the importer's lens");
    expect(system).not.toContain("the name, by the importer's lens");
  });

  it('hands an extracted X record to a callee typed on the base, which writes it', async () => {
    const { writes } = await run(
      [
        PRELUDE,
        RECAP,
        'function record_entry(d: <Entry>) {',
        '  write crm-[:companies]-> { name: d.name, stage: d.stage }',
        '}',
        'movement m(msg: <inbox-[:message]->>) {',
        '  found = extract from [msg.`text`] {',
        '    node entry: <`Recap Entry`>',
        '  }',
        '  found-[e:entry]-> { record_entry(d: e) }',
        '}',
      ].join('\n'),
      { movementName: 'm' },
    );
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'create', fields: { name: 'Acme', stage: 'Seed' } }),
    ]);
  });

  it('extracts an imported X whose base its library keeps private', async () => {
    const library = [
      'lens = "the library\'s lens"',
      'node Base: "each company" { name: <text> "the name, by ${lens}" }',
      'export node Recap extends Base { note: <text> "a note" }',
    ].join('\n');
    const system = await extractFrom(library, ['import { Recap } from "lib/entries"']);
    expect(system).toContain("the name, by the library's lens");
    expect(system).toContain('a note');
  });
});
