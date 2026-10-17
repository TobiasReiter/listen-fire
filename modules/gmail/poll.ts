// Gmail's poll — the solicited event seam.
//
// Push was available and deliberately not taken: a Pub/Sub topic, a public push
// endpoint and a watch that must be renewed every week are a lot of moving parts
// to buy a minute of latency nobody needs. So the host's poll drives event
// production (the module's `poll` declaration): it asks Gmail what has arrived since the persisted change
// marker, emits one event per message, and returns the new mark.
//
// The marker is PERISHABLE — Gmail drops it after about a week of inactivity —
// so the checkpoint carries a second mark, the last seen time, and an expired
// marker resyncs from that rather than leaving the listener dead forever.
//
// History is exact but Gmail's SEARCH, which applies the listen's query, only
// catches up eventually. An arrival the search does not admit yet rides the
// checkpoint as pending and is re-checked on later ticks, so a slow index
// delays a message rather than losing it.

import type { DiscriminableEvent } from 'movement-engine/public/adapter';
import type { PollAnswer, PollInput } from 'module-kit';
import type { GmailClientSource } from './adapter';

import {
  GmailApiError,
  type GmailApiClient,
  type GmailHistoryAddition,
  type GmailMessageRef,
} from './api_client';
import { decodeGmailMessage, type GmailMessageRecord } from './mime';
import { anyGmailLabel, combineGmailQueries } from './filter';
import {
  GMAIL_MESSAGE_EVENT_TAG,
  type GmailCheckpoint,
  type GmailPendingArrival,
} from './types';

/** Gmail's default cadence — overridable per automation via the `listen` option
 *  `pollIntervalSeconds`. A minute of delay on arriving mail is what the ruling
 *  traded the push machinery away for. */
export const GMAIL_POLL_INTERVAL_SECONDS = 60;

/** The labels a listener watches when its `labels` option says nothing. Mail
 *  that never reaches the inbox — filtered, archived on arrival, spam — is by
 *  default mail the mailbox's owner chose not to see. That is a default, not a
 *  rule: an owner who cannot steer Gmail's spam filter widens it with
 *  `labels: ["INBOX", "SPAM"]`. */
const DEFAULT_LABELS: readonly string[] = ['INBOX'];

/** Gmail's search leaves these out unless the request asks for them. */
const SPAM_AND_TRASH = new Set(['SPAM', 'TRASH']);

/** How many messages one tick will deliver. A tick that meets more than this
 *  advances the mark only over what it took, so the rest arrives on the next
 *  tick rather than being lost. */
const MAX_PER_TICK = 100;

/** How far back a resync reaches when the checkpoint carries no last seen time
 *  — which can only happen to a row written before both marks existed. */
const RESYNC_FALLBACK_MS = 24 * 60 * 60 * 1000;

/** How long an arrival the listen's search does not admit is re-checked
 *  before it counts as excluded. Gmail's search index trails its history by
 *  seconds to minutes; past this, the query genuinely does not match. */
const PENDING_GRACE_MS = 15 * 60 * 1000;

/** How many search pages one narrowing reads looking for the ids in hand —
 *  enough for a busy tick, bounded so a broad query cannot page the mailbox.
 *  An id not found stays pending rather than being dropped. */
const NARROW_MAX_PAGES = 5;

function checkpointOf(value: unknown): GmailCheckpoint {
  if (typeof value !== 'object' || value === null) return {};
  const historyId = Reflect.get(value, 'historyId');
  const lastSeenAt = Reflect.get(value, 'lastSeenAt');
  const pending = pendingOf(Reflect.get(value, 'pending'));
  return {
    ...(typeof historyId === 'string' && historyId !== '' ? { historyId } : {}),
    ...(typeof lastSeenAt === 'string' && lastSeenAt !== '' ? { lastSeenAt } : {}),
    ...(pending.length > 0 ? { pending } : {}),
  };
}

/** A checkpoint written before `pending` existed has none; an entry that does
 *  not parse is dropped rather than failing the listener. */
function pendingOf(value: unknown): GmailPendingArrival[] {
  if (!Array.isArray(value)) return [];
  const out: GmailPendingArrival[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const id = Reflect.get(entry, 'id');
    const firstSeenAt = Reflect.get(entry, 'firstSeenAt');
    if (typeof id !== 'string' || id === '') continue;
    if (typeof firstSeenAt !== 'string' || Number.isNaN(Date.parse(firstSeenAt))) continue;
    out.push({ id, firstSeenAt });
  }
  return out;
}

