// Checker coverage for the `await` primitive + the awaitable edge capability
// (asks-as-adapter chunk B). movement-lang's own jest is broken locally, so the
// language layer is exercised through apps/api's ts-jest (per repo memory).
//
// GENERIC/SYNTHETIC catalog — exercises the checker's await mechanics in the
// abstract (a family position with an AWAITABLE `Response` edge,
// readable:false + resolvesEmpty, landing on a `Response` node with an
// `Answer` field; plus an ordinary `Owner` edge for the non-awaitable case).
// It does NOT mirror the real ask adapter's schema: since chunk A
// (plans/slack-blocks-json-fields-2026-07-30/5_response_types.md) the real
// adapter mints a PER-FAMILY Response type (`Check Response`, `Draft
// Response`, …), not one shared `Response`. That real, per-family shape is
// covered end-to-end in `ask/__test__/awaited_landing_fieldcheck.unit.test.ts`
// (runs the REAL adapter through the REAL projection); this fixture stays a
// single generic `Response` on purpose, to keep the await-mechanics coverage
// independent of any one adapter's shape.
//
// Spelling: since the condition algebra (layer 13,
// plans/2026-06-10-data-movement-language/13) the parked read is
// `await FIRST(<walk>)` — bare `await <walk>` is retired
// (MOV_AWAIT_BARE_WALK). The retirement itself is pinned in movement-lang's
// checker/__test__/await_first.unit.test.ts; here we use the live spelling.

import {
  parseProgram,
  checkProgram,
  fromCatalogSnapshot,
  type CatalogSnapshot,
  type InstanceSchema,
} from 'movement-lang';

const askSchema: InstanceSchema = {
  positions: {
    Check: {
      properties: { Prompt: 'text', Url: 'text', State: 'text' },
      edges: {
        // The whole point: an awaitable, resolvesEmpty, non-readable promise —
        // and one the platform announces, so a bare `await` needs no cadence.
        Response: {
          target: 'Response',
          awaitable: true,
          watchable: true,
          resolvesEmpty: true,
          readable: false,
          writable: false,
        },
        // An ordinary readable edge — the `await`-a-non-awaitable case.
        Owner: { target: 'Person' },
      },
    },
    Response: { properties: { Answer: 'text' }, edges: {} },
    Person: { properties: { name: 'text' }, edges: {} },
  },
  collections: { Check: { target: 'Check' } },
  writableRoots: {
    Check: {
      fields: { Prompt: 'text' },
      resultShape: { externalId: 'text', url: 'text' },
    },
  },
};

const snapshot: CatalogSnapshot = {
  adapters: {
    questions: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schemas: { probe: askSchema },
    },
  },
  credentials: { probe: { adapters: ['questions'] } },
  plugins: {},
};

const PRELUDE = `import { questions } from adapters
import { probe } from credentials

qa = connect questions using probe
`;

const codesFor = (body: string): string[] =>
  checkProgram(parseProgram(`${PRELUDE}\nfunction m() {\n${body}\n}`), fromCatalogSnapshot(snapshot))
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => d.code);

const errorsFor = (body: string) =>
  checkProgram(
    parseProgram(`${PRELUDE}\nfunction m() {\n${body}\n}`),
    fromCatalogSnapshot(snapshot),
  ).filter((d) => (d.severity ?? 'error') === 'error');

describe('await + the awaitable edge capability (checker)', () => {
  it('a BARE traversal of an awaitable edge is MOV_AWAIT_REQUIRED with a did-you-mean', () => {
    const errors = errorsFor(`  a = write qa-[:Check]-> { Prompt: "Ship it?" }\n  a-[:Response]-> { }`);
    expect(errors.map((d) => d.code)).toContain('MOV_AWAIT_REQUIRED');
    const msg = errors.find((d) => d.code === 'MOV_AWAIT_REQUIRED')?.message ?? '';
    expect(msg).toContain('await');
  });

  it('awaiting a NON-awaitable edge is MOV_AWAIT_NOT_AWAITABLE', () => {
    const codes = codesFor(`  a = write qa-[:Check]-> { Prompt: "Ship it?" }\n  o = await FIRST(a-[:Owner]->)`);
    expect(codes).toContain('MOV_AWAIT_NOT_AWAITABLE');
  });

  it('awaiting an awaitable edge is clean, and the landed node reads its declared field', () => {
    const codes = codesFor(
      `  a = write qa-[:Check]-> { Prompt: "Ship it?" }\n  r = await first(a-[:Response]->)\n  if (r.Answer) { }`,
    );
    expect(codes).toEqual([]);
  });

  it('an UNKNOWN field on the landed node is refused (checked like any position)', () => {
    const codes = codesFor(
      `  a = write qa-[:Check]-> { Prompt: "Ship it?" }\n  r = await FIRST(a-[:Response]->)\n  if r.nope { }`,
    );
    expect(codes).toContain('MOV_UNKNOWN_PROPERTY');
  });

  it('an IMPURE WHERE on an awaited edge is MOV_AWAIT_IMPURE_WHERE', () => {
    const codes = codesFor(
      `  a = write qa-[:Check]-> { Prompt: "Ship it?" }\n  r = await FIRST(a-[:Response WHERE AI("looks approved") == "yes"]->)`,
    );
    expect(codes).toContain('MOV_AWAIT_IMPURE_WHERE');
  });

  it('a PURE WHERE on an awaited edge is accepted', () => {
    const codes = codesFor(
      `  a = write qa-[:Check]-> { Prompt: "Ship it?" }\n  r = await first(a-[r2:Response WHERE r2.\`Answer\` == "yes"]->)`,
    );
    expect(codes).toEqual([]);
  });

  it('the unbound statement form also type-checks', () => {
    const codes = codesFor(`  a = write qa-[:Check]-> { Prompt: "Ship it?" }\n  await first(a-[:Response]->)`);
    expect(codes).toEqual([]);
  });

  it('await sleep(<duration>) is accepted; a malformed duration is MOV_AWAIT_BAD_DURATION', () => {
    expect(codesFor(`  await sleep(2d)`)).toEqual([]);
    expect(codesFor(`  x = await sleep(2d)`)).toEqual([]);
    expect(codesFor(`  await sleep(2x)`)).toContain('MOV_AWAIT_BAD_DURATION');
  });

  it('the retired `sleep <duration>` STATEMENT no longer parses — only `await sleep(…)` does', () => {
    expect(() => parseProgram(`${PRELUDE}\nfunction m() {\n  sleep 2d\n}`)).toThrow(
      /sleep.*replaced.*await it as an expression/s,
    );
  });
});
