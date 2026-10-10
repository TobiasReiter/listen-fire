// Absence is typed, tested, and narrowed (plans/movement-absence-null-2026-07-31).
//
// Six facts, in dependency order: `null` is a typed literal; a binding carries
// `T | absent` and it can be READ BACK at the use site; `ONLY(<bare path>)`
// binds a maybe-empty NODE rather than a value; the guard forms discharge the
// absence; an ERROR-terminated arm narrows everything after the `if`; and
// `COALESCE` discharges it only when one of its arguments always answers.
//
// TWO adapter shapes throughout — a fixture matching one adapter's names cannot
// tell derived from hardcoded. `chat` and `board` tell the same story with none
// of the same names.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, diagnosticSeverity } from '../check';
import { mockCatalog, type SchemaFieldType, type InstanceSchema, type PositionSchema } from '../catalog';
import { eventAddressDisplay, eventAddressKey } from '../event_address';
import type { LanguageVersion } from '../../language_version';

// ── The chat shape: a selectable collection with a writable child ────────────

const chatSchema: InstanceSchema = {
  positions: {
    Channel: {
      properties: { Name: 'text', Topic: 'text' },
      edges: { Messages: { target: 'Message', writable: true } },
    },
    Message: { properties: { Message: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'Channel' } },
  writableRoots: {
    Channel: { fields: { Name: 'text' }, resultShape: { externalId: 'text' } },
    Message: { fields: { Message: 'text' }, resultShape: { externalId: 'text' } },
  },
};

/** The second shape — same story, none of the same names. */
const boardSchema: InstanceSchema = {
  positions: {
    Lane: {
      properties: { Title: 'text', Colour: 'text' },
      edges: { Cards: { target: 'Card', writable: true } },
    },
    Card: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { Lanes: { target: 'Lane' } },
  writableRoots: {
    Lane: { fields: { Title: 'text' }, resultShape: { externalId: 'text' } },
    Card: { fields: { Body: 'text' }, resultShape: { externalId: 'text' } },
  },
};

// ── The crm shape: an event node plus a record with a many-valued field ──────

const EVENT = 'Webhook Event';
const ACTIONS = ['record.created', 'record.updated'];
const EVENT_PROPS: Record<string, SchemaFieldType> = { action: { kind: 'enum', options: ACTIONS } };
const addressKey = (action: string) => eventAddressKey({ event: EVENT, narrowing: { action } });

const eventPositions = (): { positions: Record<string, PositionSchema>; union: string[] } => {
  const positions: Record<string, PositionSchema> = {};
  const union: string[] = [];
  for (const action of ACTIONS) {
    const key = addressKey(action);
    union.push(key);
    positions[key] = {
      properties: EVENT_PROPS,
      edges: { Companies: { target: 'Companies' } },
      displayName: eventAddressDisplay({ event: EVENT, narrowing: { action } }),
    };
  }
  return { positions, union };
};

const events = eventPositions();

const crmSchema: InstanceSchema = {
  positions: {
    Companies: {
      properties: {
        Name: 'text',
        Description: 'text',
        Domains: { kind: 'list', of: 'text' },
      },
      edges: {},
    },
    [EVENT]: {
      properties: EVENT_PROPS,
      edges: { Companies: { target: 'Companies', requiresLiveRecord: true } },
    },
    ...events.positions,
  },
  collections: {},
  unions: { [EVENT]: events.union },
  writableRoots: {},
  eventPosition: EVENT,
  eventPositions: [{ position: EVENT }],
};

const catalog = mockCatalog({
  adapters: {
    slack: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: chatSchema,
    },
    trello: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: boardSchema,
    },
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      triggerConfig: ['events'],
      triggerConfigOptions: { events: ACTIONS },
      schema: crmSchema,
    },
  },
  credentials: { probe: { adapters: ['slack', 'trello', 'attio'] } },
});

const PRELUDE = [
  'import { attio, slack, trello } from adapters',
  'import { probe } from credentials',
  '',
  'crm = attio(credentials: probe)',
  'chat = slack(credentials: probe)',
  'board = trello(credentials: probe)',
].join('\n');

const diagnosticsFor = (body: string, languageVersion?: LanguageVersion): Diagnostic[] =>
  checkProgram(
    parseProgram(
      [
        PRELUDE,
        `movement main(evt: <crm-[:\`${EVENT}\`]->>) {`,
        body,
        '}',
        'listen to crm { events: ["record.created"] } fire main',
      ].join('\n'),
      languageVersion !== undefined ? { languageVersion } : undefined,
    ),
    catalog,
    languageVersion !== undefined ? { languageVersion } : undefined,
  );

