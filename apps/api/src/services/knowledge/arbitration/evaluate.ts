// What an arbitration ruling IS: read every source that claimed a value, decide
// which value the property should now hold, and write that decision back through
// the same door every other write goes through.
//
// This used to run inside the write's transaction, from a callback the kg
// adapter handed the store. D42 moved it here — knowledge owns the behaviour
// because knowledge owns its declaration (`property_type.evaluation_strategy`),
// and it runs after the commit because a model call is a network round trip and
// a transaction is not the place to hold one.
//
// The consequence is honest and deliberate: an arbitrated property settles in
// TWO events. The incoming value commits with its candidate recorded, and the
// ruling lands as a second, evidenced, change-logged write (D37f). What the
// property ends up holding is unchanged — the ruling reads the same evidence
// set the in-transaction path read.

import { z } from 'zod';

import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import type { NodeTypeId } from '../../../generated/kysely/knowledge/NodeType';
import type { EdgeId } from '../../../generated/kysely/knowledge/Edge';
import type { PropertyId } from '../../../generated/kysely/knowledge/Property';
import type { TeamId } from '../../../generated/kysely/core/Team';

import EvidenceType from '../../../generated/kysely/knowledge/EvidenceType';
import {
  loadPropertyTypes,
  openKnowledgeStore,
  setProperties,
  type KnowledgeWriteDb,
} from '../../../lib/knowledge/store';
import { knowledgeLlmStructured } from '../../../lib/knowledge/llm';
import { ChangeSource } from '../../../lib/knowledge/changes';

/**
 * Why an arbitration finished. Every one of these is a RESOLVED question — the
 * queue row comes off either way. Only `ruled` writes.
 */
export type ArbitrationOutcome =
  /** The property was deleted between the write and the ruling. */
  | 'gone'
  /** No source has claimed a value, so there is nothing to choose between. */
  | 'no_candidates'
  /** A person edited this. A person's edit outranks any synthesis (the same
   *  short-circuit the in-transaction path had). */
  | 'user_edit'
  /** One source; the value it wrote is already the answer. */
  | 'single_source'
  /** The model read the sources and declined to name a winner. */
  | 'undecided'
  /** A winner was chosen and written. */
  | 'ruled';

const RulingSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  has_conflict: z.boolean(),
  reasoning: z.string(),
});

const RULING_JSON_SCHEMA = {
  type: 'object',
  properties: {
    value: {
      type: ['string', 'number', 'boolean', 'null'],
      description: "The property's value after weighing all the evidence, or null if it cannot be determined.",
    },
    has_conflict: {
      type: 'boolean',
      description: 'Whether the sources materially disagreed about this value.',
    },
    reasoning: {
      type: 'string',
      description: 'One or two sentences on why this value won. Recorded as the ruling\'s provenance.',
    },
  },
  required: ['value', 'has_conflict', 'reasoning'],
} as const;

const SYSTEM_PROMPT = `You decide what a single property of a record should hold, given every piece of evidence that has been recorded for it.

Weigh the evidence into the most accurate CURRENT value. The value must match the property's description and its type — read both carefully. More recent evidence is generally more reliable, but not automatically: a specific, well-sourced older claim beats a vague recent one. Say so when the sources materially disagree.

Answer with the value alone — not a sentence about the value.`;

interface PendingProperty {
  propertyId: PropertyId;
  teamId: TeamId;
  propertyTypeId: string;
  anchor: { kind: 'node'; nodeId: NodeId; nodeTypeId: NodeTypeId } | { kind: 'edge'; edgeId: EdgeId };
}

