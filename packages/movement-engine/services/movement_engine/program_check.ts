// The check every run passes before it executes: the language-version pin,
// the parse, and the checker with its file resolver, throwing MOVENG_LANGUAGE_
// VERSION, MOVENG_PARSE or MOVENG_CHECK. The TypeScript interpreter calls it
// in-process. A run on the Rust engine is checked by the Rust checker
// (`checkPinnedInRust` before its segment opens, then the engine's own check);
// the `check.program` host call (rust_engine.ts), answered with `checkAnswer`,
// remains for a segment started without the native check.
//
// The checker MUTATES the program it checks: it records on a write's spread
// the fields it stands for (`WriteSpread.fields`), on a graph's spread what
// it copies (`MapSpread.copy`), and on a graph entry whose value is a record
// that the entry is an edge holding it (`NodeEntry.reference`). The engine
// reads all three; program_check.unit pins that there are no others. A Rust engine
// re-parses the source, so those facts cross as STAMPS, each keyed by its
// node's place in the program's JSON — the AST path scheme:
//
//   path = a JSON Pointer (RFC 6901) from the Program object to the stamped
//          node, through the keys and array indices of the Program exactly
//          as the parser emits it: `/statements/2/body/0/write/spreads/1`.
//   file = absent for the program run; a library file's path for a stamp in
//          a file it imports (the same pointer, from that file's Program).
//
// The pointer is stable because the pinned source re-parses to the same
// tree (the Rust parser emits the TypeScript AST field for field), and the
// stamped keys are ones the parser never writes.
//
// A call nested in an expression (`FIRST(MAP(xs, (x) => …))`, language
// version 3) is read once per place by `parseNestedCall`, and the checker
// stamps that read. Its place continues the pointer through the slot it is
// written in: `<slot>/nested/<start>-<end>/value` is the right-hand side the
// call reads as, `start` and `end` its extent in the slot's text (UTF-16
// offsets, as the expression grammar gives them), so a stamp inside it is
// `…/value/expr/nested/0-31/value/call/args/1/closure/body/0/value/node/spreads/0`.
// The Rust engine re-reads the call from the slot to resolve one.

import {
  DiagnosticCodes,
  MovementParseError,
  checkProgramWithLink,
  fromCatalogSnapshot,
  resolveFileFromSnapshot,
  CURRENT_LANGUAGE_VERSION,
  languageVersionDiagnostic,
  nestedCallsReadIn,
  diagnosticSeverity,
  parseProgram,
  checkSourceInRust,
} from 'movement-lang';

import type {
  Catalog,
  CatalogSnapshot,
  Diagnostic,
  ExprSlot,
  LanguageVersion,
  LinkedExport,
  Program,
  ProgramLink,
  ResolveFile,
} from 'movement-lang';

import { MovementEngineError } from './errors';

/**
 * Diagnostics an author may no longer WRITE, but a saved program may still
 * RUN. A retirement refuses the construct where a program is authored; it must
 * not stop automations that were saved while the construct was legal, so the
 * run gate lets exactly these through and the engine still executes them.
 *
 * Empties out at the wave that deletes each construct's engine path — see the
 * deploy block in
 * plans/2026-06-10-data-movement-language/9_node_synthesis_build.md.
 */
const RETIRED_BUT_STILL_RUNNABLE = new Set<string>([DiagnosticCodes.WRITE_SHAPE_RETIRED]);

export interface CheckInput {
  source: string;
  catalog: CatalogSnapshot;
  languageVersion?: LanguageVersion;
  /** Checking for a move up from this version (`CheckOptions.upgradingFrom`). */
  upgradingFrom?: LanguageVersion;
}

export interface CheckedProgram {
  program: Program;
  catalog: Catalog;
  link?: ProgramLink;
  /** Every diagnostic, warnings and the runnable retirements included. */
  diagnostics: Diagnostic[];
  resolveFile?: ResolveFile;
}

/** The resolver file imports read: the snapshot's own files, captured with
 *  the catalog the program is checked against, so imports and instance
 *  schemas describe one moment of the workspace. A snapshot with no files
 *  resolves no import. */
