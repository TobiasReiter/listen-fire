// The two push doors a REMOTE adapter calls when it owns its own inbound URL
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
import type { IncomingHttpHeaders } from 'node:http';
import type { TeamId } from '../../generated/kysely/core/Team';
import { teamIdSchema } from '../../lib/team_id';
import type { DiscriminableEvent, EventType } from '../translation_graph/adapter';
import { loadRemoteAdapterSecret, resolveAdapter } from '../translation_graph/adapters/resolve';
import { RemoteAdapterManifestFile } from '../translation_graph/adapters/remote/manifest';
import { mayBeRemoteSlug } from '../translation_graph/adapters/remote/slugs';
import { listRemoteAdaptersOfType, type RemoteAdapterRow } from '../translation_graph/adapters/remote/store';
import { ADAPTER_TEAM_HEADER, authHeader } from '../translation_graph/protocol/client';
import { enqueueCapturedEvents, type CapturedTriggerEvent } from '../translation_graph/triggers/dispatch_event';
import { enqueueAwaitWakes } from '../movement_engine/await_wake';
import { notifyWork } from '../work/drain';
import { logger } from '../logger';
import { captureProviderTriggerEvents } from './handler';
import { webhookProviderKey } from './urls';

/** The install a door call authenticated as. */
export interface AdapterDoorCaller {
  teamId: TeamId;
  adapterType: string;
  credentialsId: string;
}

export type AdapterDoorAuth =
  | { kind: 'authenticated'; caller: AdapterDoorCaller }
  /** The credential matches no install of the type (or there is none, or the
   *  named team has none, or the slug is one a built-in answers to) — one
   *  answer for all four, so an anonymous caller cannot probe who installed
   *  what. */
  | { kind: 'unauthorized' }
  /** The credential matches installs on more than one team; the caller must
   *  name its team. */
  | { kind: 'ambiguous' };

const AuthStrategySchema = RemoteAdapterManifestFile.shape.authStrategy;

/** Digests first, so the comparison is constant-time whatever the lengths. */
function sameSecret(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Whether the presented headers carry this install's secret, the way its
 *  strategy sends it (the header the install sends to the remote is the one
 *  the remote sends back). An unreadable install never matches. */
async function presentsSecretOf(install: RemoteAdapterRow, headers: IncomingHttpHeaders): Promise<boolean> {
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
  headers: IncomingHttpHeaders;
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

  const matches: AdapterDoorCaller[] = [];
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

/** The adapter's event-type union, for discrimination. Best effort: an event
 *  that can't be discriminated still dispatches, seeded from its payload. */
async function remoteEventTypes(caller: AdapterDoorCaller): Promise<readonly EventType[]> {
  try {
    const adapter = await resolveAdapter({ adapterType: caller.adapterType, teamId: caller.teamId });
    return adapter.listEventTypes ? await adapter.listEventTypes() : [];
  } catch (err) {
    logger.warn('[AdapterDoors] listEventTypes failed; events dispatch undiscriminated', {
      adapterType: caller.adapterType,
      teamId: caller.teamId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Receipt each event against the caller's triggers and queue a run per
 * receipt. Returns the receipts made. A capture that throws fails the call
 * AFTER the receipts already made are queued, since a receipt without its
 * work row would never run.
 */
export async function emitAdapterEvents(input: {
  caller: AdapterDoorCaller;
  events: readonly DiscriminableEvent[];
}): Promise<{ accepted: number; failed: number }> {
  const { caller } = input;
  const subscription = {
    team_id: caller.teamId,
    credentials_id: caller.credentialsId,
    provider: webhookProviderKey({ adapterType: caller.adapterType }),
  };
  const eventTypes = input.events.length > 0 ? await remoteEventTypes(caller) : [];

  const captured: CapturedTriggerEvent[] = [];
  let failed = 0;
  for (const event of input.events) {
    try {
      const receipts = await captureProviderTriggerEvents({
        event,
        subscription,
        adapterType: caller.adapterType,
        eventTypes,
      });
      captured.push(...receipts);
    } catch (err) {
      failed += 1;
      logger.error('[AdapterDoors] emit capture failed', {
        adapterType: caller.adapterType,
        teamId: caller.teamId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await enqueueCapturedEvents(captured);
  if (captured.length > 0) notifyWork();
  return { accepted: captured.length, failed };
}

/** Queue a wake per key. A key nothing is parked on drains as a no-op. */
export async function wakeAdapterKeys(input: {
  caller: AdapterDoorCaller;
  keys: readonly string[];
}): Promise<{ accepted: number }> {
  await enqueueAwaitWakes({
    adapterType: input.caller.adapterType,
    teamId: input.caller.teamId,
    correlationKeys: input.keys,
  });
  notifyWork();
  return { accepted: input.keys.length };
}
