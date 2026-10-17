// A session: one project opened for running — its secrets, externals,
// catalog, files and listens — plus the entry points every command shares:
// an inbound event routed to the listens it matches and run, a parked run
// resumed, a callback called, and a run cancelled.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CatalogSnapshot, InstanceSchema } from 'movement-lang';
import { fireCallbackBody, runMovement, resumeMovement, settleRaceFrame, type MovementRunResult } from 'movement-engine/services/movement_engine/run';
import type { AnyParkedScopeState } from 'engine-contracts';
import { runFailureCause, RunLeaseLost } from 'movement-engine/services/movement_engine/errors';
import { withRunLease, type HeldRunLease } from 'movement-engine/services/run_host/lease';
import {
  armTimerWake,
  clearIfQuiescent,
  queueAwaitWake,
  runQuiescent,
  settleIfCancelRequested,
  type RunHost,
} from 'movement-engine/services/run_host/rules';
import {
  CallbackBodyPayload,
  callbackAwaitKeeper,
  callbackBodyWork,
  recordCallbackCall,
  runCallbackBody,
  type CallbackBodyOutcome,
  type CallbackCallOutcome,
} from 'movement-engine/services/run_host/callbacks';
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
import { localRunRecords } from './parks';
import { refuseBelowLf, type Project } from './project';
import { remoteAdapterOf } from './remote';
import { loadSecrets, requireCredentials, type Credential } from './secrets';
import { catalogOf, collectListens, scanMovements, type Listen, type MovementFile } from './sources';
import { LEASE_TTL_MS, State, WorkKind, type RunRow } from './state';

export interface Session {
  project: Project;
  state: State;
  /** The run host core over the state: lf supplies only its run records. */
  runHost: RunHost;
  /** Where lf is reached from outside: a callback's url is under it. */
  publicUrl: string;
  credentials: Map<string, Credential>;
  externals: External[];
  running: Map<string, RunningExternal>;
  documents: LocalDocumentStore;
  files: MovementFile[];
  catalog: CatalogSnapshot;
  listens: Listen[];
  close(): void;
}

