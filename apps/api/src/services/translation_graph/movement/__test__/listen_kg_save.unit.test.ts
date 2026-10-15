// A graph listen's reconciliation + the event-subscription diff-sync.
//
// REAL: saveMovement/provision (graph listens → KG_MUTATION-matchable
// trigger rows carrying the listen's own config, identity preserved
// across saves), and the REAL `listen_subscriptions.ts` diff-sync
// (webhook_subscription rows minted per (adapter, credential) channel;
// Adapter.ensureEventSubscription / removeEventSubscription called as
// listens come and go). Mocked: the DB (in-memory tables), the catalog
// assembly, the adapter registry manifests, and adapter resolution (a
// fake recording subscription calls).

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('movement-engine/services/knowledge_pipeline/output_v3/schemas');

jest.mock('../../../../lib/kysely', () => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {
    movement: [],
    trigger: [],
    translation_graph: [],
    team: [],
    webhook_subscription: [],
    movement_version: [],
    // Retiring a listener settles the runs parked on it
    // (`settleRunsParkedOnTriggers`), so the retire path reads both of these.
    parked_run: [],
    trigger_run: [],
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

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const ATTIO_EVENTS = ['record.created', 'record.updated', 'record.deleted'];

jest.mock('../../adapters/registry', () => {
  const manifests = [
    {
      adapterType: 'attio',
      displayName: 'Attio',
      supportedTriggers: ['snapshot', 'webhook'],
      methods: ['createRecord', 'ensureEventSubscription', 'removeEventSubscription'],
      requiredCredentialType: 'ATTIO',
      triggerKinds: ['ATTIO'],
      subscribableEvents: ['record.created', 'record.updated', 'record.deleted'],
    },
    {
      adapterType: 'email',
      displayName: 'Email',
      supportedTriggers: ['webhook'],
      methods: [],
      triggerConfig: [
        { kind: 'slug', key: 'key', prefix: 'inbox+', suffix: '@example.com', routingKey: true },
      ],
      triggerKinds: ['CUSTOM_EMAIL'],
    },
    {
      adapterType: 'kg',
      displayName: 'Knowledge Graph',
      supportedTriggers: ['mutation'],
      methods: ['createRecord'],
      triggerKinds: ['KG_MUTATION'],
      subscribableEvents: ['record.created', 'record.updated', 'record.deleted'],
      // The watched type is an ordinary address hop (D40) — the same
      // declaration Airtable's `base`/`table` make.
      listenConfig: [
        { key: 'type', required: true, narrows: { collection: 'Node Type', matchField: 'Id' } },
        { key: 'fields', format: 'fields' },
      ],
    },
  ];
  const aliasToSlug: Record<string, string> = {
    ATTIO: 'attio',
    CUSTOM_EMAIL: 'email',
    KG_MUTATION: 'kg',
  };
  const getManifest = (slug: string) =>
    manifests.find((m) => m.adapterType === (aliasToSlug[slug] ?? slug)) ?? null;
  return {
    listAdapterManifests: () => manifests,
    getAdapterManifest: getManifest,
    resolveAdapterSlug: (kind: string) => aliasToSlug[kind] ?? kind,
    hasAdapter: (kind: string) => manifests.some((m) => m.adapterType === (aliasToSlug[kind] ?? kind)),
    adapterInboundRoutingKey: (slug: string) =>
      (getManifest(slug)?.triggerConfig ?? []).find(
        (f: { routingKey?: boolean }) => f.routingKey === true,
      ) ?? null,
    inboundAddressFor: (slug: string, config: Record<string, unknown>) => {
      const field = (getManifest(slug)?.triggerConfig ?? []).find(
        (f: { routingKey?: boolean }) => f.routingKey === true,
      ) as { key: string; prefix?: string; suffix?: string } | undefined;
      const value = field ? config[field.key] : undefined;
      return typeof value === 'string' && value.length > 0
        ? `${field?.prefix ?? ''}${value}${field?.suffix ?? ''}`
        : null;
    },
  };
});

// Adapter resolution: a fake whose subscription methods record their calls.
const ensureCalls: Array<{
  adapterType: string;
  credentialsId?: string;
  events: string[];
  callbackUrl: string;
  current?: { externalId?: string; events: string[] };
}> = [];
const removeCalls: Array<{ adapterType: string; callbackUrl: string; externalId?: string }> = [];

// The graph adapter's introspection — the SAME `listEntryPoints()` /
// `describe(typeId)` pair every adapter's resolver is built from. The
// framework identity IS the node type's NAME; the store's own id rides
// `externalId`.
const KG_ENTRIES = [
  {
    typeId: 'company',
    displayName: 'company',
    externalId: 'nt-company',
    writable: true,
    readable: true,
  },
];
const KG_DESCRIBE: Record<string, unknown> = {
  company: {
    typeId: 'company',
    displayName: 'company',
    fields: [
      { fieldId: 'pt-name', displayName: 'name', kind: 'string', writable: true, required: false },
      {
        fieldId: 'pt-domains',
        displayName: 'domains',
        kind: 'string',
        cardinality: 'many',
        writable: true,
        required: false,
      },
    ],
    references: [],
  },
};

jest.mock('../../adapters/resolve', () => ({
  resolveAdapter: jest.fn(
    async ({ adapterType, credentialsId }: { adapterType: string; credentialsId?: string }) => ({
      adapterType,
      // Introspection — only the KG adapter publishes a non-empty surface in
      // this suite (its display→UUID mapping drives the kg-listen config
      // translation); other adapters never reach the introspection path here.
      listEntryPoints: async () =>
        adapterType === 'kg' ? KG_ENTRIES : [],
      describe: async (typeId: string) =>
        adapterType === 'kg' ? (KG_DESCRIBE[typeId] ?? null) : null,
      // The root hop publishes the `Node Type` MEMBERS a listen's `type:` pin
      // selects between — the same walk Airtable's bases ride, so the address
      // resolves through `resolveListenAddress` with nothing kg-shaped in the
      // host.
      ...(adapterType === 'kg'
        ? {
            edgesFrom: async () => ({
              descriptor: {
                typeId: '__meta__',
                displayName: 'Knowledge Graph',
                fields: [],
                references: [],
              },
              targetPositions: Object.fromEntries(
                KG_ENTRIES.map((e) => [
                  `Node Type::${e.typeId}`,
                  {
                    adapterType: 'kg',
                    recordType: 'Node Type',
                    identity: {
                      kind: 'stable',
                      recordId: e.typeId,
                      data: { Id: e.typeId, Name: e.displayName },
                    },
                  },
                ]),
              ),
            }),
          }
        : {}),
      ensureEventSubscription: async (input: {
        events: string[];
        callbackUrl: string;
        current?: { externalId?: string; events: string[] };
      }) => {
        ensureCalls.push({ adapterType, credentialsId, ...input });
        return input.current?.externalId !== undefined
          ? { externalId: input.current.externalId }
          : { externalId: `wh-${ensureCalls.length}`, secret: `secret-${ensureCalls.length}` };
      },
      removeEventSubscription: async (input: { callbackUrl: string; externalId?: string }) => {
        removeCalls.push({ adapterType, ...input });
      },
    }),
  ),
}));

jest.mock('../../storage/tg_table', () => ({
  saveTriggerEntriesForTrigger: jest.fn(async () => undefined),
}));

// The catalog: kg schema, an events-capable attio, an email. The KG's
// display→UUID resolution no longer rides on the catalog — it's derived at
// the engine boundary from the KG adapter's OWN introspection (the
// resolveAdapter mock below publishes it).
jest.mock('../catalog', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockCatalog } = require('movement-lang');
  const kgSchema = {
    positions: {
      company: {
        properties: { name: 'text', domains: { kind: 'list', of: 'text' } },
        edges: {},
      },
    },
    collections: {},
    writableRoots: {},
  };
  const attioSchema = {
    positions: { record: { properties: {}, edges: {}, openProperties: true } },
    collections: {},
    writableRoots: {},
  };
  return {
    // The address resolver reads an instance's entry-position args off the
    // catalog; nothing here declares any, so it is the identity.
    positionArgValues: () => ({}),
    movementCatalogForTeam: jest.fn(async () => ({
      catalog: mockCatalog({
        adapters: {
          attio: {
            constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
            triggerConfig: ['events'],
            triggerConfigOptions: {
              events: ['record.created', 'record.updated', 'record.deleted'],
            },
            schema: attioSchema,
          },
          email: { constructionArgs: [{ name: 'credentials', kind: 'position', required: false }], triggerConfig: ['key'] },
          // A write-only target (the real Google Sheets / Drive / Dropbox
          // shape): its manifest names no trigger type, so nothing that
          // happens there can ever reach us.
          sheets: {
            constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
            canFire: false,
            schema: attioSchema,
          },
          kg: {
            constructionArgs: [],
            triggerConfig: ['events', 'type', 'fields'],
            triggerConfigRequired: ['type'],
            triggerConfigOptions: {
              events: ['record.created', 'record.updated', 'record.deleted'],
            },
            triggerConfigFormats: { fields: 'fields' },
            schema: kgSchema,
          },
        },
        credentials: { acme: { adapter: 'attio' }, sheet_cred: { adapter: 'sheets' } },
      }),
      resolveCredentialId: (name: string) =>
        name === 'acme' ? 'cred-attio-1' : name === 'sheet_cred' ? 'cred-sheets-1' : undefined,
      credentialsByName: {},
      resolveFile: () => undefined,
      notes: [],
      gaps: [],
    })),
  };
});

