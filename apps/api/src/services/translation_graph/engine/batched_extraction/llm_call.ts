// One model call, as the batched extraction and the movement engine make it:
// what is asked, of which model, and what comes back.

import type { Effort, TierModel } from '../../../movement_engine/ai_tiers';

/** Result of one LLM call. */
export interface LlmCallResult {
  /** Pre-parsed JSON body. The phases module validates against the
   *  synthetic schema. */
  parsedJson: unknown;
  /** The reply as the model wrote it, before parsing repaired anything —
   *  what an observer needs when the parsed body does not explain why the
   *  schema rejected it. Optional: a client that has already thrown the
   *  text away (and every test stub) simply omits it, and observers fall
   *  back to the parsed body. Never persisted except on an anomaly. */
  rawText?: string;
  /** Present when the client got its answer only by asking less deeply than the
   *  caller said: the first attempt spent its whole output ceiling thinking and
   *  wrote nothing. The answer in hand is the cheaper one, and an observer has
   *  to be able to see that rather than infer it from a thin reply. */
  effortSteppedDown?: { from: string; to: string };
  /**
   * Continuation turns the client spent: the answer ran past the model's
   * output ceiling, and the partial text was fed back with "continue where you
   * left off" until it finished. The stitched answer PARSES, so nothing
   * downstream can tell it happened — and a continued answer routinely drops
   * the records at the end of what it read. Present only when one ran.
   */
  continuations?: number;
}

export interface LlmCallInput {
  system: string;
  userMessage: string;
  label: string;
  /** A built-in tier alias, or the logical model a deployment's tier
   *  assignment or an author's override named. */
  model: TierModel;
  /**
   * How much reasoning this call is worth. ABSENT means the model's own
   * default — which on the adaptive-thinking models is the deepest setting —
   * so a caller that wants a shallow, cheap answer has to say so. Both
   * extraction and `AI()` say whatever their tier maps to, and the tier
   * mapping is where the choice is made.
   */
  effort?: Effort;
  /**
   * Room for THIS answer, replacing the ceiling the client sizes from the
   * input. Absent is the norm: that ceiling is the runaway guard, and this is
   * what the most expensive tier spends instead of it.
   */
  maxTokens?: number;
}

/**
 * Injected LLM client. Production wires this to the existing
 * `anthropicChat` + `parseJson` pair; tests inject a deterministic
 * stub that returns canned JSON.
 */
export interface LlmClient {
  call(input: LlmCallInput): Promise<LlmCallResult>;
}