async function loadPending(
  db: KnowledgeWriteDb,
  input: { teamId: TeamId; propertyId: PropertyId },
): Promise<PendingProperty | null> {
  const row = await db
    .selectFrom('property')
    .where('property.id', '=', input.propertyId)
    .where('property.team_id', '=', input.teamId)
    .select(['property.id', 'property.property_type_id', 'property.node_id', 'property.edge_id'])
    .executeTakeFirst();
  if (!row) return null;

  if (row.node_id) {
    const node = await db
      .selectFrom('node')
      .where('node.id', '=', row.node_id)
      .select(['node.node_type_id'])
      .executeTakeFirst();
    if (!node) return null;
    return {
      propertyId: row.id,
      teamId: input.teamId,
      propertyTypeId: row.property_type_id as string,
      anchor: { kind: 'node', nodeId: row.node_id, nodeTypeId: node.node_type_id },
    };
  }
  if (row.edge_id) {
    return {
      propertyId: row.id,
      teamId: input.teamId,
      propertyTypeId: row.property_type_id as string,
      anchor: { kind: 'edge', edgeId: row.edge_id },
    };
  }
  return null;
}

/**
 * The candidate set: every source that has claimed a value on this property.
 *
 * Past RULINGS are excluded structurally — a verdict is not evidence for the
 * next verdict, and including it would let one synthesis harden into the answer
 * by being restated. That exclusion is the whole reason `arbitration` is its own
 * evidence type rather than a flag on a source type.
 */
async function loadCandidates(
  db: KnowledgeWriteDb,
  input: { teamId: TeamId; propertyId: PropertyId },
) {
  return db
    .selectFrom('evidence')
    .where('evidence.property_id', '=', input.propertyId)
    .where('evidence.team_id', '=', input.teamId)
    .where('evidence.type', '!=', EvidenceType.arbitration)
    .orderBy('evidence.created_at', 'desc')
    .select(['evidence.type', 'evidence.description', 'evidence.created_at'])
    .execute();
}

/**
 * Resolve one queued question. Throws only on failures worth RETRYING (an
 * unreachable model, a write that lost a race); everything else is an outcome.
 */
export async function arbitrateProperty(input: {
  teamId: TeamId;
  propertyId: PropertyId;
}): Promise<{ outcome: ArbitrationOutcome; hasConflict?: boolean }> {
  const db = openKnowledgeStore();

  const pending = await loadPending(db, input);
  if (!pending) return { outcome: 'gone' };

  const candidates = await loadCandidates(db, input);
  if (candidates.length === 0) return { outcome: 'no_candidates' };
  if (candidates.some((c) => c.type === EvidenceType.user_edit)) return { outcome: 'user_edit' };
  if (candidates.length < 2) return { outcome: 'single_source' };

  const propertyTypes = await loadPropertyTypes(db, {
    teamId: input.teamId,
    propertyTypeIds: [pending.propertyTypeId],
  });
  const pt = propertyTypes.get(pending.propertyTypeId);
  if (!pt) return { outcome: 'gone' };

  const ruling = await knowledgeLlmStructured({
    teamId: input.teamId as string,
    purpose: 'knowledge.property_arbitration',
    system: SYSTEM_PROMPT,
    user: [
      `Property: ${pt.name}`,
      `Description: ${pt.description}`,
      `Type: ${pt.value_type}`,
      '',
      'Evidence (most recent first):',
      JSON.stringify(
        candidates.map((c) => ({ description: c.description, recorded_at: c.created_at })),
        null,
        2,
      ),
    ].join('\n'),
    schema: RULING_JSON_SCHEMA as unknown as Record<string, unknown>,
    validator: RulingSchema,
  });

  if (ruling.value === null) return { outcome: 'undecided', hasConflict: ruling.has_conflict };

  await setProperties(db, {
    context: {
      teamId: input.teamId,
      evidenceType: EvidenceType.arbitration,
      changeSource: ChangeSource.pipeline,
      description: ruling.reasoning,
      // The whole point: this write raises no new question (D42).
      arbitrationRuling: true,
    },
    anchor: pending.anchor,
    properties: [{ propertyTypeId: pending.propertyTypeId, value: ruling.value }],
    propertyTypes,
  });

  return { outcome: 'ruled', hasConflict: ruling.has_conflict };
}
