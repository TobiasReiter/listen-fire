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
  type PluginSpec,
} from 'movement-lang';
import { pluginSpecsOfManifest } from 'module-kit';
import { z } from 'zod';
import { triggerTypeSchema } from 'engine-contracts';
import { collectFileListeners, type FileListener } from 'movement-engine/public/run-support';
import {
  buildCatalogSnapshot,
  type CatalogAdapterInput,
} from 'movement-engine/public/catalog';
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
  for (const credential of input.credentials.values()) {
    const binding = credential.binding ?? { kind: 'legacy' as const };
    // An install's secret signs calls; it is no account a `using` may name.
    if (binding.kind === 'install') continue;
    credentials[credential.name] = { adapters: [credential.external], ...(binding.kind === 'credential' ? { credential: binding.declared } : {}) };
  }
  const adapters: CatalogAdapterInput[] = [];
  for (const [name, running] of input.running) {
    if (running.external.manifest.kind === 'plugin') continue;
    // The hosted product holds a remote install's secret itself, so there it
    // constructs credential-free; here the secrets file names it, so an
    // external that authenticates takes the credential as an argument.
    // A module that declares credentials is connected as one of its users.
    // One that declares none is connected as itself once its install holds
    // the server secret; before that (a hand-written entry) the entry names it.
    const installed = [...input.credentials.values()].some((c) => c.external === name && c.binding?.kind === 'install');
    const credentialed = running.credentials.length > 0 || (running.external.manifest.auth !== undefined && !installed);
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
        ...(running.credentials.length > 0 ? { declaredCredentials: running.credentials.map((declared) => declared.name) } : {}),
        introspectedSchema: true,
      },
      constructionArgs: credentialed ? [{ name: 'credentials', kind: 'credential', required: true }] : [],
      schemas,
    });
  }
  return buildCatalogSnapshot({
    adapters,
    credentials,
    plugins: pluginsOf(input.running),
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

/**
 * The plugins the project's plugin externals serve, keyed as a program spells
 * them, each tagged with the package it is imported from. Two externals
 * serving one plugin name would make a call mean two things: refused.
 */
export function pluginsOf(running: Map<string, RunningExternal>): Record<string, PluginSpec> {
  const plugins: Record<string, PluginSpec> = {};
  const servedBy = new Map<string, string>();
  for (const [name, external] of running) {
    if (external.plugins === undefined) continue;
    for (const [plugin, spec] of Object.entries(pluginSpecsOfManifest({ plugins: external.plugins }))) {
      const other = servedBy.get(plugin);
      if (other !== undefined) throw new Error(`plugin "${plugin}" is served by both externals "${other}" and "${name}"`);
      servedBy.set(plugin, name);
      plugins[plugin] = spec;
    }
  }
  return plugins;
}

/** The plugin external that serves `plugin` (either spelling). */
export function pluginExternalFor(running: Map<string, RunningExternal>, plugin: string): RunningExternal | undefined {
  const spelled = plugin.replace(/-/g, '_');
  for (const external of running.values()) {
    if (external.plugins?.plugins.some((p) => p.name.replace(/-/g, '_') === spelled)) return external;
  }
  return undefined;
}
