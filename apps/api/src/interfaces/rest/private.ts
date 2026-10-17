import { RequestHandler, Request, Response } from 'express';
import { currentPrincipal } from 'principal';

import type { TriggerEvent } from 'movement-engine/public/inbound';

import { currentContext } from '../../services/context';
import { catchingRoutes } from './async_route';
import { logger } from 'movement-engine/public/log';
import { sendSlackNotification } from '../../lib/slack';
import { getQb } from '../../lib/kysely';
import { TeamId } from '../../generated/kysely/core/Team';
import { loadTriggerById } from '../../services/translation_graph/storage/tg_table';
import { receiveTriggerEvent } from '../../services/translation_graph/triggers/event_store';
import {
  createEmailAdapter,
  normaliseInboundEmailPayload,
  EMAIL_ADAPTER_TYPE,
  EMAIL_RECORD_TYPE_ID,
} from '../../services/translation_graph/adapters/email';
import { fetchResendEmailPayload } from '../../services/translation_graph/adapters/email/resend_inbound';
import { readMailgunMessage, readResendEnvelope, resendEnvelopeRecipients } from 'movement-engine/public/inbound';
import { resolveActingUser } from '../../services/translation_graph/adapters/acting_user/resolve';

/**
 * The team this message belongs to — the one the DOOR already decided from the
 * sender (D31/D32) and handed to the funnel as the requested team, read back off
 * the Principal rather than through `Context.user`. `user` is user-SHAPED and
 * throws when there is no user, and a coreless deployment authenticates as a
 * machine principal with none (D2) — so the whole inbound-email door, which only
 * ever wanted a tenant, answered nothing at all rather than accepting the mail.
 */
function actingTeamId(): TeamId {
  return currentPrincipal().teamId as TeamId;
}

/**
 * What an inbound email is, once its provider's wire shape has been read off.
 *
 * Everything below this line is the same for every provider: who is allowed to
 * send, which trigger answers, and what happens when none does. The parsing
 * above it is not — Mailgun posts the whole message as a form, Resend posts an
 * id and has to be asked — and that difference is the ONLY thing the two
 * handlers keep to themselves.
 */
interface InboundEmail {
  /** The adapter's advertised `EmailPayload` fields, over whatever else the
   *  provider sent. */
  payload: Record<string, unknown>;
  /** Who the message was addressed to — for the quarantine record. */
  recipients: string[];
}

