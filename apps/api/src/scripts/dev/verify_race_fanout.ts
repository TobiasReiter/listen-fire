/**
 * One-off provisioner for the runtime-contestant race e2e (layer 13 C3): the
 * CRM's companies become the options of ONE question, and the answer names the
 * winner — raced against a 2d timeout. The winner's name lands in a Telegram
 * reply. Drive it with:
 *
 *   pnpm dev:inject telegram-event --text "go"
 *   # grab the question's Url from the reply (dev:inspect telegram outbox)
 *   pnpm dev:inject telegram-callback --token <ask_…> --answer "<company name>"
 *   # the settled run replies "won=<name>"
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
import { telegram, ask, attio } from adapters
import { \`Dev Loop Telegram\`, \`Dev Loop Attio\` } from credentials

tg = telegram(credentials: \`Dev Loop Telegram\`)
questions = ask()
crm = attio(credentials: \`Dev Loop Attio\`)

movement race_fanout_probe(m: <tg-[:\`Message\`]->>) {
  names = crm-[c:Companies]-> {
    return c.\`Name\`
  }
  q = write questions-[:Choose]-> {
    Prompt: "Which company?"
    Options: names
  }
  write m-[:Replies]-> {
    Text: "pick one of \${COUNT(names)}: \${q.Url}"
  }

  w = race(
    () => {
      a = await FIRST(q-[:Response]->)
      return a.Answer
    },
    () => { await sleep(2d) },
  )

  write m-[:Replies]-> {
    Text: "won=\${COALESCE(AT(w, 0), "timeout")}"
  }
}

listen to tg {} fire race_fanout_probe
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
