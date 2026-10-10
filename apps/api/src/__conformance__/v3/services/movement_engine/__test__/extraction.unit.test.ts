// E2 — extraction + traversal blocks + meta-nodes in the movement engine.
//
//   1. A stage-0 (`through`-free) log_dealflow-like fixture run
//      through BOTH `runMovement` (one planned LLM call, mocked client)
//      AND the frozen compile + TG-engine path (per-site LLM calls,
//      mocked anthropic): identical captured writes. The response
//      formats differ by design (the movement planner batches the whole
//      tree into ONE nested call; the TG engine fires one flat call per
//      `#extract` site), so each engine gets a shim rendering the SAME
//      canned semantic data in its own format and parity is asserted on
//      the writes.
//   2. BEYOND-TG — a `through`-staged fixture the frozen compiler
//      rejects: phase plan (call count + per-call tree contents), the
//      plugin fed by a working field, the enriched context reaching the
//      deeper node, and working-field invisibility.
//   3. Enum options from an explicit BORROWED annotation
//      (`stage: crm.company.stage "…"`) reach the LLM request (entity
//      guide + response validation) — and an UNannotated field does NOT
//      pick the options up silently (adoption is demoted).
//   4. Block meta-node aggregates (`COUNT(orgs-[:co]->)`,
//      `FIRST(orgs-[:co]->).`url``) end-to-end.
//   5. Per-position isolation — each block iteration binds its own
//      handles; values never leak across iterations.

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

import {
  mockCatalog,
  type ExtractExpression,
  type InstanceSchema,
  type Span,
} from 'movement-lang';
import { anthropicChatDetailed } from '../../../lib/anthropic';
import { LlmUsageContext } from '../../../lib/llm_usage';
import { MovementRunFailed, runFailureCause, runMovement } from '../run';
import { MovementEngineError, type MovementTraceEntry } from '../expression';
import { logger } from '../../logger';
import {
  ROOT_EXTRACT_DESCRIPTION,
  STAGE_FAN_OUT,
  buildExtractSpec,
  makeAnthropicLlmClient,
  materializeExtract,
  registryTransformInvoker,
  type MovementTransformInvoker,
} from '../extraction';
import { NO_PROVENANCE } from '../provenance';
import {
  getTransform,
  registerTransform,
  type TransformImpl,
  type TransformInput,
} from '../../translation_graph/engine/transforms/registry';
import { registerBundledTransforms } from '../../translation_graph/engine/transforms/register-bundled';
import { DOCUMENT_STORE_OWNER } from '../../translation_graph/engine/files/document_store';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
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
import type { MutationContext } from '../../translation_graph/mutation_context';
import { positionData } from '../../translation_graph/types';
import { candidateIsAllExact } from '../../translation_graph/uniqueness';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as TeamId;

/** A description as the parser hands it over: the quoted literal, so the
 *  engine desugars it through the same bridge a written movement uses. */
function desc(text: string, at: Span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } }) {
  return { raw: JSON.stringify(text), span: at };
}

/** A cancel gate a test can stamp mid-run, standing in for the DB-backed one. */
function makeTestCancelGate() {
  let stamped = false;
  return {
    stamp() {
      stamped = true;
    },
    async cancelled(): Promise<boolean> {
      return stamped;
    },
    async cancelledNow(): Promise<boolean> {
      return stamped;
    },
    reason(): string | null {
      return stamped ? 'Cancelled by an operator' : null;
    },
  };
}

/** Wire a gate the way a real firing does: onto the interpreter (statement
 *  boundaries) AND onto the ambient LlmUsageContext, which is where the
 *  extraction's own in-statement boundaries read it from. */
function runCancellable<T>(
  cancelGate: ReturnType<typeof makeTestCancelGate>,
  fn: () => Promise<T>,
): Promise<T> {
  return new LlmUsageContext({ teamId: TEAM_ID as unknown as string, cancelGate }).runAsync(fn);
}

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

// ── LLM shims ────────────────────────────────────────────────────────────────
//
// Canned SEMANTIC data is keyed by the authors' descriptions (the one
// cross-engine-stable currency); each engine's shim renders it in that
// engine's response format.

/** Canned emissions per `#extract`-site description; each emission maps
 *  field DESCRIPTIONS to values. */
type CannedSites = Record<string, Array<Record<string, unknown>>>;

/**
 * TG-engine responder: the production batcher fires one FLAT call per
 * site, with the entity guide carrying `**siteId**: description` and
 * field lines `- \`sanitized_name\` (kind): description`. Parse the
 * single site + its fields out of the system prompt and answer from
 * the canned data, `{ evidence, value }`-wrapped.
 */
function tgResponder(canned: CannedSites): (input: { system: string }) => Promise<string> {
  return async ({ system }) => {
    const site = /\*\*([^*]+)\*\*: ([\s\S]*?) \(emit each matching entity/.exec(system);
    if (!site) throw new Error(`test: no extract site in TG system prompt:\n${system}`);
    const [, siteId, description] = site;
    const emissions = canned[description];
    if (!emissions) throw new Error(`test: no canned data for site description '${description}'`);
    const fields = [...system.matchAll(/^\s+- `([^`]+)` \([^)]*\): (.*)$/gm)].map((m) => ({
      name: m[1],
      description: m[2],
    }));
    const entities = emissions.map((emission) =>
      Object.fromEntries(
        fields.map((f) => [f.name, { evidence: 'q', value: emission[f.description] ?? null }]),
      ),
    );
    return JSON.stringify({ [siteId]: entities });
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

/** A client that answers under whatever key the call ASKED for, rather than
 *  the next key in a queue. A fan-out mints its call sites as its branches
 *  reach them, so which sibling holds which site id is not the test's
 *  business — what it answers about is. */
function keyedMovementLlm(reply: (input: LlmCallInput) => unknown[]): {
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
        return { parsedJson: { [key]: reply(input) } };
      },
    },
  };
}

/** A promise the test releases by hand — how a fake plugin is held open long
 *  enough for a sibling's invocation to be observed alongside it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every already-scheduled continuation run. Enough passes that a fan's
 *  branches all reach their first real await. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** The entity a per-entity call is asking about — the `CURRENT ENTITY` block
 *  quotes its extracted name. Absent for a first-stage call, which is asking
 *  about the source text and no entity in particular. */
function askedAbout(input: LlmCallInput, names: string[]): string | undefined {
  if (!input.userMessage.includes('## CURRENT ENTITY')) return undefined;
  return names.find((name) => input.userMessage.includes(`"${name}"`));
}

const wrap = (value: unknown) => ({ evidence: 'q', value });

// ── Catalogs ────────────────────────────────────────────────────────────────

// The stage-0 fixture uses the REAL static catalog (manifests + thin
// schemas).
const parityCatalog = staticCatalogFromManifests({
  credentials: {
    dealflow_inbox: { adapters: ['email'] },
    acme_main: { adapters: ['attio'] },
    acme_workspace: { adapters: ['slack'] },
  },
});

// The movement-engine-only fixtures use a fully-controlled mock catalog
// (enum-typed targets, a declared plugin).
const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};
const attioSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text', summary: 'text', stage: 'text' },
      edges: { notes: { target: 'note', writable: true } },
    },
    note: { properties: { text: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' } },
  writableRoots: {
    company: {
      fields: {
        name: 'text',
        summary: 'text',
        stage: { kind: 'enum', options: ['Seed', 'Series A', 'Series B'] },
        categories: {
          kind: 'list',
          of: { kind: 'enum', options: ['Biotechnology', 'Health Care', 'Pharmaceuticals'] },
        },
        // `open` — known values from a live listing, not a closed set (the
        // `knownValues` shape, e.g. Slack channel names). Other values stay legal.
        region: { kind: 'enum', options: ['EMEA', 'APAC'], open: {} },
        tags: {
          kind: 'list',
          of: { kind: 'enum', options: ['Priority', 'Watchlist'], open: {} },
        },
      },
      resultShape: { externalId: 'text', url: 'text', name: 'text', summary: 'text' },
    },
    note: {
      fields: { text: 'text' },
      resultShape: { externalId: 'text', text: 'text' },
    },
  },
};
const slackSchema: InstanceSchema = {
  positions: { message: { properties: { channel: 'text', text: 'text' }, edges: {} } },
  collections: { messages: { target: 'message' } },
  writableRoots: {
    message: {
      fields: { channel: 'text', text: 'text' },
      resultShape: { externalId: 'text', channel: 'text', text: 'text' },
    },
  },
};

const movementCatalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: attioSchema },
    slack: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: slackSchema },
  },
  credentials: {
    dealflow_inbox: { adapters: ['email'] },
    acme_main: { adapters: ['attio'] },
    acme_workspace: { adapters: ['slack'] },
  },
  plugins: {
    vc_fetch: { args: ['urls'] },
    // Real registered transform; `text` is an `auto` param, so it takes NO
    // author args (the engine auto-feeds the source content).
    vc_url_retrieval: { args: [] },
    // The targeted twin: every argument is the author's, and `url` is required.
    fetch_url: { args: ['url', 'email', 'password'], fedByExtraction: true },
  },
});

const MOVEMENT_PRELUDE = [
  'import { email, attio, slack } from adapters',
  'import { dealflow_inbox, acme_main, acme_workspace } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  'team  = slack(credentials: acme_workspace)',
].join('\n');

// ═════════════════════════════════════════════════════════════════════════════
// 1. Stage-0 extract through runMovement
// ═════════════════════════════════════════════════════════════════════════════

// The parity fixture runs against the REAL static catalog, where email is
// credential-free (built in, no account to connect) — so it constructs `email()`
// bare, unlike the mock-catalog fixtures below whose MOVEMENT_PRELUDE models
// email as a generic stand-in credential adapter.
const PARITY_PRELUDE = [
  'import { email, attio, slack } from adapters',
  'import { acme_main, acme_workspace } from credentials',
  '',
  'inbox = email()',
  'crm   = attio(credentials: acme_main)',
  'team  = slack(credentials: acme_workspace)',
].join('\n');

const PARITY_MOVEMENT = [
  PARITY_PRELUDE,
  '',
  'movement log_dealflow(msg: <inbox-[:message]->>) {',
  '',
  '  deals = extract from [msg.`text`] {',
  '    digest: "a one-line summary of the dealflow message"',
  '    node company: "each company seeking investment in this message" {',
  '      name: "the company\'s name"',
  '      stage: "the funding stage, e.g. Seed"',
  '    }',
  '  }',
  '',
  '  write team-[:messages]-> {',
  '    channel: "#dealflow"',
  '    text:    deals.`digest`',
  '  }',
  '',
  '  deals-[c:company]-> {',
  '    write crm-[:companies]-> {',
  '      unique by (`name`)',
  '      name:    c.`name`',
  '      summary: c.`stage`',
  '    }',
  '  }',
  '}',
].join('\n');

const PARITY_CANNED: CannedSites = {
  [ROOT_EXTRACT_DESCRIPTION]: [
    { 'a one-line summary of the dealflow message': 'Two deals inbound' },
  ],
  'each company seeking investment in this message': [
    { "the company's name": 'Acme', 'the funding stage, e.g. Seed': 'Seed' },
    { "the company's name": 'Globex', 'the funding stage, e.g. Seed': 'Series A' },
  ],
};

describe('stage-0 extraction through runMovement', () => {
  const event = webhookEvent('email', {
    subject: 'Deals',
    text: 'Acme is raising a Seed. Globex is raising a Series A.',
  });

  it('produces the expected writes given canned extraction data', async () => {
    // ── Run A: the movement engine — ONE planned call for the whole tree.
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          {
            digest: wrap('Two deals inbound'),
            company: [
              { name: wrap('Acme'), stage: wrap('Seed') },
              { name: wrap('Globex'), stage: wrap('Series A') },
            ],
          },
        ],
      },
    ]);
    const movementWrites: CapturedWrite[] = [];
    const runResult = await runMovement({
      source: PARITY_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: parityCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      dryRun: true,
      writeSink: (w) => movementWrites.push(w),
    });
    expect(runResult.movementName).toBe('log_dealflow');

    // The through-free tree is ONE LLM call regardless of depth.
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].system).toContain('each company seeking investment in this message');
    expect(llm.calls[0].userMessage).toContain('Acme is raising a Seed.');

    expect(movementWrites).toEqual([
      {
        kind: 'create',
        adapterType: 'slack',
        recordType: 'message',
        fields: { channel: '#dealflow', text: 'Two deals inbound' },
      },
      {
        kind: 'create',
        adapterType: 'attio',
        recordType: 'company',
        fields: { name: 'Acme', summary: 'Seed' },
      },
      {
        kind: 'create',
        adapterType: 'attio',
        recordType: 'company',
        fields: { name: 'Globex', summary: 'Series A' },
      },
    ]);
  });

  it('records a per-node empty-entity count in the trace when a fielded entity comes back all-null', async () => {
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          {
            digest: wrap('Two deals inbound'),
            company: [
              // Every declared field null — the "found nothing" shape the
              // prompt now asks the model to omit instead of emitting.
              { name: wrap(null), stage: wrap(null) },
              { name: wrap('Globex'), stage: wrap('Series A') },
            ],
          },
        ],
      },
    ]);
    const runResult = await runMovement({
      source: PARITY_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: parityCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      dryRun: true,
      writeSink: () => {},
    });

    const extractionEntry = runResult.trace.find((e) => e.kind === 'extraction');
    expect(extractionEntry).toMatchObject({
      kind: 'extraction',
      emissions: { 'extract result': 1 },
      empty: { company: 1 },
    });
  });

  it('omits `empty` from the trace when every entity carries at least one value', async () => {
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          {
            digest: wrap('Two deals inbound'),
            company: [
              { name: wrap('Acme'), stage: wrap('Seed') },
              { name: wrap('Globex'), stage: wrap('Series A') },
            ],
          },
        ],
      },
    ]);
    const runResult = await runMovement({
      source: PARITY_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: parityCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      dryRun: true,
      writeSink: () => {},
    });

    const extractionEntry = runResult.trace.find((e) => e.kind === 'extraction');
    expect(extractionEntry).not.toHaveProperty('empty');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. `through`-staged extraction
// ═════════════════════════════════════════════════════════════════════════════

const STAGED_MOVEMENT = [
  'import { email, attio, slack } from adapters',
  'import { dealflow_inbox, acme_main, acme_workspace } from credentials',
  'import { vc_fetch } from plugins',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  'team  = slack(credentials: acme_workspace)',
  '',
  'movement log_dealflow(msg: <inbox-[:message]->>) {',
  '',
  '  deals = extract from [msg.`text`] {',
  '    node company: "each company seeking investment in this message" {',
  '      name: "the company\'s name"',
  '      urls: "URLs in the message associated with this company"',
  '    } through [vc_fetch(urls: urls)] {',
  '      name:    "the company\'s name"',
  '      website: "the company\'s official website"',
  '',
  '      node round: "the funding round this company is raising" {',
  '        stage: "the round\'s stage"',
  '      }',
  '    }',
  '  }',
  '',
  '  deals-[c:company]-> {',
  '    write crm-[:companies]-> {',
  '      unique by (`name`)',
  '      name:    c.`name`',
  '      summary: c.`website`',
  '    }',
  '    c-[r:round]-> {',
  '      write team-[:messages]-> {',
  '        channel: "#rounds"',
  '        text:    "${c.`name`}: ${r.`stage`}"',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

// The tier is the extraction's, not a stage's: it applies to every call the
// extraction makes, so a staged fixture is the right shape to pin it on.
describe('the extraction tier', () => {
  const event = webhookEvent('email', { text: 'Acme (acme.com) is fundraising.' });

  const withTier = (tier?: string): string =>
    STAGED_MOVEMENT.replace(
      '  deals = extract from [',
      `  deals = extract${tier !== undefined ? ` "${tier}"` : ''} from [`,
    );

  async function callsFor(tier?: string): Promise<Array<Record<string, unknown>>> {
    const llm = queuedMovementLlm([
      { 'x:extract_result#1': [{ company: [{ name: wrap('Acme'), urls: wrap('acme.com') }] }] },
      {
        'x:company#3': [
          {
            name: wrap('Acme'),
            website: wrap('https://acme.com'),
            round: [{ stage: wrap('Series A') }],
          },
        ],
      },
    ]);
    const transformInvoker: MovementTransformInvoker = {
      async invoke() {
        return { text: 'Fetched acme.com: Acme is raising a Series A.', data: {} };
      },
    };
    await runMovement({
      source: withTier(tier),
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      transformInvoker,
      dryRun: true,
      writeSink: () => {},
    });
    // Both calls: the stage-1 pass and the one behind the `through` fence.
    expect(llm.calls).toHaveLength(2);
    return llm.calls.map(({ model, effort, maxTokens }) => ({
      model,
      ...(effort !== undefined ? { effort } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    }));
  }

  // Nothing deployed changes without an authored tier: the density heuristic
  // still picks the model, extraction still asks for shallow reasoning, and
  // the ceiling is still sized from the input.
  it('sends exactly today’s settings when no tier is written', async () => {
    expect(await callsFor()).toEqual([
      { model: 'sonnet', effort: 'low' },
      { model: 'sonnet', effort: 'low' },
    ]);
  });

  // One model (sonnet-5) at rising effort, not three models: two bake-off
  // rounds (plans/mvt-core-calculus-2026-08-31/10_bakeoff.md) found no
  // fixture where a bigger model scored higher, at any effort.
  it('applies a written tier to every call, stage-1 and fenced alike', async () => {
    expect(await callsFor('quick')).toEqual([
      { model: 'sonnet', effort: 'low' },
      { model: 'sonnet', effort: 'low' },
    ]);
    // Both tiers that REASON spend a flat budget rather than one sized from the
    // question, and a larger one than anything else here — that budget pays for
    // the thinking as well as the answer.
    expect(await callsFor('careful')).toEqual([
      { model: 'sonnet', effort: 'high', maxTokens: 64_000 },
      { model: 'sonnet', effort: 'high', maxTokens: 64_000 },
    ]);
    expect(await callsFor('thorough')).toEqual([
      { model: 'sonnet', effort: 'xhigh', maxTokens: 64_000 },
      { model: 'sonnet', effort: 'xhigh', maxTokens: 64_000 },
    ]);
  });

  it('runs the legacy spelling as the tier it means', async () => {
    expect(await callsFor('smart')).toEqual([
      { model: 'sonnet', effort: 'high', maxTokens: 64_000 },
      { model: 'sonnet', effort: 'high', maxTokens: 64_000 },
    ]);
  });
});

describe('through-staged extraction', () => {
  const event = webhookEvent('email', { text: 'Acme (acme.com) is fundraising.' });

  it('plans phases at the through fence, feeds the plugin the working field, and re-extracts with enriched context', async () => {
    const llm = queuedMovementLlm([
      // Phase 0: the company's FIRST stage only (working `urls` included,
      // nothing behind the fence).
      {
        'x:extract_result#1': [
          { company: [{ name: wrap('Acme'), urls: wrap('acme.com') }] },
        ],
      },
      // Phase 1 (per entity, post-plugin): the fenced stage + its child.
      {
        'x:company#3': [
          {
            name: wrap('Acme'),
            website: wrap('https://acme.com'),
            round: [{ stage: wrap('Series A') }],
          },
        ],
      },
    ]);

    const invocations: Array<{
      plugin: string;
      config: Record<string, unknown>;
      extractedContext: Record<string, unknown>;
    }> = [];
    const transformInvoker: MovementTransformInvoker = {
      async invoke(input) {
        invocations.push(input);
        return {
          text: 'Fetched acme.com: Acme builds rockets and is raising a Series A.',
          data: { official_site: 'https://acme.com' },
        };
      },
    };

    const slack = makeFakeAdapter('slack');
    const attio = makeFakeAdapter('attio');
    const result = await runMovement({
      source: STAGED_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: slack.adapter,
      }),
      llm: llm.client,
      transformInvoker,
    });

    // ── Phase plan: exactly two calls, fenced at the author's `through`.
    expect(llm.calls).toHaveLength(2);

    const phase0 = llm.calls[0];
    expect(phase0.system).toContain('each company seeking investment in this message');
    expect(phase0.system).toContain('`urls`');
    expect(phase0.system).not.toContain('`website`');
    expect(phase0.system).not.toContain('the funding round this company is raising');

    const phase1 = llm.calls[1];
    expect(phase1.system).toContain('`website`');
    expect(phase1.system).toContain('the funding round this company is raising');
    expect(phase1.system).not.toContain('`urls`');
    // The continuation call sees the original data, the entity so far,
    // AND the plugin's contribution — the deeper node extracts against
    // enriched context.
    expect(phase1.userMessage).toContain('Acme (acme.com) is fundraising.');
    expect(phase1.userMessage).toContain('## CURRENT ENTITY');
    expect(phase1.userMessage).toContain('"urls": "acme.com"');
    expect(phase1.userMessage).toContain('## ENRICHMENT via `vc_fetch`');
    expect(phase1.userMessage).toContain('Acme builds rockets');

    // ── The plugin ran per entity, fed by the earlier stage's field.
    expect(invocations).toEqual([
      {
        plugin: 'vc_fetch',
        config: { urls: 'acme.com' },
        extractedContext: { name: 'Acme', urls: 'acme.com' },
      },
    ]);

    // ── Writes: the node's shape flowed through; the nested block
    //    saw the deeper node.
    expect(result.writes.map((w) => [w.adapterType, w.recordType])).toEqual([
      ['attio', 'company'],
      ['slack', 'message'],
    ]);
    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme', summary: 'https://acme.com' } },
    ]);
    expect(slack.creates).toEqual([
      { recordType: 'message', fields: { channel: '#rounds', text: 'Acme: Series A' } },
    ]);
  });

  it('a later stage INHERITS the earlier one’s fields — a first-stage field reads back after the extract', async () => {
    // `urls` is declared only in the first stage and never re-declared, so it
    // is exactly the "unchanged" case the inheritance rule exists for.
    const source = STAGED_MOVEMENT.replace('summary: c.`website`', 'summary: c.`urls`');
    const llm = queuedMovementLlm([
      { 'x:extract_result#1': [{ company: [{ name: wrap('Acme'), urls: wrap('acme.com') }] }] },
      {
        'x:company#3': [
          {
            name: wrap('Acme'),
            website: wrap('https://acme.com'),
            round: [{ stage: wrap('Series A') }],
          },
        ],
      },
    ]);
    const transformInvoker: MovementTransformInvoker = {
      async invoke() {
        return { text: 'Fetched acme.com.', data: {} };
      },
    };
    const attio = makeFakeAdapter('attio');
    await runMovement({
      source,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      transformInvoker,
    });

    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme', summary: 'acme.com' } },
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2b. `auto` plugin params (vc_url_retrieval's `text`) are engine-fed
// ═════════════════════════════════════════════════════════════════════════════

const AUTO_CONTENT_MOVEMENT = [
  MOVEMENT_PRELUDE,
  'import { vc_url_retrieval } from plugins',
  '',
  'movement intake(msg: <inbox-[:message]->>) {',
  '  deals = extract from [msg.`text`] through [vc_url_retrieval] {',
  '    node company: "each company mentioned" {',
  '      name: "the company\'s name"',
  '    }',
  '  }',
  '  deals-[c:company]-> {',
  '    write crm-[:companies]-> { unique by (`name`) name: c.`name` }',
  '  }',
  '}',
].join('\n');

describe('through auto-content (vc_url_retrieval)', () => {
  const event = webhookEvent('email', { text: 'Acme (acme.com) is fundraising.' });

  it('auto-feeds the extract source as the plugin content — no author argument', async () => {
    const llm = queuedMovementLlm([
      { 'x:extract_result#1': [{ company: [{ name: wrap('Acme') }] }] },
    ]);
    const invocations: Array<{ plugin: string; config: Record<string, unknown> }> = [];
    const transformInvoker: MovementTransformInvoker = {
      async invoke(input) {
        invocations.push({ plugin: input.plugin, config: input.config });
        return {};
      },
    };
    await runMovement({
      source: AUTO_CONTENT_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      transformInvoker,
      dryRun: true,
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0].plugin).toBe('vc_url_retrieval');
    // `text` is injected from the `from [msg.\`text\`]` source — the author
    // passed nothing.
    expect(invocations[0].config).toEqual({ text: 'Acme (acme.com) is fundraising.' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2c. A required plugin argument that resolves empty skips THAT entity only
// ═════════════════════════════════════════════════════════════════════════════

const PER_ENTITY_FETCH_MOVEMENT = [
  MOVEMENT_PRELUDE,
  'import { fetch_url } from plugins',
  '',
  'movement intake(msg: <inbox-[:message]->>) {',
  '  deals = extract from [msg.`text`] {',
  '    node company: "each company mentioned" {',
  '      name:    "the company\'s name"',
  '      website: "the company\'s web address"',
  '    } through [fetch_url(url: website)] {',
  '      summary: "what the company does"',
  '    }',
  '  }',
  '  deals-[c:company]-> {',
  '    write crm-[:companies]-> {',
  '      unique by (`name`)',
  '      name:    c.`name`',
  '      summary: c.`summary`',
  '    }',
  '  }',
  '}',
].join('\n');

describe('a per-entity retrieval stage', () => {
  const event = webhookEvent('email', {
    text: 'Gondor (gondor.fi) and Rohan are both worth a look.',
  });

  it('loads each company\'s own page, and skips the company with no address', async () => {
    const llm = queuedMovementLlm([
      // Stage 0: both companies; only one of them has a web address.
      {
        'x:extract_result#1': [
          {
            company: [
              { name: wrap('Gondor'), website: wrap('gondor.fi') },
              { name: wrap('Rohan'), website: { evidence: null, value: null } },
            ],
          },
        ],
      },
      // Stage 1 runs for the company whose page was loaded. Rohan's fetch never
      // ran, so its continuation would have re-read exactly what stage 0 read.
      { 'x:company#3': [{ summary: wrap('Forges rings') }] },
    ]);

    const invocations: Array<{ plugin: string; config: Record<string, unknown> }> = [];
    const transformInvoker: MovementTransformInvoker = {
      async invoke(input) {
        invocations.push({ plugin: input.plugin, config: input.config });
        return { text: `Fetched ${String(input.config.url)}: a page about that company.` };
      },
    };

    const result = await runMovement({
      source: PER_ENTITY_FETCH_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      transformInvoker,
      dryRun: true,
    });

    // The stage ran ONCE — for the company that carried an address.
    expect(invocations).toEqual([
      { plugin: 'fetch_url', config: { url: 'gondor.fi' } },
    ]);

    // And the continuation call runs ONCE, for that same company: Rohan's
    // stage had nothing to read that its first stage had not already read.
    const stageCalls = llm.calls.slice(1);
    expect(stageCalls).toHaveLength(1);

    // The company whose page was loaded sees an enrichment, and it sees its
    // OWN page — the isolation the per-entity placement exists for. Rohan is
    // named in the shared source text, but never as the entity being asked
    // about (the `CURRENT ENTITY` block quotes the name).
    expect(stageCalls[0].userMessage).toContain('"Gondor"');
    expect(stageCalls[0].userMessage).not.toContain('"Rohan"');
    expect(stageCalls[0].userMessage).toContain('## ENRICHMENT via `fetch_url`');
    expect(stageCalls[0].userMessage).toContain('Fetched gondor.fi');

    // The call that wasn't made is on the record, with what each of the
    // stage's plugins did — "skipped as pointless", not "never ran".
    expect(result.trace).toContainEqual({
      kind: 'extraction',
      node: 'company',
      inputChars: 0,
      skipped: 'no_enrichment',
      plugins: [{ plugin: 'fetch_url', outcome: 'skipped' }],
      emissions: { company: 0 },
    });
  });

  // A required argument reaches the plugin as a VALUE, and every shape of
  // "nothing" has to read the same at that boundary — a field the model
  // answered `null`, one it answered with a blank string, and one it omitted
  // entirely. Otherwise a nullish value gets stringified into an address
  // (`https://null`) that grinds to the fetch's seven-minute backstop.
  it.each([
    ['null', { evidence: null, value: null }],
    ['a blank string', wrap('  ')],
    ['nothing at all', undefined],
  ])('skips the invocation when the url resolved to %s', async (_shape, website) => {
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          { company: [{ name: wrap('Rohan'), ...(website ? { website } : {}) }] },
        ],
      },
    ]);

    const invocations: Array<{ plugin: string; config: Record<string, unknown> }> = [];

    await runMovement({
      source: PER_ENTITY_FETCH_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      transformInvoker: {
        async invoke(input) {
          invocations.push({ plugin: input.plugin, config: input.config });
          return {};
        },
      },
      dryRun: true,
    });

    // No enrichment, no error — and no second call either: with the fetch
    // skipped there is nothing the first call did not already read.
    expect(invocations).toEqual([]);
    expect(llm.calls).toHaveLength(1);
  });

  // An `extract` is ONE statement, so the interpreter's between-statements
  // cancel check cannot help while it runs — and when the extract is the last
  // statement there is no next check at all. These two assert the boundaries
  // inside the statement: a cancel stamped mid-extraction stops it at the next
  // plugin invocation and at the next LLM call, rather than after every fetch
  // in the fan has run and the run has reported success.
  it('stops at the next plugin invocation once the run is cancelled', async () => {
    const cancelGate = makeTestCancelGate();
    // More companies than the fan runs at once: the ones past the cap have not
    // been launched when the cancel lands, and they are what this asserts on.
    const named = ['gondor', 'rohan', 'shire', 'moria', 'lorien', 'bree'];
    const launched = named.slice(0, STAGE_FAN_OUT).map((n) => `${n}.fi`);
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          { company: named.map((n) => ({ name: wrap(n), website: wrap(`${n}.fi`) })) },
        ],
      },
    ]);

    const invocations: string[] = [];
    const transformInvoker: MovementTransformInvoker = {
      async invoke(input) {
        invocations.push(String(input.config.url));
        // The operator hits Cancel while this fetch is in flight.
        cancelGate.stamp();
        return { text: `Fetched ${String(input.config.url)}.` };
      },
    };

    const result = await runCancellable(cancelGate, () =>
      runMovement({
        source: PER_ENTITY_FETCH_MOVEMENT,
        event,
        teamId: TEAM_ID,
        catalog: movementCatalog,
        resolveAdapter: makeResolver({
          email: makeFakeAdapter('email').adapter,
          attio: makeFakeAdapter('attio').adapter,
          slack: makeFakeAdapter('slack').adapter,
        }),
        llm: llm.client,
        transformInvoker,
        dryRun: true,
        cancelGate,
      }),
    );

    expect(result.cancelled).toBe(true);
    // Only what the fan had already put in flight ever ran — the companies
    // behind the cap are never fetched. Without the in-statement check all six
    // pages load and the run settles `success`.
    expect(invocations.filter((url) => !launched.includes(url))).toEqual([]);
    expect(invocations.length).toBeLessThanOrEqual(STAGE_FAN_OUT);
    // And nothing behind the fence: the continuation call is the next boundary
    // after the plugin, and it is cancelled too.
    expect(llm.calls).toHaveLength(1);
  });

  it('stops at the next bundle-level plugin once the run is cancelled', async () => {
    const cancelGate = makeTestCancelGate();
    // The bundle pipeline runs before any entity exists, so its plugins are the
    // first fan a cancel can land in. More of them than the fan runs at once,
    // for the same reason as above: the ones past the cap are never launched.
    const pipeline = Array.from({ length: STAGE_FAN_OUT + 2 }, () => 'vc_url_retrieval');
    const source = [
      MOVEMENT_PRELUDE,
      'import { vc_url_retrieval } from plugins',
      '',
      'movement intake(msg: <inbox-[:message]->>) {',
      `  deals = extract from [msg.\`text\`] through [${pipeline.join(', ')}] {`,
      '    node company: "each company mentioned" {',
      '      name: "the company\'s name"',
      '    }',
      '  }',
      '  deals-[c:company]-> {',
      '    write crm-[:companies]-> { unique by (`name`) name: c.`name` }',
      '  }',
      '}',
    ].join('\n');
    const llm = queuedMovementLlm([
      { 'x:extract_result#1': [{ company: [{ name: wrap('Acme') }] }] },
    ]);

    let invocations = 0;
    const transformInvoker: MovementTransformInvoker = {
      async invoke() {
        invocations += 1;
        // The operator hits Cancel while this fetch is in flight.
        cancelGate.stamp();
        return { text: 'Fetched.' };
      },
    };

    const result = await runCancellable(cancelGate, () =>
      runMovement({
        source,
        event: webhookEvent('email', { text: 'Acme (acme.com) is fundraising.' }),
        teamId: TEAM_ID,
        catalog: movementCatalog,
        resolveAdapter: makeResolver({
          email: makeFakeAdapter('email').adapter,
          attio: makeFakeAdapter('attio').adapter,
          slack: makeFakeAdapter('slack').adapter,
        }),
        llm: llm.client,
        transformInvoker,
        dryRun: true,
        cancelGate,
      }),
    );

    expect(result.cancelled).toBe(true);
    expect(invocations).toBeLessThanOrEqual(STAGE_FAN_OUT);
    // The bundle's own extraction call is the next boundary, and it never runs.
    expect(llm.calls).toHaveLength(0);
  });

  it('stops at the next LLM call once the run is cancelled', async () => {
    const cancelGate = makeTestCancelGate();
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          {
            company: [
              { name: wrap('Gondor'), website: { evidence: null, value: null } },
              { name: wrap('Rohan'), website: { evidence: null, value: null } },
            ],
          },
        ],
      },
      { 'x:company#3': [{ summary: wrap('Forges rings') }] },
      { 'x:company#3': [{ summary: wrap('Breeds horses') }] },
    ]);

    const result = await runCancellable(cancelGate, () =>
      runMovement({
        source: PER_ENTITY_FETCH_MOVEMENT,
        event,
        teamId: TEAM_ID,
        catalog: movementCatalog,
        resolveAdapter: makeResolver({
          email: makeFakeAdapter('email').adapter,
          attio: makeFakeAdapter('attio').adapter,
          slack: makeFakeAdapter('slack').adapter,
        }),
        llm: {
          async call(input: LlmCallInput): Promise<LlmCallResult> {
            const reply = await llm.client.call(input);
            // Cancelled during the first (stage-0) call, so the per-company
            // continuation calls are the next boundary.
            cancelGate.stamp();
            return reply;
          },
        },
        transformInvoker: {
          async invoke() {
            return {};
          },
        },
        dryRun: true,
        cancelGate,
      }),
    );

    expect(result.cancelled).toBe(true);
    expect(llm.calls).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2d. A stage with nothing new to read makes no model call
