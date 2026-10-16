// Language version 5: `fail(…)` inside an expression (a value that never
// arrives, TypeScript's `never`) and `sort` by a function key, through the
// TypeScript checker. The Rust checker's twin is
// crates/movement-checker/tests/v5_never_sort.rs.

import { parseProgram } from '../../parser/parse';
import { checkProgram, type Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';

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

const v5 = (body: string): string =>
  `import { \`@lf/attio\` as attio } from adapters\nimport { \`Acme CRM\` } from credentials\ncrm = connect attio using \`Acme CRM\`\nfunction need(s: <text>) {\n  return s\n}\nfunction go(t: <text>, xs: <text[]>, co: <crm-[:company]->>) {\n${body}\n}\n`;
const v4 = (body: string): string =>
  `import { attio } from adapters\nimport { \`Acme CRM\` } from credentials\ncrm = attio(credentials: \`Acme CRM\`)\nmovement go(t: <text>, xs: <text[]>, co: <crm-[:company]->>) {\n${body}\n}\n`;

/** A body with `m` a text that may be absent. */
const withM = (body: string): string => v5(`  m = first(xs)\n${body}`);

function clean(body: string): void {
  const source = withM(body);
  expect({ source, diagnostics: check(source, 5) }).toEqual({ source, diagnostics: [] });
}

function refused(body: string, code: string): void {
  expect(codes(withM(body), 5)).toContain(code);
}

const NEED = '  need(x)';

describe('language version 5: fail inside an expression', () => {
  it('is a value that never arrives', () => {
    // The control: a maybe-absent value where a text is required.
    refused(`  x = m\n${NEED}`, 'MOV_CALL_ARG_TYPE');
    // A union with a value that never arrives is its other member.
    clean(`  x = coalesce(m, fail("no m"))\n${NEED}`);
    clean(`  x = m != null ? m : fail("no m")\n${NEED}`);
    clean(`  x = m == null ? fail("no m") : m\n${NEED}`);
    clean('  need(coalesce(m, fail("no m")))');
    // Its other member keeps its own kind: a number is refused as a text.
    refused('  n = m != null ? 1 : fail("no m")\n  need(n)', 'MOV_CALL_ARG_TYPE');
    // It fits every type.
    clean('  y = Text.upper(fail("stop"))');
  });

  it('code after an arm that only fails knows the condition', () => {
    clean('  y = m != null ? m : fail("no m")\n  need(m)');
    clean('  y = m == null ? fail("no m") : 1\n  need(m)');
    clean('  y = coalesce(m, fail("no m"))\n  need(m)');
    // Without the failing arm nothing is known below.
    refused('  y = m != null ? m : "none"\n  need(m)', 'MOV_CALL_ARG_TYPE');
  });

  it('versions 1 to 4 read ERROR as no value', () => {
    expect(codes(v4('  x = COALESCE(t, ERROR("no"))'), 4)).toEqual(['MOV_FUNCTION_UNKNOWN']);
    expect(codes(v5('  x = coalesce(t, fail("no"))'), 5)).toEqual([]);
  });
});
