// Upgrading a program's text to a newer language version by its own fixes.
//
// There is no source printer. A check under the target version reports every
// construct the move broke, and where the rewrite is certain it carries it as
// a fix (fixes.ts): an old spelling under 5 is `MOV_V5_SPELLING` with its
// exact rewrite. So an upgrade is a loop — check, take the fixes that do not
// overlap, apply them, check again — until nothing fixable is left. A fix is
// written from the text it was reported against, so a fix nested inside
// another one comes round on the next pass. Only the rewritten spans change:
// comments and layout everywhere else survive byte for byte, and a text with
// nothing to fix comes back unchanged (the loop is idempotent).
//
// Whether a pin may then move is the caller's decision, on what is left.
//
// Every surface that rewrites shares this one loop, and each runs only when
// asked: `lf upgrade`, the API's explicit upgrade (and the agent tool), and the
// script beside this package (conformance/upgrade_text.ts). The deploy check
// never rewrites a movement's text.

import { parseProgram, MovementParseError } from '../parser/parse';
import type { Loc, Span } from '../parser/ast';
import { CURRENT_LANGUAGE_VERSION, type LanguageVersion } from '../language_version';
import type { CatalogSnapshot } from '../service/snapshot';
import { checkProgram, diagnosticSeverity, type Diagnostic } from './check';
import type { Catalog } from './catalog';
import { checkSourceInRust, RustCheckRefused } from './rust_checker';
import { applyFix, type DiagnosticFix, type SourceEdit } from './fixes';

/** Every diagnostic a check of `source` under the target version reports. */
export type UpgradeCheck = (source: string) => Diagnostic[];
export type AsyncUpgradeCheck = (source: string) => Promise<Diagnostic[]>;

export interface UpgradeResult {
  /** The rewritten text — the input itself when nothing applied. */
  source: string;
  changed: boolean;
  /** How many fixes were applied, over every pass. */
  applied: number;
  /** What the last check still reports: errors, and warnings marking a
   *  construct whose meaning changed (`Diagnostic.upgrade`), spans into
   *  `source`. Empty means the text checks clean under the target. */
  remaining: Diagnostic[];
  /** False when the fixes kept producing new ones past the pass limit — a
   *  bug in some fix, reported rather than looped on. */
  settled: boolean;
  /** Among `remaining`, those whose fix was offered but not applied: it is
   *  not marked safe (`DiagnosticFix.safe`) and `all` was not asked for. A
   *  person reads these and decides. */
  held: Diagnostic[];
}

export interface UpgradeOptions {
  /** Apply every fix offered, not only those marked safe — a person asked
   *  for it (`lf upgrade --all`, the API's `applyAllFixes`). */
  all?: boolean;
}

/** One fix per pass per place is safe; a well-behaved upgrade settles in a
 *  pass or two per level of nesting. */
const MAX_PASSES = 16;

/** The diagnostics that stand between a text and the target version. */
function standing(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d) => diagnosticSeverity(d) === 'error' || d.upgrade === true);
}

/**
 * The fixes one pass applies: every standing diagnostic's fix, outermost first,
 * skipping any fix that overlaps one already taken (it is reported again
 * against the rewritten text). A fix is taken whole or not at all.
 */
function fixesToApply(diagnostics: Diagnostic[], options: UpgradeOptions): DiagnosticFix[] {
  const offered = standing(diagnostics)
    .map((d) => d.fix)
    .filter((fix): fix is DiagnosticFix => fix !== undefined && fix.edits.length > 0 && (options.all === true || fix.safe === true));
  const extent = (fix: DiagnosticFix): Span => ({
    start: fix.edits.map((e) => e.span.start).reduce((a, b) => (compareLoc(a, b) <= 0 ? a : b)),
    end: fix.edits.map((e) => e.span.end).reduce((a, b) => (compareLoc(a, b) >= 0 ? a : b)),
  });
  offered.sort((a, b) => {
    const x = extent(a);
    const y = extent(b);
    return compareLoc(x.start, y.start) || compareLoc(y.end, x.end);
  });
  const taken: DiagnosticFix[] = [];
  const seen = new Set<string>();
  for (const fix of offered) {
    const key = JSON.stringify(fix.edits);
    // Two diagnostics offering the same repair (one import line for two uses)
    // apply it once.
    if (seen.has(key)) continue;
    if (taken.some((t) => t.edits.some((a) => fix.edits.some((b) => editsOverlap(a, b))))) continue;
    seen.add(key);
    taken.push(fix);
  }
  return taken;
}

