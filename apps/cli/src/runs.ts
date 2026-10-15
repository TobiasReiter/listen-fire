// A session: one project opened for running — its secrets, externals,
// catalog, files and listens — plus the two entry points every command shares:
// an inbound event routed to the listens it matches and run, and a parked run
// resumed.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CatalogSnapshot, InstanceSchema, LanguageVersion } from 'movement-lang';
import type { ParkedScopeState } from 'engine-contracts';
import { runMovement, resumeMovement, type MovementRunResult } from 'movement-engine/services/movement_engine/run';
import { runFailureCause } from 'movement-engine/services/movement_engine/errors';
import { eventMatchesTriggerScope } from 'movement-engine/services/translation_graph/triggers/listen_config';
import { triggerEventOf } from 'movement-engine/services/translation_graph/triggers/trigger_event';
import type { DiscriminableEvent, EventType } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { METHODS } from 'engine-contracts';
import { parseWireResult } from 'movement-engine/services/translation_graph/protocol/client';
import { verifyRemoteSignature } from 'movement-engine/services/webhook_sync/remote_inbound';
import {
  credentialFor,
  describeExternal,
  rpc,
  scanExternals,
  startExternals,
  type External,
  type RunningExternal,
} from './externals';
import { neverAsAny } from 'movement-engine/lib/utils/types';
import { LOCAL_TENANT, localHost, tenant } from './host';
import { enqueueAwaitWake, timerWorkKey } from './parks';
import type { Project } from './project';
import { loadSecrets, requireCredentials, type Credential } from './secrets';
import { catalogOf, collectListens, scanMovements, type Listen, type MovementFile } from './sources';
import { LEASE_TTL_MS, State, type ClaimedWork, type ParkRow } from './state';

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
  credentials: Map<string, Credential>;
  externals: External[];
  running: Map<string, RunningExternal>;
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
  const close = () => {
    for (const r of running.values()) r.stop();
    state.close();
  };
  try {
    const schemas = new Map<string, InstanceSchema>();
    for (const [name, r] of running) {
      schemas.set(name, await describeExternal({ running: r, credential: credentialFor(credentials, name), tenant: LOCAL_TENANT }));
    }
    const files = scanMovements(project);
    const credentialed = new Set(externals.filter((e) => e.manifest.auth !== undefined).map((e) => e.manifest.name));
    const catalog = catalogOf({ schemas, credentials, credentialed, files });
    return {
      project,
      state,
      credentials,
      externals,
      running,
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
  status: 'completed' | 'parked' | 'failed';
  writes: number;
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
export async function fireEvent(session: Session, input: { external: string; event: DiscriminableEvent }): Promise<RunOutcome[]> {
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
    outcomes.push(await runListen(session, { runId, listen, event: triggerEvent }));
  }
  return outcomes;
}

async function eventTypesOf(session: Session, external: string): Promise<EventType[]> {
  const running = session.running.get(external);
  if (running === undefined || !running.methods.includes('listEventTypes')) return [];
  const raw = await rpc({ running, credential: credentialFor(session.credentials, external), method: 'listEventTypes', params: {}, tenant: LOCAL_TENANT });
  return parseWireResult(METHODS.listEventTypes.result, raw, { method: 'listEventTypes', adapter: external });
}

async function runListen(session: Session, input: { runId: string; listen: Listen; event: TriggerEvent }): Promise<RunOutcome> {
  const { project, state } = session;
  const firedAt = new Date().toISOString();
  const facts: z.infer<typeof RunFacts> = {
    source: input.listen.file.source,
    languageVersion: project.languageVersion,
    event: input.event,
    movementName: input.listen.listener.movementName,
    firedAt,
  };
  state.startRun({ id: input.runId, file: input.listen.file.name, movement: facts.movementName, started_at: firedAt, input: JSON.stringify(facts) });
  const host = localHost({ ...sessionParts(session), runId: input.runId });
  return settle(session, { runId: input.runId, file: input.listen.file.name, movement: facts.movementName }, () =>
    runMovement({
      source: facts.source,
      languageVersion: project.languageVersion,
      movementName: facts.movementName,
      event: input.event,
      teamId: tenant(),
      catalog: session.catalog,
      credentialIds: credentialIdsOf(session.catalog),
      firedAt,
      runId: input.runId,
      host,
    }),
  );
}

/** A fresh firing, run under its run's lease. */
async function settle(
  session: Session,
  run: { runId: string; file: string; movement: string },
  go: () => Promise<MovementRunResult>,
): Promise<RunOutcome> {
  const stepped = await withRunLease(session.state, run.runId, async () => {
    let result: MovementRunResult;
    try {
      result = await go();
    } catch (error) {
      return failRun(session, run, error);
    }
    return settleStep(session, run, { writes: result.writes.length });
  });
  // A fresh run's row is new: nobody else can hold its lease.
  if (stepped.kind === 'busy') throw new RunBusy(run.runId);
  return stepped.value;
}

/** A run whose lease another process holds (it is being stepped there). */
export class RunBusy extends Error {
  constructor(readonly runId: string) {
    super(`run ${runId} is being stepped by another lf process right now; try again in a moment`);
    this.name = 'RunBusy';
  }
}

/** Step `runId` while holding its lease: one process steps a run at a time,
 *  whichever lf (`serve`, `resume`) asks. */
async function withRunLease<T>(state: State, runId: string, step: () => Promise<T>): Promise<{ kind: 'held'; value: T } | { kind: 'busy' }> {
  const lease = state.claimRunLease(runId);
  if (lease === null) return { kind: 'busy' };
  const renew = setInterval(() => state.renewRunLease(runId, lease.token), LEASE_TTL_MS / 3);
  renew.unref();
  try {
    return { kind: 'held', value: await step() };
  } finally {
    clearInterval(renew);
    state.releaseRunLease(runId, lease.token);
  }
}

/** Which of a parked run's leaves a step resumes. */
type LeafChoice = { kind: 'every' } | { kind: 'dueTimers' } | { kind: 'addresses'; addresses: readonly string[] };

function leavesOf(state: State, runId: string, choice: LeafChoice): ParkRow[] {
  switch (choice.kind) {
    case 'every':
      return state.parks(runId).filter((p) => p.status === 'parked');
    case 'dueTimers':
      return state.dueTimerParks(runId);
    case 'addresses':
      return state.parks(runId).filter((p) => p.status === 'parked' && choice.addresses.includes(p.address));
    default:
      return neverAsAny(choice);
  }
}

/**
 * Continue a parked run: each chosen leaf is claimed, then resumed. A timer
 * steps past its sleep (an `until` re-checks); an await or a suspension
 * re-enters to re-check live. The claimed row goes once its step is over,
 * unless the step parked again at the same address. The run is complete only
 * when no join waits and no leaf is left parked. Null when the run is not
 * parked or none of the chosen leaves is.
 */
async function stepParkedRun(session: Session, runId: string, choice: LeafChoice): Promise<RunOutcome | null> {
  const { state } = session;
  const run = state.run(runId);
  if (run === undefined) throw new Error(`no run ${runId}`);
  if (run.status !== 'parked') return null;
  const leaves = leavesOf(state, runId, choice);
  if (leaves.length === 0) return null;
  const facts = RunFacts.parse(JSON.parse(run.input));
  const named = { runId, file: run.file, movement: run.movement };
  state.markRunning(runId);
  let writes = 0;
  for (const leaf of leaves) {
    const claimed = state.claimPark(runId, leaf.address);
    if (claimed === null) continue;
    const parkedState = JSON.parse(claimed.state) as ParkedScopeState;
    const reenter = claimed.kind !== 'timer' || parkedState.until === true;
    let result: MovementRunResult;
    try {
      result = await resumeMovement({
        source: facts.source,
        languageVersion: facts.languageVersion as LanguageVersion,
        movementName: facts.movementName,
        event: facts.event as TriggerEvent,
        teamId: tenant(),
        catalog: session.catalog,
        credentialIds: credentialIdsOf(session.catalog),
        firedAt: facts.firedAt,
        runId,
        state: parkedState,
        parkedOnEngine: 'rust',
        ...(reenter ? { reenter: true } : {}),
        host: localHost({ ...sessionParts(session), runId }),
      });
    } catch (error) {
      return failRun(session, named, error);
    }
    writes += result.writes.length;
    state.finishPark(runId, leaf.address);
  }
  return settleStep(session, named, { writes });
}

/** Where a run stands once a segment is over: complete when nothing waits on
 *  it (its joins cleared), parked otherwise, with its next timer armed. */
function settleStep(session: Session, run: { runId: string; file: string; movement: string }, input: { writes: number }): RunOutcome {
  const { state } = session;
  const at = new Date().toISOString();
  if (state.runQuiescent(run.runId)) {
    state.clearJoins(run.runId);
    state.settleRun(run.runId, 'completed', { writes: input.writes }, at);
    return { ...run, status: 'completed', writes: input.writes, traceEntries: state.trace(run.runId).length };
  }
  state.settleRun(run.runId, 'parked', { writes: input.writes }, at);
  const nextWake = state.nextTimerWake(run.runId);
  if (nextWake !== null) state.enqueue({ kind: 'resume_timer', key: timerWorkKey(run.runId), payload: { runId: run.runId }, dueAt: nextWake });
  return { ...run, status: 'parked', writes: input.writes, traceEntries: state.trace(run.runId).length };
}

/** An error anywhere fails the whole run: its leaves and joins go (nothing
 *  will resume them); the writes it made stand. */
function failRun(session: Session, run: { runId: string; file: string; movement: string }, error: unknown): RunOutcome {
  const cause = runFailureCause(error);
  const message = cause instanceof Error ? cause.message : String(cause);
  session.state.dropRunLeaves(run.runId);
  session.state.settleRun(run.runId, 'failed', { error: message }, new Date().toISOString());
  return { ...run, status: 'failed', writes: 0, traceEntries: session.state.trace(run.runId).length, error: message };
}

/** `lf resume <run>`: every parked leaf of the run, now (a timer early). */
export async function resumeRun(session: Session, runId: string): Promise<RunOutcome> {
  const run = session.state.run(runId);
  if (run === undefined) throw new Error(`no run ${runId}`);
  if (run.status !== 'parked') throw new Error(`run ${runId} is ${run.status}, not parked`);
  const stepped = await withRunLease(session.state, runId, () => stepParkedRun(session, runId, { kind: 'every' }));
  if (stepped.kind === 'busy') throw new RunBusy(runId);
  if (stepped.value === null) throw new Error(`run ${runId} is parked but has no parked leaf`);
  return stepped.value;
}

/**
 * `lf resume` with no run: drain the due work (timers due, wakes queued),
 * then step every leaf still parked, now — a timer early, an await
 * re-entered to re-check live.
 */
export async function resumeAll(session: Session): Promise<RunOutcome[]> {
  const outcomes = await drainWork(session);
  for (const runId of parkedRuns(session)) {
    const stepped = await withRunLease(session.state, runId, () => stepParkedRun(session, runId, { kind: 'every' }));
    if (stepped.kind === 'busy') throw new RunBusy(runId);
    if (stepped.value !== null) outcomes.push(stepped.value);
  }
  return outcomes;
}

/** Every parked run id. */
export function parkedRuns(session: Session): string[] {
  return session.state.runs(1000).filter((r) => r.status === 'parked').map((r) => r.id);
}

const ResumeTimerPayload = z.object({ runId: z.string() });
const WakeAwaitPayload = z.object({ adapterType: z.string(), correlationKey: z.string() });

/** How long a work row waits before it is tried again: when its run was held
 *  elsewhere, and when it failed. */
const BUSY_RETRY_MS = 5_000;
const FAILED_RETRY_MS = 30_000;

/**
 * Drain the work queue once: every due row is leased, done, and completed
 * (or released for a retry when its run is held elsewhere or it failed). A
 * `resume_timer` steps its run's due timers; a `wake_await` steps every
 * await parked on its key.
 */
export async function drainWork(session: Session, options: { log?: (line: string) => void } = {}): Promise<RunOutcome[]> {
  const { state } = session;
  const outcomes: RunOutcome[] = [];
  for (const work of state.claimDue()) {
    try {
      const done = await doWork(session, work);
      outcomes.push(...done.outcomes);
      if (done.busy) state.releaseWork({ ...work, dueAt: new Date(Date.now() + BUSY_RETRY_MS).toISOString() });
      else state.completeWork(work);
    } catch (error) {
      options.log?.(`work ${work.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      state.releaseWork({ ...work, dueAt: new Date(Date.now() + FAILED_RETRY_MS).toISOString() });
    }
  }
  return outcomes;
}

async function doWork(session: Session, work: ClaimedWork): Promise<{ busy: boolean; outcomes: RunOutcome[] }> {
  switch (work.kind) {
    case 'resume_timer': {
      const { runId } = ResumeTimerPayload.parse(work.payload);
      if (session.state.run(runId) === undefined) return { busy: false, outcomes: [] };
      const stepped = await withRunLease(session.state, runId, () => stepParkedRun(session, runId, { kind: 'dueTimers' }));
      if (stepped.kind === 'busy') return { busy: true, outcomes: [] };
      return { busy: false, outcomes: stepped.value === null ? [] : [stepped.value] };
    }
    case 'wake_await': {
      const wake = WakeAwaitPayload.parse(work.payload);
      const byRun = new Map<string, string[]>();
      for (const park of session.state.awaitParks(wake)) byRun.set(park.run_id, [...(byRun.get(park.run_id) ?? []), park.address]);
      let busy = false;
      const outcomes: RunOutcome[] = [];
      for (const [runId, addresses] of byRun) {
        const stepped = await withRunLease(session.state, runId, () => stepParkedRun(session, runId, { kind: 'addresses', addresses }));
        if (stepped.kind === 'busy') busy = true;
        else if (stepped.value !== null) outcomes.push(stepped.value);
      }
      return { busy, outcomes };
    }
    default:
      return neverAsAny(work.kind);
  }
}

function sessionParts(session: Session) {
  return {
    project: session.project,
    state: session.state,
    externals: session.running,
    credentials: session.credentials,
    engine: 'rust' as const,
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
  const parsed = parseWireResult(
    METHODS.preprocessInbound.result,
    await rpc({ running, credential, method: 'preprocessInbound', params: { raw }, tenant: LOCAL_TENANT }),
    { method: 'preprocessInbound', adapter: input.external },
  );
  // The keys this delivery resolves, independent of any listen: a comment on
  // a thread wakes the awaits parked on it whether or not a movement listens
  // for comments.
  if (running.methods.includes('wakeKeys')) {
    const keys = parseWireResult(
      METHODS.wakeKeys.result,
      await rpc({ running, credential, method: 'wakeKeys', params: { raw }, tenant: LOCAL_TENANT }),
      { method: 'wakeKeys', adapter: input.external },
    );
    for (const correlationKey of keys) enqueueAwaitWake(session.state, { adapterType: input.external, correlationKey });
  }
  const outcomes: RunOutcome[] = [];
  for (const event of parsed.events) outcomes.push(...(await fireEvent(session, { external: input.external, event: event as DiscriminableEvent })));
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
