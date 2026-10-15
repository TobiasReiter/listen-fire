// Chunk F surfaces over the NEW ask store, against a REAL DB. Proves the three
// on-system surfaces read + answer the new store:
//   • "your asks" control tower  — listAskRecordsForTeam / answerAskRecordForTeam
//   • the agent (MCP)            — listOpenAsksForTeam / answerForTeam
//   • run views name awaited edges (P22) — describeRunAwaits
//
// All exercise the ONE answer door and the real coercion lattice, so a settle
// here is the same transition the link page and Slack buttons drive.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { AskId } from '../../../generated/kysely/asks/Ask';

import { cleanupTeam } from '../../../test/harness/cleanup';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { createAsk, getAsk } from '../../translation_graph/adapters/ask/store';
import {
  listAskRecordsForTeam,
  answerAskRecordForTeam,
} from '../ask_records';
import { listOpenAsksForTeam, answerForTeam } from '../answer_surfaces';
import { describeRunAwaits } from '../../movement_engine/await_description';
import { notifyEngineOfSettledAsks } from '../../asks/in_process_notifier';
import { postgresRunHostStore } from '../../movement_engine/run_host_store';

async function makeTeam(): Promise<TeamId> {
  const teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `ask-surf-${teamId.slice(0, 8)}` } as any)
    .execute();
  return teamId;
}

async function makeParkedRun(teamId: TeamId): Promise<TriggerRunId> {
  const runId = randomUUID() as TriggerRunId;
  await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      id: runId,
      team_id: teamId,
      // trigger_id references automations.trigger by uuid (no automations.trigger
      // row here — the name simply resolves to null, exercising that path).
      trigger_id: randomUUID(),
      trigger_type: 'webhook',
      status: 'parked',
    } as any)
    .execute();
  return runId;
}

describe('chunk F — new-store ask surfaces (real DB)', () => {
  let teamId: TeamId;

  beforeEach(async () => {
    teamId = await makeTeam();
  });
  afterEach(async () => {
    await cleanupTeam(teamId);
  });

  describe('"your asks" control tower', () => {
    it('lists open + settled records, open first, and answers one in place', async () => {
      const open = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?' });
      const done = await createAsk({ teamId, family: 'Review', prompt: 'FYI' });
      await answerAskRecordForTeam({ askId: done.id, answer: 'ack', teamId });

      const listed = await listAskRecordsForTeam(teamId);
      expect(listed.map((a) => a.askId)).toEqual([open.id, done.id]); // open sorts first
      expect(listed[0]).toMatchObject({
        state: 'open',
        question: 'Ship it?',
        interactionType: 'check',
      });
      expect(listed[1]).toMatchObject({ state: 'answered', answer: 'ack' });

      // Answer the open one in place — the real coercion runs (string→boolean).
      const result = await answerAskRecordForTeam({ askId: open.id, answer: 'true', teamId });
      expect(result.state).toBe('answered');
      expect((await getAsk(open.id))?.answer).toBe(true);
    });

    it('answering wakes the parked run through the shared door: one queued wake, nothing resumed in the request', async () => {
      notifyEngineOfSettledAsks();
      const runId = await makeParkedRun(teamId);
      const ask = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?', provenance: { runId } });
      await getAutomationsQb(['parked_run'])
        .insertInto('parked_run')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .values({ run_id: runId, address: 'await-ask', status: 'parked', park_reason: 'await', state: '{}' } as any)
        .execute();
      await postgresRunHostStore.correlations.correlate({ adapterType: 'ask', correlationKey: ask.id, runId, teamId, address: 'await-ask' });

      await answerAskRecordForTeam({ askId: ask.id, answer: 'true', teamId });

      const wakes = await getAutomationsQb(['work'])
        .selectFrom('work')
        .where('team_id', '=', teamId)
        .where('kind', '=', 'wake_await')
        .select('payload')
        .execute();
      expect(wakes.map((w) => w.payload)).toEqual([{ adapterType: 'ask', teamId, correlationKey: ask.id }]);
      // The run is resumed by the drain, not by the request.
      const park = await getAutomationsQb(['parked_run'])
        .selectFrom('parked_run')
        .where('run_id', '=', runId)
        .select('status')
        .executeTakeFirst();
      expect(park?.status).toBe('parked');
    });

    it('refuses a question owned by another team, and a bad answer', async () => {
      const other = await makeTeam();
      try {
        const ask = await createAsk({ teamId: other, family: 'Select', prompt: 'Which?', options: ['a', 'b'] });
        await expect(
          answerAskRecordForTeam({ askId: ask.id, answer: 'a', teamId }),
        ).rejects.toThrow(/could not be found/);
        await expect(
          answerAskRecordForTeam({ askId: ask.id, answer: 'z', teamId: other }),
        ).rejects.toThrow();
      } finally {
        await cleanupTeam(other);
      }
    });
  });

  describe('the agent surface (MCP)', () => {
    it('lists new-store open asks with the family-derived control, and answers by id', async () => {
      const ask = await createAsk({
        teamId,
        family: 'Provide',
        prompt: 'How many seats?',
        answerType: 'number',
      });

      const open = await listOpenAsksForTeam(teamId);
      const view = open.find((v) => (v.requestId as unknown as string) === ask.id);
      expect(view).toBeDefined();
      expect(view).toMatchObject({
        interactionType: 'provide',
        resultType: { graph: 'number' },
      });
      expect(view?.args.title).toBe('How many seats?');

      const outcome = await answerForTeam({
        teamId,
        requestId: ask.id as unknown as AskId,
        answer: '5',
      });
      expect(outcome.ok).toBe(true);
      expect((await getAsk(ask.id))?.answer).toBe(5);
    });
  });

  describe('run views name awaited edges (P22)', () => {
    it('describes an ask await in plain language, and an until timer', async () => {
      const runId = await makeParkedRun(teamId);
      const ask = await createAsk({ teamId, family: 'Check', prompt: 'Kill Acme Corp?' });

      // An await park on the ask's Response edge + its correlation row.
      await getAutomationsQb(['parked_run'])
        .insertInto('parked_run')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .values({ run_id: runId, address: 's0', status: 'parked', park_reason: 'await', state: JSON.stringify({}) } as any)
        .execute();
      await getAutomationsQb(['adapter_await'])
        .insertInto('adapter_await')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .values({ adapter_type: 'ask', correlation_key: ask.id, run_id: runId, team_id: teamId, address: 's0' } as any)
        .execute();

      // A recurring `until` timer park.
      await getAutomationsQb(['parked_run'])
        .insertInto('parked_run')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .values({ run_id: runId, address: 's1', status: 'parked', park_reason: 'timer', state: JSON.stringify({ until: true }) } as any)
        .execute();

      const awaits = await describeRunAwaits(runId);
      expect(awaits).toContain('waiting for an answer to: Kill Acme Corp?');
      expect(awaits).toContain('checking on a schedule for a condition to become true');

      // The awaiting automation surfaces on the "your asks" record too (name
      // unresolved here — no automations.trigger row — so it stays null, but the
      // correlation lookup runs the real path).
      const listed = await listAskRecordsForTeam(teamId);
      expect(listed.find((a) => a.askId === ask.id)?.awaitingAutomationName ?? null).toBeNull();
    });
  });
});
