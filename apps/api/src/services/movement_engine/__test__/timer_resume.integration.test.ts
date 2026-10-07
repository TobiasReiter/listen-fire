// The wake driver against the REAL DB (plans/2026-07-01-movement-sleep §4). A
// linear movement that `sleep`s then writes is dispatched for real — it PARKS at
// the sleep (a real `park_reason='timer'` `parked_run` + pinned movement_version
// + `trigger_run.trigger_payload`). We backdate `wake_at` into the past, run one
// `resumeTimerHandler.run` pass, and prove the driver: picks the due leaf up,
// steps PAST the sleep (binding nothing — `state.bindingName` is null), runs the
// remainder of the branch (the write lands), and settles the run `success`
// (single linear branch, no join). The `parked_run` row is swept.
//
// Only the two NETWORK seams a bare test DB can't stand up are mocked (exactly as
// typed_event_dispatch.integration.test.ts does): the catalog's live adapter
// introspection and adapter I/O. The dispatch gates, the firing, the durable
// park, the recorder, and the RESUME all run for real.

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
import { resumeTimerHandler } from '../timer_resume';
import { testWorkContext } from '../../../test/harness/work';

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
  '  await sleep(1s)',
  '  write chat-[:messages]-> {',
  '    channel: "#alerts"',
  '    text: "awake after sleep"',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created"] } fire sleep_then_notify',
].join('\n');

