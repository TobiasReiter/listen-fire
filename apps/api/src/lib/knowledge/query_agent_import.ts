import { sql } from 'kysely';

import type { NodeId } from '../../generated/kysely/knowledge/Node';
import type { TeamId } from '../../generated/kysely/core/Team';

import { runInSandbox, type HostFn } from './import_sandbox';
import { applyImport } from './import_host_functions';
import { mergeNodes } from './merge';
import {
  createEntity,
  updateEntity,
  deleteEntity,
  createRelationship,
  updateRelationship,
  deleteRelationship,
} from './query_agent_crud';
import { unwrapAgentQueryRows } from './query_agent_utils';
import { getQb } from '../kysely';
import { anthropicChat } from '../anthropic';

// import tool definitions and implementations

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling format)
// ---------------------------------------------------------------------------

export const importToolDefinitions = [
  {
    type: 'function',
    name: 'testImport',
    description:
      'Test an import mapping by running it in mock mode against a sample of the data. Returns what would be created (node/edge counts, samples) without writing to the database. Iterate on the code until the output looks correct, then call executeImport. The code has access to: `input` (the raw data text), parseCSV(text, options?), parseTSV(text), parseJSON(text), createNode(type, props), createEdge(type, source, target), findNode(type, identityProps), readFile(index) — read an uploaded file by index returning {filename, content}, fileCount() — number of uploaded files. All functions are synchronous — do NOT use async/await.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript code. Use `input` to access the raw data, parse it, then create nodes and edges. All functions are synchronous — do NOT use async/await.',
        },
        input: {
          type: 'string',
          description:
            'The raw data to import. If omitted, uses the working document content or uploaded file.',
        },
        maxRows: {
          type: 'number',
          description:
            'Max nodes to record in mock mode (default 5). Use a small number to validate the mapping quickly.',
        },
      },
      required: ['code'],
    },
  },
  {
    type: 'function',
    name: 'executeImport',
    description:
      'Execute a tested import mapping against the full dataset. Writes nodes and edges to the knowledge graph with identity-based deduplication — existing nodes are matched by unique properties and updated rather than duplicated. Always test with testImport first.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The same JavaScript code that was tested with testImport.',
        },
        input: {
          type: 'string',
          description:
            'The raw data to import. If omitted, uses the working document content or uploaded file.',
        },
      },
      required: ['code'],
    },
  },
  {
    type: 'function',
    name: 'executeBulkOperation',
    description:
      'Run a JavaScript script in a sandbox with direct access to the knowledge graph. Use for bulk operations that need to query and mutate in a loop. Available functions (all synchronous — do NOT use async/await): query(sql) — read-only SQL (returns array of row objects), mergeNodes(targetNodeId, sourceNodeId) — merge source into target, createEntity(typeName, properties) — create a node, updateEntity(nodeId, properties) — update node properties (null to clear), deleteEntity(nodeId) — delete a node, createRelationship(sourceNodeId, targetNodeId, relationshipName, properties?) — create an edge, updateRelationship(edgeId, properties) — update edge properties, deleteRelationship(sourceNodeId, targetNodeId, relationshipName) — delete edges, haiku(prompt, options?) — call Claude Haiku for fast classification/extraction over text, returns the assistant text string (options: { system?, maxTokens?, temperature? }), readFile(index) — read an uploaded file by index returning {filename, content}, fileCount() — number of uploaded files. console.log() for debugging. The `input` global contains any data passed in.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript code. Use query() for SQL lookups and mergeNodes() for merging. All functions are synchronous — do NOT use async/await.',
        },
        input: {
          type: 'string',
          description: 'Optional data to make available as the `input` global variable.',
        },
      },
      required: ['code'],
    },
  },
];

// ---------------------------------------------------------------------------
// Resolve input data: explicit param > working document > uploaded files
// ---------------------------------------------------------------------------

