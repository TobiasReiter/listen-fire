// The built-in integrations, one line each: `legacy` (the adapter or plugin
// this app has always run) or `module` (its module, `modules/<name>`, loaded
// in process). Flipping a line is the whole switch, and flipping it back the
// whole rollback. A module line loads its module on first use, not when this
// app starts, and the platform is then the module's host: the credential from
// the encrypted store, the dev loop's fake as `baseUrlOverride` for the
// test-harness team, the engine's logger, answers validated outside hosted
// production (`inProcessValidationDefault`). A line may add what its module
// needs of the host beyond that: how its stored payload reads as fields, the
// platform's OAuth app that refreshes its token, its dev-loop fake, its kv and
// files — or the whole credential, when the platform's stored shapes need
// more than a reading (Gmail's two connect methods). A file the module reads out is named as the install's, as a module
// served as a process has its files named. The module declares the rest —
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
  type ModuleFiles,
  type ModuleKv,
  type PluginModuleDefinition,
} from 'module-kit';
import {
  createSecretsFamily,
  declaredRefresher,
  expiresWithin,
  type OAuth2ClientApp,
  type SecretsFamily,
} from 'movement-engine/public/secrets';
import { declaredInboundVerifier, type InboundVerifier } from 'movement-engine/public/inbound';
import { ownedFilesAdapter } from 'movement-engine/public/modules';
import { logger } from 'movement-engine/public/log';
import { DEALROOM_MANIFEST } from '@lf/dealroom/manifest';
import { GRANOLA_MANIFEST } from '@lf/granola/manifest';
import { EVERTRACE_MANIFEST } from '@lf/evertrace/manifest';
import { DROPBOX_MANIFEST } from '@lf/dropbox/manifest';
import { GOOGLE_SHEETS_MANIFEST } from '@lf/google-sheets/manifest';
import { GOOGLE_DRIVE_MANIFEST } from '@lf/google-drive/manifest';
import { GMAIL_MANIFEST } from '@lf/gmail/manifest';
import { pluginDeclarationNamed } from 'movement-engine/public/plugins';

import { injectFakeBaseUrl, isTestHarnessTeam } from '../../../lib/recording';
import { getAutomationsQb } from '../../../lib/kysely';
import { services } from '../../../adapters/registry';
import { camelTokenPayloadShape, postgresSecrets, type PayloadShape } from '../../credentials/secrets_postgres';
import { grantedItemsKv } from '../../credentials/granted_items';
import { platformModuleFiles } from '../engine/files/module_files';
import { googleIntegrationsApp } from '../../../adapters/google/authClient';
import { gmailModuleCredential } from '../../../adapters/gmail/module_credential';
import { credentialTypeOf } from './credential_type';

export type BuiltinLine = 'legacy' | 'module';

/** The platform's registered app at a provider, and where it refreshes when
 *  that is not the module's declared token URL. */
export type HostOAuthApp = OAuth2ClientApp & { tokenUrl?: string };

/** What a module line asks of the platform as its host, beyond the
 *  credential, the logger and validation every module line gets. */
export interface ModuleLineHost {
  /** How the stored credential payload reads as the module's fields (and
   *  takes a write-back). Default: flat, its string keys as they are. */
  storedAs?: PayloadShape;
  /** The platform's own OAuth app at the provider. With one, an `oauth2`
   *  credential is refreshed by the platform before it reaches the module,
   *  at the token URL the module declares unless the app names its own (the
   *  dev loop's fake OAuth provider). */
  hostApp?: () => HostOAuthApp | undefined;
  /** The install's credential, when reading the stored payload is not
   *  enough. Default: the stored credential, read the way `storedAs` says
   *  and refreshed with `hostApp`. */
  credential?: (install: BuiltinInstall) => ModuleCredential;
  /** The install's kv. Default: refused, by name. */
  kv?: (install: BuiltinInstall) => ModuleKv;
  /** The install's files. Default: refused, by name. */
  files?: (install: BuiltinInstall) => ModuleFiles;
}

/** One built-in's line. A module line names how to load the module, and the
 *  manifest the host lists it by without loading it. */
