// The forms PLAN-08B Task 2 ported to the Rust engine: a match over a tuple
// of paths, an `IS` test of a graph literal, a graph spread of the event,
// `refresh`, and a closure called by name inside a library function. Each
// program runs on the Rust engine against fresh fakes, and the assertions
// say what a caller sees — the result or the error, the adapter calls, the
// judge's questions, and the parks. Where a form sits beside a park, the
// parked state resumes.

import { mockCatalogSnapshot, type CatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { PARK_STATE_VERSION, tenantIdOf } from 'engine-contracts';

import type { Adapter, ExternalRecordRef } from 'movement-engine/services/translation_graph/adapter';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { META_RECORD_TYPE, makeStablePosition, positionData, positionRecordId } from 'movement-engine/services/translation_graph/types';
import { credentialIdsFor, makeFakeParkSink, makeTestHost, type TestHostOverrides } from 'movement-engine/services/movement_engine/test_host';
import { resumeMovement, runFailureCause, runMovement, type RunMovementInput } from 'movement-engine/services/movement_engine/run';
import type { ParkedScopeState } from 'movement-engine/services/movement_engine/serialize';
import { resetRustRunStats, rustRunStats } from 'movement-engine/services/movement_engine/rust_stats';

jest.setTimeout(60_000);

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000008b2');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};
const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text', region: 'text', meta: 'json' },
      edges: { notes: { target: 'note', writable: true } },
    },
    person: { properties: { name: 'text' }, edges: { company: { target: 'company' }, notes: { target: 'note', writable: true } } },
    note: { properties: { body: 'text', region: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, people: { target: 'person' }, notes: { target: 'note' } },
  writableRoots: {
    company: { fields: { name: 'text', region: 'text' }, resultShape: { externalId: 'text', name: 'text', region: 'text' }, fuzzyResolution: true },
    person: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
    note: { fields: { body: 'text' }, resultShape: { externalId: 'text', body: 'text', region: 'text' }, fuzzyResolution: true },
  },
  supportsInPlaceUpdate: true,
};
const catalog: CatalogSnapshot = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  'inbox = connect email using dealflow_inbox',
  'crm = connect attio using acme_main',
  '',
].join('\n');

interface Row {
  id: string;
  fields: Record<string, unknown>;
}

interface Case {
  /** A movement body (`movement m(msg: …) { … }` around it), or `source`. */
  body?: string;
  /** The file after the prelude, whole. */
  source?: string;
  files?: Record<string, { source: string }>;
  /** What resolveEntity answers, by the record type asked for. */
  candidates?: Record<string, ExternalRecordRef[]>;
  /** What a collection walk lands on, by collection. */
  related?: Record<string, Row[]>;
  /** What readRecord answers, by external id. */
  read?: Record<string, Record<string, unknown>>;
  judge?: number | null;
  /** The CRM answers no `readRecord`. */
  noReadRecord?: boolean;
  resume?: ParkedScopeState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isParkedScopeState(value: unknown): value is ParkedScopeState {
  return isRecord(value) && value.version === PARK_STATE_VERSION && typeof value.address === 'string';
}

const COLLECTION_TYPE: Record<string, string> = { companies: 'company', people: 'person', notes: 'note' };

function fakeCrm(c: Case, received: unknown[], kept: unknown[] = []): Adapter {
  // What each call was handed, as it was handed (an adapter's data is data:
  // `kept` holds the very objects a create was given, read after the run).
  const calls = { push: (call: unknown) => received.push(structuredClone(call)) };
  let minted = 0;
  const rows = Object.values(c.related ?? {}).flat();
  const adapter: Adapter = {
    adapterType: 'attio',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    async describe(recordType) {
      calls.push(['describe', recordType]);
      return null;
    },
    async resolveEntity(input) {
      calls.push(['resolveEntity', input]);
      return { candidates: c.candidates?.[input.recordType] ?? [] };
    },
    async readRecord(input) {
      calls.push(['readRecord', input]);
      return c.read?.[input.externalId] ?? null;
    },
    async getFieldValue(input) {
      calls.push(['getFieldValue', input.fieldId]);
      // The position's inline data first (what `refresh` moves on), then
      // the row the walk landed on.
      const data = positionData(input.position);
      if (isRecord(data) && Object.hasOwn(data, input.fieldId)) return data[input.fieldId];
      const id = positionRecordId(input.position);
      const row = rows.find((r) => r.id === id);
      return row?.fields[input.fieldId] ?? null;
    },
    async getRelated(read) {
      calls.push(['getRelated', read.fieldId]);
      if (read.position.recordType !== META_RECORD_TYPE) return [];
      return (c.related?.[read.fieldId] ?? []).map((r) => ({
        position: makeStablePosition({ adapterType: 'attio', recordType: COLLECTION_TYPE[read.fieldId] ?? read.fieldId, recordId: r.id }),
      }));
    },
    async createRecord(input) {
      calls.push(['createRecord', input]);
      kept.push(input.fields);
      minted += 1;
      return { adapterType: 'attio', externalId: `attio-${minted}`, data: { minted } };
    },
    async updateRecord(input) {
      calls.push(['updateRecord', input]);
      return { adapterType: 'attio', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord(input) {
      calls.push(['deleteRecord', input]);
      return {};
    },
  };
  if (c.noReadRecord === true) delete (adapter as Partial<Adapter>).readRecord;
  return adapter;
}

function fakeEmail(): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      const data = positionData(input.position);
      return isRecord(data) ? (data[input.fieldId] ?? null) : null;
    },
    getRelated: async () => [],
    createRecord: async () => ({ adapterType: 'email', externalId: 'x', data: {} }),
    updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
  };
}

