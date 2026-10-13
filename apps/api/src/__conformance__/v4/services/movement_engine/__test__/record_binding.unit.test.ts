// The engine-owned binding store: the position-key ENCODER (canonical
// instance key, endpoint encoding) and the SYMMETRIC store ops (record /
// find / delete) — the latter verified against a recording getQb mock so we
// assert the SQL shape (canonical a/b ordering, the both-directions lookup,
// idempotent upsert) without a live DB.

// ── Recording getQb mock — captures the values()/where()/delete() shapes ──

interface RecordedInsert {
  table: string;
  values: Record<string, unknown>;
  onConflictColumns?: string[];
  onConflictUpdate?: Record<string, unknown>;
}

const recordedInserts: RecordedInsert[] = [];
let selectResultRows: Array<Record<string, unknown>> = [];
let lastDeleteWheres: Array<[string, string, unknown]> = [];

function makeInsertBuilder(table: string) {
  const rec: RecordedInsert = { table, values: {} };
  const builder: Record<string, unknown> = {
    values(v: Record<string, unknown>) {
      rec.values = v;
      return builder;
    },
    onConflict(fn: (oc: unknown) => unknown) {
      const oc = {
        columns(cols: string[]) {
          rec.onConflictColumns = cols;
          return oc;
        },
        doUpdateSet(u: Record<string, unknown>) {
          rec.onConflictUpdate = u;
          return oc;
        },
      };
      fn(oc);
      return builder;
    },
    execute() {
      recordedInserts.push(rec);
      return Promise.resolve([]);
    },
  };
  return builder;
}

function makeSelectBuilder() {
  const builder: Record<string, unknown> = {
    where() {
      return builder;
    },
    selectAll() {
      return builder;
    },
    orderBy() {
      return builder;
    },
    execute() {
      return Promise.resolve(selectResultRows);
    },
  };
  return builder;
}

function makeDeleteBuilder() {
  const builder: Record<string, unknown> = {
    where(col: string, op: string, val: unknown) {
      lastDeleteWheres.push([col, op, val]);
      return builder;
    },
    execute() {
      return Promise.resolve([]);
    },
  };
  return builder;
}

jest.mock('../../../lib/kysely', () => ({
  getAutomationsQb: jest.fn(() => ({
    insertInto: (table: string) => makeInsertBuilder(table),
    selectFrom: () => makeSelectBuilder(),
    deleteFrom: () => makeDeleteBuilder(),
  })),
}));

import {
  encodeInstanceKey,
  encodeEndpoint,
  recordBinding,
  findBoundCounterpart,
  deleteBinding,
  type BindingEndpoint,
} from '../record_binding';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM = 'team-1' as TeamId;

beforeEach(() => {
  recordedInserts.length = 0;
  selectResultRows = [];
  lastDeleteWheres = [];
});

describe('encodeInstanceKey — canonical instance identity', () => {
  it('is order-insensitive over construction config', () => {
    const a = encodeInstanceKey({ credentialId: 'c1', constructionConfig: { base: 'B', view: 'V' } });
    const b = encodeInstanceKey({ credentialId: 'c1', constructionConfig: { view: 'V', base: 'B' } });
    expect(a).toBe(b);
  });

  it('distinguishes different bases (same credential)', () => {
    const a = encodeInstanceKey({ credentialId: 'c1', constructionConfig: { base: 'B1' } });
    const b = encodeInstanceKey({ credentialId: 'c1', constructionConfig: { base: 'B2' } });
    expect(a).not.toBe(b);
  });

  it('distinguishes credentials (credentials are part of identity)', () => {
    const a = encodeInstanceKey({ credentialId: 'c1', constructionConfig: { base: 'B' } });
    const b = encodeInstanceKey({ credentialId: 'c2', constructionConfig: { base: 'B' } });
    expect(a).not.toBe(b);
  });

  it('collapses a construction-free instance to a stable empty marker', () => {
    expect(encodeInstanceKey({})).toBe(encodeInstanceKey({ constructionConfig: {} }));
  });
});

