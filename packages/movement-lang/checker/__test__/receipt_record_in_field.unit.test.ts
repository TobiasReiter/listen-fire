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

const errorsUnder = (version: LanguageVersion, body: string[]): Diagnostic[] => {
  const source = `${PRELUDE}\nmovement m() {\n${body.join('\n')}\n}`;
  return checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version }).filter(
    d => (d.severity ?? 'error') === 'error',
  );
};

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
    it('the whole receipt into a written field', () => {
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

    it('the whole receipt into a graph entry; the record slot alone is an edge, as a list literal\'s is', () => {
      refused([...arms, '  g = graph { a: r }'], 'MOV_GRAPH_ENTRY_RECORD', "'a' is a field, and 'r[0]' is a crm.company handle");
      expect(errorsUnder(version, [...arms, '  g = graph { a: AT(r, 0) }'])).toEqual([]);
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
    return checkProgram(parseProgram(withFound, { languageVersion: version }), catalog, { languageVersion: version }).filter(
      d => (d.severity ?? 'error') === 'error',
    );
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