import { saveMovement } from '../provision';

const db = jest.requireMock('../../../../lib/kysely') as {
  __tables: Record<string, Array<Record<string, unknown>>>;
  __reset: () => void;
};

const TEAM = 'team-1';

const KG_SOURCE = `import { kg } from adapters

graph = kg()

movement on_company_change(rec: <graph-[:company]->>) {
  x = rec.\`name\`
}

listen to graph { type: "company", events: ["record.created", "record.updated"], fields: [domains] } fire on_company_change
`;

const KG_SOURCE_V2 = KG_SOURCE.replace('x = rec.`name`', 'y = rec.`name`');
const KG_LIBRARY = `import { kg } from adapters

graph = kg()

movement on_company_change(rec: <graph-[:company]->>) {
  x = rec.\`name\`
}
`;

const ATTIO_SOURCE = (events: string) => `import { attio } from adapters
import { acme } from credentials

crm = attio(credentials: acme)

movement on_new_record(rec: <crm-[:record]->>) {
  x = "noted"
}

listen to crm { events: [${events}] } fire on_new_record
`;

beforeEach(() => {
  db.__reset();
  db.__tables.team.push({ id: TEAM, active_pipeline_configuration_id: 'pc-1' });
  ensureCalls.length = 0;
  removeCalls.length = 0;
});

