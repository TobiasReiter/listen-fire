// A callback's body and the await on its `Called` edge, through the real
// engine, the real store and the work table: the body's row is written with
// the claim, the awaiter never resumes ahead of the body, and a cancel stamped
// on a run parked on the await is settled by the sweep. Only catalog
// introspection and adapter I/O are mocked (as in the timer work test).

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
import { positionData } from 'movement-engine/services/translation_graph/types';
import type { Adapter, RuntimeCapabilities } from 'movement-engine/services/translation_graph/adapter';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import type { CatalogSnapshot, InstanceSchema, PositionSchema } from 'movement-lang';
import { eventAddressKey, CURRENT_LANGUAGE_VERSION } from 'movement-lang';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import { registerTimerWork, settleCancelledTimersHandler } from '../timer_resume';
import { drainUntilIdle, resetWorkHandlersForTests } from '../../work/drain';
import * as runLease from '../run_lease';
import { fireCallback, registerCallbackFireWork } from '../callback_fire';
import { registerAwaitWork, resumeAwaitsForCorrelation } from '../await_resume';
import { getCallback, listRunCallbacks } from '../callback_store';
import { CALLBACK_AWAIT_TYPE } from 'engine-contracts';
import { testWorkContext } from '../../../test/harness/work';
import { postgresRunHostStore } from '../run_host_store';

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

const TAP_THEN_RESUME = [
  'import { attio, slack } from adapters',
  'import { acme_main, acme_slack } from credentials',
  '',
  'crm = attio(credentials: acme_main)',
  'chat = slack(credentials: acme_slack)',
  '',
  'movement tap_then_resume(ev: <crm-[:`Webhook Event`]->>) {',
  '  cb = callback({',
  '    write chat-[:messages]-> {',
  '      channel: "#alerts"',
  '      text: "body"',
  '    }',
  '  })',
  '  c = await FIRST(cb-[:Called]->)',
  '  write chat-[:messages]-> {',
  '    channel: "#alerts"',
  '    text: "after"',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created"] } fire tap_then_resume',
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



async function awaitParkedRun(teamId: TeamId): Promise<{ runId: TriggerRunId; callbackId: string }> {
  const row = await getAutomationsQb(['parked_run', 'trigger_run'])
    .selectFrom('parked_run')
    .innerJoin('trigger_run', 'trigger_run.id', 'parked_run.run_id')
    .where('trigger_run.team_id', '=', teamId)
    .where('parked_run.park_reason', '=', 'await')
    .where('parked_run.status', '=', 'parked')
    .select('parked_run.run_id as runId')
    .executeTakeFirstOrThrow();
  const [callback] = await listRunCallbacks(row.runId);
  if (callback === undefined) throw new Error('test: the run minted no callback');
  return { runId: row.runId, callbackId: callback.id };
}

async function runRow(runId: TriggerRunId) {
  return getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select(['status', 'failure_reason'])
    .executeTakeFirstOrThrow();
}

/** Every row of the team due now, as the clock would make them. */
async function makeTeamWorkDue(teamId: TeamId): Promise<void> {
  await getAutomationsQb(['work'])
    .updateTable('work')
    .set({ due_at: new Date(Date.now() - 1_000) })
    .where('team_id', '=', teamId)
    .execute();
}

/** A few passes of the drain with every row made due before each, as time
 *  passing would: a row deferred behind another of the same run runs next. */
async function drainAsTheClockWould(teamId: TeamId): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    await makeTeamWorkDue(teamId);
    await drainUntilIdle({ owner: 't' });
  }
}

async function fireCallbackRows(teamId: TeamId) {
  return getAutomationsQb(['work'])
    .selectFrom('work')
    .where('kind', '=', 'fire_callback')
    .where('team_id', '=', teamId)
    .select(['key', 'due_at'])
    .execute();
}

