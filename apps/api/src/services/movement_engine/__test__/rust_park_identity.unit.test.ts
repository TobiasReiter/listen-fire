// What a park says about identity and where code is declared, on the Rust
// engine (main's B7, B11 and B13): each case parks, then resumes the parked
// state.
//
//   · B7 — one write handle two names hold (`b = a`, `b = write a { … }`, a
//     record's `-[:@old]->`) is written once and referenced after
//     (`handleRef`, the first descriptor numbered `id`), so the resume holds
//     ONE handle: an in-place write through one name is read through the
//     other. A completed branch's export is written by one park, `#return`
//     first.
//   · B11 — a shape or movement declared in a library parks with its `file`
//     and is found again there, though the root declares the same name.
//   · B13 — a closure bound at a file's top level holds that file's scope by
//     reference and parks by name (`fileClosure`), so a park stays small
//     however many a file declares.

import { spelledForVersion5 } from './combinator_spelling';
import { spelledFor } from 'movement-lang/checker/__test__/surface_spelling';
import {
  fromCatalogSnapshot,
  mockCatalogSnapshot,
  resolveFileFromSnapshot,
  type CatalogSnapshot,
  type InstanceSchema,
} from 'movement-lang';
import { SUPPORTED_PARK_STATE_VERSIONS, tenantIdOf, type AnyParkedScopeState } from 'engine-contracts';

import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { positionData } from 'movement-engine/services/translation_graph/types';
import { credentialIdsFor, makeTestHost } from 'movement-engine/services/movement_engine/test_host';
import {
  resumeMovement,
  runFailureCause,
  runMovement,
  type ParkSink,
  type RunMovementInput,
} from 'movement-engine/services/movement_engine/run';
import {
  resetRustRunStats,
  rustRunStats,
} from 'movement-engine/services/movement_engine/rust_stats';

jest.setTimeout(60_000);

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000cb');

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
  supportsInPlaceUpdate: true,
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
  'inbox = email(credentials: dealflow_inbox)',
  'crm = attio(credentials: acme_main)',
  '',
].join('\n');

