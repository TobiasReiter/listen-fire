// Closures are values (language version 5, Dancing Wren), as TypeScript's
// functions are — but a closure is not data. It lives in a variable or a
// parameter, or is passed as an argument where it is written, and it is
// called through whichever holds it. A closure written in a list is refused
// (MOV_CLOSURE_NOT_DATA); before 5 it is refused where it is written
// (MOV_EXPR_CLOSURE_POSITION) — the corpus for versions 1 to 4 pins it.

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
].join('\n');

const errorsUnder = (version: LanguageVersion, body: string[]): Diagnostic[] => {
  const source = `${PRELUDE}\nmovement m() {\n${body.join('\n')}\n}`;
  return checkProgram(parseProgram(spelledFor(version, source, catalog), { languageVersion: version }), catalog, { languageVersion: version }).filter(
    d => (d.severity ?? 'error') === 'error',
  );
};

const codes = (version: LanguageVersion, body: string[]): string[] => errorsUnder(version, body).map(d => d.code);

describe('a closure written as a list element', () => {
  const LISTS: Array<[string, string[]]> = [
    ['a bound list', ['  fs = [() => { return 1 }]']],
    ['a block body over lines', ['  fs = [', '    () => {', '      y = 2', '      return y', '    }', '  ]']],
    ['a MAP source', ['  out = MAP([() => { return 1 }], (f) => { return 1 })']],
    ['beside a value', ['  fs = [1, () => { return "x" }]']],
  ];

  it.each(LISTS)('%s: refused under Luminous Owl (4), where a closure is no value', (_label, body) => {
    expect(codes(4, body)).toContain('MOV_EXPR_CLOSURE_POSITION');
  });

  it.each(LISTS)('%s: refused under Dancing Wren (5), where a closure is not data', (_label, body) => {
    expect(codes(5, body)).toEqual(['MOV_CLOSURE_NOT_DATA']);
  });

  it('a closure anywhere else in an expression is still refused by name', () => {
    expect(codes(5, ['  y = IF TRUE THEN () => { return 1 } ELSE 2 END'])).toContain('MOV_EXPR_CLOSURE_POSITION');
  });
});

// A closure's type flows through every place a closure may be (a variable, a
// parameter, a call's answer), so a value whose type is a closure may be called
// under 5: its value is what the closure returns, records included, so the
// record-in-data rules see a record it hands back. A closure is never an
// operand, so IF and COALESCE do not choose between closures
// (MOV_CLOSURE_NOT_DATA). A value that may not be a closure, or whose type
// nothing shows, is refused where it is called.
describe('calling a value that is a closure', () => {
  const note = (value: string): string => `  write crm-[:notes]-> { title: ${value} }`;
  const MIXED = ['  a = () => { return made() }', '  g = a'];
  const TEXT = ['  a = () => { return "y" }', '  g = a'];

  const CALLS: Array<[string, string[]]> = [
    ['a bound closure', ['  a = () => { return 1 }', '  x = a()']],
    ['a closure bound to another name', [...TEXT, '  x = g()']],
    ['a closure called as a statement', ['  a = () => { return 1 }', '  a()']],
    ['a closure with an argument', ['  inc = (n: <number>) => n + 1', '  x = inc(3)']],
  ];

  it.each(CALLS)('%s: checks clean under 5', (_label, body) => {
    expect(errorsUnder(5, body)).toEqual([]);
  });

  it('under 4 a closure value is not called', () => {
    expect(codes(4, ['  a = () => { return "y" }', '  c = TRUE', '  g = IF c THEN a ELSE a END', '  x = g()'])).not.toEqual([]);
  });

  it('IF and COALESCE do not choose between closures: a closure is not data', () => {
    expect(codes(5, ['  a = () => { return 1 }', '  b = (n: <number>) => n', '  c = TRUE', '  g = IF c THEN a ELSE b END'])).toEqual(['MOV_CLOSURE_NOT_DATA']);
    expect(codes(5, ['  a = () => { return 1 }', '  b = () => { return 2 }', '  g = COALESCE(a, b)'])).toEqual(['MOV_CLOSURE_NOT_DATA']);
  });

  it('a value that is not a closure is refused where it is called', () => {
    const errors = errorsUnder(5, ['  t = "a"', '  x = t()']);
    expect(errors.map(d => d.code)).toEqual(['MOV_CALL_NOT_MOVEMENT']);
    expect(errors[0]!.message).toContain("'t' is called, and it is text");
  });

  it('a value that may not be a closure is refused where it is called', () => {
    const errors = errorsUnder(5, ['  c = () => { return 1 }', '  g = COALESCE(c, 2)', '  x = g()']);
    expect(errors.map(d => d.code)).toContain('MOV_CALL_NOT_MOVEMENT');
  });

  describe('what a called closure returns', () => {
    it('a record it returns is refused in a field', () => {
      const errors = errorsUnder(5, [...MIXED, '  x = g()', note('x')]);
      expect(errors.map(d => d.code)).toEqual(['MOV_WRITE_FIELD_TYPE']);
      expect(errors[0]!.message).toContain('crm.company handle');
    });

    it('and through all, slot by slot', () => {
      expect(codes(5, ['  a = () => { return made() }', '  b = () => { return "x" }', '  r = all(a, b)', note('AT(r, 0)')])).toEqual(['MOV_WRITE_FIELD_TYPE']);
      expect(codes(5, ['  a = () => { return made() }', '  b = () => { return "x" }', '  r = all(a, b)', note('AT(r, 1)')])).toEqual([]);
    });

    it('a closure that returns text is written', () => {
      expect(errorsUnder(5, [...TEXT, '  x = g()', note('x')])).toEqual([]);
    });

    it('a closure a closure returns is called, and what it returns is seen', () => {
      expect(codes(5, ['  mk = () => { return () => { return made() } }', '  h = mk()', '  y = h()', note('y')])).toEqual(['MOV_WRITE_FIELD_TYPE']);
    });

    it('a closure an argument passes is called through its parameter', () => {
      expect(codes(5, ['  call = (f: <() => <text>>) => { return f() }', '  y = call(() => "a")', note('y')])).toEqual([]);
      expect(codes(5, ['  call = (f: <() => <text>>) => { return f() }', '  y = call(made)'])).toEqual(['MOV_CALL_ARG_TYPE']);
    });
  });

  it('a function declared with a name is a closure value too', () => {
    expect(errorsUnder(5, ['  g = made', '  x = g()'])).toEqual([]);
    expect(codes(5, ['  g = made', '  x = g()', note('x')])).toEqual(['MOV_WRITE_FIELD_TYPE']);
  });
});
