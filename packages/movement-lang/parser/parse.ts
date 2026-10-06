// The statement layer's entry points. The grammar is the Rust parser
// (crates/movement-parser), loaded as WebAssembly by wasm/loader.ts; this file
// is the TypeScript surface over it. Expression positions come back as ExprSlot
// spans whose trees the bridge reads (expression/bridge.ts).

import { CURRENT_LANGUAGE_VERSION, type LanguageVersion } from '../language_version';
import type { ExprSlot, Loc, Program, RValue } from './ast';
import { rustParseNestedCall, rustParseProgram, type StatementParse } from './rust_parser';

export class MovementParseError extends Error {
  readonly loc: Loc;

  constructor(message: string, loc: Loc) {
    super(`${message} (line ${loc.line}, col ${loc.col})`);
    this.name = 'MovementParseError';
    this.loc = loc;
  }
}

/** The compile context a parse runs under. */
export interface ParseOptions {
  /** The language version the source is written against — what a version
   *  conditional in the grammar reads. Absent ⇒ the current version. */
  languageVersion?: LanguageVersion;
}

export function parseProgram(source: string, options?: ParseOptions): Program {
  const languageVersion = options?.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  return refusedAsError(rustParseProgram(source, languageVersion));
}

/**
 * A call written inside an expression — `f(x)` in `f(x) + 1`, `extract(c, S)`
 * in `ONLY(extract(c, S))` — read as the right-hand side of a binding, which
 * is what it means (language version 3): the expression is the same as binding
 * the call to a fresh name first and reading the name. `at` is the call's
 * extent in `slot.raw`, as the expression grammar found it; the statement
 * grammar reads it because a call's arguments are its own (a closure's
 * statements, a type, a node literal). Spans are the file's.
 */
export function parseNestedCall(
  slot: ExprSlot,
  at: { start: number; end: number },
  languageVersion: LanguageVersion,
): RValue {
  return refusedAsError(rustParseNestedCall(slot, at, languageVersion));
}

function refusedAsError<T>(parse: StatementParse<T>): T {
  if (parse.ok) return parse.value;
  throw new MovementParseError(parse.refusal.message, parse.refusal.loc);
}
