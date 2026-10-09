import { sql } from 'kysely';

import type { Kysely } from 'kysely';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type {
  MutationCypherQuery,
  MutationClause,
  SetClause,
  RemoveClause,
  DeleteClause,
  CreateClause,
  MergeClause,
  CypherQuery,
  MatchClause,
  PatternPath,
  NodePattern,
  RelationshipPattern,
  Expression,
  ReturnClause,
  ReturnItem,
} from './types';
import type { CypherResult } from './index';

import { getQb, getKnowledgeQb } from '../../kysely';
import { unwrapAgentQueryRows } from '../query_agent_utils';
import {
  createEntity,
  updateEntity,
  updateRelationship,
  deleteEntity,
  createRelationship,
  deleteRelationship,
} from '../query_agent_crud';
import { deleteEdge, type KnowledgeWriteDb } from '../store';
import { ChangeSource } from '../changes';
import EvidenceType from '../../../generated/kysely/knowledge/EvidenceType';
import { transpile, loadOntology, type OntologyCache, type CypherParams } from './transpiler';


// --- Types ---

interface VarInfo {
  isEdge: boolean;
  label?: string;
}

type VariableBindings = Map<string, string>;
type PropertyValue = string | number | boolean | null;

// --- Main entry point ---

interface MutationExecuteOptions {
  ast: MutationCypherQuery;
  teamId: string;
  qb: Kysely<any>;
  ontology?: OntologyCache;
  maxLimit?: number | null;
  params?: CypherParams;
}

export async function executeMutationCypher({
  ast,
  teamId,
  qb,
  ontology,
  maxLimit = null,
  params: cypherParams = {},
}: MutationExecuteOptions): Promise<CypherResult> {
  const start = performance.now();
  const ont = ontology ?? (await loadOntology(qb, teamId));

  // Extract variable info from MATCH patterns
  const varInfo = extractVariablesFromPatterns([
    ...(ast.match?.patterns ?? []),
    ...(ast.optionalMatch?.patterns ?? []),
  ]);

  // Phase 1: Get variable bindings from MATCH (if present)
  let bindingRows: VariableBindings[];

  if (ast.match && varInfo.size > 0) {
    bindingRows = await executeBindingQuery(ast, varInfo, ont, teamId, qb, maxLimit, cypherParams);
  } else {
    bindingRows = [new Map()];
  }

  // Phase 2: Apply mutations in a single transaction
  const knowledgeQb = getKnowledgeQb() as Kysely<any>;
  const finalBindings = await (knowledgeQb as any).transaction().execute(async (trx: any) => {
    const allBindings: VariableBindings[] = [];

    for (const row of bindingRows) {
      const rowBindings = new Map(row);

      for (const clause of ast.mutations) {
        await applyClause(trx, clause, rowBindings, varInfo, ont, teamId, cypherParams);
      }

      allBindings.push(rowBindings);
    }

    return allBindings;
  });

  // Phase 3: Build return
  const elapsed = Math.round(performance.now() - start);

  if (!ast.return) {
    return {
      columns: ['mutated_rows'],
      data: [{ mutated_rows: finalBindings.length }],
      meta: { rowCount: 1, timeMs: elapsed },
    };
  }

  return evaluateReturn(ast.return, finalBindings, varInfo, qb, teamId, elapsed);
}

// --- Phase 1: Binding query ---

function extractVariablesFromPatterns(patterns: PatternPath[]): Map<string, VarInfo> {
  const vars = new Map<string, VarInfo>();

  for (const pattern of patterns) {
    for (const el of pattern.elements) {
      if (el.kind === 'node' && el.variable) {
        vars.set(el.variable, { isEdge: false, label: el.label });
      } else if (el.kind === 'relationship' && el.variable) {
        vars.set(el.variable, { isEdge: true, label: el.type });
      }
    }
  }

  return vars;
}

