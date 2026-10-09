/**
 * Dev-loop provisioning CLI for inbound Airtable webhook triggers.
 *
 *   pnpm dev:airtable setup [--base <id>] [--table <id>] [--reprovision]
 *
 * `--reprovision` drops the AIRTABLE webhook_subscription rows first, so the
 * save re-registers the webhook against fake-channels. Reach for it when
 * `dev:inject airtable-webhook` says "Webhook not found" — the fake's store was
 * wiped while Postgres kept the row, and the reconciler no-ops on an unchanged
 * event set, so nothing else heals the split.
 *
 * Idempotently wires everything an Airtable-sourced movement needs for the
 * dev-loop team:
 *
 *   1. mock AIRTABLE + SLACK credentials (the first comes from `dev:seed`; this
 *      ensures both so `setup` works standalone),
 *   2. a base + table seeded into fake-channels (so the movement's
 *      `<at-[:\`Deals\`]->>` type resolves at author time), and
 *   3. a movement that `listen`s to that (base, table) for `record.created`
 *      ONLY and writes each new record to the fake Slack `dealflow` channel,
 *      PLUS its positioned twin (`airtable_intake_positioned`): the instance
 *      constructed AT the base (`base: "Dev Base"`), a table-only listen and a
 *      table-only signature — the position supplies the base hop. Both
 *      listens resolve to ONE subscription channel (channel identity is the
 *      RESOLVED address), so a single inject fires BOTH movements: two Slack
 *      messages, "Airtable record created: …" and "Positioned intake: …".
 *
 * Saving the movement runs the REAL listen-reconciliation path
 * (`syncListenSubscriptions` → `ensureEventSubscription` → `createWebhook`
 * against fake-channels), so a `webhook_subscription` row (provider `AIRTABLE`,
 * scope `{ base, table }`, the fake's `macSecretBase64`) is created as a side
 * effect — exactly as production would.
 *
 * Then fire a record change with:
 *
 *   pnpm dev:inject airtable-webhook --event create --record rec1 --values '{"Name":"Acme"}'
 *
 * and verify with `pnpm dev:inspect slack` / `pnpm dev:inspect airtable` +
 * `tail -F .dev-loop/loop.log`. An `--event update` proves selection holds:
 * the webhook only subscribed to creates, so the change is never queued and no
 * movement runs. See docs/dev-loop.md "dev:inject airtable-webhook".
 */

import './_profile_loader';
// Register the service adapters the API server boots so `saveMovement` runs the
// real provision path (catalog assembly, listen-subscription reconciliation).
import '../../services';

import { randomUUID } from 'node:crypto';

import { getAutomationsQb } from '../../lib/kysely';
import { encryptToken } from '../../lib/credentials';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { ensureDevLoopTeam, ensureDevLoopSlackCredential } from './_lib';
import { saveMovement } from '../../services/translation_graph/movement/provision';

const FAKE_CHANNELS_URL = process.env.FAKE_CHANNELS_URL || 'http://localhost:5556';

/** The base + table the dev-loop Airtable listener watches. These ids are what
 *  `dev:inject airtable-webhook` defaults to (`--base` / `--table` override). */
export const DEV_AIRTABLE_BASE_ID = 'appDevLoop';
export const DEV_AIRTABLE_BASE_NAME = 'Dev Base';
export const DEV_AIRTABLE_TABLE_ID = 'tblDeals';
export const DEV_AIRTABLE_TABLE_NAME = 'Deals';

