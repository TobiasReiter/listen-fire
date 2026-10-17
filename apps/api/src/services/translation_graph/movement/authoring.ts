// The authoring loop's validation surface: propose → typecheck → repair.
//
// `diagnoseMovementSource` is the pure core — it mirrors EXACTLY the gate
// `saveMovement` applies (parse → check → the engine's dry
// interpretability scan), so a clean validation predicts a live save.
// Diagnostics are returned as plain data with 1-based line/col spans,
// codes, severities, and the offending source line, ready to hand to an
// authoring agent (or any other consumer) for the repair half of the loop.
//
// `validateMovementForTeam` is the I/O wrapper: it assembles the same
// per-team catalog the save path uses (referenced-construction scoped)
// and runs the core against it.

import {
  BridgeError,
  CURRENT_LANGUAGE_VERSION,
  MovementParseError,
  checkProgram,
  checkSourceInRust,
  diagnosticSeverity,
  languageVersionDiagnostic,
  parseProgram,
  since,
} from 'movement-lang';

import type {
  Catalog,
  CatalogSnapshot,
  Diagnostic,
  LanguageVersion,
  Program,
  ResolveFile,
  Span,
} from 'movement-lang';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { CatalogGap } from './catalog';
import type { MovementValidityStatus } from './store';

import { listUnsupportedConstructs } from 'movement-engine/services/movement_engine/interpretable';
import { RUST_ENGINE_FROM_VERSION } from 'movement-engine/services/movement_engine/rust_engine';
import { movementCatalogForTeam } from './catalog';
import { stepTimer, type StepTimer } from './timing';


export interface AuthoringDiagnostic {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  /** 1-based line/col into the source. */
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  /** The offending source line, verbatim — repair context without re-reading. */
  sourceLine: string;
  /** Marks a construct whose meaning changed between the pin and the version
   *  checked, on an upgrade check (the checker's `Diagnostic.upgrade`). */
  upgrade?: true;
  /** The exact rewrite that resolves it (also spelled out in `message`):
   *  replace each 1-based range with `text`; an empty range inserts. `safe`:
   *  it provably keeps the meaning, so an upgrade may apply it unasked. */
  fix?: { edits: AuthoringEdit[]; safe?: true };
}

export interface AuthoringEdit {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  text: string;
}

export interface MovementValidation {
  /** True when nothing error-severity was found — a save would go live. */
  ok: boolean;
  diagnostics: AuthoringDiagnostic[];
  /** `listen` statements found (0 = library file: nothing fires it). */
  listenerCount: number;
  /** Movements each listener fires, in file order. */
  firedMovements: string[];
}

function toAuthoringDiagnostic(
  diagnostic: Diagnostic,
  lines: string[],
): AuthoringDiagnostic {
  const span: Span = diagnostic.span;
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnosticSeverity(diagnostic),
    line: span.start.line,
    col: span.start.col,
    endLine: span.end.line,
    endCol: span.end.col,
    sourceLine: lines[span.start.line - 1] ?? '',
    ...(diagnostic.upgrade === true ? { upgrade: true } : {}),
    ...(diagnostic.fix !== undefined
      ? {
          fix: {
            edits: diagnostic.fix.edits.map((edit) => ({
              line: edit.span.start.line,
              col: edit.span.start.col,
              endLine: edit.span.end.line,
              endCol: edit.span.end.col,
              text: edit.text,
            })),
            ...(diagnostic.fix.safe === true ? { safe: true as const } : {}),
          },
        }
      : {}),
  };
}

/** Raw checker/compile diagnostics → the authoring shape, against the
 *  source they were produced from (the save path returns raw ones). */
export function formatMovementDiagnostics(
  source: string,
  diagnostics: Diagnostic[],
): AuthoringDiagnostic[] {
  const lines = source.split('\n');
  return diagnostics.map((d) => toAuthoringDiagnostic(d, lines));
}

