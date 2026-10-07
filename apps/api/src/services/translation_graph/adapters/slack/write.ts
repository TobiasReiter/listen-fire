// Slack adapter — target/write side (message-write-unification chunk 1).
// ONE message type (`slack:message`), readable and writable, created only
// along edges:
//
//   Channel -[:Messages]->  Slack Message    — a top-level post
//   msg     -[:Replies]->   Slack Message    — a thread reply
//   msg     -[:Reactions]-> Slack Reaction   — an emoji reaction
//
// `channel` is never a field and `thread_ts` is never exposed: parentage
// supplies both (the parent link's externalId + data — §5.2 of the design).
// A `File` value on the write takes the upload flow with the Message text
// riding as the file's `initial_comment` — one visible Slack message either
// way (verified against the Slack API docs, design resolution 6).

import type { getSlackClient } from '../../../../adapters/slack/webApi/apiClient';
import { logger } from '../../../logger';
import type { FileRef, WriteResult } from '../../adapter';
import { hasFileSource, streamFileRef } from '../../engine/files/retrieve';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import { SLACK_ADAPTER_TYPE } from './types';
import { finalizeMessageText } from './mentions';

type SlackClient = ReturnType<typeof getSlackClient>;

/**
 * `chat.postMessage`'s own `blocks` element type (`ChatPostMessageArguments`
 * isn't a plain interface — it's `TokenOverridable & (ChannelAndText |
 * ChannelAndBlocks | …) & …`, so its `blocks` isn't indexable directly; reach
 * the ONE union member that declares it). We deliberately do not import Block
 * Kit's own typed shape (`@slack/types`' `KnownBlock` etc.) any further than
 * this — Blocks is verbatim passthrough, only validated as "a list of
 * objects" at the adapter boundary (`asBlocksValue`); this alias just
 * satisfies the SDK's call signature at the one place the value crosses it.
 */
type PostMessageBlock =
  import('@slack/web-api/dist/types/request/chat').ChannelAndBlocks['blocks'][number];

/** Where a message write lands — derived from the parent link, never fields. */
export type SlackWriteAnchor =
  | { kind: 'post'; channelId: string }
  | { kind: 'reply'; channelId: string; threadTs: string };

/** Where a reaction lands — the parent message's own channel + ts. */
export type SlackReactionAnchor = { channelId: string; ts: string };

/** A parent Slack Message as the write path sees it — the shape both anchors
 *  are derived from. */
