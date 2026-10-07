// The timer driver through the work table: a timer park arms one
// `resume_timer:<runId>` work row, and draining it wakes the run. The park →
// row → drain → resume path is real; only catalog introspection and adapter
// I/O are mocked (as in timer_resume.integration.test.ts).

import { randomUUID } from 'node:crypto';

jest.mock('../../translation_graph/movement/catalog', () => {
  const actual = jest.requireActual('../../translation_graph/movement/catalog');
  return { ...actual, runCatalogSnapshotForTeam: jest.fn() };
});
jest.mock('../../translation_graph/adapters/resolve', () => {
  const actual = jest.requireActual('../../translation_graph/adapters/resolve');
  return { ...actual, resolveAdapter: jest.fn() };
});

import { getAutomationsQb, getCoreQb, getQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { PipelineConfigurationId } from '../../../generated/kysely/public/PipelineConfiguration';
import { dispatchTriggerByIdEvent } from '../../translation_graph/triggers/router';
import { runCatalogSnapshotForTeam, snapshotOverManifests, staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { resolveAdapter } from '../../translation_graph/adapters/resolve';
import { mintMovementVersionIfChanged } from '../../translation_graph/movement/version_store';
import { positionData } from '../../translation_graph/types';
import type { Adapter, RuntimeCapabilities } from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { Catalog, CatalogSnapshot, InstanceSchema, PositionSchema } from 'movement-lang';
import { eventAddressKey, CURRENT_LANGUAGE_VERSION } from 'movement-lang';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import { TriggerRunRecorder } from '../../translation_graph/runs/trigger_run';
import { registerTimerWork, resumeTimerParkedRun, settleCancelledTimersHandler, timerWorkKey } from '../timer_resume';
import { testWorkContext } from '../../../test/harness/work';
import { makeRecorderParkSink } from '../park_sink';
import { drainUntilIdle, drainWork, resetWorkHandlersForTests } from '../../work/drain';
import { claimRunLease, releaseRunLease, withRunLease, type HeldRunLease } from '../run_lease';
import { getCallback, listRunCallbacks } from '../callback_store';
import { loadCorrelatedParks } from '../../translation_graph/adapters/await_correlation';

const mockedCatalog = runCatalogSnapshotForTeam as jest.Mock;
const mockedResolve = resolveAdapter as jest.Mock;

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

const ACTIONS = ['record.created', 'record.updated', 'record.deleted'];
const EVENT = 'Webhook Event';
const graftPositions: Record<string, PositionSchema> = {};
const graftVariants: string[] = [];
for (const action of ACTIONS) {
  const key = eventAddressKey({ event: EVENT, narrowing: { action } });
  graftVariants.push(key);
  graftPositions[key] = {
    properties: { action: { kind: 'enum', options: ACTIONS } },
    edges: action === 'record.deleted' ? {} : {  },
  };
}
const ATTIO_SCHEMA: InstanceSchema = {
  positions: {
    [EVENT]: {
      properties: { action: { kind: 'enum', options: ACTIONS } },
      edges: {  },
    },
    ...graftPositions,
  },
  collections: {},
  unions: { [EVENT]: graftVariants },
  writableRoots: {},
  eventPosition: EVENT,
  eventPositions: [{ position: EVENT }],
};

function buildCatalog(): CatalogSnapshot {
  const base = staticCatalogFromManifests({
    credentials: {
      acme_main: { adapters: ['attio'] },
      acme_slack: { adapters: ['slack'] },
    },
  });
  return snapshotOverManifests({
    ...base,
    instantiate(name, args) {
      if (name === 'attio') return ATTIO_SCHEMA;
      return base.instantiate(name, args);
    },
  });
}

function makeAttioSourceFake(): Adapter {
  return {
    adapterType: 'attio',
    supportedTriggers: ['webhook'] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId] ?? null;
    },
    async getRelated() {
      return [];
    },
    async createRecord() {
      throw new Error('test: attio is a source here');
    },
    async updateRecord() {
      throw new Error('test: attio is a source here');
    },
    async deleteRecord() {
      return {};
    },
  };
}