async function resolveInput(
  explicitInput: string | undefined,
  loadWorkingDoc: (() => Promise<{ content: string }>) | undefined,
  loadUploadedDocs: (() => Promise<string>) | undefined,
): Promise<string> {
  if (explicitInput) return explicitInput;
  if (loadWorkingDoc) {
    const doc = await loadWorkingDoc();
    if (doc.content) return doc.content;
  }
  if (loadUploadedDocs) {
    const content = await loadUploadedDocs();
    if (content) return content;
  }
  throw new Error(
    'No input data provided. Either pass data in the `input` parameter, put it in the working document, or upload a file.',
  );
}

// ---------------------------------------------------------------------------
// Host functions for bulk operations (query + merge)
// ---------------------------------------------------------------------------

function bulkOperationHostFns(teamId: string): Record<string, HostFn> {
  return {
    query: async (sqlText: string) => {
      const qb = getQb();
      const result = await qb.transaction().execute(async (trx) => {
        await sql`SELECT set_current_team_id(${teamId})`.execute(trx);
        await sql`SET LOCAL ROLE agent`.execute(trx);
        const rows = await sql`SELECT * FROM execute_agent_query(${sqlText.replace(/;$/, '')})`.execute(trx);
        return rows.rows;
      });
      return JSON.stringify(Array.isArray(result) ? unwrapAgentQueryRows(result) : result);
    },

    mergeNodes: async (argsJson: string) => {
      const { targetNodeId, sourceNodeId } = JSON.parse(argsJson) as {
        targetNodeId: string;
        sourceNodeId: string;
      };
      const result = await mergeNodes({
        targetNodeId: targetNodeId as NodeId,
        sourceNodeId: sourceNodeId as NodeId,
        teamId: teamId as TeamId,
      });
      return JSON.stringify(result);
    },

    createEntity: async (argsJson: string) => {
      const args = JSON.parse(argsJson);
      return JSON.stringify(await createEntity(args, teamId));
    },

    updateEntity: async (argsJson: string) => {
      const args = JSON.parse(argsJson);
      return JSON.stringify(await updateEntity(args, teamId));
    },

    deleteEntity: async (argsJson: string) => {
      const args = JSON.parse(argsJson);
      return JSON.stringify(await deleteEntity(args, teamId));
    },

    createRelationship: async (argsJson: string) => {
      const args = JSON.parse(argsJson);
      return JSON.stringify(await createRelationship(args, teamId));
    },

    updateRelationship: async (argsJson: string) => {
      const args = JSON.parse(argsJson);
      return JSON.stringify(await updateRelationship(args, teamId));
    },

    deleteRelationship: async (argsJson: string) => {
      const args = JSON.parse(argsJson);
      return JSON.stringify(await deleteRelationship(args, teamId));
    },

    haiku: async (argsJson: string) => {
      const { prompt, options } = JSON.parse(argsJson) as {
        prompt: string;
        options?: { system?: string; maxTokens?: number; temperature?: number };
      };
      const text = await anthropicChat({
        model: 'claude-haiku-4-5-20251001',
        system: options?.system ?? '',
        userMessage: prompt,
        maxTokens: options?.maxTokens ?? 1024,
        temperature: options?.temperature,
        label: 'query_agent_sandbox_haiku',
      });
      return JSON.stringify(text);
    },
  };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

interface ImportToolContext {
  teamId: string;
  loadUploadedDocs?: () => Promise<string>;
  loadWorkingDoc?: () => Promise<{ content: string }>;
  readUploadedFile?: (index: number) => Promise<{ filename: string; content: string } | null>;
  uploadedFileCount?: number;
}

export function createImportTools(ctx: ImportToolContext) {
  // Build readFile host function if uploaded files are available
  const fileHostFns: Record<string, HostFn> = {};
  if (ctx.readUploadedFile) {
    const readFn = ctx.readUploadedFile;
    const fileCount = ctx.uploadedFileCount ?? 0;
    fileHostFns.readFile = async (argsJson: string) => {
      const { index } = JSON.parse(argsJson) as { index: number };
      if (index < 0 || index >= fileCount) {
        return JSON.stringify({ __error: `Invalid file index ${index}. ${fileCount} file(s) available (0-indexed).` });
      }
      const doc = await readFn(index);
      if (!doc) return JSON.stringify({ __error: 'Could not read this file.' });
      return JSON.stringify({ filename: doc.filename, content: doc.content });
    };
    fileHostFns.fileCount = async () => JSON.stringify(fileCount);
  }

  return {
    testImport: async (args: { code: string; input?: string; maxRows?: number }) => {
      const inputData = await resolveInput(args.input, ctx.loadWorkingDoc, ctx.loadUploadedDocs);
      const maxNodes = args.maxRows ?? 5;

      const sandbox = await runInSandbox(args.code, inputData, {
        maxNodes,
        hostFnOverrides: { ...fileHostFns },
      });

      // Build summary grouped by type
      const nodesByType = new Map<string, Array<Record<string, unknown>>>();
      for (const n of sandbox.nodes) {
        const list = nodesByType.get(n.type) ?? [];
        list.push(n.properties);
        nodesByType.set(n.type, list);
      }
      const nodeSummary = [...nodesByType.entries()].map(([type, props]) => ({
        type,
        count: props.length,
        sample: props.slice(0, 2),
      }));

      const edgesByType = new Map<string, number>();
      for (const e of sandbox.edges) {
        edgesByType.set(e.type, (edgesByType.get(e.type) ?? 0) + 1);
      }
      const edgeSummary = [...edgesByType.entries()].map(([type, count]) => ({ type, count }));

      return {
        success: sandbox.success,
        error: sandbox.error,
        nodes: nodeSummary,
        edges: edgeSummary,
        totalNodesRecorded: sandbox.nodes.length,
        totalEdgesRecorded: sandbox.edges.length,
        maxRowsApplied: maxNodes,
        logs: sandbox.logs.length > 0 ? sandbox.logs.slice(0, 20) : undefined,
      };
    },

    executeImport: async (args: { code: string; input?: string }) => {
      const inputData = await resolveInput(args.input, ctx.loadWorkingDoc, ctx.loadUploadedDocs);

      // Run sandbox to collect all operations (cap at 10k nodes as safety limit)
      const sandbox = await runInSandbox(args.code, inputData, {
        timeoutMs: 600_000,
        maxNodes: 10_000,
        hostFnOverrides: { ...fileHostFns },
      });

      if (!sandbox.success) {
        return { success: false, error: sandbox.error };
      }

      // Apply collected operations to DB with identity matching + property upsert
      const result = await applyImport(sandbox.nodes, sandbox.edges, ctx.teamId);

      return {
        success: true,
        nodesCreated: result.nodesCreated,
        nodesMatched: result.nodesMatched,
        edgesCreated: result.edgesCreated,
        edgesSkipped: result.edgesSkipped,
        propertiesUpserted: result.propertiesUpserted,
        errors: result.errors.length > 0 ? result.errors : undefined,
      };
    },

    executeBulkOperation: async (args: { code: string; input?: string }) => {
      const hostFnOverrides = { ...fileHostFns, ...bulkOperationHostFns(ctx.teamId) };

      let inputData = '';
      try {
        inputData = await resolveInput(args.input, ctx.loadWorkingDoc, ctx.loadUploadedDocs);
      } catch {
        // No input available — that's fine for bulk operations that only use query()
      }

      const sandbox = await runInSandbox(args.code, inputData, {
        timeoutMs: 600_000,
        hostFnOverrides,
      });

      return {
        success: sandbox.success,
        error: sandbox.error,
        logs: sandbox.logs.length > 0 ? sandbox.logs : undefined,
      };
    },
  };
}
