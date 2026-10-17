// The engine inside the SaaS's own process: each customer is a tenant with its
// own saved movements, its own CRM records and its own API key; a customer's
// movement is checked when saved and run when one of its events happens.
// Everything here comes from the engine's public entries and the module kit.

import { tenantIdOf, type RunInput } from '@lf/engine-contracts';
import { runMovement, checkPinnedInRust, parsePinned, type MovementRunResult } from '@lf/engine/public/movement-engine';
import { inProcessHost, introspectAdapter, collectFileListeners, pricedModels, type FileListener, type ModelClient } from '@lf/engine/public/embed';
import { buildCatalogSnapshot } from '@lf/engine/public/catalog';
import { eventMatchesTriggerScope, triggerEventOf } from '@lf/engine/public/inbound';
import { createMemoryVault, createSecretsFamily, type MemoryVault } from '@lf/engine/public/secrets';
import type { Adapter, DiscriminableEvent } from '@lf/engine/public/adapter';
import type { EngineHost } from '@lf/engine/public/host';
import { adapterInProcess, memoryKv, refusingFiles, secretsCredential, type ModuleLog } from '@lf/module-kit';

import { CompanyStore, crmModule } from './crm';

/** The language version every customer's movement is pinned to. */
export const LANGUAGE_VERSION = 5;

/** The one connection a customer's movement imports: its CRM workspace. */
export const CREDENTIAL = 'workspace';

/** What a run may consume. A customer's movement is code the SaaS did not
 *  write: every limit is set, and every run has a cost cap. */
export interface Limits {
  maxSteps: number;
  maxTextBytes: number;
  maxCollectionItems: number;
  maxResultBytes: number;
  /** The most one run may spend on models, in microdollars. */
  costCapMicrodollars: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxSteps: 100_000,
  maxTextBytes: 1024 * 1024,
  maxCollectionItems: 10_000,
  maxResultBytes: 4 * 1024 * 1024,
  costCapMicrodollars: 50_000,
};

interface SavedMovement {
  name: string;
  source: string;
  listeners: FileListener[];
}

/** What a save answers: saved, or why not (the checker's words). */
export type SaveAnswer = { saved: true; listens: number } | { saved: false; problems: string[] };

export interface FiredRun {
  movement: string;
  outcome: { ok: true; writes: number; spentMicrodollars: number } | { ok: false; error: string };
}

type CatalogSnapshot = RunInput['catalog'];

