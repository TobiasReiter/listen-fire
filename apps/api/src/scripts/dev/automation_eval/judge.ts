// The clarity judge: a model reads the final automation source and the
// conversation the user saw, and scores them against a written rubric. The
// rubric is the contract — the scores mean what the rubric says and nothing
// more — so it is spelled out here in full and travels with every report.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import type { TranscriptEntry } from './builder';
import type { Task } from './task';

import { addMessageUsage, type TokenUsage } from './usage';

/** Each criterion is scored 1 (poor) to 5 (exemplary). */
const RUBRIC = {
  source: {
    modernForms:
      'Uses the current forms: `function` declarations rather than `movement`; the extraction call form rather than the older `extract … from … through` keyword; one declaration reused rather than the same fields repeated. 5 = nothing retired or discouraged; 1 = built mostly from retired forms.',
    noDeadCode:
      'Every binding, branch, import and construction is used; nothing commented out, no leftovers from earlier drafts, no unused systems imported. 5 = none; 1 = a lot.',
    sensibleNames:
      "Automation, function and binding names say what they are in the user's business terms; readable display names. 5 = a newcomer understands each name; 1 = cryptic or misleading.",
  },
  conversation: {
    businessTerms:
      'Talks about outcomes in the user\'s terms (a company added to the CRM, a message posted to #dealflow) — not records, nodes, edges, writes, listeners, diagnostics, or tool names. 5 = never slips; 1 = mostly jargon.',
    rightQuestions:
      'Asks about the decisions that change what happens in the world (what triggers it, where things go, duplicates, who gets messaged) when the request leaves them open, and nothing it could decide itself or look up. 5 = exactly the needed questions; 1 = guessed at an open decision or interrogated the user about trivia.',
    concise:
      'Says what it will do and what it did briefly; no narration of every step. 5 = crisp; 1 = walls of text.',
  },
} as const;

type SourceCriterion = keyof typeof RUBRIC.source;
type ConversationCriterion = keyof typeof RUBRIC.conversation;
type Criterion = SourceCriterion | ConversationCriterion;

const CRITERIA: Criterion[] = [
  ...(Object.keys(RUBRIC.source) as SourceCriterion[]),
  ...(Object.keys(RUBRIC.conversation) as ConversationCriterion[]),
];

const Score = z.number().int().min(1).max(5);

const JudgeOutput = z.object({
  scores: z.object({
    modernForms: Score,
    noDeadCode: Score,
    sensibleNames: Score,
    businessTerms: Score,
    rightQuestions: Score,
    concise: Score,
  }),
  askedClarifyingQuestion: z
    .boolean()
    .describe('Did the assistant ask the user at least one question about what they wanted before building?'),
  notes: z.string().describe('Two or three sentences: the most important strengths and problems, with quotes.'),
});

type JudgeOutputShape = z.infer<typeof JudgeOutput>;

interface ClarityVerdict {
  scores: Record<Criterion, number>;
  /** Mean of the source criteria, of the conversation criteria, and of all six. */
  sourceMean: number;
  conversationMean: number;
  overall: number;
  askedClarifyingQuestion: boolean;
  notes: string;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Validate what the judge returned and derive the means. Accepts the parsed
 * object or its JSON text; throws with the reason when the shape is wrong, so a
 * malformed verdict is never averaged in as if it were a score.
 */
function parseJudgeVerdict(raw: unknown): ClarityVerdict {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const parsed: JudgeOutputShape = JudgeOutput.parse(value);
  const scores = parsed.scores;
  const sourceKeys = Object.keys(RUBRIC.source) as SourceCriterion[];
  const conversationKeys = Object.keys(RUBRIC.conversation) as ConversationCriterion[];
  return {
    scores,
    sourceMean: mean(sourceKeys.map((k) => scores[k])),
    conversationMean: mean(conversationKeys.map((k) => scores[k])),
    overall: mean(CRITERIA.map((k) => scores[k])),
    askedClarifyingQuestion: parsed.askedClarifyingQuestion,
    notes: parsed.notes,
  };
}

function renderRubric(): string {
  const section = (title: string, entries: Record<string, string>) =>
    `${title}\n${Object.entries(entries)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n')}`;
  return [
    section('Source (the automation program):', RUBRIC.source),
    section('Conversation (what the user saw):', RUBRIC.conversation),
  ].join('\n\n');
}

function judgePrompt(input: { task: Task; sources: string[]; transcript: TranscriptEntry[] }): string {
  const conversation = input.transcript
    .map((t) => `${t.role === 'builder' ? 'ASSISTANT' : 'USER'}: ${t.text}`)
    .join('\n\n');
  const sources = input.sources.length
    ? input.sources.map((s, i) => `--- automation ${i + 1} ---\n${s}`).join('\n\n')
    : '(nothing was saved)';
  return `You are grading how an AI assistant built an automation for a non-technical user in Listen-Fire. Score each criterion 1-5 exactly as the rubric defines it. Be strict and consistent; a 5 is rare.

${renderRubric()}

Overbuilding means unrequested extras: extra records, fields, recipients or messages. An approval step before any send to a third party (anyone outside the team) is expected safe behaviour, not overbuilding: never mark it down, even though the user did not ask for it.

The user's private intent (the assistant never saw this; use it to judge whether the right questions were asked):
"""
${input.task.hiddenSpec}
"""
${input.task.clarificationExpected ? `\nThe request was deliberately ambiguous. The decision a good assistant asks about: ${input.task.clarificationExpected}\n` : ''}
The conversation:
"""
${conversation}
"""

The saved automation source:
"""
${sources}
"""`;
}

async function judgeClarity(input: {
  client: Anthropic;
  model: string;
  task: Task;
  sources: string[];
  transcript: TranscriptEntry[];
  usage: TokenUsage;
}): Promise<ClarityVerdict> {
  const response = await input.client.messages.parse({
    model: input.model,
    max_tokens: 8_000,
    output_config: { effort: 'medium', format: zodOutputFormat(JudgeOutput) },
    messages: [{ role: 'user', content: judgePrompt(input) }],
  });
  addMessageUsage(input.usage, response.usage);
  if (!response.parsed_output) {
    throw new Error(`the judge did not answer in the expected shape (stop_reason ${response.stop_reason})`);
  }
  return parseJudgeVerdict(response.parsed_output);
}

export { CRITERIA, RUBRIC, judgeClarity, parseJudgeVerdict, renderRubric };
export type { ClarityVerdict, Criterion };
