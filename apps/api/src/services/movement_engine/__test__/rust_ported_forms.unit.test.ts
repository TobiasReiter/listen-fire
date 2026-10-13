// The forms PLAN-08B Task 2 ported to the Rust engine, each once refused at
// admission by name (crates/movement-engine/README.md, "The port list"): a
// match over a tuple of paths, an `IS` test of a graph literal, a graph
// spread of the event, `refresh`, and a closure called by name inside a
// library function. Each program runs under MOVEMENT_ENGINE=ts and =rust
// against fresh fakes, and the two must agree on everything a caller can see
// — the result or the error, every adapter call in order and key for key, the
// judge's questions, and the parks — and the Rust run must run whole. Where a
// form sits beside a park, each engine's parked state resumes on both.

import { mockCatalogSnapshot, type CatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { PARK_STATE_VERSION, tenantIdOf } from 'engine-contracts';

import type { Adapter, ExternalRecordRef } from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import { META_RECORD_TYPE, makeStablePosition, positionData, positionRecordId } from '../../translation_graph/types';
import { credentialIdsFor, makeFakeParkSink, makeTestHost, type TestHostOverrides } from '../test_host';
import { resumeMovement, runFailureCause, runMovement, type RunMovementInput } from '../run';
import type { ParkedScopeState } from '../serialize';
import { resetRustEvalStats, resetRustRunStats, rustRunStats } from '../rust_stats';

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
  'inbox = email(credentials: dealflow_inbox)',
  'crm = attio(credentials: acme_main)',
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
  languageVersion?: LanguageVersion;
  resume?: ParkedScopeState;
}

type Engine = 'ts' | 'rust';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isParkedScopeState(value: unknown): value is ParkedScopeState {
  return isRecord(value) && value.version === PARK_STATE_VERSION && typeof value.address === 'string';
}

const COLLECTION_TYPE: Record<string, string> = { companies: 'company', people: 'person', notes: 'note' };

