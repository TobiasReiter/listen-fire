// The unified agent's deterministic tools, exposed as first-class REST/MCP
// primitives so an external Claude can author movements, read + edit the
// knowledge graph, and read the handbook DIRECTLY — without proxying through
// `start_conversation` (which runs the whole agent loop).
//
// Every handler here REUSES the exact same service function the agent's
// `buildScopedTools` (lib/knowledge/unified_agent.ts) wires — single source of
// logic, no duplication, no routing through the agent loop. Team-scoping is
// identical to the agent's: every op is bound to the MCP session's team (the
// ambient Principal's `teamId`, via `resolveToolTeam`) and the underlying
// service clamps to it, so a cross-team id simply isn't found → denied.
//
// Mechanism: every agent-facing op is a first-class top-level MCP tool in
// `interfaces/mcp/server.ts` (the knowledge MCP surface is FLAT — no
// describe_api/call_api shim). Each tool maps to one of the REST handlers
// mounted here, so the in-app agent, the MCP surface, and any other REST
// caller share one implementation. The route metadata is still registered on
// the registry (`registerKnowledgeAgentToolRoutes`) for non-MCP discovery.
//
// sibling of the
//   async-conversation surface; this is the DIRECT (non-agent) half.

import { randomUUID } from "node:crypto";

import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { currentPrincipal } from 'principal';
import {
  before,
  CURRENT_LANGUAGE_VERSION,
  getMovementCompletions,
  languageVersionView,
  type LanguageVersion,
  type LanguageVersionView,
} from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';
import type { NodeId } from '../../../generated/kysely/knowledge/Node';

import { getKnowledgeQb } from '../../../lib/kysely';
import { mintConnectLink } from '../../../services/credentials/connect_link';
import { mintGrantAccessLink } from '../../../services/credentials/grant_access';
import {
  startPhoneVerification,
  confirmPhoneVerification,
  userHasVerifiedWhatsappNumber,
} from '../../../services/whatsapp/phone_verification';
import { WHATSAPP_MOVEMENTS_WA_ME_LINK } from '../../../services/translation_graph/adapters/whatsapp';
import { readBook } from '../../../lib/knowledge/library';
import {
  LANGUAGE_SEARCH_KINDS,
  searchLanguage,
} from '../../../lib/knowledge/movement_handbook/language_search';
import { getNodeDetail } from '../../../lib/knowledge/knowledge_query';
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
} from '../../../lib/knowledge/query_agent_crud';
import { mergeNodes } from '../../../lib/knowledge/merge';
import { createOntologyAgentTools } from '../../../lib/knowledge/ontology_agent';
import {
  assessMovementValidity,
  validateMovementForTeam,
  formatMovementDiagnostics,
  type AuthoringDiagnostic,
  type TeamMovementValidation,
} from '../../../services/translation_graph/movement/authoring';
import { describeConnectionCompact } from '../../../services/translation_graph/movement/describe_connection';
import { renderGetStarted } from '../../../services/translation_graph/movement/get_started';
import {
  describeMovementInstance,
  movementCatalogSnapshotForTeam,
  toAgentCatalogView,
} from '../../../services/translation_graph/movement/catalog';
import {
  getMovement,
  listMovements,
  saveMovement,
  deleteMovement,
} from '../../../services/translation_graph/movement/provision';
import {
  getMovementRow,
  listMovementRows,
} from '../../../services/translation_graph/movement/store';
import {
  upgradeMovement,
  type UpgradeMovementResult,
} from '../../../services/translation_graph/movement/language_upgrade';
import { neverAsAny } from 'movement-engine/public/types';
import { movementSourceHash } from '../../../services/translation_graph/movement/version_store';
import { applyContentEdit } from '../../../services/translation_graph/movement/edit';
import {
  storyTokenForMovement,
  storyTokensForMovements,
  storyUrl,
} from '../../../services/translation_graph/movement/story_token';
import {
  runMovementAsync,
  getMovementRunStatus,
  listMovementRuns,
  inspectMovementRun,
} from '../../../services/translation_graph/movement/run_now';
import { abortRun, resumeRun } from '../../../services/interaction/operator';
import { RunBusy } from '../../../services/movement_engine/run_lease';
import { MovementEngineError } from 'movement-engine/public/errors';
import { UserService } from '../../../services/user';
import { registerRoute } from '../../mcp/registry';
import {
  ToolTeamError,
  listAccessibleTeams,
  resolveToolTeam,
  teamSetForReads,
  teamNames,
} from './team_scope';

const KNOWLEDGE_DOMAIN = 'knowledge';
const AUTOMATION_DOMAIN = 'automation';

function internalError(res: Parameters<RequestHandler>[1], err: unknown) {
  // A team-resolution problem (wrong/missing `team`) is a clean 400 the caller
  // can act on, not an opaque 500.
  if (err instanceof ToolTeamError) {
    return res.status(400).json({ error: err.message, ...(err.teams ? { teams: err.teams } : {}) });
  }
  const traceId = randomUUID();
  console.error(`[knowledge-agent-tools:${traceId}]`, err);
  return res.status(500).json({ error: 'internal_error', message: 'An internal error occurred.', traceId });
}

/**
 * The acting USER, when this connection has one. It is not the tenant: the
 * tenant is `resolveToolTeam` / the Principal's `teamId`, and every tool below
 * scopes on that. This answers the narrower question a handful of tools ask —
 * "which person is doing this?" — for which a machine principal (an api key
 * minted for a service, the static single-tenant stub) has no answer by design
 * (D2). `Context.user` THREW rather than saying so, and since these are the
 * tools a standalone automation deployment leads with, that throw is the thing
 * standing between it and a working MCP surface.
 *
 * Callers split two ways: a tool that merely ATTRIBUTES degrades to absent, a
 * tool that binds something TO a person refuses with {@link NO_ACTING_USER}.
 */
function actingUserId(): UserId | undefined {
  return currentPrincipal().userId as UserId | undefined;
}

/**
 * The refusal for tools whose whole job is to act on one person's account — a
 * connect link stamped with who asked for it, a phone number linked to a
 * login. There is no honest answer for a machine principal and no fake user to
 * invent, so the tool says which credential would work instead. `jsonHandler`
 * renders a bare `{ error }` as a 400.
 */
const NO_ACTING_USER = {
  error:
    'This tool acts on one person’s account, but this connection authenticates as a machine (an API key with no user behind it). Reconnect with a user-anchored credential to use it.',
};

/**
 * Wrap a handler that takes validated input and returns a JSON-serialisable
 * value. The service functions surface "team-scoped not found" / validation
 * problems as a returned `{ error }` object (the agent's `announce`
 * convention) — we map that to a 404/400 so the MCP caller sees a clean
 * status, exactly as a cross-team id is denied.
 */
/** A handler's answer that the request lost a race and may be retried:
 *  answered 409. */
class Conflict {
  constructor(readonly message: string) {}
}

function jsonHandler<I>(
  schema: z.ZodType<I>,
  source: 'body' | 'query' | 'params',
  run: (input: I) => Promise<unknown>,
): RequestHandler {
  return async (req, res) => {
    const raw = source === 'body' ? req.body : source === 'query' ? req.query : req.params;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }
    try {
      const result = await run(parsed.data);
      if (result instanceof Conflict) return res.status(409).json({ error: result.message });
      if (result && typeof result === 'object' && 'error' in result && Object.keys(result).length <= 2) {
        const message = String((result as { error: unknown }).error);
        const status = /not found|no .*found|unknown|not exist/i.test(message) ? 404 : 400;
        return res.status(status).json(result);
      }
      return res.status(200).json(result);
    } catch (err) {
      return internalError(res, err);
    }
  };
}

// A no-op event sink for the agent tool factories — these tools emit UI
// "tool_call" hints into a chat stream; on the MCP path there is no stream,
// so we discard them. The underlying mutation/read logic is unchanged.
const noopEmit = () => {};

// ---------------------------------------------------------------------------
// library.read — readBook
// ---------------------------------------------------------------------------

const readBookSchema = z.object({
  handbook: z.string().optional(),
  chapter: z.string().optional(),
  chapters: z.array(z.string()).optional(),
  section: z.string().optional(),
});

// The connector's agent has searchLanguage, so it is served the front page and
// looks the rest up rather than reading whole chapters.
const readBookHandler: RequestHandler = jsonHandler(readBookSchema, 'body', async (input) =>
  readBook({
    bookId: input.handbook,
    chapter: input.chapter,
    chapters: input.chapters,
    section: input.section,
    frontPageInsteadOfChapters: true,
  }),
);

// ---------------------------------------------------------------------------
// library.read — searchLanguage
// ---------------------------------------------------------------------------

const searchLanguageSchema = z.object({
  query: z.string().min(1),
  kind: z.enum(LANGUAGE_SEARCH_KINDS).optional(),
});

const searchLanguageHandler: RequestHandler = jsonHandler(searchLanguageSchema, 'body', async (input) =>
  searchLanguage({ query: input.query, ...(input.kind ? { kind: input.kind } : {}) }),
);

// ---------------------------------------------------------------------------
// knowledge.read — getNodeDetail, getRecipe, getOntology
// ---------------------------------------------------------------------------

const nodeDetailSchema = z.object({
  id: z.string(),
  mode: z.enum(['full', 'context']).optional(),
  team: z.string().optional(),
});

const getNodeDetailHandler: RequestHandler = async (req, res) => {
  const parsed = nodeDetailSchema.safeParse({ ...req.params, ...req.query });
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  try {
    const resolvedTeam = await resolveToolTeam(parsed.data.team);
    const result = await getNodeDetail(parsed.data.id, resolvedTeam, parsed.data.mode ?? 'full');
    if (result && typeof result === 'object' && 'error' in result) {
      return res.status(404).json(result);
    }
    return res.status(200).json(result);
  } catch (err) {
    return internalError(res, err);
  }
};