describe('a graph listen — trigger derivation', () => {
  it('derives a kg-slug trigger row carrying the listen config verbatim', async () => {
    const result = await saveMovement({ teamId: TEAM, source: KG_SOURCE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.validity.status).toBe('valid');
    expect(result.listeners).toHaveLength(1);
    expect(result.listeners[0]).toMatchObject({
      kind: 'kg',
      credentialsId: null,
      inboundAddress: null,
      movementName: 'on_company_change',
    });

    const [trigger] = db.__tables.trigger;
    expect(trigger).toMatchObject({
      kind: 'kg',
      name: 'movement/on_company_change/on_company_change',
      config: {
        type: 'company',
        events: ['record.created', 'record.updated'],
        fields: ['domains'],
      },
      run_mode: 'live',
    });
    expect(trigger.movement_id).toBe(db.__tables.movement[0].id);

    // The KG needs no external subscription — in-process dispatch.
    expect(ensureCalls).toEqual([]);
    expect(db.__tables.webhook_subscription).toEqual([]);
  });

  it('carries suppress_self into the persisted trigger', async () => {
    const source = `import { kg } from adapters

graph = kg()

movement mirror(rec: <graph-[:company]->>) {
  x = rec.\`name\`
}

listen to graph { type: "company", suppress_self: true } fire mirror
`;
    const result = await saveMovement({ teamId: TEAM, source });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [trigger] = db.__tables.trigger;
    // The universal 2-way-sync flag rides the listen's own config, and the
    // dispatch boundary reads it back off the persisted row.
    expect(trigger.config).toMatchObject({ type: 'company', suppress_self: true });
  });

  it('an unchanged kg listen keeps its trigger id across saves (run history preserved)', async () => {
    const first = await saveMovement({ teamId: TEAM, source: KG_SOURCE });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const id = first.listeners[0].triggerId;

    const second = await saveMovement({
      teamId: TEAM,
      id: first.movementId,
      source: KG_SOURCE_V2,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.listeners[0].triggerId).toBe(id);
    expect(second.listeners[0].reused).toBe(true);
    expect(db.__tables.trigger).toHaveLength(1);
  });

  it('removing the kg listen retires its trigger row', async () => {
    const first = await saveMovement({ teamId: TEAM, source: KG_SOURCE });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await saveMovement({
      teamId: TEAM,
      id: first.movementId,
      source: KG_LIBRARY,
    });
    expect(second.ok).toBe(true);
    expect(db.__tables.trigger).toHaveLength(0);
  });
});

describe('listen events → external subscription diff-sync', () => {
  it('a new events listen provisions the channel: row minted, ensureEventSubscription called, secret persisted', async () => {
    const result = await saveMovement({ teamId: TEAM, source: ATTIO_SOURCE('"record.created"') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0]).toMatchObject({
      adapterType: 'attio',
      credentialsId: 'cred-attio-1',
      events: ['record.created'],
    });
    expect(ensureCalls[0].current).toBeUndefined();

    const [row] = db.__tables.webhook_subscription;
    expect(row).toMatchObject({
      team_id: TEAM,
      provider: 'ATTIO',
      credentials_id: 'cred-attio-1',
      provisioned_by: 'movement-listen',
      external_webhook_id: 'wh-1',
      webhook_secret: 'secret-1',
      status: 'active',
    });
    // The callback URL is keyed by the ROW id — stable per channel.
    expect(ensureCalls[0].callbackUrl).toContain(`/webhook-sync/attio/${row.id}`);
  });

  it('an unchanged event set re-saves without touching the source registration', async () => {
    const first = await saveMovement({ teamId: TEAM, source: ATTIO_SOURCE('"record.created"') });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await saveMovement({
      teamId: TEAM,
      id: first.movementId,
      source: ATTIO_SOURCE('"record.created"'),
    });
    expect(ensureCalls).toHaveLength(1);
  });

  it('a changed event set diff-syncs IN PLACE: same row, ensure called with current registration', async () => {
    const first = await saveMovement({ teamId: TEAM, source: ATTIO_SOURCE('"record.created"') });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const rowId = db.__tables.webhook_subscription[0].id;

    await saveMovement({
      teamId: TEAM,
      id: first.movementId,
      source: ATTIO_SOURCE('"record.created", "record.updated"'),
    });

    expect(ensureCalls).toHaveLength(2);
    expect(ensureCalls[1]).toMatchObject({
      events: ['record.created', 'record.updated'],
      current: { externalId: 'wh-1', events: ['record.created'] },
    });
    expect(db.__tables.webhook_subscription).toHaveLength(1);
    expect(db.__tables.webhook_subscription[0].id).toBe(rowId);
    expect(db.__tables.webhook_subscription[0].subscriptions).toBe(
      JSON.stringify([
        { event_type: 'record.created' },
        { event_type: 'record.updated' },
      ]),
    );
  });

  it('retiring the last listen on a channel tears the subscription down', async () => {
    const first = await saveMovement({ teamId: TEAM, source: ATTIO_SOURCE('"record.created"') });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const library = `import { attio } from adapters
import { acme } from credentials

crm = attio(credentials: acme)

movement on_new_record(rec: <crm-[:record]->>) {
  x = "noted"
}
`;
    await saveMovement({ teamId: TEAM, id: first.movementId, source: library });

    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]).toMatchObject({ adapterType: 'attio', externalId: 'wh-1' });
    const [row] = db.__tables.webhook_subscription;
    expect(row.status).toBe('disabled');
    expect(row.deleted_at).toBeInstanceOf(Date);
  });

  it('a listen with no events config subscribes the full manifest vocabulary', async () => {
    const source = `import { attio } from adapters
import { acme } from credentials

crm = attio(credentials: acme)

movement on_new_record(rec: <crm-[:record]->>) {
  x = "noted"
}

listen to crm fire on_new_record
`;
    const result = await saveMovement({ teamId: TEAM, source });
    expect(result.ok).toBe(true);
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0].events).toEqual(ATTIO_EVENTS);
  });
});

