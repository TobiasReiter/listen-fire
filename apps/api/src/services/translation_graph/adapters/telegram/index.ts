// Telegram's legacy line: the module's adapter (@lf/telegram) over the
// credential path the platform used before modules — the stored credential
// decrypted here, the shared bot's token from `TELEGRAM_BOT_TOKEN`, the dev
// loop's fake for the test-harness team. Kept so the `BUILTIN_MODULES` line
// for Telegram can go back to `legacy` in one edit while the module line is
// new; remove it with the line once the module line has soaked.
//
// The doors construct this class directly whatever the line says: answering
// a button tap, retiring a keyboard and the shared bot's handshake reply are
// the platform speaking as its bot, not a movement's call.

import { z } from 'zod';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';
import type { WebhookEvent } from '../../../webhook_sync/providers/interface';
import type { Adapter, DiscriminableEvent } from 'movement-engine/public/adapter';

import {
  TELEGRAM_MESSAGE_TYPE_ID,
  TelegramAdapter as TelegramModuleAdapter,
  TelegramClient,
  parseTelegramMessage,
  type TelegramSources,
} from '@listen-fire/telegram';
import { webhookEventToDiscriminable } from '../../../webhook_sync/event_conversion';
import { decryptToken } from '../../../../lib/credentials';
import { getAutomationsQb } from '../../../../lib/kysely';
import { injectFakeBaseUrl, isTestHarnessTeam } from '../../../../lib/recording';
import { logger } from 'movement-engine/public/log';
import { telegramIdentities } from './identities';
import { builtInBotToken } from './shared_bot';

export {
  TELEGRAM_ADAPTER_TYPE,
  TELEGRAM_ATTACHMENTS_FIELD,
  TELEGRAM_ATTACHMENT_TYPE_ID,
  TELEGRAM_MANIFEST,
  TELEGRAM_MESSAGE_TYPE_ID,
  normalizeMessage,
  type TelegramMessagePayload,
} from '@listen-fire/telegram';

/** Stored Telegram credential — just the bot token. */
const telegramCredsParser = z.object({
  botToken: z.string(),
  baseUrl: z.string().url().optional(),
});

/**
 * The shape of a CONNECTED-but-secret-less Telegram credential: the "empty
 * credential" a team creates to opt into the optional shared built-in bot.
 * It carries NO bot token — the transport secret stays the env
 * `TELEGRAM_BOT_TOKEN`. A `baseUrl` may still ride it (e.g. the harness).
 * `{}`, `{ botToken: '' }`, and `{ baseUrl }` all parse as "empty".
 */
const telegramEmptyCredsParser = z.object({
  botToken: z.string().optional(),
  baseUrl: z.string().url().optional(),
});

function hasUsableBotToken(payload: { botToken?: string }): boolean {
  return typeof payload.botToken === 'string' && payload.botToken.trim().length > 0;
}

/** Global fetch, looked up per call (so a test's stub is seen). */
const platformFetch: typeof fetch = (input, init) => fetch(input, init);

function applyFakeBaseUrl(teamId: TeamId, payload: unknown): unknown {
  return isTestHarnessTeam(teamId) ? injectFakeBaseUrl(payload as Record<string, unknown>, 'TELEGRAM') : payload;
}

/** The shared bot's client; the harness's fake under the test-harness team,
 *  else a connected-empty credential's `baseUrl`, else Telegram. */
function builtInClient(teamId: TeamId, baseUrlOverride?: string): TelegramClient | null {
  const botToken = builtInBotToken();
  if (!botToken) return null;
  const base = applyFakeBaseUrl(teamId, { botToken }) as { botToken: string; baseUrl?: string };
  const payload = base.baseUrl === undefined && baseUrlOverride !== undefined ? { ...base, baseUrl: baseUrlOverride } : base;
  const parsed = telegramCredsParser.safeParse(payload);
  if (!parsed.success) return null;
  return new TelegramClient(parsed.data.botToken, parsed.data.baseUrl, platformFetch);
}

/**
 * The team's own bot when its credential holds a token; the shared bot when
 * the credential is empty (the "connect the shared bot" gesture) or there is
 * none; null when the row or payload is missing or malformed — read paths
 * must never break dispatch, so only a send errors.
 */
