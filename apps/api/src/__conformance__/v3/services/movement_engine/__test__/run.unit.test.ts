// E1 — the movement engine's interpreter core.
//
//   1. The spec's §I dealflow_intake three-system fixture (email →
//      attio company + slack message + affinity organization) run
//      through `runMovement` with fake adapters: captured writes in
//      program order (adapterType, fields, handle piping).
//   1b. AI() — through `runMovement`'s injectable LlmClient seam with a
//      canned answer rule: writes, prompts at the seam, `ai` provenance
//      on the firing record.
//   1c. Runtime IS — type tests against the runtime position's type
//      where known (discriminated events, handles); falsy-skip where
//      the type is unknowable (undiscriminated events).
//   2. `unique by` — a second run against a fake adapter that returns
//      the first run's record as a resolveEntity candidate updates it
//      rather than duplicating (the shared arbitration module's
//      single-candidate branch).
//   3. Program order — a later write (different target) reads an earlier
//      write's handle (`co.externalId`, `co.`url``) env-side.
//   4. `if` with expression conditions gates writes.
//   5. Unsupported constructs (file-level extraction) raise clean
//      MOVENG_UNSUPPORTED errors naming the construct; check failures
//      raise MOVENG_CHECK.
//      (Extraction and traversal-headed blocks run since E2 —
//      extraction.unit.test.ts; kg targets and linked writes run since
//      E3 — kg.unit.test.ts; calls/composition since E5 —
//      calls.unit.test.ts; meta-rooted backfills since E6 —
//      backfill.unit.test.ts. The adapter-target linked-write seam is
//      covered here in §6.)
//   7. Event schema-edge block heads (E6) — `msg-[f:files]-> { … }`
//      streams positions through the source adapter's getRelated, the
//      same seam the TG engine walks; per-hop WHERE filters evaluate
//      position-scoped.
//   8. EXISTS() at runtime (E6) — `if EXISTS(msg-[:files]->) { … }`
//      gates by ≥1 adapter-edge yield; the WHERE filter is honored
//      against each landed position.

// ── Jest module workarounds (mirrors movement/compile.unit.test.ts) ─────────

// Order-sensitive cycle: pre-require schemas.ts so `expressionSchema`
// resolves before any ES import pulls it transitively.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../knowledge_pipeline/output_v3/schemas');

// lib/credentials derives its DEK at module load; the attio adapter pulls
// it in through the registry. Synthetic keys — nothing here encrypts.
process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');

// The adapter registry transitively imports `src/prisma`, which asserts
// these at module load. The kysely mock below intercepts every query
// path this suite exercises — the URLs are never dialled.
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??=
  'postgresql://unit:unit@localhost:5432/unit-test-unused';

// The bundled transforms (the catalog's plugin registry) read these at
// module load; nothing in this suite scrapes or calls an LLM.
process.env.SCRAPER_API_KEY ??= 'unit-test-unused';

// DB layer — nothing here should execute a real query.
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

// services/logger pulls services/context → prisma → DATABASE_URL_* env
// requirements at import time.
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

// The real KG adapter module reaches prisma through the knowledge write
// path. The catalog only needs its MANIFEST; no fixture resolves it.
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

// LLM seams pulled in by production_deps (facts → anthropic). No fixture
// here extracts or judges >1 candidate — stubbed to keep the module
// graph loadable.
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

// Acting-user arbitration (`@user_*` meta keys). The REAL chain walks
// team-user tables; this mock keeps the seam honest — it still consumes
// the adapter-parsed candidates the engine passes through
// `getCandidates`, so the test proves the source-adapter wiring.
jest.mock('../../translation_graph/adapters/acting_user/resolve', () => ({
  resolveActingUser: jest.fn(
    async (input: {
      getCandidates: () => Promise<
        Array<{ identity: { email?: string; identifier: string; name?: string } }>
      >;
    }) => {
      const first = (await input.getCandidates())[0];
      if (!first) return null;
      return {
        id: 'user-1',
        email: first.identity.email ?? first.identity.identifier,
        name: first.identity.name ?? null,
      };
    },
  ),
}));

// Adapter resolution + composition — every test injects its own
// resolver, and no fixture has a generic_reference target.
jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

import type { InstanceSchema } from 'movement-lang';
import { mockCatalog, parseMovementExpression } from 'movement-lang';
import type { Expression } from '#shared/expression/types';
import {
  MovementRunFailed,
  runFailureCause,
  runMovement,
  resumeMovement,
} from '../run';
import type { ParkSink } from '../run';
import {
  rehydrateBinding,
  serializeBinding,
  type BindingDescriptor,
  type ParkedScopeState,
  type RehydrationContext,
} from '../serialize';
import { createSingleFlight } from '../single_flight';
import type { Binding, SourceRead } from '../expression';
import { Environment, MovementEngineError, evalMovementExpr } from '../expression';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import type {
  Adapter,
  RuntimeCapabilities,
  ExternalRecordRef,
} from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { LlmClient } from '../../translation_graph/engine/batched_extraction';
import { makeStablePosition, makeUnstablePosition, positionData } from '../../translation_graph/types';
import type { SchemaTypeDescriptor } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as TeamId;

// ── Fake adapters (per-action-target.unit.test.ts pattern) ──────────────────

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

/**
 * A fake adapter whose `getFieldValue` reads the position's data bag (so
 * both engines see the same event payload through the same read seam),
 * recording real creates/updates and answering `resolveEntity` from an
 * injectable candidate function.
 */
function makeFakeAdapter(
  adapterType: string,
  opts: {
    resolveCandidates?: (record: Record<string, unknown>) => ExternalRecordRef[];
    createResult?: (n: number) => { externalId: string; url?: string };
    /** Native identity + fields the engine reads off `describe` (the constraint
     *  set it folds resolved parents into, and the required-field gate). */
    describeType?: (recordType: string) => SchemaTypeDescriptor | null;
    /** Current values the write-semantics gate merges against. */
    readRecord?: (externalId: string) => Record<string, unknown> | null;
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
    async describe(recordType: string) {
      return opts.describeType?.(recordType) ?? null;
    },
    async resolveEntity({ record }) {
      return { candidates: opts.resolveCandidates?.(record) ?? [] };
    },
    ...(opts.readRecord
      ? {
          async readRecord({ externalId }: { externalId: string }) {
            return opts.readRecord!(externalId);
          },
        }
      : {}),
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

/**
 * The error a rejected run really died of. A failure raised once the
 * interpreter is running comes out wrapped in `MovementRunFailed` (it carries
 * the partial write ledger out with it); parse/check failures are unwrapped.
 * The message is identical either way — only the class needs looking through.
 */
async function rejectionCause(promise: Promise<unknown>): Promise<unknown> {
  const settled: unknown = await promise.then(
    () => new Error('expected the run to reject, but it resolved'),
    (e: unknown) => e,
  );
  return runFailureCause(settled);
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
    pipelineInputId: 'pi-movement-engine',
    adapterType,
    triggerType: 'webhook',
    payload,
  };
}

// ── Catalogs / fixtures ─────────────────────────────────────────────────────

/** Fixture team ontology — only needed for the kg-target unsupported case. */
const kgSchema: InstanceSchema = {
  positions: {
    summary_note: { properties: { text: 'text' }, edges: {} },
  },
  collections: {
    summary_note: { target: "summary_note" }
  },
  writableRoots: {
    summary_note: {
      fields: { text: 'text' },
      resultShape: { externalId: 'text', text: 'text' },
      // The KG resolves fuzzy uniqueness components by pg_trgm similarity.
      fuzzyResolution: true,
    },
  },
};

const catalog = staticCatalogFromManifests({
  credentials: {
    dev_slack: { adapters: ['slack'] },
    acme_main: { adapters: ['attio'] },
  },
  instanceSchemas: { kg: kgSchema },
});

const CREDENTIAL_IDS: Record<string, string> = {
  dev_slack: 'cred-slack-1',
  acme_main: 'cred-attio-1',
};

const PRELUDE = [
  'import { slack, attio, kg } from adapters',
  'import { dev_slack, acme_main } from credentials',
  '',
  'inbox = slack(credentials: dev_slack)',
  'crm   = attio(credentials: acme_main)',
  'graph = kg()',
].join('\n');

// ── 1. §I dealflow_intake across three systems ──────────────────────────────

const MILESTONE_CREDENTIAL_IDS: Record<string, string> = {
  dealflow_inbox: 'cred-email-1',
  acme_main: 'cred-attio-1',
  acme_workspace: 'cred-slack-2',
  acme_affinity: 'cred-affinity-1',
};

const milestoneCatalog = staticCatalogFromManifests({
  credentials: {
    dealflow_inbox: { adapters: ['email'] },
    acme_main: { adapters: ['attio'] },
    acme_workspace: { adapters: ['slack'] },
    acme_affinity: { adapters: ['affinity'] },
  },
});

// The spec's §I worked example, in E1-runnable form (parallel rewritten
// sequential; handle reads via externalId; LLM-free name field).
const DEALFLOW_INTAKE_MILESTONE = [
  'import { email, attio, slack, affinity } from adapters',
  'import { acme_main, acme_workspace, acme_affinity } from credentials',
  '',
  'inbox = email()',
  'crm   = attio(credentials: acme_main)',
  'team  = slack(credentials: acme_workspace)',
  'aff   = affinity(credentials: acme_affinity)',
  '',
  'movement dealflow_intake(msg: <inbox-[:message]->>) {',
  '',
  '  company = write crm-[:companies]-> {',
  '    unique by (`domains`)',
  '    name:    msg.`subject`',
  '    domains: [msg.`text`]',
  '  }',
  '',
  '  write team-[:messages]-> {',
  '    channel: "#dealflow"',
  '    text:    "New deal from ${msg.`subject`}: ${company.externalId}"',
  '  }',
  '',
  '  write aff-[:organization]-> {',
  '    unique by (`name`)',
  '    name:      company.`name`',
  '    attio_url: company.externalId',
  '  }',
  '}',
].join('\n');

describe('§I dealflow_intake: runMovement across three systems', () => {
  function milestoneFakes() {
    return {
      email: makeFakeAdapter('email').adapter,
      attio: makeFakeAdapter('attio').adapter,
      slack: makeFakeAdapter('slack').adapter,
      affinity: makeFakeAdapter('affinity').adapter,
    };
  }

  const event = webhookEvent('email', { subject: 'Acme Corp intro', text: 'acme.dev' });

  it('captures the writes in program order (adapterType, fields, handle piping)', async () => {
    // The movement engine, directly on the checked AST.
    const movementWrites: CapturedWrite[] = [];
    const runResult = await runMovement({
      source: DEALFLOW_INTAKE_MILESTONE,
      event,
      teamId: TEAM_ID,
      catalog: milestoneCatalog,
      resolveCredentialId: (name) => MILESTONE_CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver(milestoneFakes()),
      dryRun: true,
      writeSink: (w) => movementWrites.push(w),
    });

    expect(runResult.movementName).toBe('dealflow_intake');
    const movementCompanyId = runResult.writes[0].externalId;
    expect(movementCompanyId).toMatch(/^[0-9a-f-]{36}$/);

    // The concrete expected shape (program order, per-write adapter,
    // field values, handle piping into BOTH later targets):
    expect(movementWrites).toEqual([
      {
        kind: 'create',
        adapterType: 'attio',
        recordType: 'company',
        fields: { name: 'Acme Corp intro', domains: 'acme.dev' },
      },
      {
        kind: 'create',
        adapterType: 'slack',
        recordType: 'message',
        fields: {
          channel: '#dealflow',
          text: `New deal from Acme Corp intro: ${movementCompanyId}`,
        },
      },
      {
        kind: 'create',
        adapterType: 'affinity',
        recordType: 'organization',
        fields: { name: 'Acme Corp intro', attio_url: movementCompanyId },
      },
    ]);

    // The engine's own firing record mirrors the sink, in program order.
    expect(runResult.writes.map((w) => [w.bindingName, w.adapterType, w.recordType, w.created]))
      .toEqual([
        ['company', 'attio', 'company', true],
        [undefined, 'slack', 'message', true],
        [undefined, 'affinity', 'organization', true],
      ]);
  });
});

// ── 1b. AI() in a write field through the LlmClient seam ────────────────────

describe('AI(): runMovement through the LlmClient seam', () => {
  const cannedAiAnswer = (prompt: string) => `normalized(${prompt})`;

  const movementLlmPrompts: string[] = [];
  const movementLlm: LlmClient = {
    async call({ userMessage }) {
      movementLlmPrompts.push(userMessage);
      // The structured envelope the engine's system prompt requests.
      return { parsedJson: { value: cannedAiAnswer(userMessage), has_value: true } };
    },
  };

  const AI_MOVEMENT = [
    'import { email, attio } from adapters',
    'import { acme_main } from credentials',
    '',
    'inbox = email()',
    'crm   = attio(credentials: acme_main)',
    '',
    'movement ai_intake(msg: <inbox-[:message]->>) {',
    '  write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name:    AI("normalise the company name")',
    '    summary: AI(msg.`subject`)',
    '  }',
    '}',
  ].join('\n');

  const event = webhookEvent('email', { subject: 'ACME corp intro' });

  beforeEach(() => {
    movementLlmPrompts.length = 0;
  });

  it('writes the canned answers, prompting once per AI() field', async () => {
    // The movement engine, LlmClient injected.
    const movementWrites: CapturedWrite[] = [];
    const runResult = await runMovement({
      source: AI_MOVEMENT,
      event,
      teamId: TEAM_ID,
      catalog: milestoneCatalog,
      resolveCredentialId: (name) => MILESTONE_CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
      }),
      llm: movementLlm,
      dryRun: true,
      writeSink: (w) => movementWrites.push(w),
    });

    expect(movementWrites).toEqual([
      {
        kind: 'create',
        adapterType: 'attio',
        recordType: 'company',
        fields: {
          name: 'normalized(normalise the company name)',
          summary: 'normalized(ACME corp intro)',
        },
      },
    ]);
    // …from the prompts at the seam: the static prompt verbatim, and the
    // prompt EXPRESSION evaluated then stringified (the frozen
    // `String(value ?? '')` rule, mirrored).
    expect(movementLlmPrompts.sort()).toEqual(
      ['normalise the company name', 'ACME corp intro'].sort(),
    );

    // E4's `ai` origin, produced: each AI-written field's trail carries
    // the prompt on the firing record.
    expect(runResult.writes[0].provenance).toEqual({
      name: [{ kind: 'ai', prompt: 'normalise the company name' }],
      summary: [{ kind: 'ai', prompt: 'ACME corp intro' }],
    });
  });

  it('AI(prompt_binding) — a bare-name value read feeds the prompt expression', async () => {
    const BOUND_PROMPT = [
      'import { email, attio } from adapters',
      'import { acme_main } from credentials',
      '',
      'inbox = email()',
      'crm   = attio(credentials: acme_main)',
      '',
      'company_prompt = "normalise the company name"',
      '',
      'movement ai_intake(msg: <inbox-[:message]->>) {',
      '  write crm-[:companies]-> {',
      '    unique by (`name`)',
      '    name: AI(company_prompt)',
      '  }',
      '}',
    ].join('\n');

    const attio = makeFakeAdapter('attio');
    await runMovement({
      source: BOUND_PROMPT,
      event,
      teamId: TEAM_ID,
      catalog: milestoneCatalog,
      resolveCredentialId: (name) => MILESTONE_CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
      }),
      llm: movementLlm,
    });

    expect(movementLlmPrompts).toEqual(['normalise the company name']);
    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'normalized(normalise the company name)' } },
    ]);
  });

  // The author says how much thinking the answer is worth; the platform's tier
  // mapping decides what that buys. These pin the mapping AT the call, which is
  // the only place the two meet.
  it('AI(prompt, tier) — each tier reaches the models it maps to', async () => {
    const TIERED = [
      'import { email, attio } from adapters',
      'import { acme_main } from credentials',
      '',
      'inbox = email()',
      'crm   = attio(credentials: acme_main)',
      '',
      'movement ai_tiers(msg: <inbox-[:message]->>) {',
      '  write crm-[:companies]-> {',
      '    unique by (`name`)',
      '    name:    AI("normalise the company name", "careful")',
      '    summary: AI("one-line summary", "quick")',
      '    domains: AI("the website")',
      '  }',
      '  write crm-[:companies]-> {',
      '    unique by (`name`)',
      '    name:    AI("weigh this against the thesis", "thorough")',
      '    summary: AI("a note", "smart")',
      '  }',
      '}',
    ].join('\n');

    const calls: Array<{
      prompt: string;
      model: string;
      effort?: string;
      maxTokens?: number;
    }> = [];
    const tierLlm: LlmClient = {
      async call({ userMessage, model, effort, maxTokens }) {
        calls.push({
          prompt: userMessage,
          model,
          ...(effort !== undefined ? { effort } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
        });
        return { parsedJson: { value: 'x', has_value: true } };
      },
    };
    await runMovement({
      source: TIERED,
      event,
      teamId: TEAM_ID,
      catalog: milestoneCatalog,
      resolveCredentialId: (name) => MILESTONE_CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
      }),
      llm: tierLlm,
      dryRun: true,
      writeSink: () => {},
    });

    const byPrompt = new Map(calls.map(({ prompt, ...settings }) => [prompt, settings]));
    // No tier is the platform default, and it is `quick`: the fast model under
    // the ceiling the client sizes from the input.
    expect(byPrompt.get('the website')).toEqual({ model: 'haiku', effort: 'low' });
    expect(byPrompt.get('one-line summary')).toEqual({ model: 'haiku', effort: 'low' });
    // `careful` and `thorough` name no effort — those models reason at their
    // own default depth rather than being capped from here. `thorough` is
    // claude-opus-5, not opus-4-7: plans/mvt-core-calculus-2026-08-31/10_bakeoff.md
    // round 2 found opus-4-7 with no effort named runs with NO thinking at
    // all (and can leak its scratchpad into the reply), while opus-5 in the
    // same silence thinks adaptively by default.
    expect(byPrompt.get('normalise the company name')).toEqual({ model: 'sonnet' });
    expect(byPrompt.get('weigh this against the thesis')).toEqual({
      model: 'opus5',
      maxTokens: 64000,
    });
    // The spelling that predates the tiers still runs, and runs as `careful`.
    expect(byPrompt.get('a note')).toEqual({ model: 'sonnet' });
  });

  it('AI() resolves to null via has_value: false — EXISTS() gates the block', async () => {
    const GATED = [
      'import { email, attio } from adapters',
      'import { acme_main } from credentials',
      '',
      'inbox = email()',
      'crm   = attio(credentials: acme_main)',
      '',
      'movement follow_up(msg: <inbox-[:message]->>) {',
      '  suggested_action = AI("a brief next step — only if one is needed")',
      '  if EXISTS(suggested_action) {',
      '    write crm-[:companies]-> {',
      '      unique by (`name`)',
      '      name: suggested_action',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const runGated = async (parsedJson: unknown) => {
      const attio = makeFakeAdapter('attio');
      await runMovement({
        source: GATED,
        event,
        teamId: TEAM_ID,
        catalog: milestoneCatalog,
        resolveCredentialId: (name) => MILESTONE_CREDENTIAL_IDS[name],
        resolveAdapter: makeResolver({
          email: makeFakeAdapter('email').adapter,
          attio: attio.adapter,
        }),
        llm: { call: async () => ({ parsedJson }) },
      });
      return attio.creates;
    };

    // Nothing applies → real null → the gate skips: no writes.
    expect(await runGated({ value: null, has_value: false })).toEqual([]);
    // A null value with has_value true is still a null.
    expect(await runGated({ value: null, has_value: true })).toEqual([]);
    // A blank answer is the same fact wearing a different shape — it must
    // reach the gate as absent, or the documented idiom passes on nothing.
    expect(await runGated({ value: '', has_value: true })).toEqual([]);
    expect(await runGated({ value: '   ', has_value: true })).toEqual([]);
    // The envelope-less fallback shape too.
    expect(await runGated({ answer: '' })).toEqual([]);
    // An answer → the gate opens and the value writes through.
    expect(await runGated({ value: 'Follow up with Alice', has_value: true })).toEqual([
      { recordType: 'company', fields: { name: 'Follow up with Alice' } },
    ]);
  });

  it('the run trace explains a no-writes firing: field miss, empty extraction, null AI, closed gate', async () => {
    // The production shape that motivated the trace: a schema field the
    // event payload doesn't carry → extraction over nothing → AI with no
    // useful context returns null → the gate closes → zero writes, and
    // the run record says exactly why.
    const SRC = [
      'import { email, attio } from adapters',
      'import { acme_main } from credentials',
      '',
      'inbox = email()',
      'crm   = attio(credentials: acme_main)',
      '',
      'movement probe(msg: <inbox-[:message]->>) {',
      '  mentions = extract from [msg.text] {',
      '    node company: "each company mentioned" {',
      '      name: "the company name"',
      '    }',
      '  }',
      '  suggested = AI("a next step, if any")',
      '  mentions-[c:company]-> {',
      '    write crm-[:companies]-> {',
      '      unique by (`name`)',
      '      name: c.name',
      '    }',
      '  }',
      '  if EXISTS(suggested) {',
      '    write crm-[:companies]-> {',
      '      unique by (`name`)',
      '      name: suggested',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const attio = makeFakeAdapter('attio');
    const runResult = await runMovement({
      source: SRC,
      // The payload has a subject but NO text body — the mailgun case.
      event: webhookEvent('email', { subject: 'hi', sender: 'a@b.c' }),
      teamId: TEAM_ID,
      catalog: milestoneCatalog,
      resolveCredentialId: (name) => MILESTONE_CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
      }),
      llm: { call: async () => ({ parsedJson: { value: null, has_value: false } }) },
    });

    expect(attio.creates).toEqual([]);
    expect(runResult.trace).toEqual([
      {
        kind: 'field_miss',
        binding: 'inbox',
        field: 'text',
        available: expect.arrayContaining(['subject', 'sender']),
      },
      {
        kind: 'extraction',
        node: 'extract result',
        inputChars: 0,
        skipped: 'empty_source',
        emissions: { 'extract result': 0 },
      },
      { kind: 'ai', prompt: 'a next step, if any', hasValue: false },
      { kind: 'block', root: 'mentions-[c:company]->', positions: 0 },
      { kind: 'gate', outcome: false },
    ]);
  });
});

