// Movement-authoring A/B eval harness — Progressive Authoring Phase 1.
//
// Answers the gate question from plans/2026-06-16-progressive-authoring
// (Principle 8, "measure before scaling"): does authoring STRUCTURE-FIRST
// and GROUNDING every name in live `completionsAt` actually beat today's
// whole-buffer authoring on quality — without an unacceptable cost blow-up?
//
// It drives the real movement-authoring tool surface in-process (bypassing
// the dev:chat path, which mangles exact source) against the seeded
// dev-loop team, in two modes:
//
//   A — whole-buffer (today): the production "author the whole .mvt, then
//       validate" loop. `completionsAt` is NOT offered.
//   B — structure-first: write the skeleton (extraction tree nested, write
//       targets connected, bodies empty) → validate for the missing
//       required-field/edge CHECKLIST → fill each hole grounded in
//       `completionsAt` → re-validate → save. `completionsAt` IS offered.
//
// Every tool call is recorded, so scoring is deterministic: we re-validate
// the final source ourselves and bucket diagnostics into the failure
// families the plan cares about (invented names, missing required
// fields/edges, type errors, engine-unsupported). Cost is the per-run
// turn/token/wall-clock envelope from the tool loop.
//
// Usage (stack must be up + seeded — `pnpm dev:loop:agent` + `pnpm dev:seed`):
//   pnpm dev:mvt-eval                       # full suite, k=3, both modes
//   pnpm dev:mvt-eval --k 1 --briefs intake # cheap smoke of one brief
//   pnpm dev:mvt-eval --modes B --k 1 --briefs intake --pretty
//
// Cost: real Anthropic calls. A full run is dozens of multi-turn agent
// sessions — smoke with `--k 1 --briefs intake` first.

import './_profile_loader';

import { writeFileSync, mkdirSync } from 'node:fs';

import { anthropicToolLoop, type TurnEvent } from '../../lib/anthropic';
import { parseChatModelName } from 'movement-engine/lib/models/registry';

import type { ChatModelName } from 'movement-engine/lib/models/registry';

import {
  createMovementAgentTools,
  movementToolDefinitions,
} from '../../lib/knowledge/movement_agent';
import { buildMovementFrontMatter } from '../../lib/knowledge/movement_handbook';
import { validateMovementForTeam } from '../../services/translation_graph/movement/authoring';

import type { TeamId } from '../../generated/kysely/core/Team';

import { ensureDevLoopTeam, buildAgentContext } from './_lib';
import { LlmUsageContext } from '../../lib/llm_usage';
import { bucketDiagnostics, type ValidationLike } from './lib/diagnostic_families';

// ---------------------------------------------------------------------------
// Prompts — the eval pins its OWN A/B prompts so the measurement doesn't
// drift as the production prompt evolves. Both share the exact same intro +
// language reference (buildMovementFrontMatter) + style; only the "How you
// work" workflow differs, which is the single variable under test.
// ---------------------------------------------------------------------------

const SHARED_HEAD = `You are the movement author for Listen-Fire — a well-trained consultant who turns a user's plain-language brief into a working movement program.

## What a movement is

A movement is a small text program (a .mvt file) over one position — an inbound email, a record in another tool, a node in the knowledge graph — that says what to write where when that position arrives. The text is canonical: saving a clean file provisions its listeners and the automation is live.

${buildMovementFrontMatter()}`;

const SHARED_STYLE = `## Style

- You write the program; the user describes the outcome. Don't ask the user to write or edit code.
- Keep movements minimal: one movement per coherent reaction, \`unique by\` on entity-like targets, handles only where read.
- Use the user's naming when given ("name everything X" means the movement name, written record names where sensible, and listener key derive from X).
- **Two kinds of names.** The file's display name (saveMovement's \`name\`) is for humans — plain readable words ("Daily focus"), never underscores. Declared movement identifiers inside the program are code — snake_case (\`daily_focus\`), since the language requires identifiers. Always set both: readable display name on save, clean identifiers in the text.
- Be concise and concrete. No internal jargon (say "the program" or "the movement", not framework shorthand).`;

