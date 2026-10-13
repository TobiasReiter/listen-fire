// E5 — composition: same-file movement calls (§G of the syntax sketch).
//
//   1. THE §G INTAKE FIXTURE — `msg-[f:_resources]-> {
//      files_to_dropbox(f: node { … }) }`: per resource, the inline
//      literal synthesises an in-memory position (no
//      adapter), the call binds it to the callee's parameter in a FRESH
//      file-rooted environment, the callee constructs ITS OWN dropbox
//      instance and the write lands on the dropbox fake — one create per
//      file, provenance flowing from the resource read through the
//      synthesised position into the dropbox write's firing record.
//   2. Handle / position pass-through — a bare-name argument passes the
//      binding itself (a synthesised position bound earlier; nested calls
//      keep passing it down).
//   3. Lexical scoping — caller locals are invisible in the callee (the
//      checker refuses the program: the callee's scope is file-rooted).
//   4. Guards — recursion, unique-by on the retired declaration write (its engine
//      path outlives the author-time refusal by one wave), linked writes off
//      a synthesised position, value bindings as arguments.

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

import { runFailureCause, runMovement } from '../run';

import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import { MovementEngineError } from '../expression';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import {
  RESOURCES_REFERENCE_FIELD_ID,
  type Adapter,
  type RuntimeCapabilities,
  type Resource,
} from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { makeUnstablePosition, positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

/**
 * The error a rejected run really died of. A failure raised once the
 * interpreter is running comes out wrapped in `MovementRunFailed` (it carries
 * the run's partial write ledger out with it); parse/check failures are
 * unwrapped. The message is identical either way — only the class needs
 * looking through.
 */
async function rejectionCause(promise: Promise<unknown>): Promise<unknown> {
  const settled: unknown = await promise.then(
    () => new Error('expected the run to reject, but it resolved'),
    (e: unknown) => e,
  );
  return runFailureCause(settled);
}


const TEAM_ID = '00000000-0000-0000-0000-000000000020' as TeamId;

// ── Fake adapters ────────────────────────────────────────────────────────────

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
  opts: { resources?: Resource[] } = {},
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
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated({ fieldId }) {
      if (fieldId === RESOURCES_REFERENCE_FIELD_ID && opts.resources) {
        return opts.resources.map((resource) => ({
          position: makeUnstablePosition({ adapterType, recordType: null, data: resource }),
        }));
      }
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
    pipelineInputId: 'pi-movement-calls',
    adapterType,
    triggerType: 'webhook',
    payload,
  };
}

// ── Catalog / fixtures ───────────────────────────────────────────────────────

const catalog = staticCatalogFromManifests({
  credentials: {
    dealflow_inbox: { adapters: ['email'] },
    team_drive: { adapters: ['dropbox'] },
    acme_main: { adapters: ['attio'] },
  },
});

const CREDENTIAL_IDS: Record<string, string> = {
  dealflow_inbox: 'cred-email-1',
  team_drive: 'cred-dropbox-1',
  acme_main: 'cred-attio-1',
};

// The spec's §G worked example: a shape-typed library movement that
// constructs its own target, called per resource with an inline node
// literal adapting each file into the parameter's type.
const INTAKE_G = [
  'import { email, dropbox } from adapters',
  'import { team_drive } from credentials',
  '',
  'inbox = email()',
  '',
  'node Files {',
  '  name: <text>',
  '  data: <text>',
  '}',
  '',
  'movement files_to_dropbox(f: <Files>) {',
  '  drive = dropbox(credentials: team_drive)',
  '  write drive-[:file]-> {',
  '    name: f.`name`',
  '    data: f.`data`',
  '  }',
  '}',
  '',
  'movement intake(msg: <inbox-[:message]->>) {',
  '  msg-[f:_resources]-> {',
  '    files_to_dropbox(f: node { name: f.`filename`, data: f.`data` })',
  '  }',
  '}',
].join('\n');

