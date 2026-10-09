import { randomUUID } from "node:crypto";
import { Readable } from 'node:stream';

import { Router, type RequestHandler } from 'express';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { parse as parseCsvSync } from 'csv-parse/sync';
import { currentPrincipal } from 'principal';

import { currentContext } from '../../../services/context';
import { catchingRoutes } from '../async_route';
import { getKnowledgeQb, getQb } from '../../../lib/kysely';
import { DocumentService } from '../../../services/document';
import { services } from '../../../adapters/registry';
import {
  executeCypher,
  explainCypher,
  getSchema,
  ParseError,
  TranspileError,
  MutationNotAllowedError,
  loadOntology,
} from '../../../lib/knowledge/cypher';
import { toCsv } from '../../../lib/knowledge/csv';
import { describeOntology, planAndExecuteQuery } from '../../../lib/knowledge/knowledge_query';
import { applyImport } from '../../../lib/knowledge/import_host_functions';
import { rowsToCollectedNodes } from '../../../lib/knowledge/csv_import_mapping';
import { fetchCsvFromUrl } from '../../../lib/knowledge/safe_csv_fetch';
import { LlmUsageContext } from '../../../lib/llm_usage';
import { exposeFile } from '../../../services/translation_graph/engine/files/expose';
import { mountKnowledgeToolRoutes } from './knowledge_agent_tools';
import { mountKnowledgeGraphRoutes } from './knowledge_graph_api';
import { resolveToolTeam, ToolTeamError } from './team_scope';
import { requireScope } from './require_scope';

const KNOWLEDGE_SCOPE = 'knowledge';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function knowledgeQb(): Kysely<any> {
  return getKnowledgeQb() as Kysely<any>;
}

/**
 * The tenant a route below acts in, read off the Principal rather than through
 * `Context.user`. `user` is user-SHAPED and throws when there is no user, and
 * an api key minted for a service or the static single-tenant stub is a machine
 * principal with none (D2) — so a knowledge-only deployment, which is exactly
 * the standalone boot this product has to prove, lost every one of these routes
 * to a read that only ever wanted a team id.
 *
 * The sibling routers say this as `resolveToolTeam(req.query.team)`, which also
 * lets a caller name a team; these routes have never accepted one, and giving
 * them the parameter is a surface change, not a fix.
 */
function actingTeamId(): string {
  return currentPrincipal().teamId;
}

function internalError(res: Parameters<RequestHandler>[1], err: unknown) {
  // A team-resolution problem (wrong/missing `team`) is a clean 400 the caller
  // can act on, not an opaque 500.
  if (err instanceof ToolTeamError) {
    return res.status(400).json({ error: err.message, ...(err.teams ? { teams: err.teams } : {}) });
  }
  const traceId = randomUUID();
  console.error(`[knowledge-api:${traceId}]`, err);
  return res.status(500).json({
    error: 'internal_error',
    message: 'An internal error occurred.',
    traceId,
  });
}

/** The floor under every route in this router — see `async_route.ts` for why an
 *  unwrapped async handler HANGS rather than 500s. */
const route = catchingRoutes(internalError);

// Translate a Cypher pipeline error into its canonical 400 response. Returns
// true if it sent a response; false to let the caller fall through to
// `internalError`. Only error translation lives here — never resolve/execute.
function handleCypherError(res: Parameters<RequestHandler>[1], err: unknown): boolean {
  if (err instanceof ParseError) {
    res.status(400).json({ error: 'query_error', message: err.message, position: err.position });
    return true;
  }
  if (err instanceof TranspileError) {
    res.status(400).json({ error: 'query_error', message: err.message });
    return true;
  }
  if (err instanceof MutationNotAllowedError) {
    res.status(400).json({ error: 'read_only', message: err.message });
    return true;
  }
  return false;
}

const cypherSchema = z.object({
  query: z.string().min(1).max(10000),
  params: z
    .record(
      z.string(),
      z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(z.union([z.string(), z.number(), z.boolean()])),
      ]),
    )
    .optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().min(0).optional(),
  includeGeneratedSql: z.boolean().optional(),
  explain: z.boolean().optional(),
  team: z.string().optional(),
});

