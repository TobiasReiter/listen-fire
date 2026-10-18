// The GATED risk (plans/2026-07-01-movement-sleep/3_model.md §9): MULTIPLE
// concurrent timer parks in ONE run, converging at a join — fan-out sleep. The
// linear case (one park per run, no join) is proven by
// `timer_resume.integration.test.ts`; this file makes multi-park-per-run REAL and
// proves the join/settle machinery (`join_pending.ts` atomic decrements +
// `settleBranchComplete`) — exercised until now only at single-park scope — is
// correct under fan-out.
//
// The movement fans out over N (=3) related records with a `sleep` INSIDE each
// iteration body, then a per-iteration write after the sleep. ONE dispatch parks
// N `park_reason='timer'` leaves under ONE join frame (the traversal block's
// address), `join_pending.pending = N`.
//
// Two shapes, both against the REAL DB:
//   1. ALL-DUE: backdate every leaf's `wake_at`, one wake pass drains all N in
//      turn (the scanner's serial per-run drain), every branch runs its write,
//      the join decrements N→0, the run settles `success` EXACTLY ONCE, all N
//      parks are swept.
//   2. STAGGERED (multi-pass): backdate only SOME leaves. Pass 1 drains those,
//      the join decrements PARTWAY (not to 0) — the run stays observably `parked`
//      (no premature success while a sibling sleeps), its writes land, the not-
//      yet-due leaf's park stands. Pass 2 (after backdating the last) drains the
//      final leaf → join reaches 0 → run settles `success`, parks swept.
//
// Same two mocked network seams as the linear harness (catalog introspection +
// adapter I/O); dispatch gates, firing, durable park, recorder, join, and RESUME
// all run for real.

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
import { seedTeamCredential } from '../../../test/harness/credentials';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { PipelineConfigurationId } from '../../../generated/kysely/public/PipelineConfiguration';
import { dispatchTriggerByIdEvent } from '../../translation_graph/triggers/router';
import { runCatalogSnapshotForTeam, snapshotOverManifests, staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { resolveAdapter } from '../../translation_graph/adapters/resolve';
import { mintMovementVersionIfChanged } from '../../translation_graph/movement/version_store';
import { makeStablePosition, positionData } from 'movement-engine/services/translation_graph/types';
import type { Adapter, RuntimeCapabilities } from 'movement-engine/services/translation_graph/adapter';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import type { Catalog, CatalogSnapshot, InstanceSchema, PositionSchema } from 'movement-lang';
import { eventAddressKey, CURRENT_LANGUAGE_VERSION } from 'movement-lang';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { resumeTimerHandler } from '../timer_resume';
import { testWorkContext } from '../../../test/harness/work';

const mockedCatalog = runCatalogSnapshotForTeam as jest.Mock;
const mockedResolve = resolveAdapter as jest.Mock;

const FANOUT_N = 3;
const CONTACT_NAMES = ['Ada', 'Babbage', 'Curie'];

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

// Event variants carry a `Contacts` edge → a `Contact` record the traversal
// fans out over (mirrors typed_event_run's `-[:Companies]->` shape).
const ACTIONS = ['record.created', 'record.updated', 'record.deleted'];
const EVENT = 'Webhook Event';
const graftPositions: Record<string, PositionSchema> = {};
const graftVariants: string[] = [];
for (const action of ACTIONS) {
  const key = eventAddressKey({ event: EVENT, narrowing: { action } });
  graftVariants.push(key);
  graftPositions[key] = {
    properties: { action: { kind: 'enum', options: ACTIONS } },
    edges: action === 'record.deleted' ? {} : { Contacts: { target: 'Contact' } },
  };
}
const ATTIO_SCHEMA: InstanceSchema = {
  positions: {
    Contact: { properties: { Name: 'text' }, edges: {} },
    [EVENT]: {
      properties: { action: { kind: 'enum', options: ACTIONS } },
      edges: { Contacts: { target: 'Contact', requiresLiveRecord: true } },
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

// The Attio SOURCE: `-[c:Contacts]->` fans out to N contact records, each with a
// distinct `Name`. Everything else is a source no-op.
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
    async getRelated({ fieldId }) {
      if (fieldId !== 'Contacts') return [];
      return CONTACT_NAMES.map((name, i) => ({
        position: makeStablePosition({
          adapterType: 'attio',
          recordType: 'Contact',
          recordId: `contact-${i}`,
          data: { Name: name },
        }),
      }));
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

// The fan-out sleep movement: narrow to the created record, traverse its N
// contacts, and — for EACH — sleep then write. One dispatch ⇒ N timer parks
// under one join (the block frame).
const FANOUT_SLEEP = [
  'import { attio, slack } from adapters',
  'import { acme_main, acme_slack } from credentials',
  '',
  'crm = connect attio using acme_main',
  'chat = connect slack using acme_slack',
  '',
  'function fanout_sleep_notify(ev: <crm-[:`Webhook Event`]->>) {',
  '  if (ev is <crm-[:`Webhook Event` WHERE `action` == "record.created"]->>) {',
  '    ev-[c:Contacts]-> {',
  '      await sleep(1s)',
  '      write chat-[:messages]-> {',
  '        channel: "#alerts"',
  '        text: c.`Name`',
  '      }',
  '    }',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created"] } fire fanout_sleep_notify',
].join('\n');

// The fan-out sleep movement WITH A TRAILING TOP-LEVEL WRITE after the fan-out
// block (VERIFICATION, plans/2026-07-01-movement-sleep whole-branch review). The
// `write chat-[:messages]-> { channel: "#done" … }` sits at MOVEMENT-BODY scope, AFTER
// the `if` that wraps the fan-out — i.e. a statement at a PARENT scope that comes
// after the block containing the parked leaves.
//
// This test DOCUMENTS A GAP (it asserts the ACTUAL current behaviour, so it stays
// green in CI): on wake, resume runs only each leaf's OWN block forward
// (`interpretBody` from the statement after the sleep) and the join completer just
// finalises the run — NOTHING re-runs the enclosing movement-body sequence, so the
// trailing top-level `write B` is DROPPED. The `join_pending.ts:6-8` comment
// claiming the completer "runs the enclosing sequence forward" is not backed by
// code on this resume path.
const FANOUT_THEN_TAIL = [
  'import { attio, slack } from adapters',
  'import { acme_main, acme_slack } from credentials',
  '',
  'crm = connect attio using acme_main',
  'chat = connect slack using acme_slack',
  '',
  'function fanout_then_tail(ev: <crm-[:`Webhook Event`]->>) {',
  '  if (ev is <crm-[:`Webhook Event` WHERE `action` == "record.created"]->>) {',
  '    ev-[c:Contacts]-> {',
  '      await sleep(1s)',
  '      write chat-[:messages]-> {',
  '        channel: "#alerts"',
  '        text: c.`Name`',
  '      }',
  '    }',
  '  }',
  '  write chat-[:messages]-> {',
  '    channel: "#done"',
  '    text: "ALL DONE"',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created"] } fire fanout_then_tail',
].join('\n');

async function seedMovement(
  teamId: TeamId,
  opts: { source: string; firedName: string; name: string },
): Promise<{ triggerId: TriggerId }> {
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
    .values({ id: movementId, team_id: teamId, name: opts.name, source: opts.source, language_version: CURRENT_LANGUAGE_VERSION } as any)
    .execute();

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

  return { triggerId };
}

async function seedMovementWithTrigger(teamId: TeamId): Promise<{ triggerId: TriggerId }> {
  return seedMovement(teamId, {
    source: FANOUT_SLEEP,
    firedName: 'fanout_sleep_notify',
    name: 'Fan-out sleep notify',
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

async function timerParks(teamId: TeamId): Promise<{ runId: string; address: string }[]> {
  const rows = await getAutomationsQb(['parked_run', 'trigger_run'])
    .selectFrom('parked_run')
    .innerJoin('trigger_run', 'trigger_run.id', 'parked_run.run_id')
    .where('trigger_run.team_id', '=', teamId)
    .where('parked_run.park_reason', '=', 'timer')
    .where('parked_run.status', '=', 'parked')
    .select(['parked_run.run_id as runId', 'parked_run.address as address'])
    .execute();
  return rows.map((r) => ({ runId: r.runId, address: r.address }));
}

async function runStatus(runId: string): Promise<string> {
  const row = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId as never)
    .select('status')
    .executeTakeFirstOrThrow();
  return row.status;
}

async function joinPending(runId: string): Promise<number | null> {
  const row = await getAutomationsQb(['join_pending'])
    .selectFrom('join_pending')
    .where('run_id', '=', runId as never)
    .select('pending')
    .executeTakeFirst();
  return row?.pending ?? null;
}

async function remainingParks(runId: string): Promise<number> {
  const rows = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId as never)
    .select('id')
    .execute();
  return rows.length;
}

async function backdate(runId: string, addresses: string[]): Promise<void> {
  await getAutomationsQb(['parked_run'])
    .updateTable('parked_run')
    .set({ wake_at: new Date(Date.now() - 60_000) })
    .where('run_id', '=', runId as never)
    .where('address', 'in', addresses as never[])
    .execute();
}

describe('timer_resume — fan-out sleep, multi-park-per-run under a join (real DB)', () => {
  let teamId: TeamId;
  let credentialId: string;
  let slackCreates: Record<string, unknown>[];

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        id: teamId,
        name: `fanout-sleep-${teamId.slice(0, 8)}`,
      } as any)
      .execute();
    credentialId = await seedTeamCredential(teamId);

    const catalog = buildCatalog();
    mockedCatalog.mockResolvedValue({
      snapshot: catalog,
      credentialIds: Object.fromEntries(Object.keys(catalog.credentials).map((name) => [name, credentialId])),
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

  it('ALL-DUE: N branches sleep, wake in one pass, join settles success exactly once, parks swept', async () => {
    const { triggerId } = await seedMovementWithTrigger(teamId);

    // One dispatch → the fan-out parks N timer leaves under ONE join (no writes).
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    expect(slackCreates).toHaveLength(0);

    const parks = await timerParks(teamId);
    expect(parks).toHaveLength(FANOUT_N);
    const runId = parks[0].runId;
    expect(parks.every((p) => p.runId === runId)).toBe(true); // all under one run

    // The join records exactly N pending children, and the run is observably parked.
    expect(await joinPending(runId)).toBe(FANOUT_N);
    expect(await runStatus(runId)).toBe('parked');

    // Not yet due → a wake is a no-op.
    await resumeTimerHandler.run({ runId }, testWorkContext());
    expect(slackCreates).toHaveLength(0);
    expect(await runStatus(runId)).toBe('parked');

    // Backdate ALL N leaves → all due. One wake pass drains them in turn.
    await backdate(runId, parks.map((p) => p.address));
    await resumeTimerHandler.run({ runId }, testWorkContext());

    // Every branch stepped PAST its sleep and ran its write — N writes, one per contact.
    expect(slackCreates).toHaveLength(FANOUT_N);
    expect(new Set(slackCreates.map((c) => c.text))).toEqual(new Set(CONTACT_NAMES));
    expect(slackCreates.every((c) => c.channel === '#alerts')).toBe(true);

    // The join reached zero exactly once → the run settled success; join dissolved.
    expect(await runStatus(runId)).toBe('success');
    expect(await joinPending(runId)).toBeNull();

    // All N timer parks swept.
    expect(await remainingParks(runId)).toBe(0);
  });

  it('STAGGERED: partial wake keeps the run parked (no premature success); the last-leaf pass completes it', async () => {
    const { triggerId } = await seedMovementWithTrigger(teamId);

    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const parks = await timerParks(teamId);
    expect(parks).toHaveLength(FANOUT_N);
    const runId = parks[0].runId;
    expect(await joinPending(runId)).toBe(FANOUT_N);

    // PASS 1 — backdate only the first N-1 leaves. They drain; the last still sleeps.
    const early = parks.slice(0, FANOUT_N - 1).map((p) => p.address);
    const late = parks[FANOUT_N - 1].address;
    await backdate(runId, early);
    await resumeTimerHandler.run({ runId }, testWorkContext());

    // N-1 writes landed; the join decremented to exactly 1 (NOT zero).
    expect(slackCreates).toHaveLength(FANOUT_N - 1);
    expect(await joinPending(runId)).toBe(1);
    // The run is STILL parked — no premature success while a sibling sleeps.
    expect(await runStatus(runId)).toBe('parked');
    // Exactly the not-yet-due leaf's park remains.
    expect(await remainingParks(runId)).toBe(1);

    // PASS 2 — the last leaf becomes due; the pass that drains it completes the run.
    await backdate(runId, [late]);
    await resumeTimerHandler.run({ runId }, testWorkContext());

    expect(slackCreates).toHaveLength(FANOUT_N);
    expect(new Set(slackCreates.map((c) => c.text))).toEqual(new Set(CONTACT_NAMES));
    expect(await runStatus(runId)).toBe('success');
    expect(await joinPending(runId)).toBeNull();
    expect(await remainingParks(runId)).toBe(0);
  });

  // ── VERIFICATION (whole-branch review): trailing TOP-LEVEL statement after a
  // fan-out block whose leaves parked at a sleep. The resume unwind (§4/§12) fixes
  // the earlier drop: each branch runs its own iteration body forward (the N
  // `#alerts` writes) and, at the join, persists+decrements; the UNIQUE closing
  // branch folds the join and runs the enclosing movement-body continuation — so
  // the trailing `write { "#done" }` runs EXACTLY ONCE (only on the closing pass).
  it('a trailing top-level write AFTER the fan-out block runs EXACTLY ONCE on wake (join closer)', async () => {
    const { triggerId } = await seedMovement(teamId, {
      source: FANOUT_THEN_TAIL,
      firedName: 'fanout_then_tail',
      name: 'Fan-out then tail',
    });

    // One dispatch → the fan-out parks N timer leaves under one join. The trailing
    // top-level write did NOT run at dispatch either (the fan-out block parked
    // before control returned to the movement body).
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    expect(slackCreates).toHaveLength(0);

    const parks = await timerParks(teamId);
    expect(parks).toHaveLength(FANOUT_N);
    const runId = parks[0].runId;
    expect(parks.every((p) => p.runId === runId)).toBe(true);
    expect(await joinPending(runId)).toBe(FANOUT_N);
    expect(await runStatus(runId)).toBe('parked');

    // Wake all N leaves in one pass.
    await backdate(runId, parks.map((p) => p.address));
    await resumeTimerHandler.run({ runId }, testWorkContext());

    // Each leaf ran its OWN write (the N per-contact `#alerts` messages) …
    const alerts = slackCreates.filter((c) => c.channel === '#alerts');
    expect(alerts).toHaveLength(FANOUT_N);
    expect(new Set(alerts.map((c) => c.text))).toEqual(new Set(CONTACT_NAMES));

    // … AND the TRAILING TOP-LEVEL write ran EXACTLY ONCE — only the branch that
    // closed the join unwound to the movement-body continuation.
    const done = slackCreates.filter((c) => c.channel === '#done');
    expect(done).toEqual([{ channel: '#done', text: 'ALL DONE' }]);
    expect(slackCreates).toHaveLength(FANOUT_N + 1); // N per-leaf writes + one tail

    // The run settled success and swept its parks.
    expect(await runStatus(runId)).toBe('success');
    expect(await joinPending(runId)).toBeNull();
    expect(await remainingParks(runId)).toBe(0);
  });
});
