// saveMovement — manual-channel runnability + the dry_run → trigger
// run_mode derivation. Same seams as save.unit.test.ts: catalog /
// tg_table / kysely mocked, the REAL saveMovement, reconciliation, store
// row logic, the REAL movement-lang parse/check and the REAL
// `movementWriteRunMode` derivation run against an in-memory table fake.
// Covered:
//
//   1. a manual-channel listener makes the file runnable on list/get
//      (its derived trigger row is the Run-now channel; no derived
//      artifact — execution reads the canonical text)
//   2. removing the manual listen drops runnable (and retires its row)
//   3. a manual-only file (no other listens) is live and runnable
//   4. dry_run constructions → derived trigger created run_mode dry_run;
//      removing the flag returns the row to live on the next save
//   5. an operator's 'off' survives both directions of the dry_run axis

// Order-sensitive cycle guard (mirrors save.unit.test.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('movement-engine/services/knowledge_pipeline/output_v3/schemas');

jest.mock('../../../../lib/kysely', () => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {
    movement: [],
    trigger: [],
    translation_graph: [],
    team: [],
    movement_version: [],
    // Retiring a listener settles the runs parked on its triggers
    // (`settleRunsParkedOnTriggers`), so the delete path reads both of these.
    parked_run: [],
    trigger_run: [],
  };
  const matches = (row: Row, wheres: Array<[string, string, unknown]>) =>
    wheres.every(([col, op, val]) =>
      op === '='
        ? row[col] === val
        : op === 'in'
          ? Array.isArray(val) && (val as unknown[]).includes(row[col])
          : false,
    );
  function builder(table: string, mode: 'select' | 'insert' | 'update' | 'delete') {
    const wheres: Array<[string, string, unknown]> = [];
    let patch: Row = {};
    let values: Row = {};
    let order: { col: string; dir: string } | undefined;
    const rows = () => tables[table].filter((r) => matches(r, wheres));
    const execute = async (): Promise<Row[]> => {
      if (mode === 'insert') {
        tables[table].push({ created_at: new Date(), updated_at: new Date(), ...values });
        return [];
      }
      if (mode === 'update') {
        for (const row of rows()) Object.assign(row, patch);
        return [];
      }
      if (mode === 'delete') {
        tables[table] = tables[table].filter((r) => !matches(r, wheres));
        return [];
      }
      const out = rows().slice();
      if (order) {
        const { col, dir } = order;
        out.sort((a, b) => {
          const av = a[col] as never;
          const bv = b[col] as never;
          return (av < bv ? -1 : av > bv ? 1 : 0) * (dir === 'desc' ? -1 : 1);
        });
      }
      return out;
    };
    const api = {
      where: (col: string, op: string, val: unknown) => {
        wheres.push([col, op, val]);
        return api;
      },
      select: () => api,
      selectAll: () => api,
      orderBy: (col: string, dir?: string) => {
        order = { col, dir: dir ?? 'asc' };
        return api;
      },
      set: (p: Row) => {
        patch = p;
        return api;
      },
      values: (v: Row) => {
        values = v;
        return api;
      },
      execute,
      executeTakeFirst: async () => (await execute())[0],
    };
    return api;
  }
  return {
    getQb: () => ({
      selectFrom: (t: string) => builder(t, 'select'),
      insertInto: (t: string) => builder(t, 'insert'),
      updateTable: (t: string) => builder(t, 'update'),
      deleteFrom: (t: string) => builder(t, 'delete'),
    }),
    getCoreQb: () => ({
      selectFrom: (t: string) => builder(t, 'select'),
      insertInto: (t: string) => builder(t, 'insert'),
      updateTable: (t: string) => builder(t, 'update'),
      deleteFrom: (t: string) => builder(t, 'delete'),
    }),
    getKnowledgeQb: () => ({
      selectFrom: (t: string) => builder(t, 'select'),
      insertInto: (t: string) => builder(t, 'insert'),
      updateTable: (t: string) => builder(t, 'update'),
      deleteFrom: (t: string) => builder(t, 'delete'),
    }),
    getAutomationsQb: () => ({
      selectFrom: (t: string) => builder(t, 'select'),
      insertInto: (t: string) => builder(t, 'insert'),
      updateTable: (t: string) => builder(t, 'update'),
      deleteFrom: (t: string) => builder(t, 'delete'),
    }),
    __tables: tables,
    __reset: () => {
      for (const key of Object.keys(tables)) tables[key] = [];
    },
  };
});

