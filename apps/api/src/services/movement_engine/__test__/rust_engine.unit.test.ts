// The shim's half of the request/answer protocol, against a scripted engine
// double: no WASM. The real artifact's half is rust_engine_abi.unit.test.ts.

import fs from 'node:fs';
import path from 'node:path';

import { EMPTY_CATALOG_SNAPSHOT, mockCatalogSnapshot, type CatalogSnapshot } from 'movement-lang';

import { fileValue, isFileValue, tenantIdOf } from 'engine-contracts';

import { RunCostCapExceeded } from 'movement-engine/lib/run_cost';
import { containerAssociation, type Adapter } from 'movement-engine/services/translation_graph/adapter';
import { hostMethodPaths } from 'movement-engine/services/movement_engine/host';
import { AdapterCallFailed } from 'movement-engine/services/movement_engine/host_adapter';
import { MovementRunFailed, runFailureCause, runMovement, type RunMovementInput } from 'movement-engine/services/movement_engine/run';
import { openRunContext, RunLedger } from 'movement-engine/services/movement_engine/run_context';
import { ENGINE_OWN_ROUTES, shimRoutePaths } from 'movement-engine/services/movement_engine/rust_host';
import { resetRustRunStats, rustRunStats } from 'movement-engine/services/movement_engine/rust_stats';
import { REFUSED, WireOut } from 'movement-engine/services/movement_engine/rust_wire';
import { makeFakeParkSink, makeTestHost, type TestHostOverrides } from 'movement-engine/services/movement_engine/test_host';
import {
  driveEngine,
  readRunResult,
  runSegmentInRust,
  EVENT_DOES_NOT_CROSS,
  RustShimError,
  type EngineProtocol,
  type EngineStep,
  type HostAnswer,
  type HostRequest,
} from 'movement-engine/services/movement_engine/rust_engine';

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
  // The pins in this file are the protocol's fixtures: scripted engines and
  // programs no version reads differently, so version 3 throughout.
  const context = await openRunContext({ host, teamId: TEAM, languageVersion: 3, spend: {} });
  return { host, context, catalog };
}

/** A request bound for the host names the segment the driver serves. */
function inSegment(segmentId: string, args: Record<string, unknown>): Record<string, unknown> {
  return { segmentId, ...args };
}

const RESOLVE = { adapterType: 'fake', role: 'source' };

