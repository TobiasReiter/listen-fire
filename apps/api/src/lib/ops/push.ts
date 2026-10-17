import webpush from 'web-push';

import { logger } from 'movement-engine/public/log';
import { getQb } from '../kysely';
import { OpsEventId } from '../../generated/kysely/public/OpsEvent';
import { renderPushPayload, PushPayload } from './render';
import { loadActiveSubscriptions, deleteSubscription, ActiveSubscription } from './subscriptions';

// Resolved once per process. 'disabled' latches so a missing-VAPID deployment
// logs the warning a single time, not once per notification. (Render restarts
// on an env change, so adding keys later re-evaluates from 'unknown'.)
//
// VAPID_SUBJECT is as required as the keys, not a nicety with a default: it is
// the contact a push relay uses to report abuse, and it used to default to
// Listen-Fire's inbox — so someone else's deployment sent us their complaints. Push
// is optional, so an unset subject turns the whole feature off rather than
// signing this deployment's notifications with a stranger's address.
let vapidState: 'unknown' | 'ready' | 'disabled' = 'unknown';
function ensureVapid(): boolean {
  if (vapidState !== 'unknown') return vapidState === 'ready';
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    logger.warn(
      'ops push disabled — VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (this deployment\'s mailto: or https contact) must all be set',
    );
    vapidState = 'disabled';
    return false;
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidState = 'ready';
  return true;
}

export async function sendToSubscriptions(payload: PushPayload, eventId: string): Promise<void> {
  if (!ensureVapid()) return;
  const subs = await loadActiveSubscriptions();
  const body = JSON.stringify({ ...payload, eventId });
  await Promise.allSettled(subs.map((sub) => sendOne(sub, body)));
}

async function sendOne(sub: ActiveSubscription, body: string): Promise<void> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      body,
    );
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.statusCode === 410) {
      await deleteSubscription(sub.id);
    } else {
      logger.warn('ops push delivery failed', { endpoint: sub.endpoint, error: err });
    }
  }
}

export async function dispatchPush(eventId: string): Promise<void> {
  const event = await getQb(['ops_event'])
    .selectFrom('ops_event')
    .selectAll()
    .where('id', '=', eventId as OpsEventId)
    .executeTakeFirst();
  if (!event) return;
  await sendToSubscriptions(renderPushPayload(event), eventId);
}
