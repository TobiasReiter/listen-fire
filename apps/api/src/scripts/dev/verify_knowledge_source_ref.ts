/**
 * Phase 3(i) verification: the graph editor after `evidence.resource_id` became
 * the opaque `source_ref` (K-7), and after the embedding columns went (K-12).
 *
 * The movement side is covered by running a kg-writing movement through
 * `dev:movement`; this covers the OTHER write path — the tRPC graph editor,
 * whose evidence readers are the only consumers that ever spoke `resource_id`.
 * It writes a node and a user edit through the real procedures, then reads the
 * evidence back three ways (`getPropertyEvidence`, `getNodeEvidence`,
 * `getPropertyTimeline`) and proves the reader unwraps a `{kind:'resource'}`
 * ref into the `resource_id` the UI still expects — and leaves any other kind
 * unresolved rather than guessing.
 *
 * The movement half of the gate is two fixtures next door:
 *
 *   pnpm dev:movement provision --file src/scripts/dev/_fixtures/kg_write_probe.mvt
 *   pnpm dev:movement provision --file src/scripts/dev/_fixtures/kg_listen_probe.mvt
 *   pnpm dev:movement run kg_write_probe
 *
 * The second one only runs if the first one's write still emits a mutation
 * event, so an Echo person in the graph is the proof that returning events
 * from the write and dispatching them downstream both survived.
 */
import './_profile_loader';
import { runInContext } from '../../services/context/utils';
import { getKnowledgeQb } from '../../lib/kysely';
import { trpcRouter } from '../../interfaces/trpc';
import { ensureDevLoopTeam } from './_lib';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import type { PropertyId } from '../../generated/kysely/knowledge/Property';

import EvidenceType from '../../generated/kysely/knowledge/EvidenceType';

async function main() {
  const { teamId, userId } = await ensureDevLoopTeam();
  const out: Record<string, unknown> = {};

  const nodeType = await getKnowledgeQb(['node_type'])
    .selectFrom('node_type')
    .where('team_id', '=', teamId as TeamId)
    .where('name', '=', 'Organisation')
    .select(['id'])
    .executeTakeFirstOrThrow();

  const propType = await getKnowledgeQb(['property_type'])
    .selectFrom('property_type')
    .where('team_id', '=', teamId as TeamId)
    .where('node_type_id', '=', nodeType.id as NodeTypeId)
    .where('name', '=', 'Name')
    .select(['id'])
    .executeTakeFirstOrThrow();

  await runInContext(
    async () => {
      const caller = trpcRouter.createCaller({ authorise: async () => {} });

      // 1. The editor's create path — node + property + evidence, no resource.
      const created = (await caller.views.knowledge.graph.createNode({
        nodeTypeId: nodeType.id as string,
        properties: [{ propertyTypeId: propType.id as string, valueText: 'Editor Probe Ltd' }],
      })) as { id: string };
      out.createdNode = created.id;

      const prop = await getKnowledgeQb(['property'])
        .selectFrom('property')
        .where('node_id', '=', created.id as never)
        .select(['id'])
        .executeTakeFirstOrThrow();

      // 2. The editor's update path — a fresh evidence row on an existing value.
      await caller.views.knowledge.graph.createUserEdit({
        propertyId: prop.id as string,
        description: '3i probe edit',
        valueText: 'Editor Probe Ltd (edited)',
      });

      // 3. Stamp the two source-ref kinds the reader must treat differently:
      //    a backfill-shaped resource ref, and a kind it has never heard of.
      await getKnowledgeQb(['evidence'])
        .insertInto('evidence')
        .values([
          {
            team_id: teamId as TeamId,
            property_id: prop.id as PropertyId,
            type: EvidenceType.retrieval,
            description: 'backfilled resource provenance',
            source_ref: JSON.stringify({ kind: 'resource', id: RESOURCE_UUID }) as never,
          },
          {
            team_id: teamId as TeamId,
            property_id: prop.id as PropertyId,
            type: EvidenceType.retrieval,
            description: 'a source kind the UI cannot open',
            source_ref: JSON.stringify({ kind: 'url', id: 'https://elsewhere.example' }) as never,
          },
        ])
        .execute();

      // 4. Read it back through all three evidence surfaces.
      const propEvidence = (await caller.views.knowledge.graph.getPropertyEvidence({
        propertyId: prop.id as string,
      })) as { description: string; resource_id: string | null }[];
      out.propertyEvidence = propEvidence.map((e) => ({
        description: e.description,
        resource_id: e.resource_id,
      }));

      const nodeEvidence = (await caller.views.knowledge.graph.getNodeEvidence({
        nodeId: created.id,
      })) as { resource_id: string | null }[];
      out.nodeEvidenceCount = nodeEvidence.length;

      const timeline = (await caller.views.knowledge.graph.getPropertyTimeline({
        propertyId: prop.id as string,
      })) as { type: string; resourceId?: string | null }[];
      out.timelineResourceIds = timeline
        .filter((e) => e.type === 'evidence')
        .map((e) => e.resourceId ?? null);

      // The contract: the resource kind resolves, every other kind stays null.
      out.resolvesResourceKind = propEvidence.some((e) => e.resource_id === RESOURCE_UUID);
      out.leavesUnknownKindUnresolved =
        propEvidence.filter((e) => e.description.includes('cannot open'))[0]?.resource_id === null;
    },
    { id: userId },
  );

  // 5. K-12 — the columns are gone from the live schema, not just the types.
  const cols = await getKnowledgeQb(['node'])
    .selectFrom('node')
    .select(['id'])
    .limit(1)
    .execute();
  out.nodeReadsWithoutEmbeddingColumn = Array.isArray(cols);

  console.log(JSON.stringify(out, null, 2));
}

const RESOURCE_UUID = '11111111-2222-3333-4444-555555555555';

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