type Judge = NonNullable<NonNullable<TestHostOverrides['llm']>['arbitrateEntities']>;

async function runOn(c: Case) {
  const calls: unknown[] = [];
  const asked: unknown[] = [];
  const park = makeFakeParkSink();
  const snapshot = { ...catalog, files: c.files ?? {} };
  const kept: unknown[] = [];
  const crm = fakeCrm(c, calls, kept);
  const email = fakeEmail();
  const judge: Judge = async (input) => {
    asked.push({ asserted: input.asserted, candidates: input.candidates, recordType: input.recordType });
    return { index: c.judge ?? null, cost: [{ source: 'model:judge', microdollars: 3 }] };
  };
  const source = c.source ?? `function m(msg: <inbox-[:message]->>) {\n${c.body ?? ''}\n}`;
  const input: RunMovementInput = {
    source: PRELUDE + source,
    event: { pipelineInputId: 'pi-ported-forms', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme', text: 'EU' } },
    teamId: TEAM_ID,
    catalog: snapshot,
    credentialIds: credentialIdsFor(snapshot, (name: string) => `cred-${name}`),
    firedAt: '2026-05-01T09:00:00.000Z',
    movementName: 'm',
    host: makeTestHost({
      adapters: { resolve: (r) => (r.adapterType === 'attio' ? crm : email) },
      llm: { arbitrateEntities: judge },
      park: { sink: park.sink },
    }),
  };
  resetRustRunStats();
  let outcome: Record<string, unknown>;
  try {
    const result = c.resume !== undefined ? await resumeMovement({ ...input, state: c.resume }) : await runMovement(input);
    outcome = { result };
  } catch (error) {
    outcome = { error: String(error), cause: String(runFailureCause(error)) };
  }
  const stats = { segments: rustRunStats.segments, unsupported: { ...rustRunStats.unsupported }, shimFaults: rustRunStats.shimFaults };
  return { observed: normalised({ ...outcome, calls, asked, kept, parks: park.timerParks }), parks: park.timerParks, stats };
}

/** What a caller sees, ids named by first appearance. */
function normalised(value: unknown): string {
  const ids = new Map<string, string>();
  const text = JSON.stringify(value, (_key, x: unknown) => (x instanceof Map ? Object.fromEntries(x) : x)) ?? 'undefined';
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
    const known = ids.get(id);
    if (known !== undefined) return known;
    const name = `uuid-${ids.size + 1}`;
    ids.set(id, name);
    return name;
  });
}

/** One segment on the Rust engine: the engine ran it, refusing nothing. */
async function run(c: Case) {
  const ran = await runOn(c);
  expect(ran.stats).toEqual({ segments: 1, unsupported: {}, shimFaults: 0 });
  return ran;
}

