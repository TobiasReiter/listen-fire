// The run host's contract suite: one set of cases, written against the backend
// families (store.ts) and the core's rules over them, run against every
// backend (the hosted Postgres one in apps/api's integration set, `lf`'s
// SQLite one in apps/cli's tests). Ported from the hosted integration tests
// (work store, join_pending, park sink, run lease, await correlation, the
// resume drivers) and lf's state tests, keeping the cases about what the
// state MEANS rather than how one database stores it.
//
// Runner-agnostic: each case is a name and an async body that throws on
// failure (node:assert), so jest and node:test both wrap the same list.

import assert from 'node:assert/strict';
import { RunLeaseLost } from '../movement_engine/errors';
import { drainRun, wakeAwaits, type StepLeaf, type StepOutcome, type StepRequest } from './drain';
import { cancelSubtrees, clearIfQuiescent, runCompleteWithout, runParkSink, type RunHost, type RunRecords } from './rules';
import type { AwaitKeeper, ClaimedWork, RunHostStore } from './store';

export interface ContractBackend {
  store: RunHostStore;
  /** The tenant every run of the case belongs to. */
  teamId: string;
  /** A fresh run the backend can park against. */
  newRun(): Promise<string>;
}

export interface ContractCase {
  name: string;
  run(backend: ContractBackend): Promise<void>;
}

const PAST = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const FUTURE = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SHORT_MS = 300;
const LAPSE_MS = 700;

function uniqueKey(prefix: string): string {
  return `${prefix}:${Math.random().toString(36).slice(2)}:${Date.now()}`;
}

/** Claim until the row with `key` is among the claims (other rows in a shared
 *  queue may be due too). */
async function claimKey(store: RunHostStore, key: string, leaseMs = 60_000): Promise<ClaimedWork | undefined> {
  const claimed = await store.work.claimDue({ limit: 1000, leaseMs });
  return claimed.find((w) => w.key === key);
}

async function park(store: RunHostStore, runId: string, address: string, extra: { reason?: 'timer' | 'await' | 'limit'; wakeAt?: string | null; state?: unknown } = {}): Promise<void> {
  const reason = extra.reason ?? 'timer';
  await store.parks.putLeaf({
    runId,
    address,
    reason,
    wakeAt: extra.wakeAt !== undefined ? extra.wakeAt : reason === 'timer' ? PAST(1) : null,
    state: extra.state ?? { address },
  });
}

async function branch(store: RunHostStore, runId: string, frame: string, branchAddress: string, index: number): Promise<void> {
  await store.joins.persistBranchExport({ runId, frameAddress: frame, branchAddress, branchIndex: index, exports: { i: index } });
}

async function parkedAddresses(store: RunHostStore, runId: string): Promise<string[]> {
  return (await store.parks.leaves({ runId, parkedOnly: true })).map((l) => l.address).sort();
}

/** A recording run host over the backend: the product's run records and one
 *  record-backed keeper, both in memory. */
function hostOf(backend: ContractBackend, opts: { cancelReason?: string | null; resolvable?: string[] } = {}) {
  const failed: Array<{ runId: string; message: string }> = [];
  const closed: string[] = [];
  const abandoned: Array<{ runId: string; addresses?: readonly string[] }> = [];
  const runs: RunRecords = {
    cancelRequest: async () => (opts.cancelReason === undefined ? null : { reason: opts.cancelReason }),
    markFailed: async (input) => {
      failed.push(input);
    },
    closeRun: async ({ runId }) => {
      closed.push(runId);
    },
  };
  const keeper: AwaitKeeper = {
    adapterType: 'ask',
    loadResolvable: async ({ runId }) => (opts.resolvable ?? []).map((address) => ({ runId, teamId: backend.teamId, address })),
    abandon: async (input) => {
      abandoned.push(input);
    },
  };
  const host: RunHost = { store: backend.store, keepers: [keeper], runs };
  return { host, failed, closed, abandoned };
}

/** A step scripted per leaf address (or race frame): what it does and what it
 *  answers. Records every request. */
function scriptedStep(script: Record<string, (req: StepRequest, settle: { runComplete(): Promise<boolean> }) => Promise<StepOutcome>>) {
  const requests: StepRequest[] = [];
  const step: StepLeaf = async (req, settle) => {
    requests.push(req);
    const key = req.kind === 'leaf' ? req.address : `race:${req.frameAddress}`;
    const body = script[key];
    if (body === undefined) throw new Error(`no scripted step for ${key}`);
    return body(req, settle);
  };
  return { step, requests };
}