interface Case {
  source: string;
  files?: Record<string, { source: string }>;
  /** The stored rows a resume reads: parks, joins and branch exports. */
  store?: Store;
  resume?: { address: string; state: AnyParkedScopeState };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isParkedScopeState(value: unknown): value is AnyParkedScopeState {
  return (
    isRecord(value) &&
    typeof value.version === 'number' &&
    SUPPORTED_PARK_STATE_VERSIONS.has(value.version) &&
    typeof value.address === 'string'
  );
}

/** A park sink that keeps what it is handed, as the database would hand it
 *  back (JSON), so a resume reads the joins and branch exports a park wrote. */
function makeStore() {
  const parks = new Map<
    string,
    { kind: 'timer' | 'await' | 'suspension'; state: AnyParkedScopeState }
  >();
  const joins = new Map<
    string,
    { pending: number; closedBy: string | null; decremented: Set<string> }
  >();
  const exports = new Map<string, Map<string, { branchIndex: number; exports: unknown }>>();
  const keep = (kind: 'timer' | 'await' | 'suspension', address: string, state: unknown): void => {
    parks.set(address, { kind, state: JSON.parse(JSON.stringify(state)) as AnyParkedScopeState });
  };
  const sink: ParkSink = {
    async recordJoin(input) {
      const existing = joins.get(input.frameAddress);
      joins.set(input.frameAddress, {
        pending: input.parkedChildren,
        closedBy: existing?.closedBy ?? null,
        decremented: existing?.decremented ?? new Set(),
      });
    },
    async commitTimerPark(input) {
      keep('timer', input.address, input.state);
    },
    async commitAwaitPark(input) {
      keep('await', input.address, input.state);
    },
    async commitSuspension(input) {
      keep('suspension', input.address, input.state);
    },
    async decrementJoin(input) {
      const frame = joins.get(input.frameAddress);
      if (frame === undefined) return { closed: false };
      if (frame.decremented.has(input.branchAddress))
        return { closed: frame.closedBy === input.leafAddress };
      frame.decremented.add(input.branchAddress);
      if (frame.pending === 0) return { closed: frame.closedBy === input.leafAddress };
      frame.pending -= 1;
      if (frame.pending > 0) return { closed: false };
      frame.closedBy = input.leafAddress;
      return { closed: true };
    },
    async persistBranchExport(input) {
      const byBranch = exports.get(input.frameAddress) ?? new Map();
      byBranch.set(input.branchAddress, {
        branchIndex: input.branchIndex,
        exports: JSON.parse(JSON.stringify(input.exports)) as unknown,
      });
      exports.set(input.frameAddress, byBranch);
    },
    async collectBranchExports(input) {
      return [...(exports.get(input.frameAddress) ?? new Map()).entries()]
        .map(([branchAddress, row]) => ({
          branchAddress,
          branchIndex: row.branchIndex,
          exports: row.exports,
        }))
        .sort((a, b) => a.branchIndex - b.branchIndex);
    },
    async cancelSubtrees(input) {
      const under = (address: string): boolean =>
        input.subtreeAddresses.some((p) => address === p || address.startsWith(`${p}.`));
      for (const address of [...parks.keys()]) {
        if (under(address) && address !== input.excludeLeaf) parks.delete(address);
      }
    },
  };
  /** The rows as they stand, for another run to start from. */
  const snapshot = () =>
    JSON.stringify({
      parks: [...parks],
      joins: [...joins].map(([k, v]) => [k, { ...v, decremented: [...v.decremented] }]),
      exports: [...exports].map(([k, v]) => [k, [...v]]),
    });
  const restore = (text: string): void => {
    const saved = JSON.parse(text) as {
      parks: Array<[string, { kind: 'timer' | 'await' | 'suspension'; state: AnyParkedScopeState }]>;
      joins: Array<[string, { pending: number; closedBy: string | null; decremented: string[] }]>;
      exports: Array<[string, Array<[string, { branchIndex: number; exports: unknown }]>]>;
    };
    for (const [k, v] of saved.parks) parks.set(k, v);
    for (const [k, v] of saved.joins) joins.set(k, { ...v, decremented: new Set(v.decremented) });
    for (const [k, v] of saved.exports) exports.set(k, new Map(v));
  };
  return { sink, parks, exports, snapshot, restore };
}

type Store = ReturnType<typeof makeStore>;

function fakeAttio(calls: unknown[]): Adapter {
  let minted = 0;
  return {
    adapterType: 'attio',
    supportedTriggers: [],
    runtimeCapabilities: () => ({
      traversal: { incoming: false, edgeProperties: false },
      resources: false,
    }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      const data = positionData(input.position);
      return isRecord(data) ? data[input.fieldId] : undefined;
    },
    getRelated: async () => [],
    async createRecord(input) {
      calls.push(['createRecord', input.recordType, input.fields]);
      minted += 1;
      return { adapterType: 'attio', externalId: `attio-${minted}`, data: { ...input.fields } };
    },
    async updateRecord(input) {
      calls.push(['updateRecord', input.externalId, input.fields]);
      return {
        adapterType: 'attio',
        externalId: input.externalId,
        data: { ...input.fields },
        association: containerAssociation(input),
      };
    },
    async deleteRecord(input) {
      calls.push(['deleteRecord', input]);
      return {};
    },
  };
}

function fakeEmail(): Adapter {
  return { ...fakeAttio([]), adapterType: 'email' };
}

async function runOn(c: Case) {
  const calls: unknown[] = [];
  const store = makeStore();
  if (c.store !== undefined) store.restore(c.store.snapshot());
  // Written once in the spelling versions 1–4 read; the run reads it as the upgrade tool respells it.
  const withFiles = c.files !== undefined ? { ...catalog, files: c.files } : catalog;
  const spell = (text: string) =>
    spelledFor(5, text, fromCatalogSnapshot(withFiles), {
      resolveFile: resolveFileFromSnapshot(withFiles),
    });
  const files =
    c.files === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(c.files).map(([name, file]) => [name, { source: spell(file.source) }]),
        );
  const snapshot = files !== undefined ? { ...catalog, files } : catalog;
  const attio = fakeAttio(calls);
  const email = fakeEmail();
  const input: RunMovementInput = {
    source: spell(PRELUDE + c.source),
    event: {
      pipelineInputId: 'pi-park-identity',
      adapterType: 'email',
      triggerType: 'webhook',
      payload: { subject: 'Acme', text: 'Acme raised.' },
    },
    teamId: TEAM_ID,
    catalog: snapshot,
    credentialIds: credentialIdsFor(snapshot, (name: string) => `cred-${name}`),
    firedAt: '2026-05-01T09:00:00.000Z',
    movementName: 'm',
    languageVersion: 5,
    host: makeTestHost({
      adapters: { resolve: (r) => (r.adapterType === 'attio' ? attio : email) },
      park: { sink: store.sink },
    }),
  };
  resetRustRunStats();
  let outcome: Record<string, unknown>;
  try {
    const result =
      c.resume !== undefined
        ? await resumeMovement({ ...input, state: c.resume.state, reenter: false })
        : await runMovement(input);
    outcome = {
      writes: result.writes.map((w) => [w.recordType, w.outcome, w.writtenValues]),
      parked: result.parked,
    };
  } catch (error) {
    outcome = { error: String(error), cause: String(runFailureCause(error)) };
  }
  // The parks this run wrote, and the branch exports, byte for byte.
  if (c.resume !== undefined) store.parks.delete(c.resume.address);
  const parked = JSON.stringify([...store.parks]);
  const exported = JSON.stringify([...store.exports].map(([frame, rows]) => [frame, [...rows]]));
  const stats = {
    segments: rustRunStats.segments,
    unsupported: { ...rustRunStats.unsupported },
    shimFaults: rustRunStats.shimFaults,
  };
  return {
    observed: JSON.stringify({ outcome, calls, parked, exported }),
    outcome,
    calls,
    parked,
    exported,
    store,
    stats,
  };
}

