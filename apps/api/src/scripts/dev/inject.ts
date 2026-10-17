/**
 * Dev-loop event-injection CLI. Fires synthetic inbound events at the local
 * stack so the agent can verify "third-party sends X → our system reacts"
 * flows end-to-end without touching the real source.
 *
 * Three layers, building from generic to specific:
 *
 *   raw                — `--url <path> --body <json>` POSTs anything
 *                        anywhere on the API. The escape hatch for any
 *                        provider not covered below.
 *
 *   <provider> events  — typed wrappers around `raw` that know the
 *                        provider's URL and event shape:
 *                          attio-webhook   - Attio CRM record events
 *                          slack-event     - Slack Events API payloads
 *                          mailgun-email   - Mailgun inbound email payload
 *                          resend-email    - Resend inbound email (seed + signed webhook)
 *                          gmail-message   - a message into the fake Gmail mailbox, then its poll
 *                          oauth-expire    - make the dev-loop Dropbox token stale (stored expiry + provider refusal)
 *                          oauth-config    - [--expires-in s] [--rotate true|false] [--fail-next n] [--fail-with invalid_grant|server_error]
 *                          crm-company     - a company created in the fake CRM, which pushes `emit`
 *                          crm-comment     - a comment on a fake-CRM company, which pushes `wake`
 *
 * The wrappers are intentionally thin so it's obvious how to add a new
 * one (`affinity-webhook`, `intercom-event`, etc.) — each is ~30 lines
 * that build a provider-shaped body and delegate to `raw`.
 *
 * For inbound events that need persistent setup state (a
 * webhook_subscription, a linked_object, a pipeline_input with a TG
 * trigger), the wrapper handles ensuring that state lazily — see
 * ensureAttioSubscription below for the pattern.
 *
 * Returns a JSON summary of what was sent and the API's response.
 */
// Side-effect first: ensure the dev-loop profile loader has merged its env
// into process.env before any base-URL captures below. `_lib` re-imports
// the loader too (via `import './_profile_loader'`), but pulling it in
// explicitly here makes the dependency obvious and doesn't rely on the
// transitive ordering through `_lib`.
import './_profile_loader';
// The cron / kg-mutation subcommands dispatch IN-PROCESS (no HTTP route exists
// for them), so the firing runs the movement engine here — register the same
// service adapters the API server boots (as `dev:movement` does).
import '../../services';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { getAutomationsQb, getKnowledgeQb } from '../../lib/kysely';

import type { TeamId } from '../../generated/kysely/core/Team';

import { findTriggersByKind } from '../../services/translation_graph/storage/tg_table';
import { pollTriggerNow } from '../../services/poll_source/worker';
import { EVERTRACE_API_VERSION } from '@lf/evertrace/api_client';
import { dispatchTriggerByIdEvent } from '../../services/translation_graph/triggers/router';
import { dispatchMutationEvent } from '../../services/translation_graph/triggers/mutation_dispatch';
import { userEditContext } from 'movement-engine/services/translation_graph/mutation_context';

