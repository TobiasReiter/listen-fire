// Parked code — a closure, a kept walk's head and mapping, a body-local
// declaration — rides in the parked state as its syntax tree
// (docs/contracts/park-state.md, "Code is carried as a name, or as its syntax
// tree"), and a resume rebuilds it from that tree on either engine, never by
// looking for its span in the program. Each case parks inside a library
// function on both engines, then resumes each engine's state on both: where
// the root writes other code at the same span, or the library is edited while
// the run sleeps, both engines still run the code that was parked (PLAN-08A
// batch review, R1 and R2).

import { mockCatalogSnapshot, type CatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';

import { containerAssociation } from '../../translation_graph/adapter';
import { makeStablePosition, positionData } from '../../translation_graph/types';
import { credentialIdsFor, makeFakeParkSink, makeTestHost } from '../test_host';
import { resumeMovement, runFailureCause, runMovement } from '../run';
import { resetRustEvalStats, resetRustRunStats, rustRunStats } from '../rust_stats';

jest.setTimeout(60_000);

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000ca');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};
const attioSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text' }, edges: {} },
    note: { properties: { body: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
    note: { fields: { body: 'text' }, resultShape: { externalId: 'text', body: 'text' } },
  },
};
const catalog: CatalogSnapshot = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: attioSchema },
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

interface Case {
  source: string;
  files: Record<string, { source: string }>;
  /** `getRelated` answers by field. */
  related?: Record<string, Array<Record<string, unknown>>>;
  replies?: unknown[];
  resume?: unknown;
}

type Engine = 'ts' | 'rust';

function fakeAdapter(adapterType: string, calls: unknown[], c: Case) {
  let minted = 0;
  return {
    adapterType,
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false } }),
    listEntryPoints: async () => [],
    async describe() {
      return null;
    },
    async resolveEntity(input: unknown) {
      calls.push([adapterType, 'resolveEntity', input]);
      return { candidates: [] };
    },
    async getFieldValue(input: { fieldId: string; position: unknown }) {
      return (positionData(input.position) as Record<string, unknown> | undefined)?.[input.fieldId];
    },
    async getRelated(read: { fieldId: string }) {
      calls.push([adapterType, 'getRelated', read.fieldId]);
      const rows = adapterType === 'attio' ? (c.related?.[read.fieldId] ?? []) : [];
      return rows.map((data, i) => ({
        position: makeStablePosition({ adapterType, recordType: 'company', recordId: `${adapterType}-${i}`, data }),
      }));
    },
    async createRecord(input: unknown) {
      calls.push([adapterType, 'createRecord', input]);
      minted += 1;
      return { adapterType, externalId: `${adapterType}-${minted}`, data: { minted } };
    },
    async updateRecord(input: { externalId: string }) {
      calls.push([adapterType, 'updateRecord', input]);
      return { adapterType, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord(input: unknown) {
      calls.push([adapterType, 'deleteRecord', input]);
      return {};
    },
  };
}

