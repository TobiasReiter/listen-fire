import type { TeamId } from '../generated/kysely/core/Team';
import type { UserId } from '../generated/kysely/core/User';

import { getCoreQb, getQb } from '../lib/kysely';
import { sendSlackNotification } from '../lib/slack';
import { sendEmail } from '../email/send';
import { logger } from 'movement-engine/public/log';

type EventType = 'pipeline_run' | 'query_input';

interface UsageStatus {
  allowed: boolean;
  used: number;
  weeklyMax: number;
  additional: number;
  effectiveLimit: number;
  remaining: number;
  periodStart: Date;
  periodEnd: Date;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getPeriodBounds(weekStartsOn: number): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  const currentDay = now.getUTCDay();
  const diff = (currentDay - weekStartsOn + 7) % 7;

  const periodStart = new Date(now);
  periodStart.setUTCDate(periodStart.getUTCDate() - diff);
  periodStart.setUTCHours(0, 0, 0, 0);

  const periodEnd = new Date(periodStart);
  periodEnd.setUTCDate(periodEnd.getUTCDate() + 7);

  return { periodStart, periodEnd };
}

function getConfigColumn(eventType: EventType, prefix: 'max_weekly' | 'additional') {
  return eventType === 'pipeline_run'
    ? `${prefix}_pipeline_runs` as const
    : `${prefix}_query_inputs` as const;
}

function eventTypeLabel(eventType: EventType): string {
  return eventType === 'pipeline_run' ? 'pipeline runs' : 'query inputs';
}

async function getConfig(teamId: string) {
  const qb = getQb(['team_usage_config']);
  return qb
    .selectFrom('team_usage_config')
    .selectAll()
    .where('team_id', '=', teamId as TeamId)
    .executeTakeFirst();
}

async function countUsageForPeriod(teamId: string, eventType: EventType, periodStart: Date): Promise<number> {
  const qb = getQb(['usage_event']);
  const result = await qb
    .selectFrom('usage_event')
    .select(qb.fn.countAll<string>().as('count'))
    .where('team_id', '=', teamId as TeamId)
    .where('event_type', '=', eventType)
    .where('created_at', '>=', periodStart)
    .executeTakeFirstOrThrow();
  return parseInt(result.count, 10);
}

async function checkUsage(teamId: string, eventType: EventType): Promise<UsageStatus | null> {
  const config = await getConfig(teamId);
  if (!config) return null;

  const { periodStart, periodEnd } = getPeriodBounds(config.week_starts_on);
  const used = await countUsageForPeriod(teamId, eventType, periodStart);
  const weeklyMax = config[getConfigColumn(eventType, 'max_weekly')];
  const additional = config[getConfigColumn(eventType, 'additional')];
  const effectiveLimit = weeklyMax + additional;
  const remaining = Math.max(0, effectiveLimit - used);

  return {
    allowed: used < effectiveLimit,
    used,
    weeklyMax,
    additional,
    effectiveLimit,
    remaining,
    periodStart,
    periodEnd,
  };
}

async function recordEvent(options: {
  teamId: string;
  eventType: EventType;
  referenceId?: string;
  createdBy?: string;
}): Promise<void> {
  const qb = getQb(['usage_event']);
  await qb
    .insertInto('usage_event')
    .values({
      team_id: options.teamId as TeamId,
      event_type: options.eventType,
      reference_id: options.referenceId ?? null,
      created_by: (options.createdBy as UserId) ?? null,
    })
    .execute();
}

