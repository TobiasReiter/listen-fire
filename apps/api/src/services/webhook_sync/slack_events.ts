// The "Listen-Fire" Slack app's inbound Events door — the single global entry for the
// movements app, which is installed per workspace (one Events URL for the app,
// all installs deliver here). Distinct from the BYO webhook_sync door (per
// subscription URL): routing is by the Slack workspace (`team_id`).
//
//   inbound event  →  team_id  →  the app_id='listen-fire' SLACK credential whose
//   identifier is `teamId:<team_id>`  →  that credential's Listen-Fire team + token
//   →  dispatch the team's Slack movements (which reply via that install).
//
// A workspace with no Slack credential (not installed / uninstalled) is dropped.

import { getAutomationsQb } from '../../lib/kysely';
import { logger } from '../logger';
import { parseSlackEvents } from './providers/slack';
import { dispatchToProviderTriggers } from './handler';
import { enqueueAwaitWakes } from '../movement_engine/await_wake';
import { teamIdSchema } from '../../lib/team_id';
import { resolveAdapter } from '../translation_graph/adapters/resolve';
import { SLACK_ADAPTER_TYPE, slackEventToDiscriminable } from '../translation_graph/adapters/slack';
import { SLACK_APP_ID } from '../credentials/app_id';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import type { TeamId } from '../../generated/kysely/core/Team';

/** The provider key SLACK triggers are routed by (= `trigger.kind`). */
const SLACK_PROVIDER_KEY = 'SLACK';

export interface SlackEventsResult {
  ok: boolean;
  classification: 'dispatched' | 'no_events' | 'unknown_workspace' | 'no_team';
  /** The Slack workspace id the delivery was for, when present. */
  teamId?: string;
  eventsProcessed?: number;
}

/**
 * Resolve a Slack workspace id → the Listen-Fire install for it: the `SLACK`
 * credential stamped `app_id='listen-fire'` whose `identifier` is `teamId:<id>`. The
 * credential row carries the Listen-Fire team + is the send identity (its token).
 */
async function resolveSlackInstall(
  slackTeamId: string,
): Promise<{ credentialsId: string; nativeTeamId: TeamId } | null> {
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('type', '=', ExternalServiceType.SLACK)
    .where('app_id', '=', SLACK_APP_ID.movements)
    .where('identifier', '=', `teamId:${slackTeamId}`)
    .select(['id', 'team_id'])
    .executeTakeFirst();
  if (!row) return null;
  return { credentialsId: row.id as unknown as string, nativeTeamId: teamIdSchema.parse(row.team_id) };
}

/**
 * The Listen-Fire-app inbound entry. ONE global call per delivered `event_callback`.
 * Routes by the envelope `team_id` to the workspace's install, then dispatches
 * each event through the shared trigger fan-out with that install's credential
 * (so trigger matching + the reply both use the right token). url_verification
 * is handled at the route before this runs.
 */
export async function handleSlackEventsInbound(raw: unknown): Promise<SlackEventsResult> {
  const teamId = (raw as { team_id?: unknown } | null | undefined)?.team_id;
  if (typeof teamId !== 'string' || teamId.length === 0) {
    return { ok: true, classification: 'no_team' };
  }

  const events = parseSlackEvents(raw);
  if (events.length === 0) {
    return { ok: true, classification: 'no_events', teamId };
  }

  const install = await resolveSlackInstall(teamId);
  if (!install) {
    logger.info('[SlackEvents] no Listen-Fire install for workspace — ignoring', { teamId });
    return { ok: true, classification: 'unknown_workspace', teamId };
  }

  // The wake door, independent of dispatch below (consent-by-silence, S18).
  const nativeTeamId = install.nativeTeamId;
  try {
    const adapter = await resolveAdapter({
      adapterType: SLACK_ADAPTER_TYPE,
      teamId: nativeTeamId,
      credentialsId: install.credentialsId,
    });
    if (adapter.wakeKeys) {
      await enqueueAwaitWakes({
        adapterType: adapter.adapterType,
        teamId: nativeTeamId,
        correlationKeys: await adapter.wakeKeys({ raw }),
      });
    }
  } catch (err) {
    logger.error('[SlackEvents] await wake failed', {
      teamId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let processed = 0;
  for (const event of events) {
    try {
      await dispatchToProviderTriggers({
        // The shared Slack mapper stamps `changeType: 'create'` on message
        // deliveries — what routes the seed onto the EVENT node (`Message
        // Received`). Reactions carry none and keep their legacy seed.
        event: slackEventToDiscriminable(event),
        // The install's credential is BOTH the trigger-matching key and the send
        // identity — a real BYO-style dispatch (no matchAnyCredential), so a
        // team's Slack movement fires and replies via its own workspace token.
        subscription: {
          team_id: install.nativeTeamId,
          credentials_id: install.credentialsId,
          provider: SLACK_PROVIDER_KEY,
        },
        adapterType: SLACK_ADAPTER_TYPE,
      });
      processed += 1;
    } catch (err) {
      logger.error('[SlackEvents] dispatch failed', {
        teamId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ok: true, classification: 'dispatched', teamId, eventsProcessed: processed };
}
