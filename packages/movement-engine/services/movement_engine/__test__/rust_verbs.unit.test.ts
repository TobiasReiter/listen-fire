// The record verbs in the Rust engine (chunk 5B task 5) — match, link,
// unlink, delete, a target's WHERE, and writes off a traversed record — each
// program run against fresh fakes, and everything a caller can see — the
// result or the error, the trace, the resolver's requests, the judge's
// questions, a rehearsal's captured writes, and every call the adapters
// received, in order and key for key — held to the recorded snapshot.

import {
  CURRENT_LANGUAGE_VERSION,
  fromCatalogSnapshot,
  mockCatalogSnapshot,
  type InstanceSchema,
} from 'movement-lang';
import { spelledFor } from 'movement-lang/checker/__test__/surface_spelling';

import { tenantIdOf } from 'engine-contracts';

import type {
  Adapter,
  ExternalRecordRef,
} from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import {
  META_RECORD_TYPE,
  makeStablePosition,
  positionData,
  positionRecordId,
} from '../../translation_graph/types';
import {
  runFailureCause,
  runMovement,
  type MovementRunResult,
} from '../run';
import {
  resetRustRunStats,
  rustRunStats,
} from '../rust_stats';
import {
  credentialIdsFor,
  makeTestHost,
  recordingWriteLocks,
  type TestHostOverrides,
} from '../test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000c5');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

// The system deletes a record of any of its types, and says so as a describe
// would (`deletable`, which version 5 checks a `delete` against).
const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text', region: 'text', summary: 'text' },
      edges: { notes: { target: 'note', writable: true }, portfolio: { target: 'fund' } },
      deletable: true,
    },
    person: {
      properties: { name: 'text', email: 'text' },
      edges: { company: { target: 'company' } },
      deletable: true,
    },
    fund: { properties: { name: 'text', vintage: 'text' }, edges: {}, deletable: true },
    note: { properties: { body: 'text' }, edges: {}, deletable: true },
  },
  collections: {
    companies: { target: 'company' },
    people: { target: 'person' },
    funds: { target: 'fund' },
    notes: { target: 'note' },
  },
  writableRoots: {
    company: {
      fields: { name: 'text', region: 'text', summary: 'text' },
      resultShape: { externalId: 'text', name: 'text', region: 'text', summary: 'text' },
      fuzzyResolution: true,
    },
    person: {
      fields: { name: 'text', email: 'text' },
      resultShape: { externalId: 'text', name: 'text', email: 'text' },
    },
    fund: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
    note: { fields: { body: 'text' }, resultShape: { externalId: 'text', body: 'text' } },
  },
  supportsInPlaceUpdate: true,
};

const catalog = mockCatalogSnapshot({
  adapters: {
    email: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: emailSchema,
    },
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: crmSchema,
    },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  '',
].join('\n');

/** Two companies a fuzzy search cannot tell apart; the first is the US one. */
const QUIET: ExternalRecordRef = {
  adapterType: 'attio',
  externalId: 'co-quiet',
  data: { name: 'Example Labs', summary: 'quiet' },
};
const ACTIVE: ExternalRecordRef = {
  adapterType: 'attio',
  externalId: 'co-active',
  url: 'https://crm/co-active',
  data: { name: 'Example Labs Ltd', summary: 'active' },
};
const FULL: Record<string, Record<string, unknown>> = {
  'co-quiet': { region: 'US' },
  'co-active': { region: 'EU' },
  'fund-7': { vintage: '2024' },
};

interface Store {
  /** What resolveEntity answers, by the record type asked for. */
  candidates?: Record<string, ExternalRecordRef[]>;
  /** The records a `companies` walk lands on. */
  companies?: Array<{ id: string; fields: Record<string, unknown> }>;
  /** Mint numeric record ids, as some systems answer them. */
  numeric?: boolean;
  /** Which edge methods the adapter has. */
  verbs?: Array<'linkRecords' | 'unlinkRecords' | 'deleteRecord'>;
}

