// The built-in integrations, one line each: `legacy` (the adapter or plugin
// this app has always run) or `module` (its module, `modules/<name>`, loaded
// in process). Flipping a line is the whole switch, and flipping it back the
// whole rollback. A module line loads its module on first use, not when this
// app starts, and the platform is then the module's host: the credential from
// the encrypted store, the dev loop's fake as `baseUrlOverride` for the
// test-harness team, the engine's logger, answers validated outside hosted
// production (`inProcessValidationDefault`). The module declares the rest —
// its poll, its periodic tasks, its signed inbound — and the platform acts on
// the declarations, so nothing here names what a module does.

import type { Adapter, AdapterManifest } from 'movement-engine/public/adapter';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { WorkKindRegistration } from '../../work/drain';
import type { PollSource } from '../poll_source';

import {
  adapterInProcess,
  pluginsInProcess,
  inProcessValidationDefault,
  noCredential,
  refusingFiles,
  refusingKv,
  type AdapterModuleDefinition,
  type InProcessAdapterModule,
  type InProcessPluginModule,
  type ModuleCredential,
  type ModuleDefinition,
  type PluginModuleDefinition,
} from 'module-kit';
import { createSecretsFamily, type SecretsFamily } from 'movement-engine/public/secrets';
import { declaredInboundVerifier, type InboundVerifier } from 'movement-engine/public/inbound';
import { logger } from 'movement-engine/public/log';
import { DEALROOM_MANIFEST } from '@lf/dealroom/manifest';
import { GRANOLA_MANIFEST } from '@lf/granola/manifest';
import { pluginDeclarationNamed } from 'movement-engine/public/plugins';

import { injectFakeBaseUrl, isTestHarnessTeam } from '../../../lib/recording';
import { getAutomationsQb } from '../../../lib/kysely';
import { postgresSecrets } from '../../credentials/secrets_postgres';
import { credentialTypeOf } from './credential_type';

export type BuiltinLine = 'legacy' | 'module';

/** One built-in's line. A module line names how to load the module, and the
 *  manifest the host lists it by without loading it. */
export type BuiltinModuleLine =
  | { kind: 'adapter' | 'plugin'; line: 'legacy' }
  | { kind: 'adapter'; line: 'module'; manifest: AdapterManifest; load: () => AdapterModuleDefinition }
  | { kind: 'plugin'; line: 'module'; load: () => PluginModuleDefinition };

/** The table a lookup reads: `BUILTIN_MODULES`, or a test's own. */
export type BuiltinModuleTable = Readonly<Record<string, BuiltinModuleLine>>;

/**
 * Every built-in that becomes a module (plan 22 #1), by adapter type or
 * plugin name. The order is the plan's (dealroom first, Slack last). A0
 * creates every line so each later move edits exactly one.
 */
export const BUILTIN_MODULES: BuiltinModuleTable = {
  dealroom: {
    kind: 'adapter',
    line: 'module',
    manifest: DEALROOM_MANIFEST,
    load: () => {
      const { dealroomModule }: typeof import('@lf/dealroom') = require('@lf/dealroom');
      return dealroomModule;
    },
  },
  granola: {
    kind: 'adapter',
    line: 'module',
    manifest: GRANOLA_MANIFEST,
    load: () => {
      const { granolaModule }: typeof import('@lf/granola') = require('@lf/granola');
      return granolaModule;
    },
  },
  evertrace: { kind: 'adapter', line: 'legacy' },
  affinity: { kind: 'adapter', line: 'legacy' },
  airtable: { kind: 'adapter', line: 'legacy' },
  attio: { kind: 'adapter', line: 'legacy' },
  google_sheets: { kind: 'adapter', line: 'legacy' },
  google_drive: { kind: 'adapter', line: 'legacy' },
  dropbox: { kind: 'adapter', line: 'legacy' },
  gmail: { kind: 'adapter', line: 'legacy' },
  telegram: { kind: 'adapter', line: 'legacy' },
  slack: { kind: 'adapter', line: 'legacy' },
  // The bundled plugins (Henry 2026-10-17: plugins are modules too).
  'fetch-url': { kind: 'plugin', line: 'legacy' },
  'web-research': { kind: 'plugin', line: 'legacy' },
  research: { kind: 'plugin', line: 'legacy' },
  'linkedin-research': { kind: 'plugin', line: 'legacy' },
  'linkedin-enrichment': { kind: 'plugin', line: 'legacy' },
  'vc-url-retrieval': { kind: 'plugin', line: 'legacy' },
};

