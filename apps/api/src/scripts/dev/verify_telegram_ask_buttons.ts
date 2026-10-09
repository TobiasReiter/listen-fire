/**
 * One-off verification provisioner for the Telegram ask-button round-trip
 * (b416d63a8 / 8b5819e02 / 60a3c38ed). Not part of the standing dev-loop
 * tooling — mints its own movement against the shared `Dev Loop Telegram`
 * credential.
 *
 * The in-chat `callback_data` tap it used to provision carried the ask's
 * `Token`, retired with callback-primitive layer 3; the keyboard is the `url`
 * form until layer 4 re-points the tap at a callback id.
 */
import './_profile_loader';
import '../../services';
import { ensureDevLoopTeam } from './_lib';
import { getAutomationsQb } from '../../lib/kysely';
import { encryptToken } from '../../lib/credentials';
import { defaultAppIdForType } from '../../services/credentials/app_id';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';

import { randomUUID } from 'node:crypto';

import { saveMovement } from '../../services/translation_graph/movement/provision';

async function ensureCredential(input: {
  teamId: string;
  type: ExternalServiceType;
  name: string;
  secret: Record<string, string>;
}): Promise<void> {
  const existing = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', input.teamId as TeamId)
    .where('type', '=', input.type)
    .select('id')
    .executeTakeFirst();
  if (existing) return;
  const credId = randomUUID() as ExternalServiceCredentialsId;
  const encrypted = await encryptToken(JSON.stringify(input.secret), credId);
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({
      id: credId,
      name: input.name,
      type: input.type,
      credentials: encrypted,
      team_id: input.teamId,
      app_id: defaultAppIdForType(input.type),
    } as never)
    .execute();
}

const MOVEMENT = `
import { telegram, ask } from adapters
import { \`Dev Loop Telegram\` } from credentials

tg = telegram(credentials: \`Dev Loop Telegram\`)
questions = ask()

movement tg_ask_buttons(m: <tg-[:\`Message\`]->>) {
  q = write questions-[:Check]-> {
    Prompt: "Send the update?"
    Detail: "\${m.\`Text\`}"
  }

  write m-[:Replies]-> {
    Text: "Send the update? \${q.Url}"
    \`Reply Markup\`: {
      inline_keyboard: [
        [ { text: "Approve", url: "\${q.Url}?answer=true" },
          { text: "Open", url: "\${q.Url}?answer=true" } ]
      ]
    }
  }

  answer = await FIRST(q-[:Response]->)
  if answer.Answer {
    write m-[:Replies]-> { Text: "Approved." }
  }
}

listen to tg {} fire tg_ask_buttons
`;

async function main() {
  const seed = await ensureDevLoopTeam();
  await ensureCredential({
    teamId: seed.teamId,
    type: ExternalServiceType.TELEGRAM,
    name: 'Dev Loop Telegram',
    secret: { botToken: 'dev-loop-telegram-token' },
  });

  const result = await saveMovement({ teamId: seed.teamId, source: MOVEMENT });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
