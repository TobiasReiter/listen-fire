// The expression bridge — from the movement language's expression grammar to
// the shared formula `Expression` (packages/shared/expression/types.ts) that
// the checker, the engine, the web app and adapter pushdown read.
//
// One grammar reads every expression slot (parser/expression/parse_expression.ts)
// into a structured tree, and the lowering (parser/expression/lower.ts) turns
// that tree into the shared `Expression`. Plan:
// plans/functional-extract-2026-10-02/2_one_grammar.md.
//
// A slot the statement parser captured is read through `expressionOfSlot` /
// `conditionOfSlot`, which parse its text once and keep the tree beside the
// slot. `parseMovementExpression` / `parseMovementCondition` read a text that is
// not a slot (a probe a consumer builds, a narrowing's stored WHERE).

import type { Expression } from '@listen-fire/shared/expression/types';
import type { ExprSlot } from '../parser/ast';
import {
  lowerCondition,
  lowerExpression,
  lowerMovementCondition,
  lowerMovementExpression,
  type MovementCondition,
} from '../parser/expression/lower';
import { ExpressionSyntaxError, parseExpression } from '../parser/expression/parse_expression';
import type { MExpr } from '../parser/expression/tree';
import { BridgeError } from './error';

export { BridgeError } from './error';
export { POSITION_SENTINEL, type MovementCondition } from '../parser/expression/lower';

export function parseMovementExpression(raw: string): Expression {
  return lowerMovementExpression(raw);
}

export function parseMovementCondition(raw: string): MovementCondition {
  return lowerMovementCondition(raw);
}

// ── Slots ──
//
// A slot's tree is kept beside the slot object rather than on it: the slot is
// the statement layer's verbatim capture, and slots are also built from text
// by the checker, the story and tests. Each is parsed once however many
// readers (the engine reads one slot up to four ways per evaluation) ask.

const slotTrees = new WeakMap<ExprSlot, MExpr | ExpressionSyntaxError>();

function treeOf(slot: ExprSlot): MExpr {
  let tree = slotTrees.get(slot);
  if (tree === undefined) {
    try {
      tree = parseExpression(slot.raw);
    } catch (e) {
      if (!(e instanceof ExpressionSyntaxError)) throw e;
      tree = e;
    }
    slotTrees.set(slot, tree);
  }
  if (tree instanceof ExpressionSyntaxError) throw tree;
  return tree;
}

/** The slot's tree as the grammar read it, before lowering decides what any
 *  name in it means — what call resolution walks. Throws the slot's syntax
 *  error, as the lowerings below do. */
export function treeOfSlot(slot: ExprSlot): MExpr {
  return treeOf(slot);
}

/**
 * A slot whose tree is `tree` — a rewriting of `slot`'s own tree (a nested
 * call replaced by the name it is bound to), or one of its sub-expressions.
 * Offsets in `tree` are `slot.raw`'s, so the text is kept: for a
 * sub-expression, with everything outside it blanked, so a reader of the text
 * sees only the part the tree is.
 */
export function slotOfTree(slot: ExprSlot, tree: MExpr): ExprSlot {
  const whole = tree.at.start === 0 && tree.at.end === slot.raw.length;
  const raw = whole
    ? slot.raw
    : slot.raw.slice(0, tree.at.start).replace(/[^\n]/g, ' ')
      + slot.raw.slice(tree.at.start, tree.at.end)
      + slot.raw.slice(tree.at.end).replace(/[^\n]/g, ' ');
  const derived: ExprSlot = { raw, span: slot.span };
  slotTrees.set(derived, tree);
  slotOrigins.set(derived, originalSlot(slot));
  return derived;
}

const slotOrigins = new WeakMap<ExprSlot, ExprSlot>();

/** The slot the statement layer captured that `slot` was derived from
 *  (`slotOfTree`) — `slot` itself when it is one. A derived slot keeps the
 *  original's offsets, so a place in one is the same place in the other. */
export function originalSlot(slot: ExprSlot): ExprSlot {
  return slotOrigins.get(slot) ?? slot;
}

/** The slot as a value expression. */
export function expressionOfSlot(slot: ExprSlot): Expression {
  return lowerExpression(treeOf(slot), slot.raw);
}

/** The slot as an `if` condition. */
export function conditionOfSlot(slot: ExprSlot): MovementCondition {
  return lowerCondition(treeOf(slot), slot.raw);
}

/**
 * A string slot's text for a READER — the story, a diagnostic, a listing.
 * A literal that interpolates has no text until it is evaluated in a firing
 * environment, so what a reader is shown is the source they wrote: the point
 * is that the `${…}` stays visible AS an interpolation rather than being
 * mistaken for the words the extractor will get. Anything that needs the real
 * text must evaluate the slot. Anything but one double-quoted string is shown
 * as written.
 */
export function authoredStringText(raw: string): string {
  let tree: MExpr;
  try {
    tree = parseExpression(raw);
  } catch (e) {
    if (e instanceof BridgeError) return raw;
    throw e;
  }
  if (tree.kind !== 'string' || tree.quote !== '"') return raw;
  if (tree.parts.every(p => typeof p === 'string')) return tree.parts.join('');
  // Interpolating: the source between the quotes, `${…}` and all.
  return raw.slice(tree.at.start + 1, tree.at.end - 1);
}