type AdapterModuleLine = Extract<BuiltinModuleLine, { kind: 'adapter'; line: 'module' }>;

function moduleLineOf(name: string): AdapterModuleLine | undefined {
  const entry = BUILTIN_MODULES[name];
  return entry?.kind === 'adapter' && entry.line === 'module' ? entry : undefined;
}

/** Every adapter module line's definition, loaded. */
function adapterModuleDefinitions(): AdapterModuleDefinition[] {
  return Object.values(BUILTIN_MODULES).flatMap((entry) => (entry.kind === 'adapter' && entry.line === 'module' ? [entry.load()] : []));
}

/** What an install of a built-in is constructed for. */
export interface BuiltinInstall {
  teamId: TeamId;
  credentialsId?: string;
  constructionArgs?: Record<string, string>;
}

/** The install's credential, read and written back through the encrypted
 *  store (cipher and payload exactly as the connect flow stored them). */
function storedCredential(definition: ModuleDefinition, install: BuiltinInstall, secrets: SecretsFamily): ModuleCredential {
  const declared = definition.credentials[0];
  const displayName = definition.kind === 'adapter' ? definition.manifest.displayName : definition.name;
  if (declared === undefined) return noCredential(`module ${definition.name} declares no credential`);
  const ref = install.credentialsId;
  if (ref === undefined) {
    return noCredential(`${displayName}: no credential is connected for team ${install.teamId} (credentialsId unset). Connect ${displayName}.`);
  }
  return {
    name: declared.name,
    fields: async () => (await secrets.resolve(ref)).fields,
    update: async (fields) => {
      await secrets.update(ref, fields);
    },
  };
}

/** The dev loop's fake for the test-harness team, by the credential type the
 *  module's manifest names; nothing for anyone else. */
function harnessBaseUrl(definition: AdapterModuleDefinition, teamId: TeamId): string | undefined {
  const type = definition.manifest.requiredCredentialType;
  if (!isTestHarnessTeam(teamId) || type === undefined) return undefined;
  const redirected = injectFakeBaseUrl({}, type).baseUrl;
  return typeof redirected === 'string' ? redirected : undefined;
}

/** A module line's adapter module, loaded in process for one install. */
export function loadBuiltinModule(definition: AdapterModuleDefinition, install: BuiltinInstall): InProcessAdapterModule {
  const secrets = createSecretsFamily({
    backend: postgresSecrets({ teamId: install.teamId }),
    warn: (message) => logger.warn(message),
  });
  const unavailable = (what: string) =>
    `module ${definition.name}: ${what} has no store on the platform yet (no built-in module uses it)`;
  const baseUrlOverride = harnessBaseUrl(definition, install.teamId);
  return adapterInProcess(definition, {
    tenant: install.teamId,
    credential: storedCredential(definition, install, secrets),
    log: logger,
    files: refusingFiles(unavailable('ctx.files')),
    kv: refusingKv(unavailable('ctx.kv')),
    ...(baseUrlOverride !== undefined ? { baseUrlOverride } : {}),
    ...(install.constructionArgs !== undefined ? { constructionArgs: install.constructionArgs } : {}),
    validateResults: inProcessValidationDefault(process.env),
  });
}

/** The manifest of a built-in on a module line, without loading it. */
export function builtinModuleManifest(adapterType: string): AdapterManifest | undefined {
  return moduleLineOf(adapterType)?.manifest;
}

/** A registry factory for a built-in: its module when its line says so,
 *  else the legacy factory it has always had. */
export function builtinAdapterFactory(
  adapterType: string,
  legacy: (input: BuiltinInstall) => Adapter,
): (input: BuiltinInstall) => Adapter {
  const entry = moduleLineOf(adapterType);
  if (entry === undefined) return legacy;
  return (install) => loadBuiltinModule(entry.load(), install).adapter;
}

/** A registry poll source for a built-in: the module's declared poll when its
 *  line says so, else the legacy poll source. */
