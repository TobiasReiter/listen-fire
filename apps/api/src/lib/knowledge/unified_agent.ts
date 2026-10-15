// The unified knowledge agent — ONE user-facing consultant replacing the
// domain-routed query / ontology / output / movement / system agents.
//
// Three ideas define it:
//
//  1. Books on demand. Instead of one giant per-domain system prompt, the
//     agent carries the Library's index (lib/knowledge/library) and reads
//     handbook chapters with `readBook` when a task needs depth — the
//     generalisation of the movement agent's readAuthoringDoc pattern.
//
//  2. Scopes. Every tool belongs to a named scope; each INVOCATION declares
//     which scopes are enabled (app chat = all; narrower surfaces grant
//     less). The agent is told both what it has and what exists but is
//     lacking, so it can say "that needs the movements.author scope, which
//     this channel doesn't have" instead of failing opaquely.
//
//  3. Cypher-backed reads. Knowledge-graph reads go through the Cypher
//     engine (lib/knowledge/cypher) — the agent writes Cypher itself; no
//     LLM-generated raw SQL anywhere. Mutations keep the validated CRUD
//     path (query_agent_crud / ontology tools), never Cypher mutations.
//
// Reasoning model: Opus. This agent reads and mutates the user's real data
// and authors automations off it, so judgement matters more than per-turn
// cost — see UNIFIED_AGENT_MODEL below.

import { z } from 'zod';

import type { Kysely } from 'kysely';
import type { ChatModelName } from 'movement-engine/lib/models/registry';
import type { ResourceChangeEvent } from '../message_queue/queues/resourceChanges';
import type { AgentUpdate } from '../openai/types';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { NodeId } from '../../generated/kysely/knowledge/Node';
import type { ToolTrace, SuggestedAction } from './agent_types';

import {
  anthropicChat,
  anthropicToolLoop,
  type AnthropicSystemBlock,
  type TurnEvent,
} from '../anthropic';
import { AgentResponseSchema } from '../openai/db_agent_schema';
import { currentContext } from '../../services/context';
import { logger } from 'movement-engine/services/logger';
import { mq } from '../message_queue';
import { getAutomationsQb, getKnowledgeQb, getQb } from '../kysely';
import {
  getAdapterManifest,
  adapterRequiredCredentialType,
} from '../../services/translation_graph/adapters/registry';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { parseJson } from 'movement-engine/lib/utils/parse_json';
import { getLibraryShelf, readBook } from './library';
import { getMovementDoctrine } from './movement_handbook';
import { executeCypher, getSchema, stripCypherComments, ParseError, TranspileError } from './cypher';
import { parseAnyCypher } from './cypher/parser';
import { isMutation } from './cypher/types';
import { getNodeDetail } from './knowledge_query';
import { searchFacts } from '../../services/knowledge_pipeline/facts';
import {
  createEntity,
  updateEntity,
  createRelationship,
  updateRelationship,
  deleteEntity,
  deleteRelationship,
  bulkCreateEntities,
  bulkUpdateEntities,
  bulkDeleteEntities,
  bulkCreateRelationships,
  bulkDeleteRelationships,
  crudToolDefinitions,
} from './query_agent_crud';
import { mergeNodes } from './merge';
import {
  ONTOLOGY_TOOL_DEFINITIONS,
  createOntologyAgentTools,
} from './ontology_agent';
import {
  movementToolDefinitions,
  createMovementAgentTools,
} from './movement_agent';
import { beatForToolCall } from './build_beats';
import {
  systemToolDefinitions,
  createSystemAgentTools,
} from './system_agent';
import { listConversationFiles, readConversationFile } from './conversation_files';

const MAX_TOOL_RESULT_CHARS = 50_000;

// ---------------------------------------------------------------------------
// Scopes — the safety model. A scope is a named group of tools; the surface
// invoking the agent decides which scopes the invocation gets.
// ---------------------------------------------------------------------------

export const AGENT_SCOPES = {
  'library.read': {
    summary: 'Read the Library handbooks (readBook) — how-to depth for every capability.',
  },
  'knowledge.read': {
    summary:
      'Read the knowledge graph: structured graph queries, entity detail with provenance, fact-store search, and the current model definition.',
  },
  'knowledge.edit': {
    summary:
      'Change knowledge: create/update/delete entities and relationships, merge duplicates, and edit the model itself (entity types, fields, relationships, dedup rules).',
  },
  'movements.read': {
    summary: 'See saved movements (automations): their programs, status, and listeners.',
  },
  'movements.author': {
    summary: 'Author movements: typecheck programs and save them live (provisions listeners).',
  },
  'catalog.read': {
    summary:
      'See what the workspace can connect to: adapters, credentials, plugins, and live external-system schemas.',
  },
  'runs.read': {
    summary:
      'Inspect the operational record: inbound messages, extraction pipeline runs, automation firings, and channel configuration.',
  },
  'files.read': {
    summary:
      'Read files the user attached to this conversation: list them and read their extracted text.',
  },
} as const;

export type AgentScope = keyof typeof AGENT_SCOPES;
export const ALL_AGENT_SCOPES = Object.keys(AGENT_SCOPES) as AgentScope[];

const AgentScopeSchema = z.enum(
  Object.keys(AGENT_SCOPES) as [AgentScope, ...AgentScope[]],
);

export function parseAgentScopes(raw: unknown): AgentScope[] {
  if (raw === undefined || raw === null) return ALL_AGENT_SCOPES;
  const parsed = z.array(AgentScopeSchema).parse(raw);
  return [...new Set(parsed)];
}

// ---------------------------------------------------------------------------
// Page context — what the user is looking at when they send a message.
//
// The web app's slide-over panel attaches a structured snapshot of the
// current page (route, named entities on screen, page-specific extras
// like the movement editor's draft script) to every turn. It is rendered
// as a clearly-delimited prompt section so the agent can resolve "this"
// / "here" references. Context INFORMS, it never AUTHORISES — scopes are
// the only capability boundary, and a page snapshot grants nothing.
// ---------------------------------------------------------------------------

export const PageContextSchema = z.object({
  /** Human-readable page name, e.g. "Movement editor". */
  page: z.string().max(200),
  /** The route, e.g. "/movements/abc123". */
  path: z.string().max(500).optional(),
  /** Named things on screen: { kind: 'movement', id, name }. */
  entities: z
    .array(
      z.object({
        kind: z.string().max(100),
        id: z.string().max(200).optional(),
        name: z.string().max(500).optional(),
      }),
    )
    .max(50)
    .optional(),
  /** Page-specific state, e.g. the editor's current draft script. */
  extras: z.record(z.string(), z.string()).optional(),
});

export type PageContext = z.infer<typeof PageContextSchema>;

/** Lenient boundary parse — malformed context degrades to "no context"
 *  rather than failing the turn. */