const getRecipeSchema = z.object({ name: z.string(), team: z.string().optional() });

const getRecipeHandler: RequestHandler = async (req, res) => {
  const parsed = getRecipeSchema.safeParse({ ...req.params, ...req.query });
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  try {
    const resolvedTeam = await resolveToolTeam(parsed.data.team);
    const recipe = await getKnowledgeQb(['recipe'])
      .selectFrom('recipe')
      .where('team_id', '=', resolvedTeam as TeamId)
      .where('name', '=', parsed.data.name)
      .select(['name', 'description', 'instructions'])
      .executeTakeFirst();
    if (!recipe) return res.status(404).json({ error: `Recipe "${parsed.data.name}" not found.` });
    return res.status(200).json({
      name: recipe.name,
      description: recipe.description,
      instructions: recipe.instructions,
    });
  } catch (err) {
    return internalError(res, err);
  }
};

const getOntologyHandler: RequestHandler = async (req, res) => {
  try {
    const team = typeof req.query.team === 'string' ? req.query.team : undefined;
    const resolvedTeam = await resolveToolTeam(team);
    const tools = createOntologyAgentTools(noopEmit, resolvedTeam);
    const result = await tools.getOntology();
    return res.status(200).json(result);
  } catch (err) {
    return internalError(res, err);
  }
};

// ---------------------------------------------------------------------------
// knowledge.edit — entity / relationship CRUD, merge, recipe, ontology
// ---------------------------------------------------------------------------

/** Each entry: (validation-passthrough) → underlying service fn, teamId-bound. */
const crudOps: Record<string, (args: any, team: string) => Promise<unknown>> = {
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
};

/** Args validated by the service fn itself; we forward the raw body object
 *  (minus the team-scoping `team`, which we resolve and pass as the teamId). */
const crudHandler = (name: keyof typeof crudOps): RequestHandler =>
  async (req, res) => {
    try {
      const { team, ...args } = (req.body ?? {}) as { team?: string } & Record<string, unknown>;
      const resolvedTeam = await resolveToolTeam(team);
      const result = await crudOps[name](args, resolvedTeam);
      if (result && typeof result === 'object' && 'error' in result) {
        const message = String((result as { error: unknown }).error);
        const status = /not found|no .*found|unknown|not exist/i.test(message) ? 404 : 400;
        return res.status(status).json(result);
      }
      return res.status(200).json(result);
    } catch (err) {
      return internalError(res, err);
    }
  };

const mergeNodesSchema = z.object({
  targetNodeId: z.string(),
  sourceNodeId: z.string(),
  team: z.string().optional(),
});

const mergeNodesHandler: RequestHandler = jsonHandler(mergeNodesSchema, 'body', async (input) =>
  mergeNodes({
    targetNodeId: input.targetNodeId as NodeId,
    sourceNodeId: input.sourceNodeId as NodeId,
    teamId: (await resolveToolTeam(input.team)) as TeamId,
  }),
);

const saveRecipeSchema = z.object({
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  team: z.string().optional(),
});

const saveRecipeHandler: RequestHandler = jsonHandler(saveRecipeSchema, 'body', async (input) => {
  const team = (await resolveToolTeam(input.team)) as TeamId;
  const existing = await getKnowledgeQb(['recipe'])
    .selectFrom('recipe')
    .where('team_id', '=', team)
    .where('name', '=', input.name)
    .select(['id'])
    .executeTakeFirst();
  if (existing) {
    await getKnowledgeQb(['recipe'])
      .updateTable('recipe')
      .set({ description: input.description, instructions: input.instructions, updated_at: new Date() })
      .where('id', '=', existing.id)
      .execute();
    return { success: true, action: 'updated', name: input.name };
  }
  await getKnowledgeQb(['recipe'])
    .insertInto('recipe')
    .values({
      team_id: team,
      name: input.name,
      description: input.description,
      instructions: input.instructions,
    })
    .execute();
  return { success: true, action: 'created', name: input.name };
});

/** The ontology-mutation tool names (reuses the agent's createOntologyAgentTools impls). */
const ONTOLOGY_MUTATION_TOOLS = [
  'createNodeType',
  'updateNodeType',
  'deleteNodeType',
  'createPropertyType',
  'updatePropertyType',
  'deletePropertyType',
  'createEdgeType',
  'updateEdgeType',
  'deleteEdgeType',
  'setUniquenessConstraints',
] as const;

const ontologyMutationHandler = (name: (typeof ONTOLOGY_MUTATION_TOOLS)[number]): RequestHandler =>
  async (req, res) => {
    try {
      const { team, ...args } = (req.body ?? {}) as { team?: string } & Record<string, unknown>;
      const resolvedTeam = await resolveToolTeam(team);
      const tools = createOntologyAgentTools(noopEmit, resolvedTeam) as Record<
        string,
        (args: any) => Promise<unknown>
      >;
      const result = await tools[name](args);
      if (result && typeof result === 'object' && 'error' in result) {
        const message = String((result as { error: unknown }).error);
        const status = /not found|no .*found|unknown|not exist/i.test(message) ? 404 : 400;
        return res.status(status).json(result);
      }
      return res.status(200).json(result);
    } catch (err) {
      return internalError(res, err);
    }
  };

// ---------------------------------------------------------------------------
// catalog.read — listCatalog, describeInstance
// ---------------------------------------------------------------------------

const listCatalogHandler: RequestHandler = async (req, res) => {
  try {
    const team = typeof req.query.team === 'string' ? req.query.team : undefined;
    const resolvedTeam = await resolveToolTeam(team);
    const catalog = await movementCatalogSnapshotForTeam(resolvedTeam as TeamId);
    return res.status(200).json(toAgentCatalogView(catalog));
  } catch (err) {
    return internalError(res, err);
  }
};

const describeInstanceSchema = z.object({
  system: z.union([z.string(), z.array(z.string())]),
  connection: z.string().optional(),
  team: z.string().optional(),
  types: z.array(z.string()).optional(),
  // WHERE TO STAND. One of the `position` strings a previous call's edges
  // handed back, echoed verbatim — never a path the caller composed. Absent is
  // the root, which is not a special case: it is the node you get when you name
  // no path.
  position: z.string().optional(),
  // Narrowing a polymorphic type is how you reach a member's own fields and
  // edges: the type itself shows only what ALL its members share, which is
  // frequently nothing. `where` is a movement-lang predicate over the fields
  // the edge's own `narrowBy` lists — the SAME string you put in the
  // movement's WHERE clause, so exploring and authoring share one vocabulary.
  narrow: z
    .object({ type: z.string(), where: z.string() })
    .optional()
    .describe(
      'Narrow a polymorphic type to one member and describe that member. ' +
        'e.g. { type: "Base", where: "`Name` == \\"CRM\\"" }',
    ),
  // How much to say. Absent is the compact text an agent authors against;
  // "full" is the JSON, for what the text leaves out.
  detail: z.enum(['compact', 'full']).optional(),
});

/**
 * The describe, as asked: the full JSON with `detail: "full"`, otherwise the
 * compact text — the digest's notation, scoped to the requested place. The
 * JSON is what an agent needs rarely (descriptions, capabilities, write
 * shapes); the text is what it authors against, at a fraction of the tokens.
 */
const describeInstanceHandler: RequestHandler = async (req, res) => {
  const parsed = describeInstanceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  const input = parsed.data;
  try {
    const teamId = (await resolveToolTeam(input.team)) as TeamId;
    if (input.detail === 'full') return res.status(200).json(await describeInstanceFull(teamId, input));
    // Batch form: each system at its root, one block apiece, described
    // concurrently. Per-system scoping is single-system only.
    const systems = Array.isArray(input.system) ? input.system : [input.system];
    const scoped = !Array.isArray(input.system);
    const blocks = await Promise.all(
      systems.map((system) =>
        describeConnectionCompact({
          teamId,
          system,
          ...(scoped && input.connection !== undefined ? { connection: input.connection } : {}),
          ...(scoped && input.types !== undefined ? { types: input.types } : {}),
          ...(scoped && input.position !== undefined ? { position: input.position } : {}),
          ...(scoped && input.narrow !== undefined ? { narrow: input.narrow } : {}),
        }),
      ),
    );
    return res.status(200).type('text/markdown').send(blocks.join('\n\n'));
  } catch (err) {
    return internalError(res, err);
  }
};

async function describeInstanceFull(teamId: TeamId, input: z.infer<typeof describeInstanceSchema>) {
  // Batch form: describe every named system in one call (concurrently) so
  // an automation touching several systems needs one round trip, not one
  // per system. Per-system `connection`/`types` scoping is single-system
  // only; the batch form describes each at its default connection.
  // Always force a fresh read: this route is `describeConnection`'s only
  // path to introspection, and the whole point of a describe is to ground
  // an agent on the LIVE schema — including a field the agent (or a human)
  // just added in the external workspace, which a warm cache entry would
  // otherwise still be hiding for up to the TTL.
  if (Array.isArray(input.system)) {
    const connections = await Promise.all(
      input.system.map(async (system) => ({
        system,
        ...(await describeMovementInstance({ teamId, adapter: system, forceRefresh: true })),
      })),
    );
    return { connections };
  }
  return describeMovementInstance({
    teamId,
    adapter: input.system,
    forceRefresh: true,
    ...(input.connection !== undefined ? { credentialName: input.connection } : {}),
    ...(input.types !== undefined ? { types: input.types } : {}),
    ...(input.position !== undefined ? { position: input.position } : {}),
    ...(input.narrow !== undefined ? { narrow: input.narrow } : {}),
  });
}

const connectCredentialSchema = z.object({
  system: z.string(),
  connection: z.string().optional(),
  team: z.string().optional(),
});