/** One segment on the Rust engine, run whole. */
async function onRust(c: Case) {
  const rust = await runOn(c);
  expect(rust.stats).toEqual({ segments: 1, unsupported: {}, shimFaults: 0 });
  return rust;
}

/**
 * Park on the Rust engine, then resume its state at `address` (the only
 * park, when not given). Returns the park's state and the resumed outcome.
 */
async function parkAndResume(
  c: Case,
  address?: string,
): Promise<{ state: string; resumed: ReturnType<typeof JSON.parse> }> {
  const parked = await onRust(c);
  const at = address ?? [...parked.store.parks.keys()][0];
  const state = parked.store.parks.get(at ?? '')?.state;
  if (at === undefined || !isParkedScopeState(state))
    throw new Error('the park writer left no parked scope state');
  const resumed = await onRust({ ...c, store: parked.store, resume: { address: at, state } });
  return { state: JSON.stringify(state), resumed: JSON.parse(resumed.observed) };
}

const movement = (...body: string[]) =>
  ['movement m(msg: <inbox-[:message]->>) {', ...body, '}'].join('\n');

describe('one write handle two names hold, across a park (B7)', () => {
  for (const [how, alias] of [
    ['b = a', '  b = a'],
    ['b = write a { … }', '  b = write a { name: "one" }'],
  ] as const) {
    it(`${how}: the write through 'a' after the resume is read through 'b'`, async () => {
      const { state, resumed } = await parkAndResume({
        source: movement(
          '  a = write crm-[:companies]-> { name: "one" }',
          alias,
          '  await sleep(1h)',
          '  write a { name: "two" }',
          '  write crm-[:notes]-> { body: b.name }',
        ),
      });
      expect(state).toContain('"kind":"handleRef"');
      expect(state).toContain('"id":0');
      expect(JSON.stringify(resumed.calls)).toContain('["createRecord","note",{"body":"two"}]');
    });
  }

  it("a record's @old and the handle that wrote it", async () => {
    const { state, resumed } = await parkAndResume({
      source: movement(
        '  a = write crm-[:companies]-> { name: "one" }',
        '  write a { name: "two" }',
        '  o = FIRST(a-[:@old]->)',
        '  p = FIRST(a-[:@old]->)',
        '  await sleep(1h)',
        '  write crm-[:notes]-> { body: CONCAT(o.name, "/", p.name, "/", a.name) }',
      ),
    });
    expect(state).toContain('"kind":"handleRef"');
    expect(JSON.stringify(resumed.calls)).toContain('{"body":"one/one/two"}');
  });

  it('a park holding each handle under one name writes no reference, as before', async () => {
    const { state } = await parkAndResume({
      source: movement(
        '  a = write crm-[:companies]-> { name: "one" }',
        '  await sleep(1h)',
        '  write crm-[:notes]-> { body: a.name }',
      ),
    });
    expect(state).not.toContain('handleRef');
    expect(state).not.toContain('"id"');
  });

  it('inside a branch that completes on the resume: its export is one park, #return first', async () => {
    // Arm 0 parks before its return; arm 1 completes. Arm 0 completing on
    // the resume writes its whole scope as its export. `parallel` is retired
    // from version 5, where `all` is the same join.
    const spelled = spelledForVersion5;
    const { resumed } = await parkAndResume({
      source: spelled(
        movement(
          '  r = await parallel([',
          '    () => {',
          '      a = write crm-[:companies]-> { name: "arm 0" }',
          '      b = a',
          '      n = node { body: "shared" }',
          '      k = n',
          '      await sleep(1h)',
          '      return b',
          '    },',
          '    () => {',
          '      return 2',
          '    }',
          '  ])',
          '  write crm-[:notes]-> { body: CONCAT("joined/", AT(r, 1)) }',
        ),
      ),
    });
    const exported = String(resumed.exported);
    expect(exported).toContain('"exports":{"#return":');
    expect(exported).toContain('"kind":"handleRef"');
    expect(exported).toContain('"kind":"nodeRef"');
    expect(JSON.stringify(resumed.calls)).toContain('{"body":"joined/2"}');
  });
});

