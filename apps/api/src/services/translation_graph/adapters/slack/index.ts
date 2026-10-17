// Slack's legacy line: the module's adapter (@lf/slack) over the credential
// path the platform used before modules — the stored credential decrypted
// here, the dev loop's fake for the test-harness team — and over the
// platform's own model and file redemption. Kept so the `BUILTIN_MODULES`
// line for Slack can go back to `legacy` in one edit while the module line is
// new; remove it with the line once the module line has soaked.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';
import type { WebhookEvent } from '../../../webhook_sync/providers/interface';
import type { Adapter, DiscriminableEvent, FileRef } from 'movement-engine/public/adapter';
import type { SlackComposeChat, SlackSources } from '@lf/slack';

import { SLACK_MESSAGE_EVENT_TYPES, SlackAdapter as SlackModuleAdapter, composeSlackMessage } from '@lf/slack';
import { getSlackClient, slackCredsParser } from '../../../../adapters/slack/webApi/apiClient';
import { webhookEventToDiscriminable } from '../../../webhook_sync/event_conversion';
import { decryptToken } from '../../../../lib/credentials';
import { getAutomationsQb } from '../../../../lib/kysely';
import { injectFakeBaseUrl, isTestHarnessTeam } from '../../../../lib/recording';
import { logger } from 'movement-engine/public/log';
import { streamFileRef } from '../../engine/files/retrieve';

export * from '@lf/slack/types';
export {
  SLACK_FILE_TYPE_ID,
  SLACK_MANIFEST,
  SLACK_MESSAGE_EVENT_TYPES,
  SLACK_MESSAGE_FIELDS,
  SLACK_MESSAGE_FILES_REFERENCE,
  SLACK_MESSAGE_FILES_REFERENCE_NAME,
  SLACK_MESSAGE_TYPE_ID,
  SLACK_REACTION_EDGES,
  SLACK_REACTION_EDGE_NAMES,
  SLACK_REACTION_EVENT_TYPES,
  SLACK_REACTION_TYPE_ID,
  type SlackFileRecord,
} from '@lf/slack';

/** The composition function's model on the platform: its routed, metered
 *  chat (lazily required: its transitive Prisma dependency stays out of unit
 *  tests that never compose). */
export const platformSlackChat: SlackComposeChat = async (input) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { anthropicChat }: typeof import('../../../../lib/anthropic') = require('../../../../lib/anthropic');
  return anthropicChat(input);
};

/** A `File` value's bytes on the platform: redeemed from whichever owner it
 *  names, for the team the run belongs to. */
export async function platformSlackFile(ref: FileRef, teamId: TeamId): Promise<{ body: Buffer; contentType?: string }> {
  const resolved = await streamFileRef(ref, { teamId });
  const chunks: Buffer[] = [];
  for await (const chunk of resolved.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return { body: Buffer.concat(chunks), ...(resolved.contentType !== undefined ? { contentType: resolved.contentType } : {}) };
}

/** Global fetch, looked up per call (so a test's stub is seen). */
const platformFetch: typeof fetch = (input, init) => fetch(input, init);

/** The stored credential's client; null when no credential id is wired or
 *  its payload is malformed — the actor path must never break dispatch. */
async function legacyClient(teamId: TeamId, credentialsId: string | undefined): Promise<ReturnType<typeof getSlackClient> | null> {
  if (!credentialsId) return null;
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', credentialsId as ExternalServiceCredentialsId)
    .where('team_id', '=', teamId)
    .select(['id', 'credentials'])
    .executeTakeFirst();
  if (!row) return null;
  const decrypted = await decryptToken(row.credentials, row.id);
  let payload: unknown;
  try {
    payload = JSON.parse(decrypted);
  } catch {
    return null;
  }
  const rawPayload = isTestHarnessTeam(teamId) ? injectFakeBaseUrl(payload as Record<string, unknown>, 'SLACK') : payload;
  const parsed = slackCredsParser.safeParse(rawPayload);
  if (!parsed.success) return null;
  return getSlackClient(parsed.data.accessToken, parsed.data.baseUrl);
}

function legacySources(teamId: TeamId, credentialsId: string | undefined): SlackSources {
  return {
    client: () => legacyClient(teamId, credentialsId),
    missingClient: (op) =>
      op === 'streamSlackFileBytes'
        ? `slack.streamSlackFileBytes: no usable Slack credential for team ${teamId} (credentialsId=${credentialsId ?? 'unset'}).`
        : `SlackAdapter.${op}: no usable Slack credential for team ${teamId} (credentialsId=${credentialsId ?? 'unset'}). Wire pipeline_output.credentials_id through getAdapter.`,
    tenant: teamId,
    ...(credentialsId !== undefined ? { credentialRef: credentialsId } : {}),
    log: logger,
    fetch: platformFetch,
    readFile: (ref) => platformSlackFile(ref, teamId),
    compose: (args) => composeSlackMessage(platformSlackChat, args),
  };
}

export class SlackAdapter extends SlackModuleAdapter {
  constructor(
    readonly teamId: TeamId,
    readonly credentialsId?: string,
  ) {
    super(legacySources(teamId, credentialsId));
  }
}

/**
 * The shared app's door's WebhookEvent → DiscriminableEvent (`slack_events.ts`):
 * the legacy conversion plus `create` on message deliveries — exactly what the
 * module's own `preprocessInbound` answers for the same delivery.
 */
export function slackEventToDiscriminable(e: WebhookEvent): DiscriminableEvent {
  const base = webhookEventToDiscriminable(e);
  return (SLACK_MESSAGE_EVENT_TYPES as readonly string[]).includes(e.eventType) ? { ...base, changeType: 'create' } : base;
}

/** Factory for the registry's legacy line. */
export function createSlackAdapter(input: { teamId: TeamId; credentialsId?: string }): Adapter {
  return new SlackAdapter(input.teamId, input.credentialsId);
}
