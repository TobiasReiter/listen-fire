// The event-subscription diff-sync keys channels on the RESOLVED ADDRESS.
//
// REAL: `syncListenSubscriptions` — desired channels off trigger rows, the
// webhook_subscription rows it mints, the external ensure/remove calls.
// Mocked: the DB (in-memory tables), the adapter registry (one
// container-shaped adapter with two address hops), adapter resolution (a
// recording fake).
//
// The two pins this file exists to hold (both DRIVEN live before the fix,
// 2026-07-17 — plans/2026-07-10-adapter-entry-positions/8_event_edges.md):
//
//   1. TRANSITION: an old config-shaped row and a new resolved-address row
//      naming the SAME container reconcile to ONE channel — no
//      double-register, no churn.
//   2. NEVER HALF-SCOPED: a trigger whose address didn't resolve provisions
//      NO channel and says so in a note. It used to mint a row with
//      status 'active', a null external id and ZERO notes — a silently-dead
//      listen every later sync short-circuited past.

jest.mock('../../../../lib/kysely', () => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {
    trigger: [],
    webhook_subscription: [],
    remote_adapter: [],
  };
  const matches = (row: Row, wheres: Array<[string, string, unknown]>) =>
    wheres.every(([col, op, val]) => {
      if (op === '=') return row[col] === val;
      if (op === 'in') return Array.isArray(val) && (val as unknown[]).includes(row[col]);
      if (op === 'is') return (row[col] ?? null) === val;
      if (op === 'is not') return (row[col] ?? null) !== val;
      return false;
    });
  function builder(table: string, mode: 'select' | 'insert' | 'update' | 'delete') {
    const wheres: Array<[string, string, unknown]> = [];
    let patch: Row = {};
    let values: Row = {};
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
      return rows().slice();
    };
    const api = {
      where: (col: string, op: string, val: unknown) => {
        wheres.push([col, op, val]);
        return api;
      },
      select: () => api,
      selectAll: () => api,
      orderBy: () => api,
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
  const qb = () => ({
    selectFrom: (t: string) => builder(t, 'select'),
    insertInto: (t: string) => builder(t, 'insert'),
    updateTable: (t: string) => builder(t, 'update'),
    deleteFrom: (t: string) => builder(t, 'delete'),
  });
  return {
    getQb: qb,
    getCoreQb: qb,
    getKnowledgeQb: qb,
    getAutomationsQb: qb,
    __tables: tables,
    __reset: () => {
      for (const key of Object.keys(tables)) tables[key] = [];
    },
  };
});

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// One container-shaped adapter: two address hops (shelf, crate) — NOT
// Airtable's names, so nothing here can pass by matching a hardcoded shape.
jest.mock('../../adapters/registry', () => {
  const manifests = [
    {
      adapterType: 'pantry',
      displayName: 'Pantry',
      supportedTriggers: ['webhook'],
      methods: ['createRecord', 'ensureEventSubscription', 'removeEventSubscription'],
      requiredCredentialType: 'PANTRY',
      triggerKinds: ['PANTRY'],
      subscribableEvents: ['thing.created', 'thing.deleted'],
      subscriptionScopeKeys: ['shelf', 'crate'],
      listenConfig: [
        { key: 'shelf', required: true, narrows: { collection: 'Shelf', matchField: 'Id' } },
        { key: 'crate', required: true, narrows: { collection: 'Crate', matchField: 'Id' } },
      ],
    },
  ];
  return {
    listAdapterManifests: () => manifests,
    getAdapterManifest: (slug: string) => manifests.find((m) => m.adapterType === slug) ?? null,
    resolveAdapterSlug: (kind: string) => (kind === 'PANTRY' ? 'pantry' : kind),
    hasAdapter: (kind: string) => kind === 'pantry' || kind === 'PANTRY',
    adapterInboundRoutingKey: () => null,
    inboundAddressFor: () => null,
  };
});

jest.mock('../../adapters/builtin_modules', () => ({ builtinInboundSecretIssuedByProvider: jest.fn(() => false) }));

const ensureCalls: Array<{
  events: string[];
  callbackUrl: string;
  scope?: Record<string, string>;
  current?: { externalId?: string; events: string[] };
}> = [];
const removeCalls: Array<{ callbackUrl: string; externalId?: string; scope?: Record<string, string> }> = [];

