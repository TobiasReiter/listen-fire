/**
 * Dev-loop provisioning CLI for the Evertrace POLL source.
 *
 *   pnpm dev:evertrace setup
 *
 * Evertrace is a POLLED source (no webhooks — see 0_mission.md "Connection"):
 * the `poll_source` worker scans `automations.trigger` rows of kind
 * `evertrace`, pulls signals from the Evertrace client, and dispatches each
 * through the one event pipeline. To exercise that in the dev loop you need,
 * for the dev-loop team:
 *
 *   1. an EVERTRACE credential (a stub api key — `injectFakeBaseUrl` points
 *      the client at the fake Evertrace API in fake-channels for the
 *      test-harness team),
 *   2. a SLACK credential (the movement's observable write target), and
 *   3. one file carrying BOTH listeners — one on the `Signal` fires edge, one
 *      on the `List Entry` fires edge (`events: ["list_entry"]`) — each writing
 *      a distinguishable line to the fake Slack `dealflow` channel.
 *
 * `setup` creates all three, idempotently. Saving the file runs the REAL
 * provision path, which derives TWO `evertrace`-kind trigger rows (poll_last_at
 * NULL → immediately due), each with its own poll checkpoint. Then fire either
 * kind:
 *
 *   pnpm dev:inject evertrace --first-name Dana --last-name Kaplan --type "New Company" --score 8
 *   pnpm dev:inject evertrace-list-entry --list Pipeline --signal sig_2
 *
 * Each seeds into the fake Evertrace API and fires the poll IN-PROCESS for the
 * evertrace triggers, so the seeded row flows through the real getEvents →
 * discriminate → seed → movement run path — and only the listener whose edge
 * the row belongs to writes. Verify with `pnpm dev:inspect slack` (the message
 * names the signal, and for a list addition the list too) and
 * `pnpm dev:inspect evertrace` (each trigger's poll checkpoint).
 */

import './_profile_loader';
// Register the service adapters the API server boots so `saveMovement` runs the
// real provision path (catalog assembly, listener reconciliation).
import '../../services';

import { randomUUID } from 'node:crypto';

import { getAutomationsQb } from '../../lib/kysely';
import { encryptToken } from '../../lib/credentials';
import { defaultAppIdForType } from '../../services/credentials/app_id';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { ensureDevLoopTeam } from './_lib';
import { saveMovement } from '../../services/translation_graph/movement/provision';

/**
 * The proof file: BOTH of Evertrace's event edges, side by side.
 *
 *   - `evertrace_intake` listens on `Signal` (no `events` — the default) and
 *     writes each newly discovered signal;
 *   - `evertrace_list_intake` listens on `List Entry`
 *     (`events: ["list_entry"]`) and walks the delivered entry to the person
 *     and to the list they were filed on.
 *
 * The two messages are worded differently on purpose: an inject of one kind
 * must produce exactly one of them, which is what proves the one poll source
 * only produces the kind its trigger listens for. Both runs are observable via
 * `pnpm dev:inspect slack`.
 *
 * `\`list\`` is deliberately left off the list listener so `setup` delivers
 * additions to EVERY list; the list-scoped case is exercised by editing the
 * listen (see `setup --list <name>`). `setup --search <title|id>` does the same
 * for the signal listener, which then delivers only what that saved search's
 * own filters match.
 */
function evertraceFile(scope: { list?: string; search?: string } = {}): string {
  const listConfig =
    scope.list !== undefined
      ? `{ events: ["list_entry"], list: "${scope.list}" }`
      : '{ events: ["list_entry"] }';
  const signalConfig = scope.search !== undefined ? `{ search: "${scope.search}" }` : '{}';
  return `
import { evertrace, slack } from adapters
import { \`Dev Loop Evertrace\`, \`Dev Loop Slack\` } from credentials

et   = connect evertrace using \`Dev Loop Evertrace\`
chat = connect slack using \`Dev Loop Slack\`

function evertrace_intake(sig: <et-[:\`Signal\`]->>) {
  chat-[ch:Channels WHERE ch.\`Name\` == "dealflow"]-> {
    write ch-[:Messages]-> {
      Message: "Evertrace signal: \${sig.\`First Name\`} \${sig.\`Last Name\`} (\${sig.\`Score\`})"
    }
  }
}

function evertrace_list_intake(entry: <et-[:\`List Entry\`]->>) {
  entry-[sig:\`Signal\`]-> {
    entry-[lst:\`List\`]-> {
      chat-[ch:Channels WHERE ch.\`Name\` == "dealflow"]-> {
        write ch-[:Messages]-> {
          Message: "Evertrace list addition: \${sig.\`First Name\`} \${sig.\`Last Name\`} onto \${lst.\`Name\`}"
        }
      }
    }
  }
}

listen to et ${signalConfig} fire evertrace_intake
listen to et ${listConfig} fire evertrace_list_intake
`;
}

/** Idempotent mock credential of a given type/name (any token works — the
 *  fake-channels base-url injection keys off credential TYPE + test-harness
 *  team). Mirrors the helper in dev:granola. */
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

function flagValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'setup';
  if (command !== 'setup') {
    console.error(
      `Unknown command '${command}'. Use: setup [--list <name|id>] [--search <title|id>]`,
    );
    process.exit(1);
  }
  // `--list` scopes the list listener to ONE list, so an addition to any other
  // list must not reach it.
  const listScope = flagValue(args, 'list');
  // `--search` scopes the signal listener to ONE saved search, so a signal the
  // search's own filters reject must not reach it.
  const searchScope = flagValue(args, 'search');

  const seed = await ensureDevLoopTeam();
  await ensureCredential({
    teamId: seed.teamId,
    type: ExternalServiceType.EVERTRACE,
    name: 'Dev Loop Evertrace',
    payload: { apiKey: 'dev-loop-evertrace-key' },
  });
  await ensureCredential({
    teamId: seed.teamId,
    type: ExternalServiceType.SLACK,
    name: 'Dev Loop Slack',
    payload: { accessToken: 'dev-loop-slack-token' },
  });

  const movement = await saveMovement({
    teamId: seed.teamId,
    source: evertraceFile({
      ...(listScope !== undefined ? { list: listScope } : {}),
      ...(searchScope !== undefined ? { search: searchScope } : {}),
    }),
  });

  // Surface the evertrace triggers the listen reconciler derived (their ids are
  // what `dev:inject evertrace` / `dev:inject evertrace-list-entry` fire the
  // poll against) — one per listen, each with its own checkpoint.
  const triggers = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', seed.teamId as TeamId)
    .where('kind', '=', 'evertrace')
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
        listScope: listScope ?? null,
        searchScope: searchScope ?? null,
        triggers,
        nextSteps: [
          `pnpm dev:inject evertrace --first-name Dana --last-name Kaplan --type "New Company" --score 8`,
          'pnpm dev:inject evertrace-list-entry --list Pipeline --signal sig_2',
          'pnpm dev:inspect slack',
          'pnpm dev:inspect evertrace',
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
