// Landing types GENERIC OVER THE CONSTRUCTION SITE, checker side
// (asks-as-adapter layer 5, chunk B).
//
// The checker DECIDES nothing here, mirroring `refineSelected`: the host
// synthesized a position for the literals one write authored and registered it
// under `genericLandingKey`; the checker derives the same key from the same
// body and retargets the edge's landing. So this fixture hand-registers the
// graft, exactly as the host would.
//
// DELIBERATELY NOT THE ASK ADAPTER. A fixture matching one adapter's shape
// cannot tell derived from hardcoded, and the ask's own shape is covered
// end-to-end (through the REAL adapter, the REAL projection and the REAL host
// pre-pass) in
// `apps/api/.../movement/__test__/generic_landings.unit.test.ts`. This one is a
// polling adapter with two generic edges — one over free-text options (dynamic
// options are legitimate), one over a closed set that must be literal.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { genericLandingKey, genericLandingName } from '../generics';
import { fromCatalogSnapshot, type CatalogSnapshot } from '../../service/snapshot';
import type { InstanceSchema } from '../catalog';

const CHOICES = ['Seed', 'Series A'];
const POLL_RESULT = 'Poll Result';
const RATING_RESULT = 'Rating Result';

const pollLandingName = genericLandingName({ target: POLL_RESULT, values: CHOICES });
const ratingLandingName = genericLandingName({ target: RATING_RESULT, values: ['number'] });

/** The awaitable, resolvesEmpty promise both families carry — same shape as the
 *  ask `Response` edge, so the `maybe-absent` composition is exercised too. */
const promise = (target: string, genericOver: { field: string; onNonLiteral?: 'error' | 'warn' }) => ({
  target,
  awaitable: true, watchable: true,
  resolvesEmpty: true,
  readable: false,
  genericOver,
});

const schema: InstanceSchema = {
  positions: {
    // The BASE landings — what an ask whose parameter we can't see gets.
    [POLL_RESULT]: { properties: { Answer: 'text' }, edges: {} },
    [RATING_RESULT]: { properties: { Answer: 'text' }, edges: {} },
    // …and what the host synthesized for the one construction site below.
    [pollLandingName]: {
      properties: { Answer: { kind: 'enum', options: CHOICES } },
      edges: {},
    },
    [ratingLandingName]: { properties: { Answer: 'number' }, edges: {} },
  },
  collections: { Poll: { target: 'Poll' }, Rating: { target: 'Rating' } },
  writableRoots: {
    Poll: {
      fields: { Question: 'text', Choices: { kind: 'list', of: 'text' } },
      requiredFields: ['Question'],
      resultShape: { externalId: 'text', url: 'text' },
      edges: { Result: promise(POLL_RESULT, { field: 'Choices' }) },
    },
    Rating: {
      fields: { Question: 'text', Scale: { kind: 'enum', options: ['number', 'text'] } },
      requiredFields: ['Question'],
      resultShape: { externalId: 'text', url: 'text' },
      edges: { Result: promise(RATING_RESULT, { field: 'Scale', onNonLiteral: 'error' }) },
    },
  },
  genericLandings: {
    [genericLandingKey({ target: POLL_RESULT, values: CHOICES })]: pollLandingName,
    [genericLandingKey({ target: RATING_RESULT, values: ['number'] })]: ratingLandingName,
  },
};

const snapshot: CatalogSnapshot = {
  adapters: {
    polls: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schemas: { probe: schema },
    },
  },
  credentials: { probe: { adapters: ['polls'] } },
  plugins: {},
};

const PRELUDE = `import { polls } from adapters
import { probe } from credentials

p = polls(credentials: probe)
`;

const diagnosticsFor = (body: string): Diagnostic[] =>
  checkProgram(
    parseProgram(`${PRELUDE}\nmovement m() {\n${body}\n}`),
    fromCatalogSnapshot(snapshot),
  ).filter((d) => (d.severity ?? 'error') === 'error');

const codesFor = (body: string): string[] => diagnosticsFor(body).map((d) => d.code);

/** `await` the promise off a write and read its answer. The landing is
 *  `resolvesEmpty`, so the answer is `T | absent` — which equality tolerates
 *  (layer 6), leaving the enum diagnostics below as the only thing a comparison
 *  can say. */
const awaited = (write: string) => `  a = write ${write}\n  r = await FIRST(a-[:Result]->)`;
const LITERAL_POLL = 'p-[:Poll]-> { Question: "Round?", Choices: ["Seed", "Series A"] }';

