// What lf's SQLite state holds beyond the run host's contract suite
// (run_host_contract.test.ts holds its backend families to the hosted
// meaning): what the contract cannot see from one handle on a wall clock
// (two processes on one file, a lease that lapses on a stepped clock), and
// record bindings, ported from the hosted record_bindings integration tests.

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

describe('work queue', () => {
  test('enqueue against a row whose lease lapsed behaves as unleased: the earlier due time stands', async () => {
    const { state, clock } = open();
    await state.store.work.enqueue({ kind: 'resume_timer', key: 'k', payload: {}, dueAt: at(0) });
    assert.equal((await state.store.work.claimDue({ limit: 10, leaseMs: 1_000 })).length, 1);
    clock.ms = 2_000;
    await state.store.work.enqueue({ kind: 'resume_timer', key: 'k', payload: {}, dueAt: at(60_000) });
    assert.equal(state.work()[0]?.due_at, at(0));
  });

  test('a release without a retry time keeps the due time and clears the lease', async () => {
    const { state } = open();
    await state.store.work.enqueue({ kind: 'wake_await', key: 'k', payload: {}, dueAt: at(0) });
    const [claimed] = await state.store.work.claimDue({ limit: 10, leaseMs: 60_000 });
    assert.ok(claimed);
    await state.store.work.release(claimed);
    assert.equal(state.work()[0]?.due_at, at(0));
    assert.equal(state.work()[0]?.lease_token, null);
  });

  test('two state handles on one file claim disjoint rows', async () => {
    const { state, path } = open();
    const other = new State(path, { now: () => new Date(T0) });
    for (let i = 0; i < 6; i++) await state.store.work.enqueue({ kind: 'wake_await', key: `k${i}`, payload: {}, dueAt: at(0) });
    const a = (await state.store.work.claimDue({ limit: 3, leaseMs: 60_000 })).map((w) => w.key);
    const b = (await other.store.work.claimDue({ limit: 3, leaseMs: 60_000 })).map((w) => w.key);
    assert.equal(new Set([...a, ...b]).size, 6);
    other.close();
  });

  test('a kind lf does not drain is refused at the queue', async () => {
    const { state } = open();
    await assert.rejects(state.store.work.enqueue({ kind: 'resume_callback', key: 'k', payload: {} }));
  });
});

describe('run lease across two handles', () => {
  test('one holder at a time; a lapsed lease is taken by the other process, with the abandoned claim parked again', async () => {
    const { state, clock, path } = open();
    state.startRun({ id: 'run-1', file: 'f', movement: 'm', started_at: at(0), input: '{}' });
    await state.store.parks.putLeaf({ runId: 'run-1', address: 's1', reason: 'timer', wakeAt: at(0), state: {} });
    const first = await state.store.leases.claim({ runId: 'run-1', ttlMs: 1_000 });
    assert.ok(first);
    assert.ok(await state.store.parks.claimLeaf({ runId: 'run-1', address: 's1' }));
    const other = new State(path, { now: () => new Date(T0 + clock.ms) });
    assert.equal(await other.store.leases.claim({ runId: 'run-1', ttlMs: 1_000 }), null);
    clock.ms = 1_001;
    assert.equal(await state.store.leases.renew({ runId: 'run-1', token: first.token, ttlMs: 1_000 }), false);
    assert.ok(await other.store.leases.claim({ runId: 'run-1', ttlMs: 1_000 }));
    assert.deepEqual((await other.store.parks.leaves({ runId: 'run-1', parkedOnly: true })).map((l) => l.address), ['s1']);
    other.close();
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
