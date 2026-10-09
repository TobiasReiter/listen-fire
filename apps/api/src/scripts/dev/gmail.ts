/**
 * Dev-loop provisioning CLI for the Gmail POLL source and the two writes.
 *
 *   pnpm dev:gmail setup [--query "from:acme.com"] [--write send|reply]
 *                        [--method oauth|delegated]
 *
 * `--method` re-seeds the mailbox credential in that shape: `oauth` runs a real
 * sign-in against the fake Google (code exchange, granted scopes, refresh
 * token), `delegated` stores the address alone. Omitted, the stack's own
 * `GMAIL_CONNECT_METHOD` decides — which defaults to `oauth`.
 *
 * Gmail is polled rather than pushed (a minute of delay buys away the Pub/Sub
 * topic, the push endpoint and the weekly watch renewal), so
 * event production is the poll-source worker: it scans `automations.trigger`
 * rows of kind `gmail`, asks Gmail what has arrived since the persisted change
 * marker, and dispatches each message through the one event pipeline.
 * Exercising that in the dev loop needs, for the dev-loop team:
 *
 *   1. a GOOGLE_GMAIL credential carrying the mailbox address and the delegated
 *      `app_id` — `ensureDevLoopTeam()` seeds it as 'Dev Loop Gmail', and
 *      `injectFakeBaseUrl` points the client at the fake Gmail in fake-channels,
 *   2. a SLACK credential (the movement's observable write target), and
 *   3. one file carrying the listener on the `Message` fires edge, whose body
 *      writes ONE line naming the sender and the subject to the fake Slack
 *      `dealflow` channel.
 *
 * `setup` creates all three, idempotently. Saving the file runs the REAL
 * provision path, which derives the `gmail`-kind trigger row (poll_last_at NULL
 * → immediately due) with its own poll checkpoint. Then:
 *
 *   pnpm dev:inject gmail-message --subject "Q3 figures" --from ops@northwind.example
 *   pnpm dev:inspect gmail
 *   pnpm dev:inspect slack
 *
 * The inject drops a message into the fake mailbox and fires the poll
 * IN-PROCESS, so it flows through the real getEvents → discriminate → seed →
 * run path. `--query` on SETUP narrows the listen, so an inject that does not
 * match must produce nothing.
 *
 * `--write send` and `--write reply` swap the movement's body for the two write
 * shapes, whose evidence is the fake mailbox's OUTBOX rather than Slack:
 *
 *   pnpm dev:gmail setup --write reply
 *   pnpm dev:inject gmail-message --subject "Q3 figures" --from ops@northwind.example
 *   pnpm dev:inspect gmail        # outbox[0].inReplyTo + threadId == the incoming one
 */

import './_profile_loader';
// Register the service adapters the API server boots so `saveMovement` runs the
// real provision path (catalog assembly, listener reconciliation).
import '../../services';
import { getAutomationsQb } from '../../lib/kysely';

import type { TeamId } from '../../generated/kysely/core/Team';

import {
  ensureDevLoopGmailCredential,
  ensureDevLoopSlackCredential,
  ensureDevLoopTeam,
} from './_lib';
import {
  GMAIL_CONNECT_METHODS,
  gmailConnectMethod,
  type GmailConnectMethod,
} from '../../adapters/gmail/connect_method';
import { saveMovement } from '../../services/translation_graph/movement/provision';

/** What the provisioned movement DOES with a delivered message. */
type WriteMode = 'slack' | 'send' | 'reply';

/** Where a `--write send` proof addresses its mail. Synthetic, and never a real
 *  domain — the fake mailbox is the only thing that ever sees it. */
const SEND_TARGET = 'ops@northwind.example';

