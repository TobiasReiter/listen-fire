// System PollSource — the platform's own events, read from what it already
// records: `Run Failed` from the run table, the deploy check's three kinds from
// the stored events it writes (events.ts).
//
// WHY A POLL, NOT A PUSH. A run is marked failed by several independent writers
// (the run recorder, Run now's settle, the interaction failure path, a cancel),
// none of which goes through a shared queue. Hooking each one would be a seam
// per writer and a silent gap the day a fifth appears. The run table is where
// every one of them lands, so a poll over it since a checkpoint catches all of
// them uniformly — at the price of a minute or two of latency, which a failure
// notice can afford.
//
// An automation is never told about its own failures: a handler that fails
// while reporting a failure would otherwise report itself, forever. The worker
// hands the listening automation's id in, and its own runs are skipped (the
// checkpoint still passes them, so they are never reconsidered).

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';
import type { DiscriminableEvent } from 'movement-engine/services/translation_graph/adapter';
import type { PollSource } from '../../poll_source';

import { getAutomationsQb } from '../../../../lib/kysely';
import { eventConfigList } from 'movement-engine/services/translation_graph/triggers/listen_config';
import {
  readStoredSystemEventsFromDb,
  webBaseUrl,
  type StoredEventMark,
  type StoredSystemEvent,
  type StoredSystemEventReader,
} from './events';
import {
  RUN_FAILED,
  RUN_PAUSED,
  SYSTEM_EVENT_KINDS,
  type SystemEventKind,
  type SystemEventPayload,
} from './types';

/** The platform's own table is cheap to read; a failure notice should not wait
 *  five minutes. Overridable per listen with `pollIntervalSeconds`. */
const DEFAULT_POLL_INTERVAL_SECONDS = 60;

/** A run's `failed_at` is stamped before its row commits, so a row can appear
 *  with a time already behind the mark. Reading only rows older than this
 *  keeps the mark behind every write still in flight. */
const SETTLE_MS = 10_000;

/** Rows per poll. More than this waits for the next poll rather than
 *  delivering a flood in one tick. */
const PAGE_SIZE = 100;

/** The lowest run id, for a mark that has no run at its instant yet. */
const NIL_RUN_ID = '00000000-0000-0000-0000-000000000000';

/** Where the last poll stopped: the (failed at, run id) of the last run it
 *  passed. Ordered on both so runs failing in the same millisecond are neither
 *  skipped nor delivered twice. */
export interface RunFailedMark {
  failedAt: string;
  runId: string;
}

export interface SystemCheckpoint {
  runFailed?: RunFailedMark;
  /** One mark across the stored kinds — they share one table and one order. */
  stored?: StoredEventMark;
}

/** The kinds read from the stored events rather than the run table. */
const STORED_KINDS: readonly SystemEventKind[] = SYSTEM_EVENT_KINDS.filter(
  (kind) => kind !== RUN_FAILED,
);

/** One failed run, joined to the automation it belongs to — null for a run
 *  no automation owns (a legacy or simulated run), which the mark still passes
 *  but nothing delivers, since there is nothing to name or link. */
export interface FailedRun {
  runId: string;
  automation: { id: string; name: string } | null;
  reason: string;
  failedAt: Date;
}

/** A failed run that belongs to an automation — the only kind delivered. */
type OwnedFailedRun = FailedRun & { automation: { id: string; name: string } };

/** Reads the team's failed runs strictly after `after`, no later than
 *  `until`, oldest first. The seam tests replace. */
export type FailedRunReader = (input: {
  teamId: TeamId;
  after: RunFailedMark;
  until: Date;
  limit: number;
}) => Promise<FailedRun[]>;

function runFailedMark(checkpoint: unknown): RunFailedMark | undefined {
  const mark = (checkpoint as SystemCheckpoint | null | undefined)?.runFailed;
  return typeof mark?.failedAt === 'string' && typeof mark.runId === 'string' ? mark : undefined;
}

function storedMark(checkpoint: unknown): StoredEventMark | undefined {
  const mark = (checkpoint as SystemCheckpoint | null | undefined)?.stored;
  return typeof mark?.occurredAt === 'string' && typeof mark.id === 'string' ? mark : undefined;
}

/** The kinds a listen selected — `Run Failed` alone when it selected nothing
 *  (the manifest's default). */
function selectedKinds(config: unknown): SystemEventKind[] {
  const selected = eventConfigList((config as { events?: unknown } | null | undefined)?.events);
  if (selected.length === 0) return [RUN_FAILED];
  return SYSTEM_EVENT_KINDS.filter((kind) => selected.includes(kind.displayName));
}

