/**
 * Phase 3.i(b) verification: all three graph write paths through one door, and
 * the D37(b) refusal sweep.
 *
 * The door's promise is that the kg adapter, the graph editor and the agent
 * CRUD tools no longer disagree about what a write means. This drives each of
 * them against the seeded dev data and checks the four things that used to
 * differ per caller:
 *
 *   - a `null` write CLEARS (row kept, evidence appended) rather than deleting
 *     the row on one path and nulling it on the others (D37a)
 *   - `writable_by` refuses on every path, loudly (D37b/c) — including the
 *     three procedures that never checked it
 *   - `change` rows land on every path, movement writes included (D37f)
 *   - asserting an edge twice makes one edge (D37e)
 *
 * The sweep half is the deliverable the ruling asked for: every property type
 * whose `writable_by` is restrictive, and which path each restriction now
 * refuses that previously went through. On dev data this is expected to be
 * short or empty; anything it lists is DATA to fix, never code to bypass.
 *
 * The movement half of the gate is the two fixtures next door:
 *
 *   pnpm dev:movement provision --file src/scripts/dev/_fixtures/kg_write_probe.mvt
 *   pnpm dev:movement provision --file src/scripts/dev/_fixtures/kg_listen_probe.mvt
 *   pnpm dev:movement run kg_write_probe
 */
