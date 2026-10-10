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

// ── Jest module workarounds (mirrors run.unit.test.ts) ──────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../knowledge_pipeline/output_v3/schemas');

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

jest.mock('../../logger', () => ({
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

import { runMovement } from '../run';

import type { InstanceSchema, LanguageVersion } from 'movement-lang';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import {
  containerAssociation,
  type Adapter,
  type ExternalRecordRef,
  type RuntimeCapabilities,
} from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { makeStablePosition, positionData } from '../../translation_graph/types';
import { tenantIdOf } from 'engine-contracts';
import { makeTestHost } from '../test_host';
import { resetRustRunStats, rustRunStats } from '../rust_stats';

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

function run(
  body: string[],
  crm: Adapter,
  options: { languageVersion?: LanguageVersion; head?: string[] } = {},
) {
  const source =
    PRELUDE +
    [
      'movement intake(msg: <inbox-[:message]->>) {',
      '  crm = attio(credentials: acme_main)',
      ...(options.head ?? []),
      ...body,
      '}',
    ].join('\n');
  return runMovement({
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
    }),
  });
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
  it('a created record has no @old', async () => {
    const crm = makeCrm([ACME]);
    await run(
      [
        '  org = write crm-[:companies]-> { unique by (`name`), name: "Newco", domain: "new.example" }',
        note('IF EXISTS(org-[:@old]->) THEN "matched" ELSE "created" END'),
      ],
      crm.adapter,
    );
    expect(notes(crm)).toEqual(['created']);
  });

  it('a matched record with a changed field: @old present, old domain differs, positions differ', async () => {
    const crm = makeCrm([ACME]);
    await run(
      [
        WRITE_ACME('new.example'),
        '  was = FIRST(org-[:@old]->)',
        '  if was != null {',
        note('was.`domain`'),
        note('IF was.`domain` != org.`domain` THEN "changed" ELSE "same" END'),
        note('IF was == org THEN "same position" ELSE "distinct position" END'),
        '  }',
      ],
      crm.adapter,
    );
    expect(notes(crm)).toEqual(['old.example', 'changed', 'distinct position']);
    expect(crm.updates).toEqual([{ externalId: 'co-1', fields: { domain: 'new.example' } }]);
  });

  it('a matched no-op (?: declined): @old present, values equal, positions differ', async () => {
    const crm = makeCrm([ACME]);
    await run(
      [
        '  org = write crm-[:companies]-> { unique by (`name`), name: "Acme Incorporated", domain ?: "x.example" }',
        '  was = FIRST(org-[:@old]->)',
        '  if was != null {',
        note('IF was.`domain` == org.`domain` THEN "same" ELSE "changed" END'),
        note('IF was == org THEN "same position" ELSE "distinct position" END'),
        '  }',
      ],
      crm.adapter,
    );
    expect(notes(crm)).toEqual(['same', 'distinct position']);
    expect(crm.updates).toEqual([]);
  });

  it('dry run on an existing record: @old is the same position, and nothing is updated', async () => {
    const crm = makeCrm([ACME]);
    await run(
      [
        '  org = write rehearsed-[:companies]-> { unique by (`name`), name: "Acme Incorporated", domain: "new.example" }',
        note('IF FIRST(org-[:@old]->) == org THEN "rehearsed" ELSE "live" END'),
      ],
      crm.adapter,
      { head: ['  rehearsed = attio(credentials: acme_main, dry_run: true)'] },
    );
    expect(notes(crm)).toEqual(['rehearsed']);
    expect(crm.updates).toEqual([]);
  });

  it('a match the adapter made by its own rule (no unique by) still populates @old', async () => {
    const crm = makeCrm([ACME], { findsAlways: true });
    await run(
      [
        '  org = write crm-[:companies]-> { name: "Acme Inc.", domain: "new.example" }',
        note('IF EXISTS(org-[:@old]->) THEN "matched" ELSE "created" END'),
      ],
      crm.adapter,
    );
    expect(notes(crm)).toEqual(['matched']);
  });

  it('a block head over -[:@old]-> runs once on the record before the write, and not at all after a create', async () => {
    const crm = makeCrm([ACME]);
    await run(
      [
        WRITE_ACME('new.example'),
        '  org-[w:@old]-> { ' + note('w.`domain`').trim() + ' }',
        '  fresh = write crm-[:companies]-> { unique by (`name`), name: "Newco", domain: "new.example" }',
        '  fresh-[w2:@old]-> { ' + note('"never"').trim() + ' }',
      ],
      crm.adapter,
    );
    expect(notes(crm)).toEqual(['old.example']);
  });

  it('a snapshot is per write: two MAP members each see their own @old', async () => {
    const crm = makeCrm([ACME, BETA]);
    await run(
      [
        '  MAP(["Acme Incorporated", "Beta Ltd", "Newco"], (n) => {',
        '    o = write crm-[:companies]-> { unique by (`name`), name: n, domain: "new.example" }',
        '    w = FIRST(o-[:@old]->)',
        '    write crm-[:notes]-> { title: IF w == null THEN "created" ELSE w.`domain` END }',
        '  })',
      ],
      crm.adapter,
    );
    expect(notes(crm).sort()).toEqual(['beta-old.example', 'created', 'old.example']);
  });
});

