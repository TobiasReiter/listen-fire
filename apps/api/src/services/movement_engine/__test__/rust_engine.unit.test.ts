// The shim's half of the request/answer protocol, against a scripted engine
// double: no WASM. The real artifact's half is rust_engine_abi.unit.test.ts.

import fs from 'node:fs';
import path from 'node:path';

import { EMPTY_CATALOG_SNAPSHOT, mockCatalogSnapshot, type CatalogSnapshot } from 'movement-lang';

import { tenantIdOf } from 'engine-contracts';

import { containerAssociation, type Adapter } from '../../translation_graph/adapter';
import { hostMethodPaths } from '../host';
import { AdapterCallFailed } from '../host_adapter';
import { MovementRunFailed, runFailureCause, type RunMovementInput } from '../run';
import { openRunContext, RunLedger } from '../run_context';
import { ENGINE_OWN_ROUTES, shimRoutePaths } from '../rust_host';
import { resetRustRunStats, rustRunStats } from '../rust_stats';
import { WireOut } from '../rust_wire';
import { makeTestHost, type TestHostOverrides } from '../test_host';
import {
  assertEngineChoiceConfigured,
  driveEngine,
  engineChoice,
  readRunResult,
  runSegmentInRust,
  rustCanRun,
  EVENT_DOES_NOT_CROSS,
  RustShimError,
  type EngineProtocol,
  type EngineStep,
  type HostAnswer,
  type HostRequest,
} from '../rust_engine';

const TEAM = tenantIdOf('team-1');

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

/** The driver's input: a test host, and a segment opened on it as the run
 *  host opens one. */
async function hostWith(overrides: TestHostOverrides, catalog: CatalogSnapshot = EMPTY_CATALOG_SNAPSHOT) {
  const host = makeTestHost(overrides);
  const context = await openRunContext({ host, teamId: TEAM, languageVersion: 3, spend: {} });
  return { host, context, catalog };
}

/** A request bound for the host names the segment the driver serves. */
function inSegment(segmentId: string, args: Record<string, unknown>): Record<string, unknown> {
  return { segmentId, ...args };
}

const RESOLVE = { adapterType: 'fake', role: 'source' };