// Author-time: mint a single-use link the agent hands the user to connect an
// integration. Works for BOTH OAuth adapters (the link opens a browser sign-in)
// and API-key adapters (the link opens a browser form where the user pastes —
// or replaces — the key). Returns the URL, the connectKind, and the
// credentialName it will land under; the agent then polls listCatalog to
// confirm the credential appeared.
const connectCredentialHandler: RequestHandler = jsonHandler(
  connectCredentialSchema,
  'body',
  async (input) => {
    // The link is stamped with who asked for it and names the credential after
    // them, so it needs a person — a machine principal has none.
    const userId = actingUserId();
    if (userId === undefined) return NO_ACTING_USER;
    const result = await mintConnectLink({
      teamId: (await resolveToolTeam(input.team)) as TeamId,
      userId,
      adapterSlug: input.system,
      ...(input.connection !== undefined ? { credentialName: input.connection } : {}),
    });
    if ('error' in result) return result;
    const action =
      result.connectKind === 'oauth'
        ? `sign in to ${result.displayName}`
        : result.connectKind === 'intrinsic'
          ? `set it up for their team in one click — ${result.displayName} is part of Listen-Fire, so there's no sign-in or key`
          : result.connectKind === 'handshake'
            ? `link their ${result.displayName} account — the page opens ${result.displayName} with the Listen-Fire bot, where they must press Start to finish`
            : `paste their ${result.displayName} API key into a short form (it also lets them replace an existing key)`;
    return {
      url: result.url,
      adapter: result.adapter,
      displayName: result.displayName,
      connectKind: result.connectKind,
      credentialName: result.credentialName,
      expiresAt: result.expiresAt.toISOString(),
      instructions:
        `Give this link to the user and ask them to open it in their browser to ${action}. ` +
        `After they confirm they've connected, call listConnections again — ` +
        `the connection "${result.credentialName}" will appear in the results once it lands.`,
    };
  },
);

const grantAccessSchema = z.object({
  system: z.string(),
  connection: z.string().optional(),
  team: z.string().optional(),
});

// Author-time: mint a single-use link so the user grants access to specific
// items INSIDE an already-connected account (Google Sheets: the Drive picker
// under drive.file — picking is the only way to reach an existing file).
// Dispatches on the adapter manifest's construction action blocks, so the
// surface stays generic while the adapter carries the burden.
const grantAccessHandler: RequestHandler = jsonHandler(grantAccessSchema, 'body', async (input) => {
  // Same as connect: the link is minted for a named person to open.
  const userId = actingUserId();
  if (userId === undefined) return NO_ACTING_USER;
  const result = await mintGrantAccessLink({
    teamId: (await resolveToolTeam(input.team)) as TeamId,
    userId,
    system: input.system,
    ...(input.connection !== undefined ? { connection: input.connection } : {}),
  });
  if ('error' in result) return result;
  return {
    url: result.url,
    connection: result.credentialName,
    expiresAt: result.expiresAt.toISOString(),
    instructions:
      'Give this link to the user: it opens the provider\'s picker and the items they choose ' +
      'become visible to Listen-Fire (only those items). After they pick, call describeConnection ' +
      'for the system — the granted items\' types appear as writable types.',
  };
});

// ---------------------------------------------------------------------------
// WhatsApp number linking — prove a number is the user's so messages they send
// to the Listen-Fire WhatsApp number run their automations. Two steps: send a code,
// then confirm it — or one, on a deployment that trusts a signed-in user's claim
// (WHATSAPP_LINK_VERIFICATION=trust). The MCP key is user-bound, so the link
// targets that user.
// ---------------------------------------------------------------------------

const startWhatsappVerificationSchema = z.object({ phoneNumber: z.string().min(6) });

const startWhatsappVerificationHandler: RequestHandler = jsonHandler(
  startWhatsappVerificationSchema,
  'body',
  async (input) => {
    // The number is linked TO an account, so there must be an account.
    const userId = actingUserId();
    if (userId === undefined) return NO_ACTING_USER;
    const res = await startPhoneVerification({
      userId,
      phoneNumber: input.phoneNumber,
    });
    if (!res.ok) {
      const message =
        res.reason === 'number_taken'
          ? 'That number is already linked to a different Listen-Fire account.'
          : res.reason === 'cooldown'
            ? 'A code was just sent — wait a minute before requesting another.'
            : 'Too many codes have been requested for that number recently. Try again shortly.';
      return { ok: false, reason: res.reason, message };
    }
    switch (res.outcome) {
      case 'linked':
        return {
          ok: true,
          outcome: res.outcome,
          ...whatsappLinkedResult('That number is now linked — no code is needed on this deployment.'),
        };
      case 'code_sent':
        return {
          ok: true,
          outcome: res.outcome,
          expiresAt: res.expiresAt.toISOString(),
          instructions:
            'A verification code was sent to that number on WhatsApp (it expires in a few minutes). ' +
            'Ask the user for the code they received, then call confirmWhatsappCode with the same number and the code.',
        };
      default:
        return neverAsAny(res);
    }
  },
);

const confirmWhatsappVerificationSchema = z.object({
  phoneNumber: z.string().min(6),
  code: z.string().min(1),
});

const confirmWhatsappVerificationHandler: RequestHandler = jsonHandler(
  confirmWhatsappVerificationSchema,
  'body',
  async (input) => {
    const userId = actingUserId();
    if (userId === undefined) return NO_ACTING_USER;
    const res = await confirmPhoneVerification({
      userId,
      phoneNumber: input.phoneNumber,
      code: input.code,
    });
    if (!res.ok) {
      const message =
        res.reason === 'no_code_needed'
          ? 'No code is needed on this deployment — linkWhatsappNumber links the number straight away.'
          : res.reason === 'no_active_code'
            ? 'No code is waiting for that number — request one first with linkWhatsappNumber.'
            : res.reason === 'expired'
              ? 'That code has expired — request a new one with linkWhatsappNumber.'
              : res.reason === 'too_many_attempts'
                ? 'Too many wrong attempts — request a new code with linkWhatsappNumber.'
                : 'That code is not right — double-check it with the user and try again.';
      return { ok: false, reason: res.reason, message };
    }
    return { ok: true, ...whatsappLinkedResult('That number is now verified and linked.') };
  },
);

/** What both ways of finishing a link tell the agent: where the user's
 *  messages go now, and the one-tap chat link when the deployment has one. */
function whatsappLinkedResult(lead: string): { chatLink: string | null; message: string } {
  return {
    chatLink: WHATSAPP_MOVEMENTS_WA_ME_LINK,
    message:
      `${lead} Messages the user sends to the Listen-Fire WhatsApp number will run their automations.` +
      (WHATSAPP_MOVEMENTS_WA_ME_LINK
        ? ` Give the user this link to open the chat and start straight away: ${WHATSAPP_MOVEMENTS_WA_ME_LINK}`
        : ''),
  };
}

// ---------------------------------------------------------------------------
// teams — the connection's accessible teams
// ---------------------------------------------------------------------------

const listTeamsHandler: RequestHandler = async (_req, res) => {
  try {
    return res.status(200).json({ teams: await listAccessibleTeams() });
  } catch (err) {
    return internalError(res, err);
  }
};

// ---------------------------------------------------------------------------
// getStarted — the first read of a build, in one call
// ---------------------------------------------------------------------------

const getStartedSchema = z.object({ team: z.string().optional() });

// Markdown, not JSON: the answer is prose and a digest, and escaping it into a
// JSON string costs the reader tokens for nothing.
const getStartedHandler: RequestHandler = async (req, res) => {
  const parsed = getStartedSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  try {
    const teams = await listAccessibleTeams();
    // Several teams and none named: list them rather than refuse, so the agent
    // learns them here instead of from a separate listTeams.
    const teamId =
      parsed.data.team === undefined && teams.length > 1
        ? null
        : ((await resolveToolTeam(parsed.data.team)) as TeamId);
    const text = await renderGetStarted({ teams, teamId });
    return res.status(200).type('text/markdown').send(text);
  } catch (err) {
    return internalError(res, err);
  }
};

// ---------------------------------------------------------------------------
// movements.read / movements.author
// ---------------------------------------------------------------------------

// Spans every team the connection covers (unpinned → all the user's teams;
// pinned → the one), tagging each movement with the team it lives in.
const listMovementsHandler: RequestHandler = async (_req, res) => {
  try {
    const teams = await teamSetForReads();
    const names = await teamNames(teams);
    const perTeam = await Promise.all(
      teams.map(async (t) =>
        (await listMovements(t)).map((m) => ({
          ...m,
          teamId: t,
          teamName: names.get(t) ?? t,
        })),
      ),
    );
    const movements = perTeam.flat();
    // One batched mint across every team's rows — the picture link is
    // offerable straight from the list, without a getAutomation round-trip
    // per row.
    const tokens = await storyTokensForMovements(
      movements.map((m) => ({ movementId: m.id, teamId: m.teamId })),
    );
    return res.status(200).json({
      movements: movements.map((m) => {
        const token = tokens.get(m.id);
        if (!token) throw new Error(`storyTokensForMovements did not mint a token for movement ${m.id}`);
        return { ...withLanguageVersionView(m), storyUrl: storyUrl(token) };
      }),
    });
  } catch (err) {
    return internalError(res, err);
  }
};

const getMovementSchema = z.object({ idOrName: z.string() });

const getMovementHandler: RequestHandler = jsonHandler(getMovementSchema, 'params', async (input) => {
  // Look across every team the connection spans, so an id/name from any of the
  // user's teams resolves.
  const teams = await teamSetForReads();
  for (const team of teams) {
    const byId = await getMovement({ teamId: team, id: input.idOrName }).catch(() => null);
    if (byId) return withStoryUrl(team, byId);
  }
  for (const team of teams) {
    const named = (await listMovements(team)).find((m) => m.name === input.idOrName);
    if (named) {
      const found = await getMovement({ teamId: team, id: named.id });
      return found ? withStoryUrl(team, found) : { error: `No automation '${input.idOrName}'.` };
    }
  }
  return { error: `No automation '${input.idOrName}'.` };
});

