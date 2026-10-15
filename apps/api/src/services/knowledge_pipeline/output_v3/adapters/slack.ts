import type { FileUploadComplete } from '@slack/web-api/dist/types/request/files';
import type { MessageAttachment } from '@slack/web-api';
import type { getSlackClient } from '../../../../adapters/slack/webApi/apiClient';
import type { V3Adapter, V3AdapterExecuteInput, AdapterResult, ResourceContext } from './types';

import { services } from '../../../../adapters/registry';
import { logger } from 'movement-engine/services/logger';
import { composeTextFromPrompt, resolvePreserveTags, loadResources } from '../resolve';
import { resolveConfigField } from './types';

const SLACK_SYSTEM_PROMPT_EXTENSION = `This message will be sent to Slack. Use Slack-native formatting only:
- Bold: *bold*
- Italic: _italic_
- Strikethrough: ~strike~
- Link: <url|display text> (ALWAYS use this exact syntax for links — the angle brackets and pipe are required)
- Emoji codes: :emoji_name:
- Code: \`inline\` or \`\`\`block\`\`\`
- Tagging users: <@user_id>

Do NOT use markdown formatting (no ## headers, no **bold**, no [links](url)).
When the prompt includes a URL to link to along with some display text, you MUST output it as <https://example.com|display text>. If you have only one of display text or a url you don't need to format the link in this way.`;

async function fetchSlackMemberContext(
  client: ReturnType<typeof getSlackClient>,
  channelId: string,
): Promise<string | undefined> {
  try {
    const [users, channelMembers] = await Promise.all([
      client.api.users.list({}),
      client.api.conversations.members({ channel: channelId }),
    ]);
    const channelMemberIds = channelMembers.members;
    const memberList = users.members
      ?.filter(
        (user) =>
          !user.deleted &&
          !user.is_bot &&
          (!channelMemberIds || channelMemberIds.includes(user.id!)),
      )
      .map((user) => `Name: ${user.name}, ID: ${user.id}`)
      .join('\n');
    if (!memberList) return undefined;
    return `"user_id" is the Slack user ID of the user to tag. Here are the users in the channel:\n${memberList}`;
  } catch (e) {
    logger.warn('[SlackV3] Failed to fetch Slack member list for tagging', { error: e });
    return undefined;
  }
}

// name→ID resolution
async function resolveChannelId(
  client: ReturnType<typeof getSlackClient>,
  input: V3AdapterExecuteInput,
): Promise<string | undefined> {
  const resolved = await resolveConfigField('channelId', input.adapterConfig, input);
  if (!resolved) return undefined;
  // If it looks like a channel ID already (starts with C, D, or G), use directly
  if (/^[CDG][A-Z0-9]+$/.test(resolved)) return resolved;
  // Otherwise resolve name → ID
  const channels = await client.api.conversations.list({ types: 'public_channel,private_channel', limit: 1000 });
  const match = channels.channels?.find(ch => ch.name?.toLowerCase() === resolved.toLowerCase());
  if (match?.id) return match.id;
  logger.warn(`[SlackV3] Could not resolve channel name "${resolved}" to ID`);
  return undefined;
}

function createSlackV3Adapter(client: ReturnType<typeof getSlackClient>): V3Adapter {
  return {
    async execute(input: V3AdapterExecuteInput): Promise<AdapterResult> {
      const [, actionType] = input.type.split(':');

      if (actionType === 'message') {
        return executeMessage(client, input);
      } else if (actionType === 'thread-reply') {
        return executeThreadReply(client, input);
      } else if (actionType === 'attachment') {
        return executeAttachment(client, input);
      } else if (actionType === 'preview') {
        return executePreview(client, input);
      }

      logger.warn(`Slack v3 adapter: unknown action type "${actionType}"`);
      return {};
    },
  };
}

