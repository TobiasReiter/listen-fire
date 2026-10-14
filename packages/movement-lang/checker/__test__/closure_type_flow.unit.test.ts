// A closure's type flows wherever its value goes (language version 5), as a
// TypeScript function's does: a named function bound or handed back as a
// value, a conditional or COALESCE over closures (their union), and a race
// receipt's slot. A call through any of them is typed by what the closures it
// may be return — so a record one returns is refused in a text field, and text
// is clean.

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
  return checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version }).filter(
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
  ['IF … THEN … ELSE … END over bound closures', fn => ['  a = () => label()', `  b = () => ${fn}()`, '  c = TRUE', '  g = IF c THEN a ELSE b END', '  v = g()']],
  ['IF … THEN … ELSE … END over named functions', fn => ['  c = TRUE', `  g = IF c THEN label ELSE ${fn} END`, '  v = g()']],
  ['COALESCE over bound closures', fn => ['  a = () => label()', `  b = () => ${fn}()`, '  g = COALESCE(a, b)', '  v = g()']],
  ['COALESCE of a maybe-absent pick and a named function', fn => ['  fs = [label, label]', `  g = COALESCE(FIRST(FILTER(fs, (f) => TRUE)), ${fn})`, '  v = g()']],
  ['a race receipt slot holding a closure', fn => [`  r = await race([() => { return () => { return ${fn}() } }])`, '  g = AT(r, 0)', '  if g != null {', '    v = g()', '  ' + WRITE, '  }']],
];

const program = (body: string[]): string[] => (body.includes('  ' + WRITE) ? body : [...body, WRITE]);

describe('a closure\'s type flows through every value position (Dancing Wren, 5)', () => {
  it.each(POSITIONS)('%s: a record it returns is refused in a text field', (_label, at) => {
    expect(codes(5, program(at('made', 'label')))).toEqual(['MOV_WRITE_FIELD_TYPE']);
  });

  it.each(POSITIONS)('%s: text it returns is clean', (_label, at) => {
    expect(errorsUnder(5, program(at('label', 'label')))).toEqual([]);
  });

  it('a MAP whose members are named functions maps to closures, called with their type', () => {
    expect(codes(5, ['  fs = MAP([1, 2], (n) => made)', '  r = MAP(fs, (f) => f())', '  v = FIRST(r)', '  if v != null {', '    ' + WRITE, '  }']))
      .toEqual(['MOV_WRITE_FIELD_TYPE']);
  });

  it('under Luminous Owl (4) a named function bound to a name is still no function to call', () => {
    expect(codes(4, ['  g = label', '  v = g()', WRITE])).toEqual(['MOV_CONSTRUCT_NOT_ADAPTER']);
  });
});