jest.mock('../../adapters/resolve', () => ({
  resolveAdapter: jest.fn(async () => ({
    ensureEventSubscription: async (input: {
      events: string[];
      callbackUrl: string;
      scope?: Record<string, string>;
      current?: { externalId?: string; events: string[] };
    }) => {
      ensureCalls.push(input);
      return { externalId: `wh-${ensureCalls.length}`, secret: `secret-${ensureCalls.length}` };
    },
    removeEventSubscription: async (input: {
      callbackUrl: string;
      externalId?: string;
      scope?: Record<string, string>;
    }) => {
      removeCalls.push(input);
    },
  })),
}));

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { syncListenSubscriptions } from '../listen_subscriptions';
import { resolveAdapter } from '../../adapters/resolve';
import { builtinInboundSecretIssuedByProvider } from '../../adapters/builtin_modules';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const kyselyMock = require('../../../../lib/kysely') as {
  __tables: Record<string, Array<Record<string, unknown>>>;
  __reset: () => void;
};

const TEAM = 'team-1' as TeamId;

function triggerRow(input: {
  name: string;
  config: Record<string, unknown>;
  resolvedAddress?: Record<string, string>;
}): Record<string, unknown> {
  return {
    id: `trg-${input.name}`,
    team_id: TEAM,
    name: input.name,
    kind: 'pantry',
    credentials_id: 'cred-1',
    movement_id: 'mov-1',
    config: input.config,
    resolved_address: input.resolvedAddress ?? null,
    run_mode: 'live',
  };
}

beforeEach(() => {
  kyselyMock.__reset();
  ensureCalls.length = 0;
  removeCalls.length = 0;
});

describe('syncListenSubscriptions — a built-in whose provider issues the webhook secret', () => {
  const pantryListen = (events: string[]) =>
    triggerRow({ name: 'issued', config: { shelf: 'shf_north', crate: 'crt_apples', events } });
  const secretlessOnce = () =>
    (resolveAdapter as jest.Mock).mockResolvedValueOnce({
      ensureEventSubscription: async (input: { events: string[]; callbackUrl: string }) => {
        ensureCalls.push(input);
        return { externalId: `wh-${ensureCalls.length}` };
      },
      removeEventSubscription: async (input: { callbackUrl: string; externalId?: string }) => {
        removeCalls.push(input);
      },
    });

  beforeEach(() => (builtinInboundSecretIssuedByProvider as jest.Mock).mockReturnValue(true));
  afterEach(() => (builtinInboundSecretIssuedByProvider as jest.Mock).mockReturnValue(false));

  it('a registration that returns no secret is refused and withdrawn', async () => {
    kyselyMock.__tables.trigger.push(pantryListen(['thing.created']));
    secretlessOnce();

    const { notes } = await syncListenSubscriptions({ teamId: TEAM });

    expect(notes).toEqual([
      'pantry: event-subscription provisioning failed (the provider issues the webhook secret but its registration returned none; deliveries cannot be verified)',
    ]);
    expect(kyselyMock.__tables.webhook_subscription).toEqual([]);
    expect(removeCalls).toHaveLength(1);
  });

  it('a change answered without a secret keeps the one the provider issued before', async () => {
    kyselyMock.__tables.trigger.push(pantryListen(['thing.created']));
    await syncListenSubscriptions({ teamId: TEAM });
    kyselyMock.__tables.trigger[0].config = { shelf: 'shf_north', crate: 'crt_apples', events: ['thing.created', 'thing.deleted'] };
    secretlessOnce();

    const { notes } = await syncListenSubscriptions({ teamId: TEAM });

    expect(notes).toEqual([]);
    expect(removeCalls).toEqual([]);
    expect(kyselyMock.__tables.webhook_subscription[0]).toMatchObject({ status: 'active', webhook_secret: 'secret-1' });
  });
});