/**
 * Attach the automation's shareable picture.
 *
 * Minted on READ, not on save: the link is a capability, and a capability that
 * exists because someone asked for it is one fewer thing lying around. Reused
 * once minted, so the link an agent hands out is stable across conversations.
 */
async function withStoryUrl<
  T extends { id: string; languageVersion: LanguageVersion; validityCheckedAgainst: LanguageVersion | null },
>(teamId: string, movement: T) {
  const token = await storyTokenForMovement({ teamId, movementId: movement.id });
  return { ...withLanguageVersionView(movement), storyUrl: storyUrl(token) };
}

/**
 * An automation's language version as an agent reads it: the pin and the
 * version its last validation ran under, each by integer and name.
 */
function withLanguageVersionView<
  T extends { languageVersion: LanguageVersion; validityCheckedAgainst: LanguageVersion | null },
>(
  movement: T,
): Omit<T, 'languageVersion' | 'validityCheckedAgainst'> & {
  languageVersion: LanguageVersionView;
  checkedAgainst: LanguageVersionView | null;
} {
  const { languageVersion, validityCheckedAgainst, ...rest } = movement;
  return {
    ...rest,
    languageVersion: languageVersionView(languageVersion),
    checkedAgainst:
      validityCheckedAgainst === null ? null : languageVersionView(validityCheckedAgainst),
  };
}

const validateMovementSchema = z.object({
  source: z.string(),
  team: z.string().optional(),
  automation: z.string().optional(),
  languageVersion: z.number().int().optional(),
});

type AutomationValidation = TeamMovementValidation & { validatedUnder: LanguageVersionView };

/**
 * Check text the way a save would: an explicit version wins; else a saved
 * automation validates under its pin; else new text validates under the
 * current version. A saved automation checked under a version newer than its
 * pin is a check for the move, and hears what changed meaning on the way.
 */
async function validateAutomationText(input: {
  teamId: string;
  source: string;
  automation?: string;
  languageVersion?: LanguageVersion;
}): Promise<AutomationValidation | { error: string }> {
  let languageVersion = input.languageVersion;
  let upgradingFrom: LanguageVersion | undefined;
  if (input.automation !== undefined) {
    const row = await getMovementRow({ teamId: input.teamId, id: input.automation }).catch(() => null);
    if (!row) return { error: `No automation '${input.automation}' in this team.` };
    if (languageVersion === undefined) languageVersion = row.languageVersion;
    else if (before(row.languageVersion, languageVersion)) upgradingFrom = row.languageVersion;
  }
  const validation = await validateMovementForTeam({
    teamId: input.teamId,
    source: input.source,
    ...(languageVersion !== undefined ? { languageVersion } : {}),
    ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
  });
  return {
    ...validation,
    validatedUnder: languageVersionView(languageVersion ?? CURRENT_LANGUAGE_VERSION),
  };
}

/**
 * What an agent's save answers when the text would not go live: nothing is
 * saved, and the diagnostics come back as validateAutomation returns them, so
 * the save is itself the check and the fix starts from its answer. Null when
 * the text is clean and the save may go ahead.
 */
function unsavedRefusal(validation: AutomationValidation) {
  const validity = assessMovementValidity({ diagnostics: validation.diagnostics, gaps: validation.gaps });
  switch (validity.status) {
    case 'valid':
      return null;
    case 'invalid':
      return {
        ok: false as const,
        saved: false as const,
        message: 'Not saved: the program has errors (diagnostics). Fix them and save again.',
        diagnostics: validation.diagnostics,
        validatedUnder: validation.validatedUnder,
      };
    case 'unverified':
      return {
        ok: false as const,
        saved: false as const,
        message:
          "Not saved: a system it uses could not be checked (errors). Save again once the connection works, or pass acknowledgeErrors: true — with the user's consent — to save it unchecked.",
        errors: validation.gaps.map((g) => `couldn't check this automation against "${g.adapter}" (${g.detail})`),
        diagnostics: validation.diagnostics,
        validatedUnder: validation.validatedUnder,
      };
    default:
      return neverAsAny(validity.status);
  }
}

/** The warnings a clean check still carries, for a save to pass along. */
const remainingDiagnostics = (diagnostics: AuthoringDiagnostic[]) =>
  diagnostics.length > 0 ? { diagnostics } : {};

const validateMovementHandler: RequestHandler = jsonHandler(
  validateMovementSchema,
  'body',
  async (input) =>
    validateAutomationText({
      teamId: await resolveToolTeam(input.team),
      source: input.source,
      ...(input.automation !== undefined ? { automation: input.automation } : {}),
      ...(input.languageVersion !== undefined ? { languageVersion: input.languageVersion } : {}),
    }),
);

const upgradeMovementSchema = z.object({
  automation: z.string(),
  acknowledge: z.boolean().optional(),
  applyAllFixes: z.boolean().optional(),
  team: z.string().optional(),
});

/** What an agent is told for each upgrade outcome, in the user's terms. */
function upgradeMessage(result: Exclude<UpgradeMovementResult, { status: 'not_found' }>): string {
  const to = `"${result.to.name}" (${result.to.version})`;
  const rewritten = result.upgradedSource !== undefined;
  switch (result.status) {
    case 'already_current':
      return `Already written in ${to}, the current language version. Nothing to do.`;
    case 'blocked':
      return rewritten
        ? `Not upgraded: its old spellings rewrite into ${to} automatically (upgradedSource), and the rewritten text still reports the diagnostics listed — their lines are upgradedSource's, each with its source line. A diagnostic that carries a fix has a rewrite not proved to keep the meaning: read it, and call again with applyAllFixes: true to apply those too. Repair the others in the saved text (either spelling), save, and call this again.`
        : `Not upgraded: under ${to} it reports the diagnostics listed. Repair them (validate the edited text under languageVersion ${result.to.version}), save, and call this again.`;
    case 'unverified':
      return result.detail !== undefined
        ? `Not upgraded: ${result.detail}. Try again.`
        : `Not upgraded: a connected system it uses could not be read, so it cannot be shown to be clean under ${to}. Try again once the connection works.`;
    case 'needs_acknowledgement':
      return rewritten
        ? `Clean under ${to} once its old spellings are rewritten (upgradedSource). Call again with acknowledge: true to save that text and move it there; it keeps running as it does now until then.`
        : `Clean under ${to}. Call again with acknowledge: true to move it there; it keeps running as it does now until then.`;
    case 'upgraded':
      return `Upgraded to ${to}${rewritten ? ', its text rewritten into that version\'s spelling (upgradedSource)' : ''}. New runs use it; runs already in progress finish under the version they started with.`;
    default:
      return neverAsAny(result.status);
  }
}

const upgradeMovementHandler: RequestHandler = jsonHandler(
  upgradeMovementSchema,
  'body',
  async (input) => {
    const result = await upgradeMovement({
      teamId: await resolveToolTeam(input.team),
      id: input.automation,
      acknowledge: input.acknowledge === true,
      applyAllFixes: input.applyAllFixes === true,
    });
    if (result.status === 'not_found') {
      return { error: `No automation '${input.automation}' in this team.` };
    }
    return { ...result, message: upgradeMessage(result) };
  },
);

const completionsAtSchema = z.object({
  source: z.string(),
  team: z.string().optional(),
  automation: z.string().optional(),
  languageVersion: z.number().int().optional(),
});

const completionsAtHandler: RequestHandler = jsonHandler(
  completionsAtSchema,
  'body',
  async (input) => {
    const MARKER = '<|>';
    const markerIdx = input.source.indexOf(MARKER);
    const offset = markerIdx === -1 ? input.source.length : markerIdx;
    const fullSource =
      markerIdx === -1
        ? input.source
        : input.source.slice(0, markerIdx) + input.source.slice(markerIdx + MARKER.length);
    const teamId = (await resolveToolTeam(input.team)) as TeamId;
    const { snapshot } = await movementCatalogSnapshotForTeam(teamId);
    // Same version rule as validateAutomationText: explicit, else the saved automation's pin, else current.
    let languageVersion = input.languageVersion;
    if (languageVersion === undefined && input.automation !== undefined) {
      const row = await getMovementRow({ teamId, id: input.automation }).catch(() => null);
      if (!row) return { error: `No automation '${input.automation}' in this team.` };
      languageVersion = row.languageVersion;
    }
    const result = getMovementCompletions(fullSource, offset, snapshot, {
      languageVersion: languageVersion ?? CURRENT_LANGUAGE_VERSION,
    });
    return {
      completions: result.items.map((i) => ({
        label: i.label,
        kind: i.kind,
        ...(i.detail !== undefined ? { detail: i.detail } : {}),
      })),
    };
  },
);

const saveMovementSchema = z.object({
  source: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  id: z.string().optional(),
  team: z.string().optional(),
  /** Consent to save a broken automation live anyway. Without it, a save that
   *  can't be verified or has errors is refused with its diagnostics and
   *  nothing is saved, so you can fix it or check with the user first. */
  acknowledgeErrors: z.boolean().optional(),
  /** Optimistic-concurrency precondition: the `revision` a prior getAutomation
   *  call returned for this automation. When set on a re-save (an `id`) and
   *  the automation's current source no longer matches it — someone else
   *  saved a newer version since you read it — the save is refused as a
   *  conflict instead of silently overwriting. Omit for today's behaviour
   *  (no precondition). Ignored when creating a new automation. */
  expectedRevision: z.string().optional(),
});

