/**
 * Dev-loop knowledge-graph state inspection. Lightweight read-only views
 * over the test-harness team's ontology + nodes + edges, without burning
 * agent tokens.
 *
 *   pnpm dev:graph                       summary: counts by node type,
 *                                        recent nodes/edges
 *   pnpm dev:graph nodes [--type <name>] list nodes (optionally by type)
 *   pnpm dev:graph edges [--type <name>] list edges
 *   pnpm dev:graph node <id>             one node + properties + edges
 *   pnpm dev:graph linked                linked_objects (KG ↔ external)
 *   pnpm dev:graph ontology              node + edge type definitions
 *
 * --pretty for human-readable output, default JSON.
 */
import type { TeamId } from '../../generated/kysely/core/Team';

import { getKnowledgeQb } from '../../lib/kysely';

const TEAM_ID = process.env.TEST_HARNESS_TEAM_ID;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = args[i + 1];
  if (!next || next.startsWith('--')) return 'true';
  return next;
}

async function summary() {
  const teamId = TEAM_ID as TeamId;
  const nodeCounts = await getKnowledgeQb(['node', 'node_type'])
    .selectFrom('node')
    .innerJoin('node_type', 'node_type.id', 'node.node_type_id')
    .where('node.team_id', '=', teamId)
    .select(['node_type.name'])
    .select((eb) => eb.fn.count('node.id').as('count'))
    .groupBy('node_type.name')
    .execute();

  const edgeCounts = await getKnowledgeQb(['edge', 'edge_type'])
    .selectFrom('edge')
    .innerJoin('edge_type', 'edge_type.id', 'edge.edge_type_id')
    .where('edge.team_id', '=', teamId)
    .select(['edge_type.outbound_name'])
    .select((eb) => eb.fn.count('edge.id').as('count'))
    .groupBy('edge_type.outbound_name')
    .execute();

  const recentNodes = await getKnowledgeQb(['node', 'node_type'])
    .selectFrom('node')
    .innerJoin('node_type', 'node_type.id', 'node.node_type_id')
    .where('node.team_id', '=', teamId)
    .select(['node.id', 'node_type.name as type', 'node.created_at'])
    .orderBy('node.created_at', 'desc')
    .limit(10)
    .execute();

  const linkedCount = await getKnowledgeQb(['linked_object'])
    .selectFrom('linked_object')
    .where('team_id', '=', teamId)
    .select((eb) => eb.fn.count('id').as('count'))
    .executeTakeFirst();

  return {
    teamId: TEAM_ID,
    nodes: { total: nodeCounts.reduce((s, r) => s + Number(r.count), 0), byType: nodeCounts },
    edges: { total: edgeCounts.reduce((s, r) => s + Number(r.count), 0), byType: edgeCounts },
    recentNodes,
    linkedObjects: Number(linkedCount?.count ?? 0),
  };
}

async function listNodes(type?: string) {
  const teamId = TEAM_ID as TeamId;
  let q = getKnowledgeQb(['node', 'node_type'])
    .selectFrom('node')
    .innerJoin('node_type', 'node_type.id', 'node.node_type_id')
    .where('node.team_id', '=', teamId);
  if (type) q = q.where('node_type.name', '=', type);
  const rows = await q
    .select(['node.id', 'node_type.name as type', 'node.created_at', 'node.updated_at'])
    .orderBy('node.created_at', 'desc')
    .limit(100)
    .execute();
  return rows;
}

async function listEdges(type?: string) {
  const teamId = TEAM_ID as TeamId;
  let q = getKnowledgeQb(['edge', 'edge_type'])
    .selectFrom('edge')
    .innerJoin('edge_type', 'edge_type.id', 'edge.edge_type_id')
    .where('edge.team_id', '=', teamId);
  if (type) q = q.where('edge_type.outbound_name', '=', type);
  return q
    .select([
      'edge.id',
      'edge_type.outbound_name as type',
      'edge.source_node_id',
      'edge.target_node_id',
      'edge.created_at',
    ])
    .orderBy('edge.created_at', 'desc')
    .limit(100)
    .execute();
}