export function parsePageContext(raw: unknown): PageContext | undefined {
  if (raw === undefined || raw === null) return undefined;
  const result = PageContextSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

const MAX_EXTRA_CHARS = 12_000;

function renderPageContextSection(pageContext: PageContext): string {
  const lines: string[] = [
    '## What the user is currently viewing',
    '',
    'The user sent this message from inside the app. This is a snapshot of the page on their screen — use it to resolve references like "this", "here", or "what am I looking at", and to tailor answers to what they are working on. It is context only: it grants no extra capability, and everything you do still goes through your normal tools and scopes.',
    '',
    `Page: ${pageContext.page}${pageContext.path ? ` (${pageContext.path})` : ''}`,
  ];

  if (pageContext.entities && pageContext.entities.length > 0) {
    lines.push('', 'On screen:');
    for (const entity of pageContext.entities) {
      const label = entity.name ?? entity.id ?? '(unnamed)';
      lines.push(`- ${entity.kind}: ${label}${entity.id && entity.name ? ` (id: ${entity.id})` : ''}`);
    }
  }

  const extras = Object.entries(pageContext.extras ?? {});
  for (const [key, rawValue] of extras) {
    const value =
      rawValue.length > MAX_EXTRA_CHARS
        ? `${rawValue.slice(0, MAX_EXTRA_CHARS)}\n… (truncated)`
        : rawValue;
    if (value.includes('\n') || value.length > 120) {
      lines.push('', `${key}:`, '```', value, '```');
    } else {
      lines.push('', `${key}: ${value}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Agent ↔ agent delegation seam — STUBBED, not active.
//
// The one concrete use designed for: Cypher escalation. If the default
// model proved unable to write correct Cypher for hard questions, the
// queryGraph path would delegate the narrow task to a stronger model:
//
//   delegate({ task: 'Write a Cypher query answering: <question>',
//              scope: 'knowledge.read' })
//
// — a sub-agent invoked with ONLY the named scope, returning its final
// text. Eval verdict (2026-06-11, ~10 representative questions through
// this agent on Sonnet against the dev knowledge graph): Sonnet composed
// correct Cypher unaided, so the seam stays inactive. Flip
// DELEGATION_ACTIVE if a future capability needs escalation; the tool
// definition and dispatch slot below are ready.
// ---------------------------------------------------------------------------

const DELEGATION_ACTIVE = false;

export interface DelegationRequest {
  task: string;
  scope: AgentScope;
}

const delegateToolDefinition = {
  type: 'function',
  name: 'delegate',
  description:
    'Delegate a narrow, self-contained task to a specialist sub-agent that runs with exactly one scope. Use only when the task exceeds what you can do directly.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Complete, self-contained task description.' },
      scope: {
        type: 'string',
        enum: ALL_AGENT_SCOPES,
        description: 'The single scope the sub-agent runs with.',
      },
    },
    required: ['task', 'scope'],
  },
};

async function delegate(_request: DelegationRequest): Promise<{ error: string }> {
  return { error: 'Delegation is not active on this deployment.' };
}

// ---------------------------------------------------------------------------
// Library — books on demand
// ---------------------------------------------------------------------------

function renderShelfForPrompt(): string {
  const lines: string[] = [];
  for (const book of getLibraryShelf()) {
    if (book.status === 'coming_soon') continue;
    const flag = book.status === 'legacy' ? ' [legacy]' : '';
    lines.push(`- **${book.title}** (bookId: \`${book.bookId}\`)${flag} — ${book.description}`);
    if (book.statusNote) lines.push(`  Note: ${book.statusNote}`);
    if (book.chapters.length > 0) {
      lines.push(`  Chapters: ${book.chapters.map((c) => `\`${c.id}\` (${c.title})`).join(', ')}`);
    }
  }
  return lines.join('\n');
}

// readBook now lives in ./library (single source — shared with the direct
// MCP path in interfaces/rest/v1/knowledge_agent_tools.ts).

// ---------------------------------------------------------------------------
// Knowledge-graph reads — Cypher composed by the agent, executed through
// the cypher engine. Strictly read-only: mutation syntax is rejected and
// redirected to the validated editing tools.
// ---------------------------------------------------------------------------

const CYPHER_REFERENCE = `### Graph query language (queryGraph)

queryGraph takes a Cypher query over the model shown below. Supported subset:

\`\`\`
MATCH pattern [, pattern]*
[OPTIONAL MATCH pattern [, pattern]*]
[WHERE conditions]
[WITH expressions [AS alias] [, ...] [WHERE conditions]]
RETURN [DISTINCT] expressions [AS alias] [, ...]
[ORDER BY expression [ASC|DESC] [, ...]]
[SKIP n] [LIMIT n]
\`\`\`

**Patterns:** \`(v:NodeType)\`, inline equality \`(v:NodeType {Prop: 'value'})\`, outgoing \`-[:rel]->\`, incoming \`<-[:rel]-\`, undirected \`-[:rel]-\`, edge variable \`-[r:rel]->\` (then \`r.Prop\`), chains \`(a:A)-[:r1]->(b:B)-[:r2]->(c:C)\`, multiple MATCH lines (merged). **Backtick-quote** any label, relationship, or property containing spaces: \`(\\\`Funding Round\\\`)\`, \`[:\\\`Member Of\\\`]\`, \`r.\\\`Round Name\\\`\`.

**WHERE:** \`=\`, \`<>\`, \`<\`, \`>\`, \`<=\`, \`>=\`, \`AND\`, \`OR\`, \`NOT\`, \`CONTAINS\`, \`STARTS WITH\`, \`ENDS WITH\`, \`IS NULL\`, \`IS NOT NULL\`, \`IN [...]\`, \`NOT IN [...]\`.

**Aggregations:** \`COUNT\`, \`SUM\`, \`AVG\`, \`MIN\`, \`MAX\`, \`COLLECT\`, \`COUNT(*)\`, \`COUNT(DISTINCT x)\`. Map literals inside COLLECT: \`COLLECT({name: p.Name, role: r.Role})\`.

**Scalar functions:** \`TOLOWER\`, \`TOUPPER\`, \`TRIM\`, \`TOSTRING\`, \`TOINTEGER\`, \`TOFLOAT\`, \`SIZE\`, \`CONCAT(a, b, ...)\` (never \`+\` for strings), \`COALESCE(a, b, ...)\`. Arithmetic \`+ - * / %\`. \`CASE WHEN ... THEN ... [ELSE ...] END\`. Dates: \`date()\`, \`duration('P30D')\`, with arithmetic \`date() - duration('P30D')\`.

**Meta fields** on every node (not in the schema): \`v.created_at\`, \`v.updated_at\`, \`v.summary\`.

**Rules:**
1. Use EXACT node type / relationship / property names from the schema (case-sensitive).
2. Default to LIMIT 20 unless more is needed; always include some LIMIT.
3. Use WITH to filter on aggregates; OPTIONAL MATCH for left-join semantics.
4. No UNION, no UNWIND.
5. READ-ONLY: never write CREATE/SET/MERGE/DELETE here — use the editing tools instead.
6. Return \`v.id\` alongside display fields when the user may follow up on a specific entity.`;

function backtickIfNeeded(name: string): string {
  return /\s/.test(name) ? `\`${name}\`` : name;
}

async function renderGraphSchema(teamId: string): Promise<string> {
  const qb = getKnowledgeQb() as Kysely<any>;
  const schema = await getSchema(qb, teamId);
  if (schema.nodeTypes.length === 0) {
    return 'The knowledge model is empty — no entity types defined yet.';
  }

  const lines: string[] = ['### Entity types'];
  for (const nt of schema.nodeTypes) {
    const props = nt.properties
      .map((p) => {
        let desc = `${backtickIfNeeded(p.name)} (${p.type}`;
        if (p.enumValues && p.enumValues.length > 0) {
          desc += `, values: ${p.enumValues.map((v) => `"${v}"`).join(' | ')}`;
        }
        return `${desc})`;
      })
      .join(', ');
    lines.push(`- **${backtickIfNeeded(nt.name)}**${props ? `: ${props}` : ''}`);
  }

  lines.push('', '### Relationship types');
  for (const et of schema.edgeTypes) {
    const props = et.properties.length
      ? ` [edge props: ${et.properties.map((p) => `${backtickIfNeeded(p.name)} (${p.type})`).join(', ')}]`
      : '';
    lines.push(
      `- **${backtickIfNeeded(et.name)}**: (${backtickIfNeeded(et.source)}) → (${backtickIfNeeded(et.target)})${props}`,
    );
  }
  return lines.join('\n');
}

async function queryGraph(args: { query: string }, teamId: string) {
  let ast;
  try {
    ast = parseAnyCypher(stripCypherComments(args.query));
  } catch (e) {
    if (e instanceof ParseError) {
      return { error: `Cypher parse error at position ${e.position}: ${e.message}` };
    }
    throw e;
  }
  if (isMutation(ast)) {
    return {
      error:
        'queryGraph is read-only — mutation syntax (CREATE/SET/MERGE/DELETE/REMOVE) is not allowed here. Use the editing tools (createEntity, updateEntity, createRelationship, mergeNodes, …) to change data.',
    };
  }
  try {
    const qb = getKnowledgeQb() as Kysely<any>;
    const result = await executeCypher({ query: args.query, teamId, qb });
    return {
      columns: result.columns,
      rows: result.data,
      rowCount: result.meta.rowCount,
    };
  } catch (e) {
    if (e instanceof ParseError || e instanceof TranspileError) {
      return { error: e.message };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Tool surface, grouped by scope
// ---------------------------------------------------------------------------

const libraryToolDefinitions = [
  {
    type: 'function',
    name: 'readBook',
    description:
      'Read a handbook from the Library. No arguments → the full shelf. bookId only → that book\'s chapter list and "when to read what" index, which routes each situation to a `chapter` or a `chapter#section`. bookId + chapter (or `chapters` for several at once) → the content. A chapter id may name one section — "writes#identity" — which is what to fetch when you need a single rule rather than a whole area. Prefer reading ALL the chapters and sections you expect to need in ONE call via `chapters` — frontload it rather than a round-trip per chapter. Read the relevant chapters BEFORE working on anything you are not already sure of.',
    parameters: {
      type: 'object',
      properties: {
        bookId: { type: 'string', description: 'Book id from the shelf (e.g. "automations").' },
        chapter: {
          type: 'string',
          description: 'A single chapter id (e.g. "anatomy"), or one section of it ("writes#identity").',
        },
        chapters: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Several chapter ids to read at once, each optionally a section (e.g. ["anatomy","writes#identity","patterns"]).',
        },
      },
      required: [],
    },
  },
];

const knowledgeReadToolDefinitions = [
  {
    type: 'function',
    name: 'queryGraph',
    description:
      'Run a read-only Cypher query against the knowledge graph. Compose the query yourself using the model schema in your instructions and the supported subset documented there. Returns columns and rows. Mutations are rejected — use the editing tools for changes.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The Cypher query (read-only).' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'getNodeDetail',
    description:
      "Everything about one entity. 'full' mode (default): properties, relationships with resolved names, evidence, and original source texts. 'context' mode: lightweight properties + relationships view for disambiguation before edits.",
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The entity id (from a queryGraph result).' },
        mode: { type: 'string', enum: ['full', 'context'] },
      },
      required: ['nodeId'],
    },
  },
  {
    type: 'function',
    name: 'searchFactStore',
    description:
      'Fallback search over raw (subject, predicate, object) tuples extracted from historical documents — may hold information never modelled in the graph. Ranked by semantic similarity. Note to the user that these are raw extractions when presenting them.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search terms.' },
        limit: { type: 'number', description: 'Max facts (default 20, max 50).' },
      },
      required: ['query'],
    },
  },
];

// Recipes: reusable, team-authored instructions. getRecipe is a read
// (load full instructions by name); saveRecipe writes one. Gated on the
// knowledge read/edit scopes respectively.
const recipeReadToolDefinitions = [
  {
    type: 'function',
    name: 'getRecipe',
    description:
      "Load the full instructions for a saved recipe by name. Use this when you identify that a recipe is relevant to the user's request.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact name of the recipe to load' },
      },
      required: ['name'],
    },
  },
];