describe('a library declaration parks with its file and is found there (B11)', () => {
  const files = {
    'lib/leads': {
      source: [
        'export node Lead {',
        '  name: <text>',
        '}',
        'export function is_lead(name: <text>): <boolean> {',
        '  check = (who: <text>) => {',
        '    n = node { name: who }',
        '    await sleep(1h)',
        '    if n IS <Lead> {',
        '      return true',
        '    }',
        '    return false',
        '  }',
        '  return check(name)',
        '}',
      ].join('\n'),
    },
  };

  it('a library shape, though the root declares one by the same name', async () => {
    const { state, resumed } = await parkAndResume({
      files,
      source: [
        'import { is_lead } from "lib/leads"',
        'node Lead {',
        '  name: <text>',
        '  stage: <text>',
        '}',
        movement('  x = is_lead(name: "Ada")', '  write crm-[:notes]-> { body: "${x}" }'),
      ].join('\n'),
    });
    expect(state).toContain('{"kind":"shape","name":"Lead","file":"lib/leads"}');
    expect(JSON.stringify(resumed.calls)).toContain('{"body":"true"}');
  });

  it('a library movement a closure holds, though the root declares one by the same name', async () => {
    const { state, resumed } = await parkAndResume({
      files: {
        'lib/notes': {
          source: [
            PRELUDE,
            'function stamp(t: <text>): <text> {',
            '  return CONCAT(t, "-lib")',
            '}',
            'export function noted(t: <text>): <text> {',
            '  k = (v: <text>) => stamp(v)',
            '  await sleep(1h)',
            '  return k(t)',
            '}',
          ].join('\n'),
        },
      },
      source: [
        'import { noted } from "lib/notes"',
        'function stamp(t: <text>): <text> {',
        '  return CONCAT(t, "-root")',
        '}',
        movement('  x = noted(t: "a")', '  write crm-[:notes]-> { body: x }'),
      ].join('\n'),
    });
    expect(state).toContain('{"kind":"movement","name":"stamp","file":"lib/notes"}');
    expect(JSON.stringify(resumed.calls)).toContain('{"body":"a-lib"}');
  });
});

