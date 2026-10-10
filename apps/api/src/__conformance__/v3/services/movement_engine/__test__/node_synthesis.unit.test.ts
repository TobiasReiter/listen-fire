// Engine coverage for `node { … }` — in-memory node synthesis, wave 1.
//
// The synthesised position is the composition currency: a literal is evaluated
// EAGERLY where it is written, passed to a callee as an argument, and read back
// there on both planes — entries by dot, synthesised landings by arrow. No
// adapter is involved (a node belongs to no graph), so what is worth pinning is
// that nothing reaches the firing log from the synthesis itself, that the
// per-entry TRAIL survives the call, and that a FileRef rides through untouched.
//
// Mirrors the harness of calls.unit.test.ts (§G composition).

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

import { runMovement, resumeMovement } from '../run';
import type { ParkSink } from '../run';
import type { CallbackSink } from '../callback_sink';
import type { ParkedScopeState } from '../serialize';

import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import {
  RESOURCES_REFERENCE_FIELD_ID,
  type Adapter,
  type RuntimeCapabilities,
  type Resource,
} from '../../translation_graph/adapter';
import type { FileRef } from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { makeUnstablePosition, positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

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
  opts: {
    resources?: Resource[];
    related?: Record<string, Array<Record<string, unknown>>>;
    /** Answer a hop FRESHLY per call — how a source that changes between two
     *  reads is spelled (a lazy walk must see the change; an eager one must
     *  not). Consulted before `related`; `relatedCalls` counts the hops. */
    relatedFn?: (fieldId: string, call: number) => Array<Record<string, unknown>> | undefined;
  } = {},
): {
  adapter: Adapter;
  creates: RecordedWrite[];
  updates: RecordedWrite[];
  relatedCalls: { count: number };
} {
  const creates: RecordedWrite[] = [];
  const updates: RecordedWrite[] = [];
  const relatedCalls = { count: 0 };
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
      relatedCalls.count += 1;
      const fresh = opts.relatedFn?.(fieldId, relatedCalls.count);
      if (fresh) {
        return fresh.map((data) => ({
          position: makeUnstablePosition({ adapterType, recordType: null, data }),
        }));
      }
      if (fieldId === RESOURCES_REFERENCE_FIELD_ID && opts.resources) {
        return opts.resources.map((resource) => ({
          position: makeUnstablePosition({ adapterType, recordType: null, data: resource }),
        }));
      }
      for (const [edge, records] of Object.entries(opts.related ?? {})) {
        if (edge !== fieldId) continue;
        return records.map((data) => ({
          position: makeUnstablePosition({ adapterType, recordType: null, data }),
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
  return { adapter, creates, updates, relatedCalls };
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

const PRELUDE = [
  'import { email, dropbox, attio } from adapters',
  'import { team_drive, acme_main } from credentials',
  '',
  'inbox = email()',
  '',
].join('\n');

/** A fake callback sink — the cheapest REAL park: minting a callback captures
 *  the enclosing scope through the same serialiser a parked ask writes. */
function makeFakeCallbackSink() {
  const mints: Array<{ id: string; state: ParkedScopeState }> = [];
  const sink = {
    async mint(input: { state: ParkedScopeState }) {
      const id = `cb_fake${mints.length + 1}`;
      mints.push({ id, state: input.state });
      return { id, url: `https://api.test/api/cb/${id}` };
    },
    async calls() {
      return [];
    },
    async correlateAwait() {},
  } as unknown as CallbackSink;
  return { sink, mints };
}

interface RunAdapters {
  email: Adapter;
  attio?: Adapter;
  dropbox?: Adapter;
  callbacks?: { sink: CallbackSink };
  parkSink?: ParkSink;
}

function run(source: string, payload: Record<string, unknown>, adapters: RunAdapters):
  Promise<Awaited<ReturnType<typeof runMovement>>> {
  return runMovement({
    source: PRELUDE + source,
    movementName: 'intake',
    event: webhookEvent('email', payload),
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: (name) => CREDENTIAL_IDS[name],
    resolveAdapter: makeResolver({
      email: adapters.email,
      ...(adapters.attio ? { attio: adapters.attio } : {}),
      ...(adapters.dropbox ? { dropbox: adapters.dropbox } : {}),
    }),
    ...(adapters.callbacks ? { callbackSink: adapters.callbacks.sink } : {}),
    ...(adapters.parkSink ? { parkSink: adapters.parkSink } : {}),
  });
}

/** The same movement, resumed from a parked leaf — the REAL resume path. */
function resume(
  source: string,
  payload: Record<string, unknown>,
  adapters: RunAdapters,
  state: ParkedScopeState,
): Promise<Awaited<ReturnType<typeof resumeMovement>>> {
  return resumeMovement({
    source: PRELUDE + source,
    movementName: 'intake',
    event: webhookEvent('email', payload),
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: (name) => CREDENTIAL_IDS[name],
    resolveAdapter: makeResolver({
      email: adapters.email,
      ...(adapters.attio ? { attio: adapters.attio } : {}),
      ...(adapters.dropbox ? { dropbox: adapters.dropbox } : {}),
    }),
    state,
  });
}

function makeFakeParkSink(): {
  sink: ParkSink;
  timerParks: Array<{ address: string; state: ParkedScopeState }>;
} {
  const timerParks: Array<{ address: string; state: ParkedScopeState }> = [];
  const sink = {
    async commitTimerPark(input: { address: string; state: ParkedScopeState }) {
      timerParks.push({ address: input.address, state: input.state });
    },
    async recordJoin() {},
  } as unknown as ParkSink;
  return { sink, timerParks };
}

describe('a two-field node passed to a library movement and read back', () => {
  const NOTE = [
    'node Note {',
    '  title: <text>',
    '  body: <text>',
    '}',
    '',
    'movement persist(n: <Note>) {',
    '  crm = attio(credentials: acme_main)',
    '  write crm-[:companies]-> {',
    '    name: n.`title`',
    '    summary: n.`body`',
    '  }',
    '}',
    '',
  ].join('\n');

  it('the callee reads both entries, and the synthesis itself writes nothing', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    const result = await run(
      NOTE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  persist(n: node { title: msg.`subject`, body: msg.`text` })',
          '}',
        ].join('\n'),
      { subject: 'Acme Corp', text: 'a deck' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme Corp', summary: 'a deck' } },
    ]);
    // ONE firing-log entry: the attio create. Synthesising a node is not an
    // effect — no adapter, no external record, nothing to record.
    expect(result.writes).toHaveLength(1);
    // The trail crosses the synthesis untouched: each written field still cites
    // the event field its entry was computed from.
    expect(result.writes[0].provenance).toEqual({
      name: [{ kind: 'source_field', instance: 'inbox', adapterType: 'email', field: 'subject' }],
      summary: [{ kind: 'source_field', instance: 'inbox', adapterType: 'email', field: 'text' }],
    });
  });

  it('a node bound to a name passes down through nested frames', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await run(
      NOTE +
        [
          'movement relay(n: <Note>) {',
          '  persist(n: n)',
          '}',
          '',
          'movement intake(msg: <inbox-[:message]->>) {',
          '  d = node { title: msg.`subject`, body: msg.`text` }',
          '  relay(n: d)',
          '}',
        ].join('\n'),
      { subject: 'Acme Corp', text: 'b' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme Corp', summary: 'b' } },
    ]);
  });
});

describe('a single synthesised edge, traversed by the callee', () => {
  it('the edge lands ONE synthesised position and its entries read there', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'node Deal {',
        '  title: <text>',
        '  node company {',
        '    name: <text>',
        '  }',
        '}',
        '',
        'movement persist(d: <Deal>) {',
        '  crm = attio(credentials: acme_main)',
        '  d-[o:company]-> {',
        '    write crm-[:companies]-> {',
        '      name: o.`name`',
        '      summary: d.`title`',
        '    }',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  persist(d: node {',
        '    title: msg.`subject`',
        '    company: node { name: msg.`text` }',
        '  })',
        '}',
      ].join('\n'),
      { subject: 'Series A', text: 'Acme Corp' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme Corp', summary: 'Series A' } },
    ]);
  });

  it('synthesised edges nest — a grandchild is reached by two hops', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'node Deal {',
        '  title: <text>',
        '  node company {',
        '    name: <text>',
        '    node owner {',
        '      email: <text>',
        '    }',
        '  }',
        '}',
        '',
        'movement persist(d: <Deal>) {',
        '  crm = attio(credentials: acme_main)',
        '  d-[o:company]-> {',
        '    o-[p:owner]-> {',
        '      write crm-[:people]-> {',
        '        name: o.`name`',
        '        email: p.`email`',
        '      }',
        '    }',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  persist(d: node {',
        '    title: msg.`subject`',
        '    company: node { name: msg.`text`, owner: node { email: "ada@acme.test" } }',
        '  })',
        '}',
      ].join('\n'),
      { subject: 'Series A', text: 'Acme Corp' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([
      { recordType: 'person', fields: { name: 'Acme Corp', email: 'ada@acme.test' } },
    ]);
  });
});

describe('a plural synthesised edge, fanned out', () => {
  it('one write per landing, in source order', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'node Deal {',
        '  title: <text>',
        '  node people {',
        '    name: <text>',
        '  }',
        '}',
        '',
        'movement persist(d: <Deal>) {',
        '  crm = attio(credentials: acme_main)',
        '  d-[p:people]-> {',
        '    write crm-[:people]-> {',
        '      name: p.`name`',
        '      email: d.`title`',
        '    }',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  persist(d: node {',
        '    title: msg.`subject`',
        '    people: [node { name: msg.`text` }, node { name: "Grace" }]',
        '  })',
        '}',
      ].join('\n'),
      { subject: 'Series A', text: 'Ada' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([
      { recordType: 'person', fields: { name: 'Ada', email: 'Series A' } },
      { recordType: 'person', fields: { name: 'Grace', email: 'Series A' } },
    ]);
  });
});

describe('values ride through untouched', () => {
  it('a FileRef entry reaches the callee as the SAME handle — nothing materialises', async () => {
    const fileRef = {
      __brand: 'FileRef',
      name: 'pitch.pdf',
      contentType: 'application/pdf',
      retrieve: async () => {
        throw new Error('test: the synthesis must never pull the bytes');
      },
    } as unknown as FileRef;

    const email = makeFakeAdapter('email', {
      related: { files: [{ filename: 'pitch.pdf', data: fileRef }] },
    });
    const dropbox = makeFakeAdapter('dropbox');

    await run(
      [
        'node Doc {',
        '  name: <text>',
        '  blob: <file>',
        '}',
        '',
        'movement store(f: <Doc>) {',
        '  drive = dropbox(credentials: team_drive)',
        '  write drive-[:file]-> {',
        '    name: f.`name`',
        '    data: f.`blob`',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  msg-[a:files]-> {',
        '    store(f: node { name: a.`filename`, blob: a.`data` })',
        '  }',
        '}',
      ].join('\n'),
      { subject: 'deck' },
      { email: email.adapter, dropbox: dropbox.adapter },
    );

    expect(dropbox.creates).toHaveLength(1);
    expect(dropbox.creates[0].fields.name).toBe('pitch.pdf');
    // Object IDENTITY: the handle the source produced is the handle the callee
    // wrote. Nothing copied it, and nothing read the bytes.
    expect(dropbox.creates[0].fields.data).toBe(fileRef);
  });
});

// The retirement's own contract (wave 4). A program that writes to a shape is
// REFUSED where it is authored — but one already saved must keep running, so the
// run gate lets this one diagnostic through and the engine still materialises
// it. Both forms therefore reach the same parameter, which is what an author
// mid-migration sees.
describe('a shape WRITE still RUNS after the author-time retirement', () => {
  it('both forms reach the same shape-typed parameter in one movement', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'node Note {',
        '  title: <text>',
        '}',
        '',
        'movement persist(n: <Note>) {',
        '  crm = attio(credentials: acme_main)',
        '  write crm-[:companies]-> { name: n.`title` }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  persist(n: write Note-[:item]-> { title: msg.`subject` })',
        '  persist(n: node { title: msg.`text` })',
        '}',
      ].join('\n'),
      { subject: 'from a shape write', text: 'from a node' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'from a shape write' } },
      { recordType: 'company', fields: { name: 'from a node' } },
    ]);
  });
});

