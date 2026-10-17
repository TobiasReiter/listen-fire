// Evertrace's poll — the solicited event seam. Evertrace has no webhooks, so
// the host's poll drives event production: it pulls what has been created
// since the persisted checkpoint, emits one event per row, and returns the new
// high-water marks.
//
// Creation is the ONE "changed since" Evertrace offers, so a listener fires on
// new things only — a signal that changes afterwards does not fire again, and
// an entry that is removed and re-added fires as the new entry it is.
//
// TWO KINDS, ONE SOURCE. A listen selects between them the ordinary way —
// `events: ["signal"]` or `events: ["list_entry"]`, the values each event edge
// declares it fires on (schema.ts `firesOn`) — and this reads the SAME
// selection off the trigger's config, so what the checker typed the listened
// parameter as is exactly what gets fetched. No selection is the signal alone,
// which is what every listen written before lists still means.

import type { DiscriminableEvent } from 'movement-engine/public/adapter';
import type { ModuleLog, PollAnswer, PollInput } from 'module-kit';
import type {
  EvertraceApiClient,
  EvertraceList,
  EvertraceListEntry,
  EvertraceSearch,
  EvertraceSignal,
} from './api_client';

import { eventConfigList } from 'movement-engine/public/inbound';
import { narrowsAnything, signalFilterFromSearchRows } from './saved_search';
import {
  EVERTRACE_LIST_ENTRY_EVENT,
  EVERTRACE_LIST_ENTRY_EVENT_TAG,
  EVERTRACE_SIGNAL_EVENT,
  EVERTRACE_SIGNAL_EVENT_TAG,
  encodeListEntryId,
  type EvertraceCheckpoint,
} from './types';

/** Evertrace's default cadence — overridable per automation via the `listen`
 *  option `pollIntervalSeconds`. */
export const EVERTRACE_POLL_INTERVAL_SECONDS = 300;

/** Rows per request. Evertrace's envelope carries no total, so a SHORT page is
 *  the end of the collection. */
const PAGE_SIZE = 100;

/** The list-entry poll walks newest-first pages; this bounds how far back it
 *  will walk when the cutoff is never reached (a list that has been quiet is
 *  otherwise paged in full on every tick). */
const MAX_LIST_PAGES = 20;

/** Saved searches whose stored rows have already been logged, so the raw
 *  vocabulary reaches production logs ONCE per search per process rather than
 *  on every tick. */
const loggedSearches = new Set<string>();

interface EvertracePollConfig {
  search?: string;
  list?: string;
  pollIntervalSeconds?: number;
}

function stringOption(config: unknown, key: 'search' | 'list'): string | undefined {
  const value = (config as EvertracePollConfig | null | undefined)?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** The kinds this trigger listens for. An empty or unrecognised selection is
 *  the signal alone — the manifest's `defaultSubscribedEvents`, and what a
 *  config-less listen has always meant. */
function selectedEvents(config: unknown): { signals: boolean; entries: boolean } {
  const selected = eventConfigList((config as { events?: unknown } | null | undefined)?.events);
  const entries = selected.includes(EVERTRACE_LIST_ENTRY_EVENT);
  const signals = selected.includes(EVERTRACE_SIGNAL_EVENT) || !entries;
  return { signals, entries };
}

function mark(checkpoint: unknown, key: keyof EvertraceCheckpoint): number | undefined {
  const value = (checkpoint as EvertraceCheckpoint | null | undefined)?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export async function pollEvertrace(client: EvertraceApiClient, input: PollInput, options: { log: ModuleLog }): Promise<PollAnswer> {
  const wanted = selectedEvents(input.config);
  const now = Date.now();
  const next: EvertraceCheckpoint = {};
  const events: DiscriminableEvent[] = [];

  if (wanted.signals) {
    // First poll: set the mark to now and emit nothing. A live listener
    // watches from go-live onward — it never backfills the corpus (which
    // would flood the run on connect). Past signals stay reachable through
    // the root's `Signals` collection.
    const since = mark(input.checkpoint, 'createdAfter');
    if (since === undefined) {
      next.createdAfter = now;
    } else {
      const search = stringOption(input.config, 'search');
      const signals =
        search !== undefined
          ? await signalsFromSearch({ client, log: options.log, search, createdAfter: since })
          : await signalsSinceCreation({ client, createdAfter: since });
      next.createdAfter = signals.reduce((high, s) => Math.max(high, s.createdAt), since);
      for (const signal of signals) {
        events.push({
          payload: signal,
          externalId: signal.id,
          tag: EVERTRACE_SIGNAL_EVENT_TAG,
          occurredAt: new Date(signal.createdAt).toISOString(),
        });
      }
    }
  }

  if (wanted.entries) {
    // Same first-poll rule: the mark starts at now, so the entries already on
    // the workspace's lists are history, not a delivery.
    const since = mark(input.checkpoint, 'entriesCreatedAfter');
    if (since === undefined) {
      next.entriesCreatedAfter = now;
    } else {
      const entries = await entriesSinceCreation({
        client,
        createdAfter: since,
        list: stringOption(input.config, 'list'),
      });
      next.entriesCreatedAfter = entries.reduce((high, e) => Math.max(high, e.createdAt), since);
      for (const entry of entries) {
        events.push({
          payload: entry,
          externalId: encodeListEntryId({ listId: entry.listId, entryId: entry.id }),
          tag: EVERTRACE_LIST_ENTRY_EVENT_TAG,
          occurredAt: new Date(entry.createdAt).toISOString(),
        });
      }
    }
  }

  // Oldest first — a run processes what Evertrace found in the order it
  // found it.
  events.sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''));

  return { events, checkpoint: next };
}

