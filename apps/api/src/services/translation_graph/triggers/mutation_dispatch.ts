// Mutation-event dispatcher — given a RecordMutationEvent (emitted from the
// commit hook after a write to the knowledge graph), find translation graphs
// configured to respond to mutations on the affected node type and run them.
//
// Output containers, per `plans/2026-05-10-valuations-knowledge-sync/`: each
// `pipeline_output` row holds an array of `TriggerEntry` records (column
// `translation_graphs` jsonb). Mutation-kind entries are matched by evaluating
// each entry's filter expression against the inbound event — paralleling
// exactly how webhook entries on `pipeline_input` are matched. The legacy
// `pipeline_output.trigger_node_type_id` FK + singular `translation_graph`
// column shape no longer exists; v3 ActionTree-based mutation triggers continue
// to fire through the existing output_v3/triggers.ts pipeline.

import { logger } from '../../logger';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { EvaluationResult } from '../engine/types';
import type { RecordMutationEvent } from './record_mutation_event';
import { findTriggersByKind } from '../storage/tg_table';
import { movementForTrigger, runMovementFiring } from '../movement/execute';
import { runModeGate } from './run_mode';
import type { TriggerEvent } from './types';
import { consultEchoSuppression } from './echo_suppression';
import { resolveAdapter } from '../adapters/resolve';
import { resolveAdapterSlug } from '../adapters/registry';

export interface MutationDispatchInput {
  /** The event produced by the commit hook (or upstream KG-write path). */
  event: RecordMutationEvent;
  /** Team scope. */
  teamId: TeamId;
}

export interface MutationDispatchResult {
  /** TGs that were dispatched (one entry per (output, entry) pair where filter passed). */
  evaluations: Array<{
    pipelineOutputId: string;
    triggerEntryId: string;
    result: EvaluationResult;
  }>;
  /**
   * Movement listeners that fired (`listen to graph { type: "Company" } fire …` —
   * trigger rows carrying `movement_id`). Each ran the canonical text
   * through `runMovementFiring`; events ITS writes emitted were already
   * re-dispatched recursively here (the dispatcher owns the mutation
   * re-dispatch loop for movement firings, since their result shape is
   * the movement engine's, not an `EvaluationResult`).
   */
  movementFirings: Array<{
    triggerId: string;
    movementId: string;
    ok: boolean;
    error?: string;
  }>;
  /** (output, entry) pairs that matched the container but were skipped by provenance-aware firing. */
  skippedByDefaultFilter: Array<{ pipelineOutputId: string; triggerEntryId: string }>;
  /** (output, entry) pairs whose entry-specific filter expression evaluated false. */
  skippedByEntryFilter: Array<{ pipelineOutputId: string; triggerEntryId: string }>;
}

/**
 * Dispatch a KG mutation event to every movement-derived KG_MUTATION trigger
 * whose config matches. Each match fires its movement through the movement
 * engine (`runMovementFiring`); events those firings emit re-dispatch
 * recursively. The legacy non-movement orchestration path
 * (`evaluateTranslationGraph`) retired with the TG engine (kill-tg SD-3a) —
 * the `evaluations` slot on the result is now always empty for KG mutations.
 *
 */
export async function dispatchMutationEvent(input: MutationDispatchInput): Promise<MutationDispatchResult> {
  const evaluations: MutationDispatchResult['evaluations'] = [];
  const movementFirings: MutationDispatchResult['movementFirings'] = [];
  const skippedByDefaultFilter: MutationDispatchResult['skippedByDefaultFilter'] = [];
  const skippedByEntryFilter: MutationDispatchResult['skippedByEntryFilter'] = [];

  // N3-C: trigger-substrate is the only dispatch surface. The N2-R
  // legacy `pipeline_output`-keyed container walk was retired — it
  // resolved to the empty set once `trigger_entry.pipeline_output_id`
  // went away, and kept the dual-resolve fallback coupled to dropped
  // columns. KG_MUTATION triggers carry every mutation-driven binding
  // today.
  await dispatchKgMutationTriggers({
    event: input.event,
    teamId: input.teamId,
    evaluations,
    movementFirings,
    skippedByEntryFilter,
  });

  return { evaluations, movementFirings, skippedByDefaultFilter, skippedByEntryFilter };
}

// ── Trigger-id (KG_MUTATION) dispatch (R, 2026-05-28) ─────────────────────