// ── Wave 2 — pass-through edges and `lazy` ──────────────────────────────────

describe('the files-through-a-call gap, closed', () => {
  // The shape the callee is written against names the SOURCE's own field
  // names: a traversal entry hands the walked positions through unrenamed
  // (per-item renaming is the next wave).
  const DOC = [
    'node Doc {',
    '  title: <text>',
    '  node files {',
    '    filename: <text>',
    '    data: <file>',
    '  }',
    '}',
    '',
    'movement store(d: <Doc>) {',
    '  drive = dropbox(credentials: team_drive)',
    '  d-[f:files]-> {',
    '    write drive-[:file]-> {',
    '      name: f.`filename`',
    '      data: f.`data`',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');

  function attachment(name: string) {
    return {
      filename: name,
      data: {
        __brand: 'FileRef',
        name,
        contentType: 'application/pdf',
        retrieve: async () => {
          throw new Error('test: the pass-through must never pull the bytes');
        },
      } as unknown as FileRef,
    };
  }

  it('a lazy edge hands the source FileRef to a callee that writes it onward', async () => {
    const deck = attachment('pitch.pdf');
    const email = makeFakeAdapter('email', { related: { files: [deck] } });
    const dropbox = makeFakeAdapter('dropbox');

    const result = await run(
      DOC +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  store(d: node { title: msg.`subject`, files: lazy msg-[a:files]-> })',
          '}',
        ].join('\n'),
      { subject: 'Series A' },
      { email: email.adapter, dropbox: dropbox.adapter },
    );

    expect(dropbox.creates).toHaveLength(1);
    expect(dropbox.creates[0].fields.name).toBe('pitch.pdf');
    // IDENTITY: the handle the source produced is the handle the callee wrote.
    // Nothing copied it, nothing read the bytes, nothing materialised.
    expect(dropbox.creates[0].fields.data).toBe(deck.data);
    // The trail names the REAL source the walk went through — a pass-through
    // edge invents no origin of its own.
    expect(result.writes[0].provenance.name).toEqual([
      { kind: 'source_field', instance: 'inbox', adapterType: 'email', field: 'filename' },
    ]);
  });

  it('the eager form closes it too — same landings, walked at the literal', async () => {
    const deck = attachment('deck.pdf');
    const email = makeFakeAdapter('email', { related: { files: [deck] } });
    const dropbox = makeFakeAdapter('dropbox');

    await run(
      DOC +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  store(d: node { title: msg.`subject`, files: msg-[a:files]-> })',
          '}',
        ].join('\n'),
      { subject: 'Series A' },
      { email: email.adapter, dropbox: dropbox.adapter },
    );

    expect(dropbox.creates).toHaveLength(1);
    expect(dropbox.creates[0].fields.data).toBe(deck.data);
  });

  it('every landing fans out — one write per walked position', async () => {
    const email = makeFakeAdapter('email', {
      related: { files: [attachment('a.pdf'), attachment('b.pdf')] },
    });
    const dropbox = makeFakeAdapter('dropbox');

    await run(
      DOC +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  store(d: node { title: "x", files: lazy msg-[a:files]-> })',
          '}',
        ].join('\n'),
      {},
      { email: email.adapter, dropbox: dropbox.adapter },
    );

    expect(dropbox.creates.map((w) => w.fields.name)).toEqual(['a.pdf', 'b.pdf']);
  });
});

