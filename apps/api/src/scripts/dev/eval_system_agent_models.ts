/**
 * Which model should the system conversation agent run on?
 *
 * The agent behind `/v1/system` is the one agent mounted in every deployment,
 * and it is the last place in the product still reaching an Opus 4 model. This
 * puts the candidates through the REAL agent — the real system prompt, the real
 * tool surface, the real grounding check and its one corrective turn — over a
 * fixed set of single turns against the seeded dev team, and scores them on the
 * two things that decide the question: did it call the right tools, and is the
 * answer true of the data.
 *
 * What it does and does not touch:
 *
 * - It calls `runUnifiedAgent` directly, not the conversation orchestrator. The
 *   orchestrator adds history persistence and compaction, which would make one
 *   arm's turn depend on an earlier arm's.
 * - It runs with the WRITE scopes off. Every mutating tool the agent has —
 *   entity and model editing, and saving an automation live — is out of reach,
 *   so no arm can leave the seeded team different from how it found it, and the
 *   arms all see the same data.
 * - The one thing overridden inside the agent is which model answers. That is a
 *   named option on the agent (`modelUnderTest`); no product caller sets it, and
 *   an arm that names nothing is byte for byte today's request.
 *
 * How the numbers are read. `runUnifiedAgent` returns the tool trace but no
 * token counts, so the per-turn line the Anthropic wrapper already logs is
 * tapped read-only — the same tactic the extraction bake-off uses, and for the
 * same reason: a callback seam through a shared production file is not worth
 * carrying for a measurement script. The grounding check's own warning is
 * tapped too, because a corrective turn having fired is otherwise invisible
 * from outside the agent.
 *
 * Usage (real API spend):
 *
 *   pnpm dev:eval-system-agent --dry-run
 *   pnpm dev:eval-system-agent --arms base,sonnet5 --prompts companies,catalog
 *   pnpm dev:eval-system-agent --out /tmp/agentbake
 *
 * Needs the dev stack up (`pnpm dev:loop:agent`) and seeded (`pnpm dev:seed`).
 * The expected answers below are this team's real state, so re-read them
 * against the database before trusting a rerun.
 */
import './_profile_loader';

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { logger } from 'movement-engine/services/logger';
import { LlmUsageContext } from '../../lib/llm_usage';
import {
  runUnifiedAgent,
  type AgentScope,
  type UnifiedAgentCall,
} from '../../lib/knowledge/unified_agent';
import { buildAgentContext, ensureDevLoopTeam } from './_lib';

// ── The arms ───────────────────────────────────────────────────────────────

interface ArmSpec {
  label: string;
  /** What the agent is asked to use. `undefined` is the baseline and means the
   *  agent's own row — not a copy of it, so the baseline cannot drift. */
  call: UnifiedAgentCall | undefined;
  /** For the cost column only; the baseline's own model, spelled out here
   *  because the agent does not hand it back. */
  modelId: string;
}

/**
 * The most room a turn of this agent can be given, and the reason it is not a
 * round number.
 *
 * The agent's tool loop does not stream, and the Anthropic client refuses a
 * non-streaming request whose output ceiling implies more than ten minutes of
 * generation — the rule is `3600 × ceiling / 128000 > 600`, so anything above
 * 21,333 tokens is rejected before it leaves the process. A 32k ceiling, the
 * obvious "room to think" number, therefore fails every call outright. Making
 * more room than this at this site is a change to the tool loop, not a change
 * to a number.
 */
const MAX_NONSTREAMING_TOKENS = 21000;

const ARMS: Record<string, ArmSpec> = {
  /** Exactly today: opus-4-8, 16k of room, and nothing said about thinking —
   *  which on this model means it does none. */
  base: { label: 'today (opus-4-8 / no depth named / 16k)', call: undefined, modelId: 'claude-opus-4-8' },
  /** Opus 5 at a depth that is NAMED. Left silent this model thinks by default
   *  and would spend the whole ceiling on it before writing a word. */
  opus5: {
    label: `opus-5 / medium / ${MAX_NONSTREAMING_TOKENS}`,
    call: { model: 'claude-opus-5', effort: 'medium', maxOutputTokens: MAX_NONSTREAMING_TOKENS },
    modelId: 'claude-opus-5',
  },
  /** The proposal: the mid-tier model, same depth and same room, so the only
   *  difference from the arm above is which model answers. */
  sonnet5: {
    label: `sonnet-5 / medium / ${MAX_NONSTREAMING_TOKENS}`,
    call: { model: 'claude-sonnet-5', effort: 'medium', maxOutputTokens: MAX_NONSTREAMING_TOKENS },
    modelId: 'claude-sonnet-5',
  },
  /** The same model asked to think harder — the fallback if `medium` loses
   *  something, since it is still cheaper per token than either Opus. */
  sonnet5High: {
    label: `sonnet-5 / high / ${MAX_NONSTREAMING_TOKENS}`,
    call: { model: 'claude-sonnet-5', effort: 'high', maxOutputTokens: MAX_NONSTREAMING_TOKENS },
    modelId: 'claude-sonnet-5',
  },
};

