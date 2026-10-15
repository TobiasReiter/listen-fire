import { type Request, type Response } from 'express';

import { logger } from 'movement-engine/services/logger';
import { sendSlackNotification } from '../../lib/slack';
import { authorizeUnsignedWebhook } from '../../lib/unsigned_webhooks';
import { dispatchWhatsappMessage } from '../../services/whatsapp/dispatch';
import { whatsappProvider } from '../../services/webhook_sync/providers/whatsapp';
import { resolveWhatsappSender } from '../../services/whatsapp/utils';
import {
  defaultWhatsappCallbackResponder,
  handleWhatsappInteractiveReplies,
  ownsWhatsappInteractiveReply,
} from '../../services/webhook_sync/whatsapp_callback_door';

interface WhatsAppWebhookEntry {
  changes?: Array<{
    field: string;
    value: {
      /** Which of OUR numbers received this — `phone_number_id` selects the
       *  number a reply is sent from (primary vs movements). */
      metadata?: {
        display_phone_number?: string;
        phone_number_id?: string;
      };
      contacts?: Array<{
        wa_id: string;
        profile?: {
          name?: string;
        };
      }>;
      messages?: WhatsAppMessage[];
      statuses?: WhatsAppStatus[];
    };
  }>;
}

/** Which Meta app/number a webhook door serves — its verify token (GET
 *  handshake) and app secret (X-Hub-Signature-256). Both doors share one
 *  implementation; only these differ. */
export interface WhatsappDoorConfig {
  verifyToken: string | undefined;
  appSecret: string | undefined;
}

interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: {
    body: string;
  };
  interactive?: {
    type: string;
    button_reply?: {
      id: string;
      title: string;
    };
    list_reply?: {
      id: string;
      title: string;
      description?: string;
    };
  };
  button?: {
    payload: string;
    text: string;
  };
  image?: {
    id: string;
    mime_type: string;
    sha256: string;
    caption?: string;
  };
  document?: {
    id: string;
    mime_type: string;
    sha256: string;
    filename: string;
    caption?: string;
  };
  audio?: {
    id: string;
    mime_type: string;
    sha256: string;
  };
  video?: {
    id: string;
    mime_type: string;
    sha256: string;
    caption?: string;
  };
  context?: {
    from: string;
    id: string;
  };
  contacts?: Array<{
    addresses?: Array<{
      city?: string;
      country?: string;
      country_code?: string;
      state?: string;
      street?: string;
      type?: string;
      zip?: string;
    }>;
    birthday?: string;
    emails?: Array<{
      email?: string;
      type?: string;
    }>;
    name: {
      formatted_name: string;
      first_name?: string;
      last_name?: string;
      middle_name?: string;
      suffix?: string;
      prefix?: string;
    };
    org?: {
      company?: string;
      department?: string;
      title?: string;
    };
    phones?: Array<{
      phone?: string;
      wa_id?: string;
      type?: string;
    }>;
    urls?: Array<{
      url?: string;
      type?: string;
    }>;
  }>;
}

interface WhatsAppStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
}

interface WhatsAppWebhookBody {
  isTesting?: boolean | null;
  object: string;
  entry?: WhatsAppWebhookEntry[];
}

/**
 * Verify webhook endpoint for WhatsApp Business API
 * This endpoint is called by WhatsApp to verify the webhook URL
 */
const verifyWebhook = (config: WhatsappDoorConfig) => (req: Request, res: Response): void => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Check if a token and mode were sent
  if (mode && token) {
    // Check the mode and token sent are correct
    if (mode === 'subscribe' && token === config.verifyToken) {
      // Respond with 200 OK and challenge token from the request
      res.status(200).send(challenge);
      return;
    } else {
      // Respond with '403 Forbidden' if verify tokens do not match
      res.sendStatus(403);
      return;
    }
  }

  // Respond with '400 Bad Request' if required parameters are missing
  res.sendStatus(400);
};

/** Safe, no-throw extraction for the signature-rejection log below — the body
 *  may not have parsed into the shape we expect, and this must never throw
 *  while handling a rejection. Never log the body itself, only these three
 *  identifying fields. */