function fakeCrm(store: Store) {
  const calls: Array<[string, unknown]> = [];
  let minted = 0;
  const verbs = new Set(store.verbs ?? ['linkRecords', 'unlinkRecords', 'deleteRecord']);
  const companies = store.companies ?? [];
  const adapter: Adapter = {
    adapterType: 'attio',
    supportedTriggers: [],
    runtimeCapabilities: () => ({
      traversal: { incoming: false, edgeProperties: false },
      resources: false,
    }),
    listEntryPoints: async () => [],
    async describe(recordType) {
      calls.push(['describe', recordType]);
      return null;
    },
    async resolveEntity(input) {
      calls.push(['resolveEntity', input]);
      return { candidates: store.candidates?.[input.recordType] ?? [] };
    },
    async readRecord(input) {
      calls.push(['readRecord', input]);
      return FULL[input.externalId] ?? null;
    },
    async getFieldValue(input) {
      calls.push(['getFieldValue', input]);
      const id = positionRecordId(input.position);
      const row = companies.find((c) => c.id === id);
      if (row !== undefined) return row.fields[input.fieldId] ?? null;
      return (
        (positionData(input.position) as Record<string, unknown> | undefined)?.[input.fieldId] ??
        null
      );
    },
    async getRelated(read) {
      calls.push(['getRelated', read]);
      if (read.position.recordType !== META_RECORD_TYPE || read.fieldId !== 'companies') return [];
      return companies.map((c) => ({
        position: makeStablePosition({
          adapterType: 'attio',
          recordType: 'company',
          recordId: c.id,
        }),
      }));
    },
    async createRecord(input) {
      calls.push(['createRecord', input]);
      minted += 1;
      // A numeric id crosses as the number the adapter answered.
      const externalId =
        store.numeric === true ? ((100 + minted) as unknown as string) : `attio-${minted}`;
      return { adapterType: 'attio', externalId, data: {} };
    },
    async updateRecord(input) {
      calls.push(['updateRecord', input]);
      return {
        adapterType: 'attio',
        externalId: input.externalId,
        data: {},
        association: containerAssociation(input),
      };
    },
    async deleteRecord(input) {
      calls.push(['deleteRecord', input]);
      return {};
    },
    ...(verbs.has('linkRecords')
      ? {
          async linkRecords(input: Parameters<NonNullable<Adapter['linkRecords']>>[0]) {
            calls.push(['linkRecords', input]);
            return { created: true };
          },
        }
      : {}),
    ...(verbs.has('unlinkRecords')
      ? {
          async unlinkRecords(input: Parameters<NonNullable<Adapter['unlinkRecords']>>[0]) {
            calls.push(['unlinkRecords', input]);
            return { removed: false };
          },
        }
      : {}),
  };
  // An adapter without the capability, as the TypeScript engine's `typeof` check sees it.
  if (!verbs.has('deleteRecord')) delete (adapter as Partial<Adapter>).deleteRecord;
  return { adapter, calls };
}

function fakeEmail() {
  const adapter: Adapter = {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({
      traversal: { incoming: false, edgeProperties: false },
      resources: false,
    }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      return (
        (positionData(input.position) as Record<string, unknown> | undefined)?.[input.fieldId] ??
        null
      );
    },
    getRelated: async () => [],
    createRecord: async () => ({ adapterType: 'email', externalId: 'x', data: {} }),
    updateRecord: async (input) => ({
      adapterType: 'email',
      externalId: input.externalId,
      data: {},
      association: containerAssociation(input),
    }),
    deleteRecord: async () => ({}),
  };
  return { adapter };
}

type Judge = NonNullable<NonNullable<TestHostOverrides['llm']>['arbitrateEntities']>;

/** A judge that picks `index`, recording what it was asked. */
const picks =
  (index: number | null) =>
  (asked: unknown[]): Judge =>
  async (input) => {
    asked.push({
      asserted: input.asserted,
      candidates: input.candidates,
      recordType: input.recordType,
    });
    return { index, cost: [{ source: 'model:judge', microdollars: 3 }] };
  };

interface Case {
  body: string;
  crm?: Store;
  judge?: (asked: unknown[]) => Judge;
  dryRun?: boolean;
}

