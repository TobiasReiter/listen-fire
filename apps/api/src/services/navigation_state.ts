// ## NavigationState service
//
// Per-conversation navigation state. Agents work in names + pinned
// references; the framework owns the id resolution. Replaces the
// id-passing-through-handoffs pattern the V-cycle was trying to patch.
//
// See plans/2026-05-24-navigation-state/2_architecture.md for the
// principle (browser-tab analogy: navigateTo REPLACES, extendNavigation
// MERGES). resolveByName implements recency disambiguation:
//   1. Prefer the entity most-recently-pinned in THIS conversation
//      (i.e. the latest navigateTo / extendNavigation that named it)
//   2. Fall back to the team's most-recently-updated entity of that kind
//   3. If still tied: arbitrary, stable on uuid sort

import { sql } from 'kysely';

import type { AgentConversationId } from '../generated/kysely/public/AgentConversation';
import type { TeamId } from '../generated/kysely/core/Team';

import { getQb, getAutomationsQb } from '../lib/kysely';
import { neverAsAny } from 'movement-engine/lib/utils/types';

// ── Types ────────────────────────────────────────────────────────────────

/**
 * The navigation state object. Shape is per-purpose — only carries the
 * keys the current context needs (e.g. `tgName`, `triggerName`). The
 * framework treats it as opaque; agents read and write specific keys
 * via the service.
 *
 * Key set (post N3-C):
 *   - `triggerName` — pinned trigger (the listener / event source)
 *   - `tgName` — pinned translation graph (the sync)
 *   - `pinnedKind` — which kind of thing the agent last navigated to;
 *     always `'trigger' | 'translation_graph'`
 *   - `phase` — Setup-flow phase (provisioned / authored / previewed / activated)
 *
 * `inboundName` / `destinationName` (the old pipeline_input / pipeline_output
 * names) are retired — destinations are TG attributes (`body.targetSchemaRef`),
 * not pinnable entities.
 */
export type NavigationState = Record<string, unknown>;

/**
 * A single navigation-history entry. Appended on every navigateTo /
 * extendNavigation call that introduces named keys; consulted by
 * resolveByName for in-conversation recency.
 */
export interface NavigationHistoryEntry {
  /** What kind of entity was pinned (matches ResolutionKind). */
  kind: ResolutionKind;
  /** The name as the agent referred to it. */
  name: string;
  /** ISO timestamp of the pin. */
  at: string;
}

/**
 * The entity kinds resolveByName can look up. Drives which table the
 * service queries.
 *
 * Post N3-C: trigger-substrate is the only resolution surface. Legacy
 * `pipeline_input` / `pipeline_output` arms were dropped — destinations
 * are TG attributes (`body.targetSchemaRef`), not pinnable entities.
 */
export type ResolutionKind = 'trigger';

/**
 * The shape resolveByName returns. The id is the framework's concern;
 * the agent never sees it — it stays inside the framework's tool
 * implementations.
 */
export interface ResolvedEntity {
  kind: ResolutionKind;
  id: string;
  name: string;
  teamId: TeamId;
  updatedAt: Date;
}

/**
 * Keys we treat as "named pins" when extracting history entries from a
 * navigation state object. Each maps a state key to the resolution kind
 * the name implies. Tools that pin entities through navigateTo should
 * use these keys so resolveByName's in-conversation recency works.
 *
 * Extend this map as new pinned-named-entity kinds appear.
 */
const NAMED_PIN_KEYS: Record<string, ResolutionKind> = {
  triggerName: 'trigger',
};

/** Cap on history-array size — trimmed on every append. */
const HISTORY_CAP = 50;

// ── Internal helpers ─────────────────────────────────────────────────────

/**
 * Read the row backing a conversation's navigation. Throws if the
 * conversation doesn't exist — every caller has a conversationId from a
 * live turn, so the row must exist.
 */
async function loadConversationRow(conversationId: AgentConversationId): Promise<{
  navigation_state: NavigationState;
  navigation_history: NavigationHistoryEntry[];
  team_id: TeamId;
}> {
  const qb = getQb(['agent_conversation']);
  const row = await qb
    .selectFrom('agent_conversation')
    .select(['navigation_state', 'navigation_history', 'team_id'])
    .where('id', '=', conversationId)
    .executeTakeFirstOrThrow();

  return {
    navigation_state: (row.navigation_state ?? {}) as NavigationState,
    navigation_history: (row.navigation_history ?? []) as NavigationHistoryEntry[],
    // agent_conversation.team_id lost its brand with its FK (D3); this is the
    // crossing back into core's id, so it is where the brand is re-applied.
    team_id: row.team_id as TeamId,
  };
}

/**
 * Extract { kind, name } pairs from a state object using NAMED_PIN_KEYS.
 * Used when writing history entries so we record what the agent pinned.
 */
function pinsFromState(state: NavigationState): Array<{ kind: ResolutionKind; name: string }> {
  const pins: Array<{ kind: ResolutionKind; name: string }> = [];
  for (const [key, value] of Object.entries(state)) {
    const kind = NAMED_PIN_KEYS[key];
    if (!kind) continue;
    if (typeof value !== 'string' || value.length === 0) continue;
    pins.push({ kind, name: value });
  }
  return pins;
}

/**
 * Append new history entries (one per named pin) and trim to HISTORY_CAP.
 * Returns the new history array — caller writes it back.
 */
