// Model calls: the provider key comes from the secrets file, under the
// reserved credential name `anthropic` (field `api_key`).
//
// STUB: the model client the hosted product uses (apps/api lib/models,
// lib/anthropic, the batched-extraction call) has not moved out of apps/api,
// so a run that reaches a model call fails here, naming whether the key was
// found. Moving that client into a package is what makes this real.

import type { EngineHost } from 'movement-engine/services/movement_engine/host';
import { MODEL_CREDENTIAL, type Credential } from './secrets';

export function modelCalls(credentials: Map<string, Credential>): EngineHost['llm'] {
  const refuse = async (): Promise<never> => {
    const key = credentials.get(MODEL_CREDENTIAL)?.fields.api_key;
    throw new Error(
      key === undefined
        ? `a model call needs a provider key: add \`${MODEL_CREDENTIAL}: { external: anthropic, api_key: … }\` to the secrets file`
        : 'model calls are not wired in lf yet: the provider key is found, the model client still lives in apps/api',
    );
  };
  return {
    client: { call: refuse },
    extractCall: { call: refuse },
    transforms: { invoke: refuse },
    arbitrateEntities: refuse,
  };
}
