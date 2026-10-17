// The hosted product's answer to which provider serves each chat model name:
// its MODEL_MAP and environment pick the vendor and its credentials. The seam
// itself (`ChatProvider`, `ChatCall`) lives with the shared client.

import type { ChatCall, ChatProvider } from 'movement-engine/public/models';
import type { Provider } from 'movement-engine/public/models';
import type { ChatModelName } from 'movement-engine/public/models';

import { assertRunBudget } from 'movement-engine/public/models';
import { neverAsAny } from 'movement-engine/public/types';
import { assertCallable, resolveModel } from 'movement-engine/public/models';
import { anthropicChatProvider } from './providers/anthropic';
import { geminiChatProvider } from './providers/gemini';
import { openAiChatProvider } from './providers/openai';
import { vertexChatProvider } from './providers/vertex';

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

export function chatCallFor(name: ChatModelName, env: NodeJS.ProcessEnv): ChatCall {
  const resolved = resolveModel(name, env);
  assertCallable(resolved, env);
  // A run that has spent its cost cap gets no further model call. Checked here
  // for the callers that make one request per call; the Anthropic seam's queue
  // checks again per request, for the ones that loop.
  assertRunBudget();
  return { client: chatProviderFor(resolved.provider, env), wireModel: resolved.wireModel, resolved };
}

export type { ChatCall, ChatProvider };