export type BuiltinModuleLine =
  | { kind: 'adapter' | 'plugin'; line: 'legacy' }
  | (ModuleLineHost & {
      kind: 'adapter';
      line: 'module';
      manifest: AdapterManifest;
      load: () => AdapterModuleDefinition;
      /** The dev loop's fake for this module, by its service name in the
       *  recording layer. Default: the manifest's credential type. */
      harnessService?: string;
    })
  | (ModuleLineHost & { kind: 'plugin'; line: 'module'; load: () => PluginModuleDefinition });

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
  evertrace: {
    kind: 'adapter',
    line: 'module',
    manifest: EVERTRACE_MANIFEST,
    load: () => {
      const { evertraceModule }: typeof import('@lf/evertrace') = require('@lf/evertrace');
      return evertraceModule;
    },
  },
  affinity: { kind: 'adapter', line: 'legacy' },
  airtable: { kind: 'adapter', line: 'legacy' },
  attio: { kind: 'adapter', line: 'legacy' },
  google_sheets: {
    kind: 'adapter',
    line: 'module',
    manifest: GOOGLE_SHEETS_MANIFEST,
    load: () => {
      const { googleSheetsModule }: typeof import('@lf/google-sheets') = require('@lf/google-sheets');
      return googleSheetsModule;
    },
    // The connect flow stores `{ accessToken, refreshToken, expiresAt }`.
    storedAs: camelTokenPayloadShape,
    hostApp: googleIntegrationsApp,
    harnessService: 'GOOGLE_SHEETS',
    kv: (install) =>
      install.credentialsId !== undefined
        ? grantedItemsKv(install.credentialsId, { teamId: install.teamId })
        : refusingKv('Google Sheets: no credential is connected, so there are no granted spreadsheets. Connect Google Sheets.'),
  },
  google_drive: {
    kind: 'adapter',
    line: 'module',
    manifest: GOOGLE_DRIVE_MANIFEST,
    load: () => {
      const { googleDriveModule }: typeof import('@lf/google-drive') = require('@lf/google-drive');
      return googleDriveModule;
    },
    // The connect flow stores `{ accessToken, refreshToken, expiresAt }`.
    storedAs: camelTokenPayloadShape,
    hostApp: googleIntegrationsApp,
    harnessService: 'GOOGLE_DRIVE',
    kv: (install) =>
      install.credentialsId !== undefined
        ? grantedItemsKv(install.credentialsId, { teamId: install.teamId })
        : refusingKv('Google Drive: no credential is connected, so there are no granted items. Connect Google Drive.'),
    files: (install) => platformModuleFiles({ teamId: install.teamId, module: '@lf/google-drive' }),
  },
  dropbox: {
    kind: 'adapter',
    line: 'module',
    manifest: DROPBOX_MANIFEST,
    load: () => {
      const { dropboxModule }: typeof import('@lf/dropbox') = require('@lf/dropbox');
      return dropboxModule;
    },
    // The connect flow stores `{ accessToken, refreshToken, expiresAt }`.
    storedAs: camelTokenPayloadShape,
    hostApp: () => services.dropbox?.authClient.hostApp(),
    files: (install) => platformModuleFiles({ teamId: install.teamId, module: '@lf/dropbox' }),
  },
  gmail: {
    kind: 'adapter',
    line: 'module',
    manifest: GMAIL_MANIFEST,
    load: () => {
      const { gmailModule }: typeof import('@lf/gmail') = require('@lf/gmail');
      return gmailModule;
    },
    // Two stored shapes (a sign-in, a delegated mailbox) behind one set of
    // fields, the allowlist enforced before either is handed over.
    credential: gmailModuleCredential,
    harnessService: 'GOOGLE_GMAIL',
    files: (install) => platformModuleFiles({ teamId: install.teamId, module: '@lf/gmail' }),
  },
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

/** Every adapter module line. */
function adapterModuleLines(): AdapterModuleLine[] {
  return Object.values(BUILTIN_MODULES).flatMap((entry) => (entry.kind === 'adapter' && entry.line === 'module' ? [entry] : []));
}

/** What an install of a built-in is constructed for. */
export interface BuiltinInstall {
  teamId: TeamId;
  credentialsId?: string;
  constructionArgs?: Record<string, string>;
}

/** How long before its expiry the platform refreshes a token it hands a
 *  module: google-auth-library's eager threshold, which the Google lines
 *  refreshed by before they were modules. */
export const HOST_REFRESH_WINDOW_MS = 5 * 60_000;

/**
 * The install's credential, read and written back through the encrypted
 * store (cipher and payload exactly as the connect flow stored them, read as
 * fields the way the line says). An `oauth2` credential on a line with a host
 * app is refreshed first when it expires within the window: through the
 * family, so one refresh runs at a time per credential here, and the store's
 * lock and version keep two processes from spending one refresh token.
 */
