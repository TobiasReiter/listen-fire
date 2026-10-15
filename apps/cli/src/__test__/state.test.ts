// The SQLite state's semantics, held to the hosted Postgres backend's: the
// cases are ported from its integration tests (work/__test__/
// store.integration.test.ts, movement_engine/__test__/
// join_pending.integration.test.ts, park_sink.integration.test.ts), the ones
// about what the store means rather than how Postgres stores it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../state';

const T0 = Date.parse('2026-10-15T12:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

function open(): { state: State; clock: { ms: number }; path: string } {
  const clock = { ms: 0 };
  const path = join(mkdtempSync(join(tmpdir(), 'lf-state-')), 'state.db');
  return { state: new State(path, { now: () => new Date(T0 + clock.ms) }), clock, path };
}

function withRun(state: State, id = 'run-1'): string {
  state.startRun({ id, file: 'f', movement: 'm', started_at: at(0), input: '{}' });
  return id;
}

function park(state: State, runId: string, address: string, extra: Partial<Parameters<State['upsertPark']>[0]> = {}): void {
  state.upsertPark({ run_id: runId, address, kind: 'timer', wake_at: at(0), adapter_type: null, correlation_key: null, state: '{}', engine: 'rust', ...extra });
}

describe('work queue (store.integration.test.ts)', () => {
  test('enqueue against an unleased row keeps the earliest due time and takes the new payload', () => {
    const { state } = open();
    state.enqueue({ kind: 'resume_timer', key: 'k', payload: { runId: 'a' }, dueAt: at(5_000) });
    state.enqueue({ kind: 'resume_timer', key: 'k', payload: { runId: 'b' }, dueAt: at(9_000) });
    const [row] = state.work();
    assert.equal(row?.due_at, at(5_000));
    assert.deepEqual(JSON.parse(row?.payload ?? ''), { runId: 'b' });
  });

  test('enqueue against a row whose lease expired behaves as unleased', () => {
    const { state, clock } = open();
    state.enqueue({ kind: 'resume_timer', key: 'k', payload: {}, dueAt: at(0) });
    assert.equal(state.claimDue({ leaseMs: 1_000 }).length, 1);
    clock.ms = 2_000;
    state.enqueue({ kind: 'resume_timer', key: 'k', payload: {}, dueAt: at(60_000) });
    assert.equal(state.work()[0]?.due_at, at(0));
  });

  test('a re-arm during a live lease survives completion with the new due time and no lease', () => {
    const { state } = open();
    state.enqueue({ kind: 'resume_timer', key: 'k', payload: { runId: 'a' }, dueAt: at(0) });
    const [claimed] = state.claimDue();
    assert.ok(claimed);
    state.enqueue({ kind: 'resume_timer', key: 'k', payload: { runId: 'b' }, dueAt: at(60_000) });
    state.completeWork(claimed);
    const rows = state.work();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.due_at, at(60_000));
    assert.equal(rows[0]?.lease_token, null);
    assert.deepEqual(JSON.parse(rows[0]?.payload ?? ''), { runId: 'b' });
  });

  test('a claim takes only due, unleased rows', () => {
    const { state } = open();
    state.enqueue({ kind: 'resume_timer', key: 'due', payload: {}, dueAt: at(-1) });
    state.enqueue({ kind: 'resume_timer', key: 'later', payload: {}, dueAt: at(60_000) });
    assert.deepEqual(state.claimDue().map((w) => w.key), ['due']);
    assert.deepEqual(state.claimDue().map((w) => w.key), []);
  });

  test('a live lease blocks another claim; a lapsed lease is re-claimable', () => {
    const { state, clock } = open();
    state.enqueue({ kind: 'wake_await', key: 'k', payload: {}, dueAt: at(0) });
    assert.equal(state.claimDue({ leaseMs: 1_000 }).length, 1);
    assert.equal(state.claimDue({ leaseMs: 1_000 }).length, 0);
    clock.ms = 1_001;
    assert.equal(state.claimDue({ leaseMs: 1_000 }).length, 1);
  });

  test('a stale claim cannot release or complete the re-claim', () => {
    const { state, clock } = open();
    state.enqueue({ kind: 'wake_await', key: 'k', payload: {}, dueAt: at(0) });
    const [first] = state.claimDue({ leaseMs: 1_000 });
    clock.ms = 2_000;
    const [second] = state.claimDue({ leaseMs: 1_000 });
    assert.ok(first && second);
    state.completeWork(first);
    state.releaseWork({ ...first, dueAt: at(99_000) });
    const [row] = state.work();
    assert.equal(row?.lease_token, second.leaseToken);
    assert.equal(row?.due_at, at(0));
  });

  test('completion deletes a one-shot row', () => {
    const { state } = open();
    state.enqueue({ kind: 'wake_await', key: 'k', payload: {}, dueAt: at(0) });
    const [claimed] = state.claimDue();
    assert.ok(claimed);
    state.completeWork(claimed);
    assert.equal(state.work().length, 0);
  });

  test('release clears the lease and keeps the due time; with a due time, moves it', () => {
    const { state } = open();
    state.enqueue({ kind: 'wake_await', key: 'k', payload: {}, dueAt: at(0) });
    const [first] = state.claimDue();
    assert.ok(first);
    state.releaseWork(first);
    assert.equal(state.work()[0]?.due_at, at(0));
    assert.equal(state.work()[0]?.lease_token, null);
    const [second] = state.claimDue();
    assert.ok(second);
    state.releaseWork({ ...second, dueAt: at(30_000) });
    assert.equal(state.work()[0]?.due_at, at(30_000));
  });

  test('a re-arm during a failing run wins over the release due time, and the lease still clears', () => {
    const { state } = open();
    state.enqueue({ kind: 'resume_timer', key: 'k', payload: {}, dueAt: at(0) });
    const [claimed] = state.claimDue();
    assert.ok(claimed);
    state.enqueue({ kind: 'resume_timer', key: 'k', payload: {}, dueAt: at(60_000) });
    state.releaseWork({ ...claimed, dueAt: at(5_000) });
    assert.equal(state.work()[0]?.due_at, at(60_000));
    assert.equal(state.work()[0]?.lease_token, null);
  });

  test('two state handles on one file claim disjoint rows', () => {
    const { state, path } = open();
    const other = new State(path, { now: () => new Date(T0) });
    for (let i = 0; i < 6; i++) state.enqueue({ kind: 'wake_await', key: `k${i}`, payload: {}, dueAt: at(0) });
    const a = state.claimDue({ limit: 3 }).map((w) => w.key);
    const b = other.claimDue({ limit: 3 }).map((w) => w.key);
    assert.equal(new Set([...a, ...b]).size, 6);
    other.close();
  });
});

