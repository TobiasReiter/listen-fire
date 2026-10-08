// A segment's engine state: the run's spend account, the priced host calls
// made under its budget, and a segment's opening and closing (its host segment,
// its cross-run lock holder). The cap is data here — the engine never reads
// the environment.

import type { InstanceSchema } from 'movement-lang';

import { HOST_FAMILIES_VERSION, tenantIdOf } from 'engine-contracts';
import type { Adapter, WriteInput } from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';

import { isRunCostCapExceeded, RunCostCapExceeded, type Budget } from '../../../lib/run_cost';
import { InMemoryWriteLocks, type WriteLockHolder, type WriteLocks } from '../../write_locks/write_locks';
import { makeFakeParkSink, makeTestHost } from '../test_host';
import { NEVER_CANCELLED } from '../host_kit';
import { runMovement } from '../run';
import { RunCancelledSignal } from '../errors';
import {
  closeRunContext,
  openRunContext,
  pricedCalls,
  RunLedger,
  runLogFields,
  throwIfCancelled,
} from '../run_context';
import { teamOfTenant } from '../../translation_graph/movement/tenant';

const DOLLAR = 1_000_000;
const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000061');
const SCRAPE = 'service:brightdata.web_unlocker';

function caught(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("the run's spend account", () => {
  it('with no cap, spends without limit, still knows what it spent, and hands out an unlimited budget', () => {
    const ledger = new RunLedger({});
    for (let i = 0; i < 100; i++) {
      ledger.check();
      ledger.charge([{ source: SCRAPE, microdollars: DOLLAR }]);
    }
    expect(ledger.spend.segmentMicrodollars).toBe(100 * DOLLAR);
    expect(ledger.budget()).toEqual({ remainingMicrodollars: null });
  });

  it('the call that crosses the cap goes through; the NEXT priced call is refused', () => {
    const ledger = new RunLedger({ capMicrodollars: 2.5 * DOLLAR });
    ledger.check();
    ledger.charge([{ source: SCRAPE, microdollars: 2 * DOLLAR }]);
    expect(ledger.budget()).toEqual({ remainingMicrodollars: 0.5 * DOLLAR });
    ledger.check();
    ledger.charge([{ source: SCRAPE, microdollars: DOLLAR }]); // over now
    const err = caught(() => ledger.check());
    expect(isRunCostCapExceeded(err)).toBe(true);
    expect(err).toBeInstanceOf(RunCostCapExceeded);
    expect((err as RunCostCapExceeded).capMicrodollars).toBe(2.5 * DOLLAR);
    expect((err as RunCostCapExceeded).spentMicrodollars).toBe(3 * DOLLAR);
    expect(ledger.budget()).toEqual({ remainingMicrodollars: -0.5 * DOLLAR });
  });

  it("its message is the author's whole failure surface: the cap, the spend, the knob, how to raise it", () => {
    const ledger = new RunLedger({ capMicrodollars: 2.5 * DOLLAR });
    ledger.charge([{ source: SCRAPE, microdollars: 3 * DOLLAR }]);
    expect(() => ledger.check()).toThrow(
      'Run cost cap reached: this run has spent $3.00 on model calls and paid services, ' +
        'and the limit set by MOVEMENT_MAX_RUN_COST_USD is $2.50. ' +
        'The run was stopped before its next priced call in case something was looping. ' +
        "If this run legitimately needs more, raise MOVEMENT_MAX_RUN_COST_USD in the server's environment " +
        '(or unset it to remove the cap).',
    );
  });

  it('a $0.016 cap does not read as a higher figure than the spend that met it', () => {
    const ledger = new RunLedger({ capMicrodollars: 16_000 });
    ledger.charge([{ source: 'model:m', microdollars: 25_400 }]);
    expect(() => ledger.check()).toThrow(/has spent \$0\.0254 .* is \$0\.016\./);
  });

  it('a resumed segment is seeded with what the run spent before it parked: the cap holds across parks', () => {
    const ledger = new RunLedger({ capMicrodollars: 2.5 * DOLLAR, priorMicrodollars: 2 * DOLLAR });
    ledger.check();
    ledger.charge([{ source: SCRAPE, microdollars: DOLLAR }]);
    expect(ledger.spend).toEqual({
      segmentMicrodollars: DOLLAR,
      runMicrodollars: 3 * DOLLAR,
      bySource: { [SCRAPE]: DOLLAR },
    });
    expect((caught(() => ledger.check()) as RunCostCapExceeded).spentMicrodollars).toBe(3 * DOLLAR);
  });

  it('a segment seeded at or over the cap refuses its first priced call', () => {
    const ledger = new RunLedger({ capMicrodollars: 2.5 * DOLLAR, priorMicrodollars: 2.5 * DOLLAR });
    expect(() => ledger.check()).toThrow(RunCostCapExceeded);
    expect(ledger.budget()).toEqual({ remainingMicrodollars: 0 });
  });

  it('a run resumed from a limit pause counts toward the cap from that point only', () => {
    const ledger = new RunLedger({
      capMicrodollars: 2.5 * DOLLAR,
      priorMicrodollars: 3 * DOLLAR,
      capBaselineMicrodollars: 3 * DOLLAR,
    });
    ledger.check();
    expect(ledger.budget()).toEqual({ remainingMicrodollars: 2.5 * DOLLAR });
    ledger.charge([{ source: SCRAPE, microdollars: 2.5 * DOLLAR }]);
    expect((caught(() => ledger.check()) as RunCostCapExceeded).spentMicrodollars).toBe(2.5 * DOLLAR);
  });

  it('every charge is summed by where it went', () => {
    const ledger = new RunLedger({});
    ledger.charge([
      { source: SCRAPE, microdollars: 1_500 },
      { source: 'model:claude-sonnet-5', microdollars: 2 * DOLLAR },
    ]);
    ledger.charge([
      { source: SCRAPE, microdollars: 1_500 },
      { source: 'plugin:fetch_url', microdollars: 700 },
    ]);
    ledger.charge(undefined);
    expect(ledger.spend.bySource).toEqual({
      [SCRAPE]: 3_000,
      'model:claude-sonnet-5': 2 * DOLLAR,
      'plugin:fetch_url': 700,
    });
  });

  it.each([-5, Number.NaN, Number.POSITIVE_INFINITY])('a reported cost of %p fails rather than charging nothing', (bad) => {
    expect(() => new RunLedger({}).charge([{ source: SCRAPE, microdollars: bad }])).toThrow(/a cost report must be/);
  });
});

describe('priced host calls under the run budget', () => {
  it('hands each call the budget left, and charges what it reports', async () => {
    const budgets: Budget[] = [];
    const host = makeTestHost({
      llm: {
        client: {
          call: async ({ budget }) => {
            budgets.push(budget);
            return { parsedJson: {}, cost: [{ source: 'model:m', microdollars: DOLLAR }] };
          },
        },
      },
    });
    const ledger = new RunLedger({ capMicrodollars: 2.5 * DOLLAR });
    const priced = pricedCalls(host, { segmentId: 'seg-1', ledger, plugins: {} });
    await priced.client.call({ system: '', userMessage: '', label: 'a', model: 'sonnet' });
    await priced.client.call({ system: '', userMessage: '', label: 'b', model: 'sonnet' });
    expect(budgets).toEqual([{ remainingMicrodollars: 2.5 * DOLLAR }, { remainingMicrodollars: 1.5 * DOLLAR }]);
    expect(ledger.spend.segmentMicrodollars).toBe(2 * DOLLAR);
  });

  it("a call the host refused partway is charged what it spent, and raised as the run's cap", async () => {
    const host = makeTestHost({
      files: {
        // The host answers the refusal as data, with what it spent first.
        resolveFileText: async () => ({
          error: { kind: 'budget', message: 'out of budget' },
          cost: [{ source: 'model:whisper', microdollars: 1_200_000 }],
        }),
      },
    });
    const ledger = new RunLedger({ capMicrodollars: DOLLAR });
    const priced = pricedCalls(host, { segmentId: 'seg-1', ledger, plugins: {} });
    const err = await priced
      .resolveFileText({ file: { __brand: 'FileRef', name: 'call.mp3' } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunCostCapExceeded);
    expect((err as RunCostCapExceeded).spentMicrodollars).toBe(1_200_000);
    expect(ledger.spend.bySource).toEqual({ 'model:whisper': 1_200_000 });
  });

  it('a priced plugin is not started once the run has spent its cap; an unpriced one is', async () => {
    const invoked: string[] = [];
    const host = makeTestHost({
      llm: {
        transforms: {
          invoke: async ({ plugin }) => {
            invoked.push(plugin);
            return {};
          },
        },
      },
    });
    // Whether a plugin is priced is the snapshot's to say.
    const priced = pricedCalls(host, {
      segmentId: 'seg-1',
      ledger: new RunLedger({ capMicrodollars: DOLLAR, priorMicrodollars: DOLLAR }),
      plugins: { paid: { args: [], priced: true }, free: { args: [], priced: false } },
    });
    await expect(priced.transforms.invoke({ plugin: 'paid', config: {}, extractedContext: {} })).rejects.toThrow(
      RunCostCapExceeded,
    );
    await priced.transforms.invoke({ plugin: 'free', config: {}, extractedContext: {} });
    expect(invoked).toEqual(['free']);
  });

  it("the judge answers its index, and why it could not judge when it could not; its spend is charged", async () => {
    const host = makeTestHost({
      llm: { arbitrateEntities: async () => ({ index: 1, cost: [{ source: 'model:judge', microdollars: 300 }] }) },
    });
    const ledger = new RunLedger({});
    const answer = await pricedCalls(host, { segmentId: 'seg-1', ledger, plugins: {} }).arbitrateEntities({
      asserted: {},
      candidates: [],
      recordType: 'company',
      constraints: { any: [] },
      languageVersion: 2,
    });
    expect(answer).toEqual({ index: 1 });
    expect(ledger.spend.bySource).toEqual({ 'model:judge': 300 });

    const unavailable = makeTestHost({
      llm: { arbitrateEntities: async () => ({ index: null, judgeUnavailable: 'anthropic 529' }) },
    });
    const declined = await pricedCalls(unavailable, { segmentId: 'seg-1', ledger, plugins: {} }).arbitrateEntities({
      asserted: {},
      candidates: [],
      recordType: 'company',
      constraints: { any: [] },
      languageVersion: 2,
    });
    expect(declined).toEqual({ index: null, judgeUnavailable: 'anthropic 529' });
  });
});

describe("a segment's opening and closing", () => {
  it('opens a host segment under the pin and the run, and closes it however the segment ends', async () => {
    const opened: unknown[] = [];
    const closed: string[] = [];
    const host = makeTestHost({
      segment: {
        open: async (input) => {
          opened.push(input);
          return { segmentId: 'seg-1' };
        },
        close: async ({ segmentId }) => {
          closed.push(segmentId);
          return { cost: [{ source: 'model:adapter-match', microdollars: 40 }] };
        },
      },
    });
    const context = await openRunContext({ host, teamId: TEAM_ID, runId: 'run-1', languageVersion: 1, spend: {} });
    // The engine names the host families version it speaks on every open.
    expect(opened).toEqual([{ teamId: TEAM_ID, runId: 'run-1', languageVersion: 1, hostFamiliesVersion: HOST_FAMILIES_VERSION }]);
    expect(context.segmentId).toBe('seg-1');
    await closeRunContext(context, host);
    expect(closed).toEqual(['seg-1']);
    // What the segment's adapter calls spent is the run's too.
    expect(context.ledger.spend.bySource).toEqual({ 'model:adapter-match': 40 });
  });

  it('the test host refuses an open under a host families version it does not serve, before its own open runs', async () => {
    const opened: unknown[] = [];
    const host = makeTestHost({
      segment: {
        open: async (input) => {
          opened.push(input);
          return { segmentId: 'seg-1' };
        },
      },
    });
    await expect(
      host.segment.open({ teamId: TEAM_ID, languageVersion: 1, hostFamiliesVersion: HOST_FAMILIES_VERSION + 1 }),
    ).rejects.toThrow(
      `segment.open carries host families version ${HOST_FAMILIES_VERSION + 1}, which this host does not serve (supported: 1)`,
    );
    expect(opened).toEqual([]);
  });

  it("a segment's locks are taken by token, and whatever it still holds is let go when it ends", async () => {
    const locks = new InMemoryWriteLocks({ timeoutMs: 100 });
    const host = makeTestHost({ locks });
    const first = await openRunContext({ host, teamId: TEAM_ID, languageVersion: 2, spend: {} });
    await first.locks.acquire(['record attio 1']);
    await closeRunContext(first, host);

    const second = await openRunContext({ host, teamId: TEAM_ID, languageVersion: 2, spend: {} });
    const token = await second.locks.acquire(['record attio 1']);
    await second.locks.release(token);
    await expect(second.locks.release(token)).rejects.toThrow(/is not held/);
    await closeRunContext(second, host);
  });
});

// ── A whole run's segment ───────────────────────────────────────────────────

/** Locks that remember every name a holder took and how often a holder was
 *  released whole (its session closed), over the real in-memory gate. */
function recordingLocks(): {
  locks: WriteLocks;
  taken: Set<string>;
  opened: () => number;
  closed: () => number;
  inner: InMemoryWriteLocks;
} {
  const inner = new InMemoryWriteLocks({ timeoutMs: 100 });
  const taken = new Set<string>();
  let opened = 0;
  let closed = 0;
  const locks: WriteLocks = {
    holder(scope): WriteLockHolder {
      opened += 1;
      const holder = inner.holder(scope);
      return {
        acquire: async (names) => {
          await holder.acquire(names);
          for (const name of names) taken.add(name);
        },
        release: async (names) => {
          if (names === undefined) closed += 1;
          await holder.release(names);
        },
      };
    },
  };
  return { locks, taken, opened: () => opened, closed: () => closed, inner };
}

const kgSchema: InstanceSchema = {
  positions: { note: { properties: { body: 'text' }, edges: {} } },
  collections: { note: { target: 'note' } },
  writableRoots: { note: { fields: { body: 'text' }, resultShape: { externalId: 'text' } } },
};

function kgAdapter(onCreate: (write: WriteInput) => void): Adapter {
  return {
    adapterType: 'kg',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async () => null,
    getRelated: async () => [],
    createRecord: async (write) => {
      onCreate(write);
      return { adapterType: 'kg', externalId: 'note-1', data: {} };
    },
    updateRecord: async (input) => ({
      adapterType: 'kg',
      externalId: input.externalId,
      data: {},
      association: containerAssociation(input),
    }),
    deleteRecord: async () => ({}),
  };
}

function runOnce(input: { body: string; kg: Adapter; locks: WriteLocks; closes: string[] }) {
  const manual = createManualAdapter({ teamId: teamOfTenant(TEAM_ID) });
  return runMovement({
    source: [
      'import { manual, kg } from adapters',
      'import { kg_cred } from credentials',
      'runs = manual()',
      'graph = kg(credentials: kg_cred)',
      'movement m(go: <runs-[:Invocation]->>) {',
      '  write graph-[:note]-> { unique by (`body`) body: "one" }',
      input.body,
      '}',
      'listen to runs {} fire m',
    ].join('\n'),
    event: {
      pipelineInputId: 'trigger:manual-segment',
      adapterType: 'manual',
      triggerType: 'webhook',
      payload: { firedAt: '2026-10-07T09:00:00.000Z' },
      occurredAt: '2026-10-07T09:00:00.000Z',
    },
    teamId: TEAM_ID,
    catalog: staticCatalogSnapshot({
      credentials: { kg_cred: { adapters: ['kg'] } },
      instanceSchemas: { kg: kgSchema },
    }),
    host: makeTestHost({
      segment: {
        close: async ({ segmentId }) => {
          input.closes.push(segmentId);
          return {};
        },
      },
      adapters: { resolve: ({ adapterType }) => (adapterType === 'kg' ? input.kg : manual) },
      park: { sink: makeFakeParkSink().sink },
      locks: input.locks,
    }),
  });
}

describe("a run's segment ends exactly once, however the run ends", () => {
  it('a run that throws closes its segment once and lets go of its locks', async () => {
    const recorded = recordingLocks();
    const closes: string[] = [];
    const kg = kgAdapter(() => {
      throw new Error('the write failed');
    });
    await expect(runOnce({ body: '', kg, locks: recorded.locks, closes })).rejects.toThrow('the write failed');
    expect(closes).toHaveLength(1);
    expect(recorded.closed()).toBe(1);
    expect(recorded.taken.size).toBeGreaterThan(0);
    const next = recorded.inner.holder(TEAM_ID);
    await next.acquire([...recorded.taken]);
    await next.release();
  });

  it('a run that parks closes its segment once and lets go of its locks', async () => {
    const recorded = recordingLocks();
    const closes: string[] = [];
    const result = await runOnce({ body: '  await sleep(1d)', kg: kgAdapter(() => {}), locks: recorded.locks, closes });
    expect(result.parked).toBe(true);
    expect(closes).toHaveLength(1);
    expect(recorded.closed()).toBe(1);
    expect(recorded.taken.size).toBeGreaterThan(0);
    const next = recorded.inner.holder(TEAM_ID);
    await next.acquire([...recorded.taken]);
    await next.release();
  });

  it('a host segment that fails to open has taken no lock session', async () => {
    const recorded = recordingLocks();
    const host = makeTestHost({
      locks: recorded.locks,
      segment: {
        open: async () => {
          throw new Error('no segment today');
        },
      },
    });
    await expect(openRunContext({ host, teamId: TEAM_ID, languageVersion: 2, spend: {} })).rejects.toThrow(
      'no segment today',
    );
    // The host opens a segment's lock session at its first acquire.
    expect(recorded.opened()).toBe(0);
  });

  it("a close that fails never replaces the run's own answer", async () => {
    const host = makeTestHost({
      segment: {
        close: async () => {
          throw new Error('close failed');
        },
      },
    });
    const context = await openRunContext({ host, teamId: TEAM_ID, languageVersion: 2, spend: {} });
    await expect(closeRunContext(context, host)).resolves.toBeUndefined();
  });
});

describe('the run facts a statement carries', () => {
  it('a cancel is honoured inside a statement; outside a run there is nothing to cancel', async () => {
    const cancelled = { ...NEVER_CANCELLED, cancelled: async () => true };
    await expect(throwIfCancelled({ languageVersion: 2, cancel: cancelled })).rejects.toBeInstanceOf(
      RunCancelledSignal,
    );
    await expect(throwIfCancelled({ languageVersion: 2, cancel: NEVER_CANCELLED })).resolves.toBeUndefined();
    await expect(throwIfCancelled(undefined)).resolves.toBeUndefined();
  });

  it("a log line names the run, when there is one", () => {
    expect(runLogFields({ languageVersion: 2, cancel: NEVER_CANCELLED, runId: 'run-9' })).toEqual({ runId: 'run-9' });
    expect(runLogFields({ languageVersion: 2, cancel: NEVER_CANCELLED })).toEqual({});
    expect(runLogFields(undefined)).toEqual({});
  });
});
