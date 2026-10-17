// What a SUCCESSFUL save says when the outcome would surprise the author,
// over the REAL seams (real Postgres, the real saveMovement gate, a live
// remote adapter socket).
//
// Two rulings, one channel (`warnings` on the save result):
//
//   1. A save whose source can't be READ, shipped on consent, retires every
//      listener the automation had. Consent covers the consequence — the
//      alternative (old rows firing text that no longer exists) makes the
//      saved file and the running behaviour silently disagree. Runs parked on
//      those listeners are settled, not stranded.
//   2. A movement name is unique only WITHIN its file, so another automation
//      in the team can be the one firing under that name. Nothing about
//      registration is ambiguous; the AUTHOR's mental model is. Warn.

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

const NAME = 'save-warnings-probe';

/** A one-movement, one-listen file, parameterised by the movement name it
 *  declares (the axis the collision warning keys on) and whether its writes
 *  rehearse (the axis the listener's run_mode keys on). */
const fileDeclaring = (movementName: string, options: { dryRun?: boolean } = {}): string =>
  `import { manual, \`${FAKE_CRM_ADAPTER_TYPE}\` as crm } from adapters

runs = connect manual
df = connect crm${options.dryRun === true ? ' { dryRun: true }' : ''}

function ${movementName}(go: <runs-[:\`Invocation\`]->>) {
  write df-[:\`${FAKE_CRM_COMPANY_TYPE}\`]-> {
    Name: "Vireo Robotics"
  }
}

listen to runs {} fire ${movementName}
`;

/** Fails in the PARSER, not the checker — the distinction the retirement
 *  ruling turns on. */
const UNREADABLE = `import { manual } from adapters

runs = connect manual

function probe(go: <runs-[:\`Invocation\`]->>) {
  write ((((
`;

