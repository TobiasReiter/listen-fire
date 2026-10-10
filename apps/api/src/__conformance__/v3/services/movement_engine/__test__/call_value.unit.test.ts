// Engine coverage for CALL VALUES — a call's value is the node the callee's
// top-level bindings make (layer 10 §A).
//
// The three probes that matter are the ones the value has to survive:
//   1. the UTILITY IDIOM end to end — a shaping movement's value handed to a
//      writing one, with the wave-3 assertions (FileRef identity, source
//      provenance) now taken THROUGH a call boundary;
//   2. a WRITE HANDLE bound by the callee, read as an edge off the value —
//      its landing reads exactly as it does anywhere;
//   3. PARK/RESUME while the caller holds a LAZY binding returned from a call
//      — the recipe crosses back, and a resumed run re-walks the live source.
//
// Harness mirrors node_synthesis.unit.test.ts (the waves this stands on).

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

const TEAM_ID = '00000000-0000-0000-0000-000000000021' as TeamId;

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
    pipelineInputId: 'pi-call-values',
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
    ...(adapters.parkSink ? { parkSink: adapters.parkSink } : {}),
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


// ── Probe 1: the utility idiom, end to end ───────────────────────────────────

describe('the utility idiom — one movement shapes, another writes', () => {
  // The shaper RETURNS a node with a field (`title`) and a lazy edge (`files`)
  // — multi-export is an ordinary node literal, handed back. Its parameter `m`
  // is the caller's data and is not part of what it returns.
  const SHAPER = [
    'movement email_to_doc(m: <inbox-[:message]->>) {',
    '  return node {',
    '    title: m.`subject`',
    '    files: lazy m-[a:files]-> node { name: a.`filename`, blob: a.`data` }',
    '  }',
    '}',
    '',
  ].join('\n');

  const WRITER = [
    'node Doc {',
    '  title: <text>',
    '  node files {',
    '    name: <text>',
    '    blob: <file>',
    '  }',
    '}',
    '',
    'movement log_doc(d: <Doc>) {',
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
          throw new Error('test: a call value must never pull the bytes');
        },
      } as unknown as FileRef,
    };
  }

  const INTAKE = [
    'movement intake(msg: <inbox-[:message]->>) {',
    '  doc = email_to_doc(m: msg)',
    '  log_doc(d: doc)',
    '}',
  ].join('\n');

  it("the callee's bindings ARE the value: FileRef identity and source provenance survive the call", async () => {
    const deck = attachment('pitch.pdf');
    const email = makeFakeAdapter('email', { related: { files: [deck] } });
    const dropbox = makeFakeAdapter('dropbox');

    const result = await run(SHAPER + WRITER + INTAKE, { subject: 'Series A' }, {
      email: email.adapter,
      dropbox: dropbox.adapter,
    });

    expect(dropbox.creates).toHaveLength(1);
    // The shaper's names reached the writer — which never learned the source's.
    expect(dropbox.creates[0].fields.filename).toBe('pitch.pdf');
    // IDENTITY: the handle the SOURCE produced is the handle the writer wrote.
    // Crossing a call boundary renamed nothing and copied nothing.
    expect(dropbox.creates[0].fields.data).toBe(deck.data);

    // The trail names the real source read. A call's value is its bindings, and
    // each binding still carries the provenance of the expression that made it.
    expect(result.writes[0].provenance.data).toEqual([
      { kind: 'source_field', instance: 'inbox', adapterType: 'email', field: 'data' },
    ]);
    expect(result.writes[0].provenance.filename).toEqual([
      { kind: 'source_field', instance: 'inbox', adapterType: 'email', field: 'filename' },
    ]);
    // Synthesising the value is not an effect — one write, the writer's own.
    expect(result.writes).toHaveLength(1);
  });

  it('the value is passed on DIRECTLY, without a name in between', async () => {
    const email = makeFakeAdapter('email', { related: { files: [attachment('deck.pdf')] } });
    const dropbox = makeFakeAdapter('dropbox');

    await run(
      SHAPER + WRITER + [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  log_doc(d: email_to_doc(m: msg))',
        '}',
      ].join('\n'),
      { subject: 'Series A' },
      { email: email.adapter, dropbox: dropbox.adapter },
    );

    expect(dropbox.creates.map((w) => w.fields.filename)).toEqual(['deck.pdf']);
  });

  it("the scalar binding reads by DOT off the value", async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await run(
      SHAPER + [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  doc = email_to_doc(m: msg)',
        '  write crm-[:companies]-> { name: doc.title }',
        '}',
      ].join('\n'),
      { subject: 'Acme Corp' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([{ recordType: 'company', fields: { name: 'Acme Corp' } }]);
  });

  it('the VALUE carries what the body made, and nothing else', async () => {
    // The shaper's scope holds a parameter (`m`), a constructed instance
    // (`crm`), a scalar (`title`) and a lazy position (`files`). Only the last
    // two are records the body made — the rest is the caller's data and
    // configuration. Read off the parked value, which is the shape itself.
    const email = makeFakeAdapter('email', { related: { files: [{ filename: 'a.pdf' }] } });
    const attio = makeFakeAdapter('attio');
    const callbacks = makeFakeCallbackSink();

    await run(
      [
        'movement shape_it(m: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  return node {',
        '    title: m.`subject`',
        '    files: lazy m-[a:files]-> node { name: a.`filename` }',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  doc = shape_it(m: msg)',
        '  cb = callback({ write crm-[:companies]-> { name: doc.title } })',
        '}',
      ].join('\n'),
      { subject: 'Acme Corp' },
      { email: email.adapter, attio: attio.adapter, callbacks },
    );

    const value = callbacks.mints[0].state.scopeChain
      .flatMap((scope) => Object.entries(scope.bindings))
      .find(([name]) => name === 'doc')?.[1];
    if (value?.kind !== 'nodePosition') {
      throw new Error("expected the call's value to survive the park");
    }
    expect(Object.keys(value.fields)).toEqual(['title']);
    expect(Object.keys(value.edges)).toEqual(['files']);
  });
});