// ── 1b². Value bindings — field reads ────────────────────────────────────────

describe('value bindings — field reads', () => {
  it('reads a field of an object held in a value binding (null for absent fields)', async () => {
    // Mirrors the production shape that used to raise MOVENG_UNSUPPORTED
    // ("reading fields of the value binding 'suggested_action'"): bind a
    // value, then read fields off it in a write.
    const SRC = [
      'import { email, attio } from adapters',
      'import { acme_main } from credentials',
      '',
      'inbox = email()',
      'crm   = attio(credentials: acme_main)',
      '',
      'movement suggestion_intake(msg: <inbox-[:message]->>) {',
      '  suggested_action = msg.`subject`',
      '  write crm-[:companies]-> {',
      '    unique by (`name`)',
      '    name:    suggested_action.`label`',
      '    summary: suggested_action.`missing`',
      '  }',
      '}',
    ].join('\n');

    const attio = makeFakeAdapter('attio');
    await runMovement({
      source: SRC,
      // The event field holds an object — the binding's value.
      event: webhookEvent('email', {
        subject: { label: 'Follow up with ACME' },
      }),
      teamId: TEAM_ID,
      catalog: milestoneCatalog,
      resolveCredentialId: (name) => MILESTONE_CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
      }),
    });

    expect(attio.creates).toEqual([
      {
        recordType: 'company',
        fields: { name: 'Follow up with ACME', summary: null },
      },
    ]);
  });
});

// ── 1c. IS — runtime type tests (the checker's narrowing assumption) ────────

describe('IS — runtime type tests', () => {
  const IS_EVENT = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  if msg IS <inbox-[:message]->> {',
    '    write crm-[:companies]-> {',
    '      unique by (`name`)',
    '      name: msg.`user`',
    '    }',
    '  } else {',
    '    write inbox-[:messages]-> {',
    '      channel: "#skipped"',
    '      text:    "no match"',
    '    }',
    '  }',
    '}',
  ].join('\n');

  async function runIs(source: string, event: TriggerEvent): Promise<CapturedWrite[]> {
    const writes: CapturedWrite[] = [];
    await runMovement({
      source,
      event,
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      dryRun: true,
      writeSink: (w) => writes.push(w),
    });
    return writes;
  }

  /** A discriminated inbound event — the seeded position is STABLE and
   *  carries its record type, so the IS test has a runtime answer. */
  function stableEvent(recordType: string): TriggerEvent {
    return {
      ...webhookEvent('slack', { user: 'U123' }),
      rootRecordType: recordType,
      externalRecordRef: { adapterType: 'slack', externalId: 'ts-1' },
    };
  }

  it('a discriminated event matching the named type takes the arm', async () => {
    const writes = await runIs(IS_EVENT, stableEvent('message'));
    expect(writes).toEqual([
      { kind: 'create', adapterType: 'attio', recordType: 'company', fields: { name: 'U123' } },
    ]);
  });

  it('a discriminated event of a DIFFERENT type falls through', async () => {
    const writes = await runIs(IS_EVENT, stableEvent('file'));
    expect(writes[0].fields).toEqual({ channel: '#skipped', text: 'no match' });
  });

  // This USED to fall into the `else` (the old "falsy-skip"). That answered
  // "can't tell" with the same `false` as "not that kind", so an
  // undiscriminated record ran the arm that means "not that kind" — and it is
  // why `else` could not narrow. The run now stops instead, which is what
  // makes the checker's else-arm elimination sound.
  it('an undiscriminated (typeless) event FAILS THE RUN — neither arm is truthful', async () => {
    await expect(runIs(IS_EVENT, webhookEvent('slack', { user: 'U123' }))).rejects.toThrow(
      /can't tell what kind of record 'msg' is/,
    );
  });

  it('the refusal names the missing discrimination, not an internal type', async () => {
    await expect(runIs(IS_EVENT, webhookEvent('slack', { user: 'U123' }))).rejects.toThrow(
      /the event arrived without a discriminated kind/,
    );
  });

  it('an answerable IS is unaffected — a different kind still takes the else', async () => {
    const writes = await runIs(IS_EVENT, stableEvent('file'));
    expect(writes[0].fields).toEqual({ channel: '#skipped', text: 'no match' });
  });

  // A TRAVERSAL ALIAS carries the landed record's own type — the adapter
  // stamped it, and the surface-read wrapper restamped it to the natural name.
  // The IS evaluator used to fall through to `false` for this binding kind, so
  // EVERY `IS` on a traversal result silently never matched: the arm was
  // skipped, no error, no log. Nothing to do with unions — it is what makes
  // narrowing a polymorphic edge work at run time.
  it('a traversal alias answers IS from the landed record type', async () => {
    const landed = (recordType: string, name: string) =>
      makeStablePosition({
        adapterType: 'slack',
        recordType,
        recordId: `${recordType}-1`,
        data: { name },
      });
    const slack = makeFakeAdapter('slack');
    const walking: Adapter = {
      ...slack.adapter,
      async getRelated() {
        return [{ position: landed('file', 'deck.pdf') }, { position: landed('message', 'Jane') }];
      },
    };
    const IS_TRAVERSED = [
      PRELUDE,
      '',
      'movement m(msg: <inbox-[:message]->>) {',
      '  msg-[r:files]-> {',
      '    if r IS <inbox-[:file]->> {',
      '      write inbox-[:messages]-> { channel: "#files", text: r.`name` }',
      '    }',
      '    if r IS <inbox-[:message]->> {',
      '      write inbox-[:messages]-> { channel: "#messages", text: r.`name` }',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const writes: CapturedWrite[] = [];
    await runMovement({
      source: IS_TRAVERSED,
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: makeFakeAdapter('attio').adapter, slack: walking }),
      dryRun: true,
      writeSink: (w) => writes.push(w),
    });
    // Each landed record takes ITS OWN arm — and only its own.
    expect(writes.map((w) => w.fields)).toEqual([
      { channel: '#files', text: 'deck.pdf' },
      { channel: '#messages', text: 'Jane' },
    ]);
  });

  it('a traversal alias of a DIFFERENT graph does not match', async () => {
    const slack = makeFakeAdapter('slack');
    const walking: Adapter = {
      ...slack.adapter,
      async getRelated() {
        return [
          {
            position: makeStablePosition({
              adapterType: 'slack',
              recordType: 'file',
              recordId: 'f-1',
              data: { name: 'deck.pdf' },
            }),
          },
        ];
      },
    };
    const writes: CapturedWrite[] = [];
    await runMovement({
      source: [
        PRELUDE,
        '',
        'movement m(msg: <inbox-[:message]->>) {',
        '  msg-[r:files]-> {',
        '    if r IS <crm-[:company]->> {',
        '      write inbox-[:messages]-> { channel: "#never", text: "wrong graph" }',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: makeFakeAdapter('attio').adapter, slack: walking }),
      dryRun: true,
      writeSink: (w) => writes.push(w),
    });
    expect(writes).toEqual([]);
  });

  it('a write handle answers IS from its binding (graph + surface type)', async () => {
    const IS_HANDLE = [
      PRELUDE,
      '',
      'movement m(msg: <inbox-[:message]->>) {',
      '  co = write crm-[:companies]-> {',
      '    unique by (`name`)',
      '    name: msg.`user`',
      '  }',
      '  if co IS <crm-[:company]->> {',
      '    write inbox-[:messages]-> { channel: "#yes", text: "company handle" }',
      '  }',
      '  if co IS <inbox-[:message]->> {',
      '    write inbox-[:messages]-> { channel: "#never", text: "wrong graph" }',
      '  }',
      '}',
    ].join('\n');
    const writes = await runIs(IS_HANDLE, webhookEvent('slack', { user: 'U123' }));
    expect(writes.map((w) => w.fields)).toEqual([
      { name: 'U123' },
      { channel: '#yes', text: 'company handle' },
    ]);
  });

  // A DECLARED NODE names a STRUCTURE, not a graph, so the question is whether
  // the subject's position carries what the declaration declares. It is decided
  // from the record type's SCHEMA — no data read, and a field being null is not
  // a misfit. The "can't tell" rule is untouched: an undiscriminated event has
  // no record type to look up, so the run stops rather than pick a branch.
  const structural = (decl: string[]): string =>
    [
      PRELUDE,
      '',
      ...decl,
      '',
      'movement m(msg: <inbox-[:message]->>) {',
      '  if msg IS <Shape> {',
      '    write inbox-[:messages]-> {',
      '      channel: "#arm"',
      '      text:    "fits"',
      '    }',
      '  } else {',
      '    write inbox-[:messages]-> {',
      '      channel: "#else"',
      '      text:    "does not fit"',
      '    }',
      '  }',
      '}',
    ].join('\n');

  const FITS = structural(['node Shape {', '  user: <text>', '}']);
  const MISSES = structural(['node Shape {', '  nowhere: <text>', '}']);

  it('a real position that carries the declared members takes the arm', async () => {
    const writes = await runIs(FITS, stableEvent('message'));
    expect(writes[0].fields).toEqual({ channel: '#arm', text: 'fits' });
  });

  it('a member the position does not have takes the else', async () => {
    const writes = await runIs(MISSES, stableEvent('message'));
    expect(writes[0].fields).toEqual({ channel: '#else', text: 'does not fit' });
  });

  it('a structural test on an undiscriminated event still FAILS THE RUN', async () => {
    await expect(runIs(FITS, webhookEvent('slack', { user: 'U123' }))).rejects.toThrow(
      /can't tell what kind of record 'msg' is/,
    );
  });
});

// ── 2. unique by — second run resolves to an update, not a duplicate ────────

describe('unique by — entity resolution through the shared arbitration split', () => {
  const UNIQUE_MOVEMENT = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  co = write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name:    msg.`user`',
    '    summary: msg.`text`',
    '  }',
    '}',
  ].join('\n');

  it('creates on first run, updates the resolved candidate on the second', async () => {
    // A stateful fake: resolveEntity answers from the records it has
    // already created, matching on the constraint field (`name`).
    const store: Array<{ externalId: string; fields: Record<string, unknown> }> = [];
    const attio = makeFakeAdapter('attio', {
      resolveCandidates: (record) =>
        store
          .filter((r) => r.fields.name === record.name)
          .map((r) => ({
            adapterType: 'attio',
            externalId: r.externalId,
            data: r.fields,
          })),
    });
    const baseCreate = attio.adapter.createRecord.bind(attio.adapter);
    attio.adapter.createRecord = async (input) => {
      const result = await baseCreate(input);
      store.push({ externalId: result.externalId, fields: input.fields });
      return result;
    };
    const slack = makeFakeAdapter('slack');
    const resolveAdapter = makeResolver({ attio: attio.adapter, slack: slack.adapter });

    const run = (text: string) =>
      runMovement({
        source: UNIQUE_MOVEMENT,
        event: webhookEvent('slack', { user: 'U123', text }),
        teamId: TEAM_ID,
        catalog,
        resolveCredentialId: (name) => CREDENTIAL_IDS[name],
        resolveAdapter,
      });

    // The firing record carries each written field's summarised trail
    // (E4) — here, both values flowed straight off the event's source
    // fields, so each field cites its { instance, field } origin.
    const expectedProvenance = {
      name: [{ kind: 'source_field', instance: 'inbox', adapterType: 'slack', field: 'user' }],
      summary: [{ kind: 'source_field', instance: 'inbox', adapterType: 'slack', field: 'text' }],
    };

    const first = await run('first message');
    expect(first.writes).toEqual([
      {
        bindingName: 'co',
        adapterType: 'attio',
        recordType: 'company',
        created: true,
        committed: true,
        externalId: 'ext-attio-1',
        writtenValues: { name: 'U123', summary: 'first message' },
        outcome: 'create',
        provenance: expectedProvenance,
        // The firing entry IS the bound handle (one unified record): it
        // carries the handle-read surface — the adapter's result-data bag
        // and the interned write origin later reads chain to.
        resultData: {},
        origin: { kind: 'write', writeIndex: 0, externalId: 'ext-attio-1' },
      },
    ]);
    expect(attio.creates).toHaveLength(1);

    const second = await run('second message');
    expect(second.writes).toEqual([
      {
        bindingName: 'co',
        adapterType: 'attio',
        recordType: 'company',
        created: false,
        committed: true,
        externalId: 'ext-attio-1',
        writtenValues: { name: 'U123', summary: 'second message' },
        outcome: 'update',
        provenance: expectedProvenance,
        resultData: {},
        origin: { kind: 'write', writeIndex: 0, externalId: 'ext-attio-1' },
      },
    ]);
    // No duplicate — the second run updated the first run's record.
    expect(attio.creates).toHaveLength(1);
    expect(attio.updates).toEqual([
      {
        recordType: 'company',
        externalId: 'ext-attio-1',
        fields: { name: 'U123', summary: 'second message' },
      },
    ]);
  });

  it('a FUZZY component reaches the adapter as a fuzzy constraint', async () => {
    // The whole point of FUZZY: the engine hands the adapter a similarity
    // constraint, which its resolveEntity turns into a fuzzy candidate search.
    const FUZZY_MOVEMENT = [
      PRELUDE,
      '',
      'movement m(msg: <inbox-[:message]->>) {',
      '  write graph-[:summary_note]-> {',
      '    unique by (FUZZY `text`)',
      '    text: msg.`text`',
      '  }',
      '}',
    ].join('\n');

    let captured: unknown;
    const kg = makeFakeAdapter('kg');
    kg.adapter.resolveEntity = async ({ constraints }) => {
      captured = constraints;
      return { candidates: [] };
    };
    const slack = makeFakeAdapter('slack');
    const resolveAdapter = makeResolver({
      'kg': kg.adapter,
      slack: slack.adapter,
    });

    await runMovement({
      source: FUZZY_MOVEMENT,
      event: webhookEvent('slack', { user: 'U123', text: 'Acme, Inc.' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter,
    });

    expect(captured).toEqual({ any: [{ all: [{ field: 'text', fuzzy: true }] }] });
  });
});

// ── 3. Program order — a later write reads an earlier handle ────────────────

describe('program order — later writes read earlier handles env-side', () => {
  const CHAINED = [
    PRELUDE,
    '',
    'movement chained(msg: <inbox-[:message]->>) {',
    '  co = write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name: msg.`user`',
    '  }',
    '  write inbox-[:messages]-> {',
    '    channel: "#deals"',
    '    text:    "id=${co.externalId} url=${co.`url`}"',
    '  }',
    '}',
  ].join('\n');

  it('pipes the first write’s externalId and result-data url into the second target', async () => {
    const attio = makeFakeAdapter('attio', {
      createResult: (n) => ({ externalId: `co-${n}`, url: `https://app.attio.com/co-${n}` }),
    });
    const slack = makeFakeAdapter('slack');

    const result = await runMovement({
      source: CHAINED,
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: attio.adapter, slack: slack.adapter }),
    });

    // Program order: company first, message second, handle values piped.
    expect(result.writes.map((w) => [w.adapterType, w.recordType])).toEqual([
      ['attio', 'company'],
      ['slack', 'message'],
    ]);
    expect(attio.creates).toEqual([{ recordType: 'company', fields: { name: 'U123' } }]);
    expect(slack.creates).toEqual([
      {
        recordType: 'message',
        fields: { channel: '#deals', text: 'id=co-1 url=https://app.attio.com/co-1' },
      },
    ]);
  });
});

// ── 3b. A run that dies mid-way carries its landed writes out ───────────────

describe('MovementRunFailed — a failing write does not erase what already landed', () => {
  const TWO_TARGETS = [
    PRELUDE,
    '',
    'movement two_targets(msg: <inbox-[:message]->>) {',
    '  co = write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name: msg.`user`',
    '  }',
    '  write inbox-[:messages]-> {',
    '    channel: "#deals"',
    '    text:    "id=${co.externalId}"',
    '  }',
    '}',
  ].join('\n');

  it('rethrows the write failure with the partial ledger, message and stack intact', async () => {
    const attio = makeFakeAdapter('attio');
    const slack = makeFakeAdapter('slack');
    const boom = new Error('slack: 422 Unprocessable Entity');
    slack.adapter.createRecord = async () => {
      throw boom;
    };

    const failure: unknown = await runMovement({
      source: TWO_TARGETS,
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: attio.adapter, slack: slack.adapter }),
    }).catch((e: unknown) => e);

    if (!(failure instanceof MovementRunFailed)) throw failure;
    // Transparent wrapper: the log line and the run's failure reason must
    // read exactly as they did before the ledger rode out with the error.
    expect(failure.message).toBe('slack: 422 Unprocessable Entity');
    expect(failure.cause).toBe(boom);
    expect(failure.stack).toBe(boom.stack);
    // The first write really landed — it must survive into the run record.
    expect(failure.partial.writes.map((w) => [w.adapterType, w.recordType])).toEqual([
      ['attio', 'company'],
    ]);
    expect(failure.partial.writes[0].committed).toBe(true);
    expect(attio.creates).toHaveLength(1);
    // Control flow is unchanged: the run still aborts on the first failure.
    expect(slack.creates).toEqual([]);
  });

  it('a run that writes nothing before failing carries an empty ledger', async () => {
    const attio = makeFakeAdapter('attio');
    attio.adapter.createRecord = async () => {
      throw new Error('attio: 401 Unauthorized');
    };

    const failure: unknown = await runMovement({
      source: TWO_TARGETS,
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: attio.adapter, slack: makeFakeAdapter('slack').adapter }),
    }).catch((e: unknown) => e);

    if (!(failure instanceof MovementRunFailed)) throw failure;
    expect(failure.message).toBe('attio: 401 Unauthorized');
    expect(failure.partial.writes).toEqual([]);
  });
});

// ── 4. if — expression conditions gate writes ───────────────────────────────

