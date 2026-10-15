// The resume "unwind-and-continue" matrix (plans/2026-07-01-movement-sleep/
// 4_resume_unwind_fix.md §10) — the exhaustive proof that resume rebuilds normal
// execution's return-from-block: after a parked leaf's block completes, each
// ancestor's post-container continuation runs (join-aware, exactly once), and a
// fan-out/parallel join reconstructs the FULL cross-branch aggregate from the
// durable export store (§12).
//
// Driven by the TIMER driver (`sleep` parks; `resumeTimerHandler` wakes) — the
// same real-DB harness as `timer_resume_fanout.integration.test.ts` (mocked
// catalog introspection + adapter I/O only; dispatch, park, recorder, join,
// resume all real). The two basic gap-inversion tests live in the sibling files;
// THIS file adds the intricate shapes:
//
//   §10.3  STAGGERED fan-out + trailing — the continuation fires only on the
//          closing pass, never early.
//   §10.4  parallel + trailing, reading BOTH branches' bindings after the join
//          (§12.4 cross-branch reconstruction).
//   §10 11 assigned fan-out — the trailing read sees what ALL N iterations
//          RETURNED, not just the closer's; + a STAGGERED variant.
//   §10.5  two/three levels deep — `if { parallel { fanout } { sleep } }`; joins
//          close bottom-up, each ancestor's continuation runs once.
//   §10.6  re-park in the continuation — the trailing statement itself sleeps;
//          + a fan-out variant where the CLOSER's continuation re-parks (the
//          closed inner join is left untouched).
//   §10.9  crash-safety of the closer continuation — the closer's leaf survives
//          a simulated crash and is re-scanned; the trailing write is re-run,
//          deduped (not doubled), and never run by a sibling.

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
import { makeStablePosition, positionData } from 'movement-engine/services/translation_graph/types';
import type { Adapter, RuntimeCapabilities } from 'movement-engine/services/translation_graph/adapter';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import type { Catalog, CatalogSnapshot, InstanceSchema, LanguageVersion, PositionSchema } from 'movement-lang';
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
      // Idempotent delivery: dedup on (channel, text). This models the realistic
      // shape for a resumable write (a `unique by` / find-or-create sink) so the
      // crash-safety test isolates the ENGINE's closer-identity guarantee from
      // write-delivery semantics — a leaf-block REPLAY on re-scan is at-least-once
      // at the engine (no engine-side write ledger), and a real resumable write
      // dedups downstream. Legitimate distinct writes never collide here.
      const key = JSON.stringify([input.fields.channel, input.fields.text]);
      const existingIdx = creates.findIndex(
        (c) => JSON.stringify([c.channel, c.text]) === key,
      );
      if (existingIdx !== -1) {
        return { adapterType: 'slack', externalId: `msg-${existingIdx + 1}`, data: {} };
      }
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

const PRELUDE = [
  'import { attio, slack } from adapters',
  'import { acme_main, acme_slack } from credentials',
  '',
  'crm = attio(credentials: acme_main)',
  'chat = slack(credentials: acme_slack)',
  '',
];