const recipeEditToolDefinitions = [
  {
    type: 'function',
    name: 'saveRecipe',
    description:
      'Save a new recipe or update an existing one. Use this when the user asks you to save the current approach as a reusable recipe.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name for the recipe' },
        description: {
          type: 'string',
          description: 'One-line summary of what this recipe does and when to use it',
        },
        instructions: {
          type: 'string',
          description: 'Full instructions the agent should follow when this recipe is active',
        },
      },
      required: ['name', 'description', 'instructions'],
    },
  },
];

// Files the user attached to this conversation (uploaded through the
// web assistant). Read-only: enumerate + read extracted text. The
// legacy query agent's raw-SQL bulk-import tools were deliberately NOT
// ported alongside these.
const fileToolDefinitions = [
  {
    type: 'function',
    name: 'listUploadedFiles',
    description:
      'List the files the user has attached to this conversation (index and filename). Returns an empty list when nothing has been attached.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'readUploadedFile',
    description:
      'Read the text content of a file the user attached to this conversation, by its index from listUploadedFiles. Returns line-numbered text; pass start_line / end_line to page through large files.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'File index from listUploadedFiles.' },
        start_line: { type: 'number', description: 'First line to return (1-based).' },
        end_line: { type: 'number', description: 'Last line to return (inclusive).' },
      },
      required: ['index'],
    },
  },
];

const ONTOLOGY_READ_TOOL_NAMES = new Set(['getOntology']);
const MOVEMENT_TOOLS_BY_SCOPE: Record<string, AgentScope> = {
  listCatalog: 'catalog.read',
  describeInstance: 'catalog.read',
  completionsAt: 'movements.author',
  validateMovement: 'movements.author',
  saveMovement: 'movements.author',
  planBuild: 'movements.author',
  listMovements: 'movements.read',
  getMovement: 'movements.read',
  // readAuthoringDoc intentionally omitted — readBook('automations', …) covers it.
};

interface ScopedToolSet {
  defs: any[];
  impls: Record<string, (args: any) => Promise<any>>;
}

// ── Credential connect offers ──────────────────────────────────────────
// The agent can offer the user an in-chat button to connect an integration's
// credential. The offer is a construction-free fact derived from the adapter
// manifest plus a per-team "is it already connected?" check; offersToSuggestedActions
// turns the unconnected ones into the connect-credential suggestedActions the
// web dispatches to its connect-action handler registry.
export interface CredentialConnectOffer {
  adapter: string;
  displayName: string;
  serviceType: string;
  alreadyConnected: boolean;
}

export async function buildCredentialConnectOffer(args: {
  adapterSlug: string;
  hasCredentialOfType: (serviceType: string) => Promise<boolean>;
}): Promise<CredentialConnectOffer | { error: string }> {
  const manifest = getAdapterManifest(args.adapterSlug);
  if (!manifest) {
    return { error: `No adapter '${args.adapterSlug}'. It is not an available integration.` };
  }
  const credType = adapterRequiredCredentialType(args.adapterSlug);
  if (!credType) {
    return { error: `${manifest.displayName} needs no credential — nothing to connect.` };
  }
  const alreadyConnected = await args.hasCredentialOfType(credType);
  return {
    adapter: manifest.adapterType,
    displayName: manifest.displayName,
    serviceType: credType,
    alreadyConnected,
  };
}

export function offersToSuggestedActions(
  offers: CredentialConnectOffer[],
): { label: string; message: string; connectAction: { kind: string; adapter: string; serviceType: string } }[] {
  return offers
    .filter((o) => !o.alreadyConnected)
    .map((o) => ({
      label: `Connect ${o.displayName}`,
      message: '',
      connectAction: { kind: 'connect-credential', adapter: o.adapter, serviceType: o.serviceType },
    }));
}

async function teamHasCredentialOfType(teamId: string, serviceType: string): Promise<boolean> {
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', teamId as TeamId)
    .where('type', '=', serviceType as ExternalServiceType)
    .select('id')
    .limit(1)
    .executeTakeFirst();
  return !!row;
}

// The agent's ONTOLOGY tools — the one mutation class with no shared
// service chokepoint (the agent's ontology_agent.ts edits the model
// directly, separately from the UI's ontology router). kg-data and
// movement are NOT here: they propagate from their shared layers
// (recordChanges, saveMovement/deleteMovement), which the agent's CRUD
// and saveMovement tools already flow through — so they'd double-emit if
// listed. Reads and ambient-context tools change nothing.
const MUTATING_TOOL_KINDS: Record<string, ResourceChangeEvent['kind']> = {
  createNodeType: 'ontology',
  updateNodeType: 'ontology',
  deleteNodeType: 'ontology',
  createPropertyType: 'ontology',
  updatePropertyType: 'ontology',
  deletePropertyType: 'ontology',
  createEdgeType: 'ontology',
  updateEdgeType: 'ontology',
  deleteEdgeType: 'ontology',
  setUniquenessConstraints: 'ontology',
};

/**
 * Wrap the agent's ontology tool impls so a successful call publishes a
 * resource-change hint (source: agent). The result passes through
 * untouched; a tool that returned an `{ error }` object (the `announce`
 * convention) or threw publishes nothing.
 */
