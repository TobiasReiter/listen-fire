import { logger } from 'movement-engine/public/log';

/**
 * What every inbound webhook door does when it has NO secret to verify against.
 *
 * The doors used to answer this themselves, identically and wrongly: reject in
 * production, allow everywhere else. "Everywhere else" is any staging box, any
 * review app, any laptop with a tunnel — each of which is on the public
 * internet with an unauthenticated ingress that fires real automations. NODE_ENV
 * is a build flag, not a network boundary.
 *
 * So it fails CLOSED, and the dev loop (which injects unsigned Slack, Telegram
 * and WhatsApp deliveries) opens it EXPLICITLY with `ALLOW_UNSIGNED_WEBHOOKS`.
 * The bypass never applies in production, whatever the variable says — an
 * environment that can be talked into accepting forged deliveries by setting
 * one env var is not fail-closed — and it says so out loud, once per door, so
 * an operator who set it for a laptop and inherited it on a shared box finds
 * the reason in the logs rather than in an incident.
 *
 * One helper, one rule: the doors differ in how they verify a secret they HAVE,
 * never in what they do without one.
 */

const warnedDoors = new Set<string>();

type UnsignedWebhookAuth = { authorized: true } | { authorized: false; reason: 'no_secret' };

/**
 * The decision a door makes when its signing secret is unset. `door` is the
 * human name of the ingress ("slack/events", "telegram/builtin") and appears in
 * the warning.
 */
function authorizeUnsignedWebhook(door: string): UnsignedWebhookAuth {
  if (process.env.NODE_ENV === 'production') return { authorized: false, reason: 'no_secret' };
  if (process.env.ALLOW_UNSIGNED_WEBHOOKS !== 'true') {
    return { authorized: false, reason: 'no_secret' };
  }

  if (!warnedDoors.has(door)) {
    warnedDoors.add(door);
    logger.warn(
      `[${door}] ALLOW_UNSIGNED_WEBHOOKS=true — this door is accepting UNSIGNED, ` +
        'UNAUTHENTICATED deliveries because no signing secret is configured. Anyone ' +
        'who can reach this host can fire it. Never set this on anything the public ' +
        'internet can reach.',
    );
  }
  return { authorized: true };
}

export { authorizeUnsignedWebhook, type UnsignedWebhookAuth };
