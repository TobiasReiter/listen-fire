// The parser entry points' Rust side: each call goes through the WASM module
// (wasm/loader.ts) and its JSON comes back as the TypeScript AST types. The
// error envelope is validated here; the tree itself is trusted as the Rust
// parser's own output, whose shape the pinned corpora hold
// (parser/__test__/programs_regression, parser/expression/__test__/trees_regression).

import { ExpressionSyntaxError } from '../expression/error';
import { slotTrees } from '../expression/slot_trees';
import { callParser } from '../wasm/loader';
import type { ExprSlot, Loc, Program, RValue } from './ast';
import type { MExpr } from './expression/tree';

/** A statement-grammar refusal: the base message (the caller's error class
 *  appends the location) and where. */
export interface StatementRefusal {
  message: string;
  loc: Loc;
}

export type StatementParse<T> = { ok: true; value: T } | { ok: false; refusal: StatementRefusal };

export function rustParseProgram(source: string, languageVersion: number): StatementParse<Program> {
  const { ok, json } = callParser('parse_program_eager', source, [languageVersion]);
  if (!ok) return { ok: false, refusal: statementRefusal(json) };
  if (!isProgram(json)) throw malformed('parse_program_eager', json);
  absorbSlotTrees(json);
  return { ok: true, value: json };
}

export function rustParseNestedCall(
  slot: ExprSlot,
  at: { start: number; end: number },
  languageVersion: number,
): StatementParse<RValue> {
  const origin = slot.span.start;
  const { ok, json } = callParser('parse_nested_call', slot.raw, [
    at.start,
    at.end,
    origin.line,
    origin.col,
    languageVersion,
  ]);
  if (!ok) return { ok: false, refusal: statementRefusal(json) };
  if (!isRValue(json)) throw malformed('parse_nested_call', json);
  absorbSlotTrees(json);
  return { ok: true, value: json };
}

/** Throws `ExpressionSyntaxError`. A text read here is not a program's slot
 *  (those arrive parsed, under their program's version): it reads as versions
 *  1–4 do (version 0), so a probe's text never takes the v5 surface's
 *  meaning — unless the reader names the program's version, for a text the
 *  program wrote (a type's hops), which reads as its slots did. */
export function rustParseExpression(source: string, languageVersion = 0): MExpr {
  const { ok, json } = callParser('parse_expression', source, [languageVersion]);
  if (!ok) throw expressionError(json, 'parse_expression');
  if (!isTree(json)) throw malformed('parse_expression', json);
  return json;
}

/**
 * Moves each slot's eager parse (`tree` or `error`, which the Rust parser
 * adds beside `raw` and `span`) into the bridge's slot cache, leaving the
 * slot exactly `{raw, span}`. A fresh object replaces the slot rather than
 * deleting the two keys, which would leave V8 a slow dictionary object.
 */
function absorbSlotTrees(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((child: unknown, i) => {
      const slot = parsedSlot(child);
      if (slot === undefined) absorbSlotTrees(child);
      else value[i] = slot;
    });
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const slot = parsedSlot(child);
      if (slot === undefined) absorbSlotTrees(child);
      else value[key] = slot;
    }
  }
}

/** A slot carrying its eager parse, as a bare slot with the parse cached.
 *  No other parser AST record has a `tree` or `error` key, so one that does
 *  but lacks a slot's `raw`/`span` is a broken slot, not some other node. */
function parsedSlot(record: unknown): ExprSlot | undefined {
  if (!isRecord(record) || (!('tree' in record) && !('error' in record))) return undefined;
  const { raw, span, tree, error } = record;
  if (typeof raw !== 'string' || !isSpan(span)) throw malformed('slot', record);
  const slot: ExprSlot = { raw, span };
  if (tree !== undefined) {
    if (!isTree(tree)) throw malformed('a slot tree', tree);
    slotTrees.set(slot, tree);
  } else {
    slotTrees.set(slot, expressionError({ error }, 'a slot'));
  }
  return slot;
}

function statementRefusal(json: unknown): StatementRefusal {
  const error = isRecord(json) ? json.error : undefined;
  if (!isRecord(error) || typeof error.message !== 'string' || !isLoc(error.loc)) {
    throw malformed('a statement refusal', json);
  }
  return { message: error.message, loc: { line: error.loc.line, col: error.loc.col } };
}

function expressionError(json: unknown, what: string): ExpressionSyntaxError {
  const error = isRecord(json) ? json.error : undefined;
  if (!isRecord(error) || typeof error.message !== 'string' || typeof error.pos !== 'number') {
    throw malformed(`${what}'s expression refusal`, json);
  }
  return new ExpressionSyntaxError(error.message, error.pos);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLoc(value: unknown): value is Loc {
  return isRecord(value) && typeof value.line === 'number' && typeof value.col === 'number';
}

function isSpan(value: unknown): value is ExprSlot['span'] {
  return isRecord(value) && isLoc(value.start) && isLoc(value.end);
}

// The guards below on the parser's TREES are shallow on purpose: they tell
// the envelopes apart and catch a gross ABI mismatch; everything beneath the
// root is trusted as the Rust parser's own output.

function isProgram(value: unknown): value is Program {
  return isRecord(value) && Array.isArray(value.statements);
}

function isRValue(value: unknown): value is RValue {
  return isRecord(value) && typeof value.kind === 'string';
}

function isTree(value: unknown): value is MExpr {
  return isRecord(value) && typeof value.kind === 'string' && isRecord(value.at);
}

function malformed(what: string, json: unknown): Error {
  return new Error(`the movement parser returned a malformed ${what}: ${JSON.stringify(json)?.slice(0, 200)}`);
}