/** The unfiltered poll: Evertrace's own `created_after` does the bounding, so
 *  every page is already new. */
async function signalsSinceCreation(input: {
  client: EvertraceApiClient;
  createdAfter: number;
}): Promise<EvertraceSignal[]> {
  const all: EvertraceSignal[] = [];
  for (let page = 1; ; page++) {
    const { data } = await input.client.listSignals({
      filter: { created_after: String(input.createdAfter) },
      page,
      limit: PAGE_SIZE,
    });
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * The saved-search poll. The search's stored filter rows are rebuilt as the
 * `POST /signals` body and the poll adds its own `created_after` — so this is
 * the unfiltered poll with the search's narrowing on top, and the cutoff is
 * the server's rather than an assumption about the order rows come back in.
 */
async function signalsFromSearch(input: {
  client: EvertraceApiClient;
  log: ModuleLog;
  search: string;
  createdAfter: number;
}): Promise<EvertraceSignal[]> {
  const found = await resolveSearch(input.client, input.search);
  // `GET /searches` carries the rows; a workspace that answers without them
  // is worth one more call rather than a poll that silently matches nothing.
  const rows = found.filters ?? (await input.client.getSearch(found.id)).filters ?? [];
  const { filter, skipped } = signalFilterFromSearchRows(rows);

  if (!loggedSearches.has(found.id)) {
    loggedSearches.add(found.id);
    input.log.info(
      `[evertrace] saved search "${found.title}" (${found.id}) rows: ${JSON.stringify(rows)}`,
    );
    if (skipped.length > 0) {
      input.log.info(
        `[evertrace] saved search "${found.title}" (${found.id}) skipped: ${JSON.stringify(skipped)}`,
      );
    }
  }
  if (!narrowsAnything(filter)) {
    // Every row unreadable would otherwise read as "this search matches
    // everything" — say so, rather than delivering the whole feed in silence.
    input.log.warn(
      `[evertrace] saved search "${found.title}" (${found.id}) contributed no filter; ` +
        `polling on the checkpoint alone`,
    );
  }

  const all: EvertraceSignal[] = [];
  for (let page = 1; ; page++) {
    const { data } = await input.client.listSignals({
      filter: { ...filter, created_after: String(input.createdAfter) },
      page,
      limit: PAGE_SIZE,
    });
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return all;
}

/** A saved search named by its id or by its exact title. */
async function resolveSearch(client: EvertraceApiClient, search: string): Promise<EvertraceSearch> {
  const searches = await client.listSearches();
  const match =
    searches.find((s) => s.id === search) ??
    searches.find((s) => s.title.toLowerCase() === search.toLowerCase());
  if (!match) {
    throw new Error(
      `EvertracePollSource: no saved search called "${search}" in this Evertrace workspace ` +
        `(saw: ${searches.map((s) => s.title).join(', ') || 'none'}).`,
    );
  }
  return match;
}

/**
 * The list-entry poll. Entries live under their list — there is no
 * workspace-wide entry listing and no `created_after` on the one there is — so
 * this asks each list in scope for its newest entries first and stops at the
 * mark. An unscoped listen covers every list the workspace has.
 */
async function entriesSinceCreation(input: {
  client: EvertraceApiClient;
  createdAfter: number;
  list?: string;
}): Promise<EvertraceListEntry[]> {
  const lists = await input.client.listLists();
  const scope = input.list !== undefined ? [resolveList(lists, input.list)] : lists;

  const fresh: EvertraceListEntry[] = [];
  for (const list of scope) {
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const { data } = await input.client.listListEntries(list.id, {
        page,
        limit: PAGE_SIZE,
        sortBy: 'entry_created_at',
        sortOrder: 'desc',
      });
      fresh.push(...data.filter((entry) => entry.createdAt > input.createdAfter));
      if (data.length < PAGE_SIZE || data.some((e) => e.createdAt <= input.createdAfter)) break;
    }
  }
  return fresh;
}

/** A list named by its id or by its exact name. */
function resolveList(lists: EvertraceList[], list: string): EvertraceList {
  const match =
    lists.find((l) => l.id === list) ??
    lists.find((l) => l.name.toLowerCase() === list.toLowerCase());
  if (!match) {
    throw new Error(
      `EvertracePollSource: no list called "${list}" in this Evertrace workspace ` +
        `(saw: ${lists.map((l) => l.name).join(', ') || 'none'}).`,
    );
  }
  return match;
}
