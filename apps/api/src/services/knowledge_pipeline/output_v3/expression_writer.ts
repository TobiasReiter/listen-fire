// LLM-powered expression writer.
// Gives Claude the same interface a human gets in the formula bar:
// context-aware completions, validation feedback, and incremental typing.
// tool-use approach

import type { Expression } from '#shared/expression/types';

import { anthropicToolLoop } from '../../../lib/anthropic';
import { logger } from 'movement-engine/services/logger';

import {
  serialize,
  parse,
  validate,
  getCompletions,
  type PropertyInfo,
  type EdgeInfo,
  type ValidationResult,
  type Completion,
} from '#shared/expression/formula';

// ── Context: what the LLM needs to know about the schema ──

export interface ExpressionWriterContext {
  intent: string;
  subjectNodeTypeId: string;
  subjectNodeTypeName: string;
  properties: PropertyInfo[];
  edges: EdgeInfo[];
  edgeProperties?: PropertyInfo[];
  targetFieldName?: string;
  targetFieldType?: string;
  targetFieldOptions?: string[];
}

export interface ExpressionWriterResult {
  expression: Expression;
  formula: string;
}

export interface ExpressionWriterError {
  error: string;
  bestAttempt?: string;
}

// ── Tool definitions ──

const TOOLS = [
  {
    type: 'function',
    name: 'validate_expression',
    description: 'Check if a formula is syntactically and semantically valid. Returns validation result with error details and position if invalid.',
    parameters: {
      type: 'object',
      properties: {
        formula: { type: 'string', description: 'The formula text to validate' },
      },
      required: ['formula'],
    },
  },
  {
    type: 'function',
    name: 'get_completions',
    description: 'Get context-aware autocomplete suggestions at a cursor position. Shows what properties, edges, functions, and operators are valid at that point in the formula.',
    parameters: {
      type: 'object',
      properties: {
        formula: { type: 'string', description: 'The formula text so far' },
        cursor_pos: { type: 'number', description: 'Cursor position (0-indexed character offset). Use the end of the formula to see what comes next.' },
      },
      required: ['formula', 'cursor_pos'],
    },
  },
  {
    type: 'function',
    name: 'submit_expression',
    description: 'Submit a formula as the final answer. Only succeeds if the formula is valid.',
    parameters: {
      type: 'object',
      properties: {
        formula: { type: 'string', description: 'The final formula to submit' },
      },
      required: ['formula'],
    },
  },
];

// ── System prompt ──

function buildSystemPrompt(ctx: ExpressionWriterContext): string {
  const propertyList = ctx.properties
    .map(p => {
      let desc = `  - ${p.name}`;
      if (p.valueType) desc += ` (${p.valueType})`;
      if (p.enumValues?.length) desc += ` [options: ${p.enumValues.join(', ')}]`;
      return desc;
    })
    .join('\n');

  const edgeList = ctx.edges
    .map(e => `  - -[:${e.outboundName}]-> (${e.sourceNodeTypeId} → ${e.targetNodeTypeId})` +
      (e.inboundName !== e.outboundName ? ` | inbound: -[:${e.inboundName}]->` : ''))
    .join('\n');

  const targetInfo = ctx.targetFieldName
    ? `\nTarget field: "${ctx.targetFieldName}"` +
      (ctx.targetFieldType ? ` (type: ${ctx.targetFieldType})` : '') +
      (ctx.targetFieldOptions?.length ? `\nAllowed values: ${ctx.targetFieldOptions.join(', ')}` : '')
    : '';

  return `You are an expression formula writer for a knowledge graph output system.

Your job is to write a formula expression that satisfies the user's intent.

## Formula syntax

The formula language supports:
- Property references: \`Property Name\` or PropertyName (backtick-quote names with spaces)
- Traversals: -[:EdgeName]->.PropertyName (walk an edge, read a property at the destination)
- Chained traversals: -[:Edge1]->-[:Edge2]->.Property
- Comparisons: Property = "value", Amount > 100, Status EXISTS
- Arithmetic: Amount * 1000, Price + Tax
- Logic: condition1 AND condition2, condition1 OR condition2, NOT condition
- Conditionals: IF condition THEN value ELSE other_value END
- Functions: CONCAT(a, b), COALESCE(a, b), TRIM(x), LOWER(x), UPPER(x), ISNULL(x)
- Aggregations: FIRST(expr), JOIN(expr, ", "), SUM(expr), COUNT(expr), AVG(expr)
- AI extraction: AI("prompt describing what to extract")
- Special variables: @user_name, @current_date, @parent.created, @parent.external_id
- Resource access: -[#resources WHERE type = "FILE"]->.url
- Linked objects: -[#linked WHERE type = "ATTIO"]->.external_id

## Available schema

Subject node type: ${ctx.subjectNodeTypeName}

Properties on this node type:
${propertyList || '  (none)'}

Edges from/to this node type:
${edgeList || '  (none)'}
${targetInfo}

## Instructions

1. Use the tools to explore and validate your formula
2. Use get_completions to discover what properties/edges are available (especially after traversals — destination properties may differ)
3. Use validate_expression to check your formula before submitting
4. Use submit_expression when you have a valid formula

Write the simplest expression that satisfies the user's intent. Prefer direct property access over traversals when possible.`;
}

