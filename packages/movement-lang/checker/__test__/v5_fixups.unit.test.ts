// Version 5 fix-ups the handbook found (the Rust twin is
// crates/movement-checker/tests/v5_fixups.rs): a namespace member bound or
// returned whole (`t = Date.today(z)`) reads as versions 1–4 read
// `DATE.TODAY(z)`, an expression, never a call; and a type's address names
// the event's fields through its hop's alias (`e.action`), as every WHERE
// does from 5.

import { parseProgram } from '../../parser/parse';
import { checkProgram } from '../check';
import { mockCatalog } from '../catalog';
import { eventAddressKey, eventAddressOfHops, eventAddressSource } from '../event_address';
import { typescriptCheck, upgradeSource } from '../upgrade';

const catalog = mockCatalog({ adapters: {} });

function errors(source: string, languageVersion: 4 | 5): string[] {
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion })
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => `${d.code}: ${d.message}`);
}

describe('a namespace member called whole where a value is bound', () => {
  it.each([
    'Date.today("Europe/Berlin")',
    'DateTime.at(Date.today("UTC"), "07:00", "UTC")',
    'Date.addDays(@current_date, 1)',
    'Text.regexExtract("DEAL-1", "(DEAL-\\\\d+)")',
    'Currency.numberFromFigure("£1.2m")',
    'Text.slug("a b")',
  ])('`t = %s` checks clean under 5, as its old spelling did under 4', (call) => {
    expect(errors(`function f() {\n  t = ${call}\n  return t\n}`, 5)).toEqual([]);
    expect(errors(`function f() {\n  return ${call}\n}`, 5)).toEqual([]);
  });

  it('the old spelling under 4 is unchanged', () => {
    expect(errors('movement f() {\n  t = DATE.TODAY("UTC")\n  return t\n}', 4)).toEqual([]);
  });

  it('a member the namespace does not have is still refused', () => {
    expect(errors('function f() {\n  t = Date.tomorrow("UTC")\n  return t\n}', 5).join('\n')).toMatch(/MOV_V5_UNKNOWN_MEMBER/);
  });
});

describe("an address's WHERE read through the hop's alias", () => {
  const aliased = '-[e:`Webhook Event` WHERE e.action == "record.created"]->';
  const bare = '-[:`Webhook Event` WHERE `action` == "record.created"]->';
  const address = { event: 'Webhook Event', narrowing: { action: 'record.created' } };

  it('names the same address under 5 as the bare field did under 4', () => {
    expect(eventAddressOfHops(aliased, 5)).toEqual(address);
    expect(eventAddressOfHops(bare, 4)).toEqual(address);
  });

  it('is what advice suggests: the alias form under 5, the bare field under 4, and both read back', () => {
    const address = { event: 'Webhook Event', narrowing: { action: 'record.created', 'base id': 'b' } };
    const v5 = eventAddressSource('crm', address, 5);
    expect(v5).toBe('<crm-[e:`Webhook Event` WHERE e.action == "record.created" && e.`base id` == "b"]->>');
    expect(eventAddressSource('crm', address, 4)).toBe('<crm-[:`Webhook Event` WHERE `action` == "record.created" AND `base id` == "b"]->>');
    expect(eventAddressOfHops(v5.slice('<crm'.length, -1), 5)).toEqual(address);
    expect(eventAddressSource('crm', { event: 'Webhook Event', narrowing: {} }, 5)).toBe('<crm-[:`Webhook Event`]->>');
  });

  it('is not an address under 4, as it never was', () => {
    expect(eventAddressOfHops(aliased, 4)).toBeUndefined();
    expect(eventAddressOfHops(aliased)).toBeUndefined();
  });
});

