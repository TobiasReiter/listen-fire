// Real-DB proof of the callback store's two load-bearing claims:
//
//   1. The CLAIM is a CAS. Two concurrent fires of a single-use callback record
//      exactly ONE call and exactly one wins; the loser reads `closed`. This is
//      the whole race story, and it is one statement — so it is worth pinning
//      against the real engine rather than a mock.
//   2. REVOCATION follows the run's lifecycle (ruling (b)). Any terminal state
//      and a movement delete kill the outstanding callbacks, and a fired
//      single-use keeps its `fired` ending rather than being rewritten.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { ParkedScopeState } from '../serialize';

import { sql } from 'kysely';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { CALLBACK_ID_PREFIX, callbackUrl, claimCallbackFire, coerceCallbackValues, getCallback, isCallbackId, listRunCallbacks, markCallbackBodyStarted, mintCallback, readCallbackCalls, revokeRunCallbacks } from '../callback_store';
import { CALLBACK_AWAIT_TYPE, type CallbackParamSpec } from '../callback_types';
import { loadResolvableCallbackAwaits } from '../callback_sink';

let teamId: TeamId;
let runId: TriggerRunId;

const STATE: ParkedScopeState = {
  version: 1,
  address: 's2',
  bindingName: null,
  scopeChain: [{ bindings: {} }, { bindings: { note: { kind: 'value', value: 'hi' } } }],
};

async function mint(overrides: {
  singleUse?: boolean;
  expiresAt?: Date;
  params?: CallbackParamSpec[];
  address?: string;
} = {}) {
  return mintCallback({
    teamId,
    runId,
    address: overrides.address ?? 's2',
    params: overrides.params ?? [],
    state: STATE,
    singleUse: overrides.singleUse ?? true,
    ...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
  });
}

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  runId = randomUUID() as TriggerRunId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `callback-store-${teamId.slice(0, 8)}` } as any)
    .execute();
  await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      id: runId,
      team_id: teamId,
      trigger_id: 'callback-store-trigger',
      trigger_type: 'webhook',
      status: 'running',
      started_at: new Date(),
    } as any)
    .execute();
});

