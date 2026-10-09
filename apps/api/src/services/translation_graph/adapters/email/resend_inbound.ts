// The Resend inbound door, and what it takes to turn a Resend delivery into
// the same email every other part of the system already understands.
//
// Resend's webhook is a notification, not a message: `email.received` carries
// ids and an envelope and nothing an author can read. So this file does two
// things the Mailgun path never had to — believe a Svix signature over the
// exact bytes that arrived, and then go and FETCH the message.
//
// What it deliberately does not do is decide anything about routing. Whose
// team the mail is for and which trigger answers for it are the same three
// questions Mailgun's door asks, and they are asked in the same place
// (`routeInboundEmail`), because a message routing differently depending on
// who carried it would be a bug nobody would find.

import { parseEmailAddress } from './index';

import type { Request } from 'express';
import type { EmailAttachment, EmailPayload } from './index';

import { logger } from '../../../logger';
import { routeInboundEmail, type InboundEmailDecision } from './inbound_door';
import {
  fetchReceivedEmail,
  listReceivedAttachments,
  resendAttachmentHandle,
  type ResendReceivedEmail,
} from './resend';
import { verifySvixSignature } from './svix';

/** The one event type that carries mail INTO the system. */
const RECEIVED_EVENT_TYPE = 'email.received';

const WEBHOOK_SECRET_VAR = 'RESEND_WEBHOOK_SECRET';

interface ResendReceivedEnvelope {
  email_id: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  received_for?: string[];
  message_id?: string;
  subject?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The raw bytes of the delivery, or null when the route was mounted without
 *  the raw parser and the signature can therefore never be checked. */
function rawBody(req: Request): string | null {
  return Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : null;
}

/** Read the `email.received` envelope out of a webhook body. */
function readReceivedEnvelope(body: string): ResendReceivedEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const delivery = asRecord(parsed);
  if (delivery === null || delivery.type !== RECEIVED_EVENT_TYPE) return null;
  const data = asRecord(delivery.data);
  if (data === null || typeof data.email_id !== 'string') return null;
  return {
    email_id: data.email_id,
    ...(typeof data.from === 'string' ? { from: data.from } : {}),
    to: stringList(data.to),
    cc: stringList(data.cc),
    bcc: stringList(data.bcc),
    received_for: stringList(data.received_for),
    ...(typeof data.message_id === 'string' ? { message_id: data.message_id } : {}),
    ...(typeof data.subject === 'string' ? { subject: data.subject } : {}),
  };
}

/** Whether the delivery is an event type we take mail from at all. */
function isReceivedDelivery(body: string): boolean {
  try {
    return asRecord(JSON.parse(body))?.type === RECEIVED_EVENT_TYPE;
  } catch {
    return false;
  }
}

/** Every address the message was addressed to, in routing order. */
function envelopeRecipients(envelope: ResendReceivedEnvelope): string[] {
  return Array.from(
    new Set(
      [
        ...(envelope.received_for ?? []),
        ...(envelope.to ?? []),
        ...(envelope.cc ?? []),
        ...(envelope.bcc ?? []),
      ]
        .map((address) => parseEmailAddress(address))
        .filter((address): address is string => address !== null),
    ),
  );
}

/**
 * Believe the delivery, then route it.
 *
 * Every refusal is final — a bad signature never becomes good, and a delivery
 * we have no secret to check is not one we can ever accept — so none of them
 * answers with a code Resend would retry.
 */
async function verifyResendInboundRequest(req: Request): Promise<InboundEmailDecision> {
  const body = rawBody(req);
  if (body === null) {
    logger.error('[ResendInbound] the callback was reached without its raw body — cannot verify');
    return { outcome: 'refused', status: 406 };
  }

  const secret = process.env[WEBHOOK_SECRET_VAR];
  if (secret === undefined || secret.length === 0) {
    logger.error(`[ResendInbound] ${WEBHOOK_SECRET_VAR} is not set — refusing inbound email`);
    return { outcome: 'refused', status: 401 };
  }

  const verdict = verifySvixSignature({
    secret,
    headers: {
      id: String(req.headers['svix-id'] ?? ''),
      timestamp: String(req.headers['svix-timestamp'] ?? ''),
      signature: String(req.headers['svix-signature'] ?? ''),
    },
    body,
  });
  if (verdict !== 'verified') {
    logger.warn('[ResendInbound] refused a delivery that did not verify', { verdict });
    return { outcome: 'refused', status: 406 };
  }

  // Resend delivers its whole event stream to one endpoint. Anything that is
  // not mail arriving is acknowledged and ignored — refusing it would have
  // Resend retry a delivery we will never want.
  if (!isReceivedDelivery(body)) {
    return { outcome: 'refused', status: 200 };
  }

  const envelope = readReceivedEnvelope(body);
  if (envelope === null) {
    logger.warn('[ResendInbound] refused an email.received delivery with no email id');
    return { outcome: 'refused', status: 406 };
  }

  const sender = parseEmailAddress(envelope.from);
  if (sender === null) {
    logger.warn('[ResendInbound] refused a delivery with no sender');
    return { outcome: 'refused', status: 406 };
  }

  // Resend's webhook carries no forwarding headers, so the sender is the only
  // candidate. The full header set arrives with the fetched message and is
  // what the acting-user chain reads later.
  return routeInboundEmail({
    recipients: envelopeRecipients(envelope),
    senderCandidates: [sender],
  });
}

// ── The message itself ─────────────────────────────────────────────────────

/**
 * Fetch the message behind a delivery and shape it the way every email in the
 * system is shaped.
 *
 * Headers are also spread as flat top-level keys because that is where the
 * acting-user chain looks for the forwarding headers (`X-Forwarded-For`,
 * `Delivered-To`, …) — Mailgun sends them flat, Resend sends them in an
 * object, and the chain should not have to know which.
 */
async function fetchResendEmailPayload(
  emailId: string,
): Promise<Record<string, unknown>> {
  const email = await fetchReceivedEmail(emailId);
  const attachments = await resendAttachments(emailId, email);

  const recipient = email.received_for?.[0] ?? email.to?.[0] ?? '';
  const payload: EmailPayload = {
    messageId: email.message_id ?? emailId,
    subject: email.subject ?? '',
    sender: email.from ?? '',
    recipient,
    ...(email.html ? { bodyHtml: email.html } : {}),
    ...(email.text ? { bodyText: email.text } : {}),
    attachments,
  };
  return { ...(email.headers ?? {}), ...payload };
}

/**
 * The attachment list, with a handle that will still resolve tomorrow.
 *
 * The message's own `attachments` are used only as a fallback for their
 * metadata: the listing endpoint is the one that knows sizes, and neither
 * carries bytes.
 */
async function resendAttachments(
  emailId: string,
  email: ResendReceivedEmail,
): Promise<EmailAttachment[]> {
  const listed = await listReceivedAttachments(emailId);
  const source = listed.length > 0 ? listed : (email.attachments ?? []);
  return source.flatMap((attachment): EmailAttachment[] => {
    if (typeof attachment.id !== 'string' || typeof attachment.filename !== 'string') return [];
    return [
      {
        key: resendAttachmentHandle(emailId, attachment.id),
        filename: attachment.filename,
        contentType: attachment.content_type ?? 'application/octet-stream',
        ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
      },
    ];
  });
}

export {
  RECEIVED_EVENT_TYPE,
  WEBHOOK_SECRET_VAR,
  envelopeRecipients,
  fetchResendEmailPayload,
  readReceivedEnvelope,
  verifyResendInboundRequest,
  type ResendReceivedEnvelope,
};
