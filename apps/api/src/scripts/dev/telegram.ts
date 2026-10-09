/**
 * Dev-loop provisioning CLI for inbound Telegram (BYO webhook-sync door).
 *
 *   pnpm dev:telegram setup    # idempotent: TELEGRAM + SLACK creds + a
 *                              # movement that EXTRACTS from message text AND
 *                              # attachment files (voice notes transcribe)
 *
 * The proof movement listens to a telegram source (param = the message
 * itself, `<tg-[:`Message`]->>` — the fires edge lands straight on
 * it, rule 1's collapse) and
 * runs an `extract from [m.`Text`, m-[:Attachments]->.`File`]` — so a voice
 * note's TRANSCRIPT flows through the file-text seam into the extraction,
 * and each extracted update lands as a fake-Slack post. Fire and verify with:
 *
 *   pnpm dev:inject telegram --voice          # real OGG/OPUS speech sample
 *   pnpm dev:inspect slack                    # → the spoken words, extracted
 *
 * The subscription row the webhook-sync door needs is ensured by the inject
 * (`ensureTelegramSubscription`); listen reconciliation derives the TELEGRAM
 * trigger row from the movement's `listen` statement.
 *
 * Two more fixtures exercise the unified edge-anchored send (chunk 3):
 *   • `tg_reply` — `write m-[:Replies]->` threads a reply under the inbound
 *     message (chat + reply target from the parent, never a field).
 *   • `tg_dm`    — `write u-[:Messages]->` DMs the linked dev-loop user (their
 *     linked-user id IS the private chat id).
 *
 * See docs/dev-loop.md "Worked example: a Telegram voice note transcribes into a
 * movement".
 */

import './_profile_loader';
// Register the service adapters the API server boots so `saveMovement` runs
// the real provision path (catalog assembly, listener reconciliation).
import '../../services';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import {
  DEV_LOOP_EMAIL,
  ensureCredential,
  ensureDevLoopTelegramCredential,
  ensureDevLoopTeam,
} from './_lib';
import { saveMovement } from '../../services/translation_graph/movement/provision';

/**
 * Three SEPARATE programs, not one file with three listens.
 *
 * The checker enforces one listener per (instance, config) identity PER
 * PARSED PROGRAM (`packages/movement-lang/checker/check.ts` —
 * `MOV_LISTEN_DUPLICATE`, unchanged since the listen-derived-triggers design
 * of 2026-06-10): `listen to tg {}` repeated three times in one file collides
 * on identity regardless of which movement each fires, and the Telegram
 * adapter declares no `triggerConfig` vocabulary to differentiate them with.
 * That's a per-file authoring constraint, not a per-team one — dispatch fans
 * out across ALL trigger rows that match an inbound credential
 * (`webhook_sync/handler.ts`'s `candidates` loop is keyed by kind +
 * credentials, not by which movement file created the row), so three
 * independently-saved movements against the SAME `Dev Loop Telegram`
 * credential all fire off one inbound event, exactly like three listens in
 * one file would if the checker allowed it. Each `saveMovement` upserts by
 * the program's first declared movement name, so re-running `setup` stays
 * idempotent per movement.
 */
const TELEGRAM_VOICE_MOVEMENT = `
import { telegram, slack } from adapters
import { \`Dev Loop Telegram\`, \`Dev Loop Slack\` } from credentials

tg   = telegram(credentials: \`Dev Loop Telegram\`)
chat = slack(credentials: \`Dev Loop Slack\`)

movement telegram_voice_intake(m: <tg-[:\`Message\`]->>) {
  extracted = extract from [m.\`Text\`, m-[:Attachments]->.\`File\`] {
    node update: "Each distinct update, report, or request in this message — including anything SPOKEN in an attached voice note or audio file (the audio's transcript is part of the source text)." {
      summary: "a one-sentence summary of the update in the sender's own words"
    }
  }
  extracted-[u:update]-> {
    chat-[ch:Channels WHERE \`Name\` == "dealflow"]-> {
      write ch-[:Messages]-> {
        Message: "Telegram update: \${u.summary}"
      }
    }
  }
}

listen to tg {} fire telegram_voice_intake
`;

/** `write m-[:Replies]->` threads a reply under the inbound message (chat +
 *  reply target from the parent, never a field). */
const TELEGRAM_REPLY_MOVEMENT = `
import { telegram } from adapters
import { \`Dev Loop Telegram\` } from credentials

tg = telegram(credentials: \`Dev Loop Telegram\`)

movement tg_reply(m: <tg-[:\`Message\`]->>) {
  write m-[:Replies]-> {
    Text: "Noted: \${m.\`Text\`}"
  }
}

listen to tg {} fire tg_reply
`;

/** `write u-[:Messages]->` DMs the linked dev-loop user (their linked-user id
 *  IS the private chat id). */
const TELEGRAM_DM_MOVEMENT = `
import { telegram } from adapters
import { \`Dev Loop Telegram\` } from credentials

tg = telegram(credentials: \`Dev Loop Telegram\`)

movement tg_dm(m: <tg-[:\`Message\`]->>) {
  tg-[u:\`Linked Users\` WHERE \`Email\` == "${DEV_LOOP_EMAIL}"]-> {
    write u-[:Messages]-> {
      Text: "DM for \${u.\`Email\`}: saw \\"\${m.\`Text\`}\\""
    }
  }
}

listen to tg {} fire tg_dm
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'setup';
  if (command !== 'setup') {
    console.error(`Unknown command '${command}'. Use: setup`);
    process.exit(1);
  }

  const seed = await ensureDevLoopTeam();
  await ensureDevLoopTelegramCredential(seed.teamId);
  await ensureCredential({
    teamId: seed.teamId,
    type: ExternalServiceType.SLACK,
    name: 'Dev Loop Slack',
    secret: { accessToken: 'dev-loop-slack-token' },
  });

  const programs = [
    { source: TELEGRAM_VOICE_MOVEMENT },
    { source: TELEGRAM_REPLY_MOVEMENT },
    { source: TELEGRAM_DM_MOVEMENT },
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
          'pnpm dev:inject telegram --voice',
          'pnpm dev:inspect slack',
          'pnpm dev:inject telegram --text "e2e: unify"',
          'pnpm dev:inspect telegram',
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
