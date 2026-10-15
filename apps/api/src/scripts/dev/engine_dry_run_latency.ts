/**
 * What the admission dry run costs per firing, over the recorded corpora.
 *
 *   pnpm dev:engine-dry-run-latency
 *
 * Every run and resume recording in the host-conformance fixtures
 * (services/movement_engine/conformance/__fixtures__/engine-runs.v*.json) is
 * put to the dry run (rust_engine.ts `dryAdmitRun`) as the TypeScript-routed
 * branch would put it, against a test host, and timed around the call. Prints
 * the percentiles and what the dry run found. No database, no network.
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';

import type { HostRecording } from 'engine-contracts/conformance';

import { openRunContext } from 'movement-engine/services/movement_engine/run_context';
import { dryAdmitResume, dryAdmitRun } from 'movement-engine/services/movement_engine/rust_engine';
import { resetRustRunStats, rustRunStats } from 'movement-engine/services/movement_engine/rust_stats';
import { makeTestHost } from 'movement-engine/services/movement_engine/test_host';

const FIXTURES = path.resolve(__dirname, '../../services/movement_engine/conformance/__fixtures__');

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? Number.NaN;
}

async function main(): Promise<void> {
  // Recordings carry no run id, so no verdict is held for a host to persist.
  resetRustRunStats();
  const times: number[] = [];
  for (const file of fs.readdirSync(FIXTURES).filter((name) => /^engine-runs\.v\d+\.json$/.test(name)).sort()) {
    for (const line of fs.readFileSync(path.join(FIXTURES, file), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const recording: HostRecording = JSON.parse(line);
      if (recording.entry !== 'run' && recording.entry !== 'resume') continue;
      const host = makeTestHost();
      const languageVersion = recording.input.languageVersion ?? CURRENT_LANGUAGE_VERSION;
      const context = await openRunContext({ host, teamId: recording.input.teamId, languageVersion, spend: {} });
      const asked = rustRunStats.dryRun.sampled;
      const startedAt = performance.now();
      if (recording.entry === 'run') dryAdmitRun({ input: { ...recording.input, host }, context });
      else dryAdmitResume({ input: { ...recording.input, host }, context });
      const took = performance.now() - startedAt;
      // A rehearsal is not asked about: its near-zero time is not the cost.
      if (rustRunStats.dryRun.sampled > asked) times.push(took);
    }
  }
  const sorted = [...times].sort((a, b) => a - b);
  const ms = (value: number) => `${value.toFixed(2)} ms`;
  const { sampled, admitted, faults } = rustRunStats.dryRun;
  console.log(`admission dry run over the ${times.length} recorded firings it asks about (rehearsals are not)`);
  console.log(`  p50 ${ms(percentile(sorted, 0.5))}  p95 ${ms(percentile(sorted, 0.95))}  p99 ${ms(percentile(sorted, 0.99))}  max ${ms(sorted[sorted.length - 1] ?? Number.NaN)}`);
  console.log(`  first call ${ms(times[0] ?? Number.NaN)} (the artifact compiles once per process)`);
  console.log(`  ${sampled} asked, ${admitted} admitted, ${sampled - admitted} refused, ${faults} faults`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
