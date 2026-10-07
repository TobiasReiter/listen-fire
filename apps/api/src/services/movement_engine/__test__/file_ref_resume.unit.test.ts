// A file bound before a park is still READABLE after the run resumes.
//
// A FileRef is a descriptor — JSON naming the adapter instance that owns its
// bytes — so it parks as it stands and the resume rebinds nothing. When the
// resumed run reads the file, the host resolves that instance, with the
// credential the descriptor names, and asks it for the bytes. These tests drive
// the real interpreter through an ordinary timer park and through a cost-cap
// pause inside a MAP member, read a credentialed Attio file across a park, and
// pin the loud warning a file with no handle gives.

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { Readable } from 'node:stream';
import type { FileTextResolution, MovementTraceEntry } from '../expression';
import { resumeMovement, runMovement, type MovementRunResult, type ParkSink, type RunLimitPause } from '../run';
import type { MovementTransformInvoker } from '../extraction';
import type { ParkedScopeState } from '../serialize';
import { assertRunBudget, reportRunCost } from '../../../lib/run_spend';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import { fileHandle, type Adapter, type FileRef, type RuntimeCapabilities } from '../../translation_graph/adapter';
import { streamFileRef, type ResolveFileOwner } from '../../translation_graph/engine/files/retrieve';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { makeUnstablePosition, positionData, type TransformOutputShape } from '../../translation_graph/types';
import { getTransform } from '../../translation_graph/engine/transforms/registry';
import type { TeamId } from '../../../generated/kysely/core/Team';
import { makeTestHost } from '../host';

const TEAM_ID = '00000000-0000-0000-0000-000000000054' as TeamId;
const ENV_VAR = 'MOVEMENT_MAX_RUN_COST_USD';
const DOLLAR = 1_000_000;

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[ENV_VAR];
  process.env[ENV_VAR] = '1.5';
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = saved;
});

/** The bytes each owner's storage holds, by the file's handle. */
const STORED: Record<string, string> = {
  'att-key-1': 'Memo: Orbit Labs builds satellites.',
  'file-pitch-9': 'Deck: Orbit Labs raises a seed round.',
};

/** An inbound email's attachment, as its producer makes it: the owner (email
 *  takes no credential) and the handle it redeems. */
function attachmentFileRef(key: string): FileRef {
  return {
    __brand: 'FileRef',
    name: 'memo.pdf',
    contentType: 'application/pdf',
    source: { adapterType: 'email', handle: key },
  };
}

function makeEmailAdapter() {
  const resolved: string[] = [];
  const adapter: Adapter = {
    adapterType: 'email',
    supportedTriggers: [] as never[],
    runtimeCapabilities: (): RuntimeCapabilities => ({
      traversal: { incoming: true, edgeProperties: true },
      resources: true,
    }),
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
      if (fieldId === 'data' && typeof data?.key === 'string') return attachmentFileRef(data.key);
      return data?.[fieldId];
    },
    async getRelated({ position }) {
      const data = positionData(position) as { attachments?: unknown[] } | undefined;
      return (data?.attachments ?? []).map((att) => ({
        position: makeUnstablePosition({ adapterType: 'email', recordType: 'Attachment', data: att }),
      }));
    },
    async resolveFileRef({ ref }) {
      const key = fileHandle(ref) ?? '';
      resolved.push(key);
      return { stream: Readable.from([Buffer.from(STORED[key] ?? '')]) };
    },
    async createRecord() {
      throw new Error('test: email is source-only');
    },
    async updateRecord() {
      throw new Error('test: email is source-only');
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, resolved };
}

/** The CRM: the write target, and — read as a source — a record whose files
 *  it owns. Its descriptors name the credential it was resolved with, and its
 *  `resolveFileRef` serves bytes only to an instance holding that credential. */
function makeCrmAdapter(credentialsId: string | undefined) {
  const creates: Array<Record<string, unknown>> = [];
  const resolved: string[] = [];
  const adapter: Adapter = {
    adapterType: 'attio',
    supportedTriggers: [] as never[],
    runtimeCapabilities: (): RuntimeCapabilities => ({
      traversal: { incoming: true, edgeProperties: true },
      resources: true,
    }),
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
      if (fieldId === 'data' && typeof data?.id === 'string') {
        return {
          __brand: 'FileRef',
          name: 'deck.pdf',
          contentType: 'application/pdf',
          source: { adapterType: 'attio', ...(credentialsId !== undefined ? { credentialId: credentialsId } : {}), handle: data.id },
        } satisfies FileRef;
      }
      return data?.[fieldId];
    },
    async getRelated({ position }) {
      const data = positionData(position) as { files?: unknown[] } | undefined;
      return (data?.files ?? []).map((file) => ({
        position: makeUnstablePosition({ adapterType: 'attio', recordType: 'File', data: file }),
      }));
    },
    async resolveFileRef({ ref }) {
      if (credentialsId === undefined) throw new Error('test: attio cannot read a file without its credential');
      const key = fileHandle(ref) ?? '';
      resolved.push(key);
      return { stream: Readable.from([Buffer.from(STORED[key] ?? '')]) };
    },
    async createRecord(input) {
      creates.push(input.fields);
      return { adapterType: 'attio', externalId: `ext-${creates.length}`, data: { ...input.fields } };
    },
    async updateRecord() {
      throw new Error('test: no updates expected');
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates, resolved };
}

