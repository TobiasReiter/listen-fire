import { type Kysely, sql } from 'kysely';

import { getQb } from '../../kysely';
import { unwrapAgentQueryRows } from '../query_agent_utils';
import { parseAnyCypher, ParseError } from './parser';
import { isMutation } from './types';
import { transpile, loadOntology, TranspileError, type OntologyCache, type CypherParams } from './transpiler';
import { executeMutationCypher } from './mutationExecutor';

export type { OntologyCache } from './transpiler';
export type { CypherParams } from './transpiler';
export { loadOntology } from './transpiler';

export class MutationNotAllowedError extends Error {
  constructor() {
    super('This is a read-only query tool. Use cypherWrite for CREATE/MERGE/SET/REMOVE/DELETE.');
    this.name = 'MutationNotAllowedError';
  }
}

interface CypherExecuteOptions {
  query: string;
  teamId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  qb: Kysely<any>;
  ontology?: OntologyCache;
  maxLimit?: number | null;
  params?: CypherParams;
  readOnly?: boolean;
}

export interface CypherResult {
  columns: string[];
  data: Record<string, unknown>[];
  meta: {
    rowCount: number;
    timeMs: number;
    generatedSql?: string;
  };
}

// Inline transpiler params into the SQL string for execute_agent_query.
// Safe because params originate from our transpiler (team IDs, ontology IDs,
// parsed Cypher literals) — never from raw user input.
function formatScalar(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  return `'${String(val).replace(/'/g, "''")}'`;
}

function inlineParams(sqlText: string, params: unknown[]): string {
  return sqlText.replace(/\$(\d+)/g, (_, n) => {
    const val = params[parseInt(n, 10) - 1];
    if (Array.isArray(val)) {
      return `ARRAY[${val.map(formatScalar).join(', ')}]`;
    }
    return formatScalar(val);
  });
}

// Strip // inline comments from Cypher queries (preserving the query structure)
export function stripCypherComments(query: string): string {
  return query
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trimEnd())
    .filter((line) => line.length > 0)
    .join(' ');
}

export async function executeCypher({
  query: cypherQuery,
  teamId,
  qb,
  ontology,
  maxLimit,
  params: cypherParams,
  readOnly,
}: CypherExecuteOptions): Promise<CypherResult> {
  const start = performance.now();

  const ast = parseAnyCypher(stripCypherComments(cypherQuery));

  if (isMutation(ast)) {
    if (readOnly) throw new MutationNotAllowedError();
    return executeMutationCypher({ ast, teamId, qb, ontology, maxLimit, params: cypherParams });
  }

  const ont = ontology ?? (await loadOntology(qb, teamId));
  const { sql: sqlText, params, columns } = transpile(ast, ont, teamId, maxLimit, cypherParams);

  // Inline params and execute through execute_agent_query() plpgsql function.
  // This wraps the SQL in a subquery (preventing multi-statement injection)
  // and enforces RLS via the agent role.
  const fullSql = inlineParams(sqlText, params);
  const rows = await getQb().transaction().execute(async (trx) => {
    await sql`SELECT set_current_team_id(${teamId})`.execute(trx);
    await sql`SET LOCAL ROLE agent`.execute(trx);
    const result = await sql`SELECT * FROM execute_agent_query(${fullSql})`.execute(trx);
    return result.rows;
  });

  const elapsed = performance.now() - start;
  const unwrapped = unwrapAgentQueryRows(rows as unknown[]) as Record<string, unknown>[];

  return {
    columns,
    data: unwrapped.map((row) => {
      const obj: Record<string, unknown> = {};
      for (const col of columns) {
        obj[col] = row[col];
      }
      return obj;
    }),
    meta: {
      rowCount: unwrapped.length,
      timeMs: Math.round(elapsed),
      generatedSql: sqlText,
    },
  };
}