describe('a callback whose closure takes the parameters the acting side fills', () => {
  const program = (param: string) =>
    `function book(name: <text>, day: <date>) {\n  return "\${name} \${day}"\n}\n\nfunction offer() {\n  pick = callback((day: ${param}) => book("Acme", day))\n  return pick.url\n}`;

  it('reads as the closure calling the function, checked as one', () => {
    expect(errors(program('<date>'), 5)).toEqual([]);
  });

  it('holds the call to what the parameter is declared as', () => {
    expect(errors(program('<number>'), 5).join('\n')).toMatch(/MOV_CALL_ARG_TYPE/);
  });

  it('a closure with no parameters still defers the call with its arguments fixed now', () => {
    expect(errors('function chase(name: <text>) {\n  return name\n}\n\nfunction offer() {\n  again = callback(() => chase("Acme"))\n  return again.url\n}', 5)).toEqual([]);
  });

  const leaving = (subject: string, keyword: string) =>
    `${keyword} book(name: <text>, day: <date>) {\n  return "\${name} \${day}"\n}\n\n${keyword} offer() {\n  pick = callback(${subject})\n  return pick.url\n}`;

  it("a closure with no parameters that leaves its function's parameter open is an arity error from 5", () => {
    expect(errors(leaving('() => book("Acme")', 'function'), 5)).toEqual([
      "MOV_CALL_ARITY: 'book' takes 2 arguments, got 1 — a callback's closure is called with nothing, so it passes every argument itself, and what the platform sends when it fires is a parameter the closure declares: callback((d: <date>) => book(…, d))",
    ]);
  });

  it('a function named bare still leaves its parameters to the platform, and 1–4 are unchanged', () => {
    expect(errors(leaving('book', 'function'), 5)).toEqual([]);
    expect(errors(leaving('book("Acme")', 'movement'), 4)).toEqual([]);
  });

  it("offers the upgrade of `callback(f(x))` off f's signature, the open parameter declared as f declares it, for a person", () => {
    const held = upgradeSource(leaving('book("Acme")', 'movement'), typescriptCheck({ catalog }));
    expect(held.source).toContain('pick = callback(() => book("Acme"))');
    expect(held.held.map(d => d.fix?.edits[0]?.text)).toEqual(['(day: <date>) => book("Acme", day)']);
    const applied = upgradeSource(leaving('book("Acme")', 'movement'), typescriptCheck({ catalog }), { all: true });
    expect(applied.remaining).toEqual([]);
    expect(applied.source).toContain('pick = callback((day: <date>) => book("Acme", day))');
  });
});

describe("a move up across 5 warns a null test on a block's returned records", () => {
  const chat = mockCatalog({
    adapters: {
      slack: {
        constructionArgs: [],
        schema: {
          positions: {
            channel: { properties: { Name: 'text' }, edges: { Messages: { target: 'message', readable: true, sequenced: 'chronological' } } },
            message: { properties: { Text: 'text' }, edges: {} },
          },
          collections: { Channels: { target: 'channel' } },
          writableRoots: {},
        },
      },
    },
  });
  const v4 = (test: string) =>
    `import { slack } from adapters\nchat = slack()\n\nmovement go(c: <chat-[:channel]->>) {\n  found = c-[m:Messages WHERE \`Text\` == "x"]-> { return m }\n  n = IF ${test} THEN 1 ELSE 0 END\n  return n\n}`;
  const v5 = (test: string) =>
    `import { \`@lf/slack\` as slack } from adapters\nchat = connect slack\n\nfunction go(c: <chat-[:channel]->>) {\n  found = c-[m:Messages WHERE m.Text == "x"]-> { return m }\n  n = ${test} ? 1 : 0\n  return n\n}`;
  const warned = (source: string, options: { languageVersion: 4 | 5; upgradingFrom?: 4 }) =>
    checkProgram(parseProgram(source, { languageVersion: options.languageVersion }), chat, options)
      .filter((d) => d.code === 'MOV_PRESENCE_OF_RETURNED');

  it('on the v4 program checked for 5, and on its rewrite', () => {
    const [d] = warned(v4('found != NULL'), { languageVersion: 5, upgradingFrom: 4 });
    expect(d).toMatchObject({ severity: 'warning', upgrade: true });
    expect(d.message).toContain("'found != null' says whether the block returned any records into 'found'");
    expect(warned(v5('found == null'), { languageVersion: 5, upgradingFrom: 4 })).toHaveLength(1);
  });

  it('nowhere else: not under 4, not under 5 without a move up, not on EXISTS', () => {
    expect(warned(v4('found != NULL'), { languageVersion: 4 })).toEqual([]);
    expect(warned(v5('found != null'), { languageVersion: 5 })).toEqual([]);
    expect(warned(v4('EXISTS(found)'), { languageVersion: 5, upgradingFrom: 4 })).toEqual([]);
  });
});