describe('if — expression conditions', () => {
  const GATED = [
    PRELUDE,
    '',
    'movement gated(msg: <inbox-[:message]->>) {',
    '  if msg.`text` CONTAINS "deal" {',
    '    write crm-[:companies]-> {',
    '      unique by (`name`)',
    '      name: msg.`user`',
    '    }',
    '  } else {',
    '    write inbox-[:messages]-> {',
    '      channel: "#triage"',
    '      text:    "not a deal: ${msg.`text`}"',
    '    }',
    '  }',
    '}',
  ].join('\n');

  async function runGated(text: string): Promise<CapturedWrite[]> {
    const writes: CapturedWrite[] = [];
    await runMovement({
      source: GATED,
      event: webhookEvent('slack', { user: 'U123', text }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      dryRun: true,
      writeSink: (w) => writes.push(w),
    });
    return writes;
  }

  it('takes the matching arm', async () => {
    const writes = await runGated('a new deal for you');
    expect(writes).toEqual([
      {
        kind: 'create',
        adapterType: 'attio',
        recordType: 'company',
        fields: { name: 'U123' },
      },
    ]);
  });

  it('falls through to else', async () => {
    const writes = await runGated('lunch plans');
    expect(writes).toEqual([
      {
        kind: 'create',
        adapterType: 'slack',
        recordType: 'message',
        fields: { channel: '#triage', text: 'not a deal: lunch plans' },
      },
    ]);
  });
});

// ── 4a′. function calls — the mirrored pure built-ins ───────────────────────

describe('function calls — COALESCE and the built-in pure set', () => {
  const FALLBACK = [
    PRELUDE,
    '',
    'movement fallback(msg: <inbox-[:message]->>) {',
    '  write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name: COALESCE(msg.`channel`, msg.`user`)',
    '    summary: UPPER(TRIM(msg.`text`))',
    '  }',
    '}',
  ].join('\n');

  async function runFallback(payload: Record<string, unknown>): Promise<CapturedWrite[]> {
    const writes: CapturedWrite[] = [];
    await runMovement({
      source: FALLBACK,
      event: webhookEvent('slack', payload),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      dryRun: true,
      writeSink: (w) => writes.push(w),
    });
    return writes;
  }

  it('COALESCE picks the first non-empty value (the taught fallback idiom)', async () => {
    const writes = await runFallback({ user: 'U123', text: '  big deal ' });
    expect(writes).toEqual([
      {
        kind: 'create',
        adapterType: 'attio',
        recordType: 'company',
        fields: { name: 'U123', summary: 'BIG DEAL' },
      },
    ]);
  });

  it('COALESCE passes an earlier non-null straight through', async () => {
    const writes = await runFallback({ channel: 'Acme', user: 'U123', text: 'x' });
    expect(writes[0].fields).toEqual({ name: 'Acme', summary: 'X' });
  });

  it('a non-built-in function the target field does NOT advertise raises MOVENG_UNSUPPORTED naming it', async () => {
    await expect(
      runMovement({
        source: FALLBACK.replace('COALESCE(msg.`channel`, msg.`user`)', 'DOMAIN_OF(msg.`user`)'),
        event: webhookEvent('slack', { user: 'U123', text: 'x' }),
        teamId: TEAM_ID,
        catalog,
        resolveCredentialId: (name) => CREDENTIAL_IDS[name],
        resolveAdapter: makeResolver({
          attio: makeFakeAdapter('attio').adapter,
          slack: makeFakeAdapter('slack').adapter,
        }),
        dryRun: true,
        writeSink: () => {},
      }),
    ).rejects.toThrow(/MOVENG_UNSUPPORTED.*DOMAIN_OF/);
  });
});

// ── 4a″. adapter field functions — bound to the write target, per field ─────

describe('adapter field functions — resolved against the WRITE TARGET adapter at field-mapping time', () => {
  const COMPOSED = [
    PRELUDE,
    '',
    'movement compose(msg: <inbox-[:message]->>) {',
    '  write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name:    DOMAIN_OF(msg.`user`)',
    '    summary: msg.`text`',
    '  }',
    '}',
  ].join('\n');

  function makeComposerAdapter() {
    const invocations: Array<{
      recordType: string;
      fieldId: string;
      functionName: string;
      args: { instructions: string; data: unknown[] };
    }> = [];
    const fake = makeFakeAdapter('attio');
    // Surface-native fixture: the program names the type / field by these same
    // names, so the descriptor's `displayName` (the field-function binding
    // key) IS the program's `company` / `name`.
    fake.adapter.describe = async (typeId: string) => ({
      typeId,
      displayName: typeId,
      references: [],
      fields: [
        {
          fieldId: 'name',
          displayName: 'name',
          kind: 'string' as const,
          writable: true,
          required: false,
          functions: [
            {
              name: 'DOMAIN_OF',
              displayName: 'Domain of',
              summary: 'the registrable domain of a value',
              params: [],
            },
          ],
        },
      ],
    });
    fake.adapter.invokeFieldFunction = async (input) => {
      invocations.push(input);
      return `domain-of:${input.args.instructions}`;
    };
    return { fake, invocations };
  }

  it("invokes the target adapter's invokeFieldFunction when the destination field advertises the name", async () => {
    const { fake, invocations } = makeComposerAdapter();
    const result = await runMovement({
      source: COMPOSED,
      event: webhookEvent('slack', { user: 'acme.dev', text: 'big deal' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: fake.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
    });

    // The frozen binding convention: args[0] is the (stringified)
    // instructions brief; the rest is bare data.
    expect(invocations).toEqual([
      {
        recordType: 'company',
        fieldId: 'name',
        functionName: 'DOMAIN_OF',
        args: { instructions: 'acme.dev', data: [] },
      },
    ]);
    expect(fake.creates).toEqual([
      {
        recordType: 'company',
        fields: { name: 'domain-of:acme.dev', summary: 'big deal' },
      },
    ]);
    // A field function is a transform — the source read survives in the
    // taint union on the firing record.
    expect(result.writes[0].provenance.name).toEqual([
      expect.objectContaining({ kind: 'source_field', field: 'user' }),
    ]);
  });

  it('the binding is per FIELD — the same name on a field that does not advertise it stays unsupported', async () => {
    const { fake } = makeComposerAdapter();
    await expect(
      runMovement({
        source: COMPOSED.replace('summary: msg.`text`', 'summary: DOMAIN_OF(msg.`text`)'),
        event: webhookEvent('slack', { user: 'acme.dev', text: 'big deal' }),
        teamId: TEAM_ID,
        catalog,
        resolveCredentialId: (name) => CREDENTIAL_IDS[name],
        resolveAdapter: makeResolver({
          attio: fake.adapter,
          slack: makeFakeAdapter('slack').adapter,
        }),
      }),
    ).rejects.toThrow(/MOVENG_UNSUPPORTED.*DOMAIN_OF/);
  });
});

// ── 4a‴. meta values — the frozen engine's @<key> families ──────────────────

describe('meta values — @current_date / @actor_* / @user_* resolve from the dispatch context', () => {
  const STAMPED = [
    PRELUDE,
    '',
    'movement stamp(msg: <inbox-[:message]->>) {',
    '  write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name:    msg.`user`',
    '    domains: [@user_email]',
    '    summary: "actor=${@actor_email} (${@actor_name}) day=${@current_date}"',
    '  }',
    '}',
  ].join('\n');

  function actorAwareSlack() {
    const fake = makeFakeAdapter('slack');
    fake.adapter.extractActor = async () => ({
      identifier: 'U-AMY',
      scheme: 'email',
      email: 'amy@acme.dev',
      name: 'Amy',
    });
    fake.adapter.getActorCandidates = async () => [
      {
        identity: { identifier: 'amy@acme.dev', scheme: 'email', email: 'amy@acme.dev', name: 'Amy' },
        source: 'originator',
      },
    ];
    return fake;
  }

  it('resolves time, actor, and acting-user keys through the same sources as the frozen engine', async () => {
    const slack = actorAwareSlack();
    const attio = makeFakeAdapter('attio');
    const result = await runMovement({
      source: STAMPED,
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: attio.adapter, slack: slack.adapter }),
    });

    expect(attio.creates).toHaveLength(1);
    const fields = attio.creates[0].fields;
    expect(fields.name).toBe('U123');
    // @user_* — candidates parsed by the source adapter, arbitrated by
    // resolveActingUser (mocked at the module seam, candidate-driven).
    expect(fields.domains).toBe('amy@acme.dev');
    // @actor_* — the source adapter's pure-parse extractActor;
    // @current_date — the universal time key, no context needed.
    expect(fields.summary).toMatch(
      /^actor=amy@acme\.dev \(Amy\) day=\d{4}-\d{2}-\d{2}$/,
    );

    // The firing record's trail names the meta key, literal-ish.
    expect(result.writes[0].provenance.domains).toEqual([{ kind: 'meta', key: 'user_email' }]);
  });

  it('user/actor keys collapse to null when the source adapter has no actor surface', async () => {
    const attio = makeFakeAdapter('attio');
    const result = await runMovement({
      source: STAMPED,
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
    });
    expect(result.writes).toHaveLength(1);
    const fields = attio.creates[0].fields;
    // [null] joins to '' at the scalar boundary; the interpolated
    // actor reads collapse to empty strings.
    expect(fields.domains).toBe('');
    expect(fields.summary).toMatch(/^actor= \(\) day=\d{4}-\d{2}-\d{2}$/);
  });
});

// ── 4a‴b. the pinned clock — one instant per run ────────────────────────────
//
// Every clock read in a run answers from the instant the run FIRED, supplied
// by the host as `firedAt` (the run row's `started_at`, which a resume reads
// back). Two reads in one run therefore agree even across a midnight, and a
// resumed run computes the window it started with rather than the one it woke
// up in.

describe('the run clock is pinned to the firing instant', () => {
  const CLOCKED = [
    PRELUDE,
    '',
    'movement clocked(msg: <inbox-[:message]->>) {',
    '  write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name:    msg.`user`',
    '    summary: "${@current_date} ${@current_timestamp} ${DATE.TODAY("Europe/Berlin")} ${DATE.TODAY("UTC")}"',
    '  }',
    '}',
  ].join('\n');

  /** 23:30Z on the 11th is already the 12th in Berlin — a live `new Date()`
   *  anywhere on this path would show up as a different answer here. */
  const FIRED_AT = new Date('2026-03-11T23:30:00.000Z');

  async function summaryFiredAt(firedAt?: Date): Promise<string> {
    const attio = makeFakeAdapter('attio');
    await runMovement({
      source: CLOCKED,
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      ...(firedAt !== undefined ? { firedAt } : {}),
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
    });
    return String(attio.creates[0].fields.summary);
  }

  it('every clock read in the run answers from the firing instant', async () => {
    expect(await summaryFiredAt(FIRED_AT)).toBe(
      '2026-03-11 2026-03-11T23:30:00.000Z 2026-03-12 2026-03-11',
    );
  });

  it('a resume of the same firing reads the same instant, hours later', async () => {
    // Resuming IS re-running with the run row's original `started_at` — the
    // host passes the same `firedAt`, so the movement sees the same day.
    const first = await summaryFiredAt(FIRED_AT);
    const resumed = await summaryFiredAt(FIRED_AT);
    expect(resumed).toBe(first);
  });

  it('no firing instant supplied ⇒ one live instant, pinned for that run', async () => {
    const summary = await summaryFiredAt();
    const [date, timestamp] = summary.split(' ');
    expect(timestamp.startsWith(date)).toBe(true);
  });
});

// ── 4a⁗. array indexing — the shared AST's `at` node, frozen semantics ──────

// The movement GRAMMAR has no postfix-index syntax (`xs[0]` does not
// parse; `AT()` is a generic non-built-in name on both engines), but the
// shared Expression union carries an `at` node (editor-built TG JSON) —
// the evaluator mirrors the frozen engine's semantics for it, so the
// AST-level coverage is engine-complete.
describe('array indexing — the `at` expression node, frozen semantics mirrored', () => {
  async function evalAt(value: unknown, index: number): Promise<unknown> {
    const env = new Environment();
    env.declare('xs', { kind: 'value', value });
    const expr: Expression = {
      type: 'at',
      expression: { type: 'alias_ref', name: 'xs' },
      index: { type: 'static', value: index },
    };
    return (await evalMovementExpr(expr, { env })).value;
  }

  it('indexes forward and backward, nulls out of range and non-integer indexes, scalar acts as a one-element list', async () => {
    await expect(evalAt(['a', 'b', 'c'], 0)).resolves.toBe('a');
    await expect(evalAt(['a', 'b', 'c'], -1)).resolves.toBe('c');
    await expect(evalAt(['a', 'b', 'c'], 5)).resolves.toBeNull();
    await expect(evalAt(['a', 'b', 'c'], 1.5)).resolves.toBeNull();
    await expect(evalAt('scalar', 0)).resolves.toBe('scalar');
    await expect(evalAt('scalar', -1)).resolves.toBe('scalar');
    await expect(evalAt('scalar', 1)).resolves.toBeNull();
    await expect(evalAt(null, 0)).resolves.toBeNull();
  });
});

// ── 4a⁴. bare coercers — DATE() / DATETIME() / NUMBER() as built-ins ────────
//
// The coercers are plain built-in functions (`{ fn: 'date'|'datetime'|
// 'number' }`), parsed bare by the grammar and run through the engine's
// applyMovementFunction, which delegates to movement-lang's exported
// coercer helpers (one source of truth). Pure, null-safe.

describe('bare coercers — DATE() / DATETIME() / NUMBER() built-ins', () => {
  async function evalCoercer(text: string): Promise<unknown> {
    const expr = parseMovementExpression(text);
    return (await evalMovementExpr(expr, { env: new Environment() })).value;
  }

  it('DATE() truncates a readable instant to a midnight-UTC calendar day', async () => {
    await expect(evalCoercer('DATE("2026-03-12T09:30:00Z")')).resolves.toBe('2026-03-12');
    await expect(evalCoercer('DATE("12 March 2026")')).resolves.toBe('2026-03-12');
    await expect(evalCoercer('DATE("garbage")')).resolves.toBeNull();
  });

  it('DATETIME() keeps the full instant (midnight for a bare date)', async () => {
    await expect(evalCoercer('DATETIME("2026-03-12")')).resolves.toBe('2026-03-12T00:00:00.000Z');
    await expect(evalCoercer('DATETIME("2026-03-12T09:30:00.000Z")')).resolves.toBe(
      '2026-03-12T09:30:00.000Z',
    );
    await expect(evalCoercer('DATETIME("garbage")')).resolves.toBeNull();
  });

  it('NUMBER() parses a number and is null on unparseable / null', async () => {
    await expect(evalCoercer('NUMBER("42")')).resolves.toBe(42);
    await expect(evalCoercer('NUMBER("3.5")')).resolves.toBe(3.5);
    await expect(evalCoercer('NUMBER("nope")')).resolves.toBeNull();
    await expect(evalCoercer('NUMBER(NULL)')).resolves.toBeNull();
  });

  it('the bare coercers carry transformed provenance (a pure transform)', async () => {
    const result = await evalMovementExpr(parseMovementExpression('NUMBER("42")'), {
      env: new Environment(),
    });
    expect(result.value).toBe(42);
    expect(result.provenance).toBeDefined();
  });
});

// ── 4a⁵. dispatch arity — multi-parameter movements are callees ─────────────

describe('dispatch arity — a multi-parameter movement cannot be the entry', () => {
  it('raises MOVENG_RUNTIME naming the movement (dispatch supplies one event)', async () => {
    const source = [
      PRELUDE,
      '',
      'movement pair(a: <inbox-[:message]->>, b: <inbox-[:message]->>) {',
      '  write crm-[:companies]-> { name: a.`user` }',
      '}',
    ].join('\n');
    await expect(
      runMovement({
        source,
        movementName: 'pair',
        event: webhookEvent('slack', { user: 'U123' }),
        teamId: TEAM_ID,
        catalog,
        resolveCredentialId: (name) => CREDENTIAL_IDS[name],
        resolveAdapter: makeResolver({
          attio: makeFakeAdapter('attio').adapter,
          slack: makeFakeAdapter('slack').adapter,
        }),
      }),
    ).rejects.toThrow(/MOVENG_RUNTIME.*'pair' takes 2 parameters/);
  });
});

// ── 4b. parallel — env fork + join ──────────────────────────────────────────

describe('parallel — env fork + join', () => {
  /** An n-arrival barrier: each arrival blocks until ALL n have arrived.
   *  Under sequential execution the first arrival never unblocks — the
   *  timeout fails the test loud instead of hanging it. */
  function makeBarrier(n: number, timeoutMs = 2000) {
    let count = 0;
    let release!: () => void;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      async arrive(): Promise<void> {
        count += 1;
        if (count >= n) release();
        let timer: NodeJS.Timeout;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `barrier timeout — only ${count}/${n} arrivals; parallel siblings did not run concurrently`,
                ),
              ),
            timeoutMs,
          );
        });
        await Promise.race([open, timeout]).finally(() => clearTimeout(timer));
      },
    };
  }

  const PARALLEL = [
    PRELUDE,
    '',
    'movement fanned(msg: <inbox-[:message]->>) {',
    '  r = await parallel([',
    '    () => {',
    '      co = write crm-[:companies]-> {',
    '        unique by (`name`)',
    '        name: msg.`user`',
    '      }',
    '      return co.externalId',
    '    },',
    '    () => {',
    '      note = write inbox-[:messages]-> {',
    '        channel: "#left"',
    '        text:    msg.`text`',
    '      }',
    '      return note.externalId',
    '    },',
    '  ])',
    '  write inbox-[:messages]-> {',
    '    channel: "#after"',
    '    text:    "co=${AT(r, 0)} note=${AT(r, 1)}"',
    '  }',
    '}',
  ].join('\n');

  it('runs siblings CONCURRENTLY (each write blocks until both have started)', async () => {
    const barrier = makeBarrier(2);
    const attio = makeFakeAdapter('attio');
    const slack = makeFakeAdapter('slack');
    for (const fake of [attio, slack]) {
      const base = fake.adapter.createRecord.bind(fake.adapter);
      fake.adapter.createRecord = async (input) => {
        await barrier.arrive();
        return base(input);
      };
    }

    const result = await runMovement({
      source: PARALLEL,
      event: webhookEvent('slack', { user: 'U123', text: 'hello' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: attio.adapter, slack: slack.adapter }),
    });

    // Both arms' writes landed (the barrier proves overlap), and the statement
    // AFTER the join read BOTH slots of the receipt.
    expect(attio.creates).toEqual([{ recordType: 'company', fields: { name: 'U123' } }]);
    expect(slack.creates).toContainEqual({
      recordType: 'message',
      fields: { channel: '#left', text: 'hello' },
    });
    expect(slack.creates).toContainEqual({
      recordType: 'message',
      fields: { channel: '#after', text: 'co=ext-attio-1 note=ext-slack-1' },
    });
    expect(result.writes).toHaveLength(3);
    // The post-join write is last in program order; sibling completion
    // order between the first two is scheduling-dependent.
    expect(result.writes[2].writtenValues.channel).toBe('#after');
    expect(
      result.writes
        .slice(0, 2)
        .map((w) => w.bindingName)
        .sort(),
    ).toEqual(['co', 'note']);
  });

  it('arms read enclosing-scope bindings; what they return is read by slot after the join', async () => {
    const attio = makeFakeAdapter('attio', {
      createResult: (n) => ({ externalId: `co-${n}` }),
    });
    const slack = makeFakeAdapter('slack');

    const SCOPED = [
      PRELUDE,
      '',
      'movement scoped(msg: <inbox-[:message]->>) {',
      '  co = write crm-[:companies]-> {',
      '    unique by (`name`)',
      '    name: msg.`user`',
      '  }',
      '  r = await parallel([',
      '    () => {',
      '      left = write inbox-[:messages]-> {',
      '        channel: "#left"',
      '        text:    co.externalId',
      '      }',
      '      return left.externalId',
      '    },',
      '    () => {',
      '      right = write inbox-[:messages]-> {',
      '        channel: "#right"',
      '        text:    co.externalId',
      '      }',
      '      return right.externalId',
      '    },',
      '  ])',
      '  write inbox-[:messages]-> {',
      '    channel: "#after"',
      '    text:    "${AT(r, 0)}/${AT(r, 1)}"',
      '  }',
      '}',
    ].join('\n');

    await runMovement({
      source: SCOPED,
      event: webhookEvent('slack', { user: 'U9' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: attio.adapter, slack: slack.adapter }),
    });

    // Each arm read the ENCLOSING scope's pre-combinator handle (`co`)…
    expect(slack.creates).toContainEqual({
      recordType: 'message',
      fields: { channel: '#left', text: 'co-1' },
    });
    expect(slack.creates).toContainEqual({
      recordType: 'message',
      fields: { channel: '#right', text: 'co-1' },
    });
    // …and the post-join statement read BOTH slots of the receipt.
    const after = slack.creates.find((c) => c.fields.channel === '#after');
    expect(after?.fields.text).toMatch(/^ext-slack-\d\/ext-slack-\d$/);
  });
});

// ── 5. Unsupported constructs / failed checks error cleanly ─────────────────

