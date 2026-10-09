// W3-A2 — Wave-1 golden-path fixture for integration tests.
//
// NOTE: lives under `harness/` rather than `fixtures/` because the
// `fixtures/` path is `.gitignore`d at the repo root (it's reserved
// for legacy pipeline-recording fixtures).
//
// Minimum seed for the wave-1 golden-path two-investor extraction
// scenario. Bootstraps:
//
//   - A fresh `team` row
//   - Three `node_type` rows (`Opportunity`, `Funding Round`,
//     `Round Participation`)
//   - The `property_type` rows for the fields the worked-example test
//     asserts against (`company`, `summary`, `name`, `stage`, `amount`,
//     `investor_name`, `lead`)
//   - One `edge_type` (`Participants` from Funding Round → Round
//     Participation)
//
// Mirrors the shape of `apps/api/src/scripts/dev/seed-wave-1-golden-path.ts`
// but skips the TG mappings + pipeline_input/trigger_entry — those are
// only needed for end-to-end webhook-driven runs, which require the
// full engine entry point. The worked-example test in this chunk
// targets the batcher → KG-adapter contract directly, so it only
// needs the ontology + a pre-existing anchor node to write against.
//
// Future integration tests (e.g. the full webhook → composition →
// KG-write pipeline) will compose additional fixtures on top of this
// primitive.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import type { PropertyTypeId } from '../../generated/kysely/knowledge/PropertyType';
import type { EdgeTypeId } from '../../generated/kysely/knowledge/EdgeType';

import { getCoreQb, getKnowledgeQb } from '../../lib/kysely';

export interface Wave1GoldenPathSeed {
  teamId: TeamId;
  nodeTypes: {
    /** Source-side message anchor — what the inbound bridge materialises
     *  per W3-B1 (the message-node anchor `applyTarget.anchorNodeId`
     *  points at). */
    dealflowMessage: NodeTypeId;
    opportunity: NodeTypeId;
    fundingRound: NodeTypeId;
    roundParticipation: NodeTypeId;
  };
  propertyTypes: {
    opportunityCompany: PropertyTypeId;
    opportunitySummary: PropertyTypeId;
    fundingRoundName: PropertyTypeId;
    fundingRoundStage: PropertyTypeId;
    fundingRoundAmount: PropertyTypeId;
    roundParticipationInvestorName: PropertyTypeId;
    roundParticipationLead: PropertyTypeId;
    /** W4-KG1 — `writable_by: [user_edit]` so extraction writes are
     *  silently rejected by the KG adapter. */
    opportunityUserOnlyNote: PropertyTypeId;
    /** W4-KG1 — multi-cardinality text so re-extractions set-union
     *  with the existing array rather than overwriting. */
    opportunityTags: PropertyTypeId;
    /** W4-KG1 — `evaluation_strategy: 'llm'` so writes with >1
     *  evidence row trigger LLM synthesis across history. */
    opportunityHeadline: PropertyTypeId;
    /** W4-KG3 — edge-anchored property on the Participants edge
     *  (Funding Round → Round Participation). Authors write this via
     *  an action targeting Round Participation; the KG adapter routes
     *  the write to `property.edge_id` rather than `property.node_id`. */
    participationAmount: PropertyTypeId;
  };
  edgeTypes: {
    participants: EdgeTypeId;
  };
}

/**
 * Seed the wave-1 golden-path ontology against the test DB. Returns
 * stable references to every row the worked-example test asserts
 * against.
 *
 * Idempotency is NOT a requirement here — each test invocation runs
 * inside a clean DB (per-test `cleanupTeam` runs `afterEach`), so the
 * fixture always inserts. Use `cleanupTeam(seed.teamId)` to tear down.
 */
