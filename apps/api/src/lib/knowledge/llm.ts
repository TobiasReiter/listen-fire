// Knowledge's own model call, and the sink it reports what it spent to.
//
// D12: a shared LLM helper is a coupling every product inherits, so each unit
// vendors its own small one instead. This is knowledge's — the ~120 lines it
// actually needs, reporting usage through an interface rather than reaching for
// automations' metering, its wallet, its cost meter or its cancel gate. The
// composition root is the only place that knows both sides and wires them
// together; a standalone knowledge simply has no sink and records nothing.
//
// Degradation is LOUD and it is the caller's to handle (D42): no key configured
// is `null` from `knowledgeLlmKey()`, not a throw at import and not a silent
// call that fails at the vendor. The arbitration worker reads that and lets its
// queue grow visibly rather than burning attempts on a call that cannot succeed.

import { z } from 'zod';

import type Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider } from 'movement-engine/public/models';
import type { Provider, Resolved } from 'movement-engine/public/models';
import type { ChatModelName } from 'movement-engine/public/models';

import { missingGoogleServiceAccountVars } from 'movement-engine/public/google-cloud';
import { chatCallFor } from '../models/chat';
import { providerCredentialsPresent, resolveModel } from 'movement-engine/public/models';
import { anthropicKeyedChatProvider } from 'movement-engine/public/anthropic';
import { parseChatModelName } from 'movement-engine/public/models';
import { neverAsAny } from 'movement-engine/public/utils';
import { logger } from 'movement-engine/public/log';

/**
 * Knowledge's key, falling back to the composed deployment's. A self-hoster
 * sets `KNOWLEDGE_LLM_API_KEY` and nothing else; Listen-Fire's single process has one
 * key that both products use. Deliberately NOT `getEnvVar` with a dev default —
 * "no key" has to be expressible, because a store without one is a supported
 * deployment, not a misconfiguration.
 *
 * A key answers only when knowledge's model resolves to Anthropic's own API.
 * Elsewhere the model map decides who answers and with what credentials, and
 * the question "can knowledge call a model" is {@link isKnowledgeLlmConfigured}'s.
 */
export function knowledgeLlmKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.KNOWLEDGE_LLM_API_KEY ?? env.ANTHROPIC_API_KEY;
  return key ? key : null;
}

/** Overridable because the operator paying for the calls should get to choose. */
export function knowledgeLlmModel(env: NodeJS.ProcessEnv = process.env): ChatModelName {
  const raw = env.KNOWLEDGE_LLM_MODEL;
  return raw ? parseChatModelName(raw, 'KNOWLEDGE_LLM_MODEL') : 'claude-opus-5';
}

/** Refuse a `KNOWLEDGE_LLM_MODEL` the registry does not know, at boot rather
 *  than at the first arbitration. */
export function assertKnowledgeLlmModelConfigured(env: NodeJS.ProcessEnv = process.env): void {
  knowledgeLlmModel(env);
}

/** What an operator sets so knowledge's model can be called where it resolves. */
function credentialsToSet(provider: Provider, env: NodeJS.ProcessEnv): string {
  switch (provider) {
    case 'anthropic':
      return 'KNOWLEDGE_LLM_API_KEY or ANTHROPIC_API_KEY';
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'vertex':
    case 'gemini':
      return missingGoogleServiceAccountVars(env).join(', ');
    default:
      return neverAsAny(provider);
  }
}

export function isKnowledgeLlmConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const { provider } = resolveModel(knowledgeLlmModel(env), env);
  return provider === 'anthropic'
    ? knowledgeLlmKey(env) !== null
    : providerCredentialsPresent(provider, env);
}

/**
 * Knowledge's own client, resolved through the same model map as everything
 * else. On Anthropic's own API it keeps its own client on its own key — the
 * operator's choice of who pays for arbitration. Anywhere else the key has
 * nothing to open and is simply unused.
 */
function knowledgeLlmClient(env: NodeJS.ProcessEnv): { client: ChatProvider; resolved: Resolved } {
  const model = knowledgeLlmModel(env);
  const resolved = resolveModel(model, env);
  if (resolved.provider === 'anthropic') {
    const apiKey = knowledgeLlmKey(env);
    if (!apiKey) throw new KnowledgeLlmUnavailable();
    return { client: anthropicKeyedChatProvider({ apiKey }), resolved };
  }
  if (!providerCredentialsPresent(resolved.provider, env)) {
    throw new KnowledgeLlmUnavailable(credentialsToSet(resolved.provider, env));
  }
  return chatCallFor(model, env);
}

/**
 * Where knowledge reports what a call cost. Structural, and optional: the unit
 * works without one, it just meters nothing.
 */
export interface KnowledgeLlmUsageSink {
  record(usage: {
    teamId: string;
    /** What the call was for — the sink's only handle on which surface spent this. */
    purpose: string;
    /** Who answered and under what name, as the model map resolved it. */
    resolved: Resolved;
    inputTokens: number;
    outputTokens: number;
  }): void;
}

let usageSink: KnowledgeLlmUsageSink | null = null;

export function registerKnowledgeLlmUsageSink(sink: KnowledgeLlmUsageSink): void {
  usageSink = sink;
}

export class KnowledgeLlmUnavailable extends Error {
  /** What the operator has to set, which differs by where knowledge's model
   *  resolves: a key for Anthropic's own API, a Google service account for
   *  Vertex. */
  constructor(setThis = 'KNOWLEDGE_LLM_API_KEY or ANTHROPIC_API_KEY') {
    super(
      `No LLM credentials are configured for knowledge (set ${setThis}). ` +
        'Model-backed knowledge behaviour is disabled until they are.',
    );
    this.name = 'KnowledgeLlmUnavailable';
  }
}

const MAX_TOKENS = 8192;

/**
 * One model call returning a value of the caller's shape.
 *
 * The shape is enforced by a forced tool rather than by asking for JSON: the
 * vendor guarantees the arguments match the schema, so there is no parse to
 * salvage and no prose to strip. The tool is never executed — it exists only to
 * give the answer a type.
 */
export async function knowledgeLlmStructured<T extends z.ZodType>(input: {
  teamId: string;
  purpose: string;
  system: string;
  user: string;
  /** JSON Schema for the answer, and the validator it must satisfy. */
  schema: Record<string, unknown>;
  validator: T;
  env?: NodeJS.ProcessEnv;
}): Promise<z.infer<T>> {
  const env = input.env ?? process.env;
  const { client, resolved } = knowledgeLlmClient(env);
  const model = resolved.preferred;

  const response = await client.messages.create({
    model: resolved.wireModel,
    max_tokens: MAX_TOKENS,
    system: input.system,
    messages: [{ role: 'user', content: input.user }],
    tools: [
      {
        name: 'answer',
        description: input.purpose,
        input_schema: input.schema as Anthropic.Tool['input_schema'],
      },
    ],
    tool_choice: { type: 'tool', name: 'answer' },
  });

  usageSink?.record({
    teamId: input.teamId,
    purpose: input.purpose,
    resolved,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });

  const answer = response.content.find((block) => block.type === 'tool_use');
  if (!answer || answer.type !== 'tool_use') {
    // A forced tool that produced no tool block means the turn ended some other
    // way — refused, or truncated. Either is a failure the caller must see.
    logger.warn('[knowledge llm] forced tool produced no answer', {
      purpose: input.purpose,
      model,
      stopReason: response.stop_reason,
    });
    throw new Error(
      `Knowledge LLM call "${input.purpose}" returned no answer (stop_reason=${response.stop_reason}).`,
    );
  }

  return input.validator.parse(answer.input);
}
