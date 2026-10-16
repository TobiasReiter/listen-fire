// A closure's type flows wherever its value goes (language version 5), as a
// TypeScript function's does: a named function bound or handed back as a
// value, and a closure an `all` arm captures. A call through any of them is
// typed by what the closure returns — so a record it returns is refused in a
// text field, and text is clean. IF and COALESCE never choose between closures:
// a closure is not data (closure_not_data).

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';
import { spelledFor } from './surface_spelling';

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
  'function label() {',
  '  return "label"',
  '}',
  'function pickMade() {',
  '  return made',
  '}',
  'function pickLabel() {',
  '  return label',
  '}',
].join('\n');

const errorsUnder = (version: LanguageVersion, body: string[]): Diagnostic[] => {
  const source = `${PRELUDE}\nmovement m() {\n${body.join('\n')}\n}`;
  return checkProgram(parseProgram(spelledFor(version, source, catalog), { languageVersion: version }), catalog, { languageVersion: version }).filter(
    d => (d.severity ?? 'error') === 'error',
  );
};
const codes = (version: LanguageVersion, body: string[]): string[] => errorsUnder(version, body).map(d => d.code);

const WRITE = '  write crm-[:notes]-> { title: v }';

/** Each position, once with a closure that returns a record (`rec`) and once
 *  with one that returns text (`txt`). */
const POSITIONS: Array<[string, (rec: string, txt: string) => string[]]> = [
  ['a named function bound to a name', fn => [`  g = ${fn}`, '  v = g()']],
  ['a named function a concise closure returns', fn => [`  mk = () => ${fn}`, '  h = mk()', '  v = h()']],
  ['a named function a block closure returns', fn => [`  mk = () => { return ${fn} }`, '  h = mk()', '  v = h()']],
  ['a named function a declared function returns', fn => [`  h = ${fn === 'made' ? 'pickMade' : 'pickLabel'}()`, '  v = h()']],
  ['a closure an all arm captures and calls', fn => [`  g = ${fn}`, '  r = all(() => { return g() })', '  v = AT(r, 0)']],
];

const program = (body: string[]): string[] => (body.includes('  ' + WRITE) ? body : [...body, WRITE]);

describe('a closure\'s type flows through every value position (Dancing Wren, 5)', () => {
  it.each(POSITIONS)('%s: a record it returns is refused in a text field', (_label, at) => {
    expect(codes(5, program(at('made', 'label')))).toEqual(['MOV_WRITE_FIELD_TYPE']);
  });

  it.each(POSITIONS)('%s: text it returns is clean', (_label, at) => {
    expect(errorsUnder(5, program(at('label', 'label')))).toEqual([]);
  });

  it('a MAP whose members would be closures is refused: a closure is not data', () => {
    expect(codes(5, ['  fs = MAP([1, 2], (n) => made)'])).toEqual(['MOV_CLOSURE_NOT_DATA']);
  });

  it('under Luminous Owl (4) a named function bound to a name is still no function to call', () => {
    expect(codes(4, ['  g = label', '  v = g()', WRITE])).toEqual(['MOV_CONSTRUCT_NOT_ADAPTER']);
  });
});