export async function seedWave1GoldenPath(): Promise<Wave1GoldenPathSeed> {
  const teamId = randomUUID() as TeamId;

  // 1. Team row — required as the parent FK for every other write.
  await getCoreQb(['team'])
    .insertInto('team')
    .values({
      id: teamId,
      name: `wave1-golden-path-${teamId.slice(0, 8)}`,
    } as any)
    .execute();

  // 2. Node types.
  const dealflowMessageId = randomUUID() as NodeTypeId;
  const opportunityId = randomUUID() as NodeTypeId;
  const fundingRoundId = randomUUID() as NodeTypeId;
  const roundParticipationId = randomUUID() as NodeTypeId;

  await getKnowledgeQb(['node_type'])
    .insertInto('node_type')
    .values([
      {
        id: dealflowMessageId,
        team_id: teamId,
        name: 'Dealflow Message',
        description: 'Inbound dealflow message — the source-side message anchor.',
        category: 'message',
      },
      {
        id: opportunityId,
        team_id: teamId,
        name: 'Opportunity',
        description: 'Investment opportunity extracted from a dealflow message.',
        category: 'object',
      },
      {
        id: fundingRoundId,
        team_id: teamId,
        name: 'Funding Round',
        description: 'Funding round attached to an opportunity.',
        category: 'object',
      },
      {
        id: roundParticipationId,
        team_id: teamId,
        name: 'Round Participation',
        description: 'Investor participation in a funding round.',
        category: 'object',
      },
    ] as any)
    .execute();

  // 3. Property types.
  const propertyTypes = {
    opportunityCompany: randomUUID() as PropertyTypeId,
    opportunitySummary: randomUUID() as PropertyTypeId,
    fundingRoundName: randomUUID() as PropertyTypeId,
    fundingRoundStage: randomUUID() as PropertyTypeId,
    fundingRoundAmount: randomUUID() as PropertyTypeId,
    roundParticipationInvestorName: randomUUID() as PropertyTypeId,
    roundParticipationLead: randomUUID() as PropertyTypeId,
    opportunityUserOnlyNote: randomUUID() as PropertyTypeId,
    opportunityTags: randomUUID() as PropertyTypeId,
    opportunityHeadline: randomUUID() as PropertyTypeId,
    participationAmount: randomUUID() as PropertyTypeId,
  };

  await getKnowledgeQb(['property_type'])
    .insertInto('property_type')
    .values([
      {
        id: propertyTypes.opportunityCompany,
        team_id: teamId,
        node_type_id: opportunityId,
        name: 'company',
        value_type: 'text',
        identity: 'unique',
        evaluation_strategy: 'latest',
      },
      {
        id: propertyTypes.opportunitySummary,
        team_id: teamId,
        node_type_id: opportunityId,
        name: 'summary',
        value_type: 'text',
        identity: 'none',
        evaluation_strategy: 'latest',
      },
      {
        id: propertyTypes.fundingRoundName,
        team_id: teamId,
        node_type_id: fundingRoundId,
        name: 'name',
        value_type: 'text',
        identity: 'unique',
        evaluation_strategy: 'latest',
      },
      {
        id: propertyTypes.fundingRoundStage,
        team_id: teamId,
        node_type_id: fundingRoundId,
        name: 'stage',
        value_type: 'text',
        identity: 'none',
        evaluation_strategy: 'latest',
      },
      {
        id: propertyTypes.fundingRoundAmount,
        team_id: teamId,
        node_type_id: fundingRoundId,
        name: 'amount',
        value_type: 'number',
        identity: 'none',
        evaluation_strategy: 'latest',
      },
      {
        id: propertyTypes.roundParticipationInvestorName,
        team_id: teamId,
        node_type_id: roundParticipationId,
        name: 'investor_name',
        value_type: 'text',
        identity: 'unique',
        evaluation_strategy: 'latest',
      },
      {
        id: propertyTypes.roundParticipationLead,
        team_id: teamId,
        node_type_id: roundParticipationId,
        name: 'lead',
        value_type: 'boolean',
        identity: 'none',
        evaluation_strategy: 'latest',
      },
      // W4-KG1 — policy-bearing property types. Additive on the
      // Opportunity node type so existing tests assert against the
      // original seven property types unchanged.
      {
        id: propertyTypes.opportunityUserOnlyNote,
        team_id: teamId,
        node_type_id: opportunityId,
        name: 'user_only_note',
        description: 'Free-form note editable only by users — extraction writes are rejected.',
        value_type: 'text',
        identity: 'none',
        evaluation_strategy: 'latest',
        writable_by: ['user_edit'],
      },
      {
        id: propertyTypes.opportunityTags,
        team_id: teamId,
        node_type_id: opportunityId,
        name: 'tags',
        description: 'Multi-valued tag set; re-extractions union with the existing array.',
        value_type: 'text',
        identity: 'none',
        evaluation_strategy: 'latest',
        cardinality: 'multi',
      },
      {
        id: propertyTypes.opportunityHeadline,
        team_id: teamId,
        node_type_id: opportunityId,
        name: 'headline',
        description: 'Short opportunity headline. LLM-synthesised across all extraction evidence.',
        value_type: 'text',
        identity: 'none',
        evaluation_strategy: 'llm',
      },
    ] as any)
    .execute();

  // 4. Edge type — `Participants` (Funding Round → Round Participation).
  const participantsEdgeId = randomUUID() as EdgeTypeId;
  await getKnowledgeQb(['edge_type'])
    .insertInto('edge_type')
    .values([
      {
        id: participantsEdgeId,
        team_id: teamId,
        source_node_type_id: fundingRoundId,
        target_node_type_id: roundParticipationId,
        outbound_name: 'Participants',
        inbound_name: 'Participates In',
        // Default cardinality / scoping etc. covered by schema defaults.
      },
    ] as any)
    .execute();

  // 5. W4-KG3 — edge-anchored property type on the Participants edge.
  // Sits at the edge level rather than the Round Participation node so
  // re-using the same investor across multiple rounds doesn't conflate
  // amounts; identity is the (round, investor) edge tuple.
  await getKnowledgeQb(['property_type'])
    .insertInto('property_type')
    .values([
      {
        id: propertyTypes.participationAmount,
        team_id: teamId,
        edge_type_id: participantsEdgeId,
        name: 'participation_amount',
        description: 'Amount this investor put into the round.',
        value_type: 'number',
        identity: 'none',
        evaluation_strategy: 'latest',
      },
    ] as any)
    .execute();

  return {
    teamId,
    nodeTypes: {
      dealflowMessage: dealflowMessageId,
      opportunity: opportunityId,
      fundingRound: fundingRoundId,
      roundParticipation: roundParticipationId,
    },
    propertyTypes,
    edgeTypes: {
      participants: participantsEdgeId,
    },
  };
}
