import { type Kysely } from 'kysely';

import type {
  CypherQuery,
  ExistsSubquery,
  Expression,
  MapLiteral,
  NodePattern,
  ParameterRef,
  PatternPath,
  RelationshipPattern,
} from './types';

import { ParseError } from './parser';

// Cypher → PostgreSQL function name mapping
const FUNCTION_MAP: Record<string, string> = {
  COLLECT: 'array_agg',
  CONCAT: 'concat',
  COALESCE: 'coalesce',
  TOLOWER: 'lower',
  TOUPPER: 'upper',
  TRIM: 'trim',
  SIZE: 'length',
};

// Node meta fields that map directly to columns on knowledge.node (not property lookups)
const NODE_META_FIELDS: Record<string, string> = {
  created_at: 'created_at',
  updated_at: 'updated_at',
  summary: 'summary',
  // Node UUID. `n.id` is what every Cypher author (and our own query
  // generator + agents) writes; without this mapping it fell through to
  // a lookup of a property literally named "id" and silently returned
  // null — dead-ending any flow that needs ids (delete, update, links).
  id: 'id',
  _id: 'id',
};

// Cypher functions that map to CAST(... AS type)
const CAST_FUNCTIONS: Record<string, string> = {
  TOSTRING: 'text',
  TOINTEGER: 'integer',
  TOFLOAT: 'double precision',
};

const AGGREGATE_FUNCTIONS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COLLECT']);

function isAggregate(expr: Expression): boolean {
  return expr.kind === 'function_call' && AGGREGATE_FUNCTIONS.has(expr.name.toUpperCase());
}

// Parse ISO 8601 duration (P[n]Y[n]M[n]DT[n]H[n]M[n]S) to PostgreSQL interval string
function isoDurationToInterval(iso: string): string {
  const parts: string[] = [];
  const match = iso.match(
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/,
  );
  if (!match) throw new Error(`Invalid ISO 8601 duration: ${iso}`);
  const [, years, months, weeks, days, hours, minutes, seconds] = match;
  if (years) parts.push(`${years} years`);
  if (months) parts.push(`${months} months`);
  if (weeks) parts.push(`${parseInt(weeks) * 7} days`);
  if (days) parts.push(`${days} days`);
  if (hours) parts.push(`${hours} hours`);
  if (minutes) parts.push(`${minutes} minutes`);
  if (seconds) parts.push(`${seconds} seconds`);
  return parts.join(' ') || '0 seconds';
}

export interface OntologyCache {
  nodeTypes: Map<string, { id: string; name: string }>;
  edgeTypes: Map<string, { id: string; sourceNodeTypeId: string; targetNodeTypeId: string }>;
  propertyTypes: Map<string, Map<string, { id: string; valueType: string; name: string }>>;
}

