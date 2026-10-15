import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { EdgeTypeId } from '../../generated/kysely/knowledge/EdgeType';
import type {
  InputPropertyMapping,
  InputMetadata,
} from '../../adapters/pipeline/inbound/metadata';
import type {
  ExtractedProperty,
  ExtractedEvidence,
  ExtractedNode,
  ExtractedEdge,
  ExtractedSubgraph,
  ExtractionTree,
  ExtractionTreeNode,
  ExtractionTreePropertyDef,
} from './types';

import { execute } from '../../lib/prompts/execute';
import { promptDef } from '../../lib/prompts/definition';
import { logger } from 'movement-engine/services/logger';
import EvidenceType from '../../generated/kysely/knowledge/EvidenceType';
import { inputPropertyMappingSchema } from '../../adapters/pipeline/inbound/metadata';


function coerceToPropertyType(
  raw: string | number | boolean,
  propertyDef: ExtractionTreePropertyDef,
): string | number | boolean | null {
  const { valueType, enumValues } = propertyDef;

  switch (valueType) {
    case 'number': {
      const str = String(raw).trim().replace(/,/g, '');
      const cleaned = str.replace(/^[$£€]/, '').replace(/%$/, '').trim();
      const num = Number(cleaned);
      return isFinite(num) ? num : null;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const str = String(raw).toLowerCase().trim();
      if (['true', 'yes', '1'].includes(str)) return true;
      if (['false', 'no', '0'].includes(str)) return false;
      return null;
    }
    case 'text':
    case 'date':
    default: {
      const str = String(raw);
      if (enumValues?.length) {
        const lower = str.toLowerCase();
        const match = enumValues.find((v) => v.toLowerCase() === lower);
        if (match) return match;
        const normalized = lower.replace(/[_-]/g, ' ');
        const normMatch = enumValues.find(
          (v) => v.toLowerCase().replace(/[_-]/g, ' ') === normalized,
        );
        if (normMatch) return normMatch;
      }
      return str;
    }
  }
}

const inputMappingLlmDef = promptDef({
  description: 'Resolve an input mapping via LLM',
  arguments: ['metadata', 'prompt', 'propertyDescription'] as const,
  messages: [
    {
      role: 'system',
      content:
        'You are extracting a property value from input channel metadata. ' +
        'Respond with ONLY the property value — no explanation, no formatting.',
    },
    {
      role: 'user',
      content: [
        '## Input metadata',
        '```json',
        '{{{metadata}}}',
        '```',
        '',
        '## Target property',
        '{{{propertyDescription}}}',
        '',
        '## Instructions',
        '{{{prompt}}}',
      ].join('\n'),
    },
  ],
  model: 'claude-haiku-4-5-20251001',
});

function parsePropertyMappings(raw: unknown): InputPropertyMapping[] {
  const result = z.array(inputPropertyMappingSchema).safeParse(raw);
  if (!result.success) {
    logger.warn('Invalid property_mappings, ignoring', { error: result.error });
    return [];
  }
  return result.data;
}

// Walk the extraction tree following edge type IDs to find the target node
function walkExtractionTree(
  tree: ExtractionTree,
  edgeTypeIds: string[],
): { propertyDefs: ExtractionTreePropertyDef[]; treeNode: ExtractionTreeNode } | null {
  let children = tree.children;

  for (let i = 0; i < edgeTypeIds.length; i++) {
    const edgeTypeId = edgeTypeIds[i];
    const match = children.find((c) => (c.edgeType.id as string) === edgeTypeId);
    if (!match) return null;

    if (i === edgeTypeIds.length - 1) {
      return { propertyDefs: match.propertyDefs, treeNode: match };
    }
    children = match.children;
  }

  return null;
}

