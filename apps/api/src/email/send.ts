// The one way this codebase should call the outbound email seam.
//
// `services.email.send` returns FALSE when the provider rejected the message.
// Every caller used to `await` it and drop the boolean, so a Mailgun 4xx was
// indistinguishable from a delivered email — the notice paths even logged
// "sent". This wrapper makes a rejection visible (error log, and a
// success=false row in outbound_email via the ledger decorator) and hands the
// boolean back, so callers with a user-facing channel can tell the truth.
//
// It also carries the `kind` tag into the ledger, which is what makes the ledger
// queryable by what the message WAS rather than by its subject line.

import type { SendArgs } from '../adapters/email/interface';

import { services } from '../adapters/registry';
import { logger } from 'movement-engine/public/log';

/** Send through the seam. Returns whether the provider accepted the message. */
async function sendEmail(kind: string, args: SendArgs): Promise<boolean> {
  const delivered = await services.email.send({
    ...args,
    metadata: { ...args.metadata, kind },
  });
  if (!delivered) {
    logger.error('[email] provider rejected the message', {
      kind,
      subject: args.subject,
      recipients: args.recipients.map((r) => r.email),
      teamId: args.metadata?.teamId,
    });
  }
  return delivered;
}

export { sendEmail };
