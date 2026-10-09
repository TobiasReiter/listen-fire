// Save-time validation for kg_exists / kg_value expressions. Enforces:
//   - read-only (no mutation clauses)
//   - kg_value: single-column RETURN
//   - all $N param references are positional and match the params[] length
//
// Runtime execution lives in kg_query_runner.ts so this module stays free of
// the DB/Prisma import chain (validators run in lightweight unit tests).

import type {
  CypherQuery,
  Expression as CypherExpression,
  PatternPath,
} from '../../../lib/knowledge/cypher/types';

import { parseAnyCypher, ParseError } from '../../../lib/knowledge/cypher/parser';
import { isMutation } from '../../../lib/knowledge/cypher/types';

export class KgQueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KgQueryValidationError';
  }
}

interface ValidateInput {
  kind: 'kg_exists' | 'kg_value';
  query: string;
  paramCount: number;
}

export function validateKgQuery({ kind, query, paramCount }: ValidateInput): { ast: CypherQuery } {
  let parsed;
  try {
    parsed = parseAnyCypher(query.trim());
  } catch (err) {
    if (err instanceof ParseError) {
      throw new KgQueryValidationError(`Cypher parse error: ${err.message}`);
    }
    throw err;
  }

  if (isMutation(parsed)) {
    throw new KgQueryValidationError(
      `${kind} cannot use mutation clauses (CREATE, MERGE, SET, DELETE, REMOVE).`,
    );
  }

  if (kind === 'kg_value' && parsed.return.items.length !== 1) {
    throw new KgQueryValidationError(
      `kg_value requires a single RETURN column; got ${parsed.return.items.length}.`,
    );
  }

  const referenced = collectParamRefs(parsed);
  for (const name of referenced) {
    if (!/^\d+$/.test(name)) {
      throw new KgQueryValidationError(
        `kg_query parameters must be positional ($0, $1, ...); got $${name}.`,
      );
    }
    const idx = parseInt(name, 10);
    if (idx >= paramCount) {
      throw new KgQueryValidationError(
        `Query references $${idx} but only ${paramCount} param expression(s) provided.`,
      );
    }
  }
  for (let i = 0; i < paramCount; i++) {
    if (!referenced.has(String(i))) {
      throw new KgQueryValidationError(
        `Param expression at position ${i} ($${i}) is not referenced in the query.`,
      );
    }
  }

  return { ast: parsed };
}

function collectParamRefs(query: CypherQuery): Set<string> {
  const out = new Set<string>();
  const collect = (expr: CypherExpression): void => walkExpr(expr, out);
  for (const path of query.match.patterns) collectPath(path, out);
  if (query.optionalMatch) {
    for (const path of query.optionalMatch.patterns) collectPath(path, out);
  }
  if (query.where) collect(query.where);
  if (query.having) collect(query.having);
  for (const item of query.return.items) collect(item.expression);
  if (query.orderBy) for (const o of query.orderBy) collect(o.expression);
  if (typeof query.skip === 'object' && query.skip?.kind === 'parameter') out.add(query.skip.name);
  if (typeof query.limit === 'object' && query.limit?.kind === 'parameter') out.add(query.limit.name);
  return out;
}

function collectPath(path: PatternPath, out: Set<string>): void {
  for (const el of path.elements) {
    if (el.kind === 'node' && el.properties) {
      for (const p of el.properties) walkExpr(p.value, out);
    }
  }
}

function walkExpr(expr: CypherExpression, out: Set<string>): void {
  switch (expr.kind) {
    case 'parameter':
      out.add(expr.name);
      return;
    case 'literal':
    case 'variable':
    case 'property_access':
      return;
    case 'binary':
      walkExpr(expr.left, out);
      walkExpr(expr.right, out);
      return;
    case 'unary':
      walkExpr(expr.operand, out);
      return;
    case 'is_null':
      walkExpr(expr.operand, out);
      return;
    case 'in':
      walkExpr(expr.operand, out);
      walkExpr(expr.list, out);
      return;
    case 'function_call':
      for (const a of expr.args) walkExpr(a, out);
      return;
    case 'list':
      for (const e of expr.elements) walkExpr(e, out);
      return;
    case 'map':
      for (const e of expr.entries) walkExpr(e.value, out);
      return;
    case 'case':
      if (expr.operand) walkExpr(expr.operand, out);
      for (const w of expr.whens) {
        walkExpr(w.condition, out);
        walkExpr(w.result, out);
      }
      if (expr.elseResult) walkExpr(expr.elseResult, out);
      return;
    case 'exists_subquery':
      for (const path of expr.match.patterns) collectPath(path, out);
      if (expr.where) walkExpr(expr.where, out);
      return;
  }
}
