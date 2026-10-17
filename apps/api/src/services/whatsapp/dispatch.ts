// WhatsApp dumb dispatcher — the agent-free inbound path. An inbound Meta
// message is routed, with NO agent in the middle, to an ingestion path the
// sender's team has wired:
//   1. a movement `trigger` of kind INBOUND_WHATSAPP (preferred), else
//   2. a legacy `pipeline_input` (default_for INBOUND_WHATSAPP), else
//   3. dropped (logged).
// Modelled on `inboundEmailHandler` (interfaces/rest/private.ts) — trigger-first,
// pipeline_input fallback.
//
// The RECEIVING number gates which of those paths is even eligible
// (`resolveWhatsappRoute`): once a movements number is configured, the
// movements number reaches movements only (never the legacy pipeline) and the
// primary number reaches the legacy pipeline only (never movements). Before a
// movements number exists the single number keeps the trigger-first→legacy
// fallback for both.

import { Readable } from 'node:stream';

import type { TriggerEvent } from 'movement-engine/public/inbound';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { WhatsappAttachment, WhatsappPayload } from '../translation_graph/adapters/whatsapp/types';
import type { MetaWhatsappMessage } from '../webhook_sync/providers/whatsapp';

import { prismaClient } from '../../prisma';
import { Context } from '../context';
import { logger } from 'movement-engine/public/log';
import { DocumentService } from '../document';
import { exposeFile } from '../translation_graph/engine/files/expose';
import { findTriggersByKind } from '../translation_graph/storage/tg_table';
import {
  classifyMetaMessage,
  triggerAcceptsWhatsappKind,
} from '../webhook_sync/providers/whatsapp';
import { resolveAdapterSlug } from '../translation_graph/adapters/registry';
import { receiveTriggerEvent } from '../translation_graph/triggers/event_store';
import { getMetaWhatsappApi, movementsPhoneNumberId } from './metaApi';
import { resolveWhatsappRoute } from './route';
import { isVerifiedLink } from './phone_verification/logic';
import { isTeamMember } from './membership';
import { userPrincipal } from '../principal';

const WHATSAPP_KIND = 'INBOUND_WHATSAPP';

/** Resolve the sending phone number to an owning team + user. The phone_number
 *  table maps a phone → user; the user's preferred team is the candidate. Two
 *  gates, both required: the link must be VERIFIED (an unverified row, added
 *  without proving ownership, can't capture someone else's WhatsApp traffic),
 *  and the user must be a MEMBER of the team the message would run in.
 *
 *  This is a public webhook door — it never passes through `resolveActingTeam`,
 *  so it applies the same membership rule itself. `default_team_id` names where
 *  a person lands, never where they may act (C-6/D28). */
async function resolveSenderTeam(
  phone: string,
): Promise<{ userId: string; teamId: string } | null> {
  const candidates = [phone, `+${phone.replace(/^\+/, '')}`];
  for (const value of candidates) {
    const row = await prismaClient.phoneNumber.findUnique({ where: { phoneNumber: value } });
    if (row?.userId && isVerifiedLink({ userId: row.userId, verifiedAt: row.verifiedAt })) {
      const user = await prismaClient.user.findUnique({ where: { id: row.userId } });
      if (user) {
        if (await isTeamMember(user.id, user.defaultTeamId)) {
          return { userId: user.id, teamId: user.defaultTeamId };
        }
        logger.info('[whatsapp-dispatch] sender is not a member of their default team', {
          userId: user.id,
          teamId: user.defaultTeamId,
        });
      }
    }
  }
  return null;
}

/** An attachment carrying BOTH a fetchable blob URL (the movement path: the
 *  WhatsappAdapter resolves bytes via `fetchUrlToStream(key)`) AND a durable
 *  document id (the legacy pipeline_input path: `segments` reads
 *  `attachment.documentId`). One shape serves both consumers. */
type ResolvedAttachment = WhatsappAttachment & { documentId?: string };

/**
 * Resolve a Meta message's media. Meta delivers media by id; we download the
 * bytes once, then both (a) persist a durable copy via DocumentService and
 * (b) expose a short-lived fetchable URL via `exposeFile` (→ /api/files/blob/:id).
 * The attachment carries the blob URL as `key`/`url` (so the adapter's
 * `fetchUrlToStream(key)` resolves on the movement path) and the `documentId`
 * (so the legacy pipeline_input consumer reads it).
 */