describe('hopping ON past a pass-through edge', () => {
  it('the chain continues in the SOURCE graph, through its own adapter', async () => {
    // `people` lands attio records; the next hop is theirs, not the node's.
    const attio = makeFakeAdapter('attio', {
      related: { people: [{ name: 'Ada' }], company: [{ name: 'Acme' }] },
    });
    const email = makeFakeAdapter('email');

    await run(
      [
        'node Roster {',
        '  title: <text>',
        '  node people {',
        '    name: <text>',
        '    node company {',
        '      name: <text>',
        '    }',
        '  }',
        '}',
        '',
        'movement persist(r: <Roster>) {',
        '  crm = attio(credentials: acme_main)',
        '  r-[:people]->-[c:company]-> {',
        '    write crm-[:companies]-> { name: c.`name` }',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  persist(r: node { title: "x", people: crm-[p:people]-> })',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([{ recordType: 'company', fields: { name: 'Acme' } }]);
  });
});

describe('when the walk happens', () => {
  const COUNTER = [
    'node Bag {',
    '  title: <text>',
    '  node files {',
    '    filename: <text>',
    '  }',
    '}',
    '',
    'movement record_names(d: <Bag>) {',
    '  crm = attio(credentials: acme_main)',
    '  d-[f:files]-> {',
    '    write crm-[:companies]-> { name: f.`filename` }',
    '  }',
    '}',
    '',
  ].join('\n');

  /** A source whose `files` edge yields one MORE record on each hop — the
   *  smallest thing that can tell "walked once" from "walked per read". */
  function growingEmail() {
    return makeFakeAdapter('email', {
      relatedFn: (fieldId, call) =>
        fieldId === 'files'
          ? Array.from({ length: call }, (_, i) => ({ filename: `call${call}-${i}` }))
          : undefined,
    });
  }

  it('EAGER walks once, at the literal — a later read sees that same snapshot', async () => {
    const email = growingEmail();
    const attio = makeFakeAdapter('attio');

    await run(
      COUNTER +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  d = node { title: "x", files: msg-[a:files]-> }',
          '  record_names(d: d)',
          '  record_names(d: d)',
          '}',
        ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    // One hop, at the synthesis; both reads see its one landing.
    expect(email.relatedCalls.count).toBe(1);
    expect(attio.creates.map((w) => w.fields.name)).toEqual(['call1-0', 'call1-0']);
  });

  it('LAZY re-walks the live source on EVERY read — no cache, per ruling 3', async () => {
    const email = growingEmail();
    const attio = makeFakeAdapter('attio');

    await run(
      COUNTER +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  d = node { title: "x", files: lazy msg-[a:files]-> }',
          '  record_names(d: d)',
          '  record_names(d: d)',
          '}',
        ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(email.relatedCalls.count).toBe(2);
    // The second read sees what the source says NOW: two records, not one.
    expect(attio.creates.map((w) => w.fields.name)).toEqual([
      'call1-0',
      'call2-0',
      'call2-1',
    ]);
  });

  it('a lazy edge nothing reads never walks at all', async () => {
    const email = growingEmail();
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  d = node { title: "x", files: lazy msg-[a:files]-> }',
        '  crm = attio(credentials: acme_main)',
        '  write crm-[:companies]-> { name: d.title }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(email.relatedCalls.count).toBe(0);
    expect(attio.creates).toEqual([{ recordType: 'company', fields: { name: 'x' } }]);
  });
});

describe('the hop keeps its own WHERE / ORDER BY / LIMIT', () => {
  const PICK = [
    'node Bag {',
    '  title: <text>',
    '  node files {',
    '    filename: <text>',
    '  }',
    '}',
    '',
    'movement record_names(d: <Bag>) {',
    '  crm = attio(credentials: acme_main)',
    '  d-[f:files]-> {',
    '    write crm-[:companies]-> { name: f.`filename` }',
    '  }',
    '}',
    '',
  ].join('\n');

  const FILES = [
    { filename: 'b.pdf', kind: 'deck' },
    { filename: 'a.pdf', kind: 'deck' },
    { filename: 'c.txt', kind: 'note' },
  ];

  it('the same WHERE on an ordinary block head narrows identically', async () => {
    const email = makeFakeAdapter('email', { related: { files: FILES } });
    const attio = makeFakeAdapter('attio');
    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  msg-[a:files WHERE `filename` == "a.pdf"]-> {',
        '    write crm-[:companies]-> { name: a.`filename` }',
        '  }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );
    expect(attio.creates.map((w) => w.fields.name)).toEqual(['a.pdf']);
  });

  it('a WHERE on a lazy hop narrows the walk it stored', async () => {
    const email = makeFakeAdapter('email', { related: { files: FILES } });
    const attio = makeFakeAdapter('attio');

    await run(
      PICK +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  record_names(d: node { title: "x", files: lazy msg-[a:files WHERE `kind` == "deck"]-> })',
          '}',
        ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((w) => w.fields.name)).toEqual(['b.pdf', 'a.pdf']);
  });

  it('ORDER BY / LIMIT apply to the stored walk, not to the read', async () => {
    const email = makeFakeAdapter('email', { related: { files: FILES } });
    const attio = makeFakeAdapter('attio');

    await run(
      PICK +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  record_names(d: node { title: "x", files: lazy msg-[a:files ORDER BY `filename` LIMIT 2]-> })',
          '}',
        ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((w) => w.fields.name)).toEqual(['a.pdf', 'b.pdf']);
  });
});

describe('`lazy` on an ordinary binding', () => {
  it('binds the walk, and a block off it walks the live source', async () => {
    const attio = makeFakeAdapter('attio', {
      related: { people: [{ name: 'Ada' }], company: [{ name: 'Acme' }] },
    });
    const email = makeFakeAdapter('email');

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  people = lazy crm-[p:people]->',
        '  people-[c:company]-> {',
        '    write crm-[:companies]-> { name: c.`name` }',
        '  }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([{ recordType: 'company', fields: { name: 'Acme' } }]);
  });

  it('a field read off it walks and collapses over the landings', async () => {
    const email = makeFakeAdapter('email', {
      related: { files: [{ filename: 'a.pdf' }, { filename: 'b.pdf' }] },
    });
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  files = lazy msg-[a:files]->',
        '  write crm-[:companies]-> { name: JOIN(files.`filename`, ", ") }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'a.pdf, b.pdf' } },
    ]);
  });

  it('each read walks again — the binding holds the walk, not its answer', async () => {
    const email = makeFakeAdapter('email', {
      relatedFn: (fieldId, call) =>
        fieldId === 'files' ? [{ filename: `call${call}` }] : undefined,
    });
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  files = lazy msg-[a:files]->',
        '  write crm-[:companies]-> { name: files.`filename` }',
        '  write crm-[:companies]-> { name: files.`filename` }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((w) => w.fields.name)).toEqual(['call1', 'call2']);
  });
});

describe('a park carries the WALK, not what it walked to', () => {
  it('the captured scope holds the traversal and its own scope — no landings', async () => {
    const email = makeFakeAdapter('email', { related: { files: [{ filename: 'a.pdf' }] } });
    const attio = makeFakeAdapter('attio');
    const callbacks = makeFakeCallbackSink();

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  files = lazy msg-[a:files]->',
        '  cb = callback({ write crm-[:companies]-> { name: files.`filename` } })',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter, callbacks },
    );

    expect(callbacks.mints).toHaveLength(1);
    const captured = callbacks.mints[0].state.scopeChain
      .flatMap((scope) => Object.entries(scope.bindings))
      .find(([name]) => name === 'files');
    expect(captured).toBeDefined();
    const descriptor = captured?.[1];
    if (descriptor?.kind !== 'lazyWalk') throw new Error('expected the walk to survive the park');
    expect(descriptor.walk.head.hopsRaw).toBe('-[a:files]->');
    // The root it walks from came along, so the resumed run can walk again.
    expect(Object.keys(descriptor.walk.captured)).toContain('msg');
    // Nothing was walked to park it — the source was never touched.
    expect(email.relatedCalls.count).toBe(0);
    // And the parked blob really is a JSON wire shape.
    expect(() => JSON.stringify(callbacks.mints[0].state)).not.toThrow();
  });

  it('a synthesised node parks its deferred edge the same way', async () => {
    const email = makeFakeAdapter('email', { related: { files: [{ filename: 'a.pdf' }] } });
    const attio = makeFakeAdapter('attio');
    const callbacks = makeFakeCallbackSink();

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  d = node { title: "x", files: lazy msg-[a:files]-> }',
        '  cb = callback({ write crm-[:companies]-> { name: d.title } })',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter, callbacks },
    );

    const node = callbacks.mints[0].state.scopeChain
      .flatMap((scope) => Object.entries(scope.bindings))
      .find(([name]) => name === 'd')?.[1];
    if (node?.kind !== 'nodePosition') throw new Error('expected the node to survive the park');
    const edge = node.edges.files;
    if (edge.kind !== 'deferred') throw new Error('expected the edge to park deferred');
    expect(edge.walk.head.hopsRaw).toBe('-[a:files]->');
    expect(email.relatedCalls.count).toBe(0);
  });

  it('an EAGER edge parks what it already walked', async () => {
    const email = makeFakeAdapter('email', { related: { files: [{ filename: 'a.pdf' }] } });
    const attio = makeFakeAdapter('attio');
    const callbacks = makeFakeCallbackSink();

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  d = node { title: "x", files: msg-[a:files]-> }',
        '  cb = callback({ write crm-[:companies]-> { name: d.title } })',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter, callbacks },
    );

    const node = callbacks.mints[0].state.scopeChain
      .flatMap((scope) => Object.entries(scope.bindings))
      .find(([name]) => name === 'd')?.[1];
    if (node?.kind !== 'nodePosition') throw new Error('expected the node to survive the park');
    const edge = node.edges.files;
    if (edge.kind !== 'landed') throw new Error('expected the edge to park landed');
    expect(edge.landings).toHaveLength(1);
    expect(email.relatedCalls.count).toBe(1);
  });
});

