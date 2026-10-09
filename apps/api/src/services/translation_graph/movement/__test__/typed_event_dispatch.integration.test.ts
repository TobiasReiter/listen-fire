// Layer 3 — typed listen events, the DISPATCH path against the REAL DB. Drives
// `dispatchTriggerByIdEvent` (the in-process trigger entry: gates →
// runMovementFiring → runMovement → recorder → Postgres) with a synthetic Attio
// `record.created` event and a movement that narrows on the action variant and
// traverses the meta-edge. Proves the wiring author-time rigor can't catch: the
// event's `changeType` becomes the seeded variant, the IS-narrow resolves, and
// the `-[:Companies]->` traversal hydrates the live record — through the real
// firing + recorder, read back exactly as the agent surface does.
//
// The two NETWORK seams a bare test DB can't stand up are mocked (and ONLY
// those): the catalog's live adapter introspection (`runCatalogSnapshotForTeam`)
// and adapter I/O (`resolveAdapter`). Everything else — dispatch gates, the
// firing, the run recorder, the engine seed/narrow/traverse — runs for real.

import { randomUUID } from 'node:crypto';

// ── Mocks: the two network seams (catalog introspection + adapter I/O) ───────

jest.mock('../catalog', () => {
  const actual = jest.requireActual('../catalog');
  return { ...actual, runCatalogSnapshotForTeam: jest.fn() };
});
jest.mock('../../adapters/resolve', () => {
  const actual = jest.requireActual('../../adapters/resolve');
  return { ...actual, resolveAdapter: jest.fn() };
});

import { eventAddressKey } from 'movement-lang';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { PipelineConfigurationId } from '../../../../generated/kysely/public/PipelineConfiguration';
import type { Adapter, RuntimeCapabilities } from '../../adapter';
import type { Catalog, CatalogSnapshot, InstanceSchema, PositionSchema } from 'movement-lang';
import type { TriggerEvent } from '../../triggers/types';

