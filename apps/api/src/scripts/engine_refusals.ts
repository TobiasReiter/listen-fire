/**
 * The Rust engine's refusal burn-down, in production demand order: of the
 * runs the TypeScript engine ran over the last N days, what the Rust engine's
 * admission would have refused them for (the admission dry run, persisted as
 * a daily roll-up: services/movement_engine/admission_rollup.ts). For each
 * reason: the runs it blocked, how many automations those were, and the five
 * with the most runs. Twice: by the reason a run is refused for first, and by
 * every reason it names.
 *
 * The roll-ups live in the operator event store, which keeps 14 days.
 *
 * Read-only — it changes nothing.
 *
 * Usage:
 *   pnpm engine:refusals              # the last 7 days
 *   pnpm engine:refusals --days 14
 *   pnpm engine:refusals --json       # machine-readable
 */

import {
  readAdmissionRollups,
  summariseAdmissionRollups,
  type AdmissionReport,
  type ReasonDemand,
} from '../services/movement_engine/admission_rollup';
import { logger } from '../services/logger';

const RETAINED_DAYS = 14;

function parseArgs(argv: readonly string[]): { days: number; json: boolean } {
  const out = { days: 7, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--days') {
      const days = Number(argv[++i]);
      if (!Number.isInteger(days) || days < 1) throw new Error(`--days takes a whole number of days, not "${argv[i]}"`);
      out.days = days;
    } else throw new Error(`engine:refusals does not take "${argv[i]}" (--days N, --json)`);
  }
  return out;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? '-' : `${((100 * part) / whole).toFixed(1)}%`;
}

function table(title: string, rows: readonly ReasonDemand[]): string[] {
  if (rows.length === 0) return [title, '  (none)'];
  const width = Math.max(6, ...rows.map((row) => row.reason.length));
  return [
    title,
    `  ${'reason'.padEnd(width)}  ${'runs'.padStart(7)}  ${'autos'.padStart(5)}  top automations (runs)`,
    ...rows.map(
      (row) =>
        `  ${row.reason.padEnd(width)}  ${String(row.runs).padStart(7)}  ${String(row.automations).padStart(5)}  ` +
        row.top.map((top) => `${top.automation} (${top.runs})`).join(', '),
    ),
  ];
}

export function renderAdmissionReport(report: AdmissionReport, days: number): string {
  const { total } = report;
  const refused = total.sampled - total.admitted;
  const lines = [
    `Rust admission dry run, last ${days} day(s)${report.days.length > 0 ? ` (${report.days[0]} to ${report.days[report.days.length - 1]})` : ''}`,
    `  runs asked about: ${total.sampled}; Rust would have started ${total.admitted} (${percent(total.admitted, total.sampled)}), refused ${refused} (${percent(refused, total.sampled)})`,
    ...Object.entries(report.versions)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(
        ([version, tally]) =>
          `  language version ${version}: ${tally.sampled} asked, ${tally.admitted} admitted (${percent(tally.admitted, tally.sampled)})`,
      ),
    '',
    ...table('By first reason (what a run is refused for):', report.first),
    '',
    ...table('By every reason (each refused run once per reason it names):', report.all),
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { days, json } = parseArgs(process.argv.slice(2));
  if (days > RETAINED_DAYS) {
    logger.warn(`the operator event store keeps ${RETAINED_DAYS} days: --days ${days} reads at most that`);
  }
  const report = summariseAdmissionRollups(await readAdmissionRollups(days));
  console.log(json ? JSON.stringify({ windowDays: days, ...report }, null, 2) : renderAdmissionReport(report, days));
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      logger.error('engine:refusals failed', error);
      process.exit(1);
    });
}