const DEFAULT_ARMS = ['base', 'opus5', 'sonnet5', 'sonnet5High'];

/** Dollars per million tokens, from `lib/llm_usage.ts`'s `MODEL_PRICING`. The
 *  grounding judge is a fourth model every arm pays for identically. */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

// ── The scopes ─────────────────────────────────────────────────────────────

/**
 * Everything the agent can READ, and nothing it can change.
 *
 * Named by what is left out rather than by listing what is in: the two omitted
 * scopes are the only ones carrying a mutating tool, and leaving them out is
 * what makes a rerun mean the same thing as the run before it.
 */
const READ_ONLY_SCOPES: AgentScope[] = [
  'library.read',
  'knowledge.read',
  'movements.read',
  'catalog.read',
  'runs.read',
  'files.read',
];

// ── The prompts ────────────────────────────────────────────────────────────

interface Prompt {
  id: string;
  /** What the turn asks of the agent, in the words a user would use. */
  message: string;
  /** What the answer must be true of, checked by hand against the seed. */
  truth: string;
  /** A tool whose absence from the trace means the answer was not looked up.
   *  Several names means any one of them counts. */
  wants: string[];
}

/**
 * Six turns, each chosen because its right answer can be read straight out of
 * the dev team's own database rather than being a matter of taste.
 *
 * The truths below are one dev team's state, read out of its database by hand
 * rather than produced by a fresh seed — a team worked in long enough to carry
 * 94 saved automations and 15 connected credentials. They are calibration, not
 * a fixture: re-read them against YOUR dev team before trusting a score.
 *
 * One thing the prompts deliberately work AROUND. The knowledge graph holds 8
 * companies at the database level, but the agent's own graph query returns
 * nothing for them — reproducibly, and identically through `pnpm dev:chat`, so
 * it is a property of the product and not of this harness. Every arm therefore
 * sees the same empty graph, which keeps the comparison fair but would make a
 * "name our companies" question measure nothing. The graph questions here are
 * the ones whose right answer IS that there is nothing on file.
 */
const PROMPTS: Prompt[] = [
  {
    id: 'catalog',
    message: 'What external systems are we connected to?',
    truth:
      'fifteen credentials: Slack, Affinity, six separate Attio connections, Airtable, Listen-Fire Valuations, Telegram, the Acme CRM remote adapter, the built-in knowledge graph, Evertrace and Dealroom',
    wants: ['listCatalog', 'describeInstance'],
  },
  {
    id: 'automations',
    message: 'How many automations do we have saved?',
    truth: '94 saved movements on this team',
    wants: ['listMovements'],
  },
  {
    id: 'two_tools',
    message:
      'Do we have any automation that could post into Slack, and is Slack even one of the systems we are connected to?',
    truth:
      'Slack IS connected (a credential named Dev Loop Slack), and the team has 94 saved movements to look through. Answering both halves needs two different tools',
    wants: ['listMovements', 'listCatalog'],
  },
  {
    id: 'ontology',
    message:
      'What kinds of records can this workspace store, and what fields do we keep on a company?',
    truth:
      'eight record types — Deal, Dealflow Message, Funding Round, Investor Update, Opportunity, Organisation, Person, Round Participation — and a company (Organisation) keeps Name, Website, Description, Headquarters and Sector',
    wants: ['getOntology', 'queryGraph'],
  },
  {
    id: 'absent_data',
    message: 'How much revenue did Kestrel Logistics report in its last investor update?',
    truth:
      'nothing comes back for this — the only true answer is that we do not have an investor update for them, and an answer that names a revenue figure is invented',
    wants: ['queryGraph', 'searchFactStore', 'getNodeDetail'],
  },
  {
    id: 'change_request',
    message: 'Halcyon Bio has moved its headquarters to Basel. Please update our record for them.',
    truth:
      'the agent has no write tool in this run — it must look first, then say plainly that nothing was changed, and never report the update as done',
    wants: ['queryGraph', 'getNodeDetail', 'getOntology'],
  },
];

