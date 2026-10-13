// The signature names the FULL address — and THE EVENT IS JUST A NODE.
//
// A movement declares the event type it accepts; a listen firing it must produce
// one that satisfies it. If it doesn't, that is a type error — the same rule as
// any call, where an argument must match a parameter. Nothing here is special to
// events.
//
// THE SILENCE THIS CLOSES. `derivedEventType` used to map a listen's `events:`
// config to a VARIANT NAME (`Record Created`), so two listens watching different
// tables produced the SAME type, compared EQUAL, and the per-listen check that
// should have caught them stayed silent BY CONSTRUCTION — the narrowing was not
// in the name being compared. Verified live, `b536a1a79`: two listens on
// different tables firing one movement gave NO diagnostic at all.
//
// THE NAMES THIS RETIRES. `Record Created`/`Updated`/`Deleted` were nominal
// names for address narrowings — `Record Created` ≡ `` Record Change WHERE
// `action` == "record.created" ``. The change kind is an ORDINARY FIELD on the
// event node (`action`, an enum of the listen's `events:` vocabulary — ONE
// namespace), pinned in the address like `base` and `table`. The projection
// synthesizes nothing; the narrowed positions are grafted on demand from the
// addresses the program names.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { mockCatalog, type SchemaFieldType, type InstanceSchema, type PositionSchema } from '../catalog';
import { eventAddressDisplay, eventAddressKey, narrowingPrefixKey } from '../event_address';

const EVENT = 'Record Change';
const ACTIONS = ['record.created', 'record.deleted'];

const deals = { base: 'appDevLoop', table: 'tblDeals' };
const contacts = { base: 'appDevLoop', table: 'tblContacts' };

const EVENT_PROPS: Record<string, SchemaFieldType> = {
  action: { kind: 'enum', options: ACTIONS },
  base: 'text',
  table: 'text',
};

/** The narrowed event positions the HOST grafts for one hop address — keyed by
 *  the opaque `eventAddressKey`, displayed by the separate
 *  `eventAddressDisplay`, the action axis left open as a union over per-action
 *  copies. Built here exactly as `listen_narrowing.ts` builds it, so this test
 *  asserts the checker AGREES on the key rather than asserting its own
 *  arithmetic. */
function grafted(hopPins: Record<string, string>, table: string) {
  const positions: Record<string, PositionSchema> = {};
  const variantKeys: string[] = [];
  for (const action of ACTIONS) {
    const narrowing = { ...hopPins, action };
    const key = eventAddressKey({ event: EVENT, narrowing });
    variantKeys.push(key);
    positions[key] = {
      properties: EVENT_PROPS,
      edges: { record: { target: table } },
      displayName: eventAddressDisplay({ event: EVENT, narrowing }),
    };
  }
  const unionKey = eventAddressKey({ event: EVENT, narrowing: hopPins });
  return {
    positions,
    unions: { [unionKey]: variantKeys },
    unionDisplayNames: { [unionKey]: eventAddressDisplay({ event: EVENT, narrowing: hopPins }) },
  };
}

/** The WIDE graft — the address that pins nothing narrows only the action axis;
 *  its variants' record edge stays on the meta type `Table`. */
function wideGraft() {
  const positions: Record<string, PositionSchema> = {};
  const variantKeys: string[] = [];
  for (const action of ACTIONS) {
    const key = eventAddressKey({ event: EVENT, narrowing: { action } });
    variantKeys.push(key);
    positions[key] = {
      properties: EVENT_PROPS,
      edges: { record: { target: 'Table' } },
      displayName: eventAddressDisplay({ event: EVENT, narrowing: { action } }),
    };
  }
  return { positions, unions: { [EVENT]: variantKeys } };
}

const dealsGraft = grafted(deals, 'at::record::deals');
const contactsGraft = grafted(contacts, 'at::record::contacts');
const wide = wideGraft();