describe('syncListenSubscriptions — channel identity is the resolved address', () => {
  it('TRANSITION: an old config-shaped row and a new resolved-address row naming the same container are ONE channel', async () => {
    kyselyMock.__tables.trigger.push(
      // Old shape: the authored config carries the ids (pre-resolution row).
      triggerRow({
        name: 'legacy',
        config: { shelf: 'shf_north', crate: 'crt_apples', events: ['thing.created'] },
      }),
      // New shape: positioned instance — config names only the crate; the
      // resolved address carries the position's shelf.
      triggerRow({
        name: 'positioned',
        config: { crate: 'crt_apples', events: ['thing.deleted'] },
        resolvedAddress: { shelf: 'shf_north', crate: 'crt_apples' },
      }),
    );

    const { notes } = await syncListenSubscriptions({ teamId: TEAM });

    expect(notes).toEqual([]);
    const subs = kyselyMock.__tables.webhook_subscription;
    expect(subs).toHaveLength(1);
    expect(subs[0].scope && JSON.parse(subs[0].scope as string)).toEqual({
      shelf: 'shf_north',
      crate: 'crt_apples',
    });
    // One registration, carrying the UNION of both listens' events.
    expect(ensureCalls).toHaveLength(1);
    expect([...ensureCalls[0].events].sort()).toEqual(['thing.created', 'thing.deleted']);
    expect(subs[0].status).toBe('active');
    expect(subs[0].external_webhook_id).toBe('wh-1');
  });

  it('NEVER HALF-SCOPED: an unresolved address provisions NO channel, and says so', async () => {
    kyselyMock.__tables.trigger.push(
      triggerRow({
        name: 'unresolved',
        config: { crate: 'crt_apples', events: ['thing.created'] }, // no shelf anywhere
      }),
    );

    const { notes } = await syncListenSubscriptions({ teamId: TEAM });

    // No row minted at all — nothing can ever sit 'active' with a null
    // external id (the driven silently-dead state).
    expect(kyselyMock.__tables.webhook_subscription).toHaveLength(0);
    expect(ensureCalls).toHaveLength(0);
    expect(notes.some((n) => n.includes('unresolved') && n.includes('shelf'))).toBe(true);
  });

  it('the resolved address WINS over a disagreeing config value (the derived field is the identity)', async () => {
    kyselyMock.__tables.trigger.push(
      triggerRow({
        name: 'drifted',
        config: { shelf: 'shf_stale', crate: 'crt_apples', events: ['thing.created'] },
        resolvedAddress: { shelf: 'shf_north', crate: 'crt_apples' },
      }),
    );

    await syncListenSubscriptions({ teamId: TEAM });

    const subs = kyselyMock.__tables.webhook_subscription;
    expect(subs).toHaveLength(1);
    expect(JSON.parse(subs[0].scope as string)).toEqual({
      shelf: 'shf_north',
      crate: 'crt_apples',
    });
  });

  it('two resolved addresses differing only in the POSITION hop are TWO channels (the leak gate)', async () => {
    kyselyMock.__tables.trigger.push(
      triggerRow({
        name: 'north',
        config: { crate: 'crt_apples', events: ['thing.created'] },
        resolvedAddress: { shelf: 'shf_north', crate: 'crt_apples' },
      }),
      triggerRow({
        name: 'south',
        config: { crate: 'crt_apples', events: ['thing.created'] },
        resolvedAddress: { shelf: 'shf_south', crate: 'crt_apples' },
      }),
    );

    await syncListenSubscriptions({ teamId: TEAM });

    const subs = kyselyMock.__tables.webhook_subscription;
    expect(subs).toHaveLength(2);
    const scopes = subs.map((s) => JSON.parse(s.scope as string) as Record<string, string>);
    expect(new Set(scopes.map((s) => s.shelf))).toEqual(new Set(['shf_north', 'shf_south']));
    expect(ensureCalls).toHaveLength(2);
  });

  it('a retired listen tears its channel down by the same address identity', async () => {
    kyselyMock.__tables.trigger.push(
      triggerRow({
        name: 'kept',
        config: { crate: 'crt_apples', events: ['thing.created'] },
        resolvedAddress: { shelf: 'shf_north', crate: 'crt_apples' },
      }),
    );
    await syncListenSubscriptions({ teamId: TEAM });
    expect(kyselyMock.__tables.webhook_subscription).toHaveLength(1);

    // The listen disappears; the next sync retires the channel.
    kyselyMock.__tables.trigger.length = 0;
    await syncListenSubscriptions({ teamId: TEAM });

    const subs = kyselyMock.__tables.webhook_subscription;
    expect(subs).toHaveLength(1);
    expect(subs[0].deleted_at).not.toBeNull();
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0].scope).toEqual({ shelf: 'shf_north', crate: 'crt_apples' });
  });
});

