// End-to-end authoring eval through the automations MCP tools.
//
// For each task × variant × trial: reset the eval team's world, let a builder
// agent (only the automations MCP tools, optionally the builder skill) talk a
// simulated user through to a saved automation, fire the task's fixture events
// at what it saved, wait for the runs to settle, and score the end state the
// fake channels were left in — plus efficiency, safety, and a model judge's
// clarity scores.
//
//   pnpm dev:loop:agent                                   # one shell, leave running
//   pnpm dev:seed                                         # once
//   pnpm dev:automation-eval --tasks inbound-intake --k 1 # a smoke
//   pnpm dev:automation-eval --variants noskill,skill --k 3   # the baseline
//
// Output: .dev-loop/evals/<timestamp>/{report.json, summary.md, trials/*.json}.
// Real Anthropic calls; each trial is capped by --max-trial-cost (default $2).

import '../_profile_loader';
import '../../../services';

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import { bucketDiagnostics } from '../lib/diagnostic_families';
import { runBuilder, type BuildOutcome, type Effort, type Variant } from './builder';
import { judgeFixture, sentEmailCount } from './end_state';
import { judgeClarity, RUBRIC, type ClarityVerdict } from './judge';
import {
  assessSafety,
  measureEfficiency,
  renderSummary,
  sendsBeforeApproval,
  summarize,
  totalsByVariant,
  type FixtureRecord,
  type TrialOutcome,
  type TrialRecord,
} from './report';
import {
  cancelOpenRuns,
  connectStack,
  ensureConnections,
  fireEvent,
  inspectRun,
  listAutomations,
  primePolledInboxes,
  readAutomationSource,
  resetForTrial,
  saveCanary,
  seedFakeChannels,
  settle,
  snapshot,
  validateSource,
  type AutomationSummary,
  type Stack,
} from './stack';
import { runRecordOf } from './run_record';

import type { Task } from './task';

import { TASKS } from './tasks';
import { costUsd, emptyUsage } from './usage';
import { parseVariants, trialFileName } from './variants';

interface Args {
  taskIds: string[];
  k: number;
  variants: Variant[];
  builderModel: string;
  builderEffort: Effort;
  userModel: string;
  judgeModel: string;
  maxTrialCostUsd: number;
  maxModelCalls: number;
  maxUserTurns: number;
  outDir: string | null;
}

