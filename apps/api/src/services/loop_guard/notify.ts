// Loop guard — breach notification.
//
// Fire-and-forget: a Slack/notify failure must NEVER break dispatch (same
// discipline as the old breaker's emitHaltAlert). Mirrors that block, but
// generalised from "linked_object" to "automation paused by the safety guard".
//
// The operator gets full internal detail via sendSlackNotification SUPPORT.
// The team-facing durable in-app notification is an explicit follow-up (see
// 4_disable_and_notify.md §4.4 option 2 + 6_phasing.md "team-facing in-app
// notification"); until it exists we emit a plain-language, jargon-free log line
// addressed to the team so the message content is already written for the user.

import type { TeamId } from '../../generated/kysely/core/Team';
import type { GuardSignal } from './types';

import { getCoreQb } from '../../lib/kysely';
import { sendSlackNotification } from '../../lib/slack';
import { logger } from 'movement-engine/public/log';


const SIGNAL_LABEL: Record<GuardSignal, string> = {
  trigger_rate: 'per-automation rate limit',
  team_budget: 'team usage budget',
};

export async function notifyBreach(input: {
  teamId: string;
  triggerId: string;
  triggerName: string;
  signal: GuardSignal;
  reason: string;
  /** The observed count and the limit it crossed, for the operator detail. */
  observed: number;
  limit: number;
  windowSeconds: number;
}): Promise<void> {
  const team = await getCoreQb(['team'])
    .selectFrom('team')
    .where('id', '=', input.teamId as TeamId)
    .select(['name'])
    .executeTakeFirst()
    .catch(() => undefined);
  const teamName = team?.name ?? input.teamId;

  // Operator (full internal detail). Mirrors the old emitHaltAlert block.
  await sendSlackNotification({
    type: 'SUPPORT',
    text: `Loop guard paused automation "${input.triggerName}" (${teamName})`,
    opsTitle: `Loop guard paused automation "${input.triggerName}"`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `:rotating_light: *Loop guard paused an automation* — the safety floor stepped in.\n` +
            `Automation *${input.triggerName}* tripped the *${SIGNAL_LABEL[input.signal]}* ` +
            `(${input.observed} over a limit of ${input.limit} in ${input.windowSeconds}s). ` +
            `The run is skipped and the automation is paused; inbound events are still ` +
            `recorded and replayable. Manual resume required.`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Team:*\n${teamName} (\`${input.teamId}\`)` },
          { type: 'mrkdwn', text: `*Automation:*\n\`${input.triggerId}\`` },
          { type: 'mrkdwn', text: `*Signal:*\n${input.signal}` },
          { type: 'mrkdwn', text: `*Reason:*\n${input.reason}` },
        ],
      },
    ],
    unfurl_links: false,
    unfurl_media: false,
  }).catch((err) => {
    logger.error('[LoopGuard] failed to post operator breach alert', {
      triggerId: input.triggerId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Team-facing message (plain language, no internal jargon). Durable in-app
  // delivery is the deferred follow-up; the wording is final so dropping it
  // into a team_notification row later is a one-line change.
  logger.info('[LoopGuard] team notice (pending durable in-app channel)', {
    teamId: input.teamId,
    triggerId: input.triggerId,
    message:
      `We paused the automation "${input.triggerName}" because it started running far ` +
      `more than expected. No data was lost — we've held the events. You can review and ` +
      `re-enable it from the automation's page.`,
  });
}
