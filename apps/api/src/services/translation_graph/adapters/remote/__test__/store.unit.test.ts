// Unit tests for the remote_adapter store.
//
// Coverage:
//   - upsert → get round-trip (manifest + projected scalar columns)
//   - upsert idempotency on the (team_id, adapter_type) unique key
//     (second upsert updates the existing row, does not duplicate)
//   - list (team-scoped)
//   - delete
//   - invalid manifest is rejected by the zod validation
//
// Mocks the kysely qb with a hermetic in-memory store, the way other store
// unit tests in this package do (see schema_type/__test__/create.unit.test.ts).
// The fake qb models just enough of the builder surface the store uses:
// insertInto.values.onConflict.returning, selectFrom.where.selectAll,
// deleteFrom.where, and the (team_id, adapter_type) upsert key.

import { randomUUID } from 'node:crypto';

interface FakeRow {
  id: string;
  team_id: string;
  adapter_type: string;
  base_url: string;
  auth_strategy: unknown;
  credentials_id: string | null;
  manifest: unknown;
  created_at: Date;
  updated_at: Date;
}

const fakeStore: FakeRow[] = [];

// `sql\`...::jsonb\`` produces a kysely RawBuilder; unwrap it back to the
// parsed JSON value so assertions see plain objects.
function unwrapSqlJsonb(val: unknown): unknown {
  if (val == null || typeof val !== 'object') return val;
  const node = (val as any).toOperationNode;
  if (typeof node !== 'function') return val;
  let op: any;
  try {
    op = node.call(val);
  } catch {
    return val;
  }
  const fragments: string[] | undefined = op?.sqlFragments;
  const params: any[] | undefined = op?.parameters;
  if (!Array.isArray(fragments) || !Array.isArray(params)) return val;
  if (!/::jsonb$/.test(fragments.join('').trim())) return val;
  const first = params[0];
  const raw =
    typeof first === 'string'
      ? first
      : first && typeof first === 'object' && 'value' in first
        ? (first as { value: unknown }).value
        : undefined;
  if (typeof raw !== 'string') return val;
  try {
    return JSON.parse(raw);
  } catch {
    return val;
  }
}

function resolveValues(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, vv] of Object.entries(v)) out[k] = unwrapSqlJsonb(vv);
  return out;
}

type WhereEq = { col: string; val: unknown };

function applyWhere(rows: FakeRow[], wheres: WhereEq[]): FakeRow[] {
  return rows.filter((r) => wheres.every((w) => (r as any)[w.col] === w.val));
}

jest.mock('../../../../../lib/kysely', () => {
  const qb = {
    insertInto: (_t: string) => ({
      values(v: Record<string, unknown>) {
        const insertVals = resolveValues(v);
        return {
          onConflict(cb: (oc: any) => any) {
            let updateVals: Record<string, unknown> | undefined;
            const oc = {
              columns: (_cols: string[]) => ({
                doUpdateSet(u: Record<string, unknown>) {
                  updateVals = resolveValues(u);
                  return oc;
                },
              }),
            };
            cb(oc);
            return {
              returning(_cols: string[]) {
                return {
                  async executeTakeFirstOrThrow() {
                    const existing = fakeStore.find(
                      (r) =>
                        r.team_id === insertVals.team_id &&
                        r.adapter_type === insertVals.adapter_type,
                    );
                    if (existing) {
                      Object.assign(existing, updateVals ?? {});
                      return { id: existing.id };
                    }
                    const row: FakeRow = {
                      id: randomUUID(),
                      created_at: new Date(),
                      updated_at: new Date(),
                      ...(insertVals as any),
                    };
                    fakeStore.push(row);
                    return { id: row.id };
                  },
                };
              },
            };
          },
        };
      },
    }),
    selectFrom: (_t: string) => {
      const wheres: WhereEq[] = [];
      const builder: any = {
        where(col: string, _op: string, val: unknown) {
          wheres.push({ col, val });
          return builder;
        },
        selectAll() {
          return {
            orderBy(col: string, dir: string) {
              return {
                async execute() {
                  const rows = applyWhere(fakeStore, wheres).map((r) => ({ ...r }));
                  rows.sort((a, b) => {
                    const av = String((a as any)[col]);
                    const bv = String((b as any)[col]);
                    return dir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
                  });
                  return rows;
                },
              };
            },
            async executeTakeFirst() {
              const found = applyWhere(fakeStore, wheres)[0];
              return found ? { ...found } : undefined;
            },
            async execute() {
              return applyWhere(fakeStore, wheres).map((r) => ({ ...r }));
            },
          };
        },
      };
      return builder;
    },
    deleteFrom: (_t: string) => {
      const wheres: WhereEq[] = [];
      const builder: any = {
        where(col: string, _op: string, val: unknown) {
          wheres.push({ col, val });
          return builder;
        },
        async execute() {
          const toDelete = applyWhere(fakeStore, wheres);
          for (const r of toDelete) {
            const idx = fakeStore.indexOf(r);
            if (idx >= 0) fakeStore.splice(idx, 1);
          }
        },
      };
      return builder;
    },
  };
  return { getQb: () => qb, getCoreQb: () => qb, getAutomationsQb: () => qb };
});