/** Park, then resume the parked state: how the resumed segment ended. */
async function parkAndResume(c: Case): Promise<string> {
  const parked = await run(c);
  expect(parked.parks).toHaveLength(1);
  // As production stores it: parked state is jsonb, so object identity
  // does not survive the park.
  const state: unknown = JSON.parse(JSON.stringify(parked.parks[0]?.state));
  if (!isParkedScopeState(state)) throw new Error('the park writer left no parked scope state');
  return (await run({ ...c, resume: state })).observed;
}

const library = (body: string[]) => ({ 'lib/forms': { source: PRELUDE + body.join('\n') } });
const movement = (body: string[]) => ['function m(msg: <inbox-[:message]->>) {', ...body, '}'].join('\n');

// ── match over a tuple of paths ────────────────────────────────────────────

const NOTE: ExternalRecordRef = { adapterType: 'attio', externalId: 'note-1', data: { body: 'Acme' } };
const PARENTS = ['  co = write crm-[:companies]-> { name: "Acme" }', '  pe = write crm-[:people]-> { name: "Ada" }'];
const TUPLE_MATCH = '  found = match (co-[:notes]->, pe-[:notes]->) { unique by (`body`), body: msg.`subject` }';

describe('a match over a tuple of paths', () => {
  it('finds the record at the convergence of both paths', async () => {
    const rust = await run({
      body: [...PARENTS, TUPLE_MATCH, '  write crm-[:notes]-> { body: "${found.`body`} ${found.`region`}" }'].join('\n'),
      candidates: { note: [NOTE] },
      read: { 'note-1': { region: 'EU' } },
    });
    expect(rust.observed).toContain('"body":"Acme EU"');
  });

  it('binds absent on a miss', async () => {
    const body = [...PARENTS, TUPLE_MATCH, '  write crm-[:notes]-> { body: found == null ? "absent" : found.`body` }'].join('\n');
    const rust = await run({ body });
    expect(rust.observed).toContain('"body":"absent"');
  });

  it('asks the judge with every candidate, and binds the one it picks', async () => {
    const other: ExternalRecordRef = { adapterType: 'attio', externalId: 'note-2', data: { body: 'Acme Ltd' } };
    const rust = await run({
      body: [...PARENTS, '  found = match (co-[:notes]->, pe-[:notes]->) { unique by (FUZZY `body`), body: "Acm" }', '  write crm-[:notes]-> { body: coalesce(found.`body`, "none") }'].join('\n'),
      candidates: { note: [NOTE, other] },
      judge: 1,
    });
    expect(rust.observed).toContain('"body":"Acme Ltd"');
  });

  it('matches between two traversed records', async () => {
    const rust = await run({
      body: ['  crm-[c:companies]-> {', '    crm-[p:people]-> {', '      found = match (c-[:notes]->, p-[:notes]->) { unique by (`body`), body: c.`name` }', '      write crm-[:notes]-> { body: "${found.`body`}/${p.`name`}" }', '    }', '  }'].join('\n'),
      related: { companies: [{ id: 'c-1', fields: { name: 'Acme' } }], people: [{ id: 'p-1', fields: { name: 'Ada' } }] },
      candidates: { note: [NOTE] },
    });
    expect(rust.observed).toContain('"body":"Acme/Ada"');
  });

  it('runs inside a library function', async () => {
    const files = library([
      'export function find(n: <text>) {',
      ...PARENTS,
      '  found = match (co-[:notes]->, pe-[:notes]->) { unique by (`body`), body: n }',
      '  return coalesce(found.`body`, "none")',
      '}',
    ]);
    const source = ['import { find } from "lib/forms"', movement(['  b = find(msg.`subject`)', '  write crm-[:notes]-> { body: b }'])].join('\n');
    const rust = await run({ source, files, candidates: { note: [NOTE] } });
    expect(rust.observed).toContain('"body":"Acme"');
  });

  it('matches after a park', async () => {
    // Parked before the parents are written: a handle rehydrated from a
    // park lands in a graph of its own, so two of them fail
    // a tuple's one-graph rule (reported, not this port's to change).
    const body = ['  await sleep(1h)', ...PARENTS, TUPLE_MATCH, '  write crm-[:notes]-> { body: coalesce(found.`body`, "none") }'].join('\n');
    const resumed = await parkAndResume({ body, candidates: { note: [NOTE] } });
    expect(resumed).toContain('"body":"Acme"');
  });
});

