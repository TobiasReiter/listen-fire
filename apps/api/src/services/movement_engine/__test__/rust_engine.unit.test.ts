// The shim's half of the request/answer protocol, against a scripted engine
// double: no WASM. The real artifact's half is rust_engine_abi.unit.test.ts.

import type { TeamId } from '../../../generated/kysely/core/Team';

import { containerAssociation, type Adapter } from '../../translation_graph/adapter';
import { makeTestHost, type TestHostOverrides } from '../host';
import {
  assertEngineChoiceConfigured,
  driveEngine,
  engineChoice,
  readRunResult,
  runSegmentInRust,
  rustCanRun,
  RustShimError,
  type EngineProtocol,
  type EngineStep,
  type HostAnswer,
  type HostRequest,
} from '../rust_engine';

const TEAM = 'team-1' as TeamId;

/** A double that issues what `script` says, step by step: each reply is
 *  computed from every answer received so far, so a test can assert both
 *  what the shim answered and in what order. */
function scriptedEngine(script: (answers: Array<{ id: number; answer: HostAnswer }>) => EngineStep): {
  engine: EngineProtocol;
  answers: Array<{ id: number; answer: HostAnswer }>;
  started: unknown[];
  finished: () => boolean;
} {
  const answers: Array<{ id: number; answer: HostAnswer }> = [];
  const started: unknown[] = [];
  let finished = false;
  return {
    engine: {
      start(input) {
        started.push(input);
        return script(answers);
      },
      answer(id, answer) {
        answers.push({ id, answer });
        return script(answers);
      },
      finish() {
        finished = true;
      },
    },
    answers,
    started,
    finished: () => finished,
  };
}

function request(id: number, family: string, method: string, args: unknown): HostRequest {
  return { id, family, method, args };
}

function fakeAdapter(methods: Partial<Adapter> = {}): Adapter {
  return {
    adapterType: 'fake',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ fieldId }) => `value of ${fieldId}`,
    getRelated: async () => [],
    createRecord: async () => ({ adapterType: 'fake', externalId: 'r1', recordType: 'T', data: {} }),
    updateRecord: async (input) => ({
      adapterType: 'fake',
      externalId: input.externalId,
      data: {},
      association: containerAssociation(input),
    }),
    deleteRecord: async () => ({}),
    ...methods,
  };
}

function hostWith(overrides: TestHostOverrides) {
  return { host: makeTestHost(overrides), teamId: TEAM };
}

const RESOLVE = { adapterType: 'fake', teamId: TEAM, role: 'source' };