/**
 * The body of the proof movement, per mode.
 *
 *   slack  — the READ proof: the delivered message's fields reach a Slack line,
 *            evidence the whole path ran (poll → discriminate → seed → run →
 *            a write in another system).
 *   send   — a NEW message, written along the mailbox's own `Messages` edge.
 *   reply  — a reply, written along the DELIVERED message's `Replies` edge. It
 *            names nothing about where it goes: the thread, the `Re:` subject
 *            and the reply headers all come off that parent.
 */
function movementBody(mode: WriteMode): string {
  if (mode === 'send') {
    return `  write mail-[:Messages]-> {
    To: ["${SEND_TARGET}"]
    Subject: "Received: \${msg.\`Subject\`}"
    Body: "Thanks — we have your note. You wrote: \${msg.\`Body\`}"
  }`;
  }
  if (mode === 'reply') {
    return `  write msg-[:Replies]-> {
    Body: "Thanks — got it, looking now."
  }`;
  }
  return `  chat-[ch:Channels WHERE \`Name\` == "dealflow"]-> {
    write ch-[:Messages]-> {
      Message: "Gmail: \${msg.\`Subject\`} from \${msg.\`From\`} — \${msg.\`Body\`}"
    }
  }`;
}

function gmailFile(scope: { query?: string; mode: WriteMode }): string {
  const listenConfig = scope.query !== undefined ? `{ query: "${scope.query}" }` : '{}';
  return `
import { gmail, slack } from adapters
import { \`Dev Loop Gmail\`, \`Dev Loop Slack\` } from credentials

mail = gmail(credentials: \`Dev Loop Gmail\`)
chat = slack(credentials: \`Dev Loop Slack\`)

movement gmail_message_intake(msg: <mail-[:\`Message\`]->>) {
${movementBody(scope.mode)}
}

listen to mail ${listenConfig} fire gmail_message_intake
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
    console.error(
      `Unknown command '${command}'. Use: setup [--query "<gmail search>"] ` +
        `[--write send|reply] [--method ${GMAIL_CONNECT_METHODS.join('|')}]`,
    );
    process.exit(1);
  }
  const query = flagValue(args, 'query');
  const write = flagValue(args, 'write') ?? 'slack';
  if (write !== 'slack' && write !== 'send' && write !== 'reply') {
    console.error(`Unknown --write '${write}'. Use: slack (default), send, or reply.`);
    process.exit(1);
  }
  const mode: WriteMode = write;

  const requested = flagValue(args, 'method');
  if (requested !== undefined && !GMAIL_CONNECT_METHODS.some((m) => m === requested)) {
    console.error(
      `Unknown --method '${requested}'. Use: ${GMAIL_CONNECT_METHODS.join(' or ')}.`,
    );
    process.exit(1);
  }
  const method: GmailConnectMethod =
    requested === 'oauth' || requested === 'delegated' ? requested : gmailConnectMethod();

  const seed = await ensureDevLoopTeam();
  await ensureDevLoopSlackCredential(seed.teamId);
  // Re-seed unconditionally: `--method` is how a stack is switched between the
  // two credential shapes, and an idempotent skip would silently keep the old
  // one.
  await ensureDevLoopGmailCredential({
    teamId: seed.teamId as TeamId,
    method,
    replace: true,
  });

  const movement = await saveMovement({
    teamId: seed.teamId,
    source: gmailFile({ ...(query !== undefined ? { query } : {}), mode }),
  });

  // Surface the gmail trigger the listen reconciler derived — its id is what
  // `dev:inject gmail-message` fires the poll against, and its `poll_checkpoint`
  // is what "the first poll emits nothing" means concretely.
  const triggers = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', seed.teamId as TeamId)
    .where('kind', '=', 'gmail')
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
        query: query ?? null,
        write: mode,
        connectMethod: method,
        triggers,
        nextSteps: [
          'pnpm dev:inject gmail-message --subject "Q3 figures" --from ops@northwind.example',
          'pnpm dev:inspect gmail',
          mode === 'slack' ? 'pnpm dev:inspect slack' : 'read `outbox` in dev:inspect gmail',
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