describe('encodeEndpoint', () => {
  it('normalizes the adapter slug and carries the stable type id verbatim', () => {
    const e = encodeEndpoint({
      adapterType: 'NATIVE_VALUATIONS',
      credentialId: 'c1',
      typeId: 'stable-type-uuid',
      recordId: 'rec-9',
    });
    expect(e.adapterType).toBe('native-valuations');
    expect(e.typeId).toBe('stable-type-uuid');
    expect(e.recordId).toBe('rec-9');
  });
});

const kgEndpoint: BindingEndpoint = { adapterType: 'kg', typeId: 'kg-company-type', recordId: 'node-1' };
const attioEndpoint: BindingEndpoint = {
  adapterType: 'attio',
  credentialId: 'attio-cred',
  typeId: 'companies',
  recordId: 'attio-rec-1',
};

describe('recordBinding — symmetric, canonically ordered upsert', () => {
  it('orders the two endpoints canonically regardless of call direction', async () => {
    await recordBinding({ teamId: TEAM, from: kgEndpoint, to: attioEndpoint });
    const forward = recordedInserts[0].values;
    recordedInserts.length = 0;
    await recordBinding({ teamId: TEAM, from: attioEndpoint, to: kgEndpoint });
    const reverse = recordedInserts[0].values;
    // Same canonical row no matter which way the engine asked.
    expect(forward).toEqual(reverse);
  });

  it('upserts idempotently on the full pair, refreshing updated_at', async () => {
    await recordBinding({ teamId: TEAM, from: kgEndpoint, to: attioEndpoint });
    const rec = recordedInserts[0];
    expect(rec.table).toBe('record_binding');
    expect(rec.onConflictColumns).toEqual([
      'team_id',
      'a_adapter_type',
      'a_instance_key',
      'a_type_id',
      'a_record_id',
      'b_adapter_type',
      'b_instance_key',
      'b_type_id',
      'b_record_id',
    ]);
    expect(rec.onConflictUpdate).toHaveProperty('updated_at');
  });
});

describe('findBoundCounterpart — matches either side, returns the other', () => {
  it('returns the b-side counterpart when the queried endpoint is stored as a', async () => {
    const enc = encodeEndpoint(kgEndpoint);
    selectResultRows = [
      {
        a_adapter_type: enc.adapterType,
        a_instance_key: enc.instanceKey,
        a_type_id: enc.typeId,
        a_record_id: enc.recordId,
        b_adapter_type: 'attio',
        b_instance_key: 'attio-cred|',
        b_type_id: 'companies',
        b_record_id: 'attio-rec-1',
        updated_at: new Date(),
      },
    ];
    const found = await findBoundCounterpart({ teamId: TEAM, endpoint: kgEndpoint });
    expect(found).toEqual({
      adapterType: 'attio',
      instanceKey: 'attio-cred|',
      typeId: 'companies',
      recordId: 'attio-rec-1',
    });
  });

  it('returns the a-side counterpart when the queried endpoint is stored as b', async () => {
    const enc = encodeEndpoint(kgEndpoint);
    selectResultRows = [
      {
        a_adapter_type: 'attio',
        a_instance_key: 'attio-cred|',
        a_type_id: 'companies',
        a_record_id: 'attio-rec-1',
        b_adapter_type: enc.adapterType,
        b_instance_key: enc.instanceKey,
        b_type_id: enc.typeId,
        b_record_id: enc.recordId,
        updated_at: new Date(),
      },
    ];
    const found = await findBoundCounterpart({ teamId: TEAM, endpoint: kgEndpoint });
    expect(found?.adapterType).toBe('attio');
    expect(found?.recordId).toBe('attio-rec-1');
  });

  it('returns null when no binding exists', async () => {
    selectResultRows = [];
    expect(await findBoundCounterpart({ teamId: TEAM, endpoint: kgEndpoint })).toBeNull();
  });
});

describe('deleteBinding — self-heal removes the canonical pair', () => {
  it('deletes by the full canonically-ordered key from either direction', async () => {
    await deleteBinding({ teamId: TEAM, from: kgEndpoint, to: attioEndpoint });
    const forward = lastDeleteWheres;
    lastDeleteWheres = [];
    await deleteBinding({ teamId: TEAM, from: attioEndpoint, to: kgEndpoint });
    expect(lastDeleteWheres).toEqual(forward);
  });
});
