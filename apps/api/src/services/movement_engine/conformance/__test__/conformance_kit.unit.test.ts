// The host-conformance kit's own units: the recorder writes a run down as it
// crossed (each request with the requests answered before it), a recording
// replays against the in-process and HTTP targets, the matching rule allows
// concurrency and names the first divergence or reordering, and the HTTP host
// double carries every family's request and answer across a wire.

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';

jest.mock('../../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { tenantIdOf } from 'engine-contracts';
import {
  RecordedConversation,
  hostRecordingSchema,
  type HostRecording,
  type RecordedRequest,
} from 'engine-contracts/conformance';

import { staticCatalogSnapshot } from '../../../translation_graph/movement/catalog';
import type { Adapter, RuntimeCapabilities } from '../../../translation_graph/adapter';
import { positionData } from '../../../translation_graph/types';
import { RunCancelledSignal } from '../../errors';
import { VOID_HOST_METHODS, hostMethodPaths, type EngineHost } from '../../host';
import { runMovement } from '../../run';
import { credentialIdsFor, makeTestHost } from '../../test_host';
import { NotJson } from '../../__test__/round_trip_host';
import { startHostDouble, httpHost, type HostDouble } from '../http_host_double';
import { recordEntry } from '../recorder';
import { httpTarget, typescriptTarget } from '../replay';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000c1');

function fakeAdapter(adapterType: string): Adapter {
  let created = 0;
  return {
    adapterType,
    supportedTriggers: [] as never[],
    runtimeCapabilities: (): RuntimeCapabilities => ({ traversal: { incoming: true, edgeProperties: true }, resources: true }),
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
      const data = positionData(position);
      return typeof data === 'object' && data !== null ? Reflect.get(data, fieldId) : undefined;
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      created += 1;
      return { adapterType, externalId: `ext-${created}`, data: { ...input.fields } };
    },
    async updateRecord() {
      throw new Error('no updates expected');
    },
    async deleteRecord() {
      return {};
    },
  };
}

const catalog = staticCatalogSnapshot({ credentials: { acme_main: { adapters: ['attio'] } } });

const SOURCE = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  '',
  'inbox = email()',
  'crm = attio(credentials: acme_main)',
  '',
  'movement intake(m: <inbox-[:message]->>) {',
  '  write crm-[:companies]-> { name: "Acme" }',
  '  write crm-[:companies]-> { name: "Beta" }',
  '}',
].join('\n');

function input(host: EngineHost) {
  return {
    source: SOURCE,
    movementName: 'intake',
    event: { pipelineInputId: 'pi-kit', adapterType: 'email', triggerType: 'webhook' as const, payload: {} },
    teamId: TEAM_ID,
    catalog,
    credentialIds: credentialIdsFor(catalog, (name) => (name === 'acme_main' ? 'cred-attio-1' : undefined)),
    host,
  };
}

function testHost(): EngineHost {
  const adapters: Record<string, Adapter> = { email: fakeAdapter('email'), attio: fakeAdapter('attio') };
  return makeTestHost({
    adapters: {
      resolve: ({ adapterType }: { adapterType: string }) => {
        const adapter = adapters[adapterType];
        if (adapter === undefined) throw new Error(`no ${adapterType}`);
        return adapter;
      },
    },
  });
}

type RunRecording = Extract<HostRecording, { entry: 'run' }>;

async function recorded(host: EngineHost = testHost()): Promise<RunRecording> {
  const kept: HostRecording[] = [];
  await recordEntry({ entry: 'run', input: input(host), run: runMovement, keep: (r) => kept.push(r) });
  const [recording] = kept;
  if (recording === undefined || kept.length !== 1) throw new Error(`recorded ${kept.length} entries`);
  if (recording.entry !== 'run') throw new Error(`recorded a ${recording.entry}`);
  return recording;
}

const paths = (recording: HostRecording): string[] => recording.requests.map((r) => `${r.family}.${r.method}`);

