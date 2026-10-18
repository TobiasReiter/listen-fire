// Storage-backed file-import resolution.
//
// `import { … } from "<file>"` paths resolve against the team's saved
// `automations.movement` rows BY NAME — a library is just a saved movement
// file with no `listen` statements (the checker enforces the no-invoker
// rule; the TEXT is canonical either way).
//
// The checker's `ResolveFile` is synchronous, so the sources are
// prefetched here: starting from the root program, every referenced path
// is loaded and re-scanned for ITS file imports until the closure is
// complete (bounded — cycles and diamonds visit each path once).
//
// `assembleMovementFileSources` is the pure closure walk (injectable
// loader, unit-testable without a DB); `teamMovementFileResolver` is the
// DB-backed wrapper.
//
// Dependent revalidation (the once-skipped piece): saving a library never
// rewrites its dependents' stored validity — a dependent's validity is
// assessed by its OWN saves and runs. But a clean library save now
// RE-CHECKS every direct importer (`checkMovementDependents`) and reports
// the verdicts alongside the save, so breakage surfaces immediately
// instead of at the dependent's next save/run (the interpreter still
// re-checks every firing through this same resolver, so a broken import
// always fails loud, never silently).

import {
  CURRENT_LANGUAGE_VERSION,
  MovementParseError,
  fileExports,
  runHostUnits,
  parseProgram,
  referencedFileImports,
  type LanguageVersion,
  type Program,
  type ResolveFile,
} from 'movement-lang';

import { getMovementRowByName, listMovementRows, type MovementValidityStatus } from './store';

/** Defensive bound on the import closure — no sane library graph nests
 *  this deep, and the checker reports real cycles precisely. */
const MAX_DEPTH = 16;

/**
 * The transitive closure of file-import sources reachable from
 * `rootSource`. Unresolvable paths are simply absent (the checker
 * reports them as MOV_IMPORT_FILE_UNRESOLVED).
 */
export async function assembleMovementFileSources(input: {
  rootSource: string;
  load: (path: string) => Promise<string | null>;
}): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  let frontier = referencedFileImports(input.rootSource);
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    await Promise.all(
      frontier.map(async (path) => {
        if (sources.has(path)) return;
        const source = await input.load(path);
        if (source === null) return;
        sources.set(path, source);
        for (const nested of referencedFileImports(source)) {
          if (!sources.has(nested)) next.push(nested);
        }
      }),
    );
    frontier = next;
  }
  return sources;
}

/** A checker `ResolveFile` over a prefetched path → source map. */
export function resolverOverSources(sources: Map<string, string>): ResolveFile {
  return (path) => {
    const source = sources.get(path);
    return source !== undefined ? { source } : undefined;
  };
}

/**
 * The team resolver for one root source: prefetch the import closure from
 * `automations.movement` rows (path = row name), return the synchronous
 * resolver every consumer shares — checkProgram, runMovement, the
 * interpretability scan.
 */
export async function teamMovementFileResolver(input: {
  teamId: string;
  rootSource: string;
}): Promise<ResolveFile> {
  const sources = await assembleMovementFileSources({
    rootSource: input.rootSource,
    load: async (path) => {
      const row = await getMovementRowByName({ teamId: input.teamId, name: path });
      return row?.source ?? null;
    },
  });
  return resolverOverSources(sources);
}

// ── File facets — what a file IS, derived from its text ─────────────────────
//
// A file's kind is never stored: the source is canonical, so the facets
// are re-derived from it wherever they're shown.
//
//   - AUTOMATION: the file declares an invoker — `listen` statements
//     (`listen` is the ONLY invoker; on-demand runs are a manual-channel
//     listener, schedules a cron-channel one).
//   - LIBRARY: the file EXPLICITLY exports — declarations marked with
//     the `export` prefix (`export movement …` / `export shape …`).
//     Exporting is vocabulary, not inference: a spare un-fired movement
//     is private until its author says otherwise. A file can be both
//     (listeners AND exports).
//
// Mid-edit text that doesn't parse falls back to a line-level scan (the
// same lenient posture as referencedConstructions) so drafts still render
// sensibly — over- or under-counting there can only mislabel a badge,
// never an execution decision.

export interface MovementFileFacets {
  /** `listen` statements — events fire this file. */
  listenerCount: number;
  /** The file declares a manual-channel listener — "Run now" works. */
  runnableOnDemand: boolean;
  /** Something invokes this file: listeners (the only invoker). */
  isAutomation: boolean;
  /** Movements marked `export` — importable by other files. */
  exportedMovementCount: number;
  /** Node declarations marked `export` — importable by other files. */
  exportedShapeCount: number;
  /** The file explicitly exports (≥1 `export` declaration). */
  isLibrary: boolean;
}