// Mode A — today's whole-buffer workflow (the production HEAD prompt, with
// no completionsAt step). This is the incumbent the experiment must beat.
const PROMPT_A = `${SHARED_HEAD}

## How you work

1. **Understand the brief.** Restate what should happen, in one or two sentences, before writing any code. Ask only when the brief is genuinely ambiguous about intent; reasonable defaults (channel names, record naming) you may choose and state.
2. **Ground yourself before authoring.** Call \`listCatalog\` to see the workspace's real adapters, credentials, and plugins — NEVER invent an adapter, credential, type, or field name. Call \`describeInstance\` for every (adapter, credential) pair you plan to construct, and read the writable roots' exact field names. Read the relevant handbook chapters (\`readAuthoringDoc\`) before your first authoring pass — at minimum \`anatomy\` and \`patterns\`, plus whichever chapters the index routes your situation to.
3. **Author, then ALWAYS validate before saving.** Call \`validateMovement\` on every draft. Diagnostics carry codes, line/col positions, and the offending source line — repair the program and re-validate until there are no error-severity diagnostics. Never call \`saveMovement\` on a source you have not just validated clean.
4. **Iterate on diagnostics, don't argue with them.** A MOV_ENGINE_UNSUPPORTED diagnostic means the construct is valid language but ahead of today's engine — restructure per the message's hint (the handbook's "What runs today" notes cover the substitutions).
5. **Save and report.** On a clean validation, \`saveMovement\`. Report back at the user's altitude: what the automation does, where events enter (quote the inbound address for email listeners), and the full final program in a code block so they can see exactly what will run.

${SHARED_STYLE}`;

// Mode B — structure-first + completions-grounded. Skeleton, then fill the
// holes the framework points at, every name chosen from completionsAt.
const PROMPT_B = `${SHARED_HEAD}

## How you work — structure first

You build the movement the way a careful human power-user does in the editor: shape first, then fill the holes the framework points at, grounding every name in what it actually offers.

1. **Understand the brief.** Restate what should happen, in one or two sentences, before writing any code. Ask only when the brief is genuinely ambiguous about intent; reasonable defaults you may choose and state.
2. **Ground yourself before authoring.** Call \`listCatalog\` for the workspace's real adapters, credentials, and plugins. Call \`describeInstance\` for every (adapter, credential) pair you plan to construct. Read the relevant handbook chapters (\`readAuthoringDoc\`) — at minimum \`anatomy\` and \`patterns\` — before your first authoring pass. NEVER invent an adapter, credential, type, or field name.
3. **Write the SKELETON first — structure before any field.** Emit the data flow with empty bodies: imports + instance constructions, the extraction tree NESTED (children inside their parent node), the write targets CONNECTED (use the linked / tuple forms so related records are joined, not written flat), and the \`listen\` statement. Leave every body empty. This forces you to get cardinality, nesting, and connections right up front — the things that are painful to fix later.
4. **Validate the skeleton to get your CHECKLIST.** Call \`validateMovement\` on the skeleton. The \`MOV_WRITE_MISSING_REQUIRED_FIELD\` and \`MOV_WRITE_MISSING_REQUIRED_EDGE\` diagnostics are NOT failures — they are your to-do list of holes to fill. Structural errors (bad adapter/edge/nesting) you fix now, before touching any field.
5. **Fill each hole, grounded in \`completionsAt\`.** For every body, and every field/edge/value you're about to commit, call \`completionsAt\`: put a \`<|>\` marker where the cursor is (keep the surrounding program intact, including closing braces) and it returns EXACTLY what is valid there — the target's writable fields, the edges off a handle, enum options, meta-fields. Pick from the offered set; never recall a name and hope. Write every field you sensibly can, not just the required ones.
6. **Re-validate until clean, then save and report.** Re-run \`validateMovement\` after filling (the checklist should shrink); repeat until there are no error-severity diagnostics. Then \`saveMovement\` with a human-readable display name. Report at the user's altitude: what the automation does, where events enter, and the full final program in a code block.

${SHARED_STYLE}`;

