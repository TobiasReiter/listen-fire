// Text-canonical movement persistence — saveMovement + listener
// reconciliation (trigger rows are DERIVED from the file's `listen`
// statements).
//
// The catalog assembly (`../catalog`), the trigger-orchestration writer
// (`../../storage/tg_table`), and the DB (`lib/kysely`) are mocked; the
// REAL `saveMovement` / `getMovement` / `listMovements` /
// `deleteMovement`, the REAL reconciliation (`planListenerReconciliation`
// + reconcile walk), the REAL movement-lang parse/check + the REAL dry
// interpretability scan, and the REAL `store.ts` row logic run against an
// in-memory table fake. Covered:
//
//   1.  clean save → canonical row + one derived trigger per listen,
//       validity valid, trigger named movement/<file>/<movement>, NO
//       object code (orchestration stays empty — execution reads the text)
//   2.  round-trip — getMovement returns the EXACT saved source + listeners
//   3.  multi-listen → multiple derived rows, file order
//   4.  identity: an unchanged listen keeps its trigger id across saves
//   5.  unambiguous config change updates the row IN PLACE (same id)
//   6.  removed listens retire their rows
//   7.  zero listens (library) → all derived rows retired, links cleared,
//       MOV_LISTEN_MISSING surfaced as an info
//   8.  check errors → consent gate (needsConfirmation); consented save
//       ships broken (decision 3b)
//   9.  run_mode is NEVER touched by reconciliation after creation
//   10. clean check, provisioning failure → save fails honestly
//   11. unsupported constructs → consent gate, constructs NAMED
//   12. durable name: declaration edit keeps the stored name (only the fire
//       target follows); an explicit name renames in place and persists
//   13. list projection + delete cleans every derived row

// Order-sensitive cycle guard: pre-require schemas.ts so
// `expressionSchema` resolves before orchestration/types pulls it
// transitively.
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