/** The automation's run history, filtered to its failures — the page a person
 *  opens to see this run beside the others. */
export function failedRunsUrl(automationId: string): string {
  return `${webBaseUrl()}/movements/${encodeURIComponent(automationId)}?view=activity&status=failed`;
}

export function runFailedEvent(run: OwnedFailedRun): DiscriminableEvent {
  const at = run.failedAt.toISOString();
  const payload: SystemEventPayload = {
    automation: run.automation.name,
    automationId: run.automation.id,
    runId: run.runId,
    // A failed run's version is not what went wrong; the field is part of the
    // one record shape every kind shares.
    version: '',
    reason: run.reason,
    url: failedRunsUrl(run.automation.id),
    at,
  };
  return {
    payload,
    externalId: run.runId,
    // Per-trigger receipt dedupe: a run is reported to a listener once, even if
    // a crash between dispatch and checkpoint replays the poll.
    idempotencyKey: `${RUN_FAILED.tag}:${run.runId}`,
    tag: RUN_FAILED.tag,
    occurredAt: at,
  };
}

export function storedSystemEvent(event: StoredSystemEvent): DiscriminableEvent | null {
  const kind = STORED_KINDS.find((k) => k.typeId === event.kind);
  if (kind === undefined) return null;
  return {
    payload: event.payload,
    externalId: event.id,
    // Per-trigger receipt dedupe, as for a failed run.
    idempotencyKey: `${kind.tag}:${event.id}`,
    tag: kind.tag,
    occurredAt: event.occurredAt.toISOString(),
  };
}

export class SystemPollSource implements PollSource {
  readonly pollIntervalSeconds = DEFAULT_POLL_INTERVAL_SECONDS;

  constructor(
    private readonly teamId: TeamId,
    /** Injectable for tests; production reads the run table. */
    private readonly readFailedRuns: FailedRunReader = readFailedRunsFromDb,
    private readonly now: () => Date = () => new Date(),
    /** Injectable for tests; production reads the stored events. */
    private readonly readStoredEvents: StoredSystemEventReader = readStoredSystemEventsFromDb,
  ) {}

  async getEvents(input: {
    config: unknown;
    checkpoint?: unknown;
    movementId?: string;
  }): Promise<{ events: DiscriminableEvent[]; checkpoint?: unknown }> {
    const previous = (input.checkpoint ?? {}) as SystemCheckpoint;
    const kinds = selectedKinds(input.config);
    const until = new Date(this.now().getTime() - SETTLE_MS);

    const runFailed = kinds.includes(RUN_FAILED)
      ? await this.pollRunFailed({ mark: runFailedMark(input.checkpoint), until, movementId: input.movementId })
      : { events: [], mark: previous.runFailed };
    const storedKinds = kinds.filter((kind) => kind !== RUN_FAILED);
    const stored =
      storedKinds.length > 0
        ? await this.pollStored({
            kinds: storedKinds,
            mark: storedMark(input.checkpoint),
            until,
            movementId: input.movementId,
          })
        : { events: [], mark: previous.stored };

    return {
      events: [...runFailed.events, ...stored.events],
      checkpoint: {
        ...previous,
        ...(runFailed.mark !== undefined ? { runFailed: runFailed.mark } : {}),
        ...(stored.mark !== undefined ? { stored: stored.mark } : {}),
      },
    };
  }

  private async pollRunFailed(input: {
    mark: RunFailedMark | undefined;
    until: Date;
    movementId: string | undefined;
  }): Promise<{ events: DiscriminableEvent[]; mark: RunFailedMark }> {
    // First poll: set the mark and emit nothing. Going live never replays the
    // failures that happened before anyone was listening.
    if (input.mark === undefined) {
      return { events: [], mark: { failedAt: input.until.toISOString(), runId: NIL_RUN_ID } };
    }

    const runs = await this.readFailedRuns({
      teamId: this.teamId,
      after: input.mark,
      until: input.until,
      limit: PAGE_SIZE,
    });
    const last = runs[runs.length - 1];
    return {
      events: runs
        .filter((run): run is OwnedFailedRun => run.automation !== null)
        .filter((run) => run.automation.id !== input.movementId)
        .map(runFailedEvent),
      mark:
        last === undefined
          ? input.mark
          : { failedAt: last.failedAt.toISOString(), runId: last.runId },
    };
  }

