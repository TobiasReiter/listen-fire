// A file is what the envelope that carries it declares, never a shape the
// data carries (Henry's ruling, 2026-10-10: the engine structures the data it
// handles so that its content can never change how it is treated). Each case
// runs on the Rust engine whole, through the real shim.
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
import type { Adapter, FileRef } from 'movement-engine/services/translation_graph/adapter';
import type { ExtractCallLlmResult } from 'movement-engine/services/movement_engine/extraction_call';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { ParkedScopeState } from 'movement-engine/services/movement_engine/serialize';
import type { FileTextResolution } from 'movement-engine/services/movement_engine/expression';

import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { makeUnstablePosition, positionData } from 'movement-engine/services/translation_graph/types';
import { credentialIdsFor, makeFakeParkSink, makeTestHost, endedInRust } from 'movement-engine/services/movement_engine/test_host';
import { isCheckFailure } from 'movement-engine/services/movement_engine/errors';
import { runFailureCause, resumeMovement, runMovement, type RunMovementInput } from 'movement-engine/services/movement_engine/run';
import { filesInBranchExports, filesInParkState } from 'movement-engine/services/movement_engine/rust_wire';
import { isFileValue } from 'engine-contracts';
import { resetRustRunStats, rustRunStats } from 'movement-engine/services/movement_engine/rust_stats';
import { installMemoryDocumentStore } from '../../translation_graph/engine/files/__test__/memory_document_store';
import { FileOutsideTeamError } from '../../translation_graph/engine/files/retrieve';
import { makeFileTextResolver } from '../../translation_graph/movement/file_text';
import { inMemoryRawTextStore } from '../../translation_graph/movement/raw_text_store';
import { teamOfTenant } from '../../translation_graph/movement/tenant';
import { createEmailAdapter } from '../../translation_graph/adapters/email';

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
  writableRoots: { note: { fields: { title: 'text', deck: 'file' }, resultShape: { externalId: 'text', title: 'text' } } },
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
  'inbox = connect email using dealflow_inbox',
  'kg = connect graph',
  'crm = connect attio using acme_main',
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
/** Each file a write handed the CRM, as JSON (what a remote host receives). */
const writtenFiles: unknown[] = [];
/** What the source double's records hold at `meta` (a `json` field). */
let recordMeta: unknown = SPELLED;
/** Set: the email double serves its files as the real email adapter does. */
let realEmailOwner: Adapter | undefined;

/** A source that answers each field off the position's own data, and is
 *  asked (and refuses) to serve any file it owns. */
