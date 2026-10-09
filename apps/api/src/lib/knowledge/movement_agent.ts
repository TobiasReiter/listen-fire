// The movement author agent — a consultant that turns plain-language
// briefs into movement (.mvt) programs through the propose → typecheck →
// repair loop the language was designed for
// (plans/2026-06-10-data-movement-language/1_principles.md §9).
//
// Tool surface (all team-scoped, reusing the movement services):
//   readAuthoringDoc — the movement handbook (lib/knowledge/movement_handbook)
//   listCatalog      — the workspace's adapters / credentials / plugins / kg
//   describeInstance — one (adapter, credential)'s live schema
//   validateMovement — parse + check + compile gate (predicts the save)
//   saveMovement     — persist + provision listeners
//   listMovements / getMovement — the saved inventory
//
// The agent follows the same runner pattern as the other knowledge chat
// agents (system_agent et al.): the Claude tool loop, mq progress
// updates, registered under the 'movement' domain.

import { z } from 'zod';
import { getMovementCompletions } from 'movement-lang';

import type { AgentUpdate } from '../openai/types';
import type { TeamId } from '../../generated/kysely/core/Team';

import { anthropicToolLoop, type TurnEvent } from '../anthropic';
import { AgentResponseSchema } from '../openai/db_agent_schema';
import { currentContext } from '../../services/context';
import { mq } from '../message_queue';
import { splitChapterRoute } from '../handbook_section';
import {
  buildMovementFrontMatter,
  getMovementChapter,
  renderMovementIndex,
} from './movement_handbook';
import {
  formatMovementDiagnostics,
  validateMovementForTeam,
} from '../../services/translation_graph/movement/authoring';
import {
  describeMovementInstance,
  movementCatalogSnapshotForTeam,
  toAgentCatalogView,
} from '../../services/translation_graph/movement/catalog';
import {
  getMovement,
  listMovements,
  saveMovement,
} from '../../services/translation_graph/movement/provision';
import { beatForToolCall } from './build_beats';

const SYSTEM_PROMPT = `You are the movement author for Listen-Fire — a well-trained consultant who turns a user's plain-language brief into a working movement program.

## What a movement is

Saving a clean file provisions its listeners, and the automation is live.

${buildMovementFrontMatter()}

## How you work

1. **Understand the brief.** Restate what should happen, in one or two sentences, before writing any code. Ask only when the brief is genuinely ambiguous about intent; reasonable defaults (channel names, record naming) you may choose and state.
2. **Ground yourself before authoring.** Call \`listCatalog\` to see the workspace's real adapters, credentials, and plugins — NEVER invent an adapter, credential, type, or field name. Call \`describeInstance\` for every (adapter, credential) pair you plan to construct, and read the writable roots' exact field names. Read the relevant handbook chapters (\`readAuthoringDoc\`) before your first authoring pass — at minimum \`anatomy\` and \`patterns\`, plus whichever chapters the index routes your situation to.
3. **Save a skeleton FIRST, then watch it come together.** As soon as you know the shape, write the structure — imports + instance constructions, the extraction nested, the write targets CONNECTED (linked / tuple forms) with EMPTY bodies, and the \`listen\` statement — and call \`saveMovement\` with a human-readable display name. This persists the automation immediately — your text is kept even though it's incomplete — and takes a watching user straight to its page. It doesn't run yet: nothing goes live until it's complete and clean.
4. **Fill it in progressively, re-saving as you go.** Take the movement id the first save returns and, as you complete each body — grounding every field name, edge, and value in \`completionsAt\` (pick from what it offers; never recall-and-hope) — call \`saveMovement\` again with that SAME id at each meaningful step (e.g. after finishing each write target). Each save updates the page, so the user watches it come together. \`saveMovement\` returns the same diagnostics \`validateMovement\` would; keep going until there are no error-severity ones — that final clean save goes live.
5. **Iterate on diagnostics, don't argue with them.** A MOV_ENGINE_UNSUPPORTED diagnostic means the construct is valid language but ahead of today's engine — restructure per the message's hint (the handbook's "What runs today" notes cover the substitutions).
6. **Report.** Once the final save is live, report back at the user's altitude: what the automation does, where events enter (quote the inbound address for email listeners). Do NOT paste the program — the user can see it on screen and does not want to read code.

## Style

- You write the program; the user describes the outcome. Don't ask the user to write or edit code.
- Keep movements minimal: one movement per coherent reaction, \`unique by\` on entity-like targets, handles only where read.
- Use the user's naming when given ("name everything X" means the movement name, written record names where sensible, and listener key derive from X).
- **Two kinds of names.** The file's display name (saveMovement's \`name\`) is for humans — plain readable words ("Daily focus"), never underscores. Declared movement identifiers inside the program are code — snake_case (\`daily_focus\`), since the language requires identifiers. Always set both: readable display name on save, clean identifiers in the text.
- Be concise and concrete. No internal jargon (say "the program" or "the movement", not framework shorthand).`;