const errorsFor = (body: string, languageVersion?: LanguageVersion): Diagnostic[] =>
  diagnosticsFor(body, languageVersion).filter(d => diagnosticSeverity(d) === 'error');

const codesFor = (body: string, languageVersion?: LanguageVersion): string[] =>
  errorsFor(body, languageVersion).map(d => d.code);

const infosFor = (body: string): string[] =>
  diagnosticsFor(body)
    .filter(d => diagnosticSeverity(d) === 'info')
    .map(d => d.code);

// ── 1. `null` is a typed literal ────────────────────────────────────────────

describe('the null literal', () => {
  it('compares with == / != at any type', () => {
    expect(codesFor('  n = ONLY(chat-[c:Channels]->.`Name`)\n  if n == null { }')).toEqual([]);
    expect(codesFor('  n = ONLY(chat-[c:Channels]->.`Name`)\n  if n != null { }')).toEqual([]);
  });

  it('ORDERING against null is an error — nothing orders against nothing', () => {
    expect(codesFor('  n = ONLY(chat-[c:Channels]->.`Name`)\n  if n > null { }')).toEqual([
      'MOV_COMPARE_TYPE_MISMATCH',
    ]);
  });

  it('a never-absent subject makes `== null` always false (info, not an error)', () => {
    const body = '  n = "fixed"\n  if n == null { }';
    expect(codesFor(body)).toEqual([]);
    expect(infosFor(body)).toEqual(['MOV_PRESENCE_TEST_CONSTANT']);
  });

  it('…and `!= null` always true, on the other shape too', () => {
    const body = '  t = "fixed"\n  if t != null { }';
    expect(infosFor(body)).toEqual(['MOV_PRESENCE_TEST_CONSTANT']);
  });

  it('a maybe-absent subject says nothing — the test is the point', () => {
    expect(infosFor('  n = ONLY(board-[l:Lanes]->.`Title`)\n  if n == null { }')).toEqual([]);
  });
});

// ── 2. bindings carry `T | absent`, readable back ───────────────────────────

