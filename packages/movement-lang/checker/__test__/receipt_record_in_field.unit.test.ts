// A `parallel` / `race` receipt is a list of what its arms returned — the
// nearest simpler construct is `[a(), b()]` — so a record an arm hands back (a
// write handle, a found record) is one the receipt, and a slot of it
// (`AT(r, i)`), may hold. Written into a field, a graph entry, a plugin
// argument or an extraction input, the engine handed its own handle object
// onward (serialized `{"kind":"handle",…}` on TypeScript). The receipt now
// carries what its arms' returns may hold, as a call's value does (B14), for
// inline closure arms, named closure arms and named movement arms alike.
//
// A bug fix — the forms always leaked an engine object — so on every version
// (1, 3, 4 and 5 asserted). Arms that hand back values leave the receipt plain
// data, and it is written.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { applyFix } from '../fixes';
import { InstanceSchema, mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const crmSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text' }, edges: {} },
    note: { properties: { title: 'text', company: 'json' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
    note: { fields: { title: 'text', company: 'json' }, resultShape: { externalId: 'text' } },
  },
};

const ledgerSchema: InstanceSchema = {
  positions: { entry: { properties: { Amount: 'number', Meta: 'json' }, edges: {} } },
  collections: { entries: { target: 'entry' } },
  writableRoots: {
    entry: { fields: { Amount: 'number', Meta: 'json' }, resultShape: { externalId: 'text' } },
  },
};

const catalog = mockCatalog({
  adapters: {
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema },
    ledger: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: ledgerSchema },
  },
  credentials: { crm_cred: { adapter: 'attio' }, ledger_cred: { adapter: 'ledger' } },
  plugins: {
    summarise: {
      args: ['data'],
      argTypes: { data: 'json' },
      requiredArgs: ['data'],
      effects: { ai: true },
      output: { kind: 'value', type: 'text' },
    },
  },
});

const PRELUDE = [
  'import { attio, ledger } from adapters',
  'import { crm_cred, ledger_cred } from credentials',
  'import { summarise } from plugins',
  '',
  'crm = attio(credentials: crm_cred)',
  'l = ledger(credentials: ledger_cred)',
  '',
  'function made() {',
  '  o = write crm-[:companies]-> { name: "Acme Inc." }',
  '  return o',
  '}',
  'function label() {',
  '  return "label"',
  '}',
].join('\n');

const checkUnder = (version: LanguageVersion, source: string): Diagnostic[] =>
  checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version }).filter(
    d => (d.severity ?? 'error') === 'error',
  );

/**
 * `parallel` is retired under 5 (MOV_PARALLEL_RETIRED), so under 5 each
 * program here is checked as the checker's own fix rewrites it — the MAP over
 * the arms — which must answer what the receipt did. Arms built at run time
 * have no fix (their concurrency is the author's), and are rewritten the same
 * way by hand.
 */
const errorsUnder = (version: LanguageVersion, body: string[]): Diagnostic[] =>
  checkUnder(version, rewrittenUnder(version, `${PRELUDE}\nmovement m() {\n${body.join('\n')}\n}`));

function rewrittenUnder(version: LanguageVersion, written: string): string {
  let source = written;
  if (version >= 5) {
    source = source.replace(/await parallel\((\w+)\)/g, 'MAP($1, { concurrency: 2 }, (f) => f())');
    for (let guard = 0; guard < 5; guard++) {
      const retired = checkUnder(version, source).find(d => d.code === 'MOV_PARALLEL_RETIRED');
      if (retired?.fix === undefined) break;
      source = applyFix(source, retired.fix);
    }
  }
  return source;
}

/** The receipt `r`, its first arm handing back a write handle, its second text. */
const ARMS: Array<[string, string[]]> = [
  [
    'inline closure arms',
    [
      '  r = await parallel([',
      '    () => {',
      '      o = write crm-[:companies]-> { name: "Acme Inc." }',
      '      return o',
      '    },',
      '    () => { return "x" },',
      '  ])',
    ],
  ],
  [
    'named closure arms',
    [
      '  c = () => {',
      '    o = write crm-[:companies]-> { name: "Acme Inc." }',
      '    return o',
      '  }',
      '  t = () => { return "x" }',
      '  r = await parallel([c, t])',
    ],
  ],
  ['named movement arms', ['  r = await parallel([made, label])']],
  ['a race of named movement arms', ['  r = await race([made, label])']],
];

const RECORD_NOT_A_VALUE = 'a record, not a value';
const note = (company: string): string => `  write crm-[:notes]-> { title: "hello", company: ${company} }`;