// A REAL movement-lang catalog (the parse/check in provisionListeners is
// not mocked), with the email vocabulary the listen fixtures exercise and
// a file resolver for the library-import save case.
jest.mock('../catalog', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockCatalog } = require('movement-lang');
  const LIB_SOURCE = [
    'export node Lead {',
    '  name: <text>',
    '}',
    '',
    'export function log_lead(l: <Lead>) {',
    '  x = l.`name`',
    '}',
  ].join('\n');
  return {
    movementCatalogForTeam: jest.fn(async () => ({
      catalog: mockCatalog({
        adapters: {
          email: { constructionArgs: [{ name: 'credentials', kind: 'position', required: false }], triggerConfig: ['key'] },
        },
        plugins: {
          fetch_pages: { args: ['urls'] },
        },
      }),
      resolveCredentialId: () => undefined,
      credentialsByName: {},
      translation: {},
      resolveFile: (path: string) =>
        path === 'lib/leads' ? { source: LIB_SOURCE } : undefined,
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

// External event-subscription diff-sync — its own suite
// (listen_kg_save.unit.test.ts) exercises the real module; here it would
// only drag the adapter-resolution graph into the listener-derivation
// fixtures.
jest.mock('../listen_subscriptions', () => ({
  syncListenSubscriptions: jest.fn(async () => ({ notes: [] })),
}));

jest.mock('../../storage/tg_table', () => ({
  saveTriggerEntriesForTrigger: jest.fn(
    async (input: { triggerId: string; entries: unknown[] }) => {
      // Faithful contract (what replaceTriggerOrchestration does): zero
      // entries clears the orchestration and deletes the owned mapping —
      // the only path the movement save uses now (the trigger row is
      // purely the dispatch index; execution reads the text).
      const { __tables } = jest.requireMock('../../../../lib/kysely');
      const trigger = __tables.trigger.find(
        (row: { id: string }) => row.id === input.triggerId,
      );
      if (!trigger) throw new Error(`trigger ${input.triggerId} not found`);
      const mappingId = trigger.orchestration?.tgId as string | undefined;
      if (input.entries.length !== 0) {
        throw new Error('movement saves derive no orchestration entries');
      }
      if (mappingId !== undefined) {
        __tables.translation_graph = __tables.translation_graph.filter(
          (row: { id: string }) => row.id !== mappingId,
        );
      }
      trigger.orchestration = null;
    },
  ),
}));

// Journey taps — `saveMovement` records the `first_automation_saved`
// milestone from three post-persistence sites (see `../provision.ts`:
// `recordAutomationSavedMilestones`). Mocked so we can assert the taps
// actually fire, not just that saveMovement returns the right shape — an
// earlier chunk of this feature shipped a clause with zero coverage that
// silently no-op'd.
jest.mock('../../../../lib/journey', () => ({
  recordUserMilestone: jest.fn().mockResolvedValue(true),
  recordTeamMilestone: jest.fn().mockResolvedValue(true),
}));

// Request-scoped Context — `saveMovement` reads `unsafeCurrentContext()` for
// both the acting user (already exercised via `input.userId` above) and,
// as of the monotonicity fix (plans/2026-07-16-journey-instrumentation),
// `mcpDomain`: the USER `first_automation_saved` milestone fires ONLY when
// this save arrived via MCP (`x-mcp-domain: automation`). Mocked (default:
// no context, i.e. a plain web-UI save) so individual tests can simulate an
// MCP-originated save by returning `{ mcpDomain: 'automation' }`.
jest.mock('../../../../services/context', () => ({
  unsafeCurrentContext: jest.fn(() => undefined),
}));

import { CURRENT_LANGUAGE_VERSION, mockCatalog } from 'movement-lang';

import type { DerivedTriggerRow } from '../store';

import {
  deleteMovement,
  getMovement,
  listMovements,
  movementNameFromSource,
  planListenerReconciliation,
  saveMovement,
} from '../provision';
import { movementSourceHash } from '../version_store';


const db = jest.requireMock('../../../../lib/kysely') as {
  __tables: Record<string, Array<Record<string, unknown>>>;
  __reset: () => void;
};

const catalogMock = jest.requireMock('../catalog') as {
  movementCatalogForTeam: jest.Mock;
};

const journey = jest.requireMock('../../../../lib/journey') as {
  recordUserMilestone: jest.Mock;
  recordTeamMilestone: jest.Mock;
};

const contextMock = jest.requireMock('../../../../services/context') as {
  unsafeCurrentContext: jest.Mock;
};

const TEAM = 'team-1';

const PRELUDE = `import { email } from adapters

inbox = connect email
`;

const SOURCE_V1 = `${PRELUDE}
function intake(m: <inbox-[:message]->>) {
  # version one
}

listen to inbox { key: "deals" } fire intake
`;
const SOURCE_V2 = SOURCE_V1.replace('# version one', '# version two');
const SOURCE_BROKEN = SOURCE_V1.replace('# version one', 'write nowhere-[:thing]-> { x: 1 }');

const MULTI_LISTEN = `${PRELUDE}
function intake(m: <inbox-[:message]->>) {
  # intake
}

function digest(m: <inbox-[:message]->>) {
  # digest
}

listen to inbox { key: "deals" } fire intake
listen to inbox { key: "intros" } fire digest
`;

const NO_LISTEN = `${PRELUDE}
function intake(m: <inbox-[:message]->>) {
  # library now
}
`;

// Movements listening over DISTINCT instances that nonetheless resolve to the
// SAME (kind, credentials, config key) trigger identity — the checker forbids
// two identical listens on ONE instance (MOV_LISTEN_DUPLICATE), so the real
// collision that fooled the old positional reconciler comes from separate
// instances of the same credential-less adapter sharing a config key.
const TWO_INSTANCE_PRELUDE = `import { email } from adapters

inbox_a = connect email
inbox_b = connect email
`;

const TWO_SHARED = `${TWO_INSTANCE_PRELUDE}
function a(m: <inbox_a-[:message]->>) {
  # a
}

function b(m: <inbox_b-[:message]->>) {
  # b
}

listen to inbox_a { key: "deals" } fire a
listen to inbox_b { key: "deals" } fire b
`;

// The same file with a new instance + movement `c` (and its listen) inserted
// AHEAD of the others — declaration and `listen` both first in the file.
const THREE_SHARED = `import { email } from adapters

inbox_c = connect email
inbox_a = connect email
inbox_b = connect email

function c(m: <inbox_c-[:message]->>) {
  # c
}

function a(m: <inbox_a-[:message]->>) {
  # a
}

function b(m: <inbox_b-[:message]->>) {
  # b
}

listen to inbox_c { key: "deals" } fire c
listen to inbox_a { key: "deals" } fire a
listen to inbox_b { key: "deals" } fire b
`;

// A consumer importing from a saved library file (the catalog mock's
// resolveFile serves "lib/leads").
const WITH_FILE_IMPORT = `import { email } from adapters
import { log_lead, Lead } from "lib/leads"

inbox = connect email

function intake(m: <inbox-[:message]->>) {
  log_lead(node { name: m.\`subject\` })
}

listen to inbox { key: "deals" } fire intake
`;

const WITH_BAD_FILE_IMPORT = WITH_FILE_IMPORT.replace('"lib/leads"', '"lib/nowhere"');

// Two aliased lanes firing the same movement — trigger names should equal the
// lane aliases (not the derived `movement/<file>/<movement>` form).
const ALIASED_LANES = `${PRELUDE}
function intake(m: <inbox-[:message]->>) {
  # intake
}

listen as "Alice's lane" to inbox { key: "alice" } fire intake
listen as "Bob's lane"   to inbox { key: "bob"   } fire intake
`;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no request Context (a plain web-UI/API save) — `clearAllMocks`
  // wipes call history but not a mock's return-value implementation, so this
  // must be set explicitly each time.
  contextMock.unsafeCurrentContext.mockReturnValue(undefined);
  db.__reset();
  db.__tables.team.push({ id: TEAM, active_pipeline_configuration_id: 'pc-1' });
});

function triggerRows() {
  return db.__tables.trigger;
}

describe('saveMovement — listener derivation', () => {
  it('clean save: canonical row + one derived trigger per listen, valid, no object code', async () => {
    const result = await saveMovement({ teamId: TEAM, source: SOURCE_V1, userId: 'user-1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.validity.status).toBe('valid');
    expect(result.movementName).toBe('intake');
    expect(result.listeners).toHaveLength(1);
    expect(result.listeners[0]).toMatchObject({
      kind: 'email',
      configKey: 'deals',
      inboundAddress: 'inbox+deals@example.com',
      movementName: 'intake',
      runMode: 'live',
      reused: false,
    });
    expect(result.infos).toEqual([]);

    const [row] = db.__tables.movement;
    expect(row).toMatchObject({
      team_id: TEAM,
      name: 'intake',
      source: SOURCE_V1,
      trigger_id: result.listeners[0].triggerId,
      created_by_user_id: 'user-1',
    });
    expect(row.validity_status).toBe('valid');

    const [trigger] = triggerRows();
    expect(trigger).toMatchObject({
      id: result.listeners[0].triggerId,
      name: 'movement/intake/intake',
      fired_movement_name: 'intake',
      kind: 'email',
      config: { key: 'deals' },
      movement_id: row.id,
      run_mode: 'live',
    });

    // Execution reads the canonical text: the trigger row carries NO
    // orchestration and no mapping rows are derived.
    expect(trigger.orchestration ?? null).toBeNull();
    expect(db.__tables.translation_graph).toHaveLength(0);

    // Journey taps: no MCP context on this save (a plain web-UI/API save) —
    // the user milestone is gated MCP-only for monotonicity, so it does NOT
    // fire here; the team milestone fires on any route.
    expect(journey.recordUserMilestone).not.toHaveBeenCalled();
    expect(journey.recordTeamMilestone).toHaveBeenCalledWith(TEAM, {
      milestone: 'first_automation_saved',
    });
  });

  it('round-trip: getMovement returns the exact saved source + listeners', async () => {
    const saved = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const detail = await getMovement({ teamId: TEAM, id: saved.movementId });
    expect(detail).not.toBeNull();
    expect(detail?.source).toBe(SOURCE_V1);
    expect(detail?.validityStatus).toBe('valid');
    expect(detail?.name).toBe('intake');
    expect(detail?.listeners).toHaveLength(1);
    expect(detail?.listeners[0]).toMatchObject({
      triggerId: saved.listeners[0].triggerId,
      kind: 'email',
      configKey: 'deals',
      inboundAddress: 'inbox+deals@example.com',
      movementName: 'intake',
      runMode: 'live',
    });
    expect(detail?.kind).toBe('email');
  });

  it('multi-listen: one derived trigger per listen, in file order', async () => {
    const result = await saveMovement({ teamId: TEAM, source: MULTI_LISTEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.listeners).toHaveLength(2);
    expect(result.listeners.map((l) => [l.configKey, l.movementName])).toEqual([
      ['deals', 'intake'],
      ['intros', 'digest'],
    ]);
    expect(triggerRows().map((t) => t.name).sort()).toEqual([
      'movement/intake/digest',
      'movement/intake/intake',
    ]);
  });

  it('inserting a movement ahead of colliding-key listens: originals keep their trigger ids AND movement', async () => {
    const first = await saveMovement({ teamId: TEAM, source: TWO_SHARED });
    if (!first.ok) throw new Error(`first save should be live: ${JSON.stringify(first)}`);
    expect(triggerRows()).toHaveLength(2);
    const before = new Map(triggerRows().map((t) => [t.fired_movement_name, t.id]));

    const second = await saveMovement({ teamId: TEAM, id: first.movementId, source: THREE_SHARED });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(triggerRows()).toHaveLength(3);
    const after = new Map(triggerRows().map((t) => [t.fired_movement_name, t.id]));
    // Every original trigger kept BOTH its id and its movement association —
    // the insert did not shift ids down the file the way the old match did.
    for (const movement of ['a', 'b']) {
      expect(after.get(movement)).toBe(before.get(movement));
    }
    // `c` is new — a fresh trigger, not adopted from an existing one.
    expect(before.has('c')).toBe(false);
    expect(after.get('c')).toEqual(expect.any(String));
  });

  it('identity: an unchanged listen keeps its trigger id (and run history) across saves', async () => {
    const first = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    if (!first.ok) throw new Error('first save should be live');

    const second = await saveMovement({ teamId: TEAM, id: first.movementId, source: SOURCE_V2 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.listeners[0].triggerId).toBe(first.listeners[0].triggerId);
    expect(second.listeners[0].reused).toBe(true);
    expect(triggerRows()).toHaveLength(1);
  });

  it('an unambiguous config change updates the row in place (same trigger id)', async () => {
    const first = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    if (!first.ok) throw new Error('first save should be live');

    const rekeyed = SOURCE_V1.replace('key: "deals"', 'key: "renamed-deals"');
    const second = await saveMovement({ teamId: TEAM, id: first.movementId, source: rekeyed });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.listeners[0].triggerId).toBe(first.listeners[0].triggerId);
    expect(second.listeners[0].reused).toBe(true);
    expect(second.listeners[0].configKey).toBe('renamed-deals');
    const [trigger] = triggerRows();
    expect(trigger.config).toEqual({ key: 'renamed-deals' });
  });

  it('removed listens retire their rows', async () => {
    const first = await saveMovement({ teamId: TEAM, source: MULTI_LISTEN });
    if (!first.ok) throw new Error('first save should be live');
    expect(triggerRows()).toHaveLength(2);

    const oneListen = MULTI_LISTEN.replace(
      'listen to inbox { key: "intros" } fire digest\n',
      '',
    );
    const second = await saveMovement({ teamId: TEAM, id: first.movementId, source: oneListen });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.listeners).toHaveLength(1);
    expect(second.listeners[0].configKey).toBe('deals');
    expect(second.listeners[0].triggerId).toBe(first.listeners[0].triggerId);
    expect(triggerRows()).toHaveLength(1);
  });

  it('zero listens (library): every derived row retired, links cleared, info surfaced', async () => {
    const first = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    if (!first.ok) throw new Error('first save should be live');

    const second = await saveMovement({ teamId: TEAM, id: first.movementId, source: NO_LISTEN });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.listeners).toEqual([]);
    expect(second.validity.status).toBe('valid');
    // The file still declares a dispatchable movement — the checker says so
    // (info severity, never blocking).
    expect(second.infos.map((d) => d.code)).toEqual(['MOV_LISTEN_MISSING']);

    expect(triggerRows()).toHaveLength(0);
    const [row] = db.__tables.movement;
    expect(row.trigger_id).toBeNull();
  });

  it('check errors: unconsented save needs confirmation; consented save SHIPS broken (no draft limbo)', async () => {
    const first = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    if (!first.ok) throw new Error('first save should be live');

    const second = await saveMovement({
      teamId: TEAM,
      id: first.movementId,
      source: SOURCE_BROKEN,
      userId: 'user-1',
    });

    // Decision 3b: no draft limbo — the broken save stops at the consent gate.
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.needsConfirmation).toBe(true);
    expect(second.validity?.status).toBe('invalid');
    expect(second.movementId).toBe(first.movementId);
    // Text persisted regardless — the broken movement is a retained artifact.
    expect(db.__tables.movement[0].source).toBe(SOURCE_BROKEN);

    // Journey taps: `needsConfirmation` still counts for the team milestone
    // (any route) — the person authored an automation even though it
    // didn't ship live. No MCP context on this save, so the MCP-gated user
    // milestone does not fire.
    expect(journey.recordUserMilestone).not.toHaveBeenCalled();
    expect(journey.recordTeamMilestone).toHaveBeenCalledWith(TEAM, {
      milestone: 'first_automation_saved',
    });

    // Consent SHIPS it: the broken source is what runs now (fires-and-fails).
    const consented = await saveMovement({
      teamId: TEAM,
      id: first.movementId,
      source: SOURCE_BROKEN,
      acknowledgeErrors: true,
    });
    expect(consented.ok).toBe(true);
    if (!consented.ok) return;
    expect(consented.validity.status).toBe('invalid');
    expect(db.__tables.movement[0].validity_consented_at).toBeTruthy();

    // A clean re-save goes live again with the SAME identity.
    const third = await saveMovement({ teamId: TEAM, id: first.movementId, source: SOURCE_V2 });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.validity.status).toBe('valid');
    expect(third.listeners[0].triggerId).toBe(first.listeners[0].triggerId);
  });

  it('run_mode is NEVER touched by reconciliation after creation', async () => {
    const first = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    if (!first.ok) throw new Error('first save should be live');

    // Operator pauses the listener (the one hand-editable field).
    triggerRows()[0].run_mode = 'off';

    // Re-save with a config change — the row updates in place…
    const rekeyed = SOURCE_V1.replace('key: "deals"', 'key: "other"');
    const second = await saveMovement({ teamId: TEAM, id: first.movementId, source: rekeyed });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // …but run_mode stays what the operator set.
    expect(triggerRows()[0].run_mode).toBe('off');
    expect(second.listeners[0].runMode).toBe('off');
  });

  it('clean check but provisioning failure: text saved, save fails honestly', async () => {
    // No active pipeline configuration → listener provisioning errors after
    // a clean check.
    db.__tables.team.length = 0;

    const result = await saveMovement({ teamId: TEAM, source: SOURCE_V1, userId: 'user-1' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.needsConfirmation).toBeUndefined();
    expect(result.errors?.[0]).toContain('pipeline_configuration');

    const [row] = db.__tables.movement;
    expect(row).toMatchObject({ source: SOURCE_V1, name: 'intake' });

    // Journey taps: a VALID save whose provisioning failed on infrastructure
    // still counts for the team milestone — the source is durably persisted
    // and the user did everything in their control. No MCP context here, so
    // the MCP-gated user milestone does not fire.
    expect(journey.recordUserMilestone).not.toHaveBeenCalled();
    expect(journey.recordTeamMilestone).toHaveBeenCalledWith(TEAM, {
      milestone: 'first_automation_saved',
    });
  });

  it('an engine-unsupported construct refuses the save with the construct named (consent gate)', async () => {
    // (Edge statements run since E7, file imports since E8 — a nested
    // movement declaration is the gate fixture now.)
    const first = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    if (!first.ok) throw new Error('first save should be live');
    const withNested = SOURCE_V1.replace(
      '# version one',
      ['movement nested(x: <inbox-[:message]->>) {', '    y = x.`a`', '  }'].join('\n'),
    );
    const result = await saveMovement({ teamId: TEAM, source: withNested, id: first.movementId });
    // Engine-unsupported is a check error now — consent gate, not a hard error.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.needsConfirmation).toBe(true);
    expect(result.validity?.status).toBe('invalid');
    expect((result.errors ?? []).join(' ')).toContain('nested movement declarations');
    // Text saved; the previously-derived listener row is untouched.
    expect(db.__tables.movement[0].source).toBe(withNested);
    expect(triggerRows()).toHaveLength(1);
  });

  it('listen alias: trigger name equals the lane alias when present', async () => {
    const result = await saveMovement({ teamId: TEAM, source: ALIASED_LANES });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.listeners).toHaveLength(2);
    const names = triggerRows().map((t) => t.name as string).sort();
    expect(names).toEqual(["Alice's lane", "Bob's lane"]);
    // The alias is the display name, but the fired movement is persisted
    // separately so dispatch can still pick it — the MOVENG_NOT_FOUND fix.
    expect(triggerRows().map((t) => t.fired_movement_name)).toEqual(['intake', 'intake']);
    // The returned listener info must report the fired movement (not null) even
    // though the alias name has no `movement/<file>/<movement>` shape to parse —
    // otherwise the editor can't match the live row and shows "Starts on save".
    expect(result.listeners.map((l) => l.movementName).sort()).toEqual(['intake', 'intake']);
  });

  it('a through-staged extraction saves LIVE (the engine runs staging)', async () => {
    const staged = `import { email } from adapters
import { fetchPages as fetch_pages } from plugins

inbox = connect email

function intake(m: <inbox-[:message]->>) {
  mentions = extract from [m.\`text\`] {
    node company: "each company mentioned" {
      name: "the company's name"
      urls: "URLs for this company"
    } through [fetch_pages({ urls: urls })] {
      name: "the company's name"
      website: "the company's official website"
    }
  }
}

listen to inbox { key: "deals" } fire intake
`;
    const result = await saveMovement({ teamId: TEAM, source: staged });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected live save');
    expect(result.validity.status).toBe('valid');
    expect(result.listeners).toHaveLength(1);
    // The derived trigger row exists (dispatch routes to it) with an
    // EMPTY orchestration — execution reads the canonical text.
    const trigger = triggerRows()[0];
    expect(trigger.movement_id).toBe(result.movementId);
    expect(trigger.orchestration ?? null).toBeNull();
    expect(db.__tables.translation_graph).toHaveLength(0);
  });

  it('editing the declaration keeps the stored name (durable) — only the fire target follows', async () => {
    const first = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    if (!first.ok) throw new Error('first save should be live');

    const edited = SOURCE_V1.replace(/\bintake\b/g, 'intake_v2');
    const second = await saveMovement({ teamId: TEAM, id: first.movementId, source: edited });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.listeners[0].triggerId).toBe(first.listeners[0].triggerId);

    const [row] = db.__tables.movement;
    // The display name is user-owned: editing the declaration does NOT rename it.
    expect(row.name).toBe('intake');
    // The fire target DOES follow the declaration — the trigger names the fired
    // movement (second segment) while the first segment stays the row name.
    const [trigger] = triggerRows();
    expect(trigger).toMatchObject({
      id: first.listeners[0].triggerId,
      name: 'movement/intake/intake_v2',
      fired_movement_name: 'intake_v2',
    });
  });

  it('rename via an explicit name updates the row in place and is durable', async () => {
    const first = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    if (!first.ok) throw new Error('first save should be live');

    // An explicit name (a rename from the breadcrumb / the MCP) takes effect.
    const renamed = await saveMovement({
      teamId: TEAM,
      id: first.movementId,
      source: SOURCE_V1,
      name: 'My Intake',
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(db.__tables.movement[0].name).toBe('My Intake');

    // …and survives a later save that passes no name (the web's normal save).
    const resaved = await saveMovement({ teamId: TEAM, id: first.movementId, source: SOURCE_V1 });
    expect(resaved.ok).toBe(true);
    expect(db.__tables.movement[0].name).toBe('My Intake');
  });

  it('no declaration + no name: nothing saved, actionable error', async () => {
    const result = await saveMovement({
      teamId: TEAM,
      source: '# just a comment\n',
      userId: 'user-1',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.movementId).toBeUndefined();
    expect(result.errors?.[0]).toContain('movement declaration');
    expect(db.__tables.movement).toHaveLength(0);

    // Journey tap: this returns BEFORE upsertMovementRow — nothing was
    // saved, so neither milestone fires.
    expect(journey.recordUserMilestone).not.toHaveBeenCalled();
    expect(journey.recordTeamMilestone).not.toHaveBeenCalled();
  });
});

// Monotonicity gate (plans/2026-07-16-journey-instrumentation, "Monotonicity",
// ruling 2026-07-16): the SAME `saveMovement` call gates its two milestones
// differently. The user's `first_automation_saved` counts ONLY an MCP save
// (so it can never outrun the user's `first_mcp_call`, stamped earlier in
// the same request by the auth middleware); the team's counts ANY route,
// unconditionally, so a web-UI save still lights up the account.
describe('saveMovement — journey milestone MCP gate (monotonicity)', () => {
  it('web-UI save (no MCP context): user milestone does NOT fire, team milestone does', async () => {
    // beforeEach already leaves unsafeCurrentContext() returning undefined —
    // spelled out here for clarity since this test's whole point is the gate.
    contextMock.unsafeCurrentContext.mockReturnValue(undefined);

    const result = await saveMovement({ teamId: TEAM, source: SOURCE_V1, userId: 'user-1' });

    expect(result.ok).toBe(true);
    expect(journey.recordUserMilestone).not.toHaveBeenCalled();
    expect(journey.recordTeamMilestone).toHaveBeenCalledWith(TEAM, {
      milestone: 'first_automation_saved',
    });
  });

  it('MCP save (x-mcp-domain: automation stamped on the Context): both milestones fire', async () => {
    contextMock.unsafeCurrentContext.mockReturnValue({
      mcpDomain: 'automation',
      authenticated: false,
    });

    const result = await saveMovement({ teamId: TEAM, source: SOURCE_V1, userId: 'user-1' });

    expect(result.ok).toBe(true);
    expect(journey.recordUserMilestone).toHaveBeenCalledWith('user-1', {
      milestone: 'first_automation_saved',
      teamId: TEAM,
    });
    expect(journey.recordTeamMilestone).toHaveBeenCalledWith(TEAM, {
      milestone: 'first_automation_saved',
    });
  });

  it('MCP context present but no acting user known: only the team milestone fires', async () => {
    contextMock.unsafeCurrentContext.mockReturnValue({
      mcpDomain: 'automation',
      authenticated: false,
    });

    const result = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });

    expect(result.ok).toBe(true);
    expect(journey.recordUserMilestone).not.toHaveBeenCalled();
    expect(journey.recordTeamMilestone).toHaveBeenCalledWith(TEAM, {
      milestone: 'first_automation_saved',
    });
  });
});

describe('listMovements / deleteMovement', () => {
  it('lists listeners + first channel; delete removes every derived row', async () => {
    const saved = await saveMovement({ teamId: TEAM, source: MULTI_LISTEN });
    if (!saved.ok) throw new Error('save should be live');

    const list = await listMovements(TEAM);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: saved.movementId,
      name: 'intake',
      validityStatus: 'valid',
      kind: 'email',
    });
    expect(list[0].listeners).toHaveLength(2);
    expect(list[0].listeners.map((l) => l.configKey).sort()).toEqual(['deals', 'intros']);

    const deleted = await deleteMovement({ teamId: TEAM, id: saved.movementId });
    expect(deleted).toBe(true);
    expect(db.__tables.movement).toHaveLength(0);
    expect(db.__tables.trigger).toHaveLength(0);
    expect(await getMovement({ teamId: TEAM, id: saved.movementId })).toBeNull();

    expect(await deleteMovement({ teamId: TEAM, id: saved.movementId })).toBe(false);
  });
});

