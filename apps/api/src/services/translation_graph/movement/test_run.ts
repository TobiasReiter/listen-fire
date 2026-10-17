// Movement test run — the automation-page "Test run".
//
// Fire a SYNTHETIC event at a movement-bound trigger and report what the
// movement WOULD do, without touching any live system. This replaces the
// retired TG `simulate` core (the TG engine is gone): the live executor is
// the movement engine, so the Test run is just `runMovement` with
// `dryRun: true` and a `writeSink` that captures the would-be writes.
//
//   1. Resolve the trigger → its movement row + source adapter slug.
//   2. Invent a realistic inbound payload (an LLM reads the movement's
//      source so the synthetic event matches the fields the movement reads;
//      an optional `seed` biases the scenario). Construction-free: nothing
//      external is contacted to build it.
//   3. Run the movement on the team catalog with `dryRun: true`; the target
//      adapters are wrapped so writes are captured, never performed.
//   4. Return the synthetic event + the captured writes for the UI.
//
//   (Test run rewired off the TG engine onto a movement dry-run)

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { CapturedWrite } from 'movement-engine/public/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';

import { anthropicChat } from '../../../lib/anthropic';
import { runCostCapFromEnv } from 'movement-engine/lib/run_spend';
import { logger } from 'movement-engine/services/logger';
import { runMovement } from 'movement-engine/services/movement_engine/run';
import { resolveAdapterSlug } from '../adapters/registry';
import { resolveAdapter } from '../adapters/resolve';
import { loadTriggerById } from '../storage/tg_table';
import { runCatalogSnapshotForTeam } from './catalog';
import { productionEngineHost } from './engine_host';
import { tenantOfTeam } from './tenant';
import { inMemoryRawTextStore } from './raw_text_store';
import { InMemoryWriteLocks } from 'movement-engine/services/write_locks/write_locks';
import { getMovementRow } from './store';

/** A source field the synthetic payload should be keyed by — pulled from the
 *  source adapter's `describe` so the inventor returns the adapter's own field
 *  ids (the email adapter reads `payload[fieldId]`, not the display name). */
interface SourceField {
  fieldId: string;
  displayName: string;
  description?: string;
}

/** One would-be write the movement produced under dry-run — the
 *  `CapturedWrite` currency, surfaced verbatim to the UI. */
export type MovementTestRunWrite = CapturedWrite;

export type MovementTestRunResult =
  | {
      ok: true;
      /** The synthetic inbound payload we made up — shown to the author so
       *  they can see what the run was fed (the source-side event). */
      event: Record<string, unknown>;
      /** Would-create / would-update / would-link intents, in program order. */
      writes: MovementTestRunWrite[];
      /** Honest gaps surfaced while assembling the run (catalog notes). */
      notes: string[];
    }
  | { ok: false; error: string };

export interface MovementTestRunInput {
  teamId: TeamId;
  /** The `automations.trigger` row to test (already team-scoped by the caller). */
  triggerId: string;
  /** Optional natural-language scenario bias for the synthetic event. */
  seed?: string;
  /** Injected for tests: invent the synthetic payload. Defaults to an
   *  Anthropic-backed generator that reads the movement source + the source
   *  adapter's field descriptors. */
  invent?: (input: {
    source: string;
    fields: SourceField[];
    seed?: string;
  }) => Promise<Record<string, unknown>>;
}