describe('a system with no inbound surface cannot be listened to', () => {
  // The defect this guards: Sheets declares no trigger types, yet a listener on
  // it saved VALID and then stayed silent forever — indistinguishable, to the
  // author, from "wired up, nothing has happened yet". The downstream
  // event-type check can't catch it: an empty event surface reads the same as
  // one nobody has introspected, so it stays (correctly) lenient.
  const SHEETS_SOURCE = `import { sheets } from adapters
import { sheet_cred } from credentials

sh = sheets(credentials: \`sheet_cred\`)
movement on_row(rec: <sh-[:record]->>) {
  x = 1
}

listen to sh {} fire on_row
`;

  it('rejects the listen, naming the system and what to do instead', async () => {
    const result = await saveMovement({ teamId: TEAM, source: SHEETS_SOURCE });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The user-facing surface: one error, naming the instance, in the author's
    // own terms — no adapter/manifest/trigger jargon.
    const message = (result.errors ?? []).join('\n');
    expect(message).toContain("'sh'");
    expect(message).toMatch(/can't start an automation/);
    expect(message).not.toMatch(/adapter|manifest|supportedTriggers|eventPosition/);
  });

  it('leaves a listen on a system that CAN fire alone', async () => {
    const result = await saveMovement({ teamId: TEAM, source: ATTIO_SOURCE('"record.created"') });
    expect(result.ok).toBe(true);
  });
});

describe('manifest ↔ event-node vocabulary pin', () => {
  // ONE namespace, and it is the platform's: a listen's `events:` selection and
  // the event node's own `action` axis are the same values, and the deleted
  // spelling is the one the checker keys the dropped-record-edge behaviour on.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = jest.requireActual('../../adapters/knowledge_graph') as {
    KG_MANIFEST: { subscribableEvents?: readonly string[] };
    KG_SUBSCRIBABLE_EVENTS: readonly string[];
    KG_EVENT_TYPE_NAME: string;
    KnowledgeGraphAdapter: new (teamId: string) => {
      describe(typeRef: string): Promise<{
        fields: Array<{ displayName: string; enumValues?: readonly string[] }>;
      } | null>;
    };
  };

  it("the manifest's subscribable events are the event node's own `action` enum", async () => {
    const adapter = new real.KnowledgeGraphAdapter('team-pin');
    const descriptor = await adapter.describe(real.KG_EVENT_TYPE_NAME);
    const action = descriptor?.fields.find((f) => f.displayName === 'action');
    expect(action?.enumValues).toEqual([...real.KG_SUBSCRIBABLE_EVENTS]);
    expect(real.KG_MANIFEST.subscribableEvents).toEqual([...real.KG_SUBSCRIBABLE_EVENTS]);
  });

  it('the deleted spelling is the one the checker drops live-record edges on', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RECORD_DELETED_ACTION } = require('movement-lang');
    expect(real.KG_SUBSCRIBABLE_EVENTS).toContain(RECORD_DELETED_ACTION);
  });
});
