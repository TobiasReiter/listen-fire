// Jev (Typesafe AI) — a non-generative judge. You send it a `state` and a
// set of typed questions and it returns a probability distribution per
// question, rather than free text to parse. Its own file, mirroring the
// model provider files' placement, because it is a distinct vendor
// with its own auth and wire shape — everything here imports the
// environment and nothing else project-specific besides billing.
//
// Optional end to end: a deployment that never sets `JEV_ENTITY_RESOLUTION`
// never reads `JEV_KEY` and never calls this module for real.

import { backOff } from 'exponential-backoff';
import { z } from 'zod';

import { SECOND } from '../../constants';
import { recordLlmUsage } from '../llm_usage';
import { assertRunBudget } from 'movement-engine/public/models';

const JEV_API_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_REQUEST_MODEL = 'jev-latest';

const RETRY_ATTEMPTS = 3;
const RETRY_START_DELAY = 1 * SECOND;

/**
 * `JEV_ENTITY_RESOLUTION=true` with no `JEV_KEY` is a deployment that
 * believes it has a second judge and does not. A distinct class so the
 * entity judge's decline-on-throw posture (any OTHER throw reads as a
 * considered decline and creates a new record) can recognise this ONE
 * throw as a misconfiguration instead — creating a duplicate over a typo'd
 * env var would be a far worse failure than a loud crash.
 */
export class JevConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JevConfigurationError';
  }
}

/** A Jev call that reached the API (or tried to) and failed for a reason
 *  that is NOT a missing key — a caller with a fallback (the entity judge,
 *  onto the generative model) catches this; `JevConfigurationError` it must
 *  not, so the two are deliberately different classes. */
export class JevRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'JevRequestError';
  }
}

export function jevEntityResolutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JEV_ENTITY_RESOLUTION === 'true';
}

/**
 * Refuse a half-configured Jev route the first time anything asks whether
 * it is on — the same "loud, not silent" posture as
 * `assertModelMapConfigured` (`lib/models/map.ts`). Called again at boot
 * (`server.ts`) so a misconfigured deployment fails before its first write,
 * not at it.
 */
export function assertJevConfigured(env: NodeJS.ProcessEnv = process.env): void {
  if (jevEntityResolutionEnabled(env) && !env.JEV_KEY) {
    throw new JevConfigurationError(
      'JEV_ENTITY_RESOLUTION is true, so entity matching judges through Jev — but JEV_KEY is not ' +
        'set. Set JEV_KEY, or unset JEV_ENTITY_RESOLUTION.',
    );
  }
}

const jevChoiceQuestionSchema = z.object({
  type: z.literal('choice'),
  instructions: z.string(),
  // A criterion's value describes the option to the model; `null` means the
  // option key alone (e.g. "c0") is self-explanatory from the state.
  criteria: z.record(z.string(), z.string().nullable()),
});

export type JevChoiceQuestion = z.infer<typeof jevChoiceQuestionSchema>;

// "How true is this statement" — a single probability, no option list. Used
// for the entity-match judge's per-candidate same/evidence questions instead
// of one `choice` question, so the option-count ceiling below never applies.
const jevNoulQuestionSchema = z.object({
  type: z.literal('noul'),
  instructions: z.string(),
});

export type JevNoulQuestion = z.infer<typeof jevNoulQuestionSchema>;

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;

const jevChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
});

export type JevChoiceAnswer = z.infer<typeof jevChoiceAnswerSchema>;

const jevNoulAnswerSchema = z.object({
  type: z.literal('noul'),
  noul: z.number(),
});

export type JevNoulAnswer = z.infer<typeof jevNoulAnswerSchema>;

const jevAnswerSchema = z.discriminatedUnion('type', [jevChoiceAnswerSchema, jevNoulAnswerSchema]);

export type JevAnswer = z.infer<typeof jevAnswerSchema>;

const jevUsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
});

const jevResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), jevAnswerSchema),
  usage: jevUsageSchema.optional(),
});

function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || status === 529;
}

/**
 * Ask Jev one or more typed questions (`choice` or `noul`) over a `state`.
 * Bounded retry with exponential backoff on 429/529 (rate limit / overloaded)
 * — anything else (a 400 over the token ceiling, a network error) fails on
 * the first try, since retrying a request Jev has already rejected would
 * only spend the caller's own retry budget for nothing (the entity judge's
 * fallback to the generative model wants to happen promptly, not after
 * three doomed retries).
 *
 * Bills through the same `llm_usage` ledger every other model call does —
 * `provider: 'jev'` — so a run's total cost includes what its judging
 * spent, not just its generation.
 */
export async function askJev(
  input: { state: unknown; questions: Record<string, JevQuestion> },
  options: { env?: NodeJS.ProcessEnv; label?: string } = {},
): Promise<Record<string, JevAnswer>> {
  const env = options.env ?? process.env;
  const apiKey = env.JEV_KEY;
  if (!apiKey) {
    throw new JevConfigurationError('JEV_KEY is not set — Jev cannot be called.');
  }

  assertRunBudget();

  const body = JSON.stringify({
    model: JEV_REQUEST_MODEL,
    state: input.state,
    questions: input.questions,
  });

  const res = await backOff(
    async () => {
      const response = await fetch(JEV_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new JevRequestError(`Jev request failed (${response.status}): ${text}`, response.status);
      }
      return response;
    },
    {
      numOfAttempts: RETRY_ATTEMPTS,
      startingDelay: RETRY_START_DELAY,
      jitter: 'full',
      retry: (err) => err instanceof JevRequestError && isRetryableStatus(err.status),
    },
  );

  const raw: unknown = await res.json();
  const parsed = jevResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new JevRequestError(`Jev response failed validation: ${parsed.error.message}`);
  }

  await recordLlmUsage({
    resolved: { provider: 'jev', wireModel: parsed.data.model },
    callType: 'structured',
    label: options.label,
    inputTokens: parsed.data.usage?.input_tokens ?? 0,
    outputTokens: parsed.data.usage?.output_tokens ?? 0,
  });

  return parsed.data.answers;
}
