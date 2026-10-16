// A program can never make the checker hang. Every walk over a type is linear
// in its distinct parts — a closure's return nests the last one's, shared, not
// copied, and comparing, spelling or searching it meets each part once — and an
// inferred type with more than 10,000 distinct parts stops there, reported on
// every version (`MOV_TYPE_TOO_LARGE`): a safety limit, not a language rule.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const crmSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: { company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } } },
};

const catalog = mockCatalog({
  adapters: { attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema } },
  credentials: { crm_cred: { adapter: 'attio' } },
  plugins: {},
});

const PRELUDE = ['import { attio } from adapters', 'import { crm_cred } from credentials', 'crm = attio(credentials: crm_cred)'].join('\n');

const errorsUnder = (version: LanguageVersion, outside: string[], body: string[]): Diagnostic[] => {
  const source = `${PRELUDE}\n${outside.join('\n')}\nmovement m() {\n${body.join('\n')}\n}`;
  return checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version }).filter(
    d => (d.severity ?? 'error') === 'error',
  );
};

const LINKS = 30;

/** A chain of closures, each returning `returned` (over `a`, the last one's
 *  value) on two branches. */
function chainOf(returned: string, start: string): string[] {
  const lines = ['  org = write crm-[:companies]-> { name: "Acme" }', `  f0 = () => ${start}`];
  for (let i = 1; i <= LINKS; i++) {
    lines.push(`  f${i} = () => {`, `    a = f${i - 1}()`, '    if 1 > 0 {', `      return ${returned}`, '    }', `    return ${returned}`, '  }');
  }
  return lines;
}

const timed = (run: () => Diagnostic[]): { found: Diagnostic[]; ms: number } => {
  const started = Date.now();
  const found = run();
  return { found, ms: Date.now() - started };
};

const BIG_MAP = `{ ${Array.from({ length: 10_000 }, (_, i) => `k${i}: { k${i}: 1 }`).join(', ')} }`;
const TOO_LARGE = (name: string): string =>
  `'${name}' builds a type too large to check (over 10000 parts) — split the value into named parts or declare its shape (node <Name> { … })`;

describe.each<LanguageVersion>([3, 4, 5])('a type a program builds (version %i)', version => {
  it('a chain of closures returning a map of the last value twice checks in linear time', () => {
    const { found, ms } = timed(() => errorsUnder(version, [], [...chainOf('{ k: a, j: a }', 'COALESCE(org, "x")'), `  g = graph { n: f${LINKS}() }`]));
    expect(found.map(d => d.code)).toEqual(['MOV_GRAPH_ENTRY_RECORD']);
    expect(ms).toBeLessThan(1000);
  });

  it('the same chain over a plain value checks in linear time, and says nothing', () => {
    const { found, ms } = timed(() => errorsUnder(version, [], [...chainOf('{ k: a, j: a }', '1'), `  x = f${LINKS}()`]));
    expect(found).toEqual([]);
    expect(ms).toBeLessThan(1000);
  });

  it('a chain of closures returning a list of the last value twice checks in linear time', () => {
    const { found, ms } = timed(() => errorsUnder(version, [], [...chainOf('[a, a]', 'COALESCE(org, "x")'), `  g = graph { n: f${LINKS}() }`]));
    expect(found.map(d => d.code)).toEqual(['MOV_GRAPH_ENTRY_RECORD']);
    expect(ms).toBeLessThan(1000);
  });

  it('a fan of closures, each a list of three calls of the last, checks in linear time', () => {
    const fan = ['  org = write crm-[:companies]-> { name: "Acme" }', '  h0 = () => COALESCE(org, "x")'];
    for (let i = 1; i <= LINKS; i++) fan.push(`  h${i} = () => [h${i - 1}(), h${i - 1}(), h${i - 1}()]`);
    const { found, ms } = timed(() => errorsUnder(version, [], [...fan, `  g = graph { n: h${LINKS}() }`]));
    expect(found.map(d => d.code)).toEqual(['MOV_GRAPH_ENTRY_RECORD']);
    expect(ms).toBeLessThan(1000);
  });

  it('a binding whose type has more than 10,000 distinct parts is refused, once, and goes untyped', () => {
    const found = errorsUnder(version, [], [`  x = ${BIG_MAP}`, '  y = x.k1']);
    expect(found.map(d => [d.code, d.message])).toEqual([['MOV_TYPE_TOO_LARGE', TOO_LARGE('x')]]);
  });

  it('a function or a closure that returns one is refused where it is declared, and its calls go untyped', () => {
    const fn = errorsUnder(version, ['function big() {', `  return ${BIG_MAP}`, '}'], ['  y = big()', '  z = y.k1']);
    expect(fn.map(d => [d.code, d.message, d.span.start.line])).toEqual([['MOV_TYPE_TOO_LARGE', TOO_LARGE('big'), 4]]);
    const closure = errorsUnder(version, [], [`  c = () => { return ${BIG_MAP} }`, '  y = c()', '  z = y.k1']);
    expect(closure.map(d => [d.code, d.message])).toEqual([['MOV_TYPE_TOO_LARGE', TOO_LARGE('c')]]);
  });

  it('a type with 10,000 parts is within the limit', () => {
    const within = `{ ${Array.from({ length: 9_997 }, (_, i) => `k${i}: { k${i}: 1 }`).join(', ')} }`;
    expect(errorsUnder(version, [], [`  x = ${within}`])).toEqual([]);
  });
});
