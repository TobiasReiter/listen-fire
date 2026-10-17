// Evertrace adapter — the names and ids the rest of the package shares.
//
// The ONE rule (adapters/base.ts): a position's `recordType` is the pretty
// DISPLAY NAME; the `evertrace:*` typeIds below are this adapter's private
// currency and never ride a position.

export const EVERTRACE_ADAPTER_TYPE = 'evertrace';

/** The workspace meta node a movement obtains by constructing the adapter. */
export const EVERTRACE_WORKSPACE_TYPE_ID = 'evertrace:workspace';
export const EVERTRACE_WORKSPACE_DISPLAY_NAME = 'Evertrace';

export const EVERTRACE_SIGNAL_TYPE_ID = 'evertrace:signal';
export const EVERTRACE_SIGNAL_DISPLAY_NAME = 'Signal';

export const EVERTRACE_EXPERIENCE_TYPE_ID = 'evertrace:experience';
export const EVERTRACE_EXPERIENCE_DISPLAY_NAME = 'Experience';

export const EVERTRACE_EDUCATION_TYPE_ID = 'evertrace:education';
export const EVERTRACE_EDUCATION_DISPLAY_NAME = 'Education';

export const EVERTRACE_COMPANY_TYPE_ID = 'evertrace:company';
export const EVERTRACE_COMPANY_DISPLAY_NAME = 'Company';

export const EVERTRACE_SCHOOL_TYPE_ID = 'evertrace:school';
export const EVERTRACE_SCHOOL_DISPLAY_NAME = 'School';

export const EVERTRACE_SEARCH_TYPE_ID = 'evertrace:search';
export const EVERTRACE_SEARCH_DISPLAY_NAME = 'Search';

export const EVERTRACE_LIST_TYPE_ID = 'evertrace:list';
export const EVERTRACE_LIST_DISPLAY_NAME = 'List';

export const EVERTRACE_LIST_ENTRY_TYPE_ID = 'evertrace:list_entry';
export const EVERTRACE_LIST_ENTRY_DISPLAY_NAME = 'List Entry';

// ── Root collections (the meta-node edges an author traverses) ───────────────
// Title Case, plural, and distinct from the record type each yields — the
// convention every other adapter's root collections already follow.

export const EVERTRACE_SIGNALS_COLLECTION = 'Signals';
export const EVERTRACE_SEARCHES_COLLECTION = 'Searches';
export const EVERTRACE_LISTS_COLLECTION = 'Lists';
export const EVERTRACE_COMPANIES_COLLECTION = 'Companies';
export const EVERTRACE_SCHOOLS_COLLECTION = 'Schools';

// ── Edges below the root: read id (private) ↔ natural name (what authors write)

export const EVERTRACE_EXPERIENCES_EDGE = 'experiences';
export const EVERTRACE_EXPERIENCES_EDGE_NAME = 'Experiences';
export const EVERTRACE_EDUCATIONS_EDGE = 'educations';
export const EVERTRACE_EDUCATIONS_EDGE_NAME = 'Educations';
export const EVERTRACE_SIGNAL_LIST_ENTRIES_EDGE = 'signal_list_entries';
export const EVERTRACE_SIGNAL_LIST_ENTRIES_EDGE_NAME = 'List Entries';
export const EVERTRACE_EXPERIENCE_COMPANY_EDGE = 'experience_company';
export const EVERTRACE_EXPERIENCE_COMPANY_EDGE_NAME = 'Company';
export const EVERTRACE_EDUCATION_SCHOOL_EDGE = 'education_school';
export const EVERTRACE_EDUCATION_SCHOOL_EDGE_NAME = 'School';
export const EVERTRACE_SEARCH_SIGNALS_EDGE = 'search_signals';
export const EVERTRACE_SEARCH_SIGNALS_EDGE_NAME = 'Signals';
export const EVERTRACE_LIST_ENTRIES_EDGE = 'list_entries';
export const EVERTRACE_LIST_ENTRIES_EDGE_NAME = 'Entries';
export const EVERTRACE_ENTRY_SIGNAL_EDGE = 'entry_signal';
export const EVERTRACE_ENTRY_SIGNAL_EDGE_NAME = 'Signal';
export const EVERTRACE_ENTRY_LIST_EDGE = 'entry_list';
export const EVERTRACE_ENTRY_LIST_EDGE_NAME = 'List';