interface TranspileResult {
  sql: string;
  params: unknown[];
  columns: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadOntology(
  qb: Kysely<any>,
  teamId: string,
): Promise<OntologyCache> {
  const [nodeTypes, edgeTypes, propertyTypes] = await Promise.all([
    qb
      .selectFrom('node_type')
      .where('team_id', '=', teamId)
      .select(['id', 'name'])
      .execute(),
    qb
      .selectFrom('edge_type')
      .where('team_id', '=', teamId)
      .select(['id', 'outbound_name', 'inbound_name', 'source_node_type_id', 'target_node_type_id'])
      .execute(),
    qb
      .selectFrom('property_type')
      .innerJoin('node_type', 'node_type.id', 'property_type.node_type_id')
      .where('node_type.team_id', '=', teamId)
      .select([
        'property_type.id',
        'property_type.name',
        'property_type.value_type',
        'property_type.node_type_id',
      ])
      .execute(),
  ]);

  const nodeTypeMap = new Map<string, { id: string; name: string }>();
  for (const nt of nodeTypes) {
    nodeTypeMap.set(nt.name.toLowerCase(), { id: nt.id, name: nt.name });
    // Also index by name with underscores replaced by spaces for flexibility
    const underscored = nt.name.toLowerCase().replace(/\s+/g, '_');
    if (underscored !== nt.name.toLowerCase()) {
      nodeTypeMap.set(underscored, { id: nt.id, name: nt.name });
    }
  }

  const edgeTypeMap = new Map<
    string,
    { id: string; sourceNodeTypeId: string; targetNodeTypeId: string }
  >();
  for (const et of edgeTypes) {
    edgeTypeMap.set(et.outbound_name.toLowerCase(), {
      id: et.id,
      sourceNodeTypeId: et.source_node_type_id,
      targetNodeTypeId: et.target_node_type_id,
    });
    if (et.inbound_name) {
      edgeTypeMap.set(et.inbound_name.toLowerCase(), {
        id: et.id,
        sourceNodeTypeId: et.source_node_type_id,
        targetNodeTypeId: et.target_node_type_id,
      });
    }
  }

  // Property types indexed by node_type_id → property_name (lowercase) → info
  const propertyTypeMap = new Map<string, Map<string, { id: string; valueType: string; name: string }>>();
  for (const pt of propertyTypes) {
    if (!pt.node_type_id) continue;
    let inner = propertyTypeMap.get(pt.node_type_id);
    if (!inner) {
      inner = new Map();
      propertyTypeMap.set(pt.node_type_id, inner);
    }
    inner.set(pt.name.toLowerCase(), { id: pt.id, valueType: pt.value_type, name: pt.name });
  }

  return {
    nodeTypes: nodeTypeMap,
    edgeTypes: edgeTypeMap,
    propertyTypes: propertyTypeMap,
  };
}

// Track what each variable in the MATCH clause maps to
interface VariableBinding {
  tableAlias: string;
  nodeTypeId?: string;
  isEdge: boolean;
}

export type CypherParamValue = string | number | boolean | null | (string | number | boolean)[];
export type CypherParams = Record<string, CypherParamValue>;

class Transpiler {
  private ontology: OntologyCache;
  private teamId: string;
  private bindings = new Map<string, VariableBinding>();
  private fromClauses: string[] = [];
  private joinClauses: string[] = [];
  private leftJoinClauses: string[] = [];
  private whereClauses: string[] = [];
  private params: unknown[] = [];
  private cypherParams: CypherParams;
  private aliasCounter = 0;
  private maxLimit: number | null;
  // When transpiling inside an EXISTS { ... } subquery, these aliases refer to
  // outer-scope node tables and must not be re-added to the subquery's FROM.
  private existsOuterAliases: Set<string> | null = null;

  constructor(ontology: OntologyCache, teamId: string, maxLimit: number | null = null, cypherParams: CypherParams = {}) {
    this.ontology = ontology;
    this.teamId = teamId;
    this.maxLimit = maxLimit;
    this.cypherParams = cypherParams;
  }

  private nextAlias(prefix: string): string {
    return `${prefix}${this.aliasCounter++}`;
  }