function fakeCrm(c: Case, calls: unknown[]): Adapter {
  let minted = 0;
  const rows = Object.values(c.related ?? {}).flat();
  return {
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
      const id = positionRecordId(input.position);
      const row = rows.find((r) => r.id === id);
      if (row !== undefined) return row.fields[input.fieldId] ?? null;
      const data = positionData(input.position);
      return isRecord(data) ? (data[input.fieldId] ?? null) : null;
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

async function runOn(engine: Engine, c: Case) {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  const calls: unknown[] = [];
  const asked: unknown[] = [];
  const park = makeFakeParkSink();
  const snapshot = { ...catalog, files: c.files ?? {} };
  const crm = fakeCrm(c, calls);
  const email = fakeEmail();
  const judge: Judge = async (input) => {
    asked.push({ asserted: input.asserted, candidates: input.candidates, recordType: input.recordType });
    return { index: c.judge ?? null, cost: [{ source: 'model:judge', microdollars: 3 }] };
  };
  const source = c.source ?? `movement m(msg: <inbox-[:message]->>) {\n${c.body ?? ''}\n}`;
  const input: RunMovementInput = {
    source: PRELUDE + source,
    event: { pipelineInputId: 'pi-ported-forms', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme', text: 'EU' } },
    teamId: TEAM_ID,
    catalog: snapshot,
    credentialIds: credentialIdsFor(snapshot, (name: string) => `cred-${name}`),
    firedAt: '2026-05-01T09:00:00.000Z',
    movementName: 'm',
    ...(c.languageVersion !== undefined ? { languageVersion: c.languageVersion } : {}),
    host: makeTestHost({
      adapters: { resolve: (r) => (r.adapterType === 'attio' ? crm : email) },
      llm: { arbitrateEntities: judge },
      park: { sink: park.sink },
    }),
  };
  resetRustRunStats();
  resetRustEvalStats();
  let outcome: Record<string, unknown>;
  try {
    const result = c.resume !== undefined ? await resumeMovement({ ...input, state: c.resume }) : await runMovement(input);
    outcome = { result };
  } catch (error) {
    outcome = { error: String(error), cause: String(runFailureCause(error)) };
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
  const stats = { routed: rustRunStats.routed, ranWhole: rustRunStats.ranWhole, unreproduced: rustRunStats.unreproduced, notAdmitted: { ...rustRunStats.notAdmitted }, declined: { ...rustRunStats.declined } };
  return { observed: normalised({ ...outcome, calls, asked, parks: park.timerParks }), parks: park.timerParks, stats };
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

/** One segment on both engines: identical, and run whole on Rust. */
async function both(c: Case) {
  const ts = await runOn('ts', c);
  const rust = await runOn('rust', c);
  expect(rust.observed).toBe(ts.observed);
  expect(rust.stats).toEqual({ routed: 1, ranWhole: 1, unreproduced: 0, notAdmitted: {}, declined: {} });
  return { ts, rust };
}

/** Park on both engines, then resume each engine's state on both: every
 *  resume identical across the engines and the two park writers. */
async function parkAndResume(c: Case): Promise<string> {
  const parked = await both(c);
  const resumed: string[] = [];
  for (const writer of [parked.ts, parked.rust]) {
    expect(writer.parks).toHaveLength(1);
    const state = writer.parks[0]?.state;
    if (!isParkedScopeState(state)) throw new Error('the park writer left no parked scope state');
    const { rust, ts } = await both({ ...c, resume: state });
    resumed.push(ts.observed, rust.observed);
  }
  expect(new Set(resumed).size).toBe(1);
  const [outcome] = resumed;
  if (outcome === undefined) throw new Error('nothing resumed');
  return outcome;
}

const library = (body: string[]) => ({ 'lib/forms': { source: PRELUDE + body.join('\n') } });
const movement = (body: string[]) => ['movement m(msg: <inbox-[:message]->>) {', ...body, '}'].join('\n');

// ── match over a tuple of paths ────────────────────────────────────────────

const NOTE: ExternalRecordRef = { adapterType: 'attio', externalId: 'note-1', data: { body: 'Acme' } };
const PARENTS = ['  co = write crm-[:companies]-> { name: "Acme" }', '  pe = write crm-[:people]-> { name: "Ada" }'];
const TUPLE_MATCH = '  found = match (co-[:notes]->, pe-[:notes]->) { unique by (`body`), body: msg.`subject` }';

describe('a match over a tuple of paths', () => {
  it('finds the record at the convergence of both paths, under version 3 and version 4', async () => {
    for (const languageVersion of [3, 4] as const) {
      const { rust } = await both({
        body: [...PARENTS, TUPLE_MATCH, '  write crm-[:notes]-> { body: "${found.`body`} ${found.`region`}" }'].join('\n'),
        candidates: { note: [NOTE] },
        read: { 'note-1': { region: 'EU' } },
        languageVersion,
      });
      expect(rust.observed).toContain('"body":"Acme EU"');
    }
  });

  it('ends the body quietly on a miss before version 4, and binds absent from version 4', async () => {
    const body = [...PARENTS, TUPLE_MATCH, '  write crm-[:notes]-> { body: IF found == null THEN "absent" ELSE found.`body` END }'].join('\n');
    const v3 = await both({ body, languageVersion: 3 });
    expect(v3.rust.observed).not.toContain('"absent"');
    const v4 = await both({ body, languageVersion: 4 });
    expect(v4.rust.observed).toContain('"body":"absent"');
  });

  it('asks the judge with every candidate, and binds the one it picks', async () => {
    const other: ExternalRecordRef = { adapterType: 'attio', externalId: 'note-2', data: { body: 'Acme Ltd' } };
    const { rust } = await both({
      body: [...PARENTS, '  found = match (co-[:notes]->, pe-[:notes]->) { unique by (FUZZY `body`), body: "Acm" }', '  write crm-[:notes]-> { body: COALESCE(found.`body`, "none") }'].join('\n'),
      candidates: { note: [NOTE, other] },
      judge: 1,
    });
    expect(rust.observed).toContain('"body":"Acme Ltd"');
  });

  it('matches between two traversed records', async () => {
    const { rust } = await both({
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
      '  return COALESCE(found.`body`, "none")',
      '}',
    ]);
    const source = ['import { find } from "lib/forms"', movement(['  b = find(n: msg.`subject`)', '  write crm-[:notes]-> { body: b }'])].join('\n');
    const { rust } = await both({ source, files, candidates: { note: [NOTE] } });
    expect(rust.observed).toContain('"body":"Acme"');
  });

  it('matches after a park, on whichever engine resumes it', async () => {
    // Parked before the parents are written: a handle rehydrated from a
    // park lands in a graph of its own on both engines, so two of them fail
    // a tuple's one-graph rule (reported, not this port's to change).
    const body = ['  await sleep(1h)', ...PARENTS, TUPLE_MATCH, '  write crm-[:notes]-> { body: COALESCE(found.`body`, "none") }'].join('\n');
    const resumed = await parkAndResume({ body, candidates: { note: [NOTE] } });
    expect(resumed).toContain('"body":"Acme"');
  });
});

// ── IS <Decl> of a graph literal holding a system's records ────────────────

const LEAD = ['node Lead {', '  name: <text>', '  node owner {', '    name: <text>', '  }', '}'].join('\n');
const TYPED_LEAD = ['node Lead {', '  name: <text>', '  node owner {', '    region: <number>', '  }', '}'].join('\n');
const VERDICT = ['  if g IS <Lead> {', '    write crm-[:notes]-> { body: "fits" }', '  } else {', '    write crm-[:notes]-> { body: "does not" }', '  }'];

describe('IS <Decl> of a graph literal', () => {
  it('compares a written handle its edge holds by the handle’s record type', async () => {
    for (const [declaration, verdict] of [[LEAD, 'fits'], [TYPED_LEAD, 'does not']] as const) {
      const { rust } = await both({
        source: [declaration, movement(['  co = write crm-[:companies]-> { name: "Acme" }', '  g = graph { name: "a", owner: co }', ...VERDICT])].join('\n'),
      });
      expect(rust.observed).toContain(`"body":"${verdict}"`);
    }
  });

  it('compares a traversed record its edge holds, and fits where the edge holds nothing', async () => {
    const companies = { companies: [{ id: 'c-1', fields: { name: 'Acme' } }] };
    for (const [declaration, verdict] of [[LEAD, 'fits'], [TYPED_LEAD, 'does not']] as const) {
      const { rust } = await both({
        source: [declaration, movement(['  crm-[c:companies]-> {', '    g = graph { name: c.`name`, owner: c }', ...VERDICT.map((l) => `  ${l}`), '  }'])].join('\n'),
        related: companies,
      });
      expect(rust.observed).toContain(`"body":"${verdict}"`);
    }
    const { rust } = await both({ source: [TYPED_LEAD, movement(['  g = graph { name: "a" }', ...VERDICT])].join('\n') });
    expect(rust.observed).toContain('"body":"fits"');
  });

  it('compares a record nested two nodes down', async () => {
    const deep = (type: string) => ['node Lead {', '  name: <text>', '  node team {', '    node owner {', `      region: <${type}>`, '    }', '  }', '}'].join('\n');
    for (const [type, verdict] of [['text', 'fits'], ['number', 'does not']] as const) {
      const { rust } = await both({
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
      '  if g IS <Lead> {',
      '    return "fits"',
      '  }',
      '  return "does not"',
      '}',
    ]);
    const source = ['import { judge } from "lib/forms"', movement(['  v = judge(n: msg.`subject`)', '  write crm-[:notes]-> { body: COALESCE(v, "none") }'])].join('\n');
    const { rust } = await both({ source, files });
    expect(rust.observed).toContain('"body":"does not"');
  });

  it('compares a handle the graph held across a park, on whichever engine resumes it', async () => {
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
    const { rust } = await both({ body: ['  g = graph { ...msg, extra: 1 }', '  write crm-[:notes]-> { body: "${g.`subject`}/${g.`text`}/${g.`extra`}" }'].join('\n') });
    expect(rust.observed).toContain('"body":"Acme/EU/1"');
  });

  it('copies a map a record’s field holds, and nothing where the field is absent', async () => {
    const { rust } = await both({
      source: [S, movement(['  crm-[c:companies]-> {', '    g = graph<S> { ...c.`meta` }', '    write crm-[:notes]-> { body: COALESCE(g.`a`, "none") }', '  }'])].join('\n'),
      related: META,
    });
    expect(rust.observed).toContain('"body":"x"');
    expect(rust.observed).toContain('"body":"none"');
  });

  it('copies a map a written handle’s field holds', async () => {
    const { rust } = await both({
      source: [S, movement(['  co = write crm-[:companies]-> { name: "Acme" }', '  g = graph<S> { ...co.`meta` }', '  write crm-[:notes]-> { body: COALESCE(g.`a`, "none") }'])].join('\n'),
    });
    expect(rust.observed).toContain('"body":"none"');
  });

  it('copies a map a record’s field holds inside a library function', async () => {
    const files = library([
      S,
      'export function first_a(n: <text>) {',
      '  crm-[c:companies]-> {',
      '    g = graph<S> { ...c.`meta` }',
      '    write crm-[:notes]-> { body: COALESCE(g.`a`, n) }',
      '  }',
      '  return n',
      '}',
    ]);
    const source = ['import { first_a } from "lib/forms"', movement(['  first_a(n: msg.`subject`)'])].join('\n');
    const { rust } = await both({ source, files, related: META });
    expect(rust.observed).toContain('"body":"x"');
    expect(rust.observed).toContain('"body":"Acme"');
  });

  it('keeps the event’s copy across a park, on whichever engine resumes it', async () => {
    const body = ['  g = graph { ...msg }', '  await sleep(1h)', '  write crm-[:notes]-> { body: g.`subject` }'].join('\n');
    const resumed = await parkAndResume({ body });
    expect(resumed).toContain('"body":"Acme"');
  });
});