async function resolveAttachments(
  message: MetaWhatsappMessage,
  teamId: string,
  businessPhoneNumberId?: string,
): Promise<ResolvedAttachment[]> {
  const media = message.image ?? message.document ?? message.audio ?? message.video;
  if (!media) return [];
  try {
    // Download with the receiving number's token — Meta media is scoped to the
    // app that received it, so a separate-app movements number needs its own.
    const downloaded = await getMetaWhatsappApi(businessPhoneNumberId).downloadMedia(media.id);
    const filename = media.filename ?? downloaded.filename ?? message.id;
    const document = await DocumentService.createAndUpload(Readable.from(downloaded.buffer), {
      mimeType: downloaded.mimeType,
      contentLength: downloaded.buffer.length,
      description: filename,
    });
    const exposed = await exposeFile({
      stream: Readable.from(downloaded.buffer),
      filename,
      contentType: downloaded.mimeType,
      // This door resolved the sender's team before it downloaded anything, so
      // it can say whose file this is outright rather than leave it to the
      // ambient identity it happens to be running under.
      teamId,
    });
    return [
      {
        key: exposed.url,
        url: exposed.url,
        filename,
        contentType: downloaded.mimeType,
        documentId: document.id,
      },
    ];
  } catch (err) {
    logger.error('[whatsapp-dispatch] media resolve failed', { mediaId: media.id, error: String(err) });
    return [];
  }
}

/** Dispatch one inbound Meta message dumbly. Public webhook → no auth ctx, so we
 *  resolve the team from the sender and run under a Context built for it. */
export async function dispatchWhatsappMessage(input: {
  message: MetaWhatsappMessage;
  businessNumber?: string;
  /** The Meta `phone_number_id` this message was received on — which of our
   *  numbers (primary vs movements). Rides the event so a reply is sent from
   *  the same number. Absent → the primary number. */
  businessPhoneNumberId?: string;
  profileName?: string;
}): Promise<void> {
  const { message, businessNumber, businessPhoneNumberId, profileName } = input;
  const resolved = await resolveSenderTeam(message.from);
  if (!resolved) {
    logger.info('[whatsapp-dispatch] no team for sender — dropping', { from: message.from });
    return;
  }

  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId: resolved.userId, teamId: resolved.teamId }));

  await ctx.runAsync(async () => {
    // Classify FIRST: reactions/locations are their own event kinds, and an
    // unsupported kind (contacts, interactive replies, system notices) is
    // dropped here — it must never fire movements as an empty message.
    const classified = classifyMetaMessage(message, { businessNumber, businessPhoneNumberId, profileName });
    if (classified === undefined) {
      logger.info('[whatsapp-dispatch] unsupported inbound kind — dropping', {
        type: message.type,
        from: message.from,
      });
      return;
    }
    const attachments =
      classified.kind === 'message'
        ? await resolveAttachments(message, resolved.teamId, businessPhoneNumberId)
        : [];
    const payload = {
      ...classified.payload,
      ...(classified.kind === 'message' ? { attachments } : {}),
    } as WhatsappPayload;

    // Which paths the receiving number is allowed to take. The movements number
    // reaches movements only; the primary number reaches legacy only; an
    // unconfigured-movements deployment keeps the trigger-first→legacy fallback.
    const route = resolveWhatsappRoute({
      businessPhoneNumberId,
      movementsPhoneNumberId: movementsPhoneNumberId(),
    });

    // 1. Movement trigger (preferred) — skipped entirely when the number is
    //    gated to legacy only, so the old number can never fire a movement.
    if (route !== 'legacy-only') {
      const triggers = (await findTriggersByKind({ teamId: resolved.teamId, kinds: [WHATSAPP_KIND] }))
        .filter((t) => t.movementId != null);
      if (triggers.length > 0) {
        let dispatched = 0;
        for (const trigger of triggers) {
          // The listen's `events` config gates the kind — no `events` means
          // messages only, so reactions never fire a movement that didn't opt in.
          if (!triggerAcceptsWhatsappKind(trigger.config, classified.kind)) continue;
          const adapterType = resolveAdapterSlug(trigger.kind);
          const event: TriggerEvent = {
            pipelineInputId: `trigger:${trigger.id}`,
            // Resolve the trigger kind to the registered adapter slug
            // (INBOUND_WHATSAPP → whatsapp); a lowercased kind doesn't resolve.
            adapterType,
            triggerType: 'webhook',
            payload,
            // The wamid is the message's durable native id — carrying it seeds
            // a STABLE event position, so the message can parent linked writes
            // (`write msg-[:replies]->` / `write msg-[:reactions]->`).
            rootRecordType: classified.rootRecordType,
            externalRecordRef: {
              adapterType,
              recordType: classified.rootRecordType,
              externalId: message.id,
            },
            occurredAt: new Date().toISOString(),
          };
          await receiveTriggerEvent({ teamId: resolved.teamId as TeamId, triggerId: trigger.id, event });
          dispatched += 1;
        }
        // Read receipt at preprocess: a message a movement will handle shows
        // blue ticks immediately (ruling 2026-07-07). Fire-and-forget — a
        // receipt failure must never affect dispatch. Messages only; Meta has
        // no receipt for reactions/locations.
        if (classified.kind === 'message' && dispatched > 0) {
          void getMetaWhatsappApi(businessPhoneNumberId).markMessageRead(message.id).catch(() => {});
        }
        return;
      }
    }

    // 2. No movement trigger wired — drop. Nothing else consumes inbound
    //    WhatsApp now that the legacy pipeline fallback is gone.
    logger.info('[whatsapp-dispatch] no trigger for team — dropping', {
      teamId: resolved.teamId,
      from: message.from,
    });
  });
}