/** The author's own narrowing. A listen without one is a listener on every
 *  message that arrives carrying one of its labels. */
export function listenQuery(config: unknown): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const query = Reflect.get(config, 'query');
  return typeof query === 'string' && query.trim() !== '' ? query.trim() : undefined;
}

export const GMAIL_LABELS_SHAPE_ERROR =
  "a Gmail listener's 'labels' must be a non-empty list of Gmail label ids — " +
  'e.g. labels: ["INBOX", "SPAM"]';

/**
 * The labels whose arrivals fire the listener. Absent ⇒ the inbox alone. A
 * malformed value THROWS rather than falling back to the inbox: the checker
 * refuses it at save, so one reaching here is a listener that would otherwise
 * quietly watch something other than what its author wrote.
 */
export function listenLabels(config: unknown): string[] {
  const raw =
    typeof config === 'object' && config !== null ? Reflect.get(config, 'labels') : undefined;
  if (raw === undefined) return [...DEFAULT_LABELS];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(GMAIL_LABELS_SHAPE_ERROR);
  const labels: string[] = [];
  for (const label of raw) {
    if (typeof label !== 'string' || label.trim() === '') throw new Error(GMAIL_LABELS_SHAPE_ERROR);
    if (!labels.includes(label.trim())) labels.push(label.trim());
  }
  return labels;
}

/** Gmail's `after:` takes whole epoch SECONDS, and is inclusive — so a resync
 *  asks from the last seen second and the caller drops what it already
 *  delivered. */
function afterTerm(sinceMs: number): string {
  return `after:${Math.floor(sinceMs / 1000)}`;
}

/** One search over the watched labels: their OR group, then the author's own
 *  query, which is Gmail's AND. */
function searchOf(input: {
  labels: readonly string[];
  terms: (string | undefined)[];
}): { query: string; includeSpamTrash?: true } {
  const query = combineGmailQueries(anyGmailLabel(input.labels), ...input.terms) ?? '';
  return input.labels.some((label) => SPAM_AND_TRASH.has(label))
    ? { query, includeSpamTrash: true }
    : { query };
}

/** One mailbox's poll, over the client its host's credential reaches it with. */
export class GmailPollSource {
  readonly pollIntervalSeconds = GMAIL_POLL_INTERVAL_SECONDS;

  constructor(private readonly client: GmailClientSource) {}