describe('a binding carries its absence to the use site', () => {
  it('FIRST over a property path types `T | absent`, and a plain write field rejects it', () => {
    expect(
      codesFor(
        '  n = ONLY(chat-[c:Channels]->.`Name`)\n'
        + '  write board-[:Lanes]-> { Title: n }',
      ),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('the same on the other shape — derived, not hardcoded', () => {
    expect(
      codesFor(
        '  t = ONLY(board-[l:Lanes]->.`Title`)\n'
        + '  write chat-[:Channels]-> { Name: t }',
      ),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('MIN / MAX carry it too — an empty set has no least element', () => {
    for (const fn of ['MIN', 'MAX']) {
      expect(
        codesFor(
          `  n = ${fn}(chat-[c:Channels]->.\`Name\`)\n`
          + '  write board-[:Lanes]-> { Title: n }',
        ),
      ).toEqual(['MOV_ABSENT_REQUIRED']);
    }
  });

  it('COUNT does not — a count of nothing is zero', () => {
    expect(codesFor('  n = COUNT(chat-[c:Channels]->)\n  if n > 0 { }')).toEqual([]);
  });

  it('a `?:` fill is the discharge the write field offers', () => {
    expect(
      codesFor(
        '  n = ONLY(chat-[c:Channels]->.`Name`)\n'
        + '  write board-[:Lanes]-> { Title ?: n }',
      ),
    ).toEqual([]);
  });

  it('an ORDERED comparison of a maybe-absent binding is an error, as it is of a field', () => {
    expect(codesFor('  n = ONLY(chat-[c:Channels]->.`Name`)\n  if n > "a" { }')).toEqual([
      'MOV_ABSENT_REQUIRED',
    ]);
  });
});

// ── 3. FIRST over a bare traversal binds a NODE ─────────────────────────────

describe('FIRST over a bare traversal binds a maybe-empty position', () => {
  const SELECT = '  channel = ONLY(chat-[c:Channels WHERE `Name` == "alerts"]->)';
  const SELECT_LANE = '  lane = ONLY(board-[l:Lanes WHERE `Title` == "Inbox"]->)';

  it('a write off it is an error until the absence is discharged', () => {
    expect(codesFor(`${SELECT}\n  write channel-[:Messages]-> { Message: "hi" }`)).toEqual([
      'MOV_ABSENT_REQUIRED',
    ]);
  });

  it('the message names the guard idiom, in the author’s own names', () => {
    const message = errorsFor(`${SELECT}\n  write channel-[:Messages]-> { Message: "hi" }`)[0].message;
    expect(message).toContain("if channel == null");
    expect(message).toContain('EXISTS(channel)');
    expect(message).toContain('channel-[x:…]->');
  });

  it('the other shape gets its OWN names in the same message', () => {
    const message = errorsFor(`${SELECT_LANE}\n  write lane-[:Cards]-> { Body: "hi" }`)[0].message;
    expect(message).toContain("if lane == null");
    expect(message).not.toContain('channel');
  });

  it('a traversal BLOCK off it is fine — the block runs zero times when empty', () => {
    expect(
      codesFor(`${SELECT}\n  channel-[m:Messages]-> { write board-[:Lanes]-> { Title: m.\`Message\` } }`),
    ).toEqual([]);
  });

  it('it is a NODE, so its fields read through the arrow plane’s dot', () => {
    expect(codesFor(`${SELECT}\n  if channel != null { if channel.\`Topic\` == "x" { } }`)).toEqual(
      [],
    );
  });

  it('a property-path FIRST still binds a scalar (the two planes stay apart)', () => {
    // `ONLY(c.Name)` picks a VALUE; a write off it is not a linked write at all.
    expect(
      codesFor('  n = ONLY(chat-[c:Channels]->.`Name`)\n  write board-[:Lanes]-> { Title ?: n }'),
    ).toEqual([]);
  });
});

// ── 4. guards that discharge ────────────────────────────────────────────────

describe('guards discharge absence', () => {
  const SELECT = '  channel = ONLY(chat-[c:Channels WHERE `Name` == "alerts"]->)';
  const NAME = '  n = ONLY(chat-[c:Channels]->.`Name`)';

  it('`!= null` proves presence in the TRUE branch (node plane)', () => {
    expect(
      codesFor(`${SELECT}\n  if channel != null { write channel-[:Messages]-> { Message: "hi" } }`),
    ).toEqual([]);
  });

  it('`!= null` proves presence in the TRUE branch (scalar plane)', () => {
    expect(codesFor(`${NAME}\n  if n != null { write board-[:Lanes]-> { Title: n } }`)).toEqual([]);
  });

  it('EXISTS(<bare name>) proves the same thing', () => {
    expect(
      codesFor(`${SELECT}\n  if EXISTS(channel) { write channel-[:Messages]-> { Message: "hi" } }`),
    ).toEqual([]);
    expect(codesFor(`${NAME}\n  if EXISTS(n) { write board-[:Lanes]-> { Title: n } }`)).toEqual([]);
  });

  it('`== <a present value>` proves it too — the comparison IS the guard', () => {
    expect(codesFor(`${NAME}\n  if n == "alerts" { write board-[:Lanes]-> { Title: n } }`)).toEqual(
      [],
    );
  });

  it('`== null` proves NOTHING in its true branch — that branch is the absent one', () => {
    expect(
      codesFor(`${SELECT}\n  if channel == null { write channel-[:Messages]-> { Message: "hi" } }`),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('narrowing does not leak past the arm', () => {
    expect(
      codesFor(
        `${SELECT}\n  if channel != null { }\n  write channel-[:Messages]-> { Message: "hi" }`,
      ),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('under OR it proves nothing', () => {
    expect(codesFor(`${NAME}\n  if n != null OR 1 == 1 { write board-[:Lanes]-> { Title: n } }`))
      .toContain('MOV_ABSENT_REQUIRED');
  });

  it('EXISTS on a never-absent binding is an info, not silence', () => {
    expect(infosFor('  n = "fixed"\n  if EXISTS(n) { }')).toEqual(['MOV_PRESENCE_TEST_CONSTANT']);
  });

  it('`IF EXISTS(x) THEN … ELSE … END` narrows its own THEN side', () => {
    // The value-level guard clause: with the test, the THEN arm reads `text`
    // and the conditional is `text`. Without it, the THEN arm is still
    // `text | absent`, which is what the conditional carries out — so the write
    // field is flagged. Same movement, one guard apart.
    expect(
      codesFor(
        `${NAME}\n  line = IF EXISTS(n) THEN n ELSE "" END\n`
        + '  write board-[:Lanes]-> { Title: line }',
      ),
    ).toEqual([]);
    expect(
      codesFor(
        `${NAME}\n  line = IF 1 == 1 THEN n ELSE "" END\n`
        + '  write board-[:Lanes]-> { Title: line }',
      ),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });
});

// ── 5. an ERROR-terminated arm narrows the continuation ─────────────────────

describe('the guard clause', () => {
  const SELECT = '  channel = ONLY(chat-[c:Channels WHERE `Name` == "alerts"]->)';
  const SELECT_LANE = '  lane = ONLY(board-[l:Lanes WHERE `Title` == "Inbox"]->)';

  it('`if x == null { ERROR(…) }` proves x present BELOW the if', () => {
    expect(
      codesFor(
        `${SELECT}\n  if channel == null { ERROR("no channel") }\n`
        + '  write channel-[:Messages]-> { Message: "hi" }',
      ),
    ).toEqual([]);
  });

  it('…on the other shape too', () => {
    expect(
      codesFor(
        `${SELECT_LANE}\n  if lane == null { ERROR("no lane") }\n`
        + '  write lane-[:Cards]-> { Body: "hi" }',
      ),
    ).toEqual([]);
  });

  it('an arm that does NOT terminate proves nothing below', () => {
    expect(
      codesFor(
        `${SELECT}\n  if channel == null { }\n`
        + '  write channel-[:Messages]-> { Message: "hi" }',
      ),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('it works on the scalar plane as well', () => {
    expect(
      codesFor(
        '  n = ONLY(chat-[c:Channels]->.`Name`)\n'
        + '  if n == null { ERROR("no name") }\n'
        + '  write board-[:Lanes]-> { Title: n }',
      ),
    ).toEqual([]);
  });

  it('a nested if that terminates on EVERY arm (else included) terminates too', () => {
    expect(
      codesFor(
        `${SELECT}\n`
        + '  if channel == null { if 1 == 1 { ERROR("a") } else { ERROR("b") } }\n'
        + '  write channel-[:Messages]-> { Message: "hi" }',
      ),
    ).toEqual([]);
  });

  it('…and one missing its else does not', () => {
    expect(
      codesFor(
        `${SELECT}\n`
        + '  if channel == null { if 1 == 1 { ERROR("a") } }\n'
        + '  write channel-[:Messages]-> { Message: "hi" }',
      ),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('a LATER arm proves its negation only while every earlier arm terminates', () => {
    // Arm 1 falls through, so reaching the write may mean arm 1 ran — arm 2's
    // condition was never even evaluated, and its negation is not established.
    expect(
      codesFor(
        `${SELECT}\n`
        + '  if 1 == 1 { } else if channel == null { ERROR("no channel") }\n'
        + '  write channel-[:Messages]-> { Message: "hi" }',
      ),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });
});

// ── 5b. an early `return` narrows the continuation too (version 3) ──────────
//
// TypeScript's guard clause is `if (x == null) return …;` as often as it is
// `throw`. From Steady Lynx a `return` leaves an arm as surely as `ERROR`
// does; Bright Otter keeps the ERROR-only reading, proved alongside each form.

describe('an early return narrows the rest of the body (v3)', () => {
  const SELECT = '  channel = ONLY(chat-[c:Channels WHERE `Name` == "alerts"]->)';
  const NAME = '  n = ONLY(chat-[c:Channels]->.`Name`)';
  const WRITE = '  write channel-[:Messages]-> { Message: "hi" }';
  const WRITE_N = '  write board-[:Lanes]-> { Title: n }';

  const forms: Array<[string, string]> = [
    ['`== null` then return', `${NAME}\n  if n == null { return "none" }\n${WRITE_N}`],
    ['`ISNULL(x)` then return', `${NAME}\n  if ISNULL(n) { return "none" }\n${WRITE_N}`],
    ['`NOT EXISTS(x)` then return', `${SELECT}\n  if NOT EXISTS(channel) { return "none" }\n${WRITE}`],
    ['the node plane, `== null`', `${SELECT}\n  if channel == null { return "none" }\n${WRITE}`],
    [
      '`a == null OR b == null` proves both',
      `${SELECT}\n${NAME}\n  if channel == null OR n == null { return "none" }\n${WRITE}\n${WRITE_N}`,
    ],
    ['`!= null` whose ELSE returns', `${NAME}\n  if n != null { } else { return "none" }\n${WRITE_N}`],
    ['`EXISTS(x)` whose ELSE returns', `${SELECT}\n  if EXISTS(channel) { } else { return "none" }\n${WRITE}`],
    [
      '`a != null AND b != null` whose ELSE returns proves both',
      `${SELECT}\n${NAME}\n  if channel != null AND n != null { } else { return "none" }\n${WRITE}\n${WRITE_N}`,
    ],
    [
      'the one arm that falls through, the else and the others returning',
      `${NAME}\n  if 1 == 2 { return "a" } else if n != null { } else { ERROR("no name") }\n${WRITE_N}`,
    ],
    [
      'a nested if whose every arm returns',
      `${NAME}\n  if n == null { if 1 == 1 { return "a" } else { ERROR("b") } }\n${WRITE_N}`,
    ],
  ];

  it.each(forms)('%s: clean under v3', (_label, body) => {
    expect(codesFor(body)).toEqual([]);
  });

  it.each(forms)('%s: still refused under v2 (only ERROR narrows there)', (_label, body) => {
    expect(codesFor(body, 2)).toContain('MOV_ABSENT_REQUIRED');
  });

  it('`AND` false proves nothing, so a returning arm over a conjunction narrows neither', () => {
    expect(
      codesFor(`${SELECT}\n  if channel == null AND 1 == 1 { return "none" }\n${WRITE}`),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('`OR` true proves nothing, so an else-return over a disjunction narrows neither', () => {
    expect(
      codesFor(`${SELECT}\n  if channel != null OR 1 == 1 { } else { return "none" }\n${WRITE}`),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('an else-return with TWO arms falling through proves neither condition', () => {
    expect(
      codesFor(`${NAME}\n  if n != null { } else if 1 == 1 { } else { return "none" }\n${WRITE_N}`),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('an else that falls through proves nothing about the arm', () => {
    expect(codesFor(`${NAME}\n  if n != null { } else { }\n${WRITE_N}`)).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('a return inside a block narrows the rest of THAT block body', () => {
    expect(
      codesFor(
        '  chat-[c:Channels]-> {\n'
        + '    n = ONLY(c-[m:Messages]->.`Message`)\n'
        + '    if n == null { return "none" }\n'
        + '    write board-[:Lanes]-> { Title: n }\n'
        + '  }',
      ),
    ).toEqual([]);
  });

  it('…and not past it: the narrowing ends with the body that holds the if', () => {
    expect(
      codesFor(
        `${NAME}\n`
        + '  chat-[c:Channels]-> {\n'
        + '    if n == null { return "none" }\n'
        + '  }\n'
        + WRITE_N,
      ),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });
});

// ── 6. COALESCE discharges absence only when something always answers ───────

describe('COALESCE on the absence axis', () => {
  const NAME = '  n = ONLY(chat-[c:Channels]->.`Name`)';
  const TITLE = '  t = ONLY(board-[l:Lanes]->.`Title`)';

  it('no fallback discharges nothing — it is ONLY(x) with a longer name', () => {
    expect(
      codesFor(
        '  n = COALESCE(ONLY(chat-[c:Channels]->.`Name`))\n'
        + '  write board-[:Lanes]-> { Title: n }',
      ),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('…on the other shape too', () => {
    expect(
      codesFor(
        '  t = COALESCE(ONLY(board-[l:Lanes]->.`Title`))\n'
        + '  write chat-[:Channels]-> { Name: t }',
      ),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('…and in an ordered comparison, exactly as the bare aggregate is', () => {
    expect(codesFor('  if COALESCE(ONLY(chat-[c:Channels]->.`Name`)) > "a" { }')).toEqual([
      'MOV_ABSENT_REQUIRED',
    ]);
  });

  it('a LITERAL fallback discharges it — a plain write field takes the result', () => {
    expect(
      codesFor(
        '  n = COALESCE(ONLY(chat-[c:Channels]->.`Name`), "unknown")\n'
        + '  write board-[:Lanes]-> { Title: n }',
      ),
    ).toEqual([]);
  });

  it('so does a fallback that is itself always there', () => {
    expect(
      codesFor(
        '  fallback = "unknown"\n'
        + '  n = COALESCE(ONLY(chat-[c:Channels]->.`Name`), fallback)\n'
        + '  write board-[:Lanes]-> { Title: n }',
      ),
    ).toEqual([]);
  });

  it('`null` is not a fallback — it IS the absence', () => {
    expect(
      codesFor(
        '  n = COALESCE(ONLY(chat-[c:Channels]->.`Name`), null)\n'
        + '  write board-[:Lanes]-> { Title: n }',
      ),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('every argument maybe-absent ⇒ the result is too', () => {
    expect(
      codesFor(
        `${NAME}\n${TITLE}\n`
        + '  either = COALESCE(n, t)\n'
        + '  write board-[:Lanes]-> { Title: either }',
      ),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('an UNTYPED argument keeps the answer unknown — no error manufactured from ignorance', () => {
    // `AI(…)` types nothing. Nothing here knows whether it answers, so this
    // layer neither claims a presence nor invents an absence (TS's `unknown`).
    expect(
      codesFor(
        `${TITLE}\n`
        + '  n = COALESCE(AI("a name"), t)\n'
        + '  write board-[:Lanes]-> { Title: n }',
      ),
    ).toEqual([]);
  });

  it('it composes — the fallback may be a COALESCE, and so may the value', () => {
    expect(
      codesFor(
        '  n = COALESCE(COALESCE(ONLY(chat-[c:Channels]->.`Name`)), "unknown")\n'
        + '  write board-[:Lanes]-> { Title: n }',
      ),
    ).toEqual([]);
    expect(
      codesFor(
        '  n = COALESCE(COALESCE(ONLY(chat-[c:Channels]->.`Name`)))\n'
        + '  write board-[:Lanes]-> { Title: n }',
      ),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('a `?:` fill still takes the undischarged form', () => {
    expect(
      codesFor(
        '  n = COALESCE(ONLY(chat-[c:Channels]->.`Name`))\n'
        + '  write board-[:Lanes]-> { Title ?: n }',
      ),
    ).toEqual([]);
  });

  it('both messages name the fallback among the fixes', () => {
    const write = errorsFor(
      '  n = COALESCE(ONLY(chat-[c:Channels]->.`Name`))\n'
      + '  write board-[:Lanes]-> { Title: n }',
    )[0].message;
    expect(write).toContain('COALESCE');
    const ordered = errorsFor('  if COALESCE(ONLY(chat-[c:Channels]->.`Name`)) > "a" { }')[0]
      .message;
    expect(ordered).toContain('COALESCE');
  });
});

// ── 7. the WHERE plane obeys the same rule ──────────────────────────────────
//
// A bracket WHERE is where a binding meets a hop's own fields, and the engine
// reads BOTH surfaces there (a value binding in scope, else a field of the hop
// target). The checker used to see only the second, so a maybe-absent binding
// in an ordered comparison typed as nothing and passed — and at run time the
// comparison is silently false, so the hop keeps NO records. Same rule, same
// message, same discharges as anywhere else.

describe('a maybe-absent binding inside a bracket WHERE', () => {
  const NAME = '  n = ONLY(chat-[c:Channels]->.`Name`)';
  const TITLE = '  t = ONLY(board-[l:Lanes]->.`Title`)';

  it('an ORDERED comparison against it is refused', () => {
    expect(codesFor(`${NAME}\n  board-[l:Lanes WHERE \`Title\` > n]-> { }`)).toEqual([
      'MOV_ABSENT_REQUIRED',
    ]);
  });

  it('…on the other shape too — derived, not hardcoded', () => {
    expect(codesFor(`${TITLE}\n  chat-[c:Channels WHERE \`Name\` <= t]-> { }`)).toEqual([
      'MOV_ABSENT_REQUIRED',
    ]);
  });

  it('every ordered operator, and either side of it', () => {
    for (const op of ['>', '>=', '<', '<=']) {
      expect(codesFor(`${NAME}\n  board-[l:Lanes WHERE \`Title\` ${op} n]-> { }`)).toEqual([
        'MOV_ABSENT_REQUIRED',
      ]);
      expect(codesFor(`${NAME}\n  board-[l:Lanes WHERE n ${op} \`Title\`]-> { }`)).toEqual([
        'MOV_ABSENT_REQUIRED',
      ]);
    }
  });

  it('the message names the same fixes it names everywhere else', () => {
    const message = errorsFor(`${NAME}\n  board-[l:Lanes WHERE \`Title\` > n]-> { }`)[0].message;
    expect(message).toContain('ordered comparison');
    expect(message).toContain('COALESCE');
    expect(message).toContain('never equal');
  });

  it('an EXISTS bracket is the same plane', () => {
    expect(
      codesFor(`${NAME}\n  if EXISTS(board-[l:Lanes WHERE \`Title\` > n]->) { }`),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('a query bracket in value position too', () => {
    expect(codesFor(`${NAME}\n  x = ONLY(board-[l:Lanes WHERE \`Title\` > n]->)`)).toEqual([
      'MOV_ABSENT_REQUIRED',
    ]);
  });

  it('EQUALITY against it stays legal — absent is simply never equal', () => {
    expect(codesFor(`${NAME}\n  board-[l:Lanes WHERE \`Title\` == n]-> { }`)).toEqual([]);
    expect(codesFor(`${NAME}\n  board-[l:Lanes WHERE \`Title\` != n]-> { }`)).toEqual([]);
  });

  it('a PRESENT binding orders freely — nothing to discharge', () => {
    expect(codesFor('  n = "alerts"\n  board-[l:Lanes WHERE `Title` > n]-> { }')).toEqual([]);
  });

  it("the hop's OWN fields are untouched — a declared field still wins the name", () => {
    expect(codesFor('  board-[l:Lanes WHERE `Title` > `Colour`]-> { }')).toEqual([]);
  });

  it('a name that is neither a field nor a binding is an unknown field, not an absence', () => {
    expect(codesFor('  board-[l:Lanes WHERE `Bogus` > "a"]-> { }')).toEqual([
      'MOV_UNKNOWN_PROPERTY',
    ]);
  });

  // The discharges, each in the WHERE.
  it('a `!= null` guard around the traversal discharges it', () => {
    expect(
      codesFor(`${NAME}\n  if n != null { board-[l:Lanes WHERE \`Title\` > n]-> { } }`),
    ).toEqual([]);
  });

  it('EXISTS(<name>) discharges it', () => {
    expect(
      codesFor(`${NAME}\n  if EXISTS(n) { board-[l:Lanes WHERE \`Title\` > n]-> { } }`),
    ).toEqual([]);
  });

  it('a terminating `== null` guard clause discharges it below', () => {
    expect(
      codesFor(
        `${NAME}\n  if n == null { ERROR("no name") }\n`
        + '  board-[l:Lanes WHERE `Title` > n]-> { }',
      ),
    ).toEqual([]);
  });

  it('COALESCE with a present fallback discharges it', () => {
    // Off a landed position rather than a collection: the hop capability gate
    // refuses a non-pure filter over an unbounded source, which would answer
    // for the wrong reason. The absence is what is under test.
    expect(
      codesFor(
        `${NAME}\n`
        + '  chat-[c:Channels]-> { c-[m:Messages WHERE `Message` > COALESCE(n, "a")]-> { } }',
      ),
    ).toEqual([]);
  });

  it('…and COALESCE with no fallback does not', () => {
    expect(
      codesFor(
        `${NAME}\n`
        + '  chat-[c:Channels]-> { c-[m:Messages WHERE `Message` > COALESCE(n)]-> { } }',
      ),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('a `== null` presence test inside a WHERE keeps working', () => {
    expect(codesFor(`${NAME}\n  board-[l:Lanes WHERE n == null]-> { }`)).toEqual([]);
    expect(codesFor(`${NAME}\n  board-[l:Lanes WHERE n != null]-> { }`)).toEqual([]);
  });

  it('a selecting WHERE on a present field is untouched', () => {
    expect(codesFor('  board-[l:Lanes WHERE `Title` == "Inbox"]-> { }')).toEqual([]);
  });
});

// ── The acceptance movement ─────────────────────────────────────────────────

const ACCEPTANCE = (guard: string): string =>
  [
    PRELUDE,
    '',
    `movement notify_company_change(evt: <crm-[:\`${EVENT}\`]->>) {`,
    '  channel = ONLY(chat-[ch:Channels WHERE `Name` == "auto-alerts"]->)',
    guard,
    '',
    `  if evt IS <crm-[:\`${EVENT}\` WHERE \`action\` == "record.created"]->> {`,
    '    evt-[co:Companies]-> {',
    '      domain      = ONLY(co.Domains)',
    '      domain_line = IF EXISTS(domain) THEN "\\n<https://${domain}|${domain}>" ELSE "" END',
    '',
    '      write channel-[:Messages]-> {',
    '          Message: "*New company in Attio:* ${co.Name}\\n${co.Description}${domain_line}"',
    '      }',
    '    }',
    '  }',
    '}',
    '',
    'listen to crm { events: ["record.created", "record.updated"] } fire notify_company_change',
  ].join('\n');

describe("the acceptance movement (regression example, 2026-07-31)", () => {
  const GUARD = '  if channel == null { ERROR("channel not found") }';

  it('checks clean WITH the guard', () => {
    const diagnostics = checkProgram(parseProgram(ACCEPTANCE(GUARD)), catalog);
    expect(diagnostics.map(d => `${d.code}: ${d.message}`)).toEqual([]);
  });

  it('WITHOUT the guard, the write off `channel` is flagged', () => {
    const errors = checkProgram(parseProgram(ACCEPTANCE('')), catalog).filter(
      d => diagnosticSeverity(d) === 'error',
    );
    expect(errors.map(d => d.code)).toEqual(['MOV_ABSENT_REQUIRED']);
    expect(errors[0].message).toContain('channel');
  });

  it("`domain_line`'s EXISTS(domain) discharges the maybeAbsent from ONLY(co.Domains)", () => {
    // `ONLY(co.Domains)` is `text | absent` — a company may have no domain. The
    // movement as written never trips on it, because interpolation renders an
    // absent value as nothing; so to SEE the discharge, read `domain` bare
    // inside the THEN and write `domain_line` bare. With the EXISTS it is
    // `text`; with the guard swapped for a constant it is still `text | absent`,
    // and the write field says so.
    const bare = (condition: string): string =>
      ACCEPTANCE(GUARD)
        .replace('IF EXISTS(domain) THEN "\\n<https://${domain}|${domain}>"', `IF ${condition} THEN domain`)
        .replace(/Message: "\*New company[^\n]*/, 'Message: domain_line');
    const errors = (source: string): string[] =>
      checkProgram(parseProgram(source), catalog)
        .filter(d => diagnosticSeverity(d) === 'error')
        .map(d => d.code);
    expect(errors(bare('EXISTS(domain)'))).toEqual([]);
    expect(errors(bare('1 == 1'))).toEqual(['MOV_ABSENT_REQUIRED']);
  });
});

// ── 7. the null-plane guards all read a DOTTED path (R13) ───────────────────
//
// The three spellings ask one question — is this there? — so they take the same
// subjects and prove the same thing. Before R13 only `== null` / `!= null` read
// a property path; `EXISTS` refused one outright and `ISNULL` proved nothing at
// all, so an author had to bind the field to a name just to test it.

describe('a guard reads a property path, not just a bound name', () => {
  const SELECT = '  channel = ONLY(chat-[c:Channels WHERE `Name` == "alerts"]->)';
  const LANE = '  lane = ONLY(board-[l:Lanes WHERE `Title` == "Inbox"]->)';
  const useTopic = '  write board-[:Lanes]-> { Title: channel.`Topic` }';
  const useColour = '  write chat-[:Channels]-> { Name: lane.`Colour` }';

  it('the unguarded read is the error the guards are for', () => {
    expect(codesFor(`${SELECT}\n${useTopic}`)).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('EXISTS(x.`Field`) is accepted, and narrows that path in its own arm', () => {
    expect(codesFor(`${SELECT}\n  if EXISTS(channel.\`Topic\`) {\n${useTopic}\n  }`)).toEqual([]);
    expect(codesFor(`${LANE}\n  if EXISTS(lane.\`Colour\`) {\n${useColour}\n  }`)).toEqual([]);
  });

  it('…and `!= null` on the same path says the same thing', () => {
    expect(codesFor(`${SELECT}\n  if channel.\`Topic\` != null {\n${useTopic}\n  }`)).toEqual([]);
  });

  it('a proven field discharges the whole landing — the absence was node-level', () => {
    expect(
      codesFor(`${SELECT}\n  if EXISTS(channel.\`Topic\`) { write channel-[:Messages]-> { Message: "hi" } }`),
    ).toEqual([]);
  });

  it('the narrowing does not leak past the arm', () => {
    expect(codesFor(`${SELECT}\n  if EXISTS(channel.\`Topic\`) { }\n${useTopic}`)).toEqual([
      'MOV_ABSENT_REQUIRED',
    ]);
  });

  it('under OR it proves nothing, exactly as the comparison form does', () => {
    expect(
      codesFor(`${SELECT}\n  if EXISTS(channel.\`Topic\`) OR 1 == 1 {\n${useTopic}\n  }`),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('EXISTS over a relationship is untouched — the arrow plane still needs a path', () => {
    expect(codesFor(`${LANE}\n  if EXISTS(board-[l:Lanes]->) { }`)).toEqual([]);
    expect(codesFor('  if EXISTS(1 + 1) { }')).toEqual(['MOV_EXPR_PARSE']);
  });

  it('ISNULL is a guard clause: false below the arm means present', () => {
    expect(
      codesFor(
        '  n = ONLY(chat-[c:Channels]->.`Name`)\n'
        + '  if ISNULL(n) { ERROR("no name") }\n'
        + '  write board-[:Lanes]-> { Title: n }',
      ),
    ).toEqual([]);
  });

  it('…and it reads a dotted path too', () => {
    expect(codesFor(`${SELECT}\n  if ISNULL(channel.\`Topic\`) { ERROR("no topic") }\n${useTopic}`))
      .toEqual([]);
  });

  it('NOT ISNULL(x) narrows its own arm — the dual of the guard clause', () => {
    expect(codesFor(`${SELECT}\n  if NOT ISNULL(channel.\`Topic\`) {\n${useTopic}\n  }`)).toEqual([]);
  });

  it('an ISNULL arm that does not terminate proves nothing below it', () => {
    expect(codesFor(`${SELECT}\n  if ISNULL(channel.\`Topic\`) { }\n${useTopic}`)).toEqual([
      'MOV_ABSENT_REQUIRED',
    ]);
  });
});