// ═════════════════════════════════════════════════════════════════════════════
//
// Production evidence (2026-09-01): one per-entity staged extract made 53
// continuation calls, and 50 of them were no-ops. For those entities every
// plugin of the stage either skipped (a required argument resolved empty) or
// ran and contributed nothing, so the prompt carried the same source text and
// the same fields the previous stage had already extracted from — and the
// model, correctly, answered with nothing new. ~130s of a four-minute run.

/** Two plugins fencing one stage: the mixed pipeline. `vc_url_retrieval`
 *  takes its content from the extract source (engine-fed), so it runs for
 *  every entity whatever the entity's own fields say. */
const TWO_PLUGIN_STAGE_MOVEMENT = [
  MOVEMENT_PRELUDE,
  'import { fetch_url, vc_url_retrieval } from plugins',
  '',
  'movement intake(msg: <inbox-[:message]->>) {',
  '  deals = extract from [msg.`text`] {',
  '    node company: "each company mentioned" {',
  '      name:    "the company\'s name"',
  '      website: "the company\'s web address"',
  '    } through [vc_url_retrieval, fetch_url(url: website)] {',
  '      summary: "what the company does"',
  '    }',
  '  }',
  '  deals-[c:company]-> {',
  '    write crm-[:companies]-> {',
  '      unique by (`name`)',
  '      name:    c.`name`',
  '      summary: c.`summary`',
  '    }',
  '  }',
  '}',
].join('\n');