describe('unsupported constructs raise MOVENG_UNSUPPORTED naming the construct', () => {
  async function expectUnsupported(source: string, pattern: RegExp): Promise<void> {
    const promise = runMovement({
      source,
      event: webhookEvent('slack', { user: 'U123', text: 'hello' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      dryRun: true,
    });
    expect(await rejectionCause(promise)).toBeInstanceOf(MovementEngineError);
    await expect(promise).rejects.toThrow(pattern);
  }

  // Extraction and traversal-headed blocks RUN since E2 — see
  // extraction.unit.test.ts. The still-unsupported boundaries:

  it('file-level extract expressions', async () => {
    await expectUnsupported(
      [
        PRELUDE,
        '',
        'r = extract from ["a fixed document"] {',
        '  node round: "funding round mentioned in this document" {',
        '    name: "funding round name"',
        '  }',
        '}',
        '',
        'movement m(msg: <inbox-[:message]->>) {',
        '  write crm-[:companies]-> {',
        '    unique by (`name`)',
        '    name: msg.`user`',
        '  }',
        '}',
      ].join('\n'),
      /MOVENG_UNSUPPORTED: file-level extract expressions/,
    );
  });

  it('a failing check raises MOVENG_CHECK with the diagnostics', async () => {
    await expectCode(
      [
        PRELUDE,
        '',
        'movement m(msg: <inbox-[:message]->>) {',
        '  write crm-[:companies]-> {',
        '    unique by (`name`)',
        '    name: nonsense.`user`',
        '  }',
        '}',
      ].join('\n'),
      /MOVENG_CHECK/,
    );
  });

  async function expectCode(source: string, pattern: RegExp): Promise<void> {
    await expect(
      runMovement({
        source,
        event: webhookEvent('slack', { user: 'U123' }),
        teamId: TEAM_ID,
        catalog,
        resolveAdapter: makeResolver({}),
      }),
    ).rejects.toThrow(pattern);
  }
});

// ── 6. Linked writes against an adapter target (E3 — same seam as KG) ────────

describe('adapter-target linked writes — parent link forwarded to the adapter', () => {
  const LINKED = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  p = write crm-[:people]-> {',
    '    unique by (`email`)',
    '    name:  msg.`user`',
    '    email: msg.`user`',
    '  }',
    '  write p-[:company]-> {',
    '    unique by (`name`)',
    '    name: msg.`user`',
    '  }',
    '}',
  ].join('\n');

  it('creates the linked record in the parent’s graph with the connecting edge context', async () => {
    const attio = makeFakeAdapter('attio');
    const parentLinks: unknown[] = [];
    const baseCreate = attio.adapter.createRecord.bind(attio.adapter);
    attio.adapter.createRecord = async (input) => {
      parentLinks.push(input.parentLinks ?? null);
      return baseCreate(input);
    };

    const result = await runMovement({
      source: LINKED,
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
    });

    // The written type is inferred from the parent's schema edge
    // (person -[company]-> company), and the adapter receives the
    // parent → child link to wire the reference.
    expect(result.writes.map((w) => [w.adapterType, w.recordType, w.created])).toEqual([
      ['attio', 'person', true],
      ['attio', 'company', true],
    ]);
    expect(parentLinks).toEqual([
      [],
      [{ recordType: 'person', externalId: 'ext-attio-1', edgeName: 'company', data: {} }],
    ]);
  });

  const EVENT_LINKED = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  write msg-[:replies]-> {',
    '    channel: msg.`channel`',
    '    text:    "ack"',
    '  }',
    '}',
  ].join('\n');

  it('the EVENT position parents a linked write when it carries a stable record id', async () => {
    const slack = makeFakeAdapter('slack');
    const parentLinks: unknown[] = [];
    const baseCreate = slack.adapter.createRecord.bind(slack.adapter);
    slack.adapter.createRecord = async (input) => {
      parentLinks.push(input.parentLinks ?? null);
      return baseCreate(input);
    };

    const result = await runMovement({
      source: EVENT_LINKED,
      event: {
        ...webhookEvent('slack', { channel: 'C1', text: 'original' }),
        rootRecordType: 'message',
        externalRecordRef: { adapterType: 'slack', recordType: 'message', externalId: 'slack-msg-1' },
      },
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        slack: slack.adapter,
        attio: makeFakeAdapter('attio').adapter,
      }),
    });

    expect(result.writes.map((w) => [w.adapterType, w.recordType, w.created])).toEqual([
      ['slack', 'message', true],
    ]);
    expect(parentLinks).toEqual([
      [{
        recordType: 'message',
        externalId: 'slack-msg-1',
        edgeName: 'replies',
        data: { channel: 'C1', text: 'original' },
      }],
    ]);
  });

  it('an event with NO durable record id rejects the linked write, loudly', async () => {
    await expect(
      runMovement({
        source: EVENT_LINKED,
        event: webhookEvent('slack', { channel: 'C1', text: 'original' }),
        teamId: TEAM_ID,
        catalog,
        resolveCredentialId: (name) => CREDENTIAL_IDS[name],
        resolveAdapter: makeResolver({
          slack: makeFakeAdapter('slack').adapter,
          attio: makeFakeAdapter('attio').adapter,
        }),
      }),
    ).rejects.toThrow(/durable record id/);
  });
});

// ── 6a2. Identity that names the parent edge — the seam an attached record's
//        upsert rides (Affinity's list membership: one entry per record+list).

describe('a native constraint naming a parent edge routes the second write to update', () => {
  const LINKED_UPSERT = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  p = write crm-[:people]-> {',
    '    unique by (`email`)',
    '    name:  msg.`user`',
    '    email: msg.`user`',
    '  }',
    '  write p-[:company]-> {',
    '    name ?: msg.`user`',
    '  }',
    '}',
  ].join('\n');

  // The attached record has no identity of its own: it is unique per (parent,
  // …), and the parent reaches it through the edge. So the descriptor names
  // the EDGE as an identity field, and the engine folds the resolved parent in
  // under that name before asking the adapter to search.
  const describeType = (recordType: string): SchemaTypeDescriptor | null =>
    recordType === 'company'
      ? {
          typeId: 'company',
          displayName: 'company',
          fields: [],
          references: [],
          uniquenessConstraints: { any: [{ all: [{ field: 'company' }] }] },
        }
      : null;

  it('folds the parent under the edge name, then updates the record it found', async () => {
    const asked: Record<string, unknown>[] = [];
    const attio = makeFakeAdapter('attio', {
      describeType,
      resolveCandidates: (record) => {
        asked.push(record);
        const parent = record.company as { id?: string } | undefined;
        return parent?.id === 'ext-attio-1'
          ? [{ adapterType: 'attio', externalId: 'entry-9', data: {} }]
          : [];
      },
      readRecord: () => ({}),
    });

    const result = await runMovement({
      source: LINKED_UPSERT,
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
    });

    expect(asked[1]).toMatchObject({ company: { id: 'ext-attio-1' } });
    expect(result.writes.map((w) => [w.recordType, w.created])).toEqual([
      ['person', true],
      ['company', false],
    ]);
    expect(attio.updates).toEqual([
      { recordType: 'company', externalId: 'entry-9', fields: { name: 'U123' } },
    ]);
  });

  it('`?:` leaves a value the found record already carries', async () => {
    const attio = makeFakeAdapter('attio', {
      describeType,
      resolveCandidates: (record) =>
        (record.company as { id?: string } | undefined)?.id === 'ext-attio-1'
          ? [{ adapterType: 'attio', externalId: 'entry-9', data: {} }]
          : [],
      // The found record already has a name — a fill has nothing to fill.
      readRecord: () => ({ name: 'already set' }),
    });

    await runMovement({
      source: LINKED_UPSERT,
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
    });

    // Nothing of the record's OWN left to write — but the write names a
    // parent, so the adapter is still called, with an EMPTY field set, to
    // make the association. Matching is not associating.
    expect(attio.updates).toEqual([
      { recordType: 'company', externalId: 'entry-9', fields: {} },
    ]);
  });
});

// ── 6b. Standalone edge statements (E7 — the Adapter.linkRecords seam) ───────

describe('standalone edge statements — adapter linkRecords', () => {
  // Two ROOT writes (no parent-child shape), then the edge assert — the
  // residual case linked writes don't cover. The thin attio schema
  // declares person -[company]-> company, so the edge resolves against
  // the from-side's type.
  const EDGE_ASSERT = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  p = write crm-[:people]-> {',
    '    unique by (`email`)',
    '    name:  msg.`user`',
    '    email: msg.`user`',
    '  }',
    '  co = write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name: msg.`user`',
    '  }',
    '  link p -[:company]-> co',
    '}',
  ].join('\n');

  function withLinkRecords(fake: ReturnType<typeof makeFakeAdapter>) {
    const linkCalls: Parameters<NonNullable<Adapter['linkRecords']>>[0][] = [];
    fake.adapter.linkRecords = async (input) => {
      linkCalls.push(input);
      return { created: true };
    };
    return linkCalls;
  }

  it('routes the assert through linkRecords (reference-field semantics are the adapter’s) and records it with both endpoints’ provenance', async () => {
    const attio = makeFakeAdapter('attio');
    const linkCalls = withLinkRecords(attio);

    const result = await runMovement({
      source: EDGE_ASSERT,
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
    });

    expect(linkCalls).toEqual([
      {
        from: { recordType: 'person', externalId: 'ext-attio-1' },
        edgeName: 'company',
        to: { recordType: 'company', externalId: 'ext-attio-2' },
        mutationContext: expect.objectContaining({
          source: expect.objectContaining({ adapterType: 'slack' }),
        }),
      },
    ]);
    expect(result.writes[2]).toEqual({
      kind: 'link',
      adapterType: 'attio',
      recordType: 'person',
      created: true,
      committed: true,
      externalId: 'ext-attio-1',
      writtenValues: {},
      link: { edgeName: 'company', toRecordType: 'company', toExternalId: 'ext-attio-2' },
      provenance: {
        from: [{ kind: 'write', write: 0, externalId: 'ext-attio-1' }],
        to: [{ kind: 'write', write: 1, externalId: 'ext-attio-2' }],
      },
    });
  });

  it('rejects a cross-graph edge with both graphs named (the checker only name-checks)', async () => {
    const attio = makeFakeAdapter('attio');
    withLinkRecords(attio);
    const promise = runMovement({
      source: [
        PRELUDE,
        '',
        'movement m(msg: <inbox-[:message]->>) {',
        '  p = write crm-[:people]-> {',
        '    unique by (`email`)',
        '    name:  msg.`user`',
        '    email: msg.`user`',
        '  }',
        '  note = write inbox-[:messages]-> {',
        '    channel: "#x"',
        '    text:    msg.`user`',
        '  }',
        '  link p -[:company]-> note',
        '}',
      ].join('\n'),
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
    });
    expect(await rejectionCause(promise)).toBeInstanceOf(MovementEngineError);
    await expect(promise).rejects.toThrow(
      /MOVENG_RUNTIME[\s\S]*both handles must live in the same graph[\s\S]*'p' is in 'crm'[\s\S]*'note' is in 'inbox'/,
    );
  });

  it('rejects an adapter without the linkRecords capability, by name, suggesting the linked write', async () => {
    // makeFakeAdapter has no linkRecords — the capability gap case.
    const promise = runMovement({
      source: EDGE_ASSERT,
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
    });
    expect(await rejectionCause(promise)).toBeInstanceOf(MovementEngineError);
    await expect(promise).rejects.toThrow(
      /MOVENG_RUNTIME[\s\S]*'attio' adapter cannot link two existing records[\s\S]*linked write/,
    );
  });

  it('dry-run captures the would-be link and never calls the real adapter', async () => {
    const attio = makeFakeAdapter('attio');
    const linkCalls = withLinkRecords(attio);
    const captured: CapturedWrite[] = [];

    const result = await runMovement({
      source: EDGE_ASSERT,
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      dryRun: true,
      writeSink: (w) => captured.push(w),
    });

    expect(linkCalls).toHaveLength(0);
    expect(attio.creates).toHaveLength(0);
    const link = captured.find((w) => w.kind === 'link');
    expect(link).toEqual({
      kind: 'link',
      adapterType: 'attio',
      recordType: 'person',
      externalId: expect.any(String),
      link: {
        edgeName: 'company',
        toRecordType: 'company',
        toExternalId: expect.any(String),
      },
    });
    // The firing record still carries the edge entry (the preview shows
    // what would have been asserted).
    expect(result.writes[2]).toEqual(
      expect.objectContaining({
        created: true,
        link: expect.objectContaining({ edgeName: 'company' }),
      }),
    );
  });
});

// ── 6c. `?:` set-if-empty fields ─────────────────────────────────────────────

describe("'?:' set-if-empty fields — written only when the target's current value is empty", () => {
  // One write that always matches an existing record (resolveCandidates
  // returns one), mixing a plain field with a `?:` field.
  const FILL_WRITE = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name:     msg.`user`',
    '    summary ?: msg.`text`',
    '  }',
    '}',
  ].join('\n');

  function matchingAttio(currentValues: Record<string, unknown> | null) {
    const fake = makeFakeAdapter('attio', {
      resolveCandidates: () => [
        { adapterType: 'attio', externalId: 'existing-1', data: {} },
      ],
    });
    if (currentValues !== null) {
      fake.adapter.readRecord = async () => currentValues;
    }
    return fake;
  }

  async function runFill(attio: ReturnType<typeof makeFakeAdapter>, opts: {
    dryRun?: boolean;
    writeSink?: (w: CapturedWrite) => void;
  } = {}) {
    return runMovement({
      source: FILL_WRITE,
      event: webhookEvent('slack', { user: 'Acme', text: 'a fresh summary' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      ...opts,
    });
  }

  it('skips the `?:` field on update when the current value is present (plain field still overwrites)', async () => {
    const attio = matchingAttio({ name: 'Old Name', summary: 'already written' });
    const result = await runFill(attio);
    expect(attio.updates).toEqual([
      {
        recordType: 'company',
        externalId: 'existing-1',
        fields: { name: 'Acme' }, // summary suppressed — already filled
      },
    ]);
    // The firing record's writtenValues distinguish: only fields actually
    // written appear.
    expect(result.writes[0].writtenValues).toEqual({ name: 'Acme' });
  });

  it('writes the `?:` field on update when the current value is empty (null or absent)', async () => {
    const attio = matchingAttio({ name: 'Old Name', summary: null });
    await runFill(attio);
    expect(attio.updates[0].fields).toEqual({ name: 'Acme', summary: 'a fresh summary' });
  });

  it('treats an unreadable current value as empty (no readRecord → fill writes, mirroring set-if-null)', async () => {
    const attio = matchingAttio(null); // adapter has no readRecord
    await runFill(attio);
    expect(attio.updates[0].fields).toEqual({ name: 'Acme', summary: 'a fresh summary' });
  });

  it("an empty string counts as a value — `?:` doesn't overwrite it (TG set-if-null parity)", async () => {
    const attio = matchingAttio({ name: 'Acme', summary: '' });
    const result = await runFill(attio);
    // name is a no-op (equal); summary is '' — present, so the fill skips:
    // nothing to write at all.
    expect(attio.updates).toEqual([]);
    expect(result.writes[0].writtenValues).toEqual({});
  });

  it('behaves as a plain set on create', async () => {
    const attio = makeFakeAdapter('attio'); // no candidates → create
    await runFill(attio);
    expect(attio.creates).toEqual([
      {
        recordType: 'company',
        fields: { name: 'Acme', summary: 'a fresh summary' },
      },
    ]);
  });

  it('dry-run capture excludes the suppressed `?:` field (reads still hit the live record)', async () => {
    const attio = matchingAttio({ name: 'Old Name', summary: 'already written' });
    const captured: CapturedWrite[] = [];
    await runFill(attio, { dryRun: true, writeSink: (w) => captured.push(w) });
    expect(attio.updates).toHaveLength(0);
    expect(captured).toEqual([
      expect.objectContaining({
        kind: 'update',
        externalId: 'existing-1',
        fields: { name: 'Acme' },
      }),
    ]);
  });
});

// ── 6c-ii. `+:` / `+?:` append on a multi-valued field ──────────────────────

describe("'+:' / '+?:' append operators — merge the new value into the current list", () => {
  const APPEND = (op: '+:' | '+?:') =>
    [
      PRELUDE,
      '',
      'movement m(msg: <inbox-[:message]->>) {',
      '  write crm-[:companies]-> {',
      '    unique by (`name`)',
      '    name:     msg.`user`',
      `    domains ${op} [msg.\`text\`]`,
      '  }',
      '}',
    ].join('\n');

  function matchingAttio(currentValues: Record<string, unknown> | null) {
    const fake = makeFakeAdapter('attio', {
      resolveCandidates: () => [{ adapterType: 'attio', externalId: 'existing-1', data: {} }],
    });
    if (currentValues !== null) fake.adapter.readRecord = async () => currentValues;
    return fake;
  }

  const run = (op: '+:' | '+?:', attio: ReturnType<typeof makeFakeAdapter>) =>
    runMovement({
      source: APPEND(op),
      event: webhookEvent('slack', { user: 'Acme', text: 'new.com' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: attio.adapter, slack: makeFakeAdapter('slack').adapter }),
    });

  it("'+:' appends the new value onto the current list", async () => {
    const attio = matchingAttio({ name: 'Acme', domains: ['old.com'] });
    await run('+:', attio);
    expect(attio.updates[0].fields.domains).toEqual(['old.com', 'new.com']);
  });

  it("'+:' is a no-op when the appended value adds nothing (deep-equal merge)", async () => {
    const attio = matchingAttio({ name: 'Acme', domains: ['new.com'] });
    await run('+:', attio);
    // append concatenates, so ['new.com'] ++ ['new.com'] = ['new.com','new.com']
    // — NOT equal to current, so it DOES write (duplicates allowed by '+').
    expect(attio.updates[0].fields.domains).toEqual(['new.com', 'new.com']);
  });

  it("'+?:' appends only values not already present (dedupes)", async () => {
    const attio = matchingAttio({ name: 'Acme', domains: ['new.com'] });
    await run('+?:', attio);
    // 'new.com' already present → nothing to add → whole write is a no-op.
    expect(attio.updates).toEqual([]);
  });

  it("'+?:' adds a genuinely new value", async () => {
    const attio = matchingAttio({ name: 'Acme', domains: ['old.com'] });
    await run('+?:', attio);
    expect(attio.updates[0].fields.domains).toEqual(['old.com', 'new.com']);
  });

  // On create there is no current value, so append is structurally a plain set:
  // applyCreate never consults `fieldSemantics`. A create still fires (the
  // append doesn't suppress it).
  it('still creates on a no-match (append is a plain set on create)', async () => {
    const attio = makeFakeAdapter('attio'); // no candidates → create
    await run('+:', attio);
    expect(attio.creates).toHaveLength(1);
    expect(attio.updates).toHaveLength(0);
  });
});

// ── 6c-iii. Matching is not associating — the parent-only attach ────────────

describe('a matched child with nothing of its own to change still attaches to its parent', () => {
  // `write org-[:People]-> { … }` against a person who already exists with
  // exactly those names: every field is suppressed, but the write still names
  // a parent, and only the adapter can make that association. Early-returning
  // on the empty field set dropped every person↔organization edge in
  // production (run 3285f127) — the record matched, and nothing attached.
  const LINKED = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  p = write crm-[:people]-> {',
    '    unique by (`email`)',
    '    name:  msg.`user`',
    '    email: msg.`user`',
    '  }',
    '  write p-[:company]-> {',
    '    unique by (`name`)',
    '    name: msg.`user`',
    '  }',
    '}',
  ].join('\n');

  const ROOT = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name: msg.`user`',
    '  }',
    '}',
  ].join('\n');

  /** The attio fake, plus every `updateRecord` call with its parent links —
   *  the shared fake records fields only. `current` is what the matched child
   *  already carries, so the caller decides whether anything changed. */
  function matchingAttio(current: Record<string, unknown>) {
    const fake = makeFakeAdapter('attio', {
      // The person write carries `email`; the child company write does not —
      // so only the child resolves to an existing record.
      resolveCandidates: (record) =>
        'email' in record ? [] : [{ adapterType: 'attio', externalId: 'existing-co', data: {} }],
      readRecord: () => current,
    });
    const updates: Array<{ externalId?: string; fields: Record<string, unknown>; parentLinks: unknown }> = [];
    const base = fake.adapter.updateRecord.bind(fake.adapter);
    fake.adapter.updateRecord = async (input) => {
      updates.push({
        externalId: input.externalId,
        fields: input.fields,
        parentLinks: input.parentLinks ?? null,
      });
      return base(input);
    };
    return { fake, updates };
  }

  const run = (source: string, attio: Adapter) =>
    runMovement({
      source,
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio, slack: makeFakeAdapter('slack').adapter }),
    });

  it('calls the adapter with an empty field set and the parent link, and reads `attach`', async () => {
    const { fake, updates } = matchingAttio({ name: 'U123' });

    const result = await run(LINKED, fake.adapter);

    expect(updates).toEqual([
      {
        externalId: 'existing-co',
        fields: {},
        parentLinks: [
          { recordType: 'person', externalId: 'ext-attio-1', edgeName: 'company', data: {} },
        ],
      },
    ]);
    expect(result.writes.map((w) => [w.recordType, w.created, w.outcome])).toEqual([
      ['person', true, 'create'],
      ['company', false, 'attach'],
    ]);
    expect(result.writes[1].writtenValues).toEqual({});
    expect(result.writes[1].parents).toEqual([
      { recordType: 'person', externalId: 'ext-attio-1', edgeName: 'company' },
    ]);
  });

  it('a genuinely changed field is an `update`, parent link and all', async () => {
    const { fake, updates } = matchingAttio({ name: 'stale' });

    const result = await run(LINKED, fake.adapter);

    expect(updates[0].fields).toEqual({ name: 'U123' });
    expect(result.writes.map((w) => w.outcome)).toEqual(['create', 'update']);
  });

  it('no parent and nothing changed sends nothing at all — `noop`', async () => {
    const attio = makeFakeAdapter('attio', {
      resolveCandidates: () => [{ adapterType: 'attio', externalId: 'existing-1', data: {} }],
      readRecord: () => ({ name: 'U123' }),
    });

    const result = await run(ROOT, attio.adapter);

    expect(attio.updates).toEqual([]);
    expect(result.writes.map((w) => [w.created, w.outcome])).toEqual([[false, 'noop']]);
  });

  // `attach` says the record is attached, not that the engine sent a write —
  // so the fact comes from the adapter, and the write records which of the two
  // things happened.
  it.each([
    ['made' as const, 'made'],
    ['already' as const, 'already'],
  ])("carries the target's own answer (%s) onto the write", async (answer, expected) => {
    const { fake } = matchingAttio({ name: 'U123' });
    const base = fake.adapter.updateRecord.bind(fake.adapter);
    fake.adapter.updateRecord = async (input) => ({ ...(await base(input)), association: answer });

    const result = await run(LINKED, fake.adapter);

    expect(result.writes.map((w) => [w.outcome, w.association])).toEqual([
      ['create', undefined],
      ['attach', expected],
    ]);
  });

  // The honest outcome when a system cannot attach an existing record along
  // the edge the author wrote: the run fails, naming the edge. Reporting
  // success would be exactly the silence that let production drop every edge.
  it('fails the run when the target cannot attach an existing record', async () => {
    const { fake } = matchingAttio({ name: 'U123' });
    const base = fake.adapter.updateRecord.bind(fake.adapter);
    fake.adapter.updateRecord = async (input) => ({
      ...(await base(input)),
      association: 'unsupported' as const,
    });

    await expect(run(LINKED, fake.adapter)).rejects.toThrow(
      "'attio' cannot attach an existing company to person ext-attio-1 through company",
    );
  });
});