function makeSlackTargetFake(): { adapter: Adapter; creates: Record<string, unknown>[] } {
  const creates: Record<string, unknown>[] = [];
  const adapter: Adapter = {
    adapterType: 'slack',
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      creates.push(input.fields);
      return { adapterType: 'slack', externalId: `msg-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      return { adapterType: 'slack', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

const SLEEP_THEN_NOTIFY = [
  'import { attio, slack } from adapters',
  'import { acme_main, acme_slack } from credentials',
  '',
  'crm = attio(credentials: acme_main)',
  'chat = slack(credentials: acme_slack)',
  '',
  'movement sleep_then_notify(ev: <crm-[:`Webhook Event`]->>) {',
  '  await sleep(1h)',
  '  write chat-[:messages]-> {',
  '    channel: "#alerts"',
  '    text: "awake after sleep"',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created"] } fire sleep_then_notify',
].join('\n');

const SLEEP_THEN_TWICE = [
  'import { attio, slack } from adapters',
  'import { acme_main, acme_slack } from credentials',
  '',
  'crm = attio(credentials: acme_main)',
  'chat = slack(credentials: acme_slack)',
  '',
  'movement sleep_then_twice(ev: <crm-[:`Webhook Event`]->>) {',
  '  await sleep(1h)',
  '  write chat-[:messages]-> {',
  '    channel: "#alerts"',
  '    text: "first"',
  '  }',
  '  write chat-[:messages]-> {',
  '    channel: "#alerts"',
  '    text: "second"',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created"] } fire sleep_then_twice',
].join('\n');

const SLEEP_THEN_LAST = [
  'import { attio, slack } from adapters',
  'import { acme_main, acme_slack } from credentials',
  '',
  'crm = attio(credentials: acme_main)',
  'chat = slack(credentials: acme_slack)',
  '',
  'movement sleep_then_last(ev: <crm-[:`Webhook Event`]->>) {',
  '  cb = callback()',
  '  await sleep(1h)',
  '  write chat-[:messages]-> {',
  '    channel: "#alerts"',
  '    text: "last"',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created"] } fire sleep_then_last',
].join('\n');

async function seedMovement(
  teamId: TeamId,
  opts: { source: string; firedName: string; name: string },
): Promise<{ movementId: MovementId; triggerId: TriggerId }> {
  const pipelineConfigurationId = randomUUID() as PipelineConfigurationId;
  await getQb(['pipeline_configuration'])
    .insertInto('pipeline_configuration')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: pipelineConfigurationId, team_id: teamId, name: `cfg-${pipelineConfigurationId.slice(0, 8)}` } as any)
    .execute();

  const movementId = randomUUID() as MovementId;
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: movementId, team_id: teamId, name: opts.name, source: opts.source } as any)
    .execute();

  // Pin a runnable version + set current_version_id (the resume re-parses THIS).
  await mintMovementVersionIfChanged({ teamId, movementId, source: opts.source, languageVersion: CURRENT_LANGUAGE_VERSION });

  const triggerId = randomUUID() as TriggerId;
  await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      id: triggerId,
      team_id: teamId,
      pipeline_configuration_id: pipelineConfigurationId,
      name: 'Attio record changes',
      kind: 'attio',
      movement_id: movementId,
      fired_movement_name: opts.firedName,
    } as any)
    .execute();

  return { movementId, triggerId };
}

async function seedMovementWithTrigger(teamId: TeamId): Promise<{
  movementId: MovementId;
  triggerId: TriggerId;
}> {
  return seedMovement(teamId, {
    source: SLEEP_THEN_NOTIFY,
    firedName: 'sleep_then_notify',
    name: 'Sleep then notify',
  });
}

function webhookEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:test',
    adapterType: 'attio',
    triggerType: 'webhook',
    payload: { event_type: 'record.created', action: 'record.created', id: { object_id: 'obj-x', record_id: 'co-1' } },
    changeType: 'create',
    rootRecordType: 'Companies',
    externalRecordRef: { adapterType: 'attio', externalId: 'co-1', recordType: 'Companies' },
    occurredAt: new Date().toISOString(),
  };
}


const HOUR = 60 * 60 * 1000;

async function parkedRun(teamId: TeamId): Promise<{ runId: TriggerRunId; address: string; startedAt: Date }> {
  const row = await getAutomationsQb(['parked_run', 'trigger_run'])
    .selectFrom('parked_run')
    .innerJoin('trigger_run', 'trigger_run.id', 'parked_run.run_id')
    .where('trigger_run.team_id', '=', teamId)
    .where('parked_run.park_reason', '=', 'timer')
    .where('parked_run.status', '=', 'parked')
    .select(['parked_run.run_id as runId', 'parked_run.address as address', 'trigger_run.started_at as startedAt'])
    .executeTakeFirstOrThrow();
  return { runId: row.runId, address: row.address, startedAt: new Date(row.startedAt) };
}

async function workRows(runId: string) {
  return getAutomationsQb(['work'])
    .selectFrom('work')
    .where('key', '=', timerWorkKey(runId))
    .selectAll()
    .execute();
}

async function runRow(runId: TriggerRunId) {
  return getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select(['status', 'failure_reason'])
    .executeTakeFirstOrThrow();
}

async function backdateLeafAndRow(runId: TriggerRunId): Promise<void> {
  const past = new Date(Date.now() - 60_000);
  await getAutomationsQb(['parked_run'])
    .updateTable('parked_run')
    .set({ wake_at: past })
    .where('run_id', '=', runId)
    .execute();
  await getAutomationsQb(['work'])
    .updateTable('work')
    .set({ due_at: past })
    .where('key', '=', timerWorkKey(runId))
    .execute();
}

// What a process death mid-claim leaves behind: a claimed row whose lease ran out.
async function lapseLease(runId: TriggerRunId): Promise<void> {
  const past = new Date(Date.now() - 60_000);
  await getAutomationsQb(['work'])
    .updateTable('work')
    .set({ attempts: 1, lease_owner: 'dead-process', lease_until: past, lease_token: randomUUID(), due_at: past })
    .where('key', '=', timerWorkKey(runId))
    .execute();
}

async function markRunning(runId: TriggerRunId, lastHeartbeatAt: Date): Promise<void> {
  await getAutomationsQb(['trigger_run'])
    .updateTable('trigger_run')
    .set({ status: 'running', last_heartbeat_at: lastHeartbeatAt })
    .where('id', '=', runId)
    .execute();
}

async function parkedRows(runId: TriggerRunId): Promise<number> {
  const rows = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .select('id')
    .execute();
  return rows.length;
}

async function wakeAtOf(runId: TriggerRunId): Promise<number> {
  const row = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .where('park_reason', '=', 'timer')
    .select('wake_at')
    .executeTakeFirstOrThrow();
  return new Date(row.wake_at ?? 0).getTime();
}

/** Only what makeRecorderParkSink reads; the run row already exists from the dispatch. */
function recorderFor(input: { runId: TriggerRunId; teamId: TeamId }): TriggerRunRecorder {
  return {
    get triggerRunId() {
      return input.runId;
    },
    get teamId() {
      return input.teamId;
    },
    async ensureStarted() {},
    async markParked() {},
  } as unknown as TriggerRunRecorder;
}

describe('timer_resume — parks resume through the work table (real DB)', () => {
  let teamId: TeamId;
  let slackCreates: Record<string, unknown>[];

  beforeAll(() => {
    resetWorkHandlersForTests();
    registerTimerWork();
  });

  afterAll(() => {
    resetWorkHandlersForTests();
  });

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `timer-work-${teamId.slice(0, 8)}` } as any)
      .execute();

    const catalog = buildCatalog();
    mockedCatalog.mockResolvedValue({
      snapshot: catalog,
      credentialIds: Object.fromEntries(Object.keys(catalog.credentials).map((name) => [name, 'cred-1'])),
      notes: [],
    });

    const target = makeSlackTargetFake();
    slackCreates = target.creates;
    mockedResolve.mockImplementation(async ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'attio') return makeAttioSourceFake();
      if (adapterType === 'slack') return target.adapter;
      throw new Error(`test: no fake for '${adapterType}'`);
    });
  });

  afterEach(async () => {
    await cleanupTeam(teamId);
    jest.clearAllMocks();
  });

  it('a sleep(1h) park leaves one resume_timer row due an hour after the run started', async () => {
    const { triggerId } = await seedMovementWithTrigger(teamId);
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });

    const { runId, startedAt } = await parkedRun(teamId);
    const rows = await workRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('resume_timer');
    expect(rows[0].team_id).toBe(teamId);
    expect(rows[0].payload).toEqual({ runId });
    expect(Math.abs(new Date(rows[0].due_at).getTime() - (startedAt.getTime() + HOUR))).toBeLessThan(1000);
  });

  it('a re-park at a later wake moves the row forward (via the wake that finds nothing due)', async () => {
    const { triggerId } = await seedMovementWithTrigger(teamId);
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const { runId, address, startedAt } = await parkedRun(teamId);
    const firstWake = startedAt.getTime() + HOUR;

    const laterWake = new Date(Date.now() + 2 * HOUR);
    const sink = makeRecorderParkSink(recorderFor({ runId, teamId }));
    const parked = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .where('run_id', '=', runId)
      .where('address', '=', address)
      .select('state')
      .executeTakeFirstOrThrow();
    await sink.commitTimerPark({ address, state: parked.state, wakeAt: laterWake.toISOString() });

    // An unleased row keeps the earlier time: one row serves every leaf of the run.
    let rows = await workRows(runId);
    expect(rows).toHaveLength(1);
    expect(Math.abs(new Date(rows[0].due_at).getTime() - firstWake)).toBeLessThan(1000);

    // That early wake resumes nothing and re-arms at the leaf's real wake time.
    await getAutomationsQb(['work'])
      .updateTable('work')
      .set({ due_at: new Date(Date.now() - 60_000) })
      .where('key', '=', timerWorkKey(runId))
      .execute();
    await drainUntilIdle({ owner: 't' });

    rows = await workRows(runId);
    expect(rows).toHaveLength(1);
    expect(Math.abs(new Date(rows[0].due_at).getTime() - laterWake.getTime())).toBeLessThan(1000);
    expect(rows[0].lease_until).toBeNull();
    expect(slackCreates).toHaveLength(0);
    expect((await runRow(runId)).status).toBe('parked');
  });

  it('draining a due row resumes the run to success and removes the row', async () => {
    const { triggerId } = await seedMovementWithTrigger(teamId);
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const { runId } = await parkedRun(teamId);

    await backdateLeafAndRow(runId);
    await drainUntilIdle({ owner: 't' });

    expect(slackCreates).toEqual([{ channel: '#alerts', text: 'awake after sleep' }]);
    expect((await runRow(runId)).status).toBe('success');
    expect(await workRows(runId)).toHaveLength(0);
  });

  it('a run another process is stepping re-arms its row a few seconds on and resumes nothing, then resumes once free', async () => {
    const { triggerId } = await seedMovementWithTrigger(teamId);
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const { runId } = await parkedRun(teamId);
    const elsewhere = await claimRunLease(runId, { owner: 'another-instance', ttlMs: 60_000 });
    expect(elsewhere).not.toBeNull();

    await backdateLeafAndRow(runId);
    const before = Date.now();
    const held = await drainWork({ owner: 't' });

    expect(held).toMatchObject({ claimed: 1, failed: 0 });
    expect(slackCreates).toHaveLength(0);
    expect((await runRow(runId)).status).toBe('parked');
    const parked = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .where('run_id', '=', runId)
      .select('status')
      .execute();
    expect(parked.map((row) => row.status)).toEqual(['parked']);
    const [rearmed] = await workRows(runId);
    expect(rearmed.lease_until).toBeNull();
    const dueIn = new Date(rearmed.due_at).getTime() - before;
    expect(dueIn).toBeGreaterThan(1_000);
    expect(dueIn).toBeLessThan(30_000);

    await releaseRunLease(runId, elsewhere!.token);
    await backdateLeafAndRow(runId);
    await drainUntilIdle({ owner: 't' });
    expect(slackCreates).toEqual([{ channel: '#alerts', text: 'awake after sleep' }]);
    expect((await runRow(runId)).status).toBe('success');
  });

  it('a holder that loses its run lease stops at its next statement, and the new holder resumes the run alone', async () => {
    const { triggerId } = await seedMovement(teamId, {
      source: SLEEP_THEN_TWICE,
      firedName: 'sleep_then_twice',
      name: 'Sleep then twice',
    });
    // The first write the stale holder makes hangs until the test lets it go,
    // standing in for a process that stalls past its lease.
    const texts: unknown[] = [];
    let unstall: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      unstall = resolve;
    });
    let entered: () => void = () => {};
    const inFirstWrite = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slack = makeSlackTargetFake().adapter;
    slack.createRecord = async (input) => {
      texts.push(input.fields.text);
      if (texts.length === 1) {
        entered();
        await stalled;
      }
      return { adapterType: 'slack', externalId: `msg-${texts.length}`, data: {} };
    };
    mockedResolve.mockImplementation(async ({ adapterType }: { adapterType: string }) =>
      adapterType === 'slack' ? slack : makeAttioSourceFake(),
    );
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const { runId } = await parkedRun(teamId);
    await backdateLeafAndRow(runId);

    let stale: HeldRunLease | undefined;
    const staleStep = withRunLease(
      runId,
      (lease) => {
        stale = lease;
        return resumeTimerParkedRun({ runId, teamId }, new Date(), lease);
      },
      { ttlMs: 1_500 },
    );
    await inFirstWrite;

    // Its lease lapses (it stopped renewing, as far as the database knows),
    // and another instance takes the run and resumes it to the end.
    await getAutomationsQb(['trigger_run'])
      .updateTable('trigger_run')
      .set({ lease_until: new Date(Date.now() - 1_000) })
      .where('id', '=', runId)
      .execute();
    const fresh = await withRunLease(runId, (lease) => resumeTimerParkedRun({ runId, teamId }, new Date(), lease));
    expect(fresh.kind).toBe('held');
    expect((await runRow(runId)).status).toBe('success');

    // The stale holder's next renewal finds the lease gone; let its write
    // land, and it stops before its next statement.
    for (let i = 0; i < 40 && !stale?.isLost(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stale?.isLost()).toBe(true);
    unstall();
    await staleStep;

    // Its in-flight write is the one thing it did; the second write is the
    // new holder's alone, and the run is the new holder's to have settled.
    expect(texts).toEqual(['first', 'first', 'second']);
    expect(await runRow(runId)).toEqual({ status: 'success', failure_reason: null });
    expect(await parkedRows(runId)).toBe(0);
  });

  it('a lapsed lease on a run left running with a stale heartbeat fails the run', async () => {
    const { triggerId } = await seedMovementWithTrigger(teamId);
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const { runId } = await parkedRun(teamId);

    await markRunning(runId, new Date(Date.now() - 2 * 60_000));
    await lapseLease(runId);
    const result = await drainWork({ owner: 't' });

    expect(result.recovered).toBe(1);
    expect(await runRow(runId)).toEqual({
      status: 'failed',
      failure_reason: 'segment did not complete: lease lapsed or the previous attempt failed',
    });
    expect(slackCreates).toHaveLength(0);
    expect(await parkedRows(runId)).toBe(0);
    expect(await workRows(runId)).toHaveLength(0);
  });

  it('a lapsed lease on a run running with a fresh heartbeat leaves the run alone and looks again once it would be stale', async () => {
    const { triggerId } = await seedMovementWithTrigger(teamId);
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const { runId } = await parkedRun(teamId);

    await markRunning(runId, new Date());
    await lapseLease(runId);
    const before = Date.now();
    const result = await drainWork({ owner: 't' });

    expect(result.recovered).toBe(1);
    expect((await runRow(runId)).status).toBe('running');
    expect(await parkedRows(runId)).toBe(1);
    expect(slackCreates).toHaveLength(0);
    const rows = await workRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].lease_until).toBeNull();
    expect(rows[0].payload).toEqual({ runId });
    const dueAt = new Date(rows[0].due_at).getTime();
    expect(dueAt).toBeGreaterThanOrEqual(before + 60_000 - 1_000);
    expect(dueAt).toBeLessThan(Date.now() + 60_000 + 1_000);
  });

  it('the timer sweep re-arms a timer park that has no work row, idempotently', async () => {
    const { triggerId } = await seedMovementWithTrigger(teamId);
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const { runId } = await parkedRun(teamId);
    const wakeAt = await wakeAtOf(runId);

    // A park from before work rows existed.
    await getAutomationsQb(['work']).deleteFrom('work').where('key', '=', timerWorkKey(runId)).execute();
    await settleCancelledTimersHandler.run({}, testWorkContext());

    const first = await workRows(runId);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: 'resume_timer', team_id: teamId, payload: { runId }, lease_until: null });
    expect(Math.abs(new Date(first[0].due_at).getTime() - wakeAt)).toBeLessThan(1000);

    await settleCancelledTimersHandler.run({}, testWorkContext());
    const second = await workRows(runId);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].due_at).toEqual(first[0].due_at);
    expect(second[0].lease_until).toBeNull();
  });

  it('the timer sweep leaves a leased row alone', async () => {
    const { triggerId } = await seedMovementWithTrigger(teamId);
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const { runId } = await parkedRun(teamId);

    const held = {
      due_at: new Date(Date.now() + 5 * HOUR),
      lease_owner: 'busy-drainer',
      lease_until: new Date(Date.now() + 60_000),
      lease_token: randomUUID(),
      attempts: 1,
    };
    await getAutomationsQb(['work']).updateTable('work').set(held).where('key', '=', timerWorkKey(runId)).execute();
    const before = (await workRows(runId))[0];

    await settleCancelledTimersHandler.run({}, testWorkContext());

    const after = await workRows(runId);
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before);
  });

  it('a lapsed lease on a run still parked resumes it normally', async () => {
    const { triggerId } = await seedMovementWithTrigger(teamId);
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const { runId } = await parkedRun(teamId);

    await backdateLeafAndRow(runId);
    await lapseLease(runId);
    const result = await drainWork({ owner: 't' });

    expect(result.recovered).toBe(1);
    expect((await runRow(runId)).status).toBe('success');
    expect(slackCreates).toEqual([{ channel: '#alerts', text: 'awake after sleep' }]);
    expect(await workRows(runId)).toHaveLength(0);
  });

  it('a lease that lapses during the last statement settles nothing: the stale return touches no row, and the new holder finishes alone', async () => {
    const { triggerId } = await seedMovement(teamId, {
      source: SLEEP_THEN_LAST,
      firedName: 'sleep_then_last',
      name: 'Sleep then last',
    });
    const texts: unknown[] = [];
    let unstall: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      unstall = resolve;
    });
    let entered: () => void = () => {};
    const inLastWrite = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slack = makeSlackTargetFake().adapter;
    slack.createRecord = async (input) => {
      texts.push(input.fields.text);
      if (texts.length === 1) {
        entered();
        await stalled;
      }
      return { adapterType: 'slack', externalId: `msg-${texts.length}`, data: {} };
    };
    mockedResolve.mockImplementation(async ({ adapterType }: { adapterType: string }) =>
      adapterType === 'slack' ? slack : makeAttioSourceFake(),
    );
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const { runId } = await parkedRun(teamId);
    const [callback] = await listRunCallbacks(runId);
    expect(callback?.status).toBe('live');
    // A correlation of the run's, which nothing the stale holder does may drop.
    await getAutomationsQb(['adapter_await'])
      .insertInto('adapter_await')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ adapter_type: 'ask', correlation_key: 'req-kept', run_id: runId, team_id: teamId, address: 's9' } as any)
      .execute();
    await backdateLeafAndRow(runId);

    let stale: HeldRunLease | undefined;
    const staleStep = withRunLease(
      runId,
      (lease) => {
        stale = lease;
        return resumeTimerParkedRun({ runId, teamId }, new Date(), lease);
      },
      { ttlMs: 1_500 },
    );
    await inLastWrite;

    // The lease lapses while the run's last statement is in flight, and
    // another instance claims the run (without stepping it yet).
    await getAutomationsQb(['trigger_run'])
      .updateTable('trigger_run')
      .set({ lease_until: new Date(Date.now() - 1_000) })
      .where('id', '=', runId)
      .execute();
    const other = await claimRunLease(runId, { owner: 'the-new-holder', ttlMs: 60_000 });
    expect(other).not.toBeNull();
    for (let i = 0; i < 40 && !stale?.isLost(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stale?.isLost()).toBe(true);

    // The write lands and the segment ends normally: there is no statement
    // boundary after it. The stale holder must still settle nothing.
    unstall();
    expect(await staleStep).toEqual({ kind: 'held', value: 'lease_lost' });
    expect(texts).toEqual(['last']);
    expect((await runRow(runId)).status).toBe('parked');
    expect((await getCallback(callback!.id))?.status).toBe('live');
    expect(await loadCorrelatedParks({ adapterType: 'ask', teamId, correlationKey: 'req-kept' })).toHaveLength(1);
    const leaves = await getAutomationsQb(['parked_run']).selectFrom('parked_run').where('run_id', '=', runId).select('status').execute();
    expect(leaves).toEqual([{ status: 'resuming' }]);

    // The new holder resumes the run itself and finishes it, alone.
    await releaseRunLease(runId, other!.token);
    const fresh = await withRunLease(runId, (lease) => resumeTimerParkedRun({ runId, teamId }, new Date(), lease));
    expect(fresh).toEqual({ kind: 'held', value: 'done' });
    expect(texts).toEqual(['last', 'last']);
    expect(await runRow(runId)).toEqual({ status: 'success', failure_reason: null });
    expect((await getCallback(callback!.id))?.status).toBe('revoked');
    expect(await parkedRows(runId)).toBe(0);
  });

  it("a settle that missed the lease check still cannot finish the run: the terminal write is fenced by the lease's token", async () => {
    const { triggerId } = await seedMovement(teamId, {
      source: SLEEP_THEN_LAST,
      firedName: 'sleep_then_last',
      name: 'Sleep then last',
    });
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const { runId } = await parkedRun(teamId);
    const [callback] = await listRunCallbacks(runId);
    const holder = await claimRunLease(runId, { owner: 'the-new-holder', ttlMs: 60_000 });

    const stale = new TriggerRunRecorder({
      teamId,
      triggerId,
      triggerType: 'webhook',
      triggerEvent: webhookEvent(),
      movementVersionId: null,
      existingRunId: runId,
    });
    stale.holdLease({ token: randomUUID() });
    await stale.markParked();
    await stale.finish();

    expect((await runRow(runId)).status).toBe('parked');
    expect((await getCallback(callback!.id))?.status).toBe('live');
    await releaseRunLease(runId, holder!.token);
  });
});
