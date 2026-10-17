/**
 * End-to-end probe for the authoring-loop editing primitives (readAutomation,
 * editAutomation, grepAutomations) over the real REST surface — same auth
 * path measure_authoring_loop.ts uses (a mintKey() acting as a team member).
 *
 *   pnpm dev:loop:agent   # then, in another shell
 *   pnpm dev:seed
 *   npx tsx src/scripts/dev/verify_editing_primitives.ts
 */

import './_profile_loader';
import '../../services';
import { ApiKeyService } from '../../services/api_key';
import { getCoreQb } from '../../lib/kysely';

const BASE = process.env.API_BASE_URL ?? 'http://localhost:3500';
const MOVEMENT_NAME = 'editing_primitives_probe';

function program(name: string, note: string): string {
  return `import { manual } from adapters

runs = connect manual

function ${name}(go: <runs-[:Invocation]->>) {
  x = "${note}"
}

listen to runs {} fire ${name}
`;
}

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
    name: `editing-primitives-${Date.now()}`,
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

let failures = 0;

function check(label: string, condition: boolean, detail: unknown): void {
  if (condition) {
    console.log(`OK   ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}  ${JSON.stringify(detail).slice(0, 400)}`);
  }
}

async function main(): Promise<void> {
  const { key, teamId } = await mintKey();
  console.log(`# base ${BASE}  team ${teamId}\n`);

  // Seed a fresh automation to edit.
  const seeded = await call(key, 'POST', '/automations/save', {
    source: program(MOVEMENT_NAME, 'seed'),
    name: MOVEMENT_NAME,
  });
  check('seed save ok', seeded.body.ok === true, seeded.body);
  const id = seeded.body.movementId as string | undefined;
  if (!id) {
    console.log('# no movementId — aborting');
    process.exit(1);
  }

  // 1. Windowed read.
  const read1 = await call(key, 'GET', `/automations/${id}/source?offset=1&limit=2`);
  check(
    '1. readAutomation returns a window',
    read1.status === 200 &&
      Array.isArray(read1.body.lines) &&
      (read1.body.lines as unknown[]).length === 2 &&
      typeof read1.body.revision === 'string',
    read1.body,
  );
  const revision1 = read1.body.revision as string;

  // 2. Edit one line with the read revision -> ok.
  const edit1 = await call(key, 'POST', `/automations/${id}/edit`, {
    oldString: 'x = "seed"',
    newString: 'x = "edited"',
    expectedRevision: revision1,
  });
  check('2. editAutomation with fresh revision -> ok', edit1.body.ok === true, edit1.body);

  // 3. Edit again with the NOW-STALE revision1 -> conflict.
  const edit2 = await call(key, 'POST', `/automations/${id}/edit`, {
    oldString: 'x = "edited"',
    newString: 'x = "clobber"',
    expectedRevision: revision1,
  });
  check(
    '3. editAutomation with stale revision -> conflict',
    edit2.body.ok === false && edit2.body.conflict !== undefined,
    edit2.body,
  );

  // 4. Ambiguous anchor -> 400.
  const ambiguousName = 'ambiguous_probe';
  const ambiguousSource = `import { manual } from adapters

runs = connect manual

function ${ambiguousName}(go: <runs-[:Invocation]->>) {
  a = "dup"
  b = "dup"
}

listen to runs {} fire ${ambiguousName}
`;
  const seededAmbiguous = await call(key, 'POST', '/automations/save', {
    source: ambiguousSource,
    name: ambiguousName,
  });
  const ambiguousId = seededAmbiguous.body.movementId as string | undefined;
  let edit3: CallResult = { status: 0, body: {} };
  if (ambiguousId) {
    edit3 = await call(key, 'POST', `/automations/${ambiguousId}/edit`, {
      oldString: '"dup"',
      newString: '"single"',
    });
  }
  check(
    '4. ambiguous anchor -> 400',
    edit3.status === 400 && typeof edit3.body.error === 'string' && /2 places/.test(edit3.body.error),
    edit3.body,
  );

  // 5. grep finds the edited text.
  const grep = await call(key, 'GET', `/automations/grep?pattern=${encodeURIComponent('x = "edited"')}`);
  const matches = (grep.body.matches as { id: string }[] | undefined) ?? [];
  check(
    '5. grepAutomations finds the edited text',
    grep.status === 200 && matches.some((m) => m.id === id),
    grep.body,
  );

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
