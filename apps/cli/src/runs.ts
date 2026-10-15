// A session: one project opened for running — its secrets, externals,
// catalog, files and listens — plus the two entry points every command shares:
// an inbound event routed to the listens it matches and run, and a parked run
// resumed.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CatalogSnapshot, InstanceSchema, LanguageVersion } from 'movement-lang';
import { runMovement, resumeMovement, settleRaceFrame, type MovementRunResult } from 'movement-engine/services/movement_engine/run';
import { runFailureCause, RunLeaseLost } from 'movement-engine/services/movement_engine/errors';
import { withRunLease, type HeldRunLease } from 'movement-engine/services/run_host/lease';
import {
  armTimerWake,
  clearIfQuiescent,
  queueAwaitWake,
  runQuiescent,
  type RunHost,
  type RunRecords,
} from 'movement-engine/services/run_host/rules';
import { afterStep, drainDueTimers, drainRun, nextTimerWake, wakeAwaits, type StepLeaf, type StepOutcome } from 'movement-engine/services/run_host/drain';
import type { ClaimedWork } from 'movement-engine/services/run_host/store';
import { eventMatchesTriggerScope } from 'movement-engine/services/translation_graph/triggers/listen_config';
import { triggerEventOf } from 'movement-engine/services/translation_graph/triggers/trigger_event';
import type { DiscriminableEvent, EventType } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { verifyRemoteSignature } from 'movement-engine/services/webhook_sync/remote_inbound';
import type { CapturedWrite } from 'movement-engine/services/translation_graph/engine/dry_run_adapter';
import { localDocumentStore, type LocalDocumentStore } from './documents';
import {
  credentialFor,
  describeExternal,
  scanExternals,
  startExternals,
  type External,
  type RunningExternal,
} from './externals';
import { neverAsAny } from 'movement-engine/lib/utils/types';
import { LOCAL_TENANT, localHost, tenant } from './host';
import type { Project } from './project';
import { remoteAdapterOf } from './remote';
import { loadSecrets, requireCredentials, type Credential } from './secrets';
import { catalogOf, collectListens, scanMovements, type Listen, type MovementFile } from './sources';
import { LEASE_TTL_MS, State, WorkKind } from './state';

/** lf runs every language version on the Rust engine, and only there: a
 *  program the Rust engine refuses fails with its reason, never falling back
 *  to the TypeScript engine. The engine reads its route from the process
 *  environment, so lf sets it before any run. */
function forceRustEngine(): void {
  process.env.MOVEMENT_ENGINE = 'rust';
  process.env.MOVEMENT_ENGINE_FALLBACK = 'none';
}

export interface Session {
  project: Project;
  state: State;
  /** The run host core over the state: lf supplies only its run records. */
  runHost: RunHost;
  credentials: Map<string, Credential>;
  externals: External[];
  running: Map<string, RunningExternal>;
  documents: LocalDocumentStore;
  files: MovementFile[];
  catalog: CatalogSnapshot;
  listens: Listen[];
  close(): void;
}

/** `LF_CLOCK_AHEAD_MS`: what is due is judged this far ahead of the wall
 *  clock, so a developer (or a test) sees a timer wake without waiting for
 *  it. Leases and the engine's own clock stay on the wall clock. */
function dueClockOffset(env: NodeJS.ProcessEnv): number {
  const raw = env.LF_CLOCK_AHEAD_MS;
  if (raw === undefined || raw === '') return 0;
  const parsed = z.coerce.number().int().nonnegative().safeParse(raw);
  if (!parsed.success) throw new Error(`LF_CLOCK_AHEAD_MS is "${raw}": it must be a whole number of milliseconds`);
  return parsed.data;
}