describe('saveMovement — file imports (movement libraries)', () => {
  it('a consumer importing from a saved library checks through the resolver and goes live', async () => {
    const result = await saveMovement({
      teamId: TEAM,
      source: WITH_FILE_IMPORT,
      userId: 'user-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.validity.status).toBe('valid');
    expect(result.listeners).toHaveLength(1);
  });

  it('an unresolvable import path needs confirmation with MOV_IMPORT_FILE_UNRESOLVED', async () => {
    const result = await saveMovement({
      teamId: TEAM,
      source: WITH_BAD_FILE_IMPORT,
      userId: 'user-1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.needsConfirmation).toBe(true);
    expect(result.validity?.status).toBe('invalid');
    expect((result.errors ?? []).join(' ')).toContain('No movement file named');
    // The structured diagnostics (with codes) ride validity.reason.
    const reason = result.validity?.reason as { diagnostics?: Array<{ code: string }> };
    expect(reason?.diagnostics?.map((d) => d.code)).toContain('MOV_IMPORT_FILE_UNRESOLVED');
    // The text is saved either way — the retained artifact.
    expect(db.__tables.movement).toHaveLength(1);
  });
});

describe('movementNameFromSource', () => {
  it('reads the first declaration name, even from unparseable drafts', () => {
    expect(movementNameFromSource(SOURCE_V1)).toBe('intake');
    expect(movementNameFromSource('movement a(x: <s-[:m]->>) {}\nmovement b(y: <s-[:m]->>) {}')).toBe('a');
    expect(movementNameFromSource('garbage {{{\nmovement my_flow(')).toBe('my_flow');
    expect(movementNameFromSource('# none')).toBeUndefined();
  });

  it('reads a backtick-quoted human name (mirrors the parser)', () => {
    expect(movementNameFromSource('movement `Sweep Intake`(x: <s-[:m]->>) {}')).toBe('Sweep Intake');
    expect(movementNameFromSource('garbage {{{\nmovement `My Flow`(')).toBe('My Flow');
    // a bare name following a backtick one still reads the first
    expect(movementNameFromSource('movement `First Lane`(x: <s-[:m]->>) {}\nmovement second(y: <s-[:m]->>) {}')).toBe(
      'First Lane',
    );
  });
});

// A derived trigger belongs to the MOVEMENT it fires, never to a `listen`
// statement's file position. These pure-function cases pin the identity
// contract: reordering movements, or inserting one ahead of the others, never
// reassigns a surviving listener's row — even when several movements share the
// same channel + config (the collision that made the old positional match
// silently hand every subsequent trigger id to a DIFFERENT movement).
describe('planListenerReconciliation — movement-scoped identity', () => {
  let seq = 0;
  const row = (opts: {
    firedMovementName: string | null;
    configKey: string | null;
    kind?: string;
    credentialsId?: string | null;
  }): DerivedTriggerRow => ({
    id: `trigger-${(seq += 1)}`,
    movementId: 'movement-1',
    name: `trigger-${seq}`,
    firedMovementName: opts.firedMovementName,
    kind: opts.kind ?? 'email',
    credentialsId: opts.credentialsId ?? null,
    config: opts.configKey === null ? {} : { key: opts.configKey },
    runMode: 'live',
  });
  const want = (opts: {
    movementName: string;
    configKey: string | null;
    kind?: string;
    credentialsId?: string | null;
  }) => ({
    movementName: opts.movementName,
    kind: opts.kind ?? 'email',
    credentialsId: opts.credentialsId ?? null,
    configKey: opts.configKey,
  });

  it('reordering movements keeps each trigger with its own movement', () => {
    const a = row({ firedMovementName: 'a', configKey: 'x1' });
    const b = row({ firedMovementName: 'b', configKey: 'x2' });
    const plan = planListenerReconciliation({
      // file re-authored b-then-a
      desired: [want({ movementName: 'b', configKey: 'x2' }), want({ movementName: 'a', configKey: 'x1' })],
      existing: [a, b],
    });
    expect(plan.matches.map((m) => m?.id)).toEqual([b.id, a.id]);
    expect(plan.retired).toEqual([]);
  });

  it('inserting a new movement ahead of colliding-config listens preserves every id AND association', () => {
    // Three movements share the SAME inbound channel+config — the exact shape
    // the old (kind, creds, configKey)-only match reassigned positionally.
    const a = row({ firedMovementName: 'a', configKey: 'shared' });
    const b = row({ firedMovementName: 'b', configKey: 'shared' });
    const c = row({ firedMovementName: 'c', configKey: 'shared' });
    const plan = planListenerReconciliation({
      desired: [
        want({ movementName: 'd', configKey: 'shared' }), // NEW, inserted at the top
        want({ movementName: 'a', configKey: 'shared' }),
        want({ movementName: 'b', configKey: 'shared' }),
        want({ movementName: 'c', configKey: 'shared' }),
      ],
      existing: [a, b, c],
    });
    expect(plan.matches[0]).toBeUndefined(); // d is new — mints a fresh trigger
    expect(plan.matches[1]?.id).toBe(a.id);
    expect(plan.matches[2]?.id).toBe(b.id);
    expect(plan.matches[3]?.id).toBe(c.id);
    expect(plan.retired).toEqual([]);
  });

  it('a new movement on a shared channel never steals a surviving movement’s trigger', () => {
    const a = row({ firedMovementName: 'a', configKey: 'shared' });
    const plan = planListenerReconciliation({
      desired: [want({ movementName: 'a', configKey: 'shared' }), want({ movementName: 'b', configKey: 'shared' })],
      existing: [a],
    });
    expect(plan.matches[0]?.id).toBe(a.id); // a keeps its row
    expect(plan.matches[1]).toBeUndefined(); // b mints a new one — did not adopt a's
    expect(plan.retired).toEqual([]);
  });

  it('renaming a movement (config unchanged) reunites the listen with its row', () => {
    const a = row({ firedMovementName: 'intake', configKey: 'deals' });
    const plan = planListenerReconciliation({
      desired: [want({ movementName: 'intake_v2', configKey: 'deals' })],
      existing: [a],
    });
    expect(plan.matches[0]?.id).toBe(a.id); // movement-blind fallback keeps run history
    expect(plan.retired).toEqual([]);
  });

  it('an unambiguous config change still updates the row in place (pass 2 intact)', () => {
    const a = row({ firedMovementName: 'intake', configKey: 'deals' });
    const plan = planListenerReconciliation({
      desired: [want({ movementName: 'intake', configKey: 'renamed-deals' })],
      existing: [a],
    });
    expect(plan.matches[0]?.id).toBe(a.id);
    expect(plan.retired).toEqual([]);
  });

  it('a legacy row (fired_movement_name null) is adopted, not retired', () => {
    const legacy = row({ firedMovementName: null, configKey: 'deals' });
    const plan = planListenerReconciliation({
      desired: [want({ movementName: 'intake', configKey: 'deals' })],
      existing: [legacy],
    });
    expect(plan.matches[0]?.id).toBe(legacy.id);
    expect(plan.retired).toEqual([]);
  });

  it('two identical listens in ONE movement each keep a row (positional within the movement)', () => {
    const first = row({ firedMovementName: 'intake', configKey: 'shared' });
    const second = row({ firedMovementName: 'intake', configKey: 'shared' });
    const plan = planListenerReconciliation({
      desired: [
        want({ movementName: 'intake', configKey: 'shared' }),
        want({ movementName: 'intake', configKey: 'shared' }),
      ],
      existing: [first, second],
    });
    expect(plan.matches.map((m) => m?.id).sort()).toEqual([first.id, second.id].sort());
    expect(plan.retired).toEqual([]);
  });
});

// A clean save mints an immutable version (deduped by content), and the
// movement points at its current version (versioning D1/D2/D3, P11). These
// run the REAL mint (../version_store) against the same in-memory fake.
describe('saveMovement — versioning (movement_version)', () => {
  const versionsFor = (movementId: string) =>
    db.__tables.movement_version
      .filter((v) => v.movement_id === movementId)
      .sort((a, b) => (a.version_number as number) - (b.version_number as number));

  it('clean save mints v1 and points current_version_id at it', async () => {
    const result = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [movement] = db.__tables.movement;
    const versions = versionsFor(movement.id as string);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      movement_id: movement.id,
      team_id: TEAM,
      version_number: 1,
      source: SOURCE_V1,
    });
    expect(versions[0].content_hash).toEqual(expect.any(String));
    // The movement pins it.
    expect(movement.current_version_id).toBe(versions[0].id);
  });

  it('re-saving identical source is deduped — no new version, pin unchanged', async () => {
    const first = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const movementId = first.movementId;
    const v1Id = (db.__tables.movement.find((m) => m.id === movementId) ?? {}).current_version_id;

    await saveMovement({ teamId: TEAM, id: movementId, source: SOURCE_V1 });

    expect(versionsFor(movementId)).toHaveLength(1);
    expect(
      (db.__tables.movement.find((m) => m.id === movementId) ?? {}).current_version_id,
    ).toBe(v1Id);
  });

  it('a changed source mints v2 and repins; both snapshots are retained', async () => {
    const first = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const movementId = first.movementId;

    await saveMovement({ teamId: TEAM, id: movementId, source: SOURCE_V2 });

    const versions = versionsFor(movementId);
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.version_number)).toEqual([1, 2]);
    expect(versions[0].source).toBe(SOURCE_V1);
    expect(versions[1].source).toBe(SOURCE_V2);
    // current pins the latest (v2).
    expect((db.__tables.movement.find((m) => m.id === movementId) ?? {}).current_version_id).toBe(
      versions[1].id,
    );
  });

  it('a draft (failed gate) mints NO version — only runnable snapshots are versioned', async () => {
    const result = await saveMovement({ teamId: TEAM, source: SOURCE_BROKEN });
    // SOURCE_BROKEN writes to an unresolvable adapter → not a clean 'live' save.
    expect(result.ok).toBe(false);
    const movement = db.__tables.movement[0];
    expect(movement).toBeDefined();
    expect(versionsFor(movement.id as string)).toHaveLength(0);
    expect(movement.current_version_id ?? null).toBeNull();
  });
});