interface SlackWriteParent {
  externalId: string;
  data?: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * A parent message's OWN channel + ts, however its identity was minted. Read
 * positions key `recordId = "<channelId>:<ts>"` (index.ts channel
 * history/replies) while an inbound event's stable id and a WriteResult
 * externalId are the bare ts — in the bare case the channel rides the parent's
 * data (`channel` on positions/events, `channelId` on WriteResult data).
 */
function parentMessageIdentity(parent: SlackWriteParent): {
  channelId: string | undefined;
  ts: string;
} {
  const composite = /^([CDG][A-Z0-9]+):(.+)$/.exec(parent.externalId);
  const data = parent.data ?? {};
  return {
    channelId: composite ? composite[1] : str(data.channel) ?? str(data.channelId),
    ts: composite ? composite[2] : parent.externalId,
  };
}

/**
 * Split a parent Slack Message's identity into channel + thread anchor.
 * A reply-to-a-reply anchors the thread ROOT: the parent's own `thread_ts` /
 * `threadTs` wins over its ts.
 */
export function replyAnchorFromParent(
  parent: SlackWriteParent,
): { channelId: string | undefined; threadTs: string } {
  const { channelId, ts } = parentMessageIdentity(parent);
  const data = parent.data ?? {};
  return { channelId, threadTs: str(data.thread_ts) ?? str(data.threadTs) ?? ts };
}

/**
 * The same split for a reaction — and it stops at the parent's OWN ts rather
 * than climbing to the thread root the way a reply does. A reply JOINS a
 * thread; a reaction sticks to the one message it was handed, which for a
 * message that is itself a thread reply is not the root.
 */
export function reactionAnchorFromParent(
  parent: SlackWriteParent,
): { channelId: string | undefined; ts: string } {
  return parentMessageIdentity(parent);
}

async function ensureChannelMembership(client: SlackClient, channelId: string): Promise<void> {
  const info = await client.api.conversations.info({ channel: channelId });
  if (!info.channel?.is_member) {
    await client.api.conversations.join({ channel: channelId });
  }
}

/** The writeUnion clash wording, mirrored from the checker's
 *  `WRITE_UNION_UNSATISFIED` message (slack/index.ts's `writeUnion` variant
 *  names + field display names) — defense in depth: runtime never trusts
 *  that a payload came through the checker. */
const WRITE_UNION_CLASH =
  "SlackAdapter.createRecord: a Slack Message is either a file post (Message, File) or an interactive post (Message, Blocks) — File and Blocks can't both be set.";

/**
 * The one create path: post or reply, decided by the anchor; text and/or
 * file and/or blocks, decided by the fields (internal currency: `text` /
 * `file` / `blocks` — the adapter's createRecord resolves natural names
 * before calling this). At least one of Message / File / Blocks is
 * required, and File + Blocks is a loud clash — the same union the checker
 * enforces at save time (`writeUnion` on the descriptor), enforced again
 * here because the type system can't say either-of and runtime never
 * trusts that a payload came through the checker.
 */
export async function createUnifiedMessage(input: {
  client: SlackClient;
  /** The team whose run is posting — a `File` value is redeemed for it. */
  teamId: TeamId;
  anchor: SlackWriteAnchor;
  fields: Record<string, unknown>;
}): Promise<WriteResult> {
  const { client, teamId, anchor, fields } = input;
  const text = str(fields.text);
  const fileValue = asFileValue(fields.file);
  const blocks = asBlocksValue(fields.blocks);
  if (!text && !fileValue && blocks === undefined) {
    throw new Error(
      'SlackAdapter.createRecord: a Slack Message needs at least one of Message / File / Blocks.',
    );
  }
  if (fileValue && blocks !== undefined) {
    throw new Error(WRITE_UNION_CLASH);
  }
  const channelId = anchor.channelId;
  await ensureChannelMembership(client, channelId);
  // Resolve @[Name] mention tokens against the channel roster + mrkdwn
  // safety net — the channel is known here. Blocks are NOT touched: verbatim
  // means verbatim, and mention/mrkdwn finalisation is a Message-text concern.
  const finalText = text ? await finalizeMessageText({ client, channelId, text }) : undefined;
  const threadTs = anchor.kind === 'reply' ? anchor.threadTs : undefined;

  if (fileValue) {
    // A file share carries no interactive blocks (Slack's upload flow has no
    // blocks surface) — the writeUnion rules this combination out already.
    return uploadFileMessage({ client, teamId, channelId, threadTs, fileValue, comment: finalText });
  }

  // Blocks ride verbatim; `text` is the notification fallback Slack shows in
  // previews/notifications, omitted entirely when absent (Slack accepts a
  // blocks-only post).
  const response = await postMessage({ client, channelId, threadTs, text: finalText, blocks });
  if (!response.ts) {
    throw new Error('SlackAdapter.createRecord: Slack returned no message ts.');
  }
  return {
    adapterType: SLACK_ADAPTER_TYPE,
    externalId: response.ts,
    data: {
      channelId,
      ts: response.ts,
      ...(threadTs !== undefined ? { threadTs } : {}),
      name: finalText,
      url: channelPermalink(channelId, response.ts),
    },
  };
}

/**
 * The reaction write: `reactions.add` on the message the write anchored off.
 * Channel and ts come from that parent — nothing about WHICH message a
 * reaction lands on is ever a field, exactly as with a reply's thread.
 *
 * `already_reacted` is Slack reporting that the reaction the write asked for is
 * already there, which is the state the author wanted: a no-op success, so
 * re-running a movement over the same message is idempotent like every other
 * write on this adapter.
 */
export async function addReaction(input: {
  client: SlackClient;
  anchor: SlackReactionAnchor;
  fields: Record<string, unknown>;
}): Promise<WriteResult> {
  const { client, anchor, fields } = input;
  const emoji = emojiName(fields.emoji);
  if (!emoji) {
    throw new Error(
      'SlackAdapter.createRecord(reaction): the "Emoji" field must carry an emoji ' +
        'name — e.g. "thumbsup".',
    );
  }
  await ensureChannelMembership(client, anchor.channelId);
  try {
    await client.api.reactions.add({
      channel: anchor.channelId,
      timestamp: anchor.ts,
      name: emoji,
    });
  } catch (err) {
    if (slackErrorCode(err) !== 'already_reacted') throw err;
    logger.info(
      `[SlackAdapter.write] :${emoji}: was already on ${anchor.channelId}/${anchor.ts}`,
    );
  }
  return {
    adapterType: SLACK_ADAPTER_TYPE,
    // Deterministic, so a re-run of the same movement over the same message
    // mints the same handle — matching the idempotent write behind it.
    externalId: `reaction:${anchor.channelId}:${anchor.ts}:${emoji}`,
    // Shaped like an inbound `reaction_added` payload so the Reaction's own
    // `Message` / `Channel` edges resolve off this handle. `user` is absent on
    // purpose: the reactor is the bot, and inventing a member id would be a lie.
    data: {
      reaction: emoji,
      item: { type: 'message', channel: anchor.channelId, ts: anchor.ts },
    },
  };
}

/**
 * The bare emoji name Slack's API wants. Authors write the name they see in
 * Slack, which is as often `:eyes:` as `eyes` — the surrounding colons are
 * Slack's own display convention for the very same value, so stripping them is
 * normalising one spelling, not guessing at intent.
 */
function emojiName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim().replace(/^:|:$/g, '');
  return name.length > 0 ? name : undefined;
}

