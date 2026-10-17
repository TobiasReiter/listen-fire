/**
 * Export one team's knowledge graph into a self-describing SQLite file for an
 * AI agent that only has SQL access — no app code, no ORM, no context on our
 * node/edge/property model.
 *
 * The source model is generic: node types + edge types + property types
 * define an ontology, and node/edge/property rows are its data, sparse by
 * design (a property row simply doesn't exist when a value is unset). That
 * shape is great for a schema-flexible app but illegible to an agent doing
 * `SELECT * FROM property WHERE ...` — it would have to reconstruct the
 * ontology itself. So this script flattens it: one physical table per node
 * type, one per edge type, real columns instead of EAV rows, real FOREIGN
 * KEY constraints instead of a generic `edge` join table, and a handful of
 * underscore-prefixed meta tables (`_overview`, `_tables`, `_columns`,
 * `_relationships`) that tell the agent what it's looking at before it reads
 * a single data row.
 *
 * Usage:
 *   pnpm export:kg-sqlite --team <uuid> --out <path>
 *
 * Read-only against Postgres. Refuses to overwrite an existing --out file.
 */
import fs from "node:fs";
import path from "node:path";

import Database from 'better-sqlite3';

import type { TeamId } from '../generated/kysely/core/Team';
import type { NodeTypeId } from '../generated/kysely/knowledge/NodeType';
import type { EdgeTypeId } from '../generated/kysely/knowledge/EdgeType';
import type { NodeId } from '../generated/kysely/knowledge/Node';
import type { EdgeId } from '../generated/kysely/knowledge/Edge';
import type { LinkedObjectId } from '../generated/kysely/knowledge/LinkedObject';
import type { RecordBindingId } from '../generated/kysely/automations/RecordBinding';
import type { PropertyTypeId } from '../generated/kysely/knowledge/PropertyType';
import type { Property } from '../generated/kysely/knowledge/Property';

import { KG_ADAPTER_TYPE } from '../services/translation_graph/adapters/knowledge_graph';
import { logger } from 'movement-engine/public/log';
import { neverAsAny } from 'movement-engine/public/utils';
import { getAutomationsQb, getCoreQb, getKnowledgeQb } from '../lib/kysely';
import PropertyValueType from '../generated/kysely/knowledge/PropertyValueType';
import PropertyCardinality from '../generated/kysely/knowledge/PropertyCardinality';

const PAGE_SIZE = 500;

// Reserved SQLite keywords (https://sqlite.org/lang_keywords.html) — a
// sanitized name that collides with one gets a trailing underscore.
const SQLITE_KEYWORDS = new Set([
  'ABORT', 'ACTION', 'ADD', 'AFTER', 'ALL', 'ALTER', 'ALWAYS', 'ANALYZE', 'AND', 'AS', 'ASC',
  'ATTACH', 'AUTOINCREMENT', 'BEFORE', 'BEGIN', 'BETWEEN', 'BY', 'CASCADE', 'CASE', 'CAST',
  'CHECK', 'COLLATE', 'COLUMN', 'COMMIT', 'CONFLICT', 'CONSTRAINT', 'CREATE', 'CROSS', 'CURRENT',
  'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'DATABASE', 'DEFAULT', 'DEFERRABLE',
  'DEFERRED', 'DELETE', 'DESC', 'DETACH', 'DISTINCT', 'DO', 'DROP', 'EACH', 'ELSE', 'END',
  'ESCAPE', 'EXCEPT', 'EXCLUDE', 'EXCLUSIVE', 'EXISTS', 'EXPLAIN', 'FAIL', 'FILTER', 'FIRST',
  'FOLLOWING', 'FOR', 'FOREIGN', 'FROM', 'FULL', 'GENERATED', 'GLOB', 'GROUP', 'GROUPS',
  'HAVING', 'IF', 'IGNORE', 'IMMEDIATE', 'IN', 'INDEX', 'INDEXED', 'INITIALLY', 'INNER',
  'INSERT', 'INSTEAD', 'INTERSECT', 'INTO', 'IS', 'ISNULL', 'JOIN', 'KEY', 'LAST', 'LEFT',
  'LIKE', 'LIMIT', 'MATCH', 'MATERIALIZED', 'NATURAL', 'NO', 'NOT', 'NOTHING', 'NOTNULL',
  'NULL', 'NULLS', 'OF', 'OFFSET', 'ON', 'OR', 'ORDER', 'OTHERS', 'OUTER', 'OVER', 'PARTITION',
  'PLAN', 'PRAGMA', 'PRECEDING', 'PRIMARY', 'QUERY', 'RAISE', 'RANGE', 'RECURSIVE',
  'REFERENCES', 'REGEXP', 'REINDEX', 'RELEASE', 'RENAME', 'REPLACE', 'RESTRICT', 'RETURNING',
  'RIGHT', 'ROLLBACK', 'ROW', 'ROWS', 'SAVEPOINT', 'SELECT', 'SET', 'TABLE', 'TEMP',
  'TEMPORARY', 'THEN', 'TIES', 'TO', 'TRANSACTION', 'TRIGGER', 'UNBOUNDED', 'UNION', 'UNIQUE',
  'UPDATE', 'USING', 'VACUUM', 'VALUES', 'VIEW', 'VIRTUAL', 'WHEN', 'WHERE', 'WINDOW', 'WITH',
  'WITHOUT',
]);