interface MovementAgentOptions {
  sessionId?: string;
  teamId: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  additionalToolDefs?: any[];
  additionalToolImpls?: Record<string, (args: any) => Promise<any>>;
}

const toolDefinitions = [
  {
    type: 'function',
    name: 'readAuthoringDoc',
    description:
      'Read the movement authoring handbook. Call with no chapter for the index (situations → chapter#section routes); call with a chapter id to read it in full, or with a section to read just that part — prefer the section when you need one rule. Read the relevant chapters BEFORE authoring.',
    parameters: {
      type: 'object',
      properties: {
        chapter: {
          type: 'string',
          description:
            'Chapter id from the index (e.g. "writes"), optionally with a section ("writes#identity"). Omit for the index.',
        },
        section: {
          type: 'string',
          description:
            'One section of the chapter (e.g. "identity"). Omit to read the whole chapter.',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'listCatalog',
    description:
      "The workspace's movement catalog: adapters (with construction arguments and listener-config keys), credentials (import name → adapter), plugins, and the knowledge graph's type names. These are the ONLY names valid in imports and constructions. Schemas are listed separately — call describeInstance for the pairs you will construct.",
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'describeInstance',
    description:
      "WALK one connected system. Omit `position` to stand at its root; the answer is that node — what it is, its properties, and every edge leaving it, each edge saying what it lands on and carrying the `position` that walks it. Echo one of those back as `position` to go deeper; never compose one yourself. An edge target marked `stub: true` means its fields exist but have not been fetched — hop to it, and never read it as a node without fields. Writable roots may carry `fieldDocs` — per-field value conventions and live workspace facts (e.g. Slack's actual channel names); follow them when choosing values. Call this for every (adapter, credential) pair the program constructs, before writing field mappings.",
    parameters: {
      type: 'object',
      properties: {
        adapter: { type: 'string', description: 'Adapter slug from listCatalog (e.g. "attio").' },
        credentialName: {
          type: 'string',
          description:
            'Credential import name from listCatalog. Omit for credential-free adapters (e.g. email).',
        },
      },
      required: ['adapter'],
    },
  },
  {
    type: 'function',
    name: 'validateMovement',
    description:
      'Typecheck a movement program against the live workspace catalog WITHOUT saving: parse, check, and compile each listener-fired movement. Returns diagnostics (code, message, severity, line/col, offending source line). A clean validation predicts a live save. ALWAYS run this before saveMovement.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'The complete .mvt program text.' },
      },
      required: ['source'],
    },
  },
  {
    type: 'function',
    name: 'completionsAt',
    description:
      "Ask the framework what is valid at a cursor inside a draft — the SAME completions the editor shows a human: the writable fields of the target you're in, the edges off a handle, keywords, meta-fields (@actor_email, …), enum options of the field you're setting. GROUND a field name, edge, or value in what the live catalog actually offers instead of recalling it and hoping. IMPORTANT: mark the cursor with the token `<|>` inside your draft and keep the surrounding program intact — including the closing braces of the block you're in — so the program parses and the target resolves (a truncated, unbalanced draft yields only generic keywords). Example: `write crm-[:Companies]-> {\\n  <|>\\n}` returns Companies' writable fields. Cheap — reach for it whenever you're about to commit a name you're not certain of, or to check a spot you've already written.",
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description:
            'The .mvt draft with a `<|>` marker at the cursor you want completions for. Keep the rest of the program (and the block\'s closing braces) around the marker so it parses. If no marker is present, completions are for the end of the text.',
        },
      },
      required: ['source'],
    },
  },
  {
    type: 'function',
    name: 'saveMovement',
    description:
      'Save a movement program and provision its listeners. Returns whether the save shipped, its runtime validity (valid / invalid / unverified), any diagnostics, and per-listener details including the inbound address for email listeners. Only call after validateMovement comes back clean.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'The complete .mvt program text.' },
        name: {
          type: 'string',
          description:
            'The file\'s display name — what the user sees in lists and page titles. ALWAYS provide one, written for a human: plain words, normal capitalisation ("Daily focus", "Inbound email intake"), never underscores or code-style identifiers. Libraries conventionally keep path-style names ("lib/contact-routines"). Omitting it falls back to the first movement declaration\'s identifier, which reads like code.',
        },
        description: { type: 'string', description: 'One-line summary for the movements list.' },
        id: {
          type: 'string',
          description: 'Existing movement id, when re-saving/renaming one (from listMovements).',
        },
      },
      required: ['source'],
    },
  },
  {
    type: 'function',
    name: 'planBuild',
    description:
      "DEMO BUILD MODE — call this FIRST, before writing anything. Lay out your approach as about 5 short, plain-language steps (what you'll do, not how) — e.g. \"Pull the company out of the email\", \"Add it to Attio, matched by domain\", \"Mirror it into the knowledge graph\". The user sees these on screen while you work, so keep them human and outcome-focused, no code or jargon.",
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'About 5 short plain-language steps describing your approach.',
        },
      },
      required: ['steps'],
    },
  },
  {
    type: 'function',
    name: 'listMovements',
    description:
      "List the team's saved movement files. `validityStatus` is the runtime health of the current source (valid = expected to run, invalid = has problems, unverified = couldn't be checked against a connected system, null = never checked) — it does NOT mean the file runs on its own. What a file IS comes from `facets`: `isAutomation` (it has listeners — events invoke it) and `isLibrary` (it has `export`-marked movements/shapes other files can import — a file can be both). A 'valid' library just checks clean. Each item also carries its listeners.",
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'getMovement',
    description:
      'One saved movement in full: the program source, runtime validity, and listener details. Accepts the movement id or its exact name.',
    parameters: {
      type: 'object',
      properties: {
        idOrName: { type: 'string', description: 'Movement id or exact name.' },
      },
      required: ['idOrName'],
    },
  },
];

