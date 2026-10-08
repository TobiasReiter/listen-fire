// What every expression text the corpora produce lowers to, pinned.
//
// `expression_slots.json` holds every expression text the v1, v2 and current
// corpora produce (regenerate with ../harvest). `expression_slots.lowered.json`
// holds what each one lowers to — or that it is refused, and with which code —
// as a condition, an expression, or both, plus hand-written texts for what the
// corpora never write. It was recorded from the old text-rewriting bridge
// before the one grammar replaced it (2_one_grammar.md, step 2), and has changed
// since only where a ruling changed what a text means; the regression test
// names each such ruling.

import type { Expression } from '@listen-fire/shared/expression/types';
import { lowerMovementCondition, lowerMovementExpression, type MovementCondition } from '../lower';
import { ExpressionSyntaxError, parseExpression } from '../parse_expression';

// This package carries no Node typings; jest's module scope has `require`,
// which reads the JSON fixtures natively.
declare function require(id: string): unknown;

export interface SlotRecord {
  raw: string;
  /** How the text reached the code: an ExprSlot of a parsed program (`slot`),
   *  a call into the expression or condition entry, or a construct the
   *  statement layer reads (`closure`, `node`, `graph`, `declaration`). */
  entries: string[];
  versions: number[];
  corpora: string[];
  where?: string[];
}

export type Mode = 'expression' | 'condition';

export type Lowered =
  | { raw: string; mode: Mode; source: 'corpus' | 'synthetic'; lowered: Expression | MovementCondition }
  /** `true` when the refusal carries no diagnostic code of its own. */
  | { raw: string; mode: Mode; source: 'corpus' | 'synthetic'; refused: string | true };

/** Regenerate with ../harvest (see jest.harvest.cjs and build_fixture.cjs). */
export const SLOTS = require('./__fixtures__/expression_slots.json') as SlotRecord[];

export const LOWERED = require('./__fixtures__/expression_slots.lowered.json') as Lowered[];

/** The modes a text was consumed under. A text only ever seen as an ExprSlot
 *  is read as an expression. */
export function modesOf(record: SlotRecord): Mode[] {
  const modes: Mode[] = [];
  if (record.entries.includes('expression')) modes.push('expression');
  if (record.entries.includes('condition')) modes.push('condition');
  if (modes.length === 0) modes.push('expression');
  return modes;
}

/** Texts that reached the expression entries, or were an expression slot. */
const EXPRESSION_ENTRIES = ['expression', 'condition', 'slot'];

export function corpusCases(): Array<{ raw: string; mode: Mode }> {
  return SLOTS.filter(record => record.entries.some(e => EXPRESSION_ENTRIES.includes(e))).flatMap(record =>
    modesOf(record).map(mode => ({ raw: record.raw, mode })),
  );
}

/** What a text lowers to now, in the fixture's own form. */
export function lowerNow(raw: string, mode: Mode, source: Lowered['source']): Lowered {
  try {
    const lowered = mode === 'expression' ? lowerMovementExpression(raw) : lowerMovementCondition(raw);
    return { raw, mode, source, lowered };
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    const code = (e as { code?: unknown }).code;
    return { raw, mode, source, refused: typeof code === 'string' ? code : true };
  }
}

/** Key order and `undefined` members are not part of a value. */
export { canonical } from '../../../conformance/checks_corpus';

/** The constructs the statement layer reads today and the new grammar reads
 *  as expressions, with the tree kind each must parse to. */
export const CONSTRUCTS = { closure: 'closure', node: 'node', graph: 'graph', declaration: 'declaration' } as const;

export interface ConstructCase {
  raw: string;
  construct: keyof typeof CONSTRUCTS;
  /** The tree kind it parsed to, or the syntax error. */
  result: { ok: true; kind: string } | { ok: false; message: string };
}

export function parseConstructs(): ConstructCase[] {
  return SLOTS.flatMap(record =>
    record.entries
      .filter((e): e is keyof typeof CONSTRUCTS => e in CONSTRUCTS)
      // A callback's subject is stored as a closure, but written as a bare
      // block or parameter list — not the `(x) => …` form.
      .filter(construct => construct !== 'closure' || (record.raw.startsWith('(') && record.raw.includes('=>')))
      .map((construct): ConstructCase => {
        // `export` marks the declaration, at statement level; it is not part of it.
        const raw = construct === 'declaration' ? record.raw.replace(/^export\s+/, '') : record.raw;
        try {
          return { raw, construct, result: { ok: true, kind: parseExpression(raw).kind } };
        } catch (e) {
          if (!(e instanceof ExpressionSyntaxError)) throw e;
          return { raw, construct, result: { ok: false, message: e.message } };
        }
      }),
  );
}