// ---------------------------------------------------------------------------
// Brief suite. Grounded in the seeded dev-loop catalog: Attio
// (company/person/investment/fund, mock creds), the vc-dealflow KG
// (Organisation/Person/Deal/…), email inbound. Slack is NOT credentialed,
// so no brief targets it.
// ---------------------------------------------------------------------------

interface Brief {
  id: string;
  title: string;
  /** What the user types. The agent must turn this into a saved movement. */
  message: string;
}

const BRIEFS: Brief[] = [
  {
    id: 'intake',
    title: 'Dealflow intake → Attio',
    message:
      'When a dealflow email arrives at our intake address, create the company in Attio with its name, domain, and a one-line summary, and create the sender as a person in Attio with their name and email.',
  },
  {
    id: 'mirror',
    title: 'Mirror dealflow to the knowledge graph',
    message:
      'When a dealflow email arrives, mirror it into our knowledge graph: create the company as an Organisation and the sender as a Person, and connect the person to the organisation. Fill in whatever fields you can extract from the email.',
  },
  {
    id: 'multi',
    title: 'Multi-target: Attio company + KG Deal',
    message:
      'When a dealflow email arrives, do two things: create the company in Attio (name, domain, summary), and in the knowledge graph create the Organisation and a Deal for that organisation with status Sourced and source type inbound. Connect the Deal to the Organisation.',
  },
];

// ---------------------------------------------------------------------------
// One run: drive the agent on a brief in one mode, recording every tool call.
// ---------------------------------------------------------------------------

type Mode = 'A' | 'B';

interface ToolCallRecord {
  name: string;
  args: any;
  result: any;
}

interface RunRecord {
  mode: Mode;
  briefId: string;
  rep: number;
  // process / cost
  turns: number;
  truncated: boolean;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  wallMs: number;
  error: string | null;
  // outcome
  savedOk: boolean;
  finalSource: string | null;
  // process quality (from the agent's OWN validate calls)
  numValidates: number;
  firstPassClean: boolean | null; // null = never validated
  inventedAcrossRun: number; // summed over every validate the agent ran
  // outcome quality (authoritative — WE re-validate the final source)
  finalOk: boolean | null;
  finalErrorCount: number | null;
  finalInvented: number | null;
  finalMissingRequired: number | null;
  finalTypeErrors: number | null;
  finalEngineUnsupported: number | null;
  // structural proxies for "records connected"
  usesLinkedForm: boolean;
  numWrites: number;
  /** Every readAuthoringDoc target, in order ("index", "writes", "writes#identity"). */
  docFetches: string[];
}

const MAX_TURNS = 40;

function toolDefsForMode(mode: Mode) {
  // Mode A genuinely cannot see completionsAt — it's "today's whole-buffer
  // mode". Mode B gets the full surface.
  return mode === 'B'
    ? movementToolDefinitions
    : movementToolDefinitions.filter((d: any) => d.name !== 'completionsAt');
}