describe('the Rust engine shim', () => {
  it('answers adapters.resolve with an instance handle, then calls that live adapter by it', async () => {
    const resolved: unknown[] = [];
    const { engine, answers, finished } = scriptedEngine((seen) => {
      if (seen.length === 0) return { pending: [request(1, 'adapters', 'resolve', RESOLVE)] };
      if (seen.length === 1) {
        return {
          pending: [
            request(2, 'adapters', 'call', {
              instance: 1,
              method: 'getFieldValue',
              args: [{ position: {}, fieldId: 'Name' }],
            }),
          ],
        };
      }
      return { done: { ok: true } };
    });
    const adapter = fakeAdapter();
    const done = await driveEngine(
      engine,
      { entry: 'test' },
      hostWith({
        adapters: {
          resolve: (input) => {
            resolved.push(input);
            return adapter;
          },
        },
      }),
    );
    expect(done).toEqual({ ok: true });
    expect(resolved).toEqual([{ adapterType: 'fake', teamId: TEAM, role: 'source' }]);
    expect(answers).toEqual([
      { id: 1, answer: { value: { instance: 1 } } },
      { id: 2, answer: { value: 'value of Name' } },
    ]);
    expect(finished()).toBe(true);
  });

  it('serves requests pending at once concurrently and answers each as it settles', async () => {
    // The first request cannot settle until the second has been served, so a
    // shim that served them one after another would never finish.
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const { engine, answers } = scriptedEngine((seen) => {
      if (seen.length === 0) {
        return {
          pending: [
            request(1, 'adapters', 'resolve', RESOLVE),
            request(2, 'adapters', 'credentialId', { credentialName: 'crm' }),
          ],
        };
      }
      return seen.length < 2 ? { pending: [] } : { done: seen.map((a) => a.id) };
    });
    const done = await driveEngine(
      engine,
      {},
      hostWith({
        adapters: {
          resolve: async () => {
            await gate;
            return fakeAdapter();
          },
          credentialId: () => {
            openGate();
            return 'cred-1';
          },
        },
      }),
    );
    expect(done).toEqual([2, 1]);
    expect(answers).toEqual([
      { id: 2, answer: { value: 'cred-1' } },
      { id: 1, answer: { value: { instance: 1 } } },
    ]);
  });

  it("hands the host's failure to the engine as an error answer, and undefined as {}", async () => {
    const { engine, answers } = scriptedEngine((seen) =>
      seen.length < 2
        ? {
            pending:
              seen.length === 0
                ? [
                    request(1, 'adapters', 'resolve', RESOLVE),
                    request(2, 'adapters', 'credentialId', { credentialName: 'none' }),
                  ]
                : [],
          }
        : { done: null },
    );
    await driveEngine(
      engine,
      {},
      hostWith({
        adapters: {
          resolve: () => {
            throw new TypeError('registry down');
          },
        },
      }),
    );
    expect(answers).toEqual(
      expect.arrayContaining([
        { id: 1, answer: { error: { message: 'registry down', name: 'TypeError' } } },
        { id: 2, answer: {} },
      ]),
    );
  });

  it('fails the run, naming the method, when an adapter returns something JSON cannot carry', async () => {
    const { engine, finished } = scriptedEngine((seen) =>
      seen.length === 0
        ? { pending: [request(1, 'adapters', 'resolve', RESOLVE)] }
        : { pending: [request(2, 'adapters', 'call', { instance: 1, method: 'getFieldValue', args: [{}] })] },
    );
    const adapter = fakeAdapter({ getFieldValue: async () => () => 'a closure' });
    await expect(driveEngine(engine, {}, hostWith({ adapters: { resolve: () => adapter } }))).rejects.toThrow(
      new RustShimError('adapters.call getFieldValue returned a function, which is not plain JSON'),
    );
    expect(finished()).toBe(true);
  });

  it('names where in the result the unrepresentable value sits', async () => {
    const { engine } = scriptedEngine((seen) =>
      seen.length === 0
        ? { pending: [request(1, 'adapters', 'resolve', RESOLVE)] }
        : { pending: [request(2, 'adapters', 'call', { instance: 1, method: 'getFieldValue', args: [{}] })] },
    );
    const adapter = fakeAdapter({ getFieldValue: async () => ({ when: [{ at: new Date(0) }] }) });
    await expect(driveEngine(engine, {}, hostWith({ adapters: { resolve: () => adapter } }))).rejects.toThrow(
      'adapters.call getFieldValue returned a Date at when[0].at, which is not plain JSON',
    );
  });

  it('refuses a request it has no route for, an unknown instance and a missing method', async () => {
    const run = (pending: HostRequest[]) =>
      driveEngine(
        scriptedEngine((seen) => (seen.length === 0 ? { pending } : { done: null })).engine,
        {},
        hostWith({ adapters: { resolve: () => fakeAdapter() } }),
      );
    await expect(run([request(1, 'llm', 'client', {})])).rejects.toThrow('the shim has no route for llm.client');
    await expect(run([request(1, 'adapters', 'call', { instance: 4, method: 'describe', args: [] })])).rejects.toThrow(
      'adapters.call describe: no adapter instance 4',
    );
    await expect(run([request(1, 'adapters', 'resolve', { ...RESOLVE, teamId: 'other' })])).rejects.toThrow(
      'adapters.resolve asked for team other in a run of another team',
    );
  });

  it('refuses an engine that waits with nothing in flight', async () => {
    const { engine, finished } = scriptedEngine(() => ({ pending: [] }));
    await expect(driveEngine(engine, {}, hostWith({}))).rejects.toThrow(
      'the Rust engine is waiting with no request in flight',
    );
    expect(finished()).toBe(true);
  });

  it('reads a result with nothing in it, and refuses what it does not decode yet', () => {
    expect(readRunResult({ movementName: 'm', writes: [], trace: [], extractionSites: {} })).toEqual({
      movementName: 'm',
      writes: [],
      trace: [],
      extractionSites: {},
    });
    expect(() => readRunResult({ movementName: 'm', writes: [{}], trace: [] })).toThrow(
      'the Rust engine result has writes this shim does not decode yet',
    );
    expect(() => readRunResult({ movementName: 'm', writes: [], trace: [], parked: true })).toThrow(
      'the Rust engine result has parked, which this shim does not decode yet',
    );
  });
});

describe('the segment input', () => {
  it('is read before the engine starts: one that cannot cross starts nothing', async () => {
    const { engine, started, finished } = scriptedEngine(() => ({ done: {} }));
    const input = {
      source: '',
      event: { occurredAt: new Date(0) },
      teamId: TEAM,
      catalog: {},
      host: makeTestHost(),
    } as unknown as Parameters<typeof runSegmentInRust>[0];
    await expect(runSegmentInRust(input, engine)).rejects.toThrow(RustShimError);
    expect(started).toEqual([]);
    expect(finished()).toBe(false);
  });
});

describe('choosing the engine', () => {
  it('reads MOVEMENT_ENGINE: unset or ts is the TypeScript engine, rust the Rust one, anything else refused', () => {
    expect(engineChoice({})).toBe('ts');
    expect(engineChoice({ MOVEMENT_ENGINE: 'ts' })).toBe('ts');
    expect(engineChoice({ MOVEMENT_ENGINE: 'rust' })).toBe('rust');
    expect(() => engineChoice({ MOVEMENT_ENGINE: 'Rust' })).toThrow('MOVEMENT_ENGINE is "Rust"');
  });

  it('refuses a bad MOVEMENT_ENGINE at boot', () => {
    expect(() => assertEngineChoiceConfigured({ MOVEMENT_ENGINE: 'wasm' })).toThrow('MOVEMENT_ENGINE is "wasm"');
    expect(() => assertEngineChoiceConfigured({})).not.toThrow();
  });

  it('lets no program through to the Rust engine yet', () => {
    expect(rustCanRun({ statements: [] })).toBe(false);
  });
});