/**
 * Lower snake_case, alphanumerics only. Not a bijection — collisions are the
 * caller's job via `dedupeIdentifier`.
 */
function sanitizeIdentifier(rawName: string): string {
  let base = rawName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (base === '') base = 't_unnamed';
  if (/^[0-9]/.test(base)) base = `t_${base}`;
  if (SQLITE_KEYWORDS.has(base.toUpperCase())) base = `${base}_`;
  return base;
}

/** Registers `candidate` in `used`, suffixing `_2`, `_3`, … on collision. */
function dedupeIdentifier(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let suffix = 2;
  let attempt = `${candidate}_${suffix}`;
  while (used.has(attempt)) {
    suffix += 1;
    attempt = `${candidate}_${suffix}`;
  }
  used.add(attempt);
  return attempt;
}

function valueTypeToSqliteType(valueType: PropertyValueType): 'TEXT' | 'REAL' | 'INTEGER' {
  switch (valueType) {
    case PropertyValueType.text:
      return 'TEXT';
    case PropertyValueType.number:
      return 'REAL';
    case PropertyValueType.boolean:
      return 'INTEGER';
    case PropertyValueType.date:
      return 'TEXT';
    case PropertyValueType.json:
      return 'TEXT';
    default:
      return neverAsAny(valueType);
  }
}

type PropertyValueRow = Pick<
  Property,
  'value_text' | 'value_text_array' | 'value_number' | 'value_boolean' | 'value_date' | 'value_json'
>;

/** Pivots one sparse `property` row into the scalar/JSON value its column stores. */
function serializePropertyValue(
  valueType: PropertyValueType,
  cardinality: PropertyCardinality,
  row: PropertyValueRow | undefined,
): string | number | null {
  if (row === undefined) return null;
  switch (valueType) {
    case PropertyValueType.text:
      if (cardinality === PropertyCardinality.multi) {
        return row.value_text_array !== null ? JSON.stringify(row.value_text_array) : null;
      }
      return row.value_text;
    case PropertyValueType.number:
      return row.value_number !== null ? Number(row.value_number) : null;
    case PropertyValueType.boolean:
      return row.value_boolean === null ? null : row.value_boolean ? 1 : 0;
    case PropertyValueType.date:
      return row.value_date !== null ? row.value_date.toISOString() : null;
    case PropertyValueType.json:
      return row.value_json !== null ? JSON.stringify(row.value_json) : null;
    default:
      return neverAsAny(valueType);
  }
}

/** One `record_binding` endpoint's four stored columns (a_* or b_*), as plain
 *  strings — see services/movement_engine/record_binding.ts for the encoder
 *  that produces them. */
interface BindingEndpointColumns {
  adapterType: string;
  instanceKey: string;
  typeId: string;
  recordId: string;
}

type BindingOrientation =
  | { kind: 'kg'; kgEndpoint: BindingEndpointColumns; otherEndpoint: BindingEndpointColumns }
  | { kind: 'both_kg' }
  | { kind: 'neither_kg' };

/**
 * `record_binding` stores its two endpoints as unordered a/b columns —
 * canonically ordered by encoded key (record_binding.ts:130-137), not by
 * "which side is the KG". This picks the KG side out and returns the other
 * endpoint as the external record, or flags the degenerate cases (both sides
 * KG, neither side KG) the caller must skip rather than emit a self-link or a
 * link with no external counterpart for.
 */
function selectKgEndpoint(row: { a: BindingEndpointColumns; b: BindingEndpointColumns }, kgAdapterType: string): BindingOrientation {
  const aIsKg = row.a.adapterType === kgAdapterType;
  const bIsKg = row.b.adapterType === kgAdapterType;
  if (aIsKg && bIsKg) return { kind: 'both_kg' };
  if (aIsKg) return { kind: 'kg', kgEndpoint: row.a, otherEndpoint: row.b };
  if (bIsKg) return { kind: 'kg', kgEndpoint: row.b, otherEndpoint: row.a };
  return { kind: 'neither_kg' };
}