function buildBindingQuery(ast: MutationCypherQuery, varNames: string[]): CypherQuery {
  return {
    match: ast.match!,
    ...(ast.optionalMatch ? { optionalMatch: ast.optionalMatch } : {}),
    ...(ast.where ? { where: ast.where } : {}),
    return: {
      items: varNames.map((name): ReturnItem => ({
        expression: { kind: 'variable', name },
        alias: name,
      })),
    },
    ...(ast.limit !== undefined ? { limit: ast.limit } : {}),
  };
}

function inlineParams(sqlText: string, params: unknown[]): string {
  return sqlText.replace(/\$(\d+)/g, (_, n) => {
    const val = params[parseInt(n, 10) - 1];
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'number') return String(val);
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    return `'${String(val).replace(/'/g, "''")}'`;
  });
}

async function executeBindingQuery(
  ast: MutationCypherQuery,
  varInfo: Map<string, VarInfo>,
  ont: OntologyCache,
  teamId: string,
  qb: Kysely<any>,
  maxLimit: number | null,
  cypherParams: CypherParams = {},
): Promise<VariableBindings[]> {
  const varNames = [...varInfo.keys()];
  if (varNames.length === 0) return [new Map()];

  const bindingQuery = buildBindingQuery(ast, varNames);
  const { sql: sqlText, params, columns } = transpile(bindingQuery, ont, teamId, maxLimit, cypherParams);

  const fullSql = inlineParams(sqlText, params);
  const rows = await getQb().transaction().execute(async (trx) => {
    await sql`SELECT set_current_team_id(${teamId})`.execute(trx);
    await sql`SET LOCAL ROLE agent`.execute(trx);
    const result = await sql`SELECT * FROM execute_agent_query(${fullSql})`.execute(trx);
    return result.rows;
  });

  const unwrapped = unwrapAgentQueryRows(rows as unknown[]) as Record<string, unknown>[];

  return unwrapped.map((row) => {
    const bindings: VariableBindings = new Map();
    for (const col of columns) {
      if (row[col] != null) {
        bindings.set(col, String(row[col]));
      }
    }
    return bindings;
  });
}

// --- Phase 2: Mutation application ---

async function applyClause(
  trx: any,
  clause: MutationClause,
  bindings: VariableBindings,
  varInfo: Map<string, VarInfo>,
  ont: OntologyCache,
  teamId: string,
  cypherParams: CypherParams = {},
): Promise<void> {
  switch (clause.kind) {
    case 'set':
      return applySet(trx, clause, bindings, varInfo, teamId, cypherParams);
    case 'remove':
      return applyRemove(trx, clause, bindings, varInfo, teamId);
    case 'delete':
      return applyDelete(trx, clause, bindings, varInfo, teamId);
    case 'create':
      return applyCreate(trx, clause, bindings, varInfo, ont, teamId, cypherParams);
    case 'merge':
      return applyMerge(trx, clause, bindings, varInfo, ont, teamId, cypherParams);
  }
}

async function applySet(
  trx: any,
  clause: SetClause,
  bindings: VariableBindings,
  varInfo: Map<string, VarInfo>,
  teamId: string,
  cypherParams: CypherParams = {},
): Promise<void> {
  // Group SET items by target variable
  const grouped = new Map<string, Record<string, PropertyValue>>();

  for (const item of clause.items) {
    const variable = item.target.variable;
    const id = bindings.get(variable);
    if (!id) throw new Error(`SET references unbound variable: ${variable}`);

    const props = grouped.get(variable) ?? {};
    props[item.target.property] = evaluateLiteralExpr(item.value, cypherParams);
    grouped.set(variable, props);
  }

  for (const [variable, properties] of grouped) {
    const id = bindings.get(variable)!;
    const info = varInfo.get(variable);

    if (info?.isEdge) {
      await updateRelationship({ edgeId: id, properties }, teamId, trx);
    } else {
      await updateEntity({ nodeId: id, properties }, teamId, trx);
    }
  }
}

