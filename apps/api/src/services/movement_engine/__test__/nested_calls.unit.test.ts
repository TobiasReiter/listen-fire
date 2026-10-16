// Calls nested in expressions through the REAL interpreter (language version
// 3; movement-lang checker/nested_calls.ts): a function's call, a collection
// op and a closure are values inside any expression, evaluated in the order
// the text states them, and `IF` / `AND` / `OR` / `COALESCE` never reach an
// operand they do not need — so a write in an arm that is not taken never
// happens. Every proof is what reaches the adapter, in the order it arrived.

import type { InstanceSchema, LanguageVersion } from 'movement-lang';
import { runMovement } from 'movement-engine/services/movement_engine/run';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import type { Adapter, RuntimeCapabilities, WriteInput } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { tenantIdOf } from 'engine-contracts';
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { makeTestHost } from 'movement-engine/services/movement_engine/test_host';
import { teamOfTenant } from '../../translation_graph/movement/tenant';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000047');
const KG = 'kg';

const manualAdapter = createManualAdapter({ teamId: teamOfTenant(TEAM_ID) });

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: false, edgeProperties: false }, resources: false };
}

/** A KG fake that records every note it is asked to create, in order. */
function makeKgFake() {
  const creates: WriteInput[] = [];
  const adapter: Adapter = {
    adapterType: KG,
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue() {
      return null;
    },
    async getRelated() {
      return [];
    },
    async createRecord(write) {
      creates.push(write);
      return { adapterType: KG, externalId: `new-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      return { adapterType: KG, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

const kgSchema: InstanceSchema = {
  positions: { note: { properties: { body: 'text', payload: 'json' }, edges: {} } },
  collections: { note: { target: 'note' } },
  writableRoots: {
    note: { fields: { body: 'text', payload: 'json' }, resultShape: { externalId: 'text' } },
  },
};

const catalog = staticCatalogSnapshot({
  credentials: { kg_cred: { adapters: ['kg'] } },
  instanceSchemas: { kg: kgSchema },
});

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:manual-nested',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: new Date().toISOString() },
    occurredAt: new Date().toISOString(),
  };
}

const PRELUDE = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = connect manual
graph = connect kg using kg_cred
`;

/** A function with an effect anyone can see: it writes a note, then hands
 *  back what it wrote. */
const PRELUDE_V4 = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
`;

const MARK_V4 = `movement mark(t: <text>) {
  write graph-[:note]-> { body: t }
  return t
}
movement double(n: <number>) {
  return n * 2
}
`;

const MARK = `function mark(t: <text>) {
  write graph-[:note]-> { body: t }
  return t
}
function double(n: <number>) {
  return n * 2
}
`;

async function runBody(body: string, options: { languageVersion?: LanguageVersion; fileLevel?: string } = {}) {
  const kg = makeKgFake();
  const v4 = options.languageVersion !== undefined && options.languageVersion < 5;
  const source = `${v4 ? PRELUDE_V4 : PRELUDE}${options.fileLevel ?? (v4 ? MARK_V4 : MARK)}${v4 ? 'movement' : 'function'} recap(go: <runs-[:Invocation]->>) {
${body}
}
listen to runs {} fire recap
`;
  await runMovement({
    source,
    event: manualEvent(),
    teamId: TEAM_ID,
    catalog,
    movementName: 'recap',
    host: makeTestHost({
      adapters: {
        resolve: ({ adapterType }: { adapterType: string }) => {
          if (adapterType === 'manual') return manualAdapter;
          if (adapterType === KG) return kg.adapter;
          throw new Error(`test: no fake adapter for '${adapterType}'`);
        },
      },
    }),
    dryRun: false,
    ...(options.languageVersion !== undefined ? { languageVersion: options.languageVersion } : {}),
  });
  return kg.creates;
}

const bodies = (creates: WriteInput[]): unknown[] => creates.map((c) => c.fields.body);
const payload = (creates: WriteInput[]): unknown => creates[creates.length - 1]?.fields.payload;

describe('a nested call is the value it returns', () => {
  it("a function's call inside arithmetic", async () => {
    const creates = await runBody('  write graph-[:note]-> { payload: { v: double(3) + 1 } }');
    expect(payload(creates)).toEqual({ v: 7 });
  });

  it('a function call nested in a function call, and a read off the value', async () => {
    const creates = await runBody('  write graph-[:note]-> { payload: { v: double(double(2)) - 1 } }');
    expect(payload(creates)).toEqual({ v: 7 });
  });

  it('a collection op inside an expression, and one inside another', async () => {
    const creates = await runBody(
      [
        '  n = count(map([1, 2, 3], (v) => v * 2)) + 1',
        '  twice = map(map([1, 2], (v) => v + 1), (v) => v * 10)',
        '  shout = Text.join(map(["a", "b"], (t) => Text.upper(t)), ",")',
        '  write graph-[:note]-> { payload: { n: n, twice: twice, shout: shout } }',
      ].join('\n'),
    );
    expect(payload(creates)).toEqual({ n: 4, twice: [20, 30], shout: 'A,B' });
  });

  it('a closure bound to a name is a value, passed to the op that calls it', async () => {
    const creates = await runBody(
      [
        '  inc = (v: <number>) => v + 1',
        '  write graph-[:note]-> { payload: { v: map([1, 2], inc) } }',
      ].join('\n'),
    );
    expect(payload(creates)).toEqual({ v: [2, 3] });
  });

  it('a nested call in a condition', async () => {
    const creates = await runBody(
      [
        '  if (double(2) == 4 && count(map([1], (v) => v)) == 1) {',
        '    write graph-[:note]-> { body: "taken" }',
        '  }',
      ].join('\n'),
    );
    expect(bodies(creates)).toEqual(['taken']);
  });
});

describe('effects run in the order the text states them', () => {
  it('left to right across operands', async () => {
    const creates = await runBody('  x = Text.concat(mark("a"), mark("b"), mark("c"))\n  write graph-[:note]-> { body: x }');
    expect(bodies(creates)).toEqual(['a', 'b', 'c', 'abc']);
  });

  it("a call's arguments before its body", async () => {
    const creates = await runBody('  x = Text.upper(mark(mark("inner")))');
    expect(bodies(creates)).toEqual(['inner', 'inner']);
  });

  it('a nested call in a write field runs before the write it feeds', async () => {
    const creates = await runBody('  write graph-[:note]-> { body: Text.concat(mark("first"), "!") }');
    expect(bodies(creates)).toEqual(['first', 'first!']);
  });

  it('writes inside a nested MAP land member by member', async () => {
    const creates = await runBody(
      '  n = count(map(["x", "y"], (t) => mark(t))) + 0\n  write graph-[:note]-> { payload: { n: n } }',
    );
    expect(bodies(creates).slice(0, 2)).toEqual(['x', 'y']);
    expect(payload(creates)).toEqual({ n: 2 });
  });
});

describe('IF, AND, OR and COALESCE never reach an operand they do not need', () => {
  it('an arm not taken never runs, so its write never happens', async () => {
    const creates = await runBody(
      [
        '  a = 1 > 2 ? mark("then") : "else"',
        '  b = 1 > 2 && mark("and") == "and"',
        '  c = 1 < 2 || mark("or") == "or"',
        '  d = coalesce("here", mark("coalesce"))',
        '  write graph-[:note]-> { payload: { a: a, b: b, c: c, d: d } }',
      ].join('\n'),
    );
    expect(bodies(creates)).toEqual([undefined]);
    expect(payload(creates)).toEqual({ a: 'else', b: false, c: true, d: 'here' });
  });

  it('an arm that is taken runs, once', async () => {
    const creates = await runBody(
      [
        '  a = 1 < 2 ? mark("then") : mark("else")',
        '  b = 1 < 2 && mark("and") == "and"',
        '  c = 1 > 2 || mark("or") == "or"',
        '  d = coalesce(null, mark("coalesce"))',
      ].join('\n'),
    );
    expect(bodies(creates)).toEqual(['then', 'and', 'or', 'coalesce']);
  });

  it('COALESCE stops at the first present value, so a later failure is never raised', async () => {
    const creates = await runBody('  x = coalesce("a", only([1, 2]))\n  write graph-[:note]-> { body: x }');
    expect(bodies(creates)).toEqual(['a']);
  });

  it('before version 3 COALESCE evaluated every argument first — unchanged', async () => {
    const v2 = `${PRELUDE_V4}movement recap(go: <runs-[:Invocation]->>) {
  x = COALESCE("a", ONLY([1, 2]))
  write graph-[:note]-> { body: x }
}
listen to runs {} fire recap
`;
    const kg = makeKgFake();
    await expect(
      runMovement({
        source: v2,
        event: manualEvent(),
        teamId: TEAM_ID,
        catalog,
        host: makeTestHost({
          adapters: {
            resolve: ({ adapterType }: { adapterType: string }) =>
              adapterType === 'manual' ? manualAdapter : kg.adapter,
          },
        }),
        dryRun: false,
        languageVersion: 2,
      }),
    ).rejects.toThrow(/exactly one/);
    expect(kg.creates).toEqual([]);
  });
});

describe('a function name is the same name in any letter case', () => {
  it('a listener firing the movement in another case runs it', async () => {
    const kg = makeKgFake();
    await runMovement({
      source: `${PRELUDE_V4}movement recap(go: <runs-[:Invocation]->>) {
  write graph-[:note]-> { body: "ran" }
}
listen to runs {} fire RECAP
`,
      event: manualEvent(),
      teamId: TEAM_ID,
      catalog,
      movementName: 'RECAP',
      host: makeTestHost({
        adapters: {
          resolve: ({ adapterType }: { adapterType: string }) =>
            adapterType === 'manual' ? manualAdapter : kg.adapter,
        },
      }),
      dryRun: false,
      // Version 5 reads names exactly; letter-case folding is a version 1–4 rule.
      languageVersion: 4,
    });
    expect(bodies(kg.creates)).toEqual(['ran']);
  });
});

describe('a closure bound to a name is called like any function', () => {
  it('its value is what its body returns — bound, nested, by name, in any letter case', async () => {
    const creates = await runBody(
      [
        '  inc = (v: <number>) => v + 1',
        '  a = inc(2)',
        '  b = inc(2) * 10',
        '  c = double(INC(inc(1)))',
        '  write graph-[:note]-> { payload: { a: a, b: b, c: c } }',
      ].join('\n'),
      // Version 5 reads names exactly; letter-case folding is a version 1–4 rule.
      { languageVersion: 4 },
    );
    expect(payload(creates)).toEqual({ a: 3, b: 30, c: 6 });
  });

  it('its body sees the scope it was written in', async () => {
    const creates = await runBody(
      ['  base = 10', '  add = (v: <number>) => v + base', '  write graph-[:note]-> { payload: { v: add(1) } }'].join(
        '\n',
      ),
    );
    expect(payload(creates)).toEqual({ v: 11 });
  });

  it('on its own line it runs for its effects; its arguments run first, left to right', async () => {
    const creates = await runBody(
      [
        '  note = (a: <text>, b: <text>) => {',
        '    write graph-[:note]-> { body: Text.concat(a, b) }',
        '  }',
        '  note(mark("a"), mark("b"))',
      ].join('\n'),
    );
    expect(bodies(creates)).toEqual(['a', 'b', 'ab']);
  });

  it('nested in an arm that is not taken, it never runs', async () => {
    const creates = await runBody(
      [
        '  loud = (t: <text>) => mark(t)',
        '  x = 1 > 2 ? loud("then") : "else"',
        '  write graph-[:note]-> { body: x }',
      ].join('\n'),
    );
    expect(bodies(creates)).toEqual(['else']);
  });

  it('before version 3 a closure is not called — the run is refused', async () => {
    const v2 = `${PRELUDE_V4}movement recap(go: <runs-[:Invocation]->>) {
  one = () => {
    return 1
  }
  one()
}
listen to runs {} fire recap
`;
    const kg = makeKgFake();
    await expect(
      runMovement({
        source: v2,
        event: manualEvent(),
        teamId: TEAM_ID,
        catalog,
        host: makeTestHost({
          adapters: {
            resolve: ({ adapterType }: { adapterType: string }) =>
              adapterType === 'manual' ? manualAdapter : kg.adapter,
          },
        }),
        dryRun: false,
        languageVersion: 2,
      }),
    ).rejects.toThrow(/MOV_CALL_NOT_MOVEMENT/);
  });
});