/**
 * Dispatch a mutation event to every TG bound to a KG_MUTATION trigger on
 * this team. Each trigger carries optional config: `{ node_type_id?:
 * uuid, change_kinds?: ('created'|'updated'|'deleted')[] }`. Triggers
 * whose config rejects the event are skipped before TG eval. Bound TGs
 * are loaded via `loadTriggerEntriesByTriggerIds` (one batched query).
 *
 * Mutation event change_kind comes through as `create | update | delete`;
 * the trigger config uses the `created | updated | deleted` participles
 * (matches the substrate plan's vocabulary). We map between the two at
 * config-match time so authors don't have to mirror the engine's
 * abbreviation.
 *
 */
async function dispatchKgMutationTriggers(input: {
  event: RecordMutationEvent;
  teamId: TeamId;
  evaluations: MutationDispatchResult['evaluations'];
  movementFirings: MutationDispatchResult['movementFirings'];
  skippedByEntryFilter: MutationDispatchResult['skippedByEntryFilter'];
}): Promise<void> {
  const triggers = await findTriggersByKind({
    teamId: input.teamId,
    kinds: ['KG_MUTATION'],
  });
  if (triggers.length === 0) return;

  // The event in the currency a listen is WRITTEN in — resolved through the
  // adapter, lazily, and memoised per CONNECTION rather than per dispatch.
  //
  // The connection is load-bearing, not decoration: an adapter that reaches its
  // system over the network cannot introspect without one, and its failure here
  // is caught (a listen with no name-shaped filter must not pay for a lookup it
  // never asked for). Building the surface without the trigger's own credential
  // therefore does not fail loudly — it resolves every name to `undefined`, and
  // every name-shaped listen silently stops matching. Two triggers on one event
  // can also name different connections, so one shared surface would answer the
  // second from the first's model.
  const surfaces = new Map<string, ReturnType<typeof surfaceEventNames>>();
  const surfaceFor = (trigger: (typeof triggers)[number]) => {
    const adapterSlug = resolveAdapterSlug(trigger.kind);
    const key = `${adapterSlug}::${trigger.credentialsId ?? ''}`;
    let surface = surfaces.get(key);
    if (!surface) {
      surface = surfaceEventNames({
        adapterSlug,
        teamId: input.teamId,
        credentialsId: trigger.credentialsId ?? undefined,
        event: input.event,
      });
      surfaces.set(key, surface);
    }
    return surface;
  };

  const matching: typeof triggers = [];
  for (const t of triggers) {
    if (await mutationTriggerConfigMatches(t.config, input.event, surfaceFor(t))) matching.push(t);
  }
  if (matching.length === 0) return;

  for (const trigger of matching) {
    // The trigger row names its own adapter (its `kind`) and credential — the
    // same two facts the webhook doors read off theirs. Nothing here knows
    // what a knowledge graph is.
    const adapterSlug = resolveAdapterSlug(trigger.kind);
    // run_mode gate (on top of `onlyAuthored`): `off` drops, `dry_run`
    // runs the orchestration with the engine capturing writes instead of
    // committing, `live` dispatches normally.
    const gate = runModeGate(trigger.runMode);
    if (!gate.dispatch) {
      logger.info('[TGMutationDispatch] (trigger-id) dropped: run_mode off', {
        triggerId: trigger.id,
      });
      continue;
    }
    const dryRun = gate.dryRun;

    // ── OPT-IN ECHO-SUPPRESSION (Phase 2) — the 2-way-sync tool, NOT a guard.
    // A `listen to graph { …, suppress_self: true } fire …` opts out of its own
    // writes echoing back. The KG answers "did WE author this change?" from
    // the mutation event's own provenance (structured_input/extraction from a
    // movement = ours; a human user_edit = not ours, fires normally). Default
    // off (no flag) → no consult. Skipped under dry-run.
    if (!dryRun) {
      const sourceAdapter = await resolveAdapter({
        adapterType: adapterSlug,
        teamId: input.teamId,
        ...(trigger.credentialsId !== null ? { credentialsId: trigger.credentialsId } : {}),
      });
      const disposition = await consultEchoSuppression({
        triggerConfig: trigger.config,
        sourceAdapter,
        event: {
          pipelineInputId: `trigger:${trigger.id}`,
          adapterType: adapterSlug,
          triggerType: 'mutation',
          payload: input.event,
          recordId: input.event.recordId,
          changedFields: input.event.changedFields,
          occurredAt: input.event.context.occurredAt,
        },
        triggerId: trigger.id,
      });
      if (disposition.kind === 'suppress') {
        logger.info('[TGMutationDispatch] suppressed as the author\'s own echo (suppress_self)', {
          triggerId: trigger.id,
          reason: disposition.reason,
        });
        // The kg mutation path has no durable trigger_event receipt to mark
        // (the mutation event is in-process), so suppression here is a skip
        // recorded in the log; the firing simply doesn't run.
        continue;
      }
      if (disposition.kind === 'no-op') {
        logger.warn('[TGMutationDispatch] suppress_self on but unanswerable — firing as normal', {
          triggerId: trigger.id,
          note: disposition.note,
        });
      }
    }

    // A movement-derived trigger (`listen to graph { type: "Company" } fire …`)
    // executes its canonical text through the movement engine — the
    // trigger row is purely the dispatch index. The mutation event seeds
    // the movement's event parameter; events the firing's own writes
    // emitted re-dispatch recursively (termination by no-op detection +
    // the circuit breaker).
    //
    // Movement-derived triggers are the ONLY mutation dispatch path now:
    // the legacy non-movement branch (orchestration bindings →
    // `evaluateTranslationGraph`) retired with the TG engine (kill-tg
    // SD-3a). Since `cee6659ab` every trigger is provisioned WITH a
    // `movement_id`, so a `movementId === null` KG_MUTATION trigger is a
    // vestigial pre-movement row — it no longer dispatches anything.
    if (trigger.movementId !== null) {
      await dispatchMovementMutationFiring({
        trigger: { ...trigger, movementId: trigger.movementId, adapterSlug },
        event: input.event,
        teamId: input.teamId,
        dryRun,
        movementFirings: input.movementFirings,
      });
      continue;
    }

    logger.info('[TGMutationDispatch] skipping legacy non-movement KG_MUTATION trigger', {
      triggerId: trigger.id,
    });
  }
}