async function runOn(engine: Engine, c: Case) {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  const calls: unknown[] = [];
  const asked: unknown[] = [];
  const replies = [...(c.replies ?? [])];
  const park = makeFakeParkSink();
  const snapshot = { ...catalog, files: c.files };
  const email = fakeAdapter('email', calls, c);
  const attio = fakeAdapter('attio', calls, c);
  const input = {
    source: PRELUDE + c.source,
    event: { pipelineInputId: 'pi-parked-code', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme', text: 'Acme raised.' } },
    teamId: TEAM_ID,
    catalog: snapshot,
    credentialIds: credentialIdsFor(snapshot, (name: string) => `cred-${name}`),
    firedAt: '2026-05-01T09:00:00.000Z',
    movementName: 'm',
    host: makeTestHost({
      adapters: { resolve: (r: { adapterType: string }) => (r.adapterType === 'attio' ? attio : email) },
      llm: {
        client: {
          call: async (request: { label: string; userMessage: string; systemPrompt?: string }) => {
            asked.push({ label: request.label, userMessage: request.userMessage, system: request.systemPrompt });
            return { parsedJson: replies.shift() ?? {} };
          },
        },
      },
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
  const stats = { routed: rustRunStats.routed, ranWhole: rustRunStats.ranWhole, unreproduced: rustRunStats.unreproduced, declined: { ...rustRunStats.declined } };
  return { observed: normalised({ ...outcome, calls, asked, parks: park.timerParks }), parks: park.timerParks, stats };
}

/** What a caller sees, ids named by first appearance. */
function normalised(value: unknown): string {
  const ids = new Map<string, string>();
  const text = JSON.stringify(value, (_key, x: unknown) => (x instanceof Map ? Object.fromEntries(x) : x)) ?? 'undefined';
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
    if (!ids.has(id)) ids.set(id, `uuid-${ids.size + 1}`);
    return ids.get(id) as string;
  });
}

/** One segment on both engines: identical, and run whole on Rust. */
async function both(c: Case) {
  const ts = await runOn('ts', c);
  const rust = await runOn('rust', c);
  expect(rust.observed).toBe(ts.observed);
  expect(rust.stats).toEqual({ routed: 1, ranWhole: 1, unreproduced: 0, declined: {} });
  return { ts, rust };
}

/**
 * Park on both engines, then resume each engine's state on both against
 * `resumeFiles` (the library as it stands at the resume): every resume
 * identical across the engines and across the two park writers. Returns the
 * resumed outcome.
 */
async function parkAndResume(c: Case, resumeFiles: Record<string, { source: string }> = c.files): Promise<string> {
  const parked = await both(c);
  const resumed: string[] = [];
  for (const writer of [parked.ts, parked.rust]) {
    expect(writer.parks).toHaveLength(1);
    const { rust, ts } = await both({ ...c, files: resumeFiles, resume: writer.parks[0]?.state });
    resumed.push(ts.observed, rust.observed);
  }
  expect(new Set(resumed).size).toBe(1);
  return resumed[0] as string;
}

const library = (body: string[]) => ({ 'lib/keep': { source: PRELUDE + body.join('\n') } });

describe('parked code is rebuilt from its tree on both engines', () => {
  const closureLibrary = (suffix: string) =>
    library([
      'export function keep(n: <text>) {',
      `  f = (x: <text>) => CONCAT(x, "-${suffix}")`,
      '  await sleep(1h)',
      '  return FIRST(MAP([n], f))',
      '}',
    ]);

  it('runs a library closure as it was parked, though the root writes another at its span (R1)', async () => {
    const source = [
      'export function zork(n: <text>) {',
      '  f = (x: <text>) => CONCAT(x, "-R")',
      '  return FIRST(MAP([n], f))',
      '}',
      'import { keep } from "lib/keep"',
      'movement m(msg: <inbox-[:message]->>) {',
      '  r = keep(n: msg.subject)',
      '  write crm-[:companies]-> { name: COALESCE(r, "none") }',
      '}',
    ].join('\n');
    const resumed = await parkAndResume({ source, files: closureLibrary('L') });
    expect(resumed).toContain('"name":"Acme-L"');
    expect(resumed).not.toContain('Acme-R');
  });

  it('runs a library closure as it was parked, though the library was edited while the run slept (R1)', async () => {
    const source = [
      'import { keep } from "lib/keep"',
      'movement m(msg: <inbox-[:message]->>) {',
      '  r = keep(n: msg.subject)',
      '  write crm-[:notes]-> { body: COALESCE(r, "none") }',
      '}',
    ].join('\n');
    const resumed = await parkAndResume({ source, files: closureLibrary('L') }, closureLibrary('X'));
    expect(resumed).toContain('"body":"Acme-L"');
    expect(resumed).not.toContain('Acme-X');
  });

  it('reads a parked closure’s checked spread from the tree it rode in (R1)', async () => {
    const files = library([
      'export function keep(n: <text>) {',
      '  f = (x: <text>) => {',
      '    d = node { body: CONCAT(x, "-L") }',
      '    write crm-[:notes]-> { ...d }',
      '    return x',
      '  }',
      '  await sleep(1h)',
      '  return FIRST(MAP([n], f))',
      '}',
    ]);
    const source = ['import { keep } from "lib/keep"', 'movement m(msg: <inbox-[:message]->>) {', '  keep(n: msg.subject)', '}'].join('\n');
    const resumed = await parkAndResume({ source, files });
    expect(resumed).toContain('"body":"Acme-L"');
  });

  it('asks the model about a library’s body-local shape as it was parked, though the root declares another at its span (R1)', async () => {
    const files = library([
      'export function keep(n: <text>) {',
      '  node Tag: "a tag by LIB" {',
      '    label: <text> "its label"',
      '  }',
      '  await sleep(1h)',
      '  found = extract from [n] {',
      '    node tag: <Tag>',
      '  }',
      '  found-[g:tag]-> {',
      '    write crm-[:notes]-> { body: g.label }',
      '  }',
      '}',
    ]);
    const source = [
      'export function zork(n: <text>) {',
      '  node Tag: "a tag by ROO" {',
      '    label: <text> "its label"',
      '  }',
      '  return n',
      '}',
      'import { keep } from "lib/keep"',
      'movement m(msg: <inbox-[:message]->>) {',
      '  keep(n: msg.subject)',
      '}',
    ].join('\n');
    const replies = [{ 'x:extract_result#1': [{ tag: [{ label: { evidence: 'q', value: 'Infra' } }] }] }];
    const resumed = await parkAndResume({ source, files, replies });
    expect(resumed).toContain('a tag by LIB');
    expect(resumed).not.toContain('a tag by ROO');
    expect(resumed).toContain('"body":"Infra"');
  });

  const walkLibrary = library([
    'export function keep(n: <text>) {',
    '  d = node { cos: lazy crm-[a:companies]-> node { name: CONCAT(a.name, "-L") } }',
    '  await sleep(1h)',
    '  return d',
    '}',
  ]);
  const walkRoot = [
    'import { keep } from "lib/keep"',
    'movement m(msg: <inbox-[:message]->>) {',
    '  d = keep(n: msg.subject)',
    '  d-[c:cos]-> {',
    '    write crm-[:notes]-> { body: c.name }',
    '  }',
    '}',
  ].join('\n');
  const related = { companies: [{ name: 'Co1' }] };

  it('walks a library’s kept walk as it was parked, where the root writes no walk (R2)', async () => {
    const resumed = await parkAndResume({ source: walkRoot, files: walkLibrary, related });
    expect(resumed).toContain('"body":"Co1-L"');
  });

  it('walks a library’s kept walk as it was parked, though the root writes another at its head’s span (R2)', async () => {
    const source = [
      'export function zork(n: <text>) {',
      '  d = node { cos: lazy crm-[a:companies]-> node { name: CONCAT(a.name, "-RR") } }',
      '  return d',
      '}',
      walkRoot,
    ].join('\n');
    const resumed = await parkAndResume({ source, files: walkLibrary, related });
    expect(resumed).toContain('"body":"Co1-L"');
    expect(resumed).not.toContain('Co1-R');
  });
});
