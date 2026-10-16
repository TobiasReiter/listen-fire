// Parked code — a closure, a kept walk's head and mapping, a body-local
// declaration — rides in the parked state as its syntax tree
// (docs/contracts/park-state.md, "Code is carried as a name, or as its syntax
// tree"), and a resume rebuilds it from that tree, never by looking for its
// span in the program. Each case parks inside a library function on the Rust
// engine, then resumes that state: where the root writes other code at the
// same span, or the library is edited while the run sleeps, the engine still
// runs the code that was parked (PLAN-08A batch review, R1 and R2).

import { mockCatalogSnapshot, type CatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { PARK_STATE_VERSION, tenantIdOf } from 'engine-contracts';

import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { makeStablePosition, positionData } from 'movement-engine/services/translation_graph/types';
import {
  credentialIdsFor,
  makeFakeParkSink,
  makeTestHost,
} from 'movement-engine/services/movement_engine/test_host';
import {
  resumeMovement,
  runFailureCause,
  runMovement,
  type RunMovementInput,
} from 'movement-engine/services/movement_engine/run';
import type { ParkedScopeState } from 'movement-engine/services/movement_engine/serialize';
import {
  resetRustRunStats,
  rustRunStats,
} from 'movement-engine/services/movement_engine/rust_stats';

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
    email: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: emailSchema,
    },
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: attioSchema,
    },
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

interface Case {
  source: string;
  files: Record<string, { source: string }>;
  /** `getRelated` answers by field. */
  related?: Record<string, Array<Record<string, unknown>>>;
  replies?: unknown[];
  resume?: ParkedScopeState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isParkedScopeState(value: unknown): value is ParkedScopeState {
  return (
    isRecord(value) && value.version === PARK_STATE_VERSION && typeof value.address === 'string'
  );
}

function fakeAdapter(adapterType: string, calls: unknown[], c: Case): Adapter {
  let minted = 0;
  return {
    adapterType,
    supportedTriggers: [],
    runtimeCapabilities: () => ({
      traversal: { incoming: false, edgeProperties: false },
      resources: false,
    }),
    listEntryPoints: async () => [],
    describe: async () => null,
    async resolveEntity(input) {
      calls.push([adapterType, 'resolveEntity', input]);
      return { candidates: [] };
    },
    async getFieldValue(input) {
      const data = positionData(input.position);
      return isRecord(data) ? data[input.fieldId] : undefined;
    },
    async getRelated(read) {
      calls.push([adapterType, 'getRelated', read.fieldId]);
      const rows = adapterType === 'attio' ? c.related?.[read.fieldId] ?? [] : [];
      return rows.map((data, i) => ({
        position: makeStablePosition({
          adapterType,
          recordType: 'company',
          recordId: `${adapterType}-${i}`,
          data,
        }),
      }));
    },
    async createRecord(input) {
      calls.push([adapterType, 'createRecord', input]);
      minted += 1;
      return { adapterType, externalId: `${adapterType}-${minted}`, data: { minted } };
    },
    async updateRecord(input) {
      calls.push([adapterType, 'updateRecord', input]);
      return {
        adapterType,
        externalId: input.externalId,
        data: {},
        association: containerAssociation(input),
      };
    },
    async deleteRecord(input) {
      calls.push([adapterType, 'deleteRecord', input]);
      return {};
    },
  };
}

async function runOn(c: Case) {
  const calls: unknown[] = [];
  const asked: unknown[] = [];
  const replies = [...(c.replies ?? [])];
  const park = makeFakeParkSink();
  const snapshot = { ...catalog, files: c.files };
  const email = fakeAdapter('email', calls, c);
  const attio = fakeAdapter('attio', calls, c);
  const input: RunMovementInput = {
    source: PRELUDE + c.source,
    event: {
      pipelineInputId: 'pi-parked-code',
      adapterType: 'email',
      triggerType: 'webhook',
      payload: { subject: 'Acme', text: 'Acme raised.' },
    },
    teamId: TEAM_ID,
    catalog: snapshot,
    credentialIds: credentialIdsFor(snapshot, (name: string) => `cred-${name}`),
    firedAt: '2026-05-01T09:00:00.000Z',
    movementName: 'm',
    host: makeTestHost({
      adapters: { resolve: (r) => (r.adapterType === 'attio' ? attio : email) },
      llm: {
        client: {
          call: async (request) => {
            asked.push({
              label: request.label,
              userMessage: request.userMessage,
              system: request.system,
            });
            return { parsedJson: replies.shift() ?? {} };
          },
        },
        extractCall: {
          call: async (request) => {
            asked.push({ label: request.label, blocks: request.blocks, system: request.system });
            return {
              parsedJson: replies.shift() ?? {},
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              },
            };
          },
        },
      },
      park: { sink: park.sink },
    }),
  };
  resetRustRunStats();
  let outcome: Record<string, unknown>;
  try {
    const result =
      c.resume !== undefined
        ? await resumeMovement({ ...input, state: c.resume })
        : await runMovement(input);
    outcome = { result };
  } catch (error) {
    outcome = { error: String(error), cause: String(runFailureCause(error)) };
  }
  const stats = {
    segments: rustRunStats.segments,
    unsupported: { ...rustRunStats.unsupported },
    shimFaults: rustRunStats.shimFaults,
  };
  return {
    observed: normalised({ ...outcome, calls, asked, parks: park.timerParks }),
    parks: park.timerParks,
    stats,
  };
}

/** What a caller sees, ids named by first appearance. */
function normalised(value: unknown): string {
  const ids = new Map<string, string>();
  const text =
    JSON.stringify(value, (_key, x: unknown) => (x instanceof Map ? Object.fromEntries(x) : x)) ??
    'undefined';
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
    const known = ids.get(id);
    if (known !== undefined) return known;
    const name = `uuid-${ids.size + 1}`;
    ids.set(id, name);
    return name;
  });
}

/** One segment on the Rust engine, run whole. */
async function onRust(c: Case) {
  const rust = await runOn(c);
  expect(rust.stats).toEqual({ segments: 1, unsupported: {}, shimFaults: 0 });
  return rust;
}

/**
 * Park on the Rust engine, then resume its state against `resumeFiles` (the
 * library as it stands at the resume). Returns the resumed outcome.
 */
async function parkAndResume(
  c: Case,
  resumeFiles: Record<string, { source: string }> = c.files,
): Promise<string> {
  const parked = await onRust(c);
  expect(parked.parks).toHaveLength(1);
  const state = parked.parks[0]?.state;
  if (!isParkedScopeState(state)) throw new Error('the park writer left no parked scope state');
  return (await onRust({ ...c, files: resumeFiles, resume: state })).observed;
}

const library = (body: string[]) => ({ 'lib/keep': { source: PRELUDE + body.join('\n') } });