/** The file→text seam as production builds it, minus OCR: the descriptor's
 *  owner resolved on the host side and its bytes read to text. Bytes that
 *  cannot be fetched are `bytes_unavailable`, exactly as
 *  `makeFileTextResolver` answers. */
function fileTextOn(resolveOwner: ResolveFileOwner) {
  return async ({ file }: { file: FileRef }): Promise<FileTextResolution> => {
    try {
      const { stream } = await streamFileRef(file, { teamId: TEAM_ID, resolveOwner });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
      return { text: Buffer.concat(chunks).toString('utf8') };
    } catch (error) {
      return { unreadable: 'bytes_unavailable', detail: error instanceof Error ? error.message : String(error) };
    }
  };
}

/** A `fetch_url` that costs one dollar, refused first once the cap is met. */
const pricedInvoker: MovementTransformInvoker = {
  declaredOutput: (plugin) => {
    const impl = getTransform(plugin) ?? getTransform(plugin.replace(/_/g, '-'));
    return impl?.signature.output as TransformOutputShape | undefined;
  },
  async invoke({ config }) {
    assertRunBudget();
    reportRunCost({ source: { kind: 'service', name: 'test.fetch' }, microdollars: DOLLAR });
    return { text: `got-${String(config.url)}` };
  },
};

const catalog = staticCatalogSnapshot({
  credentials: { acme_main: { adapters: ['attio'] } },
});

/** The CRM as a source whose companies carry files. */
const attioFilesCatalog = staticCatalogSnapshot({
  credentials: { acme_main: { adapters: ['attio'] } },
  instanceSchemas: {
    attio: {
      positions: {
        company: { properties: { name: 'text' }, edges: { files: { target: 'file' } } },
        file: { properties: { name: 'text', data: 'file' }, edges: {} },
      },
      collections: { companies: { target: 'company' } },
      writableRoots: { company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } } },
    },
  },
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  'import { fetch_url } from plugins',
  '',
  'inbox = email()',
  'crm = attio(credentials: acme_main)',
  '',
].join('\n');

type ParkKind = 'timer' | 'await' | 'suspension';

function makeParkSink() {
  const parks = new Map<string, { kind: ParkKind; state: ParkedScopeState }>();
  const joins = new Map<string, { pending: number; closedBy: string | null; decremented: Set<string> }>();
  const exports = new Map<string, Map<string, { branchIndex: number; exports: unknown }>>();
  const pauses: RunLimitPause[] = [];
  const keep = (kind: ParkKind, address: string, state: unknown): void => {
    parks.set(address, { kind, state: JSON.parse(JSON.stringify(state)) as ParkedScopeState });
  };
  const sink: ParkSink = {
    async recordJoin(input) {
      const existing = joins.get(input.frameAddress);
      joins.set(input.frameAddress, {
        pending: input.parkedChildren,
        closedBy: existing?.closedBy ?? null,
        decremented: existing?.decremented ?? new Set(),
      });
    },
    async commitTimerPark(input) {
      keep('timer', input.address, input.state);
    },
    async commitAwaitPark(input) {
      keep('await', input.address, input.state);
    },
    async commitSuspension(input) {
      keep('suspension', input.address, input.state);
    },
    async commitLimitPause(pause) {
      pauses.push(pause);
    },
    async decrementJoin(input) {
      const frame = joins.get(input.frameAddress);
      if (frame === undefined) return { closed: false };
      if (frame.decremented.has(input.branchAddress)) return { closed: frame.closedBy === input.leafAddress };
      frame.decremented.add(input.branchAddress);
      if (frame.pending === 0) return { closed: frame.closedBy === input.leafAddress };
      frame.pending -= 1;
      if (frame.pending > 0) return { closed: false };
      frame.closedBy = input.leafAddress;
      return { closed: true };
    },
    async persistBranchExport(input) {
      const byBranch = exports.get(input.frameAddress) ?? new Map();
      byBranch.set(input.branchAddress, {
        branchIndex: input.branchIndex,
        exports: JSON.parse(JSON.stringify(input.exports)) as unknown,
      });
      exports.set(input.frameAddress, byBranch);
    },
    async collectBranchExports(input) {
      return [...(exports.get(input.frameAddress) ?? new Map()).entries()]
        .map(([branchAddress, row]) => ({ branchAddress, branchIndex: row.branchIndex, exports: row.exports }))
        .sort((a, b) => a.branchIndex - b.branchIndex);
    },
    async cancelSubtrees() {},
  };
  return { sink, parks, pauses };
}