describe('save warnings (real Postgres + live adapter socket)', () => {
  let teamId: TeamId;
  let server: FakeCrmServer;

  /** The route an inbound event actually takes — the same lookup dispatch
   *  uses, not a bespoke read of the table. */
  const dispatchRoutes = async (movementId: string) =>
    (await findTriggersByKind({ teamId: teamId as string, kinds: ['manual'] })).filter(
      (t) => t.movementId === movementId,
    );

  beforeAll(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `warn-${teamId.slice(0, 8)}` } as any)
      .execute();
    const pcId = randomUUID();
    await getQb(['pipeline_configuration'])
      .insertInto('pipeline_configuration')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: pcId, team_id: teamId, name: 'warn-probe' } as any)
      .execute();
    await getCoreQb(['team'])
      .updateTable('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ active_pipeline_configuration_id: pcId } as any)
      .where('id', '=', teamId)
      .execute();
    server = await startFakeCrmServer({ secret: 'warn-secret' });
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
      secret: 'warn-secret',
    });
  }, 60_000);

  afterAll(async () => {
    await server.close().catch(() => {});
    await cleanupTeam(teamId);
  });

  const save = async (input: {
    name: string;
    source: string;
    id?: string;
    acknowledgeErrors?: boolean;
  }) =>
    saveMovement({
      teamId: teamId as string,
      source: input.source,
      name: input.name,
      ...(input.id !== undefined ? { id: input.id } : {}),
      ...(input.acknowledgeErrors !== undefined
        ? { acknowledgeErrors: input.acknowledgeErrors }
        : {}),
    });

  const saveOk = async (input: Parameters<typeof save>[0]) => {
    const result = await save(input);
    if (!result.ok) throw new Error(`save failed: ${JSON.stringify(result, null, 2)}`);
    return result;
  };

  /** A run waiting to continue on a listener (an ask, a timer, an await — the
   *  park reason doesn't matter; the trigger row is what every resume driver
   *  loads first). */
  const parkRunOn = async (triggerId: string): Promise<string> => {
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
    return runId;
  };

  describe('a source that cannot be read', () => {
    it('retires every listener when the save is consented, and says so', async () => {
      const name = `${NAME}-consented`;
      const first = await saveOk({ name, source: fileDeclaring('consented_probe') });
      expect(first.listeners).toHaveLength(1);
      const runId = await parkRunOn(first.listeners[0].triggerId);

      const broken = await saveOk({
        name,
        id: first.movementId,
        source: UNREADABLE,
        acknowledgeErrors: true,
      });

      expect(broken.listeners).toEqual([]);
      expect(broken.warnings).toEqual([
        'This source could not be read, so no listeners could be derived from it. You saved it anyway, so every listener this automation had has been retired — it will not fire again until a source that reads cleanly restores them.',
      ]);
      expect(await dispatchRoutes(first.movementId)).toEqual([]);

      // The run parked on the retired listener is settled, not stranded.
      const run = await getAutomationsQb(['trigger_run'])
        .selectFrom('trigger_run')
        .where('id', '=', runId as never)
        .select(['status', 'failure_reason'])
        .executeTakeFirstOrThrow();
      expect(run.status).toBe('failed');
      expect(run.failure_reason).toMatch(/could not be read/);
      const stillParked = await getAutomationsQb(['parked_run'])
        .selectFrom('parked_run')
        .where('run_id', '=', runId as never)
        .select('id')
        .execute();
      expect(stillParked).toEqual([]);

      // …and a source that reads cleanly puts the automation back on the air.
      const repaired = await saveOk({
        name,
        id: first.movementId,
        source: fileDeclaring('consented_probe'),
      });
      expect(repaired.listeners).toHaveLength(1);
      expect(repaired.warnings).toEqual([]);
      const routes = await dispatchRoutes(first.movementId);
      expect(routes).toHaveLength(1);
      expect(routes[0].id).toBe(repaired.listeners[0].triggerId);
    }, 180_000);

    it('refuses without consent, and the listeners keep firing', async () => {
      const name = `${NAME}-unconsented`;
      const first = await saveOk({ name, source: fileDeclaring('unconsented_probe') });
      expect(first.listeners).toHaveLength(1);

      const refused = await save({ name, id: first.movementId, source: UNREADABLE });
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error('unreachable');
      expect(refused.needsConfirmation).toBe(true);

      const routes = await dispatchRoutes(first.movementId);
      expect(routes).toHaveLength(1);
      expect(routes[0].id).toBe(first.listeners[0].triggerId);
    }, 180_000);
  });

  describe('a movement name another automation already fires', () => {
    it('names the other automation, and says its listener is live', async () => {
      const shared = 'shared_live';
      const owner = await saveOk({ name: `${NAME}-owner-live`, source: fileDeclaring(shared) });
      expect(owner.listeners[0].runMode).toBe('live');

      const second = await saveOk({
        name: `${NAME}-second-live`,
        source: fileDeclaring(shared),
      });
      expect(second.warnings).toEqual([
        `The movement name "${shared}" is also used by another automation, "${NAME}-owner-live", whose listener for it is live — that listener fires the other automation's version, not this one.`,
      ]);

      // The warning is pure VISIBILITY: registration was never ambiguous.
      // Trigger identity is `movement/<file>/<movement>` and reconciliation is
      // scoped to the movement row, so each file keeps its own listener.
      expect(second.listeners).toHaveLength(1);
      expect(second.listeners[0].triggerId).not.toBe(owner.listeners[0].triggerId);
      expect(await dispatchRoutes(owner.movementId)).toHaveLength(1);
      expect(await dispatchRoutes(second.movementId)).toHaveLength(1);
    }, 180_000);

    it("says so differently when the other automation's listener is not live", async () => {
      const shared = 'shared_rehearsed';
      const owner = await saveOk({
        name: `${NAME}-owner-dry`,
        source: fileDeclaring(shared, { dryRun: true }),
      });
      expect(owner.listeners[0].runMode).toBe('dry_run');

      const second = await saveOk({
        name: `${NAME}-second-dry`,
        source: fileDeclaring(shared),
      });
      expect(second.warnings).toEqual([
        `The movement name "${shared}" is also used by another automation, "${NAME}-owner-dry". Its listener for that name is not live, so nothing fires it from there today.`,
      ]);
    }, 180_000);

    it('never warns a file about its own listeners', async () => {
      const name = `${NAME}-self`;
      const first = await saveOk({ name, source: fileDeclaring('self_probe') });
      expect(first.warnings).toEqual([]);

      const again = await saveOk({
        name,
        id: first.movementId,
        source: fileDeclaring('self_probe'),
      });
      expect(again.warnings).toEqual([]);
      expect(again.listeners[0].triggerId).toBe(first.listeners[0].triggerId);
    }, 180_000);
  });
});
