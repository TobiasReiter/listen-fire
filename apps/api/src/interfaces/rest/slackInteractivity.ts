// The "Listen-Fire" Slack app's Interactivity Request URL — POST /api/public/slack-actions.
// Every tap on a control this platform posted arrives here. A block action is a
// POST by construction, so this is the true one-tap path (GET never writes
// anywhere — 5_build_order Ops decisions).
//
// What a tap CARRIES is one opaque callback id, in `value` or `action_id`; the
// door recognises the id's namespace prefix and hands it to the router, which
// owns everything that happens next. The door keeps only what is genuinely
// Slack-shaped: signature verification, the ack, and the message edit.
//
// Legacy ask answer links (`<url-or-token>?answer=`) stay RECOGNISED for
// movements authored before callbacks — tried after the prefix check, no longer
// taught — and retire once those are re-authored.
//
// Belongs to the SAME Slack app as the Events door (slackEvents.ts) — one signing
// secret (SLACK_MOVEMENTS_SIGNING_SECRET), verified over the raw body. The opaque
// payload id IS the authorisation, so this mounts BEFORE the auth middleware
// (like the ask link route). It never touches a credential.
//
// Ops decisions

import { Router } from 'express';

import type { Request, Response } from 'express';

import { logger } from 'movement-engine/services/logger';
import { verifySlackEventsRequest } from './slackEvents';
import { answerAskByToken, type AskDoorOutcome } from '../../services/translation_graph/adapters/ask/answer_door';
import { parseAskAction, parseAskLink } from '../../services/translation_graph/adapters/ask/answer_link';
import { isCallbackId } from '../../services/movement_engine/callback_store';
import {
  callbackAckText,
  fireCallback,
  interactionServed,
  type CallbackFireOutcome,
} from '../../services/movement_engine/callback_fire';

// The link parse lives with the minting (`adapters/ask`), not with Slack: a
// second platform door (Telegram's callback queries) reads the same shapes, and
// neither door should have to import the other's route to get at them. Still
// re-exported here — this route was the parser's first home and its callers
// name it there.
export { parseAskAction };

const slackInteractivityRouter: ReturnType<typeof Router> = Router();

export interface BlockAction {
  action_id?: unknown;
  value?: unknown;
  /** A `static_select`'s choice carries its own payload at
   *  `selected_option.value`, never on the action's own `value` (that field
   *  is a button's). */
  selected_option?: { value?: unknown };
  /** `datepicker` tap-time value — `YYYY-MM-DD`, or `null` when cleared. */
  selected_date?: unknown;
  /** `timepicker` tap-time value — `HH:mm`, or `null` when cleared. */
  selected_time?: unknown;
}

interface BlockActionsPayload {
  type?: string;
  response_url?: string;
  actions?: BlockAction[];
}

/**
 * The pre-wired payload out of one block action, whichever Slack shape it
 * arrived in: a button's own `value`, or a `static_select`'s chosen
 * `selected_option.value`. Neither present (or not a string) → `undefined`,
 * meaning the action carries nothing this door could have wired into it.
 */
export function blockActionValue(action: BlockAction): string | undefined {
  if (typeof action.value === 'string') return action.value;
  return typeof action.selected_option?.value === 'string' ? action.selected_option.value : undefined;
}

/**
 * The value Slack captured AT TAP TIME — a `datepicker`'s `selected_date`, a
 * `timepicker`'s `selected_time`, a dispatch-triggered `plain_text_input`'s
 * entered `value`, or (a select that keys off `action_id`) the chosen
 * `selected_option.value`. Undefined when the action carries none of these
 * (e.g. a plain button, whose `value` IS its pre-wired payload, not a tap-time
 * capture — those never reach here, because every resolver tries the pre-wired
 * slot first).
 */
function tapTimeValue(action: BlockAction): string | undefined {
  if (typeof action.selected_date === 'string') return action.selected_date;
  if (typeof action.selected_time === 'string') return action.selected_time;
  if (typeof action.value === 'string') return action.value;
  return typeof action.selected_option?.value === 'string' ? action.selected_option.value : undefined;
}

/** What one block action turned out to be. `null` — the ordinary case — means
 *  some other block action Slack sent, which flows through untouched. */
