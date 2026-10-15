// Model calls: the shared Anthropic client (movement-engine's lib/anthropic)
// on the provider key from the secrets file, under the reserved credential
// name `anthropic` (field `api_key`, and `base_url` for another endpoint
// speaking the same Messages API).
//
// Every model name goes to Anthropic under its own name: lf has no model map.
// Nothing is billed — there is no account to bill — so a run's cost cap does
// not see what its model calls spent.

import type { EngineHost } from 'movement-engine/services/movement_engine/host';
import type { ChatCall } from 'movement-engine/lib/models/chat';
import type { ChatModelName } from 'movement-engine/lib/models/registry';

import { anthropicClient } from 'movement-engine/lib/anthropic';
import { models } from 'movement-engine/lib/models/registry';
import { anthropicKeyedChatProvider, type AnthropicKey } from 'movement-engine/lib/models/providers/anthropic';
import { metered, refusingPastBudget } from 'movement-engine/services/translation_graph/movement/metered';
import {
  makeAnthropicExtractCallClient,
  makeAnthropicLlmClient,
} from 'movement-engine/services/translation_graph/movement/llm_clients';
import { arbitrateWithoutJudge } from 'movement-engine/services/translation_graph/uniqueness';
import { MODEL_CREDENTIAL, type Credential } from './secrets';

export function modelCalls(credentials: Map<string, Credential>): EngineHost['llm'] {
  const chat = anthropicClient({
    // Read at the call, not here: a run that never reaches a model needs no key.
    chatCallFor: (name) => anthropicCall(name, anthropicKey(credentials)),
    recordUsage: async () => {},
    logFields: () => ({}),
  });
  const llm = makeAnthropicLlmClient({ chat: chat.anthropicChatDetailed });
  const extractCall = makeAnthropicExtractCallClient({ chat: chat.anthropicChatDetailed });

  return {
    client: { call: (request) => metered(request, (input) => llm.call(input)) },
    extractCall: { call: (request) => metered(request, (input) => extractCall.call(input)) },
    transforms: {
      invoke: async ({ plugin }) => {
        throw new Error(`plugin "${plugin}" cannot run: lf does not serve plugins yet`);
      },
    },
    arbitrateEntities: (request) => refusingPastBudget(async () => arbitrate(request)),
  };
}

function anthropicKey(credentials: Map<string, Credential>): AnthropicKey {
  const fields = credentials.get(MODEL_CREDENTIAL)?.fields;
  const apiKey = fields?.api_key;
  if (apiKey === undefined || apiKey === '') {
    throw new Error(
      `a model call needs a provider key: add \`${MODEL_CREDENTIAL}: { external: anthropic, api_key: … }\` to the secrets file`,
    );
  }
  return { apiKey, ...(fields?.base_url !== undefined ? { baseUrl: fields.base_url } : {}) };
}

function anthropicCall(name: ChatModelName, key: AnthropicKey): ChatCall {
  const { home } = models[name];
  if (home !== 'anthropic') {
    throw new Error(`model "${name}" is served by ${home}; lf calls only Anthropic`);
  }
  return {
    client: anthropicKeyedChatProvider(key),
    wireModel: name,
    resolved: { preferred: name, provider: 'anthropic', wireModel: name },
  };
}

// The rules decide what they can; a question only a judge can answer is
// declined and says why, the same answer a hosted run gives when its judge
// call fails — the write then reports it rather than reading as a considered
// decline.
async function arbitrate(
  request: Parameters<EngineHost['llm']['arbitrateEntities']>[0],
): Promise<{ index: number | null; judgeUnavailable?: string; cost: [] }> {
  const decided = arbitrateWithoutJudge(request);
  if (decided !== undefined) return { index: decided, cost: [] };
  return { index: null, judgeUnavailable: 'lf has no identity judge yet: an ambiguous match creates a new record', cost: [] };
}