// ── IS <Decl> of a graph literal holding a system's records ────────────────

const LEAD = ['node Lead {', '  name: <text>', '  node owner {', '    name: <text>', '  }', '}'].join('\n');
const TYPED_LEAD = ['node Lead {', '  name: <text>', '  node owner {', '    region: <number>', '  }', '}'].join('\n');
const VERDICT = ['  if (g is <Lead>) {', '    write crm-[:notes]-> { body: "fits" }', '  } else {', '    write crm-[:notes]-> { body: "does not" }', '  }'];

describe('IS <Decl> of a graph literal', () => {
  it('compares a written handle its edge holds by the handle’s record type', async () => {
    for (const [declaration, verdict] of [[LEAD, 'fits'], [TYPED_LEAD, 'does not']] as const) {
      const rust = await run({
        source: [declaration, movement(['  co = write crm-[:companies]-> { name: "Acme" }', '  g = graph { name: "a", owner: co }', ...VERDICT])].join('\n'),
      });
      expect(rust.observed).toContain(`"body":"${verdict}"`);
    }
  });

  it('compares a traversed record its edge holds, and fits where the edge holds nothing', async () => {
    const companies = { companies: [{ id: 'c-1', fields: { name: 'Acme' } }] };
    for (const [declaration, verdict] of [[LEAD, 'fits'], [TYPED_LEAD, 'does not']] as const) {
      const rust = await run({
        source: [declaration, movement(['  crm-[c:companies]-> {', '    g = graph { name: c.`name`, owner: c }', ...VERDICT.map((l) => `  ${l}`), '  }'])].join('\n'),
        related: companies,
      });
      expect(rust.observed).toContain(`"body":"${verdict}"`);
    }
    const rust = await run({ source: [TYPED_LEAD, movement(['  g = graph { name: "a" }', ...VERDICT])].join('\n') });
    expect(rust.observed).toContain('"body":"fits"');
  });

  it('compares a record nested two nodes down', async () => {
    const deep = (type: string) => ['node Lead {', '  name: <text>', '  node team {', '    node owner {', `      region: <${type}>`, '    }', '  }', '}'].join('\n');
    for (const [type, verdict] of [['text', 'fits'], ['number', 'does not']] as const) {
      const rust = await run({
        source: [deep(type), movement(['  co = write crm-[:companies]-> { name: "Acme" }', '  g = graph { name: "a", team: { owner: co } }', ...VERDICT])].join('\n'),
      });
      expect(rust.observed).toContain(`"body":"${verdict}"`);
    }
  });

  it('runs inside a library function', async () => {
    const files = library([
      TYPED_LEAD,
      'export function judge(n: <text>) {',
      '  co = write crm-[:companies]-> { name: n }',
      '  g = graph { name: n, owner: co }',
      '  if (g is <Lead>) {',
      '    return "fits"',
      '  }',
      '  return "does not"',
      '}',
    ]);
    const source = ['import { judge } from "lib/forms"', movement(['  v = judge(msg.`subject`)', '  write crm-[:notes]-> { body: coalesce(v, "none") }'])].join('\n');
    const rust = await run({ source, files });
    expect(rust.observed).toContain('"body":"does not"');
  });

  it('compares a handle the graph held across a park', async () => {
    const source = [TYPED_LEAD, movement(['  co = write crm-[:companies]-> { name: "Acme" }', '  g = graph { name: "a", owner: co }', '  await sleep(1h)', ...VERDICT])].join('\n');
    const resumed = await parkAndResume({ source });
    expect(resumed).toContain('"body":"does not"');
  });
});

// ── a graph spread of the event, and of a record's member ──────────────────

const S = ['node S {', '  a: <text | null>', '}'].join('\n');
const META = { companies: [{ id: 'c-1', fields: { name: 'Acme', meta: { a: 'x' } } }, { id: 'c-2', fields: { name: 'Beta' } }] };

