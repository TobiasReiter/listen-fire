/**
 * Where the authoring loop's wall clock goes — validate → save, over HTTP,
 * against the running dev-loop stack.
 *
 *   pnpm dev:loop:agent   # then, in another shell
 *   pnpm dev:seed
 *   npx tsx src/scripts/dev/measure_authoring_loop.ts [--runs 3]
 *
 * Every call is a real request to the mounted REST surface (the path an MCP
 * `saveAutomation` takes, minus the connector hop), so nothing here can be
 * faster than what an agent actually waits for.
 *
 * This script prints only the HTTP wall clock per call. The STEP breakdown
 * rides the API's own one-line-per-call log (`authoring: save` /
 * `authoring: validate`, services/translation_graph/movement/timing.ts) — read
 * those from `.dev-loop/loop.log`; the `## scenario` markers this script logs
 * to stdout in the same order keep the two readable side by side.
 *
 * The program exercises both cost centres a save pays for: an INTROSPECTED
 * adapter (fake Attio — `listEntryPoints` plus a `describe` per demanded type)
 * and two `listen` statements, one of them on Attio, whose derived trigger
 * drives the team-wide external subscription sync.
 */

import './_profile_loader';
import '../../services';
import { ApiKeyService } from '../../services/api_key';
import { getCoreQb } from '../../lib/kysely';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const BASE = arg('base', process.env.API_BASE_URL ?? 'http://localhost:3500');
const RUNS = Number(arg('runs', '3'));
const MOVEMENT_NAME = 'authoring_latency_probe';

/**
 * The probe program. `note` varies the body text (a save with no listener
 * change); `crmEvents` varies the Attio listen (a save that moves the derived
 * trigger, and with it the external subscription this team registers).
 */
function program(input: { note: string; crmEvents: string[] }): string {
  return `import { attio, slack } from adapters
import { \`Dev Loop Attio\`, \`Dev Loop Slack\` } from credentials

crm  = connect attio using \`Dev Loop Attio\`
chat = connect slack using \`Dev Loop Slack\`

function latency_intake(sm: <chat-[:Message]->>) {
  co = write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        sm.\`Message\`
    Description: "${input.note}"
  }
  chat-[ch:Channels WHERE ch.\`Name\` == "dealflow"]-> {
    write ch-[:Messages]-> {
      Message: "New company in Attio: \${co.externalId}"
    }
  }
}

listen to chat { events: ["message"] } fire latency_intake

function latency_watch(ev: <crm-[:\`Webhook Event\`]->>) {
  if (ev is <crm-[:\`Webhook Event\` WHERE \`action\` == "record.created"]->>) {
    ev-[co:Companies]-> {
      chat-[ch:Channels WHERE ch.\`Name\` == "dealflow"]-> {
        write ch-[:Messages]-> {
          Message: "Changed: \${co.\`Name\`}"
        }
      }
    }
  }
}

listen to crm { events: [${input.crmEvents.map((e) => `"${e}"`).join(', ')}] } fire latency_watch
`;
}

async function mintKey(): Promise<{ key: string; teamId: string }> {
  const teamId = process.env.TEST_HARNESS_TEAM_ID;
  if (!teamId) throw new Error('TEST_HARNESS_TEAM_ID is unset — run `pnpm dev:seed` first');
  // The key acts AS a member of the team — a key minted for a user outside it
  // authenticates and then 403s on the team it was minted for.
  const [member] = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select(['user_id'])
    .where('team_id', '=', teamId as never)
    .limit(1)
    .execute();
  const { key } = await ApiKeyService.createForOwner({
    name: `authoring-latency-${Date.now()}`,
    scopes: ['*', 'automation'],
    teamId,
    createdBy: member?.user_id as unknown as string,
  });
  return { key, teamId };
}

interface CallResult {
  ms: number;
  status: number;
  body: Record<string, unknown>;
}

function post(
  key: string,
  path: string,
  body: unknown,
): Promise<CallResult> {
  const started = Date.now();
  return fetch(`${BASE}/api/v1/automation${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  }).then(async (response) => ({
    ms: Date.now() - started,
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  }));
}

/** One line per call, in the same order the API's own timing lines land. */
function report(scenario: string, run: number, call: string, result: CallResult): void {
  const outcome =
    result.body.ok === true
      ? 'ok'
      : result.body.needsConfirmation === true
        ? `needsConfirmation ${JSON.stringify(result.body.errors ?? []).slice(0, 400)}`
        : `not-ok ${JSON.stringify(result.body.errors ?? result.body).slice(0, 220)}`;
  console.log(
    `${scenario.padEnd(4)} run${run} ${call.padEnd(8)} ${String(result.ms).padStart(6)}ms  ${result.status}  ${outcome}`,
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const { key, teamId } = await mintKey();
  console.log(`# base ${BASE}  team ${teamId}  runs ${RUNS}\n`);

  // Establish the row once, so every measured save is a RE-save (the shape an
  // agent iterating on an automation actually pays for).
  const seeded = await post(key, '/automations/save', {
    source: program({ note: 'seed', crmEvents: ['record.created'] }),
    name: MOVEMENT_NAME,
  });
  report('seed', 0, 'save', seeded);
  const movementId = seeded.body.movementId as string | undefined;
  if (movementId === undefined) {
    console.log('# no movementId came back — the probe program does not save on this stack');
    process.exit(1);
  }

  const save = (source: string): Promise<CallResult> =>
    post(key, '/automations/save', { source, id: movementId, name: MOVEMENT_NAME });
  const validate = (source: string): Promise<CallResult> =>
    post(key, '/automations/validate', { source });

  for (let run = 1; run <= RUNS; run++) {
    // (a) validate then save immediately — inside the 20s instance-cache TTL.
    const a = program({ note: `a-${run}`, crmEvents: ['record.created'] });
    console.log(`## a validate+save immediate (run ${run})`);
    report('a', run, 'validate', await validate(a));
    report('a', run, 'save', await save(a));

    // (b) validate, wait out the 20s TTL, then save.
    const b = program({ note: `b-${run}`, crmEvents: ['record.created'] });
    console.log(`## b validate, 30s gap, save (run ${run})`);
    report('b', run, 'validate', await validate(b));
    await sleep(30_000);
    report('b', run, 'save', await save(b));

    // (c) a one-line body-text edit — nothing about the listeners moves.
    console.log(`## c body-text edit (run ${run})`);
    report('c', run, 'save', await save(program({ note: `c-${run}`, crmEvents: ['record.created'] })));

    // (d) a listen change — the derived trigger and the subscription sync move.
    const events =
      run % 2 === 0 ? ['record.created'] : ['record.created', 'record.updated'];
    console.log(`## d listen change (run ${run})`);
    report('d', run, 'save', await save(program({ note: 'd', crmEvents: events })));

    // (e) the same source twice — the no-op re-save.
    const e = program({ note: `e-${run}`, crmEvents: ['record.created'] });
    console.log(`## e same source twice (run ${run})`);
    report('e', run, 'save-1', await save(e));
    report('e', run, 'save-2', await save(e));
  }

  process.exit(0);
}

void main();
