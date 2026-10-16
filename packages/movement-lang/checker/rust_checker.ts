// The Rust checker (crates/movement-checker), through the movement artifact's
// `check_program` export: the checker a program that runs on the Rust engine
// is held to, at its run and wherever it is validated for one. It reports the
// TypeScript checker's diagnostics, shape and order included (PARITY.md), and
// reads the catalog as the snapshot a run is handed, file imports resolving
// against the snapshot's `files`.
//
// It loads with the engine artifact, which a browser never downloads: the
// editor's live diagnostics stay on the TypeScript checker.

import { callCheckProgram } from '../wasm/loader';
import type { Loc, Span } from '../parser/ast';
import type { LanguageVersion } from '../language_version';
import type { CatalogSnapshot } from '../service/snapshot';
import type { Diagnostic } from './check';
import type { DiagnosticFix, SourceEdit } from './fixes';

export interface RustCheckOptions {
  languageVersion: LanguageVersion;
  /** Checking for a move up from this version (`CheckOptions.upgradingFrom`). */
  upgradingFrom?: LanguageVersion;
}

/** A source the Rust checker could not check: it does not parse, or the
 *  snapshot does not load. */
export class RustCheckRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RustCheckRefused';
  }
}

/** Every diagnostic the Rust checker reports for `source` against
 *  `snapshot`, warnings and info included. */
export function checkSourceInRust(source: string, snapshot: CatalogSnapshot, options: RustCheckOptions): Diagnostic[] {
  const reply = callCheckProgram(source, JSON.stringify(snapshot), options.languageVersion, options.upgradingFrom ?? 0);
  const json: unknown = reply.json;
  if (!reply.ok) {
    const error = isRecord(json) && isRecord(json.error) ? json.error : undefined;
    throw new RustCheckRefused(typeof error?.message === 'string' ? error.message : 'the Rust checker refused the check');
  }
  const diagnostics = isRecord(json) ? json.diagnostics : undefined;
  if (!Array.isArray(diagnostics)) throw new Error('the Rust checker answered no diagnostics');
  return diagnostics.map(diagnosticOf);
}

function diagnosticOf(value: unknown): Diagnostic {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') {
    throw new Error(`the Rust checker answered a diagnostic that is not one: ${JSON.stringify(value)}`);
  }
  const severity = value.severity;
  if (severity !== undefined && severity !== 'warning' && severity !== 'info') {
    throw new Error(`the Rust checker answered the severity ${JSON.stringify(severity)}`);
  }
  return {
    code: value.code,
    message: value.message,
    span: spanOf(value.span),
    ...(severity !== undefined ? { severity } : {}),
    ...(value.upgrade === true ? { upgrade: true } : {}),
    ...(value.fix !== undefined ? { fix: fixOf(value.fix) } : {}),
  };
}

function fixOf(value: unknown): DiagnosticFix {
  const edits = isRecord(value) ? value.edits : undefined;
  if (!Array.isArray(edits)) throw new Error(`the Rust checker answered a fix with no edits: ${JSON.stringify(value)}`);
  return {
    edits: edits.map((edit): SourceEdit => {
      if (!isRecord(edit) || typeof edit.text !== 'string') throw new Error(`the Rust checker answered an edit that is not one: ${JSON.stringify(edit)}`);
      return { span: spanOf(edit.span), text: edit.text };
    }),
    ...(isRecord(value) && value.safe === true ? { safe: true as const } : {}),
  };
}

function spanOf(value: unknown): Span {
  if (!isRecord(value)) throw new Error(`the Rust checker answered a span that is not one: ${JSON.stringify(value)}`);
  return { start: locOf(value.start), end: locOf(value.end) };
}

function locOf(value: unknown): Loc {
  if (!isRecord(value) || typeof value.line !== 'number' || typeof value.col !== 'number') {
    throw new Error(`the Rust checker answered a position that is not one: ${JSON.stringify(value)}`);
  }
  return { line: value.line, col: value.col };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
