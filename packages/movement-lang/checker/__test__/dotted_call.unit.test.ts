// `o.f(…)` — a dotted call. The engine reads it as `f` run in `o`'s scope,
// so a function that is no built-in has nothing to run outside a write field
// (whose target may advertise its own) — the run always failed where it
// reached it. That is refused from language version 5 only: versions 1–4 keep
// their behaviour. A built-in in a record's scope (`o.UPPER(name)`) is what it
// always was.
//
// Under 5 there are no methods either: a closure is never held under a key,
// so `box.g()` on a value is refused the same way, never a call of a member.

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

const errorsUnder = (version: LanguageVersion, body: string[]): Diagnostic[] => {
  const source = `${PRELUDE}\nmovement m() {\n${body.join('\n')}\n}`;
  return checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version }).filter(
    d => (d.severity ?? 'error') === 'error',
  );
};
const codes = (version: LanguageVersion, body: string[]): string[] => errorsUnder(version, body).map(d => d.code);
const WRITE = '  write crm-[:notes]-> { title: v }';

describe('a dotted call on a value (Dancing Wren, 5): there are no methods', () => {
  it('is refused as a function that is no built-in, and the message offers no member call', () => {
    const errors = errorsUnder(5, ['  box = { n: 1 }', '  v = box.g()']);
    expect(errors.map(d => d.code)).toEqual(['MOV_FUNCTION_UNKNOWN']);
    expect(errors[0]!.message).toContain('There are no methods');
    expect(errors[0]!.message).not.toContain("'box.g()'");
  });

  it('is refused nested in an expression', () => {
    expect(codes(5, ['  box = { n: 1 }', '  v = UPPER(box.g())'])).toEqual(['MOV_FUNCTION_UNKNOWN']);
  });

  it('a value that would have held a closure is refused where the closure is put under the key', () => {
    expect(codes(5, ['  box = { g: label }', '  v = box.g()'])).toEqual(['MOV_CLOSURE_UNDER_KEY', 'MOV_FUNCTION_UNKNOWN']);
  });
});

describe('a dotted call that never ran', () => {
  it('is refused from version 5: a record\'s dotted call of no built-in', () => {
    expect(codes(5, ['  o = made()', '  v = o.nope()'])).toEqual(['MOV_FUNCTION_UNKNOWN']);
  });

  it.each<LanguageVersion>([1, 2, 3, 4])('version %s: is left as it was', version => {
    expect(errorsUnder(version, ['  o = made()', '  v = o.nope()'])).toEqual([]);
    expect(errorsUnder(version, ['  box = { g: label }', '  v = box.g()'])).toEqual([]);
  });

  it.each<LanguageVersion>([1, 2, 3, 4, 5])('version %s: a built-in in a record\'s scope is what it was', version => {
    expect(errorsUnder(version, ['  o = made()', '  v = o.UPPER(name)'])).toEqual([]);
  });

  it.each<LanguageVersion>([3, 4])('version %s: inside a write field the target may advertise the function', version => {
    expect(errorsUnder(version, ['  box = { g: label }', '  write crm-[:notes]-> { title: box.summarize() }'])).toEqual([]);
  });
});
