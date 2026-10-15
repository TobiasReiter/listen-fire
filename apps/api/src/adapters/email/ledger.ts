// The outbound-email ledger: a db-level record of every email we send.
//
// It is a DECORATOR around whichever adapter is registered (services.ts), not a
// call at each send site — the whole point is that nothing escapes, and there
// are a dozen callers. One row per RECIPIENT per send attempt, carrying the
// outcome the adapter reported: a provider 4xx and a delivered message are
// distinguishable after the fact, which they weren't before.
//
// Logging never affects delivery: a ledger write failure is logged and
// swallowed, and the send's own result (or thrown error) passes straight
// through.

import type { TeamId } from '../../generated/kysely/core/Team';

import { getAutomationsQb } from '../../lib/kysely';
import { logger } from 'movement-engine/services/logger';
import { OutboundEmailMessager, SendArgs } from './interface';

/** Which adapter served a send — the ledger's record of who was asked. */
type OutboundEmailProvider = 'mailgun' | 'resend' | 'fake' | 'unconfigured';

async function recordSend(input: {
  args: SendArgs;
  provider: OutboundEmailProvider;
  success: boolean;
  error: string | null;
}): Promise<void> {
  const { args, provider, success, error } = input;
  const rows = args.recipients.map((r) => ({
    team_id: (args.metadata?.teamId as TeamId | undefined) ?? null,
    recipient_email: r.email,
    subject: args.subject,
    kind: args.metadata?.kind ?? null,
    provider,
    success,
    error,
  }));
  if (rows.length === 0) return;

  try {
    await getAutomationsQb(['outbound_email']).insertInto('outbound_email').values(rows).execute();
  } catch (err) {
    logger.error('[outbound-email] failed to record send in the ledger', {
      provider,
      subject: args.subject,
      success,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Wrap an outbound email adapter so every send lands in `outbound_email`. */
function withOutboundEmailLedger(
  inner: OutboundEmailMessager,
  provider: OutboundEmailProvider,
): OutboundEmailMessager {
  return {
    async send(args: SendArgs): Promise<boolean> {
      let success: boolean;
      try {
        success = await inner.send(args);
      } catch (err) {
        await recordSend({
          args,
          provider,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      await recordSend({
        args,
        provider,
        success,
        error: success ? null : 'provider rejected the message',
      });
      return success;
    },
  };
}

export { withOutboundEmailLedger, type OutboundEmailProvider };