// Agent-facing optimistic concurrency (expectedRevision): the customer-agent
// save surface (knowledge_agent_tools.ts) exposes a content-hash precondition
// so a stale-copy-holding agent can't silently clobber a newer edit (the prod
// incident this guards against). Independent of `baseUpdatedAt` (the editor's
// timestamp-keyed guard, exercised elsewhere) — this is content-keyed and is
// what getMovement's `revision` field feeds.
describe('saveMovement — expectedRevision (agent-facing optimistic concurrency)', () => {
  it('getMovement carries `revision` as the content hash of the current source', async () => {
    const saved = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    if (!saved.ok) throw new Error('save should be live');

    const detail = await getMovement({ teamId: TEAM, id: saved.movementId });
    expect(detail?.revision).toBe(movementSourceHash(SOURCE_V1));
  });

  it('a matching expectedRevision saves normally', async () => {
    const first = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    if (!first.ok) throw new Error('first save should be live');
    const detail = await getMovement({ teamId: TEAM, id: first.movementId });
    const revision = detail!.revision;

    const second = await saveMovement({
      teamId: TEAM,
      id: first.movementId,
      source: SOURCE_V2,
      expectedRevision: revision,
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(db.__tables.movement[0].source).toBe(SOURCE_V2);
  });

  it('a stale expectedRevision is rejected with an actionable conflict, and does NOT overwrite', async () => {
    const first = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    if (!first.ok) throw new Error('first save should be live');
    const staleRevision = movementSourceHash(SOURCE_V1);

    // Someone else's save lands in between — the stored source moves on.
    const landedInBetween = await saveMovement({
      teamId: TEAM,
      id: first.movementId,
      source: SOURCE_V2,
    });
    if (!landedInBetween.ok) throw new Error('intervening save should be live');

    // The stale-copy holder now tries to save its own (still-V1-based) edit.
    const staleEdit = SOURCE_V1.replace('# version one', '# a stale edit');
    const result = await saveMovement({
      teamId: TEAM,
      id: first.movementId,
      source: staleEdit,
      expectedRevision: staleRevision,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors?.[0]).toBe(
      'This automation changed since you read it — call getAutomation again, merge your changes into the latest version, and re-save with the new revision.',
    );
    expect(result.movementId).toBe(first.movementId);
    expect(result.conflict).toMatchObject({
      currentSource: SOURCE_V2,
      currentRevision: movementSourceHash(SOURCE_V2),
    });
    // Nothing was overwritten — the intervening save's source is untouched.
    expect(db.__tables.movement[0].source).toBe(SOURCE_V2);
  });

  it('omitting expectedRevision preserves today\'s behaviour: overwrites regardless', async () => {
    const first = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    if (!first.ok) throw new Error('first save should be live');

    await saveMovement({ teamId: TEAM, id: first.movementId, source: SOURCE_V2 });

    // A third save with no expectedRevision at all still succeeds, even
    // though the caller's hypothetical copy would be stale.
    const third = await saveMovement({
      teamId: TEAM,
      id: first.movementId,
      source: SOURCE_V1,
    });
    expect(third.ok).toBe(true);
    expect(db.__tables.movement[0].source).toBe(SOURCE_V1);
  });

  it('expectedRevision is ignored on the creation path (no existing automation)', async () => {
    const result = await saveMovement({
      teamId: TEAM,
      source: SOURCE_V1,
      expectedRevision: 'anything-at-all',
    });
    expect(result.ok).toBe(true);
  });
});

// ── Backtick credential args — provision-path coverage ──────────────────────
//
// The bug: `checkCredentialArg` unwrapped backtick names, but `collectFileListeners`
// in provision.ts gated `credentialName` on a bare-ident regex. A movement with
// `attio(credentials: \`Dev-loop Attio\`)` type-checked clean but provisioned with
// `credentials_id = null`. The aliased form worked; the direct form did not.

// A catalog with an attio adapter requiring credentials and a credential named
// 'Dev-loop Attio' (a name that MUST be backtick-quoted in source because it
// contains a hyphen).
function makeAttioTeamCatalog() {
  return {
    catalog: mockCatalog({
      adapters: {
        attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }]},
      },
      credentials: {
        'Dev-loop Attio': { adapter: 'attio' },
      },
    }),
    resolveCredentialId: (name: string) => (name === 'Dev-loop Attio' ? 'cred-attio-123' : undefined),
    credentialsByName: {
      'Dev-loop Attio': { id: 'cred-attio-123', rowName: 'Dev-loop Attio', adapters: ['attio'] },
    },
    resolveFile: () => undefined,
    notes: [],
    gaps: [],
  };
}

