// Transitional: the TypeScript lowering against the Rust one, over every
// expression text the corpora write (expression_slots.json, in the modes the
// slots were read in) and every slot tree of every pinned program
// (programs.json, through the eager parse, in both modes). The two must agree
// exactly — the value with its key order, or the refusal's class, message
// and code. Gated: MOVEMENT_LOWERING_DIFFERENTIAL=1.
import { callParser } from '../../../wasm/loader';
import { rustLowerCondition, rustLowerExpression, tsLowerCondition, tsLowerExpression } from '../lower';
import { ExpressionSyntaxError, parseExpression } from '../parse_expression';
import type { MExpr } from '../tree';
import { LOWERED, SLOTS, modesOf, type Mode } from './lowering_fixture';

declare function require(id: string): unknown;
declare const process: { env: Record<string, string | undefined> };
declare const __dirname: string;
declare const console: { log(...args: unknown[]): void };

const fs = require('fs') as { readFileSync(path: string, encoding: 'utf8'): string };

type Outcome = { value: string } | { refused: { class: string; message: string; code?: string } };

function outcome(lower: () => unknown): Outcome {
  try {
    return { value: JSON.stringify(lower()) };
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    const code = (e as { code?: unknown }).code;
    return { refused: { class: e.name, message: e.message, ...(typeof code === 'string' ? { code } : {}) } };
  }
}

interface Case {
  raw: string;
  tree: MExpr;
  mode: Mode;
  where: string;
}

function diff(c: Case): string | undefined {
  const [ts, rust] =
    c.mode === 'expression'
      ? [outcome(() => tsLowerExpression(c.tree, c.raw)), outcome(() => rustLowerExpression(c.tree, c.raw))]
      : [outcome(() => tsLowerCondition(c.tree, c.raw)), outcome(() => rustLowerCondition(c.tree, c.raw))];
  const [a, b] = [JSON.stringify(ts), JSON.stringify(rust)];
  return a === b ? undefined : `${c.where} ${c.mode}: ${JSON.stringify(c.raw)}\n  ts:   ${a}\n  rust: ${b}`;
}

function sliceCases(): Case[] {
  return SLOTS.flatMap(record => {
    let tree: MExpr;
    try {
      tree = parseExpression(record.raw);
    } catch (e) {
      if (e instanceof ExpressionSyntaxError) return [];
      throw e;
    }
    return modesOf(record).map(mode => ({ raw: record.raw, tree, mode, where: 'slot' }));
  });
}

/** Rules the corpora rarely or never reach: every refusal message with a
 *  computed part, the text-reading rules, and the JavaScript string and
 *  number semantics the Rust has to reproduce. */