import type { RecordMutationEvent } from '../../services/translation_graph/triggers/record_mutation_event';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { NodeId } from '../../generated/kysely/knowledge/Node';
import type { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';

import { Context } from '../../services/context';
import { prismaClient } from '../../prisma';

import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';
import type { WebhookSubscriptionId } from '../../generated/kysely/automations/WebhookSubscription';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { encryptToken } from '../../lib/credentials';
import { ensureDevLoopTeam } from './_lib';
import { fakeCrmBaseUrl } from './fake_crm_adapter';
import { signMailgunPayload } from './lib/mailgun-sign';
import { signResendWebhook } from './lib/resend-sign';
import { expireDevLoopDropboxCredential, fakeOAuthControl } from './lib/dev_oauth';
import { userPrincipal } from '../../services/principal';

/**
 * Resolve the API base URL lazily, at call time rather than module load.
 *
 * The dev CLIs are launched via `pnpm dev:inject ...`, which preloads
 * `dotenv/config` and `tsconfig-paths/register` and then loads this module.
 * The `_profile_loader` side-effect block (imported above) merges the active
 * dev-loop profile's env vars — including `API_BASE_URL=http://localhost:3500`
 * for `dev:loop:agent` — into `process.env` at import time, so by the time
 * `getApiBaseUrl()` runs from inside `injectRaw()` the profile has applied.
 *
 * An explicit `process.env.API_BASE_URL=...` prefix on the shell still wins,
 * because `applyEnv` only fills in *undefined* keys.
 */
function getApiBaseUrl(): string {
  return process.env.API_BASE_URL || 'http://localhost:3000';
}

const FAKE_CHANNELS_URL = process.env.FAKE_CHANNELS_URL || 'http://localhost:5556';
const DEV_LOOP_WEBHOOK_SECRET = 'dev-loop-webhook-secret';
const DEV_LOOP_WORKSPACE_ID = 'dev-loop-workspace';

interface AttioInjectArgs {
  event: string;
  object: string;
  record: string;
  values?: Record<string, unknown>;
  /** When the event is attribute-scoped (e.g. record.attribute_updated.foo),
   *  Attio surfaces the changed attribute's UUID. Pass through to exercise
   *  event-mode TG pruning via `backingFields`. */
  attributeId?: string;
}

function parseFlags(args: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

async function ensureAttioSubscription(teamId: string): Promise<{ id: string; credentialsId: string }> {
  // Find any existing Attio subscription for the dev-loop team
  const existing = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('team_id', '=', teamId as TeamId)
    .where('provider', '=', 'ATTIO')
    .where('deleted_at', 'is', null)
    .select(['id', 'credentials_id'])
    .executeTakeFirst();
  if (existing) {
    return { id: existing.id as string, credentialsId: existing.credentials_id as string };
  }

  // Need a credentials row to bind to. Seed step already creates one.
  const creds = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', teamId as TeamId)
    .where('type', '=', ExternalServiceType.ATTIO)
    .select(['id'])
    .executeTakeFirst();
  if (!creds) {
    throw new Error(
      'No Attio credentials for dev-loop team. Run pnpm dev:seed first.',
    );
  }

  const subId = randomUUID();
  await getAutomationsQb(['webhook_subscription'])
    .insertInto('webhook_subscription')
    .values({
      id: subId as WebhookSubscriptionId,
      team_id: teamId as TeamId,
      provider: 'ATTIO',
      credentials_id: creds.id as ExternalServiceCredentialsId,
      webhook_secret: DEV_LOOP_WEBHOOK_SECRET,
      subscriptions: JSON.stringify([
        { event_type: 'record.created' },
        { event_type: 'record.updated' },
        { event_type: 'record.deleted' },
      ]),
      status: 'active',
      external_webhook_id: 'dev-loop-fake-webhook',
    } as any)
    .execute();

  return { id: subId, credentialsId: creds.id as string };
}

/**
 * Idempotently ensure a Slack `webhook_subscription` row exists for the
 * dev-loop team so `/api/public/webhook-sync/slack/<sub-id>` resolves.
 * The subscription is bound to the team's `SLACK` credential row, mirroring
 * production BYO inbound: inbound dispatch (`dispatchToProviderTriggers`)
 * drops any trigger whose `credentials_id` disagrees with the delivering
 * subscription, so the subscription's credential must agree with the
 * movement's slack trigger, not just point at some valid FK target. A
 * pre-existing subscription bound to a stale/arbitrary credential is
 * repaired in place rather than left to silently swallow injected events.
 */
async function ensureSlackSubscription(teamId: string): Promise<{ id: string; credentialsId: string }> {
  // Bind to the SLACK credential row, mirroring production BYO inbound: a
  // Slack webhook subscription is tied to Slack credentials. This id must
  // equal the movement's slack trigger `credentials_id` — the inbound
  // dispatch filter (`dispatchToProviderTriggers`) drops any trigger whose
  // credential disagrees with the delivering subscription, so an arbitrary
  // FK target here silently prevents the reply movement from ever firing.
  const slackCred = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', teamId as TeamId)
    .where('type', '=', ExternalServiceType.SLACK)
    .select(['id'])
    .executeTakeFirst();
  if (!slackCred) {
    throw new Error(
      'No SLACK external_service_credentials row for dev-loop team. Run pnpm dev:movement (which seeds the Dev Loop Slack credential) first.',
    );
  }

  const existing = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('team_id', '=', teamId as TeamId)
    .where('provider', '=', 'SLACK')
    .where('deleted_at', 'is', null)
    .select(['id', 'credentials_id'])
    .executeTakeFirst();
  if (existing) {
    // Repair a stale row that predates the Slack credential (or was bound to
    // an arbitrary one) so its credential agrees with the trigger's.
    if (existing.credentials_id !== slackCred.id) {
      await getAutomationsQb(['webhook_subscription'])
        .updateTable('webhook_subscription')
        .set({ credentials_id: slackCred.id as ExternalServiceCredentialsId })
        .where('id', '=', existing.id as WebhookSubscriptionId)
        .execute();
    }
    return { id: existing.id as string, credentialsId: slackCred.id as string };
  }

  const creds = slackCred;

  const subId = randomUUID();
  await getAutomationsQb(['webhook_subscription'])
    .insertInto('webhook_subscription')
    .values({
      id: subId as WebhookSubscriptionId,
      team_id: teamId as TeamId,
      provider: 'SLACK',
      credentials_id: creds.id as ExternalServiceCredentialsId,
      webhook_secret: DEV_LOOP_WEBHOOK_SECRET,
      subscriptions: JSON.stringify([{ event_type: 'message' }]),
      status: 'active',
      external_webhook_id: 'dev-loop-fake-slack',
    } as any)
    .execute();

  return { id: subId, credentialsId: creds.id as string };
}

/**
 * Idempotently ensure a `TELEGRAM` credential row + a Telegram
 * `webhook_subscription` exist for the dev-loop team, so:
 *   • the source-side TelegramAdapter has a credential to load (and to
 *     `injectFakeBaseUrl` against → the fake Bot API), and
 *   • `/api/public/webhook-sync/telegram/<sub-id>` resolves.
 *
 * Unlike Slack, Telegram DOES use credentials (the bot token both sends and
 * identifies the bot), so we mint a real `TELEGRAM` credential rather than
 * borrowing the Attio row. The bot token is any string — under the
 * test-harness team `injectFakeBaseUrl` swaps in the fake-channels base, so the
 * token value is never validated against the real Telegram host.
 */
async function ensureTelegramCredentials(teamId: string): Promise<string> {
  const existing = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', teamId as TeamId)
    .where('type', '=', ExternalServiceType.TELEGRAM)
    .select(['id'])
    .executeTakeFirst();
  if (existing) return existing.id as string;

  const credId = randomUUID() as ExternalServiceCredentialsId;
  const encrypted = await encryptToken(
    JSON.stringify({ botToken: 'dev-loop-telegram-token' }),
    credId,
  );
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({
      id: credId,
      name: 'Dev Loop Telegram',
      type: ExternalServiceType.TELEGRAM,
      credentials: encrypted,
      team_id: teamId,
    } as any)
    .execute();
  return credId as string;
}

async function ensureTelegramSubscription(teamId: string): Promise<{ id: string; credentialsId: string }> {
  const credentialsId = await ensureTelegramCredentials(teamId);

  const existing = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('team_id', '=', teamId as TeamId)
    .where('provider', '=', 'TELEGRAM')
    .where('deleted_at', 'is', null)
    .select(['id', 'credentials_id'])
    .executeTakeFirst();
  if (existing) {
    return { id: existing.id as string, credentialsId: existing.credentials_id as string };
  }

  const subId = randomUUID();
  await getAutomationsQb(['webhook_subscription'])
    .insertInto('webhook_subscription')
    .values({
      id: subId as WebhookSubscriptionId,
      team_id: teamId as TeamId,
      provider: 'TELEGRAM',
      credentials_id: credentialsId as ExternalServiceCredentialsId,
      webhook_secret: DEV_LOOP_WEBHOOK_SECRET,
      subscriptions: JSON.stringify([{ event_type: 'message' }]),
      status: 'active',
      external_webhook_id: 'dev-loop-fake-telegram',
    } as any)
    .execute();

  return { id: subId, credentialsId };
}

interface TelegramEventInjectArgs {
  text?: string;
  chatId?: string;
  senderId?: string;
  username?: string;
  firstName?: string;
  messageId?: string;
  /** Attach a voice note: seed REAL audio bytes into the fake Telegram media
   *  store and put a `voice` object on the Update. */
  voice?: boolean;
  /** Override the audio file seeded for `--voice` (defaults to the committed
   *  OGG/OPUS speech sample). */
  voiceFile?: string;
}

/**
 * Seed real audio bytes into the fake Telegram media store (`POST
 * /telegram/media`) so the adapter's two-leg `getFile` → file-path download
 * yields decodable audio. Defaults to the committed speech sample
 * (`apps/fake-channels/assets/voice-sample.ogg`) — real OGG/OPUS words, so the
 * downstream transcription produces recognisable text.
 */
async function seedTelegramVoice(fileOverride?: string): Promise<{
  fileId: string;
  fileSize: number;
}> {
  const samplePath =
    fileOverride ?? path.resolve(__dirname, '../../../../fake-channels/assets/voice-sample.ogg');
  const bytes = readFileSync(samplePath);
  const fileId = `voice_${Date.now()}`;
  const res = await fetch(`${FAKE_CHANNELS_URL}/telegram/media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: fileId,
      mimeType: 'audio/ogg',
      filename: path.basename(samplePath),
      base64: bytes.toString('base64'),
    }),
  });
  if (!res.ok) {
    throw new Error(`fake Telegram media seed failed (${res.status}): ${await res.text()}`);
  }
  return { fileId, fileSize: bytes.length };
}

/**
 * Fire a synthetic inbound Telegram `Update` at the webhook-sync route. Builds
 * a real-shaped `Update` ({ update_id, message: { message_id, from, chat, date,
 * text } }), ensures the credential + subscription exist, and POSTs at
 * `/api/public/webhook-sync/telegram/<subId>`. The test-harness team bypass
 * skips signature verification (Telegram doesn't sign anyway).
 */
async function injectTelegramEvent(args: TelegramEventInjectArgs) {
  const seed = await ensureDevLoopTeam();
  const sub = await ensureTelegramSubscription(seed.teamId);

  const nowSec = Math.floor(Date.now() / 1000);
  const chatId = Number(args.chatId ?? '111222333');
  const senderId = Number(args.senderId ?? '999888777');
  const messageId = Number(args.messageId ?? String(nowSec));

  // A voice note rides a `voice` object (no filename — always OGG/OPUS); any
  // text becomes the caption, matching real Telegram voice deliveries.
  const voice = args.voice ? await seedTelegramVoice(args.voiceFile) : undefined;

  const body = {
    update_id: nowSec,
    message: {
      message_id: messageId,
      from: {
        id: senderId,
        is_bot: false,
        first_name: args.firstName ?? 'Dev',
        username: args.username ?? 'dev_user',
      },
      chat: { id: chatId, type: 'private' as const },
      date: nowSec,
      ...(voice
        ? {
            ...(args.text ? { caption: args.text } : {}),
            voice: {
              file_id: voice.fileId,
              file_unique_id: `${voice.fileId}_u`,
              duration: 5,
              mime_type: 'audio/ogg',
              file_size: voice.fileSize,
            },
          }
        : { text: args.text }),
    },
  };

  const out = await injectRaw({
    url: `/api/public/webhook-sync/telegram/${sub.id}`,
    method: 'POST',
    body,
  });
  return { ...out, subscriptionId: sub.id, ...(voice ? { seededVoice: voice } : {}) };
}

/**
 * The shared-bot inbound route authenticates Telegram deliveries via the
 * `X-Telegram-Bot-Api-Secret-Token` header (verified against
 * `TELEGRAM_WEBHOOK_SECRET`). The dev loop sets that secret, so we send the
 * header here — exercising the REAL authenticated gate rather than relying on
 * the unset-dev bypass. When the env var is unset we send no header (the
 * dev-only unauthenticated path still works for local runs without a secret).
 */
function telegramWebhookSecretHeader(): Record<string, string> | undefined {
  const raw = process.env.TELEGRAM_WEBHOOK_SECRET;
  const secret = typeof raw === 'string' ? raw.trim() : '';
  return secret.length > 0 ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : undefined;
}

/**
 * Fire a synthetic inbound at the SHARED built-in bot entry
 * (`/api/public/telegram/builtin`) — the identity-routed, subscription-less
 * door. Unlike `telegram-event` (BYO, per-subscription single-team dispatch),
 * this exercises the sender-identity fan-out: the message routes to every team
 * that has a binding for the sender. Used to prove both the linked-routing and
 * the unlinked-ignore paths.
 */
async function injectTelegramBuiltin(args: TelegramEventInjectArgs) {
  // No subscription needed — the shared entry has no subscription id. We still
  // ensure the dev-loop team exists so the harness team id is wired.
  await ensureDevLoopTeam();

  const nowSec = Math.floor(Date.now() / 1000);
  const chatId = Number(args.chatId ?? '111222333');
  const senderId = Number(args.senderId ?? '999888777');
  const messageId = Number(args.messageId ?? String(nowSec));

  const body = {
    update_id: nowSec,
    message: {
      message_id: messageId,
      from: {
        id: senderId,
        is_bot: false,
        first_name: args.firstName ?? 'Dev',
        username: args.username ?? 'dev_user',
      },
      chat: { id: chatId, type: 'private' as const },
      date: nowSec,
      text: args.text,
    },
  };

  return injectRaw({
    url: `/api/public/telegram/builtin`,
    method: 'POST',
    body,
    headers: telegramWebhookSecretHeader(),
  });
}

interface TelegramCallbackInjectArgs {
  /** A callback id (`cb_…`) — the CURRENT idiom, and what an author wires into
   *  `callback_data` (comfortably inside Telegram's 64 bytes). Drives the real
   *  PLATFORM door, not the `/api/cb/<id>` HTTP one. */
  cbId?: string;
  /** The bare ask token — the LEGACY idiom, still recognised. */
  token?: string;
  answer?: string;
  /** Full `callback_data` verbatim, for probing the door's tolerance (a whole
   *  answer URL, a non-ask string, a token with no answer). Wins over
   *  token/answer. */
  data?: string;
  chatId?: string;
  senderId?: string;
  /** The message the keyboard is on — the one `editMessageReplyMarkup` retires.
   *  Defaults to the newest message in the fake Telegram outbox, which is the
   *  one a movement just sent. */
  messageId?: string;
  /** Fire at the BYO door (`/api/public/webhook-sync/telegram/<subId>`) rather
   *  than the shared built-in entry. */
  byo?: boolean;
}

/** The newest message the fake Telegram outbox holds — the one a movement just
 *  sent, and so the one a tap in the dev loop is tapping. */
async function latestFakeTelegramMessageId(): Promise<number | undefined> {
  const res = await fetch(`${FAKE_CHANNELS_URL}/telegram/admin/outbox`);
  if (!res.ok) return undefined;
  const body = (await res.json()) as { data?: { message_id?: number }[] };
  const ids = (body.data ?? [])
    .map((m) => m.message_id)
    .filter((id): id is number => typeof id === 'number');
  return ids.length > 0 ? ids[ids.length - 1] : undefined;
}

/**
 * Tap an inline-keyboard button — a real `callback_query` update, the shape
 * Telegram delivers when someone presses a `callback_data` button. The door
 * recognises the payload, fires it through the router, acks
 * (`answerCallbackQuery`) and — when the tap served the message — retires the
 * keyboard (`editMessageReplyMarkup`); all three observable in
 * `dev:inspect telegram`.
 */
async function injectTelegramCallback(args: TelegramCallbackInjectArgs) {
  const seed = await ensureDevLoopTeam();

  const nowSec = Math.floor(Date.now() / 1000);
  const chatId = Number(args.chatId ?? '111222333');
  const senderId = Number(args.senderId ?? '999888777');
  const messageId =
    args.messageId !== undefined
      ? Number(args.messageId)
      : ((await latestFakeTelegramMessageId()) ?? nowSec);
  const data =
    args.cbId ??
    args.data ??
    `${args.token}?answer=${encodeURIComponent(args.answer ?? '')}`;

  const body = {
    update_id: nowSec,
    callback_query: {
      id: `cbq_${nowSec}`,
      from: { id: senderId, is_bot: false, first_name: 'Dev', username: 'dev_user' },
      message: {
        message_id: messageId,
        from: { id: 424242, is_bot: true, username: 'listen_fire_dev_bot' },
        chat: { id: chatId, type: 'private' as const },
        date: nowSec,
      },
      chat_instance: `ci_${chatId}`,
      data,
    },
  };

  if (args.byo) {
    const sub = await ensureTelegramSubscription(seed.teamId);
    const out = await injectRaw({
      url: `/api/public/webhook-sync/telegram/${sub.id}`,
      method: 'POST',
      body,
    });
    return { ...out, callbackData: data, messageId, subscriptionId: sub.id };
  }

  const out = await injectRaw({
    url: `/api/public/telegram/builtin`,
    method: 'POST',
    body,
    headers: telegramWebhookSecretHeader(),
  });
  return { ...out, callbackData: data, messageId };
}

interface TelegramStartInjectArgs {
  /** The handshake token. When omitted, one is minted for the dev-loop user. */
  token?: string;
  senderId?: string;
  chatId?: string;
  username?: string;
  firstName?: string;
}

/**
 * Drive the `/start <token>` handshake against the shared built-in bot entry.
 * When no `--token` is given, mint one for the seeded dev-loop user (the same
 * token `connectTelegram` would return) so the agent can run the whole bind in
 * one shot. The resulting `Update` is `{ message: { text: "/start <token>",
 * from: { id: <senderId> }, … } }`. On success the handler writes an
 * `adapters.telegram_identity` row binding `(team, senderId) → the user's
 * primary email` and replies "✅ Linked, …" into the fake outbox.
 */
async function injectTelegramStart(args: TelegramStartInjectArgs) {
  const seed = await ensureDevLoopTeam();

  let token = args.token;
  if (!token) {
    const { mintTelegramToken } = await import(
      '../../services/translation_graph/adapters/telegram/handshake'
    );
    const minted = await mintTelegramToken({
      nativeUserId: seed.userId,
      teamId: seed.teamId,
    });
    token = minted.token;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const chatId = Number(args.chatId ?? '111222333');
  const senderId = Number(args.senderId ?? '999888777');

  const body = {
    update_id: nowSec,
    message: {
      message_id: nowSec,
      from: {
        id: senderId,
        is_bot: false,
        first_name: args.firstName ?? 'Dev',
        username: args.username ?? 'dev_user',
      },
      chat: { id: chatId, type: 'private' as const },
      date: nowSec,
      text: `/start ${token}`,
    },
  };

  const out = await injectRaw({
    url: `/api/public/telegram/builtin`,
    method: 'POST',
    body,
    headers: telegramWebhookSecretHeader(),
  });
  return { ...out, token, senderId: String(senderId), teamId: seed.teamId };
}

async function ensureRecordInFakeChannels(args: AttioInjectArgs): Promise<void> {
  // Make sure the record exists in fake-channels so handler.fetchAttioRecord
  // can refresh from the source. If --values supplied, set them; otherwise
  // create an empty record with this id.
  const existing = await fetch(
    `${FAKE_CHANNELS_URL}/attio/v2/objects/${args.object}/records/${args.record}`,
  );
  if (existing.status === 404) {
    // Create — note fake-channels assigns its own ids on POST. To make the
    // record available at the requested id, we use the search-record loophole
    // by hand-crafting the record via the entity store route. For dev-loop
    // simplicity, we POST and then warn if id mismatched.
    const res = await fetch(
      `${FAKE_CHANNELS_URL}/attio/v2/objects/${args.object}/records`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { values: args.values ?? {} } }),
      },
    );
    if (!res.ok) {
      throw new Error(`fake-channels create-record failed: ${res.status} ${await res.text()}`);
    }
  } else if (args.values) {
    const res = await fetch(
      `${FAKE_CHANNELS_URL}/attio/v2/objects/${args.object}/records/${args.record}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { values: args.values } }),
      },
    );
    if (!res.ok) {
      throw new Error(`fake-channels patch-record failed: ${res.status} ${await res.text()}`);
    }
  }
}