describe('the Rust engine shim', () => {
  it("answers clock.now with the host's clock, not the pin, and commits the wake the engine computed from that answer", async () => {
    const park = makeFakeParkSink();
    const host = makeTestHost({
      park: { sink: park.sink },
      clock: { now: async () => ({ nowIso: '2026-10-07T12:00:00.000Z' }) },
    });
    const context = await openRunContext({
      host,
      teamId: TEAM,
      languageVersion: 3,
      firedAt: '2026-10-07T09:00:00.000Z',
      spend: {},
    });
    const segmentId = context.segmentId;
    const { engine, answers } = scriptedEngine((seen) => {
      if (seen.length === 0) return { pending: [request(1, 'clock', 'now', inSegment(segmentId, {}))] };
      if (seen.length === 1) {
        const answer = seen[0]?.answer;
        const nowIso = answer !== undefined && 'value' in answer ? String(Reflect.get(Object(answer.value), 'nowIso')) : '';
        // The engine's arithmetic: the answer plus an hour's sleep.
        const wakeAt = new Date(new Date(nowIso).getTime() + 3_600_000).toISOString();
        return {
          pending: [
            request(2, 'park.sink', 'commitTimerPark', inSegment(segmentId, {
              address: 's0',
              state: new WireOut().value({ version: 1, address: 's0', bindingName: null, scopeChain: [] }),
              wakeAt,
              wire: true,
            })),
          ],
        };
      }
      return { done: { ok: true } };
    });
    await driveEngine(engine, { entry: 'test' }, { host, context, catalog: EMPTY_CATALOG_SNAPSHOT });
    expect(answers[0]).toEqual({ id: 1, answer: { value: { nowIso: '2026-10-07T12:00:00.000Z' } } });
    // Committed as the engine computed it: nothing re-bases it on the way.
    expect(park.timerParks.map((p) => p.wakeAt)).toEqual(['2026-10-07T13:00:00.000Z']);
  });

  it("fails the run on a clock answer naming no instant, read as the TypeScript engine reads it", async () => {
    const host = makeTestHost({ clock: { now: async () => ({ nowIso: 'soon' }) } });
    const context = await openRunContext({ host, teamId: TEAM, languageVersion: 3, firedAt: '2026-10-07T09:00:00.000Z', spend: {} });
    const { engine, answers } = scriptedEngine((seen) =>
      seen.length === 0 ? { pending: [request(1, 'clock', 'now', inSegment(context.segmentId, {}))] } : { done: { ok: true } },
    );
    await driveEngine(engine, {}, { host, context, catalog: EMPTY_CATALOG_SNAPSHOT });
    const answer = answers[0]?.answer;
    expect(answer !== undefined && 'error' in answer ? answer.error.message : answer).toBe(
      'clock.now answered {"nowIso":"soon"}, which is not { nowIso: <an ISO 8601 instant> }',
    );
  });

  it('settles every request in flight before a shim fault ends the segment', async () => {
    // Two requests in flight: the first faults the shim (a route that
    // refuses its args) while the second is still at the host. The drive
    // rethrows only once the second has settled.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const atHost = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let secondSettled = false;
    const served = await hostWith({
      control: {
        cancel: {
          cancelled: async () => {
            reached();
            await held;
            secondSettled = true;
            return false;
          },
          cancelledNow: async () => false,
        },
      },
    });
    const segmentId = served.context.segmentId;
    const { engine, finished } = scriptedEngine(() => ({
      pending: [
        request(1, 'locks', 'acquire', inSegment(segmentId, { names: 'not a list' })),
        request(2, 'control.cancel', 'cancelled', inSegment(segmentId, {})),
      ],
    }));
    const drive = driveEngine(engine, {}, served);
    let rejected = false;
    const observed = drive.then(
      () => undefined,
      (error: unknown) => {
        rejected = true;
        return error;
      },
    );
    // The second request is at the host. Past a macrotask every microtask
    // has run, the first request's fault included: the drive now waits on
    // the second alone.
    await atHost;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect({ rejected, secondSettled }).toEqual({ rejected: false, secondSettled: false });
    release();
    const error = await observed;
    expect(error).toBeInstanceOf(RustShimError);
    expect(secondSettled).toBe(true);
    expect(finished()).toBe(true);
  });

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

  it('forwards the slug an instance value holds as it is, for the host to key its registry by', async () => {
    // A registry keyed as the platform's is, by property lookup: a list reads
    // as its text, and a slug naming no adapter is the host's own error.
    const registry: Record<string, Adapter> = { fake: fakeAdapter() };
    const served = await hostWith({
      adapters: {
        resolve: ({ adapterType }) => {
          const adapter = registry[adapterType];
          if (adapter === undefined) throw new Error(`Unknown adapter type: ${adapterType}`);
          return adapter;
        },
      },
    });
    const segmentId = served.context.segmentId;
    const hostErrors: unknown[] = [];
    const { role } = RESOLVE;
    const { engine, answers } = scriptedEngine((seen) =>
      seen.length === 0
        ? {
            pending: [
              request(1, 'adapters', 'resolve', inSegment(segmentId, { adapterType: ['fake'], role })),
              request(2, 'adapters', 'resolve', inSegment(segmentId, { adapterType: 5, role })),
              request(3, 'adapters', 'resolve', inSegment(segmentId, { role })),
            ],
          }
        : seen.length < 3
          ? { pending: [] }
          : { done: null },
    );
    await driveEngine(engine, {}, { ...served, hostErrors });
    const byId = Object.fromEntries(answers.map(({ id, answer }) => [id, answer]));
    expect(byId[1]).toEqual({ value: expect.objectContaining({ adapterType: 'fake' }) });
    expect(byId[2]).toEqual({ error: { message: 'Unknown adapter type: 5', name: 'Error', ref: expect.any(Number) } });
    expect(byId[3]).toEqual({ error: { message: 'Unknown adapter type: undefined', name: 'Error', ref: expect.any(Number) } });
    expect(hostErrors).toHaveLength(2);
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

  it('answers 2,000 requests in flight, the host settling them last first, in linear work', async () => {
    const N = 2_000;
    const waiting: Array<() => void> = [];
    const served = await hostWith({
      control: {
        cancel: {
          cancelled: () => new Promise<boolean>((resolve) => waiting.push(() => resolve(false))),
          cancelledNow: async () => false,
        },
      },
    });
    const segmentId = served.context.segmentId;
    const { engine, answers } = scriptedEngine((seen) => {
      if (seen.length === 0 && waiting.length === 0) {
        return { pending: Array.from({ length: N }, (_, i) => request(i + 1, 'control.cancel', 'cancelled', inSegment(segmentId, {}))) };
      }
      return seen.length < N ? { pending: [] } : { done: seen.length };
    });
    // Every `then` attached while the segment runs: a race over the requests
    // in flight attaches one per request per answer (2,007,000 here); the
    // settle queue a constant few per request (4,000).
    const then = Promise.prototype.then;
    let thens = 0;
    Promise.prototype.then = function counted(this: Promise<unknown>, ...args: Parameters<typeof then>) {
      thens += 1;
      return then.apply(this, args);
    } as typeof then;
    try {
      const driving = driveEngine(engine, {}, served);
      // Let every request reach the host, then settle them last first.
      while (waiting.length < N) await new Promise((resolve) => setImmediate(resolve));
      for (const settle of [...waiting].reverse()) settle();
      expect(await driving).toBe(N);
    } finally {
      Promise.prototype.then = then;
    }
    expect(new Set(answers.map((a) => a.id)).size).toBe(N);
    expect(thens).toBeLessThan(20 * N);
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
                    request(2, 'trace', 'append', inSegment(segmentId, { entries: ['l', []], wire: true })),
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

  it('documents its own requests in docs/contracts/host-families.md, exactly', () => {
    const doc = fs.readFileSync(path.resolve(__dirname, '../../../../../../docs/contracts/host-families.md'), 'utf8');
    const start = doc.indexOf("## The Rust engine's requests");
    const section = doc.slice(start, doc.indexOf('\n## ', start + 1));
    const documented = [...section.matchAll(/^\| `([a-z]+\.[A-Za-z]+) \{/gm)].map((match) => match[1]);
    expect(documented.sort()).toEqual(Object.keys(ENGINE_OWN_ROUTES).sort());
  });

  // A shim bug: a result naming no writes is read as the old wire's empty
  // list (`['l', 0, []]`, rust_engine.ts `resultOf`), which the plain wire
  // refuses ("a wire list is [\"l\", items]"). Fails until the default is
  // `['l', []]`.
  it.failing('reads a result that names no writes as writing nothing', async () => {
    const context = { trace: { entries: [], published: 0 }, ledger: new RunLedger({}) };
    expect(readRunResult({ result: { movementName: 'm' } }, { context, hostErrors: [] })).toEqual({
      ran: { movementName: 'm', writes: [], trace: [], extractionSites: {} },
    });
  });

  it('reads a result, a failure and a decline, charges the cost it reports, and refuses what it does not decode yet', async () => {
    const trace = [{ kind: 'gate' as const, outcome: true }];
    const context = (entries: typeof trace = []) => ({ trace: { entries, published: 0 }, ledger: new RunLedger({}) });
    // Every result here names its writes (none: `['l', []]`); one naming
    // none is the case above.
    const none = ['l', []];
    expect(readRunResult({ result: { movementName: 'm', writes: none } }, { context: context(trace), hostErrors: [] })).toEqual({
      ran: { movementName: 'm', writes: [], trace, extractionSites: {} },
    });
    expect(readRunResult({ result: { movementName: 'm', writes: none, cancelled: true } }, { context: context(), hostErrors: [] })).toEqual({
      ran: { movementName: 'm', writes: [], trace: [], extractionSites: {}, cancelled: true },
    });
    // The cost the engine reports must be what its host was charged.
    const charged = context();
    charged.ledger.charge([{ source: 'model:judge', microdollars: 12 }]);
    const reported = { result: { movementName: 'm', writes: none }, cost: [{ source: 'model:judge', microdollars: 12 }] };
    expect(readRunResult(reported, { context: charged, hostErrors: [] })).toMatchObject({ ran: { movementName: 'm' } });
    expect(() => readRunResult(reported, { context: context(), hostErrors: [] })).toThrow(RustShimError);
    expect(readRunResult({ declined: 'a shape' }, { context: context(), hostErrors: [] })).toEqual({ declined: 'a shape' });
    expect(readRunResult({ refused: 'language_version_runs_on_typescript' }, { context: context(), hostErrors: [] })).toEqual({
      refused: 'language_version_runs_on_typescript',
    });
    expect(() => readRunResult({ refused: 1 }, { context: context(), hostErrors: [] })).toThrow(RustShimError);
    const original = new TypeError('the adapter broke');
    expect(() => readRunResult({ thrown: { hostError: 0 } }, { context: context(), hostErrors: [original] })).toThrow(original);
    expect(() =>
      readRunResult(
        { thrown: { class: 'MovementEngineError', code: 'MOVENG_NOT_FOUND', message: 'no movement' } },
        { context: context(), hostErrors: [] },
      ),
    ).toThrow('MOVENG_NOT_FOUND: no movement');
    // A cap met where the run cannot suspend: the TypeScript ledger's error, from its figures.
    let cap: unknown;
    try {
      readRunResult({ thrown: { class: 'RunCostCapExceeded', capMicrodollars: 1000, spentMicrodollars: 1500 } }, { context: context(), hostErrors: [] });
    } catch (error) {
      cap = error;
    }
    expect(cap).toBeInstanceOf(RunCostCapExceeded);
    expect(String(cap)).toBe(String(new RunCostCapExceeded(1000, 1500)));
    expect(() => readRunResult({ thrown: { class: 'RunCostCapExceeded', capMicrodollars: '1' } }, { context: context(), hostErrors: [] })).toThrow(RustShimError);
    let failed: unknown;
    try {
      readRunResult({ failed: { error: { hostError: 0 }, result: { movementName: 'm', writes: none } } }, { context: context(trace), hostErrors: [original] });
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
    const wired = ['l', [['o', Object.entries(write).map(([k, v]) => [k, typeof v === 'object' ? ['o', Object.entries(v).map(([a, b]) => [a, Array.isArray(b) ? ['l', []] : b])] : v])]]];
    expect(readRunResult({ result: { movementName: 'm', writes: wired, parked: true, parkedAddress: 's0' } }, { context: context(), hostErrors: [] })).toEqual({
      ran: { movementName: 'm', writes: [write], trace: [], extractionSites: {}, parked: true, parkedAddress: 's0' },
    });
    expect(() => readRunResult({ result: { movementName: 'm', counted: {} } }, { context: context(), hostErrors: [] })).toThrow(
      'the Rust engine result has counted, which this shim does not decode yet',
    );
    expect(() => readRunResult({ result: { movementName: 'm', writes: ['l', [1]] } }, { context: context(), hostErrors: [] })).toThrow(RustShimError);
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
  it('is read before the engine starts: an event that cannot cross fails the run, and starts nothing (a source holding a lone half crosses)', async () => {
    const asked: unknown[] = [];
    const served = await hostWith({ adapters: { resolve: (r) => (asked.push(r), fakeAdapter()) } });
    const crossing = (input: { source: string; event: unknown }) =>
      ({ ...input, teamId: TEAM, catalog: EMPTY_CATALOG_SNAPSHOT, host: served.host }) as unknown as RunMovementInput;
    resetRustRunStats();
    for (const input of [crossing({ source: '', event: { payload: { occurredAt: new Map([['at', 0]]) } } })]) {
      const { engine, started, finished } = scriptedEngine(() => ({ done: {} }));
      await expect(runSegmentInRust({ input, context: served.context }, engine)).rejects.toMatchObject({
        code: 'MOVENG_UNSUPPORTED',
        details: { reason: EVENT_DOES_NOT_CROSS },
      });
      expect(started).toEqual([]);
      expect(finished()).toBe(false);
    }
    expect(rustRunStats).toMatchObject({ segments: 0, unsupported: { [EVENT_DOES_NOT_CROSS]: 1 }, hostCalls: {} });
    expect(asked).toEqual([]);
    // The source crosses: its lone half is read as the TypeScript's parser is
    // handed it (rust_wire_round_trip.unit.test.ts runs it).
    const { engine, started } = scriptedEngine(() => ({ done: { result: {} } }));
    resetRustRunStats();
    await runSegmentInRust({ input: crossing({ source: 'x = "\ud800"', event: { payload: {} } }), context: served.context }, engine).catch(() => undefined);
    expect(rustRunStats.unsupported).toEqual({});
    expect(started).toHaveLength(1);
  });

  it('carries a dict in the event shaped like a binding as the data it is, never as a record', async () => {
    const served = await hostWith({ adapters: { resolve: () => fakeAdapter() } });
    const input = { source: '', event: { payload: { meta: { kind: 'event' }, list: [{ kind: 'toString' }] } }, teamId: TEAM, catalog: EMPTY_CATALOG_SNAPSHOT, host: served.host } as unknown as RunMovementInput;
    const { engine, started } = scriptedEngine(() => ({ done: { result: {} } }));
    resetRustRunStats();
    await runSegmentInRust({ input, context: served.context }, engine).catch(() => undefined);
    expect(rustRunStats.unsupported).toEqual({});
    // Data, as every dict is: no record tag anywhere in the input.
    expect(JSON.stringify(started)).toContain('["meta",["o",[["kind","event"]]]]');
    expect(JSON.stringify(started)).toContain('"kind","toString"');
    expect(JSON.stringify(started)).not.toContain('["x"');
  });
});

describe('a segment the Rust engine will not run', () => {
  it.each([
    ['refuses at its entry', { refused: 'language_version_runs_on_typescript' }],
    ['declines after its check', { declined: 'test_decline' }],
  ])('fails the run when the engine %s, counted by its reason, with no other engine to run it', async (_how, done) => {
    const served = await hostWith({ adapters: { resolve: () => fakeAdapter() } });
    const input = { source: '', event: { payload: {} }, teamId: TEAM, catalog: EMPTY_CATALOG_SNAPSHOT, host: served.host } as unknown as RunMovementInput;
    const { engine } = scriptedEngine(() => ({ done }));
    resetRustRunStats();
    const reason = Object.values(done)[0];
    await expect(runSegmentInRust({ input, context: served.context }, engine)).rejects.toMatchObject({ code: 'MOVENG_UNSUPPORTED', details: { reason } });
    expect(rustRunStats).toMatchObject({ segments: 1, unsupported: { [reason ?? '']: 1 }, shimFaults: 0 });
  });

  it('counts a run that ends in its own MOVENG_UNSUPPORTED mid-run as a segment it ran', async () => {
    const error = { class: 'MovementEngineError', code: 'MOVENG_UNSUPPORTED', message: 'a bound write is not supported by the movement engine yet' };
    const served = await hostWith({ adapters: { resolve: () => fakeAdapter() } });
    const input = { source: '', event: { payload: {} }, teamId: TEAM, catalog: EMPTY_CATALOG_SNAPSHOT, host: served.host } as unknown as RunMovementInput;
    const { engine } = scriptedEngine(() => ({ done: { thrown: error } }));
    resetRustRunStats();
    await expect(runSegmentInRust({ input, context: served.context }, engine)).rejects.toThrow('MOVENG_UNSUPPORTED');
    expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {}, shimFaults: 0 });
  });
});

describe('a host without the clock and ids', () => {
  it.each([4, 5])('is refused before any segment opens (version %d)', async (languageVersion) => {
    resetRustRunStats();
    const { clock: _clock, ids: _ids, ...host } = makeTestHost();
    const run = runMovement({
      source: 'function m() {\n  x = 1\n}',
      languageVersion,
      event: { pipelineInputId: 'p', adapterType: 'manual', triggerType: 'webhook', payload: {} },
      teamId: TEAM,
      catalog: EMPTY_CATALOG_SNAPSHOT,
      // A host from before the clock and ids, as a remote embedder's may be.
      host: host as unknown as RunMovementInput['host'],
    });
    await expect(run).rejects.toThrow(
      'the host does not serve clock.now, ids.mint, which host families version 1 requires (the clock, ids families); no segment was opened',
    );
    expect(rustRunStats.segments).toBe(0);
  });
});

describe("a segment's wire", () => {
  it('hands a record the engine handed out back by its id, and carries every other object as data, whatever its kind', () => {
    const wire = new WireOut();
    const event = wire.read(['x', 0, ['o', [['kind', 'event']]]]);
    expect(event).toEqual({ kind: 'event' });
    expect(wire.read(['x', 0])).toBe(event);
    expect(wire.value(event)).toEqual(['x', 0]);
    expect(wire.value([event, { kind: 'event' }])).toEqual(['l', [['x', 0], ['o', [['kind', 'event']]]]]);
    expect(wire.value({ kind: 'lazyWalk', walk: {} })).toEqual(['o', [['kind', 'lazyWalk'], ['walk', ['o', []]]]]);
    expect(() => wire.read(['x', 'handle'])).toThrow('the engine handed the host a record it cannot carry (handle)');
    expect(() => wire.read(['x', 1, ['o', [['kind', 'lazyWalk']]]])).toThrow('a record of kind lazyWalk, which the shim does not rebuild');
  });

  it('hands the engine a file as an opaque handle, keeps its descriptor, and carries a dict that spells one as data', () => {
    const wire = new WireOut();
    const descriptor = { __brand: 'FileRef' as const, name: 'deck.pdf', source: { store: 'document' as const, objectUri: 's3://x/deck.pdf' } };
    const file = fileValue(descriptor);
    // The id, the opaque identity, what it may print: no source, no URI's
    // reading, nothing of a credential.
    const written = wire.value(file);
    expect(written).toEqual(['F', 0, { handle: 's3://x/deck.pdf', name: 'deck.pdf' }]);
    expect(JSON.stringify(written)).not.toContain('store');
    // The same file again is the same id; back from the engine, the very file.
    expect(wire.value(file)).toEqual(['F', 0, { handle: 's3://x/deck.pdf', name: 'deck.pdf' }]);
    expect(wire.read(['F', 0])).toBe(file);
    expect(() => wire.read(['F', 7])).toThrow('a file 7 this segment never handed it');
    // The same keys as data: an object, never a file, on either side.
    expect(wire.value(descriptor)).toEqual(expect.arrayContaining(['o']));
    expect(isFileValue(wire.read(['o', [['__brand', 'FileRef'], ['name', 'x']]]))).toBe(false);
  });

  it('carries plain JSON: what JSON cannot say is null, a lone surrogate U+FFFD, an object reached twice written twice, a cycle refused', () => {
    const wire = new WireOut();
    expect(wire.value([undefined, NaN, Infinity, -Infinity, -0, 0])).toEqual(['l', [null, null, null, null, null, 0]]);
    expect(wire.value({ ['\uD83D']: 'a\uDE00', k: '😀' })).toEqual(['o', [['\uFFFD', 'a\uFFFD'], ['k', '😀']]]);
    const shared = { n: 1 };
    expect(wire.value({ a: shared, b: shared })).toEqual(['o', [['a', ['o', [['n', 1]]]], ['b', ['o', [['n', 1]]]]]]);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(wire.value(cycle)).toBe(REFUSED);
    expect(wire.value(Object.prototype.toString)).toBe(REFUSED);
    expect(wire.value(Object.assign(Object.create(null), { a: 1 }))).toEqual(['o', [['a', 1]]]);
    for (const gone of [['u'], ['n', 'NaN'], ['i', 0], ['r', 0], ['s16', [0xd83d]], ['p'], ['f', 'toString']]) {
      expect(() => wire.read(gone)).toThrow('an unknown wire tag');
    }
  });
});
