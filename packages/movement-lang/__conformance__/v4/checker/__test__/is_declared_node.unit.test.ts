// `x IS <Doc>` — a STRUCTURAL conformance predicate (layer 10 §D).
//
// The other two IS planes ask "is this position THAT one" (by name, by
// address). A declared node names no position at all, so the question is the
// one the language already answers when a node literal reaches a `<Doc>`
// parameter — does what this position OFFERS carry everything Doc declares? —
// asked as a predicate. So what's worth pinning is (a) that it is TypeScript's
// structural assignability and not a name match (extra members fine, a missing
// one fatal, a wrong TYPE fatal), (b) that narrowing is the record plane's
// machinery with the comparator standing in for the name match, arm AND else,
// and (c) that it decides from the SCHEMA, so nothing about it needs data.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

// `subject` is polymorphic — three landings, and only some of them look like a
// contact. That is what gives the predicate something to decide. Three members,
// so an `else if` chain has something left after the first test.
const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { Name: 'text', Email: 'text', Employees: 'number' },
      edges: { logo: { target: 'asset', readable: true } },
    },
    person: {
      properties: { Name: 'text', Email: 'text' },
      edges: { logo: { target: 'asset', readable: true } },
    },
    // No `Email` and no `logo`, so it fits nothing that asks for either.
    ticket: { properties: { Name: 'text' }, edges: {} },
    asset: { properties: { url: 'text', bytes: 'file' }, edges: {} },
    log: { properties: { text: 'text' }, edges: {} },
    // NOBODY HAS LOOKED at this one — no surface, so no comparison happened.
    mystery: { properties: {}, edges: {}, undescribed: true },
  },
  collections: { logs: { target: 'log' } },
  unions: { entity: ['company', 'person', 'ticket'], guarded: ['company', 'mystery'] },
  writableRoots: {
    log: { fields: { text: 'text' }, resultShape: { externalId: 'text', text: 'text' } },
  },
};

const catalog = mockCatalog({
  adapters: {
    crm: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: crmSchema,
    },
  },
  credentials: { crm_creds: { adapter: 'crm' } },
});

const PRELUDE = `import { crm } from adapters
import { crm_creds } from credentials
book = crm(credentials: crm_creds)

node Contact {
  Name: <text>
  Email: <text>
}

node Named {
  Name: <text>
}

node Branded {
  Name: <text>
  node logo {
    url: <text>
  }
}

node Counted {
  Name: <text>
  Employees: <text>
}

node Impossible {
  Nope: <text>
}

node \`Multi Words\` {
  Name: <text>
}
`;

/** The subject is the polymorphic union itself — which is where the predicate
 *  does work, since a single-typed subject is decided outright. */