function emailEvent(): TriggerEvent {
  return {
    pipelineInputId: 'pi-file-resume',
    adapterType: 'email',
    triggerType: 'webhook',
    payload: { subject: 'Intros', attachments: [{ key: 'att-key-1', filename: 'memo.pdf' }] },
  };
}

function attioEvent(): TriggerEvent {
  return {
    pipelineInputId: 'pi-file-resume-attio',
    adapterType: 'attio',
    triggerType: 'webhook',
    payload: { name: 'Orbit Labs', files: [{ id: 'file-pitch-9' }] },
  };
}

function harness(source: string, from: { event: TriggerEvent; catalog: typeof catalog } = { event: emailEvent(), catalog }) {
  const email = makeEmailAdapter();
  const crm = makeCrmAdapter('cred-attio-1');
  const parks = makeParkSink();
  /** Every instance the host resolved to read a file's bytes. */
  const owners: Array<Parameters<ResolveFileOwner>[0]> = [];
  const resolveOwner: ResolveFileOwner = (identity) => {
    owners.push(identity);
    if (identity.adapterType === 'email') return email.adapter;
    return makeCrmAdapter(identity.credentialsId).adapter;
  };
  let spent = 0;
  const input = () => ({
    source: PRELUDE + source,
    movementName: 'intake',
    event: from.event,
    teamId: TEAM_ID,
    catalog: from.catalog,
    host: makeTestHost({
      adapters: {
        credentialId: (name: string) => (name === 'acme_main' ? 'cred-attio-1' : undefined),
        resolve: ({ adapterType }: { adapterType: string }) =>
          adapterType === 'email' ? email.adapter : crm.adapter,
      },
      llm: { transforms: pricedInvoker },
      park: { sink: parks.sink },
      files: { resolveFileText: fileTextOn(resolveOwner) },
    }),
    dryRun: false,
  });
  const record = (result: MovementRunResult): MovementRunResult => {
    spent = result.runSpentMicrodollars ?? spent;
    return result;
  };
  return {
    email,
    crm,
    parks,
    owners,
    async start(extra: { priorSpentMicrodollars?: number } = {}) {
      if (extra.priorSpentMicrodollars !== undefined) spent = extra.priorSpentMicrodollars;
      return record(await runMovement({ ...input(), ...extra }));
    },
    async resumeOnly(edit: (state: ParkedScopeState) => ParkedScopeState = (s) => s) {
      expect(parks.parks.size).toBe(1);
      const [[address, park]] = [...parks.parks.entries()];
      parks.parks.delete(address);
      return record(
        await resumeMovement({
          ...input(),
          state: edit(park.state),
          reenter: park.kind !== 'timer',
          priorSpentMicrodollars: spent,
          capBaselineMicrodollars: spent,
        }),
      );
    },
  };
}

const warnings = (trace: MovementTraceEntry[]) =>
  trace.filter((e): e is Extract<MovementTraceEntry, { kind: 'warning' }> => e.kind === 'warning');