export type ResolvedBlockAction =
  | {
      kind: 'callback';
      id: string;
      /** Slack's ONE tap-time capture, unnamed. The router binds it (see
       *  `bindSuppliedValue`); the door never guesses a parameter name. */
      suppliedValue?: string;
    }
  /** LEGACY: an ask answer link wired in before callbacks existed. */
  | { kind: 'ask'; token: string; answer: string };

/**
 * Recognition, in precedence order:
 *
 *  1. **A callback id** — the one prefix check, on the pre-wired slot first
 *     (`value` / `selected_option.value`: a button or a per-option select,
 *     where the id alone says what the tap meant), then on `action_id` (a
 *     control whose value does not exist until the tap — a `datepicker`,
 *     `timepicker` or text input — which has no `value` field to carry an id).
 *     From `action_id`, whatever the tap captured rides along as the supplied
 *     value.
 *  2. **A legacy ask answer link** — kept working for movements authored before
 *     callbacks, no longer taught, retiring once those are re-authored.
 *
 * A pre-wired callback id beats everything: it is the current mechanism, and an
 * author who wired one meant it.
 */
export function resolveBlockAction(action: BlockAction): ResolvedBlockAction | null {
  const preWired = blockActionValue(action);
  if (preWired !== undefined && isCallbackId(preWired)) return { kind: 'callback', id: preWired };

  const actionId = typeof action.action_id === 'string' ? action.action_id : undefined;
  if (actionId !== undefined && isCallbackId(actionId)) {
    const supplied = tapTimeValue(action);
    return supplied === undefined
      ? { kind: 'callback', id: actionId }
      : { kind: 'callback', id: actionId, suppliedValue: supplied };
  }

  const ask = resolveAskAction(action);
  return ask === null ? null : { kind: 'ask', ...ask };
}

/**
 * LEGACY (migration window): resolve one block action to an
 * ask `{ token, answer }`, or null when it isn't an ask action at all. Reached
 * only after the callback prefix check has declined. Precedence:
 *
 *  1. Pre-wired: `value` / `selected_option.value` parses to a full answer
 *     link (`?answer=` present) — today's button/select wiring.
 *  2. Tap-time: `action_id` parses to an ask token.
 *     - carries its own `?answer=` → honoured as-is (fixed-answer elements,
 *       e.g. a `datepicker` used as a plain trigger, that have no `value`
 *       field to pre-wire an answer link into).
 *     - bare token → paired with whatever tap-time value the action itself
 *       carries (`selected_date` / `selected_time` / entered text / a
 *       select's `selected_option.value`). No tap-time value present on an
 *       otherwise ask-shaped `action_id` is a MALFORMED ask action (author
 *       wired the token onto an element that can't supply one) — logged
 *       loudly rather than silently dropped, then ignored like any other
 *       action Slack sent that isn't answerable.
 *
 *  An `action_id` with no ask-token prefix at all is not an ask action —
 *  the ordinary case for every non-ask block action — and is ignored
 *  silently.
 */
export function resolveAskAction(action: BlockAction): { token: string; answer: string } | null {
  const preWired = blockActionValue(action);
  if (preWired !== undefined) {
    const parsed = parseAskAction(preWired);
    if (parsed) return parsed;
  }

  const actionId = typeof action.action_id === 'string' ? action.action_id : undefined;
  if (actionId === undefined) return null;
  const linked = parseAskLink(actionId);
  if (!linked) return null; // not ask-shaped — an ordinary block action's action_id.
  if (linked.answer !== undefined) return { token: linked.token, answer: linked.answer };

  const tapValue = tapTimeValue(action);
  if (tapValue === undefined) {
    logger.warn('[slack/actions] ask action_id parsed but the action carries no tap-time value', {
      actionId,
    });
    return null;
  }
  return { token: linked.token, answer: tapValue };
}

