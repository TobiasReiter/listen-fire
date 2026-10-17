// Granola's names and the shapes that cross its seams: the adapter type, the
// type ids and display names positions carry, the event tag, the poll
// checkpoint and the note payload a polled event carries. Data and types only.

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

/** The opaque checkpoint the poll persists — the high-water `updated_at`. */
export interface GranolaCheckpoint {
  updatedAfter: string;
}

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