function describeWhatsappWebhookRejection(
  body: unknown,
  hasSignature: boolean,
): { hasSignature: boolean; businessAccountId: string | null; phoneNumberId: string | null } {
  const entry = (
    body as
      | { entry?: Array<{ id?: string; changes?: Array<{ value?: { metadata?: { phone_number_id?: string } } }> }> }
      | null
      | undefined
  )?.entry?.[0];
  return {
    hasSignature,
    businessAccountId: typeof entry?.id === 'string' ? entry.id : null,
    phoneNumberId: entry?.changes?.[0]?.value?.metadata?.phone_number_id ?? null,
  };
}

/**
 * Receive webhook endpoint for WhatsApp Business API
 * This endpoint receives webhook events from WhatsApp
 */
const receiveWebhook = (config: WhatsappDoorConfig) => async (req: Request, res: Response): Promise<void> => {
  try {
    // Verify the Meta X-Hub-Signature-256 HMAC when an app secret is configured.
    // With NO app secret this used to skip verification entirely, anywhere — so
    // it now falls to the shared no-secret rule every inbound door shares
    // (`lib/unsigned_webhooks`): refused unless the deployment explicitly opted
    // into unsigned deliveries and is not production.
    const appSecret = config.appSecret;
    if (appSecret) {
      const signature = req.get('X-Hub-Signature-256');
      // Meta signs the RAW request bytes, captured as rawBody by the JSON
      // parser's verify hook (lib/middleware/body_parser). The re-serialising
      // fallback only byte-matches plain-ASCII payloads with no `/` in them, so
      // it is for callers that hand the handler a body directly (tests).
      const rawBody: Buffer =
        (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));
      if (!signature || !whatsappProvider.verifySignature(rawBody, signature, appSecret)) {
        // A mismatch is silent otherwise: an operator whose deliveries all
        // bounce sees only 401s in the access log, with no way to tell a
        // second Meta app (subscribed to the same WhatsApp Business Account,
        // signing with its own app secret) from a rotated secret.
        logger.warn(
          signature
            ? "[whatsapp/webhook] REJECTING inbound: signature did not verify against WHATSAPP_WEBHOOK_SECRET — the sending Meta app's secret differs (a second app subscribed to this WhatsApp Business Account, or the secret was reset in Meta)"
            : "[whatsapp/webhook] REJECTING inbound: X-Hub-Signature-256 header was absent — the sending Meta app's secret differs (a second app subscribed to this WhatsApp Business Account, or the secret was reset in Meta)",
          describeWhatsappWebhookRejection(req.body, Boolean(signature)),
        );
        res.sendStatus(401);
        return;
      }
    } else if (!authorizeUnsignedWebhook('whatsapp/webhook').authorized) {
      logger.error(
        '[whatsapp/webhook] REJECTING inbound: WHATSAPP_WEBHOOK_SECRET is unset, so ' +
          'nothing proves this delivery came from Meta.',
      );
      res.sendStatus(401);
      return;
    }
    logger.info('Received WhatsApp webhook:', req.body);
    try {
      const body = req.body as WhatsAppWebhookBody;
      if (body.object === 'whatsapp_business_account') {
        // Process each entry in the webhook
        const processingPromises: Promise<void>[] = [];

        // A tapped reply button arrives as an ordinary message carrying
        // `interactive.button_reply`/`list_reply` — branch FIRST, before any
        // movement-event parsing, exactly like Telegram's callback_query check
        // (services/webhook_sync/telegram_callback_door.ts). Unlike Telegram's
        // single callback_query per delivery, a batch can carry several
        // messages, so this does not gate what follows: `classifyMetaMessage`
        // already drops an interactive-typed message as unclassified, so
        // letting the rest of this handler also see it is harmless — never a
        // double dispatch. Off-request, like every other promise here.
        if (ownsWhatsappInteractiveReply(body)) {
          processingPromises.push(
            handleWhatsappInteractiveReplies({
              raw: body,
              responder: defaultWhatsappCallbackResponder(),
            })
              .then((results) => {
                logger.info('Handled WhatsApp interactive callback replies', {
                  count: results.length,
                });
              })
              .catch((error: unknown) => {
                logger.error('Error handling WhatsApp callback replies:', error);
              }),
          );
        }

        body.entry?.forEach(async (entry: WhatsAppWebhookEntry) => {
          // Get the webhook event
          const webhookEvent = entry.changes?.[0];

          if (webhookEvent?.field === 'messages') {
            const value = webhookEvent.value;
            // Only send notification for NEW MESSAGES
            if (value.messages && value.messages.length > 0) {
              // Send notification once per webhook that contains new messages
              const firstMessage = value.messages[0];
              const sender = await resolveWhatsappSender(firstMessage.from);

              let messageContent = '';
              if (firstMessage.text?.body) {
                messageContent = firstMessage.text.body;
              } else if (firstMessage.button) {
                messageContent = `Template Button: ${firstMessage.button.text} (${firstMessage.button.payload})`;
              } else if (firstMessage.interactive?.button_reply) {
                messageContent = `Interactive Button: ${firstMessage.interactive.button_reply.title} (${firstMessage.interactive.button_reply.id})`;
              } else if (firstMessage.contacts && firstMessage.contacts.length > 0) {
                const contact = firstMessage.contacts[0];
                messageContent = `Contact Card: ${contact.name.formatted_name}`;
                if (contact.org?.company) {
                  messageContent += ` @ ${contact.org.company}`;
                }
              } else {
                messageContent = '[No text content]';
              }

              const senderLabel = sender.displayName
                ? `${sender.displayName} (${firstMessage.from})`
                : `Unknown user: ${firstMessage.from}`;
              await sendSlackNotification({
                type: 'OVI',
                teamId: sender.teamId,
                text: `:speech_balloon: New WhatsApp message from: ${senderLabel}\n*Message*: "${messageContent}"`,
                opsTitle: `New WhatsApp message from ${sender.displayName ?? firstMessage.from}`,
              });

              // Dumb dispatch: each message goes straight to the sender team's
              // wired movement trigger or pipeline_input — no agent. The
              // receiving number (`metadata.phone_number_id`) rides along so a
              // reply goes out from the number it arrived on (primary vs
              // movements); `display_phone_number` is the human-facing `to`.
              const profileName = value.contacts?.[0]?.profile?.name;
              const businessPhoneNumberId = value.metadata?.phone_number_id;
              const businessNumber = value.metadata?.display_phone_number;
              value.messages.forEach((message: WhatsAppMessage) => {
                const processingPromise = dispatchWhatsappMessage({
                  message,
                  profileName,
                  businessNumber,
                  businessPhoneNumberId,
                })
                  .then(() => {
                    logger.info('Dispatched WhatsApp message', { messageId: message.id });
                  })
                  .catch((error: unknown) => {
                    logger.error('Error dispatching WhatsApp message:', {
                      messageId: message.id,
                      error,
                    });
                  });

                processingPromises.push(processingPromise);
              });
            }

            // `value.statuses` (delivery/read receipts) is intentionally
            // unprocessed: its only consumer, `updateMessageStatus`, wrote to
            // the writerless `whatsapp_messages` table, dropped at Phase 6
            // close (D57) — the row-creation loop it would have updated left
            // with the legacy dealflow era, so the write was already a no-op in
            // production. The field stays on the payload type below as
            // documentation of what Meta can send.
          }
        });

        Promise.all(processingPromises).catch((error: unknown) => {
          logger.error('Error in webhook processing:', error);
        });
        res.status(200).send('EVENT_RECEIVED');
        return;
      }
    } catch (error) {
      logger.warn('Failed to process request', {
        body: JSON.stringify(req.body),
        error: error,
      });
    }
  } catch (error: unknown) {
    logger.error('Error processing WhatsApp webhook:', error);
    res.sendStatus(500);
  }
};

export { verifyWebhook, receiveWebhook, WhatsAppMessage };