describe('emptiness through a deferred walk', () => {
  it('EXISTS gates on the walk, run at the test', async () => {
    const email = makeFakeAdapter('email', { related: { files: [{ filename: 'a.pdf' }] } });
    const attio = makeFakeAdapter('attio');
    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  files = lazy msg-[a:files]->',
        '  if EXISTS(files) {',
        '    write crm-[:companies]-> { name: "yes" }',
        '  }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );
    expect(attio.creates).toEqual([{ recordType: 'company', fields: { name: 'yes' } }]);
  });
});

// ── Wave 3 — per-item synthesis (`-> node { … }`) ───────────────────────────

describe('the design example, end to end', () => {
  // Layer 8 take 4's opening sketch, run for real: the callee is written
  // against `name` / `blob`, names the SOURCE never used, and the mapping is
  // the only thing that knows both.
  const DEAL = [
    'node Deal {',
    '  title: <text>',
    '  node files {',
    '    name: <text>',
    '    blob: <file>',
    '  }',
    '}',
    '',
    'movement process_deal(d: <Deal>) {',
    '  drive = dropbox(credentials: team_drive)',
    '  d-[f:files]-> {',
    '    write drive-[:file]-> {',
    '      filename: f.`name`',
    '      data: f.`blob`',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');

  function attachment(name: string) {
    return {
      filename: name,
      data: {
        __brand: 'FileRef',
        name,
        contentType: 'application/pdf',
        retrieve: async () => {
          throw new Error('test: per-item synthesis must never pull the bytes');
        },
      } as unknown as FileRef,
    };
  }

  const INTAKE = [
    'movement intake(msg: <inbox-[:message]->>) {',
    '  deal = node {',
    '    title: msg.`subject`',
    '    files: lazy msg-[a:files]-> node { name: a.`filename`, blob: a.`data` }',
    '  }',
    '  process_deal(d: deal)',
    '}',
  ].join('\n');

  it('the callee reads the MAPPING’s names and writes the source’s own FileRef onward', async () => {
    const deck = attachment('pitch.pdf');
    const email = makeFakeAdapter('email', { related: { files: [deck] } });
    const dropbox = makeFakeAdapter('dropbox');

    const result = await run(DEAL + INTAKE, { subject: 'Series A' }, {
      email: email.adapter,
      dropbox: dropbox.adapter,
    });

    expect(dropbox.creates).toHaveLength(1);
    // Renamed on the way through: the source's `filename` reached the callee
    // as `name`, and the callee never had to know the source's spelling.
    expect(dropbox.creates[0].fields.filename).toBe('pitch.pdf');
    // IDENTITY: the handle the source produced is the handle the callee wrote.
    // The wrapper renamed the entry; it did not copy the value.
    expect(dropbox.creates[0].fields.data).toBe(deck.data);

    // The trail names the REAL source read the entry came from — a synthesised
    // entry carries the provenance of the expression that produced it, and the
    // wrapper invents nothing of its own.
    expect(result.writes[0].provenance.data).toEqual([
      { kind: 'source_field', instance: 'inbox', adapterType: 'email', field: 'data' },
    ]);
    expect(result.writes[0].provenance.filename).toEqual([
      { kind: 'source_field', instance: 'inbox', adapterType: 'email', field: 'filename' },
    ]);
  });

  it('every landing is mapped — one synthesised node per walked position', async () => {
    const email = makeFakeAdapter('email', {
      related: { files: [attachment('a.pdf'), attachment('b.pdf')] },
    });
    const dropbox = makeFakeAdapter('dropbox');

    await run(DEAL + INTAKE, {}, { email: email.adapter, dropbox: dropbox.adapter });

    expect(dropbox.creates.map((w) => w.fields.filename)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('the eager form maps at the literal — same landings, walked once', async () => {
    const deck = attachment('deck.pdf');
    const email = makeFakeAdapter('email', { related: { files: [deck] } });
    const dropbox = makeFakeAdapter('dropbox');

    await run(
      DEAL +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  process_deal(d: node {',
          '    title: msg.`subject`',
          '    files: msg-[a:files]-> node { name: a.`filename`, blob: a.`data` }',
          '  })',
          '}',
        ].join('\n'),
      {},
      { email: email.adapter, dropbox: dropbox.adapter },
    );

    expect(email.relatedCalls.count).toBe(1);
    expect(dropbox.creates[0].fields.data).toBe(deck.data);
  });
});

describe('when a MAPPED walk happens', () => {
  const BAG = [
    'node Bag {',
    '  title: <text>',
    '  node files {',
    '    label: <text>',
    '  }',
    '}',
    '',
    'movement record_names(d: <Bag>) {',
    '  crm = attio(credentials: acme_main)',
    '  d-[f:files]-> {',
    '    write crm-[:companies]-> { name: f.`label` }',
    '  }',
    '}',
    '',
  ].join('\n');

  /** One more record per hop — the smallest thing that tells "walked once"
   *  from "walked (and mapped) per read". */
  function growingEmail() {
    return makeFakeAdapter('email', {
      relatedFn: (fieldId, call) =>
        fieldId === 'files'
          ? Array.from({ length: call }, (_, i) => ({ filename: `call${call}-${i}` }))
          : undefined,
    });
  }

  const MAPPED_ENTRY = 'files: lazy msg-[a:files]-> node { label: a.`filename` }';

  it('LAZY re-walks AND re-maps on every read — no cache, per ruling 3', async () => {
    const email = growingEmail();
    const attio = makeFakeAdapter('attio');

    await run(
      BAG +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          `  d = node { title: "x", ${MAPPED_ENTRY} }`,
          '  record_names(d: d)',
          '  record_names(d: d)',
          '}',
        ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(email.relatedCalls.count).toBe(2);
    expect(attio.creates.map((w) => w.fields.name)).toEqual(['call1-0', 'call2-0', 'call2-1']);
  });

  it('EAGER maps once, at the literal — a later read sees that same snapshot', async () => {
    const email = growingEmail();
    const attio = makeFakeAdapter('attio');

    await run(
      BAG +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  d = node { title: "x", files: msg-[a:files]-> node { label: a.`filename` } }',
          '  record_names(d: d)',
          '  record_names(d: d)',
          '}',
        ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(email.relatedCalls.count).toBe(1);
    expect(attio.creates.map((w) => w.fields.name)).toEqual(['call1-0', 'call1-0']);
  });

  it('a mapped edge nothing reads never walks, and never synthesises', async () => {
    const email = growingEmail();
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        `  d = node { title: "x", ${MAPPED_ENTRY} }`,
        '  crm = attio(credentials: acme_main)',
        '  write crm-[:companies]-> { name: d.title }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(email.relatedCalls.count).toBe(0);
  });

  it('the hop keeps its own WHERE — the mapping renames what the walk chose', async () => {
    const email = makeFakeAdapter('email', {
      related: {
        files: [
          { filename: 'b.pdf', kind: 'deck' },
          { filename: 'c.txt', kind: 'note' },
        ],
      },
    });
    const attio = makeFakeAdapter('attio');

    await run(
      BAG +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  record_names(d: node { title: "x", files: lazy msg-[a:files WHERE `kind` == "deck"]-> node { label: a.`filename` } })',
          '}',
        ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((w) => w.fields.name)).toEqual(['b.pdf']);
  });
});

describe('mapped landings are ordinary synthesised nodes', () => {
  it('a tail may carry its own edges — a two-level tree, hopped by the callee', async () => {
    const attio = makeFakeAdapter('attio', {
      related: { people: [{ name: 'Ada' }], company: [{ name: 'Acme' }] },
    });
    const email = makeFakeAdapter('email');

    await run(
      [
        'node Roster {',
        '  title: <text>',
        '  node people {',
        '    name: <text>',
        '    node company {',
        '      name: <text>',
        '    }',
        '  }',
        '}',
        '',
        'movement persist(r: <Roster>) {',
        '  crm = attio(credentials: acme_main)',
        '  r-[p:people]-> {',
        '    p-[c:company]-> {',
        '      write crm-[:companies]-> { name: c.`name`, summary: p.`name` }',
        '    }',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  persist(r: node {',
        '    title: "x"',
        '    people: crm-[p:people]-> node { name: p.`name`, company: p-[e:company]-> node { name: e.`name` } }',
        '  })',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme', summary: 'Ada' } },
    ]);
  });

  it('a `lazy` BINDING with a tail yields mapped landings a block fans out', async () => {
    const email = makeFakeAdapter('email', {
      related: { files: [{ filename: 'a.pdf' }, { filename: 'b.pdf' }] },
    });
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  files = lazy msg-[a:files]-> node { label: a.`filename` }',
        '  write crm-[:companies]-> { name: JOIN(files.label, ", ") }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'a.pdf, b.pdf' } },
    ]);
  });

  it('hopping PAST a lazy mapped edge continues on the TAIL’s plane, not the source’s', async () => {
    // The hop after `people` is `company`, which the MAPPING declared — past
    // the tail we are inside the synthesised tree, so the source's own edge of
    // that name is never consulted.
    const attio = makeFakeAdapter('attio', {
      related: { people: [{ name: 'Ada' }], company: [{ name: 'Wrong' }] },
    });
    const email = makeFakeAdapter('email');

    await run(
      [
        'node Roster {',
        '  title: <text>',
        '  node people {',
        '    name: <text>',
        '    node company {',
        '      name: <text>',
        '    }',
        '  }',
        '}',
        '',
        'movement persist(r: <Roster>) {',
        '  crm = attio(credentials: acme_main)',
        '  r-[:people]->-[c:company]-> {',
        '    write crm-[:companies]-> { name: c.`name` }',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  persist(r: node {',
        '    title: "x"',
        '    people: lazy crm-[p:people]-> node { name: p.`name`, company: node { name: "Acme" } }',
        '  })',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([{ recordType: 'company', fields: { name: 'Acme' } }]);
  });
});

describe('a park carries the MAPPING, not what it mapped', () => {
  it('the parked edge holds the walk AND the tail literal — no landings', async () => {
    const email = makeFakeAdapter('email', { related: { files: [{ filename: 'a.pdf' }] } });
    const attio = makeFakeAdapter('attio');
    const callbacks = makeFakeCallbackSink();

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  d = node { title: "x", files: lazy msg-[a:files]-> node { label: a.`filename` } }',
        '  cb = callback({ write crm-[:companies]-> { name: d.title } })',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter, callbacks },
    );

    const node = callbacks.mints[0].state.scopeChain
      .flatMap((scope) => Object.entries(scope.bindings))
      .find(([name]) => name === 'd')?.[1];
    if (node?.kind !== 'nodePosition') throw new Error('expected the node to survive the park');
    const edge = node.edges.files;
    if (edge.kind !== 'deferred') throw new Error('expected the edge to park deferred');
    expect(edge.walk.head.hopsRaw).toBe('-[a:files]->');
    expect(edge.walk.mapping?.entries.map((e) => e.name)).toEqual(['label']);
    // Nothing was walked, and nothing was synthesised, to park it.
    expect(email.relatedCalls.count).toBe(0);
    expect(() => JSON.stringify(callbacks.mints[0].state)).not.toThrow();
  });

  it('a RESUMED run re-walks and re-maps — the recipe survived, the answers did not', async () => {
    const SOURCE =
      [
        'node Bag {',
        '  title: <text>',
        '  node files {',
        '    label: <text>',
        '  }',
        '}',
        '',
        'movement record_names(d: <Bag>) {',
        '  crm = attio(credentials: acme_main)',
        '  d-[f:files]-> {',
        '    write crm-[:companies]-> { name: f.`label` }',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  d = node { title: "x", files: lazy msg-[a:files]-> node { label: a.`filename` } }',
        '  write crm-[:companies]-> { name: d.title }',
        '  await sleep(30d)',
        '  record_names(d: d)',
        '}',
      ].join('\n');

    // A `sleep` before the call parks the run there.
    const { sink, timerParks } = makeFakeParkSink();
    const email0 = makeFakeAdapter('email', { related: { files: [{ filename: 'before.pdf' }] } });
    const attio0 = makeFakeAdapter('attio');
    const parked = await run(SOURCE, {}, {
      email: email0.adapter,
      attio: attio0.adapter,
      parkSink: sink,
    });

    expect(parked.parked).toBe(true);
    expect(attio0.creates.map((w) => w.fields.name)).toEqual(['x']);
    // The deferred edge never walked before the park.
    expect(email0.relatedCalls.count).toBe(0);
    const state = JSON.parse(JSON.stringify(timerParks[0].state)) as ParkedScopeState;

    // Resume against a source that has MOVED ON. The mapping came back as AST
    // and runs against what the source says now — which is the whole point of
    // parking the recipe rather than its answers.
    const email1 = makeFakeAdapter('email', { related: { files: [{ filename: 'after.pdf' }] } });
    const attio1 = makeFakeAdapter('attio');
    const result = await resume(SOURCE, {}, { email: email1.adapter, attio: attio1.adapter }, state);

    expect(result.parked).toBeUndefined();
    expect(attio1.creates.map((w) => w.fields.name)).toEqual(['after.pdf']);
  });
});

// ── `IS <Doc>` against a synthesised subject (layer 10 §D) ──────────────────
//
// A node literal's structure is complete where it is written, so the predicate
// is decidable at check time — and the run has to agree with that answer,
// which is the whole reason both sides go through one comparator. Nothing here
// reads data: a declared entry holding null is still an entry.

describe('IS against a declared node — a synthesised subject', () => {
  const DECLS = [
    'node Note {',
    '  title: <text>',
    '  body: <text>',
    '}',
    '',
    'node Titled {',
    '  title: <text>',
    '}',
    '',
    'node Filed {',
    '  title: <text>',
    '  node file {',
    '    label: <text>',
    '  }',
    '}',
    '',
  ].join('\n');

  const intake = (body: string[]): string =>
    DECLS
    + [
      'movement intake(msg: <inbox-[:message]->>) {',
      '  crm = attio(credentials: acme_main)',
      ...body,
      '}',
    ].join('\n');

  /** The names written, in order — the arm each subject took. */
  async function names(body: string[], payload: Record<string, unknown> = {}): Promise<unknown[]> {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await run(intake(body), payload, { email: email.adapter, attio: attio.adapter });
    return attio.creates.map((w) => w.fields.name);
  }

  const branch = (test: string): string[] => [
    `  if ${test} {`,
    '    write crm-[:companies]-> { name: "arm" }',
    '  } else {',
    '    write crm-[:companies]-> { name: "else" }',
    '  }',
  ];

  it('a literal carrying every declared entry takes the arm', async () => {
    expect(
      await names(['  d = node { title: "t", body: "b" }', ...branch('d IS <Note>')]),
    ).toEqual(['arm']);
  });

  it('a literal missing a declared entry takes the else', async () => {
    expect(await names(['  d = node { title: "t" }', ...branch('d IS <Note>')])).toEqual(['else']);
  });

  it('EXTRA entries are fine — conformance is structural, not exact', async () => {
    expect(
      await names(['  d = node { title: "t", body: "b" }', ...branch('d IS <Titled>')]),
    ).toEqual(['arm']);
  });

  it('a supplied EDGE still has its target checked', async () => {
    expect(
      await names([
        '  d = node { title: "t", file: node { label: "deck.pdf" } }',
        ...branch('d IS <Filed>'),
      ]),
    ).toEqual(['arm']);
  });

  it('a missing declared edge conforms too — edges are zero-or-more, absence is the empty set', async () => {
    expect(await names(['  d = node { title: "t" }', ...branch('d IS <Filed>')])).toEqual([
      'arm',
    ]);
  });

  // A REAL position's surface is what it DECLARES, so a null field is still a
  // field. A synthesised one has no schema behind it — its surface is what the
  // literal produced — and the language already rules that an entry evaluating
  // to nothing is ABSENT rather than present-and-empty, so the same one story
  // the read plane tells is the one the predicate tells.
  it('an entry that evaluated to nothing is absent here too — one story about a missing value', async () => {
    expect(
      await names(
        ['  d = node { title: "t", body: msg.`text` }', ...branch('d IS <Note>')],
        { subject: 'x', text: 'a deck' },
      ),
    ).toEqual(['arm']);
    expect(
      await names(
        ['  d = node { title: "t", body: msg.`text` }', ...branch('d IS <Note>')],
        { subject: 'x' },
      ),
    ).toEqual(['else']);
  });

  it("a CALL's value is a node like any other, so it answers the same test", async () => {
    const source =
      DECLS
      + [
        'movement make(m: <inbox-[:message]->>) {',
        '  return node { title: m.`subject`, body: m.`text` }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  d = make(m: msg)',
        ...branch('d IS <Note>'),
        '}',
      ].join('\n');
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await run(source, { subject: 'Acme', text: 'a deck' }, {
      email: email.adapter,
      attio: attio.adapter,
    });
    expect(attio.creates.map((w) => w.fields.name)).toEqual(['arm']);
  });
});

describe('a bare-name binding of a node is an ALIAS at run time (2026-08-05 ruling)', () => {
  function attachment(name: string) {
    return { filename: name };
  }

  it("an alias RETURNED from a block is the block's value, landing the REAL positions", async () => {
    const email = makeFakeAdapter('email', {
      related: { files: [attachment('a.pdf'), attachment('b.pdf')] },
    });
    const dropbox = makeFakeAdapter('dropbox');

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  drive = dropbox(credentials: team_drive)',
        '  x = msg-[a:files]-> {',
        '    doc = a',
        '    return doc',
        '  }',
        '  write drive-[:file]-> {',
        '    name: x.`filename`',
        '  }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, dropbox: dropbox.adapter },
    );

    // The block returned the aliased SOURCE positions, so reading a field off
    // its value reads through the real adapter, once per landing — before the
    // alias rule the binding collapsed to a value and the read found nothing.
    expect(dropbox.creates.map((w) => w.fields.name)).toEqual(['a.pdf, b.pdf']);
  });

  it('a top-level alias reads like the original', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    const result = await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  m2 = msg',
        '  write crm-[:companies]-> {',
        '    name: m2.`subject`',
        '  }',
        '}',
      ].join('\n'),
      { subject: 'Acme Corp' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([{ recordType: 'company', fields: { name: 'Acme Corp' } }]);
    // The trail still cites the event field — the alias added no origin.
    expect(result.writes[0].provenance.name).toEqual([
      { kind: 'source_field', instance: 'inbox', adapterType: 'email', field: 'subject' },
    ]);
  });
});

describe("a bound block's returned VALUES read as an array", () => {
  // The read yields the array; what lands on the adapter then follows the
  // existing single-cardinality write rule (`coerceValueForFieldCardinality`):
  // a non-json single field CSV-joins the array, a json or cardinality-many
  // field keeps it. The fake adapter describes no fields, so the join applies
  // — each output below is derivable ONLY from an always-array read (zero
  // iterations join to '', one to the bare name, N to the comma list).
  function file(name: string) {
    return { filename: name };
  }

  async function runReadingNames(files: Array<{ filename: string }>) {
    const email = makeFakeAdapter('email', { related: { files } });
    const attio = makeFakeAdapter('attio');
    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  x = msg-[a:files]-> {',
        '    return a.`filename`',
        '  }',
        '  write crm-[:companies]-> {',
        '    name: "batch"',
        '    summary: x',
        '  }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );
    return attio.creates[0]?.fields.summary;
  }

  it('N iterations read as an N-element array (joined by the text field)', async () => {
    expect(await runReadingNames([file('a.pdf'), file('b.pdf')])).toEqual('a.pdf, b.pdf');
  });

  it('ONE iteration still reads as a 1-element array — cardinality is stable', async () => {
    expect(await runReadingNames([file('only.pdf')])).toEqual('only.pdf');
  });

  it('ZERO iterations read as the empty array, not null — the field writes empty', async () => {
    expect(await runReadingNames([])).toEqual('');
  });
});

describe('the combinators — arms, ties and slots (sync paths)', () => {
  it('two arms settling in one burst is a TIE — both slots are filled', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  r = await race([',
        '    () => { return "first" },',
        '    () => { return "second" },',
        '  ])',
        '  write crm-[:companies]-> {',
        '    name: "done"',
        '    summary: "${AT(r, 0)}/${AT(r, 1)}"',
        '  }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );
    // Neither arm suspended, so both settled inside the same running burst —
    // simultaneous, and more than one filled slot is legal.
    expect(attio.creates[0]?.fields.summary).toBe('first/second');
  });

  it('an arm that hands nothing back is a null slot, whichever combinator ran', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  r = await parallel([',
        '    () => { return "value" },',
        '    () => { done = "acted" },',
        '  ])',
        '  write crm-[:companies]-> {',
        '    name: "done"',
        '    summary: COALESCE(AT(r, 1), "empty")',
        '    domains: [AT(r, 0)]',
        '  }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );
    expect(attio.creates[0]?.fields.summary).toBe('empty');
    expect(attio.creates[0]?.fields.domains).toBe('value');
  });

  it('a race over no arms can never settle, and says so at run time', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await expect(
      run(
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  arms = []',
          '  r = await race(arms)',
          '}',
        ].join('\n'),
        {},
        { email: email.adapter, attio: attio.adapter },
      ),
    ).rejects.toThrow(/can never settle/);
  });

  it('a parallel over no arms ran nothing, and the run proceeds', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  arms = []',
        '  r = await parallel(arms)',
        '  write crm-[:companies]-> { name: "after" }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );
    expect(attio.creates.map((w) => w.fields.name)).toEqual(['after']);
  });
});

// ── The appendable run-local node ───────────────────────────────────────────
//
// A declared edge starts empty and `link` appends landings to it, so branches
// that each write a different number of records can be acted on together
// afterwards. What is worth pinning: the landings arrive in PROGRAM ORDER,
// they keep their own kind (a write off one is the ordinary linked write),
// an untouched edge traverses as empty, and a park carries what was appended.

/** The attio fake, plus the parent link each create carried — how a write off
 *  an APPENDED landing proves it reached the right record. */
function makeParentRecordingAttio(): {
  adapter: Adapter;
  creates: RecordedWrite[];
  children: Array<{ recordType: string; parent?: string; edge?: string }>;
} {
  const base = makeFakeAdapter('attio');
  const children: Array<{ recordType: string; parent?: string; edge?: string }> = [];
  const adapter: Adapter = {
    ...base.adapter,
    async createRecord(input) {
      const parent = (input.parentLinks ?? [])[0];
      children.push({
        recordType: input.recordType,
        ...(parent ? { parent: parent.externalId, edge: parent.edgeName } : {}),
      });
      return base.adapter.createRecord(input);
    },
  };
  return { adapter, creates: base.creates, children };
}

describe('a declared edge grows by `link`', () => {
  it('two branches append, and the traversal afterwards sees both in program order', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeParentRecordingAttio();

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  sent = node { posted: <crm-[:companies]->> }',
        '  if (msg.`subject` == "both") {',
        '    one = write crm-[:companies]-> { name: "a" }',
        '    link sent -[:posted]-> one',
        '    two = write crm-[:companies]-> { name: "b" }',
        '    link sent -[:posted]-> two',
        '  } else {',
        '    three = write crm-[:companies]-> { name: "c" }',
        '    link sent -[:posted]-> three',
        '  }',
        '  sent-[c:posted]-> {',
        '    write c-[:investments]-> { amount: 1 }',
        '  }',
        '}',
      ].join('\n'),
      { subject: 'both' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((w) => w.fields.name)).toEqual(['a', 'b', undefined, undefined]);
    // One investment per landing, each attached to the company it was linked
    // from — and in the order the links ran.
    expect(attio.children.filter((c) => c.recordType === 'investment')).toEqual([
      { recordType: 'investment', parent: 'ext-attio-1', edge: 'investments' },
      { recordType: 'investment', parent: 'ext-attio-2', edge: 'investments' },
    ]);
  });

  it('the arm that did NOT run appended nothing', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeParentRecordingAttio();

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  sent = node { posted: <crm-[:companies]->> }',
        '  if (msg.`subject` == "both") {',
        '    one = write crm-[:companies]-> { name: "a" }',
        '    link sent -[:posted]-> one',
        '  } else {',
        '    two = write crm-[:companies]-> { name: "b" }',
        '    link sent -[:posted]-> two',
        '  }',
        '  sent-[c:posted]-> {',
        '    write c-[:investments]-> { amount: 1 }',
        '  }',
        '}',
      ].join('\n'),
      { subject: 'one' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((w) => w.fields.name)).toEqual(['b', undefined]);
    expect(attio.children.filter((c) => c.recordType === 'investment')).toEqual([
      { recordType: 'investment', parent: 'ext-attio-1', edge: 'investments' },
    ]);
  });

  it('an edge nothing linked traverses as empty, and COUNT over it is 0', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  sent = node { posted: <crm-[:companies]->> }',
        '  sent-[c:posted]-> {',
        '    write c-[:investments]-> { amount: 1 }',
        '  }',
        '  write crm-[:companies]-> { name: COUNT(sent-[:posted]->) }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([{ recordType: 'company', fields: { name: 0 } }]);
  });

  it('a park carries the appended landings — the handle survives it', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const callbacks = makeFakeCallbackSink();

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  sent = node { posted: <crm-[:companies]->> }',
        '  one = write crm-[:companies]-> { name: "a" }',
        '  link sent -[:posted]-> one',
        '  cb = callback({ write crm-[:companies]-> { name: "after" } })',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter, callbacks },
    );

    const node = callbacks.mints[0].state.scopeChain
      .flatMap((scope) => Object.entries(scope.bindings))
      .find(([name]) => name === 'sent')?.[1];
    if (node?.kind !== 'nodePosition') throw new Error('expected the node to survive the park');
    const edge = node.edges.posted;
    if (edge.kind !== 'landed') throw new Error('expected the edge to park landed');
    expect(edge.landings).toHaveLength(1);
    expect(edge.landings[0].kind).toBe('handle');
    expect(() => JSON.stringify(callbacks.mints[0].state)).not.toThrow();
  });
});

