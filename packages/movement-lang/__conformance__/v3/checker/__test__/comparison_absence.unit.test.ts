// Comparison and absence (slack-blocks-json-fields layer 6).
//
// The TS model, adopted: comparing `T | absent` against a present value is
// LEGAL — absent is simply never equal (the engine's `left === right`) — and in
// the true branch of an `==` the value is PRESENT, so the comparison joins `?:`
// fill and traversal-as-gate as a guard form. ORDERING keeps requiring a present
// value, mirroring TS's error on `x < 3` for `x: number | undefined`.
//
// TWO adapter shapes, deliberately: a fixture matching one adapter cannot tell
// derived from hardcoded. `polls` carries NODE-level absence (a `resolvesEmpty`
// awaited landing); `meter` is the same story with different names, and the
// same story with different names.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { fromCatalogSnapshot, type CatalogSnapshot } from '../../service/snapshot';
import type { InstanceSchema } from '../catalog';

const promise = (target: string) => ({
  target,
  awaitable: true, watchable: true,
  resolvesEmpty: true,
  readable: false,
  writable: false,
});

const pollSchema: InstanceSchema = {
  positions: {
    Poll: { properties: { Question: 'text' }, edges: { Result: promise('Poll Result') } },
    'Poll Result': {
      properties: {
        Answer: { kind: 'enum', options: ['Ship', 'Hold'] },
        Score: 'number',
        Seen: 'datetime',
        Payload: 'json',
        Tags: { kind: 'list', of: 'text' },
      },
      edges: { Notes: { target: 'Poll Note', readable: true } },
    },
    'Poll Note': { properties: { Body: 'text' }, edges: {} },
  },
  collections: { Poll: { target: 'Poll' } },
  writableRoots: {
    Poll: {
      fields: { Question: 'text' },
      requiredFields: ['Question'],
      resultShape: { externalId: 'text' },
    },
  },
};

/** The second shape — same story, none of the same names. */
const meterSchema: InstanceSchema = {
  positions: {
    Gauge: { properties: { Label: 'text' }, edges: { Reading: promise('Gauge Reading') } },
    'Gauge Reading': {
      properties: { Grade: { kind: 'enum', options: ['A', 'B'] }, Level: 'number' },
      edges: {},
    },
  },
  collections: { Gauge: { target: 'Gauge' } },
  writableRoots: {
    Gauge: {
      fields: { Label: 'text' },
      requiredFields: ['Label'],
      resultShape: { externalId: 'text' },
    },
  },
};

/** An ordinary writable sink — the require-present site an undischarged
 *  absence lands on. */
const logSchema: InstanceSchema = {
  positions: { Entry: { properties: { label: 'text', score: 'number' }, edges: {} } },
  collections: { Entry: { target: 'Entry' } },
  writableRoots: {
    Entry: { fields: { label: 'text', score: 'number' }, resultShape: { externalId: 'text' } },
  },
};

const snapshot: CatalogSnapshot = {
  adapters: {
    polls: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schemas: { probe: pollSchema },
    },
    meter: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schemas: { probe: meterSchema },
    },
    logbook: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schemas: { probe: logSchema },
    },
  },
  credentials: { probe: { adapters: ['polls', 'meter', 'logbook'] } },
  plugins: {},
};

const PRELUDE = `import { polls, meter, logbook } from adapters
import { probe } from credentials

p = polls(credentials: probe)
g = meter(credentials: probe)
log = logbook(credentials: probe)
`;

const diagnosticsFor = (body: string): Diagnostic[] =>
  checkProgram(
    parseProgram(`${PRELUDE}\nmovement m() {\n${body}\n}`),
    fromCatalogSnapshot(snapshot),
  ).filter(d => (d.severity ?? 'error') === 'error');

const codesFor = (body: string): string[] => diagnosticsFor(body).map(d => d.code);

/** An awaited `resolvesEmpty` landing — every field reads `T | absent`. */
const AWAITED = '  a = write p-[:Poll]-> { Question: "Ship it?" }\n  r = await FIRST(a-[:Result]->)';
const AWAITED_METER = '  b = write g-[:Gauge]-> { Label: "Heat" }\n  q = await FIRST(b-[:Reading]->)';