export async function explainCypher({
  query: cypherQuery,
  teamId,
  qb,
  params: cypherParams,
}: {
  query: string;
  teamId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  qb: Kysely<any>;
  params?: CypherParams;
}): Promise<{ estimatedRows: number; generatedSql: string; plan: unknown }> {
  const ast = parseAnyCypher(stripCypherComments(cypherQuery));
  if (isMutation(ast)) throw new MutationNotAllowedError();

  const ont = await loadOntology(qb, teamId);
  const { sql: sqlText, params } = transpile(ast, ont, teamId, null, cypherParams);
  const fullSql = inlineParams(sqlText, params);

  // sql.raw is required because EXPLAIN can't take a parameterized statement as
  // a value; fullSql is our own transpiler output with literals already inlined
  // and safely escaped (see formatScalar), run under the read-only agent role —
  // never raw user text. Wrapping it in a subquery mirrors the defense-in-depth
  // execute_agent_query() gives executeCypher: a stray trailing statement can no
  // longer execute standalone because it's forced into a single FROM-clause
  // expression, so it becomes a syntax error instead of running.
  const rows = await getQb().transaction().execute(async (trx) => {
    await sql`SELECT set_current_team_id(${teamId})`.execute(trx);
    await sql`SET LOCAL ROLE agent`.execute(trx);
    const result = await sql<{ 'QUERY PLAN': unknown }>`${sql.raw(`EXPLAIN (FORMAT JSON) SELECT * FROM (${fullSql}) AS _explain_subquery`)}`.execute(trx);
    return result.rows;
  });

  const plan = (rows[0] as { 'QUERY PLAN'?: Array<{ Plan?: { 'Plan Rows'?: number } }> })?.['QUERY PLAN'];
  const estimatedRows = plan?.[0]?.Plan?.['Plan Rows'] ?? 0;
  return { estimatedRows, generatedSql: sqlText, plan };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getSchema(
  qb: Kysely<any>,
  teamId: string,
): Promise<{
  nodeTypes: {
    name: string;
    properties: { name: string; type: string; identity: string; enumValues?: string[] }[];
  }[];
  edgeTypes: {
    name: string;
    source: string;
    target: string;
    properties: { name: string; type: string }[];
  }[];
}> {
  const [nodeTypes, edgeTypes, nodePropertyTypes, edgePropertyTypes] = await Promise.all([
    qb
      .selectFrom('node_type')
      .where('team_id', '=', teamId)
      .select(['id', 'name', 'category', 'description'])
      .orderBy('name')
      .execute(),
    qb
      .selectFrom('edge_type')
      .innerJoin('node_type as src', 'src.id', 'edge_type.source_node_type_id')
      .innerJoin('node_type as tgt', 'tgt.id', 'edge_type.target_node_type_id')
      .where('edge_type.team_id', '=', teamId)
      .select([
        'edge_type.id',
        'edge_type.outbound_name',
        'src.name as source_name',
        'tgt.name as target_name',
      ])
      .orderBy('edge_type.outbound_name')
      .execute(),
    qb
      .selectFrom('property_type')
      .innerJoin('node_type', 'node_type.id', 'property_type.node_type_id')
      .where('node_type.team_id', '=', teamId)
      .select([
        'property_type.name',
        'property_type.value_type',
        'property_type.identity',
        'property_type.enum_values',
        'property_type.node_type_id',
      ])
      .orderBy('property_type.sort_order')
      .execute(),
    qb
      .selectFrom('property_type')
      .innerJoin('edge_type', 'edge_type.id', 'property_type.edge_type_id')
      .where('edge_type.team_id', '=', teamId)
      .select([
        'property_type.name',
        'property_type.value_type',
        'property_type.edge_type_id',
      ])
      .orderBy('property_type.sort_order')
      .execute(),
  ]);

  const nodePropsMap = new Map<string, typeof nodePropertyTypes>();
  for (const pt of nodePropertyTypes) {
    const list = nodePropsMap.get(pt.node_type_id!) ?? [];
    list.push(pt);
    nodePropsMap.set(pt.node_type_id!, list);
  }

  const edgePropsMap = new Map<string, typeof edgePropertyTypes>();
  for (const pt of edgePropertyTypes) {
    const list = edgePropsMap.get(pt.edge_type_id!) ?? [];
    list.push(pt);
    edgePropsMap.set(pt.edge_type_id!, list);
  }

  return {
    nodeTypes: nodeTypes.map((nt: any) => ({
      name: nt.name,
      properties: (nodePropsMap.get(nt.id) ?? []).map((pt: any) => ({
        name: pt.name,
        type: pt.value_type,
        identity: pt.identity,
        ...(pt.enum_values && Array.isArray(pt.enum_values) && pt.enum_values.length > 0
          ? { enumValues: pt.enum_values as string[] }
          : {}),
      })),
    })),
    edgeTypes: edgeTypes.map((et: any) => ({
      name: et.outbound_name,
      source: et.source_name,
      target: et.target_name,
      properties: (edgePropsMap.get(et.id) ?? []).map((pt: any) => ({
        name: pt.name,
        type: pt.value_type,
      })),
    })),
  };
}

export { ParseError, TranspileError };