  private async pollStored(input: {
    kinds: readonly SystemEventKind[];
    mark: StoredEventMark | undefined;
    until: Date;
    movementId: string | undefined;
  }): Promise<{ events: DiscriminableEvent[]; mark: StoredEventMark }> {
    // First poll: set the mark and emit nothing, as for failed runs.
    if (input.mark === undefined) {
      return { events: [], mark: { occurredAt: input.until.toISOString(), id: NIL_RUN_ID } };
    }
    // An automation IS told about its own validation issue: unlike a failure,
    // hearing about it cannot produce another one. A pause is like a failure:
    // a handler that paused while reporting a pause would report itself, so an
    // automation is never told about its own runs pausing.
    const events = await this.readStoredEvents({
      teamId: this.teamId,
      kinds: input.kinds.map((kind) => kind.typeId),
      after: input.mark,
      until: input.until,
      limit: PAGE_SIZE,
    });
    const last = events[events.length - 1];
    return {
      events: events.flatMap((event) => {
        if (event.kind === RUN_PAUSED.typeId && event.payload.automationId === input.movementId) return [];
        const discriminable = storedSystemEvent(event);
        return discriminable === null ? [] : [discriminable];
      }),
      mark:
        last === undefined
          ? input.mark
          : { occurredAt: last.occurredAt.toISOString(), id: last.id },
    };
  }
}

/** A run's aggregate errors, as the first message among them. */
function firstErrorMessage(errors: unknown): string | undefined {
  if (!Array.isArray(errors)) return undefined;
  for (const error of errors) {
    const message = (error as { message?: unknown } | null)?.message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return undefined;
}

/** A run row's trigger id is engine-side text; only a uuid can name a trigger
 *  row, so anything else (a legacy or simulated run) has no automation. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const readFailedRunsFromDb: FailedRunReader = async ({ teamId, after, until, limit }) => {
  const afterAt = new Date(after.failedAt);
  const runs = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('team_id', '=', teamId)
    .where('status', '=', 'failed')
    // A rehearsal failing is the author trying something, not an incident.
    .where('dry_run', '=', false)
    .where('failed_at', 'is not', null)
    .where('failed_at', '<=', until)
    .where((eb) =>
      eb.or([
        eb('failed_at', '>', afterAt),
        eb.and([eb('failed_at', '=', afterAt), eb('id', '>', after.runId as TriggerRunId)]),
      ]),
    )
    .select(['id', 'trigger_id', 'failed_at', 'failure_reason', 'errors'])
    .orderBy('failed_at', 'asc')
    .orderBy('id', 'asc')
    .limit(limit)
    .execute();
  if (runs.length === 0) return [];

  const triggerIds = [...new Set(runs.map((r) => r.trigger_id).filter((id) => UUID.test(id)))];
  const triggers =
    triggerIds.length === 0
      ? []
      : await getAutomationsQb(['trigger'])
          .selectFrom('trigger')
          .where('team_id', '=', teamId)
          .where('id', 'in', triggerIds as TriggerId[])
          .where('movement_id', 'is not', null)
          .select(['id', 'movement_id'])
          .execute();
  const movementByTrigger = new Map(
    triggers.map((t) => [t.id as string, t.movement_id as string]),
  );

  const movementIds = [...new Set(movementByTrigger.values())];
  const movements =
    movementIds.length === 0
      ? []
      : await getAutomationsQb(['movement'])
          .selectFrom('movement')
          .where('team_id', '=', teamId)
          .where('id', 'in', movementIds as MovementId[])
          .select(['id', 'name'])
          .execute();
  const nameByMovement = new Map(movements.map((m) => [m.id as string, m.name]));

  return runs.flatMap((run) => {
    // Unreachable (the query requires it), but the column type cannot say so.
    if (run.failed_at === null) return [];
    const automationId = movementByTrigger.get(run.trigger_id);
    const name = automationId === undefined ? undefined : nameByMovement.get(automationId);
    return [
      {
        runId: run.id as string,
        automation:
          automationId !== undefined && name !== undefined ? { id: automationId, name } : null,
        reason:
          run.failure_reason ?? firstErrorMessage(run.errors) ?? 'The run failed without a recorded reason.',
        failedAt: run.failed_at,
      },
    ];
  });
};

/** Factory matching the registry's PollSourceFactory signature. */
export function createSystemPollSource(input: { teamId: TeamId }): SystemPollSource {
  return new SystemPollSource(input.teamId);
}
