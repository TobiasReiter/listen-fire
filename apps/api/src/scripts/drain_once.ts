/**
 * Drain once: claim and run every due automations work row until a pass finds
 * no more, then exit. The entry for a deployment whose passes come from
 * outside any server — a scheduled job (a Cloud Run job on Cloud Scheduler, a
 * cron line) or an embedder's own scheduler. It drains what the server's drain
 * would, and nothing else: no HTTP, and none of the other units' loops.
 *
 * Exit 0 when the drain went idle (failed rows included: each is released to
 * retry on a later pass), 1 when the work table could not be reached.
 *
 * Usage:
 *   node build/scripts/drain_once.js [--limit <1..100>] [--max-passes <1..50>]
 *   pnpm drain:once [...]                  # the same, against the dev loop
 */

import '../services';

import { randomUUID } from 'node:crypto';

import { globalQb } from '../lib/kysely';
import { prismaClient } from '../prisma';
import { mounts } from '../products';
import { drainUntilIdle } from '../services/work/drain';
import { registerAutomationsWork } from '../startup/automations';

// The tick endpoint's bounds, so a job and a tick are the same pass.
const LIMIT_MAX = 100;
const MAX_PASSES_MAX = 50;

function intFlag(argv: readonly string[], input: { flag: string; max: number }): number | undefined {
  const index = argv.indexOf(input.flag);
  if (index < 0) return undefined;
  const raw = argv[index + 1] ?? '';
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > input.max) {
    throw new Error(`${input.flag} must be a whole number from 1 to ${input.max}, not "${raw}".`);
  }
  return value;
}

/** One drain-once run; resolves to the process's exit code. */
export async function drainOnceMain(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  // The work table is the automations unit's; a process that does not mount it
  // has no handlers to run, and would claim rows only to release them.
  if (!mounts('automations')) {
    throw new Error('drain:once runs automations work, and LISTEN_FIRE_PRODUCTS does not mount automations.');
  }
  const limit = intFlag(argv, { flag: '--limit', max: LIMIT_MAX });
  const maxPasses = intFlag(argv, { flag: '--max-passes', max: MAX_PASSES_MAX });

  await registerAutomationsWork();
  const result = await drainUntilIdle({
    owner: `once:${randomUUID()}`,
    ...(limit !== undefined ? { limit } : {}),
    ...(maxPasses !== undefined ? { maxPasses } : {}),
  });
  console.log(JSON.stringify(result));
  return result.claimFailed ? 1 : 0;
}

/** Run once, close the pools, and exit with the run's code. */
export async function drainOnceAndExit(): Promise<never> {
  const code = await drainOnceMain().catch((err: unknown) => {
    console.error('[drain:once] failed', err);
    return 1;
  });
  await Promise.allSettled([prismaClient.$disconnect(), globalQb.destroy()]);
  process.exit(code);
}

if (require.main === module) void drainOnceAndExit();
