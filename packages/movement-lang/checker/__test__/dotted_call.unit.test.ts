// `box.g()` — a dotted call on a value. From language version 5 it calls the
// closure the value holds under that key, as TypeScript's does, typed by that
// closure; a key it does not have, or one that is no closure, is refused.
//
// Before 5 the engine reads `o.f(…)` as `f` run in `o`'s scope, so a function
// that is no built-in has nothing to run outside a write field (whose target
// may advertise its own) — the run always failed where it reached it, so it is
// refused on every version. A built-in in a record's scope (`o.UPPER(name)`)
// is what it always was.

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

describe('a dotted call on a value (Dancing Wren, 5)', () => {
  it('calls the closure the value holds, typed by it', () => {
    expect(errorsUnder(5, ['  box = { g: label }', '  v = box.g()', WRITE])).toEqual([]);
    expect(errorsUnder(5, ['  box = { g: label }', '  v = UPPER(box.g())', WRITE])).toEqual([]);
    expect(codes(5, ['  box = { g: made }', '  v = box.g()', WRITE])).toEqual(['MOV_WRITE_FIELD_TYPE']);
  });

  it('is held to the closure\'s parameters', () => {
    expect(codes(5, ['  box = { g: label }', '  v = box.g(1)'])).toEqual(['MOV_CALL_ARITY']);
  });

  it('a key the value does not have is refused, by name', () => {
    const errors = errorsUnder(5, ['  box = { g: label }', '  v = box.nope()']);
    expect(errors.map(d => d.code)).toEqual(['MOV_CALL_NOT_MOVEMENT']);
    expect(errors[0]!.message).toContain("'box' has no 'nope'");
  });

  it('a member that is no closure is refused', () => {
    expect(codes(5, ['  box = { n: 1 }', '  v = box.n()'])).toEqual(['MOV_CALL_NOT_MOVEMENT']);
  });
});

describe('a dotted call that never ran is refused on every version', () => {
  it.each<LanguageVersion>([1, 2, 3, 4, 5])('version %s: a record\'s dotted call of no built-in', version => {
    expect(codes(version, ['  o = made()', '  v = o.nope()'])).toEqual(['MOV_FUNCTION_UNKNOWN']);
  });

  it.each<LanguageVersion>([1, 2, 3, 4])('version %s: a value\'s dotted call of no built-in', version => {
    expect(codes(version, ['  box = { g: label }', '  v = box.g()'])).toEqual(['MOV_FUNCTION_UNKNOWN']);
  });

  it.each<LanguageVersion>([1, 2, 3, 4, 5])('version %s: a built-in in a record\'s scope is what it was', version => {
    expect(errorsUnder(version, ['  o = made()', '  v = o.UPPER(name)'])).toEqual([]);
  });

  it.each<LanguageVersion>([3, 4])('version %s: inside a write field the target may advertise the function', version => {
    expect(errorsUnder(version, ['  box = { g: label }', '  write crm-[:notes]-> { title: box.summarize() }'])).toEqual([]);
  });
});