afterAll(async () => {
  await getAutomationsQb(['callback']).deleteFrom('callback').where('run_id', '=', runId).execute();
  await getAutomationsQb(['trigger_run']).deleteFrom('trigger_run').where('id', '=', runId).execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

afterEach(async () => {
  await getAutomationsQb(['callback']).deleteFrom('callback').where('run_id', '=', runId).execute();
});

describe('mint', () => {
  it('mints a `cb_`-prefixed opaque id, live, single-use by default, with the captured state', async () => {
    const record = await mint({ singleUse: undefined });

    expect(record.id.startsWith(CALLBACK_ID_PREFIX)).toBe(true);
    expect(isCallbackId(record.id)).toBe(true);
    expect(record.status).toBe('live');
    expect(record.singleUse).toBe(true);
    expect(record.calls).toEqual([]);
    expect(record.address).toBe('s2');
    // The capture is the park machinery's own shape, round-tripped through jsonb.
    expect(record.state).toEqual(STATE);
    expect(callbackUrl(record.id).endsWith(`/api/cb/${record.id}`)).toBe(true);
  });

  it('reads back by id, and a foreign payload never reaches a query', async () => {
    const record = await mint();
    expect((await getCallback(record.id))?.id).toBe(record.id);
    // No `cb_` prefix ⇒ not ours. Compared, never parsed.
    expect(await getCallback('ask_something')).toBeNull();
    expect(await getCallback('AC1234')).toBeNull();
  });

  it('lists a run’s callbacks in mint order — two fan-out mints share an address, not an id', async () => {
    const first = await mint({ address: 's1.i0.s0' });
    const second = await mint({ address: 's1.i1.s0' });
    const listed = await listRunCallbacks(runId);
    expect(listed.map((c) => c.id)).toEqual([first.id, second.id]);
    expect(listed.map((c) => c.address)).toEqual(['s1.i0.s0', 's1.i1.s0']);
  });
});

describe('the claim (CAS)', () => {
  it('records the call and flips a single-use callback live → fired', async () => {
    const record = await mint();
    const claim = await claimCallbackFire({ id: record.id, values: { choice: 'ship' } });

    expect(claim.kind).toBe('recorded');
    if (claim.kind !== 'recorded') throw new Error('expected recorded');
    expect(claim.call.values).toEqual({ choice: 'ship' });
    expect(claim.callback.status).toBe('fired');
    expect(claim.callback.calls).toHaveLength(1);
    expect((await getCallback(record.id))?.firedAt).not.toBeNull();
  });

  it('two CONCURRENT fires of a single-use callback record exactly one call', async () => {
    const record = await mint();

    const [a, b] = await Promise.all([
      claimCallbackFire({ id: record.id, values: { who: 'a' } }),
      claimCallbackFire({ id: record.id, values: { who: 'b' } }),
    ]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['closed', 'recorded']);
    // The ledger is the proof: the loser's call is not in it.
    expect((await getCallback(record.id))?.calls).toHaveLength(1);
  });

  it('a repeatable callback stays live and ACCUMULATES calls', async () => {
    const record = await mint({ singleUse: false });

    await claimCallbackFire({ id: record.id, values: { n: 1 } });
    await claimCallbackFire({ id: record.id, values: { n: 2 } });

    const after = await getCallback(record.id);
    expect(after?.status).toBe('live');
    expect(after?.firedAt).toBeNull();
    expect(after?.calls.map((c) => c.values)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('concurrent fires of a REPEATABLE callback all land (append, never lost)', async () => {
    const record = await mint({ singleUse: false });

    await Promise.all(
      [1, 2, 3, 4, 5].map((n) => claimCallbackFire({ id: record.id, values: { n } })),
    );

    const calls = (await getCallback(record.id))?.calls ?? [];
    expect(calls).toHaveLength(5);
    expect(new Set(calls.map((c) => (c.values as { n: number }).n))).toEqual(
      new Set([1, 2, 3, 4, 5]),
    );
  });

  it('a call is seen once its body has started, never before', async () => {
    const record = await mint({ singleUse: false });
    await claimCallbackFire({ id: record.id, values: { n: 1 } });
    expect(await readCallbackCalls(record.id)).toEqual([]);

    await markCallbackBodyStarted({ id: record.id, callIndex: 0 });
    const calls = await readCallbackCalls(record.id);
    expect(calls).toEqual([{ at: expect.any(String), values: { n: 1 } }]);
    // The landing's `At` is an instant JavaScript reads back as itself.
    expect(new Date(calls[0]!.at).toISOString()).toBe(calls[0]!.at);
  });

  it('expiry is read on the database clock, so a refusal says expired, whatever this process thinks the time is', async () => {
    // Expired a second ago by the database's clock.
    const record = await mint({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
    await getAutomationsQb(['callback'])
      .updateTable('callback')
      .set({ expires_at: sql<Date>`now() - interval '1 second'` })
      .where('id', '=', record.id)
      .execute();
    // This process's clock runs an hour slow.
    const slow = jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 60 * 60 * 1000);
    try {
      expect((await claimCallbackFire({ id: record.id, values: {} })).kind).toBe('expired');
    } finally {
      slow.mockRestore();
    }
  });

  it('a malformed ledger is refused where it is read, naming the callback', async () => {
    const record = await mint();
    await getAutomationsQb(['callback'])
      .updateTable('callback')
      .set({ calls: sql`'[{"values": {}}]'::jsonb` })
      .where('id', '=', record.id)
      .execute();
    await expect(getCallback(record.id)).rejects.toThrow(`callback ${record.id} has a malformed call ledger`);
  });

  it('TTL expiry is LAZY — checked at the claim, never by a sweeper', async () => {
    const record = await mint({ expiresAt: new Date(Date.now() - 1000) });

    const claim = await claimCallbackFire({ id: record.id, values: {} });
    expect(claim.kind).toBe('expired');
    // The row is untouched: nothing swept it, and it still reads `live`.
    const after = await getCallback(record.id);
    expect(after?.status).toBe('live');
    expect(after?.calls).toEqual([]);
  });

  it('an unknown id is not_found (and a foreign payload is too)', async () => {
    expect((await claimCallbackFire({ id: `${CALLBACK_ID_PREFIX}nope`, values: {} })).kind).toBe(
      'not_found',
    );
    expect((await claimCallbackFire({ id: 'ask_nope', values: {} })).kind).toBe('not_found');
  });
});

describe('revocation follows the run (ruling (b))', () => {
  it('revokes every LIVE callback of a run, idempotently', async () => {
    const a = await mint();
    const b = await mint({ singleUse: false });

    expect(await revokeRunCallbacks(runId)).toBe(2);
    expect(await revokeRunCallbacks(runId)).toBe(0);

    expect((await getCallback(a.id))?.status).toBe('revoked');
    expect((await getCallback(b.id))?.status).toBe('revoked');
    expect((await getCallback(a.id))?.revokedAt).not.toBeNull();
  });

  it('leaves a FIRED single-use alone — the two endings stay distinguishable', async () => {
    const record = await mint();
    await claimCallbackFire({ id: record.id, values: {} });

    await revokeRunCallbacks(runId);

    const after = await getCallback(record.id);
    expect(after?.status).toBe('fired');
    expect(after?.revokedAt).toBeNull();
  });

  it('a revoked callback refuses the claim with the closed outcome', async () => {
    const record = await mint();
    await revokeRunCallbacks(runId);

    const claim = await claimCallbackFire({ id: record.id, values: {} });
    expect(claim.kind).toBe('closed');
    expect(await readCallbackCalls(record.id)).toEqual([]);
  });

  it('deleting the run cascades its callbacks away', async () => {
    const record = await mint();
    const scratchRun = randomUUID() as TriggerRunId;
    await getAutomationsQb(['trigger_run'])
      .insertInto('trigger_run')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        id: scratchRun,
        team_id: teamId,
        trigger_id: 'callback-store-trigger',
        trigger_type: 'webhook',
        status: 'running',
        started_at: new Date(),
      } as any)
      .execute();
    const doomed = await mintCallback({
      teamId,
      runId: scratchRun,
      address: 's0',
      params: [],
      state: STATE,
      singleUse: true,
    });

    await getAutomationsQb(['trigger_run']).deleteFrom('trigger_run').where('id', '=', scratchRun).execute();

    expect(await getCallback(doomed.id)).toBeNull();
    expect((await getCallback(record.id))?.status).toBe('live');
  });
});

describe('the backstop wake — a callback with a recorded call is resolvable', () => {
  async function correlate(callbackId: string, address: string) {
    await getAutomationsQb(['adapter_await'])
      .insertInto('adapter_await')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        adapter_type: CALLBACK_AWAIT_TYPE,
        correlation_key: callbackId,
        run_id: runId,
        team_id: teamId,
        address,
      } as any)
      .execute();
  }

  afterEach(async () => {
    await getAutomationsQb(['adapter_await']).deleteFrom('adapter_await').where('run_id', '=', runId).execute();
  });

  it('an UNFIRED callback’s park is not resolvable (the run is genuinely still waiting)', async () => {
    const record = await mint();
    await correlate(record.id, 's1');

    expect(await loadResolvableCallbackAwaits({ runId })).toEqual([]);
  });

  it('a recorded call whose body has not started does not resolve the park: the awaiter waits for the body', async () => {
    const record = await mint();
    await correlate(record.id, 's1');
    await claimCallbackFire({ id: record.id, values: {} });

    expect(await loadResolvableCallbackAwaits({ runId })).toEqual([]);
  });

  it('a FIRED callback’s park is resolvable once its body started — so a lost wake nudge cannot strand the run', async () => {
    const record = await mint();
    await correlate(record.id, 's1');
    await claimCallbackFire({ id: record.id, values: {} });
    await markCallbackBodyStarted({ id: record.id, callIndex: 0 });

    const resolvable = await loadResolvableCallbackAwaits({ runId });
    expect(resolvable).toEqual([{ runId, teamId, address: 's1' }]);
  });
});

describe('fire-time parameter validation (loud, never a silent default)', () => {
  const params: CallbackParamSpec[] = [
    { name: 'when', type: 'date' },
    { name: 'note', type: 'text' },
  ];

  it('coerces each declared value to its declared type', () => {
    const result = coerceCallbackValues(params, { when: '2026-08-01', note: 'ok' });
    expect(result).toEqual({ ok: true, values: { when: '2026-08-01', note: 'ok' } });
  });

  it('refuses a MISSING parameter, naming what it expects', () => {
    const result = coerceCallbackValues(params, { note: 'ok' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.message).toContain("missing 'when'");
    expect(result.message).toContain('when (date)');
  });

  it('refuses an UNDECLARED value rather than dropping it silently', () => {
    const result = coerceCallbackValues(params, { when: '2026-08-01', note: 'ok', extra: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.message).toContain("'extra' is not a parameter");
  });

  it('a value-less callback refuses ANY value', () => {
    const result = coerceCallbackValues([], { anything: 'at all' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.message).toContain('takes no values');
  });

  it('refuses an uncoercible value with the type named', () => {
    expect(coerceCallbackValues([{ name: 'n', type: 'number' }], { n: 'lots' })).toEqual({
      ok: false,
      message: "'n' expects number, but 'lots' is not a number",
    });
    expect(coerceCallbackValues([{ name: 'd', type: 'date' }], { d: 'someday' })).toEqual({
      ok: false,
      message: "'d' expects date, but 'someday' is not a date",
    });
  });

  it('accepts the spellings a form and a JSON caller each send for a boolean', () => {
    const bool: CallbackParamSpec[] = [{ name: 'yes', type: 'boolean' }];
    expect(coerceCallbackValues(bool, { yes: 'true' })).toEqual({ ok: true, values: { yes: true } });
    expect(coerceCallbackValues(bool, { yes: false })).toEqual({ ok: true, values: { yes: false } });
    expect(coerceCallbackValues(bool, { yes: 'no' })).toEqual({ ok: true, values: { yes: false } });
    expect(coerceCallbackValues(bool, { yes: 'maybe' }).ok).toBe(false);
  });
});
