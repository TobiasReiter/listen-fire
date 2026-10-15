// The seam every chat call crosses: a provider object in Anthropic's own
// request and response types, plus the name to put on its wire.
//
// Typed structurally rather than as either SDK's class, so a translator that is
// not an Anthropic client at all can stand behind it, and so a caller cannot
// wander onto an endpoint (batches, files) that only one vendor has.

import type Anthropic from '@anthropic-ai/sdk';
import type { Provider, Resolved } from 'movement-engine/lib/models/map';
import type { ChatModelName } from 'movement-engine/lib/models/registry';

import { assertRunBudget } from '../run_spend';
import { neverAsAny } from 'movement-engine/lib/utils/types';
import { assertCallable, resolveModel } from 'movement-engine/lib/models/map';
import { anthropicChatProvider } from './providers/anthropic';
import { geminiChatProvider } from './providers/gemini';
import { openAiChatProvider } from './providers/openai';
import { vertexChatProvider } from './providers/vertex';


export type ChatProvider = {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): Promise<Anthropic.Message>;
    stream(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): { finalMessage(): Promise<Anthropic.Message> };
  };
};

export interface ChatCall {
  client: ChatProvider;
  wireModel: string;
  resolved: Resolved;
}

function chatProviderFor(provider: Provider, env: NodeJS.ProcessEnv): ChatProvider {
  switch (provider) {
    case 'anthropic':
      return anthropicChatProvider(env);
    case 'vertex':
      return vertexChatProvider(env);
    case 'openai':
      return openAiChatProvider(env);
    case 'gemini':
      return geminiChatProvider(env);
    default:
      return neverAsAny(provider);
  }
}

export function chatCallFor(name: ChatModelName, env: NodeJS.ProcessEnv = process.env): ChatCall {
  const resolved = resolveModel(name, env);
  assertCallable(resolved, env);
  // A run that has spent its cost cap gets no further model call. Checked here
  // for the callers that make one request per call; the Anthropic seam's queue
  // checks again per request, for the ones that loop.
  assertRunBudget();
  return { client: chatProviderFor(resolved.provider, env), wireModel: resolved.wireModel, resolved };
}