const EDGE_TEXTS = [
  // calls and their static shape
  'FILE(x)', 'FILE(x, "doc")', 'FILE(x, "pdf")', 'READ()', 'READ(a, b)', 'X.FILE(a)', 'X.READ(a, b)',
  'CHUNKS(t)', 'CHUNKS(t, 5)', 'CHUNKS(t, { ...o })', 'CHUNKS(t, { sise: 1 })', 'CHUNKS(t, { over: 1 })',
  'CHUNKS(t, { zz: 1 })', 'CHUNKS(t, { size: 1, size: 2 })', 'CHUNKS(t, { overlap: 1 })',
  'CHUNKS(t, { size: 1, entities: 2 })', 'CHUNKS(t, { size: 10, overlap: 10 })',
  'CHUNKS(t, { size: 1.5, overlap: 1000000000000000000000 })', 'CHUNKS(t, { size: 0.00000001, overlap: 0.0000001 })',
  'CHUNKS(t, { size: 0.1, overlap: 0.30000000000000004 })', 'CHUNKS(t, { size: 0.0000001, overlap: 1 })',
  'CHUNKS(t, { size: 10, overlap: 2 })', 'CHUNKS(t, { size: 10, unit: u })', 'CHUNKS(t, { size: 10, unit: "x" })',
  'CHUNKS(t, { size: 10, unit: "tokens" })', 'CHUNKS(t, { size: 10, unit: "chars" })', 'CHUNKS(t, { entities: n })',
  'AI()', 'AI(a, b, c)', 'AI("p", x)', 'AI("p", "quick")', 'AI(p, "careful")', 'AI(p)',
  'AT(x)', 'AT(x, 1)', 'KG_EXISTS("q", a)', 'KG_VALUE(q)', 'kg_value("q")', 'CONCAT()',
  'SORT()', 'SORT(x)', 'SORT(x, k)', 'SORT(x, desc)', 'SORT(x, k, Asc)', 'SORT(x, a, b, c)', 'SORT(x, a, b)',
  'JOIN(x, ", ")', 'JOIN(x, sep)', 'COUNT()', 'first(o-[:co]->).url', '`FIRST`(o-[:co]->).url', 'COUNT(o-[:co]->).url.x',
  'f(a: 1)', 'EXTRACT_VALUE(x)', '`EXTRACT_VALUE`', 'EXTRACT_VALUE', 'x.EXTRACT_VALUE',
  // namespaces
  'CURRENCY.GET_NUMBER_FROM_FIGURE(x)', 'currency.get_number_from_figure(x)', 'CURRENCY.NOPE(x)', 'CURRENCY.x',
  'CURRENCY.GET_NUMBER_FROM_FIGURE()', 'TEXT.REGEX_EXTRACT(a)', 'TEXT.REGEX_EXTRACT(a, b, c, d)', 'DATETIME.AT(a, b, c)',
  'NOPE.F(x)', 'Nope.F(x)', 'N.F(x)', 'NOPE.x', 'CURRENCY.CONCAT(a)', 'TEXT.AI(x)', 'DATE.COUNT(x)',
  'EXISTS(CURRENCY)', 'EXISTS(NOPE-[:a]->)', 'EXISTS(TEXT-[:a]->)',
  // exists
  'EXISTS()', 'EXISTS(a, b)', 'EXISTS(x.y WHERE z)', 'EXISTS(edge.y)', 'EXISTS(1)', 'EXISTS(x.y)',
  'EXISTS(x-[:a]-> WHERE b == 1)', 'EXISTS(-[:a]->-[:_resources]->)', 'EXISTS(x-[:a]-.b)', 'EXISTS(f(x)-[:a]->)',
  // chains and walks
  'edge.x', 'EDGE.x', 'edge.x.y', 'f(x).y', '(a).b', '1.b', '-[:a]->', 'x<-[:a]-', 'x<-[a:b]-.c', 'x-[:a]->()',
  'x-[:a]->-[:#extract]->.b', 'x-[:#extract]->.b', 'x-[:_resources]->-[:a]->.b', 'x-[:_resources]->',
  'x-[:_resources]->.name.x', 'x-[:_resources]->.other.x', 'x-[:#resources:EMAIL]->.url', 'x-[:_resources: url ]->.url',
  'x-[:_resources:\u00a0TEXT\u00a0]->.url', 'x-[:_resources:bogus]->.url', 'x-[:a]->-[:_resources]->.content',
  'x-[:_resources WHERE type == "URL" AND NOT mimetype]->.url', 'x-[:_resources WHERE constructor]->.url',
  'x-[:_resources WHERE Foo]->.url', 'x-[:_resources WHERE a + b]->.url', 'x-[:_resources WHERE -name]->.url',
  'x-[:_resources WHERE [name, ...url]]->.url', 'x-[:_resources WHERE name EXISTS]->.url',
  'x-[:_resources WHERE f(x)]->.url', 'x-[:_resources WHERE (contentType == "a")]->.url',
  'x-[:_resources WHERE "s" == @meta]->.url', 'x-[:_resources:TEXT WHERE name == "a" OR url == "b"]->.content',
  '-[#linked WHERE TYPE = \'hub\']->.x', '-[#linked WHERE type=hub]->.x', '-[#linked WHERE type = ""]->.x',
  '-[#linked WHERE subtype == "q" AND type = "a"]->.x', '-[#linked]->.x', '-[#linked WHERE type = "a"]->.x.y',
  '-[#linked WHERE type = "a"]->', '-[#linked x WHERE type = "a"]->.f', 'x-[:a]->-[#linked WHERE a]->.x',
  'x-[t:#transform]->.o', 'x-[#transform { ...a }]->.o', 'x-[#transform { enrich_with: 1 }]->.o',
  'x-[#transform { enrich_with: [1] }]->.o', 'x-[#transform { enrich_with: [{ transform: a }] }]->.o',
  'x-[#transform { enrich_with: [{ transform: a, argument: b }] }]->.o',
  'x-[#transform { enrich_with: [{ transform: a, argument: b, c: 1 }] }]->.o', 'x-[#transform { enrich_with: [] }]->.o',
  'x-[#transform { data: 1 }]->.o', 'x-[#transform { data: [a, ...b] }]->.o', 'x-[#transform { data: [a, b] }]->.o',
  'x-[#transform { z: 1, plugin: p, description: d, a: 2, description: e, z: 3, __proto__: 4, "1": 5 }]->.o',
  'x-[#transform {}]->.o', 'x-[:a ORDER BY k LIMIT 3]->.b', 'x-[:a LIMIT 3]->.b', 'x-[:a ORDER BY k ASC]->.b',
  'x-[:a WHERE b]->-[:c WHERE d]->.e', 'x-[:a]->[0]', 'x[0]',
  // values
  '"a${b}${c}"', '"${a}"', '""', '"é🌍"', '1e21', '0.1', '-0', '1.5e-7', '9007199254740993', 'null', 'true',
  'x WITHIN 30D', 'x WITHIN "30D"', 'x WITHIN 3M', '@meta', '@parent.created', '@parent.bogus', '@resource.url',
  '@resource.', '@current_date', 'IF a THEN b END', 'IF a THEN b ELSE c END', '[1, ...a]', '{ a: 1, ...b }',
  'a AND b AND c', '(a AND b) AND c', 'a AND (b AND c)', 'a OR b OR c', 'a % b', '-a', 'NOT a', 'a IN [1]',
  'a contains b', 'x WHERE y', '(x) => x', '<crm>', 'node { a: 1 }', 'graph { a: 1 }',
  // conditions
  'r IS <crm>', 'r IS <crm-[:company]->>', 'r IS <crm-[:`Odd Name`]->>', 'r IS <crm-[:a b]->>',
  'r IS <crm-[:a]->-[:b]->>', 'r IS <crm-[:a WHERE x == 1]->>', 'r IS <crm<-[:a]->>', 'r IS <crm-[:a]->>[]',
  'r IS <crm>.field', 'r IS { a: <x> }', '`r x` IS <crm>', ' (r) IS <crm>', 'f(r) IS <crm> AND b', 'NOT (r IS <crm>)',
  'a OR r IS <crm>', 'r IS <crm> AND s IS <x-[:y]->> AND z', '(r IS <crm>)', 'r IS <crm-[:a { k: 1 }]->>',
  'r IS <crm-[a:b]->>', 'r IS <crm-[:a LIMIT 1]->>',
  // UTF-16 offsets: text after an astral character
  'f("🌍") IS <crm>', 'r IS <crm-[:a WHERE n == "🌍"]->>', '"🌍" == f(x) AND r IS <crm-[:a WHERE n == "é🌍"]->>',
  '-[#linked WHERE type = "é🌍x"]->.x', '-[#linked WHERE n == "🌍" AND type = 🌍]->.x', 'CHUNKS(t, { "🌍": 1 })',
  'CURRENCY.`🌍`(x)', 'x WITHIN "3🌍"',
];