/** The proof movement: listens to the seeded (base, table) for record creates
 *  ONLY and writes each new record to the fake Slack `dealflow` channel (so a
 *  run is observable via `pnpm dev:inspect slack`).
 *
 *  THE EVENT AND THE ROW ARE DIFFERENT NODES — and THE EVENT IS JUST A NODE:
 *  the parameter is `Record Change`, an occurrence, its change kind the node's
 *  own `action` field pinned in the address (`Record Created` was only ever a
 *  nominal name for `` Record Change WHERE `action` == "record.created" ``).
 *  The row that changed hangs off the event's `record` edge. This adapter used
 *  to seed the row AS the event, which is why a movement could declare
 *  `<at-[:`Deals`]->>` with nothing to check it against.
 *
 *  NO `base:`. The event is an edge off the META node and lives behind no
 *  container: a listen HANDS you the event position, so naming it must not
 *  require having walked to a base. Positioning the instance was only ever
 *  needed to name a TABLE, and this movement never names one.
 *
 *  THE SIGNATURE NAMES THE FULL ADDRESS. A type annotation IS an address, so
 *  the parameter says which event, in which base, in which table — and the
 *  listen must produce one that satisfies it. That is not a restatement of the
 *  listen: it is PARAMETER vs ARGUMENT. `f(x: int)` and `f(3)` both "say int",
 *  and nobody calls that duplication — it is what type checking IS. Point the
 *  listen at another table and this stops compiling, which is the whole reason
 *  the address exists: two listens narrowing differently used to be SILENT.
 *
 *  plans/2026-07-10-adapter-entry-positions/8_event_edges.md */
const AIRTABLE_MOVEMENT = `
import { airtable, slack } from adapters
import { \`Dev Loop Airtable\`, \`Dev Loop Slack\` } from credentials

at   = airtable(credentials: \`Dev Loop Airtable\`)
chat = slack(credentials: \`Dev Loop Slack\`)

movement airtable_intake(e: <at-[:\`Record Change\`
      WHERE \`action\` == "record.created" AND \`base\` == "${DEV_AIRTABLE_BASE_ID}" AND \`table\` == "${DEV_AIRTABLE_TABLE_ID}"]->>) {
  e-[r:Record]-> {
    chat-[ch:Channels WHERE \`Name\` == "dealflow"]-> {
      write ch-[:Messages]-> {
        Message: "Airtable record created: \${r.\`Name\`} (stage \${r.\`Stage\`})"
      }
    }
  }
}

listen to at { base: "${DEV_AIRTABLE_BASE_ID}", table: "${DEV_AIRTABLE_TABLE_ID}", events: ["record.created"] } fire airtable_intake
`;

/** The POSITIONED twin, a separate movement file. EVENT EDGES HANG OFF
 *  POSITIONS: the instance starts AT the base (`base: "Dev Base"` — by NAME),
 *  so the base hop of the listen's address comes from the position and the
 *  listen names ONLY the table. The signature is likewise table-only — a
 *  COMPLETE address relative to the position.
 *
 *  CHANNEL IDENTITY IS THE RESOLVED ADDRESS: provisioning resolves
 *  position+config → { base: appDevLoop, table: tblDeals } (persisted on the
 *  trigger as `resolved_address`), which keys the SAME subscription channel as
 *  the unpositioned movement's full-config listen — one webhook, both
 *  movements fire on an inject.
 *
 *  plans/2026-07-10-adapter-entry-positions/8_event_edges.md */
const AIRTABLE_POSITIONED_MOVEMENT = `
import { airtable, slack } from adapters
import { \`Dev Loop Airtable\`, \`Dev Loop Slack\` } from credentials

at   = airtable(credentials: \`Dev Loop Airtable\`, base: "${DEV_AIRTABLE_BASE_NAME}")
chat = slack(credentials: \`Dev Loop Slack\`)

movement airtable_intake_positioned(e: <at-[:\`Record Change\`
      WHERE \`action\` == "record.created" AND \`table\` == "${DEV_AIRTABLE_TABLE_ID}"]->>) {
  e-[r:Record]-> {
    chat-[ch:Channels WHERE \`Name\` == "dealflow"]-> {
      write ch-[:Messages]-> {
        Message: "Positioned intake: \${r.\`Name\`} (stage \${r.\`Stage\`})"
      }
    }
  }
}

listen to at { table: "${DEV_AIRTABLE_TABLE_ID}", events: ["record.created"] } fire airtable_intake_positioned
`;


/** Seed a base + table into fake-channels so `listEntryPoints` resolves the
 *  movement's `<at-[:\`Deals\`]->>` type. Idempotent — the admin seed
 *  route upserts by (service, entity_type, id). */