// Source using a DIRECT backtick credential (no alias).
const DIRECT_BACKTICK_SOURCE = [
  'import { attio } from adapters',
  'import { `Dev-loop Attio` } from credentials',
  '',
  'crm = connect attio using `Dev-loop Attio`',
  '',
  'function intake(m: <crm-[:company]->>) {',
  '  # process',
  '}',
  '',
  'listen to crm {} fire intake',
].join('\n');

// Source using the ALIASED form — the existing working path.
const ALIASED_SOURCE = [
  'import { attio } from adapters',
  'import { `Dev-loop Attio` as crm_cred } from credentials',
  '',
  'crm = connect attio using crm_cred',
  '',
  'function intake(m: <crm-[:company]->>) {',
  '  # process',
  '}',
  '',
  'listen to crm {} fire intake',
].join('\n');

describe('saveMovement — backtick credential args (provision-path)', () => {
  beforeEach(() => {
    db.__reset();
    db.__tables.team.push({ id: TEAM, active_pipeline_configuration_id: 'pc-1' });
  });

  it('direct backtick cred: trigger provisions with the correct credentials_id (non-null)', async () => {
    catalogMock.movementCatalogForTeam.mockResolvedValueOnce(makeAttioTeamCatalog());
    const result = await saveMovement({ teamId: TEAM, source: DIRECT_BACKTICK_SOURCE });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.validity.status).toBe('valid');
    expect(result.listeners).toHaveLength(1);
    expect(result.listeners[0].credentialsId).toBe('cred-attio-123');

    const [trigger] = triggerRows();
    expect(trigger.credentials_id).toBe('cred-attio-123');
  });

  it('aliased cred and direct backtick cred produce the same credentials_id (parity)', async () => {
    // Aliased path (the previously working form).
    catalogMock.movementCatalogForTeam.mockResolvedValueOnce(makeAttioTeamCatalog());
    const aliasResult = await saveMovement({ teamId: TEAM, source: ALIASED_SOURCE });
    expect(aliasResult.ok).toBe(true);
    if (!aliasResult.ok) return;
    const aliasCredId = aliasResult.listeners[0].credentialsId;

    db.__reset();
    db.__tables.team.push({ id: TEAM, active_pipeline_configuration_id: 'pc-1' });

    // Direct backtick path (the previously broken form).
    catalogMock.movementCatalogForTeam.mockResolvedValueOnce(makeAttioTeamCatalog());
    const directResult = await saveMovement({ teamId: TEAM, source: DIRECT_BACKTICK_SOURCE });
    expect(directResult.ok).toBe(true);
    if (!directResult.ok) return;
    const directCredId = directResult.listeners[0].credentialsId;

    expect(directCredId).toBe(aliasCredId);
    expect(directCredId).toBe('cred-attio-123');
  });
});