/** Two edits touch the same text — or insert at the same place, where their
 *  order would be a guess. */
function editsOverlap(a: SourceEdit, b: SourceEdit): boolean {
  const empty = (e: SourceEdit): boolean => compareLoc(e.span.start, e.span.end) === 0;
  if ((empty(a) || empty(b)) && compareLoc(a.span.start, b.span.start) === 0) return true;
  return compareLoc(a.span.start, b.span.end) < 0 && compareLoc(b.span.start, a.span.end) < 0;
}

function compareLoc(a: Loc, b: Loc): number {
  return a.line - b.line || a.col - b.col;
}

interface Pass {
  source: string;
  applied: number;
  remaining: Diagnostic[] | undefined;
}

/** One pass: what the check said, and the text after its fixes — or, when it
 *  offered none, the verdict. */
function pass(source: string, diagnostics: Diagnostic[], options: UpgradeOptions): Pass {
  const fixes = fixesToApply(diagnostics, options);
  if (fixes.length === 0) return { source, applied: 0, remaining: standing(diagnostics) };
  const rewritten = applyFix(source, { edits: fixes.flatMap((f) => f.edits) });
  // A fix that rewrites to the same text would loop forever.
  if (rewritten === source) return { source, applied: 0, remaining: standing(diagnostics) };
  return { source: rewritten, applied: fixes.length, remaining: undefined };
}

/** Upgrade `source` by `check`'s fixes (see the top of this file). */
export function upgradeSource(source: string, check: UpgradeCheck, options: UpgradeOptions = {}): UpgradeResult {
  let text = source;
  let applied = 0;
  for (let i = 0; i < MAX_PASSES; i++) {
    const step = pass(text, check(text), options);
    if (step.remaining !== undefined) return result(source, text, applied, step.remaining, true);
    text = step.source;
    applied += step.applied;
  }
  return result(source, text, applied, standing(check(text)), false);
}

/** `upgradeSource` over a check that answers asynchronously (the API's,
 *  which reads the team's connected systems). */
export async function upgradeSourceAsync(source: string, check: AsyncUpgradeCheck, options: UpgradeOptions = {}): Promise<UpgradeResult> {
  let text = source;
  let applied = 0;
  for (let i = 0; i < MAX_PASSES; i++) {
    const step = pass(text, await check(text), options);
    if (step.remaining !== undefined) return result(source, text, applied, step.remaining, true);
    text = step.source;
    applied += step.applied;
  }
  return result(source, text, applied, standing(await check(text)), false);
}

function result(original: string, source: string, applied: number, remaining: Diagnostic[], settled: boolean): UpgradeResult {
  const held = remaining.filter((d) => d.fix !== undefined && d.fix.edits.length > 0);
  return { source, changed: source !== original, applied, remaining, settled, held };
}

// ── The checks an upgrade runs on ───────────────────────────────────────────

/** A text that does not parse under the target, as the diagnostic a check
 *  would have reported for it. */
function parseRefusal(error: MovementParseError): Diagnostic {
  return { code: 'MOV_PARSE', message: error.message, span: { start: error.loc, end: error.loc } };
}

/**
 * The old spellings alone, from the parse — no catalog. What the script runs
 * over a bare text: it rewrites every old spelling, but it cannot say the
 * result checks clean, since nothing was checked against connected systems.
 */
export function spellingCheck(languageVersion: LanguageVersion = CURRENT_LANGUAGE_VERSION): UpgradeCheck {
  return (source) => {
    try {
      return (parseProgram(source, { languageVersion }).spelling ?? []).map((f) => ({
        code: f.code,
        message: f.message,
        span: f.span,
        ...(f.fix !== undefined ? { fix: f.fix } : {}),
      }));
    } catch (error) {
      if (error instanceof MovementParseError) return [parseRefusal(error)];
      throw error;
    }
  };
}