/**
 * One movement listener's mutation firing: load the canonical text, run it
 * through the movement engine (`runMovementFiring` — failure-contained,
 * trigger_run-recorded), then re-dispatch every mutation event the firing's
 * own writes emitted.
 */
async function dispatchMovementMutationFiring(input: {
  trigger: {
    id: string;
    name: string;
    movementId: string;
    firedMovementName: string | null;
    /** The adapter the trigger row names — what the seeded event is stamped
     *  with, exactly as the webhook doors stamp theirs. */
    adapterSlug: string;
  };
  event: RecordMutationEvent;
  teamId: TeamId;
  dryRun: boolean;
  movementFirings: MutationDispatchResult['movementFirings'];
}): Promise<void> {
  const { trigger } = input;
  const movementRow = await movementForTrigger({
    teamId: input.teamId,
    movementId: trigger.movementId,
  });
  if (!movementRow) {
    logger.warn('[TGMutationDispatch] movement row not found for trigger', {
      triggerId: trigger.id,
      movementId: trigger.movementId,
    });
    input.movementFirings.push({
      triggerId: trigger.id,
      movementId: trigger.movementId,
      ok: false,
      error: `movement ${trigger.movementId} not found`,
    });
    return;
  }

  // The mutation event becomes the firing's trigger event — the engine seeds
  // the movement's parameter from `recordId` (the changed record's stable
  // position; see movement_engine/run.ts seedEventPosition).
  const triggerEvent: TriggerEvent = {
    pipelineInputId: `trigger:${trigger.id}`,
    adapterType: trigger.adapterSlug,
    triggerType: 'mutation',
    payload: input.event,
    recordId: input.event.recordId,
    changedFields: input.event.changedFields,
    occurredAt: input.event.context.occurredAt,
  };

  const firing = await runMovementFiring({
    teamId: input.teamId,
    triggerId: trigger.id,
    triggerName: trigger.name,
    ...(trigger.firedMovementName !== null
      ? { firedMovementName: trigger.firedMovementName }
      : {}),
    movementRow,
    event: triggerEvent,
    recordingTriggerType: 'mutation',
    dryRun: input.dryRun,
  });
  input.movementFirings.push({
    triggerId: trigger.id,
    movementId: trigger.movementId,
    ok: firing.result !== null,
    ...(firing.error !== undefined ? { error: firing.error } : {}),
  });
}

/** The engine's change-kind axis → the platform's uniform `record.*` event
 *  vocabulary — the one namespace a listen's `events:` names (D40). */
const CHANGE_KIND_TO_EVENT: Record<string, string> = {
  create: 'record.created',
  update: 'record.updated',
  delete: 'record.deleted',
};

/** Pre-D40 rows spoke participles in `change_kinds`. */
const CHANGE_KIND_TO_PARTICIPLE: Record<string, string> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
};

/**
 * The event in the SURFACE currency a listen is written in.
 *
 * A listen names the watched type and its properties by NAME — the identity
 * the adapter publishes — while the event carries the store's internal ids.
 * THE ADAPTER owns that mapping, out of its own introspection, so nothing here
 * knows what an ontology is. Both halves are lazy and memoised for the whole
 * dispatch: a listen with no name-shaped filter never pays for either, and ten
 * listeners on one event pay once.
 */
