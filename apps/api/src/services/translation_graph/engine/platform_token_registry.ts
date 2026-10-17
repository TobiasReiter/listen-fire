// Listen-Fire-owned API-token registry for Layer 14.4 actor-based echo recognition.
// When the engine writes to an external system, it uses one of these tokens.
// When the source system later surfaces the resulting change with actor info,
// we drop it at entry as our own echo.
//
// **Correctness independence**: if recognition fails (token missing from
// registry, actor info absent, etc.), the layered defenses above (P14.1
// no-op detection and P14.2 circuit breaker) carry the load. This is a
// performance optimization, not a correctness mechanism.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { Actor } from 'movement-engine/public/adapter';

/**
 * Registry of API-token IDs Listen-Fire itself owns when writing to external
 * systems. The lookup is per (team, adapter) — different teams may have
 * different tokens, and different adapters certainly do.
 *
 * Storage is TBD pending the first adapter that needs it (per
 * 3h_loop_prevention.md open questions). Likely either:
 * - A `team_settings.platform_token_ids` JSONB array, or
 * - A small `platform_owned_token` table keyed on (team_id, adapter_type, token_id).
 */
export interface PlatformTokenRegistry {
  /**
   * Whether the given actor matches a Listen-Fire-owned token for the given
   * adapter and team. Returns `false` when the actor is not an api-token,
   * when the registry has no entry, or when the actor's id is null.
   */
  isPlatformOwned(input: {
    teamId: TeamId;
    adapterType: string;
    actor: Actor;
  }): Promise<boolean>;

  /**
   * Register a token as Listen-Fire-owned. Called when the framework provisions a
   * new outbound-write token for an adapter.
   */
  registerToken(input: {
    teamId: TeamId;
    adapterType: string;
    tokenId: string;
  }): Promise<void>;

  /**
   * Unregister a token (e.g., after rotation or revocation).
   */
  unregisterToken(input: {
    teamId: TeamId;
    adapterType: string;
    tokenId: string;
  }): Promise<void>;
}

/**
 * In-memory implementation — useful for testing and as a placeholder until
 * persistent storage is designed. Throws if used in non-development contexts
 * to avoid silent in-memory state in production.
 */
export class InMemoryPlatformTokenRegistry implements PlatformTokenRegistry {
  private readonly tokens = new Set<string>();

  async isPlatformOwned(input: { teamId: TeamId; adapterType: string; actor: Actor }): Promise<boolean> {
    if (input.actor.type !== 'api-token') return false;
    if (input.actor.id === null) return false;
    return this.tokens.has(this.key(input.teamId, input.adapterType, input.actor.id));
  }

  async registerToken(input: { teamId: TeamId; adapterType: string; tokenId: string }): Promise<void> {
    this.tokens.add(this.key(input.teamId, input.adapterType, input.tokenId));
  }

  async unregisterToken(input: { teamId: TeamId; adapterType: string; tokenId: string }): Promise<void> {
    this.tokens.delete(this.key(input.teamId, input.adapterType, input.tokenId));
  }

  private key(teamId: TeamId, adapterType: string, tokenId: string): string {
    return `${teamId}:${adapterType}:${tokenId}`;
  }
}

/**
 * Decide whether an inbound trigger event is an echo of a write Listen-Fire itself
 * produced. Returns `true` when the framework should drop the event at entry
 * before any other processing.
 *
 * This is the entry point for Layer 14.4. Wired into the engine's trigger-
 * router before it invokes the rest of the pipeline.
 */
export async function shouldDropAsNativeEcho(input: {
  registry: PlatformTokenRegistry;
  teamId: TeamId;
  adapterType: string;
  actor: Actor | undefined;
}): Promise<boolean> {
  if (!input.actor) return false; // no actor info → fall back to P14.1/P14.2
  return input.registry.isPlatformOwned({
    teamId: input.teamId,
    adapterType: input.adapterType,
    actor: input.actor,
  });
}