/** Where the two lowerings differ on purpose, pending a ruling: the
 *  TypeScript looks a `_resources` WHERE name up on a plain object, so
 *  `constructor` finds Object.prototype's and lowers to a `resource` read
 *  with no field; the Rust refuses it as the unknown property it is. */
const PENDING_RULING = new Set(['x-[:_resources WHERE constructor]->.url']);

function edgeCases(): Case[] {
  return EDGE_TEXTS.flatMap(raw => {
    let tree: MExpr;
    try {
      tree = parseExpression(raw);
    } catch (e) {
      if (e instanceof ExpressionSyntaxError) return [];
      throw e;
    }
    return (['expression', 'condition'] as const).map(mode => ({ raw, tree, mode, where: 'edge' }));
  });
}

function syntheticCases(): Case[] {
  return LOWERED.filter(l => l.source === 'synthetic').flatMap(l => {
    try {
      return [{ raw: l.raw, tree: parseExpression(l.raw), mode: l.mode, where: 'synthetic' }];
    } catch (e) {
      if (e instanceof ExpressionSyntaxError) return [];
      throw e;
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Every `{raw, tree}` slot the eager parse attached, anywhere in the AST. */
function slotTrees(value: unknown, out: Array<{ raw: string; tree: MExpr }>): void {
  if (Array.isArray(value)) {
    value.forEach(v => slotTrees(v, out));
  } else if (isRecord(value)) {
    if (typeof value.raw === 'string' && isRecord(value.tree) && typeof value.tree.kind === 'string') {
      out.push({ raw: value.raw, tree: value.tree as unknown as MExpr });
      return;
    }
    Object.values(value).forEach(v => slotTrees(v, out));
  }
}

function programCases(): Case[] {
  const programs = fs
    .readFileSync(`${__dirname}/../../__test__/__fixtures__/programs.json`, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as { source: string; version: number });
  const cases: Case[] = [];
  programs.forEach((program, i) => {
    const { ok, json } = callParser('parse_program_eager', program.source, [program.version]);
    if (!ok) return;
    const slots: Array<{ raw: string; tree: MExpr }> = [];
    slotTrees(json, slots);
    for (const slot of slots) {
      for (const mode of ['expression', 'condition'] as const) {
        cases.push({ ...slot, mode, where: `program ${i} (v${program.version})` });
      }
    }
  });
  return cases;
}

const run = process.env.MOVEMENT_LOWERING_DIFFERENTIAL ? describe : describe.skip;

run('the Rust lowering against the TypeScript', () => {
  it('agrees on every corpus expression text', () => {
    const cases = sliceCases();
    expect(cases.length).toBeGreaterThan(2000);
    const diffs = cases.map(diff).filter((d): d is string => d !== undefined);
    console.log(`slots: ${cases.length} cases, ${diffs.length} diffs`);
    expect(diffs.slice(0, 40)).toEqual([]);
  });

  it('agrees on the pinned hand-written texts and the edge cases', () => {
    const cases = [...syntheticCases(), ...edgeCases()].filter(c => !PENDING_RULING.has(c.raw));
    const diffs = cases.map(diff).filter((d): d is string => d !== undefined);
    const unparsed = EDGE_TEXTS.filter(raw => !cases.some(c => c.raw === raw));
    console.log(`synthetic + edge: ${cases.length} cases, ${diffs.length} diffs; edge texts that do not parse: ${JSON.stringify(unparsed)}`);
    expect(diffs).toEqual([]);
  });

  it('agrees on every slot tree of every pinned program', () => {
    const cases = programCases();
    expect(cases.length).toBeGreaterThan(2000);
    const seen = new Set<string>();
    const unique = cases.filter(c => {
      const key = `${c.mode}\u0000${c.raw}\u0000${JSON.stringify(c.tree)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const diffs = unique.map(diff).filter((d): d is string => d !== undefined);
    console.log(`programs: ${cases.length} cases (${unique.length} distinct), ${diffs.length} diffs`);
    expect(diffs.slice(0, 40)).toEqual([]);
  });
});
