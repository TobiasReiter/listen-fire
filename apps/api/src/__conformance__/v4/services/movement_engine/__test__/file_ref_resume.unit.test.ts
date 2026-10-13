// A file bound before a park is still READABLE after the run resumes.
//
// A FileRef's byte channel (`retrieve()`) is a function, so it cannot ride the
// parked state. What rides is the producer's durable handle (`source`), and the
// resume rebinds the channel through the owning adapter. These tests drive the
// real interpreter through an ordinary timer park and through a cost-cap pause
// inside a MAP member, and pin the loud warning a file with no handle gives.

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { Readable } from 'node:stream';
import { resumeMovement, runMovement, type MovementRunResult, type ParkSink, type RunLimitPause } from '../run';
import type { FileTextResolution, MovementTraceEntry } from '../expression';
import type { MovementTransformInvoker } from '../extraction';
import type { ParkedScopeState } from '../serialize';
import { assertRunBudget, reportRunCost } from '../../../lib/run_spend';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import type { Adapter, FileRef, RuntimeCapabilities } from '../../translation_graph/adapter';
import { streamFileRef } from '../../translation_graph/engine/files/retrieve';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { makeUnstablePosition, positionData, type TransformOutputShape } from '../../translation_graph/types';
import { getTransform } from '../../translation_graph/engine/transforms/registry';
import type { TeamId } from '../../../generated/kysely/core/Team';

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

/** The bytes the attachment's storage holds, by its storage key. */
const STORED: Record<string, string> = { 'att-key-1': 'Memo: Orbit Labs builds satellites.' };

/** An inbound email's attachment, as its producer makes it: a byte channel of
 *  its own, plus the durable handle the owner can redeem. */
function attachmentFileRef(key: string): FileRef {
  return {
    __brand: 'FileRef',
    name: 'memo.pdf',
    contentType: 'application/pdf',
    retrieve: async () => ({ stream: Readable.from([Buffer.from(STORED[key] ?? '')]) }),
    source: { ownerAdapterType: 'email', handle: key },
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
      const key = ref.source?.handle ?? '';
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

function makeCrmAdapter() {
  const creates: Array<Record<string, unknown>> = [];
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
    async getFieldValue() {
      return undefined;
    },
    async getRelated() {
      return [];
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
  return { adapter, creates };
}

/** The file→text seam as production builds it, minus OCR: the FileRef's own
 *  byte channel, read to text. A channel that is missing or fails is
 *  `bytes_unavailable`, exactly as `makeFileTextResolver` answers. */
async function resolveFileText(ref: FileRef): Promise<FileTextResolution> {
  try {
    const { stream } = await streamFileRef(ref);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return { text: Buffer.concat(chunks).toString('utf8') };
  } catch (error) {
    return { unreadable: 'bytes_unavailable', detail: error instanceof Error ? error.message : String(error) };
  }
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

const catalog = staticCatalogFromManifests({
  credentials: { acme_main: { adapters: ['attio'] } },
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
      await input.correlate('run-1');
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

function harness(source: string) {
  const email = makeEmailAdapter();
  const crm = makeCrmAdapter();
  const parks = makeParkSink();
  let spent = 0;
  const input = () => ({
    source: PRELUDE + source,
    movementName: 'intake',
    event: emailEvent(),
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: (name: string) => (name === 'acme_main' ? 'cred-attio-1' : undefined),
    resolveAdapter: ({ adapterType }: { adapterType: string }) =>
      adapterType === 'email' ? email.adapter : crm.adapter,
    transformInvoker: pricedInvoker,
    resolveFileText,
    parkSink: parks.sink,
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

  it('parks the file in its wire form — the shape a park written before this fix also has', async () => {
    const h = harness(source);
    await h.start();
    const [park] = [...h.parks.parks.values()];
    const content = park?.state.scopeChain.flatMap((scope) => Object.entries(scope.bindings)).find(([name]) => name === 'content');
    // Metadata and the owner's handle; the byte channel stayed behind. A state
    // parked by the earlier writer holds exactly this, so it resumes readable.
    expect(content?.[1]).toMatchObject({
      kind: 'value',
      value: [
        'Intros',
        {
          __brand: 'FileRef',
          name: 'memo.pdf',
          contentType: 'application/pdf',
          source: { ownerAdapterType: 'email', handle: 'att-key-1' },
        },
      ],
    });
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
    expect(found[0]?.message).toMatch(/parked without a durable handle/);
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