// Find an existing extracted node for a given node type that's connected via the expected edge,
// or create a stub node and edge in the subgraph. Returns the target node's tempId.
function ensureNodeForTraversal(options: {
  subgraph: ExtractedSubgraph;
  tree: ExtractionTree;
  edgeTypeIds: string[];
}): string | null {
  const { subgraph, tree, edgeTypeIds } = options;

  // Empty traversal = message node
  if (edgeTypeIds.length === 0) return subgraph.messageNode.tempId;

  // Walk edge by edge, ensuring each node exists
  let currentTempId = subgraph.messageNode.tempId;
  let children = tree.children;

  for (const edgeTypeId of edgeTypeIds) {
    const treeChild = children.find((c) => (c.edgeType.id as string) === edgeTypeId);
    if (!treeChild) return null;

    // The extraction tree may traverse an edge inversely (e.g. scoping edges,
    // where the scoped child is the canonical edge source and the parent is
    // the canonical target). Orient lookup and stub creation accordingly.
    const childIsSource =
      (treeChild.edgeType.sourceNodeTypeId as string) === (treeChild.nodeType.id as string);

    const existingEdge = subgraph.edges.find((e) =>
      (e.edgeType as string) === edgeTypeId &&
      (childIsSource ? e.targetTempId === currentTempId : e.sourceTempId === currentTempId),
    );

    if (existingEdge) {
      currentTempId = childIsSource ? existingEdge.sourceTempId : existingEdge.targetTempId;
    } else {
      // Create stub node
      const stubTempId = randomUUID();
      const stubNode: ExtractedNode = {
        tempId: stubTempId,
        nodeType: treeChild.nodeType.id,
      };
      subgraph.nodes.push(stubNode);

      // Create edge in canonical (edge_type) orientation
      const [edgeSrc, edgeTgt] = childIsSource
        ? [stubTempId, currentTempId]
        : [currentTempId, stubTempId];
      const stubEdge: ExtractedEdge = {
        sourceTempId: edgeSrc,
        targetTempId: edgeTgt,
        edgeType: edgeTypeId as EdgeTypeId,
      };
      subgraph.edges.push(stubEdge);

      currentTempId = stubTempId;
    }

    children = treeChild.children;
  }

  return currentTempId;
}

