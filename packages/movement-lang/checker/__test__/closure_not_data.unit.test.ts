// A closure is not data (language version 5). A closure lives in a variable
// (`g = label`, a call that answers one), in a parameter, or is passed as an
// argument to a parameter that takes one (`MAP(xs, (x) => …)`, `race(a, b)`,
// `all(a, b)`, a closure-typed parameter) — never in a list, a record, a map, a
// field, a collection op's answer or a combinator's receipt, and never as an
// operand of a value expression: an IF's arm, COALESCE's argument, a
// comparison, interpolation, arithmetic, a condition, a built-in's argument
// (`MOV_CLOSURE_NOT_DATA`). There are no methods, either: a dot on a record or
// map always reads a field. Before 5 a closure is not a value at all, and
// nothing changes.

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

describe('a closure is not data (Dancing Wren, 5)', () => {
  it.each<[string, string[], string[]]>([
    // A list's element.
    ['a named function in a list', [], ['  fs = [label]']],
    ['a bound closure in a list', [], ['  g = () => 1', '  fs = [g]']],
    ['a closure written in a list', [], ['  fs = [() => { return 1 }]']],
    ['a closure beside a value', [], ['  fs = [1, label]']],
    ['one arm of a conditional in a list', [], ['  c = TRUE', '  fs = [IF c THEN label ELSE 1 END]']],
    ['a call that answers a closure, in a list', ['function mk() {', '  return label', '}'], ['  fs = [mk()]']],
    // A record or map's value.
    ['a named function as a map value', [], ['  box = { g: label }']],
    ['a bound closure as a map value', [], ['  g = () => 1', '  box = { g: g }']],
    ['a closure written as a map value', [], ['  box = { g: () => 1 }']],
    ['one arm of a conditional as a map value', [], ['  c = TRUE', '  box = { g: IF c THEN label ELSE 1 END }']],
    ['a map a function returns', ['function mk() {', '  return { g: label }', '}'], ['  b = mk()']],
    // A field written.
    ['a field written', [], ['  g = label', '  write crm-[:notes]-> { title: g }']],
    // A collection op's answer.
    ['a MAP whose function returns a closure', [], ['  d = MAP([1, 2], (x) => { return label })']],
    ['a MAP whose function returns a map holding one', [], ['  d = MAP([1, 2], (x) => { return { g: label } })']],
    // An operand of a value expression.
    ['IF … THEN … ELSE … END choosing between closures', [], ['  c = TRUE', '  h = () => "b"', '  g = IF c THEN label ELSE h END']],
    ['IF … THEN … ELSE … END with one closure arm', [], ['  c = TRUE', '  g = IF c THEN label ELSE "x" END']],
    ['COALESCE over closures', [], ['  h = () => "b"', '  g = COALESCE(label, h)']],
    ['a comparison', [], ['  h = () => "b"', '  x = h == label']],
    ['interpolation', [], ['  x = "v ${label}"']],
    ['arithmetic', [], ['  h = () => 1', '  x = h + 1']],
    ['a negation', [], ['  h = () => 1', '  x = -h']],
    ['NOT', [], ['  x = NOT label']],
    ['AND', [], ['  x = label AND TRUE']],
    ['a built-in that takes no function', [], ['  x = UPPER(label)']],
    ['a condition', [], ['  if label {', '    x = 1', '  }']],
    // A combinator's receipt.
    ['an all arm that returns a closure', [], ['  r = all(() => { return label })']],
    ['a race arm that returns a closure', [], ['  r = race(() => { return label })']],
  ])('%s is refused', (_label, functions, body) => {
    expect(codes(functions, body)).toEqual(['MOV_CLOSURE_NOT_DATA']);
  });

  it.each<[string, string[], string[]]>([
    ['a list of closures as a parameter\'s type', ['function run(fs: <() => <text>>[]) {', '  return 1', '}'], []],
    ['a record type\'s key typed as a closure', ['function run(box: <{ g: <() => <text>> }>) {', '  return 1', '}'], []],
  ])('%s is refused where the type is written', (_label, functions, body) => {
    expect(codes(functions, body)).toEqual(['MOV_CLOSURE_NOT_DATA']);
  });

  it('a value typed as holding closures is refused again wherever it is kept: a spread, KEYBY, GROUPBY', () => {
    const go = ['function go(xs: <() => <text>>[]) {', '  ys = [...xs]', '  d = KEYBY(xs, (f) => "k")', '  e = GROUPBY(xs, (f) => "k")', '  return 1', '}'];
    const messages = errorsUnder(5, go, ['  v = 1']).map(d => `${d.code}: ${d.message}`);
    expect(messages).toHaveLength(4);
    expect(messages.every(m => m.startsWith('MOV_CLOSURE_NOT_DATA'))).toBe(true);
    expect(messages.join('\n')).toContain('a spread into a list holds a closure');
    expect(messages.join('\n')).toContain("'KEYBY' files each member under a key");
    expect(messages.join('\n')).toContain("'GROUPBY' files each member under a key");
  });

  it('the message says where a closure lives instead', () => {
    const [error] = errorsUnder(5, [], ['  box = { g: label }']);
    expect(error!.message).toContain("'g' holds a closure");
    expect(error!.message).toContain('a closure is not data');
    expect(error!.message).toContain('keep it in a variable');
    expect(error!.message).toContain('pass it as an argument');
  });

  it.each<[string, string[], string[]]>([
    ['a variable', [], ['  g = label', '  x = g()']],
    ['a call that answers a closure', ['function mk() {', '  return label', '}'], ['  g = mk()', '  x = g()']],
    ['a closure-typed parameter, and its argument', ['function run(f: <() => <text>>) {', '  return f()', '}'], ['  x = run(label)', '  y = run(() => "b")']],
    ['a collection op\'s function', [], ['  d = MAP([1, 2], (x) => x + 1)']],
    ['all\'s arguments', [], ['  r = all(label, () => { return 1 })', '  write crm-[:notes]-> { title: AT(r, 0) }']],
    ['race\'s arguments', [], ['  r = race(label, () => { await sleep(1h) })']],
  ])('%s keeps a closure', (_label, functions, body) => {
    expect(errorsUnder(5, functions, body)).toEqual([]);
  });

  it.each<LanguageVersion>([1, 2, 3, 4])('version %s is unchanged', version => {
    expect(errorsUnder(version, [], ['  box = { g: label }']).map(d => d.code)).not.toContain('MOV_CLOSURE_NOT_DATA');
    expect(errorsUnder(version, [], ['  fs = [() => { return 1 }]']).map(d => d.code)).toEqual(['MOV_EXPR_CLOSURE_POSITION']);
  });
});