// The language-version pin: stamped at FIRST save, never moved by an edit, and
// the version every save validates under (recorded as `checked_against`).
describe('the language version pin', () => {
  it('a first save stamps the current version and records the check under it', async () => {
    const saved = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    expect(saved.ok).toBe(true);
    const [row] = db.__tables.movement;
    expect(row.language_version).toBe(CURRENT_LANGUAGE_VERSION);
    expect(row.validity_checked_against).toBe(CURRENT_LANGUAGE_VERSION);

    const [item] = await listMovements(TEAM);
    expect(item).toMatchObject({ languageVersion: CURRENT_LANGUAGE_VERSION, validityCheckedAgainst: CURRENT_LANGUAGE_VERSION });
  });

  it('a re-save keeps an older pin and validates under it', async () => {
    const first = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    if (!first.ok) throw new Error('first save failed');
    // A movement saved before the current version existed.
    db.__tables.movement[0].language_version = 1;

    // The edit is written as version 1 reads it (the old spelling).
    const sourceV1Spelling = SOURCE_V2.replace('inbox = connect email', 'inbox = email()').replace('function intake', 'movement intake');
    const again = await saveMovement({ teamId: TEAM, id: first.movementId, source: sourceV1Spelling });
    expect(again.ok).toBe(true);
    const [row] = db.__tables.movement;
    expect(row.source).toBe(sourceV1Spelling);
    expect(row.language_version).toBe(1);
    expect(row.validity_checked_against).toBe(1);

    const detail = await getMovement({ teamId: TEAM, id: first.movementId });
    expect(detail).toMatchObject({ languageVersion: 1, validityCheckedAgainst: 1 });
  });

  it('a movement pinned to a version this release does not support is refused, not saved as current', async () => {
    const first = await saveMovement({ teamId: TEAM, source: SOURCE_V1 });
    if (!first.ok) throw new Error('first save failed');
    db.__tables.movement[0].language_version = 99;

    const again = await saveMovement({ teamId: TEAM, id: first.movementId, source: SOURCE_V2 });
    expect(again.ok).toBe(false);
    const [row] = db.__tables.movement;
    expect(row.language_version).toBe(99);
    expect(row.validity_status).toBe('invalid');
    expect(JSON.stringify(row.validity_reason)).toContain('MOV_LANGUAGE_VERSION_UNSUPPORTED');
  });
});

