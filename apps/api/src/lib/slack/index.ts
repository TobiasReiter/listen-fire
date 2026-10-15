import {
  ChatPostMessageArguments,
  ChatUpdateArguments,
  KnownBlock,
  WebAPICallResult,
  WebClient,
} from '@slack/web-api';
import { IncomingWebhook, IncomingWebhookSendArguments } from '@slack/webhook';

import { logger } from 'movement-engine/services/logger';
import { MINUTE } from '../../constants';
import { getAutomationsQb } from '../kysely';
import { decryptToken } from '../credentials';
import { getErrorMessage } from 'movement-engine/lib/utils/error';
import { notNull } from '../utils/nullability';
import { services } from '../../adapters/registry';
import { unsafeCurrentContext } from '../../services/context';
import { emitOpsEvent } from '../ops/emit';
import { renderLogsUrl } from '../render_logs_url';
import { opsTypeFromSlack, deriveTitle } from '../ops/types';
import { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';

const SLACK_ERROR_MESSAGE_LENGTH_LIMIT = 500;
const SLACK_TRUNCATION_SUFFIX =
  '... (truncated - please check Sentry or the logs for the full message)';

const NotificationSlackWebhooks = {
  PORTFOLIO: process.env.SLACK_WEBHOOK_ACTIVITY,
  DEALFLOW: process.env.SLACK_WEBHOOK_DEALFLOW,
  DIRECTORY: process.env.SLACK_WEBHOOK_INVESTOR_DIRECTORY,
  LIVE_FEED: process.env.SLACK_WEBHOOK_LIVE_FEED,
  ONBOARDING: process.env.SLACK_WEBHOOK_ONBOARDING,
  SCHEDULED_COMMS: process.env.SLACK_WEBHOOK_SCHEDULED_COMMS,
  SUPPORT: process.env.SLACK_WEBHOOK_SUPPORT,
  SOCIAL: process.env.SLACK_WEBHOOK_SOCIAL,
  METRICS: process.env.SLACK_WEBHOOK_METRICS,
  OVI: process.env.SLACK_WEBHOOK_OVI,
};

type SlackNotificationType =
  | 'PORTFOLIO'
  | 'DEALFLOW'
  | 'DIRECTORY'
  | 'LIVE_FEED'
  | 'ONBOARDING'
  | 'SCHEDULED_COMMS'
  | 'SUPPORT'
  | 'SOCIAL'
  | 'METRICS'
  | 'OVI';

// Categories we no longer ping into Slack — they remain in the admin Operations
// Feed (via the emitOpsEvent dual-write below), which is now the home for
// inbound-WhatsApp ("OVI") and onboarding activity. Slack stays reserved for the
// higher-signal ops channels.
const SLACK_SUPPRESSED_TYPES: ReadonlySet<SlackNotificationType> = new Set<SlackNotificationType>([
  'OVI',
  'ONBOARDING',
]);

async function sendSlackNotification({
  text,
  blocks,
  type,
  teamId,
  opsTitle,
}: IncomingWebhookSendArguments & {
  type: SlackNotificationType;
  /** Attributes the ops-feed event to a team (resolves `team_name` in the admin
   *  feed instead of "Unknown team"). Optional — many ops events are team-less. */
  teamId?: string | null;
  /** Plain-language title for the ops feed, decoupled from the Slack `text`.
   *  Slack keeps its richer wording (emoji, bold); the feed shows this instead.
   *  Falls back to the first line of `text` when omitted. */
  opsTitle?: string;
}) {
  const suppressSlack = SLACK_SUPPRESSED_TYPES.has(type);
  const feedTitle = opsTitle ?? deriveTitle(text);
  const url = NotificationSlackWebhooks[type];

  // This is alerting/telemetry — it must never throw for lack of ambient
  // context, so read optionally rather than via the throwing currentContext().
  // A caller with no ALS context at all (e.g. a bare worker loop) just gets no
  // request-id log-link prefix below, instead of losing the notification.
  const requestId = unsafeCurrentContext()?.id;

  // Dual-run: write the EU ops_event for every operator-facing notification
  // (the non-run-routed path).
  void emitOpsEvent({
    type: opsTypeFromSlack(type),
    title: feedTitle,
    detail: { text, blocks },
    teamId: teamId ?? null,
  }).catch((e) => logger.warn('emitOpsEvent from slack shim failed', { error: e }));

  if (text && requestId) {
    const short = requestId.slice(0, 8);
    const logsUrl = renderLogsUrl(requestId);
    text = `[${logsUrl ? `<${logsUrl}|${short}>` : short}] ${text}`;
  }

  if (!url || suppressSlack) {
    logger.info('Dry running slack notification', { type, text, blocks });
    return;
  }
  const webhook = new IncomingWebhook(url);
  return webhook.send({ text, blocks });
}

class WebClientWithCache extends WebClient {
  private cache: Record<string, unknown> = {};
  private ttlMap: Record<string, number> = {
    'users.list': 1 * MINUTE,
    'conversations.info': 1 * MINUTE,
    'conversations.members': 1 * MINUTE,
  };

  async apiCall(...args: Parameters<WebClient['apiCall']>) {
    const [method] = args;
    const ttl = this.ttlMap[method];
    const key = ttl ? JSON.stringify(args) : undefined;
    if (ttl && key) {
      if (this.cache[key]) {
        return this.cache[key] as WebAPICallResult;
      }
    }

    const result = await super.apiCall(...args);

    if (ttl && key) {
      this.cache[key] = result;
      setTimeout(() => {
        delete this.cache[key];
      }, ttl);
    }

    return result;
  }
}

const webClientsByAccessToken: Record<string, WebClient> = {};

const getWebClient = (accessToken: string): WebClient => {
  if (!webClientsByAccessToken[accessToken]) {
    webClientsByAccessToken[accessToken] = new WebClientWithCache(accessToken);
  }

  return webClientsByAccessToken[accessToken];
};

class SlackMonitoring {
  private credentialsId: string;
  private conversationId: string;

  private webClient: WebClient | undefined;

  constructor({
    credentialsId,
    conversationId,
  }: {
    credentialsId: string;
    conversationId: string;
  }) {
    this.credentialsId = credentialsId;
    this.conversationId = conversationId;
  }

  async getClient() {
    if (this.webClient) {
      return this.webClient;
    }

    const credentials = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('type', '=', ExternalServiceType.SLACK)
      .where('id', '=', this.credentialsId as ExternalServiceCredentialsId)
      .select(['id', 'credentials'])
      .executeTakeFirst();

    let accessToken: string | undefined;
    if (credentials) {
      const decryptedCreds = await decryptToken(credentials.credentials, credentials.id);
      const credsObject = JSON.parse(decryptedCreds);
      accessToken = credsObject.accessToken as string;
    }

    if (!accessToken) {
      throw new Error('No access token found for team id');
    }

    this.webClient = getWebClient(accessToken);
    return this.webClient;
  }

  async send(options: Omit<Extract<ChatPostMessageArguments, { blocks: any }>, 'channel'>) {
    const client = await this.getClient();
    const args = {
      ...options,
      channel: this.conversationId,
    } as ChatPostMessageArguments;
    return client.chat.postMessage(args);
  }

  async update(options: Omit<Extract<ChatUpdateArguments, { blocks: any }>, 'channel'>) {
    const client = await this.getClient();
    const args = {
      ...options,
      channel: this.conversationId,
    } as ChatUpdateArguments;
    return client.chat.update(args);
  }

  async startPipeline({
    email,
    channel,
    requestId,
  }: {
    email: string;
    channel: string;
    requestId: string;
  }) {
    const logsUrl = renderLogsUrl(requestId);
    const short = `[${requestId.slice(0, 8)}]`;
    const requestIdMarkup = logsUrl ? `<${logsUrl}|${short}>` : short;
    return this.send({
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:tropical_fish: \`${channel}\` ${requestIdMarkup} from ${email}`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'image',
              image_url:
                'https://imagedelivery.net/MtyoQnRb3eQvVziZgpAo2w/31694c2f-7ba1-4087-e808-59a64588bf00/public',
              alt_text: 'ellipsis',
            },
            {
              type: 'mrkdwn',
              text: '> Starting...',
            },
          ],
        },
      ],
      text: `:tropical_fish: \`${channel}\` ${requestIdMarkup} from ${email}\n> Starting...`,
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  async updatePipeline({ ts, message }: { ts: string; message: string }) {
    const client = await this.getClient();
    const response = await client.conversations.history({
      channel: this.conversationId,
      latest: ts,
      limit: 1,
      inclusive: true,
    });
    const firstMessage = response.messages?.[0];
    if (!firstMessage) {
      return;
    }

    const newBlocks = firstMessage.blocks as KnownBlock[];
    const contextBlock = newBlocks?.[1];
    if (contextBlock?.type !== 'context') {
      return;
    }

    // This cast feels suspicious
    const elements = contextBlock.elements;
    const markdownBlock = elements?.[1];
    if (markdownBlock?.type !== 'mrkdwn') {
      return;
    }

    markdownBlock.text = '> ' + message;
    await this.update({
      ts,
      blocks: newBlocks,
    });
  }

  async completePipeline({
    ts,
    completedIn,
  }: {
    ts: string;
    completedIn: { minutes: number; seconds: number };
  }) {
    const client = await this.getClient();
    const response = await client.conversations.history({
      channel: this.conversationId,
      latest: ts,
      limit: 1,
      inclusive: true,
    });
    const firstMessage = response.messages?.[0];
    if (!firstMessage) {
      return;
    }

    const newBlocks = firstMessage.blocks as KnownBlock[];

    await this.update({
      ts,
      blocks: [
        newBlocks[0],
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:white_check_mark: Completed (${completedIn.minutes}m ${completedIn.seconds}s)`,
          },
        },
      ],
    });
  }

  async failPipeline({ ts, errors }: { ts: string; errors: unknown[] }) {
    const client = await this.getClient();
    const response = await client.conversations.history({
      channel: this.conversationId,
      latest: ts,
      limit: 1,
      inclusive: true,
    });
    const firstMessage = response.messages?.[0];
    if (!firstMessage) {
      return;
    }

    const newBlocks = firstMessage.blocks as KnownBlock[];

    await this.update({
      ts,
      blocks: [
        newBlocks[0],
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':x: Failed',
          },
        },
        errors.length > 0
          ? {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `\n\nThe were some issues:${errors
                  .map((error) => `\n• ${this.getErrorMessageForSlack(error)}`)
                  .join('')}`,
              },
            }
          : null,
      ].filter(notNull),
    });
  }

  async addThreadMessage({ ts, message }: { ts: string; message: string }) {
    const client = await this.getClient();
    await client.chat.postMessage({
      channel: this.conversationId,
      thread_ts: ts,
      text: message,
      unfurl_links: false,
      unfurl_media: false,
    });

    await this.updatePipeline({
      ts,
      message: message.split('\n')[0],
    });
  }

  getErrorMessageForSlack(error: unknown) {
    const errorMessage = getErrorMessage(error);
    const truncatedMessage = errorMessage.slice(0, SLACK_ERROR_MESSAGE_LENGTH_LIMIT);

    if (errorMessage.length > truncatedMessage.length) {
      return truncatedMessage + SLACK_TRUNCATION_SUFFIX;
    }
    return truncatedMessage;
  }
}

export { sendSlackNotification, SlackNotificationType, getWebClient, SlackMonitoring };
