// Dealroom PollSource — the solicited event seam. Dealroom has no webhooks
// anywhere in its API, so the poll-source worker drives event production: it
// pulls the rounds recorded since the persisted checkpoint, emits one event per
// round, and returns the new high-water mark.
//
// Creation is the ONE "changed since" Dealroom offers on a round, so a listener
// fires on NEW rounds only — a round whose amount is corrected afterwards does
// not fire again.

import type { DiscriminableEvent } from '../../adapter';
import type { PollSource } from '../../poll_source';
import type { TeamId } from '../../../../generated/kysely/core/Team';

import {
  DEALROOM_MAX_LIMIT,
  DEALROOM_MAX_OFFSET,
  dealroomDateTime,
  parseDealroomInstant,
  type DealroomFundingRound,
  type DealroomMustFilters,
} from '../../../../adapters/dealroom/apiClient';
import { eventConfigList } from '../../triggers/listen_config';
import { resolveDealroomClient, type DealroomApiClient } from './client';
import { DEALROOM_SEARCH_FIELDS } from './schema';
import {
  DEALROOM_FUNDING_ROUND_EVENT_TAG,
  DEALROOM_FUNDING_ROUND_TYPE_ID,
  type DealroomCheckpoint,
} from './types';

/** Dealroom's default cadence — overridable per automation via the `listen`
 *  option `pollIntervalSeconds`. Rounds land in batches through the day, so a
 *  ten-minute look is plenty and keeps well inside the request budget. */
const DEFAULT_POLL_INTERVAL_SECONDS = 600;

/**
 * How far one tick will page. `created_utc_min` bounds the query, so a tick only
 * reaches this when a very quiet listener wakes to a very busy day — and then
 * the mark advances anyway, so the rest arrives on the next tick rather than
 * being lost.
 */
const MAX_PAGES = 20;

/** The listen options that narrow delivery. Each is a Dealroom terms filter,
 *  passed through as `form_data.must` exactly as the search takes it. */
const LISTEN_FILTER_KEYS = ['rounds', 'industries', 'hq_locations'] as const;

function mark(checkpoint: unknown): number | undefined {
  const value = (checkpoint as DealroomCheckpoint | null | undefined)?.createdAfter;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The narrowing a listen asked for. An option nobody set contributes nothing,
 *  which is a listener on every new round. */
export function listenFilters(config: unknown): DealroomMustFilters {
  const raw = (config ?? {}) as Record<string, unknown>;
  const must: DealroomMustFilters = {};
  for (const key of LISTEN_FILTER_KEYS) {
    const values = eventConfigList(raw[key]);
    if (values.length > 0) must[key] = values;
  }
  return must;
}

export class DealroomPollSource implements PollSource {
  readonly pollIntervalSeconds = DEFAULT_POLL_INTERVAL_SECONDS;

  constructor(
    private readonly teamId: TeamId,
    private readonly credentialsId: string | undefined,
    /** Injectable for tests; production resolves a credentialed client. */
    private readonly clientOverride?: DealroomApiClient,
  ) {}

  async getEvents(input: {
    config: unknown;
    checkpoint?: unknown;
  }): Promise<{ events: DiscriminableEvent[]; checkpoint?: unknown }> {
    const client =
      this.clientOverride ??
      (await resolveDealroomClient({ teamId: this.teamId, credentialsId: this.credentialsId }));
    if (!client) {
      throw new Error(
        `DealroomPollSource: no usable Dealroom credential for team ${this.teamId} ` +
          `(credentialsId=${this.credentialsId ?? 'unset'}). Connect Dealroom.`,
      );
    }

    const now = Date.now();
    const since = mark(input.checkpoint);

    // First poll: set the mark to now and emit nothing. A live listener watches
    // from go-live onward — it never backfills the database (which would flood
    // the run on connect). Past rounds stay reachable through the root's
    // `Funding Rounds` collection.
    if (since === undefined) return { events: [], checkpoint: { createdAfter: now } };

    const rounds = await roundsSinceCreation({
      client,
      createdAfter: since,
      must: listenFilters(input.config),
    });

    const checkpoint: DealroomCheckpoint = {
      createdAfter: rounds.reduce(
        (high, round) => Math.max(high, parseDealroomInstant(round.created_utc) ?? high),
        since,
      ),
    };

    const events: DiscriminableEvent[] = rounds.map((round) => ({
      payload: round,
      externalId: String(round.id),
      tag: DEALROOM_FUNDING_ROUND_EVENT_TAG,
      occurredAt: new Date(parseDealroomInstant(round.created_utc) ?? now).toISOString(),
    }));

    // Oldest first — a run processes the rounds in the order Dealroom recorded
    // them.
    events.sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''));

    return { events, checkpoint };
  }
}

/**
 * The rounds recorded since the mark. Dealroom's own `created_utc_min` does the
 * bounding and its `created_utc` sort makes the walk oldest-first, so paging is
 * a plain offset walk. The bound is inclusive over there, so the round that SET
 * the mark comes back — dropped here rather than delivered twice.
 */
async function roundsSinceCreation(input: {
  client: DealroomApiClient;
  createdAfter: number;
  must: DealroomMustFilters;
}): Promise<DealroomFundingRound[]> {
  const fresh: DealroomFundingRound[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * DEALROOM_MAX_LIMIT;
    if (offset > DEALROOM_MAX_OFFSET) break;
    const { items } = await input.client.searchFundingRounds({
      must: { ...input.must, created_utc_min: dealroomDateTime(input.createdAfter) },
      fields: DEALROOM_SEARCH_FIELDS[DEALROOM_FUNDING_ROUND_TYPE_ID],
      sort: 'created_utc',
      limit: DEALROOM_MAX_LIMIT,
      offset,
    });
    for (const round of items) {
      const created = parseDealroomInstant(round.created_utc);
      if (created !== undefined && created <= input.createdAfter) continue;
      fresh.push(round);
    }
    if (items.length < DEALROOM_MAX_LIMIT) break;
  }
  return fresh;
}

/** Factory matching the PollSource registry signature. */
export function createDealroomPollSource(input: {
  teamId: TeamId;
  credentialsId?: string;
}): DealroomPollSource {
  return new DealroomPollSource(input.teamId, input.credentialsId);
}
