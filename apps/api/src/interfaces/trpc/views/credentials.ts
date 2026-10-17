import { z } from 'zod';

import type { ConnectMethod } from '../../../services/credentials/connect_link';
import type { SchemaTypeDescriptor } from 'movement-engine/public/catalog';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb, getQb } from '../../../lib/kysely';
import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { services } from '../../../adapters/registry';
import { decryptToken, encryptToken } from '../../../lib/credentials';
import { claimPendingCredentials } from '../../../lib/pendingCredentials';
import { logger } from 'movement-engine/public/log';
import { bindFlowToUser, extractStateFromUrl } from '../../../lib/oauthFlows';
import { slackCredsParser } from '../../../adapters/slack/webApi/apiClient';
import { affinityCredsParser } from '@lf/affinity/api_client';
import {
  airtableCredsParser,
  clearClientByCredentialsId,
} from '../../../adapters/airtable/apiClient';
import { attioCredsParser, getAttioClient } from '../../../adapters/attio/apiClient';
import { googleCredsParser } from '../../../adapters/google/authClient';
import {
  connectGmailByRefreshToken,
  gmailCredsParser,
  gmailDelegatedCredsParser,
  gmailRefreshTokenCredsParser,
  validateGmailMailbox,
} from '../../../adapters/gmail/apiClient';
import { forgetGmailTokenClient } from '../../../adapters/gmail/authClient';
import { gmailConnectMethod } from '../../../adapters/gmail/connect_method';
import { dropboxCredsParser } from '../../../adapters/dropbox/authClient';
import { nativeValuationsCredsParser } from '../../../services/translation_graph/adapters/native_valuations';
import { granolaCredsParser } from '../../../services/credentials/connect_form_spec';
import { evertraceCredsParser } from '@lf/evertrace/api_client';
import { dealroomCredsParser } from '@lf/dealroom/api_client';
import { credentialLifecycle } from '../../../services/credentials/credential_lifecycle';
import { persistCredential } from '../../../services/credentials/persist_credential';
import { intrinsicProvisionerForType } from '../../../services/credentials/intrinsic_provision';
import { connectMethodForType } from '../../../services/credentials/connect_link';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../lib/recording';
import { resolveAdapter } from '../../../services/translation_graph/adapters/resolve';
import { hasAdapter } from '../../../services/translation_graph/adapters/registry';
import { buildWebhookTargetUrl } from '../../../services/webhook_sync/urls';
import { describeExecutedVersion } from '../../../services/translation_graph/movement/version_store';
import { flattenTriggerRunPlans } from '../../../services/translation_graph/runs/trigger_run_read';
import { runCostSummaries } from '../../../lib/llm_usage';
import {
  schemaRefSchema,
  adapterTypeForRef,
  credentialsIdFromRef,
} from 'movement-engine/public/catalog';
import { TeamId } from '../../../generated/kysely/core/Team';
import { UserId } from '../../../generated/kysely/core/User';
import { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { reportedFailureReason } from '../../../services/translation_graph/runs/trigger_run';

function maybeFakeCreds<T extends Record<string, unknown>>(creds: T, serviceType: string): T {
  const ctx = currentContext();
  if (!isTestHarnessTeam(ctx.user.teamId)) return creds;
  return injectFakeBaseUrl(creds, serviceType) as T;
}

/**
 * What a Gmail save actually stores, checked live first.
 *
 * The connect-LINK forms (connect_form_spec.ts) check before storing anything;
 * the in-app modal skipped it, so a wrong address — or one this installation's
 * GMAIL_MAILBOX_ALLOWLIST does not name — only failed the first time a run
 * tried to use it. The same functions run here, so the two save paths can never
 * drift.
 *
 * Three things can arrive, and each is checked as itself: a typed mailbox
 * address (the delegated form), the claimed payload of a sign-in, and a pasted
 * refresh token. The last is the only one that RESOLVES to something else —
 * Google answers with the mailbox and the scopes, and that is what gets stored.
 */
async function gmailCredentialToStore(credentials: unknown): Promise<unknown> {
  const pasted = gmailRefreshTokenCredsParser.safeParse(credentials);
  if (pasted.success) {
    const entry = maybeFakeCreds(pasted.data, 'GOOGLE_GMAIL');
    const resolved = await connectGmailByRefreshToken({
      refreshToken: entry.refreshToken,
      ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
    });
    if (!resolved.ok) throw new Error(resolved.message);
    return resolved.credentials;
  }

  const verdict = await validateGmailMailbox(
    maybeFakeCreds(gmailCredsParser.parse(credentials), 'GOOGLE_GMAIL'),
  );
  if (!verdict.ok) {
    throw new Error(verdict.message);
  }
  return credentials;
}

/**
 * The credential + connected-system surface (M-24): everything the live
 * automations UI needs from the retired `pipelineConfiguration` grab-bag —
 * the vault CRUD, the per-provider OAuth connect URLs, the adapter
 * introspection the movement editor's schema formulas run on, and the
 * single-firing detail the activity view opens.
 *
 * `pipelineConfiguration` merges this router in so the legacy apps/app UI
 * keeps resolving `views.pipelineConfiguration.*` until it is deleted.
 */
const credentialsRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    getCredentials: userProcedure.query(async () => {
      const ctx = currentContext();
      const credentials = await getAutomationsQb(['external_service_credentials'])
        .selectFrom('external_service_credentials')
        .where('team_id', '=', ctx.user.teamId as TeamId)
        .select(['id', 'name', 'type', 'credentials', 'identifier'])
        .orderBy('name', 'asc')
        .execute();

      return credentials.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
      }));
    }),

    addCredential: userProcedure
      .input(
        z.intersection(
          z.object({
            name: z.string(),
          }),
          z.union([
            z.object({
              type: z.literal(ExternalServiceType.AFFINITY),
              credentials: affinityCredsParser,
            }),
            z.object({
              type: z.literal(ExternalServiceType.ATTIO),
              credentials: attioCredsParser,
            }),
            z.object({
              type: z.literal(ExternalServiceType.SLACK),
              credentials: slackCredsParser,
            }),
            z.object({
              type: z.literal(ExternalServiceType.AIRTABLE),
              credentials: airtableCredsParser,
            }),
            z.object({
              type: z.literal(ExternalServiceType.GOOGLE),
              credentials: googleCredsParser,
            }),
            z.object({
              type: z.literal(ExternalServiceType.GOOGLE_GMAIL),
              // Either Gmail connect form's posted values: a mailbox address
              // under the delegated method, a pasted refresh token under oauth.
              credentials: z.union([gmailRefreshTokenCredsParser, gmailDelegatedCredsParser]),
            }),
            z.object({
              type: z.literal(ExternalServiceType.DROPBOX),
              credentials: dropboxCredsParser,
            }),
            z.object({
              type: z.literal(ExternalServiceType.GRANOLA),
              credentials: granolaCredsParser,
            }),
            z.object({
              type: z.literal(ExternalServiceType.EVERTRACE),
              credentials: evertraceCredsParser,
            }),
            z.object({
              type: z.literal(ExternalServiceType.DEALROOM),
              credentials: dealroomCredsParser,
            }),
            // The intrinsic types — we own both ends of the auth. The caller
            // supplies no key; the server mints one with the right scope,
            // registers it for echo suppression, and stores the plaintext
            // alongside the api-key row id so the adapter can replay it and
            // delete can find the row to revoke. `baseUrl` is for a self-hoster
            // pointing at their own deployment; omitted, it resolves to this
            // instance.
            z.object({
              type: z.enum([
                ExternalServiceType.NATIVE_VALUATIONS,
                ExternalServiceType.NATIVE_KNOWLEDGE,
              ]),
              baseUrl: z.string().url().optional(),
            }),
            z.object({
              type: z.nativeEnum(ExternalServiceType),
              claimToken: z.string(),
            }),
          ]),
        ),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        let credentials: unknown;
        if ('claimToken' in input) {
          credentials = await claimPendingCredentials(input.claimToken, ctx.user.id);
        } else if (!('credentials' in input)) {
          // Intrinsic credential — the server mints + registers an Listen-Fire-owned
          // token. WHICH types those are is derived from the provisioner
          // registry rather than listed here, so adding one cannot leave this
          // branch behind (see intrinsic_provision.ts). Shared with the
          // author-time connect-link path so the two can never drift.
          const provisioner = intrinsicProvisionerForType(input.type);
          if (!provisioner) {
            throw new Error(`No intrinsic provisioner is registered for ${input.type}`);
          }
          ({ credentials } = await provisioner.provision({
            teamId: ctx.user.teamId as TeamId,
            userId: ctx.user.id as UserId,
            credentialName: input.name,
            baseUrl: 'baseUrl' in input ? input.baseUrl : undefined,
          }));
        } else {
          credentials = input.credentials;
        }

        if (input.type === ExternalServiceType.GOOGLE_GMAIL) {
          credentials = await gmailCredentialToStore(credentials);
        }

        await persistCredential({
          teamId: ctx.user.teamId as TeamId,
          userId: ctx.user.id as UserId,
          name: input.name,
          type: input.type,
          credentials,
        });
      }),

    updateCredential: userProcedure
      .input(
        z.intersection(
          z.object({
            id: z.string(),
            name: z.string(),
          }),
          z.union([
            z.object({
              type: z.literal(ExternalServiceType.AFFINITY),
              credentials: affinityCredsParser,
            }),
            z.object({
              type: z.literal(ExternalServiceType.ATTIO),
              credentials: attioCredsParser,
            }),
            z.object({
              type: z.literal(ExternalServiceType.SLACK),
              credentials: slackCredsParser,
            }),
            z.object({
              type: z.literal(ExternalServiceType.AIRTABLE),
              credentials: airtableCredsParser,
            }),
            z.object({
              type: z.literal(ExternalServiceType.GOOGLE),
              credentials: googleCredsParser,
            }),
            z.object({
              type: z.literal(ExternalServiceType.GOOGLE_GMAIL),
              // Either Gmail connect form's posted values: a mailbox address
              // under the delegated method, a pasted refresh token under oauth.
              credentials: z.union([gmailRefreshTokenCredsParser, gmailDelegatedCredsParser]),
            }),
            z.object({
              type: z.literal(ExternalServiceType.DROPBOX),
              credentials: dropboxCredsParser,
            }),
            z.object({
              type: z.literal(ExternalServiceType.GRANOLA),
              credentials: granolaCredsParser,
            }),
            z.object({
              type: z.literal(ExternalServiceType.EVERTRACE),
              credentials: evertraceCredsParser,
            }),
            z.object({
              type: z.literal(ExternalServiceType.DEALROOM),
              credentials: dealroomCredsParser,
            }),
            // NATIVE_VALUATIONS updates never rotate the api-key (re-mint
            // means a stale platform_owned_token entry — handled by
            // delete + add). Caller can only edit name + optional baseUrl;
            // we preserve apiKey + apiKeyId from the existing row.
            z.object({
              type: z.literal(ExternalServiceType.NATIVE_VALUATIONS),
              baseUrl: z.string().url().optional(),
            }),
            z.object({
              type: z.nativeEnum(ExternalServiceType),
              claimToken: z.string(),
            }),
          ]),
        ),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        const existing = await getAutomationsQb(['external_service_credentials'])
          .selectFrom('external_service_credentials')
          .where('id', '=', input.id as ExternalServiceCredentialsId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .select(['type', 'credentials'])
          .executeTakeFirstOrThrow();

        if (existing.type !== input.type) {
          throw new Error('Cannot change credentials type');
        }

        let credentials: unknown;
        if ('claimToken' in input) {
          credentials = await claimPendingCredentials(input.claimToken, ctx.user.id);
        } else if (input.type === ExternalServiceType.NATIVE_VALUATIONS) {
          const decrypted = await decryptToken(existing.credentials as Buffer, input.id);
          const prior = nativeValuationsCredsParser.parse(JSON.parse(decrypted));
          credentials = {
            apiKey: prior.apiKey,
            ...(prior.apiKeyId ? { apiKeyId: prior.apiKeyId } : {}),
            ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
          };
        } else {
          credentials = input.credentials;
        }

        if (input.type === ExternalServiceType.GOOGLE_GMAIL) {
          credentials = await gmailCredentialToStore(credentials);
        }

        const updateLifecycle = credentialLifecycle(input.type);
        if (updateLifecycle?.onUpdate) {
          const decrypted = await decryptToken(existing.credentials as Buffer, input.id);
          credentials = await updateLifecycle.onUpdate({
            credentials,
            teamId: ctx.user.teamId as TeamId,
            prior: JSON.parse(decrypted),
          });
        }

        const encrypted = await encryptToken(JSON.stringify(credentials), input.id);
        let identifier: string | null = null;
        if (input.type === ExternalServiceType.SLACK) {
          const creds = credentials as { teamId?: string; enterpriseId?: string };
          if (creds.teamId) {
            identifier = `teamId:${creds.teamId}`;
          } else if (creds.enterpriseId) {
            identifier = `enterpriseId:${creds.enterpriseId}`;
          }
        }

        await getAutomationsQb(['external_service_credentials'])
          .updateTable('external_service_credentials')
          .set({
            name: input.name,
            credentials: encrypted,
            identifier,
          })
          .where('id', '=', input.id as ExternalServiceCredentialsId)
          .executeTakeFirst();

        if (input.type === 'AIRTABLE') {
          clearClientByCredentialsId(input.id);
        }
        if (input.type === 'GOOGLE') {
          services.google?.authClient.removeClient(input.id);
        }
        if (input.type === ExternalServiceType.GOOGLE_GMAIL) {
          forgetGmailTokenClient(input.id);
        }
      }),

    deleteCredential: userProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        const credential = await getAutomationsQb(['external_service_credentials'])
          .selectFrom('external_service_credentials')
          .where('id', '=', input.id as ExternalServiceCredentialsId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .select(['id', 'type', 'credentials'])
          .executeTakeFirstOrThrow();

        if (credential.type === ExternalServiceType.GOOGLE) {
          services.google?.authClient.removeClient(credential.id);
        } else if (credential.type === ExternalServiceType.GOOGLE_GMAIL) {
          // Nothing is revoked at Google: under delegation there is no token at
          // all, and a sign-in's grant belongs to the account that made it, not
          // to a team's delete. What must go is the cached token client, or the
          // next connect under a reused id would reach for a dead token.
          forgetGmailTokenClient(credential.id);
        } else if (credential.type === ExternalServiceType.AIRTABLE) {
          clearClientByCredentialsId(credential.id);
        }

        // Best-effort source-side webhook deregistration. The
        // `webhook_subscription` rows themselves go away with the
        // credential (FK ON DELETE CASCADE), but the provider keeps
        // posting at a dead URL unless its external registration is
        // removed — and that removal needs the credential to still
        // authenticate, so it has to happen before the row is deleted.
        // Mirrors the listen-reconciliation teardown: failures never
        // block the delete (a dangling source-side webhook posts at a
        // row that no longer verifies, and is removable by hand).
        const webhookSubscriptions = await getAutomationsQb(['webhook_subscription'])
          .selectFrom('webhook_subscription')
          .where('credentials_id', '=', credential.id)
          .where('deleted_at', 'is', null)
          .select(['id', 'provider', 'external_webhook_id'])
          .execute();
        for (const subscription of webhookSubscriptions) {
          try {
            const adapter = await resolveAdapter({
              adapterType: subscription.provider,
              teamId: ctx.user.teamId as TeamId,
              credentialsId: credential.id as unknown as string,
            });
            if (typeof adapter.removeEventSubscription === 'function') {
              await adapter.removeEventSubscription({
                callbackUrl: buildWebhookTargetUrl(
                  subscription.provider,
                  subscription.id as unknown as string,
                ),
                ...(subscription.external_webhook_id !== null
                  ? { externalId: subscription.external_webhook_id }
                  : {}),
              });
            }
          } catch (err) {
            logger.warn('[credentials] webhook deregistration failed on delete', {
              subscriptionId: subscription.id,
              provider: subscription.provider,
              err,
            });
          }
        }

        // Owned-token teardown (Attio / Listen-Fire Valuations) — release any
        // external token tied to this credential before the row goes away.
        const deleteLifecycle = credentialLifecycle(credential.type);
        if (deleteLifecycle?.onDelete) {
          try {
            const decrypted = await decryptToken(credential.credentials as Buffer, credential.id);
            await deleteLifecycle.onDelete({
              credentials: JSON.parse(decrypted),
              teamId: ctx.user.teamId as TeamId,
            });
          } catch (err) {
            logger.warn('[credentials] owned-token teardown failed on delete', { err });
          }
        }

        await getAutomationsQb(['external_service_credentials'])
          .deleteFrom('external_service_credentials')
          .where('id', '=', input.id as ExternalServiceCredentialsId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .execute();
      }),

    /**
     * How THIS deployment connects each credential type — the same derivation
     * the movement catalog advertises. A type whose OAuth connector has no
     * client-id/secret here falls back to whatever else it can do (Attio: a
     * pasted access token), so the connect UI never offers a sign-in button
     * this server can't run.
     */
    connectMethods: userProcedure.query(() => {
      const methods: Partial<Record<ExternalServiceType, ConnectMethod>> = {};
      for (const type of Object.values(ExternalServiceType)) {
        methods[type] = connectMethodForType(type);
      }
      return methods;
    }),

    slackConnectUrl: userProcedure.mutation(async () => {
      const ctx = currentContext();
      const installUrl = await services.slack?.generateInstallUrl();
      if (installUrl) {
        const state = extractStateFromUrl(installUrl);
        if (state) bindFlowToUser(state, ctx.user.id);
      }
      return installUrl;
    }),

    airtableConnectUrl: userProcedure.mutation(async () => {
      const ctx = currentContext();
      const installUrl = await services.airtable?.generateInstallUrl();
      if (installUrl) {
        const state = extractStateFromUrl(installUrl);
        if (state) bindFlowToUser(state, ctx.user.id);
      }
      return installUrl;
    }),

    attioConnectUrl: userProcedure.mutation(async () => {
      const ctx = currentContext();
      const installUrl = await services.attio?.generateInstallUrl();
      if (installUrl) {
        const state = extractStateFromUrl(installUrl);
        if (state) bindFlowToUser(state, ctx.user.id);
      }
      return installUrl;
    }),

    googleConnectUrl: userProcedure.mutation(async () => {
      const ctx = currentContext();
      const installUrl = await services.google?.generateInstallUrl();
      if (installUrl) {
        const state = extractStateFromUrl(installUrl);
        if (state) bindFlowToUser(state, ctx.user.id);
      }
      return installUrl;
    }),

    /**
     * How THIS deployment connects a Gmail mailbox. `connectMethods` above
     * cannot answer it: under the sign-in method a deployment with no OAuth
     * client still offers a key-entry form, and so does the delegated method —
     * but one asks for a refresh token and the other for a mailbox address, and
     * the UI must not show the wrong one.
     */
    gmailConnectPolicy: userProcedure.query(() => ({
      method: gmailConnectMethod(),
      signIn: Boolean(services.gmail),
    })),

    // Only answers on a deployment that connects Gmail by sign-in; under the
    // delegated method `services.gmail` is unregistered and this returns
    // undefined.
    gmailConnectUrl: userProcedure.mutation(async () => {
      const ctx = currentContext();
      const installUrl = await services.gmail?.generateInstallUrl();
      if (installUrl) {
        const state = extractStateFromUrl(installUrl);
        if (state) bindFlowToUser(state, ctx.user.id);
      }
      return installUrl;
    }),

    dropboxConnectUrl: userProcedure.mutation(async () => {
      const ctx = currentContext();
      const installUrl = services.dropbox?.generateInstallUrl();
      if (installUrl) {
        const state = extractStateFromUrl(installUrl);
        if (state) bindFlowToUser(state, ctx.user.id);
      }
      return installUrl;
    }),

    attioListObjects: userProcedure
      .input(
        z.object({
          credentialsId: z.string().nullish(),
        }),
      )
      .query(async ({ input }) => {
        if (!input.credentialsId) {
          return [];
        }

        const credentials = await getAutomationsQb(['external_service_credentials'])
          .selectFrom('external_service_credentials')
          .select(['id', 'credentials'])
          .where('id', '=', input.credentialsId as ExternalServiceCredentialsId)
          .executeTakeFirstOrThrow();

        const decrypted = await decryptToken(credentials.credentials, input.credentialsId);
        const creds = maybeFakeCreds(attioCredsParser.parse(JSON.parse(decrypted)), 'ATTIO');

        // Introspection reads the credential directly: an Attio access token
        // authenticates the same whether OAuth minted it or the user pasted
        // it, so this must not depend on the OAuth connector being wired.
        return getAttioClient(creds.accessToken, creds.baseUrl).listObjects();
      }),

    /**
     * Lightweight adapter introspection. Returns:
     *   - `entries` — the catalog of entry-point types (writable record
     *     types + author-time meta-types). One or two API calls,
     *     no per-type attribute fan-out.
     *   - `runtimeCapabilities` — whole-adapter capability (incoming-edge
     *     traversal, edge properties, resources) that gates editor UI.
     *   - `supportedTriggers` — trigger kinds the adapter can fire,
     *     drives the input-trigger kind picker.
     *
     * All three are adapter-level (not per-type), so they ride together
     * in one round-trip. The surviving input editor consumes ADAPTER refs
     * only.
     */
    listEntryPoints: userProcedure
      .input(
        z.object({
          ref: schemaRefSchema,
          credentialsId: z.string().optional(),
        }),
      )
      .query(async ({ input }) => {
        const ctx = currentContext();
        const adapterType = adapterTypeForRef(input.ref);
        if (!adapterType || !hasAdapter(adapterType)) {
          return { entries: [], runtimeCapabilities: null, supportedTriggers: [] };
        }
        const adapter = await resolveAdapter({
          adapterType,
          teamId: ctx.user.teamId as TeamId,
          credentialsId:
            input.credentialsId ?? credentialsIdFromRef(input.ref) ?? undefined,
        });
        return {
          entries: await adapter.listEntryPoints(),
          runtimeCapabilities: adapter.runtimeCapabilities(),
          supportedTriggers: adapter.supportedTriggers,
        };
      }),

    /**
     * Batched on-demand fetcher for type descriptors — the input editor's
     * primary schema-introspection primitive. Pass every typeId the editor
     * needs and get back a map of full descriptors in one round-trip. The
     * adapter's `describe(typeId)` is the source of truth; per-type
     * attribute fetches are lazy + cached inside the adapter.
     */
    describeTypes: userProcedure
      .input(
        z.object({
          ref: schemaRefSchema,
          credentialsId: z.string().optional(),
          typeIds: z.array(z.string()),
        }),
      )
      .query(async ({ input }) => {
        const ctx = currentContext();
        const adapterType = adapterTypeForRef(input.ref);
        if (!adapterType || !hasAdapter(adapterType) || input.typeIds.length === 0)
          return {};
        const adapter = await resolveAdapter({
          adapterType,
          teamId: ctx.user.teamId as TeamId,
          credentialsId:
            input.credentialsId ?? credentialsIdFromRef(input.ref) ?? undefined,
        });
        const out: Record<string, SchemaTypeDescriptor> = {};
        await Promise.all(
          input.typeIds.map(async (typeId) => {
            const t = await adapter.describe(typeId);
            if (t) out[typeId] = t;
          }),
        );
        return out;
      }),

    /**
     * Full detail of a single firing, including its steps + trigger_payload.
     * `steps` carries each orchestration step's applied plans / diagnostics
     * / errors; `appliedActionPlans` is the flattened firing-level union for
     * callers that want the whole action tree at once.
     */
    getTgRun: userProcedure
      .input(z.object({ runId: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();
        const row = await getAutomationsQb(['trigger_run'])
          .selectFrom('trigger_run')
          .where('id', '=', input.runId as TriggerRunId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .selectAll()
          .executeTakeFirst();
        if (!row) throw new Error(`trigger_run ${input.runId} not found`);
        const cost = (await runCostSummaries([row.id as unknown as TriggerRunId])).get(
          row.id as unknown as string,
        );
        return {
          ...row,
          // A note on a run still going is not a failure (reportedFailureReason).
          failure_reason: reportedFailureReason(row),
          appliedActionPlans: flattenTriggerRunPlans(row.steps),
          // Which saved version actually ran — a firing from before the
          // last save executed older logic than the editor is showing.
          executedVersion: await describeExecutedVersion({
            versionId: row.movement_version_id,
          }),
          // Model-call cost this firing incurred, rolled up from
          // `llm_usage` — zero when it made no model calls.
          costMicrodollars: cost?.costMicrodollars ?? 0,
          calls: cost?.calls ?? 0,
          inputTokens: cost?.inputTokens ?? 0,
          outputTokens: cost?.outputTokens ?? 0,
        };
      }),
  });
};

export { credentialsRouter };
