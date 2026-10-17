/**
 * Dev-loop provisioning CLI for inbound WhatsApp (Meta Cloud API).
 *
 *   pnpm dev:whatsapp setup [--phone <e164>]   # idempotent: phone_number row
 *                                              # + a whatsapp movement trigger
 *
 * The WhatsApp dumb dispatcher (services/whatsapp/dispatch.ts) routes an
 * inbound message by SENDER PHONE → that phone's team, then to a movement
 * trigger of kind whatsapp (preferred) or a legacy pipeline_input. To exercise
 * it in the dev loop you need two things wired for the dev-loop team:
 *
 *   1. a `phone_number` row mapping the sender phone → the dev-loop user, and
 *   2. a movement that `listen`s to a `whatsapp()` source (which derives the
 *      trigger row dispatch looks up).
 *
 * `setup` creates both, idempotently. Then fire a message with:
 *
 *   pnpm dev:inject whatsapp --from <phone> --text "hi"
 *   pnpm dev:inject whatsapp --from <phone> --media           # image
 *   pnpm dev:inject whatsapp --from <phone> --media --media-type document
 *
 * and verify with `pnpm dev:inspect whatsapp` (fake outbox, seeded media,
 * recent exposed-file blob URLs) + `tail -F .dev-loop/loop.log`.
 *
 * The provisioned fixture carries TWO movements over the one `whatsapp()`
 * source: `whatsapp_intake` mirrors the message into Slack, and `wa_reply`
 * exercises the unified write-back surface — a reaction, the ephemeral typing
 * action (`write m-[:Typing]-> {}`), and a threaded reply (recipient derived
 * from the inbound message, never a `To` field). They're provisioned as two
 * separate programs (mirrors telegram.ts) — the checker's MOV_LISTEN_DUPLICATE
 * rule keys off `instance::config` only, not the fired movement, so two
 * `listen to wa {}` statements in the SAME file collide even though they fire
 * different movements.
 *
 * See docs/dev-loop.md "Worked example: inbound WhatsApp media".
 */

import './_profile_loader';
// Register the service adapters the API server boots so `saveMovement` runs the
// real provision path (catalog assembly, listener reconciliation).
import '../../services';

import { randomUUID } from 'node:crypto';

import { getAutomationsQb } from '../../lib/kysely';
import { encryptToken } from '../../lib/credentials';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { ensureDevLoopTeam, ensureDevLoopSlackCredential } from './_lib';
import { saveMovement } from '../../services/translation_graph/movement/provision';

/** Default sender phone the dispatcher resolves to the dev-loop user. Match
 *  this with `dev:inject whatsapp --from`. Override with `--phone`. */
const DEFAULT_SENDER_PHONE = '+15551234567';

/**
 * The proof movements over a credential-free `whatsapp()` source:
 *   • `whatsapp_intake` mirrors each inbound message into a Slack post (the
 *     dev-loop fake) — proves the message reached a movement trigger; the
 *     media bytes are proven separately via the exposed-file blob URL.
 *   • `wa_reply` exercises the UNIFIED write surface back to WhatsApp — a
 *     reaction (`msg-[:Reactions]->`), the ephemeral typing action
 *     (`msg-[:Typing]-> {}`, no fields), and a threaded reply
 *     (`msg-[:Replies]->`, the recipient derived from the inbound message).
 *     The `(send)` sentinels are gone.
 */
const WHATSAPP_INTAKE_MOVEMENT = `
import { whatsapp, slack } from adapters
import { \`Dev Loop Slack\` } from credentials

wa   = connect whatsapp
chat = connect slack using \`Dev Loop Slack\`

function whatsapp_intake(m: <wa-[:\`Message\`]->>) {
  chat-[ch:Channels WHERE ch.\`Name\` == "dealflow"]-> {
    write ch-[:Messages]-> {
      Message: "WhatsApp from \${m.\`From\`}: \${m.\`Body\`}"
    }
  }
}

listen to wa {} fire whatsapp_intake
`;

const WHATSAPP_REPLY_MOVEMENT = `
import { whatsapp } from adapters

wa = connect whatsapp

function wa_reply(m: <wa-[:\`Message\`]->>) {
  write m-[:Reactions]-> { Emoji: "👍" }
  write m-[:Typing]-> {}
  write m-[:Replies]-> { Body: "Noted: \${m.\`Body\`}" }
}

listen to wa {} fire wa_reply
`;


/** Idempotently map `phone` → the dev-loop user so `resolveSenderTeam` finds a
 *  team for the inbound sender. */
async function ensurePhoneNumber(input: { phone: string; userId: string }): Promise<boolean> {
  const existing = await getAutomationsQb(['phone_number'])
    .selectFrom('phone_number')
    .where('phone_number', '=', input.phone)
    .select(['id', 'user_id'])
    .executeTakeFirst();
  if (existing) {
    // Re-point at the dev-loop user if a stale row claims this number, and stamp
    // it verified — inbound routing now ignores unverified links.
    if (existing.user_id !== (input.userId as UserId)) {
      await getAutomationsQb(['phone_number'])
        .updateTable('phone_number')
        .set({ user_id: input.userId as UserId, verified_at: new Date() })
        .where('id', '=', existing.id)
        .execute();
    }
    return false;
  }
  await getAutomationsQb(['phone_number'])
    .insertInto('phone_number')
    .values({
      id: randomUUID() as never,
      user_id: input.userId as UserId,
      phone_number: input.phone,
      is_test_number: true,
      name: 'Dev Loop WhatsApp Sender',
      verified_at: new Date(),
    } as never)
    .execute();
  return true;
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'setup';
  if (command !== 'setup') {
    console.error(`Unknown command '${command}'. Use: setup`);
    process.exit(1);
  }

  const seed = await ensureDevLoopTeam();
  await ensureDevLoopSlackCredential(seed.teamId);

  const phone = argValue(args, '--phone') ?? DEFAULT_SENDER_PHONE;
  const phoneCreated = await ensurePhoneNumber({ phone, userId: seed.userId });

  const programs = [
    { source: WHATSAPP_INTAKE_MOVEMENT },
    { source: WHATSAPP_REPLY_MOVEMENT },
  ];
  const movements = [];
  for (const program of programs) {
    movements.push(await saveMovement({ teamId: seed.teamId, source: program.source }));
  }

  console.log(
    JSON.stringify(
      {
        ok: movements.every((m) => m.ok),
        teamId: seed.teamId,
        senderPhone: phone,
        phoneCreated,
        movements: movements.map((movement) =>
          movement.ok
            ? {
                name: movement.movementName,
                listeners: movement.listeners.map((l) => ({
                  triggerId: l.triggerId,
                  kind: l.kind,
                  fires: l.movementName,
                })),
              }
            : { errors: movement.errors, diagnostics: movement.diagnostics },
        ),
        nextSteps: [
          `pnpm dev:inject whatsapp --from ${phone.replace(/^\+/, '')} --media`,
          'pnpm dev:inspect whatsapp',
        ],
      },
      null,
      2,
    ),
  );
  if (!movements.every((m) => m.ok)) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