/** Slack's own error code off a `@slack/web-api` platform rejection. */
function slackErrorCode(err: unknown): string | undefined {
  return (err as { data?: { error?: string } } | undefined)?.data?.error;
}

/**
 * `chat.postMessage`, enriched on failure: Slack's `invalid_blocks`-class
 * errors carry the specific complaint in `response_metadata.messages` (not
 * typed on `@slack/web-api`'s `WebAPICallResult`, but present on the wire) —
 * this is the agreed cost of verbatim, check-time-untyped blocks: no static
 * guarantee, but a loud, specific run error instead of a silent post.
 */
async function postMessage(input: {
  client: SlackClient;
  channelId: string;
  threadTs: string | undefined;
  text: string | undefined;
  blocks: unknown[] | undefined;
}): Promise<{ ts?: string }> {
  const { client, channelId, threadTs, text, blocks } = input;
  const thread = threadTs !== undefined ? { thread_ts: threadTs } : {};
  try {
    // Two literal shapes, not one conditionally-spread object: the SDK types
    // `blocks` as REQUIRED on the blocks variant (`text` optional there) and
    // `text` as required on the text-only variant — an object built with an
    // always-present-but-sometimes-undefined `blocks` key satisfies neither.
    if (blocks !== undefined) {
      return await client.api.chat.postMessage({
        channel: channelId,
        ...thread,
        ...(text !== undefined ? { text } : {}),
        blocks: blocks as PostMessageBlock[],
        unfurl_links: false,
        unfurl_media: false,
      });
    }
    if (text === undefined) {
      // Unreachable given `createUnifiedMessage`'s at-least-one precondition;
      // kept so this function is honest on its own rather than trusting the
      // caller silently.
      throw new Error('SlackAdapter.createRecord: a Slack Message post needs Message text when there are no Blocks.');
    }
    return await client.api.chat.postMessage({
      channel: channelId,
      ...thread,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (err) {
    throw enrichPostMessageError(err);
  }
}

function enrichPostMessageError(err: unknown): Error {
  const data = (err as { data?: { error?: string; response_metadata?: { messages?: unknown } } } | undefined)
    ?.data;
  const messages = data?.response_metadata?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return err instanceof Error ? err : new Error(String(err));
  }
  return new Error(
    `SlackAdapter.createRecord: Slack rejected the post${data?.error ? ` (${data.error})` : ''} — ${messages.join('; ')}`,
  );
}

/**
 * The upload flow (files.getUploadURLExternal → POST bytes →
 * files.completeUploadExternal). A Slack file share IS its own message —
 * the Message text rides as `initial_comment` so text+file is ONE visible
 * message (design resolution 6). Slack returns no share-message ts
 * synchronously, so the file id is the write's externalId; `channelId`
 * (+ `threadTs`) still ride the handle data for downstream anchoring.
 */
async function uploadFileMessage(input: {
  client: SlackClient;
  teamId: TeamId;
  channelId: string;
  threadTs: string | undefined;
  fileValue: FileValue;
  comment: string | undefined;
}): Promise<WriteResult> {
  const { client, teamId, channelId, threadTs, fileValue, comment } = input;
  const bytes = await fetchFileBytes(fileValue, teamId);
  if (!bytes) {
    throw new Error('SlackAdapter.createRecord: could not retrieve file bytes for the File value.');
  }
  const fileName = fileValue.name ?? 'file';
  const uploadUrl = await client.api.files.getUploadURLExternal({
    filename: fileName,
    length: bytes.length,
  });
  if (!uploadUrl.upload_url || !uploadUrl.file_id) {
    throw new Error(
      `SlackAdapter.createRecord: failed to get an upload URL (${uploadUrl.error ?? 'unknown'}).`,
    );
  }
  const uploadResponse = await client.fetch(uploadUrl.upload_url, {
    method: 'POST',
    body: bytes.body,
    headers: { 'Content-Type': bytes.contentType },
  } as RequestInit);
  if (!uploadResponse.ok) {
    throw new Error(
      `SlackAdapter.createRecord: upload POST failed (status ${uploadResponse.status}).`,
    );
  }
  await client.api.files.completeUploadExternal({
    channel_id: channelId,
    ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
    ...(comment !== undefined ? { initial_comment: comment } : {}),
    files: [{ id: uploadUrl.file_id, title: fileName }],
  });
  logger.info(`[SlackAdapter.write] uploaded "${fileName}" to ${channelId}`);
  return {
    adapterType: SLACK_ADAPTER_TYPE,
    externalId: uploadUrl.file_id,
    data: {
      channelId,
      fileId: uploadUrl.file_id,
      ...(threadTs !== undefined ? { threadTs } : {}),
      name: comment ?? fileName,
    },
  };
}

/**
 * Slack archive permalink (archive-relative — a full permalink would need a
 * chat.getPermalink round-trip).
 */
function channelPermalink(channelId: string, ts: string): string {
  return `slack://archives/${channelId}/p${ts.replace('.', '')}`;
}

// ── Blocks (verbatim Block Kit passthrough) ─────────────────────────────────

/**
 * The only validation Blocks gets: it must be a LIST of block objects — no
 * per-key Block Kit typing (that is the deliberate cost of verbatim
 * passthrough; a malformed key surfaces as Slack's own `invalid_blocks` error,
 * see `enrichPostMessageError`). `undefined`/`null` and an empty list both mean
 * "no Blocks" (mirrors `file`'s falsy-is-absent treatment) so `Blocks: []`
 * behaves like the field was never set rather than posting an empty `blocks`
 * array.
 */
function asBlocksValue(raw: unknown): unknown[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(
      `SlackAdapter.createRecord: Blocks must be a LIST of Block Kit block objects, got ${describeBlocksValue(raw)}.`,
    );
  }
  for (const block of raw) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new Error(
        `SlackAdapter.createRecord: Blocks must be a LIST of Block Kit block objects — found ${describeBlocksValue(block)} in the list.`,
      );
    }
  }
  return raw.length > 0 ? raw : undefined;
}