  async getEvents(input: PollInput): Promise<PollAnswer> {
    const labels = listenLabels(input.config);
    const client = await this.client();

    const now = Date.now();
    const mark = checkpointOf(input.checkpoint);
    const query = listenQuery(input.config);

    // First poll: take the mailbox's current marker and emit nothing. A live
    // listener watches from go-live onward — it never backfills the mailbox
    // (which would flood the run on connect). Past mail stays reachable through
    // the root's `Messages` collection.
    if (mark.historyId === undefined) {
      const profile = await client.getProfile();
      return {
        events: [],
        checkpoint: { historyId: profile.historyId, lastSeenAt: new Date(now).toISOString() },
      };
    }

    const { refs, historyId, resynced } = await this.arrivals({
      client,
      historyId: mark.historyId,
      lastSeenAt: mark.lastSeenAt,
      labels,
      query,
      now,
    });

    // Arrivals carried over from earlier ticks go through the same narrowing as
    // this tick's: one the search now admits is delivered now.
    const fresh = new Set(refs.map((ref) => ref.id));
    const carried = (mark.pending ?? []).filter((entry) => !fresh.has(entry.id));
    const candidates = [...refs, ...carried.map((entry) => ({ id: entry.id }))];

    const { messages, unadmitted } = await this.fetchMessages({
      client,
      refs: candidates,
      labels,
      query,
    });

    const firstSeen = new Map(carried.map((entry) => [entry.id, entry.firstSeenAt]));
    const pending: GmailPendingArrival[] = [];
    for (const id of unadmitted) {
      const firstSeenAt = firstSeen.get(id) ?? new Date(now).toISOString();
      if (now - Date.parse(firstSeenAt) < PENDING_GRACE_MS) pending.push({ id, firstSeenAt });
    }

    const events: DiscriminableEvent[] = messages.map((message) => ({
      payload: { ...message, ...(resynced ? { resynced: true } : {}) },
      externalId: message.id,
      // Gmail delivers the same message id on a resync overlap as on a normal
      // tick, so the delivery key is the message — a resync that re-sees a
      // message the engine already ran is a no-op rather than a second run.
      idempotencyKey: `gmail:${message.id}`,
      tag: GMAIL_MESSAGE_EVENT_TAG,
      ...(message.date !== null ? { occurredAt: message.date } : {}),
    }));

    // Oldest first — a run processes the mail in the order it arrived.
    events.sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''));

    // `lastSeenAt` is the moment this poll LOOKED, not the newest message's own
    // date: a resync from it asks Gmail for everything since the last look,
    // which is the question the missing marker left unanswered. Anything the
    // overlap re-delivers is dropped on the event's idempotency key.
    const checkpoint: GmailCheckpoint = {
      historyId: historyId ?? mark.historyId,
      lastSeenAt: new Date(now).toISOString(),
      ...(pending.length > 0 ? { pending } : {}),
    };
    return { events, checkpoint };
  }

  /**
   * What has arrived since the mark.
   *
   * The normal path is Gmail's own history, which is cheap and exact. When
   * Gmail has DROPPED the marker — the 404 it gives after about a week of
   * inactivity — the answer is a search from the last seen time instead, and
   * every message it yields is flagged `resynced` so a run can tell that the
   * "since" was approximate rather than exact.
   */
  private async arrivals(input: {
    client: GmailApiClient;
    historyId: string;
    lastSeenAt: string | undefined;
    labels: readonly string[];
    query: string | undefined;
    now: number;
  }): Promise<{ refs: GmailMessageRef[]; historyId?: string; resynced: boolean }> {
    const { client } = input;
    try {
      const reads: LabelHistory[] = [];
      for (const labelId of input.labels) {
        reads.push(await readLabelHistory({ client, startHistoryId: input.historyId, labelId }));
      }
      return { ...takeArrivals(reads), resynced: false };
    } catch (error) {
      if (!(error instanceof GmailApiError) || error.failure !== 'history_expired') throw error;
    }

    const sinceMs = input.lastSeenAt ? Date.parse(input.lastSeenAt) : NaN;
    const since = Number.isNaN(sinceMs) ? input.now - RESYNC_FALLBACK_MS : sinceMs;
    const profile = await client.getProfile();
    const { messages } = await client.listMessages({
      ...searchOf({ labels: input.labels, terms: [afterTerm(since), input.query] }),
      maxResults: MAX_PER_TICK,
    });
    return { refs: dedupe(messages), historyId: profile.historyId, resynced: true };
  }

  /**
   * The messages behind the refs, narrowed to the author's filter.
   *
   * History does not take a query, so a listener with one narrows HERE — a
   * search whose answer is intersected with the ids in hand, which is a page
   * or two of ids rather than a fetch per message that is then thrown away.
   * The ids the search did NOT admit come back too: the caller decides whether
   * the index has not caught up yet or the query excludes them.
   */
  private async fetchMessages(input: {
    client: GmailApiClient;
    refs: GmailMessageRef[];
    labels: readonly string[];
    query: string | undefined;
  }): Promise<{ messages: GmailMessageRecord[]; unadmitted: string[] }> {
    if (input.refs.length === 0) return { messages: [], unadmitted: [] };

    const allowed = await this.narrow(input);
    const messages: GmailMessageRecord[] = [];
    const unadmitted: string[] = [];
    for (const ref of input.refs) {
      if (!allowed.has(ref.id)) {
        unadmitted.push(ref.id);
        continue;
      }
      messages.push(decodeGmailMessage(await input.client.getMessage(ref.id)));
    }
    return { messages, unadmitted };
  }

  /** The subset of ids the listen's own query admits, among mail carrying any
   *  watched label. No query ⇒ all of them, and no request — history was
   *  already read per label. */
  private async narrow(input: {
    client: GmailApiClient;
    refs: GmailMessageRef[];
    labels: readonly string[];
    query: string | undefined;
  }): Promise<Set<string>> {
    const wanted = new Set(input.refs.map((ref) => ref.id));
    if (input.query === undefined) return wanted;
    const admitted = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < NARROW_MAX_PAGES; page += 1) {
      const result = await input.client.listMessages({
        ...searchOf({ labels: input.labels, terms: [input.query] }),
        maxResults: MAX_PER_TICK,
        ...(pageToken !== undefined ? { pageToken } : {}),
      });
      for (const message of result.messages) {
        if (wanted.has(message.id)) admitted.add(message.id);
      }
      pageToken = result.nextPageToken;
      if (pageToken === undefined || admitted.size === wanted.size) break;
    }
    return admitted;
  }
}

