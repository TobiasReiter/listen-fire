// Language version 5: `fail(…)` inside an expression (a value that never
// arrives, TypeScript's `never`) and `sort` by a function key, through the
// TypeScript checker. The Rust checker's twin is
// crates/movement-checker/tests/v5_never_sort.rs.

import { parseProgram } from '../../parser/parse';
import { checkProgram, type Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import { applyFix } from '../fixes';
import { checkSourceInRust } from '../rust_checker';
import { fromCatalogSnapshot, type CatalogSnapshot } from '../../service/snapshot';

const crmSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text', score: 'number' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: { companies: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' }, edges: {} } },
};

const catalog = mockCatalog({
  adapters: { attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema } },
  credentials: { 'Acme CRM': { adapters: ['attio'] } },
});

/** Every program checked here, for the parity test at the end. */
const checked: Array<{ source: string; languageVersion: number }> = [];

function check(source: string, languageVersion: number): Diagnostic[] {
  checked.push({ source, languageVersion });
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

const ROWS = '  rows = List.from(crm-[:companies]->)';

/** The safe marker on the old sort key's fix. */
function fixSafe(source: string): boolean {
  const finding = check(source, 5).find((d) => d.code === 'MOV_V5_SPELLING' && d.message.includes('its key a function'));
  if (finding === undefined) throw new Error(`${source}: no sort key finding`);
  return finding.fix?.safe === true;
}

describe('language version 5: sort by a function key', () => {
  it('reads each member through the function', () => {
    clean(`${ROWS}\n  x = sort(rows, (r) => Text.lower(r.name), { order: "desc" })`);
    clean(`${ROWS}\n  x = sort(rows, (r) => r.score)`);
    clean(`${ROWS}\n  k = (r: <crm-[:company]->>) => r.score\n  x = sort(rows, k)`);
    clean(`${ROWS}\n  top = first(sort(rows, (r) => r.score, { order: "desc" }))\n  need(coalesce(top.name, fail("no top")))`);
    clean('  x = sort(xs, (s) => Text.length(s))');
    clean(`${ROWS}\n  name = "z"\n  x = sort(rows, (r) => r.name)`);
  });

  it('refuses a key with no order', () => {
    refused(`${ROWS}\n  x = sort(rows, (r) => r)\n  y = 1`, 'MOV_SORT_NEEDS_KEY');
    refused(`${ROWS}\n  x = sort(rows, (r) => co)`, 'MOV_SORT_NEEDS_KEY');
    refused('  x = sort(xs, (s) => Text.split(s, ","))', 'MOV_ORDER_KEY_MULTI');
    refused('  x = sort(xs, (s) => s, { order: "down" })', 'MOV_V5_NOT_YET');
    refused('  x = sort(xs, (s) => Text.length(s), { order: "down" })', 'MOV_COLLECTION_OP_CONFIG');
    refused('  x = sort(xs, (s) => Text.length(s), { by: "desc" })', 'MOV_COLLECTION_OP_CONFIG');
    refused('  x = sort(xs, (s) => Text.length(s), 3)', 'MOV_BUILTIN_ARGS');
    expect(codes(v4('  x = SORTBY(xs, (s) => s)'), 4)).toContain('MOV_FUNCTION_UNKNOWN');
    refused('  x = SORTBY(xs, (s) => Text.length(s))', 'MOV_V5_SPELLING');
  });

  it('upgrades the old field key to a function, safe only where no variable hides the field', () => {
    const old = v4('  rows = COLLECT(crm-[:companies]->)\n  x = SORT(rows, `score`, DESC)');
    const fixed = upgraded(old);
    expect(fixed).toContain('sort(rows, (r) => r.score, { order: "desc" })');
    expect(codes(fixed, 5)).toEqual(codes(old, 4));
    expect(fixSafe(old)).toBe(true);
    expect(fixSafe(v4('  score = 3\n  rows = COLLECT(crm-[:companies]->)\n  x = SORT(rows, `score`, DESC)'))).toBe(false);
    expect(fixSafe(v4('  r = 3\n  rows = COLLECT(crm-[:companies]->)\n  x = SORT(rows, `score`)'))).toBe(false);
    expect(fixSafe(v4('  rows = COLLECT(crm-[:companies]->)\n  x = SORT(rows, `score`)\n  if t == "a" {\n    score = 1\n  }'))).toBe(true);
  });
});

// The Rust checker's twin (crates/movement-checker/tests/v5_never_sort.rs)
// holds the same answers by code; here every program above is held to the
// Rust checker's exact diagnostics, messages, spans and fixes included.
const SNAPSHOT = JSON.parse(
  '{"adapters":{"attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"Acme CRM":{"positions":{"company":{"properties":{"name":"text","score":"number"},"edges":{}}},"collections":{"companies":{"target":"company"}},"writableRoots":{"companies":{"fields":{"name":"text"},"resultShape":{"externalId":"text","name":"text"}}}}}}},"credentials":{"Acme CRM":{"adapters":["attio"]}},"plugins":{}}',
) as CatalogSnapshot;

describe('both checkers agree', () => {
  it('on every program above, exactly', () => {
    expect(checked.length).toBeGreaterThan(20);
    const seen = new Set<string>();
    for (const { source, languageVersion } of checked) {
      const key = `${languageVersion}\n${source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ts = checkProgram(parseProgram(source, { languageVersion }), fromCatalogSnapshot(SNAPSHOT), { languageVersion });
      const rust = checkSourceInRust(source, SNAPSHOT, { languageVersion });
      expect({ source, diagnostics: rust }).toEqual({ source, diagnostics: ts });
    }
  });
});