describe('the Rust engine shim', () => {
  it('forwards adapters.resolve and adapters.call, naming the segment, and answers the instance as data', async () => {
    const resolved: unknown[] = [];
    const served = await hostWith({
      adapters: {
        resolve: (input) => {
          resolved.push(input);
          return fakeAdapter();
        },
      },
    });
    const segmentId = served.context.segmentId;
    let instance = '';
    const { engine, answers, finished } = scriptedEngine((seen) => {
      if (seen.length === 0) return { pending: [request(1, 'adapters', 'resolve', inSegment(segmentId, RESOLVE))] };
      if (seen.length === 1) {
        const answer = seen[0]?.answer;
        instance = answer !== undefined && 'value' in answer ? String(Reflect.get(Object(answer.value), 'instance')) : '';
        return {
          pending: [
            request(2, 'adapters', 'call', inSegment(segmentId, {
              instance,
              method: 'getFieldValue',
              args: new WireOut().value({ position: {}, fieldId: 'Name' }),
              wire: true,
            })),
          ],
        };
      }
      return { done: { ok: true } };
    });
    const done = await driveEngine(engine, { entry: 'test' }, served);
    expect(done).toEqual({ ok: true });
    expect(resolved).toEqual([expect.objectContaining({ adapterType: 'fake', role: 'source', segmentId, teamId: TEAM })]);
    expect(answers).toEqual([
      { id: 1, answer: { value: expect.objectContaining({ instance: expect.any(String), adapterType: 'fake', methods: expect.any(Array) }) } },
      { id: 2, answer: { value: { result: new WireOut().value('value of Name') } } },
    ]);
    expect(finished()).toBe(true);
  });

  it("answers an adapter's failure as data, holding the error the TypeScript engine raises for it", async () => {
    const served = await hostWith({
      adapters: { resolve: () => fakeAdapter({ getFieldValue: async () => { throw new TypeError('remote down'); } }) },
    });
    const segmentId = served.context.segmentId;
    const hostErrors: unknown[] = [];
    const { engine, answers } = scriptedEngine((seen) => {
      if (seen.length === 0) return { pending: [request(1, 'adapters', 'resolve', inSegment(segmentId, RESOLVE))] };
      if (seen.length === 1) {
        const answer = seen[0]?.answer;
        const instance = answer !== undefined && 'value' in answer ? String(Reflect.get(Object(answer.value), 'instance')) : '';
        return {
          pending: [request(2, 'adapters', 'call', inSegment(segmentId, { instance, method: 'getFieldValue', args: new WireOut().value({}), wire: true }))],
        };
      }
      return { done: null };
    });
    await driveEngine(engine, {}, { ...served, hostErrors });
    expect(answers[1]).toEqual({
      id: 2,
      answer: { value: { error: expect.objectContaining({ kind: 'adapter_error', message: 'remote down', name: 'TypeError', ref: 0 }) } },
    });
    expect(hostErrors[0]).toBeInstanceOf(AdapterCallFailed);
    expect(hostErrors[0]).toMatchObject({ name: 'TypeError', message: 'remote down' });
  });

  it('serves requests pending at once concurrently and answers each as it settles', async () => {
    // The first request cannot settle until the second has been served, so a
    // shim that served them one after another would never finish.
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const served = await hostWith({
      adapters: {
        resolve: async () => {
          await gate;
          return fakeAdapter();
        },
      },
      control: {
        cancel: {
          cancelled: async () => {
            openGate();
            return false;
          },
          cancelledNow: async () => false,
        },
      },
    });
    const segmentId = served.context.segmentId;
    const { engine, answers } = scriptedEngine((seen) => {
      if (seen.length === 0) {
        return {
          pending: [
            request(1, 'adapters', 'resolve', inSegment(segmentId, RESOLVE)),
            request(2, 'control.cancel', 'cancelled', inSegment(segmentId, {})),
          ],
        };
      }
      return seen.length < 2 ? { pending: [] } : { done: seen.map((a) => a.id) };
    });
    const done = await driveEngine(engine, {}, served);
    expect(done).toEqual([2, 1]);
    expect(answers[0]).toEqual({ id: 2, answer: { value: false } });
  });

  it("hands the host's thrown failure to the engine as an error answer, and undefined as {}", async () => {
    const served = await hostWith({
      adapters: {
        resolve: () => {
          throw new TypeError('registry down');
        },
      },
    });
    const segmentId = served.context.segmentId;
    const { engine, answers } = scriptedEngine((seen) =>
      seen.length < 2
        ? {
            pending:
              seen.length === 0
                ? [
                    request(1, 'adapters', 'resolve', inSegment(segmentId, RESOLVE)),
                    request(2, 'trace', 'append', inSegment(segmentId, { entries: [] })),
                  ]
                : [],
          }
        : { done: null },
    );
    await driveEngine(engine, {}, served);
    expect(answers).toEqual(
      expect.arrayContaining([
        { id: 1, answer: { error: { message: 'registry down', name: 'TypeError', ref: 0 } } },
        { id: 2, answer: {} },
      ]),
    );
  });

  it('fails the run, naming the method, when an adapter returns something the eval wire cannot carry', async () => {
    const served = await hostWith({ adapters: { resolve: () => fakeAdapter({ getFieldValue: async () => () => 'a closure' }) } });
    const segmentId = served.context.segmentId;
    const { engine, finished } = scriptedEngine((seen) => {
      if (seen.length === 0) return { pending: [request(1, 'adapters', 'resolve', inSegment(segmentId, RESOLVE))] };
      const answer = seen[0]?.answer;
      const instance = answer !== undefined && 'value' in answer ? String(Reflect.get(Object(answer.value), 'instance')) : '';
      return { pending: [request(2, 'adapters', 'call', inSegment(segmentId, { instance, method: 'getFieldValue', args: new WireOut().value({}), wire: true }))] };
    });
    await expect(driveEngine(engine, {}, served)).rejects.toThrow(
      new RustShimError('adapters.call getFieldValue returned a value the eval wire cannot carry as itself'),
    );
    expect(finished()).toBe(true);
  });

  it('refuses a request it has no route for, another segment, and a method no adapter has', async () => {
    const served = await hostWith({ adapters: { resolve: () => fakeAdapter() } });
    const segmentId = served.context.segmentId;
    const run = (pending: HostRequest[]) =>
      driveEngine(scriptedEngine((seen) => (seen.length === 0 ? { pending } : { done: null })).engine, {}, served);
    await expect(run([request(1, 'llm', 'client', {})])).rejects.toThrow('the shim has no route for llm.client');
    await expect(run([request(1, 'adapters', 'resolve', inSegment('another', RESOLVE))])).rejects.toThrow(
      `adapters.resolve named segment another, not this engine's ${segmentId}`,
    );
    await expect(
      run([request(1, 'adapters', 'call', inSegment(segmentId, { instance: 'i', method: 'manifest', args: {}, wire: true }))]),
    ).rejects.toThrow('adapters.call method "manifest" is not an adapter method');
  });

  it("charges a priced call's cost to the run as its answer passes, so a later shim fault loses none of it", async () => {
    const served = await hostWith({
      llm: { arbitrateEntities: async () => ({ index: null, cost: [{ source: 'model:judge', microdollars: 9 }] }) },
    });
    const segmentId = served.context.segmentId;
    const wire = (value: unknown) => new WireOut().value(value);
    const { engine } = scriptedEngine((seen) =>
      seen.length === 0
        ? {
            pending: [
              request(1, 'llm', 'arbitrateEntities', inSegment(segmentId, {
                asserted: wire({ name: 'Acme' }),
                candidates: wire([]),
                recordType: 'company',
                constraints: wire({ any: [{ all: [{ field: 'name' }] }] }),
                languageVersion: 3,
                budget: { remainingMicrodollars: null },
              })),
            ],
          }
        : { pending: [request(2, 'nope', 'nothing', {})] },
    );
    await expect(driveEngine(engine, {}, served)).rejects.toThrow('the shim has no route for nope.nothing');
    expect(served.context.ledger.spend.bySource).toEqual({ 'model:judge': 9 });
  });

  it('refuses an engine that waits with nothing in flight', async () => {
    const { engine, finished } = scriptedEngine(() => ({ pending: [] }));
    await expect(driveEngine(engine, {}, await hostWith({}))).rejects.toThrow(
      'the Rust engine is waiting with no request in flight',
    );
    expect(finished()).toBe(true);
  });

  it('routes only host methods the manifest names, and the engine-own families it exempts', () => {
    const host = new Set(hostMethodPaths());
    for (const path of shimRoutePaths()) {
      expect({ path, routed: host.has(path) || Object.hasOwn(ENGINE_OWN_ROUTES, path) }).toEqual({ path, routed: true });
    }
    for (const path of Object.keys(ENGINE_OWN_ROUTES)) expect(host.has(path)).toBe(false);
  });

  it('documents its own requests in docs/engine-host.md, exactly', () => {
    const doc = fs.readFileSync(path.resolve(__dirname, '../../../../../../docs/engine-host.md'), 'utf8');
    const section = doc.slice(doc.indexOf("## The Rust engine's requests"), doc.indexOf('## Changes since chunk 3'));
    const documented = [...section.matchAll(/^\| `([a-z]+\.[A-Za-z]+) \{/gm)].map((match) => match[1]);
    expect(documented.sort()).toEqual(Object.keys(ENGINE_OWN_ROUTES).sort());
  });

  it('reads a result, a failure and a decline, charges the cost it reports, and refuses what it does not decode yet', async () => {
    const trace = [{ kind: 'gate' as const, outcome: true }];
    const context = (entries: typeof trace = []) => ({ trace: { entries, published: 0 }, ledger: new RunLedger({}) });
    expect(readRunResult({ result: { movementName: 'm' } }, { context: context(trace), hostErrors: [] })).toEqual({
      ran: { movementName: 'm', writes: [], trace, extractionSites: {} },
    });
    expect(readRunResult({ result: { movementName: 'm', cancelled: true } }, { context: context(), hostErrors: [] })).toEqual({
      ran: { movementName: 'm', writes: [], trace: [], extractionSites: {}, cancelled: true },
    });
    // The cost the engine reports must be what its host was charged.
    const charged = context();
    charged.ledger.charge([{ source: 'model:judge', microdollars: 12 }]);
    const reported = { result: { movementName: 'm' }, cost: [{ source: 'model:judge', microdollars: 12 }] };
    expect(readRunResult(reported, { context: charged, hostErrors: [] })).toMatchObject({ ran: { movementName: 'm' } });
    expect(() => readRunResult(reported, { context: context(), hostErrors: [] })).toThrow(RustShimError);
    expect(readRunResult({ declined: 'a shape' }, { context: context(), hostErrors: [] })).toEqual({ declined: 'a shape' });
    const original = new TypeError('the adapter broke');
    expect(() => readRunResult({ thrown: { hostError: 0 } }, { context: context(), hostErrors: [original] })).toThrow(original);
    expect(() =>
      readRunResult(
        { thrown: { class: 'MovementEngineError', code: 'MOVENG_NOT_FOUND', message: 'no movement' } },
        { context: context(), hostErrors: [] },
      ),
    ).toThrow('MOVENG_NOT_FOUND: no movement');
    let failed: unknown;
    try {
      readRunResult({ failed: { error: { hostError: 0 }, result: { movementName: 'm' } } }, { context: context(trace), hostErrors: [original] });
    } catch (error) {
      failed = error;
    }
    expect(failed).toBeInstanceOf(MovementRunFailed);
    expect(runFailureCause(failed)).toBe(original);
    if (!(failed instanceof MovementRunFailed)) throw new Error('a MovementRunFailed');
    expect(failed.partial).toEqual({ movementName: 'm', writes: [], trace, extractionSites: {} });
    const write = {
      adapterType: 'attio', recordType: 'company', created: true, committed: false, externalId: 'x1',
      writtenValues: { name: 'Acme' }, outcome: 'create', provenance: { name: [] },
    };
    const wired = ['l', 0, [['o', 1, Object.entries(write).map(([k, v]) => [k, typeof v === 'object' ? ['o', 2, Object.entries(v).map(([a, b]) => [a, Array.isArray(b) ? ['l', 3, []] : b])] : v])]]];
    expect(readRunResult({ result: { movementName: 'm', writes: wired, parked: true, parkedAddress: 's0' } }, { context: context(), hostErrors: [] })).toEqual({
      ran: { movementName: 'm', writes: [write], trace: [], extractionSites: {}, parked: true, parkedAddress: 's0' },
    });
    expect(() => readRunResult({ result: { movementName: 'm', extractionSites: {} } }, { context: context(), hostErrors: [] })).toThrow(
      'the Rust engine result has extractionSites, which this shim does not decode yet',
    );
    expect(() => readRunResult({ result: { movementName: 'm', writes: ['l', 0, [1]] } }, { context: context(), hostErrors: [] })).toThrow(RustShimError);
    expect(() => readRunResult({ parked: true }, { context: context(), hostErrors: [] })).toThrow(RustShimError);
  });
});

describe('the check host call', () => {
  const catalog = mockCatalogSnapshot({
    adapters: { manual: { constructionArgs: [] } },
  });
  const SOURCE = ['import { manual } from adapters', 'go = manual()', 'movement m(e: <go>) {', '  x = 1', '}'].join('\n');
  const check = (source: string) => request(1, 'check', 'program', { source, languageVersion: 3 });

  it("answers check.program with the TypeScript checker's diagnostics, link and stamps", async () => {
    const { engine, answers } = scriptedEngine((seen) => (seen.length === 0 ? { pending: [check(SOURCE)] } : { done: {} }));
    await driveEngine(engine, { entry: 'test' }, await hostWith({}, catalog));
    expect(answers).toEqual([{ id: 1, answer: { value: { diagnostics: expect.any(Array), stamps: [] } } }]);
  });

  it('ends the run with MOVENG_CHECK, which the engine never hears', async () => {
    const { engine, answers, finished } = scriptedEngine(() => ({ pending: [check(SOURCE.replace('x = 1', 'x = y'))] }));
    await expect(driveEngine(engine, { entry: 'test' }, await hostWith({}, catalog))).rejects.toThrow(
      /^MOVENG_CHECK: the movement program failed checking/,
    );
    expect(answers).toEqual([]);
    expect(finished()).toBe(true);
  });

});

describe('the segment input', () => {
  it('is read before the engine starts: an event or source that cannot cross declines, and starts nothing', async () => {
    const asked: unknown[] = [];
    const served = await hostWith({ adapters: { resolve: (r) => (asked.push(r), fakeAdapter()) } });
    const crossing = (input: { source: string; event: unknown }) =>
      ({ ...input, teamId: TEAM, catalog: EMPTY_CATALOG_SNAPSHOT, host: served.host }) as unknown as RunMovementInput;
    resetRustRunStats();
    for (const input of [
      crossing({ source: '', event: { payload: { occurredAt: new Date(0) } } }),
      crossing({ source: 'x = "\ud800"', event: { payload: {} } }),
    ]) {
      const { engine, started, finished } = scriptedEngine(() => ({ done: {} }));
      await expect(runSegmentInRust({ input, context: served.context }, engine)).resolves.toEqual({ declined: EVENT_DOES_NOT_CROSS });
      expect(started).toEqual([]);
      expect(finished()).toBe(false);
    }
    expect(rustRunStats).toMatchObject({ routed: 2, ranWhole: 0, declined: { [EVENT_DOES_NOT_CROSS]: 2 }, hostCalls: {} });
    expect(asked).toEqual([]);
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

  it('admits no run that could suspend', () => {
    expect(rustCanRun({ statements: [] }, {})).toBe(true);
    expect(rustCanRun({ statements: [] }, { limitPaused: true })).toBe(false);
    expect(rustCanRun({ statements: [] }, { suspendAt: ['s0'] })).toBe(false);
  });
});