describe('the recorder', () => {
  it('writes one run down as it crossed: input, every request in order with its answer and what it came after, the result', async () => {
    const recording = await recorded();
    expect(hostRecordingSchema.safeParse(JSON.parse(JSON.stringify(recording))).success).toBe(true);
    expect(recording.entry).toBe('run');
    expect(recording.input).not.toHaveProperty('host');
    expect(recording.input.languageVersion).toBe(3);
    expect(paths(recording)[0]).toBe('segment.open');
    expect(paths(recording).at(-1)).toBe('segment.close');
    const creates = recording.requests.filter(
      (r) => r.family === 'adapters' && r.method === 'call' && JSON.stringify(r.args).includes('createRecord'),
    );
    expect(creates).toHaveLength(2);
    expect(creates[0]).toMatchObject({ answer: { result: { externalId: 'ext-1' } } });
    expect(recording.result).toMatchObject({ movementName: 'intake', writes: [{ externalId: 'ext-1' }, { externalId: 'ext-2' }] });
    expect(recording.methods).toContain('park.wake');
    expect(recording.methods).not.toContain('park.sink.commitTimerPark');
    // A run with nothing concurrent in it: each request came after the one
    // before, which implies all the others.
    expect(recording.requests.map((r) => r.after)).toEqual(recording.requests.map((_, i) => (i === 0 ? [] : [i - 1])));
  });

  it('records a host method that throws rather than rejecting, and the engine still sees the throw', async () => {
    const host = testHost();
    const throwing: EngineHost = {
      ...host,
      control: {
        cancel: {
          ...host.control.cancel,
          cancelled: () => {
            throw new Error('the gate is down');
          },
        },
      },
    };
    const kept: HostRecording[] = [];
    await expect(
      recordEntry({ entry: 'run', input: input(throwing), run: runMovement, keep: (r) => kept.push(r) }),
    ).rejects.toThrow('the gate is down');
    expect(kept[0]?.requests.find((r) => r.method === 'cancelled')).toMatchObject({
      error: { class: 'Error', message: 'the gate is down' },
    });
  });

  it('refuses a request made after the entry ended, and says so', async () => {
    const late: string[] = [];
    let captured: EngineHost | undefined;
    await recordEntry({
      entry: 'run',
      input: input(testHost()),
      run: (entered) => {
        captured = entered.host;
        return runMovement(entered);
      },
      keep: () => undefined,
      late: (message) => late.push(message),
    });
    expect(() => captured?.control.cancel.cancelled({ segmentId: 'test-segment-1' })).toThrow(
      'host request control.cancel.cancelled was made after the entry ended',
    );
    expect(late).toEqual(['host request control.cancel.cancelled was made after the entry ended']);
  });

  it('refuses an answer JSON cannot carry, naming the method', async () => {
    const host = testHost();
    const broken: EngineHost = {
      ...host,
      segment: { ...host.segment, open: async () => ({ segmentId: 's-1', at: new Date() }) },
    };
    await expect(recorded(broken)).rejects.toThrow(NotJson);
    await expect(recorded(broken)).rejects.toThrow(/segment\.open: answer\.at is an instance of Date/);
  });
});

