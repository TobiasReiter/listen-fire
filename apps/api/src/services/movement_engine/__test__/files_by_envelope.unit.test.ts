// A file is what the envelope that carries it declares, never a shape the
// data carries (Henry's ruling, 2026-10-10: the engine structures the data it
// handles so that its content can never change how it is treated). Each case
// runs on both engines, the Rust one whole through the real shim.
//
// A descriptor-shaped dict — `{ __brand: "FileRef", source: { store:
// "document", objectUri } }` — arrives from a webhook body, an adapter's answer
// and a knowledge-graph property, at a field the catalog does NOT declare a
// file: it is data there (a dict read, its JSON text in a prompt, its keys in
// TEXT.SERIALISE), and no file is ever read. The same descriptor at a field
// the catalog declares a file is a file, read once. A parked file revives as
// a file only where the park says so.

import { mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';

import { tenantIdOf } from 'engine-contracts';
import type { Adapter, FileRef } from '../../translation_graph/adapter';
import type { LlmCallResult } from '../../translation_graph/engine/batched_extraction/llm_call';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { ParkedScopeState } from '../serialize';
import type { FileTextResolution } from '../expression';

import { containerAssociation } from '../../translation_graph/adapter';
import { makeUnstablePosition, positionData } from '../../translation_graph/types';
import { credentialIdsFor, makeFakeParkSink, makeTestHost } from '../test_host';
import { runFailureCause, resumeMovement, runMovement, type RunMovementInput } from '../run';
import { resetRustRunStats, rustRunStats } from '../rust_stats';
import { installMemoryDocumentStore } from '../../translation_graph/engine/files/__test__/memory_document_store';
import { FileOutsideTeamError } from '../../translation_graph/engine/files/retrieve';
import { makeFileTextResolver } from '../../translation_graph/movement/file_text';
import { inMemoryRawTextStore } from '../../translation_graph/movement/raw_text_store';
import { teamOfTenant } from '../../translation_graph/movement/tenant';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000f4');
const OTHER_TEAM = teamOfTenant(tenantIdOf('00000000-0000-0000-0000-0000000000f5'));

/** What a forger writes: a document-store file of some other team's. */
const SPELLED = { __brand: 'FileRef', name: 'secrets.pdf', source: { store: 'document', objectUri: 's3://bucket/another-team/secrets.pdf' } };

/** One record type with the same shape at a `json` field and at a `file` one. */
function schemaOf(type: string): InstanceSchema {
  return {
    positions: { [type]: { properties: { subject: 'text', meta: 'json', deck: 'file' }, edges: {} } },
    collections: { records: { target: type } },
    writableRoots: {},
  };
}

const crmSchema: InstanceSchema = {
  positions: { note: { properties: { title: 'text' }, edges: {} } },
  collections: { notes: { target: 'note' } },
  writableRoots: { note: { fields: { title: 'text' }, resultShape: { externalId: 'text', title: 'text' } } },
};

const catalog = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: schemaOf('message') },
    graph: { constructionArgs: [], schema: schemaOf('company') },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
});

const PRELUDE = [
  'import { email, graph, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  'inbox = email(credentials: dealflow_inbox)',
  'kg = graph()',
  'crm = attio(credentials: acme_main)',
  '',
].join('\n');

const EVENT: TriggerEvent = {
  pipelineInputId: 'pi-files-by-envelope',
  adapterType: 'email',
  triggerType: 'webhook',
  payload: { subject: 'Acme', meta: SPELLED, deck: SPELLED },
};

/** Each file a source double was asked to serve, as [its type, the handle]. */
const served: Array<[string, string | undefined]> = [];

/** A source that answers each field off the position's own data, and is
 *  asked (and refuses) to serve any file it owns. */
