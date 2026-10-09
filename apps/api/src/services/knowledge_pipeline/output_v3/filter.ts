import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import type { FilterExpression, FilterCondition, FieldRef, Selection } from './schemas';
import type { AdapterResult } from './adapters/types';
import type { OutputExecutionContext } from './resolve';

import { resolveFieldMapping } from './resolve';
import { evaluateExpression } from './evaluate';

interface NodeData {
  properties: Record<string, unknown>;
  edgeProperties: Record<string, unknown>;
  linkedObjects: { adapter: string; actionNodeId: string | null; externalId: string; data: Record<string, unknown> }[];
  _old: Record<string, unknown> | null;
  _oldEdgeProperties: Record<string, unknown> | null;
  _meta: Record<string, unknown> | null;
  _parentResult: AdapterResult | null;
}

// -- Legacy FieldRef resolution (used by resolve.ts for ordering etc.) --

function resolveFieldRef(ref: FieldRef, nodeData: NodeData): unknown {
  switch (ref.type) {
    case 'node_property':
      if (ref.old) return nodeData._old?.[ref.propertyTypeId] ?? null;
      return nodeData.properties[ref.propertyTypeId] ?? null;

    case 'edge_property':
      if (ref.old) return nodeData._oldEdgeProperties?.[ref.propertyTypeId] ?? null;
      return nodeData.edgeProperties[ref.propertyTypeId] ?? null;

    case 'linked_object': {
      const lo = nodeData.linkedObjects.find(
        (l) => l.adapter === ref.adapter && l.actionNodeId === ref.actionNodeId,
      );
      if (!lo) return null;
      if (ref.field === 'external_id') return lo.externalId;
      return lo.data[ref.field] ?? null;
    }

    case 'meta':
      return nodeData._meta?.[ref.key] ?? null;

    case 'parent_result': {
      if (!nodeData._parentResult) return null;
      if (ref.field === 'created') return nodeData._parentResult.created ?? null;
      if (ref.field === 'external_id') return nodeData._parentResult.externalId ?? null;
      return null;
    }
  }
}

// -- Comparison --

function evaluateCondition(actual: unknown, operator: string, expected: unknown): boolean {
  switch (operator) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'exists':
      return (actual != null) === (expected ?? true);
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    default:
      return false;
  }
}

// -- Filter evaluation (async — resolves conditions through the shared field mapping pipeline) --

async function evaluateFilter(
  filter: FilterExpression,
  contextNodeId: NodeId,
  context: OutputExecutionContext,
): Promise<boolean> {
  if ('$and' in filter) {
    for (const sub of filter.$and) {
      if (!(await evaluateFilter(sub, contextNodeId, context))) return false;
    }
    return true;
  }
  if ('$or' in filter) {
    for (const sub of filter.$or) {
      if (await evaluateFilter(sub, contextNodeId, context)) return true;
    }
    return false;
  }
  if ('$not' in filter) {
    return !(await evaluateFilter(filter.$not, contextNodeId, context));
  }

  // Leaf condition
  const condition = filter as FilterCondition;

  // Expression-based condition: the expression itself evaluates to a boolean
  if (condition.expression) {
    const result = await evaluateExpression(condition.expression, {
      nodeIds: [contextNodeId],
      lastEdges: [],
      exec: context,
    });
    return !!result;
  }

  // Legacy path: resolve through the shared field mapping pipeline
  if (!condition.selection || !condition.operator) return false;

  const mapping = {
    targetField: '__condition',
    traversal: condition.traversal,
    selection: condition.selection as Selection,
    aggregation: condition.aggregation,
  };
  const resolved = await resolveFieldMapping(mapping, contextNodeId, context);

  const op = condition.operator!;
  if (condition.aggregation) {
    return evaluateCondition(resolved, op, condition.value);
  }

  const values = Array.isArray(resolved) ? resolved : [resolved];
  return values.some((v) => evaluateCondition(v, op, condition.value));
}

export { evaluateFilter, resolveFieldRef, evaluateCondition };
export type { NodeData };