async function applyRemove(
  trx: any,
  clause: RemoveClause,
  bindings: VariableBindings,
  varInfo: Map<string, VarInfo>,
  teamId: string,
): Promise<void> {
  // REMOVE is SET to null
  const grouped = new Map<string, Record<string, PropertyValue>>();

  for (const prop of clause.properties) {
    const variable = prop.variable;
    const id = bindings.get(variable);
    if (!id) throw new Error(`REMOVE references unbound variable: ${variable}`);

    const props = grouped.get(variable) ?? {};
    props[prop.property] = null;
    grouped.set(variable, props);
  }

  for (const [variable, properties] of grouped) {
    const id = bindings.get(variable)!;
    await updateEntity({ nodeId: id, properties }, teamId, trx);
  }
}

async function applyDelete(
  trx: any,
  clause: DeleteClause,
  bindings: VariableBindings,
  varInfo: Map<string, VarInfo>,
  teamId: string,
): Promise<void> {
  // Delete edges first, then nodes (to avoid FK violations when not using DETACH)
  const edges: string[] = [];
  const nodes: string[] = [];

  for (const variable of clause.variables) {
    const id = bindings.get(variable);
    if (!id) throw new Error(`DELETE references unbound variable: ${variable}`);

    const info = varInfo.get(variable);
    if (info?.isEdge) {
      edges.push(variable);
    } else {
      nodes.push(variable);
    }
  }

  // Delete edges
  for (const variable of edges) {
    const edgeId = bindings.get(variable)!;
    // The executor's transaction handle is untyped (`any`) throughout this
    // file; the door takes an explicit one and joins the open transaction.
    await deleteEdge(trx as KnowledgeWriteDb, {
      context: {
        teamId: teamId as TeamId,
        evidenceType: EvidenceType.user_edit,
        changeSource: ChangeSource.agent,
        description: 'Deleted by Ask agent',
      },
      edgeId,
    });
  }

  // Delete nodes (FK cascades handle related edges/properties/evidence)
  for (const variable of nodes) {
    const nodeId = bindings.get(variable)!;
    await deleteEntity({ nodeId }, teamId, trx);
  }
}

async function applyCreate(
  trx: any,
  clause: CreateClause,
  bindings: VariableBindings,
  varInfo: Map<string, VarInfo>,
  ont: OntologyCache,
  teamId: string,
  cypherParams: CypherParams = {},
): Promise<void> {
  for (const pattern of clause.patterns) {
    // First pass: create all new nodes
    for (const el of pattern.elements) {
      if (el.kind !== 'node') continue;
      if (!el.variable || bindings.has(el.variable)) continue;

      if (!el.label) throw new Error('CREATE node requires a label');

      const properties: Record<string, PropertyValue> = {};
      for (const prop of el.properties ?? []) {
        properties[prop.key] = evaluateLiteralExpr(prop.value, cypherParams);
      }

      const result = await createEntity(
        { typeName: el.label, properties },
        teamId,
        trx,
      );

      bindings.set(el.variable, result.id);
      varInfo.set(el.variable, { isEdge: false, label: el.label });
    }

    // Second pass: create edges
    const elements = pattern.elements;
    for (let i = 1; i < elements.length; i += 2) {
      const rel = elements[i] as RelationshipPattern;
      const prevNode = elements[i - 1] as NodePattern;
      const nextNode = elements[i + 1] as NodePattern;

      if (!rel.type) throw new Error('CREATE relationship requires a type');

      const sourceVar = rel.direction === 'incoming' ? nextNode.variable : prevNode.variable;
      const targetVar = rel.direction === 'incoming' ? prevNode.variable : nextNode.variable;

      if (!sourceVar || !targetVar) {
        throw new Error('CREATE relationship requires variables on both endpoints');
      }

      const sourceId = bindings.get(sourceVar);
      const targetId = bindings.get(targetVar);
      if (!sourceId || !targetId) {
        throw new Error(`CREATE relationship references unbound variable: ${sourceVar} or ${targetVar}`);
      }

      const result = await createRelationship(
        { sourceNodeId: sourceId, targetNodeId: targetId, relationshipName: rel.type },
        teamId,
        trx,
      );

      if (rel.variable) {
        bindings.set(rel.variable, result.id);
        varInfo.set(rel.variable, { isEdge: true, label: rel.type });
      }
    }
  }
}

