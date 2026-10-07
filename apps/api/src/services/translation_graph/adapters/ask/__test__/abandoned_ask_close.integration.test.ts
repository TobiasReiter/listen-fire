// An ask whose asker walked away is CLOSED, against a real DB.
//
// The gap this stands over: a park could be withdrawn — a race arm that lost to
// a timer, a run stranded by a retired listener, a run that failed — while the
// ask that park was awaiting stayed `open`. Its link kept rendering a live
// answer form, accepted a submission, and told the person "The workflow will
// continue shortly", which was false: the run had already settled. Nothing was
// left to consume the answer.
//
// So every path that drops parks without their answer now runs the ONE closing
// routine (`abandonAskAwaits`), and the link renders the already-closed page
// instead. The three legs below are the three ways a park is dropped, plus the
// case that must NOT change: an ask answered before the settle keeps its answer.

import { randomUUID } from 'node:crypto';
import express, { type Router } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { getAutomationsQb, getCoreQb } from '../../../../../lib/kysely';
import { cleanupTeam } from '../../../../../test/harness/cleanup';
import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../../../generated/kysely/automations/TriggerRun';
import type { TriggerRunRecorder } from '../../../runs/trigger_run';
import { makeRecorderParkSink } from '../../../../movement_engine/park_sink';
import { settleRunsParkedOnTriggers } from '../../../../interaction/run_failure';
import { claimRunLease, releaseRunLease } from '../../../../movement_engine/run_lease';
import { asksRouter } from '../../../../../interfaces/rest/asks';
import { answerAskByToken } from '../answer_door';
import { registerAwaitCorrelation } from '../../await_correlation';
import { ASK_ADAPTER_TYPE } from '../type';
import { createAsk, getAsk, type AskRecord } from '../store';

// The link page's own harness — the closed rendering is a user-facing promise,
// so it is asserted over real HTTP through the real router, not by calling the
// page builder.
let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/asks', asksRouter as Router);
  server = createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

let teamId: TeamId;
let runId: TriggerRunId;
let triggerId: string;

beforeEach(async () => {
  teamId = randomUUID() as TeamId;
  runId = randomUUID() as TriggerRunId;
  triggerId = randomUUID();
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `abandon-ask-${teamId.slice(0, 8)}` } as any)
    .execute();
  await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      id: runId,
      team_id: teamId,
      trigger_id: triggerId,
      trigger_type: 'webhook',
      status: 'parked',
      started_at: new Date(),
    } as any)
    .execute();
});

afterEach(async () => {
  // `parked_run` and `adapter_await` both cascade from `trigger_run`, which
  // cleanupTeam deletes.
  await cleanupTeam(teamId);
});

/** Only the four members `makeRecorderParkSink` reads. */
function stubRecorder(): TriggerRunRecorder {
  return {
    get triggerRunId() {
      return runId;
    },
    get teamId() {
      return teamId;
    },
    async ensureStarted() {
      // Pre-inserted in beforeEach.
    },
    async markParked() {
      // The run is seeded parked.
    },
  } as unknown as TriggerRunRecorder;
}

/** An ask + the park awaiting it, exactly as `commitAwaitPark` leaves them. */
async function askParkedAt(address: string): Promise<AskRecord> {
  const ask = await createAsk({
    teamId,
    family: 'Provide',
    answerType: 'text',
    prompt: 'Which vendor did we settle on?',
    provenance: { runId },
  });
  await getAutomationsQb(['parked_run'])
    .insertInto('parked_run')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      run_id: runId,
      address,
      status: 'parked',
      park_reason: 'await',
      state: JSON.stringify({ version: 1, address, scopeChain: [] }),
    } as any)
    .execute();
  await registerAwaitCorrelation({ adapterType: ASK_ADAPTER_TYPE, correlationKey: ask.id, runId, teamId, address });
  return ask;
}

/** A timer park — the arm that wins the race below. */
async function timerParkedAt(address: string): Promise<void> {
  await getAutomationsQb(['parked_run'])
    .insertInto('parked_run')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      run_id: runId,
      address,
      status: 'parked',
      park_reason: 'timer',
      wake_at: new Date(),
      state: JSON.stringify({ version: 1, address, scopeChain: [] }),
    } as any)
    .execute();
}

const correlationsFor = async (): Promise<string[]> =>
  (
    await getAutomationsQb(['adapter_await'])
      .selectFrom('adapter_await')
      .where('run_id', '=', runId)
      .select('address')
      .execute()
  ).map((r) => r.address);