const cypherHandler: RequestHandler = async (req, res, next) => {
  const parseResult = cypherSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Invalid request body',
      details: parseResult.error.flatten(),
    });
  }

  const { query, params, limit, offset, includeGeneratedSql, explain, team } = parseResult.data;

  try {
    const teamId = await resolveToolTeam(team);

    if (explain) {
      const preview = await explainCypher({ query, teamId, qb: knowledgeQb(), params });
      return res.status(200).json(preview);
    }

    const pageOffset = offset ?? 0;
    const pageLimit = Math.min(limit ?? 1000, 1000);
    const fetchLimit = Math.min(pageOffset + pageLimit + 1, 100000);

    const result = await executeCypher({
      query,
      teamId,
      qb: knowledgeQb(),
      maxLimit: fetchLimit,
      params,
      readOnly: true,
    });

    const page = result.data.slice(pageOffset, pageOffset + pageLimit);
    const hasMore = result.data.length > pageOffset + pageLimit;

    if (!includeGeneratedSql) {
      delete (result.meta as Record<string, unknown>).generatedSql;
    }

    return res.status(200).json({
      columns: result.columns,
      data: page,
      meta: {
        ...result.meta,
        rowCount: page.length,
        offset: pageOffset,
        hasMore,
        ...(hasMore
          ? { note: 'More rows exist. Page with `offset`, or use exportCsv to get the full result as a downloadable CSV.' }
          : {}),
      },
    });
  } catch (err) {
    if (handleCypherError(res, err)) return;
    return internalError(res, err);
  }
};

const cypherWriteHandler: RequestHandler = async (req, res) => {
  const parseResult = cypherSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Invalid request body',
      details: parseResult.error.flatten(),
    });
  }

  const { query, params, limit, includeGeneratedSql, team } = parseResult.data;

  try {
    const teamId = await resolveToolTeam(team);
    const result = await executeCypher({
      query,
      teamId,
      qb: knowledgeQb(),
      maxLimit: limit,
      params,
    });

    if (!includeGeneratedSql) {
      delete (result.meta as Record<string, unknown>).generatedSql;
    }

    return res.status(200).json(result);
  } catch (err) {
    if (handleCypherError(res, err)) return;
    return internalError(res, err);
  }
};

const exportCsvSchema = z.object({
  query: z.string().min(1).max(10000),
  params: cypherSchema.shape.params,
  filename: z.string().max(128).optional(),
  maxRows: z.number().int().positive().max(100000).optional(),
  team: z.string().optional(),
});

const PREVIEW_ROWS = 20;

const exportCsvHandler: RequestHandler = async (req, res) => {
  const parseResult = exportCsvSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parseResult.error.flatten() });
  }

  const { query, params, filename, maxRows, team } = parseResult.data;

  try {
    const teamId = await resolveToolTeam(team);
    const result = await executeCypher({
      query,
      teamId,
      qb: knowledgeQb(),
      maxLimit: maxRows ?? 100000,
      params,
      readOnly: true,
    });

    const csv = toCsv({ columns: result.columns, rows: result.data });
    const bytes = Buffer.from(csv, 'utf8');
    const sanitizedBase = (filename ?? 'export').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.csv$/i, '');
    const name = (sanitizedBase.trim() || 'export') + '.csv';

    const exposed = await exposeFile({
      stream: Readable.from(bytes),
      filename: name,
      contentType: 'text/csv',
    });

    return res.status(200).json({
      url: exposed.url,
      expiresAt: exposed.expiresAt,
      filename: name,
      columns: result.columns,
      rowCount: result.data.length,
      byteSize: bytes.byteLength,
      preview: result.data.slice(0, PREVIEW_ROWS),
    });
  } catch (err) {
    if (handleCypherError(res, err)) return;
    return internalError(res, err);
  }
};

const importCsvSchema = z.object({
  csvUrl: z.string().url(),
  typeName: z.string().min(1),
  mapping: z.record(z.string(), z.string()),
  team: z.string().optional(),
});

const IMPORT_MAX_BYTES = 25 * 1024 * 1024;

const importCsvHandler: RequestHandler = async (req, res) => {
  const parseResult = importCsvSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parseResult.error.flatten() });
  }

  const { csvUrl, typeName, mapping, team } = parseResult.data;

  try {
    const teamId = await resolveToolTeam(team);

    let csvText: string;
    try {
      csvText = await fetchCsvFromUrl(csvUrl, { maxBytes: IMPORT_MAX_BYTES, timeoutMs: 15000 });
    } catch (fetchErr) {
      const message = fetchErr instanceof Error ? fetchErr.message : 'Could not fetch csvUrl.';
      return res.status(400).json({ error: 'fetch_failed', message });
    }

    const rows = parseCsvSync(csvText, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
    const nodes = rowsToCollectedNodes({ rows, typeName, mapping });
    const result = await applyImport(nodes, [], teamId);

    return res.status(200).json({ rowsRead: rows.length, ...result });
  } catch (err) {
    return internalError(res, err);
  }
};