// ── The tap ────────────────────────────────────────────────────────────────

interface TurnRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  llmMs: number;
  toolNames: string[];
  stopReason: string | null;
  truncated: string | null;
  /** The visible text emitted alongside a turn's tool calls; a turn that
   *  produced only reasoning shows up here as nothing. */
  hadText: boolean;
}

/**
 * Reads the two lines the agent's own machinery already writes: the wrapper's
 * per-turn record, and the grounding check's warning when it caught a claim the
 * agent had not earned. Both go through `logger`, so one pass-through wrapper
 * sees both, and everything still logs exactly as before.
 */
class AgentTap {
  readonly turns: TurnRecord[] = [];
  /** Non-null once the grounding check has rejected a reply this run. */
  groundingIssue: string | null = null;
  private restore: (() => void) | undefined;

  attach(): void {
    const info = logger.info.bind(logger);
    const warn = logger.warn.bind(logger);
    const fieldsOf = (meta: unknown): Record<string, unknown> | undefined =>
      meta !== null && typeof meta === 'object' ? (meta as Record<string, unknown>) : undefined;

    /* eslint-disable @typescript-eslint/no-explicit-any */
    (logger as any).info = (message: unknown, meta: unknown, ...rest: unknown[]): unknown => {
      const fields = fieldsOf(meta);
      if (typeof message === 'string' && message.includes('[anthropic] turn') && fields) {
        this.turns.push({
          model: String(fields.model ?? ''),
          inputTokens: Number(fields.inputTokens ?? 0),
          outputTokens: Number(fields.outputTokens ?? 0),
          cacheReadTokens: Number(fields.cacheReadTokens ?? 0),
          cacheCreationTokens: Number(fields.cacheCreationTokens ?? 0),
          llmMs: Number(fields.llmMs ?? 0),
          toolNames: Array.isArray(fields.toolNames) ? fields.toolNames.map(String) : [],
          stopReason: fields.stop_reason == null ? null : String(fields.stop_reason),
          truncated: fields.truncated == null ? null : String(fields.truncated),
          hadText: typeof fields.thinkingText === 'string' && fields.thinkingText.length > 0,
        });
      }
      return (info as any)(message, meta, ...rest);
    };
    (logger as any).warn = (message: unknown, meta: unknown, ...rest: unknown[]): unknown => {
      const fields = fieldsOf(meta);
      if (
        typeof message === 'string' &&
        message.includes('grounding check caught ungrounded claim') &&
        fields
      ) {
        this.groundingIssue = String(fields.issue ?? 'unnamed');
      }
      return (warn as any)(message, meta, ...rest);
    };
    this.restore = () => {
      (logger as any).info = info;
      (logger as any).warn = warn;
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  detach(): void {
    this.restore?.();
  }

  reset(): void {
    this.turns.length = 0;
    this.groundingIssue = null;
  }
}

// ── The run ────────────────────────────────────────────────────────────────

interface Cell {
  prompt: string;
  arm: string;
  ok: boolean;
  error?: string;
  /** Every tool the agent called, in the order it called them. */
  tools: string[];
  /** What it asked each of them for — the only way to tell a tool that was
   *  called from a tool that was asked the right question. */
  toolArgs: Array<{ tool: string; args: unknown }>;
  /** Whether at least one of the prompt's expected tools was reached. */
  grounded: boolean;
  /** Whether the grounding check rejected the first reply and the agent got
   *  its one corrective turn. */
  corrected: boolean;
  groundingIssue: string | null;
  turns: number;
  /** Turns that emitted neither text nor a tool call — the shape a reply takes
   *  when the thinking has eaten the whole ceiling. */
  silentTurns: number;
  truncations: string[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** The grounding judge's tokens, which every arm pays identically. */
  judgeTokens: number;
  cost: number;
  latencyMs: number;
  answer: string;
}

function costOf(arm: ArmSpec, tap: AgentTap): number {
  let total = 0;
  for (const turn of tap.turns) {
    const price = PRICING[turn.model] ?? PRICING[arm.modelId];
    total +=
      (turn.inputTokens * price.input +
        turn.cacheReadTokens * price.input * CACHE_READ_MULTIPLIER +
        turn.cacheCreationTokens * price.input * CACHE_WRITE_MULTIPLIER +
        turn.outputTokens * price.output) /
      1_000_000;
  }
  return total;
}

async function runCell(
  teamId: string,
  prompt: Prompt,
  armId: string,
  arm: ArmSpec,
  tap: AgentTap,
): Promise<Cell> {
  tap.reset();
  const started = Date.now();
  let answer = '';
  let tools: string[] = [];
  let toolArgs: Array<{ tool: string; args: unknown }> = [];
  let error: string | undefined;

  try {
    const usage = new LlmUsageContext({ teamId });
    const result = await usage.runAsync(() =>
      runUnifiedAgent(prompt.message, {
        teamId,
        scopes: READ_ONLY_SCOPES,
        ...(arm.call ? { modelUnderTest: arm.call } : {}),
      }),
    );
    answer = result.text;
    tools = result.trace.map((entry) => entry.tool);
    toolArgs = result.trace.map((entry) => ({ tool: entry.tool, args: entry.args }));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // The judge is Haiku on every arm, so its spend is separated out rather than
  // folded into the arm's — otherwise a cheap arm looks dearer than it is.
  const agentTurns = tap.turns.filter((turn) => !turn.model.startsWith('claude-haiku'));
  const judge = tap.turns.filter((turn) => turn.model.startsWith('claude-haiku'));

  return {
    prompt: prompt.id,
    arm: armId,
    ok: error === undefined,
    ...(error !== undefined ? { error } : {}),
    tools,
    toolArgs,
    grounded: tools.some((tool) => prompt.wants.includes(tool)),
    corrected: tap.groundingIssue !== null,
    groundingIssue: tap.groundingIssue,
    turns: agentTurns.length,
    silentTurns: agentTurns.filter((turn) => !turn.hadText && turn.toolNames.length === 0).length,
    truncations: agentTurns.flatMap((turn) => (turn.truncated ? [turn.truncated] : [])),
    inputTokens: agentTurns.reduce((n, t) => n + t.inputTokens, 0),
    outputTokens: agentTurns.reduce((n, t) => n + t.outputTokens, 0),
    cacheReadTokens: agentTurns.reduce((n, t) => n + t.cacheReadTokens, 0),
    cacheCreationTokens: agentTurns.reduce((n, t) => n + t.cacheCreationTokens, 0),
    judgeTokens: judge.reduce((n, t) => n + t.inputTokens + t.outputTokens, 0),
    cost: costOf(arm, tap),
    latencyMs: Date.now() - started,
    answer,
  };
}

// ── Reporting ──────────────────────────────────────────────────────────────

function renderReport(cells: Cell[], armIds: string[]): string {
  const lines: string[] = [];

  lines.push('### Prompt × arm');
  lines.push('');
  lines.push(
    '| prompt | arm | tools called, in order | grounded | corrective turn | turns | silent turns | truncated | in tok | cached tok | out tok | s | cost |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const prompt of PROMPTS) {
    for (const armId of armIds) {
      const cell = cells.find((c) => c.prompt === prompt.id && c.arm === armId);
      if (!cell) continue;
      lines.push(
        `| ${cell.prompt} | ${cell.arm} | ${cell.tools.join(' → ') || '(none)'} | ${
          cell.grounded ? 'yes' : 'NO'
        } | ${cell.corrected ? 'FIRED' : 'no'} | ${cell.turns} | ${cell.silentTurns} | ${
          cell.truncations.join(',') || '—'
        } | ${cell.inputTokens} | ${cell.cacheReadTokens + cell.cacheCreationTokens} | ${
          cell.outputTokens
        } | ${(cell.latencyMs / 1000).toFixed(1)} | $${cell.cost.toFixed(4)} |${
          cell.ok ? '' : ` FAILED: ${cell.error}`
        }`,
      );
    }
  }

  lines.push('');
  lines.push('### Per arm');
  lines.push('');
  lines.push(
    '| arm | settings | grounded | corrective turns | silent turns | failures | turns | in tok | cached tok | out tok | judge tok | median s | cost |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const armId of armIds) {
    const armCells = cells.filter((c) => c.arm === armId);
    if (armCells.length === 0) continue;
    const sum = (pick: (c: Cell) => number): number => armCells.reduce((n, c) => n + pick(c), 0);
    const latencies = armCells.map((c) => c.latencyMs).sort((a, b) => a - b);
    lines.push(
      `| ${armId} | ${ARMS[armId].label} | ${armCells.filter((c) => c.grounded).length}/${
        armCells.length
      } | ${armCells.filter((c) => c.corrected).length} | ${sum((c) => c.silentTurns)} | ${
        armCells.filter((c) => !c.ok).length
      } | ${sum((c) => c.turns)} | ${sum((c) => c.inputTokens)} | ${sum(
        (c) => c.cacheReadTokens + c.cacheCreationTokens,
      )} | ${sum((c) => c.outputTokens)} | ${sum((c) => c.judgeTokens)} | ${(
        latencies[Math.floor(latencies.length / 2)] / 1000
      ).toFixed(1)} | $${sum((c) => c.cost).toFixed(4)} |`,
    );
  }

  lines.push('');
  lines.push('### Answers');
  lines.push('');
  for (const prompt of PROMPTS) {
    if (!cells.some((c) => c.prompt === prompt.id)) continue;
    lines.push(`#### ${prompt.id} — "${prompt.message}"`);
    lines.push('');
    lines.push(`Ground truth: ${prompt.truth}`);
    lines.push('');
    for (const armId of armIds) {
      const cell = cells.find((c) => c.prompt === prompt.id && c.arm === armId);
      if (!cell) continue;
      lines.push(`**${armId}** — ${cell.answer.replace(/\n+/g, ' ').slice(0, 900)}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ── Entry ──────────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

async function main(): Promise<void> {
  const armIds = flag('arms')?.split(',') ?? DEFAULT_ARMS;
  for (const id of armIds) if (!(id in ARMS)) throw new Error(`unknown arm '${id}'`);
  const only = flag('prompts')?.split(',');
  const prompts = only ? PROMPTS.filter((p) => only.includes(p.id)) : PROMPTS;
  const outDir = flag('out') ?? path.join(process.cwd(), '.agent-bakeoff');
  const budget = Number(flag('budget') ?? 10);

  if (prompts.length === 0) throw new Error('no prompts selected');

  console.log(
    `system-agent bake-off: ${prompts.length} prompts × ${armIds.length} arms` +
      `\narms: ${armIds.map((id) => `${id} = ${ARMS[id].label}`).join(' | ')}\n`,
  );

  if (process.argv.includes('--dry-run')) {
    for (const prompt of prompts) {
      console.log(`── ${prompt.id}\n   "${prompt.message}"\n   truth: ${prompt.truth}`);
    }
    return;
  }

  const seed = await ensureDevLoopTeam();
  const ctx = buildAgentContext(seed.teamId, seed.userId);
  const tap = new AgentTap();
  tap.attach();

  const cells: Cell[] = [];
  let spent = 0;
  await ctx.runAsync(async () => {
    outer: for (const armId of armIds) {
      for (const prompt of prompts) {
        if (spent > budget) {
          console.error(`\nABORT: spend passed the $${budget} budget at $${spent.toFixed(2)}`);
          break outer;
        }
        const cell = await runCell(seed.teamId, prompt, armId, ARMS[armId], tap);
        cells.push(cell);
        spent += cell.cost;
        console.log(
          `${cell.prompt.padEnd(16)} ${cell.arm.padEnd(12)} ` +
            `${cell.turns} turns  tools [${cell.tools.join(', ')}]  ` +
            `${cell.corrected ? 'CORRECTED  ' : ''}${(cell.latencyMs / 1000).toFixed(1)}s  ` +
            `spent $${spent.toFixed(3)}  ${cell.ok ? '' : `FAILED: ${cell.error}`}`,
        );
      }
    }
  });

  tap.detach();

  const report = renderReport(cells, armIds);
  console.log(`\n${report}\n\nTOTAL SPEND: $${spent.toFixed(4)}`);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'cells.json'), JSON.stringify({ cells, spent }, null, 2));
  writeFileSync(path.join(outDir, 'report.md'), `${report}\n\nTotal spend: $${spent.toFixed(4)}\n`);
  console.log(`\nwrote ${outDir}/cells.json and ${outDir}/report.md`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