describe('the language upgrade, through the real save', () => {
  // A movement saved under version 4 in its spelling; the upgrade rewrites it
  // by the checker's fixes and saves the rewrite with the pin, in one save.
  const OLD = `import { email } from adapters

inbox = email()

# hand each deal to the team
movement intake(m: <inbox-[:message]->>) {
  subject = UPPER(TRIM(m.Subject))
}

listen to inbox { key: "deals" } fire intake
`;
  const NEW = `import { email } from adapters

inbox = connect email

# hand each deal to the team
function intake(m: <inbox-[:message]->>) {
  subject = Text.upper(Text.trim(m.Subject))
}

listen to inbox { key: "deals" } fire intake
`;

  // The upgrade validates and saves inside the team, as one of its members;
  // the request Context is faked in this file, so that wrapper only runs.
  let inTeam: jest.SpyInstance | undefined;
  beforeEach(() => {
    inTeam = jest
      .spyOn(jest.requireActual<typeof import('../firing_context')>('../firing_context'), 'withTeamContext')
      .mockImplementation((_teamId, fn) => fn());
  });
  afterEach(() => inTeam?.mockRestore());

  /** A movement as a version 4 save left it: the row, and its snapshot. */
  async function savedUnderFour(): Promise<string> {
    const first = await saveMovement({ teamId: TEAM, source: NEW });
    if (!first.ok) throw new Error(`first save failed: ${(first.errors ?? []).join('; ')}`);
    const [row] = db.__tables.movement;
    Object.assign(row, { source: OLD, language_version: 4 });
    Object.assign(db.__tables.movement_version[0], { source: OLD, language_version: 4 });
    return first.movementId;
  }

  it('shows the rewrite, then saves it with the pin once acknowledged', async () => {
    const { upgradeMovement } = await import('../language_upgrade');
    const id = await savedUnderFour();

    const shown = await upgradeMovement({ teamId: TEAM, id, acknowledge: false });
    expect(shown).toMatchObject({ status: 'needs_acknowledgement', upgradedSource: NEW, diagnostics: [] });
    expect(db.__tables.movement[0]).toMatchObject({ source: OLD, language_version: 4 });

    const done = await upgradeMovement({ teamId: TEAM, id, acknowledge: true });
    expect(done).toMatchObject({ status: 'upgraded', upgradedSource: NEW });
    expect(db.__tables.movement[0]).toMatchObject({ source: NEW, language_version: 5, upgrade_diagnostics: null });
    const current = db.__tables.movement_version.find((v) => v.id === db.__tables.movement[0].current_version_id);
    expect(current).toMatchObject({ source: NEW, language_version: 5 });

    const again = await upgradeMovement({ teamId: TEAM, id, acknowledge: true });
    expect(again.status).toBe('already_current');
  });

  it('a movement the rewrite cannot make clean keeps its text and its pin', async () => {
    const { upgradeMovement } = await import('../language_upgrade');
    const id = await savedUnderFour();
    const broken = (text: string, upper: string) => text.replace('# hand', `write nowhere-[:thing]-> { x: ${upper}("a") }\n# hand`);
    db.__tables.movement[0].source = broken(OLD, 'UPPER');

    const result = await upgradeMovement({ teamId: TEAM, id, acknowledge: true });
    expect(result.status).toBe('blocked');
    expect(result).toMatchObject({ upgradedSource: broken(NEW, 'Text.upper') });
    if (result.status === 'not_found') return;
    expect(result.diagnostics.map((d) => [d.severity, d.line])).toEqual([['error', 5]]);
    expect(db.__tables.movement[0]).toMatchObject({ source: broken(OLD, 'UPPER'), language_version: 4 });
  });
});
