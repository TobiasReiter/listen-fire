// tRPC management endpoints
// auto vs manual registration
import { z } from 'zod';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import type { WebhookSubscriptionId } from '../../../generated/kysely/automations/WebhookSubscription';

import { trpc } from '../trpc';
import { currentContext } from '../../../services/context';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { getAutomationsQb } from '../../../lib/kysely';
import {
  getWebhookProvider,
  getWebhookProviderMeta,
  listWebhookProviders,
} from '../../../services/webhook_sync/providers';
import { buildWebhookTargetUrl as buildTargetUrl } from '../../../services/webhook_sync/urls';

const webhookSubscriptionsRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    /** Surface the set of providers the webhook-sync framework supports so
     *  the UI can offer "Create subscription" only for integrations we know
     *  how to wire up. Keeps the hardcoded provider keys server-side. */
    listProviders: userProcedure.query(() => listWebhookProviders()),

    list: userProcedure.query(async () => {
      const ctx = currentContext();
      const rows = await getAutomationsQb(['webhook_subscription'])
        .selectFrom('webhook_subscription')
        .where('webhook_subscription.team_id', '=', ctx.user.teamId as TeamId)
        .where('webhook_subscription.deleted_at', 'is', null)
        .select([
          'webhook_subscription.id',
          'webhook_subscription.provider',
          'webhook_subscription.credentials_id',
          'webhook_subscription.external_webhook_id',
          'webhook_subscription.webhook_secret',
          'webhook_subscription.status',
          'webhook_subscription.subscriptions',
          'webhook_subscription.created_at',
        ])
        .orderBy('webhook_subscription.created_at', 'desc')
        .execute();
      return rows.map((row) => {
        const meta = getWebhookProviderMeta(row.provider);
        return {
          id: row.id,
          provider: row.provider,
          credentials_id: row.credentials_id,
          external_webhook_id: row.external_webhook_id,
          /** Manual-mode subscriptions need to surface the secret so the
           *  operator can paste it into the source system. Auto-mode
           *  subscriptions hide it (it's the source's secret, never used
           *  by the operator). */
          webhook_secret:
            meta && !meta.canRegisterViaApi ? row.webhook_secret : null,
          status: row.status,
          subscriptions: row.subscriptions,
          created_at: row.created_at,
          targetUrl: buildTargetUrl(row.provider, row.id),
          /** Whether this provider auto-registered via the source API or
           *  whether the operator needs to do manual setup. */
          canRegisterViaApi: meta?.canRegisterViaApi ?? true,
          setupInstructions: meta?.setupInstructions ?? null,
        };
      });
    }),

    create: userProcedure
      .input(
        z.object({
          credentialsId: z.string(),
          provider: z.string(),
          /** Provider-shaped event-type strings. Omit to use the
           *  provider's `defaultEventTypes` — preferred path from the
           *  UI, which doesn't know per-provider shapes. */
          eventTypes: z.array(z.string()).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        const providerKey = input.provider.toUpperCase();

        const provider = getWebhookProvider(providerKey);
        if (!provider) {
          throw new Error(`Unsupported webhook provider: ${input.provider}`);
        }
        const eventTypes =
          input.eventTypes && input.eventTypes.length > 0
            ? input.eventTypes
            : [...provider.defaultEventTypes];

        // Insert a placeholder so we can compute the target URL (which
        // contains the row id). We finalize the row after registration.
        const sub = await getAutomationsQb(['webhook_subscription'])
          .insertInto('webhook_subscription')
          .values({
            team_id: teamId,
            provider: providerKey,
            credentials_id: input.credentialsId as ExternalServiceCredentialsId,
            webhook_secret: 'pending',
            subscriptions: JSON.stringify(
              eventTypes.map((e) => ({ event_type: e })),
            ),
            status: 'pending',
          })
          .returning(['id'])
          .executeTakeFirstOrThrow();

        const targetUrl = buildTargetUrl(providerKey, sub.id);

        try {
          // Both auto and manual providers go through this single call —
          // auto providers hit the source API and return externalId+secret,
          // manual providers generate a local secret and leave externalId
          // undefined.
          const registration = await provider.registerSubscription({
            credentialsId: input.credentialsId,
            targetUrl,
            eventTypes,
          });

          await getAutomationsQb(['webhook_subscription'])
            .updateTable('webhook_subscription')
            .set({
              external_webhook_id: registration.externalId ?? null,
              webhook_secret: registration.secret,
              status: 'active',
              updated_at: new Date(),
            })
            .where('webhook_subscription.id', '=', sub.id)
            .execute();

          return {
            id: sub.id,
            targetUrl,
            status: 'active',
            canRegisterViaApi: provider.canRegisterViaApi,
            // Surface the secret on creation only when manual — the
            // operator needs it to paste into the source system. For auto
            // providers the secret is the source's, never user-facing.
            webhookSecret: provider.canRegisterViaApi ? null : registration.secret,
            setupInstructions: provider.setupInstructions ?? null,
          };
        } catch (err) {
          await getAutomationsQb(['webhook_subscription'])
            .deleteFrom('webhook_subscription')
            .where('webhook_subscription.id', '=', sub.id)
            .execute();
          throw err;
        }
      }),

    delete: userProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const sub = await getAutomationsQb(['webhook_subscription'])
          .selectFrom('webhook_subscription')
          .where('webhook_subscription.id', '=', input.id as WebhookSubscriptionId)
          .where('webhook_subscription.team_id', '=', ctx.user.teamId as TeamId)
          .where('webhook_subscription.deleted_at', 'is', null)
          .select([
            'webhook_subscription.id',
            'webhook_subscription.provider',
            'webhook_subscription.credentials_id',
            'webhook_subscription.external_webhook_id',
          ])
          .executeTakeFirst();

        if (!sub) throw new Error('Subscription not found');

        // Deregister via the provider when (a) we know the source's id
        // (auto-registered) and (b) the provider implements deregistration.
        // Manual providers expose nothing to call into; the operator
        // removes the webhook on the source side.
        const provider = getWebhookProvider(sub.provider);
        if (sub.external_webhook_id && provider?.deregisterSubscription && sub.credentials_id !== null) {
          try {
            await provider.deregisterSubscription({
              credentialsId: sub.credentials_id,
              externalId: sub.external_webhook_id,
            });
          } catch {
            // Non-fatal — still soft-delete locally.
          }
        }

        await getAutomationsQb(['webhook_subscription'])
          .updateTable('webhook_subscription')
          .set({ deleted_at: new Date(), status: 'disabled', updated_at: new Date() })
          .where('webhook_subscription.id', '=', sub.id)
          .execute();
      }),
  });
};

export { webhookSubscriptionsRouter };