const AIRTABLE_SCHEMA: InstanceSchema = {
  positions: {
    // The tables the addresses land on, under keys nothing parses.
    'at::record::deals': { properties: { Name: 'text' }, edges: {}, displayName: 'Deals' },
    'at::record::contacts': {
      properties: { 'Full Name': 'text' },
      edges: {},
      displayName: 'Contacts',
    },
    // The UNNARROWED event node, as the projection mints it: JUST A NODE —
    // its change kind an ordinary enum field, its record edge still on the
    // meta type.
    [EVENT]: { properties: EVENT_PROPS, edges: { record: { target: 'Table' } } },
    // The meta type an UNNARROWED event's record edge lands on. Nobody has
    // described it — an unnarrowed `Record Change` could be any table — and
    // that is `undescribed`, not open. It used to be open, which is why
    // `` e-[r:record]->.`Name` `` on a wide signature drew no diagnostics.
    Table: { properties: {}, edges: {}, undescribed: true },
    ...wide.positions,
    ...dealsGraft.positions,
    ...contactsGraft.positions,
  },
  collections: {},
  unions: { ...wide.unions, ...dealsGraft.unions, ...contactsGraft.unions },
  unionDisplayNames: { ...dealsGraft.unionDisplayNames, ...contactsGraft.unionDisplayNames },
  writableRoots: {},
  eventPosition: EVENT,
  eventPositions: [{ position: EVENT }],
  eventNarrowingKeys: ['base', 'table'],
  // What may legally be pinned at each hop, keyed by the prefix it is legal
  // under — built through `narrowingPrefixKey` exactly as the host builds it, so
  // these tests assert the checker AGREES rather than asserting their own
  // arithmetic.
  //
  // TWO BASES WITH DIFFERENT TABLES, deliberately: a fixture where every base
  // holds the same tables cannot tell a real drill-down from one global list of
  // table ids, which is precisely the 1 + N this shape exists to avoid.
  eventNarrowingValues: {
    [narrowingPrefixKey({})]: { base: ['appDevLoop', 'appOther'] },
    [narrowingPrefixKey({ base: 'appDevLoop' })]: { table: ['tblDeals', 'tblContacts'] },
    [narrowingPrefixKey({ base: 'appOther' })]: { table: ['tblOther'] },
  },
};

const catalog = mockCatalog({
  adapters: {
    airtable: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      triggerConfig: ['base', 'table', 'events'],
      triggerConfigOptions: { events: ACTIONS },
      schema: AIRTABLE_SCHEMA,
    },
  },
  credentials: { at_cred: { adapters: ['airtable'] } },
});

/** Errors only. An error diagnostic carries NO explicit severity (only warnings
 *  and infos do), so filtering on `=== 'error'` silently drops every one — which
 *  is a fine way to write a test that can never fail. */
const check = (source: string): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog).filter((d) => d.severity === undefined);

const file = (param: string, listens: string[], body: string) => `
import { airtable } from adapters
import { at_cred } from credentials

at = airtable(credentials: at_cred)

movement intake(e: ${param}) {
${body}
}
${listens.map((l) => `listen to at { ${l}, events: ["record.created"] } fire intake`).join('\n')}
`;

/** Reads the ROW, through the event's record edge. */
const program = (param: string, listens: string[]) =>
  file(param, listens, '  e-[r:record]-> { ERROR("\${r.\`Name\`}") }');

/** Reads the EVENT's own property and never touches the record edge — for the
 *  tests about which listens a signature accepts. An unnarrowed event's record
 *  edge lands on an undescribed type, and reading through it is now its own
 *  error (rightly); it must not be what a listen-matching test is measuring. */
const programNoRow = (param: string, listens: string[]) =>
  file(param, listens, '  ERROR("\${e.\`table\`}")');

const DEALS_ADDRESS =
  '<at-[:`Record Change` WHERE `action` == "record.created" AND `base` == "appDevLoop" AND `table` == "tblDeals"]->>';
const CONTACTS_ADDRESS =
  '<at-[:`Record Change` WHERE `action` == "record.created" AND `base` == "appDevLoop" AND `table` == "tblContacts"]->>';

