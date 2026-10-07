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
import type { TriggerRunRecorder } from '../../translation_graph/runs/trigger_run';
import { registerTimerWork, settleCancelledTimersHandler, timerWorkKey } from '../timer_resume';
import { testWorkContext } from '../../../test/harness/work';
import { makeRecorderParkSink } from '../park_sink';
import { drainUntilIdle, drainWork, resetWorkHandlersForTests } from '../../work/drain';

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
    await sink.commitTimerPark({ address, state: parked.state, wakeAt: laterWake });

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
});
