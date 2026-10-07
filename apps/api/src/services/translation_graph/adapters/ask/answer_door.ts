// THE Response WRITE, and the doors over it (callback-primitive layer 3).
//
// Answering a request is an ORDINARY EDGE WRITE — `write a-[:Response]-> {
// Answer: TRUE }` — so the answer semantics (coerce against the family, single
// answer, closed-request-wins) live in ONE function, `writeAskResponse`, and
// every caller is a wrapper over it:
//   • the ask adapter    — `createRecord` along `-[:Response]->`, i.e. any
//                          movement code, including a callback body
//   • the link page      — a confirmed POST on `/api/asks/<token>`
//   • Slack / Telegram   — a block-action / callback-query POST
//   • the agent (MCP)    — an answer against an ask id
//   • the control tower  — an operator answering on a person's behalf
// One semantics, several callers. The engine is never involved — a settle just
// hands the record to this deployment's `AskSettledNotifier` (composed: the
// engine's queued wake for the run parked on it; standalone: a signed webhook
// to whoever asked). Either way the answer is already durable before anyone is
// told.
//
// GET never writes ANYWHERE: this door is only ever reached from a POST /
// block-action / authed call. A `?answer=` query param PRE-FILLS a control; it
// never resolves.
//
// Ops decisions

import { notifyAskCancelled, notifyAskSettled } from './notifier';
import { answerAsk, cancelAsk, lookupAskByToken, type AskRecord, type CancelOutcome } from './store';
import type { AskId } from '../../../../generated/kysely/asks/Ask';

export type AskDoorOutcome =
  /** The token was not minted by this store — the caller should fall through to
   *  the legacy path (link page only; other callers treat it as not-found). */
  | { kind: 'not_ours' }
  /** No such ask (a bad id / a token this store minted but no longer has). */
  | { kind: 'not_found' }
  /** Answered just now — the run (if any) will resume. */
  | { kind: 'answered'; ask: AskRecord }
  /** Already settled (answered elsewhere / cancelled) or the token has lapsed —
   *  closed-request-wins: whoever raced sees the terminal state, nothing moves. */
  | { kind: 'closed'; ask: AskRecord }
  /** The submitted value did not fit the family's answer type. */
  | { kind: 'invalid'; message: string; ask: AskRecord };

/** Everything `writeAskResponse` can answer that is NOT an accepted answer —
 *  the refusal half of the one outcome vocabulary. */
export type AskResponseRefusal = Exclude<AskDoorOutcome, { kind: 'answered' }>;

/**
 * The Response write, refused. Thrown by the ADAPTER's write path, which has no
 * non-throwing failure channel (`createRecord` returns a `WriteResult` or
 * throws), and carries the outcome so nothing downstream has to match on a
 * string: a door, a router, or the run inspector branches on `.outcome.kind`
 * in the very same vocabulary the outcome-returning callers read.
 */
export class AskResponseRefused extends Error {
  constructor(readonly outcome: AskResponseRefusal) {
    super(refusalMessage(outcome));
    this.name = 'AskResponseRefused';
  }
}

function refusalMessage(outcome: AskResponseRefusal): string {
  switch (outcome.kind) {
    case 'not_ours':
    case 'not_found':
      return 'that request no longer exists — nothing can be answered against it';
    case 'closed':
      return `that request is already closed (${
        outcome.ask.state === 'answered' ? 'answered' : 'cancelled or expired'
      }) — the first answer stands`;
    case 'invalid':
      return `that answer was not accepted: ${outcome.message}`;
  }
}

/**
 * Answer a request — the edge write itself, and the ONLY place the answer
 * semantics live. Coercion against the family, the single-answer guard and
 * closed-request-wins all belong to the store's lattice transition; this maps
 * its result onto the caller-agnostic outcome vocabulary and tells whoever was
 * waiting on it.
 */
export async function writeAskResponse(input: {
  askId: AskId;
  answer: unknown;
}): Promise<AskDoorOutcome> {
  const outcome = await answerAsk({ id: input.askId, raw: input.answer });
  if (outcome.ok) {
    // The ask just settled — tell whoever was waiting. Awaited so a queued
    // delivery is durable before the answerer is told we took it; never throws,
    // so a notification fault cannot fail an accepted answer.
    await notifyAskSettled(outcome.ask);
    return { kind: 'answered', ask: outcome.ask };
  }
  switch (outcome.reason) {
    case 'not_found':
      return { kind: 'not_found' };
    case 'invalid':
      return { kind: 'invalid', message: outcome.message ?? 'that answer could not be accepted', ask: outcome.ask! };
    case 'settled':
    case 'expired':
      return { kind: 'closed', ask: outcome.ask! };
  }
}

/** Answer by capability token — the link page and the platform doors. Returns
 *  `not_ours` when the token is not a new-store token so the link page can hand
 *  off to the legacy resolver. */
export async function answerAskByToken(token: string, raw: unknown): Promise<AskDoorOutcome> {
  const ask = await lookupAskByToken(token);
  if (!ask) return { kind: 'not_ours' };
  return writeAskResponse({ askId: ask.id, answer: raw });
}

/** Answer by ask id — the agent (MCP) and the control tower. Returns
 *  `not_found` for an id this store does not own (the caller decides whether to
 *  try the legacy store next). */
export async function answerAskById(askId: AskId, raw: unknown): Promise<AskDoorOutcome> {
  return writeAskResponse({ askId, answer: raw });
}

/**
 * Cancel an open ask — the cancellation door, beside the answer door. Every
 * caller that cancels on purpose comes through here (`write a { Cancelled: true
 * }`, `POST /v1/asks/:id/cancel`), so a run parked on the ask is woken now and
 * its await resolves empty. Only the in-process waiter is told, and only where
 * one is registered: a cancel is not an answer, so the creator's settle
 * webhook stays the answer's alone.
 *
 * Run teardown (`abandonAskAwaits`) cancels through the store directly: it has
 * already withdrawn the parks, so there is nobody to wake.
 */
export async function cancelAskAndWake(input: { id: AskId }): Promise<CancelOutcome> {
  const outcome = await cancelAsk(input);
  if (outcome.ok) await notifyAskCancelled(outcome.ask);
  return outcome;
}