  private addParam(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  private resolveIntParam(value: number | ParameterRef | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    if (typeof value === 'number') return value;
    if (!(value.name in this.cypherParams)) {
      throw new TranspileError(`Missing parameter: $${value.name}`);
    }
    const resolved = this.cypherParams[value.name];
    if (typeof resolved !== 'number' || !Number.isInteger(resolved)) {
      throw new TranspileError(`Parameter $${value.name} must be an integer`);
    }
    return resolved;
  }

  private resolveOptionalIntParam(value: number | ParameterRef | undefined): number | null {
    if (value === undefined) return null;
    if (typeof value === 'number') return value;
    if (!(value.name in this.cypherParams)) {
      throw new TranspileError(`Missing parameter: $${value.name}`);
    }
    const resolved = this.cypherParams[value.name];
    if (typeof resolved !== 'number' || !Number.isInteger(resolved)) {
      throw new TranspileError(`Parameter $${value.name} must be an integer`);
    }
    return resolved;
  }

  transpile(query: CypherQuery): TranspileResult {
    // Process MATCH patterns
    for (const pattern of query.match.patterns) {
      this.processPattern(pattern);
    }

    // Convert inline node property predicates to WHERE conditions
    for (const pattern of query.match.patterns) {
      for (const el of pattern.elements) {
        if (el.kind === 'node' && el.properties) {
          const variable = el.variable ?? '';
          const binding = this.bindings.get(variable);
          if (binding) {
            for (const { key, value } of el.properties) {
              const propExpr: Expression = { kind: 'property_access', variable, property: key };
              const condition: Expression = { kind: 'binary', operator: '=', left: propExpr, right: value };
              this.whereClauses.push(this.transpileExpression(condition));
            }
          }
        }
      }
    }

    // Enforce team scoping on all node tables from MATCH
    for (const [, binding] of this.bindings) {
      if (!binding.isEdge) {
        this.whereClauses.push(`${binding.tableAlias}.team_id = ${this.addParam(this.teamId)}`);
      }
    }

    // Process OPTIONAL MATCH patterns (use LEFT JOINs)
    if (query.optionalMatch) {
      const bindingsBefore = new Set(this.bindings.keys());
      for (const pattern of query.optionalMatch.patterns) {
        this.processPattern(pattern, true);
      }
      // Enforce team scoping on newly bound nodes from OPTIONAL MATCH
      for (const [varName, binding] of this.bindings) {
        if (!bindingsBefore.has(varName) && !binding.isEdge) {
          // Team scoping goes into the LEFT JOIN ON clause, not WHERE
          // (WHERE would turn the LEFT JOIN into an INNER JOIN)
          const lastJoinIdx = this.leftJoinClauses.length - 1;
          if (lastJoinIdx >= 0 && this.leftJoinClauses[lastJoinIdx].includes(binding.tableAlias)) {
            this.leftJoinClauses[lastJoinIdx] += ` AND ${binding.tableAlias}.team_id = ${this.addParam(this.teamId)}`;
          }
        }
      }
    }

    // Process WHERE
    if (query.where) {
      this.whereClauses.push(this.transpileExpression(query.where));
    }

    // Process RETURN
    const selectItems: string[] = [];
    const columns: string[] = [];
    for (const item of query.return.items) {
      const expr = this.transpileExpression(item.expression);
      const alias = item.alias ?? this.expressionLabel(item.expression);
      selectItems.push(`${expr} AS "${alias}"`);
      columns.push(alias);
    }

    const distinct = query.return.distinct ? 'DISTINCT ' : '';

    // Detect aggregation: only known aggregate functions (COUNT, SUM, AVG, MIN, MAX, COLLECT)
    // trigger GROUP BY — scalar functions like TOLOWER, COALESCE are not aggregates.
    // Use positional GROUP BY references (e.g. GROUP BY 1, 3) to avoid re-transpiling
    // expressions, which would create duplicate parameter bindings.
    const hasAggregation = query.return.items.some((item) => isAggregate(item.expression));
    let groupByClause = '';
    if (hasAggregation) {
      const positions = query.return.items
        .map((item, index) => ({ index, isAgg: isAggregate(item.expression) }))
        .filter(({ isAgg }) => !isAgg)
        .map(({ index }) => index + 1);
      if (positions.length > 0) {
        groupByClause = ` GROUP BY ${positions.join(', ')}`;
      }
    }

    // Build alias map from RETURN items for resolving references in HAVING/ORDER BY
    const aliasMap = new Map<string, Expression>();
    for (const item of query.return.items) {
      if (item.alias) {
        aliasMap.set(item.alias, item.expression);
      }
    }

    // Build HAVING — resolve aliases to their underlying expressions since PostgreSQL
    // doesn't allow column aliases in HAVING
    let havingClause = '';
    if (query.having) {
      havingClause = ` HAVING ${this.transpileExpression(this.resolveAliases(query.having, aliasMap))}`;
    }

    // Build ORDER BY — PostgreSQL allows column aliases here, so just resolve to the alias name
    let orderByClause = '';
    if (query.orderBy?.length) {
      const parts = query.orderBy.map((o) => {
        const expr = o.expression;
        if (expr.kind === 'variable' && aliasMap.has(expr.name)) {
          return `"${expr.name}" ${o.direction}`;
        }
        return `${this.transpileExpression(expr)} ${o.direction}`;
      });
      orderByClause = ` ORDER BY ${parts.join(', ')}`;
    }

    // Apply a LIMIT only when the query asks for one or a cap is configured.
    // No explicit LIMIT and no cap → return all matching rows (unbounded).
    const explicitLimit = this.resolveOptionalIntParam(query.limit);
    const effectiveLimit =
      this.maxLimit === null
        ? explicitLimit
        : explicitLimit === null
          ? this.maxLimit
          : Math.min(explicitLimit, this.maxLimit);

    const fromSection = this.fromClauses.join(', ');
    const joinSection = this.joinClauses.length ? ' ' + this.joinClauses.join(' ') : '';
    const leftJoinSection = this.leftJoinClauses.length ? ' ' + this.leftJoinClauses.join(' ') : '';
    const whereSection = this.whereClauses.length
      ? ` WHERE ${this.whereClauses.join(' AND ')}`
      : '';
    const skipValue = this.resolveOptionalIntParam(query.skip);
    const skipClause = skipValue !== null ? ` OFFSET ${this.addParam(skipValue)}` : '';
    const limitClause =
      effectiveLimit !== null ? ` LIMIT ${this.addParam(effectiveLimit)}` : '';

    const sqlText = `SELECT ${distinct}${selectItems.join(', ')} FROM ${fromSection}${joinSection}${leftJoinSection}${whereSection}${groupByClause}${havingClause}${orderByClause}${limitClause}${skipClause}`;

    return { sql: sqlText, params: this.params, columns };
  }

  private processPattern(pattern: PatternPath, optional = false): void {
    const elements = pattern.elements;
    // Elements alternate: node, rel, node, rel, node...

    // Pre-assign stable variable names to anonymous nodes so the same
    // NodePattern gets a consistent identity across multiple bindNodePattern
    // calls (e.g. once from processRelationshipPattern, once from the loop).
    for (const el of elements) {
      if (el.kind === 'node' && !el.variable) {
        el.variable = this.nextAlias('_anon_');
      }
    }

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (el.kind === 'node') {
        if (optional) {
          // For OPTIONAL MATCH, only bind (create alias/type filter) — don't add to FROM.
          // New nodes will be introduced via LEFT JOIN in processRelationshipPattern.
          this.bindNodePattern(el);
        } else {
          this.processNodePattern(el);
        }
      } else if (el.kind === 'relationship') {
        const prevNode = elements[i - 1] as NodePattern;
        const nextNode = elements[i + 1] as NodePattern;
        this.processRelationshipPattern(el, prevNode, nextNode, optional);
      }
    }
  }