const saveMovementHandler: RequestHandler = jsonHandler(saveMovementSchema, 'body', async (input) => {
  const teamId = await resolveToolTeam(input.team);
  // Validate first, and save nothing that would not go live: an agent's save is
  // its check, so text it got wrong never becomes the stored automation.
  // Consent (acknowledgeErrors) skips the refusal and ships the text as it is.
  let checked: AuthoringDiagnostic[] = [];
  if (input.acknowledgeErrors !== true) {
    const validation = await validateAutomationText({
      teamId,
      source: input.source,
      ...(input.id !== undefined ? { automation: input.id } : {}),
    });
    if ('error' in validation) return validation;
    const refusal = unsavedRefusal(validation);
    if (refusal) return refusal;
    checked = validation.diagnostics;
  }
  const result = await saveMovement({
    teamId,
    source: input.source,
    changeSource: 'agent',
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.id !== undefined ? { id: input.id } : {}),
    ...(input.acknowledgeErrors !== undefined ? { acknowledgeErrors: input.acknowledgeErrors } : {}),
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
  });
  if (result.ok) {
    // A manual channel is what runAutomation dispatches on — surface whether an
    // on-demand run is even possible, so the agent doesn't call runAutomation on
    // a listener-only automation and hit the "no manual channel" gate.
    const runnable = result.listeners.some((l) => l.kind === 'manual');
    // A WhatsApp listener goes live but silently never fires until the user's
    // number is linked — warn at save time rather than leaving them to wonder.
    // The check is about THIS caller's number, so a machine principal has none
    // to check and gets no such warning (rather than one phrased about an
    // account it doesn't have).
    // The save itself already reports what would surprise the author (listeners
    // retired by an unreadable consented source, a movement name another
    // automation fires); this handler only adds what it alone can see.
    const warnings: string[] = [...result.warnings];
    const savedBy = actingUserId();
    if (savedBy !== undefined && result.listeners.some((l) => l.kind === 'whatsapp')) {
      const verified = await userHasVerifiedWhatsappNumber(savedBy);
      if (!verified) {
        warnings.push(
          "This automation listens for WhatsApp messages, but no WhatsApp number is linked to the user's account yet — it won't fire until they link one with linkWhatsappNumber.",
        );
      }
    }
    // The picture is offerable the moment something is saved — the authoring
    // loop's natural "here's what I built for you", without a second round trip.
    const token = await storyTokenForMovement({ teamId, movementId: result.movementId });
    return {
      ...result,
      runnable,
      storyUrl: storyUrl(token),
      warnings,
      ...remainingDiagnostics(checked),
    };
  }
  return {
    ...result,
    ...(result.diagnostics !== undefined
      ? { diagnostics: formatMovementDiagnostics(input.source, result.diagnostics) }
      : {}),
  };
});

// ---------------------------------------------------------------------------
// automations.read (windowed) / automations.edit / automations.grep — the
// Claude-Code-shaped editing primitives: a small read, a content-anchored
// write, and a search across the team's files. `resolveMovementRef` (below)
// is the same id-or-name lookup getMovementHandler uses.
// ---------------------------------------------------------------------------

const readAutomationSchema = z.object({
  idOrName: z.string(),
  offset: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});

// GET /automations/:idOrName/source?offset=&limit= — a windowed read, so an
// agent that wants to change one line doesn't have to resend (or re-read) the
// whole file. Line numbers are 1-based and only meaningful on THIS read: they
// go stale the moment anything else edits the file, which is why editAutomation
// anchors on content instead.
const readAutomationHandler: RequestHandler = async (req, res) => {
  const parsed = readAutomationSchema.safeParse({ ...req.params, ...req.query });
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  try {
    const { idOrName, offset, limit } = parsed.data;
    const ref = await resolveMovementRef(idOrName);
    if (!ref) return res.status(404).json({ error: `No automation '${idOrName}'.` });
    const movement = await getMovement({ teamId: ref.teamId, id: ref.movementId });
    if (!movement) return res.status(404).json({ error: `No automation '${idOrName}'.` });
    const allLines = movement.source.split('\n');
    const totalLines = allLines.length;
    const resolvedOffset = offset ?? 1;
    const startIndex = Math.max(0, resolvedOffset - 1);
    const endIndex = limit === undefined ? totalLines : Math.min(totalLines, startIndex + limit);
    const lines = allLines
      .slice(startIndex, endIndex)
      .map((text, i) => ({ n: startIndex + i + 1, text }));
    return res.status(200).json({
      id: movement.id,
      name: movement.name,
      revision: movement.revision,
      totalLines,
      offset: resolvedOffset,
      lines,
    });
  } catch (err) {
    return internalError(res, err);
  }
};

const editAutomationSchema = z.object({
  idOrName: z.string(),
  oldString: z.string().min(1),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
  expectedRevision: z.string().optional(),
  acknowledgeErrors: z.boolean().optional(),
});

// POST /automations/:idOrName/edit — splice `oldString` → `newString` into the
// CURRENT source, then save exactly as saveAutomation would: an edit is a
// save, with the same validity gate, the same expectedRevision precondition,
// and the same consent-to-ship-broken. There is no draft lane, so a broken
// edit to a library is visible to every importer immediately, same as a
// broken saveAutomation would be.
const editAutomationHandler: RequestHandler = async (req, res) => {
  const parsed = editAutomationSchema.safeParse({ ...req.params, ...req.body });
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  try {
    const input = parsed.data;
    const ref = await resolveMovementRef(input.idOrName);
    if (!ref) return res.status(404).json({ error: `No automation '${input.idOrName}'.` });
    const current = await getMovement({ teamId: ref.teamId, id: ref.movementId });
    if (!current) return res.status(404).json({ error: `No automation '${input.idOrName}'.` });

    const spliced = applyContentEdit({
      source: current.source,
      oldString: input.oldString,
      newString: input.newString,
      ...(input.replaceAll !== undefined ? { replaceAll: input.replaceAll } : {}),
    });
    if (!spliced.ok) {
      return res.status(400).json({ error: spliced.error });
    }

    // An edit is a save, and refuses what would not go live just as one does.
    let checked: AuthoringDiagnostic[] = [];
    if (input.acknowledgeErrors !== true) {
      const validation = await validateAutomationText({
        teamId: ref.teamId,
        source: spliced.source,
        automation: ref.movementId,
      });
      if ('error' in validation) return res.status(404).json(validation);
      const refusal = unsavedRefusal(validation);
      if (refusal) return res.status(200).json(refusal);
      checked = validation.diagnostics;
    }

    // Delegate to saveMovement for everything past the splice: the
    // expectedRevision precondition (a conflict here is refused exactly like a
    // stale saveAutomation, current source included, so the caller can re-read
    // and retry), the validity gate, listener provisioning, version minting.
    const result = await saveMovement({
      teamId: ref.teamId,
      id: ref.movementId,
      source: spliced.source,
      changeSource: 'agent',
      ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      ...(input.acknowledgeErrors !== undefined ? { acknowledgeErrors: input.acknowledgeErrors } : {}),
    });

    if (result.ok) {
      return res
        .status(200)
        .json({ ...result, revision: movementSourceHash(spliced.source), ...remainingDiagnostics(checked) });
    }
    return res.status(200).json({
      ...result,
      ...(result.diagnostics !== undefined
        ? { diagnostics: formatMovementDiagnostics(spliced.source, result.diagnostics) }
        : {}),
    });
  } catch (err) {
    return internalError(res, err);
  }
};

const grepAutomationsSchema = z.object({
  pattern: z.string().min(1),
  isRegex: z.coerce.boolean().optional(),
  contextLines: z.coerce.number().int().min(0).max(20).optional(),
  team: z.string().optional(),
});

const GREP_AUTOMATIONS_MAX_MATCHES = 200;

// GET /automations/grep?pattern=&isRegex=&contextLines=&team= — a search
// across a team's automations (every team the connection covers when `team`
// is omitted), so an agent can find where something is used without listing
// and reading every file. Literal substring by default; isRegex opts into a
// RegExp (an invalid pattern is a clean 400, not a throw).
const grepAutomationsHandler: RequestHandler = jsonHandler(
  grepAutomationsSchema,
  'query',
  async (input) => {
    let matches = (line: string) => line.includes(input.pattern);
    if (input.isRegex) {
      let re: RegExp;
      try {
        re = new RegExp(input.pattern);
      } catch (err) {
        return { error: `"${input.pattern}" is not a valid regular expression: ${(err as Error).message}` };
      }
      matches = (line) => re.test(line);
    }

    const teams = input.team ? [await resolveToolTeam(input.team)] : await teamSetForReads();
    const contextLines = input.contextLines ?? 0;
    const results: {
      id: string;
      name: string;
      teamId: string;
      line: number;
      text: string;
      before: string[];
      after: string[];
    }[] = [];
    let truncated = false;

    teamLoop: for (const teamId of teams) {
      const rows = await listMovementRows(teamId);
      for (const row of rows) {
        const lines = row.source.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!matches(lines[i])) continue;
          if (results.length >= GREP_AUTOMATIONS_MAX_MATCHES) {
            truncated = true;
            break teamLoop;
          }
          results.push({
            id: row.id,
            name: row.name,
            teamId,
            line: i + 1,
            text: lines[i],
            before: lines.slice(Math.max(0, i - contextLines), i),
            after: lines.slice(i + 1, i + 1 + contextLines),
          });
        }
      }
    }

    return { matches: results, truncated };
  },
);

const deleteMovementSchema = z.object({
  automation: z.string(),
  team: z.string().optional(),
});

// Remove a saved automation and every listener it derives (and tear down any
// now-orphaned external subscriptions). Same path the app's delete uses — a hard
// delete, so it's destructive-annotated on the tool. Returns { deleted: false }
// when no automation with that id lives in the resolved team, rather than erroring.
const deleteMovementHandler: RequestHandler = jsonHandler(deleteMovementSchema, 'body', async (input) => {
  const deleted = await deleteMovement({
    teamId: await resolveToolTeam(input.team),
    id: input.automation,
  });
  return { deleted, automation: input.automation };
});

const runMovementSchema = z.object({
  automation: z.string(),
  text: z.string().optional(),
  files: z
    .array(
      z.object({
        filename: z.string(),
        contentType: z.string(),
        contentBase64: z.string(),
      }),
    )
    .optional(),
  team: z.string().optional(),
});

