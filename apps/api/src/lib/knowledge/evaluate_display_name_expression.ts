// Display-name-context expression evaluator.
// Supports: property, traverse, static, meta (#id), concat, function,
//           conditional, arithmetic, compare, logical, not.
// Does NOT support: llm, edge_property, linked_object, resource,
//                   resource_traverse, parent_result, aggregate.

import type { Expression, TraversalStep } from '#shared/expression/types';

import { getKnowledgeQb } from '../kysely';
import { NodeId } from '../../generated/kysely/knowledge/Node';
import { PropertyTypeId } from '../../generated/kysely/knowledge/PropertyType';
import { EdgeTypeId } from '../../generated/kysely/knowledge/EdgeType';
import PropertyValueType from '../../generated/kysely/knowledge/PropertyValueType';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function formatDate(date: Date): string {
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

interface EvalContext {
  nodeId: string;
}

async function evaluate(expr: Expression, ctx: EvalContext): Promise<unknown> {
  switch (expr.type) {
    case 'property': {
      const row = await getKnowledgeQb(['property', 'property_type'])
        .selectFrom('property')
        .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
        .where('property.node_id', '=', ctx.nodeId as NodeId)
        .where('property.property_type_id', '=', expr.propertyTypeId as PropertyTypeId)
        .select([
          'property.value_text',
          'property.value_number',
          'property.value_date',
          'property.value_boolean',
          'property_type.value_type',
        ])
        .executeTakeFirst();

      if (!row) return null;
      if (row.value_type === PropertyValueType.date && row.value_date) {
        return formatDate(new Date(row.value_date));
      }
      if (row.value_type === PropertyValueType.number && row.value_number != null) {
        return row.value_number;
      }
      if (row.value_type === PropertyValueType.boolean && row.value_boolean != null) {
        return row.value_boolean;
      }
      return row.value_text ?? null;
    }

    case 'static':
      return expr.value;

    case 'meta': {
      if (expr.key === 'id') return ctx.nodeId;
      return null;
    }

    case 'traverse': {
      const targetNodeId = await resolveTraversal(expr.steps, ctx.nodeId);
      if (!targetNodeId) return null;
      return evaluate(expr.expression, { nodeId: targetNodeId });
    }

    case 'concat': {
      const parts: string[] = [];
      for (const part of expr.parts) {
        const val = await evaluate(part, ctx);
        if (val == null) return null;
        parts.push(String(val));
      }
      return parts.join('');
    }

    case 'conditional': {
      const condition = await evaluate(expr.condition, ctx);
      return condition
        ? evaluate(expr.then, ctx)
        : evaluate(expr.else, ctx);
    }

    case 'arithmetic': {
      const [left, right] = await Promise.all([
        evaluate(expr.left, ctx),
        evaluate(expr.right, ctx),
      ]);
      if (left == null || right == null) return null;
      const l = Number(left);
      const r = Number(right);
      if (isNaN(l) || isNaN(r)) return null;
      switch (expr.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? null : l / r;
        case '%': return r === 0 ? null : l % r;
      }
      break;
    }

    case 'compare': {
      const [left, right] = await Promise.all([
        evaluate(expr.left, ctx),
        evaluate(expr.right, ctx),
      ]);
      return evaluateComparison(left, expr.op, right);
    }

    case 'logical': {
      if (expr.op === 'and') {
        for (const operand of expr.operands) {
          const val = await evaluate(operand, ctx);
          if (!val) return false;
        }
        return true;
      }
      for (const operand of expr.operands) {
        const val = await evaluate(operand, ctx);
        if (val) return true;
      }
      return false;
    }

    case 'not': {
      const val = await evaluate(expr.expression, ctx);
      return !val;
    }

    case 'function':
      return evaluateFunction(expr.fn, expr.args, ctx);

    default:
      return null;
  }
}

async function resolveTraversal(steps: TraversalStep[], nodeId: string): Promise<string | null> {
  let currentNodeId = nodeId;

  for (const step of steps) {
    if (step.type !== 'edge') return null;

    if (step.direction === 'outgoing') {
      const row = await getKnowledgeQb(['edge'])
        .selectFrom('edge')
        .where('edge.source_node_id', '=', currentNodeId as NodeId)
        .where('edge.edge_type_id', '=', step.edgeTypeId as EdgeTypeId)
        .orderBy('edge.created_at asc')
        .select('edge.target_node_id')
        .executeTakeFirst();
      if (!row) return null;
      currentNodeId = row.target_node_id;
    } else {
      const row = await getKnowledgeQb(['edge'])
        .selectFrom('edge')
        .where('edge.target_node_id', '=', currentNodeId as NodeId)
        .where('edge.edge_type_id', '=', step.edgeTypeId as EdgeTypeId)
        .orderBy('edge.created_at asc')
        .select('edge.source_node_id')
        .executeTakeFirst();
      if (!row) return null;
      currentNodeId = row.source_node_id;
    }
  }

  return currentNodeId;
}

function evaluateComparison(left: unknown, op: string, right: unknown): boolean {
  if (op === 'eq') return left === right || (left == null && right == null);
  if (op === 'neq') return left !== right;
  if (left == null || right == null) return false;

  const l = typeof left === 'number' ? left : String(left);
  const r = typeof right === 'number' ? right : String(right);

  switch (op) {
    case 'gt': return l > r;
    case 'gte': return l >= r;
    case 'lt': return l < r;
    case 'lte': return l <= r;
    case 'contains': return String(l).includes(String(r));
    case 'exists': return left != null;
    default: return false;
  }
}

async function evaluateFunction(fn: string, args: Expression[], ctx: EvalContext): Promise<unknown> {
  switch (fn) {
    case 'coalesce': {
      for (const arg of args) {
        const val = await evaluate(arg, ctx);
        if (val != null) return val;
      }
      return null;
    }
    case 'isnull': {
      const val = await evaluate(args[0], ctx);
      return val == null;
    }
    case 'trim': {
      const val = await evaluate(args[0], ctx);
      return typeof val === 'string' ? val.trim() : val;
    }
    case 'lower': {
      const val = await evaluate(args[0], ctx);
      return typeof val === 'string' ? val.toLowerCase() : val;
    }
    case 'upper': {
      const val = await evaluate(args[0], ctx);
      return typeof val === 'string' ? val.toUpperCase() : val;
    }
    case 'tostring': {
      const val = await evaluate(args[0], ctx);
      return val == null ? null : String(val);
    }
    default:
      return null;
  }
}

export { evaluate as evaluateDisplayNameExpression };
