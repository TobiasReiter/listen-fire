import { logger } from 'movement-engine/services/logger';
import { OutboundWhatsAppMessager, SendArgs } from './interface';

const FAKE_CHANNELS_URL = process.env.FAKE_CHANNELS_URL || 'http://localhost:5556';

class FakeOutboundWhatsAppAdapter implements OutboundWhatsAppMessager {
  async send(args: SendArgs): Promise<boolean> {
    const payload = {
      recipient: args.recipient,
      body: args.body,
      contentSid: args.contentSid,
    };

    try {
      const res = await fetch(`${FAKE_CHANNELS_URL}/whatsapp/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        logger.warn(`FakeOutboundWhatsAppAdapter: fake-channels returned ${res.status}`);
      }
      return true;
    } catch (err) {
      logger.warn(
        `FakeOutboundWhatsAppAdapter: fake-channels unreachable at ${FAKE_CHANNELS_URL}, falling back to log. ${(err as Error).message}`,
      );
      logger.info(`WhatsApp payload (fallback log): ${JSON.stringify(payload)}`);
      return true;
    }
  }
}

export { FakeOutboundWhatsAppAdapter };