  private bindNodePattern(node: NodePattern): string {
    const variable = node.variable ?? this.nextAlias('_anon_');

    if (this.bindings.has(variable)) {
      return variable;
    }

    const alias = this.nextAlias('n');
    let nodeTypeId: string | undefined;

    if (node.label) {
      const nt = this.ontology.nodeTypes.get(node.label.toLowerCase());
      if (!nt) {
        // Name what exists so a caller (often an LLM) can self-correct
        // in one step instead of guessing.
        const available = [
          ...new Set([...this.ontology.nodeTypes.values()].map((v) => v.name)),
        ].sort();
        throw new TranspileError(
          `Unknown node type: ${node.label}. Available: ${available.join(', ')}`,
        );
      }
      nodeTypeId = nt.id;
      this.whereClauses.push(`${alias}.node_type_id = ${this.addParam(nodeTypeId)}`);
    }

    this.bindings.set(variable, { tableAlias: alias, nodeTypeId, isEdge: false });
    return variable;
  }

  private processNodePattern(node: NodePattern): void {
    const variable = this.bindNodePattern(node);
    const binding = this.bindings.get(variable)!;

    // Inside EXISTS { ... }, nodes bound by the outer query are referenced by
    // correlation and must not be re-added to the subquery's FROM.
    if (this.existsOuterAliases?.has(binding.tableAlias)) {
      return;
    }

    // Only add to FROM if not already added via JOIN
    if (
      !this.fromClauses.some((c) => c.includes(binding.tableAlias)) &&
      !this.joinClauses.some((c) => c.includes(`knowledge.node ${binding.tableAlias}`))
    ) {
      this.fromClauses.push(`knowledge.node ${binding.tableAlias}`);
    }
  }

  private isNodeAdded(tableAlias: string): boolean {
    // Outer-scope nodes are "already added" from the subquery's perspective —
    // relationship joins should anchor to the outer alias via correlation.
    if (this.existsOuterAliases?.has(tableAlias)) return true;
    return (
      this.fromClauses.some((c) => c.includes(tableAlias)) ||
      this.joinClauses.some((c) => c.includes(`knowledge.node ${tableAlias}`)) ||
      this.leftJoinClauses.some((c) => c.includes(`knowledge.node ${tableAlias}`))
    );
  }