// A sleep nested ONE LEVEL inside an `if`, followed by a TRAILING TOP-LEVEL write
// at movement-body scope (VERIFICATION, plans/2026-07-01-movement-sleep
// whole-branch review). Single linear branch (no fan-out, no join_pending row) —
// the sleep sits inside `if ev IS Record Created { … }`, and `write { "#done" }`
// comes AFTER that block at the movement body.
//
// This test DOCUMENTS A GAP (asserts the ACTUAL current behaviour so it stays
// green in CI): on wake, resume descends the leaf's address into the `if` arm and
// runs the arm body forward from the statement after the sleep — the `#alerts`
// write lands — then the run finalises. NOTHING re-runs the enclosing
// movement-body sequence, so the trailing top-level `write B` is DROPPED. Contrast
// with the linear top-level `sleep; write` above (SLEEP_THEN_NOTIFY), where the
// leaf's OWN block IS the movement body, so the trailing write DOES run.
const IF_THEN_TAIL = [
  'import { attio, slack } from adapters',
  'import { acme_main, acme_slack } from credentials',
  '',
  'crm = attio(credentials: acme_main)',
  'chat = slack(credentials: acme_slack)',
  '',
  'movement if_then_tail(ev: <crm-[:`Webhook Event`]->>) {',
  '  if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.created"]->> {',
  '    await sleep(1s)',
  '    write chat-[:messages]-> {',
  '      channel: "#alerts"',
  '      text: "awake in branch"',
  '    }',
  '  }',
  '  write chat-[:messages]-> {',
  '    channel: "#done"',
  '    text: "after the block"',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created"] } fire if_then_tail',
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

describe('timer_resume — the wake driver (real DB)', () => {
  let teamId: TeamId;
  let slackCreates: Record<string, unknown>[];

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        id: teamId,
        name: `timer-resume-${teamId.slice(0, 8)}`,
      } as any)
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

  it('a due timer park is resumed: steps past the sleep, runs the write, settles success', async () => {
    const { triggerId } = await seedMovementWithTrigger(teamId);

    // Dispatch → the run parks at `sleep 1s` (no write yet).
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    expect(slackCreates).toHaveLength(0);

    // The real durable timer park: one parked_run, park_reason='timer', the run
    // observably 'parked'.
    const parked = await getAutomationsQb(['parked_run', 'trigger_run'])
      .selectFrom('parked_run')
      .innerJoin('trigger_run', 'trigger_run.id', 'parked_run.run_id')
      .where('trigger_run.team_id', '=', teamId)
      .where('parked_run.park_reason', '=', 'timer')
      .where('parked_run.status', '=', 'parked')
      .select(['parked_run.run_id as run_id', 'parked_run.address as address'])
      .executeTakeFirstOrThrow();
    const runId = parked.run_id;

    const runBefore = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', runId)
      .select('status')
      .executeTakeFirstOrThrow();
    expect(runBefore.status).toBe('parked');

    // Not yet due → a wake is a no-op (wake_at is ~now+1s).
    await resumeTimerHandler.run({ runId }, testWorkContext());
    expect(slackCreates).toHaveLength(0);

    // Backdate wake_at into the past → the leaf is now due.
    await getAutomationsQb(['parked_run'])
      .updateTable('parked_run')
      .set({ wake_at: new Date(Date.now() - 60_000) })
      .where('run_id', '=', runId)
      .where('address', '=', parked.address)
      .execute();

    // One wake pass.
    await resumeTimerHandler.run({ runId }, testWorkContext());

    // The branch stepped PAST the sleep and ran the write (bound nothing).
    expect(slackCreates).toEqual([{ channel: '#alerts', text: 'awake after sleep' }]);

    // The run settled success, and the timer park was swept.
    const runAfter = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', runId)
      .select('status')
      .executeTakeFirstOrThrow();
    expect(runAfter.status).toBe('success');

    const remaining = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .where('run_id', '=', runId)
      .select('id')
      .execute();
    expect(remaining).toHaveLength(0);
  });

  // ── VERIFICATION (whole-branch review): a sleep nested one level inside an `if`,
  // with a trailing TOP-LEVEL write after the block. The resume unwind (§4) fixes
  // the earlier drop: on wake the `if` arm runs forward past the sleep (the
  // `#alerts` write lands), then the NON-JOIN unwind runs the enclosing
  // movement-body continuation — so the trailing `write { "#done" }` ALSO lands.
  it('sleep nested in an `if`: on wake BOTH the in-branch write and the trailing top-level write land', async () => {
    const { triggerId } = await seedMovement(teamId, {
      source: IF_THEN_TAIL,
      firedName: 'if_then_tail',
      name: 'If then tail',
    });

    // Dispatch → the run parks at the sleep INSIDE the if arm. Neither write ran
    // (the trailing top-level write is after the block that parked).
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    expect(slackCreates).toHaveLength(0);

    const parked = await getAutomationsQb(['parked_run', 'trigger_run'])
      .selectFrom('parked_run')
      .innerJoin('trigger_run', 'trigger_run.id', 'parked_run.run_id')
      .where('trigger_run.team_id', '=', teamId)
      .where('parked_run.park_reason', '=', 'timer')
      .where('parked_run.status', '=', 'parked')
      .select(['parked_run.run_id as run_id', 'parked_run.address as address'])
      .executeTakeFirstOrThrow();
    const runId = parked.run_id;
    // The leaf address descends into the `if` arm (a `branch` step) — nested, not
    // a bare top-level `stmt`.
    expect(parked.address).toContain('b');

    // Backdate → the leaf is due. One wake pass.
    await getAutomationsQb(['parked_run'])
      .updateTable('parked_run')
      .set({ wake_at: new Date(Date.now() - 60_000) })
      .where('run_id', '=', runId)
      .where('address', '=', parked.address)
      .execute();
    await resumeTimerHandler.run({ runId }, testWorkContext());

    // The `if` arm ran forward past the sleep → the `#alerts` write landed …
    const alerts = slackCreates.filter((c) => c.channel === '#alerts');
    expect(alerts).toEqual([{ channel: '#alerts', text: 'awake in branch' }]);

    // … AND the non-join unwind ran the enclosing movement-body continuation, so
    // the TRAILING TOP-LEVEL write after the block ALSO landed.
    const done = slackCreates.filter((c) => c.channel === '#done');
    expect(done).toEqual([{ channel: '#done', text: 'after the block' }]);
    expect(slackCreates).toHaveLength(2); // in-branch write + trailing tail

    // The run settled success and swept its park.
    const runAfter = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', runId)
      .select('status')
      .executeTakeFirstOrThrow();
    expect(runAfter.status).toBe('success');

    const remaining2 = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .where('run_id', '=', runId)
      .select('id')
      .execute();
    expect(remaining2).toHaveLength(0);
  });
});