describe('a graph spread of a record', () => {
  it('copies the event’s fields, as any record’s', async () => {
    const rust = await run({ body: ['  g = graph { ...msg, extra: 1 }', '  write crm-[:notes]-> { body: "${g.`subject`}/${g.`text`}/${g.`extra`}" }'].join('\n') });
    expect(rust.observed).toContain('"body":"Acme/EU/1"');
  });

  it('copies a map a record’s field holds, and nothing where the field is absent', async () => {
    const rust = await run({
      source: [S, movement(['  crm-[c:companies]-> {', '    g = graph<S> { ...c.`meta` }', '    write crm-[:notes]-> { body: coalesce(g.`a`, "none") }', '  }'])].join('\n'),
      related: META,
    });
    expect(rust.observed).toContain('"body":"x"');
    expect(rust.observed).toContain('"body":"none"');
  });

  it('copies a map a written handle’s field holds', async () => {
    const rust = await run({
      source: [S, movement(['  co = write crm-[:companies]-> { name: "Acme" }', '  g = graph<S> { ...co.`meta` }', '  write crm-[:notes]-> { body: coalesce(g.`a`, "none") }'])].join('\n'),
    });
    expect(rust.observed).toContain('"body":"none"');
  });

  it('copies a map a record’s field holds inside a library function', async () => {
    const files = library([
      S,
      'export function first_a(n: <text>) {',
      '  crm-[c:companies]-> {',
      '    g = graph<S> { ...c.`meta` }',
      '    write crm-[:notes]-> { body: coalesce(g.`a`, n) }',
      '  }',
      '  return n',
      '}',
    ]);
    const source = ['import { first_a } from "lib/forms"', movement(['  first_a(msg.`subject`)'])].join('\n');
    const rust = await run({ source, files, related: META });
    expect(rust.observed).toContain('"body":"x"');
    expect(rust.observed).toContain('"body":"Acme"');
  });

  it('keeps the event’s copy across a park', async () => {
    const body = ['  g = graph { ...msg }', '  await sleep(1h)', '  write crm-[:notes]-> { body: g.`subject` }'].join('\n');
    const resumed = await parkAndResume({ body });
    expect(resumed).toContain('"body":"Acme"');
  });
});

describe('a parked closure holding a record spread', () => {
  it('parks and resumes a closure holding a spread of a handle, a landing and the event', async () => {
    for (const spread of ['...co', '...msg']) {
      const body = [
        '  co = write crm-[:companies]-> { name: "Acme" }',
        '  f = (x: <text>) => {',
        `    g = graph { ${spread}, extra: x }`,
        '    return g.`extra`',
        '  }',
        '  await sleep(1h)',
        '  write crm-[:notes]-> { body: f("1") }',
      ].join('\n');
      const resumed = await parkAndResume({ body });
      expect(resumed).toContain('"body":"1"');
    }
    const landing = ['  crm-[c:companies]-> {', '    f = (x: <text>) => {', '      g = graph { ...c, extra: x }', '      return g.`extra`', '    }', '    await sleep(1h)', '    write crm-[:notes]-> { body: f("1") }', '  }'].join('\n');
    const resumed = await parkAndResume({ body: landing, related: { companies: [{ id: 'c-1', fields: { name: 'Acme' } }] } });
    expect(resumed).toContain('"body":"1"');
  });
});

// ── refresh ────────────────────────────────────────────────────────────────

const FRESH = { 'attio-1': { name: 'Acme Inc', region: 'EU' }, 'c-1': { name: 'Fresh', region: 'US' } };
const NOTE_OF_CO = '  write crm-[:notes]-> { body: "${co.`name`} ${co.`region`}" }';