  private processRelationshipPattern(
    rel: RelationshipPattern,
    prevNode: NodePattern,
    nextNode: NodePattern,
    optional = false,
  ): void {
    const edgeAlias = this.nextAlias('e');
    const prevBinding = this.bindings.get(prevNode.variable ?? '')!;
    const joinType = optional ? 'LEFT JOIN' : 'JOIN';
    const joinTarget = optional ? this.leftJoinClauses : this.joinClauses;

    // Bind the next node variable (get its alias) but don't add to FROM yet
    const nextVar = this.bindNodePattern(nextNode);
    const nextBinding = this.bindings.get(nextVar)!;

    const prevAdded = this.isNodeAdded(prevBinding.tableAlias);
    const nextAdded = this.isNodeAdded(nextBinding.tableAlias);

    // For optional joins, edge type filter goes in the ON clause instead of WHERE
    let edgeTypeCondition = '';
    if (rel.type) {
      const et = this.ontology.edgeTypes.get(rel.type.toLowerCase());
      if (!et) {
        const available = [...new Set(this.ontology.edgeTypes.keys())].sort();
        throw new TranspileError(
          `Unknown edge type: ${rel.type}. Available: ${available.join(', ')}`,
        );
      }
      if (optional) {
        edgeTypeCondition = ` AND ${edgeAlias}.edge_type_id = ${this.addParam(et.id)}`;
      } else {
        this.whereClauses.push(`${edgeAlias}.edge_type_id = ${this.addParam(et.id)}`);
      }
    }

    // For OPTIONAL MATCH: if prev node is NEW but next is KNOWN, anchor from the known node.
    // e.g. (p:Person)-[:Member Of]->(o) where o is known → LEFT JOIN edge ON edge.target=o.id, LEFT JOIN p ON p.id=edge.source
    if (optional && !prevAdded && nextAdded) {
      // Reverse: anchor from known (next) node, LEFT JOIN the new (prev) node
      const nodeTypeCondition = this.extractNodeTypeCondition(prevBinding);
      if (rel.direction === 'outgoing') {
        // Cypher: (new)-[]->(known) → edge.target = known, edge.source = new
        joinTarget.push(
          `LEFT JOIN knowledge.edge ${edgeAlias} ON ${edgeAlias}.target_node_id = ${nextBinding.tableAlias}.id${edgeTypeCondition}`,
        );
        joinTarget.push(
          `LEFT JOIN knowledge.node ${prevBinding.tableAlias} ON ${prevBinding.tableAlias}.id = ${edgeAlias}.source_node_id${nodeTypeCondition}`,
        );
      } else if (rel.direction === 'incoming') {
        // Cypher: (new)<-[]-(known) → edge.source = known, edge.target = new
        joinTarget.push(
          `LEFT JOIN knowledge.edge ${edgeAlias} ON ${edgeAlias}.source_node_id = ${nextBinding.tableAlias}.id${edgeTypeCondition}`,
        );
        joinTarget.push(
          `LEFT JOIN knowledge.node ${prevBinding.tableAlias} ON ${prevBinding.tableAlias}.id = ${edgeAlias}.target_node_id${nodeTypeCondition}`,
        );
      } else {
        joinTarget.push(
          `LEFT JOIN knowledge.edge ${edgeAlias} ON (${edgeAlias}.source_node_id = ${nextBinding.tableAlias}.id OR ${edgeAlias}.target_node_id = ${nextBinding.tableAlias}.id)${edgeTypeCondition}`,
        );
        joinTarget.push(
          `LEFT JOIN knowledge.node ${prevBinding.tableAlias} ON (${prevBinding.tableAlias}.id = ${edgeAlias}.target_node_id OR ${prevBinding.tableAlias}.id = ${edgeAlias}.source_node_id) AND ${prevBinding.tableAlias}.id != ${nextBinding.tableAlias}.id${nodeTypeCondition}`,
        );
      }
    } else if (rel.direction === 'outgoing') {
      joinTarget.push(
        `${joinType} knowledge.edge ${edgeAlias} ON ${edgeAlias}.source_node_id = ${prevBinding.tableAlias}.id${edgeTypeCondition}`,
      );
      if (!nextAdded) {
        joinTarget.push(
          `${joinType} knowledge.node ${nextBinding.tableAlias} ON ${nextBinding.tableAlias}.id = ${edgeAlias}.target_node_id`,
        );
      } else if (!optional) {
        this.whereClauses.push(
          `${edgeAlias}.target_node_id = ${nextBinding.tableAlias}.id`,
        );
      } else {
        // Both known in optional — add target constraint to ON clause
        const lastIdx = joinTarget.length - 1;
        joinTarget[lastIdx] += ` AND ${edgeAlias}.target_node_id = ${nextBinding.tableAlias}.id`;
      }
    } else if (rel.direction === 'incoming') {
      joinTarget.push(
        `${joinType} knowledge.edge ${edgeAlias} ON ${edgeAlias}.target_node_id = ${prevBinding.tableAlias}.id${edgeTypeCondition}`,
      );
      if (!nextAdded) {
        joinTarget.push(
          `${joinType} knowledge.node ${nextBinding.tableAlias} ON ${nextBinding.tableAlias}.id = ${edgeAlias}.source_node_id`,
        );
      } else if (!optional) {
        this.whereClauses.push(
          `${edgeAlias}.source_node_id = ${nextBinding.tableAlias}.id`,
        );
      } else {
        const lastIdx = joinTarget.length - 1;
        joinTarget[lastIdx] += ` AND ${edgeAlias}.source_node_id = ${nextBinding.tableAlias}.id`;
      }
    } else {
      joinTarget.push(
        `${joinType} knowledge.edge ${edgeAlias} ON (${edgeAlias}.source_node_id = ${prevBinding.tableAlias}.id OR ${edgeAlias}.target_node_id = ${prevBinding.tableAlias}.id)${edgeTypeCondition}`,
      );
      if (!nextAdded) {
        joinTarget.push(
          `${joinType} knowledge.node ${nextBinding.tableAlias} ON (${nextBinding.tableAlias}.id = ${edgeAlias}.target_node_id OR ${nextBinding.tableAlias}.id = ${edgeAlias}.source_node_id) AND ${nextBinding.tableAlias}.id != ${prevBinding.tableAlias}.id`,
        );
      } else if (!optional) {
        this.whereClauses.push(
          `(${edgeAlias}.target_node_id = ${nextBinding.tableAlias}.id OR ${edgeAlias}.source_node_id = ${nextBinding.tableAlias}.id)`,
        );
      }
    }

    if (rel.variable) {
      this.bindings.set(rel.variable, { tableAlias: edgeAlias, isEdge: true });
    }
  }