async function applyMerge(
  trx: any,
  clause: MergeClause,
  bindings: VariableBindings,
  varInfo: Map<string, VarInfo>,
  ont: OntologyCache,
  teamId: string,
  cypherParams: CypherParams = {},
): Promise<void> {
  const elements = clause.pattern.elements;

  // Single-node MERGE
  if (elements.length === 1 && elements[0].kind === 'node') {
    const node = elements[0] as NodePattern;
    if (!node.label) throw new Error('MERGE requires a node label');
    if (!node.variable) throw new Error('MERGE requires a variable');

    const inlineProps: Record<string, PropertyValue> = {};
    for (const prop of node.properties ?? []) {
      inlineProps[prop.key] = evaluateLiteralExpr(prop.value, cypherParams);
    }

    // Search for existing node with exact property match
    const nodeType = ont.nodeTypes.get(node.label.toLowerCase());
    if (!nodeType) throw new Error(`Unknown node type: ${node.label}`);

    const existing = await findExactMatch(trx, nodeType.id, inlineProps, teamId);

    if (existing) {
      // MATCH — bind to existing node
      bindings.set(node.variable, existing);
      varInfo.set(node.variable, { isEdge: false, label: node.label });

      // Apply ON MATCH SET
      if (clause.onMatchSet?.length) {
        await applySet(
          trx,
          { kind: 'set', items: clause.onMatchSet },
          bindings,
          varInfo,
          teamId,
          cypherParams,
        );
      }
    } else {
      // CREATE — create new node with inline properties
      const result = await createEntity(
        { typeName: node.label, properties: inlineProps },
        teamId,
        trx,
      );
      bindings.set(node.variable, result.id);
      varInfo.set(node.variable, { isEdge: false, label: node.label });

      // Apply ON CREATE SET
      if (clause.onCreateSet?.length) {
        await applySet(
          trx,
          { kind: 'set', items: clause.onCreateSet },
          bindings,
          varInfo,
          teamId,
          cypherParams,
        );
      }
    }
    return;
  }

  // Edge MERGE: (a)-[:REL]->(b) where a and b are already bound
  if (elements.length === 3) {
    const prevNode = elements[0] as NodePattern;
    const rel = elements[1] as RelationshipPattern;
    const nextNode = elements[2] as NodePattern;

    if (!rel.type) throw new Error('MERGE relationship requires a type');

    const sourceVar = rel.direction === 'incoming' ? nextNode.variable : prevNode.variable;
    const targetVar = rel.direction === 'incoming' ? prevNode.variable : nextNode.variable;

    if (!sourceVar || !targetVar) {
      throw new Error('MERGE relationship requires variables on both endpoints');
    }

    const sourceId = bindings.get(sourceVar);
    const targetId = bindings.get(targetVar);
    if (!sourceId || !targetId) {
      throw new Error(`MERGE relationship references unbound variable: ${sourceVar} or ${targetVar}`);
    }

    // Look up edge type
    const edgeType = ont.edgeTypes.get(rel.type.toLowerCase());
    if (!edgeType) throw new Error(`Unknown edge type: ${rel.type}`);

    // Check if edge already exists
    const existingEdge = await trx
      .selectFrom('edge')
      .where('source_node_id', '=', sourceId)
      .where('target_node_id', '=', targetId)
      .where('edge_type_id', '=', edgeType.id)
      .where('team_id', '=', teamId)
      .select('id')
      .executeTakeFirst();

    if (existingEdge) {
      if (rel.variable) {
        bindings.set(rel.variable, existingEdge.id);
        varInfo.set(rel.variable, { isEdge: true, label: rel.type });
      }
      if (clause.onMatchSet?.length) {
        await applySet(trx, { kind: 'set', items: clause.onMatchSet }, bindings, varInfo, teamId, cypherParams);
      }
    } else {
      const result = await createRelationship(
        { sourceNodeId: sourceId, targetNodeId: targetId, relationshipName: rel.type },
        teamId,
        trx,
      );
      if (rel.variable) {
        bindings.set(rel.variable, result.id);
        varInfo.set(rel.variable, { isEdge: true, label: rel.type });
      }
      if (clause.onCreateSet?.length) {
        await applySet(trx, { kind: 'set', items: clause.onCreateSet }, bindings, varInfo, teamId, cypherParams);
      }
    }
    return;
  }

  throw new Error('MERGE supports single-node or single-edge patterns only');
}

