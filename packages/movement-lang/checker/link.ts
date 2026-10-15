// File-import resolution (the linker) — movements and shapes from named
// files (3_syntax_sketch.md §H).
//
// `linkImports` is the STRUCTURAL half of file imports, shared by every
// consumer of a resolved program:
//   - the checker (check.ts) resolves imported names to the library's
//     exported declarations and CHECKS each library in its own scope;
//   - the movement engine consumes the same `ProgramLink` to declare
//     imported movements/shapes and execute imported callees against
//     their own file scope;
//   - the language service lists a file's exports for completions.
//
// Resolution is injected (`ResolveFile`): the host decides what a path
// means — apps/api resolves against saved `automations.movement` rows by
// name; tests pass a map. movement-lang itself never touches storage.
//
// A LIBRARY is a movement file with no `listen`/`run` — the invoker-less
// file (6_engine.md). Importing from a file that declares either is a
// problem (it is an automation, not a library), reported but non-fatal:
// the names still bind so downstream diagnostics don't cascade.
//
// Exported = declared at file level: `movement` and `node` declarations.
// Instances and value bindings are never exported (§H: "instances are
// never imported and never passed").
//
// Cycles are refused with a problem naming the chain; diamonds (two
// files importing the same library) share one parsed `LinkedFile`.

import {
  AwaitExpression,
  CombinatorExpression,
  ImportStatement,
  MovementDeclaration,
  Program,
  ShapeDeclaration,
  Span,
  Statement,
} from '../parser/ast';
import { writtenArms } from '../parser/ast';
import { MovementParseError, parseProgram } from '../parser/parse';
import type { LanguageVersion } from '../language_version';

export interface FileResolution {
  source: string;
}

/** Host-injected path resolution. `undefined` = no such file. */
export type ResolveFile = (path: string) => FileResolution | undefined;

export type LinkedExport =
  | { kind: 'movement'; name: string; declaration: MovementDeclaration; file: LinkedFile }
  | { kind: 'shape'; name: string; declaration: ShapeDeclaration; file: LinkedFile };

export interface LinkedFile {
  path: string;
  program: Program;
  /** This file's OWN file-imported names: local name → resolved export. */
  imports: Map<string, LinkedExport>;
}

/** Structurally a checker `Diagnostic` — link problems merge straight
 *  into the diagnostics list. */
export interface LinkProblem {
  code: string;
  message: string;
  span: Span;
}

export interface ProgramLink {
  /** The root program's file-imported names: local name → resolved export. */
  imports: Map<string, LinkedExport>;
  /** Every resolved library file, by path (diamonds shared). */
  files: Map<string, LinkedFile>;
  problems: LinkProblem[];
}

export const LinkDiagnosticCodes = {
  IMPORT_FILE_UNRESOLVED: 'MOV_IMPORT_FILE_UNRESOLVED',
  IMPORT_FILE_INVALID: 'MOV_IMPORT_FILE_INVALID',
  IMPORT_CYCLE: 'MOV_IMPORT_CYCLE',
  IMPORT_NOT_EXPORTED: 'MOV_IMPORT_NOT_EXPORTED',
} as const;

export type FileExport =
  | { name: string; kind: 'movement'; declaration: MovementDeclaration }
  | { name: string; kind: 'shape'; declaration: ShapeDeclaration };

/** A file's exported declarations — the movements and shapes marked
 *  with the `export` prefix. Exporting is explicit vocabulary: a
 *  declaration without it is private to its file, and a file with at
 *  least one export is a LIBRARY. */
export function fileExports(program: Program): FileExport[] {
  const exportList: FileExport[] = [];
  for (const statement of program.statements) {
    if (statement.kind === 'movement' && statement.exported === true) {
      exportList.push({ name: statement.name, kind: 'movement', declaration: statement });
    } else if (statement.kind === 'shape' && statement.exported === true) {
      exportList.push({ name: statement.name, kind: 'shape', declaration: statement });
    }
  }
  return exportList;
}