// ── Tag vocabularies ────────────────────────────────────────────────────────
// A signal's `taggings` mix two closed vocabularies, and the API filters them
// through two DIFFERENT keys: the kind of event that raised the signal goes to
// `type`, what the person is goes to `profile_tags`. The adapter reads both off
// the one `Tags` field, so these sets are what tells a pushdown which key a
// written value belongs to — and what an author sees as the field's values.

/** The event that raised the signal — Evertrace's `type` filter. */
export const EVERTRACE_SIGNAL_KINDS = [
  'New Company',
  'Stealth Position',
  'Left Position',
  'New Patent',
  'New Grant',
  'New Paper',
] as const;

/** What the person is — Evertrace's `profile_tags` filter. */
export const EVERTRACE_PROFILE_TAGS = [
  'Serial Founder',
  'VC Backed Founder',
  'VC Backed Operator',
  'VC Investor',
  'YC Alumni',
  'Big Tech experience',
  'Big 4 experience',
  'Banking experience',
  'Consulting experience',
] as const;

/** Every value `Tags` is known to take. Open, not closed: Evertrace may tag a
 *  signal from a namespace this adapter has not met. */
export const EVERTRACE_TAG_VALUES: readonly string[] = [
  ...EVERTRACE_SIGNAL_KINDS,
  ...EVERTRACE_PROFILE_TAGS,
];

/** The discriminator a polled signal event carries. */
export const EVERTRACE_SIGNAL_EVENT_TAG = 'evertrace:signal';

/** The discriminator a polled list-addition event carries. */
export const EVERTRACE_LIST_ENTRY_EVENT_TAG = 'evertrace:list_entry';

// ── The `events:` vocabulary ────────────────────────────────────────────────
// Evertrace polls two different things — a signal Evertrace has just found, and
// a signal somebody has just filed onto a list — and one poll source serves
// both. A listen says WHICH with the ordinary `events:` selection, and each
// event edge declares (`firesOn`) the value that lands on it, so the checker
// types the listened parameter from the same fact the poll reads to decide what
// to fetch. No selection is the signal alone (`defaultSubscribedEvents`), which
// is what a listen written before lists existed still means.

export const EVERTRACE_SIGNAL_EVENT = 'signal';
export const EVERTRACE_LIST_ENTRY_EVENT = 'list_entry';

export const EVERTRACE_SUBSCRIBABLE_EVENTS = [
  EVERTRACE_SIGNAL_EVENT,
  EVERTRACE_LIST_ENTRY_EVENT,
] as const;

/**
 * The opaque checkpoint the PollSource persists. Creation is the one
 * "changed since" mark Evertrace offers, so each kind carries its own
 * high-water `createdAt` in epoch milliseconds — a listen selecting both keeps
 * both, and a mark that is absent is a kind this trigger has never pulled.
 */
export interface EvertraceCheckpoint {
  /** Signals: the newest `createdAt` already delivered. */
  createdAfter?: number;
  /** List entries: the newest entry `createdAt` already delivered. */
  entriesCreatedAfter?: number;
}

/**
 * A list entry's identity in Evertrace IS the pair (list, entry): every one of
 * its endpoints is `/lists/{listId}/entries/{entryId}`, and there is no lookup
 * by entry id alone. `DeleteInput` / `UpdateInput` carry only an `externalId`,
 * so the pair travels as one string through that seam. Encoded and decoded
 * here, in one place, so no call site re-invents the separator.
 */
export function encodeListEntryId(input: { listId: string; entryId: string }): string {
  return `${input.listId}:${input.entryId}`;
}

/** The inverse of {@link encodeListEntryId}. Splits at the FIRST separator —
 *  undefined when the value is not a pair. */
export function decodeListEntryId(
  externalId: string,
): { listId: string; entryId: string } | undefined {
  const at = externalId.indexOf(':');
  if (at <= 0 || at === externalId.length - 1) return undefined;
  return { listId: externalId.slice(0, at), entryId: externalId.slice(at + 1) };
}
