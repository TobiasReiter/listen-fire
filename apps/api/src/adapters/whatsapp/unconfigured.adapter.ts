import { logger } from 'movement-engine/public/log';
import { OutboundWhatsAppMessager, SendArgs } from './interface';

/**
 * The production/staging stand-in for missing outbound-WhatsApp config —
 * TWILIO_NUMBER, TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN, none of which has a
 * safe default and any of which alone cannot send. Production used to fall back
 * to the fake adapter, which POSTs at a localhost outbox that isn't there and
 * returns `true` anyway — so every production WhatsApp message evaporated while
 * reporting success. This fails loudly instead: callers see `false` and can act
 * on an undeliverable message rather than believing a delivered one.
 */
class UnconfiguredOutboundWhatsAppAdapter implements OutboundWhatsAppMessager {
  async send(args: SendArgs): Promise<boolean> {
    logger.error(
      'whatsapp adapter unconfigured in production/staging — set TWILIO_NUMBER, TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN',
      {
        recipient: args.recipient.phoneNumber,
        contentSid: args.contentSid,
      },
    );
    return false;
  }
}

export { UnconfiguredOutboundWhatsAppAdapter };