interface WhatsappInjectArgs {
  from: string;
  text?: string;
  media?: boolean;
  mediaType?: 'image' | 'document' | 'audio';
  mediaId?: string;
  name?: string;
  /** Send an inbound REACTION (to `reactedMessageId` ?? a synthetic wamid). */
  reaction?: string;
  reactedMessageId?: string;
  /** Tap an interactive reply button — a real `interactive.button_reply`
   *  message, the shape WhatsApp delivers when someone presses one. Wins over
   *  `text`/`media`/`reaction`; drives the real callback door
   *  (services/webhook_sync/whatsapp_callback_door.ts), not the `/api/cb/<id>`
   *  HTTP one. */
  cbId?: string;
}

/** A 1×1 PNG — the bytes seeded for an injected image. */
const FAKE_WHATSAPP_IMAGE_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
/** A one-page PDF with a text layer — the bytes seeded for an injected
 *  document, so file-text's extraction has something to read end to end. */
const WHATSAPP_PDF_ASSET = path.resolve(__dirname, '../../../../fake-channels/assets/dev-document.pdf');

/**
 * Seed the inbound media bytes into the fake Meta Cloud API so the
 * dispatcher's `metaApi.downloadMedia(mediaId)` resolves them (the fake's
 * `POST /whatsapp/media`, served back via `GET /whatsapp/graph/:id`). Matches
 * Meta's upload response (`{ id }`). Idempotent on the media id.
 */