const uploadCsvHandler: RequestHandler = async (req, res) => {
  try {
    const headerName = typeof req.headers['x-filename'] === 'string' ? req.headers['x-filename'] : undefined;
    const sanitized = (headerName ?? 'upload.csv').replace(/[^A-Za-z0-9._-]/g, '_');
    const filename = sanitized.trim() || 'upload.csv';

    let exposed;
    try {
      exposed = await exposeFile({
        stream: req,
        filename,
        contentType: 'text/csv',
        maxBytes: 25 * 1024 * 1024,
      });
    } catch (uploadErr) {
      if (uploadErr instanceof Error && uploadErr.message === 'Upload exceeds the size limit.') {
        return res.status(413).json({ error: 'too_large', message: uploadErr.message });
      }
      throw uploadErr;
    }

    return res.status(200).json({ url: exposed.url, expiresAt: exposed.expiresAt, filename });
  } catch (err) {
    return internalError(res, err);
  }
};

const schemaHandler: RequestHandler = async (req, res, next) => {
  try {
    const team = typeof req.query.team === 'string' ? req.query.team : undefined;
    const teamId = await resolveToolTeam(team);
    const schema = await getSchema(knowledgeQb(), teamId);
    return res.status(200).json(schema);
  } catch (err) {
    return internalError(res, err);
  }
};

const nodesQuerySchema = z.object({
  type: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const nodesHandler: RequestHandler = async (req, res, next) => {
  const teamId = actingTeamId();

  const parseResult = nodesQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Invalid query parameters',
      details: parseResult.error.flatten(),
    });
  }

  const { type, search, limit, offset } = parseResult.data;

  try {
    const qb = knowledgeQb();
    const ontology = await loadOntology(qb, teamId);

    let query = qb
      .selectFrom('node')
      .where('node.team_id', '=', teamId)
      .select(['node.id', 'node.node_type_id', 'node.summary', 'node.created_at', 'node.updated_at']);

    if (type) {
      const nt = ontology.nodeTypes.get(type.toLowerCase());
      if (!nt) {
        return res.status(400).json({ error: `Unknown node type: ${type}` });
      }
      query = query.where('node.node_type_id', '=', nt.id);
    }

    if (search) {
      query = query.where(
        sql<boolean>`node.summary_tsvector @@ plainto_tsquery('english', ${search})`,
      );
    }

    const nodes = await query
      .orderBy('node.created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();

    const nodeIds = nodes.map((n: any) => n.id);
    const properties =
      nodeIds.length > 0
        ? await qb
            .selectFrom('property')
            .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
            .where('property.node_id', 'in', nodeIds)
            .select([
              'property.node_id',
              'property_type.name',
              'property_type.value_type',
              'property.value_text',
              'property.value_number',
              'property.value_boolean',
              'property.value_date',
            ])
            .execute()
        : [];

    const propsByNode = new Map<string, Record<string, unknown>>();
    for (const p of properties) {
      let props = propsByNode.get(p.node_id);
      if (!props) {
        props = {};
        propsByNode.set(p.node_id, props);
      }
      props[p.name] =
        p.value_type === 'number'
          ? p.value_number
          : p.value_type === 'boolean'
            ? p.value_boolean
            : p.value_type === 'date'
              ? p.value_date
              : p.value_text;
    }

    const nodeTypeNames = new Map<string, string>();
    for (const [, nt] of ontology.nodeTypes) {
      nodeTypeNames.set(nt.id, nt.name);
    }

    const data = nodes.map((n: any) => ({
      id: n.id,
      type: nodeTypeNames.get(n.node_type_id) ?? n.node_type_id,
      properties: propsByNode.get(n.id) ?? {},
      summary: n.summary,
      updated_at: n.updated_at,
    }));

    return res.status(200).json({ data, meta: { count: data.length, offset, limit } });
  } catch (err) {
    return internalError(res, err);
  }
};