describe('a listen must satisfy the movement signature', () => {
  it('accepts the listen whose address IS the signature', () => {
    expect(check(program(DEALS_ADDRESS, ['base: "appDevLoop", table: "tblDeals"']))).toEqual([]);
  });

  it('REJECTS a listen narrowing to another table — the measured silence', () => {
    const diagnostics = check(
      program(DEALS_ADDRESS, ['base: "appDevLoop", table: "tblContacts"']),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe(C.LISTEN_PARAM_MISMATCH);
    // It names the DISAGREEMENT — both sides, as addresses. The old diagnostic
    // blamed the READ (`MOV_UNKNOWN_PROPERTY`) and never the disagreement, and
    // a diagnostic pointing at the wrong line is its own trap.
    expect(diagnostics[0].message).toContain('table=tblContacts');
    expect(diagnostics[0].message).toContain('table=tblDeals');
    // Never the opaque identity.
    expect(diagnostics[0].message).not.toContain(
      eventAddressKey({ event: EVENT, narrowing: { ...contacts, action: 'record.created' } }),
    );
  });

  it('rejects only the listen that disagrees — the other still fires', () => {
    // Two listens, one signature. They never have to agree with EACH OTHER;
    // they each have to agree with the movement.
    const diagnostics = check(
      program(DEALS_ADDRESS, [
        'base: "appDevLoop", table: "tblDeals"',
        'base: "appDevLoop", table: "tblContacts"',
      ]),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain('table=tblContacts');
  });

  it('an UNNARROWED signature accepts any listen — a wider type, not a mechanism', () => {
    expect(
      check(
        programNoRow('<at-[:`Record Change`]->>', [
          'base: "appDevLoop", table: "tblDeals"',
          'base: "appDevLoop", table: "tblContacts"',
        ]),
      ),
    ).toEqual([]);
  });

  it('rejects a listen firing a DIFFERENT action than the signature pins', () => {
    const diagnostics = check(`
import { airtable } from adapters
import { at_cred } from credentials

at = airtable(credentials: at_cred)

movement intake(e: <at-[:\`Record Change\` WHERE \`action\` == "record.deleted" AND \`base\` == "appDevLoop" AND \`table\` == "tblDeals"]->>) {
  ERROR("\${e.\`table\`}")
}
listen to at { base: "appDevLoop", table: "tblDeals", events: ["record.created"] } fire intake
`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe(C.LISTEN_PARAM_MISMATCH);
  });

  it('rejects an action-pinned signature against a wider selection — every listen argument must fit', () => {
    // events: [created, deleted] delivers deletes too; a created-pinned
    // signature cannot take them. The union of selected pins is the argument.
    const diagnostics = check(`
import { airtable } from adapters
import { at_cred } from credentials

at = airtable(credentials: at_cred)

movement intake(e: ${DEALS_ADDRESS}) {
  ERROR("\${e.\`table\`}")
}
listen to at { base: "appDevLoop", table: "tblDeals", events: ["record.created", "record.deleted"] } fire intake
`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe(C.LISTEN_PARAM_MISMATCH);
  });

  it("types the body against the address's OWN table", () => {
    // The narrowing is REAL, not permissive: a neighbouring table's field is an
    // error rather than a null.
    const diagnostics = check(`
import { airtable } from adapters
import { at_cred } from credentials

at = airtable(credentials: at_cred)

movement intake(e: ${DEALS_ADDRESS}) {
  e-[r:record]-> { ERROR("\${r.\`Full Name\`}") }
}
listen to at { base: "appDevLoop", table: "tblDeals", events: ["record.created"] } fire intake
`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe(C.UNKNOWN_PROPERTY);
    // Reported against the table's DISPLAY name — the key is unspeakable.
    expect(diagnostics[0].message).toContain('Deals');
  });
});

describe('IS narrows by EXTENDING the subject address — an intersection', () => {
  it('an action-only IS on a table-pinned subject lands on the grafted variant', () => {
    // The subject already pins base+table; the IS adds only the action —
    // TS's `A & B`, no restating the address.
    const source = `
import { airtable } from adapters
import { at_cred } from credentials

at = airtable(credentials: at_cred)

movement intake(e: <at-[:\`Record Change\` WHERE \`base\` == "appDevLoop" AND \`table\` == "tblDeals"]->>) {
  if e IS <at-[:\`Record Change\` WHERE \`action\` == "record.created"]->> {
    e-[r:record]-> { ERROR("\${r.\`Name\`}") }
  }
}
listen to at { base: "appDevLoop", table: "tblDeals" } fire intake
`;
    expect(check(source)).toEqual([]);
  });

  it("a typo'd action pin in an IS dies at the event node's enum", () => {
    const source = `
import { airtable } from adapters
import { at_cred } from credentials

at = airtable(credentials: at_cred)

movement intake(e: <at-[:\`Record Change\` WHERE \`base\` == "appDevLoop" AND \`table\` == "tblDeals"]->>) {
  if e IS <at-[:\`Record Change\` WHERE \`action\` == "record.craeted"]->> {
    ERROR("\${e.\`table\`}")
  }
}
listen to at { base: "appDevLoop", table: "tblDeals" } fire intake
`;
    const diagnostics = check(source);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe(C.ENUM_UNKNOWN_VALUE);
    expect(diagnostics[0].message).toContain('Did you mean "record.created"?');
  });
});

describe('the address grammar', () => {
  const parses = (param: string) => () => parseProgram(program(param, []));

  it('parses the `->>` close — scanHop takes `-[…]->`, then `>` closes the marker', () => {
    expect(parses(DEALS_ADDRESS)).not.toThrow();
    expect(parses('<at-[:`Record Change`]->>')).not.toThrow();
  });

  it('parses an address spanning lines, as any hop WHERE may', () => {
    expect(
      parses('<at-[:`Record Change`\n      WHERE `base` == "appDevLoop" AND `table` == "tblDeals"]->>'),
    ).not.toThrow();
  });

  it('the dotted TYPE marker is retired — a parse error with the exact address replacement', () => {
    expect(parses('<at.`Record Change`>')).toThrow(
      /Write '<at-\[:`Record Change`\]->>' instead of '<at\.`Record Change`>'/,
    );
    // The old name-AND-address hybrid dies at the dot too.
    expect(parses('<at.`Record Change`-[:record]->>')).toThrow(/'\.' reads a property/);
  });

  it('the unpinned address form typechecks where the dotted form used to', () => {
    expect(
      check(programNoRow('<at-[:`Record Change`]->>', ['base: "appDevLoop", table: "tblDeals"'])),
    ).toEqual([]);
  });

});

// ── The typo dies at the comparison, and the handle dies at the USE ──
//
// 2026-07-17: "I'd potentially argue that it shouldn't throw at the
// narrow… but it should throw if we try to do anything with the handle. Where it
// should probably error is that the typo should be comparing to a known enum, and
// so we should get an error on `enum == "string literal that's not in the enum"`."
//
// Both halves are TypeScript's own answers. A narrowing that matches nothing is
// `never` — the CORRECT type, exactly as `if (x === "nope")` on `x: "a" | "b"` —
// so erroring at the narrow would be erroring at a true statement. And a typo'd
// literal against a known value set is an enum error with a did-you-mean, which
// `MOV_ENUM_UNKNOWN_VALUE` already did and simply never reached the event node.

describe('an address pin is an ENUM comparison', () => {
  const withTable = (base: string, table: string) =>
    program(`<at-[:\`Record Change\` WHERE \`base\` == "${base}" AND \`table\` == "${table}"]->>`, []);

  it('a typo\'d table is MOV_ENUM_UNKNOWN_VALUE with a did-you-mean — not a read error', () => {
    const diagnostics = check(withTable('appDevLoop', 'tblDaels'));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe(C.ENUM_UNKNOWN_VALUE);
    expect(diagnostics[0].message).toContain('Did you mean "tblDeals"?');
    // The error is the TYPO, at the pin. Not MOV_UNKNOWN_PROPERTY downstream,
    // and not a complaint that the address resolved to nothing — that part is
    // `never`, and `never` is right.
    expect(diagnostics.map((d) => d.code)).not.toContain(C.UNKNOWN_POSITION);
  });

  it("a typo'd ACTION pin dies at the event node's own enum", () => {
    const diagnostics = check(
      program(
        '<at-[:`Record Change` WHERE `action` == "record.craeted" AND `base` == "appDevLoop" AND `table` == "tblDeals"]->>',
        [],
      ),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe(C.ENUM_UNKNOWN_VALUE);
    expect(diagnostics[0].message).toContain('Did you mean "record.created"?');
  });

  it("checks `table` against THAT base's tables — the options are not one global list", () => {
    // `tblDeals` is real, and legal under appDevLoop. Under appOther it is not,
    // and saying so is the whole variance rule: `table` becomes an enum only
    // once `base` is narrowed.
    const diagnostics = check(withTable('appOther', 'tblDeals'));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe(C.ENUM_UNKNOWN_VALUE);
    expect(diagnostics[0].message).toContain('tblOther');
  });

  it("a typo'd base is reported, and the table is left ALONE", () => {
    // Exactly one diagnostic: the hop that is actually wrong. A base nobody has
    // is a base whose tables are unknowable, and guessing at them would mean
    // enumerating tables across every base — the 1 + N this plan exists to kill,
    // arrived at while diagnosing a typo.
    const diagnostics = check(withTable('appDevLop', 'tblDeals'));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe(C.ENUM_UNKNOWN_VALUE);
    expect(diagnostics[0].message).toContain('Did you mean "appDevLoop"?');
    expect(diagnostics[0].message).not.toContain('tblDeals');
  });

  it('says nothing about an address whose pins are all legal', () => {
    // `tblContacts` is legal under `appDevLoop`, and the Contacts row really has
    // no `Name` — so read ITS field, not Deals'. A pin check that passes must
    // leave the body's own checks exactly as they were.
    expect(
      check(file(CONTACTS_ADDRESS, [], '  e-[r:record]-> { ERROR("\${r.\`Full Name\`}") }')),
    ).toEqual([]);
  });

  it('stays silent when nobody published what is legal here', () => {
    // An adapter that declares address hops but whose walk couldn't answer.
    // Unknown never becomes an accusation.
    const blind = mockCatalog({
      adapters: {
        airtable: {
          constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
          triggerConfig: ['base', 'table', 'events'],
          schema: { ...AIRTABLE_SCHEMA, eventNarrowingValues: undefined },
        },
      },
      credentials: { at_cred: { adapters: ['airtable'] } },
    });
    const diagnostics = checkProgram(
      parseProgram(withTable('appDevLoop', 'tblDaels')),
      blind,
    ).filter((d) => d.severity === undefined);
    expect(diagnostics).toEqual([]);
  });
});

describe('touching an UNDESCRIBED handle is an error', () => {
  it('reads through an unnarrowed event\'s record edge — the measured silence', () => {
    // ```
    // movement intake(e: <at-[:`Record Change`]->>) {
    //   e-[r:record]-> { … r.`Name` … }     # used to be NO diagnostics
    // }
    // ```
    // `r` targets the meta type `Table`: an unnarrowed event's record could be
    // ANY table, so nothing describes it. It used to project OPEN — "I haven't
    // looked" and "anything goes" spelled the same way — so the read compiled
    // and returned null at run time.
    const diagnostics = check(program('<at-[:`Record Change`]->>', []));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe(C.UNDESCRIBED_POSITION);
    expect(diagnostics[0].message).toContain('at.Table');
    expect(diagnostics[0].message).toContain('Name');
  });

  it('says nothing when the signature pins the table — the handle IS described', () => {
    expect(check(program(DEALS_ADDRESS, []))).toEqual([]);
  });

  // PENDING is the third fact, and it must not borrow either of the other two
  // spellings. Same program, same unreachable surface — but the reason is "the
  // fetch has not come back yet", not "nobody will ever look". An editor that
  // fills positions lazily hits this on every keystroke while a walk is in
  // flight, so reporting here would flash errors that clear themselves.
  //
  // Asserted against the SAME program as the undescribed case above, because
  // the only thing that may differ between them is the flag.
  it('stays silent while the position is PENDING — the answer is still coming', () => {
    const pendingCatalog = mockCatalog({
      adapters: {
        airtable: {
          constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
          triggerConfig: ['base', 'table', 'events'],
          triggerConfigOptions: { events: ACTIONS },
          schema: {
            ...AIRTABLE_SCHEMA,
            positions: {
              ...AIRTABLE_SCHEMA.positions,
              Table: { properties: {}, edges: {}, pending: true },
            },
          },
        },
      },
      credentials: { at_cred: { adapters: ['airtable'] } },
    });
    const diagnostics = checkProgram(
      parseProgram(program('<at-[:`Record Change`]->>', [])),
      pendingCatalog,
    ).filter((d) => d.severity === undefined);
    expect(diagnostics).toEqual([]);
  });
});
