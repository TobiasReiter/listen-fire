// Spine gaps of language version 5's surface (plans/naming-rethink-2026-10-14/
// 5_design.md) through the TypeScript checker: the v5 form checks under 5 as
// the old form does under 4, the old form under 5 is MOV_V5_SPELLING with a
// fix, and the fixed text checks under 5 as the old form did under 4. The
// Rust checker's twin is crates/movement-checker/tests/v5_gaps.rs.

import { parseProgram } from '../../parser/parse';
import { checkProgram, type Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import { applyFix } from '../fixes';

const crmSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text', score: 'number' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: { companies: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' }, edges: {} } },
};

const catalog = mockCatalog({
  adapters: { attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema } },
  credentials: { 'Acme CRM': { adapters: ['attio'] } },
});

function check(source: string, languageVersion: number): Diagnostic[] {
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion });
}

const codes = (source: string, version: number): string[] => check(source, version).map((d) => d.code).sort();

function cmp(a: { line: number; col: number }, b: { line: number; col: number }): number {
  return a.line - b.line || a.col - b.col;
}

/** Applies every non-overlapping MOV_V5_SPELLING fix until none is left. */
function upgraded(source: string): string {
  let text = source;
  for (let round = 0; round < 8; round++) {
    const refused = check(text, 5).filter((d) => d.code === 'MOV_V5_SPELLING');
    if (refused.length === 0) return text;
    const taken: NonNullable<Diagnostic['fix']>['edits'] = [];
    for (const d of refused) {
      if (d.fix === undefined) throw new Error(`no fix for ${d.message}`);
      for (const e of d.fix.edits) {
        if (taken.every((t) => cmp(e.span.end, t.span.start) <= 0 || cmp(e.span.start, t.span.end) >= 0)) taken.push(e);
      }
    }
    text = applyFix(text, { edits: taken });
  }
  throw new Error(`${text}: the fixes did not settle`);
}

const v5 = (body: string): string =>
  `import { \`@lf/attio\` as attio } from adapters\nimport { \`Acme CRM\` } from credentials\ncrm = connect attio using \`Acme CRM\`\nfunction go(t: <text>, xs: <text[]>, co: <crm-[:company]->>) {\n${body}\n}\n`;
const v4 = (body: string): string =>
  `import { attio } from adapters\nimport { \`Acme CRM\` } from credentials\ncrm = attio(credentials: \`Acme CRM\`)\nmovement go(t: <text>, xs: <text[]>, co: <crm-[:company]->>) {\n${body}\n}\n`;

function same(newBody: string, oldBody: string): void {
  const [next, old] = [v5(newBody), v4(oldBody)];
  const want = codes(old, 4);
  expect(want.filter((c) => c.startsWith('MOV_UNKNOWN'))).toEqual([]);
  expect(codes(next, 5)).toEqual(want);
  expect(codes(old, 5)).toContain('MOV_V5_SPELLING');
  expect(codes(upgraded(old), 5)).toEqual(want);
}

describe('language version 5: the spine gaps', () => {
  it('fail is the error statement', () => {
    same('  if (t == null) {\n    fail("no text")\n  }\n  y = Text.upper(t)', '  if t == NULL {\n    ERROR("no text")\n  }\n  y = UPPER(t)');
    same('  fail("always")', '  ERROR("always")');
    expect(codes(v4('  fail("x")'), 4)).toContain('MOV_FUNCTION_UNKNOWN');
    expect(codes(v5('  x = coalesce(t, fail("no"))'), 5)).toContain('MOV_V5_NOT_YET');
  });

  it('is inside the if parentheses narrows', () => {
    same('  y = 1\n  if (co is <crm-[:company]->>) {\n    n = co.name\n  }', '  y = 1\n  if co IS <crm-[:company]->> {\n    n = co.name\n  }');
  });

  it('closure-taking built-ins bind in v5 order', () => {
    same('  x = map(xs, (s) => Text.upper(s), { concurrency: 2 })', '  x = MAP(xs, { concurrency: 2 }, (s) => UPPER(s))');
    same('  x = map(xs, (s) => {\n    return Text.upper(s)\n  }, { concurrency: 2 })', '  x = MAP(xs, { concurrency: 2 }, (s) => {\n    return UPPER(s)\n  })');
    same('  x = reduce(xs, (a: <number>, s: <text>) => a + Text.length(s), 0)', '  x = REDUCE(xs, 0, (a: <number>, s: <text>) => a + LENGTH(s))');
    same('  g = (a: <number>, s: <text>) => a + Text.length(s)\n  x = reduce(xs, g, 0)', '  g = (a: <number>, s: <text>) => a + LENGTH(s)\n  x = REDUCE(xs, 0, g)');
    same('  x = List.groupBy(xs, (s) => Text.lower(s))', '  x = GROUPBY(xs, (s) => LOWER(s))');
    same('  x = count(List.keyBy(xs, (s) => Text.lower(s)))', '  x = COUNT(KEYBY(xs, (s) => LOWER(s)))');
  });

  it('sort with no key, by its order, or by the member itself', () => {
    same('  x = sort(xs)', '  x = SORT(xs)');
    same('  x = sort(xs, { order: "desc" })', '  x = SORT(xs, DESC)');
    same('  x = sort(xs, (s) => s, { order: "desc" })', '  x = SORT(xs, DESC)');
  });

  it('indexing reads in a write field and in interpolation', () => {
    same('  y = "${xs[0]}"', '  y = "${AT(xs, 0)}"');
    same('  write crm-[:companies]-> { name: xs[0] }', '  write crm-[:companies]-> { name: AT(xs, 0) }');
  });

  it('await first is lower case', () => {
    same('  q = co\n  x = await first(q-[:companies]->)', '  q = co\n  x = await FIRST(q-[:companies]->)');
  });

  it('callback takes a deferred call', () => {
    same('  x = callback(() => go(t, xs, co))', '  x = callback(go(t, xs, co))');
  });

  it('a backticked credential after using', () => {
    expect(codes(v5('  y = 1'), 5)).toEqual(codes(v4('  y = 1'), 4));
  });
});