const nodeDetailHandler: RequestHandler = async (req, res, next) => {
  const teamId = actingTeamId();

  try {
    const qb = knowledgeQb();

    const node = await qb
      .selectFrom('node')
      .where('node.id', '=', req.params.id)
      .where('node.team_id', '=', teamId)
      .select(['node.id', 'node.node_type_id', 'node.summary', 'node.created_at', 'node.updated_at'])
      .executeTakeFirst();

    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const [properties, edges] = await Promise.all([
      qb
        .selectFrom('property')
        .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
        .where('property.node_id', '=', node.id)
        .select([
          'property_type.name',
          'property_type.value_type',
          'property.value_text',
          'property.value_number',
          'property.value_boolean',
          'property.value_date',
        ])
        .execute(),
      qb
        .selectFrom('edge')
        .innerJoin('edge_type', 'edge_type.id', 'edge.edge_type_id')
        .innerJoin('node as target', 'target.id', 'edge.target_node_id')
        .innerJoin('node_type', 'node_type.id', 'target.node_type_id')
        .where((eb: any) =>
          eb.or([
            eb('edge.source_node_id', '=', node.id),
            eb('edge.target_node_id', '=', node.id),
          ]),
        )
        .select([
          'edge.id as edge_id',
          'edge_type.outbound_name as relationship',
          'edge.source_node_id',
          'edge.target_node_id',
          'target.summary as target_summary',
          'node_type.name as target_type',
        ])
        .execute(),
    ]);

    const props: Record<string, unknown> = {};
    for (const p of properties) {
      props[p.name] =
        p.value_type === 'number'
          ? p.value_number
          : p.value_type === 'boolean'
            ? p.value_boolean
            : p.value_type === 'date'
              ? p.value_date
              : p.value_text;
    }

    const ontology = await loadOntology(qb, teamId);
    const nodeTypeNames = new Map<string, string>();
    for (const [, nt] of ontology.nodeTypes) {
      nodeTypeNames.set(nt.id, nt.name);
    }

    return res.status(200).json({
      id: node.id,
      type: nodeTypeNames.get(node.node_type_id) ?? node.node_type_id,
      properties: props,
      summary: node.summary,
      updated_at: node.updated_at,
      edges: edges.map((e: any) => ({
        id: e.edge_id,
        relationship: e.relationship,
        direction: e.source_node_id === node.id ? 'outgoing' : 'incoming',
        targetId: e.source_node_id === node.id ? e.target_node_id : e.source_node_id,
        targetType: e.target_type,
        targetSummary: e.target_summary,
      })),
    });
  } catch (err) {
    return internalError(res, err);
  }
};

const nodeEdgesHandler: RequestHandler = async (req, res, next) => {
  const teamId = actingTeamId();

  try {
    const qb = knowledgeQb();

    const node = await qb
      .selectFrom('node')
      .where('node.id', '=', req.params.id)
      .where('node.team_id', '=', teamId)
      .select('node.id')
      .executeTakeFirst();

    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    let query = qb
      .selectFrom('edge')
      .innerJoin('edge_type', 'edge_type.id', 'edge.edge_type_id')
      .where((eb: any) =>
        eb.or([
          eb('edge.source_node_id', '=', node.id),
          eb('edge.target_node_id', '=', node.id),
        ]),
      )
      .select([
        'edge.id',
        'edge_type.outbound_name as relationship',
        'edge.source_node_id',
        'edge.target_node_id',
      ]);

    if (req.query.type) {
      const ontology = await loadOntology(qb, teamId);
      const et = ontology.edgeTypes.get((req.query.type as string).toLowerCase());
      if (!et) {
        return res.status(400).json({ error: `Unknown edge type: ${req.query.type}` });
      }
      query = query.where('edge.edge_type_id', '=', et.id);
    }

    const edges = await query.execute();

    return res.status(200).json({
      data: edges.map((e: any) => ({
        id: e.id,
        relationship: e.relationship,
        direction: e.source_node_id === node.id ? 'outgoing' : 'incoming',
        sourceId: e.source_node_id,
        targetId: e.target_node_id,
      })),
    });
  } catch (err) {
    return internalError(res, err);
  }
};

// ---------------------------------------------------------------------------
// Query (Opus planner → SQL → rows, no agent loop)
// ---------------------------------------------------------------------------

const querySchema = z.object({
  question: z.string().min(1).max(5000),
  context: z.string().max(5000).optional(),
  team: z.string().optional(),
});

const queryHandler: RequestHandler = async (req, res) => {
  const parseResult = querySchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parseResult.error.flatten() });
  }

  const { question, context, team } = parseResult.data;

  try {
    const teamId = await resolveToolTeam(team);
    const usageContext = new LlmUsageContext({ teamId });
    const result = await usageContext.runAsync(async () => {
      const ontologyText = await describeOntology(teamId);
      return planAndExecuteQuery(question, ontologyText, teamId, context);
    });

    return res.status(200).json(result);
  } catch (err) {
    return internalError(res, err);
  }
};

// ── Node resources ──

