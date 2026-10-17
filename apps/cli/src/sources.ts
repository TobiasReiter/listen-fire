// The project's movement files: scanned, checked, and read for their listens.
// Routing is read from source — every `listen … fire …` across the files is
// the routing table, exactly as the hosted product derives one trigger per
// listen when a file is saved.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  MovementParseError,
  checkSourceInRust,
  diagnosticSeverity,
  instanceSchemaKey,
  parseProgram,
  type CatalogSnapshot,
  type CredentialSpec,
  type InstanceSchema,
  type LanguageVersion,
} from 'movement-lang';
import { z } from 'zod';
import { triggerTypeSchema } from 'engine-contracts';
import { collectFileListeners, type FileListener } from 'movement-engine/services/translation_graph/movement/file_listeners';
import {
  buildCatalogSnapshot,
  type CatalogAdapterInput,
} from 'movement-engine/services/translation_graph/movement/catalog_snapshot';
import type { RunningExternal } from './externals';
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
 * The catalog a program is checked and run against, built by the same builder
 * the hosted product uses: each adapter external's manifest answer (what a
 * listen on it may say) and schema, the credentials the secrets name, and the
 * project's files (so a file import resolves by path, as it does today).
 */
export function catalogOf(input: {
  running: Map<string, RunningExternal>;
  schemas: Map<string, InstanceSchema>;
  credentials: Map<string, Credential>;
  files: MovementFile[];
}): CatalogSnapshot {
  const credentials: Record<string, CredentialSpec> = {};
  for (const credential of input.credentials.values()) credentials[credential.name] = { adapters: [credential.external] };
  const adapters: CatalogAdapterInput[] = [];
  for (const [name, running] of input.running) {
    // The hosted product holds a remote install's secret itself, so there it
    // constructs credential-free; here the secrets file names it, so an
    // external that authenticates takes the credential as an argument.
    const credentialed = running.external.manifest.auth !== undefined;
    const schema = input.schemas.get(name);
    const schemas: Record<string, InstanceSchema> = {};
    if (schema !== undefined) {
      if (!credentialed) schemas[instanceSchemaKey({})] = schema;
      for (const [credentialName, spec] of Object.entries(credentials)) {
        if (credentialed && spec.adapters.includes(name)) schemas[instanceSchemaKey({ credentialName })] = schema;
      }
    }
    adapters.push({
      manifest: {
        adapterType: name,
        supportedTriggers: z.array(triggerTypeSchema).parse(running.supportedTriggers),
        ...running.listen,
        introspectedSchema: true,
      },
      constructionArgs: credentialed ? [{ name: 'credentials', kind: 'credential', required: true }] : [],
      schemas,
    });
  }
  return buildCatalogSnapshot({
    adapters,
    credentials,
    plugins: {},
    files: Object.fromEntries(input.files.map((f) => [f.name, { source: f.source }])),
  });
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
 * The checker seam: every diagnostic one file has, by the Rust checker — the
 * one every `lf` run is held to, since every run is on the Rust engine.
 */
export function checkFile(input: {
  file: MovementFile;
  catalog: CatalogSnapshot;
  languageVersion: LanguageVersion;
}): FileDiagnostic[] {
  // The parse first, for its error's place, which the checker's refusal
  // words without one.
  try {
    parseProgram(input.file.source, { languageVersion: input.languageVersion });
  } catch (error) {
    if (!(error instanceof MovementParseError)) throw error;
    return [{ file: input.file, line: error.loc.line, column: error.loc.col, code: 'MOV_PARSE', message: error.message, severity: 'error' }];
  }
  return checkSourceInRust(input.file.source, input.catalog, { languageVersion: input.languageVersion }).map((d) => ({
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