describe('a chained write updates the handle in place (version 4)', () => {
  it('after write org { … } twice, org-[:@old]-> is the first handle and its @old is the original snapshot', async () => {
    const crm = makeCrm([ACME]);
    await run(
      [
        WRITE_ACME('second.example'),
        '  write org { domain: "third.example" }',
        '  prev = FIRST(org-[:@old]->)',
        '  if prev != null {',
        note('prev.`domain`').replace('  write', '    write'),
        '    first = FIRST(prev-[:@old]->)',
        '    if first != null { ' + note('first.`domain`').trim() + ' }',
        '  }',
        note('org.`domain`'),
      ],
      crm.adapter,
    );
    expect(notes(crm)).toEqual(['second.example', 'old.example', 'third.example']);
  });

  it('under dry run an in-place write also meets itself at @old: nothing changed, so before is after', async () => {
    const crm = makeCrm([ACME]);
    await run(
      [
        '  org = write rehearsed-[:companies]-> { unique by (`name`), name: "Acme Incorporated", domain: "second.example" }',
        '  write org { domain: "third.example" }',
        note('IF FIRST(org-[:@old]->) == org THEN "rehearsed" ELSE "live" END'),
      ],
      crm.adapter,
      { head: ['  rehearsed = attio(credentials: acme_main, dry_run: true)'] },
    );
    expect(notes(crm)).toEqual(['rehearsed']);
    expect(crm.updates).toEqual([]);
  });

  it('under version 3 write org { … } leaves org as the first handle (stale, as before)', async () => {
    const crm = makeCrm([ACME]);
    await run(
      [WRITE_ACME('second.example'), '  write org { domain: "third.example" }', note('org.`domain`')],
      crm.adapter,
      { languageVersion: 3 },
    );
    expect(notes(crm)).toEqual(['second.example']);
  });

  it('x = write org { … } names the same record: x == org, and both read the new value', async () => {
    const crm = makeCrm([ACME]);
    await run(
      [
        WRITE_ACME('second.example'),
        '  x = write org { domain: "third.example" }',
        note('IF x == org THEN "same" ELSE "distinct" END'),
        note('x.`domain`'),
        note('org.`domain`'),
      ],
      crm.adapter,
    );
    expect(notes(crm)).toEqual(['same', 'third.example', 'third.example']);
  });

  it('a write to org inside an if arm is visible to a read of org after the arm', async () => {
    const crm = makeCrm([ACME]);
    await run(
      [
        WRITE_ACME('second.example'),
        '  if TRUE { write org { domain: "arm.example" } }',
        note('org.`domain`'),
      ],
      crm.adapter,
    );
    expect(notes(crm)).toEqual(['arm.example']);
  });

  it('a write through a traversal landing: the named handle reaches the landing as it stood', async () => {
    const crm = makeCrm([ACME]);
    await run(
      [
        '  crm-[c:companies]-> {',
        '    x = write c { domain: "landed.example" }',
        '    was = FIRST(x-[:@old]->)',
        '    if was != null { ' + note('was.`domain`').trim() + ' }',
        '    ' + note('x.`domain`').trim(),
        '  }',
      ],
      crm.adapter,
    );
    expect(notes(crm)).toEqual(['old.example', 'landed.example']);
  });

  it('a write through a found record: the named handle reaches the record as found; the match is untouched', async () => {
    const crm = makeCrm([ACME]);
    await run(
      [
        '  m = match crm-[:companies]-> { unique by (`name`), name: "Acme Incorporated" }',
        '  if m != null {',
        '    x = write m { domain: "m.example" }',
        '    was = FIRST(x-[:@old]->)',
        '    if was != null { ' + note('was.`domain`').trim() + ' }',
        '    ' + note('m.`domain`').trim(),
        '  }',
      ],
      crm.adapter,
    );
    expect(notes(crm)).toEqual(['old.example', 'old.example']);
  });
});

