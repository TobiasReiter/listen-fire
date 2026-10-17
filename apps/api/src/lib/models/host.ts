// How the hosted product answers model-providers' questions: its process
// environment (with the dev-loop key defaults), its usage ledger, and its
// tokenizer. The vendor code itself lives in packages/model-providers, which
// reads none of these on its own.

import type { ModelHost } from 'model-providers/host';

import { countTokens } from '../chunking';
import { recordLlmUsage } from '../llm_usage';

/**
 * The vendor keys, with the answer an unset one used to get from `getEnvVar`:
 * outside production a placeholder, in production nothing, so the provider
 * refuses at first use (never at import) and names the key. The process
 * environment still answers when a threaded one lacks the key.
 */
export function hostedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const devDefault = process.env.NODE_ENV === 'production' ? undefined : 'test';
  return {
    ...env,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? devDefault,
    OPENAI_API_KEY:
      env.OPENAI_API_KEY ?? env.OPENAI_API_KEY_FALLBACK_OR_DEV ?? process.env.OPENAI_API_KEY ?? devDefault,
  };
}

export function hostedModelHost(env: NodeJS.ProcessEnv): ModelHost {
  return { env: hostedEnv(env), recordUsage: recordLlmUsage, countTokens };
}