export const runHostContractCases: ContractCase[] = [
  // ── Work queue (work/store.integration.test.ts) ──────────────────────────
  {
    name: 'work: a key enqueued twice while unleased keeps the earliest due time and the newest payload',
    async run({ store }) {
      const key = uniqueKey('wake_await');
      await store.work.enqueue({ kind: 'wake_await', key, payload: { n: 1 }, dueAt: FUTURE(10) });
      await store.work.enqueue({ kind: 'wake_await', key, payload: { n: 2 }, dueAt: FUTURE(20) });
      assert.equal(await claimKey(store, key), undefined, 'not due yet');
      await store.work.enqueue({ kind: 'wake_await', key, payload: { n: 3 }, dueAt: PAST(1) });
      const claimed = await claimKey(store, key);
      assert.deepEqual(claimed?.payload, { n: 3 });
      if (claimed) await store.work.complete(claimed);
    },
  },
  {
    name: 'work: only due, unleased rows are claimed; a live lease blocks a second claim',
    async run({ store }) {
      const due = uniqueKey('wake_await');
      const later = uniqueKey('wake_await');
      await store.work.enqueue({ kind: 'wake_await', key: due, payload: {}, dueAt: PAST(1) });
      await store.work.enqueue({ kind: 'wake_await', key: later, payload: {}, dueAt: FUTURE(10) });
      const first = await store.work.claimDue({ limit: 1000, leaseMs: 60_000 });
      assert.ok(first.some((w) => w.key === due));
      assert.ok(!first.some((w) => w.key === later));
      const second = await store.work.claimDue({ limit: 1000, leaseMs: 60_000 });
      assert.ok(!second.some((w) => w.key === due), 'leased row is not claimed again');
      for (const w of first) if (w.key === due) await store.work.complete(w);
    },
  },
  {
    name: 'work: a lapsed lease is claimable again, and the stale claim can neither complete nor release it',
    async run({ store }) {
      const key = uniqueKey('wake_await');
      await store.work.enqueue({ kind: 'wake_await', key, payload: {}, dueAt: PAST(1) });
      const stale = await claimKey(store, key, SHORT_MS);
      assert.ok(stale);
      await sleep(LAPSE_MS);
      const fresh = await claimKey(store, key);
      assert.ok(fresh, 'lapsed lease re-claimed');
      await store.work.complete(stale);
      await store.work.release({ ...stale, dueAt: FUTURE(30) });
      assert.equal(await claimKey(store, key), undefined, 'still leased to the fresh claim');
      await store.work.complete(fresh);
    },
  },
  {
    name: 'work: completing a one-shot deletes it',
    async run({ store }) {
      const key = uniqueKey('wake_await');
      await store.work.enqueue({ kind: 'wake_await', key, payload: {}, dueAt: PAST(1) });
      const claimed = await claimKey(store, key, SHORT_MS);
      assert.ok(claimed);
      await store.work.complete(claimed);
      await sleep(LAPSE_MS);
      assert.equal(await claimKey(store, key), undefined);
    },
  },
  {
    name: 'work: a re-arm during the lease survives the completion, due at its new time',
    async run({ store }) {
      const key = uniqueKey('resume_timer');
      await store.work.enqueue({ kind: 'resume_timer', key, payload: { n: 1 }, dueAt: PAST(5) });
      const claimed = await claimKey(store, key);
      assert.ok(claimed);
      await store.work.enqueue({ kind: 'resume_timer', key, payload: { n: 2 }, dueAt: PAST(1) });
      await store.work.complete(claimed);
      const again = await claimKey(store, key);
      assert.deepEqual(again?.payload, { n: 2 }, 're-armed row stayed');
      if (again) await store.work.complete(again);
    },
  },
  {
    name: 'work: a release unleases the row due at its retry time; a re-arm since the claim wins over it',
    async run({ store }) {
      const key = uniqueKey('wake_await');
      await store.work.enqueue({ kind: 'wake_await', key, payload: {}, dueAt: PAST(1) });
      const claimed = await claimKey(store, key);
      assert.ok(claimed);
      await store.work.release({ ...claimed, dueAt: FUTURE(30) });
      assert.equal(await claimKey(store, key), undefined, 'due later now');

      const rearmed = uniqueKey('wake_await');
      await store.work.enqueue({ kind: 'wake_await', key: rearmed, payload: {}, dueAt: PAST(5) });
      const held = await claimKey(store, rearmed);
      assert.ok(held);
      await store.work.enqueue({ kind: 'wake_await', key: rearmed, payload: {}, dueAt: PAST(1) });
      await store.work.release({ ...held, dueAt: FUTURE(30) });
      const again = await claimKey(store, rearmed);
      assert.ok(again, 'the re-arm due time stood');
      await store.work.complete(again);
    },
  },
  {
    name: 'work: two concurrent claims take disjoint rows',
    async run({ store }) {
      const keys = Array.from({ length: 6 }, () => uniqueKey('wake_await'));
      for (const key of keys) await store.work.enqueue({ kind: 'wake_await', key, payload: {}, dueAt: PAST(1) });
      const [a, b] = await Promise.all([store.work.claimDue({ limit: 1000, leaseMs: 60_000 }), store.work.claimDue({ limit: 1000, leaseMs: 60_000 })]);
      const ours = (rows: ClaimedWork[]) => rows.filter((w) => keys.includes(w.key));
      const taken = [...ours(a), ...ours(b)];
      assert.equal(new Set(taken.map((w) => w.key)).size, taken.length, 'no row claimed twice');
      assert.equal(taken.length, keys.length);
      for (const w of taken) await store.work.complete(w);
    },
  },

  // ── Joins (join_pending.integration.test.ts) ─────────────────────────────
  {
    name: 'joins: a re-recorded frame rewrites its count; the last decrement closes it, marking its closer',
    async run({ store, newRun }) {
      const runId = await newRun();
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 2 });
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 2 });
      await branch(store, runId, 's1', 's1.b0', 0);
      await branch(store, runId, 's1', 's1.b1', 1);
      assert.deepEqual(await store.joins.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b0', leafAddress: 's1.b0.s0' }), { closed: false });
      assert.equal(await store.joins.hasPendingJoins({ runId }), true);
      assert.deepEqual(await store.joins.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b1', leafAddress: 's1.b1.s0' }), { closed: true });
      assert.equal(await store.joins.hasPendingJoins({ runId }), false);
      // A retry of the closer (re-scanned after a crash) is still the closer.
      assert.deepEqual(await store.joins.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b1', leafAddress: 's1.b1.s0' }), { closed: true });
      assert.deepEqual(await store.joins.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b0', leafAddress: 's1.b0.s0' }), { closed: false });
    },
  },
  {
    name: 'joins: a branch decrements exactly once, even re-persisted',
    async run({ store, newRun }) {
      const runId = await newRun();
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 2 });
      await branch(store, runId, 's1', 's1.b0', 0);
      await store.joins.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b0', leafAddress: 's1.b0' });
      await branch(store, runId, 's1', 's1.b0', 0);
      assert.deepEqual(await store.joins.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b0', leafAddress: 's1.b0' }), { closed: false });
      assert.equal(await store.joins.hasPendingJoins({ runId }), true, 'one branch still owed');
    },
  },
  {
    name: 'joins: a missing frame never closes; frames of one run are independent',
    async run({ store, newRun }) {
      const runId = await newRun();
      await branch(store, runId, 's9', 's9.b0', 0);
      assert.deepEqual(await store.joins.decrementJoin({ runId, frameAddress: 's9', branchAddress: 's9.b0', leafAddress: 's9.b0' }), { closed: false });
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 1 });
      await store.joins.recordJoin({ runId, frameAddress: 's2', pending: 1 });
      await branch(store, runId, 's1', 's1.b0', 0);
      assert.deepEqual(await store.joins.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b0', leafAddress: 's1.b0' }), { closed: true });
      assert.equal(await store.joins.hasPendingJoins({ runId }), true, 's2 still waits');
      assert.deepEqual((await store.joins.frames({ runId })).sort(), ['s1', 's2']);
    },
  },
  {
    name: 'joins: exports collect in branch order; a re-persist rewrites in place',
    async run({ store, newRun }) {
      const runId = await newRun();
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 3 });
      await store.joins.persistBranchExport({ runId, frameAddress: 's1', branchAddress: 's1.b2', branchIndex: 2, exports: { v: 'c' } });
      await store.joins.persistBranchExport({ runId, frameAddress: 's1', branchAddress: 's1.b0', branchIndex: 0, exports: { v: 'a' } });
      await store.joins.persistBranchExport({ runId, frameAddress: 's1', branchAddress: 's1.b0', branchIndex: 0, exports: { v: 'a2' } });
      const collected = await store.joins.collectBranchExports({ runId, frameAddress: 's1' });
      assert.deepEqual(collected, [
        { branchAddress: 's1.b0', branchIndex: 0, exports: { v: 'a2' } },
        { branchAddress: 's1.b2', branchIndex: 2, exports: { v: 'c' } },
      ]);
      await store.joins.deleteFrames({ runId, frameAddresses: ['s1'] });
      assert.deepEqual(await store.joins.frames({ runId }), []);
      assert.deepEqual(await store.joins.collectBranchExports({ runId, frameAddress: 's1' }), []);
    },
  },

  // ── Parks and the run lease (park_sink, run_lease) ───────────────────────
  {
    name: 'parks: a re-reached park rewrites its one row; a leaf is claimed once and its claimed row finished',
    async run({ store, newRun }) {
      const runId = await newRun();
      await park(store, runId, 's0', { state: { v: 1 } });
      await park(store, runId, 's0', { state: { v: 2 } });
      assert.deepEqual(await parkedAddresses(store, runId), ['s0']);
      const claimed = await store.parks.claimLeaf({ runId, address: 's0' });
      assert.deepEqual(claimed, { state: { v: 2 }, reason: 'timer' });
      assert.equal(await store.parks.claimLeaf({ runId, address: 's0' }), null);
      assert.deepEqual(await parkedAddresses(store, runId), [], 'a claimed leaf is not parked');
      await store.parks.finishLeaf({ runId, address: 's0' });
      assert.deepEqual(await store.parks.leaves({ runId }), []);
    },
  },
  {
    name: 'parks: a leaf parked again by its own step survives the finish',
    async run({ store, newRun }) {
      const runId = await newRun();
      await park(store, runId, 's0', { reason: 'await' });
      await store.parks.claimLeaf({ runId, address: 's0' });
      await park(store, runId, 's0', { reason: 'await' });
      await store.parks.finishLeaf({ runId, address: 's0' });
      assert.deepEqual(await parkedAddresses(store, runId), ['s0']);
    },
  },
  {
    name: 'parks: claiming by reason and listing by reason and due time',
    async run({ store, newRun }) {
      const runId = await newRun();
      await park(store, runId, 's0', { reason: 'timer', wakeAt: PAST(1) });
      await park(store, runId, 's1', { reason: 'timer', wakeAt: FUTURE(60) });
      await park(store, runId, 's2', { reason: 'await' });
      const due = await store.parks.leaves({ runId, parkedOnly: true, reason: 'timer', dueBy: new Date().toISOString() });
      assert.deepEqual(due.map((l) => l.address), ['s0']);
      assert.equal(await store.parks.claimLeaf({ runId, address: 's2', reason: 'timer' }), null);
      const timers = await store.parks.leaves({ runId, reason: 'timer' });
      assert.deepEqual(timers.map((l) => l.address).sort(), ['s0', 's1']);
      assert.ok(timers.every((t) => t.wakeAt !== null && !Number.isNaN(Date.parse(t.wakeAt))));
    },
  },
  {
    name: 'lease: one holder at a time; a lapsed lease is taken over and the stale token can neither renew nor release it',
    async run({ store, newRun }) {
      const runId = await newRun();
      const first = await store.leases.claim({ runId, ttlMs: SHORT_MS });
      assert.ok(first);
      assert.equal(await store.leases.claim({ runId, ttlMs: 60_000 }), null);
      assert.equal(await store.leases.renew({ runId, token: first.token, ttlMs: SHORT_MS }), true);
      await sleep(LAPSE_MS);
      assert.equal(await store.leases.renew({ runId, token: first.token, ttlMs: SHORT_MS }), false, 'a lapsed lease is not revived');
      const second = await store.leases.claim({ runId, ttlMs: 60_000 });
      assert.ok(second);
      await store.leases.release({ runId, token: first.token });
      assert.equal(await store.leases.claim({ runId, ttlMs: 60_000 }), null, 'stale release changed nothing');
      await store.leases.release({ runId, token: second.token });
      assert.ok(await store.leases.claim({ runId, ttlMs: 60_000 }));
    },
  },
  {
    name: 'lease: taking the lease returns a dead holder\'s claimed leaves to parked',
    async run({ store, newRun }) {
      const runId = await newRun();
      await park(store, runId, 's0');
      const dead = await store.leases.claim({ runId, ttlMs: SHORT_MS });
      assert.ok(dead);
      await store.parks.claimLeaf({ runId, address: 's0' });
      await sleep(LAPSE_MS);
      assert.ok(await store.leases.claim({ runId, ttlMs: 60_000 }));
      assert.deepEqual(await parkedAddresses(store, runId), ['s0']);
    },
  },
  {
    name: 'fence: park and join writes under a lapsed holder\'s token are refused with RunLeaseLost',
    async run({ store, newRun }) {
      const runId = await newRun();
      const mine = await store.leases.claim({ runId, ttlMs: SHORT_MS });
      assert.ok(mine);
      await store.parks.putLeaf({ runId, address: 's0', reason: 'await', wakeAt: null, state: {}, fence: mine.token });
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 1, fence: mine.token });
      await sleep(LAPSE_MS);
      assert.ok(await store.leases.claim({ runId, ttlMs: 60_000 }));
      await assert.rejects(store.parks.putLeaf({ runId, address: 's2', reason: 'await', wakeAt: null, state: {}, fence: mine.token }), RunLeaseLost);
      await assert.rejects(store.joins.recordJoin({ runId, frameAddress: 's3', pending: 1, fence: mine.token }), RunLeaseLost);
      assert.deepEqual(await parkedAddresses(store, runId), ['s0']);
      assert.deepEqual(await store.joins.frames({ runId }), ['s1']);
    },
  },
  {
    name: 'fence: a lapsed holder finishes no leaf and drops no state',
    async run({ store, newRun }) {
      const runId = await newRun();
      await park(store, runId, 's0');
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 1 });
      const mine = await store.leases.claim({ runId, ttlMs: SHORT_MS });
      assert.ok(mine);
      await store.parks.claimLeaf({ runId, address: 's0' });
      await sleep(LAPSE_MS);
      const theirs = await store.leases.claim({ runId, ttlMs: 60_000 });
      assert.ok(theirs);
      await store.parks.claimLeaf({ runId, address: 's0' });
      await store.parks.finishLeaf({ runId, address: 's0', fence: mine.token });
      assert.equal(await store.leases.dropRunState({ runId, fence: mine.token }), false);
      assert.equal((await store.parks.leaves({ runId })).length, 1, 'the new holder still has its claimed leaf');
      assert.deepEqual(await store.joins.frames({ runId }), ['s1']);
      assert.equal(await store.leases.dropRunState({ runId, fence: theirs.token }), true);
      assert.deepEqual(await store.parks.leaves({ runId }), []);
      assert.deepEqual(await store.joins.frames({ runId }), []);
    },
  },

  // ── Await correlation (await_correlation, adapter doors) ─────────────────
  {
    name: 'correlation: one entry per park, team-scoped, dropped per park or per run',
    async run({ store, newRun, teamId }) {
      const runId = await newRun();
      const key = uniqueKey('thread');
      await park(store, runId, 's0', { reason: 'await' });
      await park(store, runId, 's1', { reason: 'await' });
      await store.correlations.correlate({ runId, teamId, address: 's0', adapterType: 'slack', correlationKey: 'old' });
      await store.correlations.correlate({ runId, teamId, address: 's0', adapterType: 'slack', correlationKey: key });
      await store.correlations.correlate({ runId, teamId, address: 's1', adapterType: 'slack', correlationKey: key });
      assert.deepEqual((await store.correlations.correlated({ adapterType: 'slack', teamId, correlationKey: 'old' })).filter((c) => c.runId === runId), []);
      const found = await store.correlations.correlated({ adapterType: 'slack', teamId, correlationKey: key });
      assert.deepEqual(found.map((c) => c.address).sort(), ['s0', 's1']);
      assert.deepEqual(await store.correlations.correlated({ adapterType: 'slack', teamId: '00000000-0000-4000-8000-00000000beef', correlationKey: key }), []);
      assert.deepEqual((await store.correlations.ofRun({ runId, adapterType: 'slack' })).map((c) => c.correlationKey), [key, key]);
      await store.correlations.drop({ runId, address: 's0' });
      assert.deepEqual((await store.correlations.correlated({ adapterType: 'slack', teamId, correlationKey: key })).map((c) => c.address), ['s1']);
      await store.correlations.dropRun({ runId });
      assert.deepEqual(await store.correlations.correlated({ adapterType: 'slack', teamId, correlationKey: key }), []);
    },
  },

  // ── The core's rules over the backend ────────────────────────────────────
  {
    name: 'completion: a run completes only when no join waits and no other leaf is parked; a quiescent run\'s joins clear',
    async run(backend) {
      const { store, newRun } = backend;
      const runId = await newRun();
      await park(store, runId, 's1.b0');
      await park(store, runId, 's1.b1');
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 1 });
      assert.equal(await runCompleteWithout(store, { runId, leafAddress: 's1.b0' }), false, 'join pending');
      await branch(store, runId, 's1', 's1.b0', 0);
      await store.joins.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b0', leafAddress: 's1.b0' });
      assert.equal(await runCompleteWithout(store, { runId, leafAddress: 's1.b0' }), false, 'a sibling is parked');
      await store.parks.deleteLeaves({ runId, addresses: ['s1.b1'] });
      assert.equal(await runCompleteWithout(store, { runId, leafAddress: 's1.b0' }), true);
      assert.equal(await clearIfQuiescent(store, { runId }), false, 'its own leaf is still there');
      await store.parks.deleteLeaves({ runId, addresses: ['s1.b0'] });
      assert.equal(await clearIfQuiescent(store, { runId }), true);
      assert.deepEqual(await store.joins.frames({ runId }), [], 'completion clears joins');
    },
  },
  {
    name: 'race: losing subtrees go by parsed address, sparing the winner, with their joins, correlations and keeper records',
    async run(backend) {
      const { store, newRun, teamId } = backend;
      const { host, abandoned } = hostOf(backend);
      const runId = await newRun();
      for (const address of ['s1.b1.s0', 's1.b1.s2', 's1.b10.s0', 's1.b2.s0']) {
        await park(store, runId, address, { reason: 'await' });
        await store.correlations.correlate({ runId, teamId, address, adapterType: 'slack', correlationKey: `k-${address}` });
      }
      await store.joins.recordJoin({ runId, frameAddress: 's1.b1.s3', pending: 1 });
      await branch(store, runId, 's1.b1.s3', 's1.b1.s3.b0', 0);
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 2 });
      await cancelSubtrees(host, { runId, subtreeAddresses: ['s1.b1', 's1.b2'], excludeLeaf: 's1.b1.s2' });
      assert.deepEqual(await parkedAddresses(store, runId), ['s1.b1.s2', 's1.b10.s0']);
      assert.deepEqual(await store.joins.frames({ runId }), ['s1']);
      assert.deepEqual(await store.joins.collectBranchExports({ runId, frameAddress: 's1.b1.s3' }), []);
      assert.deepEqual((await store.correlations.ofRun({ runId, adapterType: 'slack' })).map((c) => c.address).sort(), ['s1.b1.s2', 's1.b10.s0']);
      assert.deepEqual(abandoned.map((a) => [...(a.addresses ?? [])].sort()), [['s1.b1.s0', 's1.b2.s0']]);
    },
  },
  {
    name: 'drain: branches completing in one batch defer their race, which settles once with every winner',
    async run(backend) {
      const { store, newRun, teamId } = backend;
      const { host } = hostOf(backend);
      const runId = await newRun();
      for (const address of ['s1.b0.s0', 's1.b1.s0']) {
        await park(store, runId, address, { reason: 'await' });
        await store.correlations.correlate({ runId, teamId, address, adapterType: 'slack', correlationKey: 'k' });
      }
      let settledComplete: boolean | undefined;
      const { step, requests } = scriptedStep({
        's1.b0.s0': async () => ({ kind: 'completed', deferredRaceFrames: ['s1'] }),
        's1.b1.s0': async () => ({ kind: 'completed', deferredRaceFrames: ['s1'] }),
        'race:s1': async (_req, settle) => {
          settledComplete = await settle.runComplete();
          return { kind: 'completed', deferredRaceFrames: [] };
        },
      });
      const lease = await store.leases.claim({ runId, ttlMs: 60_000 });
      assert.ok(lease);
      const outcome = await drainRun(host, {
        runId,
        leaves: { addresses: ['s1.b0.s0', 's1.b1.s0'] },
        lease: { runId, token: lease.token, isLost: () => false, release: async () => {} },
        step,
      });
      assert.equal(outcome, 'done');
      assert.deepEqual(requests.map((r) => (r.kind === 'leaf' ? `${r.address}:${r.reenter}` : `race:${r.frameAddress}`)), ['s1.b0.s0:true', 's1.b1.s0:true', 'race:s1']);
      assert.equal(settledComplete, true);
      assert.deepEqual(await store.parks.leaves({ runId }), []);
      assert.deepEqual(await store.correlations.ofRun({ runId, adapterType: 'slack' }), []);
    },
  },
  {
    name: 'drain: an await re-armed at its own address keeps its row and correlation; a slept timer steps past its sleep',
    async run(backend) {
      const { store, newRun, teamId } = backend;
      const { host } = hostOf(backend);
      const runId = await newRun();
      await park(store, runId, 's0', { reason: 'await' });
      await store.correlations.correlate({ runId, teamId, address: 's0', adapterType: 'slack', correlationKey: 'k' });
      await park(store, runId, 's1', { reason: 'timer' });
      const { step, requests } = scriptedStep({
        s0: async () => {
          await park(store, runId, 's0', { reason: 'await' });
          return { kind: 'parked', parkedAddress: 's0', deferredRaceFrames: [] };
        },
        s1: async () => {
          await park(store, runId, 's2', { reason: 'timer', wakeAt: FUTURE(5) });
          return { kind: 'parked', parkedAddress: 's2', deferredRaceFrames: [] };
        },
      });
      assert.equal(await drainRun(host, { runId, leaves: { addresses: ['s0', 's1'] }, step }), 'done');
      assert.deepEqual(requests.map((r) => (r.kind === 'leaf' ? r.reenter : null)), [true, false]);
      assert.deepEqual(await parkedAddresses(store, runId), ['s0', 's2']);
      assert.deepEqual((await store.correlations.ofRun({ runId, adapterType: 'slack' })).map((c) => c.address), ['s0']);
    },
  },
  {
    name: 'drain: an engine failure tears the run down, closing its keeper records and correlations',
    async run(backend) {
      const { store, newRun, teamId } = backend;
      const { host, abandoned, closed } = hostOf(backend);
      const runId = await newRun();
      await park(store, runId, 's0', { reason: 'await' });
      await park(store, runId, 's1', { reason: 'await' });
      await store.correlations.correlate({ runId, teamId, address: 's1', adapterType: 'slack', correlationKey: 'k' });
      await store.joins.recordJoin({ runId, frameAddress: 's9', pending: 1 });
      const { step } = scriptedStep({ s0: async () => ({ kind: 'failed', error: 'boom' }) });
      assert.equal(await drainRun(host, { runId, leaves: { addresses: ['s0', 's1'] }, step }), 'done');
      assert.deepEqual(await store.parks.leaves({ runId }), []);
      assert.deepEqual(await store.joins.frames({ runId }), []);
      assert.deepEqual(await store.correlations.ofRun({ runId, adapterType: 'slack' }), []);
      assert.deepEqual(abandoned, [{ runId }]);
      assert.deepEqual(closed, [runId]);
    },
  },
  {
    name: 'drain: a run an operator asked to cancel is settled failed with their reason, and nothing is stepped',
    async run(backend) {
      const { store, newRun } = backend;
      const { host, failed } = hostOf(backend, { cancelReason: 'wrong customer' });
      const runId = await newRun();
      await park(store, runId, 's0', { reason: 'await' });
      const { step, requests } = scriptedStep({});
      assert.equal(await drainRun(host, { runId, leaves: { addresses: ['s0'] }, step }), 'done');
      assert.deepEqual(requests, []);
      assert.deepEqual(failed, [{ runId, message: 'wrong customer' }]);
      assert.deepEqual(await store.parks.leaves({ runId }), []);
    },
  },
  {
    name: 'drain: a lease lost mid-batch stops before the next leaf, leaving every row',
    async run(backend) {
      const { store, newRun } = backend;
      const { host } = hostOf(backend);
      const runId = await newRun();
      await park(store, runId, 's0', { reason: 'await' });
      await park(store, runId, 's1', { reason: 'await' });
      let lost = false;
      const { step, requests } = scriptedStep({
        s0: async () => {
          lost = true;
          return { kind: 'completed', deferredRaceFrames: [] };
        },
      });
      const lease = { runId, token: 'gone', isLost: () => lost, release: async () => {} };
      assert.equal(await drainRun(host, { runId, leaves: { addresses: ['s0', 's1'] }, lease, step }), 'leaseLost');
      assert.equal(requests.length, 1);
      assert.deepEqual(await parkedAddresses(store, runId), ['s1']);
    },
  },
  {
    name: 'wake: a signal drives every run parked on its key, each under its lease; a run held elsewhere is busy',
    async run(backend) {
      const { store, newRun, teamId } = backend;
      const { host } = hostOf(backend);
      const key = uniqueKey('thread');
      const free = await newRun();
      const held = await newRun();
      for (const runId of [free, held]) {
        await park(store, runId, 's0', { reason: 'await' });
        await store.correlations.correlate({ runId, teamId, address: 's0', adapterType: 'slack', correlationKey: key });
      }
      assert.ok(await store.leases.claim({ runId: held, ttlMs: 60_000 }));
      const stepped: string[] = [];
      const { busy } = await wakeAwaits(host, {
        wake: { adapterType: 'slack', teamId, correlationKey: key },
        stepper: async ({ runId }) => async () => {
          stepped.push(runId);
          return { kind: 'completed', deferredRaceFrames: [] };
        },
      });
      assert.deepEqual(stepped, [free]);
      assert.deepEqual(busy, [held]);
      assert.deepEqual(await store.parks.leaves({ runId: free }), []);
      assert.deepEqual(await parkedAddresses(store, held), ['s0']);
    },
  },
  {
    name: 'park sink: an await parks its leaf, then its correlation, and arms nothing; a timer arms its run\'s wake',
    async run(backend) {
      const { store, newRun, teamId } = backend;
      const { host } = hostOf(backend);
      const runId = await newRun();
      const marks: string[] = [];
      const sink = runParkSink(host, {
        runId,
        teamId,
        records: { ensureRun: async () => void marks.push('ensure'), markParked: async () => void marks.push('parked') },
      });
      await sink.commitAwaitPark({ address: 's0', state: { a: 1 }, adapterType: 'slack', correlationKey: 'k' });
      assert.deepEqual(await parkedAddresses(store, runId), ['s0']);
      assert.deepEqual((await store.correlations.ofRun({ runId, adapterType: 'slack' })).map((c) => c.correlationKey), ['k']);
      await sink.commitTimerPark({ address: 's1', state: {}, wakeAt: PAST(1) });
      const timerRow = await claimKey(store, `resume_timer:${runId}`);
      assert.deepEqual(timerRow?.payload, { runId });
      if (timerRow) await store.work.complete(timerRow);
      await sink.commitSuspension?.({ address: 's0', state: { a: 2 } });
      assert.deepEqual(await store.correlations.ofRun({ runId, adapterType: 'slack' }), [], 'a suspended await drops its correlation');
      assert.deepEqual(marks, ['ensure', 'parked', 'ensure', 'parked', 'ensure', 'parked']);
    },
  },
  {
    name: 'park sink: a cancel stamped while the run parked settles it at once; a lapsed holder\'s park is refused',
    async run(backend) {
      const { store, newRun, teamId } = backend;
      const cancelled = hostOf(backend, { cancelReason: null });
      const runId = await newRun();
      const records = { ensureRun: async () => {}, markParked: async () => {} };
      await runParkSink(cancelled.host, { runId, teamId, records }).commitAwaitPark({ address: 's0', state: {}, adapterType: 'slack', correlationKey: 'k' });
      assert.deepEqual(cancelled.failed, [{ runId, message: 'Cancelled by an operator' }]);
      assert.deepEqual(await store.parks.leaves({ runId }), []);
      assert.deepEqual(await store.correlations.ofRun({ runId, adapterType: 'slack' }), []);

      const { host } = hostOf(backend);
      const other = await newRun();
      const lapsed = await store.leases.claim({ runId: other, ttlMs: SHORT_MS });
      assert.ok(lapsed);
      await sleep(LAPSE_MS);
      assert.ok(await store.leases.claim({ runId: other, ttlMs: 60_000 }));
      const sink = runParkSink(host, { runId: other, teamId, fence: lapsed.token, records });
      await assert.rejects(sink.commitTimerPark({ address: 's0', state: {}, wakeAt: FUTURE(1) }), RunLeaseLost);
      assert.deepEqual(await store.parks.leaves({ runId: other }), []);
    },
  },
];
