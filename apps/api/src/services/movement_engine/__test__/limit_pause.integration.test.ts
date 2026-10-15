// A run that meets its cost cap PAUSES, against the REAL DB, and resuming it
// carries it on (movement_engine/limit_pause.ts). The movement fetches twice,
// writing after each; the cap is one dollar and each fetch costs one. The
// dispatch fetches once, writes, and meets the cap before the second fetch:
//   · the run is `parked`, with ONE `parked_run` row (`park_reason='limit'`) at
//     the statement that would have spent, and `trigger_run.limit_pause` set;
//   · a `Run Paused` system event is stored for the team;
//   · the run's status says paused, with what it spent and the cap;
//   · `resumeRun` resumes it with its usage reset: the second fetch and write
//     happen, nothing before them happens again, and the run settles success.
//
// The network seams (catalog introspection, adapter I/O) are mocked as in
// timer_resume.integration.test.ts; the plugin is a priced stand-in.
//
// The second case pauses where the priced call is the identity judge — a
// `unique by` write whose fuzzy search finds two candidates — with no plugin
// in the program, so the Rust engine runs it whole (MOVEMENT_ENGINE=rust):
// the same pause row, the same `parked_run` leaf, the same operator resume.
// The judge's model call is a priced stand-in at the prompt seam.

import { randomUUID } from 'node:crypto';

jest.mock('../../translation_graph/movement/catalog', () => {
  const actual = jest.requireActual('../../translation_graph/movement/catalog');
  return { ...actual, runCatalogSnapshotForTeam: jest.fn() };
});
jest.mock('../../translation_graph/adapters/resolve', () => {
  const actual = jest.requireActual('../../translation_graph/adapters/resolve');
  return { ...actual, resolveAdapter: jest.fn() };
});

const mockFetched: string[] = [];
jest.mock('../../translation_graph/movement/transform_invoker', () => {
  const actual = jest.requireActual('../../translation_graph/movement/transform_invoker');
  const runSpend = jest.requireActual('../../../lib/run_spend');
  return {
    ...actual,
    registryTransformInvoker: {
      async invoke({ config }: { config: Record<string, unknown> }) {
        mockFetched.push(String(config.url));
        runSpend.reportRunCost({ source: { kind: 'service', name: 'test.fetch' }, microdollars: 1_000_000 });
        return { text: `got-${String(config.url)}` };
      },
    },
  };
});

// The identity judge's model call: one dollar a judgement, refused before it
// starts once the run's budget is spent (as the metered model call is).
let mockJudgements = 0;
jest.mock('../../../lib/prompts/execute', () => {
  const actual = jest.requireActual('../../../lib/prompts/execute');
  const runSpend = jest.requireActual('../../../lib/run_spend');
  return {
    ...actual,
    async execute(name: string, ...rest: unknown[]) {
      if (name !== 'tg_entity_match') return actual.execute(name, ...rest);
      runSpend.assertRunBudget();
      mockJudgements += 1;
      runSpend.reportRunCost({ source: { kind: 'model', name: 'test.judge' }, microdollars: 1_000_000 });
      return { match_index: 0, confidence: 0.9, reasoning: 'test' };
    },
  };
});

import { getAutomationsQb, getCoreQb, getQb } from '../../../lib/kysely';
import { resetRustRunStats, rustRunStats } from 'movement-engine/services/movement_engine/rust_stats';
import { resumeRun } from '../../interaction/operator';
import { claimRunLease, releaseRunLease, RunBusy } from '../run_lease';
import { getMovementRunStatus } from '../../translation_graph/movement/run_now';

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
import type { Catalog, CatalogSnapshot, InstanceSchema, PositionSchema } from 'movement-lang';
import { eventAddressKey, CURRENT_LANGUAGE_VERSION } from 'movement-lang';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';

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

/** A message target whose search is fuzzy, so a `unique by (FUZZY …)` key
 *  that finds two near matches asks the judge. */
const JUDGED_SLACK_SCHEMA: InstanceSchema = {
  positions: { message: { properties: { channel: 'text', text: 'text' }, edges: {} } },
  collections: { messages: { target: 'message' } },
  writableRoots: {
    message: {
      fields: { channel: 'text', text: 'text' },
      resultShape: { externalId: 'text', channel: 'text', text: 'text' },
      fuzzyResolution: true,
    },
  },
};

