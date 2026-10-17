/**
 * Dev-loop provisioning CLI for the Dealroom POLL source.
 *
 *   pnpm dev:dealroom setup [--round "SERIES A"] [--industry Fintech]
 *
 * Dealroom has no webhooks anywhere in its API (0_mission.md "Connection"), so
 * event production is the poll-source worker: it scans `automations.trigger`
 * rows of kind `dealroom`, asks the Dealroom client for the rounds recorded
 * since the persisted checkpoint, and dispatches each through the one event
 * pipeline. Exercising that in the dev loop needs, for the dev-loop team:
 *
 *   1. a DEALROOM credential (a stub api key — `injectFakeBaseUrl` points the
 *      client at the fake Dealroom API in fake-channels for the test-harness
 *      team). `ensureDevLoopTeam()` already seeds it as 'Dev Loop Dealroom',
 *   2. a SLACK credential (the movement's observable write target), and
 *   3. one file carrying the listener on the `Funding Round` fires edge, whose
 *      body walks the delivered round to its `Company` and its `Investors` and
 *      writes ONE line naming both to the fake Slack `dealflow` channel.
 *
 * `setup` creates all three, idempotently. Saving the file runs the REAL
 * provision path, which derives the `dealroom`-kind trigger row (poll_last_at
 * NULL → immediately due) with its own poll checkpoint. Then:
 *
 *   pnpm dev:inject dealroom --round "SERIES A"
 *   pnpm dev:inspect dealroom
 *   pnpm dev:inspect slack
 *
 * The inject seeds a round into the fake and fires the poll IN-PROCESS, so the
 * seeded round flows through the real getEvents → discriminate → seed → run
 * path. `--round` on SETUP narrows the listen (the `rounds` terms filter), so
 * an inject of any other round label must produce nothing.
 */

import './_profile_loader';
// Register the service adapters the API server boots so `saveMovement` runs the
// real provision path (catalog assembly, listener reconciliation).
import '../../services';
import { getAutomationsQb } from '../../lib/kysely';

import type { TeamId } from '../../generated/kysely/core/Team';

import { ensureDevLoopTeam, ensureDevLoopSlackCredential } from './_lib';
import { saveMovement } from '../../services/translation_graph/movement/provision';

/**
 * The proof file. The delivered round is a `Funding Round` position, so the
 * body walks the two edges a listener actually wants — `Company` (who raised)
 * and `Investors` (who put money in, via the `Round Investor` pair node) — and
 * writes one line naming both. That line is the evidence the whole path ran:
 * poll → discriminate → seed → run → two hops into the fake → a Slack write.
 *
 * With no `--round` the listen delivers EVERY new round; `--round` narrows it
 * to one Dealroom round label, which is what makes an excluded-label inject
 * observably silent.
 */
function dealroomFile(scope: { round?: string; industry?: string } = {}): string {
  const options: string[] = [];
  if (scope.round !== undefined) options.push(`rounds: ["${scope.round}"]`);
  if (scope.industry !== undefined) options.push(`industries: ["${scope.industry}"]`);
  const listenConfig = options.length > 0 ? `{ ${options.join(', ')} }` : '{}';
  return `
import { dealroom, slack } from adapters
import { \`Dev Loop Dealroom\`, \`Dev Loop Slack\` } from credentials

dr   = connect dealroom using \`Dev Loop Dealroom\`
chat = connect slack using \`Dev Loop Slack\`

function dealroom_round_intake(round: <dr-[:\`Funding Round\`]->>) {
  round-[co:\`Company\`]-> {
    backers = Text.join(round-[ri:\`Investors\` ORDER BY ri.\`Name\` ASC]->.\`Name\`, ", ")
    chat-[ch:Channels WHERE ch.\`Name\` == "dealflow"]-> {
      write ch-[:Messages]-> {
        Message: "Dealroom round: \${co.\`Name\`} raised \${round.\`Round\`} (\${round.\`Amount\`} \${round.\`Currency\`}) from \${backers}"
      }
    }
  }
}

listen to dr ${listenConfig} fire dealroom_round_intake
`;
}

function flagValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'setup';
  if (command !== 'setup') {
    console.error(`Unknown command '${command}'. Use: setup [--round <label>] [--industry <name>]`);
    process.exit(1);
  }
  const roundScope = flagValue(args, 'round');
  const industryScope = flagValue(args, 'industry');

  const seed = await ensureDevLoopTeam();
  await ensureDevLoopSlackCredential(seed.teamId);

  const movement = await saveMovement({
    teamId: seed.teamId,
    source: dealroomFile({
      ...(roundScope !== undefined ? { round: roundScope } : {}),
      ...(industryScope !== undefined ? { industry: industryScope } : {}),
    }),
  });

  // Surface the dealroom trigger the listen reconciler derived — its id is what
  // `dev:inject dealroom` fires the poll against, and its `poll_checkpoint` is
  // what "the first poll emits nothing" means concretely.
  const triggers = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', seed.teamId as TeamId)
    .where('kind', '=', 'dealroom')
    .where('movement_id', 'is not', null)
    .select([
      'id',
      'kind',
      'run_mode',
      'config',
      'credentials_id',
      'poll_last_at',
      'poll_checkpoint',
      'fired_movement_name',
    ])
    .execute();

  console.log(
    JSON.stringify(
      {
        ok: movement.ok,
        teamId: seed.teamId,
        movement: movement.ok
          ? {
              name: movement.movementName,
              listeners: movement.listeners.map((l) => ({
                triggerId: l.triggerId,
                kind: l.kind,
                fires: l.movementName,
              })),
            }
          : { errors: movement.errors, diagnostics: movement.diagnostics },
        roundScope: roundScope ?? null,
        industryScope: industryScope ?? null,
        triggers,
        nextSteps: [
          'pnpm dev:inject dealroom --round "SERIES A"',
          'pnpm dev:inspect dealroom',
          'pnpm dev:inspect slack',
        ],
      },
      null,
      2,
    ),
  );
  if (!movement.ok) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
