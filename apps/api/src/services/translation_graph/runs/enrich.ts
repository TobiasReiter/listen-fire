// trigger_run read-side enrichment. Attaches linked_object-derived display
// metadata (URL, friendly name, external object type) to each entry in
// `applied_action_plans` so the runs UI can render record anchors and
// readable names without each adapter needing to publish a per-record
// URL contract.
//
// linked_object is the canonical store for "what does this external
// record actually look like to humans" — adapters drop `data.name`,
// `data.title`, `data.url` etc. into it as part of the bridge write
// (see ensureBridge / insertLinkedObjectBridge). The TG runs query
// joins back to that data here rather than per-adapter wiring.

import type { TeamId } from '../../../generated/kysely/core/Team';

import { getKnowledgeQb } from '../../../lib/kysely';
import { normalizeAdapterType } from '../../knowledge_pipeline/output_v3/linked_objects';

export interface AppliedActionPlanWire {
  nodeId: string;
  adapterType: string;
  recordType: string;
  created: boolean;
  externalId?: string;
  writtenValues: Record<string, unknown>;
}

export interface EnrichedAppliedActionPlan extends AppliedActionPlanWire {
  /** Friendly name pulled from linked_object.data (`name` / `title` /
   *  first non-URL string). `null` when no bridge exists yet — typical
   *  for dry-run synthesized ids and adapters that don't populate
   *  display data. */
  externalDisplayName: string | null;
  /** Anchor href for the external record, when the bridge holds one. */
  externalUrl: string | null;
  /** `linked_object.external_object_type` — useful when the action's
   *  `recordType` is a generic umbrella (e.g. `attio:object`) and the
   *  bridge carries the resolved object name (e.g. `companies`). */
  externalObjectTypeResolved: string | null;
}

/**
 * Walk the firing rows, parse each row's `applied_action_plans` JSONB
 * array, batch-fetch the relevant linked_object rows in one query, and
 * return a copy of the rows with each plan entry replaced by an
 * `EnrichedAppliedActionPlan`.
 *
 * Empty input or input with no applied plans short-circuits without a
 * DB roundtrip.
 */
export async function enrichWithLinkedObjectData<
  R extends { applied_action_plans: unknown },
>(rows: R[], teamId: TeamId): Promise<(R & { applied_action_plans: EnrichedAppliedActionPlan[] })[]> {
  if (rows.length === 0) return [];

  // 1. Collect distinct (adapter_type, external_id) pairs across all
  //    plans. linked_object stores adapter_type normalised, so we
  //    normalise on the way in for comparison.
  const externalIds = new Set<string>();
  const wantedPairs = new Set<string>();
  for (const row of rows) {
    const plans = parseAppliedPlans(row.applied_action_plans);
    for (const p of plans) {
      if (!p.externalId) continue;
      externalIds.add(p.externalId);
      wantedPairs.add(`${normalizeAdapterType(p.adapterType)}::${p.externalId}`);
    }
  }

  // 2. Fetch matching linked_object rows. We don't push the pair tuple
  //    into Postgres — querying by external_id alone is selective enough
  //    (external IDs are adapter-scoped in practice; the JS filter
  //    removes false-positive cross-adapter hits).
  const loRows = externalIds.size
    ? await getKnowledgeQb(['linked_object'])
        .selectFrom('linked_object')
        .where('team_id', '=', teamId)
        .where('external_id', 'in', Array.from(externalIds))
        .select(['adapter_type', 'external_id', 'external_object_type', 'data'])
        .execute()
    : [];

  const byPair = new Map<
    string,
    { externalObjectType: string | null; data: Record<string, unknown> }
  >();
  for (const lo of loRows) {
    const key = `${lo.adapter_type}::${lo.external_id}`;
    if (!wantedPairs.has(key)) continue;
    byPair.set(key, {
      externalObjectType: lo.external_object_type ?? null,
      data: (lo.data ?? {}) as Record<string, unknown>,
    });
  }

  // 3. Project each row's plans with the enriched fields.
  return rows.map((row) => {
    const plans = parseAppliedPlans(row.applied_action_plans);
    const enriched: EnrichedAppliedActionPlan[] = plans.map((p) => {
      const key = p.externalId
        ? `${normalizeAdapterType(p.adapterType)}::${p.externalId}`
        : null;
      const lo = key ? byPair.get(key) : undefined;
      const data = lo?.data ?? {};
      return {
        ...p,
        externalDisplayName: pickDisplayName(data),
        externalUrl: pickUrl(data),
        externalObjectTypeResolved: lo?.externalObjectType ?? null,
      };
    });
    return { ...row, applied_action_plans: enriched };
  });
}

function parseAppliedPlans(value: unknown): AppliedActionPlanWire[] {
  if (!Array.isArray(value)) return [];
  return value as AppliedActionPlanWire[];
}

function pickDisplayName(data: Record<string, unknown>): string | null {
  // Mirror v3's heuristic: prefer well-known keys, fall back to the first
  // non-URL string value the adapter dropped in. Keeping it lenient lets
  // adapters land display data under their own conventional key
  // (`name`, `title`, `subject`, …) without per-adapter wiring here.
  if (typeof data.name === 'string' && data.name) return data.name;
  if (typeof data.title === 'string' && data.title) return data.title;
  const url = typeof data.url === 'string' ? data.url : undefined;
  for (const v of Object.values(data)) {
    if (typeof v === 'string' && v.length > 0 && v !== url) return v;
  }
  return null;
}

function pickUrl(data: Record<string, unknown>): string | null {
  return typeof data.url === 'string' && data.url ? data.url : null;
}