slackInteractivityRouter.post('/', async (req: Request, res: Response) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));

  const auth = verifySlackEventsRequest(rawBody, req.headers);
  if (!auth.authorized) {
    if (auth.reason === 'no_secret') {
      logger.error('[slack/actions] REJECTING: SLACK_MOVEMENTS_SIGNING_SECRET is unset.');
    } else {
      logger.warn('[slack/actions] dropping inbound: Slack signature missing or invalid.');
    }
    res.status(auth.reason === 'no_secret' ? 500 : 401).json({ ok: false });
    return;
  }

  // Interactivity payloads arrive urlencoded as `payload=<json>`.
  const payload = parsePayload(rawBody);
  if (!payload || payload.type !== 'block_actions') {
    // Ack anything else (e.g. a shortcut) without acting — Slack needs a 200.
    res.status(200).json({ ok: true });
    return;
  }

  // Ack the interaction immediately (Slack's 3s budget); do the answer + message
  // edit off the request cycle, addressed by the payload's response_url.
  res.status(200).json({ ok: true });
  setImmediate(() => {
    void handleBlockActions(payload).catch((err) => {
      logger.error('[slack/actions] handling failed:', err);
    });
  });
});

async function handleBlockActions(payload: BlockActionsPayload): Promise<void> {
  const responseUrl = typeof payload.response_url === 'string' ? payload.response_url : undefined;
  for (const action of payload.actions ?? []) {
    const resolved = resolveBlockAction(action);
    if (!resolved) continue;

    if (resolved.kind === 'callback') {
      let outcome: CallbackFireOutcome;
      try {
        outcome = await fireCallback({
          id: resolved.id,
          values: {},
          ...(resolved.suppliedValue !== undefined ? { suppliedValue: resolved.suppliedValue } : {}),
        });
      } catch (err) {
        // The tapper still hears back — silence reads as "it worked" — and the
        // failure itself is not swallowed.
        logger.error('[slack/actions] callback firing failed', {
          id: resolved.id,
          error: err instanceof Error ? err.message : String(err),
        });
        if (responseUrl) {
          await postToResponseUrl(responseUrl, {
            response_type: 'ephemeral',
            replace_original: false,
            text: 'Something went wrong recording that.',
          });
        }
        return;
      }
      if (responseUrl) await ackCallbackToSlack(responseUrl, outcome);
    } else {
      const outcome = await answerAskByToken(resolved.token, resolved.answer);
      if (responseUrl) await ackToSlack(responseUrl, outcome);
    }
    // One control per message in practice — stop after the first action this
    // door owns so a stray second action can't double-ack.
    return;
  }
}

/** Ack a fired callback via the payload's response_url. The message itself is
 *  replaced only when the tap SERVED it (`interactionServed` — the shared,
 *  provisional rule); everything else is an ephemeral notice, so a message whose
 *  controls are still live keeps them, and a refusal never rewrites what the
 *  person who acted first is looking at. */
async function ackCallbackToSlack(responseUrl: string, outcome: CallbackFireOutcome): Promise<void> {
  const text = callbackAckText(outcome);
  const body = interactionServed(outcome)
    ? {
        replace_original: true,
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: ${text}` } }],
      }
    : { response_type: 'ephemeral', replace_original: false, text };

  await postToResponseUrl(responseUrl, body);
}

/** LEGACY (migration window): ack a resolved (or already-closed) ask by editing
 *  the Slack message via its response_url — replacing the buttons with a
 *  confirmation line. A late click on a settled/expired ask gets an EPHEMERAL
 *  "closed" notice instead (closed-request-wins), so the original message is
 *  left intact for whoever answered. */
async function ackToSlack(responseUrl: string, outcome: AskDoorOutcome): Promise<void> {
  const body =
    outcome.kind === 'answered'
      ? {
          replace_original: true,
          text: 'Thanks — your answer was recorded.',
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: ':white_check_mark: Thanks — your answer was recorded.' },
            },
          ],
        }
      : outcome.kind === 'invalid'
        ? { response_type: 'ephemeral', replace_original: false, text: `That answer could not be accepted: ${outcome.message}` }
        : { response_type: 'ephemeral', replace_original: false, text: 'This request was already closed.' };

  await postToResponseUrl(responseUrl, body);
}

async function postToResponseUrl(responseUrl: string, body: unknown): Promise<void> {
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    logger.warn('[slack/actions] response_url ack failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function parsePayload(rawBody: Buffer): BlockActionsPayload | null {
  const params = new URLSearchParams(rawBody.toString('utf-8'));
  const raw = params.get('payload');
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as BlockActionsPayload;
  } catch {
    return null;
  }
}

export { slackInteractivityRouter };