describe('§G — _resources block → call with a synthesised node arg → dropbox writes', () => {
  it('lands one dropbox write per file, provenance flowing from the resource read', async () => {
    const email = makeFakeAdapter('email', {
      resources: [
        {
          externalId: 'att-1',
          name: 'pitch.pdf',
          data: { filename: 'pitch.pdf', data: 'BYTES-1' },
        },
        {
          externalId: 'att-2',
          name: 'model.xlsx',
          data: { filename: 'model.xlsx', data: 'BYTES-2' },
        },
      ],
    });
    const dropbox = makeFakeAdapter('dropbox');

    const result = await runMovement({
      source: INTAKE_G,
      movementName: 'intake',
      event: webhookEvent('email', { subject: 'Acme deck' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ email: email.adapter, dropbox: dropbox.adapter }),
    });

    // One dropbox create per resource, fields read off the in-memory
    // position the inline literal synthesised.
    expect(dropbox.creates).toEqual([
      { recordType: 'file', fields: { name: 'pitch.pdf', data: 'BYTES-1' } },
      { recordType: 'file', fields: { name: 'model.xlsx', data: 'BYTES-2' } },
    ]);

    // The firing record carries ONLY the adapter writes (the literal
    // is in-memory — not an effect), and each written field's trail
    // reaches back THROUGH the call + synthesised position to the resource
    // field the value was read from.
    expect(result.writes).toEqual([
      {
        adapterType: 'dropbox',
        recordType: 'file',
        created: true,
        committed: true,
        externalId: 'ext-dropbox-1',
        writtenValues: { name: 'pitch.pdf', data: 'BYTES-1' },
        outcome: 'create',
        provenance: {
          name: [{ kind: 'resource', externalId: 'att-1', name: 'pitch.pdf', field: 'filename' }],
          data: [{ kind: 'resource', externalId: 'att-1', name: 'pitch.pdf', field: 'data' }],
        },
        resultData: {},
        origin: { kind: 'write', writeIndex: 0, externalId: 'ext-dropbox-1' },
      },
      {
        adapterType: 'dropbox',
        recordType: 'file',
        created: true,
        committed: true,
        externalId: 'ext-dropbox-2',
        writtenValues: { name: 'model.xlsx', data: 'BYTES-2' },
        outcome: 'create',
        provenance: {
          name: [{ kind: 'resource', externalId: 'att-2', name: 'model.xlsx', field: 'filename' }],
          data: [{ kind: 'resource', externalId: 'att-2', name: 'model.xlsx', field: 'data' }],
        },
        resultData: {},
        origin: { kind: 'write', writeIndex: 1, externalId: 'ext-dropbox-2' },
      },
    ]);
  });
});

describe('pass-through arguments and nested calls', () => {
  // intake binds a synthesised position, passes it BY NAME through two call
  // frames; the innermost movement writes it to attio.
  const NESTED = [
    'import { email, attio } from adapters',
    'import { acme_main } from credentials',
    '',
    'inbox = email()',
    '',
    'node Lead {',
    '  name: <text>',
    '}',
    '',
    'movement persist(c: <Lead>) {',
    '  crm = attio(credentials: acme_main)',
    '  write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name: c.`name`',
    '  }',
    '}',
    '',
    'movement relay(c: <Lead>) {',
    '  persist(c: c)',
    '}',
    '',
    'movement intake(msg: <inbox-[:message]->>) {',
    '  lead = node { name: msg.`subject` }',
    '  relay(c: lead)',
    '}',
  ].join('\n');

  it('a bare-name argument passes the position binding down through nested frames', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    const result = await runMovement({
      source: NESTED,
      movementName: 'intake',
      event: webhookEvent('email', { subject: 'Acme Corp' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ email: email.adapter, attio: attio.adapter }),
    });

    expect(attio.creates).toEqual([{ recordType: 'company', fields: { name: 'Acme Corp' } }]);
    // The trail crosses both frames AND the synthesised position untouched:
    // the written name still cites the event's source field.
    expect(result.writes).toEqual([
      {
        adapterType: 'attio',
        recordType: 'company',
        created: true,
        committed: true,
        externalId: 'ext-attio-1',
        writtenValues: { name: 'Acme Corp' },
        outcome: 'create',
        provenance: {
          name: [
            { kind: 'source_field', instance: 'inbox', adapterType: 'email', field: 'subject' },
          ],
        },
        resultData: {},
        origin: { kind: 'write', writeIndex: 0, externalId: 'ext-attio-1' },
      },
    ]);
  });
});