interface Outcome {
  failed: boolean;
  /** Every `locks.acquire`'s names, in order. */
  locks: string[][];
  result?: MovementRunResult;
  error?: unknown;
  crm: string;
  resolved: unknown[];
  trace: unknown[];
  captured: CapturedWrite[];
  asked: unknown[];
}

async function runOn(c: Case): Promise<Outcome> {
  const locks: string[][] = [];
  const crm = fakeCrm(c.crm ?? {});
  const email = fakeEmail();
  const resolved: unknown[] = [];
  const trace: unknown[] = [];
  const captured: CapturedWrite[] = [];
  const asked: unknown[] = [];
  const world = () => ({
    locks,
    crm: JSON.stringify(crm.calls),
    resolved,
    trace,
    captured,
    asked,
  });
  try {
    const result = await runMovement({
      source: spelledFor(
        CURRENT_LANGUAGE_VERSION,
        `${PRELUDE}movement m(msg: <inbox-[:message]->>) {\n${c.body}\n}`,
        fromCatalogSnapshot(catalog),
      ),
      event: {
        pipelineInputId: 'pi-rust-verbs',
        adapterType: 'email',
        triggerType: 'webhook',
        payload: { subject: 'Example Labs', text: 'EU' },
      } satisfies TriggerEvent,
      teamId: TEAM_ID,
      catalog,
      credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
      firedAt: '2026-05-01T09:00:00.000Z',
      ...(c.dryRun === true ? { dryRun: true } : {}),
      host: makeTestHost({
        locks: recordingWriteLocks(locks),
        ...(c.dryRun === true ? { writeSink: (w: CapturedWrite) => captured.push(w) } : {}),
        adapters: {
          resolve: (request) => {
            resolved.push(request);
            if (request.adapterType === 'email') return email.adapter;
            if (request.adapterType === 'attio') return crm.adapter;
            throw new Error(`test: no fake for ${request.adapterType}`);
          },
        },
        ...(c.judge !== undefined ? { llm: { arbitrateEntities: c.judge(asked) } } : {}),
        trace: trace as never[],
      }),
    });
    return { failed: false, result, ...world() };
  } catch (error) {
    return { failed: true, error, ...world() };
  }
}

/** A rehearsal mints random ids: each run's, in the order they appear, read
 *  as the same placeholders. */
function sameIds<T>(value: T): T {
  const ids = new Map<string, string>();
  const normal = JSON.stringify(value).replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    (id) => {
      if (!ids.has(id)) ids.set(id, `uuid-${ids.size + 1}`);
      return ids.get(id)!;
    },
  );
  return JSON.parse(normal) as T;
}

/** One run on the Rust engine: run whole, and what
 *  the hosts saw and what the run handed back (or how it failed) held to the
 *  recorded snapshot, read for correctness when it was recorded. */
async function onRust(c: Case) {
  resetRustRunStats();
  const rust = await runOn(c);
  expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {}, shimFaults: 0 });
  const world = ({ failed: _failed, result: _result, error: _error, ...rest }: Outcome) => rest;
  expect(
    sameIds({
      world: world(rust),
      failed: rust.failed ? String(rust.error) : false,
      result: rust.result,
    }),
  ).toMatchSnapshot();
  return { rust };
}

const calls = (o: Outcome) => JSON.parse(o.crm) as Array<[string, Record<string, unknown>]>;
const methods = (o: Outcome) => calls(o).map(([m]) => m);
const TWO = { candidates: { company: [QUIET, ACTIVE] } };
const NOTE_OF = (name: string) =>
  `  write crm-[:notes]-> { body: "${'${'}${name}.\`summary\`} ${'${'}${name}.\`region\`}" }`;