async function executeMessage(
  client: ReturnType<typeof getSlackClient>,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  const config = input.adapterConfig as { channelId: unknown; prompt: string };
  const channelId = await resolveChannelId(client, input);
  if (!channelId) return { skipped: true, skipReason: 'No channel ID configured' };
  if (!config.prompt) return { skipped: true, skipReason: 'No message prompt configured' };

  // If already linked to a message, reuse it as the thread parent instead of posting again
  if (input.linkedObjects.length > 0) {
    const existing = input.linkedObjects[0];
    logger.info(`[SlackV3] Reusing existing message ${existing.externalId} in ${channelId}`);
    return {
      externalId: existing.externalId,
      parentMessage: { channelId, threadTs: existing.externalId },
    };
  }

  // Ensure we're in the channel
  const info = await client.api.conversations.info({ channel: channelId });
  if (!info.channel?.is_member && !input.readOnly) {
    await client.api.conversations.join({ channel: channelId });
  }

  const memberContext = await fetchSlackMemberContext(client, channelId);

  let text = await composeTextFromPrompt(config.prompt, input.contextNodeId, input.context, {
    systemPromptExtension: SLACK_SYSTEM_PROMPT_EXTENSION,
    additionalContext: memberContext,
  });
  if (!text) return { skipped: true, skipReason: 'LLM returned empty message' };
  if (input.afterEmbedValues?.size) text = resolvePreserveTags(text, input.afterEmbedValues);

  // Read-only mode: resolve message text but don't post
  if (input.readOnly) {
    return {
      displayValues: { Message: text },
      parentMessage: { channelId, threadTs: `readonly-${Date.now()}` },
    };
  }

  const threadTs = input.parentResult?.parentMessage?.threadTs;

  const response = await client.api.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });

  if (!response.ts) {
    logger.error('Slack v3: failed to send message');
    return {};
  }

  return {
    externalId: response.ts,
    data: { channelId },
    displayValues: { Message: text },
    parentMessage: { channelId, threadTs: response.ts },
  };
}

async function executeThreadReply(
  client: ReturnType<typeof getSlackClient>,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  if (!input.parentResult?.parentMessage) {
    throw new Error('Slack thread-reply requires a parent message');
  }

  const config = input.adapterConfig as { prompt: string };
  if (!config.prompt) return { skipped: true, skipReason: 'No reply prompt configured' };

  const { channelId, threadTs } = input.parentResult.parentMessage;

  const memberContext = await fetchSlackMemberContext(client, channelId);

  let text = await composeTextFromPrompt(config.prompt, input.contextNodeId, input.context, {
    systemPromptExtension: SLACK_SYSTEM_PROMPT_EXTENSION,
    additionalContext: memberContext,
  });
  if (!text) return { skipped: true, skipReason: 'LLM returned empty reply' };
  if (input.afterEmbedValues?.size) text = resolvePreserveTags(text, input.afterEmbedValues);

  // Read-only mode: resolve reply text but don't post
  if (input.readOnly) {
    return {
      displayValues: { Reply: text },
      parentMessage: { channelId, threadTs },
    };
  }

  const response = await client.api.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });

  return {
    externalId: response.ts,
    displayValues: { Reply: text },
    parentMessage: { channelId, threadTs },
  };
}

async function executeAttachment(
  client: ReturnType<typeof getSlackClient>,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  if (!input.parentResult?.parentMessage) {
    throw new Error('Slack attachment requires a parent message');
  }

  const { channelId, threadTs } = input.parentResult.parentMessage;

  let resources: ResourceContext[];
  if (input.resource) {
    resources = [input.resource];
  } else {
    const mimeType = input.adapterConfig.mimeType as string | undefined;
    const namePattern = input.adapterConfig.namePattern as string | undefined;
    resources = await loadResources(input.contextNodeId, input.context, {
      resourceType: 'FILE',
      hasDocument: true,
      ...(mimeType ? { mimeType } : {}),
      ...(namePattern ? { namePattern } : {}),
    });
  }

  const downloadable = resources.filter((r) => r.documentObjectUri);
  if (downloadable.length === 0) {
    return { skipped: true, skipReason: 'No downloadable files found' };
  }

  // Read-only mode: resolve which files would be uploaded but don't upload
  if (input.readOnly) {
    return {
      displayValues: { Attachments: downloadable.map((r) => r.name).join(', ') },
      parentMessage: { channelId, threadTs },
    };
  }

  const uploadedFiles: FileUploadComplete[] = [];
  for (const resource of downloadable) {
    const uploaded = await uploadFileToSlack(client, resource);
    if (uploaded) uploadedFiles.push(uploaded);
  }

  if (uploadedFiles.length === 0) {
    return { skipped: true, skipReason: 'All file uploads failed' };
  }

  await client.api.files.completeUploadExternal({
    channel_id: channelId,
    thread_ts: threadTs,
    files: uploadedFiles as [FileUploadComplete, ...FileUploadComplete[]],
  });

  logger.info(`[SlackV3] Uploaded ${uploadedFiles.length} file(s) to ${channelId}`);

  return {
    parentMessage: { channelId, threadTs },
  };
}