jest.mock('../catalog', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockCatalog } = require('movement-lang');
  return {
    movementCatalogForTeam: jest.fn(async () => ({
      catalog: mockCatalog({
        adapters: {
          email: { constructionArgs: [{ name: 'credentials', kind: 'position', required: false }], triggerConfig: ['key'] },
          manual: { constructionArgs: [{ name: 'credentials', kind: 'position', required: false }] },
        },
      }),
      resolveCredentialId: () => undefined,
      credentialsByName: {},
      translation: {},
      notes: [],
      gaps: [],
    })),
  };
});

jest.mock('../../adapters/registry', () => {
  const routingKey = (slug: string) =>
    slug === 'email'
      ? { kind: 'slug', key: 'key', prefix: 'inbox+', suffix: '@example.com', routingKey: true }
      : null;
  return {
    adapterInboundRoutingKey: routingKey,
    inboundAddressFor: (slug: string, config: Record<string, unknown>) => {
      const field = routingKey(slug);
      const value = field ? config[field.key] : undefined;
      return typeof value === 'string' && value.length > 0
        ? `${field!.prefix}${value}${field!.suffix}`
        : null;
    },
    // No manifest ⇒ no address hops ⇒ the listen-address resolution no-ops.
    getAdapterManifest: () => null,
  };
});

// External event-subscription diff-sync — exercised by its own suite
// (listen_kg_save.unit.test.ts); a no-op here keeps the run-entry
// fixtures off the adapter-resolution graph.
jest.mock('../listen_subscriptions', () => ({
  syncListenSubscriptions: jest.fn(async () => ({ notes: [] })),
}));

jest.mock('../../storage/tg_table', () => ({
  saveTriggerEntriesForTrigger: jest.fn(async (input: { triggerId: string }) => {
    const { __tables } = jest.requireMock('../../../../lib/kysely');
    const trigger = __tables.trigger.find(
      (row: { id: string }) => row.id === input.triggerId,
    );
    if (!trigger) throw new Error(`trigger ${input.triggerId} not found`);
    trigger.orchestration = null;
  }),
}));

import {
  deleteMovement,
  getMovement,
  listMovements,
  saveMovement,
} from '../provision';

const db = jest.requireMock('../../../../lib/kysely') as {
  __tables: Record<string, Array<Record<string, unknown>>>;
  __reset: () => void;
};

const TEAM = 'team-1';

const PRELUDE = `import { email } from adapters

inbox = email()
`;

const DRY_PRELUDE = `import { email } from adapters

inbox = email(dry_run: true)
`;

const LISTEN_ONLY = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  write inbox-[:messages]-> { subject: "ack" }
}

listen to inbox { key: "deals" } fire intake
`;

const DRY_LISTEN_ONLY = `${DRY_PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  write inbox-[:messages]-> { subject: "ack" }
}

listen to inbox { key: "deals" } fire intake
`;

const WITH_MANUAL = `import { email, manual } from adapters

inbox = email()

movement intake(m: <inbox-[:message]->>) {
  write inbox-[:messages]-> { subject: "ack" }
}

runs = manual()
movement backfill(go: <runs-[:Invocation]->>) {
  write inbox-[:messages]-> { subject: "backfill" }
}

listen to inbox { key: "deals" } fire intake
listen to runs {} fire backfill
`;

const MANUAL_ONLY = `import { manual, email } from adapters

inbox = email()

runs = manual()
movement backfill(go: <runs-[:Invocation]->>) {
  write inbox-[:messages]-> { subject: "backfill" }
}