function storedCredential(
  definition: ModuleDefinition,
  install: BuiltinInstall,
  options: { secrets: SecretsFamily; hostApp?: () => HostOAuthApp | undefined },
): ModuleCredential {
  const { secrets, hostApp } = options;
  const declared = definition.credentials[0];
  const displayName = definition.kind === 'adapter' ? definition.manifest.displayName : definition.name;
  if (declared === undefined) return noCredential(`module ${definition.name} declares no credential`);
  const ref = install.credentialsId;
  if (ref === undefined) {
    return noCredential(`${displayName}: no credential is connected for team ${install.teamId} (credentialsId unset). Connect ${displayName}.`);
  }
  const refreshes = declared.kind === 'oauth2' && hostApp !== undefined;
  return {
    name: declared.name,
    fields: async () => {
      const record = await secrets.resolve(ref);
      if (!refreshes || !expiresWithin(record.fields, HOST_REFRESH_WINDOW_MS)) return record.fields;
      const app = hostApp();
      if (app === undefined) {
        throw new Error(`${displayName}: the token has expired and the platform has no ${displayName} OAuth app configured to refresh it.`);
      }
      const { tokenUrl, ...client } = app;
      const at = declared.kind === 'oauth2' && tokenUrl !== undefined ? { ...declared, oauth2: { ...declared.oauth2, tokenUrl } } : declared;
      const refresher = declaredRefresher(at, { client });
      if (refresher === undefined) return record.fields;
      try {
        return (await secrets.refresh(ref, { seenVersion: record.version, refresher })).fields;
      } catch (error) {
        // The family's message names the credential and the provider's answer
        // with every secret value taken out; the caller is told only which.
        logger.error(`[${displayName}] token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        throw new Error(`${displayName} token refresh failed`);
      }
    },
    update: async (fields) => {
      await secrets.update(ref, fields);
    },
  };
}

/** The dev loop's fake for the test-harness team, by the service the line
 *  names (default the manifest's credential type); nothing for anyone else. */
function harnessBaseUrl(entry: AdapterModuleLine, definition: AdapterModuleDefinition, teamId: TeamId): string | undefined {
  const service = entry.harnessService ?? definition.manifest.requiredCredentialType;
  if (!isTestHarnessTeam(teamId) || service === undefined) return undefined;
  const redirected = injectFakeBaseUrl({}, service).baseUrl;
  return typeof redirected === 'string' ? redirected : undefined;
}

/** What the platform hosts a module line's module with, for one install:
 *  the stored credential, and the line's kv and files (refused by name
 *  where the line names none). */
function platformHost(
  entry: ModuleLineHost,
  definition: ModuleDefinition,
  install: BuiltinInstall,
): { credential: ModuleCredential; kv: ModuleKv; files: ModuleFiles } {
  const secrets = createSecretsFamily({
    backend: postgresSecrets({ teamId: install.teamId, ...(entry.storedAs !== undefined ? { shape: entry.storedAs } : {}) }),
    warn: (message) => logger.warn(message),
  });
  const unavailable = (what: string) => `module ${definition.name}: ${what} has no store on the platform for this module`;
  return {
    credential:
      entry.credential?.(install) ??
      storedCredential(definition, install, { secrets, ...(entry.hostApp !== undefined ? { hostApp: entry.hostApp } : {}) }),
    kv: entry.kv?.(install) ?? refusingKv(unavailable('ctx.kv')),
    files: entry.files?.(install) ?? refusingFiles(unavailable('ctx.files')),
  };
}

/** A module line's adapter module, loaded in process for one install. */
export function loadBuiltinModule(entry: AdapterModuleLine, install: BuiltinInstall): InProcessAdapterModule {
  const definition = entry.load();
  const baseUrlOverride = harnessBaseUrl(entry, definition, install.teamId);
  const loaded = adapterInProcess(definition, {
    tenant: install.teamId,
    ...platformHost(entry, definition, install),
    log: logger,
    ...(baseUrlOverride !== undefined ? { baseUrlOverride } : {}),
    ...(install.constructionArgs !== undefined ? { constructionArgs: install.constructionArgs } : {}),
    validateResults: inProcessValidationDefault(process.env),
  });
  // The files it reads out name this install, as a served module's do.
  const owner = { adapterType: definition.manifest.adapterType, ...(install.credentialsId !== undefined ? { credentialsId: install.credentialsId } : {}) };
  return { ...loaded, adapter: ownedFilesAdapter(loaded.adapter, owner) };
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
  return (install) => loadBuiltinModule(entry, install).adapter;
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
    const loaded = loadBuiltinModule(entry, install);
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
  for (const entry of adapterModuleLines()) {
    const declared = entry.load().inbound;
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
  for (const entry of adapterModuleLines()) {
    const definition = entry.load();
    for (const task of definition.periodic ?? []) {
      kinds.push({
        kind: `module_periodic:${definition.manifest.adapterType}:${task.name}`,
        intervalMs: task.intervalSeconds * 1000,
        handler: {
          async run() {
            for (const install of await listInstalls(definition)) {
              try {
                await loadBuiltinModule(entry, install).runPeriodic?.(task.name);
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
    return pluginsInProcess(definition, {
      tenant: install.teamId,
      ...platformHost(entry, definition, { teamId: install.teamId }),
      log: logger,
      validateResults: inProcessValidationDefault(process.env),
    });
  }
  return undefined;
}