async function uploadFileToSlack(
  client: ReturnType<typeof getSlackClient>,
  resource: ResourceContext,
): Promise<FileUploadComplete | null> {
  try {
    const retrieved = await services.document.getFile({ objectUri: resource.documentObjectUri! });
    if (!retrieved?.ContentLength) return null;

    const uploadUrlResponse = await client.api.files.getUploadURLExternal({
      filename: resource.name,
      length: retrieved.ContentLength,
    });

    if (!uploadUrlResponse?.upload_url || !uploadUrlResponse?.file_id) {
      logger.error('[SlackV3] Failed to get upload URL', { error: uploadUrlResponse.error });
      return null;
    }

    const uploadResponse = await client.fetch(uploadUrlResponse.upload_url, {
      method: 'POST',
      body: retrieved.webStream,
      duplex: 'half',
      headers: {
        'Content-Type': retrieved.ContentType ?? 'application/octet-stream',
      },
    } as RequestInit);

    if (!uploadResponse.ok) {
      logger.error(`[SlackV3] Failed to upload "${resource.name}"`);
      return null;
    }

    return { id: uploadUrlResponse.file_id, title: resource.name };
  } catch (err) {
    logger.error(`[SlackV3] Failed to upload "${resource.name}"`, { error: err });
    return null;
  }
}

// -- Preview --

const EMAIL_CHANNELS = new Set(['MAILGUN', 'INBOUND_EMAIL', 'CUSTOM_EMAIL']);

function isEmailPayload(resource: ResourceContext): boolean {
  if (resource.type === 'EMAIL') return true;
  const payloadChannel = resource.metadata.payloadChannel as string | undefined;
  return payloadChannel ? EMAIL_CHANNELS.has(payloadChannel) : false;
}

const BODY_MAX_LENGTH = 3000;

function truncateBody(text: string): string {
  if (text.length <= BODY_MAX_LENGTH) return text;
  return text.slice(0, BODY_MAX_LENGTH) + '\n…_(truncated)_';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildEmailHeaderBlocks(
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>,
): { blocks: Record<string, unknown>[]; text: string; subject: string } {
  // `??` only falls back on null/undefined — a present-but-blank subject (`""`)
  // would slip through and produce an empty header block (Slack rejects those).
  const rawSubject = (payload.subject ?? metadata.subject) as string | undefined;
  const subject = rawSubject && rawSubject.trim().length > 0 ? rawSubject : 'No subject';
  const sender = (payload.sender ??
    payload['X-Original-From'] ??
    metadata.from_address ??
    '') as string;
  const to = (payload.To ?? metadata.to_address ?? payload.recipient ?? '') as string;
  const cc = (payload.Cc ?? '') as string;

  const headerFields: string[] = [];
  if (sender) headerFields.push(`*From:*  ${sender}`);
  if (to) headerFields.push(`*To:*  ${to}`);
  if (cc) headerFields.push(`*Cc:*  ${cc}`);

  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: subject.slice(0, 150), emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: headerFields.join('\n') },
    },
  ];

  return { blocks, text: `${subject} — from ${sender}`, subject };
}

function getEmailBodyHtml(payload: Record<string, unknown>): string {
  const bodyHtml = payload['body-html'] as string | undefined;
  if (bodyHtml) return bodyHtml;

  const bodyPlain = (payload['body-plain'] ?? payload['stripped-text']) as string | undefined;
  if (bodyPlain) {
    return `<pre style="font-family: sans-serif; white-space: pre-wrap; word-wrap: break-word;">${escapeHtml(bodyPlain)}</pre>`;
  }

  return '<p style="color: #999;">No body content</p>';
}

