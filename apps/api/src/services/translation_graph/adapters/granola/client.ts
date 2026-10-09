// Granola API client + record types — shared by the read-side Adapter
// (granola/index.ts) and the PollSource (granola/poll.ts). Lifted from the
// legacy scheduled connector (adapters/pipeline/scheduled/granola.ts), which is
// proven against the live Granola API; reshaped behind one owner of the wire
// shape so both seams speak it.

import { z } from 'zod';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';

import { logger } from '../../../logger';
import { decryptToken } from '../../../../lib/credentials';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../../lib/recording';
import { getAutomationsQb } from '../../../../lib/kysely';

export const GRANOLA_ADAPTER_TYPE = 'granola';
/** A meeting note — the entry-point source type a movement listens to. */
export const GRANOLA_NOTE_TYPE_ID = 'granola:note';
/** Natural type name for a meeting note — the pretty name positions carry. */
export const GRANOLA_NOTE_DISPLAY_NAME = 'Meeting Note';
/** A person on the call — reached from a note via the `Attendees` edge. */
export const GRANOLA_ATTENDEE_TYPE_ID = 'granola:attendee';
/** Natural type name for an attendee — the pretty name positions carry. */
export const GRANOLA_ATTENDEE_DISPLAY_NAME = 'Attendee';
/** The note→attendee reference (natural name authors write after `-[:`). */
export const GRANOLA_ATTENDEES_FIELD = 'attendees';
/** The discriminator `tag` every polled note event carries. */
export const GRANOLA_NOTE_EVENT_TAG = 'granola:note';

/** The meta-root node a movement obtains by constructing the adapter
 *  (`granola(credentials:)`) — a single, contentless "Granola Meetings"
 *  position whose `Meetings` collection fans out to PAST Meeting Notes.
 *  Distinct from the polled `Meeting Note` source: the poll fires once per
 *  NEW/changed note; this lets a movement pull the back-catalogue on demand. */
export const GRANOLA_WORKSPACE_TYPE_ID = 'granola:workspace';
/** The meta-root collection edge a movement traverses to reach past meetings
 *  (`granola-[m:Meetings WHERE …]-> { … }`). Named distinctly from the
 *  `Meeting Note` record type it yields, so the poll-side note type is
 *  untouched — and Title Case, the one convention every other adapter's root
 *  collection already follows (`Folders`, `Channels`, `Linked Users`). */
export const GRANOLA_MEETINGS_COLLECTION = 'Meetings';

const DEFAULT_BASE = 'https://public-api.granola.ai';

/** Stored Granola credential — an API key (the `baseUrl` override points the
 *  dev loop at a fake API). */
export const granolaCredsParser = z.object({
  apiKey: z.string(),
  baseUrl: z.string().url().optional(),
});
export type GranolaCredentials = z.infer<typeof granolaCredsParser>;

/** The opaque checkpoint the PollSource persists — the high-water `updated_at`. */
export interface GranolaCheckpoint {
  updatedAfter: string;
}

// ── Granola API shapes (from the Granola OpenAPI spec) ──────────────────────

type GranolaUser = { name: string | null; email: string };

type GranolaCalendarEvent = {
  event_title: string;
  invitees: Array<{ email: string }>;
  organiser: string;
  calendar_event_id: string;
  scheduled_start_time: string;
  scheduled_end_time: string;
};

type GranolaFolder = { id: string; name: string };

type GranolaTranscriptEntry = {
  speaker: { source: 'microphone' | 'speaker' };
  text: string;
  start_time: string;
  end_time: string;
};

export type GranolaNoteSummary = {
  id: string;
  object: 'note';
  title: string | null;
  owner: GranolaUser;
  created_at: string;
  updated_at: string;
};

export type GranolaNote = GranolaNoteSummary & {
  calendar_event: GranolaCalendarEvent | null;
  attendees: GranolaUser[];
  folder_membership: GranolaFolder[];
  summary_text: string;
  summary_markdown: string | null;
  transcript: GranolaTranscriptEntry[] | null;
};

type ListNotesResponse = {
  notes: GranolaNoteSummary[];
  hasMore: boolean;
  cursor: string | null;
};

// ── Client ──────────────────────────────────────────────────────────────────

export class GranolaClient {
  private readonly base: string;

