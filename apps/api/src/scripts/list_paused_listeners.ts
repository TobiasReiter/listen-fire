/**
 * List every listener still sitting at `run_mode = 'off'`.
 *
 * `off` used to be an operator pause — a toggle on the automation page. That
 * toggle is gone: the movement text is the only pause authority now, and
 * pausing a listener means commenting its `listen` line out. Nothing writes
 * `off` any more, but existing rows were deliberately NOT auto-resumed (a
 * silent resume would start running automations in production that someone
 * turned off on purpose), so the dispatcher keeps honouring them.
 *
 * That leaves a finite, static set of rows to hand-convert. This script is how
 * you find them: for each one it points at the movement and, where it can, the
 * exact `listen` line span to comment out. Once the list is empty, the `off`
 * value can be retired by a migration.
 *
 * Read-only — it changes nothing.
 *
 * Usage:
 *   pnpm listeners:paused                 # every team
 *   pnpm listeners:paused --team <id>     # one team
 *   pnpm listeners:paused --json          # machine-readable
 */

import { parseProgram, type ListenDeclaration } from 'movement-lang';

import type { TeamId } from '../generated/kysely/core/Team';
import type { MovementId } from '../generated/kysely/automations/Movement';

import { getAutomationsQb, getCoreQb } from '../lib/kysely';
import { logger } from '../services/logger';

type PausedListener = {
  triggerId: string;
  triggerName: string;
  kind: string;
  teamId: string;
  teamName: string;
  movement: { id: string; name: string } | null;
  /** The fired movement inside the script — the `listen … -> <name>` target. */
  firedMovementName: string | null;
  /** 1-based line span of the `listen` statement to comment out, when the
   *  script parses and the statement is identifiable. */
  listenLines: { start: number; end: number } | null;
  /** Why we couldn't pin the span, when we couldn't. */
  note: string | null;
};

function parseArgs(argv: string[]): { team?: string; json: boolean } {
  const out: { team?: string; json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--team') out.team = argv[++i];
  }
  return out;
}

/**
 * Locate the `listen` statement this trigger was compiled from. Matched on the
 * fired movement name (the trigger row's `fired_movement_name`), which is what
 * provisioning keys a derived trigger to. Ambiguity and parse failures are
 * reported rather than guessed at — a wrong line number here means the
 * operator comments out the wrong listener.
 */
function locateListen(
  source: string,
  firedMovementName: string | null,
): { lines: { start: number; end: number } | null; note: string | null } {
  let program;
  try {
    program = parseProgram(source);
  } catch {
    return { lines: null, note: 'movement source does not parse — locate the listen by hand' };
  }
  const listens = program.statements.filter(
    (s): s is ListenDeclaration => s.kind === 'listen',
  );
  if (listens.length === 0) {
    return { lines: null, note: 'no live listen statement in the script (already commented out?)' };
  }
  const matches =
    firedMovementName === null
      ? listens
      : listens.filter((s) => s.movement === firedMovementName);
  if (matches.length !== 1) {
    return {
      lines: null,
      note: `${matches.length} listen statements match "${firedMovementName ?? '(none)'}" — disambiguate by hand`,
    };
  }
  const span = matches[0].span;
  return { lines: { start: span.start.line, end: span.end.line }, note: null };
}

async function collect(teamFilter: string | undefined): Promise<PausedListener[]> {
  const triggers = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('run_mode', '=', 'off')
    .$if(teamFilter != null, (qb) => qb.where('team_id', '=', teamFilter as TeamId))
    .orderBy('team_id', 'asc')
    .orderBy('name', 'asc')
    .select(['id', 'team_id', 'name', 'kind', 'movement_id', 'fired_movement_name'])
    .execute();

  if (triggers.length === 0) return [];

  // automations.* and public.* are separate schemas here, so team names and
  // movement sources are fetched alongside rather than joined.
  // `trigger.team_id` is an opaque tenant uuid (D3 dropped the FK, and with it
  // the brand); naming it as core's team id is the boundary conversion.
  const teamIds = [...new Set(triggers.map((t) => t.team_id as TeamId))];
  const teams = await getCoreQb(['team'])
    .selectFrom('team')
    .where('id', 'in', teamIds)
    .select(['id', 'name'])
    .execute();
  const teamName = new Map(teams.map((t) => [t.id as string, t.name]));

  const movementIds = [
    ...new Set(triggers.map((t) => t.movement_id).filter((id): id is MovementId => id !== null)),
  ];
  const movements =
    movementIds.length > 0
      ? await getAutomationsQb(['movement'])
          .selectFrom('movement')
          .where('id', 'in', movementIds)
          .select(['id', 'name', 'source'])
          .execute()
      : [];
  const movementById = new Map(movements.map((m) => [m.id as string, m]));

  return triggers.map((t): PausedListener => {
    const movementId = t.movement_id as string | null;
    const movement = movementId !== null ? movementById.get(movementId) : undefined;
    const located =
      movement !== undefined
        ? locateListen(movement.source, t.fired_movement_name)
        : {
            lines: null,
            note:
              movementId === null
                ? 'not movement-derived (legacy trigger — it cannot dispatch at all)'
                : 'movement row missing',
          };
    return {
      triggerId: t.id as string,
      triggerName: t.name,
      kind: t.kind,
      teamId: t.team_id as string,
      teamName: teamName.get(t.team_id as string) ?? '(unknown team)',
      movement: movement !== undefined ? { id: movement.id as string, name: movement.name } : null,
      firedMovementName: t.fired_movement_name,
      listenLines: located.lines,
      note: located.note,
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = await collect(args.team);

  if (args.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    logger.info(
      'No listeners are at run_mode=off. The value is unused and can be retired by a migration.',
    );
    return;
  }

  logger.info(
    `${rows.length} listener(s) still paused via the retired run_mode=off. Comment out the listen line in each movement, then re-run.`,
  );
  for (const row of rows) {
    const where =
      row.movement === null
        ? '—'
        : `${row.movement.name}${
            row.listenLines !== null
              ? ` lines ${row.listenLines.start}-${row.listenLines.end}`
              : ''
          }`;
    logger.info(
      `  [${row.teamName}] ${row.triggerName} (${row.kind}, trigger ${row.triggerId}) → ${where}${
        row.note !== null ? ` — ${row.note}` : ''
      }`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error('list paused listeners failed', e);
    process.exit(1);
  });
