// Granola's poll — the solicited event seam (Granola is a polled source).
// The host calls it this often per listen: it pulls notes updated since the
// persisted checkpoint, emits one event per note (tagged `granola:note`), and
// returns the new high-water checkpoint. Shares the API client with the
// read-side adapter.

import type { DiscriminableEvent } from 'movement-engine/public/adapter';
import type { PollAnswer, PollInput } from 'module-kit';

import { noteHasContent, normalizeNote, type GranolaClient } from './api_client';
import { GRANOLA_NOTE_EVENT_TAG, type GranolaCheckpoint } from './types';

/** Granola's default cadence — overridable per automation via the `listen`
 *  option `pollIntervalSeconds`. */
export const GRANOLA_POLL_INTERVAL_SECONDS = 300;

interface GranolaPollConfig {
  folder?: string | string[];
}

/** The folder names a `listen` filter restricts to (lowercased), or [] for none. */
function folderFilter(config: unknown): string[] {
  const folder = (config as GranolaPollConfig | null | undefined)?.folder;
  const list = typeof folder === 'string' ? [folder] : Array.isArray(folder) ? folder : [];
  return list.filter((f): f is string => typeof f === 'string').map((f) => f.toLowerCase());
}

function parseCheckpoint(checkpoint: unknown): GranolaCheckpoint | undefined {
  const updatedAfter = (checkpoint as GranolaCheckpoint | null | undefined)?.updatedAfter;
  return typeof updatedAfter === 'string' ? { updatedAfter } : undefined;
}

export async function pollGranola(client: GranolaClient, input: PollInput): Promise<PollAnswer> {
  const checkpoint = parseCheckpoint(input.checkpoint);
  const folders = folderFilter(input.config);

  // First poll: just set the checkpoint to now and emit nothing. A live
  // trigger watches for meetings from go-live onward — it never backfills the
  // whole archive (which would flood the movement on connect). Subsequent
  // polls fetch only notes updated after this mark. Historical meetings stay
  // reachable on demand via the meta-root `Meetings` collection.
  if (checkpoint === undefined) {
    return { events: [], checkpoint: { updatedAfter: new Date().toISOString() } };
  }

  const summaries = await client.listAllNotes(checkpoint.updatedAfter);
  const events: DiscriminableEvent[] = [];
  let maxUpdatedAt = checkpoint?.updatedAfter ?? '';

  for (const summary of summaries) {
    // Advance the high-water mark for every note seen (even filtered ones) so
    // the checkpoint moves forward and we don't re-list them next poll.
    if (summary.updated_at > maxUpdatedAt) maxUpdatedAt = summary.updated_at;

    const note = await client.getNote(summary.id);

    if (folders.length > 0) {
      const noteFolders = note.folder_membership.map((f) => f.name.toLowerCase());
      if (!folders.some((f) => noteFolders.includes(f))) continue;
    }
    if (!noteHasContent(note)) continue;

    events.push({
      payload: normalizeNote(note),
      externalId: note.id,
      tag: GRANOLA_NOTE_EVENT_TAG,
      occurredAt: note.updated_at,
    });
  }

  // Oldest first — a movement processes meetings in the order they happened.
  events.sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''));

  const next: GranolaCheckpoint = {
    updatedAfter: maxUpdatedAt || (checkpoint?.updatedAfter ?? ''),
  };
  return { events, checkpoint: next };
}
