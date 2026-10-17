// Granola API client + record types — shared by the read-side adapter
// (adapter.ts) and the poll (poll.ts). Lifted from the legacy scheduled
// connector, which is proven against the live Granola API; reshaped behind one
// owner of the wire shape so both seams speak it. It reaches Granola through
// the fetch and the log its host hands the module, never the process's own.

import { z } from 'zod';

import type { ModuleLog } from 'module-kit';

import type { GranolaNotePayload } from './types';

export const GRANOLA_DEFAULT_BASE_URL = 'https://public-api.granola.ai';

/** Stored Granola credential — an API key (the `baseUrl` override points the
 *  dev loop at a fake API). */
export const granolaCredsParser = z.object({
  apiKey: z.string(),
  baseUrl: z.string().url().optional(),
});
export type GranolaCredentials = z.infer<typeof granolaCredsParser>;

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

export interface GranolaClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** The host's fetch. */
  fetch: typeof fetch;
  log: ModuleLog;
}

export class GranolaClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: ModuleLog;

  constructor(options: GranolaClientOptions) {
    this.base = (options.baseUrl ?? GRANOLA_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch;
    this.log = options.log;
  }

  private async request<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
      this.log.warn(`[granola] rate limited, waiting ${waitMs}ms`);
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

// ── Normalisation — the flat field bag describe() advertises ────────────────

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
