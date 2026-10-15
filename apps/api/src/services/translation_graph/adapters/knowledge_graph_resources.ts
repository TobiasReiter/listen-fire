// KG resource persistence (`4d_resources.md`).
//
// Node-level resources ride `WriteInput.resources` and persist as part of the
// record's own write: createKgRecord/updateKgRecord call `persistKgResources`
// once the node exists. This is the per-node persist helper repurposed from
// the retired standalone `writeResource` method.
//
// The persistence is SPLIT along the carve's own line, and deliberately: the
// resource itself is a `public.resource` row, which belongs to this side and is
// resolved here; the LINK from a node to that resource, and the facts extracted
// from it, are knowledge's, and go over the graph's HTTP surface like every
// other write. Nothing here reaches into `knowledge.*` directly any more.
//
// The link now carries the resource's TEXT as well as its id (D43a). It has to
// be resolved on this side — `public.raw_text` is this side's table — and
// knowledge keeps a copy so `node.summary` can quote the source material
// without ever reading back across the boundary. The whole body, or the offset
// slice when the link carries offsets, exactly as the summariser used to
// compute on the fly.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ResourceId } from '../../../generated/kysely/knowledge/Resource';
import type { Resource } from 'movement-engine/services/translation_graph/adapter';
import type { WriteConnection } from './knowledge_graph_writes';

import { getKnowledgeQb } from '../../../lib/kysely';
import ResourceType from '../../../generated/kysely/knowledge/ResourceType';
import { resourceIdSchema } from '../../../lib/resource_id';
import { kgFetch } from './kg_client';


/**
 * Persist node-level resources against a written KG node (`4d_resources.md`).
 * One transactional unit per resource: upsert the `public.resource` row,
 * link it via `node_resource`, and write its `extraction_fact` rows.
 *
 * Idempotent — the resource is resolved by (a) its engine-stamped internal
 * `id`, then (b) `(team, adapter, externalId)`; `node_resource` conflicts are
 * no-ops. So re-delivering the same resource to the same node, or the same
 * resource to multiple nodes across a run, collapses correctly without the
 * engine holding any dedup state (the adapter "dedups on the stable id").
 *
 * Supersedes the standalone `writeResource` method + `applyChangeset` resource
 * loop: resources now ride `WriteInput.resources` and persist as part of the
 * record's own write.
 */
export async function persistKgResources(input: {
  connection: WriteConnection;
  teamId: TeamId;
  nodeId: string;
  resources: Resource[] | undefined;
}): Promise<void> {
  if (!input.resources || input.resources.length === 0) return;
  for (const resource of input.resources) {
    await persistKgResource({
      connection: input.connection,
      teamId: input.teamId,
      nodeId: input.nodeId,
      resource,
    });
  }
}

async function persistKgResource(input: {
  connection: WriteConnection;
  teamId: TeamId;
  nodeId: string;
  resource: Resource;
}): Promise<void> {
  const pqb = getKnowledgeQb(['resource']);

  const { resource } = input;
  const resourceTypeValue = (resource.type ?? 'TEXT') as ResourceType;
  // External provenance: the system the resource's source record lives in,
  // from the structured `provenance` (4d_resources.md).
  const externalAdapterType = resource.provenance?.adapterType ?? null;
  const externalId = resource.externalId ?? null;
  const resourceName = resource.name ?? resource.url ?? resource.externalId ?? 'resource';
  // The structured provenance (source record + field) has no dedicated column;
  // keep it lossless in metadata so "the description of this Attio record" is
  // recoverable.
  const metadata = resource.provenance
    ? { ...(resource.metadata ?? {}), provenance: resource.provenance }
    : resource.metadata ?? {};

  let resolvedId: ResourceId | undefined;
  const ownId = resource.id !== undefined ? resourceIdSchema.parse(resource.id) : undefined;

  if (ownId !== undefined) {
    const byId = await pqb
      .selectFrom('resource')
      .where('resource.id', '=', ownId)
      .select(['resource.id'])
      .executeTakeFirst();
    if (byId) resolvedId = byId.id;
  }

  if (resolvedId === undefined && externalId !== null && externalAdapterType !== null) {
    const byExternal = await pqb
      .selectFrom('resource')
      .where('resource.team_id', '=', input.teamId)
      .where('resource.external_adapter_type', '=', externalAdapterType)
      .where('resource.external_id', '=', externalId)
      .select(['resource.id'])
      .executeTakeFirst();
    if (byExternal) resolvedId = byExternal.id;
  }

  if (resolvedId === undefined) {
    const inserted = await pqb
      .insertInto('resource')
      .values({
        ...(ownId !== undefined ? { id: ownId } : {}),
        team_id: input.teamId,
        type: resourceTypeValue,
        url: resource.url ?? null,
        name: resourceName,
        metadata,
        external_id: externalId,
        external_adapter_type: externalAdapterType,
      })
      .returning(['resource.id'])
      .executeTakeFirstOrThrow();
    resolvedId = inserted.id;
  }

  await kgFetch(input.connection.creds, {
    method: 'POST',
    path: `/nodes/${input.nodeId}/resources`,
    body: {
      resourceId: resolvedId,
      excerpt: await excerptFor(resolvedId),
      facts: (input.resource.facts ?? []).map((fact) => ({
        subject: fact.s,
        predicate: fact.p,
        object: fact.o,
      })),
    },
  });
}

/** The text the link quotes. Null when the resource carries no body (a URL, a
 *  file we never extracted) — the summary then has nothing to quote, which is
 *  what it did before too.
 *
 *  No slicing here: this path posts no offsets, so the link is to the whole
 *  body and the excerpt is the whole body. The endpoint takes offsets and the
 *  backfill honours them, for links made by anything that does supply them. */
async function excerptFor(resourceId: ResourceId): Promise<string | null> {
  const row = await getKnowledgeQb(['resource', 'raw_text'])
    .selectFrom('resource')
    .innerJoin('raw_text', 'raw_text.id', 'resource.raw_text_id')
    .where('resource.id', '=', resourceId)
    .select(['raw_text.content'])
    .executeTakeFirst();
  return row?.content ?? null;
}