// Run a saved movement on its manual channel, now. The acting team + user come
// from the MCP session (api-key auth), so the run's actor (`@user_*` / `@actor_*`)
// resolves to the caller — identical to pressing "Run now" in the app.
//
// ASYNC: a non-trivial run (extraction + writes) outlasts the MCP 55s tool-call
// limit, so we DISPATCH and return immediately with `{ runId, status: 'running' }`.
// The worker records the outcome on the run row; the caller polls
// `getMovementRun(runId)` for the result.
const runMovementHandler: RequestHandler = jsonHandler(runMovementSchema, 'body', async (input) => {
  // The actor is attribution: it feeds `@user_*` / `@actor_*` resolution and
  // the run's "who pressed Run now". A machine principal is nobody in
  // particular, so the run carries NO actor rather than a fabricated one —
  // those references simply resolve to nothing, which is the honest answer.
  const runBy = actingUserId();
  const user = runBy === undefined ? undefined : await UserService.getById(runBy);
  const teamId = await resolveToolTeam(input.team);
  // Names are accepted everywhere else; the run path alone compared the raw
  // string against a uuid column, which surfaced as a 500.
  const movementId = await resolveMovementIdInTeam({ teamId, idOrName: input.automation });
  if (movementId === null) return { error: `No automation '${input.automation}'.` };
  const result = await runMovementAsync({
    teamId,
    movementId,
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.files !== undefined ? { files: input.files } : {}),
    ...(user === undefined
      ? {}
      : {
          actor: {
            email: user.email,
            ...(user.username !== null ? { name: user.username } : {}),
          },
        }),
  });
  if (!result.ok) return { error: result.errors.join('; ') };
  return {
    runId: result.runId,
    status: result.status,
    movementName: result.movementName,
    hint: 'The run is dispatched and executing. Poll checkRun with this runId until status leaves "running" — it settles to "success" / "partial" / "failed" (or "parked" — paused, waiting for your review — see listReviews).',
  };
});

const getMovementRunSchema = z.object({ runId: z.string(), team: z.string().optional() });

// Read one run's status by id — the poll target for runMovement's async dispatch.
// Team-scoped: searches every team the connection covers, so a runId from any of
// the user's accessible teams resolves; a run in a team they can't see is simply
// not found (404).
const getMovementRunHandler: RequestHandler = jsonHandler(
  getMovementRunSchema,
  'body',
  async (input) => {
    const teams = await teamSetForReads();
    for (const team of teams) {
      const status = await getMovementRunStatus({ teamId: team, runId: input.runId });
      if (!('error' in status)) return status;
    }
    return { error: `run ${input.runId} not found` };
  },
);

async function resolveMovementIdInTeam(input: {
  teamId: string;
  idOrName: string;
}): Promise<string | null> {
  const byId = await getMovement({ teamId: input.teamId, id: input.idOrName }).catch(() => null);
  if (byId) return byId.id;
  const named = (await listMovements(input.teamId)).find((m) => m.name === input.idOrName);
  return named?.id ?? null;
}

// Resolve a movement reference (id or exact name) to its (teamId, movementId)
// across the teams the connection covers — the same lookup getMovementHandler
// performs, narrowed to the id needed to query its runs.
async function resolveMovementRef(
  idOrName: string,
): Promise<{ teamId: string; movementId: string } | null> {
  const teams = await teamSetForReads();
  for (const team of teams) {
    const byId = await getMovement({ teamId: team, id: idOrName }).catch(() => null);
    if (byId) return { teamId: team, movementId: byId.id };
  }
  for (const team of teams) {
    const named = (await listMovements(team)).find((m) => m.name === idOrName);
    if (named) return { teamId: team, movementId: named.id };
  }
  return null;
}

// List a movement's recent runs, newest first — the discovery surface that
// hands an agent the run ids a listener-fired movement never otherwise exposes.
// GET /movements/:idOrName/runs?limit=&team= (team is advisory; resolution
// spans every team the connection covers).
const listRunsHandler: RequestHandler = async (req, res) => {
  try {
    const idOrName = String(req.params.idOrName ?? '');
    const ref = await resolveMovementRef(idOrName);
    if (!ref) return res.status(404).json({ error: `No automation '${idOrName}'.` });
    const rawLimit = Number(req.query.limit);
    const runs = await listMovementRuns({
      teamId: ref.teamId,
      movementId: ref.movementId,
      ...(Number.isFinite(rawLimit) ? { limit: rawLimit } : {}),
    });
    return res.status(200).json({ runs });
  } catch (err) {
    return internalError(res, err);
  }
};

const inspectRunSchema = z.object({ runId: z.string(), team: z.string().optional() });

// Read one run's full captured detail — source event, resolved write-plan, and
// decision trace. Team-scoped: searches every team the connection covers.
const inspectRunHandler: RequestHandler = jsonHandler(
  inspectRunSchema,
  'body',
  async (input) => {
    const teams = await teamSetForReads();
    for (const team of teams) {
      const detail = await inspectMovementRun({ teamId: team, runId: input.runId });
      if (!('error' in detail)) return detail;
    }
    return { error: `run ${input.runId} not found` };
  },
);

// ---------------------------------------------------------------------------
// automations.cancel / automations.resume — the runs-cancel operator actions
// (services/interaction/operator.ts), reused as-is. Both are runId-scoped, not
// team-scoped up front, so team resolution follows the SAME search-across-
// accessible-teams pattern as run-status/inspectRun above: the run's own
// `team_id` FK is the real scope, `assertOwnedRun` inside each service fn reads
// a cross-team id as not-found, and we simply try each accessible team until
// one owns it.
// ---------------------------------------------------------------------------

const cancelRunSchema = z.object({ runId: z.string(), team: z.string().optional() });

// Stop a run by id (runs-cancel task 8 — the REST/MCP half of tRPC's abortRun).
// abortRun itself never throws except "not found" (a running run is stamped
// cancel-requested, a parked run is failed immediately, a terminal run no-ops)
// — so the loop only ever needs to distinguish "wrong team, keep looking" from
// a genuine result.
const cancelRunHandler: RequestHandler = jsonHandler(cancelRunSchema, 'body', async (input) => {
  // A label for the cancellation, nothing more — a machine principal cancels
  // anonymously rather than failing to cancel at all.
  const cancelledBy = actingUserId();
  const user = cancelledBy === undefined ? undefined : await UserService.getById(cancelledBy);
  const abortedBy = user?.username ?? user?.email ?? undefined;
  const teams = await teamSetForReads();
  for (const team of teams) {
    try {
      return await abortRun({
        runId: input.runId,
        teamId: team as TeamId,
        ...(abortedBy !== undefined ? { abortedBy } : {}),
      });
    } catch (err) {
      if (err instanceof MovementEngineError && /not found/i.test(err.message)) continue;
      throw err;
    }
  }
  return { error: `run ${input.runId} not found` };
});

const resumeRunSchema = z.object({ runId: z.string(), team: z.string().optional() });

// Resume a run paused at its cost limit (the REST/MCP half of tRPC's resumeRun).
// Same search-across-teams as cancel: "not found" means try the next team; a
// run that is found but not paused at a limit is reported as such.
const resumeRunHandler: RequestHandler = jsonHandler(resumeRunSchema, 'body', async (input) => {
  const teams = await teamSetForReads();
  for (const team of teams) {
    try {
      return await resumeRun({ runId: input.runId, teamId: team as TeamId });
    } catch (err) {
      if (err instanceof RunBusy) return new Conflict(err.message);
      if (err instanceof MovementEngineError && /not found/i.test(err.message)) continue;
      if (err instanceof MovementEngineError) return { error: err.message.replace(/^MOVENG_RUNTIME: /, '') };
      throw err;
    }
  }
  return { error: `run ${input.runId} not found` };
});

// ---------------------------------------------------------------------------
// Mount + register
// ---------------------------------------------------------------------------
//
// The handlers above back TWO independent connectors, each on its own router
// and its own coarse scope:
//   • Automation (`/v1/automation/*`, scope `automation`): movements, the
//     catalog, the handbook, credential-connect, and `/teams`.
//   • Knowledge  (`/v1/knowledge/*`,  scope `knowledge`):  KG read + validated
//     edits, the ontology (model), recipes, and `/teams`.
// `/teams` is shared — both connections list the teams they can act in.

/** Automation connector routes: movements, catalog, handbook, connect, teams. */
function mountAutomationToolRoutes(router: ReturnType<typeof Router>): void {
  // teams (shared with the knowledge connector)
  router.get('/teams', listTeamsHandler);

  // the first read of a build: the handbook's front page, the team, its systems
  router.get('/get-started', getStartedHandler);

  // library.read — the authoring handbook
  router.post('/handbook', readBookHandler);
  router.post('/language/search', searchLanguageHandler);

  // catalog.read
  router.get('/connections', listCatalogHandler);
  router.post('/connections/describe', describeInstanceHandler);
  router.post('/connections/connect', connectCredentialHandler);
  router.post('/connections/grant-access', grantAccessHandler);

  // whatsapp number linking (verification code loop)
  router.post('/whatsapp/verify/start', startWhatsappVerificationHandler);
  router.post('/whatsapp/verify/confirm', confirmWhatsappVerificationHandler);

  // movements
  router.get('/automations', listMovementsHandler);
  // `/automations/grep` must be registered before the `:idOrName` param route
  // below, or it would resolve as an automation named "grep".
  router.get('/automations/grep', grepAutomationsHandler);
  router.get('/automations/:idOrName/runs', listRunsHandler);
  router.get('/automations/:idOrName/source', readAutomationHandler);
  router.post('/automations/:idOrName/edit', editAutomationHandler);
  router.get('/automations/:idOrName', getMovementHandler);
  router.post('/automations/validate', validateMovementHandler);
  router.post('/automations/upgrade', upgradeMovementHandler);
  router.post('/automations/completions', completionsAtHandler);
  router.post('/automations/save', saveMovementHandler);
  router.post('/automations/delete', deleteMovementHandler);
  router.post('/automations/run', runMovementHandler);
  router.post('/automations/run-status', getMovementRunHandler);
  router.post('/automations/inspect-run', inspectRunHandler);
  router.post('/automations/cancel-run', cancelRunHandler);
  router.post('/automations/resume-run', resumeRunHandler);
}

