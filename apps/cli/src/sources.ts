// The project's movement files: scanned, checked, and read for their listens.
// Routing is read from source — every `listen … fire …` across the files is
// the routing table, exactly as the hosted product derives one trigger per
// listen when a file is saved.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  MovementParseError,
  checkProgram,
  diagnosticSeverity,
  fromCatalogSnapshot,
  mockCatalogSnapshot,
  parseProgram,
  resolveFileFromSnapshot,
  type CatalogSnapshot,
  type InstanceSchema,
  type LanguageVersion,
} from 'movement-lang';
import { collectFileListeners, type FileListener } from 'movement-engine/services/translation_graph/movement/file_listeners';
import type { Project } from './project';
import type { Credential } from './secrets';

export const MOVEMENT_EXTENSION = '.mvt';

export interface MovementFile {
  /** The path an import names: relative to the movements folder, no extension. */
  name: string;
  /** Where it is on disk. */
  path: string;
  source: string;
}

export function scanMovements(project: Project): MovementFile[] {
  const files: MovementFile[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(MOVEMENT_EXTENSION)) {
        files.push({
          name: relative(project.movementsDir, path).slice(0, -MOVEMENT_EXTENSION.length),
          path,
          source: readFileSync(path, 'utf8'),
        });
      }
    }
  };
  walk(project.movementsDir);
  return files;
}

/**
 * The catalog a program is checked and run against: each adapter external's
 * schema, the credentials the secrets name, and the project's files (so a
 * file import resolves by path, as it does today).
 */
export function catalogOf(input: {
  schemas: Map<string, InstanceSchema>;
  credentials: Map<string, Credential>;
  credentialed: Set<string>;
  files: MovementFile[];
}): CatalogSnapshot {
  const adapters: NonNullable<Parameters<typeof mockCatalogSnapshot>[0]['adapters']> = {};
  for (const [name, schema] of input.schemas) {
    adapters[name] = {
      constructionArgs: input.credentialed.has(name) ? [{ name: 'credentials', kind: 'credential', required: true }] : [],
      schema,
    };
  }
  const credentials: Record<string, { adapters: string[] }> = {};
  for (const credential of input.credentials.values()) credentials[credential.name] = { adapters: [credential.external] };
  return {
    ...mockCatalogSnapshot({ adapters, credentials }),
    files: Object.fromEntries(input.files.map((f) => [f.name, { source: f.source }])),
  };
}

export interface FileDiagnostic {
  file: MovementFile;
  line: number;
  column: number;
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

/**
 * The checker seam: every diagnostic one file has. Answered by the TypeScript
 * checker today; the Rust checker (`check.program`) answers here when it lands.
 */
export function checkFile(input: {
  file: MovementFile;
  catalog: CatalogSnapshot;
  languageVersion: LanguageVersion;
}): FileDiagnostic[] {
  let program;
  try {
    program = parseProgram(input.file.source, { languageVersion: input.languageVersion });
  } catch (error) {
    if (!(error instanceof MovementParseError)) throw error;
    const at = /line (\d+)(?:, column (\d+))?/.exec(error.message);
    return [{ file: input.file, line: Number(at?.[1] ?? 1), column: Number(at?.[2] ?? 1), code: 'MOV_PARSE', message: error.message, severity: 'error' }];
  }
  const resolveFile = resolveFileFromSnapshot(input.catalog);
  return checkProgram(program, fromCatalogSnapshot(input.catalog), {
    languageVersion: input.languageVersion,
    ...(resolveFile !== undefined ? { resolveFile } : {}),
  }).map((d) => ({
    file: input.file,
    line: d.span.start.line,
    column: d.span.start.col,
    code: d.code,
    message: d.message,
    severity: diagnosticSeverity(d),
  }));
}

/** One listen, read off its file. */
export interface Listen {
  file: MovementFile;
  listener: FileListener;
}

export function collectListens(files: MovementFile[], languageVersion: LanguageVersion): Listen[] {
  return files.flatMap((file) => {
    let program;
    try {
      program = parseProgram(file.source, { languageVersion });
    } catch (error) {
      // A file that does not parse routes nothing; `lf check` reports why.
      if (error instanceof MovementParseError) return [];
      throw error;
    }
    return collectFileListeners(program).map((listener) => ({ file, listener }));
  });
}
