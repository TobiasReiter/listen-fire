// Parked code — a closure, a kept walk's head and mapping, a body-local
// declaration — is named in the parked state by its place in the pinned
// program (park state version 2, docs/contracts/park-state.md), and the
// libraries the run linked ride beside it: their text, or the hash the host's
// source store (`park.sources`) keeps it by. Each case parks inside a library
// function and resumes: where the root writes other code at the same span, or
// the library is edited while the run sleeps, the run still runs the code that
// was parked (PLAN-08A batch review, R1 and R2).

import { mockCatalogSnapshot, type CatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { PARK_STATE_VERSION, tenantIdOf } from 'engine-contracts';

import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { makeStablePosition, positionData } from 'movement-engine/services/translation_graph/types';
import { credentialIdsFor, makeFakeParkSink, makeMemoryParkSources, makeTestHost } from 'movement-engine/services/movement_engine/test_host';
import { resumeMovement, runFailureCause, runMovement, type RunMovementInput } from 'movement-engine/services/movement_engine/run';
import type { CodeByPlace, ParkedScopeState } from 'engine-contracts';
import { resetRustEvalStats, resetRustRunStats, rustRunStats } from 'movement-engine/services/movement_engine/rust_stats';

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
  resume?: ParkedScopeState<CodeByPlace>;
  /** The host's library source store; absent, a park carries each text. */
  sources?: ReturnType<typeof makeMemoryParkSources>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isParkedScopeState(value: unknown): value is ParkedScopeState<CodeByPlace> {
  return isRecord(value) && value.version === PARK_STATE_VERSION && typeof value.address === 'string';
}

function fakeAdapter(adapterType: string, calls: unknown[], c: Case): Adapter {
  let minted = 0;
  return {
    adapterType,
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
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
      const rows = adapterType === 'attio' ? (c.related?.[read.fieldId] ?? []) : [];
      return rows.map((data, i) => ({
        position: makeStablePosition({ adapterType, recordType: 'company', recordId: `${adapterType}-${i}`, data }),
      }));
    },
    async createRecord(input) {
      calls.push([adapterType, 'createRecord', input]);
      minted += 1;
      return { adapterType, externalId: `${adapterType}-${minted}`, data: { minted } };
    },
    async updateRecord(input) {
      calls.push([adapterType, 'updateRecord', input]);
      return { adapterType, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord(input) {
      calls.push([adapterType, 'deleteRecord', input]);
      return {};
    },
  };
}

async function runOnRust(c: Case) {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = 'rust';
  const calls: unknown[] = [];
  const asked: unknown[] = [];
  const replies = [...(c.replies ?? [])];
  const park = makeFakeParkSink();
  const snapshot = { ...catalog, files: c.files };
  const email = fakeAdapter('email', calls, c);
  const attio = fakeAdapter('attio', calls, c);
  const input: RunMovementInput = {
    source: PRELUDE + c.source,
    event: { pipelineInputId: 'pi-parked-code', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme', text: 'Acme raised.' } },
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
            asked.push({ label: request.label, userMessage: request.userMessage, system: request.system });
            return { parsedJson: replies.shift() ?? {} };
          },
        },
        extractCall: {
          call: async (request) => {
            asked.push({ label: request.label, blocks: request.blocks, system: request.system });
            return { parsedJson: replies.shift() ?? {}, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } };
          },
        },
      },
      park: { sink: park.sink, ...(c.sources !== undefined ? { sources: c.sources.sources } : {}) },
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
    const known = ids.get(id);
    if (known !== undefined) return known;
    const name = `uuid-${ids.size + 1}`;
    ids.set(id, name);
    return name;
  });
}

/** One segment, run whole on Rust. */
async function onRust(c: Case) {
  const rust = await runOnRust(c);
  expect(rust.stats).toEqual({ routed: 1, ranWhole: 1, unreproduced: 0, declined: {} });
  return rust;
}

/** The one park a run left. */
function parkedState(run: { parks: Array<{ state: unknown }> }): ParkedScopeState<CodeByPlace> {
  expect(run.parks).toHaveLength(1);
  const state = run.parks[0]?.state;
  if (!isParkedScopeState(state)) throw new Error('the park writer left no parked scope state');
  return state;
}

/** Park, then resume against `resumeFiles` (the library as it stands at the
 *  resume). Returns the resumed outcome. */