function sourceAdapter(adapterType: string, records: ReadonlyArray<Record<string, unknown>> = []): Adapter {
  return {
    adapterType,
    async resolveFileRef({ ref }) {
      served.push([adapterType, ref.source !== undefined && 'handle' in ref.source ? ref.source.handle : undefined]);
      if (adapterType === 'email' && realEmailOwner?.resolveFileRef !== undefined) return realEmailOwner.resolveFileRef({ ref });
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
    PRELUDE + 'function m(msg: <inbox-[:message]->>) {',
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
      if (input.fields.deck !== undefined) writtenFiles.push(JSON.parse(JSON.stringify(input.fields.deck)));
      return { adapterType: 'attio', externalId: `n-${titles.length}`, data: {} };
    },
  };
  const records = [{ subject: 'Acme', meta: recordMeta, deck: SPELLED }];
  return makeTestHost({
    adapters: {
      resolve: (r) => (r.adapterType === 'attio' ? crm : sourceAdapter(r.adapterType, records)),
    },
    llm: {
      extractCall: {
        call: async (request): Promise<ExtractCallLlmResult> => {
          prompts.push(request.blocks.map((block) => block.text).join('\n'));
          return {
            parsedJson: { record: { name: { evidence: 'q', value: 'Acme' } } },
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          };
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

async function runOn(source: string): Promise<Ran> {
  const ran: Ran = { read: [], titles: [], prompts: [] };
  try {
    ran.result = await runMovement({ ...baseInput(source), host: hostFor(ran.read, ran.titles, ran.prompts) });
  } catch (error) {
    ran.error = error;
  }
  return ran;
}

/** The program on the Rust engine, whole — or, where the case says so
 *  (`endsAtCheck`), ended at the check before the engine was asked. */
async function run(source: string, { endsAtCheck = false }: { endsAtCheck?: boolean } = {}): Promise<Ran> {
  resetRustRunStats();
  const ran = await runOn(source);
  expect(isCheckFailure(ran.error)).toBe(endsAtCheck);
  expect(rustRunStats).toMatchObject({ ...endedInRust(ran.error), shimFaults: 0 });
  return ran;
}

describe.each(SOURCES)('a descriptor-shaped dict from $what', (source) => {
  it('there, TEXT.SERIALISE prints its keys, not a file', async () => {
    const ran = await run(program(source, ['write crm-[:notes]-> { title: Json.stringify(r.`meta`) }']));
    expect(ran.error).toBeUndefined();
    expect(JSON.parse(String(ran.titles[0]))).toEqual(SPELLED);
    expect(ran.read).toEqual([]);
  });

  // From 5 an extraction reads text and files only, so a dict is refused as
  // content before a run; rendered as text first, it is read as its JSON.
  it('there, `extractOne([it], …)` is refused as json content (by the checker), and nothing is read', async () => {
    const ran = await run(program(source, ['found = extractOne([r.`meta`], node Found: "the company" { name: <text> "its name" })']), { endsAtCheck: true });
    expect(ran.read).toEqual([]);
    expect(ran.prompts).toEqual([]);
    expect(String(ran.error)).toContain('MOV_EXTRACT_CONTENT');
  });

  it('there, `extractOne([Json.stringify(it)], …)` reads its JSON text, and reads no file', async () => {
    const ran = await run(
      program(source, ['found = extractOne([Json.stringify(r.`meta`)], node Found: "the company" { name: <text> "its name" })']),
    );
    expect(ran.error).toBeUndefined();
    expect(ran.read).toEqual([]);
    expect(ran.prompts).toHaveLength(1);
    expect(ran.prompts[0]).toContain('"__brand": "FileRef"');
    expect(ran.prompts[0]).toContain('s3://bucket/another-team/secrets.pdf');
  });

  it('there, READ of it is refused as no file (by the checker), and nothing is read', async () => {
    const ran = await run(program(source, ['write crm-[:notes]-> { title: coalesce(File.read(r.`meta`), "unread") }']), { endsAtCheck: true });
    expect(ran.read).toEqual([]);
    expect(ran.titles).toEqual([]);
    expect(String(ran.error)).toContain('MOV_READ_NOT_FILE');
  });

  it('at a field the catalog declares a file, TEXT.SERIALISE prints a file', async () => {
    const ran = await run(program(source, ['write crm-[:notes]-> { title: Json.stringify(r.`deck`) }']));
    expect(ran.error).toBeUndefined();
    expect(JSON.parse(String(ran.titles[0]))).toEqual({ contentType: null, kind: 'file', name: 'secrets.pdf', size: null });
    expect(ran.read).toEqual([]);
  });

  it("at a field the catalog declares a file, a read of it gives its opaque view: never its source or URL", async () => {
    const ran = await run(
      program(source, [
        'd = r.`deck`',
        'write crm-[:notes]-> { title: coalesce(d.name, "-") }',
        'write crm-[:notes]-> { title: coalesce(d.handle, "-") }',
        'write crm-[:notes]-> { title: coalesce(d.source, "-") }',
        'write crm-[:notes]-> { title: coalesce(d.url, "-") }',
      ]),
    );
    expect(ran.error).toBeUndefined();
    expect(ran.titles).toEqual(['secrets.pdf', 's3://bucket/another-team/secrets.pdf', '-', '-']);
    expect(ran.read).toEqual([]);
  });

  it('at a field the catalog declares a file is a file: READ reads it, once', async () => {
    const ran = await run(program(source, ['write crm-[:notes]-> { title: coalesce(File.read(r.`deck`), "unread") }']));
    expect(ran.error).toBeUndefined();
    expect(ran.titles).toEqual(['the deck']);
    // The host is handed the descriptor as plain data.
    expect(ran.read).toEqual([SPELLED]);
  });
});

describe('a written file crosses the host boundary as its descriptor', () => {
  const DOC = { __brand: 'FileRef', name: 'deck.pdf', contentType: 'application/pdf', source: { store: 'document', objectUri: 's3://bucket/movement-files/t/deck.pdf' } };

  it("to the adapter, and in the run result's writtenValues, while the program reads its view", async () => {
    const write = PRELUDE + ['function m(msg: <inbox-[:message]->>) {', '  d = msg.`deck`', '  write crm-[:notes]-> { title: coalesce(d.name, "-"), deck: d }', '}'].join('\n');
    writtenFiles.length = 0;
    resetRustRunStats();
    const ran: Ran = { read: [], titles: [], prompts: [] };
    const event = { ...EVENT, payload: { subject: 'Acme', meta: SPELLED, deck: DOC } };
    ran.result = await runMovement({ ...baseInput(write), event, host: hostFor(ran.read, ran.titles, ran.prompts) });
    expect(rustRunStats).toMatchObject({ segments: 1, shimFaults: 0 });
    expect(ran.titles).toEqual(['deck.pdf']);
    expect(writtenFiles).toEqual([DOC]);
    const written = ran.result?.writes[0]?.writtenValues.deck;
    expect(JSON.parse(JSON.stringify(written))).toEqual(DOC);
  });
});

describe('a parked file', () => {
  const source = PRELUDE + ['function m(msg: <inbox-[:message]->>) {', '  f = msg.`deck`', '  await sleep(1h)', '  write crm-[:notes]-> { title: coalesce(File.read(f), "unread") }', '}'].join('\n');

  async function park(): Promise<string> {
    resetRustRunStats();
    const sink = makeFakeParkSink();
    await runMovement({ ...baseInput(source), host: hostFor([], [], [], sink) });
    expect(rustRunStats).toMatchObject({ segments: 1, shimFaults: 0 });
    expect(sink.timerParks).toHaveLength(1);
    return JSON.stringify(sink.timerParks[0]?.state);
  }

  async function resumed(state: string) {
    const ran: Ran = { read: [], titles: [], prompts: [] };
    resetRustRunStats();
    try {
      const parsed: ParkedScopeState = JSON.parse(state);
      ran.result = await resumeMovement({ ...baseInput(source), state: parsed, host: hostFor(ran.read, ran.titles, ran.prompts) });
    } catch (error) {
      ran.error = error;
    }
    expect(rustRunStats).toMatchObject({ segments: 1, shimFaults: 0 });
    return ran;
  }

  it('is said to be one, and a `file` descriptor revives as a file', async () => {
    const parked = await park();
    expect(parked).toContain('"kind":"file"');
    const ran = await resumed(parked);
    expect(ran.error).toBeUndefined();
    expect(ran.titles).toEqual(['the deck']);
    expect(ran.read).toEqual([SPELLED]);
  });

  it('parked as data — a descriptor-shaped `value` — revives as a dict', async () => {
    const state = JSON.parse(await park()) as ParkedScopeState;
    // The name held as a plain value carrying the descriptor's keys: what a
    // park written before files were said to be holds, and what a forger
    // would write.
    const scope = state.scopeChain.find((s) => s.bindings.f !== undefined);
    if (scope === undefined) throw new Error('test: the park holds f');
    scope.bindings.f = { kind: 'value', value: SPELLED };
    const ran = await resumed(JSON.stringify(state));
    expect(ran.read).toEqual([]);
    expect(ran.titles).toEqual([]);
    expect(String(runFailureCause(ran.error) ?? ran.error)).toContain('READ() reads a file');
  });
});

describe('a parked file is found by the park\'s structure, never by a name', () => {
  // The names a park's own descriptors use for their members: bound by the
  // author, each is only a key in a scope's bindings, and a file bound to it
  // is a file after the resume.
  const NAMES = ['fields', 'body', 'head', 'position', 'op', 'mapping', 'closure', 'params', 'origin', 'handle'];

  function bodyFor(name: string): string {
    return PRELUDE + ['function m(msg: <inbox-[:message]->>) {', `  ${name} = msg.\`deck\``, '  await sleep(1h)', `  write crm-[:notes]-> { title: coalesce(File.read(${name}), "unread") }`, '}'].join('\n');
  }

  async function parkOn(source: string, event: TriggerEvent = EVENT): Promise<string> {
    resetRustRunStats();
    const park = makeFakeParkSink();
    await runMovement({ ...baseInput(source), event, host: hostFor([], [], [], park) });
    expect(rustRunStats).toMatchObject({ segments: 1, shimFaults: 0 });
    expect(park.timerParks).toHaveLength(1);
    return JSON.stringify(park.timerParks[0]?.state);
  }

  async function resumedOn(source: string, state: string, event: TriggerEvent = EVENT): Promise<Ran> {
    const ran: Ran = { read: [], titles: [], prompts: [] };
    resetRustRunStats();
    try {
      const parsed: ParkedScopeState = JSON.parse(state);
      ran.result = await resumeMovement({ ...baseInput(source), event, state: parsed, host: hostFor(ran.read, ran.titles, ran.prompts) });
    } catch (error) {
      ran.error = error;
    }
    expect(rustRunStats).toMatchObject({ segments: 1, shimFaults: 0 });
    return ran;
  }

  it.each(NAMES)('a file bound to `%s` parks as a file and is read after the resume', async (name) => {
    const source = bodyFor(name);
    const parked = await parkOn(source);
    expect(parked).toContain('"kind":"file"');
    const resumed = await resumedOn(source, parked);
    expect(resumed.error).toBeUndefined();
    expect(resumed.titles).toEqual(['the deck']);
    expect(resumed.read).toEqual([SPELLED]);
  });

  /** A file's value descriptor, as data would spell it. */
  const LOOKALIKE = { kind: 'file', file: SPELLED };
  const serialised = PRELUDE + ['function m(msg: <inbox-[:message]->>) {', '  OPEN', '  d = r.`meta`', '  await sleep(1h)', '  write crm-[:notes]-> { title: Json.stringify(d) }', '  CLOSE', '}'].join('\n');

  it.each([
    ['a webhook field holding its JSON text, read as a json field', SOURCES[0]!, JSON.stringify(LOOKALIKE)],
    ["an adapter's answer holding it", SOURCES[1]!, LOOKALIKE],
  ])('data shaped like a file — %s — resumes as the data it is', async (_what, from, meta) => {
    const source = serialised.replace('  OPEN', from.open.join('\n')).replace('  CLOSE', from.close.join('\n'));
    const event: TriggerEvent = { ...EVENT, payload: { subject: 'Acme', meta, deck: SPELLED } };
    recordMeta = meta;
    try {
      // What the run writes when it never parks.
      const unparked = source.replace('  await sleep(1h)\n', '');
      const whole: Ran = { read: [], titles: [], prompts: [] };
      await runMovement({ ...baseInput(unparked), event, host: hostFor(whole.read, whole.titles, whole.prompts) });
      expect(whole.titles).toHaveLength(1);
      expect(whole.read).toEqual([]);
      const parked = await parkOn(source, event);
      const resumed = await resumedOn(source, parked, event);
      expect(resumed.error).toBeUndefined();
      expect(resumed.read).toEqual([]);
      expect(resumed.titles).toEqual(whole.titles);
    } finally {
      recordMeta = SPELLED;
    }
  });

  it('the host walk makes a file only where the structure says one is', () => {
    const fileValue = { kind: 'file', file: SPELLED };
    const binding = { kind: 'recordValue', value: fileValue };
    const state = {
      version: 1,
      address: 'a',
      bindingName: null,
      scopeChain: [
        {
          bindings: {
            ...Object.fromEntries(NAMES.map((name) => [name, binding])),
            // Data whatever its shape: a value, a data member, a record's
            // fields, an edge's properties, a written record.
            plain: { kind: 'value', value: fileValue },
            data: { kind: 'recordValue', value: { kind: 'map', of: { x: { kind: 'data', value: fileValue } } } },
            shaped: {
              kind: 'shapePosition', shape: 's', node: 'n', fields: { deck: fileValue, other: fileValue },
              fileFields: { deck: fileValue }, fieldProvenance: {},
            },
            edge: { kind: 'sourcePosition', position: { data: fileValue }, edgeProperties: { p: fileValue } },
            written: { kind: 'handle', handle: { fields: { deck: fileValue } }, targetType: 't', graph: {} },
            unknown: { kind: 'notAKindYet', fields: fileValue, file: SPELLED },
          },
        },
      ],
    };
    const made = filesInParkState(JSON.parse(JSON.stringify(state))) as typeof state;
    const bindings = made.scopeChain[0]!.bindings as Record<string, any>;
    for (const name of NAMES) expect(isFileValue(bindings[name].value.file)).toBe(true);
    expect(bindings.plain).toEqual(state.scopeChain[0]!.bindings.plain);
    expect(bindings.data).toEqual(state.scopeChain[0]!.bindings.data);
    expect(bindings.edge).toEqual(state.scopeChain[0]!.bindings.edge);
    expect(bindings.written).toEqual(state.scopeChain[0]!.bindings.written);
    expect(bindings.unknown).toEqual(state.scopeChain[0]!.bindings.unknown);
    expect(bindings.shaped.fields).toEqual({ deck: fileValue, other: fileValue });
    expect(isFileValue(bindings.shaped.fileFields.deck.file)).toBe(true);

    // A branch's exports are its names' descriptors, whatever the names.
    const rows = filesInBranchExports([
      { branchAddress: 'b0', branchIndex: 0, exports: { kept: binding, source: binding, plain: { kind: 'value', value: fileValue } } },
      { branchAddress: 'b1', branchIndex: 1, exports: { kept: true, answer: binding } },
      { branchAddress: 'f', branchIndex: -1, exports: { arms: 2 } },
    ]) as Array<{ exports: Record<string, any> }>;
    expect(isFileValue(rows[0]!.exports.kept.value.file)).toBe(true);
    expect(isFileValue(rows[0]!.exports.source.value.file)).toBe(true);
    expect(rows[0]!.exports.plain).toEqual({ kind: 'value', value: fileValue });
    expect(isFileValue(rows[1]!.exports.answer.value.file)).toBe(true);
    expect(rows[2]!.exports).toEqual({ arms: 2 });
  });
});

describe("a file-kind field's descriptor is read only as the run's team's", () => {
  // The production reader: the team's byte read (`streamFileRef`), then text.
  const store = installMemoryDocumentStore();
  const reader = makeFileTextResolver(inMemoryRawTextStore(), { teamId: teamOfTenant(TEAM_ID) });
  const read = PRELUDE + ['function m(msg: <inbox-[:message]->>) {', '  write crm-[:notes]-> { title: coalesce(File.read(msg.`deck`), "unread") }', '}'].join('\n');

  async function runWith(deck: FileRef): Promise<Ran> {
    const ran: Ran = { read: [], titles: [], prompts: [] };
    resetRustRunStats();
    try {
      const event = { ...EVENT, payload: { subject: 'Acme', meta: SPELLED, deck } };
      ran.result = await runMovement({ ...baseInput(read), event, host: hostFor(ran.read, ran.titles, ran.prompts, undefined, reader) });
    } catch (error) {
      ran.error = error;
    }
    expect(rustRunStats).toMatchObject({ segments: 1, shimFaults: 0 });
    return ran;
  }

  it("refuses, by name, a forged document of another team's, nothing written", async () => {
    const theirs = store.file('THEIR SECRETS', { name: 'secrets.pdf', contentType: 'application/pdf', teamId: OTHER_TEAM });
    const ran = await runWith(theirs);
    expect(ran.titles).toEqual([]);
    const cause = runFailureCause(ran.error);
    expect(cause).toBeInstanceOf(FileOutsideTeamError);
    expect(String(cause)).toContain("is not this team's, so its bytes are not read");
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
      const ran = await runWith(deck);
      expect(ran.titles).toEqual([]);
      expect(runFailureCause(ran.error)).toMatchObject({ code: 'FILE_OUTSIDE_TEAM', owner: 'instance' });
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
    served.length = 0;
    const ran = await runWith(deck);
    // The run's email instance (the test's source double) was asked for
    // the handle, and serves no bytes: the read is absent, not refused.
    expect(served).toEqual([['email', 'https://storage.mailgun.net/v3/x']]);
    expect(ran.error).toBeUndefined();
    expect(ran.titles).toEqual(['unread']);
  });

  it.each([
    ['its own spelling', { adapterType: 'email', handle: 'https://evil.example/exfiltrate' }],
    ['the earlier spelling', { ownerAdapterType: 'email', handle: 'https://evil.example/exfiltrate' }],
    ['a host that only ends like the provider', { adapterType: 'email', handle: 'https://evilmailgun.net/v3/x' }],
  ])("refuses, by name, an email handle (%s) its owner never issued, nothing fetched", async (_what, source) => {
    realEmailOwner = createEmailAdapter({ teamId: teamOfTenant(TEAM_ID) });
    const realFetch = global.fetch;
    const fetched: unknown[] = [];
    global.fetch = (async (url: unknown) => {
      fetched.push(url);
      throw new Error('test: nothing may be fetched');
    }) as typeof fetch;
    try {
      const deck = { __brand: 'FileRef' as const, name: 'deck.pdf', contentType: 'application/pdf', source } as FileRef;
      const ran = await runWith(deck);
      expect(ran.titles).toEqual([]);
      expect(runFailureCause(ran.error)).toMatchObject({ code: 'FILE_OUTSIDE_TEAM', owner: 'handle' });
      expect(fetched).toEqual([]);
    } finally {
      global.fetch = realFetch;
      realEmailOwner = undefined;
    }
  });
});

