// Engine coverage for graph literals — `graph<Shape> { … }` / `graph { … }`.
//
// A graph literal builds a LOCAL GRAPH: the same run-local node a node literal
// makes, so paths, WHERE, writes and links on it are the local graph's own.
// Its entries follow TypeScript's object semantics: a bare walk or a record
// holds REFERENCES (reads live, writes reach the real record), while a walk
// with a field body or a record spread is a SNAPSHOT — and a file is copied as
// the handle it is. Mirrors the harness of node_synthesis.unit.test.ts.

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
import { makeStablePosition, makeUnstablePosition, positionData } from '../../translation_graph/types';
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

// The inbox is TYPED here (the thin fixture leaves email untyped), so a graph
// literal's shape check has teeth — and its attachments are updatable in
// place, so a write through a reference has a real record to reach.
const catalog = staticCatalogFromManifests({
  credentials: {
    dealflow_inbox: { adapters: ['email'] },
    team_drive: { adapters: ['dropbox'] },
    acme_main: { adapters: ['attio'] },
  },
  instanceSchemas: {
    email: {
      positions: {
        message: {
          properties: { subject: 'text', text: 'text', payload: 'json' },
          edges: { files: { target: 'attachment', readable: true, sequenced: 'document' } },
        },
        attachment: {
          properties: { filename: 'text', contentType: 'text', data: 'file' },
          edges: { versions: { target: 'version', readable: true } },
        },
        version: { properties: { label: 'text' }, edges: {} },
      },
      collections: { message: { target: 'message' } },
      supportsInPlaceUpdate: true,
      writableRoots: {
        attachment: {
          fields: { filename: 'text', contentType: 'text' },
          resultShape: { externalId: 'text', filename: 'text', contentType: 'text' },
        },
      },
    },
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


// ── Graph literals ───────────────────────────────────────────────────────────

const MESSAGE = [
  'node Message: "a message in a common format" {',
  '  text: <text>',
  '  node attachment: "each file attached" {',
  '    name: <text | null>',
  '    type: <text>',
  '    file: <file>',
  '  }',
  '}',
  '',
  'movement from_email(m: <inbox-[:message]->>) {',
  '  return graph<Message> {',
  '    text: m.subject,',
  '    attachment: m-[a:files]-> { name: a.filename, type: a.contentType, file: a.`data` },',
  '  }',
  '}',
  '',
].join('\n');

function attachment(filename: string, contentType: string) {
  return {
    filename,
    contentType,
    data: {
      __brand: 'FileRef',
      name: filename,
      contentType,
      retrieve: async () => {
        throw new Error('test: building a graph must never pull the bytes');
      },
    } as unknown as FileRef,
  };
}

describe('graph<Shape> — the worked example', () => {
  it('builds a Message from an email; the caller reads it by path, WHERE and dot', async () => {
    const deck = attachment('deck.pdf', 'application/pdf');
    const photo = attachment('photo.png', 'image/png');
    const email = makeFakeAdapter('email', { related: { files: [deck, photo] } });
    const dropbox = makeFakeAdapter('dropbox');

    const result = await run(
      MESSAGE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  drive = dropbox(credentials: team_drive)',
          '  m = from_email(m: msg)',
          '  m-[a:attachment WHERE a.type = "application/pdf"]-> {',
          '    write drive-[:file]-> {',
          '      filename: m.text',
          '      data: a.file',
          '    }',
          '  }',
          '}',
        ].join('\n'),
      { subject: 'Series A' },
      { email: email.adapter, dropbox: dropbox.adapter },
    );

    // The WHERE kept the one PDF, and its file is the SAME handle the source
    // produced: a file is copied as the lazy handle it is, nothing downloads.
    expect(dropbox.creates).toHaveLength(1);
    expect(dropbox.creates[0].fields).toEqual({ filename: 'Series A', data: deck.data });
    // The trail survives the snapshot: the copied file still cites its source.
    expect(result.writes.at(-1)?.provenance.data).toEqual([
      { kind: 'source_field', instance: 'inbox', adapterType: 'email', field: 'data' },
    ]);
  });

  it('a WHERE over the result in an expression reads the kept records', async () => {
    const email = makeFakeAdapter('email', {
      related: { files: [attachment('a.pdf', 'application/pdf'), attachment('b.png', 'image/png')] },
    });
    const attio = makeFakeAdapter('attio');

    await run(
      MESSAGE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  m = from_email(m: msg)',
          '  write crm-[:companies]-> {',
          '    name: m.text',
          '    summary: COALESCE(ONLY(m-[a:attachment WHERE a.type = "application/pdf"]->.name), "none")',
          '  }',
          '}',
        ].join('\n'),
      { subject: 'Acme' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme', summary: 'a.pdf' } },
    ]);
  });
});

// ── References: TypeScript's object semantics ──────────────────────────────
//
// A bare walk or a record written as an entry's value holds the RECORDS
// THEMSELVES, as `{ items: obj }` holds `obj`: reads through the graph are
// live, and a write through it reaches the real record. A walk with a field
// body and a record spread copy, as `{ ...obj }` does.

/** A source whose attachments are real records — stable ids, fields read live
 *  from a store the test can change under the run, and updatable in place. */
function makeLiveInbox(files: Record<string, Record<string, unknown>>): {
  adapter: Adapter;
  store: Record<string, Record<string, unknown>>;
  updates: RecordedWrite[];
  creates: RecordedWrite[];
} {
  const store = files;
  const updates: RecordedWrite[] = [];
  const creates: RecordedWrite[] = [];
  const adapter: Adapter = {
    adapterType: 'email',
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
      if (position.identity.kind === 'stable') return store[position.identity.recordId]?.[fieldId];
      return (positionData(position) as Record<string, unknown> | undefined)?.[fieldId];
    },
    async getRelated({ fieldId }) {
      if (fieldId !== 'files') return [];
      return Object.keys(store).map((recordId) => ({
        position: makeStablePosition({ adapterType: 'email', recordType: 'attachment', recordId }),
      }));
    },
    async readRecord({ externalId }) {
      return store[externalId] ?? null;
    },
    async createRecord(input) {
      creates.push({ recordType: input.recordType, fields: input.fields });
      return { adapterType: 'email', externalId: `new-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      updates.push({ recordType: input.recordType, externalId: input.externalId, fields: input.fields });
      Object.assign(store[input.externalId] ?? {}, input.fields);
      return { adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, store, updates, creates };
}

/** An attio fake whose every create first runs `before` — how "the source
 *  changed after the graph was built" is spelled inside one run. */
function attioThatTouches(before: () => void) {
  const attio = makeFakeAdapter('attio');
  const create = attio.adapter.createRecord.bind(attio.adapter);
  attio.adapter.createRecord = async (input) => {
    before();
    return create(input);
  };
  return attio;
}

const ARCHIVE = [
  'node Archive {',
  '  subject: <text>',
  '  node files {',
  '    filename: <text>',
  '  }',
  '}',
  '',
].join('\n');

describe('a bare walk holds references — the records themselves', () => {
  it('reads are live: a change to the source after the graph was built shows through it', async () => {
    const inbox = makeLiveInbox({ a1: { filename: 'x.pdf', contentType: 'application/pdf' } });
    const attio = attioThatTouches(() => {
      inbox.store.a1.filename = 'renamed.pdf';
    });

    await run(
      ARCHIVE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  g = graph<Archive> { subject: msg.subject, files: msg-[:files]-> }',
          '  write crm-[:companies]-> { name: "between" }',
          '  g-[f:files]-> {',
          '    write crm-[:companies]-> { name: f.filename }',
          '  }',
          '}',
        ].join('\n'),
      { subject: 's' },
      { email: inbox.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((c) => c.fields.name)).toEqual(['between', 'renamed.pdf']);
  });

  it('a write to a record reached through the graph updates the real record', async () => {
    const inbox = makeLiveInbox({ a1: { filename: 'x.pdf', contentType: 'application/pdf' } });
    const attio = makeFakeAdapter('attio');

    const result = await run(
      ARCHIVE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  g = graph<Archive> { subject: msg.subject, files: msg-[:files]-> }',
          '  g-[f:files]-> {',
          '    write f { filename: "renamed.pdf" }',
          '  }',
          '  g-[f:files]-> {',
          '    write crm-[:companies]-> { name: f.filename }',
          '  }',
          '}',
        ].join('\n'),
      { subject: 's' },
      { email: inbox.adapter, attio: attio.adapter },
    );

    expect(inbox.updates).toEqual([
      { recordType: 'attachment', externalId: 'a1', fields: { filename: 'renamed.pdf' } },
    ]);
    expect(attio.creates.map((c) => c.fields.name)).toEqual(['renamed.pdf']);
    expect(result.writes[0]).toMatchObject({ adapterType: 'email', externalId: 'a1', committed: true });
  });

  it('a write into the edge that matches a referenced record updates it; a new one stays local', async () => {
    const inbox = makeLiveInbox({ a1: { filename: 'x.pdf', contentType: 'application/pdf' } });
    const attio = makeFakeAdapter('attio');

    const result = await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  g = graph { files: msg-[:files]-> }',
        '  write g-[:files]-> { unique by (filename), filename: "x.pdf", contentType: "application/x-pdf" }',
        '  write g-[:files]-> { unique by (filename), filename: "new.pdf", contentType: "text/plain" }',
        '  g-[f:files]-> {',
        '    write crm-[:companies]-> { name: f.filename, summary: f.contentType }',
        '  }',
        '}',
      ].join('\n'),
      {},
      { email: inbox.adapter, attio: attio.adapter },
    );

    // The match was the real record: only the changed field went to its system.
    expect(inbox.updates).toEqual([
      { recordType: 'attachment', externalId: 'a1', fields: { contentType: 'application/x-pdf' } },
    ]);
    // The new child is the graph's own: nothing was created in the source.
    expect(inbox.creates).toEqual([]);
    expect(attio.creates.map((c) => c.fields)).toEqual([
      { name: 'x.pdf', summary: 'application/x-pdf' },
      { name: 'new.pdf', summary: 'text/plain' },
    ]);
    expect(result.writes.slice(0, 2)).toMatchObject([
      { adapterType: 'email', recordType: 'attachment', externalId: 'a1', committed: true },
      { adapterType: 'local', committed: false, local: { edge: 'files' } },
    ]);
  });

  it('WHERE and MAP over the reference edge read the real records', async () => {
    const inbox = makeLiveInbox({
      a1: { filename: 'x.pdf', contentType: 'application/pdf' },
      a2: { filename: 'y.png', contentType: 'image/png' },
    });
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  g = graph { files: msg-[:files]-> }',
        '  names = MAP(g-[f:files]->, (f) => f.filename)',
        '  pdf = ONLY(g-[f:files WHERE f.contentType = "application/pdf"]->.filename)',
        '  write crm-[:companies]-> { name: COALESCE(pdf, "none"), summary: JOIN(names, ", ") }',
        '}',
      ].join('\n'),
      {},
      { email: inbox.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((c) => c.fields)).toEqual([{ name: 'x.pdf', summary: 'x.pdf, y.png' }]);
  });

  it('a record written as an entry value is held the same way', async () => {
    const inbox = makeLiveInbox({ a1: { filename: 'x.pdf', contentType: 'application/pdf' } });
    const attio = attioThatTouches(() => {
      inbox.store.a1.filename = 'renamed.pdf';
    });

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  g = graph { owner: ONLY(msg-[:files]->) }',
        '  write crm-[:companies]-> { name: "between" }',
        '  g-[o:owner]-> {',
        '    write crm-[:companies]-> { name: o.filename }',
        '    write o { contentType: "seen" }',
        '  }',
        '}',
      ].join('\n'),
      {},
      { email: inbox.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((c) => c.fields.name)).toEqual(['between', 'renamed.pdf']);
    expect(inbox.updates).toEqual([{ recordType: 'attachment', externalId: 'a1', fields: { contentType: 'seen' } }]);
  });

  it('concurrent members merging into one referenced record wait for each other: no lost update', async () => {
    // A write to the real record is slow, so a member that does not hold the
    // record's lock reads it while another member's write is still in flight.
    const inbox = makeLiveInbox({ a1: { filename: 'x.pdf', contentType: null } });
    const update = inbox.adapter.updateRecord.bind(inbox.adapter);
    inbox.adapter.updateRecord = async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return update(input);
    };

    // Half the members fill the field through the graph (a match in the
    // edge), half straight on the record. A fill is a read-then-write, so
    // only the first of the four may send anything.
    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  g = graph { files: msg-[:files]-> }',
        '  done = MAP(["a", "b", "c", "d"], { concurrency: 4 }, (i) => {',
        '    if i == "a" OR i == "c" {',
        '      write g-[:files]-> { unique by (filename), filename: "x.pdf", contentType ?: i }',
        '    }',
        '    if i == "b" OR i == "d" {',
        '      msg-[f:files]-> {',
        '        write f { contentType ?: i }',
        '      }',
        '    }',
        '    return i',
        '  })',
        '}',
      ].join('\n'),
      {},
      { email: inbox.adapter },
    );

    expect(inbox.updates).toHaveLength(1);
    expect(inbox.updates[0]).toMatchObject({ recordType: 'attachment', externalId: 'a1' });
  });
});

describe('unlink and delete through a reference act on the real record', () => {
  it('delete of a record reached through the graph deletes it in its system', async () => {
    const inbox = makeLiveInbox({ a1: { filename: 'x.pdf', contentType: 'application/pdf' } });
    const deletes: Array<{ recordType: string; externalId: string }> = [];
    inbox.adapter.deleteRecord = async ({ recordType, externalId }) => {
      deletes.push({ recordType, externalId });
      return {};
    };

    const result = await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  g = graph { files: msg-[:files]-> }',
        '  g-[f:files]-> {',
        '    delete f',
        '  }',
        '}',
      ].join('\n'),
      {},
      { email: inbox.adapter },
    );

    expect(deletes).toEqual([{ recordType: 'attachment', externalId: 'a1' }]);
    expect(result.writes).toMatchObject([{ kind: 'delete', adapterType: 'email', externalId: 'a1', committed: true }]);
  });

  it('unlink between two records reached through the graph severs their edge in their system', async () => {
    const inbox = makeLiveInbox({});
    const attio = makeFakeAdapter('attio');
    const unlinks: Array<Parameters<NonNullable<Adapter['unlinkRecords']>>[0]> = [];
    attio.adapter.unlinkRecords = async (input) => {
      unlinks.push(input);
      return { removed: true };
    };

    const result = await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  p = write crm-[:people]-> { unique by (`email`), name: "Ada", email: "ada@acme.test" }',
        '  co = write crm-[:companies]-> { unique by (`name`), name: "Acme" }',
        '  g = graph { person: p, company: co }',
        '  g-[q:person]-> {',
        '    g-[c:company]-> {',
        '      unlink q -[:company]-> c',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      {},
      { email: inbox.adapter, attio: attio.adapter },
    );

    expect(unlinks).toEqual([
      expect.objectContaining({
        from: { recordType: 'person', externalId: 'ext-attio-1' },
        edgeName: 'company',
        to: { recordType: 'company', externalId: 'ext-attio-2' },
      }),
    ]);
    expect(result.writes[2]).toMatchObject({ kind: 'unlink', adapterType: 'attio', externalId: 'ext-attio-1', created: true });
  });
});

describe('a field body and a record spread copy — snapshots', () => {
  it('a later change to the source does not show through either copy', async () => {
    const inbox = makeLiveInbox({ a1: { filename: 'x.pdf', contentType: 'application/pdf' } });
    const attio = attioThatTouches(() => {
      inbox.store.a1.filename = 'renamed.pdf';
    });

    await run(
      [
        'node Snap {',
        '  filename: <text | null>',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  first = ONLY(msg-[:files]->)',
        '  bodied = graph { files: msg-[a:files]-> { filename: a.filename } }',
        '  spread = graph<Snap> { ...first }',
        '  write crm-[:companies]-> { name: "between" }',
        '  bodied-[f:files]-> {',
        '    write crm-[:companies]-> { name: f.filename }',
        '  }',
        '  write crm-[:companies]-> { name: COALESCE(spread.filename, "none") }',
        '}',
      ].join('\n'),
      {},
      { email: inbox.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((c) => c.fields.name)).toEqual(['between', 'x.pdf', 'x.pdf']);
  });
});

describe('the collector — records the run wrote, grouped under a local record', () => {
  it('a MAP of writes held under a named edge: filtered, written through, linked onto and reported', async () => {
    const email = makeFakeAdapter('email', {
      related: { files: [attachment('x.pdf', 'application/pdf'), attachment('y.png', 'image/png')] },
    });
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'node Batch {',
        '  node companies {',
        '    name: <text>',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  written = MAP(msg-[a:files]->, (a) => {',
        '    return write crm-[:companies]-> { name: a.filename }',
        '  })',
        '  batch = graph<Batch> { companies: written }',
        '  late = write crm-[:companies]-> { name: "late" }',
        '  link batch -[:companies]-> late',
        '  batch-[c:companies WHERE c.name = "x.pdf"]-> {',
        '    write c-[:investments]-> { amount: 1 }',
        '  }',
        '  names = MAP(batch-[c:companies]->, (c) => c.name)',
        '  write crm-[:companies]-> { name: "report", summary: JOIN(names, ", ") }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((c) => [c.recordType, c.fields])).toEqual([
      ['company', { name: 'x.pdf' }],
      ['company', { name: 'y.png' }],
      ['company', { name: 'late' }],
      // Written THROUGH the grouped reference: a child of the real record.
      ['investment', { amount: 1 }],
      ['company', { name: 'report', summary: 'x.pdf, y.png, late' }],
    ]);
  });
});

describe('a park carries references as handles, and the resumed run reads them live', () => {
  const SOURCE =
    ARCHIVE +
    [
      'movement intake(msg: <inbox-[:message]->>) {',
      '  crm = attio(credentials: acme_main)',
      '  g = graph<Archive> { subject: msg.subject, files: msg-[:files]-> }',
      '  await sleep(30d)',
      '  g-[f:files]-> {',
      '    write crm-[:companies]-> { name: f.filename }',
      '  }',
      '}',
    ].join('\n');

  it('parks the record handle, not a copy of its fields', async () => {
    const { sink, timerParks } = makeFakeParkSink();
    const inbox0 = makeLiveInbox({ a1: { filename: 'x.pdf' } });
    const parked = await run(SOURCE, { subject: 's' }, {
      email: inbox0.adapter,
      attio: makeFakeAdapter('attio').adapter,
      parkSink: sink,
    });
    expect(parked.parked).toBe(true);

    const state = JSON.parse(JSON.stringify(timerParks[0].state)) as ParkedScopeState;
    const g = state.scopeChain.flatMap((scope) => Object.entries(scope.bindings)).find(([name]) => name === 'g')?.[1];
    if (g?.kind !== 'nodePosition') throw new Error('expected the graph to survive the park');
    const files = g.edges.files;
    if (files.kind !== 'landed') throw new Error('expected a landed edge');
    expect(files.landings).toHaveLength(1);
    const [held] = files.landings;
    if (held.kind !== 'sourcePosition') throw new Error(`expected a record handle, got ${held.kind}`);
    expect(held.position.identity).toMatchObject({ kind: 'stable', recordId: 'a1' });

    // Resume against a source that has moved on: the handle reads it NOW.
    const inbox1 = makeLiveInbox({ a1: { filename: 'renamed.pdf' } });
    const attio1 = makeFakeAdapter('attio');
    const result = await resume(SOURCE, { subject: 's' }, { email: inbox1.adapter, attio: attio1.adapter }, state);
    expect(result.parked).toBeUndefined();
    expect(attio1.creates.map((c) => c.fields.name)).toEqual(['renamed.pdf']);
  });
});

describe('TEXT.SERIALISE through a reference', () => {
  it('is refused before the run: the graph holds records read live from a system', async () => {
    const inbox = makeLiveInbox({ a1: { filename: 'x.pdf' } });
    const attio = makeFakeAdapter('attio');
    await expect(
      run(
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  g = graph { files: msg-[:files]-> }',
          "  write crm-[:companies]-> { name: TEXT.SERIALISE(g, 'JSON') }",
          '}',
        ].join('\n'),
        {},
        { email: inbox.adapter, attio: attio.adapter },
      ),
    ).rejects.toThrow(/MOV_STDLIB_ARG_NOT_RECORD|read live from a system/);
    expect(attio.creates).toEqual([]);
  });
});

describe('walking on past a reference, the bare walk without a shape, and the typed empty graph', () => {
  it('a nested node in the shape is followed through the source\'s edge of the same name', async () => {
    const email = makeFakeAdapter('email', {
      related: { files: [attachment('x.pdf', 'application/pdf')], versions: [{ label: 'v1' }, { label: 'v2' }] },
    });
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'node Archive {',
        '  subject: <text>',
        '  node files {',
        '    filename: <text>',
        '    node versions {',
        '      label: <text>',
        '    }',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  g = graph<Archive> { subject: msg.subject, files: msg-[:files]-> }',
        '  g-[f:files]->-[v:versions]-> {',
        '    write crm-[:companies]-> { name: f.filename, summary: v.label }',
        '  }',
        '}',
      ].join('\n'),
      { subject: 's' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((c) => c.fields)).toEqual([
      { name: 'x.pdf', summary: 'v1' },
      { name: 'x.pdf', summary: 'v2' },
    ]);
    // Two hops to the source — files at the literal, versions past the reference.
    expect(email.relatedCalls.count).toBe(2);
  });

  it('without a shape, a bare walk holds the records, read by their own names', async () => {
    const deck = attachment('deck.pdf', 'application/pdf');
    const email = makeFakeAdapter('email', { related: { files: [deck] } });
    const dropbox = makeFakeAdapter('dropbox');

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  drive = dropbox(credentials: team_drive)',
        '  g = graph { files: msg-[:files]-> }',
        '  g-[f:files]-> {',
        '    write drive-[:file]-> { filename: f.filename, data: f.data }',
        '  }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, dropbox: dropbox.adapter },
    );

    expect(dropbox.creates.map((c) => c.fields)).toEqual([{ filename: 'deck.pdf', data: deck.data }]);
  });

  it('graph<Shape> {} starts every child empty, and a write fills it', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'node Detailed {',
        '  note: <text | null>',
        '  node part {',
        '    label: <text>',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  g = graph<Detailed> {}',
        '  g-[p:part]-> {',
        '    write crm-[:companies]-> { name: "before" }',
        '  }',
        '  write g-[:part]-> { unique by (label), label: "one" }',
        '  g-[p:part]-> {',
        '    write crm-[:companies]-> { name: p.label }',
        '  }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((c) => c.fields.name)).toEqual(['one']);
  });
});

describe('graph { … } and spreads', () => {
  it('without a shape, the literal is its own type and nested bodies are children', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  g = graph { title: msg.subject, parts: [{ label: "one" }, { label: "two" }] }',
        '  g-[p:parts]-> {',
        '    write crm-[:companies]-> { name: g.title, summary: p.label }',
        '  }',
        '}',
      ].join('\n'),
      { subject: 'T' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((c) => c.fields)).toEqual([
      { name: 'T', summary: 'one' },
      { name: 'T', summary: 'two' },
    ]);
  });

  const NOTE = ['node Note {', '  text: <text>', '  node tag {', '    label: <text>', '  }', '}', ''].join('\n');

  it('a spread map becomes the graph; the shape decides which keys are children', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await run(
      NOTE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  v = { text: "from a map", tag: [{ label: "a" }, { label: "b" }] }',
          '  g = graph<Note> { ...v }',
          '  g-[t:tag]-> {',
          '    write crm-[:companies]-> { name: g.text, summary: t.label }',
          '  }',
          '}',
        ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((c) => c.fields)).toEqual([
      { name: 'from a map', summary: 'a' },
      { name: 'from a map', summary: 'b' },
    ]);
  });

  async function created(graph: string, payload: unknown): Promise<unknown[]> {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await run(
      NOTE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  v = msg.payload',
          `  g = ${graph}`,
          '  write crm-[:companies]-> { name: g.text }',
          '  g-[t:tag]-> {',
          '    write crm-[:companies]-> { name: t.label }',
          '  }',
          '}',
        ].join('\n'),
      { payload },
      { email: email.adapter, attio: attio.adapter },
    );
    return attio.creates.map((c) => c.fields.name);
  }

  const spread = { text: 'spread', tag: [{ label: 'spread' }] };

  it('members take effect in the order written: an entry after the spread overrides its key', async () => {
    expect(
      await created('graph<Note> { ...v, text: "written", tag: [{ label: "written" }] }', spread),
    ).toEqual(['written', 'written']);
  });

  it('a spread after an entry overrides it, a field and a child node alike', async () => {
    // The spread's keys are unnamed here, so the checker cannot call the entries overwritten.
    expect(
      await created('graph<Note> { text: "written", tag: [{ label: "written" }], ...v }', spread),
    ).toEqual(['spread', 'spread']);
  });

  it('a spread that supplies only some keys leaves the others as written', async () => {
    expect(
      await created('graph<Note> { text: "written", tag: [{ label: "written" }], ...v }', {
        text: 'spread',
      }),
    ).toEqual(['spread', 'written']);
  });

  it('a map nobody could type is checked against the shape when the graph is built', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    const run1 = run(
      NOTE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  v = msg.payload',
          '  g = graph<Note> { ...v }',
          '  write crm-[:companies]-> { name: g.text }',
          '}',
        ].join('\n'),
      { payload: { tag: [{ label: 'a' }] } },
      { email: email.adapter, attio: attio.adapter },
    );

    await expect(run1).rejects.toThrow(/doesn't fit it: it has no `text`/);
    expect(attio.creates).toEqual([]);
  });
});

// A walk read for a field is one value per landing; a spread splices those
// values, however many landed — the plan's content idiom, against the source
// graph and against a local one.
describe('a spread of a walk read for a field', () => {
  function emailWith(files: Array<ReturnType<typeof attachment>>) {
    return makeFakeAdapter('email', { related: { files } });
  }

  async function contentOf(body: string[], files: Array<ReturnType<typeof attachment>>): Promise<unknown> {
    const email = emailWith(files);
    const dropbox = makeFakeAdapter('dropbox');
    await run(
      MESSAGE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  drive = dropbox(credentials: team_drive)',
          ...body,
          '  write drive-[:file]-> { parts: TEXT.SERIALISE(content, "JSON") }',
          '}',
        ].join('\n'),
      { subject: 'Series A' },
      { email: email.adapter, dropbox: dropbox.adapter },
    );
    expect(dropbox.creates).toHaveLength(1);
    return JSON.parse(String(dropbox.creates[0].fields.parts));
  }

  const deck = attachment('deck.pdf', 'application/pdf');
  const memo = attachment('memo.pdf', 'application/pdf');
  const photo = attachment('photo.png', 'image/png');
  // A file serialises as its name, type and size — enough to say which one.
  const pdf = (name: string) => ({ kind: 'file', name, contentType: 'application/pdf', size: null });

  const BOUND = [
    '  pdfs = msg-[a:files WHERE a.contentType = "application/pdf"]->.`data`',
    '  content = [msg.subject, ...pdfs]',
  ];

  it('bound to a name, off the source: the WHERE keeps the PDFs and the spread splices them', async () => {
    await expect(contentOf(BOUND, [deck, photo, memo])).resolves.toEqual(['Series A', pdf('deck.pdf'), pdf('memo.pdf')]);
  });

  it('one landing splices its one value', async () => {
    await expect(contentOf(BOUND, [photo, deck])).resolves.toEqual(['Series A', pdf('deck.pdf')]);
  });

  it('nothing landed splices nothing', async () => {
    await expect(contentOf(BOUND, [photo])).resolves.toEqual(['Series A']);
    await expect(contentOf(BOUND, [])).resolves.toEqual(['Series A']);
  });

  it("inline, off a local graph — the plan's second form", async () => {
    const body = [
      '  m = from_email(m: msg)',
      '  content = [m.text, ...m-[a:attachment WHERE a.type = "application/pdf"]->.file]',
    ];
    await expect(contentOf(body, [deck, photo, memo])).resolves.toEqual(['Series A', pdf('deck.pdf'), pdf('memo.pdf')]);
    await expect(contentOf(body, [deck])).resolves.toEqual(['Series A', pdf('deck.pdf')]);
    await expect(contentOf(body, [photo])).resolves.toEqual(['Series A']);
  });

  it('the name still reads as one value where one value is written, as it always did', async () => {
    const email = emailWith([photo, deck]);
    const attio = makeFakeAdapter('attio');
    await run(
      MESSAGE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  name = msg-[a:files WHERE a.contentType = "application/pdf"]->.filename',
          '  write crm-[:companies]-> { name: name }',
          '}',
        ].join('\n'),
      { subject: 'Acme' },
      { email: email.adapter, attio: attio.adapter },
    );
    expect(attio.creates).toEqual([{ recordType: 'company', fields: { name: 'deck.pdf' } }]);
  });
});

describe('a park keeps the identity of the nodes the run built', () => {
  const TOPIC = ['node Topic {', '  title: <text>', '  node x {', '    title: <text>', '  }', '}', ''].join('\n');

  /** Run `beforePark`, park on a sleep, then resume — through jsonb's
   *  stand-in, a JSON round trip — and run `afterPark`. */
  async function parkAndResume(beforePark: string[], afterPark: string[]) {
    const source = [
      TOPIC,
      'movement intake(msg: <inbox-[:message]->>) {',
      '  crm = attio(credentials: acme_main)',
      ...beforePark,
      '  await sleep(30d)',
      ...afterPark,
      '}',
    ].join('\n');
    const { sink, timerParks } = makeFakeParkSink();
    const parked = await run(source, {}, {
      email: makeFakeAdapter('email').adapter,
      attio: makeFakeAdapter('attio').adapter,
      parkSink: sink,
    });
    expect(parked.parked).toBe(true);
    const state = JSON.parse(JSON.stringify(timerParks[0].state)) as ParkedScopeState;
    const attio = makeFakeAdapter('attio');
    const result = await resume(source, {}, { email: makeFakeAdapter('email').adapter, attio: attio.adapter }, state);
    expect(result.parked).toBeUndefined();
    return { state, creates: attio.creates.map((c) => c.fields) };
  }

  function bindingNamed(state: ParkedScopeState, name: string) {
    return state.scopeChain.flatMap((scope) => Object.entries(scope.bindings)).find(([n]) => n === name)?.[1];
  }

  it('one node held by two graphs is one node after the resume: a write through one is read through the other', async () => {
    const { state, creates } = await parkAndResume(
      ['  n = graph<Topic> { title: "n" }', '  g1 = graph { owner: n }', '  g2 = graph { owner: n }'],
      [
        '  g1-[o:owner]-> {',
        '    write o-[:x]-> { unique by (title), title: "added" }',
        '  }',
        '  g2-[o:owner]->-[c:x]-> {',
        '    write crm-[:companies]-> { name: c.title }',
        '  }',
        '  n-[c:x]-> {',
        '    write crm-[:companies]-> { name: c.title }',
        '  }',
      ],
    );
    expect(creates).toEqual([{ name: 'added' }, { name: 'added' }]);
    // Written once; every later sighting names it.
    const g2 = bindingNamed(state, 'g2');
    if (g2?.kind !== 'nodePosition' || g2.edges.owner?.kind !== 'landed') throw new Error('expected g2 to hold n');
    expect(g2.edges.owner.landings).toEqual([{ kind: 'nodeRef', id: expect.any(Number) }]);
  });

  it('a node linked to itself parks and resumes as the same cycle', async () => {
    const { state, creates } = await parkAndResume(
      ['  g = graph<Topic> { title: "t" }', '  link g -[:x]-> g'],
      [
        '  write g-[:x]-> { unique by (title), title: "later" }',
        '  g-[a:x]-> {',
        '    write crm-[:companies]-> { name: a.title }',
        '  }',
      ],
    );
    // Before, the park recursed round the loop until the stack ran out. (That
    // the landing IS g, not a copy of it, is proved where the language cannot
    // hop twice — in serialize.unit.test.ts.)
    expect(creates).toEqual([{ name: 't' }, { name: 'later' }]);
    const g = bindingNamed(state, 'g');
    if (g?.kind !== 'nodePosition' || g.edges.x?.kind !== 'landed') throw new Error('expected g to survive the park');
    expect(g.edges.x.landings).toEqual([{ kind: 'nodeRef', id: g.id }]);
  });

  it('two nodes linked to each other park and resume as the same two', async () => {
    const { creates } = await parkAndResume(
      ['  a = graph<Topic> { title: "a" }', '  b = graph<Topic> { title: "b" }', '  link a -[:x]-> b', '  link b -[:x]-> a'],
      [
        '  write a-[:x]-> { unique by (title), title: "new" }',
        '  a-[q:x]-> {',
        '    write crm-[:companies]-> { name: q.title }',
        '  }',
        '  b-[q:x]-> {',
        '    write crm-[:companies]-> { name: q.title }',
        '  }',
      ],
    );
    expect(creates).toEqual([{ name: 'b' }, { name: 'new' }, { name: 'a' }]);
  });
});