export function fileResolverOf(input: Pick<CheckInput, 'catalog'>): ResolveFile | undefined {
  return resolveFileFromSnapshot(input.catalog);
}

/** The pin, the parse: MOVENG_LANGUAGE_VERSION or MOVENG_PARSE. */
export function parsePinned(input: Pick<CheckInput, 'source' | 'languageVersion'>): Program {
  const languageVersion = input.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  // The pin is answered before the source is read: a version this release
  // cannot honour must fail as exactly that, not as whatever the current
  // grammar makes of the text.
  const versionDiagnostic = languageVersionDiagnostic(languageVersion);
  if (versionDiagnostic !== undefined && diagnosticSeverity(versionDiagnostic) === 'error') {
    throw new MovementEngineError('MOVENG_LANGUAGE_VERSION', versionDiagnostic.message, [
      versionDiagnostic,
    ]);
  }
  try {
    return parseProgram(input.source, { languageVersion });
  } catch (e) {
    if (e instanceof MovementParseError) {
      throw new MovementEngineError('MOVENG_PARSE', e.message);
    }
    throw e;
  }
}

/** Parse + check, throwing MOVENG_LANGUAGE_VERSION, MOVENG_PARSE or
 *  MOVENG_CHECK. Error severity only blocks: info diagnostics
 *  (MOV_LISTEN_MISSING — a dispatchable movement with no listen) never do.
 *  With the file resolver, the check RESOLVES file imports and the returned
 *  link is the engine's import structure. */
export function checkPinned(input: CheckInput, parsed?: Program): CheckedProgram {
  const languageVersion = input.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  const program = parsed ?? parsePinned(input);
  const catalog = fromCatalogSnapshot(input.catalog);
  const resolveFile = fileResolverOf(input);
  const { diagnostics, link } = checkProgramWithLink(program, catalog, {
    languageVersion,
    ...(input.upgradingFrom !== undefined ? { upgradingFrom: input.upgradingFrom } : {}),
    ...(resolveFile !== undefined ? { resolveFile } : {}),
  });
  throwIfBlocking(diagnostics);
  return {
    program,
    catalog,
    diagnostics,
    ...(link !== undefined ? { link } : {}),
    ...(resolveFile !== undefined ? { resolveFile } : {}),
  };
}

/** `checkPinned` by the Rust checker (crates/movement-checker), the one a
 *  run on the Rust engine is held to: the same pin, parse and blocking rule,
 *  throwing the same errors, before anything of the run reaches its host.
 *  The engine checks again as its segment starts (`nativeCheck`), and it is
 *  that check whose stamps and link the run reads; this one answers only
 *  whether the run may open a segment at all. */
export function checkPinnedInRust(input: CheckInput): Diagnostic[] {
  const languageVersion = input.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  parsePinned(input);
  const diagnostics = checkSourceInRust(input.source, input.catalog, {
    languageVersion,
    ...(input.upgradingFrom !== undefined ? { upgradingFrom: input.upgradingFrom } : {}),
  });
  throwIfBlocking(diagnostics);
  return diagnostics;
}

function throwIfBlocking(diagnostics: Diagnostic[]): void {
  const blocking = diagnostics.filter(
    (d) => (d.severity ?? 'error') === 'error' && !RETIRED_BUT_STILL_RUNNABLE.has(d.code),
  );
  if (blocking.length > 0) {
    throw new MovementEngineError(
      'MOVENG_CHECK',
      `the movement program failed checking:\n${blocking
        .map((d) => `  ${d.code} (line ${d.span.start.line}): ${d.message}`)
        .join('\n')}`,
      blocking,
    );
  }
}

// ── The check as data ─────────────────────────────────────────────────────────

/** A checker fact about one node, keyed by its AST path (the header): a
 *  write spread's field list, a graph spread's copy plan (a `CopyPlan`, as
 *  plain data), or that a graph entry is a reference. */
export type Stamp = { file?: string; path: string } & (
  | { spreadFields: readonly string[] }
  | { copy: unknown }
  | { reference: true }
);