  // Extract node_type_id filter from WHERE and return it as a JOIN ON condition
  // (putting it in WHERE would turn LEFT JOIN into INNER JOIN)
  private extractNodeTypeCondition(binding: VariableBinding): string {
    if (!binding.nodeTypeId) return '';
    const whereIdx = this.whereClauses.findIndex((c) =>
      c.includes(`${binding.tableAlias}.node_type_id`),
    );
    if (whereIdx >= 0) {
      const condition = this.whereClauses[whereIdx];
      this.whereClauses.splice(whereIdx, 1);
      return ` AND ${condition}`;
    }
    return '';
  }

  private transpileExpression(expr: Expression): string {
    switch (expr.kind) {
      case 'property_access': {
        const binding = this.bindings.get(expr.variable);
        if (!binding) {
          throw new TranspileError(`Unknown variable: ${expr.variable}`);
        }

        if (binding.isEdge) {
          return `knowledge.edge_prop(${binding.tableAlias}.id, ${this.addParam(expr.property)})`;
        }

        // Meta fields are direct columns on the node table
        const metaColumn = NODE_META_FIELDS[expr.property.toLowerCase()];
        if (metaColumn) {
          return `${binding.tableAlias}.${metaColumn}`;
        }

        // Resolve to canonical DB name (case-insensitive lookup) and typed accessor
        const propType = this.resolvePropertyType(binding.nodeTypeId, expr.property);
        const accessor = propType ? propAccessor(propType.valueType) : 'knowledge.prop';
        const propName = propType?.name ?? expr.property;
        return `${accessor}(${binding.tableAlias}.id, ${this.addParam(propName)})`;
      }

      case 'variable': {
        const binding = this.bindings.get(expr.name);
        if (!binding) {
          throw new TranspileError(`Unknown variable: ${expr.name}`);
        }
        return `${binding.tableAlias}.id`;
      }

      case 'parameter': {
        if (!(expr.name in this.cypherParams)) {
          throw new TranspileError(`Missing parameter: $${expr.name}`);
        }
        const paramValue = this.cypherParams[expr.name];
        if (paramValue === null) return 'NULL';
        return this.addParam(paramValue);
      }

      case 'literal': {
        if (expr.value === null) return 'NULL';
        return this.addParam(expr.value);
      }

      case 'binary': {
        const left = this.transpileExpression(expr.left);
        const right = this.transpileExpression(expr.right);

        switch (expr.operator) {
          case 'CONTAINS':
            return `${left} ILIKE '%' || ${right} || '%'`;
          case 'STARTS WITH':
            return `${left} ILIKE ${right} || '%'`;
          case 'ENDS WITH':
            return `${left} ILIKE '%' || ${right}`;
          case '+':
          case '-':
          case '*':
          case '/':
          case '%':
            return `(${left} ${expr.operator} ${right})`;
          case 'AND':
            return `(${left} AND ${right})`;
          case 'OR':
            return `(${left} OR ${right})`;
          default:
            return `${left} ${expr.operator} ${right}`;
        }
      }

      case 'unary':
        return `NOT (${this.transpileExpression(expr.operand)})`;

      case 'is_null':
        return expr.negated
          ? `${this.transpileExpression(expr.operand)} IS NOT NULL`
          : `${this.transpileExpression(expr.operand)} IS NULL`;

      case 'list': {
        const elements = expr.elements.map((e) => this.transpileExpression(e));
        return `(${elements.join(', ')})`;
      }

      case 'in': {
        const operand = this.transpileExpression(expr.operand);
        // Array-valued parameters use ANY/ALL (PG can't expand an array into an IN list).
        if (expr.list.kind === 'parameter') {
          if (!(expr.list.name in this.cypherParams)) {
            throw new TranspileError(`Missing parameter: $${expr.list.name}`);
          }
          const value = this.cypherParams[expr.list.name];
          if (Array.isArray(value)) {
            const placeholder = this.addParam(value);
            return expr.negated
              ? `${operand} <> ALL(${placeholder})`
              : `${operand} = ANY(${placeholder})`;
          }
        }
        const list = this.transpileExpression(expr.list);
        return expr.negated ? `${operand} NOT IN ${list}` : `${operand} IN ${list}`;
      }

      case 'map': {
        const pairs = expr.entries.flatMap((e) => [
          this.addParam(e.key),
          this.transpileExpression(e.value),
        ]);
        return `jsonb_build_object(${pairs.join(', ')})`;
      }

      case 'function_call': {
        const name = expr.name.toUpperCase();
        const distinct = expr.distinct ? 'DISTINCT ' : '';
        if (name === 'DATE' && expr.args.length === 0) {
          return 'CURRENT_DATE';
        }
        if (name === 'DURATION' && expr.args.length === 1 && expr.args[0].kind === 'literal') {
          return `INTERVAL '${isoDurationToInterval(String(expr.args[0].value))}'`;
        }
        if (name === 'COUNT' && expr.args.length === 0) {
          return 'COUNT(*)';
        }
        // id(n) resolves to the node table's primary-key column.
        if (name === 'ID') {
          if (expr.args.length !== 1 || expr.args[0].kind !== 'variable') {
            throw new TranspileError('id() requires a single variable argument');
          }
          return this.transpileExpression(expr.args[0]);
        }
        const args = expr.args.map((a) => this.transpileExpression(a));
        // Map Cypher functions to PostgreSQL equivalents
        const sqlName = FUNCTION_MAP[name] ?? name;
        if (CAST_FUNCTIONS[name]) {
          return `CAST(${args[0]} AS ${CAST_FUNCTIONS[name]})`;
        }
        return `${sqlName}(${distinct}${args.join(', ')})`;
      }

      case 'exists_subquery':
        return this.transpileExistsSubquery(expr);

      case 'case': {
        const parts = ['CASE'];
        for (const w of expr.whens) {
          parts.push(`WHEN ${this.transpileExpression(w.condition)} THEN ${this.transpileExpression(w.result)}`);
        }
        if (expr.elseResult) {
          parts.push(`ELSE ${this.transpileExpression(expr.elseResult)}`);
        }
        parts.push('END');
        return parts.join(' ');
      }

      default:
        throw new TranspileError(`Unsupported expression type: ${(expr as Expression).kind}`);
    }
  }