describe('count from version 5 counts every item', () => {
  const v4 = (list: string) => `movement f(t: <text>) {\n  xs = ${list}\n  return COUNT(xs)\n}`;
  const warned = (source: string, options: { languageVersion: 4 | 5; upgradingFrom?: 4 }) =>
    checkProgram(parseProgram(source, { languageVersion: options.languageVersion }), catalog, options)
      .filter((d) => d.code === 'MOV_COUNT_COUNTS_EMPTY');

  it('a move up across 5 warns a count of a list that may hold an empty item', () => {
    const [d] = warned(v4('[t, NULL]'), { languageVersion: 5, upgradingFrom: 4 });
    expect(d).toMatchObject({ severity: 'warning', upgrade: true });
    expect(d.message).toContain('count(filter(xs, (x) => x != null))');
  });

  it('not a list of present items, and not without a move up', () => {
    expect(warned(v4('[t, "b"]'), { languageVersion: 5, upgradingFrom: 4 })).toEqual([]);
    expect(warned(v4('[t, NULL]'), { languageVersion: 4 })).toEqual([]);
  });

  it("LENGTH and EXISTS of a list are rewritten to count, marked safe: count's answer is theirs from 5", () => {
    const source = 'movement f(t: <text>) {\n  xs = [t, NULL]\n  n = LENGTH(xs)\n  ok = EXISTS(xs)\n  return n\n}';
    const fixes = checkProgram(parseProgram(source, { languageVersion: 5 }), catalog, { languageVersion: 5 })
      .filter((d) => d.code === 'MOV_V5_SPELLING' && d.fix?.edits.some((e) => e.text.startsWith('count(')))
      .map((d) => [d.fix?.edits.map((e) => e.text).join(''), d.fix?.safe]);
    expect(fixes).toEqual([
      ['count(xs)', true],
      ['count(xs) > 0', true],
    ]);
  });
});

describe('a message calls a declaration a function from 5', () => {
  const unknown = (version: 4 | 5) =>
    errors(version === 5 ? 'function f() {\n  return nope(1)\n}' : 'movement f() {\n  return nope(1)\n}', version).join('\n');

  it('under 5, and as before under 4', () => {
    expect(unknown(5)).toContain('a call names a function declared or imported here, or a built-in');
    expect(unknown(4)).toContain('a call names a movement or function declared or imported here, or a built-in');
  });
});

describe('a member read off an index from 5 binds the index first, as AT(xs, i) was', () => {
  it.each(['  r = [{ a: 1 }]\n  n = r[0].a', '  r = [[{ a: 1 }]]\n  n = r[0][0].a'])('%j checks clean', (body) => {
    expect(errors(`function f() {\n${body}\n  return n\n}`, 5)).toEqual([]);
  });
});

describe("a negative literal index from 5 reads the tuple's slot, as AT(t, -1) did", () => {
  const program = (index: string) =>
    `function g(n: <number>) {\n  return n\n}\n\nfunction f() {\n  t = ["a", 2]\n  c = t[${index}]\n  return g(c)\n}`;

  it('the last slot, not the union of every member', () => {
    expect(errors(program('-1'), 5)).toEqual([]);
    expect(errors(program('0'), 5).join('\n')).toMatch(/MOV_CALL_ARG_TYPE/);
  });
});

describe("a target's bare field is respelled through the hop's alias at its own place", () => {
  const registry = mockCatalog({
    adapters: {
      registry: {
        constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
        schema: {
          positions: { entity: { properties: { Name: 'text', City: 'text' }, edges: {} } },
          collections: { entities: { target: 'entity' } },
          writableRoots: {
            entity: { fields: { Name: 'text', City: 'text' }, resultShape: { externalId: 'text', Name: 'text', City: 'text' }, fuzzyResolution: ['Name'] },
          },
        },
      },
    },
    credentials: { public_registry: { adapter: 'registry' } },
  });
  const edits = (line: string) => {
    const source = `import { registry } from adapters\nimport { public_registry } from credentials\nreg = registry(credentials: public_registry)\nmovement main() {\n${line}\n}`;
    const d = checkProgram(parseProgram(source, { languageVersion: 5 }), registry, { languageVersion: 5, upgradingFrom: 4 }).find(
      (d) => d.code === 'MOV_V5_SPELLING' && d.message.includes("hop's alias"),
    );
    return d?.fix?.edits.map((e) => [e.span.start.col, e.span.end.col, e.text]);
  };
  const expected = (at: number) => [
    [at, at, 'e'],
    [at + 16, at + 22, 'e.`City`'],
  ];

  it('in a write or a match target as in a walk read (the colon at 14, 18 and 15)', () => {
    expect(edits('  write reg-[:entities WHERE `City` == "x"]-> { unique by (FUZZY `Name`), Name: "a" }')).toEqual(expected(14));
    expect(edits('  m = match reg-[:entities WHERE `City` == "x"]-> { unique by (FUZZY `Name`), Name: "a" }')).toEqual(expected(18));
    expect(edits('  rows = reg-[:entities WHERE `City` == "x"]->')).toEqual(expected(15));
  });
});

