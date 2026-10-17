// The inbound mail doors' core: how a Mailgun form post or a Resend (Svix)
// notification is believed, and the answer each refusal earns.
//
// The host owns the two things that are not about the wire: where the signing
// key comes from (an environment rule), and whose team a believed message is
// for (a database and a directory). Everything between is here, so any host
// that serves these doors answers the same status for the same delivery.
//
// Every refusal is final — a bad signature never becomes good — so none of
// them answers with a code the provider would retry.

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { InboundHeaders } from './verify';

import { logger } from '../logger';
import { verifySvixSignature } from './svix';

export * from './svix';

/** What the door decided, carried to the handler. */
export interface InboundEmailRoute {
  teamId: string;
  /** The `<local>+<key>@` routing key on the message, when it carries one. */
  key: string | null;
  /** The team's trigger for that key — null when nothing matched. */
  trigger: { id: string; kind: string } | null;
}

export type InboundEmailDecision =
  | { outcome: 'routed'; userId: string; teamId: string; route: InboundEmailRoute }
  /** Nothing to do — answer with `status` and stop. Never a 5xx. 200 is the
   *  "understood, and there is nothing to do" arm: a provider that delivers its
   *  whole event stream to one endpoint sends things that are not mail. */
  | { outcome: 'refused'; status: 401 | 406 | 201 | 200 };

/** What routing needs to know, whatever provider carried the message. */
export interface RoutableMessage {
  recipients: string[];
  /** Addresses the message passed through before us, most-specific first. */
  senderCandidates: string[];
}

/** What every mail door needs from the host: whose team a believed message
 *  is for, and which trigger answers. */
export interface InboundMailRouter {
  route(message: RoutableMessage): Promise<InboundEmailDecision>;
}

export interface MailgunStore extends InboundMailRouter {
  /** The key Mailgun signs with; undefined when this host has none. */
  mailgunSigningKey(): string | undefined;
}

export interface ResendStore extends InboundMailRouter {
  /** The secret Resend's Svix signs with; undefined when this host has none. */
  resendWebhookSecret(): string | undefined;
}

/** The bare address out of an RFC 5322 field: `"Ada" <ada@example.com>` →
 *  `ada@example.com`, lower case; null when there is no `@`. */
export function parseEmailAddress(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const match = raw.match(/<([^>]+)>/);
  const candidate = (match ? match[1] : raw).trim().toLowerCase();
  if (!candidate.includes('@')) return null;
  return candidate;
}

// ── Mailgun ────────────────────────────────────────────────────────────────

export interface MailgunSignature {
  signature: string;
  token: string;
  timestamp: string;
}

export interface MailgunMessage extends RoutableMessage, MailgunSignature {
  sender: string;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstAddress(header: string | undefined): string | undefined {
  return header?.split(/[;, ]+/)[0];
}

function parseRecipientList(header: string | undefined): string[] {
  return header?.split(', ').map((entry) => entry.replace(/^.*<(.*)>$/, '$1')) ?? [];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function receivedHeaderRecipients(raw: Record<string, unknown>): string[] {
  const value = raw['message-headers'];
  const headers: unknown = typeof value === 'string' ? safeJson(value) : value;
  if (!Array.isArray(headers)) return [];

  const found: string[] = [];
  for (const entry of headers) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [key, line] = entry;
    if (key !== 'Received' || typeof line !== 'string') continue;
    // `for <email@domain>`, whose angle brackets may arrive HTML-encoded —
    // the last resort when a BCC was stripped on the way in.
    const match = line.match(/\bfor\s+(?:<|&lt;)([\w.+-]+@[\w.-]+)(?:>|&gt;)/);
    if (match) found.push(match[1]);
  }
  return found;
}

/** The message a Mailgun form post carries; null when it has no sender. */
export function readMailgunMessage(body: unknown): MailgunMessage | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw: Record<string, unknown> = { ...(body as Record<string, unknown>) };

  const sender = nonEmpty(raw['sender']);
  if (sender === undefined) return null;

  return {
    signature: nonEmpty(raw['signature']) ?? '',
    token: nonEmpty(raw['token']) ?? '',
    timestamp: nonEmpty(raw['timestamp']) ?? '',
    sender,
    recipients: Array.from(
      new Set([
        ...parseRecipientList(nonEmpty(raw['To'])),
        ...parseRecipientList(nonEmpty(raw['Cc'])),
        ...parseRecipientList(nonEmpty(raw['Bcc'])),
        ...receivedHeaderRecipients(raw),
      ]),
    ),
    // Auto-forwarding addresses act as service accounts: an email that reached
    // us THROUGH one of them is the proxy's to answer for, so the proxy is
    // tried before the human who happens to be in the `sender` header.
    senderCandidates: [
      firstAddress(nonEmpty(raw['X-Forwarded-For'])),
      firstAddress(nonEmpty(raw['X-BeenThere'])),
      firstAddress(nonEmpty(raw['X-Gm-Original-To'])),
      firstAddress(nonEmpty(raw['X-Google-Original-To'])),
      firstAddress(nonEmpty(raw['X-Original-To'])),
      firstAddress(nonEmpty(raw['Delivered-To'])),
      sender,
    ].filter((candidate): candidate is string => candidate !== undefined),
  };
}

