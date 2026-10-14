// Closures are values (language version 5, Dancing Wren), as TypeScript's
// functions are: a closure may be written as an element of a list literal
// (`[() => { … }, (x: <number>) => x + 1]`), and the list's element type is the
// union of its closures' types. Before 5 the closure is refused where it is
// written (MOV_EXPR_CLOSURE_POSITION) — the corpus for versions 1 to 4 pins it.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const crmSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text' }, edges: {} },
    note: { properties: { title: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
    note: { fields: { title: 'text' }, resultShape: { externalId: 'text' } },
  },
};

const catalog = mockCatalog({
  adapters: { attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema } },
  credentials: { crm_cred: { adapter: 'attio' } },
  plugins: {},
});

const PRELUDE = [
  'import { attio } from adapters',
  'import { crm_cred } from credentials',
  'crm = attio(credentials: crm_cred)',
  'function made() {',
  '  o = write crm-[:companies]-> { name: "Acme Inc." }',
  '  return o',
  '}',
].join('\n');

export const errorsUnder = (version: LanguageVersion, body: string[]): Diagnostic[] => {
  const source = `${PRELUDE}\nmovement m() {\n${body.join('\n')}\n}`;
  return checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version }).filter(
    d => (d.severity ?? 'error') === 'error',
  );
};

const codes = (version: LanguageVersion, body: string[]): string[] => errorsUnder(version, body).map(d => d.code);

describe('a closure written as a list element', () => {
  const LISTS: Array<[string, string[]]> = [
    ['a bound list', ['  fs = [() => { return 1 }, (x: <number>) => x + 1]']],
    ['a block body over lines', ['  fs = [', '    () => {', '      y = 2', '      return y', '    },', '    () => "a"', '  ]']],
    ['a MAP source', ['  out = MAP([() => { return 1 }, () => { return 2 }], (f) => { return 1 })']],
    ['beside a value', ['  fs = [1, () => { return "x" }]']],
  ];

  it.each(LISTS)('%s: refused under Luminous Owl (4)', (_label, body) => {
    expect(codes(4, body)).toContain('MOV_EXPR_CLOSURE_POSITION');
  });

  it.each(LISTS)('%s: checks clean under Dancing Wren (5)', (_label, body) => {
    expect(errorsUnder(5, body)).toEqual([]);
  });

  it('its body is checked where it is written, in the scope around the list', () => {
    expect(errorsUnder(5, ['  k = 3', '  fs = [() => { return k }]'])).toEqual([]);
    const errors = errorsUnder(5, ['  fs = [', '    () => {', '      return nope', '    }', '  ]']);
    expect(errors.map(d => d.code)).toEqual(['MOV_NAME_UNRESOLVED']);
    expect(errors[0]!.span.start.line).toBe(11);
  });

  it('a parameter no caller supplies needs a type, as a bound closure\'s does', () => {
    expect(codes(5, ['  fs = [(x) => x + 1]'])).toEqual(['MOV_PARAM_NEEDS_TYPE']);
  });

  it('a closure anywhere else in an expression is still refused by name', () => {
    expect(codes(5, ['  y = IF TRUE THEN () => { return 1 } ELSE 2 END'])).toContain('MOV_EXPR_CLOSURE_POSITION');
  });
});