function wrapMutatingTools(
  impls: Record<string, (args: any) => Promise<any>>,
  teamId: string,
): Record<string, (args: any) => Promise<any>> {
  const wrapped: Record<string, (args: any) => Promise<any>> = {};
  for (const [name, fn] of Object.entries(impls)) {
    const kind = MUTATING_TOOL_KINDS[name];
    if (!kind) {
      wrapped[name] = fn;
      continue;
    }
    wrapped[name] = async (args: any) => {
      const result = await fn(args);
      const failed = result && typeof result === 'object' && 'error' in result;
      if (!failed) {
        const resourceId =
          (result && typeof result === 'object' ? result.id : undefined) ?? undefined;
        mq.resourceChanges.changed
          .publish({ kind, teamId, source: 'agent', action: name, ...(resourceId ? { resourceId } : {}) })
          .catch(() => {});
      }
      return result;
    };
  }
  return wrapped;
}

/**
 * A warm, plain-language status line for a data-mutating tool — the user sees
 * this while it runs, so it must never leak the raw tool name (e.g.
 * `createEntity`). Grouped by what the user actually experiences.
 */
function friendlyCrudMessage(name: string): string {
  if (name.includes('delete') || name.includes('Delete')) return 'Removing some records…';
  if (name === 'mergeNodes') return 'Merging duplicate records…';
  if (name.includes('Relationship')) return 'Connecting your records…';
  if (name.includes('create') || name.includes('Create')) return 'Adding to your records…';
  return 'Updating your records…';
}

