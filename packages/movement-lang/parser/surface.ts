// The language surface of version 5 (plans/naming-rethink-2026-10-14/5_design.md):
// its spelling table and rewrite live in Rust (crates/movement-parser/src/surface);
// this is the TypeScript's view of them through the WASM.

import type { Span } from './ast';
import type { DiagnosticFix } from '../checker/fixes';
import { callParser } from '../wasm/loader';

/** An old spelling in a version 5 program: refused, its rewrite as the fix.
 *  `Program.spelling` carries them; both checkers report each as a diagnostic. */
export interface SpellingFinding {
  code: string;
  message: string;
  span: Span;
  fix?: DiagnosticFix;
}

/** `message` naming every built-in it quotes as `version` spells it
 *  (`UPPER` under 4, `Text.upper` under 5). */
export function spellMessage(message: string, version: number): string {
  if (version < 5) return message;
  const { ok, json } = callParser('spell_message', message, [version]);
  if (!ok || typeof json !== 'string') throw new Error(`spell_message: ${JSON.stringify(json)}`);
  return json;
}

/** Program text a diagnostic suggests (`EXISTS(x)`, `AT(r, 0)`, `IF … THEN
 *  "Yes" ELSE "No" END`), written in the canonical spelling, as `version`
 *  spells it: as it is under 1–4, rewritten by the parser's own spelling
 *  fixes from 5 (`x != null`, `r[0]`, `… ? "Yes" : "No"`). `…` stands for any
 *  expression. Pass only code: a text that parses is rewritten. */
export function spellCode(code: string, version: number): string {
  if (version < 5) return code;
  const { ok, json } = callParser('spell_code', code, [version]);
  if (!ok || typeof json !== 'string') throw new Error(`spell_code: ${JSON.stringify(json)}`);
  return json;
}

/** A word of code in prose (`negated by NOT`, `narrow with an IS test`): bare
 *  up to version 4, where it is a CAPS word; quoted from 5, where it is a
 *  symbol or lower case (`negated by '!'`). */
export function spellWord(word: string, version: number): string {
  return version < 5 ? word : `'${spellCode(word, version)}'`;
}

/** The head of an `if` a diagnostic suggests (`if EXISTS(x)`), as
 *  `version` spells it: from 5 its condition is parenthesised and respelled
 *  (`if (x != null)`). For a suggestion whose body is not code. */
export function spellIf(condition: string, version: number): string {
  return version < 5 ? `if ${condition}` : `if (${spellCode(condition, version)})`;
}

export interface SpellingRow {
  canonical: string;
  v5: string;
  shape: string;
  oldOnly: boolean;
  newOnly: boolean;
}

export interface SurfaceTable {
  spellings: SpellingRow[];
  namespaces: string[];
  walkCaps: [string, string][];
  operators: [string, string][];
  statementWords: [string, string][];
}

let table: SurfaceTable | undefined;

/** The spelling table, read once from the WASM. */
export function surfaceTable(): SurfaceTable {
  if (table === undefined) {
    const { ok, json } = callParser('surface_table', '', [0]);
    if (!ok || !isTable(json)) throw new Error(`surface_table: ${JSON.stringify(json)}`);
    table = json;
  }
  return table;
}

function isTable(value: unknown): value is SurfaceTable {
  return typeof value === 'object' && value !== null && Array.isArray((value as { spellings?: unknown }).spellings);
}