interface FacetScan {
  listenerCount: number;
  /** Movements fired by MANUAL-channel listeners ("Run now" targets). */
  manualTargets: string[];
  firedMovements: string[];
  /** `export movement` declarations. */
  exportedMovementCount: number;
  /** `export node` declarations. */
  exportedShapeCount: number;
}

/**
 * Movements fired by manual-channel listeners — the "Run now" targets.
 * A listener is manual when it listens to a NAMED construction of the manual
 * adapter (`go = manual()` then `listen to go {}`), import aliases honored.
 */
export function manualListenerMovements(program: Program, options: { languageVersion?: number } = {}): string[] {
  const importOriginals = new Map<string, string>();
  const constructionAdapters = new Map<string, string>();
  // From version 5 `manual` is the run host's own unit: `listen to manual fire
  // backfill` needs no construction, unless the file binds the name itself.
  for (const unit of runHostUnits(options.languageVersion ?? CURRENT_LANGUAGE_VERSION)) constructionAdapters.set(unit, unit);
  for (const statement of program.statements) {
    if (statement.kind === 'import') {
      for (const { name, alias } of statement.names) {
        if (alias !== undefined) importOriginals.set(alias, name);
        constructionAdapters.delete(alias ?? name);
      }
    } else if (statement.kind === 'assign' && statement.value.kind === 'construct') {
      const callee = statement.value.construct.callee;
      constructionAdapters.set(statement.name, importOriginals.get(callee) ?? callee);
    }
  }
  const targets: string[] = [];
  for (const statement of program.statements) {
    if (statement.kind !== 'listen') continue;
    const adapter = constructionAdapters.get(statement.instance);
    if (adapter === 'manual') targets.push(statement.movement);
  }
  return targets;
}

function facetScanOfProgram(program: Program): FacetScan {
  const scan: FacetScan = {
    listenerCount: 0,
    manualTargets: manualListenerMovements(program),
    firedMovements: [],
    exportedMovementCount: 0,
    exportedShapeCount: 0,
  };
  for (const statement of program.statements) {
    if (statement.kind === 'listen') {
      scan.listenerCount++;
      scan.firedMovements.push(statement.movement);
    }
  }
  for (const exported of fileExports(program)) {
    if (exported.kind === 'movement') scan.exportedMovementCount++;
    else scan.exportedShapeCount++;
  }
  return scan;
}