function sourceAdapter(adapterType: string, records: ReadonlyArray<Record<string, unknown>> = []): Adapter {
  return {
    adapterType,
    async resolveFileRef({ ref }) {
      served.push([adapterType, ref.source !== undefined && 'handle' in ref.source ? ref.source.handle : undefined]);
      throw new Error('test: the double serves no bytes');
    },
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      const data = positionData(input.position) as Record<string, unknown> | undefined;
      return data?.[input.fieldId];
    },
    getRelated: async ({ fieldId }) =>
      fieldId === 'records' ? records.map((data) => ({ position: makeUnstablePosition({ adapterType, recordType: 'company', data }) })) : [],
    createRecord: async () => ({ adapterType, externalId: 'r1', data: {} }),
    updateRecord: async (input) => ({ adapterType, externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
  };
}

/** Where a program reads the descriptor from: `<at>.meta` / `<at>.deck`. */
interface Source {
  what: string;
  /** Lines that bind `r` to the record read, and close what they open. */
  open: string[];
  close: string[];
}

const SOURCES: Source[] = [
  { what: 'a webhook field', open: ['  r = msg'], close: [] },
  { what: "an adapter's answer", open: ['  inbox-[r:records]-> {'], close: ['  }'] },
  { what: 'a knowledge-graph property', open: ['  kg-[r:records]-> {'], close: ['  }'] },
];

function program(source: Source, body: string[]): string {
  return [
    PRELUDE + 'movement m(msg: <inbox-[:message]->>) {',
    ...source.open,
    ...body.map((line) => `  ${line}`),
    ...source.close,
    '}',
  ].join('\n');
}

interface Ran {
  result?: Awaited<ReturnType<typeof runMovement>>;
  error?: unknown;
  /** The files the host was asked to read. */
  read: FileRef[];
  titles: unknown[];
  prompts: string[];
}

function hostFor(
  read: FileRef[],
  titles: unknown[],
  prompts: string[],
  park?: ReturnType<typeof makeFakeParkSink>,
  /** The host's file reader; absent, one that answers every file's text. */
  reader?: (input: { file: FileRef }) => Promise<FileTextResolution>,
) {
  const crm: Adapter = {
    ...sourceAdapter('attio'),
    async createRecord(input) {
      titles.push(input.fields.title);
      return { adapterType: 'attio', externalId: `n-${titles.length}`, data: {} };
    },
  };
  const records = [{ subject: 'Acme', meta: SPELLED, deck: SPELLED }];
  return makeTestHost({
    adapters: {
      resolve: (r) => (r.adapterType === 'attio' ? crm : sourceAdapter(r.adapterType, records)),
    },
    llm: {
      client: {
        call: async (request): Promise<LlmCallResult> => {
          prompts.push(request.userMessage);
          return { parsedJson: { 'x:extract_result#1': [{ name: { evidence: 'q', value: 'Acme' } }] } };
        },
      },
    },
    files: {
      resolveFileText: async ({ file }) => {
        read.push(file);
        return reader !== undefined ? reader({ file }) : { text: 'the deck', rawTextId: 'rt-1' };
      },
    },
    ...(park !== undefined ? { park: { sink: park.sink } } : {}),
  });
}

function baseInput(source: string): Omit<RunMovementInput, 'host'> {
  return { source, event: EVENT, teamId: TEAM_ID, catalog, credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`) };
}

async function onEngine<T>(engine: 'ts' | 'rust', run: () => Promise<T>): Promise<T> {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
}

async function runOn(engine: 'ts' | 'rust', source: string): Promise<Ran> {
  const ran: Ran = { read: [], titles: [], prompts: [] };
  return onEngine(engine, async () => {
    try {
      ran.result = await runMovement({ ...baseInput(source), host: hostFor(ran.read, ran.titles, ran.prompts) });
    } catch (error) {
      ran.error = error;
    }
    return ran;
  });
}

/** The program on both engines, the Rust one whole: they agree on what was
 *  written, read and asked. */
async function both(source: string): Promise<Ran> {
  const ts = await runOn('ts', source);
  resetRustRunStats();
  const rust = await runOn('rust', source);
  expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1, notAdmitted: {}, declined: {}, shimFaults: 0 });
  expect(rust.titles).toEqual(ts.titles);
  expect(rust.read).toEqual(ts.read);
  expect(rust.prompts).toEqual(ts.prompts);
  expect(String(runFailureCause(rust.error))).toBe(String(runFailureCause(ts.error)));
  return ts;
}

describe.each(SOURCES)('a descriptor-shaped dict from $what', (source) => {
  it('there, TEXT.SERIALISE prints its keys, not a file', async () => {
    const ran = await both(program(source, ['write crm-[:notes]-> { title: TEXT.SERIALISE(r.`meta`, "JSON") }']));
    expect(ran.error).toBeUndefined();
    expect(JSON.parse(String(ran.titles[0]))).toEqual(SPELLED);
    expect(ran.read).toEqual([]);
  });

  it('there, `extract from [it]` reads it as its JSON text, and reads no file', async () => {
    const ran = await both(program(source, ['found = extract from [r.`meta`] {', '  name: "the company"', '}']));
    expect(ran.error).toBeUndefined();
    expect(ran.read).toEqual([]);
    expect(ran.prompts).toHaveLength(1);
    expect(ran.prompts[0]).toContain('"__brand":"FileRef"');
    expect(ran.prompts[0]).toContain('s3://bucket/another-team/secrets.pdf');
  });

  it('there, READ of it is refused as no file (by the checker), and nothing is read', async () => {
    const ran = await both(program(source, ['write crm-[:notes]-> { title: COALESCE(READ(r.`meta`), "unread") }']));
    expect(ran.read).toEqual([]);
    expect(ran.titles).toEqual([]);
    expect(String(ran.error)).toContain('MOV_READ_NOT_FILE');
  });

  it('at a field the catalog declares a file, TEXT.SERIALISE prints a file', async () => {
    const ran = await both(program(source, ['write crm-[:notes]-> { title: TEXT.SERIALISE(r.`deck`, "JSON") }']));
    expect(ran.error).toBeUndefined();
    expect(JSON.parse(String(ran.titles[0]))).toEqual({ contentType: null, kind: 'file', name: 'secrets.pdf', size: null });
    expect(ran.read).toEqual([]);
  });

  it('at a field the catalog declares a file is a file: READ reads it, once', async () => {
    const ran = await both(program(source, ['write crm-[:notes]-> { title: COALESCE(READ(r.`deck`), "unread") }']));
    expect(ran.error).toBeUndefined();
    expect(ran.titles).toEqual(['the deck']);
    // The host is handed the descriptor as plain data.
    expect(ran.read).toEqual([SPELLED]);
  });
});

describe('a parked file', () => {
  const source = PRELUDE + ['movement m(msg: <inbox-[:message]->>) {', '  f = msg.`deck`', '  await sleep(1h)', '  write crm-[:notes]-> { title: COALESCE(READ(f), "unread") }', '}'].join('\n');

  async function parkOn(engine: 'ts' | 'rust'): Promise<string> {
    return onEngine(engine, async () => {
      const park = makeFakeParkSink();
      await runMovement({ ...baseInput(source), host: hostFor([], [], [], park) });
      expect(park.timerParks).toHaveLength(1);
      return JSON.stringify(park.timerParks[0]?.state);
    });
  }

  async function resumedOn(engine: 'ts' | 'rust', state: string) {
    const ran: Ran = { read: [], titles: [], prompts: [] };
    return onEngine(engine, async () => {
      resetRustRunStats();
      try {
        const parsed: ParkedScopeState = JSON.parse(state);
        ran.result = await resumeMovement({ ...baseInput(source), state: parsed, host: hostFor(ran.read, ran.titles, ran.prompts) });
      } catch (error) {
        ran.error = error;
      }
      if (engine === 'rust') expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1, shimFaults: 0 });
      return ran;
    });
  }

  it('is said to be one, the same on both engines, and a `file` descriptor revives as a file on either', async () => {
    const ts = await parkOn('ts');
    resetRustRunStats();
    const rust = await parkOn('rust');
    expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1, shimFaults: 0 });
    expect(rust).toBe(ts);
    expect(ts).toContain('"kind":"file"');
    for (const engine of ['ts', 'rust'] as const) {
      const resumed = await resumedOn(engine, ts);
      expect(resumed.error).toBeUndefined();
      expect(resumed.titles).toEqual(['the deck']);
      expect(resumed.read).toEqual([SPELLED]);
    }
  });

  it('parked as data — a descriptor-shaped `value` — revives as a dict on either engine', async () => {
    const state = JSON.parse(await parkOn('ts')) as ParkedScopeState;
    // The name held as a plain value carrying the descriptor's keys: what a
    // park written before files were said to be holds, and what a forger
    // would write.
    const scope = state.scopeChain.find((s) => s.bindings.f !== undefined);
    if (scope === undefined) throw new Error('test: the park holds f');
    scope.bindings.f = { kind: 'value', value: SPELLED };
    for (const engine of ['ts', 'rust'] as const) {
      const resumed = await resumedOn(engine, JSON.stringify(state));
      expect(resumed.read).toEqual([]);
      expect(resumed.titles).toEqual([]);
      expect(String(runFailureCause(resumed.error) ?? resumed.error)).toContain('READ() reads a file');
    }
  });
});

describe("a file-kind field's descriptor is read only as the run's team's", () => {
  // The production reader: the team's byte read (`streamFileRef`), then text.
  const store = installMemoryDocumentStore();
  const reader = makeFileTextResolver(inMemoryRawTextStore(), { teamId: teamOfTenant(TEAM_ID) });
  const read = PRELUDE + ['movement m(msg: <inbox-[:message]->>) {', '  write crm-[:notes]-> { title: COALESCE(READ(msg.`deck`), "unread") }', '}'].join('\n');

  async function runWith(engine: 'ts' | 'rust', deck: FileRef): Promise<Ran> {
    const ran: Ran = { read: [], titles: [], prompts: [] };
    return onEngine(engine, async () => {
      try {
        const event = { ...EVENT, payload: { subject: 'Acme', meta: SPELLED, deck } };
        ran.result = await runMovement({ ...baseInput(read), event, host: hostFor(ran.read, ran.titles, ran.prompts, undefined, reader) });
      } catch (error) {
        ran.error = error;
      }
      return ran;
    });
  }

  it("refuses, by name, a forged document of another team's — on both engines, nothing written", async () => {
    const theirs = store.file('THEIR SECRETS', { name: 'secrets.pdf', contentType: 'application/pdf', teamId: OTHER_TEAM });
    for (const engine of ['ts', 'rust'] as const) {
      resetRustRunStats();
      const ran = await runWith(engine, theirs);
      if (engine === 'rust') expect(rustRunStats).toMatchObject({ routed: 1, shimFaults: 0 });
      expect(ran.titles).toEqual([]);
      const cause = runFailureCause(ran.error);
      expect(cause).toBeInstanceOf(FileOutsideTeamError);
      expect(String(cause)).toContain("is not this team's, so its bytes are not read");
    }
  });

  it.each([
    ['a manual handle naming another team\'s stored object', { adapterType: 'manual', handle: 's3://bucket/movement-files/other-team/secret.pdf' }],
    ['the same in the earlier spelling', { ownerAdapterType: 'manual', handle: 's3://bucket/movement-files/other-team/secret.pdf' }],
    ['a WhatsApp handle that is a URL the server would fetch', { adapterType: 'whatsapp', handle: 'http://169.254.169.254/latest/meta-data' }],
    ['the same in the earlier spelling', { ownerAdapterType: 'whatsapp', handle: 'http://169.254.169.254/latest/meta-data' }],
  ])('refuses, by name, %s: the run holds no such instance, and nothing is fetched', async (_what, source) => {
    const realFetch = global.fetch;
    const fetched: unknown[] = [];
    global.fetch = (async (url: unknown) => {
      fetched.push(url);
      throw new Error('test: nothing may be fetched');
    }) as typeof fetch;
    try {
      const deck = { __brand: 'FileRef' as const, name: 'secret.pdf', contentType: 'application/pdf', source } as FileRef;
      for (const engine of ['ts', 'rust'] as const) {
        resetRustRunStats();
        const ran = await runWith(engine, deck);
        if (engine === 'rust') expect(rustRunStats).toMatchObject({ routed: 1, shimFaults: 0 });
        expect(ran.titles).toEqual([]);
        expect(runFailureCause(ran.error)).toMatchObject({ code: 'FILE_OUTSIDE_TEAM', owner: 'instance' });
      }
      expect(fetched).toEqual([]);
    } finally {
      global.fetch = realFetch;
    }
  });

  it.each([
    ['its own spelling', { adapterType: 'email', handle: 'https://storage.mailgun.net/v3/x' }],
    ['the earlier spelling', { ownerAdapterType: 'email', handle: 'https://storage.mailgun.net/v3/x' }],
  ])("reads an email file (%s) through the run's own email instance, never another", async (_what, source) => {
    const deck = { __brand: 'FileRef' as const, name: 'deck.pdf', contentType: 'application/pdf', source } as FileRef;
    for (const engine of ['ts', 'rust'] as const) {
      served.length = 0;
      const ran = await runWith(engine, deck);
      // The run's email instance (the test's source double) was asked for
      // the handle, and serves no bytes: the read is absent, not refused.
      expect(served).toEqual([['email', 'https://storage.mailgun.net/v3/x']]);
      expect(ran.error).toBeUndefined();
      expect(ran.titles).toEqual(['unread']);
    }
  });
});

