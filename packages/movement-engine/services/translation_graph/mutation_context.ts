// Mutation context schema — structured provenance metadata threaded through
// every change in the translation-graph system. Consumed by mutation triggers
// (provenance-aware firing, P7.2) and consolidation (property recalculation,
// in the consolidation-authority child stub plan).

import { z } from 'zod';
import { actorSchema, triggerTypeSchema, type TriggerType } from 'engine-contracts';

// ── Actor: server-asserted identity of who/what produced a change ────────
// Modeled on Attio's actor schema (https://docs.attio.com/docs/actors).
// Substrate for Layer 14.4 actor-based echo recognition (3h §Layer 14.4).
// Server-asserted by the producing system from auth context; never caller-
// asserted via header. Adapters that observe a source system surfacing
// actor info normalize it into this uniform shape; adapters that don't
// leave the field absent (correctness falls to P14.1/P14.2). The actor and
// the trigger taxonomy ride the run's event, so they are the contract's
// (`engine-contracts`).

export { actorSchema, actorTypeSchema, triggerTypeSchema } from 'engine-contracts';
export type { Actor, ActorType, TriggerType } from 'engine-contracts';

// ── Source-of-change classification ────────────────────────────────────────

export const mutationSourceTypeSchema = z.enum([
  'user_edit',
  'extraction',
  'structured_input',
  'api',
  'agent',
]);

export type MutationSourceType = z.infer<typeof mutationSourceTypeSchema>;

// ── MutationSource: who/what produced the change ───────────────────────────

export const mutationSourceSchema = z.object({
  type: mutationSourceTypeSchema,
  // Adapter that observed or produced the change. 'kg' for writes originating
  // within Listen-Fire (user edits, agent operations, direct API).
  adapterType: z.string().optional(),
  // Server-asserted actor that produced this change, when the source system
  // surfaces it. Substrate for Layer 14.4 actor-based echo recognition;
  // correctness falls back to P14.1 (no-op) and P14.2 (circuit breaker)
  // when absent. Never caller-asserted via header.
  actor: actorSchema.optional(),
  // Translation graph that produced this write (when applicable).
  translationGraphId: z.string().optional(),
  // The ActionNode/ExtractionNode `id` field within the translation graph.
  translationGraphNodeId: z.string().optional(),
  // Identity bridge to an external record (when applicable).
  linkedObjectId: z.string().optional(),
  // Pipeline input that fired (when applicable).
  pipelineInputId: z.string().optional(),
  // Trigger type that fired (when applicable).
  triggerType: triggerTypeSchema.optional(),
});

export type MutationSource = z.infer<typeof mutationSourceSchema>;

// ── MutationContext: full provenance + audit metadata ──────────────────────

export const mutationContextSchema = z.object({
  source: mutationSourceSchema,
  // ISO-8601 string for JSONB friendliness; the column is jsonb on knowledge.evidence.
  occurredAt: z.string().datetime(),
  // User / agent / system actor; populated for user_edit and agent sources.
  actorId: z.string().optional(),
});

export type MutationContext = z.infer<typeof mutationContextSchema>;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Construct a MutationContext for a write originating from the Listen-Fire UI / API.
 * For direct database writes that don't go through a translation graph.
 */
export function userEditContext(actorId: string): MutationContext {
  return {
    source: {
      type: 'user_edit',
      adapterType: 'kg',
    },
    occurredAt: new Date().toISOString(),
    actorId,
  };
}

/**
 * Construct a MutationContext for a write originating from an agent operation.
 */
export function agentContext(actorId: string, translationGraphId?: string): MutationContext {
  return {
    source: {
      type: 'agent',
      adapterType: 'kg',
      translationGraphId,
    },
    occurredAt: new Date().toISOString(),
    actorId,
  };
}

/**
 * Construct a MutationContext for a write produced by a translation graph
 * running in the structured-input mode (external system → knowledge graph).
 */
export function structuredInputContext(input: {
  adapterType: string;
  translationGraphId: string;
  translationGraphNodeId: string;
  pipelineInputId: string;
  triggerType: TriggerType;
  linkedObjectId?: string;
}): MutationContext {
  return {
    source: {
      type: 'structured_input',
      ...input,
    },
    occurredAt: new Date().toISOString(),
  };
}

/**
 * Construct a MutationContext for a write produced by an extraction node
 * (LLM-driven expansion within a translation graph).
 */
export function extractionContext(input: {
  adapterType: string;
  translationGraphId: string;
  translationGraphNodeId: string;
  pipelineInputId: string;
  triggerType: TriggerType;
  linkedObjectId?: string;
}): MutationContext {
  return {
    source: {
      type: 'extraction',
      ...input,
    },
    occurredAt: new Date().toISOString(),
  };
}
