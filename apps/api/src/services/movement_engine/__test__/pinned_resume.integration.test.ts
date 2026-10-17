// The pin a paused run resumes on, through the real wake path (real DB, the
// Rust engine): a run parks inside a library function; while it waits, the
// movement is edited and redeployed (a new movement_version) and the library
// is edited (the team's saved files); the wake resumes it on the movement text
// it was pinned to (trigger_run.movement_version_id; version rows are
// immutable) and on the library text its park pinned (park state version 2's
// `libraries`, kept once by hash in automations.park_library_source).
//
// Only the network seams are mocked, as timer_resume.integration.test.ts does:
// the catalog snapshot (which is also where the team's library files come
// from, so editing it is editing the library) and adapter I/O.

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
import type { ParkLibrarySourceTeamId } from '../../../generated/kysely/automations/ParkLibrarySource';
import type { PipelineConfigurationId } from '../../../generated/kysely/public/PipelineConfiguration';
import { dispatchTriggerByIdEvent } from '../../translation_graph/triggers/router';
import { runCatalogSnapshotForTeam, snapshotOverManifests, staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { resolveAdapter } from '../../translation_graph/adapters/resolve';
import { mintMovementVersionIfChanged } from '../../translation_graph/movement/version_store';
import { positionData } from 'movement-engine/services/translation_graph/types';
import type { Adapter, RuntimeCapabilities } from 'movement-engine/services/translation_graph/adapter';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import type { Catalog, CatalogSnapshot, InstanceSchema, PositionSchema } from 'movement-lang';
import { eventAddressKey, CURRENT_LANGUAGE_VERSION, fromCatalogSnapshot, resolveFileFromSnapshot } from 'movement-lang';
import { spelledFor } from 'movement-lang/checker/__test__/surface_spelling';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
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

/** Written once in the spelling versions 1–4 read; respelled for version 5
 *  as the upgrade tool respells it (`spelled`). */
const LIBRARY = (marker: string) =>
  [
    'export function greeting(who: <text>) {',
    '  f = (x: <text>) => {',
    `    return CONCAT(x, "/lib-${marker}")`,
    '  }',
    '  await sleep(1s)',
    '  return f(who)',
    '}',
  ].join('\n');

const ROOT = (marker: string) =>
  [
    'import { attio, slack } from adapters',
    'import { acme_main, acme_slack } from credentials',
    'import { greeting } from "lib/words"',
    '',
    'crm = attio(credentials: acme_main)',
    'chat = slack(credentials: acme_slack)',
    '',
    'movement pinned(ev: <crm-[:`Webhook Event`]->>) {',
    `  said = greeting("root-${marker}")`,
    '  write chat-[:messages]-> {',
    '    channel: "#alerts"',
    `    text: CONCAT(said, "/after-${marker}")`,
    '  }',
    '}',
    '',
    'listen to crm { events: ["record.created"] } fire pinned',
  ].join('\n');

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

function spelled(text: string): string {
  const catalog = { ...buildCatalog(), files: { 'lib/words': { source: spelledFor(5, LIBRARY('ORIGINAL'), fromCatalogSnapshot(buildCatalog())) } } };
  return spelledFor(5, text, fromCatalogSnapshot(catalog), { resolveFile: resolveFileFromSnapshot(catalog) });
}

/** The library-source store keys its rows by its own team id type. */
const libraryRowTeam = (teamId: TeamId): ParkLibrarySourceTeamId => teamId as string as ParkLibrarySourceTeamId;

describe('a paused run resumes on the text it was pinned to (real DB, Rust engine)', () => {
  let teamId: TeamId;
  let slackCreates: Record<string, unknown>[];

  /** The catalog snapshot the run host reads, with the team's library as saved now. */
  function serveLibrary(marker: string) {
    const catalog = { ...buildCatalog(), files: { 'lib/words': { source: spelled(LIBRARY(marker)) } } };
    mockedCatalog.mockResolvedValue({
      snapshot: catalog,
      credentialIds: Object.fromEntries(Object.keys(catalog.credentials).map((name) => [name, 'cred-1'])),
      notes: [],
    });
  }

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `pinned-resume-${teamId.slice(0, 8)}` } as any)
      .execute();
    serveLibrary('ORIGINAL');
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
    await getAutomationsQb(['park_library_source']).deleteFrom('park_library_source').where('team_id', '=', libraryRowTeam(teamId)).execute();
    jest.clearAllMocks();
  });

  it('runs the movement and library text it parked with, though both were edited while it waited', async () => {
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
      .values({ id: movementId, team_id: teamId, name: 'Pinned', source: spelled(ROOT('ORIGINAL')), language_version: CURRENT_LANGUAGE_VERSION } as any)
      .execute();
    await mintMovementVersionIfChanged({ teamId, movementId, source: spelled(ROOT('ORIGINAL')), languageVersion: CURRENT_LANGUAGE_VERSION });
    const triggerId = randomUUID() as TriggerId;
    await getAutomationsQb(['trigger'])
      .insertInto('trigger')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: triggerId, team_id: teamId, pipeline_configuration_id: pipelineConfigurationId, name: 'Attio record changes', kind: 'attio', movement_id: movementId, fired_movement_name: 'pinned' } as any)
      .execute();

    // The run parks inside the library function, before its closure runs.
    await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });
    expect(slackCreates).toHaveLength(0);
    const parked = await getAutomationsQb(['parked_run', 'trigger_run'])
      .selectFrom('parked_run')
      .innerJoin('trigger_run', 'trigger_run.id', 'parked_run.run_id')
      .where('trigger_run.team_id', '=', teamId)
      .where('parked_run.status', '=', 'parked')
      .select(['parked_run.run_id as run_id', 'parked_run.address as address', 'parked_run.state as state'])
      .executeTakeFirstOrThrow();
    // Park state version 2 (the Rust engine's): the library named by the hash
    // its one stored text is kept by.
    const state = parked.state as { version: number; libraries: Array<{ path: string; hash: string }> };
    expect(state.version).toBe(2);
    expect(state.libraries).toEqual([{ path: 'lib/words', hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) }]);
    const stored = await getAutomationsQb(['park_library_source'])
      .selectFrom('park_library_source')
      .where('team_id', '=', libraryRowTeam(teamId))
      .select(['hash', 'source'])
      .execute();
    expect(stored).toEqual([{ hash: state.libraries[0]?.hash, source: spelled(LIBRARY('ORIGINAL')) }]);

    // While it waits: the movement is edited and redeployed, and the library
    // edited.
    await getAutomationsQb(['movement']).updateTable('movement').set({ source: spelled(ROOT('EDITED')) }).where('id', '=', movementId).execute();
    const redeployed = await mintMovementVersionIfChanged({ teamId, movementId, source: spelled(ROOT('EDITED')), languageVersion: CURRENT_LANGUAGE_VERSION });
    expect(redeployed.minted).toBe(true);
    serveLibrary('EDITED');

    // The wake.
    await getAutomationsQb(['parked_run'])
      .updateTable('parked_run')
      .set({ wake_at: new Date(Date.now() - 60_000) })
      .where('run_id', '=', parked.run_id)
      .where('address', '=', parked.address)
      .execute();
    await resumeTimerHandler.run({ runId: parked.run_id }, testWorkContext());

    expect(slackCreates).toEqual([{ channel: '#alerts', text: 'root-ORIGINAL/lib-ORIGINAL/after-ORIGINAL' }]);
    const run = await getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('id', '=', parked.run_id).select('status').executeTakeFirstOrThrow();
    expect(run.status).toBe('success');
  });
});