const argSchemas = {
  readAuthoringDoc: z.object({ chapter: z.string().optional(), section: z.string().optional() }),
  listCatalog: z.object({}),
  describeInstance: z.object({
    adapter: z.string(),
    credentialName: z.string().optional(),
    /** WHERE TO STAND — an address a previous call handed back, echoed
     *  verbatim; absent is the root. Without this the hosted agent could not
     *  walk at all: it saw only the root and the flat schema, while the MCP
     *  route next door has taken a position all along. */
    position: z.string().optional(),
  }),
  validateMovement: z.object({ source: z.string() }),
  completionsAt: z.object({ source: z.string() }),
  saveMovement: z.object({
    source: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    id: z.string().optional(),
  }),
  planBuild: z.object({ steps: z.array(z.string()) }),
  listMovements: z.object({}),
  getMovement: z.object({ idOrName: z.string() }),
};

function createWrappedTools(
  emitUpdate: (update: Omit<AgentUpdate, 'sessionId' | 'timestamp'>) => void,
  teamId: TeamId,
  opts?: { showMode?: boolean },
) {
  const showMode = opts?.showMode === true;

  // In demo mode (Follow armed) the agent narrates its work on the build stage:
  // every beat-producing tool emits a `build` beat with the real artifact, and
  // any tool carrying a program (`source`) streams it as a `draft` so the editor
  // types it in (plans/2026-06-16-demo-build-stage).
  const emitBuild = (name: string, args: unknown, result: unknown) => {
    if (!showMode) return;
    if (typeof (args as { source?: unknown })?.source === 'string') {
      emitUpdate({ type: 'draft', message: 'drafting', data: { source: (args as { source: string }).source } });
    }
    if (name === 'saveMovement') {
      const r = result as { ok?: unknown; movementId?: unknown };
      const isLive = r?.ok === true;
      emitUpdate({
        type: 'build',
        message: isLive ? 'Live' : 'Filling it in',
        data: {
          phase: isLive ? 'live' : 'fill',
          label: isLive ? 'Your automation is live' : 'Filling it in',
          ...(isLive && typeof r?.movementId === 'string' ? { movementId: r.movementId } : {}),
        },
      });
      return;
    }
    const beat = beatForToolCall({ name, args, result });
    if (beat) emitUpdate({ type: 'build', message: beat.label, data: beat });
  };

  const wrap =
    <K extends keyof typeof argSchemas>(
      name: K,
      fallbackMessage: (args: z.infer<(typeof argSchemas)[K]>) => string,
      fn: (args: z.infer<(typeof argSchemas)[K]>) => Promise<unknown>,
      // Optional payload to ride along on the success ("— done") update, so the
      // client stream — not just the LLM — learns the result. Used by
      // saveMovement to surface the saved movement id for follow-along
      // navigation (plans/2026-06-16-follow-along).
      doneData?: (result: unknown) => Record<string, unknown> | undefined,
    ) =>
    async (rawArgs: unknown) => {
      const args = argSchemas[name].parse(rawArgs ?? {}) as z.infer<(typeof argSchemas)[K]>;
      const msg = fallbackMessage(args);
      emitUpdate({ type: 'tool_call', message: msg });
      try {
        const result = await fn(args);
        const data = doneData?.(result);
        emitUpdate({ type: 'tool_call', message: `${msg} — done`, ...(data ? { data } : {}) });
        emitBuild(name, args, result);
        return result;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        emitUpdate({ type: 'tool_call', message: `${msg} — failed: ${errMsg}` });
        return { error: errMsg };
      }
    };

  // Surface the saved movement id on the client stream as soon as a row
  // exists — INCLUDING draft saves (ok === false). Progressive authoring saves
  // an incomplete skeleton first to get the id and take a following user to the
  // page immediately, then fills it in; navigation must fire on that first
  // (draft) save, not only the final live one (plans/2026-06-16-follow-along).
  const savedMovementId = (result: unknown): Record<string, unknown> | undefined => {
    if (typeof result !== 'object' || result === null) return undefined;
    const r = result as { movementId?: unknown };
    if (typeof r.movementId === 'string') {
      return { savedMovementId: r.movementId };
    }
    return undefined;
  };

  return {
    readAuthoringDoc: wrap(
      'readAuthoringDoc',
      (args) => (args.chapter ? 'Reading up on how to do this…' : 'Getting my bearings…'),
      async (args) => {
        if (!args.chapter) return { ok: true as const, index: renderMovementIndex() };
        const route = splitChapterRoute(args.chapter);
        return getMovementChapter(route.chapter, route.section ?? args.section);
      },
    ),
    listCatalog: wrap(
      'listCatalog',
      () => 'Seeing what you have connected…',
      async () => {
        const catalog = await movementCatalogSnapshotForTeam(teamId);
        return toAgentCatalogView(catalog);
      },
    ),
    describeInstance: wrap(
      'describeInstance',
      (args) => `Taking a closer look at ${args.adapter}…`,
      async (args) =>
        describeMovementInstance({
          teamId,
          adapter: args.adapter,
          ...(args.credentialName !== undefined ? { credentialName: args.credentialName } : {}),
          ...(args.position !== undefined ? { position: args.position } : {}),
        }),
    ),
    validateMovement: wrap(
      'validateMovement',
      () => 'Double-checking it all fits together…',
      async (args) => validateMovementForTeam({ teamId, source: args.source }),
    ),
    completionsAt: wrap(
      'completionsAt',
      () => 'Working out the valid next step…',
      async (args) => {
        const MARKER = '<|>';
        const markerIdx = args.source.indexOf(MARKER);
        const offset = markerIdx === -1 ? args.source.length : markerIdx;
        const fullSource =
          markerIdx === -1
            ? args.source
            : args.source.slice(0, markerIdx) + args.source.slice(markerIdx + MARKER.length);
        const { snapshot } = await movementCatalogSnapshotForTeam(teamId);
        const result = getMovementCompletions(fullSource, offset, snapshot);
        return {
          completions: result.items.map((i) => ({
            label: i.label,
            kind: i.kind,
            ...(i.detail !== undefined ? { detail: i.detail } : {}),
          })),
        };
      },
    ),
    saveMovement: wrap(
      'saveMovement',
      (args) => `Saving your automation${args.name ? ` '${args.name}'` : ''}…`,
      async (args) => {
        const result = await saveMovement({
          teamId,
          source: args.source,
          changeSource: 'agent',
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.id !== undefined ? { id: args.id } : {}),
        });
        if (result.ok) return result;
        return {
          ...result,
          ...(result.diagnostics !== undefined
            ? { diagnostics: formatMovementDiagnostics(args.source, result.diagnostics) }
            : {}),
        };
      },
      savedMovementId,
    ),
    planBuild: wrap(
      'planBuild',
      () => 'Planning the approach…',
      async (args) => {
        const steps = args.steps.map((s) => s.trim()).filter(Boolean).slice(0, 6);
        emitUpdate({ type: 'plan', message: 'planning', data: { steps } });
        emitUpdate({
          type: 'build',
          message: 'Planning the approach',
          data: { phase: 'plan', label: 'Planning the approach' },
        });
        return { ok: true as const, steps };
      },
    ),
    listMovements: wrap(
      'listMovements',
      () => 'Listing saved movements…',
      async () => listMovements(teamId),
    ),
    getMovement: wrap(
      'getMovement',
      (args) => `Fetching movement '${args.idOrName}'…`,
      async (args) => {
        const byId = await getMovement({ teamId, id: args.idOrName }).catch(() => null);
        if (byId) return byId;
        const all = await listMovements(teamId);
        const named = all.find((m) => m.name === args.idOrName);
        if (!named) return { error: `No movement with id or name '${args.idOrName}'` };
        return getMovement({ teamId, id: named.id });
      },
    ),
  };
}