// ── Name resolution helpers ──

function buildResolvers(ctx: ExpressionWriterContext) {
  const propByName = new Map(ctx.properties.map(p => [p.name.toLowerCase(), p.id]));
  const edgePropByName = new Map((ctx.edgeProperties ?? []).map(p => [p.name.toLowerCase(), p.id]));

  const edgeByName = new Map<string, string>();
  const edgeWithDirection = new Map<string, { id: string; direction: 'outgoing' | 'incoming' }>();
  for (const e of ctx.edges) {
    edgeByName.set(e.outboundName.toLowerCase(), e.id);
    edgeByName.set(e.inboundName.toLowerCase(), e.id);
    edgeWithDirection.set(e.outboundName.toLowerCase(), { id: e.id, direction: 'outgoing' });
    edgeWithDirection.set(e.inboundName.toLowerCase(), { id: e.id, direction: 'incoming' });
  }

  const resolveProperty = (name: string) => propByName.get(name.toLowerCase());
  const resolveEdgeProperty = (name: string) => edgePropByName.get(name.toLowerCase());
  const resolveEdge = (name: string) => edgeByName.get(name.toLowerCase());
  const resolveEdgeWithDirection = (name: string) => edgeWithDirection.get(name.toLowerCase());

  const resolveId = (id: string, isEdge?: boolean) => {
    if (isEdge) {
      for (const e of ctx.edges) {
        if (e.id === id) return e.outboundName;
      }
      for (const p of ctx.edgeProperties ?? []) {
        if (p.id === id) return p.name;
      }
      return id;
    }
    for (const p of ctx.properties) {
      if (p.id === id) return p.name;
    }
    return id;
  };

  return { resolveProperty, resolveEdgeProperty, resolveEdge, resolveEdgeWithDirection, resolveId };
}

// ── Main entry point ──

export async function writeExpression(
  ctx: ExpressionWriterContext,
  options?: { signal?: AbortSignal; maxTurns?: number },
): Promise<ExpressionWriterResult | ExpressionWriterError> {
  const { resolveProperty, resolveEdgeProperty, resolveEdge, resolveEdgeWithDirection, resolveId } = buildResolvers(ctx);
  const maxTurns = options?.maxTurns ?? 10;

  let lastValidFormula: string | undefined;
  let submitted = false;
  let submittedExpression: Expression | undefined;
  let submittedFormula: string | undefined;

  const toolImpls: Record<string, (args: any) => Promise<any>> = {
    async validate_expression(args: { formula: string }) {
      const result = validateFormula(args.formula);
      if (result.valid && result.expression) {
        lastValidFormula = args.formula;
      }
      return result;
    },

    async get_completions(args: { formula: string; cursor_pos: number }) {
      const completions = getCompletions(
        args.formula,
        args.cursor_pos,
        ctx.properties,
        ctx.edges,
        ctx.subjectNodeTypeId,
        ctx.edgeProperties,
        ctx.targetFieldOptions,
      );
      return completions.slice(0, 30).map(c => ({
        label: c.label,
        insert: c.insert,
        kind: c.kind,
      }));
    },

    async submit_expression(args: { formula: string }) {
      const result = validateFormula(args.formula);
      if (!result.valid) {
        return { success: false, error: result.error, errorPos: result.errorPos };
      }
      submitted = true;
      submittedExpression = result.expression;
      submittedFormula = args.formula;
      return { success: true };
    },
  };

  function validateFormula(formula: string): ValidationResult {
    return validate(
      formula,
      resolveProperty,
      resolveEdgeProperty,
      resolveEdge,
      undefined,
      resolveEdgeWithDirection,
      undefined,
      ctx.properties,
      ctx.edges,
    );
  }

  try {
    await anthropicToolLoop(
      {
        model: 'claude-sonnet-5',
        system: buildSystemPrompt(ctx),
        userMessage: ctx.intent,
        tools: TOOLS,
        maxTurns,
        label: 'expression_writer',
        signal: options?.signal,
      },
      toolImpls,
    );
  } catch (e) {
    logger.error('[expression_writer] tool loop failed', { error: e });
  }

  if (submitted && submittedExpression && submittedFormula) {
    return { expression: submittedExpression, formula: submittedFormula };
  }

  if (lastValidFormula) {
    const result = validateFormula(lastValidFormula);
    if (result.valid && result.expression) {
      return { expression: result.expression, formula: lastValidFormula };
    }
  }

  return {
    error: 'Failed to produce a valid expression',
    bestAttempt: lastValidFormula,
  };
}