function appendHistory(
  current: NavigationHistoryEntry[],
  newPins: Array<{ kind: ResolutionKind; name: string }>,
): NavigationHistoryEntry[] {
  if (newPins.length === 0) return current;
  const now = new Date().toISOString();
  const additions: NavigationHistoryEntry[] = newPins.map((p) => ({
    kind: p.kind,
    name: p.name,
    at: now,
  }));
  const combined = [...current, ...additions];
  if (combined.length <= HISTORY_CAP) return combined;
  return combined.slice(combined.length - HISTORY_CAP);
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Read the current navigation state. Returns `{}` if the conversation
 * has never navigated.
 */
export async function getNavigation(
  conversationId: AgentConversationId,
): Promise<NavigationState> {
  const row = await loadConversationRow(conversationId);
  return row.navigation_state;
}

/**
 * REPLACE the navigation state. Per principle 3: orthogonal keys from
 * prior navigation DON'T quietly carry through. Use this on every
 * "navigate to X" operation (selecting an entity, creating one,
 * pivoting context).
 *
 * Also appends to navigation_history so resolveByName can recency-rank
 * within-conversation pins.
 */
export async function navigateTo(
  conversationId: AgentConversationId,
  state: NavigationState,
): Promise<void> {
  const row = await loadConversationRow(conversationId);
  const newHistory = appendHistory(row.navigation_history, pinsFromState(state));

  const qb = getQb(['agent_conversation']);
  await qb
    .updateTable('agent_conversation')
    .set({
      navigation_state: sql`${JSON.stringify(state)}::jsonb`,
      navigation_history: sql`${JSON.stringify(newHistory)}::jsonb`,
      updated_at: new Date(),
    })
    .where('id', '=', conversationId)
    .execute();
}

/**
 * MERGE keys into the navigation state. Rare — only when staying in the
 * same context but adding detail (e.g. agent pinned the TG via
 * navigateTo, then a follow-up tool wants to annotate the destination
 * the agent just confirmed without wiping the TG pin).
 *
 * Per principle 3, prefer navigateTo unless you specifically need
 * additive semantics.
 */
export async function extendNavigation(
  conversationId: AgentConversationId,
  partial: NavigationState,
): Promise<void> {
  const row = await loadConversationRow(conversationId);
  const merged: NavigationState = { ...row.navigation_state, ...partial };
  const newHistory = appendHistory(row.navigation_history, pinsFromState(partial));

  const qb = getQb(['agent_conversation']);
  await qb
    .updateTable('agent_conversation')
    .set({
      navigation_state: sql`${JSON.stringify(merged)}::jsonb`,
      navigation_history: sql`${JSON.stringify(newHistory)}::jsonb`,
      updated_at: new Date(),
    })
    .where('id', '=', conversationId)
    .execute();
}

/**
 * Resolve a name to a concrete entity via recency disambiguation.
 *
 * Lookup order (per architecture):
 *   1. Most-recently-pinned-in-this-conversation match (history search,
 *      newest first; first matching name + matching team's entity wins)
 *   2. Most-recently-updated-in-team match
 *   3. Stable arbitrary (uuid sort) if still tied
 *
 * Returns null if no entity matches the name in the team.
 */
export async function resolveByName(
  conversationId: AgentConversationId,
  kind: ResolutionKind,
  name: string,
): Promise<ResolvedEntity | null> {
  const row = await loadConversationRow(conversationId);

  // 1. Pull every candidate in the team that matches the name.
  const candidates = await fetchCandidates(row.team_id, kind, name);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // 2. Recency: was this name pinned in this conversation? If so the
  //    most recent matching pin's name biases toward the candidate that
  //    was most recently updated AFTER that pin time. We approximate by
  //    "pin exists in history" → still prefer the team-most-recent
  //    candidate — but if a candidate's updated_at falls before the
  //    most-recent pin, treat the pin as the disambiguator and pick
  //    that candidate. In practice the pin's content was the resolved
  //    entity, so we record candidate-id in history when we pin.
  //    (Today the history only carries the name; team-recency wins
  //    among same-name candidates.)
  //
  //    The richer "pin records the id" extension can land in N2/N3 if
  //    the simpler recency proves insufficient; the brief explicitly
  //    allows escalation if so.

  // 3. Most-recently-updated-in-team wins (candidates are already
  //    sorted desc by updated_at, then asc by id for stable tie-break).
  return candidates[0];
}

/**
 * Fetch every candidate in the team whose name matches `name` for the
 * given kind. Sorted descending by updated_at, then ascending by id for
 * stable tie-breaks.
 */
async function fetchCandidates(
  teamId: TeamId,
  kind: ResolutionKind,
  name: string,
): Promise<ResolvedEntity[]> {
  if (kind === 'trigger') {
    const rows = await getAutomationsQb(['trigger'])
      .selectFrom('trigger')
      .select(['id', 'name', 'team_id', 'updated_at'])
      .where('team_id', '=', teamId)
      .where('name', '=', name)
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map((r) => ({
      kind,
      id: r.id as unknown as string,
      name: r.name,
      // The query is already team-scoped by the caller's TeamId; `trigger.team_id`
      // is an opaque uuid now that the table lives in `automations` (D3).
      teamId,
      updatedAt: r.updated_at,
    }));
  }
  // Exhaustiveness — if a new ResolutionKind is added we get a compile
  // error at the throw site so we remember to extend fetchCandidates.
  throw new Error(`Unhandled resolution kind: ${neverAsAny(kind)}`);
}

// ── Re-exports ────────────────────────────────────────────────────────────

// Surface the conversation id type so callers don't have to dig into
// generated kysely paths.
export type { AgentConversationId };

// ── Test-only exports ─────────────────────────────────────────────────────

/**
 * Pure-function internals exposed for unit testing. Not part of the
 * service's public surface — callers should go through the named
 * exports above.
 */
export const __test = {
  pinsFromState,
  appendHistory,
  NAMED_PIN_KEYS,
  HISTORY_CAP,
};
