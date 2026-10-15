import { logger } from 'movement-engine/services/logger';
import { OutboundEmailMessager, SendArgs } from './interface';

const FAKE_CHANNELS_URL = process.env.FAKE_CHANNELS_URL || 'http://localhost:5556';

class FakeOutboundEmailAdapter implements OutboundEmailMessager {
  async send(args: SendArgs): Promise<boolean> {
    const payload = {
      recipients: args.recipients,
      sender: args.sender,
      cc: args.cc,
      subject: args.subject,
      data: args.data,
      replyToHeader: args.replyToHeader,
      inReplyToHeader: args.inReplyToHeader,
      attachment: args.attachment
        ? { filename: args.attachment.filename, size: args.attachment.data?.length ?? 0 }
        : undefined,
    };

    try {
      const res = await fetch(`${FAKE_CHANNELS_URL}/email/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        logger.warn(`FakeOutboundEmailAdapter: fake-channels returned ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      // An unreachable outbox is a FAILED send. Reporting success here made the
      // dev loop unable to distinguish "delivered to the fake outbox" from
      // "nothing happened", which is exactly the bug the ledger exists to catch.
      logger.warn(
        `FakeOutboundEmailAdapter: fake-channels unreachable at ${FAKE_CHANNELS_URL}. ${(err as Error).message}`,
      );
      logger.info(`Email payload (undelivered): ${JSON.stringify(payload)}`);
      return false;
    }
  }
}

export { FakeOutboundEmailAdapter };
