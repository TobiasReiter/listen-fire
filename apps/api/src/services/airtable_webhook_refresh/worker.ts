// Airtable webhook refresh worker — keeps movement-derived Airtable webhooks
// alive past Airtable's 7-day expiry.
//
// Airtable disables a webhook 7 days after its last activity. An inbound
// delivery already extends that window (we pull the payload feed, which Airtable
// counts as activity), so a busy webhook never needs help — only QUIET ones do.
// `webhook_subscription.updated_at` advances on every checkpoint write (i.e.
// every pull) and on an explicit refresh here, so it tracks "last time the
// window was extended". This worker refreshes any Airtable subscription whose
// window is older than REFRESH_AFTER, well before the 7-day cliff.
//
// A periodic work row (`airtable_webhook_refresh`) on the automations drain;
// the row's lease is what keeps a second instance from scanning at the same
// time. Failures are contained per row — one bad credential never starves the
// rest.

import type { WorkHandler } from '../work/kinds';
import type { WorkKindRegistration } from '../work/drain';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { WebhookSubscriptionId } from '../../generated/kysely/automations/WebhookSubscription';

import { logger } from 'movement-engine/public/log';
import { getAutomationsQb } from '../../lib/kysely';
import { HOUR } from '../../constants';
import { MOVEMENT_LISTEN_PROVISIONER } from '../translation_graph/movement/listen_subscriptions';
import { getAdapter } from '../translation_graph/adapters/registry';

/** The webhook_subscription.provider key for Airtable (the uppercase trigger
 *  kind; see webhook_sync/providers/index.ts). */
const AIRTABLE_PROVIDER_KEY = 'AIRTABLE';

export const AIRTABLE_WEBHOOK_SCAN_INTERVAL = HOUR;
/** Refresh once a webhook's window is older than this — 1 day of headroom
 *  before Airtable's 7-day expiry. */
const REFRESH_AFTER = 6 * 24 * HOUR;

/** Parse a `scope` jsonb cell (object, or a serialized string from test fakes)
 *  into a flat string map. */
function scopeOf(rawValue: unknown): Record<string, string> {
  let raw = rawValue;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (raw === null || typeof raw !== 'object') return {};
  const scope: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') scope[k] = v;
  }
  return scope;
}

export async function refreshDueAirtableWebhooks(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - REFRESH_AFTER);
  const rows = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('provider', '=', AIRTABLE_PROVIDER_KEY)
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .where('deleted_at', 'is', null)
    .where('status', '=', 'active')
    .where('external_webhook_id', 'is not', null)
    .where('updated_at', '<', cutoff)
    .select([
      'id',
      'team_id',
      'credentials_id',
      'external_webhook_id',
      'scope',
    ])
    .execute();

  for (const row of rows) {
    try {
      if (row.credentials_id === null || row.external_webhook_id === null) continue;
      const scope = scopeOf(row.scope);
      if (typeof scope.base !== 'string') {
        logger.warn('[AirtableWebhookRefresh] subscription has no base scope; skipping', {
          subscriptionId: row.id,
        });
        continue;
      }

      // Whichever line Airtable is on: its module or its legacy adapter. The
      // refresh is not on the protocol (only Airtable's webhooks expire), so
      // it is the in-process adapter's own method.
      const adapter = getAdapter({
        adapterType: 'airtable',
        teamId: row.team_id as TeamId,
        credentialsId: row.credentials_id as unknown as string,
      });
      const refresh: unknown = Reflect.get(adapter, 'refreshEventSubscription');
      if (typeof refresh !== 'function') {
        throw new Error('the Airtable adapter cannot refresh a webhook subscription');
      }
      await Reflect.apply(refresh, adapter, [{ externalId: row.external_webhook_id, scope }]);

      // Advance the window mark so it isn't re-refreshed until the next cycle.
      await getAutomationsQb(['webhook_subscription'])
        .updateTable('webhook_subscription')
        .set({ updated_at: now })
        .where('id', '=', row.id as WebhookSubscriptionId)
        .execute();

      logger.info('[AirtableWebhookRefresh] refreshed webhook', {
        subscriptionId: row.id,
        webhookId: row.external_webhook_id,
      });
    } catch (err) {
      logger.error('[AirtableWebhookRefresh] refresh failed for subscription', {
        subscriptionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const airtableWebhookRefreshHandler: WorkHandler = {
  async run(_payload, ctx) {
    await refreshDueAirtableWebhooks(ctx.now);
  },
};

// The Airtable adapter's own periodic kind: its webhook subscriptions expire
// unless refreshed. The adapter registry hands it to the process that drains
// (`adapterWorkKinds`).

declare module '../work/kinds' {
  interface UnitWorkKinds {
    airtable_webhook_refresh: true;
  }
}

export const AIRTABLE_WORK_KINDS: readonly WorkKindRegistration[] = [
  { kind: 'airtable_webhook_refresh', handler: airtableWebhookRefreshHandler, intervalMs: AIRTABLE_WEBHOOK_SCAN_INTERVAL },
];