describe('a replay', () => {
  let http: Awaited<ReturnType<typeof httpTarget>>;
  beforeAll(async () => {
    http = await httpTarget();
  });
  afterAll(async () => {
    await http.close();
  });

  it('of an unchanged recording is the same against the in-process and HTTP targets', async () => {
    const recording = await recorded();
    expect(await typescriptTarget.replay(recording)).toEqual({ kind: 'same' });
    expect(await http.replay(recording)).toEqual({ kind: 'same' });
  });

  it('names the first request the recording has no counterpart for', async () => {
    const recording = await recorded();
    const requests = recording.requests.map((r): RecordedRequest =>
      JSON.stringify(r.args).includes('"Beta"') ? { ...r, args: JSON.parse(JSON.stringify(r.args).replace('"Beta"', '"Gamma"')) } : r,
    );
    const verdict = await typescriptTarget.replay({ ...recording, requests });
    expect(verdict.kind).toBe('diverged');
    expect(verdict).toMatchObject({
      divergence: expect.stringMatching(/^request #\d+ adapters\.call .*"Beta".* has no recorded counterpart; the first unserved adapters\.call recorded was #\d+ .*"Gamma"/),
    });
    expect(await http.replay({ ...recording, requests })).toMatchObject({ kind: 'diverged' });
  });

  it('names a recorded request the replay never made', async () => {
    const recording = await recorded();
    const extra: RecordedRequest = {
      family: 'park',
      method: 'wake',
      args: { segmentId: 'test-segment-1', adapterType: 'x', correlationKey: 'k' },
      after: [],
    };
    const verdict = await typescriptTarget.replay({ ...recording, requests: [...recording.requests, extra] });
    expect(verdict).toEqual({
      kind: 'diverged',
      divergence: expect.stringMatching(/^recorded request #\d+ park\.wake .* was never made$/),
    });
  });

  it('lets a request made sooner than recorded wait for what it was recorded after', async () => {
    const conversation = new RecordedConversation([
      { family: 'locks', method: 'acquire', args: { segmentId: 's', names: ['a'] }, after: [], answer: { token: 't-a' } },
      { family: 'locks', method: 'acquire', args: { segmentId: 's', names: ['b'] }, after: [0], answer: { token: 't-b' } },
    ]);
    const order: string[] = [];
    const b = conversation.answer('locks.acquire', { segmentId: 's', names: ['b'] }).then((served) => {
      order.push('b');
      return served;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual([]);
    // B waited; A's request releases it.
    expect(await conversation.answer('locks.acquire', { segmentId: 's', names: ['a'] })).toEqual({ answer: { token: 't-a' } });
    expect(await b).toEqual({ answer: { token: 't-b' } });
    expect(order).toEqual(['b']);
    expect(conversation.firstDivergence()).toBeUndefined();
  });

  it('names a causal reordering: a request made before one it waits on, which the replay never makes', async () => {
    const recording = await recorded();
    const creates = recording.requests.flatMap((r, i) =>
      r.family === 'adapters' && r.method === 'call' && JSON.stringify(r.args).includes('createRecord') ? [i] : [],
    );
    const [acme, beta] = creates;
    if (acme === undefined || beta === undefined) throw new Error('two creates expected');
    // The recording now says Acme's create was made only once Beta's was
    // answered — but the engine makes Beta's only once Acme's is answered.
    const requests = recording.requests.map((r, i) => (i === acme ? { ...r, after: [...r.after, beta] } : r));
    for (const target of [typescriptTarget, http]) {
      const verdict = await target.replay({ ...recording, requests });
      expect(verdict).toMatchObject({
        kind: 'diverged',
        divergence: expect.stringMatching(
          new RegExp(`^request #\\d+ adapters\\.call .*"Acme".* was made before recorded request #${beta + 1} adapters\\.call .*"Beta".*the replay reordered them$`),
        ),
      });
    }
  });

  it('names where the result differs when the requests match', async () => {
    const recording = await recorded();
    const result = JSON.parse(JSON.stringify(recording.result).replace('"intake"', '"outtake"'));
    expect(await typescriptTarget.replay({ ...recording, result })).toEqual({
      kind: 'diverged',
      divergence: 'the results differ at result.movementName: recorded "outtake", replayed "intake"',
    });
  });

  it('compares a failure by class, code and message', async () => {
    const recording = await recorded();
    const failing = { ...recording, input: { ...recording.input, source: `${SOURCE}\nnot a statement` } };
    const failure = { class: 'MovementEngineError', code: 'MOVENG_PARSE', message: 'MOVENG_PARSE: wrong' };
    const verdict = await typescriptTarget.replay({ ...failing, requests: [], result: undefined, failure });
    expect(verdict).toMatchObject({ kind: 'diverged', divergence: expect.stringContaining('recorded the failure') });
  });
});

describe('the HTTP host double', () => {
  let double: HostDouble;
  beforeAll(async () => {
    double = await startHostDouble();
  });
  afterAll(async () => {
    await double.close();
  });

  it('carries every family\'s request and answer, an answer of nothing and a thrown error across the wire', async () => {
    const voids: ReadonlySet<string> = new Set(VOID_HOST_METHODS);
    const all = hostMethodPaths();
    const requests: RecordedRequest[] = all.map((path, i) => {
      const dot = path.lastIndexOf('.');
      const request = { family: path.slice(0, dot), method: path.slice(dot + 1), args: { segmentId: 's-1', n: i }, after: [] };
      return voids.has(path) ? request : { ...request, answer: { answered: path, nested: [i, null, 'é'] } };
    });
    requests.push({
      family: 'control.cancel',
      method: 'cancelled',
      args: { segmentId: 's-2' },
      after: [],
      error: { class: 'RunCancelledSignal', message: 'run cancelled by user request' },
    });
    const conversation = new RecordedConversation(requests);
    double.serve(conversation);
    const host = httpHost(double.url, all);
    const call = (path: string, request: unknown): Promise<unknown> => {
      let at: unknown = host;
      let owner: unknown = host;
      for (const key of path.split('.')) {
        owner = at;
        at = typeof at === 'object' && at !== null ? Reflect.get(at, key) : undefined;
      }
      if (typeof at !== 'function' || typeof owner !== 'object' || owner === null) throw new Error(`no ${path}`);
      return Reflect.apply(at, owner, [request]);
    };
    for (const [i, path] of all.entries()) {
      const answer = await call(path, { segmentId: 's-1', n: i });
      expect([path, answer]).toEqual([path, voids.has(path) ? undefined : { answered: path, nested: [i, null, 'é'] }]);
    }
    await expect(call('control.cancel.cancelled', { segmentId: 's-2' })).rejects.toBeInstanceOf(RunCancelledSignal);
    expect(conversation.firstDivergence()).toBeUndefined();
    await expect(call('segment.open', { teamId: 'x' })).rejects.toThrow(/has no recorded counterpart/);
  });
});