function check(body: string, param = '<book-[:entity]->>'): Diagnostic[] {
  const source = `${PRELUDE}
movement m(x: ${param}) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string, param?: string): string[] => check(body, param).map((d) => d.code);
const messages = (body: string, param?: string): string =>
  check(body, param)
    .map((d) => d.message)
    .join('\n');

describe('the test itself', () => {
  it('is valid anywhere a boolean is, and reads no data', () => {
    expect(codes('  if x IS <Contact> { }')).toEqual([]);
  });

  it('reads as a boolean under AND alongside an ordinary condition', () => {
    expect(codes('  if x IS <Contact> AND x.`Name` != "" { }')).toEqual([]);
  });

  it('a declaration the file never made is an unknown name, not a silent false', () => {
    expect(codes('  if x IS <Nowhere> { }')).toContain(C.NAME_UNRESOLVED);
  });

  it('hopping through a declared node is refused with the corrective', () => {
    expect(codes('  if x IS <Contact-[:logo]->> { }')).toContain(C.SHAPE_HOP_RETIRED);
    expect(messages('  if x IS <Contact-[:logo]->> { }')).toContain('x IS <Contact>');
  });
});

describe('the arm keeps what conforms', () => {
  it('a field only SOME members carry needs narrowing — and the test supplies it', () => {
    expect(codes('  y = x.`Email`')).toEqual([C.NARROWING]);
    expect(codes('  if x IS <Contact> { y = x.`Email` }')).toEqual([]);
  });

  it('EXTRA members are fine — a position that carries more still conforms', () => {
    // Every member has `Name`, so every member is still in the arm…
    expect(codes('  if x IS <Named> { y = x.`Name` }')).toEqual([]);
    // …including the one whose `Email` the arm therefore still can't read.
    expect(codes('  if x IS <Named> { y = x.`Email` }')).toEqual([C.NARROWING]);
  });

  it('the arm is still a union when two members conform — it narrows, it does not collapse', () => {
    // company|person both fit Contact; `Employees` is company-only.
    expect(codes('  if x IS <Contact> { y = x.`Employees` }')).toEqual([C.NARROWING]);
  });

  it('a missing declared edge no longer narrows the union — absence is the empty set', () => {
    // `ticket` has no `logo` edge at all, but that no longer excludes it from
    // conforming to Branded — a missing edge is zero of them, not a missing
    // member. So IS <Branded> conforms for every member and narrows nothing.
    expect(codes('  if x IS <Branded> { y = x.`Name` }')).toEqual([]);
    // Traversing `logo` itself still needs narrowing down to the members that
    // actually carry the edge — IS <Branded> no longer does that for you,
    // same as the unnarrowed traversal below.
    expect(codes('  x-[l:logo]-> { y = l.`url` }')).toEqual([C.NARROWING]);
    expect(codes('  if x IS <Branded> { x-[l:logo]-> { y = l.`url` } }')).toEqual([
      C.NARROWING,
    ]);
  });

  it('the TYPE has to be compatible, not just the name', () => {
    // Counted wants `Employees: <text>`; company's is a number, so nothing
    // conforms and the arm is `never`.
    expect(codes('  if x IS <Counted> { y = x.`Name` }')).toEqual([C.UNREACHABLE_BRANCH]);
  });

  it('a structure nothing conforms to narrows to never — refused at the USE, not the test', () => {
    expect(codes('  if x IS <Impossible> { }')).toEqual([]);
    expect(codes('  if x IS <Impossible> { y = x.`Name` }')).toEqual([C.UNREACHABLE_BRANCH]);
  });

  it('a single-typed subject is decided at check time and narrows nothing', () => {
    expect(codes('  if x IS <Contact> { y = x.`Employees` }', '<book-[:company]->>')).toEqual([]);
  });

  it('a backtick-quoted declared node name narrows exactly like a bare one', () => {
    // `Multi Words` declares the same single field as `Named` — same narrowing,
    // just spelled with the backtick a name carrying spaces always wears.
    expect(codes('  if x IS <`Multi Words`> { y = x.`Name` }')).toEqual([]);
    expect(codes('  if x IS <`Multi Words`> { y = x.`Email` }')).toEqual([C.NARROWING]);
  });
});

describe('the else eliminates what conformed', () => {
  it('the else sees the members that did NOT conform', () => {
    // else = ticket alone, so `Name` reads and `Email` is a plain unknown field.
    expect(codes('  if x IS <Contact> { } else { y = x.`Name` }')).toEqual([]);
    expect(codes('  if x IS <Contact> { } else { y = x.`Email` }')).toEqual([C.UNKNOWN_PROPERTY]);
  });

  it('an else-if chain keeps eliminating', () => {
    // `Contact` (a FIELD-based test) still eliminates ticket — `Branded`
    // (edge-based) no longer would, since ticket now conforms to it too
    // (missing `logo` is the empty set, not a disqualifier).
    expect(
      codes('  if x IS <Contact> { } else if x IS <Named> { y = x.`Name` } else { }'),
    ).toEqual([]);
    expect(
      codes('  if x IS <Contact> { } else if x IS <Named> { } else { y = x.`Name` }'),
    ).toEqual([C.UNREACHABLE_BRANCH]);
  });

  it('an exhausted else has nothing left to read', () => {
    // Every member conforms to Named, so the else is `never`.
    expect(codes('  if x IS <Named> { } else { y = x.`Name` }')).toEqual([C.UNREACHABLE_BRANCH]);
    expect(messages('  if x IS <Named> { } else { y = x.`Name` }')).toContain(
      'already cover every kind',
    );
  });

  it('a test NOTHING conforms to eliminates nothing — the else is the whole union', () => {
    expect(codes('  if x IS <Impossible> { } else { y = x.`Email` }')).toEqual([C.NARROWING]);
  });

  // "I haven't looked" and "it doesn't fit" are different facts, and only the
  // second one may eliminate. A member with no published surface was never
  // compared, so the else still has to reckon with it — the chain is NOT
  // exhausted, and the read is refused for the honest reason.
  it('a member nobody has described is NOT eliminated — unknown is a third answer', () => {
    const undescribed = codes('  if x IS <Named> { } else { y = x.`Name` }', '<book-[:guarded]->>');
    expect(undescribed).not.toContain(C.UNREACHABLE_BRANCH);
    expect(undescribed).toEqual([C.UNDESCRIBED_POSITION]);
  });

  it('…and the ARM keeps it too, so the arm narrowed nothing', () => {
    // Only `company` was proved to fit, but the undescribed member could fit
    // as well — so the arm is still both, and a company-only read still needs
    // narrowing rather than reading clean off a union of one.
    expect(codes('  if x IS <Named> { y = x.`Name` }', '<book-[:guarded]->>')).toEqual([
      C.NARROWING,
    ]);
  });
});