describe('joins (join_pending.integration.test.ts)', () => {
  const branch = (state: State, runId: string, frame: string, b: string, index: number) =>
    state.persistBranchExport({ runId, frameAddress: frame, branchAddress: b, branchIndex: index, exports: { i: index } });

  test('decrements toward close; the closer is marked; a re-scan is the closer again, a sibling never', () => {
    const { state } = open();
    const runId = withRun(state);
    state.recordJoin(runId, 's0', 2);
    branch(state, runId, 's0', 's0.b0', 0);
    branch(state, runId, 's0', 's0.b1', 1);
    assert.deepEqual(state.decrementJoin({ runId, frameAddress: 's0', branchAddress: 's0.b0', leafAddress: 's0.b0.s0' }), { closed: false });
    assert.deepEqual(state.decrementJoin({ runId, frameAddress: 's0', branchAddress: 's0.b1', leafAddress: 's0.b1.s0' }), { closed: true });
    assert.deepEqual(state.decrementJoin({ runId, frameAddress: 's0', branchAddress: 's0.b1', leafAddress: 's0.b1.s0' }), { closed: true });
    assert.deepEqual(state.decrementJoin({ runId, frameAddress: 's0', branchAddress: 's0.b0', leafAddress: 's0.b0.s0' }), { closed: false });
    assert.equal(state.runHasPendingJoins(runId), false);
  });

  test('per branch exactly once: a non-closer re-scanned while the join is open does not decrement it again', () => {
    const { state } = open();
    const runId = withRun(state);
    state.recordJoin(runId, 'c0', 3);
    branch(state, runId, 'c0', 'c0.b0', 0);
    branch(state, runId, 'c0', 'c0.b1', 1);
    branch(state, runId, 'c0', 'c0.b2', 2);
    const dec = (b: string) => state.decrementJoin({ runId, frameAddress: 'c0', branchAddress: b, leafAddress: `${b}.s0` });
    assert.deepEqual(dec('c0.b0'), { closed: false });
    assert.deepEqual(dec('c0.b0'), { closed: false });
    // A re-persist (a retried branch) must not reset its claim.
    branch(state, runId, 'c0', 'c0.b0', 0);
    assert.deepEqual(dec('c0.b0'), { closed: false });
    assert.equal(state.runHasPendingJoins(runId), true);
    assert.deepEqual(dec('c0.b1'), { closed: false });
    assert.deepEqual(dec('c0.b2'), { closed: true });
  });

  test('a missing frame is never the closer', () => {
    const { state } = open();
    const runId = withRun(state);
    assert.deepEqual(state.decrementJoin({ runId, frameAddress: 'nope', branchAddress: 'nope.b0', leafAddress: 'nope.b0' }), { closed: false });
  });

  test('independent joins of one run decrement independently', () => {
    const { state } = open();
    const runId = withRun(state);
    state.recordJoin(runId, 's0', 1);
    state.recordJoin(runId, 's1', 1);
    branch(state, runId, 's0', 's0.b0', 0);
    branch(state, runId, 's1', 's1.b0', 0);
    assert.deepEqual(state.decrementJoin({ runId, frameAddress: 's0', branchAddress: 's0.b0', leafAddress: 's0.b0' }), { closed: true });
    assert.equal(state.runHasPendingJoins(runId), true);
    assert.deepEqual(state.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b0', leafAddress: 's1.b0' }), { closed: true });
    assert.equal(state.runHasPendingJoins(runId), false);
  });

  test('collects branches in branch order whatever the persist order; a re-persist updates in place', () => {
    const { state } = open();
    const runId = withRun(state);
    branch(state, runId, 's0', 's0.b2', 2);
    branch(state, runId, 's0', 's0.b0', 0);
    branch(state, runId, 's0', 's0.b1', 1);
    state.persistBranchExport({ runId, frameAddress: 's0', branchAddress: 's0.b1', branchIndex: 1, exports: { again: true } });
    assert.deepEqual(state.collectBranchExports(runId, 's0'), [
      { branchAddress: 's0.b0', branchIndex: 0, exports: { i: 0 } },
      { branchAddress: 's0.b1', branchIndex: 1, exports: { again: true } },
      { branchAddress: 's0.b2', branchIndex: 2, exports: { i: 2 } },
    ]);
  });

  test('clearing a run wipes its joins and every branch export', () => {
    const { state } = open();
    const runId = withRun(state);
    state.recordJoin(runId, 's0', 2);
    branch(state, runId, 's0', 's0.b0', 0);
    state.clearJoins(runId);
    assert.equal(state.runHasPendingJoins(runId), false);
    assert.deepEqual(state.collectBranchExports(runId, 's0'), []);
  });
});

describe('parks (park_sink.integration.test.ts)', () => {
  test('a re-reached park upserts: one row, new state and wake time, parked again', () => {
    const { state } = open();
    const runId = withRun(state);
    park(state, runId, 's1', { wake_at: at(1_000), state: '{"v":1}' });
    assert.ok(state.claimPark(runId, 's1'));
    park(state, runId, 's1', { wake_at: at(2_000), state: '{"v":2}' });
    const rows = state.parks(runId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'parked');
    assert.equal(rows[0]?.wake_at, at(2_000));
    assert.equal(rows[0]?.state, '{"v":2}');
    // The re-park stands: finishing the claim leaves it.
    state.finishPark(runId, 's1');
    assert.equal(state.parks(runId).length, 1);
  });

  test('a leaf is claimed once; finishing the claim deletes it', () => {
    const { state } = open();
    const runId = withRun(state);
    park(state, runId, 's1');
    assert.ok(state.claimPark(runId, 's1'));
    assert.equal(state.claimPark(runId, 's1'), null);
    state.finishPark(runId, 's1');
    assert.equal(state.parks(runId).length, 0);
  });

  test('cancelling subtrees uses the parsed address: s1.b1 does not take s1.b10, and the winner is spared', () => {
    const { state } = open();
    const runId = withRun(state);
    park(state, runId, 's1.b1.s0');
    park(state, runId, 's1.b1.s2');
    park(state, runId, 's1.b10.s0');
    state.recordJoin(runId, 's1.b1.s3', 1);
    state.recordJoin(runId, 's1.b10.s3', 1);
    state.cancelSubtrees({ runId, subtreeAddresses: ['s1.b1'], excludeLeaf: 's1.b1.s2' });
    assert.deepEqual(state.parks(runId).map((p) => p.address).sort(), ['s1.b1.s2', 's1.b10.s0']);
    assert.equal(state.runHasPendingJoins(runId), true);
    state.cancelSubtrees({ runId, subtreeAddresses: ['s1.b10'] });
    assert.deepEqual(state.parks(runId).map((p) => p.address), ['s1.b1.s2']);
    assert.equal(state.runHasPendingJoins(runId), false);
  });

  test('a run is complete only when no join waits and no other leaf is parked', () => {
    const { state } = open();
    const runId = withRun(state);
    park(state, runId, 's0.b0.s0');
    park(state, runId, 's0.b1.s0');
    state.recordJoin(runId, 's0', 2);
    assert.equal(state.runCompleteBut(runId, 's0.b0.s0'), false);
    state.persistBranchExport({ runId, frameAddress: 's0', branchAddress: 's0.b0', branchIndex: 0, exports: {} });
    state.decrementJoin({ runId, frameAddress: 's0', branchAddress: 's0.b0', leafAddress: 's0.b0.s0' });
    assert.ok(state.claimPark(runId, 's0.b0.s0'));
    state.finishPark(runId, 's0.b0.s0');
    assert.equal(state.runQuiescent(runId), false);
    state.persistBranchExport({ runId, frameAddress: 's0', branchAddress: 's0.b1', branchIndex: 1, exports: {} });
    state.decrementJoin({ runId, frameAddress: 's0', branchAddress: 's0.b1', leafAddress: 's0.b1.s0' });
    assert.equal(state.runCompleteBut(runId, 's0.b1.s0'), true);
  });

  test('await parks are found by their adapter and correlation key', () => {
    const { state } = open();
    const runId = withRun(state);
    park(state, runId, 's2', { kind: 'await', wake_at: null, adapter_type: 'crm', correlation_key: 'thread:1' });
    park(state, runId, 's3', { kind: 'await', wake_at: null, adapter_type: 'crm', correlation_key: 'thread:2' });
    assert.deepEqual(state.awaitParks({ adapterType: 'crm', correlationKey: 'thread:1' }).map((p) => p.address), ['s2']);
  });
});

describe('run lease (run_lease.integration.test.ts)', () => {
  test('one holder at a time; a lapsed lease is re-taken and returns abandoned claims to parked', () => {
    const { state, clock, path } = open();
    const runId = withRun(state);
    park(state, runId, 's1');
    const first = state.claimRunLease(runId, 1_000);
    assert.ok(first);
    assert.ok(state.claimPark(runId, 's1'));
    const other = new State(path, { now: () => new Date(T0 + clock.ms) });
    assert.equal(other.claimRunLease(runId, 1_000), null);
    clock.ms = 1_001;
    assert.equal(state.renewRunLease(runId, first.token), false);
    assert.ok(other.claimRunLease(runId, 1_000));
    assert.equal(other.parks(runId)[0]?.status, 'parked');
    other.close();
  });

  test('a released lease is free at once; a stale token releases nothing', () => {
    const { state } = open();
    const runId = withRun(state);
    const first = state.claimRunLease(runId);
    assert.ok(first);
    state.releaseRunLease(runId, 'not-the-token');
    assert.equal(state.claimRunLease(runId), null);
    state.releaseRunLease(runId, first.token);
    assert.ok(state.claimRunLease(runId));
  });
});

describe('record bindings (record_bindings.integration.test.ts)', () => {
  const crm = { adapterType: 'acme_crm', credentialId: 'acme', typeId: 'Company' };
  const kg = { adapterType: 'graph', typeId: 'Organisation' };

  test('symmetric: found from either side; restricted to the counterpart instance and type', () => {
    const { state } = open();
    state.recordBinding({ from: { ...crm, recordId: 'c-1' }, to: { ...kg, recordId: 'n-1' } });
    assert.equal(state.findBoundCounterpart({ endpoint: { ...crm, recordId: 'c-1' } })?.recordId, 'n-1');
    assert.equal(state.findBoundCounterpart({ endpoint: { ...kg, recordId: 'n-1' } })?.recordId, 'c-1');
    assert.equal(state.findBoundCounterpart({ endpoint: { ...kg, recordId: 'n-1' }, counterpart: { ...crm, typeId: 'Person' } }), null);
    // The adapter type is normalised: an enum spelling is the same instance.
    assert.equal(state.findBoundCounterpart({ endpoint: { ...crm, adapterType: 'ACME_CRM', recordId: 'c-1' } })?.recordId, 'n-1');
  });

  test('the most recently bound counterpart wins; a delete from either side removes the pair', () => {
    const { state } = open();
    state.recordBinding({ from: { ...crm, recordId: 'c-1' }, to: { ...kg, recordId: 'n-1' } });
    state.recordBinding({ from: { ...crm, recordId: 'c-1' }, to: { ...kg, recordId: 'n-2' } });
    assert.equal(state.findBoundCounterpart({ endpoint: { ...crm, recordId: 'c-1' } })?.recordId, 'n-2');
    state.recordBinding({ from: { ...kg, recordId: 'n-1' }, to: { ...crm, recordId: 'c-1' } });
    assert.equal(state.findBoundCounterpart({ endpoint: { ...crm, recordId: 'c-1' } })?.recordId, 'n-1');
    const counterpart = state.findBoundCounterpart({ endpoint: { ...crm, recordId: 'c-1' } });
    assert.ok(counterpart);
    state.deleteBinding({ from: counterpart, to: { ...crm, recordId: 'c-1' } });
    assert.equal(state.findBoundCounterpart({ endpoint: { ...crm, recordId: 'c-1' } })?.recordId, 'n-2');
  });
});