describe.each([1, 3, 4, 5] as LanguageVersion[])('under language version %i, a receipt holds what its arms return', version => {
  const refused = (body: string[], code: string, said: string): void => {
    const errors = errorsUnder(version, body);
    expect(errors.map(d => d.code)).toEqual([code]);
    expect(errors[0]!.message).toContain(said);
    expect(errors[0]!.message).toContain('crm.company handle');
  };

  describe.each(ARMS)('%s', (_label, arms) => {
    // Under 5 the receipt is the MAP's answer, a tuple of a record and text,
    // which read whole is also the mixed list the literal `[made(), "x"]` is.
    const mixed = version >= 5 && arms.some(line => line.includes('parallel'));

    it('the whole receipt into a written field', () => {
      if (mixed) {
        const codes = errorsUnder(version, [...arms, note('r')]).map(d => d.code).sort();
        expect(codes).toEqual(['MOV_LIST_MIXED', 'MOV_WRITE_FIELD_TYPE']);
        expect(errorsUnder(version, ['  r = [made(), "x"]', note('r')]).map(d => d.code).sort()).toEqual(codes);
        return;
      }
      refused([...arms, note('r')], 'MOV_WRITE_FIELD_TYPE', `'company[0]' is a crm.company handle — ${RECORD_NOT_A_VALUE}`);
    });

    it('the whole receipt under a key of a written field', () => {
      refused([...arms, note('{ x: r }')], 'MOV_WRITE_FIELD_TYPE', `'company.x[0]' is a crm.company handle — ${RECORD_NOT_A_VALUE}`);
    });

    it('a slot of it into a written field, and into the second shape', () => {
      refused([...arms, note('{ x: AT(r, 0) }')], 'MOV_WRITE_FIELD_TYPE', `'company.x' is a crm.company handle — ${RECORD_NOT_A_VALUE}`);
      refused(
        [...arms, '  write l-[:entries]-> { Amount: 1, Meta: { by: AT(r, 0) } }'],
        'MOV_WRITE_FIELD_TYPE',
        "'Meta' on l.entry is json, and 'Meta.by' is a crm.company handle",
      );
    });

    it('a slot of it, bound to a name, into a written field', () => {
      refused([...arms, '  h = AT(r, 0)', note('{ x: h }')], 'MOV_WRITE_FIELD_TYPE', RECORD_NOT_A_VALUE);
    });

    it('a receipt mixing a record with a value stays refused as a graph entry, and the message offers the slot', () => {
      const errors = errorsUnder(version, [...arms, '  g = graph { a: r }']).filter(d => !mixed || d.code !== 'MOV_LIST_MIXED');
      if (mixed) expect(errorsUnder(version, ['  r = [made(), "x"]', '  g = graph { a: r }']).map(d => d.code)).toContain('MOV_LIST_MIXED');
      expect(errors.map(d => d.code)).toEqual(['MOV_GRAPH_ENTRY_RECORD']);
      expect(errors[0]!.message).toContain("'r[0]' is a crm.company handle");
      expect(errors[0]!.message).toContain("'a: AT(r, 0)'");
      expect(errors[0]!.message).not.toContain("'a: r'");
    });

    it('a literal index picks its own slot: the value slot is written', () => {
      expect(errorsUnder(version, [...arms, note('{ x: AT(r, 1) }'), '  s = summarise(data: { a: AT(r, 1) })'])).toEqual([]);
    });

    it('into a plugin argument, whole and as a slot', () => {
      refused([...arms, '  s = summarise(data: { a: r })'], 'MOV_CALL_ARG_TYPE', "'summarise' takes structured data for 'data', and 'data.a[0]' is");
      refused([...arms, '  s = summarise(data: { a: AT(r, 0) })'], 'MOV_CALL_ARG_TYPE', "and 'data.a' is a crm.company handle");
    });

    it('a field read off the record slot is a value, and is written', () => {
      expect(errorsUnder(version, [...arms, '  h = AT(r, 0)', note('{ x: h.name }')])).toEqual([]);
    });
  });

  describe('records only', () => {
    it('a receipt of record slots is an edge list at a graph entry, parallel and race', () => {
      expect(errorsUnder(version, ['  r = await parallel([made, made])', '  g = graph { a: r }'])).toEqual([]);
      expect(errorsUnder(version, ['  r = await race([made, made])', '  g = graph { a: r }'])).toEqual([]);
      expect(errorsUnder(version, ['  g = graph { a: [made(), made()] }'])).toEqual([]);
    });

    it('but the same receipt in a field is still refused', () => {
      const errors = errorsUnder(version, ['  r = await parallel([made, made])', note('r')]);
      expect(errors.map(d => d.code)).toEqual(['MOV_WRITE_FIELD_TYPE']);
    });

    it('AT of a record slot is an edge, not a field holding the handle', () => {
      expect(errorsUnder(version, ['  r = await parallel([made, label])', '  g = graph { a: AT(r, 0) }'])).toEqual([]);
      expect(errorsUnder(version, ['  r = await parallel([made, label])', '  h = AT(r, 0)', '  g = graph { a: h }'])).toEqual([]);
    });
  });

  describe('arms known from a name or a MAP', () => {
    const NAMED: Array<[string, string[]]> = [
      ['a named list of movements', ['  arms = [made, label]', '  r = await parallel(arms)']],
      ['a named list of closures', ['  c = () => { return made() }', '  t = () => { return "x" }', '  arms = [c, t]', '  r = await race(arms)']],
    ];
    const MAPPED: Array<[string, string[]]> = [
      ['a MAP of closures', ['  arms = MAP([1, 2], (n) => { return () => { return made() } })', '  r = await parallel(arms)']],
      ['a MAP of closures, race', ['  arms = MAP([1, 2], (n) => { return () => { return made() } })', '  r = await race(arms)']],
    ];

    it.each([...NAMED, ...MAPPED])('%s: a record slot reaching a field is refused', (_label, arms) => {
      const errors = errorsUnder(version, [...arms, note('{ x: AT(r, 0) }')]);
      expect(errors.map(d => d.code)).toEqual(['MOV_WRITE_FIELD_TYPE']);
      expect(errors[0]!.message).toContain('crm.company handle');
    });

    it.each([...NAMED, ...MAPPED])('%s: and into a plugin argument', (_label, arms) => {
      expect(errorsUnder(version, [...arms, '  s = summarise(data: { a: AT(r, 0) })']).map(d => d.code)).toEqual(['MOV_CALL_ARG_TYPE']);
    });

    it('a named list that hands back values leaves the receipt plain data', () => {
      for (const arms of [
        ['  arms = [label, label]', '  r = await parallel(arms)'],
        ['  arms = MAP([1, 2], (n) => { return () => { return "x" } })', '  r = await parallel(arms)'],
      ]) {
        expect(errorsUnder(version, [...arms, note('{ x: AT(r, 0) }')])).toEqual([]);
      }
    });

    it('arms filtered at run time: untyped before 5 (a lower bound, pinned); typed from 5', () => {
      const errors = errorsUnder(version, [
        '  arms = FILTER([made, label], (a) => { return true })',
        '  r = await parallel(arms)',
        note('{ x: AT(r, 0) }'),
      ]);
      // Before 5 a function read as a value has no type, so the receipt is
      // untyped and the record slot reaches the field (KNOWN GAP). From 5 a
      // function is a closure value, and FILTER keeps its element type: the
      // receipt may hold the record `made` returns.
      expect(errors.map(d => d.code)).toEqual(version >= 5 ? ['MOV_WRITE_FIELD_TYPE'] : []);
    });
  });

  describe('arms that hand back values', () => {
    const TEXT: Array<[string, string[]]> = [
      ['inline closure arms', ['  r = await parallel([() => { return "a" }, () => { return "b" }])']],
      ['named closure arms', ['  c = () => { return "a" }', '  r = await parallel([c, c])']],
      ['named movement arms', ['  r = await parallel([label, label])']],
      ['a race of named movement arms', ['  r = await race([label, label])']],
    ];

    it.each(TEXT)('%s: the receipt is plain data, written into every sink', (_label, arms) => {
      for (const sink of [
        note('r'),
        note('{ x: r }'),
        note('{ x: AT(r, 0) }'),
        '  g = graph { a: AT(r, 0) }',
        '  s = summarise(data: { a: r, b: AT(r, 1) })',
      ]) {
        expect(errorsUnder(version, [...arms, sink])).toEqual([]);
      }
    });
  });
});