describe('multi-parameter callees — any arity by call (entries stay arity-1)', () => {
  const PAIRED = [
    'import { email, attio } from adapters',
    'import { acme_main } from credentials',
    '',
    'inbox = email()',
    '',
    'node Lead {',
    '  name: <text>',
    '}',
    '',
    'node Note {',
    '  text: <text>',
    '}',
    '',
    'movement persist_pair(c: <Lead>, n: <Note>) {',
    '  crm = attio(credentials: acme_main)',
    '  write crm-[:companies]-> {',
    '    unique by (`name`)',
    '    name:    c.`name`',
    '    summary: n.`text`',
    '  }',
    '}',
    '',
    'movement intake(msg: <inbox-[:message]->>) {',
    '  persist_pair(c: node { name: msg.`subject` }, n: node { text: msg.`text` })',
    '}',
  ].join('\n');

  // Same call as PAIRED but with the arguments SWAPPED in source order —
  // named arguments carry no positional meaning, so the binding must go
  // by name (n → n, c → c), not by index.
  const PAIRED_OUT_OF_ORDER = PAIRED.replace(
    'persist_pair(c: node { name: msg.`subject` }, n: node { text: msg.`text` })',
    'persist_pair(n: node { text: msg.`text` }, c: node { name: msg.`subject` })',
  );

  it('a two-parameter movement runs as a callee, each argument bound by name', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await runMovement({
      source: PAIRED,
      movementName: 'intake',
      event: webhookEvent('email', { subject: 'Acme Corp', text: 'warm intro' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ email: email.adapter, attio: attio.adapter }),
    });

    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme Corp', summary: 'warm intro' } },
    ]);
  });

  it('an out-of-order call binds by argument name, not by position', async () => {
    expect(PAIRED_OUT_OF_ORDER).not.toBe(PAIRED); // the swap took
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await runMovement({
      source: PAIRED_OUT_OF_ORDER,
      movementName: 'intake',
      event: webhookEvent('email', { subject: 'Acme Corp', text: 'warm intro' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ email: email.adapter, attio: attio.adapter }),
    });

    // Exactly what the in-order call produces: c is still the company,
    // n is still the note — argument order carries no meaning.
    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme Corp', summary: 'warm intro' } },
    ]);
  });

  it('the multi-parameter movement itself cannot be the dispatch entry (MOVENG_RUNTIME)', async () => {
    await expect(
      runMovement({
        source: PAIRED,
        movementName: 'persist_pair',
        event: webhookEvent('email', { subject: 'Acme Corp' }),
        teamId: TEAM_ID,
        catalog,
        resolveCredentialId: (name) => CREDENTIAL_IDS[name],
        resolveAdapter: makeResolver({
          email: makeFakeAdapter('email').adapter,
          attio: makeFakeAdapter('attio').adapter,
        }),
      }),
    ).rejects.toThrow(/MOVENG_RUNTIME.*'persist_pair' takes 2 parameters/);
  });
});

describe('lexical scoping — the callee sees file scope, not the caller', () => {
  it("a callee reading a caller local fails the CHECK (the callee's scope is file-rooted)", async () => {
    const SOURCE = [
      'import { email, attio } from adapters',
      'import { acme_main } from credentials',
      '',
      'inbox = email()',
      'crm   = attio(credentials: acme_main)',
      '',
      'node Lead {',
      '  name: <text>',
      '}',
      '',
      'movement persist(c: <Lead>) {',
      '  write crm-[:companies]-> {',
      '    unique by (`name`)',
      '    name: caller_local',
      '  }',
      '}',
      '',
      'movement intake(msg: <inbox-[:message]->>) {',
      '  caller_local = msg.`subject`',
      '  persist(c: node { name: msg.`subject` })',
      '}',
    ].join('\n'),
      promise = runMovement({
        source: SOURCE,
        movementName: 'intake',
        event: webhookEvent('email', { subject: 'Acme Corp' }),
        teamId: TEAM_ID,
        catalog,
        resolveCredentialId: (name) => CREDENTIAL_IDS[name],
        resolveAdapter: makeResolver({
          email: makeFakeAdapter('email').adapter,
          attio: makeFakeAdapter('attio').adapter,
        }),
      });
    expect(await rejectionCause(promise)).toBeInstanceOf(MovementEngineError);
    await expect(promise).rejects.toThrow(/MOVENG_CHECK/);
  });

  it('a callee DOES see file-scope value bindings through its fresh environment', async () => {
    const SOURCE = [
      'import { email, attio } from adapters',
      'import { acme_main } from credentials',
      '',
      'inbox = email()',
      'crm   = attio(credentials: acme_main)',
      'team_tag = "sourced-by-listen-fire"',
      '',
      'node Lead {',
      '  name: <text>',
      '}',
      '',
      'movement persist(c: <Lead>) {',
      '  write crm-[:companies]-> {',
      '    unique by (`name`)',
      '    name: c.`name`',
      '    summary: team_tag',
      '  }',
      '}',
      '',
      'movement intake(msg: <inbox-[:message]->>) {',
      '  persist(c: node { name: msg.`subject` })',
      '}',
    ].join('\n');
    const attio = makeFakeAdapter('attio');

    await runMovement({
      source: SOURCE,
      movementName: 'intake',
      event: webhookEvent('email', { subject: 'Acme Corp' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: attio.adapter,
      }),
    });

    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme Corp', summary: 'sourced-by-listen-fire' } },
    ]);
  });
});