function surfaceEventNames(input: {
  adapterSlug: string;
  teamId: TeamId;
  /** The trigger's own connection. An adapter that reaches its system over the
   *  network needs it to introspect at all. */
  credentialsId?: string;
  event: RecordMutationEvent;
}): { typeName(): Promise<string | undefined>; fieldNames(): Promise<string[]> } {
  const adapter = () =>
    resolveAdapter({
      adapterType: input.adapterSlug,
      teamId: input.teamId,
      credentialsId: input.credentialsId,
    });
  let type: Promise<string | undefined> | undefined;
  let fields: Promise<string[]> | undefined;
  // A failure here must not fail the dispatch — a listen with no name-shaped
  // filter never asked for this lookup. But it must not be SILENT either: an
  // unanswerable name makes every name-shaped listen stop matching, and the
  // only symptom is a listener that never fires. Loud, then degraded.
  const typeName = () =>
    (type ??= (async () => {
      const entries = await (await adapter()).listEntryPoints();
      return entries.find((e) => e.externalId === input.event.nodeTypeId)?.typeId;
    })().catch((err) => {
      logger.error('[TGMutationDispatch] could not name the changed record’s type — name-shaped listens on this event cannot match', {
        adapterSlug: input.adapterSlug,
        teamId: input.teamId,
        nodeTypeId: input.event.nodeTypeId,
        hasConnection: input.credentialsId !== undefined,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }));
  return {
    typeName,
    fieldNames: () =>
      (fields ??= (async () => {
        const name = await typeName();
        if (name === undefined) return [];
        const descriptor = await (await adapter()).describe(name);
        const byId = new Map((descriptor?.fields ?? []).map((f) => [f.fieldId, f.displayName]));
        return input.event.changedFields.flatMap((id) => {
          const displayName = byId.get(id);
          return displayName !== undefined ? [displayName] : [];
        });
      })().catch((err) => {
        logger.error('[TGMutationDispatch] could not name the changed fields — `fields:` filters on this event cannot match', {
          adapterSlug: input.adapterSlug,
          teamId: input.teamId,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      })),
  };
}

/**
 * Does this trigger's routing config accept the event?
 *
 * Two spellings are read, and that is a transition rather than a hedge: a row
 * provisioned before D40 persists the store's own currency (`node_type_id`,
 * participle `change_kinds`, `changed_fields` by id), and a row provisioned
 * after it persists the listen VERBATIM (`type`, `events`, `fields` by name),
 * because the adapter no longer translates a listen's config on the way in.
 * Old rows keep filtering exactly as they did until their movement is re-saved.
 */
async function mutationTriggerConfigMatches(
  rawConfig: unknown,
  event: RecordMutationEvent,
  surface: ReturnType<typeof surfaceEventNames>,
): Promise<boolean> {
  if (!rawConfig || typeof rawConfig !== 'object') return true;
  const config = rawConfig as {
    type?: unknown;
    events?: unknown;
    fields?: unknown;
    node_type_id?: unknown;
    change_kinds?: unknown;
    changed_fields?: unknown;
  };

  if (typeof config.node_type_id === 'string') {
    if (config.node_type_id !== event.nodeTypeId) return false;
  } else if (typeof config.type === 'string') {
    if (config.type !== (await surface.typeName())) return false;
  }

  if (Array.isArray(config.events) && config.events.length > 0) {
    if (!config.events.includes(CHANGE_KIND_TO_EVENT[event.changeKind] ?? event.changeKind)) {
      return false;
    }
  } else if (Array.isArray(config.change_kinds) && config.change_kinds.length > 0) {
    if (
      !config.change_kinds.includes(CHANGE_KIND_TO_PARTICIPLE[event.changeKind] ?? event.changeKind)
    ) {
      return false;
    }
  }

  // Changed-attribute routing (`fields: [domains]`): fire only when the change
  // touched at least one watched property. Deletes carry no changedFields and
  // pass — the watched record disappearing IS a change to its fields.
  if (event.changeKind !== 'delete') {
    const watchedIds = Array.isArray(config.changed_fields)
      ? config.changed_fields.filter((f): f is string => typeof f === 'string')
      : [];
    if (watchedIds.length > 0) {
      if (!watchedIds.some((f) => event.changedFields.includes(f))) return false;
    } else {
      const watchedNames = Array.isArray(config.fields)
        ? config.fields.filter((f): f is string => typeof f === 'string')
        : [];
      if (watchedNames.length > 0) {
        const touched = await surface.fieldNames();
        if (!watchedNames.some((f) => touched.includes(f))) return false;
      }
    }
  }
  return true;
}