export async function runMovementTestRun(
  input: MovementTestRunInput,
): Promise<MovementTestRunResult> {
  const trigger = await loadTriggerById(input.triggerId);
  if (!trigger) {
    return { ok: false, error: `Automation ${input.triggerId} not found.` };
  }
  if (trigger.movementId === null) {
    return { ok: false, error: 'This automation has no movement to run yet.' };
  }

  const movementRow = await getMovementRow({
    teamId: input.teamId as unknown as string,
    id: trigger.movementId,
  });
  if (!movementRow) {
    return {
      ok: false,
      error: `This automation's movement (${trigger.movementId}) is missing.`,
    };
  }

  // The trigger's kind IS the source adapter slug (Model A); resolve any
  // legacy uppercase channel kind to the canonical slug so the synthetic
  // event's `adapterType` matches the adapter's own identity guard.
  const adapterType = resolveAdapterSlug(trigger.kind);

  // Pull the source type's field descriptors so the inventor keys the
  // synthetic payload by the adapter's OWN field ids — the adapter reads
  // `payload[fieldId]`, not the program's natural display names.
  let sourceFields: SourceField[] = [];
  try {
    sourceFields = await loadSourceFields({
      adapterType,
      teamId: input.teamId,
      credentialsId: trigger.credentialsId ?? undefined,
    });
  } catch (err) {
    // Non-fatal — fall back to a display-name-keyed payload (the inventor
    // still reads the movement source). Logged, never silent.
    logger.warn('[MovementTestRun] could not load source field descriptors', {
      adapterType,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let payload: Record<string, unknown>;
  try {
    const invent = input.invent ?? anthropicInventPayload;
    payload = await invent({
      source: movementRow.source,
      fields: sourceFields,
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't make up a test event: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // A synthetic webhook event — the movement engine seeds the trigger
  // parameter from `payload` for webhook triggers (run.ts:seedEventPosition).
  const event: TriggerEvent = {
    pipelineInputId: `test-run:${input.triggerId}`,
    adapterType,
    triggerType: 'webhook',
    payload,
    occurredAt: new Date().toISOString(),
  };

  let teamCatalog: Awaited<ReturnType<typeof runCatalogSnapshotForTeam>>;
  try {
    teamCatalog = await runCatalogSnapshotForTeam(input.teamId, {
      source: movementRow.source,
      languageVersion: movementRow.languageVersion,
    });
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't assemble the run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const writes: MovementTestRunWrite[] = [];
  try {
    await runMovement({
      source: movementRow.source,
      languageVersion: movementRow.languageVersion,
      ...(trigger.firedMovementName !== null
        ? { movementName: trigger.firedMovementName }
        : {}),
      event,
      teamId: tenantOfTeam(input.teamId),
      costCapMicrodollars: runCostCapFromEnv(),
      catalog: teamCatalog.snapshot,
      credentialIds: teamCatalog.credentialIds,
      // A test run leaves nothing durable behind, its file text included, and
      // captures its writes rather than making them, so it takes no cross-run
      // lock a live firing could wait on.
      host: productionEngineHost({
        teamId: input.teamId,
        rawText: inMemoryRawTextStore(),
        locks: new InMemoryWriteLocks(),
        writeSink: (w) => writes.push(w),
      }),
      dryRun: true,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, event: payload, writes, notes: teamCatalog.notes };
}

// ── Source field descriptors ────────────────────────────────────────────────

/**
 * The source type's writable-or-readable fields, by the adapter's OWN field
 * ids — what a webhook position is keyed by. We read the first readable entry
 * point (the type an inbound event lands as) and project its `describe` fields.
 */
async function loadSourceFields(input: {
  adapterType: string;
  teamId: TeamId;
  credentialsId?: string;
}): Promise<SourceField[]> {
  const adapter = await resolveAdapter({
    adapterType: input.adapterType,
    teamId: input.teamId,
    ...(input.credentialsId !== undefined ? { credentialsId: input.credentialsId } : {}),
  });
  const entries = await adapter.listEntryPoints();
  const rootTypeId = entries.find((e) => e.readable)?.typeId ?? entries[0]?.typeId;
  if (!rootTypeId) return [];
  const descriptor = await adapter.describe(rootTypeId);
  if (!descriptor) return [];
  return descriptor.fields.map((f) => ({
    fieldId: f.fieldId,
    displayName: f.displayName,
    ...(f.description !== undefined ? { description: f.description } : {}),
  }));
}

// ── Synthetic payload generation ────────────────────────────────────────────

const INVENT_SYSTEM =
  'You invent a single realistic example inbound event for a data-automation, ' +
  "so its author can preview what it would do. You are given the automation's " +
  'source (a movement program) and the source system\'s fields (each with an id, ' +
  'a display name, and a description). Read which fields the automation reads from ' +
  'its triggering parameter, then return ONE JSON object keyed by the source ' +
  "system's field IDs (the `id` column, NOT the display name) with believable " +
  'example values. Only include fields the automation actually uses, plus any ' +
  'obviously-needed identifiers. Return JSON ONLY — no prose, no fences.';

/** Default payload inventor — an Anthropic call that reads the movement
 *  source + the source field descriptors so the synthetic event is keyed by
 *  the adapter's own field ids (what a webhook position is read by). */
async function anthropicInventPayload(input: {
  source: string;
  fields: SourceField[];
  seed?: string;
}): Promise<Record<string, unknown>> {
  const fieldList =
    input.fields.length > 0
      ? input.fields
          .map(
            (f) =>
              `- id: ${f.fieldId} · display: ${f.displayName}${f.description ? ` — ${f.description}` : ''}`,
          )
          .join('\n')
      : '(the source system did not publish field descriptors — key by the names the program reads)';
  const parts = [
    input.seed ? `Scenario to base the example on: ${input.seed}` : undefined,
    `Source system fields:\n${fieldList}`,
    `Movement source:\n${input.source}`,
  ].filter((p): p is string => p !== undefined);
  const raw = await anthropicChat({
    system: INVENT_SYSTEM,
    userMessage: parts.join('\n\n'),
    label: 'movement:test-run:invent',
    temperature: 0.7,
  });
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    logger.warn('[MovementTestRun] inventor returned no JSON object; using empty payload', {
      sample: raw.slice(0, 120),
    });
    return {};
  }
  return parsed;
}

/** Tolerate a stray ```json fence or trailing prose around the object. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : t;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const value: unknown = JSON.parse(body.slice(start, end + 1));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
