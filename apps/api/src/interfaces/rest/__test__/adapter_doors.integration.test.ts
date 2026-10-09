// A remote adapter's inbound, end to end against the real DB and a real remote:
// the fake CRM runs behind the wire protocol on an ephemeral server and is
// installed for a test team. Three ways in, all real down to the work rows:
//
//   • the HOST owns the URL — the reconciler subscribes over the wire, the CRM
//     delivers a signed webhook to the webhook-sync door, and the door reads it
//     over the wire (preprocessInbound, listEventTypes, wakeKeys);
//   • the REMOTE pushes events through `emit`;
//   • the REMOTE pushes correlation keys through `wake`.
//
// Only the engine's resume step is mocked (what a wake row drives is under test,
// not the interpreter) and the credential lifecycle hook install fires.

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import express from 'express';

import type { AddressInfo } from 'node:net';

jest.mock('../../../services/credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));
jest.mock('../../../services/translation_graph/movement/execute', () => {
  const actual = jest.requireActual('../../../services/translation_graph/movement/execute');
  return { ...actual, resumeMovementFiring: jest.fn() };
});

import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { MovementVersionId } from '../../../generated/kysely/automations/MovementVersion';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { PipelineConfigurationId } from '../../../generated/kysely/public/PipelineConfiguration';

import { cleanupTeam } from '../../../test/harness/cleanup';
import { getAutomationsQb, getCoreQb, getQb } from '../../../lib/kysely';
import {
  FAKE_CRM_ADAPTER_TYPE,
  FAKE_CRM_COMPANY_CREATED,
  fakeCrmManifest,
  fakeCrmThreadKey,
  startFakeCrmServer,
  type FakeCrmDelivery,
  type FakeCrmServer,
} from '../../../scripts/dev/fake_crm_adapter';
import { RemoteAdapterManifestInput } from '../../../services/translation_graph/adapters/remote/manifest';
import { installRemoteAdapterFromManifest } from '../../../services/translation_graph/adapters/remote/install';
import { upsertRemoteAdapter } from '../../../services/translation_graph/adapters/remote/store';
import { mintRemoteCredential } from '../../../services/credentials/remote_credential';
import { loadCorrelatedParks, registerAwaitCorrelation } from '../../../services/translation_graph/adapters/await_correlation';
import { syncListenSubscriptions } from '../../../services/translation_graph/movement/listen_subscriptions';
import { mintMovementVersionIfChanged } from '../../../services/translation_graph/movement/version_store';
import { resumeMovementFiring } from '../../../services/translation_graph/movement/execute';
import { registerDispatchWork } from '../../../services/translation_graph/triggers/dispatch_event';
import { registerAwaitWork } from '../../../services/movement_engine/await_resume';
import {
  drainUntilIdle,
  inProcessNotifier,
  resetWorkHandlersForTests,
  setWorkNotifier,
} from '../../../services/work/drain';
import { signRemoteDelivery, REMOTE_SIGNATURE_HEADER } from '../../../services/webhook_sync/remote_inbound';
import { webhookSyncRouter } from '../webhookSync';
import { adapterDoorsRouter } from '../adapterDoors';

const mockedResume = resumeMovementFiring as jest.Mock;

const SECRET = `acme-${randomUUID()}`;
const OTHER_SECRET = `beta-${randomUUID()}`;
const OTHER_ADAPTER_TYPE = `beta_crm_${randomUUID().slice(0, 8)}`;

let host: Server;
let hostUrl: string;
let crm: FakeCrmServer;
let otherCrm: FakeCrmServer;
let teamId: TeamId;
let otherTeamId: TeamId;
let triggerId: TriggerId;
let versionId: MovementVersionId;

async function createTeam(label: string): Promise<TeamId> {
  const id = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id, name: `${label}-${id.slice(0, 8)}` } as any)
    .execute();
  return id;
}

const SOURCE = 'movement on_company(ev) {\n}\n';

