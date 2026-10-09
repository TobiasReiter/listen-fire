/**
 * Dev-loop linked-object setup. Bridges a knowledge node to a fake-channels
 * record so the webhook handler's refresh path has something to update.
 *
 *   pnpm dev:link create \
 *     --node-type Deal \
 *     --provider ATTIO \
 *     --object-slug deals \
 *     --record <recordId> \
 *     [--external-object-type Deal]
 *
 * Creates (idempotently) a Deal node in the dev-loop team and a
 * linked_object row pointing it at the given fake-channels record.
 *
 *   pnpm dev:link list                    list all linked_objects on the team
 *   pnpm dev:link delete <linkedObjectId> remove a link
 */
import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';

import { getKnowledgeQb } from '../../lib/kysely';
import { ensureDevLoopTeam } from './_lib';
import { normalizeAdapterType } from '../../services/knowledge_pipeline/output_v3/linked_objects';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = args[i + 1];
  if (!next || next.startsWith('--')) return 'true';
  return next;
}

async function createLink(args: string[]) {
  const nodeTypeName = flag(args, 'node-type');
  const provider = (flag(args, 'provider') ?? 'ATTIO').toUpperCase();
  const objectSlug = flag(args, 'object-slug');
  const recordId = flag(args, 'record');
  const externalObjectType = flag(args, 'external-object-type') ?? nodeTypeName;

  if (!nodeTypeName || !objectSlug || !recordId) {
    throw new Error(
      'Usage: pnpm dev:link create --node-type <name> --object-slug <slug> --record <id> [--provider ATTIO] [--external-object-type <type>]',
    );
  }

  const seed = await ensureDevLoopTeam();
  const teamId = seed.teamId as TeamId;
  const adapterType = normalizeAdapterType(provider);

  // Find the node type
  const nodeType = await getKnowledgeQb(['node_type'])
    .selectFrom('node_type')
    .where('team_id', '=', teamId)
    .where('name', '=', nodeTypeName)
    .select(['id'])
    .executeTakeFirst();
  if (!nodeType) {
    throw new Error(`Node type "${nodeTypeName}" not found on dev-loop team`);
  }

  // Reuse an existing Deal-shaped node if one is already linked to this same
  // (adapter, recordId), otherwise create a fresh node.
  const existingLink = await getKnowledgeQb(['linked_object'])
    .selectFrom('linked_object')
    .where('team_id', '=', teamId)
    .where('adapter_type', '=', adapterType)
    .where('external_id', '=', recordId)
    .select(['id', 'node_id'])
    .executeTakeFirst();
  if (existingLink) {
    return {
      linkedObjectId: existingLink.id,
      nodeId: existingLink.node_id,
      created: false,
    };
  }

  const nodeId = randomUUID();
  await getKnowledgeQb(['node'])
    .insertInto('node')
    .values({
      id: nodeId,
      team_id: teamId,
      node_type_id: nodeType.id as NodeTypeId,
    } as any)
    .execute();

  const linkedId = randomUUID();
  await getKnowledgeQb(['linked_object'])
    .insertInto('linked_object')
    .values({
      id: linkedId,
      team_id: teamId,
      node_id: nodeId,
      adapter_type: adapterType,
      external_id: recordId,
      external_object_type: externalObjectType,
      data: JSON.stringify({}),
    } as any)
    .execute();

  return { linkedObjectId: linkedId, nodeId, nodeTypeName, created: true };
}

async function listLinks() {
  const seed = await ensureDevLoopTeam();
  return getKnowledgeQb(['linked_object', 'node', 'node_type'])
    .selectFrom('linked_object')
    .innerJoin('node', 'node.id', 'linked_object.node_id')
    .innerJoin('node_type', 'node_type.id', 'node.node_type_id')
    .where('linked_object.team_id', '=', seed.teamId as TeamId)
    .select([
      'linked_object.id',
      'node_type.name as nodeType',
      'linked_object.node_id',
      'linked_object.adapter_type',
      'linked_object.external_id',
      'linked_object.external_object_type',
      'linked_object.fetched_at',
    ])
    .orderBy('linked_object.created_at', 'desc')
    .execute();
}

async function deleteLink(id: string) {
  const seed = await ensureDevLoopTeam();
  await getKnowledgeQb(['linked_object'])
    .deleteFrom('linked_object')
    .where('team_id', '=', seed.teamId as TeamId)
    .where('id', '=', id as any)
    .execute();
  return { deleted: id };
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  let result: unknown;
  if (subcommand === 'create') {
    result = await createLink(rest);
  } else if (subcommand === 'list') {
    result = await listLinks();
  } else if (subcommand === 'delete') {
    if (!rest[0] || rest[0].startsWith('--')) {
      console.error('Usage: pnpm dev:link delete <linkedObjectId>');
      process.exit(2);
    }
    result = await deleteLink(rest[0]);
  } else {
    console.error('Usage: pnpm dev:link {create,list,delete}');
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
