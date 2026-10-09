/**
 * Manually prune old trigger_run rows. Disabled by default; enable on a cron
 * (e.g. Render scheduled job) when retention is required.
 *
 *   pnpm tg:prune                 → delete rows older than 7 days, all teams
 *   pnpm tg:prune --days 3        → delete rows older than 3 days
 *   pnpm tg:prune --team <uuid>   → scope to one team
 */

import type { TeamId } from '../../generated/kysely/core/Team';

import { pruneTriggerRuns } from '../../services/translation_graph/runs/prune';
import { releaseLlmUsageRunReferences } from '../../lib/llm_usage';

function parseArgs(): { days: number; teamId?: TeamId } {
  const args = process.argv.slice(2);
  let days = 7;
  let teamId: TeamId | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days') {
      days = Number(args[++i]);
    } else if (args[i] === '--team') {
      teamId = args[++i] as TeamId;
    }
  }
  if (!Number.isFinite(days) || days < 0) {
    throw new Error(`--days must be a non-negative number, got ${days}`);
  }
  return { days, teamId };
}

async function main() {
  const { days, teamId } = parseArgs();
  const { deletedRunIds, ...result } = await pruneTriggerRuns({ olderThanDays: days, teamId });
  // The run ledger is automations'; `llm_usage` is residual and no longer
  // nulls itself off it (D3/D8), so this pruner releases it by hand.
  await releaseLlmUsageRunReferences({ runIds: deletedRunIds });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
