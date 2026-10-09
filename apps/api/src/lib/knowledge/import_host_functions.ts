// The bulk (CSV) import, over the store's write door.
//
// What stays here is the import's own surface: an ontology cache keyed by the
// names a spreadsheet speaks, identity matching, and the per-row error list the
// importer reports back. Every write itself — the `writable_by` gate, value
// coercion, evidence, change rows, transactionality — is the door's (D37).
//
// import application using pipeline patterns

import type { CollectedNode, CollectedEdge } from './import_sandbox';

import { getKnowledgeQb } from '../kysely';
import { TeamId } from '../../generated/kysely/core/Team';
import { NodeId } from '../../generated/kysely/knowledge/Node';
import { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import { PropertyTypeId } from '../../generated/kysely/knowledge/PropertyType';
import EvidenceType from '../../generated/kysely/knowledge/EvidenceType';
import PropertyIdentity from '../../generated/kysely/knowledge/PropertyIdentity';
import {
  createNode,
  link,
  openKnowledgeStore,
  setProperties,
  type PropertyWrite,
  type WriteContext,
} from './store';
import { ChangeSource } from './changes';

/**
 * The import's provenance: `user_edit` evidence, because a spreadsheet is a
 * person asserting facts, and `agent` as the change source, because the import
 * tool is what ran it.
 */
function importContext(teamId: string, description: string): WriteContext {
  return {
    teamId: teamId as TeamId,
    evidenceType: EvidenceType.user_edit,
    changeSource: ChangeSource.agent,
    description,
  };
}

// ---------------------------------------------------------------------------
// Ontology cache (loaded once per import)
// ---------------------------------------------------------------------------

interface PropertyTypeInfo {
  id: string;
  name: string;
  value_type: string;
  identity: string;
  enum_values: unknown;
}

interface OntologyCache {
  nodeTypes: Map<string, { id: string; name: string; category: string }>;
  propertyTypesByNodeType: Map<string, PropertyTypeInfo[]>;
  edgeTypes: Map<string, { id: string; outboundName: string }>;
  edgeTypesByName: Map<string, { id: string; sourceNodeTypeId: string; targetNodeTypeId: string }>;
}

async function loadOntologyCache(teamId: string): Promise<OntologyCache> {
  const [nodeTypesRaw, propertyTypesRaw, edgeTypesRaw] = await Promise.all([
    getKnowledgeQb(['node_type'])
      .selectFrom('node_type')
      .where('team_id', '=', teamId as TeamId)
      .select(['id', 'name', 'category'])
      .execute(),
    getKnowledgeQb(['property_type'])
      .selectFrom('property_type')
      .where('team_id', '=', teamId as TeamId)
      .select(['id', 'name', 'value_type', 'identity', 'enum_values', 'node_type_id'])
      .execute(),
    getKnowledgeQb(['edge_type'])
      .selectFrom('edge_type')
      .where('team_id', '=', teamId as TeamId)
      .select(['id', 'outbound_name', 'source_node_type_id', 'target_node_type_id'])
      .execute(),
  ]);

  const nodeTypes = new Map(nodeTypesRaw.map((nt) => [nt.name, { id: String(nt.id), name: nt.name, category: nt.category }]));

  const propertyTypesByNodeType = new Map<string, PropertyTypeInfo[]>();
  for (const pt of propertyTypesRaw) {
    if (!pt.node_type_id) continue;
    const key = String(pt.node_type_id);
    const list = propertyTypesByNodeType.get(key) ?? [];
    list.push({
      id: String(pt.id),
      name: pt.name,
      value_type: pt.value_type,
      identity: pt.identity,
      enum_values: pt.enum_values,
    });
    propertyTypesByNodeType.set(key, list);
  }

  const edgeTypes = new Map<string, { id: string; outboundName: string }>();
  const edgeTypesByName = new Map<string, { id: string; sourceNodeTypeId: string; targetNodeTypeId: string }>();
  for (const et of edgeTypesRaw) {
    edgeTypes.set(String(et.id), { id: String(et.id), outboundName: et.outbound_name });
    const nameKey = `${et.outbound_name}::${et.source_node_type_id}::${et.target_node_type_id}`;
    edgeTypesByName.set(nameKey, {
      id: String(et.id),
      sourceNodeTypeId: String(et.source_node_type_id),
      targetNodeTypeId: String(et.target_node_type_id),
    });
  }

  return { nodeTypes, propertyTypesByNodeType, edgeTypes, edgeTypesByName };
}

// ---------------------------------------------------------------------------
// Identity-based node matching (reuses same logic as consolidate.ts)
// ---------------------------------------------------------------------------

async function findExistingNode(
  nodeTypeId: string,
  identityProps: Array<{ propertyTypeId: string; value: unknown; identity: string; valueType: string }>,
  teamId: string,
): Promise<NodeId | null> {
  const uniqueProps = identityProps.filter((p) => p.identity === PropertyIdentity.unique);
  if (uniqueProps.length === 0) return null;

  let query = getKnowledgeQb(['node', 'property'])
    .selectFrom('node as n')
    .where('n.team_id', '=', teamId as TeamId)
    .where('n.node_type_id', '=', nodeTypeId as NodeTypeId)
    .select('n.id');

  for (const prop of uniqueProps) {
    const valueColumn =
      prop.valueType === 'number' ? 'p.value_number'
        : prop.valueType === 'date' ? 'p.value_date'
          : prop.valueType === 'boolean' ? 'p.value_boolean'
            : 'p.value_text';

    query = query.where((eb: any) =>
      eb.exists(
        eb.selectFrom('property as p')
          .whereRef('p.node_id', '=', 'n.id')
          .where('p.property_type_id', '=', prop.propertyTypeId as PropertyTypeId)
          .where(valueColumn, '=', String(prop.value)),
      ),
    ) as any;
  }

  const found = await (query as any).executeTakeFirst();
  return found ? (found.id as NodeId) : null;
}

// ---------------------------------------------------------------------------
// Apply import — takes collected sandbox output and writes to DB
// ---------------------------------------------------------------------------

export interface ImportResult {
  nodesCreated: number;
  nodesMatched: number;
  edgesCreated: number;
  edgesSkipped: number;
  propertiesUpserted: number;
  errors: Array<{ message: string }>;
}

export async function applyImport(
  collectedNodes: CollectedNode[],
  collectedEdges: CollectedEdge[],
  teamId: string,
): Promise<ImportResult> {
  const cache = await loadOntologyCache(teamId);
  const result: ImportResult = {
    nodesCreated: 0,
    nodesMatched: 0,
    edgesCreated: 0,
    edgesSkipped: 0,
    propertiesUpserted: 0,
    errors: [],
  };

  // Map from sandbox temp ID → real DB node ID
  const tempToReal = new Map<string, { nodeId: NodeId; nodeTypeId: string; isNew: boolean }>();

  const db = openKnowledgeStore();

  // Process nodes — each node is resolved (match existing or create new) then properties upserted
  for (const collected of collectedNodes) {
    try {
      const nt = cache.nodeTypes.get(collected.type);
      if (!nt) {
        result.errors.push({ message: `Unknown type "${collected.type}". Available: ${[...cache.nodeTypes.keys()].join(', ')}` });
        continue;
      }

      const propertyTypes = cache.propertyTypesByNodeType.get(nt.id) ?? [];
      const ptMap = new Map(propertyTypes.map((pt) => [pt.name, pt]));

      // Build identity property list for matching
      const identityProps = Object.entries(collected.properties)
        .map(([name, value]) => {
          const pt = ptMap.get(name);
          if (!pt || pt.identity === PropertyIdentity.none) return null;
          return { propertyTypeId: pt.id, value, identity: pt.identity, valueType: pt.value_type };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);

      // Try to find existing node
      const existingNodeId = await findExistingNode(nt.id, identityProps, teamId);

      if (existingNodeId) {
        // Matched — upsert properties on the existing node. A column the
        // matched type does not have is not an error here: the row found its
        // node, and the spreadsheet may carry columns for several types.
        tempToReal.set(collected.id, { nodeId: existingNodeId, nodeTypeId: nt.id, isNew: false });
        result.nodesMatched++;

        const writes: PropertyWrite[] = [];
        for (const [propName, propValue] of Object.entries(collected.properties)) {
          if (propValue === null || propValue === undefined) continue;
          const pt = ptMap.get(propName);
          if (!pt) continue;
          writes.push({ propertyTypeId: pt.id, value: propValue });
        }

        const written = await setProperties(db, {
          context: importContext(teamId, 'Updated via bulk import'),
          anchor: { kind: 'node', nodeId: existingNodeId, nodeTypeId: nt.id as NodeTypeId },
          properties: writes,
        });
        result.propertiesUpserted += written.length;
      } else {
        // New node — created with all its properties in one transaction, so a
        // refused cell (D37c) leaves no half-populated row behind.
        const writes: PropertyWrite[] = [];
        for (const [propName, propValue] of Object.entries(collected.properties)) {
          if (propValue === null || propValue === undefined) continue;
          const pt = ptMap.get(propName);
          if (!pt) {
            result.errors.push({ message: `Unknown property "${propName}" on ${collected.type}` });
            continue;
          }
          writes.push({ propertyTypeId: pt.id, value: propValue });
        }

        const { nodeId } = await createNode(db, {
          context: importContext(teamId, 'Imported via bulk import'),
          nodeTypeId: nt.id,
          properties: writes,
        });

        tempToReal.set(collected.id, { nodeId, nodeTypeId: nt.id, isNew: true });
        result.nodesCreated++;
      }
    } catch (err) {
      result.errors.push({ message: `Node "${collected.type}": ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // Process edges
  for (const collected of collectedEdges) {
    try {
      const sourceResolved = tempToReal.get(collected.sourceId);
      const targetResolved = tempToReal.get(collected.targetId);
      if (!sourceResolved || !targetResolved) {
        result.errors.push({ message: `Edge "${collected.type}": source or target node not resolved` });
        continue;
      }

      const etKey = `${collected.type}::${sourceResolved.nodeTypeId}::${targetResolved.nodeTypeId}`;
      const et = cache.edgeTypesByName.get(etKey);
      if (!et) {
        result.errors.push({ message: `No edge type "${collected.type}" between resolved node types` });
        continue;
      }

      // Edge identity is (type, source, target), so asserting one the graph
      // already holds is the skip the import used to spell as a pre-check (D37e).
      const { created } = await link(db, {
        context: importContext(teamId, 'Imported via bulk import'),
        edgeTypeId: et.id,
        sourceNodeId: sourceResolved.nodeId,
        targetNodeId: targetResolved.nodeId,
      });

      if (created) result.edgesCreated++;
      else result.edgesSkipped++;
    } catch (err) {
      result.errors.push({ message: `Edge "${collected.type}": ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  return result;
}
