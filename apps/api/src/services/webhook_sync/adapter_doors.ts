// The platform's store under the two push doors a REMOTE adapter calls when it
// owns its own inbound URL (the doors themselves are the shared inbound core's
// `answerEmit` / `answerWake`)
// (plans/cloud-native-2026-10-06/02_await_correlation_example.md, "Topology"):
//
//   emit(events) — new data: each event is matched against the team's triggers
//                  for that adapter type and receipted, exactly as a webhook
//                  delivery's events are;
//   wake(keys)   — resume whatever is parked on these correlation keys.
//
// The two are unordered and independent; nothing relies on a wake arriving
// before the dispatch it relates to. A wake for a key nothing is parked on, and
// an emit no trigger listens for, are accepted and leave nothing behind.
//
// The caller presents the credential its install holds (the same secret
// Listen-Fire authenticates to it with, carried the same way the install's
// `authStrategy` says), and the install whose secret matches is the team. Only a
// credential shared by several teams' installs needs the team named as well.

import { createHash, timingSafeEqual } from 'node:crypto';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { InboundHeaders, PushAuth, PushCaller, PushStore } from 'movement-engine/public/inbound';

import { teamIdSchema } from '../../lib/team_id';
import { loadRemoteAdapterSecret, resolveAdapter } from '../translation_graph/adapters/resolve';
import { RemoteAdapterManifestFile } from '../translation_graph/adapters/remote/manifest';
import { mayBeRemoteSlug } from '../translation_graph/adapters/remote/slugs';
import { listRemoteAdaptersOfType, type RemoteAdapterRow } from '../translation_graph/adapters/remote/store';
import { ADAPTER_TEAM_HEADER, authHeader } from 'movement-engine/services/translation_graph/protocol/client';
import { enqueueCapturedEvents, type CapturedTriggerEvent } from '../translation_graph/triggers/dispatch_event';
import { enqueueAwaitWakes } from '../movement_engine/await_wake';
import { notifyWork } from '../work/drain';
import { logger } from 'movement-engine/services/logger';
import { captureProviderTriggerEvents } from './handler';
import { webhookProviderKey } from './urls';

/** The credential matches no install of the type (or there is none, or the
 *  named team has none, or the slug is one a built-in answers to) — one answer
 *  for all four (`unauthorized`), so an anonymous caller cannot probe who
 *  installed what. */
export type AdapterDoorAuth = PushAuth;

const AuthStrategySchema = RemoteAdapterManifestFile.shape.authStrategy;

/** Digests first, so the comparison is constant-time whatever the lengths. */
function sameSecret(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

function headerValue(headers: InboundHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return typeof value === 'string' ? value : value?.[0];
}

/** Whether the presented headers carry this install's secret, the way its
 *  strategy sends it (the header the install sends to the remote is the one
 *  the remote sends back). An unreadable install never matches. */
async function presentsSecretOf(install: RemoteAdapterRow, headers: InboundHeaders): Promise<boolean> {
  if (install.credentials_id === null) return false;
  const strategy = AuthStrategySchema.safeParse(install.auth_strategy);
  if (!strategy.success) return false;
  let secret: string;
  try {
    secret = await loadRemoteAdapterSecret(install.credentials_id, teamIdSchema.parse(install.team_id), install.adapter_type);
  } catch (err) {
    logger.warn('[AdapterDoors] install secret unreadable; skipped', {
      adapterType: install.adapter_type,
      teamId: install.team_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  let matched = false;
  for (const [name, expected] of Object.entries(authHeader(strategy.data, secret))) {
    const presented = headerValue(headers, name);
    if (presented !== undefined && sameSecret(presented, expected)) matched = true;
  }
  return matched;
}

/**
 * Find the install the presented credential belongs to. Every candidate is
 * checked — no early exit — so the answer's timing does not say which install
 * matched. A caller whose credential is shared across teams names its team in
 * `x-listen-fire-team`, which narrows the candidates to that team's install.
 */
export async function authenticateAdapterDoor(input: {
  adapterType: string;
  headers: InboundHeaders;
}): Promise<AdapterDoorAuth> {
  // A slug a built-in answers to is never a remote install's, whatever row
  // the table holds — the same answer as no install, so it says nothing.
  if (!mayBeRemoteSlug(input.adapterType)) return { kind: 'unauthorized' };
  const namedTeam = headerValue(input.headers, ADAPTER_TEAM_HEADER);
  let teamId: TeamId | undefined;
  if (namedTeam !== undefined) {
    const parsed = teamIdSchema.safeParse(namedTeam);
    if (!parsed.success) return { kind: 'unauthorized' };
    teamId = parsed.data;
  }
  const installs = await listRemoteAdaptersOfType({
    adapterType: input.adapterType,
    ...(teamId !== undefined ? { teamId } : {}),
  });

  const matches: PushCaller[] = [];
  for (const install of installs) {
    if (install.credentials_id !== null && (await presentsSecretOf(install, input.headers))) {
      matches.push({
        teamId: teamIdSchema.parse(install.team_id),
        adapterType: install.adapter_type,
        credentialsId: install.credentials_id,
      });
    }
  }
  const [caller, ...others] = matches;
  if (caller === undefined) return { kind: 'unauthorized' };
  if (others.length > 0) return { kind: 'ambiguous' };
  return { kind: 'authenticated', caller };
}

/** The platform's store under the push doors (the core's `answerEmit` /
 *  `answerWake`): installs and their secrets, the trigger table, the work table. */
export const platformPushStore: PushStore<CapturedTriggerEvent> = {
  authenticate: (input) => authenticateAdapterDoor(input),

  // Best effort: an event that can't be discriminated still dispatches, seeded
  // from its payload.
  async eventTypes(caller) {
    try {
      const adapter = await resolveAdapter({ adapterType: caller.adapterType, teamId: caller.teamId as TeamId });
      return adapter.listEventTypes ? await adapter.listEventTypes() : [];
    } catch (err) {
      logger.warn('[AdapterDoors] listEventTypes failed; events dispatch undiscriminated', {
        adapterType: caller.adapterType,
        teamId: caller.teamId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  },

  capture: ({ caller, event, eventTypes }) =>
    captureProviderTriggerEvents({
      event,
      subscription: {
        team_id: caller.teamId,
        credentials_id: caller.credentialsId,
        provider: webhookProviderKey({ adapterType: caller.adapterType }),
      },
      adapterType: caller.adapterType,
      eventTypes,
    }),

  enqueue: (captured) => enqueueCapturedEvents([...captured]),

  enqueueWakes: ({ adapterType, teamId, keys }) =>
    enqueueAwaitWakes({ adapterType, teamId: teamId as TeamId, correlationKeys: keys }),

  notify: () => notifyWork(),
};
