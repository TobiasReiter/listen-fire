// Engine-side event discrimination. A `DiscriminableEvent` — from an adapter's
// `preprocessInbound` (unsolicited) or a `PollSource.getEvents` (solicited poll)
// — is matched against the adapter's declared `EventType` union to produce a
// typed root `SourcePosition`. This is what lets the live trigger path seed the
// concrete record up front — no `webhook_event` meta-type + per-target-edge hop.
//
// The adapter makes the event discriminable; the engine discriminates it.

import type { DiscriminableEvent, EventType } from '../../adapter';

import { makeStablePosition, makeUnstablePosition, type SourcePosition } from '../../types';

export interface DiscriminationResult {
  /** The typed root position to seed the trigger's evaluation with. */
  position: SourcePosition;
  /** The matched event type (its `tag` / `positionType` drive downstream logic). */
  eventType: EventType;
}

/**
 * Match a single event against the union. Returns null when nothing matches —
 * the caller drops the event with a "no event type matched" diagnostic rather
 * than running a TG against an untyped position.
 *
 * Selection: an event the adapter already classified carries a `tag` (e.g.
 * `preprocessInbound` did a fetch to type a thin payload) and is matched by
 * tag; otherwise each type's declarative `match` is evaluated over the payload.
 */
export function discriminateEvent(input: {
  adapterType: string;
  event: DiscriminableEvent;
  eventTypes: readonly EventType[];
}): DiscriminationResult | null {
  const eventType = selectEventType(input.event, input.eventTypes);
  if (!eventType) return null;

  const { adapterType, event } = input;
  // A record-anchored event (the common case) seeds a stable position keyed by
  // its external id; an event with no record identity seeds an unstable
  // position still carrying the concrete type.
  const position: SourcePosition =
    event.externalId !== undefined
      ? makeStablePosition({
          adapterType,
          recordType: eventType.positionType,
          recordId: event.externalId,
          data: event.payload,
        })
      : makeUnstablePosition({
          adapterType,
          recordType: eventType.positionType,
          data: event.payload,
        });

  return { position, eventType };
}

function selectEventType(
  event: DiscriminableEvent,
  eventTypes: readonly EventType[],
): EventType | undefined {
  if (event.tag !== undefined) {
    return eventTypes.find((t) => t.tag === event.tag);
  }
  return eventTypes.find((t) => t.match !== undefined && matchesPayload(t.match, event.payload));
}

function matchesPayload(match: NonNullable<EventType['match']>, payload: unknown): boolean {
  const value = readPath(payload, match.path);
  // Discriminators are string-valued field paths (event_type, object_id, …).
  // A non-string value at the path is simply a non-match.
  if (typeof value !== 'string') return false;
  return Array.isArray(match.equals)
    ? match.equals.includes(value)
    : match.equals === value;
}

/** Read a dotted path (e.g. `id.object_id`) out of a nested object. */
function readPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}
