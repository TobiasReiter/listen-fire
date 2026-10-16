// Engine coverage for a write handle's `-[:@old]->` — the record as it stood
// before that write — and for a position write updating the handle it was
// written through (language version 4).
//
// What is worth pinning: a create has no `@old`; a write that found a record
// snapshots it (a distinct position, even when nothing changed); a rehearsed
// write's `@old` is the handle itself; and `write org { … }` moves `org` on to
// the new record while its `@old` chain keeps the old one — visible from an
// `if` arm, through a second name, and per write inside a MAP.
//
// Harness mirrors match.unit.test.ts; the fake CRM here reads its records back
// (`readRecord`) and records its updates, which is what a snapshot is made of.
// Every case runs on both engines (`run`), the Rust engine running it whole,
// and the CRM sees the same calls from each.

// ── Jest module workarounds (mirrors run.unit.test.ts) ──────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('movement-engine/services/knowledge_pipeline/output_v3/schemas');

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??=
  'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.SCRAPER_API_KEY ??= 'unit-test-unused';

function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_target: object, prop: string | symbol): unknown {
      if (prop === 'execute') return async () => [];
      if (prop === 'executeTakeFirst') return async () => null;
      if (prop === 'then') return undefined;
      return () => mockChainable();
    },
  };
  return new Proxy({}, handler);
}
jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockChainable()),
  getAutomationsQb: jest.fn(() => mockChainable()),
  getQb: jest.fn(() => mockChainable()),
  getCoreQb: jest.fn(() => mockChainable()),
}));

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../context', () => ({
  unsafeCurrentContext: () => undefined,
  currentContext: () => ({
    user: undefined,
    runAsync: async <T>(fn: () => Promise<T>) => fn(),
  }),
}));

jest.mock('../../translation_graph/adapters/knowledge_graph', () => ({
  KG_ADAPTER_TYPE: 'kg',
  KG_MANIFEST: {
    adapterType: 'kg',
    displayName: 'Knowledge Graph',
    supportedTriggers: ['mutation'],
    methods: [
      'listEntryPoints', 'describe', 'resolveEntity', 'getDedupRules',
      'getFieldValue', 'getRelated', 'createRecord', 'updateRecord',
      'getPriorMatch', 'recordLink',
    ],
    triggerKinds: ['KG_MUTATION'],
  },
  createKnowledgeGraphAdapter: jest.fn(() => ({ adapterType: 'kg' })),
}));

jest.mock('../../knowledge_pipeline/facts', () => ({
  extractFactsForResource: jest.fn(async () => []),
}));

jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

// The ONE judge — mocked at the LLM seam, so the real arbitration (the
// short-circuits, the exactness rule) still runs and only the decision is
// injected.
jest.mock('../../../lib/prompts/execute', () => ({
  execute: jest.fn(),
  parseJsonReply: jest.fn(),
  flattenMessages: jest.fn(),
}));

import { resumeMovement, runMovement, type ParkSink } from 'movement-engine/services/movement_engine/run';

import { fromCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { spelledFor } from 'movement-lang/checker/__test__/surface_spelling';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import {
  containerAssociation,
  type Adapter,
  type ExternalRecordRef,
  type RuntimeCapabilities,
} from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { makeStablePosition, positionData } from 'movement-engine/services/translation_graph/types';
import { tenantIdOf } from 'engine-contracts';
import { makeFakeParkSink, makeTestHost } from 'movement-engine/services/movement_engine/test_host';
import type { ParkedScopeState } from 'movement-engine/services/movement_engine/serialize';
import { resetRustRunStats, rustRunStats } from 'movement-engine/services/movement_engine/rust_stats';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000022');

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

interface RecordedWrite {
  recordType: string;
  fields: Record<string, unknown>;
}

interface RecordedUpdate {
  externalId: string;
  fields: Record<string, unknown>;
}

/**
 * A CRM holding `companies`. `resolveEntity` finds a company by the asserted
 * name (or, `findsAlways`, by its own rule whatever was asserted — an adapter
 * that decides identity itself); `readRecord` reads a company back as it now
 * stands, updates included.
 */
function makeCrm(
  companies: ExternalRecordRef[],
  options: { findsAlways?: boolean } = {},
): { adapter: Adapter; creates: RecordedWrite[]; updates: RecordedUpdate[] } {
  const creates: RecordedWrite[] = [];
  const updates: RecordedUpdate[] = [];
  const stored = new Map(companies.map((c) => [c.externalId, { ...c.data }]));
  const adapter: Adapter = {
    adapterType: 'attio',
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity({ recordType, record }) {
      if (recordType !== 'company') return { candidates: [] };
      const found = options.findsAlways
        ? companies
        : companies.filter((c) => c.data.name === record.name);
      return { candidates: found.map((c) => ({ ...c, data: { ...c.data } })) };
    },
    async readRecord({ externalId }) {
      const data = stored.get(externalId);
      return data === undefined ? null : { ...data };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated({ fieldId }) {
      if (fieldId !== 'companies') return [];
      return companies.map((c) => ({
        position: makeStablePosition({
          adapterType: 'attio',
          recordType: 'company',
          recordId: c.externalId,
          data: { ...stored.get(c.externalId) },
        }),
      }));
    },
    async createRecord(input) {
      creates.push({ recordType: input.recordType, fields: input.fields });
      return { adapterType: 'attio', externalId: `ext-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      updates.push({ externalId: input.externalId, fields: input.fields });
      const current = stored.get(input.externalId);
      if (current !== undefined) Object.assign(current, input.fields);
      return {
        adapterType: 'attio',
        externalId: input.externalId,
        data: {},
        association: containerAssociation(input),
      };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates, updates };
}

function makeInbox(): Adapter {
  return makeCrm([]).adapter;
}

const crmSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text', domain: 'text' }, edges: {} },
    note: { properties: { title: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: {
      fields: { name: 'text', domain: 'text' },
      resultShape: { externalId: 'text', name: 'text', domain: 'text' },
    },
    note: { fields: { title: 'text' }, resultShape: { externalId: 'text', title: 'text' } },
  },
  // `write org { … }` updates by id.
  supportsInPlaceUpdate: true,
};

const catalog = staticCatalogSnapshot({
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
  instanceSchemas: { attio: crmSchema },
});

const CREDENTIAL_IDS: Record<string, string> = {
  dealflow_inbox: 'cred-email-1',
  acme_main: 'cred-attio-1',
};

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  '',
  'inbox = email()',
  '',
].join('\n');

function webhookEvent(payload: Record<string, unknown>): TriggerEvent {
  return { pipelineInputId: 'pi-old-edge', adapterType: 'email', triggerType: 'webhook', payload };
}

type Crm = ReturnType<typeof makeCrm>;

/**
 * `body` against a fresh CRM, on the engine its pin runs on (version 4 and
 * earlier the TypeScript engine, 5 the Rust engine). Hands back the CRM.
 */
async function run(
  body: string[],
  crmOf: () => Crm,
  options: { languageVersion?: LanguageVersion; head?: string[] } = {},
): Promise<Crm> {
  const crm = crmOf();
  await runOn(body, crm.adapter, options);
  return crm;
}

function runOn(
  body: string[],
  crm: Adapter,
  options: { languageVersion?: LanguageVersion; head?: string[]; park?: ParkSink; resume?: ParkedScopeState } = {},
) {
  // Written once, in the spelling versions 1–4 read; a version 5 run reads it as the upgrade tool respells it.
  const source = spelledFor(
    options.languageVersion ?? 5,
    PRELUDE +
    [
      'movement intake(msg: <inbox-[:message]->>) {',
      '  crm = attio(credentials: acme_main)',
      ...(options.head ?? []),
      ...body,
      '}',
    ].join('\n'),
    fromCatalogSnapshot(catalog),
  );
  const input = {
    source,
    movementName: 'intake',
    ...(options.languageVersion !== undefined ? { languageVersion: options.languageVersion } : {}),
    event: webhookEvent({}),
    teamId: TEAM_ID,
    catalog,
    credentialIds: CREDENTIAL_IDS,
    host: makeTestHost({
      adapters: {
        resolve: ({ adapterType }: { adapterType: string }) => {
          if (adapterType === 'email') return makeInbox();
          if (adapterType === 'attio') return crm;
          throw new Error(`test: no fake adapter for '${adapterType}'`);
        },
      },
      ...(options.park !== undefined ? { park: { sink: options.park } } : {}),
    }),
  };
  return options.resume !== undefined ? resumeMovement({ ...input, state: options.resume }) : runMovement(input);
}

const ACME: ExternalRecordRef = {
  adapterType: 'attio',
  externalId: 'co-1',
  data: { name: 'Acme Incorporated', domain: 'old.example' },
};

const BETA: ExternalRecordRef = {
  adapterType: 'attio',
  externalId: 'co-2',
  data: { name: 'Beta Ltd', domain: 'beta-old.example' },
};

/** A note whose title is what the program says — the run's answer, as the
 *  CRM received it. */
const note = (expr: string) => `  write crm-[:notes]-> { title: ${expr} }`;

const notes = (crm: { creates: RecordedWrite[] }) =>
  crm.creates.filter((c) => c.recordType === 'note').map((c) => c.fields.title);

const WRITE_ACME = (domain: string) =>
  `  org = write crm-[:companies]-> { unique by (\`name\`), name: "Acme Incorporated", domain: "${domain}" }`;

describe('-[:@old]-> off a write handle', () => {
  it('the result\'s write record has no old member (version 4), though -[:@old]-> read it during the run', async () => {
    const body = [WRITE_ACME('new.example'), note('IF EXISTS(org-[:@old]->) THEN "matched" ELSE "created" END')];
    const crm = await run(body, () => makeCrm([ACME]), { languageVersion: 4 });
    expect(notes(crm)).toEqual(['matched']);
    const result = await runOn(body, makeCrm([ACME]).adapter, { languageVersion: 4 });
    expect(result.writes.length).toBeGreaterThan(0);
    for (const w of result.writes) expect(Object.hasOwn(w, 'old')).toBe(false);
  });

  it('a created record has no @old', async () => {
    const crm = await run(
      [
        '  org = write crm-[:companies]-> { unique by (`name`), name: "Newco", domain: "new.example" }',
        note('IF EXISTS(org-[:@old]->) THEN "matched" ELSE "created" END'),
      ],
      () => makeCrm([ACME]),
    );
    expect(notes(crm)).toEqual(['created']);
  });

  it('a matched record with a changed field: @old present, old domain differs, positions differ', async () => {
    const crm = await run(
      [
        WRITE_ACME('new.example'),
        '  was = FIRST(org-[:@old]->)',
        '  if was != null {',
        note('was.`domain`'),
        note('IF was.`domain` != org.`domain` THEN "changed" ELSE "same" END'),
        note('IF was == org THEN "same position" ELSE "distinct position" END'),
        '  }',
      ],
      () => makeCrm([ACME]),
    );
    expect(notes(crm)).toEqual(['old.example', 'changed', 'distinct position']);
    expect(crm.updates).toEqual([{ externalId: 'co-1', fields: { domain: 'new.example' } }]);
  });

  it('a matched no-op (?: declined): @old present, values equal, positions differ', async () => {
    const crm = await run(
      [
        '  org = write crm-[:companies]-> { unique by (`name`), name: "Acme Incorporated", domain ?: "x.example" }',
        '  was = FIRST(org-[:@old]->)',
        '  if was != null {',
        note('IF was.`domain` == org.`domain` THEN "same" ELSE "changed" END'),
        note('IF was == org THEN "same position" ELSE "distinct position" END'),
        '  }',
      ],
      () => makeCrm([ACME]),
    );
    expect(notes(crm)).toEqual(['same', 'distinct position']);
    expect(crm.updates).toEqual([]);
  });

  it('dry run on an existing record: @old is the same position, and nothing is updated', async () => {
    const crm = await run(
      [
        '  org = write rehearsed-[:companies]-> { unique by (`name`), name: "Acme Incorporated", domain: "new.example" }',
        note('IF FIRST(org-[:@old]->) == org THEN "rehearsed" ELSE "live" END'),
      ],
      () => makeCrm([ACME]),
      { head: ['  rehearsed = attio(credentials: acme_main, dry_run: true)'] },
    );
    expect(notes(crm)).toEqual(['rehearsed']);
    expect(crm.updates).toEqual([]);
  });

  it('a match the adapter made by its own rule (no unique by) still populates @old', async () => {
    const crm = await run(
      [
        '  org = write crm-[:companies]-> { name: "Acme Inc.", domain: "new.example" }',
        note('IF EXISTS(org-[:@old]->) THEN "matched" ELSE "created" END'),
      ],
      () => makeCrm([ACME], { findsAlways: true }),
    );
    expect(notes(crm)).toEqual(['matched']);
  });

  it('a block head over -[:@old]-> runs once on the record before the write, and not at all after a create', async () => {
    const crm = await run(
      [
        WRITE_ACME('new.example'),
        '  org-[w:@old]-> { ' + note('w.`domain`').trim() + ' }',
        '  fresh = write crm-[:companies]-> { unique by (`name`), name: "Newco", domain: "new.example" }',
        '  fresh-[w2:@old]-> { ' + note('"never"').trim() + ' }',
      ],
      () => makeCrm([ACME]),
    );
    expect(notes(crm)).toEqual(['old.example']);
  });

  it('a snapshot is per write: two MAP members each see their own @old', async () => {
    const crm = await run(
      [
        '  MAP(["Acme Incorporated", "Beta Ltd", "Newco"], (n) => {',
        '    o = write crm-[:companies]-> { unique by (`name`), name: n, domain: "new.example" }',
        '    w = FIRST(o-[:@old]->)',
        '    write crm-[:notes]-> { title: IF w == null THEN "created" ELSE w.`domain` END }',
        '  })',
      ],
      () => makeCrm([ACME, BETA]),
    );
    expect(notes(crm).sort()).toEqual(['beta-old.example', 'created', 'old.example']);
  });
});

describe('a chained write updates the handle in place (version 4)', () => {
  it('after write org { … } twice, org-[:@old]-> is the first handle and its @old is the original snapshot', async () => {
    const crm = await run(
      [
        WRITE_ACME('second.example'),
        '  write org { domain: "third.example" }',
        '  prev = FIRST(org-[:@old]->)',
        '  if prev != null {',
        note('prev.`domain`').replace('  write', '    write'),
        '    oldest = FIRST(prev-[:@old]->)',
        '    if oldest != null { ' + note('oldest.`domain`').trim() + ' }',
        '  }',
        note('org.`domain`'),
      ],
      () => makeCrm([ACME]),
    );
    expect(notes(crm)).toEqual(['second.example', 'old.example', 'third.example']);
  });

  it('under dry run an in-place write also meets itself at @old: nothing changed, so before is after', async () => {
    const crm = await run(
      [
        '  org = write rehearsed-[:companies]-> { unique by (`name`), name: "Acme Incorporated", domain: "second.example" }',
        '  write org { domain: "third.example" }',
        note('IF FIRST(org-[:@old]->) == org THEN "rehearsed" ELSE "live" END'),
      ],
      () => makeCrm([ACME]),
      { head: ['  rehearsed = attio(credentials: acme_main, dry_run: true)'] },
    );
    expect(notes(crm)).toEqual(['rehearsed']);
    expect(crm.updates).toEqual([]);
  });

  it('under version 3 write org { … } leaves org as the first handle (stale, as before)', async () => {
    const crm = await run(
      [WRITE_ACME('second.example'), '  write org { domain: "third.example" }', note('org.`domain`')],
      () => makeCrm([ACME]),
      { languageVersion: 3 },
    );
    expect(notes(crm)).toEqual(['second.example']);
  });

  it('x = write org { … } names the same record: x == org, and both read the new value', async () => {
    const crm = await run(
      [
        WRITE_ACME('second.example'),
        '  x = write org { domain: "third.example" }',
        note('IF x == org THEN "same" ELSE "distinct" END'),
        note('x.`domain`'),
        note('org.`domain`'),
      ],
      () => makeCrm([ACME]),
    );
    expect(notes(crm)).toEqual(['same', 'third.example', 'third.example']);
  });

  it('a write to org inside an if arm is visible to a read of org after the arm', async () => {
    const crm = await run(
      [
        WRITE_ACME('second.example'),
        '  if TRUE { write org { domain: "arm.example" } }',
        note('org.`domain`'),
      ],
      () => makeCrm([ACME]),
    );
    expect(notes(crm)).toEqual(['arm.example']);
  });

  it('a write through a traversal landing: the named handle reaches the landing as it stood', async () => {
    const crm = await run(
      [
        '  crm-[c:companies]-> {',
        '    x = write c { domain: "landed.example" }',
        '    was = FIRST(x-[:@old]->)',
        '    if was != null { ' + note('was.`domain`').trim() + ' }',
        '    ' + note('x.`domain`').trim(),
        '  }',
      ],
      () => makeCrm([ACME]),
    );
    expect(notes(crm)).toEqual(['old.example', 'landed.example']);
  });

  it('a write through a found record: the named handle reaches the record as found; the match is untouched', async () => {
    const crm = await run(
      [
        '  m = match crm-[:companies]-> { unique by (`name`), name: "Acme Incorporated" }',
        '  if m != null {',
        '    x = write m { domain: "m.example" }',
        '    was = FIRST(x-[:@old]->)',
        '    if was != null { ' + note('was.`domain`').trim() + ' }',
        '    ' + note('m.`domain`').trim(),
        '  }',
      ],
      () => makeCrm([ACME]),
    );
    expect(notes(crm)).toEqual(['old.example', 'old.example']);
  });
});

describe('a match miss inside a MAP member (version 4)', () => {
  it('binds absent for that member only; the other member runs', async () => {
    const crm = await run(
      [
        '  MAP(["Acme Incorporated", "Nope Ltd"], (n) => {',
        '    m = match crm-[:companies]-> { unique by (`name`), name: n }',
        '    write crm-[:notes]-> { title: IF m == null THEN "absent" ELSE m.`domain` END }',
        '  })',
      ],
      () => makeCrm([ACME]),
    );
    expect(notes(crm).sort()).toEqual(['absent', 'old.example']);
  });
});

// A write with no `unique by` still finds a record when the adapter matches
// by its own rule (or the target's native constraints): since version 4 its
// handle then reads the found record for the fields it did not send. Both
// engines keep the record the write found, whatever found it, so the Rust
// engine runs the program whole under either version.
describe('a handle on a record the adapter matched by its own rule', () => {
  const BODY = ['  org = write crm-[:companies]-> { name: "Acme Inc." }', note('org.`domain`')];

  async function on(languageVersion: LanguageVersion) {
    const crm = makeCrm([ACME], { findsAlways: true });
    await runOn(BODY, crm.adapter, { languageVersion });
    return notes(crm);
  }

  it('under version 4 reads the record as found', async () => {
    expect(await on(4)).toEqual(['old.example']);
  });

  it('under version 3 reads only what the write said', async () => {
    expect(await on(3)).toEqual([null]);
  });

  it('parks with the record as found and its @old, and resumes (version 5, on the Rust engine)', async () => {
    const parkedBody = [
      '  org = write crm-[:companies]-> { name: "Acme Inc." }',
      '  dry = write rehearsed-[:companies]-> { name: "Acme Inc." }',
      '  await sleep(1h)',
      note('org.`domain`'),
      note('IF EXISTS(org-[:@old]->) THEN "matched" ELSE "created" END'),
      note('COALESCE(FIRST(org-[:@old]->).`domain`, "none")'),
      note('IF FIRST(dry-[:@old]->) == dry THEN "rehearsed" ELSE "live" END'),
    ];
    const head = ['  rehearsed = attio(credentials: acme_main, dry_run: true)'];
    resetRustRunStats();
    const park = makeFakeParkSink();
    await runOn(parkedBody, makeCrm([ACME], { findsAlways: true }).adapter, { head, park: park.sink });
    expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {} });
    expect(park.timerParks).toHaveLength(1);
    const state = JSON.stringify(park.timerParks[0]?.state);
    // The handle's record as found, and `old` / `oldIsSelf`, key for key.
    expect(state).toContain('"foundData":{"name":"Acme Incorporated","domain":"old.example"}');
    expect(state).toContain('"snapshot":true');
    expect(state).toContain('"oldIsSelf":true');
    const crm = makeCrm([ACME], { findsAlways: true });
    await runOn(parkedBody, crm.adapter, { head, resume: JSON.parse(state) as ParkedScopeState });
    expect(rustRunStats).toMatchObject({ segments: 2, unsupported: {} });
    expect(notes(crm)).toEqual(['old.example', 'matched', 'old.example', 'rehearsed']);
  });
});
