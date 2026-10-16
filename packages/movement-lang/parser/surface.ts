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