describe('guards', () => {
  const GUARD_PRELUDE = [
    'import { email, attio } from adapters',
    'import { acme_main } from credentials',
    '',
    'inbox = email()',
    'crm   = attio(credentials: acme_main)',
    '',
    'node Lead {',
    '  name: <text>',
    '}',
  ].join('\n');

  async function expectError(source: string, pattern: RegExp): Promise<void> {
    const promise = runMovement({
      source,
      movementName: 'intake',
      event: webhookEvent('email', { subject: 'Acme Corp' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
      }),
    });
    expect(await rejectionCause(promise)).toBeInstanceOf(MovementEngineError);
    await expect(promise).rejects.toThrow(pattern);
  }

  // From version 3 recursion is allowed and bounded by the call depth
  // (`recursion.unit.test.ts`); one that never ends still fails loud.
  it('recursion that never ends fails loud instead of looping', async () => {
    await expectError(
      [
        GUARD_PRELUDE,
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  intake(msg: msg)',
        '}',
      ].join('\n'),
      /MOVENG_CALL_DEPTH: call depth limit reached: 'intake → intake → intake → intake → … 24 more … → intake/,
    );
  });

  // The retired construct's engine path, which outlives the author-time
  // refusal by one wave: it still runs, and its own guard still holds.
  it('unique by on a declaration write has no store to resolve against', async () => {
    await expectError(
      [
        GUARD_PRELUDE,
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  lead = write Lead-[:company]-> {',
        '    unique by (`name`)',
        '    name: msg.`subject`',
        '  }',
        '}',
      ].join('\n'),
      /MOVENG_UNSUPPORTED: unique by on a shape write/,
    );
  });

  // Refused where it is written now (the checker knows the value's type), so
  // the engine's own guard is the second line, behind MOVENG_CHECK.
  it('a value binding is not a position argument', async () => {
    await expectError(
      [
        GUARD_PRELUDE,
        '',
        'movement persist(c: <Lead>) {',
        '  write crm-[:companies]-> {',
        '    unique by (`name`)',
        '    name: c.`name`',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  v = msg.`subject`',
        '  persist(c: v)',
        '}',
      ].join('\n'),
      /MOVENG_CHECK.*MOV_CALL_ARG_TYPE.*'persist' expects .*, but this argument is text/s,
    );
  });
});

// ── Positional calls and value parameters ────────────────────────────────────
//
// What TypeScript does: `f(a, b)` binds in declared order, and a parameter may
// take a value — a scalar, or a config record spelled as an object type — bound
// to what the argument evaluates to.
describe('positional calls and value parameters', () => {
  const PRELUDE = [
    'import { email, attio } from adapters',
    'import { acme_main } from credentials',
    '',
    'inbox = email()',
    '',
    'node Lead {',
    '  name: <text>',
    '}',
    '',
    'node Note {',
    '  text: <text>',
    '}',
  ].join('\n');

  async function run(source: string) {
    const attio = makeFakeAdapter('attio');
    await runMovement({
      source,
      movementName: 'intake',
      event: webhookEvent('email', { subject: 'Acme Corp', text: 'warm intro' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ email: makeFakeAdapter('email').adapter, attio: attio.adapter }),
    });
    return attio.creates;
  }

  it('positional arguments bind to the parameters in declared order', async () => {
    const creates = await run(
      [
        PRELUDE,
        'movement persist_pair(c: <Lead>, n: <Note>) {',
        '  crm = attio(credentials: acme_main)',
        '  write crm-[:companies]-> {',
        '    unique by (`name`)',
        '    name:    c.`name`',
        '    summary: n.`text`',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  persist_pair(node { name: msg.`subject` }, node { text: msg.`text` })',
        '}',
      ].join('\n'),
    );
    expect(creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme Corp', summary: 'warm intro' } },
    ]);
  });

  it('a scalar and a config-record parameter take values, optional key left out', async () => {
    const creates = await run(
      [
        PRELUDE,
        'movement persist(name: <text>, cfg: <{ summary: text, tag?: text }>) {',
        '  crm = attio(credentials: acme_main)',
        '  write crm-[:companies]-> {',
        '    unique by (`name`)',
        '    name:    name',
        '    summary: AT(cfg, "summary")',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  persist(msg.`subject`, { summary: "from ${msg.`text`}" })',
        '}',
      ].join('\n'),
    );
    expect(creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme Corp', summary: 'from warm intro' } },
    ]);
  });

  it('a value call binds the same by name', async () => {
    const creates = await run(
      [
        PRELUDE,
        'movement persist(name: <text>, cfg: <{ summary: text }>) {',
        '  crm = attio(credentials: acme_main)',
        '  write crm-[:companies]-> {',
        '    unique by (`name`)',
        '    name:    name',
        '    summary: AT(cfg, "summary")',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  persist(cfg: { summary: "named" }, name: msg.`subject`)',
        '}',
      ].join('\n'),
    );
    expect(creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme Corp', summary: 'named' } },
    ]);
  });
});

