/**
 * Dev-loop provisioning CLI for the Granola POLL source.
 *
 *   pnpm dev:granola setup
 *
 * Granola is a POLLED source (no inbound webhook): the `poll_source` worker scans
 * `automations.trigger` rows of kind `granola`, pulls notes from the Granola client,
 * and dispatches each through the one event pipeline. To exercise that in the dev
 * loop you need, for the dev-loop team:
 *
 *   1. a GRANOLA credential (a stub API key — `injectFakeBaseUrl` points the
 *      client at the fake Granola API in fake-channels for the test-harness team),
 *   2. a SLACK credential (the movement's observable write target), and
 *   3. a movement that `listen`s to a `granola()` source and reads `note.`Title``
 *      (the field whose runtime resolution the just-shipped seam fix exercises),
 *      writing each note to the fake Slack `dealflow` channel.
 *
 * `setup` creates all three, idempotently. Saving the movement runs the REAL
 * provision path, which derives a `granola`-kind trigger row (poll_last_at NULL →
 * immediately due). Then fire a note with:
 *
 *   pnpm dev:inject granola --title "Series A sync" --owner priya@fund.com
 *
 * which seeds the note into the fake Granola API and fires the poll IN-PROCESS for
 * the granola trigger, so the seeded note flows through the real
 * getEvents → discriminate → seed → movement run path. Verify with
 * `pnpm dev:inspect slack` (the message contains the Title) and
 * `pnpm dev:inspect granola` (the trigger's poll checkpoint).
 *
 * See docs/dev-loop.md "Worked example: a polled Granola note runs a movement".
 */

import './_profile_loader';
// Register the service adapters the API server boots so `saveMovement` runs the
// real provision path (catalog assembly, listener reconciliation).
import '../../services';

import { randomUUID } from 'node:crypto';

import { getQb, getAutomationsQb } from '../../lib/kysely';
import { encryptToken } from '../../lib/credentials';
import { defaultAppIdForType } from '../../services/credentials/app_id';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { ensureDevLoopTeam } from './_lib';
import { saveMovement } from '../../services/translation_graph/movement/provision';

/**
 * The proof movement: listens to a `granola()` source and writes each polled
 * note to the fake Slack `dealflow` channel. It reads `note.`Title`` (and the
 * owner email) — the field read whose runtime resolution drifted before the seam
 * fix ("'Title' is not a known field of 'granola:note'") — plus traverses the
 * `Attendees` edge (which went through the same drift path) and writes each
 * attendee. A run is observable via `pnpm dev:inspect slack`.
 */
const GRANOLA_MOVEMENT = `
import { granola, slack } from adapters
import { \`Dev Loop Granola\`, \`Dev Loop Slack\` } from credentials

gr   = granola(credentials: \`Dev Loop Granola\`)
chat = slack(credentials: \`Dev Loop Slack\`)

movement granola_intake(note: <gr-[:\`Meeting Note\`]->>) {
  chat-[ch:Channels WHERE \`Name\` == "dealflow"]-> {
    write ch-[:Messages]-> {
      Message: "Granola note: \${note.\`Title\`} — owner \${note.\`Note Owner Email\`}"
    }
  }
  note-[a:Attendees]-> {
    chat-[ch2:Channels WHERE \`Name\` == "dealflow"]-> {
      write ch2-[:Messages]-> {
        Message: "Attendee on \${note.\`Title\`}: \${a.\`Email\`}"
      }
    }
  }
}

listen to gr {} fire granola_intake
`;

/** Idempotent mock credential of a given type/name (any token works — the
 *  fake-channels base-url injection keys off credential TYPE + test-harness
 *  team). Mirrors the helpers in dev:airtable / dev:whatsapp. */
async function ensureCredential(input: {
  teamId: string;
  type: ExternalServiceType;
  name: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const existing = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', input.teamId as TeamId)
    .where('type', '=', input.type)
    .where('name', '=', input.name)
    .select('id')
    .executeTakeFirst();
  if (existing) return;
  const credId = randomUUID() as ExternalServiceCredentialsId;
  const encrypted = await encryptToken(JSON.stringify(input.payload), credId);
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({
      id: credId,
      name: input.name,
      type: input.type,
      credentials: encrypted,
      team_id: input.teamId,
      // Slack is two apps and a NULL app_id reads as the LEGACY one, which the
      // authoring surface hides — so omitting this mints a credential the
      // checker can't see. undefined for every other type.
      app_id: defaultAppIdForType(input.type),
    } as never)
    .execute();
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'setup';
  if (command !== 'setup') {
    console.error(`Unknown command '${command}'. Use: setup`);
    process.exit(1);
  }

  const seed = await ensureDevLoopTeam();
  await ensureCredential({
    teamId: seed.teamId,
    type: ExternalServiceType.GRANOLA,
    name: 'Dev Loop Granola',
    payload: { apiKey: 'dev-loop-granola-token' },
  });
  await ensureCredential({
    teamId: seed.teamId,
    type: ExternalServiceType.SLACK,
    name: 'Dev Loop Slack',
    payload: { accessToken: 'dev-loop-slack-token' },
  });

  const movement = await saveMovement({ teamId: seed.teamId, source: GRANOLA_MOVEMENT });

  // Surface the granola trigger the listen reconciler derived (its id is what
  // `dev:inject granola` fires the poll against).
  const trigger = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', seed.teamId as TeamId)
    .where('kind', '=', 'granola')
    .where('movement_id', 'is not', null)
    .select(['id', 'kind', 'run_mode', 'credentials_id', 'poll_last_at', 'fired_movement_name'])
    .executeTakeFirst();

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
        trigger: trigger ?? null,
        nextSteps: [
          `pnpm dev:inject granola --title "Series A sync" --owner priya@fund.com --attendee ceo@acme.com`,
          'pnpm dev:inspect slack',
          'pnpm dev:inspect granola',
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