describe('refresh', () => {
  it('moves a written handle’s snapshot to the record as it stands, in the run’s result too', async () => {
    const rust = await run({ body: ['  co = write crm-[:companies]-> { name: "Acme" }', '  refresh co', NOTE_OF_CO].join('\n'), read: FRESH });
    expect(rust.observed).toContain('"body":"Acme Inc EU"');
    expect(rust.observed).toContain('"writtenValues":{"name":"Acme Inc"}');
  });

  it('fails the run on a record the system deleted, and re-reads each field where the adapter has no readRecord', async () => {
    const gone = await run({ body: ['  co = write crm-[:companies]-> { name: "Acme" }', '  refresh co', NOTE_OF_CO].join('\n') });
    expect(gone.observed).toContain('no longer exists in');
    const fallback = await run({ body: ['  co = write crm-[:companies]-> { name: "Acme" }', '  refresh co', NOTE_OF_CO].join('\n'), noReadRecord: true });
    expect(fallback.observed).toContain('getFieldValue');
  });

  it('moves a traversed record’s inline data, seen through every name that holds it', async () => {
    const related = { companies: [{ id: 'c-1', fields: { name: 'Stale' } }] };
    const rust = await run({
      body: ['  crm-[c:companies]-> {', '    held = { k: c }', '    refresh c', '    write crm-[:notes]-> { body: "${c.`name`}/${held.k.`name`}" }', '  }'].join('\n'),
      related,
      read: FRESH,
    });
    expect(rust.observed).toContain('"body":"Fresh/Fresh"');
    const fallback = await run({ body: ['  crm-[c:companies]-> {', '    refresh c', '    write crm-[:notes]-> { body: c.`name` }', '  }'].join('\n'), related, noReadRecord: true });
    expect(fallback.observed).toContain('"body":"Stale"');
  });

  it('runs inside a library function', async () => {
    const files = library([
      'export function fresh_name(n: <text>) {',
      '  co = write crm-[:companies]-> { name: n }',
      '  refresh co',
      '  return co.`name`',
      '}',
    ]);
    const source = ['import { fresh_name } from "lib/forms"', movement(['  b = fresh_name(msg.`subject`)', '  write crm-[:notes]-> { body: coalesce(b, "none") }'])].join('\n');
    const rust = await run({ source, files, read: FRESH });
    expect(rust.observed).toContain('"body":"Acme Inc"');
  });

  it('leaves an object an adapter kept from a create as it was handed', async () => {
    const rust = await run({ body: ['  co = write crm-[:companies]-> { name: "Acme" }', '  refresh co', NOTE_OF_CO].join('\n'), read: FRESH });
    expect(rust.observed).toContain('"kept":[{"name":"Acme"}');
  });

  it('carries a refreshed handle through a park, and refreshes one after it', async () => {
    const before = await parkAndResume({ body: ['  co = write crm-[:companies]-> { name: "Acme" }', '  refresh co', '  await sleep(1h)', NOTE_OF_CO].join('\n'), read: FRESH });
    expect(before).toContain('"body":"Acme Inc EU"');
    const after = await parkAndResume({ body: ['  co = write crm-[:companies]-> { name: "Acme" }', '  await sleep(1h)', '  refresh co', NOTE_OF_CO].join('\n'), read: FRESH });
    expect(after).toContain('"body":"Acme Inc EU"');
  });
});

// ── a closure called by name inside a library function ─────────────────────

describe('a closure called by name inside a library function', () => {
  const closures = (call: string) =>
    library(['export function tag(n: <text>) {', '  f = (x: <text>) => Text.concat(x, "-L")', `  return ${call}`, '}']);
  const root = ['import { tag } from "lib/forms"', movement(['  r = tag(msg.`subject`)', '  write crm-[:notes]-> { body: coalesce(r, "none") }'])].join('\n');

  it('runs as the same body runs in the root, by order and by name', async () => {
    for (const call of ['f(n)', 'Text.upper(f(n))']) {
      const rust = await run({ source: root, files: closures(call) });
      expect(rust.observed).toContain(call.startsWith('Text.upper') ? '"body":"ACME-L"' : '"body":"Acme-L"');
    }
  });

  it('runs a function of the root file returning its closure’s call, and hands back absent from an empty one', async () => {
    const source = [
      'function tag(n: <text>) {',
      '  f = (x: <text>) => {',
      '    if (x == "") {',
      '      return null',
      '    }',
      '    return Text.concat(x, "-R")',
      '  }',
      '  return f(n)',
      '}',
      movement(['  r = tag(msg.`subject`)', '  e = tag("")', '  write crm-[:notes]-> { body: "${coalesce(r, "none")}/${coalesce(e, "none")}" }']),
    ].join('\n');
    const rust = await run({ source });
    expect(rust.observed).toContain('"body":"Acme-R/none"');
  });

  it('resumes a park inside the library’s closure', async () => {
    const files = library(['export function tag(n: <text>) {', '  f = (x: <text>) => {', '    await sleep(1h)', '    return Text.concat(x, "-L")', '  }', '  return f(n)', '}']);
    const resumed = await parkAndResume({ source: root, files });
    expect(resumed).toContain('"body":"Acme-L"');
  });
});