async function seedFakeBaseAndTable(input: { baseId: string; tableId: string }): Promise<void> {
  const entities = [
    {
      entity_type: 'base',
      id: input.baseId,
      data: { id: input.baseId, name: DEV_AIRTABLE_BASE_NAME },
    },
    {
      entity_type: `table:${input.baseId}`,
      id: input.tableId,
      data: {
        id: input.tableId,
        name: DEV_AIRTABLE_TABLE_NAME,
        primaryFieldId: 'fldName',
        fields: [
          { id: 'fldName', name: 'Name', type: 'singleLineText' },
          { id: 'fldStage', name: 'Stage', type: 'singleLineText' },
        ],
      },
    },
  ];
  const res = await fetch(`${FAKE_CHANNELS_URL}/admin/airtable/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entities }),
  });
  if (!res.ok) {
    throw new Error(`fake-channels airtable seed failed: ${res.status} ${await res.text()}`);
  }
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Drop the team's AIRTABLE `webhook_subscription` rows so the next save
 * re-registers the webhook against fake-channels.
 *
 * The dev loop keeps this state in TWO stores that can be wiped independently:
 * the subscription row lives in Postgres, the `ach…` webhook it points at lives
 * in fake-channels. Reset the fake (`dev:inspect --reset`) and they diverge —
 * and the reconciler cannot heal it, because `ensureEventSubscription` no-ops
 * when the row already names an externalId with an unchanged event set. So the
 * webhook stays gone, `dev:inject airtable-webhook` reports "Webhook not found"
 * with `eventsProcessed: 0`, and the refresh worker spins on a 404 forever.
 *
 * Dropping the row is what makes the next `setup` re-create the webhook.
 */
async function dropSubscriptions(teamId: TeamId): Promise<number> {
  const res = await getAutomationsQb(['webhook_subscription'])
    .deleteFrom('webhook_subscription')
    .where('team_id', '=', teamId)
    .where('provider', '=', 'AIRTABLE')
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'setup';
  if (command !== 'setup') {
    console.error(`Unknown command '${command}'. Use: setup [--reprovision]`);
    process.exit(1);
  }

  const seed = await ensureDevLoopTeam();
  await ensureDevLoopSlackCredential(seed.teamId);

  const baseId = argValue(args, '--base') ?? DEV_AIRTABLE_BASE_ID;
  const tableId = argValue(args, '--table') ?? DEV_AIRTABLE_TABLE_ID;
  await seedFakeBaseAndTable({ baseId, tableId });

  const reprovisioned =
    args.includes('--reprovision') ? await dropSubscriptions(seed.teamId as TeamId) : 0;

  const movement = await saveMovement({ teamId: seed.teamId, source: AIRTABLE_MOVEMENT });

  // The positioned twin — same table, addressed relative to the instance's
  // POSITION. Its resolved address keys the SAME subscription channel, so no
  // second webhook is registered and one inject fires BOTH movements.
  const positioned = await saveMovement({
    teamId: seed.teamId,
    source: AIRTABLE_POSITIONED_MOVEMENT,
  });

  // Surface the webhook_subscription the listen reconciler provisioned (its id
  // keys the inbound callback URL; the external_webhook_id is the fake's
  // `ach…` webhook the payload feed lives under). Both movements' listens
  // resolve to ONE channel, so this stays a single row.
  const sub = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('team_id', '=', seed.teamId as TeamId)
    .where('provider', '=', 'AIRTABLE')
    .where('deleted_at', 'is', null)
    .select(['id', 'external_webhook_id', 'status', 'scope', 'subscriptions'])
    .executeTakeFirst();

  console.log(
    JSON.stringify(
      {
        ok: movement.ok,
        teamId: seed.teamId,
        base: baseId,
        table: tableId,
        ...(reprovisioned > 0 ? { reprovisioned } : {}),
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
        positioned: positioned.ok
          ? {
              name: positioned.movementName,
              listeners: positioned.listeners.map((l) => ({
                triggerId: l.triggerId,
                kind: l.kind,
                fires: l.movementName,
              })),
            }
          : { errors: positioned.errors, diagnostics: positioned.diagnostics },
        subscription: sub ?? null,
        nextSteps: [
          `pnpm dev:inject airtable-webhook --event create --record rec1 --values '{"Name":"Acme","Stage":"Seed"}'`,
          'pnpm dev:inspect slack',
          `pnpm dev:inject airtable-webhook --event update --record rec1   # proves selection: should NOT run`,
        ],
      },
      null,
      2,
    ),
  );
  if (!movement.ok || !positioned.ok) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