// ── `unique by (…)` ──
//
// A `unique by` predicate is a comma-separated list of components, each
// optionally prefixed FUZZY — not one expression — so it is split here, on the
// text, before each component is read as one.

function skipBacktick(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) { i += 2; continue; }
    if (text[i] === '`') return i + 1;
    i++;
  }
  throw new BridgeError('Unterminated backtick-quoted name', start);
}

function skipString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) { i += 2; continue; }
    if (quote === '"' && ch === '$' && text[i + 1] === '{') {
      i = skipInterpolation(text, i + 2);
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  throw new BridgeError('Unterminated string literal', start);
}

/** `start` is the index just after `${`; returns the index just after the matching `}`. */
function skipInterpolation(text: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { i = skipString(text, i); continue; }
    if (ch === '`') { i = skipBacktick(text, i); continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  throw new BridgeError('Unterminated ${…} interpolation', start - 2);
}

/** A same-length copy of `text` with every string and backtick literal
 *  (delimiters included) blanked, so positions map back to the original. */
function blankLiterals(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = ch === '`' ? skipBacktick(text, i) : skipString(text, i);
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Bracket depth ((), [], {}) at each position of (already-blanked) text. */
function bracketDepths(blanked: string): number[] {
  const depths: number[] = new Array(blanked.length);
  let depth = 0;
  for (let i = 0; i < blanked.length; i++) {
    const ch = blanked[i];
    if (ch === '(' || ch === '[' || ch === '{') { depths[i] = depth; depth++; }
    else if (ch === ')' || ch === ']' || ch === '}') { depth--; depths[i] = depth; }
    else depths[i] = depth;
  }
  return depths;
}

/** One top-level conjunct of a `unique by (…)` predicate, with its FUZZY
 *  modifier lifted off. */
export interface UniquenessConjunct {
  /** The conjunct's expression text, FUZZY modifier removed, trimmed. */
  raw: string;
  /** Char offset of `raw` within the original predicate (for diagnostics). */
  offset: number;
  /** True when the conjunct was prefixed with the FUZZY modifier. */
  fuzzy: boolean;
}

/** A leading `FUZZY` modifier on a uniqueness component — uppercase, like the
 *  AND/OR keywords, so a field literally named `fuzzy` is never mistaken for it. */
const FUZZY_MODIFIER = /^\s*FUZZY\b\s*/;

/**
 * Split a `unique by (…)` predicate into its components on the top-level COMMA,
 * lifting a leading `FUZZY` modifier off each. Comma is the component separator
 * (clearer than `AND`, which is *also* an expression operator); `AND` still
 * works inside a single component as an ordinary conjunction (the engine and
 * checker flatten it). FUZZY is a uniqueness-local marker — "match this
 * component by similarity, surfacing close candidates for the engine to
 * arbitrate" — not a general expression operator (it would be meaningless in a
 * WHERE filter), so it is stripped here before the remainder is parsed as an
 * ordinary movement expression. Literals and brackets are blanked so a comma
 * inside a string, a `[:edge]` hop, or a `WITHIN(7, days)` call never splits.
 */
export function splitUniquenessConjuncts(raw: string): UniquenessConjunct[] {
  const blanked = blankLiterals(raw);
  const depths = bracketDepths(blanked);

  const spans: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < blanked.length; i++) {
    if (blanked[i] === ',' && depths[i] === 0) {
      spans.push({ start, end: i });
      start = i + 1;
    }
  }
  spans.push({ start, end: raw.length });

  return spans.map((span) => {
    const text = raw.slice(span.start, span.end);
    const fuzzyMatch = FUZZY_MODIFIER.exec(text);
    if (fuzzyMatch !== null) {
      const rest = text.slice(fuzzyMatch[0].length);
      return { raw: rest.trim(), offset: span.start + fuzzyMatch[0].length, fuzzy: true };
    }
    const lead = text.length - text.trimStart().length;
    return { raw: text.trim(), offset: span.start + lead, fuzzy: false };
  });
}

/**
 * What one conjunct of a `unique by` component contributes to the KEY the
 * target's lookup searches by: a bare name (a field of the record, identified
 * by the value written, or a bound parent handle), or `field == value` (the
 * field, compared with `value`). Undefined for every other conjunct (`WITHIN`,
 * `!=`, a range), which narrows the candidates that lookup returns instead.
 * The checker and the engine both split a clause by this, so they cannot
 * disagree about which conjuncts are which.
 */
export function identityKeyOf(
  conjunct: Expression,
): { name: string; comparedWith?: Expression } | undefined {
  switch (conjunct.type) {
    case 'property':
    case 'edge_property':
      return { name: conjunct.propertyTypeId };
    case 'alias_ref':
      return { name: conjunct.name };
    case 'compare':
      if (conjunct.op !== 'eq') return undefined;
      if (conjunct.left.type !== 'property' && conjunct.left.type !== 'edge_property') return undefined;
      return { name: conjunct.left.propertyTypeId, comparedWith: conjunct.right };
    default:
      return undefined;
  }
}
