// The GENERIC correlation map (asks-as-adapter §A duty 1) against a REAL DB —
// register / lookup / drop, and the reason the map is ONE table for every
// awaitable adapter: run death reaps every adapter's correlations for a run in
// one `DELETE … WHERE run_id = ?`, no per-adapter fan-out.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { postgresRunHostStore } from '../../../movement_engine/run_host_store';

const { correlations } = postgresRunHostStore;

async function makeTeam(): Promise<TeamId> {
  const teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `await-corr-${teamId.slice(0, 8)}` } as any)
    .execute();
  return teamId;
}

async function makeRun(teamId: TeamId): Promise<TriggerRunId> {
  const runId = randomUUID() as TriggerRunId;
  await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      id: runId,
      team_id: teamId,
      trigger_id: randomUUID(),
      trigger_type: 'webhook',
      status: 'parked',
    } as any)
    .execute();
  return runId;
}

describe('adapter_await — the generic correlation map (real DB)', () => {
  let teamId: TeamId;
  let runId: TriggerRunId;

  beforeEach(async () => {
    teamId = await makeTeam();
    runId = await makeRun(teamId);
  });

  afterEach(async () => {
    await cleanupTeam(teamId);
  });

  it('registers a park and the correlated lookup finds it by adapter identity', async () => {
    await correlations.correlate({
      adapterType: 'ask',
      correlationKey: 'ask-123',
      runId,
      teamId,
      address: 's0',
    });

    const found = await correlations.correlated({
      adapterType: 'ask',
      teamId,
      correlationKey: 'ask-123',
    });
    expect(found).toEqual([{ runId, teamId, address: 's0' }]);

    // A different correlation key finds nothing.
    expect(
      await correlations.correlated({ adapterType: 'ask', teamId, correlationKey: 'ask-999' }),
    ).toEqual([]);
  });

  it('registration is idempotent on (run, address) — a re-park rewrites the same row', async () => {
    await correlations.correlate({
      adapterType: 'slack',
      correlationKey: 'C1:1000.0001',
      runId,
      teamId,
      address: 's0',
    });
    // The same leaf re-parks (re-enters the SAME await) with a fresh correlation
    // identity — the row is rewritten in place, not duplicated.
    await correlations.correlate({
      adapterType: 'slack',
      correlationKey: 'C1:2000.0002',
      runId,
      teamId,
      address: 's0',
    });

    const old = await correlations.correlated({
      adapterType: 'slack',
      teamId,
      correlationKey: 'C1:1000.0001',
    });
    expect(old).toEqual([]);

    const fresh = await correlations.correlated({
      adapterType: 'slack',
      teamId,
      correlationKey: 'C1:2000.0002',
    });
    expect(fresh).toEqual([{ runId, teamId, address: 's0' }]);

    const rows = await getAutomationsQb(['adapter_await'])
      .selectFrom('adapter_await')
      .where('run_id', '=', runId)
      .select(['address'])
      .execute();
    expect(rows).toHaveLength(1); // rewritten, not duplicated
  });

  it('the correlated lookup is team-scoped — another team never sees this correlation', async () => {
    const otherTeam = await makeTeam();
    try {
      await correlations.correlate({
        adapterType: 'ask',
        correlationKey: 'shared-key',
        runId,
        teamId,
        address: 's0',
      });

      expect(
        await correlations.correlated({
          adapterType: 'ask',
          teamId: otherTeam,
          correlationKey: 'shared-key',
        }),
      ).toEqual([]);
      expect(
        await correlations.correlated({ adapterType: 'ask', teamId, correlationKey: 'shared-key' }),
      ).toEqual([{ runId, teamId, address: 's0' }]);
    } finally {
      await cleanupTeam(otherTeam);
    }
  });

  it("dropping one park's correlation removes exactly one park, leaving its siblings", async () => {
    await correlations.correlate({
      adapterType: 'ask',
      correlationKey: 'ask-a',
      runId,
      teamId,
      address: 's0',
    });
    await correlations.correlate({
      adapterType: 'ask',
      correlationKey: 'ask-b',
      runId,
      teamId,
      address: 's1',
    });

    await correlations.drop({ runId, address: 's0' });

    expect(
      await correlations.correlated({ adapterType: 'ask', teamId, correlationKey: 'ask-a' }),
    ).toEqual([]);
    expect(
      await correlations.correlated({ adapterType: 'ask', teamId, correlationKey: 'ask-b' }),
    ).toEqual([{ runId, teamId, address: 's1' }]);
  });

  it("dropping a run's correlations reaps every adapter of one run in one call (run death, F7)", async () => {
    // The multi-adapter case: a fan-out with an open ask AND a Slack reply
    // watch-point in flight for the SAME run.
    await correlations.correlate({
      adapterType: 'ask',
      correlationKey: 'ask-x',
      runId,
      teamId,
      address: 's0',
    });
    await correlations.correlate({
      adapterType: 'slack',
      correlationKey: 'C1:1000.0001',
      runId,
      teamId,
      address: 's1',
    });

    // A second, unrelated run's correlation must survive the first run's reap.
    const otherRun = await makeRun(teamId);
    await correlations.correlate({
      adapterType: 'ask',
      correlationKey: 'ask-y',
      runId: otherRun,
      teamId,
      address: 's0',
    });

    await correlations.dropRun({ runId });

    expect(
      await correlations.correlated({ adapterType: 'ask', teamId, correlationKey: 'ask-x' }),
    ).toEqual([]);
    expect(
      await correlations.correlated({
        adapterType: 'slack',
        teamId,
        correlationKey: 'C1:1000.0001',
      }),
    ).toEqual([]);
    // The other run's ask correlation is untouched.
    expect(
      await correlations.correlated({ adapterType: 'ask', teamId, correlationKey: 'ask-y' }),
    ).toEqual([{ runId: otherRun, teamId, address: 's0' }]);

    const remaining = await getAutomationsQb(['adapter_await'])
      .selectFrom('adapter_await')
      .where('run_id', '=', runId)
      .execute();
    expect(remaining).toHaveLength(0);
  });
});