/** Knowledge connector routes: KG read + validated edits, ontology, recipes, teams. */
function mountKnowledgeToolRoutes(router: ReturnType<typeof Router>): void {
  // teams (shared with the automation connector)
  router.get('/teams', listTeamsHandler);

  // knowledge.read
  router.get('/ontology', getOntologyHandler);
  router.get('/node-detail/:id', getNodeDetailHandler);
  router.get('/recipes/:name', getRecipeHandler);

  // knowledge.edit — entities / relationships
  router.post('/entities', crudHandler('createEntity'));
  router.patch('/entities', crudHandler('updateEntity'));
  router.delete('/entities', crudHandler('deleteEntity'));
  router.post('/entities/bulk-create', crudHandler('bulkCreateEntities'));
  router.post('/entities/bulk-update', crudHandler('bulkUpdateEntities'));
  router.post('/entities/bulk-delete', crudHandler('bulkDeleteEntities'));
  router.post('/relationships', crudHandler('createRelationship'));
  router.patch('/relationships', crudHandler('updateRelationship'));
  router.delete('/relationships', crudHandler('deleteRelationship'));
  router.post('/relationships/bulk-create', crudHandler('bulkCreateRelationships'));
  router.post('/relationships/bulk-delete', crudHandler('bulkDeleteRelationships'));
  router.post('/merge', mergeNodesHandler);
  router.post('/recipes', saveRecipeHandler);

  // knowledge.edit — ontology (model) mutations
  for (const name of ONTOLOGY_MUTATION_TOOLS) {
    router.post(`/ontology/${name}`, ontologyMutationHandler(name));
  }
}

/** A `reg` bound to a base path + domain, for one connector's route metadata. */
function makeReg(base: string, domain: string) {
  return (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    description: string,
    opts: { inputSchema?: z.ZodType; readOnly?: boolean; latency?: 'fast' | 'medium' | 'slow' } = {},
  ) =>
    registerRoute({
      method,
      path: `${base}${path}`,
      description,
      domain,
      ...(opts.inputSchema ? { inputSchema: opts.inputSchema } : {}),
      inputLocation: method === 'GET' ? 'query' : 'body',
      ...(opts.latency ? { latency: opts.latency } : {}),
      ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
    });
}

/** Register the automation connector's route metadata (domain `automation`). */
function registerAutomationToolRoutes(): void {
  const reg = makeReg('/v1/automation', AUTOMATION_DOMAIN);

  // teams
  reg(
    'GET',
    '/teams',
    'List the teams this connection can act in: each one\'s teamId, name, access, and isPersonal (true marks the user\'s personal workspace vs a shared team). Pass a teamId as `team` to tools that read or change a specific team. Also the top-level "listTeams" tool.',
    { readOnly: true, latency: 'fast' },
  );
  reg(
    'GET',
    '/get-started',
    'The first read of a build, as markdown: the automations handbook\'s front page, the team (every team, with ids, when the connection spans several and no `team` is named), and that team\'s systems — how to construct each, its record types with their fields, and what a listen on it may say. Query: team?. Also the top-level "getStarted" tool.',
    { inputSchema: getStartedSchema, readOnly: true, latency: 'medium' },
  );

  // library
  reg(
    'POST',
    '/handbook',
    'Read the Listen-Fire handbooks. No args → every handbook + its chapters. handbook → that handbook\'s chapter index + when-to-read-what; for the automations handbook, its front page. handbook + chapter(s) → chapter bodies, except a whole hand-written automations chapter, which answers with a pointer to searchLanguage (its sections, system and plugin chapters, and the front page\'s sections read). Also the top-level "readHandbook" tool.',
    {
      inputSchema: readBookSchema,
      readOnly: true,
      latency: 'fast',
    },
  );
  reg(
    'POST',
    '/language/search',
    'Search the automation language: built-in functions (generated signatures), the front page\'s concepts, recipes, and what each system and plugin documents. Body: { query, kind?: "function" | "concept" | "recipe" }. Returns at most a few entries, each with its purpose, signature or short text, an example, and an anchor readHandbook serves. Also the top-level "searchLanguage" tool.',
    { inputSchema: searchLanguageSchema, readOnly: true, latency: 'fast' },
  );

  // connected systems
  reg('GET', '/connections', 'The connected systems list: the workspace\'s systems (construction args + listener-config keys + `triggerExpectation` — what a listener actually fires on; ground trigger-surface claims in it), connections, plugins, and knowledge-graph type names — the ONLY names valid in automation imports/constructions. Also the top-level "listConnections" tool.', { readOnly: true, latency: 'medium' });
  reg('POST', '/connections/describe', 'The live schema of one (system, connection) at one position. Body: { system, connection?, types?, position?, narrow?, detail? }. By default answers compact markdown in getStarted\'s notation (the node\'s fields, its edges with their targets\' fields one level deep; at the root, how to construct and listen); `detail: "full"` answers the JSON described below. Call before authoring an automation against a system; every call re-reads the live schema, so call again after adding a field in the external workspace. Returns the system\'s description + triggerExpectation, plus an identity note (who a movement runs as, and whose activity triggers a listener) and a capability note (what it can read/write), even when no connection exists yet. A type listing `members` is POLYMORPHIC: it shows only what all its members share (often nothing), and you reach one member\'s real fields and edges by describing again with `narrow` — see `narrowBy` for the fields to test and `narrowingHint` for a worked example.', { inputSchema: describeInstanceSchema, readOnly: true, latency: 'medium' });
  reg('POST', '/connections/connect', 'AUTHOR-TIME: if a system the automation needs isn\'t connected yet, mint a single-use link for the user to open in their browser — no popup needed. Works for OAuth systems (the link opens a browser sign-in), API-key systems (the link opens a form to paste/replace the key), intrinsic systems (one-click confirm), and handshake systems (Telegram — the link opens Telegram with the Listen-Fire bot; the user presses Start there to finish). Body: { system, connection? }. Returns a link to send the user, the connect kind ("oauth" | "key-entry" | "intrinsic" | "handshake"), the name the connection will be stored under, and when the link expires. Hand the url to the user; after they connect, poll listConnections — the connection shows up in the results. Also the top-level "connectSystem" tool.', { inputSchema: connectCredentialSchema, latency: 'fast' });
  reg('POST', '/connections/grant-access', 'AUTHOR-TIME: some systems need access granted to specific items inside an already-connected account (Google Sheets: the Drive picker — under drive.file, picking is the only way to reach an existing file). Mint a single-use link where the user picks the item(s) to grant. Body: { system, connection? }. Returns { url, connection, expiresAt }. Systems without a grant flow return a clear error. Also the top-level "grantAccess" tool.', { inputSchema: grantAccessSchema, latency: 'fast' });

  // automations
  reg('GET', '/automations', 'List saved automations: id, name, status, listeners. Spans every team the connection covers; each item is tagged with its teamId + teamName.', { readOnly: true, latency: 'fast' });
  reg('GET', '/automations/:idOrName', 'Get one saved automation by id or name (across the teams the connection covers): its program, status, listeners, `revision` — a fingerprint of its current source — and `storyUrl`, a link to a picture of what it does that anyone can open (hand it to the user as a labelled link, e.g. [See what this does](url); it needs no login and always shows the current version). Re-read this (don\'t reuse an old copy) before editing an automation you already have, then pass its `revision` back as `expectedRevision` when you save.', { readOnly: true, latency: 'fast' });
  reg('GET', '/automations/:idOrName/source', 'Read an automation\'s program text a window at a time, by id or name — cheaper than getAutomation when you only need to see (or re-check) part of a long file. Pass ?offset= (1-based line number, default 1) and ?limit= (line count, default the rest of the file). Returns { id, name, revision, totalLines, offset, lines: [{ n, text }] }. Line numbers are only valid against THIS read — anything else that edits the file moves them, so anchor an edit on the text itself (editAutomation), not on `n`.', { readOnly: true, latency: 'fast' });
  reg('POST', '/automations/:idOrName/edit', 'Change one saved automation by splicing a snippet, without resending the whole program: pass the automation\'s id or name and { oldString, newString, replaceAll?, expectedRevision?, acknowledgeErrors? }. oldString must appear in the CURRENT source exactly once (read it first — readAutomation or getAutomation — and quote enough surrounding text to pin one spot), or the edit is refused with a 400 explaining why: not found, or found more than once (pass replaceAll: true to change every match instead of widening the anchor). Once the anchor resolves, this is exactly saveAutomation with the spliced result as the new source — same expectedRevision conflict check, same check first (an edit with errors is not saved; the diagnostics come back), same acknowledgeErrors consent. Returns save\'s result plus the new `revision`.', { latency: 'medium' });
  reg('GET', '/automations/grep', 'Search across a team\'s automations for a literal snippet (or, with isRegex: true, a regular expression) and get back every matching line: { matches: [{ id, name, teamId, line, text, before, after }], truncated }. Query: pattern, isRegex?, contextLines? (lines of surrounding context per match, default 0), team? (default: every team the connection covers). Capped at 200 matches. Use it to find where something is defined or imported before editing it.', { inputSchema: grepAutomationsSchema, readOnly: true, latency: 'fast' });
  reg('POST', '/automations/validate', 'Typecheck an automation program against the live connected systems WITHOUT saving. Returns diagnostics (code, message, severity, line/col). A clean validation predicts a live save; saving runs the same check first, so this is for exploring. Acts in your default team unless you pass `team`. Also the top-level "validateAutomation" tool.', { inputSchema: validateMovementSchema, latency: 'medium' });
  reg('POST', '/automations/upgrade', 'Move a saved automation onto the current language version. Body: { automation, acknowledge?, team? }. Rewrites its old spellings by the checker\'s fixes, validates the result under the current version and returns { status, from, to, diagnostics, upgradedSource?, message }: `blocked` (diagnostics to repair), `needs_acknowledgement` (clean — call again with acknowledge: true to move it), `upgraded`, `already_current`, or `unverified`. Without acknowledge nothing changes. Also the top-level "upgradeAutomation" tool.', { inputSchema: upgradeMovementSchema, latency: 'medium' });
  reg('POST', '/automations/completions', 'Given an automation program with a `<|>` cursor marker, return the valid next tokens at that point (writable fields, edges, enum options). Body: { source, team?, automation?, languageVersion? } (a saved automation completes under its pinned language version).', { inputSchema: completionsAtSchema, latency: 'medium' });
  reg('POST', '/automations/save', 'Save an automation program and provision its listeners (authoring → live). It validates first: text with errors, or that can\'t be verified, is NOT saved — the answer is { ok: false, saved: false, diagnostics } — and acknowledgeErrors: true ships it anyway (replacing whatever ran, even broken). A clean save goes live. No "draft" quietly keeps the last good version running. Returns diagnostics, per-listener details, runnable, `warnings` (saved fine, but would surprise the user — a movement name another automation already fires, or listeners retired because the saved source could not be read; always relay these), and `storyUrl` — a login-free link to a picture of what the automation does, worth offering as a labelled link once a save goes live. Body: { source, name?, description?, id?, acknowledgeErrors?, expectedRevision?, team? } — pass id to re-save, expectedRevision (the `revision` from your last getAutomation read) when updating an EXISTING automation so a concurrent edit can\'t be silently clobbered — a stale expectedRevision is rejected with { ok: false, conflict } instead of overwriting; call getAutomation again, merge, and re-save with the new revision. Omit expectedRevision for today\'s behaviour (no precondition — last write wins); it\'s ignored when creating a new automation. `team` files it in a specific team. Also the top-level "saveAutomation" tool.', { inputSchema: saveMovementSchema, latency: 'medium' });
  reg('POST', '/automations/delete', 'Permanently delete a saved automation and every listener it derives (a hard delete — the automation and its run triggers are gone, and any now-orphaned external subscriptions are torn down). Body: { automation, team? } — the automation id (from listAutomations); pass `team` when you belong to more than one. Returns { deleted } — false if no automation with that id lives in the resolved team. Also the top-level "deleteAutomation" tool.', { inputSchema: deleteMovementSchema, latency: 'fast' });
  reg('POST', '/automations/run', 'Dispatch a saved automation on its manual channel and return IMMEDIATELY with { runId, status: "running" } — the run executes asynchronously (it can take a while). Optionally pass text and/or files as its input. Body: { automation, text?, files?, team? }. Poll /automations/run-status (the "checkRun" tool) with the runId for the outcome. Also the top-level "runAutomation" tool.', { inputSchema: runMovementSchema, latency: 'fast' });
  reg('POST', '/automations/run-status', 'Read one automation run\'s status by id — the poll target for runAutomation. Body: { runId, team? }. Returns { status (running | parked | success | partial | failed), recordCount, errors, startedAt, finishedAt, failedAt, failureReason, costUsd, modelCalls } — costUsd/modelCalls are the run\'s model-call spend and call count. Poll until status leaves "running" ("parked" means paused, waiting for your review — see listReviews). Also the top-level "checkRun" tool.', { inputSchema: getMovementRunSchema, readOnly: true, latency: 'fast' });
  reg('GET', '/automations/:idOrName/runs', 'List an automation\'s recent runs (every listener / "Run now" firing), newest first. Returns each run\'s { runId, lane, triggerType, status, committed, captured, recordCount, timestamps, costUsd, modelCalls } — `committed` = writes that landed, `captured` = writes rehearsed (a `dry_run` target, or a whole-run rehearsal), `costUsd`/`modelCalls` = the run\'s model-call spend and call count. Use a runId with inspectRun to see what the run actually captured and wrote. Query: ?limit= (default 20), ?team=. Also the top-level "listRuns" tool.', { readOnly: true, latency: 'fast' });
  reg('POST', '/automations/inspect-run', 'Read one run\'s full captured detail by id: the source event that fired it, the resolved write-plan (every target record + the FINAL field values it wrote, with every `?:` and enum coercion applied, each write flagged `committed` or captured), the decision trace (gate/branch outcomes, extraction emissions), errors, and the run\'s `committed`/`captured` counts plus its `costUsd`/`modelCalls` model-call spend. The "did it actually do what I meant" surface — including exactly which writes a rehearsal captured versus committed. Body: { runId, team? }. Get runIds from listRuns. Also the top-level "inspectRun" tool.', { inputSchema: inspectRunSchema, readOnly: true, latency: 'fast' });
  reg('POST', '/automations/resume-run', 'Resume a run that paused because it reached its cost limit (checkRun shows it as status "parked" with `paused` set). Every part of the run that stopped carries on from where it stopped, and its usage resets, so the limit applies afresh. Body: { runId, team? }. Also the top-level "resumeRun" tool.', { inputSchema: resumeRunSchema, latency: 'fast' });
  reg('POST', '/automations/cancel-run', 'Stop a run by id — one that\'s executing or one that\'s paused waiting on something. Everything the run already did stays done; it just won\'t do anything more. An executing run stops at its next safe point (usually within seconds). Body: { runId, team? }. Also the top-level "cancelRun" tool.', { inputSchema: cancelRunSchema, latency: 'fast' });
}