describe('a file-level closure holds its file by reference and parks by name (B13)', () => {
  it('an earlier one calls a later one, parking inside it', async () => {
    const { state, resumed } = await parkAndResume({
      source: [
        'f = (n: <number>) => {',
        '  await sleep(1h)',
        '  return g(n) + 1',
        '}',
        'g = (n: <number>) => n * 10',
        movement('  x = f(1)', '  write crm-[:notes]-> { body: "${x}" }'),
      ].join('\n'),
    });
    expect(state).toContain('"g":{"kind":"fileClosure","name":"g"}');
    expect(state).not.toContain('"kind":"closure"');
    expect(JSON.stringify(resumed.calls)).toContain('{"body":"11"}');
  });

  it("a library's, captured by a body closure, names its library", async () => {
    const { state, resumed } = await parkAndResume({
      files: {
        'lib/leads': {
          source: [
            'double = (n: <number>) => n * 2',
            'export function twice(n: <number>): <number> {',
            '  k = (m: <number>) => double(m)',
            '  await sleep(1h)',
            '  return k(n) + 1',
            '}',
          ].join('\n'),
        },
      },
      source: [
        'import { twice } from "lib/leads"',
        movement('  x = twice(n: 4)', '  write crm-[:notes]-> { body: "${x}" }'),
      ].join('\n'),
    });
    expect(state).toContain('"double":{"kind":"fileClosure","name":"double","file":"lib/leads"}');
    expect(JSON.stringify(resumed.calls)).toContain('{"body":"9"}');
  });

  it('14 unused file-level closures park in about a kilobyte', async () => {
    const decls = Array.from({ length: 14 }, (_, i) => `h${i} = (v: <number>) => v + ${i}`).join(
      '\n',
    );
    const { state } = await parkAndResume({
      source: [decls, movement('  await sleep(1h)', '  write crm-[:notes]-> { body: "x" }')].join(
        '\n',
      ),
    });
    expect(state).toContain('"h13":{"kind":"fileClosure","name":"h13"}');
    expect(state.length).toBeLessThan(1500);
  });
});

