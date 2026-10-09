// The platform events that no other table records — written here by whatever
// produces them (the deploy check; a run pausing at its cost limit), read back
// by the system poll source.
//
// `Run Failed` is not stored here: the run table already records every failure
// from every writer, so the poll reads that. The other kinds happen once, in
// one place, and leave nothing else behind to read.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { SystemEventId } from '../../../../generated/kysely/automations/SystemEvent';
import type { SystemEventKind, SystemEventPayload } from './types';

import { getAutomationsQb } from '../../../../lib/kysely';
import { getEnvVar } from '../../../../lib/utils/environment';

/** One stored platform event. */
export interface StoredSystemEvent {
  id: string;
  /** The kind's `typeId`. */
  kind: string;
  payload: SystemEventPayload;
  occurredAt: Date;
}

/** Where the last poll stopped in the stored events: ordered on both fields,
 *  so events recorded in the same millisecond are neither skipped nor
 *  delivered twice. */
export interface StoredEventMark {
  occurredAt: string;
  id: string;
}

export async function recordSystemEvent(input: {
  teamId: string;
  kind: SystemEventKind;
  payload: SystemEventPayload;
}): Promise<void> {
  await getAutomationsQb(['system_event'])
    .insertInto('system_event')
    .values({
      team_id: input.teamId,
      kind: input.kind.typeId,
      payload: input.payload,
      occurred_at: new Date(input.payload.at),
    })
    .execute();
}

/** Reads the team's stored events of `kinds` strictly after `after`, no later
 *  than `until`, oldest first. The seam tests replace. */
export type StoredSystemEventReader = (input: {
  teamId: TeamId;
  kinds: readonly string[];
  after: StoredEventMark;
  until: Date;
  limit: number;
}) => Promise<StoredSystemEvent[]>;

export const readStoredSystemEventsFromDb: StoredSystemEventReader = async ({
  teamId,
  kinds,
  after,
  until,
  limit,
}) => {
  if (kinds.length === 0) return [];
  const afterAt = new Date(after.occurredAt);
  const rows = await getAutomationsQb(['system_event'])
    .selectFrom('system_event')
    .where('team_id', '=', teamId)
    .where('kind', 'in', [...kinds])
    .where('occurred_at', '<=', until)
    .where((eb) =>
      eb.or([
        eb('occurred_at', '>', afterAt),
        eb.and([eb('occurred_at', '=', afterAt), eb('id', '>', after.id as SystemEventId)]),
      ]),
    )
    .select(['id', 'kind', 'payload', 'occurred_at'])
    .orderBy('occurred_at', 'asc')
    .orderBy('id', 'asc')
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    id: row.id as string,
    kind: row.kind,
    payload: row.payload as SystemEventPayload,
    occurredAt: row.occurred_at,
  }));
};

export function webBaseUrl(): string {
  return getEnvVar('WEB_BASE_URL', { devDefault: 'http://localhost:3003' }).replace(/\/$/, '');
}

/** The automation's own page — where its version and its diagnostics show. */
export function automationUrl(automationId: string): string {
  return `${webBaseUrl()}/movements/${encodeURIComponent(automationId)}`;
}

/** The automations list. */
export function automationsUrl(): string {
  return `${webBaseUrl()}/automations`;
}