describe('match in the Rust engine', () => {
  it('finds through the judge, reads the record whole, and binds it', async () => {
    const { rust } = await onRust({
      // Neither candidate's name is the asserted one exactly: the rules
      // cannot decide, and the judge is asked.
      body: [
        '  co = match crm-[:companies]-> { unique by (FUZZY `name`), name: "Example" }',
        NOTE_OF('co'),
      ].join('\n'),
      crm: TWO,
      judge: picks(1),
    });
    expect(rust.result?.writes[0]).toMatchObject({
      kind: 'match',
      externalId: 'co-active',
      resultData: { url: 'https://crm/co-active', region: 'EU' },
    });
    expect(rust.asked).toHaveLength(1);
  });

  it('binds absent on a miss, and the block carries on', async () => {
    const { rust } = await onRust({
      body: [
        '  write crm-[:notes]-> { body: "first" }',
        '  co = match crm-[:companies]-> { unique by (`name`), name: "Nowhere" }',
        '  write crm-[:notes]-> { body: IF co == null THEN "absent" ELSE co.`summary` END }',
      ].join('\n'),
    });
    expect(rust.failed).toBe(false);
    expect(rust.result?.writes.map((w) => w.writtenValues.body)).toEqual(['first', 'absent']);
  });

  it('narrows the shortlist by the target’s WHERE before the judge — an aliased field and a bare one', async () => {
    const forms = [{ where: 'c:companies WHERE c.`region` == msg.`text`' }];
    for (const { where } of forms) {
      const { rust } = await onRust({
        body: [
          `  co = match crm-[${where}]-> { unique by (FUZZY \`name\`), name: msg.\`subject\` }`,
          NOTE_OF('co'),
        ].join('\n'),
        crm: TWO,
        judge: picks(0),
      });
      expect(rust.result?.writes[0]).toMatchObject({ kind: 'match', externalId: 'co-active' });
      // Each candidate was read whole, then through the graph as a source.
      expect(methods(rust).slice(0, 4)).toEqual([
        'describe',
        'resolveEntity',
        'readRecord',
        'getFieldValue',
      ]);
    }
  });

  it('skips the iteration whose match misses, and runs the next', async () => {
    const { rust } = await onRust({
      body: [
        '  crm-[c:companies]-> {',
        '    found = match crm-[:funds]-> { unique by (`name`), name: c.`name` }',
        '    write crm-[:notes]-> { body: "${c.`name`} -> ${found.`vintage`}" }',
        '  }',
      ].join('\n'),
      crm: {
        companies: [
          { id: 'n-1', fields: { name: 'Fund III' } },
          { id: 'n-2', fields: { name: 'Nowhere' } },
        ],
        candidates: {
          fund: [{ adapterType: 'attio', externalId: 'fund-7', data: { name: 'Fund III' } }],
        },
      },
    });
    expect(rust.result?.writes.map((w) => w.kind ?? w.outcome)).toEqual([
      'match',
      'create',
      'match',
      'create',
    ]);
  });
});

describe('a write whose target carries a WHERE', () => {
  it('updates the candidate that passes it, and creates when none does', async () => {
    const write = (region: string) =>
      `  write crm-[c:companies WHERE c.\`region\` == "${region}"]-> { unique by (FUZZY \`name\`), name: msg.\`subject\`, summary: "seen" }`;
    const updated = await onRust({ body: write('EU'), crm: TWO, judge: picks(0) });
    expect(updated.rust.result?.writes[0]).toMatchObject({
      outcome: 'update',
      externalId: 'co-active',
    });
    const created = await onRust({ body: write('APAC'), crm: TWO, judge: picks(0) });
    expect(created.rust.result?.writes[0]).toMatchObject({ outcome: 'create' });
    expect(created.rust.asked).toEqual([]);
  });
});