async function runCell(opts: {
  teamId: string;
  brief: Brief;
  mode: Mode;
  rep: number;
  model: ChatModelName;
}): Promise<RunRecord> {
  const { teamId, brief, mode, rep, model } = opts;

  const calls: ToolCallRecord[] = [];
  const baseTools = createMovementAgentTools(() => {}, teamId as TeamId);
  const toolImpls: Record<string, (args: any) => Promise<any>> = {};
  for (const [name, impl] of Object.entries(baseTools)) {
    if (mode === 'A' && name === 'completionsAt') continue;
    toolImpls[name] = async (args: any) => {
      const result = await impl(args);
      calls.push({ name, args, result });
      return result;
    };
  }

  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  const controller = new AbortController();
  let truncated = false;

  const onTurn = (e: TurnEvent) => {
    turns = e.turn + 1;
    inputTokens += e.inputTokens;
    outputTokens += e.outputTokens;
    cacheReadTokens += e.cacheReadTokens;
    cacheCreationTokens += e.cacheCreationTokens;
    if (turns >= MAX_TURNS) {
      truncated = true;
      controller.abort();
    }
  };

  const start = Date.now();
  let error: string | null = null;
  try {
    await anthropicToolLoop(
      {
        model,
        max_output_tokens: 8192,
        system: mode === 'A' ? PROMPT_A : PROMPT_B,
        userMessage: brief.message,
        tools: toolDefsForMode(mode) as any[],
        onTurn,
        label: `mvt_eval_${mode}_${brief.id}`,
        signal: controller.signal,
      },
      toolImpls,
    );
  } catch (e: any) {
    // An abort (turn cap) is expected truncation, not a real failure.
    if (!(truncated && /aborted/i.test(String(e?.message)))) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  const wallMs = Date.now() - start;

  // ---- derive metrics from the recorded calls ----
  const toolCallsByName: Record<string, number> = {};
  for (const c of calls) toolCallsByName[c.name] = (toolCallsByName[c.name] ?? 0) + 1;

  // Authoring is whole-program: the source rides on validateMovement /
  // saveMovement. (The chunked-draft protocol that used to be replayed here is
  // retired.)
  let lastSource: string | null = null;
  let savedOk = false;
  const validations: ValidationLike[] = [];

  for (const c of calls) {
    switch (c.name) {
      case 'validateMovement': {
        const v = c.result as ValidationLike | undefined;
        if (v?.diagnostics) validations.push(v);
        if (typeof c.args?.source === 'string') lastSource = c.args.source;
        break;
      }
      case 'saveMovement': {
        if (c.result?.ok === true) savedOk = true;
        if (typeof c.args?.source === 'string') lastSource = c.args.source;
        break;
      }
      default:
        break;
    }
  }

  const firstPassClean = validations.length ? validations[0].ok === true : null;

  let inventedAcrossRun = 0;
  for (const v of validations) inventedAcrossRun += bucketDiagnostics(v).invented;

  const finalSource = lastSource;

  // Authoritative re-validation of the exact final source.
  let finalOk: boolean | null = null;
  let finalBucket: ReturnType<typeof bucketDiagnostics> | null = null;
  if (finalSource) {
    try {
      const v = await validateMovementForTeam({ teamId, source: finalSource });
      finalOk = v.ok;
      finalBucket = bucketDiagnostics(v);
    } catch (e: any) {
      error = error ?? `final re-validate threw: ${e?.message ?? e}`;
    }
  }

  const usesLinkedForm = finalSource ? /-\s*\[\s*[:!]/.test(finalSource) : false;
  const numWrites = finalSource ? (finalSource.match(/\bwrite\b/g) ?? []).length : 0;

  return {
    mode,
    briefId: brief.id,
    rep,
    turns,
    truncated,
    toolCalls: calls.length,
    toolCallsByName,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    wallMs,
    error,
    savedOk,
    finalSource,
    numValidates: validations.length,
    firstPassClean,
    inventedAcrossRun,
    finalOk,
    finalErrorCount: finalBucket?.errorCount ?? null,
    finalInvented: finalBucket?.invented ?? null,
    finalMissingRequired: finalBucket?.missingRequired ?? null,
    finalTypeErrors: finalBucket?.typeErrors ?? null,
    finalEngineUnsupported: finalBucket?.engineUnsupported ?? null,
    usesLinkedForm,
    numWrites,
    docFetches: calls
      .filter((c) => c.name === 'readAuthoringDoc')
      .map((c) =>
        c.args?.chapter
          ? c.args.section
            ? `${c.args.chapter}#${c.args.section}`
            : String(c.args.chapter)
          : 'index',
      ),
  };
}

// ---------------------------------------------------------------------------
// Aggregation + reporting.
// ---------------------------------------------------------------------------

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number) => `${Math.round(x * 100)}%`;

interface CellSummary {
  briefId: string;
  mode: Mode;
  n: number;
  savedOkRate: number;
  finalCleanRate: number;
  firstPassCleanRate: number;
  meanValidates: number;
  meanInventedAcrossRun: number;
  meanFinalMissingRequired: number;
  meanFinalErrors: number;
  usesLinkedRate: number;
  meanCompletionsCalls: number;
  meanTurns: number;
  meanOutputTokens: number;
  meanTotalTokens: number;
  meanWallMs: number;
  truncatedRate: number;
  errorRate: number;
}

function summarize(runs: RunRecord[], briefId: string, mode: Mode): CellSummary {
  const cell = runs.filter((r) => r.briefId === briefId && r.mode === mode);
  const num = (sel: (r: RunRecord) => number | null) =>
    mean(cell.map(sel).filter((x): x is number => x != null));
  return {
    briefId,
    mode,
    n: cell.length,
    savedOkRate: rate(cell.map((r) => r.savedOk)),
    finalCleanRate: rate(cell.map((r) => r.finalOk === true)),
    firstPassCleanRate: rate(cell.map((r) => r.firstPassClean === true)),
    meanValidates: num((r) => r.numValidates),
    meanInventedAcrossRun: num((r) => r.inventedAcrossRun),
    meanFinalMissingRequired: num((r) => r.finalMissingRequired),
    meanFinalErrors: num((r) => r.finalErrorCount),
    usesLinkedRate: rate(cell.map((r) => r.usesLinkedForm)),
    meanCompletionsCalls: num((r) => r.toolCallsByName['completionsAt'] ?? 0),
    meanTurns: num((r) => r.turns),
    meanOutputTokens: num((r) => r.outputTokens),
    meanTotalTokens: num((r) => r.inputTokens + r.outputTokens),
    meanWallMs: num((r) => r.wallMs),
    truncatedRate: rate(cell.map((r) => r.truncated)),
    errorRate: rate(cell.map((r) => r.error != null)),
  };
}

function printCell(s: CellSummary) {
  const L = (label: string, val: string) => console.log(`    ${label.padEnd(24)} ${val}`);
  console.log(`  mode ${s.mode}  (n=${s.n})`);
  L('saved clean', pct(s.savedOkRate));
  L('final re-validates clean', pct(s.finalCleanRate));
  L('first-pass clean', pct(s.firstPassCleanRate));
  L('validate calls (mean)', String(r1(s.meanValidates)));
  L('invented names / run', String(r1(s.meanInventedAcrossRun)));
  L('final missing-required', String(r1(s.meanFinalMissingRequired)));
  L('final errors (mean)', String(r1(s.meanFinalErrors)));
  L('uses linked form', pct(s.usesLinkedRate));
  L('completionsAt calls', String(r1(s.meanCompletionsCalls)));
  L('turns (mean)', String(r1(s.meanTurns)));
  L('output tokens (mean)', String(Math.round(s.meanOutputTokens)));
  L('total tokens (mean)', String(Math.round(s.meanTotalTokens)));
  L('wall (mean)', `${r1(s.meanWallMs / 1000)}s`);
  if (s.truncatedRate > 0) L('hit turn cap', pct(s.truncatedRate));
  if (s.errorRate > 0) L('errored', pct(s.errorRate));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  k: number;
  briefIds: string[];
  modes: Mode[];
  model: ChatModelName;
  out: string | null;
  pretty: boolean;
}

const DEFAULT_MODEL: ChatModelName = 'claude-sonnet-5';

function parseModel(flag: string | undefined): ChatModelName {
  return flag === undefined ? DEFAULT_MODEL : parseChatModelName(flag, '--model');
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string) => argv.includes(flag);

  const k = Number(get('--k') ?? '3');
  const briefsArg = get('--briefs');
  const briefIds = briefsArg ? briefsArg.split(',').map((s) => s.trim()) : BRIEFS.map((b) => b.id);
  const modesArg = get('--modes');
  const modes = (modesArg ? modesArg.split(',') : ['A', 'B']).map((m) => m.trim() as Mode);
  return {
    k: Number.isFinite(k) && k > 0 ? k : 3,
    briefIds,
    modes,
    model: parseModel(get('--model')),
    out: get('--out') ?? null,
    pretty: has('--pretty'),
  };
}