async function seedWhatsappMedia(args: {
  id: string;
  mimeType: string;
  filename?: string;
  base64: string;
}): Promise<void> {
  const res = await fetch(`${FAKE_CHANNELS_URL}/whatsapp/media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    throw new Error(`fake-channels seed-media failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Fire a synthetic inbound WhatsApp (Meta Cloud API) message at the webhook
 * (`/api/public/whatsapp/webhook`). No subscription — the dumb dispatcher
 * (`services/whatsapp/dispatch.ts`) routes by SENDER PHONE to that phone's
 * team, so the caller wires a `phone_number` row + a trigger/pipeline_input for
 * that team first (`pnpm dev:whatsapp setup` does both). `--media` includes an
 * image/document message; its bytes are seeded into the fake Meta media
 * endpoint so the dispatcher's `downloadMedia` resolves them through the real
 * path (the dev loop points WHATSAPP_GRAPH_BASE_URL at the fake).
 */
async function injectWhatsapp(args: WhatsappInjectArgs) {
  await ensureDevLoopTeam();

  const nowSec = Math.floor(Date.now() / 1000);
  const messageId = `wamid.${nowSec}`;
  const message: Record<string, unknown> = {
    from: args.from,
    id: messageId,
    timestamp: String(nowSec),
    type:
      args.cbId !== undefined
        ? 'interactive'
        : args.reaction !== undefined
          ? 'reaction'
          : args.media
            ? args.mediaType ?? 'image'
            : 'text',
  };
  if (args.cbId !== undefined) {
    // A tapped reply button — the shape `interactive.button_reply` delivers.
    // This message's OWN id (`messageId`, already computed above) is what the
    // door's ack reply threads to, via Meta's `context.message_id`.
    message.interactive = { type: 'button_reply', button_reply: { id: args.cbId, title: 'Tap' } };
  } else if (args.reaction !== undefined) {
    message.reaction = {
      message_id: args.reactedMessageId ?? `wamid.${nowSec - 60}`,
      emoji: args.reaction,
    };
  } else if (args.media) {
    const mediaType = args.mediaType ?? 'image';
    const mediaId = args.mediaId ?? `fake-media-${nowSec}`;
    // A voice note is NAMELESS audio (Meta sends no filename; downstream names
    // fall back to the wamid) — real OGG/OPUS speech bytes so transcription
    // yields recognisable words, exactly the prod shape.
    const mimeType =
      mediaType === 'document'
        ? 'application/pdf'
        : mediaType === 'audio'
          ? 'audio/ogg; codecs=opus'
          : 'image/jpeg';
    const filename =
      mediaType === 'document' ? 'doc.pdf' : mediaType === 'audio' ? undefined : 'image.jpeg';
    const base64 =
      mediaType === 'document'
        ? readFileSync(WHATSAPP_PDF_ASSET).toString('base64')
        : mediaType === 'audio'
          ? readFileSync(
              path.resolve(__dirname, '../../../../fake-channels/assets/voice-sample.ogg'),
            ).toString('base64')
          : FAKE_WHATSAPP_IMAGE_B64;
    // Seed the bytes the dispatcher will download from the fake Graph API.
    await seedWhatsappMedia({ id: mediaId, mimeType, filename, base64 });
    message[mediaType] = {
      id: mediaId,
      mime_type: mimeType,
      sha256: 'devsha',
      ...(filename ? { filename } : { voice: true }),
      ...(args.text ? { caption: args.text } : {}),
    };
  } else {
    message.text = { body: args.text ?? 'hello from dev:inject' };
  }

  const body = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { display_phone_number: '15550000000' },
              contacts: [{ wa_id: args.from, profile: { name: args.name ?? 'Dev Sender' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };

  return injectRaw({ url: '/api/public/whatsapp/webhook', method: 'POST', body });
}

/**
 * Run `fn` inside a Context bound to the dev-loop user — the in-process
 * dispatch entries (and the trigger-received notification they emit) read the
 * ambient AsyncLocalStorage Context, so calling them bare throws. Mirrors the
 * Context the live webhook path (`services/whatsapp/dispatch.ts`) builds.
 */
async function runInDevLoopContext<T>(
  seed: { userId: string; teamId: string },
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId: seed.userId, teamId: seed.teamId }));
  return ctx.runAsync(fn);
}

/**
 * Fire the team's `cron` movement trigger(s) immediately, bypassing the wall
 * clock + first-sight-skip. Synthesizes a `tick` TriggerEvent (the exact shape
 * `movement_scheduler/worker.ts` builds) and dispatches it in-process through
 * `dispatchTriggerByIdEvent` — the same entry the scheduler uses. No HTTP: cron
 * has no inbound route. Author a listener first:
 *   timer = cron(); listen to timer { schedule: "…" } fire <movement>
 */
async function injectCron(args: { movement?: string }) {
  const seed = await ensureDevLoopTeam();
  const triggers = (await findTriggersByKind({ teamId: seed.teamId, kinds: ['cron'] }))
    .filter((t) => t.movementId != null)
    .filter((t) => !args.movement || t.name.endsWith(`/${args.movement}`));

  if (triggers.length === 0) {
    return {
      fired: 0,
      note:
        'No cron movement triggers on the dev-loop team. Author one with ' +
        '`pnpm dev:movement provision --file <f>` where <f> has ' +
        '`timer = cron()` + `listen to timer { schedule: "…" } fire <movement>`.',
    };
  }

  const nowIso = new Date().toISOString();
  const results: unknown[] = [];
  for (const t of triggers) {
    const config = (t.config ?? {}) as Record<string, unknown>;
    const schedule = typeof config.schedule === 'string' ? config.schedule : '';
    const event: TriggerEvent = {
      pipelineInputId: `trigger:${t.id}`,
      adapterType: 'cron',
      triggerType: 'webhook',
      payload: { firedAt: nowIso, schedule },
      occurredAt: nowIso,
    };
    const out = await runInDevLoopContext(seed, () =>
      dispatchTriggerByIdEvent({ triggerId: t.id, event, teamId: seed.teamId as TeamId }),
    );
    results.push({
      triggerId: t.id,
      movement: t.name,
      schedule,
      firings: out.movementFirings ?? [],
      droppedReason: out.droppedReason,
    });
  }
  return { fired: triggers.length, results };
}

interface GranolaInjectArgs {
  title: string;
  summary?: string;
  owner?: string;
  ownerName?: string;
  /** Comma-separated attendee emails. */
  attendees?: string[];
  folder?: string;
  id?: string;
}

/**
 * Seed a Granola meeting note into the fake Granola API, then fire the team's
 * granola POLL trigger IN-PROCESS — Granola has no inbound HTTP route, so this
 * mirrors `cron`/`kg-mutation`: it runs the real poll path
 * (`pollTriggerNow` → getEvents → discriminate → dispatch → movement run) in the
 * CLI process against the shared DB + fakes. The seeded note carries a fresh id +
 * an `updated_at` of now, so it's always newer than the trigger's poll checkpoint
 * and re-delivers on every inject. Run `pnpm dev:granola setup` first to provision
 * the GRANOLA credential + the `note.`Title``-reading listener movement.
 */
async function injectGranola(args: GranolaInjectArgs) {
  const seed = await ensureDevLoopTeam();

  const nowIso = new Date().toISOString();
  const noteId = args.id ?? `note-${Date.now()}`;
  const ownerEmail = args.owner ?? 'dev-loop@listen-fire.local';
  const summary = args.summary ?? 'Seeded via dev:inject granola.';
  const attendees = (args.attendees ?? []).map((email) => ({ name: null, email }));

  // The full GranolaNote shape the fake stores and `getNote` returns verbatim —
  // `normalizeNote` flattens it (summary/title/attendees/owner).
  const note = {
    id: noteId,
    object: 'note' as const,
    title: args.title,
    owner: { name: args.ownerName ?? null, email: ownerEmail },
    created_at: nowIso,
    updated_at: nowIso,
    calendar_event: null,
    attendees,
    folder_membership: args.folder ? [{ id: 'fld-dev', name: args.folder }] : [],
    summary_text: summary,
    summary_markdown: null,
    transcript: null,
  };

  // 1. Seed the note into the fake Granola API (the generic admin seed route).
  const seedRes = await fetch(`${FAKE_CHANNELS_URL}/admin/granola/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entities: [{ entity_type: 'note', id: noteId, data: note }] }),
  });
  if (!seedRes.ok) {
    throw new Error(`fake-channels granola seed failed: ${seedRes.status} ${await seedRes.text()}`);
  }

  // 2. Find the team's granola poll trigger (provisioned by `dev:granola setup`).
  const triggers = (await findTriggersByKind({ teamId: seed.teamId, kinds: ['granola'] })).filter(
    (t) => t.movementId != null && t.runMode !== 'off',
  );
  if (triggers.length === 0) {
    return {
      seededNoteId: noteId,
      error:
        'No granola movement trigger on the dev-loop team. Run `pnpm dev:granola setup` first ' +
        '(it saves a movement with `listen to gr {} fire …`).',
    };
  }

  // 3. Fire the poll in-process for each granola trigger (forced — bypasses the
  //    5-min interval gate). Surfaces the engine error inline on a failing run.
  const results: unknown[] = [];
  for (const t of triggers) {
    try {
      const out = await pollTriggerNow({ triggerId: t.id });
      results.push({ triggerId: t.id, movement: t.name, ...out });
    } catch (err) {
      results.push({
        triggerId: t.id,
        movement: t.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { seededNoteId: noteId, title: args.title, owner: ownerEmail, results };
}

interface EvertraceInjectArgs {
  firstName?: string;
  lastName?: string;
  /** One of the API's signal `type` values (e.g. "New Company", "Stealth
   *  Position") — becomes the seeded signal's `signal_type` tagging. */
  type?: string;
  score?: string;
  /** When set, gives the signal one Experience naming this company (no
   *  CompanyEntity — just the free-text `companyName`, matching a signal
   *  whose employer hasn't been resolved to a lookup entity yet). */
  company?: string;
  id?: string;
}

/**
 * Seed an Evertrace signal into the fake Evertrace API, then fire the team's
 * evertrace POLL trigger IN-PROCESS — Evertrace has no inbound HTTP route, so
 * this mirrors `granola`: it runs the real poll path (`pollTriggerNow` →
 * getEvents → discriminate → dispatch → movement run) in the CLI process
 * against the shared DB + fakes. The seeded signal carries a fresh id and a
 * `createdAt` of now, so it's always newer than the trigger's poll checkpoint
 * and re-delivers on every inject. Run `pnpm dev:evertrace setup` first to
 * provision the EVERTRACE credential + the `Signal`-listening movement.
 */
async function injectEvertrace(args: EvertraceInjectArgs) {
  const seed = await ensureDevLoopTeam();

  const now = Date.now();
  const signalId = args.id ?? `sig-${now}`;
  const type = args.type ?? 'New Company';
  const score = Number(args.score ?? '7');

  const signal = {
    id: signalId,
    score,
    source: 'dev-inject',
    firstName: args.firstName ?? 'Dana',
    lastName: args.lastName ?? 'Kaplan',
    imageUrl: null,
    nationality: 'American',
    description: null,
    city: null,
    country: null,
    gender: 'woman',
    githubSlug: null,
    linkedinIdIm: null,
    linkedinIdStr: `dev-inject-${now}`,
    signalHash: `hash_${signalId}`,
    profileAccuracy: 'high',
    age: '30 to 34',
    discoveredAt: now,
    twitterId: null,
    email: null,
    stealthSign: null,
    stealthReason: null,
    summary: 'Seeded via dev:inject evertrace.',
    createdAt: now,
    taggings: [{ id: `tg-${now}`, key: type, namespace: 'signal_type', signalId, createdAt: now, updatedAt: now }],
    experiences: args.company
      ? [
          {
            id: `exp-${now}`,
            signalId,
            experienceEntityId: null,
            title: 'Founder',
            location: null,
            companyName: args.company,
            indexOrder: 0,
            startDate: null,
            endDate: null,
            createdAt: now,
            updatedAt: now,
            entity: null,
          },
        ]
      : [],
    educations: [],
    region: null,
    unipileMessagesCount: 0,
    unipileInvitationsCount: 0,
  };

  // 1. Seed the signal into the fake Evertrace API (the generic admin seed route).
  const seedRes = await fetch(`${FAKE_CHANNELS_URL}/admin/evertrace/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entities: [{ entity_type: 'signal', id: signalId, data: signal }] }),
  });
  if (!seedRes.ok) {
    throw new Error(`fake-channels evertrace seed failed: ${seedRes.status} ${await seedRes.text()}`);
  }

  // 2. Find the team's evertrace poll trigger (provisioned by `dev:evertrace setup`).
  const triggers = (await findTriggersByKind({ teamId: seed.teamId, kinds: ['evertrace'] })).filter(
    (t) => t.movementId != null && t.runMode !== 'off',
  );
  if (triggers.length === 0) {
    return {
      seededSignalId: signalId,
      error:
        'No evertrace movement trigger on the dev-loop team. Run `pnpm dev:evertrace setup` first ' +
        '(it saves a movement with `listen to et {} fire …`).',
    };
  }

  // 3. Fire the poll in-process for each evertrace trigger (forced — bypasses
  //    the interval gate). Surfaces the engine error inline on a failing run.
  const results: unknown[] = [];
  for (const t of triggers) {
    try {
      const out = await pollTriggerNow({ triggerId: t.id });
      results.push({ triggerId: t.id, movement: t.name, ...out });
    } catch (err) {
      results.push({
        triggerId: t.id,
        movement: t.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { seededSignalId: signalId, type, score, results };
}

/**
 * Add a signal to an Evertrace list through the fake's REAL create route (so
 * the entry gets a fresh `createdAt`, which is what the poll's checkpoint
 * compares against), then fire the team's evertrace poll triggers in-process —
 * the same path `dev:inject evertrace` rides. Only the trigger listening on
 * `List Entry` produces anything: the poll source fetches the kind its own
 * `events` selection names.
 *
 * `--list` names the list by name or id and CREATES it when the workspace has
 * none by that name, so a second list (to prove a list-scoped listener ignores
 * additions elsewhere) needs no seeding.
 */
async function injectEvertraceListEntry(args: { list: string; signal?: string }) {
  const seed = await ensureDevLoopTeam();

  // Every Evertrace route is behind the same auth + version gate the real API
  // has, so the CLI presents them exactly as the client does.
  const headers = {
    Authorization: 'Bearer dev-loop-evertrace-key',
    'X-API-Version': EVERTRACE_API_VERSION,
    'content-type': 'application/json',
  };
  const evertrace = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${FAKE_CHANNELS_URL}/evertrace${path}`, { headers, ...init });
    if (!res.ok) {
      throw new Error(`fake-channels evertrace ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<unknown>;
  };

  // 1. Resolve (or create) the list through the fake's own routes.
  const lists = (await evertrace('/lists')) as Array<{ id: string; name: string }>;
  const list =
    lists.find((l) => l.id === args.list) ??
    lists.find((l) => l.name.toLowerCase() === args.list.toLowerCase()) ??
    ((await evertrace('/lists', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: args.list }),
    })) as { id: string; name: string });

  // 2. Pick the signal to file (default: the first one the workspace has).
  let signalId = args.signal;
  if (signalId === undefined) {
    const page = (await evertrace('/signals', {
      method: 'POST',
      headers,
      body: JSON.stringify({ page: 1, limit: 1 }),
    })) as { data?: Array<{ id: string }> };
    signalId = page.data?.[0]?.id;
    if (signalId === undefined) {
      return { error: 'No signals in the fake Evertrace API — run `pnpm dev:seed` first.' };
    }
  }

  // 3. Add it through the real create route (idempotent on (list, signal), so a
  //    repeat inject reuses the existing entry and its ORIGINAL createdAt —
  //    which is why a second delivery needs a different signal).
  const entry = (await evertrace(`/lists/${encodeURIComponent(list.id)}/entries`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ signalId }),
  })) as { id: string; createdAt: number };

  // 4. Fire every evertrace poll trigger — the list listener delivers, the
  //    signal listener finds nothing new.
  const triggers = (await findTriggersByKind({ teamId: seed.teamId, kinds: ['evertrace'] })).filter(
    (t) => t.movementId != null && t.runMode !== 'off',
  );
  if (triggers.length === 0) {
    return {
      list: { id: list.id, name: list.name },
      entryId: entry.id,
      error:
        'No evertrace movement trigger on the dev-loop team. Run `pnpm dev:evertrace setup` first.',
    };
  }
  const results: unknown[] = [];
  for (const t of triggers) {
    try {
      const out = await pollTriggerNow({ triggerId: t.id });
      results.push({ triggerId: t.id, movement: t.name, ...out });
    } catch (err) {
      results.push({
        triggerId: t.id,
        movement: t.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    list: { id: list.id, name: list.name },
    signalId,
    entry: { id: entry.id, createdAt: entry.createdAt },
    results,
  };
}

interface DealroomInjectArgs {
  /** Dealroom's own round label, e.g. "SERIES A" / "SEED". Matched
   *  case-insensitively by the fake, as Dealroom's terms filter is. */
  round?: string;
  /** Which company raised — its Dealroom id, its path slug, or its name. */
  company?: string;
  /** Round size in `--currency` (millions are the unit Dealroom records). */
  amount?: string;
  currency?: string;
  /** Investor ids/names/paths taking part; the first is the lead. Defaults to
   *  the two the fake seeds first. */
  investors?: string[];
  /** Fire the poll WITHOUT seeding anything. What "the first poll after going
   *  live emits nothing" looks like as a command: the fake already holds a
   *  dozen rounds, and an honest poll returns none of them. */
  noSeed?: boolean;
}

/** `"YYYY-MM-DD HH:mm:ss"` — the UTC timestamp format every Dealroom date
 *  field and `created_utc_min` filter uses. */
function dealroomTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Seed a NEW funding round into the fake Dealroom API, then fire the team's
 * dealroom POLL trigger IN-PROCESS — Dealroom has no inbound HTTP route, so
 * this mirrors `evertrace`: it runs the real poll path (`pollTriggerNow` →
 * getEvents → discriminate → dispatch → movement run) in the CLI process
 * against the shared DB + fakes.
 *
 * The round carries a fresh NUMERIC id (the API types a round id as a number)
 * and a `created_utc` of now, so it is always past the trigger's checkpoint and
 * re-delivers on every inject. Its company and investors are existing seeded
 * records, so the run's `Company` and `Investors` hops land on real rows.
 *
 * Run `pnpm dev:dealroom setup` first to provision the listener; give SETUP a
 * `--round` to narrow the listen, then inject a different label to prove the
 * excluded round produces nothing.
 */
async function injectDealroom(args: DealroomInjectArgs) {
  const seed = await ensureDevLoopTeam();

  if (args.noSeed === true) {
    const idle = (await findTriggersByKind({ teamId: seed.teamId, kinds: ['dealroom'] })).filter(
      (t) => t.movementId != null && t.runMode !== 'off',
    );
    if (idle.length === 0) {
      return { seeded: false, error: 'No dealroom movement trigger — run `pnpm dev:dealroom setup` first.' };
    }
    const polled: unknown[] = [];
    for (const t of idle) {
      try {
        polled.push({ triggerId: t.id, movement: t.name, ...(await pollTriggerNow({ triggerId: t.id })) });
      } catch (err) {
        polled.push({ triggerId: t.id, movement: t.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { seeded: false, results: polled };
  }

  const state = await fetch(`${FAKE_CHANNELS_URL}/admin/dealroom/state`);
  if (!state.ok) {
    throw new Error(`fake-channels dealroom state failed: ${state.status} ${await state.text()}`);
  }
  const grouped = (await state.json()) as Record<string, Record<string, unknown>[]>;
  const companies = grouped.company ?? [];
  const investors = grouped.investor ?? [];
  const rounds = grouped.round ?? [];
  if (companies.length === 0 || investors.length === 0) {
    return { error: 'The fake Dealroom API has no companies/investors — run `pnpm dev:seed` first.' };
  }

  const pick = (rows: Record<string, unknown>[], needle: string | undefined, fallback: number) => {
    if (needle === undefined) return rows[fallback] ?? rows[0];
    const lower = needle.toLowerCase();
    return (
      rows.find((r) => String(r.id) === needle) ??
      rows.find((r) => String(r.path ?? '').toLowerCase() === lower) ??
      rows.find((r) => String(r.name ?? '').toLowerCase() === lower) ??
      rows[fallback] ??
      rows[0]
    );
  };

  const company = pick(companies, args.company, 0);
  const chosenInvestors =
    args.investors && args.investors.length > 0
      ? args.investors.map((needle) => pick(investors, needle, 0))
      : [investors[0], investors[1]].filter(Boolean);

  // A round id is a NUMBER over the wire, so a fresh one is the next integer —
  // not a `dr-<timestamp>` string, which the client's schema would reject.
  const nextId = String(
    rounds.reduce((high, r) => Math.max(high, Number(r.id) || 0), 0) + 1,
  );
  const now = Date.now();
  const createdUtc = dealroomTimestamp(now);
  const date = createdUtc.slice(0, 10);
  const label = args.round ?? 'SERIES A';
  const amount = args.amount === undefined ? 12 : Number(args.amount);
  const currency = args.currency ?? 'USD';

  const round = {
    id: nextId,
    companyId: String(company.id),
    date,
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    amount,
    amount_source: Math.round(amount * 1_000_000),
    currency,
    round: label,
    standardised_round_label: label,
    valuation: null,
    is_verified: true,
    is_undisclosed: false,
    news_source: null,
    unknown_investors: [],
    amount_eur_million: amount,
    amount_usd_million: amount,
    last_updated: `${createdUtc.replace(' ', 'T')}+00:00`,
    last_updated_utc: createdUtc,
    created_utc: createdUtc,
  };

  // The round and its investor join rows in one seed call — `round_investor` is
  // its own row in the fake (nothing is duplicated between a round and its
  // participants), and the first investor leads.
  const entities = [
    { entity_type: 'round', id: nextId, data: round },
    ...chosenInvestors.map((investor, index) => ({
      entity_type: 'round_investor',
      id: `ri_inject_${nextId}_${investor.id}`,
      data: { id: `ri_inject_${nextId}_${investor.id}`, roundId: nextId, investorId: String(investor.id), lead: index === 0 },
    })),
  ];
  const seedRes = await fetch(`${FAKE_CHANNELS_URL}/admin/dealroom/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entities }),
  });
  if (!seedRes.ok) {
    throw new Error(`fake-channels dealroom seed failed: ${seedRes.status} ${await seedRes.text()}`);
  }

  const triggers = (await findTriggersByKind({ teamId: seed.teamId, kinds: ['dealroom'] })).filter(
    (t) => t.movementId != null && t.runMode !== 'off',
  );
  if (triggers.length === 0) {
    return {
      seededRoundId: nextId,
      error:
        'No dealroom movement trigger on the dev-loop team. Run `pnpm dev:dealroom setup` first ' +
        '(it saves a movement with `listen to dr {} fire …`).',
    };
  }

  // Fire the poll in-process for each dealroom trigger (forced — bypasses the
  // interval gate). `eventCount: 0` is the honest answer when the listen's
  // `rounds` filter excludes the label just seeded.
  const results: unknown[] = [];
  for (const t of triggers) {
    try {
      const out = await pollTriggerNow({ triggerId: t.id });
      results.push({ triggerId: t.id, movement: t.name, ...out });
    } catch (err) {
      results.push({
        triggerId: t.id,
        movement: t.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    seededRoundId: nextId,
    round: label,
    createdUtc,
    company: { id: company.id, name: company.name },
    investors: chosenInvestors.map((i) => ({ id: i.id, name: i.name })),
    results,
  };
}

/**
 * Drop a message into the fake mailbox and fire the team's gmail POLL trigger
 * IN-PROCESS — Gmail has no inbound HTTP route here (the connector polls), so
 * this mirrors `dealroom`: it runs the real poll path (`pollTriggerNow` →
 * `getEvents` → discriminate → dispatch → run).
 *
 * `--expire-history` first walks the fake's change-marker floor past the stored
 * checkpoint, so the next poll meets the 404 Gmail gives after a quiet week and
 * has to resync from the last seen time. That is the one behaviour a real
 * mailbox will not produce on demand.
 *
 * Run `pnpm dev:gmail setup` first to provision the listener.
 */
async function injectGmailMessage(args: {
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  body?: string;
  bodyHtml?: string;
  labels?: string[];
  attachment?: string;
  expireHistory?: boolean;
  noSeed?: boolean;
}) {
  const seed = await ensureDevLoopTeam();

  if (args.expireHistory) {
    const res = await fetch(`${FAKE_CHANNELS_URL}/fake-gmail/expire-history`, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`fake-channels gmail expire-history failed: ${res.status} ${await res.text()}`);
    }
  }

  let seeded: unknown = null;
  if (!args.noSeed) {
    const attachments = args.attachment
      ? [{ filename: args.attachment, contentType: 'text/plain', content: `Contents of ${args.attachment}.` }]
      : [];
    const res = await fetch(`${FAKE_CHANNELS_URL}/fake-gmail/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: args.subject ?? 'Seeded via dev:inject gmail-message',
        from: args.from ?? 'ops@northwind.example',
        ...(args.to !== undefined ? { to: args.to } : {}),
        ...(args.cc !== undefined ? { cc: args.cc } : {}),
        bodyText: args.body ?? 'Seeded body.',
        ...(args.bodyHtml !== undefined ? { bodyHtml: args.bodyHtml } : {}),
        ...(args.labels !== undefined ? { labelIds: args.labels } : {}),
        attachments,
      }),
    });
    if (!res.ok) {
      throw new Error(`fake-channels gmail seed failed: ${res.status} ${await res.text()}`);
    }
    seeded = await res.json();
  }

  const triggers = (await findTriggersByKind({ teamId: seed.teamId, kinds: ['gmail'] })).filter(
    (t) => t.movementId != null && t.runMode !== 'off',
  );
  if (triggers.length === 0) {
    return {
      seeded,
      error:
        'No gmail movement trigger on the dev-loop team. Run `pnpm dev:gmail setup` first ' +
        '(it saves a movement with `listen to mail {} fire …`).',
    };
  }

  // Forced — bypasses the interval gate. `eventCount: 0` is the honest answer
  // when the listen's `query` excludes the message just seeded, and on the very
  // first poll, which only sets the mark.
  const results: unknown[] = [];
  for (const t of triggers) {
    try {
      const out = await pollTriggerNow({ triggerId: t.id });
      results.push({ triggerId: t.id, movement: t.name, ...out });
    } catch (err) {
      results.push({
        triggerId: t.id,
        movement: t.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { seeded, expiredHistory: args.expireHistory === true, results };
}

/**
 * Fire a synthetic KG mutation so a `listen to <graph> { type: "…" }` movement
 * dispatches. Resolves the node type by name (or id), picks an existing node of
 * that type (or `--node-id`), builds a `RecordMutationEvent`, and dispatches it
 * in-process via `dispatchMutationEvent` — the same entry the post-commit
 * emitter feeds. Use this instead of `dev:link` (a raw insert that bypasses the
 * mutation emitter, so it never fires a kg listener).
 */
async function injectKgMutation(args: {
  nodeType: string;
  nodeId?: string;
  changeKind?: 'create' | 'update' | 'delete';
  fields?: string[];
}) {
  const seed = await ensureDevLoopTeam();
  const kqb = getKnowledgeQb(['node_type', 'node']);

  // Resolve by name first; only try the id column when the arg is a uuid —
  // feeding a bare name into the uuid-typed `id` column errors in Postgres.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    args.nodeType,
  );
  let nt = await kqb
    .selectFrom('node_type')
    .where('team_id', '=', seed.teamId as TeamId)
    .where('name', '=', args.nodeType)
    .select(['id', 'name'])
    .executeTakeFirst();
  if (!nt && isUuid) {
    nt = await kqb
      .selectFrom('node_type')
      .where('team_id', '=', seed.teamId as TeamId)
      .where('id', '=', args.nodeType as unknown as NodeTypeId)
      .select(['id', 'name'])
      .executeTakeFirst();
  }
  if (!nt) {
    return {
      error: `No node_type '${args.nodeType}' on the dev-loop team. Run pnpm dev:seed, or check pnpm dev:graph ontology.`,
    };
  }

  let nodeId = args.nodeId;
  if (!nodeId) {
    const node = await kqb
      .selectFrom('node')
      .where('team_id', '=', seed.teamId as TeamId)
      .where('node_type_id', '=', nt.id)
      .select(['id'])
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (!node) {
      return {
        error:
          `No existing '${nt.name}' node to mutate. Create one (e.g. ` +
          `pnpm dev:link create --node-type ${nt.name} --object-slug companies --record 1) ` +
          `or pass --node-id <uuid>.`,
      };
    }
    nodeId = node.id as unknown as string;
  }

  const event: RecordMutationEvent = {
    recordId: nodeId as unknown as NodeId,
    nodeTypeId: nt.id as unknown as string,
    changeKind: args.changeKind ?? 'update',
    changedFields: args.fields ?? [],
    context: userEditContext(seed.userId),
  };
  const out = await runInDevLoopContext(seed, () =>
    dispatchMutationEvent({ event, teamId: seed.teamId as TeamId }),
  );
  return {
    nodeType: nt.name,
    nodeId,
    changeKind: event.changeKind,
    changedFields: event.changedFields,
    firings: out.movementFirings ?? [],
  };
}

interface RawInjectArgs {
  url: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * The base injection primitive. All other inject subcommands delegate to
 * this — provider-specific wrappers just precompute (url, body) and call
 * down. Use directly via `dev:inject raw` when no wrapper exists.
 */
async function injectRaw(args: RawInjectArgs) {
  const fullUrl = args.url.startsWith('http') ? args.url : `${getApiBaseUrl()}${args.url}`;
  const init: RequestInit = {
    method: args.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(args.headers ?? {}),
    },
  };
  if (args.body !== undefined) {
    init.body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
  }
  const res = await fetch(fullUrl, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return {
    target: fullUrl,
    method: init.method,
    request: args.body,
    response: { status: res.status, body },
  };
}

async function injectAttioWebhook(args: AttioInjectArgs) {
  const seed = await ensureDevLoopTeam();
  const sub = await ensureAttioSubscription(seed.teamId);

  if (args.values) {
    await ensureRecordInFakeChannels(args);
  }

  const body = {
    webhook_id: 'dev-loop-fake-webhook',
    events: [
      {
        event_type: args.event,
        id: {
          workspace_id: DEV_LOOP_WORKSPACE_ID,
          object_id: args.object,
          record_id: args.record,
          ...(args.attributeId ? { attribute_id: args.attributeId } : {}),
        },
      },
    ],
  };

  const out = await injectRaw({
    url: `/api/public/webhook-sync/attio/${sub.id}`,
    method: 'POST',
    body,
  });
  return { ...out, subscriptionId: sub.id };
}

interface AirtableInjectArgs {
  /** create | update | delete — mapped to the Airtable native change kind. */
  event: 'create' | 'update' | 'delete';
  record: string;
  /** Field NAME → value (the fake maps names → field ids when building the
   *  payload). Ignored for delete. */
  values?: Record<string, unknown>;
  /** When the team has more than one Airtable listener, pick the (base, table)
   *  to target. Default: the first AIRTABLE subscription's scope. */
  base?: string;
  table?: string;
}

/** create → add, update → update, delete → remove (the Airtable change kind),
 *  plus the `record.*` name for the report. */
const AIRTABLE_EVENT_MAP: Record<
  AirtableInjectArgs['event'],
  { changeType: 'add' | 'update' | 'remove'; recordEvent: string }
> = {
  create: { changeType: 'add', recordEvent: 'record.created' },
  update: { changeType: 'update', recordEvent: 'record.updated' },
  delete: { changeType: 'remove', recordEvent: 'record.deleted' },
};

function scopeOfRow(rawValue: unknown): Record<string, string> {
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

/**
 * Fire a synthetic Airtable webhook delivery. Airtable is notify-then-pull: the
 * ping carries only `{ base, webhook }` ids and the adapter PULLS the actual
 * changes from the webhook's payload feed. So this wrapper does two things:
 *
 *   1. SEED the record change into the fake's payload feed for the webhook the
 *      listen reconciler registered (the fake honors the webhook's subscribed
 *      `changeTypes` + table scope — an unsubscribed change kind is dropped,
 *      never queued, modeling Airtable's credit guarantee);
 *   2. POST the tiny ping at `/api/public/webhook-sync/airtable/<subId>`, which
 *      drives `preprocessInbound` → `listPayloads` → discriminate → dispatch.
 *
 * Run `pnpm dev:airtable setup` first — it provisions the AIRTABLE
 * webhook_subscription (and the fake `ach…` webhook the feed lives under). The
 * base/table/webhook id are read off that subscription, so the inject needs
 * only `--event` + `--record`.
 */
async function injectAirtableWebhook(args: AirtableInjectArgs) {
  const seed = await ensureDevLoopTeam();

  const subs = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('team_id', '=', seed.teamId as TeamId)
    .where('provider', '=', 'AIRTABLE')
    .where('deleted_at', 'is', null)
    .select(['id', 'external_webhook_id', 'scope', 'status'])
    .execute();
  const matched = subs.find((s) => {
    const scope = scopeOfRow(s.scope);
    if (args.base && scope.base !== args.base) return false;
    if (args.table && scope.table !== args.table) return false;
    return true;
  });
  if (!matched) {
    return {
      error:
        'No AIRTABLE webhook_subscription for the dev-loop team' +
        (args.base || args.table ? ` matching base/table ${args.base}/${args.table}` : '') +
        '. Run `pnpm dev:airtable setup` first.',
      subscriptionsFound: subs.length,
    };
  }
  if (!matched.external_webhook_id) {
    return {
      error:
        `AIRTABLE subscription ${matched.id} has no external_webhook_id (status ` +
        `${matched.status}) — its ensureEventSubscription/createWebhook never completed. ` +
        'Re-run `pnpm dev:airtable setup` and check fake-channels is up.',
    };
  }

  const scope = scopeOfRow(matched.scope);
  const base = args.base ?? scope.base;
  const table = args.table ?? scope.table;
  if (!base || !table) {
    return { error: `AIRTABLE subscription ${matched.id} has no base/table scope`, scope };
  }

  const { changeType, recordEvent } = AIRTABLE_EVENT_MAP[args.event];

  // 1. Seed the change into the fake's payload feed (honors changeTypes/scope).
  const seedRes = await fetch(
    `${FAKE_CHANNELS_URL}/airtable/v0/bases/${base}/webhooks/${matched.external_webhook_id}/payloads`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        changeType,
        tableId: table,
        recordId: args.record,
        fields: args.values ?? {},
      }),
    },
  );
  const seedBody = (await seedRes.json()) as { appended?: boolean; reason?: string };

  // 2. POST the ping. `preprocessInbound` pulls the feed from the persisted
  //    cursor; if the change was dropped at (1) the pull yields nothing and no
  //    movement runs — the selection guarantee, observable end-to-end.
  const out = await injectRaw({
    url: `/api/public/webhook-sync/airtable/${matched.id}`,
    method: 'POST',
    body: {
      base: { id: base },
      webhook: { id: matched.external_webhook_id },
      timestamp: new Date().toISOString(),
    },
  });
  return {
    ...out,
    subscriptionId: matched.id as string,
    webhookId: matched.external_webhook_id,
    base,
    table,
    recordEvent,
    changeType,
    seeded: seedBody,
  };
}

interface SlackEventInjectArgs {
  eventType: string;
  channel: string;
  user: string;
  text: string;
  ts?: string;
  /**
   * A thread reply: the thread ROOT ts the reply lands under (the awaited
   * message's ts). When set, the inbound event carries `thread_ts`, AND the
   * reply is seeded into the fake-channels store so `conversations.replies`
   * returns it — which is what an `await m-[:Replies]->` resolve re-checks live.
   * Without this, a bare message injection can't resolve a Replies await.
   */
  threadTs?: string;
  teamId?: string;
  /**
   * Optional path to a JSON fixture (e.g. the wave-1 golden-path
   * synthetic-slack-message.json). When set, the file's `event` field is
   * used as the inner event verbatim — the CLI flags above are ignored.
   * Useful for replaying the exact fixture G1 / I1 reference.
   */
  fixture?: string;
  /**
   * Bypass the new TG-bridge path and POST to the legacy
   * `/private/slack/callback` route (which lands in `inbound_payload`).
   * The legacy path is preserved by I1; this flag is the only way to
   * reach it from the CLI now that the default re-points at the new
   * webhook-sync endpoint.
   */
  legacy?: boolean;
}

/** Seed one message into the fake-channels Slack store (the `/admin/slack/seed`
 *  helper), so `conversations.replies` returns it — what a `Replies` await
 *  re-checks live. */
async function seedFakeSlackMessage(data: {
  channel: string;
  thread_ts: string;
  ts: string;
  user: string;
  text: string;
}): Promise<void> {
  const res = await fetch(`${FAKE_CHANNELS_URL}/admin/slack/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entities: [{ entity_type: 'message', id: data.ts, data }],
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to seed fake Slack reply (${res.status}) — is fake-channels running at ${FAKE_CHANNELS_URL}?`,
    );
  }
}

async function injectSlackEvent(args: SlackEventInjectArgs) {
  let body: Record<string, unknown>;

  if (args.fixture) {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(args.fixture, 'utf-8');
    body = JSON.parse(raw);
  } else {
    const ts = args.ts ?? `${Date.now() / 1000}`;
    body = {
      type: 'event_callback',
      event_id: `Ev${Date.now()}`,
      event_time: Math.floor(Date.now() / 1000),
      team_id: args.teamId ?? 'T_DEV_LOOP',
      event: {
        type: args.eventType,
        user: args.user,
        text: args.text,
        channel: args.channel,
        ts,
        event_ts: ts,
        ...(args.threadTs !== undefined ? { thread_ts: args.threadTs } : {}),
      },
    };

    // A thread reply must also EXIST in the fake store — the `Replies` await
    // re-checks the thread live via `conversations.replies`, which reads the
    // store. Seed the reply message (a real inbound reply isn't posted through
    // the bot's chat.postMessage, so nothing else creates it).
    if (args.threadTs !== undefined) {
      await seedFakeSlackMessage({
        channel: args.channel,
        thread_ts: args.threadTs,
        ts,
        user: args.user,
        text: args.text,
      });
    }
  }

  if (args.legacy) {
    // Legacy path: lands at /private/slack/callback → inboundSlackHandler
    // → `inbound_payload`. Preserved by I1 in parallel with the new
    // webhook-sync route.
    return injectRaw({
      url: `/private/slack/callback`,
      method: 'POST',
      body,
    });
  }

  // New path: routes through services/webhook_sync/handler.ts and into
  // routeTrigger for any pipeline_input with a Slack trigger_entry on
  // this team. The test-harness team bypass skips signature verification,
  // so no x-slack-signature header is needed here.
  const seed = await ensureDevLoopTeam();
  const sub = await ensureSlackSubscription(seed.teamId);

  const out = await injectRaw({
    url: `/api/public/webhook-sync/slack/${sub.id}`,
    method: 'POST',
    body,
  });
  return { ...out, subscriptionId: sub.id };
}

interface SlackInteractivityInjectArgs {
  /** A callback id (`cb_…`) — the CURRENT idiom. It rides the same slot the
   *  author would have wired it into: `value` on a button, the chosen option's
   *  `value` on a select, `action_id` on a datepicker (which has no `value`).
   *  Drives the real PLATFORM door, not the `/api/cb/<id>` HTTP one. */
  cbId?: string;
  /** A full button/option value (the LEGACY ask answer link). Overrides
   *  token/answer. */
  value?: string;
  /** The ask capability token (`ask_…`) — combined with `answer` to build the
   *  button/option value the author would have wired in. */
  token?: string;
  answer?: string;
  channel?: string;
  /** The ts of the posted message the buttons/select sits on — the
   *  response_url edits THIS message on ack (read it from `dev:inspect`
   *  after the movement posts). */
  messageTs?: string;
  /** Fire a `static_select` choice (`selected_option.value`) instead of a
   *  button tap (`value`) — the two inbound shapes `handleBlockActions`
   *  branches on. */
  select?: boolean;
  /** Fire a `datepicker` tap instead of a button/select — the TAP-TIME
   *  idiom: the bare ask link (no `?answer=`) rides `action_id` (a
   *  datepicker has no `value` to pre-wire an answer into), and the picked
   *  date (`selectedDate`, defaulted below) is the answer, supplied only at
   *  tap time. Exercises `resolveAskAction`'s action_id branch. */
  datepicker?: boolean;
  /** The date picked for `--datepicker` (`YYYY-MM-DD`). */
  selectedDate?: string;
}

/**
 * Fire a synthetic Slack block-action — a button tap, a static_select choice,
 * or a datepicker tap-time pick — at the Listen-Fire app's interactivity door
 * (`/api/public/slack-actions`). Builds the real `block_actions` payload Slack
 * posts, so this drives the PLATFORM path end to end (recognition → router →
 * ack → message edit), not the HTTP door `dev:inject callback` uses.
 *
 * `--cb-id` is the current idiom: the opaque id rides `value` (button),
 * `selected_option.value` (select) or `action_id` (datepicker, which has no
 * `value` field), and the datepicker's `selected_date` becomes the ONE supplied
 * value the router binds to the callback's first parameter. `--token/--answer`
 * still inject the LEGACY ask answer link, which the door keeps recognising
 * during the migration window.
 *
 * `response_url` points at fake-channels so the ack (the message edit, or the
 * ephemeral "closed"/refusal notice) is observable via `dev:inspect`.
 */
async function injectSlackInteractivity(args: SlackInteractivityInjectArgs) {
  await ensureDevLoopTeam();

  const messageTs = args.messageTs ?? `${Date.now() / 1000}`;
  const channel = args.channel ?? 'C_DEV';

  let action: Record<string, unknown>;
  let actionValue: string;

  if (args.datepicker) {
    // Tap-time: the pre-wired slot can't carry the picked value, so the
    // callback id (legacy: the bare ask link) rides `action_id` and the pick
    // arrives as `selected_date` (@slack/bolt-js's `DatepickerAction` field
    // name) — the same shape timepicker/dispatch-triggered text input use.
    const link = args.cbId ?? args.value ?? `${getApiBaseUrl()}/api/asks/${args.token}`;
    action = {
      type: 'datepicker',
      action_id: link,
      block_id: 'ask',
      selected_date: args.selectedDate ?? args.answer ?? '2026-08-15',
    };
    actionValue = link;
  } else {
    const value =
      args.cbId ??
      args.value ??
      `${getApiBaseUrl()}/api/asks/${args.token}?answer=${encodeURIComponent(args.answer ?? '')}`;
    action = args.select
      ? {
          type: 'static_select',
          action_id: 'ask_answer_0',
          block_id: 'ask',
          selected_option: { value, text: { type: 'plain_text', text: 'Option' } },
        }
      : { type: 'button', action_id: 'ask_answer_0', block_id: 'ask', value };
    actionValue = value;
  }

  const payload = {
    type: 'block_actions',
    user: { id: 'U_DEV', username: 'dev_user' },
    team: { id: 'T_DEV_LOOP' },
    channel: { id: channel },
    message: { ts: messageTs },
    response_url: `${FAKE_CHANNELS_URL}/slack/response/${messageTs}`,
    actions: [action],
  };

  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const out = await injectRaw({
    url: '/api/public/slack-actions',
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  return { ...out, buttonValue: actionValue, responseUrl: payload.response_url };
}

interface MailgunEmailInjectArgs {
  /**
   * Path to a JSON fixture matching the Mailgun inbound webhook payload
   * shape (subject, sender, recipient, body-plain, body-html,
   * attachments, message-headers, …). Defaults to the bundled
   * `__fixtures__/mailgun-email-dealflow.json`.
   *
   * The fixture's PLACEHOLDER recipient is replaced by `--to` so a
   * single fixture serves every freshly-minted `inbox+pi-<id>@example.com`
   * address that activation produces.
   */
  fixture?: string;
  /**
   * Recipient address. Required — the inbound handler routes by parsing
   * `inbox+<key>@example.com` and matching `key` to a CUSTOM_EMAIL
   * pipeline_input. Pass the activation-minted address here.
   */
  to: string;
  /** Override the sender on the fixture (`sender` + `From`). */
  from?: string;
  /** Override the subject on the fixture. */
  subject?: string;
  /**
   * Mailgun API key used for the HMAC signature. Defaults to
   * `'test-harness-dummy-key'` to match the dev-loop wiring in
   * `services.ts` (which uses that string when TEST_HARNESS_TEAM_ID is
   * set and the stack isn't prod / staging). We intentionally do NOT
   * fall back to `process.env.MAILGUN_API_KEY` — `.env` often ships
   * with a real Mailgun key for outbound sends, and silently signing
   * with that would mismatch the dev-loop adapter and return 406.
   * Pass `--api-key` explicitly when posting to a real Mailgun setup.
   */
  apiKey?: string;
}

/** Sender baked into the default dealflow fixture. Resolves to the
 * dev-loop user (`dev-loop@listen-fire.local`) so the mailgun handler's
 * `getSenderIdentifier → unauthorisedGetUserByEmail` lookup finds a
 * team and the plus-key dispatch can route to the matching
 * pipeline_input. Without this, the payload lands as a
 * NULL-pipeline_input_id `inbound_payload` row. Override per-call with
 * `--from` when you need to exercise a different sender path. */
const DEFAULT_MAILGUN_API_KEY = 'test-harness-dummy-key';

/**
 * Fire a synthetic Mailgun inbound email at `/api/mailgun/callback`.
 *
 * The endpoint sits behind the `isMailgunRequest` auth branch
 * (`lib/middleware/authentication/index.ts`), which calls
 * `InboundMailgunAdapter.validateInboundRequest`. The adapter verifies
 * HMAC(apiKey, timestamp + token) === signature, then routes by parsing
 * the recipient for `inbox+<key>@example.com` to find a CUSTOM_EMAIL
 * trigger. Provisioning mints those keys (the forwarding address it
 * surfaces) — pass the minted address as `--to`.
 *
 * Unlike the attio / slack wrappers there's no test-harness signature
 * bypass on this path today (see docs/dev-loop.md "Known gaps" — Mailgun
 * inbound is named alongside Slack as needing the same isTestHarnessTeam
 * bypass). We work around it by signing with the same key the dev-loop
 * adapter is constructed with (`'test-harness-dummy-key'`), so
 * verification succeeds without touching the verifier.
 */
const DEFAULT_MAILGUN_FIXTURE = path.resolve(
  __dirname,
  '__fixtures__/mailgun-email-dealflow.json',
);

/**
 * Pure helper that takes a parsed fixture + overrides and returns the
 * body to POST. Split out from `injectMailgunEmail` so it can be unit
 * tested without spinning up HTTP.
 *
 * Placeholder substitution: the fixture intentionally hard-codes
 * `inbox+pi-PLACEHOLDER@example.com` in `recipient` / `To` and inside the
 * `Received` line of `message-headers` so the adapter's BCC-fallback
 * parser sees the real address too. Anywhere the placeholder appears
 * (case-insensitive on the surrounding fields), we swap it.
 */
function buildMailgunRequestBody({
  fixture,
  to,
  from,
  subject,
  apiKey,
  now,
}: {
  fixture: Record<string, unknown>;
  to: string;
  from?: string;
  subject?: string;
  apiKey: string;
  /** Injection point for deterministic tests. */
  now?: { timestamp: string; token: string };
}) {
  const body: Record<string, unknown> = { ...fixture };

  const stringFields = ['recipient', 'To', 'message-headers'] as const;
  for (const field of stringFields) {
    const value = body[field];
    if (typeof value === 'string') {
      body[field] = value.replace(/inbox\+pi-PLACEHOLDER@example\.com/g, to);
    }
  }

  if (from) {
    body.sender = from;
    body.From = from;
  }
  if (subject) {
    body.subject = subject;
  }

  const sig = signMailgunPayload({
    apiKey,
    timestamp: now?.timestamp,
    token: now?.token,
  });

  const signed: Record<string, unknown> = {
    ...body,
    timestamp: sig.timestamp,
    token: sig.token,
    signature: sig.signature,
  };
  return signed;
}

async function injectMailgunEmail(args: MailgunEmailInjectArgs) {
  const fs = await import('node:fs/promises');

  const fixturePath = args.fixture
    ? path.resolve(args.fixture)
    : DEFAULT_MAILGUN_FIXTURE;

  const raw = await fs.readFile(fixturePath, 'utf-8');
  const fixture = JSON.parse(raw) as Record<string, unknown>;

  const apiKey = args.apiKey ?? DEFAULT_MAILGUN_API_KEY;

  const body = buildMailgunRequestBody({
    fixture,
    to: args.to,
    from: args.from,
    subject: args.subject,
    apiKey,
  });

  const out = await injectRaw({
    url: '/api/mailgun/callback',
    method: 'POST',
    body,
  });
  return {
    ...out,
    fixture: fixturePath,
    recipient: args.to,
  };
}

// ── Resend inbound email ───────────────────────────────────────────────────
// Two steps, because Resend's webhook carries no message: seed the fixture
// into the fake receiving API first, THEN post the signed notification. Firing
// the webhook alone would have the API fetch a message that does not exist —
// which is a real failure mode, just not the one being tested.

const DEFAULT_RESEND_FIXTURE = path.resolve(
  __dirname,
  '__fixtures__/resend-email-dealflow.json',
);

/** The dev loop's webhook secret. Matches what the stack sets on the API; a
 *  real Resend setup passes its own with `--secret`. */
const DEFAULT_RESEND_WEBHOOK_SECRET = 'whsec_ZGV2LWxvb3AtcmVzZW5kLXNlY3JldA==';

interface ResendEmailInjectArgs {
  fixture?: string;
  /** The minted routing address the mail is delivered to. */
  to: string;
  from?: string;
  subject?: string;
  secret?: string;
}

/**
 * The `email.received` body, as Resend would send it: ids and an envelope,
 * nothing an author can read.
 */
function buildResendWebhookBody({
  emailId,
  to,
  from,
  messageId,
  subject,
  attachments,
  now,
}: {
  emailId: string;
  to: string;
  from: string;
  messageId: string;
  subject: string;
  attachments: { id: string; filename: string; content_type?: string }[];
  /** Injection point for deterministic tests. */
  now?: string;
}): Record<string, unknown> {
  return {
    type: 'email.received',
    created_at: now ?? new Date().toISOString(),
    data: {
      email_id: emailId,
      created_at: now ?? new Date().toISOString(),
      from,
      to: [to],
      cc: [],
      bcc: [],
      received_for: [to],
      message_id: messageId,
      subject,
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        content_type: a.content_type ?? 'application/octet-stream',
        content_disposition: 'attachment',
      })),
    },
  };
}

async function injectResendEmail(args: ResendEmailInjectArgs) {
  const fs = await import('node:fs/promises');

  const fixturePath = args.fixture ? path.resolve(args.fixture) : DEFAULT_RESEND_FIXTURE;
  const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf-8')) as Record<string, unknown>;

  const emailId = String(fixture.id ?? 're_dev_loop');
  const from = args.from ?? String(fixture.from ?? '');
  const subject = args.subject ?? String(fixture.subject ?? '');
  const messageId = String(fixture.message_id ?? `<${emailId}@fake-resend.local>`);
  const attachments = Array.isArray(fixture.attachments)
    ? (fixture.attachments as { id: string; filename: string; content_type?: string }[])
    : [];

  const seeded = { ...fixture, from, subject, to: [args.to], received_for: [args.to] };
  const seedResponse = await fetch(`${FAKE_CHANNELS_URL}/resend/_seed/received`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(seeded),
  });
  if (!seedResponse.ok) {
    throw new Error(
      `Seeding the fake Resend receiving API failed (status ${seedResponse.status}) — is fake-channels running?`,
    );
  }

  // The signature covers the exact bytes, so the body is serialised ONCE and
  // both signed and posted as that string.
  const body = JSON.stringify(
    buildResendWebhookBody({ emailId, to: args.to, from, messageId, subject, attachments }),
  );
  const headers = signResendWebhook({
    secret: args.secret ?? DEFAULT_RESEND_WEBHOOK_SECRET,
    body,
  });

  const out = await injectRaw({
    url: '/api/resend/callback',
    method: 'POST',
    body,
    headers,
  });
  return { ...out, fixture: fixturePath, recipient: args.to, emailId };
}

export {
  buildMailgunRequestBody,
  buildResendWebhookBody,
  DEFAULT_MAILGUN_FIXTURE,
  DEFAULT_MAILGUN_API_KEY,
  DEFAULT_RESEND_FIXTURE,
  DEFAULT_RESEND_WEBHOOK_SECRET,
  injectMailgunEmail,
  injectResendEmail,
  injectCron,
  injectGmailMessage,
  getApiBaseUrl,
};

/**
 * A change in the fake CRM (the reference remote adapter), made through its
 * own dev route. The CRM then pushes to the host's adapter door itself
 * (`emit` for a company, `wake` for a comment), so this proves the push path a
 * third party uses — nothing here talks to the API.
 */
async function injectFakeCrm(route: 'companies' | 'comments', body: unknown): Promise<unknown> {
  const url = new URL(`dev/${route}`, fakeCrmBaseUrl()).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { url, status: res.status, response: await res.json() };
}

function printResult(out: any, pretty: boolean) {
  if (pretty && out?.response) {
    console.log(`${out.method ?? 'POST'} ${out.target}`);
    if (out.subscriptionId) console.log(`subscription: ${out.subscriptionId}`);
    console.log(`response: ${out.response.status}`);
    console.log(JSON.stringify(out.response.body, null, 2));
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

/**
 * Fire a callback through the REAL door — `POST /api/cb/<id>` — so the dev loop
 * exercises exactly the path a platform button takes. `--param name=value` is
 * repeatable; `--param-json` supplies a whole object when a value is not a
 * plain scalar. GET is deliberately NOT offered: it never fires.
 */
async function injectCallback(args: {
  id: string;
  params: Record<string, string>;
  paramJson?: string;
}): Promise<Awaited<ReturnType<typeof injectRaw>>> {
  let body: Record<string, unknown> = { ...args.params };
  if (args.paramJson) {
    try {
      body = { ...body, ...(JSON.parse(args.paramJson) as Record<string, unknown>) };
    } catch {
      console.error(`--param-json is not valid JSON: ${args.paramJson}`);
      process.exit(2);
    }
  }
  return injectRaw({ url: `/api/cb/${encodeURIComponent(args.id)}`, method: 'POST', body });
}

/** Repeated `--param name=value` flags. `parseFlags` keeps only the last of a
 *  repeated key, so the raw argv is re-scanned here rather than losing values
 *  silently. */
function collectParams(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--param') continue;
    const pair = argv[i + 1];
    if (pair === undefined || pair.startsWith('--')) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      console.error(`--param expects name=value, got '${pair}'`);
      process.exit(2);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const PRETTY = 'pretty' in flags;

  if (subcommand === 'raw') {
    if (!flags.url) {
      console.error('Usage: pnpm dev:inject raw --url <path> [--method POST] [--body <json>]');
      process.exit(2);
    }
    let body: unknown;
    if (flags.body) {
      try {
        body = JSON.parse(flags.body);
      } catch {
        body = flags.body;
      }
    }
    printResult(await injectRaw({ url: flags.url, method: flags.method, body }), PRETTY);
    return;
  }

  if (subcommand === 'attio-webhook' || subcommand === 'attio') {
    if (!flags.event || !flags.object || !flags.record) {
      console.error(
        'Usage: pnpm dev:inject attio-webhook --event <e> --object <slug> --record <id> [--values \'<json>\'] [--attribute-id <uuid>]',
      );
      process.exit(2);
    }
    let values: Record<string, unknown> | undefined;
    if (flags.values) {
      try {
        values = JSON.parse(flags.values);
      } catch (err) {
        console.error(`--values must be valid JSON: ${(err as Error).message}`);
        process.exit(2);
      }
    }
    const out = await injectAttioWebhook({
      event: flags.event,
      object: flags.object,
      record: flags.record,
      values,
      attributeId: flags['attribute-id'],
    });
    printResult(out, PRETTY);
    return;
  }

  if (subcommand === 'airtable-webhook' || subcommand === 'airtable') {
    if (!flags.event || !flags.record) {
      console.error(
        'Usage: pnpm dev:inject airtable-webhook --event create|update|delete --record <id> [--values \'<json>\'] [--base <appId>] [--table <tblId>]',
      );
      console.error('  Run `pnpm dev:airtable setup` first to provision the subscription.');
      process.exit(2);
    }
    if (flags.event !== 'create' && flags.event !== 'update' && flags.event !== 'delete') {
      console.error('--event must be one of: create, update, delete');
      process.exit(2);
    }
    let values: Record<string, unknown> | undefined;
    if (flags.values) {
      try {
        values = JSON.parse(flags.values);
      } catch (err) {
        console.error(`--values must be valid JSON: ${(err as Error).message}`);
        process.exit(2);
      }
    }
    const out = await injectAirtableWebhook({
      event: flags.event,
      record: flags.record,
      values,
      base: flags.base,
      table: flags.table,
    });
    printResult(out, PRETTY);
    return;
  }

  if (subcommand === 'slack-event' || subcommand === 'slack') {
    const useFixture = Boolean(flags.fixture);
    if (!useFixture && (!flags.channel || !flags.user || !flags.text)) {
      console.error(
        'Usage: pnpm dev:inject slack-event --channel <c> --user <u> --text "<t>" [--event-type message] [--thread-ts <root-ts>] [--legacy]',
      );
      console.error(
        '  --thread-ts <root-ts>  inject a THREAD REPLY under that message ts (resolves an `await m-[:Replies]->`).',
      );
      console.error(
        '   or: pnpm dev:inject slack-event --fixture <path-to-event-callback.json> [--legacy]',
      );
      process.exit(2);
    }
    const out = await injectSlackEvent({
      eventType: flags['event-type'] ?? 'message',
      channel: flags.channel ?? '',
      user: flags.user ?? '',
      text: flags.text ?? '',
      ts: flags.ts,
      threadTs: flags['thread-ts'],
      teamId: flags['slack-team'],
      fixture: flags.fixture,
      legacy: 'legacy' in flags,
    });
    printResult(out, PRETTY);
    return;
  }

  if (subcommand === 'slack-interactivity' || subcommand === 'slack-action') {
    if (!flags['cb-id'] && !flags.value && !flags.token) {
      console.error(
        'Usage: pnpm dev:inject slack-interactivity --cb-id <cb_…> [--channel <C…>] [--message-ts <ts>] [--select]',
      );
      console.error(
        '   or: pnpm dev:inject slack-interactivity --cb-id <cb_…> --datepicker [--selected-date <YYYY-MM-DD>] [--message-ts <ts>]',
      );
      console.error(
        '   or (legacy ask link): pnpm dev:inject slack-interactivity --token <ask_…> --answer <v> [--select]',
      );
      console.error('   or: pnpm dev:inject slack-interactivity --value "<full button/option value>" [--message-ts <ts>] [--select]');
      console.error('  Fires a real block_actions payload at the Listen-Fire app interactivity door — the PLATFORM path (recognition → router → ack), unlike `dev:inject callback`, which posts to the HTTP door.');
      console.error('  --cb-id rides `value` (button), the chosen option (--select), or `action_id` (--datepicker, whose picked date is the supplied value).');
      process.exit(2);
    }
    const out = await injectSlackInteractivity({
      cbId: flags['cb-id'],
      value: flags.value,
      token: flags.token,
      answer: flags.answer,
      channel: flags.channel,
      messageTs: flags['message-ts'],
      select: 'select' in flags,
      datepicker: 'datepicker' in flags,
      selectedDate: flags['selected-date'],
    });
    printResult(out, PRETTY);
    return;
  }

  if (subcommand === 'mailgun-email' || subcommand === 'mailgun') {
    if (!flags.to) {
      console.error(
        'Usage: pnpm dev:inject mailgun-email --to <address> [--fixture <path>] [--from <addr>] [--subject "<s>"] [--api-key <key>]',
      );
      console.error(
        '  --to is the activation-minted inbox+pi-<id>@example.com address.',
      );
      process.exit(2);
    }
    const out = await injectMailgunEmail({
      to: flags.to,
      fixture: flags.fixture,
      from: flags.from,
      subject: flags.subject,
      apiKey: flags['api-key'],
    });
    printResult(out, PRETTY);
    return;
  }

  if (subcommand === 'resend-email' || subcommand === 'resend') {
    if (!flags.to) {
      console.error(
        'Usage: pnpm dev:inject resend-email --to <address> [--fixture <path>] [--from <addr>] [--subject "<s>"] [--secret <whsec_…>]',
      );
      console.error('  --to is the activation-minted inbound address.');
      process.exit(2);
    }
    const out = await injectResendEmail({
      to: flags.to,
      fixture: flags.fixture,
      from: flags.from,
      subject: flags.subject,
      secret: flags.secret,
    });
    printResult(out, PRETTY);
    return;
  }

  if (subcommand === 'telegram-event' || subcommand === 'telegram') {
    if (!flags.text && flags.voice !== 'true') {
      console.error(
        'Usage: pnpm dev:inject telegram-event --text "<t>" [--voice] [--voice-file <path>] [--chat-id <id>] [--sender-id <id>] [--username <u>] [--first-name <n>] [--message-id <id>]',
      );
      console.error('  --voice attaches a voice note (real audio bytes seeded into fake Telegram).');
      process.exit(2);
    }
    const out = await injectTelegramEvent({
      text: flags.text,
      chatId: flags['chat-id'],
      senderId: flags['sender-id'],
      username: flags.username,
      firstName: flags['first-name'],
      messageId: flags['message-id'],
      voice: flags.voice === 'true',
      voiceFile: flags['voice-file'],
    });
    printResult(out, PRETTY);
    return;
  }

  if (subcommand === 'telegram-builtin') {
    if (!flags.text) {
      console.error(
        'Usage: pnpm dev:inject telegram-builtin --text "<t>" [--chat-id <id>] [--sender-id <id>] [--username <u>] [--first-name <n>] [--message-id <id>]',
      );
      console.error(
        '  Fires at the SHARED built-in bot entry (/api/public/telegram/builtin) — routes by sender identity.',
      );
      process.exit(2);
    }
    const out = await injectTelegramBuiltin({
      text: flags.text,
      chatId: flags['chat-id'],
      senderId: flags['sender-id'],
      username: flags.username,
      firstName: flags['first-name'],
    });
    printResult(out, PRETTY);
    return;
  }

  if (subcommand === 'telegram-callback') {
    if (!flags['cb-id'] && !flags.token && !flags.data) {
      console.error(
        'Usage: pnpm dev:inject telegram-callback --cb-id <cb_…> [--message-id <id>] [--chat-id <id>] [--sender-id <id>] [--byo]',
      );
      console.error(
        '   or (legacy ask link): pnpm dev:inject telegram-callback --token <ask_…> --answer <v> [--message-id <id>]',
      );
      console.error('   or: pnpm dev:inject telegram-callback --data "<verbatim callback_data>"');
      console.error(
        '  Taps an inline-keyboard button — the PLATFORM path (recognition → router → ack → keyboard), unlike `dev:inject callback`, which posts to the HTTP door.',
      );
      console.error(
        '  --byo fires at the per-subscription door instead of the shared built-in entry.',
      );
      process.exit(2);
    }
    const out = await injectTelegramCallback({
      cbId: flags['cb-id'],
      token: flags.token,
      answer: flags.answer,
      data: flags.data,
      chatId: flags['chat-id'],
      senderId: flags['sender-id'],
      messageId: flags['message-id'],
      byo: 'byo' in flags,
    });
    printResult(out, PRETTY);
    return;
  }

  if (subcommand === 'telegram-start') {
    const out = await injectTelegramStart({
      token: flags.token,
      senderId: flags['sender-id'],
      chatId: flags['chat-id'],
      username: flags.username,
      firstName: flags['first-name'],
    });
    printResult(out, PRETTY);
    return;
  }

  if (subcommand === 'whatsapp' || subcommand === 'whatsapp-event') {
    if (!flags.from) {
      console.error(
        'Usage: pnpm dev:inject whatsapp --from <phone> [--text "<t>"] [--media] [--media-type image|document|audio] [--media-id <id>] [--name "<n>"]',
      );
      console.error(
        '   or: pnpm dev:inject whatsapp --from <phone> --cb-id <cb_…>  (tap an interactive reply button — the PLATFORM path: door → router → ack reply)',
      );
      process.exit(2);
    }
    const mediaType =
      flags['media-type'] === 'document'
        ? 'document'
        : flags['media-type'] === 'audio'
          ? 'audio'
          : flags['media-type'] === 'image'
            ? 'image'
            : undefined;
    const out = await injectWhatsapp({
      from: flags.from,
      reaction: flags.reaction === 'true' ? '👍' : flags.reaction,
      reactedMessageId: flags['reacted-message-id'],
      text: flags.text,
      media: 'media' in flags,
      mediaType,
      mediaId: flags['media-id'],
      name: flags.name,
      cbId: flags['cb-id'],
    });
    printResult(out, PRETTY);
    return;
  }

  if (subcommand === 'cron') {
    printResult(await injectCron({ movement: flags.movement }), PRETTY);
    return;
  }

  if (subcommand === 'granola') {
    if (!flags.title) {
      console.error(
        'Usage: pnpm dev:inject granola --title "<t>" [--summary "<s>"] [--owner <email>] [--owner-name "<n>"] [--attendee <email[,email]>] [--folder "<f>"] [--id <noteId>]',
      );
      console.error('  Run `pnpm dev:granola setup` first to provision the listener movement.');
      process.exit(2);
    }
    const attendees = flags.attendee
      ? flags.attendee.split(',').map((a) => a.trim()).filter(Boolean)
      : undefined;
    const out = await injectGranola({
      title: flags.title,
      summary: flags.summary,
      owner: flags.owner,
      ownerName: flags['owner-name'],
      attendees,
      folder: flags.folder,
      id: flags.id,
    });
    printResult(out, PRETTY);
    return;
  }

  if (subcommand === 'evertrace') {
    const out = await injectEvertrace({
      firstName: flags['first-name'],
      lastName: flags['last-name'],
      type: flags.type,
      score: flags.score,
      company: flags.company,
      id: flags.id,
    });
    printResult(out, PRETTY);
    return;
  }

  if (subcommand === 'evertrace-list-entry') {
    if (!flags.list) {
      console.error(
        'Usage: pnpm dev:inject evertrace-list-entry --list <name|id> [--signal <signal id>]',
      );
      process.exit(2);
    }
    printResult(
      await injectEvertraceListEntry({ list: flags.list, signal: flags.signal }),
      PRETTY,
    );
    return;
  }

  if (subcommand === 'dealroom') {
    const out = await injectDealroom({
      round: flags.round,
      company: flags.company,
      amount: flags.amount,
      currency: flags.currency,
      investors: flags.investors ? flags.investors.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      noSeed: flags['no-seed'] === 'true',
    });
    printResult(out, PRETTY);
    return;
  }

  if (subcommand === 'gmail-message') {
    const out = await injectGmailMessage({
      subject: flags.subject,
      from: flags.from,
      to: flags.to,
      cc: flags.cc,
      body: flags.body,
      bodyHtml: flags['body-html'],
      labels: flags.labels ? flags.labels.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      attachment: flags.attachment,
      expireHistory: flags['expire-history'] === 'true',
      noSeed: flags['no-seed'] === 'true',
    });
    printResult(out, PRETTY);
    return;
  }

  if (subcommand === 'oauth-expire') {
    const seed = await ensureDevLoopTeam();
    printResult(await expireDevLoopDropboxCredential(seed.teamId), PRETTY);
    return;
  }

  if (subcommand === 'oauth-config') {
    printResult(
      await fakeOAuthControl('config', {
        ...(flags['expires-in'] !== undefined ? { expiresIn: Number(flags['expires-in']) } : {}),
        ...(flags.rotate !== undefined ? { rotate: flags.rotate === 'true' } : {}),
        ...(flags['fail-next'] !== undefined ? { failNext: Number(flags['fail-next']) } : {}),
        ...(flags['fail-with'] !== undefined ? { failWith: flags['fail-with'] } : {}),
      }),
      PRETTY,
    );
    return;
  }

  if (subcommand === 'callback' || subcommand === 'cb') {
    if (!flags['cb-id']) {
      console.error(
        "Usage: pnpm dev:inject callback --cb-id <cb_...> [--param name=value ...] [--param-json '<json>']",
      );
      process.exit(2);
    }
    printResult(
      await injectCallback({
        id: flags['cb-id'],
        params: collectParams(rest),
        paramJson: flags['param-json'],
      }),
      PRETTY,
    );
    return;
  }

  if (subcommand === 'kg-mutation') {
    if (!flags['node-type']) {
      console.error(
        'Usage: pnpm dev:inject kg-mutation --node-type <name|id> [--node-id <uuid>] [--change-kind create|update|delete] [--fields <id,id>]',
      );
      process.exit(2);
    }
    const changeKind =
      flags['change-kind'] === 'create' || flags['change-kind'] === 'delete'
        ? flags['change-kind']
        : 'update';
    const fields = flags.fields ? flags.fields.split(',').map((f) => f.trim()).filter(Boolean) : undefined;
    printResult(
      await injectKgMutation({
        nodeType: flags['node-type'],
        nodeId: flags['node-id'],
        changeKind,
        fields,
      }),
      PRETTY,
    );
    return;
  }

  if (subcommand === 'crm-company') {
    if (!flags.name) {
      console.error('Usage: pnpm dev:inject crm-company --name "<Name>" [--description "<text>"]');
      process.exit(2);
    }
    printResult(
      await injectFakeCrm('companies', {
        Name: flags.name,
        ...(flags.description !== undefined ? { Description: flags.description } : {}),
      }),
      PRETTY,
    );
    return;
  }

  if (subcommand === 'crm-comment') {
    if (!flags.company || !flags.text) {
      console.error('Usage: pnpm dev:inject crm-comment --company <company-N> --text "<comment>"');
      process.exit(2);
    }
    printResult(await injectFakeCrm('comments', { company: flags.company, text: flags.text }), PRETTY);
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  console.error(
    'Available: raw, attio-webhook, airtable-webhook, slack-event, slack-interactivity, mailgun-email, resend-email, telegram-event, telegram-builtin, telegram-callback, telegram-start, whatsapp, cron, granola, evertrace, evertrace-list-entry, dealroom, gmail-message, oauth-expire, oauth-config, kg-mutation, callback, crm-company, crm-comment',
  );
  process.exit(2);
}

// Only run main when invoked as a script — not when imported by tests.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
