// Opt-in echo-suppression — the inbound consult for the `suppress_self` listen
// flag.
//
// THIS IS NOT A LOOP DETECTOR. It is a declarative 2-WAY-SYNC feature, DEFAULT
// OFF. An author who builds an A↔B sync (one movement that both reads and
// writes the same system) sets `suppress_self: true` on the listen to mean
// "ignore my own writes echoing back into this system," so the sync doesn't
// self-trigger. Off matters: a user legitimately WANTS to react to Listen-Fire's own
// writes (Movement 1 writes a company to Attio → Movement 2 posts new Attio
// companies to Slack); a default-on suppression would nuke that.
//
// The consult is capability-gated. It asks the SOURCE adapter
// `didWeAuthor(event)` — the adapter answers from what IT owns (the change's
// actor and/or a short-TTL memory of our recent writes). The scope is the
// authorship of THIS change, never the record's identity-forever: a human's
// later edit of a record we once wrote answers `false` and fires normally.
//
// When the flag is on but the adapter can't answer (doesn't implement
// `didWeAuthor`, or returns `null`), this is a clearly-logged NO-OP — the
// author asked for something this source can't do, and we never silently
// swallow a legitimate event on an indeterminate answer. The floor (Phase 1)
// and the opt-in nature already bound the cost of an un-suppressed echo.

import { SUPPRESS_SELF_KEY } from 'movement-lang';

import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';

import { logger } from 'movement-engine/services/logger';

/**
 * Read the opt-in `suppress_self` flag off a persisted trigger config. The flag
 * is a boolean; anything other than the literal `true` (absent, false, a
 * malformed value) means OFF — the default.
 */
export function suppressSelfEnabled(config: unknown): boolean {
  if (config === null || typeof config !== 'object') return false;
  return (config as Record<string, unknown>)[SUPPRESS_SELF_KEY] === true;
}

export type EchoSuppressionDisposition =
  // Suppress the firing: the flag is on and the adapter confirmed WE authored
  // this inbound change. Recorded as suppressed (replayable), not dropped.
  | { kind: 'suppress'; reason: string }
  // Proceed normally — either the flag is off (the default), or it's on but the
  // change is NOT ours (a human / external edit).
  | { kind: 'proceed' }
  // The flag is on but the adapter can't answer "did we author this" (doesn't
  // implement the capability, or returned null). A no-op with a loud note so
  // the author learns this source can't honour the request.
  | { kind: 'no-op'; note: string };

/**
 * Decide whether an inbound event should be suppressed as the author's own
 * echo. Pure decision — the caller records/skips/proceeds. Fail-open: a thrown
 * `didWeAuthor` is treated as "can't answer" (no-op), never blocking dispatch.
 */
export async function consultEchoSuppression(input: {
  /** The persisted trigger config carrying the opt-in flag. */
  triggerConfig: unknown;
  /** The SOURCE adapter — the one whose writes might be echoing back. */
  sourceAdapter: Adapter;
  /** The inbound event the adapter inspects for authorship. */
  event: TriggerEvent;
  /** For logs. */
  triggerId: string;
}): Promise<EchoSuppressionDisposition> {
  // 1. Default off — the flag gates the whole feature. No flag, no consult.
  if (!suppressSelfEnabled(input.triggerConfig)) return { kind: 'proceed' };

  // 2. Capability gate — an adapter that can't tell its own writes apart from
  //    foreign ones omits `didWeAuthor`. The author asked for something this
  //    source can't do.
  if (typeof input.sourceAdapter.didWeAuthor !== 'function') {
    const note =
      `${input.sourceAdapter.adapterType}: suppress_self is on, but this source can't tell ` +
      `its own writes from external ones (no didWeAuthor capability) — firing as normal`;
    logger.warn('[EchoSuppression] flag on but adapter cannot answer — no-op', {
      triggerId: input.triggerId,
      adapterType: input.sourceAdapter.adapterType,
    });
    return { kind: 'no-op', note };
  }

  // 3. Ask the adapter about THIS change's authorship.
  let authored: boolean | null;
  try {
    authored = await input.sourceAdapter.didWeAuthor({ event: input.event });
  } catch (err) {
    // Fail-open: an authorship-check fault must never block a legitimate event.
    logger.warn('[EchoSuppression] didWeAuthor threw — treating as indeterminate (no-op)', {
      triggerId: input.triggerId,
      adapterType: input.sourceAdapter.adapterType,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: 'no-op',
      note: `${input.sourceAdapter.adapterType}: suppress_self check errored — firing as normal`,
    };
  }

  if (authored === true) {
    return {
      kind: 'suppress',
      reason: `${input.sourceAdapter.adapterType}: this change was authored by our own write (suppress_self)`,
    };
  }
  if (authored === null) {
    // Indeterminate for THIS event — don't suppress (same as a non-implementer
    // for this event), so we never swallow a possibly-legitimate change.
    logger.info('[EchoSuppression] adapter returned null (indeterminate) — firing as normal', {
      triggerId: input.triggerId,
      adapterType: input.sourceAdapter.adapterType,
    });
    return { kind: 'proceed' };
  }
  // authored === false — a human / external change. Fire normally.
  return { kind: 'proceed' };
}
