// The models slot of an in-process host, from plain model clients: each call
// served under its request's budget and answering what it spent, as every
// host serves its priced calls (`metered`). A client that charges its price
// to the spend meter (the Anthropic clients do) counts against the run's cost
// cap; a fake that charges nothing spends nothing.

import type { Costed, EngineHost } from '../movement_engine/host';
import type { ExtractCallLlmInput, ExtractCallLlmResult } from '../movement_engine/extraction_call';
import type { LlmCallInput, LlmCallResult } from '../translation_graph/engine/batched_extraction/llm_call';
import { metered } from '../translation_graph/movement/metered';

/** A model client whose answer may say what it cost, beyond what it charged
 *  to the spend meter (a fake, a provider billed by the call). */
export interface ModelClient {
  call(input: LlmCallInput): Promise<Costed<LlmCallResult>>;
}

export interface ExtractCallModelClient {
  call(input: ExtractCallLlmInput): Promise<Costed<ExtractCallLlmResult>>;
}

export function pricedModels(clients: {
  /** The extraction keyword's and `AI()`'s client. */
  client?: ModelClient;
  /** The extraction call's (`extract(content, Shape)`). */
  extractCall?: ExtractCallModelClient;
}): Pick<Partial<EngineHost['llm']>, 'client' | 'extractCall'> {
  const { client, extractCall } = clients;
  return {
    ...(client !== undefined ? { client: { call: (request) => metered(request, (input) => client.call(input)) } } : {}),
    ...(extractCall !== undefined ? { extractCall: { call: (request) => metered(request, (input) => extractCall.call(input)) } } : {}),
  };
}
