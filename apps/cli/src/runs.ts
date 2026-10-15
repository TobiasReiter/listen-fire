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
import { LOCAL_TENANT, localHost, tenant } from './host';
import type { Project } from './project';
import { remoteAdapterOf } from './remote';
import { loadSecrets, type Credential } from './secrets';
import { catalogOf, collectListens, scanMovements, type Listen, type MovementFile } from './sources';
import { State } from './state';

/** Which engine runs a language version: 5 and later on Rust, 1–4 on TypeScript. */
function engineFor(languageVersion: LanguageVersion): 'rust' | 'ts' {
  return languageVersion >= 5 ? 'rust' : 'ts';
}

export interface Session {
  project: Project;
  state: State;
  credentials: Map<string, Credential>;
  externals: External[];
  running: Map<string, RunningExternal>;
  documents: LocalDocumentStore;
  files: MovementFile[];
  catalog: CatalogSnapshot;
  listens: Listen[];
  close(): void;
}

export async function openSession(project: Project, options: { ephemeral: boolean; start: boolean }): Promise<Session> {
  // Every run takes the engine its pinned language version runs on.
  process.env.MOVEMENT_ENGINE ??= 'by-version';
  const credentials = loadSecrets(project);
  const externals = scanExternals(project);
  const running = options.start
    ? await startExternals({ project, externals, credentials, tenant: LOCAL_TENANT })
    : new Map<string, RunningExternal>();
  const state = State.open(project, { ephemeral: options.ephemeral });
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
  status: 'completed' | 'parked' | 'failed';
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
  // A dry run's writes are captured by the rehearsed instances, never made,
  // and it never parks: it has no wall clock to wait on.
  const captured: CapturedWrite[] = [];
  const host = localHost({
    ...sessionParts(session),
    runId: input.runId,
    ...(input.dryRun ? { writeSink: (write: CapturedWrite) => captured.push(write) } : {}),
  });
  const outcome = await settle(session, { runId: input.runId, file: input.listen.file.name, movement: facts.movementName }, () =>
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
      ...(input.dryRun ? { dryRun: true } : {}),
      host,
    }),
  );
  return input.dryRun ? { ...outcome, captured } : outcome;
}

/**
 * Continue a parked run: each of its parks, in order. A timer park is resumed
 * now whatever its wake time (one-shot `lf resume` does not wait); an await
 * park re-enters to re-check its condition live.
 */
export async function resumeRun(session: Session, runId: string): Promise<RunOutcome> {
  const { state } = session;
  const run = state.run(runId);
  if (run === undefined) throw new Error(`no run ${runId}`);
  if (run.status !== 'parked') throw new Error(`run ${runId} is ${run.status}, not parked`);
  const facts = RunFacts.parse(JSON.parse(run.input));
  const parks = state.parks(runId);
  if (parks.length === 0) throw new Error(`run ${runId} is parked but has no park recorded`);
  let outcome: RunOutcome | undefined;
  for (const park of parks) {
    state.dropPark(park.id);
    state.markRunning(runId);
    const parkedState = JSON.parse(park.state) as ParkedScopeState;
    const host = localHost({ ...sessionParts(session), runId });
    outcome = await settle(session, { runId, file: run.file, movement: run.movement }, () =>
      resumeMovement({
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
        parkedOnEngine: park.engine === 'ts' ? 'ts' : 'rust',
        ...(park.kind === 'await' || parkedState.until === true ? { reenter: true } : {}),
        host,
      }),
    );
  }
  if (outcome === undefined) throw new Error(`run ${runId}: nothing resumed`);
  return outcome;
}

/** Every parked run id. */
export function parkedRuns(session: Session): string[] {
  return session.state.runs(1000).filter((r) => r.status === 'parked').map((r) => r.id);
}

async function settle(
  session: Session,
  run: { runId: string; file: string; movement: string },
  go: () => Promise<MovementRunResult>,
): Promise<RunOutcome> {
  const at = new Date().toISOString();
  try {
    const result = await go();
    const status = result.parked === true ? 'parked' : 'completed';
    session.state.settleRun(run.runId, status, { writes: result.writes, parkedAddress: result.parkedAddress }, at);
    return { ...run, status, writes: result.writes.length, traceEntries: session.state.trace(run.runId).length };
  } catch (error) {
    const cause = runFailureCause(error);
    const message = cause instanceof Error ? cause.message : String(cause);
    session.state.settleRun(run.runId, 'failed', { error: message }, at);
    return { ...run, status: 'failed', writes: 0, traceEntries: session.state.trace(run.runId).length, error: message };
  }
}

function sessionParts(session: Session) {
  return {
    project: session.project,
    state: session.state,
    externals: session.running,
    credentials: session.credentials,
    documents: session.documents,
    engine: engineFor(session.project.languageVersion),
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