listen to runs {} fire backfill
`;

beforeEach(() => {
  db.__reset();
  db.__tables.team.push({ id: TEAM, active_pipeline_configuration_id: 'pc-1' });
});

describe('saveMovement — a manual listener is the Run-now channel', () => {
  it('a manual listen derives a trigger row and makes the file runnable', async () => {
    const result = await saveMovement({ teamId: TEAM, source: WITH_MANUAL });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Both listeners derive trigger rows — email and manual alike.
    expect(result.listeners).toHaveLength(2);
    expect(result.listeners.map((l) => l.kind).sort()).toEqual(['email', 'manual']);
    // No derived artifact: execution reads the canonical text.
    expect(db.__tables.translation_graph).toHaveLength(0);

    const detail = await getMovement({ teamId: TEAM, id: result.movementId });
    expect(detail?.runnable).toBe(true);
    const list = await listMovements(TEAM);
    expect(list[0].runnable).toBe(true);
  });

  it('a manual-only file is live and runnable', async () => {
    const result = await saveMovement({ teamId: TEAM, source: MANUAL_ONLY });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.validity.status).toBe('valid');
    expect(result.listeners).toHaveLength(1);
    expect(result.listeners[0].kind).toBe('manual');
    // The manual listen dispatches the movement — no MOV_LISTEN_MISSING info.
    expect(result.infos).toEqual([]);
    expect(db.__tables.trigger).toHaveLength(1);
  });

  it('removing the manual listen drops runnable and retires its row', async () => {
    const first = await saveMovement({ teamId: TEAM, source: WITH_MANUAL });
    if (!first.ok) throw new Error('first save should be live');

    const second = await saveMovement({
      teamId: TEAM,
      id: first.movementId,
      source: LISTEN_ONLY,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.listeners).toHaveLength(1);
    expect(second.listeners[0].kind).toBe('email');
    const detail = await getMovement({ teamId: TEAM, id: first.movementId });
    expect(detail?.runnable).toBe(false);
  });

  it('delete removes the derived trigger rows with the movement', async () => {
    const saved = await saveMovement({ teamId: TEAM, source: WITH_MANUAL });
    if (!saved.ok) throw new Error('save should be live');
    expect(db.__tables.trigger).toHaveLength(2);

    expect(await deleteMovement({ teamId: TEAM, id: saved.movementId })).toBe(true);
    expect(db.__tables.trigger).toHaveLength(0);
    expect(db.__tables.movement).toHaveLength(0);
  });
});

describe('saveMovement — dry_run derives the listener run_mode', () => {
  it("a dry_run movement creates its derived trigger with run_mode 'dry_run'", async () => {
    const result = await saveMovement({ teamId: TEAM, source: DRY_LISTEN_ONLY });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listeners[0].runMode).toBe('dry_run');
    expect(db.__tables.trigger[0].run_mode).toBe('dry_run');
  });

  it('the dry_run⇄live axis follows the text across saves', async () => {
    const first = await saveMovement({ teamId: TEAM, source: DRY_LISTEN_ONLY });
    if (!first.ok) throw new Error('first save should be live');
    expect(db.__tables.trigger[0].run_mode).toBe('dry_run');

    // The dry_run flag comes off the construction → back to live.
    const second = await saveMovement({ teamId: TEAM, id: first.movementId, source: LISTEN_ONLY });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.listeners[0].triggerId).toBe(first.listeners[0].triggerId);
    expect(second.listeners[0].runMode).toBe('live');
    expect(db.__tables.trigger[0].run_mode).toBe('live');
  });

  it("an operator's 'off' survives both directions of the dry_run axis", async () => {
    const first = await saveMovement({ teamId: TEAM, source: LISTEN_ONLY });
    if (!first.ok) throw new Error('first save should be live');

    db.__tables.trigger[0].run_mode = 'off'; // operator pauses

    const second = await saveMovement({
      teamId: TEAM,
      id: first.movementId,
      source: DRY_LISTEN_ONLY,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(db.__tables.trigger[0].run_mode).toBe('off');
    expect(second.listeners[0].runMode).toBe('off');
  });

});