const quietLog: ModuleLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export class Embedding {
  readonly companies = new CompanyStore();
  private readonly crm = crmModule(this.companies);
  private readonly vault: MemoryVault = createMemoryVault();
  private readonly secrets = createSecretsFamily({ backend: this.vault });
  private readonly movements = new Map<string, Map<string, SavedMovement>>();
  private readonly host: EngineHost;

  constructor(private readonly options: { models?: ModelClient; limits?: Limits } = {}) {
    this.host = inProcessHost({
      adapters: { resolve: ({ adapterType, teamId, credentialsId }) => this.crmFor({ adapterType, tenant: teamId, credentialsId }) },
      // A run reaches only its own tenant's connection: the host asks this
      // before it builds an instance for the credential a run names.
      credentials: { belongsTo: ({ teamId, credentialsId }) => credentialsId === credentialRef(teamId) },
      ...(options.models !== undefined ? { llm: pricedModels({ client: options.models }) } : {}),
    });
  }

  /** A new customer: its own tenant, and the API key its CRM workspace is
   *  reached with, kept in the SaaS's vault. */
  addCustomer(tenant: string, apiKey: string): void {
    this.vault.put(credentialRef(tenant), { api_key: apiKey });
    this.movements.set(tenant, new Map());
  }

  /** Check a customer's movement against its own catalog; save it if clean. */
  async save(tenant: string, name: string, source: string): Promise<SaveAnswer> {
    const saved = this.savedOf(tenant);
    const catalog = await this.catalogFor(tenant);
    try {
      checkPinnedInRust({ source, catalog, languageVersion: LANGUAGE_VERSION });
    } catch (error) {
      return { saved: false, problems: [error instanceof Error ? error.message : String(error)] };
    }
    const listeners = collectFileListeners(parsePinned({ source, languageVersion: LANGUAGE_VERSION }));
    saved.set(name, { name, source, listeners });
    return { saved: true, listens: listeners.length };
  }

  /** Something happened in a customer's CRM: run each of its movements that
   *  listens for it. */
  async fire(tenant: string, event: DiscriminableEvent): Promise<FiredRun[]> {
    const catalog = await this.catalogFor(tenant);
    const runs: FiredRun[] = [];
    for (const movement of this.savedOf(tenant).values()) {
      for (const listener of movement.listeners) {
        if (listener.adapter !== 'crm' || !eventMatchesTriggerScope(event, listener.config)) continue;
        runs.push({ movement: movement.name, outcome: await this.run(tenant, movement, listener, event, catalog) });
      }
    }
    return runs;
  }

  private async run(tenant: string, movement: SavedMovement, listener: FileListener, event: DiscriminableEvent, catalog: CatalogSnapshot): Promise<FiredRun['outcome']> {
    const limits = this.options.limits ?? DEFAULT_LIMITS;
    const { triggerEvent } = triggerEventOf({
      pipelineInputId: `${movement.name}:${listener.movementName}`,
      adapterType: 'crm',
      triggerType: 'webhook',
      event,
      eventTypes: (await this.crmFor({ adapterType: 'crm', tenant, credentialsId: credentialRef(tenant) }).listEventTypes?.()) ?? [],
      now: new Date(),
    });
    const input: RunInput & { host: EngineHost } = {
      source: movement.source,
      languageVersion: LANGUAGE_VERSION,
      movementName: listener.movementName,
      event: triggerEvent,
      teamId: tenantIdOf(tenant),
      catalog,
      credentialIds: { [CREDENTIAL]: credentialRef(tenant) },
      costCapMicrodollars: limits.costCapMicrodollars,
      limits: {
        maxSteps: limits.maxSteps,
        maxTextBytes: limits.maxTextBytes,
        maxCollectionItems: limits.maxCollectionItems,
        maxResultBytes: limits.maxResultBytes,
      },
      host: this.host,
    };
    try {
      const result: MovementRunResult = await runMovement(input);
      return { ok: true, writes: result.writes.length, spentMicrodollars: result.runSpentMicrodollars ?? result.spentMicrodollars ?? 0 };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** What a customer's movements are checked against: the CRM, introspected
   *  for that customer, and the one connection it holds. */
  private async catalogFor(tenant: string): Promise<CatalogSnapshot> {
    const { schema } = await introspectAdapter(this.crmFor({ adapterType: 'crm', tenant, credentialsId: credentialRef(tenant) }), this.crm.manifest);
    return buildCatalogSnapshot({
      adapters: [{ manifest: this.crm.manifest, schemas: { [CREDENTIAL]: schema } }],
      credentials: { [CREDENTIAL]: { adapters: ['crm'], credential: 'crm' } },
      plugins: {},
    });
  }

  /** The customer's CRM, loaded in process, over the connection named. */
  private crmFor(input: { adapterType: string; tenant: string; credentialsId: string | undefined }): Adapter {
    const { adapterType, tenant, credentialsId } = input;
    if (adapterType !== 'crm') throw new Error(`no adapter "${adapterType}" here`);
    if (credentialsId === undefined) throw new Error(`the CRM needs a connection`);
    return adapterInProcess(this.crm, {
      tenant,
      credential: secretsCredential({ name: 'crm', ref: credentialsId, secrets: this.secrets }),
      log: quietLog,
      files: refusingFiles('the CRM keeps no files'),
      kv: memoryKv(),
      validateResults: true,
    }).adapter;
  }

  private savedOf(tenant: string): Map<string, SavedMovement> {
    const saved = this.movements.get(tenant);
    if (saved === undefined) throw new Error(`no customer ${tenant}`);
    return saved;
  }
}

function credentialRef(tenant: string): string {
  return `crm:${tenant}`;
}