describe('a race arm that LOSES closes the ask it was awaiting', () => {
  it('closes the loser arm’s ask, refuses a late submission, and renders the closed page', async () => {
    // `race([ await q-[:Response]->, sleep(30s) ])` — arm 0 waits on the ask,
    // arm 1 on the timer. The timer fires first, so the engine settles the race
    // with arm 1 as the winner and withdraws every other arm's subtree.
    const ask = await askParkedAt('s1.b0');
    await timerParkedAt('s1.b1');

    const sink = makeRecorderParkSink(stubRecorder());
    await sink.cancelSubtrees({ subtreeAddresses: ['s1.b0', 's1.b1'], excludeLeaf: 's1.b1' });

    // The ask is closed, not merely un-correlated.
    expect((await getAsk(ask.id))?.state).toBe('expired');
    expect(await correlationsFor()).toEqual([]);

    // The link no longer offers a form, and says so honestly — no "the workflow
    // will continue shortly", and no invitation to request a fresh link.
    const page = await fetch(`${baseUrl}/api/asks/${ask.token}`);
    expect(page.status).toBe(410);
    const html = await page.text();
    expect(html).toContain('This request was closed');
    expect(html).not.toContain('continue shortly');
    expect(html).not.toMatch(/<form/i);

    // A late submission is REFUSED and changes nothing.
    const late = await fetch(`${baseUrl}/api/asks/${ask.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: 'Vireo Robotics' }),
    });
    expect(late.status).toBe(410);
    expect(await late.text()).toContain('This request was closed');

    const after = await getAsk(ask.id);
    expect(after?.state).toBe('expired');
    expect(after?.answer).toBeNull();
  });

  it('leaves an ask the WINNING arm answered alone', async () => {
    const ask = await askParkedAt('s1.b0');
    await timerParkedAt('s1.b1');

    // The ask arm wins: the answer lands, then the race settles and withdraws
    // the other arms. The answered record must survive the withdrawal.
    const answered = await answerAskByToken(ask.token, 'Vireo Robotics');
    expect(answered.kind).toBe('answered');

    const sink = makeRecorderParkSink(stubRecorder());
    await sink.cancelSubtrees({ subtreeAddresses: ['s1.b0', 's1.b1'], excludeLeaf: 's1.b0' });

    const after = await getAsk(ask.id);
    expect(after?.state).toBe('answered');
    expect(after?.answer).toBe('Vireo Robotics');
  });
});

describe('retiring a listener closes the asks its stranded runs were awaiting', () => {
  it('closes the pending ask and refuses a late submission', async () => {
    const ask = await askParkedAt('s2');

    await settleRunsParkedOnTriggers({
      triggerIds: [triggerId],
      reason: 'The listener that started this run was removed',
    });

    // The run reached a terminal state…
    const run = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', runId)
      .select(['status', 'failure_reason'])
      .executeTakeFirst();
    expect(run?.status).toBe('failed');

    // …and its ask went with it.
    expect((await getAsk(ask.id))?.state).toBe('expired');
    expect(await correlationsFor()).toEqual([]);

    const late = await answerAskByToken(ask.token, 'too late');
    expect(late.kind).toBe('closed');
    expect((await getAsk(ask.id))?.answer).toBeNull();

    const page = await fetch(`${baseUrl}/api/asks/${ask.token}`);
    expect(page.status).toBe(410);
    expect(await page.text()).toContain('This request was closed');
  });

  it('a run another instance is resuming is stamped for that resume to settle, not torn down under it', async () => {
    const ask = await askParkedAt('s2');
    const elsewhere = await claimRunLease(runId, { owner: 'another-instance', ttlMs: 60_000 });
    const reason = 'The listener that started this run was removed';

    await settleRunsParkedOnTriggers({ triggerIds: [triggerId], reason });

    const run = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', runId)
      .select(['status', 'cancel_requested_at', 'cancel_reason'])
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('parked');
    expect(run.cancel_requested_at).not.toBeNull();
    expect(run.cancel_reason).toBe(reason);
    // Its leaves and its ask are the holder's to settle.
    expect((await getAsk(ask.id))?.state).toBe('open');
    await releaseRunLease(runId, elsewhere!.token);
  });

  it('a run whose leaf another instance is resuming is stamped, not missed', async () => {
    await askParkedAt('s2');
    const elsewhere = await claimRunLease(runId, { owner: 'another-instance', ttlMs: 60_000 });
    await getAutomationsQb(['parked_run']).updateTable('parked_run').set({ status: 'resuming' }).where('run_id', '=', runId).execute();
    const reason = 'The listener that started this run was removed';

    await settleRunsParkedOnTriggers({ triggerIds: [triggerId], reason });

    const run = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', runId)
      .select(['status', 'cancel_reason'])
      .executeTakeFirstOrThrow();
    expect(run).toEqual({ status: 'parked', cancel_reason: reason });
    await releaseRunLease(runId, elsewhere!.token);
  });

  it('leaves an ask answered BEFORE the settle exactly as it was', async () => {
    const ask = await askParkedAt('s2');
    const answered = await answerAskByToken(ask.token, 'Vireo Robotics');
    expect(answered.kind).toBe('answered');

    await settleRunsParkedOnTriggers({
      triggerIds: [triggerId],
      reason: 'The listener that started this run was removed',
    });

    const after = await getAsk(ask.id);
    expect(after?.state).toBe('answered');
    expect(after?.answer).toBe('Vireo Robotics');

    // The link still shows what was recorded, not the closed page.
    const page = await fetch(`${baseUrl}/api/asks/${ask.token}`);
    expect(page.status).toBe(410);
    const html = await page.text();
    expect(html).toContain('already been answered');
    expect(html).toContain('Vireo Robotics');
  });
});
