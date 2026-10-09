// Runtime execution for kg_exists / kg_value expressions.
// Split from kg_query.ts so the validator can be imported in unit tests
// without dragging in Prisma/Kysely.

import type { Kysely } from 'kysely';

import { executeCypher } from '../../../lib/knowledge/cypher';
import { getKnowledgeQb } from '../../../lib/kysely';
import { validateKgQuery } from './kg_query';

type CypherParamValue = string | number | boolean | null | (string | number | boolean)[];

export interface RunKgQueryInput {
  kind: 'kg_exists' | 'kg_value';
  query: string;
  /** Already-evaluated param values, indexed positionally. */
  paramValues: unknown[];
  teamId: string;
  /** Per-evaluation cache, allocated by the caller. */
  cache: Map<string, unknown>;
}

/**
 * Executes a kg_exists/kg_value query and returns the row data. The caller
 * is responsible for coercing rows to the expression's return shape:
 *   - kg_exists → boolean (rows.length > 0)
 *   - kg_value  → null | scalar | scalar[] (single-column, validated above)
 */
export async function runKgQuery(input: RunKgQueryInput): Promise<Record<string, unknown>[]> {
  const { kind, query, paramValues, teamId, cache } = input;

  // Defense-in-depth: re-validate at evaluation time. Save-time validation
  // is the primary gate; this catches drift if a TG/output is persisted
  // from an older code path.
  validateKgQuery({ kind, query, paramCount: paramValues.length });

  const params: Record<string, CypherParamValue> = {};
  for (let i = 0; i < paramValues.length; i++) {
    params[String(i)] = coerceCypherParam(paramValues[i]);
  }

  const cacheKey = `${kind}\n${query}\n${JSON.stringify(params)}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) as Record<string, unknown>[];
  }

  const result = await executeCypher({
    query,
    teamId,
    qb: getKnowledgeQb() as unknown as Kysely<unknown>,
    params,
  });
  cache.set(cacheKey, result.data);
  return result.data;
}

// Coerce an evaluated expression value into a CypherParamValue. Scalars and
// scalar arrays pass through; anything else stringifies (lenient by design,
// since the caller's source adapter may surface heterogeneous shapes).
function coerceCypherParam(value: unknown): CypherParamValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
      return String(v);
    }) as (string | number | boolean)[];
  }
  return String(value);
}