interface ColumnPlan {
  propertyTypeId: PropertyTypeId;
  columnName: string;
  originalName: string;
  valueType: PropertyValueType;
  cardinality: PropertyCardinality;
  enumValues: string[] | null;
  description: string;
  sqliteType: 'TEXT' | 'REAL' | 'INTEGER';
}

interface EntityTablePlan {
  nodeTypeId: NodeTypeId;
  tableName: string;
  originalName: string;
  description: string;
  columns: ColumnPlan[];
}

interface RelationshipTablePlan {
  edgeTypeId: EdgeTypeId;
  tableName: string;
  sourceTable: string;
  targetTable: string;
  sourceNodeTypeId: NodeTypeId;
  targetNodeTypeId: NodeTypeId;
  outboundName: string;
  inboundName: string;
  description: string;
  columns: ColumnPlan[];
}

function parseArgs(argv: string[]): { team?: string; out?: string } {
  const out: { team?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--team') out.team = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
  }
  return out;
}

function buildColumnPlans(
  propertyTypes: {
    id: PropertyTypeId;
    name: string;
    description: string;
    value_type: PropertyValueType;
    cardinality: PropertyCardinality;
    enum_values: string[] | null;
  }[],
  reservedColumnNames: string[],
): ColumnPlan[] {
  const usedColumns = new Set<string>(reservedColumnNames);
  return propertyTypes.map((pt) => ({
    propertyTypeId: pt.id,
    columnName: dedupeIdentifier(sanitizeIdentifier(pt.name), usedColumns),
    originalName: pt.name,
    valueType: pt.value_type,
    cardinality: pt.cardinality,
    enumValues: pt.enum_values,
    description: pt.description,
    sqliteType: valueTypeToSqliteType(pt.value_type),
  }));
}

async function populateEntityTable(
  db: Database.Database,
  teamId: TeamId,
  plan: EntityTablePlan,
): Promise<void> {
  const insertCols = ['id', 'summary', ...plan.columns.map((c) => c.columnName)];
  const stmt = db.prepare(
    `INSERT INTO "${plan.tableName}" (${insertCols.map((c) => `"${c}"`).join(', ')}) VALUES (${insertCols
      .map(() => '?')
      .join(', ')})`,
  );

  let afterId: NodeId | null = null;
  for (;;) {
    let query = getKnowledgeQb(['node'])
      .selectFrom('node')
      .where('team_id', '=', teamId)
      .where('node_type_id', '=', plan.nodeTypeId)
      .orderBy('id', 'asc')
      .limit(PAGE_SIZE)
      .select(['id', 'summary']);
    if (afterId !== null) query = query.where('id', '>', afterId);
    // eslint-disable-next-line no-await-in-loop
    const nodes = await query.execute();
    if (nodes.length === 0) break;

    const nodeIds = nodes.map((n) => n.id);
    const properties =
      plan.columns.length === 0
        ? []
        : // eslint-disable-next-line no-await-in-loop
          await getKnowledgeQb(['property'])
            .selectFrom('property')
            .where('team_id', '=', teamId)
            .where('node_id', 'in', nodeIds)
            .select([
              'node_id',
              'property_type_id',
              'value_text',
              'value_text_array',
              'value_number',
              'value_date',
              'value_boolean',
              'value_json',
            ])
            .execute();

    const propsByNode = new Map<NodeId, Map<PropertyTypeId, (typeof properties)[number]>>();
    for (const p of properties) {
      if (p.node_id === null) continue;
      let byType = propsByNode.get(p.node_id);
      if (!byType) {
        byType = new Map();
        propsByNode.set(p.node_id, byType);
      }
      byType.set(p.property_type_id, p);
    }

    for (const node of nodes) {
      const nodeProps = propsByNode.get(node.id);
      const values: (string | number | null)[] = [node.id, node.summary];
      for (const col of plan.columns) {
        values.push(serializePropertyValue(col.valueType, col.cardinality, nodeProps?.get(col.propertyTypeId)));
      }
      stmt.run(...values);
    }

    afterId = nodes[nodes.length - 1].id;
    if (nodes.length < PAGE_SIZE) break;
  }
}