async function resolveInputMappings(options: {
  metadata: InputMetadata;
  mappings: InputPropertyMapping[];
  subgraph: ExtractedSubgraph;
  tree: ExtractionTree;
}): Promise<{ properties: ExtractedProperty[]; evidence: ExtractedEvidence[] }> {
  const { metadata, mappings, subgraph, tree } = options;
  const properties: ExtractedProperty[] = [];
  const evidence: ExtractedEvidence[] = [];

  for (const mapping of mappings) {
    const traversalEdgeIds = (mapping.traversal ?? []).map((s) => s.edgeTypeId);
    const isMessageNode = traversalEdgeIds.length === 0;

    // Resolve the target node type ID
    let targetNodeTypeId: string;
    if (isMessageNode) {
      targetNodeTypeId = tree.messageType.id as string;
    } else {
      const target = walkExtractionTree(tree, traversalEdgeIds);
      if (!target) {
        logger.warn('Input mapping traversal does not match extraction tree', {
          traversal: traversalEdgeIds,
        });
        continue;
      }
      targetNodeTypeId = target.treeNode.nodeType.id as string;
    }

    // Use unfiltered property defs so mappings can target properties excluded from LLM extraction
    const propertyDefs = tree.allPropertyDefsByNodeType.get(targetNodeTypeId) ?? [];
    const propertyDefMap = new Map(propertyDefs.map((pd) => [pd.propertyTypeId as string, pd]));
    const propertyDef = propertyDefMap.get(mapping.targetPropertyTypeId);
    if (!propertyDef) {
      logger.warn('Input mapping targets unknown property type', {
        targetPropertyTypeId: mapping.targetPropertyTypeId,
        traversal: traversalEdgeIds,
      });
      continue;
    }

    // Ensure the target node exists in the subgraph (create stub if needed)
    const targetTempId = ensureNodeForTraversal({
      subgraph,
      tree,
      edgeTypeIds: traversalEdgeIds,
    });
    if (!targetTempId) {
      logger.warn('Failed to resolve target node for input mapping traversal', {
        traversal: traversalEdgeIds,
      });
      continue;
    }

    // Resolve source value
    let rawValue: string | number | boolean | null = null;
    let evidenceDescription: string;

    try {
      switch (mapping.source.mode) {
        case 'property': {
          const fieldValue = metadata[mapping.source.fieldKey];
          if (fieldValue === undefined) continue;
          rawValue = fieldValue;
          evidenceDescription = `Input field ${mapping.source.fieldKey}: ${String(fieldValue)}`;
          break;
        }
        case 'static': {
          rawValue = mapping.source.value;
          evidenceDescription = `Static value: ${mapping.source.value}`;
          break;
        }
        case 'llm': {
          const result = await execute('input_mapping_llm', inputMappingLlmDef, {
            metadata: JSON.stringify(metadata, null, 2),
            prompt: mapping.source.prompt,
            propertyDescription: `${propertyDef.name} (${propertyDef.valueType})${propertyDef.description ? ': ' + propertyDef.description : ''}`,
          });
          rawValue = result.trim();
          evidenceDescription = `LLM from input metadata: ${mapping.source.prompt}`;
          break;
        }
      }
    } catch (err) {
      logger.warn('Input mapping resolution failed, skipping', {
        mapping,
        error: err,
      });
      continue;
    }

    if (rawValue == null) continue;

    const coerced = coerceToPropertyType(rawValue, propertyDef);
    if (coerced == null) {
      logger.warn('Input mapping coercion failed', {
        rawValue,
        propertyDef: propertyDef.name,
        valueType: propertyDef.valueType,
      });
      continue;
    }

    // Input mappings are authoritative: remove any LLM-extracted property for the same
    // target node + property type so the input mapping value wins
    for (let i = subgraph.properties.length - 1; i >= 0; i--) {
      const existing = subgraph.properties[i];
      if (
        existing.parentTempId === targetTempId &&
        (existing.propertyTypeId as string) === mapping.targetPropertyTypeId
      ) {
        // Also remove associated evidence
        const existingTempId = existing.tempId;
        for (let j = subgraph.evidence.length - 1; j >= 0; j--) {
          if (subgraph.evidence[j].targetPropertyTempId === existingTempId) {
            subgraph.evidence.splice(j, 1);
          }
        }
        subgraph.properties.splice(i, 1);
      }
    }

    const tempId = randomUUID();
    properties.push({
      tempId,
      propertyTypeId: propertyDef.propertyTypeId,
      parentTempId: targetTempId,
      value: coerced,
      evidenceDescription: evidenceDescription!,
    });
    evidence.push({
      targetPropertyTempId: tempId,
      resourceId: null,
      type: EvidenceType.input_mapping,
      description: evidenceDescription!,
    });
  }

  return { properties, evidence };
}

// Collect all default_property_mappings from the tree, each with its traversal path prepended.
// This flattens the tree's per-node defaults into a single list that resolveInputMappings can process.
function collectDefaultMappings(tree: ExtractionTree): InputPropertyMapping[] {
  const result: InputPropertyMapping[] = [];

  // Root (message node) defaults — traversal is empty
  for (const m of tree.messageDefaultPropertyMappings) {
    result.push({ ...m, traversal: [] });
  }

  function walk(node: ExtractionTreeNode, parentTraversal: { edgeTypeId: string }[]) {
    const traversal = [...parentTraversal, { edgeTypeId: node.edgeType.id as string }];
    for (const m of node.defaultPropertyMappings) {
      // Prepend the path to this node, then append any traversal the mapping itself has
      const mappingTraversal = (m.traversal ?? []);
      result.push({ ...m, traversal: [...traversal, ...mappingTraversal] });
    }
    for (const child of node.children) {
      walk(child, traversal);
    }
  }

  for (const child of tree.children) {
    walk(child, []);
  }

  return result;
}

export { resolveInputMappings, parsePropertyMappings, collectDefaultMappings };