async function legacyClient(teamId: TeamId, credentialsId: string | undefined): Promise<TelegramClient | null> {
  if (!credentialsId) return builtInClient(teamId);
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', credentialsId as ExternalServiceCredentialsId)
    .where('team_id', '=', teamId)
    .select(['id', 'credentials'])
    .executeTakeFirst();
  if (!row) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(await decryptToken(row.credentials, row.id));
  } catch {
    return null;
  }
  const byo = telegramCredsParser.safeParse(applyFakeBaseUrl(teamId, payload));
  if (byo.success && hasUsableBotToken(byo.data)) {
    return new TelegramClient(byo.data.botToken, byo.data.baseUrl, platformFetch);
  }
  const empty = telegramEmptyCredsParser.safeParse(payload);
  return builtInClient(teamId, empty.success ? empty.data.baseUrl : undefined);
}

function legacySources(teamId: TeamId, credentialsId: string | undefined): TelegramSources {
  return {
    client: () => legacyClient(teamId, credentialsId),
    missingClient: (op) =>
      op === 'resolveFileRef'
        ? `telegram: no usable Telegram credential for team ${teamId} (credentialsId=${credentialsId ?? 'unset'}).`
        : `TelegramAdapter.${op}: no usable Telegram bot token for team ${teamId} ` +
          `(credentialsId=${credentialsId ?? 'unset'}; TELEGRAM_BOT_TOKEN ` +
          `${builtInBotToken() ? 'set' : 'unset'}). Connect a Telegram credential ` +
          `or set TELEGRAM_BOT_TOKEN for the shared built-in bot.`,
    identities: telegramIdentities(teamId),
    ...(credentialsId !== undefined ? { credentialRef: credentialsId } : {}),
    log: logger,
  };
}

export class TelegramAdapter extends TelegramModuleAdapter {
  constructor(
    readonly teamId: TeamId,
    readonly credentialsId?: string,
  ) {
    super(legacySources(teamId, credentialsId));
  }

  /**
   * Send a plain text message through the SHARED built-in bot — the channel
   * the shared-bot `/start` handshake uses for its confirmation/reject reply.
   * Not a movement write: the platform itself speaking as its bot. The
   * harness's fake still applies under the test-harness team.
   */
  async sendBuiltInReply(input: { chatId: string; text: string }): Promise<void> {
    const client = builtInClient(this.teamId);
    if (!client) {
      throw new Error(
        'TelegramAdapter.sendBuiltInReply: TELEGRAM_BOT_TOKEN is unset — the shared ' +
          'built-in bot cannot send the handshake reply. Set TELEGRAM_BOT_TOKEN.',
      );
    }
    await client.sendMessage({ chat_id: input.chatId, text: input.text });
  }
}

/**
 * The shared-bot classifier's parse (telegram_builtin.ts): the delivered
 * message as the webhook layer's event, the module's normaliser underneath,
 * so both doors read byte-identical payloads.
 */
export function parseTelegramEvents(body: unknown): WebhookEvent[] {
  const payload = parseTelegramMessage(body);
  if (payload === null) return [];
  return [
    {
      eventType: 'message',
      recordId: payload.message_id,
      objectId: TELEGRAM_MESSAGE_TYPE_ID,
      // A Telegram user id, not a platform authentication actor.
      actor: undefined,
      rawPayload: payload,
      // Telegram delivers whole messages, not field-level diffs.
      changedFields: undefined,
    },
  ];
}

/** The shared door's WebhookEvent → DiscriminableEvent: the legacy conversion
 *  plus the module's tag and `create`, exactly what the module's own
 *  `preprocessInbound` answers for the same delivery. */
export function telegramEventToDiscriminable(e: WebhookEvent): DiscriminableEvent {
  return {
    ...webhookEventToDiscriminable(e),
    tag: e.eventType,
    ...(e.eventType === 'message' ? { changeType: 'create' as const } : {}),
  };
}

/** Factory for the registry's legacy line. */
export function createTelegramAdapter(input: { teamId: TeamId; credentialsId?: string }): Adapter {
  return new TelegramAdapter(input.teamId, input.credentialsId);
}