export function builtinPollSourceFactory(
  adapterType: string,
  legacy: (input: BuiltinInstall) => PollSource,
): (input: BuiltinInstall) => PollSource {
  const entry = moduleLineOf(adapterType);
  if (entry === undefined) return legacy;
  return (install) => {
    const definition = entry.load();
    const declared = definition.poll;
    const loaded = loadBuiltinModule(definition, install);
    const poll = loaded.poll;
    if (declared === undefined || poll === undefined) {
      throw new Error(`module ${definition.name} declares no poll; it is not a polled source`);
    }
    return {
      pollIntervalSeconds: declared.intervalSeconds,
      getEvents: (input) => poll({ config: input.config, ...(input.checkpoint !== undefined ? { checkpoint: input.checkpoint } : {}) }),
    };
  };
}

/**
 * The verifier for a built-in's inbound when its module declares one: the
 * host's one rule for a declared signed inbound. Undefined when no module
 * line declares an inbound under that provider key (the frozen table then
 * verifies, as it always has).
 */
export function builtinModuleInboundVerifier(providerKey: string): InboundVerifier | undefined {
  for (const definition of adapterModuleDefinitions()) {
    const declared = definition.inbound;
    if (declared !== undefined && declared.providerKey.toUpperCase() === providerKey.toUpperCase()) {
      return declaredInboundVerifier(declared);
    }
  }
  return undefined;
}

// ── Periodic tasks ──────────────────────────────────────────────────────────
// A module's `periodic` declarations, as work kinds: one periodic kind per
// declared task, run once per install (each connected credential of the
// module's type) with that install's credential.

declare module '../../work/kinds' {
  interface UnitWorkKinds {
    [kind: `module_periodic:${string}`]: true;
  }
}

/** The installs of a module on the platform: every connected credential of
 *  the type its manifest names. */
async function installsOf(definition: AdapterModuleDefinition): Promise<BuiltinInstall[]> {
  const type = credentialTypeOf(definition.manifest.requiredCredentialType);
  if (type === null) return [];
  const rows = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('type', '=', type)
    .where('credentials', 'is not', null)
    .select(['id', 'team_id'])
    .execute();
  return rows.map((row) => ({ teamId: row.team_id as TeamId, credentialsId: row.id as unknown as string }));
}

/** The work kinds every module line's periodic declarations need. Loading a
 *  module line here is its first use in the process that drains. */
export function builtinModuleWorkKinds(
  listInstalls: (definition: AdapterModuleDefinition) => Promise<BuiltinInstall[]> = installsOf,
): WorkKindRegistration[] {
  const kinds: WorkKindRegistration[] = [];
  for (const definition of adapterModuleDefinitions()) {
    for (const task of definition.periodic ?? []) {
      kinds.push({
        kind: `module_periodic:${definition.manifest.adapterType}:${task.name}`,
        intervalMs: task.intervalSeconds * 1000,
        handler: {
          async run() {
            for (const install of await listInstalls(definition)) {
              try {
                await loadBuiltinModule(definition, install).runPeriodic?.(task.name);
              } catch (error) {
                // One install's failure never stops the next.
                logger.error(`[module] ${definition.name} periodic task ${task.name} failed for an install`, {
                  teamId: install.teamId,
                  credentialsId: install.credentialsId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          },
        },
      });
    }
  }
  return kinds;
}

// ── Plugins ─────────────────────────────────────────────────────────────────

/**
 * The in-process plugin module that serves `plugin` (either spelling), when a
 * plugin module line declares it; undefined sends the call to the legacy
 * registry. A plugin's module is loaded for the team the run belongs to.
 */
export function builtinPluginModule(
  plugin: string,
  install: Pick<BuiltinInstall, 'teamId'>,
  table: BuiltinModuleTable = BUILTIN_MODULES,
): InProcessPluginModule | undefined {
  for (const entry of Object.values(table)) {
    if (entry.kind !== 'plugin' || entry.line !== 'module') continue;
    const definition = entry.load();
    if (pluginDeclarationNamed(definition.plugins, plugin) === undefined) continue;
    const secrets = createSecretsFamily({ backend: postgresSecrets({ teamId: install.teamId }), warn: (message) => logger.warn(message) });
    const unavailable = (what: string) => `module ${definition.name}: ${what} has no store on the platform yet (no built-in module uses it)`;
    return pluginsInProcess(definition, {
      tenant: install.teamId,
      credential: storedCredential(definition, install, secrets),
      log: logger,
      files: refusingFiles(unavailable('ctx.files')),
      kv: refusingKv(unavailable('ctx.kv')),
      validateResults: inProcessValidationDefault(process.env),
    });
  }
  return undefined;
}