/** Where `lf serve` listens unless told otherwise. */
export const DEFAULT_PORT = 4400;

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
      // A plugin external has no graph to describe; its plugins are its manifest's.
      if (r.external.manifest.kind === 'plugin') continue;
      schemas.set(name, await describeExternal(remoteAdapterOf({ running: r, credential: credentialFor(credentials, name), documents, tenant: LOCAL_TENANT })));
    }
    const files = scanMovements(project);
    const catalog = catalogOf({ running, schemas, credentials, files });
    return {
      project,
      state,
      runHost: { store: state.store, keepers: [callbackAwaitKeeper(state.store, state.callbacks)], runs: localRunRecords(state) },
      publicUrl: project.publicUrl ?? options.hostUrl ?? `http://127.0.0.1:${DEFAULT_PORT}`,
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

/** A pre-parsed event file: which external it came from, and the event. */
export const EventFile = z.object({
  external: z.string().min(1),
  event: z.object({ payload: z.unknown() }).passthrough(),
});

export interface RunOutcome {
  runId: string;
  file: string;
  movement: string;
  /** A fresh firing, a parked run stepped forward, or a callback's body run
   *  (`error`: the body failed; the run carries on). */
  entry: 'fired' | 'resumed' | 'called';
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
  if (result.cancelled === true) return cancelledOutcome(state, runId);
  if (result.parked === true) {
    state.settleRun(runId, 'parked', { writes: tally.writes }, at);
    return { kind: 'parked', parkedAddress: result.parkedAddress, deferredRaceFrames };
  }
  const complete = await input.settle.runComplete();
  state.settleRun(runId, complete ? 'completed' : 'parked', { writes: tally.writes }, at);
  return { kind: 'completed', deferredRaceFrames };
}

/** An operator's cancel stopped the segment: the reason they gave. */
function cancelledOutcome(state: State, runId: string): StepOutcome {
  const reason = state.cancelRequest(runId)?.reason;
  return { kind: 'cancelled', ...(reason != null ? { reason } : {}) };
}

/** What every entry into a parked run's program shares: the run's own facts
 *  (its pinned source and event, its first firing's instant) and this
 *  session's catalog and host, under the lease `lease`. */
function reentryOf(session: Session, input: { runId: string; facts: z.infer<typeof RunFacts>; lease: HeldRunLease }) {
  const { runId, facts, lease } = input;
  return {
    source: facts.source,
    languageVersion: facts.languageVersion,
    movementName: facts.movementName,
    event: facts.event as TriggerEvent,
    teamId: tenant(),
    catalog: session.catalog,
    credentialIds: credentialIdsOf(session.catalog),
    firedAt: facts.firedAt,
    runId,
    parkedOnEngine: 'rust' as const,
    host: localHost({ ...sessionParts(session), runId, fence: lease.token }),
  };
}

/** A run's facts, refused when its pin is one lf does not run. */
function runFactsOf(row: RunRow): z.infer<typeof RunFacts> {
  const facts = RunFacts.parse(JSON.parse(row.input));
  // An earlier lf ran versions below 5 on the Rust engine; this one hands
  // them to no engine (the engine would route them to TypeScript).
  refuseBelowLf(facts.languageVersion, {
    pinned: `run ${row.id}`,
    remedy: 'it cannot resume; run `lf upgrade` and fire it again',
  });
  return facts;
}

/** A parked run's step for the core's drains, under the lease `lease`. Null
 *  when the run is not parked. */
function parkedStepper(session: Session, runId: string, lease: HeldRunLease): { run: NamedRun; tally: Tally; step: StepLeaf } | null {
  const row = session.state.run(runId);
  if (row === undefined || row.status !== 'parked') return null;
  const facts = runFactsOf(row);
  const run = { runId, file: row.file, movement: row.movement };
  const tally = { writes: 0, stepped: 0 };
  const step: StepLeaf = (request, settle) => {
    const resumed = { ...reentryOf(session, { runId, facts, lease }), state: request.state };
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
    case 'fire_callback': {
      const { callbackId, callIndex } = CallbackBodyPayload.parse(claimed.payload);
      const ran = await runRecordedBody(session, { callbackId, callIndex });
      if (ran.kind !== 'ran') return { busy: ran.kind === 'busy', outcomes: [] };
      return { busy: false, outcomes: ran.outcomes };
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
    publicUrl: session.publicUrl,
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

// ── Callbacks ───────────────────────────────────────────────────────────────

/** How long after a call its durable rows (its body's, its awaiters' wake)
 *  come due. Its body runs at once when the run is free; the rows matter only
 *  if this process dies first, so they wait well past a normal body. */
const CALLBACK_BACKSTOP_MS = 30_000;

export interface CallOutcome {
  call: CallbackCallOutcome;
  /** The run was being stepped elsewhere: the body waits on its work row,
   *  due now, for whichever lf process drains next. */
  queued: boolean;
  outcomes: RunOutcome[];
}

/**
 * Call a callback: validate and record the call (its body queued with it),
 * then run the body now under the run's lease and wake whatever awaits the
 * callback. The door (`POST /api/cb/<id>`) and `lf call` both come here.
 */
export async function callCallback(session: Session, input: { id: string; values: Record<string, unknown> }): Promise<CallOutcome> {
  const backstop = new Date(Date.now() + CALLBACK_BACKSTOP_MS).toISOString();
  const call = await recordCallbackCall(session.runHost, session.state.callbacks, {
    id: input.id,
    values: input.values,
    bodyDueAt: backstop,
    wakeDueAt: backstop,
  });
  if (call.kind !== 'recorded') return { call, queued: false, outcomes: [] };
  const ran = await runRecordedBody(session, { callbackId: call.callback.id, callIndex: call.callIndex });
  if (ran.kind === 'ran') return { call, queued: false, outcomes: ran.outcomes };
  if (ran.kind === 'refused') return { call, queued: false, outcomes: [] };
  // Held elsewhere: its row, due now, runs it once the run is free.
  await session.runHost.store.work.enqueue(
    callbackBodyWork({ callbackId: call.callback.id, teamId: call.callback.teamId, callIndex: call.callIndex, dueAt: new Date().toISOString() }),
  );
  return { call, queued: true, outcomes: [] };
}

type RecordedBodyRun = { kind: 'ran'; outcomes: RunOutcome[] } | { kind: 'busy' } | { kind: 'refused'; reason: string };

/** Run one recorded call's body under its run's lease, then the awaits it
 *  resolves. `busy` when another process holds the run, or the lease went
 *  before the body began: the body is left to its work row. */
async function runRecordedBody(session: Session, input: { callbackId: string; callIndex: number }): Promise<RecordedBodyRun> {
  const { state, runHost } = session;
  const callback = await state.callbacks.get({ id: input.callbackId });
  if (callback === null) return { kind: 'refused', reason: 'its callback is gone' };
  const row = state.run(callback.runId);
  if (row === undefined) return { kind: 'refused', reason: 'its run is gone' };
  const run = { runId: row.id, file: row.file, movement: row.movement };
  const held = await withRunLease(runHost.store.leases, run.runId, async (lease) => {
    const facts = runFactsOf(row);
    const tally = { writes: 0, stepped: 0 };
    const stepped: Array<{ run: NamedRun; tally: Tally }> = [];
    let failure: string | undefined;
    const ran = await runCallbackBody(runHost, state.callbacks, {
      id: input.callbackId,
      callIndex: input.callIndex,
      lease,
      now: new Date().toISOString(),
      runOpen: async (runId) => {
        const status = state.run(runId)?.status;
        return status === 'parked' || status === 'running';
      },
      body: async ({ callback: minted, values }) => {
        const outcome = await callbackBodySegment(session, { ...run, facts, lease, tally, state: minted.state, values, callIndex: input.callIndex });
        if (outcome.kind === 'failed') failure = outcome.error;
        return outcome;
      },
      stepper: async ({ runId, lease: held }) => {
        const stepper = parkedStepper(session, runId, held);
        if (stepper === null) return null;
        stepped.push(stepper);
        return stepper.step;
      },
    });
    return { ran, tally, stepped, failure };
  });
  if (held.kind === 'busy') return { kind: 'busy' };
  const { ran, tally, stepped, failure } = held.value;
  if (ran.kind === 'not_started') return { kind: 'busy' };
  if (ran.kind === 'refused') return ran;
  const drained = ran.outcome.kind === 'leaseLost' ? 'leaseLost' : 'done';
  const called = await settledOutcome(session, { run, entry: 'called', tally, drained });
  const outcomes = [failure !== undefined ? { ...called, error: `the callback's body failed: ${failure}` } : called];
  for (const s of stepped) {
    if (s.tally.stepped > 0) outcomes.push(await settledOutcome(session, { run: s.run, entry: 'resumed', tally: s.tally, drained: 'done' }));
  }
  return { kind: 'ran', outcomes };
}

/** A callback's body: one engine segment entered at the callback, with the
 *  call's values. A body that fails fails its segment, never the run. */
async function callbackBodySegment(
  session: Session,
  input: NamedRun & {
    facts: z.infer<typeof RunFacts>;
    lease: HeldRunLease;
    tally: Tally;
    state: unknown;
    values: Record<string, unknown>;
    callIndex: number;
  },
): Promise<CallbackBodyOutcome> {
  if (!isParkState(input.state)) return { kind: 'failed', error: 'the callback holds no state to run its body from' };
  input.tally.stepped += 1;
  try {
    const result = await fireCallbackBody({
      ...reentryOf(session, { runId: input.runId, facts: input.facts, lease: input.lease }),
      state: input.state,
      values: input.values,
      callIndex: input.callIndex,
    });
    input.tally.writes += result.writes.length;
    if (result.cancelled === true) {
      const reason = session.state.cancelRequest(input.runId)?.reason;
      return { kind: 'cancelled', ...(reason != null ? { reason } : {}) };
    }
    return { kind: 'ran' };
  } catch (error) {
    const cause = runFailureCause(error);
    if (cause instanceof RunLeaseLost) return { kind: 'leaseLost' };
    return { kind: 'failed', error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** A park state as the engine reads it: the engine re-validates the shape
 *  and refuses a version it does not read. */
function isParkState(value: unknown): value is AnyParkedScopeState {
  return typeof value === 'object' && value !== null && typeof (value as { version?: unknown }).version === 'number';
}

// ── Cancel ──────────────────────────────────────────────────────────────────

export type CancelOutcome =
  /** The run was not being stepped: it is settled failed now. */
  | { kind: 'cancelled' }
  /** Another lf process is stepping it: its segment stops at the next
   *  statement boundary, and the run settles failed there. */
  | { kind: 'requested' };

/**
 * `lf cancel <run>`: stamp the operator's request on the run's row, then
 * settle it through the core's cancel path (failed with the reason, its live
 * state torn down, its callbacks revoked) when no one holds it. A run being
 * stepped elsewhere reads the stamp at its next boundary.
 */
export async function cancelRun(session: Session, input: { runId: string; reason: string | null }): Promise<CancelOutcome> {
  const { state, runHost } = session;
  const row = state.run(input.runId);
  if (row === undefined) throw new Error(`no run ${input.runId}`);
  if (!state.requestCancel(input.runId, input.reason)) throw new Error(`run ${input.runId} is ${row.status}; there is nothing to cancel`);
  const held = await withRunLease(runHost.store.leases, input.runId, (lease) => settleIfCancelRequested(runHost, { runId: input.runId, fence: lease.token }));
  return held.kind === 'busy' ? { kind: 'requested' } : { kind: 'cancelled' };
}