export async function openSession(
  project: Project,
  options: {
    ephemeral: boolean;
    start: boolean;
    /** Where `lf serve` takes pushes, handed to the externals it starts. */
    hostUrl?: string;
  },
): Promise<Session> {
  forceRustEngine();
  const credentials = loadSecrets(project);
  if (options.start) requireCredentials(project, credentials);
  const externals = scanExternals(project);
  const running = options.start
    ? await startExternals({ project, externals, credentials, tenant: LOCAL_TENANT, ...(options.hostUrl !== undefined ? { hostUrl: options.hostUrl } : {}) })
    : new Map<string, RunningExternal>();
  const state = State.open(project, { ephemeral: options.ephemeral, dueClockOffsetMs: dueClockOffset(process.env) });
  const documents = localDocumentStore(project.lfDir);
  const close = () => {
    for (const r of running.values()) r.stop();
    void documents.close();
    state.close();
  };
  try {
    const schemas = new Map<string, InstanceSchema>();
    for (const [name, r] of running) {
      schemas.set(name, await describeExternal(remoteAdapterOf({ running: r, credential: credentialFor(credentials, name), documents, tenant: LOCAL_TENANT })));
    }
    const files = scanMovements(project);
    const catalog = catalogOf({ running, schemas, credentials, files });
    return {
      project,
      state,
      runHost: { store: state.store, keepers: [], runs: localRunRecords(state) },
      credentials,
      externals,
      running,
      documents,
      files,
      catalog,
      listens: collectListens(files, project.languageVersion),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

/** What lf keeps about a run beyond its live state: its row. lf has no cancel
 *  command, so no run carries a cancel request. */
function localRunRecords(state: State): RunRecords {
  return {
    cancelRequest: async () => null,
    markFailed: async ({ runId, message }) => state.markFailed(runId, message),
  };
}

/** A pre-parsed event file: which external it came from, and the event. */
export const EventFile = z.object({
  external: z.string().min(1),
  event: z.object({ payload: z.unknown() }).passthrough(),
});

export interface RunOutcome {
  runId: string;
  file: string;
  movement: string;
  /** A fresh firing, or a parked run stepped forward. */
  entry: 'fired' | 'resumed';
  /** `leaseLost`: the run's lease lapsed mid-segment; whoever took it over
   *  steps it now, and this entry left its rows as they were. */
  status: 'completed' | 'parked' | 'failed' | 'leaseLost';
  writes: number;
  /** A dry run's writes, captured instead of made. */
  captured?: CapturedWrite[];
  traceEntries: number;
  error?: string;
}

/** The facts a run keeps so it can be resumed against the same program. */
const RunFacts = z.object({
  source: z.string(),
  languageVersion: z.number().int(),
  event: z.unknown(),
  movementName: z.string(),
  firedAt: z.string(),
});

/** Route one event to every listen it matches, and run each. */
export async function fireEvent(
  session: Session,
  input: { external: string; event: DiscriminableEvent; dryRun?: boolean },
): Promise<RunOutcome[]> {
  const eventTypes = await eventTypesOf(session, input.external);
  const matching = session.listens.filter(
    (l) => l.listener.adapter === input.external && eventMatchesTriggerScope(input.event, l.listener.config),
  );
  const outcomes: RunOutcome[] = [];
  for (const listen of matching) {
    const runId = randomUUID();
    const { triggerEvent } = triggerEventOf({
      pipelineInputId: `listen:${listen.file.name}:${listen.listener.movementName}`,
      adapterType: input.external,
      triggerType: 'webhook',
      event: input.event,
      eventTypes,
      now: new Date(),
    });
    outcomes.push(await runListen(session, { runId, listen, event: triggerEvent, dryRun: input.dryRun === true }));
  }
  return outcomes;
}

async function eventTypesOf(session: Session, external: string): Promise<EventType[]> {
  const running = session.running.get(external);
  if (running === undefined || !running.methods.includes('listEventTypes')) return [];
  const adapter = remoteAdapterOf({ running, credential: credentialFor(session.credentials, external), documents: session.documents, tenant: LOCAL_TENANT });
  return adapter.listEventTypes !== undefined ? adapter.listEventTypes() : [];
}

async function runListen(
  session: Session,
  input: { runId: string; listen: Listen; event: TriggerEvent; dryRun: boolean },
): Promise<RunOutcome> {
  const { project, state, runHost } = session;
  const firedAt = new Date().toISOString();
  const facts: z.infer<typeof RunFacts> = {
    source: input.listen.file.source,
    languageVersion: project.languageVersion,
    event: input.event,
    movementName: input.listen.listener.movementName,
    firedAt,
  };
  const run = { runId: input.runId, file: input.listen.file.name, movement: facts.movementName };
  state.startRun({ id: run.runId, file: run.file, movement: run.movement, started_at: firedAt, input: JSON.stringify(facts) });
  // A dry run's writes are captured by the rehearsed instances, never made,
  // and it never parks: it has no wall clock to wait on.
  const captured: CapturedWrite[] = [];
  const tally = { writes: 0, stepped: 0 };
  const held = await withRunLease(runHost.store.leases, run.runId, async (lease) => {
    const fence = { fence: lease.token };
    const host = localHost({
      ...sessionParts(session),
      runId: run.runId,
      ...fence,
      ...(input.dryRun ? { writeSink: (write: CapturedWrite) => captured.push(write) } : {}),
    });
    const outcome = await recordSegment(session, {
      runId: run.runId,
      tally,
      segment: () =>
        runMovement({
          source: facts.source,
          languageVersion: project.languageVersion,
          movementName: facts.movementName,
          event: input.event,
          teamId: tenant(),
          catalog: session.catalog,
          credentialIds: credentialIdsOf(session.catalog),
          firedAt,
          runId: run.runId,
          ...(input.dryRun ? { dryRun: true } : {}),
          host,
        }),
      settle: { runComplete: () => runQuiescent(runHost.store, { runId: run.runId }) },
    });
    if ((await afterStep(runHost, { runId: run.runId, ...fence, outcome })) === 'continue') {
      await clearIfQuiescent(runHost.store, { runId: run.runId, ...fence });
    }
    return outcome.kind === 'leaseLost' ? 'leaseLost' : 'done';
  });
  // A fresh run's row is new: nobody else can hold its lease.
  if (held.kind === 'busy') throw new RunBusy(run.runId);
  const outcome = await settledOutcome(session, { run, entry: 'fired', tally, drained: held.value });
  return input.dryRun ? { ...outcome, captured } : outcome;
}

/** A run whose lease another process holds (it is being stepped there). */
export class RunBusy extends Error {
  constructor(readonly runId: string) {
    super(`run ${runId} is being stepped by another lf process right now; try again in a moment`);
    this.name = 'RunBusy';
  }
}

/** What a run entry has done so far: its writes, and how many segments ran. */
interface Tally {
  writes: number;
  stepped: number;
}

/**
 * Run one segment and record what it came to on the run's row. A segment
 * that throws failed the run (recorded failed; the core tears its live state
 * down), unless what it died of is the run lease, which leaves the run as it
 * is for whoever holds it now. A segment that ran to its end completes the
 * run only when the core says nothing else waits on it.
 */
async function recordSegment(
  session: Session,
  input: { runId: string; tally: Tally; segment: () => Promise<MovementRunResult>; settle: { runComplete(): Promise<boolean> } },
): Promise<StepOutcome> {
  const { state } = session;
  const { runId, tally } = input;
  tally.stepped += 1;
  let result: MovementRunResult;
  try {
    result = await input.segment();
  } catch (error) {
    const cause = runFailureCause(error);
    if (cause instanceof RunLeaseLost) return { kind: 'leaseLost' };
    const message = cause instanceof Error ? cause.message : String(cause);
    state.markFailed(runId, message);
    return { kind: 'failed', error: message };
  }
  tally.writes += result.writes.length;
  const deferredRaceFrames = result.deferredRaceFrames ?? [];
  const at = new Date().toISOString();
  if (result.cancelled === true) return { kind: 'cancelled' };
  if (result.parked === true) {
    state.settleRun(runId, 'parked', { writes: tally.writes }, at);
    return { kind: 'parked', parkedAddress: result.parkedAddress, deferredRaceFrames };
  }
  const complete = await input.settle.runComplete();
  state.settleRun(runId, complete ? 'completed' : 'parked', { writes: tally.writes }, at);
  return { kind: 'completed', deferredRaceFrames };
}

/** A parked run's step for the core's drains, under the lease `lease`. Null
 *  when the run is not parked. */
function parkedStepper(session: Session, runId: string, lease: HeldRunLease): { run: NamedRun; tally: Tally; step: StepLeaf } | null {
  const row = session.state.run(runId);
  if (row === undefined || row.status !== 'parked') return null;
  const facts = RunFacts.parse(JSON.parse(row.input));
  const run = { runId, file: row.file, movement: row.movement };
  const tally = { writes: 0, stepped: 0 };
  const step: StepLeaf = (request, settle) => {
    const resumed = {
      source: facts.source,
      languageVersion: facts.languageVersion as LanguageVersion,
      movementName: facts.movementName,
      event: facts.event as TriggerEvent,
      teamId: tenant(),
      catalog: session.catalog,
      credentialIds: credentialIdsOf(session.catalog),
      firedAt: facts.firedAt,
      runId,
      state: request.state,
      parkedOnEngine: 'rust' as const,
      host: localHost({ ...sessionParts(session), runId, fence: lease.token }),
    };
    return recordSegment(session, {
      runId,
      tally,
      settle,
      segment: () => {
        switch (request.kind) {
          case 'leaf':
            return resumeMovement({ ...resumed, ...(request.reenter ? { reenter: true } : {}), deferRaceSettlement: request.deferRaceSettlement });
          case 'race':
            return settleRaceFrame({ ...resumed, frameAddress: request.frameAddress });
          default:
            return neverAsAny(request);
        }
      },
    });
  };
  return { run, tally, step };
}

type NamedRun = { runId: string; file: string; movement: string };

/** Where a run stands once an entry into it is over, as its row says. A run
 *  still parked re-arms its timer row at its earliest parked timer. */
async function settledOutcome(
  session: Session,
  input: { run: NamedRun; entry: RunOutcome['entry']; tally: Tally; drained: 'done' | 'leaseLost' },
): Promise<RunOutcome> {
  const { state, runHost } = session;
  const { run, entry, tally } = input;
  const row = state.run(run.runId);
  if (row === undefined) throw new Error(`no run ${run.runId}`);
  const base = { ...run, entry, writes: tally.writes, traceEntries: state.trace(run.runId).length };
  if (input.drained === 'leaseLost') return { ...base, status: 'leaseLost' };
  switch (row.status) {
    case 'completed':
      return { ...base, status: 'completed' };
    case 'failed':
      return { ...base, status: 'failed', error: FailedOutcome.parse(JSON.parse(row.outcome ?? 'null')).error };
    case 'parked':
    case 'running': {
      const wakeAt = await nextTimerWake(runHost, { runId: run.runId });
      if (wakeAt !== null) await armTimerWake(runHost.store, { runId: run.runId, teamId: LOCAL_TENANT, wakeAt });
      return { ...base, status: 'parked' };
    }
    default:
      return neverAsAny(row.status);
  }
}

const FailedOutcome = z.object({ error: z.string() }).catch({ error: 'failed' });

/**
 * Step a parked run's leaves through one of the core's drains, under the
 * run's lease. Null when the run is not parked or none of its leaves was
 * stepped; throws `RunBusy` when another process holds the run.
 */
async function driveParkedRun(
  session: Session,
  runId: string,
  drain: (input: { lease: HeldRunLease; step: StepLeaf }) => Promise<'done' | 'leaseLost'>,
): Promise<RunOutcome | null | 'busy'> {
  if (session.state.run(runId) === undefined) throw new Error(`no run ${runId}`);
  const held = await withRunLease(session.runHost.store.leases, runId, async (lease) => {
    const stepper = parkedStepper(session, runId, lease);
    if (stepper === null) return null;
    return { stepper, drained: await drain({ lease, step: stepper.step }) };
  });
  if (held.kind === 'busy') return 'busy';
  if (held.value === null || held.value.stepper.tally.stepped === 0) return null;
  const { stepper, drained } = held.value;
  return settledOutcome(session, { run: stepper.run, entry: 'resumed', tally: stepper.tally, drained });
}

/** Every leaf of the run still parked, now: a timer early, an await
 *  re-entered to re-check live. */
function everyParkedLeaf(session: Session, runId: string) {
  return async ({ lease, step }: { lease: HeldRunLease; step: StepLeaf }) => {
    const leaves = await session.runHost.store.parks.leaves({ runId, parkedOnly: true });
    return drainRun(session.runHost, { runId, leaves: { addresses: leaves.map((l) => l.address) }, lease, step });
  };
}

/** `lf resume <run>`: every parked leaf of the run, now. */
export async function resumeRun(session: Session, runId: string): Promise<RunOutcome> {
  const run = session.state.run(runId);
  if (run === undefined) throw new Error(`no run ${runId}`);
  if (run.status !== 'parked') throw new Error(`run ${runId} is ${run.status}, not parked`);
  const outcome = await driveParkedRun(session, runId, everyParkedLeaf(session, runId));
  if (outcome === 'busy') throw new RunBusy(runId);
  if (outcome === null) throw new Error(`run ${runId} is parked but has no parked leaf`);
  return outcome;
}

/**
 * `lf resume` with no run: drain the due work (events queued, timers due,
 * wakes queued), then step every leaf still parked, now.
 */
export async function resumeAll(session: Session): Promise<RunOutcome[]> {
  const outcomes = await drainWork(session);
  for (const runId of parkedRuns(session)) {
    const outcome = await driveParkedRun(session, runId, everyParkedLeaf(session, runId));
    if (outcome === 'busy') throw new RunBusy(runId);
    if (outcome !== null) outcomes.push(outcome);
  }
  return outcomes;
}

/** Every parked run id. */
export function parkedRuns(session: Session): string[] {
  return session.state.runs(1000).filter((r) => r.status === 'parked').map((r) => r.id);
}

const ResumeTimerPayload = z.object({ runId: z.string() });
const WakeAwaitPayload = z.object({ adapterType: z.string(), teamId: z.string().default(LOCAL_TENANT), correlationKey: z.string() });

/** How long a work row waits before it is tried again: when its run was held
 *  elsewhere, and when it failed. */
const BUSY_RETRY_MS = 5_000;
const FAILED_RETRY_MS = 30_000;

/**
 * Drain the work queue once: every due row is leased, done, and completed
 * (or released for a retry when its run is held elsewhere or it failed). A
 * `fire_event` routes a queued event to its listens; a `resume_timer` steps
 * its run's due timers; a `wake_await` steps every await correlated to its
 * key.
 */
export async function drainWork(session: Session, options: { log?: (line: string) => void } = {}): Promise<RunOutcome[]> {
  const { work } = session.runHost.store;
  const outcomes: RunOutcome[] = [];
  for (const claimed of await work.claimDue({ limit: 100, leaseMs: LEASE_TTL_MS })) {
    try {
      const done = await doWork(session, claimed);
      outcomes.push(...done.outcomes);
      if (done.busy) await work.release({ ...claimed, dueAt: new Date(Date.now() + BUSY_RETRY_MS).toISOString() });
      else await work.complete(claimed);
    } catch (error) {
      options.log?.(`work ${claimed.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      await work.release({ ...claimed, dueAt: new Date(Date.now() + FAILED_RETRY_MS).toISOString() });
    }
  }
  return outcomes;
}

async function doWork(session: Session, claimed: ClaimedWork): Promise<{ busy: boolean; outcomes: RunOutcome[] }> {
  const { runHost, state } = session;
  const kind = WorkKind.parse(claimed.kind);
  switch (kind) {
    case 'fire_event': {
      const { external, event } = EventFile.parse(claimed.payload);
      return { busy: false, outcomes: await fireEvent(session, { external, event: event as DiscriminableEvent }) };
    }
    case 'resume_timer': {
      const { runId } = ResumeTimerPayload.parse(claimed.payload);
      if (state.run(runId) === undefined) return { busy: false, outcomes: [] };
      const outcome = await driveParkedRun(session, runId, ({ lease, step }) =>
        drainDueTimers(runHost, { runId, dueBy: state.dueBy(), lease, step }),
      );
      if (outcome === 'busy') return { busy: true, outcomes: [] };
      return { busy: false, outcomes: outcome === null ? [] : [outcome] };
    }
    case 'wake_await': {
      const wake = WakeAwaitPayload.parse(claimed.payload);
      const stepped: Array<{ run: NamedRun; tally: Tally }> = [];
      const { busy } = await wakeAwaits(runHost, {
        wake,
        stepper: async ({ runId, lease }) => {
          const stepper = parkedStepper(session, runId, lease);
          if (stepper === null) return null;
          stepped.push(stepper);
          return stepper.step;
        },
      });
      const outcomes: RunOutcome[] = [];
      for (const { run, tally } of stepped) {
        if (tally.stepped > 0) outcomes.push(await settledOutcome(session, { run, entry: 'resumed', tally, drained: 'done' }));
      }
      return { busy: busy.length > 0, outcomes };
    }
    default:
      return neverAsAny(kind);
  }
}

function sessionParts(session: Session) {
  return {
    project: session.project,
    state: session.state,
    externals: session.running,
    credentials: session.credentials,
    documents: session.documents,
    runHost: session.runHost,
  };
}

/** A credential's id is its name: the secrets file is keyed by it. */
function credentialIdsOf(catalog: CatalogSnapshot): Record<string, string> {
  return Object.fromEntries(Object.keys(catalog.credentials).map((name) => [name, name]));
}

/**
 * A webhook delivery, exactly as production takes one: the external's
 * signature scheme verifies the raw body with the install's secret, the
 * external parses it into events (`preprocessInbound`), and each event is
 * routed. The install is the credential named in the URL (or the external's
 * only credential).
 */
export async function receiveWebhook(
  session: Session,
  input: { external: string; install?: string; rawBody: Buffer; headers: Record<string, string | undefined> },
): Promise<RunOutcome[]> {
  const running = session.running.get(input.external);
  if (running === undefined) throw new WebhookRefused(404, `no external "${input.external}"`);
  const credential =
    input.install !== undefined ? session.credentials.get(input.install) : credentialFor(session.credentials, input.external);
  if (credential === undefined || credential.external !== input.external) {
    throw new WebhookRefused(404, `no install "${input.install ?? ''}" of external "${input.external}" in the secrets file`);
  }
  const webhook = running.external.manifest.webhook;
  if (webhook === undefined) throw new WebhookRefused(404, `external "${input.external}" takes no webhooks`);
  const signature = input.headers[webhook.header.toLowerCase()] ?? '';
  if (!verifyRemoteSignature(input.rawBody, signature, credential.fields[webhook.secretField] ?? null)) {
    throw new WebhookRefused(401, `signature did not verify for external "${input.external}"`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input.rawBody.toString('utf8'));
  } catch {
    throw new WebhookRefused(400, 'body is not JSON');
  }
  const adapter = remoteAdapterOf({ running, credential, documents: session.documents, tenant: LOCAL_TENANT });
  if (adapter.preprocessInbound === undefined) throw new WebhookRefused(404, `external "${input.external}" parses no inbound events`);
  const parsed = await adapter.preprocessInbound({ raw });
  // The keys this delivery resolves, independent of any listen: a comment on
  // a thread wakes the awaits parked on it whether or not a movement listens
  // for comments.
  if (adapter.wakeKeys !== undefined) {
    for (const correlationKey of await adapter.wakeKeys({ raw })) {
      await queueAwaitWake(session.runHost.store, { adapterType: input.external, teamId: LOCAL_TENANT, correlationKey });
    }
  }
  const outcomes: RunOutcome[] = [];
  for (const event of parsed.events) outcomes.push(...(await fireEvent(session, { external: input.external, event })));
  return outcomes;
}

export class WebhookRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookRefused';
  }
}
