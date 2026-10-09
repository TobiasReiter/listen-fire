// The querying handbook — chapters teaching how to ask, change, and
// trust data in the knowledge model through conversation. Mirrors the
// movement_handbook registry pattern: consumer-neutral chapter bodies
// behind a thin index/lookup surface.
//
// Seeded from the teaching content the data assistant works from
// (lib/knowledge/query_agent.ts), rewritten for the person asking.

import type { Handbook, ChapterId, Chapter, IntentEntry } from './types';

import { asking } from './chapters/asking';
import { changing } from './chapters/changing';
import { grounding } from './chapters/grounding';

const PREFACE = `## Working with your data in conversation

The knowledge model is queried and edited by talking to the assistant:
ask questions in plain language, state facts to record them, and trace
any answer back to its source. These chapters cover how to aim a
question well, how changes work (and which instruction does what), and
how provenance lets you judge what an answer is worth.`;

const CONVENTIONS = `## Conventions (always in play)

- Ask in your model's vocabulary — its entity type, field, and
  relationship names.
- Conversation carries context: follow-ups apply to the answers on the
  table.
- Stated facts are recorded; ambiguous instructions come back as
  options.
- Every fact traces to a source — when a number matters, read where it
  came from.`;

const INTENT_INDEX: IntentEntry[] = [
  { intent: 'Find things by their fields or status', chapter: 'asking' },
  { intent: 'Answer a question about how things connect', chapter: 'asking' },
  { intent: 'A complex question spanning several steps', chapter: 'asking' },
  { intent: 'Record a new fact or entry', chapter: 'changing' },
  { intent: 'Fix a wrong or stale field', chapter: 'changing' },
  { intent: 'Two entries are really the same thing', chapter: 'changing' },
  { intent: 'Change many entries at once', chapter: 'changing' },
  { intent: 'Check where a fact came from before acting on it', chapter: 'grounding' },
  { intent: 'The model lacks structure for something mentioned in documents', chapter: 'grounding' },
];

const CHAPTERS: Record<ChapterId, Chapter> = {
  asking,
  changing,
  grounding,
};

export const queryHandbook: Handbook = {
  preface: PREFACE,
  conventions: CONVENTIONS,
  intentIndex: INTENT_INDEX,
  chapters: CHAPTERS,
};