/** Held back from the builder's share of a trial's budget so the judge can still run. */
const JUDGE_RESERVE_USD = 0.15;

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const list = (value: string | undefined) =>
    value
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const positive = (flag: string, fallback: number) => {
    const raw = get(flag);
    const n = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number, got ${raw}`);
    return n;
  };

  const variants = parseVariants({ variants: get('--variants'), skill: argv.includes('--skill') });
  const effortName = get('--effort') ?? 'high';
  const builderEffort = EFFORTS.find((e) => e === effortName);
  if (!builderEffort) throw new Error(`unknown --effort "${effortName}" (expected ${EFFORTS.join(', ')})`);

  return {
    taskIds: list(get('--tasks')) ?? TASKS.map((t) => t.id),
    k: positive('--k', 1),
    variants,
    builderModel: get('--model') ?? 'claude-sonnet-5-5',
    builderEffort,
    userModel: get('--user-model') ?? 'claude-sonnet-5-5',
    judgeModel: get('--judge-model') ?? 'claude-sonnet-5-5',
    maxTrialCostUsd: positive('--max-trial-cost', 2),
    maxModelCalls: positive('--max-model-calls', 60),
    maxUserTurns: positive('--max-user-turns', 8),
    outDir: get('--out') ?? null,
  };
}

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');

function log(line: string): void {
  process.stderr.write(`[automation-eval] ${line}\n`);
}

function trialCost(args: Args, usage: TrialRecord['usage']): number {
  return (
    (costUsd(args.builderModel, usage.builder) ?? 0) +
    (costUsd(args.userModel, usage.user) ?? 0) +
    (costUsd(args.judgeModel, usage.judge) ?? 0)
  );
}

async function runFixtures(input: {
  stack: Stack;
  task: Task;
  automations: AutomationSummary[];
  workDir: string;
}): Promise<FixtureRecord[]> {
  const { stack, task } = input;
  const records: FixtureRecord[] = [];
  for (const fixture of task.fixtures) {
    if (fixture.seed) await seedFakeChannels(stack, fixture.seed);
    const before = await snapshot(stack);
    // A second of slack for the database clock, so the run row is never "before" the event.
    const since = new Date(Date.now() - 1_000);
    const fired = await fireEvent({
      stack,
      event: fixture.event,
      automations: input.automations,
      workDir: input.workDir,
    });
    const settled = await settle({ stack, since, review: fixture.review ?? 'approve' });
    const runs = await Promise.all(settled.runs.map(async (run) => runRecordOf(run, await inspectRun(stack, run.id))));
    const after = await snapshot(stack);
    const verdict = judgeFixture(fixture, before, after);
    const outboxBefore = sentEmailCount(before);
    records.push({
      id: fixture.id,
      description: fixture.description,
      pass: verdict.pass,
      results: verdict.results,
      firedAt: fired.targets,
      fireNote: fired.note ?? null,
      runs,
      reviews: settled.reviews,
      timedOut: settled.timedOut,
      sendsBeforeApproval: task.sendsToThirdParty
        ? sendsBeforeApproval({
            outboxBefore,
            outboxAfter: sentEmailCount(after),
            outboxAtFirstReview: settled.outboxAtFirstReview,
          })
        : 0,
    });
    log(`  fixture ${fixture.id}: ${verdict.pass ? 'PASS' : 'FAIL'} (${settled.runs.length} run(s), ${settled.reviews.length} review(s)${settled.timedOut ? ', timed out' : ''})`);
    await cancelOpenRuns(stack);
  }
  return records;
}

function outcomeOf(build: BuildOutcome): TrialOutcome {
  switch (build.endReason) {
    case 'cost-budget':
      return 'budget-exceeded';
    case 'error':
    case 'refusal':
      return 'build-failed';
    case 'done':
    case 'model-call-budget':
    case 'user-turn-budget':
      return 'scored';
  }
}

async function runTrial(input: {
  args: Args;
  stack: Stack;
  task: Task;
  variant: Variant;
  rep: number;
  workDir: string;
}): Promise<TrialRecord> {
  const { args, stack, task, variant, rep } = input;
  const started = Date.now();
  const models = { builder: args.builderModel, user: args.userModel, judge: args.judgeModel };
  const judgeUsage = emptyUsage();

  await resetForTrial(stack, task.seed);
  const missing = await ensureConnections(stack, task.connections);
  const canary = await saveCanary(stack);
  if (missing.length > 0) {
    log(`  setup: missing connections ${missing.join(', ')}`);
  }

  const build = await runBuilder({
    task,
    variant,
    apiBaseUrl: stack.apiBaseUrl,
    apiKey: stack.apiKey,
    builderModel: args.builderModel,
    builderEffort: args.builderEffort,
    userModel: args.userModel,
    maxModelCalls: args.maxModelCalls,
    maxUserTurns: args.maxUserTurns,
    maxCostUsd: args.maxTrialCostUsd - JUDGE_RESERVE_USD,
    log,
  });
  const outcome: TrialOutcome = missing.length > 0 ? 'setup-failed' : outcomeOf(build);
  log(`  build ended: ${build.endReason}${build.error ? ` (${build.error})` : ''} after ${build.modelCalls} model calls, ${build.toolCalls.length} tool calls`);

  // The builder's own test runs must not act during the fixtures.
  await cancelOpenRuns(stack);
  const automations = (await listAutomations(stack)).filter((a) => a.id !== canary.id);
  await primePolledInboxes(automations);
  await cancelOpenRuns(stack);

  const fixtures =
    outcome === 'budget-exceeded' || outcome === 'setup-failed'
      ? []
      : await runFixtures({ stack, task, automations, workDir: input.workDir });

  const finalSources = await Promise.all(
    automations.map(async (a) => ({ id: a.id, name: a.name, source: await readAutomationSource(stack, a.id) })),
  );
  const finalValidation = await Promise.all(
    finalSources
      .filter((s): s is { id: string; name: string; source: string } => s.source !== null)
      .map(async (s) => {
        const v = await validateSource(stack, s.source);
        return { id: s.id, ok: v.ok, buckets: bucketDiagnostics(v) };
      }),
  );

  const canaryAfter = (await listAutomations(stack)).some((a) => a.id === canary.id)
    ? await readAutomationSource(stack, canary.id)
    : null;

  let clarity: ClarityVerdict | null = null;
  let judgeError: string | null = null;
  if (outcome !== 'budget-exceeded' && outcome !== 'setup-failed') {
    try {
      clarity = await judgeClarity({
        client: new Anthropic(),
        model: args.judgeModel,
        task,
        sources: finalSources.map((s) => s.source).filter((s): s is string => s !== null),
        transcript: build.transcript,
        usage: judgeUsage,
      });
    } catch (err) {
      judgeError = `judge failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const usage = { builder: build.builderUsage, user: build.userUsage, judge: judgeUsage };
  const errors = [
    missing.length > 0 ? `missing connections: ${missing.join(', ')}` : null,
    build.error,
    judgeError,
  ].filter((e): e is string => e !== null);

  return {
    taskId: task.id,
    variant,
    rep,
    outcome,
    buildEndReason: build.endReason,
    error: errors.length ? errors.join('; ') : null,
    models,
    fixtures,
    correct: outcome === 'scored' && fixtures.length > 0 && fixtures.every((f) => f.pass),
    efficiency: measureEfficiency({
      toolCalls: build.toolCalls,
      modelCalls: build.modelCalls,
      userTurns: build.userTurns,
      buildWallMs: build.wallMs,
      timing: build.timing,
    }),
    safety: assessSafety({
      toolCalls: build.toolCalls,
      canaryId: canary.id,
      canarySourceBefore: canary.source,
      canarySourceAfter: canaryAfter,
      fixtures,
    }),
    clarity,
    finalSources,
    finalValidation,
    usage,
    costUsd: trialCost(args, usage),
    wallMs: Date.now() - started,
    transcript: build.transcript,
    steps: build.steps,
    toolCalls: build.toolCalls,
  };
}

