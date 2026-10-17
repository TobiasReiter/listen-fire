/**
 * End-to-end probe for the appendable run-local node feature
 * (plans/authoring-loop-2026-09-07/1_appendable_local_node.md): a node literal
 * declares an empty typed edge (`messages: <chat-[:Channels]->-[:Messages]->>`)
 * and `link sent -[:messages]-> <position>` appends to it from inside branches
 * that otherwise have no shared scope to hang an accumulator on. After the
 * branches, `sent-[m:messages]-> { ... }` traverses everything that was
 * linked, in program order, and writes a threaded reply off each landing.
 *
 * Drives the REAL REST surface (save -> validate -> run -> inspect-run),
 * against the fake Slack in the dev loop, for BOTH branches of the automation
 * below (branches on the run's `Text` input):
 *   - text "urgent"   -> two Messages writes, each replied to (2 writes + 2 replies)
 *   - text (anything else) -> one Messages write, replied to (1 write + 1 reply)
 *
 *   pnpm dev:loop:agent   # then, in another shell
 *   pnpm dev:seed
 *   npx tsx src/scripts/dev/verify_appendable_local_node.ts
 */

import './_profile_loader';
import '../../services';
import { ApiKeyService } from '../../services/api_key';
import { getCoreQb } from '../../lib/kysely';
import { ensureDevLoopSlackCredential } from './_lib';

const BASE = process.env.API_BASE_URL ?? 'http://localhost:3500';
const MOVEMENT_NAME = 'appendable_local_node_probe';
const FAKE_CHANNELS_URL = process.env.FAKE_CHANNELS_URL || 'http://localhost:5556';

// The exact syntax taught in the handbook's `collect-what-you-wrote` section
// (apps/api/src/lib/knowledge/movement_handbook/chapters/anatomy.ts), against
// the seeded dev-loop team's Slack credential and its `dealflow` channel.
const SOURCE = `import { manual, slack } from adapters
import { \`Dev Loop Slack\` } from credentials

runs = connect manual
chat = connect slack using \`Dev Loop Slack\`

function ${MOVEMENT_NAME}(go: <runs-[:Invocation]->>) {
  sent = node { messages: <chat-[:Channels]->-[:Messages]->> }

  chat-[ch:Channels WHERE ch.\`Name\` == "dealflow"]-> {
    if (go.\`Text\` == "urgent") {
      urgent = write ch-[:Messages]-> { Message: "A big one just landed." }
      link sent -[:messages]-> urgent
      second = write ch-[:Messages]-> { Message: "Worth a look today." }
      link sent -[:messages]-> second
    } else {
      single = write ch-[:Messages]-> { Message: "A new company just landed." }
      link sent -[:messages]-> single
    }
  }

  sent-[m:messages]-> {
    write m-[:Replies]-> { Message: "✅ filed" }
  }
}

listen to runs {} fire ${MOVEMENT_NAME}
`;

async function mintKey(): Promise<{ key: string; teamId: string }> {
  const teamId = process.env.TEST_HARNESS_TEAM_ID;
  if (!teamId) throw new Error('TEST_HARNESS_TEAM_ID is unset — run `pnpm dev:seed` first');
  const [member] = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select(['user_id'])
    .where('team_id', '=', teamId as never)
    .limit(1)
    .execute();
  const { key } = await ApiKeyService.createForOwner({
    name: `appendable-local-node-${Date.now()}`,
    scopes: ['*', 'automation'],
    teamId,
    createdBy: member?.user_id as unknown as string,
  });
  return { key, teamId };
}

interface CallResult {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  key: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<CallResult> {
  const response = await fetch(`${BASE}/api/v1/automation${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pollRun(key: string, runId: string): Promise<CallResult> {
  for (let i = 0; i < 60; i++) {
    const result = await call(key, 'POST', '/automations/run-status', { runId });
    const status = result.body.status as string | undefined;
    if (status !== undefined && status !== 'running') return result;
    await sleep(1000);
  }
  throw new Error(`run ${runId} did not settle in time`);
}

async function slackState(): Promise<{ channels: unknown[]; messages: any[] }> {
  const state = (await fetch(`${FAKE_CHANNELS_URL}/admin/slack/state`).then((r) => r.json())) as Record<
    string,
    unknown[]
  >;
  return { channels: state.channel ?? [], messages: (state.message ?? []) as any[] };
}

let failures = 0;
function check(label: string, condition: boolean, detail: unknown): void {
  if (condition) {
    console.log(`OK   ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}  ${JSON.stringify(detail).slice(0, 800)}`);
  }
}

async function main(): Promise<void> {
  const { key, teamId } = await mintKey();
  console.log(`# base ${BASE}  team ${teamId}\n`);

  await ensureDevLoopSlackCredential(teamId);
  console.log('# ensured Dev Loop Slack credential\n');