describe("sort by a function key is refused where SORT(xs, key) was", () => {
  const chat = mockCatalog({
    adapters: {
      slack: {
        constructionArgs: [],
        schema: {
          positions: {
            channel: { properties: { Name: 'text' }, edges: { Members: { target: 'person', readable: true } } },
            person: { properties: { Name: 'text' }, edges: {} },
          },
          collections: { Channels: { target: 'channel' } },
          writableRoots: {},
        },
      },
    },
  });
  const codes = (body: string): string[] =>
    checkProgram(
      parseProgram(`import { \`@lf/slack\` as slack } from adapters\nchat = connect slack\n\nfunction m(c: <chat-[:channel]->>) {\n${body}\n  return t\n}`, { languageVersion: 5 }),
      chat,
      { languageVersion: 5 },
    )
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => d.code);
  const names = '  names = c-[p:Members]-> { return p.Name }\n';

  it('a key read off plain values, as SORT(names, Name) was; a key of the member itself stands', () => {
    expect(codes(`${names}  t = sort(names, (r) => r.Name)`)).toEqual(['MOV_SORT_KEY_ON_SCALAR']);
    expect(codes(`${names}  t = sort(names, (r) => Text.lower(r.Name))`)).toEqual(['MOV_SORT_KEY_ON_SCALAR']);
    expect(codes(`${names}  t = sort(names, (r) => Text.lower(r))`)).toEqual([]);
  });

  it('a walk written inside the call, as SORT(c-[p:Members]->, Name) was; a bound one stands', () => {
    expect(codes('  t = count(sort(c-[p:Members]->, (r) => r.Name))')).toEqual(['MOV_SORT_KEY_ON_WALK']);
    expect(codes('  people = c-[p:Members]-> { return p }\n  t = count(sort(people, (r) => r.Name))')).toEqual([]);
  });
});

describe("a listen's pasteable signature joins its pins with 5's &&", () => {
  const ACTIONS = ['record.created', 'record.updated', 'record.deleted'];
  const change = { properties: { action: { kind: 'enum' as const, options: ACTIONS }, type: 'text' as const } };
  const variants = ACTIONS.map((action) => eventAddressKey({ event: 'Change', narrowing: { action, type: 'Ticket' } }));
  const graph = mockCatalog({
    adapters: {
      kg: {
        constructionArgs: [],
        triggerConfig: ['type', 'events'],
        triggerConfigOptions: { events: ACTIONS },
        schema: {
          positions: {
            Ticket: { properties: { Status: 'text' }, edges: {} },
            Kind: { properties: {}, edges: {}, undescribed: true },
            Change: { ...change, edges: { Record: { target: 'Kind', subject: true, requiresLiveRecord: true } } },
            ...Object.fromEntries(
              variants.map((key, i) => [key, { ...change, edges: ACTIONS[i] === 'record.deleted' ? {} : { Record: { target: 'Ticket', subject: true } } }]),
            ),
          },
          collections: {},
          unions: { [eventAddressKey({ event: 'Change', narrowing: { type: 'Ticket' } })]: variants },
          writableRoots: {},
          eventPosition: 'Change',
          eventPositions: [{ position: 'Change' }],
          eventNarrowingKeys: ['type'],
        },
      },
    },
  });

  it('under 5, where AND is an old spelling', () => {
    const source = 'import { kg } from adapters\ngraph = connect kg\nfunction m(t: <graph-[:Ticket]->>) {\n}\nlisten to graph { type: "Ticket", events: ["record.created"] } fire m';
    const [d] = checkProgram(parseProgram(source, { languageVersion: 5 }), graph, { languageVersion: 5 }).filter((d) => d.code === 'MOV_LISTEN_PARAM_MISMATCH');
    expect(d?.message).toContain("'m(event: <graph-[e:\`Change\` WHERE e.action == \"record.created\" && e.type == \"Ticket\"]->>)'");
  });
});

describe("includes inside walk brackets reads as the CONTAINS or IN written there", () => {
  const registry = mockCatalog({
    adapters: {
      registry: {
        constructionArgs: [],
        schema: { positions: { entity: { properties: { Name: 'text', City: 'text' }, edges: {} } }, collections: { entities: { target: 'entity' } }, writableRoots: {} },
      },
    },
  });
  const walk = (where: string) =>
    checkProgram(
      parseProgram(`import { registry } from adapters\nreg = connect registry\n\nfunction f() {\n  rows = reg-[e:entities WHERE ${where}]-> { return e }\n  return rows\n}`, { languageVersion: 5 }),
      registry,
      { languageVersion: 5 },
    )
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => d.code);

  it.each([['Text.includes(e.City, "a")', 'e.City CONTAINS "a"'], ['List.includes(["a", "b"], e.City)', 'e.City IN ["a", "b"]']])(
    '`%s` checks as `%s` does',
    (everyday, caps) => {
      expect(walk(everyday)).toEqual([]);
      expect(walk(caps)).toEqual([]);
      expect(walk(everyday.replace('e.City', 'e.Nope'))).toEqual(walk(caps.replace('e.City', 'e.Nope')));
      expect(walk(everyday.replace('e.City', 'e.Nope'))).toEqual(['MOV_UNKNOWN_PROPERTY']);
    },
  );
});