function dedupe(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.code}@${d.span.start.line}:${d.span.start.col}:${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Parse + check + the engine's dry interpretability scan, against an
 * injected catalog — the exact gate `saveMovement` applies, minus the
 * persistence. Pure given the catalog; unit-testable without I/O.
 */
export function diagnoseMovementSource(
  source: string,
  options: {
    catalog: Catalog;
    resolveCredentialId?: (credentialName: string) => string | undefined;
    /** File-import resolution (movement libraries) — same resolver the
     *  save path threads through checkProgram and compileMovement. */
    resolveFile?: ResolveFile;
    /** The language version to validate under — a saved movement's pin.
     *  Absent ⇒ the current version. */
    languageVersion?: LanguageVersion;
    /** The movement's pin, when this validation asks whether it can move up
     *  to `languageVersion` — adds the checker's warnings for constructs whose
     *  meaning changed between the two (`CheckOptions.upgradingFrom`). */
    upgradingFrom?: LanguageVersion;
    /** The snapshot a run of the source checks and runs against, from the
     *  same assembly as `catalog`. With it, a version that runs on the Rust
     *  engine is checked by the Rust checker against it — the check its run
     *  enforces. Without it (a caller holding only a catalog object, as unit
     *  tests do) the TypeScript checker answers; `validateMovementForTeam`
     *  always passes it. */
    snapshot?: CatalogSnapshot;
  },
): MovementValidation {
  const lines = source.split('\n');
  const languageVersion = options.languageVersion ?? CURRENT_LANGUAGE_VERSION;

  // A pin this release cannot honour is the whole verdict: reading the text
  // under some other version's grammar would report problems that aren't.
  const versionDiagnostic = languageVersionDiagnostic(languageVersion);
  if (versionDiagnostic !== undefined && diagnosticSeverity(versionDiagnostic) === 'error') {
    return {
      ok: false,
      diagnostics: [toAuthoringDiagnostic(versionDiagnostic, lines)],
      listenerCount: 0,
      firedMovements: [],
    };
  }

  let program: Program;
  try {
    program = parseProgram(source, { languageVersion });
  } catch (e) {
    if (!(e instanceof MovementParseError)) throw e;
    const parseDiagnostic: Diagnostic = {
      code: 'MOV_PARSE',
      message: e.message,
      span: { start: e.loc, end: e.loc },
    };
    return {
      ok: false,
      diagnostics: [toAuthoringDiagnostic(parseDiagnostic, lines)],
      listenerCount: 0,
      firedMovements: [],
    };
  }

  const checkedInRust = options.snapshot !== undefined && since(languageVersion, RUST_ENGINE_FROM_VERSION);
  const upgrading = options.upgradingFrom !== undefined ? { upgradingFrom: options.upgradingFrom } : {};
  const collected: Diagnostic[] = [
    ...(checkedInRust
      ? checkSourceInRust(source, options.snapshot, { languageVersion, ...upgrading })
      : checkProgram(program, options.catalog, {
          languageVersion,
          ...upgrading,
          ...(options.resolveFile !== undefined ? { resolveFile: options.resolveFile } : {}),
        })),
  ];
  const firedMovements: string[] = [];
  for (const statement of program.statements) {
    if (statement.kind === 'listen') firedMovements.push(statement.movement);
  }

  // The engine gate, mirrored from the save path: the dry
  // interpretability scan names any constructs the movement engine does
  // not support yet — error severity, since the save would refuse with
  // status 'error'. Spans aren't statically available from the scan;
  // the construct names carry the repair signal.
  for (const construct of listUnsupportedConstructs(source, {
    languageVersion,
    ...(options.resolveFile !== undefined ? { resolveFile: options.resolveFile } : {}),
  })) {
    // From v5 the Rust checker refuses a file-level call as MOV_FILE_VALUE_RUNS,
    // which says why and what to do; the scan's note would only repeat it.
    if (checkedInRust && construct === 'file-level calls') continue;
    collected.push({
      code: 'MOV_ENGINE_UNSUPPORTED',
      message: `the engine does not support ${construct} yet — remove it to save this file live`,
      span: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
    });
  }

  const diagnostics = dedupe(collected).map((d) => toAuthoringDiagnostic(d, lines));
  return {
    ok: diagnostics.every((d) => d.severity !== 'error'),
    diagnostics,
    listenerCount: firedMovements.length,
    firedMovements,
  };
}

export interface TeamMovementValidation extends MovementValidation {
  /** Honest gaps from catalog assembly (untyped adapters, …) — context
   *  for why some checks may have stayed silent. */
  catalogNotes: string[];
  /** Structured introspection gaps — a referenced adapter that couldn't be
   *  typed because introspecting it failed. The `unverified` signal, distinct
   *  from a check error. */
  gaps: CatalogGap[];
}

export interface MovementValidityAssessment {
  status: MovementValidityStatus;
  /** Structured `validity_reason`: `{ diagnostics }` for invalid,
   *  `{ gaps }` for unverified, `null` for valid. */
  reason: unknown;
}

/**
 * Collapse a validation into the runtime validity status. Precedence:
 *   error diagnostics → `invalid` (we know it's broken)
 *   else introspection gaps → `unverified` (we couldn't check a referenced adapter)
 *   else → `valid`.
 * Parse errors surface as an error-severity `MOV_PARSE` diagnostic, so an
 * incompilable movement lands `invalid` here. See
 * plans/2026-07-13-movement-validity-lifecycle.
 */
export function assessMovementValidity(input: {
  diagnostics: AuthoringDiagnostic[];
  gaps: CatalogGap[];
}): MovementValidityAssessment {
  const errors = input.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) return { status: 'invalid', reason: { diagnostics: errors } };
  if (input.gaps.length > 0) return { status: 'unverified', reason: { gaps: input.gaps } };
  return { status: 'valid', reason: null };
}