describe('link and unlink in the Rust engine', () => {
  const TWO_ROOTS = [
    '  p = write crm-[:people]-> { unique by (`email`), name: msg.`subject`, email: msg.`text` }',
    '  co = write crm-[:companies]-> { unique by (`name`), name: msg.`subject` }',
  ];

  it('links and unlinks two written records, each with both endpoints’ provenance', async () => {
    const { rust } = await onRust({
      body: [...TWO_ROOTS, '  link p -[:company]-> co', '  unlink p -[:company]-> co'].join('\n'),
    });
    expect(rust.result?.writes.slice(2).map((w) => [w.kind, w.created])).toEqual([
      ['link', true],
      ['unlink', false],
    ]);
  });

  it('rehearses a link and an unlink', async () => {
    const { rust } = await onRust({
      body: [...TWO_ROOTS, '  link p -[:company]-> co', '  unlink p -[:company]-> co'].join('\n'),
      dryRun: true,
    });
    expect(rust.captured.map((w) => w.kind)).toContain('link');
  });

  it('fails a link the adapter cannot make, and an edge the from side does not declare, with the TypeScript engine’s errors', async () => {
    const missing = await onRust({
      body: [...TWO_ROOTS, '  link p -[:company]-> co'].join('\n'),
      crm: { verbs: ['deleteRecord'] },
    });
    expect(String(runFailureCause(missing.rust.error))).toContain(
      'cannot link two existing records (no linkRecords capability)',
    );
    const undeclared = await onRust({
      body: [...TWO_ROOTS, '  link co -[:company]-> p'].join('\n'),
    });
    expect(String(runFailureCause(undeclared.rust.error))).toContain(
      "'company' is not a declared edge of company",
    );
  });
});

describe('writes and deletes off a traversed record', () => {
  const COMPANIES = {
    companies: [
      { id: 'n-1', fields: { name: 'Acme' } },
      { id: 'n-2', fields: { name: 'Globex' } },
    ],
  };

  it('writes off it, updates it in place and deletes it, each through the graph’s target adapter', async () => {
    const { rust } = await onRust({
      body: [
        '  crm-[c:companies]-> {',
        '    write c-[:notes]-> { body: c.`name` }',
        '    write c { summary: "seen" }',
        '    delete c',
        '  }',
      ].join('\n'),
      crm: COMPANIES,
    });
    expect(rust.result?.writes.map((w) => w.kind ?? w.outcome)).toEqual([
      'create',
      'update',
      'delete',
      'create',
      'update',
      'delete',
    ]);
    expect(rust.result?.writes[0]).toMatchObject({
      parents: [{ recordType: 'company', externalId: 'n-1', edgeName: 'notes' }],
    });
  });

  it('deletes a written handle, its provenance chaining to the write, and rehearses it', async () => {
    const body = [
      '  stale = write crm-[:companies]-> { unique by (`name`), name: msg.`subject` }',
      '  delete stale',
    ].join('\n');
    const live = await onRust({ body });
    expect(live.rust.result?.writes[1]).toMatchObject({
      kind: 'delete',
      provenance: { record: [{ kind: 'write', write: 0 }] },
    });
    await onRust({ body, dryRun: true });
    const refused = await onRust({ body, crm: { verbs: [] } });
    expect(String(runFailureCause(refused.rust.error))).toContain(
      'cannot delete records (no deleteRecord capability)',
    );
  });

  describe('lock names', () => {
    // effect_locks.ts `part` is JSON.stringify of the id as the adapter
    // answered it: a numeric id locks as `42`, not `"42"`, on both engines.
    const flat = (o: Outcome) => o.locks.flat();

    it('an update by a numeric id locks the record by the number', async () => {
      const numeric = {
        adapterType: 'attio',
        externalId: 7 as unknown as string,
        data: { name: 'Example Labs' },
      };
      const { rust } = await onRust({
        body: '  write crm-[:companies]-> { unique by (`name`), name: msg.`subject`, summary: "seen" }',
        crm: { candidates: { company: [numeric] } },
      });
      expect(flat(rust)).toContain('record "attio" 7');
    });

    it('a delete, a link and an unlink of numeric ids lock by the numbers', async () => {
      const { rust } = await onRust({
        body: [
          '  p = write crm-[:people]-> { name: msg.`subject`, email: msg.`text` }',
          '  co = write crm-[:companies]-> { name: msg.`subject` }',
          '  link p -[:company]-> co',
          '  unlink p -[:company]-> co',
          '  delete co',
        ].join('\n'),
        crm: { numeric: true },
      });
      expect(flat(rust)).toEqual([
        'edge "attio" 101 "company" 102',
        'edge "attio" 101 "company" 102',
        'record "attio" 102',
      ]);
    });
  });
});
