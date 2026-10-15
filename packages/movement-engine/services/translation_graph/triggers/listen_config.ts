// Normalising a listen's `events` config, and the scope gate an inbound event
// must clear to reach a listen.
//
// Authored syntax is always a list (`events: ["x", "y"]`) — the checker rejects
// a bare string. But a stored config may still be a bare string: one authored
// before that rule, or written directly. Downstream readers want a uniform
// string[] regardless:
//   - subscription registration (`desiredChannels`) computes the channel's
//     event set to register with the source;
//   - dispatch-time scope filtering (`eventMatchesTriggerScope`) gates each
//     inbound event against the trigger's chosen events.
// A bare-string `events` used to fall through to "all events" — the source
// over-registered AND the dispatch filter matched everything, so a listen scoped
// to one event fired on all of them. Normalise here so any stored shape reads
// the same.

import type { DiscriminableEvent } from '../adapter';

export function eventConfigList(events: unknown): string[] {
  if (Array.isArray(events)) return events.filter((e): e is string => typeof e === 'string');
  if (typeof events === 'string') return [events];
  return [];
}

/**
 * Whether a trigger's `channels` listen filter admits an event in `channelName`
 * (Slack's `listen … { channels: ["dealflow", ...] }`, matched by name).
 *   - No `channels` set → always true (the listener isn't channel-scoped).
 *   - Scoped → true only when the resolved channel name is in the list.
 *   - A scoped listener whose event channel couldn't be resolved (`null`) never
 *     matches — we don't fire on a channel we can't confirm is in scope.
 * The channel-name resolution itself is the caller's (async) concern; this is
 * the pure decision, kept dependency-free so it's unit-testable in isolation.
 */
export function channelScopeMatches(config: unknown, channelName: string | null): boolean {
  const channels = eventConfigList((config as { channels?: unknown } | null)?.channels);
  if (channels.length === 0) return true;
  return channelName != null && channels.includes(channelName);
}

/**
 * Does this event clear a trigger's `listen` scope? Two gates, both from the
 * trigger's `config`:
 *   • `events: [...]` — the chosen change types (`record.created`, …). The
 *     authored selection that the source registration already narrowed to;
 *     re-checked here so two listens sharing one webhook each see only theirs.
 *   • `table: "tbl…"` — Airtable's per-table scope. The webhook is per-base, so
 *     a delivery for base B reaches every trigger on B's credential; this keeps
 *     a table-T listen from firing on table-U changes (no cross-leak, no wasted
 *     run). The event names its table in `recordType`.
 */
export function eventMatchesTriggerScope(event: DiscriminableEvent, config: unknown): boolean {
  const c = config as { events?: unknown; table?: unknown } | null;

  const events = eventConfigList(c?.events);
  if (events.length > 0) {
    if (event.eventType === undefined || !events.includes(event.eventType)) return false;
  }

  if (typeof c?.table === 'string' && c.table.length > 0) {
    if (event.recordType !== undefined && event.recordType !== c.table) return false;
  }

  return true;
}