async function populateRelationshipTable(
  db: Database.Database,
  teamId: TeamId,
  plan: RelationshipTablePlan,
): Promise<void> {
  const insertCols = ['id', 'source_id', 'target_id', ...plan.columns.map((c) => c.columnName)];
  const stmt = db.prepare(
    `INSERT INTO "${plan.tableName}" (${insertCols.map((c) => `"${c}"`).join(', ')}) VALUES (${insertCols
      .map(() => '?')
      .join(', ')})`,
  );

  let afterId: EdgeId | null = null;
  for (;;) {
    let query = getKnowledgeQb(['edge'])
      .selectFrom('edge')
      .where('team_id', '=', teamId)
      .where('edge_type_id', '=', plan.edgeTypeId)
      .orderBy('id', 'asc')
      .limit(PAGE_SIZE)
      .select(['id', 'source_node_id', 'target_node_id']);
    if (afterId !== null) query = query.where('id', '>', afterId);
    // eslint-disable-next-line no-await-in-loop
    const edges = await query.execute();
    if (edges.length === 0) break;

    const edgeIds = edges.map((e) => e.id);
    const properties =
      plan.columns.length === 0
        ? []
        : // eslint-disable-next-line no-await-in-loop
          await getKnowledgeQb(['property'])
            .selectFrom('property')
            .where('team_id', '=', teamId)
            .where('edge_id', 'in', edgeIds)
            .select([
              'edge_id',
              'property_type_id',
              'value_text',
              'value_text_array',
              'value_number',
              'value_date',
              'value_boolean',
              'value_json',
            ])
            .execute();

    const propsByEdge = new Map<EdgeId, Map<PropertyTypeId, (typeof properties)[number]>>();
    for (const p of properties) {
      if (p.edge_id === null) continue;
      let byType = propsByEdge.get(p.edge_id);
      if (!byType) {
        byType = new Map();
        propsByEdge.set(p.edge_id, byType);
      }
      byType.set(p.property_type_id, p);
    }

    for (const edge of edges) {
      const edgeProps = propsByEdge.get(edge.id);
      const values: (string | number | null)[] = [edge.id, edge.source_node_id, edge.target_node_id];
      for (const col of plan.columns) {
        values.push(serializePropertyValue(col.valueType, col.cardinality, edgeProps?.get(col.propertyTypeId)));
      }
      stmt.run(...values);
    }

    afterId = edges[edges.length - 1].id;
    if (edges.length < PAGE_SIZE) break;
  }
}

/** Batch-resolves each node's node_type_id, scoped to this team — the shared
 *  "does this linked node still exist, and what entity table is it in" check
 *  both external_links sources need. Nodes absent from the map either don't
 *  exist (deleted, or belong to another team) or aren't in this export. */
async function fetchNodeTypesByNodeId(teamId: TeamId, nodeIds: NodeId[]): Promise<Map<NodeId, NodeTypeId>> {
  if (nodeIds.length === 0) return new Map();
  const rows = await getKnowledgeQb(['node'])
    .selectFrom('node')
    .where('team_id', '=', teamId)
    .where('id', 'in', nodeIds)
    .select(['id', 'node_type_id'])
    .execute();
  return new Map(rows.map((r) => [r.id, r.node_type_id]));
}

/**
 * `external_links` rows sourced from `knowledge.linked_object` — the legacy
 * pipeline retrieval/output correspondence store. Deliberately omits `data`
 * (identity mapping only, see file header decision).
 */
async function populateExternalLinksFromLinkedObject(
  teamId: TeamId,
  entityPlanByNodeType: Map<NodeTypeId, EntityTablePlan>,
  stmt: Database.Statement,
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  let afterId: LinkedObjectId | null = null;
  for (;;) {
    let query = getKnowledgeQb(['linked_object'])
      .selectFrom('linked_object')
      .where('team_id', '=', teamId)
      .orderBy('id', 'asc')
      .limit(PAGE_SIZE)
      .select(['id', 'node_id', 'adapter_type', 'external_id', 'external_object_type']);
    if (afterId !== null) query = query.where('id', '>', afterId);
    // eslint-disable-next-line no-await-in-loop
    const rows = await query.execute();
    if (rows.length === 0) break;

    // eslint-disable-next-line no-await-in-loop
    const nodeTypeByNodeId = await fetchNodeTypesByNodeId(
      teamId,
      rows.map((r) => r.node_id),
    );

    for (const row of rows) {
      const nodeTypeId = nodeTypeByNodeId.get(row.node_id);
      const entityPlan = nodeTypeId !== undefined ? entityPlanByNodeType.get(nodeTypeId) : undefined;
      if (entityPlan === undefined) {
        skipped += 1;
        continue;
      }
      stmt.run(entityPlan.tableName, row.node_id, row.adapter_type, null, row.external_object_type, row.external_id, 'linked_object');
      inserted += 1;
    }

    afterId = rows[rows.length - 1].id;
    if (rows.length < PAGE_SIZE) break;
  }
  return { inserted, skipped };
}