async function main() {
  const args = parseArgs();

  const seed = await ensureDevLoopTeam();
  const ctx = buildAgentContext(seed.teamId, seed.userId);

  const briefs = BRIEFS.filter((b) => args.briefIds.includes(b.id));
  if (briefs.length === 0) {
    console.error(`No matching briefs. Available: ${BRIEFS.map((b) => b.id).join(', ')}`);
    process.exit(1);
  }

  const plan = briefs.length * args.modes.length * args.k;
  console.error(
    `[mvt-eval] team=${seed.teamId} model=${args.model} briefs=${briefs.map((b) => b.id).join(',')} modes=${args.modes.join(',')} k=${args.k} → ${plan} runs (real Anthropic calls)`,
  );

  const runs: RunRecord[] = [];
  await ctx.runAsync(async () => {
    for (const brief of briefs) {
      for (const mode of args.modes) {
        for (let rep = 0; rep < args.k; rep++) {
          const usage = new LlmUsageContext({ teamId: seed.teamId });
          console.error(`[mvt-eval] running ${mode} · ${brief.id} · rep ${rep + 1}/${args.k}…`);
          const run = await usage.runAsync(() =>
            runCell({ teamId: seed.teamId, brief, mode, rep, model: args.model }),
          );
          runs.push(run);
          console.error(
            `[mvt-eval]   → saved=${run.savedOk} finalClean=${run.finalOk} turns=${run.turns} validates=${run.numValidates} completions=${run.toolCallsByName['completionsAt'] ?? 0}${run.error ? ` ERROR=${run.error}` : ''}`,
          );
        }
      }
    }
  });

  // ---- report ----
  console.log(`\n========== Movement-authoring A/B — Phase 1 (${args.model}) ==========\n`);
  const summaries: CellSummary[] = [];
  for (const brief of briefs) {
    console.log(`Brief: ${brief.id} — ${brief.title}`);
    for (const mode of args.modes) {
      const s = summarize(runs, brief.id, mode);
      summaries.push(s);
      printCell(s);
    }
    console.log('');
  }

  if (args.modes.includes('A') && args.modes.includes('B')) {
    console.log('---------- A → B deltas (positive = B better) ----------\n');
    for (const brief of briefs) {
      const a = summaries.find((s) => s.briefId === brief.id && s.mode === 'A')!;
      const b = summaries.find((s) => s.briefId === brief.id && s.mode === 'B')!;
      console.log(`  ${brief.id}`);
      console.log(
        `    final-clean   ${pct(a.finalCleanRate)} → ${pct(b.finalCleanRate)}   (Δ ${pct(b.finalCleanRate - a.finalCleanRate)})`,
      );
      console.log(
        `    invented/run  ${r1(a.meanInventedAcrossRun)} → ${r1(b.meanInventedAcrossRun)}   (Δ ${r1(b.meanInventedAcrossRun - a.meanInventedAcrossRun)})`,
      );
      console.log(
        `    miss-required ${r1(a.meanFinalMissingRequired)} → ${r1(b.meanFinalMissingRequired)}   (Δ ${r1(b.meanFinalMissingRequired - a.meanFinalMissingRequired)})`,
      );
      console.log(
        `    linked-form   ${pct(a.usesLinkedRate)} → ${pct(b.usesLinkedRate)}`,
      );
      console.log(
        `    cost: turns ${r1(a.meanTurns)} → ${r1(b.meanTurns)} · out-tok ${Math.round(a.meanOutputTokens)} → ${Math.round(b.meanOutputTokens)} · wall ${r1(a.meanWallMs / 1000)}s → ${r1(b.meanWallMs / 1000)}s`,
      );
      console.log('');
    }
  }

  const outPath = args.out ?? `.dev-loop/mvt-eval-${Date.now()}.json`;
  try {
    mkdirSync('.dev-loop', { recursive: true });
    writeFileSync(outPath, JSON.stringify({ args, summaries, runs }, null, 2));
    console.error(`[mvt-eval] full results → ${outPath}`);
  } catch (e: any) {
    console.error(`[mvt-eval] could not write ${outPath}: ${e?.message ?? e}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