import { getAutomationsQb, getCoreQb, getQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { dispatchTriggerByIdEvent } from '../../triggers/router';
import { inspectMovementRun, listMovementRuns } from '../run_now';
import {
  runCatalogSnapshotForTeam,
  snapshotOverManifests,
  staticCatalogFromManifests,
} from '../catalog';
import { resolveAdapter } from '../../adapters/resolve';
import {
  makeStablePosition,
  positionData,
} from '../../types';
import { containerAssociation } from '../../adapter';


const mockedCatalog = runCatalogSnapshotForTeam as jest.Mock;
const mockedResolve = resolveAdapter as jest.Mock;

const COMPANIES_OBJECT_ID = 'obj-companies';
const PERSON_OBJECT_ID = 'obj-person';

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

// The Attio instance schema as the projection + host graft produce it: the
// event NODE with its `action` enum, plus the demand-grafted per-action
// narrowings — the same fixture the checker test uses.
const ACTIONS = ['record.created', 'record.updated', 'record.deleted'];
const EVENT = 'Webhook Event';
const graftPositions: Record<string, PositionSchema> = {};
const graftVariants: string[] = [];
for (const action of ACTIONS) {
  const key = eventAddressKey({ event: EVENT, narrowing: { action } });
  graftVariants.push(key);
  graftPositions[key] = {
    properties: { action: { kind: 'enum', options: ACTIONS } },
    edges: action === 'record.deleted' ? {} : { Companies: { target: 'Companies' } },
  };
}
const ATTIO_SCHEMA: InstanceSchema = {
  positions: {
    Companies: { properties: { Name: 'text' }, edges: {} },
    [EVENT]: {
      properties: { action: { kind: 'enum', options: ACTIONS } },
      edges: { Companies: { target: 'Companies', requiresLiveRecord: true } },
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

// Fake Attio SOURCE mirroring getRecordForEvent: the `-[:Companies]->` edge
// hydrates the live record ONLY when the event's id.object_id matches Companies.
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
    async getRelated({ position, fieldId }) {
      if (fieldId !== 'Companies') return [];
      const data = positionData(position) as
        | { id?: { object_id?: string; record_id?: string } }
        | undefined;
      if (data?.id?.object_id !== COMPANIES_OBJECT_ID) return [];
      return [
        {
          position: makeStablePosition({
            adapterType: 'attio',
            recordType: 'Companies',
            recordId: data.id.record_id ?? 'unknown',
            data: { Name: 'Acme' },
          }),
        },
      ];
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

const NOTIFY_NEW_COMPANY = [
  'import { attio, slack } from adapters',
  'import { acme_main, acme_slack } from credentials',
  '',
  'crm = attio(credentials: acme_main)',
  'chat = slack(credentials: acme_slack)',
  '',
  'movement notify_new_company(ev: <crm-[:`Webhook Event`]->>) {',
  '  if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.created"]->> {',
  '    ev-[co:Companies]-> {',
  '      write chat-[:messages]-> {',
  '        channel: "#alerts"',
  '        text: co.`Name`',
  '      }',
  '    }',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created", "record.updated", "record.deleted"] } fire notify_new_company',
].join('\n');

async function seedMovementWithAttioTrigger(teamId: TeamId): Promise<{
  movementId: MovementId;
  triggerId: TriggerId;
}> {
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
    .values({ id: movementId, team_id: teamId, name: 'Notify new company', source: NOTIFY_NEW_COMPANY } as any)
    .execute();

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
      fired_movement_name: 'notify_new_company',
    } as any)
    .execute();

  return { movementId, triggerId };
}

function webhookEvent(input: {
  changeType: 'create' | 'update' | 'delete';
  objectId: string;
  eventType: string;
}): TriggerEvent {
  return {
    pipelineInputId: 'trigger:test',
    adapterType: 'attio',
    triggerType: 'webhook',
    payload: {
      event_type: input.eventType,
      action: input.eventType,
      id: { object_id: input.objectId, record_id: 'co-1' },
    },
    changeType: input.changeType,
    rootRecordType: 'Companies',
    externalRecordRef: { adapterType: 'attio', externalId: 'co-1', recordType: 'Companies' },
    occurredAt: new Date().toISOString(),
  };
}

describe('typed listen events — dispatch path (real DB)', () => {
  let teamId: TeamId;
  let slackCreates: Record<string, unknown>[];

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        id: teamId,
        name: `typed-ev-${teamId.slice(0, 8)}`,
      } as any)
      .execute();

    // The catalog: hand-built (the live introspection seam is faked).
    const catalog = buildCatalog();
    mockedCatalog.mockResolvedValue({
      snapshot: catalog,
      credentialIds: Object.fromEntries(Object.keys(catalog.credentials).map((name) => [name, 'cred-1'])),
      notes: [],
    });

    // Adapter I/O: a fake Attio source + a fake Slack target.
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

  it('a Companies record.created → narrows + traverses + hydrates a write carrying "Acme"', async () => {
    const { movementId, triggerId } = await seedMovementWithAttioTrigger(teamId);

    const result = await dispatchTriggerByIdEvent({
      triggerId,
      teamId,
      event: webhookEvent({ changeType: 'create', objectId: COMPANIES_OBJECT_ID, eventType: 'record.created' }),
    });

    // The firing applied exactly one write (the IS-narrow passed, the traversal hydrated).
    expect(result.movementFirings).toEqual([
      { movementName: 'notify_new_company', writes: 1, dryRun: false },
    ]);
    // The committed write carries the HYDRATED field — not blank.
    expect(slackCreates).toEqual([{ channel: '#alerts', text: 'Acme' }]);

    // And it's recorded — readable back as the agent surface reads it.
    const [{ runId }] = await listMovementRuns({ teamId, movementId });
    const detail = await inspectMovementRun({ teamId, runId });
    if ('error' in detail) throw new Error(detail.error);
    expect(detail.status).toBe('success');
    expect(detail.writes).toHaveLength(1);
    expect(detail.writes[0].values).toMatchObject({ text: 'Acme' });
  });

  it('a Person record.created → narrows fine but the Companies traversal is empty: zero writes (object axis)', async () => {
    const { triggerId } = await seedMovementWithAttioTrigger(teamId);

    const result = await dispatchTriggerByIdEvent({
      triggerId,
      teamId,
      event: webhookEvent({ changeType: 'create', objectId: PERSON_OBJECT_ID, eventType: 'record.created' }),
    });

    expect(result.movementFirings).toEqual([
      { movementName: 'notify_new_company', writes: 0, dryRun: false },
    ]);
    expect(slackCreates).toEqual([]);
  });

  it('a record.deleted does not satisfy the created pin — the live-record branch is not entered: zero writes', async () => {
    const { triggerId } = await seedMovementWithAttioTrigger(teamId);

    const result = await dispatchTriggerByIdEvent({
      triggerId,
      teamId,
      event: webhookEvent({ changeType: 'delete', objectId: COMPANIES_OBJECT_ID, eventType: 'record.deleted' }),
    });

    expect(result.movementFirings).toEqual([
      { movementName: 'notify_new_company', writes: 0, dryRun: false },
    ]);
    expect(slackCreates).toEqual([]);
  });
});