/** Declarations an `export` prefix WOULD expose — for the "did you
 *  forget to export it?" arm of the unresolved-import diagnostic. */
export function unexportedDeclarationNames(program: Program): string[] {
  return program.statements
    .filter(
      (s): s is MovementDeclaration | ShapeDeclaration =>
        (s.kind === 'movement' || s.kind === 'shape') && s.exported !== true,
    )
    .map((s) => s.name);
}

/** Every `import … from "<file>"` statement, including ones nested in
 *  bodies (the parser allows them anywhere a statement goes). */
function fileImportStatements(
  statements: Statement[],
  out: Array<ImportStatement & { source: { kind: 'file'; path: string } }> = [],
): Array<ImportStatement & { source: { kind: 'file'; path: string } }> {
  for (const statement of statements) {
    switch (statement.kind) {
      case 'import':
        if (statement.source.kind === 'file') {
          out.push(statement as ImportStatement & { source: { kind: 'file'; path: string } });
        }
        break;
      case 'movement':
        fileImportStatements(statement.body, out);
        break;
      case 'combinator':
        fileImportStatements(armBodies(statement.combinator), out);
        break;
      case 'await':
        fileImportStatements(armBodies(combinatorOf(statement.await)), out);
        break;
      case 'block':
        fileImportStatements(statement.block.body, out);
        break;
      case 'if':
        for (const arm of statement.arms) fileImportStatements(arm.body, out);
        if (statement.elseArm) fileImportStatements(statement.elseArm.body, out);
        break;
      case 'assign':
        if (statement.value.kind === 'block') fileImportStatements(statement.value.block.body, out);
        else if (statement.value.kind === 'closure') {
          fileImportStatements(statement.value.closure.body, out);
        } else if (statement.value.kind === 'combinator') {
          fileImportStatements(armBodies(statement.value.combinator), out);
        } else if (statement.value.kind === 'await') {
          fileImportStatements(armBodies(combinatorOf(statement.value.await)), out);
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/** The combinator an `await` waits on, if that is what it waits on. */
function combinatorOf(expr: AwaitExpression): CombinatorExpression | undefined {
  return expr.source.kind === 'combinator' ? expr.source.combinator : undefined;
}

/** The statements inside a combinator's literal closure arms — an arm is an
 *  ordinary body, so an import inside one is an import the file makes. */
function armBodies(expr: CombinatorExpression | undefined): Statement[] {
  if (expr === undefined) return [];
  return writtenArms(expr.arms).flatMap(arm => (arm.kind === 'closure' ? arm.closure.body : []));
}

/**
 * Resolve a program's file imports (transitively). Never throws on bad
 * input: every failure mode — unresolved path, unparseable library,
 * cycle, non-library file, unknown export — is a `problem` attributed to
 * an import statement of the ROOT program (nested failures carry a
 * `"<path>" line <n>:` message prefix), and the affected names are simply
 * absent from the imports maps.
 */
export function linkImports(
  program: Program,
  resolveFile: ResolveFile,
  options?: {
    /** The importing movement's pin — a library is read under the version of
     *  the program that imports it. Absent ⇒ the current version. */
    languageVersion?: LanguageVersion;
  },
): ProgramLink {
  const files = new Map<string, LinkedFile | null>();
  const problems: LinkProblem[] = [];
  const loading: string[] = [];

  /** Problem reporter for one site: nested sites prefix their library path
   *  and line but report at the root import statement's span. */
  const reporterFor =
    (rootSpan: Span, withinPath: string | undefined) =>
    (code: string, message: string, statementSpan: Span): void => {
      const prefix =
        withinPath !== undefined ? `"${withinPath}" line ${statementSpan.start.line}: ` : '';
      problems.push({
        code,
        message: `${prefix}${message}`,
        span: withinPath !== undefined ? rootSpan : statementSpan,
      });
    };

  function load(
    path: string,
    report: (code: string, message: string, statementSpan: Span) => void,
    statementSpan: Span,
    rootSpan: Span,
  ): LinkedFile | null {
    if (loading.includes(path)) {
      const chain = [...loading.slice(loading.indexOf(path)), path].join(' → ');
      report(
        LinkDiagnosticCodes.IMPORT_CYCLE,
        `Import cycle: ${chain} — movement libraries cannot import each other in a loop`,
        statementSpan,
      );
      return null;
    }
    const known = files.get(path);
    if (known !== undefined) return known;

    const resolution = resolveFile(path);
    if (!resolution) {
      report(
        LinkDiagnosticCodes.IMPORT_FILE_UNRESOLVED,
        `No movement file named "${path}" — file imports resolve against your saved movement files by name`,
        statementSpan,
      );
      files.set(path, null);
      return null;
    }

    let libraryProgram: Program;
    try {
      libraryProgram = parseProgram(
        resolution.source,
        options?.languageVersion !== undefined ? { languageVersion: options.languageVersion } : undefined,
      );
    } catch (e) {
      if (!(e instanceof MovementParseError)) throw e;
      report(
        LinkDiagnosticCodes.IMPORT_FILE_INVALID,
        `"${path}" does not parse — ${e.message} — fix the library file before importing from it`,
        statementSpan,
      );
      files.set(path, null);
      return null;
    }

    // A file with its own listeners is importable — `export` is the
    // gate now, so an automation can offer helpers without splitting
    // into two files. (The pre-export rule barred any listening file:
    // back then EVERY file-level movement was importable, entry points
    // included.)

    const file: LinkedFile = { path, program: libraryProgram, imports: new Map() };
    files.set(path, file);
    loading.push(path);
    try {
      linkFileLevel(libraryProgram, file.imports, reporterFor(rootSpan, path), rootSpan);
    } finally {
      loading.pop();
    }
    return file;
  }

  function linkFileLevel(
    target: Program,
    into: Map<string, LinkedExport>,
    report: (code: string, message: string, statementSpan: Span) => void,
    rootSpanOf?: Span,
  ): void {
    for (const statement of fileImportStatements(target.statements)) {
      const path = statement.source.path;
      // Nested problems are attributed to the ROOT import statement that
      // pulled this library in; root problems sit on their own statement.
      const rootSpan = rootSpanOf ?? statement.span;
      const file = load(path, report, statement.span, rootSpan);
      if (!file) continue;
      // NB: not named `exports` — that would shadow the CommonJS module
      // object and break compiled references to this module's exports.
      const exportList = fileExports(file.program);
      for (const { name, alias } of statement.names) {
        const exported = exportList.find((e) => e.name === name);
        if (!exported) {
          const available = exportList.map((e) => e.name);
          const unexported = unexportedDeclarationNames(file.program);
          const hint = unexported.includes(name)
            ? ` — "${path}" declares '${name}' but doesn't export it; add \`export\` before its declaration`
            : ` — a file's exports are the declarations marked \`export\`${available.length ? `: ${available.join(', ')}` : ' (it exports none)'}`;
          report(
            LinkDiagnosticCodes.IMPORT_NOT_EXPORTED,
            `"${path}" does not export '${name}'${hint}`,
            statement.span,
          );
          continue;
        }
        const local = alias ?? name;
        into.set(
          local,
          exported.kind === 'movement'
            ? { kind: 'movement', name, declaration: exported.declaration, file }
            : { kind: 'shape', name, declaration: exported.declaration, file },
        );
      }
    }
  }

  const imports = new Map<string, LinkedExport>();
  linkFileLevel(program, imports, reporterFor(SPAN_FALLBACK, undefined));

  const linkedFiles = new Map<string, LinkedFile>();
  for (const [path, file] of files) {
    if (file) linkedFiles.set(path, file);
  }
  return { imports, files: linkedFiles, problems };
}

const SPAN_FALLBACK: Span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };
