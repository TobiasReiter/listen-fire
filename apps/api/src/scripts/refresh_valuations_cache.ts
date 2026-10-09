// Recompute (and audit) the degree-bucketed valuations cache.
//
//   --team <id>                    required; the cache is team-scoped
//   --investment <id> ...          restrict to specific investments
//   --concurrency <n>              default 5
//   --as-of <YYYY-MM-DD>           analysis date for the walk
//   --check                        parity mode: READ-ONLY. Compares the cached
//                                  read against the full walk per investment
//                                  and exits non-zero on any disagreement.
//   --currency <ISO>               parity mode's currency of analysis (USD)
//
// Recompute is idempotent: each investment's rows are deleted and rewritten
// wholesale from the walk, so re-running lands on the same bytes.
//
// See src/db/backfills/README.md for the operator procedure.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../generated/kysely/core/Team';

import { Context } from '../services/context';
import { getCachedInvestmentsValuation, refreshInventoryCache } from '../lib/valuations/cache';
import { getInvestmentsValuation } from '../lib/valuations/valuation';
import { getValuationsQb } from '../lib/kysely';
import { userPrincipal } from '../services/principal';
import CurrencyIsoCode from '../generated/kysely/valuations/CurrencyIsoCode';
import { InvestmentValuation } from '../lib/valuations/valuation/types';

// The two paths reach the same numbers by different arithmetic (SQL SUM vs a
// JS reduce over lots), so they agree to floating-point noise, not to the bit.
const TOLERANCE = 0.01;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.teamId) {
    console.error(
      'Usage: refresh_valuations_cache --team <teamId> [--investment <id> ...] [--concurrency <n>] [--as-of <YYYY-MM-DD>] [--check] [--currency <ISO>]',
    );
    process.exit(1);
  }

  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId: randomUUID(), teamId: args.teamId }));

  await ctx.runAsync(args.check ? () => checkParity(args) : () => recompute(args));
}

async function recompute(args: ParsedArgs): Promise<void> {
  const start = Date.now();
  const result = await refreshInventoryCache({
    investmentIds: args.investmentIds.length > 0 ? args.investmentIds : undefined,
    concurrency: args.concurrency,
    asOfDate: args.asOfDate,
    onProgress: (done, total, id) => {
      if (done % 10 === 0 || done === total) {
        console.log(`  [${done}/${total}] warmed ${id}`);
      }
    },
  });
  const seconds = ((Date.now() - start) / 1000).toFixed(1);

  console.log('');
  console.log(`Done in ${seconds}s. Warmed ${result.warmed}, failed ${result.failed.length}.`);
  if (result.failed.length) {
    console.log('Failures:');
    for (const f of result.failed) {
      console.log(`  ${f.investmentId}: ${f.error}`);
    }
    process.exit(2);
  }
}

/**
 * Read-only audit: for every investment, the cached read must produce the same
 * valuation as the full walk. Compares the CACHED row directly rather than
 * `useHoldingsCache`, which silently falls back to the walk — a fallback would
 * make a broken cache look perfect.
 */
async function checkParity(args: ParsedArgs): Promise<void> {
  const asOfDate = args.asOfDate ?? new Date();
  const ids =
    args.investmentIds.length > 0
      ? args.investmentIds
      : await listAllInvestmentIdsForTeam(args.teamId!);

  let agreed = 0;
  const uncached: string[] = [];
  const missingFx: string[] = [];
  const disagreed: { investmentId: string; field: string; cached: number; walked: number }[] = [];

  for (const investmentId of ids) {
    const cache = await getCachedInvestmentsValuation({
      investmentIds: [investmentId],
      asOfDate,
      fxDate: asOfDate,
      targetCurrency: args.currency,
    });
    if (cache.investmentsWithoutCache.includes(investmentId)) {
      uncached.push(investmentId);
      continue;
    }
    if (cache.investmentsMissingFx.includes(investmentId)) {
      missingFx.push(investmentId);
      continue;
    }

    const walked = await getInvestmentsValuation({
      investments: [{ id: investmentId, date: null }],
      asOfDate,
      fxDate: asOfDate,
      targetCurrency: args.currency,
    });

    const mismatches = compareValuations(cache.perInvestment[investmentId], walked);
    if (mismatches.length === 0) agreed += 1;
    for (const m of mismatches) disagreed.push({ investmentId, ...m });
  }

  console.log('');
  console.log(`Checked ${ids.length} investments against the full walk.`);
  console.log(`  agreed:      ${agreed}`);
  console.log(`  uncached:    ${uncached.length}${uncached.length ? ` (${uncached.join(', ')})` : ''}`);
  console.log(`  missing fx:  ${missingFx.length}`);
  console.log(`  disagreed:   ${new Set(disagreed.map((d) => d.investmentId)).size}`);
  for (const d of disagreed) {
    console.log(`    ${d.investmentId} ${d.field}: cached ${d.cached} vs walked ${d.walked}`);
  }
  if (disagreed.length) process.exit(2);
}

function compareValuations(
  cached: InvestmentValuation,
  walked: InvestmentValuation,
): { field: string; cached: number; walked: number }[] {
  const mismatches: { field: string; cached: number; walked: number }[] = [];
  for (const [field, walkedValue] of Object.entries(walked)) {
    const cachedValue = cached[field as keyof InvestmentValuation];
    if (typeof walkedValue === 'number' && typeof cachedValue === 'number') {
      if (Math.abs(walkedValue - cachedValue) > TOLERANCE) {
        mismatches.push({ field, cached: cachedValue, walked: walkedValue });
      }
      continue;
    }
    if (walkedValue !== cachedValue) {
      mismatches.push({ field, cached: Number(cachedValue), walked: Number(walkedValue) });
    }
  }
  return mismatches;
}

async function listAllInvestmentIdsForTeam(teamId: string): Promise<string[]> {
  const rows = await getValuationsQb(['investment'])
    .selectFrom('investment')
    .select('id')
    .where('team_id', '=', teamId as TeamId)
    .execute();
  return rows.map((r) => r.id);
}

interface ParsedArgs {
  teamId?: string;
  investmentIds: string[];
  concurrency: number;
  asOfDate?: Date;
  check: boolean;
  currency: CurrencyIsoCode;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    investmentIds: [],
    concurrency: 5,
    check: false,
    currency: CurrencyIsoCode.USD,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--team' && next) {
      parsed.teamId = next;
      i++;
    } else if (arg === '--investment' && next) {
      parsed.investmentIds.push(next);
      i++;
    } else if (arg === '--concurrency' && next) {
      parsed.concurrency = Number(next);
      i++;
    } else if (arg === '--as-of' && next) {
      parsed.asOfDate = new Date(next);
      i++;
    } else if (arg === '--currency' && next) {
      parsed.currency = next as CurrencyIsoCode;
      i++;
    } else if (arg === '--check') {
      parsed.check = true;
    }
  }
  return parsed;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