/** Register the knowledge connector's route metadata (domain `knowledge`). */
function registerKnowledgeAgentToolRoutes(): void {
  const reg = makeReg('/v1/knowledge', KNOWLEDGE_DOMAIN);

  // teams
  reg(
    'GET',
    '/teams',
    'List the teams this connection can act in: each one\'s teamId, name, access, and isPersonal (true marks the user\'s personal workspace vs a shared team). Pass a teamId as `team` to tools that read or change a specific team. Also the top-level "listTeams" tool.',
    { readOnly: true, latency: 'fast' },
  );

  // knowledge.read
  reg('GET', '/ontology', 'The current knowledge model: entity types, fields, relationships, and dedup rules (names only). Reads your default team unless you pass ?team.', { readOnly: true, latency: 'fast' });
  reg('GET', '/node-detail/:id', 'Full detail for one entity: properties, connected relationships with provenance. Pass ?mode=context for a compact view. Reads your default team unless you pass ?team.', { readOnly: true, latency: 'fast' });
  reg('GET', '/recipes/:name', 'Load a saved recipe (reusable instructions) by exact name. Reads your default team unless you pass ?team.', { readOnly: true, latency: 'fast' });

  // knowledge.edit — acts in your default team unless you pass `team` (a teamId
  // from listTeams).
  reg('POST', '/entities', 'Create an entity (validated). Body: { type, properties, ..., team? } — see the knowledge-model handbook. Acts in your default team unless you pass `team`. Names/types are validated against the model; an unknown type → 400.', { latency: 'medium' });
  reg('PATCH', '/entities', 'Update an entity by id (validated). Acts in your default team unless you pass `team`. A cross-team id is not found → 404.', { latency: 'medium' });
  reg('DELETE', '/entities', 'Delete an entity by id (validated, team-scoped).', { latency: 'medium' });
  reg('POST', '/entities/bulk-create', 'Create many entities in one validated call.', { latency: 'medium' });
  reg('POST', '/entities/bulk-update', 'Update many entities in one validated call.', { latency: 'medium' });
  reg('POST', '/entities/bulk-delete', 'Delete many entities in one validated call.', { latency: 'medium' });
  reg('POST', '/relationships', 'Create a relationship between two entities (validated against the model).', { latency: 'medium' });
  reg('PATCH', '/relationships', 'Update a relationship (validated).', { latency: 'medium' });
  reg('DELETE', '/relationships', 'Delete a relationship (validated, team-scoped).', { latency: 'medium' });
  reg('POST', '/relationships/bulk-create', 'Create many relationships in one call.', { latency: 'medium' });
  reg('POST', '/relationships/bulk-delete', 'Delete many relationships in one call.', { latency: 'medium' });
  reg('POST', '/merge', 'Merge a duplicate entity into another. Body: { targetNodeId, sourceNodeId }.', { inputSchema: mergeNodesSchema, latency: 'medium' });
  reg('POST', '/recipes', 'Save or update a recipe. Body: { name, description, instructions }.', { inputSchema: saveRecipeSchema, latency: 'fast' });
  for (const name of ONTOLOGY_MUTATION_TOOLS) {
    reg('POST', `/ontology/${name}`, `Model mutation: ${name}. Edits the knowledge model itself (entity/field/relationship types, dedup rules), validated exactly as the agent's version. Body matches the agent tool's args.`, { latency: 'medium' });
  }
}

export {
  mountAutomationToolRoutes,
  mountKnowledgeToolRoutes,
  registerAutomationToolRoutes,
  registerKnowledgeAgentToolRoutes,
  // exported for unit tests
  getStartedHandler,
  readBookHandler,
  getNodeDetailHandler,
  listCatalogHandler,
  describeInstanceHandler,
  connectCredentialHandler,
  validateMovementHandler,
  upgradeMovementHandler,
  saveMovementHandler,
  readAutomationHandler,
  editAutomationHandler,
  grepAutomationsHandler,
  deleteMovementHandler,
  listMovementsHandler,
  runMovementHandler,
  getMovementRunHandler,
  listRunsHandler,
  inspectRunHandler,
  cancelRunHandler,
};
