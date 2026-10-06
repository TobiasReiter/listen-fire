// The BYO webhook door through the work table: a delivery leaves a receipt and
// a work row before anything runs, and draining the rows runs the movement or
// wakes the parked await. Delivery → receipt → row → drain → run is real; only
// catalog introspection, adapter I/O and (for the await wake) the engine step
// are mocked.

import { createHmac, randomUUID } from 'node:crypto';

jest.mock('../../translation_graph/movement/catalog', () => {
  const actual = jest.requireActual('../../translation_graph/movement/catalog');
  return { ...actual, movementCatalogForTeam: jest.fn() };
});
jest.mock('../../translation_graph/adapters/resolve', () => {
  const actual = jest.requireActual('../../translation_graph/adapters/resolve');
  return { ...actual, resolveAdapter: jest.fn() };
});
jest.mock('../../translation_graph/movement/execute', () => {
  const actual = jest.requireActual('../../translation_graph/movement/execute');
  return { ...actual, resumeMovementFiring: jest.fn() };
});
jest.mock('../../translation_graph/triggers/router', () => {
  const actual = jest.requireActual('../../translation_graph/triggers/router');
  return { ...actual, dispatchTriggerByIdEvent: jest.fn(actual.dispatchTriggerByIdEvent) };
});

import { getAutomationsQb, getCoreQb, getQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { testWorkContext } from '../../../test/harness/work';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { TriggerEventId } from '../../../generated/kysely/automations/TriggerEvent';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import type { WebhookSubscriptionId } from '../../../generated/kysely/automations/WebhookSubscription';
import type { PipelineConfigurationId } from '../../../generated/kysely/public/PipelineConfiguration';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import type { Catalog, InstanceSchema, PositionSchema } from 'movement-lang';
import { eventAddressKey, CURRENT_LANGUAGE_VERSION } from 'movement-lang';
import { movementCatalogForTeam, staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { resolveAdapter } from '../../translation_graph/adapters/resolve';
import { resumeMovementFiring } from '../../translation_graph/movement/execute';
import { dispatchTriggerByIdEvent } from '../../translation_graph/triggers/router';
import { mintMovementVersionIfChanged } from '../../translation_graph/movement/version_store';
import { positionData } from '../../translation_graph/types';
import type { Adapter, DiscriminableEvent, RuntimeCapabilities } from '../../translation_graph/adapter';
import { loadCorrelatedParks, registerAwaitCorrelation } from '../../translation_graph/adapters/await_correlation';
import { dispatchEventHandler, registerDispatchWork } from '../../translation_graph/triggers/dispatch_event';
import { registerAwaitWork } from '../../movement_engine/await_resume';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../work/drain';
import { handleInboundWebhook } from '../handler';

const mockedCatalog = movementCatalogForTeam as jest.Mock;
const mockedResolve = resolveAdapter as jest.Mock;
const mockedResume = resumeMovementFiring as jest.Mock;
const mockedDispatch = dispatchTriggerByIdEvent as jest.Mock;

const SECRET = 'inbound-work-secret';

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
  graftPositions[key] = { properties: { action: { kind: 'enum', options: ACTIONS } }, edges: {} };
}
const ATTIO_SCHEMA: InstanceSchema = {
  positions: {
    [EVENT]: { properties: { action: { kind: 'enum', options: ACTIONS } }, edges: {} },
    ...graftPositions,
  },
  collections: {},
  unions: { [EVENT]: graftVariants },
  writableRoots: {},
  eventPosition: EVENT,
  eventPositions: [{ position: EVENT }],
};

function buildCatalog(): Catalog {
  const base = staticCatalogFromManifests({
    credentials: { acme_main: { adapters: ['attio'] }, acme_slack: { adapters: ['slack'] } },
  });
  return {
    ...base,
    instantiate(name, args) {
      if (name === 'attio') return ATTIO_SCHEMA;
      return base.instantiate(name, args);
    },
  };
}

/** A fake adapter whose inbound seam hands back `events` verbatim. */
function makeFakeAdapter(adapterType: string, events: () => DiscriminableEvent[]): Adapter {
  return {
    adapterType,
    supportedTriggers: ['webhook'] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async preprocessInbound() {
      return { events: events() };
    },
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
    async createRecord(input) {
      return { adapterType, externalId: `rec-${randomUUID()}`, data: input.fields };
    },
    async updateRecord() {
      throw new Error('test: no updates');
    },
    async deleteRecord() {
      return {};
    },
  };
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

async function seedMovementTrigger(teamId: TeamId): Promise<TriggerId> {
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
    .values({ id: movementId, team_id: teamId, name: 'Sleep then notify', source: SLEEP_THEN_NOTIFY } as any)
    .execute();
  await mintMovementVersionIfChanged({
    teamId,
    movementId,
    source: SLEEP_THEN_NOTIFY,
    languageVersion: CURRENT_LANGUAGE_VERSION,
  });
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
      fired_movement_name: 'sleep_then_notify',
    } as any)
    .execute();
  return triggerId;
}