  private transpileExistsSubquery(expr: ExistsSubquery): string {
    // Save outer scope state so we can restore after generating the subquery SQL.
    const savedFrom = this.fromClauses;
    const savedJoin = this.joinClauses;
    const savedLeftJoin = this.leftJoinClauses;
    const savedWhere = this.whereClauses;
    const savedExistsOuter = this.existsOuterAliases;

    const outerBindingKeys = new Set(this.bindings.keys());
    const outerAliases = new Set<string>();
    for (const [, b] of this.bindings) {
      if (!b.isEdge) outerAliases.add(b.tableAlias);
    }

    // Subquery builds its own FROM/JOIN/WHERE lists, but shares `this.bindings`
    // and `this.params` so outer-correlated aliases and the parameter list work.
    this.fromClauses = [];
    this.joinClauses = [];
    this.leftJoinClauses = [];
    this.whereClauses = [];
    this.existsOuterAliases = outerAliases;

    for (const pattern of expr.match.patterns) {
      this.processPattern(pattern);
    }

    // Inline node property predicates on newly-bound nodes.
    for (const pattern of expr.match.patterns) {
      for (const el of pattern.elements) {
        if (el.kind === 'node' && el.properties) {
          const variable = el.variable ?? '';
          const binding = this.bindings.get(variable);
          if (binding && !outerBindingKeys.has(variable)) {
            for (const { key, value } of el.properties) {
              const propExpr: Expression = { kind: 'property_access', variable, property: key };
              const condition: Expression = { kind: 'binary', operator: '=', left: propExpr, right: value };
              this.whereClauses.push(this.transpileExpression(condition));
            }
          }
        }
      }
    }

    // Team scoping only for nodes newly bound inside the subquery.
    for (const [varName, binding] of this.bindings) {
      if (!outerBindingKeys.has(varName) && !binding.isEdge) {
        this.whereClauses.push(`${binding.tableAlias}.team_id = ${this.addParam(this.teamId)}`);
      }
    }

    if (expr.where) {
      this.whereClauses.push(this.transpileExpression(expr.where));
    }

    // If every pattern element attached via a correlated JOIN (no standalone node
    // was added to FROM), promote the first JOIN into the FROM clause so the
    // subquery is syntactically `SELECT 1 FROM <table> <alias> [JOIN ...]`.
    if (this.fromClauses.length === 0 && this.joinClauses.length > 0) {
      const first = this.joinClauses.shift()!;
      const m = first.match(/^JOIN\s+(\S+)\s+(\S+)\s+ON\s+(.+)$/s);
      if (m) {
        const [, table, alias, onPred] = m;
        this.fromClauses.push(`${table} ${alias}`);
        this.whereClauses.unshift(onPred);
      } else {
        this.joinClauses.unshift(first);
      }
    }

    const fromSection = this.fromClauses.join(', ');
    const joinSection = this.joinClauses.length ? ' ' + this.joinClauses.join(' ') : '';
    const leftJoinSection = this.leftJoinClauses.length ? ' ' + this.leftJoinClauses.join(' ') : '';
    const whereSection = this.whereClauses.length
      ? ` WHERE ${this.whereClauses.join(' AND ')}`
      : '';
    const sql = `EXISTS (SELECT 1 FROM ${fromSection}${joinSection}${leftJoinSection}${whereSection})`;

    // Restore outer state and drop bindings introduced inside the subquery.
    this.fromClauses = savedFrom;
    this.joinClauses = savedJoin;
    this.leftJoinClauses = savedLeftJoin;
    this.whereClauses = savedWhere;
    this.existsOuterAliases = savedExistsOuter;
    for (const varName of Array.from(this.bindings.keys())) {
      if (!outerBindingKeys.has(varName)) this.bindings.delete(varName);
    }

    return sql;
  }