describe('a stage whose plugins contributed nothing', () => {
  const event = webhookEvent('email', { text: 'Gondor (gondor.fi) is worth a look.' });
  const GONDOR = {
    'x:extract_result#1': [
      { company: [{ name: wrap('Gondor'), website: wrap('gondor.fi') }] },
    ],
  };

  async function intake(
    source: string,
    responses: unknown[],
    invoke: MovementTransformInvoker['invoke'],
  ): Promise<{
    calls: LlmCallInput[];
    writes: Record<string, unknown>[];
    trace: Awaited<ReturnType<typeof runMovement>>['trace'];
  }> {
    const llm = queuedMovementLlm(responses);
    const attio = makeFakeAdapter('attio');
    const result = await runMovement({
      source,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      transformInvoker: { invoke },
    });
    return {
      calls: llm.calls,
      writes: attio.creates.map((c) => c.fields),
      trace: result.trace,
    };
  }

  // Every shape of "the plugin ran and gave nothing back" — the three that
  // render no ENRICHMENT block, which is the whole test.
  it.each([
    ['nothing at all', {}],
    ['empty text', { text: '' }],
    ['empty data', { data: {} }],
  ])('makes no continuation call when the plugin came back with %s', async (_shape, result) => {
    const { calls, writes } = await intake(
      PER_ENTITY_FETCH_MOVEMENT,
      [GONDOR],
      async () => result,
    );

    // The plugin ran (the company had an address) — and the stage behind it
    // did not, because there was nothing for it to read.
    expect(calls).toHaveLength(1);
    // Its declared text field joins the entity empty — the same thing the
    // call it replaced produced, since the model had nothing new to answer
    // from either.
    expect(writes).toEqual([{ name: 'Gondor', summary: '' }]);
  });

  it('carries the plugin’s own outcome onto its trace entry', async () => {
    const { trace } = await intake(PER_ENTITY_FETCH_MOVEMENT, [GONDOR], async () => ({
      outcome: 'has_link',
    }));

    expect(trace).toContainEqual(
      expect.objectContaining({ kind: 'plugin', plugin: 'fetch_url', outcome: 'has_link' }),
    );
    // An outcome is not enrichment — the stage is still skipped as pointless.
    expect(trace).toContainEqual(
      expect.objectContaining({ kind: 'extraction', skipped: 'no_enrichment' }),
    );
  });

  it('records the call it did not make, and what each plugin did', async () => {
    const { trace } = await intake(PER_ENTITY_FETCH_MOVEMENT, [GONDOR], async () => ({}));

    expect(trace).toContainEqual({
      kind: 'extraction',
      node: 'company',
      inputChars: 0,
      skipped: 'no_enrichment',
      plugins: [{ plugin: 'fetch_url', outcome: 'empty' }],
      emissions: { company: 0 },
    });
  });

  // The three deliberate non-skips.

  it.each([
    ['text', { text: 'a page about that company' }],
    ['data', { data: { official_site: 'https://gondor.fi' } }],
  ])('still calls when a plugin came back with %s', async (_kind, result) => {
    const { calls } = await intake(
      PER_ENTITY_FETCH_MOVEMENT,
      [GONDOR, { 'x:company#3': [{ summary: wrap('Forges rings') }] }],
      async () => result,
    );

    expect(calls).toHaveLength(2);
    expect(calls[1].userMessage).toContain('## ENRICHMENT via `fetch_url`');
  });

  it('still calls when ONE plugin of the stage contributed and the other did not', async () => {
    const { calls } = await intake(
      TWO_PLUGIN_STAGE_MOVEMENT,
      [GONDOR, { 'x:company#3': [{ summary: wrap('Forges rings') }] }],
      async ({ plugin }) => (plugin === 'fetch_url' ? { text: 'a page' } : {}),
    );

    expect(calls).toHaveLength(2);
    expect(calls[1].userMessage).toContain('## ENRICHMENT via `fetch_url`');
    expect(calls[1].userMessage).not.toContain('vc_url_retrieval');
  });

  // The FIRST pass has no previous call to inherit from, so a bundle-level
  // pipeline that contributed nothing changes nothing about it.
  it('still makes the first call when the extract’s own pipeline contributed nothing', async () => {
    const { calls } = await intake(
      AUTO_CONTENT_MOVEMENT,
      [{ 'x:extract_result#1': [{ company: [{ name: wrap('Gondor') }] }] }],
      async () => ({}),
    );

    expect(calls).toHaveLength(1);
  });

  // A stage that declares NO plugins is field staging, not enrichment: it has
  // no pipeline to come back empty, and "every plugin contributed nothing"
  // must never be vacuously true for it. Today's grammar can't write one — a
  // chained stage is introduced by `through […]`, which needs at least one
  // plugin — so the spec is built directly, which is also the only way the
  // engine could ever meet one.
  it('a stage that declares NO plugins always calls', async () => {
    const llm = queuedMovementLlm([
      { 'x:extract_result#1': [{ name: wrap('Acme') }] },
      { 'x:extract_result#2': [{ summary: wrap('builds rockets') }] },
    ]);
    const span: Span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };
    const extract: ExtractExpression = {
      from: [{ raw: 'text', span }],
      stages: [
        {
          fields: [{ name: 'name', description: desc("the company's name", span), span }],
          children: [],
          span,
        },
        {
          fields: [{ name: 'summary', description: desc('what the company does', span), span }],
          children: [],
          span,
        },
      ],
      span,
    };

    const emission = await materializeExtract({
      extract,
      spec: await buildExtractSpec(extract),
      runtime: {
        llm: llm.client,
        transformInvoker: {
          async invoke() {
            throw new Error('test: a plugin-less stage must not invoke anything');
          },
        },
        evalSlot: async () => ({
          value: 'Acme builds rockets.',
          provenance: NO_PROVENANCE,
        }),
      },
    });

    expect(llm.calls).toHaveLength(2);
    expect(emission.fields).toEqual({ name: 'Acme', summary: 'builds rockets' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Enum options from an explicit BORROWED annotation reach the LLM request
// ═════════════════════════════════════════════════════════════════════════════

describe('enum borrowing — `stage: crm.company.stage "…"` constrains the extraction', () => {
  // The explicit borrowed annotation is THE mechanism (adoption is
  // demoted): the dotted path resolves against the live instance schema
  // at firing time, so the option list reaches the LLM without ever
  // being copied into the program.
  const ENUM_MOVEMENT = [
    MOVEMENT_PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  deals = extract from [msg.`text`] {',
    '    node company: "each company seeking investment in this message" {',
    '      name:  "the company\'s name"',
    '      stage: <crm-[:company]->.stage> "the funding stage of the company\'s round"',
    '    }',
    '  }',
    '  deals-[c:company]-> {',
    '    write crm-[:companies]-> {',
    '      unique by (`name`)',
    '      name:  c.`name`',
    '      stage ?: c.`stage`',
    '    }',
    '  }',
    '}',
  ].join('\n');

  it('surfaces the borrowed enum options in the entity guide and accepts a valid value', async () => {
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          { company: [{ name: wrap('Acme'), stage: wrap('Series A') }] },
        ],
      },
    ]);
    const attio = makeFakeAdapter('attio');
    await runMovement({
      source: ENUM_MOVEMENT,
      event: webhookEvent('email', { text: 'Acme raising Series A' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
    });

    // The borrowed enum (resolved live from crm.company.stage) reaches
    // the LLM request — option list in the guide, enum-validated response.
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].system).toContain('`stage` (enum: Seed | Series A | Series B)');
    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme', stage: 'Series A' } },
    ]);
  });

  it('an UNannotated field does not pick the options up silently (adoption is demoted)', async () => {
    const unannotated = ENUM_MOVEMENT.replace(
      "stage: <crm-[:company]->.stage> \"the funding stage of the company's round\"",
      "stage: \"the funding stage of the company's round\"",
    );
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          { company: [{ name: wrap('Acme'), stage: wrap('somewhere mid-stage') }] },
        ],
      },
    ]);
    const attio = makeFakeAdapter('attio');
    await runMovement({
      source: unannotated,
      event: webhookEvent('email', { text: 'Acme raising Series A' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
    });
    // No options in the guide, no enum validation: only explicit
    // annotations constrain — the checker SUGGESTS the annotation instead.
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].system).not.toContain('Seed | Series A | Series B');
    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme', stage: 'somewhere mid-stage' } },
    ]);
  });

  it('a DECLARED refinement constrains the extraction the same way a borrow does', async () => {
    // `type Stage = <…>` is the written twin of the borrowed option set: it
    // reaches the guide by the same road and validates the same way, so the
    // two are indistinguishable downstream. Written values differ from the
    // adapter's so nothing can pass by borrowing instead.
    const declared = [
      MOVEMENT_PRELUDE,
      '',
      'type Stage = <"Pre-seed" | "Bridge">',
      '',
      'movement m(msg: <inbox-[:message]->>) {',
      '  deals = extract from [msg.`text`] {',
      '    node company: "each company seeking investment in this message" {',
      '      name:  "the company\'s name"',
      '      stage: <Stage> "the funding stage of the company\'s round"',
      '    }',
      '  }',
      '  deals-[c:company]-> {',
      '    write crm-[:companies]-> {',
      '      unique by (`name`)',
      '      name:  c.`name`',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const llm = queuedMovementLlm([
      // Case-only near-miss, so the answer also proves the CLOSED-enum
      // coercion runs against the written option list.
      { 'x:extract_result#1': [{ company: [{ name: wrap('Acme'), stage: wrap('bridge') }] }] },
    ]);
    const attio = makeFakeAdapter('attio');
    const result = await runMovement({
      source: declared,
      event: webhookEvent('email', { text: 'Acme raising a bridge' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
    });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].system).toContain('`stage` (enum: Pre-seed | Bridge)');
    const extraction = result.trace.find((e) => e.kind === 'extraction');
    expect(JSON.stringify(extraction)).toContain('Bridge');
  });

  it('coerces a case-only near-miss to its canonical option (no retry)', async () => {
    // `series a` differs only by casing — it resolves to `Series A` rather
    // than failing validation and burning a retry over the whole region.
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          { company: [{ name: wrap('Acme'), stage: wrap('series a') }] },
        ],
      },
    ]);
    const attio = makeFakeAdapter('attio');
    await runMovement({
      source: ENUM_MOVEMENT,
      event: webhookEvent('email', { text: 'Acme raising Series A' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
    });
    expect(llm.calls).toHaveLength(1);
    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme', stage: 'Series A' } },
    ]);
  });

  it('drops genuine non-members from a multiselect without failing the whole extraction', async () => {
    // The live-Attio bug: one near-miss in a multiselect array used to fail
    // the ENTIRE extraction. Now each entry is matched independently — case
    // near-misses coerce, genuine non-members drop, valid siblings survive,
    // and no retry fires.
    const MULTISELECT_MOVEMENT = [
      MOVEMENT_PRELUDE,
      '',
      'movement m(msg: <inbox-[:message]->>) {',
      '  deals = extract from [msg.`text`] {',
      '    node company: "each company seeking investment in this message" {',
      '      name:       "the company\'s name"',
      '      categories: <crm-[:company]->.categories> "the industry categories"',
      '    }',
      '  }',
      '  deals-[c:company]-> {',
      '    write crm-[:companies]-> {',
      '      unique by (`name`)',
      '      name:       c.`name`',
      '      categories ?: c.`categories`',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          {
            company: [
              {
                name: wrap('Acme'),
                // exact | case near-miss | exact | genuine hallucination
                categories: wrap(['Biotechnology', 'health care', 'Pharmaceuticals', 'Fintech']),
              },
            ],
          },
        ],
      },
    ]);
    const attio = makeFakeAdapter('attio');
    await runMovement({
      source: MULTISELECT_MOVEMENT,
      event: webhookEvent('email', { text: 'Acme, a biotech company' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
    });
    expect(llm.calls).toHaveLength(1);
    // Exactly the three valid options survive, in order: `Fintech` is dropped,
    // `health care` coerces to `Health Care`. (The fake adapter's `describe()`
    // returns null, so write-cardinality is unknown and the array is CSV-joined
    // — production reports `cardinality: 'many'` and preserves the array, which
    // the Attio write path then matches per-element via the shared `matchOption`.)
    expect(attio.creates).toEqual([
      {
        recordType: 'company',
        fields: { name: 'Acme', categories: 'Biotechnology, Health Care, Pharmaceuticals' },
      },
    ]);
  });
});