  console.log('=== SOURCE ===');
  console.log(SOURCE);
  console.log('=== /SOURCE ===\n');

  // 1. Save.
  const saved = await call(key, 'POST', '/automations/save', { source: SOURCE, name: MOVEMENT_NAME });
  console.log('# save ->', JSON.stringify(saved.body).slice(0, 1000));
  check('1. save ok, no needsConfirmation', saved.status === 200 && saved.body.ok === true, saved.body);
  const movementId = saved.body.movementId as string | undefined;
  if (!movementId) {
    console.log('# no movementId — aborting');
    process.exit(1);
  }

  // 2. Validate.
  const validated = await call(key, 'POST', '/automations/validate', { source: SOURCE });
  console.log('# validate ->', JSON.stringify(validated.body).slice(0, 2000));
  const diagnostics = (validated.body.diagnostics as { severity?: string }[] | undefined) ?? [];
  const errorDiagnostics = diagnostics.filter((d) => (d.severity ?? 'error') === 'error');
  check('2. validate has no error diagnostics', errorDiagnostics.length === 0, validated.body);

  const before = await slackState();
  console.log(`\n# slack state before runs: ${before.messages.length} messages\n`);

  // 3a. Run branch A ("urgent" -> two writes + two replies).
  const runA = await call(key, 'POST', '/automations/run', { automation: movementId, text: 'urgent' });
  console.log('# run A dispatch ->', JSON.stringify(runA.body));
  check('3a. run A dispatched', runA.status === 200 && typeof runA.body.runId === 'string', runA.body);
  const runIdA = runA.body.runId as string;
  const statusA = await pollRun(key, runIdA);
  console.log('# run A status ->', JSON.stringify(statusA.body));
  check('3a. run A succeeded', statusA.body.status === 'success', statusA.body);

  const inspectA = await call(key, 'POST', '/automations/inspect-run', { runId: runIdA });
  console.log('# run A inspect ->', JSON.stringify(inspectA.body).slice(0, 3000));

  const afterA = await slackState();
  const newMsgsA = afterA.messages.slice(before.messages.length);
  const topLevelA = newMsgsA.filter((m) => m.thread_ts === undefined || m.thread_ts === null);
  const repliesA = newMsgsA.filter((m) => m.thread_ts !== undefined && m.thread_ts !== null);
  console.log(
    `\n# branch A: ${newMsgsA.length} new messages total, ${topLevelA.length} top-level, ${repliesA.length} replies`,
  );
  check('3a. branch A posted exactly 2 top-level messages', topLevelA.length === 2, topLevelA);
  check('3a. branch A got exactly 2 replies', repliesA.length === 2, repliesA);
  check(
    '3a. each top-level message in branch A has exactly one reply',
    topLevelA.every((tl) => repliesA.filter((r) => r.thread_ts === tl.ts).length === 1),
    { topLevelA, repliesA },
  );
  check(
    '3a. every reply text is the checkmark',
    repliesA.every((r) => r.text === '✅ filed'),
    repliesA,
  );

  // 3b. Run branch B (anything else -> one write + one reply).
  const runB = await call(key, 'POST', '/automations/run', { automation: movementId, text: 'calm' });
  console.log('\n# run B dispatch ->', JSON.stringify(runB.body));
  check('3b. run B dispatched', runB.status === 200 && typeof runB.body.runId === 'string', runB.body);
  const runIdB = runB.body.runId as string;
  const statusB = await pollRun(key, runIdB);
  console.log('# run B status ->', JSON.stringify(statusB.body));
  check('3b. run B succeeded', statusB.body.status === 'success', statusB.body);

  const inspectB = await call(key, 'POST', '/automations/inspect-run', { runId: runIdB });
  console.log('# run B inspect ->', JSON.stringify(inspectB.body).slice(0, 3000));

  const afterB = await slackState();
  const newMsgsB = afterB.messages.slice(afterA.messages.length);
  const topLevelB = newMsgsB.filter((m) => m.thread_ts === undefined || m.thread_ts === null);
  const repliesB = newMsgsB.filter((m) => m.thread_ts !== undefined && m.thread_ts !== null);
  console.log(
    `\n# branch B: ${newMsgsB.length} new messages total, ${topLevelB.length} top-level, ${repliesB.length} replies`,
  );
  check('3b. branch B posted exactly 1 top-level message', topLevelB.length === 1, topLevelB);
  check('3b. branch B got exactly 1 reply', repliesB.length === 1, repliesB);
  check(
    '3b. the top-level message in branch B has exactly one reply',
    topLevelB.every((tl) => repliesB.filter((r) => r.thread_ts === tl.ts).length === 1),
    { topLevelB, repliesB },
  );

  // 4. Run write ledger via listRuns.
  const runs = await call(key, 'GET', `/automations/${movementId}/runs`);
  console.log('\n# listRuns ->', JSON.stringify(runs.body).slice(0, 2000));

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