async function checkAndAlert(teamId: string, eventType: EventType): Promise<void> {
  const config = await getConfig(teamId);
  if (!config) return;

  const { periodStart } = getPeriodBounds(config.week_starts_on);
  const used = await countUsageForPeriod(teamId, eventType, periodStart);
  const weeklyMax = config[getConfigColumn(eventType, 'max_weekly')];
  const additional = config[getConfigColumn(eventType, 'additional')];
  const effectiveLimit = weeklyMax + additional;

  // Decrement additional balance when in overage
  if (used > weeklyMax && additional > 0) {
    const col = getConfigColumn(eventType, 'additional');
    const qb = getQb(['team_usage_config']);
    await qb
      .updateTable('team_usage_config')
      .set((eb) => ({ [col]: eb(col, '-', 1) }))
      .where('team_id', '=', teamId as TeamId)
      .where(col, '>', 0)
      .execute();
  }

  if (used >= effectiveLimit) {
    await tryAlert(teamId, eventType, 'exhausted', periodStart);
  } else {
    const threshold = Math.floor(effectiveLimit * config.alert_threshold_pct / 100);
    if (used >= threshold) {
      await tryAlert(teamId, eventType, 'threshold', periodStart);
    }
  }
}

async function tryAlert(
  teamId: string,
  eventType: EventType,
  alertKind: 'threshold' | 'exhausted',
  periodStart: Date,
): Promise<void> {
  const qb = getQb(['usage_alert']);
  const inserted = await qb
    .insertInto('usage_alert')
    .values({
      team_id: teamId as TeamId,
      event_type: eventType,
      alert_kind: alertKind,
      period_start: periodStart,
    })
    .onConflict((oc) =>
      oc.columns(['team_id', 'event_type', 'alert_kind', 'period_start']).doNothing(),
    )
    .returning('id')
    .executeTakeFirst();

  // If null, the alert already fired this period
  if (!inserted) return;

  await sendUsageAlert(teamId, eventType, alertKind);
}

async function sendUsageAlert(
  teamId: string,
  eventType: EventType,
  alertKind: 'threshold' | 'exhausted',
): Promise<void> {
  const contacts = await getBillingContacts(teamId);
  const label = eventTypeLabel(eventType);

  const subject = alertKind === 'threshold'
    ? `Usage alert: approaching ${label} limit`
    : `Usage alert: ${label} limit reached`;

  const body = alertKind === 'threshold'
    ? `Your team is approaching its weekly ${label} limit. Consider purchasing additional usage to avoid interruption.`
    : `Your team has reached its weekly ${label} limit. New ${label === 'pipeline runs' ? 'pipelines' : 'questions'} will be blocked until the period resets or additional usage is purchased.`;

  let successes = 0;
  for (const contact of contacts) {
    try {
      const delivered = await sendEmail('usage_alert', {
        recipients: [{ email: contact.email, username: contact.email }],
        subject,
        data: body,
        metadata: { teamId },
      });
      if (delivered) successes++;
    } catch (err) {
      logger.error('Failed to send usage alert email', { error: String(err), email: contact.email });
    }
  }

  // No contact actually received it — whether that's because there are none or
  // because every send failed, the alert is lost and a human needs to know.
  if (successes === 0) {
    await sendSlackNotification({
      type: 'SUPPORT',
      opsTitle: subject,
      text: `:warning: ${subject} for team ${teamId} — ${body}`,
    }).catch((err) => {
      logger.error('Failed to send usage alert to Slack', { error: String(err) });
    });
  }
}

async function getBillingContacts(teamId: string): Promise<Array<{ email: string; userId: string }>> {
  const qb = getCoreQb(['user_email', 'user']);
  const contacts = await qb
    .selectFrom('user_email')
    .innerJoin('user', 'user.id', 'user_email.user_id')
    .select(['user_email.email', 'user.id as userId'])
    .where('user.default_team_id', '=', teamId as TeamId)
    .where('user.granted_access_at', 'is not', null)
    .where('user_email.is_billing_contact', '=', true)
    .execute();

  return contacts.map((c) => ({ email: c.email, userId: c.userId }));
}

const USAGE_EXHAUSTED_MESSAGES = {
  pipeline_run:
    "Your team has reached its weekly pipeline run limit. New messages won't be processed until the period resets. Contact your team admin to purchase additional usage.",
  query_input:
    "Your team has reached its weekly question limit. Please wait for the period to reset or contact your team admin to purchase additional usage.",
} as const;

export {
  checkUsage,
  recordEvent,
  checkAndAlert,
  getBillingContacts,
  USAGE_EXHAUSTED_MESSAGES,
  type EventType,
  type UsageStatus,
};
