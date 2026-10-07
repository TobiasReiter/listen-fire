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
// The caller never names its team. It presents the credential its install
// holds (the same secret Listen-Fire authenticates to it with, carried the same
// way the install's `authStrategy` says), and the install whose secret matches
// is the team.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { DiscriminableEvent, EventType } from '../translation_graph/adapter';
import { loadRemoteAdapterSecret, resolveAdapter } from '../translation_graph/adapters/resolve';
import { RemoteAdapterManifestFile } from '../translation_graph/adapters/remote/manifest';
import { listRemoteAdaptersOfType } from '../translation_graph/adapters/remote/store';
import { authHeader } from '../translation_graph/protocol/client';
import { enqueueCapturedEvents, type CapturedTriggerEvent } from '../translation_graph/triggers/dispatch_event';
import { enqueueAwaitWake } from '../movement_engine/await_wake';
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
  /** No team has installed this adapter type. */
  | { kind: 'unknown_adapter' }
  /** Installs exist, and the presented credential matches none of them. */
  | { kind: 'unauthorized' };

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

/**
 * Find the install the presented credential belongs to. Every install of the
 * type is a candidate; the first whose secret matches (oldest install first)
 * names the team. A row without a credential, a malformed strategy, or a
 * secret that will not decrypt is skipped, never an error the caller sees.
 */
export async function authenticateAdapterDoor(input: {
  adapterType: string;
  headers: IncomingHttpHeaders;
}): Promise<AdapterDoorAuth> {
  const installs = await listRemoteAdaptersOfType({ adapterType: input.adapterType });
  if (installs.length === 0) return { kind: 'unknown_adapter' };

  for (const install of installs) {
    if (install.credentials_id === null) continue;
    const strategy = AuthStrategySchema.safeParse(install.auth_strategy);
    if (!strategy.success) continue;
    let secret: string;
    try {
      secret = await loadRemoteAdapterSecret(
        install.credentials_id,
        install.team_id as TeamId,
        install.adapter_type,
      );
    } catch (err) {
      logger.warn('[AdapterDoors] install secret unreadable; skipped', {
        adapterType: install.adapter_type,
        teamId: install.team_id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    // The header the install's strategy sends to the remote is the one the
    // remote sends back.
    for (const [name, expected] of Object.entries(authHeader(strategy.data, secret))) {
      const presented = headerValue(input.headers, name);
      if (presented !== undefined && sameSecret(presented, expected)) {
        return {
          kind: 'authenticated',
          caller: {
            teamId: install.team_id as TeamId,
            adapterType: install.adapter_type,
            credentialsId: install.credentials_id,
          },
        };
      }
    }
  }
  return { kind: 'unauthorized' };
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
  for (const correlationKey of input.keys) {
    await enqueueAwaitWake({
      adapterType: input.caller.adapterType,
      teamId: input.caller.teamId,
      correlationKey,
    });
  }
  notifyWork();
  return { accepted: input.keys.length };
}