describe('a parked state the engine cannot rebuild is refused loudly', () => {
  /** Resume `state` at its only park: the run fails with `message`. */
  async function refusedAlike(c: Case, state: string, message: string) {
    const parsed = JSON.parse(state) as AnyParkedScopeState;
    const rust = await runOn({ ...c, resume: { address: parsed.address, state: parsed } });
    expect(rust.outcome.error).toContain(message);
    expect(rust.stats).toMatchObject({ segments: 1, shimFaults: 0 });
  }

  it('a handle reference no descriptor in the state numbers', async () => {
    const c: Case = {
      source: movement(
        '  a = write crm-[:companies]-> { name: "one" }',
        '  b = a',
        '  await sleep(1h)',
        '  write crm-[:notes]-> { body: b.name }',
      ),
    };
    const { state } = await parkAndResume(c);
    expect(state).toContain('"id":0');
    await refusedAlike(
      c,
      state.replace('"id":0}', '"id":7}'),
      'refers to write handle(s) #0 that it never wrote',
    );
  });

  it('a library the re-parsed program does not link', async () => {
    const c: Case = {
      files: {
        'lib/leads': {
          source: [
            'export node Lead {',
            '  name: <text>',
            '}',
            'export function lead(name: <text>): <boolean> {',
            '  check = (who: <text>) => {',
            '    n = node { name: who }',
            '    await sleep(1h)',
            '    if n IS <Lead> {',
            '      return true',
            '    }',
            '    return false',
            '  }',
            '  return check(name)',
            '}',
          ].join('\n'),
        },
      },
      source: [
        'import { lead } from "lib/leads"',
        movement('  x = lead(name: "Ada")', '  write crm-[:notes]-> { body: "${x}" }'),
      ].join('\n'),
    };
    const { state } = await parkAndResume(c);
    expect(state).toContain('"file":"lib/leads"');
    await refusedAlike(
      c,
      state.replaceAll(
        '{"kind":"shape","name":"Lead","file":"lib/leads"}',
        '{"kind":"shape","name":"Lead","file":"lib/gone"}',
      ),
      'resume: the parked state names the library "lib/gone", which the re-parsed program does not link',
    );
  });

  it('a file-level function the re-parsed program binds to something else', async () => {
    const parkedOn = (h0: string): Case => ({
      source: [
        h0,
        movement('  g = h0', '  await sleep(1h)', '  write crm-[:notes]-> { body: "x" }'),
      ].join('\n'),
    });
    const { state } = await parkAndResume(parkedOn('h0 = (v: <number>) => v + 1'));
    expect(state).toContain('"g":{"kind":"fileClosure","name":"h0"}');
    await refusedAlike(
      parkedOn('h0 = 5'),
      state,
      "resume: 'h0' parked as a file-level function, and the re-parsed program binds it to something else",
    );
  });
});

