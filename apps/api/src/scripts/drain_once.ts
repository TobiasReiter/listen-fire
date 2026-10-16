/**
 * Drain once: claim and run every due automations work row until a pass finds
 * no more, then exit. The entry for a deployment whose passes come from
 * outside any server — a scheduled job (a Cloud Run job on Cloud Scheduler, a
 * cron line) or an embedder's own scheduler. It drains what the server's drain
 * would, and nothing else: no HTTP, and none of the other units' loops.
 *
 * Exit 0 when the drain went idle (failed rows included: each is released to
 * retry on a later pass), 2 when it stopped at the pass limit with work still
 * due, 1 when the work table could not be reached or the run threw.
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
import { drainUntilIdle, type DrainStop } from '../services/work/drain';
import { registerAutomationsWork } from '../startup/automations';

// The tick endpoint's bounds, so a job and a tick are the same pass.
const FLAG_MAX = { '--limit': 100, '--max-passes': 50 } as const;

type Flag = keyof typeof FLAG_MAX;

function isFlag(name: string): name is Flag {
  return Object.hasOwn(FLAG_MAX, name);
}

/** `--limit 5` or `--limit=5`, likewise `--max-passes`; anything else is refused by name. */
function parseFlags(argv: readonly string[]): Partial<Record<Flag, number>> {
  const flags: Partial<Record<Flag, number>> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (!isFlag(name)) throw new Error(`drain:once does not take "${arg}" (it takes --limit and --max-passes).`);
    const raw = eq < 0 ? (argv[++i] ?? '') : arg.slice(eq + 1);
    const value = Number(raw);
    if (raw === '' || !Number.isInteger(value) || value < 1 || value > FLAG_MAX[name]) {
      throw new Error(`${name} must be a whole number from 1 to ${FLAG_MAX[name]}, not "${raw}".`);
    }
    flags[name] = value;
  }
  return flags;
}

/** 0: the drain went idle. 2: it stopped at the pass limit with work still
 *  due, so a scheduler should run it again. 1: the work table could not be
 *  reached (or, from `drainOnceAndExit`, the run threw). */
const EXIT_CODE: Record<DrainStop, number> = { idle: 0, pass_limit: 2, claim_failed: 1 };

/** One drain-once run; resolves to the process's exit code. */
export async function drainOnceMain(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  // The work table is the automations unit's; a process that does not mount it
  // has no handlers to run, and would claim rows only to release them.
  if (!mounts('automations')) {
    throw new Error('drain:once runs automations work, and LISTEN_FIRE_PRODUCTS does not mount automations.');
  }
  const { '--limit': limit, '--max-passes': maxPasses } = parseFlags(argv);

  await registerAutomationsWork();
  const result = await drainUntilIdle({
    owner: `once:${randomUUID()}`,
    ...(limit !== undefined ? { limit } : {}),
    ...(maxPasses !== undefined ? { maxPasses } : {}),
  });
  console.log(JSON.stringify(result));
  return EXIT_CODE[result.stopped];
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