// ── Probe 2: a write handle bound by the callee, read as an edge ─────────────

describe('a write-handle binding is an edge off the value', () => {
  const SOURCE = [
    'movement make_company(m: <inbox-[:message]->>) {',
    '  crm = attio(credentials: acme_main)',
    '  return write crm-[:companies]-> {',
    '    name: m.`subject`',
    '  }',
    '}',
    '',
    'movement intake(msg: <inbox-[:message]->>) {',
    '  drive = dropbox(credentials: team_drive)',
    '  c = make_company(m: msg)',
    '  write drive-[:file]-> {',
    '    filename: c.`name`',
    '    data: c.`externalId`',
    '  }',
    '}',
  ].join('\n');

  it("the handle's landing reads as it does anywhere — written values and specials alike", async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const dropbox = makeFakeAdapter('dropbox');

    const result = await run(SOURCE, { subject: 'Acme Corp' }, {
      email: email.adapter,
      attio: attio.adapter,
      dropbox: dropbox.adapter,
    });

    // The callee's write ran (effects are unchanged — the value is additional).
    expect(attio.creates).toEqual([{ recordType: 'company', fields: { name: 'Acme Corp' } }]);
    // …and its handle came back as an edge of the value, read on both surfaces.
    expect(dropbox.creates).toHaveLength(1);
    expect(dropbox.creates[0].fields.filename).toBe('Acme Corp');
    expect(dropbox.creates[0].fields.data).toBe('ext-attio-1');
    // Two effects, in order: the callee's create, then the caller's.
    expect(result.writes).toHaveLength(2);
  });
});

// ── Probe 3: park / resume across a lazy binding returned from a call ────────