/**
 * Validate a movement source against the team's REAL catalog — the same
 * referenced-construction-scoped assembly `saveMovement` uses, so the
 * verdict predicts the save.
 */
export async function validateMovementForTeam(input: {
  teamId: string;
  source: string;
  /** The language version to validate under — a saved movement's pin, or an
   *  explicit request. Absent ⇒ the current version. */
  languageVersion?: LanguageVersion;
  /** The movement's pin, when validating it for a move up to
   *  `languageVersion` — see `diagnoseMovementSource`. */
  upgradingFrom?: LanguageVersion;
}): Promise<TeamMovementValidation> {
  // Catalog assembly scopes itself to the source by scanning its constructions
  // and expression slots. A malformed expression can make one of those scans
  // throw — which must NEVER 500 the validator. Fall back to the whole-workspace
  // catalog (which doesn't scan the source), so `diagnoseMovementSource` still
  // runs and the checker reports the parse error as a diagnostic. Non-source
  // (infra) failures propagate unchanged.
  const timer = stepTimer('authoring: validate', { teamId: input.teamId });
  try {
    return await runValidate(input, timer);
  } finally {
    timer.done();
  }
}

async function runValidate(
  input: {
    teamId: string;
    source: string;
    languageVersion?: LanguageVersion;
    upgradingFrom?: LanguageVersion;
  },
  timer: StepTimer,
): Promise<TeamMovementValidation> {
  let teamCatalog;
  /** Why the scoped scan failed, when it did — the fallback catalog describes
   *  nothing, so this is the only account of what went unchecked. */
  let scanFailure: string | undefined;
  try {
    teamCatalog = await timer.step('catalog', () =>
      movementCatalogForTeam(input.teamId as TeamId, {
        source: input.source,
        ...(input.languageVersion !== undefined ? { languageVersion: input.languageVersion } : {}),
      }),
    );
  } catch (e) {
    if (!(e instanceof BridgeError || e instanceof MovementParseError)) throw e;
    scanFailure = e.message;
    // `types: []` — describe NOTHING. Source that will not parse never reaches
    // type-checking, so no schema can inform the diagnostic; fetching every
    // type of every connected system to report a missing bracket is a
    // whole-graph load bought for nothing.
    teamCatalog = await timer.step('catalog', () =>
      movementCatalogForTeam(input.teamId as TeamId, { types: [] }),
    );
  }
  timer.note(teamCatalog.cost ?? {});
  const validation = await timer.step('diagnose', async () =>
    diagnoseMovementSource(input.source, {
      catalog: teamCatalog.catalog,
      resolveCredentialId: teamCatalog.resolveCredentialId,
      resolveFile: teamCatalog.resolveFile,
      ...(teamCatalog.runSnapshot !== undefined ? { snapshot: teamCatalog.runSnapshot() } : {}),
      ...(input.languageVersion !== undefined ? { languageVersion: input.languageVersion } : {}),
      ...(input.upgradingFrom !== undefined ? { upgradingFrom: input.upgradingFrom } : {}),
    }),
  );
  const notes = [...teamCatalog.notes];
  const gaps = [...teamCatalog.gaps];
  if (scanFailure !== undefined) {
    // The fallback catalog describes NOTHING, so every schema-typed check ran
    // against an empty world and stayed silent. Usually the source also failed
    // to parse and the parse error carries the verdict — but not always, and a
    // source that parses would otherwise come back a clean `ok` that means only
    // "nothing was checked". A gap makes that `unverified`, which is what it is.
    const detail =
      `the source could not be scanned for the systems it uses, so nothing was ` +
      `checked against live schemas — ${scanFailure}`;
    gaps.push({ adapter: 'every system', detail });
    notes.push(detail);
  }
  return { ...validation, catalogNotes: notes, gaps };
}
