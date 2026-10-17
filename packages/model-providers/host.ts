// What the package takes from whoever embeds it, in place of reading the
// process: the environment that carries keys and the model map, and the two
// things only a host can answer (where usage is recorded, how text is counted).

import type { Resolved } from 'movement-engine/public/models';

export interface UsageRecord {
  resolved: Resolved;
  callType: 'chat' | 'embedding' | 'image';
  label?: string;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number;
}

export interface ModelHost {
  env: NodeJS.ProcessEnv;
  /** Fire and forget by contract: a failed record never fails the call. */
  recordUsage(usage: UsageRecord): Promise<void>;
  countTokens(text: string): number;
}