  constructor(
    private readonly apiKey: string,
    baseUrl?: string,
  ) {
    this.base = (baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  }

  private async request<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
      logger.warn(`[granola] rate limited, waiting ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.request<T>(path);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Granola API ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  listNotes(options: { updatedAfter?: string; cursor?: string; pageSize?: number }): Promise<ListNotesResponse> {
    const params = new URLSearchParams();
    if (options.updatedAfter) params.set('updated_after', options.updatedAfter);
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.pageSize) params.set('page_size', String(options.pageSize));
    const qs = params.toString();
    return this.request<ListNotesResponse>(`/v1/notes${qs ? `?${qs}` : ''}`);
  }

  getNote(noteId: string): Promise<GranolaNote> {
    return this.request<GranolaNote>(`/v1/notes/${noteId}?include=transcript`);
  }

  /** Page through every note updated since `updatedAfter` (summaries only). */
  async listAllNotes(updatedAfter: string | undefined): Promise<GranolaNoteSummary[]> {
    const all: GranolaNoteSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listNotes({ updatedAfter, cursor, pageSize: 30 });
      all.push(...page.notes);
      cursor = page.hasMore && page.cursor ? page.cursor : undefined;
    } while (cursor);
    return all;
  }

  /**
   * Pull PAST meeting notes since `updatedAfter`, hydrated to the full
   * normalised payload (`normalizeNote` — summary, transcript, attendees,
   * calendar fields) — the shape the `Meetings` collection yields one
   * position per. Notes with neither a summary nor a transcript are skipped
   * (`noteHasContent`), matching the poll source. `limit`, when set, caps how
   * many of the most-recent notes are hydrated (the back-catalogue can be
   * large, and each hydration is a `getNote` round-trip). Newest first.
   */
  async listMeetingsSince(input: {
    updatedAfter?: string;
    limit?: number;
  }): Promise<GranolaNotePayload[]> {
    const summaries = (await this.listAllNotes(input.updatedAfter)).sort((a, b) =>
      b.updated_at.localeCompare(a.updated_at),
    );
    const bounded =
      input.limit !== undefined && input.limit >= 0 ? summaries.slice(0, input.limit) : summaries;
    const notes: GranolaNotePayload[] = [];
    for (const summary of bounded) {
      const note = await this.getNote(summary.id);
      if (!noteHasContent(note)) continue;
      notes.push(normalizeNote(note));
    }
    return notes;
  }
}

/**
 * Construct a credentialed client for a team — shared by the read-side Adapter
 * and the PollSource. Returns null when no credential is wired or the stored
 * payload doesn't parse (the caller surfaces a clear "connect Granola" error).
 */
export async function resolveGranolaClient(input: {
  teamId: TeamId;
  credentialsId?: string;
}): Promise<GranolaClient | null> {
  if (!input.credentialsId) return null;
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', input.credentialsId as ExternalServiceCredentialsId)
    .where('team_id', '=', input.teamId)
    .select(['id', 'credentials'])
    .executeTakeFirst();
  if (!row) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(await decryptToken(row.credentials, row.id));
  } catch {
    return null;
  }
  // Route dev-loop team traffic to the fake Granola API (fake-channels). Mirrors
  // the per-adapter injection the other source adapters do when the engine loads
  // credentials directly — without it the client hits real Granola and 401s on
  // the seeded stub token.
  const rawPayload = isTestHarnessTeam(input.teamId)
    ? injectFakeBaseUrl(payload as Record<string, unknown>, 'GRANOLA')
    : payload;
  const parsed = granolaCredsParser.safeParse(rawPayload);
  if (!parsed.success) return null;
  return new GranolaClient(parsed.data.apiKey, parsed.data.baseUrl);
}

// ── Normalisation — the flat field bag describe() advertises ────────────────

export interface GranolaAttendeePayload {
  email: string;
  name?: string;
}

/** The note payload a polled event carries — the `describe('granola:note')`
 *  fields, plus `attendees[]` (for the edge) and the prose (for resources). */
export interface GranolaNotePayload {
  title: string;
  summary: string;
  scheduled_start?: string;
  scheduled_end?: string;
  organizer_email?: string;
  folder_names?: string;
  note_owner_email: string;
  note_owner_name?: string;
  created_at: string;
  updated_at: string;
  granola_note_id: string;
  attendees: GranolaAttendeePayload[];
  /** Formatted transcript, when the note has one — the transcript TEXT resource. */
  transcript_text?: string;
}

export function normalizeNote(note: GranolaNote): GranolaNotePayload {
  const title = note.title ?? note.calendar_event?.event_title ?? 'Untitled Meeting';
  const folderNames = note.folder_membership.map((f) => f.name).join(', ');
  return {
    title,
    summary: note.summary_markdown ?? note.summary_text ?? '',
    ...(note.calendar_event ? { scheduled_start: note.calendar_event.scheduled_start_time } : {}),
    ...(note.calendar_event ? { scheduled_end: note.calendar_event.scheduled_end_time } : {}),
    ...(note.calendar_event ? { organizer_email: note.calendar_event.organiser } : {}),
    ...(folderNames ? { folder_names: folderNames } : {}),
    note_owner_email: note.owner.email,
    ...(note.owner.name ? { note_owner_name: note.owner.name } : {}),
    created_at: note.created_at,
    updated_at: note.updated_at,
    granola_note_id: note.id,
    attendees: note.attendees.map((a) => ({
      email: a.email,
      ...(a.name ? { name: a.name } : {}),
    })),
    ...(transcriptText(note) ? { transcript_text: transcriptText(note) } : {}),
  };
}

/** Format the transcript as `[You]/[Speaker]: …` lines (the legacy shape), or
 *  undefined when the note has no transcript. */
export function transcriptText(note: GranolaNote): string | undefined {
  if (!note.transcript || note.transcript.length === 0) return undefined;
  return note.transcript
    .map((e) => `[${e.speaker.source === 'microphone' ? 'You' : 'Speaker'}]: ${e.text}`)
    .join('\n');
}

/** A note has nothing worth processing when it carries neither a summary nor a
 *  transcript — the legacy connector skips these. */
export function noteHasContent(note: GranolaNote): boolean {
  return Boolean(note.summary_text || note.summary_markdown || (note.transcript && note.transcript.length > 0));
}