/** A movement-derived listen on the CRM, as a save would reconcile it. */
async function seedListen(team: TeamId): Promise<{ triggerId: TriggerId; versionId: MovementVersionId }> {
  const pipelineConfigurationId = randomUUID() as PipelineConfigurationId;
  await getQb(['pipeline_configuration'])
    .insertInto('pipeline_configuration')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: pipelineConfigurationId, team_id: team, name: `cfg-${pipelineConfigurationId.slice(0, 8)}` } as any)
    .execute();
  const movementId = randomUUID() as MovementId;
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: movementId, team_id: team, name: `crm ${movementId.slice(0, 8)}`, source: SOURCE } as any)
    .execute();
  const minted = await mintMovementVersionIfChanged({
    teamId: team,
    movementId,
    source: SOURCE,
    languageVersion: CURRENT_LANGUAGE_VERSION,
  });
  const id = randomUUID() as TriggerId;
  await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      id,
      team_id: team,
      pipeline_configuration_id: pipelineConfigurationId,
      name: 'CRM companies',
      kind: FAKE_CRM_ADAPTER_TYPE,
      config: JSON.stringify({ events: [FAKE_CRM_COMPANY_CREATED] }),
      movement_id: movementId,
      fired_movement_name: 'on_company',
    } as any)
    .execute();
  return { triggerId: id, versionId: minted.versionId as MovementVersionId };
}

async function receipts(team: TeamId) {
  return getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('team_id', '=', team)
    .select(['id', 'trigger_id', 'status'])
    .execute();
}

async function workRows(team: TeamId, kind?: string) {
  let q = getAutomationsQb(['work']).selectFrom('work').where('team_id', '=', team);
  if (kind !== undefined) q = q.where('kind', '=', kind);
  return q.selectAll().execute();
}