function describeBlocksValue(raw: unknown): string {
  if (typeof raw === 'string') return `the string "${raw}"`;
  if (raw === null) return 'null';
  if (Array.isArray(raw)) return 'an array';
  return `a ${typeof raw}`;
}

// ── File value handling (unchanged from the sentinel implementation) ──────

interface FileValue extends FileRef {
  content?: string;
}

function asFileValue(raw: unknown): FileValue | null {
  if (!raw || typeof raw !== 'object') return null;
  return raw as FileValue;
}

interface FileBytes {
  body: Buffer;
  length: number;
  contentType: string;
}

async function fetchFileBytes(fileValue: FileValue, teamId: TeamId): Promise<FileBytes | null> {
  if (hasFileSource(fileValue)) {
    try {
      const resolved = await streamFileRef(fileValue, { teamId });
      const body = await streamToBuffer(resolved.stream);
      return {
        body,
        length: body.length,
        contentType:
          resolved.contentType ?? fileValue.contentType ?? 'application/octet-stream',
      };
    } catch (err) {
      logger.warn('[SlackAdapter.write] file retrieval failed', {
        name: fileValue.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (typeof fileValue.content === 'string') {
    const body = Buffer.from(fileValue.content);
    return {
      body,
      length: body.length,
      contentType: fileValue.contentType ?? 'text/plain',
    };
  }
  return null;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
