// A closure is never held under a key (language version 5). There are no
// methods: a dot on a record or map always reads a field, so a closure lives
// in a variable or a list — never as a map's value, whichever way the map is
// built (`MOV_CLOSURE_UNDER_KEY`). A list of closures under a key is a list,
// and stays. Before 5 a closure is not a value at all, and nothing changes.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const crmSchema: InstanceSchema = {
  positions: { note: { properties: { title: 'text' }, edges: {} } },
  collections: { notes: { target: 'note' } },
  writableRoots: { note: { fields: { title: 'text' }, resultShape: { externalId: 'text' } } },
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
  'function label() {',
  '  return "label"',
  '}',
].join('\n');

const errorsUnder = (version: LanguageVersion, functions: string[], body: string[]): Diagnostic[] => {
  const source = `${PRELUDE}\n${functions.join('\n')}\nmovement m() {\n${body.join('\n')}\n}`;
  return checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version }).filter(
    d => (d.severity ?? 'error') === 'error',
  );
};
const codes = (functions: string[], body: string[]): string[] => errorsUnder(5, functions, body).map(d => d.code);

describe('a closure is never held under a key (Dancing Wren, 5)', () => {
  it.each<[string, string[], string[]]>([
    ['a named function as a map value', [], ['  box = { g: label }']],
    ['a bound closure as a map value', [], ['  g = () => 1', '  box = { g: g }']],
    ['a value that may be a closure', [], ['  fs = [label]', '  box = { g: FIRST(fs) }']],
    ['one arm of a conditional', [], ['  c = TRUE', '  box = { g: IF c THEN label ELSE 1 END }']],
    ['a map a function returns', ['function mk() {', '  return { g: label }', '}'], ['  b = mk()']],
    ['a map a MAP builds per member', [], ['  fs = [label]', '  d = MAP(fs, (f) => { return { g: f } })']],
    ['a map inside a list', [], ['  d = [{ g: label }]']],
    ['KEYBY over closures', [], ['  fs = [label]', '  d = KEYBY(fs, (f) => "k")']],
  ])('%s is refused', (_label, functions, body) => {
    expect(codes(functions, body)).toEqual(['MOV_CLOSURE_UNDER_KEY']);
  });

  it('the message says where a closure lives instead', () => {
    const [error] = errorsUnder(5, [], ['  box = { g: label }']);
    expect(error!.message).toContain("'g' holds a closure");
    expect(error!.message).toContain('in a variable');
    expect(error!.message).toContain('in a list');
  });

  it('a closure written in place under a key is refused where it is written', () => {
    expect(codes([], ['  box = { g: () => 1 }'])).toEqual(['MOV_EXPR_CLOSURE_POSITION']);
  });

  it.each<[string, string[]]>([
    ['a list of closures under a key', ['  box = { fs: [label] }']],
    ['GROUPBY over closures (each key holds a list)', ['  fs = [label]', '  d = GROUPBY(fs, (f) => "k")']],
    ['a MAP config beside a list of closures', ['  fs = [label]', '  r = MAP(fs, { concurrency: 2 }, (f) => f())']],
  ])('%s stays', (_label, body) => {
    expect(errorsUnder(5, [], body)).toEqual([]);
  });

  it.each<LanguageVersion>([1, 2, 3, 4])('version %s is unchanged', version => {
    expect(errorsUnder(version, [], ['  box = { g: label }']).map(d => d.code)).not.toContain('MOV_CLOSURE_UNDER_KEY');
  });
});