import './_profile_loader';
import { runInContext } from '../../services/context/utils';
import { getKnowledgeQb } from '../../lib/kysely';
import { trpcRouter } from '../../interfaces/trpc';
import { ensureDevLoopTeam } from './_lib';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { NodeId } from '../../generated/kysely/knowledge/Node';
import type { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import type { PropertyTypeId } from '../../generated/kysely/knowledge/PropertyType';

import EvidenceType from '../../generated/kysely/knowledge/EvidenceType';
import PropertyValueType from '../../generated/kysely/knowledge/PropertyValueType';
import PropertyCardinality from '../../generated/kysely/knowledge/PropertyCardinality';
import EvaluationStrategy from '../../generated/kysely/knowledge/EvaluationStrategy';
import PropertyIdentity from '../../generated/kysely/knowledge/PropertyIdentity';
import { createEntity, updateEntity } from '../../lib/knowledge/query_agent_crud';
import { createKgRecord, updateKgRecord, linkKgRecords } from '../../services/translation_graph/adapters/knowledge_graph_writes';

import type { MutationContext } from 'movement-engine/services/translation_graph/mutation_context';

import { getAutomationsQb } from '../../lib/kysely';
import { loadKgCredentials, kgFetch, type WireOntology } from '../../services/translation_graph/adapters/kg_client';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';

const movementContext: MutationContext = {
  source: { type: 'extraction', adapterType: 'kg' },
  occurredAt: new Date().toISOString(),
};

async function main() {
  const { teamId, userId } = await ensureDevLoopTeam();
  const out: Record<string, unknown> = {};
  const team = teamId as TeamId;

  // ── Build the WriteConnection ────────────────────────────────────────────
  const credRow = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', team)
    .where('type', '=', ExternalServiceType.NATIVE_KNOWLEDGE)
    .select(['id'])
    .executeTakeFirstOrThrow();
  const creds = await loadKgCredentials(credRow.id as string);
  const ontology = await kgFetch<WireOntology>(creds, { method: 'GET', path: '/ontology' });
  const writeConnection = { creds, ontology };

  // ── 1. The D37(b) sweep ──────────────────────────────────────────────────
  // A null `writable_by` admits everything; anything else is a restriction the
  // uniform gate now enforces on paths that used to skip it.
  const restricted = await getKnowledgeQb(['property_type', 'node_type', 'edge_type'])
    .selectFrom('property_type as pt')
    .leftJoin('node_type as nt', 'nt.id', 'pt.node_type_id')
    .leftJoin('edge_type as et', 'et.id', 'pt.edge_type_id')
    .where('pt.team_id', '=', team)
    .where('pt.writable_by', 'is not', null)
    .select([
      'pt.id',
      'pt.name',
      'pt.writable_by',
      'nt.name as node_type_name',
      'et.outbound_name as edge_type_name',
    ])
    .execute();

  const admits = (raw: unknown, type: EvidenceType) => {
    const list = Array.isArray(raw)
      ? raw
      : typeof raw === 'string'
        ? raw.replace(/^\{|\}$/g, '').split(',').filter(Boolean)
        : null;
    return list == null || list.includes(type);
  };

  out.writableBySweep = {
    restrictedPropertyTypes: restricted.length,
    // Newly refused on the editor + agent paths: they gate on `user_edit`, and
    // three editor procedures plus the agent's clear never gated at all.
    refusesUserEdit: restricted
      .filter((r) => !admits(r.writable_by, EvidenceType.user_edit))
      .map((r) => ({
        property: `${r.node_type_name ?? r.edge_type_name ?? '?'}.${r.name}`,
        writableBy: r.writable_by,
      })),
    // Newly THROWS rather than silently skipping on the movement path.
    refusesExtraction: restricted
      .filter((r) => !admits(r.writable_by, EvidenceType.extraction))
      .map((r) => ({
        property: `${r.node_type_name ?? r.edge_type_name ?? '?'}.${r.name}`,
        writableBy: r.writable_by,
      })),
  };

  // ── 2. Fixtures ──────────────────────────────────────────────────────────
  const orgType = await getKnowledgeQb(['node_type'])
    .selectFrom('node_type')
    .where('team_id', '=', team)
    .where('name', '=', 'Organisation')
    .select(['id'])
    .executeTakeFirstOrThrow();

  const nameType = await getKnowledgeQb(['property_type'])
    .selectFrom('property_type')
    .where('team_id', '=', team)
    .where('node_type_id', '=', orgType.id as NodeTypeId)
    .where('name', '=', 'Name')
    .select(['id'])
    .executeTakeFirstOrThrow();

  // A property only extraction may write — the refusal case, built rather than
  // borrowed so the probe does not depend on the seed carrying one.
  const lockedName = 'Door Probe Locked';
  await getKnowledgeQb(['property_type'])
    .deleteFrom('property_type')
    .where('team_id', '=', team)
    .where('name', '=', lockedName)
    .execute();
  const locked = await getKnowledgeQb(['property_type'])
    .insertInto('property_type')
    .values({
      team_id: team,
      node_type_id: orgType.id as NodeTypeId,
      name: lockedName,
      description: 'Only extraction may write this',
      value_type: PropertyValueType.text,
      identity: PropertyIdentity.none,
      evaluation_strategy: EvaluationStrategy.latest,
      cardinality: PropertyCardinality.single,
      writable_by: [EvidenceType.extraction],
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  // ── 3. The editor path ───────────────────────────────────────────────────
  await runInContext(
    async () => {
      const caller = trpcRouter.createCaller({ authorise: async () => {} });

      const created = (await caller.views.knowledge.graph.createNode({
        nodeTypeId: orgType.id as string,
        properties: [{ propertyTypeId: nameType.id as string, valueText: 'Door Probe Editor Ltd' }],
      })) as { id: string };
      out.editorNode = created.id;
      out.editorChanges = await changeKinds(team, created.id as NodeId);
      out.editorEvidence = await evidenceCount(team, created.id as NodeId);

      const prop = await getKnowledgeQb(['property'])
        .selectFrom('property')
        .where('node_id', '=', created.id as NodeId)
        .where('property_type_id', '=', nameType.id as PropertyTypeId)
        .select(['id'])
        .executeTakeFirstOrThrow();

      // A clear through the editor keeps the row and its history (D37a).
      await caller.views.knowledge.graph.createUserEdit({
        propertyId: prop.id as string,
        description: 'door probe clear',
        valueText: null,
      });
      const afterClear = await getKnowledgeQb(['property'])
        .selectFrom('property')
        .where('id', '=', prop.id)
        .select(['id', 'value_text'])
        .executeTakeFirst();
      out.editorClearKeepsRow = Boolean(afterClear) && afterClear?.value_text === null;
      out.editorClearEvidence = await evidenceCount(team, created.id as NodeId);

      // The gate now covers createNode's initial properties (it never did).
      out.editorRefusedOnCreate = await refusal(() =>
        caller.views.knowledge.graph.createNode({
          nodeTypeId: orgType.id as string,
          properties: [{ propertyTypeId: locked.id as string, valueText: 'nope' }],
        }),
      );

      // …and edge properties, the other ungated one.
      out.editorRefusedOnProperty = await refusal(() =>
        caller.views.knowledge.graph.createProperty({
          nodeId: created.id,
          propertyTypeId: locked.id as string,
          valueText: 'nope',
        }),
      );
    },
    { id: userId },
  );

  // ── 4. The agent path ────────────────────────────────────────────────────
  const agentNode = await createEntity(
    { typeName: 'Organisation', properties: { Name: 'Door Probe Agent Ltd' } },
    teamId,
  );
  out.agentNode = agentNode.id;
  out.agentChanges = await changeKinds(team, agentNode.id as NodeId);

  await updateEntity({ nodeId: agentNode.id, properties: { Name: null } }, teamId);
  const agentProp = await getKnowledgeQb(['property'])
    .selectFrom('property')
    .where('node_id', '=', agentNode.id as NodeId)
    .where('property_type_id', '=', nameType.id as PropertyTypeId)
    .select(['id', 'value_text'])
    .executeTakeFirst();
  // The behaviour change D37(a) rules: the agent's clear used to delete the row
  // and the evidence with it.
  out.agentClearKeepsRow = Boolean(agentProp) && agentProp?.value_text === null;
  out.agentClearEvidence = await evidenceCount(team, agentNode.id as NodeId);

  out.agentRefused = await refusal(() =>
    updateEntity({ nodeId: agentNode.id, properties: { [lockedName]: 'nope' } }, teamId),
  );

  // ── 5. The movement path ─────────────────────────────────────────────────
  const adapterWrite = await createKgRecord({
    connection: writeConnection,
    teamId: team,
    recordType: orgType.id as string,
    fields: { [nameType.id as string]: 'Door Probe Movement Ltd' },
    mutationContext: movementContext,
  });
  out.movementNode = adapterWrite.externalId;
  // The change feed sees a movement write for the first time (D37f).
  out.movementChanges = await changeKinds(team, adapterWrite.externalId as NodeId);
  out.movementEvidenceCarriesContext = await evidenceHasContext(
    team,
    adapterWrite.externalId as NodeId,
  );

  await updateKgRecord({
    connection: writeConnection,
    teamId: team,
    externalId: adapterWrite.externalId,
    recordType: orgType.id as string,
    fields: { [nameType.id as string]: 'Door Probe Movement Ltd (updated)' },
    mutationContext: movementContext,
  });
  out.movementChangesAfterUpdate = await changeKinds(team, adapterWrite.externalId as NodeId);

  // The adapter's silent skip is gone: a user-edit-only property refuses an
  // extraction write out loud (D37c).
  const userEditOnly = await getKnowledgeQb(['property_type'])
    .insertInto('property_type')
    .values({
      team_id: team,
      node_type_id: orgType.id as NodeTypeId,
      name: 'Door Probe User Only',
      description: 'Only a person may write this',
      value_type: PropertyValueType.text,
      identity: PropertyIdentity.none,
      evaluation_strategy: EvaluationStrategy.latest,
      cardinality: PropertyCardinality.single,
      writable_by: [EvidenceType.user_edit],
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  out.movementRefused = await refusal(() =>
    updateKgRecord({
      connection: writeConnection,
      teamId: team,
      externalId: adapterWrite.externalId,
      recordType: orgType.id as string,
      fields: { [userEditOnly.id as string]: 'nope' },
      mutationContext: movementContext,
    }),
  );

  // ── 6. Edge identity is a set (D37e) ─────────────────────────────────────
  // Any edge type will do; the point is that asserting the same edge twice
  // makes one edge, on a path (the agent's) that used to insert blindly.
  const edgeType = await getKnowledgeQb(['edge_type'])
    .selectFrom('edge_type')
    .where('team_id', '=', team)
    .select(['id', 'outbound_name', 'source_node_type_id', 'target_node_type_id'])
    .executeTakeFirstOrThrow();

  const endpoint = async (nodeTypeId: NodeTypeId, label: string) => {
    const { nodeId } = await createNodeThroughDoor(writeConnection, team, nodeTypeId, label);
    return nodeId;
  };
  const from = await endpoint(edgeType.source_node_type_id, 'Door Probe Link From');
  const to = await endpoint(edgeType.target_node_type_id, 'Door Probe Link To');

  const first = await linkKgRecords({
    connection: writeConnection,
    from: { recordType: edgeType.source_node_type_id as string, externalId: from },
    edgeName: edgeType.outbound_name,
    to: { recordType: edgeType.target_node_type_id as string, externalId: to },
    mutationContext: movementContext,
  });
  const second = await linkKgRecords({
    connection: writeConnection,
    from: { recordType: edgeType.source_node_type_id as string, externalId: from },
    edgeName: edgeType.outbound_name,
    to: { recordType: edgeType.target_node_type_id as string, externalId: to },
    mutationContext: movementContext,
  });
  const edgeRows = await getKnowledgeQb(['edge'])
    .selectFrom('edge')
    .where('team_id', '=', team)
    .where('source_node_id', '=', from)
    .where('target_node_id', '=', to)
    .select(['id'])
    .execute();
  out.linkIsIdempotent = {
    firstCreated: first.created,
    secondCreated: second.created,
    edgesInGraph: edgeRows.length,
  };

  // ── 7. Tidy the probe's ontology additions ───────────────────────────────
  await getKnowledgeQb(['property_type'])
    .deleteFrom('property_type')
    .where('team_id', '=', team)
    .where('id', 'in', [locked.id, userEditOnly.id])
    .execute();

  console.log(JSON.stringify(out, null, 2));
}

/** A bare node create, for endpoints the link probe needs to exist. */
async function createNodeThroughDoor(
  writeConnection: { creds: { apiKey: string; baseUrl: string }; ontology: WireOntology },
  teamId: TeamId,
  nodeTypeId: NodeTypeId,
  label: string,
): Promise<{ nodeId: NodeId }> {
  const result = await createKgRecord({
    connection: writeConnection,
    teamId,
    recordType: nodeTypeId as string,
    fields: {},
    mutationContext: movementContext,
  });
  void label;
  return { nodeId: result.externalId as NodeId };
}

async function changeKinds(teamId: TeamId, nodeId: NodeId): Promise<string[]> {
  const rows = await getKnowledgeQb(['change'])
    .selectFrom('change')
    .where('team_id', '=', teamId)
    .where('node_id', '=', nodeId)
    .select(['kind', 'source'])
    .execute();
  return rows.map((r) => `${r.source}:${r.kind}`).sort();
}

async function evidenceCount(teamId: TeamId, nodeId: NodeId): Promise<number> {
  const rows = await getKnowledgeQb(['evidence', 'property'])
    .selectFrom('evidence')
    .innerJoin('property', 'property.id', 'evidence.property_id')
    .where('evidence.team_id', '=', teamId)
    .where('property.node_id', '=', nodeId)
    .select(['evidence.id'])
    .execute();
  return rows.length;
}

async function evidenceHasContext(teamId: TeamId, nodeId: NodeId): Promise<boolean> {
  const rows = await getKnowledgeQb(['evidence', 'property'])
    .selectFrom('evidence')
    .innerJoin('property', 'property.id', 'evidence.property_id')
    .where('evidence.team_id', '=', teamId)
    .where('property.node_id', '=', nodeId)
    .select(['evidence.mutation_context'])
    .execute();
  return rows.length > 0 && rows.every((r) => r.mutation_context != null);
}

/** Run something that must be refused, and report how it failed. */
async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'NOT REFUSED';
  } catch (err) {
    return (err as Error).message;
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
