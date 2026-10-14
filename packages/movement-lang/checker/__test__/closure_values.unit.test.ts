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

const errorsUnder = (version: LanguageVersion, body: string[]): Diagnostic[] => {
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

// A closure's type flows through every value position (a list, a FILTER or
// MAP over closures, AT, a call's answer), so a value whose type is a closure
// — or a union of them, TypeScript's `(() => A) | (() => B)` — may be called
// under 5: its value is the union of what the closures return, records
// included, so the record-in-data rules see a record any of them hands back.
// A value that may not be a closure, or whose type nothing shows, is refused
// where it is called.
describe('calling a value that is a closure', () => {
  const note = (value: string): string => `  write crm-[:notes]-> { title: ${value} }`;
  const MIXED = ['  fs = [() => { return made() }, () => { return "x" }]'];
  const TEXT = ['  fs = [() => { return "y" }, () => { return "x" }]'];

  const CALLS: Array<[string, string[]]> = [
    ['a member of a named list', ['  a = () => { return 1 }', '  b = () => { return "x" }', '  fs = [a, b]', '  r = MAP(fs, (f) => { return f() })']],
    ['a member of an inline list', ['  r = MAP([() => { return 1 }, () => { return 2 }], (f) => f())']],
    ['a member called as a statement', ['  fs = [() => { return 1 }]', '  MAP(fs, (f) => { f() })']],
    ['a member read with AT', ['  fs = [() => { return 1 }]', '  g = AT(fs, 0)', '  x = g()']],
    ['a member with an argument', ['  fs = [(n: <number>) => n + 1, (n: <number>) => { return n * 2 }]', '  r = MAP(fs, (f) => f(3))']],
    ['a member of a FILTER', [...TEXT, '  r = MAP(FILTER(fs, (f) => TRUE), (f) => f())']],
  ];

  it.each(CALLS)('%s: checks clean under 5', (_label, body) => {
    expect(errorsUnder(5, body)).toEqual([]);
  });

  it('under 4 a member is not called (a parameter is no function there)', () => {
    expect(codes(4, CALLS[0]![1])).toEqual(['MOV_CONSTRUCT_NOT_ADAPTER', 'MOV_RETURN_NOT_A_VALUE']);
  });

  it('a call is held to every closure the value may be', () => {
    const errors = errorsUnder(5, ['  fs = [() => { return 1 }, (n: <number>) => n]', '  r = MAP(fs, (f) => f())']);
    expect(errors.map(d => d.code)).toEqual(['MOV_CALL_ARITY']);
    expect(errors[0]!.message).toContain('taking 0 or 1 arguments');
  });

  it('a value that is not a closure is refused where it is called', () => {
    expect(codes(5, ['  fs = [1, 2]', '  r = MAP(fs, (f) => f())'])).toEqual(['MOV_CALL_NOT_MOVEMENT']);
    const errors = errorsUnder(5, ['  t = "a"', '  x = t()']);
    expect(errors.map(d => d.code)).toEqual(['MOV_CALL_NOT_MOVEMENT']);
    expect(errors[0]!.message).toContain("'t' is called, and it is text");
  });

  it('a value that may not be a closure is refused where it is called', () => {
    const errors = errorsUnder(5, ['  c = () => { return 1 }', '  g = COALESCE(c, 2)', '  x = g()']);
    expect(errors.map(d => d.code)).toContain('MOV_CALL_NOT_MOVEMENT');
  });

  describe('what a called member returns', () => {
    it('a record one of them returns is refused in a field: MAP', () => {
      const errors = errorsUnder(5, [...MIXED, '  r = MAP(fs, (f) => f())', note('COALESCE(AT(r, 0), "")')]);
      expect(errors.map(d => d.code)).toEqual(['MOV_WRITE_FIELD_TYPE']);
      expect(errors[0]!.message).toContain('crm.company handle');
    });

    it('and through AT and a bound call — a literal index reads its own slot, as a tuple\'s does', () => {
      expect(codes(5, [...MIXED, '  g = AT(fs, 0)', '  x = g()', note('x')])).toEqual(['MOV_WRITE_FIELD_TYPE']);
      expect(codes(5, [...MIXED, '  g = AT(fs, 1)', '  x = g()', note('x')])).toEqual([]);
    });

    it('and through MAP(FILTER(fs, …), (f) => f())', () => {
      expect(codes(5, [...MIXED, '  r = MAP(FILTER(fs, (f) => TRUE), (f) => f())', note('COALESCE(AT(r, 0), "")')])).toEqual(['MOV_WRITE_FIELD_TYPE']);
    });

    it('and through race over arms built with FILTER', () => {
      expect(codes(5, ['  all = [() => { return made() }, () => { return "x" }]', '  arms = FILTER(all, (f) => TRUE)', '  r = await race(arms)', note('COALESCE(AT(r, 0), "")')])).toEqual(['MOV_WRITE_FIELD_TYPE']);
    });

    it('members that return text are written', () => {
      expect(errorsUnder(5, [...TEXT, '  r = MAP(fs, (f) => f())', note('COALESCE(AT(r, 0), "")')])).toEqual([]);
      expect(errorsUnder(5, [...TEXT, '  r = MAP(FILTER(fs, (f) => TRUE), (f) => f())', note('COALESCE(AT(r, 0), "")')])).toEqual([]);
      expect(errorsUnder(5, [...TEXT, '  arms = FILTER(fs, (f) => TRUE)', '  r = await race(arms)', note('COALESCE(AT(r, 0), "")')])).toEqual([]);
    });

    it('a closure a closure returns is called, and what it returns is seen', () => {
      expect(codes(5, ['  mk = () => { return () => { return made() } }', '  h = mk()', '  y = h()', note('y')])).toEqual(['MOV_WRITE_FIELD_TYPE']);
    });
  });

  it('a function declared with a name is a closure value too', () => {
    expect(errorsUnder(5, ['  fs = [made, made]', '  r = MAP(fs, (f) => f())'])).toEqual([]);
    expect(codes(5, ['  fs = [made, made]', '  r = MAP(fs, (f) => f())', note('COALESCE(AT(r, 0), "")')])).toEqual(['MOV_WRITE_FIELD_TYPE']);
  });

  it('arms built at run time that are not closures are refused under 5', () => {
    expect(codes(5, ['  arms = [1, 2]', '  r = await race(arms)'])).toEqual(['MOV_COMBINATOR_ARM_NOT_FUNCTION']);
  });
});