function buildScopedTools(options: {
  scopes: AgentScope[];
  teamId: string;
  conversationId?: string;
  pageContext?: PageContext;
  emitUpdate: (update: Omit<AgentUpdate, 'sessionId' | 'timestamp'>) => void;
  trace: ToolTrace[];
  offers: CredentialConnectOffer[];
  /** Demo mode (Follow armed): the movement tools narrate the build. */
  showMode?: boolean;
}): ScopedToolSet {
  const { scopes, teamId, conversationId, pageContext, emitUpdate, trace, offers, showMode } = options;
  const enabled = new Set(scopes);
  const defs: any[] = [];
  const impls: Record<string, (args: any) => Promise<any>> = {};

  const announce =
    (message: string | ((args: any) => string), fn: (args: any) => Promise<any>) =>
    async (args: any) => {
      emitUpdate({
        type: 'tool_call',
        message: typeof message === 'function' ? message(args) : message,
      });
      try {
        return await fn(args);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    };

  // Ambient-context tools — always available, no scope gate. Pulled on
  // demand rather than pushed into the system prompt: page context
  // changes every navigation, so baking it into a (cached) system block
  // busted the prompt cache on every turn. As tools they're fetched only
  // when the agent actually needs to resolve "this"/"here" or reason
  // about the current time, and the system blocks stay stable.
  defs.push({
    type: 'function',
    name: 'whereAmI',
    description:
      "Where the user is in the app right now: the page they're viewing, the named things on screen (with ids), and any page-specific state. Call this to resolve references like \"this\", \"here\", or \"what am I looking at\". Context only — it grants no capability; everything still goes through your normal tools and scopes.",
    parameters: { type: 'object', properties: {} },
  });
  impls.whereAmI = announce('Checking where you are…', async () =>
    pageContext
      ? renderPageContextSection(pageContext)
      : "The user's location isn't available — they may be using a surface that doesn't report it, or interacting outside the app. Ask them what they're working on if it matters.",
  );

  defs.push({
    type: 'function',
    name: 'currentDateTime',
    description:
      'The current date and time (UTC, ISO 8601). Call this whenever you need "now" — relative dates ("next week"), recency judgements, or stamping a value. Never guess the date.',
    parameters: { type: 'object', properties: {} },
  });
  impls.currentDateTime = async () => {
    const now = new Date();
    return { iso: now.toISOString(), humanUtc: now.toUTCString() };
  };

  if (enabled.has('library.read')) {
    defs.push(...libraryToolDefinitions);
    impls.readBook = announce(
      (args) => {
        const count = args?.chapters?.length ?? (args?.chapter ? 1 : 0);
        if (!args?.bookId) return 'Looking through the guides…';
        if (count > 1) return 'Reading up on a few things…';
        return 'Reading up on how this works…';
      },
      async (args) => {
        const result = readBook(args ?? {});
        // The build stage's "reading the playbook" beat (readBook is a unified
        // tool, so it doesn't go through the movement tools' beat emitter).
        if (showMode && (args?.chapter || (args?.chapters?.length ?? 0) > 0)) {
          const beat = beatForToolCall({ name: 'readBook', args, result });
          if (beat) emitUpdate({ type: 'build', message: beat.label, data: beat });
        }
        return result;
      },
    );
  }

  if (enabled.has('knowledge.read')) {
    defs.push(...knowledgeReadToolDefinitions);
    impls.queryGraph = announce('Searching your data…', (args) => queryGraph(args, teamId));
    impls.getNodeDetail = announce('Looking up details…', (args) =>
      getNodeDetail(args.nodeId, teamId, args.mode ?? 'full'),
    );
    impls.searchFactStore = announce(
      (args) => `Looking through your records for "${args.query}"…`,
      async (args) => {
        const results = await searchFacts({
          query: args.query,
          teamId: teamId as TeamId,
          limit: Math.min(args.limit ?? 20, 50),
        });
        if (results.length === 0) return 'No matching facts found in historical documents.';
        return results.map((f) => ({
          subject: f.subject,
          predicate: f.predicate,
          object: f.object,
          similarity: Math.round(f.similarity * 100) / 100,
        }));
      },
    );
    defs.push(...recipeReadToolDefinitions);
    impls.getRecipe = announce('Loading recipe…', async (args: { name: string }) => {
      const recipe = await getKnowledgeQb(['recipe'])
        .selectFrom('recipe')
        .where('team_id', '=', teamId as TeamId)
        .where('name', '=', args.name)
        .select(['name', 'description', 'instructions'])
        .executeTakeFirst();
      if (!recipe) return { error: `Recipe "${args.name}" not found.` };
      return {
        name: recipe.name,
        description: recipe.description,
        instructions: recipe.instructions,
      };
    });
  }

  // Ontology tools: getOntology is a read; the rest edit the model.
  const ontologyTools = createOntologyAgentTools(emitUpdate, teamId);
  for (const def of ONTOLOGY_TOOL_DEFINITIONS as any[]) {
    const isRead = ONTOLOGY_READ_TOOL_NAMES.has(def.name);
    const scope: AgentScope = isRead ? 'knowledge.read' : 'knowledge.edit';
    if (!enabled.has(scope)) continue;
    defs.push(def);
    impls[def.name] = (ontologyTools as any)[def.name];
  }

  if (enabled.has('knowledge.edit')) {
    defs.push(...crudToolDefinitions);
    const crud: Record<string, (args: any) => Promise<any>> = {
      createEntity: (args) => createEntity(args, teamId),
      updateEntity: (args) => updateEntity(args, teamId),
      createRelationship: (args) => createRelationship(args, teamId),
      updateRelationship: (args) => updateRelationship(args, teamId),
      deleteEntity: (args) => deleteEntity(args, teamId),
      deleteRelationship: (args) => deleteRelationship(args, teamId),
      bulkCreateEntities: (args) => bulkCreateEntities(args, teamId),
      bulkUpdateEntities: (args) => bulkUpdateEntities(args, teamId),
      bulkDeleteEntities: (args) => bulkDeleteEntities(args, teamId),
      bulkCreateRelationships: (args) => bulkCreateRelationships(args, teamId),
      bulkDeleteRelationships: (args) => bulkDeleteRelationships(args, teamId),
      mergeNodes: (args) =>
        mergeNodes({
          targetNodeId: args.targetNodeId as NodeId,
          sourceNodeId: args.sourceNodeId as NodeId,
          teamId: teamId as TeamId,
        }),
    };
    for (const [name, fn] of Object.entries(crud)) {
      impls[name] = announce(friendlyCrudMessage(name), fn);
    }

    defs.push(...recipeEditToolDefinitions);
    impls.saveRecipe = announce(
      'Saving recipe…',
      async (args: { name: string; description: string; instructions: string }) => {
        const existing = await getKnowledgeQb(['recipe'])
          .selectFrom('recipe')
          .where('team_id', '=', teamId as TeamId)
          .where('name', '=', args.name)
          .select(['id'])
          .executeTakeFirst();
        if (existing) {
          await getKnowledgeQb(['recipe'])
            .updateTable('recipe')
            .set({
              description: args.description,
              instructions: args.instructions,
              updated_at: new Date(),
            })
            .where('id', '=', existing.id)
            .execute();
          return { success: true, action: 'updated', name: args.name };
        }
        await getKnowledgeQb(['recipe'])
          .insertInto('recipe')
          .values({
            team_id: teamId as TeamId,
            name: args.name,
            description: args.description,
            instructions: args.instructions,
          })
          .execute();
        return { success: true, action: 'created', name: args.name };
      },
    );
  }

  // Movement + catalog tools come from the movement agent's wired set.
  const movementScopesWanted = Object.values(MOVEMENT_TOOLS_BY_SCOPE).some((s) => enabled.has(s));
  if (movementScopesWanted) {
    const movementTools = createMovementAgentTools(emitUpdate, teamId as TeamId, { showMode });
    for (const def of movementToolDefinitions as any[]) {
      const scope = MOVEMENT_TOOLS_BY_SCOPE[def.name];
      if (!scope || !enabled.has(scope)) continue;
      // planBuild only makes sense on the build stage — it draws the plan
      // overlay a watching user sees.
      if (!showMode && def.name === 'planBuild') continue;
      defs.push(def);
      impls[def.name] = (movementTools as any)[def.name];
    }
  }

  if (enabled.has('catalog.read')) {
    defs.push({
      type: 'function',
      name: 'offerCredentialConnect',
      description:
        "Offer the user an in-chat button to connect an integration's credential (e.g. Attio). Call this when the user wants to connect a system. Pass the adapter slug. If the team already has that credential, this returns alreadyConnected:true and NO button is shown — tell the user it's already connected. Otherwise a Connect button is attached to your reply.",
      parameters: {
        type: 'object',
        properties: { adapterSlug: { type: 'string', description: 'Adapter slug, e.g. "attio".' } },
        required: ['adapterSlug'],
      },
    });
    impls.offerCredentialConnect = announce(
      (args) => `Setting up a way to connect ${args.adapterSlug}…`,
      async (args) => {
        const offer = await buildCredentialConnectOffer({
          adapterSlug: args.adapterSlug,
          hasCredentialOfType: (serviceType) => teamHasCredentialOfType(teamId, serviceType),
        });
        if ('error' in offer) return offer;
        if (!offer.alreadyConnected) offers.push(offer);
        return offer;
      },
    );
  }

  if (enabled.has('runs.read')) {
    const systemTools = createSystemAgentTools(emitUpdate, teamId as TeamId);
    defs.push(...(systemToolDefinitions as any[]));
    Object.assign(impls, systemTools);
  }

  if (enabled.has('files.read') && conversationId) {
    defs.push(...fileToolDefinitions);
    impls.listUploadedFiles = announce('Checking attached files…', async () =>
      listConversationFiles(conversationId),
    );
    impls.readUploadedFile = announce(
      (args) => `Reading attached file #${args.index}…`,
      async (args: { index: number; start_line?: number; end_line?: number }) => {
        const result = await readConversationFile({ conversationId, index: args.index });
        if ('error' in result) return result;
        const lines = result.content.split('\n');
        const start = Math.max(1, args.start_line ?? 1);
        const end = Math.min(lines.length, args.end_line ?? lines.length);
        const numbered = lines
          .slice(start - 1, end)
          .map((l, i) => `${start + i}: ${l}`)
          .join('\n');
        return {
          filename: result.filename,
          content: numbered,
          startLine: start,
          endLine: end,
          totalLines: lines.length,
        };
      },
    );
  }

  if (DELEGATION_ACTIVE) {
    defs.push(delegateToolDefinition);
    impls.delegate = announce('Delegating…', (args) => delegate(args));
  }

  // Uniform trace + size guard around every tool.
  for (const [name, fn] of Object.entries(impls)) {
    impls[name] = async (args: any) => {
      const t0 = Date.now();
      const result = await fn(args);
      const ms = Date.now() - t0;
      let resultSize = 0;
      try {
        resultSize = JSON.stringify(result).length;
      } catch {
        // non-serialisable result — leave size at 0
      }
      trace.push({ tool: name, args, ms, resultSize });
      if (resultSize > MAX_TOOL_RESULT_CHARS) {
        const rows = (result as any)?.rows;
        if (Array.isArray(rows)) {
          const truncated: unknown[] = [];
          let chars = 0;
          for (const row of rows) {
            const rowChars = JSON.stringify(row).length;
            if (chars + rowChars > MAX_TOOL_RESULT_CHARS) break;
            truncated.push(row);
            chars += rowChars;
          }
          return {
            ...(result as object),
            rows: truncated,
            truncated: true,
            totalRows: rows.length,
            message: `Result too large (${rows.length} rows). Showing first ${truncated.length}. Narrow the query (LIMIT, WHERE, fewer columns).`,
          };
        }
        return {
          truncated: true,
          message: `Result too large (${resultSize} chars). Narrow the request and retry.`,
        };
      }
      return result;
    };
  }

  return { defs, impls };
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const PERSONA = `You are the Listen-Fire assistant — one well-trained consultant across everything this workspace does: its knowledge model and data, its movements (the small programs that move data between tools), its connected systems, and the operational record of what has run.

## How you work

1. **Understand first, but silently.** When intent is genuinely ambiguous, restate it in a single clause and proceed. When it's clear, just act — do NOT open with a paragraph summarising what they asked; it reads as padding.
2. **Read before you act on unfamiliar ground.** The Library below holds the authoritative handbook for each capability. If a task touches territory you have not worked in this conversation — authoring a movement, evolving the model, judging provenance — read the relevant chapters with readBook BEFORE your first attempt (pass several chapter ids in one readBook call rather than one at a time). Do not guess at conventions a handbook defines.
3. **Questions about the app itself — where something lives, how to connect an integration — are answered from the \`using-listen-fire\` book, not from memory.** Read it with readBook before telling a user where to click or how to connect; the app's structure and the list of connectable integrations live there. When a user wants to connect an integration, prefer offering to connect it for them (the offerCredentialConnect tool) over describing manual steps. When you offer a Connect button, that reply must contain ONLY the offer — do not also ask the user clarifying questions in the same turn. Clicking the button immediately continues the conversation, so any question you asked would be skipped before they could answer it. Offer the button alone; once the credential is connected, then gather what you need to do next.
4. **Ground every claim in a tool result.** Never tell the user something was done unless the tool's return value confirms it. Never invent names — of entities, fields, adapters, or credentials.
5. **Act on clear intent; offer options on genuine ambiguity.** Clear directives ("set Stripe's status to Passed", "record that Alice invested in Acme") you execute and then report. Only when a request could plausibly mean several different things do you look first, then present the choices.
6. **Know your bearings on demand.** You are not told up front where the user is or what time it is. When the message says "this", "here", or "what am I looking at", call \`whereAmI\` to see their current page and the things on it. When you need the date or time — relative dates, recency, stamping a value — call \`currentDateTime\`. Never guess either.

## How to communicate

The user is a capable operator but not an engineer. Speak in their domain's vocabulary — the names of their entity types, fields, relationships, movements, and tools. Never mention internal machinery: no Cypher, SQL, queries, nodes, edges, schemas, scopes' internal ids, or framework shorthand. "Let me look up the companies in your data", not "I'll query the graph".

**Be brief, and move ONE step at a time.** Over-explaining is the most common failure — guard against it hard:
- Each reply surfaces ONE core thing and ends with ONE call to action — a single question, or a single "want me to do X?". Never lay out multi-phase plans, option menus, or two or three questions in one turn. If the work has many steps, do or ask the FIRST, then the next once they answer.
- Default to a few sentences. No "here's how we'll get there" preambles, no restating the whole goal, no explaining what you're about to do before doing it. Take the next obvious step and say what happened in a line or two.
- Prefer doing over describing: if the next step is yours (provision a channel, read a doc, build the movement), take it and report — don't narrate the plan first.

Concise and well-formatted (markdown), and err hard on the side of shorter.`;

function buildScopeSection(scopes: AgentScope[]): string {
  const enabled = new Set(scopes);
  const granted = ALL_AGENT_SCOPES.filter((s) => enabled.has(s));
  const lacking = ALL_AGENT_SCOPES.filter((s) => !enabled.has(s));

  const lines: string[] = ['## What you can do here'];
  lines.push(
    'Your capabilities are grouped into scopes. This conversation\'s surface has granted you some of them; the others exist on the platform but are NOT enabled here.',
    '',
    '### Granted on this channel',
  );
  for (const s of granted) lines.push(`- \`${s}\` — ${AGENT_SCOPES[s].summary}`);
  if (lacking.length > 0) {
    lines.push('', '### Exists, but not granted here');
    for (const s of lacking) lines.push(`- \`${s}\` — ${AGENT_SCOPES[s].summary}`);
    lines.push(
      '',
      'When a request needs an ungranted scope, decline gracefully and say exactly which capability this channel lacks — e.g. "Authoring automations needs the movements.author scope, which this channel doesn\'t have. From the main app chat I could do it." Never pretend the capability doesn\'t exist, and never try to work around the restriction.',
    );
  }
  return lines.join('\n');
}

// Demo build stage: plan first, so the user sees the approach while it works.
const DEMO_BUILD_PREAMBLE = `## You are authoring on the build stage — the user is watching

Before you ground, read, or write anything, call \`planBuild\` with about 5 short, plain-language steps describing what the AUTOMATION will do for the user — the journey of the data, end to end — outcomes a person would recognise ("Pull the company out of the email", "Add it to Attio, matched by domain", "Mirror it into the knowledge graph"), never code or jargon, and NOT your own process: do NOT mention reading handbooks, checking the catalog, inspecting schemas, or validating — only what the automation does. The user sees these on screen while you work. Do this FIRST, then proceed with the authoring steps below.`;

// The portable authoring DOCTRINE — what a movement is, the cardinal
// "write along edges, never flat rows" rule, use-cases-first, and
// factor-don't-copy — is NOT inlined here. It is domain knowledge a bare
// reader needs too, so it lives in the movements handbook's `foundations`
// chapter (single source of truth: same body feeds readBook / the Library
// page and this prompt). Resolved once at module load → deploy-static, so
// it injects into the cached system block without per-request variability.
const MOVEMENT_DOCTRINE = getMovementDoctrine();

const MOVEMENT_AUTHORING_SECTION = `## Authoring movements

Extracting data from inbound messages, emails, or documents IS a
movement: a listener whose action carries \`#extract\`. Never propose or
create an "extraction graph" — that is the legacy mechanism; the ones
that exist keep running, but every new extraction is authored as a
movement. Extraction can also run the source through plugins to clean or
enrich it before extracting (\`through [scrub_sensitive, fetch_pages]\`) —
reach for them rather than doing that work yourself.

${MOVEMENT_DOCTRINE}

**You are on the build stage — the user is WATCHING.** Author the automation live so they see it come together, grounding every piece in what the framework actually allows. Every \`saveMovement\` updates the page they are looking at — that is how they follow along.
1. Ground first: read the automations handbook (\`readBook('automations', …)\` — \`anatomy\` and \`patterns\` at least) and the real workspace (\`listCatalog\`, \`describeInstance\` for every (adapter, credential) pair). Never invent names or fields.
2. Save a skeleton FIRST. As soon as you know the shape, write the structure — imports + instance constructions, the extraction nested, the write targets CONNECTED (linked / tuple forms) with EMPTY bodies, and the \`listen\` — and \`saveMovement\` it with a human-readable display name (plain words, normal capitalisation — "Inbound email intake" — never underscores). This persists the automation immediately, even though it's incomplete, and takes the watching user straight to its page. Nothing goes live until it's complete and clean.
3. Fill it in progressively, re-saving as you go. Take the movement id the first save returns and call \`saveMovement\` again with that SAME id at each meaningful step — after finishing each write target, say. Each save updates the page, so the user watches it come together.
4. Ground each field name, edge, and value in \`completionsAt\` as you write it — pick from what it offers; never recall a name and hope.
5. \`saveMovement\` returns the same diagnostics \`validateMovement\` would. Repair and re-save until there are no error-severity ones; that final clean save is when the automation goes **live**.
6. Report briefly in plain language — what the automation does and where events enter (quote the inbound address for email listeners). Ground HOW and WHEN it fires in the adapter's described trigger behaviour (describeInstance reports it): never claim a trigger scope it doesn't state — e.g. don't say a Slack listener runs on "every message in a channel" when Slack only delivers the bot's subscribed events. Where the real behaviour depends on the user's external setup, say so or ask rather than asserting. Do NOT paste the program: the user can see it on screen and does not want to read code.

Save at coherent milestones — the skeleton, then a completed write target at a time. The user watches it come together; that's the point, and it is not a reason to re-save after every line.`;

// The non-demo path: author efficiently and save once. Used when the user is
// NOT watching (Follow off) — no narrated build, no progressive re-saves.
const MOVEMENT_AUTHORING_SECTION_PLAIN = `## Authoring movements

Extracting data from inbound messages, emails, or documents IS a
movement: a listener whose action carries \`#extract\`. Never propose or
create an "extraction graph" — that is the legacy mechanism; the ones
that exist keep running, but every new extraction is authored as a
movement. Extraction can also run the source through plugins to clean or
enrich it before extracting (\`through [scrub_sensitive, fetch_pages]\`) —
reach for them rather than doing that work yourself.

${MOVEMENT_DOCTRINE}

When asked to build or change an automation:
1. Read the automations handbook first — at minimum the \`anatomy\` and \`patterns\` chapters via readBook('automations', …), plus whatever the book's index routes your situation to. Do not author from memory.
2. Ground in the real workspace: listCatalog for adapters/credentials/plugins, describeInstance for every (adapter, credential) pair the program constructs — never invent names or fields.
3. As you write, ground each field name, edge, and value you're unsure of in \`completionsAt\` — pick from what it offers rather than recalling a name, so you don't invent fields or write flat when a linked target was available.
4. ALWAYS validateMovement before saveMovement, and re-validate after every repair until there are no error-severity diagnostics. Then saveMovement ONCE, clean.
5. Save with a human-readable display name (plain words, normal capitalisation: "Daily focus", "Inbound email intake" — never underscores); in-program identifiers stay snake_case.
6. Report briefly in plain language — what the automation does and where events enter (quote the inbound address for email listeners). Ground HOW and WHEN it fires in the adapter's described trigger behaviour (describeInstance reports it): never claim a trigger scope it doesn't state — e.g. don't say a Slack listener runs on "every message in a channel" when Slack only delivers the bot's subscribed events. Where the real behaviour depends on the user's external setup, say so or ask rather than asserting. Do NOT paste the program: the user can see it on screen and does not want to read code.`;

const KNOWLEDGE_EDIT_SECTION = `## Changing data and the model

- All changes go through the editing tools — they validate names and values against the model and return what actually happened. Confirm results from the tool's return value, never from your intent.
- Check for an existing entry before creating one — and search loosely, not by exact name: match on a distinctive word with CONTAINS (creating "Acme Corp" must surface "Acme Robotics"). If anything similar already exists, ask whether it's the same thing instead of creating a duplicate; only create without asking when nothing close matches. Use mergeNodes when two entries are really the same thing.
- Relationship statements ("Alice knows Bob", "Acme invested in Newco") are clear directives: create missing entities with what you have and record the link — don't block on optional details.
- Model edits (entity types, fields, relationships, dedup rules) cascade on delete — say what a delete will take with it. After creating types and fields, set uniqueness constraints so deduplication works. For design depth, read the knowledge-model book.`;

/**
 * System prompt as Anthropic blocks, ordered by stability so the
 * prompt cache (a strict prefix match) actually gets reused:
 *
 *   block 0: persona + library + scope sections + capability sections
 *            — identical for every conversation with the same scope
 *            set → cache_control: ephemeral (shared across teams)
 *   block 1: current knowledge model — per-team, changes only when
 *            the model is edited → cache_control: ephemeral
 *   block 2: page-context snapshot — different on every navigation →
 *            NO marker; it lives after the last breakpoint so it never
 *            invalidates the cached prefix
 *
 * The previous single-string form baked the per-request page context
 * into the one cached block, so every navigation re-wrote the whole
 * system prompt's cache entry. Content note: the knowledge-model
 * section now renders after the capability sections (it used to sit
 * inside the data-access section) — the stability boundary is the
 * point of the split.
 */
export async function buildSystemBlocks(options: {
  teamId: string;
  scopes: AgentScope[];
  funnelContext?: UnifiedFunnelContext | null;
  /** Demo mode (Follow armed): narrate authoring as a watchable build. */
  showMode?: boolean;
}): Promise<AnthropicSystemBlock[]> {
  const { teamId, scopes, funnelContext, showMode } = options;
  const enabled = new Set(scopes);
  const parts: string[] = [PERSONA];

  parts.push(`## The Library

One handbook per capability. Browse or read any of them with readBook. The shelf:

${renderShelfForPrompt()}`);

  parts.push(buildScopeSection(scopes));

  if (enabled.has('knowledge.read')) {
    parts.push(`## Your data access (internal — never expose to the user)

${CYPHER_REFERENCE}`);
  }

  if (enabled.has('knowledge.edit')) parts.push(KNOWLEDGE_EDIT_SECTION);
  if (enabled.has('movements.author')) {
    if (showMode) parts.push(DEMO_BUILD_PREAMBLE);
    parts.push(showMode ? MOVEMENT_AUTHORING_SECTION : MOVEMENT_AUTHORING_SECTION_PLAIN);
  }

  if (enabled.has('runs.read')) {
    parts.push(`## Debugging what happened

For "what happened to my message?" / "why didn't this sync?" questions: orient first (listMessages / listPipelineInputs / listPipelineOutputs), then walk the specific run (getPipelineRun stage by stage, or listTgRuns → getTgRun for automation firings). Quote error text directly; when nothing is wrong, say what you checked.`);
  }

  const blocks: AnthropicSystemBlock[] = [
    { text: parts.join('\n\n'), cacheControl: 'ephemeral' },
  ];

  if (enabled.has('knowledge.read')) {
    const schema = await renderGraphSchema(teamId);

    // Recipe index — name + description only; full instructions load on
    // demand via getRecipe. Folded into the knowledge-model block rather
    // than taking its own cache breakpoint: Anthropic caps cache_control at
    // 4 blocks per request and the layout already runs at that ceiling.
    // Both are knowledge.read-gated and team-stable, so they cache together.
    const recipes = await getKnowledgeQb(['recipe'])
      .selectFrom('recipe')
      .where('team_id', '=', teamId as TeamId)
      .select(['name', 'description'])
      .orderBy('name', 'asc')
      .execute();
    let recipeSection = '';
    if (recipes.length > 0) {
      const recipeList = recipes.map((r) => `- **${r.name}**: ${r.description}`).join('\n');
      const canSave = enabled.has('knowledge.edit');
      recipeSection = `

## Available recipes

The team has saved these reusable recipes. When a user's request matches a recipe, call getRecipe to load the full instructions before proceeding.${
        canSave ? ' You can also use saveRecipe when the user asks you to save an approach as a recipe.' : ''
      }

${recipeList}`;
    }

    blocks.push({
      text: `## Current knowledge model

${schema}${recipeSection}`,
      cacheControl: 'ephemeral',
    });
  }

  // Its own block (not folded into the shared prefix) so the big stable
  // prefix still caches across all conversations; this one is stable
  // within the funnel-originated conversation.
  if (funnelContext) {
    blocks.push({ text: renderFunnelContextSection(funnelContext) });
  }

  return blocks;
}

/**
 * The onboarding funnel's three picks, as a context block. Stable for the
 * whole conversation (set once at /setup), so it rides as a cached system
 * block. Keeps the universal agent anchored on the customer's domain —
 * this is the "better context in advance" that replaces routing setup to
 * a separate agent.
 */
function renderFunnelContextSection(funnel: UnifiedFunnelContext): string {
  const arcLine =
    funnel.suggestedArc === 'integration-first'
      ? 'They lean integration-first — connecting their existing tools is the natural place to start.'
      : funnel.suggestedArc === 'model-first'
        ? 'They lean model-first — sketching the data shape is the natural place to start; connecting tools can come once the shape is agreed.'
        : 'Their starting point is open — a single clarifying question will tell you whether to begin from the data shape or from connecting a tool.';
  const primerLine = funnel.primer ? `\n\nContext on their situation: ${funnel.primer}` : '';
  return `## How this conversation started

The user came in through onboarding and picked three things before landing here:

- **Pain:** ${funnel.pain}
- **Specifically:** ${funnel.painShape}
- **Area:** ${funnel.domain}

${arcLine}${primerLine}

Anchor on **${funnel.domain}** — the entity names, fields, and examples you propose should come from that area, not from any generic example. Open by reflecting their pick back and proposing a concrete first step, then help them set it up with your normal tools.`;
}

// ---------------------------------------------------------------------------
// Grounding check
// ---------------------------------------------------------------------------

// A cheap Haiku pass that runs once after the agent's turn, before the
// response reaches the user. It catches the failure mode where the agent
// *implies it used a tool it didn't* — most dangerously, presenting
// fabricated query/lookup results (a table of records, counts, named
// entities "from your data") when no read tool actually ran, or claiming a
// write completed when no write tool ran. This is an accountability check,
// not a perpetual gate: a violation triggers a single corrective turn, then
// whatever the agent produces is sent.
const GROUNDING_CHECK_PROMPT = `You check whether an AI assistant's response implies it used a tool it did not actually use.

The assistant has tools to read the user's data (query the knowledge graph, look up records, search facts/messages, load recipes) and to change it (create/update/delete entities, save recipes, author movements, connect integrations). You will receive the user's message, the assistant's response, and the exact list of tools it called this turn.

A FALSE CLAIM is when the response:
- Presents SPECIFIC retrieved data as real — actual records, counts, tables, rankings, field values, or named instances "from your data / graph / CRM" — when NO read/query tool is in the tools-called list. (Fabricated lookup results are the worst case: the user trusts them as ground truth.)
- States a write was COMPLETED ("Updated!", "Created the company", "Saved", "Sent") when the corresponding tool is NOT in the list.

NOT a false claim:
- Reasoning, analysis, general world knowledge, or describing the SHAPE of the data model (entity types, fields, relationships) — the model schema is given to the assistant in context, so describing structure needs no tool.
- Proposals, offers, plans, clarifying questions, "I could look this up", or action buttons. These promise nothing as done.

Respond with a JSON object:
{ "thought": "<1-2 sentences: what the response claims, and whether a matching tool was called>", "has_false_action_claim": <true or false> }

"has_false_action_claim" is true ONLY when the response presents retrieved data or a completed action whose corresponding tool is absent from the list.`;

async function checkResponseGrounding(
  userMessage: string,
  responseText: string,
  toolsCalled: string[],
): Promise<string | null> {
  try {
    const result = await anthropicChat({
      system: GROUNDING_CHECK_PROMPT,
      userMessage: `## User message\n${userMessage}\n\n## Assistant response\n${responseText}\n\n## Tools called this turn\n${
        toolsCalled.length > 0 ? toolsCalled.join(', ') : '(none)'
      }`,
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 300,
      noContinue: true,
      label: 'unified_grounding_check',
    });
    const parsed = parseJson(result);
    if (parsed.has_false_action_claim) {
      return parsed.thought ?? 'False action claim detected';
    }
    return null;
  } catch (e) {
    logger.warn('[unified_agent] grounding check failed, skipping', { error: String(e) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

// The reasoning model for the main turn and the corrective turn. Opus, not
// Sonnet: this agent acts on the user's real data, so the floor on judgement
// matters more than the per-turn cost. 4.8 — same price as 4.7, better
// quality.
const UNIFIED_AGENT_MODEL: ChatModelName = 'claude-opus-4-8';

/** The room one turn's answer gets. Thinking, where a model does any, is paid
 *  for out of this same allowance. */
const UNIFIED_AGENT_OUTPUT_TOKENS = 16384;

/** Which model answers a turn, how hard it is asked to think, and how much it
 *  may write. A bake-off names one; nothing in the product does, and silence is
 *  the row above — including the silence about thinking, which is what the two
 *  call sites below have always sent. */
export interface UnifiedAgentCall {
  model: ChatModelName;
  /** Adaptive-thinking depth. Absent leaves the model to its own default,
   *  which differs by generation and is the reason this is nameable at all. */
  effort?: 'low' | 'medium' | 'high';
  maxOutputTokens?: number;
}

function unifiedAgentCall(override: UnifiedAgentCall | undefined): {
  model: ChatModelName;
  max_output_tokens: number;
  thinking?: { type: 'adaptive' };
  output_config?: { effort: 'low' | 'medium' | 'high' };
} {
  const call = override ?? { model: UNIFIED_AGENT_MODEL };
  return {
    model: call.model,
    max_output_tokens: call.maxOutputTokens ?? UNIFIED_AGENT_OUTPUT_TOKENS,
    ...(call.effort
      ? { thinking: { type: 'adaptive' as const }, output_config: { effort: call.effort } }
      : {}),
  };
}

/** What the onboarding funnel learned before the conversation started —
 *  primes the universal agent so setup lands here, not on a split agent. */
export interface UnifiedFunnelContext {
  pain: string;
  painShape: string;
  domain: string;
  suggestedArc: 'integration-first' | 'model-first' | null;
  primer?: string;
}

export interface UnifiedAgentOptions {
  sessionId?: string;
  teamId: string;
  conversationId?: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Enabled scopes for THIS invocation. Default: all. */
  scopes?: AgentScope[];
  /** Snapshot of the page the user is viewing — informs, never authorises. */
  pageContext?: PageContext;
  /** Onboarding-funnel selections, when this conversation began at /setup. */
  funnelContext?: UnifiedFunnelContext | null;
  /** Demo mode (Follow armed): narrate authoring as a watchable build stage. */
  showMode?: boolean;
  additionalToolDefs?: any[];
  additionalToolImpls?: Record<string, (args: any) => Promise<any>>;
  /** Benchmark seam: answer this turn on a named model at a named depth
   *  instead of the agent's own. No product caller sets it. */
  modelUnderTest?: UnifiedAgentCall;
}

export async function runUnifiedAgent(
  message: string,
  options: UnifiedAgentOptions,
): Promise<{ text: string; trace: ToolTrace[]; suggestedActions: SuggestedAction[] }> {
  const {
    sessionId,
    teamId,
    conversationId,
    conversationHistory,
    scopes = ALL_AGENT_SCOPES,
    pageContext,
    funnelContext,
    showMode,
    additionalToolDefs = [],
    additionalToolImpls = {},
  } = options;

  return currentContext().runAsync(async () => {
    const startTime = Date.now();
    const sid = sessionId || `ua-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const emitUpdate = (update: Omit<AgentUpdate, 'sessionId' | 'timestamp'>) => {
      if (sessionId) {
        mq.agentUpdates.update.publish({
          sessionId: sid,
          timestamp: Date.now(),
          ...update,
        });
      }
    };

    try {
      emitUpdate({ type: 'start', message: 'Looking into this…' });

      const trace: ToolTrace[] = [];
      const offers: CredentialConnectOffer[] = [];
      const { defs, impls } = buildScopedTools({ scopes, teamId, conversationId, pageContext, emitUpdate, trace, offers, showMode });
      const systemBlocks = await buildSystemBlocks({ teamId, scopes, funnelContext, showMode });

      const allToolDefs: any[] = [...defs, ...additionalToolDefs];
      const allToolImpls = wrapMutatingTools(
        { ...impls, ...additionalToolImpls },
        teamId,
      );

      const onTurn = (event: TurnEvent) => {
        if (event.thinkingText && event.toolNames.length > 0) {
          emitUpdate({ type: 'thinking', message: event.thinkingText });
        }
      };

      // Opus, deliberately. This agent reads and mutates the user's real
      // data and authors automations off it — the cost of a wrong query or a
      // fabricated answer is high, so we don't hand the reasoning loop to a
      // cheaper model. (Supersedes the 2026-06-11 "Sonnet composes Cypher
      // unaided" call: capability was never the question here; trust is.)
      const rawResult = await anthropicToolLoop(
        {
          ...unifiedAgentCall(options.modelUnderTest),
          maxTurns: 50,
          system: systemBlocks,
          userMessage: message,
          conversationHistory,
          tools: allToolDefs,
          onTurn,
          label: 'unified_agent',
        },
        allToolImpls,
      );

      const validated = AgentResponseSchema.parse(rawResult);
      let text =
        validated
          .map((item) => item.text || item.content)
          .filter((t): t is string => !!t)
          .join('\n\n') || 'No response generated';

      // Accountability check: before the user sees anything, verify the
      // response doesn't imply a tool it never called (fabricated lookup
      // results, or a write claimed as done). On a violation, give the agent
      // ONE corrective turn to actually call the tool or rewrite honestly —
      // a single challenge, not a loop.
      const toolsCalled = trace.map((t) => t.tool);
      const groundingIssue = await checkResponseGrounding(message, text, toolsCalled);
      if (groundingIssue) {
        logger.warn('[unified_agent] grounding check caught ungrounded claim', {
          sessionId: sid,
          issue: groundingIssue,
          toolsCalled,
        });

        const correctionMessage = `Your previous response was NOT sent to the user because it implied an action or result you did not actually produce: "${groundingIssue}". You called these tools this turn: [${
          toolsCalled.join(', ') || 'none'
        }]. Do not present data you did not retrieve or claim a change you did not make. Call the correct tool now to actually get the data or perform the action, then answer from the real result. If you genuinely cannot, rewrite your response honestly — say what you don't have rather than inventing it.`;

        // A capped, truncated, or otherwise failed correction loop must never
        // replace a good reply with an error — the uncorrected text stands.
        try {
        const correctedResult = await anthropicToolLoop(
          {
            ...unifiedAgentCall(options.modelUnderTest),
            system: systemBlocks,
            userMessage: correctionMessage,
            conversationHistory: [
              ...(conversationHistory ?? []),
              { role: 'user', content: message },
              { role: 'assistant', content: text },
            ],
            tools: allToolDefs,
            maxTurns: 6,
            label: 'unified_agent_correction',
          },
          allToolImpls,
        );

        const correctedText = AgentResponseSchema.parse(correctedResult)
          .map((item) => item.text || item.content)
          .filter((t): t is string => !!t)
          .join('\n\n');
        if (correctedText.trim()) text = correctedText;
        } catch (correctionErr) {
          logger.warn('[unified_agent] grounding correction failed; keeping the uncorrected reply', {
            sessionId: sid,
            error: correctionErr instanceof Error ? correctionErr.message : String(correctionErr),
          });
        }
      }

      const elapsedMs = Date.now() - startTime;
      const suggestedActions = offersToSuggestedActions(offers);
      logger.info('[unified_agent] turn complete', {
        sessionId: sid,
        elapsedMs,
        scopes,
        toolCalls: trace.map(({ tool, ms }) => ({ tool, ms })),
      });
      emitUpdate({
        type: 'complete',
        message: `Complete in ${(elapsedMs / 1000).toFixed(1)}s`,
        data: { elapsedMs, text, trace, suggestedActions, agent: 'unified' },
      });

      return { text, trace, suggestedActions };
    } catch (error: any) {
      if (error?.isHandoff || error?.isHandBack) throw error;

      emitUpdate({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        data: { error: String(error) },
      });

      if (error instanceof z.ZodError) {
        throw new Error(`Invalid response format: ${error.message}`);
      }
      throw error;
    }
  });
}