  private resolvePropertyType(
    nodeTypeId: string | undefined,
    propertyName: string,
  ): { id: string; valueType: string; name: string } | undefined {
    if (!nodeTypeId) return undefined;
    return this.ontology.propertyTypes.get(nodeTypeId)?.get(propertyName.toLowerCase());
  }

  private resolveAliases(expr: Expression, aliasMap: Map<string, Expression>): Expression {
    if (expr.kind === 'variable' && aliasMap.has(expr.name)) {
      return aliasMap.get(expr.name)!;
    }
    if (expr.kind === 'binary') {
      return {
        ...expr,
        left: this.resolveAliases(expr.left, aliasMap),
        right: this.resolveAliases(expr.right, aliasMap),
      };
    }
    if (expr.kind === 'unary') {
      return { ...expr, operand: this.resolveAliases(expr.operand, aliasMap) };
    }
    if (expr.kind === 'is_null') {
      return { ...expr, operand: this.resolveAliases(expr.operand, aliasMap) };
    }
    if (expr.kind === 'in') {
      return {
        ...expr,
        operand: this.resolveAliases(expr.operand, aliasMap),
        list: this.resolveAliases(expr.list, aliasMap),
      };
    }
    if (expr.kind === 'function_call') {
      return { ...expr, args: expr.args.map((a) => this.resolveAliases(a, aliasMap)) };
    }
    if (expr.kind === 'map') {
      return { ...expr, entries: expr.entries.map((e) => ({ ...e, value: this.resolveAliases(e.value, aliasMap) })) };
    }
    if (expr.kind === 'case') {
      return {
        ...expr,
        whens: expr.whens.map((w) => ({
          condition: this.resolveAliases(w.condition, aliasMap),
          result: this.resolveAliases(w.result, aliasMap),
        })),
        ...(expr.elseResult ? { elseResult: this.resolveAliases(expr.elseResult, aliasMap) } : {}),
      };
    }
    return expr;
  }

  private expressionLabel(expr: Expression): string {
    switch (expr.kind) {
      case 'property_access': {
        const binding = this.bindings.get(expr.variable);
        const propType = binding ? this.resolvePropertyType(binding.nodeTypeId, expr.property) : undefined;
        return propType?.name ?? expr.property;
      }
      case 'variable':
        return expr.name;
      case 'function_call':
        return `${expr.name.toLowerCase()}(${expr.args.map((a) => this.expressionLabel(a)).join(', ')})`;
      default:
        return 'expr';
    }
  }
}

function propAccessor(valueType: string): string {
  switch (valueType) {
    case 'number':
      return 'knowledge.prop_num';
    case 'boolean':
      return 'knowledge.prop_bool';
    case 'date':
      return 'knowledge.prop_date';
    default:
      return 'knowledge.prop';
  }
}

class TranspileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CypherTranspileError';
  }
}

export function transpile(
  query: CypherQuery,
  ontology: OntologyCache,
  teamId: string,
  maxLimit: number | null = null,
  cypherParams: CypherParams = {},
): TranspileResult {
  return new Transpiler(ontology, teamId, maxLimit, cypherParams).transpile(query);
}

export { TranspileError };