describe('a callback body and the await on its call (real engine, real DB)', () => {
  let teamId: TeamId;
  let texts: unknown[];

  beforeAll(() => {
    resetWorkHandlersForTests();
    registerAwaitWork();
    registerCallbackFireWork();
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
      .values({ id: teamId, name: `cb-order-${teamId.slice(0, 8)}` } as any)
      .execute();

    const catalog = buildCatalog();
    mockedCatalog.mockResolvedValue({
      snapshot: catalog,
      credentialIds: Object.fromEntries(Object.keys(catalog.credentials).map((name) => [name, 'cred-1'])),
      notes: [],
    });

    const target = makeSlackTargetFake();
    texts = [];
    target.adapter.createRecord = async (input) => {
      texts.push(input.fields.text);
      return { adapterType: 'slack', externalId: `msg-${texts.length}`, data: {} };
    };
    mockedResolve.mockImplementation(async ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'attio') return makeAttioSourceFake();
      if (adapterType === 'slack') return target.adapter;
      throw new Error(`test: no fake for '${adapterType}'`);
    });

    const { triggerId } = await seedMovement(teamId, {
      source: TAP_THEN_RESUME,
      firedName: 'tap_then_resume',
      name: 'Tap then resume',
    });
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await cleanupTeam(teamId);
    jest.clearAllMocks();
  });

  it('a tap on a free run runs the body, then resumes the awaiter; its queued row then does nothing', async () => {
    const { runId, callbackId } = await awaitParkedRun(teamId);

    const outcome = await fireCallback({ id: callbackId, values: {}, awaitExecution: true });

    expect(outcome).toMatchObject({ kind: 'recorded' });
    expect(texts).toEqual(['body', 'after']);
    expect((await runRow(runId)).status).toBe('success');
    // The body's row was written with the claim, every time.
    expect(await fireCallbackRows(teamId)).toHaveLength(1);
    await makeTeamWorkDue(teamId);
    await drainUntilIdle({ owner: 't' });
    expect(texts).toEqual(['body', 'after']);
    expect(await fireCallbackRows(teamId)).toHaveLength(0);
  });

  it('a queued body and a backstop wake: the awaiter does not resume before the body ran', async () => {
    const { runId, callbackId } = await awaitParkedRun(teamId);
    const elsewhere = await postgresRunHostStore.leases.claim({ runId, ttlMs: 60_000 });
    expect(elsewhere).not.toBeNull();

    const outcome = await fireCallback({ id: callbackId, values: {} });
    expect(outcome).toMatchObject({ kind: 'recorded', queued: true });
    await postgresRunHostStore.leases.release({ runId, token: elsewhere!.token });

    // The backstop wake reaches the run first: the call is on the ledger, but
    // its body has not started, so the await has nothing to resolve on.
    await resumeAwaitsForCorrelation({ adapterType: CALLBACK_AWAIT_TYPE, teamId, correlationKey: callbackId });
    expect(texts).toEqual([]);
    expect((await runRow(runId)).status).toBe('parked');
    expect((await getCallback(callbackId))?.calls).toHaveLength(1);

    // The queued body runs, and only then does the awaiter resume.
    await drainUntilIdle({ owner: 't' });
    expect(texts).toEqual(['body', 'after']);
    expect((await runRow(runId)).status).toBe('success');
  });

  it('a process that dies after the claim, before the body is marked, leaves the body to its row, which runs it once', async () => {
    const { runId, callbackId } = await awaitParkedRun(teamId);
    // Everything after the claim fails, as if the process stopped there.
    jest.spyOn(runLease, 'takeRunLease').mockRejectedValueOnce(new Error('test: the process died'));

    const outcome = await fireCallback({ id: callbackId, values: {} });
    expect(outcome).toMatchObject({ kind: 'recorded', queued: true });
    expect(texts).toEqual([]);
    expect((await getCallback(callbackId))?.calls[0]?.bodyStartedAt).toBeUndefined();

    // The body's row and the wake's both come due; whichever holds the run
    // first defers the other, which runs on the next pass.
    await drainAsTheClockWould(teamId);
    expect(texts).toEqual(['body', 'after']);
    expect((await runRow(runId)).status).toBe('success');

    // Nothing is left to run it a second time.
    await makeTeamWorkDue(teamId);
    await drainUntilIdle({ owner: 't' });
    expect(texts).toEqual(['body', 'after']);
  });

  it('a cancel stamped on a run parked on an await is settled by the sweep, and its callbacks are revoked', async () => {
    const { runId, callbackId } = await awaitParkedRun(teamId);
    // Stamped while another entry held the run; that entry finished without
    // parking again, so nothing read the stamp.
    await getAutomationsQb(['trigger_run'])
      .updateTable('trigger_run')
      .set({ cancel_requested_at: new Date(), cancel_reason: 'Stopped by the operator' })
      .where('id', '=', runId)
      .execute();

    await settleCancelledTimersHandler.run({}, testWorkContext());

    expect(await runRow(runId)).toEqual({ status: 'failed', failure_reason: 'Stopped by the operator' });
    expect((await getCallback(callbackId))?.status).toBe('revoked');
    const parked = await getAutomationsQb(['parked_run']).selectFrom('parked_run').where('run_id', '=', runId).select('id').execute();
    expect(parked).toHaveLength(0);
  });
});
