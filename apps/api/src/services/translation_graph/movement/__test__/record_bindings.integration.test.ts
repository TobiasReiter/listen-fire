// R1 (the explicit-linking correctness gate) — real-DB proof of the
// engine-owned binding store's dedup + self-heal semantics, the exact
// mechanism `executeBindWrite` (run.ts) rides:
//
//   1. RE-FIRE DEDUP — binding `other ↔ A`, then a second firing for the
//      same `other` finds the SAME counterpart A (so the bind flow takes the
//      update branch, not a second create): exactly one target.
//   2. SELF-HEAL — when the bound target is gone (the adapter reports
//      not-found), the bind flow deletes the stale binding and records a
//      fresh one to the re-minted record: one fresh binding, no stale row,
//      no duplicate.
//
// This runs the REAL `record_binding` SQL against the test Postgres (the
// `executeBindWrite` flow calls these same functions). It is the
// deterministic standing gate for R1; the dev-loop re-fire is the
// end-to-end complement.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { BindingEndpoint } from 'movement-engine/services/movement_engine/host';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import {
  recordBinding,
  findBoundCounterpart,
  deleteBinding,
} from '../record_bindings';


let teamId: TeamId;

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `record-binding-r1-${teamId.slice(0, 8)}` } as any)
    .execute();
});

afterAll(async () => {
  await getAutomationsQb(['record_binding']).deleteFrom('record_binding').where('team_id', '=', teamId).execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

afterEach(async () => {
  await getAutomationsQb(['record_binding']).deleteFrom('record_binding').where('team_id', '=', teamId).execute();
});

const rowCount = async (): Promise<number> => {
  const rows = await getAutomationsQb(['record_binding'])
    .selectFrom('record_binding')
    .where('team_id', '=', teamId)
    .selectAll()
    .execute();
  return rows.length;
};

// `other` is the source record (e.g. an inbound Attio company); the target is
// the KG node the bind write creates. The bind flow keys the binding on the
// fully-qualified positions of both.
const other: BindingEndpoint = {
  adapterType: 'attio',
  credentialId: 'attio-cred-1',
  constructionConfig: { list: 'Dealflow' },
  typeId: 'companies',
  recordId: 'attio-rec-1',
};
const target = (recordId: string): BindingEndpoint => ({
  adapterType: 'kg',
  typeId: 'kg-company-type',
  recordId,
});
const targetInstance = { adapterType: 'kg', typeId: 'kg-company-type' };

describe('R1 — bind re-fire dedup (real record_binding)', () => {
  it('a second firing for the same `other` resolves to the SAME target — no duplicate', async () => {
    // First firing: create target A, record the binding.
    await recordBinding({ teamId, from: other, to: target('kg-node-A') });

    // Second firing: the bind flow looks up `other` constrained to the target
    // instance — it MUST find kg-node-A (→ update branch, not a second create).
    const found = await findBoundCounterpart({ teamId, endpoint: other, counterpart: targetInstance });
    expect(found).not.toBeNull();
    expect(found?.recordId).toBe('kg-node-A');

    // Re-asserting the SAME binding (what the create branch would do) is an
    // idempotent upsert — still exactly one row.
    await recordBinding({ teamId, from: other, to: target('kg-node-A') });
    expect(await rowCount()).toBe(1);
  });

  it('is symmetric — the binding is found from the target side too', async () => {
    await recordBinding({ teamId, from: other, to: target('kg-node-A') });
    const fromTarget = await findBoundCounterpart({
      teamId,
      endpoint: target('kg-node-A'),
      counterpart: { adapterType: 'attio', credentialId: 'attio-cred-1', constructionConfig: { list: 'Dealflow' }, typeId: 'companies' },
    });
    expect(fromTarget?.recordId).toBe('attio-rec-1');
  });

  it('distinguishes a different source instance — no false dedup across bases', async () => {
    await recordBinding({ teamId, from: other, to: target('kg-node-A') });
    const otherBase: BindingEndpoint = { ...other, constructionConfig: { list: 'Other List' } };
    const found = await findBoundCounterpart({ teamId, endpoint: otherBase, counterpart: targetInstance });
    expect(found).toBeNull();
  });
});

describe('R1 — bind self-heal (real record_binding)', () => {
  it('a 404 target self-heals to ONE fresh record + ONE fresh binding', async () => {
    // Live binding to the now-deleted target A.
    await recordBinding({ teamId, from: other, to: target('kg-node-A') });
    const stale = await findBoundCounterpart({ teamId, endpoint: other, counterpart: targetInstance });
    expect(stale?.recordId).toBe('kg-node-A');

    // updateRecord(kg-node-A) reports not-found → the bind flow deletes the
    // stale binding and records a fresh one to the re-minted node B.
    await deleteBinding({ teamId, from: other, to: stale! });
    await recordBinding({ teamId, from: other, to: target('kg-node-B') });

    // Exactly one binding, pointing at the fresh node — no stale duplicate.
    expect(await rowCount()).toBe(1);
    const healed = await findBoundCounterpart({ teamId, endpoint: other, counterpart: targetInstance });
    expect(healed?.recordId).toBe('kg-node-B');
  });
});
