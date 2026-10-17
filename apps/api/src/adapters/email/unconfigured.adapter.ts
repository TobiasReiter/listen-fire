import { logger } from 'movement-engine/public/log';
import { OutboundEmailMessager, SendArgs } from './interface';

/**
 * The production/staging stand-in for missing outbound-email config. There are
 * two ways to be configured — RESEND_API_KEY, or the Mailgun pair
 * MAILGUN_API_KEY + MAILGUN_SENDING_DOMAIN — and both also need
 * OUTBOUND_EMAIL_FROM, because nothing has a safe default and no partial set
 * can send. Production used to fall back to the fake adapter, which posted at a
 * localhost outbox that isn't there and reported success — so every alert email
 * silently evaporated. This fails loudly instead: callers see `false`, the
 * ledger records the failure, and the billing-notice paths escalate to SUPPORT
 * as they would for any other undeliverable notice.
 */
class UnconfiguredOutboundEmailAdapter implements OutboundEmailMessager {
  async send(args: SendArgs): Promise<boolean> {
    logger.error('email adapter unconfigured in production/staging — set OUTBOUND_EMAIL_FROM plus either RESEND_API_KEY or MAILGUN_API_KEY + MAILGUN_SENDING_DOMAIN', {
      subject: args.subject,
      recipients: args.recipients.map((r) => r.email),
      kind: args.metadata?.kind,
      teamId: args.metadata?.teamId,
    });
    return false;
  }
}

export { UnconfiguredOutboundEmailAdapter };