async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const { PlaywrightService } = await import('../../../playwright');
  const fullHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 24px; color: #222; background: #fff; font-size: 14px; line-height: 1.5; }
</style></head><body>${html}</body></html>`;

  return PlaywrightService.withPage(async (page) => {
    await page.setContent(fullHtml, { waitUntil: 'domcontentloaded' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '16px', bottom: '16px', left: '16px', right: '16px' },
      printBackground: true,
    });
    return Buffer.from(pdfBuffer);
  });
}

function buildSlackBlocks(
  payload: Record<string, unknown>,
  resourceName: string,
): { blocks: Record<string, unknown>[] } {
  const event = (payload.event ?? {}) as Record<string, unknown>;
  const text = (event.text ?? payload.text ?? '') as string;

  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: resourceName.slice(0, 150), emoji: true },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: truncateBody(text) },
    },
  ];

  return { blocks };
}

function buildGenericBlocks(
  payload: Record<string, unknown>,
  resource: ResourceContext,
): { blocks: Record<string, unknown>[] } {
  const bodyHtml = payload['body-html'] as string | undefined;
  const bodyPlain = (payload['body-plain'] ?? payload['stripped-text'] ?? payload.text) as
    | string
    | undefined;
  const bodyText = bodyHtml
    ? bodyHtml
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .trim()
    : bodyPlain ?? '';

  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: resource.name.slice(0, 150), emoji: true },
    },
    { type: 'divider' },
  ];

  if (bodyText) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncateBody(bodyText) },
    });
  }

  return { blocks };
}

/**
 * Slack rejects any Block Kit block whose `text.text` is an empty string
 * (`invalid_attachments`). A content-less resource (e.g. an email with a blank
 * subject or body) can produce empty blocks, so drop them before posting.
 * Structural blocks (e.g. `divider`) carry no `text` and are preserved.
 */
export function pruneEmptyBlocks(blocks: Record<string, unknown>[]): Record<string, unknown>[] {
  return blocks.filter((block) => {
    const text = (block.text as { text?: unknown } | undefined)?.text;
    return typeof text !== 'string' || text.trim().length > 0;
  });
}

async function executePreview(
  client: ReturnType<typeof getSlackClient>,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  let channelId: string | undefined;
  let threadTs: string | undefined;

  if (input.parentResult?.parentMessage) {
    channelId = input.parentResult.parentMessage.channelId;
    threadTs = input.parentResult.parentMessage.threadTs;
  } else {
    channelId = await resolveChannelId(client, input);
  }

  if (!channelId) return { skipped: true, skipReason: 'No channel ID configured or inherited' };

  // Load resource with payload data
  let resources: ResourceContext[];
  if (input.resource) {
    resources = [input.resource];
  } else {
    resources = await loadResources(input.contextNodeId, input.context, { includePayload: true });
  }

  if (resources.length === 0) {
    return { skipped: true, skipReason: 'No resources found for preview' };
  }

  // Prefer content resources (EMAIL/TEXT) over FILE/URL for email previews
  const contentTypeOrder: Record<string, number> = {
    EMAIL: 0,
    TEXT: 1,
    WHATSAPP: 2,
    URL: 3,
    FILE: 4,
  };
  resources.sort((a, b) => (contentTypeOrder[a.type] ?? 99) - (contentTypeOrder[b.type] ?? 99));

  const resource = resources[0];
  logger.info(
    `[SlackV3] Preview using resource "${resource.name}" (type=${resource.type}, id=${resource.resourceId}) from ${resources.length} candidate(s)`,
  );

  if (!resource.payload) {
    logger.info(
      `[SlackV3] Resource "${resource.name}" missing payload, re-loading with includePayload`,
    );
    const enriched = await loadResources(input.contextNodeId, input.context, {
      includePayload: true,
    });
    const match = enriched.find((r) => r.resourceId === resource.resourceId);
    if (match) {
      resource.payload = match.payload;
      if (match.metadata.payloadChannel) {
        (resource.metadata as Record<string, unknown>).payloadChannel =
          match.metadata.payloadChannel;
      }
    }
    if (!resource.payload) {
      logger.warn(
        `[SlackV3] Could not load payload for resource "${resource.name}" (id=${resource.resourceId})`,
      );
    }
  }

  // Ensure we're in the channel
  const info = await client.api.conversations.info({ channel: channelId });
  if (!info.channel?.is_member && !input.readOnly) {
    await client.api.conversations.join({ channel: channelId });
  }

  // Read-only mode: resolve preview content but don't post
  if (input.readOnly) {
    const payload = resource.payload ?? {};
    const previewType = isEmailPayload(resource) ? 'email' : (resource.metadata.payloadChannel as string) ?? resource.type;
    return {
      displayValues: { Preview: `${resource.name} (${previewType})`, Channel: channelId },
      parentMessage: { channelId, threadTs: threadTs ?? `readonly-${Date.now()}` },
    };
  }

  const payload = resource.payload ?? {};
  const metadata = resource.metadata;

  if (isEmailPayload(resource)) {
    // Email: header blocks + PDF of the body
    const { blocks, subject } = buildEmailHeaderBlocks(payload, metadata);
    const bodyHtml = getEmailBodyHtml(payload);

    // Post the header message first
    const safeBlocks = pruneEmptyBlocks(blocks);
    const headerResult = await client.api.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: subject,
      attachments: safeBlocks.length
        ? ([{ color: '#2EB67D', blocks: safeBlocks }] as unknown as MessageAttachment[])
        : undefined,
      unfurl_links: false,
      unfurl_media: false,
    });

    if (!headerResult.ok || !headerResult.ts) {
      logger.error('[SlackV3] Failed to post email header', { error: headerResult.error });
      return {};
    }

    // Render and upload the body as a PDF in the same thread
    try {
      logger.info(`[SlackV3] Rendering email body PDF (html length=${bodyHtml.length})`);
      const pdfBuffer = await renderHtmlToPdf(bodyHtml);
      logger.info(`[SlackV3] PDF rendered (${pdfBuffer.byteLength} bytes)`);

      const uploadUrl = await client.api.files.getUploadURLExternal({
        filename: `${subject}.pdf`,
        length: pdfBuffer.byteLength,
      });

      if (uploadUrl?.upload_url && uploadUrl?.file_id) {
        const uploadResponse = await client.fetch(uploadUrl.upload_url, {
          method: 'POST',
          body: pdfBuffer,
          headers: { 'Content-Type': 'application/pdf' },
        } as RequestInit);

        if (!uploadResponse.ok) {
          logger.error(`[SlackV3] PDF upload POST failed (status=${uploadResponse.status})`);
        }

        await client.api.files.completeUploadExternal({
          channel_id: channelId,
          thread_ts: headerResult.ts,
          files: [{ id: uploadUrl.file_id, title: subject }],
        });

        logger.info(`[SlackV3] PDF uploaded successfully for "${subject}"`);
      } else {
        logger.error('[SlackV3] Failed to get upload URL for PDF', { error: uploadUrl.error });
      }
    } catch (err) {
      logger.error('[SlackV3] Failed to render/upload email body PDF', { error: err });
      // Header was still posted — not a total failure
    }

    logger.info(`[SlackV3] Posted email preview for "${resource.name}" to ${channelId}`);
    return {
      externalId: headerResult.ts,
      data: { channelId },
      parentMessage: { channelId, threadTs: headerResult.ts },
    };
  }

  // Non-email: blocks only
  const payloadChannel = metadata.payloadChannel as string | undefined;
  const { blocks } =
    payloadChannel === 'SLACK'
      ? buildSlackBlocks(payload, resource.name)
      : buildGenericBlocks(payload, resource);

  const safeBlocks = pruneEmptyBlocks(blocks);
  const result = await client.api.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: resource.name,
    attachments: safeBlocks.length
      ? ([{ color: '#4A90D9', blocks: safeBlocks }] as unknown as MessageAttachment[])
      : undefined,
    unfurl_links: false,
    unfurl_media: false,
  });

  if (!result.ok || !result.ts) {
    logger.error('[SlackV3] Failed to post preview message', { error: result.error });
    return {};
  }

  logger.info(`[SlackV3] Posted preview for "${resource.name}" to ${channelId}`);

  return {
    externalId: result.ts,
    data: { channelId },
    parentMessage: { channelId, threadTs: result.ts },
  };
}

export { createSlackV3Adapter };