/** HMAC-SHA256(apiKey, timestamp + token) as hex, the signature Mailgun sends.
 *  A signature of the wrong length is a wrong signature, never an error:
 *  `timingSafeEqual` throws on unequal lengths, and a throw is a 500 that
 *  invites a redelivery of a payload that will never verify. */
export function mailgunSignatureVerifies(message: MailgunSignature, apiKey: string): boolean {
  const expected = createHmac('sha256', apiKey).update(message.timestamp + message.token).digest('hex');
  const given = Buffer.from(message.signature);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, Buffer.from(expected));
}

/** Mailgun inbound mail: its own wire shape and its own signature, then the
 *  host's routing. */
export async function admitMailgunMail(store: MailgunStore, body: unknown): Promise<InboundEmailDecision> {
  const message = readMailgunMessage(body);
  if (message === null) {
    logger.warn('[InboundEmail] refused a payload that is not an inbound email');
    return { outcome: 'refused', status: 406 };
  }

  const apiKey = store.mailgunSigningKey();
  if (apiKey === undefined) {
    logger.error('[InboundEmail] no Mailgun signing key configured — refusing inbound email');
    return { outcome: 'refused', status: 401 };
  }
  if (!mailgunSignatureVerifies(message, apiKey)) {
    // 406 rather than 401: Mailgun retries hard on anything it reads as
    // transient, and a bad signature will never become good.
    return { outcome: 'refused', status: 406 };
  }

  return store.route(message);
}

export type MailgunEventVerdict = 'verified' | 'refused' | 'misconfigured';

/** Delivery telemetry (bounces, opens) for mail we sent. The signature block
 *  travels inside the JSON body; a body without a usable one is judged like a
 *  wrong signature. `apiKey` null: this host has no key to judge with. */
export function judgeMailgunEvent(input: { signature: unknown; apiKey: string | null }): MailgunEventVerdict {
  if (input.apiKey === null) return 'misconfigured';
  const block = input.signature;
  if (block === null || typeof block !== 'object') return 'refused';
  const { token, timestamp, signature } = block as Record<string, unknown>;
  if (typeof token !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') return 'refused';
  return mailgunSignatureVerifies({ token, timestamp, signature }, input.apiKey) ? 'verified' : 'refused';
}

// ── Resend ─────────────────────────────────────────────────────────────────

/** The one event type that carries mail INTO the system. */
export const RESEND_RECEIVED_EVENT_TYPE = 'email.received';

export interface ResendReceivedEnvelope {
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

/** Read the `email.received` envelope out of a webhook body. */
export function readResendEnvelope(body: string): ResendReceivedEnvelope | null {
  const delivery = asRecord(safeJson(body));
  if (delivery === null || delivery.type !== RESEND_RECEIVED_EVENT_TYPE) return null;
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

/** Every address the message was addressed to, in routing order. */
export function resendEnvelopeRecipients(envelope: ResendReceivedEnvelope): string[] {
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

function headerText(headers: InboundHeaders, name: string): string {
  const value = headers[name];
  return String((typeof value === 'string' ? value : value?.[0]) ?? '');
}

/**
 * Believe a Resend delivery, then route it. `rawBody` is the exact bytes that
 * arrived, or null when the route was mounted without the raw parser and the
 * signature can therefore never be checked.
 */
export async function admitResendMail(
  store: ResendStore,
  delivery: { rawBody: Buffer | null; headers: InboundHeaders },
): Promise<InboundEmailDecision> {
  if (delivery.rawBody === null) {
    logger.error('[ResendInbound] the callback was reached without its raw body — cannot verify');
    return { outcome: 'refused', status: 406 };
  }
  const body = delivery.rawBody.toString('utf-8');

  const secret = store.resendWebhookSecret();
  if (secret === undefined || secret.length === 0) {
    logger.error('[ResendInbound] the webhook secret is not set — refusing inbound email');
    return { outcome: 'refused', status: 401 };
  }

  const verdict = verifySvixSignature({
    secret,
    headers: {
      id: headerText(delivery.headers, 'svix-id'),
      timestamp: headerText(delivery.headers, 'svix-timestamp'),
      signature: headerText(delivery.headers, 'svix-signature'),
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
  if (asRecord(safeJson(body))?.type !== RESEND_RECEIVED_EVENT_TYPE) {
    return { outcome: 'refused', status: 200 };
  }

  const envelope = readResendEnvelope(body);
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
  return store.route({ recipients: resendEnvelopeRecipients(envelope), senderCandidates: [sender] });
}
