// The identity judge as the hosted platform runs it: the decision rules and
// prompts are the movement-engine package's (`services/identity_judge`); this
// file injects the two network calls — Anthropic through the shared prompt
// executor, and Jev — and re-exports the judge under the names the rest of
// apps/api imports.

import { createIdentityJudge, type JevJudgeClient } from 'movement-engine/public/models';

import { execute } from '../../../lib/prompts/execute';
import { promptDef } from '../../../lib/prompts/definition';
import {
  askJev,
  assertJevConfigured,
  jevEntityResolutionEnabled,
  JevConfigurationError,
} from '../../../lib/jev/client';

export {
  GENERATIVE_MATCH_THRESHOLD,
  JEV_EVIDENCE_THRESHOLD,
  JEV_SAME_THRESHOLD,
  JUDGE_MODEL,
  type ArbitrationAnswer,
  type EntityArbitration,
} from 'movement-engine/public/models';

const jev: JevJudgeClient = {
  enabled: () => jevEntityResolutionEnabled(),
  assertConfigured: () => assertJevConfigured(),
  ask: (input, options) => askJev(input, options),
  isConfigurationError: (err) => err instanceof JevConfigurationError,
};

export const {
  judgeEntityMatch,
  judgeEntityMatchGenerativeRaw,
  judgeEntityMatchViaJev,
  judgeEntityMatchViaJevRaw,
  arbitrateEntityCandidates,
  meteredArbitration,
} = createIdentityJudge({
  jev,
  // The package hands over finished prompt text. `execute` fills `{{{slot}}}`s
  // in a definition's messages, so the text rides in as slot VALUES: values
  // are never scanned for slots again, where text placed in the messages
  // themselves would lose any `{{{…}}}` a record happens to contain.
  askModel: ({ label, model, system, user, validator }) =>
    execute(
      label,
      promptDef({
        description: 'Match an asserted record against candidate records from a target system',
        arguments: ['system', 'user'] as const,
        messages: [
          { role: 'system' as const, content: '{{{system}}}' },
          { role: 'user' as const, content: '{{{user}}}' },
        ],
        model,
        validator,
      }),
      { system, user },
    ),
});