const LISTEN_LINE = /^\s*listen\s+to\s+([A-Za-z_]\w*).*\bfire\s+([A-Za-z_]\w*)\s*$/;
const MANUAL_CONSTRUCT_LINE = /^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\(/;
const MANUAL_IMPORT_LINE = /^\s*import\s*\{([^}]*)\}\s*from\s+adapters\b/;
const EXPORT_MOVEMENT_LINE = /^\s*export\s+movement\s+([A-Za-z_]\w*)/;
const EXPORT_SHAPE_LINE = /^\s*export\s+node\s+([A-Za-z_]\w*)\s*\{/;

function facetScanByLexicalScan(source: string): FacetScan {
  const scan: FacetScan = {
    listenerCount: 0,
    manualTargets: [],
    firedMovements: [],
    exportedMovementCount: 0,
    exportedShapeCount: 0,
  };
  // Resolve `name = manual()` constructions (import aliases honored) so a
  // `listen to <name>` can be recognised as a manual channel mid-edit, when
  // the program doesn't yet parse. Two passes: imports + constructions first.
  const adapterAliases = new Map<string, string>();
  const manualInstances = new Set<string>();
  for (const line of source.split('\n')) {
    const importLine = MANUAL_IMPORT_LINE.exec(line);
    if (importLine) {
      for (const entry of importLine[1].split(',')) {
        const m = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(entry);
        if (m) adapterAliases.set(m[2] ?? m[1], m[1]);
      }
      continue;
    }
    const construct = MANUAL_CONSTRUCT_LINE.exec(line);
    if (construct) {
      const adapter = adapterAliases.get(construct[2]) ?? construct[2];
      if (adapter === 'manual') manualInstances.add(construct[1]);
    }
  }
  for (const line of source.split('\n')) {
    const listen = LISTEN_LINE.exec(line);
    if (listen) {
      scan.listenerCount++;
      scan.firedMovements.push(listen[2]);
      // The run host's `manual` unit, unless the file imports the name itself.
      const unit = listen[1] === 'manual' && !adapterAliases.has('manual');
      if (manualInstances.has(listen[1]) || unit) scan.manualTargets.push(listen[2]);
      continue;
    }
    if (EXPORT_MOVEMENT_LINE.test(line)) {
      scan.exportedMovementCount++;
      continue;
    }
    if (EXPORT_SHAPE_LINE.test(line)) scan.exportedShapeCount++;
  }
  return scan;
}

/** The file's facets, derived from its text. Never throws. */
export function movementFileFacets(source: string): MovementFileFacets {
  let scan: FacetScan;
  try {
    scan = facetScanOfProgram(parseProgram(source));
  } catch (e) {
    if (!(e instanceof MovementParseError)) throw e;
    scan = facetScanByLexicalScan(source);
  }
  return {
    listenerCount: scan.listenerCount,
    runnableOnDemand: scan.manualTargets.length > 0,
    isAutomation: scan.listenerCount > 0,
    exportedMovementCount: scan.exportedMovementCount,
    exportedShapeCount: scan.exportedShapeCount,
    isLibrary: scan.exportedMovementCount + scan.exportedShapeCount > 0,
  };
}

// ── Dependents — which files import this one ────────────────────────────────
//
// Import paths resolve against saved movement rows BY NAME (see the module
// header), so the dependents of file `name` are exactly the team rows
// whose source carries `import { … } from "<name>"`. Derived by scanning
// every team source (`referencedFileImports` is a cheap parse; teams hold
// tens of files, not thousands) — no stored edge to drift out of date.

export interface MovementDependent {
  id: string;
  name: string;
  validityStatus: MovementValidityStatus | null;
}

/** Pure core: which of `rows` directly import the file named `name`. */
export function movementDependentsOf(
  rows: Array<{
    id: string;
    name: string;
    validityStatus: MovementValidityStatus | null;
    source: string;
  }>,
  name: string,
): MovementDependent[] {
  return rows
    .filter((row) => row.name !== name && referencedFileImports(row.source).includes(name))
    .map((row) => ({ id: row.id, name: row.name, validityStatus: row.validityStatus }));
}

/** DB-backed: the team rows that directly import the file named `name`. */
export async function movementDependents(input: {
  teamId: string;
  name: string;
}): Promise<MovementDependent[]> {
  const rows = await listMovementRows(input.teamId);
  return movementDependentsOf(rows, input.name);
}

/** file name → its direct importers, for a whole team in one pass (the
 *  list page's "used by N"). Self-imports are ignored. */
export function movementUsageIndex(
  rows: Array<{
    id: string;
    name: string;
    validityStatus: MovementValidityStatus | null;
    source: string;
  }>,
): Map<string, MovementDependent[]> {
  const index = new Map<string, MovementDependent[]>();
  for (const row of rows) {
    for (const path of referencedFileImports(row.source)) {
      if (path === row.name) continue;
      const list = index.get(path) ?? [];
      list.push({ id: row.id, name: row.name, validityStatus: row.validityStatus });
      index.set(path, list);
    }
  }
  return index;
}

// ── Dependent revalidation (after a clean save of an imported file) ─────────

export interface DependentCheckResult {
  id: string;
  name: string;
  /** Would this dependent's own save go live against the current state? */
  ok: boolean;
  /** Error-severity diagnostics found (0 when ok). */
  problemCount: number;
}

/** The validator seam — structurally `validateMovementForTeam`
 *  (authoring.ts), injected because catalog.ts imports THIS module and
 *  authoring.ts imports catalog.ts (a direct import would be a cycle).
 *  Injection also keeps the core unit-testable without a catalog. */
export type ValidateMovementSource = (input: {
  teamId: string;
  source: string;
  languageVersion?: LanguageVersion;
}) => Promise<{ ok: boolean; diagnostics: Array<{ severity: 'error' | 'warning' | 'info' }> }>;

/** Pure core: re-check every row that imports `name`. */
export async function checkMovementDependentsOf(input: {
  teamId: string;
  /** `languageVersion` is each dependent's pin — it is re-checked under its
   *  own version, not the importing file's. */
  rows: Array<{ id: string; name: string; source: string; languageVersion?: LanguageVersion }>;
  name: string;
  validate: ValidateMovementSource;
}): Promise<DependentCheckResult[]> {
  const dependents = input.rows.filter(
    (row) => row.name !== input.name && referencedFileImports(row.source).includes(input.name),
  );
  return Promise.all(
    dependents.map(async (row) => {
      const validation = await input.validate({
        teamId: input.teamId,
        source: row.source,
        ...(row.languageVersion !== undefined ? { languageVersion: row.languageVersion } : {}),
      });
      return {
        id: row.id,
        name: row.name,
        ok: validation.ok,
        problemCount: validation.diagnostics.filter((d) => d.severity === 'error').length,
      };
    }),
  );
}

/**
 * Re-check every direct importer of file `name` against the team's
 * current state — run after a clean save of that file, because dependents
 * resolve their imports against the freshly-saved TEXT. READ-ONLY by
 * design: a dependent's stored validity is assessed by its OWN saves and
 * runs; this surfaces breakage in the save response without rewriting
 * anyone's history.
 */
export async function checkMovementDependents(input: {
  teamId: string;
  name: string;
  validate: ValidateMovementSource;
}): Promise<DependentCheckResult[]> {
  const rows = await listMovementRows(input.teamId);
  return checkMovementDependentsOf({ ...input, rows });
}