async function post(path: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(`${hostUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const BEARER = () => ({ authorization: `Bearer ${SECRET}` });

beforeAll(async () => {
  resetWorkHandlersForTests();
  registerDispatchWork();
  registerAwaitWork();
  // The doors poke the drain; the test drains explicitly.
  setWorkNotifier({ notify() {} });

  const app = express();
  app.use('/api/public/webhook-sync', express.raw({ type: 'application/json' }), webhookSyncRouter);
  app.use('/api/public/adapter', adapterDoorsRouter);
  host = createServer(app);
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  hostUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;

  crm = await startFakeCrmServer({ secret: SECRET });
  otherCrm = await startFakeCrmServer({ secret: OTHER_SECRET });
});

afterAll(async () => {
  setWorkNotifier(inProcessNotifier);
  resetWorkHandlersForTests();
  await crm.close();
  await otherCrm.close();
  await new Promise<void>((resolve) => host.close(() => resolve()));
});

beforeEach(async () => {
  teamId = await createTeam('adapter-doors');
  otherTeamId = await createTeam('adapter-doors-other');
  await installRemoteAdapterFromManifest({
    teamId,
    manifest: RemoteAdapterManifestInput.parse(fakeCrmManifest(crm.baseUrl)),
    secret: SECRET,
  });
  await installRemoteAdapterFromManifest({
    teamId: otherTeamId,
    manifest: RemoteAdapterManifestInput.parse({ ...fakeCrmManifest(otherCrm.baseUrl), adapterType: OTHER_ADAPTER_TYPE }),
    secret: OTHER_SECRET,
  });
  ({ triggerId, versionId } = await seedListen(teamId));
  crm.subscriptions.length = 0;
});

afterEach(async () => {
  await cleanupTeam(teamId);
  await cleanupTeam(otherTeamId);
  jest.clearAllMocks();
});

describe('the host owns the URL: the webhook door reaches the remote adapter', () => {
  async function subscribe(): Promise<{ subscriptionId: string; secret: string }> {
    const { notes } = await syncListenSubscriptions({ teamId });
    expect(notes).toEqual([]);
    const [row] = await getAutomationsQb(['webhook_subscription'])
      .selectFrom('webhook_subscription')
      .where('team_id', '=', teamId)
      .where('deleted_at', 'is', null)
      .select(['id', 'provider', 'webhook_secret', 'external_webhook_id', 'status'])
      .execute();
    const [registered] = crm.subscriptions;
    expect(row).toMatchObject({
      provider: 'ACME_CRM',
      status: 'active',
      webhook_secret: registered.secret,
      external_webhook_id: registered.externalId,
    });
    expect(registered.callbackUrl).toMatch(new RegExp(`/api/public/webhook-sync/acme_crm/${row.id}$`));
    expect(registered.events).toEqual([FAKE_CRM_COMPANY_CREATED]);
    return { subscriptionId: row.id, secret: registered.secret };
  }

  function deliver(subscriptionId: string, body: FakeCrmDelivery, signature: string) {
    return post(`/api/public/webhook-sync/acme_crm/${subscriptionId}`, JSON.stringify(body), {
      [REMOTE_SIGNATURE_HEADER]: signature,
    });
  }

  it('a signed delivery is read over the wire and receipted against the listen', async () => {
    const { subscriptionId, secret } = await subscribe();
    const body: FakeCrmDelivery = { companies: [{ id: 'co-1', Name: 'Acme' }] };

    const res = await deliver(subscriptionId, body, signRemoteDelivery(Buffer.from(JSON.stringify(body)), secret));

    expect(res).toEqual({ status: 200, body: { ok: true, eventsProcessed: 1 } });
    const [receipt] = await receipts(teamId);
    expect(receipt).toMatchObject({ trigger_id: triggerId, status: 'received' });
    expect(await workRows(teamId, 'dispatch_event')).toHaveLength(1);
  });

  it("a comment in the delivery queues a wake for the remote's own key", async () => {
    const { subscriptionId, secret } = await subscribe();
    const body: FakeCrmDelivery = { comments: [{ thread: 't1', text: 'approved' }] };

    const res = await deliver(subscriptionId, body, signRemoteDelivery(Buffer.from(JSON.stringify(body)), secret));

    expect(res.status).toBe(200);
    const wakes = await workRows(teamId, 'wake_await');
    expect(wakes.map((w) => w.payload)).toEqual([
      { adapterType: FAKE_CRM_ADAPTER_TYPE, teamId, correlationKey: fakeCrmThreadKey('t1') },
    ]);
  });

  it('a delivery signed with anything but the subscription secret is refused, and nothing is queued', async () => {
    const { subscriptionId } = await subscribe();
    const body: FakeCrmDelivery = { companies: [{ id: 'co-1', Name: 'Acme' }] };

    const res = await deliver(subscriptionId, body, signRemoteDelivery(Buffer.from(JSON.stringify(body)), SECRET));

    expect(res.status).toBe(401);
    expect(await receipts(teamId)).toEqual([]);
    expect(await workRows(teamId)).toEqual([]);
  });
});

describe('the remote owns the URL: emit', () => {
  it('an event for a listen leaves a receipt and a dispatch row', async () => {
    const res = await post(
      `/api/public/adapter/${FAKE_CRM_ADAPTER_TYPE}/emit`,
      { events: [{ payload: { id: 'co-2', Name: 'Beta' }, tag: FAKE_CRM_COMPANY_CREATED, eventType: FAKE_CRM_COMPANY_CREATED }] },
      BEARER(),
    );

    expect(res).toEqual({ status: 202, body: { accepted: 1 } });
    const [receipt] = await receipts(teamId);
    expect(receipt).toMatchObject({ trigger_id: triggerId, status: 'received' });
    const rows = await workRows(teamId, 'dispatch_event');
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(`dispatch_event:${receipt.id}`);
  });

  it('an event no listen selects is accepted as zero and leaves nothing behind', async () => {
    const res = await post(
      `/api/public/adapter/${FAKE_CRM_ADAPTER_TYPE}/emit`,
      { events: [{ payload: { id: 'co-3' }, eventType: 'company.deleted' }] },
      BEARER(),
    );

    expect(res).toEqual({ status: 202, body: { accepted: 0 } });
    expect(await receipts(teamId)).toEqual([]);
    expect(await workRows(teamId)).toEqual([]);
  });
});

describe('the remote owns the URL: wake', () => {
  async function parkOnThread(thread: string): Promise<TriggerRunId> {
    const runId = randomUUID() as TriggerRunId;
    await getAutomationsQb(['trigger_run'])
      .insertInto('trigger_run')
      .values({
        id: runId,
        team_id: teamId,
        trigger_id: triggerId,
        trigger_type: 'webhook',
        status: 'parked',
        movement_version_id: versionId,
        trigger_payload: JSON.stringify({
          pipelineInputId: `trigger:${triggerId}`,
          adapterType: FAKE_CRM_ADAPTER_TYPE,
          triggerType: 'webhook',
          payload: { id: 'co-1' },
        }),
      })
      .execute();
    await getAutomationsQb(['parked_run'])
      .insertInto('parked_run')
      .values({ run_id: runId, address: 'await-thread', state: JSON.stringify({}), park_reason: 'await' })
      .execute();
    await registerAwaitCorrelation({
      adapterType: FAKE_CRM_ADAPTER_TYPE,
      correlationKey: fakeCrmThreadKey(thread),
      runId,
      teamId,
      address: 'await-thread',
    });
    return runId;
  }

  it("a key a run is parked on resumes that run once the row drains", async () => {
    const runId = await parkOnThread('t1');
    mockedResume.mockResolvedValue({ result: { parked: false } });

    const res = await post(
      `/api/public/adapter/${FAKE_CRM_ADAPTER_TYPE}/wake`,
      { keys: [fakeCrmThreadKey('t1')] },
      BEARER(),
    );

    expect(res).toEqual({ status: 202, body: { accepted: 1 } });
    expect(await workRows(teamId, 'wake_await')).toHaveLength(1);
    expect(mockedResume).not.toHaveBeenCalled();

    await drainUntilIdle({ owner: 'test' });

    expect(mockedResume).toHaveBeenCalledWith(expect.objectContaining({ runId, reenter: true }));
    expect(
      await loadCorrelatedParks({ adapterType: FAKE_CRM_ADAPTER_TYPE, teamId, correlationKey: fakeCrmThreadKey('t1') }),
    ).toEqual([]);
    expect(await workRows(teamId)).toEqual([]);
  });

  it('a key nothing is parked on is accepted, and its row drains to nothing', async () => {
    const res = await post(
      `/api/public/adapter/${FAKE_CRM_ADAPTER_TYPE}/wake`,
      { keys: [fakeCrmThreadKey('nobody')] },
      BEARER(),
    );

    expect(res).toEqual({ status: 202, body: { accepted: 1 } });
    const drained = await drainUntilIdle({ owner: 'test' });

    expect(drained.failed).toBe(0);
    expect(mockedResume).not.toHaveBeenCalled();
    expect(await workRows(teamId)).toEqual([]);
  });
});

describe('the doors refuse a caller who is not the install', () => {
  it('a wrong secret is 401 at both doors, and nothing is queued for anyone', async () => {
    const wrong = { authorization: 'Bearer not-the-secret' };
    const emit = await post(`/api/public/adapter/${FAKE_CRM_ADAPTER_TYPE}/emit`, { events: [{ payload: {} }] }, wrong);
    const wake = await post(`/api/public/adapter/${FAKE_CRM_ADAPTER_TYPE}/wake`, { keys: ['k'] }, wrong);

    expect(emit).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(wake).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(await workRows(teamId)).toEqual([]);
    expect(await workRows(otherTeamId)).toEqual([]);
  });

  it('a row whose slug a built-in answers to (written past install) is 401 even with its own valid secret', async () => {
    const { credentialsId } = await mintRemoteCredential({
      teamId,
      userId: null,
      adapterType: 'slack',
      displayName: 'Shadow Slack',
      secret: SECRET,
      replaceExisting: true,
    });
    await upsertRemoteAdapter({
      teamId,
      manifest: { ...fakeCrmManifest(crm.baseUrl), adapterType: 'slack', protocolVersion: 2, credentialsId },
    });

    const wake = await post('/api/public/adapter/slack/wake', { keys: ['k'] }, BEARER());
    const emit = await post('/api/public/adapter/slack/emit', { events: [{ payload: {} }] }, BEARER());

    expect(wake).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(emit).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(await workRows(teamId)).toEqual([]);
  });

  it("one team's credential at another team's adapter type is 401, and neither team gets a row", async () => {
    const res = await post(`/api/public/adapter/${OTHER_ADAPTER_TYPE}/wake`, { keys: ['k'] }, BEARER());

    expect(res.status).toBe(401);
    expect(await workRows(teamId)).toEqual([]);
    expect(await workRows(otherTeamId)).toEqual([]);
  });

  it("the other team's own credential wakes only its own team", async () => {
    const res = await post(
      `/api/public/adapter/${OTHER_ADAPTER_TYPE}/wake`,
      { keys: ['k'] },
      { authorization: `Bearer ${OTHER_SECRET}` },
    );

    expect(res.status).toBe(202);
    expect(await workRows(teamId)).toEqual([]);
    expect((await workRows(otherTeamId, 'wake_await')).map((w) => w.payload)).toEqual([
      { adapterType: OTHER_ADAPTER_TYPE, teamId: otherTeamId, correlationKey: 'k' },
    ]);
  });

  it('an adapter type nobody installed is the same 401', async () => {
    const res = await post(`/api/public/adapter/nobody_${randomUUID().slice(0, 8)}/wake`, { keys: ['k'] }, BEARER());

    expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } });
  });

  it('two teams sharing one secret for a type: 409 until the team is named, then only that team', async () => {
    const shared = `shared-${randomUUID()}`;
    const sharedType = `shared_crm_${randomUUID().slice(0, 8)}`;
    const sharedCrm = await startFakeCrmServer({ secret: shared });
    try {
      const install = (team: TeamId, secret: string) =>
        installRemoteAdapterFromManifest({
          teamId: team,
          manifest: RemoteAdapterManifestInput.parse({ ...fakeCrmManifest(sharedCrm.baseUrl), adapterType: sharedType }),
          secret,
        });
      // The probe asks the server with the presented secret; this one answers to `shared`.
      await install(teamId, shared);
      await install(otherTeamId, shared);
      const wake = (headers: Record<string, string>) =>
        post(`/api/public/adapter/${sharedType}/wake`, { keys: ['k'] }, headers);

      const ambiguous = await wake({ authorization: `Bearer ${shared}` });
      expect(ambiguous.status).toBe(409);
      expect(await workRows(teamId)).toEqual([]);
      expect(await workRows(otherTeamId)).toEqual([]);

      const named = await wake({ authorization: `Bearer ${shared}`, 'x-listen-fire-team': otherTeamId });
      expect(named.status).toBe(202);
      expect(await workRows(teamId)).toEqual([]);
      expect((await workRows(otherTeamId, 'wake_await')).map((w) => w.payload)).toEqual([
        { adapterType: sharedType, teamId: otherTeamId, correlationKey: 'k' },
      ]);
    } finally {
      await sharedCrm.close();
    }
  });

  it('two teams with different secrets for one type: each secret reaches its own team only, and naming the other team is 401', async () => {
    const typeName = `twin_crm_${randomUUID().slice(0, 8)}`;
    const secretA = `twin-a-${randomUUID()}`;
    const secretB = `twin-b-${randomUUID()}`;
    const crmA = await startFakeCrmServer({ secret: secretA });
    const crmB = await startFakeCrmServer({ secret: secretB });
    try {
      await installRemoteAdapterFromManifest({
        teamId,
        manifest: RemoteAdapterManifestInput.parse({ ...fakeCrmManifest(crmA.baseUrl), adapterType: typeName }),
        secret: secretA,
      });
      await installRemoteAdapterFromManifest({
        teamId: otherTeamId,
        manifest: RemoteAdapterManifestInput.parse({ ...fakeCrmManifest(crmB.baseUrl), adapterType: typeName }),
        secret: secretB,
      });
      const wake = (key: string, headers: Record<string, string>) =>
        post(`/api/public/adapter/${typeName}/wake`, { keys: [key] }, headers);

      expect((await wake('from-a', { authorization: `Bearer ${secretA}` })).status).toBe(202);
      expect((await wake('from-b', { authorization: `Bearer ${secretB}` })).status).toBe(202);
      expect(
        (await wake('a-as-b', { authorization: `Bearer ${secretA}`, 'x-listen-fire-team': otherTeamId })).status,
      ).toBe(401);

      expect((await workRows(teamId, 'wake_await')).map((w) => w.payload)).toEqual([
        { adapterType: typeName, teamId, correlationKey: 'from-a' },
      ]);
      expect((await workRows(otherTeamId, 'wake_await')).map((w) => w.payload)).toEqual([
        { adapterType: typeName, teamId: otherTeamId, correlationKey: 'from-b' },
      ]);
    } finally {
      await crmA.close();
      await crmB.close();
    }
  });
});