async function parkAndResume(c: Case, resumeFiles: Record<string, { source: string }> = c.files): Promise<string> {
  const state = parkedState(await onRust(c));
  return (await onRust({ ...c, files: resumeFiles, resume: state })).observed;
}

const library = (body: string[]) => ({ 'lib/keep': { source: PRELUDE + body.join('\n') } });

describe('parked code is read at its place in the program it parked with', () => {
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
    const resumed = await parkAndResume({ source, files: closureLibrary('L') }, closureLibrary('X'));
    expect(resumed).toContain('"body":"Acme-L"');
    expect(resumed).not.toContain('Acme-X');
  });

  it('reads a parked closure’s checked spread in the library it parked with (R1)', async () => {
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
    const source = ['import { keep } from "lib/keep"', 'function m(msg: <inbox-[:message]->>) {', '  keep(msg.subject)', '}'].join('\n');
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
    const replies = [{ records: [{ label: { value: 'Infra', evidence: { item: 0, quote: 'q' } } }] }];
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

describe('a park pins the libraries the run linked', () => {
  const keep = (suffix: string) =>
    library([
      'export function keep(n: <text>) {',
      `  f = (x: <text>) => Text.concat(x, "-${suffix}")`,
      '  await sleep(1h)',
      '  return first(map([n], f))',
      '}',
    ]);
  const source = [
    'import { keep } from "lib/keep"',
    'function m(msg: <inbox-[:message]->>) {',
    '  r = keep(msg.subject)',
    '  write crm-[:notes]-> { body: coalesce(r, "none") }',
    '}',
  ].join('\n');

  it('names its code by place and carries each library’s text when the host keeps no store', async () => {
    const state = parkedState(await onRust({ source, files: keep('L') }));
    expect(state.version).toBe(2);
    expect(state.libraries).toEqual([{ path: 'lib/keep', source: keep('L')['lib/keep'].source }]);
    const closure = state.scopeChain.flatMap((scope) => Object.values(scope.bindings)).find((b) => b.kind === 'closure');
    expect(closure).toMatchObject({ kind: 'closure', closure: '@lib~1keep/statements/4/body/0/value/closure' });
  });

  it('names each library by the hash the store keeps its text by, and resumes with the text it parked with', async () => {
    const sources = makeMemoryParkSources();
    const state = parkedState(await onRust({ source, files: keep('L'), sources }));
    const [pinned] = state.libraries ?? [];
    if (pinned === undefined || !('hash' in pinned)) throw new Error('the park named no library by its hash');
    expect(sources.texts.get(pinned.hash)).toBe(keep('L')['lib/keep'].source);
    const resumed = await onRust({ source, files: keep('X'), sources, resume: state });
    expect(resumed.observed).toContain('"body":"Acme-L"');
    expect(resumed.observed).not.toContain('Acme-X');
  });

  it('keeps one text for two runs parked on the same library', async () => {
    const sources = makeMemoryParkSources();
    const first = parkedState(await onRust({ source, files: keep('L'), sources }));
    const second = parkedState(await onRust({ source, files: keep('L'), sources }));
    expect(second.libraries).toEqual(first.libraries);
    expect(sources.texts.size).toBe(1);
  });

  it('fails the resume naming the library when the store holds no text for its hash', async () => {
    const state = parkedState(await onRust({ source, files: keep('L'), sources: makeMemoryParkSources() }));
    const resumed = await onRust({ source, files: keep('L'), sources: makeMemoryParkSources(), resume: state });
    expect(resumed.observed).toContain('the source store holds no text for \\"lib/keep\\"');
  });
});

// A slot that arrives without its parse — a statement in a closure's body (its
// tree rides inside the call's), code read again at its place on resume —
// is read under the run's pinned version, as the program's own slots were. Read
// under none, `Text.upper(v)` is a TEXT namespace with no UPPER, `xs[0]` an
// index the lowering refuses and `a && b` a character the v1–4 grammar has no
// reading for.
describe('a slot read again is read under the run’s version', () => {
  const body = (sleep: boolean) => [
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
    const { observed } = await onRust({ source: body(false), files: {} });
    expect(observed).toContain('"body":"X-b-a"');
    expect(observed).toContain('"body":"X,Y"');
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
    const { observed } = await onRust({ source, files: {} });
    expect(observed).toContain('"body":"N1"');
  });
});
