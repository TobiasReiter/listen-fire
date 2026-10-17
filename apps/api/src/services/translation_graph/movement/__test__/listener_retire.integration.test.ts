// Retiring a listener on re-save, over the REAL seams (real Postgres, the
// real saveMovement gate, a live remote adapter socket).
//
// The invariant: a save's `listen` statements are the AUTHORITATIVE listener
// set. Anything registered for the movement and absent from the new source
// stops being a dispatch route — the trigger row is gone, so a matching
// inbound event finds nothing to fire.
//
// The unit tier already covers this against an in-memory table fake
// (./save.unit.test.ts); this leg exists because the reported production
// failure survived that fake.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { FakeCrmServer } from '../../../../scripts/dev/fake_crm_adapter';

import { getAutomationsQb, getCoreQb, getQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { saveMovement } from '../provision';
import { findTriggersByKind } from '../../storage/tg_table';
import { installRemoteAdapterFromManifest } from '../../adapters/remote/install';
import {
  FAKE_CRM_ADAPTER_TYPE,
  FAKE_CRM_COMPANY_TYPE,
  startFakeCrmServer,
} from '../../../../scripts/dev/fake_crm_adapter';


jest.mock('../../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));
jest.mock('../../../../lib/slack', () => ({
  sendSlackNotification: async () => undefined,
}));

const NAME = 'listener-retire-probe';

const BODY = `import { manual, \`${FAKE_CRM_ADAPTER_TYPE}\` as crm } from adapters

runs = connect manual
other = connect manual
df = connect crm

function probe(go: <runs-[:\`Invocation\`]->>) {
  write df-[:\`${FAKE_CRM_COMPANY_TYPE}\`]-> {
    Name: "Vireo Robotics"
  }
}

function second(go: <other-[:\`Invocation\`]->>) {
  write df-[:\`${FAKE_CRM_COMPANY_TYPE}\`]-> {
    Name: "Second Robotics"
  }
}
`;

const WITH_ONE_LISTEN = `${BODY}
listen to runs {} fire probe
`;

const WITH_TWO_LISTENS = `${WITH_ONE_LISTEN}listen as "second lane" to other {} fire second
`;

const RENAMED_LANE = `${BODY}
listen as "first lane" to runs {} fire probe
`;

const WITH_NO_LISTEN = BODY;

describe('listener retirement on re-save (real Postgres + live adapter socket)', () => {
  let teamId: TeamId;
  let server: FakeCrmServer;

  const triggerRows = async (movementId: string) =>
    (
      await getAutomationsQb(['trigger'])
        .selectFrom('trigger')
        .where('team_id', '=', teamId as never)
        .select(['id', 'name', 'kind', 'movement_id', 'fired_movement_name'])
        .execute()
    ).filter((r) => (r.movement_id as unknown as string) === movementId);

  /** The route an inbound event actually takes — the same lookup dispatch
   *  uses, not a bespoke read of the table. */
  const dispatchRoutes = async (movementId: string) =>
    (await findTriggersByKind({ teamId: teamId as string, kinds: ['manual'] })).filter(
      (t) => t.movementId === movementId,
    );

  beforeAll(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `retire-${teamId.slice(0, 8)}` } as any)
      .execute();
    const pcId = randomUUID();
    await getQb(['pipeline_configuration'])
      .insertInto('pipeline_configuration')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: pcId, team_id: teamId, name: 'retire-probe' } as any)
      .execute();
    await getCoreQb(['team'])
      .updateTable('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ active_pipeline_configuration_id: pcId } as any)
      .where('id', '=', teamId)
      .execute();
    server = await startFakeCrmServer({ secret: 'retire-secret' });
    await installRemoteAdapterFromManifest({
      teamId,
      userId: null,
      manifest: {
        protocolVersion: 2,
        adapterType: FAKE_CRM_ADAPTER_TYPE,
        baseUrl: server.baseUrl,
        authStrategy: { kind: 'bearer' },
        supportedTriggers: [],
        runtimeCapabilities: {
          traversal: { incoming: false, edgeProperties: false },
          resources: false,
        },
        methods: ['listEntryPoints', 'describe', 'resolveEntity', 'createRecord'],
      },
      secret: 'retire-secret',
    });
  }, 60_000);

  afterAll(async () => {
    await server.close().catch(() => {});
    await cleanupTeam(teamId);
  });

  /** Save under a name of this test's own, so each case owns its movement row. */
  const save = async (input: { name: string; source: string; id?: string }) => {
    const result = await saveMovement({
      teamId: teamId as string,
      source: input.source,
      name: input.name,
      ...(input.id !== undefined ? { id: input.id } : {}),
    });
    if (!result.ok) throw new Error(`save failed: ${JSON.stringify(result, null, 2)}`);
    return result;
  };

  it('deleting the only listen line leaves no row and no dispatch route', async () => {
    const name = `${NAME}-all`;
    const first = await save({ name, source: WITH_ONE_LISTEN });
    expect(first.listeners).toHaveLength(1);
    expect(await dispatchRoutes(first.movementId)).toHaveLength(1);

    const second = await save({ name, id: first.movementId, source: WITH_NO_LISTEN });
    expect(second.listeners).toEqual([]);
    expect(await triggerRows(first.movementId)).toEqual([]);
    expect(await dispatchRoutes(first.movementId)).toEqual([]);
  }, 120_000);

  it('removing one of two listens retires only the removed lane', async () => {
    const name = `${NAME}-two`;
    const both = await save({ name, source: WITH_TWO_LISTENS });
    expect(both.listeners).toHaveLength(2);
    const kept = both.listeners.find((l) => l.movementName === 'probe');

    const one = await save({ name, id: both.movementId, source: WITH_ONE_LISTEN });
    expect(one.listeners).toHaveLength(1);

    const rows = await triggerRows(both.movementId);
    expect(rows).toHaveLength(1);
    expect(rows[0].fired_movement_name).toBe('probe');
    // The surviving lane keeps its identity (and its run history).
    expect(one.listeners[0].triggerId).toBe(kept?.triggerId);
  }, 120_000);

  it('renaming a lane keeps its row (identity is the channel, not the alias)', async () => {
    const name = `${NAME}-rename`;
    const first = await save({ name, source: WITH_ONE_LISTEN });
    const renamed = await save({ name, id: first.movementId, source: RENAMED_LANE });

    expect(renamed.listeners).toHaveLength(1);
    expect(renamed.listeners[0].triggerId).toBe(first.listeners[0].triggerId);
    const rows = await triggerRows(first.movementId);
    expect(rows.map((r) => r.name)).toEqual(['first lane']);
  }, 120_000);

  it('a run parked on the retired listener is settled, not stranded', async () => {
    const name = `${NAME}-parked`;
    const first = await save({ name, source: WITH_ONE_LISTEN });
    const triggerId = first.listeners[0].triggerId;

    // A run waiting to continue on that listener (an ask, a timer, an await —
    // the park reason doesn't matter; the trigger row is what every resume
    // driver loads first).
    const runId = randomUUID();
    await getAutomationsQb(['trigger_run'])
      .insertInto('trigger_run')
      .values({
        id: runId,
        team_id: teamId,
        trigger_id: triggerId,
        trigger_type: 'manual',
        status: 'parked',
        trigger_payload: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      .execute();
    await getAutomationsQb(['parked_run'])
      .insertInto('parked_run')
      .values({
        id: randomUUID(),
        run_id: runId,
        address: 'root',
        status: 'parked',
        park_reason: 'ask',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      .execute();

    await save({ name, id: first.movementId, source: WITH_NO_LISTEN });

    const run = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', runId as never)
      .select(['status', 'failure_reason'])
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('failed');
    expect(run.failure_reason).toMatch(/listener was removed/);

    const stillParked = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .where('run_id', '=', runId as never)
      .select('id')
      .execute();
    expect(stillParked).toEqual([]);
  }, 120_000);

  it('re-adding a listen after removing it restores the dispatch route', async () => {
    const name = `${NAME}-readd`;
    const first = await save({ name, source: WITH_ONE_LISTEN });
    await save({ name, id: first.movementId, source: WITH_NO_LISTEN });
    expect(await dispatchRoutes(first.movementId)).toEqual([]);

    const readded = await save({ name, id: first.movementId, source: WITH_ONE_LISTEN });
    expect(readded.listeners).toHaveLength(1);
    expect(readded.listeners[0].reused).toBe(false);
    const routes = await dispatchRoutes(first.movementId);
    expect(routes).toHaveLength(1);
    expect(routes[0].id).toBe(readded.listeners[0].triggerId);
  }, 120_000);
});