describe('comparison legality against `T | absent`', () => {
  it('== is legal — absent is never equal to a present value', () => {
    expect(codesFor(`${AWAITED}\n  if r.Answer == "Ship" { }`)).toEqual([]);
  });

  it('!= is legal', () => {
    expect(codesFor(`${AWAITED}\n  if r.Answer != "Ship" { }`)).toEqual([]);
  });

  it('IN is legal', () => {
    expect(codesFor(`${AWAITED}\n  if r.Answer IN ["Ship", "Hold"] { }`)).toEqual([]);
  });

  it('CONTAINS is legal', () => {
    expect(codesFor(`${AWAITED}\n  if r.Tags CONTAINS "urgent" { }`)).toEqual([]);
  });

  it('ORDERED comparison still requires a present value (TS errors on `x < 3`)', () => {
    for (const op of ['>', '>=', '<', '<=']) {
      expect(codesFor(`${AWAITED}\n  if r.Score ${op} 3 { }`)).toEqual(['MOV_ABSENT_REQUIRED']);
    }
  });

  it('the ordered-comparison message says equality is fine, and names the discharges', () => {
    const message = diagnosticsFor(`${AWAITED}\n  if r.Score > 3 { }`)[0]?.message ?? '';
    expect(message).toContain('ordered comparison');
    // The fallback, not the `?:` fill: `?:` is a write-FIELD marker, and there
    // is no write field here — COALESCE is the discharge a comparison can use.
    expect(message).toContain('COALESCE');
    expect(message).toContain('never equal');
  });

  it('WITHIN orders a timestamp against the clock, so it requires present too', () => {
    expect(codesFor(`${AWAITED}\n  if r.Seen WITHIN 30d { }`)).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('a json comparison is still MOV_JSON_OPAQUE — absence changes nothing there', () => {
    expect(codesFor(`${AWAITED}\n  if r.Payload == "x" { }`)).toContain('MOV_JSON_OPAQUE');
  });

  it('an expression with no name to narrow just compares — nothing to discharge', () => {
    // `DATE.PARSE` types `date | absent`; comparing it is legal, and there is no
    // reference to narrow, exactly as in TS.
    expect(
      codesFor(`  x = "12 March 2026"\n  if DATE.PARSE(x) == DATE("2026-03-12") { }`),
    ).toEqual([]);
  });
});

describe('equality narrows — the comparison IS the guard', () => {
  it('the true branch reads the value as PRESENT', () => {
    expect(
      codesFor(`${AWAITED}\n  if r.Answer == "Ship" { write log-[:Entry]-> { label: r.Answer } }`),
    ).toEqual([]);
  });

  it('a maybe-empty LANDING narrows at the node — every field discharges', () => {
    // Emptiness is a fact about the resolution, not about one field: if the
    // answer is there, the landing is there.
    expect(
      codesFor(`${AWAITED}\n  if r.Answer == "Ship" { write log-[:Entry]-> { score: r.Score } }`),
    ).toEqual([]);
  });

  it('…so an ORDERED comparison inside the arm is discharged as well', () => {
    expect(codesFor(`${AWAITED}\n  if r.Answer == "Ship" { if r.Score > 3 { } }`)).toEqual([]);
  });

  it('the FALSE branch learns nothing (absent, or another value)', () => {
    expect(
      codesFor(
        `${AWAITED}\n  if r.Answer == "Ship" { } else { write log-[:Entry]-> { label: r.Answer } }`,
      ),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('!= narrows NOTHING in its true branch — a != match may be absent', () => {
    expect(
      codesFor(`${AWAITED}\n  if r.Answer != "Ship" { write log-[:Entry]-> { label: r.Answer } }`),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('narrowing does not leak past the arm', () => {
    expect(
      codesFor(`${AWAITED}\n  if r.Answer == "Ship" { }\n  write log-[:Entry]-> { label: r.Answer }`),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('an AND conjunct narrows for the conjuncts after it AND the body', () => {
    expect(
      codesFor(
        `${AWAITED}\n  if r.Answer == "Ship" AND r.Score > 3 { write log-[:Entry]-> { label: r.Answer } }`,
      ),
    ).toEqual([]);
  });

  it('under OR it proves nothing — a true condition need not be this operand', () => {
    expect(
      codesFor(
        `${AWAITED}\n  if r.Answer == "Ship" OR 1 == 1 { write log-[:Entry]-> { label: r.Answer } }`,
      ),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('comparing two maybe-absent reads proves nothing — absent == absent is TRUE', () => {
    expect(
      codesFor(
        `${AWAITED}\n${AWAITED_METER}\n  if r.Score == q.Level { write log-[:Entry]-> { score: r.Score } }`,
      ),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('a traversal-as-gate is untouched by any of this', () => {
    // The landing may be empty, and a walk INTO a block off it runs zero times
    // when it is — so nothing inside the block has an absence left to discharge.
    expect(
      codesFor(`${AWAITED}\n  r-[n:Notes]-> { write log-[:Entry]-> { label: n.Body } }`),
    ).toEqual([]);
  });

  it('a `?:` fill is untouched by any of this', () => {
    expect(codesFor(`${AWAITED}\n  write log-[:Entry]-> { label ?: r.Answer }`)).toEqual([]);
  });
});

describe('the second shape — derived, not hardcoded', () => {
  it('equality is legal and narrows on a differently-named landing', () => {
    expect(
      codesFor(`${AWAITED_METER}\n  if q.Grade == "A" { write log-[:Entry]-> { score: q.Level } }`),
    ).toEqual([]);
  });

  it('ordering it still requires present', () => {
    expect(codesFor(`${AWAITED_METER}\n  if q.Level >= 3 { }`)).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('the enum did-you-mean is the ONLY thing a typo’d comparison says', () => {
    const errors = diagnosticsFor(`${AWAITED_METER}\n  if q.Grade == "Ay" { }`);
    expect(errors.map(d => d.code)).toEqual(['MOV_ENUM_UNKNOWN_VALUE']);
    expect(errors[0].message).toContain('Did you mean "A"?');
  });
});