async function runMovementAgent(
  message: string,
  options: MovementAgentOptions,
): Promise<{ text: string }> {
  const {
    sessionId,
    teamId,
    conversationHistory,
    additionalToolDefs = [],
    additionalToolImpls = {},
  } = options;

  return currentContext().runAsync(async () => {
    const startTime = Date.now();
    const sid = sessionId || `mv-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
      emitUpdate({ type: 'start', message: 'Starting movement author…' });

      const wrappedTools = createWrappedTools(emitUpdate, teamId as TeamId);

      const allToolDefs: any[] = [...(toolDefinitions as any[]), ...additionalToolDefs];
      const allToolImpls = { ...wrappedTools, ...additionalToolImpls };

      const onTurn = (event: TurnEvent) => {
        if (event.thinkingText) {
          emitUpdate({ type: 'thinking', message: event.thinkingText });
        }
      };

      const rawResult = await anthropicToolLoop(
        {
          model: 'claude-sonnet-5',
          max_output_tokens: 8192,
          maxTurns: 50,
          system: SYSTEM_PROMPT,
          userMessage: message,
          conversationHistory,
          tools: allToolDefs,
          onTurn,
          label: 'movement_agent',
        },
        allToolImpls,
      );

      const validated = AgentResponseSchema.parse(rawResult);
      const text =
        validated
          .map((item) => item.text || item.content)
          .filter((t): t is string => !!t)
          .join('\n\n') || 'No response generated';

      const elapsedMs = Date.now() - startTime;
      emitUpdate({
        type: 'complete',
        message: `Complete in ${(elapsedMs / 1000).toFixed(1)}s`,
        data: { elapsedMs, text, agent: 'movement' },
      });

      return { text };
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

export {
  runMovementAgent,
  createWrappedTools as createMovementAgentTools,
  toolDefinitions as movementToolDefinitions,
};