/** One imported name, its declaration an AST path into its file. */
export interface LinkedImportData {
  local: string;
  kind: LinkedExport['kind'];
  name: string;
  file: string;
  declaration: string;
}

export interface LinkData {
  imports: LinkedImportData[];
  files: Array<{
    path: string;
    source: string;
    imports: LinkedImportData[];
    exports: Array<{ name: string; kind: LinkedExport['kind']; declaration: string }>;
  }>;
}

export interface CheckAnswer {
  diagnostics: Diagnostic[];
  link?: LinkData;
  stamps: Stamp[];
}

/** What `checkPinned` found, as plain data a re-parse can be joined with. */
export function checkAnswer(checked: CheckedProgram): CheckAnswer {
  const stamps = stampsIn(checked.program);
  const link = checked.link;
  if (link === undefined) return { diagnostics: checked.diagnostics, stamps };
  const files: LinkData['files'] = [];
  for (const file of link.files.values()) {
    stamps.push(...stampsIn(file.program, file.path));
    const resolution = checked.resolveFile?.(file.path);
    if (resolution === undefined) {
      throw new MovementEngineError('MOVENG_RUNTIME', `the library "${file.path}" resolved for the check and not after it`);
    }
    files.push({
      path: file.path,
      source: resolution.source,
      imports: importsData(file.imports),
      exports: file.program.statements.flatMap((statement, index) =>
        (statement.kind === 'movement' || statement.kind === 'shape') && statement.exported === true
          ? [{ name: statement.name, kind: statement.kind, declaration: `/statements/${index}` }]
          : [],
      ),
    });
  }
  return { diagnostics: checked.diagnostics, link: { imports: importsData(link.imports), files }, stamps };
}

function importsData(imports: ReadonlyMap<string, LinkedExport>): LinkedImportData[] {
  return [...imports].map(([local, exported]) => {
    const index = exported.file.program.statements.indexOf(exported.declaration);
    if (index < 0) {
      throw new MovementEngineError('MOVENG_RUNTIME', `'${local}' names a declaration that is not a statement of "${exported.file.path}"`);
    }
    return { local, kind: exported.kind, name: exported.name, file: exported.file.path, declaration: `/statements/${index}` };
  });
}

/** The checker's stamps on `program`: a `fields` on a write's spread, a
 *  `copy` on a graph's, a `reference` on a graph entry — in the program and
 *  in each call nested in its expressions, as read for the check. No key the
 *  parser writes. */
function stampsIn(program: Program, file?: string): Stamp[] {
  const stamps: Stamp[] = [];
  const at = (path: string) => (file !== undefined ? { file, path } : { path });
  const visit = (node: unknown, path: string, inSpreads: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}/${i}`, inSpreads));
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const fields: unknown = Reflect.get(node, 'fields');
    if (inSpreads && Array.isArray(fields) && fields.every((f) => typeof f === 'string')) {
      stamps.push({ ...at(path), spreadFields: fields });
    }
    const copy: unknown = Reflect.get(node, 'copy');
    if (copy !== undefined) stamps.push({ ...at(path), copy });
    const reference = Reflect.get(node, 'kind') === 'value' && Reflect.get(node, 'reference') === true;
    if (reference) stamps.push({ ...at(path), reference: true });
    for (const [key, child] of Object.entries(node)) {
      if (key === 'copy' || (inSpreads && key === 'fields') || (reference && key === 'reference')) continue;
      visit(child, `${path}/${pointerToken(key)}`, key === 'spreads');
    }
    if (isSlot(node)) {
      for (const read of nestedCallsReadIn(node)) visit(read.value, `${path}/nested/${read.at.start}-${read.at.end}/value`, false);
    }
  };
  visit(program, '', false);
  return stamps;
}

/** An expression's slot as the parser writes one. */
function isSlot(node: object): node is ExprSlot {
  return typeof Reflect.get(node, 'raw') === 'string' && typeof Reflect.get(node, 'span') === 'object';
}

/** RFC 6901's escaping of one reference token. */
function pointerToken(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}