// ── 6d. unlink — the inverse edge statement (Adapter.unlinkRecords) ──────────

describe('unlink statements — adapter unlinkRecords', () => {
  const UNLINK = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  p = write crm-[:people]-> {',
    '    unique by (`email`)',
    '    name:  msg.`user`',
    '    email: msg.`user`',
    '  }',
    '  co = write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name: msg.`user`',
    '  }',
    '  unlink p -[:company]-> co',
    '}',
  ].join('\n');

  function withUnlinkRecords(
    fake: ReturnType<typeof makeFakeAdapter>,
    result: { removed: boolean } = { removed: true },
  ) {
    const calls: Parameters<NonNullable<Adapter['unlinkRecords']>>[0][] = [];
    fake.adapter.unlinkRecords = async (input) => {
      calls.push(input);
      return result;
    };
    return calls;
  }

  async function runUnlink(attio: ReturnType<typeof makeFakeAdapter>, opts: {
    dryRun?: boolean;
    writeSink?: (w: CapturedWrite) => void;
  } = {}) {
    return runMovement({
      source: UNLINK,
      event: webhookEvent('slack', { user: 'U123' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      ...opts,
    });
  }

  it('routes the sever through unlinkRecords and records a kind-unlink entry with endpoint provenance', async () => {
    const attio = makeFakeAdapter('attio');
    const calls = withUnlinkRecords(attio);
    const result = await runUnlink(attio);
    expect(calls).toEqual([
      {
        from: { recordType: 'person', externalId: 'ext-attio-1' },
        edgeName: 'company',
        to: { recordType: 'company', externalId: 'ext-attio-2' },
        mutationContext: expect.objectContaining({
          source: expect.objectContaining({ adapterType: 'slack' }),
        }),
      },
    ]);
    expect(result.writes[2]).toEqual({
      kind: 'unlink',
      adapterType: 'attio',
      recordType: 'person',
      created: true, // a link existed and was severed
      committed: true,
      externalId: 'ext-attio-1',
      writtenValues: {},
      link: { edgeName: 'company', toRecordType: 'company', toExternalId: 'ext-attio-2' },
      provenance: {
        from: [{ kind: 'write', write: 0, externalId: 'ext-attio-1' }],
        to: [{ kind: 'write', write: 1, externalId: 'ext-attio-2' }],
      },
    });
  });

  it('an absent link is an idempotent no-op recorded as created: false', async () => {
    const attio = makeFakeAdapter('attio');
    withUnlinkRecords(attio, { removed: false });
    const result = await runUnlink(attio);
    expect(result.writes[2]).toEqual(
      expect.objectContaining({ kind: 'unlink', created: false }),
    );
  });

  it('rejects an adapter without the unlinkRecords capability, by name', async () => {
    const promise = runUnlink(makeFakeAdapter('attio'));
    expect(await rejectionCause(promise)).toBeInstanceOf(MovementEngineError);
    await expect(promise).rejects.toThrow(
      /MOVENG_RUNTIME[\s\S]*'attio' adapter cannot sever a link[\s\S]*no unlinkRecords capability/,
    );
  });

  it('dry-run captures the would-be unlink and never calls the real adapter', async () => {
    const attio = makeFakeAdapter('attio');
    const calls = withUnlinkRecords(attio);
    const captured: CapturedWrite[] = [];
    const result = await runUnlink(attio, { dryRun: true, writeSink: (w) => captured.push(w) });
    expect(calls).toHaveLength(0);
    const unlink = captured.find((w) => w.kind === 'unlink');
    expect(unlink).toEqual({
      kind: 'unlink',
      adapterType: 'attio',
      recordType: 'person',
      externalId: expect.any(String),
      link: {
        edgeName: 'company',
        toRecordType: 'company',
        toExternalId: expect.any(String),
      },
    });
    expect(result.writes[2]).toEqual(
      expect.objectContaining({ kind: 'unlink', created: true }),
    );
  });
});

// ── 6e. delete — record removal over a written handle ────────────────────────

describe('delete statements — adapter deleteRecord', () => {
  const DELETE = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  stale = write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name: msg.`user`',
    '  }',
    '  delete stale',
    '}',
  ].join('\n');

  async function runDelete(attio: ReturnType<typeof makeFakeAdapter>, opts: {
    dryRun?: boolean;
    writeSink?: (w: CapturedWrite) => void;
  } = {}) {
    return runMovement({
      source: DELETE,
      event: webhookEvent('slack', { user: 'Acme' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      ...opts,
    });
  }

  it('routes the removal through deleteRecord and records a kind-delete entry chaining to the handle write', async () => {
    const attio = makeFakeAdapter('attio');
    const deleteCalls: Array<{ recordType: string; externalId: string }> = [];
    attio.adapter.deleteRecord = async (input) => {
      deleteCalls.push({ recordType: input.recordType, externalId: input.externalId });
      return {};
    };
    const result = await runDelete(attio);
    expect(deleteCalls).toEqual([{ recordType: 'company', externalId: 'ext-attio-1' }]);
    expect(result.writes[1]).toEqual({
      kind: 'delete',
      adapterType: 'attio',
      recordType: 'company',
      created: false,
      committed: true,
      externalId: 'ext-attio-1',
      writtenValues: {},
      provenance: {
        record: [{ kind: 'write', write: 0, externalId: 'ext-attio-1' }],
      },
    });
  });

  it('rejects an adapter without a deleteRecord implementation, by name', async () => {
    const attio = makeFakeAdapter('attio');
    delete (attio.adapter as Partial<Adapter>).deleteRecord;
    const promise = runDelete(attio);
    expect(await rejectionCause(promise)).toBeInstanceOf(MovementEngineError);
    await expect(promise).rejects.toThrow(
      /MOVENG_RUNTIME[\s\S]*'attio' adapter cannot delete records[\s\S]*no deleteRecord capability/,
    );
  });

  it('dry-run captures the would-be delete and never calls the real adapter', async () => {
    const attio = makeFakeAdapter('attio');
    const deleteCalls: unknown[] = [];
    attio.adapter.deleteRecord = async (input) => {
      deleteCalls.push(input);
      return {};
    };
    const captured: CapturedWrite[] = [];
    const result = await runDelete(attio, { dryRun: true, writeSink: (w) => captured.push(w) });
    expect(deleteCalls).toHaveLength(0);
    expect(captured.find((w) => w.kind === 'delete')).toEqual({
      kind: 'delete',
      adapterType: 'attio',
      recordType: 'company',
      externalId: expect.any(String),
    });
    expect(result.writes[1]).toEqual(
      expect.objectContaining({ kind: 'delete', created: false }),
    );
  });
});

// ── 7. Event schema-edge block heads (E6 — the adapter getRelated seam) ──────

describe('event schema-edge block heads — positions stream via the source adapter', () => {
  /** A slack source whose `files` edge yields one position per entry of
   *  the payload's `files` array — the data bag is the file's fields. */
  function slackWithFiles(): { adapter: Adapter; relatedCalls: Array<{ fieldId: string; direction: string }> } {
    const relatedCalls: Array<{ fieldId: string; direction: string }> = [];
    const base = makeFakeAdapter('slack');
    base.adapter.getRelated = async ({ position, fieldId, direction }) => {
      relatedCalls.push({ fieldId, direction });
      const data = positionData(position) as { files?: Array<Record<string, unknown>> } | undefined;
      return (data?.files ?? []).map((file, i) => ({
        position: makeStablePosition({
          adapterType: 'slack',
          recordType: 'file',
          recordId: `file-${i + 1}`,
          data: file,
        }),
      }));
    };
    return { adapter: base.adapter, relatedCalls };
  }

  const FILES_BLOCK = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  msg-[f:files]-> {',
    '    write crm-[:companies]-> {',
    '      unique by (`name`)',
    '      name:    f.`name`',
    '      summary: msg.`user`',
    '    }',
    '  }',
    '}',
  ].join('\n');

  it('runs the body once per yielded position, alias bound per iteration (per-position isolation)', async () => {
    const slack = slackWithFiles();
    const attio = makeFakeAdapter('attio');
    const result = await runMovement({
      source: FILES_BLOCK,
      event: webhookEvent('slack', {
        user: 'U1',
        files: [{ name: 'deck.pdf' }, { name: 'notes.txt' }],
      }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ slack: slack.adapter, attio: attio.adapter }),
    });

    expect(slack.relatedCalls).toEqual([{ fieldId: 'files', direction: 'outgoing' }]);
    // One write per yielded file; each iteration read ITS OWN position's
    // field (no cross-iteration leakage) and could still read the event.
    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'deck.pdf', summary: 'U1' } },
      { recordType: 'company', fields: { name: 'notes.txt', summary: 'U1' } },
    ]);
    expect(result.writes.map((w) => w.created)).toEqual([true, true]);
    // The yielded record's field reads carry record-resolved provenance.
    expect(result.writes[0].provenance.name).toEqual([
      {
        kind: 'source_field',
        instance: 'inbox',
        adapterType: 'slack',
        recordType: 'file',
        externalId: 'file-1',
        field: 'name',
      },
    ]);
  });

  it('zero yields → zero iterations (the block body never runs)', async () => {
    const slack = slackWithFiles();
    const attio = makeFakeAdapter('attio');
    await runMovement({
      source: FILES_BLOCK,
      event: webhookEvent('slack', { user: 'U1', files: [] }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ slack: slack.adapter, attio: attio.adapter }),
    });
    expect(attio.creates).toEqual([]);
  });

  it('a per-hop WHERE filters on the walked edge’s inline properties (the bracket grammar’s edge_property currency)', async () => {
    const WHERE_BLOCK = FILES_BLOCK.replace(
      'msg-[f:files]->',
      'msg-[f:files WHERE pinned = true]->',
    );
    const slack = makeFakeAdapter('slack');
    slack.adapter.getRelated = async ({ position }) => {
      const data = positionData(position) as
        | { files?: Array<{ name: string; pinned: boolean }> }
        | undefined;
      return (data?.files ?? []).map((file, i) => ({
        position: makeStablePosition({
          adapterType: 'slack',
          recordType: 'file',
          recordId: `file-${i + 1}`,
          data: { name: file.name },
        }),
        edgeProperties: { pinned: file.pinned },
      }));
    };
    const attio = makeFakeAdapter('attio');
    await runMovement({
      source: WHERE_BLOCK,
      event: webhookEvent('slack', {
        user: 'U1',
        files: [
          { name: 'deck.pdf', pinned: true },
          { name: 'notes.txt', pinned: false },
        ],
      }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ slack: slack.adapter, attio: attio.adapter }),
    });
    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'deck.pdf', summary: 'U1' } },
    ]);
  });
});

// ── 7b. A bound block's returned RECORDS, walked and folded after it ─────────

describe('a block that returns records — the binding is walked like any position', () => {
  /** Slack yields one `file` position per entry of the payload's `files`. */
  function slackWithFiles(): ReturnType<typeof makeFakeAdapter> {
    const base = makeFakeAdapter('slack');
    base.adapter.getRelated = async ({ position, fieldId }) => {
      if (fieldId !== 'files') return [];
      const data = positionData(position) as { files?: Array<Record<string, unknown>> } | undefined;
      return (data?.files ?? []).map((file, i) => ({
        position: makeStablePosition({
          adapterType: 'slack',
          recordType: 'file',
          recordId: `file-${i + 1}`,
          data: file,
        }),
      }));
    };
    return base;
  }

  /** Attio hangs one investment off every company it is asked about. */
  function attioWithInvestments(): ReturnType<typeof makeFakeAdapter> {
    const base = makeFakeAdapter('attio');
    let seq = 0;
    base.adapter.getRelated = async ({ fieldId }) => {
      if (fieldId !== 'investments') return [];
      seq += 1;
      return [
        {
          position: makeStablePosition({
            adapterType: 'attio',
            recordType: 'investment',
            recordId: `inv-${seq}`,
            data: { amount: 100 },
          }),
        },
      ];
    };
    return base;
  }

  const RETURNED_RECORDS = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  orgs = msg-[f:files]-> {',
    '    return write crm-[:companies]-> {',
    '      unique by (`name`)',
    '      name: f.`name`',
    '    }',
    '  }',
    '  orgs-[i:investments]-> {',
    '    write inbox-[:messages]-> {',
    '      channel: "#log"',
    '      text:    "investment ${i.`amount`}"',
    '    }',
    '  }',
    '  write inbox-[:messages]-> {',
    '    channel: "#log"',
    '    text:    "Logged ${COUNT(orgs)} companies"',
    '  }',
    '}',
  ].join('\n');

  async function run(files: Array<Record<string, unknown>>) {
    const slack = slackWithFiles();
    const attio = attioWithInvestments();
    await runMovement({
      source: RETURNED_RECORDS,
      event: webhookEvent('slack', { user: 'U1', files }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ slack: slack.adapter, attio: attio.adapter }),
    });
    return { slack, attio };
  }

  it('walks the returned handles and folds over them', async () => {
    const { slack, attio } = await run([{ name: 'deck.pdf' }, { name: 'notes.txt' }]);
    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'deck.pdf' } },
      { recordType: 'company', fields: { name: 'notes.txt' } },
    ]);
    // One hop iteration per returned handle, then the fold over the same binding.
    expect(slack.creates).toEqual([
      { recordType: 'message', fields: { channel: '#log', text: 'investment 100' } },
      { recordType: 'message', fields: { channel: '#log', text: 'investment 100' } },
      { recordType: 'message', fields: { channel: '#log', text: 'Logged 2 companies' } },
    ]);
  });

  it('a block that ran zero times hops QUIETLY and counts as empty', async () => {
    // The traversal gate: an empty collection has nothing to hop from, so the
    // hop's body runs zero times — the same silence any empty traversal gives.
    // Binding it on the value plane instead would make the hop an error, which
    // is what the handbook's `orgs`/`orgs-[n:Notes]->` pair promises it is not.
    const { slack, attio } = await run([]);
    expect(attio.creates).toEqual([]);
    expect(slack.creates).toEqual([
      { recordType: 'message', fields: { channel: '#log', text: 'Logged 0 companies' } },
    ]);
  });
});

// ── 8. EXISTS() — the frozen quantifier semantics at runtime (E6) ────────────

describe('EXISTS — adapter-edge quantifiers gate writes', () => {
  function slackWithFiles(): Adapter {
    const base = makeFakeAdapter('slack');
    base.adapter.getRelated = async ({ position, fieldId }) => {
      if (fieldId !== 'files') return [];
      const data = positionData(position) as { files?: Array<Record<string, unknown>> } | undefined;
      return (data?.files ?? []).map((file, i) => ({
        position: makeStablePosition({
          adapterType: 'slack',
          recordType: 'file',
          recordId: `file-${i + 1}`,
          data: file,
        }),
      }));
    };
    return base.adapter;
  }

  const GATED = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  if EXISTS(msg-[:files]->) {',
    '    write crm-[:companies]-> {',
    '      unique by (`name`)',
    '      name: msg.`user`',
    '    }',
    '  } else {',
    '    write inbox-[:messages]-> { channel: "#bare", text: "no files" }',
    '  }',
    '}',
  ].join('\n');

  async function runGated(source: string, payload: Record<string, unknown>): Promise<CapturedWrite[]> {
    const writes: CapturedWrite[] = [];
    await runMovement({
      source,
      event: webhookEvent('slack', payload),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        slack: slackWithFiles(),
        attio: makeFakeAdapter('attio').adapter,
      }),
      dryRun: true,
      writeSink: (w) => writes.push(w),
    });
    return writes;
  }

  it('true on ≥1 yielded position — the gated write runs', async () => {
    const writes = await runGated(GATED, { user: 'U1', files: [{ name: 'deck.pdf' }] });
    expect(writes).toEqual([
      { kind: 'create', adapterType: 'attio', recordType: 'company', fields: { name: 'U1' } },
    ]);
  });

  it('false on zero yields — falls through to else', async () => {
    const writes = await runGated(GATED, { user: 'U1', files: [] });
    expect(writes[0].fields).toEqual({ channel: '#bare', text: 'no files' });
  });

  it('honors the WHERE filter against each landed position', async () => {
    const WHERE_GATED = GATED.replace(
      'EXISTS(msg-[:files]->)',
      'EXISTS(msg-[:files]-> WHERE `name` CONTAINS "pdf")',
    );
    const matching = await runGated(WHERE_GATED, {
      user: 'U1',
      files: [{ name: 'notes.txt' }, { name: 'deck.pdf' }],
    });
    expect(matching[0].fields).toEqual({ name: 'U1' });

    const nonMatching = await runGated(WHERE_GATED, {
      user: 'U1',
      files: [{ name: 'notes.txt' }],
    });
    expect(nonMatching[0].fields).toEqual({ channel: '#bare', text: 'no files' });
  });

  it('EXISTS in a write-field slot evaluates as a boolean value', async () => {
    const FIELD_SLOT = [
      PRELUDE,
      '',
      'movement m(msg: <inbox-[:message]->>) {',
      '  write inbox-[:messages]-> {',
      '    channel: "#out"',
      '    text:    EXISTS(msg-[:files]->)',
      '  }',
      '}',
    ].join('\n');
    const withFiles = await runGated(FIELD_SLOT, { user: 'U1', files: [{ name: 'a' }] });
    expect(withFiles[0].fields).toEqual({ channel: '#out', text: true });
    const bare = await runGated(FIELD_SLOT, { user: 'U1', files: [] });
    expect(bare[0].fields).toEqual({ channel: '#out', text: false });
  });
});

// ── 6f. match — find by identity, then link what was found ──────────────────