// ── Per-instance dry-run (message-write-unification incident) ────────────────
//
// A `dry_run: true` construction rehearses THAT target even when the run is
// live and the derived run_mode never flipped — the engine reads the
// instance's own construction config at adapter-resolution time, so no
// upstream static analysis can leak the write.
describe('per-instance dry_run wraps the adapter regardless of run-wide dryRun', () => {
  const DRY_ATTIO = [
    'import { email, attio } from adapters',
    'import { acme_main } from credentials',
    '',
    'inbox = email()',
    'crm   = attio(credentials: acme_main, dry_run: true)',
    '',
    'movement intake(msg: <inbox-[:message]->>) {',
    '  write crm-[:companies]-> {',
    '    name: msg.`subject`',
    '  }',
    '}',
  ].join('\n');

  const LIVE_ATTIO = DRY_ATTIO.replace(', dry_run: true', '');

  it('a dry_run instance is rehearsed even when the run is not run-wide dry', async () => {
    const attio = makeFakeAdapter('attio');
    const captured: CapturedWrite[] = [];

    const result = await runMovement({
      source: DRY_ATTIO,
      movementName: 'intake',
      event: webhookEvent('email', { subject: 'Acme Corp' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ email: makeFakeAdapter('email').adapter, attio: attio.adapter }),
      // NB: no `dryRun` — the run is live; only the instance is dry.
      writeSink: (w) => captured.push(w),
    });

    // The real adapter was never called — the post did not go out.
    expect(attio.creates).toEqual([]);
    // …but the write was still planned and observable.
    expect(captured).toEqual([
      { kind: 'create', adapterType: 'attio', recordType: 'company', fields: { name: 'Acme Corp' } },
    ]);
    expect(result.writes).toHaveLength(1);
  });

  it('the same instance without dry_run does hit the real adapter', async () => {
    const attio = makeFakeAdapter('attio');

    await runMovement({
      source: LIVE_ATTIO,
      movementName: 'intake',
      event: webhookEvent('email', { subject: 'Acme Corp' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ email: makeFakeAdapter('email').adapter, attio: attio.adapter }),
    });

    expect(attio.creates).toEqual([{ recordType: 'company', fields: { name: 'Acme Corp' } }]);
  });

  it('stamps committed:false on a rehearsed write and committed:true on a live one', async () => {
    const dryResult = await runMovement({
      source: DRY_ATTIO,
      movementName: 'intake',
      event: webhookEvent('email', { subject: 'Acme Corp' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
      }),
      writeSink: () => {},
    });
    expect(dryResult.writes[0].committed).toBe(false);

    const liveResult = await runMovement({
      source: LIVE_ATTIO,
      movementName: 'intake',
      event: webhookEvent('email', { subject: 'Acme Corp' }),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
      }),
    });
    expect(liveResult.writes[0].committed).toBe(true);
  });
});