/** The Rust checker against a run's snapshot — the checker a version 5
 *  program is held to (the CLI's, the API's and the corpus test's). */
export function rustCheck(input: {
  snapshot: CatalogSnapshot;
  languageVersion?: LanguageVersion;
  upgradingFrom?: LanguageVersion;
}): UpgradeCheck {
  const languageVersion = input.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  return (source) => {
    // The parse first, for its error's place, which the checker's refusal
    // words without one.
    try {
      parseProgram(source, { languageVersion });
    } catch (error) {
      if (error instanceof MovementParseError) return [parseRefusal(error)];
      throw error;
    }
    try {
      return checkSourceInRust(source, input.snapshot, {
        languageVersion,
        ...(input.upgradingFrom !== undefined ? { upgradingFrom: input.upgradingFrom } : {}),
      });
    } catch (error) {
      if (!(error instanceof RustCheckRefused)) throw error;
      return [{ code: 'MOV_PARSE', message: error.message, span: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } } }];
    }
  };
}

/** The TypeScript checker against a catalog object — for a test that holds a
 *  `mockCatalog` rather than a snapshot. */
export function typescriptCheck(input: {
  catalog: Catalog;
  languageVersion?: LanguageVersion;
  upgradingFrom?: LanguageVersion;
}): UpgradeCheck {
  const languageVersion = input.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  return (source) => {
    try {
      return checkProgram(parseProgram(source, { languageVersion }), input.catalog, {
        languageVersion,
        ...(input.upgradingFrom !== undefined ? { upgradingFrom: input.upgradingFrom } : {}),
      });
    } catch (error) {
      if (error instanceof MovementParseError) return [parseRefusal(error)];
      throw error;
    }
  };
}

// ── Showing a rewrite ───────────────────────────────────────────────────────

/** A unified diff of two texts, by line (`lf upgrade --check`, the script).
 *  Empty when they are the same. */
export function unifiedDiff(input: { before: string; after: string; path: string; context?: number }): string {
  if (input.before === input.after) return '';
  // A final newline ends the last line; it does not start another.
  const linesOf = (text: string): string[] => (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const a = linesOf(input.before);
  const b = linesOf(input.after);
  const context = input.context ?? 3;
  // Longest common subsequence by line; programs are small enough for the table.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  // `a` and `b`: how many lines of each side come before this one.
  type Line = { kind: ' ' | '-' | '+'; text: string; a: number; b: number };
  const lines: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const at = { a: i, b: j };
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: ' ', text: a[i]!, ...at });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      lines.push({ kind: '-', text: a[i]!, ...at });
      i++;
    } else {
      lines.push({ kind: '+', text: b[j]!, ...at });
      j++;
    }
  }
  const shown = input.path.replace(/^\/+/, '');
  const out = [`--- a/${shown}`, `+++ b/${shown}`];
  let k = 0;
  while (k < lines.length) {
    if (lines[k]!.kind === ' ') {
      k++;
      continue;
    }
    // A hunk: this change and every one within 2×context lines of it.
    let lastChange = k;
    for (let n = k; n < lines.length && n - lastChange <= 2 * context; n++) {
      if (lines[n]!.kind !== ' ') lastChange = n;
    }
    const hunk = lines.slice(Math.max(0, k - context), Math.min(lines.length, lastChange + context + 1));
    const aCount = hunk.filter((l) => l.kind !== '+').length;
    const bCount = hunk.filter((l) => l.kind !== '-').length;
    const first = hunk[0]!;
    out.push(`@@ -${first.a + (aCount > 0 ? 1 : 0)},${aCount} +${first.b + (bCount > 0 ? 1 : 0)},${bCount} @@`);
    for (const l of hunk) out.push(`${l.kind}${l.text}`);
    k = lastChange + context + 1;
  }
  return `${out.join('\n')}\n`;
}