// The same appendable edge, typed by a DECLARED NODE instead of an address:
// `<Company>` says what the landings CARRY rather than where they come from.
// Nothing about the run changes — the entry still starts empty, `link` still
// appends in program order, and the traversal afterwards reads the fields the
// declaration named — which is the point: the landing type is a checker-side
// fact, and the interpreter treats landings as values whatever typed them.
describe('a declared edge typed by a declared node', () => {
  const COMPANY = ['node Company {', '  name: <text>', '}', ''].join('\n');

  it('grows by `link` across branches, and the traversal reads the declared field', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await run(
      COMPANY +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  seen = node { companies: <Company> }',
          '  if (msg.`subject` == "both") {',
          '    one = node { name: "a" }',
          '    link seen -[:companies]-> one',
          '    two = node { name: "b" }',
          '    link seen -[:companies]-> two',
          '  } else {',
          '    three = node { name: "c" }',
          '    link seen -[:companies]-> three',
          '  }',
          '  seen-[c:companies]-> {',
          '    write crm-[:companies]-> { name: c.`name` }',
          '  }',
          '}',
        ].join('\n'),
      { subject: 'both' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((w) => w.fields.name)).toEqual(['a', 'b']);
  });

  it('an edge nothing linked traverses as empty', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await run(
      COMPANY +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  seen = node { companies: <Company> }',
          '  seen-[c:companies]-> {',
          '    write crm-[:companies]-> { name: c.`name` }',
          '  }',
          '  write crm-[:companies]-> { name: COUNT(seen-[:companies]->) }',
          '}',
        ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([{ recordType: 'company', fields: { name: 0 } }]);
  });
});
