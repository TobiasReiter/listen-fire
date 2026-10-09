import { z } from 'zod';

import type { AgentUpdate } from '../openai/types';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';

import { anthropicToolLoop, type TurnEvent } from '../anthropic';
import { AgentResponseSchema } from '../openai/db_agent_schema';
import { currentContext } from '../../services/context';
import { mq } from '../message_queue';
import { listTgRuns, getTgRun } from '../../services/system_debug';


const SYSTEM_PROMPT = `You are the System agent for Listen-Fire. You help users debug what happened to information they sent through the system.

## What you can see

You have read-only access to the operational record of data flowing through Listen-Fire:

- **Firings** — every event that hit an automation. A firing carries the trigger payload, the changed fields, the per-step action plans (what was written to the external system), diagnostics, and any errors.

## How to help

A user typically asks one of:
1. "Why didn't my data sync?" — locate the relevant firings via listTgRuns (filter by triggerId), check status/failureReason/errors, examine appliedActionPlans for what was attempted.
2. "Did my automation run?" — listTgRuns for the automation, then getTgRun on the firing in question.

## How to communicate

- Be direct and operational. The user is debugging — they want facts and pointers, not narrative.
- Always start by orienting: list relevant entities first (don't ask for an id you can find).
- When you find an error, quote the error text directly. Don't paraphrase.
- When you find no problem, say so clearly and describe what you checked.
- Surface ids the user can use in follow-ups (automation id, firing id).

## Specialist agents

You have access to specialist agents via the \`handoff\` tool:

- **query** — if the user wants to inspect actual knowledge graph data (entities, relationships, properties), not the run that produced it.
- **ontology** — if the user is asking about schema/model design (node types, edge types, extraction graphs).
- **output** — if the user wants to configure or modify outputs/integrations.

The handoff is invisible to the user — do NOT announce it. Just call \`handoff\` directly with a thorough referral.`;

interface SystemAgentOptions {
  sessionId?: string;
  teamId: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  additionalToolDefs?: any[];
  additionalToolImpls?: Record<string, (args: any) => Promise<any>>;
}

const toolDefinitions = [
  {
    type: 'function',
    name: 'listTgRuns',
    description:
      'List trigger runs (firings). Each firing is one event hitting one automation, aggregating every orchestration step. Scope to one automation via triggerId.',
    parameters: {
      type: 'object',
      properties: {
        triggerId: { type: 'string', description: 'Filter to firings of one automation (trigger)' },
        status: {
          type: 'string',
          description: 'Filter by status (success, partial, failed)',
        },
        limit: { type: 'number', description: 'Max rows (default 30)' },
        offset: { type: 'number' },
      },
    },
  },
  {
    type: 'function',
    name: 'getTgRun',
    description:
      'Full detail of one firing: trigger payload, changed fields, per-step applied action plans (what was written), diagnostics (reads/writes/skipped), errors, failure reason.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'trigger_run id' },
      },
      required: ['runId'],
    },
  },
];

const argSchemas = {
  listTgRuns: z.object({
    triggerId: z.string().optional(),
    status: z.string().optional(),
    limit: z.number().int().positive().max(100).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  getTgRun: z.object({ runId: z.string() }),
};

function createWrappedTools(
  emitUpdate: (update: Omit<AgentUpdate, 'sessionId' | 'timestamp'>) => void,
  teamId: TeamId,
) {
  const wrap =
    <K extends keyof typeof argSchemas>(name: K, fallbackMessage: (args: z.infer<(typeof argSchemas)[K]>) => string, fn: (args: z.infer<(typeof argSchemas)[K]>) => Promise<unknown>) =>
    async (rawArgs: unknown) => {
      const args = argSchemas[name].parse(rawArgs ?? {}) as z.infer<(typeof argSchemas)[K]>;
      const msg = fallbackMessage(args);
      emitUpdate({ type: 'tool_call', message: msg });
      try {
        const result = await fn(args);
        emitUpdate({ type: 'tool_call', message: `${msg} — done` });
        return result;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        emitUpdate({ type: 'tool_call', message: `${msg} — failed: ${errMsg}` });
        return { error: errMsg };
      }
    };

  return {
    listTgRuns: wrap(
      'listTgRuns',
      () => 'Listing TG runs...',
      (args) =>
        listTgRuns({
          teamId,
          triggerId: args.triggerId,
          status: args.status,
          limit: args.limit,
          offset: args.offset,
        }),
    ),
    getTgRun: wrap(
      'getTgRun',
      (args) => `Fetching TG run ${args.runId}...`,
      (args) =>
        getTgRun({
          teamId,
          runId: args.runId as TriggerRunId,
        }),
    )

  };
}

async function runSystemAgent(
  message: string,
  options: SystemAgentOptions,
): Promise<{ text: string }> {
  const { sessionId, teamId, conversationHistory, additionalToolDefs = [], additionalToolImpls = {} } = options;

  return currentContext().runAsync(async () => {
    const startTime = Date.now();
    const sid = sessionId || `sa-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
      emitUpdate({ type: 'start', message: 'Starting system agent...' });
      emitUpdate({ type: 'thinking', message: 'Understanding your request...' });

      let systemPrompt = SYSTEM_PROMPT;
      if (sid.startsWith('mcp-')) {
        systemPrompt += `\n\n## MCP session constraints\n\nThis request is being served via MCP with a tight time budget. Be direct and concise — short answers, minimal formatting, no preamble. Prefer a single tool call over chained lookups when possible.`;
      }

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
          max_output_tokens: 4096,
          maxTurns: 50,
          system: systemPrompt,
          userMessage: message,
          conversationHistory,
          tools: allToolDefs,
          onTurn,
          label: 'system_agent',
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
        data: { elapsedMs, text, agent: 'system' },
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
  runSystemAgent,
  createWrappedTools as createSystemAgentTools,
  toolDefinitions as systemToolDefinitions,
};