/** One label's history since the mark, read page by page. */
interface LabelHistory {
  added: GmailHistoryAddition[];
  /** The mailbox's marker as this read finished — only meaningful when it
   *  read to the end. */
  historyId?: string;
  /** False when the read stopped early at the tick's cap with pages left. */
  complete: boolean;
}

/**
 * Every page of one label's history, stopping once a tick's worth is in hand —
 * what lies past that stays in Gmail's history for the next tick, because the
 * mark only advances over what was taken.
 */
async function readLabelHistory(input: {
  client: GmailApiClient;
  startHistoryId: string;
  labelId: string;
}): Promise<LabelHistory> {
  const added: GmailHistoryAddition[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const page = await input.client.listHistory({
      startHistoryId: input.startHistoryId,
      labelId: input.labelId,
      ...(pageToken !== undefined ? { pageToken } : {}),
    });
    added.push(...page.added);
    pageToken = page.nextPageToken;
    if (pageToken === undefined) {
      return {
        added,
        ...(page.historyId !== undefined ? { historyId: page.historyId } : {}),
        complete: true,
      };
    }
    if (added.length >= MAX_PER_TICK) return { added, complete: false };
  }
}

/** A history id as a number to order by — Gmail's are decimal strings that
 *  outgrow a double. */
function historyOrder(id: string | undefined): bigint | undefined {
  return id !== undefined && /^\d+$/.test(id) ? BigInt(id) : undefined;
}

function minOrder(values: (bigint | undefined)[]): bigint | undefined {
  let min: bigint | undefined;
  for (const value of values) {
    if (value !== undefined && (min === undefined || value < min)) min = value;
  }
  return min;
}

/**
 * The union of every label's arrivals, and the mark the next tick reads from.
 *
 * When everything was read and taken, the mark is the mailbox's marker — the
 * LOWEST the reads reported, since a message landing on one label between two
 * labels' reads is only covered from the earlier one. When the tick stopped
 * short, the mark sits just before the first arrival it did not take, so the
 * next tick starts there; whatever it re-reads was already delivered and is
 * dropped on its idempotency key.
 */
function takeArrivals(reads: LabelHistory[]): { refs: GmailMessageRef[]; historyId?: string } {
  const all = dedupe(reads.flatMap((read) => read.added));
  const ordered = [...all].sort((a, b) => {
    const x = historyOrder(a.historyId);
    const y = historyOrder(b.historyId);
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
    return x < y ? -1 : x > y ? 1 : 0;
  });

  // An unfinished label vouches only for what it read — past its last
  // arrival, the other labels' arrivals are not yet comparable with its own.
  const frontier = minOrder(
    reads
      .filter((read) => !read.complete)
      .map((read) => historyOrder(read.added[read.added.length - 1]?.historyId)),
  );
  const eligible =
    frontier === undefined
      ? ordered
      : ordered.filter((ref) => {
          const at = historyOrder(ref.historyId);
          return at !== undefined && at <= frontier;
        });
  const taken = eligible.slice(0, MAX_PER_TICK);
  const refs = taken.map(({ id, threadId }) => ({ id, ...(threadId != null ? { threadId } : {}) }));

  const everything = frontier === undefined && taken.length === ordered.length;
  if (everything) {
    const marker = minOrder(reads.map((read) => historyOrder(read.historyId)));
    return { refs, ...(marker !== undefined ? { historyId: String(marker) } : {}) };
  }
  const next = historyOrder(eligible[taken.length]?.historyId);
  const resume = next !== undefined ? next - 1n : frontier;
  return { refs, ...(resume !== undefined ? { historyId: String(resume) } : {}) };
}

/** One event per message per tick. Gmail's history records a message once per
 *  CHANGE, so a message that arrived and was then labelled appears twice. */
function dedupe<T extends GmailMessageRef>(refs: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const ref of refs) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push(ref);
  }
  return out;
}