describe('match — find, arbitrate, bind the FOUND handle; link it with link', () => {
  const FIND_AND_LINK = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  co = write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name: msg.`user`',
    '  }',
    '  fund = match co-[:portfolio]-> { unique by (`name`), name: "Fund III" }',
    '  link co -[:portfolio]-> fund',
    '  write inbox-[:messages]-> {',
    '    channel: "#funds"',
    '    text:    "${fund.`vintage`} ${fund.`name`}"',
    '  }',
    '}',
  ].join('\n');

  function fundAttio() {
    const resolveCalls: Array<{ recordType: string; record: Record<string, unknown> }> = [];
    const fake = makeFakeAdapter('attio');
    const baseResolve = fake.adapter.resolveEntity.bind(fake.adapter);
    fake.adapter.resolveEntity = async (input) => {
      resolveCalls.push({ recordType: input.recordType, record: input.record });
      if (input.recordType === 'fund' && input.record.name === 'Fund III') {
        return {
          candidates: [
            {
              adapterType: 'attio',
              externalId: 'fund-7',
              url: 'https://crm/funds/7',
              data: { name: 'Fund III' },
            },
          ],
        };
      }
      return baseResolve(input);
    };
    fake.adapter.readRecord = async ({ recordType }) =>
      recordType === 'fund' ? { vintage: '2024' } : null;
    const linkCalls: Parameters<NonNullable<Adapter['linkRecords']>>[0][] = [];
    fake.adapter.linkRecords = async (input) => {
      linkCalls.push(input);
      return { created: true };
    };
    return { fake, resolveCalls, linkCalls };
  }

  async function runFind(adapters: { attio: Adapter; slack: Adapter }, source = FIND_AND_LINK) {
    return runMovement({
      source,
      event: webhookEvent('slack', { user: 'Acme' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver(adapters),
    });
  }

  it('resolves like a write identity, binds the found record (resultData via readRecord), and link joins it', async () => {
    const { fake, resolveCalls, linkCalls } = fundAttio();
    const slack = makeFakeAdapter('slack');
    const result = await runFind({ attio: fake.adapter, slack: slack.adapter });

    // The match resolved through the same resolveEntity gate a write uses;
    // the found record is never created and never written.
    expect(resolveCalls.find((c) => c.recordType === 'fund')).toEqual({
      recordType: 'fund',
      record: { name: 'Fund III' },
    });
    expect(fake.creates.map((c) => c.recordType)).toEqual(['company']);
    expect(fake.updates).toEqual([]);

    expect(linkCalls).toEqual([
      {
        from: { recordType: 'company', externalId: 'ext-attio-1' },
        edgeName: 'portfolio',
        to: { recordType: 'fund', externalId: 'fund-7' },
        mutationContext: expect.objectContaining({
          source: expect.objectContaining({ adapterType: 'slack' }),
        }),
      },
    ]);

    // The run log shows what the match found — a `match` row, nothing
    // written, nothing committed — and the link's to-side chains to it.
    expect(result.writes[1]).toEqual({
      bindingName: 'fund',
      kind: 'match',
      adapterType: 'attio',
      recordType: 'fund',
      created: false,
      committed: false,
      externalId: 'fund-7',
      writtenValues: {},
      resultData: { url: 'https://crm/funds/7', name: 'Fund III', vintage: '2024' },
      provenance: {},
      origin: { kind: 'write', writeIndex: 1, externalId: 'fund-7' },
    });
    expect(result.writes[2]).toMatchObject({
      kind: 'link',
      recordType: 'company',
      externalId: 'ext-attio-1',
      link: { edgeName: 'portfolio', toRecordType: 'fund', toExternalId: 'fund-7' },
      provenance: {
        from: [{ kind: 'write', write: 0, externalId: 'ext-attio-1' }],
        to: [{ kind: 'write', write: 1, externalId: 'fund-7' }],
      },
    });

    // The bound handle reads the FOUND record: candidate snapshot merged
    // with the adapter's full readRecord payload.
    expect(slack.creates).toEqual([
      { recordType: 'message', fields: { channel: '#funds', text: '2024 Fund III' } },
    ]);
  });

  it('on missing, the enclosing scope ends quietly — the movement body stops after the work already done', async () => {
    const fake = makeFakeAdapter('attio'); // no fund candidates ever
    const linkCalls: Parameters<NonNullable<Adapter['linkRecords']>>[0][] = [];
    fake.adapter.linkRecords = async (input) => {
      linkCalls.push(input);
      return { created: true };
    };
    const slack = makeFakeAdapter('slack');
    const result = await runFind({ attio: fake.adapter, slack: slack.adapter });

    // The company write stands; the match found nothing, so the rest of
    // the body — the link and the message — never ran. Nothing threw, and
    // nothing about the fund was written.
    expect(result.writes.map((w) => [w.recordType, w.kind ?? 'write'])).toEqual([
      ['company', 'write'],
    ]);
    expect(fake.creates.map((c) => c.recordType)).toEqual(['company']);
    expect(fake.updates).toEqual([]);
    expect(linkCalls).toEqual([]);
    expect(slack.creates).toEqual([]);
  });

  describe('a link body is match then link', () => {
    const TWO = [
      '  fund = match co-[:portfolio]-> { unique by (`name`), name: "Fund III" }',
      '  link co -[:portfolio]-> fund',
    ].join('\n');
    const sugared = (statement: string) => FIND_AND_LINK.replace(TWO, statement);

    async function runBoth(statement: string) {
      const run = async (source: string) => {
        const { fake, resolveCalls, linkCalls } = fundAttio();
        const constraints: unknown[] = [];
        const resolve = fake.adapter.resolveEntity.bind(fake.adapter);
        fake.adapter.resolveEntity = async (input) => {
          if (input.recordType === 'fund') constraints.push(input.constraints);
          return resolve(input);
        };
        const slack = makeFakeAdapter('slack');
        const result = await runFind({ attio: fake.adapter, slack: slack.adapter }, source);
        return { result, resolveCalls, linkCalls, constraints, messages: slack.creates };
      };
      return { twoStatements: await run(FIND_AND_LINK), sugar: await run(sugared(statement)) };
    }

    it('bound, with no unique by: identifies by all of its fields, then links and binds exactly as the two statements do', async () => {
      const { twoStatements, sugar } = await runBoth('  fund = link co -[:portfolio]-> { name: "Fund III" }');
      // The body's one field IS the identity: the same AND-group the
      // two-statement form spells as `unique by (\`name\`)`.
      expect(sugar.constraints).toEqual(twoStatements.constraints);
      expect(JSON.stringify(sugar.constraints)).toContain('"field":"name"');
      // Same run log (the match row, then the link row), same adapter calls,
      // and the bound handle reads the found record downstream.
      // (The message after them differs only in the source lines its
      // provenance points at: the sugar is one line shorter.)
      expect(sugar.result.writes.slice(0, 3)).toEqual(twoStatements.result.writes.slice(0, 3));
      expect(sugar.result.writes.map((w) => w.kind ?? 'write')).toEqual(['write', 'match', 'link', 'write']);
      const joined = (calls: typeof sugar.linkCalls) => calls.map(({ from, edgeName, to }) => ({ from, edgeName, to }));
      expect(joined(sugar.linkCalls)).toEqual(joined(twoStatements.linkCalls));
      expect(sugar.messages).toEqual([
        { recordType: 'message', fields: { channel: '#funds', text: '2024 Fund III' } },
      ]);
    });

    it('unbound, with a unique by: the match row carries no binding and the link still joins what it found', async () => {
      const { sugar } = await runBoth(
        '  link co -[:portfolio]-> { unique by (`name`), name: "Fund III" }\n  fund = match co-[:portfolio]-> { unique by (`name`), name: "Fund III" }',
      );
      const [company, found, linked] = sugar.result.writes;
      expect(company.kind ?? 'write').toBe('write');
      expect(found).toMatchObject({ kind: 'match', externalId: 'fund-7' });
      expect(found.bindingName).toBeUndefined();
      expect(linked).toMatchObject({
        kind: 'link',
        link: { edgeName: 'portfolio', toRecordType: 'fund', toExternalId: 'fund-7' },
        provenance: { to: [{ kind: 'write', write: 1, externalId: 'fund-7' }] },
      });
      expect(sugar.linkCalls).toHaveLength(1);
    });

    it('on a miss, ends the enclosing scope quietly and links nothing', async () => {
      const fake = makeFakeAdapter('attio'); // no fund candidates ever
      const linkCalls: Parameters<NonNullable<Adapter['linkRecords']>>[0][] = [];
      fake.adapter.linkRecords = async (input) => {
        linkCalls.push(input);
        return { created: true };
      };
      const slack = makeFakeAdapter('slack');
      const result = await runFind(
        { attio: fake.adapter, slack: slack.adapter },
        sugared('  fund = link co -[:portfolio]-> { name: "Fund III" }'),
      );
      expect(result.writes.map((w) => [w.recordType, w.kind ?? 'write'])).toEqual([['company', 'write']]);
      expect(fake.creates.map((c) => c.recordType)).toEqual(['company']);
      expect(fake.updates).toEqual([]);
      expect(linkCalls).toEqual([]);
      expect(slack.creates).toEqual([]);
    });
  });

  it('on missing inside a fan-out, THAT iteration skips and the next proceeds', async () => {
    // One iteration per file; the match only finds a fund named 'Fund III'.
    const FILES_FIND = [
      PRELUDE,
      '',
      'movement m(msg: <inbox-[:message]->>) {',
      '  msg-[f:files]-> {',
      '    co = write crm-[:companies]-> {',
      '      unique by (`name`)',
      '      name: f.`name`',
      '    }',
      '    fund = match co-[:portfolio]-> { unique by (`name`), name: f.`url` }',
      '    link co -[:portfolio]-> fund',
      '    write inbox-[:messages]-> {',
      '      channel: "#funds"',
      '      text:    "${co.`name`} -> ${fund.`name`}"',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const fake = makeFakeAdapter('attio');
    const baseResolve = fake.adapter.resolveEntity.bind(fake.adapter);
    fake.adapter.resolveEntity = async (input) => {
      if (input.recordType === 'fund' && input.record.name === 'Fund III') {
        return {
          candidates: [{ adapterType: 'attio', externalId: 'fund-7', data: { name: 'Fund III' } }],
        };
      }
      return baseResolve(input);
    };
    fake.adapter.linkRecords = async () => ({ created: true });
    const slackSource = makeFakeAdapter('slack');
    slackSource.adapter.getRelated = async ({ position }) => {
      const data = positionData(position) as { files?: Array<Record<string, unknown>> } | undefined;
      return (data?.files ?? []).map((file, i) => ({
        position: makeStablePosition({
          adapterType: 'slack',
          recordType: 'file',
          recordId: `file-${i + 1}`,
          data: file,
        }),
      }));
    };

    const result = await runMovement({
      source: FILES_FIND,
      event: webhookEvent('slack', {
        files: [
          { name: 'deck.pdf', url: 'Fund III' },
          { name: 'notes.txt', url: 'Fund IX' }, // no such fund — iteration skips
          { name: 'memo.doc', url: 'Fund III' },
        ],
      }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ slack: slackSource.adapter, attio: fake.adapter }),
    });

    // Iterations 1 and 3 ran to completion; iteration 2 wrote its
    // company, missed the fund, and skipped the rest — quietly.
    expect(slackSource.creates.map((c) => c.fields.text)).toEqual([
      'deck.pdf -> Fund III',
      'memo.doc -> Fund III',
    ]);
    expect(fake.creates.map((c) => c.fields.name)).toEqual(['deck.pdf', 'notes.txt', 'memo.doc']);
    expect(result.writes.filter((w) => w.kind === 'match').map((w) => w.externalId)).toEqual([
      'fund-7',
      'fund-7',
    ]);
    expect(result.writes.filter((w) => w.kind === 'link')).toHaveLength(2);
  });
});

// ── 6f-ii. A discriminated write's handle stands on the variant ─────────────

// Adding a company to a list is addressed at the membership COLLECTION and
// creates a row of the one list the body named. The list's own type is the one
// that carries that list's fields and its reference edges, so that is what the
// handle stands on — which is what the checker typed it as, and what a chained
// link off it has to resolve against at run time.
describe('a discriminated write hands back a handle of the variant it named', () => {
  const listEntrySchema: InstanceSchema = {
    positions: {
      organization: {
        properties: { name: 'text' },
        edges: { 'List Entries': { target: 'entry', writable: true } },
      },
      entry: { properties: { listName: 'text' }, edges: {} },
      'List Entry — Deals': {
        properties: { listName: 'text' },
        edges: { Owners: { target: 'person', writable: true } },
      },
      person: { properties: { name: 'text' }, edges: {} },
    },
    collections: { organizations: { target: 'organization' }, people: { target: 'person' } },
    writableRoots: {
      organization: { fields: { name: 'text' }, resultShape: { externalId: 'text' } },
      person: { fields: { name: 'text' }, resultShape: { externalId: 'text' } },
    },
    createShapes: {
      entry: {
        fields: { listName: { kind: 'enum', options: ['Deals'] } },
        requiredFields: ['listName'],
        resultShape: { externalId: 'text' },
        discriminated: {
          discriminant: 'listName',
          variants: {
            Deals: {
              fields: { listName: 'text' },
              requiredFields: ['listName'],
              resultShape: { externalId: 'text' },
              edges: { Owners: { target: 'person', writable: true } },
              position: 'List Entry — Deals',
            },
          },
        },
      },
    },
  };

  const listCatalog = staticCatalogFromManifests({
    credentials: {
      dev_slack: { adapters: ['slack'] },
      acme_main: { adapters: ['attio'] },
    },
    instanceSchemas: { attio: listEntrySchema },
  });

  const ADD_AND_OWN = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  o = write crm-[:organizations]-> { name: msg.`user` }',
    '  e = write o-[:`List Entries`]-> { listName: "Deals" }',
    '  owner = match e-[:Owners]-> { unique by (`name`), name: "Ada" }',
    '  link e -[:Owners]-> owner',
    '}',
  ].join('\n');

  function listAttio(): {
    adapter: Adapter;
    creates: RecordedWrite[];
    linkCalls: Parameters<NonNullable<Adapter['linkRecords']>>[0][];
  } {
    const fake = makeFakeAdapter('attio', {
      resolveCandidates: (record) =>
        record.name === 'Ada'
          ? [{ adapterType: 'attio', externalId: 'person-3', data: {} }]
          : [],
    });
    const linkCalls: Parameters<NonNullable<Adapter['linkRecords']>>[0][] = [];
    fake.adapter.linkRecords = async (input) => {
      linkCalls.push(input);
      return { created: true };
    };
    return { adapter: fake.adapter, creates: fake.creates, linkCalls };
  }

  const runAdd = async (adapters: { attio: Adapter; slack: Adapter }, dryRun?: true) =>
    runMovement({
      source: ADD_AND_OWN,
      event: webhookEvent('slack', { user: 'Acme' }),
      teamId: TEAM_ID,
      catalog: listCatalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver(adapters),
      ...(dryRun ? { dryRun: true } : {}),
    });

  it('links off the entry as the LIST\'s type, while the create is still addressed to the collection', async () => {
    const attio = listAttio();
    await runAdd({ attio: attio.adapter, slack: makeFakeAdapter('slack').adapter });

    // Asked by the name the write named; landed on the type the body chose.
    expect(attio.creates.map((c) => c.recordType)).toEqual(['organization', 'entry']);
    expect(attio.linkCalls).toEqual([
      {
        from: { recordType: 'List Entry — Deals', externalId: 'ext-attio-2' },
        edgeName: 'Owners',
        to: { recordType: 'person', externalId: 'person-3' },
        mutationContext: expect.objectContaining({
          source: expect.objectContaining({ adapterType: 'slack' }),
        }),
      },
    ]);
  });

  it('rehearses the link instead of sending it, still naming the variant', async () => {
    const attio = listAttio();
    const result = await runAdd({ attio: attio.adapter, slack: makeFakeAdapter('slack').adapter }, true);

    expect(attio.linkCalls).toEqual([]);
    expect(attio.creates).toEqual([]);
    expect(result.writes.map((w) => [w.kind ?? 'write', w.recordType, w.committed])).toEqual([
      ['write', 'organization', false],
      ['write', 'entry', false],
      ['match', 'person', false],
      ['link', 'List Entry — Deals', false],
    ]);
  });
});

// ── 6g. The retired `edge` statement keyword ─────────────────────────────────