describe('a landing generic over its construction site (checker)', () => {
  it('a LITERAL parameter retargets the landing to the position the host synthesized', () => {
    // Reading the specialized landing is clean…
    expect(codesFor(`${awaited(LITERAL_POLL)}\n  if r.Answer { }`)).toEqual([]);
    // …and `Answer` is the enum of the very choices this poll offered, so a
    // member draws no enum complaint.
    expect(codesFor(`${awaited(LITERAL_POLL)}\n  if r.Answer == "Seed" { }`)).not.toContain(
      'MOV_ENUM_UNKNOWN_VALUE',
    );
  });

  it('…and a NON-member is the ordinary enum error, with a did-you-mean', () => {
    const errors = diagnosticsFor(`${awaited(LITERAL_POLL)}\n  if r.Answer == "Sead" { }`);
    const enumError = errors.find((d) => d.code === 'MOV_ENUM_UNKNOWN_VALUE');
    expect(enumError).toBeDefined();
    expect(enumError?.message).toContain('Did you mean "Seed"?');
  });

  it('a NON-LITERAL parameter keeps the base landing, silently (computed options are legitimate)', () => {
    // Nothing said about the options, and the answer is honestly plain text —
    // so a value that is in no enum draws no enum complaint either.
    const codes = codesFor(
      `  choices = "Seed"\n${awaited('p-[:Poll]-> { Question: "Round?", Choices: [choices] }')}\n  if r.Answer == "anything at all" { }`,
    );
    expect(codes).not.toContain('MOV_ENUM_UNKNOWN_VALUE');
    expect(codes).not.toContain('MOV_WRITE_GENERIC_NOT_LITERAL');
  });

  it('a non-literal parameter the adapter declared LITERAL-REQUIRED is loud', () => {
    const errors = diagnosticsFor(
      `  s = "number"\n  a = write p-[:Rating]-> { Question: "How bad?", Scale: s }`,
    );
    const notLiteral = errors.find((d) => d.code === 'MOV_WRITE_GENERIC_NOT_LITERAL');
    expect(notLiteral).toBeDefined();
    // Names the field, the edge whose type it fixes, and a value it will take.
    expect(notLiteral?.message).toContain("'Scale'");
    expect(notLiteral?.message).toContain('-[:Result]->');
    expect(notLiteral?.message).toContain('Scale: "number"');
  });

  it('the literal-required parameter, given a literal, retypes the answer (text → number)', () => {
    const RATING = 'p-[:Rating]-> { Question: "How bad?", Scale: "number" }';
    // Reading it is clean; comparing it to TEXT is the category mismatch, which
    // is the proof the landing really is the number one.
    expect(codesFor(`${awaited(RATING)}\n  if r.Answer { }`)).toEqual([]);
    expect(codesFor(`${awaited(RATING)}\n  if r.Answer == "high" { }`)).toContain(
      'MOV_COMPARE_TYPE_MISMATCH',
    );
  });

  it('a landing NOBODY registered stays the base type — the checker never invents one', () => {
    // Literal choices, but not the ones the host resolved: no key, no retarget,
    // and the base `text` answer accepts any literal.
    expect(
      codesFor(
        `${awaited('p-[:Poll]-> { Question: "Round?", Choices: ["Bridge"] }')}\n  if r.Answer == "whatever" { }`,
      ),
    ).not.toContain('MOV_ENUM_UNKNOWN_VALUE');
  });

  it('resolvesEmpty still wraps the SPECIALIZED landing — absence composes over the enum', () => {
    // No guard: the awaited answer is `enum | absent`, and using it where a
    // present value is required is the same F19 error it is for any landing.
    expect(
      codesFor(
        `  a = write p-[:Poll]-> { Question: "Round?", Choices: ["Seed", "Series A"] }\n  r = await FIRST(a-[:Result]->)\n  write p-[:Poll]-> { Question: r.Answer }`,
      ),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('…and an `==` against a member is the guard — the arm reads the enum, present', () => {
    // Layer 6: comparison IS the handling, and the true branch discharges the
    // absence, so the very write that errored above is clean inside the arm.
    expect(
      codesFor(
        `${awaited(LITERAL_POLL)}\n  if r.Answer == "Seed" { write p-[:Poll]-> { Question: r.Answer } }`,
      ),
    ).toEqual([]);
  });

  it('a comparison against a NON-member says only the enum thing — no absence noise', () => {
    // The point of the layer: one diagnostic, about the typo, not two.
    expect(codesFor(`${awaited(LITERAL_POLL)}\n  if r.Answer == "Sead" { }`)).toEqual([
      'MOV_ENUM_UNKNOWN_VALUE',
    ]);
  });
});

describe('genericLandingKey — the token both sides derive', () => {
  it('is the same for the same base type and the same values', () => {
    expect(genericLandingKey({ target: POLL_RESULT, values: ['a', 'b'] })).toEqual(
      genericLandingKey({ target: POLL_RESULT, values: ['a', 'b'] }),
    );
  });

  it('is ORDER-SENSITIVE — the values become an ordered option list, so a reorder is a different type', () => {
    expect(genericLandingKey({ target: POLL_RESULT, values: ['a', 'b'] })).not.toEqual(
      genericLandingKey({ target: POLL_RESULT, values: ['b', 'a'] })
    );
  });

  it('separates the base types it specializes', () => {
    expect(genericLandingKey({ target: POLL_RESULT, values: ['a'] })).not.toEqual(
      genericLandingKey({ target: RATING_RESULT, values: ['a'] }),
    );
  });

  it('cannot collide with the other opaque keys sharing the positions namespace', () => {
    // Only ever COMPARED, never parsed — the tag is what keeps three key
    // families out of one string.
    expect(genericLandingKey({ target: POLL_RESULT, values: ['a'] })).toContain('generic-landing');
  });
});