describe("a park carries a call value's deferred walk, not what it walked to", () => {
  const SHAPER = [
    'movement email_to_doc(m: <inbox-[:message]->>) {',
    '  return node {',
    '    title: m.`subject`',
    '    files: lazy m-[a:files]-> node { name: a.`filename` }',
    '  }',
    '}',
    '',
  ].join('\n');

  it('the parked value holds the WALK — no landings, nothing walked', async () => {
    const email = makeFakeAdapter('email', { related: { files: [{ filename: 'a.pdf' }] } });
    const attio = makeFakeAdapter('attio');
    const callbacks = makeFakeCallbackSink();

    await run(
      SHAPER + [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  doc = email_to_doc(m: msg)',
        '  cb = callback({ write crm-[:companies]-> { name: doc.title } })',
        '}',
      ].join('\n'),
      { subject: 'x' },
      { email: email.adapter, attio: attio.adapter, callbacks },
    );

    const value = callbacks.mints[0].state.scopeChain
      .flatMap((scope) => Object.entries(scope.bindings))
      .find(([name]) => name === 'doc')?.[1];
    if (value?.kind !== 'nodePosition') {
      throw new Error("expected the call's value to survive the park");
    }
    // The scalar binding parked as a field; the lazy one as the RECIPE.
    expect(value.fields.title).toBe('x');
    const edge = value.edges.files;
    if (edge.kind !== 'deferred') throw new Error('expected the edge to park deferred');
    expect(edge.walk.head.hopsRaw).toBe('-[a:files]->');
    expect(edge.walk.mapping?.entries.map((e) => e.name)).toEqual(['name']);
    // The callee's scope outlives the call for the walk's purposes: the walk's
    // root resolves against what it captured THERE, and it captured it whole.
    expect(email.relatedCalls.count).toBe(0);
    expect(() => JSON.stringify(callbacks.mints[0].state)).not.toThrow();
  });

  it('a RESUMED caller re-walks the live source through the call value', async () => {
    const SOURCE = SHAPER + [
      'node Bag {',
      '  title: <text>',
      '  node files {',
      '    name: <text>',
      '  }',
      '}',
      '',
      'movement record_names(d: <Bag>) {',
      '  crm = attio(credentials: acme_main)',
      '  d-[f:files]-> {',
      '    write crm-[:companies]-> { name: f.`name` }',
      '  }',
      '}',
      '',
      'movement intake(msg: <inbox-[:message]->>) {',
      '  crm = attio(credentials: acme_main)',
      '  doc = email_to_doc(m: msg)',
      '  write crm-[:companies]-> { name: doc.title }',
      '  await sleep(30d)',
      '  record_names(d: doc)',
      '}',
    ].join('\n');

    // A `sleep` before the second call parks the run there.
    const { sink, timerParks } = makeFakeParkSink();
    const email0 = makeFakeAdapter('email', { related: { files: [{ filename: 'before.pdf' }] } });
    const attio0 = makeFakeAdapter('attio');
    const parked = await run(SOURCE, { subject: 'x' }, {
      email: email0.adapter,
      attio: attio0.adapter,
      parkSink: sink,
    });

    expect(parked.parked).toBe(true);
    expect(attio0.creates.map((w) => w.fields.name)).toEqual(['x']);
    expect(email0.relatedCalls.count).toBe(0);
    const state = JSON.parse(JSON.stringify(timerParks[0].state)) as ParkedScopeState;

    // Resume against a source that has MOVED ON — the recipe came back, so the
    // walk answers what the source says NOW.
    const email1 = makeFakeAdapter('email', { related: { files: [{ filename: 'after.pdf' }] } });
    const attio1 = makeFakeAdapter('attio');
    const result = await resume(SOURCE, { subject: 'x' }, {
      email: email1.adapter,
      attio: attio1.adapter,
    }, state);

    expect(result.parked).toBeUndefined();
    expect(attio1.creates.map((w) => w.fields.name)).toEqual(['after.pdf']);
  });
});