describe('a file bound before an ordinary timer park', () => {
  const source = [
    'movement intake(m: <inbox-[:message]->>) {',
    '  files = COLLECT(m-[:files]->.data)',
    '  content = [m.`subject`, ...files]',
    '  await sleep(1h)',
    '  write crm-[:companies]-> { name: COALESCE(READ(AT(content, 1)), "unread"), summary: COALESCE(READ(ONLY(files)), "unread") }',
    '}',
  ].join('\n');

  it('is read after the resume through its owner, from the handle that parked', async () => {
    const h = harness(source);
    const first = await h.start();
    expect(first.parked).toBe(true);
    const resumed = await h.resumeOnly();
    expect(resumed.parked).toBeUndefined();
    expect(h.crm.creates).toEqual([
      { name: 'Memo: Orbit Labs builds satellites.', summary: 'Memo: Orbit Labs builds satellites.' },
    ]);
    // The bytes came through the owning adapter, by the attachment's storage key.
    expect(h.email.resolved).toEqual(['att-key-1', 'att-key-1']);
    expect(warnings(resumed.trace)).toEqual([]);
  });

  it('parks the file as its descriptor', async () => {
    const h = harness(source);
    await h.start();
    const [park] = [...h.parks.parks.values()];
    const content = park?.state.scopeChain.flatMap((scope) => Object.entries(scope.bindings)).find(([name]) => name === 'content');
    // Metadata, the owner and its handle — the descriptor as the run held it.
    expect(content?.[1]).toMatchObject({
      kind: 'value',
      value: [
        'Intros',
        {
          __brand: 'FileRef',
          name: 'memo.pdf',
          contentType: 'application/pdf',
          source: { adapterType: 'email', handle: 'att-key-1' },
        },
      ],
    });
  });

  it('parked in the spelling a run parked before this chunk holds, still resumes readable', async () => {
    const h = harness(source);
    await h.start();
    const earlierSpelling = (state: ParkedScopeState): ParkedScopeState =>
      JSON.parse(JSON.stringify(state), (key: string, value: unknown) =>
        key === 'source' && typeof value === 'object' && value !== null && 'adapterType' in value && 'handle' in value
          ? { ownerAdapterType: value.adapterType, handle: value.handle }
          : value,
      ) as ParkedScopeState;
    const resumed = await h.resumeOnly(earlierSpelling);
    expect(h.crm.creates).toEqual([
      { name: 'Memo: Orbit Labs builds satellites.', summary: 'Memo: Orbit Labs builds satellites.' },
    ]);
    expect(warnings(resumed.trace)).toEqual([]);
  });

  it('with no durable handle is unreadable, and the run says so out loud', async () => {
    const h = harness(source);
    await h.start();
    // A parked file with no way back to its bytes.
    const handleless = (state: ParkedScopeState): ParkedScopeState =>
      JSON.parse(JSON.stringify(state), (key: string, value: unknown) =>
        key === 'source' && typeof value === 'object' ? undefined : value,
      ) as ParkedScopeState;
    const resumed = await h.resumeOnly(handleless);
    expect(h.crm.creates).toEqual([{ name: 'unread', summary: 'unread' }]);
    const found = warnings(resumed.trace).filter((w) => w.code === 'MOVENG_FILE_BYTES_UNAVAILABLE');
    // Once per file, however many reads of it failed.
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toMatch(/memo\.pdf/);
    expect(found[0]?.message).toMatch(/carries no handle to its bytes/);
  });
});

describe('a file bound before a cost-cap pause inside a MAP member', () => {
  const source = [
    'movement intake(m: <inbox-[:message]->>) {',
    '  files = COLLECT(m-[:files]->.data)',
    '  content = [m.`subject`, ...files]',
    '  out = MAP(["a"], (u) => {',
    '    page = fetch_url(url: u)',
    '    return COALESCE(READ(AT(content, 1)), "unread")',
    '  })',
    '  write crm-[:companies]-> { name: JOIN(out, ",") }',
    '}',
  ].join('\n');

  it('is read in the resumed member', async () => {
    const h = harness(source);
    const first = await h.start({ priorSpentMicrodollars: 2 * DOLLAR });
    expect(first.parked).toBe(true);
    expect([...h.parks.parks.values()].map((p) => p.kind)).toEqual(['suspension']);
    const resumed = await h.resumeOnly();
    expect(resumed.parked).toBeUndefined();
    expect(h.crm.creates).toEqual([{ name: 'Memo: Orbit Labs builds satellites.' }]);
    expect(warnings(resumed.trace)).toEqual([]);
  });
});

describe('a credentialed Attio file bound before a park', () => {
  const source = [
    'movement intake(r: <crm-[:company]->>) {',
    '  files = COLLECT(r-[:files]->.data)',
    '  await sleep(1h)',
    '  write crm-[:companies]-> { name: COALESCE(READ(ONLY(files)), "unread") }',
    '}',
  ].join('\n');

  it('parks naming its instance, and its text is read after the resume through that instance, with its credential', async () => {
    const h = harness(source, { event: attioEvent(), catalog: attioFilesCatalog });
    const first = await h.start();
    expect(first.parked).toBe(true);
    const [park] = [...h.parks.parks.values()];
    const files = park?.state.scopeChain.flatMap((scope) => Object.entries(scope.bindings)).find(([name]) => name === 'files');
    expect(JSON.stringify(files?.[1])).toContain(
      JSON.stringify({ adapterType: 'attio', credentialId: 'cred-attio-1', handle: 'file-pitch-9' }),
    );

    const resumed = await h.resumeOnly();
    expect(resumed.parked).toBeUndefined();
    expect(h.crm.creates).toEqual([{ name: 'Deck: Orbit Labs raises a seed round.' }]);
    // The host resolved the owner as the descriptor named it — the credential
    // the file was read with — which is what lets Attio serve the bytes.
    expect(h.owners).toEqual([{ adapterType: 'attio', teamId: TEAM_ID, credentialsId: 'cred-attio-1' }]);
    expect(warnings(resumed.trace)).toEqual([]);
  });
});