const acceptInboundEmail = async (
  req: Request,
  res: Response,
  email: InboundEmail,
): Promise<Response> => {
  const ctx = currentContext();
  const teamId = actingTeamId();

  // T5 — sender-auth gate. Run BEFORE plus-key routing because plus-key
  // is a routing signal, not an auth signal (anyone can email a
  // `<local>+<key>@` address). The email adapter parses sender /
  // forwarding-recipient candidates (`getActorCandidates`); Listen-Fire's
  // `resolveActingUser` maps them through the sender → service-account
  // chain. Null means "no Listen-Fire team member is authenticated for this
  // dispatch" and the request is rejected. No trigger context here (this
  // gate runs pre-routing), so neither creator-override nor creator-
  // fallback applies — same behaviour as the prior inline chain.
  //
  // Auth-passed-but-no-matching-trigger is quarantined below rather than
  // processed: the legacy pipeline this used to fall through to is gone.
  //
  // The contract seam: every email TriggerEvent built from here on
  // carries the adapter's advertised EmailPayload fields (bodyText,
  // bodyHtml, messageId, typed attachments) merged over the raw body.
  const emailPayload = email.payload;
  const emailAdapter = createEmailAdapter({ teamId });
  const authEvent: TriggerEvent = {
    pipelineInputId: 'auth-gate',
    adapterType: EMAIL_ADAPTER_TYPE,
    triggerType: 'webhook',
    payload: emailPayload,
    occurredAt: new Date().toISOString(),
  };
  const actingUser = await resolveActingUser({
    teamId,
    getCandidates: () => emailAdapter.getActorCandidates({ event: authEvent }),
  });
  if (!actingUser) {
    logger.warn('[InboundEmail] rejected unauthenticated email', {
      teamId,
    });
    return res.status(401).send();
  }

  // The door already decided all of this during authentication — which team
  // this email belongs to and which of that team's triggers, if any, its
  // `<local>+<key>@` address names. Asking again here would be a second,
  // possibly different, answer to the same question.
  const route = req.inboundEmailRoute;
  const intendedRecipients = email.recipients;

  if (route?.trigger) {
    // Liveness gate: a trigger dispatches iff it is movement-derived
    // (`movement_id` set) — the trigger row is purely the dispatch index
    // and execution reads the canonical movement text (see
    // `dispatchTriggerByIdEvent`; storage/authored.ts).
    const triggerRow = await loadTriggerById(route.trigger.id);
    if (triggerRow?.movementId != null) {
      // The email adapter's fires edge lands STRAIGHT on `Email` (rule 1's
      // collapse — a field-less `Email Received` node was pure indirection),
      // so the seed IS the email: `rootRecordType` names the delivered node
      // and the Message-Id, when present, is its durable identity — what
      // lets the engine seed it STABLE so `e.`Subject`` reads directly.
      // An id-less email still fires; its seed is honestly unstable.
      const messageId =
        typeof emailPayload['messageId'] === 'string' && emailPayload['messageId'].length > 0
          ? emailPayload['messageId']
          : undefined;
      const event: TriggerEvent = {
        pipelineInputId: `trigger:${route.trigger.id}`,
        adapterType: route.trigger.kind.toLowerCase(),
        triggerType: 'webhook',
        payload: emailPayload,
        changeType: 'create',
        rootRecordType: EMAIL_RECORD_TYPE_ID,
        // The Message-Id is also the DELIVERY id: both providers redeliver on
        // anything that isn't a 2xx, and a retry that minted a second trigger
        // event would run the movement twice on one email. The receipt's
        // unique index on (trigger, delivery id) makes the redelivery a no-op.
        ...(messageId !== undefined ? { idempotencyKey: messageId } : {}),
        ...(messageId !== undefined
          ? {
              externalRecordRef: {
                adapterType: EMAIL_ADAPTER_TYPE,
                externalId: messageId,
                recordType: EMAIL_RECORD_TYPE_ID,
              },
            }
          : {}),
        occurredAt: new Date().toISOString(),
      };
      // Store-then-ack: the event is durable before we answer, the
      // sender never waits on a movement run (slow runs used to hold
      // this response open past webhook timeouts → provider retries →
      // duplicate processing), and the stored row is replayable.
      try {
        await receiveTriggerEvent({
          triggerId: route.trigger.id,
          event,
          teamId,
        });
      } catch (err) {
        logger.error('[InboundEmail] failed to store trigger event', {
          triggerId: route.trigger.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return res.status(500).send();
      }
      return res.status(201).send();
    }
  }

  // Authenticated, but nothing of this team's answers to the address. The
  // pipeline this used to fall through to is retired, so quarantine rather
  // than drop: persist the raw payload BEFORE acking, so a team that should
  // have been onboarded isn't silently losing mail and the row can be replayed
  // once a movement listens for it (scripts/replay_dropped_emails.ts).
  await getQb(['dropped_inbound_email'])
    .insertInto('dropped_inbound_email')
    .values({
      team_id: teamId,
      request_id: ctx.id,
      reason: 'no_matching_trigger',
      recipients: intendedRecipients,
      body: emailPayload as unknown,
    })
    .execute();

  logger.warn('[InboundEmail] no movement listens for this address — stored for replay', {
    teamId,
    intendedRecipients,
  });
  await sendSlackNotification({
    type: 'SUPPORT',
    text: `Dropped an inbound email for team ${teamId} (recipients: ${intendedRecipients.join(', ')}) — no automation listens for that address. Stored for replay.`,
    opsTitle: `Dropped an inbound email with no matching automation (recipients: ${intendedRecipients.join(', ')})`,
  });
  return res.status(200).send();
};

/**
 * Mailgun posts the whole message as a form, so reading it is a normalisation
 * and nothing more.
 */
const receiveInboundEmail: RequestHandler = async (req, res) =>
  acceptInboundEmail(req, res, {
    payload: normaliseInboundEmailPayload((req.body ?? {}) as Record<string, unknown>),
    recipients: readMailgunMessage(req.body)?.recipients ?? [],
  });

/**
 * Resend posts an id. The body, the headers and the attachment list all have
 * to be fetched before there is an email at all — which is why a Resend API
 * outage surfaces here as a 500 (a retryable answer for a retryable failure)
 * rather than as an email with no content.
 */
const receiveResendInboundEmail: RequestHandler = async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : '';
  const envelope = readResendEnvelope(raw);
  // The door already answered anything that is not mail arriving; reaching
  // here without an envelope means the body changed under us.
  if (envelope === null) return res.status(406).send();

  return acceptInboundEmail(req, res, {
    payload: await fetchResendEmailPayload(envelope.email_id),
    recipients: resendEnvelopeRecipients(envelope),
  });
};

/**
 * A rejection escaping these handlers used to leave the provider's socket
 * unanswered — express 4 drops an async handler's rejection on the floor, and
 * only the event-store write above sits in a try/catch, so a failing quarantine
 * insert or Slack notice hung the request instead of failing it. 500 is the same
 * answer the store failure already gives: not taken, retry (`async_route.ts`).
 */
const catchingInboundEmail = catchingRoutes((res, err) => {
  logger.error('[InboundEmail] unhandled failure', {
    error: err instanceof Error ? err.message : String(err),
  });
  return res.status(500).send();
});

const inboundEmailHandler: RequestHandler = catchingInboundEmail(receiveInboundEmail);
const resendInboundEmailHandler: RequestHandler = catchingInboundEmail(receiveResendInboundEmail);

export { inboundEmailHandler, resendInboundEmailHandler };
