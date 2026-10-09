// Trigger-row lookups.
//
// A `automations.trigger` row is purely the dispatch index for a movement's
// `listen` statement: its `kind` (adapter slug), `config` (routing key /
// mutation filter / event types), optional `credentials_id`, and its
// `movement_id` (the movement whose text executes when it fires). The row
// carries no orchestration / object code — execution reads the canonical
// movement text (services/movement_engine/run.ts).
//
// These helpers are the read surface dispatch uses: resolve a trigger by id
// (inbound + mutation router), find the trigger owning an inbound key, find
// every trigger of a kind (webhook fan-out + KG_MUTATION dispatch), and the
// uniqueness lookup for adapter-declared `unique` config fields.

import { sql } from 'kysely';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

import { getAutomationsQb } from '../../../lib/kysely';
import { parseRunMode, type TriggerRunMode } from '../triggers/run_mode';
import { resolveAdapterSlug, siblingKindsForAdapter } from '../adapters/registry';

/**
 * Load one `trigger` row by id. Returns null when missing. Dispatchers
 * call this when they need the adapter slug / config / credentials.
 */
export async function loadTriggerById(triggerId: string): Promise<{
  id: string;
  teamId: string;
  pipelineConfigurationId: string;
  name: string;
  kind: string;
  config: unknown;
  credentialsId: string | null;
  /** The movement whose `listen` derives this trigger — null for legacy /
   *  orphaned rows. Dispatch routes to the movement engine off this. */
  movementId: string | null;
  /** The movement the `listen … fire <name>` clause runs — handed to the
   *  engine to pick the movement in a multi-movement file. Null = legacy /
   *  single-movement (the engine then requires exactly one declaration). */
  firedMovementName: string | null;
  createdByUserId: string | null;
  runMode: TriggerRunMode;
} | null> {
  const row = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('id', '=', triggerId as TriggerId)
    .select([
      'id',
      'team_id',
      'pipeline_configuration_id',
      'name',
      'kind',
      'config',
      'credentials_id',
      'movement_id',
      'fired_movement_name',
      'created_by_user_id',
      'run_mode',
    ])
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id as unknown as string,
    teamId: row.team_id as unknown as string,
    pipelineConfigurationId: row.pipeline_configuration_id as unknown as string,
    name: row.name,
    kind: row.kind,
    config: row.config,
    credentialsId: (row.credentials_id as unknown as string) ?? null,
    movementId: (row.movement_id as unknown as string) ?? null,
    firedMovementName: (row.fired_movement_name as unknown as string) ?? null,
    createdByUserId: (row.created_by_user_id as unknown as string) ?? null,
    runMode: parseRunMode(row.run_mode),
  };
}

/**
 * Inbound dispatch lookup: find the trigger that owns a given plus-key,
 * scoped to a team and a set of inbound adapter kinds. Returns null when
 * no trigger matches.
 *
 * Model A tolerance (mirrors `findTriggersByKind`): `trigger.kind` is the
 * adapter slug ('email') on newly-provisioned rows, while inbound callers
 * still key on legacy channel kinds ('CUSTOM_EMAIL', 'MAILGUN'); legacy
 * rows have it the other way round. Expand each requested kind to its
 * canonical slug + sibling kinds so both conventions resolve.
 */
export async function findTriggerByInboundKey(input: {
  teamId: string;
  kinds: string[];
  key: string;
}): Promise<{ id: string; kind: string; credentialsId: string | null } | null> {
  if (input.kinds.length === 0) return null;
  const expanded = Array.from(
    new Set(
      input.kinds.flatMap((k) => [
        k,
        resolveAdapterSlug(k),
        ...siblingKindsForAdapter(k),
      ]),
    ),
  );
  const row = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', input.teamId as TeamId)
    .where('kind', 'in', expanded)
    .where(sql`config->>'key'`, '=', input.key)
    .select(['id', 'kind', 'credentials_id'])
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id as unknown as string,
    kind: row.kind,
    credentialsId: (row.credentials_id as unknown as string) ?? null,
  };
}

/**
 * Uniqueness lookup for adapter-declared `unique` config fields: is there
 * another trigger on the team (within the given sibling kinds) whose
 * `config->><fieldKey>` already equals `value`, excluding the trigger
 * being edited? Returns the conflicting trigger id, or null when free.
 *
 * `fieldKey` is interpolated as a bound parameter — it comes from the
 * adapter's own declared schema, never from user input.
 */
export async function findSiblingTriggerByConfigValue(input: {
  teamId: string;
  kinds: string[];
  fieldKey: string;
  value: string;
  excludeTriggerId: string;
}): Promise<{ id: string } | null> {
  if (input.kinds.length === 0) return null;
  const row = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', input.teamId as TeamId)
    .where('kind', 'in', input.kinds)
    .where(sql`config->>${input.fieldKey}`, '=', input.value)
    .where('id', '!=', input.excludeTriggerId as unknown as TriggerId)
    .select(['id'])
    .executeTakeFirst();
  if (!row) return null;
  return { id: row.id as unknown as string };
}

/**
 * Webhook / mutation-side dispatch lookup: find every trigger on a team
 * whose `kind` is in the given set. Used by the webhook handler (to
 * fan out provider-keyed triggers) and the mutation dispatcher (to find
 * `KG_MUTATION` triggers). Caller layers any further filtering on top.
 */
export async function findTriggersByKind(input: {
  teamId: string;
  kinds: string[];
}): Promise<
  Array<{
    id: string;
    name: string;
    kind: string;
    config: unknown;
    credentialsId: string | null;
    runMode: TriggerRunMode;
    /** Set on movement-derived rows — dispatch executes the canonical
     *  text via `runMovementFiring`. */
    movementId: string | null;
    /** The movement the `listen … fire <name>` clause runs — handed to the
     *  engine to pick the movement in a multi-movement file. */
    firedMovementName: string | null;
  }>
> {
  if (input.kinds.length === 0) return [];
  const expanded = Array.from(
    new Set(
      input.kinds.flatMap((k) => [
        k,
        resolveAdapterSlug(k),
        ...siblingKindsForAdapter(k),
      ]),
    ),
  );
  const rows = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', input.teamId as TeamId)
    .where('kind', 'in', expanded)
    .select([
      'id',
      'name',
      'kind',
      'config',
      'credentials_id',
      'run_mode',
      'movement_id',
      'fired_movement_name',
    ])
    .execute();
  return rows.map((r) => ({
    id: r.id as unknown as string,
    name: r.name,
    kind: r.kind,
    config: r.config,
    credentialsId: (r.credentials_id as unknown as string) ?? null,
    runMode: parseRunMode(r.run_mode),
    movementId: (r.movement_id as unknown as string) ?? null,
    firedMovementName: (r.fired_movement_name as unknown as string) ?? null,
  }));
}