import {
  upsertRemoteAdapter,
  getRemoteAdapter,
  listRemoteAdapters,
  deleteRemoteAdapter,
  rowToManifest,
} from '../store';
import type { TeamId } from '../../../../../generated/kysely/core/Team';

const TEAM_ID = 'team-1' as TeamId;
const OTHER_TEAM = 'team-2' as TeamId;

function makeManifest(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 2,
    adapterType: 'remote-email',
    baseUrl: 'https://adapter.example.com/rpc',
    authStrategy: { kind: 'bearer' as const },
    credentialsId: randomUUID(),
    supportedTriggers: ['event'],
    runtimeCapabilities: {
      traversal: { incoming: false, edgeProperties: false },
      resources: false,
    },
    methods: ['manifest', 'resolveEntity'],
    ...overrides,
  };
}

describe('remote_adapter store', () => {
  beforeEach(() => {
    fakeStore.splice(0, fakeStore.length);
  });

  it('upsert → get round-trips the manifest and projected columns', async () => {
    const manifest = makeManifest();
    const { id } = await upsertRemoteAdapter({ teamId: TEAM_ID, manifest });
    expect(id).toBeTruthy();

    const row = await getRemoteAdapter({ teamId: TEAM_ID, adapterType: 'remote-email' });
    expect(row).not.toBeNull();
    if (!row) return;

    expect(row.team_id).toBe(TEAM_ID);
    expect(row.adapter_type).toBe('remote-email');
    expect(row.base_url).toBe(manifest.baseUrl);
    expect(row.auth_strategy).toEqual({ kind: 'bearer' });
    expect(row.credentials_id).toBe(manifest.credentialsId);

    // The full manifest round-trips through the jsonb column.
    expect(rowToManifest(row)).toEqual(manifest);
  });

  it('upsert is idempotent on (team_id, adapter_type): second upsert updates, not duplicates', async () => {
    const first = makeManifest({ baseUrl: 'https://v1.example.com/rpc' });
    const { id: id1 } = await upsertRemoteAdapter({ teamId: TEAM_ID, manifest: first });

    const second = makeManifest({
      baseUrl: 'https://v2.example.com/rpc',
      authStrategy: { kind: 'shared_secret', header: 'X-Token' },
      methods: ['manifest', 'resolveEntity', 'snapshot'],
    });
    const { id: id2 } = await upsertRemoteAdapter({ teamId: TEAM_ID, manifest: second });

    // Same slug → same row updated.
    expect(id2).toBe(id1);

    const all = await listRemoteAdapters({ teamId: TEAM_ID });
    expect(all).toHaveLength(1);

    const row = await getRemoteAdapter({ teamId: TEAM_ID, adapterType: 'remote-email' });
    expect(row?.base_url).toBe('https://v2.example.com/rpc');
    expect(row?.auth_strategy).toEqual({ kind: 'shared_secret', header: 'X-Token' });
    expect(rowToManifest(row!).methods).toContain('snapshot');
  });

  it('list is team-scoped and ordered', async () => {
    await upsertRemoteAdapter({ teamId: TEAM_ID, manifest: makeManifest({ adapterType: 'remote-slack' }) });
    await upsertRemoteAdapter({ teamId: TEAM_ID, manifest: makeManifest({ adapterType: 'remote-email' }) });
    await upsertRemoteAdapter({ teamId: OTHER_TEAM, manifest: makeManifest({ adapterType: 'remote-attio' }) });

    const mine = await listRemoteAdapters({ teamId: TEAM_ID });
    expect(mine.map((r) => r.adapter_type)).toEqual(['remote-email', 'remote-slack']);

    const theirs = await listRemoteAdapters({ teamId: OTHER_TEAM });
    expect(theirs.map((r) => r.adapter_type)).toEqual(['remote-attio']);
  });

  it('delete removes the install', async () => {
    await upsertRemoteAdapter({ teamId: TEAM_ID, manifest: makeManifest() });
    expect(await getRemoteAdapter({ teamId: TEAM_ID, adapterType: 'remote-email' })).not.toBeNull();

    await deleteRemoteAdapter({ teamId: TEAM_ID, adapterType: 'remote-email' });
    expect(await getRemoteAdapter({ teamId: TEAM_ID, adapterType: 'remote-email' })).toBeNull();
  });

  it('rejects an invalid manifest via zod validation', async () => {
    await expect(
      upsertRemoteAdapter({ teamId: TEAM_ID, manifest: { adapterType: '', baseUrl: 'not-a-url' } }),
    ).rejects.toThrow();
  });
});