// Find a node with exact property matches
async function findExactMatch(
  trx: any,
  nodeTypeId: string,
  properties: Record<string, PropertyValue>,
  teamId: string,
): Promise<string | null> {
  let query = trx
    .selectFrom('node')
    .where('node_type_id', '=', nodeTypeId)
    .where('team_id', '=', teamId)
    .select('id');

  // For each property, add an EXISTS subquery requiring a matching property
  for (const [name, value] of Object.entries(properties)) {
    if (value === null) continue;

    const propTypeRow = await trx
      .selectFrom('property_type')
      .where('node_type_id', '=', nodeTypeId)
      .where('name', '=', name)
      .select('id')
      .executeTakeFirst();

    if (!propTypeRow) continue;

    query = query.where((eb: any) =>
      eb.exists(
        eb
          .selectFrom('property')
          .whereRef('property.node_id', '=', 'node.id')
          .where('property.property_type_id', '=', propTypeRow.id)
          .where('property.value_text', '=', String(value))
          .select(sql`1` as any),
      ),
    );
  }

  const candidates = await query.limit(2).execute();

  // Exact match: exactly one candidate
  if (candidates.length === 1) {
    return candidates[0].id;
  }

  return null;
}

// --- Expression evaluation ---

function evaluateLiteralExpr(expr: Expression, cypherParams: CypherParams = {}): PropertyValue {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'parameter': {
      if (!(expr.name in cypherParams)) {
        throw new Error(`Missing parameter: $${expr.name}`);
      }
      const value = cypherParams[expr.name];
      if (Array.isArray(value)) {
        throw new Error(
          `Array parameter $${expr.name} cannot be used as a scalar mutation value`,
        );
      }
      return value;
    }
    case 'function_call':
      if (expr.name === 'DATE' && expr.args.length === 0) {
        return new Date().toISOString().split('T')[0];
      }
      throw new Error(`Cannot evaluate function ${expr.name} as a mutation value`);
    default:
      throw new Error(
        `Cannot evaluate expression of kind '${expr.kind}' as a mutation value. ` +
          'Only literal values, parameters, and date() are supported in SET/CREATE/MERGE values.',
      );
  }
}

// --- Phase 3: Return evaluation ---

async function evaluateReturn(
  returnClause: ReturnClause,
  allBindings: VariableBindings[],
  varInfo: Map<string, VarInfo>,
  qb: Kysely<any>,
  teamId: string,
  elapsedMs: number,
): Promise<CypherResult> {
  // Collect all unique node/edge IDs
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  for (const bindings of allBindings) {
    for (const [variable, id] of bindings) {
      const info = varInfo.get(variable);
      if (info?.isEdge) {
        edgeIds.add(id);
      } else {
        nodeIds.add(id);
      }
    }
  }

  // Fetch all properties for bound nodes
  const nodeProps = new Map<string, Record<string, unknown>>();
  if (nodeIds.size > 0) {
    const props = await (getKnowledgeQb() as Kysely<any>)
      .selectFrom('property')
      .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
      .where('property.node_id', 'in', [...nodeIds])
      .select([
        'property.node_id',
        'property_type.name',
        'property.value_text',
        'property.value_number',
        'property.value_date',
        'property.value_boolean',
      ])
      .execute();

    for (const p of props) {
      const map = nodeProps.get(p.node_id as string) ?? {};
      map[(p as any).name] = p.value_text ?? p.value_number ?? p.value_date ?? p.value_boolean;
      nodeProps.set(p.node_id as string, map);
    }
  }

  // Fetch node meta fields
  const nodeMeta = new Map<string, Record<string, unknown>>();
  if (nodeIds.size > 0) {
    const nodes = await (getKnowledgeQb() as Kysely<any>)
      .selectFrom('node')
      .where('id', 'in', [...nodeIds])
      .select(['id', 'created_at', 'updated_at', 'summary'])
      .execute();

    for (const n of nodes) {
      nodeMeta.set(n.id as string, {
        created_at: n.created_at,
        updated_at: n.updated_at,
        summary: n.summary,
      });
    }
  }

  // Evaluate RETURN expressions for each row
  const columns = returnClause.items.map(
    (item) => item.alias ?? expressionLabel(item.expression),
  );

  const data = allBindings.map((bindings) => {
    const row: Record<string, unknown> = {};

    for (const item of returnClause.items) {
      const alias = item.alias ?? expressionLabel(item.expression);
      row[alias] = evaluateExpr(item.expression, bindings, varInfo, nodeProps, nodeMeta);
    }

    return row;
  });

  return {
    columns,
    data,
    meta: { rowCount: data.length, timeMs: elapsedMs },
  };
}