function buildCatalog(options: { judgedSlack?: boolean } = {}): CatalogSnapshot {
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
      if (name === 'slack' && options.judgedSlack === true) return JUDGED_SLACK_SCHEMA;
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

/** A message target whose search finds two messages near the asserted one:
 *  neither is it exactly, so the rules cannot decide and the judge is asked. */
function makeJudgedSlackFake(): { adapter: Adapter; updates: string[] } {
  const updates: string[] = [];
  const { adapter } = makeSlackTargetFake();
  return {
    adapter: {
      ...adapter,
      async resolveEntity() {
        return {
          candidates: [
            { adapterType: 'slack', externalId: 'm-1', data: { channel: '#a', text: 'Example Labs' } },
            { adapterType: 'slack', externalId: 'm-2', data: { channel: '#a', text: 'Example Ltd' } },
          ],
        };
      },
      async updateRecord(input) {
        updates.push(input.externalId);
        return { adapterType: 'slack', externalId: input.externalId, data: {}, association: containerAssociation(input) };
      },
    },
    updates,
  };
}

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

const FETCH_TWICE = [
  'import { attio, slack } from adapters',
  'import { acme_main, acme_slack } from credentials',
  'import { fetch_url } from plugins',
  '',
  'crm = attio(credentials: acme_main)',
  'chat = slack(credentials: acme_slack)',
  '',
  'movement fetch_twice(ev: <crm-[:`Webhook Event`]->>) {',
  '  page = fetch_url(url: "a")',
  '  write chat-[:messages]-> {',
  '    channel: "#a"',
  '    text: COALESCE(page, "none")',
  '  }',
  '  more = fetch_url(url: "b")',
  '  write chat-[:messages]-> {',
  '    channel: "#b"',
  '    text: COALESCE(more, "none")',
  '  }',
  '}',
  '',
  'listen to crm { events: ["record.created"] } fire fetch_twice',
].join('\n');

const ENV_VAR = 'MOVEMENT_MAX_RUN_COST_USD';

describe('a run paused at its cost cap (real DB)', () => {
  let teamId: TeamId;
  let slackCreates: Record<string, unknown>[];
  let savedCap: string | undefined;

  beforeEach(async () => {
    savedCap = process.env[ENV_VAR];
    process.env[ENV_VAR] = '1';
    mockFetched.length = 0;
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `limit-pause-${teamId.slice(0, 8)}` } as any)
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
    if (savedCap === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = savedCap;
    await getAutomationsQb(['system_event']).deleteFrom('system_event').where('team_id', '=', teamId).execute();
    await cleanupTeam(teamId);
    jest.clearAllMocks();
  });

  it('pauses before the statement that would spend, says so, and resumes with its usage reset', async () => {
    const { triggerId } = await seedMovement(teamId, {
      source: FETCH_TWICE,
      firedName: 'fetch_twice',
      name: 'Fetch twice',
    });

    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    expect(mockFetched).toEqual(['a']);
    expect(slackCreates).toEqual([{ channel: '#a', text: 'got-a' }]);

    const run = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('team_id', '=', teamId)
      .select(['id', 'status', 'limit_pause'])
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('parked');
    expect(run.limit_pause).toMatchObject({ limit: 'cost', capMicrodollars: 1_000_000, spentMicrodollars: 1_000_000 });

    const leaves = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .where('run_id', '=', run.id)
      .select(['address', 'park_reason', 'status'])
      .execute();
    expect(leaves).toEqual([{ address: 's2', park_reason: 'limit', status: 'parked' }]);

    const events = await getAutomationsQb(['system_event'])
      .selectFrom('system_event')
      .where('team_id', '=', teamId)
      .select(['kind', 'payload'])
      .execute();
    expect(events.map((e) => e.kind)).toEqual(['run_paused']);
    expect(events[0]?.payload).toMatchObject({ automation: 'Fetch twice', runId: run.id });

    const status = await getMovementRunStatus({ teamId, runId: run.id });
    expect(status).toMatchObject({ status: 'parked', paused: { spentUsd: 1, capUsd: 1 } });

    // Another process stepping the run: the resume is refused as busy, and
    // nothing moves.
    const elsewhere = await claimRunLease(run.id, { owner: 'another-instance', ttlMs: 60_000 });
    await expect(resumeRun({ runId: run.id, teamId })).rejects.toBeInstanceOf(RunBusy);
    expect(mockFetched).toEqual(['a']);
    await releaseRunLease(run.id, elsewhere!.token);

    const resumed = await resumeRun({ runId: run.id, teamId });
    expect(resumed).toEqual({ runId: run.id, resumed: 1 });

    // Only the second fetch and write: the first are not done again.
    expect(mockFetched).toEqual(['a', 'b']);
    expect(slackCreates).toEqual([
      { channel: '#a', text: 'got-a' },
      { channel: '#b', text: 'got-b' },
    ]);

    const after = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', run.id)
      .select(['status', 'limit_pause', 'cost_cap_baseline_microdollars'])
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('success');
    expect(after.limit_pause).toBeNull();
    expect(Number(after.cost_cap_baseline_microdollars)).toBe(1_000_000);
    const remaining = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .where('run_id', '=', run.id)
      .select('id')
      .execute();
    expect(remaining).toHaveLength(0);

    // A run that is not paused at a limit cannot be resumed.
    await expect(resumeRun({ runId: run.id, teamId })).rejects.toThrow(/not paused at a limit/);
  });

  it('pauses at a judged unique-by write, and the operator resume carries it on — whole in the Rust engine under MOVEMENT_ENGINE=rust', async () => {
    const JUDGED_TWICE = [
      'import { attio, slack } from adapters',
      'import { acme_main, acme_slack } from credentials',
      '',
      'crm = attio(credentials: acme_main)',
      'chat = slack(credentials: acme_slack)',
      '',
      'movement judged_twice(ev: <crm-[:`Webhook Event`]->>) {',
      '  write chat-[:messages]-> {',
      '    unique by (FUZZY `text`)',
      '    channel: "#a"',
      '    text: "Example"',
      '  }',
      '  write chat-[:messages]-> {',
      '    unique by (FUZZY `text`)',
      '    channel: "#b"',
      '    text: "Example"',
      '  }',
      '}',
      '',
      'listen to crm { events: ["record.created"] } fire judged_twice',
    ].join('\n');
    const catalog = buildCatalog({ judgedSlack: true });
    mockedCatalog.mockResolvedValue({
      snapshot: catalog,
      credentialIds: Object.fromEntries(Object.keys(catalog.credentials).map((name) => [name, 'cred-1'])),
      notes: [],
    });
    const target = makeJudgedSlackFake();
    mockedResolve.mockImplementation(async ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'attio') return makeAttioSourceFake();
      if (adapterType === 'slack') return target.adapter;
      throw new Error(`test: no fake for '${adapterType}'`);
    });
    mockJudgements = 0;
    resetRustRunStats();
    const { triggerId } = await seedMovement(teamId, { source: JUDGED_TWICE, firedName: 'judged_twice', name: 'Judged twice' });

    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    // The first judgement spent the cap and its write stands; the second was
    // refused before it started, and the run paused before that write.
    expect(mockJudgements).toBe(1);
    expect(target.updates).toEqual(['m-1']);
    if (process.env.MOVEMENT_ENGINE === 'rust') {
      expect(rustRunStats.ranWhole).toBe(1);
      expect(rustRunStats.notAdmitted).toEqual({});
      expect(rustRunStats.declined).toEqual({});
    }

    const run = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('team_id', '=', teamId)
      .select(['id', 'status', 'limit_pause'])
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('parked');
    expect(run.limit_pause).toMatchObject({ limit: 'cost', capMicrodollars: 1_000_000, spentMicrodollars: 1_000_000 });
    const leaves = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .where('run_id', '=', run.id)
      .select(['address', 'park_reason', 'status'])
      .execute();
    expect(leaves).toEqual([{ address: 's1', park_reason: 'limit', status: 'parked' }]);

    const resumed = await resumeRun({ runId: run.id, teamId });
    expect(resumed).toEqual({ runId: run.id, resumed: 1 });
    // The second write is judged and lands; the first is not done again.
    expect(mockJudgements).toBe(2);
    expect(target.updates).toEqual(['m-1', 'm-1']);
    if (process.env.MOVEMENT_ENGINE === 'rust') {
      // The resume ran whole in the Rust engine too.
      expect(rustRunStats.ranWhole).toBe(2);
      expect(rustRunStats.notAdmitted).toEqual({});
      expect(rustRunStats.declined).toEqual({});
      expect(rustRunStats.shimFaults).toBe(0);
    }
    const after = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', run.id)
      .select(['status', 'limit_pause'])
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('success');
    expect(after.limit_pause).toBeNull();
  });
});