describe('a match miss inside a MAP member (version 4)', () => {
  it('binds absent for that member only; the other member runs', async () => {
    const crm = makeCrm([ACME]);
    await run(
      [
        '  MAP(["Acme Incorporated", "Nope Ltd"], (n) => {',
        '    m = match crm-[:companies]-> { unique by (`name`), name: n }',
        '    write crm-[:notes]-> { title: IF m == null THEN "absent" ELSE m.`domain` END }',
        '  })',
      ],
      crm.adapter,
    );
    expect(notes(crm).sort()).toEqual(['absent', 'old.example']);
  });
});

// A write with no `unique by` still finds a record when the adapter matches
// by its own rule (or the target's native constraints): since version 4 its
// handle then reads the found record for the fields it did not send. The Rust
// engine runs versions 1 to 3, and admission cannot see an adapter's rule from
// the text, so a v4 write whose handle is held goes to the TypeScript engine.
describe('a handle on a record the adapter matched by its own rule, on both engines', () => {
  const BODY = ['  org = write crm-[:companies]-> { name: "Acme Inc." }', note('org.`domain`')];

  async function on(engine: 'ts' | 'rust', languageVersion: LanguageVersion) {
    const previous = process.env.MOVEMENT_ENGINE;
    process.env.MOVEMENT_ENGINE = engine;
    resetRustRunStats();
    try {
      const crm = makeCrm([ACME], { findsAlways: true });
      await run(BODY, crm.adapter, { languageVersion });
      return { notes: notes(crm), stats: JSON.parse(JSON.stringify(rustRunStats)) as typeof rustRunStats };
    } finally {
      if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
      else process.env.MOVEMENT_ENGINE = previous;
    }
  }

  it('under version 4 reads the record as found, and Rust leaves the run to TypeScript', async () => {
    const ts = await on('ts', 4);
    const rust = await on('rust', 4);
    expect(ts.notes).toEqual(['old.example']);
    expect(rust.notes).toEqual(ts.notes);
    expect(rust.stats).toMatchObject({ routed: 1, ranWhole: 0, notAdmitted: { v4_handle_read_as_found: 1 } });
    // The TypeScript engine's admission dry run does not count it as one Rust could start.
    expect(ts.stats.dryRun).toMatchObject({ admitted: 0, first: { v4_handle_read_as_found: 1 } });
  });

  it('under version 3 reads only what the write said, and runs whole on Rust', async () => {
    const ts = await on('ts', 3);
    const rust = await on('rust', 3);
    expect(ts.notes).toEqual([null]);
    expect(rust.notes).toEqual(ts.notes);
    expect(rust.stats).toMatchObject({ routed: 1, ranWhole: 1, notAdmitted: {} });
  });
});