function evaluateExpr(
  expr: Expression,
  bindings: VariableBindings,
  varInfo: Map<string, VarInfo>,
  nodeProps: Map<string, Record<string, unknown>>,
  nodeMeta: Map<string, Record<string, unknown>>,
): unknown {
  switch (expr.kind) {
    case 'property_access': {
      const id = bindings.get(expr.variable);
      if (!id) return null;

      // Check meta fields first
      const meta = nodeMeta.get(id);
      const metaField = expr.property.toLowerCase();
      if (meta && metaField in meta) {
        return meta[metaField];
      }

      // Regular properties
      const props = nodeProps.get(id);
      return props?.[expr.property] ?? null;
    }

    case 'variable': {
      return bindings.get(expr.name) ?? null;
    }

    case 'literal':
      return expr.value;

    case 'function_call': {
      if (expr.name === 'DATE' && expr.args.length === 0) {
        return new Date().toISOString().split('T')[0];
      }
      if (expr.name === 'COALESCE') {
        for (const arg of expr.args) {
          const val = evaluateExpr(arg, bindings, varInfo, nodeProps, nodeMeta);
          if (val !== null && val !== undefined) return val;
        }
        return null;
      }
      if (expr.name === 'TOLOWER') {
        const val = evaluateExpr(expr.args[0], bindings, varInfo, nodeProps, nodeMeta);
        return typeof val === 'string' ? val.toLowerCase() : val;
      }
      if (expr.name === 'TOUPPER') {
        const val = evaluateExpr(expr.args[0], bindings, varInfo, nodeProps, nodeMeta);
        return typeof val === 'string' ? val.toUpperCase() : val;
      }
      if (expr.name === 'TOSTRING') {
        const val = evaluateExpr(expr.args[0], bindings, varInfo, nodeProps, nodeMeta);
        return val != null ? String(val) : null;
      }
      if (expr.name === 'COUNT' && expr.args.length === 0) {
        return null; // Aggregation not supported in mutation RETURN
      }
      return null;
    }

    case 'binary': {
      const left = evaluateExpr(expr.left, bindings, varInfo, nodeProps, nodeMeta);
      const right = evaluateExpr(expr.right, bindings, varInfo, nodeProps, nodeMeta);
      switch (expr.operator) {
        case '+':
          return (left as number) + (right as number);
        case '-':
          return (left as number) - (right as number);
        case '*':
          return (left as number) * (right as number);
        case '/':
          return (left as number) / (right as number);
        default:
          return null;
      }
    }

    case 'case': {
      for (const { condition, result } of expr.whens) {
        const condVal = evaluateExpr(condition, bindings, varInfo, nodeProps, nodeMeta);
        if (condVal) return evaluateExpr(result, bindings, varInfo, nodeProps, nodeMeta);
      }
      return expr.elseResult
        ? evaluateExpr(expr.elseResult, bindings, varInfo, nodeProps, nodeMeta)
        : null;
    }

    default:
      return null;
  }
}

function expressionLabel(expr: Expression): string {
  switch (expr.kind) {
    case 'property_access':
      return expr.property;
    case 'variable':
      return expr.name;
    case 'function_call':
      return `${expr.name.toLowerCase()}(${expr.args.map(expressionLabel).join(', ')})`;
    default:
      return 'expr';
  }
}