async function seedSubscription(
  teamId: TeamId,
  provider: 'ATTIO' | 'SLACK',
): Promise<WebhookSubscriptionId> {
  const credentialsId = randomUUID() as ExternalServiceCredentialsId;
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({ id: credentialsId, name: `${provider} creds`, team_id: teamId, type: ExternalServiceType[provider] })
    .execute();
  const subscriptionId = randomUUID() as WebhookSubscriptionId;
  await getAutomationsQb(['webhook_subscription'])
    .insertInto('webhook_subscription')
    .values({ id: subscriptionId, team_id: teamId, provider, credentials_id: credentialsId, webhook_secret: SECRET })
    .execute();
  return subscriptionId;
}

function attioDelivery(subscriptionId: string) {
  const rawBody = Buffer.from(JSON.stringify({ events: [{ event_type: 'record.created' }] }));
  return {
    provider: 'ATTIO',
    subscriptionId,
    rawBody,
    signatureHeader: createHmac('sha256', SECRET).update(rawBody).digest('hex'),
  };
}

function slackDelivery(subscriptionId: string) {
  const rawBody = Buffer.from(JSON.stringify({ type: 'event_callback', event: { type: 'message' } }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', SECRET).update(`v0:${timestamp}:${rawBody.toString('utf-8')}`).digest('hex');
  return { provider: 'SLACK', subscriptionId, rawBody, signatureHeader: `${timestamp}:v0=${signature}` };
}

const ATTIO_EVENT: DiscriminableEvent = {
  payload: { event_type: 'record.created', action: 'record.created', id: { object_id: 'obj-x', record_id: 'co-1' } },
  changeType: 'create',
  eventType: 'record.created',
};

async function receipts(teamId: TeamId) {
  return getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('team_id', '=', teamId)
    .select(['id', 'status'])
    .execute();
}

async function workRows(teamId: TeamId, kind: string) {
  return getAutomationsQb(['work'])
    .selectFrom('work')
    .where('team_id', '=', teamId)
    .where('kind', '=', kind)
    .selectAll()
    .execute();
}

async function runsFor(triggerId: TriggerId) {
  return getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('trigger_id', '=', triggerId)
    .select(['id', 'status', 'failure_reason', 'trigger_event_id'])
    .execute();
}

/** Capture one delivery and return its receipt id and its row's payload, undrained. */
async function capturedUndrained(teamId: TeamId): Promise<{ receiptId: string; payload: unknown }> {
  const subscriptionId = await seedSubscription(teamId, 'ATTIO');
  await (await handleInboundWebhook(attioDelivery(subscriptionId))).enqueueDeferred!();
  const [receipt] = await receipts(teamId);
  const [row] = await workRows(teamId, 'dispatch_event');
  return { receiptId: receipt.id, payload: row.payload };
}

/** What a first attempt that died mid-run leaves: a running row naming the receipt. */
async function seedRunningRun(input: {
  teamId: TeamId;
  triggerId: TriggerId;
  receiptId: string;
  status: string;
  lastHeartbeatAt: Date;
}): Promise<TriggerRunId> {
  const runId = randomUUID() as TriggerRunId;
  await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    .values({
      id: runId,
      team_id: input.teamId,
      trigger_id: input.triggerId,
      trigger_type: 'webhook',
      status: input.status,
      started_at: input.lastHeartbeatAt,
      last_heartbeat_at: input.lastHeartbeatAt,
      trigger_event_id: input.receiptId as TriggerEventId,
    })
    .execute();
  return runId;
}

const RECOVER_CTX = () => ({ ...testWorkContext(), attempts: 2 });

describe('inbound webhook deliveries run through the work table (real DB)', () => {
  let teamId: TeamId;
  let slackEvents: DiscriminableEvent[];
  let attioEvents: DiscriminableEvent[];

  beforeAll(() => {
    resetWorkHandlersForTests();
    registerDispatchWork();
    registerAwaitWork();
    // The door's notify would drain in-process; the test drains explicitly.
    setWorkNotifier({ notify() {} });
  });

  afterAll(() => {
    setWorkNotifier(inProcessNotifier);
    resetWorkHandlersForTests();
  });

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `inbound-work-${teamId.slice(0, 8)}` } as any)
      .execute();

    mockedCatalog.mockResolvedValue({
      catalog: buildCatalog(),
      resolveCredentialId: () => 'cred-1',
      credentialsByName: {},
      resolveFile: () => null,
      notes: [],
      gaps: [],
    });
    slackEvents = [];
    attioEvents = [ATTIO_EVENT];
    mockedResolve.mockImplementation(async ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'attio') return makeFakeAdapter('attio', () => attioEvents);
      if (adapterType === 'slack') return makeFakeAdapter('slack', () => slackEvents);
      throw new Error(`test: no fake for '${adapterType}'`);
    });
  });

  afterEach(async () => {
    await cleanupTeam(teamId);
    jest.clearAllMocks();
  });

  it('a delivery leaves a received receipt and a dispatch_event row; draining runs the movement', async () => {
    const triggerId = await seedMovementTrigger(teamId);
    const subscriptionId = await seedSubscription(teamId, 'ATTIO');

    const result = await handleInboundWebhook(attioDelivery(subscriptionId));
    expect(result).toMatchObject({ ok: true, eventsProcessed: 1 });
    await result.enqueueDeferred!();

    const [receipt] = await receipts(teamId);
    expect(receipt.status).toBe('received');
    const rows = await workRows(teamId, 'dispatch_event');
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(`dispatch_event:${receipt.id}`);
    expect(await runsFor(triggerId)).toHaveLength(0);

    await drainUntilIdle({ owner: 'test' });

    expect((await receipts(teamId))[0].status).toBe('dispatched');
    const runs = await runsFor(triggerId);
    expect(runs).toHaveLength(1);
    // The run names the receipt it came from.
    expect(runs[0].trigger_event_id).toBe(receipt.id);
    expect(await workRows(teamId, 'dispatch_event')).toHaveLength(0);
  });

  it('a source timestamp with an offset still runs', async () => {
    const triggerId = await seedMovementTrigger(teamId);
    const subscriptionId = await seedSubscription(teamId, 'ATTIO');
    attioEvents = [{ ...ATTIO_EVENT, occurredAt: '2026-10-06T12:00:00+02:00' }];

    const result = await handleInboundWebhook(attioDelivery(subscriptionId));
    await result.enqueueDeferred!();
    const drained = await drainUntilIdle({ owner: 'test' });

    expect(drained.failed).toBe(0);
    expect((await receipts(teamId))[0].status).toBe('dispatched');
    expect(await runsFor(triggerId)).toHaveLength(1);
  });

  it('a redelivery of a receipt that never ran queues its lost row again', async () => {
    const triggerId = await seedMovementTrigger(teamId);
    const subscriptionId = await seedSubscription(teamId, 'ATTIO');
    attioEvents = [{ ...ATTIO_EVENT, idempotencyKey: 'delivery-1' }];

    await (await handleInboundWebhook(attioDelivery(subscriptionId))).enqueueDeferred!();
    const [receipt] = await receipts(teamId);
    // The row is lost after the receipt landed.
    await getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', teamId).execute();

    await (await handleInboundWebhook(attioDelivery(subscriptionId))).enqueueDeferred!();

    expect(await receipts(teamId)).toHaveLength(1);
    const rows = await workRows(teamId, 'dispatch_event');
    expect(rows.map((r) => r.key)).toEqual([`dispatch_event:${receipt.id}`]);
    await drainUntilIdle({ owner: 'test' });
    expect((await receipts(teamId))[0].status).toBe('dispatched');
    expect(await runsFor(triggerId)).toHaveLength(1);

    // Once it ran, a further redelivery queues nothing.
    await (await handleInboundWebhook(attioDelivery(subscriptionId))).enqueueDeferred!();
    expect(await workRows(teamId, 'dispatch_event')).toHaveLength(0);
  });

  it('a Slack thread reply queues a wake_await row; draining resumes the parked await', async () => {
    const triggerId = await seedMovementTrigger(teamId);
    await dispatchTriggerByIdEvent({
      triggerId,
      teamId,
      event: {
        pipelineInputId: `trigger:${triggerId}`,
        adapterType: 'attio',
        triggerType: 'webhook',
        payload: ATTIO_EVENT.payload,
        changeType: 'create',
        occurredAt: new Date().toISOString(),
      },
    });
    const [run] = await runsFor(triggerId);
    const runId = run.id as TriggerRunId;
    const timerPark = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .where('run_id', '=', runId)
      .select('state')
      .executeTakeFirstOrThrow();
    // A reply await parked beside the run's sleep, registered on its thread.
    await getAutomationsQb(['parked_run'])
      .insertInto('parked_run')
      .values({ run_id: runId, address: 'await-reply', state: JSON.stringify(timerPark.state), park_reason: 'await' })
      .execute();
    const correlationKey = 'C123:1700000000.000100';
    await registerAwaitCorrelation({ adapterType: 'slack', correlationKey, runId, teamId, address: 'await-reply' });
    mockedResume.mockResolvedValue({ result: { parked: false } });

    const subscriptionId = await seedSubscription(teamId, 'SLACK');
    slackEvents = [{ payload: { channel: 'C123', thread_ts: '1700000000.000100', text: 'approved' } }];
    const result = await handleInboundWebhook(slackDelivery(subscriptionId));
    expect(result.ok).toBe(true);
    await result.enqueueDeferred!();

    const wakes = await workRows(teamId, 'wake_await');
    expect(wakes).toHaveLength(1);
    expect(wakes[0].payload).toEqual({ adapterType: 'slack', teamId, correlationKey });
    expect(mockedResume).not.toHaveBeenCalled();

    await drainUntilIdle({ owner: 'test' });

    expect(mockedResume).toHaveBeenCalledWith(expect.objectContaining({ runId, reenter: true }));
    expect(await loadCorrelatedParks({ adapterType: 'slack', teamId, correlationKey })).toEqual([]);
    const awaitPark = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .where('run_id', '=', runId)
      .where('address', '=', 'await-reply')
      .select('id')
      .executeTakeFirst();
    expect(awaitPark).toBeUndefined();
    expect(await workRows(teamId, 'wake_await')).toHaveLength(0);
  });

  it('recover on an already-dispatched receipt does not dispatch it again', async () => {
    const triggerId = await seedMovementTrigger(teamId);
    const subscriptionId = await seedSubscription(teamId, 'ATTIO');
    const result = await handleInboundWebhook(attioDelivery(subscriptionId));
    await result.enqueueDeferred!();
    const [row] = await workRows(teamId, 'dispatch_event');
    await drainUntilIdle({ owner: 'test' });
    expect((await receipts(teamId))[0].status).toBe('dispatched');
    mockedDispatch.mockClear();

    await dispatchEventHandler.recover!(row.payload, { ...testWorkContext(), attempts: 2 });

    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(await runsFor(triggerId)).toHaveLength(1);
  });

  describe('dispatchEventHandler.recover finds the run its first attempt started', () => {
    it('no run yet: dispatches', async () => {
      const triggerId = await seedMovementTrigger(teamId);
      const { receiptId, payload } = await capturedUndrained(teamId);

      await dispatchEventHandler.recover!(payload, RECOVER_CTX());

      expect(mockedDispatch).toHaveBeenCalledTimes(1);
      expect((await receipts(teamId))[0].status).toBe('dispatched');
      const runs = await runsFor(triggerId);
      expect(runs).toHaveLength(1);
      expect(runs[0].trigger_event_id).toBe(receiptId);
    });

    it('an orphaned running run: fails the run and the receipt, without dispatching', async () => {
      const triggerId = await seedMovementTrigger(teamId);
      const { receiptId, payload } = await capturedUndrained(teamId);
      const runId = await seedRunningRun({
        teamId,
        triggerId,
        receiptId,
        status: 'running',
        lastHeartbeatAt: new Date(Date.now() - 10 * 60_000),
      });

      await dispatchEventHandler.recover!(payload, RECOVER_CTX());

      expect(mockedDispatch).not.toHaveBeenCalled();
      const [run] = await runsFor(triggerId);
      expect(run).toMatchObject({ id: runId, status: 'failed' });
      expect(run.failure_reason).toContain('segment did not complete');
      expect((await receipts(teamId))[0].status).toBe('failed');
    });

    it('a live running run: leaves it to finish, without dispatching', async () => {
      const triggerId = await seedMovementTrigger(teamId);
      const { receiptId, payload } = await capturedUndrained(teamId);
      await seedRunningRun({ teamId, triggerId, receiptId, status: 'running', lastHeartbeatAt: new Date() });

      await dispatchEventHandler.recover!(payload, RECOVER_CTX());

      expect(mockedDispatch).not.toHaveBeenCalled();
      expect(await runsFor(triggerId)).toEqual([expect.objectContaining({ status: 'running' })]);
      expect((await receipts(teamId))[0].status).toBe('received');
    });

    it('a parked or settled run: marks the receipt dispatched, without dispatching', async () => {
      const triggerId = await seedMovementTrigger(teamId);
      const { receiptId, payload } = await capturedUndrained(teamId);
      await seedRunningRun({ teamId, triggerId, receiptId, status: 'parked', lastHeartbeatAt: new Date() });

      await dispatchEventHandler.recover!(payload, RECOVER_CTX());

      expect(mockedDispatch).not.toHaveBeenCalled();
      expect((await receipts(teamId))[0].status).toBe('dispatched');
    });
  });
});