// ── Probe 4: a CLOSURE crosses a park ────────────────────────────────────────
//
// A closure is (AST, captured bindings). Both halves have to survive the wire:
// the body rides across as itself (it has no name to re-resolve by), and the
// capture serialises like any other scope. The proof is a run that parks with a
// closure in scope, resumes, and CALLS it — the only place wave 2a can call one
// is an `until` condition, which is what makes this the real path rather than a
// serializer unit test.

describe('a closure survives park → resume and is still callable', () => {
  const SOURCE = [
    'movement intake(msg: <inbox-[:message]->>) {',
    '  crm = attio(credentials: acme_main)',
    '  subject = msg.`subject`',
    '  ready = () => {',
    '    return subject == "go"',
    '  }',
    '  await sleep(30d)',
    '  await until(ready, every: 1h)',
    '  write crm-[:companies]-> { name: subject }',
    '}',
  ].join('\n');

  it('parks with the closure in scope — its body as AST, its capture as bindings', async () => {
    const { sink, timerParks } = makeFakeParkSink();
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    const parked = await run(SOURCE, { subject: 'go' }, {
      email: email.adapter,
      attio: attio.adapter,
      parkSink: sink,
    });

    expect(parked.parked).toBe(true);
    const stored = timerParks[0].state.scopeChain
      .flatMap((scope) => Object.entries(scope.bindings))
      .find(([name]) => name === 'ready')?.[1];
    if (stored?.kind !== 'closure') throw new Error('expected the closure to park');
    expect(stored.closure.body.map((s) => s.kind)).toEqual(['return']);
    // The capture came with it — that is what makes `subject` readable a month
    // later, in another process.
    expect(stored.captured.subject).toEqual(
      expect.objectContaining({ kind: 'value', value: 'go' }),
    );
    // And the whole thing is durable data, not a live object.
    expect(() => JSON.stringify(timerParks[0].state)).not.toThrow();
  });

  it('resumes, calls the rehydrated closure, and continues on what it returned', async () => {
    const { sink, timerParks } = makeFakeParkSink();
    const email0 = makeFakeAdapter('email');
    const attio0 = makeFakeAdapter('attio');
    await run(SOURCE, { subject: 'go' }, {
      email: email0.adapter,
      attio: attio0.adapter,
      parkSink: sink,
    });
    const state = JSON.parse(JSON.stringify(timerParks[0].state)) as ParkedScopeState;

    const email1 = makeFakeAdapter('email');
    const attio1 = makeFakeAdapter('attio');
    const { sink: sink1 } = makeFakeParkSink();
    await resume(SOURCE, { subject: 'go' }, {
      email: email1.adapter,
      attio: attio1.adapter,
      parkSink: sink1,
    }, state);

    // The condition held on the CAPTURED value, so the run walked past the
    // `until` and did the work after it.
    expect(attio1.creates.map((w) => w.fields.name)).toEqual(['go']);
  });

  it('a rehydrated closure whose condition does NOT hold re-parks', async () => {
    const { sink, timerParks } = makeFakeParkSink();
    const email0 = makeFakeAdapter('email');
    const attio0 = makeFakeAdapter('attio');
    await run(SOURCE, { subject: 'wait' }, {
      email: email0.adapter,
      attio: attio0.adapter,
      parkSink: sink,
    });
    const state = JSON.parse(JSON.stringify(timerParks[0].state)) as ParkedScopeState;

    const email1 = makeFakeAdapter('email');
    const attio1 = makeFakeAdapter('attio');
    const { sink: sink1, timerParks: reparks } = makeFakeParkSink();
    await resume(SOURCE, { subject: 'wait' }, {
      email: email1.adapter,
      attio: attio1.adapter,
      parkSink: sink1,
    }, state);

    // Re-armed at the `until`, and nothing past it ran.
    expect(reparks).toHaveLength(1);
    expect(attio1.creates).toHaveLength(0);
  });
});