// §10.3 / §10.9 — fan-out sleep inside an `if`, trailing top-level write.
const FANOUT_THEN_TAIL = [
  ...PRELUDE,
  'movement fanout_then_tail(ev: <crm-[:`Webhook Event`]->>) {',
  '  if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.created"]->> {',
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

const ASSIGNED_FANOUT = [
  ...PRELUDE,
  'movement assigned_fanout(ev: <crm-[:`Webhook Event`]->>) {',
  '  if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.created"]->> {',
  '    xs = ev-[c:Contacts]-> {',
  '      await sleep(1s)',
  '      return write chat-[:messages]-> {',
  '        channel: "#alerts"',
  '        text: c.`Name`',
  '      }',
  '    }',
  '    write chat-[:messages]-> {',
  '      channel: "#done"',
  '      text: "count=${COUNT(xs)}"',
  '    }',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created"] } fire assigned_fanout',
].join('\n');
const PARALLEL_TAIL_V3 = [
  ...PRELUDE,
  'movement parallel_tail_v3(ev: <crm-[:`Webhook Event`]->>) {',
  '  r = await parallel([',
  '    () => {',
  '      await sleep(1s)',
  '      write chat-[:messages]-> {',
  '        channel: "#a"',
  '        text: "A"',
  '      }',
  '      return "A"',
  '    },',
  '    () => {',
  '      await sleep(1s)',
  '      write chat-[:messages]-> {',
  '        channel: "#b"',
  '        text: "B"',
  '      }',
  '      return "B"',
  '    },',
  '  ])',
  '  write chat-[:messages]-> {',
  '    channel: "#done"',
  '    text: "DONE ${AT(r, 0)}${AT(r, 1)}"',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created"] } fire parallel_tail_v3',
].join('\n');

// §10.5 under language version 3 — if > parallel([…]) > fan-out. One arm holds
// the fan-out, the other a sleep; joins close bottom-up (fan-out → combinator).
const DEEP_NEST_V3 = [
  ...PRELUDE,
  'movement deep_nest_v3(ev: <crm-[:`Webhook Event`]->>) {',
  '  if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.created"]->> {',
  '    r = await parallel([',
  '      () => {',
  '        ev-[c:Contacts]-> {',
  '          await sleep(1s)',
  '          write chat-[:messages]-> {',
  '            channel: "#alerts"',
  '            text: c.`Name`',
  '          }',
  '        }',
  '        return "fanned"',
  '      },',
  '      () => {',
  '        await sleep(1s)',
  '        write chat-[:messages]-> {',
  '          channel: "#other"',
  '          text: "other"',
  '        }',
  '        return "other"',
  '      },',
  '    ])',
  '    write chat-[:messages]-> {',
  '      channel: "#joined"',
  '      text: "${AT(r, 0)}/${AT(r, 1)}"',
  '    }',
  '  }',
  '  write chat-[:messages]-> {',
  '    channel: "#done"',
  '    text: "DONE"',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created"] } fire deep_nest_v3',
].join('\n');

// §10.6 — non-join re-park: the trailing continuation ITSELF contains a sleep.
const IF_THEN_SLEEP_TAIL = [
  ...PRELUDE,
  'movement if_then_sleep_tail(ev: <crm-[:`Webhook Event`]->>) {',
  '  if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.created"]->> {',
  '    await sleep(1s)',
  '    write chat-[:messages]-> {',
  '      channel: "#alerts"',
  '      text: "in-if"',
  '    }',
  '  }',
  '  await sleep(1s)',
  '  write chat-[:messages]-> {',
  '    channel: "#done"',
  '    text: "final"',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created"] } fire if_then_sleep_tail',
].join('\n');

// §10.6 / §10.9 — fan-out whose CLOSER's continuation re-parks (trailing sleep).
// The closer closes the inner fan-out join, then the continuation sleeps → the
// closed join must be left untouched. Also the crash-safety fixture: because the
// continuation re-parks, the run does NOT settle, so the closed join_pending row
// + branch exports SURVIVE — the exact mid-crash state to re-scan.
const FANOUT_TAIL_REPARK = [
  ...PRELUDE,
  'movement fanout_tail_repark(ev: <crm-[:`Webhook Event`]->>) {',
  '  if ev IS <crm-[:`Webhook Event` WHERE `action` == "record.created"]->> {',
  '    ev-[c:Contacts]-> {',
  '      await sleep(1s)',
  '      write chat-[:messages]-> {',
  '        channel: "#alerts"',
  '        text: c.`Name`',
  '      }',
  '    }',
  '  }',
  '  await sleep(1s)',
  '  write chat-[:messages]-> {',
  '    channel: "#done"',
  '    text: "DONE"',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created"] } fire fanout_tail_repark',
].join('\n');

async function seedMovement(
  teamId: TeamId,
  opts: { source: string; firedName: string; name: string; languageVersion?: LanguageVersion },
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
    .values({ id: movementId, team_id: teamId, name: opts.name, source: opts.source } as any)
    .execute();

  await mintMovementVersionIfChanged({ teamId, movementId, source: opts.source, languageVersion: opts.languageVersion ?? CURRENT_LANGUAGE_VERSION });

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

async function timerParks(teamId: TeamId): Promise<{ runId: string; address: string; state: unknown }[]> {
  const rows = await getAutomationsQb(['parked_run', 'trigger_run'])
    .selectFrom('parked_run')
    .innerJoin('trigger_run', 'trigger_run.id', 'parked_run.run_id')
    .where('trigger_run.team_id', '=', teamId)
    .where('parked_run.park_reason', '=', 'timer')
    .where('parked_run.status', '=', 'parked')
    .select([
      'parked_run.run_id as runId',
      'parked_run.address as address',
      'parked_run.state as state',
    ])
    .execute();
  return rows.map((r) => ({ runId: r.runId, address: r.address, state: r.state }));
}

async function runStatus(runId: string): Promise<string> {
  const row = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId as never)
    .select('status')
    .executeTakeFirstOrThrow();
  return row.status;
}

/** All join_pending rows for a run: { frameAddress, pending, closedBy }. */
async function joinRows(
  runId: string,
): Promise<{ frameAddress: string; pending: number; closedBy: string | null }[]> {
  const rows = await getAutomationsQb(['join_pending'])
    .selectFrom('join_pending')
    .where('run_id', '=', runId as never)
    .select(['frame_address as frameAddress', 'pending', 'closed_by_address as closedBy'])
    .execute();
  return rows.map((r) => ({
    frameAddress: r.frameAddress as unknown as string,
    pending: r.pending,
    closedBy: (r.closedBy as unknown as string) ?? null,
  }));
}

async function joinBranchExportCount(runId: string): Promise<number> {
  const rows = await getAutomationsQb(['join_branch_export'])
    .selectFrom('join_branch_export')
    .where('run_id', '=', runId as never)
    .select('branch_address')
    .execute();
  return rows.length;
}

async function remainingParks(runId: string): Promise<number> {
  const rows = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId as never)
    .where('status', '=', 'parked')
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

describe('timer_resume — unwind-and-continue matrix (real DB)', () => {
  let teamId: TeamId;
  let slackCreates: Record<string, unknown>[];

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        id: teamId,
        name: `unwind-${teamId.slice(0, 8)}`,
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

  // ── §10.3 — STAGGERED fan-out + trailing: the continuation fires only on the
  // closing pass, never on an early partial pass. ──────────────────────────────
  it('STAGGERED fan-out + trailing: the trailing write fires ONLY on the closing pass', async () => {
    const { triggerId } = await seedMovement(teamId, {
      source: FANOUT_THEN_TAIL,
      firedName: 'fanout_then_tail',
      name: 'Fan-out then tail (staggered)',
    });

    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const parks = await timerParks(teamId);
    expect(parks).toHaveLength(FANOUT_N);
    const runId = parks[0].runId;
    expect((await joinRows(runId))[0].pending).toBe(FANOUT_N);

    // PASS 1 — wake only the first N-1 leaves.
    const early = parks.slice(0, FANOUT_N - 1).map((p) => p.address);
    const late = parks[FANOUT_N - 1].address;
    await backdate(runId, early);
    await resumeTimerHandler.run({ runId }, testWorkContext());

    // N-1 per-branch writes landed; NO trailing #done yet; join decremented to 1.
    expect(slackCreates.filter((c) => c.channel === '#alerts')).toHaveLength(FANOUT_N - 1);
    expect(slackCreates.filter((c) => c.channel === '#done')).toHaveLength(0);
    expect((await joinRows(runId))[0].pending).toBe(1);
    expect(await runStatus(runId)).toBe('parked');

    // PASS 2 — wake the last leaf; the closing pass runs the trailing write ONCE.
    await backdate(runId, [late]);
    await resumeTimerHandler.run({ runId }, testWorkContext());

    expect(slackCreates.filter((c) => c.channel === '#alerts')).toHaveLength(FANOUT_N);
    const done = slackCreates.filter((c) => c.channel === '#done');
    expect(done).toEqual([{ channel: '#done', text: 'ALL DONE' }]);
    expect(await runStatus(runId)).toBe('success');
    expect(await joinRows(runId)).toEqual([]);
    expect(await joinBranchExportCount(runId)).toBe(0);
    expect(await remainingParks(runId)).toBe(0);
  });

  // ── §10.4 — parallel + trailing: both branches park; on wake the closer runs
  // the trailing write EXACTLY ONCE (only when the LAST branch closes the join). ─
  it('parallel([…]) combinator + trailing (version 3): both arms park; the closer runs the trailing write exactly once', async () => {
    const { triggerId } = await seedMovement(teamId, {
      source: PARALLEL_TAIL_V3,
      languageVersion: 3,
      firedName: 'parallel_tail_v3',
      name: 'Parallel combinator tail',
    });

    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    // Both arms parked at their sleep; no writes yet.
    expect(slackCreates).toHaveLength(0);
    const parks = await timerParks(teamId);
    expect(parks).toHaveLength(2);
    const runId = parks[0].runId;
    expect((await joinRows(runId))[0].pending).toBe(2);

    await backdate(runId, parks.map((p) => p.address));
    await resumeTimerHandler.run({ runId }, testWorkContext());

    // Each arm ran its own write …
    expect(slackCreates.filter((c) => c.channel === '#a')).toHaveLength(1);
    expect(slackCreates.filter((c) => c.channel === '#b')).toHaveLength(1);
    // … and the trailing write ran EXACTLY ONCE, reading both arms' slots of the
    // receipt rebuilt across the resume.
    expect(slackCreates.filter((c) => c.channel === '#done')).toEqual([
      { channel: '#done', text: 'DONE AB' },
    ]);

    expect(await runStatus(runId)).toBe('success');
    expect(await joinRows(runId)).toEqual([]);
    expect(await joinBranchExportCount(runId)).toBe(0);
    expect(await remainingParks(runId)).toBe(0);
  });

  // ── §10 item 11 — assigned fan-out: the trailing read sees what ALL N
  // iterations returned, reconstructed from the store. ────────────────────────
  it('assigned fan-out + trailing read: the aggregate carries ALL N iterations, not just the closer', async () => {
    const { triggerId } = await seedMovement(teamId, {
      source: ASSIGNED_FANOUT,
      firedName: 'assigned_fanout',
      name: 'Assigned fan-out',
    });

    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const parks = await timerParks(teamId);
    expect(parks).toHaveLength(FANOUT_N);
    const runId = parks[0].runId;

    await backdate(runId, parks.map((p) => p.address));
    await resumeTimerHandler.run({ runId }, testWorkContext());

    // Every iteration's per-contact write landed …
    expect(slackCreates.filter((c) => c.channel === '#alerts')).toHaveLength(FANOUT_N);
    // … and the trailing read of `xs` counted what ALL N iterations returned.
    const done = slackCreates.filter((c) => c.channel === '#done');
    expect(done).toEqual([{ channel: '#done', text: `count=${FANOUT_N}` }]);

    expect(await runStatus(runId)).toBe('success');
    expect(await joinRows(runId)).toEqual([]);
    expect(await joinBranchExportCount(runId)).toBe(0);
  });

  it('assigned fan-out STAGGERED: the aggregate read fires only once the LAST iteration closes', async () => {
    const { triggerId } = await seedMovement(teamId, {
      source: ASSIGNED_FANOUT,
      firedName: 'assigned_fanout',
      name: 'Assigned fan-out (staggered)',
    });

    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const parks = await timerParks(teamId);
    const runId = parks[0].runId;

    // PASS 1 — N-1 iterations: partial, no reconstruction, no trailing read.
    await backdate(runId, parks.slice(0, FANOUT_N - 1).map((p) => p.address));
    await resumeTimerHandler.run({ runId }, testWorkContext());
    expect(slackCreates.filter((c) => c.channel === '#done')).toHaveLength(0);
    expect((await joinRows(runId))[0].pending).toBe(1);
    expect(await runStatus(runId)).toBe('parked');

    // PASS 2 — last iteration closes → the aggregate is complete over all N.
    await backdate(runId, [parks[FANOUT_N - 1].address]);
    await resumeTimerHandler.run({ runId }, testWorkContext());
    expect(slackCreates.filter((c) => c.channel === '#done')).toEqual([
      { channel: '#done', text: `count=${FANOUT_N}` },
    ]);
    expect(await runStatus(runId)).toBe('success');
  });

  // ── §10.5 — three levels deep: if { parallel { fanout } { sleep } }; joins
  // close bottom-up, each ancestor's continuation runs once. ────────────────────
  it('three levels deep (if > parallel([…]) > fan-out, version 3): joins close bottom-up, trailing runs exactly once', async () => {
    const { triggerId } = await seedMovement(teamId, {
      source: DEEP_NEST_V3,
      languageVersion: 3,
      firedName: 'deep_nest_v3',
      name: 'Deep nest (combinator)',
    });

    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const parks = await timerParks(teamId);
    // N fan-out leaves (arm 0) + 1 sleep leaf (arm 1).
    expect(parks).toHaveLength(FANOUT_N + 1);
    const runId = parks[0].runId;
    // Two join frames: the inner fan-out (pending N) and the combinator (pending 2).
    const jr = await joinRows(runId);
    expect(jr.map((r) => r.pending).sort()).toEqual([2, FANOUT_N].sort());

    await backdate(runId, parks.map((p) => p.address));
    await resumeTimerHandler.run({ runId }, testWorkContext());

    expect(slackCreates.filter((c) => c.channel === '#alerts')).toHaveLength(FANOUT_N);
    expect(slackCreates.filter((c) => c.channel === '#other')).toHaveLength(1);
    // The combinator's continuation (inside the `if`) ran once, with both slots …
    expect(slackCreates.filter((c) => c.channel === '#joined')).toEqual([
      { channel: '#joined', text: 'fanned/other' },
    ]);
    // … then the body's trailing write, once.
    expect(slackCreates.filter((c) => c.channel === '#done')).toEqual([
      { channel: '#done', text: 'DONE' },
    ]);
    expect(await runStatus(runId)).toBe('success');
    expect(await joinRows(runId)).toEqual([]);
    expect(await joinBranchExportCount(runId)).toBe(0);
    expect(await remainingParks(runId)).toBe(0);
  });

  // ── §10.6 — re-park in a NON-JOIN continuation: the trailing statement is
  // itself a sleep. Wake 1 lands the in-if write and re-parks; wake 2 completes. ─
  it('re-park in the continuation (non-join): trailing sleep re-parks, then completes on the next wake', async () => {
    const { triggerId } = await seedMovement(teamId, {
      source: IF_THEN_SLEEP_TAIL,
      firedName: 'if_then_sleep_tail',
      name: 'If then sleep tail',
    });

    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    // Only the in-if sleep parked (control never reached the trailing sleep).
    let parks = await timerParks(teamId);
    expect(parks).toHaveLength(1);
    const runId = parks[0].runId;
    const firstAddress = parks[0].address;

    // WAKE 1 — the in-if write lands, the continuation's trailing sleep re-parks
    // at a NEW address, the run stays parked, no #done.
    await backdate(runId, [firstAddress]);
    await resumeTimerHandler.run({ runId }, testWorkContext());

    expect(slackCreates.filter((c) => c.channel === '#alerts')).toEqual([
      { channel: '#alerts', text: 'in-if' },
    ]);
    expect(slackCreates.filter((c) => c.channel === '#done')).toHaveLength(0);
    expect(await runStatus(runId)).toBe('parked');
    parks = await timerParks(teamId);
    expect(parks).toHaveLength(1);
    expect(parks[0].address).not.toEqual(firstAddress); // a fresh timer park

    // WAKE 2 — the trailing sleep is due; the final write lands, run succeeds.
    await backdate(runId, [parks[0].address]);
    await resumeTimerHandler.run({ runId }, testWorkContext());

    expect(slackCreates.filter((c) => c.channel === '#done')).toEqual([
      { channel: '#done', text: 'final' },
    ]);
    expect(await runStatus(runId)).toBe('success');
    expect(await remainingParks(runId)).toBe(0);
  });

  // ── §10.6 — re-park in the CLOSER's continuation (fan-out): the closer closes
  // the inner join, then the trailing sleep re-parks. The closed inner join must
  // be left untouched (marked closed, pending 0, no further decrement). ─────────
  it('re-park in the closer continuation (fan-out): the closed inner join is left untouched', async () => {
    const { triggerId } = await seedMovement(teamId, {
      source: FANOUT_TAIL_REPARK,
      firedName: 'fanout_tail_repark',
      name: 'Fan-out tail re-park',
    });

    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const parks = await timerParks(teamId);
    expect(parks).toHaveLength(FANOUT_N);
    const runId = parks[0].runId;

    // WAKE 1 — all N fan-out leaves wake; the closer folds the join and its
    // continuation (the trailing sleep) re-parks. No #done; run stays parked.
    await backdate(runId, parks.map((p) => p.address));
    await resumeTimerHandler.run({ runId }, testWorkContext());

    expect(slackCreates.filter((c) => c.channel === '#alerts')).toHaveLength(FANOUT_N);
    expect(slackCreates.filter((c) => c.channel === '#done')).toHaveLength(0);
    expect(await runStatus(runId)).toBe('parked');

    // The inner fan-out join is CLOSED (pending 0, closer marked) and untouched.
    const jr = await joinRows(runId);
    expect(jr).toHaveLength(1);
    expect(jr[0].pending).toBe(0);
    expect(jr[0].closedBy).not.toBeNull();

    // Exactly one fresh timer park (the trailing sleep).
    const reparks = await timerParks(teamId);
    expect(reparks).toHaveLength(1);

    // WAKE 2 — the trailing sleep completes the run once.
    await backdate(runId, [reparks[0].address]);
    await resumeTimerHandler.run({ runId }, testWorkContext());
    expect(slackCreates.filter((c) => c.channel === '#done')).toEqual([
      { channel: '#done', text: 'DONE' },
    ]);
    expect(await runStatus(runId)).toBe('success');
    expect(await joinRows(runId)).toEqual([]);
    expect(await remainingParks(runId)).toBe(0);
  });

  // ── §10.9 — crash-safety of the closer continuation. Reuse the re-park fixture
  // (its closed join_pending + branch-export rows SURVIVE, since the run stays
  // parked): re-insert the closer's leaf (simulating a crash before deleteLeaf)
  // and re-scan. The closer re-runs, deduped (no doubled writes), the join is not
  // re-decremented, and a sibling never runs the continuation. ─────────────────
  it('crash-safety: the closer leaf survives a crash and is re-scanned — deduped, never doubled, never run by a sibling', async () => {
    const { triggerId } = await seedMovement(teamId, {
      source: FANOUT_TAIL_REPARK,
      firedName: 'fanout_tail_repark',
      name: 'Fan-out tail re-park (crash)',
    });

    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const parks = await timerParks(teamId);
    expect(parks).toHaveLength(FANOUT_N);
    const runId = parks[0].runId;

    // Drive the fan-out closed: all N wake, the closer folds and re-parks at the
    // trailing sleep. The closed inner join + all N branch-export rows survive.
    await backdate(runId, parks.map((p) => p.address));
    await resumeTimerHandler.run({ runId }, testWorkContext());
    expect(slackCreates.filter((c) => c.channel === '#alerts')).toHaveLength(FANOUT_N);
    const jrBefore = await joinRows(runId);
    expect(jrBefore).toHaveLength(1);
    expect(jrBefore[0].pending).toBe(0);
    const closerAddress = jrBefore[0].closedBy!;
    expect(closerAddress).not.toBeNull();
    const exportsBefore = await joinBranchExportCount(runId);
    expect(exportsBefore).toBe(FANOUT_N);
    const closerPark = parks.find((p) => p.address === closerAddress)!;
    const nonCloserPark = parks.find((p) => p.address !== closerAddress)!;

    // Simulate a crash BETWEEN decrement-to-0 and deleteLeaf: the closer's leaf
    // row was never deleted. Re-insert it as `parked` (backdated) and re-scan.
    await getAutomationsQb(['parked_run'])
      .insertInto('parked_run')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        run_id: runId,
        address: closerPark.address,
        status: 'parked',
        park_reason: 'timer',
        wake_at: new Date(Date.now() - 60_000),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        state: closerPark.state as any,
      } as any)
      .execute();

    await resumeTimerHandler.run({ runId }, testWorkContext());

    // The re-scanned closer re-ran its leaf block (the #alerts write) — DEDUPED,
    // so still exactly N (not N+1). The trailing #done is still absent (its own
    // continuation re-parked again). The join is UNTOUCHED (pending still 0, same
    // closer), and the branch-export store is not corrupted.
    expect(slackCreates.filter((c) => c.channel === '#alerts')).toHaveLength(FANOUT_N);
    expect(slackCreates.filter((c) => c.channel === '#done')).toHaveLength(0);
    const jrAfter = await joinRows(runId);
    expect(jrAfter).toHaveLength(1);
    expect(jrAfter[0].pending).toBe(0);
    expect(jrAfter[0].closedBy).toEqual(closerAddress);
    expect(await joinBranchExportCount(runId)).toBe(FANOUT_N);

    // A re-scanned SIBLING (non-closer) must NEVER run the continuation: re-insert
    // a non-closer leaf and re-scan. It re-runs its own write (deduped) but reads
    // closed_by_address !== itself → does not fold, does not run #done.
    await getAutomationsQb(['parked_run'])
      .insertInto('parked_run')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        run_id: runId,
        address: nonCloserPark.address,
        status: 'parked',
        park_reason: 'timer',
        wake_at: new Date(Date.now() - 60_000),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        state: nonCloserPark.state as any,
      } as any)
      .execute();
    await resumeTimerHandler.run({ runId }, testWorkContext());
    expect(slackCreates.filter((c) => c.channel === '#alerts')).toHaveLength(FANOUT_N);
    expect(slackCreates.filter((c) => c.channel === '#done')).toHaveLength(0);
    expect((await joinRows(runId))[0].pending).toBe(0);

    // Finally, wake the surviving trailing sleep → the run completes ONCE, with a
    // single #done despite all the crash re-scans.
    const finalParks = await timerParks(teamId);
    const tailPark = finalParks.find(
      (p) => p.address !== closerPark.address && p.address !== nonCloserPark.address,
    )!;
    await backdate(runId, [tailPark.address]);
    await resumeTimerHandler.run({ runId }, testWorkContext());
    expect(slackCreates.filter((c) => c.channel === '#done')).toEqual([
      { channel: '#done', text: 'DONE' },
    ]);
    expect(await runStatus(runId)).toBe('success');
    expect(await remainingParks(runId)).toBe(0);
  });

  // ── §7 residual (now CLOSED) — per-leaf EXACTLY-ONCE decrement. The AMPLIFIED
  // crash gap: a NON-closer re-scanned in the window between its decrement and its
  // parked_run delete, WHILE THE JOIN IS STILL OPEN. Without the claim it would
  // decrement the join a SECOND time → close it EARLY → the closer would fold an
  // INCOMPLETE aggregate and the genuinely-last sibling would hit a closed join and
  // lose its export + continuation. The per-leaf claim
  // (join_branch_export.decremented) makes each branch's decrement fire exactly
  // once, so the re-scan is a no-op on the count. (Distinct from the §10.9 sibling
  // re-scan, which happens only AFTER the join is already closed.) ──────────────
  it('non-closer crash (join still open): re-scan does NOT re-decrement; the join closes late with the FULL aggregate, continuation runs once', async () => {
    const { triggerId } = await seedMovement(teamId, {
      source: FANOUT_THEN_TAIL,
      firedName: 'fanout_then_tail',
      name: 'Fan-out then tail (non-closer crash)',
    });

    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    const parks = await timerParks(teamId);
    expect(parks).toHaveLength(FANOUT_N);
    const runId = parks[0].runId;
    expect((await joinRows(runId))[0].pending).toBe(FANOUT_N);

    // PASS 1 — wake exactly ONE branch. pending FANOUT_N -> FANOUT_N-1 (>0), so it
    // is a NON-closer; its export row is now decremented=true and — after the
    // successful firing — its parked_run leaf is deleted by the driver.
    const nonCloser = parks[0];
    await backdate(runId, [nonCloser.address]);
    await resumeTimerHandler.run({ runId }, testWorkContext());
    expect(slackCreates.filter((c) => c.channel === '#alerts')).toHaveLength(1);
    expect(slackCreates.filter((c) => c.channel === '#done')).toHaveLength(0);
    expect((await joinRows(runId))[0].pending).toBe(FANOUT_N - 1);
    expect((await joinRows(runId))[0].closedBy).toBeNull();
    expect(await runStatus(runId)).toBe('parked');

    // CRASH: re-insert the non-closer's leaf (simulating a crash BEFORE its
    // deleteLeaf), leaving its export row decremented=true, and re-scan. The claim
    // must find NO decremented=false row for this branch → NO second decrement.
    await getAutomationsQb(['parked_run'])
      .insertInto('parked_run')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        run_id: runId,
        address: nonCloser.address,
        status: 'parked',
        park_reason: 'timer',
        wake_at: new Date(Date.now() - 60_000),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        state: nonCloser.state as any,
      } as any)
      .execute();

    await resumeTimerHandler.run({ runId }, testWorkContext());

    // The re-scanned non-closer re-ran its own write (deduped, still 1) but the
    // join was NOT re-decremented (pending STILL FANOUT_N-1, NOT closed early) and
    // no #done ran. This is the assertion the old unconditional decrement failed:
    // without the claim, pending would be FANOUT_N-2 here and could close early.
    expect(slackCreates.filter((c) => c.channel === '#alerts')).toHaveLength(1);
    expect(slackCreates.filter((c) => c.channel === '#done')).toHaveLength(0);
    expect((await joinRows(runId))[0].pending).toBe(FANOUT_N - 1);
    expect((await joinRows(runId))[0].closedBy).toBeNull();
    expect(await runStatus(runId)).toBe('parked');

    // PASS 2 — wake the remaining FANOUT_N-1 branches. The genuinely-LAST one
    // closes the join with the FULL aggregate (all FANOUT_N exports folded) and
    // runs the trailing continuation EXACTLY ONCE.
    const remaining = parks.slice(1).map((p) => p.address);
    await backdate(runId, remaining);
    await resumeTimerHandler.run({ runId }, testWorkContext());

    expect(slackCreates.filter((c) => c.channel === '#alerts')).toHaveLength(FANOUT_N);
    expect(slackCreates.filter((c) => c.channel === '#done')).toEqual([
      { channel: '#done', text: 'ALL DONE' },
    ]);
    expect(await runStatus(runId)).toBe('success');
    expect(await joinRows(runId)).toEqual([]);
    expect(await joinBranchExportCount(runId)).toBe(0);
    expect(await remainingParks(runId)).toBe(0);
  });
});