/**
 * `external_links` rows sourced from `public.record_binding` — the
 * engine-owned symmetric bind store. Only rows where exactly one endpoint is
 * the KG (`adapter_type = KG_ADAPTER_TYPE`, already the normalized form —
 * see record_binding.ts:108-120) contribute a link; KG↔KG bindings are
 * skipped and counted, not emitted twice.
 */
async function populateExternalLinksFromRecordBinding(
  teamId: TeamId,
  entityPlanByNodeType: Map<NodeTypeId, EntityTablePlan>,
  stmt: Database.Statement,
): Promise<{ inserted: number; skippedBothKg: number; skippedMissingNode: number }> {
  let inserted = 0;
  let skippedBothKg = 0;
  let skippedMissingNode = 0;
  let afterId: RecordBindingId | null = null;
  for (;;) {
    let query = getAutomationsQb(['record_binding'])
      .selectFrom('record_binding')
      .where('team_id', '=', teamId)
      .where((eb) => eb.or([eb('a_adapter_type', '=', KG_ADAPTER_TYPE), eb('b_adapter_type', '=', KG_ADAPTER_TYPE)]))
      .orderBy('id', 'asc')
      .limit(PAGE_SIZE)
      .select([
        'id',
        'a_adapter_type',
        'a_instance_key',
        'a_type_id',
        'a_record_id',
        'b_adapter_type',
        'b_instance_key',
        'b_type_id',
        'b_record_id',
      ]);
    if (afterId !== null) query = query.where('id', '>', afterId);
    // eslint-disable-next-line no-await-in-loop
    const rows = await query.execute();
    if (rows.length === 0) break;

    const orientations = rows.map((row) =>
      selectKgEndpoint(
        {
          a: { adapterType: row.a_adapter_type, instanceKey: row.a_instance_key, typeId: row.a_type_id, recordId: row.a_record_id },
          b: { adapterType: row.b_adapter_type, instanceKey: row.b_instance_key, typeId: row.b_type_id, recordId: row.b_record_id },
        },
        KG_ADAPTER_TYPE,
      ),
    );

    // The KG endpoint's recordId is a node id (record_binding.ts:36-37,
    // 74-75) — validate it against the live node table before trusting it,
    // same as the linked_object path.
    const kgNodeIds: NodeId[] = [];
    for (const orientation of orientations) {
      if (orientation.kind === 'kg') kgNodeIds.push(orientation.kgEndpoint.recordId as NodeId);
    }
    // eslint-disable-next-line no-await-in-loop
    const nodeTypeByNodeId = await fetchNodeTypesByNodeId(teamId, kgNodeIds);

    for (const orientation of orientations) {
      switch (orientation.kind) {
        case 'both_kg': {
          skippedBothKg += 1;
          break;
        }
        case 'neither_kg': {
          // Unreachable given the query's OR filter above (the DB guarantees
          // at least one side is KG); counted defensively rather than
          // silently dropped in case that filter ever regresses.
          skippedMissingNode += 1;
          break;
        }
        case 'kg': {
          const nodeId = orientation.kgEndpoint.recordId as NodeId;
          const nodeTypeId = nodeTypeByNodeId.get(nodeId);
          const entityPlan = nodeTypeId !== undefined ? entityPlanByNodeType.get(nodeTypeId) : undefined;
          if (entityPlan === undefined) {
            skippedMissingNode += 1;
            break;
          }
          stmt.run(
            entityPlan.tableName,
            nodeId,
            orientation.otherEndpoint.adapterType,
            orientation.otherEndpoint.instanceKey,
            orientation.otherEndpoint.typeId,
            orientation.otherEndpoint.recordId,
            'record_binding',
          );
          inserted += 1;
          break;
        }
        default:
          neverAsAny(orientation);
      }
    }

    afterId = rows[rows.length - 1].id;
    if (rows.length < PAGE_SIZE) break;
  }
  return { inserted, skippedBothKg, skippedMissingNode };
}

