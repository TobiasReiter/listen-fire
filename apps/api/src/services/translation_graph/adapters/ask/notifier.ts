// The settle notification seam (A-4, A-5).
//
// Answering an ask has always ended with one line: wake whoever is parked on
// it. That line named the movement engine, which is fine while the engine is in
// the same process and impossible when it is not — so the door now hands the
// settled record to an `AskSettledNotifier` and the deployment decides what
// that means.
//
//   • composed — the composition root registers a notifier that queues the
//     engine's durable wake for the ask, so the parked run resumes promptly
//     and the wake survives a restart.
//   • standalone — no engine exists. The waiter is whoever supplied a
//     `callback_url` when they created the ask, so the settle is enqueued into
//     `ask_webhook_delivery` and the worker signs and POSTs it.
//
// Which one runs is config, not registration order (`delivery_mode.ts`), so a
// deployment cannot accidentally do both and announce one answer twice.
//
// The notification is a COURTESY. The answer is already durable on the ask by
// the time we get here, and readable over `GET /v1/asks/:id` — a delivery that
// never lands loses a notification, never an answer.

import { getAsksQb } from '../../../../lib/kysely';
import { logger } from '../../../logger';
import { neverAsAny } from '../../../../lib/utils/types';
import { askSettleDelivery } from './delivery_mode';
import type { AskRecord } from './store';

/** What a deployment does when an ask settles. */
export interface AskSettledNotifier {
  notify(ask: AskRecord): Promise<void>;
}

let inProcessNotifier: AskSettledNotifier | null = null;

/**
 * Register the in-process notifier. Only meaningful in `local` delivery, and
 * only the composition root may call it — a second registration would be a
 * second notification path, which is the thing the mode exists to prevent.
 */
export function registerAskSettledNotifier(notifier: AskSettledNotifier): void {
  inProcessNotifier = notifier;
}

/** Enqueue the settle for signed delivery. No `callback_url` means the creator
 *  never asked to be told — they read the answer back instead. */
async function enqueueWebhookDelivery(ask: AskRecord): Promise<void> {
  if (!ask.callbackUrl) return;
  await getAsksQb(['ask_webhook_delivery'])
    .insertInto('ask_webhook_delivery')
    // The URL is snapshotted rather than joined at delivery time: a queued
    // notification belongs to the ask as it was when it settled.
    .values({ ask_id: ask.id, url: ask.callbackUrl })
    .execute();
}

/**
 * An ask settled — tell this deployment's one waiter. Never throws: the answer
 * is already committed, and a notification failure must not turn an accepted
 * answer into an error for the person who gave it.
 */
export async function notifyAskSettled(ask: AskRecord): Promise<void> {
  const mode = askSettleDelivery();
  try {
    switch (mode) {
      case 'local': {
        if (!inProcessNotifier) {
          // Standalone deployments set `webhook`. Local with nothing registered
          // is therefore a composed deployment whose root did not wire itself:
          // a run parked on this ask waits for the closed sweep, so say so loudly.
          logger.error(
            '[asks] an ask settled with no in-process notifier registered, but ASKS_SETTLE_DELIVERY is "local" — a run parked on it wakes only on the 30 s closed sweep',
            { askId: ask.id },
          );
          return;
        }
        await inProcessNotifier.notify(ask);
        return;
      }
      case 'webhook':
        await enqueueWebhookDelivery(ask);
        return;
      default:
        throw new Error(`Unknown ask settle delivery mode: ${neverAsAny(mode)}`);
    }
  } catch (err) {
    logger.error('[asks] failed to notify a settled ask (the answer is safe and readable)', {
      askId: ask.id,
      mode,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
