// `parallel` is retired under language version 5 (Dancing Wren): `all` is the
// same join, its functions passed as arguments — a closure is not data, so
// there is no list of them to pass — and written without `await`, which marks
// only where the run itself parks. MOV_PARALLEL_RETIRED carries the exact
// rewrite for arms written down —
//
//     r = await parallel([a, () => { … }])
//     r = all(a, () => { … })
//
// — and the rewritten program checks clean, its later `AT(r, i)` reads
// included: the receipt is a tuple, slot by slot. Versions 1 to 4 keep
// `parallel`.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import { applyFix } from '../fixes';
import type { LanguageVersion } from '../../language_version';
import { spelledFor } from './surface_spelling';

const crmSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text' }, edges: {} },
    note: { properties: { title: 'text', count: 'number' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
    note: { fields: { title: 'text', count: 'number' }, resultShape: { externalId: 'text' } },
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

const sourceOf = (body: string[]): string => `${PRELUDE}\nmovement m() {\n${body.join('\n')}\n}`;

const spell = (source: string): string => spelledFor(5, source, catalog);

const check = (version: LanguageVersion, source: string): Diagnostic[] =>
  checkProgram(parseProgram(spelledFor(version, source, catalog), { languageVersion: version }), catalog, { languageVersion: version }).filter(
    d => (d.severity ?? 'error') === 'error',
  );

/** The program with every MOV_PARALLEL_RETIRED fix applied, one at a time. */
function fixed(source: string): string {
  let current = spell(source);
  for (let guard = 0; guard < 10; guard++) {
    const retired = check(5, current).find(d => d.code === 'MOV_PARALLEL_RETIRED');
    if (retired?.fix === undefined) return current;
    current = applyFix(current, retired.fix);
  }
  return current;
}

const PROGRAMS: Array<[string, string[], string[]]> = [
  [
    'a record arm and a value arm, read slot by slot (the migration guide\'s example)',
    [
      '  r = await parallel([',
      '    () => {',
      '      a = write crm-[:companies]-> { name: "Acme" }',
      '      return a',
      '    },',
      '    () => 2',
      '  ])',
      '  write crm-[:notes]-> { title: AT(r, 0).name, count: AT(r, 1) }',
    ],
    [
      '  r = all(',
      '    () => {',
      '      a = write crm-[:companies]-> { name: "Acme" }',
      '      return a',
      '    },',
      '    () => 2',
      '  )',
      '  write crm-[:notes]-> { title: AT(r, 0).name, count: AT(r, 1) }',
    ],
  ],
  [
    'named functions as arms',
    ['  r = await parallel([made, label])', '  write crm-[:notes]-> { title: AT(r, 1) }', '  g = graph { c: AT(r, 0) }'],
    ['  r = all(made, label)', '  write crm-[:notes]-> { title: AT(r, 1) }', '  g = graph { c: AT(r, 0) }'],
  ],
  [
    'arms that wait',
    ['  r = await parallel([() => {', '    await sleep(1h)', '    return "a"', '  }, () => { return "b" }])', '  write crm-[:notes]-> { title: CONCAT(AT(r, 0), AT(r, 1)) }'],
    ['  r = all(() => {', '    await sleep(1h)', '    return "a"', '  }, () => { return "b" })', '  write crm-[:notes]-> { title: CONCAT(AT(r, 0), AT(r, 1)) }'],
  ],
  [
    'arms that hand nothing back',
    ['  await parallel([() => {', '    write crm-[:notes]-> { title: "a" }', '  }, () => {', '    write crm-[:notes]-> { title: "b" }', '  }])'],
    ['  all(() => {', '    write crm-[:notes]-> { title: "a" }', '  }, () => {', '    write crm-[:notes]-> { title: "b" }', '  })'],
  ],
  [
    'run for its effects, unbound',
    ['  await parallel([made, made])'],
    ['  all(made, made)'],
  ],
];

describe('parallel under Dancing Wren (5)', () => {
  it.each(PROGRAMS)('%s: checks clean under 4', (_label, body) => {
    expect(check(4, sourceOf(body))).toEqual([]);
  });

  it.each(PROGRAMS)('%s: refused under 5, with the rewrite', (_label, body, rewritten) => {
    const errors = check(5, sourceOf(body));
    expect(errors.map(d => d.code)).toEqual(['MOV_PARALLEL_RETIRED']);
    expect(fixed(sourceOf(body))).toBe(spell(sourceOf(rewritten)));
  });

  it.each(PROGRAMS)('%s: the rewritten program checks clean under 5', (_label, _body, rewritten) => {
    expect(check(5, sourceOf(rewritten))).toEqual([]);
  });

  it('a record slot the rewrite reads into a field is still refused, as the receipt\'s was', () => {
    const body = ['  r = await parallel([made, label])', '  write crm-[:notes]-> { title: AT(r, 0) }'];
    expect(check(4, sourceOf(body)).map(d => d.code)).toEqual(['MOV_WRITE_FIELD_TYPE']);
    expect(check(5, sourceOf(['  r = all(made, label)', '  write crm-[:notes]-> { title: AT(r, 0) }'])).map(d => d.code)).toEqual(['MOV_WRITE_FIELD_TYPE']);
  });

  it('written without await, the retirement is the one refusal, and the fix drops nothing', () => {
    const body = ['  r = parallel([label, label])', '  write crm-[:notes]-> { title: AT(r, 0) }'];
    expect(check(5, sourceOf(body)).map(d => d.code)).toEqual(['MOV_PARALLEL_RETIRED']);
    expect(fixed(sourceOf(body))).toBe(spell(sourceOf(['  r = all(label, label)', '  write crm-[:notes]-> { title: AT(r, 0) }'])));
    expect(check(5, fixed(sourceOf(body)))).toEqual([]);
  });

  it('written with its arms as arguments, the fix renames it', () => {
    const body = ['  r = parallel(label, made)'];
    expect(check(5, sourceOf(body)).map(d => d.code)).toEqual(['MOV_PARALLEL_RETIRED']);
    expect(fixed(sourceOf(body))).toBe(spell(sourceOf(['  r = all(label, made)'])));
  });

  it('an arrow body that awaits it gets the fix too', () => {
    const body = ['  g = () => await parallel([label, made])', '  v = g()', '  write crm-[:notes]-> { title: AT(v, 0) }'];
    const errors = check(5, sourceOf(body));
    expect(errors.map(d => d.code)).toEqual(['MOV_PARALLEL_RETIRED']);
    expect(errors[0]!.fix).toBeDefined();
    const rewritten = fixed(sourceOf(body));
    expect(rewritten).toBe(spell(sourceOf(['  g = () => all(label, made)', '  v = g()', '  write crm-[:notes]-> { title: AT(v, 0) }'])));
    expect(check(5, rewritten)).toEqual([]);
  });

  it('`all` is a retired name before 5', () => {
    expect(() => check(4, sourceOf(['  r = all(label, made)']))).toThrow('`all` was replaced by `parallel`');
  });
});