function writeReport(input: { outDir: string; startedAt: string; args: Args; trials: TrialRecord[] }): void {
  const { outDir, startedAt, args, trials } = input;
  writeFileSync(
    path.join(outDir, 'report.json'),
    JSON.stringify(
      {
        startedAt,
        args,
        rubric: RUBRIC,
        totals: totalsByVariant(trials),
        cells: summarize(trials),
        trials: trials.map(({ toolCalls, transcript, steps, ...rest }) => ({
          ...rest,
          toolCalls: toolCalls.length,
          transcriptTurns: transcript.length,
          steps: steps.length,
        })),
      },
      (_key, value: unknown) => (value instanceof RegExp ? value.toString() : value),
      2,
    ),
  );
  writeFileSync(
    path.join(outDir, 'summary.md'),
    renderSummary({ startedAt, args: { ...args }, trials }),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tasks = TASKS.filter((t) => args.taskIds.includes(t.id));
  const unknown = args.taskIds.filter((id) => !TASKS.some((t) => t.id === id));
  if (unknown.length > 0 || tasks.length === 0) {
    throw new Error(`unknown task(s) ${unknown.join(', ')}; available: ${TASKS.map((t) => t.id).join(', ')}`);
  }

  const startedAt = new Date().toISOString();
  const outDir = args.outDir ?? path.join(REPO_ROOT, '.dev-loop/evals', startedAt.replace(/[:.]/g, '-'));
  mkdirSync(path.join(outDir, 'trials'), { recursive: true });

  const stack = await connectStack();
  const plan = tasks.length * args.variants.length * args.k;
  log(
    `team=${stack.teamId} api=${stack.apiBaseUrl} builder=${args.builderModel}/${args.builderEffort} user=${args.userModel} judge=${args.judgeModel} → ${plan} trial(s), ≤ $${args.maxTrialCostUsd} each`,
  );
  log(`output → ${outDir}`);

  const trials: TrialRecord[] = [];
  for (const task of tasks) {
    for (const variant of args.variants) {
      for (let rep = 0; rep < args.k; rep++) {
        log(`${task.id} · ${variant} · trial ${rep + 1}/${args.k}`);
        const trial = await runTrial({
          args,
          stack,
          task,
          variant,
          rep,
          workDir: path.join(outDir, 'work'),
        });
        trials.push(trial);
        writeFileSync(
          path.join(outDir, 'trials', trialFileName({ taskId: task.id, variant, rep })),
          JSON.stringify(trial, (_key, value: unknown) => (value instanceof RegExp ? value.toString() : value), 2),
        );
        writeReport({ outDir, startedAt, args, trials });
        log(
          `  → ${trial.outcome}, correct=${trial.correct}, safe=${trial.safety.pass}, clarity=${trial.clarity?.overall.toFixed(1) ?? '–'}, build ${Math.round(trial.efficiency.buildWallMs / 1000)}s (model ${Math.round(trial.efficiency.modelMs / 1000)}s, tools ${Math.round(trial.efficiency.toolMs / 1000)}s), ${trial.efficiency.toolCalls} tool calls, read ≈${trial.efficiency.readTokens.total} tokens, $${trial.costUsd.toFixed(2)}, ${Math.round(trial.wallMs / 1000)}s`,
        );
      }
    }
  }

  await resetForTrial(stack, undefined);
  process.stdout.write(`${renderSummary({ startedAt, args: { ...args }, trials })}\n`);
  log(`report → ${path.join(outDir, 'report.json')}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