// R1 (main's B7 regression): the movement scope rides on BOTH the leaf's chain
// and the frame of a call the park is inside. The writer walks the leaf's
// chain first, so a handle (or node) held there is written in full in the
// leaf's copy and as a reference in the frame's, and the reader rebuilds the
// movement scope from the frame's: a reference is read before its descriptor.
// Each reader indexes every numbered descriptor in the whole state by the
// descriptor's STRUCTURE first, so a variable named like a code-tree member
// of a descriptor (`body`, `position`, `fields`, …) resumes too.
describe('a reference read before its descriptor, and names like a descriptor member (R1)', () => {
  const closure = ['  f = (x: <text>) => {', '    await sleep(1h)', '    return x', '  }'];
  const names = [
    'a',
    'op',
    'body',
    'closure',
    'head',
    'mapping',
    'fields',
    'fieldProvenance',
    'position',
    'declaration',
  ];

  for (const name of names) {
    it(`a handle named '${name}', parked inside a closure's call`, async () => {
      const { state, resumed } = await parkAndResume({
        source: movement(
          `  ${name} = write crm-[:companies]-> { name: "one" }`,
          ...closure,
          '  y = f("q")',
          `  write crm-[:notes]-> { body: CONCAT(y, "/", ${name}.name) }`,
        ),
      });
      expect(JSON.stringify((JSON.parse(state) as AnyParkedScopeState).frames)).toContain(
        '"kind":"handleRef"',
      );
      expect(JSON.stringify(resumed.calls)).toContain('{"body":"q/one"}');
    });

    it(`a run-built node named '${name}', parked inside a closure's call`, async () => {
      const { state, resumed } = await parkAndResume({
        source: movement(
          `  ${name} = node { name: "one" }`,
          ...closure,
          '  y = f("q")',
          `  write crm-[:notes]-> { body: CONCAT(y, "/", ${name}.name) }`,
        ),
      });
      expect(JSON.stringify((JSON.parse(state) as AnyParkedScopeState).frames)).toContain(
        '"kind":"nodeRef"',
      );
      expect(JSON.stringify(resumed.calls)).toContain('{"body":"q/one"}');
    });
  }

  it(`variables named head and captured (a kept walk's members), parked`, async () => {
    const { resumed } = await parkAndResume({
      source: movement(
        '  head = "h"',
        '  captured = "c"',
        '  await sleep(1h)',
        '  write crm-[:notes]-> { body: CONCAT(head, "/", captured) }',
      ),
    });
    expect(JSON.stringify(resumed.calls)).toContain('{"body":"h/c"}');
  });

  it(`a closure capturing head and captured, parked inside its call`, async () => {
    const { resumed } = await parkAndResume({
      source: movement(
        '  head = "h"',
        '  captured = "c"',
        '  g = (x: <text>) => {',
        '    await sleep(1h)',
        '    return CONCAT(x, head, captured)',
        '  }',
        '  y = g("q")',
        '  write crm-[:notes]-> { body: y }',
      ),
    });
    expect(JSON.stringify(resumed.calls)).toContain('{"body":"qhc"}');
  });

  for (const name of [
    'op',
    'body',
    'closure',
    'head',
    'mapping',
    'fields',
    'fieldProvenance',
    'position',
  ]) {
    it(`a closure bound as '${name}' and a text beside it, parked inside the closure's call`, async () => {
      const { resumed } = await parkAndResume({
        source: movement(
          `  ${name} = (x: <text>) => {`,
          '    await sleep(1h)',
          '    return x',
          '  }',
          '  captured = "c"',
          `  y = ${name}("q")`,
          '  write crm-[:notes]-> { body: CONCAT(y, "/", captured) }',
        ),
      });
      expect(JSON.stringify(resumed.calls)).toContain('{"body":"q/c"}');
    });
  }

  it(`a second name and a closure's capture of a handle bound as 'body' come back as one handle`, async () => {
    const { resumed } = await parkAndResume({
      source: movement(
        '  body = write crm-[:companies]-> { name: "one" }',
        '  b = body',
        '  f = (x: <text>) => {',
        '    await sleep(1h)',
        '    return CONCAT(x, "/", b.name)',
        '  }',
        '  y = f("q")',
        '  write body { name: "two" }',
        '  write crm-[:notes]-> { body: CONCAT(y, "/", b.name) }',
      ),
    });
    expect(JSON.stringify(resumed.calls)).toContain('{"body":"q/one/two"}');
  });

  it(`a handle's record before its write, read through a reference first`, async () => {
    const { resumed } = await parkAndResume({
      source: movement(
        '  a = write crm-[:companies]-> { name: "one" }',
        '  write a { name: "two" }',
        ...closure,
        '  y = f("q")',
        '  o = FIRST(a-[:@old]->)',
        '  write crm-[:notes]-> { body: CONCAT(y, "/", o.name, "/", a.name) }',
      ),
    });
    expect(JSON.stringify(resumed.calls)).toContain('{"body":"q/one/two"}');
  });
});

// B16: an `all` receipt's slot holding the record an arm handed back: from
// version 5 `AT(r, i)` reads that record, as it does off a list literal.
describe("a combinator receipt's record slot (B16)", () => {
  const arms = (park: boolean) => [
    '  r = all(',
    '    () => {',
    '      a = write crm-[:companies]-> { name: "arm 0" }',
    ...(park ? ['      await sleep(1h)'] : []),
    '      return a',
    '    },',
    '    () => 2',
    '  )',
    '  h = AT(r, 0)',
    '  write crm-[:notes]-> { body: CONCAT(COALESCE(AT(r, 0).name, "none"), "/", COALESCE(h.name, "none"), "/", IF AT(r, 0) == null THEN "missing" ELSE "held" END, "/", AT(r, 1)) }',
  ];
  const expected = '{"body":"arm 0/arm 0/held/2"}';

  it('no park', async () => {
    const rust = await onRust({ source: movement(...arms(false)) });
    expect(JSON.stringify(rust.calls)).toContain(expected);
  });

  it('the arm parked before its return', async () => {
    const { resumed } = await parkAndResume({ source: movement(...arms(true)) });
    expect(JSON.stringify(resumed.calls)).toContain(expected);
  });
});
