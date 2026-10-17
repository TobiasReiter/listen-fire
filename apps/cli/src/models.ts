// Model calls: the shared Anthropic client (movement-engine's lib/anthropic)
// on the provider key from the secrets file, under the reserved credential
// name `anthropic` (field `api_key`, and `base_url` for another endpoint
// speaking the same Messages API).
//
// Every model name goes to Anthropic under its own name: lf has no model map.
// Nothing is invoiced — there is no account to bill — but each call is priced
// from the shared price table (movement-engine's lib/models/prices.json) and
// charged to its run, so the run's cost cap sees what its model calls spent.

import type { WirePluginResultShape } from 'engine-contracts';
import type { Costed, EngineHost } from 'movement-engine/public/host';
import type { TransformInvocationResult } from 'movement-engine/public/model-calls';
import type { ChatCall } from 'movement-engine/public/models';
import type { ChatModelName } from 'movement-engine/public/models';

import { anthropicClient, type LlmUsage } from 'movement-engine/public/anthropic';
import { costMicrodollars } from 'movement-engine/public/models';
import { costSourceKey } from 'movement-engine/public/models';
import { reportRunCost } from 'movement-engine/public/models';
import { models } from 'movement-engine/public/models';
import { anthropicKeyedChatProvider, type AnthropicKey } from 'movement-engine/public/anthropic';
import { metered, refusingPastBudget } from 'movement-engine/public/models';
import {
  makeAnthropicExtractCallClient,
  makeAnthropicLlmClient,
} from 'movement-engine/public/models';
import { arbitrateWithoutJudge } from 'movement-engine/public/model-calls';
import { MODEL_CREDENTIAL, type Credential } from './secrets';

/** One call of a plugin a plugin external serves; undefined when none does. */
export type LocalPluginCall = (input: {
  plugin: string;
  config: Record<string, unknown>;
  extractedContext: Record<string, unknown>;
}) => Promise<WirePluginResultShape> | undefined;

export function modelCalls(credentials: Map<string, Credential>, plugins: LocalPluginCall): EngineHost['llm'] {
  const chat = anthropicClient({
    // Read at the call, not here: a run that never reaches a model needs no key.
    chatCallFor: (name) => anthropicCall(name, anthropicKey(credentials)),
    recordUsage: chargeToRun,
    logFields: () => ({}),
  });
  const llm = makeAnthropicLlmClient({ chat: chat.anthropicChatDetailed });
  const extractCall = makeAnthropicExtractCallClient({ chat: chat.anthropicChatDetailed });

  return {
    client: { call: (request) => metered(request, (input) => llm.call(input)) },
    extractCall: { call: (request) => metered(request, (input) => extractCall.call(input)) },
    transforms: {
      invoke: (request) =>
        metered(request, async ({ plugin, config, extractedContext }) => {
          const answered = plugins({ plugin, config, extractedContext });
          if (answered === undefined) {
            throw new Error(`plugin "${plugin}" cannot run: no plugin external in this project serves it`);
          }
          return pluginInvocation(plugin, await answered);
        }),
    },
    arbitrateEntities: (request) => refusingPastBudget(async () => arbitrate(request)),
  };
}

/** A plugin external's answer, as the engine takes a plugin's: what it
 *  added, and what its own work cost under its name, charged to the run. */
function pluginInvocation(plugin: string, answer: WirePluginResultShape): Costed<TransformInvocationResult> {
  const out: Costed<TransformInvocationResult> = {};
  if (answer.text !== undefined && answer.text !== '') out.text = answer.text;
  if (answer.data !== undefined && Object.keys(answer.data).length > 0) out.data = answer.data;
  if (answer.records !== undefined && answer.records.length > 0) out.records = answer.records;
  if (answer.outcome !== undefined) out.outcome = answer.outcome;
  if (answer.costMicrodollars !== undefined) {
    out.cost = [{ source: costSourceKey({ kind: 'plugin', name: plugin }), microdollars: answer.costMicrodollars }];
  }
  return out;
}

/** Keys already told about. An unpriced model's usage would read as free; say
 *  so once per key per process. */
const unpricedKeysWarned = new Set<string>();

// Charged before the first await: the call is not awaited, and the run's next
// priced call must already see what this one cost.
async function chargeToRun(usage: LlmUsage): Promise<void> {
  const { resolved } = usage;
  const key = `${resolved.provider}/${resolved.wireModel}`;
  const cost = costMicrodollars(key, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
  });
  if (cost === undefined) {
    if (!unpricedKeysWarned.has(key)) {
      unpricedKeysWarned.add(key);
      process.stderr.write(`lf: no price for "${key}": its usage counts as free. Add it to movement-engine/lib/models/prices.json.\n`);
    }
    return;
  }
  reportRunCost({ source: { kind: 'model', name: resolved.wireModel }, microdollars: cost });
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