describe('open enums (`enum.open`) — known-values fields accept novel values', () => {
  // `region` (single select) and `tags` (multiselect) are the `open`-marked
  // siblings of `stage`/`categories` on the shared `attioSchema` fixture — a
  // `knownValues`-style field (e.g. a live Slack channel listing): the
  // options are what the adapter could enumerate, but other values remain
  // legal (checker: catalog.ts's `enum.open`).
  const OPEN_SINGLE_MOVEMENT = [
    MOVEMENT_PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  deals = extract from [msg.`text`] {',
    '    node company: "each company seeking investment in this message" {',
    '      name:   "the company\'s name"',
    '      region: <crm-[:company]->.region> "the company\'s region"',
    '    }',
    '  }',
    '  deals-[c:company]-> {',
    '    write crm-[:companies]-> {',
    '      unique by (`name`)',
    '      name:   c.`name`',
    '      region ?: c.`region`',
    '    }',
    '  }',
    '}',
  ].join('\n');

  it('renders open enums distinguishably in the entity guide (known values, not a closed enum)', async () => {
    const llm = queuedMovementLlm([
      { 'x:extract_result#1': [{ company: [{ name: wrap('Acme'), region: wrap('EMEA') }] }] },
    ]);
    const attio = makeFakeAdapter('attio');
    await runMovement({
      source: OPEN_SINGLE_MOVEMENT,
      event: webhookEvent('email', { text: 'Acme, EMEA' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
    });
    // Distinct from the closed-enum phrasing (`enum: A | B`) — the model must
    // learn a novel value is legal here, not just the listed ones.
    expect(llm.calls[0].system).toContain('`region` (text, known values: EMEA | APAC)');
    expect(llm.calls[0].system).not.toContain('`region` (enum:');
  });

  it('keeps a genuine novel value as-is for an open enum (no coercion to null)', async () => {
    const llm = queuedMovementLlm([
      { 'x:extract_result#1': [{ company: [{ name: wrap('Acme'), region: wrap('LATAM') }] }] },
    ]);
    const attio = makeFakeAdapter('attio');
    const runResult = await runMovement({
      source: OPEN_SINGLE_MOVEMENT,
      event: webhookEvent('email', { text: 'Acme, LATAM' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
    });
    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme', region: 'LATAM' } },
    ]);
    // Not a loss — an open enum's novel value never contributes a diagnostic.
    const extractionEntry = runResult.trace.find((e) => e.kind === 'extraction');
    expect(extractionEntry).not.toHaveProperty('coerced');
  });

  it('normalizes a near-miss to its canonical option for an open enum', async () => {
    const llm = queuedMovementLlm([
      { 'x:extract_result#1': [{ company: [{ name: wrap('Acme'), region: wrap('emea') }] }] },
    ]);
    const attio = makeFakeAdapter('attio');
    await runMovement({
      source: OPEN_SINGLE_MOVEMENT,
      event: webhookEvent('email', { text: 'Acme, emea' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
    });
    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme', region: 'EMEA' } },
    ]);
  });

  it('nulls a genuine non-member of a CLOSED enum and records the diagnostic', async () => {
    const CLOSED_SINGLE_MOVEMENT = [
      MOVEMENT_PRELUDE,
      '',
      'movement m(msg: <inbox-[:message]->>) {',
      '  deals = extract from [msg.`text`] {',
      '    node company: "each company seeking investment in this message" {',
      '      name:  "the company\'s name"',
      '      stage: <crm-[:company]->.stage> "the funding stage of the company\'s round"',
      '    }',
      '  }',
      '  deals-[c:company]-> {',
      '    write crm-[:companies]-> {',
      '      unique by (`name`)',
      '      name:  c.`name`',
      '      stage ?: c.`stage`',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const llm = queuedMovementLlm([
      { 'x:extract_result#1': [{ company: [{ name: wrap('Acme'), stage: wrap('Pre-seed') }] }] },
    ]);
    const attio = makeFakeAdapter('attio');
    const runResult = await runMovement({
      source: CLOSED_SINGLE_MOVEMENT,
      event: webhookEvent('email', { text: 'Acme, pre-seed' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
    });
    // The field contract holds (closed enums still coerce-to-null)...
    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme', stage: null } },
    ]);
    // ...but the loss now surfaces in the trace instead of vanishing.
    const extractionEntry = runResult.trace.find((e) => e.kind === 'extraction');
    expect(extractionEntry).toMatchObject({ coerced: { 'company.stage': ['Pre-seed'] } });
  });

  const OPEN_MULTISELECT_MOVEMENT = [
    MOVEMENT_PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  deals = extract from [msg.`text`] {',
    '    node company: "each company seeking investment in this message" {',
    '      name: "the company\'s name"',
    '      tags: <crm-[:company]->.tags> "the tags for this company"',
    '    }',
    '  }',
    '  deals-[c:company]-> {',
    '    write crm-[:companies]-> {',
    '      unique by (`name`)',
    '      name: c.`name`',
    '      tags ?: c.`tags`',
    '    }',
    '  }',
    '}',
  ].join('\n');

  it('keeps novel entries (and normalizes near-misses) in an OPEN multiselect', async () => {
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          {
            company: [
              // exact | case near-miss | genuine novel value
              { name: wrap('Acme'), tags: wrap(['Priority', 'watchlist', 'NewTag']) },
            ],
          },
        ],
      },
    ]);
    const attio = makeFakeAdapter('attio');
    await runMovement({
      source: OPEN_MULTISELECT_MOVEMENT,
      event: webhookEvent('email', { text: 'Acme' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
    });
    expect(attio.creates).toEqual([
      {
        recordType: 'company',
        fields: { name: 'Acme', tags: 'Priority, Watchlist, NewTag' },
      },
    ]);
  });

  it('drops a non-member from a CLOSED multiselect and records the diagnostic', async () => {
    const CLOSED_MULTISELECT_MOVEMENT = [
      MOVEMENT_PRELUDE,
      '',
      'movement m(msg: <inbox-[:message]->>) {',
      '  deals = extract from [msg.`text`] {',
      '    node company: "each company seeking investment in this message" {',
      '      name:       "the company\'s name"',
      '      categories: <crm-[:company]->.categories> "the industry categories"',
      '    }',
      '  }',
      '  deals-[c:company]-> {',
      '    write crm-[:companies]-> {',
      '      unique by (`name`)',
      '      name:       c.`name`',
      '      categories ?: c.`categories`',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          {
            company: [
              // exact | genuine hallucination
              { name: wrap('Acme'), categories: wrap(['Biotechnology', 'Fintech']) },
            ],
          },
        ],
      },
    ]);
    const attio = makeFakeAdapter('attio');
    const runResult = await runMovement({
      source: CLOSED_MULTISELECT_MOVEMENT,
      event: webhookEvent('email', { text: 'Acme, a biotech company' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
    });
    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme', categories: 'Biotechnology' } },
    ]);
    const extractionEntry = runResult.trace.find((e) => e.kind === 'extraction');
    expect(extractionEntry).toMatchObject({ coerced: { 'company.categories': ['Fintech'] } });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Block meta-nodes — accumulated bindings, aggregates over meta-node edges
// ═════════════════════════════════════════════════════════════════════════════

const META_NODE_MOVEMENT = [
  MOVEMENT_PRELUDE,
  '',
  'movement m(msg: <inbox-[:message]->>) {',
  '  mentioned = extract from [msg.`text`] {',
  '    node company: "each company mentioned" {',
  '      name: "the company\'s name"',
  '    }',
  '  }',
  '',
  '  orgs = mentioned-[c:company]-> {',
  '    return write crm-[:companies]-> {',
  '      unique by (`name`)',
  '      name: c.`name`',
  '    }',
  '  }',
  '',
  '  write team-[:messages]-> {',
  '    channel: "#deals"',
  '    text: "Logged ${COUNT(orgs)} companies. Urls: ${orgs.`url`}"',
  '  }',
  '}',
].join('\n');

describe("a bound block's returned handles aggregate and read", () => {
  it('counts what the iterations returned, and reads a field off them', async () => {
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          { company: [{ name: wrap('Acme') }, { name: wrap('Globex') }] },
        ],
      },
    ]);
    const attio = makeFakeAdapter('attio', {
      createResult: (n) => ({ externalId: `co-${n}`, url: `https://app.attio.com/co-${n}` }),
    });
    const slack = makeFakeAdapter('slack');
    await runMovement({
      source: META_NODE_MOVEMENT,
      event: webhookEvent('email', { text: 'Acme and Globex' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: slack.adapter,
      }),
      llm: llm.client,
    });

    expect(attio.creates.map((c) => c.fields.name)).toEqual(['Acme', 'Globex']);
    expect(slack.creates).toEqual([
      {
        recordType: 'message',
        fields: {
          channel: '#deals',
          text: 'Logged 2 companies. Urls: https://app.attio.com/co-1,https://app.attio.com/co-2',
        },
      },
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Per-position isolation — iteration bindings never leak across positions
// ═════════════════════════════════════════════════════════════════════════════

describe('per-position isolation — each iteration binds its own handles', () => {
  const ISOLATED_MOVEMENT = [
    MOVEMENT_PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  mentioned = extract from [msg.`text`] {',
    '    node company: "each company mentioned" {',
    '      name: "the company\'s name"',
    '    }',
    '  }',
    '  mentioned-[c:company]-> {',
    '    co = write crm-[:companies]-> {',
    '      unique by (`name`)',
    '      name: c.`name`',
    '    }',
    '    write team-[:messages]-> {',
    '      channel: "#deals"',
    '      text: "${c.`name`} -> ${co.externalId}"',
    '    }',
    '  }',
    '}',
  ].join('\n');

  it('pairs each iteration’s extracted entity with that iteration’s own handle', async () => {
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          { company: [{ name: wrap('Acme') }, { name: wrap('Globex') }] },
        ],
      },
    ]);
    const attio = makeFakeAdapter('attio');
    const slack = makeFakeAdapter('slack');
    const result = await runMovement({
      source: ISOLATED_MOVEMENT,
      event: webhookEvent('email', { text: 'Acme and Globex' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: slack.adapter,
      }),
      llm: llm.client,
    });

    // Program order WITHIN each iteration, iterations in emission order.
    expect(result.writes.map((w) => [w.bindingName, w.adapterType, w.recordType])).toEqual([
      ['co', 'attio', 'company'],
      [undefined, 'slack', 'message'],
      ['co', 'attio', 'company'],
      [undefined, 'slack', 'message'],
    ]);
    expect(slack.creates.map((c) => c.fields.text)).toEqual([
      'Acme -> ext-attio-1',
      'Globex -> ext-attio-2',
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Linked writes inside blocks (E3) — each iteration chains off its own handle
// ═════════════════════════════════════════════════════════════════════════════

describe('linked writes inside blocks — per-iteration parent links', () => {
  it('creates the linked record with that iteration’s parent context', async () => {
    const source = [
      MOVEMENT_PRELUDE,
      '',
      'movement m(msg: <inbox-[:message]->>) {',
      '  mentioned = extract from [msg.`text`] {',
      '    node company: "each company mentioned" {',
      '      name: "the company\'s name"',
      '    }',
      '  }',
      '  mentioned-[c:company]-> {',
      '    co = write crm-[:companies]-> {',
      '      unique by (`name`)',
      '      name: c.`name`',
      '    }',
      '    write co-[:notes]-> {',
      '      text: c.`name`',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          { company: [{ name: wrap('Acme') }, { name: wrap('Globex') }] },
        ],
      },
    ]);
    const attio = makeFakeAdapter('attio');
    const parentLinks: unknown[] = [];
    const baseCreate = attio.adapter.createRecord.bind(attio.adapter);
    attio.adapter.createRecord = async (input) => {
      parentLinks.push(input.parentLinks ?? null);
      return baseCreate(input);
    };

    const result = await runMovement({
      source,
      event: webhookEvent('email', { text: 'Acme and Globex' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
    });

    // The note's type is inferred from company's `notes` edge; each
    // iteration's note links to that iteration's company handle.
    expect(result.writes.map((w) => [w.recordType, w.created])).toEqual([
      ['company', true],
      ['note', true],
      ['company', true],
      ['note', true],
    ]);
    // The fake's id counter is shared across creates, so the second
    // iteration's company is ext-attio-3 (the first note took -2).
    expect(parentLinks).toEqual([
      [],
      [{ recordType: 'company', externalId: 'ext-attio-1', edgeName: 'notes', data: {} }],
      [],
      [{ recordType: 'company', externalId: 'ext-attio-3', edgeName: 'notes', data: {} }],
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. EXISTS over extract edges (E6) — quantifying the emission graph
// ═════════════════════════════════════════════════════════════════════════════

const EXTRACT_EXISTS_MOVEMENT = [
  MOVEMENT_PRELUDE,
  '',
  'movement m(msg: <inbox-[:message]->>) {',
  '  deals = extract from [msg.`text`] {',
  "    node company: \"each company mentioned\" {",
  "      name: \"the company's name\"",
  '    }',
  '  }',
  '  if EXISTS(deals-[:company]-> WHERE `name` = "Acme") {',
  '    write team-[:messages]-> { channel: "#alerts", text: "Acme spotted" }',
  '  } else {',
  '    write team-[:messages]-> { channel: "#quiet", text: "no acme" }',
  '  }',
  '}',
].join('\n');

describe('EXISTS over extract edges — emission children as the traversal seam', () => {
  async function runWith(emissions: unknown): Promise<Record<string, unknown>[]> {
    const llm = queuedMovementLlm([{ 'x:extract_result#1': [emissions] }]);
    const slack = makeFakeAdapter('slack');
    await runMovement({
      source: EXTRACT_EXISTS_MOVEMENT,
      event: webhookEvent('email', { text: 'who knows' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: slack.adapter,
      }),
      llm: llm.client,
    });
    return slack.creates.map((c) => c.fields);
  }

  it('true when an emitted entity satisfies the WHERE (read off its fields)', async () => {
    const fields = await runWith({
      company: [{ name: wrap('Globex') }, { name: wrap('Acme') }],
    });
    expect(fields).toEqual([{ channel: '#alerts', text: 'Acme spotted' }]);
  });

  it('false when no emission matches — and on an empty emission set', async () => {
    expect(await runWith({ company: [{ name: wrap('Globex') }] })).toEqual([
      { channel: '#quiet', text: 'no acme' },
    ]);
    expect(await runWith({ company: [] })).toEqual([
      { channel: '#quiet', text: 'no acme' },
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Layer 5 — extracted-node `_resources` provenance + carry-forward write
// ═════════════════════════════════════════════════════════════════════════════
//
// Extract a node FROM a source file → the node's `_resources` IS the source file
// (provenance). Two proofs:
//   (a) writing the extracted node persists the source file as `WriteInput.resources`;
//   (b) walking `extractedNode-[:_resources]->` yields the source FILE position
//       carrying the SAME FileRef, writable to a file field (bytes upload).

const carryFileSchema = (): { catalog: ReturnType<typeof mockCatalog> } => {
  const emailWithFiles: InstanceSchema = {
    positions: { message: { properties: { subject: 'text', text: 'text', deck: 'file' }, edges: {} } },
    collections: {},
    writableRoots: {},
  };
  const attioWithDeck: InstanceSchema = {
    positions: { company: { properties: { name: 'text' }, edges: {} } },
    collections: { companies: { target: 'company' } },
    writableRoots: {
      company: {
        fields: { name: 'text', deck: 'file' },
        resultShape: { externalId: 'text', name: 'text' },
      },
    },
  };
  return {
    catalog: mockCatalog({
      adapters: {
        email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailWithFiles },
        attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: attioWithDeck },
      },
      credentials: {
        dealflow_inbox: { adapters: ['email'] },
        acme_main: { adapters: ['attio'] },
      },
      plugins: { vc_url_retrieval: { args: [] } },
    }),
  };
};

/** An attio fake that captures the FULL WriteInput (fields + resources). */
function makeCapturingAttio(): { adapter: Adapter; creates: import('../../translation_graph/adapter').WriteInput[] } {
  const creates: import('../../translation_graph/adapter').WriteInput[] = [];
  const base = makeFakeAdapter('attio');
  const adapter: Adapter = {
    ...base.adapter,
    async createRecord(input) {
      creates.push(input);
      return { adapterType: 'attio', externalId: `ext-attio-${creates.length}`, data: {} };
    },
  };
  return { adapter, creates };
}

const CARRY_MOVEMENT = [
  'import { email, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  '',
  'movement carry(msg: <inbox-[:message]->>) {',
  '',
  '  deal = extract from [msg.`deck`] {',
  '    name: "the company name in the deck"',
  '  }',
  '',
  '  co = write crm-[:companies]-> {',
  '    unique by (`name`)',
  '    name: deal.`name`',
  '  }',
  '',
  '  deal-[file:_resources]-> {',
  '    write crm-[:companies]-> {',
  '      unique by (`name`)',
  '      name: deal.`name`',
  '      deck: file.`file`',
  '    }',
  '  }',
  '}',
].join('\n');

// Same shape, but the extract reads BOTH the (OCR-empty) file AND a text field,
// and the carry block filters `_resources` to the FILE (the real use case).
// so the extraction still yields a name while the file's only contribution is
// the carry-forward FILE resource (no OCR text).
const CARRY_EMPTY_MOVEMENT = [
  'import { email, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  '',
  'movement carry(msg: <inbox-[:message]->>) {',
  '',
  '  deal = extract from [msg.`deck`, msg.`text`] {',
  '    name: "the company name"',
  '  }',
  '',
  '  co = write crm-[:companies]-> {',
  '    unique by (`name`)',
  '    name: deal.`name`',
  '  }',
  '',
  '  deal-[file:_resources WHERE type = "FILE"]-> {',
  '    write crm-[:companies]-> {',
  '      unique by (`name`)',
  '      name: deal.`name`',
  '      deck: file.`file`',
  '    }',
  '  }',
  '}',
].join('\n');

describe('Layer 5 — extracted-node `_resources` carries the source file forward', () => {
  it('persists the source file as node resources AND writes it to a file field with the FileRef intact', async () => {
    const deckRef = {
      __brand: 'FileRef' as const,
      name: 'pitch.pdf',
      contentType: 'application/pdf',
      size: 4096,
      source: { ownerAdapterType: 'email', handle: 'attachment-pitch' },
      retrieve: async () => ({ stream: {} as never, contentType: 'application/pdf', size: 4096 }),
    };

    // The email adapter returns the deck FileRef for the `deck` field read.
    const email = makeFakeAdapter('email');
    const emailWithFile: Adapter = {
      ...email.adapter,
      async getFieldValue({ fieldId }) {
        return fieldId === 'deck' ? deckRef : undefined;
      },
    };
    const attio = makeCapturingAttio();

    const llm = queuedMovementLlm([{ 'x:extract_result#1': [{ name: wrap('Acme') }] }]);

    await runMovement({
      source: CARRY_MOVEMENT,
      event: webhookEvent('email', { subject: 'Pitch', text: 'see attached', deck: 'ref' }),
      teamId: TEAM_ID,
      catalog: carryFileSchema().catalog,
      resolveAdapter: makeResolver({ email: emailWithFile, attio: attio.adapter }),
      llm: llm.client,
      // Inject the OCR/text seam so the file becomes extractable text.
      resolveFileText: async () => ({ text: 'Acme — Seed round pitch.', rawTextId: 'rt-pitch' }),
    });

    // Two attio creates: the plain company write, and the `_resources` carry write.
    expect(attio.creates).toHaveLength(2);

    // (a) The plain company write persisted the source file as node resources —
    //     the extracted node's `_resources` rode `WriteInput.resources`.
    const plain = attio.creates[0];
    expect(plain.fields).toEqual({ name: 'Acme' });
    const plainFileResources = (plain.resources ?? []).filter((r) => r.type === 'FILE');
    expect(plainFileResources).toHaveLength(1);
    expect(plainFileResources[0].name).toBe('pitch.pdf');
    expect(plainFileResources[0].fileRef).toBe(deckRef); // byte channel preserved

    // (b) The `_resources` carry write set the file field to the source FileRef —
    //     the same FileRef object, so the bytes upload through streamFileRef.
    const carry = attio.creates[1];
    expect(carry.fields.name).toBe('Acme');
    expect(carry.fields.deck).toBe(deckRef);
  });

  it('an OCR-EMPTY source file still becomes a node resource AND carries forward to a file field', async () => {
    // The dev-loop-blocked case: a scanned file whose OCR yields no text. The
    // file feeds the extraction NOTHING, but it is still the source — so it
    // becomes a FILE resource that persists (provenance) and carries forward.
    const deckRef = {
      __brand: 'FileRef' as const,
      name: 'scan.png',
      contentType: 'image/png',
      size: 2048,
      source: { ownerAdapterType: 'email', handle: 'attachment-scan' },
      retrieve: async () => ({ stream: {} as never, contentType: 'image/png', size: 2048 }),
    };

    const email = makeFakeAdapter('email');
    const emailWithFile: Adapter = {
      ...email.adapter,
      async getFieldValue({ fieldId }) {
        if (fieldId === 'deck') return deckRef;
        if (fieldId === 'text') return 'Acme is raising a round.';
        return undefined;
      },
    };
    const attio = makeCapturingAttio();

    // The text field feeds the extraction (the file's OCR is empty); the LLM
    // returns the name from that text.
    const llm = queuedMovementLlm([{ 'x:extract_result#1': [{ name: wrap('Acme') }] }]);

    await runMovement({
      source: CARRY_EMPTY_MOVEMENT,
      event: webhookEvent('email', { subject: 'Acme', text: 'Acme is raising a round.', deck: 'ref' }),
      teamId: TEAM_ID,
      catalog: carryFileSchema().catalog,
      resolveAdapter: makeResolver({ email: emailWithFile, attio: attio.adapter }),
      llm: llm.client,
      // OCR yields nothing — the production resolver answers `no_text` for an
      // empty file (e.g. a scanned image with nothing in it).
      resolveFileText: async () => ({ unreadable: 'no_text' as const }),
    });

    expect(attio.creates).toHaveLength(2);

    // (a) The plain company write STILL persisted the OCR-empty source file as a
    //     node resource — the file is provenance because it is a SOURCE, even
    //     though it contributed no extraction text.
    const plain = attio.creates[0];
    expect(plain.fields).toEqual({ name: 'Acme' });
    const plainFileResources = (plain.resources ?? []).filter((r) => r.type === 'FILE');
    expect(plainFileResources).toHaveLength(1);
    expect(plainFileResources[0].fileRef).toBe(deckRef);
    expect(plainFileResources[0].content).toBeUndefined(); // no OCR text

    // (b) The `_resources` carry write set the file field to the SAME FileRef —
    //     bytes upload through streamFileRef even though OCR yielded nothing.
    const carry = attio.creates[1];
    expect(carry.fields.name).toBe('Acme');
    expect(carry.fields.deck).toBe(deckRef);
  });

  it('the documented `type == "FILE"` filter form selects ONLY the file resource', async () => {
    // The movement language compares with `==` everywhere, and the handbook
    // documents the resource filter that way — the parser must not silently
    // drop the filter (which iterated the TEXT resource into the file write
    // and broke the WhatsApp-voice-note → Attio carry in prod, 2026-07-07).
    const doubleEqualsMovement = CARRY_EMPTY_MOVEMENT.replace(
      '_resources WHERE type = "FILE"',
      '_resources WHERE type == "FILE"',
    );
    expect(doubleEqualsMovement).toContain('type == "FILE"');

    const deckRef = {
      __brand: 'FileRef' as const,
      name: 'voice.ogg',
      contentType: 'audio/ogg',
      size: 2048,
      source: { ownerAdapterType: 'email', handle: 'attachment-voice' },
      retrieve: async () => ({ stream: {} as never, contentType: 'audio/ogg', size: 2048 }),
    };
    const email = makeFakeAdapter('email');
    const emailWithFile: Adapter = {
      ...email.adapter,
      async getFieldValue({ fieldId }) {
        if (fieldId === 'deck') return deckRef;
        if (fieldId === 'text') return 'Acme is raising a round.';
        return undefined;
      },
    };
    const attio = makeCapturingAttio();
    const llm = queuedMovementLlm([{ 'x:extract_result#1': [{ name: wrap('Acme') }] }]);

    await runMovement({
      source: doubleEqualsMovement,
      event: webhookEvent('email', { subject: 'Acme', text: 'Acme is raising a round.', deck: 'ref' }),
      teamId: TEAM_ID,
      catalog: carryFileSchema().catalog,
      resolveAdapter: makeResolver({ email: emailWithFile, attio: attio.adapter }),
      llm: llm.client,
      resolveFileText: async () => ({ unreadable: 'no_text' as const }),
    });

    // Exactly two creates: the plain write + ONE carry write for the FILE
    // resource. A dropped filter would iterate the TEXT resource too (a third
    // create with an empty file field).
    expect(attio.creates).toHaveLength(2);
    expect(attio.creates[1].fields.deck).toBe(deckRef);
  });

  it('the WHERE is a real expression — resource fields and AND compose', async () => {
    // Under the retired regex parser only `type`/`mimeType`/`namePattern`
    // key=value pairs parsed; now the hop's WHERE rides the same parser as
    // every other bracket filter (contentType read, AND composition, ==).
    const composed = CARRY_EMPTY_MOVEMENT.replace(
      '_resources WHERE type = "FILE"',
      '_resources WHERE contentType == "audio/ogg" AND type == "FILE"',
    );
    expect(composed).toContain('contentType == "audio/ogg"');

    const deckRef = {
      __brand: 'FileRef' as const,
      name: 'voice.ogg',
      contentType: 'audio/ogg',
      size: 2048,
      source: { ownerAdapterType: 'email', handle: 'attachment-voice' },
      retrieve: async () => ({ stream: {} as never, contentType: 'audio/ogg', size: 2048 }),
    };
    const email = makeFakeAdapter('email');
    const emailWithFile: Adapter = {
      ...email.adapter,
      async getFieldValue({ fieldId }) {
        if (fieldId === 'deck') return deckRef;
        if (fieldId === 'text') return 'Acme is raising a round.';
        return undefined;
      },
    };
    const attio = makeCapturingAttio();
    const llm = queuedMovementLlm([{ 'x:extract_result#1': [{ name: wrap('Acme') }] }]);

    await runMovement({
      source: composed,
      event: webhookEvent('email', { subject: 'Acme', text: 'Acme is raising a round.', deck: 'ref' }),
      teamId: TEAM_ID,
      catalog: carryFileSchema().catalog,
      resolveAdapter: makeResolver({ email: emailWithFile, attio: attio.adapter }),
      llm: llm.client,
      resolveFileText: async () => ({ unreadable: 'no_text' as const }),
    });

    expect(attio.creates).toHaveLength(2);
    expect(attio.creates[1].fields.deck).toBe(deckRef);
  });
});

// Files a `through` plugin fetched are sources too: a deck behind a link in the
// message lands on the extracted record's `_resources` exactly as an attached
// deck does, so the same carry block attaches it.
describe('Layer 5 — files a `through` plugin fetched join `_resources`', () => {
  const FETCHED_MOVEMENT = [
    'import { email, attio } from adapters',
    'import { dealflow_inbox, acme_main } from credentials',
    'import { vc_url_retrieval } from plugins',
    '',
    'inbox = email(credentials: dealflow_inbox)',
    'crm   = attio(credentials: acme_main)',
    '',
    'movement carry(msg: <inbox-[:message]->>) {',
    '  deal = extract from [msg.`text`] through [vc_url_retrieval] {',
    '    name: "the company name"',
    '  }',
    '',
    '  co = write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name: deal.`name`',
    '  }',
    '',
    '  deal-[r:_resources WHERE type == "FILE"]-> {',
    '    write crm-[:companies]-> {',
    '      unique by (`name`)',
    '      name: r.`url`',
    '      deck: r.`file`',
    '    }',
    '  }',
    '}',
  ].join('\n');

  let run: jest.SpyInstance;
  beforeEach(() => {
    registerBundledTransforms();
    const impl = getTransform('vc-url-retrieval');
    if (!impl) throw new Error('test: vc-url-retrieval is not registered');
    run = jest.spyOn(impl, 'run');
    storedDocuments.clear();
    storedDocuments.set('doc-1', {
      id: 'doc-1',
      description: 'Acme deck.pdf',
      objectUri: 's3://bucket/uuid-1/Acme deck.pdf',
    });
  });
  afterEach(() => run.mockRestore());

  async function runFetched(emissions: Array<Record<string, unknown>>, languageVersion?: number) {
    run.mockResolvedValue({ edges: { vcUrl: emissions.map((data) => ({ data })) } });
    const email = makeFakeAdapter('email');
    const attio = makeCapturingAttio();
    const llm = queuedMovementLlm([{ 'x:extract_result#1': [{ name: wrap('Acme') }] }]);
    await runMovement({
      source: FETCHED_MOVEMENT,
      event: webhookEvent('email', { subject: 'Deck', text: 'deck: https://docsend.example/acme' }),
      teamId: TEAM_ID,
      catalog: carryFileSchema().catalog,
      resolveAdapter: makeResolver({ email: email.adapter, attio: attio.adapter }),
      llm: llm.client,
      ...(languageVersion !== undefined ? { languageVersion } : {}),
    });
    return { creates: attio.creates, llm };
  }

  it('a fetched deck is a FILE resource carrying the stored document, and its text still reaches the model', async () => {
    const { creates, llm } = await runFetched([
      {
        name: 'Acme deck.pdf',
        url: 'https://docsend.example/acme',
        file: 'doc-1',
        text: 'Acme builds rockets.',
      },
    ]);

    expect(llm.calls[0].userMessage).toContain('Acme builds rockets.');

    // The plain write carries the fetched deck as one of the record's sources.
    expect(creates).toHaveLength(2);
    const [fileResource] = (creates[0].resources ?? []).filter((r) => r.type === 'FILE');
    expect(fileResource).toMatchObject({
      type: 'FILE',
      name: 'Acme deck.pdf',
      url: 'https://docsend.example/acme',
      data: { name: 'Acme deck.pdf', url: 'https://docsend.example/acme', type: 'FILE' },
    });
    expect(fileResource.fileRef).toMatchObject({
      __brand: 'FileRef',
      name: 'Acme deck.pdf',
      source: { ownerAdapterType: DOCUMENT_STORE_OWNER, handle: 's3://bucket/uuid-1/Acme deck.pdf' },
    });
    expect((fileResource.data as { file: unknown }).file).toBe(fileResource.fileRef);

    // The carry block reads it exactly as it reads an attached file.
    expect(creates[1].fields.name).toBe('https://docsend.example/acme');
    expect(creates[1].fields.deck).toBe(fileResource.fileRef);
  });

  it('under language version 1, a fetched file stays off `_resources` — they held the sources alone', async () => {
    const { creates, llm } = await runFetched(
      [{ name: 'Acme deck.pdf', url: 'https://docsend.example/acme', file: 'doc-1', text: 'Acme builds rockets.' }],
      1,
    );

    expect(llm.calls[0].userMessage).toContain('Acme builds rockets.');
    expect(creates).toHaveLength(1);
    expect((creates[0].resources ?? []).filter((r) => r.type === 'FILE')).toEqual([]);
  });

  it('a page that stored no file adds no resource, and its text still reaches the model', async () => {
    const { creates, llm } = await runFetched([
      { name: 'https://acme.example', url: 'https://acme.example', file: null, text: 'Acme home.' },
    ]);

    expect(llm.calls[0].userMessage).toContain('Acme home.');
    expect(creates).toHaveLength(1);
    expect((creates[0].resources ?? []).filter((r) => r.type === 'FILE')).toEqual([]);
  });
});

// ── registryTransformInvoker: kind dispatch + output translation ────────────
// The production default invoker (run.ts falls back to it). Guards the
// regression where every plugin was dispatched as `context-dependent` and only
// `properties` were read — which silently no-op'd pre-extraction, edge-emitting
// plugins like vc_url_retrieval (they throw on the wrong kind, and their
// fetched text rides on edges, not properties).
describe('registryTransformInvoker dispatch', () => {
  const seenKind: Record<string, TransformInput['kind'] | undefined> = {};

  beforeAll(() => {
    const preImpl: TransformImpl = {
      signature: {
        name: '__test_pre',
        description: 'pre-extraction fake',
        params: [],
        dataDependency: 'none',
        additions: {},
      },
      run: async (input) => {
        seenKind.pre = input.kind;
        return {
          edges: {
            fetched: [
              { data: { url: 'https://x', text: 'PAGE ONE' } },
              { data: { url: 'https://y', text: 'PAGE TWO' } },
            ],
          },
        };
      },
    };
    const ctxImpl: TransformImpl = {
      signature: {
        name: '__test_ctx',
        description: 'context-dependent fake',
        params: [],
        dataDependency: 'extracted_context',
        additions: { properties: { added: { kind: 'string' } } },
      },
      run: async (input) => {
        seenKind.ctx = input.kind;
        return { properties: { added: 'value' } };
      },
    };
    const throwImpl: TransformImpl = {
      signature: {
        name: '__test_throw',
        description: 'always throws',
        params: [],
        dataDependency: 'none',
        additions: {},
      },
      run: async () => {
        throw new Error('boom');
      },
    };
    // A plugin that attached nothing but has something to say about why.
    const outcomeImpl: TransformImpl = {
      signature: {
        name: '__test_outcome',
        description: 'reports an outcome and attaches nothing',
        params: [],
        dataDependency: 'extracted_context',
        additions: {},
      },
      run: async () => ({ outcome: 'no_match' }),
    };
    registerTransform(preImpl);
    registerTransform(ctxImpl);
    registerTransform(throwImpl);
    registerTransform(outcomeImpl);
  });

  it('dispatches a pre-extraction plugin with pre-extraction input and pipes its edge-text into result.text', async () => {
    const result = await registryTransformInvoker.invoke({
      plugin: '__test_pre',
      config: { content: 'source' },
      extractedContext: {},
    });
    expect(seenKind.pre).toBe('pre-extraction');
    expect(result.text).toBe('PAGE ONE\n\nPAGE TWO');
    expect(result.data).toBeUndefined();
  });

  it('dispatches a context-dependent plugin with context-dependent input and returns its properties as data', async () => {
    const result = await registryTransformInvoker.invoke({
      plugin: '__test_ctx',
      config: {},
      extractedContext: { name: 'Ada' },
    });
    expect(seenKind.ctx).toBe('context-dependent');
    expect(result.data).toEqual({ added: 'value' });
    expect(result.text).toBeUndefined();
  });

  it('carries a plugin’s declared outcome back with its result', async () => {
    const result = await registryTransformInvoker.invoke({
      plugin: '__test_outcome',
      config: {},
      extractedContext: {},
    });
    expect(result).toEqual({ outcome: 'no_match' });
  });

  it('turns a throwing plugin into an empty result rather than failing the run', async () => {
    const result = await registryTransformInvoker.invoke({
      plugin: '__test_throw',
      config: { content: 'source' },
      extractedContext: {},
    });
    expect(result).toEqual({});
  });

  it('returns an empty result for an unknown plugin', async () => {
    const result = await registryTransformInvoker.invoke({
      plugin: '__does_not_exist',
      config: {},
      extractedContext: {},
    });
    expect(result).toEqual({});
  });
});

// ── Ancestor context threading to a nested-node plugin ──────────────────────
// A person nested inside a company: the person's `through` plugin must see the
// company's fields (namespaced `company_name`), so an enrichment like
// linkedin can search by person + company rather than a bare first name.
const NESTED_ANCESTOR_MOVEMENT = [
  MOVEMENT_PRELUDE,
  'import { vc_url_retrieval } from plugins',
  '',
  'movement intake(msg: <inbox-[:message]->>) {',
  '  found = extract from [msg.`text`] {',
  '    node company: "the company" {',
  '      name: "the company\'s name"',
  '',
  '      node person: "each person at the company" {',
  '        name: "the person\'s full name"',
  '      } through [vc_url_retrieval] {',
  '        name:    "the person\'s full name"',
  '        website: "the person\'s website"',
  '      }',
  '    }',
  '  }',
  '  found-[c:company]-> {',
  '    write crm-[:companies]-> { unique by (`name`) name: c.`name` }',
  '  }',
  '}',
].join('\n');

describe('ancestor context threading to a nested-node plugin', () => {
  const event = webhookEvent('email', { text: 'Ada works at Acme.' });

  it('feeds a nested node plugin its ancestor fields, namespaced by node name', async () => {
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          { company: [{ name: wrap('Acme'), person: [{ name: wrap('Ada') }] }] },
        ],
      },
      // The person's post-plugin stage — its extracted values don't matter to
      // this assertion (the plugin runs, and is captured, before this call),
      // but it still has to ANSWER: an empty array, not an empty object.
      { 'x:person#4': [] },
    ]);

    const invocations: Array<{ plugin: string; extractedContext: Record<string, unknown> }> = [];
    const transformInvoker: MovementTransformInvoker = {
      async invoke(input) {
        invocations.push({ plugin: input.plugin, extractedContext: input.extractedContext });
        return {};
      },
    };

    await runMovement({
      source: NESTED_ANCESTOR_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      transformInvoker,
      dryRun: true,
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0].plugin).toBe('vc_url_retrieval');
    // The person's own `name` stays at the top level; the company's fields
    // arrive nested under `company` — structurally separable from own fields.
    expect(invocations[0].extractedContext).toEqual({
      company: { name: 'Acme' },
      name: 'Ada',
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Independent work overlaps
// ═════════════════════════════════════════════════════════════════════════════
//
// What the planner walks is a tree of independent work — one entity's stages
// read that entity's own fields, and a stage's plugins read none of each
// other's output — with exactly two orderings the semantics depend on: a
// node's stage N before its stage N+1, and a parent's stage before the fenced
// children of that stage. Everything else overlaps, bounded, and is READ back
// in the order it was written.

describe('independent extraction work runs at once', () => {
  const event = webhookEvent('email', {
    text: 'Gondor (gondor.fi) and Rohan (rohan.fi) are both worth a look.',
  });

  it('runs two sibling entities’ stage plugins at the same time', async () => {
    const llm = keyedMovementLlm((input) => {
      const about = askedAbout(input, ['Gondor', 'Rohan']);
      if (!about) {
        return [
          {
            company: [
              { name: wrap('Gondor'), website: wrap('gondor.fi') },
              { name: wrap('Rohan'), website: wrap('rohan.fi') },
            ],
          },
        ];
      }
      return [{ summary: wrap(`what ${about} does`) }];
    });

    const started: string[] = [];
    const held = deferred<void>();
    const transformInvoker: MovementTransformInvoker = {
      async invoke(input) {
        started.push(String(input.config.url));
        await held.promise;
        return { text: `Fetched ${String(input.config.url)}.` };
      },
    };

    const run = runMovement({
      source: PER_ENTITY_FETCH_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      transformInvoker,
      dryRun: true,
    });

    // Neither fetch has answered yet, and BOTH are already in flight — the
    // whole claim. Serially the second could not have started.
    await settle();
    expect(started.sort()).toEqual(['gondor.fi', 'rohan.fi']);

    held.resolve();
    await run;

    // And both companies' stages then read what their own fetch brought back.
    expect(llm.calls).toHaveLength(3);
    const asked = llm.calls.slice(1).map((c) => askedAbout(c, ['Gondor', 'Rohan']));
    expect(asked.sort()).toEqual(['Gondor', 'Rohan']);
  });

  it('renders a stage’s enrichments in declaration order, whatever order they land in', async () => {
    const llm = keyedMovementLlm((input) =>
      askedAbout(input, ['Gondor'])
        ? [{ summary: wrap('Forges rings') }]
        : [{ company: [{ name: wrap('Gondor'), website: wrap('gondor.fi') }] }],
    );

    // `vc_url_retrieval` is written FIRST and answers LAST: it waits on the
    // plugin declared after it.
    const fetched = deferred<void>();
    const transformInvoker: MovementTransformInvoker = {
      async invoke({ plugin }) {
        if (plugin === 'fetch_url') {
          fetched.resolve();
          return { text: 'the page' };
        }
        await fetched.promise;
        return { text: 'the retrieved links' };
      },
    };

    const result = await runMovement({
      source: TWO_PLUGIN_STAGE_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      transformInvoker,
      dryRun: true,
    });

    const prompt = llm.calls[1].userMessage;
    expect(prompt.indexOf('## ENRICHMENT via `vc_url_retrieval`')).toBeGreaterThan(-1);
    expect(prompt.indexOf('## ENRICHMENT via `vc_url_retrieval`')).toBeLessThan(
      prompt.indexOf('## ENRICHMENT via `fetch_url`'),
    );

    // The trace reads the same way — the author's order, not the fetches'.
    expect(result.trace.flatMap((e) => (e.kind === 'plugin' ? [e.plugin] : []))).toEqual([
      'vc_url_retrieval',
      'fetch_url',
    ]);
  });

  it('keeps the fan bounded, and finishes every entity in it', async () => {
    const named = ['gondor', 'rohan', 'shire', 'moria', 'lorien', 'bree'];
    const llm = keyedMovementLlm((input) => {
      const about = askedAbout(input, named);
      if (!about) {
        return [{ company: named.map((n) => ({ name: wrap(n), website: wrap(`${n}.fi`) })) }];
      }
      return [{ summary: wrap(`what ${about} does`) }];
    });

    let inFlight = 0;
    let peak = 0;
    const transformInvoker: MovementTransformInvoker = {
      async invoke(input) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await settle();
        inFlight--;
        return { text: `Fetched ${String(input.config.url)}.` };
      },
    };

    const attio = makeFakeAdapter('attio');
    await runMovement({
      source: PER_ENTITY_FETCH_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      transformInvoker,
    });

    expect(peak).toBe(STAGE_FAN_OUT);
    // Bounded, not dropped: all six were fetched, all six were re-extracted,
    // all six were written.
    expect(llm.calls).toHaveLength(named.length + 1);
    expect(attio.creates.map((c) => c.fields.name)).toEqual(named);
  });

  it('a fenced child still sees the parent it belongs to, not a sibling’s', async () => {
    const llm = keyedMovementLlm((input) => {
      const about = askedAbout(input, ['Ada', 'Grace']);
      if (!about) {
        return [
          {
            company: [
              { name: wrap('Acme'), person: [{ name: wrap('Ada') }] },
              { name: wrap('Initech'), person: [{ name: wrap('Grace') }] },
            ],
          },
        ];
      }
      return [{ name: wrap(about), website: wrap(`${about}.example`) }];
    });

    const invocations: Array<Record<string, unknown>> = [];
    const transformInvoker: MovementTransformInvoker = {
      async invoke(input) {
        invocations.push(input.extractedContext);
        await settle();
        return { text: 'a profile' };
      },
    };

    await runMovement({
      source: NESTED_ANCESTOR_MOVEMENT,
      event: webhookEvent('email', { text: 'Ada works at Acme. Grace works at Initech.' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      transformInvoker,
      dryRun: true,
    });

    // Both people's plugins overlap, and each one carries its OWN company —
    // the ordering the fan is not allowed to break.
    invocations.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(invocations).toEqual([
      { company: { name: 'Acme' }, name: 'Ada' },
      { company: { name: 'Initech' }, name: 'Grace' },
    ]);
  });
});

// ── Truncated LLM output must fail the call, not salvage into null fields ────

describe('the Anthropic-backed extraction client', () => {
  // Cut off mid-entity: the last field's value never arrived.
  const TRUNCATED_BODY =
    '{"x:extract_result#1":[{"name":{"evidence":"q","value":"Acme"},"summary":';

  const detailed = anthropicChatDetailed as jest.Mock;
  const callInput = {
    system: 's',
    userMessage: 'u',
    label: 'extract_companies',
    model: 'sonnet' as const,
  };

  beforeEach(() => {
    detailed.mockReset();
    (logger.warn as jest.Mock).mockClear();
    delete process.env.EXTRACTION_OUTPUT_BUDGET;
  });
  afterEach(() => {
    delete process.env.EXTRACTION_OUTPUT_BUDGET;
  });

  it('raises, naming the label, when the reply was truncated', async () => {
    detailed.mockResolvedValueOnce({
      text: TRUNCATED_BODY,
      stopReason: 'max_tokens',
      truncated: true,
      continuations: 5,
      thinkingOnly: false,
    });

    await expect(makeAnthropicLlmClient().call(callInput)).rejects.toThrow(
      /truncated.*extract_companies|extract_companies.*truncated/is,
    );
  });

  it('logs the partial reply — output size, entities parsed, and tail — before raising', async () => {
    detailed.mockResolvedValueOnce({
      text: TRUNCATED_BODY,
      stopReason: 'max_tokens',
      truncated: true,
      continuations: 5,
      thinkingOnly: false,
    });

    await expect(makeAnthropicLlmClient().call(callInput)).rejects.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      '[extraction] truncated',
      expect.objectContaining({
        label: 'extract_companies',
        estimatedOutputTokens: expect.any(Number),
        // The repaired partial still has the one entity it got through.
        entitiesParsed: 1,
        tail: expect.stringContaining('Acme'),
      }),
    );
  });

  // Sonnet 5 is not expected to loop, so by default the guard is off: every
  // extraction spends the flat ceiling and the chat wrapper's own
  // continuation default, whatever the input's size.
  describe('with EXTRACTION_OUTPUT_BUDGET unset (the default)', () => {
    it('spends the flat ceiling and leaves continuations to the wrapper default', async () => {
      detailed.mockResolvedValueOnce({ text: '{}', stopReason: 'end_turn', truncated: false });

      const bigInput = { ...callInput, userMessage: 'x'.repeat(40_000) };
      await makeAnthropicLlmClient().call(bigInput);

      expect(detailed).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 32_000 }));
      expect(detailed.mock.calls[0][0]).not.toHaveProperty('maxContinuations');
    });

    it('names the flat ceiling and the continuations the wrapper actually spent, and says the guard was off', async () => {
      detailed.mockResolvedValueOnce({
        text: TRUNCATED_BODY,
        stopReason: 'max_tokens',
        truncated: true,
        continuations: 5,
        thinkingOnly: false,
        maxTokens: 32_000,
      });

      await expect(makeAnthropicLlmClient().call(callInput)).rejects.toThrow(
        /32000-token output ceiling.*5 continuations \(EXTRACTION_OUTPUT_BUDGET off\)/s,
      );
    });
  });

  // The failure this names: a morning-recap run whose model spent the whole
  // 32k ceiling thinking at `xhigh` and wrote nothing. The error blamed "5
  // continuations" — the ceiling the wrapper was ALLOWED, not the zero it
  // actually attempted — and sent its readers looking for a long answer that
  // was never written.
  describe('when the model spent the whole ceiling thinking', () => {
    const thinkingOnlyReply = {
      text: '',
      stopReason: 'max_tokens' as const,
      truncated: true,
      continuations: 0,
      thinkingOnly: true,
      effort: 'high' as const,
      maxTokens: 64_000,
    };

    it('says so — the ceiling, the depth it was thinking at, and that no text came back', async () => {
      detailed.mockResolvedValueOnce(thinkingOnlyReply);

      await expect(
        makeAnthropicLlmClient().call({ ...callInput, effort: 'xhigh', maxTokens: 64_000 }),
      ).rejects.toThrow(
        /spent the whole 64000-token output ceiling thinking at effort high and produced no text/,
      );
    });

    it('counts the continuations it took, not the ones it was allowed', async () => {
      detailed.mockResolvedValueOnce(thinkingOnlyReply);

      await expect(
        makeAnthropicLlmClient().call({ ...callInput, effort: 'xhigh', maxTokens: 64_000 }),
      ).rejects.toThrow(/0 continuations/);
    });
  });

  // The runaway this bounds: a 2.6k-token input generated 53.7k output tokens
  // over 7½ minutes, because nothing in the request tied the size of the answer
  // to the size of the question. Setting the flag restores that leash.
  describe('with EXTRACTION_OUTPUT_BUDGET=1', () => {
    beforeEach(() => {
      process.env.EXTRACTION_OUTPUT_BUDGET = '1';
    });

    it('sizes the output budget from the input, not from a flat ceiling', async () => {
      detailed.mockResolvedValueOnce({ text: '{}', stopReason: 'end_turn', truncated: false });

      // ~10k tokens of source text — big enough to clear the floor.
      const bigInput = { ...callInput, userMessage: 'x'.repeat(40_000) };
      await makeAnthropicLlmClient().call(bigInput);

      const { maxTokens, maxContinuations } = detailed.mock.calls[0][0];
      expect(maxTokens).toBeGreaterThan(8_000);
      expect(maxTokens).toBeLessThan(53_717);
      expect(maxContinuations).toBe(1);
    });

    it('still gives a tiny input a floor to answer in', async () => {
      detailed.mockResolvedValueOnce({ text: '{}', stopReason: 'end_turn', truncated: false });

      await makeAnthropicLlmClient().call(callInput);

      expect(detailed).toHaveBeenCalledWith(
        expect.objectContaining({ maxTokens: 8_000, maxContinuations: 1 }),
      );
    });

    it('caps the budget however large the input gets', async () => {
      detailed.mockResolvedValueOnce({ text: '{}', stopReason: 'end_turn', truncated: false });

      await makeAnthropicLlmClient().call({ ...callInput, userMessage: 'x'.repeat(4_000_000) });

      expect(detailed).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 32_000 }));
    });

    it('names the proportional ceiling and the one-continuation count in the truncation error, and says the guard was on', async () => {
      detailed.mockResolvedValueOnce({
        text: TRUNCATED_BODY,
        stopReason: 'max_tokens',
        truncated: true,
        continuations: 1,
        thinkingOnly: false,
        maxTokens: 8_000,
      });

      await expect(makeAnthropicLlmClient().call(callInput)).rejects.toThrow(
        /8000-token output ceiling.*1 continuation \(EXTRACTION_OUTPUT_BUDGET on\)/s,
      );
    });
  });

  // `true` reads the same as `1`.
  it('also switches on for EXTRACTION_OUTPUT_BUDGET=true', async () => {
    process.env.EXTRACTION_OUTPUT_BUDGET = 'true';
    detailed.mockResolvedValueOnce({ text: '{}', stopReason: 'end_turn', truncated: false });

    await makeAnthropicLlmClient().call(callInput);

    expect(detailed).toHaveBeenCalledWith(expect.objectContaining({ maxContinuations: 1 }));
  });

  // Extraction transcribes; it does not reason. The adaptive-thinking models
  // reason at effort `high` when nobody says otherwise, and each continuation
  // buys another whole budget — together that is where the 53.7k went. The
  // depth now travels ON the call (the tier mapping decides it), so the client
  // forwards what it is given, independent of the budget guard.
  it('forwards the caller’s reasoning depth', async () => {
    detailed.mockResolvedValueOnce({ text: '{}', stopReason: 'end_turn', truncated: false });

    await makeAnthropicLlmClient().call({ ...callInput, effort: 'low' });

    expect(detailed).toHaveBeenCalledWith(expect.objectContaining({ effort: 'low' }));
  });

  // Silence is a caller's answer too: no effort means the model's own depth,
  // and defaulting one here would make every call an extraction.
  it('names no depth for a caller that named none', async () => {
    detailed.mockResolvedValueOnce({ text: '{}', stopReason: 'end_turn', truncated: false });

    await makeAnthropicLlmClient().call(callInput);

    expect(detailed.mock.calls[0][0]).not.toHaveProperty('effort');
  });

  // The most expensive tier spends a flat budget instead of the one sized from
  // the input — a short question may deserve a long answer. Wins over the
  // guard either way.
  it('lets the caller replace the input-proportional ceiling', async () => {
    detailed.mockResolvedValueOnce({ text: '{}', stopReason: 'end_turn', truncated: false });

    await makeAnthropicLlmClient().call({ ...callInput, maxTokens: 32_000 });

    expect(detailed).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 32_000 }));
  });

  // What the raise is protecting against: the salvage path repairs the same
  // body into a well-formed entity whose unfinished field is simply `null`.
  it('would otherwise hand back an entity with a silently nulled field', async () => {
    detailed.mockResolvedValueOnce({
      text: TRUNCATED_BODY,
      stopReason: 'max_tokens',
      truncated: false,
    });

    const { parsedJson } = await makeAnthropicLlmClient().call(callInput);
    const [entity] = (parsedJson as Record<string, Array<Record<string, { value?: unknown }>>>)[
      'x:extract_result#1'
    ];

    expect(entity.name.value).toBe('Acme');
    expect(entity.summary ?? null).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Presence — an unproduced TEXT field is `""`; an unproduced typed field is absent
// ═════════════════════════════════════════════════════════════════════════════
//
// Models answer `""` for a field they found nothing for about as readily as
// they answer `null`, so the two are collapsed into one fact. Which fact
// depends on the field's type. Text has a value that means "nothing found" —
// the empty string — so a text field nobody found reaches the program as `""`
// and reads as present (the checker types it `text`, not `text | absent`),
// which is what lets it be printed or written with no `COALESCE(x, "")`. A
// number, a date, a choice from a set has no such value, so it stays absent.

const PRESENCE_MOVEMENT = [
  MOVEMENT_PRELUDE,
  '',
  'movement m(msg: <inbox-[:message]->>) {',
  '  deals = extract from [msg.`text`] {',
  '    node company: "each company mentioned" {',
  '      name:  "the company\'s name"',
  '      stage: <text> "the funding stage, e.g. Seed"',
  '      note:  "anything else said about it"',
  '      size:  <number> "the round size in dollars"',
  '    }',
  '  }',
  '  deals-[c:company]-> {',
  '    if c.`stage` == "" {',
  '      write team-[:messages]-> { channel: "#missing", text: "[${c.`note`}]" }',
  '    } else {',
  '      write team-[:messages]-> { channel: "#found", text: c.`stage` }',
  '    }',
  '    if ISNULL(c.`size`) {',
  '      write team-[:messages]-> { channel: "#no-size", text: c.`name` }',
  '    }',
  '  }',
  '}',
].join('\n');

describe('an unproduced text field is the empty string; a typed one is absent', () => {
  async function runWith(companies: unknown[]): Promise<Record<string, unknown>[]> {
    const llm = queuedMovementLlm([{ 'x:extract_result#1': [{ company: companies }] }]);
    const slack = makeFakeAdapter('slack');
    await runMovement({
      source: PRESENCE_MOVEMENT,
      event: webhookEvent('email', { text: 'who knows' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: slack.adapter,
      }),
      llm: llm.client,
    });
    return slack.creates.map((c) => c.fields);
  }

  it('a declared <text> field answered blank, null or not at all reads as ""', async () => {
    for (const stage of [wrap(''), wrap(null), wrap('  \n '), undefined]) {
      expect(
        await runWith([{ name: wrap('Acme'), ...(stage ? { stage } : {}), size: wrap(5) }]),
      ).toEqual([{ channel: '#missing', text: '[]' }]);
    }
  });

  it('the inline shortcut interpolates as nothing when it was not found', async () => {
    expect(await runWith([{ name: wrap('Acme'), stage: wrap(''), note: wrap('  '), size: wrap(5) }])).toEqual([
      { channel: '#missing', text: '[]' },
    ]);
  });

  it('a real value is untouched', async () => {
    expect(await runWith([{ name: wrap('Acme'), stage: wrap('Seed'), size: wrap(5) }])).toEqual([
      { channel: '#found', text: 'Seed' },
    ]);
  });

  it('a typed field nobody found stays absent', async () => {
    expect(await runWith([{ name: wrap('Acme'), stage: wrap('Seed') }])).toEqual([
      { channel: '#found', text: 'Seed' },
      { channel: '#no-size', text: 'Acme' },
    ]);
  });

  it('counts a blank-only entity as empty in the trace, and drops it, exactly as an all-null one', async () => {
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          {
            company: [
              { name: wrap(''), stage: wrap('   ') },
              { name: wrap('Globex'), stage: wrap('A'), size: wrap(1) },
            ],
          },
        ],
      },
    ]);
    const slack = makeFakeAdapter('slack');
    const runResult = await runMovement({
      source: PRESENCE_MOVEMENT,
      event: webhookEvent('email', { text: 'who knows' }),
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: slack.adapter,
      }),
      llm: llm.client,
    });
    expect(runResult.trace.find((e) => e.kind === 'extraction')).toMatchObject({
      empty: { company: 1 },
    });
    expect(slack.creates.map((c) => c.fields)).toEqual([{ channel: '#found', text: 'A' }]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. A record with no value in ANY field is dropped, never emitted all-null
// ═════════════════════════════════════════════════════════════════════════════
//
// Production evidence: a staged extract emitted one
// all-null record, which then rode downstream as a real position — a write with
// every field null, a fan-out iteration over nothing, and a second stage that
// re-asked the model about an entity carrying no facts. The handbook has always
// promised the opposite ("a record with no value in any of its fields is
// dropped rather than emitted all-null"); only the PROMPT asked for it, and a
// prompt is a request, not a guarantee.

/** The `through`-free twin of PER_ENTITY_FETCH_MOVEMENT — same node, same
 *  fields, same descriptions. Its only difference is the fenced stage. */
const ONE_STAGE_FETCH_MOVEMENT = [
  MOVEMENT_PRELUDE,
  '',
  'movement intake(msg: <inbox-[:message]->>) {',
  '  deals = extract from [msg.`text`] {',
  '    node company: "each company mentioned" {',
  '      name:    "the company\'s name"',
  '      website: "the company\'s web address"',
  '    }',
  '  }',
  '  deals-[c:company]-> {',
  '    write crm-[:companies]-> {',
  '      unique by (`name`)',
  '      name:    c.`name`',
  '      summary: c.`website`',
  '    }',
  '  }',
  '}',
].join('\n');

describe('an all-null record is dropped rather than emitted', () => {
  const event = webhookEvent('email', {
    text: 'Gondor (gondor.fi) and Rohan are both worth a look.',
  });

  async function intake(
    source: string,
    responses: unknown[],
  ): Promise<{
    calls: LlmCallInput[];
    writes: Record<string, unknown>[];
    plugins: Array<{ plugin: string; config: Record<string, unknown> }>;
    trace: Awaited<ReturnType<typeof runMovement>>['trace'];
  }> {
    const llm = queuedMovementLlm(responses);
    const attio = makeFakeAdapter('attio');
    const plugins: Array<{ plugin: string; config: Record<string, unknown> }> = [];
    const result = await runMovement({
      source,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      transformInvoker: {
        async invoke(input) {
          plugins.push({ plugin: input.plugin, config: input.config });
          return { text: 'a page about that company' };
        },
      },
    });
    return { calls: llm.calls, writes: attio.creates.map((c) => c.fields), plugins, trace: result.trace };
  }

  it('never writes the empty record, and still writes its siblings', async () => {
    const { writes } = await intake(ONE_STAGE_FETCH_MOVEMENT, [
      {
        'x:extract_result#1': [
          {
            company: [
              { name: wrap(null), website: wrap(null) },
              { name: wrap('Gondor'), website: wrap('gondor.fi') },
            ],
          },
        ],
      },
    ]);

    expect(writes).toEqual([{ name: 'Gondor', summary: 'gondor.fi' }]);
  });

  // An entity whose keys NOTHING declared is not an empty record — it is a
  // record the engine could not read, and section 11 raises on it. The rule
  // here is about a record whose DECLARED keys came back valueless.
  it('drops an entity whose declared fields are all blank, alongside a real sibling', async () => {
    const { writes } = await intake(ONE_STAGE_FETCH_MOVEMENT, [
      {
        'x:extract_result#1': [
          {
            company: [
              { name: wrap('   '), website: wrap('') },
              { name: wrap('Gondor'), website: wrap('gondor.fi') },
            ],
          },
        ],
      },
    ]);

    expect(writes).toEqual([{ name: 'Gondor', summary: 'gondor.fi' }]);
  });

  // The expensive half: an empty record used to reach the fenced stage, where
  // it paid for a plugin run and a second model call to ask about an entity
  // carrying no facts.
  it('never reaches the next stage — no plugin run, no continuation call', async () => {
    const { calls, plugins, writes } = await intake(PER_ENTITY_FETCH_MOVEMENT, [
      { 'x:extract_result#1': [{ company: [{ name: wrap(null), website: wrap(null) }] }] },
      { 'x:company#3': [{ summary: wrap('should never be asked for') }] },
    ]);

    expect(plugins).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(writes).toEqual([]);
  });

  it('still counts what it dropped, so the run can say the model found nothing', async () => {
    const { trace } = await intake(ONE_STAGE_FETCH_MOVEMENT, [
      { 'x:extract_result#1': [{ company: [{ name: wrap(null), website: wrap(null) }] }] },
    ]);

    expect(trace.find((e) => e.kind === 'extraction')).toMatchObject({ empty: { company: 1 } });
  });

  // Why the report's "the staged path swallows stage 1" reading is wrong: the
  // fenced stage is resolved per entity AFTER the first call, so it cannot
  // reach the first call's request at all. Pinned, because the alternative is
  // hunting the fence again next time a first stage comes back empty.
  it('the fenced stage does not change the first call at all', async () => {
    const staged = await intake(PER_ENTITY_FETCH_MOVEMENT, [
      { 'x:extract_result#1': [{ company: [] }] },
    ]);
    const plain = await intake(ONE_STAGE_FETCH_MOVEMENT, [
      { 'x:extract_result#1': [{ company: [] }] },
    ]);

    expect(staged.calls[0].system).toEqual(plain.calls[0].system);
    expect(staged.calls[0].userMessage).toEqual(plain.calls[0].userMessage);
  });
});

describe('a response that never answers the question is an error, not an empty extraction', () => {
  const event = webhookEvent('email', { text: 'Acme is raising a Seed.' });

  // `{}` satisfied the response schema — the answer key was optional — so a
  // model that ignored the question read as "extracted nothing" and the run
  // carried on. A schema failure is a schema failure: retried once, then
  // raised, so it reaches the run instead of vanishing.
  it('raises when the answer key is missing from both the first reply and the retry', async () => {
    const llm = queuedMovementLlm([{}, {}]);

    await expect(
      runMovement({
        source: PRESENCE_MOVEMENT,
        event,
        teamId: TEAM_ID,
        catalog: movementCatalog,
        resolveAdapter: makeResolver({
          email: makeFakeAdapter('email').adapter,
          attio: makeFakeAdapter('attio').adapter,
          slack: makeFakeAdapter('slack').adapter,
        }),
        llm: llm.client,
      }),
    ).rejects.toThrow();

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].userMessage).toContain('validation errors');
  });

  it('an extraction that genuinely found nothing says so — an empty array, no error', async () => {
    const llm = queuedMovementLlm([{ 'x:extract_result#1': [{ company: [] }] }]);
    const slack = makeFakeAdapter('slack');

    await runMovement({
      source: PRESENCE_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: slack.adapter,
      }),
      llm: llm.client,
    });

    expect(slack.creates).toEqual([]);
    expect(llm.calls).toHaveLength(1);
  });
});

// An empty key is no key. A text nobody found is handed over as "", and two
// records that both lack a name are not thereby the same record — so a blank
// identity component reaches the adapter's search as null, which every
// adapter reads as "cannot match on this", and the engine's own exactness
// check never counts two blanks as equal.
describe('a unique-by key that came back empty matches nothing', () => {
  const event = webhookEvent('email', { text: 'two unnamed companies' });
  const UNNAMED = { adapterType: 'attio', externalId: 'existing-unnamed', data: { name: '' } };

  it('two writes with an empty name create two records, never merging with an existing unnamed one', async () => {
    const searched: Array<Record<string, unknown>> = [];
    // A naive search that would happily match "" against the unnamed record
    // already there — and, like every real adapter, finds nothing on null.
    const attio = makeFakeAdapter('attio', {
      resolveCandidates: (record) => {
        searched.push(record);
        return record.name == null ? [] : [UNNAMED];
      },
    });
    const llm = queuedMovementLlm([
      {
        'x:extract_result#1': [
          {
            company: [
              { name: wrap(''), website: wrap('one.fi') },
              { name: wrap('  '), website: wrap('two.fi') },
            ],
          },
        ],
      },
    ]);
    await runMovement({
      source: ONE_STAGE_FETCH_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
    });

    expect(searched.map((r) => r.name)).toEqual([null, null]);
    expect(attio.updates).toEqual([]);
    expect(attio.creates.map((c) => c.fields)).toEqual([
      { name: '', summary: 'one.fi' },
      { name: '', summary: 'two.fi' },
    ]);
  });

  it('a candidate whose key is empty is never an exact match for an empty asserted key', () => {
    const constraints = { any: [{ all: [{ field: 'name' }] }] };
    expect(candidateIsAllExact(constraints, { name: '' }, { name: '' })).toBe(false);
    expect(candidateIsAllExact(constraints, { name: null }, { name: null })).toBe(false);
    expect(candidateIsAllExact(constraints, { name: 'Acme' }, { name: 'acme' })).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. What the run record says about an extraction that misbehaved
// ═════════════════════════════════════════════════════════════════════════════
//
// The all-null incident above was diagnosed entirely from a run's own history,
// and the archaeology it took is the point of this section: which call read
// 6.2k characters and which read 1.2k, whether the model was asked twice, and
// what it actually replied when it "found nothing", were none of them on the
// record. They are now — bounded, and only where something went wrong.

describe('an extraction call describes itself on the run', () => {
  const event = webhookEvent('email', {
    text: 'Gondor (gondor.fi) and Rohan are both worth a look.',
  });

  async function intake(
    source: string,
    responses: unknown[],
    options?: {
      runId?: string;
      fetchedChars?: number;
      /** The client answered one effort lower than it was asked to. */
      steppedDown?: { from: string; to: string };
      /** The client stitched the answer together out of this many
       *  continuation turns after running past its output ceiling. */
      continuations?: number;
    },
  ): Promise<{
    calls: LlmCallInput[];
    trace: Awaited<ReturnType<typeof runMovement>>['trace'];
  }> {
    const queued = queuedMovementLlm(responses);
    const steppedDown = options?.steppedDown;
    const continuations = options?.continuations;
    const boundary =
      steppedDown !== undefined || continuations !== undefined
        ? {
            ...(steppedDown ? { effortSteppedDown: steppedDown } : {}),
            ...(continuations !== undefined ? { continuations } : {}),
          }
        : undefined;
    const llm = {
      calls: queued.calls,
      client: boundary
        ? {
            async call(input: LlmCallInput): Promise<LlmCallResult> {
              return { ...(await queued.client.call(input)), ...boundary };
            },
          }
        : queued.client,
    };
    const fire = () =>
      runMovement({
        source,
        event,
        teamId: TEAM_ID,
        catalog: movementCatalog,
        resolveAdapter: makeResolver({
          email: makeFakeAdapter('email').adapter,
          attio: makeFakeAdapter('attio').adapter,
          slack: makeFakeAdapter('slack').adapter,
        }),
        llm: llm.client,
        transformInvoker: {
          async invoke() {
            return { text: 'p'.repeat(options?.fetchedChars ?? 24) };
          },
        },
      });
    // A real firing establishes the run context around everything it calls;
    // only inside one can a log line name the run it belongs to.
    const result = options?.runId
      ? await new LlmUsageContext({
          teamId: TEAM_ID as unknown as string,
          triggerRunId: options.runId,
        }).runAsync(fire)
      : await fire();
    return { calls: llm.calls, trace: result.trace };
  }

  function extractions(trace: Awaited<ReturnType<typeof runMovement>>['trace']) {
    return trace.filter((e) => e.kind === 'extraction');
  }

  // (a) The healthy call. Everything here is the baseline a later reader
  //     compares an anomalous call against — and the reply is NOT kept.
  it('a healthy call records what it read, which model read it, and nothing the model said', async () => {
    const { trace } = await intake(ONE_STAGE_FETCH_MOVEMENT, [
      {
        'x:extract_result#1': [{ company: [{ name: wrap('Gondor'), website: wrap('gondor.fi') }] }],
      },
    ]);

    const entry = extractions(trace)[0];
    expect(entry).toMatchObject({
      kind: 'extraction',
      node: 'extract result',
      emissions: { 'extract result': 1 },
      inputs: [{ classification: 'TEXT', chars: expect.any(Number) }],
    });
    expect(entry).toHaveProperty('model');
    expect(entry).toHaveProperty('durationMs');
    expect(entry).not.toHaveProperty('reply');
    expect(entry).not.toHaveProperty('retried');
    expect(entry).not.toHaveProperty('dropped');
    expect(entry).not.toHaveProperty('failed');
    expect(entry).not.toHaveProperty('effortSteppedDown');
    expect(entry).not.toHaveProperty('continued');
    expect(entry).not.toHaveProperty('continuations');
  });

  // A call that answered only because it was asked less deeply is not the call
  // the author paid for, and the difference shows up as a thinner answer. It
  // sits next to the model, which is the other half of "what answered this".
  it('records that a call was answered one effort lower than it was asked', async () => {
    const { trace } = await intake(
      ONE_STAGE_FETCH_MOVEMENT,
      [{ 'x:extract_result#1': [{ company: [{ name: wrap('Gondor') }] }] }],
      { steppedDown: { from: 'xhigh', to: 'high' } },
    );

    expect(extractions(trace)[0]).toMatchObject({
      model: expect.any(String),
      effortSteppedDown: { from: 'xhigh', to: 'high' },
    });
  });

  // The incident this exists for: an answer too long for one ceiling is fed
  // back with "continue where you left off", the stitched text parses, and the
  // last fifteen records of a transcript are gone with nothing anywhere saying
  // so. The entry is the only thing that can say it.
  it('records that an answer was continued past its output ceiling', async () => {
    (logger.warn as jest.Mock).mockClear();
    const { trace } = await intake(
      ONE_STAGE_FETCH_MOVEMENT,
      [{ 'x:extract_result#1': [{ company: [{ name: wrap('Gondor') }] }] }],
      { continuations: 2 },
    );

    expect(extractions(trace)[0]).toMatchObject({ continued: true, continuations: 2 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ran past its output ceiling'),
      expect.objectContaining({
        node: 'extract result',
        continuations: 2,
        inputChars: expect.any(Number),
      }),
    );
  });

  it('a call that never had to continue says nothing about continuing', async () => {
    const { trace } = await intake(
      ONE_STAGE_FETCH_MOVEMENT,
      [{ 'x:extract_result#1': [{ company: [{ name: wrap('Gondor') }] }] }],
      { continuations: 0 },
    );

    expect(extractions(trace)[0]).not.toHaveProperty('continued');
  });

  it('the input shape adds up to the total, so two sibling calls are comparable', async () => {
    const { trace } = await intake(ONE_STAGE_FETCH_MOVEMENT, [
      { 'x:extract_result#1': [{ company: [{ name: wrap('Gondor') }] }] },
    ]);

    const entry = extractions(trace)[0];
    if (entry.kind !== 'extraction') throw new Error('unreachable');
    const parts = entry.inputs ?? [];
    expect(parts.length).toBeGreaterThan(0);
    // The parts are joined with a blank line between them.
    const joined = parts.reduce((sum, p) => sum + p.chars, 0) + 2 * (parts.length - 1);
    expect(joined).toBe(entry.inputChars);
  });

  // (b) The incident, replayed. A record the model answered with nothing in
  //     it is dropped, and without the digest the run says only "found
  //     nothing", which is what sent us digging.
  it('a dropped record keeps the reply, and the reply names the key the model answered under', async () => {
    const { trace } = await intake(ONE_STAGE_FETCH_MOVEMENT, [
      { 'x:extract_result#1': [{ company: [{ name: wrap(null), website: wrap(null) }] }] },
    ]);

    const entry = extractions(trace)[0];
    expect(entry).toMatchObject({
      empty: { company: 1 },
      dropped: { company: 1 },
      reply: { why: ['dropped_records'], keys: ['x:extract_result#1'] },
    });
    if (entry.kind !== 'extraction') throw new Error('unreachable');
    expect(entry.reply?.sample).toContain('website');
  });

  it('a call that yielded nothing at all keeps the reply too', async () => {
    const { trace } = await intake(ONE_STAGE_FETCH_MOVEMENT, [{ 'x:extract_result#1': [] }]);

    expect(extractions(trace)[0]).toMatchObject({
      emissions: { 'extract result': 0 },
      reply: { why: ['no_entities'] },
    });
  });

  it('the retry says what it was asked to fix, and keeps the reply that caused it', async () => {
    const { trace, calls } = await intake(ONE_STAGE_FETCH_MOVEMENT, [
      // No answer key: the schema rejects, the engine asks again.
      { por_favor: [] },
      { 'x:extract_result#1': [{ company: [{ name: wrap('Gondor') }] }] },
    ]);

    expect(calls).toHaveLength(2);
    const entry = extractions(trace)[0];
    if (entry.kind !== 'extraction') throw new Error('unreachable');
    expect(entry.retried?.[0]).toContain('x:extract_result#1');
    expect(entry.reply?.why).toEqual(['retried']);
    // The digest is of the reply that SUCCEEDED — the issues describe the
    // one that didn't, so between them both attempts are readable.
    expect(entry.reply?.keys).toEqual(['x:extract_result#1']);
  });

  // The end of the road the answer-key fix opened: asked twice, still
  // unanswered, so the run fails — naming which call, and pointing at the
  // digest it just attached.
  it('a call that is never answered fails the run by name, with the reply on the trace', async () => {
    const failure = await runMovement({
      source: PRESENCE_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      // A reply of `{}` twice: the model never answered the question.
      llm: queuedMovementLlm([{}, {}]).client,
    }).then(
      () => {
        throw new Error('test: the run should have failed');
      },
      (error: unknown) => error,
    );

    // The message is what lands in the run's `failure_reason`, so it has to
    // stand on its own: which call, which node, and where to look next.
    expect(failure).toBeInstanceOf(MovementRunFailed);
    const carrier = failure as MovementRunFailed;
    expect(runFailureCause(carrier)).toBeInstanceOf(MovementEngineError);
    expect(carrier.message).toMatch(/extraction of `extract result` \(x:extract_result#1\)/);
    expect(carrier.message).toMatch(/trace holds the first/);

    const entry = extractions(carrier.partial.trace).at(-1);
    expect(entry).toMatchObject({
      failed: 'invalid_reply',
      emissions: { 'extract result': 0 },
      reply: { why: ['failed'] },
    });
    if (entry?.kind !== 'extraction') throw new Error('unreachable');
    expect(entry.retried?.[0]).toContain('x:extract_result#1');
  });

  // A fifty-entity reply rejected at its forty-sixth record is unreadable from
  // the head of the body: the first thousand characters are all healthy
  // entities, and the one the schema complained about is nowhere in them. The
  // rejection names a path, so the trace follows it.
  it('keeps the entity the rejection named, not the head of a long reply', async () => {
    const healthy = (name: string) => ({ name: wrap(name), website: wrap(`${name}.fi`) });
    const wrong = [
      ...Array.from({ length: 45 }, (_, i) => healthy(`Gondor${i}`)),
      { nombre: wrap('Numenor') },
    ];
    const reply = { 'x:extract_result#1': [{ company: wrong }] };

    const failure = await runMovement({
      source: ONE_STAGE_FETCH_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: queuedMovementLlm([reply, reply]).client,
    }).then(
      () => {
        throw new Error('test: the run should have failed');
      },
      (error: unknown) => error,
    );

    const carrier = failure as MovementRunFailed;
    const entry = extractions(carrier.partial.trace).at(-1);
    if (entry?.kind !== 'extraction') throw new Error('unreachable');
    expect(entry.reply?.path).toBe('x:extract_result#1.0.company.45');
    expect(entry.reply?.sample).toContain('Numenor');
    // The proof it is the named entity and not the head: the head is Gondor0.
    expect(entry.reply?.sample).not.toContain('Gondor0');
    // And the message sends the reader to that entity rather than to a
    // thousand characters that do not hold it.
    expect(carrier.message).toContain('the entity at `x:extract_result#1.0.company.45`');
  });

  // The renaming above is narrow on purpose: a call can die of a truncated
  // body or a dead network too, and those already say what happened. Calling
  // one of them "the model answered wrongly" would send the next reader after
  // the wrong thing entirely.
  it('a call that died of something other than the schema keeps its own error', async () => {
    await expect(
      runMovement({
        source: PRESENCE_MOVEMENT,
        event,
        teamId: TEAM_ID,
        catalog: movementCatalog,
        resolveAdapter: makeResolver({
          email: makeFakeAdapter('email').adapter,
          attio: makeFakeAdapter('attio').adapter,
          slack: makeFakeAdapter('slack').adapter,
        }),
        llm: {
          call: async () => {
            throw new Error('the model hit the output ceiling');
          },
        },
      }),
    ).rejects.toThrow('the model hit the output ceiling');
  });

  // The budget. A fan-out asks once per entity, so a systematically confused
  // model would otherwise attach one digest per entity; the sixth says
  // nothing the first five didn't.
  it('keeps at most a handful of replies per run, however many calls misbehave', async () => {
    const companies = ['a', 'b', 'c', 'd', 'e', 'f'];
    const { trace } = await intake(PER_ENTITY_FETCH_MOVEMENT, [
      {
        'x:extract_result#1': [
          {
            company: companies.map((n) => ({ name: wrap(n), website: wrap(`${n}.fi`) })),
          },
        ],
      },
      // Every continuation answers under nothing the guide named.
      ...companies.map((_, i) => ({ [`x:company#${i + 3}`]: [] })),
    ]);

    const withReply = extractions(trace).filter(
      (e) => e.kind === 'extraction' && e.reply !== undefined,
    );
    expect(withReply).toHaveLength(5);
    expect(extractions(trace).length).toBeGreaterThan(5);
  });

  // (c) The seven-minute fetch. A plugin logs its own progress, but a log
  //     line is not attached to a run — so the invocation goes on the trace,
  //     with the URL and how long it took.
  it('a plugin invocation is on the run: which plugin, which url, how long, how much came back', async () => {
    const { trace } = await intake(
      PER_ENTITY_FETCH_MOVEMENT,
      [
        {
          'x:extract_result#1': [
            { company: [{ name: wrap('Gondor'), website: wrap('https://gondor.fi') }] },
          ],
        },
        { 'x:company#3': [{ summary: wrap('a realm') }] },
      ],
      { fetchedChars: 4242 },
    );

    expect(trace.filter((e) => e.kind === 'plugin')).toEqual([
      {
        kind: 'plugin',
        plugin: 'fetch_url',
        node: 'company',
        url: 'https://gondor.fi',
        durationMs: expect.any(Number),
        chars: 4242,
      },
    ]);
  });

  it('a plugin that never ran says which argument was empty', async () => {
    const { trace } = await intake(PER_ENTITY_FETCH_MOVEMENT, [
      {
        'x:extract_result#1': [{ company: [{ name: wrap('Rohan'), website: wrap(null) }] }],
      },
      { 'x:company#3': [{ summary: wrap('a realm') }] },
    ]);

    expect(trace.filter((e) => e.kind === 'plugin')).toEqual([
      { kind: 'plugin', plugin: 'fetch_url', node: 'company', durationMs: 0, skippedParam: 'url' },
    ]);
  });

  it('a plugin log line names the run it belongs to', async () => {
    (logger.info as jest.Mock).mockClear();
    await intake(
      PER_ENTITY_FETCH_MOVEMENT,
      [
        {
          'x:extract_result#1': [{ company: [{ name: wrap('Rohan'), website: wrap(null) }] }],
        },
        { 'x:company#3': [{ summary: wrap('a realm') }] },
      ],
      { runId: 'run-0001' },
    );

    expect(logger.info as jest.Mock).toHaveBeenCalledWith(
      expect.stringContaining('[movement:transform]'),
      expect.objectContaining({ plugin: 'fetch_url', runId: 'run-0001' }),
    );
  });

  it('the same line carries no run id outside a firing — it does not invent one', async () => {
    (logger.info as jest.Mock).mockClear();
    await intake(PER_ENTITY_FETCH_MOVEMENT, [
      {
        'x:extract_result#1': [{ company: [{ name: wrap('Rohan'), website: wrap(null) }] }],
      },
      { 'x:company#3': [{ summary: wrap('a realm') }] },
    ]);

    const call = (logger.info as jest.Mock).mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('[movement:transform]'),
    );
    expect(call?.[1]).not.toHaveProperty('runId');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. A node's records answered inside a `{ evidence, value }` pair
// ═════════════════════════════════════════════════════════════════════════════
//
// Production evidence: the model extracted the whole
// list CORRECTLY and then wrapped it — the per-field `{ evidence, value }`
// pair, applied to the node's list as well as to its leaves. `.passthrough()`
// read the envelope as ONE record carrying two keys nothing declared, every
// declared field projected to null, and the drop rule then threw a good
// extraction away. The records inside were right; only the packaging was
// wrong, so the packaging is what gets undone.

const WRAPPED_LIST_MOVEMENT = [
  MOVEMENT_PRELUDE,
  '',
  'movement watch(msg: <inbox-[:message]->>) {',
  '  found = extract from [msg.`text`] {',
  '    node entry: "each LinkedIn or company line in the message" {',
  '      name:        "the name on the line"',
  '      url:         "the link on the line"',
  '      kind:        "person or company"',
  '      posted_by:   "who posted the line"',
  '      flag_reason: "why the line was flagged"',
  '    }',
  '  }',
  '  found-[e:entry]-> {',
  '    write crm-[:companies]-> {',
  '      unique by (`name`)',
  '      name:    e.`name`',
  '      summary: e.`flag_reason`',
  '    }',
  '    write team-[:messages]-> {',
  '      channel: e.`kind`',
  '      text:    e.`url`',
  '    }',
  '    write team-[:messages]-> {',
  '      channel: "#posts"',
  '      text:    e.`posted_by`',
  '    }',
  '  }',
  '}',
].join('\n');

/** One record of the production reply, with its five fields as the model
 *  actually wrote them. */
const FLINTT = {
  name: wrap('Flintt'),
  url: wrap('https://www.linkedin.com/company/flintt'),
  kind: wrap('company'),
  posted_by: wrap('U0TESTUSER01'),
  flag_reason: wrap('fintech, London, Series A'),
};

describe('a node list answered inside an evidence envelope is unwrapped, not discarded', () => {
  const event = webhookEvent('email', {
    text: 'Flintt — https://www.linkedin.com/company/flintt — posted by U0TESTUSER01',
  });

  async function watch(
    responses: unknown[],
    source: string = WRAPPED_LIST_MOVEMENT,
  ): Promise<{
    calls: LlmCallInput[];
    companies: Record<string, unknown>[];
    messages: Record<string, unknown>[];
  }> {
    const llm = queuedMovementLlm(responses);
    const attio = makeFakeAdapter('attio');
    const slack = makeFakeAdapter('slack');
    await runMovement({
      source,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: slack.adapter,
      }),
      llm: llm.client,
    });
    return {
      calls: llm.calls,
      companies: attio.creates.map((c) => c.fields),
      messages: slack.creates.map((c) => c.fields),
    };
  }

  // The exact production reply: the node's key holds `{ evidence, value }`,
  // with the real record list under `value`.
  it('keeps every field of the record the envelope was hiding', async () => {
    const { companies, messages } = await watch([
      {
        'x:extract_result#1': [
          {
            entry: {
              evidence: 'the entire list of LinkedIn/company lines under U0TESTUSER01',
              value: [FLINTT],
            },
          },
        ],
      },
    ]);

    expect(companies).toEqual([{ name: 'Flintt', summary: 'fintech, London, Series A' }]);
    expect(messages).toEqual([
      { channel: 'company', text: 'https://www.linkedin.com/company/flintt' },
      { channel: '#posts', text: 'U0TESTUSER01' },
    ]);
  });

  it('takes the reply as written — no validation error, so no second call', async () => {
    const { calls } = await watch([
      {
        'x:extract_result#1': [{ entry: { evidence: 'the whole list', value: [FLINTT] } }],
      },
    ]);

    expect(calls).toHaveLength(1);
  });

  // The same mistake, made one level up: the answer key itself holds the pair.
  it('unwraps the envelope at the answer key, not only at a child node', async () => {
    const { companies } = await watch([
      {
        'x:extract_result#1': {
          evidence: 'the whole message',
          value: [{ entry: [FLINTT] }],
        },
      },
    ]);

    expect(companies).toEqual([{ name: 'Flintt', summary: 'fintech, London, Series A' }]);
  });

  // The same mistake made about a single record rather than a list.
  it('unwraps a single wrapped record too', async () => {
    const { companies } = await watch([
      { 'x:extract_result#1': [{ entry: { evidence: 'the one line', value: FLINTT } }] },
    ]);

    expect(companies).toEqual([{ name: 'Flintt', summary: 'fintech, London, Series A' }]);
  });

  // The envelope is recognised by SHAPE, so a node that declares a field
  // called `value` would be ambiguous — its own record reads as an envelope.
  // The node's declared keys break the tie: they win.
  it('never unwraps a node that declares a field called `value`', async () => {
    const gauge = [
      MOVEMENT_PRELUDE,
      '',
      'movement gauge(msg: <inbox-[:message]->>) {',
      '  readings = extract from [msg.`text`] {',
      '    node reading: "each reading in the message" {',
      '      value:    "the number read"',
      '      evidence: "where it was read"',
      '    }',
      '  }',
      '  readings-[r:reading]-> {',
      '    write team-[:messages]-> {',
      '      channel: r.`evidence`',
      '      text:    r.`value`',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const { messages, calls } = await watch(
      [
        {
          'x:extract_result#1': [
            { reading: { value: wrap('42'), evidence: wrap('the north gauge') } },
          ],
        },
      ],
      gauge,
    );

    expect(calls).toHaveLength(1);
    expect(messages).toEqual([{ channel: 'the north gauge', text: '42' }]);
  });

  // Belt and braces: the parser tolerates the envelope, and the prompt stops
  // asking for it in the first place.
  it('the guide says a node list is a bare array and only a field is wrapped', async () => {
    const { calls } = await watch([
      { 'x:extract_result#1': [{ entry: { evidence: 'the whole list', value: [FLINTT] } }] },
    ]);

    expect(calls[0].system).toContain('bare JSON array');
    expect(calls[0].system).toMatch(/`\{ evidence, value \}` (wrapping )?belongs to a FIELD/);
  });
});

describe('an entity answered entirely under keys nothing declared is a shape error', () => {
  const event = webhookEvent('email', {
    text: 'Gondor (gondor.fi) and Rohan are both worth a look.',
  });

  async function intake(responses: unknown[]): Promise<{
    calls: LlmCallInput[];
    failure: unknown;
  }> {
    const llm = queuedMovementLlm(responses);
    const failure = await runMovement({
      source: ONE_STAGE_FETCH_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
    }).then(
      () => {
        throw new Error('test: the run should have failed');
      },
      (error: unknown) => error,
    );
    return { calls: llm.calls, failure };
  }

  // Until now this reply was indistinguishable from "the model found nothing":
  // every declared field projected to null and the record was dropped in
  // silence. A record made ENTIRELY of keys nobody declared is not an empty
  // record, it is an unread one — so it takes the road every other schema
  // failure takes.
  it('is retried once with the key named, then raised', async () => {
    const nombre = { 'x:extract_result#1': [{ company: [{ nombre: wrap('Gondor') }] }] };
    const { calls, failure } = await intake([nombre, nombre]);

    expect(calls).toHaveLength(2);
    expect(calls[1].userMessage).toContain('validation errors');
    expect(calls[1].userMessage).toContain('nombre');
    expect(failure).toBeInstanceOf(MovementRunFailed);
    const carrier = failure as MovementRunFailed;
    expect(runFailureCause(carrier)).toBeInstanceOf(MovementEngineError);
    expect(carrier.message).toContain('nombre');
  });

  // The answer key was right — saying "the reply came back under X, not X"
  // would send the next reader after the wrong thing.
  it('says the reply answered under the right key and the entity under the wrong ones', async () => {
    const nombre = { 'x:extract_result#1': [{ company: [{ nombre: wrap('Gondor') }] }] };
    const { failure } = await intake([nombre, nombre]);

    const message = (failure as MovementRunFailed).message;
    expect(message).toContain('answered under `x:extract_result#1`');
    expect(message).not.toMatch(/not `x:extract_result#1`/);
    const trace = (failure as MovementRunFailed).partial.trace;
    const entry = trace.filter((e) => e.kind === 'extraction').at(-1);
    expect(entry).toMatchObject({ failed: 'invalid_reply', reply: { why: ['failed'] } });
    if (entry?.kind !== 'extraction') throw new Error('unreachable');
    expect(entry.reply?.sample).toContain('nombre');
  });

  // The other half of the rule, unchanged: a record whose DECLARED keys are
  // all valueless is a genuine empty, and the handbook has always promised it
  // is dropped quietly rather than raised.
  it('leaves a genuine all-null record alone — declared keys, no values, quiet drop', async () => {
    const llm = queuedMovementLlm([
      { 'x:extract_result#1': [{ company: [{ name: wrap(null), website: wrap(null) }] }] },
    ]);
    const attio = makeFakeAdapter('attio');

    await runMovement({
      source: ONE_STAGE_FETCH_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
    });

    expect(llm.calls).toHaveLength(1);
    expect(attio.creates).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. A field's EVIDENCE is provenance, not the answer
// ═════════════════════════════════════════════════════════════════════════════
//
// Production evidence: a ~50-entity extraction — some 750 fields —
// failed on `entry.49.flag_reason.evidence: expected string, received
// undefined`, was asked again, and failed on `entry.45.sourced_by.evidence:
// expected string, received object`. Twelve minutes of work thrown away over
// the packaging of two citations, while every value in the reply was right.
//
// So the citation half is read tolerantly and the VALUE half stays exactly as
// strict as it was: a wrong value is a wrong answer, and still earns the retry.

describe('a field answered without a usable citation still answers', () => {
  const span: Span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };

  const extract: ExtractExpression = {
    from: [{ raw: 'text', span }],
    stages: [
      {
        fields: [
          { name: 'name', description: desc('the name on the line', span), span },
          { name: 'flag_reason', description: desc('why the line was flagged', span), span },
        ],
        children: [],
        span,
      },
    ],
    span,
  };

  /** One entity, answered as written, through the real materializer — the
   *  emission carries the citations (`provenance`) the trace cannot show. */
  async function answered(entity: Record<string, unknown>) {
    const llm = queuedMovementLlm([{ 'x:extract_result#1': [entity] }]);
    const trace: MovementTraceEntry[] = [];
    const spec = await buildExtractSpec(extract);
    const emission = await materializeExtract({
      extract,
      spec,
      runtime: {
        llm: llm.client,
        transformInvoker: {
          async invoke() {
            throw new Error('test: nothing to invoke');
          },
        },
        evalSlot: async () => ({
          value: 'Flintt — fintech, London, Series A',
          provenance: NO_PROVENANCE,
        }),
        trace,
      },
    });
    const entry = trace.find((e) => e.kind === 'extraction');
    if (entry?.kind !== 'extraction') throw new Error('test: no extraction entry');
    return { emission, calls: llm.calls, entry, key: `${spec.name}.flag_reason` };
  }

  it('keeps the value of a field that came back with no `evidence` key at all', async () => {
    const { emission, calls, entry } = await answered({
      name: wrap('Flintt'),
      flag_reason: { value: 'fintech, London, Series A' },
    });

    expect(emission.fields.flag_reason).toBe('fintech, London, Series A');
    expect(calls).toHaveLength(1);
    // A citation nobody wrote is not a citation normalised away.
    expect(entry).not.toHaveProperty('evidenceCoerced');
  });

  it('keeps the quote out of a citation written as an object, and says it did', async () => {
    const { emission, calls, entry, key } = await answered({
      name: wrap('Flintt'),
      flag_reason: { evidence: { quote: 'fintech, London, Series A' }, value: 'fintech' },
    });

    expect(calls).toHaveLength(1);
    expect(emission.fields.flag_reason).toBe('fintech');
    expect(emission.provenance.flag_reason).toMatchObject({
      quote: 'fintech, London, Series A',
    });
    expect(entry.evidenceCoerced).toEqual({
      [key]: ['{"quote":"fintech, London, Series A"}'],
    });
  });

  // Two strings would be a guess and a number is not a quote — the value comes
  // through either way, and the field is simply left uncited.
  it('leaves a field uncited when the citation holds no single quote', async () => {
    const { emission, calls, entry, key } = await answered({
      name: wrap('Flintt'),
      flag_reason: { evidence: { a: 1, b: 2 }, value: 'fintech' },
    });

    expect(calls).toHaveLength(1);
    expect(emission.fields.flag_reason).toBe('fintech');
    expect(emission.provenance.flag_reason).not.toHaveProperty('quote');
    expect(entry.evidenceCoerced).toEqual({ [key]: ['{"a":1,"b":2}'] });
  });

  // The other half of the rule: nothing here loosened the ANSWER. A field
  // written without the wrapper at all is still a reply the guide does not
  // describe, and takes the road it always did.
  it('still asks again when the answer itself is not what the guide describes', async () => {
    const llm = queuedMovementLlm([
      { 'x:extract_result#1': [{ name: wrap('Flintt'), flag_reason: 'fintech' }] },
      { 'x:extract_result#1': [{ name: wrap('Flintt'), flag_reason: wrap('fintech') }] },
    ]);

    const emission = await materializeExtract({
      extract,
      spec: await buildExtractSpec(extract),
      runtime: {
        llm: llm.client,
        transformInvoker: {
          async invoke() {
            throw new Error('test: nothing to invoke');
          },
        },
        evalSlot: async () => ({ value: 'Flintt — fintech', provenance: NO_PROVENANCE }),
      },
    });

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].userMessage).toContain('flag_reason');
    expect(emission.fields.flag_reason).toBe('fintech');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. The ENVELOPE the answer sits in, when the model got it wrong
// ═════════════════════════════════════════════════════════════════════════════
//
// Production, on a morning-recap run: a per-entity refinement
// answered with the field map bare at the top level — `{ name: { evidence,
// value }, … }` where the guide asked for `{ "x:entry#26": [ … ] }` — and,
// asked again, with an ARRAY of those maps. Every value in both replies was
// right; only the packaging was missing. A run makes 40-85 of these calls, so
// a per-call drift of a percent makes losing the whole run the expected
// outcome, and three production runs died that way in one day.
//
// So a reply whose STRUCTURE says what it is gets its envelope rebuilt around
// it. The content still faces the full entity schema afterwards — the salvage
// only changes where the content sits.

describe('a reply that answered outside the envelope is re-wrapped, not rejected', () => {
  const span: Span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };

  const extract: ExtractExpression = {
    from: [{ raw: 'text', span }],
    stages: [
      {
        fields: [
          { name: 'name', description: desc('the name on the line', span), span },
          { name: 'flag_reason', description: desc('why the line was flagged', span), span },
        ],
        children: [],
        span,
      },
    ],
    span,
  };

  /** The reply as written, through the real materializer. */
  async function answered(...replies: unknown[]) {
    const llm = queuedMovementLlm(replies);
    const trace: MovementTraceEntry[] = [];
    const emission = await materializeExtract({
      extract,
      spec: await buildExtractSpec(extract),
      runtime: {
        llm: llm.client,
        transformInvoker: {
          async invoke() {
            throw new Error('test: nothing to invoke');
          },
        },
        evalSlot: async () => ({
          value: 'Flintt — fintech, London, Series A',
          provenance: NO_PROVENANCE,
        }),
        trace,
      },
    });
    const entry = trace.find((e) => e.kind === 'extraction');
    if (entry?.kind !== 'extraction') throw new Error('test: no extraction entry');
    return { emission, calls: llm.calls, entry };
  }

  const FLAGGED = { name: wrap('Flintt'), flag_reason: wrap('fintech, London, Series A') };

  // (a) The first of the two production shapes.
  it('reads a bare field map as the one record it is, and says the envelope was missing', async () => {
    const { emission, calls, entry } = await answered(FLAGGED);

    expect(emission.fields).toEqual({ name: 'Flintt', flag_reason: 'fintech, London, Series A' });
    // No validation error, so no second call — which is the whole point.
    expect(calls).toHaveLength(1);
    expect(entry.envelopeRepaired).toBe('a bare record');
  });

  // (b) The second — what the retry answered with when the first was rejected.
  it('reads a bare list of field maps as the records they are', async () => {
    const { emission, calls, entry } = await answered([FLAGGED]);

    expect(emission.fields.name).toBe('Flintt');
    expect(calls).toHaveLength(1);
    expect(entry.envelopeRepaired).toBe('a bare list of records');
  });

  // (c) The model kept an envelope but wrote its own label on it.
  it('re-keys a list answered under a label the model chose', async () => {
    const { emission, calls, entry } = await answered({ found: [FLAGGED] });

    expect(emission.fields.name).toBe('Flintt');
    expect(calls).toHaveLength(1);
    expect(entry.envelopeRepaired).toBe('keyed `found`');
  });

  // Two keys is a guess about which of them the answer is, and a guess is not
  // a structural reading.
  it('leaves a reply with two foreign keys alone', async () => {
    const { calls } = await answered(
      { found: [FLAGGED], notes: 'and some commentary' },
      { 'x:extract_result#1': [FLAGGED] },
    );

    expect(calls).toHaveLength(2);
  });

  // (d) The salvage recognises records, not "anything that isn't the key".
  it.each([
    ['an empty object', {}],
    ['an empty list', []],
    ['a list of strings', ['Flintt']],
    ['a record of keys nothing declares', { nombre: wrap('Flintt') }],
    ['a foreign key over a foreign record', { found: [{ nombre: wrap('Flintt') }] }],
  ])('still asks again when the reply is %s', async (_shape, reply) => {
    const { calls, entry } = await answered(reply, { 'x:extract_result#1': [FLAGGED] });

    expect(calls).toHaveLength(2);
    expect(entry).not.toHaveProperty('envelopeRepaired');
  });

  // A record answered in the right place is untouched — the salvage runs
  // before the schema, and must not become a second reading of a healthy reply.
  it('records nothing when the reply came back under the answer key', async () => {
    const { calls, entry } = await answered({ 'x:extract_result#1': [FLAGGED] });

    expect(calls).toHaveLength(1);
    expect(entry).not.toHaveProperty('envelopeRepaired');
  });

  // The content is re-placed, not excused: a value the guide does not describe
  // still fails, exactly as it would have in the right place.
  it('validates the re-wrapped record as strictly as one written in place', async () => {
    const { calls } = await answered(
      { name: wrap('Flintt'), flag_reason: 'fintech' },
      { 'x:extract_result#1': [FLAGGED] },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1].userMessage).toContain('flag_reason');
  });
});

// A model that missed the envelope is not helped by being told again which
// values are invalid — the values were fine. So the retry shows it the
// envelope, with this call's own key and its own field names in it.

describe('a retry over a shape failure asks for the envelope, not for the values', () => {
  const span: Span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };

  const extract: ExtractExpression = {
    from: [{ raw: 'text', span }],
    stages: [
      {
        fields: [{ name: 'digest', description: desc('a one-line summary', span), span }],
        children: [
          {
            name: 'entry',
            description: desc('each line in the message', span),
            stages: [
              {
                fields: [
                  { name: 'name', description: desc('the name on the line', span), span },
                  { name: 'flag_reason', description: desc('why it was flagged', span), span },
                ],
                children: [],
                span,
              },
            ],
            span,
          },
        ],
        span,
      },
    ],
    span,
  };

  const GOOD = {
    'x:extract_result#1': [
      { digest: wrap('one line'), entry: [{ name: wrap('Flintt'), flag_reason: wrap('fintech') }] },
    ],
  };

  async function asked(first: unknown) {
    const llm = queuedMovementLlm([first, GOOD]);
    await materializeExtract({
      extract,
      spec: await buildExtractSpec(extract),
      runtime: {
        llm: llm.client,
        transformInvoker: {
          async invoke() {
            throw new Error('test: nothing to invoke');
          },
        },
        evalSlot: async () => ({ value: 'Flintt — fintech', provenance: NO_PROVENANCE }),
      },
    });
    return llm.calls[1].userMessage;
  }

  // The answer key was never used at all — the issue lands at the key itself.
  it('shows the envelope when nothing came back under the answer key', async () => {
    const retry = await asked({ por_favor: 'nothing here' });

    expect(retry).toContain('"x:extract_result#1": [');
    expect(retry).toContain('"digest"');
    expect(retry).toContain('"entry"');
    expect(retry).toContain('{"evidence": string|null, "value": …}');
    expect(retry).not.toContain('fix ONLY the invalid values');
  });

  // The whole reply was an array — the issue lands at the root itself.
  it('shows the envelope when the reply was a list at the top level', async () => {
    const retry = await asked(['Flintt', 'Rohan']);

    expect(retry).toContain('"x:extract_result#1": [');
    expect(retry).toContain('SHAPE of your response');
  });

  // The other half of the rule: a complaint about a VALUE names a place the
  // model can see, and fixing it there is still the whole instruction.
  it('keeps asking for the values when the packaging was right', async () => {
    const retry = await asked({
      'x:extract_result#1': [{ digest: wrap('one line'), entry: [{ name: 'Flintt' }] }],
    });

    expect(retry).toContain('fix ONLY the invalid values');
    expect(retry).not.toContain('SHAPE of your response');
  });
});

// A per-entity call is an INCREMENT on an entity that already stands. Losing it
// costs that entity some fields; failing the run costs every entity the
// extraction already got right — and a production run makes 40-85 of these
// calls. The root call has no previous stage to stand on, so it stays fatal.

describe('a per-entity refinement that is never answered keeps the entity, not the run', () => {
  const event = webhookEvent('email', { text: 'Gondor (gondor.fi) is worth a look.' });

  const GONDOR = {
    'x:extract_result#1': [
      { company: [{ name: wrap('Gondor'), website: wrap('gondor.fi') }] },
    ],
  };

  async function intake(responses: unknown[]) {
    const llm = queuedMovementLlm(responses);
    const attio = makeFakeAdapter('attio');
    const result = await runMovement({
      source: PER_ENTITY_FETCH_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      transformInvoker: {
        async invoke() {
          return { text: 'Fetched gondor.fi: a page about that company.' };
        },
      },
    });
    return { calls: llm.calls, writes: attio.creates.map((c) => c.fields), trace: result.trace };
  }

  it('writes the entity with the fields its first stage gave it', async () => {
    // The refinement is asked twice and answered with nothing either time.
    const { calls, writes } = await intake([GONDOR, {}, {}]);

    expect(calls).toHaveLength(3);
    // `summary` is the refinement's own text field: it joins the entity empty,
    // exactly as it would have if the stage had found nothing to say.
    expect(writes).toEqual([{ name: 'Gondor', summary: '' }]);
  });

  it('marks the fallback on the trace, with the reply and the enrichment it cost', async () => {
    const { trace } = await intake([GONDOR, {}, {}]);

    const entry = trace.filter((e) => e.kind === 'extraction').at(-1);
    expect(entry).toMatchObject({
      node: 'company',
      failed: 'invalid_reply',
      fallback: 'kept_previous_stage',
      plugins: [{ plugin: 'fetch_url', outcome: 'dropped' }],
      reply: { why: ['failed'] },
    });
  });

  // The entity survives as an entity, not just as a write: the run's own
  // record of what the extract produced still holds it.
  it('still counts the entity as extracted', async () => {
    const { trace } = await intake([GONDOR, {}, {}]);

    const withEntities = trace.find((e) => e.kind === 'extraction' && e.entities);
    if (withEntities?.kind !== 'extraction') throw new Error('test: no entities on the trace');
    expect(withEntities.entities?.company).toEqual([
      { fields: { name: 'Gondor', website: 'gondor.fi', summary: '' } },
    ]);
  });

  it('warns, naming the entity and the enrichment that went with the refinement', async () => {
    await intake([GONDOR, {}, {}]);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('keeping the entity as its previous stage left it'),
      expect.objectContaining({ node: 'company', droppedEnrichments: ['fetch_url'] }),
    );
  });

  // The other end of the rule, unchanged: the root call is the whole
  // extraction, and there is nothing behind it to keep.
  it('still fails the run when it is the ROOT call that is never answered', async () => {
    const failure = await intake([{}, {}]).then(
      () => {
        throw new Error('test: the run should have failed');
      },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(MovementRunFailed);
    expect((failure as MovementRunFailed).message).toMatch(/x:extract_result#1/);
    const entry = (failure as MovementRunFailed).partial.trace
      .filter((e) => e.kind === 'extraction')
      .at(-1);
    expect(entry).toMatchObject({ failed: 'invalid_reply' });
    expect(entry).not.toHaveProperty('fallback');
  });

  // A cancel or a truncation means the same thing in a per-entity call as
  // anywhere else — only the SHAPE rejection is absorbed.
  it('still fails the run when the per-entity call died of something else', async () => {
    const llm = {
      calls: 0,
      client: {
        async call(): Promise<{ parsedJson: unknown }> {
          llm.calls += 1;
          if (llm.calls === 1) return { parsedJson: GONDOR };
          throw new Error('the connection went away');
        },
      },
    };

    const failure = await runMovement({
      source: PER_ENTITY_FETCH_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      transformInvoker: {
        async invoke() {
          return { text: 'a page about that company' };
        },
      },
    }).then(
      () => {
        throw new Error('test: the run should have failed');
      },
      (error: unknown) => error,
    );

    expect((failure as MovementRunFailed).message).toContain('the connection went away');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 14. A description is a string, so it interpolates
// ═════════════════════════════════════════════════════════════════════════════
//
// Production (2026-09-10): a field whose description interpolated a
// constant holding the theme list reached the model as the eleven literal
// characters `${`Themes`}`, so the model had no list and answered null. A
// quoted string is one thing wherever it is written — a description is
// evaluated in the firing environment exactly as a write field's value is.

const INTERPOLATED_DESCRIPTION_MOVEMENT = [
  MOVEMENT_PRELUDE,
  'import { fetch_url } from plugins',
  '',
  'movement intake(msg: <inbox-[:message]->>) {',
  '  `Themes` = "AI Agents, Future of Work, Vertical SaaS"',
  '  deals = extract from [msg.`text`] {',
  '    node company: "each company working on ${`Themes`}" {',
  '      name:    "the company\'s name"',
  '      website: "the company\'s web address"',
  '    } through [fetch_url(url: website)] {',
  '      deep_dive: "the theme(s), VERBATIM from the list. ${`Themes`}"',
  '    }',
  '  }',
  '  deals-[c:company]-> {',
  '    write crm-[:companies]-> {',
  '      unique by (`name`)',
  '      name:    c.`name`',
  '      summary: c.`deep_dive`',
  '    }',
  '  }',
  '}',
].join('\n');

describe('an extract description interpolates in the firing environment', () => {
  const event = webhookEvent('email', { text: 'Gondor (gondor.fi) is worth a look.' });

  async function run() {
    const llm = queuedMovementLlm([
      { 'x:extract_result#1': [{ company: [{ name: wrap('Gondor'), website: wrap('gondor.fi') }] }] },
      { 'x:company#3': [{ deep_dive: wrap('AI Agents') }] },
    ]);
    const writes: CapturedWrite[] = [];
    await runMovement({
      source: INTERPOLATED_DESCRIPTION_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: movementCatalog,
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      llm: llm.client,
      transformInvoker: {
        async invoke() {
          return { text: 'a page about that company' };
        },
      },
      dryRun: true,
      writeSink: (w) => writes.push(w),
    });
    return { calls: llm.calls, writes };
  }

  it("carries the constant's text into a NODE description, not the source that names it", async () => {
    const { calls } = await run();
    expect(calls[0].system).toContain(
      'each company working on AI Agents, Future of Work, Vertical SaaS',
    );
    expect(calls[0].system).not.toContain('${');
  });

  it("carries the constant's text into a stage-2 FIELD description", async () => {
    const { calls } = await run();
    expect(calls[1].system).toContain(
      '`deep_dive` (text): the theme(s), VERBATIM from the list. AI Agents, Future of Work, Vertical SaaS',
    );
    expect(calls[1].system).not.toContain('${');
  });

  it('leaves a description that interpolates nothing byte-for-byte as written', async () => {
    const { calls } = await run();
    expect(calls[0].system).toContain("- `name` (text): the company's name");
    expect(calls[0].system).toContain("- `website` (text): the company's web address");
  });

  it('still extracts against the interpolated prompt', async () => {
    const { writes } = await run();
    expect(writes).toEqual([
      {
        kind: 'create',
        adapterType: 'attio',
        recordType: 'company',
        fields: { name: 'Gondor', summary: 'AI Agents' },
      },
    ]);
  });
});