describe('parked code is rebuilt from its tree on the Rust engine', () => {
  const closureLibrary = (suffix: string) =>
    library([
      'export function keep(n: <text>) {',
      `  f = (x: <text>) => Text.concat(x, "-${suffix}")`,
      '  await sleep(1h)',
      '  return first(map([n], f))',
      '}',
    ]);

  it('runs a library closure as it was parked, though the root writes another at its span (R1)', async () => {
    const source = [
      'export function zork(n: <text>) {',
      '  f = (x: <text>) => Text.concat(x, "-R")',
      '  return first(map([n], f))',
      '}',
      'import { keep } from "lib/keep"',
      'function m(msg: <inbox-[:message]->>) {',
      '  r = keep(msg.subject)',
      '  write crm-[:companies]-> { name: coalesce(r, "none") }',
      '}',
    ].join('\n');
    const resumed = await parkAndResume({ source, files: closureLibrary('L') });
    expect(resumed).toContain('"name":"Acme-L"');
    expect(resumed).not.toContain('Acme-R');
  });

  it('runs a library closure as it was parked, though the library was edited while the run slept (R1)', async () => {
    const source = [
      'import { keep } from "lib/keep"',
      'function m(msg: <inbox-[:message]->>) {',
      '  r = keep(msg.subject)',
      '  write crm-[:notes]-> { body: coalesce(r, "none") }',
      '}',
    ].join('\n');
    const resumed = await parkAndResume(
      { source, files: closureLibrary('L') },
      closureLibrary('X'),
    );
    expect(resumed).toContain('"body":"Acme-L"');
    expect(resumed).not.toContain('Acme-X');
  });

  it('reads a parked closure’s checked spread from the tree it rode in (R1)', async () => {
    const files = library([
      'export function keep(n: <text>) {',
      '  f = (x: <text>) => {',
      '    d = node { body: Text.concat(x, "-L") }',
      '    write crm-[:notes]-> { ...d }',
      '    return x',
      '  }',
      '  await sleep(1h)',
      '  return first(map([n], f))',
      '}',
    ]);
    const source = [
      'import { keep } from "lib/keep"',
      'function m(msg: <inbox-[:message]->>) {',
      '  keep(msg.subject)',
      '}',
    ].join('\n');
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
      '  found = extract([n], Tag)',
      '  map(found, (g) => {',
      '    write crm-[:notes]-> { body: g.label }',
      '  })',
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
      'function m(msg: <inbox-[:message]->>) {',
      '  keep(msg.subject)',
      '}',
    ].join('\n');
    const replies = [
      { records: [{ label: { value: 'Infra', evidence: { item: 0, quote: 'q' } } }] },
    ];
    const resumed = await parkAndResume({ source, files, replies });
    expect(resumed).toContain('a tag by LIB');
    expect(resumed).not.toContain('a tag by ROO');
    expect(resumed).toContain('"body":"Infra"');
  });

  const walkLibrary = library([
    'export function keep(n: <text>) {',
    '  d = node { cos: lazy crm-[a:companies]-> node { name: Text.concat(a.name, "-L") } }',
    '  await sleep(1h)',
    '  return d',
    '}',
  ]);
  const walkRoot = [
    'import { keep } from "lib/keep"',
    'function m(msg: <inbox-[:message]->>) {',
    '  d = keep(msg.subject)',
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
      '  d = node { cos: lazy crm-[a:companies]-> node { name: Text.concat(a.name, "-RR") } }',
      '  return d',
      '}',
      walkRoot,
    ].join('\n');
    const resumed = await parkAndResume({ source, files: walkLibrary, related });
    expect(resumed).toContain('"body":"Co1-L"');
    expect(resumed).not.toContain('Co1-R');
  });
});

// A slot that arrives without its parse — a statement in a closure's body (its
// tree rides inside the call's), code rebuilt from a parked tree on resume —
// is read under the run's pinned version, as the program's own slots were. Read
// under none, `Text.upper(v)` is a TEXT namespace with no UPPER, `xs[0]` an
// index the lowering refuses and `a && b` a character with no reading.
describe('a slot read again is read under the run’s version, on the Rust engine', () => {
  const body = (sleep: boolean) =>
    [
      'function m(msg: <inbox-[:message]->>) {',
      '  tags = ["b", "a"]',
      '  out = map(["x", "y"], (v) => {',
      ...(sleep ? ['    await sleep(1h)'] : []),
      '    up = Text.upper(v)',
      '    sorted = sort(tags, (t) => Text.upper(t), { order: "desc" })',
      '    if (up == "X" && sorted[0] == "b") {',
      '      write crm-[:notes]-> { body: Text.concat(up, "-", sorted[0], "-", tags[1]) }',
      '    }',
      '    return Text.upper(v)',
      '  })',
      '  write crm-[:notes]-> { body: Text.join(out, ",") }',
      '}',
    ].join('\n');

  it('runs a closure’s statements under it', async () => {
    const rust = await onRust({ source: body(false), files: {} });
    expect(rust.observed).toContain('"body":"X-b-a"');
    expect(rust.observed).toContain('"body":"X,Y"');
  });

  it('resumes a collection member parked in its closure under it', async () => {
    const resumed = await parkAndResume({ source: body(true), files: {} });
    expect(resumed).toContain('"body":"X-b-a"');
  });

  it('reads a unique by part written in a closure’s body under it', async () => {
    const source = [
      'function m(msg: <inbox-[:message]->>) {',
      '  co = write crm-[:companies]-> { name: "Acme" }',
      '  out = map(["n1"], (v) => {',
      '    write crm-[:notes]-> {',
      '      unique by (body && co)',
      '      body: Text.upper(v)',
      '    }',
      '    return v',
      '  })',
      '}',
    ].join('\n');
    const rust = await onRust({ source, files: {} });
    expect(rust.observed).toContain('"body":"N1"');
  });
});