describe('syncListenSubscriptions — a remote install subscribes over the wire', () => {
  function installRemote(): void {
    kyselyMock.__tables.remote_adapter.push({
      team_id: TEAM,
      adapter_type: 'acme_crm',
      credentials_id: 'cred-remote',
      manifest: {
        protocolVersion: 2,
        adapterType: 'acme_crm',
        baseUrl: 'http://127.0.0.1:1/',
        authStrategy: { kind: 'bearer' },
        supportedTriggers: ['webhook'],
        runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
        methods: ['preprocessInbound', 'ensureEventSubscription', 'removeEventSubscription'],
      },
    });
  }

  function remoteListen(events?: string[]): Record<string, unknown> {
    return {
      id: 'trg-remote',
      team_id: TEAM,
      name: 'crm listen',
      kind: 'acme_crm',
      credentials_id: null,
      movement_id: 'mov-1',
      config: events !== undefined ? { events } : {},
      resolved_address: null,
      run_mode: 'live',
    };
  }

  it("provisions a channel under the install's provider key, passing the listen's events through", async () => {
    installRemote();
    kyselyMock.__tables.trigger.push(remoteListen(['company.created']));

    const { notes } = await syncListenSubscriptions({ teamId: TEAM });

    expect(notes).toEqual([]);
    const [sub] = kyselyMock.__tables.webhook_subscription;
    expect(sub).toMatchObject({
      provider: 'ACME_CRM',
      credentials_id: null,
      status: 'active',
      external_webhook_id: 'wh-1',
      webhook_secret: 'secret-1',
    });
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0].events).toEqual(['company.created']);
    expect(ensureCalls[0].callbackUrl).toMatch(/\/api\/public\/webhook-sync\/acme_crm\//);
    expect(resolveAdapter).toHaveBeenCalledWith({ adapterType: 'acme_crm', teamId: TEAM });
  });

  it('a listen with no events selection subscribes to everything (an empty list)', async () => {
    installRemote();
    kyselyMock.__tables.trigger.push(remoteListen());

    await syncListenSubscriptions({ teamId: TEAM });

    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0].events).toEqual([]);
  });

  it("tears the channel down through the install, mapping its provider key back to the install's slug", async () => {
    installRemote();
    kyselyMock.__tables.trigger.push(remoteListen(['company.created']));
    await syncListenSubscriptions({ teamId: TEAM });
    (resolveAdapter as jest.Mock).mockClear();

    kyselyMock.__tables.trigger.length = 0;
    const { notes } = await syncListenSubscriptions({ teamId: TEAM });

    expect(notes).toEqual([]);
    expect(removeCalls).toHaveLength(1);
    expect(resolveAdapter).toHaveBeenCalledWith({ adapterType: 'acme_crm', teamId: TEAM });
    expect(kyselyMock.__tables.webhook_subscription[0].deleted_at).not.toBeNull();
  });
  /** Seed what an earlier healthy sync left: a live remote channel. */
  async function liveRemoteChannel(): Promise<void> {
    installRemote();
    kyselyMock.__tables.trigger.push(remoteListen(['company.created']));
    await syncListenSubscriptions({ teamId: TEAM });
    expect(kyselyMock.__tables.webhook_subscription).toHaveLength(1);
    removeCalls.length = 0;
  }

  it('a failed install listing never tears a remote channel down', async () => {
    await liveRemoteChannel();
    const installs = kyselyMock.__tables.remote_adapter;
    delete (kyselyMock.__tables as Partial<typeof kyselyMock.__tables>).remote_adapter;
    try {
      const { notes } = await syncListenSubscriptions({ teamId: TEAM });

      expect(notes).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/install listing failed/),
          expect.stringMatching(/ACME_CRM: remote installs could not all be read/),
        ]),
      );
    } finally {
      kyselyMock.__tables.remote_adapter = installs;
    }
    expect(removeCalls).toEqual([]);
    const [sub] = kyselyMock.__tables.webhook_subscription;
    expect(sub.deleted_at ?? null).toBeNull();
    expect(sub.status).toBe('active');
  });

  it('an unreadable stored manifest never tears a remote channel down', async () => {
    await liveRemoteChannel();
    kyselyMock.__tables.remote_adapter[0].manifest = { adapterType: 'acme_crm' };

    await syncListenSubscriptions({ teamId: TEAM });

    expect(removeCalls).toEqual([]);
    expect(kyselyMock.__tables.webhook_subscription[0].deleted_at ?? null).toBeNull();
  });

  function secretlessRemote(): void {
    (resolveAdapter as jest.Mock).mockResolvedValueOnce({
      ensureEventSubscription: async (input: { events: string[]; callbackUrl: string }) => {
        ensureCalls.push(input);
        return { externalId: `wh-${ensureCalls.length}` };
      },
      removeEventSubscription: async (input: { callbackUrl: string; externalId?: string }) => {
        removeCalls.push(input);
      },
    });
  }

  it('a new remote channel whose registration returns no secret is refused and withdrawn', async () => {
    installRemote();
    kyselyMock.__tables.trigger.push(remoteListen(['company.created']));
    secretlessRemote();

    const { notes } = await syncListenSubscriptions({ teamId: TEAM });

    expect(notes).toEqual([
      'acme_crm: event-subscription provisioning failed (remote adapter returned no secret; deliveries cannot be verified)',
    ]);
    expect(kyselyMock.__tables.webhook_subscription).toEqual([]);
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]).toMatchObject({ externalId: 'wh-1' });
    expect(removeCalls[0].callbackUrl).toBe(ensureCalls[0].callbackUrl);
  });

  it('an updated remote channel answered without a secret goes back to needing registration, and the next sync restores it', async () => {
    await liveRemoteChannel();
    kyselyMock.__tables.trigger[0].config = { events: ['company.created', 'company.deleted'] };
    secretlessRemote();

    const refused = await syncListenSubscriptions({ teamId: TEAM });

    expect(refused.notes).toEqual([
      'acme_crm: event-subscription provisioning failed (remote adapter returned no secret; deliveries cannot be verified)',
    ]);
    expect(removeCalls).toHaveLength(1);
    const [sub] = kyselyMock.__tables.webhook_subscription;
    expect(sub).toMatchObject({ status: 'pending', webhook_secret: 'pending', external_webhook_id: null });
    expect(sub.deleted_at ?? null).toBeNull();

    // The remote answers with a secret again: the same row is registered and live.
    const restored = await syncListenSubscriptions({ teamId: TEAM });

    expect(restored.notes).toEqual([]);
    expect(kyselyMock.__tables.webhook_subscription).toHaveLength(1);
    expect(kyselyMock.__tables.webhook_subscription[0]).toMatchObject({
      id: sub.id,
      status: 'active',
      webhook_secret: `secret-${ensureCalls.length}`,
    });
    expect(ensureCalls.at(-1)?.events).toEqual(['company.created', 'company.deleted']);
  });

  /** A remote that answers every ensure with the same id and `secret`. */
  function steadyRemote(secret: string): void {
    (resolveAdapter as jest.Mock).mockResolvedValueOnce({
      ensureEventSubscription: async (input: { events: string[]; callbackUrl: string }) => {
        ensureCalls.push(input);
        return { externalId: 'wh-1', secret };
      },
      removeEventSubscription: async () => undefined,
    });
  }

  it('an active remote channel with unchanged events is ensured again on every sync', async () => {
    await liveRemoteChannel();
    const before = ensureCalls.length;
    steadyRemote('secret-1');

    await syncListenSubscriptions({ teamId: TEAM });

    expect(ensureCalls).toHaveLength(before + 1);
    expect(ensureCalls.at(-1)?.events).toEqual(['company.created']);
  });

  it('the same secret back leaves the row untouched', async () => {
    await liveRemoteChannel();
    const row = kyselyMock.__tables.webhook_subscription[0];
    const updatedAt = row.updated_at;
    row.updated_at = 'untouched';
    steadyRemote('secret-1');

    await syncListenSubscriptions({ teamId: TEAM });

    expect(row).toMatchObject({ status: 'active', webhook_secret: 'secret-1', external_webhook_id: 'wh-1' });
    expect(row.updated_at).toBe('untouched');
    row.updated_at = updatedAt;
  });

  it('a new secret back rotates the stored one', async () => {
    await liveRemoteChannel();
    steadyRemote('rotated');

    const { notes } = await syncListenSubscriptions({ teamId: TEAM });

    expect(notes).toEqual([]);
    expect(kyselyMock.__tables.webhook_subscription[0]).toMatchObject({
      status: 'active',
      webhook_secret: 'rotated',
      external_webhook_id: 'wh-1',
    });
  });

  it('a built-in channel with unchanged events is not ensured again', async () => {
    kyselyMock.__tables.trigger.push(
      triggerRow({ name: 'steady', config: {}, resolvedAddress: { shelf: 'shf_north', crate: 'crt_apples' } }),
    );
    await syncListenSubscriptions({ teamId: TEAM });
    const before = ensureCalls.length;
    expect(before).toBe(1);

    await syncListenSubscriptions({ teamId: TEAM });

    expect(ensureCalls).toHaveLength(before);
  });

  it('a row left needing registration is registered again even when its events have not changed', async () => {
    await liveRemoteChannel();
    kyselyMock.__tables.webhook_subscription[0].status = 'pending';
    const before = ensureCalls.length;

    await syncListenSubscriptions({ teamId: TEAM });

    expect(ensureCalls).toHaveLength(before + 1);
    expect(kyselyMock.__tables.webhook_subscription[0].status).toBe('active');
  });
});