describe("the 'edge' statement keyword is retired (absorbed by link)", () => {
  it('raises MOVENG_PARSE pointing at the link spelling', async () => {
    const promise = runMovement({
      source: [
        PRELUDE,
        '',
        'movement m(msg: <inbox-[:message]->>) {',
        '  a = write crm-[:companies]-> { name: msg.`user` }',
        '  b = write crm-[:people]-> { name: msg.`user`, email: msg.`user` }',
        '  edge a -[:company]-> b',
        '}',
      ].join('\n'),
      event: webhookEvent('slack', { user: 'U1' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
    });
    expect(await rejectionCause(promise)).toBeInstanceOf(MovementEngineError);
    await expect(promise).rejects.toThrow(/MOVENG_PARSE[\s\S]*'edge' is not a statement[\s\S]*link a/);
  });
});

// ── 6h. Tuple-path multi-parent writes — adapter targets ─────────────────────

describe('tuple-path multi-parent writes — adapter targets', () => {
  const TUPLE = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  co = write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name: msg.`user`',
    '  }',
    '  p = write crm-[:people]-> {',
    '    unique by (`email`)',
    '    name:  msg.`user`',
    '    email: msg.`user`',
    '  }',
    '  write (co-[:investments]->, p-[:investments]->) {',
    '    amount: 5',
    '  }',
    '}',
  ].join('\n');

  it('ONE create carries N parent links (parentLinks, no single parentLink slot)', async () => {
    const attio = makeFakeAdapter('attio');
    const writeInputs: Array<{ recordType: string; parentLinks: unknown }> = [];
    const baseCreate = attio.adapter.createRecord.bind(attio.adapter);
    attio.adapter.createRecord = async (input) => {
      writeInputs.push({
        recordType: input.recordType,
        parentLinks: input.parentLinks ?? null,
      });
      return baseCreate(input);
    };

    const result = await runMovement({
      source: TUPLE,
      event: webhookEvent('slack', { user: 'U1' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: attio.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
    });

    expect(result.writes.map((w) => [w.recordType, w.created])).toEqual([
      ['company', true],
      ['person', true],
      ['investment', true],
    ]);
    expect(writeInputs[2]).toEqual({
      recordType: 'investment',
      parentLinks: [
        { recordType: 'company', externalId: 'ext-attio-1', edgeName: 'investments', data: {} },
        { recordType: 'person', externalId: 'ext-attio-2', edgeName: 'investments', data: {} },
      ],
    });
  });

  it('a required reference field satisfied by a tuple parent does not double-fire the required-field gate', async () => {
    const attio = makeFakeAdapter('attio');
    attio.adapter.describe = async (typeId) =>
      typeId === 'investment'
        ? {
            typeId: 'investment',
            displayName: 'Investment',
            fields: [
              { fieldId: 'amount', displayName: 'Amount', kind: 'number', writable: true, required: false },
              // The FK spelling of the edge — required at create, but the
              // tuple parent establishes it structurally. Its NATURAL name (the
              // field-gate currency) IS the edge name `investments`, which the
              // parent link satisfies (a reference's natural name is its edge).
              { fieldId: 'investments', displayName: 'investments', kind: 'reference', writable: true, required: true },
            ],
            references: [],
          }
        : null;

    await expect(
      runMovement({
        source: TUPLE,
        event: webhookEvent('slack', { user: 'U1' }),
        teamId: TEAM_ID,
        catalog,
        resolveCredentialId: (name) => CREDENTIAL_IDS[name],
        resolveAdapter: makeResolver({
          attio: attio.adapter,
          slack: makeFakeAdapter('slack').adapter,
        }),
      }),
    ).resolves.toMatchObject({ movementName: 'm' });
  });
});

// ── Park sink harness ───────────────────────────────────────────────────────
//
// The shared in-memory ParkSink the timer (`sleep`), await, and race
// tests inject to capture what the interpreter hands the durable-park seam.

/** A fake park sink recording what the interpreter handed it. */
function makeFakeParkSink(_opts: { created?: boolean } = {}): {
  sink: ParkSink;
  joins: Array<{ frameAddress: string; parkedChildren: number }>;
  timerParks: Array<{ address: string; state: unknown; wakeAt: Date }>;
  awaitParks: Array<{ address: string; state: unknown }>;
  cancelled: string[];
} {
  const joins: Array<{ frameAddress: string; parkedChildren: number }> = [];
  const timerParks: Array<{ address: string; state: unknown; wakeAt: Date }> = [];
  const awaitParks: Array<{ address: string; state: unknown }> = [];
  const cancelled: string[] = [];

  // In-memory join state: maps frameAddress -> { pending, closedBy, decremented }
  // Seeded by recordJoin (sets pending = parkedChildren) so decrementJoin can
  // mirror decrementJoinClose semantics without a DB. `decremented` is the
  // per-(frame,branch) exactly-once claim (join_branch_export.decremented, §7):
  // a branch's SECOND decrement (crash-retry re-scan) skips the count.
  const joinState = new Map<
    string,
    { pending: number; closedBy: string | null; decremented: Set<string> }
  >();

  // In-memory export store: maps frameAddress -> Map<branchAddress, { branchIndex, exports }>
  const exportStore = new Map<string, Map<string, { branchIndex: number; exports: unknown }>>();

  const sink: ParkSink = {
    async commitTimerPark(input) {
      timerParks.push({ address: input.address, state: input.state, wakeAt: input.wakeAt });
    },
    async commitAwaitPark(input) {
      await input.correlate('test-run');
      awaitParks.push({ address: input.address, state: input.state });
    },
    async recordJoin(input) {
      joins.push(input);
      // Seed the in-memory join state for decrementJoin.
      joinState.set(input.frameAddress, {
        pending: input.parkedChildren,
        closedBy: null,
        decremented: new Set(),
      });
    },

    async decrementJoin(input: {
      frameAddress: string;
      branchAddress: string;
      leafAddress: string;
    }): Promise<{ closed: boolean }> {
      const frame = joinState.get(input.frameAddress);
      if (frame === undefined) {
        // No frame — treat as "already closed, not by this leaf".
        return { closed: false };
      }
      // Per-leaf exactly-once claim (mirrors the real decrementJoinClose): only
      // the FIRST decrement per branch touches the count. A re-scanned branch
      // (already claimed) skips the count and reports via closer identity.
      if (frame.decremented.has(input.branchAddress)) {
        return { closed: frame.closedBy === input.leafAddress };
      }
      frame.decremented.add(input.branchAddress);
      if (frame.pending > 0) {
        frame.pending -= 1;
        if (frame.pending === 0) {
          // This branch closes the frame — mark it (row retained, not deleted).
          frame.closedBy = input.leafAddress;
          return { closed: true };
        }
        return { closed: false };
      }
      // Frame already at 0: re-scan closer identity (crash-retry idempotency).
      return { closed: frame.closedBy === input.leafAddress };
    },

    async persistBranchExport(input: {
      frameAddress: string;
      branchAddress: string;
      branchIndex: number;
      exports: unknown;
    }): Promise<void> {
      let byBranch = exportStore.get(input.frameAddress);
      if (byBranch === undefined) {
        byBranch = new Map();
        exportStore.set(input.frameAddress, byBranch);
      }
      // UPSERT: re-writing the same row is idempotent.
      byBranch.set(input.branchAddress, { branchIndex: input.branchIndex, exports: input.exports });
    },

    async collectBranchExports(input: {
      frameAddress: string;
    }): Promise<Array<{ branchAddress: string; branchIndex: number; exports: unknown }>> {
      const byBranch = exportStore.get(input.frameAddress);
      if (byBranch === undefined) return [];
      return [...byBranch.entries()]
        .map(([branchAddress, { branchIndex, exports }]) => ({ branchAddress, branchIndex, exports }))
        .sort((a, b) => a.branchIndex - b.branchIndex);
    },

    async cancelSubtrees(input: { subtreeAddresses: string[] }): Promise<void> {
      // In-memory prefix cancel (mirrors cancelRaceSubtrees): drop await/timer
      // parks at-or-below a loser prefix, and clear join frames inside them.
      const atOrBelow = (addr: string) =>
        input.subtreeAddresses.some((p) => addr === p || addr.startsWith(`${p}.`));
      cancelled.push(...input.subtreeAddresses);
      for (let i = awaitParks.length - 1; i >= 0; i--) {
        if (atOrBelow(awaitParks[i].address)) awaitParks.splice(i, 1);
      }
      for (let i = timerParks.length - 1; i >= 0; i--) {
        if (atOrBelow(timerParks[i].address)) timerParks.splice(i, 1);
      }
      for (const key of [...joinState.keys()]) if (atOrBelow(key)) joinState.delete(key);
    },
  };
  return { sink, joins, timerParks, awaitParks, cancelled };
}


/** A slack source whose `files` edge yields one position per entry of the
 *  payload's `files` array — a deterministic fan-out (no LLM). */
function slackWithFanoutFiles(): Adapter {
  const base = makeFakeAdapter('slack');
  base.adapter.getRelated = async ({ position, fieldId }) => {
    if (fieldId !== 'files') return [];
    const data = positionData(position) as { files?: Array<Record<string, unknown>> } | undefined;
    return (data?.files ?? []).map((file, i) => ({
      position: makeStablePosition({
        adapterType: 'slack',
        recordType: 'file',
        recordId: `file-${i + 1}`,
        data: file,
      }),
    }));
  };
  return base.adapter;
}

describe('sleep — durable timer park', () => {
  const SLEEP_THEN_WRITE = [
    PRELUDE,
    '',
    'movement intake(msg: <inbox-[:message]->>) {',
    '  await sleep(30s)',
    '  write crm-[:companies]-> { unique by (`name`) name: "After: ${msg.`user`}" }',
    '}',
  ].join('\n');

  it('parks the branch via commitTimerPark (wake ≈ now + 30s) and halts before the next statement', async () => {
    const { sink, timerParks } = makeFakeParkSink();
    const crm = makeFakeAdapter('attio');

    const before = Date.now();
    const result = await runMovement({
      source: SLEEP_THEN_WRITE,
      event: webhookEvent('slack', { user: 'Acme' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: crm.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      parkSink: sink,
    });
    const after = Date.now();

    // The branch froze at the sleep — the run is parked.
    expect(result.parked).toBe(true);
    expect(timerParks).toHaveLength(1);
    expect(timerParks[0].address).toBe('s0');

    // wake_at is now + 30s, bounded by the wall-clock window of the call.
    const wakeMs = timerParks[0].wakeAt.getTime();
    expect(wakeMs).toBeGreaterThanOrEqual(before + 30_000);
    expect(wakeMs).toBeLessThanOrEqual(after + 30_000);

    // The serialized scope chain rides along, keyed at the sleep's address.
    const state = JSON.parse(JSON.stringify(timerParks[0].state)) as ParkedScopeState;
    expect(state.address).toBe('s0');
    expect(state.bindingName).toBeNull();
    expect(state.scopeChain).toBeDefined();

    // Halted BEFORE the following write — it never ran.
    expect(crm.creates).toHaveLength(0);
  });

  it('under dryRun records NO timer park and continues past the sleep to the next statement', async () => {
    const { sink, timerParks } = makeFakeParkSink();
    const captured: CapturedWrite[] = [];

    const result = await runMovement({
      source: SLEEP_THEN_WRITE,
      event: webhookEvent('slack', { user: 'Acme' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      parkSink: sink,
      dryRun: true,
      writeSink: (w) => captured.push(w),
    });

    expect(result.parked).toBeUndefined();
    expect(timerParks).toHaveLength(0);
    // Execution fast-forwarded past the sleep and reached the following write.
    expect(captured.map((w) => w.recordType)).toEqual(['company']);
  });

  it('resume (no reenter, no answer) steps PAST the sleep, binds nothing, and runs the rest of the branch', async () => {
    // Park at the sleep, capture the real serialized state, then resume it the way
    // the wake driver does: `reenter` omitted (⇒ the ask default: step past), no
    // `answer`. The parked `state.bindingName` is null, so the step-past path
    // declares nothing and continues from the write AFTER the sleep.
    const { sink, timerParks } = makeFakeParkSink();
    const crm0 = makeFakeAdapter('attio');
    const parkResult = await runMovement({
      source: SLEEP_THEN_WRITE,
      event: webhookEvent('slack', { user: 'Acme' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: crm0.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      parkSink: sink,
    });
    expect(parkResult.parked).toBe(true);
    // The write after the sleep never ran at park time.
    expect(crm0.creates).toHaveLength(0);

    const state = JSON.parse(JSON.stringify(timerParks[0].state)) as ParkedScopeState;
    expect(state.bindingName).toBeNull();

    // Resume exactly as the wake driver does: no `reenter`, no `answer`.
    const crm1 = makeFakeAdapter('attio');
    const result = await resumeMovement({
      source: SLEEP_THEN_WRITE,
      event: webhookEvent('slack', { user: 'Acme' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: crm1.adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      state,
    });

    // The branch completed (did NOT re-park — no re-run of the sleep).
    expect(result.parked).toBeUndefined();
    // The post-sleep write ran, reading `msg` off the rehydrated scope (nothing
    // was injected at the sleep leaf).
    expect(crm1.creates.map((c) => c.fields.name)).toEqual(['After: Acme']);
    expect(result.writes.map((w) => w.recordType)).toEqual(['company']);
  });
});

// ── Backtick credential args — run-path coverage ─────────────────────────────
//
// The bug: `importOriginal` in instanceBinding never stripped backticks, so a
// direct `attio(credentials: \`Dev-loop Attio\`)` bound `credentialName` to the
// literal backtick string and `resolveCredentialId` missed it.

describe('runMovement — direct backtick credential arg (run-path)', () => {
  // A catalog with a credential that MUST be backtick-quoted because its name
  // contains a hyphen (an identifier-unsafe character).
  const backtickCatalog = staticCatalogFromManifests({
    credentials: {
      'Dev-loop Attio': { adapters: ['attio'] },
    },
  });

  const BACKTICK_CRED_IDS: Record<string, string> = {
    'Dev-loop Attio': 'cred-attio-backtick-1',
  };

  // Movement that uses the credential with DIRECT backtick syntax (no alias).
  const DIRECT_BACKTICK_SOURCE = [
    'import { attio } from adapters',
    'import { `Dev-loop Attio` } from credentials',
    '',
    'crm = attio(credentials: `Dev-loop Attio`)',
    '',
    'movement intake(msg: <crm-[:company]->>) {',
    '  write crm-[:companies]-> {',
    '    name: msg.`name`',
    '  }',
    '}',
  ].join('\n');

  // Same movement using the ALIASED form — the previously working path.
  const ALIASED_SOURCE = [
    'import { attio } from adapters',
    'import { `Dev-loop Attio` as crm_cred } from credentials',
    '',
    'crm = attio(credentials: crm_cred)',
    '',
    'movement intake(msg: <crm-[:company]->>) {',
    '  write crm-[:companies]-> {',
    '    name: msg.`name`',
    '  }',
    '}',
  ].join('\n');

  const companyEvent = webhookEvent('attio', { name: 'Listen-Fire Corp' });

  it('direct backtick: resolveAdapter receives the correct credentialsId (non-null)', async () => {
    const capturedCredIds: Array<string | undefined> = [];
    const crm = makeFakeAdapter('attio');

    await runMovement({
      source: DIRECT_BACKTICK_SOURCE,
      event: companyEvent,
      teamId: TEAM_ID,
      catalog: backtickCatalog,
      resolveCredentialId: (name) => BACKTICK_CRED_IDS[name],
      resolveAdapter: ({ adapterType, credentialsId }) => {
        capturedCredIds.push(credentialsId);
        if (adapterType !== 'attio') throw new Error(`unexpected adapter ${adapterType}`);
        return crm.adapter;
      },
      dryRun: true,
    });

    // The attio adapter should have been resolved with the correct credentialsId.
    expect(capturedCredIds).toContain('cred-attio-backtick-1');
    // It must NOT be resolved with the raw backtick string.
    expect(capturedCredIds).not.toContain('`Dev-loop Attio`');
  });

  it('direct backtick and aliased forms resolve to the same credentialsId (parity)', async () => {
    const directCredIds: Array<string | undefined> = [];
    const aliasedCredIds: Array<string | undefined> = [];
    const crm = makeFakeAdapter('attio');

    await runMovement({
      source: DIRECT_BACKTICK_SOURCE,
      event: companyEvent,
      teamId: TEAM_ID,
      catalog: backtickCatalog,
      resolveCredentialId: (name) => BACKTICK_CRED_IDS[name],
      resolveAdapter: ({ adapterType, credentialsId }) => {
        directCredIds.push(credentialsId);
        if (adapterType !== 'attio') throw new Error(`unexpected adapter ${adapterType}`);
        return crm.adapter;
      },
      dryRun: true,
    });

    await runMovement({
      source: ALIASED_SOURCE,
      event: companyEvent,
      teamId: TEAM_ID,
      catalog: backtickCatalog,
      resolveCredentialId: (name) => BACKTICK_CRED_IDS[name],
      resolveAdapter: ({ adapterType, credentialsId }) => {
        aliasedCredIds.push(credentialsId);
        if (adapterType !== 'attio') throw new Error(`unexpected adapter ${adapterType}`);
        return crm.adapter;
      },
      dryRun: true,
    });

    const directId = directCredIds.find((id) => id !== undefined);
    const aliasedId = aliasedCredIds.find((id) => id !== undefined);
    expect(directId).toBe('cred-attio-backtick-1');
    expect(aliasedId).toBe('cred-attio-backtick-1');
    expect(directId).toBe(aliasedId);
  });
});

// ---------------------------------------------------------------------------
// makeFakeParkSink — in-memory join seams (unit tests for the fake itself)
// These underpin the next task's unwind unit tests: we verify the fake's
// decrementJoin / persistBranchExport / collectBranchExports are correct
// before the engine calls them.
// ---------------------------------------------------------------------------

describe('makeFakeParkSink — decrementJoin (in-memory)', () => {
  it('decrement-to-close: the branch that drives pending to 0 returns closed:true', async () => {
    const { sink } = makeFakeParkSink();
    // Seed a join with 2 pending branches.
    await sink.recordJoin({ frameAddress: 'f0', parkedChildren: 2 });

    const first = await sink.decrementJoin({
      frameAddress: 'f0',
      branchAddress: 'f0.b0',
      leafAddress: 'f0.b0',
    });
    expect(first.closed).toBe(false);

    const second = await sink.decrementJoin({
      frameAddress: 'f0',
      branchAddress: 'f0.b1',
      leafAddress: 'f0.b1',
    });
    expect(second.closed).toBe(true);
  });

  it('re-call by the closer returns closed:true (crash-retry idempotency)', async () => {
    const { sink } = makeFakeParkSink();
    await sink.recordJoin({ frameAddress: 'f0', parkedChildren: 1 });

    const first = await sink.decrementJoin({
      frameAddress: 'f0',
      branchAddress: 'f0.b0',
      leafAddress: 'f0.b0',
    });
    expect(first.closed).toBe(true);

    // Re-call with the same leaf — should still be closed.
    const retry = await sink.decrementJoin({
      frameAddress: 'f0',
      branchAddress: 'f0.b0',
      leafAddress: 'f0.b0',
    });
    expect(retry.closed).toBe(true);
  });

  it('sibling re-call after close returns closed:false', async () => {
    const { sink } = makeFakeParkSink();
    await sink.recordJoin({ frameAddress: 'f0', parkedChildren: 2 });

    await sink.decrementJoin({ frameAddress: 'f0', branchAddress: 'f0.b0', leafAddress: 'f0.b0' }); // non-closer
    await sink.decrementJoin({ frameAddress: 'f0', branchAddress: 'f0.b1', leafAddress: 'f0.b1' }); // closer

    // b0 was NOT the closer — must return false even after the frame is closed.
    const sibling = await sink.decrementJoin({
      frameAddress: 'f0',
      branchAddress: 'f0.b0',
      leafAddress: 'f0.b0',
    });
    expect(sibling.closed).toBe(false);
  });

  it('non-closer re-scan does NOT decrement the join a second time (exactly-once claim)', async () => {
    const { sink } = makeFakeParkSink();
    await sink.recordJoin({ frameAddress: 'f0', parkedChildren: 3 });

    // b0 decrements once (non-closer, pending 3 -> 2).
    const first = await sink.decrementJoin({ frameAddress: 'f0', branchAddress: 'f0.b0', leafAddress: 'f0.b0' });
    expect(first.closed).toBe(false);
    // b0 re-scanned in the crash window (its parked_run row still present) — the
    // claim must prevent a SECOND decrement (pending must NOT be driven to 1).
    const reScan = await sink.decrementJoin({ frameAddress: 'f0', branchAddress: 'f0.b0', leafAddress: 'f0.b0' });
    expect(reScan.closed).toBe(false);

    // b1 (pending 2 -> 1) then b2 (pending 1 -> 0) close it — proving the count
    // still reflects EACH branch exactly once despite b0's re-scan.
    const b1 = await sink.decrementJoin({ frameAddress: 'f0', branchAddress: 'f0.b1', leafAddress: 'f0.b1' });
    expect(b1.closed).toBe(false);
    const b2 = await sink.decrementJoin({ frameAddress: 'f0', branchAddress: 'f0.b2', leafAddress: 'f0.b2' });
    expect(b2.closed).toBe(true);
  });

  it('independent frames do not interfere with each other', async () => {
    const { sink } = makeFakeParkSink();
    await sink.recordJoin({ frameAddress: 'f0', parkedChildren: 1 });
    await sink.recordJoin({ frameAddress: 'f1', parkedChildren: 1 });

    const r0 = await sink.decrementJoin({ frameAddress: 'f0', branchAddress: 'f0.b0', leafAddress: 'f0.b0' });
    const r1 = await sink.decrementJoin({ frameAddress: 'f1', branchAddress: 'f1.b0', leafAddress: 'f1.b0' });

    expect(r0.closed).toBe(true);
    expect(r1.closed).toBe(true);
  });
});

describe('makeFakeParkSink — persistBranchExport / collectBranchExports (in-memory)', () => {
  it('persist/collect roundtrip: single branch', async () => {
    const { sink } = makeFakeParkSink();
    await sink.persistBranchExport({
      frameAddress: 'f0',
      branchAddress: 'f0.b0',
      branchIndex: 0,
      exports: { x: 'hello' },
    });

    const rows = await sink.collectBranchExports({ frameAddress: 'f0' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ branchAddress: 'f0.b0', branchIndex: 0, exports: { x: 'hello' } });
  });

  it('collect returns rows ordered by branchIndex regardless of persist order', async () => {
    const { sink } = makeFakeParkSink();
    // Persist out of order.
    await sink.persistBranchExport({ frameAddress: 'f0', branchAddress: 'f0.b2', branchIndex: 2, exports: { v: 2 } });
    await sink.persistBranchExport({ frameAddress: 'f0', branchAddress: 'f0.b0', branchIndex: 0, exports: { v: 0 } });
    await sink.persistBranchExport({ frameAddress: 'f0', branchAddress: 'f0.b1', branchIndex: 1, exports: { v: 1 } });

    const rows = await sink.collectBranchExports({ frameAddress: 'f0' });
    expect(rows.map((r) => r.branchIndex)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.exports)).toEqual([{ v: 0 }, { v: 1 }, { v: 2 }]);
  });

  it('persist is idempotent (UPSERT): re-persisting the same branch overwrites exports', async () => {
    const { sink } = makeFakeParkSink();
    await sink.persistBranchExport({ frameAddress: 'f0', branchAddress: 'f0.b0', branchIndex: 0, exports: { v: 'first' } });
    await sink.persistBranchExport({ frameAddress: 'f0', branchAddress: 'f0.b0', branchIndex: 0, exports: { v: 'second' } });

    const rows = await sink.collectBranchExports({ frameAddress: 'f0' });
    expect(rows).toHaveLength(1);
    expect(rows[0].exports).toEqual({ v: 'second' });
  });

  it('collect returns empty array for a frame with no exports', async () => {
    const { sink } = makeFakeParkSink();
    const rows = await sink.collectBranchExports({ frameAddress: 'f-unknown' });
    expect(rows).toEqual([]);
  });

  it('exports from different frames are isolated', async () => {
    const { sink } = makeFakeParkSink();
    await sink.persistBranchExport({ frameAddress: 'f0', branchAddress: 'f0.b0', branchIndex: 0, exports: { frame: 0 } });
    await sink.persistBranchExport({ frameAddress: 'f1', branchAddress: 'f1.b0', branchIndex: 0, exports: { frame: 1 } });

    const f0 = await sink.collectBranchExports({ frameAddress: 'f0' });
    const f1 = await sink.collectBranchExports({ frameAddress: 'f1' });

    expect(f0).toHaveLength(1);
    expect((f0[0].exports as { frame: number }).frame).toBe(0);
    expect(f1).toHaveLength(1);
    expect((f1[0].exports as { frame: number }).frame).toBe(1);
  });
});

// ── race: park → resume, first-arm settlement, and the withdrawal of every
// arm still parked at a suspension ──────────────────────────────────────────
describe('await race — park and resume', () => {
  const RACE_PARK = [
    PRELUDE,
    '',
    'movement intake(msg: <inbox-[:message]->>) {',
    '  r = await race([',
    '    () => {',
    '      await sleep(30d)',
    '      made = write crm-[:companies]-> {',
    '        unique by (`name`)',
    '        name: "Acme"',
    '      }',
    '      return made.externalId',
    '    },',
    '    () => { await sleep(30d) },',
    '  ])',
    '  if AT(r, 0) != null {',
    '    write crm-[:companies]-> {',
    '      unique by (`name`)',
    '      name: "won-${AT(r, 0)}"',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const EVENT = { files: [{ name: 'Acme' }, { name: 'Beta' }] };

  it('parks one leaf per ARM, pending 1 at the race', async () => {
    const { sink, timerParks, joins } = makeFakeParkSink();
    const crm = makeFakeAdapter('attio');

    const result = await runMovement({
      source: RACE_PARK,
      event: webhookEvent('slack', EVENT),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: crm.adapter, slack: slackWithFanoutFiles() }),
      parkSink: sink,
    });

    expect(result.parked).toBe(true);
    expect(crm.creates).toHaveLength(0);
    // One `branch k` frame per arm, each parking at its own sleep.
    expect(timerParks.map((t) => t.address).sort()).toEqual(['s0.b0.s0', 's0.b1.s0']);
    // First-wins: the race frame is pending ONE however many arms there are.
    expect(joins).toEqual([{ frameAddress: 's0', parkedChildren: 1 }]);
  });

  it('resuming ONE arm settles the race: the receipt binds by slot, the loser is withdrawn', async () => {
    const { sink, timerParks, cancelled } = makeFakeParkSink();
    const crm0 = makeFakeAdapter('attio');
    await runMovement({
      source: RACE_PARK,
      event: webhookEvent('slack', EVENT),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: crm0.adapter, slack: slackWithFanoutFiles() }),
      parkSink: sink,
    });

    // Resume the FIRST arm — its scope rehydrates, its write runs, and
    // completing its body settles the race at the await frame.
    const winnerState = JSON.parse(
      JSON.stringify(timerParks.find((t) => t.address === 's0.b0.s0')!.state),
    ) as ParkedScopeState;
    const crm1 = makeFakeAdapter('attio');
    const result = await resumeMovement({
      source: RACE_PARK,
      event: webhookEvent('slack', EVENT),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: crm1.adapter, slack: slackWithFanoutFiles() }),
      state: winnerState,
      parkSink: sink,
    });

    expect(result.parked).toBeUndefined();
    // The winner's write, then the continuation reading its SLOT.
    expect(crm1.creates.map((c) => c.fields.name)).toEqual(['Acme', 'won-ext-attio-1']);
    // Both arm prefixes are withdrawn — the winner's own leaf is spared by
    // ADDRESS, and the loser's park (and its resume driver) goes with it.
    expect(cancelled.sort()).toEqual(['s0.b0', 's0.b1']);
  });

  it("a withdrawn loser's later firing resumes nothing — its park is gone", async () => {
    const { sink, timerParks } = makeFakeParkSink();
    await runMovement({
      source: RACE_PARK,
      event: webhookEvent('slack', EVENT),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: makeFakeAdapter('attio').adapter,
        slack: slackWithFanoutFiles(),
      }),
      parkSink: sink,
    });
    const winnerState = JSON.parse(
      JSON.stringify(timerParks.find((t) => t.address === 's0.b0.s0')!.state),
    ) as ParkedScopeState;
    await resumeMovement({
      source: RACE_PARK,
      event: webhookEvent('slack', EVENT),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        attio: makeFakeAdapter('attio').adapter,
        slack: slackWithFanoutFiles(),
      }),
      state: winnerState,
      parkSink: sink,
    });

    // The loser's park row is gone, so the driver that would have woken it has
    // nothing to wake: its timer firing later reaches no run.
    expect(timerParks.map((t) => t.address)).not.toContain('s0.b1.s0');
  });
});

// ── race (asks-as-adapter chunk C): the synchronous-completion path ──────────
describe('race — synchronous completion builds a progressive receipt', () => {
  const RACE_SYNC = [
    'import { email, attio, slack } from adapters',
    'import { acme_main, acme_workspace } from credentials',
    '',
    'inbox = email()',
    'crm   = attio(credentials: acme_main)',
    'team  = slack(credentials: acme_workspace)',
    '',
    'movement race_sync(msg: <inbox-[:message]->>) {',
    '  r = await race([',
    '    () => {',
    '      made = write crm-[:companies]-> {',
    '        unique by (`domains`)',
    '        name:    msg.`subject`',
    '        domains: [msg.`text`]',
    '      }',
    '      return made.externalId',
    '    },',
    '    () => { return true },',
    '  ])',
    '  write team-[:messages]-> {',
    '    channel: "#c"',
    '    text:    "id=${AT(r, 0)}"',
    '  }',
    '  write team-[:messages]-> {',
    '    channel: "#c2"',
    '    text:    "flag=${AT(r, 1)}"',
    '  }',
    '}',
  ].join('\n');

  it('every arm that settled in the burst fills its own slot', async () => {
    const movementWrites: CapturedWrite[] = [];
    const result = await runMovement({
      source: RACE_SYNC,
      event: webhookEvent('email', { subject: 'Acme Corp', text: 'acme.dev' }),
      teamId: TEAM_ID,
      catalog: milestoneCatalog,
      resolveCredentialId: (name) => MILESTONE_CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      dryRun: true,
      writeSink: (w) => movementWrites.push(w),
    });

    const companyId = result.writes[0].externalId;
    // Slot 0 carries what the writing arm returned…
    const idPost = movementWrites.find((w) => w.recordType === 'message' && (w.fields?.channel === '#c'));
    expect(idPost?.fields?.text).toBe(`id=${companyId}`);
    // …and slot 1 what the other one did. Both are filled: neither suspended,
    // so both settled inside the same running burst.
    const flagPost = movementWrites.find((w) => w.recordType === 'message' && (w.fields?.channel === '#c2'));
    expect(flagPost?.fields?.text).toBe('flag=true');
  });

  // F18/F21 — MULTIPLE WINNERS. Two branches both complete in ONE batch (here,
  // synchronously — the mocked batch): BOTH bindings escape onto the receipt,
  // BOTH continuation blocks run in program order, and NO cancellation fires
  // between them (S5 exact tie). This is the multi-winner acceptance at the unit
  // tier — the fork loop must not stop at the first completer.
  const RACE_TIE = [
    'import { email, attio, slack } from adapters',
    'import { acme_main, acme_workspace } from credentials',
    '',
    'inbox = email()',
    'crm   = attio(credentials: acme_main)',
    'team  = slack(credentials: acme_workspace)',
    '',
    'movement race_tie(msg: <inbox-[:message]->>) {',
    '  r = await race([',
    '    () => { one = write crm-[:companies]-> { name: "A" }; return one.externalId },',
    '    () => { two = write crm-[:companies]-> { name: "B" }; return two.externalId },',
    '  ])',
    '  write team-[:messages]-> {',
    '    channel: "#one"',
    '    text:    "one=${AT(r, 0)}"',
    '  }',
    '  write team-[:messages]-> {',
    '    channel: "#two"',
    '    text:    "two=${AT(r, 1)}"',
    '  }',
    '}',
  ].join('\n');

  it('two arms settling in one burst is a TIE — both slots filled, nothing cancelled', async () => {
    const movementWrites: CapturedWrite[] = [];
    const result = await runMovement({
      source: RACE_TIE,
      event: webhookEvent('email', { subject: 'x', text: 'y' }),
      teamId: TEAM_ID,
      catalog: milestoneCatalog,
      resolveCredentialId: (name) => MILESTONE_CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
        slack: makeFakeAdapter('slack').adapter,
      }),
      dryRun: true,
      writeSink: (w) => movementWrites.push(w),
    });

    // BOTH arms' writes landed (two company creates), and BOTH slots reached
    // the continuation — in program order (#one before #two).
    const messages = movementWrites.filter((w) => w.recordType === 'message');
    expect(messages.map((m) => m.fields?.channel)).toEqual(['#one', '#two']);
    const oneId = result.writes.find((w) => w.recordType === 'company')?.externalId;
    expect(messages[0].fields?.text).toBe(`one=${oneId}`);
    expect(messages[1].fields?.text).toMatch(/^two=/);
    // Distinct values in the two slots — both arms are on the receipt.
    expect(messages[0].fields?.text).not.toBe(messages[1].fields?.text);
  });
});

