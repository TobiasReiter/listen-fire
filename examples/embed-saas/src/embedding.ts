// The engine inside the SaaS's own process: each customer is a tenant with its
// own saved movements, its own CRM records and its own API key; a customer's
// movement is checked when saved and run when one of its events happens. A run
// that waits (`await sleep(1h)`) parks in an in-memory run-host store and is
// stepped on by `tick()` once its time comes. Everything here comes from the
// engine's public entries and the module kit.

import { randomUUID } from 'node:crypto';

import { tenantIdOf, type RunInput } from '@lf/engine-contracts';
import { runMovement, resumeMovement, settleRaceFrame, checkPinnedInRust, parsePinned, type MovementRunResult } from '@lf/engine/public/movement-engine';
import { inProcessHost, introspectAdapter, collectFileListeners, memoryRunHostStore, pricedModels, type FileListener, type ModelClient } from '@lf/engine/public/embed';
import {
  armTimerWake,
  drainDueTimers,
  nextTimerWake,
  parkSources,
  runParkSink,
  withRunLease,
  type RunHost,
  type StepLeaf,
  type StepOutcome,
} from '@lf/engine/public/run-host';
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
  /** `parked`: the run waits (a sleep), and `tick()` steps it on later. */
  outcome: { ok: true; writes: number; spentMicrodollars: number; parked?: true } | { ok: false; error: string };
}

/** A run the SaaS keeps between its segments: what to re-enter it with. */
interface RunRecord {
  tenant: string;
  movement: string;
  input: Omit<RunInput, 'runId'>;
  spentMicrodollars: number;
  status: 'running' | 'parked' | 'completed' | 'failed';
}

type CatalogSnapshot = RunInput['catalog'];

const quietLog: ModuleLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export class Embedding {
  readonly companies = new CompanyStore();
  private readonly crm = crmModule(this.companies);
  private readonly vault: MemoryVault = createMemoryVault();
  private readonly secrets = createSecretsFamily({ backend: this.vault });
  private readonly movements = new Map<string, Map<string, SavedMovement>>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly now: () => Date;
  /** Where parked runs wait: their leaves, joins, timers and pinned texts. */
  private readonly runHost: RunHost;

  constructor(private readonly options: { models?: ModelClient; limits?: Limits; now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
    this.runHost = {
      store: memoryRunHostStore({ now: () => this.now().getTime() }),
      keepers: [],
      runs: {
        cancelRequest: async () => null,
        markFailed: async ({ runId }) => this.settle(runId, 'failed'),
      },
    };
  }

  /** The host one run's segments run against: the SaaS's parts, and the run's
   *  own park sink (a park names no run, so the sink is the run's). */
  private hostFor(runId: string, tenant: string): EngineHost {
    return inProcessHost({
      adapters: { resolve: ({ adapterType, teamId, credentialsId }) => this.crmFor({ adapterType, tenant: teamId, credentialsId }) },
      // A run reaches only its own tenant's connection: the host asks this
      // before it builds an instance for the credential a run names.
      credentials: { belongsTo: ({ teamId, credentialsId }) => credentialsId === credentialRef(teamId) },
      ...(this.options.models !== undefined ? { llm: pricedModels({ client: this.options.models }) } : {}),
      clock: { now: async () => ({ nowIso: this.now().toISOString() }) },
      park: {
        sink: runParkSink(this.runHost, {
          runId,
          teamId: tenant,
          records: { ensureRun: async () => {}, markParked: async () => this.settle(runId, 'parked') },
        }),
        sources: parkSources(this.runHost.store.sources, tenant),
      },
    });
  }

  private settle(runId: string, status: RunRecord['status']): void {
    const run = this.runs.get(runId);
    if (run !== undefined) run.status = status;
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
      now: this.now(),
    });
    const runId = randomUUID();
    const run: RunRecord = {
      tenant,
      movement: movement.name,
      input: {
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
      },
      spentMicrodollars: 0,
      status: 'running',
    };
    this.runs.set(runId, run);
    try {
      const result = await runMovement({ ...run.input, runId, host: this.hostFor(runId, tenant) });
      run.status = result.parked === true ? 'parked' : 'completed';
      return this.ran(run, result);
    } catch (error) {
      run.status = 'failed';
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** What one segment came to, kept on the run. */
  private ran(run: RunRecord, result: MovementRunResult): FiredRun['outcome'] {
    run.spentMicrodollars = result.runSpentMicrodollars ?? run.spentMicrodollars + (result.spentMicrodollars ?? 0);
    return {
      ok: true,
      writes: result.writes.length,
      spentMicrodollars: run.spentMicrodollars,
      ...(result.parked === true ? { parked: true as const } : {}),
    };
  }

  /** Step on every parked run whose timer is due: each under its run lease,
   *  its due leaves resumed, its next timer re-armed. The SaaS calls this from
   *  a scheduler (or the `POST /tick` route). */
  async tick(): Promise<FiredRun[]> {
    const { store } = this.runHost;
    const stepped: FiredRun[] = [];
    for (const work of await store.work.claimDue({ limit: 100, leaseMs: 60_000, dueBy: this.now().toISOString() })) {
      const runId = String(Reflect.get(Object(work.payload), 'runId'));
      const run = this.runs.get(runId);
      if (work.kind !== 'resume_timer' || run === undefined) {
        await store.work.complete(work);
        continue;
      }
      const outcomes: Array<FiredRun['outcome']> = [];
      await withRunLease(store.leases, runId, (lease) =>
        drainDueTimers(this.runHost, { runId, dueBy: this.now().toISOString(), lease, step: this.stepFor(runId, run, outcomes) }),
      );
      await store.work.complete(work);
      const next = await nextTimerWake(this.runHost, { runId });
      if (next !== null) await armTimerWake(store, { runId, teamId: run.tenant, wakeAt: next });
      for (const outcome of outcomes) stepped.push({ movement: run.movement, outcome });
    }
    return stepped;
  }

  /** One parked run's step: a segment re-entered from its leaf (or a race
   *  settled), on the run's own host, its cost counted from what it spent. */
  private stepFor(runId: string, run: RunRecord, outcomes: Array<FiredRun['outcome']>): StepLeaf {
    return async (request, settle): Promise<StepOutcome> => {
      const input = {
        ...run.input,
        runId,
        priorSpentMicrodollars: run.spentMicrodollars,
        state: request.state,
        host: this.hostFor(runId, run.tenant),
      };
      try {
        const result =
          request.kind === 'leaf'
            ? await resumeMovement({ ...input, ...(request.reenter ? { reenter: true } : {}), deferRaceSettlement: request.deferRaceSettlement })
            : await settleRaceFrame({ ...input, frameAddress: request.frameAddress });
        outcomes.push(this.ran(run, result));
        const deferredRaceFrames = result.deferredRaceFrames ?? [];
        if (result.parked === true) return { kind: 'parked', parkedAddress: result.parkedAddress, deferredRaceFrames };
        if (await settle.runComplete()) run.status = 'completed';
        return { kind: 'completed', deferredRaceFrames };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.status = 'failed';
        outcomes.push({ ok: false, error: message });
        return { kind: 'failed', error: message };
      }
    };
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
