// A closure's type is written down (language version 5), as TypeScript's
// function type is: `<(params) => <return>>` — `handler: <(c: <Company>) =>
// <text>>`, `arms: <() => <text>>[]`, `{ go: <() => <text>> }`. A parameter
// of closure type may be called; a closure value fits a closure type when it
// takes what the type supplies (contravariant parameters) and returns what it
// returns (covariant returns). Before 5 the syntax is refused.

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
].join('\n');

const errorsUnder = (version: LanguageVersion, functions: string[], body: string[]): Diagnostic[] => {
  const source = `${PRELUDE}\n${functions.join('\n')}\nmovement m() {\n${body.join('\n')}\n}`;
  return checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version }).filter(
    d => (d.severity ?? 'error') === 'error',
  );
};
const codes = (functions: string[], body: string[]): string[] => errorsUnder(5, functions, body).map(d => d.code);
const WRITE = '  write crm-[:notes]-> { title: v }';

const RUN_LIST = ['function go(fs: <() => <text>>[]) {', '  r = MAP(fs, (f) => f())', '  return FIRST(r)', '}'];
const RUN_ONE = ['function run(h: <() => <text>>) {', '  return h()', '}'];
const RUN_NUMBER = ['function run(h: <(n: <number>) => <text>>) {', '  return h(2)', '}'];
const TAKE_COMPANY = ['function take(h: <(c: <crm-[:company]->>) => <text>>) {', '  o = write crm-[:companies]-> { name: "x" }', '  return h(o)', '}'];

describe('the closure type <(params) => <return>> (Dancing Wren, 5)', () => {
  it('a list of closures is passed to a parameter typed <() => <text>>[], and its members are called', () => {
    expect(errorsUnder(5, RUN_LIST, ['  v = go([label, () => "x"])', '  if v != null {', '  ' + WRITE, '  }'])).toEqual([]);
  });

  it('a closure in the list that returns a record does not fit <() => <text>>[]', () => {
    expect(codes(RUN_LIST, ['  v = go([made, label])'])).toEqual(['MOV_CALL_ARG_TYPE']);
  });

  it('a parameter of closure type is called, typed by its return', () => {
    expect(errorsUnder(5, RUN_ONE, ['  v = run(label)', WRITE])).toEqual([]);
    expect(codes(['function run(h: <() => <crm-[:company]->>>) {', '  return h()', '}'], ['  v = run(made)', WRITE])).toEqual(['MOV_WRITE_FIELD_TYPE']);
  });

  it('a call of a closure-typed parameter is held to its parameters', () => {
    expect(codes(['function run(h: <() => <text>>) {', '  return h(1)', '}'], ['  v = run(label)'])).toEqual(['MOV_CALL_ARITY']);
  });

  it('returns are covariant: a closure returning a record does not fit <() => <text>>', () => {
    const errors = errorsUnder(5, RUN_ONE, ['  v = run(made)']);
    expect(errors.map(d => d.code)).toEqual(['MOV_CALL_ARG_TYPE']);
    expect(errors[0]!.message).toContain('a closure returning a crm.company');
  });

  it('a closure written in place is an argument, its parameters typed by the closure type', () => {
    expect(errorsUnder(5, RUN_NUMBER, ['  v = run((n: <number>) => "x")', WRITE])).toEqual([]);
    expect(errorsUnder(5, RUN_NUMBER, ['  v = run((n) => "x")', WRITE])).toEqual([]);
    expect(errorsUnder(5, TAKE_COMPANY, ['  v = take((c) => c.name)', WRITE])).toEqual([]);
  });

  it('parameters are contravariant: one that takes something else does not fit', () => {
    expect(codes(RUN_NUMBER, ['  v = run((n: <text>) => "x")'])).toEqual(['MOV_CALL_ARG_TYPE']);
    expect(codes(['function note(c: <crm-[:note]->>) {', '  return c.title', '}', ...TAKE_COMPANY], ['  v = take(note)'])).toEqual(['MOV_CALL_ARG_TYPE']);
  });

  it('a closure taking fewer parameters fits, and one taking more does not (as TypeScript)', () => {
    expect(errorsUnder(5, RUN_NUMBER, ['  v = run(label)', WRITE])).toEqual([]);
    expect(codes(RUN_ONE, ['  v = run((n: <number>) => "x")'])).toEqual(['MOV_CALL_ARG_TYPE']);
  });

  it('a record key may be of closure type', () => {
    const takesBox = ['function run(b: <{ go: <() => <text>> }>) {', '  return 1', '}'];
    expect(errorsUnder(5, takesBox, ['  v = run({ go: label })'])).toEqual([]);
    expect(codes(takesBox, ['  v = run({ go: made })'])).toEqual(['MOV_CALL_ARG_TYPE']);
  });

  it('a bound closure\'s parameter may be a list of closures', () => {
    expect(errorsUnder(5, [], ['  go2 = (fs: <() => <text>>[]) => MAP(fs, (f) => f())', '  r = go2([label, label])', '  v = FIRST(r)', '  if v != null {', '  ' + WRITE, '  }'])).toEqual([]);
  });

  it('a function may declare it returns a closure', () => {
    expect(errorsUnder(5, ['function pick(): <() => <text>> {', '  return label', '}'], ['  h = pick()', '  v = h()', WRITE])).toEqual([]);
  });

  it('a name in a closure type that names nothing is reported', () => {
    expect(codes(['function run(h: <() => <nope>>) {', '  return 1', '}'], ['  v = 1'])).toContain('MOV_NAME_UNRESOLVED');
  });

  it.each<[string, string, RegExp]>([
    ['an untyped parameter', 'function run(h: <(n) => <text>>) {\n  return 1\n}', /parameter 'n' needs a type/],
    ['a list after the return, which is ambiguous', 'function run(h: <() => <text>[]>) {\n  return 1\n}', /'<\(\) => <text\[\]>>'.*'<\(\) => <text>>\[\]'/],
  ])('%s is refused where it is written', (_label, fn, message) => {
    expect(() => parseProgram(`${PRELUDE}\n${fn}`, { languageVersion: 5 })).toThrow(message);
  });

  it.each<LanguageVersion>([1, 2, 3, 4])('under version %s the syntax is refused, naming the version that has it', version => {
    expect(() => parseProgram(`${PRELUDE}\n${RUN_ONE.join('\n')}`, { languageVersion: version })).toThrow(/written from language version 5 \(Dancing Wren\)/);
  });
});