// ── await landing (asks-as-adapter chunk B/C): the sourcePosition an awaited
// edge binds (declareAwaitResult) must carry the awaited HEAD's FILE-SCOPE
// instance name, NOT the local binding name. A plain await keeps its landing in
// the live env, but chunk C's race branch-export persists it
// (persistBranchExport → collectBranchExports) and re-resolves the read seam by
// instance name at settlement (run.ts rehydrationContext). If the seam names the
// local binding (`ans`), which no `import` put in file scope, the run crashes:
//   MOVENG_RUNTIME: resume: cannot rebind read seam for instance 'ans' …
// This locks the derivation at the serialize boundary — the same round trip the
// settlement performs.
describe('await landing — the bound sourcePosition round-trips via the FILE-SCOPE instance name', () => {
  // Mirror the interpreter's resume seam (run.ts rehydrationContext): a read seam
  // re-resolves ONLY through a name present in the re-parsed FILE scope; anything
  // else throws exactly as a live resume would.
  function fileScopedResolveSourceRead(fileScope: Record<string, Adapter>) {
    return async (instanceName: string): Promise<SourceRead> => {
      const adapter = fileScope[instanceName];
      if (!adapter) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `resume: cannot rebind read seam for instance '${instanceName}' — not in the re-parsed file scope`,
        );
      }
      return { adapter, instanceName };
    };
  }

  function makeCtx(fileScope: Record<string, Adapter>): RehydrationContext {
    return {
      resolveInstance: async (id) => ({
        kind: 'instance',
        name: id.name,
        adapterSlug: id.adapterSlug,
        schema: {} as never,
      }),
      resolveSourceRead: fileScopedResolveSourceRead(fileScope),
      reviveFileRef: (d) => ({ __brand: 'FileRef', ...d, retrieve: async () => ({ stream: {} as never }) }),
      resolveCodeRef: (name) => ({ kind: 'opaque', what: name }),
    };
  }

  // The binding declareAwaitResult declares: an unstable Response position
  // carrying the landing fields, read through the awaitable adapter under a
  // given instance name.
  function awaitedLanding(instanceName: string, adapter: Adapter): Binding {
    return {
      kind: 'sourcePosition',
      position: makeUnstablePosition({
        adapterType: 'ask',
        recordType: 'Response',
        data: { Answer: 'yes' },
      }),
      read: { adapter, instanceName },
    };
  }

  it('rehydrates when instanceName is the file-scope instance (the fix)', async () => {
    const { adapter } = makeFakeAdapter('ask');
    // The head was written through a file-scope instance `questions` (`import
    // { ask as questions }`); the landing must carry THAT name.
    const binding = awaitedLanding('questions', adapter);

    const descriptor = serializeBinding(binding);
    expect(descriptor).toMatchObject({ kind: 'sourcePosition', read: { instanceName: 'questions' } });

    const rehydrated = await rehydrateBinding(descriptor, makeCtx({ questions: adapter }));
    expect(rehydrated.kind).toBe('sourcePosition');
    const read = (rehydrated as Extract<Binding, { kind: 'sourcePosition' }>).read;
    expect(read?.instanceName).toBe('questions');
    expect(read?.adapter).toBeDefined();
  });

  it('regression: the local binding name is NOT in file scope — rehydration crashes (the old bug)', async () => {
    const { adapter } = makeFakeAdapter('ask');
    // The pre-fix code set instanceName to the LOCAL binding name (`ans`), which
    // no `import` ever put in file scope. Serialize→rehydrate reproduces the
    // exact settlement crash.
    const buggy = awaitedLanding('ans', adapter);
    const descriptor = serializeBinding(buggy);

    await expect(rehydrateBinding(descriptor, makeCtx({ questions: adapter }))).rejects.toThrow(
      /not in the re-parsed file scope/,
    );
  });
});

// ── await-resume single-flight (asks-as-adapter chunk C, F18/F21): concurrent
// nudges for the SAME run must coalesce. Without it, two near-simultaneous
// answers to two asks of one run spawn two overlapping scans that each settle
// the same race frame (double-processing, non-deterministic tie). The coalescer
// guarantees one drain at a time per key, with a mid-flight arrival queuing
// EXACTLY ONE follow-up — one batch scan, not a race.
//
// The slot's two entries are two different CLAIMS about a task: `coalesce` says
// "replayable — I re-gather everything outstanding" (the drain); `exclusive`
// says "one-shot — replaying me repeats my effects" (a callback body). Passing
// a one-shot task through the coalescing entry is the double-execution bug.
describe('single-flight — one task at a time per run, coalescing vs one-shot', () => {
  interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
  }
  function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }
  // Drain the microtask queue enough for a resolved gate to carry the coalescer
  // through task-return → the `while` re-check → the follow-up pass's first await.
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  it('two concurrent calls for one key never overlap; the second queues one follow-up', async () => {
    const slot = createSingleFlight<string>();
    let starts = 0;
    let inFlight = 0;
    let maxConcurrent = 0;
    const gates: Deferred[] = [];

    const task = async () => {
      starts += 1;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      inFlight -= 1;
    };

    // Two near-simultaneous nudges for the same run. The first arrival runs the
    // task synchronously up to its first await (parked on the gate); the second
    // does NOT start a second overlapping pass — it queues exactly one follow-up.
    const p1 = slot.coalesce('run-1', task);
    const p2 = slot.coalesce('run-1', task);
    expect(starts).toBe(1);
    expect(gates).toHaveLength(1);

    // Release the first pass → its single queued follow-up runs (a second, non-
    // overlapping pass), then release that too.
    gates[0].resolve();
    await flush();
    expect(starts).toBe(2);
    expect(gates).toHaveLength(2);
    gates[1].resolve();
    await Promise.all([p1, p2]);

    // Exactly two passes ran (initial + one coalesced follow-up), never at once.
    expect(starts).toBe(2);
    expect(maxConcurrent).toBe(1);
  });

  it('a burst of nudges mid-flight still collapses to a single follow-up', async () => {
    const slot = createSingleFlight<string>();
    let starts = 0;
    const gates: Deferred[] = [];
    const task = async () => {
      starts += 1;
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
    };

    const first = slot.coalesce('run-1', task);
    // Four more nudges arrive while the first pass is parked on its gate.
    const rest = [
      slot.coalesce('run-1', task),
      slot.coalesce('run-1', task),
      slot.coalesce('run-1', task),
      slot.coalesce('run-1', task),
    ];
    expect(starts).toBe(1);

    gates[0].resolve(); // finish the initial pass → the single queued follow-up runs
    await flush();
    gates[gates.length - 1].resolve();
    await Promise.all([first, ...rest]);

    // The four mid-flight arrivals collapsed onto ONE follow-up, not four.
    expect(starts).toBe(2);
  });

  it('different keys run independently (no cross-run coalescing)', async () => {
    const slot = createSingleFlight<string>();
    const started: string[] = [];
    const gates: Deferred[] = [];
    const task = (key: string) => async () => {
      started.push(key);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
    };

    const a = slot.coalesce('run-a', task('run-a'));
    const b = slot.coalesce('run-b', task('run-b'));

    // Both keys drain concurrently — the single-flight is PER key.
    expect([...started].sort()).toEqual(['run-a', 'run-b']);

    gates.forEach((g) => g.resolve());
    await Promise.all([a, b]);
  });

  // The double-execution defect (live run b7e95f89): a CALLBACK BODY entered the
  // slot through the coalescing entry, which replays the in-flight task whenever
  // an arrival lands mid-flight. A drain is meant to be replayed — it re-gathers.
  // A body is not: it belongs to ONE recorded call, so the replay applied its
  // writes a second time under a ledger still showing a single call.
  it('an EXCLUSIVE task is never replayed by a mid-flight arrival — and the arrival still runs', async () => {
    const slot = createSingleFlight<string>();
    const ran: string[] = [];
    const gate = deferred();

    const body = async () => {
      ran.push('body');
      await gate.promise;
    };
    const drain = async () => {
      ran.push('drain');
    };

    const fired = slot.exclusive('run-1', body);
    // A nudge for the same run lands while the body is in flight.
    const nudged = slot.coalesce('run-1', drain);
    expect(ran).toEqual(['body']);

    gate.resolve();
    await Promise.all([fired, nudged]);

    // The body ran ONCE; the arrival got its own pass after it, never instead of
    // it and never as a replay of it.
    expect(ran).toEqual(['body', 'drain']);
  });

  it('exclusive tasks queue behind each other — each runs exactly once, in order', async () => {
    const slot = createSingleFlight<string>();
    const ran: string[] = [];
    const gates = [deferred(), deferred()];
    const task = (name: string, gate: Deferred) => async () => {
      ran.push(name);
      await gate.promise;
    };

    const first = slot.exclusive('run-1', task('first', gates[0]));
    const second = slot.exclusive('run-1', task('second', gates[1]));
    expect(ran).toEqual(['first']);

    gates[0].resolve();
    await flush();
    expect(ran).toEqual(['first', 'second']);
    gates[1].resolve();
    await Promise.all([first, second]);
    expect(ran).toEqual(['first', 'second']);
  });

  it('a failing task does not poison the key — the next entry still runs', async () => {
    const slot = createSingleFlight<string>();
    const ran: string[] = [];

    const failing = slot.exclusive('run-1', async () => {
      ran.push('failing');
      throw new Error('body blew up');
    });
    const next = slot.exclusive('run-1', async () => {
      ran.push('next');
    });

    await expect(failing).rejects.toThrow('body blew up');
    await next;
    expect(ran).toEqual(['failing', 'next']);
  });
});

// ── 12. json write fields — a structured value reaches the adapter INTACT ────
//
// The tap-loss defect class: a value the program assembled arriving at
// `createRecord` stringified or comma-joined. A `json` field holds a JSON
// DOCUMENT, so the engine's cardinality coercion must leave it alone — and the
// leniency every other kind keeps (a list into a scalar field renders as CSV)
// is exactly what would destroy it.

describe('json write fields carry structured values through to the adapter', () => {
  const docsSchema: InstanceSchema = {
    positions: { post: { properties: { Title: 'text' }, edges: {} } },
    collections: { posts: { target: 'post' } },
    writableRoots: {
      post: {
        fields: { Title: 'text', Body: 'json', Blocks: { kind: 'list', of: 'json' } },
        resultShape: { externalId: 'text' },
      },
    },
  };

  const docsCatalog = mockCatalog({
    adapters: {
      docs: {
        constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
        schema: docsSchema,
      },
    },
    credentials: { docs_cred: { adapter: 'docs' } },
  });

  /** The adapter's OWN introspection — what the engine's field coercion reads
   *  (the checker reads the catalog schema above; the two must agree). */
  const DOCS_DESCRIPTOR: SchemaTypeDescriptor = {
    typeId: 'post',
    displayName: 'post',
    fields: [
      { fieldId: 'Title', displayName: 'Title', kind: 'string', writable: true, required: false },
      { fieldId: 'Body', displayName: 'Body', kind: 'json', writable: true, required: false },
      {
        fieldId: 'Blocks',
        displayName: 'Blocks',
        kind: 'json',
        cardinality: 'many',
        writable: true,
        required: false,
      },
    ],
    references: [],
  };

  const program = (body: string): string =>
    [
      'import { docs } from adapters',
      'import { docs_cred } from credentials',
      '',
      'd = docs(credentials: docs_cred)',
      '',
      'movement m(p: <d-[:post]->>) {',
      body,
      '}',
    ].join('\n');

  async function written(body: string): Promise<Record<string, unknown>> {
    const docs = makeFakeAdapter('docs');
    docs.adapter.describe = async () => DOCS_DESCRIPTOR;
    await runMovement({
      source: program(body),
      event: webhookEvent('docs', { Title: 'Acme' }),
      teamId: TEAM_ID,
      catalog: docsCatalog,
      resolveCredentialId: () => 'cred-docs-1',
      resolveAdapter: makeResolver({ docs: docs.adapter }),
    });
    expect(docs.creates).toHaveLength(1);
    return docs.creates[0].fields;
  }

  it('a scalar json field receives the nested object, not a rendering of it', async () => {
    const fields = await written(
      '  write d-[:posts]-> { Body: { text: { emoji: true, value: "${p.`Title`}" }, tags: ["a", "b"] } }',
    );
    expect(fields.Body).toEqual({ text: { emoji: true, value: 'Acme' }, tags: ['a', 'b'] });
  });

  it('a LIST of json arrives as an array of objects, never comma-joined', async () => {
    const fields = await written(
      '  write d-[:posts]-> { Blocks: [{ type: "section" }, { type: "divider" }] }',
    );
    expect(fields.Blocks).toEqual([{ type: 'section' }, { type: 'divider' }]);
  });

  it('a scalar json field given a list keeps the array — a JSON document may be one', async () => {
    const fields = await written('  write d-[:posts]-> { Body: [{ type: "section" }] }');
    expect(fields.Body).toEqual([{ type: 'section' }]);
  });

  it('a non-json scalar field still renders a list as CSV (leniency unchanged)', async () => {
    const fields = await written('  write d-[:posts]-> { Title: ["a", "b"] }');
    expect(fields.Title).toBe('a, b');
  });
});