const nodeResourcesHandler: RequestHandler = async (req, res) => {
  const teamId = actingTeamId();

  try {
    const qb = knowledgeQb();

    const node = await qb
      .selectFrom('node')
      .where('node.id', '=', req.params.id)
      .where('node.team_id', '=', teamId)
      .select('node.id')
      .executeTakeFirst();

    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const links = await getKnowledgeQb(['node_resource'] as any)
      .selectFrom('node_resource')
      .where('node_id', '=', node.id)
      .where('team_id', '=', teamId)
      .select(['resource_id', 'start_offset', 'end_offset'])
      .execute();

    if (links.length === 0) {
      return res.status(200).json({ data: [] });
    }

    const resourceIds = links.map((l: any) => l.resource_id);

    const resources = await getKnowledgeQb(['resource'] as any)
      .selectFrom('resource as r')
      .where('r.id', 'in', resourceIds)
      .select([
        'r.id',
        'r.type',
        'r.name',
        'r.url',
        'r.document_id',
        'r.created_at',
      ])
      .orderBy('r.created_at desc')
      .execute();

    const offsetMap = new Map(links.map((l: any) => [l.resource_id, l]));

    const data = resources.map((r: any) => {
      const link = offsetMap.get(r.id) as any;
      return {
        id: r.id,
        type: r.type,
        name: r.name,
        url: r.url,
        documentId: r.document_id,
        createdAt: r.created_at,
        startOffset: link?.start_offset ?? null,
        endOffset: link?.end_offset ?? null,
      };
    });

    return res.status(200).json({ data });
  } catch (err) {
    return internalError(res, err);
  }
};

// ── Document download ──

const documentDownloadHandler: RequestHandler = async (req, res) => {
  const teamId = actingTeamId();

  try {
    const doc = await currentContext().prisma.document.findFirst({
      where: { id: req.params.id, teamId },
    });

    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    if (req.query.presign === 'true') {
      const url = await services.document.getDownloadUrl(doc);
      return res.status(200).json({ url, expiresIn: 900 });
    }

    const rs = await services.document.getFile(doc);
    if (!rs) {
      return res.status(404).json({ error: 'Document file not found' });
    }

    if (rs.ContentType) {
      res.setHeader('Content-Type', rs.ContentType);
    }
    if (rs.ContentLength) {
      res.setHeader('Content-Length', rs.ContentLength);
    }
    if (doc.description) {
      res.setHeader('Content-Disposition', `inline; filename="${doc.description}"`);
    }

    const { Writable } = await import('node:stream');
    await rs.webStream.pipeTo(Writable.toWeb(res));
    return;
  } catch (err) {
    return internalError(res, err);
  }
};

const knowledgeRouter: ReturnType<typeof Router> = Router();

knowledgeRouter.use(requireScope(KNOWLEDGE_SCOPE));

knowledgeRouter.post('/cypher', route(cypherHandler));
knowledgeRouter.post('/cypher-write', route(cypherWriteHandler));
knowledgeRouter.post('/export-csv', route(exportCsvHandler));
knowledgeRouter.post('/import-csv', route(importCsvHandler));
knowledgeRouter.post('/import/upload', route(uploadCsvHandler));
knowledgeRouter.post('/query', route(queryHandler));
knowledgeRouter.get('/schema', route(schemaHandler));
knowledgeRouter.get('/nodes', route(nodesHandler));
knowledgeRouter.get('/nodes/:id', route(nodeDetailHandler));
knowledgeRouter.get('/nodes/:id/edges', route(nodeEdgesHandler));
knowledgeRouter.get('/nodes/:id/resources', route(nodeResourcesHandler));
knowledgeRouter.get('/documents/:id/download', route(documentDownloadHandler));

// The KG read + validated-edit tools, exposed directly (no agent loop):
// ontology, node-detail, recipes, entities/relationships, model mutations.
// Each reuses the same service fn the agent calls; all team-scoped via
// currentContext(). See knowledge_agent_tools.ts. (Movements, the catalog, the
// handbook, and asks now live on the Automation connector — automation.ts.)
mountKnowledgeToolRoutes(knowledgeRouter);

// The adapter-facing surface gets its own namespace rather than replacing the
// routes above: those speak NAMES to agents and the MCP connector, and other
// consumers read that shape. `/graph` speaks ids only (K-5) — a name is
// renameable, and an adapter that routed by one would silently stop matching
// after a rename. Two audiences, two currencies, one scope gate.
const knowledgeGraphRouter: ReturnType<typeof Router> = Router();
mountKnowledgeGraphRoutes(knowledgeGraphRouter);
knowledgeRouter.use('/graph', knowledgeGraphRouter);

export { knowledgeRouter };