async function nodeDetail(id: string) {
  const teamId = TEAM_ID as TeamId;
  const node = await getKnowledgeQb(['node', 'node_type'])
    .selectFrom('node')
    .innerJoin('node_type', 'node_type.id', 'node.node_type_id')
    .where('node.team_id', '=', teamId)
    .where('node.id', '=', id as any)
    .select(['node.id', 'node_type.name as type', 'node.created_at', 'node.updated_at'])
    .executeTakeFirst();

  if (!node) return { error: 'not_found', id };

  const properties = await getKnowledgeQb(['property', 'property_type'])
    .selectFrom('property')
    .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
    .where('property.team_id', '=', teamId)
    .where('property.node_id', '=', id as any)
    .select([
      'property_type.name',
      'property.value_text',
      'property.value_number',
      'property.value_date',
      'property.value_boolean',
      'property.updated_at',
    ])
    .execute();

  const outEdges = await getKnowledgeQb(['edge', 'edge_type'])
    .selectFrom('edge')
    .innerJoin('edge_type', 'edge_type.id', 'edge.edge_type_id')
    .where('edge.team_id', '=', teamId)
    .where('edge.source_node_id', '=', id as any)
    .select(['edge.id', 'edge_type.outbound_name as type', 'edge.target_node_id'])
    .execute();

  const inEdges = await getKnowledgeQb(['edge', 'edge_type'])
    .selectFrom('edge')
    .innerJoin('edge_type', 'edge_type.id', 'edge.edge_type_id')
    .where('edge.team_id', '=', teamId)
    .where('edge.target_node_id', '=', id as any)
    .select(['edge.id', 'edge_type.inbound_name as type', 'edge.source_node_id'])
    .execute();

  const linked = await getKnowledgeQb(['linked_object'])
    .selectFrom('linked_object')
    .where('team_id', '=', teamId)
    .where('node_id', '=', id as any)
    .select(['adapter_type', 'external_id', 'external_object_type', 'fetched_at', 'data'])
    .execute();

  return { node, properties, edges: { out: outEdges, in: inEdges }, linkedObjects: linked };
}

async function listLinked() {
  const teamId = TEAM_ID as TeamId;
  return getKnowledgeQb(['linked_object', 'node', 'node_type'])
    .selectFrom('linked_object')
    .innerJoin('node', 'node.id', 'linked_object.node_id')
    .innerJoin('node_type', 'node_type.id', 'node.node_type_id')
    .where('linked_object.team_id', '=', teamId)
    .select([
      'linked_object.id',
      'node_type.name as nodeType',
      'linked_object.node_id',
      'linked_object.adapter_type',
      'linked_object.external_id',
      'linked_object.external_object_type',
      'linked_object.fetched_at',
    ])
    .orderBy('linked_object.fetched_at', 'desc')
    .limit(100)
    .execute();
}

async function ontology() {
  const teamId = TEAM_ID as TeamId;
  const nodeTypes = await getKnowledgeQb(['node_type'])
    .selectFrom('node_type')
    .where('team_id', '=', teamId)
    .select(['id', 'name', 'category', 'description'])
    .orderBy('name')
    .execute();
  const edgeTypes = await getKnowledgeQb(['edge_type', 'node_type'])
    .selectFrom('edge_type as et')
    .leftJoin('node_type as src', 'src.id', 'et.source_node_type_id')
    .leftJoin('node_type as tgt', 'tgt.id', 'et.target_node_type_id')
    .where('et.team_id', '=', teamId)
    .select([
      'et.id',
      'et.outbound_name',
      'et.inbound_name',
      'src.name as source',
      'tgt.name as target',
    ])
    .orderBy('et.outbound_name')
    .execute();
  return { nodeTypes, edgeTypes };
}

async function main() {
  if (!TEAM_ID) {
    console.error('TEST_HARNESS_TEAM_ID not set');
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const subcommand = args[0] && !args[0].startsWith('--') ? args[0] : 'summary';
  const rest = subcommand === args[0] ? args.slice(1) : args;
  const PRETTY = rest.includes('--pretty');

  let result: unknown;
  if (subcommand === 'summary') {
    result = await summary();
  } else if (subcommand === 'nodes') {
    result = await listNodes(flag(rest, 'type'));
  } else if (subcommand === 'edges') {
    result = await listEdges(flag(rest, 'type'));
  } else if (subcommand === 'node') {
    const id = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
    if (!id) {
      console.error('Usage: pnpm dev:graph node <id>');
      process.exit(2);
    }
    result = await nodeDetail(id);
  } else if (subcommand === 'linked') {
    result = await listLinked();
  } else if (subcommand === 'ontology') {
    result = await ontology();
  } else {
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error('Available: summary, nodes, edges, node <id>, linked, ontology');
    process.exit(2);
  }

  console.log(JSON.stringify(result, null, PRETTY ? 2 : 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