describe.each([1, 3, 4, 5] as LanguageVersion[])('under language version %i, an extraction input', version => {
  // An extraction reads a record as its fields: a record the run wrote has
  // them in hand (accepted, as the direct form is); a system's record found by
  // an arm does not, so it is refused in a receipt as it is bare.
  const FOUND = ['  r = await parallel([found, label])'];
  const extract = (input: string): string[] => [`  d = extract from [${input}] {`, '    a: "the thing"', '  }'];
  const source = (body: string[]): Diagnostic[] => {
    const withFound = `${PRELUDE}\nfunction found() {\n  c = ONLY(crm-[:companies]->)\n  return c\n}\nmovement m() {\n${body.join('\n')}\n}`;
    return checkUnder(version, rewrittenUnder(version, withFound));
  };

  it('a found record in a slot is refused as an input', () => {
    const errors = source([...FOUND, ...extract('{ k: AT(r, 0) }')]);
    expect(errors.map(d => d.code)).toEqual(['MOV_EXTRACT_CONTENT']);
    expect(errors[0]!.message).toContain("'{ k: AT(r, 0) }' holds crm.company");
  });

  it('a written record in a slot is an input, as the direct form is', () => {
    expect(source([...ARMS[2]![1], ...extract('{ k: AT(r, 0) }')])).toEqual([]);
  });
});