function populateMeta(
  db: Database.Database,
  team: { name: string | null },
  entityPlans: EntityTablePlan[],
  relationshipPlans: RelationshipTablePlan[],
  entityPlanByNodeType: Map<NodeTypeId, EntityTablePlan>,
): void {
  const overviewStmt = db.prepare('INSERT INTO "_overview" (key, value) VALUES (?, ?)');
  const teamName = team.name ?? 'Untitled team';
  overviewStmt.run('title', `${teamName} — knowledge graph export`);
  overviewStmt.run('team_name', teamName);
  overviewStmt.run('exported_at', new Date().toISOString());
  overviewStmt.run(
    'description',
    "This SQLite file is a self-describing snapshot of one team's knowledge graph, meant to be " +
      'queried directly with SQL. Read `_tables` first for the list of entity and relationship ' +
      'tables and what each holds, then `_columns` for what each column means and its declared ' +
      'type, then `_relationships` for how relationship tables connect entity tables. Relationship ' +
      'tables declare real FOREIGN KEY constraints on source_id/target_id, so joins follow those ' +
      'directly. A column marked multi_valued in `_columns` holds a JSON array as text rather than ' +
      'a single scalar value. `external_links` maps entities in the tables above to their records ' +
      'in outside systems (CRMs, calendars, …) — its entity_table + entity_id columns locate the ' +
      'entity, matching a row in the table named by entity_table.',
  );

  const tableStmt = db.prepare(
    'INSERT INTO "_tables" (table_name, kind, original_name, description, row_count) VALUES (?, ?, ?, ?, ?)',
  );
  const columnStmt = db.prepare(
    'INSERT INTO "_columns" (table_name, column_name, original_name, value_type, multi_valued, enum_values, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const relStmt = db.prepare(
    'INSERT INTO "_relationships" (table_name, source_table, target_table, outbound_name, inbound_name) VALUES (?, ?, ?, ?, ?)',
  );

  const rowCount = (tableName: string): number =>
    (db.prepare(`SELECT COUNT(*) as n FROM "${tableName}"`).get() as { n: number }).n;

  const insertColumnRows = (tableName: string, columns: ColumnPlan[]): void => {
    for (const col of columns) {
      columnStmt.run(
        tableName,
        col.columnName,
        col.originalName,
        col.valueType,
        col.cardinality === PropertyCardinality.multi ? 1 : 0,
        col.enumValues !== null ? JSON.stringify(col.enumValues) : null,
        col.description,
      );
    }
  };

  for (const plan of entityPlans) {
    tableStmt.run(plan.tableName, 'entity', plan.originalName, plan.description, rowCount(plan.tableName));
    columnStmt.run(plan.tableName, 'id', 'id', 'text', 0, null, "Primary key — this entity's identifier.");
    columnStmt.run(plan.tableName, 'summary', 'summary', 'text', 0, null, 'Human-readable summary of this entity.');
    insertColumnRows(plan.tableName, plan.columns);
  }

  for (const plan of relationshipPlans) {
    const sourcePlan = entityPlanByNodeType.get(plan.sourceNodeTypeId);
    const targetPlan = entityPlanByNodeType.get(plan.targetNodeTypeId);
    const readableName = `${sourcePlan?.originalName ?? plan.sourceTable} —${plan.outboundName}→ ${
      targetPlan?.originalName ?? plan.targetTable
    }`;
    tableStmt.run(plan.tableName, 'relationship', readableName, plan.description, rowCount(plan.tableName));
    columnStmt.run(plan.tableName, 'id', 'id', 'text', 0, null, "Primary key — this relationship instance's identifier.");
    columnStmt.run(
      plan.tableName,
      'source_id',
      'source_id',
      'text',
      0,
      null,
      `References "${plan.sourceTable}".id — the ${plan.outboundName} side.`,
    );
    columnStmt.run(
      plan.tableName,
      'target_id',
      'target_id',
      'text',
      0,
      null,
      `References "${plan.targetTable}".id — the ${plan.inboundName || plan.outboundName} side.`,
    );
    insertColumnRows(plan.tableName, plan.columns);
    relStmt.run(plan.tableName, plan.sourceTable, plan.targetTable, plan.outboundName, plan.inboundName);
  }

  tableStmt.run(
    'external_links',
    'links',
    'External record links',
    'Each row maps one exported entity to its counterpart record in an external system — the ' +
      "correspondence Listen-Fire tracks live, snapshotted for this export.",
    rowCount('external_links'),
  );
  columnStmt.run(
    'external_links',
    'entity_table',
    'entity_table',
    'text',
    0,
    null,
    'The exported entity table this link belongs to (matches a table_name in `_tables`).',
  );
  columnStmt.run(
    'external_links',
    'entity_id',
    'entity_id',
    'text',
    0,
    null,
    'The id of the entity in `entity_table` — join `entity_table`.id = external_links.entity_id.',
  );
  columnStmt.run(
    'external_links',
    'system',
    'system',
    'text',
    0,
    null,
    "The external system holding the linked record (e.g. 'attio', 'affinity').",
  );
  columnStmt.run(
    'external_links',
    'system_instance',
    'system_instance',
    'text',
    0,
    null,
    'Which instance of `system` holds the record (its credential + configuration). NULL when the ' +
      'link came from the legacy linked_object store, which does not track instance identity.',
  );
  columnStmt.run(
    'external_links',
    'external_type',
    'external_type',
    'text',
    0,
    null,
    "The record's type in the external system, when known.",
  );
  columnStmt.run(
    'external_links',
    'external_id',
    'external_id',
    'text',
    0,
    null,
    "The record's id in the external system.",
  );
  columnStmt.run(
    'external_links',
    'link_source',
    'link_source',
    'text',
    0,
    JSON.stringify(['linked_object', 'record_binding']),
    "Which internal store produced this link — 'linked_object' (legacy pipeline retrieval/output " +
      "correspondence) or 'record_binding' (the movement engine's symmetric bind-write store).",
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.team) throw new Error('--team <uuid> is required');
  if (!args.out) throw new Error('--out <path> is required');

  const teamId = args.team as TeamId;
  const outPath = path.resolve(args.out);

  if (fs.existsSync(outPath)) {
    throw new Error(`refusing to overwrite existing file: ${outPath}`);
  }

  const team = await getCoreQb(['team']).selectFrom('team').where('id', '=', teamId).select(['id', 'name']).executeTakeFirst();
  if (!team) throw new Error(`no team found for id ${teamId}`);

  const [nodeTypes, edgeTypes, propertyTypes] = await Promise.all([
    getKnowledgeQb(['node_type'])
      .selectFrom('node_type')
      .where('team_id', '=', teamId)
      .select(['id', 'name', 'description', 'category'])
      .orderBy('sort_order', 'asc')
      .orderBy('name', 'asc')
      .execute(),
    getKnowledgeQb(['edge_type'])
      .selectFrom('edge_type')
      .where('team_id', '=', teamId)
      .select(['id', 'outbound_name', 'inbound_name', 'description', 'source_node_type_id', 'target_node_type_id'])
      .orderBy('sort_order', 'asc')
      .orderBy('outbound_name', 'asc')
      .execute(),
    getKnowledgeQb(['property_type'])
      .selectFrom('property_type')
      .where('team_id', '=', teamId)
      .select(['id', 'node_type_id', 'edge_type_id', 'name', 'description', 'value_type', 'cardinality', 'enum_values'])
      .orderBy('sort_order', 'asc')
      .orderBy('name', 'asc')
      .execute(),
  ]);

  const nodeTypeById = new Map(nodeTypes.map((nt) => [nt.id, nt]));
  const propertyTypesByNodeType = new Map<NodeTypeId, typeof propertyTypes>();
  const propertyTypesByEdgeType = new Map<EdgeTypeId, typeof propertyTypes>();
  for (const pt of propertyTypes) {
    if (pt.node_type_id !== null) {
      const list = propertyTypesByNodeType.get(pt.node_type_id) ?? [];
      list.push(pt);
      propertyTypesByNodeType.set(pt.node_type_id, list);
    } else if (pt.edge_type_id !== null) {
      const list = propertyTypesByEdgeType.get(pt.edge_type_id) ?? [];
      list.push(pt);
      propertyTypesByEdgeType.set(pt.edge_type_id, list);
    }
  }

  // Meta table names (and external_links) are seeded first so no node/edge
  // type can shadow them.
  const usedTableNames = new Set<string>(['_overview', '_tables', '_columns', '_relationships', 'external_links']);

  const entityPlans: EntityTablePlan[] = nodeTypes.map((nt) => ({
    nodeTypeId: nt.id,
    tableName: dedupeIdentifier(sanitizeIdentifier(nt.name), usedTableNames),
    originalName: nt.name,
    description: nt.description,
    columns: buildColumnPlans(propertyTypesByNodeType.get(nt.id) ?? [], ['id', 'summary']),
  }));
  const entityPlanByNodeType = new Map(entityPlans.map((p) => [p.nodeTypeId, p]));

  const relationshipPlans: RelationshipTablePlan[] = edgeTypes.map((et) => {
    const sourceType = nodeTypeById.get(et.source_node_type_id);
    const targetType = nodeTypeById.get(et.target_node_type_id);
    const sourcePlan = entityPlanByNodeType.get(et.source_node_type_id);
    const targetPlan = entityPlanByNodeType.get(et.target_node_type_id);
    if (!sourceType || !targetType || !sourcePlan || !targetPlan) {
      throw new Error(`edge_type ${et.id} references a node type outside team ${teamId}`);
    }
    return {
      edgeTypeId: et.id,
      tableName: dedupeIdentifier(
        sanitizeIdentifier(`${sourceType.name}_${et.outbound_name}_${targetType.name}`),
        usedTableNames,
      ),
      sourceTable: sourcePlan.tableName,
      targetTable: targetPlan.tableName,
      sourceNodeTypeId: et.source_node_type_id,
      targetNodeTypeId: et.target_node_type_id,
      outboundName: et.outbound_name,
      inboundName: et.inbound_name,
      description: et.description,
      columns: buildColumnPlans(propertyTypesByEdgeType.get(et.id) ?? [], ['id', 'source_id', 'target_id']),
    };
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const db = new Database(outPath);
  db.pragma('foreign_keys = ON');
  db.exec('BEGIN');
  try {
    for (const plan of entityPlans) {
      const cols = ['id TEXT PRIMARY KEY', 'summary TEXT', ...plan.columns.map((c) => `"${c.columnName}" ${c.sqliteType}`)];
      db.exec(`CREATE TABLE "${plan.tableName}" (${cols.join(', ')})`);
    }
    for (const plan of relationshipPlans) {
      const cols = [
        'id TEXT PRIMARY KEY',
        `source_id TEXT NOT NULL REFERENCES "${plan.sourceTable}"(id)`,
        `target_id TEXT NOT NULL REFERENCES "${plan.targetTable}"(id)`,
        ...plan.columns.map((c) => `"${c.columnName}" ${c.sqliteType}`),
      ];
      db.exec(`CREATE TABLE "${plan.tableName}" (${cols.join(', ')})`);
      db.exec(`CREATE INDEX "${plan.tableName}_source_id_idx" ON "${plan.tableName}"(source_id)`);
      db.exec(`CREATE INDEX "${plan.tableName}_target_id_idx" ON "${plan.tableName}"(target_id)`);
    }
    db.exec(
      'CREATE TABLE "external_links" (entity_table TEXT NOT NULL, entity_id TEXT NOT NULL, system TEXT NOT NULL, system_instance TEXT, external_type TEXT, external_id TEXT NOT NULL, link_source TEXT NOT NULL)',
    );
    db.exec('CREATE INDEX "external_links_entity_idx" ON "external_links"(entity_table, entity_id)');
    db.exec('CREATE TABLE "_overview" (key TEXT PRIMARY KEY, value TEXT)');
    db.exec(
      'CREATE TABLE "_tables" (table_name TEXT PRIMARY KEY, kind TEXT, original_name TEXT, description TEXT, row_count INTEGER)',
    );
    db.exec(
      'CREATE TABLE "_columns" (table_name TEXT, column_name TEXT, original_name TEXT, value_type TEXT, multi_valued INTEGER, enum_values TEXT, description TEXT, PRIMARY KEY (table_name, column_name))',
    );
    db.exec(
      'CREATE TABLE "_relationships" (table_name TEXT PRIMARY KEY, source_table TEXT, target_table TEXT, outbound_name TEXT, inbound_name TEXT)',
    );

    for (const plan of entityPlans) {
      // eslint-disable-next-line no-await-in-loop
      await populateEntityTable(db, teamId, plan);
    }
    for (const plan of relationshipPlans) {
      // eslint-disable-next-line no-await-in-loop
      await populateRelationshipTable(db, teamId, plan);
    }

    const externalLinksStmt = db.prepare(
      'INSERT INTO "external_links" (entity_table, entity_id, system, system_instance, external_type, external_id, link_source) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const linkedObjectStats = await populateExternalLinksFromLinkedObject(teamId, entityPlanByNodeType, externalLinksStmt);
    const recordBindingStats = await populateExternalLinksFromRecordBinding(teamId, entityPlanByNodeType, externalLinksStmt);
    logger.info(
      `external_links: linked_object ${linkedObjectStats.inserted} inserted / ${linkedObjectStats.skipped} skipped ` +
        `(missing node or unmapped type); record_binding ${recordBindingStats.inserted} inserted / ` +
        `${recordBindingStats.skippedBothKg} kg↔kg skipped / ${recordBindingStats.skippedMissingNode} missing-node skipped.`,
    );

    populateMeta(db, team, entityPlans, relationshipPlans, entityPlanByNodeType);

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    db.close();
    throw e;
  }
  db.close();

  logger.info(
    `Exported team "${team.name}" (${teamId}) to ${outPath}: ${entityPlans.length} entity tables, ${relationshipPlans.length} relationship tables.`,
  );
}

// Only run main when invoked as a script — not when imported by tests.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error('export_kg_sqlite failed', e);
      process.exit(1);
    });
}

export { sanitizeIdentifier, dedupeIdentifier, valueTypeToSqliteType, serializePropertyValue, selectKgEndpoint };
